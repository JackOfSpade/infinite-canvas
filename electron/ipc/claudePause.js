// Clean pause for every Claude call. A held key starts no new call; a call
// already running finishes and saves its answer, because an answer cut off or
// rushed mid-reply is worth nothing. Keys: node:<id> for handoff tasks,
// application:<jobId> for bundles, interview:<runId> for interview preparation.
const KEY_RE = /^(node|application|interview):\S{1,300}$/u;
const holds = new Set();
const listeners = new Set();
const waiters = new Map();

function notify() {
  for (const listener of [...listeners]) { try { listener(); } catch { /* a listener cannot stop a release */ } }
}

export const isClaudePauseKey = key => typeof key === 'string' && KEY_RE.test(key);
export const isClaudeHeld = key => holds.has(key);
export const heldClaudeKeys = () => [...holds];

export function holdClaude(key) {
  if (!isClaudePauseKey(key) || holds.has(key)) return;
  holds.add(key);
  notify();
}

export function releaseClaude(key) {
  if (!holds.delete(key)) return;
  for (const wake of [...(waiters.get(key) || [])]) wake();
  notify();
}

export function subscribeClaudeHolds(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Resolves at once unless the key is held; an abort ends the wait so a discard still works. */
export function waitForClaudeRelease(key, signal) {
  if (!holds.has(key) || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const set = waiters.get(key) || new Set();
    waiters.set(key, set);
    const wake = () => {
      set.delete(wake);
      if (!set.size) waiters.delete(key);
      signal?.removeEventListener?.('abort', wake);
      resolve();
    };
    set.add(wake);
    signal?.addEventListener?.('abort', wake, { once: true });
  });
}

// Calls outside the task worker report here, so a drain can wait for them too.
const runningCalls = new Map();
const callDrains = new Map();

export function trackClaudeCall(key) {
  runningCalls.set(key, (runningCalls.get(key) || 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const left = runningCalls.get(key) - 1;
    if (left > 0) { runningCalls.set(key, left); return; }
    runningCalls.delete(key);
    for (const resolve of callDrains.get(key) || []) resolve();
    callDrains.delete(key);
  };
}

/** Resolves once no tracked call for this key is still running. */
export function drainClaudeCalls(key) {
  if (!runningCalls.has(key)) return Promise.resolve();
  return new Promise((resolve) => {
    const set = callDrains.get(key) || new Set();
    callDrains.set(key, set);
    set.add(resolve);
  });
}

// A usage limit stops every Claude call at once. Accepted answers are already
// saved, so nothing is torn down: all work waits here and continues at the reset.
const USAGE_PROBE_MS = 10 * 60_000;
const USAGE_RESET_GRACE_MS = 60_000;
let usageLimit = null;
let usageTimer = null;
const usageWaiters = new Set();

function wakeUsageWaiters() {
  for (const wake of [...usageWaiters]) wake();
  notify();
}

export const claudeUsageLimit = () => usageLimit;

export function clearClaudeUsageLimit() {
  if (usageTimer) clearTimeout(usageTimer);
  usageTimer = null;
  if (!usageLimit) return;
  usageLimit = null;
  wakeUsageWaiters();
}

/** The wait for a limit: until its reset when Claude said when, else one probe interval. */
export function claudeUsageWaitMs(resetsAt, now = Date.now()) {
  return Number.isFinite(resetsAt) && resetsAt > now ? resetsAt - now + USAGE_RESET_GRACE_MS : USAGE_PROBE_MS;
}

export function reportClaudeUsageLimit({ resetsAt = null } = {}) {
  const now = Date.now();
  const resumeAt = now + claudeUsageWaitMs(resetsAt, now);
  // Later failures from calls already running can only extend a known reset.
  if (usageLimit && usageLimit.resumeAt >= resumeAt) return;
  usageLimit = { since: usageLimit?.since ?? now, resumeAt, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null };
  if (usageTimer) clearTimeout(usageTimer);
  usageTimer = setTimeout(clearClaudeUsageLimit, resumeAt - now);
  usageTimer.unref?.();
  notify();
}

export function waitForClaudeUsage(signal) {
  if (!usageLimit || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const wake = () => {
      usageWaiters.delete(wake);
      signal?.removeEventListener?.('abort', wake);
      resolve();
    };
    usageWaiters.add(wake);
    signal?.addEventListener?.('abort', wake, { once: true });
  });
}
