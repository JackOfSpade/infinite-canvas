/**
 * Merge per-source scrape progress events into a UI progress state.
 *
 * Terminal completion events can omit fields carried by earlier progress
 * events, so warning/url (and the per-source count) stay sticky until an event
 * explicitly clears them. Keeping `count` sticky matches its siblings below and
 * prevents a status-only update from blanking a card that already showed "N jobs".
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
