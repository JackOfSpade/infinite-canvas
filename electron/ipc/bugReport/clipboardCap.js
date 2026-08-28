// Clipboard-export budget enforcement for the bug report markdown.
//
// The "Copy to clipboard" path caps the report at a fixed char budget (the
// "Save to file" path is uncapped). Pure string logic with no electron deps, so
// it can be unit-tested directly. The ordering contract is the whole point:
//
//   baseMarkdown (curated static sections, usually ending in the large Node
//   Diagnostics / media / image dumps)  +  Recent Main-Process Logs  +
//   Event History
//
// The logs + most-recent event timeline are the highest-value real-time
// evidence ("did the run finish / what errored"), so they must NOT be the first
// thing sacrificed when a big canvas makes the static base overflow the budget.

export function buildFencedTextBlock(lines, emptyFallback) {
  if (!Array.isArray(lines) || lines.length === 0) return `${emptyFallback}\n`;
  return `\`\`\`text\n${lines.join('\n')}\n\`\`\`\n`;
}

// Render-time burst folding for the CLIPBOARD path only. The renderer's
// capture-time collapsers can only merge byte-identical repeats and same-id
// resize runs, so a structural churn burst (one board re-combine tears down
// hundreds of uniquely-id'd nodes in ~2ms) still arrives as hundreds of
// near-identical lines and can eat most of the retained-event budget. Only the
// structural verbs below fold; errors and module chatter always pass through
// verbatim. Save-to-file never calls this — `node removed id=` lines are the
// primary evidence for "my card disappeared" reports, so every raw id must
// survive there.
const COLLAPSIBLE = /^\[(\d\d:\d\d:\d\d\.\d\d\d)\] (node removed|node added|node resized|node moved|edge added|edge removed)\b(?:.*?)\bid=(\S+)/;

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

export function buildMainProcessLogsMarkdown(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return '';
  return `
## Recent Main-Process Logs
> Up to 200 lines from the main process's logger (ring buffer). Use this to
> see what \`[Accounts]\` / \`[StealthBrowser]\` / \`[Marketplace]\` actually
> did and any errors that were swallowed by an IPC handler before the
> renderer got a useful response.
> **Timestamps:** UTC (\`HH:MM:SS.mmm\`).

\`\`\`
${lines.join('\n')}
\`\`\`
`;
}

// Event history originates in the renderer, whose display timestamps are local
// to the user. Keep this note in the shared tail heading so uncapped export and
// every clipboard-cap path cannot drift apart while preserving the stable
// `## Event History` heading used by filters and clipboard parsing.
export const EVENT_HISTORY_HEADING = '## Event History\n> **Timestamps:** local time (renderer). See Runtime Identity for the report date, IANA timezone, and UTC offset.\n';

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

  const note = '\n\n> ⚠️ Report content after this point was omitted by the clipboard cap. The recent logs and event timeline continue below; use "Save to file" for every uncapped section.\n';
  const contentRoom = Math.max(0, room - note.length);
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

  return { text: candidate.slice(0, cut).trimEnd() + note, droppedSections, partialSection, droppedSubsections };
}

// The filter summary is assembled before the clipboard cap runs. When a FULL
// report subsequently sheds old events, its otherwise-accurate selection
// summary ("event log kept all N line(s)") would describe data that is no
// longer present in the copied markdown. Make that distinction explicit in the
// final artifact: FULL selected every event, while the clipboard retained only
// the newest subset.
function clarifyCappedFilterSummary(baseMarkdown, retainedEvents, totalEvents) {
  if (retainedEvents >= totalEvents) return baseMarkdown;
  return baseMarkdown.replace(
    /event log kept all (\d+) line\(s\)/g,
    (_, selected) =>
      `event log selected all ${selected} line(s) before clipboard capping; ` +
      `clipboard retained ${retainedEvents} of ${totalEvents} event line(s)`
  );
}

// `totalEvents` here is the post-fold line count, so the banner must also state
// how many captured lines those folds stand for — otherwise the retained/total
// ratio silently describes a smaller timeline than the one that was recorded.
function clipboardRetentionDetail(retainedEvents, totalEvents, retainedLogs, totalLogs, fold = null) {
  const detail = `retained ${retainedEvents} of ${totalEvents} most-recent event line(s) and ` +
    `${retainedLogs} of ${totalLogs} most-recent main-process log line(s)`;
  if (!fold || !(fold.foldedLineCount > 0)) return detail;
  return `${detail}; ${fold.foldedLineCount} repeated event line(s) from ${fold.rawTotal} captured line(s) ` +
    `were folded into ${fold.collapsedRuns} run line(s) before capping`;
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

// A "floor" tail: a guaranteed minimum of the MOST-RECENT logs + events, balanced
// so neither fully crowds out the other. The main-process logs (a bounded 200-line
// ring buffer holding swallowed-error detail) get up to ~45% of the floor; the
// rest goes to the most-recent event lines, which reclaim the slack when the logs
// are short or absent. Returns the trimmed slices (newest-kept) — NOT mutated copies.
function reserveFloorTail(allLogs, allEvents, floorChars) {
  const logs = [...allLogs];
  const events = [...allEvents];
  const logBudget = Math.floor(floorChars * 0.45);
  while (logs.length > 0 && buildMainProcessLogsMarkdown(logs).length > logBudget) logs.shift();
  const eventBudget = Math.max(0, floorChars - buildMainProcessLogsMarkdown(logs).length - EVENT_HISTORY_HEADING.length);
  while (events.length > 0 && buildFencedTextBlock(events, '*(No events recorded)*').length > eventBudget) events.shift();
  return { logs, events };
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

export function enforceClipboardMarkdownCap(baseMarkdown, eventLines, mainProcessLogLines, maxChars) {
  const rawEvents = Array.isArray(eventLines) ? eventLines : [];
  const allLogs = Array.isArray(mainProcessLogLines) ? mainProcessLogLines : [];

  const tailOf = (logs, events) =>
    `${buildMainProcessLogsMarkdown(logs)}${EVENT_HISTORY_HEADING}${buildFencedTextBlock(events, '*(No events recorded)*')}`;

  // Fits with the full base + full tail: nothing to do. A report that fits keeps
  // every id verbatim — burst folding is strictly a last-resort transform.
  const fullTail = tailOf(allLogs, rawEvents);
  if (baseMarkdown.length + fullTail.length <= maxChars) {
    return { markdown: baseMarkdown + fullTail, truncated: false, trimmedEventCount: 0, trimmedLogCount: 0, hardTruncated: false };
  }

  const { lines: allEvents, foldedLineCount, collapsedRuns } = collapseEventBursts(rawEvents);
  const foldDetail = { foldedLineCount, collapsedRuns, rawTotal: rawEvents.length };

  const TAIL_FLOOR = Math.min(14_000, Math.floor(maxChars * 0.3));
  const floor = reserveFloorTail(allLogs, allEvents, TAIL_FLOOR);

  // The full base still leaves room for at least the floor tail → keep the FULL
  // base and MAXIMIZE the tail: start from everything and trim oldest events, then
  // oldest logs, only as much as needed to fit. base+floor fitting guarantees this
  // never has to dip below the floor.
  if (baseMarkdown.length + tailOf(floor.logs, floor.events).length <= maxChars) {
    let events = [...allEvents];
    let logs = [...allLogs];
    let trimmedEventCount = 0;
    let trimmedLogCount = 0;
    while (baseMarkdown.length + tailOf(logs, events).length > maxChars && events.length > floor.events.length) {
      events.shift();
      trimmedEventCount++;
    }
    while (baseMarkdown.length + tailOf(logs, events).length > maxChars && logs.length > floor.logs.length) {
      logs.shift();
      trimmedLogCount++;
    }
    // Replacing the pre-cap FULL summary adds a little text. Continue trimming
    // against that final wording so an accurate explanation never pushes the
    // copied report over its size limit.
    let cappedBase = clarifyCappedFilterSummary(baseMarkdown, events.length, rawEvents.length);
    while (cappedBase.length + tailOf(logs, events).length > maxChars && events.length > floor.events.length) {
      events.shift();
      trimmedEventCount++;
      cappedBase = clarifyCappedFilterSummary(baseMarkdown, events.length, rawEvents.length);
    }
    while (cappedBase.length + tailOf(logs, events).length > maxChars && logs.length > floor.logs.length) {
      logs.shift();
      trimmedLogCount++;
      cappedBase = clarifyCappedFilterSummary(baseMarkdown, events.length, rawEvents.length);
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
      return `> Clipboard export truncated to ${maxChars} chars: ${clipboardRetentionDetail(events.length, allEvents.length, logs.length, allLogs.length, foldDetail)}${dropped}. Use "Save to file" for the full uncapped report.\n\n`;
    };
    let notice = buildNotice();
    while (notice.length + cappedBase.length + tailOf(logs, events).length > maxChars && events.length > floor.events.length) {
      events.shift();
      trimmedEventCount++;
      cappedBase = clarifyCappedFilterSummary(baseMarkdown, events.length, rawEvents.length);
      notice = buildNotice();
    }
    while (notice.length + cappedBase.length + tailOf(logs, events).length > maxChars && logs.length > floor.logs.length) {
      logs.shift();
      trimmedLogCount++;
      notice = buildNotice();
    }
    let out = notice + cappedBase + tailOf(logs, events);
    if (out.length > maxChars) {
      // The explanatory banner itself can be larger than the slack above the
      // tail floor. Preserve its exact retention counts by shedding the same
      // low-value static tail used by the hard-cap path, never the banner —
      // except to additionally name whichever section(s) that shed actually
      // removed. The helper stabilizes the mutually-dependent notice and cut
      // so a section exposed only by the smaller named-banner room is not
      // silently missing from the final notice.
      const namedCut = buildNamedStaticTruncation(cappedBase, tailOf(logs, events), maxChars, buildNotice);
      notice = namedCut.banner;
      const cutBase = namedCut.cutBase;
      out = notice + cutBase + tailOf(logs, events);
      return { markdown: out, truncated: true, trimmedEventCount, trimmedLogCount, hardTruncated: true };
    }
    // Burst folding alone can bring the report under the cap. Nothing was
    // dropped in that case, but the markdown is still transformed and carries a
    // truncation banner — reporting truncated:false would have the renderer
    // toast claim a plain, complete copy.
    return { markdown: out, truncated: trimmedEventCount > 0 || trimmedLogCount > 0 || foldedLineCount > 0, trimmedEventCount, trimmedLogCount, hardTruncated: false };
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
  const grown = reserveFloorTail(allLogs, allEvents, Math.max(TAIL_FLOOR, TAIL_CEILING));
  const floorTailLength = tailOf(floor.logs, floor.events).length;
  const useGrown = tailOf(grown.logs, grown.events).length >= floorTailLength;
  const tail = useGrown ? grown : floor;

  const tailMd = tailOf(tail.logs, tail.events);
  const trimmedEventCount = allEvents.length - tail.events.length;
  const trimmedLogCount = allLogs.length - tail.logs.length;
  const omissionVerb = trimmedEventCount > 0 || trimmedLogCount > 0 ? 'were' : 'was';
  const cappedBase = clarifyCappedFilterSummary(baseMarkdown, tail.events.length, rawEvents.length);
  const buildBanner = (droppedSections = [], partialSection = null, droppedSubsections = []) =>
    `> Clipboard export hit the ${maxChars}-char cap; ${hardCapOmissionDetail(trimmedEventCount, trimmedLogCount, droppedSections, partialSection, droppedSubsections)} ${omissionVerb} omitted to preserve the most recent diagnostics (${clipboardRetentionDetail(tail.events.length, allEvents.length, tail.logs.length, allLogs.length, foldDetail)}). Use "Save to file" for the full uncapped report.\n\n`;

  const { banner, cutBase } = buildNamedStaticTruncation(cappedBase, tailMd, maxChars, buildBanner);
  let out = banner + cutBase + tailMd;
  if (out.length > maxChars) out = out.slice(0, maxChars); // absolute backstop if the retained tail itself overran
  return { markdown: out, truncated: true, trimmedEventCount, trimmedLogCount, hardTruncated: true };
}
