/*
 * Plane tracker provider.
 *
 * Reads an office's backlog from Plane and normalises it to the shape every
 * provider returns, so the poller, the UI and the agent skills never have to
 * know which tracker an office is on.
 *
 * Auth: PLANE_API_KEY (workspace API key, sent as `x-api-key`).
 * Host: PLANE_BASE_URL, default https://api.plane.so — override for self-hosted.
 */

const DEFAULT_BASE = 'https://api.plane.so';
// Plane groups every state into one of these; the first two are the backlog an
// office's lead is allowed to pull from.
const TODO_GROUPS = new Set(['backlog', 'unstarted']);

const trim = (s) => String(s || '').replace(/\/+$/, '');

function planeConfig() {
  return {
    key: process.env.PLANE_API_KEY || '',
    base: trim(process.env.PLANE_BASE_URL || DEFAULT_BASE),
    // app.plane.so for cloud; self-hosted installs serve the UI from their own host
    app: trim(process.env.PLANE_APP_URL || 'https://app.plane.so'),
  };
}

async function planeGet(pathname, { key, base }) {
  const res = await fetch(`${base}${pathname}`, {
    headers: { 'x-api-key': key, accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Surface the status, never the key.
    throw new Error(`plane ${res.status} on ${pathname}${body ? `: ${body.slice(0, 180)}` : ''}`);
  }
  return res.json();
}

// Plane paginates with a cursor; a backlog can exceed one page.
async function planeList(pathname, cfg, cap = 500) {
  const out = [];
  let url = pathname;
  for (let page = 0; page < 10 && url; page++) {
    const data = await planeGet(url, cfg);
    const results = Array.isArray(data) ? data : data.results || [];
    out.push(...results);
    if (out.length >= cap || !data.next_page_results || !data.next_cursor) break;
    const join = pathname.includes('?') ? '&' : '?';
    url = `${pathname}${join}cursor=${encodeURIComponent(data.next_cursor)}`;
  }
  return out.slice(0, cap);
}

// Plane stores descriptions as HTML; agents want prose.
function plainText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const PRIORITY = { urgent: 'urgent', high: 'high', medium: 'medium', low: 'low', none: 'none' };

/**
 * @param {{workspace: string, project: string}} tracker  the office's tracker config
 * @returns {Promise<{tickets: Array, error?: string}>}
 */
async function fetchTickets(tracker) {
  const cfg = planeConfig();
  if (!cfg.key) return { tickets: [], error: 'PLANE_API_KEY is not set (add it to .env.local)' };
  const ws = String(tracker.workspace || '').trim();
  const pid = String(tracker.project || '').trim();
  if (!ws || !pid) return { tickets: [], error: 'office needs a Plane workspace slug and project id' };

  const root = `/api/v1/workspaces/${encodeURIComponent(ws)}/projects/${encodeURIComponent(pid)}`;

  // States carry the group (backlog/started/completed/…); issues only carry a state id.
  const [project, states, members, issues] = await Promise.all([
    planeGet(`${root}/`, cfg).catch(() => null),
    planeList(`${root}/states/`, cfg, 100),
    planeList(`${root}/members/`, cfg, 200).catch(() => []),
    planeList(`${root}/issues/`, cfg, 300),
  ]);

  const stateById = new Map(states.map((s) => [s.id, s]));
  const memberById = new Map(
    members.map((m) => [m.member || m.id, m.member__display_name || m.display_name || m.email || '']),
  );
  const identifier = project?.identifier || '';

  const tickets = issues.map((it) => {
    const st = stateById.get(it.state);
    const group = st?.group || 'backlog';
    return {
      provider: 'plane',
      id: it.id,
      // "ROOM-42" reads better on a task board than a UUID
      key: identifier && it.sequence_id ? `${identifier}-${it.sequence_id}` : String(it.sequence_id || it.id),
      title: String(it.name || '').trim(),
      body: plainText(it.description_html).slice(0, 4000),
      url: `${cfg.app}/${ws}/projects/${pid}/issues/${it.id}`,
      state: st?.name || 'Backlog',
      stateGroup: group,
      todo: TODO_GROUPS.has(group),
      priority: PRIORITY[it.priority] || 'none',
      assignees: (it.assignees || []).map((a) => memberById.get(a) || a).filter(Boolean),
      updatedAt: it.updated_at || it.created_at || null,
    };
  });

  // Urgent first, then newest — the order a lead should triage in.
  const rank = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
  tickets.sort(
    (a, b) => (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9) || String(b.updatedAt).localeCompare(String(a.updatedAt)),
  );
  return { tickets };
}

module.exports = { fetchTickets, plainText, TODO_GROUPS };
