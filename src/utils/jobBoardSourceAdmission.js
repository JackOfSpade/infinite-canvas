import { hubHasAcceptedInitialDrop } from './hubDropEligibility.js';
import {
  freshJobCareerImportCapability,
  retryableUnstartedJobCareerImportCapability,
  retryableCancelledJobCareerImportCapability,
} from './jobCareerImportCapability.js';
import {
  careerImportCompilationAdmission,
  careerResumeInputPaths,
  currentApprovedCareerImportSnapshot,
} from './jobCareerCompilationReceipt.js';
import {
  isMergeableTerminalJobSearchOutcome,
  terminalJobSearchOutcome,
} from './jobBoardPausedSourceContinuation.js';
import {
  isCareerClearedWithSavedJobs,
  pendingSavedJobsRescore,
  savedJobCount,
} from './jobSearchSplitClear.js';
import { jobSearchRescrapeAvailability } from './jobSearchSourceCoverage.js';
import { normalizedJobCareerSnapshotId } from './jobCareerSnapshotBinding.js';
// Circular with jobSearchCarriedResults.js (it imports jobSearchShownRun); both only call at run time.
import { jobSearchCarriedResultsMarker } from './jobSearchCarriedResults.js';

/**
 * Which Board first displayed a Search run's jobs. Written on the Search card
 * by the Board's Combine when it creates result cards, so it survives that
 * Board's deletion. A run's jobs are shown on at most this one Board: another
 * Board leaves them out, and once they have been shown the next Board search
 * may replace them with a fresh scrape. Only the marker for the card's CURRENT
 * run counts; a later run makes it obsolete on its own.
 */
export function jobSearchShownRun(data) {
  const marker = data?.boardShownRun;
  const runId = typeof data?.jobRunId === 'string' && data.jobRunId ? data.jobRunId : null;
  if (!runId || !marker || typeof marker !== 'object' || marker.runId !== runId) return null;
  return typeof marker.boardId === 'string' && marker.boardId ? marker : null;
}

/** True when another Board (live or deleted) already displayed this run. */
export function isJobSearchRunShownOnOtherBoard(source, boardId) {
  const shown = jobSearchShownRun(source?.data);
  return !!shown && typeof boardId === 'string' && !!boardId && shown.boardId !== boardId;
}

/**
 * The card patch a Board writes when its Combine displays this run's jobs.
 * Null when there is nothing to record or the run is already claimed (by this
 * or another Board): the first Board to show a run keeps it.
 */
export function jobSearchShownRunPatch(data, { boardId, runId, now = Date.now() } = {}) {
  if (typeof boardId !== 'string' || !boardId || typeof runId !== 'string' || !runId) return null;
  if (data?.jobRunId !== runId || jobSearchShownRun(data)) return null;
  return { boardShownRun: { runId, boardId, shownAt: now } };
}

// A Board may scrape a finished card again only by minting a fresh capability
// bound to its approved snapshot, and only when no durable recovery owns it.
function canMintRescan(data) {
  return !!normalizedJobCareerSnapshotId(data?.careerSnapshotId)
    && !data?.manualAiResume?.runId
    && !data?.terminalFinalizationRecovery;
}

function rescrapeCooldownReason(nextEligibleAt, shown) {
  const when = Number.isFinite(nextEligibleAt) ? new Date(nextEligibleAt).toLocaleString() : null;
  const lead = shown
    ? 'Its last results were already shown on a Job Board, and every selected platform was searched in the last 24 hours.'
    : 'Every selected platform was searched in the last 24 hours.';
  return when ? `${lead} The next search can run after ${when}.` : lead;
}

/**
 * Classify a Job Search generation at the Board boundary.
 *
 * A terminal Search whose jobs no Board has shown yet is immutable input: it
 * is combined, never scraped again, so nothing unseen is replaced. Once a
 * Board has shown it (or it holds nothing to lose) and a platform is past its
 * 24-hour cooldown, it is `rescrape-terminal`: the Board mints a one-shot
 * capability and the new run replaces the saved jobs. Fresh work otherwise is
 * an accepted newly-imported input waiting in `empty` with an unconsumed,
 * persisted import capability.
 * `boardId` names the Board asking; without it a run shown elsewhere reads as
 * reusable (the Search card's own last-line guard has no Board context).
 * Recovery and paused states are left to the Board's exact-plan machinery.
 */
export function classifyJobBoardSourceAdmission(source, { now = Date.now(), boardId = null } = {}) {
  const data = source?.data || {};
  if (source?.type !== 'jobhub') return { kind: 'invalid' };

  if (data.hubState === 'done') {
    // Career data was cleared but the saved jobs were kept: new files are needed
    // before those jobs can be re-scored.
    if (isCareerClearedWithSavedJobs(source)) {
      return {
        kind: 'career-cleared-awaiting-files',
        reason: 'Career data was cleared. Drop new career files on this Job Search to re-score its saved jobs.',
      };
    }
    // A marker, or a current-generation receipt that is still compiling or has
    // failed, means a re-import is in flight; only matching generations count.
    const compilation = careerImportCompilationAdmission(data, {
      generation: data.careerImportGeneration,
    });
    if (compilation.kind === 'paused') {
      return { kind: 'career-import-paused', reason: 'Career compilation is paused. Continue it on the Job Search card before using the Board.' };
    }
    if (compilation.kind === 'compiling') {
      return {
        kind: 'career-import-compiling',
        reason: 'New career files are still being compiled and audited.',
      };
    }
    if (compilation.kind === 'failed') {
      return {
        kind: 'career-import-failed',
        reason: 'Career compilation failed. Retry it on the Job Search card, then re-score its saved jobs from the Board.',
      };
    }
    // Cancelling an unstarted import or resetting its compiler keeps the
    // historical rows, but cannot make those old scores current for this input.
    if (compilation.kind === 'missing' && data.careerImportGeneration
      && !data.careerSnapshotId && careerResumeInputPaths(data).length > 0) {
      return { kind: 'career-import-requires-approval', reason: 'Career files are ready to compile. Choose Compile Career Files on the Job Search card before re-scoring its saved jobs.' };
    }
    const rescore = pendingSavedJobsRescore(data);
    if (rescore) {
      return {
        kind: 'rescore-saved-jobs',
        careerSnapshotId: rescore.careerSnapshotId,
        savedJobCount: savedJobCount(data),
        ...(rescore.scoringOnly === true ? { scoringOnly: true } : {}),
      };
    }
    if (data.savedJobsRescore) {
      return {
        kind: 'career-import-requires-approval',
        reason: 'The new career data no longer matches its approved snapshot. Clear career data and import it again.',
      };
    }
    const outcome = terminalJobSearchOutcome(source);
    const mergeable = !!outcome && isMergeableTerminalJobSearchOutcome(source, outcome);
    const rescannable = canMintRescan(data);
    const availability = rescannable ? jobSearchRescrapeAvailability(data, now) : null;
    // No platform left to pick is not a cooldown: let the Board's own setup
    // checks name it ("Select at least one job platform").
    const platformDue = !!availability
      && (availability.due.length > 0 || availability.sourceIds.length === 0);
    const shown = jobSearchShownRun(data);
    if (mergeable) {
      // Replacing saved jobs nobody has seen would lose them for good: the next
      // scan starts where this one ended. Re-scrape only once they were shown
      // on a Board, or when there is nothing saved to lose.
      const nothingToLose = savedJobCount(data) === 0;
      if ((shown || nothingToLose) && platformDue) {
        return { kind: 'rescrape-terminal', outcome, dueSourceIds: availability.due };
      }
      // Shown on another Board (often one since deleted) and nothing new can
      // be scraped yet: this Board leaves the run out instead of showing the
      // same jobs a second time.
      if (shown && boardId && shown.boardId !== boardId) {
        return {
          kind: 'rescrape-cooldown',
          outcome,
          nextEligibleAt: availability?.nextEligibleAt ?? null,
          reason: rescrapeCooldownReason(availability?.nextEligibleAt, true),
        };
      }
      return { kind: 'reuse-terminal', outcome };
    }
    // Test Mode, collection-only or incomplete results cannot be combined;
    // nothing in them was shown, so the Board may search the card again.
    if (rescannable && platformDue) {
      return { kind: 'rescrape-terminal', outcome: outcome || null, dueSourceIds: availability.due };
    }
    if (rescannable) {
      return {
        kind: 'rescrape-cooldown',
        outcome: outcome || null,
        nextEligibleAt: availability.nextEligibleAt,
        reason: rescrapeCooldownReason(availability.nextEligibleAt, false),
      };
    }
    return {
      kind: 'terminal-requires-fresh-input',
      reason: 'This completed Job Search has no approved career data to search with again. Clear its career data and import the files again, then return to the Board.',
    };
  }

  if (data.hubState === 'empty' && hubHasAcceptedInitialDrop(source)) {
    const compilation = careerImportCompilationAdmission(data, {
      generation: data.careerImportGeneration,
    });
    if (compilation.kind === 'paused') {
      return { kind: 'career-import-paused', reason: 'Career compilation is paused. Continue it on the Job Search card before using the Board.' };
    }
    if (compilation.kind === 'compiling') {
      return {
        kind: 'career-import-compiling',
        reason: 'Career files are still being compiled and audited.',
      };
    }
    if (compilation.kind === 'failed') {
      return {
        kind: 'career-import-failed',
        reason: 'Career compilation failed. Retry the career compilation on the Job Search card before searching.',
      };
    }
    if (!currentApprovedCareerImportSnapshot(data, { generation: data.careerImportGeneration })) {
      return {
        kind: 'career-import-requires-approval',
        reason: 'Career files have not produced a current approved snapshot. Retry compilation on the Job Search card before searching.',
      };
    }
    const freshImportCapability = freshJobCareerImportCapability(data, { nodeId: source.id })
      // Compatibility only: a pre-fix login rejection spent the import before
      // any parser/provider work began.  The capability helper proves that
      // narrow no-work shape before allowing a new Board transaction to claim
      // it; ordinary failed/partial imports remain clear-and-reimport only.
      || retryableUnstartedJobCareerImportCapability(data, { nodeId: source.id })
      || retryableCancelledJobCareerImportCapability(data, { nodeId: source.id });
    if (freshImportCapability) {
      return { kind: 'fresh-imported-input', freshImportCapability };
    }
    return {
      kind: 'fresh-import-requires-clear',
      reason: 'This career input has already been started or recovered. To start a new Job Search, manually clear career data, import fresh files in Job Search, then run the Board.',
    };
  }

  if (data.hubState === 'sources-ready') {
    if (typeof data.jobRunId === 'string' && data.jobRunId) {
      return { kind: 'continue-existing', runId: data.jobRunId };
    }
    return {
      kind: 'continuation-requires-run-token',
      reason: 'This paused Job Search has no recoverable run token. Resolve it from Job Search, or clear career data and import career files again before starting fresh.',
    };
  }

  return { kind: 'intermediate-or-setup' };
}

/**
 * Verify the exact terminal input a Board recorded before it starts Combine.
 * Run id/disposition are not enough: saved job rows can change while retaining
 * both fields, so the terminal merge fingerprint is part of the capability.
 */
export function completedJobSearchOutcomeMatches(source, expected) {
  const actual = terminalJobSearchOutcome(source);
  return jobSearchOutcomeReceiptMatches(actual, expected);
}

/**
 * Compare a live terminal receipt with one persisted by an earlier Board
 * phase.  Early canvases recorded no provenance for positive legacy rows;
 * their normalized live receipt is branded `legacy-scored`, while the saved
 * receipt remains null/null.  Permit only that exact all-legacy bridge.  A
 * partial modern shape must still fail closed.
 */
export function jobSearchOutcomeReceiptMatches(actual, expected) {
  if (!actual || !expected || actual.fingerprint !== expected.fingerprint) return false;
  const isAbsent = value => value === null || value === undefined || value === '';
  const actualRunId = isAbsent(actual.runId) ? null : actual.runId;
  const actualDisposition = isAbsent(actual.resultDisposition) ? null : actual.resultDisposition;
  const expectedRunId = isAbsent(expected.runId) ? null : expected.runId;
  const expectedDisposition = isAbsent(expected.resultDisposition) ? null : expected.resultDisposition;
  const actualLegacyReceipt = actual.legacyPositiveResult === true
    && !actualRunId
    && actualDisposition === 'legacy-scored';
  const expectedLegacyReceipt = isAbsent(expected.runId) && isAbsent(expected.resultDisposition);
  // A persisted entry may omit the brand flag (an interrupted Combine saved
  // by an earlier build): 'legacy-scored' is only ever minted by
  // terminalJobSearchOutcome for a run-less positive result, so the pair
  // (no run id, 'legacy-scored') is the brand.  An explicit false still fails.
  const expectedBrandedLegacyReceipt = expected.legacyPositiveResult !== false
    && !expectedRunId
    && expectedDisposition === 'legacy-scored';
  const actualInvalidModernReceipt = !actualLegacyReceipt
    && (typeof actualRunId !== 'string' || !actualRunId
      || typeof actualDisposition !== 'string' || !actualDisposition);
  const expectedInvalidModernReceipt = !expectedLegacyReceipt
    && !expectedBrandedLegacyReceipt
    && (typeof expectedRunId !== 'string' || !expectedRunId
      || typeof expectedDisposition !== 'string' || !expectedDisposition);
  const actualPartialModernReceipt = !actualLegacyReceipt && (!!actualRunId !== !!actualDisposition);
  const expectedPartialModernReceipt = !expectedLegacyReceipt
    && !expectedBrandedLegacyReceipt
    && (!!expectedRunId !== !!expectedDisposition);
  if (actualInvalidModernReceipt || expectedInvalidModernReceipt
    || actualPartialModernReceipt || expectedPartialModernReceipt) return false;
  if (actualLegacyReceipt && (expectedLegacyReceipt || expectedBrandedLegacyReceipt)) return true;
  return actualRunId === expectedRunId && actualDisposition === expectedDisposition;
}

/**
 * The exact-run entry a Combine records for one terminal input and later
 * re-checks with `jobSearchOutcomeReceiptMatches`.  Every construction site
 * must use this builder: dropping `legacyPositiveResult` turns a legitimate
 * run-less saved result into an "invalid modern receipt" and discards a
 * Combine whose inputs never changed.
 */
export function combineSourceRunEntry(module) {
  return {
    sourceId: module.id,
    runId: module.runId || null,
    resultDisposition: module.resultDisposition || null,
    legacyPositiveResult: module.legacyPositiveResult === true,
    fingerprint: module.fingerprint,
  };
}

/**
 * Old saved Search results predate host-issued operation authority. They can
 * still be combined from the live canvas, but cannot authorize a protected
 * seen-history write. A present receipt is always sent to the host for exact
 * validation; this gate does not treat a malformed receipt as legacy.
 */
export function boardHistoryAuthorityAvailable(modules) {
  return Array.isArray(modules) && modules.length > 0 && modules.every(module => (
    Boolean(module?.runId && module?.careerSnapshotId && module?.operationAuthority)
  ));
}

/**
 * Fixed, redacted reason code for why `jobSearchOutcomeReceiptMatches` rejects
 * a live receipt against a recorded one (null when it matches).  Diagnostic
 * only: it names the receipt SHAPE that failed, never ids or job content.
 */
export function describeReceiptMismatch(actual, expected) {
  if (jobSearchOutcomeReceiptMatches(actual, expected)) return null;
  if (!actual) return 'live-receipt-missing';
  if (!expected) return 'recorded-receipt-missing';
  if (actual.fingerprint !== expected.fingerprint) return 'fingerprint-changed';
  const isAbsent = value => value === null || value === undefined || value === '';
  if (!isAbsent(actual.runId) && !isAbsent(expected.runId) && actual.runId !== expected.runId) {
    return 'run-id-changed';
  }
  if (isAbsent(actual.runId) !== isAbsent(expected.runId)) return 'run-id-presence-changed';
  if (actual.resultDisposition !== expected.resultDisposition) return 'disposition-changed';
  return 'receipt-shape-invalid';
}

/**
 * What the same Board click does after a saved-job re-score (admission
 * `rescore-saved-jobs`): the card is classified as it will read once the
 * re-score commits (marker retired, its manual-AI run closed). `scrape` is
 * true when that card would be `rescrape-terminal`, i.e. a platform is past its
 * cooldown and the run may be searched again; `addsToShown` says whether the
 * new jobs join the ones this Board shows (same rule as
 * jobSearchCarriedResultsMarker) or replace them. A scoring repair never
 * searches. This is a prediction for the Board's label; the Search decides
 * again from the live re-scored card before it scrapes.
 */
export function savedJobsRescoreFollowUp(source, { now = Date.now(), boardId = null } = {}) {
  const data = source?.data || {};
  const shown = !!jobSearchShownRun(data);
  const none = { scrape: false, addsToShown: false, dueSourceIds: [], afterKind: null, shown };
  const rescore = pendingSavedJobsRescore(data);
  if (!rescore || rescore.scoringOnly === true) return none;
  const after = { ...source, data: { ...data, savedJobsRescore: null, manualAiResume: null } };
  const admission = classifyJobBoardSourceAdmission(after, { now, boardId });
  if (admission.kind !== 'rescrape-terminal') return { ...none, afterKind: admission.kind };
  const addsToShown = jobSearchCarriedResultsMarker(after.data, { orchestratorNodeId: boardId }) !== null;
  return { scrape: true, addsToShown, dueSourceIds: admission.dueSourceIds || [], afterKind: admission.kind, shown };
}

/**
 * Split selected sources without dispatching work.  The Board uses this once
 * at click admission so terminal rows are never sent to a Search executor and
 * a paused generation is distinguishable from a fresh imported input.
 */
export function partitionJobBoardSourceAdmissions(sources, options = {}) {
  return (Array.isArray(sources) ? sources : []).reduce((partition, source) => {
    const admission = classifyJobBoardSourceAdmission(source, options);
    const entry = { sourceId: source?.id || null, source, admission };
    if (!entry.sourceId) {
      partition.invalid.push(entry);
    } else if (admission.kind === 'reuse-terminal') {
      partition.reusable.push(entry);
    } else if (admission.kind === 'rescrape-terminal') {
      partition.rescrape.push(entry);
    } else if (admission.kind === 'rescrape-cooldown') {
      partition.cooldown.push(entry);
    } else if (admission.kind === 'fresh-imported-input') {
      partition.fresh.push(entry);
    } else if (admission.kind === 'rescore-saved-jobs') {
      partition.rescore.push(entry);
    } else if (admission.kind === 'continue-existing') {
      partition.continuations.push(entry);
    } else if (admission.kind === 'continuation-requires-run-token'
      || admission.kind === 'career-cleared-awaiting-files'
      || admission.kind === 'fresh-import-requires-clear'
      || admission.kind === 'terminal-requires-fresh-input'
      || admission.kind === 'career-import-paused'
      || admission.kind === 'career-import-compiling'
      || admission.kind === 'career-import-failed'
      || admission.kind === 'career-import-requires-approval') {
      partition.blocked.push(entry);
    } else {
      partition.other.push(entry);
    }
    return partition;
  }, {
    reusable: [], fresh: [], rescrape: [], cooldown: [], rescore: [], continuations: [], blocked: [], other: [], invalid: [],
  });
}
