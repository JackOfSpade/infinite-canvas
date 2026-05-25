/**
 * Result-count caps — how many results reach the LLM, and the per-source
 * breadth ceilings, in one place.
 *
 * The LLM-input caps (compsForPricing, jobScoringBatchSize) are the adaptive
 * part: they scale to how many quality results actually exist and stay bounded
 * by the downstream output-token budget. They mirror llm.js TASK_MAX_TOKENS,
 * whose price-synthesis / job-scoring caps grow ~linearly with item count
 * (≈100 tok/comp, ≈300 tok/job on top of a base) up to a 24576 hard cap — so a
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

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Mirrors llm.js TASK_MAX_TOKENS shapes (price-synthesis / job-scoring).
const TOKEN_HARD_CAP        = 24576;
const PRICE_BASE_TOKENS     = 3000;
const PRICE_TOKENS_PER_COMP = 100;
const JOB_BASE_TOKENS       = 2500;
const JOB_TOKENS_PER_JOB    = 300;
const BUDGET_SAFETY         = 0.8;   // leave headroom under the hard cap

// ── Per-source extractor breadth cap (top-N a single source contributes) ──────
// UNCAPPED (Infinity): every API source returns ALL its in-window matches rather
// than a top-N slice — `slice(0, Infinity)` is a no-op, so each fetcher's existing
// slice line keeps working untouched. Uncapped on purpose while the free Gemini
// tier is being retired; restore a numeric ceiling (was 30) when the paid API tier
// lands and per-source breadth needs bounding again.
export const JOB_RESULT_CAP = Infinity;

// ── LLM scoring budget (how many gathered jobs actually get LLM-scored) ───────
// UNCAPPED (Infinity): score EVERY gathered job. selectTopAcrossSources(_, Infinity)
// returns the whole pool unchanged, so cappedForBudget is always 0.
// ⚠️ This is deliberately ABOVE what the FREE Gemini tier can sustain — scoring
// hundreds of jobs will rate-limit (429) and fall back to weaker models until the
// paid API tier lands. Restore a numeric budget (was 150, round-robin fair across
// sources via selectTopAcrossSources) when on paid.
export const JOB_SCORE_CAP = Infinity;

// ── Date-bounded deep pagination ──────────────────────────────────────────────
// Browser sources page forward (same stealth session) until they run out of
// in-window jobs / hit a block, capped by this hard ceiling. Start generous and
// walk DOWN if a source starts getting blocked — volume is the anti-bot trigger,
// not speed, so the ceiling is the real safety knob. The scorer cap (above) still
// bounds how many of the wider pool reach the LLM.
export const JOB_MAX_PAGES = 10;

// ── LLM-input caps (adaptive: scale to availability, bounded by token budget) ─
const SOLD_COMP_TARGET    = 25; // statistically-sufficient "sold" comps for an FMV
const ACTIVE_COMP_TARGET  = 15; // "active competition" comps
const MAX_COMPS_BY_BUDGET = Math.floor((TOKEN_HARD_CAP * BUDGET_SAFETY - PRICE_BASE_TOKENS) / PRICE_TOKENS_PER_COMP);

/**
 * How many sold/active comps to feed the price-synthesis LLM. Sends what's
 * available up to the statistically-sufficient target (the caller pre-sorts by
 * title-match quality, so the top-N are the most relevant), and trims
 * proportionally if the targets ever exceed what the token budget can reason
 * about — so "enough comps for a meaningful price" without blowing the cap.
 * @returns {{ sold:number, active:number }}
 */
export function compsForPricing(soldAvailable = 0, activeAvailable = 0) {
  // Coerce defensively: a non-numeric/NaN count would otherwise propagate to
  // slice(0, NaN) → [] (silently dropping every comp).
  let sold   = Math.min(Math.max(0, Number(soldAvailable)   || 0), SOLD_COMP_TARGET);
  let active = Math.min(Math.max(0, Number(activeAvailable) || 0), ACTIVE_COMP_TARGET);
  const total = sold + active;
  if (total > MAX_COMPS_BY_BUDGET && total > 0) {
    const scale = MAX_COMPS_BY_BUDGET / total;
    sold   = Math.floor(sold * scale);
    active = Math.floor(active * scale);
  }
  return { sold, active };
}

const DEFAULT_SCORING_BATCH = 15; // calibrated batch size (telemetry — see llm.js job-scoring)
const MIN_SCORING_BATCH     = 5;

/**
 * Jobs to score per LLM call. Capped at the calibrated default, but shrinks
 * automatically if JOB_TOKENS_PER_JOB is raised to reflect a more thinking-heavy
 * model — so a batch can never request a per-call output budget over the hard
 * cap. (At today's coefficients the budget allows ~57, so the default governs.)
 */
export function jobScoringBatchSize() {
  const maxByBudget = Math.floor((TOKEN_HARD_CAP * BUDGET_SAFETY - JOB_BASE_TOKENS) / JOB_TOKENS_PER_JOB);
  return clamp(Math.min(DEFAULT_SCORING_BATCH, maxByBudget), MIN_SCORING_BATCH, DEFAULT_SCORING_BATCH);
}
