import { generateId } from './idGenerator.js';

export function sqr(x) { return x * x; }

export function dist2(v, w) { return sqr(v.x - w.x) + sqr(v.y - w.y); }

export function lerpPt(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }

export function distToSegment(p, a, b) {
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
export function segmentCircleIntersections(a, b, C, R) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const fx = a.x - C.x, fy = a.y - C.y;
  const segLen2 = dx * dx + dy * dy;
  if (segLen2 === 0) return [];               // degenerate segment
  const segDot  = 2 * (fx * dx + fy * dy);
  const segConst = fx * fx + fy * fy - R * R;
  const disc = segDot * segDot - 4 * segLen2 * segConst;
  if (disc < 0) return [];
  const sq = Math.sqrt(disc);
  const t1 = (-segDot - sq) / (2 * segLen2);
  const t2 = (-segDot + sq) / (2 * segLen2);
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
export function pixelEraseStroke(stroke, C, R, halfStroke = 0) {
  const pts = Array.isArray(stroke) ? stroke : stroke.points;
  if (!pts || pts.length < 2) return [stroke];

  const result  = [];
  let current   = [];   // points accumulating outside the circle

  const insideCircle = (p) => sqr(p.x - C.x) + sqr(p.y - C.y) <= sqr(R + halfStroke);

  let prevInside = insideCircle(pts[0]);
  if (!prevInside) current.push(pts[0]);

  const strokeId = stroke.id || generateId();

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
        if (current.length >= 2) result.push({ ...stroke, id: `${strokeId}-erased-${generateId()}`, points: current });
        current = [];
      }
      prevInside = bIn;
    } else if (ts.length === 1) {
      // One crossing
      const cross = lerpPt(a, b, ts[0]);
      if (!prevInside) {
        // Going inside: add crossing point, commit sub-stroke
        current.push(cross);
        if (current.length >= 2) result.push({ ...stroke, id: `${strokeId}-erased-${generateId()}`, points: current });
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
      if (current.length >= 2) result.push({ ...stroke, id: `${strokeId}-erased-${generateId()}`, points: current });

      // Start a new sub-stroke from the exit point
      current = [exit, b];
      // prevInside stays false (we entered and exited)
    }
  }

  if (current.length >= 2) result.push({ ...stroke, id: `${strokeId}-erased-${generateId()}`, points: current });
  return result;
}
