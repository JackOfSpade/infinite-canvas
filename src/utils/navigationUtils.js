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
export function syncStackUpward(currentNodes, currentEdges, currentDrawings, stack, startIndex, stopIndex = 0) {
  let nodes = safeClone(currentNodes);
  let edges = safeClone(currentEdges);
  let drawings = safeClone(currentDrawings);

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
 * Recursively finds and updates a node deep within nested canvasData.
 */
export function deepUpdateNode(nodes, id, dataUpdate) {
  if (!nodes) return { updated: false, nodes };
  let anyUpdated = false;
  const newNodes = nodes.map(n => {
    if (n.id === id) {
      anyUpdated = true;
      return { ...n, data: { ...n.data, ...dataUpdate } };
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
