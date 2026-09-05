/**
 * Gemini AI service — text + vision support via Vertex AI.
 * Uses Service Account for authentication against regional endpoints.
 */
import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import { handleSafe } from './ipcUtils.js';
import { logger } from '../logger.js';
import { resolveServiceAccountPath, getAISettings, getGeminiModelRuntimeState, saveGeminiModelRuntimeState, tryGetStore } from './settings.js';
import { probeClaude, claudeModelsInUse } from './claude.js';
import { primeClaudeModels } from './modelResolver.js';
import { recordTokenUsage, recordTruncation } from './tokenBudget.js';
import { IMAGE_MIME_MAP, DOCUMENT_MIME_MAP } from '../utils/mimeTypes.js';
import {
  GEMINI_MODEL_FALLBACKS,
  GEMINI_MODEL_REGISTRY,
  GEMINI_MAX_OUTPUT_TOKENS,
  VERTEX_GEMINI_MODEL_FALLBACKS,
  classifyGeminiFailure,
  describeGeminiFailure,
  getGeminiDefaultThinkingConfig,
  getGeminiLifecycleWarning,
  isGeminiProviderAvailable,
  orderGeminiModels,
  orderVertexGeminiModels,
} from './geminiModels.js';
import {
  entitledTiersFor,
  entitlementSnapshot,
  recordEntitlement,
  refreshEntitlementInBackground,
  gatedTiers,
  probeModelForTier,
} from './geminiEntitlement.js';
import { assertAttachmentPathSafe } from '../utils/pathSafety.js';
import { parseAiJson } from './jsonRepair.js';
import { appendGroundedSourceAppendix } from './groundedSourceAppendix.js';

export { GEMINI_MODEL_FALLBACKS } from './geminiModels.js';

/**
 * Gemini keeps Google Search provenance in candidate.groundingMetadata rather
 * than inline in text parts. Copy only public web URI/title fields; never the
 * provider's raw grounding payload.
 */
export function formatGeminiGroundedResponse(prose, candidate) {
  const sources = (candidate?.groundingMetadata?.groundingChunks || []).flatMap((chunk) => {
    const web = chunk?.web;
    return web ? [{ url: web.uri, title: web.title }] : [];
  });
  return appendGroundedSourceAppendix(prose, sources);
}

// Determinism for structured/JSON output (not a telemetry-learning candidate —
// temperature is a quality knob, not a budget).
const GEMINI_TEMPERATURE = 0.1;
// NOTE: we deliberately do NOT cap prompt/context size on our end. The model's
// own input window (~1M tokens on every model we call) is the only ceiling — an
// over-limit prompt is rejected by the API and that error is surfaced as-is. We
// would rather fail loudly than pre-clip or truncate context. (The file-byte cap
// below is unrelated: a hard ~20MB API limit on inline image/document bytes.)
const MAX_AI_FILE_BYTES  = 15 * 1024 * 1024; // 15MB

// Gemini's Vertex publisher models below are served by the global endpoint.
// Keeping this separate from the AI Studio catalog is intentional: a service
// account used to send every speculative 3.x/alias id to us-central1, where
// each returned a 404 before the real Vertex models were ever attempted.
export const VERTEX_LOCATION = 'global';

export function vertexGenerateContentUrl(project, model) {
  return `https://aiplatform.googleapis.com/v1/projects/${project}/locations/${VERTEX_LOCATION}/publishers/google/models/${model}:generateContent`;
}

/**
 * Google exposes the same Search capability through two JSON surfaces with
 * different field names.  AI Studio's Generative Language API uses
 * `google_search`, whereas Vertex's v1 publisher-model API uses
 * `googleSearch`.  Keep this provider boundary in one pure helper so a
 * service-account-only installation cannot silently lose company research.
 */
export function geminiGroundingTools(usingVertex = false) {
  return usingVertex ? [{ googleSearch: {} }] : [{ google_search: {} }];
}

/** API keys cannot contain meaningful surrounding whitespace. */
export function normalizeGeminiApiKey(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Convert standard JSON Schema (lowercase types) to Gemini's responseSchema
 * format (uppercase types). Recursively walks objects + arrays. Drops
 * unsupported keywords (anyOf/oneOf/$ref/additionalProperties) that Gemini's
 * schema validator rejects — keep schemas simple to avoid surprises.
 */
export function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const TYPE_MAP = {
    string: 'STRING', number: 'NUMBER', integer: 'INTEGER',
    boolean: 'BOOLEAN', array: 'ARRAY', object: 'OBJECT', null: 'NULL',
  };
  const out = {};
  if (schema.type) out.type = TYPE_MAP[schema.type] || schema.type;
  if (schema.description) out.description = schema.description;
  // Google rejects an empty string inside an enum (even though JSON Schema and
  // Claude accept it). Some contracts intentionally use "" for an honest
  // "not applicable" value; sending that enum rejects the entire request
  // before the model sees the prompt. Keep the source schema intact for
  // Claude, but omit that enum on Gemini rather than narrowing the field.
  if (Array.isArray(schema.enum) && schema.enum.length > 0
    && !schema.enum.some(value => typeof value === 'string' && value.length === 0)) {
    out.enum = schema.enum;
  }
  if (schema.nullable) out.nullable = schema.nullable;
  if (schema.required) out.required = schema.required;
  // Keep only Gemini's documented response-schema constraints. Omitting
  // min/max-items made the cover-letter two-mapping contract advisory; sending
  // generic JSON-Schema string constraints (minLength/maxLength/pattern) is
  // worse, because Gemini rejects them with a request-level 400.
  for (const key of ['minItems', 'maxItems', 'minimum', 'maximum', 'format']) {
    if (schema[key] !== undefined) out[key] = schema[key];
  }
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
// hiccups worth a same-model backoff-and-retry (see fetchWithRetry below).
// 429 is a per-minute/per-day QUOTA signal, not a hiccup — the code below
// deliberately does NOT back off and retry the same model on a 429; it
// returns immediately so the outer model-fallback cascade in callGemini can
// move to the next model/independent quota pool right away, rather than
// stalling a user-facing call on a multi-second same-model wait. Only when
// the ENTIRE ladder has 429'd in one pass — every model, all recoverable
// rate-limit failures — does callGemini honor the provider's retry-delay,
// as a single bounded wait-and-retry pass after ladder exhaustion (Finding 7).
const TRANSIENT_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);

// ── Retry / backoff policy ────────────────────────────────────────────────────
// Same-endpoint retries for transient 5xx / network blips (429 is handled by the
// model-fallback loop, not retried here). Backoff prefers the server's own
// Retry-After header when present (derive from observed provider behavior),
// falling back to bounded exponential backoff. MAX_ATTEMPTS is the hard ceiling.
const RETRY = {
  MAX_ATTEMPTS:   5,      // shared cascade policy; never exceed this request budget
  BASE_DELAY_MS:  600,    // first backoff step
  BACKOFF_FACTOR: 3,      // exponential growth per attempt
  MAX_BACKOFF_MS: 30000,  // cap any single wait, incl. an honored Retry-After
};

// Shared cascade policy: high thinking is normally ~12s but 90s leaves enough
// headroom for a cold/loaded endpoint without tying up a node indefinitely.
const REQUEST_TIMEOUT_MS = 90_000;

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

// The Finding 7 ladder-exhaustion retry wait (callGemini, below) normally
// sleeps for real via abortableSleep — anywhere from ~1s to 60s depending on
// the provider's own retry hint. The deterministic test suite has no seam to
// fake timers globally, so it substitutes a near-instant stand-in through
// __setGeminiLadderRetryWaitForTests rather than sitting through a real wait
// on every retry-pass test. Production code never touches this — it always
// resolves to the real abortableSleep.
let _ladderRetryWait = abortableSleep;
export function __setGeminiLadderRetryWaitForTests(fn) {
  _ladderRetryWait = typeof fn === 'function' ? fn : abortableSleep;
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
      // Buffer the error body NOW, while the stream is still live. If the request
      // deadline (or a caller cancel) fires during the backoff below, undici tears
      // the response stream down and the caller's `await response.text()` would
      // reject with a status-less TimeoutError — destroying the one fact worth
      // reporting: that the endpoint answered HTTP <status>. Reading it here also
      // returns the socket to the pool; on the normal retry path this Response is
      // discarded anyway.
      let bufferedBody = '';
      try { bufferedBody = await res.text(); } catch { /* stream already torn down */ }
      await abortableSleep(delay, init?.signal);
      if (init?.signal?.aborted) {
        // Replay the observed failure as a readable Response so the caller's
        // existing !response.ok path works verbatim: status, body, and Retry-After
        // all survive. Copy only the headers that path consumes.
        const replayHeaders = new Headers();
        for (const h of ['retry-after', 'content-type']) {
          const v = res.headers.get(h);
          if (v) replayHeaders.set(h, v);
        }
        return new Response(bufferedBody, { status: res.status, statusText: res.statusText, headers: replayHeaders });
      }
    } catch (err) {
      lastErr = err;
      // Don't retry aborts — caller/timeout explicitly stopped us.
      // AbortSignal.timeout() rejects with name 'TimeoutError', not 'AbortError'.
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError' || init?.signal?.aborted || attempt === maxAttempts) throw err;
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
// A one-way digest of the complete service-account file. It is never sent to
// the renderer or persisted as raw credential material; it lets the model
// health cache distinguish a key rotation that keeps the same file path.
let cachedServiceAccountFingerprint = null;

async function getAuthClient() {
  const keyFile = resolveServiceAccountPath();

  if (!keyFile) {
    authClient = null;
    projectId = null;
    cachedKeyFile = null;
    cachedServiceAccountFingerprint = null;
    // No API key and no service-account.json → no usable Gemini credential.
    // Fail loudly instead of fabricating placeholder data, so a missing key can
    // never be silently mistaken for a real AI result.
    throw new Error('No Gemini credential configured — add a Gemini API key (or a service-account.json) in Settings to use AI features.');
  }

  let saRaw;
  try {
    saRaw = await fs.promises.readFile(keyFile, 'utf8');
  } catch (err) {
    authClient = null;
    projectId = null;
    cachedKeyFile = null;
    cachedServiceAccountFingerprint = null;
    if (err.code === 'ENOENT') {
      throw new Error(`Configured Gemini service-account file not found at ${keyFile} — fix the path or add a Gemini API key in Settings.`);
    }
    throw err;
  }
  const fingerprint = hashCredential(saRaw);
  // Reuse only when both the configured pathname AND credential file contents
  // match. Service-account key rotation commonly replaces a JSON file in
  // place; path-only caching would keep using the retired account and carry
  // its suppression state into the replacement credential.
  if (authClient && cachedKeyFile === keyFile && cachedServiceAccountFingerprint === fingerprint) {
    return { auth: authClient, projectId };
  }
  authClient = null;
  projectId = null;
  cachedKeyFile = null;
  cachedServiceAccountFingerprint = null;
  const sa = JSON.parse(saRaw);
  projectId = sa.project_id;
  authClient = new GoogleAuth({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  cachedKeyFile = keyFile;
  cachedServiceAccountFingerprint = fingerprint;
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
    cachedKeyFile = null;
    cachedServiceAccountFingerprint = null;
    throw err;
  }
}

let lastAttemptedModel = '(none)';
let lastSuccessfulModel = '(none)';
let lastAttemptedError = '(none)';

// Per-model suppression and warning state. Rate limits use the provider's short
// retry hint; structurally unavailable / access-denied endpoints are retried
// after a longer interval or immediately when the user runs Check availability.
// Process-local state avoids permanently blacklisting a model after quota/access
// changes.
//
// State is keyed by (credential+endpoint, model), NOT model alone: a model that
// is rate-limited on one API key, denied for one key, or unreachable on Vertex in
// one region must not be treated as suppressed for a DIFFERENT key, a freshly
// configured key, or the other endpoint. The scope is recomputed per call from
// the active credential; switching keys therefore starts from a clean slate.
const modelSuppressedUntil = new Map();  // `${scope}\x00${model}` → timestamp
const modelRuntimeState = new Map();     // `${scope}\x00${model}` → state
let geminiRuntimeStateLoaded = false;
const UNAVAILABLE_RECHECK_MS = 6 * 60 * 60_000;
// Request-specific failures (truncation / server / timeout / malformed) are NOT
// model-health problems — their warning self-expires so one bad request can't
// leave a healthy model permanently flagged as problematic in Settings/bug reports.
const REQUEST_FAILURE_WARN_MS = 15 * 60_000;

// Most-recently-used scope, so telemetry readers (bug report, get-ai-status) that
// don't know the active credential still surface the right scope's warnings.
let lastActiveScope = null;

/**
 * Stable, non-secret-leaking fingerprint of credential material.
 *
 * Health state persists across launches, so its key needs both practical
 * collision resistance and preimage resistance. A short non-cryptographic
 * checksum can make two independent API keys share a six-hour suppression;
 * SHA-256 keeps the stored identifier safe to expose as telemetry while
 * making that cross-credential state bleed infeasible.
 */
function hashCredential(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

/**
 * Pure scope constructor, exported for regression tests. Inputs may contain
 * secrets, but the returned `ai:`/`vx:` scope contains only a SHA-256 digest.
 */
export function geminiCredentialScope({ apiKey = '', vertexCredentialIdentity = '' } = {}) {
  const normalizedApiKey = normalizeGeminiApiKey(apiKey);
  if (normalizedApiKey) return `ai:${hashCredential(normalizedApiKey)}`;
  return `vx:${hashCredential(vertexCredentialIdentity || 'default')}`;
}

/**
 * Scope key for the active credential + endpoint. AI Studio scopes by API key;
 * Vertex scopes by a digest of the loaded service-account contents. The
 * fallback pathname/project identity is used only while a malformed account
 * cannot be loaded. getAuthClient() establishes this before Vertex calls
 * record failures.
 */
function credentialScope(apiKey) {
  return geminiCredentialScope({
    apiKey,
    // A successfully-loaded account uses a digest of its complete JSON, so a
    // same-path rotation starts with clean model health. The path/project
    // fallback is used only while an invalid account cannot be read at all.
    vertexCredentialIdentity: cachedServiceAccountFingerprint || cachedKeyFile || projectId || 'default',
  });
}

function scopedKey(scope, model) {
  return `${scope}\x00${model}`;
}

/** Hydrate persisted quota/access state once Electron's settings store is ready. */
function hydrateGeminiModelRuntimeState() {
  if (geminiRuntimeStateLoaded || !tryGetStore()) return;
  const persisted = getGeminiModelRuntimeState();
  for (const [key, record] of Object.entries(persisted)) {
    if (record.suppressedUntil) modelSuppressedUntil.set(key, record.suppressedUntil);
    if (record.runtime) modelRuntimeState.set(key, record.runtime);
  }
  geminiRuntimeStateLoaded = true;
}

/** Persist the same hashed `(credential scope, model)` keys used in memory. */
function persistGeminiModelRuntimeState() {
  if (!geminiRuntimeStateLoaded) return;
  const keys = new Set([...modelSuppressedUntil.keys(), ...modelRuntimeState.keys()]);
  const snapshot = {};
  for (const key of keys) {
    const suppressedUntil = modelSuppressedUntil.get(key);
    const runtime = modelRuntimeState.get(key);
    if (suppressedUntil || runtime) snapshot[key] = { ...(suppressedUntil ? { suppressedUntil } : {}), ...(runtime ? { runtime } : {}) };
  }
  saveGeminiModelRuntimeState(snapshot);
}

/** Build a model→suppressedUntil view for the given scope (only cooling entries). */
function suppressionMapForScope(scope, now, models = GEMINI_MODEL_REGISTRY.map(({ id }) => id)) {
  hydrateGeminiModelRuntimeState();
  const m = new Map();
  for (const id of models) {
    const until = modelSuppressedUntil.get(scopedKey(scope, id)) || 0;
    if (until > now) m.set(id, until);
  }
  return m;
}

function clearGeminiModelFailure(scope, model) {
  hydrateGeminiModelRuntimeState();
  modelSuppressedUntil.delete(scopedKey(scope, model));
  modelRuntimeState.delete(scopedKey(scope, model));
  persistGeminiModelRuntimeState();
}

function rememberGeminiModelFailure(scope, model, classification, message, suppressedUntil = null) {
  hydrateGeminiModelRuntimeState();
  const key = scopedKey(scope, model);
  if (suppressedUntil) modelSuppressedUntil.set(key, suppressedUntil);
  // Warning visibility window: a suppressed failure stays visible until it's
  // eligible to retry; a transient/request-specific failure self-expires.
  const warnUntil = suppressedUntil ?? (Date.now() + REQUEST_FAILURE_WARN_MS);
  modelRuntimeState.set(key, {
    model,
    classification,
    message: describeGeminiFailure(classification, message).slice(0, 300),
    observedAt: Date.now(),
    suppressedUntil,
    warnUntil,
  });
  persistGeminiModelRuntimeState();
}

function geminiWarnings(scope = lastActiveScope) {
  hydrateGeminiModelRuntimeState();
  const warnings = [];
  const now = Date.now();
  for (const id of [...new Set([...GEMINI_MODEL_REGISTRY.map(({ id }) => id), ...VERTEX_GEMINI_MODEL_FALLBACKS])]) {
    const lifecycle = getGeminiLifecycleWarning(id);
    if (lifecycle) warnings.push({ model: id, type: 'lifecycle', message: lifecycle });
    if (!scope) continue;
    const runtime = modelRuntimeState.get(scopedKey(scope, id));
    if (!runtime) continue;
    if (runtime.warnUntil && runtime.warnUntil <= now) {
      modelRuntimeState.delete(scopedKey(scope, id));  // expired — stop warning
      persistGeminiModelRuntimeState();
      continue;
    }
    warnings.push({ model: id, type: runtime.classification, message: runtime.message });
  }
  return warnings;
}

function suppressionUntilForFailure(classification, retryAfterMs = null) {
  if (
    classification === 'unavailable'
    || classification === 'model-access'
    || classification === 'thinking-config'
    || classification === 'no-quota'
    || classification === 'daily-quota'
  ) {
    return Date.now() + UNAVAILABLE_RECHECK_MS;
  }
  if (classification !== 'rate-limit') return null;
  const cooldownMs = Math.min(10 * 60_000, Math.max(1000, retryAfterMs ?? 30_000));
  return Date.now() + cooldownMs;
}

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
  const isVertexScope = lastActiveScope?.startsWith('vx:');
  return {
    lastAttemptedModel,
    lastSuccessfulModel,
    lastAttemptedError,
    compatibleModels: [...(isVertexScope ? VERTEX_GEMINI_MODEL_FALLBACKS : GEMINI_MODEL_FALLBACKS)],
    // Why the chain starts where it does. Without this a report showing
    // "started at Flash" is indistinguishable from "Pro was skipped due to a
    // bug" — the entitlement verdict is the difference.
    tierEntitlement: lastActiveScope ? entitlementSnapshot(lastActiveScope) : [],
    warnings: geminiWarnings(),
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
 * Flatten the structured google.rpc detail blocks (QuotaFailure / RetryInfo) from
 * a Gemini error body. The flat `error.message` usually omits the violated
 * quota's `quotaValue` ("0" for a Pro model with no free-tier quota) and the
 * per-day quotaId — so the suppression policy can't tell a zero-quota model from
 * a transient burst without this. Returns '' when there are no structured details.
 */
function extractGeminiErrorDetails(body) {
  if (!body) return '';
  try {
    const details = JSON.parse(body)?.error?.details;
    if (Array.isArray(details) && details.length) return JSON.stringify(details).slice(0, 1000);
  } catch { /* not JSON */ }
  return '';
}

// Minimal probe body: we only inspect the HTTP status (ok / 429 / 4xx), never the
// content, so the smallest possible output cap keeps each probe's token footprint
// near zero. It's still one request against the model's RPD pool — inherent to
// verifying real availability — but no longer spends a 256-token budget per model.
function geminiProbeBody(model) {
  return JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
    generationConfig: {
      maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
      responseMimeType: 'text/plain',
      thinkingConfig: getGeminiDefaultThinkingConfig(model),
    },
  });
}

/**
 * Shared post-fetch shaping for probeGemini/probeGeminiVertex: both endpoints
 * must fold into the identical {ok,status,...} shape since they feed the same
 * suppression/entitlement state (runGeminiAvailabilityCheck), so a fix to
 * failure classification here can't drift between AI Studio and Vertex.
 * Always drains the body (success included) — an unread Response pins its
 * keep-alive socket until GC, same concern fetchWithRetry's comment above
 * documents for the retry path.
 */
async function shapeGeminiProbeResult(res, model, quotaStats) {
  if (res.ok) {
    await res.text().catch(() => {});
    return { ok: true, status: res.status, model, quotaStats };
  }
  let body = '';
  try { body = await res.text(); } catch { /* ignore */ }
  const error = extractGeminiErr(body, res.status);
  const errorDetails = extractGeminiErrorDetails(body);
  const classification = classifyGeminiFailure(res.status, `${error}\n${errorDetails}`);
  return {
    ok: false,
    status: res.status,
    model,
    error,
    errorDetails,
    classification,
    diagnostic: describeGeminiFailure(classification, error),
    retryAfterMs: parseGeminiRetryMs(res, body),
    quotaStats,
  };
}

/**
 * Availability probe for the AI Studio key path: a tiny generateContent ping.
 * NEVER throws — returns {ok,status,...}. Unlike Claude, Gemini exposes NO
 * remaining-quota on success (only a retry hint on 429), so there is no
 * `rateLimit` block by design — we don't fabricate one.
 */
export async function probeGemini(apiKey, model = 'gemini-3.1-flash-lite', quotaStatsMap = null) {
  apiKey = normalizeGeminiApiKey(apiKey);
  if (!apiKey) {
    return { ok: false, status: null, error: 'No AI Studio API key set (a service-account / Vertex setup is not probed here).' };
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: { 'Content-Type': 'application/json' },
      body: geminiProbeBody(model),
    });
  } catch (e) {
    return { ok: false, status: null, model, error: e?.message || String(e) };
  }
  // Attach quota stats for this model if we fetched them from Cloud Monitoring.
  const quotaStats = quotaStatsMap?.[model] ?? null;
  return shapeGeminiProbeResult(res, model, quotaStats);
}

/**
 * Availability probe for the VERTEX (service-account) path — the equivalent of
 * probeGemini for users who configured a service-account.json but no AI Studio
 * key. Without this, "Check availability" reports "no Gemini key" even though
 * normal Gemini calls work fine through Vertex (Finding 4). NEVER throws.
 */
async function probeGeminiVertex(model = VERTEX_GEMINI_MODEL_FALLBACKS[0], quotaStatsMap = null) {
  let token;
  let pid;
  try {
    token = await getToken();   // populates module-level projectId via getAuthClient
    pid = projectId;
    if (!token || !pid) {
      return { ok: false, status: null, model, error: 'No usable Vertex service-account credential.' };
    }
  } catch (e) {
    return { ok: false, status: null, model, error: e?.message || String(e) };
  }
  const url = vertexGenerateContentUrl(pid, model);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: geminiProbeBody(model),
    });
  } catch (e) {
    return { ok: false, status: null, model, error: e?.message || String(e) };
  }
  const quotaStats = quotaStatsMap?.[model] ?? null;
  return shapeGeminiProbeResult(res, model, quotaStats);
}

/**
 * Fetches real RPM / RPD / TPM quota usage for all Gemini models via the
 * Cloud Monitoring API. Requires a service account with monitoring.read scope
 * (i.e., the service-account.json the user has already configured for Vertex AI).
 * Returns a map: modelName → { rpm, rpd, tpm } where each entry is
 * { used: number, limit: number } — 100% confirmed from Google.
 * Returns null silently if no service account is configured or the call fails.
 * NEVER throws.
 */
async function fetchGeminiQuotaStats() {
  let projectId;
  let token;
  try {
    const { auth, projectId: pid } = await getAuthClient();
    projectId = pid;
    const client = await auth.getClient();
    // Request an additional monitoring.read scope on top of cloud-platform.
    const tokenResp = await client.getAccessToken();
    token = tokenResp.token;
    if (!token || !projectId) return null;
  } catch {
    // No service account configured — silently skip.
    return null;
  }

  const monBase = `https://monitoring.googleapis.com/v3/projects/${projectId}/timeSeries`;
  const authHeader = { Authorization: `Bearer ${token}` };

  // Use a 25-hour window so we always capture the last full day of RPD data.
  const now = new Date();
  const startTime = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString();
  const endTime = now.toISOString();

  // We query two metric types:
  //   quota/rate/net_usage  — how much was actually consumed (per 1-min windows)
  //   quota/limit           — the configured limit per quota metric
  // Both are under serviceruntime for the generativelanguage service.
  const BASE_FILTER = 'resource.labels.service="generativelanguage.googleapis.com"';

  const usageParams = new URLSearchParams({
    filter: `metric.type="serviceruntime.googleapis.com/quota/rate/net_usage" AND ${BASE_FILTER}`,
    'interval.startTime': startTime,
    'interval.endTime': endTime,
    'aggregation.alignmentPeriod': '3600s',
    'aggregation.crossSeriesReducer': 'REDUCE_MAX',
    'aggregation.perSeriesAligner': 'ALIGN_MAX',
    'aggregation.groupByFields': 'metric.labels.quota_metric,metric.labels.quota_location',
    view: 'FULL',
  });

  const limitParams = new URLSearchParams({
    filter: `metric.type="serviceruntime.googleapis.com/quota/limit" AND ${BASE_FILTER}`,
    'interval.startTime': startTime,
    'interval.endTime': endTime,
    'aggregation.alignmentPeriod': '86400s',
    'aggregation.crossSeriesReducer': 'REDUCE_MAX',
    'aggregation.perSeriesAligner': 'ALIGN_MAX',
    'aggregation.groupByFields': 'metric.labels.quota_metric',
    view: 'FULL',
  });

  let usageData, limitData;
  try {
    const [usageRes, limitRes] = await Promise.all([
      fetch(`${monBase}?${usageParams}`, { headers: authHeader }),
      fetch(`${monBase}?${limitParams}`, { headers: authHeader }),
    ]);
    // A losing response's body must still be drained (not just left null) —
    // an unread stream pins its keep-alive socket until GC, and this call
    // fires on every availability sweep.
    if (!usageRes.ok && !limitRes.ok) {
      await Promise.all([usageRes.text().catch(() => {}), limitRes.text().catch(() => {})]);
      return null;
    }
    const readJsonOrDrain = (res) => (res.ok ? res.json().catch(() => null) : res.text().catch(() => null).then(() => null));
    [usageData, limitData] = await Promise.all([readJsonOrDrain(usageRes), readJsonOrDrain(limitRes)]);
  } catch {
    return null;
  }

  // Parse the quota metric name to extract the model and dimension (rpm/rpd/tpm).
  // Google names these like:
  //   "generate_content_free_tier_requests_per_minute_per_project_per_model"
  //   "generate_content_free_tier_requests_per_day"
  //   "generate_content_free_tier_tokens_per_minute_per_model"
  // The actual model mapping requires parsing the quota_metric label and matching
  // to our GEMINI_MODEL_FALLBACKS list. We parse the time series labels.

  // Build limit map: quota_metric → limit value
  const limits = {};
  for (const ts of limitData?.timeSeries || []) {
    const qm = ts.metric?.labels?.quota_metric || '';
    const pts = ts.points || [];
    if (pts.length === 0) continue;
    const val = Number(pts[0].value?.int64Value ?? pts[0].value?.doubleValue ?? 0);
    limits[qm] = val;
  }

  // Build usage map: quota_metric → max used value in window
  const usages = {};
  for (const ts of usageData?.timeSeries || []) {
    const qm = ts.metric?.labels?.quota_metric || '';
    const pts = ts.points || [];
    if (pts.length === 0) continue;
    const maxVal = pts.reduce((m, p) => {
      const v = Number(p.value?.int64Value ?? p.value?.doubleValue ?? 0);
      return Math.max(m, v);
    }, 0);
    usages[qm] = (usages[qm] ?? 0) + maxVal;
  }

  // Map quota metric names → dimension keys we expose.
  // We look for keywords in the metric name to classify as rpm/rpd/tpm.
  function classifyQuotaMetric(qm) {
    const s = qm.toLowerCase();
    if (s.includes('per_minute') && s.includes('token')) return 'tpm';
    if (s.includes('per_minute')) return 'rpm';
    if (s.includes('per_day'))    return 'rpd';
    return null;
  }

  // The serviceruntime quota timeSeries we can read here are reported at the
  // PROJECT level — the returned labels don't reliably carry a per-model
  // dimension on the generativelanguage free tier (a model-labelled query isn't
  // dependable and risks 400-ing the whole call). So these rpm/rpd/tpm figures
  // are a single project-wide snapshot, NOT per-model. We therefore tag each
  // entry `scope: 'project'` and the UI labels it as shared rather than
  // pretending each model has its own numbers — Google's per-model dashboard
  // (e.g. Pro at 0/0) is the source of truth for model-specific limits.
  const aggregated = { rpm: { used: 0, limit: 0 }, rpd: { used: 0, limit: 0 }, tpm: { used: 0, limit: 0 } };
  const seenDimensions = new Set();
  for (const qm of new Set([...Object.keys(usages), ...Object.keys(limits)])) {
    const dim = classifyQuotaMetric(qm);
    if (!dim) continue;
    if (!seenDimensions.has(dim)) {
      // Take the first matching metric per dimension (avoid double-counting variants).
      aggregated[dim].used  = usages[qm]  ?? 0;
      aggregated[dim].limit = limits[qm]  ?? 0;
      seenDimensions.add(dim);
    }
  }

  // If no data came back at all, return null so the UI falls back to ping-only.
  const hasData = seenDimensions.size > 0;
  if (!hasData) return null;

  const result = {};
  for (const model of GEMINI_MODEL_FALLBACKS) {
    result[model] = {
      rpm: aggregated.rpm.limit > 0 ? aggregated.rpm : null,
      rpd: aggregated.rpd.limit > 0 ? aggregated.rpd : null,
      tpm: aggregated.tpm.limit > 0 ? aggregated.tpm : null,
      scope: 'project',   // these figures are project-wide, not model-specific
    };
  }
  return result;
}

// Last live "Check availability" result per provider, so the Settings panel can
// render the most recent verdict immediately on open (the button refreshes it).
const lastProbe = { gemini: null, claude: null };

// Coalesce concurrent Gemini "Check availability" runs. Each run probes EVERY
// compatible model (one request per model against its RPD pool), so a double-click
// or a second open panel must reuse the in-flight batch rather than fire a fresh
// one. Sequential checks (after this settles) still re-probe for fresh status.
let geminiCheckInFlight = null;

/**
 * Run one Gemini availability sweep: probe every compatible model and fold the
 * verdicts into this credential's suppression state. Supports BOTH the AI Studio
 * key path and the Vertex (service-account) path — a Vertex-only setup is no
 * longer falsely reported as "no Gemini key" (Finding 4). Never throws.
 */
async function runGeminiAvailabilityCheck(settings) {
  const apiKey = normalizeGeminiApiKey(settings.geminiApiKey);
  const hasServiceAccount = !!resolveServiceAccountPath();

  if (!apiKey && !hasServiceAccount) {
    return {
      ok: false,
      models: [{ ok: false, status: null, model: null,
        error: 'No Gemini credential set — add an AI Studio API key or a service-account.json in Settings.' }],
    };
  }

  // Pre-warm the shared auth client so the parallel Vertex probes reuse one
  // cached client+token instead of racing getAuthClient — a concurrent
  // rebuild/reset (getToken clears authClient on error) could otherwise make
  // sibling probes spuriously fail. Errors here are surfaced by the probes.
  if (!apiKey) { try { await getAuthClient(); } catch { /* probes report it */ } }

  // Probe via AI Studio when a key is set, else via the Vertex service account.
  const probeOne = apiKey
    ? (m) => probeGemini(apiKey, m, null)
    : (m) => probeGeminiVertex(m, null);

  const compatibleModels = apiKey ? GEMINI_MODEL_FALLBACKS : VERTEX_GEMINI_MODEL_FALLBACKS;

  // "Check availability" is the user explicitly asking for a FRESH answer, so
  // it re-probes the entitlement-gated tiers too (Pro) rather than reading the
  // week-old cache — this is how a key that just got billing enabled starts
  // using Pro immediately instead of on the next background refresh. These
  // extra probes are why the gated ids are excluded from GEMINI_MODEL_FALLBACKS:
  // they're worth one request here, on demand, not on every sweep of the
  // routine chain.
  const gated = (apiKey ? gatedTiers() : [])
    .map((tier) => ({ tier, model: probeModelForTier(tier) }))
    .filter((g) => !!g.model);

  const [quotaStatsMap, gatedResults, ...probeResults] = await Promise.all([
    fetchGeminiQuotaStats(),
    Promise.all(gated.map((g) => probeOne(g.model).then((r) => ({ ...g, result: r })))),
    ...compatibleModels.map((m) => probeOne(m)),
  ]);

  const models = probeResults.map((probe, i) => ({
    ...probe,
    quotaStats: quotaStatsMap?.[compatibleModels[i]] ?? null,
  }));

  // Fold verdicts into THIS credential+endpoint's scope so the check updates the
  // same suppression state the live fallback loop reads (and clears recovered ones).
  const scope = credentialScope(apiKey);
  lastActiveScope = scope;

  // Record the gated-tier verdicts against this scope. Their probe results are
  // reported alongside the routine models (so the Settings panel shows WHY Pro
  // isn't being used) but deliberately excluded from the `ok` rollup below — a
  // denied Pro tier is the expected free-tier state, not a provider outage.
  for (const g of gatedResults) {
    // No HTTP status means the probe never reached the server (network fault,
    // or no credential) — not evidence about the credential, so don't let a
    // blip overwrite a real cached verdict with a week-long "denied" (mirrors
    // the same guard in refreshEntitlementInBackground, geminiEntitlement.js).
    if (!g.result?.ok && g.result?.status == null) continue;
    recordEntitlement(scope, g.tier, !!g.result?.ok,
      g.result?.ok ? `HTTP ${g.result.status}` : `HTTP ${g.result?.status ?? '?'} ${g.result?.error || ''}`.trim());
  }

  for (const modelResult of models) {
    if (!modelResult.model) continue;
    if (modelResult.ok) { clearGeminiModelFailure(scope, modelResult.model); continue; }
    const failureText = `${modelResult.error || ''}\n${modelResult.errorDetails || ''}`;
    const classification = modelResult.classification || classifyGeminiFailure(modelResult.status, failureText);
    const suppressedUntil = suppressionUntilForFailure(classification, modelResult.retryAfterMs);
    rememberGeminiModelFailure(scope, modelResult.model, classification, modelResult.error, suppressedUntil);
  }

  return {
    ok: isGeminiProviderAvailable(models),
    models,
    // Surfaced separately from `models` so a denied Pro tier reads as "not
    // entitled on this plan" rather than as a failing model in the chain.
    tierEntitlement: entitlementSnapshot(scope),
    // Derived from the folded rows, not from the fetch succeeding: the stats map
    // is keyed by the AI Studio ids (and describes generativelanguage quota), so
    // on the Vertex endpoint no row can ever receive stats and the panel would
    // otherwise claim Cloud Monitoring figures it has nothing to render.
    hasQuotaStats: models.some((m) => !!m.quotaStats),
    endpoint: apiKey ? 'ai-studio' : 'vertex',
  };
}

/**
 * Inner executor for a single Gemini API request.
 */
async function callGeminiSingle(parts, apiKey, model, genConfig = {}) {
  apiKey = normalizeGeminiApiKey(apiKey);
  // If an API key is provided, route directly to the free AI Studio endpoint
  // Otherwise, default to the Vertex AI service account pipeline
  let endpoint = '';
  let headers = { 'Content-Type': 'application/json' };
  
  if (apiKey) {
    endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model || GEMINI_MODEL_FALLBACKS[0]}:generateContent?key=${apiKey}`;
  } else {
    // No API key → Vertex AI via service-account.json. getToken() (→ getAuthClient)
    // throws a clear "no credential" error if neither is configured.
    const token = await getToken();
    endpoint = vertexGenerateContentUrl(projectId, model || VERTEX_GEMINI_MODEL_FALLBACKS[0]);
    headers['Authorization'] = `Bearer ${token}`;
  }

  // `task` is metadata for token-usage telemetry and `meta` is a by-reference
  // out-param the fallback loop writes the succeeded model into — neither is a
  // Gemini API field, so pull them out so they never leak into generationConfig
  // (which would 400 the call). `grounding` is also ours — it lifts to a
  // top-level `tools` entry (Google Search), NOT a generationConfig field.
  // `excludeModels` is consumed by the fallback loop's model ordering (callGemini)
  // and must likewise never reach the wire.
  const { signal, responseSchema, task, formulaSeed: _formulaSeed, meta: _meta, grounding: _grounding, excludeModels: _excludeModels, ...restGenConfig } = genConfig;
  const formulaSeed = _formulaSeed ?? null;

  const generationConfig = {
    temperature: GEMINI_TEMPERATURE,
    responseMimeType: 'application/json',
    maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
    // High thinking for Gemini; Gemma is the TPM-limited exception and its
    // registry entry deliberately uses minimal. The central registry keeps
    // callers, fallbacks, probes, and direct requests on this same policy.
    thinkingConfig: getGeminiDefaultThinkingConfig(model),
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
    payload.tools = geminiGroundingTools(!apiKey);
  }

  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const endpointName = apiKey ? 'Gemini API (AI Studio)' : 'Vertex AI';

  const response = await fetchWithRetry(endpoint, {
    method: 'POST',
    signal: combinedSignal,
    headers,
    body: JSON.stringify(payload),
  }, { label: endpointName });

  if (!response.ok) {
    // Capture the status BEFORE touching the body: if the deadline tore the
    // stream down, the read below throws and the HTTP status is the only fact
    // left. The thrown message must stay free of 'abort'/'quota'/'rate limit'/
    // '429' so classification lands on the status-based 'server' branch instead
    // of being mislabelled a cancellation or a quota problem.
    const status = response.status;
    let errText;
    try {
      errText = await response.text();
    } catch {
      const e = new Error(`${endpointName} error ${status}: request deadline elapsed while retrying; response body unavailable`);
      e.status = status;
      throw e;
    }
    let errMsg;
    try { errMsg = JSON.parse(errText)?.error?.message || errText; }
    catch { errMsg = errText; }
    const error = new Error(`${endpointName} error ${status}: ${errMsg}`);
    error.status = status;
    error.retryAfterMs = parseGeminiRetryMs(response, errText);
    // Carry the structured quota/retry details so the suppression policy can see
    // quotaValue:"0" / per-day quotas that the flat message drops (Finding 3).
    error.details = extractGeminiErrorDetails(errText);
    throw error;
  }

  const data = await response.json();
  // A prompt that trips a safety filter BEFORE any candidate is generated
  // (plausible here — untrusted scraped job/listing text flows into these
  // prompts) leaves `candidates` empty/absent and `finishReason` undefined,
  // so without this check every failure mode below falls through to the
  // generic "no content" message, losing the one piece of evidence
  // (blockReason / category) that would actually explain what happened.
  const promptBlockReason = data?.promptFeedback?.blockReason;
  if (promptBlockReason && !data?.candidates?.length) {
    const categories = (data.promptFeedback?.safetyRatings || [])
      .filter(r => r?.blocked || (r?.probability && r.probability !== 'NEGLIGIBLE'))
      .map(r => r.category).filter(Boolean).join(', ');
    throw new Error(`Gemini blocked the prompt before generating a response: blockReason=${promptBlockReason}${categories ? ` (${categories})` : ''}.`);
  }
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
    const err = new Error(`AI response was truncated — hit the ${cap}-token output cap (model wrote ${visible} visible tokens + ${thoughts} thinking tokens before being cut off).${note} Raise the cap for this task in llm.js TASK_MAX_TOKENS.`);
    // Machine-readable tag: callers retry truncation on a raised cap by code, not
    // by matching the prose above.
    err.code = 'MAX_TOKENS';
    throw err;
  }
  // SAFETY / RECITATION / OTHER
  if (finishReason && finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
    throw new Error(`AI response terminated abnormally: finishReason=${finishReason}. This usually means safety filters or recitation blocking — try rephrasing or removing problematic content.`);
  }

  if (!contentText) throw new Error(`No content returned from Gemini (finishReason=${finishReason || 'unknown'}).`);

  return _grounding ? formatGeminiGroundedResponse(contentText, candidate) : contentText;
}

/**
 * Core Gemini call — sends parts (text + optional images) to Vertex AI or AI Studio,
 * automatically falling back across the available text/JSON-capable Gemini
 * models. Quality tasks prefer Pro; lightweight tasks exhaust Lite/Flash before
 * using Pro. Rate limits and unavailable endpoints move to the tail.
 * @param {Array} parts — Array of { text } or { inlineData: { mimeType, data } } objects
 * @param {string} apiKey - Optional Gemini API Key. If missing, falls back to Vertex AI.
 * @param {string} model - Preferred model for this task; all compatible models remain fallbacks.
 * @param {object} [genConfig] — generationConfig overrides
 * @returns {Promise<string>} — Raw text response from Gemini
 */
async function callGemini(parts, apiKey, model, genConfig = {}) {
  apiKey = normalizeGeminiApiKey(apiKey);
  // Without an API key we use the Vertex/service-account path; verify that
  // credential up front so a missing one fails fast with one clear error
  // instead of throwing the same auth failure against all fallback models.
  // (With a key we hit AI Studio directly — no service-account probe needed.)
  if (!apiKey) await getAuthClient();

  // Scope suppression to THIS credential + endpoint (getAuthClient above has
  // populated cachedKeyFile/projectId for the Vertex path) so a failure on one
  // key/endpoint never suppresses a model for another. A grounded call's
  // feature-specific failures are also kept out of the persistent model state.
  const scope = credentialScope(apiKey);
  lastActiveScope = scope;
  const grounded = !!genConfig.grounding;

  const attemptedErrors = [];
  if (genConfig.meta && typeof genConfig.meta === 'object') {
    genConfig.meta.fallback = { attempts: 0, preferredModel: model };
  }

  // Cascade down the shared capability ladder (GEMINI_TIER_LADDER) through every
  // compatible model; `model` is a recorded per-task preference that
  // orderGeminiModels does not act on. Known rate-limited/unreachable endpoints
  // move to the tail as a last resort.
  //
  // `entitledTiersFor` is a pure cache read — it never blocks this call. The
  // refresh below fires a single minimal probe in the BACKGROUND when a gated
  // tier's verdict is missing or stale, so the answer is ready for the next
  // call rather than adding latency to this one. Each endpoint uses its own
  // probe: a Vertex project can also lack access to a Pro model, and without
  // its background probe it would never enter the Pro tier unless the user
  // happened to click Settings → Check availability first.
  const usingVertex = !apiKey;
  // Shared by both passes: the retry pass must derive its order from exactly the
  // same inputs as the first one, or a later change to the ordering inputs would
  // silently apply to only one of them.
  const computeModelOrder = (now, logPrefix = '') => {
    const entitledTiers = usingVertex ? new Set() : entitledTiersFor(scope, now);
    const scopeSuppression = suppressionMapForScope(
      scope,
      now,
      usingVertex ? VERTEX_GEMINI_MODEL_FALLBACKS : undefined,
    );
    const order = usingVertex
      ? orderVertexGeminiModels(scopeSuppression, now, { excludeModels: genConfig.excludeModels })
      : orderGeminiModels(model, scopeSuppression, now, {
        entitledTiers,
        responseSchema: !!genConfig.responseSchema,
        grounding: grounded,
        excludeModels: genConfig.excludeModels,
      });
    const cooling = order.filter(m => scopeSuppression.has(m));
    if (cooling.length > 0 && cooling.length < order.length) {
      logger.info(`[Gemini] ${logPrefix}Deferring ${cooling.length} suppressed model(s): ${cooling.join(', ')}`);
    }
    return order;
  };

  const _now = Date.now();
  if (!usingVertex) {
    refreshEntitlementInBackground(scope, (m) => probeGemini(apiKey, m), _now);
  }
  const modelOrder = computeModelOrder(_now);

  // One pass over a fallback chain: try every model in `order` in turn.
  // Failures are folded into the shared `attemptedErrors` (the running
  // diagnostic used for the final aggregate error, across BOTH passes when a
  // retry pass runs) and also appended to the caller-supplied `passErrors`
  // array, which is scoped to only THIS pass — that's what lets the Finding 7
  // retry decision below ask "was every failure in the pass that just
  // exhausted a recoverable rate-limit?" without being polluted by a prior
  // pass's classifications. Returns the winning text on success; returns
  // undefined if every model in `order` failed (a clean cancellation or an
  // `auth` failure still throws directly, same as always).
  async function runFallbackPass(order, passErrors) {
    for (const currentModel of order) {
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
        logger.info(`[Gemini] Attempting call with model: ${currentModel}${genConfig.task ? ` task=${genConfig.task}` : ''}`);
        lastAttemptedModel = currentModel;

        const result = await callGeminiSingle(parts, apiKey, currentModel, genConfig);

        lastSuccessfulModel = currentModel;
        clearGeminiModelFailure(scope, currentModel);
        // Clear the per-attempt error on success. Otherwise it stays pinned to the
        // last failed hop — on the FREE tier the small "20 RPD" pools exhaust fast,
        // so a healthy call that simply fell through to a later model would forever
        // surface a scary "Last error: …429" in Settings and bug reports even though
        // it succeeded. The expected fall-through is still captured per-stage in
        // genConfig.meta.fallback.
        lastAttemptedError = '(none)';
        // Report the model that actually served this call back to the caller (by
        // reference) so per-stage telemetry can record WHICH model produced each
        // result — e.g. a price synthesized by a weaker fallback after the
        // preferred models 429'd looks identical in the output otherwise.
        if (genConfig.meta && typeof genConfig.meta === 'object') {
          genConfig.meta.model = currentModel;
          // When earlier models were skipped to land here, record WHY — quota/
          // rate-limit (external: wait or upgrade tier) vs token-cap truncation
          // (our cap is too low: raise it in llm.js TASK_MAX_TOKENS) vs server
          // (overload). The bug-report funnel otherwise only knows "weak fallback"
          // from the model NAME; the per-attempt reason lives solely in the
          // scrolling log buffer, and each cause needs a different fix.
          if (attemptedErrors.length > 0) {
            const counts = {};
            for (const e of attemptedErrors) {
              const k = e.classification || 'other';
              counts[k] = (counts[k] || 0) + 1;
            }
            const reason = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
            genConfig.meta.fallback = { attempts: attemptedErrors.length, reason, counts, preferredModel: model };
          }
        }
        return result;
      } catch (err) {
        const errMsg = err.message || String(err);
        const failureText = err.details ? `${errMsg}\n${err.details}` : errMsg;
        const classification = classifyGeminiFailure(err.status, failureText);
        logger.warn(`[Gemini] Model ${currentModel} failed: ${errMsg}`);
        // `classification` is decided from failureText, which folds in err.details (the
        // structured google.rpc QuotaFailure/RetryInfo blocks) — but only errMsg above
        // ever reached the log. A verdict like `daily-quota` can be driven entirely by
        // those details even when errMsg itself has no per-day/daily/RPD token in it
        // (e.g. a free-tier RPM message), which made the verdict unauditable: nobody
        // reading the log/bug report afterwards could tell a genuine per-day quotaId
        // from a spurious one, or see that a short provider retry hint was parsed and
        // then discarded rather than honored. Log those inputs now; the suppression
        // decision itself (below) is unchanged.
        const parsedRetryAfterMs = err.retryAfterMs ?? parseRetryMsFromError(errMsg);
        const detailsExcerpt = err.details
          ? (err.details.length > 300 ? `${err.details.slice(0, 300)}…` : err.details)
          : '(none)';
        logger.info(`[Gemini] ${currentModel} classification=${classification} retryAfterMs=${parsedRetryAfterMs ?? 'n/a'} details=${detailsExcerpt}`);

        lastAttemptedError = `${currentModel}: ${errMsg}`;
        attemptedErrors.push({ model: currentModel, error: errMsg, classification });
        passErrors.push(classification);

        // Only a CREDENTIAL-level auth failure aborts the whole chain — every model
        // would fail identically. A per-model 403 (model-access) does NOT: it
        // suppresses just that model and cascades to the next (Finding 1).
        if (genConfig.signal?.aborted || classification === 'auth') throw err;

        if (classification === 'rate-limit' || classification === 'no-quota' || classification === 'daily-quota') {
          const retryMs = err.retryAfterMs ?? parseRetryMsFromError(errMsg);
          rememberGeminiModelFailure(scope, currentModel, classification, errMsg, suppressionUntilForFailure(classification, retryMs));
          logger.warn(`[Gemini] Falling back to the next best model...`);
          continue;
        }
        if (classification === 'unavailable' || classification === 'model-access' || classification === 'thinking-config') {
          // A grounded request's unavailable/access failure may be feature-specific
          // (the model is fine for normal JSON calls), so don't persist suppression —
          // just cascade for THIS call (Finding 2). Non-grounded failures suppress.
          const suppressedUntil = grounded ? null : suppressionUntilForFailure(classification);
          rememberGeminiModelFailure(scope, currentModel, classification, errMsg, suppressedUntil);
          logger.warn(`[Gemini] Falling back to the next best model...`);
          continue;
        }

        // Request-specific failure (truncation/server/timeout/malformed): record an
        // EXPIRING warning, never a permanent suppression (Finding 6).
        rememberGeminiModelFailure(scope, currentModel, classification, errMsg);
        logger.warn(`[Gemini] ${currentModel}: ${classification} failure — falling through to the next model: ${errMsg}`);
      }
    }
    return undefined;
  }

  const firstPassErrors = [];
  const firstResult = await runFallbackPass(modelOrder, firstPassErrors);
  if (firstResult !== undefined) return firstResult;

  // Finding 7: a real run showed the ENTIRE ladder 429 in well under a second —
  // every independent free-tier per-minute quota pool this credential can
  // reach happened to be exhausted at the same moment — and the caller
  // silently degraded (a job application generated with NO company research)
  // instead of finding out the quota was about to reopen. `parseGeminiRetryMs`
  // / `parseRetryMsFromError` already parse the provider's own retry hint on
  // every 429; until now that value only set a suppression expiry that the
  // NEXT unrelated call would benefit from — nothing made THIS call wait for
  // it. Retry the whole ladder ONCE, and only when every failure this pass
  // was the recoverable `rate-limit` classification: a no-quota/daily-quota/
  // model-access/unavailable/auth/thinking-config/server/other failure means
  // at least one model will not work again on any short timer, so waiting
  // buys nothing and only delays the identical failure the caller would get
  // anyway — that case still throws immediately, exactly as before this fix.
  const allRateLimited = firstPassErrors.length > 0 && firstPassErrors.every((c) => c === 'rate-limit');
  if (allRateLimited) {
    const waitNow = Date.now();
    // Earliest suppression expiry across the models THIS pass attempted, via
    // the same scoped-key accessor every other suppression read/write in this
    // module uses (never a hand-built `${scope}\x00${model}` string). Every
    // model here failed rate-limit, and suppressionUntilForFailure('rate-limit',
    // …) always sets a suppression timestamp, so this is normally always found —
    // the fallback constant below only matters if a concurrent call raced and
    // cleared an entry in the shared module-level Map before we could read it.
    let earliestExpiry = null;
    for (const m of modelOrder) {
      const until = modelSuppressedUntil.get(scopedKey(scope, m));
      if (until && (earliestExpiry === null || until < earliestExpiry)) earliestExpiry = until;
    }
    const MIN_LADDER_RETRY_WAIT_MS = 1000;    // never a busy-loop retry
    const MAX_LADDER_RETRY_WAIT_MS = 60_000;  // never stall a user-facing call a full minute+
    const FALLBACK_LADDER_RETRY_WAIT_MS = 5000; // only if no suppression entry parsed at all
    const waitMs = earliestExpiry != null
      ? Math.min(MAX_LADDER_RETRY_WAIT_MS, Math.max(MIN_LADDER_RETRY_WAIT_MS, earliestExpiry - waitNow))
      : FALLBACK_LADDER_RETRY_WAIT_MS;

    logger.info(`[Gemini] All ${modelOrder.length} models rate-limited (free-tier per-minute quota) — waiting ${waitMs}ms for the earliest quota reset, then retrying the ladder once before giving up.`);
    await _ladderRetryWait(waitMs, genConfig.signal);
    // Same abort shape as every other cancellation point in this file — a
    // cancellation during the wait must surface as a clean AbortError, not get
    // swallowed into a misleading "all models failed".
    if (genConfig.signal?.aborted) {
      const abortErr = new Error('Gemini request aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }

    // Recompute fresh — suppressions may have expired during the wait, and a
    // stale `modelOrder` would just re-run the same (still-cooling) ordering.
    const modelOrder2 = computeModelOrder(Date.now(), 'Retry pass: ');

    const secondPassErrors = [];
    const secondResult = await runFallbackPass(modelOrder2, secondPassErrors);
    if (secondResult !== undefined) return secondResult;
    // Both passes exhausted — fall through to the unchanged aggregate error
    // below, guarded so this retry only ever happens once per call (never a loop).
  }

  // If we reach here, all compatible direct models have failed (across both
  // the initial pass and, when eligible, the single Finding 7 retry pass
  // above). Managed-agent endpoints are intentionally excluded: they cannot
  // honor response schemas, so they must not be used as a transparent Gemini
  // fallback.
  const errorDetails = attemptedErrors.map(e => `* ${e.model}: ${e.error}`).join('\n');
  const noQuotaCount = attemptedErrors.filter((e) => e.classification === 'no-quota').length;
  const dailyQuotaCount = attemptedErrors.filter((e) => e.classification === 'daily-quota').length;
  // Tag as rate limit if any of the errors were rate limits. \b429\b (not a
  // substring test) so digit runs like "wrote 4291 visible tokens" in a
  // truncation message can't masquerade as an HTTP 429 — enhanceLLMError
  // (llm.js) uses the same boundary match; keep the two in lockstep.
  const hasRateLimit = attemptedErrors.some(e =>
    e.classification === 'rate-limit' ||
    /\b429\b/.test(e.error) ||
    e.error.toLowerCase().includes('rate limit') ||
    e.error.toLowerCase().includes('quota')
  );
  // Only suggest quotas when some attempt actually looked quota/rate-limit
  // shaped. When every model rejected the request itself (e.g. a 400 on a
  // malformed payload), a quota-flavored header is not just wrong — the word
  // "quota" trips enhanceLLMError's message sniff downstream, falsely tagging
  // isRateLimit and titling the hub banner "Usage Limit Reached". The non-quota
  // wording below must therefore avoid "quota"/"429"/"rate limit" substrings.
  // A pass where the provider never answered (per-model timeout → 'aborted',
  // overload/5xx → 'server') sets none of the counters above, so without its own
  // branch it fell through to the request-rejection wording below and told the
  // user the app had sent a malformed request when nothing was ever rejected.
  // Report the observed classification counts instead of naming a cause.
  const noAnswerCount = attemptedErrors.filter(
    (e) => e.classification === 'server' || e.classification === 'aborted'
  ).length;
  const quotaSummary = noQuotaCount > 0
    ? `${noQuotaCount} model(s) have no quota allocated for this credential/project`
    : dailyQuotaCount > 0
      ? `${dailyQuotaCount} model(s) exhausted their daily quota`
      : hasRateLimit
        ? 'Usage limits or quotas may have been exceeded on the fallback models'
        : noAnswerCount > 0
          ? `${noAnswerCount} of ${attemptedErrors.length} attempt(s) failed before the model answered (provider server error or timeout); no usage-limit failures were seen`
          : 'Every model rejected the request itself (no usage-limit failures were seen) — this points at a malformed request or an API change, not exhausted limits';
  const finalError = new Error(`All Gemini models failed. ${quotaSummary}.\n\nDetails:\n${errorDetails}`);
  if (hasRateLimit) {
    finalError.isRateLimit = true;
    finalError.provider = 'gemini';
  }

  throw finalError;
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
  return parseAiJson(raw);
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
  apiKey = normalizeGeminiApiKey(apiKey);
  if (!apiKey) throw new Error('Gemini countTokens requires an AI Studio API key');
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model || GEMINI_MODEL_FALLBACKS[0]}:countTokens?key=${apiKey}`;
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
  const { ensureVisionSafeImage, downscaleImageIfNeeded, cleanupTempFile } = await import('./heicUtils.js');
  const tempFiles = [];
  try {
    const imageParts = await Promise.all(imagePaths.map(async (imgPath) => {
      assertAttachmentPathSafe(imgPath);
      let finalPath = await ensureVisionSafeImage(imgPath);
      if (finalPath !== imgPath) tempFiles.push(finalPath);

      // Gemini vision is flat-rate per image, but inlineData still has a hard
      // byte ceiling. Downscale phone-camera originals before the size check so
      // a 20-30MB JPEG can still be analyzed instead of forcing manual export.
      const scaledPath = await downscaleImageIfNeeded(finalPath, { maxLongSide: 1600 });
      if (scaledPath !== finalPath) {
        tempFiles.push(scaledPath);
        finalPath = scaledPath;
      }

      const stats = await fs.promises.stat(finalPath);
      // Vertex AI inlineData limit is 20MB. Base64 encoding adds ~33% overhead,
      // so we cap the raw file size at 15MB to be safe and provide a clear error.
      if (stats.size > MAX_AI_FILE_BYTES) {
        throw new Error(`Image file too large after resizing: ${path.basename(imgPath)} (${(stats.size / 1024 / 1024).toFixed(1)}MB). Max 15MB for AI analysis.`);
      }

      const buffer = await fs.promises.readFile(finalPath);
      const ext = path.extname(finalPath).toLowerCase();
      const mimeType = IMAGE_MIME_MAP[ext] || 'image/jpeg';
      return { inlineData: { mimeType, data: buffer.toString('base64') } };
    }));

    const parts = [...imageParts, { text: prompt }];
    const raw = await callGemini(parts, apiKey, model, { signal, ...opts });
    return parseAiJson(raw);
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
  assertAttachmentPathSafe(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = DOCUMENT_MIME_MAP[ext];

  if (!mimeType) {
    // If it's a known image extension, treat as vision call
    if (IMAGE_MIME_MAP[ext]) {
      return callGeminiVision([filePath], prompt, apiKey, model, signal, opts);
    }
    // Word docs (.doc/.docx) never reach here — callLLMDocument (llm.js) intercepts
    // them upstream, extracts text via textutil, and routes through callLLMText.
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
  return parseAiJson(raw);
}

export function registerGeminiHandlers() {
  // NOTE: `ai-polish-text` used to live here. It moved to registerLlmHandlers()
  // in llm.js — it was never a Gemini feature, and keeping it here forced a
  // hand-rolled copy of the provider/model routing that had already drifted out
  // of sync with TASK_MODELS. See that handler's comment for the full story.

  // Live "Check availability" — pings the requested provider (or the active one)
  // and returns a structured verdict. For Claude this probes EVERY model the app
  // uses (claudeModelsInUse()) — Anthropic limits are per-model, so checking one
  // model (esp. the lightest) misrepresents whether a real run will hit limits —
  // and returns per-model {ok,status,rateLimit} from the response headers. For
  // Gemini also probes every compatible model so partial quota/access is visible
  // without declaring the whole provider unavailable.
  handleSafe('check-ai-availability', async (event, args) => {
    const settings = getAISettings();
    const provider = (args && args.provider) || settings.provider || 'gemini';
    let result;
    if (provider === 'claude') {
      if (!settings.anthropicApiKey) {
        result = { ok: false, models: [{ ok: false, status: null, model: null, error: 'No Anthropic API key set.' }] };
      } else {
        // Resolve the live family → model-id snapshot first. Without this, a
        // process that hasn't yet made a real Claude call (or had the Settings
        // panel's own fire-and-forget getClaudeModelMap() finish) still sits on
        // MODEL_FLOOR, so this probe would test stale pinned ids instead of the
        // model ids every real call path actually resolves to. No-ops when the
        // snapshot is already fresh (modelResolver.js), so this costs nothing
        // on the common already-primed path.
        await primeClaudeModels({ apiKey: settings.anthropicApiKey });

        // Probe all models in parallel — each is a 1-token ping (~free).
        //
        // Pass the user's live per-group family picks so a NON-DEFAULT choice
        // is actually probed. Fable access can differ (higher tier, and it can
        // 400 outright for orgs below 30-day data retention), so "it worked
        // for Sonnet" proves nothing about a selected Fable API task.
        const selectedFamilies = Object.values(settings.claudeModels || {});
        const models = await Promise.all(
          claudeModelsInUse(selectedFamilies, settings.anthropicApiKey).map((m) => probeClaude(settings.anthropicApiKey, m)),
        );
        result = { ok: models.length > 0 && models.every((m) => m.ok), models };
      }
    } else {
      // Coalesce concurrent checks so a double-click doesn't double-spend RPD.
      if (geminiCheckInFlight) {
        result = await geminiCheckInFlight;
      } else {
        geminiCheckInFlight = runGeminiAvailabilityCheck(settings);
        try { result = await geminiCheckInFlight; }
        finally { geminiCheckInFlight = null; }
      }
    }
    lastProbe[provider] = { ...result, at: Date.now() };
    return {
      provider,
      ...lastProbe[provider],
      ...(provider === 'gemini' ? { telemetry: getGeminiTelemetry() } : {}),
    };
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
