// Shared env-resolution primitives for the dev/test source-scope modules
// (jobSourceScope.js + compSourceScope.js). These were byte-identical copies in
// both sibling files; consolidating here removes the drift hazard (e.g. adding a
// truthy spelling to one TRUE_VALUES set but not the other). Framework-agnostic
// so both `src/` and `electron/` can import it; renderer builds use the matching
// VITE_-prefixed keys, which getEnvValue resolves transparently.

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

export function getRuntimeEnv() {
  return {
    ...(globalThis.process?.env || {}),
    ...(import.meta.env || {}),
  };
}

export function getEnvValue(env, key) {
  // Treat a defined-but-empty unprefixed var (e.g. `FOO=` in a shell/.env) as
  // absent so it doesn't shadow a real `VITE_FOO=true`. Plain `??` only falls
  // through on null/undefined, which would return '' here and hide the prefixed value.
  const direct = env[key];
  if (direct != null && direct !== '') return direct;
  return env[`VITE_${key}`];
}

// Parse a scope env var into a boolean: known truthy/falsy spellings win, an
// actual boolean passes through, and anything empty/unrecognized uses `fallback`.
export function parseScopeEnvBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;

  const normalized = String(value).trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return fallback;
}
