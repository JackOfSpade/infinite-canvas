import { useCallback } from 'react';
import { addEdge } from '@xyflow/react';
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
}) {
  const onConnect = useCallback((params) => {
    takeSnapshot();
    setEdges((eds) => addEdge({ ...params, animated: true, style: EDGE_STYLE }, eds));
  }, [setEdges, takeSnapshot]);

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
    takeSnapshot();
    setNodes([]);
    setEdges([]);
    setDrawings([]);
    setCurrentFile(null);
    setHasUnsavedChanges(false);
  }, [takeSnapshot, setNodes, setEdges, setDrawings, setCurrentFile, setHasUnsavedChanges]);

  const clearCanvas = useCallback(() => {
    if (requestClearConfirm) {
      requestClearConfirm(doClear);
    } else {
      doClear();
    }
  }, [requestClearConfirm, doClear]);

  return { onConnect, onDragStart, clearCanvas };
}
