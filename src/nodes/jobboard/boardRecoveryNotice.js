// Job Board recovery notice helpers.
//
// A manual-AI (taxonomy + compensation) handoff is persisted as a durable
// marker in the Board node's data. After a crash or interruption, the Board
// rehydrates that marker and needs a notice explaining how to resume it; while
// a combine is actually running in this mount, the marker is owned by that
// live run and must never be presented as "restored from disk". These small
// pure helpers keep that ownership decision and the supersede diagnostics in
// one place so the surrounding node remains readable.

// Exact user-facing text shown when an interrupted saved handoff can be
// resumed. Kept as a single exported constant so the node, its effect, and
// tests all reference the same string without drift.
export const SAVED_HANDOFF_READY_MESSAGE =
  'Saved AI handoff ready. Choose Continue saved AI handoff to resume this exact Board run.';

// Reports which of the three pre-commit invariants failed, in the same
// priority order the guard historically evaluated them. Any non-true value
// counts as failing so callers can pass raw boolean expressions directly.
export function combineCommitMismatchReason({ signatureMatches, selectedRunsMatch, exactSourceRunsMatch }) {
  if (signatureMatches !== true) return 'input-signature';
  if (selectedRunsMatch !== true) return 'selected-runs';
  if (exactSourceRunsMatch !== true) return 'exact-source-runs';
  return null;
}

// A marker is owned by a live combine only when both ids are non-empty
// strings and identical; otherwise the marker must have been restored from
// disk (or is simply a different run) and is eligible for the restore notice.
export function isLiveCombineOwnedMarker(resumeRunId, activeCombineRunId) {
  return (
    typeof resumeRunId === 'string'
    && resumeRunId.length > 0
    && typeof activeCombineRunId === 'string'
    && activeCombineRunId.length > 0
    && resumeRunId === activeCombineRunId
  );
}

// Preserve the exact replay marker before aborting its backend requests. The
// host acknowledgement is the stop boundary; accepted registry answers remain
// available when the same run is explicitly resumed.
export async function pauseBoardCombine({ runId, getMarker, saveMarker, waitForCommit, fence, pauseBackend, settle }) {
  const marker = getMarker();
  if (!runId || marker?.runId !== runId || marker.retirementPending) throw new Error('The Job Board run changed before it could pause.');
  saveMarker({ ...marker, pausedByUser: true, autoResumeEligible: false, updatedAt: Date.now() });
  await waitForCommit();
  if (getMarker()?.runId !== runId || getMarker()?.pausedByUser !== true) throw new Error('The Job Board checkpoint was not saved.');
  fence();
  const result = await pauseBackend();
  if (result?.settled !== true) throw new Error('The Job Board did not confirm that its saved work stopped. Retry Pause & save.');
  settle();
  return { success: true };
}
