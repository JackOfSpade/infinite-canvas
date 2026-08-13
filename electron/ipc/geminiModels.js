/**
 * General-purpose Gemini models that can serve every workflow used by this app:
 * text/JSON, structured outputs, image/PDF understanding, and search grounding.
 *
 * Keep scheduled-for-shutdown models here while their endpoints remain live and
 * usable on the API-key/free-tier path.
 *
 * ── Ordering is a CAPABILITY LADDER: pro → flash → lite ────────────────────
 * Within a tier, entries are newest-generation first, so a quality task walks
 * the most capable model it is entitled to down to the cheapest that still
 * works. `orderGeminiModels` builds the per-call chain from this order.
 *
 * ── The Pro tier is ENTITLEMENT-GATED, not hard-coded out ──────────────────
 * Pro models are listed here but carry `requiresEntitlement: true`, which keeps
 * them out of every fallback chain until a live probe proves this credential can
 * actually call them. This replaces an older hand-written "Pro has 0/0 free-tier
 * quota, so it is excluded" comment — a claim that was true when written, but
 * silently unverifiable afterwards and wrong the moment a key gets upgraded.
 *
 * Verified live against the configured AI Studio key on 2026-08-12 (one minimal
 * generateContent call per model — the same probe `probeGemini` sends):
 *
 *   gemini-3.1-pro-preview   429  "limit: 0" on generate_content_free_tier_input_token_count
 *   gemini-pro-latest        429  "limit: 0" on generate_content_free_tier_requests
 *   gemini-2.5-pro           404  "no longer available to new users"
 *   gemini-3.6-flash         200  ✓   gemini-3.5-flash-lite     200  ✓
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
 * All ids below were confirmed present in this key's ListModels response, and
 * every one honors `responseSchema` + `thinkingLevel: 'minimal'` (probed
 * directly — a model that cannot do structured output would break every
 * schema-forced task in aiSchemas.js).
 */
export const GEMINI_MODEL_REGISTRY = Object.freeze([
  // ── Pro tier — capability ceiling, gated on a verified entitlement ────────
  {
    id: 'gemini-3.1-pro-preview',
    tier: 'pro',
    lifecycle: 'preview',
    shutdownDate: null,
    replacement: null,
    thinkingConfig: { thinkingLevel: 'minimal' },
    requiresEntitlement: true,
  },
  // ── Flash tier — the quality workhorses ───────────────────────────────────
  {
    id: 'gemini-3.6-flash',
    tier: 'flash',
    lifecycle: 'stable',
    shutdownDate: null,
    replacement: null,
    thinkingConfig: { thinkingLevel: 'minimal' },
  },
  {
    id: 'gemini-3.5-flash',
    tier: 'flash',
    lifecycle: 'stable',
    shutdownDate: null,
    replacement: null,
    thinkingConfig: { thinkingLevel: 'minimal' },
  },
  {
    id: 'gemini-3-flash-preview',
    tier: 'flash',
    lifecycle: 'preview',
    shutdownDate: null,
    replacement: 'gemini-3.6-flash',
    thinkingConfig: { thinkingLevel: 'minimal' },
  },
  {
    id: 'gemini-2.5-flash',
    tier: 'flash',
    lifecycle: 'stable',
    shutdownDate: '2026-10-16',
    replacement: 'gemini-3.6-flash',
    thinkingConfig: { thinkingBudget: 0 },
  },
  // ── Lite tier — mechanical/short structured work ──────────────────────────
  {
    id: 'gemini-3.5-flash-lite',
    tier: 'lite',
    lifecycle: 'stable',
    shutdownDate: null,
    replacement: null,
    thinkingConfig: { thinkingLevel: 'minimal' },
  },
  {
    id: 'gemini-3.1-flash-lite',
    tier: 'lite',
    lifecycle: 'stable',
    shutdownDate: '2027-05-07',
    replacement: 'gemini-3.5-flash-lite',
    thinkingConfig: { thinkingLevel: 'minimal' },
  },
  {
    id: 'gemini-2.5-flash-lite',
    tier: 'lite',
    lifecycle: 'stable',
    shutdownDate: '2026-10-16',
    replacement: 'gemini-3.5-flash-lite',
    thinkingConfig: { thinkingBudget: 0 },
  },
]);

/** Capability ladder, most capable first. Drives orderGeminiModels' tier walk. */
export const GEMINI_TIER_LADDER = Object.freeze(['pro', 'flash', 'lite']);

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
  return config ? { ...config } : { thinkingLevel: 'minimal' };
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
 * Build the fallback chain for one call: walk the capability ladder from the
 * most capable tier this credential may use down to the cheapest.
 *
 * Tier walk, by the preferred model's own tier:
 *   - `lite`  (lightweight tasks) → ['lite', 'flash'].  Deliberately never
 *     climbs to Pro: a task whose author chose Lite wants the cheap tier, and
 *     silently promoting it to the most expensive model would invert that.
 *   - anything else (quality tasks, or an unrecognized preferred model)
 *     → ['pro', 'flash', 'lite'], i.e. most advanced first.
 *
 * Within a tier the registry order (newest generation first) holds, except
 * that the task's own preferred model is hoisted to the front of ITS tier —
 * so a task keeps the exact model its author picked as the first thing tried
 * inside that tier, while still getting a more capable tier ahead of it when
 * one is available.
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
  const preferred = getGeminiModelInfo(preferredModel);
  const entitled = opts.entitledTiers instanceof Set
    ? opts.entitledTiers
    : new Set(Array.isArray(opts.entitledTiers) ? opts.entitledTiers : []);

  const tierOrder = preferred?.tier === 'lite'
    ? ['lite', 'flash']
    : GEMINI_TIER_LADDER;

  const base = tierOrder.flatMap((tier) => {
    const ids = GEMINI_MODEL_REGISTRY
      .filter((entry) => entry.tier === tier && (!entry.requiresEntitlement || entitled.has(tier)))
      .map((entry) => entry.id);
    // Hoist the task's own pick to the front of its tier.
    return preferred?.tier === tier && ids.includes(preferredModel)
      ? [preferredModel, ...ids.filter((id) => id !== preferredModel)]
      : ids;
  });

  const ready = base.filter((id) => (suppressedUntil.get(id) || 0) <= now);
  const suppressed = base.filter((id) => (suppressedUntil.get(id) || 0) > now);
  return [...ready, ...suppressed];
}
