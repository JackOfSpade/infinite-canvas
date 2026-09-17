import { JOB_SEARCH_TEST_MODE } from '../../src/utils/jobSourceScope.js';

/**
 * Result-count caps — how many results reach the LLM, and the per-source
 * breadth ceilings, in one place.
 *
 * The LLM-input caps (compsForPricing, jobScoringBatchSize) are the adaptive
 * part: they scale to how many quality results actually exist and stay bounded
 * by the downstream output-token budget. Only the price-synthesis lane is a
 * true mirror: llm.js TASK_MAX_TOKENS['price-synthesis'] imports
 * priceSynthesisMaxTokens() below, so the count fed and the budget granted are
 * derived from the same constants (≈200 tok/comp on a base, 24576 hard cap) and
 * cannot drift. The job-scoring lane's constants are a LOCAL conservative
 * approximation, not shared with llm.js — see JOB_TOKENS_PER_JOB.
 *
 * Job collection breadth is deliberately NOT configured here. It is a persisted
 * per-hub user setting (`collectionLimits`) so a run can be reproduced and does
 * not depend on hidden test/runtime flags. This module owns only LLM budgets.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Single source of truth for the price-synthesis token shape — llm.js
// TASK_MAX_TOKENS['price-synthesis'] imports priceSynthesisMaxTokens() below, so
// the output budget and the comp-count ceiling (MAX_COMPS_BY_BUDGET) are derived
// from the SAME constants and can never drift apart. 200 tok/comp is a
// conservative seed: the manual handoff can land in any chat app the user
// chooses, and different apps vary in how verbose their JSON output is — see
// llm.js for the real-world telemetry behind it.
const PRICE_SYNTH_TOKEN_HARD_CAP = 24576;
const PRICE_BASE_TOKENS          = 3000;
const PRICE_TOKENS_PER_COMP      = 200;
const JOB_BASE_TOKENS            = 2500;
// Local approximation only — llm.js grants job-scoring min(12000, 1600 + n*600),
// which is stricter than these numbers imply, so byOutput below never binds and
// SCORING_BATCH_CEILING is what limits the batch. Re-derive both from llm.js's
// live formula before raising that ceiling, or a bigger batch will silently
// request more output than the model is granted.
const JOB_TOKENS_PER_JOB          = 300;
// Headroom factor for the job-scoring batch budget (jobScoringBatchSize below).
// The comp ceiling no longer applies a safety factor — it's derived exactly from
// priceSynthesisMaxTokens so the count fed and the budget granted stay in lockstep.
const BUDGET_SAFETY         = 0.8;

// ── Compensation-research fit gate ────────────────────────────────────────────
// Minimum matchScore a job must clear before the competitive-pay check runs
// on it. Compensation research is NOT cheap on the manual-handoff transport:
// each cohort (jobs grouped by role/seniority/experience/employment-type/
// location/currency) costs TWO separate copy/paste round trips — one grounded
// market-research prompt plus one assessment prompt — and cohorts fragment by
// the job's own city, so a single multi-employer, multi-city search can
// fragment into dozens of cohorts. Every one of those round trips is a manual
// interruption for the person running the search, so an ungated run could
// demand dozens of handoffs just for compensation research on jobs the user
// was never going to pursue. Gating on fit score keeps the comparison to jobs
// the user could realistically pursue: a competitive-pay verdict only changes
// a decision on a job worth applying to.
export const COMPENSATION_MIN_FIT_SCORE = 70;

// ── LLM scoring budget (how many gathered jobs actually get LLM-scored) ───────
// UNCAPPED (Infinity): score EVERY gathered job. selectTopAcrossSources(_, Infinity)
// returns the whole pool unchanged, so cappedForBudget is always 0. The manual
// handoff transport has no request quota to exhaust, so there is no longer a
// reason to cap this short of the batching/paste effort itself.
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

// Per-job OUTPUT token cost — the budget backstop behind the batch size (it
// must never let a batch request more output than the cap allows). The
// serving model (via the manual handoff) can engage heavy reasoning on this
// task and spend substantial output on the detailed evidence schema, so this
// stays a conservative per-job coefficient. In practice the quality ceiling
// below binds before this budget backstop.
const JOB_OUT_TOKENS_PER_JOB = JOB_TOKENS_PER_JOB;

// How many jobs ride in ONE scoring call. (Unrelated to the retired
// `scoring-batch` hub state — that was the deleted Batch API; this is simply
// how many jobs share a prompt.) This is a SCORING-QUALITY bound, not an
// input-window one: an LLM ranking too many jobs in one shot compresses scores
// and rushes the reasoning, while a bigger batch has a larger truncation blast
// radius. A model can consume substantial hidden output on the detailed
// evidence schema, so 15 is the proven ceiling. Keeping each batch below the
// job-scoring formula's live 12000-token clamp avoids a single oversized
// first batch holding an entire run at 0/M — and since every call is now a
// human copy/paste handoff, each batch is also one dialog the user works
// through, so this doubles as the bound on how much one paste is worth.
const SCORING_BATCH_CEILING = 15;

/**
 * Jobs to score per LLM call. Two binding limits:
 *   1. OUTPUT budget — each job costs ~JOB_OUT_TOKENS_PER_JOB output tokens and
 *      the whole batch must fit the billing-safe output cap (so a call can never
 *      request a budget the model won't honor → no silent truncation).
 *   2. The scoring-QUALITY ceiling (SCORING_BATCH_CEILING).
 * The model's INPUT window is deliberately NOT the driver — it dwarfs even ~50
 * full JDs — but it isn't ignored: the free token-count preflight (scoreBatch /
 * splitBatchesToFitWindow in jobs.js) verifies every REAL batch fits the serving
 * model's window and halves it if a pathological JD set doesn't. So this returns
 * a TARGET; input-safety is guaranteed downstream by the count API.
 */
export function jobScoringBatchSize() {
  const outputCap = PRICE_SYNTH_TOKEN_HARD_CAP;
  const byOutput  = Math.floor((outputCap * BUDGET_SAFETY - JOB_BASE_TOKENS) / JOB_OUT_TOKENS_PER_JOB);
  return clamp(Math.min(byOutput, SCORING_BATCH_CEILING), MIN_SCORING_BATCH, SCORING_BATCH_CEILING);
}

// ── Job-preference listing evaluation budget ──────────────────────────────────
// How many job listings ride in ONE preference-evaluation handoff. Every call
// is a human copy/paste round trip, so the batch size IS the number of times
// the user is interrupted.
//
// The INPUT window is emphatically NOT the bound — slimListing caps each
// listing at 16,000 chars and the models this transport targets have very large
// contexts. The bound is OUTPUT, and it is hard: the model must WRITE one match
// object (outcome + evidence + a verbatim evidenceQuote) for EVERY
// (listing x preference-plan item) pair, so response volume scales with that
// PRODUCT, not with the listing count.
//
// MEASURED, from the 2026-09-16 run's 20 retained handoffs (bug report event
// log, textLength of each pasted response): 10 listings per batch produced
// 33,649–56,038 chars, mean 41,054. At roughly 4 chars/token for this
// English-heavy JSON that is ~10.3k tokens typical and ~14k worst case for TEN
// listings. That is the calibration anchor for LISTING_EVAL_TOKENS_PER_MATCH
// below, and it is why the batch cannot simply be made large: on a 16k-output
// model, ten listings is already close to the ceiling.
//
// LISTING_EVAL_TOKEN_HARD_CAP is the SERVING MODEL'S usable output ceiling, not
// an arbitrary budget. The transport has no cap-raise retry (see llm.js), so a
// batch sized past it does not degrade gracefully — the response is truncated
// mid-JSON and the whole handoff has to be re-pasted. Set for a model with an
// empirically verified 16,384-token output limit, held at 15,360 for margin.
// RAISE THIS when the serving model changes, and the batch size follows
// automatically.
const LISTING_EVAL_TOKEN_HARD_CAP   = 15360;
// Real JSON scaffolding only — `{"assessments":[{"index":N,"matches":[...]}]}`.
// This is NOT a safety cushion (the cushion is the per-listing floor below plus
// the 15,360-of-16,384 margin above); inflating it silently costs listings.
const LISTING_EVAL_BASE_TOKENS      = 256;
// Per (listing x plan item) match object. The schema bounds one match at
// ~1,040 chars (evidence 700 + evidenceQuote 280 + keys/enum) ≈ 260 tokens
// worst case; most rows are `unverified` with the short default evidence, so
// this is the calibrated average.
const LISTING_EVAL_TOKENS_PER_MATCH = 150;
// Per-listing FLOOR, and the safety-critical constant. The per-match term alone
// under-predicts whenever the preference plan is small, because a listing's
// response carries per-row overhead the plan size does not explain. Derived
// from the measurement above: 56,038 chars for 10 listings is 1,303–1,648
// tokens per listing across the plausible 3.4–4.3 chars/token range for this
// content, so 1,500 sits mid-range and is conservative at the ratios that
// actually apply to English-heavy JSON.
//
// Sanity check against reality: (15,360 − 256) / 1,500 = 10 listings, which is
// exactly the batch size whose 20 responses were all accepted without
// truncation in the measured run. The formula reproduces the empirical answer
// rather than contradicting it.
const LISTING_EVAL_TOKENS_PER_LISTING_FLOOR = 1500;
// A floor here must never exceed the budget: with a hard output ceiling and no
// retry, forcing a batch the model cannot finish guarantees truncation. 2 keeps
// a pathological plan from degenerating to one handoff per listing while
// staying affordable at every plan size the budget admits.
const MIN_LISTING_BATCH             = 2;
// Upper bound on one human paste. Even with budget to spare, a single response
// the user has to shuttle between apps should stay reviewable.
const MAX_LISTING_BATCH             = 25;

/** Tokens one listing's response is expected to need, given the plan size. */
function listingEvalTokensPerListing(planItemCount) {
  const items = Number.isFinite(planItemCount) ? Math.max(1, Math.floor(planItemCount)) : 1;
  return Math.max(LISTING_EVAL_TOKENS_PER_LISTING_FLOOR, items * LISTING_EVAL_TOKENS_PER_MATCH);
}

/**
 * Output budget to DECLARE for one preference-evaluation handoff. Takes both
 * axes because they bind at different plan sizes — matches dominate a large
 * plan, the per-listing floor dominates a small one — and the declared budget
 * must match the model the batch size was derived from, or the two drift and
 * the declaration stops being a guard. Always clamped to the serving model's
 * output ceiling.
 */
export function listingEvaluationMaxTokens(matchCount = 10, listingCount = 0) {
  const byMatches = LISTING_EVAL_BASE_TOKENS + Math.max(1, matchCount) * LISTING_EVAL_TOKENS_PER_MATCH;
  const byListings = LISTING_EVAL_BASE_TOKENS
    + Math.max(0, Number.isFinite(listingCount) ? Math.floor(listingCount) : 0) * LISTING_EVAL_TOKENS_PER_LISTING_FLOOR;
  return Math.min(LISTING_EVAL_TOKEN_HARD_CAP, Math.max(byMatches, byListings));
}

export function listingEvaluationBatchSize(planItemCount) {
  const perListing = listingEvalTokensPerListing(planItemCount);
  const affordable = Math.floor((LISTING_EVAL_TOKEN_HARD_CAP - LISTING_EVAL_BASE_TOKENS) / perListing);
  // MIN_LISTING_BATCH may not raise the batch above what the budget affords —
  // that is the one direction the clamp must not go, because exceeding a hard
  // output ceiling truncates the response instead of shrinking the answer.
  return Math.max(1, Math.min(clamp(affordable, MIN_LISTING_BATCH, MAX_LISTING_BATCH), affordable || 1));
}
