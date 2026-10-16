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

// The two placeholder explanations. The renderer's legacy-card migration
// (src/utils/serializationUtils.js) recognizes an unflagged placeholder saved
// before `scoreStatus` existed by exact equality with one of these, so a test
// keeps the two lists identical; never substring-match them.
export const UNSCORED_PLACEHOLDER_REASONS = Object.freeze(['AI format error', 'Unable to score']);

// Structural marker for a job the AI never actually scored. The numeric
// fallback (UNSCORED_FALLBACK_SCORE in jobs.js) is only a display sentinel; a
// consumer that must tell "scored low" from "never scored" (the board's card
// filter, the compensation gate, a report) reads this field, not the number.
export const UNSCORED_SCORE_STATUS = 'unscored';

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
    reasoning: allNull ? UNSCORED_PLACEHOLDER_REASONS[0] : UNSCORED_PLACEHOLDER_REASONS[1],
    careerDirection: 'Other',
    scoreStatus: UNSCORED_SCORE_STATUS,
  };
}
