// Durable, non-gating collection qualifications for a completed Job Search.
//
// These are deliberately separate from scrapeWarnings: a source warning changes
// source-card state and can pause or skip scoring, whereas this describes rows
// that are still useful but whose provider cannot enforce a requested boundary.

export const COLLECTION_SCOPE_CAVEAT = Object.freeze({
  GLASSDOOR_COUNTRY_SCOPE_UNENFORCED: 'glassdoor-country-scope-unenforced',
});

const MAX_COLLECTION_SCOPE_CAVEATS = 4;
// Recovery sidecars are untrusted persisted input. Only inspect a small fixed
// prefix of the one source that can own this caveat; do not walk arbitrary
// source maps or provider-controlled arrays while reopening a manifest.
const MAX_MANIFEST_SCOPE_CAVEAT_RECORDS = 16;

/**
 * Derive only trusted, compact UI facts from main-process per-source receipts.
 * Never carry provider-controlled listing text into persisted node UI state.
 */
export function collectionScopeCaveatsFromSourceResults(sourceResults) {
  if (sourceResults?.glassdoor?.locationScopeUnenforced !== true) return [];
  return [{
    sourceId: 'glassdoor',
    code: COLLECTION_SCOPE_CAVEAT.GLASSDOOR_COUNTRY_SCOPE_UNENFORCED,
  }];
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
  target.glassdoor = { ...(target.glassdoor || {}), locationScopeUnenforced: true };
  return target;
}

/** Preserve only recognised caveat tokens when a saved node is re-used. */
export function normalizeCollectionScopeCaveats(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const normalized = [];
  for (const item of value) {
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
