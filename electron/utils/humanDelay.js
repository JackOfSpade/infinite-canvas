/**
 * Log-normal delay multiplier for human-like timing variability.
 *
 * Log-normal fits real human reaction times better than uniform jitter:
 * steep rise (physical minimum), organic long tail, no negative values.
 * sigma=0.22 ≈ ±20% spread at 1 standard deviation — matches click
 * variability measured in the Indeed/Google probe scripts.
 *
 * Usage:
 *   await new Promise(r => setTimeout(r, humanDelay(1500)));  // ~1500ms ± organic spread
 */
export function humanDelay(ms) {
  const u1 = Math.random() || Number.EPSILON;
  const u2 = Math.random();
  const normal    = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const logNormal = Math.exp(normal * 0.22);
  return Math.round(ms * logNormal);
}
