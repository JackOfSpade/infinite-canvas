// React Flow deletion awaits onBeforeDelete and later removes nodes by id. A
// protected application card reused by the new tree must stay in the graph:
// deleting and immediately appending the same id lets that late removal erase
// the replacement and can make its application worker observe a deleted card.
export function replaceBoardDisplayChildren({
  hubId, newNodes, newEdges, getNodes, clearChildren, updateNodeData, setNodes, addElements,
}) {
  const liveById = new Map(getNodes().map(node => [node.id, node]));
  const retained = new Map(newNodes
    .filter(node => node.type === 'jobcard'
      && node.data?.hubId === hubId
      && liveById.get(node.id)?.type === 'jobcard'
      && liveById.get(node.id)?.data?.hubId === hubId)
    .map(node => [node.id, node]));
  const deletion = clearChildren({ preserveNodeIds: new Set(retained.keys()) });
  for (const [nodeId, replacement] of retained) {
    // The builder spreads the current protected card's data before applying
    // new result fields. Publish only changed fields so queued application or
    // note writes cannot be overwritten by an otherwise identical snapshot.
    const previousData = liveById.get(nodeId).data;
    const patch = Object.fromEntries(Object.entries(replacement.data)
      .filter(([key, value]) => value !== previousData[key]));
    if (Object.keys(patch).length > 0) updateNodeData(nodeId, patch);
  }
  if (retained.size > 0) {
    setNodes(nodes => nodes.map(node => {
      const replacement = retained.get(node.id);
      return replacement ? { ...node, position: replacement.position, hidden: replacement.hidden } : node;
    }));
  }
  addElements(newNodes.filter(node => !retained.has(node.id)), newEdges);
  return deletion;
}
