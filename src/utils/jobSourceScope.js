// Shared job-source scope for dev / test mode.
//
// When enabled, only the targeted source participates in job search:
// - backend: all other sources are skipped entirely
// - frontend: only the targeted source card is spawned/shown
//
// Keep this file framework-agnostic so both `src/` and `electron/` can import it.

export const TARGET_JOB_PLATFORM = 'indeed';

export const JOB_SEARCH_TEST_MODE = {
  enabled: true,
  sourceId: TARGET_JOB_PLATFORM,
  // fullRun: production caps + full AI scoring, but still scoped to one platform.
  // false = limited caps + skip AI (quick smoke test).
  // true  = full pipeline run (validate end-to-end quality for this platform).
  fullRun: false,
};

export function getScopedJobSourceIds(allSourceIds = []) {
  const ids = Array.isArray(allSourceIds) ? allSourceIds.filter(Boolean) : [];
  if (!JOB_SEARCH_TEST_MODE.enabled || !JOB_SEARCH_TEST_MODE.sourceId) return ids;
  return ids.filter(id => id === JOB_SEARCH_TEST_MODE.sourceId);
}

export function getScopedJobSources(allSources = []) {
  const sources = Array.isArray(allSources) ? allSources.filter(Boolean) : [];
  if (!JOB_SEARCH_TEST_MODE.enabled || !JOB_SEARCH_TEST_MODE.sourceId) return sources;
  return sources.filter(source => source?.id === JOB_SEARCH_TEST_MODE.sourceId);
}

export function isJobSourceEnabledInScope(sourceId) {
  if (!JOB_SEARCH_TEST_MODE.enabled || !JOB_SEARCH_TEST_MODE.sourceId) return true;
  return sourceId === JOB_SEARCH_TEST_MODE.sourceId;
}
