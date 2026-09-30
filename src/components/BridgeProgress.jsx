import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { ConfirmDialog } from './ConfirmDialog';
import { BRIDGE_PROGRESS_COPY, BRIDGE_UI_COPY, ipcErrorMessage } from '../utils/handoffBridgeCopy';
import { describeChat } from '../utils/handoffBridgeView';
import { deriveBridgeJobProgress, progressTimeLines } from '../utils/bridgeJobProgress';

// Live progress for one application the ChatGPT bridge holds, drawn inside the
// dock's bridge-held state. It only READS the status the dock already has, and
// its one button drives the SAME renderer IPC calls the bridge panel's chat
// section uses (handoffBridgeNewChat / handoffBridgeContinueChat), with the same
// "a chat called under 2 minutes ago" confirmation. No IPC channel is added.

const TONE_CLASS = Object.freeze({
  neutral: 'border-white/10 bg-white/[0.03]',
  working: 'border-violet-400/25 bg-violet-500/10',
  attention: 'border-amber-400/35 bg-amber-500/10',
  problem: 'border-red-400/35 bg-red-500/10',
});
const HEADLINE_CLASS = Object.freeze({
  neutral: 'text-white',
  working: 'text-white',
  attention: 'text-amber-50',
  problem: 'text-red-100',
});
const STEP_CLASS = Object.freeze({
  done: 'border-emerald-400/40 bg-emerald-500/15 text-emerald-100',
  current: 'border-violet-300/60 bg-violet-500/25 text-white',
  upcoming: 'border-white/10 bg-transparent text-white/45',
});

function bridgeApi() {
  try { return globalThis.window?.electronAPI || null; } catch { return null; }
}

function invoke(method) {
  try {
    const api = bridgeApi();
    const fn = api?.[method];
    if (typeof fn !== 'function') return Promise.resolve({ success: false, code: 'UNAVAILABLE' });
    return Promise.resolve(fn.call(api)).then(
      result => (result && typeof result === 'object' && result.success === false
        ? { success: false, code: typeof result.code === 'string' ? result.code : 'INTERNAL' }
        : {
          success: true,
          // Main decides whether the press re-copied the same starter.
          recopied: result?.recopied === true,
          chatOrdinal: Number.isInteger(result?.chatOrdinal) ? result.chatOrdinal : 0,
        }),
      () => ({ success: false, code: 'INTERNAL' }),
    );
  } catch {
    return Promise.resolve({ success: false, code: 'INTERNAL' });
  }
}

export function BridgeProgress({ status, item }) {
  const [now, setNow] = useState(() => Date.now());
  const [notice, setNotice] = useState('');
  const [confirmNew, setConfirmNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);
  // Set synchronously so a second click in the same tick is refused before
  // React has re-rendered the button as disabled.
  const busyRef = useRef(false);

  const jobs = Array.isArray(status?.queue?.jobs) ? status.queue.jobs : [];
  const job = jobs.find(entry => entry?.jobId === item?.jobId) || null;
  const chat = status?.chat && typeof status.chat === 'object' ? status.chat : {};
  const pluginName = status?.config?.pluginName;
  const view = deriveBridgeJobProgress({ job, chat, item, now, bridge: { paused: status?.paused === true, pluginName } });
  const lines = progressTimeLines(view, now);
  const ticking = view.since !== null || view.lastHeard !== null;

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

  // The panel's gate for both chat buttons.
  const canStartChat = status?.enabled === true && status?.serving === 'live' && status?.paused !== true
    && status?.setup?.tunnelReachable === true && status?.setup?.linked === true;
  const chatSummary = describeChat(chat, now);
  const requestNewChat = () => {
    const referenceNow = now || status?.at || 0;
    const age = Number.isFinite(chat.lastCallAt) && referenceNow >= chat.lastCallAt
      ? referenceNow - chat.lastCallAt
      : Infinity;
    // An unused chat (no call yet) is never ended by a starter press: main
    // hands back the same starter, so there is nothing to confirm.
    if (chat.ordinal && chat.state !== 'awaiting-first-call' && age < 120000) setConfirmNew(true);
    else void run('handoffBridgeNewChat', BRIDGE_PROGRESS_COPY.copiedNew(pluginName));
  };
  const onAction = () => {
    if (busyRef.current) return;
    if (view.action === 'continue-chat') void run('handoffBridgeContinueChat', BRIDGE_PROGRESS_COPY.copiedContinue);
    else if (view.action === 'start-chat') requestNewChat();
  };
  const actionDisabled = busy || !canStartChat || (view.action === 'continue-chat' && !chatSummary.ordinal);
  const toneLabel = BRIDGE_PROGRESS_COPY.toneLabel[view.tone];

  return (
    <section
      aria-label={BRIDGE_PROGRESS_COPY.region}
      data-progress-kind={view.kind}
      className={`min-w-0 rounded-lg border px-3 py-3 text-xs leading-relaxed ${TONE_CLASS[view.tone] || TONE_CLASS.neutral}`}
    >
      <ol aria-label={BRIDGE_PROGRESS_COPY.stepper} className="flex flex-wrap items-center gap-1.5">
        {view.steps.map((step, index) => (
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

      <div role="status" aria-live="polite" aria-atomic="true" className="mt-2.5">
        <div className={`font-semibold ${HEADLINE_CLASS[view.tone] || 'text-white'}`}>
          {toneLabel ? <span className="mr-1.5 text-[10px] font-semibold uppercase tracking-wide opacity-75">{toneLabel}</span> : null}
          {view.headline}
        </div>
        <div className="mt-1 text-white/70">{view.detail}</div>
      </div>

      {(lines.elapsed || lines.heard) && (
        <p className="mt-2 text-[11px] text-white/50">
          {[lines.elapsed, lines.heard].filter(Boolean).join(' · ')}
        </p>
      )}

      {view.action && (
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

      {confirmNew && (
        <ConfirmDialog
          title={BRIDGE_UI_COPY.confirmNewTitle}
          message={BRIDGE_UI_COPY.confirmNewMessage(chatSummary.ordinal, chatSummary.lastCall || BRIDGE_UI_COPY.recently)}
          confirmLabel={BRIDGE_UI_COPY.confirmNew}
          cancelLabel={BRIDGE_UI_COPY.keepChat(chatSummary.ordinal)}
          onConfirm={() => {
            if (busyRef.current) return;
            setConfirmNew(false);
            void run('handoffBridgeNewChat', BRIDGE_PROGRESS_COPY.copiedNew(pluginName));
          }}
          onCancel={() => setConfirmNew(false)}
        />
      )}
    </section>
  );
}
