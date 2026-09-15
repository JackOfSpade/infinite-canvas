/**
 * Build the prompt parts for one job-scoring request.
 *
 * Every job-scoring call is a human copy/paste handoff now (nonApiAi.js) —
 * there is no provider-side cache left to earn back with a separate prefix.
 * What splitting the prefix out still buys, on a multi-batch run, is for the
 * HUMAN doing the pasting: materializeNonApiPrompt (nonApiAi.js) and
 * manualRequestConfig (llm.js) both keep `cachedPrefix` as its own section
 * and note in the handoff settings that it repeats verbatim, so the rubric
 * and candidate evidence read as the identical, recognizable boilerplate
 * across every batch's dialog instead of silently re-flowing into a
 * differently-merged prompt each time. A single-batch run has no repetition
 * to keep consistent, so it merges the prefix into one paste instead of
 * splitting a one-shot prompt for no reason.
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
