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
// - JOB_SEARCH_TEST_SKIP_AI=true
//
// Renderer builds may use the matching VITE_ prefix for the same keys.

import { getRuntimeEnv, getEnvValue, parseScopeEnvBoolean } from './sourceScopeShared.js';

// Public name kept for existing importers/tests; the logic is the shared parser.
export const parseJobSearchEnvBoolean = parseScopeEnvBoolean;

// Parse a comma-separated minutes list ("1,2,4,8,16,32") into a positive-number
// array; falls back to the default when empty/garbage.
function parseJobSearchWaitsMin(value, fallback) {
  if (value == null || value === '') return fallback;
  const parts = String(value)
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return parts.length ? parts : fallback;
}

export function createJobSearchTestMode(env = getRuntimeEnv()) {
  const enabled = parseJobSearchEnvBoolean(getEnvValue(env, 'JOB_SEARCH_TEST_ENABLED'), false);
  const sourceId = String(getEnvValue(env, 'JOB_SEARCH_TEST_SOURCE') || '').trim();
  return {
    enabled,
    sourceId: enabled ? (sourceId || null) : null,
    // Test mode may still skip AI explicitly. Collection breadth is deliberately
    // not a hidden test-mode setting; it is stored on the Job Search card.
    skipAI: parseJobSearchEnvBoolean(getEnvValue(env, 'JOB_SEARCH_TEST_SKIP_AI'), false),
    // Cooldown probe (diagnostic): when true, a LinkedIn Solve turns into an
    // automated wait-and-probe loop that waits escalating idle intervals on the
    // SAME IP/browser and stops at the first interval that clears the guest wall
    // — measuring how long the rate-limit needs to cool. waitsMin is the schedule
    // of idle waits (minutes) to try in order.
    probeCooldown: parseJobSearchEnvBoolean(getEnvValue(env, 'JOB_SEARCH_PROBE_COOLDOWN'), false),
    probeCooldownWaitsMin: parseJobSearchWaitsMin(getEnvValue(env, 'JOB_SEARCH_PROBE_WAITS_MIN'), [1, 2, 4, 8, 16, 32]),
  };
}

export const JOB_SEARCH_TEST_MODE = createJobSearchTestMode();

export function getScopedJobSourceIds(allSourceIds = []) {
  const ids = Array.isArray(allSourceIds) ? allSourceIds.filter(Boolean) : [];
  if (!JOB_SEARCH_TEST_MODE.enabled || !JOB_SEARCH_TEST_MODE.sourceId) return ids;
  return ids.filter(id => id === JOB_SEARCH_TEST_MODE.sourceId);
}

export function isJobSourceEnabledInScope(sourceId) {
  if (!JOB_SEARCH_TEST_MODE.enabled || !JOB_SEARCH_TEST_MODE.sourceId) return true;
  return sourceId === JOB_SEARCH_TEST_MODE.sourceId;
}
