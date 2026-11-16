// Process-local timing receipts for "the app feels slow" reports. Numbers and
// fixed labels only: no canvas content, ids, paths or text are retained.

const MAIN_KINDS = Object.freeze({
  'main-stall': 'App process could not respond (delays every button that asks the app for something)',
  'save-serialize': 'Auto-save: turning the canvas into text on the app process (blocks it)',
  'save-compress': 'Auto-save: removing repeated content and proving it restores (worker thread, does not block)',
  'save-compress-fallback': 'Auto-save: the same work done on the app process because the worker failed (blocks it)',
  'save-request': 'Auto-save: whole request inside the app process, including the disk write',
});
const RENDERER_KINDS = Object.freeze({
  stall: 'Window could not respond (what a person feels as lag)',
  'undo-snapshot': 'Recording an undo step after an edit (blocks the window)',
  'save-prepare': 'Auto-save: gathering the canvas (blocks the window)',
  'save-handoff': 'Auto-save: handing the canvas to the app process (blocks the window)',
  'save-total': 'Auto-save: start to confirmed write (does not block)',
});
const KEEP_PER_KIND = 30;
const SHOWN_PER_KIND = 8;
const STALL_SAMPLE_MS = 100;
const STALL_MINIMUM_MS = 200;

const rings = new Map(Object.keys(MAIN_KINDS).map(kind => [kind, []]));
const totals = new Map(Object.keys(MAIN_KINDS).map(kind => [kind, { count: 0, worstMs: 0 }]));
const startedAt = Date.now();

export function recordMainPerf(kind, ms, megabytes = null) {
  const ring = rings.get(kind);
  const duration = Math.round(Number(ms));
  if (!ring || !Number.isFinite(duration) || duration < 0) return;
  const total = totals.get(kind);
  total.count += 1;
  total.worstMs = Math.max(total.worstMs, duration);
  ring.push({ at: Date.now(), ms: duration, ...(Number.isFinite(megabytes) ? { mb: Math.round(megabytes * 10) / 10 } : {}) });
  if (ring.length > KEEP_PER_KIND) ring.shift();
}

// A timer that fires late means the app process was busy that whole time.
let lastTick = Date.now();
const stallTimer = setInterval(() => {
  const now = Date.now();
  const late = now - lastTick - STALL_SAMPLE_MS;
  lastTick = now;
  if (late >= STALL_MINIMUM_MS) recordMainPerf('main-stall', late);
}, STALL_SAMPLE_MS);
stallTimer.unref?.();

function cleanRecord(record) {
  const at = Number(record?.at);
  const ms = Number(record?.ms);
  if (!Number.isFinite(at) || !Number.isFinite(ms) || ms < 0) return null;
  const size = Number.isInteger(record?.nodes) && record.nodes >= 0 ? ` · ${record.nodes} nodes on the open level`
    : Number.isFinite(record?.mb) ? ` · ${record.mb} MB` : '';
  return { at, text: `${new Date(at).toISOString()} · ${Math.round(ms)} ms${size}` };
}

function kindLines(label, total, records) {
  const rows = (Array.isArray(records) ? records : []).map(cleanRecord).filter(Boolean)
    .sort((a, b) => b.at - a.at).slice(0, SHOWN_PER_KIND);
  const count = Number.isInteger(total?.count) && total.count >= 0 ? total.count : rows.length;
  const worst = Number.isFinite(total?.worstMs) ? Math.round(total.worstMs) : 0;
  if (!count) return [`- **${label}:** none recorded.`];
  return [`- **${label}:** ${count} recorded · worst ${worst} ms · newest first:`, ...rows.map(row => `  - ${row.text}`)];
}

const minutes = ms => (Number.isFinite(ms) && ms >= 0 ? `${Math.round(ms / 60000)} min` : 'unknown time');

/** `rendererPerf` is the window's own snapshot; only numbers are read from it. */
export function performanceDiagnosticsMarkdown(rendererPerf = null) {
  const lines = ['', '## Performance (PERF)',
    '> Timings only, this app run only; no canvas content, ids or paths. A window stall of a few hundred ms is a visible hitch. Stalls under 150 ms (window) or 200 ms (app process) and undo steps under 30 ms are not recorded. Each kind keeps its newest 30 and shows 8; the count and worst cover the whole run.',
    `- Window observed for ${minutes(Number(rendererPerf?.observedForMs))} · stall detection: ${['active', 'unsupported', 'unavailable'].includes(rendererPerf?.stallObserver) ? rendererPerf.stallObserver : 'not reported'}.`];
  for (const [kind, label] of Object.entries(RENDERER_KINDS)) {
    const entry = rendererPerf?.kinds?.[kind];
    lines.push(...kindLines(label, entry, entry?.recent));
  }
  lines.push(`- App process observed for ${minutes(Date.now() - startedAt)}.`);
  for (const [kind, label] of Object.entries(MAIN_KINDS)) {
    lines.push(...kindLines(label, totals.get(kind), rings.get(kind)));
  }
  return `${lines.join('\n')}\n`;
}
