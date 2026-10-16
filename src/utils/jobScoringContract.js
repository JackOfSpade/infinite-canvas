export const JOB_SCORING_CONTRACT = 'whole-record-v3';

// The retired page merger dropped confidence and concatenated independent
// four-row audits into a larger inventory. Restrict the repair to that known
// shape, bound to the current approved career snapshot; ordinary historical
// scores and scores from a different career import are not silently migrated.
export function hasLegacyPageScoring(data) {
  const pin = data?.careerSnapshotId;
  if (!/^[a-f0-9]{64}$/.test(pin || '') || data?.savedJobsRescore) return false;
  return (Array.isArray(data.scoredJobs) ? data.scoredJobs : []).some(row => (
    row?.careerSnapshotId === pin
    && row?.scoringEvidenceReceipt?.contract !== JOB_SCORING_CONTRACT
    && row?.fitAssessment?.confidence?.reported === 'unknown'
    && Array.isArray(row?.fitAssessment?.requirementRows)
    && row.fitAssessment.requirementRows.length > 4
  ));
}

const safeValue = (value, key) => { try { return value?.[key]; } catch { return undefined; } };

export function summarizeJobScoringIntegrity(data, limit = 2000) {
  const source = safeValue(data, 'scoredJobs');
  if (!Array.isArray(source)) return null;
  const sample = source.slice(0, limit);
  const result = { version: 1, total: source.length, inspected: sample.length, currentContract: 0, atLeast70: 0, cappedBelow70: 0, legacyPageMerge: 0 };
  for (const row of sample) {
    const audit = safeValue(row, 'fitAssessment');
    const confidence = safeValue(audit, 'confidence');
    const receipt = safeValue(row, 'scoringEvidenceReceipt');
    const score = safeValue(row, 'matchScore');
    const raw = safeValue(row, 'rawScore');
    const current = safeValue(receipt, 'contract') === JOB_SCORING_CONTRACT;
    if (current) result.currentContract++;
    if (Number.isFinite(score) && score >= 70 && score <= 100) result.atLeast70++;
    if (Number.isFinite(score) && score >= 0 && score < 70 && Number.isFinite(raw) && raw >= 70 && raw <= 100) result.cappedBelow70++;
    const requirements = safeValue(audit, 'requirementRows');
    if (!current && safeValue(confidence, 'reported') === 'unknown' && Array.isArray(requirements) && requirements.length > 4) result.legacyPageMerge++;
  }
  return result;
}

export function normalizeJobScoringIntegrity(value) {
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.total) || value.total < 0
    || !Number.isSafeInteger(value.inspected) || value.inspected < 0 || value.inspected > Math.min(value.total, 2000)) return null;
  const result = { version: 1, total: value.total, inspected: value.inspected };
  for (const key of ['currentContract', 'atLeast70', 'cappedBelow70', 'legacyPageMerge']) {
    const count = safeValue(value, key);
    if (!Number.isSafeInteger(count) || count < 0 || count > value.inspected) return null;
    result[key] = count;
  }
  return result;
}
