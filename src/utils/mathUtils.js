/**
 * Tiny shared numeric helpers. Pure (no React, no DOM) — trivially testable.
 */

/** Clamp `v` into the inclusive range [lo, hi]. */
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
