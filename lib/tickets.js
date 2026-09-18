/*
 * Ticket store: what the poller writes and the UI reads.
 *
 * `data/tickets/<officeId>.json` holds the last successful fetch per office.
 * Each poll diffs against it so we can tell what is genuinely new — that diff
 * is what gets written onto the office's memory board and what decides whether
 * the lead is worth interrupting.
 */
const fs = require('fs');
const path = require('path');

const TICKET_DIR = path.join(process.cwd(), 'data', 'tickets');
const MEMORY_DIR = path.join(process.cwd(), 'data', 'memory');

const safe = (s) => String(s || '').replace(/[^a-z0-9_-]/gi, '');

const ticketFile = (oid) => path.join(TICKET_DIR, `${safe(oid)}.json`);

function readTickets(oid) {
  try {
    const d = JSON.parse(fs.readFileSync(ticketFile(oid), 'utf8'));
    return { tickets: d.tickets || [], fetchedAt: d.fetchedAt || null, error: d.error || null, provider: d.provider || null };
  } catch {
    return { tickets: [], fetchedAt: null, error: null, provider: null };
  }
}

function writeTickets(oid, payload) {
  fs.mkdirSync(TICKET_DIR, { recursive: true });
  fs.writeFileSync(ticketFile(oid), JSON.stringify(payload, null, 2));
}

/**
 * Tickets that are in a todo state now and were not on the board before.
 * A ticket that merely moved between two todo states is not "new".
 */
function newTodo(previous, current) {
  const seen = new Set((previous || []).map((t) => t.key));
  return (current || []).filter((t) => t.todo && !seen.has(t.key));
}

// Already written onto the board? The poller must be safe to run forever.
function announcedKeys(oid) {
  const file = path.join(MEMORY_DIR, `${safe(oid)}.md`);
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return new Set();
  }
  const keys = new Set();
  for (const m of text.matchAll(/^\s*[-*]\s*\[TICKET\]\s+(\S+)/gim)) keys.add(m[1]);
  return keys;
}

/**
 * Append new tickets to the office's memory board as `[TICKET]` rows. That file
 * is the board the lead already reads, so this is all it takes for a tracker
 * item to become something the office can act on.
 *
 * @returns {Array} the tickets actually written (never announced twice)
 */
function announceTickets(oid, tickets) {
  const already = announcedKeys(oid);
  const fresh = (tickets || []).filter((t) => !already.has(t.key));
  if (!fresh.length) return [];

  const when = new Date().toISOString().slice(0, 10);
  const lines = fresh.map((t) => {
    const who = t.assignees?.length ? ` · assigned: ${t.assignees.join(', ')}` : '';
    const pri = t.priority && t.priority !== 'none' ? ` · ${t.priority}` : '';
    return `- [TICKET] ${t.key} ${t.title} — ${t.state}${pri}${who} — ${t.url}`;
  });

  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  const file = path.join(MEMORY_DIR, `${safe(oid)}.md`);
  const header = `\n## [tracker] ${when} — ${fresh.length} new ticket${fresh.length === 1 ? '' : 's'} from ${tickets[0]?.provider || 'tracker'}\n`;
  fs.appendFileSync(file, `${header}${lines.join('\n')}\n`);
  return fresh;
}

/**
 * Ticket keys the office has already been told about successfully. Persisted
 * alongside the board so a restart cannot lose a pending nudge.
 */
function nudgedKeys(oid) {
  try {
    return new Set(JSON.parse(fs.readFileSync(ticketFile(oid), 'utf8')).nudged || []);
  } catch {
    return new Set();
  }
}

function rememberNudged(oid, keys) {
  const current = readTickets(oid);
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(ticketFile(oid), 'utf8'));
  } catch {}
  const merged = new Set([...(raw.nudged || []), ...keys]);
  writeTickets(oid, { ...raw, ...current, nudged: [...merged] });
}

/** Ticket keys the lead has already turned into a [TASK] line. */
function assignedKeys(oid) {
  const file = path.join(MEMORY_DIR, `${safe(oid)}.md`);
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return new Set();
  }
  const keys = new Set();
  for (const m of text.matchAll(/^\s*[-*]\s*\[(?:TASK|BLOCKED|CANCELLED)\][^\n]*/gim)) {
    for (const k of m[0].matchAll(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g)) keys.add(k[0]);
  }
  return keys;
}

/**
 * What the lead still needs to hear about: todo tickets that are neither already
 * assigned nor already successfully nudged. Recomputed from disk every poll, so
 * a nudge deferred because the lead was busy is simply retried next time.
 */
function pendingForLead(oid, tickets) {
  const told = nudgedKeys(oid);
  const assigned = assignedKeys(oid);
  return (tickets || []).filter((t) => t.todo && !told.has(t.key) && !assigned.has(t.key));
}

module.exports = {
  TICKET_DIR,
  readTickets,
  writeTickets,
  newTodo,
  announceTickets,
  announcedKeys,
  nudgedKeys,
  rememberNudged,
  assignedKeys,
  pendingForLead,
};
