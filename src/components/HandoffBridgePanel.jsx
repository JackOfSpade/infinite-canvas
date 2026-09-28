import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Cable, Pause, Play, Settings, X } from 'lucide-react';
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
import { BRIDGE_UI_COPY, ipcErrorMessage } from '../utils/handoffBridgeCopy';
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

const TONE_CLASS = Object.freeze({
  off: 'bg-slate-400',
  setup: 'bg-sky-400',
  working: 'bg-violet-400',
  ok: 'bg-emerald-400',
  attention: 'bg-amber-400',
  error: 'bg-red-400',
  nudge: 'bg-sky-400',
});

function bridgeApi() {
  try { return globalThis.window?.electronAPI || null; } catch { return null; }
}
function safeResult(result) {
  try {
    if (!result || typeof result !== 'object') return { success: true, items: [] };
    if (result.success === false) return { success: false, code: typeof result.code === 'string' ? result.code : 'INTERNAL', items: [] };
    return { success: true, items: Array.isArray(result.items) ? result.items : [] };
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
  const panelRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => startHandoffBridgeStatusSync(), []);

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

  const call = useCallback(async (method, payload) => {
    const result = await invoke(bridgeApi(), method, payload);
    if (mountedRef.current) {
      setNotice(result?.success === false ? ipcErrorMessage(result.code) : BRIDGE_UI_COPY.done);
    }
    return result;
  }, []);

  const health = deriveBridgeHealth(status, now);
  const chat = describeChat(status.chat, now);
  const canPause = status.enabled && !status.paused && status.serving === 'live';
  const canResume = status.enabled && status.paused;
  const canPair = status.enabled && status.setup.tunnelReachable;
  const canStartChat = status.enabled && status.serving === 'live' && !status.paused && status.setup.tunnelReachable && status.setup.linked;
  const canRelease = status.enabled && ['live', 'paused'].includes(status.serving);
  const healthActionDisabled = id => (
    (['new-chat', 'copy-starter'].includes(id) && !canStartChat)
    || (id === 'pause' && !canPause)
    || (id === 'resume' && !canResume)
    || (id === 'open-pairing' && !canPair)
    || (id === 'revoke-all' && !status.enabled)
  );
  const newChat = useCallback(() => {
    const referenceNow = now || status.at;
    const age = status.chat.lastCallAt && referenceNow >= status.chat.lastCallAt
      ? referenceNow - status.chat.lastCallAt
      : Infinity;
    if (status.chat.ordinal && age < 120000) setConfirm('new');
    else void call('handoffBridgeNewChat');
  }, [call, now, status.at, status.chat.lastCallAt, status.chat.ordinal]);

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
    .slice(0, 10);

  let dialog = null;
  if (confirm === 'new') {
    dialog = (
      <ConfirmDialog
        title={BRIDGE_UI_COPY.confirmNewTitle}
        message={BRIDGE_UI_COPY.confirmNewMessage(
          chat.ordinal,
          chat.lastCall || BRIDGE_UI_COPY.recently,
        )}
        confirmLabel={BRIDGE_UI_COPY.confirmNew}
        cancelLabel={BRIDGE_UI_COPY.keepChat(chat.ordinal)}
        onConfirm={() => {
          setConfirm(null);
          void call('handoffBridgeNewChat');
        }}
        onCancel={() => setConfirm(null)}
      />
    );
  } else if (confirm === 'revoke') {
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
            {health.actions.map(item => (
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
            {canStartChat && <div className="mt-2 flex min-w-0 flex-wrap gap-2">
              <button type="button" disabled={!chat.ordinal} onClick={() => void call('handoffBridgeContinueChat')} className="bridge-button-secondary">
                {BRIDGE_UI_COPY.copyContinue}
              </button>
              <button type="button" onClick={newChat} className="bridge-button-secondary">
                {BRIDGE_UI_COPY.startChat}
              </button>
            </div>}
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

          {status.enabled && <footer className="mt-4 flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-3">
            <span className="flex min-w-0 items-center gap-1 text-[11px] text-white/35">
              <Cable size={12} /> {health.headline}
            </span>
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
