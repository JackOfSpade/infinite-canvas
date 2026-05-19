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
 */
export function deleteChildrenByHubId({ getNodes, getEdges, deleteElements, hubId, childTypes }) {
  const typeSet = new Set(childTypes);
  const owned = getNodes().filter(n => typeSet.has(n.type) && n.data?.hubId === hubId);
  if (owned.length === 0) return;
  const ownedIds = new Set(owned.map(n => n.id));
  const edgesToDelete = getEdges()
    .filter(e => ownedIds.has(e.source) || ownedIds.has(e.target))
    .map(e => ({ id: e.id }));
  deleteElements({
    nodes: owned.map(n => ({ id: n.id })),
    edges: edgesToDelete,
  });
}
