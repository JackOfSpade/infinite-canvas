/** Conservative local lookup over the already validated, prepared questions. */
import { analyzeInterviewQuestion, extractLatestInterviewQuestion, interviewHelperTerms, rankInterviewEvidence } from './interviewHelper.js';
import { INTERVIEW_ANSWER_QUESTION_CATALOG } from './interviewAnswerQuestions.js';

const QUESTION_CATALOG = new Map(INTERVIEW_ANSWER_QUESTION_CATALOG.map(item => [item.question, item]));

function normalizedQuestion(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLocaleLowerCase().replace(/[.!?]+$/gu, '').replace(/\s+/gu, ' ')
    // These change only the request's delivery, never its topic or facts.
    .replace(/^(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:briefly\s+)?(?=(?:tell|describe|walk|explain|give|share)\b)/u, '')
    .replace(/^(tell me|describe|walk me|explain|give me|share) briefly\b/u, '$1')
    .replace(/\bprioritis(e|es|ed|ing|ation)\b/gu, 'prioritiz$1')
    .replace(/^how do you handle working\b/u, 'how do you work');
}

const SPECIFIC_COMPONENTS = ['decision', 'outcome', 'lesson'];
const QUESTION_SCAFFOLD = new Set(['explain', 'describe', 'discuss', 'walk', 'give', 'share']);
function numbers(value) { return value.match(/\d+(?:[.,]\d+)?%?/gu) || []; }

function singleDroppedOrTransposedLetter(left, right) {
  if (left.length < 5 || right.length < 5 || !/^[a-z]+$/u.test(left + right)) return false;
  // Substitutions can turn one real action into another (leaving/leading).
  // A one-letter omission/repetition or adjacent transposition is narrower.
  if (Math.abs(left.length - right.length) === 1) {
    const shorter = left.length < right.length ? left : right;
    const longer = left.length < right.length ? right : left;
    for (let index = 0; index < longer.length; index++) {
      if (longer.slice(0, index) + longer.slice(index + 1) === shorter) return true;
    }
  }
  if (left.length !== right.length) return false;
  const changed = [...left].flatMap((letter, index) => letter === right[index] ? [] : [index]);
  return changed.length === 2 && changed[1] === changed[0] + 1
    && left[changed[0]] === right[changed[1]] && left[changed[1]] === right[changed[0]];
}

function onePromptTypo(question, variant, vocabulary, originalVariant) {
  const left = question.split(' '); const right = variant.split(' ');
  if (left.length !== right.length) return false;
  const changed = left.flatMap((word, index) => word === right[index] ? [] : [index]);
  if (changed.length !== 1) return false;
  const index = changed[0];
  if (['at', 'for', 'with', 'from', 'in', 'use', 'used', 'using'].includes(right[index - 1])) return false;
  if ((originalVariant.match(/[\p{L}\p{N}]+/gu) || []).some((word, wordIndex) => wordIndex > 0 && /\p{Lu}/u.test(word) && word.toLocaleLowerCase() === right[index])) return false;
  // A known word, number, negation or changed employer is not a typo. Only
  // one token may differ and all remaining words must match the whole prompt.
  return !vocabulary.has(left[index]) && singleDroppedOrTransposedLetter(left[index], right[index]);
}

/**
 * Variants are authored during Prepare. They can improve recall, but cannot
 * turn a broad one-word overlap into an answer. Ambiguous matches abstain.
 * This module has no transport, filesystem, or model dependency.
 */
export function matchInterviewAnswerCard(question, bank) {
  if (typeof question !== 'string' || !question.trim() || question.length > 2_000 || !Array.isArray(bank?.cards)) return null;
  const latestQuestion = extractLatestInterviewQuestion(question);
  if (!latestQuestion) return null;
  // A discarded intent must keep using exact saved cues, even if another
  // retained card has enough overlapping question words to pass fuzzy lookup.
  // Apply the same delivery/typo/lexical gates to each discarded catalog intent
  // separately: ambiguity among discarded intents is still a reason to abstain.
  for (const dropped of Array.isArray(bank.droppedQuestions) ? bank.droppedQuestions : []) {
    const intent = QUESTION_CATALOG.get(dropped);
    if (intent && matchInterviewAnswerCard(latestQuestion, { cards: [{ id: 'dropped', ...intent }] })) return null;
  }
  const normalized = normalizedQuestion(latestQuestion);
  const variants = bank.cards.flatMap(card => [card.question, ...(Array.isArray(card.variants) ? card.variants : [])]
    .filter(value => typeof value === 'string' && value.trim())
    .map((text, index) => ({ id: `${card.id}:${index}`, card, text })));
  const exact = new Map(variants.filter(item => normalizedQuestion(item.text) === normalized).map(item => [item.card.id, item.card]));
  if (exact.size) return exact.size === 1 ? exact.values().next().value : null;

  const vocabulary = new Set(variants.flatMap(item => normalizedQuestion(item.text).split(' ')));
  const typoMatches = new Map(variants.filter(item => onePromptTypo(normalized, normalizedQuestion(item.text), vocabulary, item.text)).map(item => [item.card.id, item.card]));
  if (typoMatches.size) return typoMatches.size === 1 ? typoMatches.values().next().value : null;

  const analysis = analyzeInterviewQuestion(latestQuestion);
  const questionTerms = new Set(analysis.terms);
  if (questionTerms.size < 2) return null;
  // Reuse the exact-cue matcher's small morphology/concept vocabulary and its
  // lexical gate, then impose stricter two-way coverage for answer selection.
  const ranked = rankInterviewEvidence(analysis, { achievements: variants.map(item => ({ id: item.id, claim: item.text })) });
  const byId = new Map(variants.map(item => [item.id, item]));
  const scores = new Map();
  for (const candidate of ranked) {
    const variant = byId.get(candidate.entityId);
    const candidateTerms = new Set(interviewHelperTerms(variant.text));
    const shared = candidate.sharedTerms.length;
    if (shared < 2 || shared / questionTerms.size < 0.75 || shared / candidateTerms.size < 0.75) continue;
    // A company's name, negation, or a number is not disposable question
    // scaffolding. Do not answer a changed factual anchor on a broad overlap.
    if ([...questionTerms].some(term => !candidateTerms.has(term) && !QUESTION_SCAFFOLD.has(term))) continue;
    const variantNumbers = numbers(variant.text);
    if (numbers(latestQuestion).some(number => !variantNumbers.includes(number))) continue;
    if (/^why\b/iu.test(latestQuestion.trim()) && !/^why\b/iu.test(variant.text.trim())) continue;
    const variantComponents = analyzeInterviewQuestion(variant.text).askedComponents;
    if (SPECIFIC_COMPONENTS.some(component => analysis.askedComponents.includes(component) && !variantComponents.includes(component))) continue;
    const previous = scores.get(variant.card.id);
    if (!previous || candidate.score > previous.score) scores.set(variant.card.id, { card: variant.card, score: candidate.score });
  }
  const matches = [...scores.values()].sort((left, right) => right.score - left.score);
  if (!matches.length || (matches[1] && matches[0].score - matches[1].score < Math.max(8, matches[0].score * 0.15))) return null;
  return matches[0].card;
}
