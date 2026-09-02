/**
 * Pure builders for the Anthropic Messages request SHAPE — the cache_control
 * prefix block plus the native JSON-output envelope. Extracted here, free
 * of the SDK and any side effects, so the synchronous path (createMessage) and
 * the free token-count preflight (countClaudeInputTokens) construct the exact
 * same request from one place. The cache_control placement + JSON schema
 * envelope are scoring-correctness-critical and must never silently
 * diverge between preflight and the actual call.
 * Unit-tested in scripts/test-runner.js.
 */

import { claudeReasoningMaxTokens, getClaudeDefaultReasoningConfig } from './claudeModels.js';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { assertAnthropicStructuredOutputLimits, assertResponseSchemaVocabularySupported } from './schemaValidation.js';

/**
 * Build the `user` turn content. With a cachedPrefix, split it into an ephemeral
 * cache-marked text block + the dynamic content — Anthropic gives ~90% off the
 * cached prefix on calls within ~5 min; below the minimum cacheable size the
 * marker is a harmless no-op (no error, just normal pricing). Strings get
 * wrapped; array content (vision/document blocks) gets the prefix prepended;
 * anything else (and the no-prefix case) passes through unchanged.
 *
 * @param {string|Array|*} userContent
 * @param {string|null} cachedPrefix
 */
export function buildCachedUserContent(userContent, cachedPrefix) {
  if (!cachedPrefix) return userContent;
  const prefixBlock = { type: 'text', text: cachedPrefix, cache_control: { type: 'ephemeral' } };
  if (typeof userContent === 'string') return [prefixBlock, { type: 'text', text: userContent }];
  if (Array.isArray(userContent)) return [prefixBlock, ...userContent];
  return userContent;
}

/**
 * The exact native Structured Outputs schema Anthropic receives. Local helper
 * for buildAnthropicMessageParams below — kept pure and separate from the SDK
 * call site so the transform is easy to unit-test in isolation.
 */
function toAnthropicResponseSchema(responseSchema) {
  return jsonSchemaOutputFormat(responseSchema).schema;
}

/**
 * Build the base Messages request params shared by the live + batch paths:
 * `{ model, max_tokens, messages }`, the model's shared reasoning policy, plus
 * native Structured Outputs when a responseSchema is given.  Grounding / web-search is
 * live-only (streamed) and is intentionally NOT handled here — createMessage
 * layers it on after calling this.
 *
 * ── Why there is no assistant-prefill branch ───────────────────────────────
 * This used to push a `{ role: 'assistant', content: '{' }` turn to coax
 * unstructured JSON. **Current models reject that outright.** Verified live
 * against the API on 2026-08-12:
 *
 *   claude-opus-5    400  "This model does not support assistant message
 *   claude-sonnet-5  400   prefill. The conversation must end with a user
 *   claude-fable-5   400   message."
 *   claude-haiku-4-5 200  (older model — still accepts it)
 *
 * Anthropic removed prefill across the 4.6+ family. Structured callers now
 * require `responseSchema`, which uses native Structured Outputs; prose callers
 * use the raw path. There is intentionally no unstructured-JSON fallback.
 *
 * @param {string|Array|*} userContent
 * Anthropic's JSON output grammar supports a constrained subset of JSON Schema.
 * `jsonSchemaOutputFormat` transforms unsupported constraints into descriptive
 * guidance and adds `additionalProperties:false` recursively, so callers must
 * still validate business constraints locally.
 *
 * @param {{model:string, maxTokens:number, responseSchema?:object|null, cachedPrefix?:string|null}} opts
 * @returns {{model:string, max_tokens:number, messages:object[], thinking?:object, output_config?:object}}
 */
export function buildAnthropicMessageParams(userContent, { model, maxTokens, responseSchema = null, cachedPrefix = null }) {
  const messages = [{ role: 'user', content: buildCachedUserContent(userContent, cachedPrefix) }];
  const reasoning = getClaudeDefaultReasoningConfig(model);
  const params = { model, max_tokens: claudeReasoningMaxTokens(model, maxTokens), messages };
  if (reasoning.thinking) params.thinking = reasoning.thinking;
  if (responseSchema) {
    // Reject contracts our local post-response validator cannot enforce before
    // either a billed Messages request or count_tokens reaches Anthropic.
    assertResponseSchemaVocabularySupported(responseSchema);
    assertAnthropicStructuredOutputLimits(responseSchema);
    // Merge, don't replace, the model's reasoning effort.  `format` is the
    // native Structured Outputs API: unlike a forced fake tool, it returns the
    // JSON as the response text and is constrained for every schema-bound call.
    params.output_config = {
      ...(reasoning.outputConfig || {}),
      format: {
        type: 'json_schema',
        schema: toAnthropicResponseSchema(responseSchema),
      },
    };
  } else if (reasoning.outputConfig) {
    params.output_config = reasoning.outputConfig;
  }
  return params;
}

/**
 * Build the corresponding free `messages.count_tokens` payload.
 *
 * The count endpoint deliberately has no `max_tokens`, but it accepts the
 * same messages and `output_config` fields as a real Messages request.
 * Deriving this from the live/batch builder keeps a future schema or cache
 * envelope change from silently making the preflight count a different prompt.
 */
export function buildAnthropicTokenCountParams(userContent, opts) {
  const { max_tokens: _maxTokens, ...params } = buildAnthropicMessageParams(userContent, opts);
  return params;
}
