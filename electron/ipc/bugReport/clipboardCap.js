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

export function buildMainProcessLogsMarkdown(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return '';
  return `
## Recent Main-Process Logs
> Last ~60 lines from the main process's logger (ring buffer). Use this to
> see what \`[Accounts]\` / \`[StealthBrowser]\` / \`[Marketplace]\` actually
> did and any errors that were swallowed by an IPC handler before the
> renderer got a useful response.

\`\`\`
${lines.join('\n')}
\`\`\`
`;
}

const EVENT_HISTORY_HEADING = '## Event History\n';

// A hard clipboard cap may land inside ANY large static section (the job
// pipeline's relevance/taxonomy audits can be larger than Node Diagnostics).
// Do not claim a particular section was removed, and do not leave a Markdown
// list/table/code block looking complete when it was sliced mid-item. Prefer a
// nearby paragraph/line boundary, then append an explicit continuation note.
function truncateBaseForClipboard(baseMarkdown, room) {
  if (room <= 0) return '';
  if (baseMarkdown.length <= room) return baseMarkdown;

  const note = '\n\n> ⚠️ Report content after this point was omitted by the clipboard cap. The recent logs and event timeline continue below; use "Save to file" for every uncapped section.\n';
  const contentRoom = Math.max(0, room - note.length);
  if (contentRoom === 0) return note.slice(0, room);

  const candidate = baseMarkdown.slice(0, contentRoom);
  // Prefer a blank-line boundary close to the cap. Falling back to a newline
  // avoids cutting a telemetry row or URL in half even for dense list output.
  const paragraph = candidate.lastIndexOf('\n\n');
  const line = candidate.lastIndexOf('\n');
  const minimumUsefulCut = Math.floor(contentRoom * 0.8);
  const cut = paragraph >= minimumUsefulCut ? paragraph : (line >= 0 ? line : contentRoom);
  return candidate.slice(0, cut).trimEnd() + note;
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

function clipboardRetentionDetail(retainedEvents, totalEvents, retainedLogs, totalLogs) {
  return `retained ${retainedEvents} of ${totalEvents} most-recent event line(s) and ` +
    `${retainedLogs} of ${totalLogs} most-recent main-process log line(s)`;
}

function hardCapOmissionDetail(trimmedEventCount, trimmedLogCount) {
  const parts = ['static report content'];
  if (trimmedEventCount > 0) parts.push(`${trimmedEventCount} oldest event history line(s)`);
  if (trimmedLogCount > 0) parts.push(`${trimmedLogCount} oldest main-process log line(s)`);
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`;
}

// A "floor" tail: a guaranteed minimum of the MOST-RECENT logs + events, balanced
// so neither fully crowds out the other. The main-process logs (a bounded ~60-line
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

export function enforceClipboardMarkdownCap(baseMarkdown, eventLines, mainProcessLogLines, maxChars) {
  const allEvents = Array.isArray(eventLines) ? eventLines : [];
  const allLogs = Array.isArray(mainProcessLogLines) ? mainProcessLogLines : [];

  const tailOf = (logs, events) =>
    `${buildMainProcessLogsMarkdown(logs)}${EVENT_HISTORY_HEADING}${buildFencedTextBlock(events, '*(No events recorded)*')}`;

  // Fits with the full base + full tail: nothing to do.
  const fullTail = tailOf(allLogs, allEvents);
  if (baseMarkdown.length + fullTail.length <= maxChars) {
    return { markdown: baseMarkdown + fullTail, truncated: false, trimmedEventCount: 0, trimmedLogCount: 0, hardTruncated: false };
  }

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
    let cappedBase = clarifyCappedFilterSummary(baseMarkdown, events.length, allEvents.length);
    while (cappedBase.length + tailOf(logs, events).length > maxChars && events.length > floor.events.length) {
      events.shift();
      trimmedEventCount++;
      cappedBase = clarifyCappedFilterSummary(baseMarkdown, events.length, allEvents.length);
    }
    while (cappedBase.length + tailOf(logs, events).length > maxChars && logs.length > floor.logs.length) {
      logs.shift();
      trimmedLogCount++;
      cappedBase = clarifyCappedFilterSummary(baseMarkdown, events.length, allEvents.length);
    }

    const buildNotice = () => {
      const parts = [];
      if (trimmedEventCount > 0) parts.push(`${trimmedEventCount} oldest event history line(s)`);
      if (trimmedLogCount > 0) parts.push(`${trimmedLogCount} oldest main-process log line(s)`);
      return `> Clipboard export truncated to ${maxChars} chars: ${clipboardRetentionDetail(events.length, allEvents.length, logs.length, allLogs.length)}; dropped ${parts.join(' and ')}. Use "Save to file" for the full uncapped report.\n\n`;
    };
    let notice = buildNotice();
    while (notice.length + cappedBase.length + tailOf(logs, events).length > maxChars && events.length > floor.events.length) {
      events.shift();
      trimmedEventCount++;
      cappedBase = clarifyCappedFilterSummary(baseMarkdown, events.length, allEvents.length);
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
      // low-value static tail used by the hard-cap path, never the banner.
      const room = maxChars - notice.length - tailOf(logs, events).length;
      const cutBase = truncateBaseForClipboard(cappedBase, room);
      out = notice + cutBase + tailOf(logs, events);
      return { markdown: out, truncated: true, trimmedEventCount, trimmedLogCount, hardTruncated: true };
    }
    return { markdown: out, truncated: trimmedEventCount > 0 || trimmedLogCount > 0, trimmedEventCount, trimmedLogCount, hardTruncated: false };
  }

  // The static base ALONE (plus even the floor tail) blows the budget. Reserve
  // the floor tail and truncate the end of the base. This is often caused by
  // Node Diagnostics/session dumps, but a large pipeline audit can reach the
  // boundary first, so the user-facing notice deliberately makes no claim about
  // which section was cut. Save-to-file remains the complete artifact.
  // Save-to-file (export-bug-report handler) stays uncapped.
  const tailMd = tailOf(floor.logs, floor.events);
  const trimmedEventCount = allEvents.length - floor.events.length;
  const trimmedLogCount = allLogs.length - floor.logs.length;
  const omissionVerb = trimmedEventCount > 0 || trimmedLogCount > 0 ? 'were' : 'was';
  const banner = `> Clipboard export hit the ${maxChars}-char cap; ${hardCapOmissionDetail(trimmedEventCount, trimmedLogCount)} ${omissionVerb} omitted to preserve the most recent diagnostics (${clipboardRetentionDetail(floor.events.length, allEvents.length, floor.logs.length, allLogs.length)}). Use "Save to file" for the full uncapped report.\n\n`;
  const room = maxChars - banner.length - tailMd.length;
  const cappedBase = clarifyCappedFilterSummary(baseMarkdown, floor.events.length, allEvents.length);
  const cutBase = truncateBaseForClipboard(cappedBase, room);
  let out = banner + cutBase + tailMd;
  if (out.length > maxChars) out = out.slice(0, maxChars); // absolute backstop if the floor tail itself overran
  return { markdown: out, truncated: true, trimmedEventCount, trimmedLogCount, hardTruncated: true };
}
