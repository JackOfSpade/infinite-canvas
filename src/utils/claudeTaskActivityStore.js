// One shared view of what the Claude task worker is doing for each handoff. The
// main process pushes snapshots; a closed dock neither asks nor listens.
const LABEL_LIMIT = 160;
const STEP_LIMIT = 12;
const STATES = new Set(['queued', 'running', 'checking', 'retrying']);
const PHASES = new Set(['starting', 'waiting', 'thinking', 'writing', 'tool', 'api-retry']);
const IDLE = Object.freeze({ running: 0, waiting: 0, paused: false, pauseCode: null, held: Object.freeze([]), usageLimit: null, tasks: Object.freeze({}), claudeAccounts: Object.freeze([]) });
const ACCOUNT_LIMIT = 10;
const LIMIT_TYPES = new Set(['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_overage_included', 'overage']);

const text = (value, limit = LABEL_LIMIT) => typeof value === 'string' && value ? value.slice(0, limit) : null;
const time = value => Number.isFinite(value) && value >= 0 ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const optionalCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Pure: only bounded, known fields of one tracked Claude call. */
export function normalizeClaudeActivityEntry(raw) {
  if (!isObject(raw) || !STATES.has(raw.state)) return null;
  const failure = isObject(raw.failure) ? { label: text(raw.failure.label), retryAt: time(raw.failure.retryAt) } : null;
  const apiRetry = isObject(raw.apiRetry) ? {
    attempt: optionalCount(raw.apiRetry.attempt), maxRetries: optionalCount(raw.apiRetry.maxRetries),
    delayMs: optionalCount(raw.apiRetry.delayMs), status: optionalCount(raw.apiRetry.status),
  } : null;
  return {
    state: raw.state,
    phase: PHASES.has(raw.phase) ? raw.phase : 'starting',
    nodeId: text(raw.nodeId, 200),
    model: text(raw.model, 40),
    effort: text(raw.effort, 40),
    firstStartedAt: time(raw.firstStartedAt),
    phaseStartedAt: time(raw.phaseStartedAt),
    lastActivityAt: time(raw.lastActivityAt),
    round: count(raw.round),
    rejections: count(raw.rejections),
    toolTurns: count(raw.toolTurns),
    maxTurns: optionalCount(raw.maxTurns),
    tool: text(raw.tool, 60),
    target: text(raw.target),
    apiRetry,
    failure,
    steps: (Array.isArray(raw.steps) ? raw.steps : []).slice(-STEP_LIMIT)
      .filter(step => isObject(step) && text(step.label) && time(step.at) !== null)
      .map(step => ({ at: step.at, label: text(step.label) })),
  };
}

/** Pure: only the CONTRACT fields of one signed-in Claude account. */
export function normalizeClaudeAccount(raw) {
  if (!isObject(raw) || !text(raw.id, 60)) return null;
  return Object.freeze({
    id: text(raw.id, 60),
    isDefault: raw.isDefault === true,
    active: raw.active === true,
    loggedIn: typeof raw.loggedIn === 'boolean' ? raw.loggedIn : null,
    email: text(raw.email, 200),
    subscriptionType: text(raw.subscriptionType, 40),
    limitedUntil: time(raw.limitedUntil),
    limitType: LIMIT_TYPES.has(raw.limitType) ? raw.limitType : null,
  });
}

const limitTypeOf = value => (LIMIT_TYPES.has(value) ? value : null);

/** Pure: only bounded, known fields of a snapshot from the main process. */
export function normalizeClaudeTaskActivity(raw) {
  if (!isObject(raw)) return IDLE;
  const tasks = {};
  for (const [requestId, task] of Object.entries(isObject(raw.tasks) ? raw.tasks : {})) {
    const normalized = normalizeClaudeActivityEntry(task);
    if (normalized) tasks[requestId] = normalized;
  }
  return Object.freeze({
    running: count(raw.running), waiting: count(raw.waiting), paused: raw.paused === true,
    pauseCode: text(raw.pauseCode, 60), tasks: Object.freeze(tasks),
    usageLimit: isObject(raw.usageLimit) && time(raw.usageLimit.resumeAt) !== null
      ? Object.freeze({
        resumeAt: raw.usageLimit.resumeAt,
        knownReset: time(raw.usageLimit.resetsAt) !== null,
        limitType: limitTypeOf(raw.usageLimit.limitType),
        accountCount: count(raw.usageLimit.accountCount),
      }) : null,
    claudeAccounts: Object.freeze((Array.isArray(raw.claudeAccounts) ? raw.claudeAccounts : [])
      .slice(0, ACCOUNT_LIMIT).map(normalizeClaudeAccount).filter(Boolean)),
    held: Object.freeze((Array.isArray(raw.held) ? raw.held : []).filter(key => typeof key === 'string').slice(0, 100)),
  });
}

let snapshot = IDLE;
const listeners = new Set();
let detach = null;

function api() {
  try { return globalThis.window?.electronAPI || null; } catch { return null; }
}

export function getClaudeTaskActivity() { return snapshot; }

export function applyClaudeTaskActivity(raw) {
  snapshot = normalizeClaudeTaskActivity(raw);
  for (const listener of [...listeners]) { try { listener(); } catch { /* one subscriber cannot stop the rest */ } }
  return snapshot;
}

// The first subscriber reads the current state and starts listening.
export function subscribeClaudeTaskActivity(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  if (listeners.size === 1) {
    const bridge = api();
    try { detach = bridge?.onClaudeTaskActivity?.(applyClaudeTaskActivity) || null; } catch { detach = null; }
    try { Promise.resolve(bridge?.getClaudeTaskActivity?.()).then(raw => { if (raw) applyClaudeTaskActivity(raw); }).catch(() => {}); } catch { /* the next push fills it in */ }
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) { try { detach?.(); } catch { /* already gone */ } detach = null; }
  };
}

// Test seam: the store is module-level.
export function __resetClaudeTaskActivityForTests() {
  snapshot = IDLE;
  listeners.clear();
  detach = null;
}
