/**
 * Persisted per-source "manual-verification" history for the browser-scrape order.
 *
 * Browser job sources scrape one-at-a-time. We want the ones that historically
 * force the USER to manually solve a challenge (captcha / login wall) to run
 * FIRST, so the user clears them up front and can walk away while the rest finish
 * unattended. Each run records, per source, whether it required a manual solve
 * (1) or finished clean (0); an EMA of that drives the next run's order.
 *
 * Own electron-store file ('scrape-verification'), mirroring scrapeBudget.js. The
 * ordering/EMA math lives in src/utils/scrapeOrder.js (pure + unit-tested).
 */
import Store from 'electron-store';
import { foldVerificationSample, orderByVerification, verificationScore } from '../../src/utils/scrapeOrder.js';

// Lazy-init — new Store() needs app.whenReady() (see scrapeBudget.js).
let _store = null;
function getStore() { return _store ??= new Store({ name: 'scrape-verification' }); }
function tryGetStore() { try { return getStore(); } catch { return null; } }
const store = {
  get: (...args) => tryGetStore()?.get(...args),
  set: (...args) => tryGetStore()?.set(...args),
};

function allStats() { return store.get('verification') || {}; }

// ── Per-run manual-solve tracking (in-memory) ───────────────────────────────
// A scrape driver MARKS a source when it pauses for the user to solve a challenge
// (manualScraper's waitForReady). The orchestrator RESETS once at the start of the
// browser phase and RECORDS each source's outcome after it finishes. Indeed never
// waits for the user (it auto-escalates/skips CF), so it simply records `false`.
let manualSolveThisRun = new Set();
export function resetManualSolveTracking() { manualSolveThisRun = new Set(); }
export function markManualSolveRequired(sourceId) { if (sourceId) manualSolveThisRun.add(sourceId); }
export function wasManualSolveRequired(sourceId) { return manualSolveThisRun.has(sourceId); }

// Fold one run's outcome for a source into its EMA. `neededManual` = did this run
// make the user manually solve a challenge for this source.
export function recordVerificationOutcome(sourceId, neededManual) {
  if (!sourceId) return;
  try {
    const all = allStats();
    all[sourceId] = foldVerificationSample(all[sourceId], neededManual);
    store.set('verification', all);
  } catch { /* persistence is best-effort — never break a scrape over it */ }
}

// Reorder `defaultOrder` so manual-prone sources lead (see orderByVerification).
export function orderBrowserSources(defaultOrder) {
  return orderByVerification(defaultOrder, allStats());
}

// For the bug report: per-source {ema, samples, score} so a run's chosen order is
// explainable ("why did Google go first?").
export function getVerificationSnapshot() {
  const all = allStats();
  const out = {};
  for (const [id, s] of Object.entries(all)) {
    out[id] = { ema: s.ema, samples: s.samples, score: verificationScore(s), lastSample: s.lastSample };
  }
  return out;
}
