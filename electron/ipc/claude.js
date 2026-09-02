import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';
import { recordTokenUsage, recordTruncation } from './tokenBudget.js';
import { IMAGE_MIME_MAP } from '../utils/mimeTypes.js';
import { buildAnthropicMessageParams, buildAnthropicTokenCountParams } from './anthropicRequest.js';
import { assertAttachmentPathSafe } from '../utils/pathSafety.js';
import { claudeModelFor, claudeModelsInUse, CLAUDE_FAMILY } from './modelResolver.js';
import { appendGroundedSourceAppendix } from './groundedSourceAppendix.js';
import { recordClaudeCacheUsage } from './claudeCacheTelemetry.js';
import { assertResponseMatchesSchema, canonicalizeResponseSchemaEnums } from './schemaValidation.js';

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

// Distinct Claude models the app actually uses across tasks — re-exported
// from modelResolver.js (the resolver-driven replacement for the old literal
// CLAUDE_MODEL_IDS list) so every existing importer of "the models in use"
// has one place to go. The availability probe checks EACH, because Anthropic
// rate limits are PER-MODEL: Haiku having headroom says nothing about whether
// a Sonnet scoring run or another selected live API task will hit limits.
export { claudeModelsInUse };

/**
 * Lightweight availability probe: a 1-token ping to ONE model that reads the
 * live rate-limit headers Anthropic returns. Defaults to the resolved Sonnet
 * workhorse (evaluated fresh per call — a default parameter expression runs
 * on every invocation that omits the arg, so this always reads the CURRENT
 * snapshot rather than a value captured at import time); the availability
 * handler calls it once per claudeModelsInUse() entry so each model's
 * per-model limits are surfaced. NEVER throws — returns a structured
 * {ok,status,model,rateLimit,error} so the Settings panel can render a verdict
 * (the rate-limit numbers are straight from the response headers).
 */
export async function probeClaude(apiKey, model = claudeModelFor(CLAUDE_FAMILY.SONNET, apiKey)) {
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

/**
 * Which `web_search` tool version to send for `model`.
 *
 * The `_20260209` variant adds DYNAMIC FILTERING — Anthropic runs code
 * server-side to filter search results before they reach the context window,
 * which is a straight accuracy + token-efficiency win for grounded API calls.
 * It is supported on Opus 4.6+ and Sonnet
 * 4.6+ ONLY; sending it to an older model — or to Haiku, which never got it —
 * is a 400.
 *
 * We can't hard-code either one: the model id here comes from the live family
 * resolver (modelResolver.js), so it changes generation on its own. Hence a
 * capability check rather than a constant. Anything we can't positively
 * identify as new enough falls back to the basic `_20250305` variant, which
 * every model still accepts — the safe direction, since the cost of guessing
 * wrong upward is a hard 400 on the user's résumé research.
 */
export function webSearchToolType(model) {
  const id = String(model || '');
  // Opus/Sonnet at generation 4.6 or newer, in either the `4-6`/`4-7`/`4-8`
  // form or the bare-major `5`/`6`/... form the current ids use.
  const modern = /^claude-(opus|sonnet)-(?:4-(?:[6-9]|\d\d)|[5-9]|\d\d)/.test(id);
  return modern ? 'web_search_20260209' : 'web_search_20250305';
}

/**
 * Preserve only the public source fields Claude returns beside grounded prose.
 * Search result blocks also carry encrypted_content; it is intentionally never
 * read, copied, or appended here.
 */
export function formatClaudeGroundedResponse(content) {
  const blocks = Array.isArray(content) ? content : [];
  const prose = blocks
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
  const sources = [];
  for (const block of blocks) {
    if (block?.type === 'text') {
      for (const citation of Array.isArray(block.citations) ? block.citations : []) {
        if (citation?.type === 'web_search_result_location') {
          sources.push({ url: citation.url, title: citation.title });
        }
      }
      continue;
    }
    if (block?.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue;
    for (const result of block.content) {
      if (result?.type === 'web_search_result') {
        sources.push({ url: result.url, title: result.title });
      }
    }
  }
  return appendGroundedSourceAppendix(prose, sources);
}

async function createMessage(anthropic, userContent, { model, maxTokens, formulaSeed, signal, responseSchema, cachedPrefix, task, grounding }) {
  // The Messages API cannot simultaneously return citation-bearing web-search
  // content and a constrained JSON-output response.  No public LLM entry point
  // intentionally combines them, so fail before billing rather than silently
  // dropping the requested research tool below.
  if (grounding && responseSchema) {
    const error = new Error(`Claude grounding and structured output cannot be combined for task '${task || 'unknown'}'. Run the grounded research pass before the structured extraction pass.`);
    error.code = 'CLAUDE_GROUNDING_STRUCTURED_OUTPUT_CONFLICT';
    throw error;
  }
  // Build the shared Anthropic request shape — cache_control prefix block +
  // native JSON output schema. Extracted to
  // anthropicRequest.js so the async Message Batches path and the free
  // token-count preflight build the IDENTICAL request (see its doc).
  const params = buildAnthropicMessageParams(userContent, {
    model, maxTokens, responseSchema, cachedPrefix,
  });
  if (grounding && !responseSchema) {
    // Server-side web search: Anthropic runs the searches during this single
    // streamed turn and returns the synthesized answer in text blocks. Free
    // text (no JSON prefill, no schema) — the caller wants prose research.
    // max_uses=8 lets it actually dig (company + products + culture + recent
    // news + role context) rather than stopping at a shallow first hit; this is
    // a deliberate, user-triggered action where research depth IS the value.
    // Carries its own per-search billing.
    params.tools = [{ type: webSearchToolType(model), name: 'web_search', max_uses: 8 }];
  }
  // Stream rather than the one-shot `.create()`. With our high per-task caps,
  // a single non-streaming
  // request can exceed the SDK's 10-minute non-streaming guard and is rejected
  // outright with "Streaming is required for operations that may take longer
  // than 10 minutes".
  // `.finalMessage()` accumulates the SSE stream into the identical Message
  // shape (content blocks, usage incl. cache_read/creation tokens,
  // stop_reason), so every downstream read below is unchanged. The AbortSignal
  // is honored the same way via the request options arg.
  const response = await anthropic.messages.stream(params, { signal }).finalMessage();

  const stopReason = response.stop_reason;
  const usage = response.usage;
  // Keep durable-in-session visibility into cache writes/hits. This records
  // before stop-reason validation so truncated calls remain visible in cost
  // diagnostics too; Anthropic's input_tokens excludes cache-read tokens.
  recordClaudeCacheUsage({ task, model, cachedPrefix, usage });
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
  logger.info(`[Claude] stop_reason=${stopReason} usage=in:${usage?.input_tokens ?? '?'} out:${usage?.output_tokens ?? '?'} cap:${maxTokens}${responseSchema ? ' (structured-output)' : ''}${cacheTag}`);

  // Feed the self-calibrating token budget (output_tokens is the billable
  // output; a max_tokens stop records a sample at the cap so the budget grows
  // next call — recorded before the truncation throw below for that self-heal).
  recordTokenUsage(task, usage?.output_tokens || 0);

  if (stopReason === 'max_tokens') {
    // Censored signal: real demand exceeded the cap. Record it so effectiveCap
    // provisions past this cap on the next call (bypasses MIN_SAMPLES).
    recordTruncation(task, maxTokens, formulaSeed);
    const err = new Error(`AI response was truncated — hit the ${maxTokens}-token output cap (model wrote ${usage?.output_tokens ?? 'unknown'} tokens before being cut off). Try with fewer/smaller inputs, or raise the cap for this task in llm.js TASK_MAX_TOKENS.`);
    // Structured tag (gemini.js sets the same one) so the llm.js caller can act
    // on the raised cap recordTruncation just persisted without pattern-matching
    // a human-readable message that is free to change.
    err.code = 'MAX_TOKENS';
    throw err;
  }

  // Backstop for the preflight (checkPromptFits): on Claude 4.5+ an oversized
  // request isn't rejected — generation runs until it hits the window and stops
  // with `model_context_window_exceeded`, yielding truncated/empty content. The
  // token-count preflight should prevent this, but if a count under-estimated,
  // fail loudly with an actionable message instead of returning a partial answer.
  if (stopReason === 'model_context_window_exceeded') {
    throw new Error(`AI response stopped — the prompt plus its reserved output exceeded ${model}'s context window (input ${usage?.input_tokens ?? '?'} tok + up to ${maxTokens} output). Send fewer/smaller inputs for task '${task || 'unknown'}'.`);
  }

  // A constrained grammar guarantees the shape of a completed answer, not that
  // Claude will answer at all. Do not let a refusal become an opaque downstream
  // JSON parse error (or a silent placeholder in a legacy batch reconciliation).
  if (stopReason === 'refusal') {
    const error = new Error(`Claude refused the request for task '${task || 'unknown'}'.`);
    error.code = 'CLAUDE_REFUSAL';
    throw error;
  }

  // `pause_turn` is explicitly incomplete: Anthropic requires callers to send
  // the returned assistant content back in a continuation request.  This app
  // has no continuation protocol for one-shot structured calls, and returning
  // a partial JSON/prose result here would make it look complete downstream.
  if (stopReason === 'pause_turn') {
    const error = new Error(`Claude paused before completing task '${task || 'unknown'}'; the partial response was discarded. Retry the task.`);
    error.code = 'CLAUDE_PAUSE_TURN';
    throw error;
  }

  // Web-search (grounding) response: the answer is spread across one or more
  // `text` blocks, interleaved with server_tool_use / web_search_tool_result
  // blocks. Keep the prose plus public URLs from text citations / result
  // metadata so the structured extraction pass can verify its sources.
  if (grounding) {
    const txt = formatClaudeGroundedResponse(response.content);
    if (!txt) throw new Error(`Claude web-search returned no text (stop_reason=${stopReason || 'unknown'}).`);
    return txt;
  }

  // Native Structured Outputs returns JSON in text blocks. Validate against
  // the original response schema here before preserving the normal string
  // contract for the shared parser downstream.
  if (responseSchema) {
    const json = (response.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (!json) throw new Error(`Claude structured-output response missing JSON text (stop_reason=${stopReason || 'unknown'}).`);
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch (cause) {
      const error = new Error(`Claude returned invalid JSON for structured output on task '${task || 'unknown'}': ${cause?.message || cause}.`);
      error.code = 'STRUCTURED_OUTPUT_INVALID_JSON';
      throw error;
    }
    // Claude's documented structured-output enum/const exception permits
    // casing drift. Canonicalize a unique case-insensitive match back to the
    // schema spelling before local validation and application parsing.
    parsed = canonicalizeResponseSchemaEnums(parsed, responseSchema);
    assertResponseMatchesSchema(parsed, responseSchema, { provider: 'Claude', task });
    return JSON.stringify(parsed);
  }

  // Thinking-enabled models commonly put a thinking block before their text
  // block. Reading only content[0] therefore turns a valid answer into a
  // misleading "No content" error. Concatenate all text blocks, as the
  // grounding branch above already does; this also handles an empty refusal
  // safely and preserves multi-part text responses.
  const text = (response.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
  if (!text) throw new Error(`No content returned from Claude (stop_reason=${stopReason || 'unknown'}).`);
  // Prose callers deliberately receive the text verbatim. Structured callers
  // have returned above after native JSON-schema validation.
  return text;
}

export async function callClaudeText(prompt, model, apiKey, signal, { maxTokens = 2048, formulaSeed = null, responseSchema = null, cachedPrefix = null, task = null, grounding = false } = {}) {
  const anthropic = getAnthropicClient(apiKey);
  return createMessage(anthropic, prompt, { model, maxTokens, formulaSeed, signal, responseSchema, cachedPrefix, task, grounding });
}

/**
 * Count the input tokens a text message would consume, via Anthropic's FREE
 * `messages.count_tokens` endpoint (separate rate limits, no billing). The
 * message shape mirrors createMessage exactly — cached-prefix block + prompt,
 * plus the output format when a responseSchema is in play — so the count
 * matches what the real call would send. Returns the integer `input_tokens`.
 * Used by the preflight (checkPromptFits) to size/split prompts before sending.
 */
export async function countClaudeInputTokens(prompt, model, apiKey, { cachedPrefix = null, responseSchema = null, signal = null } = {}) {
  const anthropic = getAnthropicClient(apiKey);
  // Build from the exact same source as live + batch calls. The count endpoint
  // omits only max_tokens and keeps output_config.format in sync with the
  // corresponding live request.
  const params = buildAnthropicTokenCountParams(prompt, {
    model,
    maxTokens: 1,
    responseSchema,
    cachedPrefix,
  });
  const res = await anthropic.messages.countTokens(params, { signal });
  return res?.input_tokens ?? 0;
}

export async function callClaudeVision(imagePaths, prompt, model, apiKey, signal, { maxTokens = 2048, formulaSeed = null, responseSchema = null, task = null } = {}) {
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
    return await createMessage(anthropic, userContent, { model, maxTokens, formulaSeed, signal, responseSchema, task });
  } finally {
    if (tempFiles.length > 0) {
      const { cleanupTempFile } = await import('./heicUtils.js');
      await Promise.all(tempFiles.map(f => cleanupTempFile(f)));
    }
  }
}

export async function callClaudeDocument(filePath, prompt, model, apiKey, signal, { maxTokens = 2048, formulaSeed = null, responseSchema = null, task = null } = {}) {
  assertAttachmentPathSafe(filePath);
  const ext = path.extname(filePath).toLowerCase();

  if (IMAGE_MIME_MAP[ext]) {
    return callClaudeVision([filePath], prompt, model, apiKey, signal, { maxTokens, formulaSeed, responseSchema, task });
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
    return createMessage(anthropic, userContent, { model, maxTokens, formulaSeed, signal, responseSchema, task });
  }

  const textContent = await fs.promises.readFile(filePath, 'utf8');
  // Forward `task` so recordTokenUsage captures this call's output-token sample
  // (the image/PDF branches above already do — text files were silently dropped).
  return callClaudeText(`${prompt}\n\n[Attached File: ${path.basename(filePath)}]\n${textContent}`, model, apiKey, signal, { maxTokens, formulaSeed, responseSchema, task });
}

// ── Legacy Message Batches recovery ───────────────────────────────────────
// Submission was removed with economy scoring. These readers remain only so
// previously paid work can finish safely after an app update.
/** Poll a legacy batch's processing status (no result download). */
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
 * For legacy tool-use responses, `text` is JSON.stringify(tool_use.input).
 * Native JSON-output responses use their text blocks directly. Both return the
 * same JSON-string shape callClaudeText returns, so callers parse identically.
 *
 * A batch item can be `result.type === 'succeeded'` (the request itself
 * completed) while still having hit its per-item max_tokens cap mid-response —
 * the live path (createMessage above) treats that stop_reason as fatal and
 * throws rather than returning a partial tool_use.input/text; this path must
 * match, or a truncated score/ledger/etc. silently reconciles as a complete
 * result instead of the caller's null/placeholder fallback.
 *
 * `task` + `capsByCustomId` ({ [customId]: { cap, seed } }) feed the SAME
 * self-calibrating budget the live path feeds. They must come from the caller's
 * PERSISTED record of the submit, not from re-resolving here: a batch can end up
 * to 24h later and across an app restart, so the cap each item was actually sent
 * with no longer exists in memory. Both are optional — the tokenBudget helpers
 * no-op on a falsy task, so a sidecar written before this existed stays inert.
 */
export async function getClaudeBatchResults(apiKey, batchId, { task = null, capsByCustomId = null } = {}) {
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
    // Mirrors createMessage's ordering: the usage sample is recorded BEFORE the
    // truncation check, so a batch that hit its cap is itself a sample at the
    // cap. Batched items never pass through createMessage, so without this an
    // legacy batch contributes zero samples and keeps truncating at the
    // identical cap on every run.
    recordTokenUsage(task, msg?.usage?.output_tokens || 0);
    // Same two stop reasons createMessage() treats as fatal on the live path
    // (see its comments above) — a batched item can "succeed" at the
    // batch-request level while its own generation was cut short.
    if (msg?.stop_reason === 'max_tokens') {
      // Censored signal, exactly as on the live path. The cap comes from the
      // submit record because output_tokens only reports what was produced
      // before the cut-off, which understates the cap for a thinking-heavy item.
      const rec = capsByCustomId?.[customId];
      recordTruncation(task, rec?.cap || msg?.usage?.output_tokens || 0, rec?.seed ?? null);
      out[customId] = { ok: false, text: null, error: 'max_tokens (truncated)' };
      continue;
    }
    if (msg?.stop_reason === 'model_context_window_exceeded') {
      // Deliberately NO recordTruncation: the INPUT plus its reserved output
      // overran the window. Raising the output cap shrinks the input budget
      // further, so treating this as cap-too-low evidence makes it worse.
      out[customId] = { ok: false, text: null, error: 'model_context_window_exceeded (truncated)' };
      continue;
    }
    if (msg?.stop_reason === 'refusal') {
      out[customId] = { ok: false, text: null, error: 'refusal' };
      continue;
    }
    const toolBlock = msg?.content?.find(b => b.type === 'tool_use');
    if (toolBlock) {
      out[customId] = { ok: true, text: JSON.stringify(toolBlock.input), error: null };
      continue;
    }
    const txt = (msg?.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    out[customId] = txt ? { ok: true, text: txt, error: null } : { ok: false, text: null, error: 'empty' };
  }
  return out;
}
