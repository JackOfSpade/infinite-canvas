import { useCallback } from 'react';
import { addEdge, useReactFlow } from '@xyflow/react';
import { setupDragGhost, setupCanvasDragGhost } from '../utils/dragUtils';
import { EDGE_STYLE } from '../utils/constants';

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
  const { getNodes, getEdges } = useReactFlow();

  const onConnect = useCallback((params) => {
    if (isAnimatingRef?.current) return;
    takeSnapshot();
    setEdges((eds) => addEdge({ ...params, animated: true, style: EDGE_STYLE }, eds));
  }, [setEdges, takeSnapshot, isAnimatingRef]);

  const onDragStart = useCallback((e, type) => {
    e.dataTransfer.setData('app/node-type', type);
    e.dataTransfer.effectAllowed = 'copy';
    if (type === 'group') {
      setupCanvasDragGhost(e);
    } else {
      setupDragGhost(e, type === 'text' ? 'text' : 'link', type === 'text' ? 'rgba(255, 255, 255, 0.9)' : 'rgb(96, 165, 250)');
    }
  }, []);

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

    const lockedNodes = getNodes().filter((n) => n.data?.locked);
    const lockedIds = new Set(lockedNodes.map((n) => n.id));
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

  return { onConnect, onDragStart, clearCanvas };
}
