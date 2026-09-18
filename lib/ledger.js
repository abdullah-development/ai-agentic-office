/*
 * The task ledger — `data/floor/tasks.json`.
 *
 * The office memory files stay what they have always been: the office's narrative,
 * with its `[TASK]` / `[DONE]` prose still readable and still parsed by
 * `/api/tasks`. This is the *structured* view that sits beside it — a kanban the
 * UI can render and the server can reason about without regex.
 *
 * Two rules come straight from upstream and read like scar tissue (HIVE-SPEC §3.8):
 *
 *   - `assignee` is set the moment a card is dispatched and is NEVER cleared on a
 *     status change. A done card must still say who did the work.
 *   - A `humanQA` ask is short and in markdown. Every past ask stays on the card;
 *     that trail is the decision history, and deleting it loses the only record of
 *     why the work went the way it did.
 *
 * Single writer: the server. Agents propose changes through their lead or by
 * editing their own card's status — the file is small and rewritten whole, so it
 * is written atomically like everything else on the floor.
 */
const { TASKS_FILE, readJson, atomicWriteJson, logEvent } = require('./floor.js');

const STATUSES = ['todo', 'doing', 'blocked', 'done'];
const PRIORITIES = ['urgent', 'high', 'medium', 'low'];

const slugId = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

function readTasks() {
  const d = readJson(TASKS_FILE, { tasks: [] });
  return Array.isArray(d.tasks) ? d.tasks : [];
}

function writeTasks(tasks) {
  atomicWriteJson(TASKS_FILE, { tasks });
  return tasks;
}

/**
 * Create or update a card. Only the fields actually passed are touched, so a
 * status change cannot blank an assignee by omission.
 */
function upsertTask(patch) {
  const tasks = readTasks();
  const id = patch.id || `task-${slugId(patch.title) || Date.now().toString(36)}`;
  const now = new Date().toISOString();
  const i = tasks.findIndex((t) => t.id === id);
  const prev = i === -1 ? null : tasks[i];

  const next = {
    id,
    office: patch.office ?? prev?.office ?? null,
    title: patch.title ?? prev?.title ?? '(untitled)',
    status: STATUSES.includes(patch.status) ? patch.status : prev?.status ?? 'todo',
    // Never cleared by an update that simply does not mention it.
    assignee: patch.assignee ?? prev?.assignee ?? null,
    priority: PRIORITIES.includes(patch.priority) ? patch.priority : prev?.priority ?? 'medium',
    deps: patch.deps ?? prev?.deps ?? [],
    ticket: patch.ticket ?? prev?.ticket ?? null,
    url: patch.url ?? prev?.url ?? null,
    notes: patch.notes ?? prev?.notes ?? '',
    humanQA: prev?.humanQA ?? [],
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };
  if (i === -1) tasks.push(next);
  else tasks[i] = next;
  writeTasks(tasks);
  logEvent({ kind: 'task', id, status: next.status, assignee: next.assignee, new: i === -1 });
  return next;
}

/**
 * Raise an ASK ME on a card: the card blocks and the question goes on its
 * `humanQA` trail. Returns null if the card is gone.
 */
function addAsk(id, question, askedBy) {
  const tasks = readTasks();
  const t = tasks.find((x) => x.id === id);
  if (!t) return null;
  t.humanQA = [...(t.humanQA || []), { q: String(question || '').slice(0, 4000), askedBy: askedBy || null, askedAt: new Date().toISOString() }];
  t.status = 'blocked';
  t.updatedAt = new Date().toISOString();
  writeTasks(tasks);
  logEvent({ kind: 'ask', id, askedBy });
  return t;
}

/**
 * Answer the newest unanswered ask on a card and unblock it.
 *
 * The answer lands in the SAME entry as the question — a separate answers array
 * would let a reply drift away from what it was replying to.
 */
function answerAsk(id, answer) {
  const tasks = readTasks();
  const t = tasks.find((x) => x.id === id);
  if (!t) return null;
  const open = [...(t.humanQA || [])].reverse().find((e) => !e.a);
  if (!open) return null;
  open.a = String(answer || '');
  open.answeredAt = new Date().toISOString();
  if (t.status === 'blocked') t.status = 'todo';
  t.updatedAt = new Date().toISOString();
  writeTasks(tasks);
  logEvent({ kind: 'answer', id });
  return { task: t, entry: open };
}

/**
 * Every card with a question the human has not answered yet.
 *
 * Normalised on the way out. Agents write `tasks.json` themselves — the protocol
 * tells them to keep their card's status current — so a `humanQA` entry that never
 * went through `addAsk` above can be missing `askedBy` or `askedAt` entirely.
 * Filling them here means no consumer has to guess: `askedBy` falls back to the
 * card's assignee, which is who the answer needs to reach.
 */
function openAsks() {
  const out = [];
  for (const t of readTasks()) {
    for (const e of t.humanQA || []) {
      if (e.a) continue;
      out.push({
        taskId: t.id,
        office: t.office,
        title: t.title,
        assignee: t.assignee,
        ...e,
        q: String(e.q || ''),
        askedBy: e.askedBy || t.assignee || null,
        askedAt: e.askedAt || t.updatedAt || t.createdAt || '',
      });
    }
  }
  return out.sort((a, b) => String(b.askedAt).localeCompare(String(a.askedAt)));
}

/**
 * A tracker ticket becomes a card. Idempotent on the ticket key, and it never
 * overwrites a status or an assignee the office has already set — re-polling the
 * tracker must not drag a card back to `todo` after the lead moved it.
 */
function taskFromTicket(office, ticket) {
  const id = `task-${slugId(ticket.key)}`;
  const existing = readTasks().find((t) => t.id === id);
  if (existing) return existing;
  return upsertTask({
    id,
    office,
    title: `${ticket.key} ${ticket.title}`,
    ticket: ticket.key,
    url: ticket.url || null,
    priority: PRIORITIES.includes(ticket.priority) ? ticket.priority : 'medium',
    status: 'todo',
    notes: `From ${ticket.provider || 'tracker'} — ${ticket.state || ''}`.trim(),
  });
}

module.exports = {
  STATUSES,
  PRIORITIES,
  readTasks,
  writeTasks,
  upsertTask,
  addAsk,
  answerAsk,
  openAsks,
  taskFromTicket,
};
