// What each running module wants the side panel to say. Nodes publish here and
// show only that they are processing; the panel owns the status and Pause & save.
const entries = new Map();
const listeners = new Set();
let snapshot = Object.freeze([]);

const pausable = entry => Boolean(entry?.onPause || entry?.pauseWithoutSave);

const statusKey = entry => JSON.stringify([
  entry.label, entry.headline, entry.lines, entry.pauseKeys, entry.pauseDisabledReason,
  entry.claudeRequestId, entry.pauseWithoutSave,
]);

function publishSnapshot() {
  snapshot = Object.freeze([...entries.values()]);
  for (const listener of [...listeners]) { try { listener(); } catch { /* one subscriber cannot stop the rest */ } }
}

export function publishJobRunStatus(nodeId, entry) {
  const next = {
    nodeId, label: entry.label || 'Job Search', headline: entry.headline || 'Processing',
    lines: (entry.lines || []).filter(Boolean), pauseKeys: entry.pauseKeys || [], onPause: entry.onPause || null,
    pauseDisabledReason: entry.pauseDisabledReason || '',
    // A live Claude request the panel draws with the full worker activity card.
    claudeRequestId: entry.claudeRequestId || null,
    // The run pauses in place with no save step, so the card still holds a button.
    pauseWithoutSave: entry.pauseWithoutSave === true,
  };
  const previous = entries.get(nodeId);
  entries.set(nodeId, next);
  // A new handler alone changes nothing on screen, so it does not re-render.
  if (!previous || statusKey(previous) !== statusKey(next) || Boolean(previous.onPause) !== Boolean(next.onPause)) publishSnapshot();
  else snapshot = Object.freeze([...entries.values()]);
}

export function clearJobRunStatus(nodeId) {
  if (entries.delete(nodeId)) publishSnapshot();
}

export const getJobRunStatuses = () => snapshot;
export const getJobRunStatus = nodeId => entries.get(nodeId) || null;

/** Whose Pause & save covers this module: a Board running it, otherwise the module itself. */
export function pauseOwnerStatus(nodeId, statuses = snapshot) {
  const key = `node:${nodeId}`;
  return statuses.find(entry => entry.nodeId !== nodeId && pausable(entry) && entry.pauseKeys.includes(key))
    || statuses.find(entry => entry.nodeId === nodeId)
    || null;
}

/** One button per pausable run. The handoff row holds its owner's button, so that card shows none. */
export function showsOwnPauseButton(entry, handoffNodeId = null, statuses = snapshot) {
  if (!pausable(entry) || pauseOwnerStatus(entry.nodeId, statuses)?.nodeId !== entry.nodeId) return false;
  return !handoffNodeId || pauseOwnerStatus(handoffNodeId, statuses)?.nodeId !== entry.nodeId;
}

export function subscribeJobRunStatuses(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Test seam: the store is module-level.
export function __resetJobRunStatusForTests() {
  entries.clear();
  listeners.clear();
  snapshot = Object.freeze([]);
}
