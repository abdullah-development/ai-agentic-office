/*
 * Floor layer tests — `node test/floor.js`.
 *
 * Runs against its OWN floor in a temp directory (`FLOOR_ROOT`), built from the
 * live `data/state.json` roster. It never touches the real mailboxes, office
 * memory, tickets, or agent sessions, and it removes its tree on the way out.
 * The pid guard below is the second line of defence, for a run pointed by hand at
 * a real floor.
 *
 * Covers the four loop guards, the fact that an agent cannot forge its own
 * `from`, and the hook plane end to end through the real shim over a real socket.
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const { execFile } = require('child_process');

// Own tree, set BEFORE lib/floor.js is loaded — it reads FLOOR_ROOT at require
// time. Nothing in here can reach the real floor's mailboxes.
if (!process.env.FLOOR_ROOT) {
  process.env.FLOOR_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'floor-test-'));
}

const L = (m) => require(path.join(process.cwd(), 'lib', m));
const floor = L('floor.js');
const mailbox = L('mailbox.js');
const fleet = L('fleet.js');
const hooks = L('hooks.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra='') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra?' — '+extra:''}`); };

// ── Refuse to run against a live floor ──────────────────────────────────────
// This file wipes `data/floor/`. A running server means real agents with real
// mail in those directories, and wiping it loses their inboxes, their private
// memory.md files, and the task ledger — none of which is recoverable. The socket
// is the reliable tell: it only exists while the hook server is listening, and a
// successful connect proves that server is alive rather than a leftover file.
async function assertFloorIsDown() {
  // Only relevant when someone has pointed this run at the real floor by hand.
  // The default temp tree cannot collide with a running server.
  const real = path.join(process.cwd(), 'data', 'floor');
  if (path.resolve(floor.FLOOR_ROOT) !== path.resolve(real)) return;
  let pid = null;
  try {
    pid = parseInt(fs.readFileSync(floor.PID_FILE, 'utf8').trim(), 10);
  } catch {
    return; // no claim on the floor
  }
  if (!Number.isInteger(pid)) return;
  try {
    process.kill(pid, 0); // signal 0 tests liveness without touching the process
  } catch {
    return; // stale pidfile from a crash: harmless
  }
  console.error(
    `REFUSING TO RUN: the floor is up (server pid ${pid}).\n` +
      'FLOOR_ROOT points at the live data/floor/ — running would wipe agent inboxes,\n' +
    'private memory, and the ledger. Unset FLOOR_ROOT to use an isolated temp tree.\n' +
      'Stop the server first, or set FLOOR_TEST_FORCE=1 if you really mean it.',
  );
  process.exit(2);
}

async function main() {
if (process.env.FLOOR_TEST_FORCE !== '1') await assertFloorIsDown();

// clean slate
fs.rmSync(floor.FLOOR_ROOT, { recursive: true, force: true });
fs.mkdirSync(floor.AGENTS_DIR, { recursive: true });

mailbox.writeProtocol();
ok('PROTOCOL.md generated', fs.existsSync(floor.PROTOCOL_FILE));
const proto = fs.readFileSync(floor.PROTOCOL_FILE, 'utf8');
ok('protocol lists the live roster', proto.includes('hq/oc-dev-1') && proto.includes('**lead**'));

for (const { key } of mailbox.roster()) mailbox.ensureAgentDirs(key);
ok('mailboxes created', fs.existsSync(path.join(floor.agentDir('hq/oc-dev-1'), 'inbox')));
ok('private memory.md seeded', fs.existsSync(path.join(floor.agentDir('hq/qa'), 'memory.md')));

// --- 1. a normal dispatch -------------------------------------------------
fs.writeFileSync(
  path.join(floor.agentDir('hq/lead'), 'outbox', 'dispatch.json'),
  JSON.stringify({ to: 'oc-dev-1', act: 'request', subject: 'Slice 1', body: 'OBJECTIVE... OUTPUT... TOOLS... BOUNDARIES...' }),
);
mailbox.drainOutboxes();
const inbox = mailbox.pendingInbox('hq/oc-dev-1');
ok('message delivered', inbox.length === 1, inbox[0]?.subject);
ok('router stamped from/id/hops', inbox[0]?.from === 'hq/lead' && !!inbox[0]?.id && inbox[0]?.hops === 0);
ok('request obligates a reply', inbox[0]?.requires_reply === true);
ok('outbox drained to .sent', fs.readdirSync(path.join(floor.agentDir('hq/lead'), 'outbox')).filter(f=>f.endsWith('.json')).length === 0);

// --- 2. an agent cannot forge its own from/hops ---------------------------
fs.writeFileSync(
  path.join(floor.agentDir('hq/qa'), 'outbox', 'forge.json'),
  JSON.stringify({ to: 'lead', act: 'inform', subject: 'spoof', body: 'x', from: 'hq/lead', hops: 0, id: 'chosen-by-me' }),
);
mailbox.drainOutboxes();
const leadBox = mailbox.pendingInbox('hq/lead');
const forged = leadBox.find(m => m.subject === 'spoof');
ok('from cannot be forged', forged?.from === 'hq/qa', `got ${forged?.from}`);
ok('id cannot be forged', forged?.id !== 'chosen-by-me');
ok('inform is terminal', forged?.requires_reply === false);

// --- 3. unknown recipient bounces ----------------------------------------
fs.writeFileSync(
  path.join(floor.agentDir('hq/qa'), 'outbox', 'nowhere.json'),
  JSON.stringify({ to: 'ghost-agent', act: 'request', subject: 'hello?', body: 'x' }),
);
mailbox.drainOutboxes();
const bounced = mailbox.pendingInbox('hq/qa').find(m => m.subject.startsWith('Undelivered'));
ok('unknown recipient bounces to sender', !!bounced, bounced?.body.slice(0, 60));
ok('a bounce is terminal', bounced?.act === 'inform');

// --- 4. hop cap ----------------------------------------------------------
fs.writeFileSync(
  path.join(floor.agentDir('hq/qa'), 'outbox', 'deep.json'),
  JSON.stringify({ to: 'lead', act: 'request', subject: 'too deep', body: 'x', hops: mailbox.HOP_CAP + 1 }),
);
mailbox.drainOutboxes();
ok('hop cap drops the message', !mailbox.pendingInbox('hq/lead').some(m => m.subject === 'too deep'));
ok('hop cap tells the sender', mailbox.pendingInbox('hq/qa').some(m => m.body.includes(`${mailbox.HOP_CAP}-hop cap`)));
ok('drop is logged', floor.readLog().some(e => e.kind === 'drop' && e.reason === 'hop-cap'));

// --- 5. cross-office addressing is explicit ------------------------------
ok('bare id stays in the office', mailbox.resolveTo('oc-dev-1', 'hq/qa').join() === 'hq/oc-dev-1');
ok('full key works', mailbox.resolveTo('hq/oc-dev2', 'hq/qa').join() === 'hq/oc-dev2');
ok('human goes to the lead', mailbox.resolveTo('human', 'hq/qa').join() === 'hq/lead');

// --- 6. unparseable outbox file is moved aside, not retried forever -------
fs.writeFileSync(path.join(floor.agentDir('hq/qa'), 'outbox', 'junk.json'), 'not json at all');
mailbox.drainOutboxes();
ok('junk moved aside', !fs.existsSync(path.join(floor.agentDir('hq/qa'), 'outbox', 'junk.json')));

// --- 7. the hook plane ---------------------------------------------------
const server = hooks.startHookServer((p) => p.agent_key);
const shim = path.join(process.cwd(), 'bin', 'floor-hook.cjs');

// Async on purpose: the hook server runs in this same process, so a synchronous
// child would block the event loop that has to serve it.
function fire(payload, status = false) {
  return new Promise((resolve) => {
    const args = status ? [shim, '--status'] : [shim];
    const child = execFile(process.execPath, args, {
      env: { ...process.env, FLOOR_SOCK: floor.SOCK_FILE, AGENT_KEY: payload.agent_key },
      encoding: 'utf8',
    }, (_err, stdout) => resolve(stdout || ''));
    child.stdin.end(JSON.stringify(payload));
  });
}

await (async () => {
  const K = 'hq/oc-dev2';
  const t0 = Date.now();
  const out = await fire({ hook_event_name: 'Status', agent_key: K, session_id: 'sess-1',
    context_window: { total_input_tokens: 45000, context_window_size: 200000 },
    cost: { total_cost_usd: 1.25 } }, true);
  ok('status line prints the gauge', out === 'ctx 45k/200k (23%)', JSON.stringify(out));

  const r = fleet.get(K);
  ok('status telemetry recorded', r?.tokens === 45000 && r?.ctxPct === 23 && r?.usd === 1.25, JSON.stringify({t:r?.tokens,p:r?.ctxPct,u:r?.usd}));

  // a real loop: same tool, same args, over and over
  for (let i = 0; i < 21; i++) {
    await fire({ hook_event_name: 'PostToolUse', agent_key: K, tool_name: 'Bash', tool_input: { command: 'yarn test' }, tool_response: { is_error: true } });
  }
  const perCall = (Date.now() - t0) / 22;
  ok('a hook round-trip is fast enough to sit on every tool call', perCall < 250, `${perCall.toFixed(0)}ms each`);

  const r2 = fleet.get(K);
  ok('breaker escalated to stop', r2?.breaker === 'stop', `${r2?.breaker} after ${r2?.repeatRun} repeats`);
  ok('breaker warned the agent in its own inbox', mailbox.pendingInbox(K).some(m => m.subject.startsWith('Circuit breaker')));
  const steers = mailbox.pendingInbox(K).filter(m => m.subject.startsWith('Circuit breaker'));
  ok('one message per level, not per tool call', steers.length === 3, `${steers.length} breaker messages`);

  const denied = await fire({ hook_event_name: 'PreToolUse', agent_key: K, tool_name: 'Bash', tool_input: { command: 'yarn test' } });
  ok('PreToolUse denies once stopped', JSON.parse(denied || '{}').hookSpecificOutput?.permissionDecision === 'deny', denied.slice(0, 80));

  fleet.resetBreaker(K);
  ok('reset clears it', (await fire({ hook_event_name: 'PreToolUse', agent_key: K, tool_name: 'Bash', tool_input: {} })).trim() === '');

  // a different signature breaks the run
  const K2 = 'hq/qa';
  for (let i = 0; i < 10; i++) {
    await fire({ hook_event_name: 'PostToolUse', agent_key: K2, tool_name: 'Read', tool_input: { file: `f${i}.js` } });
  }
  ok('varied work does not trip the breaker', (fleet.get(K2)?.breaker || 'healthy') === 'healthy');

  // ride-along mail delivery
  const K3 = 'hq/oc-dev-1';
  const ctx = await fire({ hook_event_name: 'UserPromptSubmit', agent_key: K3, prompt: 'hi' });
  ok('pending mail rides along on a turn already happening',
    (JSON.parse(ctx || '{}').hookSpecificOutput?.additionalContext || '').includes('unread message'), ctx.slice(0, 70));
  ok('and is not injected twice', (await fire({ hook_event_name: 'UserPromptSubmit', agent_key: K3, prompt: 'hi' })).trim() === '');

  ok('an unknown agent_key is ignored', (await fire({ hook_event_name: 'PostToolUse', agent_key: 'ghost/agent', tool_name: 'Bash' })).trim() === '');

  const snap = fleet.snapshot(mailbox.roster().map(r => ({ key: r.key, office: r.office.id, agent: r.agent.id, name: r.agent.name, lead: r.lead, status: 'offline', inboxBacklog: mailbox.pendingInbox(r.key).length })));
  ok('fleet covers every agent, booted or not', snap.agents.length === mailbox.roster().length);
  ok('fleet carries the backlog', snap.agents.find(a => a.key === 'hq/oc-dev-1')?.inboxBacklog > 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  try {
    fs.rmSync(floor.FLOOR_ROOT, { recursive: true, force: true });
  } catch {}
  process.exit(fail ? 1 : 0);
})();
}

main();
