/**
 * General-purpose Gemini models that can serve every workflow used by this app:
 * text/JSON, structured outputs, image/PDF understanding, and search grounding.
 *
 * Keep scheduled-for-shutdown models here while their endpoints remain live and
 * usable on the API-key/free-tier path. Models that report a persistent 0/0
 * allocation in AI Studio are intentionally excluded so the app does not spend
 * every fallback chain probing guaranteed no-quota endpoints.
 */
export const GEMINI_MODEL_REGISTRY = Object.freeze([
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
    replacement: 'gemini-3.5-flash',
    thinkingConfig: { thinkingLevel: 'minimal' },
  },
  {
    id: 'gemini-2.5-flash',
    tier: 'flash',
    lifecycle: 'stable',
    shutdownDate: '2026-10-16',
    replacement: 'gemini-3.5-flash',
    thinkingConfig: { thinkingBudget: 0 },
  },
  {
    id: 'gemini-3.1-flash-lite',
    tier: 'lite',
    lifecycle: 'stable',
    shutdownDate: '2027-05-07',
    replacement: null,
    thinkingConfig: { thinkingLevel: 'minimal' },
  },
  {
    id: 'gemini-2.5-flash-lite',
    tier: 'lite',
    lifecycle: 'stable',
    shutdownDate: '2026-10-16',
    replacement: 'gemini-3.1-flash-lite',
    thinkingConfig: { thinkingBudget: 0 },
  },
]);

export const GEMINI_MODEL_FALLBACKS = Object.freeze(
  GEMINI_MODEL_REGISTRY.map(({ id }) => id),
);

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
 * Put the task's preferred model first, then preserve its cost/quality intent:
 * quality tasks exhaust Flash first; lightweight tasks exhaust Lite/Flash first.
 * Suppressed models remain at the tail as a last resort instead of being removed.
 */
export function orderGeminiModels(preferredModel, suppressedUntil = new Map(), now = Date.now()) {
  const preferred = getGeminiModelInfo(preferredModel);
  const tierOrder = preferred?.tier === 'lite'
    ? ['lite', 'flash']
    : preferred?.tier === 'flash'
      ? ['flash', 'lite']
      : ['flash', 'lite'];
  const tiered = tierOrder.flatMap((tier) => (
    GEMINI_MODEL_REGISTRY.filter((entry) => entry.tier === tier).map((entry) => entry.id)
  ));
  const base = preferred
    ? [preferredModel, ...tiered.filter((id) => id !== preferredModel)]
    : tiered;
  const ready = base.filter((id) => (suppressedUntil.get(id) || 0) <= now);
  const suppressed = base.filter((id) => (suppressedUntil.get(id) || 0) > now);
  return [...ready, ...suppressed];
}
