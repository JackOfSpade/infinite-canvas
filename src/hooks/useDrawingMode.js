import { useCallback, useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import { v4 as uuidv4 } from 'uuid';

export function useDrawingMode({
  placementMode,
  setPlacementMode,
  isDrawingMode,
  currentStroke,
  setCurrentStroke,
  setMousePos,
  setDrawings,
  setNodes,
  takeSnapshot
}) {
  const { screenToFlowPosition } = useReactFlow();

  const handlePointerDown = useCallback((e) => {
    if (placementMode) {
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      pos.x -= 12; pos.y -= 20;
      takeSnapshot();
      if (placementMode === 'text') {
        setNodes(nds => nds.concat({ id: uuidv4(), type: 'text', position: pos, data: { text: '', isNew: true } }));
      } else if (placementMode === 'link') {
        setNodes(nds => nds.concat({ id: uuidv4(), type: 'link', position: pos, data: { url: '', label: '', isNew: true } }));
      } else if (placementMode === 'group') {
        setNodes(nds => nds.concat({ id: uuidv4(), type: 'group', dragHandle: '.drag-handle', style: { width: 320 }, position: pos, data: { title: '', items: [], collapsed: false, isNew: true } }));
      }
      setPlacementMode(null);
      return;
    }
    if (!isDrawingMode) return;
    setCurrentStroke([screenToFlowPosition({ x: e.clientX, y: e.clientY })]);
  }, [placementMode, isDrawingMode, screenToFlowPosition, takeSnapshot, setNodes, setPlacementMode, setCurrentStroke]);

  const handlePointerMove = useCallback((e) => {
    if (placementMode) setMousePos({ x: e.clientX, y: e.clientY });
    if (!isDrawingMode || !currentStroke) return;
    setCurrentStroke(prev => [...prev, screenToFlowPosition({ x: e.clientX, y: e.clientY })]);
  }, [placementMode, isDrawingMode, currentStroke, screenToFlowPosition, setMousePos, setCurrentStroke]);

  const handlePointerUp = useCallback(() => {
    if (placementMode || !isDrawingMode) return;
    if (currentStroke?.length > 1) {
      takeSnapshot();
      setDrawings(prev => [...prev, currentStroke]);
    }
    setCurrentStroke(null);
  }, [placementMode, isDrawingMode, currentStroke, takeSnapshot, setDrawings, setCurrentStroke]);

  useEffect(() => {
    if (!placementMode) return;
    const handleKey = (e) => { if (e.key === 'Escape') setPlacementMode(null); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [placementMode, setPlacementMode]);

  return { handlePointerDown, handlePointerMove, handlePointerUp };
}
