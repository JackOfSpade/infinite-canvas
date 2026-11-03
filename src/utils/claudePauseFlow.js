// One Pause & save flow for every panel: hold new Claude calls, let running ones
// finish and save their answers, then let the owner save its checkpoint. It lives
// outside React so switching handoffs in the dock cannot lose a pause in progress.
const flows = new Map();
const listeners = new Set();
const IDLE = Object.freeze({ phase: 'idle', error: null });

function api() {
  try { return globalThis.window?.electronAPI || null; } catch { return null; }
}

function setFlow(key, flow) {
  if (flow) flows.set(key, Object.freeze(flow)); else flows.delete(key);
  for (const listener of [...listeners]) { try { listener(); } catch { /* one subscriber cannot stop the rest */ } }
}

export const claudeNodePauseKey = nodeId => `node:${nodeId}`;
export const claudeApplicationPauseKey = jobId => `application:${jobId}`;
export const claudeInterviewPauseKey = runId => `interview:${runId}`;

export function getClaudePauseFlow(key) { return flows.get(key) || IDLE; }

export function subscribeClaudePauseFlows(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * keys[0] names the flow. onSave is the owner's durable save, or null for work
 * with no checkpoint of its own: that work stays held until Resume.
 */
export async function startClaudePause(keys, onSave = null) {
  const [key] = keys;
  if (getClaudePauseFlow(key).phase === 'finishing' || getClaudePauseFlow(key).phase === 'saving') return;
  setFlow(key, { phase: 'finishing', error: null });
  try {
    for (const each of keys) await api()?.holdClaude?.(each);
    await Promise.all(keys.map(each => api()?.drainClaude?.(each)));
    if (!onSave) { setFlow(key, { phase: 'paused', error: null }); return; }
    setFlow(key, { phase: 'saving', error: null });
    const result = await onSave();
    // Only a confirmed save may release the hold.
    if (result?.success !== true) throw new Error(result?.error || 'The save could not be confirmed.');
    for (const each of keys) await api()?.releaseClaude?.(each);
    setFlow(key, null);
  } catch (error) {
    // Still held: a failed save must not quietly start spending again.
    setFlow(key, { phase: 'paused', error: error?.message || 'The save could not be confirmed.' });
  }
}

/** Skip the wait: running calls end now and are asked again on resume. */
export function stopRunningClaude(keys) {
  for (const each of keys) void api()?.stopRunningClaude?.(each);
}

export async function resumeClaude(keys) {
  for (const each of keys) await api()?.releaseClaude?.(each);
  setFlow(keys[0], null);
}

// Test seam: flows are module-level.
export function __resetClaudePauseFlowsForTests() {
  flows.clear();
  listeners.clear();
}
