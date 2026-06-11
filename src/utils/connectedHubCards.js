/**
 * Find live cards belonging to a hub.
 *
 * The hubId backlink is authoritative when present. A direct outgoing edge is
 * retained as a fallback for legacy cards that predate the backlink, but must
 * not pull in a card explicitly owned by another hub.
 */
export function getConnectedHubCards({ nodes, edges, hubId, cardType }) {
  const edgeIds = new Set(
    edges
      .filter(edge => edge.source === hubId)
      .map(edge => edge.target)
  );

  return nodes.filter(node => {
    if (node.type !== cardType) return false;
    const ownerId = node.data?.hubId;
    return ownerId === hubId || (!ownerId && edgeIds.has(node.id));
  });
}
