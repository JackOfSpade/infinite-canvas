import { normalizeJobAnalysisClearRunId } from './jobAnalysisRecovery.js';

// ── Global Canvas Interaction State ──────────────────────────────────────────
// These state objects are abstracted completely out of the React lifecycle to
// ensure they survive Hot Module Replacement (HMR) seamlessly during development,
// and prevent catastrophic pointer loss (race conditions) if the active component
// tree unexpectedly unmounts mid-drag.

// Map<nodeId, { flowCx, flowCy, size: { width, height } }>
// Stores the node's dimensions and exact center-point globally right before a resize drag starts.
// Tracked so that standard node-dnd handlers instantly fix the offset shift caused by scaling operations.
export const ResizeCorrection = new Map();

// Set<nodeId>
// Tracks nodes currently participating in an active user resize session.
export const ResizeActive = new Set();

// Set<nodeId>
// Tracks nodes currently being pressed explicitly along their reserved title drag-zone.
export const TitleZoneActive = new Set();

// Map<nodeId, { x, y }>
// Tracks original positional values mid-drag when TitleZone logic intercepts coordinate spaces.
export const TitleZoneCorrection = new Map();

// ── Shared Node Lifecycle Helpers ─────────────────────────────────────────────

/**
 * Recursively cancels active background IPC tasks for a node tree.
 * Optional-chains the IPC call so a missing `window.electronAPI` (or a single
 * throwing cancel) can't abort the recursion mid-tree and strand the remaining
 * nodes' background tasks (partial cancellation).
 *
 * @param {Array}  nodes   - Array of ReactFlow node objects to process
 * @param {Set}   [skipIds] - Optional set of node IDs to skip (e.g. locked nodes)
 */
export function cancelNodeTasksRecursively(nodes, skipIds) {
  if (!Array.isArray(nodes)) return;
  nodes.forEach(n => {
    if (skipIds?.has(n.id)) return;
    // This helper is only reached from the two real deletion paths, so it is
    // the one caller whose cancel genuinely IS a node deletion — every other
    // caller passes its own cause so diagnostics stop calling a Reset a delete.
    window.electronAPI?.cancelNodeTask?.(n.id, 'node-deleted');
    if (n.data?.canvasData?.nodes) cancelNodeTasksRecursively(n.data.canvasData.nodes, skipIds);
    // Legacy nodes shape fallback
    if (n.data?.nodes) cancelNodeTasksRecursively(n.data.nodes, skipIds);
  });
}

/**
 * Return the exact durable Job Search runs abandoned by a real canvas deletion.
 * This deliberately consumes the deleted-node snapshot supplied by React Flow:
 * component unmount is also used for canvas navigation and therefore is not
 * evidence that the user deleted anything.
 */
export function collectDeletedJobRunDiscards(nodes, canvasFilePath) {
  if (!Array.isArray(nodes)) return [];
  const discards = [];
  const seen = new Set();
  const visit = (items) => {
    for (const node of items || []) {
      if (node?.type === 'jobhub') {
        const nodeId = node.id || null;
        // `pendingBatch.jobRunId` owns only the scoring-batch lifecycle. Outside
        // that state it can be a stale persisted remnant, while `jobRunId` is the
        // current search/checkpoint owner stamped before the pre-score await.
        // Prefer the token whose state actually owns the hub so a malformed or
        // interrupted prior batch cannot make deletion spare the current run.
        const runId = node.data?.hubState === 'scoring-batch'
          ? (node.data?.pendingBatch?.jobRunId || node.data?.jobRunId || null)
          : (node.data?.jobRunId || node.data?.pendingBatch?.jobRunId || null);
        const key = `${nodeId || ''}\u0000${runId || ''}`;
        if (nodeId && runId && !seen.has(key)) {
          seen.add(key);
          discards.push({ canvasFilePath, nodeId, runId });
        }
      }
      visit(node?.data?.canvasData?.nodes);
      visit(node?.data?.nodes);
    }
  };
  visit(nodes);
  return discards;
}

/**
 * Dispatch best-effort exact-run cleanup for every deleted Job Search hub.
 * Kept beside the collector so interactive React Flow deletion and the
 * programmatic Clear Canvas path cannot drift into different lifecycle rules.
 */
export function discardDeletedJobRuns(nodes, canvasFilePath, onError = null) {
  const discards = collectDeletedJobRunDiscards(nodes, canvasFilePath);
  for (const discard of discards) {
    const discardRun = window.electronAPI?.discardJobRun;
    if (typeof discardRun !== 'function') {
      onError?.(new Error('Job run cleanup is unavailable'), discard, null);
      continue;
    }
    try {
      Promise.resolve(discardRun(discard)).then((result) => {
        if (result?.success !== true || result?.ok !== true) {
          onError?.(new Error(result?.error || result?.reason || 'Job run cleanup failed'), discard, result);
        }
      }).catch((error) => onError?.(error, discard, null));
    } catch (error) {
      onError?.(error, discard, null);
    }
  }
  return discards;
}

/**
 * Capture analysis-bundle cleanup ownership at a committed deletion boundary.
 * The bundle is canvas-scoped, so the hub/run and clear timestamp must be
 * captured before React Flow removes the node. Callers pass the actual removed
 * roots: Clear Canvas has already excluded its top-level locked roots, while a
 * locked descendant of an unlocked deleted group is still removed and must be
 * cleaned rather than left resumable on disk.
 */
export function collectDeletedJobAnalysisDiscards(nodes, canvasFilePath, clearedAt = Date.now()) {
  if (!Array.isArray(nodes)) return [];
  const discards = [];
  const seen = new Set();
  const visit = (items) => {
    for (const node of items || []) {
      if (node?.type === 'jobhub') {
        const nodeId = typeof node.id === 'string' && node.id ? node.id : null;
        const rawRunId = node.data?.hubState === 'scoring-batch'
          ? (node.data?.pendingBatch?.jobRunId || node.data?.jobRunId || null)
          : (node.data?.jobRunId || node.data?.pendingBatch?.jobRunId || null);
        // A malformed persisted run token must not turn an otherwise safe
        // boundary clear into an invalid IPC request. Null still deletes
        // pre-boundary artifacts by exact hub/canvas ownership; a valid token
        // simply adds the equal-time/late-write tombstone.
        const runId = normalizeJobAnalysisClearRunId(rawRunId);
        // A terminal hub can have saved analysis without a live staging token,
        // so null runId still needs an exact hub-owned cleanup attempt.
        if (nodeId && !seen.has(nodeId)) {
          seen.add(nodeId);
          discards.push({ canvasFilePath, nodeId, runId, clearedAt });
        }
      }
      visit(node?.data?.canvasData?.nodes);
      visit(node?.data?.nodes);
    }
  };
  visit(nodes);
  return discards;
}

// A cross-hub bundle can be mixed because `current` has already advanced to a
// different hub/run while this deleted hub still owns an older last-success
// record. Preserving the foreign/new artifacts and clearing the exact old one
// is a successful safe outcome, not a warning. An `unpaired` prompt is NOT
// safe: it has no owner metadata, may retain the removed hub's career data,
// and needs an honest cleanup warning. Never silently accept malformed JSON,
// uncertain removal, or an unknown state either.
export function isSafeJobAnalysisCleanupNoop(result) {
  if (result?.reason !== 'ownership-mismatch') return false;
  const artifacts = Object.values(result?.artifacts || {});
  const safeStates = new Set(['missing', 'ownership-mismatch', 'foreign-paired', 'post-clear', 'post-clear-paired', 'cleared']);
  return artifacts.length > 0
    && artifacts.every(artifact => safeStates.has(artifact?.state));
}

/**
 * Dispatch best-effort analysis cleanup without delaying visual deletion. The
 * main process rechecks canvas/hub ownership and uses the captured timestamp
 * plus run tombstone to prevent Undo or a late same-run writer resurfacing
 * pre-clear career-derived recovery.
 */
export function discardDeletedJobAnalysisSnapshots(nodes, canvasFilePath, onFailure = null, clearedAt = Date.now()) {
  const discards = collectDeletedJobAnalysisDiscards(nodes, canvasFilePath, clearedAt);
  for (const discard of discards) {
    const discardSnapshot = window.electronAPI?.discardJobAnalysisSnapshot;
    if (!discardSnapshot) {
      onFailure?.(new Error('Saved Job Search recovery cleanup is unavailable'), discard, null);
      continue;
    }
    try {
      Promise.resolve(discardSnapshot(discard)).then((result) => {
        const safeNoop = isSafeJobAnalysisCleanupNoop(result);
        if (result?.success !== true || (result?.ok !== true && !safeNoop)) {
          const detail = result?.error || result?.reason;
          onFailure?.(new Error(`Saved Job Search recovery cleanup failed${detail ? `: ${detail}` : ''}`), discard, result);
        }
      }).catch((error) => onFailure?.(error, discard, null));
    } catch (error) {
      onFailure?.(error, discard, null);
    }
  }
  return discards;
}
