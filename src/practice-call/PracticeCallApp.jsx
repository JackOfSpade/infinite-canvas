import React, { useEffect, useState } from 'react';
import ConsentScreen from './ConsentScreen.jsx';
import DownloadingScreen from './DownloadingScreen.jsx';
import PrecheckScreen from './PrecheckScreen.jsx';
import IncomingCall from './IncomingCall.jsx';
import ConnectingScreen from './ConnectingScreen.jsx';
import InCall from './InCall.jsx';
import EndedScreen from './EndedScreen.jsx';
import Replay from './Replay.jsx';
import ErrorScreen from './ErrorScreen.jsx';
import { MISSING_PRELOAD, mergeEvent, mergeState } from './callModel.js';

function readApi() {
  return typeof window === 'undefined' ? null : window.practiceCallAPI || null;
}

// A window without the preload has no main process to talk to; that is known
// before the first render, so it is the initial state instead of an effect write.
const initialState = () => (typeof readApi()?.getState === 'function' ? null : MISSING_PRELOAD);

export default function PracticeCallApp() {
  const [state, setState] = useState(initialState);
  const [replay, setReplay] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const api = readApi();
    if (typeof api?.getState !== 'function') return undefined;
    let live = true;
    const apply = value => { if (live && value && typeof value === 'object') setState(previous => mergeState(previous, value)); };
    const offState = typeof api.onState === 'function' ? api.onState(apply) : null;
    const offEvent = typeof api.onEvent === 'function' ? api.onEvent(event => { if (live) setState(previous => mergeEvent(previous, event)); }) : null;
    try {
      const initial = api.getState();
      if (initial && typeof initial.then === 'function') initial.then(apply).catch(() => { if (live) setState(previous => mergeState(previous, MISSING_PRELOAD)); });
      else apply(initial);
    } catch { Promise.resolve().then(() => { if (live) setState(previous => mergeState(previous, MISSING_PRELOAD)); }); }
    return () => {
      live = false;
      if (typeof offState === 'function') offState();
      if (typeof offEvent === 'function') offEvent();
    };
  }, []);

  const phase = state?.phase;
  useEffect(() => {
    if (phase !== 'replay') return undefined;
    const api = readApi();
    if (typeof api?.getReplay !== 'function') return undefined;
    let live = true;
    const load = () => {
      try {
        Promise.resolve(api.getReplay()).then(value => { if (live && value && typeof value === 'object') setReplay(value); })
          .catch(() => { if (live) setReplay({ audioUrl: null, durationMs: 0, transcript: [], chapters: [], feedback: null, analysis: { status: 'failed', error: 'The replay could not be loaded.' } }); });
      } catch { if (live) setReplay({ audioUrl: null, durationMs: 0, transcript: [], chapters: [], feedback: null, analysis: { status: 'failed', error: 'The replay could not be loaded.' } }); }
    };
    load();
    const off = typeof api.onReplayUpdated === 'function' ? api.onReplayUpdated(load) : null;
    return () => { live = false; if (typeof off === 'function') off(); };
  }, [phase]);

  const invoke = (name, ...args) => {
    const api = readApi();
    const fn = api?.[name];
    if (typeof fn !== 'function') return undefined;
    try { return fn(...args); } catch { return undefined; }
  };
  const agree = async () => {
    setBusy(true);
    try { await invoke('agreeModelDownload'); } catch { /* the state subscription reports failures */ } finally { setBusy(false); }
  };

  if (!state) {
    return <main role="status" aria-live="polite" aria-label="Loading practice call" className="grid min-h-screen place-items-center bg-[#111018] text-[11px] text-violet-100">Loading practice call…</main>;
  }
  switch (state.phase) {
    case 'consent': return <ConsentScreen onAgree={agree} busy={busy} />;
    case 'downloading': return <DownloadingScreen download={state.modelDownload} />;
    case 'precheck': return <PrecheckScreen level={state.level} usageWarning={state.usageWarning} persona={state.persona} />;
    case 'ringing': return <IncomingCall persona={state.persona} onAnswer={() => invoke('answer')} onDecline={() => invoke('hangUp')} />;
    case 'connecting': return <ConnectingScreen persona={state.persona} />;
    case 'in-call': return <InCall state={state} api={{
      setMuted: value => invoke('setMuted', value),
      hangUp: () => invoke('hangUp'),
      getPreparedCards: () => invoke('getPreparedCards'),
      sendChat: text => invoke('sendChat', text),
      setTyping: value => invoke('setTyping', value),
    }} />;
    case 'ended':
    case 'analyzing': return <EndedScreen state={state} />;
    case 'replay': return <Replay replay={replay} api={{ deleteRecording: () => invoke('deleteRecording') }} />;
    case 'error': return <ErrorScreen error={state.error} onClose={() => invoke('close')} />;
    default: return <ErrorScreen error={state.error || { code: 'unknown-phase', message: `The call window received an unknown phase (${String(state.phase)}).` }} onClose={() => invoke('close')} />;
  }
}

export { PracticeCallApp };
