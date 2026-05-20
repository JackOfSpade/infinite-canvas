/**
 * Gemini AI service — text + vision support via Vertex AI.
 * Uses Service Account for authentication against regional endpoints.
 */
import fs from 'fs';
import path from 'path';
import { GoogleAuth } from 'google-auth-library';
import { handleSafe } from './ipcUtils.js';
import { logger } from '../logger.js';
import { resolveServiceAccountPath } from './settings.js';

const GEMINI_MODEL = 'gemini-2.5-flash';
const LOCATION = 'us-central1';

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

/**
 * fetch() wrapper with exp backoff for transient HTTP errors and network
 * failures. Returns the final Response (caller still handles non-2xx). Aborts
 * are not retried — the user/timeout asked to stop, respect that. Logs each
 * retry so bug reports show the attempt history.
 */
async function fetchWithRetry(url, init, { label = 'fetch', maxAttempts = 3, baseDelayMs = 600 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok || !TRANSIENT_HTTP_STATUSES.has(res.status) || attempt === maxAttempts) {
        return res;
      }
      // If we hit a 429 (rate limit or quota exceeded), do not retry the same model.
      // Return immediately so the outer fallback loop can progress to the next model.
      if (res.status === 429) {
        return res;
      }
      const delay = baseDelayMs * Math.pow(3, attempt - 1);
      logger.warn(`[${label}] HTTP ${res.status} (transient) — retrying in ${delay}ms (attempt ${attempt}/${maxAttempts})`);
      await new Promise(r => setTimeout(r, delay));
    } catch (err) {
      lastErr = err;
      // Don't retry aborts — caller/timeout explicitly stopped us.
      if (err?.name === 'AbortError' || init?.signal?.aborted || attempt === maxAttempts) throw err;
      const delay = baseDelayMs * Math.pow(3, attempt - 1);
      logger.warn(`[${label}] network error: ${err?.message || String(err)} — retrying in ${delay}ms (attempt ${attempt}/${maxAttempts})`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// Internal sentinel prepended to mock responses so parseGeminiJSON can tag
// the parsed object with `_mockMode: true`. Callers downstream (marketplace,
// jobs) propagate this so the UI can show "data is fake until you configure
// AI" instead of silently presenting placeholder values as real results.
const MOCK_PREFIX = '__IC_MOCK__';

let authClient = null;
let projectId = null;
let cachedKeyFile = null; // tracks which file the cached client was built from
let isMockMode = false;

async function getAuthClient() {
  const keyFile = resolveServiceAccountPath();
  // Reuse the cached client only if it was built from the same file we'd
  // resolve right now. If the user changes the path in Settings, the next
  // call rebuilds against the new account instead of silently using the old one.
  if (authClient && cachedKeyFile === keyFile) return { auth: authClient, projectId };
  authClient = null;
  projectId = null;
  cachedKeyFile = null;
  isMockMode = false;

  if (!keyFile) {
    logger.warn('[Gemini] No service-account.json configured or found. Enabling Mock Mode for AI services.');
    isMockMode = true;
    return { auth: null, projectId: 'mock-project' };
  }

  let saRaw;
  try {
    saRaw = await fs.promises.readFile(keyFile, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      logger.warn(`[Gemini] Configured service-account file not found at ${keyFile}. Enabling Mock Mode.`);
      isMockMode = true;
      return { auth: null, projectId: 'mock-project' };
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

/**
 * Inner executor for a single Gemini API request.
 */
async function callGeminiSingle(parts, apiKey, model, genConfig = {}) {
  // If an API key is provided, route directly to the free AI Studio endpoint
  // Otherwise, default to the Vertex AI service account pipeline
  let endpoint = '';
  let headers = { 'Content-Type': 'application/json' };
  
  if (apiKey) {
    endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-2.5-flash'}:generateContent?key=${apiKey}`;
  } else {
    // Ensure getAuthClient runs to check for service-account.json and set isMockMode
    await getAuthClient();

    if (isMockMode) {
      const textPart = parts.find(p => p.text)?.text || '';
      logger.info('[Gemini] Mock Mode active. Returning dummy data for prompt.');
      // Sentinel prefix lets parseGeminiJSON strip it and signal mock-ness to
      // callers without changing the return type (still a JSON string).
      return MOCK_PREFIX + generateMockResponse(textPart);
    }

    const token = await getToken();
    endpoint = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${model || GEMINI_MODEL}:generateContent`;
    headers['Authorization'] = `Bearer ${token}`;
  }

  const { signal, responseSchema, ...restGenConfig } = genConfig;

  const generationConfig = {
    temperature: 0.1,
    responseMimeType: 'application/json',
    maxOutputTokens: 2048,   // default; callers pass task-specific caps via opts
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

  const timeoutSignal = AbortSignal.timeout(60000);
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
  const contentText = candidate?.content?.parts?.[0]?.text;
  const finishReason = candidate?.finishReason;
  const usage = data?.usageMetadata;
  const cap = payload.generationConfig.maxOutputTokens;

  // Log finish reason + token usage on every call so bug reports include the signals
  logger.info(`[Gemini] finishReason=${finishReason} usage=in:${usage?.promptTokenCount ?? '?'} out:${usage?.candidatesTokenCount ?? '?'} thoughts:${usage?.thoughtsTokenCount ?? 0} cap:${cap}`);

  // MAX_TOKENS truncation produces JSON that's missing its closing braces
  if (finishReason === 'MAX_TOKENS') {
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
 * automatically falling back across the 12 available models in descending capability order
 * when rate limits or quotas are exceeded.
 * @param {Array} parts — Array of { text } or { inlineData: { mimeType, data } } objects
 * @param {string} apiKey - Optional Gemini API Key. If missing, falls back to Vertex AI.
 * @param {string} model - Ignored for Gemini calls to enforce progressive fallback.
 * @param {object} [genConfig] — generationConfig overrides
 * @returns {Promise<string>} — Raw text response from Gemini
 */
async function callGemini(parts, apiKey, model, genConfig = {}) {
  // If Mock Mode is active, we don't need fallback
  await getAuthClient();
  if (!apiKey && isMockMode) {
    const textPart = parts.find(p => p.text)?.text || '';
    logger.info('[Gemini] Mock Mode active. Returning dummy data for prompt.');
    return MOCK_PREFIX + generateMockResponse(textPart);
  }

  // Hardening: Prevent "Payload Too Large" errors by capping total prompt text.
  let totalTextLen = 0;
  for (const part of parts) {
    if (part.text) totalTextLen += part.text.length;
  }
  if (totalTextLen > 100000) {
    throw new Error(`AI prompt too large (${totalTextLen} chars). Please select fewer nodes or a smaller group.`);
  }

  const GEMINI_MODEL_FALLBACKS = [
    'gemini-3.1-pro',
    'gemini-2.5-pro',
    'gemini-3.5-flash',
    'gemini-3-flash',
    'gemini-2.5-flash',
    'gemini-2-flash',
    'gemini-3.1-flash-lite',
    'gemini-2.5-flash-lite',
    'gemini-2-flash-lite',
  ];
  // NOTE: text-to-speech (`*-tts`) models are intentionally excluded — they
  // cannot serve generateContent text/JSON output, so including them in this
  // fallback chain only burned extra failed calls before the final error.

  const attemptedErrors = [];

  for (const currentModel of GEMINI_MODEL_FALLBACKS) {
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
 * Generates a context-aware mock JSON string based on the provided prompt.
 * Ensures the app functions gracefully without Google Cloud credentials.
 */
function generateMockResponse(prompt) {
  if (prompt.includes('marketplace listing expert')) {
    return JSON.stringify({
      brand: "Mock Brand",
      model: "Mock Model 123",
      category: "Electronics > Mock Category",
      condition: "Used - Good",
      color: "Mock Color",
      notable_features: "Minor scratches on mock surface",
      generated_title: "Mock Brand Model 123 - Good Condition",
      generated_description: "This is a mock description generated because the service-account.json file is missing. Please add the file to enable real AI analysis."
    });
  }
  if (prompt.includes('pricing analyst and marketplace routing expert')) {
    return JSON.stringify({
      recommended_price: 49.99,
      quick_sell_price: 39.99,
      max_profit_price: 59.99,
      justification: "This is a mock justification generated in Mock Mode. Prices are completely arbitrary.",
      market_summary: { sold_count: 5, sold_median: 45, sold_low: 30, sold_high: 60, active_count: 3, active_lowest: 40 },
      recommended_platforms: [
        { id: "ebay", name: "eBay", reason: "High traffic for mock items.", estimated_fee_pct: 13, net_payout: 43.49 }
      ]
    });
  }
  if (prompt.includes('Analyze this resume/CV thoroughly')) {
    return JSON.stringify({
      titles: ["Senior Mock Engineer", "Mock Developer"],
      skills: ["JavaScript", "React", "Node.js", "Python"],
      experience_years: 5,
      soft_skills: ["Communication", "Leadership"],
      industries: ["Tech", "Software"],
      locations: ["Remote", "New York"],
      education: ["BS Computer Science"],
      summary: "An experienced software engineer with a background in building mock applications."
    });
  }
  if (prompt.includes('generate search queries')) {
    return JSON.stringify({
      titleQueries: ["Senior Mock Engineer remote", "Mock Developer remote"],
      suggestedRoleQueries: ["Mock Architect remote", "Lead Mock Developer"],
      skillsOnlyQueries: ["JavaScript React Python 5 years remote"]
    });
  }
  if (prompt.includes('Score each job')) {
    const match = prompt.match(/JOBS TO SCORE \(array\):\n(\[[\s\S]*?\])\n/);
    let numJobs = 1;
    if (match) {
      try { numJobs = JSON.parse(match[1]).length; } catch { /* ignore parse error */ }
    }
    const scores = Array.from({ length: numJobs }).map((_, i) => ({
      index: i,
      matchScore: Math.max(50, 95 - (i * 3)), // Descending mock scores
      reasoning: "This is mock reasoning generated in Mock Mode.",
      careerDirection: i % 2 === 0 ? "Engineering" : "Leadership",
      strengthLabel: i < 3 ? "strong" : "exploring"
    }));
    return JSON.stringify(scores);
  }
  if (prompt.includes('compelling cover letter')) {
    return JSON.stringify({
      coverLetter: "Dear Hiring Manager,\n\nI am writing to apply for this position. This is a mock cover letter generated because service-account.json is missing.\n\nSincerely,\nMock Applicant"
    });
  }
  if (prompt.includes('expert career coach preparing a candidate')) {
    return JSON.stringify({
      questions: [
        { type: "behavioral", question: "Tell me about a time you used mock data.", tip: "Highlight your problem-solving skills." },
        { type: "technical", question: "How do you implement Mock Mode?", tip: "Discuss interception of API calls." },
        { type: "company", question: "Why do you want to work here?", tip: "Reference their mission." },
        { type: "behavioral", question: "Describe a challenge you overcame.", tip: "Focus on resilience." },
        { type: "technical", question: "What is your favorite mock tool?", tip: "Be authentic." },
        { type: "company", question: "How do you align with our values?", tip: "Show you researched them." },
        { type: "behavioral", question: "Tell me about a conflict.", tip: "Use the STAR method." },
        { type: "technical", question: "Explain a complex topic simply.", tip: "Use analogies." }
      ]
    });
  }
  
  // Default JSON wrapper
  return JSON.stringify({ mock: true, message: "Generic mock response" });
}

/**
 * Parse raw Gemini response text into JSON, stripping markdown fences if present.
 * Handles both ```json and bare ``` wrappers.
 */
export function parseGeminiJSON(raw) {
  if (!raw) return null;

  // Strip the mock-mode sentinel before parsing; remember whether it was
  // present so we can tag the parsed object.
  let isMock = false;
  if (typeof raw === 'string' && raw.startsWith(MOCK_PREFIX)) {
    isMock = true;
    raw = raw.slice(MOCK_PREFIX.length);
  }

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
    // Tag mock-mode results so the UI can show "this is placeholder data"
    // instead of presenting it as a real AI response. Plain objects only —
    // arrays/primitives stay untouched (mock mode currently only returns
    // objects, but be defensive).
    if (isMock && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      parsed._mockMode = true;
    }
    return parsed;
  } catch (error) {
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

// MIME type tables — module-level so they're not re-allocated per call.
const IMAGE_MIME_MAP = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.heic': 'image/heic', '.heif': 'image/heic',
};
const DOCUMENT_MIME_MAP = {
  '.pdf':  'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt':  'text/plain',
  '.md':   'text/plain',
  '.json': 'text/plain',
  '.js':   'text/plain',
  '.py':   'text/plain',
};

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
 * Send images + text prompt to Gemini Vision.
 * @param {string[]} imagePaths — Absolute paths to image files
 * @param {string} prompt — Text prompt
 * @param {string} apiKey
 * @param {string} model
 * @returns {Promise<object>} — Parsed JSON response
 */
export async function callGeminiVision(imagePaths, prompt, apiKey, model, signal = null, opts = {}) {
  const imageParts = await Promise.all(imagePaths.map(async (imgPath) => {
    const stats = await fs.promises.stat(imgPath);
    // Vertex AI inlineData limit is 20MB. Base64 encoding adds ~33% overhead,
    // so we cap the raw file size at 15MB to be safe and provide a clear error.
    if (stats.size > 15 * 1024 * 1024) {
      throw new Error(`Image file too large: ${path.basename(imgPath)} (${(stats.size / 1024 / 1024).toFixed(1)}MB). Max 15MB for AI analysis.`);
    }

    const buffer = await fs.promises.readFile(imgPath);
    const ext = path.extname(imgPath).toLowerCase();
    const mimeType = IMAGE_MIME_MAP[ext] || 'image/jpeg';
    return { inlineData: { mimeType, data: buffer.toString('base64') } };
  }));

  const parts = [...imageParts, { text: prompt }];
  const raw = await callGemini(parts, apiKey, model, { signal, ...opts });
  return parseGeminiJSON(raw);
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
  if (stats.size > 15 * 1024 * 1024) {
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
    const { getAISettings } = await import('./settings.js');
    const settings = getAISettings();
    const model = settings.provider === 'gemini'
      ? 'gemini-2.5-flash-lite'   // matches TASK_MODELS['text-polish'].gemini
      : null;
    // If user picked Claude, polish via Claude Haiku 4.5 directly. Avoids
    // forcing them onto Gemini just for this one helper.
    if (settings.provider === 'claude') {
      const { callClaudeText } = await import('./claude.js');
      const raw = await callClaudeText(prompt, 'claude-haiku-4-5-20251001', settings.anthropicApiKey, signal, { maxTokens: 1024, expectJson: false });
      return { text: raw.trim() };
    }
    const config = { responseMimeType: 'text/plain', signal, maxOutputTokens: 1024 };
    const raw = await callGemini([{ text: prompt }], settings.geminiApiKey, model, config);
    return { text: raw.trim() };
  });
}
