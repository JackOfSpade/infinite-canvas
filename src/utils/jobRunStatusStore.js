// What each running module wants the side panel to say. Nodes publish here and
// show only that they are processing; the panel owns the status and Pause & save.
const entries = new Map();
const listeners = new Set();
let snapshot = Object.freeze([]);

const statusKey = entry => JSON.stringify([entry.label, entry.headline, entry.lines, entry.pauseKeys, entry.pauseDisabledReason]);

function publishSnapshot() {
  snapshot = Object.freeze([...entries.values()]);
  for (const listener of [...listeners]) { try { listener(); } catch { /* one subscriber cannot stop the rest */ } }
}

export function publishJobRunStatus(nodeId, entry) {
  const next = {
    nodeId, label: entry.label || 'Job Search', headline: entry.headline || 'Processing',
    lines: (entry.lines || []).filter(Boolean), pauseKeys: entry.pauseKeys || [], onPause: entry.onPause || null,
    pauseDisabledReason: entry.pauseDisabledReason || '',
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
