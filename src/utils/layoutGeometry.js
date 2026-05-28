import { getNodeDims } from './constants.js';

/**
 * Derived layout & navigation geometry — replaces the scattered hardcoded
 * radii / spacings / durations with values computed from content (child count,
 * card/node size) and travel distance, so layouts scale instead of overlapping
 * or feeling fixed.
 *
 * Everything here is pure (no React, no DOM) so it's trivially testable.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ── Radial hub layouts (JobHub / SellHub source cards) ────────────────────────
// Both hubs fan their source cards around a circle. The radius used to be a
// hand-tuned constant per hub (320 / 260), which OVERLAPS once there are enough
// cards to wrap the circumference. Derive it instead from two constraints:
//   1. no-overlap: the circle's circumference must fit every card (+gap),
//   2. hub-clearance: the ring must sit outside the hub body.
// Taking the max satisfies both and grows automatically with the card count —
// for the current source counts it reproduces ~the old radii, and for many more
// sources it expands rather than letting cards collide.
export const RADIAL_GAP = 28; // min arc/clearance gap between card and neighbours/hub

export function radialRadius({ count, cardW, cardH, hubW, hubH, gap = RADIAL_GAP }) {
  const n = Math.max(1, count || 1);
  const cardSpan = Math.hypot(cardW || 0, cardH || 0); // worst-case footprint along the arc
  // 1) every card (+gap) must fit around the circumference: 2πr ≥ n·(span+gap)
  const rNoOverlap = (n * (cardSpan + gap)) / (2 * Math.PI);
  // 2) the ring must clear the hub body (hub half-diagonal + card half + gap)
  const rClearHub = Math.hypot(hubW || 0, hubH || 0) / 2 + cardSpan / 2 + gap;
  return Math.round(Math.max(rNoOverlap, rClearHub));
}

// ── Animation durations ───────────────────────────────────────────────────────
/**
 * fitView duration scaled mildly by how many items were just framed — more
 * cards = a larger frame to settle into, so a slightly longer tween reads as
 * smoother. Bounded so it never feels sluggish or teleporty.
 */
export function fitViewDuration(itemCount = 0) {
  return clamp(Math.round(450 + (itemCount || 0) * 18), 450, 900);
}

/**
 * Pan/center duration scaled by the on-screen travel distance (px). A near
 * jump snaps; a long glide takes a bit longer so it doesn't feel like a
 * teleport. Bounded at both ends.
 */
export function panDuration(travelPx = 0) {
  return clamp(Math.round(260 + (travelPx || 0) * 0.35), 260, 900);
}

// ── Auto-layout (tidy grid + drop placement) spacing ──────────────────────────
// Spacings used to be flat 40px (grid gutter / collision padding), a 100px
// row-detection threshold, and a 60px spiral step — all independent of node
// size, so they're cramped around big nodes and loose around tiny ones. Derive
// them from a representative node size (median of each node's mean dimension)
// with generous clamps so typical ~180px nodes land near the old values.
function representativeSize(nodes) {
  if (!nodes || nodes.length === 0) return 120;
  const means = nodes.map(n => { const { w, h } = getNodeDims(n); return (w + h) / 2; }).sort((a, b) => a - b);
  return means[Math.floor(means.length / 2)]; // median
}

/** Grid gutter, row-detection threshold, and collision padding derived from node size. */
export function gridSpacing(nodes) {
  const r = representativeSize(nodes);
  return {
    gutter:       clamp(Math.round(r * 0.25), 32, 80),  // gap between grid cells
    rowThreshold: clamp(Math.round(r * 0.6),  40, 160), // Δy below this = same row when sorting
    padding:      clamp(Math.round(r * 0.25), 32, 80),  // clearance vs. existing nodes on drop
  };
}

/** Spiral search start/step for non-overlapping drop placement, scaled to cluster size. */
export function spiralStep(dropWidth, dropHeight) {
  return clamp(Math.round(Math.max(dropWidth || 0, dropHeight || 0) * 0.5), 60, 240);
}

// ── Resize hit-zone (CanvasNode circular sub-canvas) ──────────────────────────
// The rim that activates the resize cursor is measured in SCREEN px against the
// rendered circle (getBoundingClientRect), so a fixed 12px zone is a huge slice
// of a zoomed-out circle and a sliver on a zoomed-in one. Make it a fraction of
// the rendered radius (which already folds in zoom) with sane bounds.
export const EDGE_ZONE_RATIO = 0.15;
export const EDGE_ZONE_MIN = 8;
export const EDGE_ZONE_MAX = 28;

export function edgeZoneForRadius(renderedRadiusPx) {
  return clamp((renderedRadiusPx || 0) * EDGE_ZONE_RATIO, EDGE_ZONE_MIN, EDGE_ZONE_MAX);
}

// ── WASD navigation speed ─────────────────────────────────────────────────────
// Pixels-per-SECOND (not per-frame), so panning feels identical on 60Hz and
// 120Hz+ displays. ~360 px/s ≈ the old 6 px/frame at 60fps.
export const WASD_BASE_SPEED_PX_PER_SEC = 360;
export const WASD_SHIFT_MULTIPLIER = 4;
