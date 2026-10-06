import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Pause, Play, Settings, X } from 'lucide-react';
import { ConfirmDialog } from './ConfirmDialog';
import { useHandoffBridgeStatus } from '../hooks/useHandoffBridgeStatus';
import { startHandoffBridgeStatusSync } from '../utils/handoffBridgeStore';
import {
  closeBridgePopover,
  getBridgeUiState,
  openBridgePopover,
  openBridgeSetup,
  subscribeBridgeUi,
} from '../utils/handoffBridgeUiStore';
import {
  activityLabel,
  deriveBridgeHealth,
  describeChat,
  describeJobRow,
} from '../utils/handoffBridgeView';
import { BRIDGE_PROGRESS_COPY, BRIDGE_UI_COPY, ipcErrorMessage } from '../utils/handoffBridgeCopy';
import {
  getApplicationHandoffs,
  requestApplicationHandoffFocus,
  requestApplicationHandoffRefresh,
  subscribeApplicationHandoffs,
} from '../utils/applicationHandoffDock';
import {
  projectDockItemsForBridge,
  sanitizeBridgeLabel,
  startBridgeJobPublisher,
} from '../utils/handoffBridgeQueue';
import { HANDOFF_CONCURRENCY } from '../utils/handoffScheduler';

const TONE_CLASS = Object.freeze({
  off: 'bg-slate-400',
  setup: 'bg-sky-400',
  working: 'bg-violet-400',
  ok: 'bg-emerald-400',
  attention: 'bg-amber-400',
  error: 'bg-red-400',
  nudge: 'bg-sky-400',
});
const MAX_POOL_WORKERS = HANDOFF_CONCURRENCY;
const NO_COPIED_WORKERS = new Set();
const WORKER_STATES = new Set(['available', 'ready', 'working', 'quiet', 'waiting', 'idle']);
const QUIET_REASONS = new Set(['answer_silent', 'polling_stopped']);

function bridgeApi() {
  try { return globalThis.window?.electronAPI || null; } catch { return null; }
}

// Pool starter capabilities never reach the renderer. Status carries only this
// bounded, process-local identity so the permanently mounted panel can prove
// that its local controls still point at the current main-process pool.
function workerPoolFromStatus(status) {
  try {
    if (status?.availability?.ok !== true || status?.enabled !== true || !['live', 'paused'].includes(status?.serving)) return null;
    const pool = status?.chat?.pool;
    if (pool?.active !== true) return null;
    const generation = Number.isSafeInteger(pool.generation) && pool.generation > 0 ? pool.generation : null;
    const workerCount = Number.isSafeInteger(pool.workerCount) && pool.workerCount >= 1 && pool.workerCount <= MAX_POOL_WORKERS
      ? pool.workerCount
      : null;
    if (!generation || !workerCount) return null;
    const seen = new Set();
    const workers = Array.isArray(pool.workers) ? pool.workers.flatMap(worker => {
      const ordinal = Number.isSafeInteger(worker?.ordinal) && worker.ordinal >= 1 && worker.ordinal <= workerCount
        ? worker.ordinal
        : null;
      const state = typeof worker?.state === 'string' && WORKER_STATES.has(worker.state)
        ? worker.state
        : null;
      const completed = Number.isSafeInteger(worker?.completed) && worker.completed >= 0 && worker.completed <= 1_000_000
        ? worker.completed
        : 0;
      if (!ordinal || !state || seen.has(ordinal)) return [];
      seen.add(ordinal);
      const lastCallAt = Number.isFinite(worker?.lastCallAt) && worker.lastCallAt >= 0
        ? worker.lastCallAt
        : null;
      const quietReason = state === 'quiet' && typeof worker?.quietReason === 'string' && QUIET_REASONS.has(worker.quietReason)
        ? worker.quietReason
        : null;
      return [{ ordinal, state, completed, lastCallAt, quietReason }];
    }).sort((left, right) => left.ordinal - right.ordinal) : [];
    const plan = pool?.plan && typeof pool.plan === 'object'
      ? {
        recommended: Number.isSafeInteger(pool.plan.recommended) && pool.plan.recommended >= 0 && pool.plan.recommended <= MAX_POOL_WORKERS ? pool.plan.recommended : workerCount,
        queued: Number.isSafeInteger(pool.plan.queued) && pool.plan.queued >= 0 ? pool.plan.queued : 0,
        materialized: Number.isSafeInteger(pool.plan.materialized) && pool.plan.materialized >= 0 ? Math.min(Number.isSafeInteger(pool.plan.queued) && pool.plan.queued >= 0 ? pool.plan.queued : 0, pool.plan.materialized) : (Number.isSafeInteger(pool.plan.queued) && pool.plan.queued >= 0 ? pool.plan.queued : 0),
        expandBy: Number.isSafeInteger(pool.plan.expandBy) && pool.plan.expandBy >= 0 && pool.plan.expandBy <= MAX_POOL_WORKERS ? pool.plan.expandBy : 0,
        reason: typeof pool.plan.reason === 'string' ? pool.plan.reason : 'empty',
      }
      : { recommended: workerCount, queued: 0, materialized: 0, expandBy: 0, reason: 'empty' };
    return { generation, workerCount, queued: plan.queued, materialized: plan.materialized, workers, plan };
  } catch {
    return null;
  }
}

function statusSequence(status) {
  return Number.isSafeInteger(status?.seq) && status.seq >= 0 ? status.seq : 0;
}

function workerPoolMatchesStatus(pool, reported) {
  return Boolean(pool && reported && pool.generation === reported.generation && pool.workerCount === reported.workerCount);
}

function poolStillCurrent(pool, status) {
  // A status that predates the main-owned start response is not evidence that
  // the new pool ended. Once a newer snapshot arrives, it must name this exact
  // pool or the renderer discards its stale local state.
  if (!pool || statusSequence(status) <= (Number.isSafeInteger(pool.statusSeq) ? pool.statusSeq : 0)) return true;
  return workerPoolMatchesStatus(pool, workerPoolFromStatus(status));
}

function workerPoolProgress(pool, reportedPool, copiedWorkers, copiedWorkerStatusSeqs, currentStatusSeq) {
  const reportedWorkers = workerPoolMatchesStatus(pool, reportedPool) && Array.isArray(reportedPool?.workers)
    ? reportedPool.workers
    : [];
  const reportedByOrdinal = new Map(reportedWorkers.map(worker => [worker.ordinal, worker]));
  const poolByOrdinal = new Map((Array.isArray(pool?.workers) ? pool.workers : []).map(worker => [worker.ordinal, worker]));
  const workers = Array.from({ length: pool?.workerCount || 0 }, (_unused, index) => {
    const ordinal = index + 1;
    const reported = reportedByOrdinal.get(ordinal) || poolByOrdinal.get(ordinal);
    // A local copy result wins over an older status snapshot that still says
    // "available". Once the main process reports a real worker state, that
    // durable state wins and survives a panel remount or a later queue wave.
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

function workerPoolCapacityCopy(pool) {
  const count = Number.isSafeInteger(pool?.workerCount) ? pool.workerCount : 0;
  const recommended = Number.isSafeInteger(pool?.plan?.recommended)
    ? pool.plan.recommended
    : (Number.isSafeInteger(pool?.recommended) ? pool.recommended : count);
  if (recommended > count) return BRIDGE_UI_COPY.workerPoolGrowing(count, recommended);
  return '';
}

function safeResult(result) {
  try {
    if (!result || typeof result !== 'object') return { success: true, items: [] };
    if (result.success === false) return { success: false, code: typeof result.code === 'string' ? result.code : 'INTERNAL', items: [] };
    const generation = Number.isSafeInteger(result.generation) && result.generation > 0 ? result.generation : null;
    const workerCount = Number.isSafeInteger(result.workerCount) && result.workerCount >= 1 && result.workerCount <= MAX_POOL_WORKERS
      ? result.workerCount
      : null;
    const recommended = Number.isSafeInteger(result.recommended) && result.recommended >= 1 && result.recommended <= MAX_POOL_WORKERS
      ? result.recommended
      : null;
    const queued = Number.isSafeInteger(result.queued) && result.queued >= 0 && result.queued <= 1_000_000 ? result.queued : 0;
    const materialized = Number.isSafeInteger(result.materialized) && result.materialized >= 0 && result.materialized <= 1_000_000 ? Math.min(queued, result.materialized) : queued;
    const workerOrdinal = Number.isSafeInteger(result.workerOrdinal) && result.workerOrdinal >= 1 && result.workerOrdinal <= MAX_POOL_WORKERS
      ? result.workerOrdinal
      : null;
    const workerOrdinals = value => Array.isArray(value)
      ? [...new Set(value.filter(item => Number.isSafeInteger(item) && item >= 1 && item <= MAX_POOL_WORKERS))]
      : [];
    return {
      success: true,
      items: Array.isArray(result.items) ? result.items : [],
      recopied: result.recopied === true,
      chatOrdinal: Number.isInteger(result.chatOrdinal) ? result.chatOrdinal : 0,
      // Deliberately copy only the non-secret pool metadata. A worker starter
      // can contain a session capability; it must stay in main and clipboard.
      generation,
      workerCount,
      recommended,
      queued,
      materialized,
      workerOrdinal,
      newWorkerOrdinals: workerOrdinals(result.newWorkerOrdinals),
      lockedWorkerOrdinals: workerOrdinals(result.lockedWorkerOrdinals),
      copied: result.copied === true,
    };
  } catch {
    return { success: false, code: 'INTERNAL', items: [] };
  }
}
function invoke(api, method, payload) {
  try {
    const fn = api?.[method];
    if (typeof fn !== 'function') return Promise.resolve({ success: false, code: 'UNAVAILABLE' });
    const result = payload === undefined ? fn.call(api) : fn.call(api, payload);
    return Promise.resolve(result).then(safeResult, () => ({ success: false, code: 'INTERNAL', items: [] }));
  } catch {
    return Promise.resolve({ success: false, code: 'INTERNAL' });
  }
}

function itemLabel(item) {
  return sanitizeBridgeLabel(
    item?.label || item?.title || item?.company || BRIDGE_UI_COPY.application,
  );
}

export function HandoffBridgePanel() {
  const status = useHandoffBridgeStatus();
  const ui = useSyncExternalStore(subscribeBridgeUi, getBridgeUiState, getBridgeUiState);
  const [now, setNow] = useState(0);
  const [notice, setNotice] = useState('');
  const [activity, setActivity] = useState([]);
  const [dockItems, setDockItems] = useState(() => getApplicationHandoffs());
  const [confirm, setConfirm] = useState(null);
  const [workerPool, setWorkerPool] = useState(null);
  const [startingWorkerPool, setStartingWorkerPool] = useState(false);
  const [copyingWorker, setCopyingWorker] = useState(null);
  const [copiedWorkers, setCopiedWorkers] = useState(() => new Set());
  const [copiedWorkerStatusSeqs, setCopiedWorkerStatusSeqs] = useState(() => new Map());
  const panelRef = useRef(null);
  const mountedRef = useRef(true);
  const statusRef = useRef(status);

  useEffect(() => startHandoffBridgeStatusSync(), []);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => subscribeApplicationHandoffs(setDockItems), []);

  useEffect(() => {
    if (!status.enabled || !status.availability.ok) return undefined;
    return startBridgeJobPublisher({
      subscribe: subscribeApplicationHandoffs,
      getItems: getApplicationHandoffs,
    });
  }, [status.availability.ok, status.enabled]);

  useEffect(() => {
    if (!ui.popoverOpen) return undefined;
    const update = () => setNow(Date.now());
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [ui.popoverOpen]);

  useEffect(() => {
    if (!ui.popoverOpen) return undefined;
    panelRef.current?.focus();
    const onKeyDown = event => {
      if (event.key === 'Escape' && !confirm) {
        event.preventDefault();
        closeBridgePopover();
      }
    };
    const onPointerDown = event => {
      if (!confirm && !panelRef.current?.contains(event.target)) closeBridgePopover();
    };
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [confirm, ui.popoverOpen]);

  useEffect(() => {
    if (!ui.popoverOpen) return undefined;
    let cancelled = false;
    void invoke(bridgeApi(), 'handoffBridgeGetActivity').then(result => {
      if (!cancelled && result?.success !== false && Array.isArray(result?.items)) {
        setActivity(result.items.slice(0, 200));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [status.activityVersion, ui.popoverOpen]);

  useEffect(() => {
    try {
      const api = bridgeApi(); const listener = api?.onHandoffBridgeJobChanged;
      if (typeof listener !== 'function') return undefined;
      return listener.call(api, value => requestApplicationHandoffRefresh(value?.jobId || null));
    } catch {
      return undefined;
    }
  }, []);

  useEffect(() => {
    try {
      const api = bridgeApi(); const listener = api?.onHandoffBridgeOpenPanel;
      if (typeof listener !== 'function') return undefined;
      return listener.call(api, value => {
        if (value?.step) openBridgeSetup(value.step);
        else openBridgePopover();
      });
    } catch {
      return undefined;
    }
  }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => {
      if (mountedRef.current) setNotice('');
    }, 8000);
    return () => clearTimeout(timer);
  }, [notice]);

  const reportedWorkerPool = workerPoolFromStatus(status);
  // Do not mirror status into state with an effect: that creates a render
  // where a retired pool can still hide New/Continue. Render only a local pool
  // that a newer main-process status still proves current; otherwise fall back
  // to a currently reported pool (for a remounted panel) or nothing at all.
  const expandedWorkerPool = workerPool && reportedWorkerPool
    && workerPool.generation === reportedWorkerPool.generation
    && reportedWorkerPool.workerCount >= workerPool.workerCount
    ? reportedWorkerPool
    : null;
  const activeWorkerPool = workerPool && poolStillCurrent(workerPool, status)
    ? (expandedWorkerPool || workerPool)
    : reportedWorkerPool;
  const copiedWorkersForPool = workerPoolMatchesStatus(workerPool, activeWorkerPool) ? copiedWorkers : NO_COPIED_WORKERS;
  const activeCopyingWorker = workerPoolMatchesStatus(workerPool, activeWorkerPool) ? copyingWorker : null;
  const activeWorkerProgress = activeWorkerPool
    ? workerPoolProgress(
      activeWorkerPool,
      reportedWorkerPool,
      copiedWorkersForPool,
      workerPoolMatchesStatus(workerPool, activeWorkerPool) ? copiedWorkerStatusSeqs : new Map(),
      statusSequence(status),
    )
    : null;
  const workerPoolCapacity = activeWorkerPool ? workerPoolCapacityCopy(activeWorkerPool) : '';

  const pluginName = status.config?.pluginName;
  const call = useCallback(async (method, payload) => {
    const result = await invoke(bridgeApi(), method, payload);
    if (mountedRef.current) {
      if (result?.success === false) setNotice(ipcErrorMessage(result.code));
      else if (method === 'handoffBridgeNewChat' && result?.recopied && result.chatOrdinal > 0) {
        setNotice(BRIDGE_PROGRESS_COPY.copiedAgain(result.chatOrdinal, pluginName));
      } else setNotice(BRIDGE_UI_COPY.done);
    }
    return result;
  }, [pluginName]);

  const health = deriveBridgeHealth(status, now);
  const chat = describeChat(status.chat, now);
  const canPause = status.enabled && !status.paused && status.serving === 'live';
  const canResume = status.enabled && status.paused;
  const canPair = status.enabled && status.setup.tunnelReachable;
  const canStartChat = status.enabled && status.serving === 'live' && !status.paused && status.setup.tunnelReachable && status.setup.linked;
  const canRelease = status.enabled && ['live', 'paused'].includes(status.serving);
  const visibleHealthActions = health.actions.filter(item => (
    !canStartChat || !['new-chat', 'copy-starter'].includes(item.id)
  ));
  const healthActionDisabled = id => (
    (['new-chat', 'copy-starter'].includes(id) && !canStartChat)
    || (id === 'pause' && !canPause)
    || (id === 'resume' && !canResume)
    || (id === 'open-pairing' && !canPair)
    || (id === 'revoke-all' && !status.enabled)
  );
  const startWorkerPool = useCallback(async () => {
    if (startingWorkerPool) return null;
    setStartingWorkerPool(true);
    try {
      const result = await invoke(
        bridgeApi(),
        'handoffBridgeStartWorkerPool',
        undefined,
      );
      if (!mountedRef.current) return result;
      if (result?.success === false || !result?.generation || !result?.workerCount) {
        setNotice(ipcErrorMessage(result?.code || 'INTERNAL'));
        return result;
      }
      const currentStatus = statusRef.current;
      if (currentStatus?.enabled !== true || !['live', 'paused'].includes(currentStatus?.serving)) {
        setNotice(ipcErrorMessage('NOT_READY'));
        return result;
      }
      setWorkerPool({
        generation: result.generation,
        workerCount: result.workerCount,
        recommended: result.recommended || result.workerCount,
        queued: result.queued,
        materialized: result.materialized,
        statusSeq: statusSequence(currentStatus),
      });
      setCopiedWorkers(new Set(result.lockedWorkerOrdinals || []));
      setCopiedWorkerStatusSeqs(new Map((result.lockedWorkerOrdinals || []).map(ordinal => [ordinal, statusSequence(currentStatus)])));
      setNotice(BRIDGE_UI_COPY.workerPoolReady);
      return result;
    } finally {
      if (mountedRef.current) setStartingWorkerPool(false);
    }
  }, [startingWorkerPool]);

  // Every visible "start" route now prepares the adaptive worker plan. A
  // one-worker result still uses pool mode, which lets that chat drain later
  // waves without the legacy two-bundle rollover.
  const newChat = useCallback(() => {
    void startWorkerPool();
  }, [startWorkerPool]);

  const copyWorkerStarter = useCallback(async workerOrdinal => {
    const worker = activeWorkerProgress?.byOrdinal.get(workerOrdinal);
    if (!activeWorkerPool || worker?.state !== 'available' || activeCopyingWorker !== null) return null;
    if (!poolStillCurrent(activeWorkerPool, statusRef.current)) return null;
    const copyStatusSeq = statusSequence(statusRef.current);
    setCopyingWorker(workerOrdinal);
    const result = await invoke(bridgeApi(), 'handoffBridgeCopyWorkerStarter', {
      generation: activeWorkerPool.generation,
      workerOrdinal,
    });
    if (mountedRef.current) {
      setCopyingWorker(null);
      if (!poolStillCurrent(activeWorkerPool, statusRef.current)) return result;
      // A remounted renderer can discover a still-live pool via status alone.
      // Retain that safe identity after the first interaction so copied-worker
      // buttons remain locked locally without ever knowing a starter code.
      setWorkerPool(previous => workerPoolMatchesStatus(previous, activeWorkerPool)
        ? previous
        : {
            generation: activeWorkerPool.generation,
            workerCount: activeWorkerPool.workerCount,
            recommended: activeWorkerPool.recommended || activeWorkerPool.workerCount,
            queued: activeWorkerPool.queued || 0,
            materialized: activeWorkerPool.materialized || 0,
            statusSeq: statusSequence(statusRef.current),
          });
      if (result?.success === false) {
        if (result.code === 'STARTER_COPIED' || result.code === 'SESSION_STARTED') {
          setCopiedWorkers(previous => new Set([...previous, workerOrdinal]));
          setCopiedWorkerStatusSeqs(previous => new Map([...previous, [workerOrdinal, copyStatusSeq]]));
        }
        setNotice(ipcErrorMessage(result.code));
      } else {
        setCopiedWorkers(previous => new Set([...previous, workerOrdinal]));
        setCopiedWorkerStatusSeqs(previous => new Map([...previous, [workerOrdinal, copyStatusSeq]]));
        setNotice(BRIDGE_UI_COPY.workerStarterCopied(workerOrdinal, activeWorkerPool.workerCount));
      }
    }
    return result;
  }, [activeCopyingWorker, activeWorkerPool, activeWorkerProgress]);

  const restartWorker = useCallback(async workerOrdinal => {
    const worker = activeWorkerProgress?.byOrdinal.get(workerOrdinal);
    if (!activeWorkerPool || worker?.state !== 'quiet' || activeCopyingWorker !== null) return null;
    if (!poolStillCurrent(activeWorkerPool, statusRef.current)) return null;
    const copyStatusSeq = statusSequence(statusRef.current);
    setCopyingWorker(workerOrdinal);
    const result = await invoke(bridgeApi(), 'handoffBridgeRestartWorker', {
      generation: activeWorkerPool.generation,
      workerOrdinal,
    });
    if (mountedRef.current) {
      setCopyingWorker(null);
      if (!poolStillCurrent(activeWorkerPool, statusRef.current)) return result;
      if (result?.success) {
        setCopiedWorkers(previous => new Set([...previous, workerOrdinal]));
        setCopiedWorkerStatusSeqs(previous => new Map([...previous, [workerOrdinal, copyStatusSeq]]));
        setNotice(BRIDGE_UI_COPY.workerStarterCopied(workerOrdinal, activeWorkerPool.workerCount));
      } else setNotice(ipcErrorMessage(result?.code || 'INTERNAL'));
    }
    return result;
  }, [activeCopyingWorker, activeWorkerPool, activeWorkerProgress]);

  const runHealthAction = useCallback(id => {
    if (id === 'setup') {
      openBridgeSetup(1);
      return;
    }
    if (id === 'open-panel') {
      openBridgePopover();
      return;
    }
    if (id === 'open-dock') {
      const first = status.queue.jobs.find(job => job.phase === 'needs_user');
      if (first) requestApplicationHandoffFocus(first.jobId);
      return;
    }
    if (id === 'open-pairing') {
      // Pairing's one direct response contains the short-lived code. Always
      // enter the setup surface that owns, displays and clears that response;
      // the generic panel caller deliberately sanitizes action results.
      openBridgeSetup(3);
      return;
    }
    if (id === 'new-chat' || id === 'copy-starter') {
      newChat();
      return;
    }
    if (id === 'revoke-all') {
      setConfirm('revoke');
      return;
    }
    const method = {
      enable: 'handoffBridgeSetEnabled',
      pause: 'handoffBridgePause',
      resume: 'handoffBridgeResume',
      'restart-tunnel': 'handoffBridgeRestartTunnel',
    }[id];
    if (method) void call(method, id === 'enable' ? { enabled: true } : undefined);
  }, [call, newChat, status.queue.jobs]);

  if (!status.availability.ok) return null;

  const projected = projectDockItemsForBridge(dockItems);
  const releasedIds = new Set(status.queue.jobs.map(job => job.jobId));
  const releasableIds = new Set(
    projected
      .filter(item => item.dockState === 'awaiting' && !releasedIds.has(item.jobId))
      .map(item => item.jobId),
  );
  const candidates = dockItems
    .filter(item => item?.kind === 'application' && releasableIds.has(item.jobId))
    .slice(0, MAX_POOL_WORKERS);

  let dialog = null;
  if (confirm === 'revoke') {
    dialog = (
      <ConfirmDialog
        title={BRIDGE_UI_COPY.confirmRevokeTitle}
        message={BRIDGE_UI_COPY.confirmRevokeMessage}
        confirmLabel={BRIDGE_UI_COPY.confirmRevoke}
        cancelLabel={BRIDGE_UI_COPY.cancel}
        onConfirm={() => {
          setConfirm(null);
          void call('handoffBridgeRevokeAll');
        }}
        onCancel={() => setConfirm(null)}
      />
    );
  }

  return (
    <>
      {ui.popoverOpen && (
        <aside
          ref={panelRef}
          tabIndex={-1}
          className="fixed bottom-3 left-3 z-[900] w-[360px] max-w-[calc(100vw-2rem)] min-w-0 max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl border border-white/10 bg-neutral-950/95 p-4 shadow-2xl backdrop-blur sm:left-14"
          aria-label={BRIDGE_UI_COPY.panelLabel}
        >
          <header className="flex items-start gap-3">
            <span className={`mt-1 h-2.5 w-2.5 rounded-full ${TONE_CLASS[health.tone] || 'bg-white/30'}`} />
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold text-white">{health.headline}</h2>
              <p className="mt-0.5 text-xs leading-relaxed text-white/55">{health.detail}</p>
              {health.notes.map(note => (
                <p key={note} className="mt-1 text-[11px] text-amber-200">{note}</p>
              ))}
            </div>
            <button
              type="button"
              onClick={() => openBridgeSetup(2)}
              aria-label={BRIDGE_UI_COPY.settingsLabel}
              className="bridge-icon-button"
            >
              <Settings size={16} />
            </button>
            <button
              type="button"
              onClick={closeBridgePopover}
              aria-label={BRIDGE_UI_COPY.closePanel}
              className="bridge-icon-button"
            >
              <X size={16} />
            </button>
          </header>

          <div className="mt-3 flex flex-wrap gap-2">
            {status.paused ? (
              <button type="button" disabled={!canResume} onClick={() => void call('handoffBridgeResume')} className="bridge-button-primary">
                <Play size={13} /> {BRIDGE_UI_COPY.resume}
              </button>
            ) : canPause ? (
              <button type="button" onClick={() => void call('handoffBridgePause')} className="bridge-button-secondary">
                <Pause size={13} /> {BRIDGE_UI_COPY.pause}
              </button>
            ) : null}
            {visibleHealthActions.map(item => (
              <button
                type="button"
                key={item.id}
                disabled={healthActionDisabled(item.id)}
                onClick={() => runHealthAction(item.id)}
                className={item.kind === 'danger' ? 'bridge-button-danger' : 'bridge-button-secondary'}
              >
                {item.label}
              </button>
            ))}
          </div>

          {notice && <p role="status" className="mt-3 text-xs text-amber-200">{notice}</p>}

          <section className="mt-4 border-t border-white/10 pt-3">
            <h3 className="text-xs font-semibold text-white/75">{BRIDGE_UI_COPY.chat}</h3>
            <p className="mt-1 text-xs text-white/50">
              {chat.ordinal ? BRIDGE_UI_COPY.chatOrdinal(chat.ordinal) : BRIDGE_UI_COPY.noChat}
              {chat.workingOn ? ` · ${BRIDGE_UI_COPY.workingOn(chat.workingOn)}` : ''}
            </p>
            {canStartChat && !activeWorkerPool && chat.ordinal && (
              <div className="mt-2 flex min-w-0 flex-wrap gap-2">
                <button type="button" onClick={() => void call('handoffBridgeContinueChat')} className="bridge-button-secondary">
                  {BRIDGE_UI_COPY.copyContinue}
                </button>
              </div>
            )}
            {canStartChat && (
              <div className="mt-3 rounded-lg border border-sky-300/20 bg-sky-400/5 p-2.5">
                {!activeWorkerPool ? (
                  <>
                    <p className="text-[11px] leading-relaxed text-white/55">{BRIDGE_UI_COPY.workerPoolLead}</p>
                    <button type="button" disabled={startingWorkerPool} aria-busy={startingWorkerPool || undefined} onClick={() => void startWorkerPool()} className="mt-2 bridge-button-primary">
                      {startingWorkerPool ? BRIDGE_UI_COPY.preparingWorkerPool : BRIDGE_UI_COPY.startWorkerPool}
                    </button>
                  </>
                ) : (
                  <>
                    <p className="text-[11px] font-medium text-sky-100">{BRIDGE_UI_COPY.workerPoolPlan(activeWorkerPool.workerCount, activeWorkerPool.queued, activeWorkerPool.materialized)}</p>
                    {activeWorkerProgress?.summary.available > 0 && (
                      <p className="mt-1 text-[11px] leading-relaxed text-white/55">{BRIDGE_UI_COPY.workerPoolDirections(activeWorkerPool.workerCount)}</p>
                    )}
                    {workerPoolCapacity && <p className="mt-1 text-[11px] leading-relaxed text-sky-100/80">{workerPoolCapacity}</p>}
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
                                  disabled={activeCopyingWorker !== null}
                                  aria-busy={activeCopyingWorker === worker.ordinal || undefined}
                                  onClick={() => void restartWorker(worker.ordinal)}
                                  className="ml-auto bridge-button-secondary"
                                >
                                  {activeCopyingWorker === worker.ordinal
                                    ? BRIDGE_UI_COPY.copyingWorker(worker.ordinal)
                                    : BRIDGE_UI_COPY.copyReplacementStarter}
                                </button>
                              </>
                            )}
                            {worker.state === 'available' && (
                              <button
                                type="button"
                                disabled={activeCopyingWorker !== null}
                                aria-busy={activeCopyingWorker === worker.ordinal || undefined}
                                onClick={() => void copyWorkerStarter(worker.ordinal)}
                                className="ml-auto bridge-button-secondary"
                              >
                                {activeCopyingWorker === worker.ordinal
                                  ? BRIDGE_UI_COPY.copyingWorker(worker.ordinal)
                                  : BRIDGE_UI_COPY.copyWorkerStarter(worker.ordinal)}
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
            )}
          </section>

          <section className="mt-4 border-t border-white/10 pt-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-white/75">{BRIDGE_UI_COPY.applications}</h3>
              <button
                type="button"
                disabled={!canRelease || !candidates.length}
                onClick={() => void call('handoffBridgeRelease', {
                  items: candidates.map(item => ({ jobId: item.jobId })),
                })}
                className="text-[11px] text-sky-300 hover:text-sky-200 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {BRIDGE_UI_COPY.sendAll}
              </button>
            </div>
            <ul className="mt-2 space-y-2">
              {candidates.map(item => (
                <li key={item.jobId} className="flex items-center justify-between gap-2 text-xs">
                  <span className="min-w-0 truncate text-white/55">{itemLabel(item)}</span>
                  <button
                    type="button"
                    disabled={!canRelease}
                    onClick={() => void call('handoffBridgeRelease', { items: [{ jobId: item.jobId }] })}
                    className="text-sky-300 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {BRIDGE_UI_COPY.release}
                  </button>
                </li>
              ))}
              {status.queue.jobs.slice(0, 50).map(job => {
                const row = describeJobRow(job);
                return (
                  <li key={job.jobId} className="flex items-center justify-between gap-2 text-xs">
                    <span className="min-w-0 text-white/55">{row.text}</span>
                    <div className="shrink-0 flex gap-1">
                      {row.action === 'hold' && (
                        <button
                          type="button"
                          disabled={!canRelease}
                          onClick={() => void call('handoffBridgeHoldJob', { jobId: job.jobId, held: true })}
                          className="text-sky-300 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {BRIDGE_UI_COPY.keepForMe}
                        </button>
                      )}
                      {row.action === 'resume' && (
                        <button
                          type="button"
                          disabled={!canRelease}
                          onClick={() => void call('handoffBridgeHoldJob', { jobId: job.jobId, held: false })}
                          className="text-sky-300 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {BRIDGE_UI_COPY.resumeServing}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => requestApplicationHandoffFocus(job.jobId)}
                        className="text-white/45 hover:text-white"
                      >
                        {BRIDGE_UI_COPY.openDock}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="mt-4 border-t border-white/10 pt-3">
            <h3 className="text-xs font-semibold text-white/75">{BRIDGE_UI_COPY.scoring}</h3>
            {status.push.discovered.map((hub, index) => (
              <label key={hub.key} className="mt-2 flex items-center gap-2 text-xs text-white/55">
                <input
                  type="checkbox"
                  checked={status.push.selectedHubs.includes(hub.key)}
                  disabled={!canRelease}
                  onChange={event => void call(
                    event.target.checked ? 'handoffBridgeReleasePush' : 'handoffBridgeUnreleasePush',
                    event.target.checked ? { hubs: [hub.key] } : { hub: hub.key },
                  )}
                />
                {BRIDGE_UI_COPY.scoringHub(index + 1, hub.pending)}
              </label>
            ))}
          </section>

          <section className="mt-4 border-t border-white/10 pt-3">
            <h3 className="text-xs font-semibold text-white/75">{BRIDGE_UI_COPY.activity}</h3>
            <ul className="mt-2 space-y-1 text-[11px] text-white/45">
              {activity.length ? activity.map((item, index) => (
                <li key={`${item?.at || 0}-${index}`}>{activityLabel(item)}</li>
              )) : <li>{BRIDGE_UI_COPY.noActivity}</li>}
            </ul>
          </section>

          <section className="mt-4 border-t border-white/10 pt-3">
            <h3 className="text-[11px] text-white/35">{BRIDGE_UI_COPY.counts}</h3>
            <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-white/45">
              <span>{BRIDGE_UI_COPY.served}: {status.counts.getServed}</span>
              <span>{BRIDGE_UI_COPY.accepted}: {status.counts.submitAccepted}</span>
              <span>{BRIDGE_UI_COPY.rejected}: {status.counts.submitRejected}</span>
              <span>{BRIDGE_UI_COPY.duplicates}: {status.counts.submitDuplicate}</span>
              <span>{BRIDGE_UI_COPY.junk}: {status.counts.submitJunk}</span>
              <span>{BRIDGE_UI_COPY.stalls}: {status.counts.stallNotices}</span>
              <span>{BRIDGE_UI_COPY.tunnelRestarts}: {status.counts.tunnelRestarts}</span>
            </div>
          </section>

          {status.enabled && <footer className="mt-4 flex min-w-0 flex-wrap justify-end gap-2 border-t border-white/10 pt-3">
            <div className="flex min-w-0 flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setConfirm('revoke')}
                className="bridge-button-danger"
              >
                {BRIDGE_UI_COPY.revoke}
              </button>
              <button
                type="button"
                onClick={() => void call('handoffBridgeSetEnabled', { enabled: false })}
                className="bridge-button-danger"
              >
                {BRIDGE_UI_COPY.turnOff}
              </button>
            </div>
          </footer>}
        </aside>
      )}
      {dialog}
    </>
  );
}
