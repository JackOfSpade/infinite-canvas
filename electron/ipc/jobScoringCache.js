/**
 * Build the prompt parts for one job-scoring request.
 *
 * Anthropic charges a cache write premium that cannot pay back in a normal
 * one-batch run. The scoring rubric and candidate evidence are still prompt
 * content in that case: merge them into the request body instead of dropping
 * them. Multi-batch runs keep the prefix separate so each later request can
 * reuse Anthropic's ephemeral cache.
 */
export function buildJobScoringRequestParts(prompt, cachedPrefix, topLevelBatchCount) {
  const hasPrefix = typeof cachedPrefix === 'string' && cachedPrefix.length > 0;
  const batchCount = Math.max(0, Math.floor(Number(topLevelBatchCount) || 0));

  if (!hasPrefix) return { prompt, cachedPrefix: null };
  if (batchCount >= 2) return { prompt, cachedPrefix };

  return {
    prompt: `${cachedPrefix}\n\n${prompt}`,
    cachedPrefix: null,
  };
}
