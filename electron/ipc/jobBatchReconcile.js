/**
 * Build a single scored-job record from a job and its score (or null). Used by
 * the real-time scoring loop (electron/ipc/jobs.js) so the matched/placeholder
 * shape and the two fallback strings stay consistent across every batch.
 *
 * @param {object} job              the full job object
 * @param {object|null} scoreOrNull the matched score for this job, or null
 * @param {{ fallbackScore: number, allNull: boolean }} opts
 *   - fallbackScore: matchScore to assign when no score matched
 *   - allNull: true when the whole batch was unusable → 'AI format error';
 *              false when a lone job was missing from an otherwise-good batch
 *              → 'Unable to score'. Both are flagged placeholders.
 * @returns {object} the scored-job record
 */
export function buildScoredJob(job, scoreOrNull, { fallbackScore, allNull }) {
  // A saved-job re-score can receive a previously scored row. Neither a failed
  // retry nor a fresh success may inherit its old score, audit, or unscored
  // marker simply because the new response omitted that optional field.
  const cleanJob = { ...job };
  for (const key of [
    'index', 'matchScore', 'rawScore', 'adjustedScore', 'reasoning', 'careerDirection',
    'requirementAssessments', 'materialGaps', 'confidence', 'compensationContext',
    'strengths', 'experienceAssessment', 'fitAssessment', 'scoringEvidenceReceipt',
    'scoreStatus', 'scoringCoverageReceipt',
  ]) delete cleanJob[key];
  if (scoreOrNull) {
    return { ...cleanJob, ...scoreOrNull };
  }
  return {
    ...cleanJob,
    matchScore: fallbackScore,
    reasoning: allNull ? 'AI format error' : 'Unable to score',
    careerDirection: 'Other',
  };
}
