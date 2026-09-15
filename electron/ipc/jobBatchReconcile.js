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
  if (scoreOrNull) {
    return { ...job, ...scoreOrNull };
  }
  return {
    ...job,
    matchScore: fallbackScore,
    reasoning: allNull ? 'AI format error' : 'Unable to score',
    careerDirection: 'Other',
  };
}
