import { useCallback } from 'react';
import { addEdge, useReactFlow } from '@xyflow/react';
import { setupDragGhost, setupCanvasDragGhost } from '../utils/dragUtils';
import { EDGE_STYLE } from '../utils/constants';
import { cloneNode, reassignCanvasDataIDs } from '../utils/nodeFactory';
import { EventLogger } from '../utils/EventLogger';

export function useCanvasActions({
  setNodes,
  setEdges,
  setDrawings,
  setCurrentFile,
  setHasUnsavedChanges,
  takeSnapshot,
  requestClearConfirm,
  resetStack,
  depth,
  isAnimatingRef,
}) {
  const { getNodes, getEdges, setEdges: rfSetEdges } = useReactFlow();

  const onConnect = useCallback((params) => {
    if (isAnimatingRef?.current) return;

    const targetNode = getNodes().find(n => n.id === params.target);
    if (targetNode?.data?.isSticky) {
      return;
    }

    takeSnapshot();
    setEdges((eds) => addEdge({ ...params, animated: true, style: EDGE_STYLE }, eds));
  }, [setEdges, takeSnapshot, isAnimatingRef, getNodes]);

  const onDragStart = useCallback((e, type) => {
    e.dataTransfer.setData('app/node-type', type);
    e.dataTransfer.effectAllowed = 'copy';
    if (type === 'group') {
      setupCanvasDragGhost(e);
    } else {
      setupDragGhost(e, type === 'text' ? 'text' : 'link', type === 'text' ? 'rgba(255, 255, 255, 0.9)' : 'rgb(96, 165, 250)');
    }
  }, []);

  const duplicateNodes = useCallback((nodesToDuplicate) => {
    if (!nodesToDuplicate || nodesToDuplicate.length === 0) return;
    takeSnapshot?.();
    
    const oldIdToNewId = new Map();
    const newNodes = nodesToDuplicate.map(original => {
      let clone = cloneNode(original);
      oldIdToNewId.set(original.id, clone.id);
      clone = reassignCanvasDataIDs(clone);
      return clone;
    });

    const newEdges = [];
    getEdges().forEach(eEdge => {
      if (oldIdToNewId.has(eEdge.source) && oldIdToNewId.has(eEdge.target)) {
        newEdges.push({
          ...eEdge,
          id: crypto.randomUUID(),
          source: oldIdToNewId.get(eEdge.source),
          target: oldIdToNewId.get(eEdge.target),
          selected: true,
        });
      }
    });

    setNodes(nds => {
      const unselected = nds.map(n => ({ ...n, selected: false }));
      return unselected.concat(newNodes);
    });
    
    if (newEdges.length > 0) {
      rfSetEdges(eds => {
        const unselected = eds.map(edge => ({ ...edge, selected: false }));
        return unselected.concat(newEdges);
      });
    }

    EventLogger.log(`Duplicated ${newNodes.length} nodes and ${newEdges.length} edges`);
  }, [takeSnapshot, getEdges, setNodes, rfSetEdges]);

  const doClear = useCallback(() => {
    if (isAnimatingRef?.current) return;
    takeSnapshot();

    // If we're nested, we only clear the current canvas level (this is fully undoable).
    // If we're at the root level, we also reset the file association because it's effectively a "New Workspace".
    if (depth === 0) {
      resetStack?.();
      setCurrentFile(null);
      setHasUnsavedChanges(false);
    }

    const allNodes = getNodes();
    const lockedNodes = allNodes.filter((n) => n.data?.locked);
    const lockedIds = new Set(lockedNodes.map((n) => n.id));

    // Cancel any active background tasks for nodes being removed
    if (window.electronAPI?.cancelNodeTask) {
      const cancelRecursively = (nodes) => {
        nodes.forEach(n => {
          if (!lockedIds.has(n.id)) {
            window.electronAPI.cancelNodeTask(n.id);
            if (n.data?.canvasData?.nodes) {
              cancelRecursively(n.data.canvasData.nodes);
            }
            if (n.data?.nodes) {
              cancelRecursively(n.data.nodes);
            }
          }
        });
      };
      cancelRecursively(allNodes);
    }

    const lockedEdges = getEdges().filter(
      (e) => lockedIds.has(e.source) && lockedIds.has(e.target)
    );

    setNodes(lockedNodes);
    setEdges(lockedEdges);
    setDrawings([]);
  }, [takeSnapshot, resetStack, depth, setNodes, setEdges, setDrawings, setCurrentFile, setHasUnsavedChanges, isAnimatingRef, getNodes, getEdges]);

  const clearCanvas = useCallback(() => {
    if (requestClearConfirm) {
      requestClearConfirm(doClear);
    } else {
      doClear();
    }
  }, [requestClearConfirm, doClear]);

  return { onConnect, onDragStart, clearCanvas, duplicateNodes };
}
