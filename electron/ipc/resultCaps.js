import { JOB_SEARCH_TEST_MODE } from '../../src/utils/jobSourceScope.js';
import { modelMeta } from './tokenWindow.js';

/**
 * Result-count caps — how many results reach the LLM, and the per-source
 * breadth ceilings, in one place.
 *
 * The LLM-input caps (compsForPricing, jobScoringBatchSize) are the adaptive
 * part: they scale to how many quality results actually exist and stay bounded
 * by the downstream output-token budget. They mirror llm.js TASK_MAX_TOKENS,
 * whose price-synthesis / job-scoring caps grow ~linearly with item count
 * (≈200 tok/comp, ≈300 tok/job on top of a base) up to a 24576 hard cap — so a
 * comp set / scoring batch can never request a budget the model can't honor.
 * (Coordinates with tokenBudget.js, which self-calibrates that cap on churn.)
 *
 * JOB_RESULT_CAP below is NOT adaptive: an extractor grabs DOM/API matches in
 * document order with no quality signal, and slice() already returns
 * min(available, cap). It's the single source of truth for the Node-side job
 * fetchers (see apiExtractors.js). The marketplace per-source caps remain
 * literal inside their page-context extractor strings (no value in plumbing a
 * constant into ~10 template literals for a fixed breadth ceiling).
 */

// Four named modes — exactly one is true at runtime (fast takes precedence over
// the fullRun medium/full split):
//   FAST_TEST   : 2 queries; browser 2 pages × 5 jobs (=10); API ≤10/source; AI per skipAI
//   MEDIUM_TEST : 5 jobs/page,   10 pages, AI skipped  (quick smoke test)
//   FULL_TEST   : 150 jobs/page, 10 pages, AI per skipAI flag (full pipeline, scoped source)
//   production  : 150 jobs/page, 10 pages, full AI     (all sources)
export const FAST_TEST   = JOB_SEARCH_TEST_MODE.enabled &&  JOB_SEARCH_TEST_MODE.fast;
export const MEDIUM_TEST = JOB_SEARCH_TEST_MODE.enabled && !JOB_SEARCH_TEST_MODE.fast && !JOB_SEARCH_TEST_MODE.fullRun;
export const FULL_TEST   = JOB_SEARCH_TEST_MODE.enabled && !JOB_SEARCH_TEST_MODE.fast &&  JOB_SEARCH_TEST_MODE.fullRun;

// FAST_TEST breadth knobs — kept as named constants so the 10-per-source target
// is traceable: browser 2 pages × 5 jobs, API 2 queries × 5 results. Both types
// land at the same 10/source ceiling.
const FAST_QUERY_CAP     = 2;  // first N generated queries kept (both browser + API)
const FAST_PAGES         = 2;  // browser pages walked per query
const FAST_JOBS_PER_PAGE = 5;  // browser jobs kept per page
const FAST_API_PER_QUERY = 5;  // API results targeted per query (enforced as a per-source total)

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Single source of truth for the price-synthesis token shape — llm.js
// TASK_MAX_TOKENS['price-synthesis'] imports priceSynthesisMaxTokens() below, so
// the output budget and the comp-count ceiling (MAX_COMPS_BY_BUDGET) are derived
// from the SAME constants and can never drift apart. 200 tok/comp is the
// heavy-fallback-model calibration (the binding constraint — the preferred Flash
// model uses ~87/comp); see llm.js for the real-world telemetry behind it.
const TOKEN_HARD_CAP        = 24576;
const PRICE_BASE_TOKENS     = 3000;
const PRICE_TOKENS_PER_COMP = 200;
const JOB_BASE_TOKENS       = 2500;
const JOB_TOKENS_PER_JOB    = 300;
// Headroom factor for the job-scoring batch budget (jobScoringBatchSize below).
// The comp ceiling no longer applies a safety factor — it's derived exactly from
// priceSynthesisMaxTokens so the count fed and the budget granted stay in lockstep.
const BUDGET_SAFETY         = 0.8;

// ── Per-source extractor breadth cap (top-N a single source contributes) ──────
// UNCAPPED (Infinity): every API source returns ALL its in-window matches rather
// than a top-N slice — `slice(0, Infinity)` is a no-op, so each fetcher's existing
// slice line keeps working untouched. Uncapped on purpose while the free Gemini
// tier is being retired; restore a numeric ceiling (was 30) when the paid API tier
// lands and per-source breadth needs bounding again.
export const JOB_RESULT_CAP = Infinity;
// Unified per-page/per-query cap for ALL browser scrapers (manualScraper + indeedBrowser).
// 150 is the scroll-depth target for Google for Jobs and a soft ceiling for Indeed pages
// (which have ~10 jobs/page in practice, so 150 is effectively unlimited in prod).
export const JOB_PER_PAGE_CAP = FAST_TEST ? FAST_JOBS_PER_PAGE : MEDIUM_TEST ? 5 : 150;

// ── Query cap (FAST mode only) ────────────────────────────────────────────────
// First N generated queries kept, applied once in the search-jobs handler so it
// bounds BOTH the browser scrape tasks and the API fan-out. Infinity = no cap.
export const JOB_TEST_QUERY_CAP = FAST_TEST ? FAST_QUERY_CAP : Infinity;

// ── API per-source result cap (FAST mode only) ────────────────────────────────
// Enforced at the fetchApiSources collection point — a single slice per source —
// rather than via JOB_RESULT_CAP, because API fetchers apply that cap
// inconsistently (per-query for the fan-out sources usajobs/dice, whole-feed for
// remoteok/weworkremotely/linkedin/indeed). 10 = FAST_QUERY_CAP × FAST_API_PER_QUERY,
// i.e. "2 queries × 5 each" as a per-source aggregate. Infinity = no cap.
export const JOB_API_PER_SOURCE_CAP = FAST_TEST ? FAST_QUERY_CAP * FAST_API_PER_QUERY : Infinity;

// ── LLM scoring budget (how many gathered jobs actually get LLM-scored) ───────
// UNCAPPED (Infinity): score EVERY gathered job. selectTopAcrossSources(_, Infinity)
// returns the whole pool unchanged, so cappedForBudget is always 0.
// ⚠️ This is deliberately ABOVE what the FREE Gemini tier can sustain — scoring
// hundreds of jobs will rate-limit (429) and fall back to weaker models until the
// paid API tier lands. Restore a numeric budget (was 150, round-robin fair across
// sources via selectTopAcrossSources) when on paid.
// MEDIUM skips AI (0); FAST and FULL both score (Infinity) unless skipAI — in FAST
// the gathered pool is only ~10/source, so Infinity scores that whole small set
// without straining the quota (the whole point of the fast end-to-end smoke).
export const JOB_SCORE_CAP = (MEDIUM_TEST || JOB_SEARCH_TEST_MODE.skipAI) ? 0 : Infinity;

// ── Date-bounded deep pagination ──────────────────────────────────────────────
// Browser sources page forward (same stealth session) until they run out of
// in-window jobs / hit a block, capped by this hard ceiling. Start generous and
// walk DOWN if a source starts getting blocked — volume is the anti-bot trigger,
// not speed, so the ceiling is the real safety knob. The scorer cap (above) still
// bounds how many of the wider pool reach the LLM.
export const JOB_MAX_PAGES = FAST_TEST ? FAST_PAGES : 10;

// ── Price-synthesis output-token budget (single source of truth) ──────────────
/**
 * Output-token budget for the price-synthesis LLM call, sized to the comp count
 * so the model has room to classify every listing (anchor/adjusted/bound)
 * without truncating. llm.js TASK_MAX_TOKENS['price-synthesis'] calls this, and
 * MAX_COMPS_BY_BUDGET below is derived from the SAME formula — so the count we
 * feed can never request a budget the hard cap won't honor.
 */
export function priceSynthesisMaxTokens(itemCount = 40) {
  const n = Math.max(0, Number(itemCount) || 0);
  return Math.min(TOKEN_HARD_CAP, PRICE_BASE_TOKENS + n * PRICE_TOKENS_PER_COMP);
}

// ── LLM-input cap (unbounded: feed all comps, limited only by the token budget) ─
// The largest comp count whose budget still fits UNDER the hard cap — beyond it
// priceSynthesisMaxTokens() clamps and the synthesis could truncate. Derived from
// the same constants as the budget formula, so the count fed and the budget
// granted stay in lockstep no matter how either is tuned.
const MAX_COMPS_BY_BUDGET = Math.floor((TOKEN_HARD_CAP - PRICE_BASE_TOKENS) / PRICE_TOKENS_PER_COMP);

/**
 * How many sold/active comps to feed the price-synthesis LLM. UNBOUNDED: feeds
 * EVERY available comp (the caller pre-sorts by title-match relevance, so the
 * ordering is preserved), limited only by MAX_COMPS_BY_BUDGET — the point past
 * which the token budget would clamp. If the combined set exceeds that ceiling,
 * both sides scale down proportionally so the sold/active mix is preserved.
 * @returns {{ sold:number, active:number }}
 */
export function compsForPricing(soldAvailable = 0, activeAvailable = 0) {
  // Coerce defensively: a non-numeric/NaN count would otherwise propagate to
  // slice(0, NaN) → [] (silently dropping every comp).
  let sold   = Math.max(0, Number(soldAvailable)   || 0);
  let active = Math.max(0, Number(activeAvailable) || 0);
  const total = sold + active;
  if (total > MAX_COMPS_BY_BUDGET && total > 0) {
    const scale = MAX_COMPS_BY_BUDGET / total;
    sold   = Math.floor(sold * scale);
    active = Math.floor(active * scale);
  }
  return { sold, active };
}

const MIN_SCORING_BATCH = 5;

// Per-job OUTPUT token cost by provider family — the budget backstop behind the
// batch size (it must never let a batch request more output than the cap allows).
// Gemini Flash engages heavy thinking on this task (~325 tok/job observed; we
// reuse the calibrated JOB_TOKENS_PER_JOB budget coefficient). Claude emits only
// the visible score+reasoning (~180/job, no separate thinking budget), so more
// fit the same output cap. In practice the per-provider quality ceiling below is
// what binds — both lanes' output-budget max comfortably exceeds it.
const JOB_OUT_TOKENS_PER_JOB = { claude: 200, gemini: JOB_TOKENS_PER_JOB, default: JOB_TOKENS_PER_JOB };

// Per-provider scoring-batch CEILING. This is a SCORING-QUALITY bound, not a
// token one: an LLM ranking too many jobs in one shot compresses scores and
// rushes the reasoning, and a bigger batch has a larger truncation/retry blast
// radius. Gemini stays at the telemetry-calibrated 15; the stronger paid Claude
// path scores more per call (≈2× fewer round-trips on a 500-job run) while
// staying well under the output cap. Tunable.
const SCORING_BATCH_CEILING = { claude: 30, gemini: 15, default: 15 };

/**
 * Jobs to score per LLM call, sized to the model that will actually serve scoring
 * (pass llm.js `modelForTask('job-scoring')`). Two binding limits:
 *   1. OUTPUT budget — each job costs ~JOB_OUT_TOKENS_PER_JOB output tokens and
 *      the whole batch must fit the billing-safe output cap (so a call can never
 *      request a budget the model won't honor → no silent truncation).
 *   2. A per-provider scoring-QUALITY ceiling.
 * The model's INPUT window is deliberately NOT the driver — it dwarfs even ~50
 * full JDs — but it isn't ignored: the free token-count preflight (scoreBatch /
 * splitBatchesToFitWindow in jobs.js) verifies every REAL batch fits the serving
 * model's window and halves it if a pathological JD set doesn't. So this returns
 * a TARGET; input-safety is guaranteed downstream by the count API.
 *
 * @param {string} [model] resolved scoring model id; unknown/missing → safe default
 */
export function jobScoringBatchSize(model) {
  const meta = modelMeta(model);
  // A missing model id → conservative 'default' lane (the small 15 ceiling); a
  // real id trusts its resolved provider. (modelMeta defaults unknowns to claude,
  // so only an absent arg is treated as "don't know".)
  const lane = model ? meta.provider : 'default';
  const perJob  = JOB_OUT_TOKENS_PER_JOB[lane] ?? JOB_OUT_TOKENS_PER_JOB.default;
  const ceiling = SCORING_BATCH_CEILING[lane]  ?? SCORING_BATCH_CEILING.default;
  // Cap output at min(model max, billing hard cap) so big-output models can't
  // request runaway billing; the per-provider ceiling is what binds in practice.
  const outputCap = Math.min(meta.maxOutput || TOKEN_HARD_CAP, TOKEN_HARD_CAP);
  const byOutput  = Math.floor((outputCap * BUDGET_SAFETY - JOB_BASE_TOKENS) / perJob);
  return clamp(Math.min(byOutput, ceiling), MIN_SCORING_BATCH, ceiling);
}
