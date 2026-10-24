/**
 * Renderer-side store of local Claude Code runner states for application
 * bundles, keyed by jobId. The runner itself lives in the Electron main
 * process; discovery (useApplicationHandoffDock) writes what ensure/retry/
 * change events report, and applicationDockRequest reads it so the dock can
 * show "Claude is writing this" instead of a paste box.
 */
import { normalizeApplicationProgress } from './applicationProgress.js';

export const CLAUDE_RUN_STATUSES = Object.freeze([
  'running', 'failed', 'done', 'needs-review', 'bridge', 'invalid',
]);

const MESSAGE_LIMIT = 400;

const optionalString = (value) => (typeof value === 'string' && value ? value : '');
const optionalTime = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

/**
 * Pure: the subset of a runner state the dock renders, or null for anything
 * unknown or malformed (so consumers render exactly as before).
 */
export function normalizeClaudeRun(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  const status = state.status;
  if (typeof status !== 'string' || !CLAUDE_RUN_STATUSES.includes(status)) return null;
  const progress = normalizeApplicationProgress(state.progress);
  return {
    status,
    stage: optionalString(state.stage),
    code: optionalString(state.code),
    message: optionalString(state.message).slice(0, MESSAGE_LIMIT),
    updatedAt: optionalTime(state.updatedAt),
    lastActivityAt: optionalTime(state.lastActivityAt),
    ...(optionalTime(state.startedAt) !== null ? { startedAt: state.startedAt } : {}),
    ...(progress ? { progress } : {}),
    ...(['waiting', 'running'].includes(state.activity) ? { activity: state.activity } : {}),
    ...(Number.isSafeInteger(state.activeCalls) && state.activeCalls >= 0 && state.activeCalls <= 100 ? { activeCalls: state.activeCalls } : {}),
    ...(Number.isSafeInteger(state.waitingCalls) && state.waitingCalls >= 0 && state.waitingCalls <= 100 ? { waitingCalls: state.waitingCalls } : {}),
    ...(['same-rule-repeat', 'run-budget'].includes(state.reason) ? { reason: state.reason } : {}),
    ...(Number.isSafeInteger(state.runs) && state.runs > 0 ? { runs: state.runs } : {}),
  };
}

let runs = new Map();
const listeners = new Set();

export function getClaudeApplicationRun(jobId) {
  if (!jobId) return null;
  return runs.get(String(jobId)) || null;
}

/**
 * Store a state for a job. Returns the previous stored state (or null) so a
 * caller can detect transitions. A malformed state clears the entry.
 */
export function setClaudeApplicationRun(jobId, state) {
  if (!jobId) return null;
  const key = String(jobId);
  const previous = runs.get(key) || null;
  const next = normalizeClaudeRun(state);
  if (next) runs.set(key, next);
  else runs.delete(key);
  for (const listener of [...listeners]) {
    try { listener(key, next, previous); } catch { /* a listener must never break the store */ }
  }
  return previous;
}

export function subscribeClaudeApplicationRuns(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// Test seam: the store is module-level.
export function __resetClaudeApplicationRunsForTests() {
  runs = new Map();
  listeners.clear();
}
