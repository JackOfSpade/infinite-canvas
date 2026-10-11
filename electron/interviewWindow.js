import electronPkg from 'electron';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildInterviewPlan, canonicalInterviewJobUrl, INTERVIEW_HELPER_MAX_STEPS } from '../src/utils/interviewHelper.js';
import { loadInterviewPreparationBundle, loadInterviewPreparedBrief } from './ipc/interviewPreparation.js';
import { logger } from './logger.js';

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

/** Remove provenance, profile objects, and all future unrecognized fields. */
export function projectInterviewDisplay({ brief, plan = null, snapshotId, currentStep, roleAttribution = () => '' }) {
  if (!isInterviewBrief(brief, snapshotId) || (plan !== null && !validPlan(plan, snapshotId))) throw new TypeError('Interview display input is invalid.');
  return Object.freeze({
    version: BRIEF_VERSION,
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
  buildPlan = buildInterviewPlan,
  preloadPath = path.join(process.cwd(), 'dist-electron', 'interviewWindowPreload.js'),
  devServerUrl = null,
  distHtmlPath = path.join(process.cwd(), 'dist', 'index.html'),
  registerIpc = true,
} = {}) {
  if (typeof BrowserWindow !== 'function' || !ipcMain || typeof isAuthorizedOwner !== 'function' || typeof loadSnapshot !== 'function' || typeof loadBundle !== 'function' || typeof loadPreparedBrief !== 'function' || typeof buildPlan !== 'function') throw new TypeError('Interview Window dependencies are unavailable.');
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
    sessions.delete(ownerId);
    return true;
  };

  const getForChild = sender => [...sessions.values()].find(session => session.child.webContents?.id === sender?.id) || null;

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
    if (args.plan === null) return { snapshot, brief, display: projectInterviewDisplay({ brief, snapshotId: args.snapshotId, currentStep: 0 }) };
    const canonical = buildPlan({ question: args.plan.analysis.transcript, profile: snapshot, snapshotId: args.snapshotId });
    if (!validPlan(canonical, args.snapshotId) || stableJson(canonical) !== stableJson(args.plan)) throw new Error('Interview Window plan is stale or altered.');
    return { snapshot, brief, display: projectInterviewDisplay({ brief, plan: canonical, snapshotId: args.snapshotId, currentStep: args.currentStep, roleAttribution: roleId => attribution(snapshot, roleId) }) };
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
      // The supported-rail lock protects this helper's own active interview.
      // Another helper node on the same canvas must not be told its brief
      // opened while the child still shows a different job's locked rail.
      if (existing.locked && existing.nodeId !== args.nodeId) {
        existing.child.focus?.();
        throw new Error('Another Interview Helper on this canvas has an active interview rail.');
      }
      // Any supported rail is child-owned until that child explicitly
      // advances. A parent relaunch must never erase or replace active
      // interview state, regardless of whether its plan first came from the
      // canvas or a child submission.
      if (existing.locked) {
        // The rail stays child-owned, but the newer brief and snapshot must
        // not be lost: they take effect when the child explicitly advances.
        existing.pendingParent = { brief, snapshotId: args.snapshotId };
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
          ? projectInterviewDisplay({ brief, snapshotId: args.snapshotId, currentStep: 0 })
          : display;
        existing.brief = brief;
        existing.snapshotId = args.snapshotId;
        existing.nodeId = args.nodeId;
        existing.locked = dismissedIncomingPlan ? false : display.plan?.status === 'supported';
        if (incomingPlanFingerprint !== null && !dismissedIncomingPlan) {
          existing.parentPlanFingerprint = incomingPlanFingerprint;
          existing.dismissedPlanFingerprint = null;
        }
        existing.questionSequence += 1;
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
      return { ok: true, reused: true };
    }
    const child = new BrowserWindow({
      width: 440, height: 680, minWidth: 360, minHeight: 480, resizable: true, parent: owner, modal: false, show: false,
      title: 'Interview Helper', backgroundColor: '#111018',
      webPreferences: { preload: preloadPath, nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    const session = {
      owner, ownerId, child, display, brief, snapshotId: args.snapshotId, nodeId: args.nodeId,
      locked: display.plan?.status === 'supported', questionSequence: 0, initialLoad: null,
      parentPlanFingerprint: incomingPlanFingerprint, dismissedPlanFingerprint: null, pendingParent: null,
      // The pin is native-window state that outlives the child page; main
      // records it so a reloaded page can restore its checkbox.
      alwaysOnTop: false,
      // closing: the window began closing ('close' precedes the abort Electron
      // reports for a pending load). crashed: its renderer process died.
      closing: false, crashed: false,
    };
    sessions.set(ownerId, session);
    // App-wide navigation/quit guards can recognize this restricted child
    // without inferring identity from a URL or caller-controlled value.
    child.webContents.__isInterviewHelperRenderer = true;
    protect(child);
    child.once?.('ready-to-show', () => child.show?.());
    const onOwnerClosed = () => { if (!child.isDestroyed?.()) child.close?.(); remove(ownerId, session); };
    child.once?.('close', () => { session.closing = true; });
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
    return { ok: true, reused: false };
  };

  const getBrief = event => {
    const session = getForChild(event?.sender);
    // The pin is read on this call only: a reloaded page restores its checkbox
    // from here, and no other display payload carries it.
    return session ? { ...session.display, alwaysOnTop: session.alwaysOnTop } : null;
  };
  const submitQuestion = async (event, question) => {
    const session = getForChild(event?.sender);
    if (!session) throw new Error('Interview session is not available.');
    if (typeof question !== 'string' || question.length > MAX_QUESTION || !question.trim()) throw new Error('Interview question is invalid.');
    // A supported rail is an intentionally locked, main-owned session state.
    // Repeated submit calls cannot replace it until this child explicitly asks
    // to advance, even when callers race each other.
    if (session.locked) return session.display;
    const sequence = ++session.questionSequence;
    const requestedSnapshotId = session.snapshotId;
    let snapshot = null; let failure = null;
    try {
      snapshot = await loadSafely(loadSnapshot, { snapshotId: requestedSnapshotId, owner: session.owner, nodeId: session.nodeId, userDataPath: appInstance?.getPath?.('userData') }, 'Interview Window snapshot is unavailable.');
    } catch (error) { failure = error; }
    // A parent relaunch or a later question supersedes this read. Judge the
    // fence first, or a snapshot change mid-read reports a false error.
    if (sessions.get(session.ownerId) !== session || session.questionSequence !== sequence) return session.display;
    if (failure) throw failure;
    if (!snapshot || snapshot.snapshotId !== session.snapshotId || !snapshot.profile) throw new Error('Interview Window snapshot is unavailable.');
    const plan = buildPlan({ question, profile: snapshot, snapshotId: session.snapshotId });
    // Unsupported is an intentional, truthful state rather than a prompt to invent.
    let supported = plan.status === 'supported';
    let unsupportedMessage = plan.message;
    let display = null;
    if (supported) {
      try {
        display = projectInterviewDisplay({ brief: session.brief, plan, snapshotId: session.snapshotId, currentStep: 0, roleAttribution: roleId => attribution(snapshot, roleId) });
      } catch {
        // Matching saved evidence that the rail grammar cannot carry (for
        // example an invisible format character in a cue) is reported
        // truthfully rather than as an invalid question.
        supported = false;
        unsupportedMessage = 'Matching saved evidence contains characters this view cannot display safely. Review that career entry before relying on it here.';
      }
    }
    if (!supported) {
      const base = projectInterviewDisplay({ brief: session.brief, plan: null, snapshotId: session.snapshotId, currentStep: 0 });
      display = Object.freeze({ ...base, plan: Object.freeze({ status: 'unsupported', question: displayString(plan.analysis?.transcript, MAX_QUESTION), currentStep: 0, message: displayString(unsupportedMessage, 800), missingComponents: [], steps: [] }) });
    }
    session.display = display;
    session.locked = supported;
    session.child.webContents.send?.('interview-window:brief-updated', session.display);
    return session.display;
  };
  const nextQuestion = event => {
    const session = getForChild(event?.sender);
    if (!session) return null;
    // Also invalidates an in-flight unlocked lookup before clearing state.
    session.questionSequence += 1;
    // The canvas may still retain this older submitted plan. Keep its exact
    // canonical fingerprint suppressed until a genuinely different parent
    // plan arrives, so advancing in the child is durable within this session.
    if (session.parentPlanFingerprint !== null) session.dismissedPlanFingerprint = session.parentPlanFingerprint;
    session.locked = false;
    if (session.pendingParent) {
      session.brief = session.pendingParent.brief;
      session.snapshotId = session.pendingParent.snapshotId;
      session.pendingParent = null;
    }
    session.display = projectInterviewDisplay({ brief: session.brief, snapshotId: session.snapshotId, currentStep: 0 });
    session.child.webContents.send?.('interview-window:brief-updated', session.display);
    return session.display;
  };
  const close = event => { const session = getForChild(event?.sender); if (!session) return false; session.child.close?.(); return true; };
  const setAlwaysOnTop = (event, value) => {
    const session = getForChild(event?.sender);
    if (!session || typeof value !== 'boolean') return false;
    session.child.setAlwaysOnTop?.(value);
    session.alwaysOnTop = value;
    return true;
  };

  if (registerIpc) {
    ipcMain.handle('interview-window:launch', launch);
    ipcMain.handle('interview-window:get-brief', getBrief);
    ipcMain.handle('interview-window:close', close);
    ipcMain.handle('interview-window:set-always-on-top', setAlwaysOnTop);
    ipcMain.handle('interview-window:submit-question', submitQuestion);
    ipcMain.handle('interview-window:next-question', nextQuestion);
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

  return Object.freeze({ launch, getBrief, submitQuestion, nextQuestion, close, setAlwaysOnTop, isInterviewChildWebContents: contents => !!getForChild(contents), cleanupBySenderAndNode, cleanupOwner, sessionCount: () => sessions.size, sessions });
}
