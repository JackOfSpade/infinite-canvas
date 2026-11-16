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

/** One reminder; the full prepared line stays in its hover title. */
function CueLine({ line }) {
  return <li className={line.kind}><span className="glance-cue" title={line.text}>{glanceCueOf(line.text, line.cue)}</span></li>;
}

/**
 * The cues for one prepared answer, and nothing else, as one bullet list in a
 * single type size: the headline, each point and the example are sibling
 * bullets. Separate prepared lines are separate stories, so none is nested
 * under another. No labels, citations or optional points. Every extra word
 * costs glance time in a live interview. Renders nothing for a question with
 * no prepared answer.
 */
export function PreparedAnswer({ card: rawCard }) {
  if (!hasPreparedAnswer(rawCard)) return null;
  const card = normalizeAnswerCard(rawCard);
  // A thin required card may reuse its headline as its example; say it once.
  const example = card.example.text?.trim() && card.example.text.trim() !== (card.headline || '').trim() ? card.example : null;
  const lines = [
    ...(card.headline?.trim() ? [{ kind: 'answer-headline', text: card.headline, cue: card.headlineCue }] : []),
    ...card.bullets.filter(bullet => bullet.text?.trim()).map(bullet => ({ kind: 'answer-point', text: bullet.text, cue: bullet.cue })),
    ...(example ? [{ kind: 'glance-example', text: example.text, cue: example.cue }] : []),
  ];
  return <section className="spoken-answer" aria-label="Cues">
    <ul className="spoken-bullets">{lines.map((line, index) => <CueLine key={index} line={line} />)}</ul>
  </section>;
}

export default PreparedAnswer;
