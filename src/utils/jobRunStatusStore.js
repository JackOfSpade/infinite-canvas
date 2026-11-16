import { formatProgressDuration } from './claudeJobProgress.js';

// What each running module wants the side panel to say. Nodes publish here and
// show only that they are processing; the panel owns the status and Pause & save.
const entries = new Map();
const listeners = new Set();
let snapshot = Object.freeze([]);

const pausable = entry => Boolean(entry?.onPause || entry?.pauseWithoutSave);

const statusKey = entry => JSON.stringify([
  entry.label, entry.headline, entry.lines, entry.pauseKeys, entry.pauseDisabledReason,
  entry.claudeRequestId, entry.pauseWithoutSave, entry.relatedNodeIds,
]);

function publishSnapshot() {
  snapshot = Object.freeze([...entries.values()]);
  for (const listener of [...listeners]) { try { listener(); } catch { /* one subscriber cannot stop the rest */ } }
}

export function publishJobRunStatus(nodeId, entry, now = Date.now()) {
  const previous = entries.get(nodeId);
  const next = {
    nodeId, label: entry.label || 'Job Search', headline: entry.headline || 'Processing',
    lines: (entry.lines || []).filter(Boolean), pauseKeys: entry.pauseKeys || [], onPause: entry.onPause || null,
    pauseDisabledReason: entry.pauseDisabledReason || '',
    // A live Claude request the panel draws with the full worker activity card.
    claudeRequestId: entry.claudeRequestId || null,
    // The run pauses in place with no save step, so the card still holds a button.
    pauseWithoutSave: entry.pauseWithoutSave === true,
    // Other nodes whose handoffs this run is part of: a job card's generation
    // works through prompts its Board owns, and belongs in that Board's tab.
    relatedNodeIds: (entry.relatedNodeIds || []).filter(value => typeof value === 'string' && value),
  };
  // Card clocks are bookkeeping, not status: both stay out of statusKey, so a
  // fresh timestamp on its own never re-renders the panel. startedAt survives
  // every re-publish of this nodeId and restarts only after the node was
  // cleared; changedAt moves whenever the person-visible status changes.
  next.startedAt = Number.isFinite(previous?.startedAt) ? previous.startedAt : now;
  next.changedAt = !previous || statusKey(previous) !== statusKey(next)
    ? now
    : Number.isFinite(previous.changedAt) ? previous.changedAt : now;
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

/**
 * The elapsed line a status card shows, plus the hint that nothing visible has
 * happened for two minutes. A re-publish that changed nothing keeps changedAt,
 * so a genuinely stalled run announces itself without any new publish.
 */
export function runStatusTimeLines(entry, now = Date.now()) {
  const startedAt = entry?.startedAt;
  const changedAt = entry?.changedAt;
  if (!Number.isFinite(startedAt) || !Number.isFinite(changedAt) || !Number.isFinite(now)) return { lines: [], stale: false };
  const elapsed = formatProgressDuration(now - startedAt);
  const lines = elapsed ? [`Running: ${elapsed}`] : [];
  const quiet = now - changedAt;
  const stale = quiet >= 120000;
  const unchanged = stale ? formatProgressDuration(quiet) : null;
  if (unchanged) lines.push(`No change for ${unchanged}`);
  return { lines, stale: stale && Boolean(unchanged) };
}

/** Whose Pause & save covers this module: a Board running it, otherwise the module itself. */
export function pauseOwnerStatus(nodeId, statuses = snapshot) {
  const key = `node:${nodeId}`;
  return statuses.find(entry => entry.nodeId !== nodeId && pausable(entry) && entry.pauseKeys.includes(key))
    || statuses.find(entry => entry.nodeId === nodeId)
    || null;
}

/**
 * Fold each shown run into the shown card whose Pause & save covers it — a
 * Board draws the searches it runs instead of the panel drawing them twice.
 * Only an owner that is itself shown adopts children, so a narrowed panel never
 * loses a run; order follows the store.
 */
export function groupRunStatusesByOwner(shown, statuses = snapshot) {
  const list = Array.isArray(shown) ? shown : [];
  const shownNodeIds = new Set(list.map(entry => entry?.nodeId));
  const ownerOf = new Map();
  for (const entry of list) {
    if (!entry?.nodeId) continue;
    const owner = pauseOwnerStatus(entry.nodeId, statuses);
    if (!owner || owner.nodeId === entry.nodeId || !shownNodeIds.has(owner.nodeId)) continue;
    ownerOf.set(entry.nodeId, owner.nodeId);
  }
  // An owner that is itself folded into another card draws no group of its
  // own, so its runs stay top level rather than vanish.
  for (const [nodeId, ownerNodeId] of [...ownerOf]) {
    if (ownerOf.has(ownerNodeId)) ownerOf.delete(nodeId);
  }
  const groups = [];
  const groupByOwner = new Map();
  for (const entry of list) {
    if (ownerOf.has(entry?.nodeId)) continue;
    const group = { entry, children: [] };
    groups.push(group);
    groupByOwner.set(entry.nodeId, group);
  }
  for (const entry of list) {
    const ownerNodeId = ownerOf.get(entry?.nodeId);
    if (ownerNodeId) groupByOwner.get(ownerNodeId)?.children.push(entry);
  }
  return groups;
}

/** One button per pausable run. The handoff row holds its owner's button, so that card shows none. */
export function showsOwnPauseButton(entry, handoffNodeId = null, statuses = snapshot) {
  if (!pausable(entry) || pauseOwnerStatus(entry.nodeId, statuses)?.nodeId !== entry.nodeId) return false;
  return !handoffNodeId || pauseOwnerStatus(handoffNodeId, statuses)?.nodeId !== entry.nodeId;
}

/**
 * Does this running module belong to the handoff owned by `handoffNodeId`?
 * A module belongs to its own node, and a Board also owns every search it is
 * running for itself — those searches are listed by `node:<searchId>` in the
 * Board's pauseKeys, the same keys Pause & save travels along.
 */
export function runStatusBelongsToHandoff(entry, handoffNodeId) {
  if (typeof handoffNodeId !== 'string' || !handoffNodeId) return false;
  if (entry?.nodeId === handoffNodeId) return true;
  if (Array.isArray(entry?.relatedNodeIds) && entry.relatedNodeIds.includes(handoffNodeId)) return true;
  return Array.isArray(entry?.pauseKeys) && entry.pauseKeys.includes(`node:${handoffNodeId}`);
}

/**
 * Split the store into one list per pending handoff plus the runs no handoff
 * owns. Store order is kept, a run related to several handoffs appears under
 * each of them, and empty or repeated handoff ids are tolerated — several
 * queued prompts can share one hub.
 */
export function partitionRunStatusesForHandoffs(statuses, handoffNodeIds) {
  const ids = [];
  const seen = new Set();
  for (const value of handoffNodeIds || []) {
    if (typeof value !== 'string' || !value || seen.has(value)) continue;
    seen.add(value);
    ids.push(value);
  }
  const byHandoff = new Map(ids.map(id => [id, []]));
  const unrelated = [];
  for (const entry of statuses || []) {
    let related = false;
    for (const id of ids) {
      if (!runStatusBelongsToHandoff(entry, id)) continue;
      byHandoff.get(id).push(entry);
      related = true;
    }
    if (!related) unrelated.push(entry);
  }
  return { byHandoff, unrelated };
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
