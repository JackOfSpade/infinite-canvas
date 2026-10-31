import React, { useEffect, useRef, useState } from 'react';
import { interviewIgnoredMessage } from './submitError.js';

// Failures that can happen mid-interview get a glanceable chip; the full
// explanation stays one click away. Setup errors keep their full sentence.
const GLANCE_ERRORS = Object.freeze({
  'capture-failed': 'Audio stopped · retry Listen',
  'recognition-failed': 'Transcription stopped · retry',
  'lookup-failed': 'Match failed · type it',
});
const IDLE = { status: 'idle', transcript: '', question: '', errorCode: null, message: '' };
const AUDIO_FAILED = 'Listening is unavailable. Try Listen again, or type the question below.';

export default function CallAudioPanel({ onDisplay }) {
  const [audio, setAudio] = useState(IDLE);
  const [usingQuestion, setUsingQuestion] = useState(false);
  const [useError, setUseError] = useState('');
  const actionVersion = useRef(0);
  const alive = useRef(true);
  const using = useRef(false);
  const panel = useRef(null);
  const liveStrip = useRef(null);
  const running = audio.status === 'starting' || audio.status === 'listening';

  useEffect(() => {
    alive.current = true;
    const api = window.interviewAPI;
    const version = actionVersion.current;
    let receivedUpdate = false;
    const cleanup = api?.onListeningUpdated?.(value => {
      receivedUpdate = true;
      if (alive.current) setAudio(value || IDLE);
    });
    Promise.resolve().then(() => api?.getListeningState?.()).then(value => {
      if (alive.current && !receivedUpdate && version === actionVersion.current && value) setAudio(value);
    }).catch(() => { /* Listening is optional; a status lookup never blocks typing. */ });
    return () => {
      alive.current = false;
      actionVersion.current += 1;
      cleanup?.();
      // Main also owns native-window teardown. Release immediately on a page unload.
      Promise.resolve().then(() => api?.stopListening?.()).catch(() => {});
    };
  }, []);

  // The card can appear without remounting listening. Reconnect after each
  // render so its new nav is measured, then track wrapping, fonts and resizing.
  useEffect(() => {
    const main = panel.current?.closest('.interview-window');
    const nav = main?.querySelector('nav');
    if (!main?.classList.contains('has-answer')) {
      main?.style.removeProperty('--listening-strip-height');
      main?.style.removeProperty('--answer-nav-height');
      return;
    }
    const measure = () => {
      for (const [element, variable] of [[liveStrip.current, '--listening-strip-height'], [nav, '--answer-nav-height']]) {
        const height = Math.ceil(element?.getBoundingClientRect().height || 0);
        if (height) main.style.setProperty(variable, `${height}px`);
      }
    };
    measure();
    const observer = typeof window.ResizeObserver === 'function' ? new window.ResizeObserver(measure) : null;
    if (liveStrip.current) observer?.observe(liveStrip.current);
    if (nav) observer?.observe(nav);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  });

  const toggle = async () => {
    const stop = running;
    const version = ++actionVersion.current;
    setUseError('');
    setAudio(stop ? IDLE : { ...IDLE, status: 'starting' });
    try {
      const api = window.interviewAPI;
      if (typeof (stop ? api?.stopListening : api?.startListening) !== 'function') throw new Error('unavailable');
      const value = await (stop ? api.stopListening() : api.startListening());
      if (alive.current && version === actionVersion.current && value) setAudio(value);
    } catch {
      if (alive.current && version === actionVersion.current) setAudio({ ...IDLE, status: 'error', message: AUDIO_FAILED });
    }
  };

  const useQuestion = async () => {
    if (using.current || !audio.question) return;
    using.current = true;
    setUsingQuestion(true);
    setUseError('');
    try {
      const display = await window.interviewAPI.useTranscriptQuestion();
      // Capture controls only govern audio. An explicit question request still
      // deserves its answer or explanation after the user stops listening.
      if (alive.current && display) {
        if (display.ignored) setUseError(interviewIgnoredMessage(display));
        else onDisplay?.(display);
      }
    } catch {
      if (alive.current) setUseError('This transcript could not be checked. Type or edit the question below.');
    } finally {
      using.current = false;
      if (alive.current) setUsingQuestion(false);
    }
  };

  const label = audio.status === 'listening' ? 'Listening' : audio.status === 'starting' ? 'Preparing to listen…' : audio.status === 'error' ? 'Listening unavailable' : 'Listen to call audio';
  const lastTranscriptLine = audio.transcript?.split(/\r?\n/u).filter(line => line.trim()).at(-1) || '';
  return <section ref={panel} className="call-audio" aria-label="Call audio listening" data-listening-status={audio.status}>
    <div ref={liveStrip} className="call-audio-live" aria-label="Live listening controls">
    <div className="call-audio-controls"><p className="call-audio-status" role="status"><span className="call-audio-dot" aria-hidden="true" />{label}</p><button type="button" aria-pressed={running} onClick={toggle}>{running ? 'Stop listening' : 'Listen'}</button></div>
    {audio.status === 'starting' && <p className="call-audio-help">{audio.message || 'Preparing on-device speech and requesting system audio access…'}</p>}
    {audio.status !== 'starting' && audio.status !== 'error' && audio.message && <p className="call-audio-help" role="status">{audio.message}</p>}
    {audio.status === 'error' && (GLANCE_ERRORS[audio.errorCode]
      ? <div className="call-audio-error" role="alert"><p className="glance-chip glance-chip-warn">{GLANCE_ERRORS[audio.errorCode]}</p><details className="glance-why"><summary>Why?</summary><p>{audio.message || AUDIO_FAILED}</p></details></div>
      : <p className="call-audio-error" role="alert">{audio.message || AUDIO_FAILED}</p>)}
    {audio.transcript && <div className="call-audio-preview"><p className="call-audio-transcript" aria-label="Live transcript" title={audio.transcript}>{lastTranscriptLine}</p><button type="button" className="call-audio-use" disabled={usingQuestion || !audio.question} onClick={useQuestion}>{usingQuestion ? 'Checking transcript…' : 'Use this question'}</button></div>}
    {useError && <p className="call-audio-error" role="alert">{useError}</p>}
    </div>
    <p className="call-audio-privacy">System output only · microphone excluded · on-device transcription</p>
    <details className="call-audio-guidance"><summary>Listening & permissions</summary><p>Listen automatically advances cards when it detects a new interviewer question. It hears other apps too; pause unrelated media. Your call’s playback and microphone keep working normally.</p><p>First use may download Apple’s English speech model before listening starts. Audio and transcript stay on this Mac and are cleared when listening stops.</p><p>If macOS asks, allow Infinite Canvas / Interview Audio Helper in System Settings → Privacy & Security → Screen & System Audio Recording. The screen category also covers this output-audio tap; no screen images are recorded. Enable access and retry Listen. If macOS requires a restart, keep typing and restart later.</p></details>
  </section>;
}
