import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { beginOfficialPostingPreparation, getOfficialPostingPreparation, subscribeOfficialPostingPreparation } from '../utils/officialPostingPreparation.js';
import { BOARD_STAGE_RUN_PREFIX } from '../utils/jobBoardCareerOverride.js';
import { isJobWorkflowDeletionPending } from '../utils/nodeDeletionLifecycle.js';
import { BOARD_STAGES } from '../nodes/jobboard/boardStageRerun.js';
import { EventLogger } from '../utils/EventLogger.js';

// Only the salary stage writes through global node updates. Listings and
// grouping rebuild the Board's tree with this canvas level's React Flow API,
// so leaving the level must stop them rather than let them write elsewhere.
const RETAINED_STAGES = new Set(['compensation']);

function retainedBoardOwner(options, canvasFilePath, nodeId) {
  if (typeof options.getCurrentFile !== 'function' || options.getCurrentFile() !== canvasFilePath
    || isJobWorkflowDeletionPending(nodeId)) return false;
  const owner = options.getNode(nodeId);
  return owner?.type === 'jobboard' && !owner.data?.locked;
}

/**
 * Re-run ONE Combine stage on the cards a Board already shows. Admission,
 * the shared job-search lane, the Board claim and cancellation follow the
 * official-posting refresh exactly, so Combine, scans, card lookups and other
 * stage reruns all refuse each other. Each stage's `run(ctx)` does its own IPC
 * and writes; this hook owns only the run's lifetime.
 */
export function useBoardStageRerun(options) {
  const latest = useRef(options);
  useLayoutEffect(() => { latest.current = options; }, [options]);
  const runRef = useRef(null);
  const mounted = useRef(true);
  const [progress, setProgress] = useState(null);
  const retained = useSyncExternalStore(subscribeOfficialPostingPreparation,
    useCallback(() => getOfficialPostingPreparation(options.canvasFilePath, options.nodeId), [options.canvasFilePath, options.nodeId]),
    () => null);

  const cancel = useCallback(async () => {
    const run = runRef.current;
    if (!run) {
      // A salary run kept alive across navigation belongs to the previous
      // mount; its Board claim still carries that run's cancel.
      const saved = getOfficialPostingPreparation(latest.current.canvasFilePath, latest.current.nodeId);
      if (saved?.owner === 'board-refresh' && saved.stage) saved.cancel();
      return true;
    }
    run.cancelled = true;
    if (mounted.current) setProgress(previous => previous ? { ...previous, stopping: true } : previous);
    if (!run.cancellation) {
      run.acknowledged ||= new Promise(resolve => { run.acknowledge = resolve; });
      latest.current.moduleRunQueue.cancelQueuedRunsForNode(run.nodeId, `${BOARD_STAGES[run.stage].label} cancelled`);
      run.cancellation = Promise.resolve().then(async () => {
        const result = await window.electronAPI?.cancelNodeTaskAndWait?.(run.nodeId, 'board-stage-cancelled');
        if (result?.settled !== true) throw new Error('The board update is still stopping. Retry Cancel.');
        run.acknowledge();
      });
    }
    try { await run.cancellation; return true; }
    catch (error) {
      run.cancellation = null;
      if (mounted.current) {
        setProgress(previous => previous ? { ...previous, stopping: false } : previous);
        latest.current.addToast({ title: 'Cancellation not finished', description: error.message, type: 'error' });
      }
      return false;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const run = runRef.current;
      if (run && (!RETAINED_STAGES.has(run.stage) || !retainedBoardOwner(latest.current, run.canvasFilePath, run.nodeId))) void cancel().catch(() => {});
    };
  }, [cancel]);

  const start = useCallback(async (stage) => {
    const definition = BOARD_STAGES[stage];
    const { nodeId, canvasFilePath, getNode, moduleRunQueue, addToast, canStart, getScopeKey, stages } = latest.current;
    if (!definition || typeof stages?.[stage] !== 'function') return;
    if (runRef.current || !canStart() || isJobWorkflowDeletionPending(nodeId)) return;
    const manualAiRunId = `${BOARD_STAGE_RUN_PREFIX}${stage}:${globalThis.crypto.randomUUID()}`;
    const run = { stage, nodeId, canvasFilePath, manualAiRunId, cancelled: false };
    const boardClaim = beginOfficialPostingPreparation({ canvasFilePath, nodeId, purpose: 'lookup', owner: 'board-refresh', stage, cancel });
    if (!boardClaim) {
      addToast({ title: 'Board is busy', description: 'Finish or cancel the running board work first.', type: 'info' });
      return;
    }
    runRef.current = run;
    let lease = null;
    const inScope = () => (mounted.current || retainedBoardOwner(latest.current, canvasFilePath, nodeId)) && !run.cancelled
      && latest.current.canvasFilePath === canvasFilePath && latest.current.nodeId === nodeId
      && (typeof latest.current.getCurrentFile !== 'function' || latest.current.getCurrentFile() === canvasFilePath)
      && !isJobWorkflowDeletionPending(nodeId) && !!getNode(nodeId) && !getNode(nodeId)?.data?.locked;
    const active = () => runRef.current === run && inScope();
    try {
      setProgress({ stage, queued: true });
      lease = await moduleRunQueue.acquireModuleRun({ nodeId, kind: definition.queueKind, lane: 'job-search', label: definition.label });
      if (!active() || !canStart()) return;
      // A card lookup that started while this waited in the lane owns its card.
      const pendingCardLookup = latest.current.getNodes().some(node => node?.type === 'jobcard' && node.data?.hubId === nodeId
        && getOfficialPostingPreparation(canvasFilePath, node.id));
      if (pendingCardLookup) {
        addToast({ title: 'Official posting lookup running', description: 'Finish or cancel the card lookup first.', type: 'info' });
        return;
      }
      const scopeKey = getScopeKey();
      const current = () => active() && getScopeKey() === scopeKey;
      if (mounted.current) setProgress({ stage });
      await stages[stage]({
        manualAiRunId,
        current,
        // Writes run inside React updaters that may apply after this await.
        // `stillOwned` stays true for this run's own late updaters.
        stillOwned: () => inScope() && getScopeKey() === scopeKey,
        setProgress: value => { if (current() && mounted.current) setProgress({ stage, ...value }); },
      });
    } catch (error) {
      if (active() && !run.cancelled) {
        EventLogger.error(`[JobBoard] ${stage} rerun failed`, error);
        addToast({ title: `${definition.label} stopped`, description: error?.message || 'It did not finish. The board kept its previous results.', type: 'error' });
      }
    } finally {
      await window.electronAPI?.completeNonApiAiRun?.(manualAiRunId)?.catch?.(() => {});
      if (run.cancelled && run.acknowledged) await run.acknowledged;
      boardClaim.finish();
      lease?.release();
      if (runRef.current === run) {
        runRef.current = null;
        if (mounted.current) setProgress(null);
      }
    }
  }, [cancel]);

  const recovering = !progress && retained?.owner === 'board-refresh' && retained.stage ? retained.stage : null;
  return { runRef, running: progress !== null || !!recovering,
    progress: progress || (recovering ? { stage: recovering, recovering: true } : null), start, cancel };
}
