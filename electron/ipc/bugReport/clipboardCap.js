// Shared markdown blocks for Report an Issue exports, plus the clipboard-export
// budget enforcement (enforceClipboardMarkdownCap) that "Copy to clipboard" runs
// on top of them. "Save to file" always calls the plain block builders below
// directly and stays uncapped — it is the promised complete artifact. The
// ordering contract the cap depends on is the whole point:
//
//   baseMarkdown (curated static sections, usually ending in the large Node
//   Diagnostics / media / image dumps)  +  Recent Main-Process Logs  +
//   Event History
//
// The logs + most-recent event timeline are the highest-value real-time
// evidence ("did the run finish / what errored"), so they must NOT be the first
// thing sacrificed when a big canvas makes the static base overflow the budget.
//
// ── Ordering contract the trimming code below assumes ──────────────────────
// Every array this module receives (`eventLines`, `mainProcessLogLines`, and
// whatever `truncateBaseForClipboard`/`enforceClipboardMarkdownCap` are handed)
// is CHRONOLOGICAL — oldest entry first, newest entry last — all the way through
// folding and trimming. Display-order reversal (newest-first) happens ONLY at
// the final render step, inside `buildMainProcessLogsMarkdown` /
// `buildReverseChronologicalLogBlock`. This means "drop the oldest entry" is
// always "drop from the FRONT of the array" (see `openTailWindow.dropOldest`),
// regardless of how the block eventually reads on screen. Do not feed an
// already-reversed array into any function below — it would silently start
// shedding the newest evidence instead of the oldest.

export function buildFencedTextBlock(lines, emptyFallback) {
  if (!Array.isArray(lines) || lines.length === 0) return `${emptyFallback}\n`;
  return `\`\`\`text\n${lines.join('\n')}\n\`\`\`\n`;
}

// Existing report rows may carry the current full ISO stamp, pre-hardening
// time-only stamps (with or without milliseconds), or a legacy resize/fold
// range. All are capture-time evidence and must never receive a second,
// misleading export-time prefix.
const ISO_TIMESTAMP = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?(?:Z|[+-]\\d{2}:\\d{2})';
const TIME_OF_DAY_TIMESTAMP = '\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?';
const DISPLAY_TIMESTAMP = new RegExp(
  `^\\[(?:${ISO_TIMESTAMP}|${TIME_OF_DAY_TIMESTAMP})(?:(?:–|-)(?:${ISO_TIMESTAMP}|${TIME_OF_DAY_TIMESTAMP}))?\\]\\s`
);

function timestampPart(value, width = 2) {
  return String(value).padStart(width, '0');
}

export function localIsoTimestampWithOffset(date) {
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);
  return `${timestampPart(date.getFullYear(), 4)}-${timestampPart(date.getMonth() + 1)}-${timestampPart(date.getDate())}`
    + `T${timestampPart(date.getHours())}:${timestampPart(date.getMinutes())}:${timestampPart(date.getSeconds())}.${timestampPart(date.getMilliseconds(), 3)}`
    + `${offsetSign}${timestampPart(Math.floor(absoluteOffset / 60))}:${timestampPart(absoluteOffset % 60)}`;
}

export function utcIsoTimestamp(date) {
  return date.toISOString();
}

// Logger-originated entries already carry their capture timestamp. Legacy and
// mocked payload rows do not; give only those a clearly-labelled export-time
// stamp so every rendered log row has a time anchor without forging capture
// history for rows that already recorded one.
export function timestampedLogLines(lines, { basis = 'local', now = Date.now() } = {}) {
  const source = Array.isArray(lines) ? lines : [];
  const proposedDate = new Date(Number.isFinite(Number(now)) ? Number(now) : Date.now());
  const date = Number.isFinite(proposedDate.getTime()) ? proposedDate : new Date();
  const timestamp = basis === 'utc' ? utcIsoTimestamp(date) : localIsoTimestampWithOffset(date);
  return source.map((value) => {
    const line = String(value ?? '');
    return DISPLAY_TIMESTAMP.test(line)
      ? line
      : `[${timestamp}] (timestamp assigned at report export) ${line}`;
  });
}

// Keep arrays chronological through filtering and any future retention logic:
// `last N` then means the actual newest N. Reverse only at the shared display
// boundary, so every export reads newest-first while shedding tail entries
// always loses the oldest evidence.
export function newestFirstLogLines(lines) {
  return Array.isArray(lines) ? [...lines].reverse() : [];
}

export function buildReverseChronologicalLogBlock(lines, emptyFallback, { basis = 'local' } = {}) {
  return buildFencedTextBlock(newestFirstLogLines(timestampedLogLines(lines, { basis })), emptyFallback);
}

export function buildMainProcessLogsMarkdown(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return '';
  return `
## Recent Main-Process Logs
> Up to 200 lines from the main process's logger (ring buffer). Use this to
> see what \`[Accounts]\` / \`[StealthBrowser]\` / \`[Marketplace]\` actually
> did and any errors that were swallowed by an IPC handler before the
> renderer got a useful response.
> **Order within this section:** newest first; last row is the oldest retained main-process entry. **Timestamps:** full ISO UTC. Legacy time-only rows retain their capture time but omit date and offset.

\`\`\`
${newestFirstLogLines(timestampedLogLines(lines, { basis: 'utc' })).join('\n')}
\`\`\`
`;
}

// Event history originates in the renderer, whose display timestamps are local
// to the user. Keep the time-basis note adjacent to the history itself.
export const EVENT_HISTORY_HEADING = '## Event History\n> **Order within this section:** newest first; last row is the oldest retained renderer event. **Timestamps:** full local ISO with numeric UTC offset. Legacy time-only rows retain their capture time but omit date and offset. See Runtime Identity for the report date, IANA timezone, and UTC offset.\n';

// ─────────────────────────────────────────────────────────────────────────
// Render-time folding (clipboard path only)
// ─────────────────────────────────────────────────────────────────────────
// The renderer's capture-time collapsers can only merge byte-identical repeats
// and same-id resize runs, so a structural churn burst (one board re-combine
// tears down hundreds of uniquely-id'd nodes in ~2ms) still arrives as hundreds
// of near-identical lines and can eat most of the retained-event budget. Only
// the structural verbs below fold; errors and module chatter always pass
// through verbatim. Save-to-file never calls this — `node removed id=` lines
// are the primary evidence for "my card disappeared" reports, so every raw id
// must survive there.
//
// The timestamp capture group accepts EITHER the full ISO (current renderer
// format, with numeric UTC offset) OR the legacy bare `HH:MM:SS.mmm` shape
// (rows captured before the ISO-with-offset hardening) — both are still valid
// capture-time evidence and both must be foldable.
const COLLAPSIBLE = new RegExp(
  `^\\[(${ISO_TIMESTAMP}|${TIME_OF_DAY_TIMESTAMP})\\] (node removed|node added|node resized|node moved|edge added|edge removed)\\b(?:.*?)\\bid=(\\S+)`
);

const MAX_FOLD_PREFIX_CHARS = 96;

// An emitted fold line must never be re-foldable: its timestamp span breaks the
// COLLAPSIBLE anchor, and this signature check is the belt-and-braces guard so
// a second pass over already-folded lines is a no-op.
function isFoldedEventLine(line) {
  return line.includes('×') && line.includes('(id prefix');
}

function commonPrefixOf(a, b) {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return a.slice(0, i);
}

function displayFoldPrefix(prefix) {
  return prefix.length > MAX_FOLD_PREFIX_CHARS
    ? `${prefix.slice(0, MAX_FOLD_PREFIX_CHARS - 1)}…`
    : prefix;
}

// Observation only: no cause is asserted. The first/last ids are carried in
// FULL because they hold the generation stamp that identifies which tree was
// torn down; the shared middle is elided to the run's common prefix.
function formatFoldLine(run) {
  return `[${run.firstTs}–${run.lastTs}] ${run.verb} ×${run.lines.length} `
    + `(id prefix ${displayFoldPrefix(run.prefix)}, first ${run.firstId}, last ${run.lastId})`;
}

export function collapseEventBursts(lines, { minRun = 8, minPrefix = 12 } = {}) {
  const source = Array.isArray(lines) ? lines : [];
  const out = [];
  let foldedLineCount = 0;
  let collapsedRuns = 0;
  let run = null;

  const flush = () => {
    if (!run) return;
    // Short bursts stay verbatim: a 2–7 node deletion is small enough that every
    // id is still worth its bytes.
    if (run.lines.length >= minRun) {
      out.push(formatFoldLine(run));
      foldedLineCount += run.lines.length;
      collapsedRuns++;
    } else {
      out.push(...run.lines);
    }
    run = null;
  };

  for (const raw of source) {
    const line = typeof raw === 'string' ? raw : String(raw ?? '');
    const match = isFoldedEventLine(line) ? null : COLLAPSIBLE.exec(line);
    if (!match) {
      flush();
      out.push(raw);
      continue;
    }
    const [, ts, verb, id] = match;
    // Runs are grown greedily and stay purely data-driven: a run continues only
    // while its ids still share minPrefix chars, so unrelated ids that merely
    // happen to be adjacent can never be summarized as one burst.
    if (run && run.verb === verb) {
      const prefix = commonPrefixOf(run.prefix, id);
      if (prefix.length >= minPrefix) {
        run.prefix = prefix;
        run.lastTs = ts;
        run.lastId = id;
        run.lines.push(raw);
        continue;
      }
    }
    flush();
    run = { verb, prefix: id, firstTs: ts, lastTs: ts, firstId: id, lastId: id, lines: [raw] };
  }
  flush();

  return { lines: out, foldedLineCount, collapsedRuns };
}

// Render-time repeat folding for the main-process log block, CLIPBOARD path
// only — the same last-resort transform `collapseEventBursts` applies to the
// event timeline, which the log block never had. A paginating browser source
// emits one near-identical progress pair per page, so a single deep walk can
// fill most of the retained log budget with rows that differ only in their
// counters (a real report retained 54 of 93 log lines as Glassdoor
// "page N: M new jobs" / "descriptions: M/M expanded" pairs from a run the
// reader was not asking about, while whole diagnostic sections were dropped to
// make room). Only INFO/DEBUG lines fold, and only within one repeated shape:
// WARN and ERROR always pass through verbatim, because a swallowed error is the
// single most valuable line in this block. The first and last few occurrences
// of a folded shape survive so the walk's start, end and extent stay readable.
// Save-to-file never calls this.
//
// Same dual-format timestamp acceptance as COLLAPSIBLE above — main-process
// log rows changed from a bare `HH:MM:SS.mmm` slice to the full ISO-UTC stamp
// (buildRecentMainProcessLogLines), and both shapes can appear in one ring
// buffer if the process has been running across that change.
const LOG_LINE = new RegExp(`^\\[(${ISO_TIMESTAMP}|${TIME_OF_DAY_TIMESTAMP})\\] (\\w+) +(.*)$`);
const FOLDABLE_LEVELS = new Set(['INFO', 'DEBUG', 'LOG']);
const LOG_FOLD_MIN_RUN = 6;
const LOG_FOLD_KEEP_HEAD = 1;
const LOG_FOLD_KEEP_TAIL = 2;
const MAX_LOG_SHAPE_CHARS = 120;

// Digits carry the per-iteration difference (page number, counts, ids); the
// surrounding words are the shape. Collapsing only digit runs keeps two
// genuinely different messages apart while merging one message's repeats.
function logShapeOf(message) {
  return message.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, MAX_LOG_SHAPE_CHARS);
}

// Requires the RANGE form specifically (two timestamps joined by an en dash or
// hyphen) — a single-timestamp log line that happens to contain the literal
// words "repeat(s) elided" as data must never be mistaken for an already-
// folded summary line.
const FOLDED_LOG_RANGE = new RegExp(
  `^\\[(?:${ISO_TIMESTAMP}|${TIME_OF_DAY_TIMESTAMP})(?:–|-)(?:${ISO_TIMESTAMP}|${TIME_OF_DAY_TIMESTAMP})\\] `
);
function isFoldedLogLine(line) {
  return FOLDED_LOG_RANGE.test(line) && line.includes(' repeat(s) elided');
}

export function collapseLogRepeats(lines, {
  minRun = LOG_FOLD_MIN_RUN, keepHead = LOG_FOLD_KEEP_HEAD, keepTail = LOG_FOLD_KEEP_TAIL,
} = {}) {
  const source = Array.isArray(lines) ? lines : [];
  const shapes = new Map(); // shape -> indexes, in order
  for (let i = 0; i < source.length; i++) {
    const line = typeof source[i] === 'string' ? source[i] : String(source[i] ?? '');
    if (isFoldedLogLine(line)) continue;
    const match = LOG_LINE.exec(line);
    if (!match) continue;
    const [, , level, message] = match;
    if (!FOLDABLE_LEVELS.has(level.toUpperCase())) continue;
    const key = `${level.toUpperCase()}|${logShapeOf(message)}`;
    const bucket = shapes.get(key) || [];
    bucket.push(i);
    shapes.set(key, bucket);
  }

  const elided = new Map(); // index of the first elided line -> summary line
  const dropped = new Set();
  let foldedLineCount = 0;
  let collapsedShapes = 0;
  for (const [key, indexes] of shapes) {
    if (indexes.length < minRun) continue;
    const middle = indexes.slice(keepHead, indexes.length - keepTail);
    if (middle.length < minRun - keepHead - keepTail || middle.length === 0) continue;
    const firstTs = LOG_LINE.exec(String(source[middle[0]]))?.[1] || '';
    const lastTs = LOG_LINE.exec(String(source[middle.at(-1)]))?.[1] || '';
    const [level, shape] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
    // Observation only, and it names the shape it stands for so the elision can
    // never be mistaken for a gap in the run itself.
    elided.set(middle[0], `[${firstTs}–${lastTs}] ${level} ×${middle.length} repeat(s) elided — ${shape}`);
    for (const index of middle) dropped.add(index);
    foldedLineCount += middle.length;
    collapsedShapes++;
  }
  if (collapsedShapes === 0) return { lines: source, foldedLineCount: 0, collapsedShapes: 0 };

  const out = [];
  for (let i = 0; i < source.length; i++) {
    if (elided.has(i)) out.push(elided.get(i));
    if (!dropped.has(i)) out.push(source[i]);
  }
  return { lines: out, foldedLineCount, collapsedShapes };
}

// ─────────────────────────────────────────────────────────────────────────
// Static-base truncation (finding where to cut the curated markdown)
// ─────────────────────────────────────────────────────────────────────────

// A hard clipboard cap may land inside ANY large static section (the job
// pipeline's relevance/taxonomy audits can be larger than Node Diagnostics).
// Scans the top-level (## ) headings BEFORE slicing and reports back which
// ones were dropped whole vs. the single one the cut landed inside, so the
// caller can name the real omission instead of presenting a mid-cut section
// as intact. Still prefers a nearby paragraph/line boundary, then appends an
// explicit continuation note, when choosing where to cut.
function truncateBaseForClipboard(baseMarkdown, room) {
  if (room <= 0) return { text: '', droppedSections: [], partialSection: null };
  if (baseMarkdown.length <= room) return { text: baseMarkdown, droppedSections: [], partialSection: null };

  // Collect every top-level heading (with its pre-cut position) before any
  // slicing happens, so the dropped/partial analysis below reflects the
  // original structure, not the truncated candidate.
  const headings = [...baseMarkdown.matchAll(/^## (.+)$/gm)].map((m) => ({ text: m[1], index: m.index }));

  const note = '\n\n> ⚠️ Report content after this point was omitted by the clipboard cap. The recent logs and event timeline continue below; use "Save to file" for every uncapped currently retained section.\n';
  // The base carries fenced blocks (the application diagnostics embed json/html
  // samples). A cut landing INSIDE one leaves the fence unclosed, so the
  // omission note, the logs heading and the whole retained tail render as code
  // — the report then looks intact while its own truncation marker is invisible.
  // Reserve room for a closer up front so balancing one can never push the
  // output past the cap.
  const FENCE_CLOSER = '\n```\n';
  const contentRoom = Math.max(0, room - note.length - FENCE_CLOSER.length);
  if (contentRoom === 0) {
    return { text: note.slice(0, room), droppedSections: headings.map((h) => h.text), partialSection: null };
  }

  const candidate = baseMarkdown.slice(0, contentRoom);
  // Prefer a blank-line boundary close to the cap. Falling back to a newline
  // avoids cutting a telemetry row or URL in half even for dense list output.
  const paragraph = candidate.lastIndexOf('\n\n');
  const line = candidate.lastIndexOf('\n');
  const minimumUsefulCut = Math.floor(contentRoom * 0.8);
  const cut = paragraph >= minimumUsefulCut ? paragraph : (line >= 0 ? line : contentRoom);

  // A heading at/after the cut was removed in full. The heading immediately
  // before the cut is "partial" only when the cut lands strictly inside its
  // body — not when it lines up exactly with the next heading's start (i.e.
  // the cut landed on a boundary, so nothing was cut mid-section).
  const droppedSections = headings.filter((h) => h.index >= cut).map((h) => h.text);
  let partialSection = null;
  for (let i = headings.length - 1; i >= 0; i--) {
    if (headings[i].index >= cut) continue;
    const sectionEnd = i + 1 < headings.length ? headings[i + 1].index : baseMarkdown.length;
    if (cut < sectionEnd) partialSection = headings[i].text;
    break;
  }

  // A `##` cut mid-body can silently take a dozen `###` subsections with it,
  // and the scan above cannot see them — so the notice named the parent as
  // merely "cut mid-section" while whole named diagnostics disappeared with no
  // trace. Report them SEPARATELY from the `##` tally: folding them into the
  // dropped-section count would misreport how many top-level sections were lost.
  const droppedSubsections = [...baseMarkdown.matchAll(/^### (.+)$/gm)]
    .filter((m) => m.index >= cut)
    .map((m) => m[1].trim())
    .filter((name) => !droppedSections.includes(name));

  const retained = candidate.slice(0, cut).trimEnd();
  const unclosedFence = (retained.match(/^ {0,3}```/gm) || []).length % 2 === 1;
  return {
    text: retained + (unclosedFence ? FENCE_CLOSER : '') + note,
    droppedSections,
    partialSection,
    droppedSubsections,
  };
}

// The filter summary is assembled before the clipboard cap runs. When a FULL
// report subsequently sheds old events, its otherwise-accurate selection
// summary ("event log kept all N line(s)") would describe data that is no
// longer present in the copied markdown. Make that distinction explicit in the
// final artifact: FULL selected every raw event, while the clipboard retained
// a post-fold set of rendered lines and may then have trimmed its oldest lines.
function clarifyCappedFilterSummary(baseMarkdown, retainedEvents, renderedEvents, rawEvents, fold = null) {
  // The clipboard can first fold a raw structural burst and only then trim
  // rendered lines. Comparing the post-fold line count directly with the raw
  // count made a fully retained folded timeline read as if events were lost
  // (for example, "retained 145 of 206" when 62 raw removals were represented
  // by one summary and all 145 rendered lines survived). Keep the units honest:
  // raw captured lines are the selection total; rendered lines are the cap's
  // retention unit.
  if (retainedEvents >= renderedEvents && !(fold?.foldedLineCount > 0)) return baseMarkdown;
  return baseMarkdown.replace(
    /event log kept all (\d+) line\(s\)/g,
    (_, selected) => {
      const selection = `event log selected all ${selected} line(s) before clipboard capping`;
      if (fold?.foldedLineCount > 0) {
        return `${selection}; clipboard retained ${retainedEvents} of ${renderedEvents} rendered event line(s) `
          + `after folding ${fold.foldedLineCount} repeated line(s) from ${rawEvents} captured line(s) `
          + `into ${fold.collapsedRuns} run line(s)`;
      }
      return `${selection}; clipboard retained ${retainedEvents} of ${renderedEvents} event line(s)`;
    }
  );
}

// `totalEvents` here is the post-fold line count, so the banner must also state
// how many captured lines those folds stand for — otherwise the retained/total
// ratio silently describes a smaller timeline than the one that was recorded.
function clipboardRetentionDetail(retainedEvents, totalEvents, retainedLogs, totalLogs, fold = null, logFold = null) {
  const detail = `retained ${retainedEvents} of ${totalEvents} most-recent event line(s) and ` +
    `${retainedLogs} of ${totalLogs} most-recent main-process log line(s)`;
  const clauses = [];
  if (fold?.foldedLineCount > 0) {
    clauses.push(`${fold.foldedLineCount} repeated event line(s) from ${fold.rawTotal} captured line(s) `
      + `were folded into ${fold.collapsedRuns} run line(s) before capping`);
  }
  // Stated separately from the event fold: the two counts describe different
  // blocks and one figure covering both would misreport either.
  if (logFold?.foldedLineCount > 0) {
    clauses.push(`${logFold.foldedLineCount} repeated main-process log line(s) from ${logFold.rawTotal} captured line(s) `
      + `were elided into ${logFold.collapsedShapes} summary line(s) before capping`);
  }
  return clauses.length ? `${detail}; ${clauses.join('; ')}` : detail;
}

const MAX_NAMED_DROPPED_SECTIONS = 6;
const MAX_NAMED_SECTION_CHARS = 120;

function displaySectionName(name) {
  const text = String(name || '').trim();
  return text.length > MAX_NAMED_SECTION_CHARS
    ? `${text.slice(0, MAX_NAMED_SECTION_CHARS - 1)}…`
    : text;
}

// Bounded so naming the omission can never itself eat meaningful budget: at
// most MAX_NAMED_DROPPED_SECTIONS short section names, then a "+N more" tally.
// Null when truncateBaseForClipboard found nothing to name (no heading was
// dropped or cut mid-section).
function formatSectionOmissionDetail(droppedSections, partialSection, droppedSubsections = []) {
  if (droppedSections.length === 0 && !partialSection && droppedSubsections.length === 0) return null;
  const parts = [];
  if (droppedSections.length > 0) {
    const shown = droppedSections
      .slice(0, MAX_NAMED_DROPPED_SECTIONS)
      .map(displaySectionName);
    const extra = droppedSections.length - shown.length;
    const names = extra > 0 ? `${shown.join(', ')}, +${extra} more` : shown.join(', ');
    parts.push(`${droppedSections.length} section(s) dropped: ${names}`);
  }
  if (partialSection) parts.push(`"${displaySectionName(partialSection)}" cut mid-section`);
  // Reported as its own clause, never folded into the `##` tally above — the
  // counts mean different things and merging them would misstate how many
  // top-level sections were lost.
  if (droppedSubsections.length > 0) {
    const shown = droppedSubsections
      .slice(0, MAX_NAMED_DROPPED_SECTIONS)
      .map(displaySectionName);
    const extra = droppedSubsections.length - shown.length;
    const names = extra > 0 ? `${shown.join(', ')}, +${extra} more` : shown.join(', ');
    parts.push(`${droppedSubsections.length} subsection(s) lost with them: ${names}`);
  }
  return parts.join('; ');
}

function hardCapOmissionDetail(trimmedEventCount, trimmedLogCount, droppedSections = [], partialSection = null, droppedSubsections = []) {
  const sectionDetail = formatSectionOmissionDetail(droppedSections, partialSection, droppedSubsections);
  const parts = [sectionDetail ? `static report content (${sectionDetail})` : 'static report content'];
  if (trimmedEventCount > 0) parts.push(`${trimmedEventCount} oldest event history line(s)`);
  if (trimmedLogCount > 0) parts.push(`${trimmedLogCount} oldest main-process log line(s)`);
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Char-budget windows over the (chronological, oldest-first) logs/events tail
// ─────────────────────────────────────────────────────────────────────────
// Both tail blocks are fixed chrome wrapped around the rendered lines, and
// every trim below re-measures the block after shedding ONE line. Rebuilding
// the join (and memmoving a `shift()`) per shed line is quadratic in the
// retained count — the renderer ships up to a 500KB event buffer (~6,000
// lines), which blocked the main process for seconds inside the
// generate-bug-report-markdown handler. This window keeps the same
// shed-one-and-re-measure loops but makes each iteration O(1): the joined
// length is tracked arithmetically and the OLDEST line — index `start`, i.e.
// the FRONT of the chronological array — is dropped by advancing `start`.
// (The block itself renders newest-first; that reversal happens only in the
// final `buildMainProcessLogsMarkdown`/`buildReverseChronologicalLogBlock`
// call, well after every window here has finished trimming.)
const EMPTY_EVENTS_FALLBACK = '*(No events recorded)*';

// `buildMainProcessLogsMarkdown`/`buildReverseChronologicalLogBlock` now stamp
// any line that doesn't already carry a recognized `[timestamp]` prefix with a
// "(timestamp assigned at report export)" marker before rendering — so probing
// the wrapper-only cost with a single BLANK line (the pre-hardening trick) would
// silently measure a real, decorated placeholder line instead of true chrome
// and throw off every char-budget computation below by that marker's length.
// Use a probe line that already matches the timestamp prefix pattern instead,
// so it passes through undecorated, and subtract its own (known) length back
// out to isolate the wrapper alone.
const CHROME_PROBE = '[00:00:00] ';
const LOGS_BLOCK_CHROME = buildMainProcessLogsMarkdown([CHROME_PROBE]).length - CHROME_PROBE.length;
const EVENTS_BLOCK_CHROME = buildReverseChronologicalLogBlock([CHROME_PROBE], EMPTY_EVENTS_FALLBACK, { basis: 'local' }).length - CHROME_PROBE.length;
const EMPTY_EVENTS_CHARS = buildReverseChronologicalLogBlock([], EMPTY_EVENTS_FALLBACK, { basis: 'local' }).length;

function openTailWindow(lines, chromeChars, emptyChars) {
  const source = Array.isArray(lines) ? lines : [];
  // Array.prototype.join renders null/undefined as an empty string, so the
  // per-line lengths must agree with join — not with String(line). This also
  // assumes every real line already carries a recognized timestamp (true for
  // both live sources — EventLogger and buildRecentMainProcessLogLines stamp
  // at capture time), so the render step's undecorated pass-through means this
  // raw length equals the line's contribution to the final rendered block.
  const lengths = source.map((line) => (line == null ? 0 : String(line).length));
  let start = 0;
  let joined = lengths.reduce((sum, n) => sum + n, 0) + Math.max(0, source.length - 1);
  return {
    get count() { return source.length - start; },
    get chars() { return start >= source.length ? emptyChars : chromeChars + joined; },
    dropOldest() {
      if (start >= source.length) return;
      joined -= lengths[start] + (source.length - start > 1 ? 1 : 0);
      start++;
    },
    lines() { return source.slice(start); },
  };
}

// A "floor" tail: a guaranteed minimum of the MOST-RECENT logs + events, balanced
// so neither fully crowds out the other. The main-process logs (a bounded 200-line
// ring buffer holding swallowed-error detail) get up to ~45% of the floor; the
// rest goes to the most-recent event lines, which reclaim the slack when the logs
// are short or absent. Returns the trimmed slices (newest-kept, still in
// chronological order) — NOT mutated copies.
function reserveFloorTail(allLogs, allEvents, floorChars) {
  const logs = openTailWindow(allLogs, LOGS_BLOCK_CHROME, 0);
  const events = openTailWindow(allEvents, EVENTS_BLOCK_CHROME, EMPTY_EVENTS_CHARS);
  const logBudget = Math.floor(floorChars * 0.45);
  while (logs.count > 0 && logs.chars > logBudget) logs.dropOldest();
  const eventBudget = Math.max(0, floorChars - logs.chars - EVENT_HISTORY_HEADING.length);
  while (events.count > 0 && events.chars > eventBudget) events.dropOldest();
  return { logs: logs.lines(), events: events.lines() };
}

// The static-section detail expands the banner, which in turn shrinks the
// room available for the static base. Recalculate until the omission described
// in the banner is the omission made by that final, smaller room. This is used
// by both cap paths so their diagnostics cannot name a stale first-pass cut.
function buildNamedStaticTruncation(baseMarkdown, tailMarkdown, maxChars, buildBanner) {
  let droppedSections = [];
  let partialSection = null;
  let droppedSubsections = [];
  let priorKey = null;

  for (let pass = 0; pass < 24; pass++) {
    const banner = buildBanner(droppedSections, partialSection, droppedSubsections);
    const room = maxChars - banner.length - tailMarkdown.length;
    const next = truncateBaseForClipboard(baseMarkdown, room);
    const nextKey = JSON.stringify([next.droppedSections, next.partialSection, next.droppedSubsections]);
    if (nextKey === priorKey) return { banner, cutBase: next.text };
    ({ droppedSections, partialSection } = next);
    droppedSubsections = next.droppedSubsections || [];
    priorKey = nextKey;
  }

  // Section names are bounded above, so this is only a defensive escape hatch
  // for adversarially-shaped Markdown; it still uses the latest true cut.
  const banner = buildBanner(droppedSections, partialSection, droppedSubsections);
  const room = maxChars - banner.length - tailMarkdown.length;
  return { banner, cutBase: truncateBaseForClipboard(baseMarkdown, room).text };
}

// ─────────────────────────────────────────────────────────────────────────
// The clipboard cap itself
// ─────────────────────────────────────────────────────────────────────────
export function enforceClipboardMarkdownCap(baseMarkdown, eventLines, mainProcessLogLines, maxChars) {
  const rawEvents = Array.isArray(eventLines) ? eventLines : [];
  const rawLogs = Array.isArray(mainProcessLogLines) ? mainProcessLogLines : [];

  // Both halves render newest-first; the arrays handed in and trimmed below
  // stay chronological throughout (see the file-header ordering contract).
  const tailOf = (logs, events) =>
    `${buildMainProcessLogsMarkdown(logs)}${EVENT_HISTORY_HEADING}${buildReverseChronologicalLogBlock(events, EMPTY_EVENTS_FALLBACK, { basis: 'local' })}`;

  // Fits with the full base + full tail: nothing to do. A report that fits keeps
  // every id verbatim — burst folding is strictly a last-resort transform.
  const fullTail = tailOf(rawLogs, rawEvents);
  if (baseMarkdown.length + fullTail.length <= maxChars) {
    return { markdown: baseMarkdown + fullTail, truncated: false, trimmedEventCount: 0, trimmedLogCount: 0, hardTruncated: false };
  }

  const { lines: allEvents, foldedLineCount, collapsedRuns } = collapseEventBursts(rawEvents);
  const foldDetail = { foldedLineCount, collapsedRuns, rawTotal: rawEvents.length };
  // Same last-resort treatment for the log block. A deep paginating walk emits
  // one near-identical progress line per page, so without this the log budget
  // is spent restating a single source's page counter while the oldest, most
  // structurally different lines are the ones shed.
  const { lines: allLogs, foldedLineCount: foldedLogLineCount, collapsedShapes } = collapseLogRepeats(rawLogs);
  const logFoldDetail = { foldedLineCount: foldedLogLineCount, collapsedShapes, rawTotal: rawLogs.length };

  const TAIL_FLOOR = Math.min(14_000, Math.floor(maxChars * 0.3));
  const floor = reserveFloorTail(allLogs, allEvents, TAIL_FLOOR);

  // The full base still leaves room for at least the floor tail → keep the FULL
  // base and MAXIMIZE the tail: start from everything and trim oldest events, then
  // oldest logs, only as much as needed to fit. base+floor fitting guarantees this
  // never has to dip below the floor.
  if (baseMarkdown.length + tailOf(floor.logs, floor.events).length <= maxChars) {
    const events = openTailWindow(allEvents, EVENTS_BLOCK_CHROME, EMPTY_EVENTS_CHARS);
    const logs = openTailWindow(allLogs, LOGS_BLOCK_CHROME, 0);
    const tailChars = () => logs.chars + EVENT_HISTORY_HEADING.length + events.chars;
    let trimmedEventCount = 0;
    let trimmedLogCount = 0;
    while (baseMarkdown.length + tailChars() > maxChars && events.count > floor.events.length) {
      events.dropOldest();
      trimmedEventCount++;
    }
    while (baseMarkdown.length + tailChars() > maxChars && logs.count > floor.logs.length) {
      logs.dropOldest();
      trimmedLogCount++;
    }
    // Replacing the pre-cap FULL summary adds a little text. Continue trimming
    // against that final wording so an accurate explanation never pushes the
    // copied report over its size limit.
    let cappedBase = clarifyCappedFilterSummary(baseMarkdown, events.count, allEvents.length, rawEvents.length, foldDetail);
    while (cappedBase.length + tailChars() > maxChars && events.count > floor.events.length) {
      events.dropOldest();
      trimmedEventCount++;
      cappedBase = clarifyCappedFilterSummary(baseMarkdown, events.count, allEvents.length, rawEvents.length, foldDetail);
    }
    while (cappedBase.length + tailChars() > maxChars && logs.count > floor.logs.length) {
      logs.dropOldest();
      trimmedLogCount++;
      cappedBase = clarifyCappedFilterSummary(baseMarkdown, events.count, allEvents.length, rawEvents.length, foldDetail);
    }

    const buildNotice = (droppedSections = [], partialSection = null, droppedSubsections = []) => {
      const parts = [];
      const sectionDetail = formatSectionOmissionDetail(droppedSections, partialSection, droppedSubsections);
      if (sectionDetail) parts.push(`static report content (${sectionDetail})`);
      if (trimmedEventCount > 0) parts.push(`${trimmedEventCount} oldest event history line(s)`);
      if (trimmedLogCount > 0) parts.push(`${trimmedLogCount} oldest main-process log line(s)`);
      // Folding alone can bring the report under the cap, so the drop clause is
      // omitted rather than left dangling when nothing was actually shed.
      const dropped = parts.length > 0 ? `; dropped ${parts.join(' and ')}` : '';
      return `> Clipboard export truncated to ${maxChars} chars: ${clipboardRetentionDetail(events.count, allEvents.length, logs.count, allLogs.length, foldDetail, logFoldDetail)}${dropped}. Use "Save to file" for the full uncapped currently retained report.\n\n`;
    };
    let notice = buildNotice();
    while (notice.length + cappedBase.length + tailChars() > maxChars && events.count > floor.events.length) {
      events.dropOldest();
      trimmedEventCount++;
      cappedBase = clarifyCappedFilterSummary(baseMarkdown, events.count, allEvents.length, rawEvents.length, foldDetail);
      notice = buildNotice();
    }
    while (notice.length + cappedBase.length + tailChars() > maxChars && logs.count > floor.logs.length) {
      logs.dropOldest();
      trimmedLogCount++;
      notice = buildNotice();
    }
    const retainedTail = tailOf(logs.lines(), events.lines());
    let out = notice + cappedBase + retainedTail;
    if (out.length > maxChars) {
      // The explanatory banner itself can be larger than the slack above the
      // tail floor. Preserve its exact retention counts by shedding the same
      // low-value static tail used by the hard-cap path, never the banner —
      // except to additionally name whichever section(s) that shed actually
      // removed. The helper stabilizes the mutually-dependent notice and cut
      // so a section exposed only by the smaller named-banner room is not
      // silently missing from the final notice.
      const namedCut = buildNamedStaticTruncation(cappedBase, retainedTail, maxChars, buildNotice);
      notice = namedCut.banner;
      const cutBase = namedCut.cutBase;
      out = notice + cutBase + retainedTail;
      return { markdown: out, truncated: true, trimmedEventCount, trimmedLogCount, hardTruncated: true };
    }
    // Burst folding alone can bring the report under the cap. Nothing was
    // dropped in that case, but the markdown is still transformed and carries a
    // truncation banner — reporting truncated:false would have the renderer
    // toast claim a plain, complete copy.
    return { markdown: out, truncated: trimmedEventCount > 0 || trimmedLogCount > 0 || foldedLineCount > 0 || foldedLogLineCount > 0, trimmedEventCount, trimmedLogCount, hardTruncated: false };
  }

  // The static base ALONE (plus even the floor tail) blows the budget. Reserve
  // the floor tail and truncate the end of the base. This is often caused by
  // Node Diagnostics/session dumps, but a large pipeline audit can reach the
  // boundary first, so the banner names the actual dropped/partial section(s)
  // from truncateBaseForClipboard's heading scan rather than staying silent
  // about which one was cut. Save-to-file (export-bug-report handler) remains
  // the complete, uncapped artifact.
  // The base is being cut off mid-document either way, so spending the leftover
  // budget on the FLOOR tail alone wastes it: the run that motivated this kept
  // only 55 of 125 log lines while the static cut had already thrown away far
  // more than the difference. Grow the tail above the floor toward the full
  // logs+events, bounded at half the cap so the static sections still get a
  // meaningful prefix (the hard-cap assertions in job-diagnostics.js depend on
  // that half — an unbounded tail starves the base and five of them fail).
  const TAIL_CEILING = Math.floor(maxChars * 0.5);
  const floorTailLength = tailOf(floor.logs, floor.events).length;
  // Grow PROPORTIONALLY to the overflow, not as a cliff. Jumping straight to
  // the ceiling meant a base one char past the floor path immediately forfeited
  // (ceiling − floor) chars of static diagnostics to buy tail lines it did not
  // need — the report that motivated this lost six whole sections and a
  // mid-section cut through the job pipeline audit that way. A base that
  // overflows by more than the growth room is being cut deeply regardless, so
  // the original "spend the leftover on the tail" reasoning still applies there
  // and the ceiling is reached exactly as before.
  const overflow = Math.max(0, baseMarkdown.length + floorTailLength - maxChars);
  const tailBudget = TAIL_FLOOR + Math.min(Math.max(0, TAIL_CEILING - TAIL_FLOOR), overflow);
  const grown = reserveFloorTail(allLogs, allEvents, Math.max(TAIL_FLOOR, tailBudget));
  const useGrown = tailOf(grown.logs, grown.events).length >= floorTailLength;
  const tail = useGrown ? grown : floor;

  const tailMd = tailOf(tail.logs, tail.events);
  const trimmedEventCount = allEvents.length - tail.events.length;
  const trimmedLogCount = allLogs.length - tail.logs.length;
  const omissionVerb = trimmedEventCount > 0 || trimmedLogCount > 0 ? 'were' : 'was';
  const cappedBase = clarifyCappedFilterSummary(baseMarkdown, tail.events.length, allEvents.length, rawEvents.length, foldDetail);
  const buildBanner = (droppedSections = [], partialSection = null, droppedSubsections = []) =>
    `> Clipboard export hit the ${maxChars}-char cap; ${hardCapOmissionDetail(trimmedEventCount, trimmedLogCount, droppedSections, partialSection, droppedSubsections)} ${omissionVerb} omitted to preserve the most recent diagnostics (${clipboardRetentionDetail(tail.events.length, allEvents.length, tail.logs.length, allLogs.length, foldDetail, logFoldDetail)}). Use "Save to file" for the full uncapped currently retained report.\n\n`;

  const { banner, cutBase } = buildNamedStaticTruncation(cappedBase, tailMd, maxChars, buildBanner);
  let out = banner + cutBase + tailMd;
  if (out.length > maxChars) out = out.slice(0, maxChars); // absolute backstop if the retained tail itself overran
  return { markdown: out, truncated: true, trimmedEventCount, trimmedLogCount, hardTruncated: true };
}
