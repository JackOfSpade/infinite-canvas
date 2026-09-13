import { isJobSourceWarningGating } from './jobSourceWarningPolicy.js';
import { moduleCombineFingerprint } from '../nodes/jobboard/mergeJobs.js';

// `awaitingSourceResolution` is more than display state: it is the durable
// proof that a Board owns one *specific* paused Search generation. Once that
// Search has no gating warnings, it must finish its already-collected rows
// rather than being classified as an ordinary not-ready module. A save can land
// while that continuation is scoring; the generic save sanitizer then restores
// the hub as empty/done and removes the renderer-only pending rows. Keep those
// two shapes distinct so callers can inspect the exact staged run without ever
// falling back to a new search.
export function exactPausedSourceContinuation(plan, sourceId, sourceData) {
  const awaiting = plan?.awaitingSourceResolution;
  if (
    plan?.version !== 1
    || plan?.phase !== 'searches'
    || plan?.activeSourceId !== sourceId
    || awaiting?.sourceId !== sourceId
    || typeof awaiting?.jobRunId !== 'string'
    || !awaiting.jobRunId
    || sourceData?.jobRunId !== awaiting.jobRunId
    || sourceData?.manualAiResume?.runId
  ) return null;

  const noGatingWarnings = !(Array.isArray(sourceData.scrapeWarnings)
    ? sourceData.scrapeWarnings
    : []).some(isJobSourceWarningGating);
  if (sourceData.hubState === 'sources-ready' && noGatingWarnings) {
    return { sourceId, jobRunId: awaiting.jobRunId, mode: 'finish-paused-scoring' };
  }
  // Only a nonterminal, sanitizer-restored hub may resume through the staged
  // ledger. A real terminal receipt is consumed by terminalSearchOutcome.
  if (
    (sourceData.hubState === 'empty' || sourceData.hubState === 'done')
    && !sourceData.resultDisposition
  ) {
    return { sourceId, jobRunId: awaiting.jobRunId, mode: 'recover-staged-scoring' };
  }
  return null;
}

// A `done` hub is not automatically a clean Board child: a failed/incomplete
// run can retain its earlier scored rows for inspection.  Keep this receipt
// test shared by fast lane-turn adoption and reload recovery.
export function terminalJobSearchOutcome(source) {
  const sourceData = source?.data || {};
  const runId = sourceData.jobRunId || null;
  const resultDisposition = sourceData.resultDisposition || null;
  const hasRunProvenance = sourceData.jobRunId !== null
    && sourceData.jobRunId !== undefined
    && sourceData.jobRunId !== '';
  const hasDispositionProvenance = sourceData.resultDisposition !== null
    && sourceData.resultDisposition !== undefined
    && sourceData.resultDisposition !== '';
  const scoredCount = Array.isArray(sourceData.scoredJobs) ? sourceData.scoredJobs.length : 0;
  // Older canvases stored completed positive scored rows before run receipts
  // were introduced.  They are valid display inputs, never authoritative
  // empties: preserve and fingerprint them rather than routing a Board click
  // into a replacement scrape just because provenance fields are absent.
  // A partial modern receipt is not legacy data.  Treat it as untrusted rather
  // than silently upgrading it to a reusable terminal result.
  const legacyPositiveResult = scoredCount > 0 && !hasRunProvenance && !hasDispositionProvenance;
  if (
    source?.type !== 'jobhub'
    || sourceData.hubState !== 'done'
    || !!sourceData.errorMessage
    || (!legacyPositiveResult && (typeof runId !== 'string' || !runId))
    || (!legacyPositiveResult && (typeof resultDisposition !== 'string' || !resultDisposition))
    || resultDisposition === 'incomplete'
  ) return null;
  return {
    runId,
    resultDisposition: resultDisposition || 'legacy-scored',
    legacyPositiveResult,
    fingerprint: moduleCombineFingerprint(
      sourceData.scoredJobs,
      sourceData.locationSnapshot?.remoteResidences || sourceData.remoteResidences || {},
    ),
  };
}

// A Search can reach a truthful terminal state without producing hiring-fit
// inputs for a Board: Test Mode / collection-only deliberately records the
// gathered listings but skips scoring. Keep that distinct from a scored empty
// (or preference-filtered empty) result. The former must leave an existing
// Board untouched and ask for attention; the latter is a valid zero-result
// replacement input.
export function isMergeableTerminalJobSearchOutcome(source, outcome = terminalJobSearchOutcome(source)) {
  if (!outcome) return false;
  const sourceData = source?.data || {};
  if (
    sourceData.aiSkipped
    || sourceData.collectionOnly
    || sourceData.testMode
    || outcome.resultDisposition === 'collection-only'
  ) return false;
  const scoredCount = Array.isArray(sourceData.scoredJobs) ? sourceData.scoredJobs.length : 0;
  return scoredCount > 0
    || outcome.resultDisposition === 'empty-complete'
    || outcome.resultDisposition === 'preference-filtered';
}

// A Board can queue behind the source-card's continuation.  By the time it
// receives the shared-lane turn, React may already have published the Search's
// terminal receipt.  This is deliberately a separate decision from
// `exactPausedSourceContinuation`: a terminal source must be *adopted*, never
// sent through the generic saved-run recovery path (which could start a fresh
// provider run).  Keep the parent plan, live plan, Board run, source id and
// Search generation all exact so an older continuation cannot certify a newer
// result from the same card.
export function exactPausedSourceTerminalOutcome({
  boardRunId,
  resumePlan,
  livePlan,
  sourceId,
  source,
}) {
  const expectedRunId = (
    resumePlan?.boardRunId === boardRunId
    && resumePlan.activeSourceId === sourceId
    && resumePlan.awaitingSourceResolution?.sourceId === sourceId
    && typeof resumePlan.awaitingSourceResolution.jobRunId === 'string'
    && resumePlan.awaitingSourceResolution.jobRunId
    && livePlan?.boardRunId === boardRunId
    && livePlan.activeSourceId === sourceId
    && livePlan.awaitingSourceResolution?.sourceId === sourceId
    && livePlan.awaitingSourceResolution.jobRunId
      === resumePlan.awaitingSourceResolution.jobRunId
  ) ? resumePlan.awaitingSourceResolution.jobRunId : null;
  if (!expectedRunId) return { status: 'not-awaiting' };

  const sourceData = source?.data || {};
  // A terminal manual-AI marker still owns a required cleanup transaction.
  // The registered Search executor, rather than the Board's fast adoption
  // path, must retire that marker first.
  if (sourceData.manualAiResume?.runId) {
    return { status: 'manual-ai-pending', expectedRunId };
  }
  const runId = sourceData.jobRunId || null;
  const terminal = terminalJobSearchOutcome(source);
  if (terminal?.runId === expectedRunId) {
    return { status: 'adopted', expectedRunId, outcome: terminal };
  }
  if (runId !== expectedRunId) {
    return { status: 'generation-changed', expectedRunId };
  }
  return { status: 'pending', expectedRunId };
}

/**
 * Classify the exact terminal handoff at the Board boundary.  Keeping the
 * mergeability decision beside the token check prevents a Board recovery from
 * treating a terminal source-card result as a new runnable Search merely
 * because its renderer state changed between the Solve/Skip action and the
 * Board's next lane turn.
 */
export function resolveExactPausedJobBoardTerminal(options) {
  const terminal = exactPausedSourceTerminalOutcome(options);
  if (terminal.status !== 'adopted') return terminal;
  return {
    ...terminal,
    mergeable: isMergeableTerminalJobSearchOutcome(options?.source, terminal.outcome),
  };
}
