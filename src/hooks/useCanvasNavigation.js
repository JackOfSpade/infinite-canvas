import { useState, useCallback, useRef, useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';

/**
 * Walk the navigation stack upward from `startIndex` to 0, syncing each
 * level's canvas data back into its parent's node tree.
 *
 * Returns the root-level { nodes, edges, drawings }.
 * Pure function — does not mutate state.
 */
function syncStackUpward(currentNodes, currentEdges, currentDrawings, stack, startIndex, stopIndex = 0) {
  let nodes = structuredClone(currentNodes);
  let edges = structuredClone(currentEdges);
  let drawings = structuredClone(currentDrawings);

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
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
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
    if (isAnimating) return;

    const node = reactFlow.getNode(nodeId);
    if (!node || node.type !== 'group') return;

    const canvasData = getCanvasData(node);
    const halfDuration = getAnimationDuration() / 2;

    setIsAnimating(true);
    setAnimPhase('fade-out');

    // Save current state
    const viewport = reactFlow.getViewport();
    const parentState = {
      nodeId,
      childTitle: node.data.title || 'Sub-Canvas',
      nodes: structuredClone(nodesRef.current),
      edges: structuredClone(edgesRef.current),
      drawings: structuredClone(drawingsRef.current),
      viewport,
    };

    // After fade-out completes, swap data
    setTimeout(() => {
      if (!isMountedRef.current) return;
      setStack(s => [...s, parentState]);
      setNodes(canvasData.nodes || []);
      setEdges(canvasData.edges || []);
      setDrawings(canvasData.drawings || []);
      clearHistory?.();

      // Let React render the new data, then center and fade in
      requestAnimationFrame(() => {
        if (!isMountedRef.current) return;
        // Centre on child content at current zoom — never change zoom
        const currentVp = reactFlow.getViewport();
        const childNodes = canvasData.nodes || [];
        if (childNodes.length > 0) {
          let sumX = 0, sumY = 0;
          childNodes.forEach(n => {
            sumX += n.position.x + (n.measured?.width  || 150) / 2;
            sumY += n.position.y + (n.measured?.height ||  50) / 2;
          });
          const cx = sumX / childNodes.length;
          const cy = sumY / childNodes.length;
          reactFlow.setViewport({
            x: window.innerWidth  / 2 - cx * currentVp.zoom,
            y: window.innerHeight / 2 - cy * currentVp.zoom,
            zoom: currentVp.zoom,
          }, { duration: 0 });
        }
        setAnimPhase('fade-in');

        setTimeout(() => {
          if (!isMountedRef.current) return;
          setIsAnimating(false);
          setAnimPhase(null);
        }, halfDuration);
      });
    }, halfDuration);
  }, [isAnimating, reactFlow, getAnimationDuration, setNodes, setEdges, setDrawings, clearHistory]);

  /**
   * Jump to a specific breadcrumb level.
   * targetIndex 0 = root, 1 = first sub-canvas, etc.
   * Syncs all intermediate canvas data back through the chain.
   */
  const jumpTo = useCallback((targetIndex) => {
    const currentStack = stackRef.current;
    if (isAnimating || targetIndex >= currentStack.length) return;

    const halfDuration = getAnimationDuration() / 2;
    setIsAnimating(true);
    setAnimPhase('fade-out');

    setTimeout(() => {
      if (!isMountedRef.current) return;
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
        if (!isMountedRef.current) return;
        reactFlow.setViewport(targetViewport, { duration: 0 });
        setAnimPhase('fade-in');

        setTimeout(() => {
          if (!isMountedRef.current) return;
          setIsAnimating(false);
          setAnimPhase(null);
        }, halfDuration);
      });
    }, halfDuration);
  }, [isAnimating, reactFlow, getAnimationDuration, setNodes, setEdges, setDrawings, clearHistory]);

  /**
   * Dive out one level (back to parent).
   */
  const diveOut = useCallback(() => {
    if (isAnimating || stackRef.current.length === 0) return;
    jumpTo(stackRef.current.length - 1);
  }, [isAnimating, jumpTo]);

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
   * Detach a node from the current sub-canvas and move it to the parent canvas.
   */
  const extractToParent = useCallback((nodeId) => {
    if (stackRef.current.length === 0) return;

    const nodeToExtract = nodesRef.current.find(n => n.id === nodeId);
    if (!nodeToExtract) return;

    // Remove from current canvas
    setNodes(nds => nds.filter(n => n.id !== nodeId));
    setEdges(eds => eds.filter(e => e.source !== nodeId && e.target !== nodeId));

    // Inject into parent's saved state
    setStack(s => {
      const newStack = [...s];
      const parent = newStack[newStack.length - 1];

      // Place near the parent group container, offset by previous extractions to avoid stacking
      const parentContainer = parent.nodes.find(n => n.id === parent.nodeId);
      const extractedCount = parent.nodes.length; // offset by total count to guarantee uniqueness
      const posX = (parentContainer?.position.x || 0) + (extractedCount % 5) * 40;
      const posY = (parentContainer?.position.y || 100) - 150; // offset slightly upward

      const newParentNodes = [
        ...parent.nodes,
        { ...nodeToExtract, position: { x: posX, y: posY } },
      ];

      newStack[newStack.length - 1] = { ...parent, nodes: newParentNodes };
      return newStack;
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
    resetStack,
    breadcrumbs,
    depth,
    isAnimating,
    animPhase,
  };
}
