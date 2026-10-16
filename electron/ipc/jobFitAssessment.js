/**
 * Deterministic normalization and calibration for the job-fit assessment
 * returned by an LLM.  The model may identify requirements and cite evidence;
 * this module decides whether those citations are actually present in the
 * supplied posting and candidate record, and applies transparent score caps.
 * Scores express hiring fit across the full decision process—not a statistical
 * likelihood forecast or a prediction of an employer's final decision.
 */

const PRIORITIES = new Set(['critical', 'important', 'preferred', 'required', 'contextual']);
// These are evidence classifications, not assertions about what the candidate
// has or has not done. In particular, `not_documented` only says that the
// supplied career record does not establish a match.
const STATUSES = new Set(['direct', 'adjacent', 'not_documented', 'contradicted', 'unclear']);
const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9,
  nov: 10, november: 10, dec: 11, december: 11,
};

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeText(value) {
  return text(value).replace(/\s+/g, ' ').toLocaleLowerCase();
}

function clampScore(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function normalizePriority(value) {
  const normalized = normalizeText(value);
  if (normalized === 'required') return 'critical';
  // Context can help explain a role but is not a candidate deficiency. Keep it
  // out of material-gap and score-cap logic just as a preferred signal is.
  if (normalized === 'contextual') return 'preferred';
  if (PRIORITIES.has(normalized)) return normalized;
  if (['must', 'must-have', 'required', 'high', 'highest'].includes(normalized)) return 'critical';
  if (['nice-to-have', 'nice to have', 'optional', 'low'].includes(normalized)) return 'preferred';
  return 'important';
}

function reportedPriority(value) {
  const normalized = normalizeText(value);
  if (PRIORITIES.has(normalized)) return normalized;
  if (['must', 'must-have', 'high', 'highest'].includes(normalized)) return 'required';
  if (['nice-to-have', 'nice to have', 'optional', 'low'].includes(normalized)) return 'preferred';
  return 'important';
}

function normalizeStatus(value) {
  const normalized = normalizeText(value);
  if (STATUSES.has(normalized)) return normalized;
  if (['match', 'matched', 'strong', 'meets', 'yes'].includes(normalized)) return 'direct';
  if (['transferable', 'partial', 'partially matched', 'related', 'near'].includes(normalized)) return 'adjacent';
  if (['contradiction', 'conflict', 'conflicts', 'conflicted', 'incompatible', 'inconsistent'].includes(normalized)) return 'contradicted';
  // `missing` was the first schema's name for absent support. Keep accepting
  // it—and common provider variants—but expose only the less categorical
  // canonical status. A concise supplied record is not a complete biography.
  if ([
    'missing', 'absent', 'not documented', 'not_documented', 'not evidenced',
    'not supported', 'unsupported', 'no support', 'no evidence', 'no documented evidence',
    'not established', 'gap', 'unmet', 'no', 'none', 'not met',
  ].includes(normalized)) return 'not_documented';
  if (/^(?:no|without)\b.*\b(?:support|evidence|documentation)\b/.test(normalized)
    || /\b(?:missing|absent|unsupported|unmet)\b/.test(normalized)) return 'not_documented';
  return 'unclear';
}

function quotes(value) {
  const values = Array.isArray(value) ? value : [value];
  return values
    .map(item => text(typeof item === 'object' && item ? (item.quote ?? item.text ?? item.evidence) : item))
    .filter(Boolean)
    .filter((quote, index, list) => list.indexOf(quote) === index);
}

function groundedQuotes(source, evidence) {
  const normalizedSource = normalizeText(source);
  const supplied = quotes(evidence);
  const grounded = supplied.filter(quote => normalizedSource.includes(normalizeText(quote)));
  return { supplied, grounded, allGrounded: supplied.length > 0 && grounded.length === supplied.length };
}

function rowsDuplicate(left, right) {
  const leftEvidence = quotes(left?.jobEvidence ?? left?.jobQuote ?? left?.postingEvidence ?? left?.requirementEvidence)
    .map(normalizeText).filter(Boolean);
  const rightEvidence = quotes(right?.jobEvidence ?? right?.jobQuote ?? right?.postingEvidence ?? right?.requirementEvidence)
    .map(normalizeText).filter(Boolean);
  // The source evidence is the more stable identity. Only fall back to the
  // requirement label if an evidence quote cannot distinguish the two rows:
  // once both sides carry evidence, that evidence is decisive either way, or
  // two unrelated label-less rows would collide on the same synthesized
  // placeholder (e.g. both falling back to "Requirement 1").
  if (leftEvidence.length && rightEvidence.length) {
    return leftEvidence.some(quote => rightEvidence.includes(quote));
  }
  const leftLabel = normalizeText(rowLabel(left, 0));
  const rightLabel = normalizeText(rowLabel(right, 0));
  return Boolean(leftLabel && rightLabel && leftLabel === rightLabel);
}

function rowCollection(raw) {
  if (!raw || typeof raw !== 'object') return [];
  let requirements = [];
  for (const key of ['requirements', 'requirementRows', 'requirementAssessments', 'rows']) {
    if (Array.isArray(raw[key])) {
      requirements = raw[key];
      break;
    }
  }
  const disclosedGaps = Array.isArray(raw.materialGaps) ? raw.materialGaps : [];
  // A separately disclosed grounded gap cannot be allowed to bypass the
  // requirement inventory and score calibration. Preserve it unless the main
  // array already represents the same posting evidence (or, without usable
  // evidence, the same requirement label).
  const merged = [];
  for (const row of [...requirements, ...disclosedGaps]) {
    if (!merged.some(prior => rowsDuplicate(prior, row))) merged.push(row);
  }
  return merged;
}

function rowLabel(row, index) {
  return text(row?.requirementText ?? row?.requirement ?? row?.name ?? row?.title ?? row?.label) || `Requirement ${index + 1}`;
}

export function nonScoringJobConstraintKind(row) {
  const source = normalizeText([
    rowLabel(row, 0),
    ...quotes(row?.jobEvidence ?? row?.jobQuote ?? row?.postingEvidence ?? row?.requirementEvidence),
  ].join(' '));
  if (!source) return null;

  // A posting can combine an authorization condition with a separately scored
  // professional credential in one terse requirement row.  Exempting that
  // whole row because it mentions citizenship would also exempt an active
  // clearance, license, or certification, contrary to the scoring rubric.
  // Keep such rows professional: the auditor can still show the logistical
  // wording, but cannot silently erase the credential from fit calibration.
  const includesProfessionalCredential = /\b(?:security\s+clearance|top\s+secret|secret\s+clearance|ts\s*\/?\s*sci|public\s+trust|professional\s+licen[cs]e|licensed\s+(?:engineer|architect|accountant|nurse|attorney)|\b(?:cpa|rn|p\.?eng)\b|bar\s+admission|board[- ]?certif(?:ied|ication))\b/.test(source);
  if (includesProfessionalCredential) return null;

  // These are application logistics, not evidence of professional capability.
  // Keep them in the requirement audit so a person can still see the posting's
  // constraint, but never let them lower the hiring-fit score or confidence.
  if (/\b(?:work|employment)\s+(?:authori[sz]ation|eligibility)\b/.test(source)
    || /\b(?:authori[sz]ed|eligible|entitled|cleared)\s+to\s+work\b/.test(source)
    || /\bright\s+to\s+work\b/.test(source)
    || /\bvisa\s+sponsorship\b/.test(source)
    || /\bsponsorship\s+(?:is\s+)?(?:not\s+)?(?:available|required|provided)\b/.test(source)
    || /\bu\.?s\.?\s+citizen(?:ship)?\b/.test(source)
    || /\bcitizenship\s+(?:is\s+)?required\b/.test(source)
    || /\bpermanent\s+(?:u\.?s\.?\s+)?resident\b/.test(source)
    || /\bgreen\s+card\b/.test(source)) {
    return 'work-authorization';
  }

  if (/\b(?:work[- ]?location|location\s+(?:availability|requirement)|relocation|onsite\s+availability|on[- ]site\s+availability|current\s+u\.?s\.?\s+base)\b/.test(source)
    || /\bbased\s+in\s+(?:the\s+)?[a-z]/.test(source)
    || /\bmust\s+be\s+(?:based|located|resident|residing)\s+(?:in|within)\b/.test(source)
    || /\b(?:located|reside|residing)\s+within\b/.test(source)
    || /\bwilling(?:ness)?\s+to\s+(?:work|be)\s+on[- ]?site\b/.test(source)
    || /\bwilling(?:ness)?\s+to\s+relocate\b/.test(source)
    || /\bwork\s+on[- ]?site\s+(?:in|at)\b/.test(source)
    || /\b(?:on[- ]?site|hybrid)\s+(?:in|at)\s+[a-z]/.test(source)
    || /\bremote\s+(?:within|from|only\s+in)\b/.test(source)) {
    return 'location';
  }
  return null;
}

export function isMaterialGap(priority, status, requirementGrounded, scoreImpact = 'scored') {
  return requirementGrounded
    && scoreImpact === 'scored'
    && priority !== 'preferred'
    && (status === 'not_documented' || status === 'contradicted' || status === 'unclear');
}

function normalizeRequirement(row, index, { jobText, candidateText }) {
  const reportedStatus = normalizeStatus(row?.evidenceStatus ?? row?.status ?? row?.match ?? row?.fit);
  const job = groundedQuotes(jobText, row?.jobEvidence ?? row?.jobQuote ?? row?.postingEvidence ?? row?.requirementEvidence);
  const candidate = groundedQuotes(candidateText, row?.candidateEvidence ?? row?.candidateQuote ?? row?.profileEvidence ?? row?.careerEvidence);
  // An invented requirement cannot count against the candidate. It remains in
  // the audit so an implementation can expose the model error rather than
  // quietly make the row disappear.
  const requirementGrounded = job.allGrounded;
  // A contradiction is a claim about the supplied candidate record just as a
  // direct or adjacent match is. It must therefore quote that record; without
  // a grounded quote it is merely unclear, never a factual conflict.
  const candidateClaim = ['direct', 'adjacent', 'contradicted'].includes(reportedStatus);
  const candidateClaimGrounded = !candidateClaim || candidate.allGrounded;
  const effectiveStatus = candidateClaim && (!requirementGrounded || !candidateClaimGrounded)
    ? 'unclear'
    : reportedStatus;
  const rawPriority = row?.priority ?? row?.importance ?? row?.weight;
  const priority = normalizePriority(rawPriority);
  const scoreExclusionReason = nonScoringJobConstraintKind(row);
  const scoreImpact = scoreExclusionReason ? 'informational' : 'scored';
  const materialGap = isMaterialGap(priority, effectiveStatus, requirementGrounded, scoreImpact);
  return {
    id: text(row?.id) || `requirement-${index + 1}`,
    requirement: rowLabel(row, index),
    reportedPriority: reportedPriority(rawPriority),
    priority,
    scoreImpact,
    scoreExclusionReason,
    reportedStatus,
    effectiveStatus,
    jobEvidence: job.grounded,
    candidateEvidence: candidate.grounded,
    grounding: {
      requirementGrounded,
      candidateClaimGrounded,
      rejectedJobEvidence: job.supplied.filter(quote => !job.grounded.includes(quote)),
      rejectedCandidateEvidence: candidate.supplied.filter(quote => !candidate.grounded.includes(quote)),
    },
    materialGap,
    note: text(row?.note ?? row?.reason ?? row?.explanation ?? row?.impact),
  };
}

function monthIndex(year, month) {
  return year * 12 + month;
}

// ---------------------------------------------------------------------------
// One date reader for every consumer.
//
// A career record states a period in many equivalent spellings ("March 2017",
// "Mar. 2017", "03/2017", "2017-03", "2017-03-15", "Sept. 2016", a bare year,
// "Present", "Ongoing"). The tenure engine below and the cover-letter
// ended-role gate used to read different subsets of them, so a period one
// accepted the other silently dropped. They now share these three functions:
// `splitCareerDateRange` finds the two ends of a range, `parseCareerDate` reads
// one end, and `careerRoleDateInputs` takes whichever of a role's fields states
// the period. A caller that needs a different policy (a year-only end is only
// "ended" once the whole year has passed) applies it to the parsed value; it
// does not parse again.
// ---------------------------------------------------------------------------
const MONTH_TOKEN = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const YEAR_TOKEN = '((?:19|20)\\d{2})';
const DAY_TOKEN = '(0?[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?';
const NUMERIC_MONTH_TOKEN = '(0?[1-9]|1[0-2])';
const CURRENT_DATE_RE = /^(?:(?:to|till|until|up to)\s+)?(?:present|now|today|date)$|^(?:current(?:ly)?|ongoing)$/u;
const CURRENT_DATE_WORD_RE = /\b(?:present|current|currently|ongoing|now)\b/u;
const DATE_FORMS = Object.freeze([
  { re: new RegExp(`^${MONTH_TOKEN}\\s+(?:${DAY_TOKEN}\\s+)?${YEAR_TOKEN}$`, 'u'), read: m => ({ month: m[1], year: m[3] }) },
  { re: new RegExp(`^(?:${DAY_TOKEN}\\s+)?${MONTH_TOKEN}\\s+${YEAR_TOKEN}$`, 'u'), read: m => ({ month: m[2], year: m[3] }) },
  { re: new RegExp(`^${YEAR_TOKEN}\\s*[-/.]\\s*${NUMERIC_MONTH_TOKEN}(?:\\s*[-/.]\\s*${DAY_TOKEN})?$`, 'u'), read: m => ({ year: m[1], numericMonth: m[2] }) },
  { re: new RegExp(`^${NUMERIC_MONTH_TOKEN}\\s*[-/.]\\s*${YEAR_TOKEN}$`, 'u'), read: m => ({ numericMonth: m[1], year: m[2] }) },
  { re: new RegExp(`^${YEAR_TOKEN}$`, 'u'), read: m => ({ year: m[1] }) },
]);
// Looser, position-free readers used only when a caller asks for `lenient`: the
// end of a range can carry a trailing place or note ("June 2022 Boston").
const LENIENT_DATE_SCANS = Object.freeze([
  { re: new RegExp(`(?<![\\p{L}\\p{N}])${YEAR_TOKEN}\\s*[-/.]\\s*${NUMERIC_MONTH_TOKEN}(?![\\p{L}\\p{N}])`, 'gu'), read: m => ({ year: m[1], numericMonth: m[2] }) },
  { re: new RegExp(`(?<![\\p{L}\\p{N}])${MONTH_TOKEN}\\s+(?:${DAY_TOKEN}\\s+)?${YEAR_TOKEN}(?![\\p{L}\\p{N}])`, 'gu'), read: m => ({ month: m[1], year: m[3] }) },
  { re: new RegExp(`(?<![\\p{L}\\p{N}])${NUMERIC_MONTH_TOKEN}\\s*[-/.]\\s*${YEAR_TOKEN}(?![\\p{L}\\p{N}])`, 'gu'), read: m => ({ numericMonth: m[1], year: m[2] }) },
]);

function normalizedDateFragment(value) {
  const raw = typeof value === 'number' && Number.isFinite(value) ? String(value) : text(value);
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[([][^)\]]*[)\]]/gu, ' ')
    .replace(/\s*[·•|].*$/u, '')
    .replace(/[,;]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[.\s]+$/u, '');
}

function monthFromWord(word) {
  const key = String(word || '').toLowerCase().replace(/\.$/u, '');
  return Object.hasOwn(MONTHS, key) ? MONTHS[key] : null;
}

function datePartsToValue(parts) {
  const year = Number(parts.year);
  if (!Number.isInteger(year)) return null;
  if (parts.numericMonth != null) return { year, month: Number(parts.numericMonth) - 1, precision: 'month' };
  if (parts.month != null) {
    const month = monthFromWord(parts.month);
    return month == null ? null : { year, month, precision: 'month' };
  }
  return { year, month: null, precision: 'year' };
}

/**
 * Reads one end of a career period. Returns `{ current: true }` for an open
 * end (Present, Current, Ongoing, Now), `{ year, month, precision }` for a
 * stated date (`month` is 0-11, or null with `precision: 'year'` for a bare
 * year), and null when the text is not a date this reader recognizes. With
 * `lenient`, a recognizable date inside surrounding words still counts and a
 * current-employment word anywhere makes the end open.
 */
export function parseCareerDate(value, { lenient = false } = {}) {
  const fragment = normalizedDateFragment(value);
  if (!fragment) return null;
  if (CURRENT_DATE_RE.test(fragment)) return { current: true };
  for (const form of DATE_FORMS) {
    const match = form.re.exec(fragment);
    if (match) return datePartsToValue(form.read(match));
  }
  if (!lenient) return null;
  if (CURRENT_DATE_WORD_RE.test(fragment)) return { current: true };
  for (const scan of LENIENT_DATE_SCANS) {
    for (const match of fragment.matchAll(scan.re)) {
      const parsed = datePartsToValue(scan.read(match));
      if (parsed) return parsed;
    }
  }
  const years = fragment.match(/(?<![\p{L}\p{N}])(?:19|20)\d{2}(?![\p{L}\p{N}])/gu) || [];
  return years.length === 1 ? { year: Number(years[0]), month: null, precision: 'year' } : null;
}

/**
 * Splits a stated period ("March 2017 - Present", "2017-03 – 2020-11",
 * "1997-2003", "03/2017 to 05/2020") into its two end strings, or null when no
 * separator is found. Hyphens inside an ISO date are never a separator.
 */
export function splitCareerDateRange(value) {
  const range = (typeof value === 'string' ? value : '').normalize('NFKC').replace(/\s+/gu, ' ').trim()
    .split(/\s*[·•|]\s*/u)[0].trim();
  if (!range) return null;
  const rules = [
    /^(.+?)\s+(?:[–—-]|to|through|thru|until|till)\s+(.+)$/iu,
    /^(.+?[\p{L}\d.)])\s*[–—]\s*(.+)$/u,
    /^((?:19|20)\d{2})\s*-\s*((?:19|20)\d{2})$/u,
    /^(\d{1,2}[/.](?:19|20)\d{2})\s*-\s*(\d{1,2}[/.](?:19|20)\d{2})$/u,
    /^(.+?\d)-(\p{L}.*)$/u,
    /^(.+?)\s+-(\S.*)$/u,
    /^(.+?\S)-\s+(.+)$/u,
  ];
  for (const rule of rules) {
    const match = rule.exec(range);
    if (match && text(match[1]) && text(match[2])) return { start: match[1].trim(), end: match[2].trim() };
  }
  return null;
}

/** The start and end strings a role states, from explicit fields or a combined range field. */
export function careerRoleDateInputs(role) {
  const explicitStart = role?.startDate ?? role?.start ?? role?.from;
  const explicitEnd = role?.endDate ?? role?.end ?? role?.to;
  if (explicitStart || explicitEnd) return { start: explicitStart, end: explicitEnd };
  const range = text(role?.dateRange ?? role?.dates ?? role?.period ?? role?.tenure);
  return splitCareerDateRange(range) ?? { start: '', end: '' };
}

// The tenure engine's view of one end: month-precise dates collapse to a single
// month index, a bare year to its first and last months. An end that is simply
// not stated counts as open, as it always has here.
function parseMonthYear(value) {
  if (!(typeof value === 'number' ? String(value) : text(value))) return { current: true };
  const date = parseCareerDate(value);
  if (!date) return null;
  if (date.current) return { current: true };
  if (date.month == null) return { earliest: monthIndex(date.year, 0), latest: monthIndex(date.year, 11), precision: 'year' };
  const index = monthIndex(date.year, date.month);
  return { earliest: index, latest: index, precision: 'month' };
}

function rolePeriod(role, asOf) {
  const input = careerRoleDateInputs(role);
  const start = parseMonthYear(input.start);
  const end = parseMonthYear(input.end);
  if (!start || start.current || !end) return null;
  const endPeriod = end.current
    ? { earliest: asOf, latest: asOf + 1, precision: 'asOf' }
    : { earliest: end.earliest, latest: end.latest + 1, precision: end.precision };
  if (endPeriod.latest <= start.earliest) return null;
  return {
    id: text(role?.id ?? role?.roleId ?? role?.name ?? role?.title),
    // A résumé's month label omits the day. Treat its first and last days as
    // bounds rather than pretending that every role began on the first and
    // ended on the last. This keeps even month-precise entries as a narrow
    // range (for example, May 2023–June 2026 is 36–38 calendar months).
    min: { start: start.latest + 1, end: Math.max(start.latest + 1, endPeriod.earliest) },
    max: { start: start.earliest, end: Math.max(start.earliest, endPeriod.latest) },
    uncertain: true,
  };
}

function mergedMonths(intervals) {
  const ordered = intervals.filter(interval => interval.end > interval.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let total = 0;
  let active = null;
  for (const interval of ordered) {
    if (!active || interval.start > active.end) {
      if (active) total += active.end - active.start;
      active = { ...interval };
    } else {
      active.end = Math.max(active.end, interval.end);
    }
  }
  if (active) total += active.end - active.start;
  return total;
}

function years(months) {
  return Math.round((months / 12) * 100) / 100;
}

/**
 * Calculates a bounded tenure range from résumé-style dates. Month precision
 * retains the omitted day-of-month uncertainty; year-only dates retain a
 * wider possible range. Overlapping jobs are unioned, avoiding double-counting
 * concurrent employment.
 */
export function calculateDatedTenure(roles, { asOf = new Date() } = {}) {
  const asOfMonth = monthIndex(asOf.getUTCFullYear(), asOf.getUTCMonth());
  const periods = (Array.isArray(roles) ? roles : [])
    .map(role => rolePeriod(role, asOfMonth))
    .filter(Boolean);
  const minMonths = mergedMonths(periods.map(period => period.min));
  const maxMonths = mergedMonths(periods.map(period => period.max));
  return {
    roleCount: periods.length,
    uncertainRoleCount: periods.filter(period => period.uncertain).length,
    minMonths,
    maxMonths,
    minYears: years(minMonths),
    maxYears: years(maxMonths),
    exact: minMonths === maxMonths,
    basis: periods.length ? 'dated-role-periods' : 'no-usable-dates',
  };
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function positiveNumberOrNull(value) {
  const number = numberOrNull(value);
  return number && number > 0 ? number : null;
}

function roleIdentifier(role) {
  return String(role?.id ?? role?.roleId ?? role?.name ?? role?.title ?? '');
}

function selectedRoleTenure(candidateRoles, roleIds, options) {
  if (!Array.isArray(roleIds) || roleIds.length === 0) return null;
  const wanted = new Set(roleIds.map(String));
  const selected = (Array.isArray(candidateRoles) ? candidateRoles : []).filter(role => wanted.has(roleIdentifier(role)));
  return {
    ...calculateDatedTenure(selected, options),
    requestedRoleIds: [...wanted],
    matchedRoleCount: selected.length,
    basis: selected.length ? 'selected-role-periods' : 'selected-roles-not-found',
  };
}

function evidenceAudit(source, candidateText, jobText) {
  const candidate = groundedQuotes(candidateText, source?.candidateEvidence);
  const job = groundedQuotes(jobText, source?.jobEvidence);
  return {
    candidateEvidence: candidate.grounded,
    candidateEvidenceGrounded: candidate.allGrounded,
    rejectedCandidateEvidence: candidate.supplied.filter(quote => !candidate.grounded.includes(quote)),
    jobEvidence: job.grounded,
    jobEvidenceGrounded: job.allGrounded,
    rejectedJobEvidence: job.supplied.filter(quote => !job.grounded.includes(quote)),
  };
}

function normalizeExperience(raw, candidateRoles, options, { candidateText = '', jobText = '' } = {}) {
  const source = raw?.experienceAssessment ?? raw?.experience ?? {};
  const totalSource = source?.totalProfessionalExperience ?? {};
  const categories = Array.isArray(source?.categorySpecificExperience)
    ? source.categorySpecificExperience
    // Compatibility for early structured callers. It is intentionally kept
    // separate from the total, rather than using the total as a substitute.
    : (source?.requirementSpecific ? [source.requirementSpecific] : []);
  const totalProfessionalTenure = {
    ...calculateDatedTenure(candidateRoles, options),
    reportedYears: text(totalSource?.years),
    ...evidenceAudit(totalSource, candidateText, jobText),
  };
  const categorySpecificExperience = categories.map((category, index) => {
    // The live schema uses 0 as the structural sentinel for “the listing did
    // not state a numeric minimum”, not a literal zero-year requirement.
    const requiredMinimumYears = positiveNumberOrNull(category?.requiredMinimumYears ?? category?.requiredYears ?? category?.yearsRequired);
    const tenure = selectedRoleTenure(candidateRoles, category?.roleIds, options);
    // A category that names no role, or only roles that are not in the record,
    // cannot be measured against a subset. Whatever relevant work it covers is
    // still part of the dated career, so the whole dated career is the most it
    // can reach: a requirement above that ceiling is unreachable whichever
    // roles the model meant. The ceiling can refute a threshold; it can never
    // confirm one, because the subset it stands for is unknown.
    const unscopedCeiling = requiredMinimumYears != null && !(tenure?.matchedRoleCount > 0) && totalProfessionalTenure.roleCount > 0
      ? {
        basis: 'all-dated-roles',
        roleCount: totalProfessionalTenure.roleCount,
        minYears: totalProfessionalTenure.minYears,
        maxYears: totalProfessionalTenure.maxYears,
      }
      : null;
    const measured = tenure?.matchedRoleCount > 0 ? tenure : (unscopedCeiling ?? tenure);
    const shortfallYears = requiredMinimumYears != null && measured
      ? Math.max(0, requiredMinimumYears - measured.maxYears)
      : null;
    return {
      id: text(category?.id) || `experience-category-${index + 1}`,
      category: text(category?.category ?? category?.requirementText ?? category?.name) || `Experience category ${index + 1}`,
      requiredMinimumYears,
      reportedYears: text(category?.years ?? category?.candidateYears ?? category?.candidateRelevantYears),
      roleIds: Array.isArray(category?.roleIds) ? category.roleIds.map(String) : [],
      tenure,
      unscopedCeiling,
      meetsMinimum: requiredMinimumYears != null && tenure ? tenure.minYears >= requiredMinimumYears : null,
      nearMinimum: shortfallYears != null && shortfallYears > 0 && shortfallYears <= 0.5,
      shortfallYears,
      explanation: text(category?.explanation),
      ...evidenceAudit(category, candidateText, jobText),
    };
  });
  return { totalProfessionalTenure, categorySpecificExperience };
}

function sameEvidence(left, right) {
  return normalizeText(left) && normalizeText(left) === normalizeText(right);
}

function categoryMatchesRequirement(category, row) {
  if (category.jobEvidence.some(categoryQuote => row.jobEvidence.some(rowQuote => sameEvidence(categoryQuote, rowQuote)))) return true;
  const categoryName = normalizeText(category.category);
  const requirement = normalizeText(row.requirement);
  return categoryName.length >= 4 && (categoryName.includes(requirement) || requirement.includes(categoryName));
}

// A model may cite genuine role dates and still overstate their duration. Once
// the category explicitly identifies stable work-history role IDs, dated tenure
// takes precedence over an optimistic direct/adjacent label for that category.
// A selected subset of concise career history does not prove the candidate has
// no other relevant experience, so a short documented duration is an evidence
// gap—not a factual contradiction.
//
// A category that identifies no usable role (the field omitted, empty, or
// naming only roles absent from the record) is held to the one bound that needs
// no role: no subset of the dated career is longer than the dated career. That
// bound can only demote a claim the whole record cannot reach; it never
// confirms one.
function applyDatedTenureToRequirements(rows, experience) {
  const categories = experience.categorySpecificExperience || [];
  return rows.map(row => {
    const category = categories.find(item => categoryMatchesRequirement(item, row)
      && item.requiredMinimumYears != null
      && (item.tenure?.matchedRoleCount > 0 || item.unscopedCeiling)
      && item.jobEvidenceGrounded);
    if (!category) return row;
    const scoped = category.tenure?.matchedRoleCount > 0;
    const measured = scoped ? category.tenure : category.unscopedCeiling;
    let effectiveStatus = row.effectiveStatus;
    let tenureDisposition = null;
    if (measured.maxYears < category.requiredMinimumYears) {
      effectiveStatus = category.nearMinimum ? 'adjacent' : 'not_documented';
      tenureDisposition = category.nearMinimum ? 'near-shortfall' : 'shortfall';
    } else if (!scoped) {
      return row;
    } else if (measured.minYears < category.requiredMinimumYears) {
      // The incomplete date precision could meet the threshold, but cannot
      // prove it. Do not retain a direct claim in that ambiguity.
      if (effectiveStatus === 'direct') effectiveStatus = 'unclear';
      tenureDisposition = 'threshold-uncertain';
    } else if (effectiveStatus === 'direct') {
      tenureDisposition = 'confirmed';
    }
    if (!tenureDisposition) return row;
    return {
      ...row,
      effectiveStatus,
      materialGap: isMaterialGap(row.priority, effectiveStatus, row.grounding.requirementGrounded, row.scoreImpact),
      datedTenure: {
        categoryId: category.id,
        requiredMinimumYears: category.requiredMinimumYears,
        minYears: measured.minYears,
        maxYears: measured.maxYears,
        disposition: tenureDisposition,
        basis: scoped ? 'selected-roles' : 'all-dated-roles',
      },
    };
  });
}

function confidenceLevel(value) {
  const normalized = normalizeText(value);
  if (['high', 'medium', 'low', 'unknown'].includes(normalized)) return normalized;
  return 'unknown';
}

function effectiveConfidence(reported, requirementRows, legacy) {
  if (legacy) return 'unknown';
  // Location and work-authorization rows are retained for audit, but do not
  // describe professional fit and must not dilute its evidence coverage.
  const scoredRows = requirementRows.filter(row => row.scoreImpact === 'scored');
  if (!scoredRows.length) return reported;
  const total = scoredRows.length;
  const groundedCount = scoredRows.filter(row => row.grounding.requirementGrounded).length;
  const ratio = total ? groundedCount / total : 0;
  const hasRejectedEvidence = scoredRows.some(row => row.grounding.rejectedJobEvidence.length > 0
    || row.grounding.rejectedCandidateEvidence.length > 0);
  const materialNotDocumented = scoredRows.filter(row => row.materialGap && row.effectiveStatus === 'not_documented');
  const hasCriticalNotDocumented = materialNotDocumented.some(row => row.priority === 'critical');
  // An explicit contradiction can be highly certain when both source quotes
  // are grounded. A documentation gap is different: it makes the assessment
  // less complete, and should visibly lower confidence without making a
  // categorical conclusion about experience not listed in the supplied data.
  if (hasCriticalNotDocumented || materialNotDocumented.length >= 2) return 'low';
  // No (or very little) verified posting evidence cannot support a meaningful
  // confidence claim, whatever the model selected in its own response.
  if (ratio <= 0.5) return 'low';
  if (materialNotDocumented.length > 0) {
    if (reported === 'low') return 'low';
    return 'medium';
  }
  if (reported === 'high' && (ratio < 1 || hasRejectedEvidence)) return 'medium';
  return reported;
}

function rawScoreOf(raw) {
  return raw?.rawScore ?? raw?.fitScore ?? raw?.matchScore ?? raw?.score;
}

function requirementLabels(rows) {
  return [...new Set(rows.map(row => text(row.requirement)).filter(Boolean))];
}

function joinLabels(labels) {
  if (labels.length === 0) return '';
  if (labels.length === 1) return `“${labels[0]}”`;
  if (labels.length === 2) return `“${labels[0]}” and “${labels[1]}”`;
  return `${labels.slice(0, -1).map(label => `“${label}”`).join(', ')}, and “${labels.at(-1)}”`;
}

function coverageDescription(confidence) {
  const { effective, groundedRequirementCount, requirementCount } = confidence;
  if (!requirementCount) return `Effective confidence is ${effective}; no scored requirement inventory was supplied for coverage`;
  const percentage = Math.round((groundedRequirementCount / requirementCount) * 100);
  return `Effective confidence is ${effective}; evidence coverage is ${groundedRequirementCount}/${requirementCount} grounded scored posting requirement${requirementCount === 1 ? '' : 's'} (${percentage}%)`;
}

function calibratedReasoning({
  legacy,
  strengths,
  adjacentMatches,
  materialGaps,
  rejectedRows,
  adjustments,
  mergedGapClusters = [],
  rawScore,
  adjustedScore,
  confidence,
}) {
  if (legacy) return 'This is an uncalibrated legacy fit score because structured, grounded requirement evidence was not supplied. Effective confidence and evidence coverage are unavailable.';
  const clauses = [];
  const directLabels = requirementLabels(strengths);
  const adjacentLabels = requirementLabels(adjacentMatches);
  const documentationGaps = materialGaps.filter(row => row.effectiveStatus === 'not_documented');
  const contradictions = materialGaps.filter(row => row.effectiveStatus === 'contradicted');
  const unclearGaps = materialGaps.filter(row => row.effectiveStatus === 'unclear');
  if (directLabels.length) clauses.push(`Direct strengths: ${joinLabels(directLabels)} ${directLabels.length === 1 ? 'is' : 'are'} directly supported by supplied career evidence`);
  if (adjacentLabels.length) clauses.push(`Adjacent, transferable support—not equivalent evidence—applies to ${joinLabels(adjacentLabels)}`);
  const documentationLabels = requirementLabels(documentationGaps);
  const contradictionLabels = requirementLabels(contradictions);
  const unclearLabels = requirementLabels(unclearGaps);
  if (documentationLabels.length) clauses.push(`Verified material requirement${documentationLabels.length === 1 ? '' : 's'} ${joinLabels(documentationLabels)} ${documentationLabels.length === 1 ? 'is' : 'are'} not documented in the supplied career data`);
  if (contradictionLabels.length) clauses.push(`Supplied candidate evidence conflicts with verified material requirement${contradictionLabels.length === 1 ? '' : 's'} ${joinLabels(contradictionLabels)}`);
  if (unclearLabels.length) clauses.push(`Supplied evidence is inconclusive for verified material requirement${unclearLabels.length === 1 ? '' : 's'} ${joinLabels(unclearLabels)}`);
  const rejectedLabels = requirementLabels(rejectedRows.filter(row => row.scoreImpact === 'scored'));
  if (rejectedLabels.length) clauses.push(`Assessment limitation: cited evidence for ${joinLabels(rejectedLabels)} could not be verified against the supplied records`);
  clauses.push(coverageDescription(confidence));
  for (const cluster of mergedGapClusters) {
    if (cluster.requirements.length > 1) clauses.push(`Overlapping gap rows ${joinLabels(cluster.requirements)} describe one posting requirement and were counted once for calibration`);
  }
  if (adjustments.length) clauses.push(`The score was calibrated from ${rawScore} to ${adjustedScore} under the evidence-gap rule`);
  return `${clauses.join('. ')}.`;
}

function gapCondition(rows) {
  const statuses = new Set(rows.map(row => row.effectiveStatus));
  const conditions = [];
  if (statuses.has('not_documented')) conditions.push('not documented in the supplied career data');
  if (statuses.has('contradicted')) conditions.push('contradicted by grounded candidate evidence');
  if (statuses.has('unclear')) conditions.push('unresolved in the supplied evidence');
  return conditions.join(', ') || 'not established by the supplied evidence';
}

function statusCounts(rows) {
  return [...STATUSES].reduce((counts, status) => ({
    ...counts,
    [status]: rows.filter(row => row.effectiveStatus === status).length,
  }), {});
}

// 3: ceilings count distinct requirements (overlapping gap rows merge) and
//    only hard gaps (not documented / contradicted) reach the 69 ceilings.
export const JOB_FIT_CALIBRATION_VERSION = 3;

/**
 * Aggregate how often the deterministic ceilings above actually moved a score,
 * across one scoring run. Pure and count-only: no candidate or posting text.
 *
 * `threshold` is the user's application bar. `cappedAcrossThreshold` counts
 * jobs the model placed at or above it that a cap pulled below it — the exact
 * population where a mislabelled priority, a duplicated gap, or a tenure
 * shortfall turns "apply" into "skip". `adjustmentCodes` counts every applied
 * cap by rule so a run can show WHICH rule did the lowering.
 */
export function summarizeFitCalibration(scoredJobs, { threshold } = {}) {
  const bar = Number.isFinite(Number(threshold)) ? Number(threshold) : null;
  const summary = {
    threshold: bar,
    scored: 0,
    calibrated: 0,
    capped: 0,
    cappedAcrossThreshold: 0,
    unscored: 0,
    adjustmentCodes: {},
  };
  for (const job of Array.isArray(scoredJobs) ? scoredJobs : []) {
    if (!job || typeof job !== 'object') continue;
    summary.scored += 1;
    if (typeof job.scoreStatus === 'string' && job.scoreStatus.startsWith('unscored')) {
      summary.unscored += 1;
      continue;
    }
    const raw = Number(job.rawScore);
    const adjusted = Number(job.adjustedScore ?? job.matchScore);
    if (!Number.isFinite(raw) || !Number.isFinite(adjusted)) continue;
    summary.calibrated += 1;
    const adjustments = Array.isArray(job.fitAssessment?.adjustments)
      ? job.fitAssessment.adjustments
      : Array.isArray(job.adjustments) ? job.adjustments : [];
    for (const adjustment of adjustments) {
      const code = typeof adjustment?.code === 'string' && adjustment.code.trim() ? adjustment.code.trim() : 'unknown';
      summary.adjustmentCodes[code] = (summary.adjustmentCodes[code] || 0) + 1;
    }
    if (adjusted < raw) summary.capped += 1;
    if (bar !== null && raw >= bar && adjusted < bar) summary.cappedAcrossThreshold += 1;
  }
  return summary;
}

// A gap whose status asserts something about the record (nothing documented,
// or a documented conflict), as opposed to `unclear`, which only says the
// supplied evidence could not settle the question. Both are material gaps
// and both block 85+; only hard gaps count toward the 69 ceilings, because a
// 69 means "do not apply" under the user's bar and inconclusive evidence is
// not enough to conclude that.
const HARD_GAP_STATUSES = new Set(['not_documented', 'contradicted']);
const OVERLAP_MIN_CHARS = 4;

function overlapText(value) {
  return normalizeText(value).replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function textsOverlap(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = shorter === left ? right : left;
  return shorter.length >= OVERLAP_MIN_CHARS && longer.includes(shorter);
}

// Two gap rows describe one posting requirement when one's grounded posting
// span sits inside the other's (the same clause quoted twice at different
// lengths: "AWS" and "deploy services on AWS"), or when one requirement label
// contains the other ("Cloud platform" / "Cloud platform experience"). The
// scorer is told to quote distinct spans for distinct requirements, so a
// nested span is the model's own signal that it split one requirement in two.
// Unrelated requirements ("AWS" / "GCP") share neither and stay separate.
function gapRowsOverlap(left, right) {
  // A gap review (jobGapReview.js) may record that one row duplicates another
  // by id; that verdict is host-validated and links the two rows outright.
  const leftId = text(left?.id);
  const rightId = text(right?.id);
  if ((leftId && text(right?.duplicateOf) === leftId) || (rightId && text(left?.duplicateOf) === rightId)) return true;
  const leftQuotes = (Array.isArray(left?.jobEvidence) ? left.jobEvidence : []).map(overlapText).filter(Boolean);
  const rightQuotes = (Array.isArray(right?.jobEvidence) ? right.jobEvidence : []).map(overlapText).filter(Boolean);
  if (leftQuotes.some(a => rightQuotes.some(b => textsOverlap(a, b)))) return true;
  return textsOverlap(overlapText(left?.requirement), overlapText(right?.requirement));
}

/**
 * Group material-gap rows that describe the same posting requirement so the
 * ceilings count DISTINCT requirements, not rows. Every row stays in the audit;
 * only the ceiling arithmetic changes. A cluster counts toward every priority
 * its members carry and is "hard" for a priority when a member of that
 * priority has a hard status — so adding a row can only ever add to a count,
 * never move one, which keeps "more gaps never raise the score" true.
 */
export function clusterMaterialGaps(requirementRows) {
  const clusters = [];
  for (const row of requirementRows.filter(row => row?.materialGap)) {
    const linked = clusters.filter(cluster => cluster.rows.some(member => gapRowsOverlap(member, row)));
    if (linked.length === 0) {
      clusters.push({ rows: [row] });
      continue;
    }
    const [target, ...others] = linked;
    target.rows.push(row);
    for (const other of others) {
      target.rows.push(...other.rows);
      clusters.splice(clusters.indexOf(other), 1);
    }
  }
  return clusters.map(cluster => ({
    rows: cluster.rows,
    critical: cluster.rows.some(row => row.priority === 'critical'),
    important: cluster.rows.some(row => row.priority === 'important'),
    criticalHard: cluster.rows.some(row => row.priority === 'critical' && HARD_GAP_STATUSES.has(row.effectiveStatus)),
    importantHard: cluster.rows.some(row => row.priority === 'important' && HARD_GAP_STATUSES.has(row.effectiveStatus)),
  }));
}

function clusterRows(clusters) {
  return clusters.flatMap(cluster => cluster.rows);
}

function mergedClusterSummaries(clusters) {
  return clusters
    .filter(cluster => cluster.rows.length > 1)
    .map(cluster => ({
      ids: cluster.rows.map(row => text(row.id)).filter(Boolean),
      requirements: [...new Set(cluster.rows.map(row => text(row.requirement)).filter(Boolean))],
    }));
}

// Evaluate every applicable ceiling. A critical gap cannot mask a stronger
// important-gap ceiling: adding an unresolved requirement must never raise fit.
//
// Ceilings count distinct requirements (see clusterMaterialGaps). The 69
// ceilings need HARD gaps (not documented or contradicted); an `unclear` gap
// still counts toward the 79 ceilings and the 84 material-gap ceiling.
export function calibrateGroundedJobRequirements(rawScore, requirementRows, { legacy = false } = {}) {
  const clusters = clusterMaterialGaps(requirementRows);
  const criticalClusters = clusters.filter(cluster => cluster.critical);
  const criticalHardClusters = clusters.filter(cluster => cluster.criticalHard);
  const importantClusters = clusters.filter(cluster => cluster.important);
  const importantHardClusters = clusters.filter(cluster => cluster.importantHard);
  const materialGaps = requirementRows.filter(row => row.materialGap);
  const criticalAdjacent = requirementRows.filter(row => row.priority === 'critical'
    && row.scoreImpact === 'scored'
    && row.grounding.requirementGrounded && row.effectiveStatus === 'adjacent');
  let adjustedScore = rawScore;
  const adjustments = [];
  const cap = (maximum, code, reason) => {
    if (adjustedScore > maximum) {
      adjustments.push({ code, reason, from: adjustedScore, to: maximum });
      adjustedScore = maximum;
    }
  };
  const inconclusiveNote = (all, hard) => (all.length > hard.length
    ? ' An inconclusive (unclear) requirement counts toward the 79 ceiling but not the 69 ceiling.'
    : '');
  if (!legacy) {
    if (criticalHardClusters.length >= 2) {
      cap(69, 'multiple-critical-gaps', `Two or more distinct grounded critical requirements are ${gapCondition(clusterRows(criticalHardClusters))}.`);
    } else if (criticalClusters.length >= 1) {
      const rows = clusterRows(criticalClusters);
      cap(79, 'critical-gap', `${criticalClusters.length === 1 ? 'One' : 'More than one'} grounded critical requirement ${criticalClusters.length === 1 ? 'is' : 'are'} ${gapCondition(rows)}.${inconclusiveNote(criticalClusters, criticalHardClusters)}`);
    }
    if (importantHardClusters.length >= 3) {
      cap(69, 'multiple-important-gaps', `Three or more distinct grounded important requirements are ${gapCondition(clusterRows(importantHardClusters))}.`);
    } else if (importantClusters.length >= 2) {
      cap(79, 'multiple-important-gaps', `Two or more distinct grounded important requirements are ${gapCondition(clusterRows(importantClusters))}.${inconclusiveNote(importantClusters, importantHardClusters)}`);
    }
    if (materialGaps.length > 0) {
      cap(84, 'material-gap', `A grounded material requirement is ${gapCondition(materialGaps)}.`);
    }
    if (criticalAdjacent.length > 0) {
      cap(84, 'critical-adjacent', 'A grounded critical requirement is supported only by adjacent experience.');
    }
  }
  return { adjustedScore, adjustments, mergedGapClusters: mergedClusterSummaries(clusters) };
}

// Reapply deterministic policy to an already grounded audit without asking an
// AI to reinterpret its evidence, priorities, tenure, confidence, or raw score.
//
// Every derived view of the rows (material gaps, strengths, adjacent matches,
// status counts, effective confidence and coverage) is rebuilt from the rows
// too, so a caller that corrected a row — the gap review in jobGapReview.js —
// gets one consistent audit back instead of a new score beside stale lists.
// The model's reported confidence, tenure and raw score are never touched.
export function recalibrateAuditedFitAssessment(audit) {
  if (audit?.auditStatus !== 'audited' || audit.schemaVersion !== 1
    || !Number.isInteger(audit.rawScore) || audit.rawScore < 0 || audit.rawScore > 100
    || !Array.isArray(audit.requirementRows) || !audit.requirementRows.length
    || !audit.confidence || audit.requirementRows.some(row => !row?.grounding
      || !STATUSES.has(row.effectiveStatus))) return null;
  // Keep the caller's references whenever nothing changed: an untouched audit
  // must recalibrate to the same rows and confidence objects it came with.
  const recomputed = audit.requirementRows.map(row => {
    const materialGap = isMaterialGap(row.priority, row.effectiveStatus, row.grounding.requirementGrounded, row.scoreImpact);
    return materialGap === row.materialGap ? row : { ...row, materialGap };
  });
  const rows = recomputed.some((row, index) => row !== audit.requirementRows[index]) ? recomputed : audit.requirementRows;
  const { adjustedScore, adjustments, mergedGapClusters } = calibrateGroundedJobRequirements(audit.rawScore, rows);
  const strengths = rows.filter(row => row.effectiveStatus === 'direct' && row.scoreImpact === 'scored'
    && row.grounding.requirementGrounded && row.grounding.candidateClaimGrounded);
  const adjacentMatches = rows.filter(row => row.effectiveStatus === 'adjacent' && row.scoreImpact === 'scored'
    && row.grounding.requirementGrounded && row.grounding.candidateClaimGrounded);
  const materialGaps = rows.filter(row => row.materialGap);
  const rejectedEvidenceRows = rows.filter(row => !row.grounding.requirementGrounded
    || row.grounding.rejectedJobEvidence.length > 0 || row.grounding.rejectedCandidateEvidence.length > 0);
  const scoredRequirementRows = rows.filter(row => row.scoreImpact === 'scored');
  const groundedRows = scoredRequirementRows.filter(row => row.grounding.requirementGrounded);
  const reported = confidenceLevel(audit.confidence.reported);
  const rebuiltConfidence = {
    ...audit.confidence,
    reported,
    effective: effectiveConfidence(reported, rows, false),
    groundedRequirementCount: groundedRows.length,
    requirementCount: scoredRequirementRows.length,
    groundedRequirementRatio: scoredRequirementRows.length ? groundedRows.length / scoredRequirementRows.length : 0,
  };
  const confidence = ['reported', 'effective', 'groundedRequirementCount', 'requirementCount', 'groundedRequirementRatio']
    .every(key => rebuiltConfidence[key] === audit.confidence[key])
    ? audit.confidence
    : rebuiltConfidence;
  const reasoning = calibratedReasoning({
    mergedGapClusters,
    legacy: false,
    strengths,
    adjacentMatches,
    materialGaps,
    rejectedRows: rejectedEvidenceRows,
    adjustments, rawScore: audit.rawScore, adjustedScore, confidence,
  });
  return {
    ...audit,
    calibrationVersion: JOB_FIT_CALIBRATION_VERSION,
    adjustedScore,
    adjustments,
    mergedGapClusters,
    confidence,
    statusCounts: statusCounts(rows),
    requirementRows: rows,
    strengths: strengths.map(row => ({ id: row.id, requirement: row.requirement, priority: row.priority })),
    adjacentMatches: adjacentMatches.map(row => ({ id: row.id, requirement: row.requirement, priority: row.priority })),
    materialGaps: materialGaps.map(row => ({
      id: row.id,
      requirement: row.requirement,
      priority: row.priority,
      status: row.effectiveStatus,
      reportedStatus: row.reportedStatus,
    })),
    reasoning,
  };
}

/**
 * Converts an LLM assessment into an auditable, calibrated object.  The
 * function is deliberately pure so current and future scoring pipelines can
 * call it before persisting a job card.
 */
export function validateAndNormalizeFitAssessment(raw, {
  jobText = '',
  candidateText = '',
  candidateRoles = [],
  asOf,
} = {}) {
  const safeRaw = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const rawScore = clampScore(rawScoreOf(safeRaw), 0);
  const sourceRows = rowCollection(safeRaw);
  const normalizedRows = sourceRows.map((row, index) => normalizeRequirement(row, index, { jobText, candidateText }));
  const experience = normalizeExperience(safeRaw, candidateRoles, { asOf }, { candidateText, jobText });
  const requirementRows = applyDatedTenureToRequirements(normalizedRows, experience);
  const legacy = sourceRows.length === 0;
  const materialGaps = requirementRows.filter(row => row.materialGap);
  const strengths = requirementRows.filter(row => row.effectiveStatus === 'direct'
    && row.scoreImpact === 'scored'
    && row.grounding.requirementGrounded && row.grounding.candidateClaimGrounded);
  const adjacentMatches = requirementRows.filter(row => row.effectiveStatus === 'adjacent'
    && row.scoreImpact === 'scored'
    && row.grounding.requirementGrounded && row.grounding.candidateClaimGrounded);
  const { adjustedScore, adjustments, mergedGapClusters } = calibrateGroundedJobRequirements(rawScore, requirementRows, { legacy });
  const rejectedRequirementRows = requirementRows.filter(row => !row.grounding.requirementGrounded);
  // Include a label for any row whose cited posting or candidate evidence was
  // rejected. The public explanation deliberately omits the rejected quote.
  const rejectedEvidenceRows = requirementRows.filter(row => !row.grounding.requirementGrounded
    || row.grounding.rejectedJobEvidence.length > 0
    || row.grounding.rejectedCandidateEvidence.length > 0);
  const scoredRequirementRows = requirementRows.filter(row => row.scoreImpact === 'scored');
  const groundedRows = scoredRequirementRows.filter(row => row.grounding.requirementGrounded);
  const reportedConfidence = confidenceLevel(safeRaw?.confidence ?? safeRaw?.confidenceLevel);
  const confidence = {
    // `reported` is retained only for audit. UI should show `effective`,
    // which accounts for rejected evidence and incomplete requirement rows.
    reported: reportedConfidence,
    effective: effectiveConfidence(reportedConfidence, requirementRows, legacy),
    groundedRequirementCount: groundedRows.length,
    requirementCount: scoredRequirementRows.length,
    groundedRequirementRatio: scoredRequirementRows.length ? groundedRows.length / scoredRequirementRows.length : 0,
  };
  const reasoning = calibratedReasoning({
    legacy,
    strengths,
    adjacentMatches,
    materialGaps,
    rejectedRows: rejectedEvidenceRows,
    adjustments,
    mergedGapClusters,
    rawScore,
    adjustedScore,
    confidence,
  });
  return {
    schemaVersion: 1,
    calibrationVersion: JOB_FIT_CALIBRATION_VERSION,
    scoreInterpretation: 'hiring-fit-not-probability',
    auditStatus: legacy ? 'legacy-unverified' : 'audited',
    rawScore,
    adjustedScore,
    adjustments,
    // Gap rows the ceilings counted as one posting requirement (ids and
    // labels only). Empty when every gap row was distinct.
    mergedGapClusters,
    confidence,
    // Stable, canonical evidence-status counts let the UI and saved audits
    // distinguish absent documentation from an explicit contradiction without
    // relying on prose or legacy status labels.
    statusCounts: statusCounts(requirementRows),
    requirementRows,
    strengths: strengths.map(row => ({ id: row.id, requirement: row.requirement, priority: row.priority })),
    // Adjacent evidence is intentionally visible apart from a direct strength:
    // it is transferable context, not proof of an equivalent requirement.
    adjacentMatches: adjacentMatches.map(row => ({ id: row.id, requirement: row.requirement, priority: row.priority })),
    materialGaps: materialGaps.map(row => ({
      id: row.id,
      requirement: row.requirement,
      priority: row.priority,
      status: row.effectiveStatus,
      reportedStatus: row.reportedStatus,
    })),
    rejectedRequirementRows: rejectedRequirementRows.map(row => ({ id: row.id, requirement: row.requirement, rejectedEvidence: row.grounding.rejectedJobEvidence })),
    experience,
    // Never carry over the model's free-form positive narrative: it may have
    // named evidence that failed validation. Consumers should display this
    // deterministic explanation when the assessment is present.
    reasoning,
    warnings: [
      ...(legacy ? ['Structured requirement evidence is unavailable; this legacy score is visibly uncalibrated.'] : []),
      ...rejectedRequirementRows.map(row => `Excluded ungrounded requirement: ${row.requirement}`),
    ],
  };
}
