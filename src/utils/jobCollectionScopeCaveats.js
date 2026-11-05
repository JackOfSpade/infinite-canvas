// Durable, non-gating collection qualifications for a completed Job Search.
//
// These are deliberately separate from scrapeWarnings: a source warning changes
// source-card state and can pause or skip scoring, whereas this describes rows
// that are still useful but whose provider cannot enforce a requested boundary.

export const COLLECTION_SCOPE_CAVEAT = Object.freeze({
  GLASSDOOR_COUNTRY_SCOPE_UNENFORCED: 'glassdoor-country-scope-unenforced',
});

/** A site's rows came back with fields missing: the scraper likely broke. Non-gating, but shown loudly. */
export const SOURCE_HEALTH_FAILED_CODE = 'source-health-failed';
const SOURCE_HEALTH_FIELDS = Object.freeze({ link: 'link', description: 'description', company: 'company', location: 'location', posted: 'posted date' });

const MAX_COLLECTION_SCOPE_CAVEATS = 16;
const MAX_SOURCE_HEALTH_FAILURES = 8;
// Recovery sidecars are untrusted persisted input. Only inspect a small fixed
// prefix of the one source that can own this caveat; do not walk arbitrary
// source maps or provider-controlled arrays while reopening a manifest.
const MAX_MANIFEST_SCOPE_CAVEAT_RECORDS = 16;

/**
 * Derive only trusted, compact UI facts from main-process per-source receipts.
 * Never carry provider-controlled listing text into persisted node UI state.
 */
export function collectionScopeCaveatsFromSourceResults(sourceResults) {
  const health = Object.entries(sourceResults && typeof sourceResults === 'object' ? sourceResults : {})
    .filter(([, source]) => Array.isArray(source?.healthFailures) && source.healthFailures.length)
    .map(([sourceId, source]) => ({ sourceId, code: SOURCE_HEALTH_FAILED_CODE, failures: source.healthFailures }));
  return normalizeCollectionScopeCaveats([
    ...(sourceResults?.glassdoor?.locationScopeUnenforced === true
      ? [{ sourceId: 'glassdoor', code: COLLECTION_SCOPE_CAVEAT.GLASSDOOR_COUNTRY_SCOPE_UNENFORCED }] : []),
    ...health,
  ]);
}

const healthCount = value => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
/** Persisted input: known field names and counts only, so no listing text can travel with it. */
function normalizeSourceHealthFailures(value) {
  return (Array.isArray(value) ? value : []).slice(0, MAX_SOURCE_HEALTH_FAILURES)
    .filter(item => item?.field === 'rows' || item?.field === 'salary' || item?.field === 'same-description' || Object.hasOwn(SOURCE_HEALTH_FIELDS, item?.field))
    .map(item => ({ field: item.field, rows: healthCount(item.rows), missing: healthCount(item.missing) }));
}

/** What a person reads, in one line. It says what is wrong with the data, not how the check works. */
export function describeSourceHealthFailures(failures) {
  return normalizeSourceHealthFailures(failures).map(item => {
    if (item.field === 'rows') return 'returned no listings and gave no reason';
    if (item.field === 'salary') return `no salary on any of ${item.rows} listings`;
    if (item.field === 'same-description') return `${item.missing} of ${item.rows} listings have another employer's description`;
    return `${SOURCE_HEALTH_FIELDS[item.field]} missing on ${item.missing} of ${item.rows} listings (${Math.round(item.rows ? (item.missing / item.rows) * 100 : 0)}%)`;
  }).join('; ');
}

export const sourceHealthSiteName = id => { const name = String(id || ''); return name.charAt(0).toUpperCase() + name.slice(1); };

/** Sites whose scrape looked broken in this completed search. */
export function sourceHealthCaveats(value) {
  return normalizeCollectionScopeCaveats(value).filter(item => item.code === SOURCE_HEALTH_FAILED_CODE);
}

/**
 * Recovery manifests retain only normalized per-source caveats. Rehydrate
 * facts from sources that are already terminal so a resumed search does not
 * lose a disclosure merely because it correctly avoids re-fetching that
 * provider. Missing/legacy fields are intentionally neutral.
 */
export function collectionScopeCaveatsFromCompletedManifestSources(sources) {
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) return [];
  const glassdoor = sources.glassdoor;
  if (glassdoor?.status !== 'done' || !Array.isArray(glassdoor.collectionScopeCaveats)) return [];
  return normalizeCollectionScopeCaveats(
    glassdoor.collectionScopeCaveats.slice(0, MAX_MANIFEST_SCOPE_CAVEAT_RECORDS),
  );
}

/** Apply trusted persisted caveats to the compact result summary used at return. */
export function hydrateCollectionScopeCaveatsIntoSourceResults(sourceResults, caveats) {
  const target = sourceResults && typeof sourceResults === 'object' ? sourceResults : {};
  if (!hasGlassdoorCountryScopeCaveat(caveats)) return target;
  // A done Glassdoor that staged no rows has no entry yet (recovery only seeds
  // sources that own staged jobs), so this creates it. Give it the full
  // per-source result shape: the Glassdoor gate and every later stage read
  // `jobs`/`warnings`/`stopReasons` unguarded, and a caveat-only stub crashed
  // the resume with "Cannot read properties of undefined (reading 'length')".
  target.glassdoor = {
    jobs: [],
    errors: 0,
    warnings: [],
    pagesWalked: 0,
    stopReasons: new Set(),
    ...(target.glassdoor || {}),
    locationScopeUnenforced: true,
  };
  return target;
}

/** Preserve only recognised caveat tokens when a saved node is re-used. */
export function normalizeCollectionScopeCaveats(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const normalized = [];
  for (const item of value) {
    if (item?.code === SOURCE_HEALTH_FAILED_CODE && /^[a-z]{2,32}$/u.test(String(item?.sourceId))) {
      const failures = normalizeSourceHealthFailures(item.failures);
      const key = `${item.code}:${item.sourceId}`;
      if (!failures.length || seen.has(key)) continue;
      seen.add(key);
      normalized.push({ sourceId: item.sourceId, code: item.code, failures });
      if (normalized.length >= MAX_COLLECTION_SCOPE_CAVEATS) break;
      continue;
    }
    if (
      item?.sourceId !== 'glassdoor'
      || item?.code !== COLLECTION_SCOPE_CAVEAT.GLASSDOOR_COUNTRY_SCOPE_UNENFORCED
      || seen.has(item.code)
    ) continue;
    seen.add(item.code);
    normalized.push({ sourceId: 'glassdoor', code: item.code });
    if (normalized.length >= MAX_COLLECTION_SCOPE_CAVEATS) break;
  }
  return normalized;
}

export function hasGlassdoorCountryScopeCaveat(value) {
  return normalizeCollectionScopeCaveats(value).some((item) => (
    item.code === COLLECTION_SCOPE_CAVEAT.GLASSDOOR_COUNTRY_SCOPE_UNENFORCED
  ));
}

/** A score-only saved-job pass must retain, but never broaden, collection facts. */
export function collectionScopeCaveatsForSavedJobReanalysis(runData) {
  return normalizeCollectionScopeCaveats(runData?.collectionScopeCaveats);
}
