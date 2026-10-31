/** Required answers may become narrower after repairs, but never bypass the
 * claim validator or semantic review. These are candidates, not approvals. */
import { buildInterviewAnswerEvidence, inspectInterviewAnswerCards,
  INTERVIEW_ANSWER_QUESTION_CATALOG, INTERVIEW_REQUIRED_QUESTIONS,
  isNarrowRequiredInterviewCard } from './interviewAnswerBank.js';
import { deriveInterviewResumeConsistency } from './interviewResumeCoverage.js';
import { interviewResearchInterestText, isInterviewWhyQuestion } from './interviewQuestionFit.js';

const MAX_CANDIDATES = 8;
const MAX_SOURCE_ATTEMPTS = 32;
const controls = /[\p{Cc}\p{Cf}]/u;
const complete = /[.!?]["'’”]?$/u;
const roleEnd = source => /\b(?:present|current)\b/iu.test(source.roleContext?.endDate || '')
  ? Infinity : Date.parse(source.roleContext?.endDate || '') || 0;

function statement(value) {
  if (!value || typeof value.text !== 'string' || !Array.isArray(value.evidenceIds) || !Array.isArray(value.quotes)) return null;
  return { text: value.text, evidenceIds: [...value.evidenceIds],
    quotes: value.quotes.map(quote => ({ evidenceId: quote?.evidenceId, quote: quote?.quote })) };
}

function sourceStatement(source, text) {
  return { text, evidenceIds: [source.id], quotes: [{ evidenceId: source.id, quote: source.text }] };
}

/** Preserve a required question with one mechanically verified claim. Prefer
 * the worker's own surviving speech, then literal complete source sentences.
 * An intro may fall back to its explicitly licensed employment metadata.
 * The caller must semantically review every candidate before adopting it. */
export function interviewRequiredFallbackCandidates(card, context, { validatedClaims, validatedOnly = false } = {}) {
  if (!INTERVIEW_REQUIRED_QUESTIONS.includes(card?.question)) return [];
  const evidence = buildInterviewAnswerEvidence(context);
  const career = evidence.filter(source => source.kind === 'career');
  const catalog = INTERVIEW_ANSWER_QUESTION_CATALOG.find(item => item.question === card.question);
  const candidates = [];
  const seen = new Set();
  const add = claim => {
    if (!claim || candidates.length >= MAX_CANDIDATES || typeof claim.text !== 'string'
      || !claim.text.trim() || claim.text.length > 740 || controls.test(claim.text)) return;
    const key = JSON.stringify([claim.text, [...claim.evidenceIds].sort()]);
    if (seen.has(key)) return;
    seen.add(key);
    const candidate = { id: card.id, question: card.question, variants: [...catalog.variants],
      headline: claim, bullets: [], example: structuredClone(claim), thinEvidence: true,
      consistency: deriveInterviewResumeConsistency([claim], career, context.bundle?.applicationPositioning?.resume)
        || { consistentWithResume: false, resumeQuote: '' } };
    if (isNarrowRequiredInterviewCard(candidate) && inspectInterviewAnswerCards([candidate], context).failures.length === 0) candidates.push(candidate);
  };

  for (const claim of validatedClaims || []) add(statement(claim));
  if (validatedOnly) return candidates;
  for (const claim of [card.headline, ...(Array.isArray(card.bullets) ? card.bullets : []), card.example]) add(statement(claim));
  if (candidates.length >= MAX_CANDIDATES) return candidates;

  const citedIds = new Set([card.headline, ...(Array.isArray(card.bullets) ? card.bullets : []), card.example]
    .flatMap(claim => Array.isArray(claim?.evidenceIds) ? claim.evidenceIds : []));
  const ordered = [...career].sort((left, right) => Number(citedIds.has(right.id)) - Number(citedIds.has(left.id))
    || Number(right.entityType === 'project') - Number(left.entityType === 'project'));
  // Employment alone is an honest final intro if none of the project claims
  // can carry all of their qualifications in a short spoken sentence.
  if (card.question === 'Tell me about yourself.') {
    const roles = new Set();
    for (const source of [...career].sort((left, right) => roleEnd(right) - roleEnd(left))) {
      if (!source.roleId || roles.has(source.roleId) || !source.roleContext?.title || !source.roleContext?.employer) continue;
      roles.add(source.roleId);
      add(sourceStatement(source, `I worked as ${source.roleContext.title} at ${source.roleContext.employer}.`));
      if (candidates.length >= MAX_CANDIDATES || roles.size >= 4) break;
    }
  }
  for (const source of ordered.slice(0, MAX_SOURCE_ATTEMPTS)) {
    let attempted = 0;
    for (const { segment } of new Intl.Segmenter('en', { granularity: 'sentence' }).segment(source.text)) {
      const text = segment.trim();
      if (!complete.test(text) || controls.test(text)) continue;
      add(sourceStatement(source, text));
      if (candidates.length >= MAX_CANDIDATES) return candidates;
      if (++attempted >= 4) break;
    }
  }
  return candidates;
}

/** Keep one safe career fact and a separate research reason. These candidates
 * still require semantic approval unless both exact claims were reviewed. */
export function interviewWhyFallbackCandidates(card, context, validatedClaims = []) {
  if (!isInterviewWhyQuestion(card?.question)) return [];
  const evidence = buildInterviewAnswerEvidence(context);
  const byId = new Map(evidence.map(source => [source.id, source]));
  // Prefer the failed card's own reason over otherwise valid claims prepared
  // for a different question. Semantic approval does not change its subject.
  const claims = [card.headline, ...(Array.isArray(card.bullets) ? card.bullets : []), card.example, ...validatedClaims]
    .map(statement).filter(Boolean);
  const only = (claim, kind) => claim.evidenceIds.length && claim.evidenceIds.every(id => byId.get(id)?.kind === kind);
  const interestSubject = card.question === 'Why are you interested in this role?' ? 'role' : 'company';
  const research = claims.filter(claim => only(claim, 'research')
    && (!interviewResearchInterestText(claim.text) || claim.text.startsWith(`This ${interestSubject} interests me because `)));
  const career = claims.filter(claim => only(claim, 'career'));
  const catalog = INTERVIEW_ANSWER_QUESTION_CATALOG.find(item => item.question === card.question);
  const candidates = [];
  for (const reason of research) for (const connection of career) {
    const candidate = { id: card.id, question: card.question, variants: [...catalog.variants],
      headline: connection, bullets: [{ stage: 'point', ...reason }], example: structuredClone(connection),
      thinEvidence: true, consistency: { consistentWithResume: false, resumeQuote: '' } };
    if (!inspectInterviewAnswerCards([candidate], context).failures.length) candidates.push(candidate);
    if (candidates.length >= MAX_CANDIDATES) return candidates;
  }
  return candidates;
}
