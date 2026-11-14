// Clean pause for every Claude call. A held key starts no new call; a call
// already running finishes and saves its answer, because an answer cut off or
// rushed mid-reply is worth nothing. Keys: node:<id> for handoff tasks,
// application:<jobId> for bundles, interview:<runId> for interview preparation.
import { claudeAccountLimitState, clearClaudeAccountLimits, markClaudeAccountLimited } from './claudeAccounts.js';
import { recordClaudePauseEvent } from './claudePauseDiagnostics.js';

// The real account registry, unless a test installs an isolated one.
const accountLayer = { markClaudeAccountLimited, claudeAccountLimitState, clearClaudeAccountLimits };

/** Test seam: run the account switch against a two-account fixture. */
export function setClaudeAccountLayerForTest(layer = null) {
  accountLayer.markClaudeAccountLimited = layer?.markClaudeAccountLimited ?? markClaudeAccountLimited;
  accountLayer.claudeAccountLimitState = layer?.claudeAccountLimitState ?? claudeAccountLimitState;
  accountLayer.clearClaudeAccountLimits = layer?.clearClaudeAccountLimits ?? clearClaudeAccountLimits;
}

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

export function clearClaudeUsageLimit(reason = 'reset-timer') {
  if (usageTimer) clearTimeout(usageTimer);
  usageTimer = null;
  // Resume now is the person asserting usage exists, so per-account limits end too.
  if (reason === 'resume-now') accountLayer.clearClaudeAccountLimits();
  if (!usageLimit) return;
  const pausedMs = Date.now() - usageLimit.since;
  usageLimit = null;
  recordClaudePauseEvent({ kind: 'resumed', reason, pausedMs });
  wakeUsageWaiters();
}

/** The wait for a limit: until its reset when Claude said when, else one probe interval. */
export function claudeUsageWaitMs(resetsAt, now = Date.now()) {
  return Number.isFinite(resetsAt) && resetsAt > now ? resetsAt - now + USAGE_RESET_GRACE_MS : USAGE_PROBE_MS;
}

function armUsageTimer(ms) {
  if (usageTimer) clearTimeout(usageTimer);
  usageTimer = setTimeout(() => clearClaudeUsageLimit('reset-timer'), ms);
  usageTimer.unref?.();
}

const ordinalOf = (accounts, accountId) => {
  const index = accounts.findIndex(account => account.id === accountId);
  return index >= 0 ? index + 1 : null;
};

const earliestReset = limited => limited.reduce(
  (best, item) => (Number.isFinite(item.resetsAt) && (best === null || item.resetsAt < best) ? item.resetsAt : best),
  null,
);

export function reportClaudeUsageLimit({ resetsAt = null, task = null, accountId = null, limitType = null } = {}) {
  const now = Date.now();
  // The reporting account is marked first: the switch below can only be as good as that state.
  const marked = accountLayer.markClaudeAccountLimited(accountId, { resetsAt, limitType });
  const state = accountLayer.claudeAccountLimitState();
  if (state.eligible.length > 0) {
    // Another signed-in account has usage, so nothing pauses; the next call runs there.
    recordClaudePauseEvent({
      kind: 'account-switch',
      limitType: marked.limitType,
      fromIndex: ordinalOf(state.accounts, marked.accountId),
      toIndex: ordinalOf(state.accounts, state.activeId),
      accountCount: state.accountCount,
    });
    wakeUsageWaiters();
    return { paused: false };
  }
  const resumeAt = Math.min(...state.limited.map(item => item.limitedUntil));
  // Later failures from calls already running can only extend a known reset.
  if (usageLimit && usageLimit.resumeAt >= resumeAt) return { paused: true, resumeAt: usageLimit.resumeAt };
  usageLimit = {
    since: usageLimit?.since ?? now,
    resumeAt,
    resetsAt: earliestReset(state.limited),
    limitType: marked.limitType,
    accountCount: state.accountCount,
  };
  armUsageTimer(resumeAt - now);
  recordClaudePauseEvent({ kind: 'usage-limit', code: 'CLAUDE_USAGE_LIMIT', resetsAt: usageLimit.resetsAt, resumeAt, task, limitType: usageLimit.limitType, accountCount: state.accountCount });
  notify();
  return { paused: true, resumeAt };
}

/** After system sleep timers are unreliable, so the wall clock decides whether the limit is over. */
export function recheckClaudeUsageAfterWake(now = Date.now()) {
  if (!usageLimit) { recordClaudePauseEvent({ kind: 'wake-recheck', outcome: 'not-limited', remainingMs: 0 }); return; }
  if (now >= usageLimit.resumeAt) {
    clearClaudeUsageLimit('wake-recheck');
    recordClaudePauseEvent({ kind: 'wake-recheck', outcome: 'cleared', remainingMs: 0 });
    return;
  }
  const remainingMs = usageLimit.resumeAt - now;
  armUsageTimer(remainingMs);
  recordClaudePauseEvent({ kind: 'wake-recheck', outcome: 'rearmed', remainingMs });
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
