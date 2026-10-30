import { createHash } from 'node:crypto';
import { OFFICIAL_POSTING_LEVELS, OFFICIAL_POSTING_OUTCOMES } from '../officialPostingFields.js';
import {
  collectOfficialPostingReport, sanitizeOfficialPostingReportRow,
  OFFICIAL_REPORT_MAX_NODES, OFFICIAL_REPORT_MAX_CARDS, OFFICIAL_REPORT_STATES, OFFICIAL_REPORT_FETCH_CODES,
} from '../../../src/utils/officialPostingReport.js';

export function buildOfficialPostingSnapshot(nodes, snapshot = null) {
  const report = snapshot && Array.isArray(snapshot.rows) ? snapshot : collectOfficialPostingReport(nodes);
  const rows = report.rows.slice(0, OFFICIAL_REPORT_MAX_CARDS).map(sanitizeOfficialPostingReportRow);
  const count = Math.min(OFFICIAL_REPORT_MAX_NODES, Math.max(report.rows.length,
    Number.isSafeInteger(report.inspectedCards) && report.inspectedCards >= 0 ? report.inspectedCards : 0));
  const scanTruncated = report.scanTruncated === true || report.rows.length > OFFICIAL_REPORT_MAX_NODES
    || (Number.isSafeInteger(report.inspectedCards) && report.inspectedCards > OFFICIAL_REPORT_MAX_NODES);
  const summary = (field, values) => values.map(value => `${value}=${rows.filter(row => row[field] === value).length}`).join(' · ');
  const lines = ['\n## Official Posting Card Audit (OFFICIAL)',
    '> Current card-held results, including collapsed cards and nested canvases. Restored fields remain available after a restart without a current search; this live snapshot does not prove a disk save. Fixed codes and counts only. No listing identity, prose, URLs, prompts or proof hashes. These are the latest retained results, not a history of every lookup attempt. An absent semantic proof identifies a legacy or unproved result; proof presence alone does not revalidate the posting.',
    `- Cards: ${count} inspected · ${rows.length} shown · ${count - rows.length} omitted · scan truncated: ${scanTruncated ? 'yes' : 'no'}.`,
    `- Shown records: ${summary('record', ['valid', 'absent', 'invalid'])}.`,
    `- Shown states: ${summary('state', OFFICIAL_REPORT_STATES)} · retryable=${rows.filter(row => row.retryable).length}.`,
    `- Shown levels: ${summary('level', OFFICIAL_POSTING_LEVELS)}.`,
    `- Shown outcomes: ${summary('outcome', OFFICIAL_POSTING_OUTCOMES)}.`,
  ];
  for (const row of rows) {
    const id = createHash('sha256').update(row.id).digest('hex').slice(0, 10);
    const fetches = row.fetchFailures.map(failure => `${failure.code}${failure.reason ? `/${failure.reason}` : ''}${failure.statusCode ? `/HTTP-${failure.statusCode}` : ''}`);
    const missingFetchDetails = !fetches.length && row.trail.some(code => OFFICIAL_REPORT_FETCH_CODES.includes(code));
    lines.push(`- card #${id} · record ${row.record} · level ${row.level} · outcome ${row.outcome} · status ${row.state} · retryable ${row.retryable ? 'yes' : 'no'} · research settled ${row.settled ? 'yes' : 'no'} · semantic proof ${row.semanticProof} · trail ${row.trail.join(', ') || 'not recorded'} · fetch details ${fetches.join(', ') || 'not recorded'}${missingFetchDetails ? ' (failure detail missing)' : ''}`);
  }
  return lines.join('\n') + '\n';
}
