// Country applicability and location-filter honesty for job sources.
//
// This deliberately separates "may be queried" from "is a hard country filter".
// A target may be as broad as Canada/USA or as narrow as a province/state/city;
// source applicability remains a country decision while the caller still passes
// the full board-ready location string to the source.

import { deriveLocationParam, normalizeLocationInput } from './jobLocation.js';

export const JOB_SOURCE_COUNTRY_FILTER_STRENGTH = Object.freeze({
  HARD: 'hard',
  CONDITIONAL: 'conditional',
  BEST_EFFORT: 'best-effort',
  GLOBAL_REMOTE: 'global-remote',
  UNKNOWN: 'unknown',
});

const KNOWN_SOURCE_IDS = new Set([
  'indeed', 'linkedin', 'ziprecruiter', 'glassdoor', 'google',
  'dice', 'usajobs', 'remoteok', 'weworkremotely',
]);

const SOURCE_ALIASES = Object.freeze({
  'zip-recruiter': 'ziprecruiter',
  'we-work-remotely': 'weworkremotely',
  'we work remotely': 'weworkremotely',
  'remote-ok': 'remoteok',
  'usa-jobs': 'usajobs',
});

function clean(value) {
  return String(value || '').trim();
}

function normalizedKey(value) {
  return clean(value).toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ');
}

/** Normalise source aliases before consulting the country policy. */
function normalizeJobSourceId(sourceId) {
  const id = normalizedKey(sourceId).replace(/\s+/g, '-');
  return SOURCE_ALIASES[id] || id;
}

/**
 * Classify a target location without discarding its useful tightness.
 *
 * Accepts either the stored text ("Toronto, Ontario, Canada") or the structured
 * canonical location produced by query generation. The `scope` field makes the
 * distinction explicit for diagnostics: country, subdivision, city, remote,
 * or unknown. Inference from Ontario/Colorado ensures old saved locations that
 * omitted the country remain correctly scoped.
 */
export function classifyJobTargetLocation(target, structuredLocation = null) {
  const structured = structuredLocation && typeof structuredLocation === 'object'
    ? structuredLocation
    : (target && typeof target === 'object' ? target : null);
  const raw = clean(typeof target === 'string' ? target : (structured?.display || ''));

  if (structured?.isRemote && !clean(structured.city) && !clean(structured.stateCode)
      && !clean(structured.subdivision) && !clean(structured.region)) {
    const normalizedCountry = normalizeLocationInput(structured.country);
    return {
      raw,
      boardReady: '',
      country: normalizedCountry.country || null,
      countryCode: normalizedCountry.countryCode,
      scope: 'remote',
      city: null,
      subdivision: null,
      countryConflict: false,
    };
  }

  // `deriveLocationParam` deliberately returns an empty value for a known
  // subdivision paired with the wrong country. Preserve WHY it returned empty
  // before the country fallback below: otherwise Ontario + United States would
  // degrade to an apparently valid country-only US search and the policy layer
  // would dispatch sources after the formatter had already rejected the input.
  const structuredSubdivision = clean(
    structured?.stateCode || structured?.subdivision || structured?.region,
  );
  const structuredConflictProbe = structured
    ? normalizeLocationInput([
      clean(structured.city),
      structuredSubdivision,
      clean(structured.country),
    ].filter(Boolean).join(', '))
    : null;

  // One parser owns both board-ready normalization and source policy. Keeping a
  // second country/state table here previously created two subtly different
  // answers for the same input (notably postal-code forms such as Denver, CO).
  const boardReady = structured ? deriveLocationParam(structured, raw) : raw;
  const normalized = normalizeLocationInput(boardReady || raw);
  // A US board-ready string deliberately omits its country ("Denver, CO", or a
  // bare "Denver" for a city-only target), so re-parsing it cannot always
  // recover one. Fall back to the country the caller already stated rather than
  // reporting the target as unclassified — source applicability is a country
  // decision, and an unclassified target wrongly excludes USAJobs and Dice.
  const stated = normalized.country ? null : normalizeLocationInput(structured?.country);
  return {
    raw,
    boardReady: normalized.boardReady,
    country: normalized.country || stated?.country || null,
    countryCode: normalized.countryCode || stated?.countryCode || null,
    scope: normalized.scope,
    city: normalized.city || null,
    subdivision: normalized.subdivisionCode
      ? { code: normalized.subdivisionCode.toLowerCase(), name: normalized.subdivision, country: normalized.country }
      : null,
    countryConflict: normalized.countryConflict || !!structuredConflictProbe?.countryConflict,
  };
}

/**
 * Return the source's honest applicability for this target. `include: false`
 * means no request should be made — callers can surface `reason` in source
 * progress/diagnostics instead of silently substituting an unscoped search.
 */
export function getJobSourceCountryPolicy(sourceId, target, structuredLocation = null) {
  const id = normalizeJobSourceId(sourceId);
  const location = classifyJobTargetLocation(target, structuredLocation);
  const base = { sourceId: id, location, include: true, reason: null, requiresResolvedLocation: false };

  if (location.countryConflict) {
    return {
      ...base,
      include: false,
      filterStrength: JOB_SOURCE_COUNTRY_FILTER_STRENGTH.UNKNOWN,
      label: 'Conflicting location',
      reason: 'The requested country conflicts with its province/state, so no source is queried with this location.',
    };
  }

  if (!KNOWN_SOURCE_IDS.has(id)) {
    return { ...base, filterStrength: JOB_SOURCE_COUNTRY_FILTER_STRENGTH.UNKNOWN, label: 'Unknown location treatment' };
  }
  if (id === 'remoteok' || id === 'weworkremotely') {
    return { ...base, filterStrength: JOB_SOURCE_COUNTRY_FILTER_STRENGTH.GLOBAL_REMOTE, label: 'Global remote', reason: 'Global remote feed; country eligibility is not filterable.' };
  }
  if (id === 'google') {
    return { ...base, filterStrength: JOB_SOURCE_COUNTRY_FILTER_STRENGTH.BEST_EFFORT, label: 'Best-effort location', reason: 'Country is appended to the Google query; Google does not expose a reliable country filter here.' };
  }
  if (id === 'glassdoor') {
    if (location.country && !location.countryCode) {
      return { ...base, include: false, filterStrength: JOB_SOURCE_COUNTRY_FILTER_STRENGTH.CONDITIONAL, label: 'Unverified country', reason: `Strict Glassdoor location verification currently supports Canada and the United States; ${location.country} is skipped rather than searched without proof.` };
    }
    return { ...base, filterStrength: JOB_SOURCE_COUNTRY_FILTER_STRENGTH.CONDITIONAL, label: 'Verified location filter', requiresResolvedLocation: true, reason: 'Include only after exact Glassdoor location resolution succeeds.' };
  }
  if (id === 'usajobs') {
    if (location.country !== 'United States') {
      const scope = location.country ? `${location.country}-scoped` : 'unclassified';
      return { ...base, include: false, filterStrength: JOB_SOURCE_COUNTRY_FILTER_STRENGTH.HARD, label: 'U.S.-only source', reason: `USAJobs is a U.S. federal-job source and is excluded from ${scope} searches.` };
    }
    return { ...base, filterStrength: JOB_SOURCE_COUNTRY_FILTER_STRENGTH.HARD, label: 'U.S. location filter', reason: null };
  }
  if (id === 'dice') {
    if (location.country !== 'United States') {
      if (!location.country) {
        return { ...base, include: false, filterStrength: JOB_SOURCE_COUNTRY_FILTER_STRENGTH.CONDITIONAL, label: 'U.S.-only integration', reason: 'Dice is excluded because the target country is unclassified; this integration is only verified for U.S. targeting.' };
      }
      const evidence = location.country === 'Canada'
        ? 'Dice Canada results can include U.S.-anchored remote roles'
        : 'this Dice integration has only been verified for U.S. targeting';
      return { ...base, include: false, filterStrength: JOB_SOURCE_COUNTRY_FILTER_STRENGTH.CONDITIONAL, label: `Unavailable for ${location.country} scope`, reason: `${evidence}, so Dice is excluded from ${location.country}-scoped searches.` };
    }
    return { ...base, filterStrength: JOB_SOURCE_COUNTRY_FILTER_STRENGTH.CONDITIONAL, label: 'Conditional U.S. location filter', reason: 'Dice receives its U.S. country and location parameters; retain post-result country-adherence diagnostics because the hidden API transport cannot be independently confirmed from the public browser route.' };
  }
  return { ...base, filterStrength: JOB_SOURCE_COUNTRY_FILTER_STRENGTH.HARD, label: 'Location filter' };
}

/** Keep the requested order while removing sources inapplicable to the country. */
export function getCountryApplicableJobSourceIds(sourceIds, target, structuredLocation = null) {
  const ids = Array.isArray(sourceIds) ? sourceIds : [];
  return ids.filter((sourceId) => getJobSourceCountryPolicy(sourceId, target, structuredLocation).include);
}

/** One record per requested source for deterministic diagnostics and UI copy. */
export function summarizeJobSourceCountryPolicies(sourceIds, target, structuredLocation = null) {
  const ids = Array.isArray(sourceIds) ? sourceIds : [];
  return ids.map((sourceId) => getJobSourceCountryPolicy(sourceId, target, structuredLocation));
}
