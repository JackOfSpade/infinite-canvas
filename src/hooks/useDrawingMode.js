import { useCallback, useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import { createTextNode, createLinkNode, createGroupNode } from '../utils/nodeFactory';

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
      const factories = { text: createTextNode, link: createLinkNode, group: createGroupNode };
      const factory = factories[placementMode];
      if (factory) setNodes(nds => nds.concat(factory(pos)));
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
