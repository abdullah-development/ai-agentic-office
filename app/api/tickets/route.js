/*
 * The tracker backlog the poller last fetched, for the right rail.
 *
 * GET /api/tickets            -> every office that has a tracker
 * GET /api/tickets?office=hq  -> just that one
 *
 * This only reads what `server.js` already pulled; it never calls a tracker, so
 * the UI polling it can never hammer Plane/Jira/Linear.
 */
import { readState } from '../../../lib/skills.js';
import { readTickets } from '../../../lib/tickets.js';
import { hasTracker } from '../../../lib/trackers/index.js';

export async function GET(req) {
  const want = new URL(req.url).searchParams.get('office');
  const offices = (readState().offices || []).filter((o) => (want ? o.id === want : true));

  const out = offices.map((o) => {
    const stored = readTickets(o.id);
    return {
      office: o.id,
      officeName: o.name,
      tracker: hasTracker(o) ? o.tracker.provider : null,
      configured: hasTracker(o),
      fetchedAt: stored.fetchedAt,
      error: stored.error,
      tickets: stored.tickets,
      todo: stored.tickets.filter((t) => t.todo).length,
    };
  });

  return Response.json({
    offices: out,
    todo: out.reduce((n, o) => n + o.todo, 0),
  });
}
