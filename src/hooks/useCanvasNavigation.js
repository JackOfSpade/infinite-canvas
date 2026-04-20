import { useState, useCallback, useRef, useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import { getNodeDims } from '../utils/constants';

function safeClone(data) {
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
function syncStackUpward(currentNodes, currentEdges, currentDrawings, stack, startIndex, stopIndex = 0) {
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
function getCanvasData(node) {
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
function deepUpdateNode(nodes, id, dataUpdate) {
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
 * Recursively finds the level where targetNodeId exists and appends newNodes and newEdges there.
 */
function deepAddElements(nodes, edges, targetNodeId, newNodes, newEdges) {
  if (!nodes) return { updated: false, nodes, edges };
  let anyUpdated = false;

  const nextNodes = nodes.map(n => {
    // We do NOT modify n itself if it's the target, just map its children
    if (n.data?.canvasData?.nodes) {
      const { updated, nodes: childNodes, edges: childEdges } = deepAddElements(
        n.data.canvasData.nodes, 
        n.data.canvasData.edges || [], 
        targetNodeId, 
        newNodes, 
        newEdges
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

  // If targetNodeId was found in THIS array level, append newNodes and newEdges here
  if (nodes.some(n => n.id === targetNodeId)) {
    anyUpdated = true;
    return { 
      updated: true, 
      nodes: [...nextNodes, ...newNodes],
      edges: edges ? [...edges, ...(newEdges || [])] : (newEdges || [])
    };
  }

  return { updated: anyUpdated, nodes: nextNodes, edges };
}

/**
 * Navigation stack for nested canvas dive-in / dive-out.
 *
 * Stack entries store the PARENT canvas state when we leave it:
 *   { nodeId, childTitle, nodes, edges, drawings, viewport }
 *
 * The currently-active canvas data is always whatever's in the
 * live nodes/edges/drawings state (managed by Canvas.jsx).
 */
export function useCanvasNavigation({
  nodes, edges, drawings,
  setNodes, setEdges, setDrawings,
  clearHistory,
  getAnimationDuration,
}) {
  const [stack, setStack] = useState([]);
  const [isAnimating, setIsAnimating] = useState(false);
  const [animPhase, setAnimPhase] = useState(null); // 'fade-out' | 'fade-in'
  const reactFlow = useReactFlow();

  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const drawingsRef = useRef(drawings);
  const stackRef = useRef(stack);
  const isNavigatingRef = useRef(false);
  const navTimersRef = useRef([]); // All pending navigation setTimeout IDs
  useEffect(() => {
    return () => {
      // Safety: reset navigation flag and cancel all pending timers to prevent
      // stale state updates if the component is torn down mid-transition.
      isNavigatingRef.current = false;
      navTimersRef.current.forEach(id => clearTimeout(id));
      navTimersRef.current = [];
    };
  }, []);

  useEffect(() => {
    nodesRef.current = nodes;
    edgesRef.current = edges;
    drawingsRef.current = drawings;
    stackRef.current = stack;
  }, [nodes, edges, drawings, stack]);

  const depth = stack.length;

  // Build breadcrumbs: [Root, ...each level we navigated into]
  // Last entry = current level (not clickable)
  const breadcrumbs = [
    { id: 'root', title: 'Main Canvas' },
    ...stack.map(s => ({ id: s.nodeId, title: s.childTitle })),
  ];

  /**
   * Dive into a nested canvas node.
   */
  const diveIn = useCallback((nodeId) => {
    if (isAnimating || isNavigatingRef.current) return;
    isNavigatingRef.current = true;

    const node = reactFlow.getNode(nodeId);
    if (!node || node.type !== 'group') {
      isNavigatingRef.current = false;
      return;
    }

    const canvasData = getCanvasData(node);
    const halfDuration = getAnimationDuration() / 2;

    setIsAnimating(true);
    setAnimPhase('fade-out');

    // Save current state
    const viewport = reactFlow.getViewport();
    const parentState = {
      nodeId,
      childTitle: node.data.title || 'Sub-Canvas',
      nodes: safeClone(nodesRef.current),
      edges: safeClone(edgesRef.current),
      drawings: safeClone(drawingsRef.current),
      viewport,
    };

    // After fade-out completes, swap data
    const t1 = setTimeout(() => {
      navTimersRef.current = navTimersRef.current.filter(id => id !== t1);
      setStack(s => [...s, parentState]);
      setNodes(canvasData.nodes || []);
      setEdges(canvasData.edges || []);
      setDrawings(canvasData.drawings || []);
      clearHistory?.();

      // Let React render the new data, then center and fade in
      requestAnimationFrame(() => {
        // Centre on child content at current zoom — never change zoom
        const currentVp = reactFlow.getViewport();
        const childNodes = canvasData.nodes || [];
        if (childNodes.length > 0) {
          let sumX = 0, sumY = 0;
          childNodes.forEach(n => {
            const dims = getNodeDims(n);
            sumX += n.position.x + dims.w / 2;
            sumY += n.position.y + dims.h / 2;
          });
          const cx = sumX / childNodes.length;
          const cy = sumY / childNodes.length;
          const viewportNode = document.querySelector('.react-flow__viewport');
          const flowWidth = viewportNode ? viewportNode.parentElement.clientWidth : window.innerWidth;
          const flowHeight = viewportNode ? viewportNode.parentElement.clientHeight : window.innerHeight;
          reactFlow.setViewport({
            x: flowWidth / 2 - cx * currentVp.zoom,
            y: flowHeight / 2 - cy * currentVp.zoom,
            zoom: currentVp.zoom,
          }, { duration: 0 });
        }
        setAnimPhase('fade-in');

        const t2 = setTimeout(() => {
          navTimersRef.current = navTimersRef.current.filter(id => id !== t2);
          setIsAnimating(false);
          setAnimPhase(null);
          isNavigatingRef.current = false;
        }, halfDuration);
        navTimersRef.current.push(t2);
      });
    }, halfDuration);
    navTimersRef.current.push(t1);
  }, [isAnimating, reactFlow, getAnimationDuration, setNodes, setEdges, setDrawings, clearHistory]);

  /**
   * Jump to a specific breadcrumb level.
   * targetIndex 0 = root, 1 = first sub-canvas, etc.
   * Syncs all intermediate canvas data back through the chain.
   */
  const jumpTo = useCallback((targetIndex) => {
    const currentStack = stackRef.current;
    if (isAnimating || isNavigatingRef.current || targetIndex >= currentStack.length || targetIndex < 0) return;
    isNavigatingRef.current = true;

    const halfDuration = getAnimationDuration() / 2;
    setIsAnimating(true);
    setAnimPhase('fade-out');

    const t3 = setTimeout(() => {
      navTimersRef.current = navTimersRef.current.filter(id => id !== t3);
      const { nodes: cn, edges: ce, drawings: cd } = syncStackUpward(
        nodesRef.current, edgesRef.current, drawingsRef.current,
        currentStack, currentStack.length - 1, targetIndex
      );

      const targetViewport = currentStack[targetIndex].viewport;
      setStack(s => s.slice(0, targetIndex));
      setNodes(cn);
      setEdges(ce);
      setDrawings(cd);
      clearHistory?.();

      requestAnimationFrame(() => {
        reactFlow.setViewport(targetViewport, { duration: 0 });
        setAnimPhase('fade-in');

        const t4 = setTimeout(() => {
          navTimersRef.current = navTimersRef.current.filter(id => id !== t4);
          setIsAnimating(false);
          setAnimPhase(null);
          isNavigatingRef.current = false;
        }, halfDuration);
        navTimersRef.current.push(t4);
      });
    }, halfDuration);
    navTimersRef.current.push(t3);
  }, [isAnimating, reactFlow, getAnimationDuration, setNodes, setEdges, setDrawings, clearHistory]);

  /**
   * Dive out one level (back to parent).
   */
  const diveOut = useCallback(() => {
    if (isNavigatingRef.current || stackRef.current.length === 0) return;
    jumpTo(stackRef.current.length - 1);
  }, [jumpTo]);

  /**
   * Flush: sync all pending sub-canvas edits back through the stack.
   * Returns the root-level { nodes, edges, drawings } without mutating state.
   * Called before saving.
   */
  const flushStack = useCallback(() => {
    const currentStack = stackRef.current;
    if (currentStack.length === 0) {
      return { nodes: nodesRef.current, edges: edgesRef.current, drawings: drawingsRef.current };
    }

    return syncStackUpward(
      nodesRef.current, edgesRef.current, drawingsRef.current,
      currentStack, currentStack.length - 1
    );
  }, []);

  /**
   * Detach one or more nodes (and their internal edges) from the current sub-canvas and move them to the parent canvas.
   */
  const extractToParent = useCallback((nodeIdOrIds) => {
    if (stackRef.current.length === 0) return;

    const ids = Array.isArray(nodeIdOrIds) ? nodeIdOrIds : [nodeIdOrIds];
    
    const nodesToExtract = nodesRef.current.filter(n => ids.includes(n.id));
    if (nodesToExtract.length === 0) return;

    // Preserve edges that are entirely between the extracted nodes
    const edgesToExtract = edgesRef.current.filter(e => ids.includes(e.source) && ids.includes(e.target));

    // Remove from current canvas
    setNodes(nds => nds.filter(n => !ids.includes(n.id)));
    // Delete any edges connected to the extracted nodes in the current canvas
    setEdges(eds => eds.filter(e => !ids.includes(e.source) && !ids.includes(e.target)));

    // Clear history to prevent a duplication bug where undoing the extraction 
    // restores the node locally, but it remains injected in the parent stack.
    clearHistory?.();

    // Inject into parent's saved state
    setStack(s => {
      if (s.length === 0) return s; // Secondary check inside setter
      
      const newStack = [...s];
      const parent = newStack[newStack.length - 1];
      if (!parent) return s;

      const parentContainer = parent.nodes.find(n => n.id === parent.nodeId);
      
      // Compute bounding box of extracted nodes to preserve relative layout
      const minX = Math.min(...nodesToExtract.map(n => n.position.x));
      const minY = Math.min(...nodesToExtract.map(n => n.position.y));
      
      // Base coordinate places the entire group's bounding box near the parent container
      const basePosX = (parentContainer?.position.x || 0) + 120;
      const basePosY = (parentContainer?.position.y || 100) - 150;

      const newParentNodes = [...parent.nodes];
      nodesToExtract.forEach((nodeToExtract) => {
        const offsetX = nodeToExtract.position.x - minX;
        const offsetY = nodeToExtract.position.y - minY;
        newParentNodes.push({ 
          ...nodeToExtract, 
          position: { x: basePosX + offsetX, y: basePosY + offsetY } 
        });
      });

      const newParentEdges = [...(parent.edges || []), ...edgesToExtract];

      newStack[newStack.length - 1] = { ...parent, nodes: newParentNodes, edges: newParentEdges };
      return newStack;
    });
  }, [setNodes, setEdges, clearHistory]);

  /**
   * Globally updates a node's data by ID, regardless of whether it is 
   * in the active canvas, hidden in the navigation stack, or deeply 
   * nested inside a group's canvasData.
   */
  const updateNodeDataGlobally = useCallback((nodeId, dataUpdate) => {
    // Always update both active nodes and the stack. deepUpdateNode is a pure function
    // that returns the original array reference unchanged when nothing matches, so
    // calling it on both is safe and avoids the async-flag race condition that existed
    // when reading a flag set inside a React state updater.
    setNodes(prev => {
      const { updated, nodes: newNodes } = deepUpdateNode(prev, nodeId, dataUpdate);
      return updated ? newNodes : prev;
    });

    setStack(prevStack => {
      let stackUpdated = false;
      const newStack = prevStack.map(level => {
        const { updated, nodes: newNodes } = deepUpdateNode(level.nodes, nodeId, dataUpdate);
        if (updated) stackUpdated = true;
        return updated ? { ...level, nodes: newNodes } : level;
      });
      return stackUpdated ? newStack : prevStack;
    });
  }, [setNodes]);

  /**
   * Appends new nodes and edges to the specific array level where targetNodeId lives.
   *
   * Snapshots both refs at call-time so nodes and edges are computed from a consistent
   * view of state, avoiding mismatches when functional setters for each would see
   * different committed values. The stack is still updated via a functional setter
   * because pipeline callers may call this back-to-back; the functional form always
   * sees the latest committed stack and prevents overwrite races.
   */
  const addElementsGlobally = useCallback((targetNodeId, newNodesPayload, newEdgesPayload = []) => {
    // Snapshot refs at call-time so both state updaters operate on the same
    // consistent view of nodes/edges, avoiding stale-closure bugs in concurrent mode.
    const snapshotNodes = nodesRef.current;
    const snapshotEdges = edgesRef.current;

    // Single deepAddElements call returns both updated nodes AND edges in one tree walk.
    const { updated, nodes: newNodes, edges: newEdges } = deepAddElements(
      snapshotNodes, snapshotEdges, targetNodeId, newNodesPayload, newEdgesPayload
    );

    if (updated) {
      setNodes(newNodes);
      setEdges(newEdges);
    }

    setStack(prevStack => {
      let stackUpdated = false;
      const newStack = prevStack.map(level => {
        const { updated: lu, nodes: newStackNodes, edges: newStackEdges } = deepAddElements(
          level.nodes, level.edges, targetNodeId, newNodesPayload, newEdgesPayload
        );
        if (lu) stackUpdated = true;
        return lu ? { ...level, nodes: newStackNodes, edges: newStackEdges } : level;
      });
      return stackUpdated ? newStack : prevStack;
    });
  }, [setNodes, setEdges]);

  /**
   * Reset the navigation stack entirely (e.g. when loading a new workspace).
   * This ensures we return to root level and discard all stale parent state.
   */
  const resetStack = useCallback(() => {
    setStack([]);
  }, []);

  return {
    diveIn,
    diveOut,
    jumpTo,
    flushStack,
    extractToParent,
    updateNodeDataGlobally,
    addElementsGlobally,
    resetStack,
    breadcrumbs,
    depth,
    isAnimating,
    animPhase,
  };
}
