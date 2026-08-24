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
 * Job collection breadth is deliberately NOT configured here. It is a persisted
 * per-hub user setting (`collectionLimits`) so a run can be reproduced and does
 * not depend on hidden test/runtime flags. This module owns only LLM budgets.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Single source of truth for the price-synthesis token shape — llm.js
// TASK_MAX_TOKENS['price-synthesis'] imports priceSynthesisMaxTokens() below, so
// the output budget and the comp-count ceiling (MAX_COMPS_BY_BUDGET) are derived
// from the SAME constants and can never drift apart. 200 tok/comp is the
// heavy-fallback-model calibration (the binding constraint — the preferred Flash
// model uses ~87/comp); see llm.js for the real-world telemetry behind it.
const PRICE_SYNTH_TOKEN_HARD_CAP = 24576;
const PRICE_BASE_TOKENS          = 3000;
const PRICE_TOKENS_PER_COMP      = 200;
const JOB_BASE_TOKENS            = 2500;
const JOB_TOKENS_PER_JOB          = 300;
// Headroom factor for the job-scoring batch budget (jobScoringBatchSize below).
// The comp ceiling no longer applies a safety factor — it's derived exactly from
// priceSynthesisMaxTokens so the count fed and the budget granted stay in lockstep.
const BUDGET_SAFETY         = 0.8;

// ── Compensation-research fit gate ────────────────────────────────────────────
// Minimum matchScore a job must clear before the competitive-pay check runs
// on it. Compensation research is NOT cheap: each cohort (jobs grouped by
// role/seniority/experience/employment-type/location/currency) costs TWO LLM
// calls — one grounded market-research call plus one assessment call — and
// cohorts fragment by the job's own city, so a single multi-employer, multi-city
// search can fragment into dozens of cohorts. Every one of those calls starts at
// the SAME shared Gemini ladder head, whose free tier is a flat 20 requests/day
// — so an ungated run can exhaust that quota and starve unrelated scoring/
// bucketing calls in the same run. Gating on fit score keeps the comparison to
// jobs the user could realistically pursue: a competitive-pay verdict only
// changes a decision on a job worth applying to.
export const COMPENSATION_MIN_FIT_SCORE = 75;

// ── LLM scoring budget (how many gathered jobs actually get LLM-scored) ───────
// UNCAPPED (Infinity): score EVERY gathered job. selectTopAcrossSources(_, Infinity)
// returns the whole pool unchanged, so cappedForBudget is always 0.
// ⚠️ This is deliberately ABOVE what the FREE Gemini tier can sustain — scoring
// hundreds of jobs will rate-limit (429) and fall back to weaker models until the
// paid API tier lands. Restore a numeric budget (was 150, round-robin fair across
// sources via selectTopAcrossSources) when on paid.
// Test mode can still skip expensive scoring, but it no longer changes what the
// user asked the collectors to fetch.
export const JOB_SCORE_CAP = JOB_SEARCH_TEST_MODE.skipAI ? 0 : Infinity;

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
  return Math.min(PRICE_SYNTH_TOKEN_HARD_CAP, PRICE_BASE_TOKENS + n * PRICE_TOKENS_PER_COMP);
}

// ── LLM-input cap (unbounded: feed all comps, limited only by the token budget) ─
// The largest comp count whose budget still fits UNDER the hard cap — beyond it
// priceSynthesisMaxTokens() clamps and the synthesis could truncate. Derived from
// the same constants as the budget formula, so the count fed and the budget
// granted stay in lockstep no matter how either is tuned.
const MAX_COMPS_BY_BUDGET = Math.floor((PRICE_SYNTH_TOKEN_HARD_CAP - PRICE_BASE_TOKENS) / PRICE_TOKENS_PER_COMP);

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
  const outputCap = Math.min(meta.maxOutput || PRICE_SYNTH_TOKEN_HARD_CAP, PRICE_SYNTH_TOKEN_HARD_CAP);
  const byOutput  = Math.floor((outputCap * BUDGET_SAFETY - JOB_BASE_TOKENS) / perJob);
  return clamp(Math.min(byOutput, ceiling), MIN_SCORING_BATCH, ceiling);
}
