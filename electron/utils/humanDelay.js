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

/**
 * Like humanDelay, but the result is ALWAYS > ms (strictly greater than the anchor).
 *
 * Uses a folded normal (|N(0,σ)|) so the multiplier is always ≥ 1 — the jitter
 * can only add time, never subtract. Intended for safety-critical cooldowns (e.g.
 * CF escalation backoffs) where falling below the stated minimum would defeat the
 * purpose. Expected multiplier ≈ 1.19 (vs 1.024 for the symmetric variant), so
 * a 5 s anchor yields ~6 s on average with an organic tail, never < 5 s.
 *
 * Usage:
 *   await new Promise(r => setTimeout(r, humanCooldown(5000)));  // always ≥ 5000ms
 */
export function humanCooldown(ms) {
  const u1 = Math.random() || Number.EPSILON;
  const u2 = Math.random();
  const normal    = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const logNormal = Math.exp(Math.abs(normal) * 0.22); // folded: multiplier always ≥ 1
  return Math.round(ms * logNormal);
}
