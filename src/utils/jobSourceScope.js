// Shared job-source scope for dev / test mode.
//
// When enabled with a sourceId, only the targeted source participates in job search:
// - backend: all other sources are skipped entirely
// - frontend: only the targeted source card is spawned/shown
//
// Keep this file framework-agnostic so both `src/` and `electron/` can import it.
//
// Opt in with env vars instead of editing source:
// - JOB_SEARCH_TEST_ENABLED=true
// - JOB_SEARCH_TEST_SOURCE=linkedin
// - JOB_SEARCH_TEST_FULL_RUN=true
// - JOB_SEARCH_TEST_SKIP_AI=true
//
// Renderer builds may use the matching VITE_ prefix for the same keys.

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

function getRuntimeEnv() {
  return {
    ...(globalThis.process?.env || {}),
    ...(import.meta.env || {}),
  };
}

function getEnvValue(env, key) {
  return env[key] ?? env[`VITE_${key}`];
}

export function parseJobSearchEnvBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;

  const normalized = String(value).trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return fallback;
}

export function createJobSearchTestMode(env = getRuntimeEnv()) {
  const enabled = parseJobSearchEnvBoolean(getEnvValue(env, 'JOB_SEARCH_TEST_ENABLED'), false);
  const sourceId = String(getEnvValue(env, 'JOB_SEARCH_TEST_SOURCE') || '').trim();
  return {
    enabled,
    sourceId: enabled ? (sourceId || null) : null,
    // Run tier - only meaningful when enabled:true.
    // fullRun:false -> medium (5 jobs/page, AI skipped - quick smoke test)
    // fullRun:true  -> full   (150 jobs/page, AI per skipAI flag below)
    fullRun: parseJobSearchEnvBoolean(getEnvValue(env, 'JOB_SEARCH_TEST_FULL_RUN'), false),
    // skipAI: override AI scoring independently of fullRun.
    // true  -> AI skipped regardless of fullRun (collect jobs, stop before scoring)
    // false -> AI runs when fullRun:true; still skipped when fullRun:false
    skipAI: parseJobSearchEnvBoolean(getEnvValue(env, 'JOB_SEARCH_TEST_SKIP_AI'), false),
  };
}

export const JOB_SEARCH_TEST_MODE = createJobSearchTestMode();
export const TARGET_JOB_PLATFORM = JOB_SEARCH_TEST_MODE.sourceId;

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
