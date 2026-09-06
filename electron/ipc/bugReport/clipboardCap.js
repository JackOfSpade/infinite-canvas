// Shared markdown blocks for Report an Issue exports. Both Copy and Save to
// file use these exact blocks; neither export applies a report-size cap.

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
