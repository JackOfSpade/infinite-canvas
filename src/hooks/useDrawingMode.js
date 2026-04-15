import { useCallback, useEffect, useRef } from 'react';
import { useReactFlow } from '@xyflow/react';
import { NODE_FACTORIES } from '../utils/nodeFactory';

// Geometry utils for eraser
function sqr(x) { return x * x; }
function dist2(v, w) { return sqr(v.x - w.x) + sqr(v.y - w.y); }
function distToSegmentSquared(p, v, w) {
  const l2 = dist2(v, w);
  if (l2 === 0) return dist2(p, v);
  let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
  t = Math.max(0, Math.min(1, t));
  return dist2(p, { x: v.x + t * (w.x - v.x), y: v.y + t * (w.y - v.y) });
}
function distanceToSegment(p, v, w) {
  return Math.sqrt(distToSegmentSquared(p, v, w));
}

export function useDrawingMode({
  placementMode,
  setPlacementMode,
  activeTool,       // 'pen' | 'eraser' | null
  eraserType,       // 'object' | 'pixel'
  eraserSize = 15,  // radius in flow-space pixels
  currentStroke,
  setCurrentStroke,
  setMousePos,
  setEraserScreenPos,
  setDrawings,
  setNodes,
  setEdges,
  takeSnapshot,
  activeColor = 'white',
  penSize = 3,
  getIntersectingNodes
}) {
  const { screenToFlowPosition, getViewport } = useReactFlow();
  const isErasingRef = useRef(false);

  const handleEraser = useCallback((e) => {
    const mousePos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    // Convert screen-space eraserSize into flow-space radius using current zoom
    const { zoom } = getViewport();
    const flowRadius = eraserSize / zoom;

    if (eraserType === 'object') {
      // 1. Delete nodes
      if (getIntersectingNodes) {
        const nodesHit = getIntersectingNodes({
          x: mousePos.x - flowRadius, y: mousePos.y - flowRadius,
          width: flowRadius * 2, height: flowRadius * 2
        });
        if (nodesHit && nodesHit.length > 0) {
          const hitIds = new Set(nodesHit.filter(n => !n.data?.locked).map(n => n.id));
          if (hitIds.size > 0) {
            setNodes(nds => nds.filter(n => !hitIds.has(n.id)));
            if (setEdges) setEdges(eds => eds.filter(e => !hitIds.has(e.source) && !hitIds.has(e.target)));
          }
        }
      }

      // 2. Delete full drawings
      setDrawings(prev => prev.filter(stroke => {
        const pts = Array.isArray(stroke) ? stroke : stroke.points;
        for (let i = 0; i < pts.length - 1; i++) {
          if (distanceToSegment(mousePos, pts[i], pts[i + 1]) <= flowRadius) {
            return false; // Remove this stroke entirely
          }
        }
        return true;
      }));
    } else if (eraserType === 'pixel') {
      // Split intersecting drawings at the erased segment
      setDrawings(prev => {
        let newDrawings = [];
        let changed = false;
        for (const stroke of prev) {
          let currentPart = [];
          const pts = Array.isArray(stroke) ? stroke : stroke.points;
          let i = 0;
          while (i < pts.length - 1) {
            const p1 = pts[i];
            const p2 = pts[i + 1];
            if (distanceToSegment(mousePos, p1, p2) <= flowRadius) {
              changed = true;
              if (currentPart.length > 0) {
                currentPart.push(p1);
                newDrawings.push({ ...stroke, points: currentPart });
                currentPart = [];
              }
            } else {
              currentPart.push(p1);
            }
            i++;
          }
          if (currentPart.length > 0) {
            currentPart.push(pts[pts.length - 1]);
            newDrawings.push({ ...stroke, points: currentPart });
          }
        }
        return changed ? newDrawings : prev;
      });
    }
  }, [screenToFlowPosition, getViewport, eraserSize, eraserType, getIntersectingNodes, setNodes, setEdges, setDrawings]);

  const handlePointerDown = useCallback((e) => {
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
      setCurrentStroke([screenToFlowPosition({ x: e.clientX, y: e.clientY })]);
    }
  }, [placementMode, activeTool, screenToFlowPosition, takeSnapshot, setNodes, setPlacementMode, setCurrentStroke, handleEraser]);

  const handlePointerMove = useCallback((e) => {
    if (placementMode) setMousePos({ x: e.clientX, y: e.clientY });

    if (activeTool === 'eraser' && isErasingRef.current) {
      handleEraser(e);
      return;
    }

    if (activeTool === 'pen' && currentStroke) {
      setCurrentStroke(prev => [...prev, screenToFlowPosition({ x: e.clientX, y: e.clientY })]);
    }
  }, [placementMode, activeTool, currentStroke, screenToFlowPosition, setMousePos, setCurrentStroke, handleEraser]);

  const handlePointerUp = useCallback(() => {
    if (placementMode) return;

    if (activeTool === 'eraser') {
      isErasingRef.current = false;
      return;
    }

    if (activeTool === 'pen' && currentStroke?.length > 1) {
      takeSnapshot();
      setDrawings(prev => [...prev, { points: currentStroke, color: activeColor, penSize }]);
    }
    setCurrentStroke(null);
  }, [placementMode, activeTool, currentStroke, takeSnapshot, setDrawings, setCurrentStroke, activeColor, penSize]);

  useEffect(() => {
    if (!placementMode) return;
    const handleKey = (e) => { if (e.key === 'Escape') setPlacementMode(null); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [placementMode, setPlacementMode]);

  return { handlePointerDown, handlePointerMove, handlePointerUp };
}
