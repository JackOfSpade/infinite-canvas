import {
  normalizeOfficialPosting, officialPostingLookupStatus, officialResearchSettled,
  OFFICIAL_POSTING_LEVELS, OFFICIAL_POSTING_OUTCOMES, OFFICIAL_POSTING_TRAIL,
  OFFICIAL_FETCH_FAILURE_REASONS, OFFICIAL_FETCH_FAILURE_LIMIT,
} from '../../electron/ipc/officialPostingFields.js';

export const OFFICIAL_REPORT_MAX_NODES = 20_000;
export const OFFICIAL_REPORT_MAX_CARDS = 1000;
export const OFFICIAL_REPORT_STATES = Object.freeze(['verified', 'not-found', 'ambiguous', 'closed', 'incomplete', 'unchecked']);
export const OFFICIAL_REPORT_FETCH_CODES = Object.freeze(['fetch-failed', 'fetch-timeout', 'unsafe-url', 'unsafe-address', 'unsupported-content-type', 'oversize', 'invalid-text']);
export const OFFICIAL_REPORT_PROOFS = Object.freeze(['complete', 'input-only', 'absent']);

// This is also the main-process boundary for renderer-supplied snapshots. Never
// spread a row or a fetch failure: each can carry listing text or a private URL.
export function sanitizeOfficialPostingReportRow(value) {
  const id = typeof value?.id === 'string' ? value.id.slice(0, 256) : '';
  const valid = value?.record === 'valid' && OFFICIAL_POSTING_LEVELS.includes(value.level)
    && OFFICIAL_POSTING_OUTCOMES.includes(value.outcome) && OFFICIAL_REPORT_STATES.includes(value.state)
    && typeof value.retryable === 'boolean' && typeof value.settled === 'boolean';
  if (!valid) return { id, record: value?.record === 'absent' ? 'absent' : 'invalid',
    level: 'none', outcome: 'none', state: 'unchecked', retryable: true, settled: false,
    trail: [], fetchFailures: [], semanticProof: 'absent' };
  const trail = [...new Set((Array.isArray(value.trail) ? value.trail.slice(0, 32) : [])
    .filter(code => OFFICIAL_POSTING_TRAIL.includes(code)))];
  const fetchFailures = (Array.isArray(value.fetchFailures) ? value.fetchFailures.slice(0, OFFICIAL_FETCH_FAILURE_LIMIT) : [])
    .flatMap(failure => {
      if (!OFFICIAL_REPORT_FETCH_CODES.includes(failure?.code)) return [];
      return [{ code: failure.code,
        ...(failure.code === 'fetch-failed' && OFFICIAL_FETCH_FAILURE_REASONS.includes(failure.reason) ? { reason: failure.reason } : {}),
        ...(Number.isInteger(failure.statusCode) && failure.statusCode >= 100 && failure.statusCode <= 599 ? { statusCode: failure.statusCode } : {}),
      }];
    });
  return { id, record: 'valid', level: value.level, outcome: value.outcome, state: value.state,
    retryable: value.retryable, settled: value.settled, trail, fetchFailures,
    semanticProof: OFFICIAL_REPORT_PROOFS.includes(value.semanticProof) ? value.semanticProof : 'absent' };
}

// Capture before report filters omit nodes. The global flat graph includes
// collapsed cards and parent navigation levels; direct callers can pass a tree.
export function collectOfficialPostingReport(nodes, { flat = false } = {}) {
  const pending = [nodes]; const visited = new WeakSet(); const rows = [];
  let inspectedNodes = 0; let inspectedCards = 0;
  while (pending.length && inspectedNodes < OFFICIAL_REPORT_MAX_NODES) {
    const level = pending.pop();
    if (!Array.isArray(level) || visited.has(level)) continue;
    visited.add(level);
    for (const node of level) {
      if (inspectedNodes++ >= OFFICIAL_REPORT_MAX_NODES) return { rows, inspectedCards, scanTruncated: true };
      if (!flat && node?.data?.canvasData?.nodes) pending.push(node.data.canvasData.nodes);
      if (node?.type !== 'jobcard') continue;
      inspectedCards++;
      if (rows.length >= OFFICIAL_REPORT_MAX_CARDS) continue;
      const raw = node.data?.officialPosting;
      const posting = normalizeOfficialPosting(raw);
      const status = officialPostingLookupStatus(posting);
      rows.push(sanitizeOfficialPostingReportRow({ id: node.id,
        record: posting ? 'valid' : raw == null ? 'absent' : 'invalid',
        level: posting?.level, outcome: posting?.outcome, state: status.state,
        retryable: status.retryable, settled: officialResearchSettled(posting),
        trail: posting?.trail, fetchFailures: posting?.fetchFailures,
        semanticProof: posting?.semanticMatch?.sourceHash ? 'complete' : posting?.semanticMatch ? 'input-only' : 'absent',
      }));
    }
  }
  return { rows, inspectedCards, scanTruncated: pending.length > 0 };
}
