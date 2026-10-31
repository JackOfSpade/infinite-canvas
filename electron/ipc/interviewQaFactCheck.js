/**
 * The application bundle's fact-check, applied to interview answer cards.
 *
 * Uses the shared career writing core (careerWritingCore.js): the same
 * inflation taxonomy, the same verbatim-span finding contract and validator,
 * and the application fact-check model profile (stage `qa-fact-check`). A
 * flagged claim is removed rather than rewritten, so no unvalidated text ever
 * enters the Q&A store: a flagged bullet or extension point is dropped, and a
 * flagged headline or example empties that card's answer (shown as "Empty" for
 * the user to write).
 */
import { careerFactFindingErrors, careerInflationRules } from './careerWritingCore.js';

const statementOf = value => (typeof value === 'string' ? value : value?.text || '');

/** Checkable units of the cards: `<cardId>.headline`, `.bullets[i]`, `.example`, `.extensions[i]`. */
export function interviewCardUnits(cards) {
  const units = new Map();
  for (const card of cards || []) {
    if (statementOf(card.headline).trim()) units.set(`${card.id}.headline`, { card, field: 'headline', text: statementOf(card.headline), evidenceIds: card.headline?.evidenceIds || [] });
    (card.bullets || []).forEach((item, index) => { if (statementOf(item).trim()) units.set(`${card.id}.bullets[${index}]`, { card, field: 'bullets', index, text: statementOf(item), evidenceIds: item?.evidenceIds || [] }); });
    if (statementOf(card.example).trim()) units.set(`${card.id}.example`, { card, field: 'example', text: statementOf(card.example), evidenceIds: card.example?.evidenceIds || [] });
    (card.extensions || []).forEach((item, index) => { if (statementOf(item).trim()) units.set(`${card.id}.extensions[${index}]`, { card, field: 'extensions', index, text: statementOf(item), evidenceIds: item?.evidenceIds || [] }); });
  }
  return units;
}

export function interviewFactCheckPrompt({ cards, evidence, company }) {
  const units = interviewCardUnits(cards);
  const cited = new Set([...units.values()].flatMap(unit => unit.evidenceIds));
  const quotes = (evidence || []).filter(item => cited.has(item.id)).map(item => ({ id: item.id, quote: item.text }));
  const target = typeof company === 'string' && company.trim() ? JSON.stringify(company.trim()) : 'the employer this interview is for';
  const listing = [...units.entries()].map(([id, unit]) => ({ id, text: unit.text, evidenceIds: unit.evidenceIds }));
  return `Compare every claim in the following interview answer units with its cited quotes. These are first-person spoken answers. ${careerInflationRules(target)} Each finding id must name the unit id; claim must be an exact verbatim span of that unit's text. Return JSON {findings:[{id,checkId,claim,quote,reason}]} with an empty findings array when every claim is supported. A finding id must be exactly one of the ids under CHECKABLE UNITS.\nCITED QUOTES:\n${JSON.stringify(quotes)}\nCHECKABLE UNITS:\n${JSON.stringify(listing)}`;
}

export const INTERVIEW_FACT_CHECK_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['findings'],
  properties: { findings: { type: 'array', maxItems: 60, items: {
    type: 'object', additionalProperties: false, required: ['id', 'checkId', 'claim', 'quote', 'reason'],
    properties: { id: { type: 'string' }, checkId: { type: 'string' }, claim: { type: 'string' }, quote: { type: 'string' }, reason: { type: 'string' } },
  } } },
});

/** Remove flagged claims; returns the cleaned cards and the findings applied. */
export function applyInterviewFactFindings(cards, findings) {
  const units = interviewCardUnits(cards);
  const flagged = new Map();
  for (const finding of findings || []) {
    const unit = units.get(finding?.id);
    if (!unit) continue;
    const entry = flagged.get(unit.card.id) || { emptyAnswer: false, bullets: new Set(), extensions: new Set() };
    if (unit.field === 'headline' || unit.field === 'example') entry.emptyAnswer = true;
    else entry[unit.field].add(unit.index);
    flagged.set(unit.card.id, entry);
  }
  return (cards || []).map(card => {
    const entry = flagged.get(card.id);
    if (!entry) return card;
    const empty = value => ({ text: '', evidenceIds: [], quotes: [], ...(value && typeof value === 'object' && value.stage ? { stage: value.stage } : {}) });
    if (entry.emptyAnswer) return { ...card, headline: empty(), bullets: [], example: empty(), extensions: [] };
    return {
      ...card,
      bullets: (card.bullets || []).filter((_, index) => !entry.bullets.has(index)),
      extensions: (card.extensions || []).filter((_, index) => !entry.extensions.has(index)),
    };
  });
}

/** Run the shared fact-check over generated cards and drop flagged claims. */
export async function factCheckInterviewCards({ cards, evidence, company, callText, signal }) {
  const units = interviewCardUnits(cards);
  if (!units.size) return { cards, findings: [] };
  const unitText = id => (typeof id === 'string' && units.has(id) ? units.get(id).text : null);
  const reply = await callText(interviewFactCheckPrompt({ cards, evidence, company }), {
    signal, task: 'interview-answer-bank', claudeStage: 'qa-fact-check', responseSchema: INTERVIEW_FACT_CHECK_SCHEMA,
    responseValidator: value => { const errors = careerFactFindingErrors(value?.findings, unitText); if (errors.length) throw new Error(errors.join(' | ')); },
  });
  const findings = Array.isArray(reply?.findings) ? reply.findings : [];
  return { cards: applyInterviewFactFindings(cards, findings), findings };
}
