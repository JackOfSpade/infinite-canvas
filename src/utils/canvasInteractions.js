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
    try {
      const pending = window.electronAPI?.discardJobRun?.(discard);
      pending?.catch?.((error) => onError?.(error, discard));
    } catch (error) {
      onError?.(error, discard);
    }
  }
  return discards;
}
