import { useCallback, useEffect, useRef } from 'react';
import { useReactFlow } from '@xyflow/react';
import { NODE_FACTORIES } from '../utils/nodeFactory';

// ── Geometry helpers ────────────────────────────────────────────────────────
function sqr(x) { return x * x; }
function dist2(v, w) { return sqr(v.x - w.x) + sqr(v.y - w.y); }
function lerpPt(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }

function distToSegment(p, a, b) {
  const l2 = dist2(a, b);
  if (l2 === 0) return Math.sqrt(dist2(p, a));
  const t = Math.max(0, Math.min(1,
    ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2
  ));
  return Math.sqrt(dist2(p, lerpPt(a, b, t)));
}

/**
 * Line-circle intersection: returns sorted t-values in [0,1] where the segment
 * a→b intersects the circle at centre C with radius R.
 * Returns [] if no intersection, [t1] if tangent, [t1, t2] if two crossings.
 */
function segmentCircleIntersections(a, b, C, R) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const fx = a.x - C.x, fy = a.y - C.y;
  const A_ = dx * dx + dy * dy;
  if (A_ === 0) return [];               // degenerate segment
  const B_ = 2 * (fx * dx + fy * dy);
  const C_ = fx * fx + fy * fy - R * R;
  const disc = B_ * B_ - 4 * A_ * C_;
  if (disc < 0) return [];
  const sq = Math.sqrt(disc);
  const t1 = (-B_ - sq) / (2 * A_);
  const t2 = (-B_ + sq) / (2 * A_);
  const ts = [];
  if (t1 >= 0 && t1 <= 1) ts.push(t1);
  if (t2 >= 0 && t2 <= 1 && Math.abs(t2 - t1) > 1e-6) ts.push(t2);
  return ts.sort((a, b) => a - b);
}

/**
 * Pixel-erase a single stroke against the eraser circle at C with radius R.
 * Uses true line-circle intersections so erasure is continuous (not chunk-like).
 * Returns an array of sub-strokes (each is { ...stroke, points: [...] }).
 */
function pixelEraseStroke(stroke, C, R, halfStroke = 0) {
  const pts = Array.isArray(stroke) ? stroke : stroke.points;
  if (!pts || pts.length < 2) return [stroke];

  const result  = [];
  let current   = [];   // points accumulating outside the circle

  const insideCircle = (p) => sqr(p.x - C.x) + sqr(p.y - C.y) <= sqr(R + halfStroke);

  let prevInside = insideCircle(pts[0]);
  if (!prevInside) current.push(pts[0]);

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const ts = segmentCircleIntersections(a, b, C, R + halfStroke);

    if (ts.length === 0) {
      // Segment entirely inside or entirely outside
      const bIn = insideCircle(b);
      if (!bIn) {
        current.push(b);
      } else {
        // Entering or staying inside — commit current sub-stroke
        if (current.length >= 2) result.push({ ...stroke, points: current });
        current = [];
      }
      prevInside = bIn;
    } else if (ts.length === 1) {
      // One crossing
      const cross = lerpPt(a, b, ts[0]);
      if (!prevInside) {
        // Going inside: add crossing point, commit sub-stroke
        current.push(cross);
        if (current.length >= 2) result.push({ ...stroke, points: current });
        current = [];
      } else {
        // Coming out: start new sub-stroke from crossing
        current = [cross, b];
      }
      prevInside = !prevInside;
    } else {
      // Two crossings: segment enters and exits the eraser circle
      const enter = lerpPt(a, b, ts[0]);
      const exit  = lerpPt(a, b, ts[1]);

      // End the current sub-stroke at the entry point
      current.push(enter);
      if (current.length >= 2) result.push({ ...stroke, points: current });

      // Start a new sub-stroke from the exit point
      current = [exit, b];
      // prevInside stays false (we entered and exited)
    }
  }

  if (current.length >= 2) result.push({ ...stroke, points: current });
  return result;
}

// ────────────────────────────────────────────────────────────────────────────

export function useDrawingMode({
  placementMode,
  setPlacementMode,
  activeTool,
  eraserType,
  eraserSize = 15,
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
  getIntersectingNodes,
}) {
  const { screenToFlowPosition, getViewport } = useReactFlow();
  const isErasingRef = useRef(false);

  const handleEraser = useCallback((e) => {
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
          const ids = new Set(hit.filter(n => !n.data?.locked).map(n => n.id));
          if (ids.size) {
            setNodes(nds => nds.filter(n => !ids.has(n.id)));
            setEdges?.(eds => eds.filter(e => !ids.has(e.source) && !ids.has(e.target)));
          }
        }
      }
      // Delete entire strokes that come within the eraser radius
      setDrawings(prev => prev.filter(stroke => {
        const pts = Array.isArray(stroke) ? stroke : stroke.points;
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
      setNodes, setEdges, setDrawings]);

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
      setCurrentStroke([screenToFlowPosition({ x: e.clientX, y: e.clientY })]);
    }
  }, [placementMode, activeTool, screenToFlowPosition, takeSnapshot,
      setNodes, setPlacementMode, setCurrentStroke, handleEraser]);

  const handlePointerMove = useCallback((e) => {
    // Always update mousePos — so placement ghost is at cursor immediately on mode activation
    setMousePos({ x: e.clientX, y: e.clientY });

    if (activeTool === 'eraser' && isErasingRef.current) {
      handleEraser(e);
      return;
    }
    if (activeTool === 'pen' && currentStroke) {
      setCurrentStroke(prev => [...prev, screenToFlowPosition({ x: e.clientX, y: e.clientY })]);
    }
  }, [activeTool, currentStroke, screenToFlowPosition,
      setMousePos, setCurrentStroke, handleEraser]);

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
  }, [placementMode, activeTool, currentStroke, takeSnapshot,
      setDrawings, setCurrentStroke, activeColor, penSize]);

  useEffect(() => {
    if (!placementMode) return;
    const onKey = (e) => { if (e.key === 'Escape') setPlacementMode(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [placementMode, setPlacementMode]);

  return { handlePointerDown, handlePointerMove, handlePointerUp };
}
