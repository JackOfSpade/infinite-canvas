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
 * Requires `window.electronAPI.cancelNodeTask` to be available — callers
 * are responsible for the existence check before calling this function.
 *
 * @param {Array}  nodes   - Array of ReactFlow node objects to process
 * @param {Set}   [skipIds] - Optional set of node IDs to skip (e.g. locked nodes)
 */
export function cancelNodeTasksRecursively(nodes, skipIds) {
  nodes.forEach(n => {
    if (skipIds?.has(n.id)) return;
    window.electronAPI.cancelNodeTask(n.id);
    if (n.data?.canvasData?.nodes) cancelNodeTasksRecursively(n.data.canvasData.nodes, skipIds);
    // Legacy nodes shape fallback
    if (n.data?.nodes) cancelNodeTasksRecursively(n.data.nodes, skipIds);
  });
}

