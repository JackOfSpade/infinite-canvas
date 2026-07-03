import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';
import { recordTokenUsage, recordTruncation } from './tokenBudget.js';
import { IMAGE_MIME_MAP } from '../utils/mimeTypes.js';
import { buildCachedUserContent, buildAnthropicMessageParams } from './anthropicRequest.js';
import { isSensitivePath } from '../utils/pathSafety.js';

// A document/image node's filePath is sourced from loaded canvas JSON, which
// (unlike the local-file:// preview protocol) had NO path check at all before
// being read and uploaded to the Anthropic API — an untrusted/shared canvas
// could point a node at e.g. ~/.aws/credentials and have it previewed AND,
// via a normal "AI polish/analyze" action, exfiltrated to a third-party API.
function assertAttachmentPathSafe(filePath) {
  if (isSensitivePath(path.resolve(String(filePath || '')))) {
    throw new Error(`Refusing to read a sensitive system/credential path as an AI attachment: ${filePath}`);
  }
}

// Hard ceiling on the Anthropic SDK's built-in retries. The SDK already does
// exactly what we'd hand-roll for Gemini: auto-retries 408/409/429/500/503/529
// (529 = Anthropic "overloaded", the analogue of Gemini's 503) with exponential
// backoff AND natively honors the server's Retry-After / retry-after-ms headers.
// So there's nothing to add here beyond naming the ceiling — without retries a
// transient overload would bubble up as a card-level "error" the user has to
// re-click, even though the listing itself is fine.
const ANTHROPIC_MAX_RETRIES = 3;

function getAnthropicClient(apiKey) {
  if (!apiKey) throw new Error("Anthropic API key is missing. Please add it in settings.");
  return new Anthropic({ apiKey, maxRetries: ANTHROPIC_MAX_RETRIES });
}

// Normalize either a Fetch Headers (from .withResponse()) or a plain header
// object (from an SDK APIError) into a case-insensitive getter.
function headerGetter(headers) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return (k) => headers.get(k);
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[String(k).toLowerCase()] = v;
  return (k) => lower[String(k).toLowerCase()] ?? null;
}

/**
 * Pull Anthropic's per-response rate-limit headers into a structured snapshot.
 * Anthropic returns REMAINING budget on every response (and on 429 errors):
 *   anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}
 * `reset` is an ISO-8601 instant; we precompute seconds-until-reset so the
 * renderer needs no wall-clock math. These are real numbers from the API — the
 * honest "how much is left" signal, not an estimate. Returns null if absent.
 */
function parseAnthropicRateLimit(headers) {
  const get = headerGetter(headers);
  if (!get) return null;
  const toNum = (v) => (v == null || v === '' ? null : Number(v));
  const out = {};
  for (const prefix of ['requests', 'tokens', 'input-tokens', 'output-tokens']) {
    const limit = toNum(get(`anthropic-ratelimit-${prefix}-limit`));
    const remaining = toNum(get(`anthropic-ratelimit-${prefix}-remaining`));
    const reset = get(`anthropic-ratelimit-${prefix}-reset`);
    if (limit == null && remaining == null && reset == null) continue;
    const resetMs = reset ? Date.parse(reset) : NaN;
    out[prefix.replace('-', '_')] = {
      limit, remaining, reset,
      resetInSec: Number.isFinite(resetMs) ? Math.max(0, Math.round((resetMs - Date.now()) / 1000)) : null,
    };
  }
  return Object.keys(out).length ? out : null;
}

// Distinct Claude models the app actually uses across tasks — KEEP IN SYNC with
// TASK_MODELS in llm.js (declared here, not imported, to avoid a circular import:
// llm.js imports gemini.js which owns the availability handler). Ordered
// workhorse → app-gen → light. The availability probe checks EACH, because
// Anthropic rate limits are PER-MODEL: Haiku having headroom says nothing about
// whether a Sonnet scoring run or an Opus application-generation will hit limits.
export const CLAUDE_MODELS_IN_USE = [
  'claude-sonnet-4-6',          // job scoring/bucketing, resume-parse, query-gen, vision, price-synthesis, company-research
  'claude-opus-4-8',            // application résumé + cover-letter generation
  'claude-haiku-4-5-20251001',  // platform-fit, page-status, text-polish
];

/**
 * Lightweight availability probe: a 1-token ping to ONE model that reads the
 * live rate-limit headers Anthropic returns. Defaults to the Sonnet workhorse;
 * the availability handler calls it once per CLAUDE_MODELS_IN_USE entry so each
 * model's per-model limits are surfaced. NEVER throws — returns a structured
 * {ok,status,model,rateLimit,error} so the Settings panel can render a verdict
 * (the rate-limit numbers are straight from the response headers).
 */
export async function probeClaude(apiKey, model = 'claude-sonnet-4-6') {
  if (!apiKey) return { ok: false, status: null, model, error: 'No Anthropic API key set.' };
  try {
    const anthropic = getAnthropicClient(apiKey);
    const { response } = await anthropic.messages.create({
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    }).withResponse();
    return { ok: true, status: response.status ?? 200, model, rateLimit: parseAnthropicRateLimit(response.headers) };
  } catch (err) {
    // The SDK's APIError carries .status and (usually) .headers even on 429/401,
    // so a rate-limited probe still surfaces remaining/reset.
    return { ok: false, status: err?.status ?? null, model, error: err?.message || String(err), rateLimit: err?.headers ? parseAnthropicRateLimit(err.headers) : null };
  }
}

// "2" → 2, "4.5" → 4.5, "moderate" → "moderate". Used when pulling a value out
// of leaked tool-call XML, which always arrives as a string even for an integer
// field — so the rebuilt object matches the schema's numeric types.
function coerceScalar(s) {
  const t = String(s).trim();
  if (t === '') return t;
  const n = Number(t);
  return Number.isFinite(n) && String(n) === t ? n : t;
}

/**
 * Repair a model-emitted tool-use `input` against its schema. Tool-use forces a
 * tool CALL but does NOT strictly validate the input the model fills in: for a
 * NESTED object property the model can fumble the nesting, leaking the inner
 * fields up to the parent level and/or dumping raw tool-call XML
 * (`<parameter name="x">v`) into a string value. Observed in a price-synthesis
 * call where `comp_breakdown` arrived as
 *   comp_breakdown: "\n<parameter name=\"anchor_count\">2", adjusted_count: 4, bound_count: 4
 * instead of { anchor_count: 2, adjusted_count: 4, bound_count: 4 } — which made
 * the downstream consumer read 0/0/0 and report a "thin anchor base" that was
 * never real.
 *
 * Walks the schema and, for each object-typed property that did NOT arrive as a
 * plain object, reconstructs it from (a) `<parameter name="k">v` pairs embedded
 * in the malformed value and (b) the property's own sub-keys that leaked to this
 * level (only keys not legitimately defined at this level, so a real sibling is
 * never stolen). Schema-driven → repairs ANY structured-output call, and a no-op
 * when the input is already well-formed. Returns whether anything was repaired.
 */
function repairToolInput(value, schema, repaired = { count: 0 }) {
  if (!schema || typeof value !== 'object' || value === null) return repaired;
  if (schema.type === 'object' && schema.properties) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (!sub) continue;
      if (sub.type === 'object' && sub.properties) {
        const current = value[key];
        if (current && typeof current === 'object' && !Array.isArray(current)) {
          repairToolInput(current, sub, repaired); // already an object — recurse for deeper nesting
          continue;
        }
        const rebuilt = {};
        if (typeof current === 'string') {
          for (const m of current.matchAll(/<parameter\s+name="([^"]+)">\s*([^<]*)/g)) {
            rebuilt[m[1]] = coerceScalar(m[2]);
          }
        }
        for (const subKey of Object.keys(sub.properties)) {
          if (subKey in rebuilt) continue;
          // Only adopt a leaked field — one that belongs to the sub-object but
          // isn't a legitimate property at this level.
          if (subKey in value && !(subKey in schema.properties)) {
            rebuilt[subKey] = value[subKey];
            delete value[subKey];
          }
        }
        if (Object.keys(rebuilt).length > 0) {
          value[key] = rebuilt;
          repaired.count++;
        }
      } else if (sub.type === 'array' && sub.items && Array.isArray(value[key])) {
        for (const el of value[key]) repairToolInput(el, sub.items, repaired);
      }
    }
  }
  return repaired;
}

/**
 * Send a request and, if `expectJson` is true, pre-fill the assistant turn
 * with `{` so Claude continues straight into JSON instead of preambling
 * ("Sure, here's the JSON…"). Pre-prepends `{` to the returned text so the
 * caller still gets a valid JSON string.
 *
 * Saves a handful of output tokens per call and makes downstream parsing
 * more reliable (no `Sure!`-style chatter to strip).
 */
async function createMessage(anthropic, userContent, { model, maxTokens, formulaSeed, signal, expectJson, responseSchema, cachedPrefix, task, grounding }) {
  // Build the shared Anthropic request shape — cache_control prefix block +
  // tool-use schema (forces the submit_response tool) or JSON-prefill ('{').
  // Extracted to anthropicRequest.js so the async Message Batches path and the
  // free token-count preflight build the IDENTICAL request (see its doc).
  // `expectJson && !grounding` so a grounding call (layered on below) keeps
  // priority over the JSON-prefill — preserving the original branch precedence
  // responseSchema > grounding > expectJson.
  const params = buildAnthropicMessageParams(userContent, {
    model, maxTokens, responseSchema, cachedPrefix, expectJson: expectJson && !grounding,
  });
  if (grounding && !responseSchema) {
    // Server-side web search: Anthropic runs the searches during this single
    // streamed turn and returns the synthesized answer in text blocks. Free
    // text (no JSON prefill, no schema) — the caller wants prose research.
    // max_uses=8 lets it actually dig (company + products + culture + recent
    // news + role context) rather than stopping at a shallow first hit; this is
    // a deliberate, user-triggered action where research depth IS the value.
    // Carries its own per-search billing.
    params.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }];
  }
  // Stream rather than the one-shot `.create()`. With our high per-task caps
  // (job-bucketing provisions up to ~24576 output tokens) a single non-streaming
  // request can exceed the SDK's 10-minute non-streaming guard and is rejected
  // outright with "Streaming is required for operations that may take longer
  // than 10 minutes" — which is exactly what broke job-bucketing on Claude.
  // `.finalMessage()` accumulates the SSE stream into the identical Message
  // shape (content/tool_use blocks, usage incl. cache_read/creation tokens,
  // stop_reason), so every downstream read below is unchanged. The AbortSignal
  // is honored the same way via the request options arg.
  const response = await anthropic.messages.stream(params, { signal }).finalMessage();

  const stopReason = response.stop_reason;
  const usage = response.usage;
  // Same diagnostic pattern as Gemini: log stop_reason + token usage on every
  // call so bug reports can distinguish a hit max_tokens cap from a model
  // refusal or a genuine model bug. Previously the only signal was the
  // downstream JSON parse failure ("Unterminated string at pos 701"), which
  // sent the user debugging JSON syntax instead of the real cause.
  // Cache fields (cache_creation_input_tokens, cache_read_input_tokens) only
  // appear when ephemeral caching is in play; surface them so a flat-rate
  // cost spike or zero hit-rate is debuggable from the log alone.
  const cacheRead = usage?.cache_read_input_tokens;
  const cacheWrite = usage?.cache_creation_input_tokens;
  const cacheTag = (cacheRead || cacheWrite)
    ? ` cache:read=${cacheRead ?? 0}/write=${cacheWrite ?? 0}`
    : '';
  logger.info(`[Claude] stop_reason=${stopReason} usage=in:${usage?.input_tokens ?? '?'} out:${usage?.output_tokens ?? '?'} cap:${maxTokens}${responseSchema ? ' (tool-use)' : ''}${cacheTag}`);

  // Feed the self-calibrating token budget (output_tokens is the billable
  // output; a max_tokens stop records a sample at the cap so the budget grows
  // next call — recorded before the truncation throw below for that self-heal).
  recordTokenUsage(task, usage?.output_tokens || 0);

  if (stopReason === 'max_tokens') {
    // Censored signal: real demand exceeded the cap. Record it so effectiveCap
    // provisions past this cap on the next call (bypasses MIN_SAMPLES).
    recordTruncation(task, maxTokens, formulaSeed);
    throw new Error(`AI response was truncated — hit the ${maxTokens}-token output cap (model wrote ${usage?.output_tokens ?? 'unknown'} tokens before being cut off). Try with fewer/smaller inputs, or raise the cap for this task in llm.js TASK_MAX_TOKENS.`);
  }

  // Backstop for the preflight (checkPromptFits): on Claude 4.5+ an oversized
  // request isn't rejected — generation runs until it hits the window and stops
  // with `model_context_window_exceeded`, yielding truncated/empty content. The
  // token-count preflight should prevent this, but if a count under-estimated,
  // fail loudly with an actionable message instead of returning a partial answer.
  if (stopReason === 'model_context_window_exceeded') {
    throw new Error(`AI response stopped — the prompt plus its reserved output exceeded ${model}'s context window (input ${usage?.input_tokens ?? '?'} tok + up to ${maxTokens} output). Send fewer/smaller inputs for task '${task || 'unknown'}'.`);
  }

  // Web-search (grounding) response: the answer is spread across one or more
  // `text` blocks, interleaved with server_tool_use / web_search_tool_result
  // blocks. Concatenate the text blocks into the final prose; ignore the
  // tool-result blocks (they're the raw search payloads the model already
  // synthesized from).
  if (grounding) {
    const txt = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();
    if (!txt) throw new Error(`Claude web-search returned no text (stop_reason=${stopReason || 'unknown'}).`);
    return txt;
  }

  // Tool-use response: pull the tool_use block's `input`, repair any nested
  // object the model mis-emitted (leaked fields / tool-call XML in a string),
  // then re-stringify so the shared parseGeminiJSON downstream can JSON.parse it
  // like any other JSON.
  if (responseSchema) {
    const toolBlock = response.content.find(b => b.type === 'tool_use');
    if (!toolBlock) {
      throw new Error(`Claude tool-use response missing tool_use block (stop_reason=${stopReason || 'unknown'}).`);
    }
    const { count } = repairToolInput(toolBlock.input, responseSchema);
    if (count > 0) {
      // Surface the repair so a bug report shows the model emitted non-conforming
      // structured output (rather than the silent 0/0/0 it used to produce).
      logger.warn(`[Claude] Repaired ${count} malformed nested field(s) in tool input for task '${task || 'unknown'}' — model leaked sub-fields/param-XML instead of nesting them.`);
    }
    return JSON.stringify(toolBlock.input);
  }

  const text = response.content[0]?.text;
  if (!text) throw new Error(`No content returned from Claude (stop_reason=${stopReason || 'unknown'}).`);
  if (!expectJson) return text;
  // We prefilled the assistant turn with '{', so Claude's continuation omits
  // the leading brace — prepend it back. Guard the rare case where the model
  // echoes the brace anyway: a naive '{' + text would yield invalid '{{…' that
  // the downstream JSON parser (indexOf('{') based) can't repair.
  return text.trimStart().startsWith('{') ? text : '{' + text;
}

export async function callClaudeText(prompt, model, apiKey, signal, { maxTokens = 2048, formulaSeed = null, expectJson = false, responseSchema = null, cachedPrefix = null, task = null, grounding = false } = {}) {
  const anthropic = getAnthropicClient(apiKey);
  return createMessage(anthropic, prompt, { model, maxTokens, formulaSeed, signal, expectJson, responseSchema, cachedPrefix, task, grounding });
}

/**
 * Count the input tokens a text message would consume, via Anthropic's FREE
 * `messages.count_tokens` endpoint (separate rate limits, no billing). The
 * message shape mirrors createMessage exactly — cached-prefix block + prompt,
 * plus the tool definition when a responseSchema is in play — so the count
 * matches what the real call would send. Returns the integer `input_tokens`.
 * Used by the preflight (checkPromptFits) to size/split prompts before sending.
 */
export async function countClaudeInputTokens(prompt, model, apiKey, { cachedPrefix = null, responseSchema = null, signal = null } = {}) {
  const anthropic = getAnthropicClient(apiKey);
  // Same content + tool envelope the real call sends (shared builder) so the
  // count is exact. count_tokens ignores max_tokens/tool_choice and the
  // cache_control marker doesn't change the token count, so we pass only the
  // pieces the endpoint accepts.
  const params = { model, messages: [{ role: 'user', content: buildCachedUserContent(prompt, cachedPrefix) }] };
  if (responseSchema) {
    params.tools = [{ name: 'submit_response', description: 'Submit the structured response.', input_schema: responseSchema }];
  }
  const res = await anthropic.messages.countTokens(params, { signal });
  return res?.input_tokens ?? 0;
}

export async function callClaudeVision(imagePaths, prompt, model, apiKey, signal, { maxTokens = 2048, formulaSeed = null, expectJson = false, responseSchema = null, task = null } = {}) {
  const anthropic = getAnthropicClient(apiKey);
  const tempFiles = [];

  // Outer try/finally so partial HEIC conversion or downscale successes
  // (e.g. 4 of 7 succeed, then the 5th fails) still clean up their temp
  // files instead of leaking until the OS clears /var/folders.
  try {
    const contentParts = await Promise.all(imagePaths.map(async (imgPath) => {
      assertAttachmentPathSafe(imgPath);
      let finalPath = imgPath;

      // Normalize any non-vision-safe format (HEIC/HEIF/TIFF/JXL/AVIF/BMP/SVG/…)
      // to JPEG — Claude accepts only jpeg/png/gif/webp, so a dropped TIFF or
      // iPhone HEIC would otherwise be rejected. No-op for already-safe formats.
      const { ensureVisionSafeImage, downscaleImageIfNeeded } = await import('./heicUtils.js');
      const safe = await ensureVisionSafeImage(imgPath);
      if (safe !== imgPath) {
        finalPath = safe;
        tempFiles.push(finalPath);
      }

      // Claude charges per ~1568x1568 image tile (~1600 input tokens). A
      // typical phone photo is ~4032px on the long side → 4 tiles → ~6400
      // tokens per image. Downscale to 768px on the long side first (fits
      // in one tile, ~260 tokens) — 6x cheaper per image with no impact on
      // brand/model/condition identification at this scale. Gemini sidesteps
      // this; its vision input is flat-rate per image.
      const scaled = await downscaleImageIfNeeded(finalPath, { maxLongSide: 768 });
      if (scaled !== finalPath) {
        tempFiles.push(scaled);
        finalPath = scaled;
      }

      const buffer = await fs.promises.readFile(finalPath);
      const ext = path.extname(finalPath).toLowerCase();
      const mimeType = IMAGE_MIME_MAP[ext] || 'image/jpeg';

      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: mimeType,
          data: buffer.toString('base64')
        }
      };
    }));

    const userContent = [...contentParts, { type: 'text', text: prompt }];
    return await createMessage(anthropic, userContent, { model, maxTokens, formulaSeed, signal, expectJson, responseSchema, task });
  } finally {
    if (tempFiles.length > 0) {
      const { cleanupTempFile } = await import('./heicUtils.js');
      await Promise.all(tempFiles.map(f => cleanupTempFile(f)));
    }
  }
}

export async function callClaudeDocument(filePath, prompt, model, apiKey, signal, { maxTokens = 2048, formulaSeed = null, expectJson = false, responseSchema = null, task = null } = {}) {
  assertAttachmentPathSafe(filePath);
  const ext = path.extname(filePath).toLowerCase();

  if (IMAGE_MIME_MAP[ext]) {
    return callClaudeVision([filePath], prompt, model, apiKey, signal, { maxTokens, formulaSeed, expectJson, responseSchema, task });
  }

  // Word docs (.doc/.docx) never reach here — callLLMDocument (llm.js) intercepts
  // them upstream, extracts text via textutil, and routes through callLLMText.

  // Claude API requires standard pdf extraction. For text formats, we read as utf8.
  if (ext === '.pdf') {
    const buffer = await fs.promises.readFile(filePath);
    const anthropic = getAnthropicClient(apiKey);
    const userContent = [
      {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: buffer.toString('base64')
        }
      },
      { type: 'text', text: prompt }
    ];
    return createMessage(anthropic, userContent, { model, maxTokens, formulaSeed, signal, expectJson, responseSchema, task });
  }

  const textContent = await fs.promises.readFile(filePath, 'utf8');
  // Forward `task` so recordTokenUsage captures this call's output-token sample
  // (the image/PDF branches above already do — text files were silently dropped).
  return callClaudeText(`${prompt}\n\n[Attached File: ${path.basename(filePath)}]\n${textContent}`, model, apiKey, signal, { maxTokens, formulaSeed, expectJson, responseSchema, task });
}

// ── Message Batches API (async, ~50% cheaper) ──────────────────────────────
// The batch request shape comes from the SAME buildAnthropicMessageParams the
// synchronous path uses (see anthropicRequest.js), so a batched scoring request
// is structurally guaranteed to score identically to a live one — no
// hand-mirrored copy to drift. Grounding/streaming is live-only and not used
// for batched scoring, so the shared builder covers the batch path exactly.

/**
 * Submit a Message Batch. `requests` = [{ customId, userContent, model,
 * maxTokens, responseSchema, cachedPrefix, expectJson }]. Returns the batch id +
 * status; results are fetched later via getClaudeBatchResults.
 */
export async function createClaudeBatch(apiKey, requests) {
  const anthropic = getAnthropicClient(apiKey);
  const body = {
    requests: requests.map(r => ({
      custom_id: r.customId,
      params: buildAnthropicMessageParams(r.userContent, {
        model: r.model, maxTokens: r.maxTokens, responseSchema: r.responseSchema,
        cachedPrefix: r.cachedPrefix, expectJson: r.expectJson,
      }),
    })),
  };
  const batch = await anthropic.messages.batches.create(body);
  logger.info(`[Claude] Created message batch ${batch.id} (${requests.length} request(s)) — status=${batch.processing_status}`);
  return { id: batch.id, status: batch.processing_status, counts: batch.request_counts };
}

/** Poll a batch's processing status (no result download). */
export async function getClaudeBatch(apiKey, batchId) {
  const anthropic = getAnthropicClient(apiKey);
  const batch = await anthropic.messages.batches.retrieve(batchId);
  return { id: batch.id, status: batch.processing_status, counts: batch.request_counts, endedAt: batch.ended_at };
}

/** Best-effort cancel (stops billing for not-yet-started requests). */
export async function cancelClaudeBatch(apiKey, batchId) {
  const anthropic = getAnthropicClient(apiKey);
  try { await anthropic.messages.batches.cancel(batchId); }
  catch (e) { logger.warn(`[Claude] Batch cancel failed for ${batchId}: ${e?.message || e}`); }
}

/**
 * Download batch results → { [custom_id]: { ok, text|null, error|null } }.
 * For tool-use responses, `text` is JSON.stringify(tool_use.input) — the same
 * string shape callClaudeText returns, so the caller parses it identically.
 */
export async function getClaudeBatchResults(apiKey, batchId) {
  const anthropic = getAnthropicClient(apiKey);
  const out = {};
  const results = await anthropic.messages.batches.results(batchId);
  for await (const entry of results) {
    const customId = entry.custom_id;
    const result = entry.result;
    if (result?.type !== 'succeeded') {
      out[customId] = { ok: false, text: null, error: result?.type || 'unknown' };
      continue;
    }
    const msg = result.message;
    const toolBlock = msg?.content?.find(b => b.type === 'tool_use');
    if (toolBlock) {
      out[customId] = { ok: true, text: JSON.stringify(toolBlock.input), error: null };
    } else {
      const txt = msg?.content?.find(b => b.type === 'text')?.text;
      out[customId] = txt ? { ok: true, text: txt, error: null } : { ok: false, text: null, error: 'empty' };
    }
  }
  return out;
}
