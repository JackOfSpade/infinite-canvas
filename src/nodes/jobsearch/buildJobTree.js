import { structuralEdge } from '../_shared/edgeHelpers.js';
import { isJobCardVisible } from '../../utils/jobCardFilters.js';
import { validateJobBoardTaxonomy } from '../../utils/jobBoardAiProvider.js';

/**
 * Pure helpers for turning scored jobs + taxonomy metadata into the React
 * Flow node/edge graph the Job Search Module spawns. Lives outside the component so the
 * algorithm is unit-testable without a ReactFlow runtime — JobSearchNode.jsx wires
 * up the IPC plumbing and passes the results to ReactFlow.
 *
 * The results hierarchy is THREE grouping levels, deepest last:
 *   1. Hiring-fit band — evidence-based full-process fit (matchScore), ordered HIGH→LOW.
 *   2. Salary range    — ordered HIGH→LOW (Unspecified last).
 *   3. Job role        — ordered A→Z.
 * …then the job cards (ordered by score desc).
 *
 * Hiring-fit bands are fixed to the scoring rubric (85+ excellent, 70–84 good,
 * 40–69 partial/stretch, below 40 limited). The AI bucketing pass creates the
 * salary ranges and role partition; the renderer places each job into its band
 * (by matchScore) and salary range (by parsed salary) DETERMINISTICALLY, so a
 * weak model can't drop or duplicate jobs across the three nested levels. The
 * role grouping is model-produced and must completely cover every input before
 * this renderer can build a replacement board.
 *
 * Exports:
 *  - parseSalaryToNumeric     → salary text → annual USD
 *  - computeLayoutPositions   → tight (x,y) for the current expand state
 *  - computeJobTreeView       → single derivation of `hidden` from expand × filter
 *  - compareJobsByFitAndPreference → deterministic within-fit card order
 *  - buildJobTreeNodes        → emits the {nodes, edges} graph
 */

// Column x-offsets per tree level + row heights. One layout: hiring-fit band is
// always the first level (no target-role branch column).
export const COL_X = { likelihood: 400, salary: 700, role: 1000, job: 1400 };
const ROW_H = { group: 70, job: 280 }; // module-local: only used within this file

// Vertical gap kept below an EXPANDED job card (one whose measured height exceeds
// the fixed ROW_H.job). Collapsed/normal cards keep the original ROW_H.job
// spacing via the Math.max in computeLayoutPositions, so the default layout is
// unchanged — this only governs how far the next card sits below a grown one.
const JOB_V_GAP = 40;

/**
 * Whether a newly reported JobCard measurement requires the whole visible tree
 * to be laid out again. A card initially reserves ROW_H.job; its first real
 * measurement only needs a reflow when it grows beyond that reservation. Later
 * measurement changes always need one so disclosure expansion/collapse keeps
 * every lower sibling clear.
 */
export function shouldReflowMeasuredJobCard({ visible, previousMeasuredHeight, measuredHeight }) {
  if (!visible || !Number.isFinite(measuredHeight)) return false;
  if (!Number.isFinite(previousMeasuredHeight)) return measuredHeight > ROW_H.job;
  return previousMeasuredHeight !== measuredHeight;
}

// Leaf (role) groups paginate their cards; reveal the first N on expand.
export const ROLE_VISIBLE_DEFAULT = 10;

// One scoring rubric, shared by every run and every saved taxonomy. Allowing the
// bucketing model to move these thresholds made a score of 55 "Good fit" even
// though the scoring rubric defines 40–69 as a partial/stretch outcome.
// Not imported elsewhere — normalizeBandsWithRepairs is the sole enforcement
// point, so this stays module-private.
const FIXED_LIKELIHOOD_BANDS = Object.freeze([
  Object.freeze({ label: 'Excellent hiring fit (85–100)', minScore: 85, maxScore: 100 }),
  Object.freeze({ label: 'Good hiring fit (70–84)',       minScore: 70, maxScore: 84 }),
  Object.freeze({ label: 'Partial hiring fit (40–69)',    minScore: 40, maxScore: 69 }),
  Object.freeze({ label: 'Limited hiring fit (0–39)',     minScore: 0,  maxScore: 39 }),
]);

// Fallbacks only when the AI omits salary ranges (hiring-fit bands are fixed above).
const DEFAULT_RANGES = [
  { label: '$150k+',     minSalary: 150000, maxSalary: 0 },
  { label: '$100–150k',  minSalary: 100000, maxSalary: 150000 },
  { label: '$60–100k',   minSalary: 60000,  maxSalary: 100000 },
  { label: 'Under $60k', minSalary: 1,      maxSalary: 60000 },
  { label: 'Unspecified', minSalary: 0,     maxSalary: 0 },
];

// Salary research is additive metadata on a scored job, not part of its
// hiring-fit score or hierarchy placement. Keep the compatibility
// boundary here (rather than in JobCardNode) so every path that creates a card
// can preserve a single, safe representation. A missing/unknown assessment is
// deliberately a neutral legacy state: opening an old canvas must never imply
// that new compensation research was run.
const COMPENSATION_STATUSES = new Set(['competitive', 'below_market', 'market_recommendation', 'uncertain', 'not_evaluated']);
// These records are renderer-facing, potentially persisted AI output. Keep an
// absurd value from becoming a very long disclosure (or, worse, supporting a
// semantic green/red result). This is the same generous annual-cash ceiling
// used by the offer parser; it still accommodates unusually high executive
// and contractor pay in the currencies this feature supports.
const MAX_CREDIBLE_ANNUAL_CASH = 10_000_000;
const MAX_COMPENSATION_TEXT_LENGTH = 2_400;
const MAX_SOURCE_LABEL_LENGTH = 240;
const MAX_SOURCE_DETAILS_LENGTH = 500;
const MAX_LOCATION_LABEL_LENGTH = 300;

function numericScore(value) {
  const score = Number(value);
  return Number.isFinite(score) ? score : 0;
}

/**
 * Cards remain primarily ordered by hiring fit. When that score is tied, the
 * independent Job Preferences assessment gives the user a useful secondary
 * order. Returning zero for a complete tie deliberately preserves the input's
 * stable order rather than inventing a title/company tie-break.
 */
export function compareJobsByFitAndPreference(a, b) {
  const fitDelta = numericScore(b?.matchScore) - numericScore(a?.matchScore);
  if (fitDelta) return fitDelta;
  return numericScore(b?.preferenceAssessment?.preferenceScore)
    - numericScore(a?.preferenceAssessment?.preferenceScore);
}

function textValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function positiveNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= MAX_CREDIBLE_ANNUAL_CASH ? numeric : null;
}

function normalizedPayPeriod(value) {
  const raw = textValue(value).toLowerCase().replace(/[\s/_-]+/g, '');
  if (['annual', 'annually', 'year', 'yearly', 'yr', 'peryear', 'peryr', 'annum'].includes(raw)) return 'annual';
  return raw;
}

function normalizedRange(value, fallback = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const min = positiveNumber(source.min ?? source.low ?? source.minimum ?? fallback.min);
  const max = positiveNumber(source.max ?? source.high ?? source.maximum ?? fallback.max);
  const currency = textValue(source.currency ?? source.currencyCode ?? fallback.currency).toUpperCase();
  const period = normalizedPayPeriod(source.period ?? source.payPeriod ?? source.unit ?? fallback.period);
  const resolvedMin = min ?? max;
  const resolvedMax = max ?? min;
  // Do not silently reorder a malformed offer or research range. A reversed
  // range is incomplete evidence, not a safe basis for a coloured card.
  const isOrdered = resolvedMin === null || resolvedMax === null || resolvedMin <= resolvedMax;
  return {
    min: isOrdered ? resolvedMin : null,
    max: isOrdered ? resolvedMax : null,
    currency,
    period,
  };
}

function normalizedLocation(value) {
  if (typeof value === 'string') return textValue(value).slice(0, MAX_LOCATION_LABEL_LENGTH);
  if (!value || typeof value !== 'object') return '';
  const explicit = textValue(value.display ?? value.label ?? value.displayName ?? value.name);
  if (explicit) return explicit.slice(0, MAX_LOCATION_LABEL_LENGTH);
  return [value.city, value.subdivision ?? value.state ?? value.province ?? value.region, value.country]
    .map(textValue)
    .filter(Boolean)
    .join(', ')
    .slice(0, MAX_LOCATION_LABEL_LENGTH);
}

function normalizedSourceLinks(value) {
  if (!Array.isArray(value)) return [];
  return value.map((source) => {
    if (typeof source === 'string') return { label: textValue(source).slice(0, MAX_SOURCE_LABEL_LENGTH), url: source };
    if (!source || typeof source !== 'object') return null;
    const url = textValue(source.url ?? source.href ?? source.link);
    if (!url) return null;
    return {
      label: (textValue(source.title ?? source.name ?? source.label) || 'Research source').slice(0, MAX_SOURCE_LABEL_LENGTH),
      url,
      details: textValue(source.details ?? source.note ?? source.summary).slice(0, MAX_SOURCE_DETAILS_LENGTH),
      range: normalizedRange(source.range ?? source.competitiveRange ?? source),
    };
  }).filter(Boolean).slice(0, 5);
}

function normalizedCompensationStatus(value) {
  const raw = textValue(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (COMPENSATION_STATUSES.has(raw)) return raw;
  if (['above_market', 'at_market', 'worth_it'].includes(raw)) return 'competitive';
  if (['recommended', 'market_recommended', 'salary_recommendation'].includes(raw)) return 'market_recommendation';
  if (['belowmarket', 'not_worth_it', 'under_market'].includes(raw)) return 'below_market';
  if (['unknown', 'unavailable', 'not_applicable'].includes(raw)) return 'uncertain';
  return '';
}

/**
 * Coerce current and older salary-research payloads into a render-safe shape.
 * This must fail open: only an explicit, recognized verdict can colour a card.
 */
export function normalizeCompensationAssessment(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!source) {
    return {
      schemaVersion: 0,
      status: 'not_evaluated',
      reasonCode: 'legacy_unresearched',
      justification: 'Compensation research was not run for this saved result. Re-run its Job Search module to evaluate the advertised cash salary.',
      offered: normalizedRange(), competitiveRange: normalizedRange(), comparisonLocation: '', researchedAt: '', currencyInferredFromLocation: false, sourceLinks: [],
      isLegacy: true,
    };
  }

  const schemaVersion = Number.isFinite(Number(source.schemaVersion)) ? Number(source.schemaVersion) : 0;
  const status = normalizedCompensationStatus(source.status ?? source.verdict ?? source.result);
  const normalized = {
    schemaVersion,
    status: status || 'not_evaluated',
    reasonCode: textValue(source.reasonCode ?? source.reason),
    offered: normalizedRange(source.offered ?? source.advertisedCash ?? source.advertisedSalary ?? source.offer, source),
    competitiveRange: normalizedRange(source.competitiveRange ?? source.marketRange ?? source.researchedMarketRange, source),
    comparisonLocation: normalizedLocation(source.comparisonLocation ?? source.marketLocation ?? source.evaluatedLocation),
    justification: textValue(source.justification ?? source.reasoning ?? source.explanation ?? source.summary).slice(0, MAX_COMPENSATION_TEXT_LENGTH),
    researchedAt: textValue(source.researchedAt ?? source.researchDate ?? source.researchedOn).slice(0, 100),
    currencyInferredFromLocation: source.currencyInferredFromLocation === true,
    sourceLinks: normalizedSourceLinks(source.sourceLinks ?? source.sources ?? source.evidence),
    isLegacy: false,
  };

  // A future/partial schema must never inherit a red or green visual treatment
  // just because a similarly named field happened to be present.
  if (schemaVersion !== 1) {
    normalized.status = 'not_evaluated';
    normalized.reasonCode = 'unsupported_assessment_schema';
    normalized.justification = 'This saved compensation assessment uses an unsupported or incomplete format, so no cash-pay conclusion is shown.';
  } else if (!status) {
    normalized.reasonCode = normalized.reasonCode || 'unreadable_assessment';
    normalized.justification = normalized.justification || 'Compensation research could not be read safely, so no cash-pay conclusion is shown.';
  } else if (['competitive', 'below_market'].includes(normalized.status)
    && (!(normalized.offered.min > 0) || !(normalized.offered.max > 0)
      || !(normalized.competitiveRange.min > 0) || !(normalized.competitiveRange.max > 0))) {
    normalized.status = 'uncertain';
    normalized.reasonCode = 'incomplete_comparison_data';
    normalized.justification = 'Compensation research did not retain a complete cash-pay comparison, so no green or red conclusion is shown.';
  } else if (['competitive', 'below_market'].includes(normalized.status)
    && (!normalized.offered.currency || !normalized.competitiveRange.currency
      || normalized.offered.currency !== normalized.competitiveRange.currency)) {
    // Values without an explicit shared currency cannot be compared. The
    // backend always normalizes a valid assessment to one currency, but
    // saved/partial data must fail open in the renderer rather than infer it.
    normalized.status = 'uncertain';
    normalized.reasonCode = 'incompatible_comparison_currency';
    normalized.justification = 'Compensation research retained cash figures in different currencies without a reliable conversion, so no green or red conclusion is shown.';
  } else if (['competitive', 'below_market'].includes(normalized.status)
    && (normalized.offered.period !== 'annual' || normalized.competitiveRange.period !== 'annual')) {
    normalized.status = 'uncertain';
    normalized.reasonCode = 'incompatible_comparison_period';
    normalized.justification = 'Compensation research did not retain reliably annualized cash figures, so no green or red conclusion is shown.';
  } else if (normalized.status === 'market_recommendation'
    && (!(normalized.competitiveRange.min > 0) || !(normalized.competitiveRange.max > 0)
      || !normalized.competitiveRange.currency || normalized.competitiveRange.period !== 'annual')) {
    normalized.status = 'uncertain';
    normalized.reasonCode = 'incomplete_market_recommendation';
    normalized.justification = 'Compensation research did not retain a complete annual market range and currency, so no salary recommendation is shown.';
  } else if (!normalized.justification) {
    normalized.justification = normalized.status === 'competitive'
      ? 'The advertised guaranteed cash salary reaches the researched competitive range for this role and location.'
      : normalized.status === 'below_market'
        ? 'The advertised guaranteed cash salary is below the researched competitive range for this role and location.'
        : normalized.status === 'market_recommendation'
          ? 'The listing did not provide usable cash pay to compare; this is the researched competitive salary range for the role and location.'
        : normalized.status === 'uncertain'
          ? 'The available salary evidence was not comparable enough to make a reliable cash-pay conclusion.'
          : 'The listing did not provide enough guaranteed recurring cash compensation to evaluate.';
  }
  return normalized;
}

function formatSalaryShort(value) {
  const n = Math.round(Number(value) || 0);
  if (n >= 1000 && n % 1000 === 0) return `$${Math.round(n / 1000)}k`;
  return `$${n.toLocaleString('en-US')}`;
}

/** A salary-band label is data derived from its bounds, never model-authored prose. */
export function canonicalSalaryRangeLabel(minSalary, maxSalary) {
  const min = Math.max(0, Math.round(Number(minSalary) || 0));
  const max = Math.max(0, Math.round(Number(maxSalary) || 0));
  if (min === 0 && max === 0) return 'Unspecified';
  if (max === 0) return `${formatSalaryShort(min)}+/yr`;
  if (min <= 1) return `Under ${formatSalaryShort(max)}/yr`;
  return `${formatSalaryShort(min)}–${formatSalaryShort(max)}/yr`;
}

/**
 * Salary text → approximate annual USD. Takes the first number in a range and
 * annualizes hourly/daily rates. Used by buildJobTreeNodes (and the re-layout in
 * computeJobTreeView) so every card lands in a consistent salary range. Returns
 * 0 when unparseable.
 */
export function parseSalaryToNumeric(salaryStr) {
  if (!salaryStr) return 0;
  const raw = String(salaryStr);
  const clean = raw.toLowerCase().replace(/[$,]/g, '');
  // A benefits blurb such as "401k matching" is common in descriptions and is
  // never pay. Keep legitimate bare "$95k" / "95k" salary values intact.
  if (!/\$/.test(raw) && /\b401\s*k\b/i.test(raw)) return 0;
  const m = clean.match(/(\d+(?:\.\d+)?)\s*([km](?![a-z]))?/);
  if (!m) return 0;
  let val = parseFloat(m[1]);
  if (m[2] === 'k') val *= 1000;
  if (m[2] === 'm') val *= 1000000;
  // SUB-ANNUAL cadences — the ones that drive a multiplier below. Word forms
  // ("$19 Hourly", "$1.6K Weekly") are as common on a pay chip as slash forms,
  // and `\bhour\b` does not match "hourly", so both spellings are listed.
  const hasCadence = /\b(?:bi[-\s]?weekly|week|wk|weekly|month|mo|monthly|day|daily|hour|hr|hourly)s?\b|\/\s*(?:bi[-\s]?wk|wk|mo|day|hr)\b/.test(clean);
  // An ANNUAL cadence needs no multiplier, but it does prove the number is pay —
  // so it lifts the implausible-magnitude guard for a genuinely low annual figure
  // ("$8,000 a year" on a part-time req). Gated on a currency marker so the bare
  // word in prose ("3 years experience") stays an incidental number, not a salary.
  const hasAnnualCadence = /[$€£]/.test(raw) && /\b(?:year|yr|yearly|annual|annually|annum)s?\b|\/\s*yr\b/.test(clean);
  const hasRange = /\d+(?:\.\d+)?\s*(?:k)?\s*(?:[-–—]|to)\s*\$?\s*\d+/i.test(raw);
  const hasPayContext = /\b(?:salary|pay|compensation|wage|rate)\b/i.test(raw);
  // Do not turn incidental small numbers in a loosely extracted salary field
  // ("3 shifts", "2 days", etc.) into annual compensation. Large bare values
  // and `95k` remain accepted for sources that omit currency formatting.
  //
  // A currency symbol is NOT evidence of an annual figure and never was: the
  // guard used to exempt anything with a `$`, so a ZipRecruiter chip whose "/hr"
  // the extractor had dropped ("$19", "$20", "$18.15") was annualized verbatim
  // into a nineteen-dollar-a-year salary and bucketed as real pay. An amount this
  // small with no cadence, no range and no pay context is a cadence we LOST, not
  // an annual salary — and guessing "it must be hourly" would invent a number the
  // listing never stated, so it goes to Unspecified and the raw text still shows
  // on the card. The extractor-side fixes (MONEY_SRC word forms,
  // formatJsonLdSalary's unit guard) are what recover the real value.
  const MIN_CREDIBLE_ANNUAL_SALARY = 10000;
  // A source occasionally emits an hourly-looking decimal range with an annual
  // suffix (observed from Indeed: "$18.75 - $19.70 a year"). The explicit
  // suffix used to exempt it from every magnitude guard, producing a literal
  // $19/year salary and a false Under-$30k placement. Preserve genuinely small
  // annual amounts such as "$8,000 a year", but reject values below even a
  // plausible stipend. Never guess that the source meant hourly.
  const MIN_PLAUSIBLE_EXPLICIT_ANNUAL_SALARY = 1000;
  if (hasAnnualCadence && val < MIN_PLAUSIBLE_EXPLICIT_ANNUAL_SALARY) return 0;
  if (val < MIN_CREDIBLE_ANNUAL_SALARY && !hasCadence && !hasAnnualCadence && !hasRange && !hasPayContext) return 0;
  // Cadence wins over magnitude: "$1.6K/wk" is $83,200/year, while
  // "$22/hour" is $45,760/year. Match biweekly before weekly.
  let cadenceApplied = true;
  if (/\bbi[-\s]?weekly\b|\bbiweekly\b|\/\s*bi[-\s]?wk\b/.test(clean)) val *= 26;
  else if (/\b(?:week|wk|weekly)s?\b|\/\s*wk\b/.test(clean)) val *= 52;
  else if (/\b(?:month|mo|monthly)s?\b|\/\s*mo\b/.test(clean)) val *= 12;
  else if (/\b(?:day|daily)\b|\/\s*day\b/.test(clean)) val *= 5 * 52;
  else if (/\b(?:hour|hr|hourly)s?\b|\/\s*hr\b/.test(clean)) val *= 40 * 52;
  else cadenceApplied = false;
  // `hasRange` and `hasPayContext` prove the number is PAY. Neither proves it is
  // ANNUAL pay — only `hasAnnualCadence` does that. Dice serves bare rate ranges
  // ("19 - 21", "$21 - $22", "$24 - $24") whose cadence lives nowhere in the
  // string; the range shape alone used to lift the magnitude guard above, and
  // with no cadence token left to match, the raw rate fell through as a literal
  // annual figure — a twenty-one-dollar-a-year salary that then bucketed as real
  // pay, one range too low. Same lost cadence as the bare "$19" case, so it gets
  // the same answer: Unspecified. Inferring "small means hourly" would invent a
  // cadence the listing never stated; the card still shows the raw text.
  if (!cadenceApplied && !hasAnnualCadence && val < MIN_CREDIBLE_ANNUAL_SALARY) return 0;
  // Keep malformed/ad-network pay chips out of the real salary buckets. One
  // observed ZipRecruiter chip read "$65K/hr": treating its `K` suffix and
  // hourly cadence literally produces $135.2M/year, an implausible result that
  // overwhelms auto-generated ranges. Preserve the raw chip for the card, but
  // mark a value outside any credible job-compensation range as Unspecified.
  // The ceiling still permits unusually highly paid executive and contractor
  // work (up to roughly $4.8K/hour) without silently rewriting the source.
  const MAX_CREDIBLE_ANNUAL_SALARY = 10_000_000;
  return Number.isFinite(val) && val > 0 && val <= MAX_CREDIBLE_ANNUAL_SALARY ? Math.round(val) : 0;
}

// One endpoint of a pay range. The leading `[A-Za-z]{1,3}(?=[$€£])` is
// load-bearing, not defensive padding: Google and Glassdoor both write their
// USD amounts with a country-code prefix ("US$50K–US$250K a year"), and a
// currency SYMBOL preceded by letters used to break the match outright. The
// engine would anchor group 1 on the bare `$50K` (skipping `US`), then require
// group 2 to start at `US$250K` — where `\$?\s*\d` cannot consume the `U`. The
// whole regex failed, so range metadata returned null and every US$-prefixed
// range silently escaped diagnostic disclosure at ANY ratio, for the two sources
// that use that format. The lookahead keeps the prefix unambiguous: letters are
// consumed only when a currency symbol immediately follows, so a "20 to 30"
// separator can never be mistaken for a prefix. Dice's symbol-less "USD 90,000.00
// - 125,000.00" shape already worked (nothing to anchor on but the digits).
const SALARY_ENDPOINT = '(?:[A-Za-z]{1,3}(?=[$€£]))?[$€£]?\\s*\\d[\\d,]*(?:\\.\\d+)?\\s*[km]?';
const SALARY_RANGE_RE = new RegExp(`(${SALARY_ENDPOINT})(?:\\s*(?:[-–—]|to)\\s*)(${SALARY_ENDPOINT})`, 'i');

/**
 * Return annualized endpoints for any valid source pay range without changing
 * placement. This is diagnostic provenance: salary buckets still use the lower
 * endpoint (the conservative floor a candidate can actually expect).
 */
export function salaryRangeMetadata(salaryStr) {
  const raw = String(salaryStr || '').trim();
  if (!raw) return null;
  const match = raw.match(SALARY_RANGE_RE);
  if (!match) return null;
  const lowerAnnual = parseSalaryToNumeric(raw);
  // Preserve the cadence that follows the range ("$20–$25 an hour") while
  // asking the existing parser to annualize the upper endpoint.
  const upperAnnual = parseSalaryToNumeric(`${match[2]}${raw.slice((match.index || 0) + match[0].length)}`);
  if (!(lowerAnnual > 0) || !(upperAnnual > 0) || upperAnnual < lowerAnnual) return null;
  const ratio = upperAnnual / lowerAnnual;
  return {
    lowerAnnual,
    upperAnnual,
    ratio: Math.round(ratio * 10) / 10,
  };
}

/**
 * Surface obviously malformed source pay ranges without changing placement.
 * Salary buckets intentionally use the lower endpoint (the conservative floor
 * a candidate can actually expect), but a chip such as "$23.50–$250/hr" is
 * useful scraper-quality evidence and must not disappear behind that floor.
 */
export function salaryRangeAnomaly(salaryStr) {
  const metadata = salaryRangeMetadata(salaryStr);
  if (!metadata) return null;
  const { ratio } = metadata;
  // A fivefold compensation spread is rare enough to be diagnostic while still
  // avoiding noise from normal hourly/annual bands. We report it; never rewrite
  // source data or change the lower-bound bucket.
  if (ratio < 5) return null;
  return {
    ...metadata,
    reason: `upper endpoint is ${Math.round(ratio * 10) / 10}× the lower endpoint`,
  };
}

// ── Deterministic placement ────────────────────────────────────────────────

/** Return the fixed scoring-rubric bands; legacy/model-authored bands are ignored. */
export function normalizeBandsWithRepairs(bands) {
  const repairs = [];
  const input = Array.isArray(bands) ? bands : [];
  const isCanonical = input.length === FIXED_LIKELIHOOD_BANDS.length
    && input.every((band, index) => {
      const fixed = FIXED_LIKELIHOOD_BANDS[index];
      return band?.label === fixed.label
        && Number(band?.minScore) === fixed.minScore
        && Number(band?.maxScore) === fixed.maxScore;
    });
  if (input.length > 0 && !isCanonical) {
    repairs.push('replaced hiring-fit bands with fixed scoring rubric');
  }
  return {
    bands: FIXED_LIKELIHOOD_BANDS.map(band => ({ ...band })),
    repairs,
  };
}

export function normalizeBands(bands) {
  return normalizeBandsWithRepairs(bands).bands;
}

/** Split AI salary ranges into ordered (high→low) real ranges + an Unspecified. */
export function normalizeRangesWithRepairs(ranges) {
  const repairs = [];
  const input = Array.isArray(ranges) ? ranges : [];
  const byMin = new Map();
  let sawUnspecified = false;
  for (const raw of input) {
    let minSalary = Math.max(0, Math.round(Number(raw?.minSalary) || 0));
    let maxSalary = Math.max(0, Math.round(Number(raw?.maxSalary) || 0));
    if (!Number.isFinite(Number(raw?.minSalary)) || !Number.isFinite(Number(raw?.maxSalary))) repairs.push('repaired non-numeric salary bound');
    if (minSalary === 0 && maxSalary === 0) {
      if (sawUnspecified) repairs.push('dropped duplicate Unspecified salary range');
      sawUnspecified = true;
      continue;
    }
    if (minSalary === 0) {
      minSalary = 1;
      repairs.push('repaired zero lower bound on salary range');
    }
    if (maxSalary > 0 && maxSalary <= minSalary) {
      maxSalary = 0;
      repairs.push(`made invalid salary range at ${formatSalaryShort(minSalary)} open-ended`);
    }
    const existing = byMin.get(minSalary);
    if (!existing) byMin.set(minSalary, { minSalary, maxSalary, rawLabel: String(raw?.label || '').trim() });
    else repairs.push(`dropped duplicate salary lower bound ${formatSalaryShort(minSalary)}`);
  }
  const real = [...byMin.values()].sort((a, b) => b.minSalary - a.minSalary);
  let unspecified = { label: 'Unspecified', minSalary: 0, maxSalary: 0 };
  if (!sawUnspecified) repairs.push('added missing Unspecified salary range');
  const lowest = real[real.length - 1];
  if (lowest && lowest.minSalary > 1) {
    // Keep parseable low salaries out of the "Unspecified" bucket when the AI
    // forgets to include a bottom catch-all range.
    real.push({
      minSalary: 1,
      maxSalary: lowest.minSalary,
      synthetic: true,
    });
    repairs.push(`added low-salary catch-all below ${formatSalaryShort(lowest.minSalary)}`);
  }
  // Ranges are threshold buckets in placeRange, so derive every upper bound
  // from the next higher threshold. This makes their labels truthful and the
  // bands contiguous even if the model supplied overlapping/gapped maxima.
  real.forEach((range, index) => {
    const expectedMax = index === 0 ? 0 : real[index - 1].minSalary;
    if (range.maxSalary !== expectedMax) {
      // `minSalary: 1` is the synthetic low-salary catch-all sentinel, not a
      // literal $1 salary threshold. Naming it as "$1" in diagnostics made a
      // successful taxonomy repair look like corrupt user pay data.
      const rangeName = range.minSalary <= 1
        ? 'the low-salary catch-all'
        : formatSalaryShort(range.minSalary);
      repairs.push(`normalized salary upper bound for ${rangeName}`);
    }
    range.maxSalary = expectedMax;
    range.label = canonicalSalaryRangeLabel(range.minSalary, range.maxSalary);
    // The low-salary catch-all above is authored by this sanitizer and therefore
    // has no model label to canonicalize. Do not report its missing rawLabel as a
    // provider defect; the preceding "added low-salary catch-all" repair already
    // explains exactly what happened.
    if (!range.synthetic && range.rawLabel !== range.label) repairs.push(`canonicalized salary label "${range.rawLabel || '(blank)'}"`);
    delete range.rawLabel;
    delete range.synthetic;
  });
  return { real, unspecified, repairs };
}

export function normalizeRanges(ranges) {
  const { real, unspecified } = normalizeRangesWithRepairs(ranges);
  return { real, unspecified };
}

/**
 * Canonicalize model taxonomy before it becomes persisted UI state. Roles remain
 * model-created, but invalid/out-of-range/duplicate membership cannot distort
 * the deterministic tree (first valid role assignment wins). Every job is then
 * assigned exactly once: unassigned jobs recover into their scored
 * `careerDirection`, with Other reserved for genuinely unhinted jobs.
 *
 * `jobs` is optional to keep the old `(tree, jobCount, salaries)` contract
 * working for saved/legacy callers. New callers should pass the indexed job
 * metadata as the fourth argument so recovery preserves useful role hints.
 */
export function sanitizeJobTaxonomy(tree, jobCount = 0, salaries = [], jobs = []) {
  const { bands, repairs: bandRepairs } = normalizeBandsWithRepairs(tree?.likelihoodBands);
  const { real, unspecified, repairs: rangeRepairs } = normalizeRangesWithRepairs(tree?.salaryRanges);
  const repairs = [...bandRepairs, ...rangeRepairs];
  const parseableSalary = (salaries || []).some(s => parseSalaryToNumeric(s) > 0);
  if (real.length === 0 && parseableSalary) {
    const fallback = normalizeRangesWithRepairs(DEFAULT_RANGES);
    real.push(...fallback.real);
    repairs.push('used default salary ranges because model returned no real range for parseable pay');
  }

  const usedIndices = new Set();
  const roleMap = new Map();
  for (const raw of Array.isArray(tree?.roles) ? tree.roles : []) {
    const rawName = String(raw?.name || '').trim().replace(/\s+/g, ' ');
    const name = rawName.slice(0, 120);
    if (name !== raw?.name) repairs.push('canonicalized blank or oversized role name');
    // A blank role name is not a valid AI assignment. Do not materialize it as
    // Other: leave its jobs unclaimed so the complete-coverage pass below can
    // recover them from their career direction.
    if (!name) continue;
    const valid = [];
    for (const index of Array.isArray(raw?.jobIndices) ? raw.jobIndices : []) {
      if (!Number.isInteger(index) || index < 0 || index >= jobCount) {
        repairs.push('dropped invalid role job index');
      } else if (usedIndices.has(index)) {
        repairs.push(`dropped duplicate role assignment for job ${index}`);
      } else {
        usedIndices.add(index);
        valid.push(index);
      }
    }
    if (valid.length > 0) {
      if (!roleMap.has(name)) roleMap.set(name, []);
      roleMap.get(name).push(...valid);
    }
  }

  let directionRecovered = 0;
  let otherRecovered = 0;
  for (let index = 0; index < jobCount; index += 1) {
    if (usedIndices.has(index)) continue;
    const direction = normalizeCareerDirection(jobs?.[index]?.careerDirection);
    const fallbackName = direction || 'Other';
    if (!roleMap.has(fallbackName)) roleMap.set(fallbackName, []);
    roleMap.get(fallbackName).push(index);
    usedIndices.add(index);
    if (direction) directionRecovered += 1;
    else otherRecovered += 1;
  }
  if (directionRecovered > 0) repairs.push(`recovered ${directionRecovered} job(s) into career-direction role(s)`);
  if (otherRecovered > 0) repairs.push(`recovered ${otherRecovered} unhinted job(s) into Other`);
  return {
    likelihoodBands: bands,
    salaryRanges: [...real, unspecified],
    roles: [...roleMap.entries()].map(([name, jobIndices]) => ({ name, jobIndices })),
    repairs: [...new Set(repairs)],
  };
}

/** A scorer hint is useful only when it names an actual role family. */
function normalizeCareerDirection(value) {
  const direction = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!direction || /^(?:other|unknown|unspecified|none|null|n\/?a)$/i.test(direction)) return '';
  return direction;
}

/** Band a score lands in (first whose minScore it meets, in high→low order).
 *  Single source of truth for band placement, used by buildJobTreeNodes (the
 *  Job Board's Combine spawn) so every card is placed deterministically. */
export function placeBand(score, bands) {
  const s = typeof score === 'number' ? score : 0;
  for (const b of bands) if (s >= b.minScore) return b;
  return bands[bands.length - 1];
}

/** Salary range a number lands in; unknown/zero salary → Unspecified. */
export function placeRange(salNum, realRanges, unspecified) {
  if (!(salNum > 0)) return unspecified;
  for (const r of realRanges) if (salNum >= r.minSalary) return r;
  return unspecified;
}

/**
 * Compute absolute canvas positions for every visible job-tree node owned by
 * `hubId`, based on the current expanded/collapsed state. Kind-agnostic: a
 * group's x comes from COL_X[kind]; a group whose direct children are job cards
 * paginates them via visibleCount. Returns { [nodeId]: {x, y} } for reachable
 * visible nodes only.
 */
export function computeLayoutPositions(nodes, hubId, COL_X_, hubPos) {
  const nodeById = new Map(nodes.map(n => [n.id, n]));

  const allChildIds = new Set();
  nodes.forEach(n => {
    if (n.data?.hubId === hubId && Array.isArray(n.data?.childIds)) {
      n.data.childIds.forEach(cid => allChildIds.add(cid));
    }
  });

  const rootGroups = nodes
    .filter(n => n.data?.hubId === hubId && n.type === 'jobgroup' && !allChildIds.has(n.id) && !n.hidden)
    .sort((a, b) => (a.position?.y ?? 0) - (b.position?.y ?? 0));

  const positions = {};
  const laidOut = new Set();

  function layoutNode(nodeId, startY) {
    // Persisted graphs should be trees, but a malformed childIds cycle must not
    // turn a filter/reflow into an unbounded recursive layout. A first visit is
    // sufficient because a node has one visual position in this cascade.
    if (laidOut.has(nodeId)) return startY;
    laidOut.add(nodeId);
    const node = nodeById.get(nodeId);
    if (!node) return startY;
    // Hidden nodes (collapsed OR filtered out) take no layout space, so the tree
    // tightens around whatever is removed. Visibility is owned by `hidden`
    // (see computeJobTreeView); this function just lays out what's visible.
    if (node.hidden) return startY;

    let x;
    if (node.type === 'jobcard') {
      x = hubPos.x + COL_X_.job;
    } else {
      const kx = COL_X_[node.data?.kind];
      if (kx == null) return startY;
      x = hubPos.x + kx;
    }
    positions[nodeId] = { x, y: startY };

    if (node.type === 'jobcard') {
      // Height-aware stacking: a card taller than the fixed row (e.g. one whose
      // justification is expanded) pushes the cards below it down; when it
      // collapses again they slide back up. Falls back to the fixed row height
      // until ReactFlow has measured the node. Math.max preserves the original
      // spacing for normal/collapsed cards so the default layout is untouched.
      const h = node.measured?.height;
      return startY + (h ? Math.max(ROW_H.job, h + JOB_V_GAP) : ROW_H.job);
    }
    if (!node.data?.expanded) return startY + ROW_H.group;

    // Walk EVERY child: visibility (incl. the role leaves' visibleCount window,
    // which under a filter slices the MATCHING cards, not raw childIds) is
    // owned entirely by `hidden` (computeJobTreeView), and hidden nodes take no
    // layout space — so the old visibleCount slice here would have skipped
    // revealed cards that sit beyond the raw-index window when a filter is on,
    // leaving them unpositioned.
    const childIds = Array.isArray(node.data?.childIds) ? node.data.childIds : [];
    let nextY = startY;
    for (const cid of childIds) nextY = layoutNode(cid, nextY);
    return nextY;
  }

  let nextY = hubPos.y;
  for (const root of rootGroups) nextY = layoutNode(root.id, nextY);
  return positions;
}

/**
 * Count the LIVE, filter-matching job cards under a group's childIds —
 * recursively, so it works for band/salary groups (whose children are groups)
 * and role leaves (whose children are cards) alike. Dismissed cards (ids whose
 * node no longer exists) and filtered-out cards don't count, so group badges
 * and the role leaves' "Show more" math stay truthful as cards are dismissed —
 * dismissal being the PRIMARY interaction on disposable cards. Pure: the node
 * accessor is injected so it runs against ReactFlow's nodeLookup (in a store
 * selector) or a plain Map (in tests).
 *
 * @param {string[]} childIds   the group's data.childIds
 * @param {(id: string) => object|undefined} getNodeById
 * @param {{scoreThreshold?: number, sourceFilter?: string|null}} filter
 * @returns {number}
 */
export function countMatchingDescendantCards(childIds, getNodeById, filter = {}) {
  let count = 0;
  const visited = new Set();
  const stack = Array.isArray(childIds) ? [...childIds] : [];
  while (stack.length > 0) {
    const cid = stack.pop();
    if (visited.has(cid)) continue;
    visited.add(cid);
    const n = getNodeById(cid);
    if (!n) continue; // dismissed/deleted — takes no slot
    if (n.type === 'jobcard') {
      if (isJobCardVisible(n.data || {}, filter)) count++;
    } else if (Array.isArray(n.data?.childIds)) {
      stack.push(...n.data.childIds);
    }
  }
  return count;
}

/**
 * Recompute the job tree's visibility for `hubId` from the single source of truth:
 * (current expand/collapse state) × (active card filter). Sets `hidden` on every
 * card/group so a filter ACTUALLY REMOVES non-matching cards and any branch with
 * no matching descendant (not just dims them), then relays out so the tree tightens.
 * Clearing the filter restores the normal collapsed view (everything matches).
 *
 * This is the one place that derives `hidden` — collapse/expand just flips a
 * group's `data.expanded` and calls this, so reveal always respects the filter.
 *
 * `filter` = { scoreThreshold?, sourceFilter? } (same shape as jobCardFilters).
 * Pure: returns a new nodes array (or the same ref when nothing changed).
 */
export function computeJobTreeView(nodes, hubId, filter = {}, COL_X_ = COL_X, forceLayout = false) {
  const list = Array.isArray(nodes) ? nodes : [];
  const byId = new Map(list.map(n => [n.id, n]));
  const cardMatch = (d) => isJobCardVisible(d || {}, filter);

  // # of matching descendant cards per group (memoized) — a group with 0 is an
  // empty branch under the current filter and gets removed entirely.
  const matchCount = new Map();
  const countMatches = (id) => {
    if (matchCount.has(id)) return matchCount.get(id);
    matchCount.set(id, 0); // guard against cycles
    let c = 0;
    for (const cid of byId.get(id)?.data?.childIds || []) {
      const child = byId.get(cid);
      if (!child) continue;
      c += child.type === 'jobcard' ? (cardMatch(child.data) ? 1 : 0) : countMatches(cid);
    }
    matchCount.set(id, c);
    return c;
  };

  // Band roots = this hub's jobgroups not referenced as anyone's child.
  const allChildIds = new Set();
  list.forEach(n => { if (n.data?.hubId === hubId && Array.isArray(n.data?.childIds)) n.data.childIds.forEach(c => allChildIds.add(c)); });
  const rootGroups = list.filter(n => n.data?.hubId === hubId && n.type === 'jobgroup' && !allChildIds.has(n.id));

  // Walk open paths; collect what should be VISIBLE (matching cards + non-empty
  // branches on an expanded path). Role leaves paginate over the MATCHING,
  // still-on-canvas cards: slicing raw childIds (the old behavior) let
  // non-matching cards and dismissed ghosts consume pagination slots, so an
  // expanded role under a source filter could render zero cards while matches
  // sat beyond the window. Layout positions whatever is revealed (it walks all
  // children and skips hidden), so window math lives only here.
  const visible = new Set();
  const walked = new Set();
  const walk = (id) => {
    // `countMatches` above is cycle-safe, but it only guards the count phase.
    // A malformed persisted childIds graph with a matching card in a cycle used
    // to recurse forever here while deriving visibility. Keep the first reached
    // node visible and skip repeated edges, which is both safe and recoverable.
    if (walked.has(id)) return;
    walked.add(id);
    const node = byId.get(id);
    if (!node) return;
    if (node.type === 'jobcard') { if (cardMatch(node.data)) visible.add(id); return; }
    if (countMatches(id) === 0) return;          // empty branch → removed
    visible.add(id);
    if (!node.data?.expanded) return;
    const childIds = Array.isArray(node.data?.childIds) ? node.data.childIds : [];
    const childrenAreCards = childIds.some(cid => byId.get(cid)?.type === 'jobcard');
    if (childrenAreCards) {
      childIds
        .filter(cid => { const c = byId.get(cid); return c?.type === 'jobcard' && cardMatch(c.data); })
        .slice(0, node.data?.visibleCount ?? ROLE_VISIBLE_DEFAULT)
        .forEach(cid => visible.add(cid));
    } else {
      childIds.forEach(walk);
    }
  };
  rootGroups.forEach(r => walk(r.id));

  // Legacy flat boards (saved before deterministic taxonomy recovery) have
  // jobcards wired directly to the hub with no group tree, so the walk above
  // never reaches them and would force them ALL hidden on filter/restore. Treat
  // each hub-owned jobcard that isn't any group's child as top-level and reveal
  // it iff it matches the filter — mirroring walk's jobcard branch. No-op on the
  // grouped path (those cards ARE in allChildIds, so the guard skips them).
  list.forEach(n => {
    if (n.type === 'jobcard' && n.data?.hubId === hubId && !allChildIds.has(n.id) && cardMatch(n.data)) {
      visible.add(n.id);
    }
  });

  // Apply hidden (+ clear any leftover opacity dim from the old filter approach).
  let changed = false;
  const withHidden = list.map(n => {
    if ((n.type !== 'jobcard' && n.type !== 'jobgroup') || n.data?.hubId !== hubId) return n;
    const hide = !visible.has(n.id);
    const dim = n.type === 'jobcard' && n.style?.opacity !== undefined && n.style.opacity !== 1;
    if (!!n.hidden === hide && !dim) return n;
    changed = true;
    const next = { ...n, hidden: hide };
    if (dim) { const { opacity: _opacity, ...rest } = n.style; next.style = rest; }
    return next;
  });
  // A card can change height without changing which tree nodes are visible
  // (most notably its local reasoning disclosure). In that case callers that
  // have just observed the new measurement must still be able to reflow the
  // visible tree; returning early here would leave later cards/roots at their
  // positions for the old height. Ordinary visibility/filter calls keep the
  // same-reference fast path, which avoids layout churn on initial card mounts.
  if (!changed && !forceLayout) return nodes;

  const hubPos = byId.get(hubId)?.position || { x: 0, y: 0 };
  const laidOutNodes = changed ? withHidden : list;
  const positions = computeLayoutPositions(laidOutNodes, hubId, COL_X_, hubPos);
  let positionChanged = false;
  const result = laidOutNodes.map(n => {
    const p = positions[n.id];
    if (p && (p.x !== n.position.x || p.y !== n.position.y)) {
      positionChanged = true;
      return { ...n, position: p };
    }
    return n;
  });
  // A forced reflow can be a no-op if the new measurement does not move any
  // visible descendant. Preserve referential stability in that case too.
  return changed || positionChanged ? result : nodes;
}


/**
 * Build the ReactFlow `newNodes` / `newEdges` arrays for the whole job subtree
 * (hiring-fit band → salary range → role → cards). Pure: emits arrays, calls no
 * ReactFlow setters.
 *
 * @param {object[]} displayedJobs  the scored jobs to show (post target-select)
 * @param {object} bucketTree  { likelihoodBands, salaryRanges, roles } from the
 *                              AI. Missing or incomplete taxonomy is rejected so
 *                              the caller can preserve the existing board.
 */
export function buildJobTreeNodes({
  displayedJobs,
  bucketTree,
  originalPos,
  hubId,
  baseNodeId,
}) {
  // A board must never manufacture cards from an absent or partial provider
  // response. Normalization below is limited to a successful taxonomy's
  // canonical labels/ranges; missing, duplicate, or unassigned roles are a
  // failed Combine and must leave the previous board untouched.
  const taxonomyCheck = validateJobBoardTaxonomy(bucketTree, displayedJobs.length);
  if (!taxonomyCheck.valid) {
    throw new Error(`Job Board taxonomy is invalid: ${taxonomyCheck.reason}`);
  }
  const newNodes = [];
  const newEdges = [];
  const edgeProps = structuralEdge('rgba(96,165,250,0.5)');
  let nextJobIdx = 0;

  const pushEdge = (s, t) => newEdges.push({ id: `edge-${s}-${t}`, source: s, target: t, ...edgeProps });

  const pushCard = (job) => {
    const id = `${baseNodeId}-job-${nextJobIdx++}`;
    newNodes.push({
      id,
      type: 'jobcard',
      position: { x: originalPos.x + COL_X.job, y: originalPos.y },
      hidden: true,
      data: {
        hubId,
        title: job.title, company: job.company, location: job.location,
        salary: job.salary, snippet: job.snippet, matchScore: job.matchScore,
        reasoning: job.reasoning, careerDirection: job.careerDirection,
        // Preserve the scorer's audit trail so a merged board never turns an
        // evidence-grounded hiring-fit assessment back into an opaque number. Some fields
        // are optional for legacy scores, but are copied verbatim when present.
        requirementAssessments: job.requirementAssessments,
        materialGaps: job.materialGaps,
        strengths: job.strengths,
        experienceAssessment: job.experienceAssessment,
        confidence: job.confidence,
        fitAssessment: job.fitAssessment,
        rawScore: job.rawScore,
        adjustedScore: job.adjustedScore,
        adjustments: job.adjustments,
        calibration: job.calibration,
        // Preserve the compensation research verbatim. JobCardNode normalizes
        // it defensively for legacy/future schemas, and it must travel through
        // every valid AI-taxonomized board tree.
        compensationAssessment: job.compensationAssessment,
        // Preference assessment is independent of hiring fit. Preserve it so
        // cards can explain why an otherwise equal-fit listing is ordered here.
        preferenceAssessment: job.preferenceAssessment,
        source: job.source, url: job.url, googleCardUrl: job.googleCardUrl,
        applySource: job.applySource, posted: job.posted, language: job.language,
        // The ORIGIN search module's id (the board merges cards from several
        // modules, each with its own career data) — the card's "Generate
        // Résumé" reads careerData from this hub. A string reference, not a
        // copy: the old per-card resumeProfile clone persisted N identical
        // profile objects into the canvas file and nothing ever read it.
        originHubId: job.originHubId || null, isNew: false,
      },
    });
    return id;
  };

  const pushGroup = (id, kind, label, childIds, count, { hidden = true, ...extra } = {}) => {
    newNodes.push({
      id,
      type: 'jobgroup',
      position: { x: originalPos.x + COL_X[kind], y: originalPos.y },
      hidden,
      data: {
        kind, hubId, label, count, childIds, expanded: false,
        ...(kind === 'role' ? { visibleCount: Math.min(ROLE_VISIBLE_DEFAULT, childIds.length) } : {}),
        ...extra,
      },
    });
  };

  // This is a validated provider taxonomy. Normalization retains fixed score
  // bands and canonical salary placement, while the caller rejects missing or
  // incomplete role assignments before this renderer can replace a board.
  const taxonomy = sanitizeJobTaxonomy(
    bucketTree,
    displayedJobs.length,
    displayedJobs.map(job => job?.salary),
    displayedJobs,
  );
  const bands = taxonomy.likelihoodBands;
  const { real: realRanges, unspecified } = normalizeRanges(taxonomy.salaryRanges);

  // index → role name. validateJobBoardTaxonomy guarantees complete, unique coverage.
  const roleByIdx = new Map();
  taxonomy.roles.forEach(role => {
    role.jobIndices.forEach(index => roleByIdx.set(index, role.name));
  });

  // Group every displayed job: band → range → role → jobs[]
  const tree = new Map(); // bandLabel -> Map(rangeLabel -> Map(roleName -> jobs[]))
  displayedJobs.forEach((job, index) => {
    const band = placeBand(job.matchScore, bands);
    const range = placeRange(parseSalaryToNumeric(job.salary), realRanges, unspecified);
    const role = roleByIdx.get(index);
    if (!tree.has(band.label)) tree.set(band.label, new Map());
    const byRange = tree.get(band.label);
    if (!byRange.has(range.label)) byRange.set(range.label, new Map());
    const byRole = byRange.get(range.label);
    if (!byRole.has(role)) byRole.set(role, []);
    byRole.get(role).push(job);
  });

  // Emit in canonical order: bands high→low, ranges high→low (Unspecified
  // last), roles A→Z, cards score-desc.
  const orderedRanges = [...realRanges, unspecified];
  let bi = 0;
  for (const band of bands) {
    const byRange = tree.get(band.label);
    if (!byRange) continue;
    const bandId = `${baseNodeId}-L${bi++}`;
    const bandChildIds = [];
    let bandCount = 0;
    let si = 0;
    for (const range of orderedRanges) {
      const byRole = byRange.get(range.label);
      if (!byRole) continue;
      const rangeId = `${bandId}-S${si++}`;
      const rangeChildIds = [];
      let rangeCount = 0;
      const roleNames = [...byRole.keys()].sort((a, b) => a.localeCompare(b));
      let ri = 0;
      for (const roleName of roleNames) {
        const jobs = [...byRole.get(roleName)].sort(compareJobsByFitAndPreference);
        const roleId = `${rangeId}-R${ri++}`;
        const cardIds = jobs.map(j => { const cid = pushCard(j); pushEdge(roleId, cid); return cid; });
        pushGroup(roleId, 'role', roleName, cardIds, cardIds.length);
        pushEdge(rangeId, roleId);
        rangeChildIds.push(roleId);
        rangeCount += cardIds.length;
      }
      pushGroup(rangeId, 'salary', range.label, rangeChildIds, rangeCount, {
        minSalary: range.minSalary, maxSalary: range.maxSalary,
      });
      pushEdge(bandId, rangeId);
      bandChildIds.push(rangeId);
      bandCount += rangeCount;
    }
    // Band nodes are the visible roots; everything below starts collapsed.
    pushGroup(bandId, 'likelihood', band.label, bandChildIds, bandCount, {
      hidden: false, minScore: band.minScore, maxScore: band.maxScore,
    });
    pushEdge(hubId, bandId);
  }

  // ── Lay out the collapsed tree ───────────────────────────────────────────
  // Everything spawns COLLAPSED — the band roots are visible (hidden:false) but
  // closed, and all ranges/roles/cards stay hidden until the user expands. One
  // layout pass stacks the band roots (they all spawn at the same y otherwise).
  const layoutPos = computeLayoutPositions(newNodes, hubId, COL_X, originalPos);
  newNodes.forEach(n => { if (layoutPos[n.id]) n.position = layoutPos[n.id]; });

  // Slider iterates over spawned scores.
  const spawnedScores = displayedJobs.map(j => j.matchScore || 0);
  const scoreRangeMin = spawnedScores.length > 0 ? Math.min(...spawnedScores) : 0;
  const scoreRangeMax = spawnedScores.length > 0 ? Math.max(...spawnedScores) : 100;

  return { newNodes, newEdges, scoreRangeMin, scoreRangeMax, taxonomy };
}
