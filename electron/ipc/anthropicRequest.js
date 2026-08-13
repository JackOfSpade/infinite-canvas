/**
 * Pure builders for the Anthropic Messages request SHAPE — the cache_control
 * prefix block plus the tool-use / JSON-prefill envelope. Extracted here, free
 * of the SDK and any side effects, so the synchronous path (createMessage), the
 * async Message Batches path (createClaudeBatch), and the free token-count
 * preflight (countClaudeInputTokens) all construct the EXACT same request from
 * ONE place. A batched scoring request is then structurally guaranteed to score
 * identically to a live one (and the preflight counts exactly what the real call
 * sends), instead of relying on hand-mirrored copies staying in sync. The whole
 * point is that the cache_control placement + submit_response tool envelope are
 * scoring-correctness-critical and must never silently diverge across paths.
 * Unit-tested in scripts/test-runner.js.
 */

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
 * Build the base Messages request params shared by the live + batch paths:
 * `{ model, max_tokens, messages }`, plus the tool-use envelope when a
 * responseSchema is given (force the `submit_response` tool so the model returns
 * structured JSON with the right top-level keys). Grounding / web-search is
 * live-only (streamed) and is intentionally NOT handled here — createMessage
 * layers it on after calling this.
 *
 * ── Why there is no assistant-prefill branch ───────────────────────────────
 * This used to push a `{ role: 'assistant', content: '{' }` turn when
 * `expectJson` was set without a schema, so the model would continue straight
 * into JSON. **Current models reject that outright.** Verified live against the
 * API on 2026-08-12:
 *
 *   claude-opus-5    400  "This model does not support assistant message
 *   claude-sonnet-5  400   prefill. The conversation must end with a user
 *   claude-fable-5   400   message."
 *   claude-haiku-4-5 200  (older model — still accepts it)
 *
 * Anthropic removed prefill across the 4.6+ family. Every current call site
 * happens to pass a responseSchema, so the dead branch never fired in practice
 * — but it was a live landmine: the moment any caller omitted `responseSchema`
 * while leaving `callLLMText`'s default `expectJson: true`, that task would
 * hard-400 on Opus and Sonnet while continuing to work on Haiku, which is an
 * unpleasant thing to debug.
 *
 * The replacement is nothing: `expectJson` now only signals intent to the
 * prompt layer, and the response is parsed by parseAiJson (jsonRepair.js),
 * which already tolerates fences, preamble, and trailing prose — the exact
 * slop the prefill existed to prevent. `expectJson` is kept in the signature
 * because callers still pass it and it stays meaningful for non-Anthropic
 * paths; it simply no longer changes the Anthropic request shape.
 *
 * @param {string|Array|*} userContent
 * @param {{model:string, maxTokens:number, responseSchema?:object|null, cachedPrefix?:string|null, expectJson?:boolean}} opts
 * @returns {{model:string, max_tokens:number, messages:object[], tools?:object[], tool_choice?:object}}
 */
export function buildAnthropicMessageParams(userContent, { model, maxTokens, responseSchema = null, cachedPrefix = null, expectJson = false }) {
  void expectJson;  // retained in the signature; no longer shapes the request (see doc above)
  const messages = [{ role: 'user', content: buildCachedUserContent(userContent, cachedPrefix) }];
  const params = { model, max_tokens: maxTokens, messages };
  if (responseSchema) {
    params.tools = [{ name: 'submit_response', description: 'Submit the structured response.', input_schema: responseSchema }];
    params.tool_choice = { type: 'tool', name: 'submit_response' };
  }
  return params;
}

/**
 * Build the corresponding free `messages.count_tokens` payload.
 *
 * The count endpoint deliberately has no `max_tokens`, but it accepts the
 * same messages, tools, and tool_choice fields as a real Messages request.
 * Deriving this from the live/batch builder keeps a future schema or cache
 * envelope change from silently making the preflight count a different prompt.
 */
export function buildAnthropicTokenCountParams(userContent, opts) {
  const { max_tokens: _maxTokens, ...params } = buildAnthropicMessageParams(userContent, opts);
  return params;
}
