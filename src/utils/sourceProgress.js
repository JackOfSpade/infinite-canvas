/**
 * Merge per-source scrape progress events into a UI progress state.
 *
 * Terminal completion events can omit fields carried by earlier progress
 * events, so warning/url stay sticky until an event explicitly clears them.
 */
export function mergeSourceProgress(prev, payload) {
  return {
    status:  payload.status,
    count:   payload.count,
    detail:  payload.detail ?? null,
    warning: payload.warning !== undefined ? payload.warning : prev?.warning ?? null,
    url:     payload.url     !== undefined ? payload.url     : prev?.url     ?? null,
  };
}
