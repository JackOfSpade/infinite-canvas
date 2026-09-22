// Process-local, privacy-safe receipts for the Local Application JSON
// copy/paste handoff. Do not add prompts, responses, job identifiers, handoff
// codes, validation text, or field names here: this data is exported in bug
// reports.
const RING_LIMIT = 40;
const REPORT_LIMIT = 20;

const SAFE_STAGES = new Set(['evidence-plan', 'resume', 'cover-letter', 'review']);
const SAFE_OUTCOMES = new Set(['accepted', 'rejected']);
const SAFE_REASONS = new Set([
  'INVALID_JSON',
  'SCHEMA_INVALID',
  'DOMAIN_VALIDATION_FAILED',
  'STALE_HANDOFF',
  'RESPONSE_TOO_LARGE',
  // The job ended because app-owned frozen state failed, not because the
  // pasted response did. Collapsing it into VALIDATION_FAILED would hide the
  // one distinction a reader of this report needs: no round was reopened.
  'JOB_INTEGRITY_FAULT',
  'VALIDATION_FAILED',
]);

const receipts = [];

function boundedInteger(value, maximum) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= maximum ? number : null;
}

/**
 * Record a Local Application paste handoff result.
 *
 * The caller must supply only the declared fields. `syntaxLine` and
 * `syntaxColumn` are parser positions, never response excerpts. `responseChars`
 * is the original pasted-string length. This does not persist across restart.
 */
export function recordPasteHandoffDiagnostic({
  stage,
  outcome,
  reason,
  responseChars,
  syntaxLine,
  syntaxColumn,
  artifactCandidates,
} = {}) {
  const item = {
    at: Date.now(),
    stage: SAFE_STAGES.has(stage) ? stage : 'unknown',
    outcome: SAFE_OUTCOMES.has(outcome) ? outcome : 'rejected',
    reason: SAFE_REASONS.has(reason) ? reason : 'VALIDATION_FAILED',
    responseChars: boundedInteger(responseChars, 10_000_000),
    syntaxLine: boundedInteger(syntaxLine, 1_000_000),
    syntaxColumn: boundedInteger(syntaxColumn, 1_000_000),
    artifactCandidates: boundedInteger(artifactCandidates, 1_000),
  };
  // Successful submissions need no rejection metadata.
  if (item.outcome === 'accepted') {
    item.reason = null;
    item.syntaxLine = null;
    item.syntaxColumn = null;
    item.artifactCandidates = null;
  }
  receipts.push(item);
  if (receipts.length > RING_LIMIT) receipts.shift();
}

export function getPasteHandoffDiagnosticsSnapshot() {
  const total = receipts.length;
  const shown = receipts.slice(-REPORT_LIMIT).map(item => ({ ...item }));
  return { receipts: shown, total, omitted: Math.max(0, total - shown.length), limit: REPORT_LIMIT, sourceLimit: RING_LIMIT };
}

export function buildPasteHandoffDiagnosticsMarkdown() {
  const snapshot = getPasteHandoffDiagnosticsSnapshot();
  if (snapshot.receipts.length === 0) return '';
  const accepted = snapshot.receipts.filter(item => item.outcome === 'accepted').length;
  const rejected = snapshot.receipts.length - accepted;
  const retention = snapshot.omitted > 0
    ? ` · ${snapshot.omitted} older receipt(s) omitted (newest ${snapshot.receipts.length} of ${snapshot.total} shown)`
    : ` · ${snapshot.receipts.length} of ${snapshot.total} process receipt(s) shown`;
  const lines = [
    '## Local Application Paste Handoff Lifecycle',
    '> Process-local, metadata-only receipts. Prompts, pasted responses, handoff codes, job IDs, validation text, contact details, and source quotes are never retained here.',
    `- Retained: ${snapshot.receipts.length} receipt(s) · ${accepted} accepted · ${rejected} rejected${retention} · source keeps newest ${snapshot.sourceLimit} receipt(s) per process`,
  ];
  for (const item of snapshot.receipts) {
    const at = Number.isFinite(item.at) ? new Date(item.at).toISOString() : 'time not recorded';
    const size = Number.isInteger(item.responseChars) ? ` · ${item.responseChars} chars` : '';
    const reason = item.outcome === 'rejected' ? ` · ${item.reason || 'VALIDATION_FAILED'}` : '';
    const location = item.outcome === 'rejected' && Number.isInteger(item.syntaxLine)
      ? ` · syntax line ${item.syntaxLine}${Number.isInteger(item.syntaxColumn) ? `, column ${item.syntaxColumn}` : ''}`
      : '';
    const artifacts = item.outcome === 'rejected' && Number.isInteger(item.artifactCandidates)
      ? ` · content-reference candidates ${item.artifactCandidates}`
      : '';
    lines.push(`- ${at} · stage \`${item.stage}\` · ${item.outcome}${reason}${size}${location}${artifacts}`);
  }
  return `\n${lines.join('\n')}\n`;
}

export function _resetPasteHandoffDiagnostics() {
  receipts.length = 0;
}
