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
    const allNull = !scores;
    if (allNull) failedBatches++;

    batch.forEach((job, idx) => {
      const matched = scores ? scores.find(s => s.index === idx) : null;
      if (matched) {
        scoredJobs.push({ ...job, ...matched, isTargetRoleMatch: !!matched.isTargetRoleMatch });
      } else {
        placeholderCount++;
        // Whole batch unusable → 'AI format error'; a lone job missing from an
        // otherwise-good batch → 'Unable to score'. Both are flagged placeholders.
        scoredJobs.push({
          ...job,
          matchScore: fallbackScore,
          reasoning: allNull ? 'AI format error' : 'Unable to score',
          careerDirection: 'Other',
          isTargetRoleMatch: false,
        });
      }
    });
  });

  // Same final ordering as the real-time path.
  scoredJobs.sort((a, b) => b.matchScore - a.matchScore);
  return { scoredJobs, placeholderCount, failedBatches };
}
