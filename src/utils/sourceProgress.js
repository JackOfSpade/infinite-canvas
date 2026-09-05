/**
 * Merge per-source scrape progress events into a UI progress state.
 *
 * Terminal completion events can omit fields carried by earlier progress
 * events, so warning/url (and the per-source count) stay sticky until an event
 * explicitly clears them. Keeping `count` sticky matches its siblings below and
 * prevents a status-only update from blanking a card that already showed "N jobs".
 *
 * `status` is assigned UNCONDITIONALLY, and that is deliberate: there is no
 * "never go back from terminal" rule here, because re-entering 'searching'
 * after a terminal event on the SAME sourceId and the same card is real,
 * shipping behaviour —
 *   - electron/ipc/jobs.js (mid-run LinkedIn description enrichment, whose own
 *     comment says the re-entry is what cancels the card's dismiss timer),
 *   - electron/ipc/jobs.js (the LinkedIn Solve re-fetch),
 *   - electron/ipc/marketplace.js (scrapeOneSource, the post-Solve comp rescrape),
 *   - electron/ipc/compProgressAggregator.js (cumulative mid-bundle beat).
 * Adding a regression guard here would re-introduce the disappearing-card bug
 * those re-entries exist to prevent. The one case where a genuinely STALE beat
 * could arrive after a result is already fenced at its source, by
 * `terminalManualSourceIds` in electron/ipc/jobs.js — fence it there, not here.
 */
export function mergeSourceProgress(prev, payload) {
  return {
    status:  payload.status,
    count:   payload.count !== undefined ? payload.count : prev?.count ?? null,
    detail:  payload.detail ?? null,
    warning: payload.warning !== undefined ? payload.warning : prev?.warning ?? null,
    url:     payload.url     !== undefined ? payload.url     : prev?.url     ?? null,
    completed: payload.completed !== undefined ? payload.completed : prev?.completed ?? null,
    total:     payload.total     !== undefined ? payload.total     : prev?.total     ?? null,
  };
}

// Statuses that represent a settled outcome for a source. Shared so a consumer
// deciding "has the backend spoken?" cannot drift from this module's contract;
// one private copy still exists (SellHubNode's TERMINAL_COMP_STATUSES).
export const TERMINAL_SOURCE_STATUSES = new Set(['done', 'error', 'skipped']);

export function isTerminalSourceStatus(status) {
  return TERMINAL_SOURCE_STATUSES.has(status);
}
