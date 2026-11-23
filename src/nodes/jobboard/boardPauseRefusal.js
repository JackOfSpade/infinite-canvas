// What the Job Board does when a Pause & save (or a quit pause) is not
// confirmed.
//
// The Board marks its saved run "paused by the user" before it asks the app
// process to stop the work, because the saved mark has to exist before any
// worker is aborted. The app process can still refuse (see
// 'pause-job-run-and-cancel' in electron/ipc/jobs/coreHandlers.js), and a
// refusal stops nothing. These pure helpers decide, from the answers alone,
// whether the marks may stay and what the Board can truthfully say.

const PAUSE_FLAG_KEYS = ['pausedByUser', 'autoResumeEligible'];

/** The two pause flags exactly as stored (a missing flag stays undefined). */
export function pauseFlagsOf(record) {
  return { pausedByUser: record?.pausedByUser, autoResumeEligible: record?.autoResumeEligible };
}

/** The record with its pause flags put back; a flag that was absent is removed. */
export function withPauseFlags(record, prior, now = Date.now()) {
  const next = { ...record, updatedAt: now };
  for (const key of PAUSE_FLAG_KEYS) {
    if (prior?.[key] === undefined) delete next[key];
    else next[key] = prior[key];
  }
  return next;
}

const stillPausedByThisAttempt = record => record?.pausedByUser === true && record?.autoResumeEligible === false;
// A record that was already paused before the attempt has nothing to take back.
const wasAlreadyPaused = prior => prior?.pausedByUser === true && prior?.autoResumeEligible === false;

/**
 * The node-data patch that takes back the pause marks one pause attempt set.
 *
 * `applied` is what that attempt recorded when it wrote the marks:
 *   plan:   { boardRunId, prior }                 for boardScanResume
 *   marker: { runId, existed, priorValue, prior } for manualAiResume
 * A mark is restored only when the saved record still names the same run and
 * still carries the paused flags. Anything else belongs to a newer writer and
 * is left alone. Returns null when nothing may be restored.
 */
export function boardPauseRestorePatch(data, applied, now = Date.now()) {
  const patch = {};
  const plan = data?.boardScanResume;
  if (applied?.plan && plan && (plan.boardRunId ?? null) === (applied.plan.boardRunId ?? null)
    && stillPausedByThisAttempt(plan) && !wasAlreadyPaused(applied.plan.prior)) {
    patch.boardScanResume = withPauseFlags(plan, applied.plan.prior, now);
  }
  const marker = data?.manualAiResume;
  if (applied?.marker && marker && marker.runId === applied.marker.runId && stillPausedByThisAttempt(marker)
    && !(applied.marker.existed && wasAlreadyPaused(applied.marker.prior))) {
    // A marker this attempt created from the live Combine did not exist
    // before; put back exactly what was there (null or nothing).
    patch.manualAiResume = applied.marker.existed
      ? withPauseFlags(marker, applied.marker.prior, now)
      : applied.marker.priorValue;
  }
  return Object.keys(patch).length ? patch : null;
}

/**
 * How the app process answered the pause request.
 *
 *  confirmed   - it stopped the Board's own work and said so.
 *  refused     - it returned before aborting anything; nothing was stopped.
 *  not-settled - it asked the work to stop (or drained it for quit) but did
 *                not confirm that it stopped.
 *  failed      - the request threw or the app has no such call; unknown.
 *
 * Only the final return of the handler carries `pausedContinuations`, and it
 * is reached only after the abort was requested, so that key separates
 * "not-settled" from the early refusals.
 */
export function boardPauseBackendAnswer(acknowledgement, backendError = null, { drainedBeforeAnswer = false } = {}) {
  if (backendError) return { kind: 'failed', reason: backendError?.message || 'request-failed' };
  if (!acknowledgement) return { kind: 'failed', reason: 'no-answer' };
  if (acknowledgement.settled === true && acknowledgement.ok !== false) return { kind: 'confirmed', reason: null };
  const reason = acknowledgement.operationAuthorityMismatch ? 'operation-authority-mismatch'
    : acknowledgement.reason || (acknowledgement.tokenMismatch ? 'ownership-mismatch' : 'not-confirmed');
  // A pause sent with cause 'app-quit' drains the node's tasks before every
  // refusal except a missing node id, so such a refusal is not proof that the
  // work is still running.
  const abortRequested = 'pausedContinuations' in acknowledgement || reason === 'quit-pause-not-settled'
    || (drainedBeforeAnswer && reason !== 'missing-node');
  return { kind: abortRequested ? 'not-settled' : 'refused', reason };
}

/**
 * Decide what a finished pause attempt proved.
 *
 * `children` are the Promise.allSettled results of the child Search pauses.
 * A child that answered `idle` had nothing running and is not counted as
 * paused work.
 *
 * The marks stay only when every active Search really paused and saved, the
 * Board is in its searches phase, and it holds no Combine handoff of its own:
 * then "Search paused and saved" is true and un-marking would let a restart
 * resume searches the person deliberately paused. In every other unconfirmed
 * case some work was not proven stopped, so the marks are restored.
 */
export function classifyBoardPauseOutcome({ acknowledgement, backendError = null, children = [], phase = null, hasCombineMarker = false, drainedBeforeAnswer = false } = {}) {
  const backend = boardPauseBackendAnswer(acknowledgement, backendError, { drainedBeforeAnswer });
  let paused = 0;
  let idle = 0;
  let failed = 0;
  for (const child of children) {
    if (child?.status === 'fulfilled' && child.value?.success === true) {
      if (child.value.idle === true) idle += 1; else paused += 1;
    } else failed += 1;
  }
  const confirmed = backend.kind === 'confirmed' && failed === 0;
  const searchesPhase = !phase || phase === 'searches';
  const keepMarks = !confirmed && failed === 0 && paused > 0 && searchesPhase && !hasCombineMarker;
  return {
    confirmed,
    backend: backend.kind,
    reason: backend.reason,
    searches: { total: children.length, paused, idle, failed },
    restoreMarks: !confirmed && !keepMarks,
  };
}

function searchesSentence({ paused, failed }) {
  const active = paused + failed;
  if (active === 0) return '';
  if (failed === 0) return active === 1 ? 'The active Search paused and saved.' : `All ${active} active Searches paused and saved.`;
  if (paused === 0) {
    return active === 1
      ? 'The active Search did not confirm its pause and may still be running.'
      : `None of the ${active} active Searches confirmed a pause; they may still be running.`;
  }
  return `${paused} of ${active} active Searches paused and saved; ${failed} did not confirm and may still be running.`;
}

function backendSentence({ backend, reason }) {
  if (backend === 'confirmed') return 'The Job Board\'s own work stopped.';
  if (backend === 'refused') {
    return `The app refused the Job Board's pause (${reason}) and stopped none of the Board's own work, so that work is still running.`;
  }
  if (backend === 'not-settled') {
    return `The app asked the Job Board's own work to stop but did not confirm a saved pause (${reason}).`;
  }
  return `The pause request to the app failed (${reason}), so it is not known whether the Job Board's own work stopped.`;
}

/**
 * The plain statement shown for an unconfirmed pause. `marksRestored` is
 * whether the paused marks were actually taken back.
 */
export function boardPauseRefusalMessage(outcome, { marksRestored = false } = {}) {
  const parts = [
    'Pause & save was not confirmed.',
    searchesSentence(outcome.searches),
    backendSentence(outcome),
    marksRestored
      ? 'The Job Board is not marked paused. Retry to pick this Board run back up.'
      : outcome.restoreMarks
        ? 'The Job Board\'s paused mark was left as it is (it was already paused, or its saved run changed meanwhile).'
        : 'The Job Board stays marked paused; Continue resumes this exact run.',
  ];
  return parts.filter(Boolean).join(' ');
}
