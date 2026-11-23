// Process-local timing receipts for "the app feels slow" reports. Numbers and
// fixed labels only: no canvas content, ids, paths or text are retained.

const MAIN_KINDS = Object.freeze({
  'main-stall': 'App process could not respond (delays every button that asks the app for something)',
  'save-serialize': 'Auto-save: turning the canvas into text on the app process (blocks it)',
  'save-compress': 'Auto-save: removing repeated content and proving it restores (separate process, does not block the app)',
  'save-compress-unpooled': 'Auto-save: separate process finished but kept the plain form (nothing repeated, or the pooled form did not restore identically)',
  'save-compress-failed': 'Auto-save: separate process failed; saved without removing repeated content',
  'save-request': 'Auto-save: whole request inside the app process, including the disk write',
});
const RENDERER_KINDS = Object.freeze({
  stall: 'Window could not respond (what a person feels as lag)',
  'undo-snapshot': 'Recording an undo step after an edit (blocks the window)',
  'save-prepare': 'Auto-save: gathering the canvas (blocks the window)',
  'save-handoff': 'Auto-save: longest single blocked stretch handing the canvas to the app process (one copy call; a save makes several, so this is not their sum)',
  'save-total': 'Auto-save: whole attempt, from gathering the canvas to the app process\'s reply (includes the blocked stretches; the window can paint in between)',
});
// Fixed reason codes a kind may carry; anything else is dropped.
const MAIN_KIND_REASONS = Object.freeze({
  'save-compress-failed': Object.freeze(['timeout', 'exit', 'no-result', 'other']),
});
// Node type words a receipt may name; the window sends the same list.
const SENT_LARGEST = new Set(['document', 'text', 'group', 'link', 'jobcard', 'jobhub', 'jobboard', 'sellhub',
  'marketplacecard', 'marketplacestatus', 'compsourcecard', 'jobsourcecard', 'jobgroup', 'part', 'other']);
// Kinds stamped when the stall was reported, which is just after it ended.
const ENDED_KINDS = new Set(['main-stall', 'stall']);
const KEEP_PER_KIND = 30;
const SHOWN_PER_KIND = 8;
const STALL_SAMPLE_MS = 100;
const STALL_MINIMUM_MS = 200;

const rings = new Map(Object.keys(MAIN_KINDS).map(kind => [kind, []]));
const totals = new Map(Object.keys(MAIN_KINDS).map(kind => [kind, {
  count: 0, worstMs: 0, ...(MAIN_KIND_REASONS[kind] ? { reasons: {} } : {}),
}]));
const startedAt = Date.now();

/** `reason` is kept only when it is one of the kind's fixed codes. */
export function recordMainPerf(kind, ms, megabytes = null, reason = null) {
  const ring = rings.get(kind);
  const duration = Math.round(Number(ms));
  if (!ring || !Number.isFinite(duration) || duration < 0) return;
  const total = totals.get(kind);
  total.count += 1;
  total.worstMs = Math.max(total.worstMs, duration);
  const code = MAIN_KIND_REASONS[kind]?.includes(reason) ? reason : null;
  if (code) total.reasons[code] = (total.reasons[code] || 0) + 1;
  ring.push({
    at: Date.now(), ms: duration,
    ...(Number.isFinite(megabytes) ? { mb: Math.round(megabytes * 10) / 10 } : {}),
    ...(code ? { reason: code } : {}),
  });
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

const REASON_CODES = new Set(Object.values(MAIN_KIND_REASONS).flat());

function reasonSummary(reasons) {
  if (!reasons || typeof reasons !== 'object') return '';
  const parts = [...REASON_CODES]
    .filter(code => Number.isInteger(reasons[code]) && reasons[code] > 0)
    .map(code => `${code} ${reasons[code]}`);
  return parts.length ? ` · by reason: ${parts.join(', ')}` : '';
}

function sentSummary(sent) {
  const count = value => (Number.isInteger(value) && value >= 0 ? value : null);
  const records = count(sent?.records);
  const parts = count(sent?.parts);
  const calls = count(sent?.calls);
  if (records === null || parts === null || calls === null) return '';
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const what = sent.whole === true ? 'the whole canvas' : `${plural(records, 'record')} (${plural(parts, 'part')})`;
  const largest = SENT_LARGEST.has(sent.largest) ? ` · largest: ${sent.largest}` : '';
  return ` · sent ${what} in ${plural(calls, 'call')}${largest}`;
}

function cleanRecord(record) {
  const at = Number(record?.at);
  const ms = Number(record?.ms);
  if (!Number.isFinite(at) || !Number.isFinite(ms) || ms < 0) return null;
  const size = Number.isInteger(record?.nodes) && record.nodes >= 0 ? ` · ${record.nodes} nodes on the open level`
    : Number.isFinite(record?.mb) ? ` · ${record.mb} MB` : '';
  const sent = sentSummary(record?.sent);
  const reason = REASON_CODES.has(record?.reason) ? ` · ${record.reason}` : '';
  return { at, text: `${new Date(at).toISOString()} · ${Math.round(ms)} ms${size}${sent}${reason}` };
}

function kindLines(label, total, records, endedNote = '') {
  const rows = (Array.isArray(records) ? records : []).map(cleanRecord).filter(Boolean)
    .sort((a, b) => b.at - a.at).slice(0, SHOWN_PER_KIND);
  const count = Number.isInteger(total?.count) && total.count >= 0 ? total.count : rows.length;
  const worst = Number.isFinite(total?.worstMs) ? Math.round(total.worstMs) : 0;
  if (!count) return [`- **${label}:** none recorded.`];
  return [`- **${label}:** ${count} recorded · worst ${worst} ms${reasonSummary(total?.reasons)} · newest first${endedNote}:`, ...rows.map(row => `  - ${row.text}`)];
}

const minutes = ms => (Number.isFinite(ms) && ms >= 0 ? `${Math.round(ms / 60000)} min` : 'unknown time');

/** `rendererPerf` is the window's own snapshot; only numbers are read from it. */
export function performanceDiagnosticsMarkdown(rendererPerf = null) {
  const lines = ['', '## Performance (PERF)',
    '> Timings only, this app run only; no canvas content, ids or paths. A window stall of a few hundred ms is a visible hitch. Stalls under 150 ms (window) or 200 ms (app process) and undo steps under 30 ms are not recorded. Each kind keeps its newest 30 and shows 8; the count and worst cover the whole run.',
    `- Window observed for ${minutes(Number(rendererPerf?.observedForMs))} · stall detection: ${['active', 'unsupported', 'unavailable'].includes(rendererPerf?.stallObserver) ? rendererPerf.stallObserver : 'not reported'}.`];
  for (const [kind, label] of Object.entries(RENDERER_KINDS)) {
    const entry = rendererPerf?.kinds?.[kind];
    lines.push(...kindLines(label, entry, entry?.recent, ENDED_KINDS.has(kind) ? ' · each time is when the stall ended' : ''));
  }
  lines.push(`- App process observed for ${minutes(Date.now() - startedAt)}.`);
  for (const [kind, label] of Object.entries(MAIN_KINDS)) {
    lines.push(...kindLines(label, totals.get(kind), rings.get(kind), ENDED_KINDS.has(kind) ? ' · each time is when the stall ended' : ''));
  }
  return `${lines.join('\n')}\n`;
}
