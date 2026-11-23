// Job Board recovery notice helpers.
//
// A manual-AI (taxonomy + compensation) handoff is persisted as a durable
// marker in the Board node's data. After a crash or interruption, the Board
// rehydrates that marker and needs a notice explaining how to resume it; while
// a combine is actually running in this mount, the marker is owned by that
// live run and must never be presented as "restored from disk". These small
// pure helpers keep that ownership decision and the supersede diagnostics in
// one place so the surrounding node remains readable.

import { boardPauseBackendAnswer, pauseFlagsOf, withPauseFlags } from './boardPauseRefusal.js';

// Exact user-facing text shown when an interrupted saved handoff can be
// resumed. Kept as a single exported constant so the node, its effect, and
// tests all reference the same string without drift.
export const SAVED_HANDOFF_READY_MESSAGE =
  'Saved AI handoff ready. Choose Continue saved AI handoff to resume this exact Board run.';

// The same saved pause taken while the Board is still running its Searches.
// No AI handoff exists yet in that phase, so it is named as a search.
export const SAVED_SEARCH_PAUSE_MESSAGE =
  'Search paused and saved. Choose Continue search to resume this exact Board run.';

// The Continue button label for the search-phase pause above.
export const CONTINUE_SEARCH_ACTION_LABEL = 'Continue search';

// Which saved-pause notice a paused Board publishes. Only a searches-phase
// plan with no Board AI handoff marker is a search pause; every other saved
// pause (a Combine handoff, or a plan of any other phase) keeps the AI-handoff
// notice and its behaviour unchanged.
export function savedPauseMessageForPlan(plan, manualAiResume = null) {
  const searchesPhase = !!plan && (!plan.phase || plan.phase === 'searches');
  return searchesPhase && !manualAiResume ? SAVED_SEARCH_PAUSE_MESSAGE : SAVED_HANDOFF_READY_MESSAGE;
}

// Either saved-pause notice: both mean "waiting for Continue", never a failure.
export function isSavedPauseNotice(message) {
  return message === SAVED_HANDOFF_READY_MESSAGE || message === SAVED_SEARCH_PAUSE_MESSAGE;
}

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
  let result = null;
  let backendError = null;
  try {
    result = await pauseBackend();
  } catch (error) {
    backendError = error;
  }
  if (backendError || result?.settled !== true) {
    // The app process refused or did not confirm, so the work was not proven
    // stopped. Take back the paused mark this call set (only while the marker
    // still names this run and still carries it); the fence above cannot be
    // undone, so the caller holds the run for an explicit Retry.
    const answer = boardPauseBackendAnswer(result, backendError);
    const current = getMarker();
    const alreadyPaused = marker?.pausedByUser === true && marker?.autoResumeEligible === false;
    const restored = !alreadyPaused && current?.runId === runId && current.pausedByUser === true && current.autoResumeEligible === false;
    if (restored) saveMarker(withPauseFlags(current, pauseFlagsOf(marker)));
    const error = new Error([
      answer.kind === 'refused'
        ? `The app refused the Job Board's pause (${answer.reason}) and stopped none of its work, so that work is still running.`
        : answer.kind === 'not-settled'
          ? `The Job Board did not confirm that its saved work stopped (${answer.reason}).`
          : `The pause request failed (${answer.reason}), so the Job Board did not confirm that its saved work stopped.`,
      restored ? 'The Job Board is not marked paused. Retry to pick this Board run back up.' : alreadyPaused ? 'The Job Board was already marked paused and stays so.' : 'Retry Pause & save.',
    ].join(' '));
    error.pauseMarkRestored = restored;
    error.pauseRefusalReason = answer.reason;
    throw error;
  }
  settle();
  return { success: true };
}
