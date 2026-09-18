/*
 * Floor primitives — where the mailbox lives on disk, and the handful of write
 * operations everything else is built out of.
 *
 * Three rules from the upstream design (HIVE-SPEC.md §1.2) are load-bearing here
 * and every other module in the floor layer depends on them holding:
 *
 *   1. SINGLE WRITER PER FILE. An agent writes only inside its own
 *      `agents/<key>/` directory. Nothing is ever co-edited by two processes.
 *      The one genuinely shared surface (office memory) keeps its existing
 *      append-only convention and is NOT routed through here.
 *   2. ONE JSON FILE PER MESSAGE, written temp-file + atomic rename. A shared
 *      mailbox file would interleave writes from two processes and lose mail.
 *   3. APPEND-ONLY `log.jsonl`. Each consumer tracks its own cursor.
 *
 * CommonJS on purpose: `server.js` requires it, the API routes import it.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// `FLOOR_ROOT` can be overridden so a test run gets its own tree. Without it the
// suite's fixtures — a dispatch, three circuit-breaker warnings, two bounces —
// land in the REAL agents' inboxes, and the nudge cheerfully wakes an agent to
// tell it that it has been constrained when it has not.
const FLOOR_ROOT = process.env.FLOOR_ROOT || path.join(process.cwd(), 'data', 'floor');
const AGENTS_DIR = path.join(FLOOR_ROOT, 'agents');
const LOG_FILE = path.join(FLOOR_ROOT, 'log.jsonl');
const TASKS_FILE = path.join(FLOOR_ROOT, 'tasks.json');
const FLEET_FILE = path.join(FLOOR_ROOT, 'fleet.json');
const PROTOCOL_FILE = path.join(FLOOR_ROOT, 'PROTOCOL.md');
const SOCK_FILE = path.join(FLOOR_ROOT, 'hooks.sock');
// Deliberately OUTSIDE FLOOR_ROOT. Its whole job is to say "a server owns this
// floor", and anything inside data/floor/ is gone the moment something wipes the
// floor — which is exactly the moment the answer matters most.
const PID_FILE = path.join(process.cwd(), 'data', '.floor.pid');

/**
 * Session keys are `office/agent`; directory keys are `office__agent`.
 *
 * A slash cannot appear in a directory name, and nesting `agents/<office>/<agent>/`
 * would put the router's `fs.watch` two levels deeper on a platform where nested
 * watch events are already unreliable. One flat level, double underscore, done.
 */
const dirKey = (key) => String(key).replace('/', '__');
const sessionKey = (dir) => String(dir).replace('__', '/');
const agentDir = (key) => path.join(AGENTS_DIR, dirKey(key));

/** Message ids are time-sortable so an inbox listing is already in order. */
function newMessageId() {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Write via temp file + rename, so a reader never sees a half-written message.
 *
 * The temp file is created in the SAME directory as the target: `rename` is only
 * atomic within one filesystem, and `os.tmpdir()` is frequently a different one.
 */
function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

const atomicWriteJson = (file, data) => atomicWrite(file, `${JSON.stringify(data, null, 2)}\n`);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * The floor's event feed. Append-only, one JSON object per line, never throws —
 * a full disk or a permissions problem must not take the router down with it.
 */
function logEvent(event) {
  try {
    fs.mkdirSync(FLOOR_ROOT, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${JSON.stringify({ ts: Date.now(), ...event })}\n`);
  } catch {}
}

/** Read the tail of the event feed, newest last. Used by the UI, not by agents. */
function readLog(limit = 200) {
  let text = '';
  try {
    text = fs.readFileSync(LOG_FILE, 'utf8');
  } catch {
    return [];
  }
  const lines = text.split('\n').filter(Boolean);
  const out = [];
  for (const line of lines.slice(-limit)) {
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

module.exports = {
  FLOOR_ROOT,
  AGENTS_DIR,
  LOG_FILE,
  TASKS_FILE,
  FLEET_FILE,
  PROTOCOL_FILE,
  SOCK_FILE,
  PID_FILE,
  dirKey,
  sessionKey,
  agentDir,
  newMessageId,
  atomicWrite,
  atomicWriteJson,
  readJson,
  logEvent,
  readLog,
};
