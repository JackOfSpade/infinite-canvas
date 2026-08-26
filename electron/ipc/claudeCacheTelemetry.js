// Session-only accounting for Anthropic prompt-cache activity. Anthropic's
// usage fields tell us what actually happened after a request completes; this
// module also retains the number of calls that *asked* for caching so a zero
// hit-rate is distinguishable from no cached calls at all. It is deliberately
// dependency-free so it can be exercised by the plain Node test runner.

const MAX_TASKS = 24;

function emptyStats() {
  return {
    requested: 0,
    writes: 0,
    hits: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    uncachedInputTokens: 0,
    lastEvent: null,
  };
}

const state = {
  ...emptyStats(),
  tasks: {},
};

function finiteTokenCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function taskKey(task) {
  const key = String(task || 'unknown').trim();
  return key.slice(0, 120) || 'unknown';
}

function ensureTaskStats(task) {
  const key = taskKey(task);
  if (state.tasks[key]) return state.tasks[key];
  const keys = Object.keys(state.tasks);
  if (keys.length >= MAX_TASKS) {
    // Object insertion order makes this a simple bounded LRU-like ring: a
    // repeated task is moved to the newest position below, so the oldest idle
    // task is evicted first.
    delete state.tasks[keys[0]];
  }
  state.tasks[key] = emptyStats();
  return state.tasks[key];
}

function addEvent(stats, event) {
  if (event.requested) stats.requested += 1;
  if (event.cacheWriteInputTokens > 0) stats.writes += 1;
  if (event.cacheReadInputTokens > 0) stats.hits += 1;
  stats.cacheReadInputTokens += event.cacheReadInputTokens;
  stats.cacheWriteInputTokens += event.cacheWriteInputTokens;
  stats.uncachedInputTokens += event.uncachedInputTokens;
  stats.lastEvent = event;
}

/**
 * Record a completed Claude message response.
 *
 * `input_tokens` is Anthropic's non-cached input count when prompt caching is
 * active, hence the deliberately explicit `uncachedInputTokens` label here.
 */
export function recordClaudeCacheUsage({ task = null, model = null, cachedPrefix = null, usage = null, ts = Date.now() } = {}) {
  const event = {
    task: taskKey(task),
    model: model ? String(model).slice(0, 160) : null,
    // Match buildCachedUserContent(): an empty prefix creates no cache-control
    // block, so it must not be counted as a cache request.
    requested: !!cachedPrefix,
    cacheReadInputTokens: finiteTokenCount(usage?.cache_read_input_tokens),
    cacheWriteInputTokens: finiteTokenCount(usage?.cache_creation_input_tokens),
    uncachedInputTokens: finiteTokenCount(usage?.input_tokens),
    ts: Number.isFinite(Number(ts)) ? Number(ts) : null,
  };
  const taskStats = ensureTaskStats(task);
  // Refresh an existing task's insertion position before the next eviction.
  delete state.tasks[event.task];
  state.tasks[event.task] = taskStats;
  addEvent(state, event);
  addEvent(taskStats, event);
}

function snapshotStats(stats) {
  return {
    requested: stats.requested,
    writes: stats.writes,
    hits: stats.hits,
    cacheReadInputTokens: stats.cacheReadInputTokens,
    cacheWriteInputTokens: stats.cacheWriteInputTokens,
    uncachedInputTokens: stats.uncachedInputTokens,
    lastEvent: stats.lastEvent ? { ...stats.lastEvent } : null,
  };
}

/** Return a copy so report/UI consumers cannot mutate live accounting. */
export function getClaudeCacheTelemetry() {
  const totals = snapshotStats(state);
  return {
    ...totals,
    tasks: Object.fromEntries(Object.entries(state.tasks).map(([task, stats]) => [task, snapshotStats(stats)])),
  };
}

// Test-only reset. Runtime telemetry intentionally lives only for this process.
export function _resetClaudeCacheTelemetry() {
  Object.assign(state, emptyStats(), { tasks: {} });
}
