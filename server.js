/*
 * Custom Next.js server that also hosts the PTY bridge.
 *
 * Each agent ("office/agent" key) gets one persistent node-pty session running
 * Claude Code (`claude` by default, override with CLAUDE_CMD). Browsers attach
 * over WebSocket at /pty and get a snapshot of the current screen, so closing and
 * reopening the panel reattaches to the same live session.
 */
const { createServer } = require('http');
const next = require('next');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { findOffice, officeSkillsDir, resolveCwd, isLead } = require('./lib/skills.js');
const { seedOfficeSkills } = require('./lib/seed-skills.js');

const dev = process.env.NODE_ENV !== 'production';
const port = parseInt(process.env.PORT || '3000', 10);
const CLAUDE_CMD = process.env.CLAUDE_CMD || 'claude';
// Every agent on the floor gets a live PTY as soon as the server boots, so the
// whole floor is warm before anyone opens a panel. AUTOSTART=0 disables it.
const AUTOSTART = process.env.AUTOSTART !== '0';
// Claude CLI startup is heavy; stagger spawns instead of launching N at once.
const AUTOSTART_STAGGER_MS = parseInt(process.env.AUTOSTART_STAGGER_MS || '600', 10);

const app = next({ dev });
const handle = app.getRequestHandler();

/** @type {Map<string, {pty: any, buffer: string, sockets: Set<any>, dead: boolean, cwd: string}>} */
const sessions = new Map();

// ---- shared memory (Munder Difflin-style): office memory + floor-wide memory ----
const MEMORY_DIR = path.join(process.cwd(), 'data', 'memory');

function memoryFile(scope) {
  // scope: 'floor' or an office id (already slug-safe from the UI)
  const safe = String(scope).replace(/[^a-z0-9_-]/gi, '');
  return path.join(MEMORY_DIR, `${safe || 'floor'}.md`);
}

function ensureMemoryFile(scope, label) {
  const file = memoryFile(scope);
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  if (!fs.existsSync(file)) {
    const title = scope === 'floor' ? 'Floor memory (shared across ALL offices)' : `Office memory — ${label || scope}`;
    fs.writeFileSync(file, `# ${title}\n\n_Agents append durable facts, decisions, and context below._\n`);
  }
  return file;
}

function memoryPrompt(oid, aid, role, officeFile, floorFile, skillsDir, lead) {
  const teamRule = lead
    ? `- You are the LEAD of this office. Delegate work by appending: "- [TASK] <agent-id>: <clear task description>". ` +
      `At the start of every turn, check office memory for new "[DONE]" entries from your workers; when the delegated work is reported done, ` +
      `review the reports and append "- [SUMMARY] [${oid}/${aid}]: <what the team completed, results, what remains>", and give that summary to the human as well.`
    : `- You are a WORKER (${role}). At the start of every turn, check office memory for "[TASK] ${aid}: ..." entries assigned to you and do them. ` +
      `WHENEVER you finish a piece of work — assigned by the lead or by the human — you MUST report back to the lead by appending: ` +
      `"- [DONE] [${oid}/${aid}] <task>: <what you did, files touched, result>". A task is NOT finished until its [DONE] entry is written. ` +
      `The lead reads these reports and writes the team [SUMMARY].`;
  // One office = one project = one directory; its .claude/skills is the office's
  // own playbook, discovered natively because the session runs in that directory.
  const skillRule = skillsDir
    ? [
        `OFFICE PROJECT & SKILLS:`,
        `- This office owns exactly ONE project: the directory you are running in. All of your work happens inside it.`,
        `- This office's skills live in ${skillsDir}. They are this team's procedures — consult the relevant one before starting a task, `
          + `and follow "project-brief" when you are new to a task here.`,
        `- Keep the skills current: when the team settles on a procedure worth repeating, write or update a skill there.`,
      ]
    : [];
  return [
    `You are agent "${aid}" (role: ${role}) in office "${oid}" on a multi-office agent floor.`,
    ...skillRule,
    `SHARED MEMORY PROTOCOL — follow it every task:`,
    `1. At the START of a task, read ${officeFile} (office memory, shared by all agents in this office) and ${floorFile} (floor memory, shared across ALL offices).`,
    `2. Record durable facts, decisions, and context by APPENDING short markdown bullets to the office memory file. Use the floor memory file for anything other offices need to know.`,
    `3. Never rewrite or delete other agents' entries; append only. Prefix entries with "[${oid}/${aid}]".`,
    `TEAM PROTOCOL — the office memory file is also the team's task board:`,
    teamRule,
    `4. At the END of a task, append what you learned so other agents benefit.`,
  ].join('\n');
}

// ---- persistent per-agent Claude sessions: stable UUID per agent, resumed forever ----
const SESSION_MAP_FILE = path.join(process.cwd(), 'data', 'agent-sessions.json');

function loadSessionMap() {
  try {
    return JSON.parse(fs.readFileSync(SESSION_MAP_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveSessionMap(map) {
  fs.mkdirSync(path.dirname(SESSION_MAP_FILE), { recursive: true });
  fs.writeFileSync(SESSION_MAP_FILE, JSON.stringify(map, null, 2));
}
function agentSessionId(key) {
  const map = loadSessionMap();
  if (!map[key]) {
    map[key] = crypto.randomUUID();
    saveSessionMap(map);
  }
  return map[key];
}
function forgetAgentSession(key) {
  const map = loadSessionMap();
  if (map[key]) {
    delete map[key];
    saveSessionMap(map);
  }
}
// A transcript for this UUID anywhere under ~/.claude/projects means the chat exists and can be resumed.
function transcriptExists(uuid) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  try {
    for (const dir of fs.readdirSync(root)) {
      if (fs.existsSync(path.join(root, dir, `${uuid}.jsonl`))) return true;
    }
  } catch {}
  return false;
}

// ---- live agent state: what the desk light / name-tag dot shows ----
//   offline | exited  -> red    (no session / crashed)
//   starting | working -> blue  (booting, or Claude is actively churning)
//   waiting            -> yellow(Claude is asking the human something)
//   done               -> green (alive, idle, nothing pending)
// Only a real interactive prompt counts as "needs you" — the selection caret in front
// of a numbered option, a confirm-dialog footer, or a y/n prompt. Prose that merely ends
// in a question, or a numbered list inside a reply, is still just "done".
const ASK_PATTERNS = [
  /❯\s*\d+[.)]\s/, // ❯ 1. Yes / ❯ 2. No — Claude's option picker
  /enter to confirm/i, // confirm dialogs (trust folder, pickers)
  /\(y\/n\)/i,
];
const BUSY_PATTERN = /esc to interrupt/i;

// The visible screen (not the scrollback): what a human would be looking at.
function screenText(s) {
  try {
    const buf = s.term.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

function resizeSession(s, cols, rows) {
  if (!cols || !rows || (s.cols === cols && s.rows === rows)) return false;
  s.cols = cols;
  s.rows = rows;
  try {
    s.pty.resize(cols, rows);
  } catch {}
  try {
    s.term.resize(cols, rows);
  } catch {}
  return true;
}

// Replay = a snapshot of the CURRENT screen, re-rendered at the attaching client's
// geometry. Replaying raw scrollback instead would paint a full-screen TUI that was
// drawn for a different width, which is what produced the scrambled panel.
function snapshot(s, cb) {
  s.term.write('', () => {
    let screen = '';
    try {
      screen = s.serializer.serialize();
    } catch {}
    cb(`\x1b[H\x1b[2J\x1b[3J${screen}`);
  });
}

function agentState(key, s) {
  if (!s) return 'offline';
  if (s.dead) return 'exited';
  const screen = screenText(s);
  if (BUSY_PATTERN.test(screen)) return 'working';
  // Shell + Claude still booting: no UI on screen yet.
  if (!screen.trim() && Date.now() - s.startedAt < 20_000) return 'starting';
  if (ASK_PATTERNS.some((re) => re.test(screen))) return 'waiting';
  return 'done';
}

function spawnSession(key, cwd, cols, rows, role = 'agent') {
  const shell = process.env.SHELL || '/bin/zsh';
  // Fresh env: drop any Claude Code session markers inherited by this server,
  // so each agent gets a clean top-level session.
  const env = { TERM: 'xterm-256color' };
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^(CLAUDE_?CODE|CLAUDE_SESSION|AGENT_|HIVE_)/i.test(k)) env[k] = v;
  }

  // Shared memory wiring: office + floor memory files, injected via system prompt.
  const [oid, aid] = key.split('/');
  const officeFile = ensureMemoryFile(oid);
  const floorFile = ensureMemoryFile('floor');
  env.HARNESS_OFFICE = oid;
  env.HARNESS_AGENT = aid;
  env.HARNESS_ROLE = role;
  env.OFFICE_MEMORY = officeFile;
  env.FLOOR_MEMORY = floorFile;

  // Office skills: one office = one project, and that project's `.claude/skills`
  // is where Claude Code already looks — so seeding the role-aware starters here
  // is all it takes for this agent to discover them. Offices without a project
  // folder of their own are skipped, so we never write into the app's own dir.
  const skills = officeSkillsDir(findOffice(oid));
  if (skills.configured) {
    try {
      const { seeded } = seedOfficeSkills(findOffice(oid));
      if (seeded.length) console.log(`>   seeded skills for ${oid}: ${seeded.join(', ')}`);
    } catch (err) {
      console.error(`>   skill seed failed for ${oid}: ${err.message}`);
    }
    env.OFFICE_SKILLS = skills.dir;
    env.OFFICE_PROJECT = skills.cwd;
  }
  // Lead-ness comes from the agent record (role *or* name), so an agent named
  // "REH LEAD" that was left at the default `agent` role still leads its office.
  const agent = (findOffice(oid)?.agents || []).find((a) => a.id === aid) || { id: aid, role };
  env.HARNESS_MEMORY_PROMPT = memoryPrompt(
    oid,
    aid,
    role,
    officeFile,
    floorFile,
    skills.configured ? skills.dir : '',
    isLead(agent),
  );
  // Only decorate the default `claude` command; a custom CLAUDE_CMD is run as-is.
  // Each agent has a stable session UUID: first spawn claims it with --session-id,
  // every later spawn (after kill, server restart, reboot) resumes the same chat.
  const sid = agentSessionId(key);
  const sessionFlag = transcriptExists(sid) ? `--resume ${sid}` : `--session-id ${sid}`;
  const cmd =
    CLAUDE_CMD === 'claude'
      ? `claude ${sessionFlag} --append-system-prompt "$HARNESS_MEMORY_PROMPT" --add-dir "${MEMORY_DIR}"`
      : CLAUDE_CMD;

  const p = pty.spawn(shell, ['-il', '-c', cmd], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env,
  });
  // Mirror of the PTY screen, so the server can tell what the agent is doing.
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  const s = { pty: p, term, serializer, sockets: new Set(), dead: false, cwd, cols, rows, startedAt: Date.now() };
  sessions.set(key, s);

  p.onData((data) => {
    s.term.write(data);
    for (const ws of s.sockets) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'output', data }));
    }
  });
  p.onExit(({ exitCode }) => {
    s.dead = true;
    for (const ws of s.sockets) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
    }
  });
  return s;
}

// ---- autostart: bring up one PTY per agent defined in the floor state ----
const STATE_FILE = path.join(process.cwd(), 'data', 'state.json');
const STATE_EXAMPLE = path.join(process.cwd(), 'data', 'state.example.json');

// A floor is per-machine and git-ignored, so a fresh clone arrives without one.
// Seed it from the committed example the first time, then never touch it again —
// the UI owns the file from that point on.
function ensureFloorState() {
  if (fs.existsSync(STATE_FILE) || !fs.existsSync(STATE_EXAMPLE)) return;
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.copyFileSync(STATE_EXAMPLE, STATE_FILE);
    console.log('> first run: created data/state.json from data/state.example.json');
    console.log('>   open the office, hit ✎, and point it at your project folder');
  } catch (err) {
    console.error(`> could not seed data/state.json: ${err.message}`);
  }
}

function loadFloorAgents() {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return [];
  }
  const list = [];
  for (const office of state.offices || []) {
    for (const agent of office.agents || []) {
      if (!office.id || !agent.id) continue;
      list.push({
        key: `${office.id}/${agent.id}`,
        cwd: resolveCwd(office.cwd),
        role: agent.role || 'agent',
      });
    }
  }
  return list;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let starting = false;
async function startAllSessions(reason) {
  if (!AUTOSTART || starting) return;
  starting = true;
  try {
    const pending = loadFloorAgents().filter(({ key }) => {
      const s = sessions.get(key);
      return !s || s.dead;
    });
    if (!pending.length) return;
    console.log(`> autostart (${reason}): bringing up ${pending.length} agent terminal(s)`);
    for (const { key, cwd, role } of pending) {
      // Re-check: a browser may have attached (and spawned) while we waited.
      const existing = sessions.get(key);
      if (existing && !existing.dead) continue;
      try {
        spawnSession(key, cwd, 120, 32, role);
        console.log(`>   started ${key}`);
      } catch (err) {
        console.error(`>   failed ${key}: ${err.message}`);
      }
      if (AUTOSTART_STAGGER_MS > 0) await sleep(AUTOSTART_STAGGER_MS);
    }
    console.log('> autostart: done');
  } finally {
    starting = false;
  }
}

// Agents added/renamed in the UI land in state.json; give them a terminal too.
function watchFloorState() {
  if (!AUTOSTART) return;
  let timer = null;
  try {
    fs.watch(path.dirname(STATE_FILE), (_event, filename) => {
      if (filename && filename !== path.basename(STATE_FILE)) return;
      clearTimeout(timer);
      timer = setTimeout(() => startAllSessions('floor changed'), 1500);
    });
  } catch (err) {
    console.error(`> autostart: cannot watch ${STATE_FILE}: ${err.message}`);
  }
}

function sessionStatus() {
  const out = {};
  // Every agent on the floor gets an entry, even ones with no session yet.
  for (const { key } of loadFloorAgents()) out[key] = agentState(key, sessions.get(key));
  for (const [key, s] of sessions) out[key] = agentState(key, s);
  return out;
}

app.prepare().then(() => {
  const server = createServer((req, res) => {
    if (req.url === '/api/sessions') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(sessionStatus()));
      return;
    }
    if (req.url.startsWith('/api/start-all')) {
      startAllSessions('requested');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url.startsWith('/api/kill')) {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const key = params.get('key');
      const s = key && sessions.get(key);
      if (s && !s.dead) s.pty.kill();
      if (key) sessions.delete(key);
      if (key && params.get('forget')) forgetAgentSession(key);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    handle(req, res);
  });

  const wss = new WebSocketServer({ noServer: true });
  const nextUpgrade = app.getUpgradeHandler();

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/pty') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else {
      nextUpgrade(req, socket, head); // keep Next dev HMR working
    }
  });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const key = url.searchParams.get('key');
    const cwd = resolveCwd(url.searchParams.get('cwd'));
    const role = (url.searchParams.get('role') || 'agent').slice(0, 40);
    const cols = Number(url.searchParams.get('cols')) || 120;
    const rows = Number(url.searchParams.get('rows')) || 32;
    if (!key) return ws.close();

    let s = sessions.get(key);
    const fresh = !s || s.dead;
    if (fresh) {
      try {
        s = spawnSession(key, cwd, cols, rows, role);
      } catch (err) {
        ws.send(JSON.stringify({ type: 'output', data: `\r\nfailed to spawn ${CLAUDE_CMD}: ${err.message}\r\n` }));
        return ws.close();
      }
    }
    ws.send(JSON.stringify({ type: 'ready', fresh, cwd: s.cwd }));

    if (fresh) {
      s.sockets.add(ws);
    } else {
      // Match the PTY to this client first: the SIGWINCH makes Claude repaint at the
      // new width. Give it a moment, then send that repainted screen as the replay.
      const resized = resizeSession(s, cols, rows);
      const session = s;
      setTimeout(
        () => {
          if (ws.readyState !== 1) return;
          // The snapshot and the socket join happen in the same callback, so no
          // output can slip through the gap between them.
          snapshot(session, (data) => {
            if (ws.readyState !== 1) return;
            ws.send(JSON.stringify({ type: 'output', data }));
            session.sockets.add(ws);
          });
        },
        resized ? 250 : 60,
      );
    }

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (s.dead && msg.type !== 'kill') return;
      if (msg.type === 'input') s.pty.write(msg.data);
      else if (msg.type === 'resize' && msg.cols > 0 && msg.rows > 0) {
        resizeSession(s, msg.cols, msg.rows);
      }
      else if (msg.type === 'kill') {
        if (!s.dead) s.pty.kill();
        sessions.delete(key);
      }
    });
    ws.on('close', () => s.sockets.delete(ws));
  });

  ensureFloorState();

  server.listen(port, () => {
    console.log(`> Harness Floor on http://localhost:${port} (claude cmd: ${CLAUDE_CMD})`);
    if (AUTOSTART) {
      startAllSessions('boot');
      watchFloorState();
    } else {
      console.log('> autostart disabled (AUTOSTART=0); terminals spawn on first open');
    }
  });
});
