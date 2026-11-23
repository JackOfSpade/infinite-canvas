// Bounded timing receipts for "the app feels slow" reports. Numbers and fixed
// labels only: no canvas content, ids, paths or text are ever recorded.
//
// - stall:          the window could not respond for this long (browser long task)
// - undo-snapshot:  time to record an undo step after an edit settles
// - save-prepare:   time to gather and clean the canvas for an auto-save
// - save-handoff:   the LONGEST single stretch the window was blocked while
//                   handing the canvas over (encoding, or one copy call); a save
//                   makes several, so this is not their sum
// - save-total:     whole auto-save attempt, from gathering to the app process's
//                   reply; it includes the blocked stretches above, with the
//                   window free to paint in between
// A stall is stamped when it was reported, which is just after it ended.
export const RENDERER_PERF_KINDS = Object.freeze(['stall', 'undo-snapshot', 'save-prepare', 'save-handoff', 'save-total']);
const KEEP_PER_KIND = 30;
// Below these a record is noise; save timings are always kept.
const MINIMUM_MS = { stall: 150, 'undo-snapshot': 30 };

const rings = new Map(RENDERER_PERF_KINDS.map(kind => [kind, []]));
const totals = new Map(RENDERER_PERF_KINDS.map(kind => [kind, { count: 0, worstMs: 0 }]));
const startedAt = Date.now();

// What a save sent: counts and one fixed type word only (see autosaveSender).
function cleanSent(sent) {
  const count = value => (Number.isInteger(value) && value >= 0 ? value : null);
  const records = count(sent?.records);
  const parts = count(sent?.parts);
  const calls = count(sent?.calls);
  if (records === null || parts === null || calls === null) return null;
  const largest = typeof sent.largest === 'string' && /^[a-z]{1,24}$/.test(sent.largest) ? sent.largest : null;
  return { records, parts, calls, ...(largest ? { largest } : {}), ...(sent.whole === true ? { whole: true } : {}) };
}

export function recordPerf(kind, ms, nodeCount = null, sent = null) {
  const ring = rings.get(kind);
  const duration = Math.round(Number(ms));
  if (!ring || !Number.isFinite(duration) || duration < (MINIMUM_MS[kind] ?? 0)) return;
  const total = totals.get(kind);
  total.count += 1;
  total.worstMs = Math.max(total.worstMs, duration);
  const sentSummary = cleanSent(sent);
  ring.push({
    at: Date.now(), ms: duration,
    ...(Number.isInteger(nodeCount) ? { nodes: nodeCount } : {}),
    ...(sentSummary ? { sent: sentSummary } : {}),
  });
  if (ring.length > KEEP_PER_KIND) ring.shift();
}

/** Runs `fn`, records how long it blocked, and returns its result. */
export function timePerf(kind, fn, nodeCount = null) {
  const start = performance.now();
  try {
    return fn();
  } finally {
    recordPerf(kind, performance.now() - start, nodeCount);
  }
}

export function perfDiagnosticsSnapshot() {
  return {
    observedForMs: Date.now() - startedAt,
    stallObserver: stallObserverState,
    kinds: Object.fromEntries(RENDERER_PERF_KINDS.map(kind => [kind, {
      ...totals.get(kind),
      recent: rings.get(kind).slice(),
    }])),
  };
}

let stallObserverState = 'unavailable';
if (typeof PerformanceObserver === 'function') {
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) recordPerf('stall', entry.duration);
    }).observe({ type: 'longtask', buffered: true });
    stallObserverState = 'active';
  } catch {
    stallObserverState = 'unsupported';
  }
}
