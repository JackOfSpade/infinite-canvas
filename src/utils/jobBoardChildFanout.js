/**
 * Start independent Board children before awaiting any of them.  Results are
 * returned in the caller's selected order even when completion is out of
 * order, which keeps Board reconciliation, diagnostics, and recovery stable.
 */
export async function runJobBoardChildFanout(sourceIds, runChild, { onSettled } = {}) {
  const ids = Array.isArray(sourceIds)
    ? sourceIds.filter(sourceId => typeof sourceId === 'string' && sourceId)
    : [];
  if (typeof runChild !== 'function') throw new Error('runJobBoardChildFanout requires a child runner.');
  const started = ids.map((sourceId) => Promise.resolve().then(() => runChild(sourceId)));
  const settled = await Promise.all(started.map(async (promise, index) => {
    let settlement;
    try {
      settlement = { sourceId: ids[index], result: await promise };
    } catch (error) {
      settlement = { sourceId: ids[index], error };
    }
    // The Board uses this hook to commit each child outcome while another
    // child is still awaiting manual AI. Never let a persistence observer
    // turn a successfully-settled child into an unhandled fan-out rejection.
    if (typeof onSettled === 'function') {
      try {
        await onSettled(settlement);
      } catch (persistenceError) {
        // Preserve the child result, but make a failed crash-safety commit
        // observable to final reconciliation. Silently swallowing this would
        // let the Board clear an authority it failed to persist.
        settlement.persistenceError = persistenceError;
      }
    }
    return settlement;
  }));
  return settled;
}

/** Keep durable child-cleanup writes ordered while still reaching every child. */
export async function cancelJobBoardChildrenSequentially(sourceIds, cancelChild) {
  const ids = Array.isArray(sourceIds)
    ? sourceIds.filter(sourceId => typeof sourceId === 'string' && sourceId)
    : [];
  if (typeof cancelChild !== 'function') throw new Error('cancelJobBoardChildrenSequentially requires a child canceller.');
  const results = [];
  for (const sourceId of ids) {
    try {
      results.push({ sourceId, status: 'fulfilled', value: await cancelChild(sourceId) });
    } catch (error) {
      results.push({ sourceId, status: 'rejected', reason: error });
    }
  }
  const failed = results.find(result => result.status === 'rejected');
  if (failed) {
    const error = failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason));
    error.childCancellationResults = results;
    throw error;
  }
  return results;
}

/** Promote the next paused source without changing the selected-order queue. */
export function promoteJobBoardPausedSourceResolution({
  awaitingSourceResolutions,
  activeSourceId,
  activeSourceIds,
  activeSourceRollbacks,
  activeSourceManualAiRunIds,
  consumedSourceId,
} = {}) {
  const remaining = (Array.isArray(awaitingSourceResolutions) ? awaitingSourceResolutions : [])
    .filter(entry => entry?.sourceId && entry.sourceId !== consumedSourceId);
  const awaitingSourceResolution = remaining[0] || null;
  const ids = (Array.isArray(activeSourceIds) ? activeSourceIds : [])
    .filter(sourceId => sourceId && sourceId !== consumedSourceId);
  if (awaitingSourceResolution?.sourceId && !ids.includes(awaitingSourceResolution.sourceId)) {
    ids.unshift(awaitingSourceResolution.sourceId);
  }
  const remainingRollbacks = Object.fromEntries(ids.map((sourceId) => [
    sourceId,
    activeSourceRollbacks?.[sourceId],
  ]).filter(([, rollback]) => !!rollback));
  const remainingManualAiRunIds = Object.fromEntries(ids.map((sourceId) => [
    sourceId,
    activeSourceManualAiRunIds?.[sourceId],
  ]).filter(([, runId]) => typeof runId === 'string' && !!runId));
  const nextActiveSourceId = awaitingSourceResolution?.sourceId
    || (ids.includes(activeSourceId) ? activeSourceId : ids[0] || null);
  return {
    awaitingSourceResolution,
    awaitingSourceResolutions: remaining,
    activeSourceIds: ids,
    activeSourceId: nextActiveSourceId,
    activeSourceRollback: nextActiveSourceId
      ? remainingRollbacks[nextActiveSourceId] || null
      : null,
    activeSourceRollbacks: remainingRollbacks,
    activeSourceManualAiRunIds: remainingManualAiRunIds,
  };
}
