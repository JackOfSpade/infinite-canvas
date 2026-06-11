// Renderer-side FIFO for listing-status actions.
//
// The main process also serializes each individual listing-status request,
// which protects the shared browser across windows and per-card Check clicks.
// This queue adds the renderer UX guarantee: a whole "Check All" batch and
// individual "Check" clicks from this window run in FIFO order without
// interleaving.

let tail = Promise.resolve();
let pending = 0;
const pendingKeys = new Set();

/**
 * Enqueue one listing-status action.
 *
 * A key remains active while its action is queued or running, so a rapid
 * double-click on the same card/hub cannot enqueue duplicate work before React
 * has repainted the disabled button.
 *
 * @param {string} key stable card or hub identity
 * @param {() => Promise<unknown> | unknown} fn action body
 * @returns {{enqueued: boolean, queuedBehind: number, promise: Promise<unknown>}}
 */
export function enqueueStatusCheckAction(key, fn) {
  if (typeof fn !== 'function') throw new TypeError('Status-check action must be a function');

  const normalizedKey = String(key || '').trim();
  if (normalizedKey && pendingKeys.has(normalizedKey)) {
    return {
      enqueued: false,
      queuedBehind: pending,
      promise: Promise.resolve({ deduped: true }),
    };
  }

  const queuedBehind = pending;
  pending++;
  if (normalizedKey) pendingKeys.add(normalizedKey);

  const result = tail.then(() => fn());
  // Advance regardless of outcome so one failed action cannot wedge later
  // Check / Check All buttons.
  tail = result.then(() => {}, () => {});

  const settle = () => {
    pending--;
    if (normalizedKey) pendingKeys.delete(normalizedKey);
  };
  result.then(settle, settle);

  return { enqueued: true, queuedBehind, promise: result };
}

export function getStatusCheckActionQueueDepth() {
  return pending;
}
