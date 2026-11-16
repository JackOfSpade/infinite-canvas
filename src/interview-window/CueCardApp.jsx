import React, { useEffect, useState } from 'react';
import './interviewWindow.css';
import './interviewWindowRoot.css';
import { hasPreparedAnswer, PreparedAnswer } from './PreparedAnswer.jsx';

const RETRY_LISTEN_MS = 3000;
const MAX_LISTEN_RETRIES = 20;

/**
 * The cue card: read in a glance during a live interview, never operated.
 * It shows the cues for the question being asked and nothing else. No
 * controls, labels, status or errors: a blank card means "answer freely".
 * Opening it starts listening to the call and closing it stops. Everything it
 * hears and decides goes to the session log for review after the interview.
 */
export function CueCardApp() {
  const [display, setDisplay] = useState(null);

  useEffect(() => {
    const api = window.interviewAPI;
    let alive = true;
    const cleanup = api?.onBriefUpdated?.(value => { if (alive && value) setDisplay(value); });
    Promise.resolve().then(() => api?.getBrief?.()).then(value => { if (alive && value) setDisplay(current => current || value); }).catch(() => {});
    return () => { alive = false; cleanup?.(); };
  }, []);

  // Listening belongs to the open card: it starts here and is retried quietly
  // if it stops; closing the window (or unloading this page) ends it.
  useEffect(() => {
    const api = window.interviewAPI;
    if (typeof api?.startListening !== 'function') return undefined;
    let alive = true;
    let retries = 0;
    let timer = null;
    const start = () => { Promise.resolve().then(() => api.startListening()).then(state => react(state)).catch(() => react({ status: 'error' })); };
    const react = (state) => {
      if (!alive) return;
      if (state?.status === 'listening') { retries = 0; return; }
      if ((state?.status === 'error' || state?.status === 'idle') && timer === null && retries < MAX_LISTEN_RETRIES) {
        retries += 1;
        timer = setTimeout(() => { timer = null; if (alive) start(); }, RETRY_LISTEN_MS);
      }
    };
    const cleanup = api.onListeningUpdated?.(react);
    start();
    return () => {
      alive = false;
      if (timer !== null) clearTimeout(timer);
      cleanup?.();
      Promise.resolve().then(() => api.stopListening?.()).catch(() => {});
    };
  }, []);

  // A confident guess for the question now being asked replaces the previous
  // answer at once; otherwise the answer matched to the last question stays.
  const card = display?.preview?.card || display?.answerCard || null;
  return <main className="interview-window cue-card">
    {hasPreparedAnswer(card) && <PreparedAnswer key={card.id} card={card} />}
  </main>;
}

export default CueCardApp;
