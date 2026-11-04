// What Claude is doing right now, for every panel that shows it: handoff tasks,
// application bundles and interview preparation. Holds described events only
// (see describeClaudeSdkMessage): no prompt, thinking or answer text, and
// nothing here is logged or saved.
const STEP_LIMIT = 12;
const LABEL_LIMIT = 160;

function clipped(value, max = 300) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max);
}

const ACTIVITY_TARGET_LIMIT = 120;

// What a person may see of a tool call. Only a search query and a page address
// (no query string, which can hold tokens) ever leave this file.
function toolTarget(name, input) {
  if (name === 'WebSearch' && typeof input?.query === 'string') return clipped(input.query, ACTIVITY_TARGET_LIMIT) || null;
  if (name !== 'WebFetch' || typeof input?.url !== 'string') return null;
  try {
    const url = new URL(input.url);
    return clipped(`${url.host}${url.pathname === '/' ? '' : url.pathname}`, ACTIVITY_TARGET_LIMIT) || null;
  } catch { return null; }
}

function describeStreamEvent(event) {
  if (event?.type === 'message_start') return { kind: 'request' };
  if (event?.type === 'content_block_start') {
    const type = event.content_block?.type;
    if (type === 'thinking') return { kind: 'thinking' };
    if (type === 'text') return { kind: 'writing' };
    return null;
  }
  if (event?.type !== 'content_block_delta') return null;
  if (event.delta?.type === 'thinking_delta') return { kind: 'thinking' };
  if (event.delta?.type === 'text_delta') return { kind: 'writing' };
  return null;
}

// The SDK reports a reset in seconds. Null when absent or not a real time.
export function claudeResetTimeMs(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  return value < 1e12 ? value * 1000 : value;
}

/** Sizes, tool names and retry counters for one SDK message. Never its text. */
export function describeClaudeSdkMessage(message) {
  if (!message || typeof message !== 'object') return null;
  if (message.parent_tool_use_id || message.agent_id) return { kind: 'subagent' };
  const content = Array.isArray(message.message?.content) ? message.message.content : [];
  switch (message.type) {
    case 'stream_event': return describeStreamEvent(message.event);
    case 'assistant': {
      const calls = content.filter(block => block?.type === 'tool_use' || block?.type === 'server_tool_use')
        .map(block => ({ tool: clipped(block.name, 60), target: toolTarget(block.name, block.input) }));
      return calls.length ? { kind: 'tool', messageId: typeof message.message?.id === 'string' ? message.message.id : null, calls } : null;
    }
    case 'user': {
      const results = content.filter(block => block?.type === 'tool_result');
      return results.length ? { kind: 'tool-result', isError: results.some(block => block.is_error === true) } : null;
    }
    case 'tool_progress': return { kind: 'tool-progress', tool: clipped(message.tool_name, 60), seconds: Number.isFinite(message.elapsed_time_seconds) ? message.elapsed_time_seconds : null };
    case 'result': return { kind: 'finished' };
    case 'rate_limit_event': {
      const info = message.rate_limit_info;
      if (info?.status !== 'rejected') return null;
      return { kind: 'rate-limited', resetsAt: claudeResetTimeMs(info.resetsAt) };
    }
    case 'system':
      if (message.subtype === 'init') return { kind: 'started' };
      if (message.subtype === 'api_retry') {
        const number = value => Number.isFinite(value) ? value : null;
        return { kind: 'api-retry', attempt: number(message.attempt), maxRetries: number(message.max_retries), delayMs: number(message.retry_delay_ms), status: number(message.error_status) };
      }
      return null;
    default: return null;
  }
}

export const CLAUDE_TASK_FAILURE_LABELS = Object.freeze({
  CLAUDE_TIMEOUT: 'Claude did not finish in time',
  CLAUDE_OUTPUT_TRUNCATED: 'The reply hit the output limit',
  CLAUDE_SAFEGUARD_BLOCKED: 'Claude blocked this request with its safeguards',
  CLAUDE_WRONG_MODEL: 'The reply came from the wrong model',
  CLAUDE_TASK_IMAGE: 'A photo could not be read',
  CLAUDE_ERROR: 'Claude returned an error',
});
export const claudeTaskFailureLabel = code => CLAUDE_TASK_FAILURE_LABELS[code] || 'The attempt failed';

function toolLabel({ tool, target }) {
  if (tool === 'WebSearch') return target ? `Searching the web: ${target}` : 'Searching the web';
  if (tool === 'WebFetch') return target ? `Reading ${target}` : 'Reading a page';
  return `Using ${tool}`;
}

function viewOf(task) {
  const view = { ...task, steps: task.steps.map(step => ({ ...step })) };
  delete view.turnIds;
  return view;
}

export function createClaudeTaskActivity({ now = () => Date.now(), onChange = () => {} } = {}) {
  const tasks = new Map();
  let paused = false;
  let pauseCode = null;

  function create(requestId, fields) {
    const at = now();
    const task = {
      state: 'queued', phase: 'starting', task: null, model: null, effort: null,
      firstStartedAt: at, phaseStartedAt: at, lastActivityAt: null, round: 0, rejections: 0,
      toolTurns: 0, maxTurns: null, target: null, tool: null,
      apiRetry: null, failure: null, steps: [], stepSeq: 0, nodeId: null, turnIds: new Set(), ...fields,
    };
    tasks.set(requestId, task);
    return task;
  }

  function addStep(task, label) {
    task.steps.push({ at: now(), label: String(label).slice(0, LABEL_LIMIT) });
    task.stepSeq += 1;
    if (task.steps.length > STEP_LIMIT) task.steps.splice(0, task.steps.length - STEP_LIMIT);
  }

  // A step per change of phase or tool, never per streamed delta.
  function enterPhase(task, phase, label) {
    if (task.phase === phase) return;
    task.phase = phase;
    task.phaseStartedAt = now();
    if (label) addStep(task, label);
  }

  return Object.freeze({
    queued(requestId, { task: taskId, issuedAt, nodeId = null } = {}) {
      const task = tasks.get(requestId);
      if (!task) create(requestId, { task: taskId ?? null, nodeId, ...(Number.isFinite(issuedAt) ? { firstStartedAt: issuedAt, phaseStartedAt: issuedAt } : {}) });
      else if (task.state === 'retrying') { task.state = 'queued'; task.phaseStartedAt = now(); } else return;
      onChange();
    },
    begin(requestId, { task: taskId, model, effort, maxTurns = null, rejections = 0, nodeId = null, countRound = true } = {}) {
      const task = tasks.get(requestId) || create(requestId, {});
      Object.assign(task, {
        state: 'running', phase: 'starting', phaseStartedAt: now(), task: taskId ?? task.task, nodeId: nodeId ?? task.nodeId, model: model ?? null, effort: effort ?? null,
        maxTurns, rejections: Math.max(task.rejections, Number.isSafeInteger(rejections) ? rejections : 0), round: countRound ? task.round + 1 : 1,
        toolTurns: 0, target: null, tool: null, apiRetry: null, failure: null, turnIds: new Set(),
      });
      onChange();
    },
    event(requestId, event) {
      const task = tasks.get(requestId);
      if (!task) return;
      // Any SDK message proves the stream is alive, even one we do not describe.
      task.lastActivityAt = now();
      if (event && event.kind !== 'api-retry' && event.kind !== 'subagent') task.apiRetry = null;
      switch (event?.kind) {
        case 'started': addStep(task, 'Claude started'); break;
        case 'thinking':
          task.target = null;
          enterPhase(task, 'thinking', 'Thinking');
          break;
        case 'writing':
          task.target = null;
          enterPhase(task, 'writing', 'Writing the answer');
          break;
        case 'tool': {
          if (!event.messageId || !task.turnIds.has(event.messageId)) task.toolTurns += 1;
          if (event.messageId) task.turnIds.add(event.messageId);
          for (const call of event.calls) {
            task.phase = 'tool';
            task.phaseStartedAt = now();
            task.tool = call.tool;
            task.target = call.target;
            addStep(task, toolLabel(call));
          }
          break;
        }
        case 'rate-limited': task.rateLimitResetsAt = event.resetsAt; break;
        case 'tool-result':
          if (event.isError) addStep(task, 'Tool failed');
          // The tool is done; until the next delta the turn belongs to Claude.
          task.target = null;
          task.phase = 'waiting';
          task.phaseStartedAt = now();
          break;
        case 'api-retry':
          task.apiRetry = { attempt: event.attempt, maxRetries: event.maxRetries, delayMs: event.delayMs, status: event.status };
          if (task.phase !== 'api-retry') task.phaseStartedAt = now();
          task.phase = 'api-retry';
          addStep(task, `Claude service retry ${event.attempt ?? '?'} of ${event.maxRetries ?? '?'}`);
          break;
        default: break;
      }
      onChange();
    },
    checking(requestId) {
      const task = tasks.get(requestId);
      if (!task) return;
      task.state = 'checking';
      task.phaseStartedAt = now();
      addStep(task, 'Checking the answer');
      onChange();
    },
    rejected(requestId) {
      const task = tasks.get(requestId);
      if (!task) return;
      task.state = 'queued';
      task.rejections += 1;
      task.phaseStartedAt = now();
      addStep(task, 'App rejected the answer');
      onChange();
    },
    failed(requestId, { code, attempts = null, retryAt = null } = {}) {
      const task = tasks.get(requestId);
      if (!task) return;
      task.state = 'retrying';
      task.phaseStartedAt = now();
      task.failure = { code: code || null, label: claudeTaskFailureLabel(code), attempts, retryAt };
      addStep(task, `Attempt failed: ${claudeTaskFailureLabel(code)}`);
      onChange();
    },
    // A cancelled or paused serve is not a failed attempt; it just waits again.
    released(requestId) {
      const task = tasks.get(requestId);
      if (!task || task.state === 'retrying' || task.state === 'queued') return;
      task.state = 'queued';
      task.phaseStartedAt = now();
      onChange();
    },
    // A step the caller knows about and the stream cannot: a new stage, a host check.
    note(requestId, label) {
      const task = tasks.get(requestId);
      if (!task) return;
      addStep(task, label);
      onChange();
    },
    remove(requestId) {
      if (tasks.delete(requestId)) onChange();
    },
    stepSeq: requestId => tasks.get(requestId)?.stepSeq ?? 0,
    view(requestId) {
      const task = tasks.get(requestId);
      return task ? viewOf(task) : null;
    },
    prune(liveIds) {
      let changed = false;
      for (const requestId of tasks.keys()) if (!liveIds.has(requestId)) { tasks.delete(requestId); changed = true; }
      if (changed) onChange();
    },
    setPause(isPaused, code) {
      if (paused === isPaused && pauseCode === code) return;
      paused = isPaused;
      pauseCode = code;
      onChange();
    },
    snapshot() {
      const view = {};
      let running = 0;
      let waiting = 0;
      for (const [requestId, task] of tasks) {
        if (task.state === 'running' || task.state === 'checking') running += 1;
        else if (task.state === 'queued') waiting += 1;
        view[requestId] = viewOf(task);
      }
      return { at: now(), running, waiting, paused, pauseCode, tasks: view };
    },
  });
}

// Claude calls that do not go through the task worker. The worker's feed merges
// these, so every panel reads one snapshot.
const standaloneListeners = new Set();
export const standaloneClaudeActivity = createClaudeTaskActivity({
  onChange() { for (const listener of [...standaloneListeners]) { try { listener(); } catch { /* reporting cannot affect a call */ } } },
});
export function subscribeStandaloneClaudeActivity(listener) {
  standaloneListeners.add(listener);
  return () => standaloneListeners.delete(listener);
}
