import { useCallback, useEffect, useRef } from 'react';
import { useReactFlow } from '@xyflow/react';
import { NODE_FACTORIES } from '../utils/nodeFactory';
import { distToSegment, pixelEraseStroke, sqr } from '../utils/geometry';

// ────────────────────────────────────────────────────────────────────────────

export function useDrawingMode({
  placementMode,
  setPlacementMode,
  activeTool,
  eraserType,
  eraserSize = 15,
  setDrawings,
  setNodes,
  setEdges,
  takeSnapshot,
  activeColor = 'white',
  penSize = 3,
  getIntersectingNodes,
  isAnimatingRef,
  cursorsRef,
  drawingLayerRef,
  isInteractionRef,
}) {
  const { screenToFlowPosition, getViewport, deleteElements } = useReactFlow();
  const isErasingRef = useRef(false);
  const currentStrokeRef = useRef(null);

  const handleEraser = useCallback((e) => {
    if (isAnimatingRef?.current) return;
    if (isInteractionRef) isInteractionRef.current = true;
    const C     = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const { zoom } = getViewport();
    const R     = eraserSize / zoom;  // convert screen px → flow units

    if (eraserType === 'object') {
      // Delete entire nodes that overlap the eraser circle
      if (getIntersectingNodes) {
        const hit = getIntersectingNodes({
          x: C.x - R, y: C.y - R, width: R * 2, height: R * 2,
        });
        if (hit?.length) {
          const ids = hit.filter(n => !n.data?.locked).map(n => ({ id: n.id }));
          if (ids.length) {
            deleteElements({ nodes: ids });
          }
        }
      }
      // Delete entire strokes that come within the eraser radius
      setDrawings(prev => prev.filter(stroke => {
        const pts = Array.isArray(stroke) ? stroke : stroke.points;
        if (!pts || pts.length < 2) return true;
        for (let i = 0; i < pts.length - 1; i++) {
          if (distToSegment(C, pts[i], pts[i + 1]) <= R) return false;
        }
        return true;
      }));
    } else {
      // Pixel erase: split strokes at the exact circle boundary (no chunk-erasure)
      setDrawings(prev => {
        let changed = false;
        const next = [];
        for (const stroke of prev) {
          const subs = pixelEraseStroke(stroke, C, R, (stroke.penSize || 3) / 2);
          if (subs.length !== 1 || subs[0] !== stroke) changed = true;
          next.push(...subs);
        }
        return changed ? next : prev;
      });
    }
  }, [screenToFlowPosition, getViewport, eraserSize, eraserType, getIntersectingNodes,
      setNodes, setEdges, setDrawings, isAnimatingRef, isInteractionRef]);

  const handlePointerDown = useCallback((e) => {
    if (e.button !== 0) return;
    if (placementMode) {
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      pos.x -= 12; pos.y -= 20;
      takeSnapshot();
      const factory = NODE_FACTORIES[placementMode];
      if (factory) setNodes(nds => nds.concat(factory(pos)));
      setPlacementMode(null);
      return;
    }
    if (activeTool === 'eraser') {
      isErasingRef.current = true;
      takeSnapshot();
      handleEraser(e);
      return;
    }
    if (activeTool === 'pen') {
      if (isInteractionRef) isInteractionRef.current = true;
      const newStroke = [screenToFlowPosition({ x: e.clientX, y: e.clientY })];
      currentStrokeRef.current = newStroke;
      drawingLayerRef.current?.updateCurrentStroke(newStroke);
    }
  }, [placementMode, activeTool, screenToFlowPosition, takeSnapshot,
      setNodes, setPlacementMode, handleEraser, drawingLayerRef, isInteractionRef]);

  const handlePointerMove = useCallback((e) => {
    if (placementMode) {
      cursorsRef.current?.updateMouse({ x: e.clientX, y: e.clientY });
    }

    if (isAnimatingRef?.current) return;

    if (activeTool === 'eraser' && isErasingRef.current) {
      handleEraser(e);
      return;
    }
    if (activeTool === 'pen' && currentStrokeRef.current) {
      const newPt = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const lastPt = currentStrokeRef.current[currentStrokeRef.current.length - 1];
      
      // Only add point if it moved at least 1.5 units (flow space) 
      // or if it's the second point (to ensure we have at least one segment)
      const distSq = lastPt ? (sqr(newPt.x - lastPt.x) + sqr(newPt.y - lastPt.y)) : 100;
      if (distSq > 2.25 || currentStrokeRef.current.length < 2) {
        currentStrokeRef.current.push(newPt);
        drawingLayerRef.current?.updateCurrentStroke([...currentStrokeRef.current]);
      }
    }
  }, [placementMode, activeTool, screenToFlowPosition, cursorsRef, drawingLayerRef, handleEraser, isAnimatingRef]);

  const handlePointerUp = useCallback(() => {
    if (isInteractionRef) isInteractionRef.current = false;
    if (placementMode) return;
    if (activeTool === 'eraser') {
      isErasingRef.current = false;
      return;
    }
    if (activeTool === 'pen' && currentStrokeRef.current?.length > 1) {
      if (!isAnimatingRef?.current) {
        takeSnapshot();
        setDrawings(prev => [...prev, { 
          id: window.crypto.randomUUID(),
          points: currentStrokeRef.current, 
          color: activeColor, 
          penSize 
        }]);
      }
    }
    currentStrokeRef.current = null;
    drawingLayerRef.current?.clearCurrentStroke();
  }, [placementMode, activeTool, takeSnapshot, setDrawings, activeColor, penSize, isAnimatingRef, drawingLayerRef, isInteractionRef]);

  useEffect(() => {
    if (!placementMode) {
      cursorsRef.current?.updateMouse({ x: 0, y: 0 });
      return;
    }
    const onKey = (e) => { if (e.key === 'Escape') setPlacementMode(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [placementMode, setPlacementMode, cursorsRef]);

  return { handlePointerDown, handlePointerMove, handlePointerUp };
}
