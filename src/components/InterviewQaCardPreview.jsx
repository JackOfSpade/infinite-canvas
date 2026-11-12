import React, { useState } from 'react';
import { exactInterviewAnswerMatch } from '../utils/interviewAnswerMatching.js';
import PreparedAnswer from '../interview-window/PreparedAnswer.jsx';

const inputClass = 'mt-1 w-full rounded-md border border-[var(--border-main)] bg-[var(--bg-input)] px-2 py-1.5 text-xs text-[var(--text-main)]';

const statementOf = value => typeof value === 'string' ? value : (typeof value?.text === 'string' ? value.text : '');
const evidenceIdsOf = value => Array.isArray(value?.evidenceIds) ? value.evidenceIds : [];

/** The main process's stored-card projection, mirrored locally for the editor. */
// eslint-disable-next-line react-refresh/only-export-components
export function qaCardToDisplayCard(card, scope) {
  const source = card || {};
  const headline = statementOf(source.headline);
  const bullets = (Array.isArray(source.bullets) ? source.bullets : [])
    .filter(item => statementOf(item).trim())
    .map(item => ({ stage: typeof item?.stage === 'string' && item.stage ? item.stage : 'point', text: statementOf(item), evidenceIds: evidenceIdsOf(item) }));
  const example = { text: statementOf(source.example), evidenceIds: evidenceIdsOf(source.example) };
  const optionalExtension = (Array.isArray(source.extensions) ? source.extensions : [])
    .filter(item => statementOf(item).trim())
    .map((item, index) => ({ id: typeof item?.id === 'string' && item.id ? item.id : `ext-${index + 1}`, text: statementOf(item), exampleHook: '', sourceLabel: '', evidenceIds: evidenceIdsOf(item) }));
  const origin = source.origin || 'catalog';
  const answered = Boolean(headline.trim()) || bullets.length > 0 || Boolean(example.text.trim());
  return {
    id: source.id,
    question: source.question,
    headline,
    headlineEvidenceIds: evidenceIdsOf(source.headline),
    bullets,
    example,
    optionalExtension,
    consistency: { consistentWithResume: source.consistency?.consistentWithResume === true, resumeQuote: String(source.consistency?.resumeQuote || '') },
    evidence: [],
    scope: scope === 'foundation' ? 'foundation' : 'company',
    origin,
    source: source.source && typeof source.source.url === 'string' ? { url: source.source.url, date: String(source.source.date || 'unknown'), quote: String(source.source.quote || '') } : null,
    author: source.author === 'user' ? 'user' : 'generated',
    status: answered ? 'ready' : origin === 'disclosed' ? 'needs-prep' : 'empty',
  };
}

const hasCitedEvidence = card => [card?.headline?.evidenceIds, card?.example?.evidenceIds,
  ...(Array.isArray(card?.bullets) ? card.bullets.map(item => item?.evidenceIds) : []),
  ...(Array.isArray(card?.extensions) ? card.extensions.map(item => item?.evidenceIds) : [])]
  .some(ids => Array.isArray(ids) && ids.length > 0);

/** The interview window's own answer card, rendered inside the main app. */
export function InterviewCardPreview({ card, scope }) {
  return <div className="space-y-1">
    <div className="interview-window interview-card-preview" data-testid="interview-card-preview">
      <PreparedAnswer card={qaCardToDisplayCard(card, scope)} />
    </div>
    {hasCitedEvidence(card) && <p className="text-[11px] text-[var(--text-muted)]">Cited evidence quotes appear in the live window.</p>}
  </div>;
}

/** Exact-only matcher preview: what the live window shows for this question. */
export function InterviewQaMatchTester({ foundationCards = [], companyCards = [], company = '' }) {
  const [question, setQuestion] = useState('');
  const candidates = [...foundationCards.map(card => ({ card, scope: 'foundation' })), ...companyCards.map(card => ({ card, scope: 'company' }))];
  const scopeOf = new Map(candidates.map(item => [item.card, item.scope]));
  const result = exactInterviewAnswerMatch(question, candidates.map(item => item.card));
  const scopeLabel = scope => scope === 'foundation' ? 'Foundation' : (company || 'Company');
  return <section aria-label="Preview on the interview card" className="space-y-2 rounded-lg border border-[var(--border-main)] p-3">
    <h3 className="text-sm font-semibold">Preview on the interview card</h3>
    <p className="text-xs text-[var(--text-muted)]">Exact question and variant matching only; the live window also uses AI matching.</p>
    <label className="block text-xs">Test a question<textarea className={inputClass} rows={2} placeholder="Type the question as the interviewer would ask it" value={question} onChange={event => setQuestion(event.target.value)} /></label>
    <p role="status" className="text-xs">{result.status === 'none' && 'No exact match. The live window\'s AI matching may still choose a card.'}
      {result.status === 'ambiguous' && `Matches ${result.cards.length} cards exactly — the live window will not pick one:`}
      {result.status === 'match' && `Exact match: ${result.card.question} · ${scopeLabel(scopeOf.get(result.card))}`}</p>
    {result.status === 'ambiguous' && <ul className="list-disc pl-4 text-xs text-[var(--text-muted)]">{result.cards.map((card, index) => <li key={`${card.id ?? 'card'}-${index}`}>{card.question}</li>)}</ul>}
    {result.status === 'match' && <InterviewCardPreview card={result.card} scope={scopeOf.get(result.card)} />}
  </section>;
}

export default InterviewCardPreview;
