// Process-local ring of Claude usage-pause and system sleep/wake events. Fields
// are projected to a closed vocabulary on entry: never prompts, answers, paths
// or error text.
const MAX_ROWS = 40;
const KINDS = new Set(['usage-limit', 'resumed', 'system-suspend', 'system-resume', 'wake-recheck']);
const RESUME_REASONS = new Set(['reset-timer', 'resume-now', 'wake-recheck', 'answer']);
const RECHECK_OUTCOMES = new Set(['cleared', 'rearmed', 'not-limited']);
const TASK_RE = /^[a-z0-9-]{1,80}$/u;
const CODE_RE = /^[A-Z][A-Z0-9_]{0,59}$/u;
let rows = [];

const iso = (value) => {
  if (!Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
const isoField = (value) => {
  if (typeof value === 'string') { const ms = Date.parse(value); return Number.isFinite(ms) ? iso(ms) : null; }
  return iso(value);
};
const ms = value => (Number.isFinite(value) && value >= 0 ? Math.round(value) : null);

export function recordClaudePauseEvent(event) {
  const kind = event?.kind;
  if (typeof kind !== 'string' || !KINDS.has(kind)) return;
  const row = { at: new Date().toISOString(), kind };
  if (kind === 'usage-limit') {
    row.code = typeof event.code === 'string' && CODE_RE.test(event.code) ? event.code : 'CLAUDE_USAGE_LIMIT';
    row.resetsAt = isoField(event.resetsAt);
    row.resumeAt = isoField(event.resumeAt);
    if (typeof event.task === 'string' && TASK_RE.test(event.task)) row.task = event.task;
  } else if (kind === 'resumed') {
    if (!RESUME_REASONS.has(event.reason)) return;
    row.reason = event.reason;
    row.pausedMs = ms(event.pausedMs);
  } else if (kind === 'wake-recheck') {
    if (!RECHECK_OUTCOMES.has(event.outcome)) return;
    row.outcome = event.outcome;
    row.remainingMs = ms(event.remainingMs);
  }
  rows.push(row);
  if (rows.length > MAX_ROWS) rows = rows.slice(rows.length - MAX_ROWS);
}

export function resetClaudePauseDiagnosticsForTest() { rows = []; }

function describe(row) {
  switch (row.kind) {
    case 'usage-limit':
      return `${row.code} · resets ${row.resetsAt || 'unknown'} · resume ${row.resumeAt || 'unknown'}${row.task ? ` · task ${row.task}` : ''}`;
    case 'resumed': return `reason ${row.reason} · paused ${row.pausedMs ?? 'unknown'} ms`;
    case 'wake-recheck': return `outcome ${row.outcome} · remaining ${row.remainingMs ?? 0} ms`;
    default: return '';
  }
}

export function claudePauseDiagnosticsMarkdown({ now = Date.now(), current = null } = {}) {
  const currentLine = current && Number.isFinite(current.resumeAt)
    ? `limited since ${iso(current.since) || 'unknown'}, resumes ${iso(current.resumeAt)}, resets ${iso(current.resetsAt) || 'unknown'} (checked ${iso(now) || 'unknown'})`
    : 'not limited';
  return '\n## Claude Usage Pauses (CLAUDEPAUSE)\n'
    + '> Process-local, newest first, at most 40 events. Fixed codes, times and durations only; no prompts, answers, paths or error text. Earlier processes cannot be reconstructed.\n'
    + `- Current: ${currentLine}\n`
    + (rows.length
      ? [...rows].reverse().map(row => `- ${row.at} · ${row.kind}${describe(row) ? ` · ${describe(row)}` : ''}`).join('\n')
      : '- No usage pause or sleep/wake event retained in this process.') + '\n';
}
