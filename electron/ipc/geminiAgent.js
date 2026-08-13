/**
 * Antigravity's managed-agent target on the Gemini Interactions API.
 *
 * This is deliberately NOT part of GEMINI_MODEL_REGISTRY: it is an agent
 * transport with its own quota bucket, not a generateContent model. Google
 * currently powers it with Gemini 3.6 Flash, but the request/response contract
 * differs materially from a model call (no responseSchema, no documents, and
 * max_total_tokens instead of maxOutputTokens).
 */
export const ANTIGRAVITY_AGENT_ID = 'antigravity-preview-05-2026';
export const ANTIGRAVITY_DEFAULT_MODEL = 'gemini-3.6-flash';

const INTERACTIONS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const REQUEST_TIMEOUT_MS = 300_000;
const MAX_TOTAL_TOKEN_BUDGET = 90_000;

/** Only the input types the preview agent documents today. */
export function antigravityPartsSupported(parts) {
  return Array.isArray(parts) && parts.length > 0 && parts.every((part) =>
    typeof part?.text === 'string'
    || (
      typeof part?.inlineData?.data === 'string'
      && /^image\//i.test(String(part.inlineData.mimeType || ''))
    ),
  );
}

/**
 * The preview agent cannot enforce structured outputs. Keep it behind the
 * ordinary ladder for raw prose/HTML only; schema-constrained JSON continues
 * to fail loud rather than silently weakening its output contract.
 */
export function canUseAntigravityFallback(parts, apiKey, genConfig = {}) {
  return !!apiKey
    && antigravityPartsSupported(parts)
    && !genConfig.responseSchema
    && genConfig.responseMimeType === 'text/plain';
}

function underlyingModelFor(preferredModel) {
  if (/flash[-_]?lite/i.test(String(preferredModel || ''))) return 'gemini-3.5-flash-lite';
  if (String(preferredModel || '') === 'gemini-3.5-flash') return 'gemini-3.5-flash';
  return ANTIGRAVITY_DEFAULT_MODEL;
}

function interactionInput(parts) {
  return parts.map((part) => {
    if (typeof part?.text === 'string') return { type: 'text', text: part.text };
    return {
      type: 'image',
      data: part.inlineData.data,
      mime_type: part.inlineData.mimeType,
    };
  });
}

function totalTokenBudget(parts, maxOutputTokens) {
  const textChars = parts.reduce((n, part) => n + (part?.text?.length || 0), 0);
  const images = parts.reduce((n, part) => n + (part?.inlineData ? 1 : 0), 0);
  const inputEstimate = Math.ceil(textChars / 4) + images * 1_024;
  const desiredOutput = Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
    ? Math.ceil(maxOutputTokens)
    : 2_048;
  // Leave room for the managed agent's thinking while staying below the
  // advertised 100K free-tier TPM bucket. The provider treats this as a
  // best-effort total (input + output + thinking), not an output-only cap.
  return Math.min(
    MAX_TOTAL_TOKEN_BUDGET,
    Math.max(8_192, inputEstimate + desiredOutput * 3 + 2_048),
  );
}

/** Pure request builder, exported so contract drift is covered by tests. */
export function buildAntigravityRequest(parts, preferredModel, genConfig = {}) {
  if (!antigravityPartsSupported(parts)) {
    throw new Error('Antigravity fallback supports text and images only.');
  }
  return {
    agent: ANTIGRAVITY_AGENT_ID,
    input: interactionInput(parts),
    environment: 'remote',
    // This fallback is stateless. Do not retain résumé/application prompts or
    // responses merely to gain access to the separate managed-agent quota.
    store: false,
    background: false,
    // Empty means no code/search/URL tools for ordinary app generation. This
    // prevents scraped prompt text from turning a fallback into an autonomous
    // side-effecting workflow. Grounded research opts into only web read tools.
    tools: genConfig.grounding
      ? [{ type: 'google_search' }, { type: 'url_context' }]
      : [],
    agent_config: {
      type: 'antigravity',
      model: underlyingModelFor(preferredModel),
      max_total_tokens: totalTokenBudget(parts, genConfig.maxOutputTokens),
    },
  };
}

/** Raw REST responses do not include the SDK-only `output_text` convenience. */
export function extractAntigravityOutputText(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  if (typeof data?.outputText === 'string') return data.outputText;
  const modelSteps = (Array.isArray(data?.steps) ? data.steps : [])
    .filter((step) => step?.type === 'model_output');
  const last = modelSteps.at(-1);
  return (Array.isArray(last?.content) ? last.content : [])
    .filter((content) => content?.type === 'text' && typeof content.text === 'string')
    .map((content) => content.text)
    .join('');
}

function retryAfterMs(response, body) {
  const header = response?.headers?.get?.('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1_000));
  }
  const match = /retry in ([\d.]+)\s*s/i.exec(String(body || ''));
  return match ? Math.round(Number(match[1]) * 1_000) : null;
}

/** Execute one synchronous managed-agent interaction. */
export async function callAntigravityAgent(parts, apiKey, preferredModel, genConfig = {}) {
  if (!apiKey) throw new Error('Antigravity API fallback requires an AI Studio API key.');
  const payload = buildAntigravityRequest(parts, preferredModel, genConfig);
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = genConfig.signal
    ? AbortSignal.any([genConfig.signal, timeoutSignal])
    : timeoutSignal;

  const response = await fetch(INTERACTIONS_ENDPOINT, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    let message = body;
    try { message = JSON.parse(body)?.error?.message || body; } catch { /* raw body */ }
    const error = new Error(`Antigravity Agent API error ${response.status}: ${message || `HTTP ${response.status}`}`);
    error.status = response.status;
    error.details = body.slice(0, 1_000);
    error.retryAfterMs = retryAfterMs(response, body);
    throw error;
  }

  const data = await response.json();
  if (data?.status && data.status !== 'completed') {
    const error = new Error(`Antigravity Agent ended with status=${data.status}; no complete fallback result was produced.`);
    error.status = data.status === 'failed' ? 500 : null;
    throw error;
  }
  const text = extractAntigravityOutputText(data);
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Antigravity Agent returned no output text.');
  }
  return {
    text,
    model: data?.model || payload.agent_config.model,
    usage: data?.usage || null,
  };
}
