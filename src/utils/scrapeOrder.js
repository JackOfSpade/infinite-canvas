// Pure, dependency-free helpers for the browser-scrape "manual-verification-first"
// ordering. Browser job sources are scraped one-at-a-time; we want the ones that
// historically force the USER to solve a challenge (captcha / login wall) to run
// FIRST, so they can clear them up front and walk away while the rest finish
// unattended.
//
// The persisted per-source stats live in electron/ipc/scrapeVerification.js
// (which needs electron-store); the math lives here so it's testable in plain Node.

const VERIFICATION_EMA_ALPHA = 0.3;  // weight of the newest run (matches scrapeBudget)
const VERIFICATION_MIN_SAMPLES = 2;   // need 2 runs of data before reordering off the default

// Fold a single run's 0/1 "did this source make the user manually solve something?"
// into a source's running stats (EMA + sample count). Returns the new stats object.
export function foldVerificationSample(prev, neededManual, alpha = VERIFICATION_EMA_ALPHA) {
  const sample = neededManual ? 1 : 0;
  const prior = prev && Number.isFinite(prev.ema) ? prev.ema : null;
  const ema = prior == null ? sample : prior + alpha * (sample - prior);
  return { ema, samples: (prev?.samples || 0) + 1, lastSample: sample, lastAt: Date.now() };
}

// Score a source for ordering: its manual-solve EMA once we have enough samples to
// trust it, else 0 (neutral — keeps it in its default slot behind manual-prone ones).
export function verificationScore(stats, minSamples = VERIFICATION_MIN_SAMPLES) {
  if (!stats || (stats.samples || 0) < minSamples || !Number.isFinite(stats.ema)) return 0;
  return stats.ema;
}

// Order `defaultOrder` so sources that recently required a manual solve come FIRST,
// most-frequent first. Sources with no trusted data (or that never need solving)
// keep their default-order position behind the manual-prone ones. Stable: equal
// scores preserve `defaultOrder` (so the first run, with no data, is unchanged).
export function orderByVerification(defaultOrder, statsMap, { minSamples = VERIFICATION_MIN_SAMPLES } = {}) {
  const ids = Array.isArray(defaultOrder) ? defaultOrder.filter(Boolean) : [];
  return ids
    .map((id, i) => ({ id, i, score: verificationScore(statsMap?.[id], minSamples) }))
    .sort((a, b) => (b.score - a.score) || (a.i - b.i)) // desc score; ties keep default order
    .map((x) => x.id);
}
