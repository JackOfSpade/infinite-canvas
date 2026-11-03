import { JOB_SEARCH_TEST_MODE } from '../../src/utils/jobSourceScope.js';

/**
 * Result-count caps — how many results reach the LLM, and the per-source
 * breadth ceilings, in one place.
 *
 * The LLM-input cap (jobScoringBatchSize) is the adaptive part: it scales to
 * how many quality results actually exist and stays bounded by the downstream
 * output-token budget. Pricing uses the versioned batch formula below, sized
 * against BATCH_OUTPUT_TOKEN_BUDGET. Job scoring follows the same contract: its fresh batch count and
 * prompt seed come from the one 1,600 + 600/job estimate below, while its
 * retired 15-row contract remains available only to replay an exact durable
 * handoff.
 *
 * Job collection breadth is deliberately NOT configured here. It is a persisted
 * per-hub user setting (`collectionLimits`) so a run can be reproduced and does
 * not depend on hidden test/runtime flags. This module owns only LLM budgets.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// The output size every multi-item batch is sized against. Anthropic's official
// model overview (platform.claude.com/docs/en/models/overview) gives the latest
// Haiku, Sonnet and Opus models a 128,000-token maximum output per call. This is
// that limit minus the same 1,024-token margin the budget always kept, and every
// batch-size formula below derives from it.
export const BATCH_OUTPUT_TOKEN_BUDGET = 128000 - 1024;

// The career clean layer keeps a 4/5 share of the budget, leaving room for its
// per-row framing.
export const CAREER_CLEAN_BUDGET_SHARE_NUMERATOR = 4;
export const CAREER_CLEAN_BUDGET_SHARE_DENOMINATOR = 5;
export const CAREER_CLEAN_RESPONSE_TOKEN_LIMIT = Math.floor(
  BATCH_OUTPUT_TOKEN_BUDGET * CAREER_CLEAN_BUDGET_SHARE_NUMERATOR / CAREER_CLEAN_BUDGET_SHARE_DENOMINATOR,
);

// ── Versioned multi-item handoff estimates ──────────────────────────
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
  return Math.min(BATCH_OUTPUT_TOKEN_BUDGET, priceSynthesisBatchEstimatedTokens(itemCount, totalCompCount));
}
export function priceSynthesisBatchFits(itemCount = 1, totalCompCount = 0) {
  return priceSynthesisBatchEstimatedTokens(itemCount, totalCompCount) <= BATCH_OUTPUT_TOKEN_BUDGET;
}
export function priceSynthesisBatchMaxComps(itemCount = 1) {
  const items = Math.max(1, Math.floor(Number(itemCount) || 1));
  return Math.max(0, Math.floor(
    (BATCH_OUTPUT_TOKEN_BUDGET - PRICE_BATCH_BASE_TOKENS - items * PRICE_BATCH_ITEM_TOKENS)
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
  return Math.min(BATCH_OUTPUT_TOKEN_BUDGET, marketplaceHubScanBatchEstimatedTokens(platformCount, urlCount));
}
export function marketplaceHubScanBatchFits(platformCount = 1, urlCount = 1) {
  return marketplaceHubScanBatchEstimatedTokens(platformCount, urlCount) <= BATCH_OUTPUT_TOKEN_BUDGET;
}
export function marketplaceHubScanMaxPagesForPlatform() {
  return Math.max(1, Math.floor(
    (BATCH_OUTPUT_TOKEN_BUDGET - HUB_SCAN_BATCH_BASE_TOKENS - HUB_SCAN_PLATFORM_TOKENS)
      / HUB_SCAN_PAGE_TOKENS,
  ));
}
// Ordinary platforms (two pages each) per hub scan call, from the same
// per-platform and per-page arithmetic as the estimate above.
const HUB_SCAN_ORDINARY_PAGES_PER_PLATFORM = 2;
export function marketplaceHubScanMaxPlatformsPerBatch() {
  return Math.max(1, Math.floor(
    (BATCH_OUTPUT_TOKEN_BUDGET - HUB_SCAN_BATCH_BASE_TOKENS)
      / (HUB_SCAN_PLATFORM_TOKENS + HUB_SCAN_ORDINARY_PAGES_PER_PLATFORM * HUB_SCAN_PAGE_TOKENS),
  ));
}

// ── Compensation-research fit gate ────────────────────────────────────────────
// Minimum matchScore a job must clear before the competitive-pay check runs
// on it. Compensation research is NOT cheap: each cohort (jobs grouped by
// role/seniority/experience/employment-type/location/currency) costs TWO
// separate handoffs — one grounded market-research prompt plus one assessment
// prompt — and cohorts fragment by the job's own city, so a single
// multi-employer, multi-city search can fragment into dozens of cohorts. An
// ungated run could spend dozens of model calls just for compensation
// research on jobs the user was never going to pursue. Gating on fit score keeps the comparison to jobs
// the user could realistically pursue: a competitive-pay verdict only changes
// a decision on a job worth applying to.
// The same bar now covers every automatic AI or web task after scoring (researchGate.js).
export const RESEARCH_MIN_FIT_SCORE = 70;

// ── LLM scoring budget (how many gathered jobs actually get LLM-scored) ───────
// UNCAPPED (Infinity): score EVERY gathered job. selectTopAcrossSources(_, Infinity)
// returns the whole pool unchanged, so cappedForBudget is always 0. There is no
// request quota to exhaust, so there is no longer a reason to cap this.
// Test mode can still skip expensive scoring, but it no longer changes what the
// user asked the collectors to fetch.
export const JOB_SCORE_CAP = JOB_SEARCH_TEST_MODE.skipAI ? 0 : Infinity;

// A whole-record score includes four evidence-backed strengths, the COMPLETE
// professional-gap inventory, confidence and optional tenure/pay context. The
// former 600-token allowance could not reliably fit that audit and packed 22
// jobs into one response. Reserve 2,800 tokens per job plus framing; a batch
// holds as many jobs as fit BATCH_OUTPUT_TOKEN_BUDGET.
const JOB_SCORING_BASE_TOKENS = 1600;
const JOB_SCORING_TOKENS_PER_JOB = 2800;
const LEGACY_JOB_SCORING_TOKENS_PER_JOB = 600;
export const LEGACY_JOB_SCORING_BATCH_SIZE = 15;

export function jobScoringEstimatedTokens(itemCount = 1) {
  const items = Math.max(1, Math.floor(Number(itemCount) || 1));
  return JOB_SCORING_BASE_TOKENS + items * JOB_SCORING_TOKENS_PER_JOB;
}

export function jobScoringMaxTokens(itemCount = 1) {
  return Math.min(BATCH_OUTPUT_TOKEN_BUDGET, jobScoringEstimatedTokens(itemCount));
}

export function jobScoringBatchFits(itemCount = 1) {
  return jobScoringEstimatedTokens(itemCount) <= BATCH_OUTPUT_TOKEN_BUDGET;
}

// The pre-v2 formula and grouping are deliberately retained for an exact
// accepted/pending durable scoring step. Fresh work never uses this cap.
export function legacyJobScoringMaxTokens(itemCount = 1) {
  const items = Math.max(1, Math.floor(Number(itemCount) || 1));
  return Math.min(12000, JOB_SCORING_BASE_TOKENS + items * LEGACY_JOB_SCORING_TOKENS_PER_JOB);
}

/**
 * Jobs to score per fresh LLM call. The count is derived from the same output
 * estimate which appears in the copied prompt, so a full batch is always
 * within BATCH_OUTPUT_TOKEN_BUDGET.
 * The model's INPUT window is deliberately NOT the driver — it dwarfs even ~50
 * full JDs — but it isn't ignored: the free token-count preflight (scoreBatch /
 * splitBatchesToFitWindow in jobs.js) verifies every REAL batch fits the serving
 * model's window and halves it if a pathological JD set doesn't. So this returns
 * a TARGET; input-safety is guaranteed downstream by the count API.
 */
export function jobScoringBatchSize() {
  return Math.max(1, Math.floor(
    (BATCH_OUTPUT_TOKEN_BUDGET - JOB_SCORING_BASE_TOKENS) / JOB_SCORING_TOKENS_PER_JOB,
  ));
}

// ── Job-preference listing evaluation budget ──────────────────────────────────
// How many job listings ride in ONE preference-evaluation handoff, which sets
// how many handoffs a run costs.
//
// The INPUT window is emphatically NOT the bound — slimListing caps each
// listing at 16,000 chars and the model's context is very large. The bound is
// the OUTPUT budget below: the model must WRITE one match
// object (outcome + evidence + a verbatim evidenceQuote) for EVERY
// (listing x preference-plan item) pair, so response volume scales with that
// PRODUCT, not with the listing count.
//
// MEASURED, from the 2026-09-16 run's 20 retained handoffs (bug report event
// log, textLength of each pasted response): 10 listings per batch produced
// 33,649–56,038 chars, mean 41,054. At roughly 4 chars/token for this
// English-heavy JSON that is ~10.3k tokens typical and ~14k worst case for TEN
// listings. That is the calibration anchor for LISTING_EVAL_TOKENS_PER_MATCH
// below. Ten listings of 32-item plans measured ~14k tokens worst case, and 10
// is the batch size whose quality was tested.
//
// LISTING_EVAL_TOKEN_HARD_CAP is the output budget the batch size is derived
// from (the shared batch budget). With the full Claude output limit the budget
// no longer binds first at typical plan sizes; MAX_LISTING_BATCH below does.
const LISTING_EVAL_TOKEN_HARD_CAP   = BATCH_OUTPUT_TOKEN_BUDGET;
// Real JSON scaffolding only — `{"assessments":[{"index":N,"matches":[...]}]}`.
// This is NOT a safety cushion (the cushion is the per-listing floor below plus
// the budget margin above); inflating it silently costs listings.
const LISTING_EVAL_BASE_TOKENS      = 256;
// Per (listing x plan item) match object. MEASURED, not derived from the schema
// caps — an earlier version of this constant used the schema worst case (~260
// tokens) discounted to 150, and that was wrong by 3x in the direction that
// hurts: it silently cut batches to 3 for a 32-item plan and TRIPLED the number
// of handoffs a run costs (2070 listings became 690 prompts).
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
// Small ON PURPOSE: the measured per-match rate has this overhead amortised
// into it at the plan size it was measured on.
const LISTING_EVAL_FIXED_ROW_TOKENS = 10;
// Per-listing FLOOR, and the safety-critical constant. The per-match term alone
// under-predicts whenever the preference plan is small, because a listing's
// response carries per-row overhead the plan size does not explain. Derived
// from the measurement above: 56,038 chars for 10 listings is 1,303–1,648
// tokens per listing across the plausible 3.4–4.3 chars/token range for this
// content, so 1,500 sits mid-range and is conservative at the ratios that
// actually apply to English-heavy JSON.
//
// The per-listing cost is a token estimate for sizing and for the declared
// output budget; it is independent of how large the budget is.
const LISTING_EVAL_TOKENS_PER_LISTING_FLOOR = 1500;
// A floor here must never exceed the budget: forcing a batch past the output
// budget risks a truncated reply. 2 keeps
// a pathological plan from degenerating to one handoff per listing while
// staying affordable at every plan size the budget admits.
const MIN_LISTING_BATCH             = 2;
// Upper bound on one batch. This is a separate reason from the output cap: even
// with budget to spare, one reply covers at most 25 listings so a failed or
// incomplete reply costs a bounded re-ask.
export const MAX_LISTING_BATCH      = 25;

/**
 * Tokens one listing's response is expected to need.
 *
 * ONE cost model, used by both the batch sizer and the declared output budget —
 * they must agree. When they disagreed, the sizer could shrink a batch for a
 * verbose model while the budget written into the prompt still quoted the old
 * static rate, telling the model to write less than the answer actually needs.
 *
 * A pure function of the plan size: the larger of the per-listing floor and
 * the fixed row cost plus the per-match estimate for every plan item.
 */
function listingEvalTokensPerListing(planItemCount) {
  const items = Number.isFinite(planItemCount) ? Math.max(1, Math.floor(planItemCount)) : 1;
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
export function listingEvaluationMaxTokens(matchCount = 10, listingCount = 0) {
  const listings = Math.max(0, Number.isFinite(listingCount) ? Math.floor(listingCount) : 0);
  const matches = Math.max(1, Number(matchCount) || 1);
  // Derive the plan size back out of the two counts so the shared per-listing
  // model can be applied; fall back to the match count alone when the caller
  // did not say how many listings it is sending.
  const planItems = listings > 0 ? Math.max(1, Math.round(matches / listings)) : matches;
  const byListings = LISTING_EVAL_BASE_TOKENS
    + Math.max(1, listings) * listingEvalTokensPerListing(planItems);
  return Math.min(LISTING_EVAL_TOKEN_HARD_CAP, byListings);
}

export function listingEvaluationBatchSize(planItemCount) {
  const perListing = listingEvalTokensPerListing(planItemCount);
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
// Never give a one-item remainder less than a 4096-token floor. Extra
// employers then add bounded headroom of their own.
const JOB_PREFERENCE_RESEARCH_FLOOR_TOKENS = 4096;
const JOB_PREFERENCE_RESEARCH_EXTRA_ITEM_TOKENS = 1024;
// Keep a 2048-token floor for a final singleton.
const JOB_PREFERENCE_ASSESSMENT_FLOOR_TOKENS = 2048;
const JOB_PREFERENCE_ASSESSMENT_EXTRA_ITEM_TOKENS = 512;
// The most employers one research / assessment call can carry within the budget.
export const JOB_PREFERENCE_RESEARCH_MAX_ITEMS = Math.floor(
  (BATCH_OUTPUT_TOKEN_BUDGET - JOB_PREFERENCE_RESEARCH_FLOOR_TOKENS) / JOB_PREFERENCE_RESEARCH_EXTRA_ITEM_TOKENS,
) + 1;
export const JOB_PREFERENCE_RESEARCH_ASSESSMENT_MAX_ITEMS = Math.floor(
  (BATCH_OUTPUT_TOKEN_BUDGET - JOB_PREFERENCE_ASSESSMENT_FLOOR_TOKENS) / JOB_PREFERENCE_ASSESSMENT_EXTRA_ITEM_TOKENS,
) + 1;

export function jobPreferenceResearchMaxTokens(itemCount = 1) {
  const n = Math.max(1, Math.floor(Number(itemCount) || 1));
  return Math.min(
    BATCH_OUTPUT_TOKEN_BUDGET,
    JOB_PREFERENCE_RESEARCH_FLOOR_TOKENS + Math.max(0, n - 1) * JOB_PREFERENCE_RESEARCH_EXTRA_ITEM_TOKENS,
  );
}

export function jobPreferenceResearchAssessmentMaxTokens(itemCount = 1) {
  const n = Math.max(1, Math.floor(Number(itemCount) || 1));
  return Math.min(
    BATCH_OUTPUT_TOKEN_BUDGET,
    JOB_PREFERENCE_ASSESSMENT_FLOOR_TOKENS + Math.max(0, n - 1) * JOB_PREFERENCE_ASSESSMENT_EXTRA_ITEM_TOKENS,
  );
}

// ── Role screen rows ────────────────────────────────────────────────────────
// 1,024 base + 48 tokens per terse verdict row.
export const ROLE_SCREEN_BASE_TOKENS = 1024;
export const ROLE_SCREEN_ROW_TOKENS = 48;
export const ROLE_SCREEN_MAX_ROWS = Math.floor(
  (BATCH_OUTPUT_TOKEN_BUDGET - ROLE_SCREEN_BASE_TOKENS) / ROLE_SCREEN_ROW_TOKENS,
);

// ── Batched compensation-assessment budgets ─────────────────────────────────
// One structured cohort row needs its own compact evidence extraction, while
// every listing in that cohort needs one exact indexed verdict.  Keep this
// formula shared by the packer and task cap: a drift here would either waste
// handoffs or advertise a response that cannot fit.
export const COMPENSATION_ASSESSMENT_BASE_TOKENS = 1024;
export const COMPENSATION_ASSESSMENT_PER_COHORT_TOKENS = 1400;
// Each listing now includes a career-grounded application range, a rounded
// desired salary and a brief explanation alongside its market evidence.
export const COMPENSATION_ASSESSMENT_PER_ROW_TOKENS = 1200;
// A role-family ladder is a smaller structured result than salary evidence.
// Keep this next to the cohort formula because both share the same
// extraction task, but deliberately let its downstream phase pack beyond the
// seven-item grounded-research batch that feeds it.
export const ROLE_FAMILY_ASSESSMENT_BASE_TOKENS = 1024;
export const ROLE_FAMILY_ASSESSMENT_PER_ROLE_TOKENS = 700;
export const MAX_ROLE_FAMILIES_PER_ASSESSMENT = Math.floor(
  (BATCH_OUTPUT_TOKEN_BUDGET - ROLE_FAMILY_ASSESSMENT_BASE_TOKENS)
    / ROLE_FAMILY_ASSESSMENT_PER_ROLE_TOKENS,
);
// Every cohort has at least one listing row, so account for both its compact
// evidence envelope and its required indexed assessment before setting the
// schema/packer ceiling.
export const MAX_COMPENSATION_COHORTS_PER_ASSESSMENT = Math.floor(
  (BATCH_OUTPUT_TOKEN_BUDGET - COMPENSATION_ASSESSMENT_BASE_TOKENS)
    / (COMPENSATION_ASSESSMENT_PER_COHORT_TOKENS + COMPENSATION_ASSESSMENT_PER_ROW_TOKENS),
);

export function roleFamilyAssessmentMaxTokens(roleCount = 1) {
  const roles = Math.max(1, Math.floor(Number(roleCount) || 1));
  return Math.min(
    BATCH_OUTPUT_TOKEN_BUDGET,
    ROLE_FAMILY_ASSESSMENT_BASE_TOKENS + roles * ROLE_FAMILY_ASSESSMENT_PER_ROLE_TOKENS,
  );
}

export function compensationCohortAssessmentMaxTokens(cohortCount = 1, rowCount = 1) {
  const cohorts = Math.max(1, Math.floor(Number(cohortCount) || 1));
  const rows = Math.max(1, Math.floor(Number(rowCount) || 1));
  return Math.min(
    BATCH_OUTPUT_TOKEN_BUDGET,
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
      + rows * COMPENSATION_ASSESSMENT_PER_ROW_TOKENS <= BATCH_OUTPUT_TOKEN_BUDGET;
}

export const MAX_COMPENSATION_ROWS_PER_ASSESSMENT_COHORT = Math.floor(
  (BATCH_OUTPUT_TOKEN_BUDGET - COMPENSATION_ASSESSMENT_BASE_TOKENS - COMPENSATION_ASSESSMENT_PER_COHORT_TOKENS)
    / COMPENSATION_ASSESSMENT_PER_ROW_TOKENS,
);
