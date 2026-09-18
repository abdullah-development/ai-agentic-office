/*
 * The hook plane — a unix socket the agents' lifecycle hooks talk to.
 *
 * Each agent is spawned with `--settings <its own settings.json>`, and that file
 * points every Claude Code lifecycle event at `bin/floor-hook.cjs`. The shim
 * forwards the event here over `data/floor/hooks.sock` and writes our reply back
 * to stdout, which is how a hook returns a decision.
 *
 * ── What we use hooks FOR, and what we deliberately do not ──────────────────
 * Upstream originally used the `Stop` hook to force an agent with unread mail to
 * keep working, and then removed it themselves (HIVE-SPEC.md §1.5) because it
 * bypassed the human-in-the-loop gate and could spend credits while the human was
 * mid-answer. We are not rebuilding that. Nothing here ever forces a turn.
 *
 * What hooks give us instead is worth having on its own:
 *
 *   - exact telemetry. The status payload carries the real context-window size
 *     and the session's real cost; scraping the PTY can only ever approximate them.
 *   - per-tool events, which is what the circuit breaker needs to see a loop.
 *   - a free ride for pending mail. `SessionStart` and `UserPromptSubmit` can add
 *     context to a turn that is ALREADY happening. That costs nothing extra and
 *     cannot wake a sleeping agent — the exact property the removed Stop hook
 *     lacked. The idle-gated PTY nudge in `server.js` remains the thing that
 *     actually wakes an idle agent, and it keeps its `agentState() !== 'done'` gate.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { FLOOR_ROOT, SOCK_FILE, agentDir, logEvent } = require('./floor.js');
const fleet = require('./fleet.js');
const { unnudged, markNudged } = require('./mailbox.js');

const HOOKS_ON = process.env.FLOOR_HOOKS !== '0';
// Ride-along delivery of pending mail on turns that are already happening.
const INJECT_ON = process.env.FLOOR_INJECT !== '0';
// The floor's status line replaces whatever the user configured globally, so it
// can be turned off on its own.
const STATUSLINE_ON = process.env.FLOOR_STATUSLINE !== '0';

const SHIM = path.join(process.cwd(), 'bin', 'floor-hook.cjs');

// Every lifecycle event this build of Claude Code emits. Verified against the
// installed CLI rather than copied from docs — an event name that does not exist
// is silently ignored, which would look exactly like a broken hook.
const EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'SessionEnd',
];
// Events that take a `matcher`; the rest are registered bare.
const MATCHED = new Set(['PreToolUse', 'PostToolUse']);

/**
 * Write (and return the path to) one agent's settings file.
 *
 * The node binary is written in absolute form on purpose: hooks run through a
 * shell whose PATH we do not control, and "node not found" would disable the
 * whole plane silently. `process.execPath` is the interpreter already running
 * this server, so it is guaranteed to exist.
 */
function writeAgentSettings(key) {
  const dir = agentDir(key);
  fs.mkdirSync(dir, { recursive: true });
  const command = `"${process.execPath}" "${SHIM}"`;
  const hooks = {};
  for (const event of EVENTS) {
    const entry = { hooks: [{ type: 'command', command }] };
    if (MATCHED.has(event)) entry.matcher = '*';
    hooks[event] = [entry];
  }
  const settings = {
    // `--settings` merges on top of the user's own settings, so keep this file to
    // only what the floor needs. Anything else here would silently override a
    // preference the human set for themselves.
    permissions: { additionalDirectories: [FLOOR_ROOT] },
    ...(HOOKS_ON ? { hooks } : {}),
    ...(STATUSLINE_ON ? { statusLine: { type: 'command', command: `${command} --status`, padding: 0 } } : {}),
  };
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return file;
}

// ---- event handling --------------------------------------------------------

/** Tool name + arguments, hashed. Identical signatures back to back are a loop. */
function signature(payload) {
  let args = '';
  try {
    args = JSON.stringify(payload.tool_input || {});
  } catch {
    args = String(payload.tool_input || '');
  }
  return crypto.createHash('sha1').update(`${payload.tool_name || ''}|${args}`).digest('hex').slice(0, 16);
}

/**
 * Did this tool call fail? Claude Code reports errors in more than one shape
 * depending on the tool, so check the ones that exist rather than trusting one.
 */
function failed(payload) {
  const r = payload.tool_response;
  if (!r) return false;
  if (typeof r === 'object') {
    if (r.is_error === true || r.isError === true) return true;
    if (typeof r.error === 'string' && r.error) return true;
    if (typeof r.stderr === 'string' && /error|traceback|command not found/i.test(r.stderr)) return true;
  }
  if (typeof r === 'string' && /^error[:\s]/i.test(r.trim())) return true;
  return false;
}

/** The ride-along note about pending mail, or null when there is none. */
function mailNote(key) {
  if (!INJECT_ON) return null;
  const pending = unnudged(key);
  if (!pending.length) return null;
  const ids = pending.map((m) => m.id);
  markNudged(key, ids);
  const lines = pending
    .slice(0, 8)
    .map((m) => `- ${m.id} — ${m.act} from ${m.from}: ${m.subject}`)
    .join('\n');
  const more = pending.length > 8 ? `\n- (+${pending.length - 8} more)` : '';
  return (
    `You have ${pending.length} unread message(s) in your floor inbox:\n${lines}${more}\n\n` +
    `Your inbox DIRECTORY is authoritative, not this list: work everything still pending in it, ` +
    `and if a named id is already in inbox/.done/ you handled it on an earlier turn and can ignore that one. ` +
    `Move each message to inbox/.done/ once handled. Act autonomously; only message your lead if you genuinely need a decision.`
  );
}

/** Handle one hook event. Returns the JSON to write back, or null for "no opinion". */
function handle(payload, resolveKey) {
  const key = resolveKey(payload);
  const event = payload.hook_event_name;
  if (!key) return null;

  switch (event) {
    case 'Status': {
      const cw = payload.context_window || {};
      fleet.noteStatus(key, {
        used: cw.total_input_tokens,
        size: cw.context_window_size,
        usd: payload.cost?.total_cost_usd,
        sessionId: payload.session_id,
      });
      return null; // the shim already printed the gauge; nothing to return
    }

    case 'PreToolUse': {
      // The ONLY place the floor overrules an agent, and only at the last rung.
      if (fleet.shouldDeny(key)) {
        const r = fleet.get(key);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `Floor circuit breaker is STOPPED for this agent (${r?.breakerReason || 'runaway behaviour'}). Summarise where you got to, message your lead, and end your turn.`,
          },
        };
      }
      fleet.noteActivity(key);
      return null;
    }

    case 'PostToolUse':
      fleet.noteTool(key, payload.tool_name, signature(payload), failed(payload));
      return null;

    case 'SessionStart': {
      fleet.noteSession(key, payload.session_id);
      const note = mailNote(key);
      return note
        ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: note } }
        : null;
    }

    case 'UserPromptSubmit': {
      fleet.noteActivity(key);
      const note = mailNote(key);
      return note
        ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: note } }
        : null;
    }

    case 'SessionEnd':
      fleet.noteActivity(key);
      logEvent({ kind: 'session', agent: key, event: 'end' });
      return null;

    default:
      // Stop, SubagentStart, SubagentStop, Notification, PreCompact, PostCompact.
      // All we want from these is "this agent is alive and moved just now".
      fleet.noteActivity(key);
      return null;
  }
}

// ---- the socket ------------------------------------------------------------

/**
 * Start listening. `resolveKey` maps a payload to an `office/agent` key — the
 * server owns that mapping because it owns the spawn.
 */
function startHookServer(resolveKey) {
  fs.mkdirSync(FLOOR_ROOT, { recursive: true });
  // A socket file left behind by a crash would make listen() fail with EADDRINUSE
  // forever. Nothing else can own this path, so removing it is always right.
  try {
    fs.unlinkSync(SOCK_FILE);
  } catch {}

  const server = net.createServer((conn) => {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let reply = null;
        try {
          reply = handle(JSON.parse(line), resolveKey);
        } catch (err) {
          logEvent({ kind: 'hook-error', error: err.message });
        }
        // Close as soon as we have answered. One connection carries exactly one
        // event, and Claude Code BLOCKS on the hook process exiting — leaving the
        // socket open would make every tool call wait out the shim's timeout
        // before the agent could continue. Five seconds per tool call.
        try {
          conn.end(reply ? JSON.stringify(reply) : '');
        } catch {}
      }
    });
    // Fire-and-forget senders (the status line) close their end and never read;
    // half-open connections are normal here, not an error.
    conn.on('error', () => {});
    conn.on('end', () => {
      try {
        conn.end();
      } catch {}
    });
  });

  server.on('error', (err) => {
    console.error(`> floor hooks: socket unavailable (${err.message}) — telemetry is off, agents are unaffected`);
  });
  server.listen(SOCK_FILE, () => {
    console.log(`> floor hooks listening on ${path.relative(process.cwd(), SOCK_FILE)}`);
  });

  const cleanup = () => {
    try {
      fs.unlinkSync(SOCK_FILE);
    } catch {}
  };
  process.on('exit', cleanup);
  return server;
}

module.exports = { EVENTS, HOOKS_ON, writeAgentSettings, startHookServer, handle, signature, failed };
