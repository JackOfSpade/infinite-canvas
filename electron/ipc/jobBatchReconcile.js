/**
 * Pure reconciliation of Batch-API scoring results back onto the jobs that were
 * submitted. Kept dependency-free so it's unit-testable without the Electron /
 * provider stack.
 *
 * The submit side groups jobs into batches and sends one request per batch with
 * `custom_id = "b{i}"`; within a request the scorer returns `{ scores: [{ index,
 * matchScore, reasoning, careerDirection, isTargetRoleMatch }, ...] }` where
 * `index` is the job's position WITHIN that batch. This mirrors the real-time
 * path's per-batch index matching, including the same placeholder fallbacks, so
 * a batch run produces the identical scoredJobs shape as a live run.
 *
 * @param {object[][]} scoringBatches  the exact job groupings submitted (full job objects)
 * @param {Record<string, object|null>} resultsByCustomId  parsed result per `b{i}` (null = unusable)
 * @param {{ fallbackScore: number }} opts
 * @returns {{ scoredJobs: object[], placeholderCount: number, failedBatches: number }}
 */
export function reconcileBatchScores(scoringBatches, resultsByCustomId, { fallbackScore } = {}) {
  const scoredJobs = [];
  let placeholderCount = 0;
  let failedBatches = 0;

  (Array.isArray(scoringBatches) ? scoringBatches : []).forEach((batch, i) => {
    const res = resultsByCustomId ? resultsByCustomId[`b${i}`] : null;
    const scores = Array.isArray(res?.scores)
      ? res.scores
      : Array.isArray(res)
        ? res
        : null;
    // allNull = "the whole batch produced zero usable scores", mirroring the
    // real-time path's `results.every(r => !r)` (jobs.js). It must be derived
    // from whether any job actually MATCHED a score — not merely whether a
    // scores array exists — so a present-but-fully-unmatched array (empty, or
    // all indices out of range) reports 'AI format error' + a failedBatch
    // identically to the live run, per buildScoredJob's contract below.
    const matchedScores = batch.map((_job, idx) => (scores ? scores.find(s => s.index === idx) || null : null));
    const allNull = matchedScores.every(m => !m);
    if (allNull) failedBatches++;

    batch.forEach((job, idx) => {
      const matched = matchedScores[idx];
      if (!matched) placeholderCount++;
      scoredJobs.push(buildScoredJob(job, matched, { fallbackScore, allNull }));
    });
  });

  // Same final ordering as the real-time path.
  scoredJobs.sort((a, b) => b.matchScore - a.matchScore);
  return { scoredJobs, placeholderCount, failedBatches };
}

/**
 * Build a single scored-job record from a job and its score (or null). Shared
 * by the real-time scoring loop (electron/ipc/jobs.js) and the Batch-API
 * reconciliation above so the matched/placeholder shape and the two fallback
 * strings stay in lockstep across both paths.
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
    return { ...job, ...scoreOrNull, isTargetRoleMatch: !!scoreOrNull.isTargetRoleMatch };
  }
  return {
    ...job,
    matchScore: fallbackScore,
    reasoning: allNull ? 'AI format error' : 'Unable to score',
    careerDirection: 'Other',
    isTargetRoleMatch: false,
  };
}
