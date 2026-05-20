import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';
import { recordTokenUsage } from './tokenBudget.js';

const IMAGE_MIME_MAP = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.heic': 'image/heic', '.heif': 'image/heic',
};

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

/**
 * Send a request and, if `expectJson` is true, pre-fill the assistant turn
 * with `{` so Claude continues straight into JSON instead of preambling
 * ("Sure, here's the JSON…"). Pre-prepends `{` to the returned text so the
 * caller still gets a valid JSON string.
 *
 * Saves a handful of output tokens per call and makes downstream parsing
 * more reliable (no `Sure!`-style chatter to strip).
 */
async function createMessage(anthropic, userContent, { model, maxTokens, signal, expectJson, responseSchema, cachedPrefix, task }) {
  // If a cachedPrefix is provided, split the user turn into a cache-marked
  // text block + the original dynamic content. Anthropic's `ephemeral` cache
  // gives subsequent calls within ~5 minutes a ~90% cost reduction on the
  // prefix. Below the provider's minimum cacheable size (~1024 tokens for
  // Sonnet) the cache_control marker is a no-op — no error, just falls
  // through to normal pricing — so we can apply it unconditionally.
  let messageContent;
  if (cachedPrefix) {
    const prefixBlock = {
      type: 'text',
      text: cachedPrefix,
      cache_control: { type: 'ephemeral' },
    };
    if (typeof userContent === 'string') {
      messageContent = [prefixBlock, { type: 'text', text: userContent }];
    } else if (Array.isArray(userContent)) {
      // Vision/document path: prepend the cacheable text in front of the
      // (image/PDF + text) blocks. Caching media is also supported but we
      // don't have a use case for it here.
      messageContent = [prefixBlock, ...userContent];
    } else {
      messageContent = userContent;
    }
  } else {
    messageContent = userContent;
  }

  const messages = [{ role: 'user', content: messageContent }];
  // Tool-use mode: when a responseSchema is provided, force Claude to call a
  // dummy tool whose input_schema is the desired output shape. Anthropic
  // guarantees the tool's input matches the schema (valid JSON + correct
  // types + no missing required fields + enum values respected), which
  // eliminates the entire class of "invalid JSON" / "wrong enum value"
  // bugs. JSON-prefill ('{') is incompatible with tool_choice so skip it.
  const params = {
    model,
    max_tokens: maxTokens,
    messages,
  };
  if (responseSchema) {
    params.tools = [{
      name: 'submit_response',
      description: 'Submit the structured response.',
      input_schema: responseSchema,
    }];
    params.tool_choice = { type: 'tool', name: 'submit_response' };
  } else if (expectJson) {
    messages.push({ role: 'assistant', content: '{' });
  }
  const response = await anthropic.messages.create(params, { signal });

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
    throw new Error(`AI response was truncated — hit the ${maxTokens}-token output cap (model wrote ${usage?.output_tokens ?? 'unknown'} tokens before being cut off). Try with fewer/smaller inputs, or raise the cap for this task in llm.js TASK_MAX_TOKENS.`);
  }

  // Tool-use response: pull the tool_use block's `input` (already a parsed
  // object matching the schema) and re-stringify so the shared
  // parseGeminiJSON downstream can just JSON.parse it like any other JSON.
  if (responseSchema) {
    const toolBlock = response.content.find(b => b.type === 'tool_use');
    if (!toolBlock) {
      throw new Error(`Claude tool-use response missing tool_use block (stop_reason=${stopReason || 'unknown'}).`);
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

export async function callClaudeText(prompt, model, apiKey, signal, { maxTokens = 2048, expectJson = false, responseSchema = null, cachedPrefix = null, task = null } = {}) {
  const anthropic = getAnthropicClient(apiKey);
  return createMessage(anthropic, prompt, { model, maxTokens, signal, expectJson, responseSchema, cachedPrefix, task });
}

export async function callClaudeVision(imagePaths, prompt, model, apiKey, signal, { maxTokens = 2048, expectJson = false, responseSchema = null, task = null } = {}) {
  const anthropic = getAnthropicClient(apiKey);
  const tempFiles = [];

  // Outer try/finally so partial HEIC conversion or downscale successes
  // (e.g. 4 of 7 succeed, then the 5th fails) still clean up their temp
  // files instead of leaking until the OS clears /var/folders.
  try {
    const contentParts = await Promise.all(imagePaths.map(async (imgPath) => {
      let finalPath = imgPath;
      const extRaw = path.extname(imgPath).toLowerCase();

      if (extRaw === '.heic' || extRaw === '.heif') {
        const { convertHeicIfNecessary } = await import('./heicUtils.js');
        finalPath = await convertHeicIfNecessary(imgPath);
        tempFiles.push(finalPath);
      }

      // Claude charges per ~1568x1568 image tile (~1600 input tokens). A
      // typical phone photo is ~4032px on the long side → 4 tiles → ~6400
      // tokens per image. Downscale to 768px on the long side first (fits
      // in one tile, ~260 tokens) — 6x cheaper per image with no impact on
      // brand/model/condition identification at this scale. Gemini sidesteps
      // this; its vision input is flat-rate per image.
      const { downscaleImageIfNeeded } = await import('./heicUtils.js');
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
    return await createMessage(anthropic, userContent, { model, maxTokens, signal, expectJson, responseSchema, task });
  } finally {
    if (tempFiles.length > 0) {
      const { cleanupTempFile } = await import('./heicUtils.js');
      await Promise.all(tempFiles.map(f => cleanupTempFile(f)));
    }
  }
}

export async function callClaudeDocument(filePath, prompt, model, apiKey, signal, { maxTokens = 2048, expectJson = false, responseSchema = null, task = null } = {}) {
  const ext = path.extname(filePath).toLowerCase();

  if (IMAGE_MIME_MAP[ext]) {
    return callClaudeVision([filePath], prompt, model, apiKey, signal, { maxTokens, expectJson, responseSchema, task });
  }

  if (ext === '.doc') {
    throw new Error('Legacy .doc files are not supported. Save as PDF or DOCX and try again.');
  }

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
    return createMessage(anthropic, userContent, { model, maxTokens, signal, expectJson, responseSchema, task });
  }

  const textContent = await fs.promises.readFile(filePath, 'utf8');
  return callClaudeText(`${prompt}\n\n[Attached File: ${path.basename(filePath)}]\n${textContent}`, model, apiKey, signal, { maxTokens, expectJson, responseSchema });
}
