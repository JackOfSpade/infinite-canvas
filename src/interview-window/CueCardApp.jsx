import React, { useEffect, useState } from 'react';
import './interviewWindow.css';
import './interviewWindowRoot.css';
import { CUE_CARD_MAX_LINES, hasPreparedAnswer, PreparedAnswer } from './PreparedAnswer.jsx';

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
  // A question no prepared card answers: generic talking points, written live
  // with no career data, that the person illustrates with their own example.
  const points = !card && !display?.preview && Array.isArray(display?.talkingPoints) ? display.talkingPoints.map(item => (typeof item === 'string' ? { text: item, sub: [] } : item)).filter(item => typeof item?.text === 'string' && item.text.trim()).slice(0, CUE_CARD_MAX_LINES) : [];
  return <main className="interview-window cue-card">
    {hasPreparedAnswer(card) && <PreparedAnswer key={card.id} card={card} />}
    {points.length > 0 && <section className="spoken-answer" aria-label="Cues"><ul className="spoken-bullets">{points.map((point, index) => {
      // Sub points explain the point above them; read only when there is time.
      const sub = (Array.isArray(point.sub) ? point.sub : []).filter(line => typeof line === 'string' && line.trim());
      return <li key={index} className="answer-approach"><span className="glance-cue">{point.text}</span>{sub.length > 0 && <ul>{sub.map((line, at) => <li key={at}><span className="glance-cue">{line}</span></li>)}</ul>}</li>;
    })}</ul></section>}
  </main>;
}

export default CueCardApp;
