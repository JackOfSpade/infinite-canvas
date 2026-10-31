/**
 * Deterministic, local retrieval for Interview Helper.
 *
 * This module deliberately treats the approved career profile as read-only
 * evidence.  It does not draft an answer, summarize a claim, or fall back to
 * a generic story: every displayed cue is an exact string from one structured
 * profile field and carries the entity/segment ids that support it.
 */

import { normalizeInterviewPublicUrl } from './interviewUrlPrivacy.js';

export const INTERVIEW_HELPER_MAX_STEPS = 6;
export const INTERVIEW_HELPER_MATCH_THRESHOLD = 10;

function containsControlCharacters(value) {
  return [...value].some(character => {
    const code = character.codePointAt(0);
    // Besides C0/DEL and C1 controls, reject Unicode format characters. This
    // includes invisible bidi overrides/isolates, which can make a persisted
    // URL or display string appear to say something other than its value.
    return code <= 0x1F || (code >= 0x7F && code <= 0x9F) || /\p{Cf}/u.test(character);
  });
}

// Setup data is persisted with an Interview Helper node, so keep its URL
// canonicalization deliberately small and deterministic.  In particular, do
// not accept credential-bearing URLs: a canvas is a shareable document and is
// never an appropriate place to retain a secret.
export function canonicalInterviewJobUrl(value) {
  // Keep renderer persistence exactly in lockstep with the main-process
  // boundary. This returns a URL stripped of arbitrary query/fragment data.
  return normalizeInterviewPublicUrl(value) || null;
}

function preparationText(value, limit = 512) {
  return typeof value === 'string' && !containsControlCharacters(value) && value.trim() && value.trim().length <= limit ? value.trim() : null;
}

// The worker deliberately permits an empty role summary when no safe summary
// can be produced.  It is nevertheless a required, bounded display field so
// a saved brief always has one unambiguous public shape.
function optionalPreparationText(value, limit = 512) {
  return value === '' || !!preparationText(value, limit);
}

/** A stable, non-secret binding for the three immutable preparation inputs. */
export function interviewPreparationInputDigest({ snapshotId, jobUrl, bundleArtifactId } = {}) {
  const snapshot = typeof snapshotId === 'string' && /^[a-f0-9]{64}$/u.test(snapshotId) ? snapshotId : null;
  const url = canonicalInterviewJobUrl(jobUrl);
  const bundle = preparationText(bundleArtifactId, 256);
  if (!snapshot || !url || !bundle) return null;
  // This is an input *binding*, not a security hash. The main process may
  // return its stronger digest, but the renderer can always reject a saved
  // brief whose explicit inputs no longer match.
  return `v1:${snapshot}:${url}:${bundle}`;
}

/**
 * Accept only a compact, display-oriented preparation result.  This keeps
 * accidental profile/source-text blobs from being written into canvas JSON.
 */
export function validInterviewPreparationBrief(value, { snapshotId, bundleArtifactId, bundleDigest } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
    || !/^[a-f0-9]{64}$/u.test(value.briefId || '') || !preparationText(value.createdAt, 80)
    || !value.inputs || typeof value.inputs !== 'object' || Array.isArray(value.inputs)
    || !Object.keys(value.inputs).every(key => ['careerSnapshotId', 'jobUrlSha256', 'applicationArtifactId', 'applicationArtifactDigest'].includes(key))
    || value.inputs.careerSnapshotId !== snapshotId
    || value.inputs.applicationArtifactId !== bundleArtifactId
    || value.inputs.applicationArtifactDigest !== bundleDigest
    || !/^[a-f0-9]{64}$/u.test(value.inputs.jobUrlSha256 || '')) return false;
  const role = value.role;
  if (!role || typeof role !== 'object' || Array.isArray(role)
    || Object.keys(role).length !== 4
    || !['title', 'company', 'location', 'summary'].every(field => Object.hasOwn(role, field))
    || !['title', 'company', 'location'].every(field => !!preparationText(role[field], 1200))
    || !optionalPreparationText(role.summary, 1200)) return false;
  for (const field of ['roleThemes', 'likelyQuestions', 'questionsToAsk', 'warnings']) {
    if (!Array.isArray(value[field]) || value[field].length > 8 || !value[field].every(item => !!preparationText(item, 1200))) return false;
  }
  for (const field of ['companyFacts', 'recentContext']) {
    if (!Array.isArray(value[field]) || value[field].length > 8 || !value[field].every(item => (
      item && typeof item === 'object' && !Array.isArray(item)
      && !!preparationText(item.fact, 1200) && !!preparationText(item.sourceId, 80)
      // A brief can be restored from a canvas without repeating IPC. Require
      // its displayed citation to already be the privacy-safe canonical form,
      // rather than merely accepting a value that *could* be sanitized.
      && typeof item.sourceUrl === 'string' && canonicalInterviewJobUrl(item.sourceUrl) === item.sourceUrl
      && !!preparationText(item.sourceDate, 80)
      // Main-process provenance validation may use source quotes internally,
      // but the public durable brief retains source metadata only.
      && Object.keys(item).every(key => ['fact', 'sourceId', 'sourceUrl', 'sourceDate'].includes(key))
    ))) return false;
  }
  if (!Array.isArray(value.applicationPositioning) || value.applicationPositioning.length > 8 || !value.applicationPositioning.every(item => (
    item && typeof item === 'object' && !Array.isArray(item)
    && ['resume', 'coverLetter'].includes(item.documentKind) && !!preparationText(item.point, 1200)
    // Quote provenance is checked in the main process before this compact
    // projection crosses IPC. Never persist resume/cover-letter excerpts in
    // a shareable canvas document.
    && Object.keys(item).every(key => ['documentKind', 'point'].includes(key))
  ))) return false;
  if (!Array.isArray(value.sources) || value.sources.length > 16 || !value.sources.every(item => (
    item && typeof item === 'object' && !Array.isArray(item) && !!preparationText(item.sourceId, 80)
    && typeof item.sourceUrl === 'string' && canonicalInterviewJobUrl(item.sourceUrl) === item.sourceUrl
    && !!preparationText(item.sourceDate, 80)
    && Object.keys(item).every(key => ['sourceId', 'sourceUrl', 'sourceDate'].includes(key))
  ))) return false;
  // A strict allow-list prevents a profile, raw listing, or file payload from
  // being smuggled into canvas state alongside an otherwise plausible brief.
  return Object.keys(value).every(key => [
    'version', 'briefId', 'createdAt', 'inputs', 'role', 'roleThemes',
    'companyFacts', 'recentContext', 'likelyQuestions', 'questionsToAsk',
    'applicationPositioning', 'sources', 'warnings',
  ].includes(key));
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'could', 'did', 'do',
  'for', 'from', 'had', 'has', 'have', 'how', 'i', 'if', 'in', 'is', 'it', 'me',
  'my', 'of', 'on', 'or', 'our', 'please', 'tell', 'that', 'the', 'their', 'this',
  'to', 'was', 'we', 'what', 'when', 'with', 'would', 'you', 'your', 'about',
  'time', 'into', 'through', 'experience', 'example', 'role', 'work', 'team',
]);

const CONCEPTS = {
  leadership: ['lead', 'leader', 'leadership', 'manage', 'manager', 'mentor', 'coach', 'influence'],
  collaboration: ['collaborate', 'partner', 'stakeholder', 'alignment', 'disagree', 'conflict', 'pushback'],
  delivery: ['deliver', 'launch', 'ship', 'release', 'deadline', 'roadmap', 'prioritize'],
  discovery: ['research', 'customer', 'user', 'insight', 'interview', 'validate'],
  technical: ['architecture', 'system', 'technical', 'engineering', 'scale', 'reliability', 'performance'],
};

// These are intentionally narrower than the explanatory categories above.
// They are only used to rescue a one-word lexical behavioral match, so each
// family is made up of discriminating action/conflict language rather than a
// broad business category or a participant such as "stakeholder".
const BEHAVIORAL_CONCEPTS = {
  leadership: ['lead', 'leader', 'leadership', 'manage', 'manager', 'mentor', 'coach'],
  conflict: ['conflict', 'disagree', 'disagreement', 'pushback', 'resistance'],
};

// An explicit, small morphology allow-list avoids turning retrieval into a
// synonym engine. Each member is the same written verb in a common inflected
// form; it never relates different actions to one another.
const CONTROLLED_INFLECTIONS = new Map([
  ['improved', 'improve'], ['improving', 'improve'],
  ['reduced', 'reduce'], ['reducing', 'reduce'],
  ['resolved', 'resolve'], ['resolving', 'resolve'],
  ['shipped', 'ship'], ['shipping', 'ship'],
  ['planned', 'plan'], ['planning', 'plan'],
]);

function stringValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function canonicalWord(word) {
  // Keep normalization deliberately small. These inflections and
  // derivational forms are common in behavioral questions, and unlike a
  // general synonym expansion they preserve one exact action family
  // ("leadership"/"led" <-> "lead").
  if (['led', 'leader', 'leaders', 'leadership'].includes(word)) return 'lead';
  if (['managed', 'managing', 'manager', 'managers', 'management'].includes(word)) return 'manage';
  if (['mentored', 'mentoring', 'mentorship'].includes(word)) return 'mentor';
  if (CONTROLLED_INFLECTIONS.has(word)) return CONTROLLED_INFLECTIONS.get(word);
  if (word.length > 5 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

/** Return stable, de-duplicated match terms without changing source text. */
export function interviewHelperTerms(value) {
  const seen = new Set();
  return String(value || '')
    .toLocaleLowerCase()
    .normalize('NFKD')
    // Drop combining marks so "Müller" and an unaccented "Muller" share a term.
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/u)
    .map(canonicalWord)
    .filter((term) => term && !STOP_WORDS.has(term) && !/^\d+$/u.test(term))
    .filter((term) => {
      if (seen.has(term)) return false;
      seen.add(term);
      return true;
    });
}

function adjacentPhrases(terms) {
  const phrases = [];
  for (let index = 0; index < terms.length - 1; index += 1) phrases.push(`${terms[index]} ${terms[index + 1]}`);
  return phrases;
}

function intentForTerms(terms) {
  const termSet = new Set(terms);
  const ranked = Object.entries(CONCEPTS)
    .map(([intent, words], index) => ({ intent, index, score: words.filter(word => termSet.has(canonicalWord(word))).length }))
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  return ranked[0]?.intent || 'unknown';
}

/** Lightweight question metadata for UI labels and auditability, never answer text. */
export function analyzeInterviewQuestion(question) {
  const transcript = stringValue(question);
  const normalized = transcript.toLocaleLowerCase();
  const components = [];
  const add = (name, patterns) => {
    if (patterns.some(pattern => normalized.includes(pattern))) components.push(name);
  };
  add('context', ['tell me about', 'describe', 'walk me through', 'give me an example', 'a time']);
  add('conflict', ['disagree', 'disagreement', 'conflict', 'pushback', 'resistance', 'stakeholder']);
  add('stakes', ['why did it matter', 'why it mattered', 'important', 'challenge', 'difficult', 'high stakes']);
  add('personalAction', ['what did you do', 'personally', 'your contribution', 'how did you', 'your role', 'your approach', 'handle']);
  add('decision', ['decision', 'decide', 'tradeoff', 'trade-off', 'choose', 'chose', 'alternative']);
  add('outcome', ['result', 'outcome', 'impact', 'what happened', 'successful', 'success']);
  add('lesson', ['learn', 'lesson', 'would you do differently', 'take away', 'takeaway']);
  const terms = interviewHelperTerms(transcript);
  return Object.freeze({ transcript, terms: Object.freeze(terms), intent: intentForTerms(terms), askedComponents: Object.freeze(components) });
}

function exactIds(value) {
  return Object.freeze(arrayValue(value).filter(id => typeof id === 'string' && id));
}

function profileFrom(value) {
  // Calling code may hand us an approved snapshot or its canonical `.profile`.
  // We intentionally do not fall back to the lossy legacy resumeProfile shape.
  return value?.profile && typeof value.profile === 'object' ? value.profile : value;
}

function makeEvidence({ entityType, entity, cue, sourceField, roleId = null, index, isVettedDirectSkill = false }) {
  const originalCue = typeof cue === 'string' ? cue : '';
  const nonEmptyCue = stringValue(originalCue);
  if (!nonEmptyCue || !stringValue(entity?.id)) return null;
  // A rail only displays `cue`. Never let a sibling field (including opaque
  // classification metadata) turn that exact displayed string into a match.
  const matchingText = originalCue;
  return Object.freeze({
    id: `${entityType}:${entity.id}:${sourceField}`,
    entityType,
    entityId: entity.id,
    roleId: stringValue(roleId) || null,
    sourceField,
    cue: originalCue,
    evidenceSegmentIds: exactIds(entity.evidenceSegmentIds),
    // direct skill evidence is more precise than a broader entity record.
    directEvidenceSegmentIds: exactIds(entity.directEvidenceSegmentIds),
    isVettedDirectSkill,
    matchingTerms: Object.freeze(interviewHelperTerms(matchingText)),
    matchingPhrases: Object.freeze(adjacentPhrases(interviewHelperTerms(matchingText))),
    documentedComponents: Object.freeze(documentedComponentsFor(nonEmptyCue)),
    index,
  });
}

function documentedComponentsFor(cue) {
  // The rail exposes only `cue`, so disclosure must be based on that same
  // visible text. Metrics remain structured provenance, not an invisible
  // substitute for a displayed decision, outcome, or lesson.
  const text = stringValue(cue).toLocaleLowerCase();
  const documented = [];
  if (/\b(?:decision|decid(?:ed|ing)?|chose|chosen|choice|trade-?off|select(?:ed|ing)?|prioriti[sz](?:ed|ing)?|opted|recommend(?:ed|ing)?)\b/u.test(text)) documented.push('decision');
  if (/\b(?:result|outcome|impact|improv(?:ed|ement|ing)?|reduc(?:ed|tion|ing)?|increas(?:ed|e|ing)|decreas(?:ed|e|ing)|grew|saved|launched|shipped)\b/u.test(text)) documented.push('outcome');
  if (/\b(?:learn(?:ed|ing)?|lesson|takeaway|take away|would do differently)\b/u.test(text)) documented.push('lesson');
  return documented;
}

/**
 * Projects the canonical profile into retrievable, source-preserving evidence.
 * No strings are authored here: `cue` always equals one exact profile field.
 */
export function extractInterviewProfileEvidence(input) {
  const profile = profileFrom(input);
  if (!profile || typeof profile !== 'object') return Object.freeze([]);
  const evidence = [];
  const add = (definition) => {
    const item = makeEvidence({ ...definition, index: evidence.length });
    if (item) evidence.push(item);
  };

  for (const role of arrayValue(profile.roles)) {
    // A role's title and employer are independent evidence fields. Matching a
    // title must not manufacture a second employer cue; attribution supplies
    // employer context once a legitimately matched step is shown.
    add({ entityType: 'role', entity: role, cue: role?.title, sourceField: 'title', roleId: role?.id });
    add({ entityType: 'role', entity: role, cue: role?.employer, sourceField: 'employer', roleId: role?.id });
  }
  for (const achievement of arrayValue(profile.achievements)) {
    // The technology ledger is deliberately exhaustive: it may include
    // non-skills and relationship-qualified labels. It is provenance, not a
    // standalone capability assertion, so it must not make this claim match.
    add({
      entityType: 'achievement', entity: achievement, cue: achievement?.claim, sourceField: 'claim',
      roleId: achievement?.roleId,
    });
  }
  for (const project of arrayValue(profile.projects)) {
    // Keep names separate from descriptions. A specific project name can be a
    // safe named-entity retrieval key; matching it must not surface a nearby
    // description unless that description independently clears the threshold.
    if (stringValue(project?.description)) {
      add({
        entityType: 'project', entity: project, cue: project.description, sourceField: 'description',
        roleId: project?.roleId,
      });
    }
    if (stringValue(project?.name)) {
      add({ entityType: 'project', entity: project, cue: project.name, sourceField: 'name', roleId: project?.roleId });
    }
  }
  for (const skill of arrayValue(profile.skills)) {
    // Relationship-qualified terms preserve evidence context but must not be
    // presented as a standalone candidate capability.
    if (skill?.supportMode === 'relationship-qualified' || skill?.indexEligible === false) continue;
    add({
      entityType: 'skill', entity: skill, cue: skill?.name, sourceField: 'name',
      roleId: arrayValue(skill?.roleIds)[0] || null,
      isVettedDirectSkill: skill?.supportMode === 'direct' && skill?.indexEligible === true,
    });
  }
  for (const education of arrayValue(profile.education)) {
    // Credentials and institutions are independently visible fields. Keep
    // each retrievable cue to its own literal source field; dates are context
    // metadata and are not displayed as rails.
    add({ entityType: 'education', entity: education, cue: education?.credential, sourceField: 'credential' });
    add({ entityType: 'education', entity: education, cue: education?.institution, sourceField: 'institution' });
  }
  for (const certification of arrayValue(profile.certifications)) {
    // Like education, name and issuer remain separate exact cues. Issuance
    // dates remain provenance context rather than invisible retrieval terms.
    add({ entityType: 'certification', entity: certification, cue: certification?.name, sourceField: 'name' });
    add({ entityType: 'certification', entity: certification, cue: certification?.issuer, sourceField: 'issuer' });
  }
  for (const item of arrayValue(profile.otherEvidence)) {
    // `kind` is an internal classifier, never a displayed fact. Label and
    // text each get their own source-preserving candidate when present.
    add({ entityType: 'otherEvidence', entity: item, cue: item?.label, sourceField: 'label' });
    add({ entityType: 'otherEvidence', entity: item, cue: item?.text, sourceField: 'text' });
  }
  return Object.freeze(evidence);
}

function conceptHits(terms) {
  const set = new Set(terms);
  return new Set(Object.entries(CONCEPTS)
    .filter(([, words]) => words.some(word => set.has(canonicalWord(word))))
    .map(([name]) => name));
}

function behavioralConceptHits(terms) {
  const set = new Set(terms);
  return new Set(Object.entries(BEHAVIORAL_CONCEPTS)
    .filter(([, words]) => words.some(word => set.has(canonicalWord(word))))
    .map(([name]) => name));
}

function isDirectSkillUsageException(candidate, sharedTerms, transcript) {
  if (!candidate.isVettedDirectSkill || sharedTerms.length !== 1) return false;
  const cueTerms = new Set(interviewHelperTerms(candidate.cue));
  if (!cueTerms.has(sharedTerms[0])) return false;
  const name = stringValue(candidate.cue).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  if (!name) return false;
  // This exception exists for a direct capability question such as “How have
  // you used React?”; an incidental “React bug” mention is not enough to
  // select a story or skill rail on its own.
  return new RegExp(`\\b(?:use|used|using|worked with|work with|experience with|familiar with)\\b[^?.]{0,40}(?<![\\p{L}\\p{N}])${name}(?![\\p{L}\\p{N}])`, 'iu')
    .test(stringValue(transcript));
}

function isNamedEntitySingleton(candidate, sharedTerms) {
  const isDedicatedNamedField = (candidate.entityType === 'role' && candidate.sourceField === 'employer')
    || (candidate.entityType === 'project' && candidate.sourceField === 'name');
  if (!isDedicatedNamedField || sharedTerms.length !== 1) return false;
  const cueTerms = interviewHelperTerms(candidate.cue);
  return cueTerms.length === 1 && cueTerms[0] === sharedTerms[0];
}

function isBehavioralConceptException(candidate, sharedTerms, questionTerms) {
  // A behavioral question often reduces to one useful literal term after
  // stop-word removal (for example, "Tell me about a time you led a team").
  // Admit it only when a saved narrative itself has the same controlled
  // action/conflict family. The literal shared anchor still prevents this
  // from using a category or a speculative synonym to invent a story.
  if (sharedTerms.length !== 1
    || !['achievement', 'project', 'otherEvidence'].includes(candidate.entityType)) return false;
  const cueTerms = interviewHelperTerms(candidate.cue);
  if (!cueTerms.includes(sharedTerms[0])) return false;
  const questionConcepts = behavioralConceptHits(questionTerms);
  if (!questionConcepts.size) return false;
  return [...questionConcepts].some(concept => behavioralConceptHits(cueTerms).has(concept));
}

function employerScope(transcript, input) {
  const roles = arrayValue(profileFrom(input)?.roles);
  let scope = null;
  // An explicit employer is a factual anchor, not extra lexical decoration.
  // Keep this grammar narrow: generic "at scale/work/the time" is not an
  // employer. A name at the end of a clause must resolve to a saved role.
  const references = [...String(transcript || '').matchAll(/\bat\s+([\p{L}\p{N}][\p{L}\p{N} &.'’–-]*?)(?=[,;?!]|\s+(?:and|but|when|where|while|during)\b|$)/giu)];
  for (const reference of references) {
    const name = reference[1].trim().replace(/[.]+$/u, '').toLocaleLowerCase();
    if (/^(?:work|scale|first|last|present|once|least|most|the time|that time|this point|that point|a high level|the start|the end)$/u.test(name)) continue;
    const matchingRoles = roles.filter(role => stringValue(role.employer).toLocaleLowerCase() === name);
    if (!matchingRoles.length) return new Set();
    const ids = new Set(matchingRoles.map(role => role.id));
    scope = scope === null ? ids : new Set([...scope].filter(id => ids.has(id)));
  }
  if (scope !== null && roles.some(role => {
    if (scope.has(role.id) || !stringValue(role.employer)) return false;
    const employer = role.employer.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return new RegExp(`(?<![\\p{L}\\p{N}])${employer}(?![\\p{L}\\p{N}])`, 'iu').test(transcript);
  })) return new Set();
  return scope;
}

function literalQuestionConstraints(transcript, cue) {
  const numericAnchors = String(transcript || '').match(/(?<![\p{L}\p{N}])\d+(?:[.,]\d+)?%?(?![\p{L}\p{N}])/gu) || [];
  const cueNumbers = new Set(String(cue || '').match(/(?<![\p{L}\p{N}])\d+(?:[.,]\d+)?%?(?![\p{L}\p{N}])/gu) || []);
  if (numericAnchors.some(number => !cueNumbers.has(number))) return false;
  // Curly and straight apostrophes spell the same contraction.
  const negationsOf = text => String(text || '').toLocaleLowerCase().replace(/[’‘ʼ]/gu, "'").match(/\b(?:not|never|without|no)\b|\b\p{L}+n't\b/gu) || [];
  const negations = negationsOf(transcript);
  const cueNegations = new Set(negationsOf(cue));
  return negations.every(negation => cueNegations.has(negation));
}

/** Rank exact career evidence. Category/intent is explanatory only and never scores a match. */
// Canonicalized like question terms ("discuss" becomes "discus"); built lazily
// because the term normalizer's tables are defined further down this module.
let scopedScaffoldTerms = null;
const SCOPED_SCAFFOLD_TERMS = { has: term => (scopedScaffoldTerms ||= new Set(interviewHelperTerms('handle explain describe discuss walk give share'))).has(term) };

export function rankInterviewEvidence(question, input) {
  const analysis = typeof question === 'object' && Array.isArray(question?.terms) ? question : analyzeInterviewQuestion(question);
  const questionTerms = analysis.terms;
  const questionSet = new Set(questionTerms);
  const questionPhrases = new Set(adjacentPhrases(questionTerms));
  const questionConcepts = conceptHits(questionTerms);
  const roleScope = employerScope(analysis.transcript, input);
  const employerTerms = new Set(arrayValue(profileFrom(input)?.roles)
    .filter(role => roleScope?.has(role.id)).flatMap(role => interviewHelperTerms(role.employer)));
  const scopedTopicTerms = questionTerms.filter(term => !employerTerms.has(term)
    && !SCOPED_SCAFFOLD_TERMS.has(term));

  return Object.freeze(extractInterviewProfileEvidence(input)
    .filter(candidate => (roleScope === null || roleScope.has(candidate.roleId))
      // Naming the requested employer is not itself evidence for a conflict,
      // result, or technical story at that employer.
      && (roleScope === null || !scopedTopicTerms.length || candidate.matchingTerms.some(term => scopedTopicTerms.includes(term)))
      && literalQuestionConstraints(analysis.transcript, candidate.cue))
    .map((candidate) => {
      const sharedTerms = candidate.matchingTerms.filter(term => questionSet.has(term));
      const sharedPhrases = candidate.matchingPhrases.filter(phrase => questionPhrases.has(phrase));
      const candidateConcepts = conceptHits(candidate.matchingTerms);
      const sharedConcepts = [...questionConcepts].filter(concept => candidateConcepts.has(concept));
      const lexicalScore = sharedTerms.length * 5 + sharedPhrases.length * 8;
      // Concepts can only rank an independently strong lexical match. A lone
      // generic word plus a concept must never bridge the threshold. The two
      // intentional exceptions are a direct, index-eligible skill named in a
      // direct usage question (for example, “used React”), and a narrative
      // with both one literal anchor and the same controlled behavioral
      // action/conflict family as the question.
      const qualifies = lexicalScore >= INTERVIEW_HELPER_MATCH_THRESHOLD
        || isDirectSkillUsageException(candidate, sharedTerms, analysis.transcript)
        || isNamedEntitySingleton(candidate, sharedTerms)
        || isBehavioralConceptException(candidate, sharedTerms, questionTerms);
      const score = lexicalScore + sharedConcepts.length * 3;
      return Object.freeze({ ...candidate, score, qualifies, sharedTerms: Object.freeze(sharedTerms), sharedPhrases: Object.freeze(sharedPhrases), sharedConcepts: Object.freeze(sharedConcepts) });
    })
    .filter(candidate => candidate.qualifies && candidate.sharedTerms.length > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index));
}

function stepLabel(candidate, { isPrimaryNarrative = false } = {}) {
  if (candidate.entityType === 'achievement') return isPrimaryNarrative ? 'RELEVANT EXPERIENCE' : 'RELATED EXPERIENCE';
  if (candidate.entityType === 'project') return isPrimaryNarrative ? 'RELEVANT PROJECT' : 'RELATED PROJECT';
  if (candidate.entityType === 'skill') return 'RELEVANT SKILL';
  if (candidate.entityType === 'role') return 'ROLE CONTEXT';
  if (candidate.entityType === 'education') return 'EDUCATION';
  if (candidate.entityType === 'certification') return 'CERTIFICATION';
  return 'RELEVANT DETAIL';
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

const UNSUPPORTED_MESSAGE = 'No matching example appears in saved career data. Answer from a truthful experience that is not present there.';
const PROFILE_ORDER_MESSAGE = 'Use only the saved details below. These cues follow saved profile order and do not claim an unsaved ranking.';

const COMPONENT_DISCLOSURE_ORDER = ['decision', 'outcome', 'lesson'];

function missingComponentsFor(analysis, selected) {
  const documented = new Set(selected.flatMap(candidate => candidate.documentedComponents));
  return COMPONENT_DISCLOSURE_ORDER.filter(component => analysis.askedComponents.includes(component) && !documented.has(component));
}

function compareRankedEvidence(left, right) {
  return right.score - left.score || left.index - right.index;
}

function explicitProfileIntent(transcript) {
  const prompt = stringValue(transcript).toLocaleLowerCase().replace(/[?!.…]+$/u, '').trim();
  if (/^(?:(?:can|could) you )?tell me about yourself$/u.test(prompt)
    || /^(?:(?:can|could) you )?walk me through your (?:background|resume|résumé|experience)$/u.test(prompt)) return 'overview';
  if (/^(?:what(?:'s| is) your|tell me about your) (?:biggest|greatest|proudest) (?:accomplishment|achievement)$/u.test(prompt)) return 'accomplishment';
  return null;
}

function sourceOrderedCandidate(candidate) {
  return Object.freeze({
    ...candidate,
    score: 0,
    sharedTerms: Object.freeze([]),
    sharedPhrases: Object.freeze([]),
    sharedConcepts: Object.freeze([]),
  });
}

function explicitProfileIntentRail(intent, input) {
  const evidence = extractInterviewProfileEvidence(input);
  if (intent === 'overview') {
    // A profile overview is meaningful only with a saved role. Its first
    // canonical role deterministically selects one coherent role path; this
    // is profile order, never a claim that the role is most recent or best.
    const anchor = evidence.find(candidate => candidate.entityType === 'role');
    if (!anchor?.roleId) return [];
    return coherentEvidenceRail(evidence
      .filter(candidate => candidate.roleId === anchor.roleId)
      .map(sourceOrderedCandidate));
  }
  if (intent === 'accomplishment') {
    // The snapshot has no trustworthy "biggest" ranking. Surface exactly one
    // saved achievement in canonical order, without labelling it as biggest.
    const achievement = evidence.find(candidate => candidate.entityType === 'achievement');
    return achievement ? [sourceOrderedCandidate(achievement)] : [];
  }
  return [];
}

/**
 * A cue rail is an answer path, not a checklist of every matching record.
 *
 * The first independently-qualified item selects that path. For role-linked
 * evidence, other items must both independently qualify and belong to that
 * exact role; this prevents an interviewer from being given a stitched
 * together story from separate jobs. A standalone item has no trustworthy
 * role boundary, so its path is deliberately limited to its exact entity.
 * This is narrower than a generic category grouping by design: category alone
 * is not enough evidence that two saved records describe one experience.
 */
function coherentEvidenceRail(ranked) {
  const anchor = ranked[0];
  if (!anchor) return [];

  const samePath = anchor.roleId
    ? ranked.filter(candidate => candidate.roleId === anchor.roleId)
    : ranked.filter(candidate => candidate.entityType === anchor.entityType && candidate.entityId === anchor.entityId);

  if (!anchor.roleId) return samePath.sort(compareRankedEvidence);

  const roleContext = samePath
    .filter(candidate => candidate.entityType === 'role')
    .sort(compareRankedEvidence);
  const narrative = samePath
    .filter(candidate => candidate.entityType === 'achievement' || candidate.entityType === 'project')
    .sort(compareRankedEvidence);
  const directSkills = samePath
    // Only direct skills can support a role story. Preserve a non-direct
    // anchor itself if a future canonical profile admits one, though: it was
    // independently qualified and dropping it would turn a supported match
    // into an empty, misleading rail. Do not pull in any peer skill for it.
    .filter(candidate => candidate.entityType === 'skill'
      && (candidate.isVettedDirectSkill || candidate === anchor))
    .sort(compareRankedEvidence);
  // The canonical profile can include other role-linked evidence kinds in
  // future versions. Keep them grounded and stable, but do not let them move
  // ahead of the role / story / direct-skill conversational sequence.
  const remaining = samePath
    .filter(candidate => candidate.entityType !== 'role'
      && candidate.entityType !== 'achievement'
      && candidate.entityType !== 'project'
      && candidate.entityType !== 'skill')
    .sort(compareRankedEvidence);
  return [...roleContext, ...narrative, ...directSkills, ...remaining];
}

/** Build a fixed cue rail from matching profile evidence, or a truthful empty result. */
export function buildInterviewPlan({ question, profile, snapshotId = null } = {}) {
  // A live/pasted transcript can include multiple turns. Retrieval must see
  // only the final interviewer question, not residual words from earlier
  // questions or ordinary conversational prose.
  const extractedQuestion = extractLatestInterviewQuestion(question);
  const analysis = analyzeInterviewQuestion(extractedQuestion || '');
  const profileIntent = explicitProfileIntent(analysis.transcript);
  const ranked = rankInterviewEvidence(analysis, profile);
  const resolvedSnapshotId = stringValue(snapshotId) || stringValue(profile?.snapshotId) || stringValue(profile?.profile?.snapshotId) || null;
  const intentRail = profileIntent ? explicitProfileIntentRail(profileIntent, profile) : [];
  if (!ranked.length && !intentRail.length) {
    return freezeDeep({
      status: 'unsupported', message: UNSUPPORTED_MESSAGE, snapshotId: resolvedSnapshotId, analysis,
      missingComponents: missingComponentsFor(analysis, []), steps: [], evidence: [],
    });
  }
  const selected = (intentRail.length ? intentRail : coherentEvidenceRail(ranked)).slice(0, INTERVIEW_HELPER_MAX_STEPS);
  let primaryNarrativeShown = false;
  const steps = selected.map((candidate, index) => {
    const isNarrative = candidate.entityType === 'achievement' || candidate.entityType === 'project';
    const isPrimaryNarrative = isNarrative && !primaryNarrativeShown;
    if (isNarrative) primaryNarrativeShown = true;
    return {
      id: `${candidate.id}:${index + 1}`,
      label: stepLabel(candidate, { isPrimaryNarrative }),
      cue: candidate.cue,
      provenance: {
        entityType: candidate.entityType,
        entityId: candidate.entityId,
        roleId: candidate.roleId,
        sourceField: candidate.sourceField,
        evidenceSegmentIds: [...candidate.evidenceSegmentIds],
        directEvidenceSegmentIds: [...candidate.directEvidenceSegmentIds],
      },
      match: { score: candidate.score, terms: [...candidate.sharedTerms], phrases: [...candidate.sharedPhrases], concepts: [...candidate.sharedConcepts] },
    };
  });
  return freezeDeep({
    status: 'supported',
    message: profileIntent ? PROFILE_ORDER_MESSAGE : 'Use only the saved details below; advance when you are ready for the next thought.',
    snapshotId: resolvedSnapshotId,
    analysis,
    missingComponents: missingComponentsFor(analysis, selected),
    steps,
    evidence: selected.map(candidate => ({ id: candidate.id, entityId: candidate.entityId, entityType: candidate.entityType, score: candidate.score })),
  });
}

/** Session state intentionally locks only a supported rail, never an unknown question. */
export function createInterviewHelperSession() {
  return Object.freeze({ activePlan: null, locked: false });
}

export function isDependentInterviewFollowUp(value) {
  const sentence = stringValue(value).toLocaleLowerCase().replace(/[.!?]+$/gu, '');
  // A finite grammar preserves an explicit story anchor without borrowing
  // terms from a distinct interviewer question or ordinary transcript prose.
  return /^(?:what did you do(?: next)?|what happened(?: next)?|what (?:was|were) (?:the |your )?(?:outcome|result|results|impact)|what did you learn(?: from (?:it|that|this))?|how did you (?:resolve|handle|approach|do) (?:it|that|this)|why did (?:it|that|this) matter|what (?:trade-?offs?|decisions?) did you make|what would you do differently)$/u.test(sentence);
}

// A period after these is not a sentence end ("Acme Inc. during", "U.S. Army")
// unless a question-shaped sentence follows ("left Acme Inc. How did you…").
const ABBREVIATION_END = /(?:^|[\s(])(?:Inc|Corp|Ltd|Co|LLC|Dr|Mr|Mrs|Ms|Prof|St|Jr|Sr|vs|e\.g|i\.e|(?:[A-Z]\.)+[A-Z])\.$/u;
const abbreviationContinues = (text, period, next) => ABBREVIATION_END.test(text.slice(0, period + 1)) && !isLikelyInterviewQuestion(text.slice(next));
const isSentenceBoundary = (text, match) => match[0][0] !== '.' || !abbreviationContinues(text, match.index, match.index + match[0].length);

function splitSentences(text) {
  const parts = []; let start = 0;
  for (const match of text.matchAll(/(?<=[.!])\s+/gu)) {
    if (text[match.index - 1] === '.' && abbreviationContinues(text, match.index - 1, match.index + match[0].length)) continue;
    parts.push(text.slice(start, match.index)); start = match.index + match[0].length;
  }
  parts.push(text.slice(start));
  return parts;
}

function latestQuestionWithDependentFollowUp(text) {
  const boundaries = [...text.matchAll(/[.!?]\s+/gu)].filter(match => isSentenceBoundary(text, match));
  const priorBoundary = boundaries.at(-1);
  const latestStart = priorBoundary ? priorBoundary.index + priorBoundary[0].length : 0;
  const latest = stringValue(text.slice(latestStart));
  if (!priorBoundary || !isDependentInterviewFollowUp(latest)) return latest || null;

  // Retain a chain of dependent parts only when it ends at a directly
  // adjacent question-shaped story anchor. A new independent question still
  // supersedes all earlier turns, and prose breaks the chain.
  for (let index = boundaries.length - 1; index >= 0; index -= 1) {
    const start = index > 0 ? boundaries[index - 1].index + boundaries[index - 1][0].length : 0;
    const candidate = stringValue(text.slice(start, boundaries[index].index + 1));
    if (isDependentInterviewFollowUp(candidate)) continue;
    return isLikelyInterviewQuestion(candidate) ? stringValue(text.slice(start)) || null : latest || null;
  }
  return latest || null;
}

/** Continue one explicitly selected story without selecting or authoring new claims. */
export function buildInterviewFollowUpPlan({ question, anchorPlan, previousQuestion = anchorPlan?.analysis?.transcript } = {}) {
  if (!isDependentInterviewFollowUp(question) || anchorPlan?.status !== 'supported' || !anchorPlan.steps?.length) return null;
  const combined = `${stringValue(previousQuestion)} ${stringValue(question)}`;
  if (!combined || combined.length > 2000) return null;
  const analysis = analyzeInterviewQuestion(combined);
  return freezeDeep({
    ...anchorPlan, analysis,
    message: 'Continue the same saved example. Use only the details below; do not invent missing parts.',
    missingComponents: missingComponentsFor(analysis, anchorPlan.steps.map(step => ({ documentedComponents: documentedComponentsFor(step.cue) }))),
  });
}

/**
 * Returns the latest question in a pasted transcript, including a question-like
 * tail whose punctuation was omitted. A tightly scoped
 * generic follow-up may retain its immediately preceding question-shaped story
 * prompt. When ASR omitted punctuation, accept only a single question-shaped
 * utterance; ordinary prose is deliberately ignored instead of being treated
 * as an interviewer prompt.
 */
export function extractLatestInterviewQuestion(transcript) {
  // Every persisted rail and the interview window reject invisible format and
  // non-tab/newline control characters in the transcript. A typed or pasted
  // question (emoji ZWJ, soft hyphen, zero-width space) must not yield a
  // supported plan that its own validators then discard, so drop them here.
  const text = stringValue(typeof transcript === 'string'
    ? [...transcript].filter(character => !(/[\p{Cc}\p{Cf}]/u.test(character) && !'\t\n\r'.includes(character))).join('')
    : transcript);
  if (!text) return null;
  const questionEnd = text.lastIndexOf('?');
  if (questionEnd >= 0) {
    // ASR often punctuates an earlier question but leaves the latest request
    // unfinished. Do not confidently answer that earlier question just because
    // it owns the last question mark. Instructions and ordinary prose may
    // precede or follow the new request, so inspect each trailing sentence.
    const tail = stringValue(text.slice(questionEnd + 1).replace(/[\s.!]+$/u, ''));
    const sentences = splitSentences(tail);
    for (let index = sentences.length - 1; index >= 0; index -= 1) {
      const candidate = stringValue(sentences[index]
        .replace(/^(?:(?:and|also|then|next)\b[\s,;:]*)+/iu, '')
        .replace(/[\s.!]+$/u, ''));
      if (!isLikelyInterviewQuestion(candidate)) continue;
      // Preserve only the existing narrow dependent-follow-up grammar; a
      // distinct salary/notice/topic request must supersede the older card.
      return latestQuestionWithDependentFollowUp([text.slice(0, questionEnd + 1), ...sentences.slice(0, index), candidate].join(' '));
    }
    return latestQuestionWithDependentFollowUp(text.slice(0, questionEnd + 1));
  }
  // Treat an ASR utterance ending in a period like an unpunctuated utterance
  // only when its final sentence itself has an unmistakable question shape.
  // This keeps direct inputs such as “Describe ….” usable while ordinary
  // prose remains ineligible.
  // Strip trailing whitespace and terminal punctuation together: removing only
  // the last run ("X. ...") would expose another period and make extraction
  // non-idempotent, so a persisted rail would fail its own re-verification.
  const withoutTerminal = stringValue(text.replace(/[\s.!]+$/u, ''));
  const candidate = latestQuestionWithDependentFollowUp(withoutTerminal);
  return isLikelyInterviewQuestion(candidate) ? candidate : null;
}

// Call logistics ("Share your screen", "Explain it") are not interview
// requests; any other share/discuss/explain prompt is.
const BARE_IMPERATIVE = /^(?:please\s+)?(?:briefly\s+)?(?:share|discuss|explain)\b(?=[\s.!]*$|\s+(?:(?:my|your|the|this|that|a|an)\s+)?(?:it|that|this|screen|window|link|document|doc|file|slides?|deck|calendar|invite|resume|cv|copy)\b)/iu;

export function isLikelyInterviewQuestion(value) {
  const text = stringValue(value).toLocaleLowerCase()
    .replace(/^(?:please\s+)?(?:briefly\s+)?(?=(?:tell me|describe|walk me|explain|give me|share|discuss)\b)/u, '');
  return /^(?:tell me|describe|walk me|explain|share|discuss|give me an example|how|what|why|when|where|which|who|can you|could you|have you|do you|did you|would you|are you|is there|salary|notice)\b/u.test(text)
    && !BARE_IMPERATIVE.test(text);
}

/**
 * Reducer for streaming transcript consumers. `receive-question` ignores later
 * transcript revisions once it has selected a grounded active plan. Only the
 * explicit `next-question` action unlocks the session.
 */
export function interviewHelperSessionReducer(state = createInterviewHelperSession(), action = {}) {
  if (action.type === 'next-question') return createInterviewHelperSession();
  if (action.type !== 'receive-question') return state;
  if (state.locked && state.activePlan?.status === 'supported') return state;
  const plan = buildInterviewPlan({ question: action.question, profile: action.profile, snapshotId: action.snapshotId });
  return freezeDeep({ activePlan: plan, locked: plan.status === 'supported' });
}

export const INTERVIEW_HELPER_UNSUPPORTED_MESSAGE = UNSUPPORTED_MESSAGE;

const LAUNCH_FAILURE_GENERIC = 'The interview view could not be opened. Try again from the prepared brief.';
// Main-process launch refusals the canvas may repeat. Electron wraps an IPC
// rejection as "Error invoking remote method '...': Error: <reason>", so the
// reason is matched as a substring. Every other failure stays generic because
// loader errors are already reduced to fixed messages in the main process.
const LAUNCH_FAILURE_MESSAGES = Object.freeze([
  ['Another Interview Helper on this canvas has an active interview rail.', 'Another Interview Helper on this canvas has an active interview rail. Finish or close that interview view, then launch this one.'],
]);
export function interviewLaunchErrorMessage(error) {
  const raw = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : '';
  return LAUNCH_FAILURE_MESSAGES.find(([reason]) => raw.includes(reason))?.[1] || LAUNCH_FAILURE_GENERIC;
}

// Group nodes keep nested canvases under `data.canvasData.nodes` (legacy
// `data.nodes`), the same fields the canvas lifecycle walker reads.
function nestedCanvasNodes(node) {
  if (Array.isArray(node?.data?.canvasData?.nodes)) return node.data.canvasData.nodes;
  return Array.isArray(node?.data?.nodes) ? node.data.nodes : [];
}
function walkNodes(nodes, visit, depth = 0, seen = new Set()) {
  if (!Array.isArray(nodes) || depth > 32) return;
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    visit(node);
    walkNodes(nestedCanvasNodes(node), visit, depth + 1, seen);
  }
}
/**
 * Interview Helper nodes present in `before` but absent from `after`, at any
 * nesting depth. Undo/redo restores a whole canvas state without the deletion
 * path's post-commit sweep; the caller retires these nodes' companion windows.
 */
export function removedInterviewHelperNodes(before, after) {
  const retained = new Set();
  walkNodes(after, node => { if (typeof node.id === 'string') retained.add(node.id); });
  const removed = [];
  walkNodes(before, node => {
    if (node.type === 'interviewhelper' && typeof node.id === 'string' && !retained.has(node.id)) removed.push(node);
  });
  return removed;
}
