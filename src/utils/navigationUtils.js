export function safeClone(data) {
  if (!data) return data;
  try { return structuredClone(data); }
  catch { return JSON.parse(JSON.stringify(data)); }
}

/**
 * Walk the navigation stack upward from `startIndex` to 0, syncing each
 * level's canvas data back into its parent's node tree.
 *
 * Returns the root-level { nodes, edges, drawings }.
 * Pure function — does not mutate state.
 */
export function syncStackUpward(currentNodes, currentEdges, currentDrawings, stack, startIndex, stopIndex = 0, { clone = true } = {}) {
  // A save only reads the result and copies it out of the window, so it passes
  // clone: false. Deep-copying a large open level froze the window for about
  // half a second per auto-save, and gave every node a new identity, which
  // hides from the save which nodes actually changed.
  let nodes = clone ? safeClone(currentNodes) : currentNodes;
  let edges = clone ? safeClone(currentEdges) : currentEdges;
  let drawings = clone ? safeClone(currentDrawings) : currentDrawings;

  for (let i = startIndex; i >= stopIndex; i--) {
    const parentState = stack[i];
    const updatedNodes = parentState.nodes.map(n => {
      if (n.id === parentState.nodeId) {
        return {
          ...n,
          data: {
            ...n.data,
            canvasData: { nodes, edges, drawings },
          },
        };
      }
      return n;
    });

    nodes = updatedNodes;
    edges = parentState.edges;
    drawings = parentState.drawings;
  }

  return { nodes, edges, drawings };
}

/**
 * Resolve canvas data from a node, supporting both old and new data shapes.
 * Pure function — no hook state required.
 */
export function getCanvasData(node) {
  if (node.data.canvasData) return node.data.canvasData;
  // Legacy fallback
  return {
    nodes: node.data.nodes || [],
    edges: node.data.edges || [],
    drawings: node.data.drawings || [],
  };
}

/**
 * Read-only deep traversal: collects every node in the given array, including
 * nodes nested inside group canvasData, without cloning anything (unlike
 * syncStackUpward/flushStack). Duplicate ids keep their FIRST occurrence, so
 * callers can layer sources freshest-first. Callers must treat the returned
 * nodes as read-only.
 */
export function collectNodesDeep(nodes, out = [], seen = new Set(), skipDescendIds = null) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node?.id || seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node);
    // skipDescendIds: the node itself is real, but its embedded canvasData is a
    // stale snapshot (a navigation-stack entry's dived-into branch) — the live
    // contents come from a fresher source, so descending would surface ghosts
    // of nodes that were since edited or deleted at the active level.
    if (skipDescendIds?.has(node.id)) continue;
    const nested = node.data?.canvasData?.nodes;
    if (Array.isArray(nested)) collectNodesDeep(nested, out, seen, skipDescendIds);
  }
  return out;
}

/**
 * Recursively finds and updates a node deep within nested canvasData.
 */
export function deepUpdateNode(nodes, id, dataUpdate) {
  if (!nodes) return { updated: false, nodes };
  let anyUpdated = false;
  const newNodes = nodes.map(n => {
    if (n.id === id) {
      const patch = typeof dataUpdate === 'function' ? dataUpdate(n) : dataUpdate;
      // A function patch may inspect the live node and decline (null/undefined):
      // keep the exact same node identity and report nothing updated, so a
      // guarded no-op write cannot dirty the workspace or churn React state.
      if (patch == null) return n;
      anyUpdated = true;
      return { ...n, data: { ...n.data, ...patch } };
    }
    if (n.data?.canvasData?.nodes) {
      const { updated, nodes: childNodes } = deepUpdateNode(n.data.canvasData.nodes, id, dataUpdate);
      if (updated) {
        anyUpdated = true;
        return { ...n, data: { ...n.data, canvasData: { ...n.data.canvasData, nodes: childNodes } } };
      }
    }
    return n;
  });
  return { updated: anyUpdated, nodes: newNodes };
}

/**
 * Recursively removes the given node ids from a level and every nested group
 * canvasData, dropping edges that touch them. `reflowLevel(remaining, removed)`
 * may re-lay out a level that lost nodes (it must be pure); it runs once per
 * affected level array. Unchanged arrays keep their identity.
 */
export function deepRemoveNodes(nodes, ids, reflowLevel = null) {
  if (!Array.isArray(nodes) || !ids?.size) return { updated: false, nodes };
  let anyUpdated = false;
  const removedHere = [];
  const kept = [];
  for (const n of nodes) {
    if (ids.has(n?.id)) { removedHere.push(n); continue; }
    const nested = n?.data?.canvasData;
    if (Array.isArray(nested?.nodes)) {
      const inner = deepRemoveNodes(nested.nodes, ids, reflowLevel);
      const innerEdges = Array.isArray(nested.edges) ? nested.edges : null;
      const edges = innerEdges ? innerEdges.filter(e => !ids.has(e?.source) && !ids.has(e?.target)) : null;
      if (inner.updated || (innerEdges && edges.length !== innerEdges.length)) {
        anyUpdated = true;
        kept.push({ ...n, data: { ...n.data, canvasData: { ...nested, nodes: inner.nodes, ...(innerEdges ? { edges } : {}) } } });
        continue;
      }
    }
    kept.push(n);
  }
  if (!removedHere.length) return { updated: anyUpdated, nodes: anyUpdated ? kept : nodes };
  const reflowed = typeof reflowLevel === 'function' ? reflowLevel(kept, removedHere) : kept;
  return { updated: true, nodes: Array.isArray(reflowed) ? reflowed : kept };
}

/** Drops edges touching any removed node id; keeps identity when none do. */
export function filterEdgesForRemovedNodes(edges, ids) {
  if (!Array.isArray(edges) || !ids?.size) return edges;
  const next = edges.filter(e => !ids.has(e?.source) && !ids.has(e?.target));
  return next.length === edges.length ? edges : next;
}

/**
 * The navigation stack with the given node ids removed from every level (and
 * nested canvases), with their edges. Unchanged levels, and the stack itself
 * when nothing changed, keep their identity. Pure: the setter body of
 * useCanvasNavigation.removeNodesGlobally.
 */
export function removeNodesFromStack(stack, ids, reflowLevel = null) {
  if (!Array.isArray(stack) || !ids?.size) return stack;
  let stackUpdated = false;
  const newStack = stack.map(level => {
    const { updated, nodes: newNodes } = deepRemoveNodes(level?.nodes, ids, reflowLevel);
    const newEdges = filterEdgesForRemovedNodes(level?.edges, ids);
    if (!updated && newEdges === level?.edges) return level;
    stackUpdated = true;
    return { ...level, nodes: updated ? newNodes : level.nodes, edges: newEdges };
  });
  return stackUpdated ? newStack : stack;
}

/** The active level's nodes with the ids removed; `nodes` itself when none matched. */
export function removeNodesFromActiveLevel(nodes, ids, reflowLevel = null) {
  const { updated, nodes: next } = deepRemoveNodes(nodes, ids, reflowLevel);
  return updated ? next : nodes;
}

/**
 * Recursively finds the level where targetNodeId exists and appends newNodes and newEdges.
 * placement: 'inside' (insert into targetNodeId's canvasData) | 'sibling' (insert alongside targetNodeId)
 */
export function deepAddElements(nodes, edges, targetNodeId, newNodes, newEdges, placement = 'inside') {
  if (!nodes) return { updated: false, nodes, edges };
  let anyUpdated = false;

  const nextNodes = nodes.map(n => {
    // If dropping inside this target node
    if (placement === 'inside' && n.id === targetNodeId) {
      anyUpdated = true;
      const prevNodes = n.data?.canvasData?.nodes || [];
      const prevEdges = n.data?.canvasData?.edges || [];
      return {
        ...n,
        data: {
          ...n.data,
          canvasData: {
            ...n.data?.canvasData,
            nodes: [...prevNodes, ...(newNodes || [])],
            edges: [...prevEdges, ...(newEdges || [])]
          }
        }
      };
    }

    // Keep searching deeper
    if (n.data?.canvasData?.nodes) {
      const { updated, nodes: childNodes, edges: childEdges } = deepAddElements(
        n.data.canvasData.nodes, 
        n.data.canvasData.edges || [], 
        targetNodeId, 
        newNodes, 
        newEdges,
        placement
      );
      if (updated) {
        anyUpdated = true;
        return { 
          ...n, 
          data: { 
            ...n.data, 
            canvasData: { 
              ...n.data.canvasData, 
              nodes: childNodes,
              edges: childEdges
            } 
          } 
        };
      }
    }
    return n;
  });

  // If placement is sibling, append to the array containing the target node
  if (placement === 'sibling' && nodes.some(n => n.id === targetNodeId)) {
    anyUpdated = true;
    return { 
      updated: true, 
      nodes: [...nextNodes, ...(newNodes || [])],
      edges: edges ? [...edges, ...(newEdges || [])] : (newEdges || [])
    };
  }

  return { updated: anyUpdated, nodes: nextNodes, edges };
}
