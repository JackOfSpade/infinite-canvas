import React from 'react';
import './interviewWindow.css';
import { glanceCueOf } from '../utils/interviewGlanceCue.js';

/**
 * No card shows more than three bullets. The card is read in a glance to pick
 * a direction; a fourth line costs reading time and makes it harder to find
 * one real example that fits everything shown. The rest stays in Edit Q&A.
 */
export const CUE_CARD_MAX_LINES = 3;

const approachOf = card => (Array.isArray(card?.approach) ? card.approach : []).filter(item => typeof item?.text === 'string' && item.text.trim());

// eslint-disable-next-line react-refresh/only-export-components
export function hasPreparedAnswer(card) {
  if (!card) return false;
  // Approach reminders need no prepared answer of their own.
  if (approachOf(card).length) return true;
  return !['needs-prep', 'empty'].includes(card.status) && Boolean(card.headline?.trim() || card.bullets?.some(item => item.text?.trim()) || (typeof card.example === 'string' ? card.example.trim() : card.example?.text?.trim()));
}

// eslint-disable-next-line react-refresh/only-export-components
export function normalizeAnswerCard(card) {
  return { ...card, bullets: card.bullets || [], example: typeof card.example === 'string' ? { text: card.example, evidenceIds: [] } : card.example || { text: '', evidenceIds: [] }, evidence: card.evidence || [], optionalExtension: card.optionalExtension || card.extensions || [] };
}

/** One reminder of a prepared line; the full line stays in its hover title. */
function CueLine({ line, recentEmployer }) {
  return <li className={line.kind}><span className="glance-cue" title={line.text}>{glanceCueOf(line.text, line.cue, recentEmployer)}</span></li>;
}

/**
 * The cues for one prepared answer, and nothing else, as one bullet list in a
 * single type size. No labels, citations or optional points. Every extra word
 * costs glance time in a live interview.
 *
 * A "how do you work" card shows its approach reminders, each with the one
 * prepared line chosen as its real example nested under it. That is the only
 * nesting: a nested line is always an instance of the bullet above it.
 * Every other card shows its first three prepared lines (headline, then
 * points, then the example if there is room) as sibling bullets, because
 * separate prepared lines are separate stories.
 * Renders nothing for a question with no prepared answer.
 */
export function PreparedAnswer({ card: rawCard }) {
  if (!hasPreparedAnswer(rawCard)) return null;
  const card = normalizeAnswerCard(rawCard);
  const recentEmployer = card.recentEmployer || '';
  // A thin required card may reuse its headline as its example; say it once.
  const example = card.example.text?.trim() && card.example.text.trim() !== (card.headline || '').trim() ? card.example : null;
  const lines = [
    ...(card.headline?.trim() ? [{ kind: 'answer-headline', text: card.headline, cue: card.headlineCue }] : []),
    ...card.bullets.filter(bullet => bullet.text?.trim()).map(bullet => ({ kind: 'answer-point', text: bullet.text, cue: bullet.cue })),
    ...(example ? [{ kind: 'glance-example', text: example.text, cue: example.cue }] : []),
  ];
  const approach = approachOf(card).slice(0, CUE_CARD_MAX_LINES);
  if (approach.length) {
    // One real example at most: the first reminder that has one.
    const instanceOf = item => (typeof item.example === 'string' && item.example ? lines.find(line => line.text.trim() === item.example.trim()) : null);
    const withInstance = approach.find(instanceOf);
    return <section className="spoken-answer" aria-label="Cues">
      <ul className="spoken-bullets">{approach.map((item, index) => {
        const instance = item === withInstance ? instanceOf(item) : null;
        return <li key={index} className="answer-approach"><span className="glance-cue">{item.text.trim()}</span>{instance && <ul><CueLine line={instance} recentEmployer={recentEmployer} /></ul>}</li>;
      })}</ul>
    </section>;
  }
  return <section className="spoken-answer" aria-label="Cues">
    <ul className="spoken-bullets">{lines.slice(0, CUE_CARD_MAX_LINES).map((line, index) => <CueLine key={index} line={line} recentEmployer={recentEmployer} />)}</ul>
  </section>;
}

export default PreparedAnswer;
