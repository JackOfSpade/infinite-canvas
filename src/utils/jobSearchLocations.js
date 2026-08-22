import { normalizeCountry, normalizeLocationInput } from './jobLocation.js';

// Job-search locations are deliberately stored as fields, rather than one
// comma-separated phrase.  This keeps the UI unambiguous and lets the salary
// research pipeline use an exact residence without re-parsing user input.
export const REMOTE_RESIDENCE_STORAGE_KEY = 'infiniteCanvas.jobSearch.remoteResidences';

export const EMPTY_LOCATION = Object.freeze({ city: '', subdivision: '', country: '', countryCode: null });

export function fixedCountryLocation(country) {
  const canonical = normalizeCountry(country);
  return {
    city: '',
    subdivision: '',
    country: canonical,
    countryCode: canonical === 'United States' ? 'US' : canonical === 'Canada' ? 'CA' : null,
  };
}

export function defaultRemoteResidences() {
  return {
    usa: fixedCountryLocation('United States'),
    canada: fixedCountryLocation('Canada'),
    other: { ...EMPTY_LOCATION },
  };
}

function stringField(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// `normalizeCountry` deliberately leaves `CA` alone because it is ambiguous in
// a free-form location phrase (California vs. Canada). In this UI, however,
// Country is its own field, so `CA` / `CAN` can only sensibly mean Canada.
// Keep this small and deliberately limited to the two countries for which the
// product owns deterministic geography; every other country stays AI-resolved.
function normalizeStructuredCountry(value) {
  const raw = stringField(value);
  const key = raw.toLowerCase().replace(/[.\s]/g, '');
  if (key === 'ca' || key === 'can') return 'Canada';
  if (key === 'us' || key === 'usa') return 'United States';
  return normalizeCountry(raw);
}

/**
 * Normalizes only the deterministic U.S./Canadian cases.  Other countries are
 * intentionally left field-shaped for the backend's batched AI validation;
 * guessing foreign subdivisions here would be costly to maintain and wrong
 * often enough to be harmful.
 */
export function normalizeStructuredLocation(value, fallbackText = '') {
  const raw = value && typeof value === 'object' ? value : null;
  if (!raw) {
    const legacy = normalizeLocationInput(fallbackText);
    return {
      city: legacy.city || '',
      subdivision: legacy.subdivision || '',
      country: legacy.country || '',
      countryCode: legacy.countryCode || null,
      legacyLocationText: stringField(fallbackText),
    };
  }

  const country = normalizeStructuredCountry(raw.country);
  const city = stringField(raw.city);
  // `stateCode` / `region` were the pre-structured canonical-location shape.
  // Reading them here keeps saved snapshots and canvases usable after upgrade.
  let subdivision = stringField(raw.subdivision || raw.stateCode || raw.region);
  let countryConflict = false;
  // Reuse the existing deterministic US/CA tables.  Supplying a country keeps
  // an Ontario/USA mistake from silently becoming a plausible place.
  if (country === 'United States' || country === 'Canada') {
    const parsed = normalizeLocationInput([city, subdivision, country].filter(Boolean).join(', '));
    countryConflict = !!parsed.countryConflict;
    if (!countryConflict && parsed.subdivision) subdivision = parsed.subdivision;
  }
  return {
    city,
    subdivision,
    country,
    countryCode: country === 'United States' ? 'US' : country === 'Canada' ? 'CA' : null,
    countryConflict,
    ...(stringField(raw.legacyLocationText) ? { legacyLocationText: stringField(raw.legacyLocationText) } : {}),
  };
}

export function normalizeRemoteResidences(value) {
  const source = value && typeof value === 'object' ? value : {};
  // The group label—not a legacy stored country string—is authoritative for
  // these two residences. Re-normalize subdivision under that fixed country so
  // `Ontario` in the USA group (or `Colorado` in Canada) is caught before an AI
  // call instead of becoming a plausible-but-wrong location.
  const usa = normalizeStructuredLocation({ ...(source.usa || {}), country: 'United States' });
  const canada = normalizeStructuredLocation({ ...(source.canada || {}), country: 'Canada' });
  const other = normalizeStructuredLocation(source.other);
  return {
    usa: { ...usa, country: 'United States', countryCode: 'US' },
    canada: { ...canada, country: 'Canada', countryCode: 'CA' },
    other,
  };
}

export function locationToLegacyText(value, fallbackText = '') {
  const location = normalizeStructuredLocation(value, fallbackText);
  const fields = [location.city, location.subdivision, location.country].filter(Boolean);
  return fields.join(', ') || location.legacyLocationText || '';
}

export function getSearchLocation(data = {}) {
  const firstText = [data.searchLocation, data.preferredLocation, data.canonicalLocation]
    .find(value => typeof value === 'string' && value.trim());
  const fallbackText = firstText || '';
  let structured = normalizeStructuredLocation(
    data.searchLocation && typeof data.searchLocation === 'object'
      ? data.searchLocation
      : (data.canonicalLocation && typeof data.canonicalLocation === 'object' ? data.canonicalLocation : null),
    fallbackText,
  );
  // A short-lived migration wrote an empty new-field shell while retaining the
  // old structured canonical object. Prefer a populated canonical object over
  // that shell; otherwise reopening the canvas makes its saved location blank.
  if (!structured.city && !structured.subdivision && !structured.country
    && data.searchLocation && typeof data.searchLocation === 'object'
    && data.canonicalLocation && typeof data.canonicalLocation === 'object') {
    const canonical = normalizeStructuredLocation(data.canonicalLocation);
    if (canonical.city || canonical.subdivision || canonical.country) structured = canonical;
  }
  // Some early migrations wrote an empty structured shell alongside the old
  // text field. Treat that shell as absent so a saved canvas never loses its
  // existing location or becomes impossible to rerun after updating.
  if (!structured.city && !structured.subdivision && !structured.country && fallbackText) {
    return normalizeStructuredLocation(null, fallbackText);
  }
  return structured;
}

export function hasRequiredLocations(searchLocation, remoteResidences) {
  const search = normalizeStructuredLocation(searchLocation);
  const remote = normalizeRemoteResidences(remoteResidences);
  return Boolean(
    search.country
    && !search.countryConflict
    && remote.usa.country
    && !remote.usa.countryConflict
    && remote.canada.country
    && !remote.canada.countryConflict
    && remote.other.country
    && !remote.other.countryConflict
    && remote.other.country !== 'United States'
    && remote.other.country !== 'Canada',
  );
}

export function locationValidationMessage(searchLocation, remoteResidences) {
  const search = normalizeStructuredLocation(searchLocation);
  const remote = normalizeRemoteResidences(remoteResidences);
  if (search.countryConflict) return 'The search location combines a U.S. state or Canadian province with the wrong country. Correct the state / province or country.';
  if (remote.usa.countryConflict) return 'The remote residence under “Job is in USA” has a state / province that is not in the United States.';
  if (remote.canada.countryConflict) return 'The remote residence under “Job is in Canada” has a state / province that is not in Canada.';
  if (remote.other.countryConflict) return 'The remote residence outside the US and Canada combines a U.S. state or Canadian province with the wrong country.';
  if (!search.country) return 'Enter a country for the search location before starting the job search.';
  if (!remote.other.country) return 'Enter where you would live for a remote job outside the US and Canada.';
  if (remote.other.country === 'United States' || remote.other.country === 'Canada') {
    return 'For “Job is outside US/Canada,” choose a country other than the United States or Canada.';
  }
  return '';
}

export function readLastRemoteResidences(storage = globalThis?.localStorage) {
  try {
    const saved = storage?.getItem(REMOTE_RESIDENCE_STORAGE_KEY);
    return normalizeRemoteResidences(saved ? JSON.parse(saved) : null);
  } catch {
    return defaultRemoteResidences();
  }
}

export function writeLastRemoteResidences(value, storage = globalThis?.localStorage) {
  const normalized = normalizeRemoteResidences(value);
  try {
    storage?.setItem(REMOTE_RESIDENCE_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Persistence is a convenience; private browsing/quota failures must not
    // prevent a user from searching with the values already on this module.
  }
  return normalized;
}
