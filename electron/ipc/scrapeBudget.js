/**
 * Adaptive scrape budgets + readiness-loop tuning — single source of truth.
 *
 * Background: the scrape pipeline used to guess "how long to wait for a page"
 * with a per-source fixed settle (`waitMs`) and a per-source hard `timeoutMs`.
 * The settle was replaced by a dynamic loop that polls the extractor and waits
 * for its item COUNT to stabilize (see browserPool.executeScrape and
 * authWindows' captcha-resolve path). This module finishes that job:
 *
 *   1. It LEARNS each source's typical time-to-ready (an EMA of how long the
 *      readiness loop actually takes to settle on a positive item count, or —
 *      for the API path — observed fetch latency) and derives the working hard
 *      timeout from that, instead of a static guess.
 *   2. It owns the readiness-loop detection constants so browserPool and
 *      authWindows can't drift apart.
 *
 * Safety contract (do NOT regress the "extracted 0 / scrape timed out" fix):
 * the configured per-source value is treated as an ABSOLUTE CEILING / seed.
 * A learned budget can only ever be *tighter* than the seed, never looser, and
 * never below MIN_BUDGET_MS. So a source that historically settles fast gets a
 * snappier failure timeout, while a genuinely slow source keeps its full
 * configured budget. A hung page always still aborts at (at most) the seed.
 *
 * Budgets persist across runs in their own electron-store file ('scrape-budgets'),
 * separate from user settings.
 */
import Store from 'electron-store';
import { logger } from '../logger.js';
import { humanDelay } from '../utils/humanDelay.js';

// Lazy-initialized — new Store() calls app.getPath('userData') which requires
// app.whenReady(). Module-level init runs before that, causing the v11 error.
let _store = null;
function getStore() { return _store ??= new Store({ name: 'scrape-budgets' }); }
function tryGetStore() {
  try {
    return getStore();
  } catch {
    return null;
  }
}
const store = {
  get: (...args) => tryGetStore()?.get(...args),
  set: (...args) => tryGetStore()?.set(...args),
};

// ── Budget derivation knobs ──────────────────────────────────────────────────
const EMA_ALPHA = 0.3;            // weight of the newest sample in the moving average
const SAFETY_MULT = 3;            // budget ≈ SAFETY_MULT × typical time-to-ready …
const SAFETY_MARGIN_MS = 8000;    // … plus fixed headroom for cold starts / jitter
const MIN_BUDGET_MS = 18000;      // never fail faster than this (nav + detection overhead)
const MIN_SAMPLES = 5;            // trust the EMA only after this many clean samples
const FIRST_BEAT_RATIO = 0.15;    // initial human-like pause ≈ this × typical time-to-ready

// ── Readiness-loop detection constants (shared) ───────────────────────────────
// These govern stability *detection*, not content-guessing. Shared by both the
// in-page readiness loop (browserPool) and the captcha inline-extract loop
// (authWindows) so the two stay in lockstep. The headroom values are carved out
// of the (possibly learned) hard timeout — see resolveBudget consumers.
export const READINESS = {
  POLL_MS:               600,   // gap between extractor reads (in-page loop)
  CAPTCHA_POLL_MS:       400,   // snappier cadence for post-solve detection
  STABLE_READS:          2,     // unchanged positive count this many reads → settled
  MAX_ZERO_READS:        6,     // consecutive 0-item reads → accept empty
  FIRST_BEAT_MIN_MS:     300,   // floor for the pre-first-read human beat
  FIRST_BEAT_MAX_MS:     1200,  // cap for that beat
  CEILING_MS:            20000, // authWindows: hard cap after the anti-bot gate clears
  BODY_TEXT_GATE:        1500,  // authWindows: "page has real content" gate (no-extractor sources)
  SELECTOR_WAIT_MS:      8000,  // max wait for an optional `waitFor` selector
  NAV_HEADROOM_MS:       5000,  // page.goto() gets (budget − this)
  DEFAULT_NAV_HEADROOM_MS: 2000,// setDefaultNavigationTimeout gets (budget − this)
  READINESS_HEADROOM_MS: 6000,  // readiness loop stops this long before the hard timeout
};

// ── Persistence helpers ───────────────────────────────────────────────────────
function allStats() {
  return store.get('budgets') || {};
}

function statsFor(key) {
  if (!key) return null;
  return allStats()[key] || null;
}

function writeStats(key, stats) {
  const all = allStats();
  all[key] = stats;
  store.set('budgets', all);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve the working hard-timeout for a source from its learned history.
 *
 * @param {string} key            stable source id (e.g. 'ebay-sold', 'indeed', 'linkedin-api')
 * @param {number} seedTimeoutMs  the configured timeout — treated as the ABSOLUTE ceiling
 * @returns {{ timeoutMs:number, firstBeatMs:number, learned:boolean }}
 */
export function resolveBudget(key, seedTimeoutMs) {
  const seed = Number(seedTimeoutMs) > 0 ? Math.round(Number(seedTimeoutMs)) : 30000;
  const stats = statsFor(key);

  if (!stats || stats.samples < MIN_SAMPLES || !(stats.ema > 0)) {
    return { timeoutMs: seed, firstBeatMs: READINESS.FIRST_BEAT_MIN_MS, learned: false };
  }

  const learnedBudget = Math.max(MIN_BUDGET_MS, Math.round(stats.ema * SAFETY_MULT + SAFETY_MARGIN_MS));
  // The seed is the ABSOLUTE ceiling: never produce a budget above it, even if
  // the MIN_BUDGET_MS floor would otherwise push past a small seed (e.g. an
  // API source with an 8s seed). min() last guarantees timeoutMs ≤ seed always.
  const timeoutMs = Math.min(seed, learnedBudget);
  const calculatedBeat = Math.max(
    READINESS.FIRST_BEAT_MIN_MS,
    Math.min(Math.round(stats.ema * FIRST_BEAT_RATIO), READINESS.FIRST_BEAT_MAX_MS),
  );
  const firstBeatMs = Math.max(
    READINESS.FIRST_BEAT_MIN_MS,
    Math.min(humanDelay(calculatedBeat), READINESS.FIRST_BEAT_MAX_MS),
  );
  return { timeoutMs, firstBeatMs, learned: true };
}

/**
 * Record one clean "time to ready" sample. Call ONLY for healthy outcomes:
 * a positive-count stabilization (browser path) or a successful fetch+parse
 * (API path). Do NOT call for empty/blocked/timed-out/ceiling-hit outcomes —
 * the EMA must track how long *success* takes, not how long blocks stall.
 *
 * @param {string} key        stable source id
 * @param {number} elapsedMs  wall-clock ms from start to ready
 */
export function recordReady(key, elapsedMs) {
  if (!key || !(elapsedMs > 0)) return;
  const prev = statsFor(key);
  const ema = prev?.ema > 0
    ? prev.ema * (1 - EMA_ALPHA) + elapsedMs * EMA_ALPHA
    : elapsedMs;
  const samples = (prev?.samples || 0) + 1;
  // Spread prev so body-size fields (and vice-versa) survive a timing write.
  writeStats(key, { ...(prev || {}), ema: Math.round(ema), samples, last: Math.round(elapsedMs), updated: Date.now() });

  // Log the transition from "seeded" to "learned" once, so the budget system
  // leaves a diagnostic trail in bug reports without spamming every scrape.
  if (samples === MIN_SAMPLES) {
    logger.info(`[ScrapeBudget] '${key}' now learned: ema=${Math.round(ema)}ms over ${samples} samples`);
  }
}

// ── Per-source response-body baseline ─────────────────────────────────────────
// A learned "typical good-response body size" per source. The anti-bot detector
// uses it to flag a response as a soft block when its body is anomalously small
// *relative to this source* — far more robust than a flat byte threshold (which
// both false-positives on small-but-real pages and misses larger styled block
// pages). Recorded ONLY on clean successes (items extracted, no block warning)
// so the baseline reflects healthy responses, not block skeletons.
const BODY_EMA_ALPHA = 0.2;   // slower than timing — page weight is fairly stable
const MIN_BODY_SAMPLES = 3;   // require a few clean reads before trusting it

/** Record a clean response's body size (chars). */
export function recordBodySize(key, bytes) {
  if (!key || !(bytes > 0)) return;
  const prev = statsFor(key);
  const bodyEma = prev?.bodyEma > 0
    ? prev.bodyEma * (1 - BODY_EMA_ALPHA) + bytes * BODY_EMA_ALPHA
    : bytes;
  const bodySamples = (prev?.bodySamples || 0) + 1;
  writeStats(key, { ...(prev || {}), bodyEma: Math.round(bodyEma), bodySamples, bodyUpdated: Date.now() });
}

/**
 * Typical good-response body size (chars) for a source, or 0 if we don't yet
 * have enough samples to trust it (caller should fall back to an absolute floor).
 */
export function getBodyBaseline(key) {
  const s = statsFor(key);
  if (!s || (s.bodySamples || 0) < MIN_BODY_SAMPLES || !(s.bodyEma > 0)) return 0;
  return s.bodyEma;
}

/** Diagnostic snapshot for bug reports / debugging. Returns a plain object. */
export function getBudgetSnapshot() {
  return allStats();
}
