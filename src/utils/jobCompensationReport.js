import { normalizeCompensationAssessment } from '../nodes/jobsearch/buildJobTree.js';
import { COMPENSATION_COMPARISON_REASONS, jobCompensationDisplay } from './jobCompensationDisplay.js';

export const COMPENSATION_REPORT_STATUSES = new Set(['competitive', 'below_market', 'market_recommendation', 'uncertain', 'not_evaluated']);
export const COMPENSATION_THRESHOLD_CHECKS = new Set(['consistent', 'inconsistent', 'no_comparison']);
export const COMPENSATION_RECOMMENDATION_STATUSES = new Set(['personalized', 'market_estimate', 'unavailable', 'absent']);
export const COMPENSATION_RECOMMENDATION_CHECKS = new Set(['valid_saved_guidance', 'invalid_saved_guidance', 'unavailable', 'absent']);

// Capture before report filters remove nodes; never retain salary prose,
// source URLs, career evidence, personal desired salary, or justification text.
// Personal guidance contributes only fixed status/check codes and counts.
export function collectJobCompensationReport(nodes, { flat = false } = {}) {
  const pending = [nodes];
  const visited = new WeakSet();
  const rows = [];
  let inspectedNodes = 0;
  let inspectedCards = 0;
  while (pending.length && inspectedNodes < 20_000) {
    const level = pending.pop();
    if (!Array.isArray(level) || visited.has(level)) continue;
    visited.add(level);
    for (const node of level) {
      if (inspectedNodes++ >= 20_000) return { rows, inspectedCards, scanTruncated: true };
      if (!flat && node?.data?.canvasData?.nodes) pending.push(node.data.canvasData.nodes);
      if (node?.type !== 'jobcard') continue;
      inspectedCards++;
      if (rows.length >= 1000) continue;
      const job = node.data || {};
      const assessment = normalizeCompensationAssessment(job.compensationAssessment);
      const display = jobCompensationDisplay(job, assessment);
      const reachesFloor = assessment.offered.max >= assessment.competitiveRange.min;
      const personal = assessment.personalRecommendation;
      const rawPersonal = job.compensationAssessment?.personalRecommendation;
      rows.push({
        id: typeof node.id === 'string' ? node.id.slice(0, 256) : '',
        status: assessment.status,
        reason: COMPENSATION_COMPARISON_REASONS.has(assessment.reasonCode) ? assessment.reasonCode : 'other',
        offerReason: display.offerReason,
        advertised: display.hasAdvertisedPay,
        marketRange: assessment.competitiveRange.min > 0 && assessment.competitiveRange.max > 0,
        sourceCount: assessment.sourceLinks.length,
        thresholdCheck: assessment.reasonCode === 'inconsistent_comparison_verdict' ? 'inconsistent'
          : !display.determined ? 'no_comparison'
          : (assessment.status === 'competitive') === reachesFloor ? 'consistent' : 'inconsistent',
        recommendationStatus: personal?.status || 'absent',
        recommendationCheck: personal?.isInvalid === true || rawPersonal?.isInvalid === true ? 'invalid_saved_guidance'
          : !personal ? 'absent' : personal.status === 'unavailable' ? 'unavailable' : 'valid_saved_guidance',
        recommendationCareerPin: /^[a-f0-9]{64}$/.test(personal?.careerSnapshotId || ''),
        recommendationEvidenceCount: Array.isArray(rawPersonal?.evidenceIds)
          ? new Set(rawPersonal.evidenceIds.slice(0, 6).filter(id => typeof id === 'string' && id.trim() && id.length <= 80)).size : 0,
      });
    }
  }
  return { rows, inspectedCards, scanTruncated: pending.length > 0 };
}
