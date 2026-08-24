/**
 * Pure compensation helpers used by the job-search IPC pipeline.  These
 * deliberately own the final red/green decision: an LLM may summarize sources,
 * but it cannot accidentally add a hidden safety margin or value benefits.
 */

import { inferSalaryCurrency } from '../../src/utils/salaryCurrency.js';

const VARIABLE_PAY_RE = /\b(?:commission(?:[-\s]?only)?|tips?|on[-\s]?target earnings|OTE|bonus(?:es)?|equity|stock(?:\s+options?)?|restricted stock|RSUs?|total\s+(?:comp(?:ensation)?|rewards?))\b/i;
const NON_CASH_RE = /\b(?:medical|dental|vision|health(?:care)? benefits?|insurance|retirement|pension|401\s*\(?k\)?|paid time off|PTO)\b/i;
const BASE_PAY_RE = /\b(?:base salary|base pay|salary range|salary|hourly rate|pay range|wage|rate)\b/i;
const MONEY_RE = /(?:US\$|C\$|CA\$|CAD\s*|USD\s*|\$|€|£)\s*([\d,.]+)\s*([km])?/gi;

function amount(raw, suffix = '') {
  const n = Number(String(raw).replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n * (/k/i.test(suffix) ? 1000 : /m/i.test(suffix) ? 1000000 : 1);
}

function currencyFor(text, fallback = '') {
  if (/C\$|CA\$|\bCAD\b/i.test(text)) return 'CAD';
  if (/US\$|\bUSD\b/i.test(text)) return 'USD';
  if (/€/.test(text)) return 'EUR';
  if (/£/.test(text)) return 'GBP';
  return fallback || '';
}

function bareSalaryAmounts(text, cadence) {
  const values = [];
  for (const match of String(text || '').matchAll(/\b([\d,.]+)\s*([km])\b/gi)) {
    const value = amount(match[1], match[2]);
    if (value) values.push(value);
  }
  // A bare hourly figure such as "45 per hour" is still unambiguous inside a
  // dedicated salary field. Do not accept arbitrary small bare numbers for an
  // annual salary; those are commonly hours, shifts, or experience years.
  if (cadence === 'hourly' && values.length === 0) {
    const hourly = String(text || '').match(/\b([\d,.]+)\s*(?:\/\s*(?:h|hr|hour)|(?:per|an?)\s+(?:hour|hr))\b/i);
    const value = hourly ? amount(hourly[1]) : null;
    if (value) values.push(value);
  }
  if (cadence === 'annual' && values.length === 0) {
    for (const match of String(text || '').matchAll(/\b(\d{4,8}(?:\.\d+)?)\b/g)) {
      const value = amount(match[1]);
      if (value >= 10000 && value <= 10000000) values.push(value);
    }
  }
  return values;
}

function rangeSalaryAmounts(text, cadence) {
  const match = String(text || '').match(
    /(?:US\$|C\$|CA\$|CAD\s*|USD\s*|\$|€|£)?\s*([\d,.]+)\s*([km])?\s*(?:[-–—]|\bto\b)\s*(?:US\$|C\$|CA\$|CAD\s*|USD\s*|\$|€|£)?\s*([\d,.]+)\s*([km])?/i,
  );
  if (!match) return [];
  let leftSuffix = match[2] || '';
  let rightSuffix = match[4] || '';
  // Common shorthand: "$80–100k" or "$80k–100". A suffix on either side
  // applies to both endpoints when the other endpoint is a small shorthand.
  if (!leftSuffix && rightSuffix && Number(String(match[1]).replace(/,/g, '')) < 1000) leftSuffix = rightSuffix;
  if (!rightSuffix && leftSuffix && Number(String(match[3]).replace(/,/g, '')) < 1000) rightSuffix = leftSuffix;
  const values = [amount(match[1], leftSuffix), amount(match[3], rightSuffix)].filter(Boolean);
  if (values.length !== 2) return [];
  if (cadence === 'annual' && values.some(value => value < 10000)) return [];
  return values;
}

// Remove money values which belong to a non-guaranteed component without
// assuming that the "base salary" label comes before the base figure.  Job
// boards commonly write either "$80k–$100k base salary + bonus" or
// "base salary $80k–$100k + bonus"; slicing from the marker made the former
// look like an unparseable offer and could make an OTE figure look like base
// pay when its marker followed the number.  This deliberately only removes a
// value when it is close to an excluded label, leaving the base value for the
// regular range parser below.
function removeExcludedPayAmounts(text) {
  const money = String.raw`(?:US\$|C\$|CA\$|CAD\s*|USD\s*|\$|€|£)?\s*[\d,.]+\s*[km]?`;
  const excluded = String.raw`(?:commission(?:[-\s]?only)?|tips?|on[-\s]?target earnings|OTE|bonus(?:es)?|equity|stock(?:\s+options?)?|restricted stock|RSUs?|total\s+(?:comp(?:ensation)?|rewards?)|medical|dental|vision|health(?:care)? benefits?|insurance|retirement|pension|401\s*\(?k\)?|paid time off|PTO)`;
  // "€100k OTE", "equity worth $100k", "bonus: $20,000", and the
  // occasional parenthetical qualifier are all treated as excluded.  A short
  // bounded gap avoids deleting a separate base-pay sentence elsewhere in a
  // long scraped description.
  return String(text || '')
    .replace(new RegExp(`${money}(?:\\s|,|:|\\(|\\[|\\-|–|—|/){0,8}(?:worth\\s+|up\\s+to\\s+|target\\s+)?${excluded}\\b`, 'gi'), ' ')
    .replace(new RegExp(`${excluded}\\b(?:\\s|,|:|\\(|\\[|\\+|\\-|–|—|/){0,12}(?:worth\\s+|up\\s+to\\s+|target\\s+)?${money}`, 'gi'), ' ');
}

// When a listing explicitly labels an amount as base salary/base pay, prefer
// that local span over broad clause surgery.  In particular,
// "commission + $80k base salary" is a usable $80k offer—not a commission
// figure—and the inverse wording is equally common.  Keeping only the marked
// span also ensures a following OTE/bonus number cannot leak back in.
function explicitBasePayText(text) {
  const money = String.raw`(?:US\$|C\$|CA\$|CAD\s*|USD\s*|\$|€|£)?\s*[\d,.]+\s*[km]?`;
  // The unit belongs to the base figure too. Leaving `/hour`, `/week`, or
  // `/month` behind while extracting the marked span would silently turn a
  // valid rate into an annual $45/$2,000/$8,000 offer.
  const cadence = String.raw`(?:\s*(?:\/\s*(?:h|hr|hour|wk|week|mo|month|day)|(?:per|an?)\s+(?:hour|hr|week|wk|month|mo|day|year)|\b(?:hourly|weekly|monthly|daily|annual(?:ly)?|yearly)\b))?`;
  const cashAmount = String.raw`${money}(?:\s*(?:[-–—]|\bto\b)\s*${money})?${cadence}`;
  const portions = [];
  const seen = new Set();
  const add = (match) => {
    const value = String(match || '').trim();
    if (value && !seen.has(value.toLowerCase())) {
      seen.add(value.toLowerCase());
      portions.push(value);
    }
  };
  const trailing = new RegExp(`(${cashAmount})\\s*(?:annual\\s+)?base\\s+(?:salary|pay)\\b`, 'gi');
  const leading = new RegExp(`\\bbase\\s+(?:salary|pay)\\s*(?::|is|of|-)?\\s*(${cashAmount})`, 'gi');
  for (const match of String(text || '').matchAll(trailing)) add(match[1]);
  for (const match of String(text || '').matchAll(leading)) add(match[1]);
  return portions.length ? portions.join(' ') : '';
}

/** Parse only stated, recurring cash compensation. Never manufactures an offer. */
export function parseGuaranteedCashOffer(job = {}, comparisonLocation = null) {
  // Scrapers occasionally leave `salary` as whitespace while preserving a
  // populated fallback compensation field. `||` would treat that whitespace
  // as present and skip a usable offer entirely.
  const text = [job.salary, job.compensation]
    .map(value => String(value ?? '').trim())
    .find(Boolean) || '';
  if (!text) return { usable: false, reasonCode: 'no_cash_salary' };
  // OTE, tips, and commission are not guaranteed salary. A separately stated
  // base remains usable, but never let a second variable-pay figure inflate the
  // range: evaluate only the portion before an additive "plus" clause.
  const explicitBase = BASE_PAY_RE.test(text);
  const containsExcludedComponent = VARIABLE_PAY_RE.test(text) || NON_CASH_RE.test(text);
  if (containsExcludedComponent && !explicitBase) {
    return { usable: false, reasonCode: 'variable_or_non_cash_only' };
  }
  // Strip *associated* OTE/bonus/equity/benefit values instead of slicing at
  // the base marker. Labels frequently appear after a range, so slicing loses
  // the actual base offer; conversely, merely cutting after the first OTE can
  // retain an OTE amount. See removeExcludedPayAmounts for the bounded forms.
  const markedBase = containsExcludedComponent ? explicitBasePayText(text) : '';
  let cashText = markedBase || (containsExcludedComponent ? removeExcludedPayAmounts(text) : text);
  // With an explicitly marked base span there is nothing left to trim. For
  // unmarked salary fields retain the old conservative additive-clause cutoff.
  if (!markedBase) cashText = cashText.split(/\s*(?:\+|\bplus\b)\s*/i)[0];
  const cadence = /(?:\/\s*(?:h|hr|hour)|(?:per|an?)\s+(?:hour|hr)|\bhourly\b)/i.test(cashText)
    ? 'hourly'
    : /(?:\/\s*(?:wk|week)|per\s+week|\bweekly\b)/i.test(cashText)
      ? 'weekly'
      : /(?:\/\s*(?:mo|month)|per\s+month|\bmonthly\b)/i.test(cashText)
        ? 'monthly'
        : /(?:\/\s*(?:day)|per\s+day|\bdaily\b)/i.test(cashText)
          ? 'daily'
          : 'annual';
  const rangeAmounts = rangeSalaryAmounts(cashText, cadence);
  const symbolAmounts = [...cashText.matchAll(MONEY_RE)].map(m => amount(m[1], m[2])).filter(Boolean);
  const numbers = rangeAmounts.length ? rangeAmounts : symbolAmounts.length ? symbolAmounts : bareSalaryAmounts(cashText, cadence);
  if (!numbers.length) return { usable: false, reasonCode: 'unparseable_cash_salary' };
  // "From", "minimum", and "starting" state only a floor, not the maximum
  // the applicant could receive. They cannot support the product's exact
  // maximum-vs-market-floor comparison. An explicit range still has a maximum
  // and remains usable; "up to" deliberately does not match this rule.
  if (!rangeAmounts.length && /\b(?:from|minimum|min\.?|starting(?:\s+(?:at|from|salary|pay))?|begins?\s+(?:at|from))\b/i.test(cashText)) {
    return { usable: false, reasonCode: 'salary_maximum_unstated' };
  }
  const scheduleText = `${text} ${job.snippet || ''} ${job.description || ''}`;
  let multiplier = 1;
  if (cadence === 'hourly') {
    const hoursMatch = scheduleText.match(/\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\s*(?:\/|per)?\s*(?:week|wk)\b/i);
    const hoursPerWeek = hoursMatch ? Number(hoursMatch[1]) : /\bfull[ -]?time\b/i.test(scheduleText) ? 40 : 0;
    if (!(hoursPerWeek > 0 && hoursPerWeek <= 168)) return { usable: false, reasonCode: 'hourly_hours_unclear' };
    multiplier = hoursPerWeek * 52;
  } else if (cadence === 'weekly') {
    multiplier = 52;
  } else if (cadence === 'monthly') {
    multiplier = 12;
  } else if (cadence === 'daily') {
    return { usable: false, reasonCode: 'daily_schedule_unclear' };
  }
  const annualized = cadence !== 'annual';
  const values = annualized ? numbers.map(n => Math.round(n * multiplier)) : numbers;
  const [min, max] = [Math.min(...values), Math.max(...values)];
  const fixed = values.length === 1;
  const comparisonDisplay = typeof comparisonLocation === 'string'
    ? comparisonLocation
    : comparisonLocation?.display || '';
  const inferred = inferSalaryCurrency(text, comparisonDisplay || job.location || '');
  const currency = currencyFor(text, String(job.currency || '').toUpperCase()) || inferred?.currency || '';
  if (!currency) return { usable: false, reasonCode: 'currency_unclear' };
  if (/\bstarting\s+(?:at|from)\b/i.test(text) && !/\b(?:to|–|—|-)\b/.test(text)) {
    return { usable: false, reasonCode: 'salary_maximum_unstated' };
  }
  return { usable: true, min, max, fixed, currency, period: 'annual', annualized, raw: text.slice(0, 500) };
}

export function mergeCompetitiveRanges(ranges, currency = '') {
  const expectedCurrency = String(currency || '').trim().toUpperCase();
  const valid = (Array.isArray(ranges) ? ranges : []).filter(r =>
    Number.isFinite(Number(r?.min)) && Number(r.min) > 0 &&
    Number.isFinite(Number(r?.max)) && Number(r.max) >= Number(r.min) &&
    // A research range with no stated currency cannot safely be compared to a
    // listing amount. Do not silently treat it as the offer currency.
    (!expectedCurrency || String(r?.currency || '').trim().toUpperCase() === expectedCurrency),
  );
  if (!valid.length) return null;
  // Credible comparable ranges are unioned, deliberately producing the broad
  // A–D band requested by the product rather than treating disagreement as an
  // automatic uncertainty.
  return {
    min: Math.min(...valid.map(r => Number(r.min))),
    max: Math.max(...valid.map(r => Number(r.max))),
    currency: expectedCurrency || String(valid[0].currency || '').trim().toUpperCase(),
    period: 'annual',
  };
}

export function compensationAssessment({ offer, competitiveRanges, comparisonLocation = null, justification = '', sourceLinks = [], researchedAt = new Date().toISOString(), reasonCode = '' } = {}) {
  const base = {
    schemaVersion: 1,
    status: 'not_evaluated',
    reasonCode: reasonCode || 'no_cash_salary',
    offered: offer?.usable ? offer : null,
    competitiveRange: null,
    comparisonLocation,
    justification: String(justification || '').slice(0, 2400),
    sourceLinks: sanitizeLinks(sourceLinks),
    researchedAt,
  };
  if (!offer?.usable) {
    if (!base.justification) base.justification = 'No stated guaranteed recurring cash salary was available to compare.';
    return base;
  }
  const merged = mergeCompetitiveRanges(competitiveRanges, offer.currency);
  if (!merged) {
    return { ...base, status: 'uncertain', reasonCode: reasonCode || 'market_range_unavailable', justification: base.justification || 'A comparable competitive cash-salary range could not be established.' };
  }
  // This is the entire threshold: the stated maximum (or fixed amount) must
  // reach the merged competitive floor. No buffer is applied.
  const status = offer.max < merged.min ? 'below_market' : 'competitive';
  const money = (value) => `${offer.currency ? `${offer.currency} ` : ''}${Math.round(value).toLocaleString('en-US')}`;
  const decision = status === 'below_market'
    ? `The listing's highest stated guaranteed cash salary (${money(offer.max)}) is below the merged competitive floor (${money(merged.min)}).`
    : `The listing's highest stated guaranteed cash salary (${money(offer.max)}) reaches or exceeds the merged competitive floor (${money(merged.min)}).`;
  const explanation = [base.justification, decision].filter(Boolean).join(' ').slice(0, 2400);
  return {
    ...base,
    status,
    reasonCode: status === 'below_market' ? 'offered_max_below_competitive_floor' : 'offered_reaches_competitive_floor',
    competitiveRange: merged,
    justification: explanation,
  };
}

export function resolveCompensationLocation(job = {}, context = {}, remoteResidences = {}) {
  const jobText = `${job.location || ''} ${job.snippet || ''}`;
  const statedWorkMode = String(context.workMode || '').trim().toLowerCase();
  const workMode = ['remote', 'hybrid', 'onsite', 'on_site'].includes(statedWorkMode)
    ? statedWorkMode
    : (job.remote === true || /\bremote\b/i.test(jobText) ? 'remote' : 'unknown');
  if (workMode !== 'remote') {
    const location = String(job.location || '').trim();
    return location ? { kind: 'job_location', display: location } : null;
  }
  const region = String(context.remoteRegion || '').trim().toLowerCase();
  const permittedCountry = String(context.remoteCountry || '').trim();
  const key = region === 'usa' || region === 'us'
    ? 'usa'
    : region === 'canada' || region === 'ca'
      ? 'canada'
      : region === 'other' || /^(?:worldwide|global|anywhere)$/i.test(region)
        ? 'other'
        : /^(?:united states(?: of america)?|usa|us)$/i.test(permittedCountry)
          ? 'usa'
          : /^canada$/i.test(permittedCountry)
            ? 'canada'
            : permittedCountry
              ? 'other'
              : '';
  const value = key ? remoteResidences?.[key] : null;
  const country = String(value?.country || value?.countryCode || '').trim();
  // A malformed saved residence must only make this optional comparison
  // uncertain; it must never be treated as a credible salary market.
  if (!key || !country || value?.countryConflict) return null;
  if (key === 'other' && permittedCountry
    && !/^(?:worldwide|global|anywhere|multiple|unspecified|unknown)$/i.test(permittedCountry)
    && permittedCountry.localeCompare(country, undefined, { sensitivity: 'base' }) !== 0) return null;
  const bits = [value.city, value.subdivision, country].map(v => String(v || '').trim()).filter(Boolean);
  return { kind: `remote_${key}_residence`, key, country, display: bits.join(', ') };
}

/**
 * Should this job get the competitive-pay check at all?
 *
 * Every cohort that reaches research costs TWO model calls (a grounded market
 * lookup plus an assessment), and cohorts fragment by location — so an ungated
 * 42-job run can spend dozens of calls and exhaust the shared provider quota
 * that scoring and bucketing also draw on. A pay comparison only changes a
 * decision on a job the user could realistically pursue, so it is reserved for
 * the stronger matches.
 *
 * Returns a TRI-STATE, not a boolean, because "we checked and this job scored
 * below the bar" and "we never got a score for this job" are different facts
 * and must reach the user as different reasons. Collapsing them would tell
 * someone their job was judged a weak match when it was never judged at all.
 *
 * `unscoredSentinel` is the scorer's fixed placeholder value for a job the AI
 * could not score. It is a marker, not an assessment, so it counts as unknown.
 * PURE, so the boundary is directly unit-testable.
 */
export function classifyCompensationFitEligibility(rawScore, { minScore, unscoredSentinel = null } = {}) {
  const known = typeof rawScore === 'number'
    && Number.isFinite(rawScore)
    && !(unscoredSentinel !== null && rawScore === unscoredSentinel);
  if (!known) return 'score-unavailable';
  return rawScore >= minScore ? 'eligible' : 'below-threshold';
}

export function compensationCohortKey({ job, context, location, offer }) {
  return [
    String(context?.roleFamily || job?.title || '').trim().toLowerCase(),
    String(context?.seniority || 'unspecified').toLowerCase(),
    // A "senior" role asking for 3 years is not interchangeable with one
    // asking for 10. This also prevents the 30-day live-research cache from
    // serving an evidence set for materially different experience asks.
    String(context?.requiredYears || 'unspecified').trim().toLowerCase(),
    String(context?.employmentType || 'unspecified').toLowerCase(),
    String(location?.display || '').toLowerCase(),
    String(offer?.currency || '').toUpperCase(),
  ].join('|');
}

/** A verdict-driving market range must have a human-auditable web source. */
export function isAuditableCompensationSource(source) {
  const title = String(source?.sourceName || source?.title || '').trim();
  const url = String(source?.sourceUrl || source?.url || '').trim();
  if (!title || !url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Keep the exact same bounded evidence set for the mathematical union and the
 * card disclosure. When a cohort has many sources, preserve the source that
 * sets the merged floor and the one that sets its ceiling first, then fill in
 * original research order. That avoids a hidden sixth range changing a card's
 * verdict or displayed market band.
 */
export function selectComparableEvidence(ranges, maxSources = 5, expectedCurrency = '') {
  const limit = Math.max(1, Math.floor(Number(maxSources) || 5));
  const currency = String(expectedCurrency || '').trim().toUpperCase();
  const seenUrls = new Set();
  const candidates = (Array.isArray(ranges) ? ranges : []).filter((range) => {
    if (range?.comparable !== true || !isAuditableCompensationSource(range)) return false;
    const min = Number(range.min);
    const max = Number(range.max);
    if (!(Number.isFinite(min) && min > 0 && Number.isFinite(max) && max >= min)) return false;
    // Never let an unconverted foreign-currency source consume one of the
    // bounded display/verdict slots. The assessment code does not convert
    // currencies, so source evidence must already be in the offer currency.
    if (currency && String(range.currency || '').trim().toUpperCase() !== currency) return false;
    const url = String(range.sourceUrl || range.url || '').trim();
    if (seenUrls.has(url)) return false;
    seenUrls.add(url);
    return true;
  });
  if (candidates.length <= limit) return candidates;
  const floor = candidates.reduce((best, range) => Number(range.min) < Number(best.min) ? range : best, candidates[0]);
  const ceiling = candidates.reduce((best, range) => Number(range.max) > Number(best.max) ? range : best, candidates[0]);
  const selected = [];
  const add = (range) => { if (range && !selected.includes(range) && selected.length < limit) selected.push(range); };
  add(floor);
  add(ceiling);
  for (const range of candidates) add(range);
  return selected;
}

function sanitizeLinks(links) {
  return (Array.isArray(links) ? links : []).map((value) => {
    const source = value && typeof value === 'object' ? value : null;
    const url = String(source?.url || source?.sourceUrl || value || '').trim();
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    } catch { return null; }
    if (!source) return url;
    const min = Number(source.min);
    const max = Number(source.max);
    return {
      title: String(source.title || source.sourceName || '').trim() || url,
      url,
      ...(Number.isFinite(min) && min > 0 ? { min } : {}),
      ...(Number.isFinite(max) && max > 0 ? { max } : {}),
      currency: String(source.currency || '').trim().toUpperCase(),
      note: String(source.note || '').trim().slice(0, 500),
    };
  }).filter(Boolean).slice(0, 5);
}
