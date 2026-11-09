// Prompt-only Claude Code transport using the provider's public SDK. Readable
// thinking is requested through its supported summarized display. We copy only
// that text; signatures, redacted blocks and raw SDK events never enter our log.
import {
  answeringModel,
  buildClaudeInputMessage,
  classifyClaudeFailure,
  CLAUDE_HANDOFF_SYSTEM_PROMPT,
  CLAUDE_STAGE_TIMEOUT_MS,
  CLAUDE_ULTRACODE_SETTINGS,
  CLAUDE_WORKFLOW_TOOL,
  CLAUDE_WORKFLOW_UNFINISHED,
  CLAUDE_WORKFLOW_UNFINISHED_MESSAGE,
  ClaudeRunnerError,
  createClaudeBackgroundTasks,
  withWorkflowTool,
} from './claudeApplicationRunner.js';
import { claudeResetTimeMs, describeClaudeSdkMessage } from './claudeTaskActivity.js';
import { CLAUDE_PROMPT_TOKEN_BUDGET, CLAUDE_PROMPT_TOO_LONG, claudePromptTooLongMessage, estimateClaudePromptTokens } from './claudePromptLimit.js';

export { describeClaudeSdkMessage };

const OUTPUT_CAP_BYTES = 16 * 1024 * 1024;
const SAFEGUARD_MESSAGE = 'Claude\'s safeguards stopped this request. This can be a false alarm on a normal job posting, so retrying may pass. The provider message is in the private run log.';

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
  tools = [],
  // Ultracode is a settings flag that only does anything through the Workflow
  // tool. Off unless a stage asks for it: measured 2026-11-09, it added no
  // quality to any app call and cost 3-5x on the research tasks where it acted.
  ultracode = false,
  // Explicit MCP servers only (never the user's own connectors or settings). Empty for
  // every app task today; a server's tools are named mcp__<server>__<tool> in `tools`.
  mcpServers = {},
  // One turn suffices for a launched workflow (the CLI still runs the turn
  // after its task notification), but a failed Workflow call leaves no turn
  // to answer in, so such a stage ends on error_max_turns.
  maxTurns = 1,
  persistSession = true,
  systemAppend = '',
  queryImpl = null,
  timeoutMs = CLAUDE_STAGE_TIMEOUT_MS,
  onThinkingSummary = async () => {},
  onActivity = () => {},
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
} = {}) {
  if (signal?.aborted) throw new ClaudeRunnerError('CLAUDE_CANCELLED', 'Claude run was cancelled.');
  const promptTokens = estimateClaudePromptTokens(systemAppend, text);
  if (promptTokens > CLAUDE_PROMPT_TOKEN_BUDGET) {
    throw new ClaudeRunnerError(CLAUDE_PROMPT_TOO_LONG, claudePromptTooLongMessage(promptTokens));
  }

  const controller = new AbortController();
  const mainModels = new Set();
  const answerModels = new Set();
  const assistantErrors = new Set();
  const stopReasons = new Set();
  const started = Date.now();
  let queryHandle;
  let iterator;
  let terminal = null;
  let terminalProvisional = false;
  const backgroundTasks = createClaudeBackgroundTasks();
  const toolNames = Array.isArray(tools) ? tools.map(String) : [];
  const mcpToolNames = toolNames.filter(name => name.startsWith('mcp__'));
  const builtInToolNames = toolNames.filter(name => !name.startsWith('mcp__'));
  // Ultracode does nothing without Workflow, so the tool is only offered with it.
  const offeredTools = ultracode === true
    ? withWorkflowTool(builtInToolNames)
    : builtInToolNames.filter(name => name !== CLAUDE_WORKFLOW_TOOL);
  const servers = mcpServers && typeof mcpServers === 'object' && !Array.isArray(mcpServers) ? mcpServers : {};
  let summaryCount = 0;
  let summaryChars = 0;
  let usageResetsAt = null;
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
      // A failed stage still spent money; its caller records that spend.
      ...(terminal?.usage ? { usage: terminal.usage } : {}),
      ...(typeof terminal?.costUsd === 'number' ? { costUsd: terminal.costUsd } : {}),
      ...(usageResetsAt !== null ? { resetsAt: usageResetsAt } : {}),
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
        // Workflow is offered only for ultracode; research adds its web tools.
        // Every offered tool must run without a prompt in a headless stage.
        tools: offeredTools,
        allowedTools: [...offeredTools, ...mcpToolNames],
        permissionMode: 'dontAsk',
        // An empty settings overlay is the same as none, so every other option stays.
        settings: ultracode === true ? { ...CLAUDE_ULTRACODE_SETTINGS } : {},
        strictMcpConfig: true,
        mcpServers: servers,
        settingSources: [],
        persistSession,
        maxTurns,
        // Partial stream events are a liveness signal only; they fall through
        // every branch below and are never counted or logged.
        includePartialMessages: true,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: systemAppend ? `${CLAUDE_HANDOFF_SYSTEM_PROMPT}\n\n${systemAppend}` : CLAUDE_HANDOFF_SYSTEM_PROMPT },
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
      if (message.type === 'rate_limit_event' && message.rate_limit_info?.status === 'rejected') usageResetsAt = claudeResetTimeMs(message.rate_limit_info.resetsAt);
      // Never awaited: activity reporting must not fail or slow a stage.
      try { if (typeof onActivity === 'function') onActivity(describeClaudeSdkMessage(message)); } catch { /* liveness only */ }
      backgroundTasks.observe(message);

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
        terminalProvisional = backgroundTasks.settle(message);
        terminal = {
          subtype: typeof message.subtype === 'string' ? message.subtype : null,
          isError: message.is_error === true || message.subtype !== 'success',
          result,
          apiErrorStatus: message.api_error_status ?? null,
          models: Object.keys(message.modelUsage || {}),
          durationMs: message.duration_ms ?? null,
          stopReason: typeof message.stop_reason === 'string' ? clipped(message.stop_reason, 100) : null,
          errors,
          usage: message.usage ?? null,
          costUsd: typeof message.total_cost_usd === 'number' ? message.total_cost_usd : null,
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
    // The stub written after a workflow launch is never the answer; a stream
    // that ends there, or with a task still running, lost the real one.
    // An interim error result (error_max_turns while the workflow runs) also
    // counts when a task is still pending; the classifications above, and
    // usage, sign-in and prompt-size failures, keep their own codes.
    if ((terminal && !terminal.isError && terminalProvisional) || (backgroundTasks.pending > 0 &&
      (!terminal || !terminal.isError || classified.code === 'CLAUDE_ERROR'))) {
      throw new ClaudeRunnerError(CLAUDE_WORKFLOW_UNFINISHED, CLAUDE_WORKFLOW_UNFINISHED_MESSAGE, detail());
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
    if (stopReasons.has('max_tokens') || terminal.stopReason === 'max_tokens') {
      throw new ClaudeRunnerError('CLAUDE_OUTPUT_TRUNCATED', 'Claude stopped because the reply hit the output limit, so the answer is incomplete and was not used.', detail());
    }
    if (!terminal.result.trim()) {
      throw new ClaudeRunnerError('CLAUDE_ERROR', 'Claude Code returned an empty answer.', detail(), terminal.result);
    }
    return {
      text: terminal.result,
      model: answered,
      durationMs: terminal.durationMs ?? Date.now() - started,
      ...(terminal.usage ? { usage: terminal.usage } : {}),
      ...(terminal.costUsd !== null ? { costUsd: terminal.costUsd } : {}),
      summaryCount,
      summaryChars,
      thinkingDisplay: 'summarized',
    };
  }

  const onAbort = () => interrupt(new ClaudeRunnerError('CLAUDE_CANCELLED', 'Claude run was cancelled.', detail()));
  signal?.addEventListener?.('abort', onAbort, { once: true });
  // Close the race between the first aborted check and installing the listener.
  if (signal?.aborted) onAbort();
  timer = setTimeoutImpl(() => interrupt(backgroundTasks.workflowStarted
    ? new ClaudeRunnerError(CLAUDE_WORKFLOW_UNFINISHED,
      `Claude's workflow did not finish within ${Math.round(timeoutMs / 60000)} minutes, so its answer was not used.`, detail())
    : new ClaudeRunnerError('CLAUDE_TIMEOUT',
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
