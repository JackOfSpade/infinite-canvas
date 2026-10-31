import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { beginOfficialPostingPreparation, getOfficialPostingPreparation, subscribeOfficialPostingPreparation, officialPostingPreparationSourceKey, projectOfficialPostingGenerationJob } from '../utils/officialPostingPreparation.js';
import { boardOfficialPostingRefreshCardMatches, refreshBoardOfficialPostingJobs, summarizeBoardOfficialPostingChecks } from '../utils/jobBoardOfficialPostingRefresh.js';
import { officialPostingLookupStatus } from '../../electron/ipc/officialPostingFields.js';
import { isJobWorkflowDeletionPending } from '../utils/nodeDeletionLifecycle.js';
import { EventLogger } from '../utils/EventLogger.js';

// Navigation removes a Board's React instance while retaining its node in the
// canvas stack. Only callers with live whole-canvas access may keep that work
// running; a missing/deleted owner or a different file still ends ownership.
function retainedBoardOwner(options, canvasFilePath = options.canvasFilePath, nodeId = options.nodeId) {
  if (typeof options.getCurrentFile !== 'function' || options.getCurrentFile() !== canvasFilePath
    || isJobWorkflowDeletionPending(nodeId)) return false;
  const owner = options.getNode(nodeId);
  return owner?.type === 'jobboard' && !owner.data?.locked;
}

/** Board-owned metadata work has its own lifetime; it never creates an application. */
export function useBoardOfficialPostingRefresh(options) {
  const latest = useRef(options);
  useLayoutEffect(() => { latest.current = options; }, [options]);
  const runRef = useRef(null);
  // React may apply accepted node updaters after the IPC run releases its
  // active slot. Keep their identity until the next admitted run supersedes it.
  const settlementRef = useRef(null);
  const mounted = useRef(true);
  const [progress, setProgress] = useState(null);
  const retained = useSyncExternalStore(subscribeOfficialPostingPreparation,
    useCallback(() => getOfficialPostingPreparation(options.canvasFilePath, options.nodeId), [options.canvasFilePath, options.nodeId]),
    () => null);
  const cancel = useCallback(async () => {
    const run = runRef.current;
    if (!run) {
      const saved = getOfficialPostingPreparation(latest.current.canvasFilePath, latest.current.nodeId);
      if (saved?.owner === 'board-refresh') saved.cancel();
      return true;
    }
    run.cancelled = true;
    if (mounted.current) setProgress(previous => previous ? { ...previous, stopping: true } : previous);
    if (!run.cancellation) {
      run.acknowledged ||= new Promise(resolve => { run.acknowledge = resolve; });
      latest.current.moduleRunQueue.cancelQueuedRunsForNode(run.nodeId, 'Official posting refresh cancelled');
      run.cancellation = Promise.resolve().then(async () => {
        const result = await window.electronAPI?.cancelNodeTaskAndWait?.(run.nodeId, 'official-posting-cancelled');
        if (result?.settled !== true) throw new Error('The official posting lookup is still stopping. Retry Cancel.');
        run.acknowledge();
      });
    }
    try { await run.cancellation; return true; }
    catch (error) {
      run.cancellation = null;
      if (mounted.current) {
        setProgress(previous => previous ? { ...previous, stopping: false } : previous);
        latest.current.addToast({ title: 'Lookup cancellation not finished', description: error.message, type: 'error' });
      }
      return false;
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const run = runRef.current;
      if (!retainedBoardOwner(latest.current, run?.canvasFilePath, run?.nodeId)) void cancel().catch(() => {});
    };
  }, [cancel]);

  const start = useCallback(async () => {
    const { nodeId, canvasFilePath, getNode, getNodes, updateGlobal, moduleRunQueue, addToast, canStart, getScopeKey } = latest.current;
    if (runRef.current || !canStart() || isJobWorkflowDeletionPending(nodeId)) return;
    if (typeof window.electronAPI?.refreshOfficialPostings !== 'function') {
      addToast({ title: 'Official posting lookup unavailable', description: 'Restart the updated app, then retry.', type: 'error' });
      return;
    }
    const manualAiRunId = `official-posting:board:${globalThis.crypto.randomUUID()}`;
    const run = { nodeId, canvasFilePath, manualAiRunId, cancelled: false };
    const boardClaim = beginOfficialPostingPreparation({ canvasFilePath, nodeId, purpose: 'lookup', owner: 'board-refresh', cancel });
    if (!boardClaim) return;
    runRef.current = run;
    settlementRef.current = run;
    const claims = [boardClaim]; let lease = null; let unsubscribe = null;
    const inScope = () => (mounted.current || retainedBoardOwner(latest.current, canvasFilePath, nodeId)) && !run.cancelled
      && latest.current.canvasFilePath === canvasFilePath && latest.current.nodeId === nodeId
      && (typeof latest.current.getCurrentFile !== 'function' || latest.current.getCurrentFile() === canvasFilePath)
      && !isJobWorkflowDeletionPending(nodeId) && !!getNode(nodeId) && !getNode(nodeId)?.data?.locked;
    const active = () => runRef.current === run && inScope();
    try {
      setProgress({ completed: 0, total: 0, queued: true });
      lease = await moduleRunQueue.acquireModuleRun({ nodeId, kind: 'official-posting-refresh', lane: 'job-search',
        label: 'Refresh official postings' });
      if (!active() || !canStart()) return;
      const scopeKey = getScopeKey();
      const snapshots = [];
      for (const card of getNodes()) {
        if (card?.type !== 'jobcard' || card.data?.hubId !== nodeId || card.data.locked || isJobWorkflowDeletionPending(card.id)) continue;
        const claim = beginOfficialPostingPreparation({ canvasFilePath, nodeId: card.id, purpose: 'lookup', cancel });
        if (!claim) continue;
        claims.push(claim);
        const job = projectOfficialPostingGenerationJob(card.data);
        snapshots.push({ id: card.id, job, key: officialPostingPreparationSourceKey(job),
          posting: JSON.stringify(card.data.officialPosting ?? null), postedBy: card.data.postedBy });
      }
      if (!snapshots.length) {
        addToast({ title: 'No available job cards', description: 'Unlock the cards or finish their current lookups, then retry.', type: 'info' });
        return;
      }
      if (mounted.current) setProgress({ completed: 0, total: snapshots.length });
      const current = () => active() && getScopeKey() === scopeKey;
      let batchBase = 0;
      unsubscribe = window.electronAPI.onOfficialPostingRefreshProgress?.(event => {
        if (!current() || event?.nodeId !== nodeId || event.manualAiRunId !== manualAiRunId) return;
        const completed = Number.isSafeInteger(event.completed) ? Math.max(0, event.completed) : 0;
        if (mounted.current) setProgress({ completed: Math.min(snapshots.length, batchBase + completed), total: snapshots.length });
      });
      const result = await refreshBoardOfficialPostingJobs(snapshots.map(item => item.job), {
        nodeId, manualAiRunId, force: true, cardIds: snapshots.map(item => item.id), cancelled: () => !current(),
        refresh: async args => {
          const response = await window.electronAPI.refreshOfficialPostings(args);
          batchBase += args.entries.length;
          return response;
        },
        onProgress: value => { if (current() && mounted.current) setProgress(value); },
      });
      if (!current()) return;
      for (const [index, snapshot] of snapshots.entries()) {
        const fresh = result.jobs[index];
        updateGlobal(snapshot.id, node => {
          if (settlementRef.current !== run || !inScope() || getScopeKey() !== scopeKey
            || isJobWorkflowDeletionPending(snapshot.id)
            || !boardOfficialPostingRefreshCardMatches(node, snapshot, nodeId)) return null;
          const status = officialPostingLookupStatus(fresh.officialPosting);
          const clearNotice = (node.data.listingGenerationNotice?.basis === 'official-lookup' && !status.retryable)
            || (node.data.listingGenerationNotice?.basis === 'official-closed' && status.state === 'verified' && !status.retryable);
          return { officialPosting: fresh.officialPosting, postedBy: fresh.postedBy,
            ...(clearNotice ? { listingGenerationNotice: null, listingHold: false } : {}) };
        });
      }
      const summary = summarizeBoardOfficialPostingChecks(result.jobs);
      const outcomes = [[summary.verified, 'verified'], [summary.notFound, 'no exact match'],
        [summary.ambiguous, 'ambiguous'], [summary.closed, 'closed'], [summary.retryable, 'incomplete']]
        .filter(([count]) => count).map(([count, label]) => `${count} ${label}`).join(', ');
      EventLogger.log(`[JobBoard] official-posting refresh finished checked=${summary.checked} verified=${summary.verified} notFound=${summary.notFound} ambiguous=${summary.ambiguous} closed=${summary.closed} retryable=${summary.retryable}`);
      addToast({ title: summary.retryable ? 'Official posting checks incomplete' : 'Official postings checked',
        description: `${summary.checked} check${summary.checked === 1 ? '' : 's'} finished: ${outcomes}. ${summary.retryable ? 'Retry incomplete lookups. ' : ''}Changed or unavailable cards kept their current results.`,
        type: summary.retryable ? 'info' : 'success' });
    } catch (error) {
      if (active() && error?.code !== 'JOB_OFFICIAL_REFRESH_CANCELLED') {
        EventLogger.error('[JobBoard] official-posting refresh failed', error);
        addToast({ title: 'Official posting refresh stopped', description: error?.message || 'The lookup did not finish. Retry to check the remaining postings.', type: 'error' });
      }
    } finally {
      unsubscribe?.();
      await window.electronAPI?.completeNonApiAiRun?.(manualAiRunId)?.catch?.(() => {});
      if (run.cancelled && run.acknowledged) await run.acknowledged;
      for (const claim of claims) claim.finish();
      lease?.release();
      if (runRef.current === run) {
        runRef.current = null;
        if (mounted.current) setProgress(null);
      }
    }
  }, [cancel]);
  const recovering = retained?.owner === 'board-refresh';
  return { runRef, refreshing: progress !== null || recovering,
    progress: progress || (recovering ? { recovering: true } : null), start, cancel };
}
