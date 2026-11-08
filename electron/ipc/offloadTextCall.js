// One stateless text call through the local `offload complete` CLI (DeepSeek).
// Workers and interview Q&A resend their whole message list on every call, so
// no session file is kept. Failures throw the same ClaudeRunnerError codes the
// stage runner uses (OFFLOAD_*), which callers treat as "fall back to Claude".
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import { CLAUDE_HANDOFF_SYSTEM_PROMPT, ClaudeRunnerError } from './claudeApplicationRunner.js';
import { offloadReasoning } from './aiCallProviders.js';
import { OFFLOAD_MAX_TOKENS, OFFLOAD_TIMEOUT_MS, offloadFailure, runOffloadComplete } from './offloadCompleteStage.js';

/** The handoff system prompt (plus any shared reference) and the user text, as CLI messages. */
export function handoffMessages({ text, systemAppend = '' }) {
  return [
    { role: 'system', content: CLAUDE_HANDOFF_SYSTEM_PROMPT + (systemAppend ? `\n\n${systemAppend}` : '') },
    { role: 'user', content: String(text ?? '') },
  ];
}

// The CLI accepts [A-Za-z0-9][A-Za-z0-9._-]{0,63}. The uuid is kept whole; the tag is cut to fit.
function toolLoopId(tag) {
  const uuid = crypto.randomUUID();
  const cleaned = String(tag ?? '').replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^[^A-Za-z0-9]+/u, '');
  const prefix = (cleaned || 'text').slice(0, 64 - uuid.length - 1);
  return `${prefix}-${uuid}`;
}

export async function offloadTextCall({
  messages, route, reasoning, tag, signal, maxTokens = OFFLOAD_MAX_TOKENS, timeoutMs = OFFLOAD_TIMEOUT_MS,
  binPath, nodePath = process.execPath, spawnImpl = childProcess.spawn, caller = 'infinite-canvas', webTools,
} = {}) {
  let reasoningRequest;
  try { reasoningRequest = offloadReasoning(reasoning ?? 'high'); } catch {
    throw new ClaudeRunnerError('OFFLOAD_INVALID_REQUEST', 'The offload reasoning level is not valid.');
  }
  if (signal?.aborted) throw new ClaudeRunnerError('CLAUDE_CANCELLED', 'Offload run was cancelled.');
  const request = {
    version: 1, route, messages, maxTokens, reasoning: reasoningRequest, timeoutMs,
    caller, tag: String(tag ?? 'text'),
  };
  const useWebTools = Boolean(webTools) && typeof webTools === 'object';
  if (useWebTools) {
    request.tools = [
      { builtin: 'web_search', count: webTools.searchCount ?? 5 },
      { builtin: 'web_fetch', maxChars: webTools.fetchMaxChars ?? 20000 },
    ];
    request.toolLoop = {
      id: toolLoopId(request.tag), maxTurns: webTools.maxTurns ?? 16, maxToolCallsPerTurn: 8,
      maxToolCalls: webTools.maxToolCalls ?? 64, maxUsd: webTools.maxUsd ?? 0.5,
    };
  }
  const result = await runOffloadComplete({ request, binPath, nodePath, spawnImpl, signal });
  if (result?.ok !== true) throw offloadFailure(result);
  if (result.finishReason === 'tool_calls') {
    throw new ClaudeRunnerError('OFFLOAD_UNSUPPORTED', 'The offload provider asked for tools this call cannot run.', {
      offloadCode: 'tool_calls', latencyMs: Number.isFinite(result.latencyMs) ? result.latencyMs : null,
      costUsd: typeof result.costUsd === 'number' ? result.costUsd : null });
  }
  const answer = typeof result.text === 'string' ? result.text : '';
  if (!answer.trim()) {
    throw new ClaudeRunnerError('OFFLOAD_EMPTY', 'The offload provider returned an empty answer.', {
      offloadCode: 'empty', latencyMs: Number.isFinite(result.latencyMs) ? result.latencyMs : null,
      costUsd: typeof result.costUsd === 'number' ? result.costUsd : null });
  }
  const raw = result.usage && typeof result.usage === 'object' ? result.usage : {};
  return {
    text: answer,
    model: typeof result.model === 'string' ? result.model : route,
    durationMs: Number.isFinite(result.latencyMs) ? result.latencyMs : null,
    usage: {
      input_tokens: raw.cacheMissTokens ?? 0,
      cache_read_input_tokens: raw.cacheHitTokens ?? 0,
      output_tokens: raw.outputTokens ?? 0,
      reasoning_tokens: raw.reasoningTokens ?? 0,
      provider_usage: raw,
    },
    costUsd: typeof result.costUsd === 'number' ? result.costUsd : undefined,
    provider: 'offload',
    route,
    reasoning,
    ...(useWebTools ? { webTools: { turns: result.toolLoop?.turn ?? null, toolCalls: result.toolLoop?.toolCalls ?? null } } : {}),
  };
}
