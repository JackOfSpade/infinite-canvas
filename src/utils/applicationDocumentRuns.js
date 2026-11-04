/**
 * Which document each card is setting up right now, outside React.
 *
 * A card's run outlives its component: hiding a board unmounts the card while
 * its official-posting lookup and queue wait keep going. Held in component state,
 * a remounted card would forget the run and offer the same button again.
 */
const running = new Map();
const waiting = new Set();
const listeners = new Set();
const notify = () => { for (const listener of listeners) listener(); };

export function getRunningApplicationDocument(nodeId) {
  return running.get(nodeId) || null;
}

/**
 * Take this card's one setup slot, or report that it is taken. A click must call
 * this before its first await: rendered state and the canvas both update too late
 * to stop a second click in the same tick. The caller releases it on every exit.
 */
export function claimRunningApplicationDocument(nodeId, kind) {
  if (running.has(nodeId)) return false;
  running.set(nodeId, kind);
  notify();
  return true;
}

export function clearRunningApplicationDocument(nodeId) {
  if (running.delete(nodeId)) notify();
}

export function subscribeApplicationDocumentRuns(listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** One waiter per card, so a remounted card does not start a second one. */
export function claimApplicationDocumentWaiter(nodeId) {
  if (waiting.has(nodeId)) return false;
  waiting.add(nodeId);
  return true;
}

export function releaseApplicationDocumentWaiter(nodeId) {
  waiting.delete(nodeId);
}
