// Replacing a Board's rendered children is not a user dismissal. Keep that
// intent scoped to exact card IDs until React Flow's asynchronous deletion
// lifecycle settles; never persist it on the cards or infer it from logging.
const displayRemovals = new Map();

export function beginJobCardDisplayRemoval(nodes) {
  const token = Symbol('job-card-display-removal');
  const ids = [...new Set((Array.isArray(nodes) ? nodes : [])
    .filter(node => node?.type === 'jobcard' && typeof node.id === 'string')
    .map(node => node.id))];
  for (const id of ids) {
    const owners = displayRemovals.get(id) || new Set();
    owners.add(token);
    displayRemovals.set(id, owners);
  }
  return () => {
    for (const id of ids) {
      const owners = displayRemovals.get(id);
      owners?.delete(token);
      if (!owners?.size) displayRemovals.delete(id);
    }
  };
}

export function isJobCardDisplayRemoval(nodeId) {
  return (displayRemovals.get(nodeId)?.size || 0) > 0;
}
