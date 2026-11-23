// A Job Board run that re-scores a Search's saved jobs and then searches again
// records the re-scored card as that search's rollback (`rescoreFollowUps`).
// From then on a cancel keeps the re-score, so the rollback taken before the
// re-score is never used again. It is replaced, not kept beside the new one:
// each rollback is a full copy of the Search card (163MB measured 2026-11-23),
// and two different copies pushed the canvas past what a save can write.

/**
 * The plan's rollback slots with every re-score follow-up's rollback in place
 * of the older one for the same Search. Only slots that already hold a rollback
 * for that Search change; nothing is added. Returns only the slots that
 * changed, so spreading it over a plan never adds a key the plan lacked.
 */
export function withRescoreFollowUpRollbacks({
  activeSourceRollback = null,
  activeSourceRollbacks = undefined,
  rescoreFollowUps = null,
} = {}) {
  let single = activeSourceRollback;
  let bySource = activeSourceRollbacks;
  for (const [sourceId, followUp] of Object.entries(rescoreFollowUps || {})) {
    const rollback = followUp?.rollback;
    if (!rollback || typeof rollback !== 'object' || rollback.sourceId !== sourceId) continue;
    if (bySource && typeof bySource === 'object' && bySource[sourceId] && bySource[sourceId] !== rollback) {
      bySource = { ...bySource, [sourceId]: rollback };
    }
    if (single?.sourceId === sourceId && single !== rollback) single = rollback;
  }
  return {
    ...(single !== activeSourceRollback ? { activeSourceRollback: single } : {}),
    ...(bySource !== activeSourceRollbacks ? { activeSourceRollbacks: bySource } : {}),
  };
}
