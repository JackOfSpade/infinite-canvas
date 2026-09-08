import { useState, useCallback, useMemo, useRef, useEffect, useLayoutEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import { getNodeDims, getNodesBounds } from '../utils/constants';

import { safeClone, syncStackUpward, getCanvasData, deepUpdateNode, deepAddElements, collectNodesDeep } from '../utils/navigationUtils';
import { EventLogger } from '../utils/EventLogger';
import { getReactFlowContainerSize } from '../utils/reactFlowDom';

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
  quitGateRef,
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
  const stateSwapRef = useRef(false);
  const navTimersRef = useRef([]); // All pending navigation setTimeout IDs
  const navFramesRef = useRef([]); // All pending requestAnimationFrame IDs

  // Unlike active nodes/edges/drawings, stack state is hidden from React Flow
  // but is still serialized by flushStack. It therefore needs the same quit
  // fence as the Canvas-owned setters; otherwise a late job result could alter
  // a parent canvas while the visible child window is inert.
  const canMutateCanvas = useCallback(() => !quitGateRef?.current?.frozen, [quitGateRef]);
  const setStackGuarded = useCallback((update) => {
    if (!canMutateCanvas()) return false;
    setStack(update);
    return true;
  }, [canMutateCanvas]);

  const freezeForQuit = useCallback(() => {
    isNavigatingRef.current = false;
    navTimersRef.current.forEach(id => clearTimeout(id));
    navTimersRef.current = [];
    navFramesRef.current.forEach(id => cancelAnimationFrame(id));
    navFramesRef.current = [];
    // These are visual-only state transitions. Reset them so a cancelled quit
    // returns to an interactive, non-animating canvas rather than leaving a
    // stale fade overlay after the state fence is released.
    setIsAnimating(false);
    setAnimPhase(null);
  }, []);
  useEffect(() => {
    return () => {
      // Safety: reset navigation flag and cancel all pending timers to prevent
      // stale state updates if the component is torn down mid-transition.
      freezeForQuit();
    };
  }, [freezeForQuit]);

  // flushStack can run from a save shortcut immediately after a visible node
  // update. Layout timing guarantees these refs match that committed render
  // before the user can trigger save.
  useLayoutEffect(() => {
    nodesRef.current = nodes;
    edgesRef.current = edges;
    drawingsRef.current = drawings;
    stackRef.current = stack;
  }, [nodes, edges, drawings, stack]);

  const depth = stack.length;

  // Build breadcrumbs: [Root, ...each level we navigated into]
  // Last entry = current level (not clickable)
  // Memoized on `stack` so its identity is stable across renders that don't
  // touch navigation — see the useMemo around this hook's return value below.
  const breadcrumbs = useMemo(() => [
    { id: 'root', title: 'Main Canvas' },
    ...stack.map(s => ({ id: s.nodeId, title: s.childTitle })),
  ], [stack]);

  /**
   * Dive into a nested canvas node.
   */
  const diveIn = useCallback((nodeId) => {
    if (!canMutateCanvas() || isNavigatingRef.current) return;
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
      if (!canMutateCanvas()) return;
      
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

      stateSwapRef.current = true;
      setStackGuarded(s => [...s, parentState]);
      setNodes(canvasData.nodes || []);
      setEdges(canvasData.edges || []);
      setDrawings(canvasData.drawings || []);
      clearHistory?.();

      // Let React render the new data, then center and fade in
      const frameId = requestAnimationFrame(() => {
        navFramesRef.current = navFramesRef.current.filter(id => id !== frameId);
        if (!canMutateCanvas()) return;
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
          const { width: flowWidth, height: flowHeight } = getReactFlowContainerSize();
          reactFlow.setViewport({
            x: flowWidth / 2 - cx * currentVp.zoom,
            y: flowHeight / 2 - cy * currentVp.zoom,
            zoom: currentVp.zoom,
          }, { duration: 0 });
        }
        setAnimPhase('fade-in');

        const t2 = setTimeout(() => {
          navTimersRef.current = navTimersRef.current.filter(id => id !== t2);
          if (!canMutateCanvas()) return;
          setIsAnimating(false);
          setAnimPhase(null);
          isNavigatingRef.current = false;
        }, halfDuration);
        navTimersRef.current.push(t2);
      });
      navFramesRef.current.push(frameId);
    }, halfDuration);
    navTimersRef.current.push(t1);
  }, [reactFlow, animationDuration, setNodes, setEdges, setDrawings, clearHistory, canMutateCanvas, setStackGuarded]); // isAnimating omitted — isNavigatingRef is the authoritative guard

  /**
   * Jump to a specific breadcrumb level.
   * targetIndex 0 = root, 1 = first sub-canvas, etc.
   * Syncs all intermediate canvas data back through the chain.
   */
  const jumpTo = useCallback((targetIndex) => {
    const currentStack = stackRef.current;
    if (!canMutateCanvas() || isNavigatingRef.current || targetIndex >= currentStack.length || targetIndex < 0) return;
    isNavigatingRef.current = true;

    EventLogger.log(`canvas dive-out → depth ${targetIndex} (was ${currentStack.length})`);

    const halfDuration = animationDuration / 2;
    setIsAnimating(true);
    setAnimPhase('fade-out');

    const t3 = setTimeout(() => {
      navTimersRef.current = navTimersRef.current.filter(id => id !== t3);
      if (!canMutateCanvas()) return;
      const { nodes: cn, edges: ce, drawings: cd } = syncStackUpward(
        nodesRef.current, edgesRef.current, drawingsRef.current,
        currentStack, currentStack.length - 1, targetIndex
      );

      const targetViewport = currentStack[targetIndex].viewport;
      stateSwapRef.current = true;
      setStackGuarded(s => s.slice(0, targetIndex));
      setNodes(cn);
      setEdges(ce);
      setDrawings(cd);
      clearHistory?.();

      const frameId = requestAnimationFrame(() => {
        navFramesRef.current = navFramesRef.current.filter(id => id !== frameId);
        if (!canMutateCanvas()) return;
        reactFlow.setViewport(targetViewport, { duration: 0 });
        setAnimPhase('fade-in');

        const t4 = setTimeout(() => {
          navTimersRef.current = navTimersRef.current.filter(id => id !== t4);
          if (!canMutateCanvas()) return;
          setIsAnimating(false);
          setAnimPhase(null);
          isNavigatingRef.current = false;
        }, halfDuration);
        navTimersRef.current.push(t4);
      });
      navFramesRef.current.push(frameId);
    }, halfDuration);
    navTimersRef.current.push(t3);
  }, [reactFlow, animationDuration, setNodes, setEdges, setDrawings, clearHistory, canMutateCanvas, setStackGuarded]); // isAnimating omitted — isNavigatingRef is the authoritative guard

  /**
   * Dive out one level (back to parent).
   */
  const diveOut = useCallback(() => {
    if (!canMutateCanvas() || isNavigatingRef.current || stackRef.current.length === 0) return;
    jumpTo(stackRef.current.length - 1);
  }, [jumpTo, canMutateCanvas]);

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
   * Read-only global node listing: the active level first (freshest), then
   * each navigation-stack level from deepest to root. Nested group contents
   * are included. Duplicate ids keep their first (freshest) occurrence — a
   * stack level's embedded copy of the branch currently being edited is stale
   * by design and must not shadow the live active-level node. Unlike
   * flushStack this never clones, so it is cheap enough for a poll tick;
   * callers must treat the result as read-only.
   */
  const enumerateAllNodes = useCallback(() => {
    const seen = new Set();
    const out = [];
    collectNodesDeep(nodesRef.current, out, seen);
    const stack = stackRef.current;
    // Each stack entry's `nodeId` is the group the user dived INTO at that
    // level — its embedded canvasData is a snapshot from dive-in time, and the
    // live contents are the next level (or the active arrays). Descending into
    // it would resurrect ghosts of nodes edited or deleted since (e.g. a
    // dismissed job card driven to a full import). List the group node itself,
    // never its stale embedded branch.
    const divedInto = new Set(stack.map((level) => level?.nodeId).filter(Boolean));
    for (let i = stack.length - 1; i >= 0; i--) collectNodesDeep(stack[i]?.nodes, out, seen, divedInto);
    return out;
  }, []);

  /**
   * Detach one or more nodes (and their internal edges) from the current sub-canvas and move them to a parent canvas depth.
   */
  const extractToLevel = useCallback((nodeIdOrIds, explicitTargetIndex = undefined) => {
    if (!canMutateCanvas() || isNavigatingRef.current || stackRef.current.length === 0) return;

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
    setStackGuarded(s => {
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
      const basePosY = (parentContainer?.position?.y ?? 100) - clusterHeight - 60;

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
  }, [setNodes, setEdges, clearHistory, canMutateCanvas, setStackGuarded]); // isAnimating omitted — isNavigatingRef is the authoritative guard

  /**
   * Globally updates a node's data by ID, regardless of whether it is 
   * in the active canvas, hidden in the navigation stack, or deeply 
   * nested inside a group's canvasData.
   */
  const updateNodeDataGlobally = useCallback((nodeId, dataUpdate) => {
    if (!canMutateCanvas()) return false;
    // Always update both active nodes and the stack. deepUpdateNode is a pure function
    // that returns the original array reference unchanged when nothing matches, so
    // calling it on both is safe and avoids the async-flag race condition that existed
    // when reading a flag set inside a React state updater.
    setNodes(prev => {
      const { updated, nodes: newNodes } = deepUpdateNode(prev, nodeId, dataUpdate);
      return updated ? newNodes : prev;
    });

    setStackGuarded(prevStack => {
      let stackUpdated = false;
      const newStack = prevStack.map(level => {
        const { updated, nodes: newNodes } = deepUpdateNode(level.nodes, nodeId, dataUpdate);
        if (updated) stackUpdated = true;
        return updated ? { ...level, nodes: newNodes } : level;
      });
      return stackUpdated ? newStack : prevStack;
    });
    return true;
  }, [setNodes, canMutateCanvas, setStackGuarded]);

  /**
   * Appends new nodes and edges to the targetNodeId either inside its subcanvas or as siblings.
   * Uses functional updates to safely execute against the active state queue, preserving
   * preceding updates (e.g. removing the dragged node from its old location).
   */
  const addElementsGlobally = useCallback((targetNodeId, newNodesPayload, newEdgesPayload = [], placement = 'inside') => {
    if (!canMutateCanvas()) return false;
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

    setStackGuarded(prevStack => {
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
    return true;
  }, [setNodes, setEdges, canMutateCanvas, setStackGuarded]);

  /**
   * Reset the navigation stack entirely (e.g. when loading a new workspace).
   * This ensures we return to root level and discard all stale parent state.
   */
  const resetStack = useCallback(() => {
    if (!canMutateCanvas()) return false;
    setStackGuarded([]);
    return true;
  }, [canMutateCanvas, setStackGuarded]);

  // Memoize the returned object itself. Every piece here is already stable
  // (useCallback-memoized functions, a ref, or primitives/breadcrumbs that only
  // change when navigation actually happens) — without this, Canvas.jsx's own
  // useMemo around CanvasNavigationContext's value is defeated by a brand-new
  // object literal on every call, which re-renders every context consumer
  // (JobCardNode, MarketplaceCardNode, BreadcrumbBar, ...) in lockstep with
  // Canvas.jsx's continuous re-renders during any drag/pan — the render-storm
  // useRenderStorm.js was added to diagnose, not fix.
  return useMemo(() => ({
    diveIn,
    diveOut,
    jumpTo,
    flushStack,
    enumerateAllNodes,
    extractToParent: extractToLevel,
    updateNodeDataGlobally,
    addElementsGlobally,
    resetStack,
    freezeForQuit,
    breadcrumbs,
    depth,
    isAnimating,
    animPhase,
    stateSwapRef,
  }), [
    diveIn, diveOut, jumpTo, flushStack, enumerateAllNodes, extractToLevel,
    updateNodeDataGlobally, addElementsGlobally, resetStack, freezeForQuit,
    breadcrumbs, depth, isAnimating, animPhase, stateSwapRef,
  ]);
}
