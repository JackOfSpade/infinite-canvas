import { useState, useCallback, useRef, useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import { getNodeDims, getNodesBounds } from '../utils/constants';

import { safeClone, syncStackUpward, getCanvasData, deepUpdateNode, deepAddElements } from '../utils/navigationUtils';
import { EventLogger } from '../utils/EventLogger';

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
  animationDuration,
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
  const navFramesRef = useRef([]); // All pending requestAnimationFrame IDs
  useEffect(() => {
    return () => {
      // Safety: reset navigation flag and cancel all pending timers to prevent
      // stale state updates if the component is torn down mid-transition.
      isNavigatingRef.current = false;
      navTimersRef.current.forEach(id => clearTimeout(id));
      navTimersRef.current = [];
      navFramesRef.current.forEach(id => cancelAnimationFrame(id));
      navFramesRef.current = [];
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
    if (isNavigatingRef.current) return;
    isNavigatingRef.current = true;

    // Fast fail if node doesn't exist
    const initialNode = reactFlow.getNode(nodeId);
    if (!initialNode || initialNode.type !== 'group') {
      isNavigatingRef.current = false;
      return;
    }

    EventLogger.log(`canvas dive-in id=${nodeId} (depth ${stackRef.current.length} → ${stackRef.current.length + 1})`);

    const halfDuration = animationDuration / 2;

    setIsAnimating(true);
    setAnimPhase('fade-out');

    // After fade-out completes, dynamically read the LATEST state to swap data.
    // This prevents background tasks (file watchers, IPC) from hitting a race condition
    // and overwriting their changes during the fade-out half (halfDuration =
    // animationDuration / 2, i.e. 100/200/300ms by the user's animation setting).
    const t1 = setTimeout(() => {
      navTimersRef.current = navTimersRef.current.filter(id => id !== t1);
      
      // Re-fetch the node from our latest ref to guarantee we capture any IPC updates
      const latestNode = nodesRef.current.find(n => n.id === nodeId);
      if (!latestNode) { 
          // Extremely edge case: node deleted during fade-out by IPC
          setIsAnimating(false); setAnimPhase(null); isNavigatingRef.current = false; 
          return; 
      }
      const canvasData = getCanvasData(latestNode);

      const parentState = {
        nodeId,
        childTitle: latestNode.data.title || 'Sub-Canvas',
        nodes: safeClone(nodesRef.current),
        edges: safeClone(edgesRef.current),
        drawings: safeClone(drawingsRef.current),
        viewport: reactFlow.getViewport(),
      };

      setStack(s => [...s, parentState]);
      setNodes(canvasData.nodes || []);
      setEdges(canvasData.edges || []);
      setDrawings(canvasData.drawings || []);
      clearHistory?.();

      // Let React render the new data, then center and fade in
      const frameId = requestAnimationFrame(() => {
        navFramesRef.current = navFramesRef.current.filter(id => id !== frameId);
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
          const container = viewportNode?.parentElement;
          const flowWidth  = container ? container.clientWidth  : window.innerWidth;
          const flowHeight = container ? container.clientHeight : window.innerHeight;
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
      navFramesRef.current.push(frameId);
    }, halfDuration);
    navTimersRef.current.push(t1);
  }, [reactFlow, animationDuration, setNodes, setEdges, setDrawings, clearHistory]); // isAnimating omitted — isNavigatingRef is the authoritative guard

  /**
   * Jump to a specific breadcrumb level.
   * targetIndex 0 = root, 1 = first sub-canvas, etc.
   * Syncs all intermediate canvas data back through the chain.
   */
  const jumpTo = useCallback((targetIndex) => {
    const currentStack = stackRef.current;
    if (isNavigatingRef.current || targetIndex >= currentStack.length || targetIndex < 0) return;
    isNavigatingRef.current = true;

    EventLogger.log(`canvas dive-out → depth ${targetIndex} (was ${currentStack.length})`);

    const halfDuration = animationDuration / 2;
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

      const frameId = requestAnimationFrame(() => {
        navFramesRef.current = navFramesRef.current.filter(id => id !== frameId);
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
      navFramesRef.current.push(frameId);
    }, halfDuration);
    navTimersRef.current.push(t3);
  }, [reactFlow, animationDuration, setNodes, setEdges, setDrawings, clearHistory]); // isAnimating omitted — isNavigatingRef is the authoritative guard

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
   * Detach one or more nodes (and their internal edges) from the current sub-canvas and move them to a parent canvas depth.
   */
  const extractToLevel = useCallback((nodeIdOrIds, explicitTargetIndex = undefined) => {
    if (isNavigatingRef.current || stackRef.current.length === 0) return;

    const targetIndex = explicitTargetIndex !== undefined ? explicitTargetIndex : stackRef.current.length - 1;
    // Don't extract if the target is the current level or deeper than available stack
    if (targetIndex >= stackRef.current.length || targetIndex < 0) return;

    const ids = Array.isArray(nodeIdOrIds) ? nodeIdOrIds : [nodeIdOrIds];
    
    // Filter out locked nodes - they cannot be extracted
    const nodesToExtract = nodesRef.current.filter(n => ids.includes(n.id) && !n.data?.locked);
    if (nodesToExtract.length === 0) return;

    const finalIds = nodesToExtract.map(n => n.id);

    // Preserve edges that are entirely between the extracted nodes
    const edgesToExtract = edgesRef.current.filter(e => finalIds.includes(e.source) && finalIds.includes(e.target));

    // Remove from current canvas
    setNodes(nds => nds.filter(n => !finalIds.includes(n.id)));
    // Delete any edges connected to the extracted nodes in the current canvas
    setEdges(eds => eds.filter(e => !finalIds.includes(e.source) && !finalIds.includes(e.target)));

    // Clear history to prevent a duplication bug where undoing the extraction 
    // restores the node locally, but it remains injected in the parent stack.
    clearHistory?.();

    // Inject into ancestor's saved state
    setStack(s => {
      if (s.length <= targetIndex) return s;
      
      const newStack = [...s];
      const targetParent = newStack[targetIndex];
      if (!targetParent) return s;

      // The container node inside `targetParent` which the user previously entered, serving as the spatial anchor
      const parentContainer = targetParent.nodes.find(n => n.id === targetParent.nodeId);
      
      // Compute bounding box of extracted nodes to preserve relative layout
      const { minX, maxX, minY, maxY } = getNodesBounds(nodesToExtract);
      const clusterWidth  = Math.max(0, maxX - minX);
      const clusterHeight = Math.max(0, maxY - minY);
      
      // Center the extracted cluster horizontally over the parent container
      const parentWidth = parentContainer?.measured?.width || parseInt(parentContainer?.style?.width) || 160;
      // Guard `position` too, not just `parentContainer`: a stale stack entry can
      // hold an anchor node that lost its position, and `parentContainer?.position.x`
      // only short-circuits on a nullish container — it would still throw on a
      // present-but-position-less node.
      const parentX = parentContainer?.position?.x || 0;

      const basePosX = parentX + (parentWidth / 2) - (clusterWidth / 2);
      // Ensure the bottom edge of the entire cluster rests cleanly above the parent container
      const basePosY = (parentContainer?.position?.y || 100) - clusterHeight - 60;

      const newParentNodes = [...targetParent.nodes];
      nodesToExtract.forEach((nodeToExtract) => {
        const offsetX = nodeToExtract.position.x - minX;
        const offsetY = nodeToExtract.position.y - minY;
        newParentNodes.push({ 
          ...nodeToExtract, 
          position: { x: basePosX + offsetX, y: basePosY + offsetY } 
        });
      });

      const newParentEdges = [...(targetParent.edges || []), ...edgesToExtract];

      newStack[targetIndex] = { ...targetParent, nodes: newParentNodes, edges: newParentEdges };
      return newStack;
    });
  }, [setNodes, setEdges, clearHistory]); // isAnimating omitted — isNavigatingRef is the authoritative guard

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
   * Appends new nodes and edges to the targetNodeId either inside its subcanvas or as siblings.
   * Uses functional updates to safely execute against the active state queue, preserving
   * preceding updates (e.g. removing the dragged node from its old location).
   */
  const addElementsGlobally = useCallback((targetNodeId, newNodesPayload, newEdgesPayload = [], placement = 'inside') => {
    setNodes(prevNodes => {
      const { updated, nodes: newNodes } = deepAddElements(
        prevNodes, edgesRef.current, targetNodeId, newNodesPayload, newEdgesPayload, placement
      );
      return updated ? newNodes : prevNodes;
    });

    // For 'inside' placement: edges are embedded in the target group's data.canvasData,
    // which setNodes already handles above. Only update the root edges array for 'sibling'
    // placement, where newEdgesPayload is appended alongside the target node.
    if (placement === 'sibling' && newEdgesPayload.length > 0) {
      setEdges(prevEdges => {
        const { updated, edges: newEdges } = deepAddElements(
          nodesRef.current, prevEdges, targetNodeId, newNodesPayload, newEdgesPayload, placement
        );
        return updated ? newEdges : prevEdges;
      });
    }

    setStack(prevStack => {
      let stackUpdated = false;
      const newStack = prevStack.map(level => {
        const { updated: lu, nodes: newStackNodes, edges: newStackEdges } = deepAddElements(
          level.nodes, level.edges, targetNodeId, newNodesPayload, newEdgesPayload, placement
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
    extractToParent: extractToLevel,
    updateNodeDataGlobally,
    addElementsGlobally,
    resetStack,
    breadcrumbs,
    depth,
    isAnimating,
    animPhase,
  };
}
