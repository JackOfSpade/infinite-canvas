import React from 'react';
import './interviewWindow.css';
import { glanceCueOf } from '../utils/interviewGlanceCue.js';

// eslint-disable-next-line react-refresh/only-export-components
export function hasPreparedAnswer(card) {
  return card && !['needs-prep', 'empty'].includes(card.status) && Boolean(card.headline?.trim() || card.bullets?.some(item => item.text?.trim()) || (typeof card.example === 'string' ? card.example.trim() : card.example?.text?.trim()));
}

// eslint-disable-next-line react-refresh/only-export-components
export function normalizeAnswerCard(card) {
  return { ...card, bullets: card.bullets || [], example: typeof card.example === 'string' ? { text: card.example, evidenceIds: [] } : card.example || { text: '', evidenceIds: [] }, evidence: card.evidence || [], optionalExtension: card.optionalExtension || card.extensions || [] };
}

/** The short reminder shown for one prepared line; the full line stays in its title. */
function Cue({ text, cue }) {
  return <span className="glance-cue" title={text}>{glanceCueOf(text, cue)}</span>;
}

/**
 * The cues for one prepared answer, and nothing else: the headline reminder,
 * then one line per bullet and one for the example. No labels, citations or
 * optional points. Every extra word costs glance time in a live interview.
 * Renders nothing for a question that has no prepared answer.
 */
export function PreparedAnswer({ card: rawCard }) {
  if (!hasPreparedAnswer(rawCard)) return null;
  const card = normalizeAnswerCard(rawCard);
  // A thin required card may reuse its headline as its example; say it once.
  const example = card.example.text?.trim() && card.example.text.trim() !== (card.headline || '').trim() ? card.example : null;
  return <section className="spoken-answer" aria-label="Cues">
    {card.headline?.trim() && <h2 title={card.headline}><span className="answer-headline-text">{glanceCueOf(card.headline, card.headlineCue)}</span></h2>}
    <ul className="spoken-bullets">
      {card.bullets.filter(bullet => bullet.text?.trim()).map((bullet, index) => <li key={index}><Cue text={bullet.text} cue={bullet.cue} /></li>)}
      {example && <li className="glance-example"><Cue text={example.text} cue={example.cue} /></li>}
    </ul>
  </section>;
}

export default PreparedAnswer;
