import { normalizeCompensationAssessment } from '../nodes/jobsearch/buildJobTree.js';
import { COMPENSATION_COMPARISON_REASONS, jobCompensationDisplay } from './jobCompensationDisplay.js';

export const COMPENSATION_REPORT_STATUSES = new Set(['competitive', 'lower_market', 'below_market', 'market_recommendation', 'uncertain', 'not_evaluated']);
export const COMPENSATION_THRESHOLD_CHECKS = new Set(['consistent', 'inconsistent', 'no_comparison']);
export const COMPENSATION_RECOMMENDATION_STATUSES = new Set(['personalized', 'market_estimate', 'unavailable', 'absent']);
export const COMPENSATION_RECOMMENDATION_CHECKS = new Set(['valid_saved_guidance', 'invalid_saved_guidance', 'unavailable', 'absent']);
// Title of the work-location receipt that salary research appends to
// sourceLinks (locationSourceLink in electron/ipc/jobLocationLookup.js). It
// records where the work location was read, not salary evidence, so the
// report counts it apart from market sources. A test pins the two together.
export const COMPENSATION_LOCATION_RECEIPT_TITLE = 'Employer posting (work location)';

// Counts saved source links from the raw assessment, because the normalized
// copy keeps only five and could drop the receipt. Only link-shaped entries
// with a URL count, matching what the card can show.
function sourceLinkCounts(rawLinks) {
  let marketSourceCount = 0;
  let locationReceipt = false;
  for (const link of Array.isArray(rawLinks) ? rawLinks.slice(0, 50) : []) {
    const url = typeof link === 'string' ? link : link && typeof link === 'object' ? (link.url ?? link.href ?? link.link) : '';
    if (typeof url !== 'string' || !url.trim()) continue;
    if (link?.title === COMPENSATION_LOCATION_RECEIPT_TITLE) locationReceipt = true;
    else marketSourceCount++;
  }
  return { marketSourceCount, locationReceipt };
}

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
      // Typical researched pay when the saved assessment carries it; saved
      // assessments that predate the field keep the old lowest-low floor.
      const threshold = assessment.competitiveFloor > 0 ? assessment.competitiveFloor : assessment.competitiveRange.min;
      const expectedStatus = assessment.offered.max >= threshold ? 'competitive'
        : assessment.offered.max >= assessment.competitiveRange.min ? 'lower_market' : 'below_market';
      // How far the posted maximum sits from typical pay, as a whole percent.
      // A ratio, not an amount: it shows how close a verdict was to its cut
      // point without putting any salary figure in the report.
      const gapPercent = display.determined && threshold > 0 && assessment.offered.max > 0
        ? Math.max(-999, Math.min(999, Math.round((assessment.offered.max / threshold - 1) * 1000) / 10)) : null;
      const personal = assessment.personalRecommendation;
      const rawAssessment = job.compensationAssessment;
      const links = sourceLinkCounts(rawAssessment && typeof rawAssessment === 'object'
        ? rawAssessment.sourceLinks ?? rawAssessment.sources ?? rawAssessment.evidence : null);
      const rawPersonal = job.compensationAssessment?.personalRecommendation;
      rows.push({
        id: typeof node.id === 'string' ? node.id.slice(0, 256) : '',
        status: assessment.status,
        reason: COMPENSATION_COMPARISON_REASONS.has(assessment.reasonCode) ? assessment.reasonCode : 'other',
        offerReason: display.offerReason,
        advertised: display.hasAdvertisedPay,
        marketRange: assessment.competitiveRange.min > 0 && assessment.competitiveRange.max > 0,
        marketSourceCount: links.marketSourceCount,
        locationReceipt: links.locationReceipt,
        thresholdCheck: assessment.reasonCode === 'inconsistent_comparison_verdict' ? 'inconsistent'
          : !display.determined ? 'no_comparison'
          : assessment.status === expectedStatus ? 'consistent' : 'inconsistent',
        typicalGapPercent: gapPercent,
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
