import { normalizeLocationInput } from './jobLocation.js';

// This host-issued receipt proves the source-resolution boundary was already
// crossed. Reopening its provider ledger would lose later recovered details.
export function hasCheckpointedPostCollectionAnalysis(offer) {
  const base = offer?.operationAuthority?.semanticBase;
  return offer?.found === true && offer.providerGathered === true
    && !!offer.runId && base?.runId === offer.runId
    && !!offer.careerSnapshotId && base.careerSnapshotId === offer.careerSnapshotId
    && ['resolved-source-continuation', 'resume-saved-scrape'].includes(base.kind);
}

function normalizeResumeProfileFingerprint(value) {
  const fingerprint = typeof value === 'string' ? value.trim() : '';
  return /^[a-f0-9]{64}$/.test(fingerprint) ? fingerprint : '';
}

// The Board's disabled-platform recovery affordance is deliberately narrower
// than normal Search readiness.  It may reuse the manifest's frozen provider
// breadth, but only after proving that the manifest is still the exact,
// location-safe run owned by this Search.  Keeping the policy pure makes the
// click-time and lane-time checks testable without mounting a React node.
export function exactInterruptedRecoveryAdmission({
  info,
  nodeId,
  sourceData,
  platformsVerifying = false,
  // The Board's own interrupted child: the run's age is not a reason to stop
  // (the 24-hour mark is a display hint; the resume itself has no age limit,
  // and refusing here would leave only Cancel, which discards the run).
  allowAged = false,
} = {}) {
  if (platformsVerifying) return { ok: false, reason: 'platforms-verifying' };
  if (!info?.found) return { ok: false, reason: 'not-found' };
  if (info.resumable !== true && !(allowAged === true && info.incomplete === true)) {
    return { ok: false, reason: 'not-resumable' };
  }
  if (typeof nodeId !== 'string' || !nodeId || info.nodeId !== nodeId) {
    return { ok: false, reason: 'wrong-owner' };
  }
  if (typeof info.runId !== 'string' || !info.runId.trim()) {
    return { ok: false, reason: 'missing-run-id' };
  }
  if (!(sourceData?.resumeProfile && typeof sourceData.resumeProfile === 'object'
    && !Array.isArray(sourceData.resumeProfile))) {
    return { ok: false, reason: 'missing-profile' };
  }
  // A profile object alone is not an identity contract: it can have been
  // replaced after the interrupted rows were staged. The parse pipeline's
  // full-content fingerprint is opaque, but pins recovery to that exact input
  // without sending any career material through this admission boundary.
  const sourceFingerprint = normalizeResumeProfileFingerprint(sourceData?.resumeFingerprint);
  const manifestFingerprint = normalizeResumeProfileFingerprint(info.profileFingerprint);
  if (!manifestFingerprint) return { ok: false, reason: 'missing-profile-fingerprint' };
  if (!sourceFingerprint) return { ok: false, reason: 'missing-current-profile-fingerprint' };
  if (sourceFingerprint !== manifestFingerprint) {
    return { ok: false, reason: 'profile-fingerprint-mismatch' };
  }
  const queries = Array.isArray(info.queries)
    ? info.queries.filter(query => typeof query === 'string' && query.trim())
    : [];
  if (queries.length === 0) return { ok: false, reason: 'missing-queries' };
  if (info.locationRecorded !== true) return { ok: false, reason: 'missing-location' };

  const sourceLocation = normalizeLocationInput(
    sourceData.canonicalLocation || sourceData.preferredLocation || '',
  ).boardReady;
  const manifestLocation = normalizeLocationInput(info.canonicalLocation || '').boardReady;
  if (sourceLocation !== manifestLocation) return { ok: false, reason: 'location-mismatch' };

  return {
    ok: true,
    runId: info.runId,
    queries,
    canonicalLocation: manifestLocation,
    profileFingerprint: manifestFingerprint,
  };
}

// True when the Board's saved plan names this Search as a child it had already
// started: the app closed (or was paused) while that child was running.
export function isInterruptedBoardChild(plan, sourceId) {
  if (!plan || plan.phase !== 'searches' || typeof sourceId !== 'string' || !sourceId) return false;
  return plan.activeSourceId === sourceId
    || (Array.isArray(plan.activeSourceIds) && plan.activeSourceIds.includes(sourceId));
}

/**
 * True when a card that reads as a finished, usable search may still have an
 * unfinished search saved on disk.
 *
 * A Board search of a finished card clears the card's run id when it starts
 * and keeps the earlier jobs on the card. If that search is paused or the app
 * closes before it saves any jobs, the card reloads as "done" with the earlier
 * jobs and no run id, which reads exactly like an old finished search. The
 * unfinished run on disk is then the only trace of it. So the disk is checked
 * for a finished card with no run id, and for any finished card this Board's
 * own saved plan had already started.
 *
 * `boardId` names the Board asking. A search that was adding jobs to the ones
 * another Board shows (`carriedResults.boardId`) is that Board's to continue:
 * continuing it here would show those jobs on a second Board.
 */
export function finishedCardMayHideUnfinishedRun(readiness, sourceData, { interruptedBoardChild = false, boardId = null } = {}) {
  if (readiness?.ready !== true || sourceData?.hubState !== 'done') return false;
  if (!['reuse', 'scan', 'cooldown'].includes(readiness.boardAction)) return false;
  if (interruptedBoardChild === true) return true;
  const hasRunId = typeof sourceData.jobRunId === 'string' && !!sourceData.jobRunId.trim();
  if (hasRunId) return false;
  const carriedBoardId = sourceData.carriedResults?.boardId;
  return !(typeof carriedBoardId === 'string' && carriedBoardId
    && typeof boardId === 'string' && boardId && carriedBoardId !== boardId);
}

/**
 * Whether the Board may look on disk for this Search's unfinished run before
 * deciding the Search is not ready.
 *
 * A paused source still belongs to its Source-card Resolve/Skip path, so a
 * `sources-ready` card never probes. Otherwise a probe is allowed when:
 *   - the only obstacle is the current platform selection or an already
 *     consumed import (the unfinished run carries its own frozen inputs); or
 *   - the Board's own saved plan had already started this Search and the card
 *     now reads as "needs new career data". An interrupted search leaves its
 *     AI-handoff marker on the card, and that marker alone makes a completed
 *     card read that way; the unfinished run on disk is the real state.
 *   - the card reads as a finished search but may hide an unfinished one
 *     (`finishedCardMayHideUnfinishedRun`).
 * Only an exact run can continue; a missing one stays not-ready.
 */
export function boardMayProbeInterruptedRun(readiness, sourceData, { interruptedBoardChild = false, boardId = null } = {}) {
  const probeReason = readiness?.statusLabel === 'Needs platform'
    || readiness?.boardAction === 'fresh-import-blocked'
    || (interruptedBoardChild === true && readiness?.boardAction === 'terminal-blocked')
    || finishedCardMayHideUnfinishedRun(readiness, sourceData, { interruptedBoardChild, boardId });
  return probeReason
    && sourceData?.hubState !== 'sources-ready'
    && !!sourceData?.resumeProfile
    && typeof sourceData.resumeProfile === 'object';
}

/**
 * The id of an unfinished search run on disk that belongs to this Search and
 * is not the run its saved results came from, or null.
 */
/** True when the lookup itself failed, so nothing is known about the disk. */
export function unfinishedRunLookupFailed(info) {
  return !info || info.success === false;
}

export function ownedUnfinishedRunOnDisk(info, { nodeId, savedRunId = null } = {}) {
  if (info?.found !== true || typeof nodeId !== 'string' || !nodeId || info.nodeId !== nodeId) return null;
  const runId = typeof info.runId === 'string' ? info.runId.trim() : '';
  if (!runId || runId === savedRunId) return null;
  return runId;
}

// `resumeRunId` is a compare-and-clear capability. When the main process
// reports that it vanished or was replaced after the Board's preflight, keep
// that result in the recovery lane instead of treating it as an ordinary
// provider failure. Keeping this classification pure makes the renderer's
// token-failure path directly testable.
export function exactInterruptedRecoveryBackendFailure(result, expectedRunId) {
  const runId = typeof expectedRunId === 'string' ? expectedRunId.trim() : '';
  if (!runId || result?.success !== false) return null;

  const reason = result.resumeRunMismatch === true
    ? 'run-mismatch'
    : result.resumeRunMissing === true
      ? 'run-missing'
      : result.resumeProfileMismatch === true
        ? 'profile-mismatch'
        : result.resumeProfileMissing === true
          ? 'profile-missing'
      : null;
  if (!reason) return null;

  return {
    reason,
    runId,
    error: typeof result.error === 'string' && result.error.trim()
      ? result.error
      : 'The saved Job Search recovery changed before the Job Board could resume it.',
  };
}
