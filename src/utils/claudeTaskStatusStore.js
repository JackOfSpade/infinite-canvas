// One shared view of the Claude worker's status for every component that shows
// it. A closed dock asks for nothing.
const POLL_MS = 5000;
const IDLE = Object.freeze({ active: false, paused: false, pauseCode: null });

let snapshot = IDLE;
const listeners = new Set();
let timer = null;
let pollers = 0;
let loaded = false;

function api() {
  try { return globalThis.window?.electronAPI || null; } catch { return null; }
}

export function getClaudeTaskStatus() { return snapshot; }

export function applyClaudeTaskStatus(raw) {
  const next = raw && typeof raw === 'object'
    ? Object.freeze({ active: raw.active === true, paused: raw.paused === true, pauseCode: typeof raw.pauseCode === 'string' ? raw.pauseCode : null })
    : IDLE;
  if (next.active === snapshot.active && next.paused === snapshot.paused && next.pauseCode === snapshot.pauseCode) return snapshot;
  snapshot = next;
  for (const listener of [...listeners]) { try { listener(); } catch { /* one subscriber cannot stop the rest */ } }
  return snapshot;
}

async function refresh() {
  try {
    const read = api()?.getClaudeTaskStatus;
    if (typeof read === 'function') applyClaudeTaskStatus(await read());
  } catch { /* the last status stands until the next poll */ }
}

// Reads the status once when something first subscribes, so a component that
// only needs to know the worker exists never starts a timer.
export function subscribeClaudeTaskStatus(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  if (!loaded) { loaded = true; void refresh(); }
  return () => { listeners.delete(listener); };
}

// The dock's pause notice also keeps asking, but only while it is on screen.
export function subscribeClaudeTaskStatusPolling(listener) {
  const stop = subscribeClaudeTaskStatus(listener);
  pollers += 1;
  if (pollers === 1) timer = setInterval(refresh, POLL_MS);
  return () => {
    stop();
    pollers -= 1;
    if (pollers === 0 && timer) { clearInterval(timer); timer = null; }
  };
}
