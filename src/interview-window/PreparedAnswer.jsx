import React, { useRef } from 'react';
import './interviewWindow.css';
import { InterviewQaBadges } from '../components/InterviewQaBadges';

// eslint-disable-next-line react-refresh/only-export-components
export function hasPreparedAnswer(card) {
  return card && !['needs-prep', 'empty'].includes(card.status) && Boolean(card.headline?.trim() || card.bullets?.some(item => item.text?.trim()) || (typeof card.example === 'string' ? card.example.trim() : card.example?.text?.trim()));
}

// eslint-disable-next-line react-refresh/only-export-components
export function normalizeAnswerCard(card) {
  return { ...card, bullets: card.bullets || [], example: typeof card.example === 'string' ? { text: card.example, evidenceIds: [] } : card.example || { text: '', evidenceIds: [] }, evidence: card.evidence || [], optionalExtension: card.optionalExtension || card.extensions || [] };
}

export const EXTENSION_CAUTION = 'Optional, bring in only if you can back it with an example';

// eslint-disable-next-line react-refresh/only-export-components
export const answerStageLabels = { situation: 'Situation', task: 'Task', action: 'Action', result: 'Result', reflection: 'Reflection' };

export function AnswerCitations({ evidenceIds, sourceNumbers, showSource }) {
  return <span className="answer-citation-refs">{(evidenceIds || []).filter(id => sourceNumbers.has(id)).map(id => <button key={id} type="button" className="answer-citation-ref" onClick={() => showSource(id)} aria-label={`Show exact cited evidence ${sourceNumbers.get(id)}`}>[{sourceNumbers.get(id)}]</button>)}</span>;
}

export function PreparedAnswer({ card: rawCard, headingRef, mode = 'recall', provisionalConfidence }) {
  const evidenceDetails = useRef(null);
  const sourceItems = useRef(new Map());
  const card = normalizeAnswerCard(rawCard);
  if (!hasPreparedAnswer(rawCard)) {
    return <section className="spoken-answer no-prepared-answer" aria-label="Prepared spoken answer">
      <p className="eyebrow">Your prepared answer</p>
      <h2 ref={headingRef} tabIndex={-1}>{card.question}</h2>
      <InterviewQaBadges card={card} />
      <p className="no-answer-text" role="status">No prepared answer yet</p>
      <p className="keyboard-help">Answer in your own words. Add an answer in Edit Q&A before your next interview.</p>
    </section>;
  }
  const sourceNumbers = new Map(card.evidence.map((item, index) => [item.id, index + 1]));
  const showSource = id => {
    if (evidenceDetails.current) evidenceDetails.current.open = true;
    sourceItems.current.get(id)?.focus();
  };
  const citations = ids => <AnswerCitations evidenceIds={ids} sourceNumbers={sourceNumbers} showSource={showSource} />;
  // Continuation mode keeps the memorized material intact, but puts the next
  // useful action/outcome ahead of background while the person is speaking.
  const continuation = mode === 'continuation';
  const priority = { action: 0, result: 1, point: 2, reflection: 3, task: 4, situation: 5 };
  const bullets = continuation ? card.bullets.map((bullet, index) => ({ bullet, index }))
    .sort((left, right) => (priority[left.bullet.stage] ?? 2) - (priority[right.bullet.stage] ?? 2) || left.index - right.index)
    .map(item => item.bullet) : card.bullets;
  const extensions = Array.isArray(card.optionalExtension) ? card.optionalExtension : [];
  const provisional = typeof provisionalConfidence === 'number';
  return <section className={`spoken-answer${continuation ? ' continuation-answer' : ''}${provisional ? ' provisional-answer' : ''}`} aria-label="Prepared spoken answer" data-answer-layout={mode}>
    <section className="prepared-answer-recall" aria-label="Your prepared answer">
    <p className="eyebrow" ref={continuation ? headingRef : undefined} tabIndex={continuation ? -1 : undefined}>Your prepared answer{provisional && <span className="preview-badge">Likely · {Math.round(provisionalConfidence * 100)}%</span>}</p>
    {continuation && <p className="continuation-guidance">Keep going in your own words. Glance at a cue when ready.</p>}
    {card.thinEvidence && <p className="answer-thin-evidence" role="status">Thin evidence</p>}
    <h2 ref={continuation ? undefined : headingRef} tabIndex={-1}><span className="answer-headline-text" key={card.id}>{card.headline}</span>{citations(card.headlineEvidenceIds)}</h2>
    <ul className="spoken-bullets">{bullets.map((bullet, index) => <li key={index}>{answerStageLabels[bullet.stage] && <span className="answer-stage">{answerStageLabels[bullet.stage]}</span>}<span>{bullet.text}</span>{citations(bullet.evidenceIds)}</li>)}</ul>
    <details className="spoken-example"><summary>Concrete example</summary><p>{card.example.text}{citations(card.example.evidenceIds)}</p></details>
    </section>
    {extensions.length > 0 && <details className="optional-extension" aria-label="Optional extension"><summary>Optional extension</summary>
    <p className="extension-caution">{EXTENSION_CAUTION}</p>
    <ul className="extension-points">{extensions.map((point, index) => <li key={point.id || index}><span>{point.text}</span>{citations(point.evidenceIds)}{point.exampleHook && <small className="extension-example-hook">Example hook: {point.exampleHook}</small>}</li>)}</ul>
    </details>}
    <details className="answer-evidence" ref={evidenceDetails}><summary>Exact cited evidence</summary><ol>{card.evidence.map((item, index) => <li key={item.id} tabIndex={-1} data-citation-number={index + 1} ref={element => { if (element) sourceItems.current.set(item.id, element); else sourceItems.current.delete(item.id); }}><small>{item.sourceLabel}</small><blockquote>{item.quote}</blockquote></li>)}</ol></details>
    {card.consistency && <details className="answer-consistency"><summary>{card.consistency.consistentWithResume ? 'Consistent with submitted résumé · cited wording' : 'Submitted résumé consistency is unconfirmed'}</summary>{card.consistency.resumeQuote && <blockquote>{card.consistency.resumeQuote}</blockquote>}<p>Checks the cited wording. This is not a review of every résumé claim.</p></details>}
  </section>;
}

export default PreparedAnswer;
