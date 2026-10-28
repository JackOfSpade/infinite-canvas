import { createHash } from 'node:crypto';
import { collectJobCompensationReport, COMPENSATION_REPORT_STATUSES, COMPENSATION_THRESHOLD_CHECKS, COMPENSATION_RECOMMENDATION_STATUSES, COMPENSATION_RECOMMENDATION_CHECKS } from '../../../src/utils/jobCompensationReport.js';
import { COMPENSATION_COMPARISON_REASONS, COMPENSATION_OFFER_REASONS } from '../../../src/utils/jobCompensationDisplay.js';

export function buildJobCompensationSnapshot(nodes, snapshot = null) {
  const report = snapshot && Array.isArray(snapshot.rows) ? snapshot : collectJobCompensationReport(nodes);
  const rows = report.rows.slice(0, 1000);
  const count = Number.isSafeInteger(report.inspectedCards) && report.inspectedCards >= rows.length ? report.inspectedCards : rows.length;
  const lines = ['\n## Job Card Salary Audit (JOBPAY)',
    '> Current saved card assessments, including collapsed cards and nested canvases; survives process restarts through card data. Fixed codes and counts only. No listing prose, salary amounts, career data or research URLs. A market recommendation is not an advertised-pay verdict. Personal guidance checks validate the saved shape and range bounds; they do not revalidate source evidence or establish that the career pin is current.',
    `- Cards: ${count} inspected · ${rows.length} shown · ${count - rows.length} omitted · scan truncated: ${report.scanTruncated === true ? 'yes' : 'no'}.`];
  const totals = Object.fromEntries([...COMPENSATION_REPORT_STATUSES].map(status => [status, 0]));
  const recommendationTotals = Object.fromEntries([...COMPENSATION_RECOMMENDATION_STATUSES].map(status => [status, 0]));
  const details = rows.map(row => {
    const status = COMPENSATION_REPORT_STATUSES.has(row?.status) ? row.status : 'not_evaluated';
    totals[status]++;
    const reason = COMPENSATION_COMPARISON_REASONS.has(row?.reason) ? row.reason : 'other';
    const offerReason = COMPENSATION_OFFER_REASONS.has(row?.offerReason) ? row.offerReason : 'unknown';
    const threshold = COMPENSATION_THRESHOLD_CHECKS.has(row?.thresholdCheck) ? row.thresholdCheck : 'no_comparison';
    const id = createHash('sha256').update(typeof row?.id === 'string' ? row.id.slice(0, 256) : '').digest('hex').slice(0, 10);
    const sources = Number.isSafeInteger(row?.sourceCount) ? Math.max(0, Math.min(5, row.sourceCount)) : 0;
    const recommendationStatus = COMPENSATION_RECOMMENDATION_STATUSES.has(row?.recommendationStatus) ? row.recommendationStatus : 'absent';
    const recommendationCheck = COMPENSATION_RECOMMENDATION_CHECKS.has(row?.recommendationCheck) ? row.recommendationCheck : 'absent';
    const evidenceCount = Number.isSafeInteger(row?.recommendationEvidenceCount) ? Math.max(0, Math.min(6, row.recommendationEvidenceCount)) : 0;
    recommendationTotals[recommendationStatus]++;
    return `- card #${id} · ${status} · reason ${reason} · advertised pay ${row?.advertised === true ? 'present' : 'absent'} · offer ${offerReason} · market range ${row?.marketRange === true ? 'present' : 'absent'} · sources ${sources} · verdict check ${threshold} · personal guidance ${recommendationStatus}/${recommendationCheck} · career pin ${row?.recommendationCareerPin === true ? 'present' : 'absent'} · cited evidence ${evidenceCount}`;
  });
  lines.push(`- Shown verdicts: ${Object.entries(totals).map(([status, n]) => `${status}=${n}`).join(' · ')}.`,
    `- Shown personal guidance: ${Object.entries(recommendationTotals).map(([status, n]) => `${status}=${n}`).join(' · ')}.`, ...details);
  return lines.join('\n') + '\n';
}
