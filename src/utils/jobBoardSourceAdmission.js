import { hubHasAcceptedInitialDrop } from './hubDropEligibility.js';
import {
  freshJobCareerImportCapability,
  retryableUnstartedJobCareerImportCapability,
} from './jobCareerImportCapability.js';
import {
  careerImportCompilationAdmission,
  currentApprovedCareerImportSnapshot,
} from './jobCareerCompilationReceipt.js';
import {
  isMergeableTerminalJobSearchOutcome,
  terminalJobSearchOutcome,
} from './jobBoardPausedSourceContinuation.js';

/**
 * Classify a Job Search generation at the Board boundary.
 *
 * A terminal Search is immutable input for a Board: it may be combined, but
 * must never be sent back through a fresh scrape.  Fresh work is deliberately
 * narrower: it is only an accepted newly-imported input waiting in `empty`
 * with an unconsumed, persisted import capability.
 * Recovery and paused states are left to the Board's exact-plan machinery.
 */
export function classifyJobBoardSourceAdmission(source) {
  const data = source?.data || {};
  if (source?.type !== 'jobhub') return { kind: 'invalid' };

  if (data.hubState === 'done') {
    const outcome = terminalJobSearchOutcome(source);
    if (outcome && isMergeableTerminalJobSearchOutcome(source, outcome)) {
      return { kind: 'reuse-terminal', outcome };
    }
    return {
      kind: 'terminal-requires-fresh-input',
      reason: outcome
        ? 'This completed Job Search is not mergeable. Re-scan it on the Job Search card, then return to the Board.'
        : 'This completed Job Search cannot be refreshed from the Board. Re-scan it on the Job Search card, then return to the Board.',
    };
  }

  if (data.hubState === 'empty' && hubHasAcceptedInitialDrop(source)) {
    const compilation = careerImportCompilationAdmission(data, {
      generation: data.careerImportGeneration,
    });
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
      || retryableUnstartedJobCareerImportCapability(data, { nodeId: source.id });
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

/** True only for an ordinary terminal Board input, never recovery cleanup. */
export function isReusableTerminalJobBoardSource(source) {
  return classifyJobBoardSourceAdmission(source).kind === 'reuse-terminal';
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
 * Split selected sources without dispatching work.  The Board uses this once
 * at click admission so terminal rows are never sent to a Search executor and
 * a paused generation is distinguishable from a fresh imported input.
 */
export function partitionJobBoardSourceAdmissions(sources) {
  return (Array.isArray(sources) ? sources : []).reduce((partition, source) => {
    const admission = classifyJobBoardSourceAdmission(source);
    const entry = { sourceId: source?.id || null, source, admission };
    if (!entry.sourceId) {
      partition.invalid.push(entry);
    } else if (admission.kind === 'reuse-terminal') {
      partition.reusable.push(entry);
    } else if (admission.kind === 'fresh-imported-input') {
      partition.fresh.push(entry);
    } else if (admission.kind === 'continue-existing') {
      partition.continuations.push(entry);
    } else if (admission.kind === 'continuation-requires-run-token'
      || admission.kind === 'fresh-import-requires-clear'
      || admission.kind === 'terminal-requires-fresh-input'
      || admission.kind === 'career-import-compiling'
      || admission.kind === 'career-import-failed'
      || admission.kind === 'career-import-requires-approval') {
      partition.blocked.push(entry);
    } else {
      partition.other.push(entry);
    }
    return partition;
  }, {
    reusable: [], fresh: [], continuations: [], blocked: [], other: [], invalid: [],
  });
}
