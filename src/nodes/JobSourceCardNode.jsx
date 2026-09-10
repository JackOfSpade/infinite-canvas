import React, { useCallback, useEffect, useState, useContext, useRef } from 'react';
import { useReactFlow, useStore } from '@xyflow/react';
import { Loader2, CheckCircle2, ShieldAlert, ExternalLink, SkipForward } from 'lucide-react';
import { PlatformBadge } from '../components/PlatformBadge';
import { NodeHandles } from './_shared/NodeHandles';
import { SourceWarningPanel } from './_shared/SourceWarningPanel';
import { createSourceProgressRunGuard, mergeSourceProgress, isTerminalSourceStatus } from '../utils/sourceProgress';
import { canAttemptJobSourceResolve, isJobSourceResolveBusyHubState, isJobSourceWarningGating, jobSourceWarningAction } from '../utils/jobSourceWarningPolicy';
import { CanvasNavigationContext } from '../contexts/CanvasNavigationContext';
import { useModuleRunQueue } from '../contexts/useModuleRunQueue';
import { normalizeJobCollectionLimits } from '../utils/jobCollectionLimits';
import { openExternalFailureMessage, openExternalUrl } from '../utils/openExternal';
import { EventLogger } from '../utils/EventLogger';
import { useToast } from '../components/ToastProvider';
import { isSolveIpcCancellation, isSolveIpcFailure, solveIpcFailureMessage, warningForSolveIpcFailure } from '../utils/solveIpcFailure';
import { findJobSearchBoardActiveRecoveryOwner } from '../utils/jobBoardSearchSelection';
import { isJobWorkflowDeletionPending } from '../utils/nodeDeletionLifecycle';

function hasBlockingJobSearchCleanup(data) {
  return data?.manualAiResume?.retirementPending === true
    || (Array.isArray(data?.manualAiCleanupReceipts)
      && data.manualAiCleanupReceipts.some(receipt => receipt?.cancellationPending === true));
}

function restoredSourceProgressState(persistedProgress, retiredJobRunId = null, rejectUnknownGeneration = false) {
  const restored = persistedProgress && typeof persistedProgress === 'object'
    ? persistedProgress
    : null;
  const restoredRunId = restored?.jobRunId || null;
  const abandonedRunId = retiredJobRunId || null;

  // A saved-scrape recovery can reuse the original search run token. In that
  // case retiring the "abandoned" id would also retire the valid restored
  // warning generation. Different ids can be fenced normally.
  const guard = createSourceProgressRunGuard(
    abandonedRunId && abandonedRunId !== restoredRunId ? abandonedRunId : restoredRunId,
  );
  if (abandonedRunId && abandonedRunId !== restoredRunId) {
    guard.retireActive();
    if (restoredRunId) guard.accepts(restoredRunId);
  }
  return {
    guard,
    progress: restored,
    // If an interrupted saved-scrape continuation reused the prior run token,
    // the backend's late events are indistinguishable by id from the restored
    // warning. Keep displaying the restored value, but reject progress until a
    // deliberate new-run reset or the user explicitly resumes this source.
    rejectUntilReset: rejectUnknownGeneration && (
      (!restoredRunId && !abandonedRunId)
      || (!!restoredRunId && restoredRunId === abandonedRunId)
    ),
  };
}

function terminalProgressIsCommitted(node, expected) {
  if (!node) return true;
  if (!expected || !isTerminalSourceStatus(expected.status)) return true;
  const persisted = node.data?.persistedProgress;
  return !!persisted
    && persisted.status === expected.status
    && persisted.count === expected.count
    && (persisted.jobRunId || null) === (expected.jobRunId || null)
    && JSON.stringify(persisted.warning || null) === JSON.stringify(expected.warning || null)
    && (persisted.url || null) === (expected.url || null);
}

async function waitForTerminalProgressCommit(getNode, nodeId, expected) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (terminalProgressIsCommitted(getNode(nodeId), expected)) return true;
    await new Promise((resolve) => {
      let timer = null;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer != null) clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(finish, 25);
      globalThis.requestAnimationFrame?.(finish);
    });
  }
  return terminalProgressIsCommitted(getNode(nodeId), expected);
}

/**
 * JobSourceCardNode — persistent canvas node representing one job source
 * (LinkedIn, Indeed, Greenhouse, etc.) that a JobSearchNode searches against.
 *
 * Replaces the orbital ring of source icons. Each card is a real ReactFlow
 * node connected to its hub by a native edge, leaving room for per-platform
 * features to grow on each card later (login state, custom filters, etc.).
 *
 * Lifecycle:
 *   - Spawned by the owning JobSearchNode the first time its pipeline runs.
 *   - Reused across re-runs — the hub looks up existing cards by hubId+sourceId
 *     before deciding what to spawn.
 *   - Subscribes to `job-source-progress` events filtered by its sourceId.
 *   - Falls back to the hub's `data.finalSourceCounts` between runs so the
 *     last-known count is still visible after Electron restart.
 *
 * data shape:
 *   {
 *     sourceId, name, letter, color,  // JOB_SOURCES entry
 *     hubId,                          // owning JobSearchNode id (multi-hub safety)
 *   }
 */
export const JobSourceCardNode = React.memo(function JobSourceCardNode({ id, data }) {
  const { getNode, getNodes, getEdges, deleteElements, updateNodeData } = useReactFlow();
  const { addToast } = useToast();
  // Same nav context the owning Job Search Module reads currentFile from — needed so a
  // captcha-resolve can history-dedup against this project's jobs-history CSV
  // (mirrors the headless search path), instead of re-surfacing already-seen
  // jobs every time the user re-solves a source.
  const nav = useContext(CanvasNavigationContext);
  // The provider republishes its context value when the queue snapshot changes
  // so consumers showing positions can re-render. Take the queue operations
  // themselves (which are stable for the provider lifetime), rather than
  // depending on that changing wrapper object in lifecycle effects.
  const { acquireModuleRun, cancelQueuedRunsForNode } = useModuleRunQueue();
  const [progress, setProgressState] = useState(data.persistedProgress || null); // { status, count, warning, url } | null
  const progressRef = useRef(data.persistedProgress || null);
  // Terminal source state is part of the graph snapshot a waiting Job Board
  // captures as soon as this action releases the global lane. Persist it in
  // the same call that changes local UI state; a passive effect runs too late
  // and can pair a newly-clean hub with the card's previous warning.
  const setProgress = useCallback((nextOrUpdater, { persistTerminal = true } = {}) => {
    const previous = progressRef.current;
    const next = typeof nextOrUpdater === 'function'
      ? nextOrUpdater(previous)
      : nextOrUpdater;
    progressRef.current = next;
    setProgressState(next);
    if (persistTerminal && next !== previous && next && isTerminalSourceStatus(next.status)) {
      const existing = getNode(id)?.data?.persistedProgress;
      updateNodeData(id, {
        persistedProgress: {
          ...next,
          doneAt: existing?.doneAt ?? Date.now(),
        },
      });
    }
    return next;
  }, [getNode, id, updateNodeData]);
  const [resolving, setResolving] = useState(false);
  // External listing opens do not use the long-running Solve state, but still
  // need a synchronous latch so a double-click cannot launch two OS tabs.
  const externalOpenInFlightRef = useRef(false);
  // `setResolving(true)` does not update this closure until React renders, so a
  // quick double-click could otherwise open two native Chrome verification
  // windows. Keep a synchronous latch for the actual IPC lifetime.
  const resolveInFlightRef = useRef(false);
  // `resolveInFlightRef` is set before acquiring the lane so the source card
  // can cancel its *queued* work when removed. Only this flag says the card
  // owns the hub-scoped IPC task; a queued sibling must never abort whichever
  // source currently owns the same hub id.
  const resolveStartedRef = useRef(false);
  // The resolver IPC is intentionally hub-scoped so recovered rows merge into
  // the right paused run. Its UI lifetime is narrower: deleting this source
  // card must prevent a queued/late resolver from opening a browser or
  // dispatching rows into the hub after the card is gone.
  const resolveLifecycleRef = useRef(0);
  const initialRollbackReceipt = data._boardRollbackProgressRestore;
  const initialProgressState = restoredSourceProgressState(
    data.persistedProgress,
    initialRollbackReceipt?.retiredJobRunId,
    !!initialRollbackReceipt?.nonce,
  );
  // The receipt can remain on node data until the next reset/explicit Solve.
  // Apply each nonce only once; terminal progress persistence creates a new
  // object and would otherwise bounce receipt -> local state -> node data in a
  // render loop even though the semantic progress did not change.
  const appliedRollbackReceiptNonceRef = useRef(initialRollbackReceipt?.nonce || null);
  const progressRunGuardRef = useRef(initialProgressState.guard);
  // If rollback happened before the backend revealed the abandoned jobRunId,
  // reject all progress until the next explicit fresh-run reset. Otherwise the
  // first late token would be mistaken for the restored generation.
  const rejectProgressUntilResetRef = useRef(initialProgressState.rejectUntilReset);
  // Local-only dismiss: clicking Skip on a warned card just hides the
  // Solve/Skip + warning text on this card. Doesn't touch hub state — the
  // next Re-run Search will refetch this source fresh and re-emit progress.
  const [dismissed, setDismissed] = useState(false);

  const applyProgressRestore = useCallback((persistedProgress, retiredJobRunId = null, rejectUnknown = false) => {
    const restoredState = restoredSourceProgressState(
      persistedProgress,
      retiredJobRunId,
      rejectUnknown,
    );
    progressRunGuardRef.current = restoredState.guard;
    rejectProgressUntilResetRef.current = restoredState.rejectUntilReset;
    // Rollback must reproduce the snapshot byte-for-byte. In particular,
    // legacy terminal receipts may not have doneAt; stamping one here would
    // make the coordinator's exact rollback acknowledgment time out.
    setProgress(restoredState.progress, { persistTerminal: false });
    setDismissed(false);
  }, [setProgress]);

  useEffect(() => () => {
    resolveLifecycleRef.current += 1;
    if (!resolveInFlightRef.current) return;
    // The queue entry is scheduled under the hub (the backend ownership), with
    // this card registered as a cancellation alias. Cancel the queue first so
    // an unstarted resolver cannot begin after this component disappears.
    cancelQueuedRunsForNode(id, 'Job source card removed');
    // An already-started resolver has no card-specific main-process task id:
    // it deliberately uses hubId so its recovered rows retain hub ownership.
    // Do not cancel by hub id until this card has acquired the lane. Multiple
    // warning cards from one paused hub can queue independently; deleting a
    // queued card must leave its active sibling's hub-scoped browser/request
    // untouched.
    if (resolveStartedRef.current) {
      window.electronAPI?.cancelNodeTask?.(data.hubId, 'job-source-card-removed');
    }
    resolveInFlightRef.current = false;
    resolveStartedRef.current = false;
  }, [cancelQueuedRunsForNode, data.hubId, id]);

  useEffect(() => {
    if (!window.electronAPI?.onJobSourceProgress) return;
    const cleanup = window.electronAPI.onJobSourceProgress((payload) => {
      if (payload?.nodeId && payload.nodeId !== data.hubId) return;
      if (payload?.sourceId !== data.sourceId) return;
      if (rejectProgressUntilResetRef.current) return;
      if (!progressRunGuardRef.current.accepts(payload?.jobRunId)) return;
      // Carry warning + url forward across events — see mergeSourceProgress.
      // Reset the local dismiss flag on every fresh event so a new run
      // un-hides any previously-dismissed warning.
      setProgress(prev => mergeSourceProgress(prev, payload));
      setDismissed(false);
    });
    return () => cleanup?.();
  }, [data.hubId, data.sourceId, setProgress]);

  // Fresh-run reset. The owning hub broadcasts this the moment it (re)starts a
  // scrape. This card holds its count in LOCAL state (seeded from
  // persistedProgress) and a re-run deliberately KEEPS the card on canvas, so the
  // hub's own progress-hook reset never reaches it — without this the card would
  // paint the PREVIOUS run's "{N} jobs" all the way through the new search phase
  // until this source's own first fresh event lands. Clearing to null makes the
  // card derive "Searching…" immediately; the new run re-emits real progress.
  useEffect(() => {
    const onReset = (event) => {
      if (event.detail?.hubId !== data.hubId) return;
      rejectProgressUntilResetRef.current = false;
      appliedRollbackReceiptNonceRef.current = null;
      progressRunGuardRef.current.retireActive();
      updateNodeData(id, { _boardRollbackProgressRestore: null });
      setProgress(null);
      setDismissed(false);
    };
    document.addEventListener('job-source-progress-reset', onReset);
    return () => document.removeEventListener('job-source-progress-reset', onReset);
  }, [data.hubId, id, setProgress, updateNodeData]);

  // An exact Job Board child rollback replaces this node's persisted graph
  // payload, but React keeps the component mounted when its id is unchanged.
  // Restore the local progress and run-generation guard explicitly so a warning
  // from the abandoned run cannot survive, and a pre-run warning is not rejected
  // merely because the normal fresh-run reset retired its token.
  useEffect(() => {
    const onRestore = (event) => {
      const detail = event.detail || {};
      if (detail.hubId !== data.hubId || detail.sourceId !== data.sourceId) return;
      const abandonedRunId = detail.retiredJobRunId || progressRunGuardRef.current.active();
      applyProgressRestore(detail.persistedProgress, abandonedRunId, true);
    };
    document.addEventListener('job-source-progress-restore', onRestore);
    return () => document.removeEventListener('job-source-progress-restore', onRestore);
  }, [applyProgressRestore, data.hubId, data.sourceId]);

  // A restored card that was absent at dispatch time cannot receive the event
  // above. The transient node-data receipt provides the same fence after mount
  // and also updates an already-mounted same-id component through props.
  useEffect(() => {
    const receipt = data._boardRollbackProgressRestore;
    if (!receipt?.nonce) return;
    if (appliedRollbackReceiptNonceRef.current === receipt.nonce) return;
    appliedRollbackReceiptNonceRef.current = receipt.nonce;
    applyProgressRestore(data.persistedProgress, receipt.retiredJobRunId, true);
  }, [applyProgressRestore, data._boardRollbackProgressRestore, data.persistedProgress]);

  // Some gating warnings are derived only after the complete, history-filtered
  // result set is known (notably Indeed's residual description check). The
  // source's last IPC progress event can therefore be a clean `done`; let the
  // hub promote that existing card to the derived actionable warning without
  // deleting/re-spawning it and losing its position.
  useEffect(() => {
    const onWarningSync = (event) => {
      if (event.detail?.hubId !== data.hubId || event.detail?.sourceId !== data.sourceId) return;
      const nextWarning = event.detail?.warning;
      if (!nextWarning) return;
      if (rejectProgressUntilResetRef.current) return;
      const jobRunId = event.detail?.jobRunId || progressRunGuardRef.current.active();
      if (!progressRunGuardRef.current.accepts(jobRunId)) return;
      setDismissed(false);
      setProgress(prev => ({
        ...(prev || {}),
        // A derived gate can arrive after the source's last normal progress
        // event said `done`. It is not a successful completion from the
        // person's perspective: the card still needs a decision. Preserve
        // that truth in the card and persisted diagnostics instead of showing
        // the contradictory "done (scrape-failed)" state.
        status: isJobSourceWarningGating(nextWarning) ? 'error' : 'done',
        count: nextWarning.sourceJobCount ?? prev?.count ?? 0,
        url: nextWarning.url || prev?.url || null,
        jobRunId,
        warning: nextWarning,
      }));
    };
    document.addEventListener('job-source-warning-sync', onWarningSync);
    return () => document.removeEventListener('job-source-warning-sync', onWarningSync);
  }, [data.hubId, data.sourceId, setProgress]);

  // "Score current results" on the owning hub means the user chose to proceed
  // without resolving the remaining blocks. The hub empties its own warning
  // list, but this card's warning is card-local, so without this the blocked
  // card survives with a live Solve button whose recovered rows arrive at a hub
  // that has already finished scoring. Settle exactly like the Skip button so
  // the hub's clean-card dismissal can remove it.
  useEffect(() => {
    const onClearWarnings = (event) => {
      if (event.detail?.hubId !== data.hubId) return;
      setDismissed(true);
      setProgress(prev => (prev?.warning ? {
        ...prev,
        status: isJobSourceWarningGating(prev.warning)
          ? 'skipped'
          : (prev.status === 'done' || prev.status === 'skipped'
            ? prev.status
            : ((prev.count || 0) > 0 ? 'done' : 'skipped')),
        warning: null,
      } : prev));
    };
    document.addEventListener('job-source-clear-warnings', onClearWarnings);
    return () => document.removeEventListener('job-source-clear-warnings', onClearWarnings);
  }, [data.hubId, setProgress]);

  // The owning Job Search Module coordinates clean-card dismissal after ALL source cards
  // have reported terminal progress. That keeps the source counts visible as a
  // set, while blocked/errored/manual-action cards still remain actionable.
  useEffect(() => {
    const onDismiss = (event) => {
      if (event.detail?.hubId !== data.hubId) return;
      const isCleanTerminal = (progress?.status === 'done' || progress?.status === 'skipped') && !progress.warning;
      if (!isCleanTerminal) return;
      deleteElements({ nodes: [{ id }] });
    };
    document.addEventListener('job-source-dismiss-clean', onDismiss);
    return () => document.removeEventListener('job-source-dismiss-clean', onDismiss);
  }, [data.hubId, progress?.status, progress?.warning, id, deleteElements]);

  const handleSolve = async () => {
    const warningAction = progress?.warning?.action;
    const resumeState = progress?.warning?.resumeState;
    // "Open listing" is intentionally not a source resolve. A ZipRecruiter
    // job-detail URL has no ItemList for the generic resolver to extract, and
    // treating it as a captcha solve used to close a perfectly good detail
    // page with a misleading zero-result/site-changed diagnostic.
    if (hubLocked || hubCleanupBlocked || isJobWorkflowDeletionPending(data.hubId)) return;
    if (warningAction === 'open-external') {
      if (resolving || externalOpenInFlightRef.current) return;
      externalOpenInFlightRef.current = true;
      try {
        const opened = await openExternalUrl(progress?.url, {
          dispatcher: window.electronAPI?.openExternal,
          fallback: window.open,
        });
        if (!opened.ok) {
          addToast({
            title: 'Cannot Open Listing',
            description: openExternalFailureMessage(opened),
            type: 'error',
            dedupeKey: `job-source-open-external:${id}`,
          });
        }
      } finally {
        externalOpenInFlightRef.current = false;
      }
      return;
    }
    // Do not let a source-card action race the owning hub's current search or
    // its pre-score recovery snapshot write. The button can be stale for one
    // render, so this guard is deliberately independent of its disabled state.
    if (resolving || resolveInFlightRef.current || hubBusy) return;
    if (findJobSearchBoardActiveRecoveryOwner(data.hubId, getNodes(), getEdges())) {
      addToast({
        title: 'Job Board Recovery in Progress',
        description: 'Finish or cancel the interrupted Job Board run before resolving this source.',
        type: 'info',
      });
      return;
    }
    if (!resumeState && (!progress?.url || !window.electronAPI?.resolveJobSource)) return;
    resolveInFlightRef.current = true;
    resolveStartedRef.current = false;
    const resolveLifecycle = resolveLifecycleRef.current;
    const resolverAlive = () => resolveLifecycleRef.current === resolveLifecycle;
    setResolving(true);
    // Optimistically clear the red error/warning so the card reads as "working"
    // the instant Solve is clicked — not after the (now multi-minute) resolve
    // returns. Every backend outcome re-emits a terminal event (done / error /
    // searching) via onJobSourceProgress, so the correct final state always
    // lands; this just bridges the gap until the first event arrives. Snapshot
    // the prior state so a solve that returns resolved:false WITHOUT emitting a
    // fresh event (some captcha sources) can be restored to its actionable red.
    const prevForRestore = progress;
    setProgress(prev => prev ? { ...prev, status: 'searching', warning: null, detail: 'Solving…' } : prev);
    const requestedHubData = getNode(data.hubId)?.data || {};
    // The source's event token wins: a hub can start a newer run while a
    // retained warning card still paints, and a Solve must stay scoped to the
    // run that created that warning.
    const jobRunId = progress?.jobRunId || requestedHubData.jobRunId || null;
    const capturedRunIsCurrent = () => {
      const hub = getNode(data.hubId);
      return !!hub && (hub.data?.jobRunId || null) === (jobRunId || null);
    };
    let lease = null;
    let resolveQueueCancelled = false;
    try {
      lease = await acquireModuleRun({
        nodeId: data.hubId,
        cancellationNodeIds: [id],
        kind: 'job-source-resolve',
        // Resolve work can open the same manual-AI handoff as a full search.
        // It must wait behind every other job workflow, not just this hub.
        lane: 'job-search',
        label: `Resolve ${data.name || data.sourceId}`,
        onQueued: ({ position }) => {
          setProgress(prev => prev ? { ...prev, status: 'searching', detail: `Waiting to resolve (${position})…` } : prev);
        },
        onCancel: () => {
          resolveQueueCancelled = true;
        },
      });
      if (!resolverAlive()) return;
      resolveStartedRef.current = true;
      // A queued resolve can outlive its source warning. Re-read both ownership
      // dimensions after the app-wide lease starts so it never targets a newer
      // run or a hub that has resumed normal gathering/scoring.
      const hubNode = getNode(data.hubId);
      const hubData = hubNode?.data || {};
      if (!hubNode || isJobWorkflowDeletionPending(data.hubId) || hubData.locked
        || hasBlockingJobSearchCleanup(hubData)
        // A persisted pre-token hub has no `jobRunId` property (`undefined`),
        // while a source card deliberately normalizes that absence to `null`.
        // Treat those two legacy representations as the same generation; a
        // pair of actual, differing tokens still fences a queued Solve.
        || (hubData.jobRunId || null) !== (jobRunId || null)
        || findJobSearchBoardActiveRecoveryOwner(data.hubId, getNodes(), getEdges())
        || isJobSourceResolveBusyHubState(hubData.hubState)) {
        setProgress(prev => (
          (prev?.jobRunId || null) === (jobRunId || null) && !isTerminalSourceStatus(prev.status)
            ? prevForRestore
            : prev
        ));
        return;
      }
      // An exact Board rollback may have fenced late progress from an abandoned
      // continuation that reused this warning's run id. Reaching this point is
      // an explicit user-approved resume against the same live hub generation,
      // so it is the safe boundary at which to reopen progress for that token.
      rejectProgressUntilResetRef.current = false;
      appliedRollbackReceiptNonceRef.current = null;
      updateNodeData(id, { _boardRollbackProgressRestore: null });
      // Mirror the optimistic clear on the owning hub only after this action
      // owns the shared lane and its live Board/run guard has passed. Doing it
      // at click time let a Board reserve the Search while Solve waited, after
      // which the guarded early return restored the card but permanently
      // removed this warning from the Board's rollback baseline.
      document.dispatchEvent(new CustomEvent('job-source-retry-start', {
        detail: { hubId: data.hubId, sourceId: data.sourceId },
      }));
      let result;
      const collectionLimits = normalizeJobCollectionLimits(hubData.collectionLimits);
      if (resumeState) {
        result = await window.electronAPI.resumeJobSource?.({
          sourceId: data.sourceId,
          nodeId: data.hubId,
          canvasFilePath: nav?.currentFile || null,
          maxAgeDays: getNode(data.hubId)?.data?.maxAgeDays || 21,
          collectionLimits,
          enabledSourceIds: hubData.enabledSourceIds,
          jobRunId,
          preferredLocation: getNode(data.hubId)?.data?.canonicalLocation || '',
          // Rows recovered by a native-challenge resume go through the same
          // pinned-role title gate as the main search (jobTitleMatch.js), or a
          // solved source would be the one way off-role jobs reach the board.
          targetRole: (
            hubData.pendingTargetRole
            ?? hubData.activeTargetRole
            ?? hubData.targetRole
            ?? ''
          ).trim(),
          resumeState,
        });
      } else {
        result = await window.electronAPI.resolveJobSource({
          url: progress.url,
          sourceId: data.sourceId,
          nodeId: data.hubId,
          canvasFilePath: nav?.currentFile || null,
          maxAgeDays: getNode(data.hubId)?.data?.maxAgeDays || 21,
          collectionLimits,
          enabledSourceIds: hubData.enabledSourceIds,
          jobRunId,
          secondTabUrl: progress?.warning?.openSecondTab ? progress.url : null,
          // Same gate as the main search — a captcha Solve re-extracts rows
          // in-page, so without this the solved source could ship off-role jobs.
          targetRole: (
            hubData.pendingTargetRole
            ?? hubData.activeTargetRole
            ?? hubData.targetRole
            ?? ''
          ).trim(),
        });
      }
      // handleSafe resolves failures as { success:false, error }, so they do
      // not reach the catch below unless we explicitly convert the envelope.
      // Keep the raw diagnostic in EventLogger; card data gets only concise,
      // actionable copy so a Puppeteer stderr blob is never persisted.
      if (!resolverAlive() || !capturedRunIsCurrent()) return;
      if (isJobWorkflowDeletionPending(data.hubId)) {
        // A delete confirmation is still reversible. Keep the original source
        // warning actionable instead of publishing a completed Solve into a
        // hub whose deletion transaction has not committed.
        setProgress(prev => (
          (prev?.jobRunId || null) === (jobRunId || null)
            ? prevForRestore
            : prev
        ));
        if (prevForRestore?.warning) {
          document.dispatchEvent(new CustomEvent('job-source-resolve-failed', {
            detail: {
              hubId: data.hubId,
              sourceId: data.sourceId,
              warning: prevForRestore.warning,
              resolved: false,
              restorative: true,
              jobRunId,
            },
          }));
        }
        return;
      }
      if (isSolveIpcFailure(result)) {
        const message = solveIpcFailureMessage(result);
        const error = new Error(message);
        if (isSolveIpcCancellation(result)) error.name = 'AbortError';
        else EventLogger.error(`[JobSource][${data.hubId}/${data.sourceId}] Solve IPC failed:`, result?.error || message);
        error.solveIpcResult = result;
        throw error;
      }
      // When the captcha-resolve window auto-detects the challenge as
      // cleared, the visible browser session that just bypassed the bot
      // wall also runs the extractor in-page — so any jobs the user
      // unlocked come back here as `items`. Hand them to the hub so they
      // merge into pendingJobs and the warning drops in one shot. Without
      // the inline items, the original headless scrape's 0-job result
      // from this source would persist even after a successful solve.
      const continuationPromises = [];
      if (result?.resolved) {
        const items = Array.isArray(result?.items) ? result.items : [];
        const resolvedCount = items.length;
        // A native source resume can collect many raw rows while only a subset
        // survives its title/evidence gates. Prefer its explicit raw collection
        // total for the funnel, while preserving `resolvedCount` for the
        // score-ready queue merge below. Older resolve handlers only return
        // score-ready rows, so retain that backwards-compatible fallback.
        const explicitGatheredCount = result?.gatheredCount;
        const sourceGatheredCount = explicitGatheredCount != null && Number.isFinite(Number(explicitGatheredCount))
          ? Math.max(0, Math.floor(Number(explicitGatheredCount)))
          : resolvedCount;
        const replaceSourceItems = !!result.replaceSourceItems;
        const replaceMatchingItems = !!result.replaceMatchingItems;
        const removedItemKeys = Array.isArray(result.removedItemKeys) ? result.removedItemKeys : [];
        const nextBlockedWarning = result.nextBlockedUrl ? {
          code: 'http-403',
          severity: 'block',
          evidence: 'An additional search query for this source was also blocked.',
          suggestion: 'Click Solve again to retrieve jobs from the next search query for this source.',
        } : null;
        // `gatheredCount` describes listings newly collected from a source, not
        // the card's changing description-ready/pending subset. A replacement
        // Solve re-enriches or replaces rows already counted by the initial
        // search, while an incremental recovery really did collect these rows.
        const gatheredCountDelta = (replaceSourceItems || replaceMatchingItems)
          ? 0
          : sourceGatheredCount;
        const nextCount = (prev) => {
          const priorCount = Number.isFinite(prev?.count) && prev.count >= 0
            ? prev.count
            : null;
          // The backend may emit its terminal progress event before this IPC
          // promise settles. That event carries this pass's count, not the
          // card's pre-resume total; always prefer the count captured at click
          // time so 307 existing + 90 resumed becomes 397, never 90 + 90.
          const preResolveCount = Number.isFinite(prevForRestore?.count) && prevForRestore.count >= 0
            ? prevForRestore.count
            : null;
          const baseCount = preResolveCount ?? priorCount;
          // A replacement/re-enrichment Solve improves already-collected rows.
          // Keep the card's collection count stable; its score-ready response
          // count is not a new source collection total.
          if (replaceSourceItems || replaceMatchingItems) {
            return baseCount ?? resolvedCount;
          }
          return (baseCount ?? 0) + sourceGatheredCount;
        };
        document.dispatchEvent(new CustomEvent('job-source-resolved', {
          // Carry the resolve's own warning (if any) so the hub can re-derive
          // its ScrapeWarningsPanel: clear it on a clean success, or re-show it
          // when the source comes back still-warned (LinkedIn re-walled / same
          // warm IP). Captcha/resume paths don't return a warning → stays null.
          detail: {
            hubId: data.hubId, sourceId: data.sourceId, items, replaceSourceItems, replaceMatchingItems, removedItemKeys,
            gatheredCountDelta,
            resolved: true,
            warning: result.warning || nextBlockedWarning,
            jobRunId,
            // The owning Search may need to continue directly into scoring.
            // It appends that promise synchronously during dispatch so this
            // source keeps the global lane until the whole paused workflow is
            // terminal, ahead of Boards already waiting behind this Solve.
            continuationPromises,
          },
        }));
        if (result.nextBlockedUrl) {
          // Another query for this source was also blocked. Keep the card visible
          // and re-arm it with the next URL so the user can solve in sequence
          // without re-running the full search.
          setProgress(prev => {
            const next = prev ? {
              ...prev,
              status: 'error',
              url: result.nextBlockedUrl,
              count: nextCount(prev),
              warning: nextBlockedWarning,
            } : prev;
            return next;
          });
        } else if (result.warning) {
          // Partial success that's still flagged (e.g. LinkedIn rate-limit: got
          // some descriptions but hit the guest IP ceiling). Keep the returned
          // warning + action button so the user can retry later, rather than
          // clearing to a clean done. LinkedIn replacement responses show the
          // replacement size; incremental captcha/Continue responses add.
          setProgress(prev => {
            const next = prev ? {
              ...prev,
              status: 'error',
              url: result.warning?.url || prev.url,
              warning: result.warning,
              count: nextCount(prev),
            } : prev;
            return next;
          });
        } else {
          setDismissed(true);
          // Clear the warning AND update the card's local
          // progress state so the status line flips from "captcha-presented"
          // back to "{count} jobs" with the green checkmark. Without this,
          // dismissed only hides the inline warning panel — the small status
          // line still reads the warning code, making it look like the
          // resolve didn't take effect even though it fully did.
          // The owning hub will dismiss clean source cards together after the
          // all-sources terminal grace period.
          setProgress(prev => {
            const next = prev ? {
              ...prev,
              status: 'done', // flip off 'error' so it reads "{count} jobs" not "Failed", and auto-dismisses as clean-done
              warning: null,
              count: nextCount(prev),
            } : prev;
            return next;
          });
        }
      } else {
        const rawRestoreWarning = result?.warning || prevForRestore?.warning || null;
        const restoreWarning = rawRestoreWarning ? {
          ...rawRestoreWarning,
          // Native verification failures are common for this path; keep the
          // existing action-label copy so the card explains exactly why the
          // solve was not confirmed.
          ...((resumeState?.mode === 'native-challenge' && !rawRestoreWarning.shortLabel)
            ? { shortLabel: 'Verification not confirmed' }
            : {}),
          ...((resumeState?.mode === 'native-challenge' && !rawRestoreWarning.actionLabel)
            ? { actionLabel: 'Retry verification' }
            : {}),
          resumeState: rawRestoreWarning.resumeState || resumeState || prevForRestore?.warning?.resumeState,
        } : null;

        if (rawRestoreWarning) {
          // A backend failure leaves no inline job items but should still emit a
          // source-level resolve event so JobSearchNode can re-sync its blocking
          // warning list after onRetryStart's optimistic trim.
          setProgress(prev => {
            // Yield only to a newer TERMINAL backend event. The old latch tested
            // for our optimistic detail 'Solving…', but a legitimate mid-solve
            // 'searching' beat (jobs.js re-fetching descriptions) overwrites
            // `detail`, so a failing Solve skipped the restore and stranded the
            // card spinning with no warning and no Solve button.
            if (!prev || isTerminalSourceStatus(prev.status)) return prev;
            const next = {
              ...prevForRestore,
              status: 'error',
              detail: null,
              url: rawRestoreWarning.url || prev.url,
              warning: restoreWarning,
            };
            return next;
          });
          // This outcome did not recover any source rows. Keep it off the
          // successful-resolve channel: the hub must restore its warning, but
          // must not log a misleading "Resolved … 0 items" receipt or touch
          // its pending-job merge state.
          document.dispatchEvent(new CustomEvent('job-source-resolve-failed', {
            detail: {
              hubId: data.hubId,
              sourceId: data.sourceId,
              items: [],
              replaceSourceItems: false,
              replaceMatchingItems: false,
              removedItemKeys: [],
              gatheredCountDelta: 0,
              resolved: false,
              warning: restoreWarning,
              jobRunId,
            },
          }));
        } else if (prevForRestore) {
          // Solve didn't complete. Restore the actionable warning so the card goes
          // back to red — unless a newer TERMINAL backend event already landed
          // (e.g. LinkedIn's re-emitted error), which we must not clobber. Same
          // predicate as the branch above so the two halves cannot drift apart.
          setProgress(prev => (prev && !isTerminalSourceStatus(prev.status)) ? prevForRestore : prev);
        }
      }
      if (continuationPromises.length > 0) {
        await Promise.allSettled(continuationPromises);
      }
    } catch (error) {
      // Queue cancellation/reset and IPC failures are normal races here. Keep
      // the original actionable state when this card still belongs to the
      // captured run, and never leak an async click-handler rejection.
      if (!resolverAlive() || !capturedRunIsCurrent()) return;
      let solveIpcResult = error?.solveIpcResult || null;
      if (resolveQueueCancelled) {
        EventLogger.log(`[JobSource][${data.hubId}/${data.sourceId}] Resolve queue cancelled before start`);
      } else {
        const failureError = error instanceof Error ? error : new Error(String(error || 'Solve IPC rejected'));
        // A preload/WebContents teardown can reject rather than return the
        // usual handleSafe envelope. Normalize it so this failure remains
        // visible and restores the source's actionable warning just like a
        // browser launch/navigation envelope.
        const solveFailure = failureError.solveIpcResult || {
          success: false,
          error: failureError.message,
        };
        const cancelled = failureError.name === 'AbortError' || isSolveIpcCancellation(solveFailure);
        const message = failureError.solveIpcResult ? failureError.message : solveIpcFailureMessage(solveFailure);
        if (!cancelled) {
          // A handleSafe envelope was already recorded at the point it was
          // converted into an Error above. Logging it again here produced two
          // renderer errors for one failed Solve (one raw Chromium diagnostic,
          // then one generic Error), making reports look like duplicate clicks.
          // Rejected invokes reach this branch without `solveIpcResult` and
          // still need their one renderer-side diagnostic.
          if (!failureError.solveIpcResult) {
            EventLogger.error(`[JobSource][${data.hubId}/${data.sourceId}] Resolve did not start or complete:`, error);
          }
          addToast({
            title: 'Solve could not open',
            description: message,
            type: 'error',
            dedupeKey: `job-solve-failed:${data.hubId}:${data.sourceId}`,
          });
          failureError.solveIpcResult = solveFailure;
          solveIpcResult = solveFailure;
        } else {
          EventLogger.log(`[JobSource][${data.hubId}/${data.sourceId}] Resolve cancelled by lifecycle`);
          solveIpcResult = null;
        }
      }
      setProgress(prev => (
        (prev?.jobRunId || null) === (jobRunId || null) && !isTerminalSourceStatus(prev.status)
          ? (solveIpcResult
            ? { ...prevForRestore, warning: warningForSolveIpcFailure(prevForRestore?.warning, solveIpcResult) }
            : prevForRestore)
          : prev
      ));
      if (isJobWorkflowDeletionPending(data.hubId) && prevForRestore?.warning) {
        document.dispatchEvent(new CustomEvent('job-source-resolve-failed', {
          detail: {
            hubId: data.hubId,
            sourceId: data.sourceId,
            warning: prevForRestore.warning,
            resolved: false,
            restorative: true,
            jobRunId,
          },
        }));
      }
      if (solveIpcResult && prevForRestore?.warning) {
        // onRetryStart optimistically removes non-blocking hub warnings. Put
        // the original actionable source warning back immediately on an IPC
        // launch/navigation failure so the hub and its card cannot disagree.
        // A failed launch/navigation likewise only restores the hub warning.
        // It is not a zero-item recovery and must never enter the successful
        // merge listener.
        document.dispatchEvent(new CustomEvent('job-source-resolve-failed', {
          detail: {
            hubId: data.hubId,
            sourceId: data.sourceId,
            items: [],
            replaceSourceItems: false,
            replaceMatchingItems: false,
            removedItemKeys: [],
            gatheredCountDelta: 0,
            resolved: false,
            warning: warningForSolveIpcFailure(prevForRestore.warning, solveIpcResult),
            jobRunId,
          },
        }));
      }
    } finally {
      if (lease && resolverAlive()) {
        const committed = await waitForTerminalProgressCommit(getNode, id, progressRef.current);
        if (!committed) {
          EventLogger.error(`[JobSource][${data.hubId}/${data.sourceId}] terminal progress was not committed before queue release`);
        }
      }
      lease?.release();
      if (resolverAlive()) {
        resolveInFlightRef.current = false;
        resolveStartedRef.current = false;
        setResolving(false);
      }
    }
  };

  // Hub state via reactive store selectors, not a plain getNode() snapshot —
  // getNode() only reflects the hub's CURRENT data when read, and this card
  // has no other reason to re-render on a hub-only change (lock, hubState)
  // since that doesn't touch this card's own `data` prop. Wrapped in
  // React.memo, a plain snapshot would go stale until some unrelated
  // re-render happened to refresh it (mirrors JobGroupNode.jsx).
  const hubBusy = useStore(
    useCallback((s) => isJobSourceResolveBusyHubState(s.nodeLookup.get(data.hubId)?.data?.hubState), [data.hubId])
  );
  // Hub-cascading lock: when the owning Job Search Module is locked, the source card's
  // interactive controls (Solve, Skip) become no-ops. The card itself stays
  // visible and informational.
  const hubLocked = useStore(
    useCallback((s) => !!s.nodeLookup.get(data.hubId)?.data?.locked, [data.hubId])
  );
  const hubCleanupBlocked = useStore(
    useCallback(
      (s) => hasBlockingJobSearchCleanup(s.nodeLookup.get(data.hubId)?.data),
      [data.hubId],
    ),
  );
  const hubBoardRecoveryOwned = useStore(
    useCallback((s) => !!findJobSearchBoardActiveRecoveryOwner(
      data.hubId,
      s.nodeLookup,
      s.edges,
    ), [data.hubId]),
  );
  const fallbackCount = useStore(
    useCallback((s) => s.nodeLookup.get(data.hubId)?.data?.finalSourceCounts?.[data.sourceId], [data.hubId, data.sourceId])
  );
  // A fresh run begins in 'parsing'/'querying' (the "Reading resume…" phase),
  // BEFORE the search phase emits any per-source progress — so any `progress`
  // still held here is necessarily from the PREVIOUS run. Treat it as stale in
  // those phases (derive, don't setState — clearing state in an effect causes
  // cascading renders) so the card flips straight to "Searching…" instead of
  // lingering on the old count through the whole resume-read/query phase.
  const preSearch = useStore(
    useCallback((s) => {
      const hubState = s.nodeLookup.get(data.hubId)?.data?.hubState;
      return hubState === 'parsing' || hubState === 'querying';
    }, [data.hubId])
  );
  const liveProgress = preSearch ? null : progress;

  // Pick what to display. Live progress wins; otherwise show the last-known
  // count from the most recent completed run — but ONLY between runs. While the
  // hub is busy (a re-run is underway) the last-run count is stale, so suppress
  // it and show "Searching…" until this source emits fresh progress. Without the
  // !hubBusy guard, every card flashes the previous run's counts through the
  // whole "Reading resume…" / query phase before the search phase resets them.
  let status;
  let count;
  if (liveProgress) {
    status = liveProgress.status;
    count  = liveProgress.count;
  } else if (fallbackCount != null && !hubBusy) {
    status = 'done';
    count  = fallbackCount;
  } else {
    status = hubBusy ? 'searching' : 'idle';
    count  = undefined;
  }

  const warning = liveProgress?.warning;
  const warningAction = jobSourceWarningAction(warning);
  const warningCanResolve = canAttemptJobSourceResolve(warning);
  const warningBlocksScoring = isJobSourceWarningGating(warning);
  const resolverBusy = hubBusy && warningAction !== 'open-external';
  const resolverActionDisabled = resolving || hubLocked || hubCleanupBlocked
    || hubBoardRecoveryOwned || resolverBusy;
  // Skipping is safe during an ordinary live search, but not while this card's
  // own resolver is queued/running: that would race its terminal warning.
  const sourceActionDisabled = hubLocked || hubCleanupBlocked || hubBoardRecoveryOwned || resolving;
  const isSearching = status === 'searching';
  const isDone      = status === 'done';
  const isError     = status === 'error';
  const isSkipped   = status === 'skipped';
  const hasBlock    = warning?.severity === 'block';
  const hasThrottle = warning?.severity === 'throttle';
  const hasInfo     = warning?.severity === 'info';
  const hasWarn     = warning?.severity === 'warn';
  const warningLabel = warning?.shortLabel || warning?.code || null;
  const progressTotal = Number.isFinite(liveProgress?.total) && liveProgress.total > 0 ? liveProgress.total : null;
  const progressDone = progressTotal && Number.isFinite(liveProgress?.completed)
    ? Math.max(0, Math.min(liveProgress.completed, progressTotal))
    : null;
  // A single-query source can only ever report 0/1 until it finishes, so the
  // "measured" bar rendered a frozen 8% and the text "0/1" for the entire walk —
  // an implied measurement that never moves reads as a stalled job, which is
  // exactly the wrong signal. With more than one query the fraction is real and
  // does advance, so keep it there; otherwise fall through to the indeterminate
  // working state and let the live detail line carry the progress.
  const hasMeasuredProgress = progressTotal != null && progressDone != null && progressTotal > 1;
  const progressPercent = (isDone || isSkipped || isError)
    ? 100
    : isSearching
      ? hasMeasuredProgress
        ? Math.max(8, Math.min(96, (progressDone / progressTotal) * 100))
        : 42
      : 0;
  const progressText = hasMeasuredProgress && isSearching
    ? `${progressDone}/${progressTotal}`
    : null;

  const statusLine = isError
    ? 'Failed'
    : isSkipped
      ? 'Skipped'
      : isDone
        ? `${count ?? 0} jobs`
        : isSearching
          ? (liveProgress?.detail ? `Searching… ${liveProgress.detail}` : 'Searching…')
          : 'Idle';

  // Red for hard failures/blocks, amber for throttles/skips/warn
  // (action available), platform color for healthy runs. Stale-selector errors
  // (warn severity) are amber — they need a code fix, not a captcha solve.
  const accentColor = ((isError && !hasWarn) || hasBlock)
    ? '#ef4444'
    : (hasThrottle || hasInfo || hasWarn || isSkipped)
      ? '#f59e0b'
      : data.color;

  return (
    // Outer wrapper is draggable: no `nodrag`, no pointer-down stopPropagation.
    // Matches MarketplaceCardNode / CompSourceCardNode.
    <div
      className="w-[140px] rounded-xl bg-neutral-900/95 border-2 shadow-lg overflow-hidden transition-all"
      style={{
        borderColor: `${accentColor}55`,
      }}
    >
      <NodeHandles className="!w-2 !h-2 !bg-white/30 !border-white/10" />

      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <PlatformBadge
          name={data.name}
          letter={data.letter}
          color={accentColor}
          domain={data.domain}
          size={24}
        />
        <div className="flex-1 min-w-0">
          <div className="text-white text-[11px] font-semibold truncate flex items-center gap-1">
            {data.name}
          </div>
          <div className="flex items-center gap-1 mt-0.5">
            {isSearching && <Loader2 size={9} className="text-white/40 animate-spin shrink-0" />}
            {isDone && !warning && <CheckCircle2 size={9} className="text-emerald-400 shrink-0" />}
            {(isError || hasBlock) && <ShieldAlert size={9} className="text-red-400 shrink-0" />}
            {(hasThrottle || hasInfo || isSkipped) && !hasBlock && <ShieldAlert size={9} className="text-amber-400 shrink-0" />}
            <span
              className="text-[9px] truncate"
              style={{ color: (isError || hasBlock) ? '#fca5a5' : (hasThrottle || hasInfo || isSkipped) ? '#fcd34d' : isDone ? '#a7f3d0' : 'rgba(255,255,255,0.45)' }}
            >
              {warning ? warningLabel : statusLine}
            </span>
            {progressText && (
              <span className="ml-auto text-[8px] text-white/30 tabular-nums shrink-0">
                {progressText}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="px-2.5 pb-1.5">
        <div className="h-1 overflow-hidden rounded-full bg-white/10">
          <div
            className={`h-full rounded-full transition-all duration-500 ease-out ${isSearching && !hasMeasuredProgress ? 'animate-pulse' : ''}`}
            style={{
              width: `${progressPercent}%`,
              backgroundColor: accentColor,
              opacity: progressPercent > 0 ? 0.9 : 0,
            }}
          />
        </div>
      </div>
      {/* Embedded warning text — selectable so the user can copy/paste the
          full evidence + suggestion back into a bug report or chat. */}
      {!dismissed && <SourceWarningPanel
        warning={warning}
        hasBlock={hasBlock}
        stopClick
        note={resolverBusy
          ? 'Source gathering/checkpointing is still in progress. Solve becomes available after it finishes.'
          : !warningBlocksScoring ? 'Scoring continues automatically; dismissing only hides this warning.' : null}
      />}
      {/* Solve / Skip row — Solve appears when we have a failed URL to open and
          the warning represents something the visible resolver can change.
          For config-missing (USAJobs no API key) the suggestion text above
          already directs the user to set the env var — no Solve button. */}
      {warning && !dismissed && (
        <div className="flex border-t border-white/10">
          {warningCanResolve && (progress?.warning?.actionLabel || progress?.warning?.resumeState || (progress?.url && !hasWarn)) && !hasInfo && (!hasWarn || warningBlocksScoring) && (
            <button
              onClick={(e) => { e.stopPropagation(); handleSolve(); }}
              onPointerDown={(e) => e.stopPropagation()}
              disabled={warningAction === 'open-external' ? (resolving || hubLocked) : resolverActionDisabled}
              className="nodrag flex-1 flex items-center justify-center gap-1 px-2 py-1 text-[9px] font-medium text-white/70 hover:text-white bg-white/5 hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-default border-r border-white/10"
              title={hubLocked
                ? 'Hub is locked'
                : hubBoardRecoveryOwned
                  ? 'The owning Job Board run must finish or be cancelled first'
                : resolverBusy
                  ? 'Source gathering/checkpointing is still in progress. Solve becomes available after it finishes.'
                : progress?.warning?.actionTitle
                  ? progress.warning.actionTitle
                  : progress?.warning?.resumeState?.mode === 'native-challenge'
                    ? 'Continue opens real Chrome to complete Indeed verification, then resumes the search automatically'
                    : progress?.warning?.resumeState
                      // Generic fallback ONLY. Every warning that knows why it
                      // stopped sets its own actionTitle above — this used to
                      // assert "log in first" for all of them, which read as a
                      // flat contradiction on failures that have nothing to do
                      // with the account (a busy browser profile, a Chrome that
                      // could not start) while the panel right above correctly
                      // said to close a window. Say only what is true for every
                      // resumable warning.
                      ? 'Resumes the search from where this source stopped — see the reason above for what to do first'
                  : 'Open the failed page in a browser sharing your session — solve the captcha or log in, cookies persist for the next Re-run Search'}
            >
              <ExternalLink size={9} />
              {resolving ? 'Running…' : progress?.warning?.actionLabel || (progress?.warning?.resumeState ? 'Continue' : 'Solve')}
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (
                sourceActionDisabled
                || isJobWorkflowDeletionPending(data.hubId)
                || hasBlockingJobSearchCleanup(getNode(data.hubId)?.data)
              ) return;
              if (findJobSearchBoardActiveRecoveryOwner(data.hubId, getNodes(), getEdges())) {
                addToast({
                  title: 'Job Board Run in Progress',
                  description: 'Finish or cancel the owning Job Board run before skipping this source.',
                  type: 'info',
                });
                return;
              }
              setDismissed(true);
              setProgress(prev => prev ? {
                ...prev,
                status: warningBlocksScoring
                  ? 'skipped'
                  : (prev.status === 'done' || prev.status === 'skipped'
                    ? prev.status
                    : ((prev.count || 0) > 0 ? 'done' : 'skipped')),
                warning: null,
              } : { status: 'skipped', count: 0, warning: null });
              // Notify the owning hub so it can drop this source's warning
              // from data.scrapeWarnings. When the hub is paused in the
              // 'sources-ready' state and this is the last block, it
              // auto-resumes scoring. Identified-by hubId so multi-hub
              // canvases don't cross-trigger.
              document.dispatchEvent(new CustomEvent('job-source-skip', {
                detail: {
                  hubId: data.hubId,
                  sourceId: data.sourceId,
                  action: warningAction,
                  warningCode: warning?.code || null,
                  warningSeverity: warning?.severity || null,
                },
              }));
              // A non-gating warning never held the hub open, so there may be no
              // later all-sources dismissal event to remove this acknowledged
              // card. The user explicitly dismissed it; remove it now.
              if (!warningBlocksScoring) {
                deleteElements({ nodes: [{ id }] });
              }
            }}
            onPointerDown={(e) => e.stopPropagation()}
            disabled={sourceActionDisabled}
            className="nodrag flex-1 flex items-center justify-center gap-1 px-2 py-1 text-[9px] font-medium text-white/60 hover:text-white bg-white/[0.03] hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-default"
            title={hubLocked
              ? 'Hub is locked'
              : hubBoardRecoveryOwned
                ? 'The owning Job Board run must finish or be cancelled first'
              : warningBlocksScoring
                ? 'Skip the unresolved remainder of this source and continue once every blocked source is resolved or skipped.'
                : 'Dismiss this warning. It did not pause scoring and does not remove jobs already collected from this source.'}
          >
            <SkipForward size={9} />
            {warningBlocksScoring ? 'Skip' : 'Dismiss'}
          </button>
        </div>
      )}
    </div>
  );
});
