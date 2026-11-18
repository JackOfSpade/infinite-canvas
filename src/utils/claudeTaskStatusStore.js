// One shared view of the Claude worker's status for every component that shows
// it. A closed dock asks for nothing.
const POLL_MS = 5000;
const IDLE = Object.freeze({ paused: false, pauseCode: null, searchNotice: null });

let snapshot = IDLE;
const listeners = new Set();
let timer = null;
let pollers = 0;

function api() {
  try { return globalThis.window?.electronAPI || null; } catch { return null; }
}

export function getClaudeTaskStatus() { return snapshot; }

export function applyClaudeTaskStatus(raw) {
  const next = raw && typeof raw === 'object'
    ? Object.freeze({
      paused: raw.paused === true,
      pauseCode: typeof raw.pauseCode === 'string' ? raw.pauseCode : null,
      // A line about a web-search service that is limited (Parallel Search), shown beside the pause notice.
      searchNotice: typeof raw.searchNotice === 'string' && raw.searchNotice.trim() ? raw.searchNotice.trim().slice(0, 300) : null,
    })
    : IDLE;
  if (next.paused === snapshot.paused && next.pauseCode === snapshot.pauseCode && next.searchNotice === snapshot.searchNotice) return snapshot;
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

// Reads the status whenever the first subscriber attaches, so a component that
// only needs to know the worker exists never starts a timer.
export function subscribeClaudeTaskStatus(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  if (listeners.size === 1) void refresh();
  return () => { listeners.delete(listener); };
}

// The dock's pause notice also keeps asking, but only while it is on screen.
export function subscribeClaudeTaskStatusPolling(listener) {
  const stop = subscribeClaudeTaskStatus(listener);
  pollers += 1;
  if (pollers === 1) timer = setInterval(refresh, POLL_MS);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    stop();
    pollers -= 1;
    if (pollers === 0 && timer) { clearInterval(timer); timer = null; }
  };
}
