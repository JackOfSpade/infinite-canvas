/**
 * Gemini AI service — text + vision support via Vertex AI.
 * Uses Service Account for authentication against regional endpoints.
 */
import fs from 'fs';
import path from 'path';
import { GoogleAuth } from 'google-auth-library';
import { handleSafe } from './ipcUtils.js';
import { logger } from '../logger.js';
import { resolveServiceAccountPath, getAISettings } from './settings.js';
import { callClaudeText, probeClaude } from './claude.js';
import { recordTokenUsage, recordTruncation } from './tokenBudget.js';
import { IMAGE_MIME_MAP, DOCUMENT_MIME_MAP } from '../utils/mimeTypes.js';

// Determinism for structured/JSON output (not a telemetry-learning candidate —
// temperature is a quality knob, not a budget).
const GEMINI_TEMPERATURE = 0.1;
// NOTE: we deliberately do NOT cap prompt/context size on our end. The model's
// own input window (~1M tokens on every model we call) is the only ceiling — an
// over-limit prompt is rejected by the API and that error is surfaced as-is. We
// would rather fail loudly than pre-clip or truncate context. (The file-byte cap
// below is unrelated: a hard ~20MB API limit on inline image/document bytes.)
const MAX_AI_FILE_BYTES  = 15 * 1024 * 1024; // 15MB

const GEMINI_MODEL = 'gemini-3.5-flash';
const LOCATION = 'us-central1';

// Best → worst across the FREE-tier text/JSON Gemini models, in cascade order
// (callGemini falls down this list on 429/cooldown). Hoisted to module scope so
// the token-fit preflight (checkPromptFits) can budget against the WHOLE cascade
// — i.e. the smallest window any step might use — rather than just the entry
// model. Today every entry is 1,048,576/65,536 so the cascade is homogeneous,
// but taking the min keeps the preflight correct if a smaller-window model is
// ever added. See the long rationale at the use site in callGemini.
export const GEMINI_MODEL_FALLBACKS = [
  'gemini-3.5-flash',         // ~20 RPD / 5 RPM free — best quality available on free tier
  'gemini-3-flash-preview',   // ~20 RPD / 5 RPM free  (display name "Gemini 3 Flash")
  'gemini-2.5-flash',         // ~20 RPD / 5 RPM free
  'gemini-2.5-flash-lite',    // ~20 RPD / 10 RPM free
  'gemini-3.1-flash-lite',    // ~500 RPD / 15 RPM free — workhorse, completes bulk runs
];

/**
 * Convert standard JSON Schema (lowercase types) to Gemini's responseSchema
 * format (uppercase types). Recursively walks objects + arrays. Drops
 * unsupported keywords (anyOf/oneOf/$ref/additionalProperties) that Gemini's
 * schema validator rejects — keep schemas simple to avoid surprises.
 */
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const TYPE_MAP = {
    string: 'STRING', number: 'NUMBER', integer: 'INTEGER',
    boolean: 'BOOLEAN', array: 'ARRAY', object: 'OBJECT', null: 'NULL',
  };
  const out = {};
  if (schema.type) out.type = TYPE_MAP[schema.type] || schema.type;
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum;
  if (schema.nullable) out.nullable = schema.nullable;
  if (schema.required) out.required = schema.required;
  if (schema.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      out.properties[k] = toGeminiSchema(v);
    }
  }
  if (schema.items) out.items = toGeminiSchema(schema.items);
  return out;
}

// Transient HTTP errors worth retrying. 503/500/502/504 are server-side
// hiccups; 429 is rate limit (provider tells us to back off). Everything
// else is a config/auth/quota/payload issue that won't improve on retry.
const TRANSIENT_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);

// ── Retry / backoff policy ────────────────────────────────────────────────────
// Same-endpoint retries for transient 5xx / network blips (429 is handled by the
// model-fallback loop, not retried here). Backoff prefers the server's own
// Retry-After header when present (derive from observed provider behavior),
// falling back to bounded exponential backoff. MAX_ATTEMPTS is the hard ceiling.
const RETRY = {
  MAX_ATTEMPTS:   3,      // hard ceiling on same-endpoint retries
  BASE_DELAY_MS:  600,    // first backoff step
  BACKOFF_FACTOR: 3,      // exponential growth per attempt
  MAX_BACKOFF_MS: 30000,  // cap any single wait, incl. an honored Retry-After
};

// Per-request timeout scales with payload: a multimodal call with several images
// legitimately takes longer than a short text call, so give it more headroom
// (bounded) instead of timing out a valid slow vision request at a flat 60s.
const REQUEST_TIMEOUT_BASE_MS      = 60000;
const REQUEST_TIMEOUT_PER_IMAGE_MS = 8000;
const REQUEST_TIMEOUT_MAX_MS       = 120000;

/**
 * Parse an HTTP Retry-After header (delta-seconds or HTTP-date) to ms, or null.
 */
function parseRetryAfterMs(res) {
  const h = res?.headers?.get?.('retry-after');
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
  const when = Date.parse(h);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return null;
}

/** Sleep that resolves early if the signal aborts (so a long Retry-After wait
 *  doesn't outlive a cancelled/timed-out request). */
function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (!(ms > 0) || signal?.aborted) return resolve();
    const onAbort = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/**
 * fetch() wrapper with bounded backoff for transient HTTP errors and network
 * failures. Honors a server-provided Retry-After on transient 5xx; returns the
 * final Response (caller still handles non-2xx). Aborts are not retried — the
 * user/timeout asked to stop, respect that. Logs each retry so bug reports show
 * the attempt history.
 */
async function fetchWithRetry(url, init, { label = 'fetch', maxAttempts = RETRY.MAX_ATTEMPTS } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok || !TRANSIENT_HTTP_STATUSES.has(res.status) || attempt === maxAttempts) {
        return res;
      }
      // 429 = rate limit / quota: don't wait-and-retry the same model. Return so
      // the outer fallback loop moves to the next model immediately — faster than
      // honoring a multi-second Retry-After on a call the user is waiting on.
      if (res.status === 429) {
        return res;
      }
      // Transient 5xx: prefer the server's own Retry-After (e.g. an overloaded
      // 503 telling us exactly how long to wait), else bounded exponential
      // backoff. Capped so a large/garbage value can't hang the call.
      const retryAfter = parseRetryAfterMs(res);
      const backoff = RETRY.BASE_DELAY_MS * Math.pow(RETRY.BACKOFF_FACTOR, attempt - 1);
      const delay = Math.min(RETRY.MAX_BACKOFF_MS, retryAfter ?? backoff);
      logger.warn(`[${label}] HTTP ${res.status} (transient) — retrying in ${delay}ms${retryAfter != null ? ' (honoring Retry-After)' : ''} (attempt ${attempt}/${maxAttempts})`);
      await abortableSleep(delay, init?.signal);
      if (init?.signal?.aborted) return res;  // aborted during backoff — stop retrying
    } catch (err) {
      lastErr = err;
      // Don't retry aborts — caller/timeout explicitly stopped us.
      if (err?.name === 'AbortError' || init?.signal?.aborted || attempt === maxAttempts) throw err;
      const delay = Math.min(RETRY.MAX_BACKOFF_MS, RETRY.BASE_DELAY_MS * Math.pow(RETRY.BACKOFF_FACTOR, attempt - 1));
      logger.warn(`[${label}] network error: ${err?.message || String(err)} — retrying in ${delay}ms (attempt ${attempt}/${maxAttempts})`);
      await abortableSleep(delay, init?.signal);
      if (init?.signal?.aborted) throw err;
    }
  }
  throw lastErr;
}

let authClient = null;
let projectId = null;
let cachedKeyFile = null; // tracks which file the cached client was built from

async function getAuthClient() {
  const keyFile = resolveServiceAccountPath();
  // Reuse the cached client only if it was built from the same file we'd
  // resolve right now. If the user changes the path in Settings, the next
  // call rebuilds against the new account instead of silently using the old one.
  if (authClient && cachedKeyFile === keyFile) return { auth: authClient, projectId };
  authClient = null;
  projectId = null;
  cachedKeyFile = null;

  if (!keyFile) {
    // No API key and no service-account.json → no usable Gemini credential.
    // Fail loudly instead of fabricating placeholder data, so a missing key can
    // never be silently mistaken for a real AI result.
    throw new Error('No Gemini credential configured — add a Gemini API key (or a service-account.json) in Settings to use AI features.');
  }

  let saRaw;
  try {
    saRaw = await fs.promises.readFile(keyFile, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`Configured Gemini service-account file not found at ${keyFile} — fix the path or add a Gemini API key in Settings.`);
    }
    throw err;
  }
  const sa = JSON.parse(saRaw);
  projectId = sa.project_id;
  authClient = new GoogleAuth({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  cachedKeyFile = keyFile;
  return { auth: authClient, projectId };
}

async function getToken() {
  try {
    const { auth } = await getAuthClient();
    const client = await auth.getClient();
    const { token } = await client.getAccessToken();
    if (!token) throw new Error('Failed to generate OAuth token from service account.');
    return token;
  } catch (err) {
    // Clear the cached client so the next call retries from scratch.
    // Without this, a broken credential (e.g., rotated service account) is
    // cached permanently for the process lifetime, silently failing every call.
    authClient = null;
    projectId = null;
    throw err;
  }
}

let lastAttemptedModel = '(none)';
let lastSuccessfulModel = '(none)';
let lastAttemptedError = '(none)';

// Per-model rate-limit cooldown: model id → epoch ms until which it's known to be
// 429'd. Populated from each 429's "retry in Ns" hint and consulted by the fallback
// loop so subsequent calls SKIP a model that's still cooling instead of re-hitting
// it for a wasted round-trip every batch. Process-scoped (resets on restart), which
// is correct — a rate-limit window is short-lived. See callGemini's loop.
const modelCooldownUntil = new Map();

/** Parse a Gemini 429 error MESSAGE (string) for its "retry in Ns / Nms" hint →
 *  milliseconds, or null. The API phrases it as "Please retry in 53.39s." or
 *  "...409.6ms."; the seconds-only body parser (parseGeminiRetryMs) doesn't cover
 *  the ms form or operate on a bare message string. */
function parseRetryMsFromError(msg) {
  const s = String(msg || '');
  const ms = /retry in ([\d.]+)\s*ms\b/i.exec(s);
  if (ms) return Math.round(parseFloat(ms[1]));
  const sec = /retry in ([\d.]+)\s*s\b/i.exec(s);
  if (sec) return Math.round(parseFloat(sec[1]) * 1000);
  return null;
}

/**
 * Exposes internal Gemini diagnostics to the bug reporting IPC layer.
 */
export function getGeminiTelemetry() {
  return {
    lastAttemptedModel,
    lastSuccessfulModel,
    lastAttemptedError
  };
}

/** Parse a Gemini 429 body for its suggested retry delay (ms), or null. AI
 *  Studio puts the hint in the body (a RetryInfo detail `retryDelay:"24s"`
 *  and/or "Please retry in 24.15s"), not always the Retry-After header. */
function parseGeminiRetryMs(res, body) {
  const header = parseRetryAfterMs(res);
  if (header != null) return header;
  if (!body) return null;
  try {
    const details = JSON.parse(body)?.error?.details;
    if (Array.isArray(details)) {
      for (const d of details) {
        if (typeof d?.retryDelay === 'string') {
          const s = Number(d.retryDelay.replace(/s$/i, ''));
          if (Number.isFinite(s)) return Math.round(s * 1000);
        }
      }
    }
  } catch { /* not JSON — fall through to text scan */ }
  const m = /retry in ([\d.]+)\s*s/i.exec(body);
  return m ? Math.round(parseFloat(m[1]) * 1000) : null;
}

function extractGeminiErr(body, status) {
  if (!body) return `HTTP ${status}`;
  try { const msg = JSON.parse(body)?.error?.message; if (msg) return msg; } catch { /* ignore */ }
  return body.slice(0, 200);
}

/**
 * Availability probe for the AI Studio key path: a 1-token generateContent ping.
 * NEVER throws — returns {ok,status,...}. Unlike Claude, Gemini exposes NO
 * remaining-quota on success (only a retry hint on 429), so there is no
 * `rateLimit` block by design — we don't fabricate one.
 */
export async function probeGemini(apiKey, model = 'gemini-3.1-flash-lite') {
  if (!apiKey) {
    return { ok: false, status: null, error: 'No AI Studio API key set (a service-account / Vertex setup is not probed here).' };
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'ping' }] }], generationConfig: { maxOutputTokens: 1 } }),
    });
  } catch (e) {
    return { ok: false, status: null, error: e?.message || String(e) };
  }
  if (res.ok) return { ok: true, status: res.status, model };
  let body = '';
  try { body = await res.text(); } catch { /* ignore */ }
  return { ok: false, status: res.status, error: extractGeminiErr(body, res.status), retryAfterMs: parseGeminiRetryMs(res, body) };
}

// Last live "Check availability" result per provider, so the Settings panel can
// render the most recent verdict immediately on open (the button refreshes it).
const lastProbe = { gemini: null, claude: null };

/**
 * Inner executor for a single Gemini API request.
 */
async function callGeminiSingle(parts, apiKey, model, genConfig = {}) {
  // If an API key is provided, route directly to the free AI Studio endpoint
  // Otherwise, default to the Vertex AI service account pipeline
  let endpoint = '';
  let headers = { 'Content-Type': 'application/json' };
  
  if (apiKey) {
    endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-3.5-flash'}:generateContent?key=${apiKey}`;
  } else {
    // No API key → Vertex AI via service-account.json. getToken() (→ getAuthClient)
    // throws a clear "no credential" error if neither is configured.
    const token = await getToken();
    endpoint = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${model || GEMINI_MODEL}:generateContent`;
    headers['Authorization'] = `Bearer ${token}`;
  }

  // `task` is metadata for token-usage telemetry and `meta` is a by-reference
  // out-param the fallback loop writes the succeeded model into — neither is a
  // Gemini API field, so pull them out so they never leak into generationConfig
  // (which would 400 the call). `grounding` is also ours — it lifts to a
  // top-level `tools` entry (Google Search), NOT a generationConfig field.
  const { signal, responseSchema, task, formulaSeed: _formulaSeed, meta: _meta, grounding: _grounding, ...restGenConfig } = genConfig;
  const formulaSeed = _formulaSeed ?? null;

  const generationConfig = {
    temperature: GEMINI_TEMPERATURE,
    responseMimeType: 'application/json',
    maxOutputTokens: 2048,   // default; callers pass task-specific caps via opts
    // Disable model "thinking" by default. Every task on this path is
    // schema-constrained JSON (scoring / bucketing / extraction / classification):
    // the visible answer is a few hundred tokens, but the 2.5-flash / 3-flash
    // models were spending 9k–12k tokens THINKING per call, which (a) blew the
    // output cap → MAX_TOKENS truncation → forced fallback to the WEAKEST model,
    // and (b) ran long enough to trip the 60s request timeout. Net effect: thinking
    // was knocking out the strong models and DEGRADING quality, not improving it.
    // thinkingBudget:0 is accepted by every model in the fallback chain (verified
    // live against all 5 — all 200, thoughts→0, valid JSON) and is the single
    // biggest free-tier reliability/latency win. A task that genuinely benefits
    // from reasoning can re-enable it by passing thinkingConfig via genConfig.
    thinkingConfig: { thinkingBudget: 0 },
    ...restGenConfig,
  };
  if (responseSchema) {
    // Gemini's responseSchema constrains generation to a JSON Schema —
    // 100% guarantee of valid JSON + schema-conforming output.
    generationConfig.responseSchema = toGeminiSchema(responseSchema);
  }
  const payload = {
    contents: [{ role: 'user', parts }],
    generationConfig,
  };
  // Grounding: attach the Google Search tool so the model does live web
  // research instead of answering from training knowledge alone. This is a
  // free-text path — the caller pairs it with responseMimeType:'text/plain'
  // (grounding is incompatible with a strict responseSchema), so we never set
  // generationConfig.responseSchema here. Carries its own quota/billing.
  if (_grounding) {
    payload.tools = [{ google_search: {} }];
  }

  // Scale the timeout to the payload: multimodal calls with several images
  // legitimately take longer, so a flat 60s would falsely abort a valid slow
  // vision request. Bounded by REQUEST_TIMEOUT_MAX_MS.
  const imageParts = parts.reduce((n, p) => n + (p.inlineData ? 1 : 0), 0);
  const timeoutMs = Math.min(REQUEST_TIMEOUT_MAX_MS, REQUEST_TIMEOUT_BASE_MS + imageParts * REQUEST_TIMEOUT_PER_IMAGE_MS);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const endpointName = apiKey ? 'Gemini API (AI Studio)' : 'Vertex AI';

  const response = await fetchWithRetry(endpoint, {
    method: 'POST',
    signal: combinedSignal,
    headers,
    body: JSON.stringify(payload),
  }, { label: endpointName });

  if (!response.ok) {
    const errText = await response.text();
    let errMsg;
    try { errMsg = JSON.parse(errText)?.error?.message || errText; }
    catch { errMsg = errText; }
    throw new Error(`${endpointName} error ${response.status}: ${errMsg}`);
  }

  const data = await response.json();
  const candidate = data?.candidates?.[0];
  // Join ALL text parts, not just [0]. Plain JSON answers arrive as a single
  // part, but a grounded (Google Search) response can split its answer across
  // several text parts interleaved with grounding metadata — taking only the
  // first part would silently truncate the research text.
  const contentText = (candidate?.content?.parts || [])
    .map(p => p?.text || '')
    .join('') || undefined;
  const finishReason = candidate?.finishReason;
  const usage = data?.usageMetadata;
  const cap = payload.generationConfig.maxOutputTokens;

  // Log finish reason + token usage on every call so bug reports include the signals
  logger.info(`[Gemini] finishReason=${finishReason} usage=in:${usage?.promptTokenCount ?? '?'} out:${usage?.candidatesTokenCount ?? '?'} thoughts:${usage?.thoughtsTokenCount ?? 0} cap:${cap}`);

  // Feed the self-calibrating token budget. Total output = visible + thinking
  // (both count toward the cap and are billed). A MAX_TOKENS truncation records
  // a sample AT the cap, which pulls p95 up so the budget grows next call —
  // that's the intended self-heal, so we record before the truncation throw.
  const totalOut = (usage?.candidatesTokenCount || 0) + (usage?.thoughtsTokenCount || 0);
  recordTokenUsage(task, totalOut);

  // MAX_TOKENS truncation produces JSON that's missing its closing braces
  if (finishReason === 'MAX_TOKENS') {
    // Censored signal: real demand exceeded `cap`. Record it so effectiveCap
    // provisions past this cap on the very next call (bypasses MIN_SAMPLES) —
    // otherwise this task truncates + falls back to a weaker model every run.
    recordTruncation(task, cap, formulaSeed);
    const thoughts = usage?.thoughtsTokenCount || 0;
    const visible  = usage?.candidatesTokenCount ?? 0;
    const note = thoughts > visible
      ? ` Most of that budget (${thoughts} tok) went to thinking — disable it via thinkingConfig or raise the cap.`
      : '';
    throw new Error(`AI response was truncated — hit the ${cap}-token output cap (model wrote ${visible} visible tokens + ${thoughts} thinking tokens before being cut off).${note} Raise the cap for this task in llm.js TASK_MAX_TOKENS.`);
  }
  // SAFETY / RECITATION / OTHER
  if (finishReason && finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
    throw new Error(`AI response terminated abnormally: finishReason=${finishReason}. This usually means safety filters or recitation blocking — try rephrasing or removing problematic content.`);
  }

  if (!contentText) throw new Error(`No content returned from Gemini (finishReason=${finishReason || 'unknown'}).`);

  return contentText;
}

/**
 * Core Gemini call — sends parts (text + optional images) to Vertex AI or AI Studio,
 * automatically falling back across the available text/JSON-capable Gemini models
 * in descending capability order
 * when rate limits or quotas are exceeded.
 * @param {Array} parts — Array of { text } or { inlineData: { mimeType, data } } objects
 * @param {string} apiKey - Optional Gemini API Key. If missing, falls back to Vertex AI.
 * @param {string} model - Ignored for Gemini calls to enforce progressive fallback.
 * @param {object} [genConfig] — generationConfig overrides
 * @returns {Promise<string>} — Raw text response from Gemini
 */
async function callGemini(parts, apiKey, model, genConfig = {}) {
  // Without an API key we use the Vertex/service-account path; verify that
  // credential up front so a missing one fails fast with one clear error
  // instead of throwing the same auth failure against all 10 fallback models.
  // (With a key we hit AI Studio directly — no service-account probe needed.)
  if (!apiKey) await getAuthClient();

  // Best → worst across the text/JSON-capable Gemini models, scoped to ONLY the
  // models with real FREE-tier quota (this app runs on a free-tier key). IDs
  // verified live against the v1beta ListModels endpoint (May 2026); `*-tts` /
  // `*-image` / `computer-use` / `robotics` and the non-existent `gemini-3-flash`
  // (real id is `gemini-3-flash-preview`) are excluded — they don't serve plain
  // generateContent text/JSON.
  //
  // DELIBERATELY EXCLUDED: every "Pro" model (gemini-3.1-pro, gemini-3-pro,
  // gemini-2.5-pro) — all are limit 0/0 on the free tier per the AI Studio
  // rate-limit dashboard, i.e. they 429 on EVERY call. Listing one first (as a
  // paid-tier hedge) only burned ~150ms per AI call on a guaranteed 429 before
  // falling through. If a billed/Tier-1 key is ever used, re-add 'gemini-3.1-pro-
  // preview' at the head — it's the strongest model there.
  //
  // Free-tier reality for the models we DO keep:
  //   • The 4 flash / flash-lite "20 RPD" models are each a SEPARATE quota
  //     bucket (~5–10 RPM), so chaining them multiplies usable headroom and
  //     burst capacity — a 429 on one pool spills into the next.
  //   • gemini-3.1-flash-lite has ~500 RPD / 15 RPM — 25× the others — so it's
  //     the workhorse tail: last in line, it still completes a bulk run after
  //     every smaller pool has drained.
  // (The list itself is hoisted to module scope — GEMINI_MODEL_FALLBACKS — so the
  // token-fit preflight can budget against the whole cascade.)

  const attemptedErrors = [];

  // Try models NOT currently in a 429 cooldown first; keep cooling ones only as a
  // last resort (the retry-after is an estimate, and attempting beats failing if
  // every pool happens to be cooling). On the free tier the top two flash pools
  // exhaust within a run, so without this every scoring/bucketing batch re-hit them
  // for two throwaway 429 round-trips before reaching gemini-2.5-flash.
  const _now = Date.now();
  const _ready   = GEMINI_MODEL_FALLBACKS.filter(m => (modelCooldownUntil.get(m) || 0) <= _now);
  const _cooling = GEMINI_MODEL_FALLBACKS.filter(m => (modelCooldownUntil.get(m) || 0) >  _now);
  const modelOrder = [..._ready, ..._cooling];
  if (_cooling.length > 0 && _ready.length > 0) {
    logger.info(`[Gemini] Skipping ${_cooling.length} rate-limited model(s) still cooling: ${_cooling.join(', ')}`);
  }

  for (const currentModel of modelOrder) {
    // Bail immediately if the caller cancelled (node deleted / Reset). Without
    // this, an aborted request walks the entire fallback chain — each attempt
    // throws on the already-aborted signal — and surfaces a misleading "all
    // models failed" instead of a clean cancellation. `genConfig.signal` is the
    // user signal specifically (the per-call timeout is a separate signal), so
    // a single model timing out still correctly falls through to the next.
    if (genConfig.signal?.aborted) {
      const abortErr = new Error('Gemini request aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    try {
      logger.info(`[Gemini] Attempting call with model: ${currentModel}`);
      lastAttemptedModel = currentModel;

      const result = await callGeminiSingle(parts, apiKey, currentModel, genConfig);

      lastSuccessfulModel = currentModel;
      modelCooldownUntil.delete(currentModel); // it just succeeded — clear any stale cooldown
      // Clear the per-attempt error on success. Otherwise it stays pinned to the
      // last failed hop — on the FREE tier the small "20 RPD" pools exhaust fast,
      // so a healthy call that simply fell through to a later model would forever
      // surface a scary "Last error: …429" in Settings and bug reports even though
      // it succeeded. The expected fall-through is still captured per-stage in
      // genConfig.meta.fallback.
      lastAttemptedError = '(none)';
      // Report the model that actually served this call back to the caller (by
      // reference) so per-stage telemetry can record WHICH model produced each
      // result — e.g. a price synthesized by a weak flash-lite fallback after the
      // stronger models 429'd looks identical in the output otherwise.
      if (genConfig.meta && typeof genConfig.meta === 'object') {
        genConfig.meta.model = currentModel;
        // When stronger models were skipped to land here, record WHY — quota/
        // rate-limit (external: wait or upgrade tier) vs token-cap truncation
        // (our cap is too low: raise it in llm.js TASK_MAX_TOKENS) vs server
        // (overload). The bug-report funnel otherwise only knows "weak fallback"
        // from the model NAME; the per-attempt reason lives solely in the
        // scrolling log buffer, and each cause needs a different fix.
        if (attemptedErrors.length > 0) {
          const counts = {};
          for (const e of attemptedErrors) {
            const m = String(e.error || '').toLowerCase();
            const k = (m.includes('truncat') || m.includes('max_tokens') || m.includes('token output cap')) ? 'truncation'
              : (m.includes('429') || m.includes('quota') || m.includes('rate limit')) ? 'rate-limit'
                : /\b(404|500|502|503|504)\b/.test(m) ? 'server' : 'other';
            counts[k] = (counts[k] || 0) + 1;
          }
          const reason = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
          genConfig.meta.fallback = { attempts: attemptedErrors.length, reason, counts };
        }
      }
      return result;
    } catch (err) {
      const errMsg = err.message || String(err);
      logger.warn(`[Gemini] Model ${currentModel} failed: ${errMsg}`);
      
      lastAttemptedError = `${currentModel}: ${errMsg}`;
      attemptedErrors.push({ model: currentModel, error: errMsg });

      const isRateLimitOrQuota = 
        errMsg.includes('429') ||
        errMsg.toLowerCase().includes('quota') ||
        errMsg.toLowerCase().includes('rate limit') ||
        errMsg.includes('404') || // model not found or enabled in this region/key
        errMsg.includes('503') || // overloaded
        errMsg.includes('500') ||
        errMsg.includes('502') ||
        errMsg.includes('504');

      if (isRateLimitOrQuota) {
        // For a genuine rate-limit/quota 429, remember when this model is allowed
        // again (from the API's "retry in Ns" hint) so later calls skip it until
        // then. 404/5xx are structural/transient, not rate windows — don't cool
        // those (they'd wrongly suppress a model that's actually available).
        const is429 = errMsg.includes('429') || errMsg.toLowerCase().includes('quota') || errMsg.toLowerCase().includes('rate limit');
        if (is429) {
          const retryMs = parseRetryMsFromError(errMsg);
          const cooldownMs = Math.min(10 * 60_000, Math.max(1000, retryMs ?? 30_000)); // clamp 1s–10min; 30s default when unparseable
          modelCooldownUntil.set(currentModel, Date.now() + cooldownMs);
        }
        logger.warn(`[Gemini] Falling back to the next best model...`);
        continue;
      }

      logger.warn(`[Gemini] Proceeding to fallback after non-transient failure: ${errMsg}`);
    }
  }

  // If we reach here, all models have failed!
  const errorDetails = attemptedErrors.map(e => `* ${e.model}: ${e.error}`).join('\n');
  const finalError = new Error(`All Gemini models failed. Usage limits or quotas may have been exceeded on all fallback models.\n\nDetails:\n${errorDetails}`);

  // Tag as rate limit if any of the errors were rate limits
  const hasRateLimit = attemptedErrors.some(e => 
    e.error.includes('429') || 
    e.error.toLowerCase().includes('rate limit') || 
    e.error.toLowerCase().includes('quota')
  );
  if (hasRateLimit) {
    finalError.isRateLimit = true;
    finalError.provider = 'gemini';
  }

  throw finalError;
}

/**
 * Parse raw Gemini response text into JSON, stripping markdown fences if present.
 * Handles both ```json and bare ``` wrappers.
 */
export function parseGeminiJSON(raw) {
  if (!raw) return null;

  // Resilient JSON extraction: Find the first code block or the outer-most { } pair.
  // This handles instances where Gemini adds markdown fences OR conversational text.
  let jsonStr = raw;
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (match) {
    jsonStr = match[1];
  } else {
    // If no markdown block, try to find the first { or [ and the last } or ]
    const firstBrace = raw.indexOf('{');
    const firstBracket = raw.indexOf('[');
    const lastBrace = raw.lastIndexOf('}');
    const lastBracket = raw.lastIndexOf(']');
    
    let start = -1;
    let end = -1;
    
    if (firstBrace !== -1 && firstBracket !== -1) {
      start = Math.min(firstBrace, firstBracket);
    } else if (firstBrace !== -1) {
      start = firstBrace;
    } else if (firstBracket !== -1) {
      start = firstBracket;
    }
    
    if (lastBrace !== -1 && lastBracket !== -1) {
      end = Math.max(lastBrace, lastBracket);
    } else if (lastBrace !== -1) {
      end = lastBrace;
    } else if (lastBracket !== -1) {
      end = lastBracket;
    }

    if (start !== -1 && end !== -1 && end > start) {
      jsonStr = raw.substring(start, end + 1);
    }
  }

  // Clean trailing commas that V8's JSON.parse chokes on
  jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');

  try {
    const parsed = JSON.parse(jsonStr.trim());
    return parsed;
  } catch (error) {
    // Strictly-additive fallback: the first-open/last-close span above can
    // mis-bracket when the model prefixes the JSON with prose that contains a
    // stray '{', '[', '}' or ']' (e.g. "use [ ] for arrays: {…}"), so it starts
    // the span at the stray delimiter and JSON.parse fails. Retry with a
    // brace-only then bracket-only span. This runs ONLY after the primary parse
    // already threw, so it can never regress a response that parsed cleanly.
    for (const [open, close] of [['{', '}'], ['[', ']']]) {
      const s = raw.indexOf(open);
      const e = raw.lastIndexOf(close);
      if (s !== -1 && e > s) {
        try {
          const recovered = JSON.parse(raw.substring(s, e + 1).replace(/,\s*([}\]])/g, '$1').trim());
          // Reject a trivially-empty literal here. This loop runs ONLY after the
          // primary parse already failed (mis-bracketed prose), so an empty {}/[]
          // almost always came from a STRAY delimiter pair in the prose — e.g.
          // "use [ ] for arrays: {…}", where the bracket span grabs the prose's
          // "[ ]" and parses it to []. Returning that would silently fabricate an
          // empty result and mask the failure; fall through to the fail-loud throw.
          const isEmptyLiteral = recovered && typeof recovered === 'object'
            && (Array.isArray(recovered) ? recovered.length === 0 : Object.keys(recovered).length === 0);
          if (!isEmptyLiteral) return recovered;
        } catch { /* try the next delimiter pair, then fall through to the throw */ }
      }
    }
    // Log a window AROUND the failure position, not the head of the doc.
    // V8's JSON.parse error messages include "at position N" — pull that
    // out and dump ±200 chars so bug reports show the actual malformed
    // syntax instead of valid prelude that gets truncated by the ring
    // buffer before the error site is reached.
    const posMatch = String(error.message || '').match(/at position (\d+)/);
    let context = '';
    if (posMatch) {
      const pos = Number(posMatch[1]);
      const start = Math.max(0, pos - 200);
      const end = Math.min(jsonStr.length, pos + 200);
      const before = jsonStr.slice(start, pos);
      const after = jsonStr.slice(pos, end);
      context = `\nContext (±200 chars around pos ${pos}, length=${jsonStr.length}):\n${before}«ERROR HERE»${after}`;
    } else {
      context = `\nRaw (length=${jsonStr.length}):\n${jsonStr.slice(0, 1000)}${jsonStr.length > 1000 ? '\n…[truncated]' : ''}`;
    }
    logger.error('[Gemini] Failed to parse JSON response:', error.message, context);
    throw new Error(`AI returned invalid JSON: ${error.message}`);
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Send a text-only prompt to Gemini.
 * @param {string} prompt
 * @param {string} apiKey
 * @param {string} model
 * @returns {Promise<object>} — Parsed JSON response
 */
export async function callGeminiText(prompt, apiKey, model, signal = null, opts = {}) {
  const raw = await callGemini([{ text: prompt }], apiKey, model, { signal, ...opts });
  return parseGeminiJSON(raw);
}

/**
 * Free-text (non-JSON) prompt. Returns the model's raw text — NOT parsed as
 * JSON. Forces responseMimeType:'text/plain' (overriding the JSON default) so
 * prose / HTML / research output isn't constrained to a JSON envelope. Pass
 * `grounding:true` in opts to enable live Google Search research.
 * @returns {Promise<string>} — Raw text response
 */
export async function callGeminiTextRaw(prompt, apiKey, model, signal = null, opts = {}) {
  return await callGemini([{ text: prompt }], apiKey, model, { signal, responseMimeType: 'text/plain', ...opts });
}

/**
 * Count the input tokens a text prompt would consume, via Gemini's FREE
 * `:countTokens` endpoint (no charge, ~3000 RPM). Returns the integer
 * `totalTokens`. Only the AI-Studio (API-key) path is supported — the Vertex
 * service-account path throws so the preflight falls back to its local estimate.
 * Counts the prompt text only (Gemini's responseSchema lives in generationConfig,
 * not in `contents`, so it isn't billed against the input window anyway).
 * Used by the preflight (checkPromptFits) to size/split prompts before sending.
 */
export async function countGeminiInputTokens(text, apiKey, model, { signal = null } = {}) {
  if (!apiKey) throw new Error('Gemini countTokens requires an AI Studio API key');
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model || GEMINI_MODEL}:countTokens?key=${apiKey}`;
  const timeoutSignal = AbortSignal.timeout(15000);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: String(text || '') }] }] }),
    signal: combinedSignal,
  });
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch { /* ignore */ }
    throw new Error(`Gemini countTokens error ${res.status}: ${extractGeminiErr(body, res.status)}`);
  }
  const data = await res.json();
  return data?.totalTokens ?? 0;
}

/**
 * Send images + text prompt to Gemini Vision.
 * @param {string[]} imagePaths — Absolute paths to image files
 * @param {string} prompt — Text prompt
 * @param {string} apiKey
 * @param {string} model
 * @returns {Promise<object>} — Parsed JSON response
 */
export async function callGeminiVision(imagePaths, prompt, apiKey, model, signal = null, opts = {}) {
  // Normalize any non-vision-safe format to JPEG. Gemini accepts HEIC natively
  // but NOT TIFF/JXL/AVIF/BMP/SVG — one converter keeps both providers uniform.
  // Track temp files for cleanup in the finally (this path created none before).
  const { ensureVisionSafeImage, cleanupTempFile } = await import('./heicUtils.js');
  const tempFiles = [];
  try {
    const imageParts = await Promise.all(imagePaths.map(async (imgPath) => {
      const safePath = await ensureVisionSafeImage(imgPath);
      if (safePath !== imgPath) tempFiles.push(safePath);

      const stats = await fs.promises.stat(safePath);
      // Vertex AI inlineData limit is 20MB. Base64 encoding adds ~33% overhead,
      // so we cap the raw file size at 15MB to be safe and provide a clear error.
      if (stats.size > MAX_AI_FILE_BYTES) {
        throw new Error(`Image file too large: ${path.basename(imgPath)} (${(stats.size / 1024 / 1024).toFixed(1)}MB). Max 15MB for AI analysis.`);
      }

      const buffer = await fs.promises.readFile(safePath);
      const ext = path.extname(safePath).toLowerCase();
      const mimeType = IMAGE_MIME_MAP[ext] || 'image/jpeg';
      return { inlineData: { mimeType, data: buffer.toString('base64') } };
    }));

    const parts = [...imageParts, { text: prompt }];
    const raw = await callGemini(parts, apiKey, model, { signal, ...opts });
    return parseGeminiJSON(raw);
  } finally {
    if (tempFiles.length > 0) await Promise.all(tempFiles.map(f => cleanupTempFile(f)));
  }
}

/**
 * Send a PDF or document file to Gemini for analysis.
 * @param {string} filePath — Path to PDF/DOCX file
 * @param {string} prompt — Analysis prompt
 * @param {string} apiKey
 * @param {string} model
 * @returns {Promise<object>} — Parsed JSON response
 */
export async function callGeminiDocument(filePath, prompt, apiKey, model, signal = null, opts = {}) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = DOCUMENT_MIME_MAP[ext];

  if (!mimeType) {
    // If it's a known image extension, treat as vision call
    if (IMAGE_MIME_MAP[ext]) {
      return callGeminiVision([filePath], prompt, apiKey, model, signal, opts);
    }
    // Legacy .doc files are a binary format that Vertex AI can't ingest as inline
    // data. Reading the bytes as utf8 (the previous fallback) silently produced
    // garbage; surface a clear actionable error instead.
    if (ext === '.doc') {
      throw new Error('Legacy .doc resumes are not supported. Save as PDF or DOCX and try again.');
    }
    // Fallback to text/plain for other document types so Gemini tries to read them as raw text
    return callGemini([{ text: `${prompt}\n\n[Attached File: ${path.basename(filePath)}]\n` + await fs.promises.readFile(filePath, 'utf8') }], apiKey, model, { signal, ...opts });
  }

  const stats = await fs.promises.stat(filePath);
  // Vertex AI inlineData limit is 20MB. Base64 encoding adds ~33% overhead,
  // so we cap the raw file size at 15MB to be safe and prevent OOM crashes.
  if (stats.size > MAX_AI_FILE_BYTES) {
    throw new Error(`Document file too large: ${path.basename(filePath)} (${(stats.size / 1024 / 1024).toFixed(1)}MB). Max 15MB for AI analysis.`);
  }

  const buffer = await fs.promises.readFile(filePath);
  const parts = [
    { inlineData: { mimeType, data: buffer.toString('base64') } },
    { text: prompt },
  ];

  const raw = await callGemini(parts, apiKey, model, { signal, ...opts });
  return parseGeminiJSON(raw);
}

export function registerGeminiHandlers() {
  handleSafe('ai-polish-text', async (event, text, signal) => {
    const prompt = `You are an AI assistant in a visual workspace app. Polish the following text. Make it clear, concise, and professional. Output ONLY the improved text, without quotes or conversational filler. Keep original markdown formatting if any. The text is:\n\n${text}`;
    // Text polish always returns plain text (not JSON), so it can't share
    // callLLMText (which parses JSON). Look up the same per-task model the
    // rest of the app uses, then call Gemini directly with text/plain mime.
    const settings = getAISettings();
    const model = settings.provider === 'gemini'
      ? 'gemini-3.1-flash-lite'   // matches TASK_MODELS['text-polish'].gemini
      : null;
    // If user picked Claude, polish via Claude Haiku 4.5 directly. Avoids
    // forcing them onto Gemini just for this one helper.
    if (settings.provider === 'claude') {
      const raw = await callClaudeText(prompt, 'claude-haiku-4-5-20251001', settings.anthropicApiKey, signal, { maxTokens: 1024, expectJson: false });
      return { text: raw.trim() };
    }
    const config = { responseMimeType: 'text/plain', signal, maxOutputTokens: 1024 };
    const raw = await callGemini([{ text: prompt }], settings.geminiApiKey, model, config);
    return { text: raw.trim() };
  });

  // Live "Check availability" — pings the requested provider (or the active one)
  // and returns a structured verdict. For Claude this includes real
  // remaining/reset numbers from the response headers; for Gemini just
  // up/rate-limited/bad-key + a retry hint (it has no remaining-quota API).
  handleSafe('check-ai-availability', async (event, args) => {
    const settings = getAISettings();
    const provider = (args && args.provider) || settings.provider || 'gemini';
    let result;
    if (provider === 'claude') {
      result = await probeClaude(settings.anthropicApiKey);
    } else {
      result = await probeGemini(settings.geminiApiKey);
    }
    lastProbe[provider] = { ...result, at: Date.now() };
    return { provider, ...lastProbe[provider] };
  });

  // Passive status for the initial panel render: the last probe per provider
  // plus Gemini's always-captured call telemetry (last model / last error).
  handleSafe('get-ai-status', async () => {
    return {
      gemini: { telemetry: getGeminiTelemetry(), lastProbe: lastProbe.gemini },
      claude: { lastProbe: lastProbe.claude },
    };
  });
}
