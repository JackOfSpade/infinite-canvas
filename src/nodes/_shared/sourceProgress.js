/**
 * Source-card progress merge helper.
 *
 * Comp source cards (marketplace pricing) and job source cards (job search)
 * both subscribe to per-source progress events from the backend. The events
 * arrive in two phases for each source: an initial `searching` ping, then a
 * terminal completion event. The terminal event may omit `warning` or `url`
 * even when an earlier event carried them — preserve those across events so
 * the card UI keeps showing the failure reason and Solve target.
 */

/**
 * @param {object|null} prev    — previous progress state ({ status, count, warning, url } | null)
 * @param {object}      payload — incoming event payload
 * @returns merged progress state
 */
export function mergeSourceProgress(prev, payload) {
  return {
    status: payload.status,
    count:  payload.count,
    warning: payload.warning !== undefined ? payload.warning : prev?.warning ?? null,
    url:     payload.url     !== undefined ? payload.url     : prev?.url     ?? null,
  };
}
