/*
 * The floor router — agent-to-agent messaging.
 *
 * An agent writes ONE JSON file into its own `outbox/`. This module picks it up,
 * fills in the fields the agent is not allowed to forge (`id`, `from`, `hops`,
 * timestamps), resolves the recipient, and writes it atomically into that
 * recipient's `inbox/`. Agents never deliver anything themselves and never write
 * into another agent's directory — that is the whole point, and it is what keeps
 * every file single-writer.
 *
 * The schema is FIPA-lite (HIVE-SPEC.md §1.3): the one good idea from FIPA-ACL is
 * the speech act, so that is what we keep.
 *
 * ── Why the loop guards ship in the first version, not "later" ──────────────
 * Two agents replying to each other politely forever is not a hypothetical; it is
 * the default behaviour of a mailbox without guards, and it burns real tokens
 * overnight with nobody watching. All four guards below are therefore part of the
 * router itself rather than a follow-up phase:
 *
 *   1. `inform` and `done` are TERMINAL — replying to one is a protocol
 *      violation. Only `request` / `query` / `propose` obligate a reply.
 *   2. Every reply increments `hops`; past HOP_CAP the message is dropped and
 *      logged, and the sender is told once.
 *   3. Handled mail moves to `inbox/.done/`; re-seeing an id is a no-op.
 *   4. An unknown recipient BOUNCES back to the sender. Mail never vanishes
 *      silently — a lost instruction is worse than a rejected one.
 */
const fs = require('fs');
const path = require('path');
const {
  FLOOR_ROOT,
  AGENTS_DIR,
  PROTOCOL_FILE,
  agentDir,
  dirKey,
  sessionKey,
  newMessageId,
  atomicWrite,
  atomicWriteJson,
  readJson,
  logEvent,
} = require('./floor.js');
const { readState, isLead } = require('./skills.js');

const HOP_CAP = parseInt(process.env.FLOOR_HOP_CAP || '12', 10);
const ACTS = ['request', 'inform', 'propose', 'query', 'agree', 'refuse', 'done'];
const REPLY_ACTS = new Set(['request', 'query', 'propose']);

// Server-owned nudge bookkeeping. Deliberately NOT inside an agent's directory:
// everything under `agents/<key>/` belongs to that agent, and a file the server
// also writes would be the one exception that breaks the single-writer rule.
const CURSOR_FILE = path.join(FLOOR_ROOT, 'cursors.json');

// ---- roster ----------------------------------------------------------------

/** Every `office/agent` key on the floor, with its office and agent records. */
function roster() {
  const out = [];
  for (const office of readState().offices || []) {
    for (const agent of office.agents || []) {
      if (!office.id || !agent.id) continue;
      out.push({ key: `${office.id}/${agent.id}`, office, agent, lead: isLead(agent) });
    }
  }
  return out;
}

const leadOf = (oid) => roster().find((r) => r.office.id === oid && r.lead) || null;

// ---- directories -----------------------------------------------------------

/** Idempotent; called from the spawn path so a mailbox exists before the agent does. */
function ensureAgentDirs(key) {
  const dir = agentDir(key);
  for (const sub of ['', 'inbox', path.join('inbox', '.done'), 'outbox', path.join('outbox', '.sent')]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  const memory = path.join(dir, 'memory.md');
  if (!fs.existsSync(memory)) {
    const [oid, aid] = String(key).split('/');
    fs.writeFileSync(
      memory,
      `# ${aid} (${oid}) — private memory\n\n_Yours alone. Read it at the start of a task; append durable facts, decisions, and context as you learn them._\n`,
    );
  }
  return dir;
}

// ---- schema ----------------------------------------------------------------

/**
 * Turn what the agent wrote into a real message.
 *
 * The agent supplies only `to`, `act`, `subject`, `body` (+ optional
 * `conversation` / `in_reply_to`). Everything else is filled in here — an agent
 * that could set its own `from` or reset its own `hops` could walk straight
 * through two of the four guards.
 */
function normalize(partial, fromKey) {
  const [office] = String(fromKey).split('/');
  const act = ACTS.includes(partial.act) ? partial.act : 'inform';
  return {
    id: newMessageId(),
    conversation: partial.conversation ? String(partial.conversation).slice(0, 120) : `conv-${newMessageId().slice(-6)}`,
    in_reply_to: partial.in_reply_to ? String(partial.in_reply_to).slice(0, 120) : null,
    from: fromKey,
    office,
    to: String(partial.to || '').trim(),
    act,
    subject: String(partial.subject || '(no subject)').slice(0, 300),
    body: String(partial.body == null ? '' : partial.body),
    hops: Number.isFinite(partial.hops) ? Number(partial.hops) : 0,
    requires_reply: REPLY_ACTS.has(act),
    needs_human: Boolean(partial.needs_human),
    created_at: new Date().toISOString(),
  };
}

/**
 * Resolve a `to` field to concrete session keys.
 *
 * Accepts `<agent-id>` (same office), `<office>/<agent-id>`, `lead`,
 * `<office>/lead`, `floor` (every lead), and `human`.
 */
function resolveTo(to, fromKey) {
  const want = String(to || '').trim();
  const [fromOffice] = String(fromKey).split('/');
  const all = roster();
  if (!want) return [];

  if (/^(floor|broadcast|all)$/i.test(want)) {
    return all.filter((r) => r.lead && r.key !== fromKey).map((r) => r.key);
  }
  // `human` still has to land somewhere an agent will read: the office lead is
  // the human's proxy on the floor. The escalation itself is raised on the task
  // ledger by the caller — this only decides who gets told.
  if (/^human$/i.test(want)) {
    const lead = leadOf(fromOffice);
    return lead && lead.key !== fromKey ? [lead.key] : [];
  }
  if (/^lead$/i.test(want)) {
    const lead = leadOf(fromOffice);
    return lead ? [lead.key] : [];
  }
  if (want.includes('/')) {
    const [oid, aid] = want.split('/');
    if (/^lead$/i.test(aid)) {
      const lead = leadOf(oid);
      return lead ? [lead.key] : [];
    }
    const hit = all.find((r) => r.key.toLowerCase() === want.toLowerCase());
    return hit ? [hit.key] : [];
  }
  // A bare id means "someone in my office". Cross-office needs the full key, so
  // a typo bounces instead of quietly reaching a same-named agent elsewhere.
  const hit = all.find((r) => r.office.id === fromOffice && r.agent.id.toLowerCase() === want.toLowerCase());
  return hit ? [hit.key] : [];
}

// ---- delivery --------------------------------------------------------------

/** Atomic write into a recipient's inbox. `false` means the mailbox is not there. */
function deliver(msg, toKey) {
  const inbox = path.join(agentDir(toKey), 'inbox');
  if (!fs.existsSync(inbox)) return false;
  atomicWriteJson(path.join(inbox, `${msg.id}.json`), { ...msg, to: toKey });
  return true;
}

/**
 * Route one normalized message. Returns the keys it actually reached.
 *
 * A bounce is itself a message, sent with `act: 'inform'` so it is terminal and
 * cannot start a bounce-of-a-bounce.
 */
function routeMessage(msg) {
  if (msg.hops >= HOP_CAP) {
    logEvent({ kind: 'drop', reason: 'hop-cap', id: msg.id, from: msg.from, to: msg.to, hops: msg.hops });
    bounce(msg, `Dropped: this thread hit the ${HOP_CAP}-hop cap. Summarise where it got to and stop replying, or raise it with your lead.`);
    return [];
  }
  const targets = resolveTo(msg.to, msg.from);
  if (!targets.length) {
    logEvent({ kind: 'drop', reason: 'unknown-recipient', id: msg.id, from: msg.from, to: msg.to });
    bounce(msg, `Undeliverable: "${msg.to}" is not an agent on the floor. Use <agent-id> for your own office, <office>/<agent-id> across offices, "lead", or "floor".`);
    return [];
  }
  const delivered = [];
  for (const key of targets) {
    if (deliver(msg, key)) delivered.push(key);
  }
  if (!delivered.length) {
    logEvent({ kind: 'drop', reason: 'no-mailbox', id: msg.id, from: msg.from, to: msg.to });
    bounce(msg, `Undeliverable: "${msg.to}" has no mailbox yet (its terminal has never started).`);
    return [];
  }
  logEvent({
    kind: 'message',
    id: msg.id,
    conversation: msg.conversation,
    from: msg.from,
    to: delivered,
    act: msg.act,
    subject: msg.subject,
    hops: msg.hops,
  });
  return delivered;
}

/** Tell a sender its message did not go anywhere. Terminal act, by design. */
function bounce(original, reason) {
  const inbox = path.join(agentDir(original.from), 'inbox');
  if (!fs.existsSync(inbox)) return;
  const note = {
    ...normalize(
      {
        to: original.from,
        act: 'inform',
        subject: `Undelivered: ${original.subject}`,
        body: `${reason}\n\nOriginal message id ${original.id}, addressed to "${original.to}".`,
        conversation: original.conversation,
        in_reply_to: original.id,
      },
      'floor/router',
    ),
    from: 'floor/router',
  };
  atomicWriteJson(path.join(inbox, `${note.id}.json`), note);
}

/**
 * Send a message the floor itself originated — a circuit-breaker steer, a human's
 * answer coming back, a task dispatch from the UI. Bypasses the outbox because
 * there is no agent whose outbox it would belong in.
 */
function sendSystem(toKey, partial) {
  const msg = { ...normalize(partial, partial.from || 'floor/router'), from: partial.from || 'floor/router' };
  const ok = deliver(msg, toKey);
  if (ok) {
    logEvent({ kind: 'message', id: msg.id, from: msg.from, to: [toKey], act: msg.act, subject: msg.subject, system: true });
  }
  return ok ? msg : null;
}

// ---- the sweep -------------------------------------------------------------

/**
 * Drain every outbox on the floor. Safe to call on a timer forever.
 *
 * A message file is moved into `outbox/.sent/` whether or not it was deliverable,
 * so a message the router could not place is never re-routed on the next sweep.
 * Unparseable files are moved aside too, for the same reason.
 */
function drainOutboxes() {
  let routed = 0;
  let dirs = [];
  try {
    dirs = fs.readdirSync(AGENTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return 0;
  }
  for (const dir of dirs) {
    const fromKey = sessionKey(dir);
    const outbox = path.join(AGENTS_DIR, dir, 'outbox');
    let files = [];
    try {
      files = fs.readdirSync(outbox).filter((f) => f.endsWith('.json')).sort();
    } catch {
      continue;
    }
    for (const file of files) {
      const full = path.join(outbox, file);
      const sent = path.join(outbox, '.sent', `${Date.now()}-${file}`);
      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(full, 'utf8'));
      } catch {
        logEvent({ kind: 'drop', reason: 'unparseable', from: fromKey, file });
        try {
          fs.mkdirSync(path.dirname(sent), { recursive: true });
          fs.renameSync(full, sent);
        } catch {}
        continue;
      }
      try {
        routeMessage(normalize(raw, fromKey));
        routed += 1;
      } catch (err) {
        logEvent({ kind: 'drop', reason: `router-error: ${err.message}`, from: fromKey, file });
      }
      try {
        fs.mkdirSync(path.dirname(sent), { recursive: true });
        fs.renameSync(full, sent);
      } catch {}
    }
  }
  return routed;
}

// ---- reading an inbox ------------------------------------------------------

/** Unread messages for an agent — everything still sitting in `inbox/`. */
function pendingInbox(key) {
  const inbox = path.join(agentDir(key), 'inbox');
  let files = [];
  try {
    files = fs.readdirSync(inbox).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    const msg = readJson(path.join(inbox, file), null);
    if (msg) out.push(msg);
  }
  return out;
}

const readCursors = () => readJson(CURSOR_FILE, {});

/**
 * Record that an agent has already been woken about these message ids.
 *
 * The ids are bookkeeping, not a work list: the inbox directory is authoritative.
 * This only stops us nudging twice about the same mail.
 */
function markNudged(key, ids) {
  const cursors = readCursors();
  const prev = cursors[key] || { nudged: [], lastNudgeAt: null };
  // Keep the tail bounded; an id that old is long since in .done/.
  const merged = [...new Set([...(prev.nudged || []), ...ids])].slice(-200);
  cursors[key] = { nudged: merged, lastNudgeAt: new Date().toISOString(), lastProcessed: ids[ids.length - 1] || prev.lastProcessed || null };
  atomicWriteJson(CURSOR_FILE, cursors);
}

/** Mail this agent has not been woken about yet. */
function unnudged(key) {
  const told = new Set((readCursors()[key] || {}).nudged || []);
  return pendingInbox(key).filter((m) => !told.has(m.id));
}

// ---- PROTOCOL.md -----------------------------------------------------------

/**
 * The agent-facing contract, written at boot and overwritten every boot so it
 * always matches the live roster. Agents are pointed at it from their system
 * prompt; it is the long form of the six lines they get injected.
 */
function writeProtocol() {
  const all = roster();
  const byOffice = new Map();
  for (const r of all) {
    if (!byOffice.has(r.office.id)) byOffice.set(r.office.id, { office: r.office, agents: [] });
    byOffice.get(r.office.id).agents.push(r);
  }
  const rosterMd = [...byOffice.values()]
    .map(({ office, agents }) => {
      const rows = agents
        .map((r) => `| \`${r.key}\` | ${r.agent.name || r.agent.id} | ${r.lead ? '**lead**' : r.agent.role || 'agent'} |`)
        .join('\n');
      return `### ${office.name || office.id} — \`${office.id}\`\n\nProject: \`${office.cwd || '(not set)'}\`\n\n| Address | Name | Role |\n| --- | --- | --- |\n${rows}`;
    })
    .join('\n\n');

  atomicWrite(
    PROTOCOL_FILE,
    `# Floor protocol

You are one of several Claude agents sharing this floor. Coordination is entirely
file-based, and the harness — the server that started your terminal — is the only
thing that moves messages between agents.

_Generated at boot from the live floor. Do not edit; your changes will be overwritten._

## Your workspace — \`data/floor/agents/<office>__<agent>/\`

| Path | What it is |
| --- | --- |
| \`memory.md\` | your long-term memory. Read it at the start of a task; append to it as you learn. **Yours alone.** |
| \`inbox/\` | messages addressed to you. Read every file at the start of a task. |
| \`inbox/.done/\` | move a message here once you have handled it. |
| \`outbox/\` | drop messages here to send them. The router delivers them, then moves them to \`.sent/\`. |

**Never write into another agent's folder.** Write to your own \`outbox/\`; the
router does the delivering. That is what keeps every file single-writer.

## Sending a message

Write ONE JSON file into \`outbox/\` (any filename ending in \`.json\`):

\`\`\`json
{
  "to": "<agent-id> | <office>/<agent-id> | lead | floor | human",
  "act": "request | inform | propose | query | agree | refuse | done",
  "subject": "one-line summary",
  "body": "the details",
  "conversation": "carry this across a thread (optional)",
  "in_reply_to": "<message id you are replying to> (optional)"
}
\`\`\`

The router fills in \`id\`, \`from\`, \`hops\`, and the timestamps. Anything you put
in those fields is ignored.

### Addressing

- \`<agent-id>\` — someone in your own office.
- \`<office>/<agent-id>\` — someone in another office. A bare id never reaches
  another office, so a typo bounces rather than quietly hitting a same-named agent.
- \`lead\` / \`<office>/lead\` — that office's lead.
- \`floor\` — broadcast to every office lead.
- \`human\` — goes to your lead, who is the human's proxy on the floor.

## Rules of the road

- Only \`request\`, \`query\` and \`propose\` expect a reply. **\`inform\` and \`done\`
  are terminal** — do not reply to them, or two agents will loop forever.
- Every reply increments \`hops\`. Past ${HOP_CAP} the message is dropped and you are
  told once. If you see that bounce, summarise where the thread got to and stop.
- An undeliverable message bounces back into your inbox as an \`inform\`. Read it —
  it means your instruction never arrived.
- Re-reading a message already in \`.done/\` is a no-op. Do not reprocess it.
- For anything ambiguous, cross-cutting, or needing sign-off, message \`lead\`.
- Your office memory file is still the office's shared narrative. Put in it what
  the whole office needs; put in \`memory.md\` what only you need; put in floor
  memory only what other OFFICES need.

## The work — \`tasks.json\`

\`data/floor/tasks.json\` is the structured ledger (a kanban: \`todo\` / \`doing\` /
\`blocked\` / \`done\`, with title, assignee, priority, deps). Keep the card you are
working on reflected in its status. Two rules:

- **\`assignee\` is set the moment a card is dispatched and is never cleared** — a
  done card must still say who did the work.
- A card that can only move with the human goes to \`"status": "blocked"\` with the
  ask appended to its \`humanQA\` array as \`{ "q": "...", "askedAt": "<iso>" }\`.
  The floor UI shows the open ask and the human's reply lands in the same entry
  as \`"a"\`, plus a message in the lead's inbox.

**Write the ask short, and in markdown.** The card renders it, so:

- open with ONE **bold** sentence saying exactly what you need;
- \`backticks\` for paths, commands, values, identifiers;
- \`-\` bullets or \`1.\` numbering for every option;
- roughly 700 characters, maximum. An ask longer than a short paragraph plus its
  options is a report, not a question — cut the narrative and keep the decision.

Never sit idle waiting for a reply. Move on to other work and pick the answer up
when it arrives.

## Guardrails

A circuit breaker watches every agent for runaway behaviour — the same tool
repeating, error storms, overspending — and escalates \`steer\` → \`constrain\` →
\`stop\`. If a \`Circuit breaker\` message lands in your inbox, **you are the problem
it caught**: stop repeating, summarise what you have tried, and do what the message
says. At \`constrain\` you go read-only and get your lead's sign-off before any
further tool calls.

Be token-frugal. Prefer references (file paths, message ids, card ids) over pasted
content, and \`/compact\` your own session when context gets heavy.

## The floor right now

${rosterMd || '_No offices configured yet._'}
`,
  );
}

module.exports = {
  HOP_CAP,
  ACTS,
  roster,
  leadOf,
  ensureAgentDirs,
  normalize,
  resolveTo,
  deliver,
  routeMessage,
  sendSystem,
  drainOutboxes,
  pendingInbox,
  unnudged,
  markNudged,
  writeProtocol,
};
