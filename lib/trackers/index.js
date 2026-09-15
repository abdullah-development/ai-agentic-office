/*
 * Tracker registry: one office = one project = one tracker board.
 *
 * Every provider exports `fetchTickets(tracker)` and resolves to
 * `{ tickets, error? }` with tickets already normalised, so the poller, the API
 * routes and the agent skills are provider-agnostic. Plane is implemented;
 * Jira and Linear declare the same contract and say so until they are built.
 */
const plane = require('./plane.js');

const NOT_BUILT = (name, envHint) => ({
  fetchTickets: async () => ({
    tickets: [],
    error: `the ${name} provider is not implemented yet (set up ${envHint} and ask for it)`,
  }),
});

const PROVIDERS = {
  plane,
  jira: NOT_BUILT('Jira', 'JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN'),
  linear: NOT_BUILT('Linear', 'LINEAR_API_KEY'),
};

const PROVIDER_IDS = Object.keys(PROVIDERS);

/** Is this office wired to a tracker at all? */
function hasTracker(office) {
  const t = office?.tracker;
  return Boolean(t && t.provider && PROVIDERS[t.provider] && t.enabled !== false);
}

/**
 * Read one office's board. Never throws — a tracker that is down must not take
 * the floor down with it, so failures come back as `{ tickets: [], error }`.
 */
async function fetchOfficeTickets(office) {
  if (!hasTracker(office)) return { tickets: [], error: null, provider: null };
  const { provider } = office.tracker;
  try {
    const res = await PROVIDERS[provider].fetchTickets(office.tracker);
    return { provider, tickets: res.tickets || [], error: res.error || null };
  } catch (err) {
    return { provider, tickets: [], error: err.message || String(err) };
  }
}

module.exports = { PROVIDERS, PROVIDER_IDS, hasTracker, fetchOfficeTickets };
