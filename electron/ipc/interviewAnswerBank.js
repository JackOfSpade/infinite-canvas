/**
 * Prepared candidate answers live separately from the no-candidate-claims
 * research brief. Spoken paraphrases are claims checked mechanically against
 * sealed citations; complete original evidence remains separately inspectable.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { validationFailureCollector } from './validationFailure.js';
import { wrapUntrustedText } from './promptSafety.js';
import { normalizeInterviewPublicUrl } from '../../src/utils/interviewUrlPrivacy.js';
import { deriveInterviewCandorFlags, interviewClaimFailures, interviewHeadlineFailures,
  interviewBulletFailures, interviewQuestionFit, interviewEvidenceRank, interviewStandaloneFailures, interviewClaimContent,
  interviewIntroRoleSummary } from './interviewSpokenClaims.js';
import { deriveInterviewResumeConsistency, resumeCoverage } from './interviewResumeCoverage.js';
import { isInterviewWhyQuestion, interviewResearchInterestText, interviewWhyCardFailures } from './interviewQuestionFit.js';
import { interviewAnswerRuleGuide } from './interviewAnswerRules.js';
import { sanitizeInterviewExtensions, validateInterviewExtensionPoint } from './interviewAnswerExtensions.js';

const HASH = /^[a-f0-9]{64}$/u;
const EVIDENCE_ID = /^(?:career|research)-[a-f0-9]{64}$/u;
const CARD_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const STORE = 'interview-helper-answer-banks';
const BINDING_STORE = 'interview-helper-answer-bindings';
const MAX_STORED_RECORDS = 100;
const MAX_BYTES = 1024 * 1024;
const MAX_EVIDENCE = 600;
const MAX_PROJECTION_BYTES = 200_000;
const MAX_STATEMENT = 740;
const MAX_QUOTE = 6000;
const MAX_QUESTION = 500;
const STAGES = new Set(['situation', 'task', 'action', 'result', 'point']);
export const INTERVIEW_ANSWER_MIN_CARDS = 8;
export const INTERVIEW_PROJECT_QUESTION = 'Walk me through a project.';
export const INTERVIEW_INTRO_QUESTION = 'Tell me about yourself.';
export const INTERVIEW_REQUIRED_QUESTIONS = Object.freeze([INTERVIEW_INTRO_QUESTION, INTERVIEW_PROJECT_QUESTION]);
export function isNarrowRequiredInterviewCard(card) {
  return INTERVIEW_REQUIRED_QUESTIONS.includes(card?.question) && card.thinEvidence === true
    && Array.isArray(card.bullets) && card.bullets.length < 2;
}
export function isNarrowInterviewWhyCard(card) {
  return isInterviewWhyQuestion(card?.question) && card.thinEvidence === true
    && Array.isArray(card.bullets) && card.bullets.length === 1;
}

import { INTERVIEW_ANSWER_QUESTION_CATALOG } from '../../src/utils/interviewAnswerQuestions.js';
export { INTERVIEW_ANSWER_QUESTION_CATALOG };
const QUESTION_CATALOG = new Map(INTERVIEW_ANSWER_QUESTION_CATALOG.map(item => [item.question, item]));

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function plain(value) { return !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype; }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function exact(value, keys) {
  return plain(value) && Reflect.ownKeys(value).length === keys.length
    && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key));
}
function text(value, max = MAX_QUOTE, empty = false) {
  return typeof value === 'string' && value.length <= max && (empty && value === '' || value.trim().length > 0)
    && !/[\p{Cc}\p{Cf}]/u.test(value);
}
function evidenceText(value) {
  return typeof value === 'string' && value.length <= MAX_QUOTE && value.trim().length > 0
    && !/[\p{Cc}\p{Cf}]/u.test(value.replace(/[\t\r\n]/gu, ''));
}
function list(value, max, check) { return Array.isArray(value) && value.length <= max && value.every(check); }
function segments(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string' && /^segment-[0-9]{4,}$/u.test(item)) : [];
}
function stop(signal) { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Interview answer preparation was cancelled.'); }

export function interviewAnswerBankApplicationDigest(bundle) { return plain(bundle?.digests) ? sha(stable(bundle.digests)) : ''; }

function evidenceAddress(evidence, snapshotId, briefId) {
  return `${evidence.kind}-${sha(stable({
    binding: evidence.kind === 'career' ? snapshotId : briefId,
    entityType: evidence.entityType, entityId: evidence.entityId,
    sourceField: evidence.sourceField, text: evidence.text, roleId: evidence.roleId, roleContext: evidence.roleContext,
  }))}`;
}

/** Only literal, complete, bounded fields from the already approved projection. */
export function buildInterviewAnswerEvidence({ snapshot, brief } = {}) {
  if (!HASH.test(snapshot?.snapshotId || '') || !plain(snapshot?.profile) || !HASH.test(brief?.briefId || '')) throw new TypeError('Validated interview answer inputs are required.');
  const evidence = [];
  const evidenceIds = new Set(); let projectionBytes = 2;
  const roles = new Map((snapshot.profile.roles || []).map(role => [role.id, role]));
  const add = value => {
    // Never truncate a statement or split off a qualifier. An oversized field
    // remains available to the exact-cue fallback, outside this answer bank.
    if (!evidenceText(value.text) || !text(value.entityId, 160) || !text(value.sourceLabel, 700)) return;
    const item = { id: evidenceAddress(value, snapshot.snapshotId, brief.briefId), ...value,
      candorFlags: deriveInterviewCandorFlags(value.text) };
    if (evidenceIds.has(item.id)) return;
    projectionBytes += Buffer.byteLength(JSON.stringify(item), 'utf8') + (evidence.length ? 1 : 0);
    // Refuse as soon as the complete projection exceeds its bound. In
    // particular, do not traverse a very large approved profile quadratically.
    if (evidence.length >= MAX_EVIDENCE || projectionBytes > MAX_PROJECTION_BYTES) throw new Error('The approved answer evidence projection is too large.');
    evidenceIds.add(item.id); evidence.push(item);
  };
  for (const [collection, entityType, sourceField] of [['achievements', 'achievement', 'claim'], ['projects', 'project', 'description'], ['otherEvidence', 'otherEvidence', 'text']]) {
    for (const entity of snapshot.profile[collection] || []) {
      const role = roles.get(entity.roleId);
      // An unknown role association is not permission to invent attribution.
      if (entity.roleId && !role) continue;
      const sourceLabel = [role?.title, role?.employer, entity.name || entity.label || (entityType === 'achievement' ? 'Saved achievement' : 'Saved career evidence')].filter(Boolean).join(' · ');
      add({ kind: 'career', text: entity[sourceField], roleId: role?.id || null,
        roleContext: role ? { title: role.title || '', employer: role.employer || '', startDate: role.startDate || '', endDate: role.endDate || '' } : null,
        sourceLabel, sourceUrl: '', entityType, entityId: entity.id, sourceField,
        evidenceSegmentIds: segments(entity.evidenceSegmentIds) });
    }
  }
  for (const sourceField of ['companyFacts', 'recentContext']) {
    for (const item of brief[sourceField] || []) {
      if (!text(item.sourceId, 80) || normalizeInterviewPublicUrl(item.sourceUrl) !== item.sourceUrl) continue;
      // The brief's fact is an exact quotation of validated raw research, not
      // an independently fetched/verified quotation of the remote source page.
      add({ kind: 'research', text: item.fact, roleId: null, sourceLabel: item.sourceUrl,
        roleContext: null,
        sourceUrl: item.sourceUrl, entityType: 'research', entityId: item.sourceId,
        sourceField, evidenceSegmentIds: [] });
    }
  }
  // Role motivation comes from the sealed research brief. These are visibly
  // brief-derived descriptions, distinct from externally quoted company facts.
  for (const [index, fact] of [brief.role?.summary, ...(brief.roleThemes || [])].entries()) {
    if (!fact) continue;
    add({ kind: 'research', text: fact, roleId: null, roleContext: null,
      sourceLabel: 'Prepared role research', sourceUrl: '', entityType: 'research',
      entityId: `brief-role-${index}`, sourceField: 'roleContext', evidenceSegmentIds: [] });
  }
  // Silently dropping late fields would make job-aware choice depend on source
  // order. Refuse an oversized projection so Prepare can report it honestly.
  return evidence;
}

const stringSchema = max => ({ type: 'string', minLength: 1, maxLength: max });
const statementProperties = {
  text: stringSchema(MAX_STATEMENT),
  evidenceIds: { type: 'array', minItems: 1, maxItems: 4, items: stringSchema(80) },
  quotes: { type: 'array', minItems: 1, maxItems: 4, items: {
    type: 'object', additionalProperties: false, required: ['evidenceId', 'quote'],
    properties: { evidenceId: stringSchema(80), quote: stringSchema(MAX_QUOTE) },
  } },
};
const statementSchema = { type: 'object', additionalProperties: false, required: ['text', 'evidenceIds', 'quotes'], properties: statementProperties };
export const INTERVIEW_ANSWER_BANK_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['cards'], properties: {
    cards: { type: 'array', minItems: 12, maxItems: 20, items: {
      type: 'object', additionalProperties: false,
      required: ['id', 'question', 'variants', 'headline', 'bullets', 'example', 'extensions', 'consistency', 'thinEvidence'],
      properties: {
        id: stringSchema(64), question: stringSchema(MAX_QUESTION),
        variants: { type: 'array', minItems: 1, maxItems: 8, items: stringSchema(MAX_QUESTION) },
        headline: statementSchema, thinEvidence: { type: 'boolean' },
        bullets: { type: 'array', minItems: 0, maxItems: 3, items: {
          type: 'object', additionalProperties: false, required: ['stage', 'text', 'evidenceIds', 'quotes'],
          properties: { stage: { type: 'string', enum: [...STAGES] }, ...statementProperties },
        } },
        example: statementSchema,
        extensions: { type: 'array', minItems: 0, maxItems: 4, items: {
          // IDs already name complete exact evidence. Hydrate quotes on the
          // host instead of repeating large private paragraphs 2–4 more times.
          type: 'object', additionalProperties: false, required: ['id', 'text', 'evidenceIds'],
          properties: { id: stringSchema(96), text: stringSchema(220), evidenceIds: statementProperties.evidenceIds },
        } },
        consistency: { type: 'object', additionalProperties: false, required: ['consistentWithResume', 'resumeQuote'], properties: {
          consistentWithResume: { type: 'boolean' }, resumeQuote: { type: 'string', maxLength: 2400 },
        } },
      },
    } },
  },
});

export function interviewAnswerBankPrompt({ brief, bundle, evidence } = {}) {
  // Preparation may resume after a newly published brief with the same
  // semantic hash. A wall-clock timestamp must not change the durable prompt.
  const { createdAt: _createdAt, ...stableBrief } = brief || {};
  const selection = INTERVIEW_ANSWER_QUESTION_CATALOG.map(({ question }) => ({ question,
    ranked: interviewEvidenceRank(question, evidence, stableBrief.roleThemes || [], bundle?.listingText || '').slice(0, 12) }));
  return `Prepare 12–20 ready-to-say answer cards for this interview. Keep research and candidate claims separate. Use two stages.
STAGE A — SELECTION: use the host's ranked evidence choices below. Rank question fit first, then the research brief's role themes AND original job listing. Reuse relevant evidence freely across questions when it answers them; there is no one-evidence-per-card assignment or distinct-primary requirement. Combine several evidence items in a card, binding each separate claim to its own sources. Prefer relevant frontend/full-stack, product, cross-functional, integration, data and performance evidence over less relevant domain stories when supported; do not invent role experience or a collaboration split. Never repeat a spoken bullet across cards.
STAGE B — SPOKEN CLAIMS: headline, each bullet, example and each extension are each ONE sentence/claim {text,evidenceIds,quotes:[{evidenceId,quote}]}. Speakable PARAPHRASE is allowed. Cite 1–4 supplied evidence IDs, preferably one per claim; quotes retain the entire exact source text for the separate evidence toggle. Every content noun and verb must overlap that claim's cited evidence, allowing grammatical inflections and narrow supported equivalents. Verified roleContext title/employer may place the story in its role; sourceLabel alone supplies no facts. Every other entity, product, technology, number and unit must be in that same evidence; spoken numbers equal written numbers. Do not add motives, causality, metrics, improved/reduced/increased outcomes or shipment. Outcomes require explicit source support; shipment alone does not establish an outcome. Preserve negation and attribution.
CANDOR: source candorFlags constrain EVERY spoken line, including the headline. For inherited work describe maintaining, improving, extending or adding; do not claim original construction. Co-built work requires we or the cited other engineer in every agency claim. Mixed solo/shared evidence must retain that distinction; without an explicit who-did-what split, collaboration is thin evidence. Team-chosen work gives implementation/testing only; saying implemented a modified algorithm requires the team chose it in that same line, or omit modified. Supported/assisted sources permit supported, helped or contributed, never solo evaluated, presented, led, decided or owned. Preserve approximate quantities, partial scope, example-only such-as strategies, personal-project context and historical retirement. Do not turn an example into an adopted recommendation. Observed work stays attributed to its owner. No parentheticals, note boilerplate, technology labels or source annotations in speech.
HEADLINE: 10–16 whitespace-separated words, one first-person sentence with an active verb, no parentheses, colon or semicolon. BULLETS: exactly 2–3, each 8–18 words, one claim each. Headline and bullets are recall cues for the human to memorize before the interview. Each line stands alone: name its object instead of unresolved They/Those/It/The data. Bullets must add detail beyond the headline. EXAMPLE: retain a separately cited concrete career example for the prepared answer. OPTIONAL EXTENSIONS: for EACH card generate 2–4 additional glanceable points in extensions:[{id,text,evidenceIds}], with distinct bounded IDs within that card. Extension evidenceIds bind the whole claim; OMIT quotes on extension points to keep output compact: the host restores full exact quotes from those IDs before any validation or review. Each point is one line, at most 18 words/220 characters, answering that question more completely than the memorized bullets and example: another angle, project or skill, a role-fit link, or a documented lesson/tradeoff. Use DIFFERENT or ADDITIONAL evidence/detail, including other career stories; never paraphrase existing bullets or repeat the example. Each point must stand alone and preserve all source qualifications. Cite the specific project/role evidence so the host can attach a tiny exact-source example hook; no hook or source annotation in the spoken text. Research-only points are allowed for why-company/why-role and must introduce unused sealed research facts, never candidate experience. Do not infer a lesson, outcome or role fit from unrelated facts. These points are OPTIONAL material the human has NOT memorized: bring them in only if they can supply a real example. The host drops failing points individually; an empty list is honest only when no valid additional evidence remains. Use point unless the source literally starts with the chosen STAR stage and colon; never infer causal STAR relationships between separate entities. Behavioral cards must establish the asked trait: collaboration needs a working split, result an actual outcome beyond shipped, prioritize a choice between competing demands, process improvement a before/after change, and customer needs a discovery action. When the source lacks that shape, set thinEvidence:true and say less; a deliverable or audience alone is insufficient.
Use 12–20 DISTINCT questions verbatim from the HOST QUESTION CATALOG; variants may contain only that question's listed variants. ALWAYS include Tell me about yourself. AND Walk me through a project. These are REQUIRED and cannot be dropped. Include Tell me about yourself as a short arc: current or last role first, earlier experience next, then why this role from the sealed research brief only. Name employers/roles from the cited roleContext. Separate role claims with their own citations and chronological wording; never merge separate events into a causal story. An intro employment-summary sentence may cite several roles, naming each employer and title from its own roleContext; it asserts employment only, never transfers achievements or candor between roles. Use last/earlier/previously only when the supplied role dates establish that order; omit dates from speech unless the cited source text supplies them. Research allows only "This role interests me because [cited research fact]" or "This company interests me because [cited research fact]"; no candidate experience may enter that line. WHY CARDS: prefer a headline answering why with research ONLY, using that interest frame (a third-person company fact is also allowed), followed by two career-only bullets. If this format cannot be repaired, retain a safe career headline/example and one separately research-cited reason bullet with thinEvidence:true; this narrow fallback waives length/detail expectations, never factual guards. Every factual sentence is separately cited.
REQUIRED-CARD NARROWING: when a required intro/project cannot sustain the full format, retain fewer claims with thinEvidence:true and 0–1 bullets. A single safe headline may also be its example. This explicit narrow required format waives arc, new-detail and headline word-count expectations; all citation, entity, number, candor and semantic guards still apply. Prefer this honest fallback over an unsupported claim or dropping the question.
CONSISTENCY: the captured résumé text is supplied below. consistentWithResume:true requires a captured résumé quote covering each spoken career claim with its qualifiers, not every unused detail of the original source paragraph. Copy complete sentences, including qualifying prefixes; wrapped PDF whitespace may be normalized. Otherwise set false and resumeQuote empty. The cover letter and receipt cannot establish résumé consistency. The host verifies this annotation; failed coverage becomes false and never rejects a card.
CORRECTIONS: a later repair request supplies only failing cards and their own issues. Return only those requested cards, retaining their IDs and questions. Passing cards are locked by the host. Quoted rejected wording identifies the error; it is never a writing template.
HOST VALIDATION RULES AND TINY SYNTHETIC EXAMPLES (toy names/facts only, never interview evidence):
${interviewAnswerRuleGuide()}
HOST QUESTION CATALOG:
${JSON.stringify(INTERVIEW_ANSWER_QUESTION_CATALOG)}
HOST RANKED SELECTION (scores guide selection, never establish new candidate facts):
${JSON.stringify(selection)}
${wrapUntrustedText('interview-answer-sealed-brief', JSON.stringify(stableBrief))}
${wrapUntrustedText('interview-answer-approved-evidence', JSON.stringify(evidence))}
${wrapUntrustedText('interview-answer-original-listing', bundle?.listingText || '')}
${wrapUntrustedText('interview-answer-submitted-positioning', JSON.stringify(bundle?.applicationPositioning || {}))}`;
}

function checkCards(cards, evidence, { resume, verifyResume = false, selectionEvidence, collect = false, minCards = INTERVIEW_ANSWER_MIN_CARDS, requireProject = true, lockedIds = new Set() } = {}) {
  const issues = validationFailureCollector({ stage: 'interview-answer-bank', reason: 'answer-truth', prefix: 'Invalid prepared interview answers: ' });
  const failures = [];
  const add = (rule, at, instruction) => {
    const cardIndex = /^cards\[(\d+)\]/u.exec(at)?.[1];
    let returned = at === 'cards' ? { type: Array.isArray(cards) ? 'array' : typeof cards, count: cards?.length } : cards;
    for (const key of at.replaceAll('[', '.').replaceAll(']', '').split('.').slice(1)) returned = returned?.[key];
    if (plain(returned)) returned = typeof returned.text === 'string' ? returned.text : {
      fields: Object.keys(returned), ...(typeof returned.id === 'string' ? { id: returned.id, question: returned.question } : returned),
    };
    const detail = `returned ${JSON.stringify(returned) ?? 'undefined'}; ${instruction}`;
    const failure = { rule, path: at, cardIndex: cardIndex === undefined ? null : Number(cardIndex), instruction: detail };
    failures.push(failure); issues.add(rule, `${at}: ${detail}`);
  };
  if (!Array.isArray(cards) || cards.length < minCards || cards.length > 20) {
    add('INTERVIEW_ANSWER_CARD_COUNT', 'cards', `received ${Array.isArray(cards) ? cards.length : 'a non-array'}; require ${minCards}–20 complete cards.`);
    if (collect) return { used: new Set(), failures };
    issues.throwIfAny();
  }
  if (requireProject && !cards.some(card => card?.question === INTERVIEW_PROJECT_QUESTION)) add('INTERVIEW_ANSWER_PROJECT_REQUIRED', 'cards', 'include the required project walkthrough; it cannot be omitted from a prepared bank.');
  if (requireProject && !cards.some(card => card?.question === INTERVIEW_INTRO_QUESTION)) add('INTERVIEW_ANSWER_INTRO_REQUIRED', 'cards', 'include the required introduction; it cannot be omitted from a prepared bank.');
  const byId = new Map(evidence.map(item => [item.id, item]));
  const bulletKeys = new Map();
  const used = new Set(); const cardIds = new Set(); const questions = new Set();
  const canonicalText = value => typeof value === 'string' ? value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() : '';
  // A new repair must never displace an already accepted card on a duplicate.
  const ordered = [...cards.entries()].sort((a, b) => Number(lockedIds.has(b[1]?.id)) - Number(lockedIds.has(a[1]?.id)));
  for (const [index, card] of ordered) {
    const at = `cards[${index}]`;
    const cardFields = ['id', 'question', 'variants', 'headline', 'bullets', 'example', 'consistency', 'thinEvidence'];
    // Previously sealed v2 banks remain readable. New Prepare requests the
    // dedicated extensions field; its contents are bound by the same bank hash.
    if (!(exact(card, cardFields) || exact(card, [...cardFields, 'extensions']))) { add('INTERVIEW_ANSWER_CARD_SHAPE', at, 'use exactly the required card fields, including the evidence warning flag and optional extensions array.'); continue; }
    if (!CARD_ID.test(card.id || '') || cardIds.has(card.id)) add('INTERVIEW_ANSWER_CARD_ID', `${at}.id`, 'use a unique bounded card ID.');
    cardIds.add(card.id);
    const catalog = QUESTION_CATALOG.get(card.question);
    if (!text(card.question, MAX_QUESTION) || !catalog || questions.has(card.question.toLowerCase())) add('INTERVIEW_ANSWER_QUESTION', `${at}.question`, 'copy one unique question verbatim from the host catalog.');
    if (typeof card.question === 'string') questions.add(card.question.toLowerCase());
    if (!list(card.variants, 8, value => text(value, MAX_QUESTION) && catalog?.variants.includes(value)) || card.variants.length < 1
      || new Set(card.variants).size !== card.variants.length) add('INTERVIEW_ANSWER_VARIANTS', `${at}.variants`, 'copy only distinct variants listed for this question.');
    const narrowRequired = isNarrowRequiredInterviewCard(card);
    const narrowWhy = isNarrowInterviewWhyCard(card);
    if (!Array.isArray(card.bullets) || !narrowRequired && !narrowWhy && card.bullets.length < 2 || card.bullets.length > 3) { add('INTERVIEW_ANSWER_BULLETS', `${at}.bullets`, 'provide 2–3 separately cited spoken bullets, 0–1 for a thin required intro/project, or one research bullet for a thin why-card.'); continue; }
    const careerUsed = new Map(); const localBullets = new Map();
    if (Object.hasOwn(card, 'extensions')) {
      if (!Array.isArray(card.extensions) || card.extensions.length > 4) add('INTERVIEW_EXTENSION_SHAPE', `${at}.extensions`, 'retain at most four individually validated optional points.');
      else {
        const previousPoints = [];
        for (const [pointIndex, point] of card.extensions.entries()) {
          try {
            validateInterviewExtensionPoint(point, { evidence, card, previousPoints, compareSiblingDetails: !collect });
            previousPoints.push(point);
            for (const id of point.evidenceIds) used.add(id);
          } catch (error) { add(error.code || 'INTERVIEW_EXTENSION_INVALID', `${at}.extensions[${pointIndex}]`, 'drop this optional point; it must add a separately grounded detail, preserving its complete claim citations and candor.'); }
        }
      }
    }
    const statements = [['headline', card.headline, false], ...card.bullets.map((item, i) => [`bullets[${i}]`, item, true]), ['example', card.example, false]];
    for (const [field, statement, bullet] of statements) {
      const here = `${at}.${field}`;
      const requiredFields = bullet ? ['stage', 'text', 'evidenceIds', 'quotes'] : ['text', 'evidenceIds', 'quotes'];
      if (!exact(statement, requiredFields) || !text(statement?.text, MAX_STATEMENT)) {
        add('INTERVIEW_ANSWER_STATEMENT_SHAPE', here, `returned fields ${JSON.stringify(plain(statement) ? Object.keys(statement) : typeof statement)} and text length ${statement?.text?.length}; require exactly ${JSON.stringify(requiredFields)} with nonempty text of at most ${MAX_STATEMENT} characters and no control characters.`); continue;
      }
      if (bullet && !STAGES.has(statement.stage)) { add('INTERVIEW_ANSWER_STATEMENT_SHAPE', `${here}.stage`, `use one permitted stage: ${[...STAGES].join(', ')}.`); continue; }
      if (!list(statement.evidenceIds, 4, id => typeof id === 'string' && EVIDENCE_ID.test(id)) || !statement.evidenceIds.length
        || new Set(statement.evidenceIds).size !== statement.evidenceIds.length
        || !list(statement.quotes, 4, quote => exact(quote, ['evidenceId', 'quote']) && EVIDENCE_ID.test(quote.evidenceId) && evidenceText(quote.quote))
        || statement.quotes.length !== statement.evidenceIds.length || new Set(statement.quotes.map(item => item.evidenceId)).size !== statement.quotes.length
        || statement.quotes.some(quote => !statement.evidenceIds.includes(quote.evidenceId))) {
        add('INTERVIEW_ANSWER_CITATION', `${here}.evidenceIds`, `returned quote bindings ${JSON.stringify(statement.quotes)}; cite 1–4 distinct supplied evidence IDs, each paired once with its complete exact quote.`); continue;
      }
      const sources = statement.evidenceIds.map(id => byId.get(id));
      if (sources.some(source => !source)) { add('INTERVIEW_ANSWER_CITATION', `${here}.evidenceIds`, `unknown IDs ${JSON.stringify(statement.evidenceIds.filter(id => !byId.has(id)))}; bind this claim only to supplied evidence IDs.`); continue; }
      for (const source of sources) {
        const quoteIndex = statement.quotes.findIndex(quote => quote.evidenceId === source.id);
        if (statement.quotes[quoteIndex]?.quote !== source.text) add('INTERVIEW_ANSWER_QUOTE', `${here}.quotes[${quoteIndex}]`, `the quote bound to ${source.id} differs from its supplied evidence; retain that entire exact source in the evidence quotation.`);
        if (bullet && statement.stage !== 'point' && !source.text.toLowerCase().startsWith(`${statement.stage}:`)) add('INTERVIEW_ANSWER_STAGE', `${here}.stage`, `evidence ${source.id} does not start literally with this stage and a colon; use stage point.`);
        if (source.kind === 'career') careerUsed.set(source.id, source);
        used.add(source.id);
      }
      if (field === 'example' && !sources.some(source => source.kind === 'career')) add('INTERVIEW_ANSWER_EXAMPLE', here, 'cite a concrete career example.');
      const researchOnly = sources.every(source => source.kind === 'research');
      const researchFact = interviewResearchInterestText(statement.text);
      const interest = researchOnly && researchFact !== undefined && !/\b(?:I|we|my|our|me|us)\b/iu.test(researchFact);
      if (sources.some(source => source.kind === 'research') && /\b(?:I|we|my|our|me)\b/iu.test(statement.text) && !interest) add('INTERVIEW_ANSWER_RESEARCH_AGENCY', here, 'research cannot establish candidate experience; use only the bounded personal-interest frame for a cited research fact.');
      const grounded = interest ? { ...statement, text: researchFact } : statement;
      const intro = card.question === INTERVIEW_INTRO_QUESTION;
      for (const failure of interviewClaimFailures(grounded, sources, { intro, roleEvidence: selectionEvidence || evidence })) add(failure.rule, here, failure.instruction);
      const presentation = field === 'headline' ? interviewHeadlineFailures(statement.text, { intro }) : bullet ? interviewBulletFailures(statement.text) : [];
      for (const failure of presentation) {
        if ((narrowRequired || narrowWhy) && (failure.rule === 'INTERVIEW_ANSWER_HEADLINE_LENGTH' || narrowWhy && failure.rule === 'INTERVIEW_ANSWER_BULLET_LENGTH')) continue;
        if (field === 'headline' && (
          isInterviewWhyQuestion(card.question) && failure.rule === 'INTERVIEW_ANSWER_HEADLINE_ACTIVE')) continue;
        add(failure.rule, here, failure.instruction);
      }
      if (field === 'example') for (const failure of interviewStandaloneFailures(statement.text)) add(failure.rule, here, failure.instruction);
      if (!narrowRequired && !narrowWhy && (bullet || field === 'example')) {
        const prior = field === 'example' ? [card.headline, ...card.bullets] : [card.headline];
        const known = new Set(prior.flatMap(item => interviewClaimContent(item?.text || '')));
        if (!interviewClaimContent(statement.text).some(token => !known.has(token))) add('INTERVIEW_ANSWER_DETAIL_REQUIRED', here, 'add a distinct cited detail beyond the headline (and, for the example, beyond all bullets); paraphrasing the same facts adds no new point.');
      }
      if (bullet) {
        if (canonicalText(statement.text) === canonicalText(card.headline?.text)) add('INTERVIEW_ANSWER_HEADLINE_DUPLICATE', here, `duplicates ${at}.headline; make these distinct supported claims.`);
        const wording = canonicalText(statement.text);
        if (localBullets.has(wording)) add('INTERVIEW_ANSWER_BULLET_DUPLICATE', here, `duplicates ${localBullets.get(wording)}; use a distinct supported bullet.`);
        localBullets.set(wording, here);
        const key = interviewClaimContent(statement.text).sort().join(' ');
        const reusableWhyReason = narrowWhy && sources.every(source => source.kind === 'research');
        const previous = reusableWhyReason ? undefined : bulletKeys.get(key);
        if (previous && previous.index !== index) add('INTERVIEW_ANSWER_BULLET_DUPLICATE', here, `repeats the supported action/detail already used at ${previous.path} (card ID ${JSON.stringify(cards[previous.index].id)}); use a distinct supported point.`);
        if (!reusableWhyReason) bulletKeys.set(key, { index, path: here });
      }
    }
    const visible = [card.headline, ...card.bullets];
    const speech = visible.map(item => item?.text || '').join(' ');
    const visibleIds = new Set(visible.flatMap(item => Array.isArray(item?.evidenceIds) ? item.evidenceIds : []));
    const visibleSources = evidence.filter(item => visibleIds.has(item.id));
    if (typeof card.thinEvidence !== 'boolean') add('INTERVIEW_ANSWER_THIN_EVIDENCE', `${at}.thinEvidence`, 'provide a boolean evidence warning flag.');
    else if (!card.thinEvidence && !interviewQuestionFit(card.question, speech, visibleSources)) add('INTERVIEW_ANSWER_QUESTION_FIT', `${at}.headline`, `does not establish the requested shape of ${JSON.stringify(card.question)}; use a supported question-shaped answer or retain a narrower honest claim and set thinEvidence:true.`);
    for (const failure of interviewWhyCardFailures(card, evidence)) add(failure.rule, `${at}.${failure.path}`, failure.instruction);
    if (card.question === INTERVIEW_INTRO_QUESTION && !narrowRequired) {
      const roles = visible.flatMap(item => {
        const sources = (Array.isArray(item?.evidenceIds) ? item.evidenceIds : []).map(id => byId.get(id)).filter(Boolean);
        if (interviewIntroRoleSummary(item, sources)) sources.sort((a, b) =>
          item.text.indexOf(`${a.roleContext.title} at ${a.roleContext.employer}`) - item.text.indexOf(`${b.roleContext.title} at ${b.roleContext.employer}`));
        return sources.map(source => source.roleId);
      }).filter(Boolean);
      const availableRoles = new Set((selectionEvidence || evidence).map(item => item.roleId).filter(Boolean));
      if (availableRoles.size >= 2 && new Set(roles).size < 2) add('INTERVIEW_ANSWER_INTRO_ARC', at, 'use the current/last role, then an earlier role in separately cited statements; a single deliverable is not a background arc.');
      if (new Set(roles).size < 2 && !card.thinEvidence) add('INTERVIEW_ANSWER_QUESTION_FIT', at, 'set thinEvidence:true when a multi-role background arc is unavailable.');
      const endRank = source => /\b(?:present|current)\b/iu.test(source.roleContext?.endDate || '') ? Infinity : Date.parse(source.roleContext?.endDate || '') || 0;
      const dated = (selectionEvidence || evidence).filter(item => item.roleId && endRank(item));
      if (dated.length && roles.length && dated.some(item => item.roleId !== roles[0] && endRank(item) > Math.max(...dated.filter(source => source.roleId === roles[0]).map(endRank), 0))) add('INTERVIEW_ANSWER_INTRO_ORDER', at, 'place the current or last documented role before earlier roles.');
      const why = card.bullets.at(-1);
      if (!(/^This role interests me because\s+/u.test(why?.text || '') && Array.isArray(why?.evidenceIds) && why.evidenceIds.length
        && why.evidenceIds.every(id => byId.get(id)?.kind === 'research'))) add('INTERVIEW_ANSWER_INTRO_WHY', at, 'end the introduction with the bounded personal-interest frame and a fact cited only to sealed research.');
    }
    if (!careerUsed.size) add('INTERVIEW_ANSWER_ROLE_PATH', at, 'include at least one cited career example.');
    if (card.bullets.some(item => STAGES.has(item?.stage) && item.stage !== 'point')
      && new Set([...careerUsed.values()].map(item => `${item.entityType}:${item.entityId}`)).size > 1) add('INTERVIEW_ANSWER_STAR_RELATION', at, `returned STAR stages stitch entity IDs ${JSON.stringify([...careerUsed.values()].map(item => `${item.entityType}:${item.entityId}`))}; use one career entity for STAR stages, or independent point bullets. Sharing an employer does not establish a causal story.`);
    // Résumé consistency is an annotation, never a reason to repair or drop a
    // factual draft. Sealing replaces it from the captured résumé below. Keep
    // strict checks for already-sealed data so a tampered true flag cannot load.
    if (!collect) {
      const consistency = card.consistency;
      if (!exact(consistency, ['consistentWithResume', 'resumeQuote']) || typeof consistency.consistentWithResume !== 'boolean' || !text(consistency.resumeQuote, 2400, true)) add('INTERVIEW_ANSWER_RESUME_SHAPE', `${at}.consistency`, 'provide the boolean flag and bounded résumé quote.');
      else if (!consistency.consistentWithResume && consistency.resumeQuote !== '') add('INTERVIEW_ANSWER_RESUME_QUOTE', `${at}.consistency`, 'use an empty quote when exact résumé coverage is unverified.');
      else if (consistency.consistentWithResume && !resumeCoverage(consistency.resumeQuote, [...careerUsed.values()], resume, verifyResume, statements.map(([, statement]) => statement))) add('INTERVIEW_ANSWER_RESUME_COVERAGE', `${at}.consistency`, `does not establish captured résumé coverage for each spoken career claim and its qualifiers; copy complete captured résumé sentences, allowing wrapped whitespace, or set consistentWithResume:false and resumeQuote empty.`);
    }
  }
  if (collect) return { used, failures };
  issues.throwIfAny();
  return used;
}

function inputBinding({ snapshot, brief, bundle, canonicalJobUrl, bundleArtifactId } = {}) {
  if (!HASH.test(snapshot?.snapshotId || '') || !HASH.test(brief?.briefId || '') || !plain(brief?.inputs)
    || brief.inputs.careerSnapshotId !== snapshot.snapshotId || !HASH.test(bundleArtifactId || '')
    || brief.inputs.applicationArtifactId !== bundleArtifactId || !plain(bundle?.digests)
    || brief.inputs.applicationArtifactDigest !== interviewAnswerBankApplicationDigest(bundle)
    || normalizeInterviewPublicUrl(canonicalJobUrl) !== canonicalJobUrl || brief.inputs.jobUrlSha256 !== sha(canonicalJobUrl)) throw new TypeError('Prepared answer bindings do not match.');
  return { careerSnapshotId: snapshot.snapshotId, briefId: brief.briefId,
    applicationArtifactId: bundleArtifactId, applicationArtifactDigest: brief.inputs.applicationArtifactDigest,
    jobUrlSha256: brief.inputs.jobUrlSha256 };
}

/** Complete, uncapped per-card diagnostics for the host's sparse repair loop. */
export function inspectInterviewAnswerCards(cards, context = {}, { lockedIds } = {}) {
  inputBinding(context);
  const projection = buildInterviewAnswerEvidence(context);
  return checkCards(cards, projection, { resume: context.bundle.applicationPositioning?.resume, verifyResume: true,
    selectionEvidence: projection, collect: true, minCards: 1, requireProject: cards.length >= INTERVIEW_ANSWER_MIN_CARDS, lockedIds });
}

/** Drafts are internal data, never sealed claims. Accept truth failures here so
 * transport retries cannot regenerate cards that already passed. */
export function validateInterviewAnswerDraft(value, targets, { requireExtensions = false } = {}) {
  const issues = validationFailureCollector({ stage: 'interview-answer-draft', reason: 'draft-shape' });
  const add = (rule, line) => issues.add(`INTERVIEW_ANSWER_${rule}`, line);
  const bytes = Buffer.byteLength(JSON.stringify(value) || '', 'utf8');
  if (bytes > MAX_BYTES) {
    add('BANK_SHAPE', `returned ${bytes} bytes; the complete internal draft must stay within ${MAX_BYTES} bytes.`);
    issues.throwIfAny();
  }
  if (!exact(value, ['cards']) || !Array.isArray(value.cards)
    || value.cards.length < (targets ? targets.length : 12) || value.cards.length > (targets ? targets.length : 20)) {
    add('CARD_COUNT', `returned fields ${JSON.stringify(plain(value) ? Object.keys(value) : typeof value)} and card count ${value?.cards?.length}; return only cards with ${targets ? `exactly ${targets.length}` : '12–20'} entries.`);
    issues.throwIfAny();
  }
  const seen = new Set(); const seenQuestions = new Set();
  for (const [index, card] of value.cards.entries()) {
    if (!plain(card) || !CARD_ID.test(card.id || '') || seen.has(card.id) || !QUESTION_CATALOG.has(card.question) || seenQuestions.has(card.question)) {
      add('CARD_ID', `cards[${index}] returned id ${JSON.stringify(card?.id)} and question ${JSON.stringify(card?.question)}; use distinct bounded IDs and distinct verbatim catalog questions.`);
    }
    seen.add(card?.id);
    seenQuestions.add(card?.question);
    if (requireExtensions && !Object.hasOwn(card || {}, 'extensions')) add('EXTENSIONS_REQUIRED', `cards[${index}] omitted extensions; return the separately prepared extensions array for every card. Generate 2–4 supported additional points, or an empty array only when no valid additional evidence remains.`);
    if (targets && !targets.some(target => target.id === card?.id && target.question === card?.question)) {
      add('REPAIR_BINDING', `cards[${index}] returned id ${JSON.stringify(card?.id)} and question ${JSON.stringify(card?.question)}; return only the requested ID/question pairs unchanged.`);
    }
  }
  if (!targets && !value.cards.some(card => card.question === INTERVIEW_PROJECT_QUESTION)) add('PROJECT_REQUIRED', 'the draft omitted the required project walkthrough; include its verbatim catalog question.');
  if (!targets && !value.cards.some(card => card.question === INTERVIEW_INTRO_QUESTION)) add('INTRO_REQUIRED', 'the draft omitted the required introduction; include its verbatim catalog question.');
  issues.throwIfAny();
  return structuredClone(value);
}

export function mergeInterviewAnswerCardRepair(cards, repair, targets) {
  if (!Array.isArray(targets) || !targets.length || new Set(targets.map(card => card.id)).size !== targets.length
    || targets.some(target => !cards.some(card => card.id === target.id && card.question === target.question))) throw new TypeError('Repair targets must be distinct current card ID/question pairs.');
  const checked = validateInterviewAnswerDraft(repair, targets);
  const replacements = new Map(checked.cards.map(card => [card.id, card]));
  return cards.map(card => replacements.has(card.id) ? replacements.get(card.id) : structuredClone(card));
}

export function interviewAnswerRepairSchema(targets) {
  return { ...INTERVIEW_ANSWER_BANK_SCHEMA, properties: { cards: {
    ...INTERVIEW_ANSWER_BANK_SCHEMA.properties.cards, minItems: targets.length, maxItems: targets.length,
    items: { ...INTERVIEW_ANSWER_BANK_SCHEMA.properties.cards.items, properties: {
      ...INTERVIEW_ANSWER_BANK_SCHEMA.properties.cards.items.properties,
      id: { type: 'string', enum: targets.map(card => card.id) },
      question: { type: 'string', enum: targets.map(card => card.question) },
    } },
  } } };
}

export function interviewAnswerRepairPrompt({ cards, failures, evidence = [], brief, bundle, lockedCards = [] } = {}) {
  // No passing card text is supplied. Every issue stays with its own card,
  // including issues beyond the generic transport's 12-line display cap.
  const withoutQuotes = value => plain(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'quotes')) : value;
  const requested = cards.map(card => ({ card: { ...card, headline: withoutQuotes(card.headline),
    bullets: Array.isArray(card.bullets) ? card.bullets.map(withoutQuotes) : card.bullets, example: withoutQuotes(card.example),
    ...(Object.hasOwn(card, 'extensions') ? { extensions: Array.isArray(card.extensions) ? card.extensions.map(withoutQuotes) : card.extensions } : {}) },
  issues: failures.filter(failure => failure.cardId === card.id)
    .map(({ rule, path, instruction }) => ({ rule, path, instruction })) }));
  const ids = new Set(cards.flatMap(card => [card.headline, ...(Array.isArray(card.bullets) ? card.bullets : []), card.example, ...(Array.isArray(card.extensions) ? card.extensions : [])]
    .flatMap(item => Array.isArray(item?.evidenceIds) ? item.evidenceIds : [])));
  for (const card of cards) {
    for (const item of interviewEvidenceRank(card.question, evidence, brief?.roleThemes || [], bundle?.listingText || '').slice(0, 3)) ids.add(item.evidenceId);
    if (card.question === INTERVIEW_INTRO_QUESTION || isInterviewWhyQuestion(card.question)) {
      for (const item of evidence) if (item.kind === 'research') ids.add(item.id);
      if (card.question === INTERVIEW_INTRO_QUESTION) {
        const roles = new Set();
        for (const item of evidence) if (item.roleId && !roles.has(item.roleId)) { roles.add(item.roleId); ids.add(item.id); }
      }
    }
  }
  const cited = evidence.filter(item => ids.has(item.id));
  // Preserve the omitted-card duplicate guard without resending accepted prose.
  const lockedBulletKeys = lockedCards.flatMap(card => card.bullets.map(item => interviewClaimContent(item.text).sort().join(' ')));
  return `SPARSE CARD REPAIR: return {cards:[...]} containing exactly the ${cards.length} requested ID/question pairs. Preserve each ID and question. Do not return passing cards or new questions. Fix every issue attached to each card. Values quoted in an issue are your own rejected text, evidence of the error, never a template to repeat.
Input cards omit repeated quotes for brevity; output each prepared headline/bullet/example citation's full exact quote from the bounded evidence below. Extensions cite evidenceIds only: omit repeated quotes, which the host restores exactly before validation. Headline 10–16 words, bullets 8–18 words each, one standalone sentence per line, no note syntax, stage point unless source literally starts with its STAR stage. Headline/bullets are memorized recall cues; example remains a concrete prepared career example. Include extensions:[{id,text,evidenceIds}] with 2–4 new points, each at most 18 words/220 characters, adding different or additional evidence beyond headline/bullets/example and answering this question more completely. Other projects/roles are allowed; why-company/role may use unused research. Every extension obeys the same truth and candor rules; the host supplies the source hook and drops failing points individually. Never fill space with duplicates or unsupported lessons. Preserve all entity, quantity, attribution and candor constraints. Inherited work is not original creation; shared work needs we/collaborator in every agency line; team choice stays attributed to the team; supported work stays supported. Preserve approximation, partial scope, personal context, example-only strategies and retirement. Recheck every line after editing. Required intro/project: prefer thinEvidence:true with fewer claims (0–1 bullets, safe headline repeated as example; length/detail/arc waived) over another failing arc or story. Research interest frames are This role/company interests me because [cited research fact]. Prefer research-only why headlines and career-only bullets; a thin why fallback may keep a safe career headline/example and one research reason bullet, with length/detail expectations waived. True résumé consistency still requires complete captured sentences supporting every spoken career claim; retain a valid matching quote when the claim survives.
${wrapUntrustedText('interview-answer-repair-catalog', JSON.stringify(INTERVIEW_ANSWER_QUESTION_CATALOG.filter(item => cards.some(card => card.question === item.question))))}
${wrapUntrustedText('interview-answer-repair-evidence', JSON.stringify(cited))}
${wrapUntrustedText('interview-answer-repair-resume', bundle?.applicationPositioning?.resume || '')}
${wrapUntrustedText('interview-answer-locked-bullet-keys', JSON.stringify(lockedBulletKeys))}
${wrapUntrustedText('interview-answer-failing-cards', JSON.stringify(requested))}`;
}

/** Seal only a completely valid merged bank, optionally with explicit omissions. */
export function validateInterviewAnswerBank(value, context = {}, { droppedQuestions = [] } = {}) {
  if (!exact(value, ['cards'])) {
    const issues = validationFailureCollector({ stage: 'interview-answer-bank', reason: 'answer-shape' });
    issues.add('INTERVIEW_ANSWER_BANK_SHAPE', `Returned fields ${JSON.stringify(plain(value) ? Object.keys(value) : typeof value)}; return one object containing only the complete cards array.`); issues.throwIfAny();
  }
  const inputs = inputBinding(context);
  const projection = buildInterviewAnswerEvidence(context);
  const career = projection.filter(item => item.kind === 'career');
  const cards = Array.isArray(value.cards) ? value.cards.map(card => {
    if (!plain(card)) return card;
    let consistency;
    try {
      consistency = deriveInterviewResumeConsistency([card.headline, ...(Array.isArray(card.bullets) ? card.bullets : []), card.example],
        career, context.bundle.applicationPositioning?.resume);
    } catch { /* An unusable annotation cannot invalidate a career claim. */ }
    return { ...card, ...(Object.hasOwn(card, 'extensions') ? { extensions: sanitizeInterviewExtensions(card, projection) } : {}), consistency: consistency && text(consistency.resumeQuote, 2400)
      ? consistency : { consistentWithResume: false, resumeQuote: '' } };
  }) : value.cards;
  const used = checkCards(cards, projection, { resume: context.bundle.applicationPositioning?.resume, verifyResume: true, selectionEvidence: projection, roleThemes: context.brief.roleThemes });
  const bank = { version: 2, inputs, cards: structuredClone(cards), evidence: projection.filter(item => used.has(item.id)),
    ...(droppedQuestions.length ? { droppedQuestions: [...droppedQuestions] } : {}) };
  if (!isInterviewAnswerBank(bank)) throw new Error('Prepared interview answers could not be validated.');
  return bank;
}

function evidenceShape(item, inputs) {
  if (!exact(item, ['id', 'kind', 'text', 'roleId', 'roleContext', 'sourceLabel', 'sourceUrl', 'entityType', 'entityId', 'sourceField', 'evidenceSegmentIds', 'candorFlags'])
    || stable(item.candorFlags) !== stable(deriveInterviewCandorFlags(item.text))
    || !EVIDENCE_ID.test(item.id) || !evidenceText(item.text) || !text(item.sourceLabel, 700) || !text(item.entityId, 160)
    || !(item.roleId === null || text(item.roleId, 160)) || !list(item.evidenceSegmentIds, 128, id => typeof id === 'string' && /^segment-[0-9]{4,}$/u.test(id))) return false;
  if (item.roleId === null ? item.roleContext !== null : !exact(item.roleContext, ['title', 'employer', 'startDate', 'endDate'])
    || !Object.values(item.roleContext).every(value => text(value, 700, true))) return false;
  if (item.kind === 'career') {
    if (item.sourceUrl !== '' || !new Set(['achievement:claim', 'project:description', 'otherEvidence:text']).has(`${item.entityType}:${item.sourceField}`)) return false;
  } else if (item.kind !== 'research' || item.entityType !== 'research' || !['companyFacts', 'recentContext', 'roleContext'].includes(item.sourceField)
    || item.roleId !== null || item.evidenceSegmentIds.length
    || (item.sourceField === 'roleContext' ? item.sourceUrl !== '' : normalizeInterviewPublicUrl(item.sourceUrl) !== item.sourceUrl)) return false;
  return item.id === evidenceAddress(item, inputs.careerSnapshotId, inputs.briefId);
}

/** Structural/truth checks plus optional freshly verified input authorities. */
export function isInterviewAnswerBank(bank, bindings = {}) {
  try {
    if (!(exact(bank, ['version', 'inputs', 'cards', 'evidence']) || exact(bank, ['version', 'inputs', 'cards', 'evidence', 'droppedQuestions'])) || bank.version !== 2
      || !exact(bank.inputs, ['careerSnapshotId', 'briefId', 'applicationArtifactId', 'applicationArtifactDigest', 'jobUrlSha256'])
      || !Object.values(bank.inputs).every(value => typeof value === 'string' && HASH.test(value))
      || !list(bank.evidence, MAX_EVIDENCE, item => evidenceShape(item, bank.inputs)) || !bank.evidence.length
      || new Set(bank.evidence.map(item => item.id)).size !== bank.evidence.length) return false;
    if (Object.hasOwn(bank, 'droppedQuestions') && (!list(bank.droppedQuestions, 20, question => QUESTION_CATALOG.has(question))
      || new Set(bank.droppedQuestions).size !== bank.droppedQuestions.length
      || bank.droppedQuestions.some(question => bank.cards?.some(card => card.question === question)))) return false;
    const used = checkCards(bank.cards, bank.evidence, { resume: bindings.bundle?.applicationPositioning?.resume, verifyResume: !!bindings.bundle });
    if (used.size !== bank.evidence.length) return false;
    const expected = {
      careerSnapshotId: bindings.snapshot?.snapshotId || bindings.snapshotId || bindings.careerSnapshotId,
      briefId: bindings.brief?.briefId || bindings.briefId,
      applicationArtifactId: bindings.bundleArtifactId || bindings.applicationArtifactId || bindings.brief?.inputs?.applicationArtifactId,
      applicationArtifactDigest: bindings.bundleArtifactDigest || bindings.applicationArtifactDigest || bindings.brief?.inputs?.applicationArtifactDigest,
      jobUrlSha256: bindings.canonicalJobUrl ? sha(bindings.canonicalJobUrl) : bindings.jobUrlSha256 || bindings.brief?.inputs?.jobUrlSha256,
    };
    if (Object.entries(expected).some(([key, value]) => value !== undefined && bank.inputs[key] !== value)) return false;
    if (bindings.snapshot || bindings.brief) {
      if (!bindings.snapshot || !bindings.brief || bindings.brief.inputs?.careerSnapshotId !== bank.inputs.careerSnapshotId) return false;
      const current = new Map(buildInterviewAnswerEvidence(bindings).map(item => [item.id, item]));
      if (!bank.evidence.every(item => stable(current.get(item.id)) === stable(item))) return false;
      checkCards(bank.cards, bank.evidence, { selectionEvidence: [...current.values()], roleThemes: bindings.brief.roleThemes });
    }
    if (bindings.bundle?.digests && sha(stable(bindings.bundle.digests)) !== bank.inputs.applicationArtifactDigest) return false;
    return true;
  } catch { return false; }
}

export function answerBankRecordId(bank) { return isInterviewAnswerBank(bank) ? sha(stable(bank)) : ''; }

function sameFile(left, right) { return left.dev === right.dev && left.ino === right.ino; }
async function storeRoot(userDataPath, { create = false, directory = STORE } = {}) {
  if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) throw new Error('Interview answer bank store is unavailable.');
  const base = await fs.promises.lstat(userDataPath);
  if (!base.isDirectory() || base.isSymbolicLink()) throw new Error('Unsafe interview answer bank store.');
  const realBase = await fs.promises.realpath(userDataPath);
  const root = path.join(realBase, directory);
  if (create) {
    try { await fs.promises.mkdir(root, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const stat = await fs.promises.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || await fs.promises.realpath(root) !== root) throw new Error('Unsafe interview answer bank store.');
  return { root, identity: stat };
}
async function sameRoot(store) {
  const stat = await fs.promises.lstat(store.root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !sameFile(store.identity, stat) || (stat.mode & 0o077) !== 0 || await fs.promises.realpath(store.root) !== store.root) throw new Error('Interview answer bank store changed.');
}

// Retain the latest publications in each private store, including a reused
// content-addressed bank. No renderer paths, temporary files or symlink targets
// participate in retention. An expired helper falls back to saved career cues.
async function pruneRecords(store, currentRecordId) {
  await sameRoot(store);
  const currentFile = path.join(store.root, `${currentRecordId}.json`);
  const before = await fs.promises.lstat(currentFile);
  const handle = await fs.promises.open(currentFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!before.isFile() || before.isSymbolicLink() || !opened.isFile() || !sameFile(before, opened)) throw new Error('Interview answer record changed.');
    await sameRoot(store);
    const now = new Date();
    await handle.utimes(now, now);
  } finally { await handle.close(); }
  const records = [];
  for (const name of await fs.promises.readdir(store.root)) {
    if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
    const file = path.join(store.root, name);
    let stat;
    try { stat = await fs.promises.lstat(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isFile() && !stat.isSymbolicLink()) records.push({ name, file, stat });
  }
  const currentName = `${currentRecordId}.json`;
  records.sort((left, right) => Number(right.name === currentName) - Number(left.name === currentName)
    || right.stat.mtimeMs - left.stat.mtimeMs || right.name.localeCompare(left.name));
  for (const record of records.slice(MAX_STORED_RECORDS)) {
    await sameRoot(store);
    try {
      const current = await fs.promises.lstat(record.file);
      if (current.isFile() && !current.isSymbolicLink() && sameFile(record.stat, current)
        && current.mtimeMs === record.stat.mtimeMs && current.ctimeMs === record.stat.ctimeMs) await fs.promises.unlink(record.file);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await sameRoot(store);
}

/** Main-only retention after the current brief-to-bank binding was verified. */
export async function pruneInterviewAnswerBindings({ userDataPath, briefId } = {}) {
  if (!HASH.test(briefId || '')) throw new Error('Invalid interview answer binding.');
  await pruneRecords(await storeRoot(userDataPath, { directory: BINDING_STORE }), briefId);
}
async function readRecord({ answerBankRecordId: recordId, userDataPath }) {
  if (!HASH.test(recordId || '')) return null;
  try {
    const store = await storeRoot(userDataPath);
    const file = path.join(store.root, `${recordId}.json`);
    const before = await fs.promises.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_BYTES || (before.mode & 0o077) !== 0) return null;
    const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || !sameFile(before, opened) || opened.size > MAX_BYTES || (opened.mode & 0o077) !== 0) return null;
      const chunks = []; let offset = 0;
      while (offset <= MAX_BYTES) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_BYTES + 1 - offset));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
        if (!bytesRead) break;
        chunks.push(chunk.subarray(0, bytesRead)); offset += bytesRead;
      }
      if (offset > MAX_BYTES) return null;
      const after = await handle.stat(); const current = await fs.promises.lstat(file);
      if (!sameFile(opened, after) || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
        || !current.isFile() || current.isSymbolicLink() || !sameFile(opened, current)) return null;
      await sameRoot(store);
      const record = JSON.parse(Buffer.concat(chunks, offset).toString('utf8'));
      if (!exact(record, ['version', 'recordId', 'bank']) || record.version !== 1 || record.recordId !== recordId || answerBankRecordId(record.bank) !== recordId) return null;
      return record.bank;
    } finally { await handle.close(); }
  } catch { return null; }
}

/** Main-only writer, atomically published and independently re-read. */
export async function publishInterviewAnswerBank({ bank, userDataPath, signal } = {}) {
  stop(signal);
  const recordId = answerBankRecordId(bank);
  if (!recordId) throw new Error('Invalid prepared interview answer bank.');
  const encoded = JSON.stringify({ version: 1, recordId, bank });
  if (Buffer.byteLength(encoded, 'utf8') > MAX_BYTES) throw new Error('Prepared interview answer bank is too large.');
  const store = await storeRoot(userDataPath, { create: true });
  const tmp = path.join(store.root, `.${recordId}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    stop(signal); await sameRoot(store);
    await fs.promises.writeFile(tmp, encoded, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    stop(signal); await sameRoot(store);
    try { await fs.promises.link(tmp, path.join(store.root, `${recordId}.json`)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const published = await readRecord({ answerBankRecordId: recordId, userDataPath });
    if (!published || stable(published) !== stable(bank)) throw new Error('Published interview answer bank could not be verified.');
    stop(signal);
    await pruneRecords(store, recordId);
    return Object.freeze({ answerBankRecordId: recordId, cardCount: bank.cards.length });
  } finally { await fs.promises.unlink(tmp).catch(() => undefined); }
}

/** Reload a sealed record; optional authorities recheck all source bindings. */
export async function loadInterviewAnswerBank({ answerBankRecordId: recordId, userDataPath, ...bindings } = {}) {
  const bank = await readRecord({ answerBankRecordId: recordId, userDataPath });
  return bank && isInterviewAnswerBank(bank, bindings) ? bank : null;
}
