import electronPkg from 'electron';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildInterviewPlan, buildInterviewFollowUpPlan, isDependentInterviewFollowUp, canonicalInterviewJobUrl, INTERVIEW_HELPER_MAX_STEPS } from '../src/utils/interviewHelper.js';
import { createInterviewAiMatcher, interviewAiMatcherConfigFromEnv } from './interviewAiMatcher.js';
import { prepareInterviewExtensionCandidates } from './ipc/interviewAnswerExtensions.js';
import { requestNonApiAi } from './ipc/nonApiAi.js';
import { runWithIpcRequestContext } from './ipc/ipcUtils.js';
import { loadInterviewPreparationBundle, loadInterviewPreparedBrief, loadInterviewPreparedAnswerBank } from './ipc/interviewPreparation.js';
import { loadInterviewQaLiveCards } from './ipc/interviewQaStore.js';
import { isInterviewAnswerBank } from './ipc/interviewAnswerBank.js';
import { logger } from './logger.js';
import { createInterviewCallAudioService, idleInterviewListeningState, interviewAudioHelperPath } from './interviewCallAudio.js';
import { selectInterviewCallQuestion, isInterviewPartialEligible } from './interviewCallQuestionDetector.js';
import { createInterviewSpeculativeMatcher } from './interviewSpeculativeMatcher.js';

// Live-call notices are read mid-interview at a glance: a few words, never a
// sentence. "Use this question" beside the transcript is the action they name.
export const AUDIO_NOTICES = Object.freeze({
  tooLong: 'Too long · type it',
  multipart: 'Multi-part · pick one',
  notMatched: 'Not matched · Use to match',
  noStory: 'No story to follow · type it',
});

const { BrowserWindow: ElectronBrowserWindow, ipcMain: electronIpcMain, app } = electronPkg;
const SNAPSHOT_ID = /^[a-f0-9]{64}$/u;
const NODE_ID = /^[A-Za-z0-9_-]{1,160}$/u;
const BRIEF_VERSION = 1;
const MAX_TEXT = 4_000;
const MAX_BRIEF_TEXT = 1_200;
const MAX_BRIEF_ITEMS = 8;
const MAX_BRIEF_SOURCES = MAX_BRIEF_ITEMS * 2;
const MAX_CITATION_URL = 2_048;
const MAX_CITATION_DATE = 80;
const MAX_QUESTION = 2_000;
const CARD_ID = /^[A-Za-z0-9_-]{1,64}$/u;
// These mirror the persisted rail grammar in InterviewHelperNode.  The
// renderer verifies a canonical plan before saving it, and this boundary
// verifies it again before looking up the main-process snapshot.  Keeping the
// same bounded grammar means an exact, approved evidence cue is never
// rejected (or display-truncated) merely because it crosses into the child.
const MAX_PLAN_TEXT = 12_000;
const MAX_PLAN_TERMS = 2_048;
const MAX_PLAN_ID = 4_096;
const MAX_PLAN_ENTITY_ID = 1_024;
const MAX_PLAN_SCORE = 100_000;
const BRIEF_ARRAYS = ['roleThemes', 'companyFacts', 'recentContext', 'likelyQuestions', 'questionsToAsk', 'applicationPositioning', 'warnings'];
const PLAN_ENTITY_TYPES = new Set(['role', 'achievement', 'project', 'skill', 'education', 'certification', 'otherEvidence']);
const PLAN_SOURCE_FIELDS = new Set(['title', 'employer', 'claim', 'description', 'name', 'credential', 'institution', 'issuer', 'label', 'text']);

function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys) {
  return plainRecord(value) && Reflect.ownKeys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key))
    && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key));
}

function boundedText(value, maximum = MAX_TEXT) {
  return typeof value === 'string' && value.length <= maximum;
}

function hasUnsafePlanCharacters(value) {
  // Rails may faithfully contain normal tabs/newlines from the approved
  // profile, but never invisible formatting or the other control characters.
  return [...value].some(character => {
    const code = character.codePointAt(0);
    return /\p{Cf}/u.test(character)
      || code <= 0x08
      || (code >= 0x0B && code <= 0x0C)
      || (code >= 0x0E && code <= 0x1F)
      || (code >= 0x7F && code <= 0x9F);
  });
}

function planText(value, maximum = MAX_PLAN_TEXT) {
  return typeof value === 'string' && value.length <= maximum
    && !hasUnsafePlanCharacters(value) && !!value.trim();
}

function hasControl(value) {
  return [...value].some(character => {
    const code = character.codePointAt(0);
    return code <= 0x1F || (code >= 0x7F && code <= 0x9F) || /\p{Cf}/u.test(character);
  });
}

function briefText(value, maximum = MAX_BRIEF_TEXT, { allowEmpty = false } = {}) {
  return typeof value === 'string' && value.length <= maximum && !hasControl(value)
    && (allowEmpty ? value === '' || !!value.trim() : !!value.trim());
}

function briefTextArray(value) {
  return Array.isArray(value) && value.length <= MAX_BRIEF_ITEMS && value.every(item => briefText(item));
}

function planStringArray(value, maximum, itemMaximum = MAX_PLAN_TEXT) {
  return Array.isArray(value) && value.length <= maximum
    && value.every(item => planText(item, itemMaximum));
}

function evidenceItems(value) {
  // The canvas persists a compact research projection. Quote provenance is
  // validated while the brief is assembled, then deliberately omitted before
  // it can enter shareable canvas state or the child window.
  return Array.isArray(value) && value.length <= MAX_BRIEF_ITEMS && value.every(item => exactKeys(item, ['fact', 'sourceId', 'sourceUrl', 'sourceDate'])
    && briefText(item.fact) && briefText(item.sourceId, 80)
    && canonicalInterviewJobUrl(item.sourceUrl) === item.sourceUrl && briefText(item.sourceDate, 80));
}

function positioningItems(value) {
  // Application excerpts follow the same rule: only the short authored point
  // is persisted/displayed; the original document quote never crosses IPC.
  return Array.isArray(value) && value.length <= MAX_BRIEF_ITEMS && value.every(item => exactKeys(item, ['documentKind', 'point'])
    && ['resume', 'coverLetter'].includes(item.documentKind) && briefText(item.point));
}

function sources(value) {
  return Array.isArray(value) && value.length <= MAX_BRIEF_SOURCES && value.every(item => exactKeys(item, ['sourceId', 'sourceUrl', 'sourceDate'])
    && briefText(item.sourceId, 80) && canonicalInterviewJobUrl(item.sourceUrl) === item.sourceUrl && briefText(item.sourceDate, 80));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function briefSemantic(value) {
  return {
    version: value.version,
    inputs: value.inputs,
    role: value.role,
    roleThemes: value.roleThemes,
    companyFacts: value.companyFacts,
    recentContext: value.recentContext,
    likelyQuestions: value.likelyQuestions,
    questionsToAsk: value.questionsToAsk,
    applicationPositioning: value.applicationPositioning,
    warnings: value.warnings,
  };
}

function derivedSources(value) {
  const unique = new Map();
  for (const item of [...value.companyFacts, ...value.recentContext]) {
    if (!unique.has(item.sourceId)) unique.set(item.sourceId, {
      sourceId: item.sourceId,
      sourceUrl: item.sourceUrl,
      sourceDate: item.sourceDate,
    });
  }
  return [...unique.values()];
}

function isSameJson(left, right) {
  return stableJson(left) === stableJson(right);
}

export function isInterviewWindowLaunchArgs(value) {
  if (!exactKeys(value, ['nodeId', 'snapshotId', 'jobUrl', 'briefRecordId', 'brief', 'plan', 'currentStep'])) return false;
  if (typeof value.nodeId !== 'string' || !NODE_ID.test(value.nodeId) || typeof value.snapshotId !== 'string' || !SNAPSHOT_ID.test(value.snapshotId)) return false;
  if (typeof value.briefRecordId !== 'string' || !SNAPSHOT_ID.test(value.briefRecordId)) return false;
  const canonicalJobUrl = canonicalInterviewJobUrl(value.jobUrl);
  if (!canonicalJobUrl || value.jobUrl !== canonicalJobUrl) return false;
  if (!Number.isInteger(value.currentStep) || value.currentStep < 0 || value.currentStep >= INTERVIEW_HELPER_MAX_STEPS) return false;
  return isInterviewBrief(value.brief, value.snapshotId)
    && value.brief.inputs.jobUrlSha256 === sha256(canonicalJobUrl)
    // Do not admit arbitrary records and only discover they are malformed
    // after async I/O. stableJson below must never receive cyclic or deeply
    // nested renderer-controlled input.
    && (value.plan === null || validPlan(value.plan, value.snapshotId));
}

/** The child receives only this bounded presentation contract. */
export function isInterviewBrief(value, snapshotId = null) {
  const keys = ['version', 'briefId', 'createdAt', 'inputs', 'role', ...BRIEF_ARRAYS, 'sources'];
  if (!exactKeys(value, keys) || value.version !== BRIEF_VERSION || !SNAPSHOT_ID.test(value.briefId || '')) return false;
  if (!briefText(value.createdAt, 80) || !exactKeys(value.inputs, ['careerSnapshotId', 'jobUrlSha256', 'applicationArtifactId', 'applicationArtifactDigest'])) return false;
  if (!SNAPSHOT_ID.test(value.inputs.careerSnapshotId || '') || (snapshotId && value.inputs.careerSnapshotId !== snapshotId)) return false;
  if (![value.inputs.jobUrlSha256, value.inputs.applicationArtifactId, value.inputs.applicationArtifactDigest].every(item => typeof item === 'string' && SNAPSHOT_ID.test(item))) return false;
  if (!exactKeys(value.role, ['title', 'company', 'location', 'summary'])
    || !['title', 'company', 'location'].every(key => briefText(value.role[key]))
    || !briefText(value.role.summary, MAX_BRIEF_TEXT, { allowEmpty: true })) return false;
  if (!['roleThemes', 'likelyQuestions', 'questionsToAsk', 'warnings'].every(key => briefTextArray(value[key]))
    || !evidenceItems(value.companyFacts) || !evidenceItems(value.recentContext)
    || !positioningItems(value.applicationPositioning) || !sources(value.sources)) return false;
  const allEvidence = [...value.companyFacts, ...value.recentContext];
  if (!allEvidence.every(item => item.sourceId === sha256(item.sourceUrl).slice(0, 16))) return false;
  return isSameJson(value.sources, derivedSources(value))
    && value.briefId === sha256(stableJson(briefSemantic(value)));
}

/** Validate all candidate-plan branches before any recursive stable comparison. */
function validPlan(plan, snapshotId) {
  if (!exactKeys(plan, ['status', 'message', 'snapshotId', 'analysis', 'missingComponents', 'steps', 'evidence'])
    || plan.status !== 'supported' || plan.snapshotId !== snapshotId || !planText(plan.message, 512)) return false;
  const analysis = plan.analysis;
  if (!exactKeys(analysis, ['transcript', 'terms', 'intent', 'askedComponents']) || !planText(analysis.transcript, MAX_QUESTION)
    || !planText(analysis.intent, 64) || !planStringArray(analysis.terms, MAX_PLAN_TERMS, 256) || !planStringArray(analysis.askedComponents, 8, 64)) return false;
  if (!planStringArray(plan.missingComponents, 3, 64) || !Array.isArray(plan.steps) || plan.steps.length < 1 || plan.steps.length > INTERVIEW_HELPER_MAX_STEPS || !Array.isArray(plan.evidence) || plan.evidence.length !== plan.steps.length) return false;
  const provenanceKeys = ['entityType', 'entityId', 'roleId', 'sourceField', 'evidenceSegmentIds', 'directEvidenceSegmentIds'];
  const matchKeys = ['score', 'terms', 'phrases', 'concepts'];
  for (const step of plan.steps) {
    if (!exactKeys(step, ['id', 'label', 'cue', 'provenance', 'match']) || !planText(step.id, MAX_PLAN_ID) || !planText(step.label, 512) || !planText(step.cue)) return false;
    if (!exactKeys(step.provenance, provenanceKeys) || !['string', 'object'].includes(typeof step.provenance.roleId)
      || !PLAN_ENTITY_TYPES.has(step.provenance.entityType) || !planText(step.provenance.entityId, MAX_PLAN_ENTITY_ID)
      || !(step.provenance.roleId === null || planText(step.provenance.roleId, MAX_PLAN_ENTITY_ID))
      || !PLAN_SOURCE_FIELDS.has(step.provenance.sourceField)
      || !planStringArray(step.provenance.evidenceSegmentIds, 128, MAX_PLAN_ENTITY_ID) || !planStringArray(step.provenance.directEvidenceSegmentIds, 128, MAX_PLAN_ENTITY_ID)) return false;
    if (!exactKeys(step.match, matchKeys) || !Number.isSafeInteger(step.match.score) || step.match.score < 0 || step.match.score > MAX_PLAN_SCORE
      || !planStringArray(step.match.terms, MAX_PLAN_TERMS, 256)
      || !planStringArray(step.match.phrases, MAX_PLAN_TERMS, 512) || !planStringArray(step.match.concepts, 16, 64)) return false;
  }
  return plan.evidence.every(item => exactKeys(item, ['id', 'entityId', 'entityType', 'score'])
    && planText(item.id, MAX_PLAN_ID) && planText(item.entityId, MAX_PLAN_ENTITY_ID)
    && PLAN_ENTITY_TYPES.has(item.entityType)
    && Number.isSafeInteger(item.score) && item.score >= 0 && item.score <= MAX_PLAN_SCORE);
}

function displayString(value, maximum = MAX_TEXT) {
  if (!boundedText(value, maximum)) return '';
  // Control and bidi override characters make a compact, security-sensitive
  // evidence rail misleading. They are not meaningful display content here.
  return [...value].filter(character => {
    const code = character.codePointAt(0);
    return code > 0x1f && (code < 0x7f || code > 0x9f)
      && ![0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069].includes(code);
  }).join('').slice(0, maximum);
}

// Unlike metadata derived for the child, a persisted rail's text was already
// checked by validPlan. Return it exactly so tabs/newlines and long, approved
// career evidence do not silently change at the window boundary.
function displayPlanText(value, maximum = MAX_PLAN_TEXT) {
  return planText(value, maximum) ? value : '';
}

function bankMatchesBrief(bank, brief, snapshotId, snapshot = null) {
  return isInterviewAnswerBank(bank, snapshot ? { snapshot, brief } : {
    snapshotId, briefId: brief.briefId, applicationArtifactId: brief.inputs.applicationArtifactId,
    applicationArtifactDigest: brief.inputs.applicationArtifactDigest, jobUrlSha256: brief.inputs.jobUrlSha256,
  });
}

function projectAnswerCard(card, bank) {
  if (!card) return null;
  const optionalExtension = prepareInterviewExtensionCandidates({ cards: [card], evidence: bank.evidence })[card.id] || [];
  const cited = new Set([card.headline, ...card.bullets, card.example, ...optionalExtension].flatMap(statement => statement.evidenceIds));
  return Object.freeze({
    id: card.id, question: card.question, headline: card.headline.text, headlineEvidenceIds: [...card.headline.evidenceIds],
    thinEvidence: card.thinEvidence === true,
    bullets: Object.freeze(card.bullets.map(item => Object.freeze({ stage: item.stage, text: item.text, evidenceIds: [...item.evidenceIds] }))),
    example: Object.freeze({ text: card.example.text, evidenceIds: [...card.example.evidenceIds] }),
    optionalExtension: Object.freeze(optionalExtension.map(item => Object.freeze({
      id: item.id, text: item.text, exampleHook: item.exampleHook, sourceLabel: item.sourceLabel, evidenceIds: [...item.evidenceIds],
    }))),
    consistency: Object.freeze({ consistentWithResume: card.consistency.consistentWithResume, resumeQuote: card.consistency.resumeQuote }),
    evidence: Object.freeze(bank.evidence.filter(item => cited.has(item.id)).map(item => Object.freeze({ id: item.id, quote: item.text, sourceLabel: item.sourceLabel }))),
  });
}

// Editable Q&A (interviewQaStore) is layered over the sealed bank. The sealed
// bank still proves the brief/snapshot binding; the live list decides which
// cards exist, in what scope, and with what (possibly user-written) text.
const LIVE_CARDS = new WeakMap();
const CARD_META = new WeakMap();
const OVERLAY_CARDS = new WeakSet();
export const cardsOf = bank => (bank ? LIVE_CARDS.get(bank) || bank.cards : []);
const statementOf = value => (typeof value === 'string' ? value : value?.text || '');
const sameCardText = (left, right) => statementOf(left.headline) === statementOf(right.headline)
  && statementOf(left.example) === statementOf(right.example)
  && JSON.stringify((left.bullets || []).map(statementOf)) === JSON.stringify((right.bullets || []).map(statementOf));

/** Build the live card list for a sealed bank from stored Q&A cards. */
export function attachInterviewLiveCards(bank, storeCards) {
  if (!bank) return bank;
  if (!Array.isArray(storeCards) || !storeCards.length) { LIVE_CARDS.delete(bank); return bank; }
  const sealedById = new Map(bank.cards.map(card => [card.id, card]));
  const live = storeCards.map(stored => {
    const meta = Object.freeze({ scope: stored.scope === 'foundation' ? 'foundation' : 'company', origin: stored.origin || 'catalog',
      source: stored.source && typeof stored.source.url === 'string' ? Object.freeze({ url: stored.source.url, date: String(stored.source.date || 'unknown'), quote: String(stored.source.quote || '') }) : null,
      author: stored.author === 'user' ? 'user' : 'generated' });
    const sealed = sealedById.get(stored.id);
    // An unedited card from this same preparation is the sealed object itself.
    const card = sealed && sealed.question === stored.question && meta.author !== 'user' && sameCardText(sealed, stored) ? sealed : (() => {
      const overlay = Object.freeze({ ...stored });
      OVERLAY_CARDS.add(overlay);
      return overlay;
    })();
    const answered = !!(statementOf(card.headline).trim() || (card.bullets || []).some(item => statementOf(item).trim()) || statementOf(card.example).trim());
    CARD_META.set(card, Object.freeze({ ...meta, status: answered ? 'ready' : meta.origin === 'disclosed' ? 'needs-prep' : 'empty' }));
    return card;
  });
  LIVE_CARDS.set(bank, Object.freeze(live));
  return bank;
}

function projectOverlayCard(card, bank) {
  const statement = value => Object.freeze({ text: statementOf(value), evidenceIds: [...(Array.isArray(value?.evidenceIds) ? value.evidenceIds : [])] });
  const cited = new Set([card.headline, ...(card.bullets || []), card.example].flatMap(item => (Array.isArray(item?.evidenceIds) ? item.evidenceIds : [])));
  return Object.freeze({
    id: card.id, question: card.question, headline: statementOf(card.headline), headlineEvidenceIds: [...(card.headline?.evidenceIds || [])],
    thinEvidence: card.thinEvidence === true,
    bullets: Object.freeze((card.bullets || []).filter(item => statementOf(item).trim()).map(item => Object.freeze({ stage: typeof item?.stage === 'string' ? item.stage : 'point', ...statement(item) }))),
    example: statement(card.example),
    optionalExtension: Object.freeze((card.extensions || []).filter(item => statementOf(item).trim()).map((item, index) => Object.freeze({
      id: typeof item?.id === 'string' ? item.id : `ext-${index + 1}`, text: statementOf(item), exampleHook: '', sourceLabel: '', evidenceIds: [...(item?.evidenceIds || [])],
    }))),
    consistency: Object.freeze({ consistentWithResume: card.consistency?.consistentWithResume === true, resumeQuote: String(card.consistency?.resumeQuote || '') }),
    evidence: Object.freeze(bank.evidence.filter(item => cited.has(item.id)).map(item => Object.freeze({ id: item.id, quote: item.text, sourceLabel: item.sourceLabel }))),
  });
}

function projectLiveCard(card, bank) {
  if (!card) return null;
  const projected = OVERLAY_CARDS.has(card) ? projectOverlayCard(card, bank) : projectAnswerCard(card, bank);
  const meta = CARD_META.get(card);
  return meta ? Object.freeze({ ...projected, scope: meta.scope, origin: meta.origin, source: meta.source, author: meta.author, status: meta.status }) : projected;
}

function cardSharesExactStory(plan, card, bank) {
  if (!card) return true;
  if (plan?.status !== 'supported') return false;
  const cited = new Set([card.headline, ...card.bullets, card.example].flatMap(item => item.evidenceIds));
  const career = bank.evidence.filter(item => item.kind === 'career' && cited.has(item.id));
  const narrative = plan.steps.filter(step => ['achievement', 'project', 'otherEvidence'].includes(step.provenance.entityType));
  const same = (source, step) => source.entityType === step.provenance.entityType && source.entityId === step.provenance.entityId
    && source.sourceField === step.provenance.sourceField && source.roleId === step.provenance.roleId && source.text === step.cue;
  // A generic career lookup may choose an entirely different story than the
  // job-aware preparation did. Never offer its continuation under this card.
  return career.length > 0 && career.length === narrative.length
    && career.every(source => narrative.some(step => same(source, step)));
}

/** Remove uncited profile objects and all future unrecognized fields. */
export function projectInterviewDisplay({ brief, plan = null, question = null, snapshotId, currentStep, roleAttribution = () => '', answerBank = null, answerCard = null, matching = null }) {
  if (!isInterviewBrief(brief, snapshotId) || (plan !== null && !validPlan(plan, snapshotId))) throw new TypeError('Interview display input is invalid.');
  if (answerBank !== null && !bankMatchesBrief(answerBank, brief, snapshotId)) throw new TypeError('Interview answer bank is stale.');
  if (answerCard !== null && (!answerBank || !cardsOf(answerBank).includes(answerCard))) throw new TypeError('Interview answer card is unavailable.');
  if (answerCard && !cardSharesExactStory(plan, answerCard, answerBank)) plan = null;
  return Object.freeze({
    version: BRIEF_VERSION,
    matching: Object.freeze(matching || { mode: 'auto', effectiveMode: 'recall', approximate: !!plan, p50Ms: null }),
    // Keep the interviewer's wording even when a prepared card has no cue
    // plan. The catalog prompt is a label, not the submitted question.
    question: question === null ? plan?.analysis?.transcript || null : displayString(question, MAX_QUESTION),
    answerCard: projectLiveCard(answerCard, answerBank),
    preview: null,
    plan: plan ? Object.freeze({
      status: plan.status,
      question: displayPlanText(plan.analysis.transcript, MAX_QUESTION),
      currentStep: Math.min(currentStep, plan.steps.length - 1),
      message: displayPlanText(plan.message, 512),
      missingComponents: Array.isArray(plan.missingComponents) ? plan.missingComponents.filter(value => ['decision', 'outcome', 'lesson'].includes(value)) : [],
      steps: plan.steps.map((step, index) => Object.freeze({
      id: displayPlanText(step?.id, MAX_PLAN_ID) || `step-${index + 1}`,
      label: displayPlanText(step?.label, 512),
      cue: displayPlanText(step?.cue),
      roleAttribution: displayString(roleAttribution(step?.provenance?.roleId), 400),
      })),
    }) : null,
    briefing: Object.freeze({
      role: Object.freeze({
        title: displayString(brief.role.title, 300),
        company: displayString(brief.role.company, 300),
        location: displayString(brief.role.location, 300),
        summary: displayString(brief.role.summary),
      }),
      roleThemes: brief.roleThemes.map(item => displayString(item, 800)),
      // Facts/positioning are deliberately reduced to authored display text.
      // Research citations are the sole public provenance: canonical URL plus
      // source date. Opaque source IDs and all candidate/profile/bundle input
      // provenance remain main-only.
      companyFacts: brief.companyFacts.map(item => displayString(item.fact, 1_200)),
      recentContext: brief.recentContext.map(item => displayString(item.fact, 1_200)),
      likelyQuestions: brief.likelyQuestions.map(item => displayString(item, 800)),
      ...(answerBank ? {
        preparedQuestions: cardsOf(answerBank).map(item => item.question),
        preparedCards: Object.freeze(cardsOf(answerBank).map(card => {
          const meta = CARD_META.get(card);
          return Object.freeze({ id: card.id, question: card.question, ...(meta ? { scope: meta.scope, origin: meta.origin, status: meta.status } : {}) });
        })),
      } : {}),
      questionsToAsk: brief.questionsToAsk.map(item => displayString(item, 800)),
      applicationPositioning: brief.applicationPositioning.map(item => displayString(`${item.documentKind === 'resume' ? 'Résumé' : 'Cover letter'}: ${item.point}`, 1_300)),
      warnings: brief.warnings.map(item => displayString(item, 800)),
      sources: Object.freeze(brief.sources.map(item => Object.freeze({
        sourceUrl: displayString(item.sourceUrl, MAX_CITATION_URL),
        sourceDate: displayString(item.sourceDate, MAX_CITATION_DATE),
      }))),
    }),
  });
}

export function isTrustedInterviewNavigation(rawUrl, { devServerUrl = null, distHtmlPath = null } = {}) {
  if (typeof rawUrl !== 'string') return false;
  if (devServerUrl) return rawUrl === childUrl({ devServerUrl, distHtmlPath });
  return typeof distHtmlPath === 'string' && rawUrl === childUrl({ devServerUrl: null, distHtmlPath });
}

function childUrl({ devServerUrl, distHtmlPath }) {
  if (devServerUrl) return new URL('?view=interview', new URL(devServerUrl)).toString();
  return `${pathToFileURL(distHtmlPath).toString()}?view=interview`;
}

function attribution(snapshot, roleId) {
  const role = snapshot?.profile?.roles?.find(item => item?.id === roleId);
  return [role?.title, role?.employer].filter(value => typeof value === 'string' && value.trim()).join(' · ');
}

/**
 * One non-modal, memory-only interview session per canvas owner.  The parent
 * owns authorization and snapshot loading; the child never receives an id or
 * path it can use to retrieve anything else.
 */
export function createInterviewWindowController({
  BrowserWindow = ElectronBrowserWindow,
  ipcMain = electronIpcMain,
  appInstance = app,
  isAuthorizedOwner = () => false,
  loadSnapshot,
  loadBundle = loadInterviewPreparationBundle,
  loadPreparedBrief = loadInterviewPreparedBrief,
  loadAnswerBank = loadInterviewPreparedAnswerBank,
  loadQaCards = loadInterviewQaLiveCards,
  buildPlan = buildInterviewPlan,
  createAudioService = createInterviewCallAudioService,
  createMatcher = createInterviewAiMatcher,
  matcherConfig = interviewAiMatcherConfigFromEnv(process.env),
  matcherTransportFactory,
  requestAi = requestNonApiAi,
  preloadPath = path.join(process.cwd(), 'dist-electron', 'interviewWindowPreload.js'),
  devServerUrl = null,
  distHtmlPath = path.join(process.cwd(), 'dist', 'index.html'),
  registerIpc = true,
} = {}) {
  if (typeof BrowserWindow !== 'function' || !ipcMain || typeof isAuthorizedOwner !== 'function' || typeof loadSnapshot !== 'function' || typeof loadBundle !== 'function' || typeof loadPreparedBrief !== 'function' || typeof loadAnswerBank !== 'function' || typeof buildPlan !== 'function') throw new TypeError('Interview Window dependencies are unavailable.');
  const sessions = new Map();
  // A launch spans async brief/bundle/snapshot reads and the first child
  // navigation. A committed node deletion or owner close landing in that gap
  // finds no session to close, so it cancels the in-flight launch instead.
  const pendingLaunches = new Set();
  const cancelledLaunch = () => new Error('Interview Window launch was cancelled.');
  // Outcome of a first navigation that ended because the companion was closed
  // (by the user, or because the node it had been retargeted to was deleted)
  // rather than because the page failed. Nothing failed and nothing is left to
  // report, so creator and reuse waiters resolve this instead of rejecting.
  const RETIRED = Symbol('interview-window-retired-during-load');
  const RETIRED_RESULT = Object.freeze({ ok: false, closed: true });
  // Electron's own load/abort messages embed the page URL (a local file path
  // when packaged). Only these fixed descriptions cross IPC.
  const LOAD_FAILED_MESSAGE = 'Interview Window could not load its view.';
  const RENDERER_STOPPED_MESSAGE = 'Interview Window renderer stopped while opening.';

  const cancelQuestion = session => {
    if (session.audioTurnId !== undefined) session.suppressedAudioTurn = session.audioTurnId;
    session.speculative?.cancel();
    if (session.display?.preview) session.display = Object.freeze({ ...session.display, preview: null });
    session.questionAbort?.abort();
    session.questionAbort = null;
    session.questionOrigin = null;
    session.questionSequence += 1;
  };
  const ignoredQuestion = (reason, message) => Object.freeze({ ignored: true, reason, message });
  const matchingState = (session, selection = null) => {
    const latency = session.matcher?.getLatency?.() || { p50Ms: null, latencyMode: 'recall' };
    return { ...(selection || {}), mode: session.latencyMode,
      effectiveMode: session.latencyMode === 'auto' ? latency.latencyMode : session.latencyMode,
      p50Ms: latency.p50Ms };
  };
  const ensureMatcher = (session, sealedBank) => {
    // Match over the live (editable) cards; the sealed bank stays the binding.
    const bank = sealedBank && LIVE_CARDS.has(sealedBank) ? { ...sealedBank, cards: cardsOf(sealedBank) } : sealedBank;
    const key = bank ? sha256(stableJson(bank)) : null;
    if (session.matcher && session.matcherKey === key) return session.matcher;
    session.matcher?.close();
    session.matcherKey = key;
    const extensions = sealedBank ? Object.fromEntries(Object.entries(prepareInterviewExtensionCandidates({ ...sealedBank, cards: cardsOf(sealedBank).filter(card => !OVERLAY_CARDS.has(card)) }))
      .map(([cardId, points]) => [cardId, points.map(({ id, text, exampleHook }) => ({ id, text, exampleHook }))])) : {};
    for (const card of cardsOf(sealedBank).filter(item => OVERLAY_CARDS.has(item))) {
      const points = (card.extensions || []).filter(item => statementOf(item).trim()).map((item, index) => ({ id: typeof item?.id === 'string' ? item.id : `ext-${index + 1}`, text: statementOf(item), exampleHook: '' }));
      if (points.length) extensions[card.id] = points;
    }
    session.matcher = createMatcher({ bank, config: matcherConfig, transportFactory: matcherTransportFactory,
      context: { extensions },
      request: options => runWithIpcRequestContext({ sender: session.owner.webContents, nodeId: session.nodeId,
        channel: 'interview-window:submit-question' }, () => requestAi(options)),
    });
    session.speculative?.dispose();
    session.speculative = createInterviewSpeculativeMatcher({ matcher: session.matcher, bank,
      minConfidence: session.matcher.minConfidence ?? matcherConfig.minConfidence ?? 0.55,
      enabled: session.listeningActive === true, isEligible: isInterviewPartialEligible,
      onPreview: preview => {
        if (sessions.get(session.ownerId) !== session) return;
        // Only sealed bank objects can cross the boundary, using precisely
        // the same projection as the locked answer. Model-authored text is
        // never an answer source, even if an adapter adds extra properties.
        const card = preview && cardsOf(sealedBank).find(item => item.id === preview.cardId);
        if (preview && !card) return;
        const projected = preview ? Object.freeze({ id: preview.id, cardId: card.id,
          card: projectLiveCard(card, sealedBank), confidence: preview.confidence,
          transcript: preview.transcript.slice(0, MAX_QUESTION), updatedAt: preview.updatedAt }) : null;
        session.display = Object.freeze({ ...session.display, preview: projected });
        if (!session.closing && !session.child.isDestroyed?.()) session.child.webContents.send?.('interview-window:brief-updated', session.display);
      },
    });
    session.matcher.start().catch(() => {});
    return session.matcher;
  };

  // Loader failures can carry local storage paths in their messages. The
  // canvas and the sandboxed child receive only these fixed descriptions.
  const loadSafely = async (loader, request, message) => {
    try { return await loader(request); } catch { throw new Error(message); }
  };

  // A lifecycle callback belongs to one child session. An old child's late
  // close/load-failure must not remove a replacement for the same owner.
  const remove = (ownerId, expectedSession = null) => {
    const session = sessions.get(ownerId);
    if (!session || (expectedSession && session !== expectedSession)) return false;
    session.audio?.stop();
    cancelQuestion(session);
    session.matcher?.close();
    sessions.delete(ownerId);
    return true;
  };

  const getForChild = sender => [...sessions.values()].find(session => session.child.webContents?.id === sender?.id) || null;
  const getForAudio = event => {
    const session = getForChild(event?.sender);
    if (!session || session.child.webContents !== event.sender || session.closing || session.child.isDestroyed?.()) return null;
    // A child subframe has the same WebContents as the trusted view. Require
    // the main frame as well, never just its URL or a supplied session id.
    if (event.sender.mainFrame && event.senderFrame !== event.sender.mainFrame) return null;
    return session;
  };

  // Attach the helper's editable Q&A to a sealed bank. A store failure leaves
  // the sealed cards in place: preparation already validated those.
  const refreshLiveCards = async (bank, nodeId) => {
    if (!bank || typeof nodeId !== 'string') return bank;
    let cards = null;
    try { cards = await loadQaCards({ userDataPath: appInstance?.getPath?.('userData'), nodeId }); } catch { cards = null; }
    return attachInterviewLiveCards(bank, cards);
  };
  const loadLiveAnswerBank = nodeId => async loaderArgs => refreshLiveCards(await loadAnswerBank(loaderArgs), nodeId);
  const prepare = async (owner, args) => {
    if (!isInterviewWindowLaunchArgs(args) || !isAuthorizedOwner(owner, args.nodeId)) throw new Error('Interview Window launch is not authorized.');
    // The canvas carries a cache/display copy only. Resolve its full record
    // address and require the exact app-owned seal before any portion is used.
    const brief = await loadSafely(loadPreparedBrief, { briefRecordId: args.briefRecordId, brief: args.brief, userDataPath: appInstance?.getPath?.('userData') }, 'Interview Window brief is unavailable or changed.');
    if (!isInterviewBrief(brief, args.snapshotId) || stableJson(brief) !== stableJson(args.brief)
      || brief.inputs.jobUrlSha256 !== sha256(args.jobUrl)
      || brief.inputs.careerSnapshotId !== args.snapshotId) throw new Error('Interview Window brief is unavailable or changed.');
    const bundle = await loadSafely(loadBundle, { artifactId: brief.inputs.applicationArtifactId, userDataPath: appInstance?.getPath?.('userData') }, 'Interview Window application artifact is unavailable or changed.');
    if (!bundle || bundle.artifactId !== brief.inputs.applicationArtifactId
      || bundle.applicationArtifactDigest !== brief.inputs.applicationArtifactDigest) throw new Error('Interview Window application artifact is unavailable or changed.');
    const snapshot = await loadSafely(loadSnapshot, { snapshotId: args.snapshotId, owner, nodeId: args.nodeId, userDataPath: appInstance?.getPath?.('userData') }, 'Interview Window snapshot is unavailable.');
    if (!snapshot || snapshot.snapshotId !== args.snapshotId || !snapshot.profile) throw new Error('Interview Window snapshot is unavailable.');
    const loadedBank = await loadSafely(loadLiveAnswerBank(args.nodeId), { brief, briefRecordId: args.briefRecordId, snapshot, bundle, userDataPath: appInstance?.getPath?.('userData') }, 'Interview Window prepared answers are unavailable.');
    const answerBank = bankMatchesBrief(loadedBank, brief, args.snapshotId, snapshot) ? loadedBank : null;
    if (args.plan === null) return { snapshot, brief, bundle, answerBank, display: projectInterviewDisplay({ brief, snapshotId: args.snapshotId, currentStep: 0, answerBank }) };
    const canonical = buildPlan({ question: args.plan.analysis.transcript, profile: snapshot, snapshotId: args.snapshotId });
    if (!validPlan(canonical, args.snapshotId) || stableJson(canonical) !== stableJson(args.plan)) throw new Error('Interview Window plan is stale or altered.');
    // A parent rail is exact saved evidence, not permission to choose a
    // prepared card lexically. The child selects that card through AI.
    return { snapshot, brief, bundle, answerBank, display: projectInterviewDisplay({ brief, plan: answerBank ? null : canonical,
      question: canonical.analysis.transcript, snapshotId: args.snapshotId, currentStep: args.currentStep,
      roleAttribution: roleId => attribution(snapshot, roleId), answerBank,
      matching: answerBank ? { mode: 'auto', effectiveMode: 'recall', approximate: false, status: 'selecting', p50Ms: null } : null }) };
  };

  const protect = child => {
    child.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
    child.webContents.on?.('will-attach-webview', event => event.preventDefault());
    child.webContents.on?.('will-navigate', (event, url) => {
      if (!isTrustedInterviewNavigation(url, { devServerUrl, distHtmlPath })) event.preventDefault();
    });
  };

  const launch = async (event, args) => {
    const owner = BrowserWindow.fromWebContents?.(event?.sender);
    if (!owner || owner.isDestroyed?.()) throw new Error('Interview Window requires a live canvas owner.');
    const ticket = { owner, ownerId: owner.id, nodeId: typeof args?.nodeId === 'string' ? args.nodeId : null, cancelled: false };
    pendingLaunches.add(ticket);
    try {
      return await launchFor(event, args, owner, ticket);
    } finally {
      pendingLaunches.delete(ticket);
    }
  };

  const launchFor = async (event, args, owner, ticket) => {
    // Capture the id while the owner is live: a lifecycle callback can run
    // after Electron has destroyed the owner object.
    const ownerId = ticket.ownerId;
    const prepared = await prepare(owner, args);
    if (ticket.cancelled || owner.isDestroyed?.()) throw cancelledLaunch();
    const display = prepared.display;
    const brief = prepared.brief;
    const incomingPlanFingerprint = args.plan === null ? null : stableJson(args.plan);
    const existing = sessions.get(ownerId);
    if (existing && !existing.child.isDestroyed?.()) {
      let selectIncoming = false;
      // The supported-rail lock protects this helper's own active interview.
      // Another helper node on the same canvas must not be told its brief
      // opened while the child still shows a different job's locked rail.
      if (existing.locked && existing.nodeId !== args.nodeId) {
        existing.child.focus?.();
        throw new Error('Another Interview Helper on this canvas has an active interview rail.');
      }
      if (existing.nodeId !== args.nodeId || existing.snapshotId !== args.snapshotId || existing.briefRecordId !== args.briefRecordId) existing.audio?.stop();
      // Any supported rail is child-owned until that child explicitly
      // advances. A parent relaunch must never erase or replace active
      // interview state, regardless of whether its plan first came from the
      // canvas or a child submission.
      if (existing.locked) {
        // The rail stays child-owned, but the newer brief and snapshot must
        // not be lost: they take effect when the child explicitly advances.
        existing.pendingParent = { brief, snapshotId: args.snapshotId, briefRecordId: args.briefRecordId, bundle: prepared.bundle, answerBank: prepared.answerBank, snapshot: prepared.snapshot };
      }
      if (!existing.locked) {
        existing.pendingParent = null;
        // A dismissal belongs to the node whose rail was dismissed. The same
        // question on another helper (same career snapshot) is a new rail.
        if (existing.nodeId !== args.nodeId) {
          existing.dismissedPlanFingerprint = null;
          existing.parentPlanFingerprint = null;
        }
        const dismissedIncomingPlan = incomingPlanFingerprint !== null
          && incomingPlanFingerprint === existing.dismissedPlanFingerprint;
        existing.display = dismissedIncomingPlan
          ? projectInterviewDisplay({ brief, snapshotId: args.snapshotId, currentStep: 0, answerBank: prepared.answerBank })
          : display;
        existing.brief = brief;
        existing.briefRecordId = args.briefRecordId;
        existing.bundle = prepared.bundle;
        existing.answerBank = prepared.answerBank;
        existing.listeningSnapshot = prepared.snapshot;
        existing.snapshotId = args.snapshotId;
        existing.nodeId = args.nodeId;
        existing.locked = dismissedIncomingPlan ? false : !!display.answerCard || display.plan?.status === 'supported';
        existing.anchorPlan = existing.display.plan?.status === 'supported' ? args.plan : null;
        if (incomingPlanFingerprint !== null && !dismissedIncomingPlan) {
          existing.parentPlanFingerprint = incomingPlanFingerprint;
          existing.dismissedPlanFingerprint = null;
        }
        cancelQuestion(existing);
        ensureMatcher(existing, existing.answerBank);
        selectIncoming = !!(args.plan && existing.answerBank && !dismissedIncomingPlan);
        existing.display = Object.freeze({ ...existing.display, matching: matchingState(existing, existing.display.matching) });
        existing.child.webContents.send?.('interview-window:brief-updated', existing.display);
      }
      existing.child.focus?.();
      // A reuse racing the first navigation cannot report success before the
      // original navigation has completed. The latest display is retained for
      // the child's initial get-brief request.
      const pendingInitialLoad = existing.initialLoad;
      if (pendingInitialLoad && await pendingInitialLoad === RETIRED) {
        // The companion was closed while it was still opening. Share the
        // creator's outcome: nothing failed, and a window the user closed (or
        // whose node was deleted) is not resurrected.
        if (ticket.cancelled || owner.isDestroyed?.()) throw cancelledLaunch();
        return RETIRED_RESULT;
      }
      if (sessions.get(ownerId) !== existing || existing.child.isDestroyed?.()) {
        // Applies only when the first load settled normally and the child was
        // retired afterwards (a load that is aborted by the close takes the
        // RETIRED path above). Replace that child. The same ticket carries a
        // committed deletion/owner close, so launchFor rejects instead of
        // resurrecting a retired companion.
        return launchFor(event, args, owner, ticket);
      }
      if (selectIncoming) await answerQuestion({ sender: existing.child.webContents }, args.plan.analysis.transcript, false, { cached: true, replace: true });
      return { ok: true, reused: true };
    }
    const child = new BrowserWindow({
      width: 440, height: 680, minWidth: 360, minHeight: 480, resizable: true, parent: owner, modal: false, show: false,
      title: 'Interview Helper', backgroundColor: '#111018',
      webPreferences: { preload: preloadPath, nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    const session = {
      owner, ownerId, child, display, brief, snapshotId: args.snapshotId, nodeId: args.nodeId,
      briefRecordId: args.briefRecordId, bundle: prepared.bundle, answerBank: prepared.answerBank,
      listeningSnapshot: prepared.snapshot, audio: null,
      locked: !!display.answerCard || display.plan?.status === 'supported', questionSequence: 0, initialLoad: null,
      anchorPlan: display.plan?.status === 'supported' ? args.plan : null,
      parentPlanFingerprint: incomingPlanFingerprint, dismissedPlanFingerprint: null, pendingParent: null,
      // The pin is native-window state that outlives the child page; main
      // records it so a reloaded page can restore its checkbox.
      alwaysOnTop: false,
      latencyMode: 'auto', matcher: null, matcherKey: null, questionAbort: null, questionOrigin: null,
      // closing: the window began closing ('close' precedes the abort Electron
      // reports for a pending load). crashed: its renderer process died.
      closing: false, crashed: false,
    };
    sessions.set(ownerId, session);
    ensureMatcher(session, session.answerBank);
    session.display = Object.freeze({ ...session.display, matching: matchingState(session, session.display.matching) });
    child.webContents.on?.('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) { session.audio?.stop(); cancelQuestion(session); }
    });
    // App-wide navigation/quit guards can recognize this restricted child
    // without inferring identity from a URL or caller-controlled value.
    child.webContents.__isInterviewHelperRenderer = true;
    protect(child);
    child.once?.('ready-to-show', () => child.show?.());
    const onOwnerClosed = () => { if (!child.isDestroyed?.()) child.close?.(); remove(ownerId, session); };
    child.once?.('close', () => { session.closing = true; session.audio?.stop(); cancelQuestion(session); session.matcher?.close(); });
    child.once?.('closed', () => { session.closing = true; owner.removeListener?.('closed', onOwnerClosed); remove(ownerId, session); });
    owner.once?.('closed', onOwnerClosed);
    // A crashed child renderer cannot recover its memory-only session. Retire
    // it so a relaunch opens a working child instead of focusing a dead page.
    child.webContents.once?.('render-process-gone', (_event, details) => {
      // A 'clean-exit' is the renderer ending normally (for example while its
      // window is being closed), not a crash: only a real crash is a launch failure.
      session.crashed = details?.reason !== 'clean-exit';
      remove(ownerId, session);
      if (!child.isDestroyed?.()) child.close?.();
    });
    // Normalize a synchronous Electron failure into the same promise path so
    // cleanup and concurrent reuse see one initial-load outcome. A rejection is
    // classified once, here, before the failure path below closes the child
    // itself: creator and reuse waiters then share one outcome.
    const navigation = Promise.resolve().then(() => child.loadURL(childUrl({ devServerUrl, distHtmlPath }))).then(
      () => null,
      error => {
        // Electron rejects a pending loadURL (ERR_ABORTED) when its window
        // closes. That is a retirement, not a load failure.
        if (!session.crashed && (session.closing || sessions.get(ownerId) !== session || child.isDestroyed?.())) return RETIRED;
        logger.error('[interview-window] initial load failed:', error);
        throw new Error(session.crashed ? RENDERER_STOPPED_MESSAGE : LOAD_FAILED_MESSAGE);
      },
    );
    // Electron may reject, or never settle, a pending loadURL when its window
    // closes, so also tie the first navigation to the window's own lifetime.
    const windowEnded = new Promise((resolve, reject) => {
      child.once?.('closed', () => (session.crashed ? reject(new Error(RENDERER_STOPPED_MESSAGE)) : resolve(RETIRED)));
    });
    windowEnded.catch(() => undefined);
    session.initialLoad = Promise.race([navigation, windowEnded]);
    let outcome;
    try {
      outcome = await session.initialLoad;
      session.initialLoad = null;
    } catch (error) {
      owner.removeListener?.('closed', onOwnerClosed);
      remove(ownerId, session);
      if (!child.isDestroyed?.()) child.close?.();
      throw error;
    }
    if (outcome === RETIRED) {
      // Closed while still opening: nothing failed and nothing is left to report.
      owner.removeListener?.('closed', onOwnerClosed);
      remove(ownerId, session);
      if (ticket.cancelled || owner.isDestroyed?.()) throw cancelledLaunch();
      return RETIRED_RESULT;
    }
    if (args.plan && session.answerBank && sessions.get(ownerId) === session && !session.closing) {
      await answerQuestion({ sender: child.webContents }, args.plan.analysis.transcript, false, { cached: true, replace: true });
    }
    return { ok: true, reused: false };
  };

  const getBrief = event => {
    const session = getForChild(event?.sender);
    // The pin is read on this call only: a reloaded page restores its checkbox
    // from here, and no other display payload carries it.
    return session ? { ...session.display, alwaysOnTop: session.alwaysOnTop } : null;
  };
  const answerQuestion = async (event, question, followUp = false, { cached = false, isCurrent = () => true, replace = false, origin = 'user', speculativeSelection = null, allowApproximate = () => true, onIgnored = null, onSelection = () => undefined } = {}) => {
    const session = getForChild(event?.sender);
    if (!session) throw new Error('Interview session is not available.');
    if (typeof question !== 'string' || question.length > MAX_QUESTION || !question.trim()) throw new Error('Interview question is invalid.');
    // Captured speech remains available in the transcript while a deliberate
    // submission is pending. It must never abort or supersede that request.
    if (origin === 'audio' && session.questionOrigin === 'user' && session.questionAbort) {
      onSelection({ stage: 'ignored', reason: 'user-request-pending' });
      session.audio?.notice('Your submitted question is being matched. This audio turn is available in the transcript.');
      return session.display;
    }
    if (followUp) {
      if (!session.locked || !(session.anchorPlan || session.display.answerCard)) return ignoredQuestion('no-selected-story', 'Choose an answer before submitting a follow-up.');
    } else if (session.locked && !replace) return session.display;
    // Audio advancement is transactional: retain the old card, lock and pin
    // until a complete new display can be committed. Failure/Stop never leaves
    // main cleared while the renderer still shows the previous answer.
    let pendingParent = replace ? session.pendingParent : null;
    let target = pendingParent || session;
    const previousQuestion = session.display.question || session.display.plan?.question || '';
    const previousCardId = session.display.answerCard?.id || null;
    const previousCardQuestion = session.display.answerCard?.question || '';
    const previousPlanLocked = session.locked && !!session.anchorPlan;
    const retiredSelection = session.selectionPromise;
    cancelQuestion(session);
    const sequence = session.questionSequence;
    const abort = new AbortController();
    session.questionAbort = abort;
    session.questionOrigin = origin;
    const current = () => isCurrent() && sessions.get(session.ownerId) === session
      && session.questionSequence === sequence && !session.closing;
    const superseded = () => origin === 'user'
      ? ignoredQuestion('superseded', 'This request was superseded by another action. Submit it again to use it.')
      : session.display;
    try {
      let snapshot;
      try {
        snapshot = cached ? (target.snapshot || target.listeningSnapshot) : await loadSafely(loadSnapshot,
          { snapshotId: target.snapshotId, owner: session.owner, nodeId: session.nodeId, userDataPath: appInstance?.getPath?.('userData') },
          'Interview Window snapshot is unavailable.');
      } catch (error) { if (!current()) return superseded(); throw error; }
      if (!current()) return superseded();
      if (!snapshot || snapshot.snapshotId !== target.snapshotId || !snapshot.profile) throw new Error('Interview Window snapshot is unavailable.');
      let loadedBank;
      try {
        loadedBank = cached ? await refreshLiveCards(target.answerBank, session.nodeId) : await loadSafely(loadLiveAnswerBank(session.nodeId),
          { brief: target.brief, briefRecordId: target.briefRecordId, snapshot, bundle: target.bundle, userDataPath: appInstance?.getPath?.('userData') },
          'Interview Window prepared answers are unavailable.');
      } catch (error) { if (!current()) return superseded(); throw error; }
      if (!current()) return superseded();
      let answerBank = bankMatchesBrief(loadedBank, target.brief, target.snapshotId, snapshot) ? loadedBank : null;
      let selection;
      try {
        if (speculativeSelection) selection = await speculativeSelection;
        if (!current()) return superseded();
        if (!selection) {
          // Let an aborted turn release the persistent stream before starting
          // its replacement, including when in-flight speculation abstains.
          if (retiredSelection) await retiredSelection.catch(() => {});
          if (!current()) return superseded();
          const matcher = ensureMatcher(session, answerBank);
          const context = { previousCardId, previousQuestion, previousCardQuestion, previousPlanLocked, signal: abort.signal };
          const pending = matcher.select ? matcher.select({ text: question, partial: false, ...context }) : matcher.match(question, context);
          session.selectionPromise = pending;
          try { selection = await pending; }
          finally { if (session.selectionPromise === pending) session.selectionPromise = null; }
        }
      } catch (error) {
        if (!current() || abort.signal.aborted) return superseded();
        throw error;
      }
      onSelection({ stage: 'matcher', selection, current: current() });
      if (!current()) return superseded();
      if (selection.approximate && !allowApproximate()) return session.display;
      // Classification and card selection share the same AI call. Until it
      // completes, the locked display, anchor and any pending pin stay intact.
      const approximateGate = selection.approximate ? selectInterviewCallQuestion({ text: question }, answerBank) : null;
      const approximateFollowUp = approximateGate?.accepted && approximateGate.dependent
        && session.locked && !!session.anchorPlan;
      if (selection.kind === 'not-question' && !approximateFollowUp) {
        if (origin === 'audio') {
          onIgnored?.();
          return session.display;
        }
        // A user has explicitly asked to use this text. AI abstention may leave
        // us with no prepared answer, but cannot veto the saved-evidence lookup.
        selection = { ...selection, kind: followUp ? 'follow-up' : 'question', cardId: followUp ? previousCardId || 'none' : 'none' };
      }
      followUp = followUp || selection.kind === 'follow-up' || approximateFollowUp;
      if (followUp && pendingParent) {
        // A queued parent update belongs to the next question. A continuation
        // must keep the locked card's original validated pin and evidence.
        pendingParent = null;
        target = session;
        answerBank = session.answerBank;
        snapshot = session.listeningSnapshot;
      }
      if (approximateFollowUp) question = approximateGate.question;
      const anchorPlan = followUp ? session.anchorPlan : null;
      const answerCard = cardsOf(answerBank).find(card => card.id === selection.cardId) || null;
      let plan;
      if (followUp && anchorPlan) {
        const canonical = buildPlan({ question: anchorPlan.analysis.transcript, profile: snapshot, snapshotId: target.snapshotId });
        if (!validPlan(canonical, target.snapshotId) || !isSameJson(canonical, anchorPlan)) throw new Error('Interview Window snapshot is unavailable.');
        plan = buildInterviewFollowUpPlan({ question, anchorPlan: canonical, previousQuestion });
        if (!plan) {
          // The AI (or the user's follow-up form) chose continuation. For wording
          // outside the offline component grammar, retain the exact saved cues;
          // never let a lexical lookup select a different story or invent facts.
          const transcript = `${previousQuestion} ${question}`.trim();
          if (transcript.length > MAX_QUESTION) return ignoredQuestion('follow-up-too-long', 'This follow-up is too long to keep with the selected story. Submit a shorter question.');
          plan = { ...canonical, analysis: { ...canonical.analysis, transcript },
            message: 'Continue the same saved example. Use only the details below; do not invent missing parts.' };
        }
      } else {
        plan = buildPlan({ question, profile: snapshot, snapshotId: target.snapshotId });
      }
      let supported = plan.status === 'supported';
      const sameStory = cardSharesExactStory(plan, answerCard, answerBank);
      let unsupportedMessage = plan.message;
      const matching = matchingState(session, selection);
      // A saved-cue rail is always an approximate relevance fallback, even
      // when AI correctly abstained from selecting a prepared answer.
      if (!answerCard && supported) { matching.approximate = true; matching.label = 'Approximate · saved evidence cues'; }
      let display = null;
      if (supported) {
        try {
          display = projectInterviewDisplay({ brief: target.brief, plan: sameStory ? plan : null, question, snapshotId: target.snapshotId,
            currentStep: 0, roleAttribution: roleId => attribution(snapshot, roleId), answerBank, answerCard, matching });
        } catch {
          supported = false;
          unsupportedMessage = 'Matching saved evidence contains characters this view cannot display safely. Review that career entry before relying on it here.';
        }
      }
      if (!supported) {
        const base = projectInterviewDisplay({ brief: target.brief, plan: null, question, snapshotId: target.snapshotId, currentStep: 0, answerBank, answerCard, matching });
        display = answerCard ? base : Object.freeze({ ...base, plan: Object.freeze({ status: 'unsupported', question: displayString(plan.analysis?.transcript, MAX_QUESTION), currentStep: 0, message: displayString(unsupportedMessage, 800), missingComponents: [], steps: [] }) });
      }
      if (followUp && !supported && !answerCard) throw new Error('Interview Window snapshot is unavailable.');
      if (pendingParent) {
        session.brief = pendingParent.brief;
        session.snapshotId = pendingParent.snapshotId;
        session.briefRecordId = pendingParent.briefRecordId;
        session.bundle = pendingParent.bundle;
        session.pendingParent = null;
      }
      if (replace && session.parentPlanFingerprint !== null) session.dismissedPlanFingerprint = session.parentPlanFingerprint;
      session.display = display;
      session.answerBank = answerBank;
      session.listeningSnapshot = snapshot;
      session.locked = supported || !!answerCard;
      session.anchorPlan = supported && sameStory ? (followUp && anchorPlan ? anchorPlan : plan) : null;
      onSelection({ stage: 'display', question, cardId: answerCard?.id ?? null, supported, followUp });
      session.child.webContents.send?.('interview-window:brief-updated', session.display);
      return session.display;
    } finally {
      if (session.questionAbort === abort) {
        session.questionAbort = null;
        session.questionOrigin = null;
      }
    }
  };
  const submitQuestion = (event, question) => answerQuestion(event, question, false, { replace: true });
  const followUpQuestion = (event, question) => answerQuestion(event, question, true);
  const selectPreparedCard = async (event, cardId) => {
    const session = getForAudio(event);
    if (!session || typeof cardId !== 'string' || !CARD_ID.test(cardId)
      || !session.answerBank?.cards.some(card => card.id === cardId)) throw new Error('Interview prepared answer is unavailable.');
    // A click names an already displayed card, so it retains that display's
    // pin. It supersedes any semantic lookup immediately without waiting for
    // a provider reply or changing the visible answer until validation passes.
    cancelQuestion(session);
    const sequence = session.questionSequence;
    const current = () => sessions.get(session.ownerId) === session
      && session.questionSequence === sequence && !session.closing;
    const snapshot = await loadSafely(loadSnapshot,
      { snapshotId: session.snapshotId, owner: session.owner, nodeId: session.nodeId, userDataPath: appInstance?.getPath?.('userData') },
      'Interview Window snapshot is unavailable.');
    if (!current()) return session.display;
    if (!snapshot || snapshot.snapshotId !== session.snapshotId || !snapshot.profile) throw new Error('Interview Window snapshot is unavailable.');
    const answerBank = await loadSafely(loadLiveAnswerBank(session.nodeId),
      { brief: session.brief, briefRecordId: session.briefRecordId, snapshot, bundle: session.bundle, userDataPath: appInstance?.getPath?.('userData') },
      'Interview Window prepared answers are unavailable.');
    if (!current()) return session.display;
    if (!bankMatchesBrief(answerBank, session.brief, session.snapshotId, snapshot)) throw new Error('Interview prepared answer is unavailable.');
    const answerCard = cardsOf(answerBank).find(card => card.id === cardId);
    if (!answerCard) throw new Error('Interview prepared answer is unavailable.');
    const matching = matchingState(session, { source: 'manual', method: 'manual', approximate: false,
      label: 'Prepared answer selected', kind: 'question', cardId, confidence: 1, reason: null });
    const display = projectInterviewDisplay({ brief: session.brief, snapshotId: session.snapshotId,
      question: answerCard.question, currentStep: 0, answerBank, answerCard, matching });
    if (!current()) return session.display;
    if (session.parentPlanFingerprint !== null) session.dismissedPlanFingerprint = session.parentPlanFingerprint;
    session.display = display;
    session.answerBank = answerBank;
    session.listeningSnapshot = snapshot;
    session.locked = true;
    session.anchorPlan = null;
    session.child.webContents.send?.('interview-window:brief-updated', display);
    return display;
  };
  const advanceQuestion = (event, notify = true) => {
    const session = getForChild(event?.sender);
    if (!session) return null;
    // Also invalidates an in-flight unlocked lookup before clearing state.
    cancelQuestion(session);
    // The canvas may still retain this older submitted plan. Keep its exact
    // canonical fingerprint suppressed until a genuinely different parent
    // plan arrives, so advancing in the child is durable within this session.
    if (session.parentPlanFingerprint !== null) session.dismissedPlanFingerprint = session.parentPlanFingerprint;
    session.locked = false;
    session.anchorPlan = null;
    if (session.pendingParent) {
      session.brief = session.pendingParent.brief;
      session.snapshotId = session.pendingParent.snapshotId;
      session.briefRecordId = session.pendingParent.briefRecordId;
      session.bundle = session.pendingParent.bundle;
      session.answerBank = session.pendingParent.answerBank;
      session.listeningSnapshot = session.pendingParent.snapshot;
      session.pendingParent = null;
    }
    ensureMatcher(session, session.answerBank);
    session.display = projectInterviewDisplay({ brief: session.brief, snapshotId: session.snapshotId, currentStep: 0, answerBank: session.answerBank, matching: matchingState(session) });
    if (notify) session.child.webContents.send?.('interview-window:brief-updated', session.display);
    return session.display;
  };
  const nextQuestion = event => advanceQuestion(event);
  const close = event => { const session = getForChild(event?.sender); if (!session) return false; session.child.close?.(); return true; };
  const setAlwaysOnTop = (event, value) => {
    const session = getForChild(event?.sender);
    if (!session || typeof value !== 'boolean') return false;
    session.child.setAlwaysOnTop?.(value);
    session.alwaysOnTop = value;
    return true;
  };
  const setLatencyMode = (event, value) => {
    const session = getForAudio(event);
    // Keep-going cues are a measured-latency fallback, never a forced layout.
    if (!session || !['auto', 'recall'].includes(value)) throw new Error('Interview display mode is invalid.');
    session.latencyMode = value;
    session.display = Object.freeze({ ...session.display, matching: Object.freeze(matchingState(session, session.display.matching)) });
    session.child.webContents.send?.('interview-window:brief-updated', session.display);
    return session.display;
  };

  const audioFor = session => {
    if (session.audio) return session.audio;
    session.audio = createAudioService({
      helperPath: interviewAudioHelperPath({ packaged: appInstance?.isPackaged === true, projectDir: appInstance?.getAppPath?.() || process.cwd() }),
      onState: state => {
        if (sessions.get(session.ownerId) !== session || session.child.isDestroyed?.()) return;
        if (!session.listeningActive && state.status === 'listening') {
          session.audioTurnId = undefined;
          session.suppressedAudioTurn = undefined;
        }
        session.listeningActive = state.status === 'listening';
        session.speculative?.setListening(session.listeningActive);
        try { session.child.webContents.send?.('interview-window:listening-updated', state); }
        catch { /* A retiring renderer must not hold native capture open. */ }
      },
      onPartial: partial => {
        if (sessions.get(session.ownerId) !== session || session.closing || !session.listeningActive) return;
        session.audioTurnId = partial.turnId;
        if (session.questionOrigin === 'user') session.suppressedAudioTurn = partial.turnId;
        if (session.pendingParent || session.suppressedAudioTurn === partial.turnId) return;
        ensureMatcher(session, session.answerBank);
        session.speculative.partial(partial, {
          previousCardId: session.display.answerCard?.id || null,
          previousCardQuestion: session.display.answerCard?.question || '',
          previousQuestion: session.display.question || '',
          previousPlanLocked: session.locked && !!session.anchorPlan,
        });
      },
      onQuestion: async (endpoint, isCurrent, reportSelection = () => undefined) => {
        if (!isCurrent() || sessions.get(session.ownerId) !== session || session.closing) return;
        if (session.questionOrigin === 'user' || session.suppressedAudioTurn !== undefined && session.suppressedAudioTurn === endpoint.id) {
          session.speculative?.cancel();
          return;
        }
        const speculativeSelection = session.speculative?.endpoint(endpoint) || null;
        // Also clear a preview for legacy/injected endpoints without an id.
        session.speculative?.cancel();
        const selection = selectInterviewCallQuestion(endpoint, session.pendingParent?.answerBank || session.answerBank, { semantic: true });
        reportSelection({ stage: 'semantic-gate', ...selection });
        if (!selection.accepted) {
          session.audio.notice(selection.reason === 'too-long'
            ? AUDIO_NOTICES.tooLong
            : selection.reason?.startsWith('multipart')
            ? AUDIO_NOTICES.multipart
            : AUDIO_NOTICES.notMatched);
          return;
        }
        const childEvent = { sender: session.child.webContents };
        await answerQuestion(childEvent, selection.question, false, { cached: true, isCurrent, replace: true, origin: 'audio',
          speculativeSelection,
          onSelection: reportSelection,
          onIgnored: () => {
            reportSelection({ stage: 'ignored', reason: 'not-question' });
            session.audio.notice(AUDIO_NOTICES.notMatched);
          },
          allowApproximate: () => {
            // Only an unavailable AI activates the old conservative audio
            // gate. Never let its lexical tail extraction drop other parts.
            const fallback = selectInterviewCallQuestion(endpoint, session.pendingParent?.answerBank || session.answerBank);
            reportSelection({ stage: 'approximate-gate', ...fallback });
            if (fallback.dependent && !(session.locked && session.anchorPlan)) {
              reportSelection({ stage: 'approximate-gate', accepted: false, reason: 'no-selected-story' });
              session.audio.notice(AUDIO_NOTICES.noStory);
              return false;
            }
            if (!fallback.accepted) session.audio.notice(fallback.reason?.startsWith('multipart')
              ? AUDIO_NOTICES.multipart
              : AUDIO_NOTICES.notMatched);
            return fallback.accepted;
          },
        });
      },
    });
    return session.audio;
  };
  const getListeningState = event => {
    const session = getForAudio(event);
    if (!session) throw new Error('Interview session is not available.');
    return session.audio?.getState() || idleInterviewListeningState();
  };
  const startListening = event => {
    const session = getForAudio(event);
    if (!session) throw new Error('Interview session is not available.');
    return audioFor(session).start();
  };
  const stopListening = event => {
    const session = getForAudio(event);
    if (!session) throw new Error('Interview session is not available.');
    session.listeningActive = false;
    session.speculative?.setListening(false);
    if (session.questionOrigin === 'audio') cancelQuestion(session);
    return session.audio?.stop() || idleInterviewListeningState();
  };
  const useTranscriptQuestion = async event => {
    const session = getForAudio(event);
    if (!session) throw new Error('Interview session is not available.');
    const question = session.audio?.getQuestion();
    if (typeof question !== 'string' || !question.trim() || question.length > MAX_QUESTION) throw new Error('Interview question is invalid.');
    const followUp = isDependentInterviewFollowUp(question) && session.locked && !!(session.anchorPlan || session.display.answerCard);
    return answerQuestion(event, question, followUp, { replace: !followUp });
  };

  if (registerIpc) {
    ipcMain.handle('interview-window:launch', launch);
    ipcMain.handle('interview-window:get-brief', getBrief);
    ipcMain.handle('interview-window:close', close);
    ipcMain.handle('interview-window:set-always-on-top', setAlwaysOnTop);
    ipcMain.handle('interview-window:set-latency-mode', setLatencyMode);
    ipcMain.handle('interview-window:submit-question', submitQuestion);
    ipcMain.handle('interview-window:follow-up-question', followUpQuestion);
    ipcMain.handle('interview-window:select-prepared-card', selectPreparedCard);
    ipcMain.handle('interview-window:next-question', nextQuestion);
    ipcMain.handle('interview-window:get-listening-state', getListeningState);
    ipcMain.handle('interview-window:start-listening', startListening);
    ipcMain.handle('interview-window:stop-listening', stopListening);
    ipcMain.handle('interview-window:use-transcript-question', useTranscriptQuestion);
  }
  const cleanupBySenderAndNode = (sender, nodeId) => {
    if (typeof nodeId !== 'string' || !NODE_ID.test(nodeId)) return false;
    const owner = BrowserWindow.fromWebContents?.(sender);
    if (!owner || owner.isDestroyed?.()) return false;
    if (owner.webContents === sender) {
      for (const ticket of pendingLaunches) if (ticket.ownerId === owner.id && ticket.nodeId === nodeId) ticket.cancelled = true;
    }
    const session = sessions.get(owner.id);
    // Cancellation IPC originates in the canvas renderer. Require both that
    // exact sender and its exact helper node so a sibling canvas or helper
    // cannot close this companion window.
    if (!session || session.owner !== owner || owner.webContents !== sender || session.nodeId !== nodeId) return false;
    try {
      if (!session.child.isDestroyed?.()) session.child.close?.();
    } catch {
      return false;
    }
    remove(owner.id, session);
    return true;
  };

  // Runs from the owner's 'closed' handler, after Electron already treats the
  // window as destroyed and most property reads (including `id`) throw. Match
  // by object identity or a caller-supplied numeric id; never read the owner.
  const cleanupOwner = owner => {
    const matches = value => (typeof owner === 'number' ? value.ownerId === owner : value.owner === owner);
    for (const ticket of pendingLaunches) if (matches(ticket)) ticket.cancelled = true;
    for (const [ownerId, session] of [...sessions]) {
      if (!matches(session)) continue;
      if (!session.child.isDestroyed?.()) session.child.close?.();
      remove(ownerId, session);
    }
  };

  return Object.freeze({ launch, getBrief, submitQuestion, followUpQuestion, selectPreparedCard, nextQuestion, close, setAlwaysOnTop, setLatencyMode, getListeningState, startListening, stopListening, useTranscriptQuestion, isInterviewChildWebContents: contents => !!getForChild(contents), cleanupBySenderAndNode, cleanupOwner, sessionCount: () => sessions.size, sessions });
}
