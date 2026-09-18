/*
 * The floor's read model, and the few writes the human makes from the UI.
 *
 * Everything here goes through `data/floor/` on disk rather than through the PTY
 * server's memory. That is deliberate: a Next route handler gets its own module
 * instance, so an in-memory telemetry map in `server.js` is simply not visible
 * from here. The server writes `fleet.json` on a timer for exactly this reason,
 * and agents read the same file to see their own floor.
 *
 * The one thing that cannot work this way is clearing a circuit breaker, whose
 * counters live in the server process — that is `/api/floor/reset-breaker`,
 * served directly by `server.js`.
 */
import { readJson, readLog, FLEET_FILE } from '../../../lib/floor.js';
import { readTasks, upsertTask, addAsk, answerAsk, openAsks } from '../../../lib/ledger.js';
import { sendSystem, pendingInbox, roster, leadOf } from '../../../lib/mailbox.js';

export async function GET(request) {
  const url = new URL(request.url);
  const agent = url.searchParams.get('agent');

  // One agent's mailbox, for the drawer.
  if (agent) {
    return Response.json({ agent, inbox: pendingInbox(agent) });
  }

  const fleet = readJson(FLEET_FILE, { ts: null, agents: [] });
  const tasks = readTasks();
  return Response.json({
    fleet,
    tasks,
    asks: openAsks(),
    // Newest first: the feed is append-only, so the tail is the interesting end.
    log: readLog(120).reverse(),
    counts: {
      agents: fleet.agents.length,
      backlog: fleet.agents.reduce((n, a) => n + (a.inboxBacklog || 0), 0),
      tripped: fleet.agents.filter((a) => a.breaker && a.breaker !== 'healthy').length,
      todo: tasks.filter((t) => t.status === 'todo').length,
      doing: tasks.filter((t) => t.status === 'doing').length,
      blocked: tasks.filter((t) => t.status === 'blocked').length,
      done: tasks.filter((t) => t.status === 'done').length,
    },
  });
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'bad json' }, { status: 400 });
  }

  switch (body.action) {
    /**
     * The human answers an ASK ME card. The answer lands in the same `humanQA`
     * entry as the question AND as a message in the asker's inbox — the card is
     * the record, the message is what actually reaches the agent.
     */
    case 'answer': {
      const result = answerAsk(body.id, body.answer);
      if (!result) return Response.json({ error: 'no open ask on that card' }, { status: 404 });
      // An ask written straight into tasks.json by an agent often carries no
      // `askedBy`, and an unassigned card carries no assignee either — so without
      // the last fallback the answer lands on the card and reaches nobody, which
      // is the one outcome that makes the whole ASK ME loop pointless. The office
      // lead is the right default: it is the human's proxy on the floor.
      const to = result.entry.askedBy || result.task.assignee || leadOf(result.task.office)?.key || null;
      if (to) {
        sendSystem(to, {
          to,
          from: 'floor/human',
          act: 'inform', // terminal: an answer is not an invitation to a thread
          subject: `Answer: ${result.task.title}`,
          body: `The human answered your ask on card \`${result.task.id}\`.\n\nQ: ${result.entry.q}\n\nA: ${result.entry.a}\n\nThe card is back to "todo" — carry on.`,
        });
      }
      return Response.json({ ok: true, task: result.task, notified: to || null });
    }

    case 'ask': {
      const t = addAsk(body.id, body.q, body.by);
      return t ? Response.json({ ok: true, task: t }) : Response.json({ error: 'no such card' }, { status: 404 });
    }

    case 'task':
      return Response.json({ ok: true, task: upsertTask(body.task || body) });

    /** The human sending a message onto the floor from the UI. */
    case 'message': {
      const to = String(body.to || '');
      if (!roster().some((r) => r.key === to)) {
        return Response.json({ error: `"${to}" is not an agent on the floor` }, { status: 400 });
      }
      const msg = sendSystem(to, {
        to,
        from: 'floor/human',
        act: body.act || 'request',
        subject: body.subject || '(from the human)',
        body: body.body || '',
      });
      return msg ? Response.json({ ok: true, id: msg.id }) : Response.json({ error: 'undeliverable' }, { status: 400 });
    }

    default:
      return Response.json({ error: `unknown action "${body.action}"` }, { status: 400 });
  }
}
