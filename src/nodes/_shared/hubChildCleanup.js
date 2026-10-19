import { beginJobCardDisplayRemoval } from '../../utils/jobCardRemovalIntent.js';
import { EventLogger } from '../../utils/EventLogger.js';

/**
 * Cascade-delete all canvas nodes that belong to a hub. Hub children tag
 * themselves with `data.hubId === <hub's id>` at spawn time; this helper
 * scans the canvas, collects everything matching, and issues a single
 * ReactFlow `deleteElements` call covering both the nodes and any edges
 * incident on them.
 *
 * Used by hub components for both lifecycle cleanup (unmount cascade) and
 * pre-rerun cleanup (clear stale results before spawning fresh ones).
 *
 * @param {object}   args
 * @param {function} args.getNodes      ReactFlow getNodes()
 * @param {function} args.getEdges      ReactFlow getEdges()
 * @param {function} args.deleteElements ReactFlow deleteElements()
 * @param {string}   args.hubId         The owning hub node id
 * @param {string[]} args.childTypes    Node types to consider as children
 *                                      (e.g. ['jobcard', 'jobgroup'])
 * @param {boolean}  [args.displayReplacement] Preserve user dismissal/task intent when replacing Board display cards.
 * @param {Set<string>|string[]} [args.preserveNodeIds] Existing cards reused by a replacement tree; keep their node lifecycle alive.
 * @param {string}   [args.removalLogSummary] Optional single-line summary for
 *                                      this known bulk deletion. Ordinary
 *                                      child cleanup remains itemized.
 */
export function deleteChildrenByHubId({ getNodes, getEdges, deleteElements, hubId, childTypes, removalLogSummary, displayReplacement = false, preserveNodeIds = [] }) {
  const typeSet = new Set(childTypes);
  const preservedIds = preserveNodeIds instanceof Set ? preserveNodeIds : new Set(preserveNodeIds);
  const owned = getNodes().filter(n => typeSet.has(n.type) && n.data?.hubId === hubId && !preservedIds.has(n.id));
  if (owned.length === 0) return;
  const ownedIds = new Set(owned.map(n => n.id));
  const edgesToDelete = getEdges()
    .filter(e => ownedIds.has(e.source) || ownedIds.has(e.target))
    .map(e => ({ id: e.id }));
  // Register before deleteElements: its controlled callbacks are where the
  // individual node/edge/card-dismissal events would otherwise be emitted.
  const removalBatch = removalLogSummary
    ? EventLogger.beginRemovalBatch({
      nodeIds: owned.map(n => n.id),
      edgeIds: edgesToDelete.map(e => e.id),
      jobCardDismissalIds: owned.filter(n => n.type === 'jobcard').map(n => n.id),
      summary: removalLogSummary,
    })
    : null;
  const finishDisplayRemoval = displayReplacement ? beginJobCardDisplayRemoval(owned) : () => {};
  try {
    const deletion = deleteElements({
      nodes: owned.map(n => ({ id: n.id })),
      edges: edgesToDelete,
    });
    Promise.resolve(deletion).then(finishDisplayRemoval, finishDisplayRemoval);
    if (removalBatch) {
      let expiryTimer = null;
      const finishRemovalBatch = () => {
        if (expiryTimer != null) clearTimeout(expiryTimer);
        EventLogger.endRemovalBatch(removalBatch);
      };
      // React Flow's promise settles after its node-delete lifecycle, so this
      // keeps dismissal suppression valid whether that audit fires before or
      // after the controlled node/edge remove callbacks.
      Promise.resolve(deletion).then(
        finishRemovalBatch,
        finishRemovalBatch,
      );
      // A broken/custom deleteElements implementation must not retain stale
      // IDs indefinitely (for example, across an Undo that restores an ID).
      expiryTimer = setTimeout(finishRemovalBatch, 1_000);
    }
    return deletion;
  } catch (error) {
    finishDisplayRemoval();
    EventLogger.endRemovalBatch(removalBatch);
    throw error;
  }
}
