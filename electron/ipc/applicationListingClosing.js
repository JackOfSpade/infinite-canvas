import { ORIGINAL_JOB_LISTING_BODY_HEADING, ORIGINAL_JOB_LISTING_TARGETS_HEADING } from './applicationBundle.js';
import { targetCompanyNames } from './coverLetterChecks.js';
import { assessBulkQuantity, quantityFindings } from './applicationClaimGrounding.js';

const normalize = value => String(value ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim();
const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const CANDIDATE_TERMS = /\b(?:experience|expertise|background|record|years?|decades?|lifetime|senior|principal|staff|expert|proven|skilled|seasoned|candidate|applicant|application|writer|letter|resume|résumé)\b/iu;
const BASE_CANDIDATE_TERMS = /\b(?:experience|expertise|background|record|years?|proven|skilled|seasoned|candidate|applicant|resume|résumé)\b/iu;
const ROLE_FRAME = /\bas\s+an?\s+[\p{L}]/iu;
const CONTINUITY_FRAME = /\b(?:rejoin\w*|return\s+to|resume\w*|continu\w*|stay\w*\s+(?:at|with)|remain\w*\s+(?:at|with)|be\s+back\s+at|go\s+back\s+to)\b/iu;
const INTENT_CONTINUITY_FRAME = /\b(?:stay\w*|remain\w*|be\s+back)\b/iu;
const PERFECT_WORK_FRAME = /\b(?:have|had)\s+(?:(?:already|previously|just|recently|always|never|ever)\s+)*(?:[\p{L}]+(?:ed|en)|been|built|rebuilt|run|led|done|made|written|grown|brought|kept|held|taught|thought|known|seen|won|cut|set|put|met)\b/iu;
// These words express only the closed application/intent grammar. Any other
// meaningful token must be in the frozen company or an actually cited quote.
// WRITE_VERIFY_LISTING_CLOSING_RULE prints this vocabulary to the writer (a test
// keeps the two in step), so a rejection can name it without quoting any text.
const INTENT_VOCABULARY = new Set([
  'i', 'we', 'am', 'are', 'm', 're', 'd', 'll', 'would', 'will', 'could', 'can', 'may', 'might', 'shall', 'should',
  'hope', 'want', 'plan', 'intend', 'aim', 'look', 'looking', 'forward', 'welcome', 'chance',
  'eager', 'excited', 'ready', 'keen', 'happy', 'glad', 'thrilled', 'delighted', 'pleased', 'motivated', 'prepared', 'enthusiastic',
  'love', 'like', 'join', 'joining', 'help', 'helping', 'contribute', 'contributing', 'support', 'supporting', 'bring', 'bringing',
  'apply', 'applying', 'writing', 'role', 'position', 'job', 'opportunity', 'opening', 'vacancy', 'post', 'team', 'mission',
  'your', 'you', 'this', 'the', 'a', 'an', 'and', 'or', 'to', 'for', 'at', 'with', 'in', 'on', 'of', 'so',
]);

export const LISTING_CLOSING_INTENT_VOCABULARY = INTENT_VOCABULARY;

function withoutFrozenCompany(text, company) {
  let remainder = String(text ?? '');
  for (const name of targetCompanyNames(company).sort((a, b) => b.length - a.length)) {
    remainder = remainder.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escape(name)}(?:['’]s?)?(?![\\p{L}\\p{N}])`, 'giu'), match => ' '.repeat(match.length));
  }
  return remainder;
}

function postingBody(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/gu, '\n').split('\n');
  const heading = lines.indexOf(ORIGINAL_JOB_LISTING_BODY_HEADING);
  if (heading < 0) return '';
  let opening = heading + 1;
  while (lines[opening] === '') opening++;
  const fence = lines[opening]?.match(/^(`{3,})text$/u)?.[1];
  if (!fence) return '';
  const closing = lines.indexOf(fence, opening + 1);
  if (closing < 0 || lines.slice(heading + 1, opening).includes(ORIGINAL_JOB_LISTING_TARGETS_HEADING)) return '';
  return lines.slice(opening + 1, closing).join('\n');
}

function capitalizedTermsStated(sentence, quotes, company) {
  const sources = [...targetCompanyNames(company), ...quotes].map(normalize).join('\n');
  const wholeTerm = term => new RegExp(String.raw`(?<![\p{L}\p{N}])${escape(term)}(?![\p{L}\p{N}])`, 'iu');
  for (const match of sentence.matchAll(/(?<![\p{L}\p{N}])(?:\p{Lu}[\p{L}\p{N}'’.-]*)(?![\p{L}\p{N}])/gu)) {
    const written = match[0].replace(/[.!?]+$/u, '');
    const term = written.replace(/(?:['’]s|(?<=s)['’])$/iu, '');
    if (/^(?:I|We)(?:['’](?:m|re|d|ll))?$/u.test(term)) continue;
    if (!wholeTerm(term).test(sources)) return false;
  }
  return true;
}

/** Pure, host-context evaluation. No response field can grant this exception;
 * every earlier unit is passed back through the unchanged career rules. */
export function evaluateFinalParagraphListingGrounding(context, deps) {
  const { paragraphs = [], index, acceptedEvidence = [], frozenJobListing = '', company = '', identityTokens = [] } = context || {};
  const paragraph = paragraphs[index];
  const byId = new Map(acceptedEvidence.map(item => [item?.id, item]));
  const ids = Array.isArray(paragraph?.evidenceIds) ? paragraph.evidenceIds : [];
  const listingOnly = ids.length > 0 && ids.every(id => byId.get(id)?.sourceId === 'job-listing');
  const result = { eligible: false, listingOnly, corrections: [], listingQuotes: [] };
  if (!listingOnly) return result;
  const fail = (sentence, clause) => result.corrections.push(`Cover-letter paragraph ${index + 1}, sentence ${sentence}: listing-grounded closing requires ${clause}.`);
  if (index !== paragraphs.length - 1) fail(1, 'the last paragraph position');
  if (index < 1) fail(1, 'an earlier paragraph that passes the unchanged career-evidence rules');
  if (ids.length < 1 || ids.length > 4 || new Set(ids).size !== ids.length) fail(1, 'one to four distinct accepted job-listing evidence IDs');
  const body = normalize(postingBody(frozenJobListing));
  result.listingQuotes = ids.map(id => normalize(byId.get(id)?.quote));
  if (!body || result.listingQuotes.some(quote => !quote || !body.includes(quote))) fail(1, 'every cited quote inside the frozen fenced posting body');
  if (index > 0) {
    const prior = paragraphs.slice(0, index).map((item, priorIndex) => deps.validateEarlierParagraph(item, priorIndex));
    if (!prior.some(errors => Array.isArray(errors) && errors.length === 0)) fail(1, 'an earlier paragraph that passes the unchanged career-evidence rules');
  }
  const sentences = deps.groundingSentences(paragraph?.text);
  if (!sentences.length) fail(1, 'nonempty final paragraph prose');
  const quoteTokens = new Set(deps.meaningfulSourceTokens(result.listingQuotes.join(' ')));
  const allowedTokens = new Set([...INTENT_VOCABULARY, ...quoteTokens,
    ...deps.meaningfulSourceTokens(targetCompanyNames(company).join(' '))]);
  sentences.forEach((sentence, sentenceIndex) => {
    const ordinal = sentenceIndex + 1;
    const clauses = deps.groundingClauses(sentence).map(clause => clause.text).filter(Boolean);
    const intent = deps.speaksOnlyOfApplicationIntent(sentence) || (clauses.length > 0 && clauses.every(deps.speaksOnlyOfIntent));
    if (deps.hasFigureOrYear(sentence)
      || quantityFindings(sentence, [], { targetOwnedFree: false, trustedNames: targetCompanyNames(company), skipPopulationNouns: false }).length
      || assessBulkQuantity(sentence, [])) fail(ordinal, 'no figure, number or year');
    if (deps.hasCredentialWord(sentence)) fail(ordinal, 'no credential word');
    if (deps.hasQualifierWord(sentence)) fail(ordinal, 'no qualifier word');
    const checkNewClauseFrames = (clause, clauseIndex) => {
      const remainder = withoutFrozenCompany(clause, company);
      const prefix = `clause ${clauseIndex + 1} with `;
      if (CANDIDATE_TERMS.test(remainder)) fail(ordinal, `${prefix}no candidate-experience term`);
      if (ROLE_FRAME.test(remainder)) fail(ordinal, `${prefix}no as-a-role candidate frame`);
      if (CONTINUITY_FRAME.test(remainder) || (intent && INTENT_CONTINUITY_FRAME.test(remainder))) fail(ordinal, `${prefix}no continuity or return-to-work frame`);
      if (PERFECT_WORK_FRAME.test(remainder)) fail(ordinal, `${prefix}no have-or-had participle frame`);
    };
    const unlisted = deps.meaningfulSourceTokens(sentence).filter(token => !allowedTokens.has(token));
    if (unlisted.length) {
      // The clause is named, never the word: the vocabulary is printed in the writer rule.
      const closedTerms = 'every meaningful term in the closed intent vocabulary listed in the closing rule, the frozen company name or a cited listing quote';
      const offending = clauses.flatMap((clause, clauseIndex) => deps.meaningfulSourceTokens(clause).some(token => unlisted.includes(token)) ? [clauseIndex] : []);
      if (offending.length) for (const clauseIndex of offending) fail(ordinal, `clause ${clauseIndex + 1} with ${closedTerms}`);
      else fail(ordinal, closedTerms);
    }
    if (intent) {
      // Each clause uses the same one anchored A3 lead-in as the employment
      // guard. Coordinating two plain intents does not create career prose.
      for (const [clauseIndex, clause] of (clauses.length ? clauses : [sentence]).entries()) {
        checkNewClauseFrames(clause, clauseIndex);
        const { remainder } = deps.intentLeadInRemainder(clause);
        const prefix = `clause ${clauseIndex + 1} with `;
        if (!deps.reportsNoPastWork(remainder)) fail(ordinal, `${prefix}no past-work word after its single anchored intent lead-in`);
        if (/\b(?:i|we)\b/iu.test(remainder)) fail(ordinal, `${prefix}no second first-person subject after its intent lead-in`);
        if (deps.hasWorkIngWord(remainder)) fail(ordinal, `${prefix}no work gerund after its single anchored intent lead-in`);
      }
      if (/\b(?:my|our|mine|ours)\b/iu.test(sentence)) fail(ordinal, 'no first-person possessive');
      if (!capitalizedTermsStated(sentence, result.listingQuotes, company)) fail(ordinal, 'every capitalized or acronym term in the frozen company or a cited listing quote');
      return;
    }
    if (!clauses.length) fail(ordinal, 'an employer-facing clause');
    for (const [clauseIndex, clause] of clauses.entries()) {
      const prefix = `clause ${clauseIndex + 1} with `;
      checkNewClauseFrames(clause, clauseIndex);
      if (deps.speaksAsCandidate(clause)) fail(ordinal, `${prefix}no first-person candidate reference`);
      if (!deps.sentenceAddressesTarget(clause, company)) fail(ordinal, `${prefix}an employer-facing target`);
      if (!deps.reportsNoPastWork(clause)) fail(ordinal, `${prefix}no past-work word`);
      if (deps.hasCareerClaimFrame(clause)) fail(ordinal, `${prefix}no candidate claim frame`);
      if (deps.isCandidateCareerSentence(clause, identityTokens)) fail(ordinal, `${prefix}no candidate-career assertion`);
      if (deps.opensWithVerb(clause)) fail(ordinal, `${prefix}no opening verb`);
      if (BASE_CANDIDATE_TERMS.test(clause)) fail(ordinal, `${prefix}no candidate-experience term`);
    }
    if (deps.namedTermFindings(sentence, result.listingQuotes, { trustedNames: targetCompanyNames(company), postingText: '' }).length) fail(ordinal, 'every named term stated by the frozen company or a cited listing quote');
    const shared = new Set(deps.meaningfulSourceTokens(sentence).filter(token => quoteTokens.has(token))).size;
    if (shared < deps.MIN_SHARED_SOURCE_TERMS) fail(ordinal, `at least ${deps.MIN_SHARED_SOURCE_TERMS} meaningful terms shared with its cited listing quotes`);
  });
  result.corrections = [...new Set(result.corrections)];
  result.eligible = result.corrections.length === 0;
  return result;
}

export function finalParagraphListingGrounded(context, deps) {
  return evaluateFinalParagraphListingGrounding(context, deps).eligible;
}
