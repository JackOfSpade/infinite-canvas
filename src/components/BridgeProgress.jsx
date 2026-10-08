import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { BRIDGE_PROGRESS_COPY, BRIDGE_UI_COPY, ipcErrorMessage } from '../utils/handoffBridgeCopy';
import { deriveBridgeJobProgress, deriveBridgePushProgress, progressTimeLines } from '../utils/bridgeJobProgress';
import { MAX_HANDOFF_CONCURRENCY } from '../utils/handoffScheduler';
import { HEADLINE_CLASS, TONE_CLASS } from '../utils/bridgeProgressStyles';

// Live progress for an application the bridge holds or a selected push handoff
// awaiting/holding an exact claim. Its start action prepares the same adaptive
// worker plan as the bridge panel, then exposes only per-worker copy controls
// (never a session code) right where the person sees the pending handoffs.

const STEP_CLASS = Object.freeze({
  done: 'border-emerald-400/40 bg-emerald-500/15 text-emerald-100',
  current: 'border-violet-300/60 bg-violet-500/25 text-white',
  upcoming: 'border-white/10 bg-transparent text-white/45',
});
const NO_COPIED_WORKERS = new Set();
const WORKER_STATES = new Set(['available', 'ready', 'working', 'quiet', 'waiting', 'idle']);
const QUIET_REASONS = new Set(['answer_silent', 'polling_stopped', 'fresh_context_required']);

function bridgeApi() {
  try { return globalThis.window?.electronAPI || null; } catch { return null; }
}

function workerOrdinal(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_HANDOFF_CONCURRENCY ? value : null;
}

function workerOrdinals(value) {
  return Array.isArray(value)
    ? [...new Set(value.map(workerOrdinal).filter(Boolean))].sort((left, right) => left - right)
    : [];
}

function poolFromChat(chat, observedReleased = 0) {
  const pool = chat?.pool;
  const generation = Number.isSafeInteger(pool?.generation) && pool.generation > 0 ? pool.generation : null;
  const workerCount = workerOrdinal(pool?.workerCount);
  if (pool?.active !== true || !generation || !workerCount) return null;
  const seen = new Set();
  const workers = Array.isArray(pool.workers) ? pool.workers.flatMap(worker => {
    const ordinal = workerOrdinal(worker?.ordinal);
    const state = typeof worker?.state === 'string' && WORKER_STATES.has(worker.state)
      ? worker.state
      : null;
    const completed = Number.isSafeInteger(worker?.completed) && worker.completed >= 0 && worker.completed <= 1_000_000
      ? worker.completed
      : 0;
    if (!ordinal || ordinal > workerCount || !state || seen.has(ordinal)) return [];
    seen.add(ordinal);
    const lastCallAt = Number.isFinite(worker?.lastCallAt) && worker.lastCallAt >= 0
      ? worker.lastCallAt
      : null;
    const quietReason = state === 'quiet' && typeof worker?.quietReason === 'string' && QUIET_REASONS.has(worker.quietReason)
      ? worker.quietReason
      : null;
    return [{ ordinal, state, completed, lastCallAt, quietReason }];
  }).sort((left, right) => left.ordinal - right.ordinal) : [];
  const plan = pool?.plan && typeof pool.plan === 'object' ? pool.plan : {};
  const queued = Number.isSafeInteger(plan.queued) && plan.queued >= 0 ? plan.queued : 0;
  const observed = Number.isSafeInteger(observedReleased) && observedReleased >= 0 ? observedReleased : 0;
  const reportedMaterialized = Number.isSafeInteger(plan.materialized) && plan.materialized >= 0
    ? Math.min(queued, plan.materialized)
    : queued;
  const materialized = Math.min(queued, Math.max(observed, reportedMaterialized));
  const recommended = workerOrdinal(plan.recommended) || workerCount;
  return { generation, workerCount, queued, materialized, recommended, workers, plan: { recommended } };
}

function workerPoolCapacityCopy(pool) {
  const count = workerOrdinal(pool?.workerCount) || 0;
  const recommended = workerOrdinal(pool?.plan?.recommended) || workerOrdinal(pool?.recommended) || count;
  if (recommended > count) return BRIDGE_UI_COPY.workerPoolGrowing(count, recommended);
  return '';
}

function statusSequence(status) {
  return Number.isSafeInteger(status?.seq) && status.seq >= 0 ? status.seq : 0;
}

function workerPoolMatches(left, right) {
  return Boolean(left && right && left.generation === right.generation && left.workerCount === right.workerCount);
}

function poolStillCurrent(pool, status, reported) {
  // A snapshot that predates the start response cannot prove that the new
  // main-owned pool ended. As soon as a newer snapshot arrives, it must name
  // this exact pool or local worker controls are discarded.
  if (!pool || statusSequence(status) <= (Number.isSafeInteger(pool.statusSeq) ? pool.statusSeq : 0)) return true;
  return workerPoolMatches(pool, reported);
}

function workerPoolProgress(pool, reportedPool, copiedWorkers, copiedWorkerStatusSeqs, currentStatusSeq) {
  const reportedWorkers = workerPoolMatches(pool, reportedPool) && Array.isArray(reportedPool?.workers)
    ? reportedPool.workers
    : [];
  const reportedByOrdinal = new Map(reportedWorkers.map(worker => [worker.ordinal, worker]));
  const poolByOrdinal = new Map((Array.isArray(pool?.workers) ? pool.workers : []).map(worker => [worker.ordinal, worker]));
  const workers = Array.from({ length: pool?.workerCount || 0 }, (_unused, index) => {
    const ordinal = index + 1;
    const reported = reportedByOrdinal.get(ordinal) || poolByOrdinal.get(ordinal);
    // A response from Copy arrives before its next status push. Treat that
    // transient local fact as ready, but let main's reported worker lifecycle
    // take over as soon as it is available so remounts cannot revive a copy.
    const copiedAtSeq = copiedWorkerStatusSeqs.get(ordinal);
    const localCopyBridgesSnapshot = copiedWorkers.has(ordinal)
      && Number.isSafeInteger(copiedAtSeq)
      && currentStatusSeq <= copiedAtSeq;
    const state = reported?.state
      ? (reported.state === 'available' && localCopyBridgesSnapshot ? 'ready' : reported.state)
      : copiedWorkers.has(ordinal) ? 'ready' : 'available';
    return {
      ordinal,
      state,
      completed: reported?.completed || 0,
      lastCallAt: Number.isFinite(reported?.lastCallAt) && reported.lastCallAt >= 0 ? reported.lastCallAt : null,
      quietReason: state === 'quiet' && QUIET_REASONS.has(reported?.quietReason) ? reported.quietReason : null,
    };
  });
  const summary = workers.reduce((result, worker) => {
    result[worker.state] += 1;
    result.completed += worker.completed;
    return result;
  }, { available: 0, ready: 0, working: 0, quiet: 0, waiting: 0, idle: 0, completed: 0 });
  return { workers, byOrdinal: new Map(workers.map(worker => [worker.ordinal, worker])), summary };
}

function claimedPushWorker(status, item, pool) {
  const claimId = typeof item?.bridgeClaimId === 'string' ? item.bridgeClaimId : null;
  if (!claimId || !Array.isArray(status?.push?.claimWorkers) || !Array.isArray(pool?.workers)) return null;
  const claim = status.push.claimWorkers.find(entry => entry?.claimId === claimId);
  const ordinal = workerOrdinal(claim?.workerOrdinal);
  return ordinal ? pool.workers.find(worker => worker?.ordinal === ordinal) || null : null;
}

function invoke(method, payload) {
  try {
    const api = bridgeApi();
    const fn = api?.[method];
    if (typeof fn !== 'function') return Promise.resolve({ success: false, code: 'UNAVAILABLE' });
    return Promise.resolve(payload === undefined ? fn.call(api) : fn.call(api, payload)).then(
      result => (result && typeof result === 'object' && result.success === false
        ? { success: false, code: typeof result.code === 'string' ? result.code : 'INTERNAL' }
        : {
          success: true,
          // Main decides whether the press re-copied the same starter.
          recopied: result?.recopied === true,
          chatOrdinal: Number.isInteger(result?.chatOrdinal) ? result.chatOrdinal : 0,
          generation: Number.isSafeInteger(result?.generation) && result.generation > 0 ? result.generation : null,
          workerCount: workerOrdinal(result?.workerCount),
          recommended: workerOrdinal(result?.recommended),
          queued: Number.isSafeInteger(result?.queued) && result.queued >= 0 ? result.queued : 0,
          materialized: Number.isSafeInteger(result?.materialized) && result.materialized >= 0 ? Math.min(Number.isSafeInteger(result?.queued) && result.queued >= 0 ? result.queued : 0, result.materialized) : (Number.isSafeInteger(result?.queued) && result.queued >= 0 ? result.queued : 0),
          workerOrdinal: workerOrdinal(result?.workerOrdinal),
          lockedWorkerOrdinals: workerOrdinals(result?.lockedWorkerOrdinals),
        }),
      () => ({ success: false, code: 'INTERNAL' }),
    );
  } catch {
    return Promise.resolve({ success: false, code: 'INTERNAL' });
  }
}

// The shared four-stage application stepper. Extracted so the grouped
// applications page can render each row's own step list with markup identical
// to the single-item dock page.
export function BridgeStepList({ steps }) {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  return (
    <ol aria-label={BRIDGE_PROGRESS_COPY.stepper} className="flex flex-wrap items-center gap-1.5">
      {steps.map((step, index) => (
        <li
          key={step.key}
          aria-current={step.state === 'current' ? 'step' : undefined}
          className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] ${STEP_CLASS[step.state]}`}
        >
          {step.state === 'done'
            ? <Check size={11} aria-hidden="true" />
            : <span aria-hidden="true" className="font-mono text-[10px]">{index + 1}</span>}
          <span>{step.label}</span>
          <span className="sr-only">{`, ${BRIDGE_PROGRESS_COPY.stepState[step.state]}`}</span>
        </li>
      ))}
    </ol>
  );
}

export function BridgeProgress({
  status,
  item,
  isPush = false,
  awaitingClaim = false,
  canPauseAndSave = false,
  onPauseAndSave,
  observedReleased,
  workersOnly = false,
}) {
  const [now, setNow] = useState(() => Date.now());
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [workerPool, setWorkerPool] = useState(null);
  const [copiedWorkers, setCopiedWorkers] = useState(() => new Set());
  const [copiedWorkerStatusSeqs, setCopiedWorkerStatusSeqs] = useState(() => new Map());
  const [copyingWorker, setCopyingWorker] = useState(null);
  const [pausingAndSaving, setPausingAndSaving] = useState(false);
  const mountedRef = useRef(true);
  const statusRef = useRef(status);
  // Set synchronously so a second click in the same tick is refused before
  // React has re-rendered the button as disabled.
  const busyRef = useRef(false);

  const jobs = Array.isArray(status?.queue?.jobs) ? status.queue.jobs : [];
  const job = jobs.find(entry => entry?.jobId === item?.jobId) || null;
  const chat = status?.chat && typeof status.chat === 'object' ? status.chat : {};
  const pluginName = status?.config?.pluginName;
  // The dock has an active released push request even if its status snapshot
  // lags the registry's materialized count. Do not show "0 released" beside
  // a visible worker-owned handoff. A page-level worker block instead passes
  // the number of rows it represents so the materialized count is never
  // understated while rows are still loading in or the snapshot is stale.
  const observedReleasedCount = Number.isSafeInteger(observedReleased) && observedReleased >= 0
    ? observedReleased
    : (isPush && item ? 1 : 0);
  const reportedPool = poolFromChat(chat, observedReleasedCount);
  const expandedWorkerPool = workerPool && reportedPool
    && workerPool.generation === reportedPool.generation
    && reportedPool.workerCount >= workerPool.workerCount
    ? reportedPool
    : null;
  const activeWorkerPool = workerPool && poolStillCurrent(workerPool, status, reportedPool)
    ? (expandedWorkerPool || workerPool)
    : reportedPool;
  const copiedWorkersForPool = workerPoolMatches(workerPool, activeWorkerPool) ? copiedWorkers : NO_COPIED_WORKERS;
  const activeCopyingWorker = workerPoolMatches(workerPool, activeWorkerPool) ? copyingWorker : null;
  const activeWorkerProgress = activeWorkerPool
    ? workerPoolProgress(
      activeWorkerPool,
      reportedPool,
      copiedWorkersForPool,
      workerPoolMatches(workerPool, activeWorkerPool) ? copiedWorkerStatusSeqs : new Map(),
      statusSequence(status),
    )
    : null;
  const workerPoolCapacity = activeWorkerPool ? workerPoolCapacityCopy(activeWorkerPool) : '';
  const ownerWorker = isPush === true
    ? claimedPushWorker(status, item, reportedPool)
    : (() => {
      const ordinal = workerOrdinal(job?.workerOrdinal);
      return ordinal ? reportedPool?.workers?.find(worker => worker?.ordinal === ordinal) || null : null;
    })();
  // Both kinds can carry the opaque claim token. The dialog owns the request
  // kind, so use that explicit discriminator rather than token presence: an
  // application bundle must retain its lane and four-stage progress view.
  const view = isPush === true
    ? deriveBridgePushProgress({ chat, bridge: {
      paused: status?.paused === true, pluginName,
      enabled: status?.enabled === true,
      serving: status?.serving,
      tunnelReachable: status?.setup?.tunnelReachable === true,
      linked: status?.setup?.linked === true,
    }, ownerWorker, awaitingClaim })
    : deriveBridgeJobProgress({ job, chat, item, ownerWorker, now, bridge: { paused: status?.paused === true, pluginName } });
  const lines = progressTimeLines(view, now);
  // The page-level worker block never prints the timer lines, so it must not
  // re-render once a second for them either.
  const ticking = !workersOnly && (view.since !== null || view.lastHeard !== null);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // One interval for both timer lines, alive only while there is a line to
  // update. It cannot outlive the component.
  useEffect(() => {
    if (!ticking) return undefined;
    // Refresh once on start (the clock may be stale from before the timer
    // lines appeared), then every second. Same shape as the bridge panel's.
    const update = () => setNow(Date.now());
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => {
      if (mountedRef.current) setNotice('');
    }, 8000);
    return () => clearTimeout(timer);
  }, [notice]);

  const run = useCallback(async (method, success) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await invoke(method);
      if (mountedRef.current) {
        if (!result.success) setNotice(ipcErrorMessage(result.code));
        else if (method === 'handoffBridgeNewChat' && result.recopied && result.chatOrdinal > 0) setNotice(BRIDGE_PROGRESS_COPY.copiedAgain(result.chatOrdinal, pluginName));
        else setNotice(success);
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [pluginName]);

  const prepareWorkerPool = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await invoke(
        'handoffBridgeStartWorkerPool',
        undefined,
      );
      if (!mountedRef.current) return;
      if (!result.success || !result.generation || !result.workerCount) {
        setNotice(ipcErrorMessage(result.code || 'INTERNAL'));
        return;
      }
      const currentStatus = statusRef.current;
      setWorkerPool({
        generation: result.generation,
        workerCount: result.workerCount,
        recommended: result.recommended || result.workerCount,
        queued: result.queued,
        materialized: result.materialized,
        statusSeq: statusSequence(currentStatus),
      });
      setCopiedWorkers(new Set(result.lockedWorkerOrdinals));
      setCopiedWorkerStatusSeqs(new Map(result.lockedWorkerOrdinals.map(ordinal => [ordinal, statusSequence(currentStatus)])));
      setNotice(BRIDGE_UI_COPY.workerPoolReady);
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, []);

  const copyWorkerStarter = async ordinal => {
    const worker = activeWorkerProgress?.byOrdinal.get(ordinal);
    if (!activeWorkerPool || !['available', 'ready'].includes(worker?.state) || busyRef.current || activeCopyingWorker !== null) return;
    const currentStatus = statusRef.current;
    if (!poolStillCurrent(activeWorkerPool, currentStatus, poolFromChat(currentStatus?.chat, observedReleasedCount))) return;
    const copyStatusSeq = statusSequence(currentStatus);
    busyRef.current = true;
    setCopyingWorker(ordinal);
    try {
      const result = await invoke('handoffBridgeCopyWorkerStarter', {
        generation: activeWorkerPool.generation,
        workerOrdinal: ordinal,
      });
      if (!mountedRef.current) return;
      const latestStatus = statusRef.current;
      if (!poolStillCurrent(activeWorkerPool, latestStatus, poolFromChat(latestStatus?.chat, observedReleasedCount))) return;
      setWorkerPool(previous => workerPoolMatches(previous, activeWorkerPool)
          ? previous
          : {
            generation: activeWorkerPool.generation,
            workerCount: activeWorkerPool.workerCount,
            recommended: activeWorkerPool.recommended || activeWorkerPool.plan?.recommended || activeWorkerPool.workerCount,
            queued: activeWorkerPool.queued || 0,
            materialized: activeWorkerPool.materialized || 0,
            statusSeq: statusSequence(latestStatus),
          });
      if (result.success) {
        setCopiedWorkers(previous => new Set([...previous, ordinal]));
        setCopiedWorkerStatusSeqs(previous => new Map([...previous, [ordinal, copyStatusSeq]]));
        setNotice(result?.recopied === true
          ? BRIDGE_UI_COPY.workerStarterRecopied(ordinal, activeWorkerPool.workerCount)
          : BRIDGE_UI_COPY.workerStarterCopied(ordinal, activeWorkerPool.workerCount));
      } else {
        if (result.code === 'SESSION_STARTED' || result.code === 'STARTER_COPIED') {
          setCopiedWorkers(previous => new Set([...previous, ordinal]));
          setCopiedWorkerStatusSeqs(previous => new Map([...previous, [ordinal, copyStatusSeq]]));
        }
        setNotice(ipcErrorMessage(result.code));
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setCopyingWorker(null);
    }
  };

  const restartWorker = async ordinal => {
    const worker = activeWorkerProgress?.byOrdinal.get(ordinal);
    if (!activeWorkerPool || worker?.state !== 'quiet' || busyRef.current || activeCopyingWorker !== null) return;
    const currentStatus = statusRef.current;
    if (!poolStillCurrent(activeWorkerPool, currentStatus, poolFromChat(currentStatus?.chat, observedReleasedCount))) return;
    const copyStatusSeq = statusSequence(currentStatus);
    busyRef.current = true;
    setCopyingWorker(ordinal);
    try {
      const result = await invoke('handoffBridgeRestartWorker', {
        generation: activeWorkerPool.generation,
        workerOrdinal: ordinal,
      });
      if (!mountedRef.current) return;
      const latestStatus = statusRef.current;
      if (!poolStillCurrent(activeWorkerPool, latestStatus, poolFromChat(latestStatus?.chat, observedReleasedCount))) return;
      if (result.success) {
        setCopiedWorkers(previous => new Set([...previous, ordinal]));
        setCopiedWorkerStatusSeqs(previous => new Map([...previous, [ordinal, copyStatusSeq]]));
        setNotice(BRIDGE_UI_COPY.workerStarterCopied(ordinal, activeWorkerPool.workerCount));
      } else setNotice(ipcErrorMessage(result.code));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setCopyingWorker(null);
    }
  };

  // The panel's gate for both chat buttons.
  const canStartChat = status?.enabled === true && status?.serving === 'live' && status?.paused !== true
    && status?.setup?.tunnelReachable === true && status?.setup?.linked === true;
  const onAction = () => {
    if (busyRef.current) return;
    if (view.action === 'continue-chat') void run('handoffBridgeContinueChat', BRIDGE_PROGRESS_COPY.copiedContinue);
    else if (view.action === 'start-chat') void prepareWorkerPool();
  };
  const pauseAndSave = useCallback(async () => {
    if (pausingAndSaving || typeof onPauseAndSave !== 'function') return;
    setPausingAndSaving(true);
    try {
      const result = await onPauseAndSave({
        nodeId: item?.nodeId || null,
        runId: item?.runId || null,
        requestId: item?.requestId || null,
      });
      if (mountedRef.current) {
        setNotice(result?.success === true
          ? 'Saving this Job Search. Accepted work stays saved; Resume will appear when stopping finishes.'
          : (result?.error || 'This Job Search is no longer active. Its handoff was left unchanged.'));
      }
    } catch {
      if (mountedRef.current) setNotice('Could not ask this Job Search to pause. Its handoff was left unchanged.');
    } finally {
      if (mountedRef.current) setPausingAndSaving(false);
    }
  }, [item, onPauseAndSave, pausingAndSaving]);
  const actionDisabled = busy || !canStartChat || (view.action === 'continue-chat' && !chat.ordinal);
  const toneLabel = BRIDGE_PROGRESS_COPY.toneLabel[view.tone];

  // A page-level worker block shows no per-row progress chrome: no stepper,
  // no elapsed/last-heard lines, no pause-and-save. It only explains why a
  // worker chat is needed (when there is an actionable chat), then exposes the
  // shared worker pool and its start/continue control plus any transient
  // notice. Nothing to show means nothing is rendered.
  if (workersOnly && !view.action && !activeWorkerPool && !notice) return null;

  return (
    <section
      aria-label={BRIDGE_PROGRESS_COPY.region}
      data-progress-kind={view.kind}
      data-workers-only={workersOnly ? 'true' : undefined}
      className={`min-w-0 rounded-lg border px-3 py-3 text-xs leading-relaxed ${TONE_CLASS[view.tone] || TONE_CLASS.neutral}`}
    >
      {!workersOnly && !isPush && view.steps.length > 0 && <BridgeStepList steps={view.steps} />}

      {(!workersOnly || view.action) && (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className={(isPush || workersOnly) ? '' : 'mt-2.5'}
        >
          <div className={`font-semibold ${HEADLINE_CLASS[view.tone] || 'text-white'}`}>
            {toneLabel ? <span className="mr-1.5 text-[10px] font-semibold uppercase tracking-wide opacity-75">{toneLabel}</span> : null}
            {view.headline}
          </div>
          <div className="mt-1 text-white/70">{view.detail}</div>
        </div>
      )}

      {!workersOnly && (lines.elapsed || lines.heard) && (
        <p className="mt-2 text-[11px] text-white/50">
          {[lines.elapsed, lines.heard].filter(Boolean).join(' · ')}
        </p>
      )}

      {!workersOnly && canPauseAndSave && typeof onPauseAndSave === 'function' && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-md border border-amber-300/20 bg-amber-300/[0.06] p-2">
          <button
            type="button"
            onClick={() => void pauseAndSave()}
            disabled={pausingAndSaving}
            className="rounded-md border border-amber-300/35 px-2.5 py-1.5 text-[11px] font-medium text-amber-100 transition-colors hover:bg-amber-300/10 disabled:cursor-not-allowed disabled:opacity-50"
            data-action="pause-and-save-job-search"
          >
            {pausingAndSaving ? 'Saving Job Search…' : 'Pause & save Job Search'}
          </button>
          <p className="text-[10px] text-amber-100/70">Keeps accepted work and this unresolved handoff for Resume; it does not clear your response.</p>
        </div>
      )}

      {activeWorkerPool && (
        <div className="mt-2.5 rounded-md border border-sky-300/20 bg-sky-400/5 p-2.5">
          <p className="text-[11px] font-medium text-sky-100">{BRIDGE_UI_COPY.workerPoolPlan(activeWorkerPool.workerCount, activeWorkerPool.queued, activeWorkerPool.materialized)}</p>
          {activeWorkerProgress?.summary.available > 0 && (
            <p className="mt-1 text-[11px] text-white/60">{BRIDGE_UI_COPY.workerPoolDirections(activeWorkerPool.workerCount)}</p>
          )}
          {workerPoolCapacity && <p className="mt-1 text-[11px] text-sky-100/80">{workerPoolCapacity}</p>}
          {activeWorkerProgress && (
            <ul className="mt-2 space-y-1.5" aria-label="Worker chat progress">
              {activeWorkerProgress.workers.map(worker => (
                <li
                  key={`${activeWorkerPool.generation}-${worker.ordinal}`}
                  className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-white/10 bg-black/10 px-2 py-1.5 text-[11px]"
                >
                  <span className="font-medium text-white/85">Worker {worker.ordinal}</span>
                  <span className={worker.state === 'quiet' ? 'text-amber-200' : worker.state === 'working' ? 'text-violet-200' : 'text-white/55'}>
                    {BRIDGE_UI_COPY.workerState(worker.state, worker.quietReason)}
                  </span>
                  {worker.completed > 0 && <span className="text-white/45">{BRIDGE_UI_COPY.workerDone(worker.completed)}</span>}
                  {worker.state === 'quiet' && (
                    <>
                      <span className="basis-full text-amber-100/80">{BRIDGE_UI_COPY.workerQuiet(worker.quietReason)}</span>
                      <button
                        type="button"
                        disabled={busy || activeCopyingWorker !== null}
                        aria-busy={activeCopyingWorker === worker.ordinal || undefined}
                        onClick={() => void restartWorker(worker.ordinal)}
                        className="ml-auto rounded-md border border-white/15 bg-white/5 px-2.5 py-1.5 text-[11px] font-medium text-white/85 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {activeCopyingWorker === worker.ordinal
                          ? BRIDGE_UI_COPY.copyingWorker(worker.ordinal)
                          : BRIDGE_UI_COPY.copyReplacementStarter}
                      </button>
                    </>
                  )}
                  {['available', 'ready'].includes(worker.state) && (
                    <button
                      type="button"
                      disabled={busy || activeCopyingWorker !== null}
                      aria-busy={activeCopyingWorker === worker.ordinal || undefined}
                      onClick={() => void copyWorkerStarter(worker.ordinal)}
                      className="ml-auto rounded-md border border-white/15 bg-white/5 px-2.5 py-1.5 text-[11px] font-medium text-white/85 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {activeCopyingWorker === worker.ordinal
                        ? BRIDGE_UI_COPY.copyingWorker(worker.ordinal)
                        : worker.state === 'ready'
                          ? BRIDGE_UI_COPY.copyWorkerStarterAgain(worker.ordinal)
                          : BRIDGE_UI_COPY.copyWorkerStarter(worker.ordinal)}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!activeWorkerPool && view.action && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onAction}
            disabled={actionDisabled}
            className="rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-[11px] font-medium text-white/85 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {view.actionLabel}
          </button>
        </div>
      )}

      {notice && <p role="status" className="mt-2 text-[11px] text-amber-200">{notice}</p>}
    </section>
  );
}
