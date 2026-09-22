import { JOB_SEARCH_TEST_MODE } from '../../src/utils/jobSourceScope.js';

/**
 * Result-count caps — how many results reach the LLM, and the per-source
 * breadth ceilings, in one place.
 *
 * The LLM-input caps (compsForPricing, jobScoringBatchSize) are the adaptive
 * part: they scale to how many quality results actually exist and stay bounded
 * by the downstream output-token budget. The old singleton price-synthesis
 * formula remains only to reconstruct exact durable handoffs; fresh pricing
 * uses the 15,360-token versioned batch formula below. Job scoring follows the
 * same contract: its fresh batch count and prompt seed come from the one
 * 1,600 + 600/job estimate below, while its retired 15-row contract remains
 * available only to replay an exact durable handoff.
 *
 * Job collection breadth is deliberately NOT configured here. It is a persisted
 * per-hub user setting (`collectionLimits`) so a run can be reproduced and does
 * not depend on hidden test/runtime flags. This module owns only LLM budgets.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Chat-app responses top out at 16,384 output tokens. Keep one Ki-token margin
// for provider/UI variation and size every new multi-item handoff against the
// same usable ceiling.
export const MANUAL_AI_USABLE_OUTPUT_TOKENS = 15360;

// ── Versioned multi-item manual handoff estimates ──────────────────────────
// These return the UNCLAMPED estimate as well as the prompt cap. Packers must
// compare the estimate to the usable ceiling; checking only the clamped cap
// would make an oversized batch look safe after it had already overflowed.
const PRICE_BATCH_BASE_TOKENS = 1024;
const PRICE_BATCH_ITEM_TOKENS = 900;
const PRICE_BATCH_COMP_TOKENS = 200;
export function priceSynthesisBatchEstimatedTokens(itemCount = 1, totalCompCount = 0) {
  const items = Math.max(1, Math.floor(Number(itemCount) || 1));
  const comps = Math.max(0, Math.floor(Number(totalCompCount) || 0));
  return PRICE_BATCH_BASE_TOKENS + items * PRICE_BATCH_ITEM_TOKENS + comps * PRICE_BATCH_COMP_TOKENS;
}
export function priceSynthesisBatchMaxTokens(itemCount = 1, totalCompCount = 0) {
  return Math.min(MANUAL_AI_USABLE_OUTPUT_TOKENS, priceSynthesisBatchEstimatedTokens(itemCount, totalCompCount));
}
export function priceSynthesisBatchFits(itemCount = 1, totalCompCount = 0) {
  return priceSynthesisBatchEstimatedTokens(itemCount, totalCompCount) <= MANUAL_AI_USABLE_OUTPUT_TOKENS;
}
export function priceSynthesisBatchMaxComps(itemCount = 1) {
  const items = Math.max(1, Math.floor(Number(itemCount) || 1));
  return Math.max(0, Math.floor(
    (MANUAL_AI_USABLE_OUTPUT_TOKENS - PRICE_BATCH_BASE_TOKENS - items * PRICE_BATCH_ITEM_TOKENS)
      / PRICE_BATCH_COMP_TOKENS,
  ));
}

const HUB_SCAN_BATCH_BASE_TOKENS = 1024;
const HUB_SCAN_PLATFORM_TOKENS = 2688;
const HUB_SCAN_PAGE_TOKENS = 448;
export function marketplaceHubScanBatchEstimatedTokens(platformCount = 1, urlCount = 1) {
  const platforms = Math.max(1, Math.floor(Number(platformCount) || 1));
  const urls = Math.max(1, Math.floor(Number(urlCount) || 1));
  return HUB_SCAN_BATCH_BASE_TOKENS + platforms * HUB_SCAN_PLATFORM_TOKENS + urls * HUB_SCAN_PAGE_TOKENS;
}
export function marketplaceHubScanBatchMaxTokens(platformCount = 1, urlCount = 1) {
  return Math.min(MANUAL_AI_USABLE_OUTPUT_TOKENS, marketplaceHubScanBatchEstimatedTokens(platformCount, urlCount));
}
export function marketplaceHubScanBatchFits(platformCount = 1, urlCount = 1) {
  return marketplaceHubScanBatchEstimatedTokens(platformCount, urlCount) <= MANUAL_AI_USABLE_OUTPUT_TOKENS;
}
export function marketplaceHubScanMaxPagesForPlatform() {
  return Math.max(1, Math.floor(
    (MANUAL_AI_USABLE_OUTPUT_TOKENS - HUB_SCAN_BATCH_BASE_TOKENS - HUB_SCAN_PLATFORM_TOKENS)
      / HUB_SCAN_PAGE_TOKENS,
  ));
}

// Historical singleton price-synthesis shape. Keep these values stable so an
// exact accepted/pending durable handoff can replay byte-for-byte. Fresh work
// is packed by PRICE_BATCH_* above and never receives this 24,576-token cap.
const PRICE_SYNTH_TOKEN_HARD_CAP = 24576;
const PRICE_BASE_TOKENS          = 3000;
const PRICE_TOKENS_PER_COMP      = 200;

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

// ── Legacy singleton price-synthesis output-token budget ───────────────
/**
 * Historical output-token formula used to reconstruct an exact old durable
 * prompt. Public task routing hard-clamps fresh requests, and production fresh
 * pricing uses priceSynthesisBatchMaxTokens() instead.
 */
export function priceSynthesisMaxTokens(itemCount = 40) {
  const n = Math.max(0, Number(itemCount) || 0);
  return Math.min(PRICE_SYNTH_TOKEN_HARD_CAP, PRICE_BASE_TOKENS + n * PRICE_TOKENS_PER_COMP);
}

// ── Legacy singleton input cap ─────────────────────────────────────────
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

// A score needs a compact evidence-backed JSON row and enough reasoning to
// compare it to the candidate profile.  The fresh packed contract gives the
// fixed response envelope 1,600 tokens and reserves 600 per job.  22 jobs
// estimate to 14,800; 23 would estimate to 15,400 and cross the 15,360 usable
// ceiling, so the packer must stop at 22.
const JOB_SCORING_BASE_TOKENS = 1600;
const JOB_SCORING_TOKENS_PER_JOB = 600;
export const LEGACY_JOB_SCORING_BATCH_SIZE = 15;

export function jobScoringEstimatedTokens(itemCount = 1) {
  const items = Math.max(1, Math.floor(Number(itemCount) || 1));
  return JOB_SCORING_BASE_TOKENS + items * JOB_SCORING_TOKENS_PER_JOB;
}

export function jobScoringMaxTokens(itemCount = 1) {
  return Math.min(MANUAL_AI_USABLE_OUTPUT_TOKENS, jobScoringEstimatedTokens(itemCount));
}

export function jobScoringBatchFits(itemCount = 1) {
  return jobScoringEstimatedTokens(itemCount) <= MANUAL_AI_USABLE_OUTPUT_TOKENS;
}

// The pre-v2 formula and grouping are deliberately retained for an exact
// accepted/pending durable scoring step. Fresh work never uses this cap.
export function legacyJobScoringMaxTokens(itemCount = 1) {
  const items = Math.max(1, Math.floor(Number(itemCount) || 1));
  return Math.min(12000, JOB_SCORING_BASE_TOKENS + items * JOB_SCORING_TOKENS_PER_JOB);
}

/**
 * Jobs to score per fresh LLM call. The count is derived from the same output
 * estimate which appears in the copied prompt, so a full batch is always
 * below the manual transport's 15,360-token usable ceiling.
 * The model's INPUT window is deliberately NOT the driver — it dwarfs even ~50
 * full JDs — but it isn't ignored: the free token-count preflight (scoreBatch /
 * splitBatchesToFitWindow in jobs.js) verifies every REAL batch fits the serving
 * model's window and halves it if a pathological JD set doesn't. So this returns
 * a TARGET; input-safety is guaranteed downstream by the count API.
 */
export function jobScoringBatchSize() {
  return Math.max(1, Math.floor(
    (MANUAL_AI_USABLE_OUTPUT_TOKENS - JOB_SCORING_BASE_TOKENS) / JOB_SCORING_TOKENS_PER_JOB,
  ));
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
// mid-JSON and the whole handoff has to be re-pasted.
//
// Set for ChatGPT's WEB APP, which is what this copy/paste transport actually
// targets, and that distinction is load-bearing: GPT-5.6 Sol's API advertises
// 128,000 max output tokens, but a single response in the chat UI is capped at
// 16,384 regardless of context size — and the chat UI is where these prompts
// are pasted. Sizing to the API number would truncate every batch. Held at
// 15,360 for margin.
// RAISE THIS when the serving transport changes, and the batch size follows
// automatically.
const LISTING_EVAL_TOKEN_HARD_CAP   = 15360;
// Real JSON scaffolding only — `{"assessments":[{"index":N,"matches":[...]}]}`.
// This is NOT a safety cushion (the cushion is the per-listing floor below plus
// the 15,360-of-16,384 margin above); inflating it silently costs listings.
const LISTING_EVAL_BASE_TOKENS      = 256;
// Per (listing x plan item) match object. MEASURED, not derived from the schema
// caps — an earlier version of this constant used the schema worst case (~260
// tokens) discounted to 150, and that was wrong by 3x in the direction that
// hurts: it silently cut batches to 3 for a 32-item plan and TRIPLED the number
// of copy/paste handoffs a run costs (2070 listings became 690 prompts).
//
// The measurement: the run whose 20 responses are recorded in the
// 2026-09-17T01-10 bug report used a 32-item preference plan at 10 listings per
// handoff, so every accepted response contained exactly 10 x 32 = 320 match
// objects (exact, not approximate — validateJobPreferenceListingSubmission
// hard-throws unless a row carries every preference). Those responses were
// 33,649-56,038 chars, so one match is 25-52 tokens across the plausible
// 3.4-4.3 chars/token range. 150 was never within that range.
//
// Why 46 specifically: below the FLOOR crossover (1500 / 32 items = 46.9) the
// per-listing floor governs and any smaller value changes nothing for the one
// plan size we have actually measured. 46 is therefore the LARGEST value that
// still reproduces the batch of 10 whose 20/20 zero-truncation record is the
// real evidence here — maximally conservative for larger, unmeasured plans
// while exactly matching the measured-safe point.
const LISTING_EVAL_TOKENS_PER_MATCH = 46;
// Fixed cost of one listing's response ROW, independent of plan size — the
// wrapper only: `{"index":12,"matches":[ ]},` is about 28 chars, so ~8 tokens.
// Small ON PURPOSE. It is here because a measured per-match rate has this
// overhead amortised into it at whatever plan size it was measured on, so
// applying that rate bare at a much SMALLER plan slightly under-counts the row.
// Being genuinely tiny, that distortion is tiny too — which is the point: it
// means a per-match rate does transfer across plan sizes, and no large
// plan-size-specific floor belongs on the measured path.
const LISTING_EVAL_FIXED_ROW_TOKENS = 10;
// Per-listing FLOOR for the UNCALIBRATED path, and the safety-critical constant. The per-match term alone
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

/**
 * Tokens one listing's response is expected to need.
 *
 * ONE cost model, used by both the batch sizer and the declared output budget —
 * they must agree. When they disagreed, the sizer could shrink a batch for a
 * verbose model while the budget written into the prompt still quoted the old
 * static rate, telling the model to write less than the answer actually needs.
 *
 * Measured rate when calibration has evidence, static estimate otherwise. The
 * fixed row cost is added in BOTH cases: it is the part a per-match rate cannot
 * express, and it is what keeps a rate learned at one plan size from
 * under-counting at another. The uncalibrated path keeps its floor, which was
 * measured at a 32-item plan and is meaningless for a 2-item one — so it is a
 * floor on the STATIC guess only, never on measured evidence.
 */
function listingEvalTokensPerListing(planItemCount, observedTokensPerMatch = null) {
  const items = Number.isFinite(planItemCount) ? Math.max(1, Math.floor(planItemCount)) : 1;
  const measured = Number(observedTokensPerMatch);
  if (Number.isFinite(measured) && measured > 0) {
    // No extra safety multiplier: the margin already lives in the calibration
    // percentile, which sizes on the worst sample until the window is deep
    // enough for an outlier to be identifiable.
    return Math.ceil(LISTING_EVAL_FIXED_ROW_TOKENS + items * measured);
  }
  return Math.max(
    LISTING_EVAL_TOKENS_PER_LISTING_FLOOR,
    LISTING_EVAL_FIXED_ROW_TOKENS + items * LISTING_EVAL_TOKENS_PER_MATCH,
  );
}

/**
 * Output budget to DECLARE for one preference-evaluation handoff. Takes both
 * axes because they bind at different plan sizes — matches dominate a large
 * plan, the per-listing floor dominates a small one — and the declared budget
 * must match the model the batch size was derived from, or the two drift and
 * the declaration stops being a guard. Always clamped to the serving model's
 * output ceiling.
 */
export function listingEvaluationMaxTokens(matchCount = 10, listingCount = 0, { observedTokensPerMatch = null } = {}) {
  const listings = Math.max(0, Number.isFinite(listingCount) ? Math.floor(listingCount) : 0);
  const matches = Math.max(1, Number(matchCount) || 1);
  // Derive the plan size back out of the two counts so the shared per-listing
  // model can be applied; fall back to the match count alone when the caller
  // did not say how many listings it is sending.
  const planItems = listings > 0 ? Math.max(1, Math.round(matches / listings)) : matches;
  const byListings = LISTING_EVAL_BASE_TOKENS
    + Math.max(1, listings) * listingEvalTokensPerListing(planItems, observedTokensPerMatch);
  return Math.min(LISTING_EVAL_TOKEN_HARD_CAP, byListings);
}

export function listingEvaluationBatchSize(planItemCount, { observedTokensPerMatch = null } = {}) {
  // A MEASURED per-match cost beats every static estimate here, and it is the
  // only thing that catches model drift — so when calibration has evidence, it
  // replaces both the per-match constant AND the per-listing floor (the floor
  // exists only to cover what the per-match guess could not see). The static
  // path stays as the cold-start default.
  const perListing = listingEvalTokensPerListing(planItemCount, observedTokensPerMatch);
  const affordable = Math.floor((LISTING_EVAL_TOKEN_HARD_CAP - LISTING_EVAL_BASE_TOKENS) / perListing);
  // MIN_LISTING_BATCH may not raise the batch above what the budget affords —
  // that is the one direction the clamp must not go, because exceeding a hard
  // output ceiling truncates the response instead of shrinking the answer.
  return Math.max(1, Math.min(clamp(affordable, MIN_LISTING_BATCH, MAX_LISTING_BATCH), affordable || 1));
}

// ── Batched company-preference research budgets ─────────────────────────────
// A batch contains small, separately marked web-research sections. The caps
// scale on that section count, not input size: every additional employer needs
// its own sources and facts in the raw phase and one provenance-bearing row in
// the assessment phase.
export function jobPreferenceResearchMaxTokens(itemCount = 1) {
  const n = Math.max(1, Math.floor(Number(itemCount) || 1));
  // Never give a one-item remainder less room than the historical one-company
  // handoff (4096). Extra employers then add bounded headroom of their own.
  return Math.min(MANUAL_AI_USABLE_OUTPUT_TOKENS, 4096 + Math.max(0, n - 1) * 1024);
}

export function jobPreferenceResearchAssessmentMaxTokens(itemCount = 1) {
  const n = Math.max(1, Math.floor(Number(itemCount) || 1));
  // Preserve the legacy structured-assessment floor for a final singleton.
  return Math.min(MANUAL_AI_USABLE_OUTPUT_TOKENS, 2048 + Math.max(0, n - 1) * 512);
}

// ── Batched compensation-assessment budgets ─────────────────────────────────
// One structured cohort row needs its own compact evidence extraction, while
// every listing in that cohort needs one exact indexed verdict.  Keep this
// formula shared by the packer and task cap: a drift here would either waste
// manual handoffs or advertise a response that cannot fit.
export const COMPENSATION_ASSESSMENT_BASE_TOKENS = 1024;
export const COMPENSATION_ASSESSMENT_PER_COHORT_TOKENS = 1400;
export const COMPENSATION_ASSESSMENT_PER_ROW_TOKENS = 650;
// A role-family ladder is a smaller structured result than salary evidence.
// Keep this next to the cohort formula because both share the same manual
// extraction task, but deliberately let its downstream phase pack beyond the
// seven-item grounded-research batch that feeds it.
export const ROLE_FAMILY_ASSESSMENT_BASE_TOKENS = 1024;
export const ROLE_FAMILY_ASSESSMENT_PER_ROLE_TOKENS = 700;
export const MAX_ROLE_FAMILIES_PER_ASSESSMENT = Math.floor(
  (MANUAL_AI_USABLE_OUTPUT_TOKENS - ROLE_FAMILY_ASSESSMENT_BASE_TOKENS)
    / ROLE_FAMILY_ASSESSMENT_PER_ROLE_TOKENS,
);
// Every cohort has at least one listing row, so account for both its compact
// evidence envelope and its required indexed assessment before setting the
// schema/packer ceiling.
export const MAX_COMPENSATION_COHORTS_PER_ASSESSMENT = Math.floor(
  (MANUAL_AI_USABLE_OUTPUT_TOKENS - COMPENSATION_ASSESSMENT_BASE_TOKENS)
    / (COMPENSATION_ASSESSMENT_PER_COHORT_TOKENS + COMPENSATION_ASSESSMENT_PER_ROW_TOKENS),
);

export function roleFamilyAssessmentMaxTokens(roleCount = 1) {
  const roles = Math.max(1, Math.floor(Number(roleCount) || 1));
  return Math.min(
    MANUAL_AI_USABLE_OUTPUT_TOKENS,
    ROLE_FAMILY_ASSESSMENT_BASE_TOKENS + roles * ROLE_FAMILY_ASSESSMENT_PER_ROLE_TOKENS,
  );
}

export function compensationCohortAssessmentMaxTokens(cohortCount = 1, rowCount = 1) {
  const cohorts = Math.max(1, Math.floor(Number(cohortCount) || 1));
  const rows = Math.max(1, Math.floor(Number(rowCount) || 1));
  return Math.min(
    MANUAL_AI_USABLE_OUTPUT_TOKENS,
    COMPENSATION_ASSESSMENT_BASE_TOKENS
      + cohorts * COMPENSATION_ASSESSMENT_PER_COHORT_TOKENS
      + rows * COMPENSATION_ASSESSMENT_PER_ROW_TOKENS,
  );
}

export function compensationCohortAssessmentFits(cohortCount = 1, rowCount = 1) {
  const cohorts = Math.max(1, Math.floor(Number(cohortCount) || 1));
  const rows = Math.max(1, Math.floor(Number(rowCount) || 1));
  return cohorts <= MAX_COMPENSATION_COHORTS_PER_ASSESSMENT
    && COMPENSATION_ASSESSMENT_BASE_TOKENS
      + cohorts * COMPENSATION_ASSESSMENT_PER_COHORT_TOKENS
      + rows * COMPENSATION_ASSESSMENT_PER_ROW_TOKENS <= MANUAL_AI_USABLE_OUTPUT_TOKENS;
}

export const MAX_COMPENSATION_ROWS_PER_ASSESSMENT_COHORT = Math.floor(
  (MANUAL_AI_USABLE_OUTPUT_TOKENS - COMPENSATION_ASSESSMENT_BASE_TOKENS - COMPENSATION_ASSESSMENT_PER_COHORT_TOKENS)
    / COMPENSATION_ASSESSMENT_PER_ROW_TOKENS,
);
