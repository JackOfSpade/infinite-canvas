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
    window.electronAPI?.cancelNodeTask?.(n.id);
    if (n.data?.canvasData?.nodes) cancelNodeTasksRecursively(n.data.canvasData.nodes, skipIds);
    // Legacy nodes shape fallback
    if (n.data?.nodes) cancelNodeTasksRecursively(n.data.nodes, skipIds);
  });
}

/**
 * Tell the main process that every Local AI handoff owned by a deleted job card
 * is no longer wanted. This deliberately uses only the persisted job id and
 * its owning saved-canvas path; the renderer never supplies a filesystem path
 * to remove. The main-process handler owns the capability check and any
 * import/save coordination.
 *
 * Like cancelNodeTasksRecursively, this visits nested canvas snapshots and
 * skips an explicitly retained locked branch. Deletion callbacks must stay
 * synchronous, so failures are logged but never block React Flow's removal.
 * `discard` is injectable for deterministic tests.
 */
export function discardLocalAiJobsRecursively(
  nodes,
  skipIds,
  discard = (args) => window.electronAPI?.discardLocalApplication?.(args),
) {
  if (!Array.isArray(nodes)) return 0;
  let requested = 0;
  nodes.forEach(n => {
    if (skipIds?.has(n.id)) return;
    const local = n?.type === 'jobcard' ? n.data?.localApplication : null;
    if (local?.id && local?.canvasFilePath && typeof discard === 'function') {
      requested += 1;
      try {
        void Promise.resolve(discard({
          nodeId: n.id,
          jobId: local.id,
          canvasFilePath: local.canvasFilePath,
        })).catch((error) => {
          // The node is already gone. Best-effort cleanup must not turn a
          // normal canvas deletion into an unhandled rejection.
          console.warn(`[LocalAI] Could not discard deleted card handoff job=${local.id}:`, error);
        });
      } catch (error) {
        console.warn(`[LocalAI] Could not start discard for deleted card handoff job=${local.id}:`, error);
      }
    }
    if (n.data?.canvasData?.nodes) requested += discardLocalAiJobsRecursively(n.data.canvasData.nodes, skipIds, discard);
    // Legacy nested-canvas shape fallback.
    if (n.data?.nodes) requested += discardLocalAiJobsRecursively(n.data.nodes, skipIds, discard);
  });
  return requested;
}
