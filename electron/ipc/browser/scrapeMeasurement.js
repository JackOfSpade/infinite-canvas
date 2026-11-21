/**
 * Measurement seam for in-process scrape A/B harnesses.
 *
 * The 2026-11-20 ZipRecruiter A/B showed that anti-bot "pacing" can cost hours
 * while preventing nothing, and that the browser fingerprint was the real cause
 * of its checks. Re-measuring another board needs the app's REAL walk code with
 * one variable changed at a time, not a re-implementation in a script.
 *
 * Nothing in the app sets these overrides: there is no IPC handler, UI control,
 * persisted setting or environment variable behind them. Only a Node harness
 * that imports this module in-process can change them, and every reader falls
 * back to production behavior when they are unset.
 */
let overrides = null;

/**
 * @param {null | {
 *   fingerprint?: Record<string, { plain: boolean }>,
 *   pacing?: Record<string, 'off' | number>,
 * }} next
 */
export function setScrapeMeasurementOverrides(next) {
  overrides = next ? structuredClone(next) : null;
}

/** Fingerprint override for one source, or null for the production policy. */
export function measurementFingerprintOverride(sourceId) {
  const value = overrides?.fingerprint?.[sourceId];
  return value && typeof value.plain === 'boolean' ? { plain: value.plain } : null;
}

/** True only when a harness switched this source's anti-bot pacing off. */
export function measurementPacingOff(sourceId) {
  return measurementPacingScale(sourceId) === 0;
}

/**
 * Multiplier a harness applies to this source's anti-bot pacing: 0 = off,
 * 0.5 = half, 1 = production (the default when nothing is set).
 */
export function measurementPacingScale(sourceId) {
  const value = overrides?.pacing?.[sourceId];
  if (value === 'off') return 0;
  return Number.isFinite(value) && value >= 0 ? value : 1;
}
