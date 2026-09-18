/*
 * Fleet telemetry and the circuit breaker.
 *
 * Every lifecycle hook an agent fires lands here (see `lib/hooks.js`), which makes
 * this the one place that knows what each agent is actually doing — which tool it
 * just ran, how full its context is, what it has cost, how long since it moved.
 * Two things consume that:
 *
 *   - `data/floor/fleet.json`, rewritten on a timer. It is how a LEAD gets
 *     situational awareness without a UI: a lead can read that one file and see
 *     its whole office. The UI reads the same numbers over HTTP.
 *   - The circuit breaker below.
 *
 * ── Why a breaker at all ────────────────────────────────────────────────────
 * The failure mode that costs real money is not a crash — a crash stops. It is an
 * agent that keeps going: the same tool with the same arguments forty times, or a
 * loop of failing calls it keeps retrying. Nobody is watching a terminal at 3am.
 * So the breaker escalates rather than killing outright:
 *
 *   steer      — a message in the agent's own inbox saying it is the problem.
 *   constrain  — the same, plus: go read-only, get your lead's sign-off.
 *   stop       — PreToolUse starts denying. This is the only level that takes
 *                the decision away from the agent, and it is deliberately last.
 *
 * The agent is told through its INBOX, not through a side channel, because the
 * inbox is the thing it already reads and the message needs to arrive in the same
 * place as everything else it has been told.
 */
const { FLEET_FILE, atomicWriteJson, logEvent } = require('./floor.js');
const { sendSystem } = require('./mailbox.js');

// Same tool, same arguments, this many times running before we say anything.
const REPEAT_STEER = parseInt(process.env.FLOOR_REPEAT_STEER || '8', 10);
const REPEAT_CONSTRAIN = parseInt(process.env.FLOOR_REPEAT_CONSTRAIN || '14', 10);
const REPEAT_STOP = parseInt(process.env.FLOOR_REPEAT_STOP || '20', 10);
// Consecutive failing tool calls.
const ERROR_STEER = parseInt(process.env.FLOOR_ERROR_STEER || '6', 10);
const ERROR_CONSTRAIN = parseInt(process.env.FLOOR_ERROR_CONSTRAIN || '12', 10);
// Per-agent session spend, in dollars. 0 disables the spend rung entirely.
const USD_STEER = parseFloat(process.env.FLOOR_USD_STEER || '0');
const USD_CONSTRAIN = parseFloat(process.env.FLOOR_USD_CONSTRAIN || '0');
// The breaker can be switched off wholesale; telemetry keeps working.
const BREAKER_ON = process.env.FLOOR_BREAKER !== '0';

const LEVELS = ['healthy', 'steer', 'constrain', 'stop'];
const rank = (l) => Math.max(0, LEVELS.indexOf(l));

/** @type {Map<string, object>} keyed by `office/agent` */
const agents = new Map();

function record(key) {
  if (!agents.has(key)) {
    agents.set(key, {
      key,
      sessionId: null,
      tokens: 0,
      ctxSize: 0,
      ctxPct: 0,
      usd: 0,
      lastTool: null,
      lastToolAt: null,
      lastActiveAt: null,
      toolCalls: 0,
      repeatSig: null,
      repeatRun: 0,
      errorRun: 0,
      breaker: 'healthy',
      breakerReason: null,
      breakerAt: null,
      notified: 'healthy',
    });
  }
  return agents.get(key);
}

const get = (key) => agents.get(key) || null;
const forget = (key) => agents.delete(key);

// ---- ingest ----------------------------------------------------------------

/** Context-window gauge, from the statusLine payload. */
function noteStatus(key, { used, size, usd, sessionId }) {
  const r = record(key);
  if (Number.isFinite(used)) r.tokens = used;
  if (Number.isFinite(size) && size > 0) r.ctxSize = size;
  if (r.ctxSize > 0) r.ctxPct = Math.round((r.tokens / r.ctxSize) * 100);
  if (Number.isFinite(usd)) r.usd = usd;
  if (sessionId) r.sessionId = sessionId;
  r.lastActiveAt = Date.now();
  return checkBreaker(key);
}

function noteSession(key, sessionId) {
  const r = record(key);
  if (sessionId) r.sessionId = sessionId;
  r.lastActiveAt = Date.now();
}

/** Any sign of life that is not a tool call — a prompt, a notification, a stop. */
function noteActivity(key) {
  record(key).lastActiveAt = Date.now();
}

/**
 * A tool call. `signature` is tool name + arguments: identical signatures back to
 * back are the loop we are looking for, and a *different* signature resets the
 * run, because an agent that changed what it is doing is making progress.
 */
function noteTool(key, name, signature, failed) {
  const r = record(key);
  r.toolCalls += 1;
  r.lastTool = name || null;
  r.lastToolAt = Date.now();
  r.lastActiveAt = Date.now();
  if (signature && signature === r.repeatSig) r.repeatRun += 1;
  else {
    r.repeatSig = signature || null;
    r.repeatRun = 1;
  }
  if (failed) r.errorRun += 1;
  else r.errorRun = 0;
  return checkBreaker(key);
}

// ---- the breaker -----------------------------------------------------------

function verdict(r) {
  if (!BREAKER_ON) return null;
  if (r.repeatRun >= REPEAT_STOP) {
    return { level: 'stop', reason: `the same tool call (${r.lastTool}) repeated ${r.repeatRun} times in a row` };
  }
  if (r.repeatRun >= REPEAT_CONSTRAIN) {
    return { level: 'constrain', reason: `the same tool call (${r.lastTool}) repeated ${r.repeatRun} times in a row` };
  }
  if (r.errorRun >= ERROR_CONSTRAIN) {
    return { level: 'constrain', reason: `${r.errorRun} tool calls in a row have failed` };
  }
  if (r.repeatRun >= REPEAT_STEER) {
    return { level: 'steer', reason: `the same tool call (${r.lastTool}) repeated ${r.repeatRun} times in a row` };
  }
  if (r.errorRun >= ERROR_STEER) {
    return { level: 'steer', reason: `${r.errorRun} tool calls in a row have failed` };
  }
  if (USD_CONSTRAIN > 0 && r.usd >= USD_CONSTRAIN) {
    return { level: 'constrain', reason: `this session has spent $${r.usd.toFixed(2)}, over the $${USD_CONSTRAIN.toFixed(2)} limit` };
  }
  if (USD_STEER > 0 && r.usd >= USD_STEER) {
    return { level: 'steer', reason: `this session has spent $${r.usd.toFixed(2)}, past the $${USD_STEER.toFixed(2)} soft budget` };
  }
  return null;
}

const ADVICE = {
  steer:
    'Stop repeating. Summarise in one message what you have tried and what actually happened, then try a different approach — or ask your lead. Do not run that same call again.',
  constrain:
    'You are now CONSTRAINED: go read-only. Do not edit, write, or run anything that changes state. Message your lead with what you were attempting and what went wrong, and wait for their sign-off before any further tool calls.',
  stop:
    'You are STOPPED: further tool calls are being denied. Write a short summary of where you got to and what is left, message your lead, and end your turn.',
};

/**
 * Re-evaluate one agent and, if it has got worse, tell it — once per level.
 *
 * Only escalation notifies. A breaker that re-sent its warning on every tool call
 * would itself become the loop it is there to catch.
 */
function checkBreaker(key) {
  const r = record(key);
  const v = verdict(r);
  if (!v) return r.breaker;
  if (rank(v.level) <= rank(r.breaker)) return r.breaker;

  r.breaker = v.level;
  r.breakerReason = v.reason;
  r.breakerAt = Date.now();
  logEvent({ kind: 'breaker', agent: key, level: v.level, reason: v.reason });

  if (r.notified !== v.level) {
    r.notified = v.level;
    sendSystem(key, {
      to: key,
      act: 'inform', // terminal on purpose: this is not a conversation
      from: 'floor/breaker',
      subject: `Circuit breaker: ${v.level}`,
      body: `The floor's circuit breaker caught runaway behaviour on your session — ${v.reason}.\n\nYou ARE the problem it caught. ${ADVICE[v.level]}`,
    });
  }
  return r.breaker;
}

/** Clear a breaker — the human's call, from the UI. */
function resetBreaker(key) {
  const r = record(key);
  r.breaker = 'healthy';
  r.breakerReason = null;
  r.breakerAt = null;
  r.notified = 'healthy';
  r.repeatRun = 0;
  r.errorRun = 0;
  logEvent({ kind: 'breaker', agent: key, level: 'reset' });
  return r;
}

/** Called from PreToolUse. Only `stop` actually blocks anything. */
const shouldDeny = (key) => get(key)?.breaker === 'stop';

// ---- fleet.json ------------------------------------------------------------

/**
 * Snapshot every agent on the floor, whether or not it has fired a hook yet.
 *
 * `rows` comes from the caller (server.js owns the roster and the PTY state);
 * this only decorates it with telemetry, so nothing here has to know about node-pty.
 */
function snapshot(rows) {
  const now = Date.now();
  return {
    ts: now,
    agents: rows.map((row) => {
      const r = get(row.key);
      return {
        key: row.key,
        office: row.office,
        agent: row.agent,
        name: row.name || row.agent,
        lead: Boolean(row.lead),
        status: row.status,
        cwd: row.cwd || null,
        sessionId: r?.sessionId || null,
        tokens: r?.tokens || 0,
        ctxSize: r?.ctxSize || 0,
        ctxPct: r?.ctxPct || 0,
        usd: Number((r?.usd || 0).toFixed(4)),
        lastTool: r?.lastTool || null,
        toolCalls: r?.toolCalls || 0,
        lastActiveSecAgo: r?.lastActiveAt ? Math.round((now - r.lastActiveAt) / 1000) : null,
        breaker: r?.breaker || 'healthy',
        breakerReason: r?.breakerReason || null,
        inboxBacklog: row.inboxBacklog || 0,
      };
    }),
  };
}

function writeFleet(rows) {
  const snap = snapshot(rows);
  try {
    atomicWriteJson(FLEET_FILE, snap);
  } catch {}
  return snap;
}

module.exports = {
  LEVELS,
  BREAKER_ON,
  record,
  get,
  forget,
  noteStatus,
  noteSession,
  noteActivity,
  noteTool,
  checkBreaker,
  resetBreaker,
  shouldDeny,
  snapshot,
  writeFleet,
};
