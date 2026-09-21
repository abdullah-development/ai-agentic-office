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
const { findOffice, officeSkillsDir, resolveCwd, isLead, readState } = require('./lib/skills.js');
const { seedOfficeSkills } = require('./lib/seed-skills.js');
const { loadEnv } = require('./lib/env.js');
const { hasTracker, fetchOfficeTickets } = require('./lib/trackers/index.js');
const { readTickets, writeTickets, newTodo, announceTickets } = require('./lib/tickets.js');
const floor = require('./lib/floor.js');
const mailbox = require('./lib/mailbox.js');
const ledger = require('./lib/ledger.js');
const fleet = require('./lib/fleet.js');
const hooks = require('./lib/hooks.js');

// Tracker credentials live in .env.local; read them before anything else.
loadEnv();

const dev = process.env.NODE_ENV !== 'production';
const port = parseInt(process.env.PORT || '3000', 10);
const CLAUDE_CMD = process.env.CLAUDE_CMD || 'claude';
// Every agent on the floor gets a live PTY as soon as the server boots, so the
// whole floor is warm before anyone opens a panel. AUTOSTART=0 disables it.
const AUTOSTART = process.env.AUTOSTART !== '0';
// Claude CLI startup is heavy; stagger spawns instead of launching N at once.
const AUTOSTART_STAGGER_MS = parseInt(process.env.AUTOSTART_STAGGER_MS || '600', 10);
// How often each office's tracker board is pulled. TRACKER_POLL=0 disables it.
const TRACKER_POLL_MS = parseInt(process.env.TRACKER_POLL_MS || '210000', 10); // 3.5 min
// Whether an agent holding unread mail may be woken through its terminal.
// Tracker tickets deliberately do NOT nudge: they become cards on the ledger and
// the lead picks them up in its own time. Typing every new ticket into the lead's
// terminal made it triage junk on sight and block the board with questions.
const MAIL_NUDGE = process.env.MAIL_NUDGE !== '0';
// How often a queued nudge retries while it waits for its agent to go idle.
// Cheap: reads the mailbox, never calls the tracker.
const NUDGE_DRAIN_MS = parseInt(process.env.NUDGE_DRAIN_MS || '20000', 10);
// Gap between typing the nudge and pressing Enter, so the TUI registers the
// text as input rather than swallowing the Enter into a paste.
const NUDGE_SUBMIT_DELAY_MS = parseInt(process.env.NUDGE_SUBMIT_DELAY_MS || '400', 10);
// ---- the floor layer: mailbox, ledger, fleet, hooks ----
// How often every outbox on the floor is swept. fs.watch gives us the fast path;
// this is the backstop, because nested-create events are unreliable on macOS and
// a missed message is a silently dropped instruction.
const ROUTER_SWEEP_MS = parseInt(process.env.ROUTER_SWEEP_MS || '2000', 10);
// How often `data/floor/fleet.json` is rewritten. It is the only situational
// awareness a LEAD has without a UI, so it needs to be fresh, not cheap.
const FLEET_WRITE_MS = parseInt(process.env.FLEET_WRITE_MS || '5000', 10);
// Set FLOOR=0 to run the old memory-file-only floor with none of this.
const FLOOR_ON = process.env.FLOOR !== '0';

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

/*
 * The system prompt every agent is spawned with.
 *
 * 🔒 PROMPT-CACHE INVARIANT — keep this string VOLATILE-FREE.
 *
 * It may interpolate only values that are stable for an agent's whole lifetime:
 * its id, its office, its role, its directories. Do NOT add dates, counters,
 * UUIDs, roster state, task counts, or anything derived from `Date.now()`. This
 * text is the cached prefix of every turn the agent ever takes; a prefix that
 * differs between two spawns re-primes the entire system prompt on every turn and
 * quietly doubles what the floor costs to run.
 *
 * Volatile context belongs on the live channels — the inbox, `fleet.json`, the
 * PTY — never baked in here.
 *
 * Also: no shell syntax. Every path is written the way the AGENT will read it,
 * not the way a shell would expand it.
 */
function memoryPrompt(oid, aid, role, officeFile, floorFile, skillsDir, lead, agentDir, protocolFile, tasksFile) {
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

  // The mailbox is how work is DELIVERED. The office memory file stays what it
  // has always been — the office's narrative record, and what the floor UI reads.
  // Both, on purpose: a message is addressed and arrives; a bullet in a shared
  // file is only found if someone thinks to look.
  const mailbox = [
    `MAILBOX PROTOCOL — follow it every task:`,
    `1. At the START of a task, read ${agentDir}/memory.md (your private memory) and EVERY file in ${agentDir}/inbox `
      + `(messages other agents sent you). After handling a message, move its file into ${agentDir}/inbox/.done/.`,
    `2. To ask another agent for something, or to tell one something, write ONE message JSON into ${agentDir}/outbox/ `
      + `(schema in ${protocolFile}). NEVER write into another agent's folder — the floor router delivers your outbox for you.`,
    `3. Address it with "to": a bare agent id for your own office, "<office>/<agent-id>" across offices, "lead" for your `
      + `office lead, "floor" to reach every lead, "human" to reach the human through your lead.`,
    `4. Only "request", "query" and "propose" expect a reply. "inform" and "done" are TERMINAL — do not reply to them, `
      + `or two agents will loop forever and spend all night doing it.`,
    `5. Record durable facts, decisions, and context by appending to ${agentDir}/memory.md — that file is yours alone and `
      + `it is what survives a compact.`,
    `6. If a "Circuit breaker" message appears in your inbox, YOU are the runaway behaviour it caught. Stop repeating, `
      + `summarise what you tried, and do exactly what it says.`,
  ];

  const shared = [
    `SHARED MEMORY — the narrative record, alongside the mailbox:`,
    `- ${officeFile} is this office's shared memory, and the board the human reads. ${floorFile} is the floor memory, `
      + `shared across ALL offices — put there only what other OFFICES need.`,
    `- Append short markdown bullets prefixed "[${oid}/${aid}]". Never rewrite or delete another agent's entries.`,
    `- ${tasksFile} is the structured task ledger (todo / doing / blocked / done, with title, assignee, priority, deps). `
      + `Keep the card you are working on reflected in its status. An "assignee" is never cleared — a done card must `
      + `still say who did the work.`,
  ];

  const teamRule = lead
    ? [
        `YOU ARE THE LEAD of this office. You run it: decompose incoming work, delegate it, and personally own the calls `
          + `that matter — decomposition, sign-off, conflicts, integration — not the grunt work.`,
        `- Delegate by MESSAGE, not by hoping someone reads a file: write one message per slice into your outbox with `
          + `"act": "request". Every dispatch is a 4-part contract:`,
        `    (1) OBJECTIVE — the concrete goal; (2) OUTPUT — the deliverable and its format; (3) TOOLS — what to use or `
          + `avoid, and which references to read instead of re-deriving; (4) BOUNDARIES — scope limits and the definition of done.`,
        `  Pass REFERENCES — file paths, message ids, card ids — never pasted content.`,
        `- Check who you already have before asking for anyone new. Route work to an agent already on the floor.`,
        `- You are the sole scribe of ${officeFile}. Others propose changes to it; you write them.`,
        `- Answer your workers fast. A blocked agent is your problem, not theirs.`,
        `- When the work lands, append "- [SUMMARY] [${oid}/${aid}]: <what the team completed, results, what remains>" to `
          + `office memory and give that summary to the human too.`,
        `- When a card can only move with the HUMAN — a question only they can answer, or an action only they can take — `
          + `set the card to "blocked" and append the ask to its "humanQA" array as { "q": "<markdown>", "askedAt": "<iso>" }. `
          + `Write it SHORT: one bold sentence saying exactly what you need, backticks for paths and values, one bullet per `
          + `option, about 700 characters maximum. An ask longer than that is a report, not a question. Then move on to `
          + `other work — never sit idle waiting for the answer.`,
      ].join('\n')
    : [
        `YOU ARE A WORKER (${role}).`,
        `- Work comes to you as a message in your inbox. When you finish, reply to the lead with "act": "done" and a real `
          + `summary — what you did, which files, the result, anything still open. Never a bare "done".`,
        `- Also append "- [DONE] [${oid}/${aid}] <task>: <what you did, files touched, result>" to office memory, so the `
          + `human's board shows it. A task is not finished until both exist.`,
        `- Stuck, or the request is ambiguous? Message "lead" with "act": "query" and keep working on something else `
          + `meanwhile. Do not idle waiting for a reply.`,
      ].join('\n');

  return [
    `You are agent "${aid}" (role: ${role}) in office "${oid}" on a multi-office agent floor.`,
    `Your private workspace is ${agentDir}. The full floor protocol is ${protocolFile} — read it when you need the detail.`,
    ...skillRule,
    ...mailbox,
    ...shared,
    teamRule,
    `At the END of a task, append what you learned to ${agentDir}/memory.md so future-you remembers it.`,
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
    if (!/^(CLAUDE_?CODE|CLAUDE_SESSION|AGENT_|HIVE_|FLOOR_)/i.test(k)) env[k] = v;
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

  // Lead-ness comes from the agent record (role *or* name), so an agent named
  // "REH LEAD" that was left at the default `agent` role still leads its office.
  const agent = (findOffice(oid)?.agents || []).find((a) => a.id === aid) || { id: aid, role };

  // Floor wiring: the mailbox has to exist before the agent that owns it does,
  // or its first outbox write lands in a directory the router never scans.
  let agentDirPath = '';
  let settingsFile = '';
  if (FLOOR_ON) {
    agentDirPath = mailbox.ensureAgentDirs(key);
    env.AGENT_KEY = key; // `office/agent` — how the hook plane identifies this session
    env.AGENT_ID = aid;
    env.AGENT_NAME = agent?.name || aid;
    env.AGENT_OFFICE = oid;
    env.AGENT_DIR = agentDirPath;
    env.FLOOR_ROOT = floor.FLOOR_ROOT;
    env.FLOOR_PROTOCOL = floor.PROTOCOL_FILE;
    env.FLOOR_TASKS = floor.TASKS_FILE;
    if (hooks.HOOKS_ON) env.FLOOR_SOCK = floor.SOCK_FILE;
    try {
      settingsFile = hooks.writeAgentSettings(key);
    } catch (err) {
      // No settings file means no telemetry for this agent. It still works.
      console.error(`>   floor: could not write settings for ${key}: ${err.message}`);
    }
  }

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
  env.HARNESS_MEMORY_PROMPT = memoryPrompt(
    oid,
    aid,
    role,
    officeFile,
    floorFile,
    skills.configured ? skills.dir : '',
    isLead(agent),
    agentDirPath,
    floor.PROTOCOL_FILE,
    floor.TASKS_FILE,
  );
  // Only decorate the default `claude` command; a custom CLAUDE_CMD is run as-is.
  // Each agent has a stable session UUID: first spawn claims it with --session-id,
  // every later spawn (after kill, server restart, reboot) resumes the same chat.
  const sid = agentSessionId(key);
  const sessionFlag = transcriptExists(sid) ? `--resume ${sid}` : `--session-id ${sid}`;
  // `--add-dir` has to cover the floor root as well as the memory files, or the
  // agent can read the protocol it was just told to follow but not write the
  // outbox message that protocol is entirely about.
  const extraDirs = FLOOR_ON ? ` --add-dir "${floor.FLOOR_ROOT}"` : '';
  // `--settings` MERGES on top of the user's own settings; it does not replace
  // them. That file is generated per agent and carries the lifecycle hooks.
  const settingsFlag = settingsFile ? ` --settings "${settingsFile}"` : '';
  const cmd =
    CLAUDE_CMD === 'claude'
      ? `claude ${sessionFlag} --append-system-prompt "$HARNESS_MEMORY_PROMPT" --add-dir "${MEMORY_DIR}"${extraDirs}${settingsFlag}`
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
      timer = setTimeout(() => {
        // The roster changed, so the protocol handed to agents and the set of
        // mailboxes both have to change with it — before any new terminal boots.
        if (FLOOR_ON) {
          try {
            mailbox.writeProtocol();
            for (const { key } of mailbox.roster()) mailbox.ensureAgentDirs(key);
          } catch (err) {
            console.error(`> floor: could not refresh the roster: ${err.message}`);
          }
        }
        startAllSessions('floor changed');
      }, 1500);
    });
  } catch (err) {
    console.error(`> autostart: cannot watch ${STATE_FILE}: ${err.message}`);
  }
}

// ---- tracker poll: pull each office's board, put new work in front of its lead ----

/**
 * The live session for an agent, if it exists and it is idle.
 *
 * Only ever interrupt an idle agent. Mid-task or mid-prompt, the caller leaves
 * the work queued and the drain below retries — which is the difference between
 * a dropped nudge and a deferred one. This `!== 'done'` gate is the single reason
 * typing into a live TUI is safe, and it is also the conclusion upstream reached
 * the hard way after removing their forced-continuation Stop hook.
 */
function idleAgentSession(key) {
  const s = sessions.get(key);
  if (!s || s.dead) return null;
  if (agentState(key, s) !== 'done') return null;
  return s;
}

/**
 * Type a prompt into an idle agent's terminal and submit it.
 *
 * Two writes, not one. Claude Code's input treats a large chunk as a paste, so a
 * \r inside the same write lands as a newline in the composer instead of
 * submitting — the prompt just sits there. Sending Enter separately, once the TUI
 * has processed the text, is what actually submits it.
 */
function typeToAgent(key, session, prompt) {
  try {
    session.pty.write(prompt);
    setTimeout(() => {
      try {
        session.pty.write('\r');
      } catch (err) {
        console.error(`> nudge: could not submit to ${key}: ${err.message}`);
      }
    }, NUDGE_SUBMIT_DELAY_MS);
    return true;
  } catch (err) {
    console.error(`> nudge: could not type to ${key}: ${err.message}`);
    return false;
  }
}

/**
 * Wake an idle agent that has unread mail.
 *
 * The ids in the text are DIAGNOSTIC, not a work list. They let the agent tell "I
 * already did this one" from "I was woken for nothing" without burning a
 * round-trip, which is why the wording insists the inbox directory is what counts.
 */
function nudgeMail(key, messages) {
  if (!FLOOR_ON || !MAIL_NUDGE) return false;
  const session = idleAgentSession(key);
  if (!session) return false; // still queued; the drain retries
  const ids = messages.slice(0, 6).map((m) => m.id).join(', ');
  const more = messages.length > 6 ? ` (+${messages.length - 6} more)` : '';
  const prompt =
    `You have ${messages.length} new floor inbox message(s) — at least: ${ids}${more}. ` +
    `Read your inbox, act on what is pending there, and move handled ones to inbox/.done/. ` +
    `Your inbox directory is authoritative: work everything still pending in it, and if a named id is already in ` +
    `inbox/.done/ you handled it on an earlier turn and can ignore that one. ` +
    `Act autonomously; only message your lead if you genuinely need a decision.`;
  if (!typeToAgent(key, session, prompt)) return false;
  mailbox.markNudged(key, messages.map((m) => m.id));
  console.log(`> floor: woke ${key} with ${messages.length} message(s)`);
  return true;
}

let polling = false;
async function pollTrackers(reason) {
  if (polling) return;
  const offices = (readState().offices || []).filter(hasTracker);
  if (!offices.length) return;
  polling = true;
  try {
    for (const office of offices) {
      const { tickets, error, provider } = await fetchOfficeTickets(office);
      if (error) {
        console.error(`> tracker (${office.id}/${provider}): ${error}`);
        // Keep the last good board; only record that this attempt failed.
        const prev = readTickets(office.id);
        writeTickets(office.id, { ...prev, error, fetchedAt: new Date().toISOString() });
        continue;
      }
      const prev = readTickets(office.id).tickets;
      writeTickets(office.id, { provider, tickets, error: null, fetchedAt: new Date().toISOString() });

      const fresh = newTodo(prev, tickets);
      const written = announceTickets(office.id, fresh);
      // The same tickets, as structured cards.
      //
      // Built from EVERY todo ticket, not just the ones that appeared since the
      // last poll. `fresh` is a diff against the cached board, so on a floor that
      // has been running a while it is empty — and an office's existing backlog
      // would never become cards at all, leaving the ledger dead on arrival.
      // `taskFromTicket` is idempotent on the ticket key and returns the existing
      // card untouched, so a poll can never drag a card the lead already moved
      // back to `todo`.
      if (FLOOR_ON) {
        for (const t of tickets.filter((x) => x.todo)) {
          try {
            ledger.taskFromTicket(office.id, { ...t, provider });
          } catch (err) {
            console.error(`> floor: could not add card for ${t.key}: ${err.message}`);
          }
        }
      }
      if (written.length) {
        console.log(`> tracker (${office.id}): ${written.length} new ticket(s) on the board [${reason}]`);
      }

    }
  } finally {
    polling = false;
  }
}

/**
 * Wake any agent holding mail it has not been told about, as soon as it is idle.
 *
 * Runs far more often than the tracker poll and touches no network — it only
 * re-reads the mailboxes. That is what turns "the agent was busy" from a dropped
 * nudge into a queued one.
 *
 * Tracker tickets are NOT delivered this way. They land on the ledger as cards
 * and on the office board as `[TICKET]` rows, and the lead picks them up when it
 * next looks. Nothing from a tracker types into a terminal.
 */
function drainMailNudges() {
  if (!FLOOR_ON || !MAIL_NUDGE) return;
  for (const { key } of mailbox.roster()) {
    const waiting = mailbox.unnudged(key);
    if (waiting.length) nudgeMail(key, waiting);
  }
}

function startTrackerPolling() {
  if (TRACKER_POLL_MS <= 0) {
    console.log('> tracker polling disabled (TRACKER_POLL_MS=0)');
    return;
  }
  const mins = (TRACKER_POLL_MS / 60000).toFixed(1);
  console.log(`> tracker polling every ${mins} min (tickets become cards; no terminal nudge)`);
  // Let the floor finish booting before the first pull.
  setTimeout(() => pollTrackers('boot'), 15000);
  setInterval(() => pollTrackers('interval'), TRACKER_POLL_MS);
}

// ---- the floor: router sweep, fleet snapshot, hook plane -------------------

/**
 * Every agent on the floor, decorated with what the server knows right now.
 * This is what `fleet.json` is built from — and `fleet.json` is how a LEAD gets
 * situational awareness without a UI, so it has to cover agents whose terminal
 * has never started, not just live ones.
 */
function floorRows() {
  return mailbox.roster().map(({ key, office, agent, lead }) => ({
    key,
    office: office.id,
    agent: agent.id,
    name: agent.name || agent.id,
    lead,
    cwd: resolveCwd(office.cwd),
    status: agentState(key, sessions.get(key)),
    inboxBacklog: mailbox.pendingInbox(key).length,
  }));
}

/**
 * Which agent fired this hook.
 *
 * `AGENT_KEY` is injected at spawn and comes back on every payload, but it is
 * checked against the live roster before we trust it — a stale terminal from a
 * renamed office would otherwise write telemetry under a key that no longer
 * exists and quietly accumulate a ghost agent in `fleet.json`.
 */
function resolveHookKey(payload) {
  const claimed = payload.agent_key;
  if (!claimed) return null;
  return mailbox.roster().some((r) => r.key === claimed) ? claimed : null;
}

let sweeping = false;
function sweepOutboxes(reason) {
  if (sweeping) return;
  sweeping = true;
  try {
    const n = mailbox.drainOutboxes();
    if (n) console.log(`> floor: routed ${n} message(s) [${reason}]`);
  } catch (err) {
    console.error(`> floor: router sweep failed: ${err.message}`);
  } finally {
    sweeping = false;
  }
}

function startFloor() {
  if (!FLOOR_ON) {
    console.log('> floor layer disabled (FLOOR=0) — office memory files only');
    return;
  }
  fs.mkdirSync(floor.AGENTS_DIR, { recursive: true });
  // Claim the floor. `test/floor.js` wipes data/floor/, so it needs to know a
  // server is live before it does — and it cannot learn that from anything the
  // wipe would remove.
  try {
    fs.writeFileSync(floor.PID_FILE, String(process.pid));
    const release = () => {
      try {
        if (fs.readFileSync(floor.PID_FILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(floor.PID_FILE);
      } catch {}
    };
    process.on('exit', release);
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
  } catch (err) {
    console.error(`> floor: could not claim ${path.basename(floor.PID_FILE)}: ${err.message}`);
  }
  // Regenerated every boot so it always matches the live roster. Agents are
  // pointed at it from their system prompt, and a protocol that describes an
  // office that no longer exists is worse than no protocol at all.
  try {
    mailbox.writeProtocol();
  } catch (err) {
    console.error(`> floor: could not write PROTOCOL.md: ${err.message}`);
  }
  // Mailboxes for everyone on the roster, not just whoever has a terminal up:
  // a lead must be able to dispatch to an agent that has not booted yet.
  for (const { key } of mailbox.roster()) {
    try {
      mailbox.ensureAgentDirs(key);
    } catch (err) {
      console.error(`> floor: could not create mailbox for ${key}: ${err.message}`);
    }
  }

  if (hooks.HOOKS_ON) hooks.startHookServer(resolveHookKey);
  else console.log('> floor hooks disabled (FLOOR_HOOKS=0) — idle-gate telemetry only');

  // fs.watch is the fast path; the interval is the backstop. Nested creates are
  // unreliable on macOS — we already learned that watching data/state.json — and
  // a message the router never notices is a silently dropped instruction.
  sweepOutboxes('boot');
  setInterval(() => sweepOutboxes('sweep'), ROUTER_SWEEP_MS);
  try {
    let timer = null;
    fs.watch(floor.AGENTS_DIR, { recursive: true }, (_event, filename) => {
      if (!filename || !filename.includes('outbox')) return;
      clearTimeout(timer);
      timer = setTimeout(() => sweepOutboxes('watch'), 150);
    });
  } catch (err) {
    console.error(`> floor: cannot watch mailboxes (${err.message}); falling back to the ${ROUTER_SWEEP_MS}ms sweep`);
  }

  const writeFleet = () => {
    try {
      fleet.writeFleet(floorRows());
    } catch (err) {
      console.error(`> floor: fleet snapshot failed: ${err.message}`);
    }
  };
  writeFleet();
  setInterval(writeFleet, FLEET_WRITE_MS);

  if (MAIL_NUDGE && NUDGE_DRAIN_MS > 0) {
    console.log(`> floor: queued mail nudges retry every ${Math.round(NUDGE_DRAIN_MS / 1000)}s until the agent is free`);
    setInterval(drainMailNudges, NUDGE_DRAIN_MS);
  } else {
    console.log('> floor: mail nudges off (MAIL_NUDGE=0) — agents find mail on their next turn');
  }
  console.log(
    `> floor: mailbox at ${path.relative(process.cwd(), floor.FLOOR_ROOT)} ` +
      `(router every ${ROUTER_SWEEP_MS}ms, fleet every ${FLEET_WRITE_MS}ms, breaker ${fleet.BREAKER_ON ? 'on' : 'off'})`,
  );
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
    // The breaker's counters live in this process, not on disk, so clearing one
    // has to happen here rather than in a Next route (which gets its own module
    // instance). Everything else the UI needs is read from data/floor/.
    if (req.url.startsWith('/api/floor/reset-breaker')) {
      const key = new URL(req.url, 'http://localhost').searchParams.get('key');
      const r = key ? fleet.resetBreaker(key) : null;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: Boolean(r), breaker: r?.breaker || null }));
      return;
    }
    if (req.url.startsWith('/api/floor/sweep')) {
      sweepOutboxes('requested');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
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
      if (key && params.get('forget')) {
        forgetAgentSession(key);
        fleet.forget(key); // its counters describe a session that no longer exists
      }
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
    startFloor();
    startTrackerPolling();
    if (AUTOSTART) {
      startAllSessions('boot');
      watchFloorState();
    } else {
      console.log('> autostart disabled (AUTOSTART=0); terminals spawn on first open');
    }
  });
});
