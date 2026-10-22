// Prompt-only Claude Code transport using the provider's public SDK. Readable
// thinking is requested through its supported summarized display. We copy only
// that text; signatures, redacted blocks and raw SDK events never enter our log.
import {
  answeringModel,
  buildClaudeInputMessage,
  classifyClaudeFailure,
  CLAUDE_HANDOFF_SYSTEM_PROMPT,
  CLAUDE_STAGE_TIMEOUT_MS,
  ClaudeRunnerError,
} from './claudeApplicationRunner.js';

const OUTPUT_CAP_BYTES = 16 * 1024 * 1024;
const SAFEGUARD_MESSAGE = 'Claude blocked this request with its safeguards. The private run log contains the provider message. Review the request before retrying.';

function clipped(value, max = 300) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max);
}

function stagePrompt(text, pageImages, sessionId) {
  if (!Array.isArray(pageImages) || pageImages.length === 0) return String(text ?? '');
  const input = JSON.parse(buildClaudeInputMessage({ text, pageImages }));
  return (async function* imageInput() {
    yield {
      ...input,
      parent_tool_use_id: null,
      client_composed: true,
      ...(sessionId ? { session_id: sessionId } : {}),
    };
  }());
}

export async function runClaudeSdkStage({
  text,
  pageImages,
  signal,
  binary,
  env,
  cwd,
  model = 'sonnet',
  effort = 'high',
  sessionId,
  resume = false,
  queryImpl = null,
  timeoutMs = CLAUDE_STAGE_TIMEOUT_MS,
  onThinkingSummary = async () => {},
  onActivity = () => {},
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
} = {}) {
  if (signal?.aborted) throw new ClaudeRunnerError('CLAUDE_CANCELLED', 'Claude run was cancelled.');

  const controller = new AbortController();
  const mainModels = new Set();
  const answerModels = new Set();
  const assistantErrors = new Set();
  const stopReasons = new Set();
  const started = Date.now();
  let queryHandle;
  let iterator;
  let terminal = null;
  let summaryCount = 0;
  let summaryChars = 0;
  let outputBytes = 0;
  let interrupted = null;
  let timer = null;
  let refuse = null;
  let rejectInterruption;
  const interruption = new Promise((_, reject) => { rejectInterruption = reject; });

  function closeQuery() {
    try { queryHandle?.close?.(); } catch { /* cancellation must still settle */ }
  }

  function interrupt(error) {
    if (interrupted) return;
    interrupted = error;
    controller.abort();
    closeQuery();
    rejectInterruption(error);
  }

  function checkInterrupted() {
    if (interrupted) throw interrupted;
  }

  function countText(value) {
    if (typeof value !== 'string') return;
    outputBytes += Buffer.byteLength(value, 'utf8');
    if (outputBytes > OUTPUT_CAP_BYTES) {
      throw new ClaudeRunnerError('CLAUDE_ERROR', 'Claude Code produced more than 16 MB of output.');
    }
  }

  function detail() {
    return {
      exitCode: null,
      subtype: terminal?.subtype ?? null,
      apiErrorStatus: terminal?.apiErrorStatus ?? null,
      models: [...mainModels],
      usageModels: terminal?.models ?? [],
      durationMs: terminal?.durationMs ?? null,
      stopReason: terminal?.stopReason ?? null,
      assistantStopReasons: [...stopReasons],
      assistantErrors: [...assistantErrors],
      errors: terminal?.errors ?? [],
      summaryCount,
      summaryChars,
      thinkingDisplay: 'summarized',
      ...(refuse || {}),
    };
  }

  async function consume() {
    const query = queryImpl || (await import('@anthropic-ai/claude-agent-sdk')).query;
    checkInterrupted();
    queryHandle = query({
      prompt: stagePrompt(text, pageImages, sessionId),
      options: {
        model,
        effort,
        thinking: { type: 'adaptive', display: 'summarized' },
        pathToClaudeCodeExecutable: binary,
        cwd,
        env,
        abortController: controller,
        tools: [],
        strictMcpConfig: true,
        mcpServers: {},
        settingSources: [],
        persistSession: true,
        maxTurns: 1,
        // Partial stream events are a liveness signal only; they fall through
        // every branch below and are never counted or logged.
        includePartialMessages: true,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: CLAUDE_HANDOFF_SYSTEM_PROMPT },
        extraArgs: { restricted: null },
        ...(sessionId ? (resume ? { resume: sessionId } : { sessionId }) : {}),
      },
    });
    checkInterrupted();
    iterator = queryHandle[Symbol.asyncIterator]();
    for (;;) {
      checkInterrupted();
      const item = await iterator.next();
      checkInterrupted();
      if (item.done) break;
      const message = item.value;
      if (!message || typeof message !== 'object') continue;
      // Never awaited: activity reporting must not fail or slow a stage.
      try { if (typeof onActivity === 'function') onActivity(); } catch { /* liveness only */ }

      if (message.type === 'assistant' && !message.parent_tool_use_id && !message.agent_id) {
        // SDK modelUsage also includes auxiliary calls. Only main assistant
        // frames can prove which model actually produced this stage's answer.
        const assistantModel = typeof message.message?.model === 'string' ? message.message.model : null;
        const assistantError = typeof message.error === 'string' ? clipped(message.error, 100) : null;
        if (assistantError) assistantErrors.add(assistantError);
        if (assistantModel && assistantModel !== '<synthetic>') mainModels.add(assistantModel);
        if (typeof message.message?.stop_reason === 'string') stopReasons.add(clipped(message.message.stop_reason, 100));
        if (message.aborted === true) assistantErrors.add('aborted');
        const content = Array.isArray(message.message?.content) ? message.message.content : [];
        for (const block of content) {
          if (block?.type === 'text') {
            countText(block.text);
            if (typeof block.text === 'string' && block.text.trim() && !assistantError) answerModels.add(assistantModel);
          }
          if (block?.type !== 'thinking' || typeof block.thinking !== 'string') continue;
          countText(block.thinking);
          if (!block.thinking.trim() || assistantError || !answeringModel(model, [assistantModel])) continue;
          checkInterrupted();
          try {
            await onThinkingSummary({ text: block.thinking, model: assistantModel, index: summaryCount + 1, thinkingDisplay: 'summarized' });
          } catch (error) {
            throw new ClaudeRunnerError('CLAUDE_LOG_ERROR', 'Claude diagnostic summary could not be saved.', {
              ...detail(), cause: clipped(error?.message || error),
            });
          }
          checkInterrupted();
          summaryCount += 1;
          summaryChars += block.thinking.length;
        }
      } else if (message.type === 'result') {
        const result = typeof message.result === 'string' ? message.result : '';
        countText(result);
        const errors = Array.isArray(message.errors) ? message.errors.filter(value => typeof value === 'string') : [];
        errors.forEach(countText);
        terminal = {
          subtype: typeof message.subtype === 'string' ? message.subtype : null,
          isError: message.is_error === true || message.subtype !== 'success',
          result,
          apiErrorStatus: message.api_error_status ?? null,
          models: Object.keys(message.modelUsage || {}),
          durationMs: message.duration_ms ?? null,
          stopReason: typeof message.stop_reason === 'string' ? clipped(message.stop_reason, 100) : null,
          errors,
        };
      } else if (message.type === 'system' &&
        (message.subtype === 'model_refusal_no_fallback' || (message.subtype === 'model_refusal_fallback' && message.scope !== 'local'))) {
        refuse = {
          ...(typeof message.api_refusal_category === 'string' ? { refusalCategory: clipped(message.api_refusal_category, 100) } : {}),
          ...(typeof message.request_id === 'string' ? { requestId: clipped(message.request_id, 150) } : {}),
          refusalEvent: message.subtype,
        };
        // No fallback is configured. If an installed CLI nevertheless starts
        // one, terminate it rather than accept an unrequested model's answer.
        if (message.subtype === 'model_refusal_fallback') {
          throw new ClaudeRunnerError('CLAUDE_SAFEGUARD_BLOCKED', SAFEGUARD_MESSAGE, detail(), terminal?.result || '');
        }
      }
    }

    checkInterrupted();
    const parsed = terminal ? { ...terminal, models: [...mainModels] } : null;
    const classified = classifyClaudeFailure({ parsed, stderr: terminal?.errors.join('\n') || [...assistantErrors].join('\n'), exitCode: null });
    if (classified.code === 'CLAUDE_SAFEGUARD_BLOCKED') {
      classified.detail = { ...classified.detail, ...detail() };
      throw classified;
    }
    if (refuse || stopReasons.has('refusal') || terminal?.stopReason === 'refusal') {
      throw new ClaudeRunnerError('CLAUDE_SAFEGUARD_BLOCKED', SAFEGUARD_MESSAGE, detail(), terminal?.result || '');
    }
    if (!terminal || terminal.isError || terminal.errors.length > 0 || assistantErrors.size > 0) {
      classified.detail = { ...classified.detail, ...detail() };
      throw classified;
    }
    const answered = answeringModel(model, [...answerModels]);
    if (!answered || [...answerModels].some(id => !answeringModel(model, [id])) || [...mainModels].some(id => !answeringModel(model, [id]))) {
      throw new ClaudeRunnerError('CLAUDE_WRONG_MODEL',
        `Claude answered with ${[...mainModels].join(', ') || 'an unverified model'} instead of ${model}.`, detail(), terminal.result);
    }
    if (!terminal.result.trim()) {
      throw new ClaudeRunnerError('CLAUDE_ERROR', 'Claude Code returned an empty answer.', detail(), terminal.result);
    }
    return {
      text: terminal.result,
      model: answered,
      durationMs: terminal.durationMs ?? Date.now() - started,
      summaryCount,
      summaryChars,
      thinkingDisplay: 'summarized',
    };
  }

  const onAbort = () => interrupt(new ClaudeRunnerError('CLAUDE_CANCELLED', 'Claude run was cancelled.', detail()));
  signal?.addEventListener?.('abort', onAbort, { once: true });
  // Close the race between the first aborted check and installing the listener.
  if (signal?.aborted) onAbort();
  timer = setTimeoutImpl(() => interrupt(new ClaudeRunnerError('CLAUDE_TIMEOUT',
    `Claude did not finish this stage within ${Math.round(timeoutMs / 60000)} minutes.`, detail())), timeoutMs);
  timer?.unref?.();
  const work = consume().catch(error => {
    if (interrupted) throw interrupted;
    if (error instanceof ClaudeRunnerError) throw error;
    // The classifier clips generic UI text and retains only recognized plain
    // provider errors. Do not truncate diagnostic IDs before that projection.
    const failed = classifyClaudeFailure({ parsed: terminal,
      stderr: typeof error?.message === 'string' ? error.message : String(error ?? ''), exitCode: null });
    failed.detail = { ...failed.detail, ...detail() };
    if (error?.code === 'ENOENT') {
      failed.code = 'CLAUDE_CLI_MISSING';
      failed.message = 'Claude Code is not installed or not on PATH. Install it and sign in with your Claude subscription, then retry.';
    }
    throw failed;
  });
  try {
    return await Promise.race([work, interruption]);
  } finally {
    if (timer !== null) clearTimeoutImpl(timer);
    signal?.removeEventListener?.('abort', onAbort);
    controller.abort();
    closeQuery();
    // A fake or failed iterator need not unblock next() on abort. Do not await
    // its return() and let it turn a cancellation/timeout into another hang.
    try { Promise.resolve(iterator?.return?.()).catch(() => {}); } catch { /* best effort cleanup */ }
  }
}
