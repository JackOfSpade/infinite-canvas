/**
 * General-purpose Gemini models that can serve every workflow used by this app:
 * text/JSON, structured outputs, image/PDF understanding, and search grounding.
 *
 * Keep scheduled-for-shutdown models here while their endpoints remain live and
 * usable on the API-key/free-tier path.
 *
 * ── Ordering is the shared RPD-maximizing cascade ──────────────────────────
 * Flash → entitled Pro → Flash alias → Lite → Lite alias → Gemma. The free
 * tier is request-per-day bound for Gemini, so every compatible request gets
 * room to reason before moving to the next independent quota pool.
 *
 * ── The Pro tier is ENTITLEMENT-GATED, not hard-coded out ──────────────────
 * Pro models are listed here but carry `requiresEntitlement: true`, which keeps
 * them out of every fallback chain until a live probe proves this credential can
 * actually call them. This replaces an older hand-written "Pro has 0/0 free-tier
 * quota, so it is excluded" comment — a claim that was true when written, but
 * silently unverifiable afterwards and wrong the moment a key gets upgraded.
 *
 * ListModels was refreshed against the configured AI Studio key on 2026-08-13.
 * The access results below come from small generateContent probes on 2026-08-12
 * for the existing catalog and 2026-08-13 for 3.7:
 *
 *   gemini-3.1-pro-preview   429  "limit: 0" on generate_content_free_tier_input_token_count
 *   gemini-pro-latest        429  "limit: 0" on generate_content_free_tier_requests
 *   gemini-2.5-pro           404  "no longer available to new users"
 *   gemini-3.7-flash         200  ✓   gemini-3.6-flash          200  ✓
 *   gemini-3.5-flash-lite    200  ✓
 *   gemini-3.5-flash         200  ✓   gemini-3.1-flash-lite     200  ✓
 *   gemini-3-flash-preview   200  ✓   gemini-2.5-flash-lite     200  ✓
 *   gemini-2.5-flash         200  ✓
 *
 * So on TODAY's free-tier key the effective chain is flash → lite, exactly as
 * before — but the exclusion is now a measured fact with a 7-day TTL
 * (`geminiEntitlement.js`) instead of a comment. Put a billing-enabled key in
 * Settings and Pro joins the front of the quality chain on the next probe, with
 * no code change. Never re-add a blanket "Pro is excluded" constant: the whole
 * point is that entitlement is a property of the credential, not of the app.
 *
 * The legacy `gemini-3.1-flash-lite-preview` is intentionally absent because
 * Google's current changelog says it was shut down on 2026-05-25. Gemma is
 * hosted by this API but is capability-gated out of schema and grounded calls.
 */
// High thinking needs room for both private reasoning and the visible answer.
// This is a request cap, not a billing commitment: unused output is not spent.
export const GEMINI_MAX_OUTPUT_TOKENS = 16384;

export const GEMINI_MODEL_REGISTRY = Object.freeze([
  // ── Pro tier — capability ceiling, gated on a verified entitlement ────────
  {
    id: 'gemini-3.1-pro-preview',
    tier: 'pro',
    lifecycle: 'preview',
    shutdownDate: null,
    replacement: null,
    thinkingConfig: { thinkingLevel: 'high' },
    requiresEntitlement: true,
  },
  {
    id: 'gemini-3.1-pro-preview-customtools',
    tier: 'pro', lifecycle: 'preview', shutdownDate: null, replacement: null,
    thinkingConfig: { thinkingLevel: 'high' }, requiresEntitlement: true,
  },
  {
    id: 'gemini-pro-latest',
    tier: 'pro', lifecycle: 'alias', shutdownDate: null, replacement: null,
    thinkingConfig: { thinkingLevel: 'high' }, requiresEntitlement: true,
  },
  // ── Flash tier — the quality workhorses ───────────────────────────────────
  {
    id: 'gemini-3.7-flash',
    tier: 'flash',
    lifecycle: 'stable',
    shutdownDate: null,
    replacement: null,
    thinkingConfig: { thinkingLevel: 'high' },
  },
  {
    id: 'gemini-3.6-flash',
    tier: 'flash',
    lifecycle: 'stable',
    shutdownDate: null,
    replacement: null,
    thinkingConfig: { thinkingLevel: 'high' },
  },
  {
    id: 'gemini-3.5-flash',
    tier: 'flash',
    lifecycle: 'stable',
    shutdownDate: null,
    replacement: null,
    thinkingConfig: { thinkingLevel: 'high' },
  },
  {
    id: 'gemini-3-flash-preview',
    tier: 'flash',
    lifecycle: 'preview',
    shutdownDate: null,
    // Google's current deprecation table still names 3.6 as this preview's
    // recommended migration target, even though 3.7 is now the ladder head.
    replacement: 'gemini-3.6-flash',
    thinkingConfig: { thinkingLevel: 'high' },
  },
  {
    id: 'gemini-flash-latest',
    tier: 'flash-alias',
    lifecycle: 'alias',
    shutdownDate: null,
    replacement: null,
    thinkingConfig: { thinkingLevel: 'high' },
  },
  // ── Lite tier — mechanical/short structured work ──────────────────────────
  {
    id: 'gemini-3.5-flash-lite',
    tier: 'lite',
    lifecycle: 'stable',
    shutdownDate: null,
    replacement: null,
    thinkingConfig: { thinkingLevel: 'high' },
  },
  {
    id: 'gemini-3.1-flash-lite',
    tier: 'lite',
    lifecycle: 'stable',
    shutdownDate: null,
    replacement: 'gemini-3.5-flash-lite',
    thinkingConfig: { thinkingLevel: 'high' },
  },
  {
    id: 'gemini-flash-lite-latest',
    tier: 'lite-alias',
    lifecycle: 'alias',
    shutdownDate: null,
    replacement: null,
    thinkingConfig: { thinkingLevel: 'high' },
  },
  // Gemma has a separate TPM ceiling, so minimal thinking preserves its role
  // as the final rescue path. It is excluded from schema/grounding calls.
  {
    id: 'gemma-4-31b-it', tier: 'gemma', lifecycle: 'stable', shutdownDate: null,
    replacement: null, thinkingConfig: { thinkingLevel: 'minimal' },
    supportsStructuredOutput: false, supportsGrounding: false,
  },
  {
    id: 'gemma-4-26b-a4b-it', tier: 'gemma', lifecycle: 'stable', shutdownDate: null,
    replacement: null, thinkingConfig: { thinkingLevel: 'minimal' },
    supportsStructuredOutput: false, supportsGrounding: false,
  },
]);

/** Shared cascade order, retained for diagnostics and tests. */
export const GEMINI_TIER_LADDER = Object.freeze(['flash', 'pro', 'flash-alias', 'lite', 'lite-alias', 'gemma']);

/**
 * Ids that are usable WITHOUT a proven entitlement — i.e. the chain every
 * credential can rely on. This is what the availability sweep probes, what
 * checkPromptFits budgets the smallest context window across, and what the
 * bug report lists as "compatible models". Entitlement-gated ids are
 * deliberately absent: probing a model we know we cannot call burns a request
 * from the shared RPD pool to learn nothing.
 */
export const GEMINI_MODEL_FALLBACKS = Object.freeze(
  GEMINI_MODEL_REGISTRY.filter((entry) => !entry.requiresEntitlement).map(({ id }) => id),
);

// Vertex AI is a separate provider surface from AI Studio. Its global endpoint
// does not expose the speculative 3.x/alias catalog above; keep its known-good
// models in a deliberately small, provider-specific chain. Task declarations
// may still prefer their AI Studio-quality id (for example 3.7 Flash), but the
// Vertex transport must never send that unsupported id before these fallbacks.
export const VERTEX_GEMINI_MODEL_FALLBACKS = Object.freeze([
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
]);

// Vertex Gemini 2.5 uses the REST `thinkingBudget` form; the AI Studio 3.x
// registry above uses its `thinkingLevel` form. Keep this beside the Vertex
// fallback list so probes and real calls cannot accidentally send the latter
// to a 2.5 publisher model.
const VERTEX_THINKING_CONFIG = Object.freeze({ thinkingBudget: 1024 });

/** Every id in the registry, gated or not — for metadata lookups (token windows). */
export const GEMINI_ALL_MODEL_IDS = Object.freeze(GEMINI_MODEL_REGISTRY.map(({ id }) => id));

/** The ids in `tier`, registry order (newest generation first). */
export function geminiModelsInTier(tier) {
  return GEMINI_MODEL_REGISTRY.filter((entry) => entry.tier === tier).map(({ id }) => id);
}

const MODEL_BY_ID = new Map(GEMINI_MODEL_REGISTRY.map((entry) => [entry.id, entry]));

export function getGeminiModelInfo(model) {
  return MODEL_BY_ID.get(model) || null;
}

export function getGeminiDefaultThinkingConfig(model) {
  const config = getGeminiModelInfo(model)?.thinkingConfig;
  if (config) return { ...config };
  if (VERTEX_GEMINI_MODEL_FALLBACKS.includes(model)) return { ...VERTEX_THINKING_CONFIG };
  return /^gemma-/i.test(String(model || ''))
    ? { thinkingLevel: 'minimal' }
    : { thinkingLevel: 'high' };
}

function formatDate(dateText) {
  const [year, month, day] = String(dateText || '').split('-').map(Number);
  if (!year || !month || !day) return dateText;
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export function getGeminiLifecycleWarning(model, now = Date.now()) {
  const info = getGeminiModelInfo(model);
  if (!info?.shutdownDate) return null;
  const shutdownAt = Date.parse(`${info.shutdownDate}T00:00:00Z`);
  const replacement = info.replacement ? ` Use ${info.replacement} as its replacement.` : '';
  if (Number.isFinite(shutdownAt) && now >= shutdownAt) {
    return `Scheduled shutdown date passed on ${formatDate(info.shutdownDate)}; the endpoint may no longer be reachable.${replacement}`;
  }
  return `Scheduled to shut down no earlier than ${formatDate(info.shutdownDate)}.${replacement}`;
}

/**
 * A zero quota means this credential/project is not entitled to use the model.
 * Google's dashboard renders that state as `0 / 0`: zero used out of a zero
 * limit, not an exhausted positive allowance.
 */
export function isGeminiZeroQuota(message = '') {
  const text = String(message || '');
  return /\blimit(?: value)?\s*[:=]?\s*0\b/i.test(text)
    || /"quotaValue"\s*:\s*"?0"?/i.test(text);
}

/** A per-day/RPD failure cannot recover on the short burst-limit timer. */
export function isGeminiDailyQuota(message = '') {
  const text = String(message || '');
  return /per[\s_-]?day/i.test(text)
    || /\b(daily|rpd)\b/i.test(text);
}

export function isGeminiZeroOrDailyQuota(message = '') {
  return isGeminiZeroQuota(message) || isGeminiDailyQuota(message);
}

/**
 * Classify provider failures without coupling the policy to fetch/Error objects.
 * The status is preferred; message matching covers errors already flattened by
 * an upstream layer.
 *
 * Two distinct permission outcomes matter to the fallback loop:
 *   - `auth`        — a CREDENTIAL/project-level failure (bad/disabled key,
 *                     unregistered caller). Every model fails identically, so the
 *                     caller aborts the whole chain fast.
 *   - `model-access`— a PER-MODEL permission failure (the key isn't allow-listed
 *                     for e.g. a Pro preview). Other models may still work, so the
 *                     caller must suppress only this model and keep cascading.
 * A bare 403 / PERMISSION_DENIED is ambiguous; we treat it as model-access unless
 * the message clearly points at the credential. Worst case (a project-level 403
 * with no credential wording) we try every model and aggregate-fail — slower, but
 * never silently drops a working Flash model because Pro was denied.
 */
export function classifyGeminiFailure(status, message = '') {
  const code = Number(status) || null;
  const text = String(message || '').toLowerCase();
  if (text.includes('abort')) return 'aborted';

  // Quota/rate first: a 429 can carry "per API key" wording that would otherwise
  // trip the credential check below. Keep zero-entitlement, daily exhaustion,
  // and short burst throttling distinct because each has a different remedy.
  if (code === 429 || text.includes('quota') || text.includes('rate limit') || text.includes('resource_exhausted')) {
    if (isGeminiZeroQuota(message)) return 'no-quota';
    if (isGeminiDailyQuota(message)) return 'daily-quota';
    return 'rate-limit';
  }

  // Credential/project-level signals — affect every model, so abort the chain.
  const credentialSignal =
    text.includes('api key')
    || text.includes('api_key')
    || text.includes('unregistered')
    || text.includes('unauthenticated')
    || text.includes('authentication credential')
    || text.includes('has not been used in project')
    || text.includes('api has not been used')
    || text.includes('it is disabled');
  if (credentialSignal && (code == null || code === 400 || code === 401 || code === 403)) return 'auth';
  if (code === 401 || text.includes('unauthorized')) return 'auth';

  // Remaining 403 / permission-denied is per-model: suppress this model, cascade.
  if (code === 403 || text.includes('permission denied') || text.includes('permission_denied')) return 'model-access';

  if (
    code === 404
    || text.includes('not found')
    || text.includes('not supported')
    || text.includes('not available')
    || text.includes('does not exist')
    || text.includes('not enabled')
  ) return 'unavailable';
  // An alias/preview can exist but reject its thinking configuration. That is a
  // model-local incompatibility, not a request failure: cool it down and keep
  // the cascade moving instead of burning the same RPD on every call.
  if (code === 400 && /thinking(?:config|[ _-]?(?:level|budget))/.test(text)) return 'thinking-config';
  if ([500, 502, 503, 504].includes(code) || /\b(500|502|503|504)\b/.test(text)) return 'server';
  if (text.includes('truncat') || text.includes('max_tokens') || text.includes('token output cap')) return 'truncation';
  return 'other';
}

export function isGeminiProviderAvailable(modelResults) {
  return Array.isArray(modelResults) && modelResults.some((result) => result?.ok);
}

/**
 * Produce a concise, actionable diagnostic without losing the provider's raw
 * message for classifications that do not need clarification.
 */
export function describeGeminiFailure(classification, message = '') {
  if (classification === 'no-quota') {
    return 'No quota is allocated to this credential/project for this model (limit 0). Google shows this as 0 / 0; it is not consumed usage.';
  }
  if (classification === 'daily-quota') {
    return 'The model\'s daily request quota is exhausted. It will not recover on a short retry timer.';
  }
  return String(message || '');
}

/**
 * Build the shared fallback chain for one call. `preferredModel` is kept for
 * telemetry/API compatibility, but the portable cascade order above wins so
 * every workflow uses the same independent quota pools.
 *
 * `opts.entitledTiers` (Set|Array of tier names) admits `requiresEntitlement`
 * models. Omit it and Pro is absent — the correct default, because an
 * unentitled Pro model 429s on every single call and would cost one wasted
 * round-trip per request forever. gemini.js supplies this from the cached
 * live probe (see geminiEntitlement.js).
 *
 * A preferred model that is not in the registry is DROPPED rather than
 * prepended — that's what keeps a stale/removed id in TASK_MODELS from
 * poisoning the chain with a guaranteed-404 first attempt.
 *
 * Suppressed models move to the tail as a last resort instead of being
 * removed, so a fully-suppressed chain still attempts something.
 */
export function orderGeminiModels(preferredModel, suppressedUntil = new Map(), now = Date.now(), opts = {}) {
  void preferredModel;
  const entitled = opts.entitledTiers instanceof Set
    ? opts.entitledTiers
    : new Set(Array.isArray(opts.entitledTiers) ? opts.entitledTiers : []);

  const base = GEMINI_TIER_LADDER.flatMap((tier) => GEMINI_MODEL_REGISTRY
    .filter((entry) => entry.tier === tier)
    .filter((entry) => !entry.requiresEntitlement || entitled.has(entry.tier))
    .filter((entry) => !opts.responseSchema || entry.supportsStructuredOutput !== false)
    .filter((entry) => !opts.grounding || entry.supportsGrounding !== false)
    .map((entry) => entry.id));
  const excluded = new Set(Array.isArray(opts.excludeModels) ? opts.excludeModels.filter(Boolean) : []);
  const withoutExcluded = base.filter(id => !excluded.has(id));
  // Adversarial second passes can exclude the exact model that authored the
  // material under review. Reuse it only if a future catalog leaves no other
  // compatible model at all; an empty cascade would be less safe.
  const eligible = withoutExcluded.length ? withoutExcluded : base;

  const ready = eligible.filter((id) => (suppressedUntil.get(id) || 0) <= now);
  const suppressed = eligible.filter((id) => (suppressedUntil.get(id) || 0) > now);
  return [...ready, ...suppressed];
}

/**
 * Vertex has its own supported catalog, so it cannot share AI Studio's tier
 * registry or entitlement probes. Suppressed models retain the normal
 * last-resort behavior: cool them to the tail, but never make a chain empty.
 */
export function orderVertexGeminiModels(suppressedUntil = new Map(), now = Date.now(), opts = {}) {
  const excluded = new Set(Array.isArray(opts.excludeModels) ? opts.excludeModels.filter(Boolean) : []);
  const withoutExcluded = VERTEX_GEMINI_MODEL_FALLBACKS.filter(id => !excluded.has(id));
  const eligible = withoutExcluded.length ? withoutExcluded : VERTEX_GEMINI_MODEL_FALLBACKS;
  const ready = eligible
    .filter((id) => (suppressedUntil.get(id) || 0) <= now);
  const suppressed = eligible
    .filter((id) => (suppressedUntil.get(id) || 0) > now);
  return [...ready, ...suppressed];
}
