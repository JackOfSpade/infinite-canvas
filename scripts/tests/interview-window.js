import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { assert } from './testHelpers.js';
import { buildInterviewPlan } from '../../src/utils/interviewHelper.js';
import { createInterviewWindowController, isTrustedInterviewNavigation } from '../../electron/interviewWindow.js';
import { interviewPreparedBriefRecordId } from '../../electron/ipc/interviewPreparation.js';
import { registerNetworkHandlers } from '../../electron/ipc/network.js';
import { getRecentLogs } from '../../electron/logger.js';
import { interviewSubmitErrorMessage, INVALID_QUESTION_MESSAGE, SESSION_ENDED_MESSAGE, EVIDENCE_UNAVAILABLE_MESSAGE, SUBMIT_FAILED_MESSAGE } from '../../src/interview-window/submitError.js';

const SNAPSHOT = 'a'.repeat(64);
const JOB_URL = 'https://jobs.example.test/product-manager';

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

const tick = () => new Promise(resolve => setImmediate(resolve));

// Resolves to the value or the rejection, and to a HUNG error rather than
// hanging the runner when a launch never settles.
function settle(promise, ms = 1_000) {
  let timer;
  const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(new Error('HUNG: the launch never settled')), ms); });
  return Promise.race([promise.then(value => value, error => error), deadline]).finally(() => clearTimeout(timer));
}

// The controller logs a genuine first-navigation failure with its raw cause.
// Keep the expected log lines out of the test output.
async function withQuietConsoleError(run) {
  const original = console.error;
  console.error = () => undefined;
  try { return await run(); } finally { console.error = original; }
}

// Electron's own wording for a load that is aborted by its window closing.
const abortedLoad = url => Object.assign(new Error(`ERR_ABORTED (-3) loading '${url}'`), { errno: -3, code: 'ERR_ABORTED' });

function signBrief(value) {
  const semantic = {
    version: value.version, inputs: value.inputs, role: value.role,
    roleThemes: value.roleThemes, companyFacts: value.companyFacts, recentContext: value.recentContext,
    likelyQuestions: value.likelyQuestions, questionsToAsk: value.questionsToAsk,
    applicationPositioning: value.applicationPositioning, warnings: value.warnings,
  };
  value.briefId = sha256(stableJson(semantic));
  return value;
}

function profile() {
  return { snapshotId: SNAPSHOT, profile: {
    roles: [{ id: 'role-1', title: 'Product Manager', employer: 'Acme' }],
    achievements: [{ id: 'achievement-1', roleId: 'role-1', claim: 'Improved onboarding conversion through a simpler setup flow.', technologies: [], metrics: [] }],
    projects: [], skills: [], education: [], certifications: [], otherEvidence: [],
  } };
}

function brief() {
  const sourceUrl = 'https://private.test/raw'; const sourceId = sha256(sourceUrl).slice(0, 16);
  return signBrief({ version: 1, briefId: '', createdAt: '2026-10-08T00:00:00.000Z',
    inputs: { careerSnapshotId: SNAPSHOT, jobUrlSha256: sha256(JOB_URL), applicationArtifactId: 'e'.repeat(64), applicationArtifactDigest: 'd'.repeat(64) },
    role: { title: 'Product Manager', company: 'Acme', location: 'Toronto', summary: 'Own onboarding.' },
    // This is the compact shape returned by interviewPreparation and persisted
    // by the canvas: quote provenance was already checked main-side and is
    // intentionally absent here.
    roleThemes: ['Product strategy'], companyFacts: [{ fact: 'B2B SaaS', sourceId, sourceUrl, sourceDate: '2026' }], recentContext: [{ fact: 'New onboarding launch', sourceId, sourceUrl, sourceDate: '2026' }], likelyQuestions: ['How do you measure impact?'], questionsToAsk: ['What is success?'], applicationPositioning: [{ documentKind: 'resume', point: 'Conversion experience' }], warnings: ['Verify recent facts'],
    sources: [{ sourceId, sourceUrl, sourceDate: '2026' }],
  });
}

function briefWithDistinctSources(count) {
  const value = brief();
  value.companyFacts = []; value.recentContext = []; value.sources = [];
  for (let index = 0; index < count; index += 1) {
    const sourceUrl = `https://private.test/raw/${index}`;
    const sourceId = sha256(sourceUrl).slice(0, 16);
    const item = { fact: `Research fact ${index}`, sourceId, sourceUrl, sourceDate: '2026-01-01' };
    if (index < 8) value.companyFacts.push(item); else value.recentContext.push(item);
    value.sources.push({ sourceId, sourceUrl, sourceDate: '2026-01-01' });
  }
  return signBrief(value);
}

function memoryPreparedBriefs(...briefs) {
  const records = new Map(briefs.map(item => [interviewPreparedBriefRecordId(item), item]));
  return async ({ briefRecordId, brief: candidate }) => {
    const stored = records.get(briefRecordId);
    return stored && stableJson(stored) === stableJson(candidate) ? stored : null;
  };
}

class FakeWebContents extends EventEmitter {
  constructor(id) { super(); this.id = id; this.sent = []; }
  setWindowOpenHandler(handler) { this.windowOpen = handler; }
  send(channel, value) { this.sent.push({ channel, value }); }
}

class FakeWindow extends EventEmitter {
  static windows = new Map();
  static fromWebContents(contents) { return FakeWindow.windows.get(contents?.id) || null; }
  static nextId = 100;
  static loadURLHandler = null;
  constructor(options = {}) { super(); this.id = FakeWindow.nextId++; this.options = options; this.webContents = new FakeWebContents(this.id + 1000); this.destroyed = false; this.focused = false; FakeWindow.windows.set(this.webContents.id, this); }
  isDestroyed() { return this.destroyed; }
  async loadURL(url) {
    this.url = url;
    if (FakeWindow.loadURLHandler) return FakeWindow.loadURLHandler(this, url);
    if (FakeWindow.failLoad) throw new Error('load failed');
  }
  focus() { this.focused = true; }
  show() { this.shown = true; }
  close() { if (this.destroyed) return; this.emit('close'); this.destroyed = true; this.emit('closed'); }
  setAlwaysOnTop(value) { this.alwaysOnTop = value; }
}

function makeController({ authorized = true, additionalOwners = [], loadBundle = async args => ({ artifactId: args.artifactId, applicationArtifactDigest: 'd'.repeat(64) }), storedBrief = brief(), loadPreparedBrief, loadSnapshot = async () => profile() } = {}) {
  const owner = new FakeWindow();
  const authorizedOwners = new Set([owner, ...additionalOwners]);
  const briefRecordId = interviewPreparedBriefRecordId(storedBrief);
  const controller = createInterviewWindowController({ BrowserWindow: FakeWindow, ipcMain: { handle() {} }, registerIpc: false,
    isAuthorizedOwner: value => authorized && authorizedOwners.has(value),
    loadSnapshot, loadBundle,
    loadPreparedBrief: loadPreparedBrief || (async args => args.briefRecordId === briefRecordId && stableJson(args.brief) === stableJson(storedBrief) ? storedBrief : null),
    devServerUrl: 'http://localhost:5173/', preloadPath: '/narrow-preload.cjs' });
  const question = 'How did you improve onboarding conversion?';
  const plan = buildInterviewPlan({ question, profile: profile(), snapshotId: SNAPSHOT });
  return { owner, controller, args: { nodeId: 'interview_node_1', snapshotId: SNAPSHOT, jobUrl: JOB_URL, briefRecordId, brief: structuredClone(storedBrief), plan, currentStep: 0 } };
}

export default [
  {
    name: 'interview window: narrow preload exposes only sender-bound next-question route',
    run() {
      const preload = fs.readFileSync(new URL('../../electron/interviewWindowPreload.js', import.meta.url), 'utf8');
      assert(preload.includes("nextQuestion: () => ipcRenderer.invoke('interview-window:next-question')"), 'narrow preload must expose the sender-bound nextQuestion method');
      assert(!preload.includes('electronAPI'), 'narrow preload must not reuse the broad canvas bridge');
    },
  },
  {
    name: 'interview window: only an authorized live canvas sender launches a bounded projected narrow child',
    async run() {
      const { owner, controller, args } = makeController();
      const result = await controller.launch({ sender: owner.webContents }, args);
      assert(result.ok && !result.reused && controller.sessionCount() === 1, 'authorized owner should create one child session');
      const child = [...controller.sessions.values()][0].child;
      assert(child.options.parent === owner && child.options.modal === false && child.options.width === 440
        && child.options.title === 'Interview Helper' && child.options.backgroundColor === '#111018', 'child must be a compact non-modal owned window with its ready-state visual shell');
      assert(child.options.webPreferences.nodeIntegration === false && child.options.webPreferences.contextIsolation && child.options.webPreferences.sandbox, 'child must receive hardened narrow web preferences');
      assert(child.webContents.__isInterviewHelperRenderer === true && controller.isInterviewChildWebContents(child.webContents), 'child must be marked for app-wide main-process guards before navigation');
      const display = controller.getBrief({ sender: child.webContents });
      assert(display.briefing.companyFacts[0] === 'B2B SaaS', 'safe company fact should remain visible');
      const citation = display.briefing.sources[0];
      assert(display.briefing.sources.length === 1
        && Object.keys(citation).sort().join(',') === 'sourceDate,sourceUrl'
        && citation.sourceUrl === args.brief.sources[0].sourceUrl
        && citation.sourceDate === args.brief.sources[0].sourceDate,
      'the child must receive one bounded, presentation-only canonical research citation');
      const serialized = JSON.stringify(display);
      assert(serialized.includes('https://private.test/raw')
        && !serialized.includes(args.brief.sources[0].sourceId)
        && !serialized.includes(args.brief.inputs.careerSnapshotId)
        && !serialized.includes(args.brief.inputs.applicationArtifactId)
        && !serialized.includes(args.brief.inputs.applicationArtifactDigest),
      'public research citations may cross, but opaque source ids and candidate/profile/bundle provenance must remain private');
      assert(controller.getBrief({ sender: owner.webContents }) === null, 'canvas sender cannot impersonate a child get request');

      const hostile = makeController();
      hostile.args.brief.role.title = `Product${String.fromCodePoint(0x202e)} Manager`;
      signBrief(hostile.args.brief);
      await hostile.controller.launch({ sender: hostile.owner.webContents }, hostile.args).then(
        () => { throw new Error('a control-bearing public brief unexpectedly launched'); },
        () => undefined,
      );
      assert(hostile.controller.sessionCount() === 0, 'the child boundary must reject persisted public-brief controls rather than accept a looser contract');
    },
  },
  {
    name: 'interview window: rejects unauthorized, altered, and stale plans before a child registry entry exists',
    async run() {
      const denied = makeController({ authorized: false });
      await denied.controller.launch({ sender: denied.owner.webContents }, denied.args).then(() => { throw new Error('unauthorized launch unexpectedly accepted'); }, () => undefined);
      assert(denied.controller.sessionCount() === 0, 'unauthorized sender must not allocate a session');
      const altered = makeController(); altered.args.plan = structuredClone(altered.args.plan); altered.args.plan.steps[0].cue = 'invented';
      await altered.controller.launch({ sender: altered.owner.webContents }, altered.args).then(() => { throw new Error('altered plan unexpectedly accepted'); }, () => undefined);
      assert(altered.controller.sessionCount() === 0, 'altered plan must be rejected before allocation');
      const cyclic = makeController(); cyclic.args.plan = { ...cyclic.args.plan, cyclic: null }; cyclic.args.plan.cyclic = cyclic.args.plan;
      await cyclic.controller.launch({ sender: cyclic.owner.webContents }, cyclic.args).then(() => { throw new Error('cyclic plan unexpectedly accepted'); }, () => undefined);
      assert(cyclic.controller.sessionCount() === 0, 'unbounded/cyclic candidate shape must be rejected before canonical comparison');
    },
  },
  {
    name: 'interview window: rejects malformed cyclic and deeply nested plans before async preparation',
    async run() {
      let bundleCalls = 0;
      const loadBundle = async args => {
        bundleCalls += 1;
        return { artifactId: args.artifactId, applicationArtifactDigest: 'd'.repeat(64) };
      };
      const cyclic = makeController({ loadBundle });
      cyclic.args.plan = structuredClone(cyclic.args.plan);
      cyclic.args.plan.cyclic = cyclic.args.plan;
      await cyclic.controller.launch({ sender: cyclic.owner.webContents }, cyclic.args).then(
        () => { throw new Error('cyclic plan unexpectedly accepted'); },
        () => undefined,
      );
      assert(bundleCalls === 0 && cyclic.controller.sessionCount() === 0, 'cyclic plan must be rejected before bundle or snapshot preparation');

      const deep = makeController({ loadBundle });
      let nested = {};
      for (let index = 0; index < 4_000; index += 1) nested = { next: nested };
      deep.args.plan = { ...deep.args.plan, analysis: nested };
      await deep.controller.launch({ sender: deep.owner.webContents }, deep.args).then(
        () => { throw new Error('deep malformed plan unexpectedly accepted'); },
        () => undefined,
      );
      assert(bundleCalls === 0 && deep.controller.sessionCount() === 0, 'deep malformed plan must be rejected before any recursive comparison');
    },
  },
  {
    name: 'interview window: binds launch to the canonical job URL, semantic brief, derived sources, and current application artifact',
    async run() {
      const cases = [
        ['fact', args => { args.brief.companyFacts[0].fact = 'Hand-edited fact'; }],
        ['source URL', args => { args.brief.companyFacts[0].sourceUrl = 'https://other.test/raw'; }],
        ['source record', args => { args.brief.sources[0].sourceId = 'forged-source'; }],
        ['job URL', args => { args.jobUrl = 'https://jobs.example.test/other-role'; }],
      ];
      for (const [kind, alter] of cases) {
        const candidate = makeController(); alter(candidate.args);
        await candidate.controller.launch({ sender: candidate.owner.webContents }, candidate.args).then(
          () => { throw new Error(`tampered ${kind} unexpectedly accepted`); },
          () => undefined,
        );
        assert(candidate.controller.sessionCount() === 0, `tampered ${kind} must be rejected before allocating a child`);
      }
      for (const loadBundle of [async () => null, async args => ({ artifactId: args.artifactId, applicationArtifactDigest: 'f'.repeat(64) })]) {
        const candidate = makeController({ loadBundle });
        await candidate.controller.launch({ sender: candidate.owner.webContents }, candidate.args).then(
          () => { throw new Error('missing or changed application artifact unexpectedly accepted'); },
          () => undefined,
        );
        assert(candidate.controller.sessionCount() === 0, 'missing or changed application artifact must be rejected before allocating a child');
      }
    },
  },
  {
    name: 'interview window: accepts only an exact main-published prepared brief record',
    async run() {
      const forged = brief();
      // The ordinary semantic ID is deliberately easy for a renderer to
      // recompute. Its absence from the main-owned record store must still
      // deny launch before bundle/snapshot work begins.
      const missing = makeController({ loadPreparedBrief: async () => null });
      await missing.controller.launch({ sender: missing.owner.webContents }, missing.args).then(
        () => { throw new Error('a self-hashed forged brief unexpectedly launched without a main record'); },
        () => undefined,
      );
      assert(missing.controller.sessionCount() === 0, 'a valid-looking renderer brief must not launch without a published main record');

      const stored = brief(); const altered = structuredClone(stored);
      altered.createdAt = '2026-10-08T01:00:00.000Z'; signBrief(altered);
      const changed = makeController({ storedBrief: stored });
      changed.args.brief = altered; changed.args.briefRecordId = interviewPreparedBriefRecordId(altered);
      await changed.controller.launch({ sender: changed.owner.webContents }, changed.args).then(
        () => { throw new Error('an altered full-record brief unexpectedly launched'); },
        () => undefined,
      );
      assert(changed.controller.sessionCount() === 0, 'createdAt/content changes must require their own exact main-published record');

      const accepted = makeController({ storedBrief: forged });
      await accepted.controller.launch({ sender: accepted.owner.webContents }, accepted.args);
      assert(accepted.controller.sessionCount() === 1, 'an exact main-published fixture record must launch');
    },
  },
  {
    name: 'interview window: accepts the complete compact role contract and all 16 derived sources',
    async run() {
      const completeBrief = brief(); completeBrief.role.summary = ''; signBrief(completeBrief);
      const complete = makeController({ storedBrief: completeBrief });
      await complete.controller.launch({ sender: complete.owner.webContents }, complete.args);
      assert(complete.controller.sessionCount() === 1, 'a complete role with an empty optional summary must launch');

      const sixteen = makeController({ storedBrief: briefWithDistinctSources(16) });
      await sixteen.controller.launch({ sender: sixteen.owner.webContents }, sixteen.args);
      const sixteenChild = [...sixteen.controller.sessions.values()][0].child;
      const citations = sixteen.controller.getBrief({ sender: sixteenChild.webContents }).briefing.sources;
      assert(sixteen.controller.sessionCount() === 1 && citations.length === 16
        && citations.every(item => Object.keys(item).sort().join(',') === 'sourceDate,sourceUrl')
        && citations[15].sourceUrl === 'https://private.test/raw/15',
      'the eight-plus-eight research projection must launch with all 16 bounded public citations');

      const seventeen = makeController(); seventeen.args.brief = briefWithDistinctSources(17);
      await seventeen.controller.launch({ sender: seventeen.owner.webContents }, seventeen.args).then(
        () => { throw new Error('a 17-source compact brief unexpectedly launched'); },
        () => undefined,
      );
      assert(seventeen.controller.sessionCount() === 0, 'a constructible 17-source public brief must be rejected before child allocation');
    },
  },
  {
    name: 'interview window: preserves a canvas-valid long evidence rail without truncation',
    async run() {
      const owner = new FakeWindow();
      const longEntityId = `achievement-${'x'.repeat(700)}`;
      const exactCue = `Improved onboarding conversion through ${'documented detail '.repeat(500)}`;
      const wideProfile = {
        snapshotId: SNAPSHOT,
        profile: {
          roles: [{ id: 'role-1', title: 'Product Manager', employer: 'Acme' }],
          achievements: [{
            id: longEntityId,
            roleId: 'role-1',
            claim: exactCue,
            technologies: [],
            metrics: [],
            evidenceSegmentIds: Array.from({ length: 100 }, (_, index) => `segment-${String(index).padStart(4, '0')}`),
          }],
          projects: [], skills: [], education: [], certifications: [], otherEvidence: [],
        },
      };
      const plan = buildInterviewPlan({ question: 'How did you improve onboarding conversion?', profile: wideProfile, snapshotId: SNAPSHOT });
      assert(plan.status === 'supported' && plan.steps.some(step => step.cue === exactCue), 'fixture must produce an exact long, grounded canvas rail');
      const storedBrief = brief(); const briefRecordId = interviewPreparedBriefRecordId(storedBrief);
      const controller = createInterviewWindowController({
        BrowserWindow: FakeWindow,
        ipcMain: { handle() {} },
        registerIpc: false,
        isAuthorizedOwner: value => value === owner,
        loadSnapshot: async () => wideProfile,
        loadBundle: async args => ({ artifactId: args.artifactId, applicationArtifactDigest: 'd'.repeat(64) }),
        loadPreparedBrief: async args => args.briefRecordId === briefRecordId && stableJson(args.brief) === stableJson(storedBrief) ? storedBrief : null,
        devServerUrl: 'http://localhost:5173/',
        preloadPath: '/narrow-preload.cjs',
      });
      await controller.launch({ sender: owner.webContents }, {
        nodeId: 'interview_node_long_rail', snapshotId: SNAPSHOT, jobUrl: JOB_URL,
        briefRecordId, brief: storedBrief, plan, currentStep: 0,
      });
      const child = [...controller.sessions.values()][0].child;
      const displayedStep = controller.getBrief({ sender: child.webContents }).plan.steps.find(step => step.cue === exactCue);
      assert(displayedStep?.cue === exactCue,
        'a verified 12k-bounded canvas cue must cross into the child exactly, not be rejected or sliced');
    },
  },
  {
    name: 'interview window: singleton sessions update, bind submit to child sender, and clean up with owner',
    async run() {
      const original = brief();
      const updatedBrief = structuredClone(original); updatedBrief.createdAt = '2026-10-08T01:00:00.000Z'; updatedBrief.role.title = 'Senior Product Manager'; signBrief(updatedBrief);
      const { owner, controller, args } = makeController({ storedBrief: original, loadPreparedBrief: memoryPreparedBriefs(original, updatedBrief) });
      await controller.launch({ sender: owner.webContents }, args);
      const child = [...controller.sessions.values()][0].child;
      const updated = { ...structuredClone(args), brief: updatedBrief, briefRecordId: interviewPreparedBriefRecordId(updatedBrief) };
      const result = await controller.launch({ sender: owner.webContents }, updated);
      assert(result.reused && controller.sessionCount() === 1 && child.focused, 'later launch should focus the existing child');
      await controller.submitQuestion({ sender: owner.webContents }, 'How did you improve onboarding conversion?').then(() => { throw new Error('owner submit unexpectedly accepted'); }, () => undefined);
      const locked = await controller.submitQuestion({ sender: child.webContents }, 'How did you improve onboarding conversion?');
      assert(locked.plan.status === 'supported' && child.webContents.sent.filter(item => item.channel === 'interview-window:brief-updated').length === 0, 'a supported launch rail must ignore further submissions and parent updates until Next question');
      assert(await controller.nextQuestion({ sender: owner.webContents }) === null, 'owner sender must not clear the child session');
      const cleared = await controller.nextQuestion({ sender: child.webContents });
      assert(cleared.plan === null && controller.getBrief({ sender: child.webContents }).plan === null, 'authenticated Next question must clear the main-owned plan for reload/getBrief');
      updated.plan = null;
      await controller.launch({ sender: owner.webContents }, updated);
      const display = await controller.submitQuestion({ sender: child.webContents }, 'How did you improve onboarding conversion?');
      assert(display.plan.status === 'supported' && child.webContents.sent.some(item => item.channel === 'interview-window:brief-updated'), 'only child sender can run its pinned deterministic question lookup');
      assert(display.briefing.role.title === 'Senior Product Manager', 'reused session must retain the newest brief for later child submissions');
      owner.close();
      assert(controller.sessionCount() === 0 && child.destroyed, 'owner close must close and remove the child session');
    },
  },
  {
    name: 'interview window: committed node-deletion cancellation closes only its matching companion',
    async run() {
      const secondOwner = new FakeWindow();
      const { owner, controller, args } = makeController({ additionalOwners: [secondOwner] });
      const secondArgs = { ...structuredClone(args), nodeId: 'interview_node_2' };
      await controller.launch({ sender: owner.webContents }, args);
      await controller.launch({ sender: secondOwner.webContents }, secondArgs);
      const firstChild = controller.sessions.get(owner.id).child;
      const secondChild = controller.sessions.get(secondOwner.id).child;
      const listeners = new Map();
      registerNetworkHandlers({
        ipcMainInstance: {
          on: (channel, handler) => listeners.set(channel, handler),
          handle: () => undefined,
        },
        registerHandler: () => undefined,
        onNodeDeleted: (sender, nodeId) => controller.cleanupBySenderAndNode(sender, nodeId),
      });
      const cancel = listeners.get('cancel-node-task');
      cancel({ sender: owner.webContents }, args.nodeId, 'user-reset');
      assert(!firstChild.destroyed && !secondChild.destroyed && controller.sessionCount() === 2,
        'non-deletion cancellation must not retire an interview companion');
      cancel({ sender: owner.webContents }, secondArgs.nodeId, 'node-deleted');
      assert(!firstChild.destroyed && !secondChild.destroyed && controller.sessionCount() === 2,
        'a canvas sender must not close another node or canvas companion');
      cancel({ sender: owner.webContents }, args.nodeId, 'node-deleted');
      assert(firstChild.destroyed && !secondChild.destroyed && controller.sessionCount() === 1,
        'a committed exact-node deletion must close only that node\'s companion');
      return { exactNodeClosed: firstChild.destroyed, siblingPreserved: !secondChild.destroyed };
    },
  },
  {
    name: 'interview window: parent relaunch cannot replace a child-created locked rail',
    async run() {
      const { owner, controller, args } = makeController();
      args.plan = null;
      await controller.launch({ sender: owner.webContents }, args);
      const child = controller.sessions.get(owner.id).child;
      const submitted = await controller.submitQuestion({ sender: child.webContents }, 'How did you improve onboarding conversion?');
      const lockedRail = stableJson(submitted);
      await controller.launch({ sender: owner.webContents }, args);
      const different = structuredClone(args);
      different.plan = buildInterviewPlan({ question: 'Tell me about improving onboarding conversion.', profile: profile(), snapshotId: SNAPSHOT });
      await controller.launch({ sender: owner.webContents }, different);
      // get-brief additionally reports the main-owned pin; it is not part of the rail.
      const { alwaysOnTop: pinned, ...shown } = controller.getBrief({ sender: child.webContents });
      assert(pinned === false && stableJson(shown) === lockedRail, 'null or different parent relaunches must preserve a supported child-created rail until Next question');
    },
  },
  {
    name: 'interview window: parent relaunch cannot replace a canvas-created supported rail',
    async run() {
      const original = brief(); const changedBrief = structuredClone(original);
      changedBrief.createdAt = '2026-10-08T01:00:00.000Z'; changedBrief.role.title = 'Changed by parent'; signBrief(changedBrief);
      const { owner, controller, args } = makeController({ storedBrief: original, loadPreparedBrief: memoryPreparedBriefs(original, changedBrief) });
      await controller.launch({ sender: owner.webContents }, args);
      const child = controller.sessions.get(owner.id).child;
      const lockedRail = stableJson(controller.getBrief({ sender: child.webContents }));
      const nullRelaunch = structuredClone(args);
      nullRelaunch.plan = null;
      nullRelaunch.brief = changedBrief;
      nullRelaunch.briefRecordId = interviewPreparedBriefRecordId(changedBrief);
      await controller.launch({ sender: owner.webContents }, nullRelaunch);
      const different = structuredClone(args);
      different.plan = buildInterviewPlan({ question: 'Tell me about improving onboarding conversion.', profile: profile(), snapshotId: SNAPSHOT });
      await controller.launch({ sender: owner.webContents }, different);
      assert(stableJson(controller.getBrief({ sender: child.webContents })) === lockedRail, 'null or different parent relaunches must preserve a canvas-created supported rail until Next question');
      await controller.nextQuestion({ sender: child.webContents });
      await controller.launch({ sender: owner.webContents }, nullRelaunch);
      assert(controller.getBrief({ sender: child.webContents }).plan === null && controller.getBrief({ sender: child.webContents }).briefing.role.title === 'Changed by parent', 'parent updates may apply after the authenticated child advances');
    },
  },
  {
    name: 'interview window: next question suppresses an exact stale canvas plan until it changes',
    async run() {
      const { owner, controller, args } = makeController();
      await controller.launch({ sender: owner.webContents }, args);
      const child = controller.sessions.get(owner.id).child;
      await controller.nextQuestion({ sender: child.webContents });
      await controller.launch({ sender: owner.webContents }, args);
      assert(controller.getBrief({ sender: child.webContents }).plan === null, 'the exact canvas plan dismissed by Next question must not resurrect on parent relaunch');
      const fresh = structuredClone(args);
      fresh.plan = buildInterviewPlan({ question: 'Tell me about improving onboarding conversion.', profile: profile(), snapshotId: SNAPSHOT });
      await controller.launch({ sender: owner.webContents }, fresh);
      assert(controller.getBrief({ sender: child.webContents }).plan?.question === fresh.plan.analysis.transcript, 'a genuinely different canvas plan may replace the dismissed one');
    },
  },
  {
    name: 'interview window: unsupported lookup remains unlocked for an immediate truthful retry',
    async run() {
      const { owner, controller, args } = makeController();
      args.plan = null;
      await controller.launch({ sender: owner.webContents }, args);
      const child = [...controller.sessions.values()][0].child;
      const unsupported = await controller.submitQuestion({ sender: child.webContents }, 'How do you negotiate a real-estate lease?');
      assert(unsupported.plan.status === 'unsupported', 'no-fit lookup should display the truthful unsupported result');
      const supported = await controller.submitQuestion({ sender: child.webContents }, 'How did you improve onboarding conversion?');
      assert(supported.plan.status === 'supported', 'unsupported result must leave the authenticated child unlocked for another question');
    },
  },
  {
    name: 'interview window: failed initial navigation and close/reopen leave no session or owner-close listeners behind',
    async run() {
      const failed = makeController(); FakeWindow.failLoad = true;
      try {
        await withQuietConsoleError(() => failed.controller.launch({ sender: failed.owner.webContents }, failed.args).then(() => { throw new Error('failed navigation unexpectedly launched'); }, () => undefined));
        assert(failed.controller.sessionCount() === 0 && failed.owner.listenerCount('closed') === 0, 'failed initial navigation must fully clean session and owner listener');
      } finally { FakeWindow.failLoad = false; }
      const reopened = makeController();
      await reopened.controller.launch({ sender: reopened.owner.webContents }, reopened.args);
      const first = [...reopened.controller.sessions.values()][0].child;
      first.close();
      assert(reopened.owner.listenerCount('closed') === 0, 'child close must remove its owner-close listener');
      await reopened.controller.launch({ sender: reopened.owner.webContents }, reopened.args);
      const second = [...reopened.controller.sessions.values()][0].child;
      assert(second !== first && reopened.owner.listenerCount('closed') === 1, 'reopen should install exactly one fresh owner listener');
      second.close();
      assert(reopened.owner.listenerCount('closed') === 0, 'second close must also release owner listener');
    },
  },
  {
    name: 'interview window: delayed old-child cleanup cannot remove a replacement session',
    async run() {
      const { owner, controller, args } = makeController();
      const pendingLoads = [];
      FakeWindow.loadURLHandler = child => new Promise((resolve, reject) => pendingLoads.push({ child, resolve, reject }));
      try {
        const first = controller.launch({ sender: owner.webContents }, args).then(value => value, error => error);
        await new Promise(resolve => setImmediate(resolve));
        const oldChild = controller.sessions.get(owner.id).child;
        oldChild.close();
        FakeWindow.loadURLHandler = null;
        const replacement = await controller.launch({ sender: owner.webContents }, args);
        const replacementSession = controller.sessions.get(owner.id);
        assert(replacement.ok && !replacement.reused && replacementSession.child !== oldChild, 'a closed initial child should be replaced for the live owner');
        pendingLoads[0].reject(new Error('old child load failed after replacement'));
        const firstError = await first;
        // The old child was closed mid-load: that launch is a closed outcome, and the replacement stays untouched.
        assert(firstError?.closed === true && controller.sessions.get(owner.id) === replacementSession && !replacementSession.child.destroyed, 'a delayed old child failure must not remove or close the replacement session');
      } finally {
        FakeWindow.loadURLHandler = null;
      }
    },
  },
  {
    name: 'interview window: overlapping reuse waits for the initial child navigation',
    async run() {
      const original = brief();
      const updatedBrief = structuredClone(original); updatedBrief.createdAt = '2026-10-08T01:00:00.000Z'; updatedBrief.role.title = 'Senior Product Manager'; signBrief(updatedBrief);
      const { owner, controller, args } = makeController({ storedBrief: original, loadPreparedBrief: memoryPreparedBriefs(original, updatedBrief) });
      args.plan = null;
      const pendingLoads = [];
      FakeWindow.loadURLHandler = child => new Promise(resolve => pendingLoads.push({ child, resolve }));
      try {
        const first = controller.launch({ sender: owner.webContents }, args);
        await new Promise(resolve => setImmediate(resolve));
        const child = controller.sessions.get(owner.id).child;
        const updated = { ...structuredClone(args), brief: updatedBrief, briefRecordId: interviewPreparedBriefRecordId(updatedBrief) };
        let reuseSettled = false;
        const reuse = controller.launch({ sender: owner.webContents }, updated).then(result => {
          reuseSettled = true;
          return result;
        });
        await Promise.resolve();
        assert(!reuseSettled, 'reuse must wait while the child initial navigation is pending');
        pendingLoads[0].resolve();
        const [opened, reused] = await Promise.all([first, reuse]);
        assert(opened.ok && !opened.reused && reused.ok && reused.reused, 'overlapping launches should report their distinct completed outcomes');
        assert(controller.sessions.get(owner.id).child === child && controller.getBrief({ sender: child.webContents }).briefing.role.title === 'Senior Product Manager', 'the child must retain the newer launch display once initial navigation completes');
      } finally {
        FakeWindow.loadURLHandler = null;
      }
    },
  },
  {
    name: 'interview window: later question submissions fence slower earlier snapshot reads',
    async run() {
      const owner = new FakeWindow();
      const pending = [];
      let initial = true;
      const storedBrief = brief(); const briefRecordId = interviewPreparedBriefRecordId(storedBrief);
      const controller = createInterviewWindowController({ BrowserWindow: FakeWindow, ipcMain: { handle() {} }, registerIpc: false,
        isAuthorizedOwner: value => value === owner,
        loadSnapshot: () => initial ? Promise.resolve(profile()) : new Promise(resolve => pending.push(resolve)),
        loadBundle: async args => ({ artifactId: args.artifactId, applicationArtifactDigest: 'd'.repeat(64) }),
        loadPreparedBrief: async args => args.briefRecordId === briefRecordId && stableJson(args.brief) === stableJson(storedBrief) ? storedBrief : null,
        devServerUrl: 'http://localhost:5173/' });
      const question = 'How did you improve onboarding conversion?';
      await controller.launch({ sender: owner.webContents }, { nodeId: 'interview_node_1', snapshotId: SNAPSHOT, jobUrl: JOB_URL, briefRecordId, brief: storedBrief, plan: null, currentStep: 0 });
      initial = false;
      const child = [...controller.sessions.values()][0].child;
      const early = controller.submitQuestion({ sender: child.webContents }, question);
      const lateQuestion = 'Tell me about improving onboarding conversion.';
      const late = controller.submitQuestion({ sender: child.webContents }, lateQuestion);
      pending[1](profile()); await late;
      pending[0](profile()); await early;
      assert(controller.getBrief({ sender: child.webContents }).plan.question === 'Tell me about improving onboarding conversion', 'older delayed submit must not overwrite the latest question result');
      const lockedResult = await controller.submitQuestion({ sender: child.webContents }, question);
      assert(lockedResult.plan.question === 'Tell me about improving onboarding conversion' && pending.length === 2, 'double submit after a supported result must be ignored without another snapshot read');
    },
  },
  {
    name: 'interview window: blocks popups, webviews, and remote navigation',
    async run() {
      const { owner, controller, args } = makeController(); await controller.launch({ sender: owner.webContents }, args);
      const child = [...controller.sessions.values()][0].child;
      assert(child.webContents.windowOpen('https://example.test').action === 'deny', 'all popups must be denied');
      let blocked = false; child.webContents.emit('will-navigate', { preventDefault() { blocked = true; } }, 'https://example.test/?view=interview');
      assert(blocked, 'remote navigation must be denied');
      assert(isTrustedInterviewNavigation('http://localhost:5173/?view=interview', { devServerUrl: 'http://localhost:5173/' }), 'exact development child URL should be trusted');
      assert(!isTrustedInterviewNavigation('http://localhost:5173/?view=interview&x=1', { devServerUrl: 'http://localhost:5173/' }), 'child URL must not accept caller data in query parameters');
      assert(isTrustedInterviewNavigation('http://localhost:5173/canvas/?view=interview', { devServerUrl: 'http://localhost:5173/canvas/' }), 'configured development base path must be part of the exact trusted child URL');
      assert(!isTrustedInterviewNavigation('http://localhost:5173/?view=interview', { devServerUrl: 'http://localhost:5173/canvas/' }), 'root must not be overallowed when development has a base path');
    },
  },
  {
    name: 'interview window: node deletion or owner close during launch preparation cancels that launch',
    async run() {
      for (const retire of ['node-deleted', 'owner-closed']) {
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const { owner, controller, args } = makeController({ loadSnapshot: async () => { await gate; return profile(); } });
        const windowsBefore = FakeWindow.nextId;
        const pending = controller.launch({ sender: owner.webContents }, args).then(() => null, error => error);
        await new Promise(resolve => setImmediate(resolve));
        if (retire === 'node-deleted') {
          assert(controller.cleanupBySenderAndNode(owner.webContents, 'interview_node_other') === false, 'a different node id has nothing to close');
          controller.cleanupBySenderAndNode(owner.webContents, args.nodeId);
        } else {
          controller.cleanupOwner(owner);
        }
        release();
        const error = await pending;
        assert(error && /cancelled/u.test(error.message), `${retire} during preparation must reject the in-flight launch`);
        assert(controller.sessionCount() === 0 && FakeWindow.nextId === windowsBefore, `${retire} during preparation must not open a companion window`);
      }
      // A sibling node's deletion, or a different canvas sender, never cancels this launch.
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      const otherOwner = new FakeWindow();
      const { owner, controller, args } = makeController({ additionalOwners: [otherOwner], loadSnapshot: async () => { await gate; return profile(); } });
      const pending = controller.launch({ sender: owner.webContents }, args);
      await new Promise(resolve => setImmediate(resolve));
      controller.cleanupBySenderAndNode(owner.webContents, 'interview_node_2');
      controller.cleanupBySenderAndNode(otherOwner.webContents, args.nodeId);
      release();
      const opened = await pending;
      assert(opened.ok && controller.sessionCount() === 1, 'only the exact owner and node may cancel an in-flight launch');
    },
  },
  {
    name: 'interview window: a deletion while a reuse awaits first navigation never resurrects the companion',
    async run() {
      const { owner, controller, args } = makeController();
      args.plan = null;
      const pendingLoads = [];
      // Only the first child's navigation is held; a resurrected child would load at once.
      FakeWindow.loadURLHandler = child => pendingLoads.length ? Promise.resolve() : new Promise((resolve, reject) => pendingLoads.push({ child, resolve, reject }));
      try {
        const first = controller.launch({ sender: owner.webContents }, args).then(result => result, error => error);
        await new Promise(resolve => setImmediate(resolve));
        const reuse = controller.launch({ sender: owner.webContents }, structuredClone(args)).then(result => result, error => error);
        await new Promise(resolve => setImmediate(resolve));
        const windowsBefore = FakeWindow.nextId;
        assert(controller.cleanupBySenderAndNode(owner.webContents, args.nodeId) === true, 'the committed deletion closes the loading companion');
        // Electron rejects the pending load of a window that closes (ERR_ABORTED); a
        // load that resolved after the close would not be evidence of real behaviour.
        pendingLoads[0].reject(abortedLoad(pendingLoads[0].child.url));
        const reused = await reuse;
        await first;
        assert(reused instanceof Error && /cancelled/u.test(reused.message), 'the waiting reuse must reject rather than relaunch a deleted node');
        assert(controller.sessionCount() === 0 && FakeWindow.nextId === windowsBefore, 'no replacement companion may be created for a deleted node');
      } finally {
        FakeWindow.loadURLHandler = null;
      }
    },
  },
  {
    name: 'interview window: another helper node cannot silently claim a locked rail',
    async run() {
      const { owner, controller, args } = makeController();
      await controller.launch({ sender: owner.webContents }, args);
      const session = controller.sessions.get(owner.id);
      const child = session.child;
      const lockedRail = stableJson(controller.getBrief({ sender: child.webContents }));
      const secondArgs = { ...structuredClone(args), nodeId: 'interview_node_2', plan: null };
      const rejected = await controller.launch({ sender: owner.webContents }, secondArgs).then(() => null, error => error);
      assert(rejected && /active interview rail/u.test(rejected.message), 'a different node launch over a locked rail must reject so that node can show its launch error');
      assert(session.nodeId === 'interview_node_1' && stableJson(controller.getBrief({ sender: child.webContents })) === lockedRail && child.focused, 'the locked rail and its node identity must be preserved and surfaced');
      const same = await controller.launch({ sender: owner.webContents }, args);
      assert(same.ok && same.reused, 'a same-node relaunch over its own locked rail keeps the reuse contract');
      await controller.nextQuestion({ sender: child.webContents });
      const retargeted = await controller.launch({ sender: owner.webContents }, secondArgs);
      assert(retargeted.reused && controller.sessions.get(owner.id).nodeId === 'interview_node_2', 'once unlocked, another node may retarget the companion');
    },
  },
  {
    name: 'interview window: loader failures never cross IPC with local paths',
    async run() {
      const leak = "EACCES: permission denied, open '/Users/someone/Library/Application Support/app/store/x.json'";
      const failing = async () => { throw new Error(leak); };
      const leaks = message => /\/Users\/|EACCES/u.test(message);
      for (const [label, options, expected] of [
        ['snapshot', { loadSnapshot: failing }, 'Interview Window snapshot is unavailable.'],
        ['brief', { loadPreparedBrief: failing }, 'Interview Window brief is unavailable or changed.'],
        ['bundle', { loadBundle: failing }, 'Interview Window application artifact is unavailable or changed.'],
      ]) {
        const { owner, controller, args } = makeController(options);
        const error = await controller.launch({ sender: owner.webContents }, args).then(() => null, value => value);
        assert(error && error.message === expected && !leaks(error.message), `${label} loader failure must reject launch with a fixed message`);
        assert(controller.sessionCount() === 0, `${label} loader failure must not create a session`);
      }
      let fail = false;
      const { owner, controller, args } = makeController({ loadSnapshot: async () => { if (fail) throw new Error(leak); return profile(); } });
      args.plan = null;
      await controller.launch({ sender: owner.webContents }, args);
      fail = true;
      const child = controller.sessions.get(owner.id).child;
      const submitError = await controller.submitQuestion({ sender: child.webContents }, 'How did you improve onboarding conversion?').then(() => null, value => value);
      assert(submitError && submitError.message === 'Interview Window snapshot is unavailable.' && !leaks(submitError.message), 'a child submission must not receive raw snapshot reader errors');
    },
  },
  {
    name: 'interview window: matching evidence the rail cannot display is reported as unsupported, not as an invalid question',
    async run() {
      const softHyphen = String.fromCodePoint(0xAD);
      const withFormattedCue = () => {
        const value = profile();
        value.profile.achievements[0].claim = `Improved onboarding conversion through a simpler set${softHyphen}up flow.`;
        return value;
      };
      const { owner, controller, args } = makeController({ loadSnapshot: async () => withFormattedCue() });
      args.plan = null;
      await controller.launch({ sender: owner.webContents }, args);
      const child = controller.sessions.get(owner.id).child;
      const display = await controller.submitQuestion({ sender: child.webContents }, 'How did you improve onboarding conversion?');
      assert(display.plan.status === 'unsupported' && /cannot display safely/u.test(display.plan.message) && display.plan.steps.length === 0, 'an undisplayable matching cue must produce a truthful unsupported state');
      assert(child.webContents.sent.at(-1)?.value === display, 'the child must be told about the unsupported state');
      const retry = await controller.submitQuestion({ sender: child.webContents }, 'How did you improve onboarding conversion?');
      assert(retry.plan.status === 'unsupported', 'the session must stay unlocked for another question');
    },
  },
  {
    name: 'interview window: a crashed child renderer is retired so relaunch opens a working child',
    async run() {
      const { owner, controller, args } = makeController();
      await controller.launch({ sender: owner.webContents }, args);
      const crashed = controller.sessions.get(owner.id).child;
      crashed.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
      assert(crashed.destroyed && controller.sessionCount() === 0, 'a crashed child must be closed and its session removed');
      const relaunched = await controller.launch({ sender: owner.webContents }, args);
      const replacement = controller.sessions.get(owner.id).child;
      assert(relaunched.ok && !relaunched.reused && replacement !== crashed && !replacement.destroyed, 'relaunch must open a fresh child instead of focusing the dead page');
    },
  },
  {
    name: 'interview window: owner cleanup never reads the destroyed owner, so the canvas close handler completes',
    async run() {
      class ThrowingIdWindow extends FakeWindow {
        get id() { if (this.destroyed) throw new Error('Object has been destroyed'); return this.ownId; }
        set id(value) { this.ownId = value; }
      }
      const owner = new ThrowingIdWindow();
      const storedBrief = brief(); const briefRecordId = interviewPreparedBriefRecordId(storedBrief);
      const controller = createInterviewWindowController({ BrowserWindow: FakeWindow, ipcMain: { handle() {} }, registerIpc: false,
        isAuthorizedOwner: value => value === owner, loadSnapshot: async () => profile(),
        loadBundle: async args => ({ artifactId: args.artifactId, applicationArtifactDigest: 'd'.repeat(64) }),
        loadPreparedBrief: async args => args.briefRecordId === briefRecordId && stableJson(args.brief) === stableJson(storedBrief) ? storedBrief : null,
        devServerUrl: 'http://localhost:5173/' });
      // Model main.js: its own 'closed' listener runs before the controller's and
      // must reach its canvas bookkeeping even though the owner is destroyed.
      const canvasWindows = new Set([owner]);
      let handlerError = null;
      owner.on('closed', () => { try { controller.cleanupOwner(owner); canvasWindows.delete(owner); } catch (error) { handlerError = error; } });
      const args = { nodeId: 'interview_node_1', snapshotId: SNAPSHOT, jobUrl: JOB_URL, briefRecordId, brief: storedBrief, plan: null, currentStep: 0 };
      await controller.launch({ sender: owner.webContents }, args);
      const child = [...controller.sessions.values()][0].child;
      let release; const gate = new Promise(resolve => { release = resolve; });
      const controller2Pending = (async () => {
        const second = new ThrowingIdWindow();
        const gated = createInterviewWindowController({ BrowserWindow: FakeWindow, ipcMain: { handle() {} }, registerIpc: false,
          isAuthorizedOwner: value => value === second, loadSnapshot: async () => { await gate; return profile(); },
          loadBundle: async a => ({ artifactId: a.artifactId, applicationArtifactDigest: 'd'.repeat(64) }),
          loadPreparedBrief: async a => a.briefRecordId === briefRecordId ? storedBrief : null, devServerUrl: 'http://localhost:5173/' });
        const pending = gated.launch({ sender: second.webContents }, args).then(() => null, error => error);
        await new Promise(resolve => setImmediate(resolve));
        second.destroyed = true; // Electron marks the window destroyed before 'closed'
        gated.cleanupOwner(second);
        release();
        return { error: await pending, sessions: gated.sessionCount() };
      })();
      owner.close();
      assert(handlerError === null, `the owner 'closed' handler must not throw, got ${handlerError?.message}`);
      assert(!canvasWindows.has(owner) && controller.sessionCount() === 0 && child.destroyed, 'canvas bookkeeping and companion cleanup must both complete on owner close');
      const gatedResult = await controller2Pending;
      assert(gatedResult.error && /cancelled/u.test(gatedResult.error.message) && gatedResult.sessions === 0, 'a destroyed owner must still cancel its in-flight launch without reading its id');
    },
  },
  {
    name: 'interview window: a same-node relaunch over a locked rail keeps the newer brief and snapshot for Next question',
    async run() {
      const original = brief();
      const SNAPSHOT_B = 'b'.repeat(64);
      const updatedBrief = structuredClone(original); updatedBrief.createdAt = '2026-10-08T02:00:00.000Z'; updatedBrief.role.title = 'Senior Product Manager (re-prepared)'; updatedBrief.inputs.careerSnapshotId = SNAPSHOT_B; signBrief(updatedBrief);
      const loaded = [];
      const { owner, controller, args } = makeController({ storedBrief: original, loadPreparedBrief: memoryPreparedBriefs(original, updatedBrief), loadSnapshot: async ({ snapshotId }) => { loaded.push(snapshotId); const value = profile(); value.snapshotId = snapshotId; if (snapshotId === SNAPSHOT_B) value.profile.roles[0].title = 'Staff Product Manager'; return value; } });
      await controller.launch({ sender: owner.webContents }, args);
      const child = [...controller.sessions.values()][0].child;
      assert(controller.getBrief({ sender: child.webContents }).plan?.status === 'supported', 'fixture must start with a locked canvas rail');
      const relaunch = { ...structuredClone(args), plan: null, snapshotId: SNAPSHOT_B, brief: updatedBrief, briefRecordId: interviewPreparedBriefRecordId(updatedBrief) };
      const result = await controller.launch({ sender: owner.webContents }, relaunch);
      const shown = controller.getBrief({ sender: child.webContents });
      assert(result.reused && shown.plan?.status === 'supported' && shown.briefing.role.title === 'Product Manager', 'the locked rail and its brief stay in place until the child advances');
      const advanced = await controller.nextQuestion({ sender: child.webContents });
      assert(advanced.plan === null && advanced.briefing.role.title === 'Senior Product Manager (re-prepared)', `Next question must show the brief from the relaunch, got ${advanced.briefing.role.title}`);
      await controller.submitQuestion({ sender: child.webContents }, 'How did you improve onboarding conversion?');
      assert(loaded.at(-1) === SNAPSHOT_B, 'later questions must read the relaunched career snapshot');
      // An unlocked relaunch clears any deferred parent state.
      const session = [...controller.sessions.values()][0];
      await controller.nextQuestion({ sender: child.webContents });
      await controller.launch({ sender: owner.webContents }, relaunch);
      assert(session.pendingParent === null, 'an applied relaunch leaves nothing deferred');
    },
  },
  {
    name: 'interview window: a parent relaunch onto a new snapshot supersedes an in-flight question instead of failing it',
    async run() {
      const SNAPSHOT_B = 'b'.repeat(64);
      const original = brief();
      const updatedBrief = structuredClone(original); updatedBrief.inputs.careerSnapshotId = SNAPSHOT_B; signBrief(updatedBrief);
      const pending = [];
      let gateReads = false;
      const { owner, controller, args } = makeController({ storedBrief: original, loadPreparedBrief: memoryPreparedBriefs(original, updatedBrief), loadSnapshot: async ({ snapshotId }) => {
        if (gateReads) await new Promise(resolve => pending.push(resolve));
        const value = profile(); value.snapshotId = snapshotId; return value;
      } });
      await controller.launch({ sender: owner.webContents }, { ...args, plan: null });
      const child = [...controller.sessions.values()][0].child;
      gateReads = true;
      const early = controller.submitQuestion({ sender: child.webContents }, 'How did you improve onboarding conversion?').then(display => ({ display }), error => ({ error }));
      await new Promise(resolve => setImmediate(resolve));
      gateReads = false;
      await controller.launch({ sender: owner.webContents }, { ...structuredClone(args), plan: null, snapshotId: SNAPSHOT_B, brief: updatedBrief, briefRecordId: interviewPreparedBriefRecordId(updatedBrief) });
      pending[0]();
      const outcome = await early;
      assert(!outcome.error && outcome.display.plan === null, `a superseded question must resolve to the current display, got ${outcome.error?.message}`);
      // A genuine loader failure that is NOT superseded still surfaces.
      let failReads = false;
      const failing = makeController({ loadSnapshot: async () => { if (failReads) throw new Error('/Users/private/path: EACCES'); return profile(); } });
      await failing.controller.launch({ sender: failing.owner.webContents }, { ...failing.args, plan: null });
      failReads = true;
      const failingChild = [...failing.controller.sessions.values()][0].child;
      const rejected = await failing.controller.submitQuestion({ sender: failingChild.webContents }, 'How did you improve onboarding conversion?').then(() => null, error => error);
      assert(rejected && rejected.message === 'Interview Window snapshot is unavailable.', 'an unsuperseded loader failure still reports the fixed message');
    },
  },
  {
    name: 'interview window: a Next-question dismissal belongs to its node and never hides another helper’s genuine rail',
    async run() {
      const { owner, controller, args } = makeController();
      await controller.launch({ sender: owner.webContents }, args);
      const child = [...controller.sessions.values()][0].child;
      await controller.nextQuestion({ sender: child.webContents });
      const otherNode = { ...structuredClone(args), nodeId: 'interview_node_2' };
      const result = await controller.launch({ sender: owner.webContents }, otherNode);
      const shown = controller.getBrief({ sender: child.webContents });
      assert(result.reused && shown.plan?.status === 'supported' && [...controller.sessions.values()][0].nodeId === 'interview_node_2', 'the same question on another helper is a new rail, not a dismissed one');
      await controller.nextQuestion({ sender: child.webContents });
      await controller.launch({ sender: owner.webContents }, otherNode);
      assert(controller.getBrief({ sender: child.webContents }).plan === null, 'the dismissal still holds for the node that dismissed it');
    },
  },
  {
    name: 'interview window: a submit with no session is not reported as an invalid question',
    async run() {
      const { owner, controller, args } = makeController();
      args.plan = null;
      await controller.launch({ sender: owner.webContents }, args);
      const child = [...controller.sessions.values()][0].child;
      const reason = (sender, value) => controller.submitQuestion({ sender }, value).then(() => null, error => error.message);
      assert(await reason(child.webContents, '   ') === 'Interview question is invalid.' && await reason(child.webContents, '') === 'Interview question is invalid.'
        && await reason(child.webContents, 'x'.repeat(2001)) === 'Interview question is invalid.' && await reason(child.webContents, 42) === 'Interview question is invalid.',
      'blank, over-long and non-string questions keep the validation reason');
      assert(await reason(owner.webContents, 'How did you improve onboarding conversion?') === 'Interview session is not available.', 'a sender with no session must get its own reason');
      assert(await reason(null, '   ') === 'Interview session is not available.', 'a missing session is reported before the question is judged');
      const accepted = await controller.submitQuestion({ sender: child.webContents }, 'a'.repeat(2000));
      assert(typeof accepted.plan?.status === 'string', 'a question of exactly 2000 characters is still accepted');
    },
  },
  {
    name: 'interview window: every reason submit-question can reject with maps to a specific child message and never echoes a path',
    async run() {
      // Electron wraps an IPC rejection as "Error invoking remote method '<channel>': Error: <message>".
      const ipc = error => new Error(`Error invoking remote method 'interview-window:submit-question': Error: ${error.message}`);
      const leak = "EACCES: permission denied, open '/Users/someone/Library/Application Support/app/store/x.json'";
      let failRead = false;
      const { owner, controller, args } = makeController({ loadSnapshot: async () => { if (failRead) throw new Error(leak); return profile(); } });
      args.plan = null;
      await controller.launch({ sender: owner.webContents }, args);
      const child = [...controller.sessions.values()][0].child;
      const ask = (sender, question) => controller.submitQuestion({ sender }, question).then(() => null, error => error);
      const invalid = await ask(child.webContents, '   ');
      const noSession = await ask(owner.webContents, 'How did you improve onboarding conversion?');
      failRead = true;
      const snapshot = await ask(child.webContents, 'How did you improve onboarding conversion?');
      const mapped = [invalid, noSession, snapshot].map(error => interviewSubmitErrorMessage(ipc(error)));
      assert(mapped[0] === INVALID_QUESTION_MESSAGE && mapped[1] === SESSION_ENDED_MESSAGE && mapped[2] === EVIDENCE_UNAVAILABLE_MESSAGE, `each controller reason must map to its own child message, got ${JSON.stringify(mapped)}`);
      assert(new Set([INVALID_QUESTION_MESSAGE, SESSION_ENDED_MESSAGE, EVIDENCE_UNAVAILABLE_MESSAGE, SUBMIT_FAILED_MESSAGE]).size === 4, 'the four child messages are distinct');
      assert(mapped.every(message => !/Users|EACCES|\/|interview-window:/u.test(message.replace(/\(up to 2,000 characters\)/u, ''))), 'no mapped message may echo a path, channel, or raw error');
      assert(interviewSubmitErrorMessage(new Error(leak)) === SUBMIT_FAILED_MESSAGE && interviewSubmitErrorMessage(ipc(new Error(leak))) === SUBMIT_FAILED_MESSAGE && interviewSubmitErrorMessage(null) === SUBMIT_FAILED_MESSAGE && interviewSubmitErrorMessage(undefined) === SUBMIT_FAILED_MESSAGE, 'unknown failures stay generic and never echo the raw error');
      assert(interviewSubmitErrorMessage(new TypeError('Interview question must be a bounded string.')) === INVALID_QUESTION_MESSAGE, 'the preload guard is an invalid question');
      assert(interviewSubmitErrorMessage('Interview session is not available.') === SESSION_ENDED_MESSAGE, 'a bare string reason is matched too');
    },
  },
  {
    name: 'interview window: the always-on-top pin is main-owned and only the get-brief read reports it',
    async run() {
      const { owner, controller, args } = makeController();
      args.plan = null;
      await controller.launch({ sender: owner.webContents }, args);
      const child = [...controller.sessions.values()][0].child;
      assert(controller.getBrief({ sender: child.webContents }).alwaysOnTop === false, 'a fresh companion is not pinned');
      assert(controller.setAlwaysOnTop({ sender: owner.webContents }, true) === false && !child.alwaysOnTop && controller.getBrief({ sender: child.webContents }).alwaysOnTop === false, 'only the child may pin its own window');
      assert(controller.setAlwaysOnTop({ sender: child.webContents }, 'yes') === false && !child.alwaysOnTop && controller.getBrief({ sender: child.webContents }).alwaysOnTop === false, 'only a boolean is accepted');
      assert(controller.setAlwaysOnTop({ sender: child.webContents }, true) === true && child.alwaysOnTop === true, 'the child pins its own window');
      // A reloaded page asks again and must see the native truth, whatever its React state was.
      assert(controller.getBrief({ sender: child.webContents }).alwaysOnTop === true, 'get-brief must report the pin after a page reload');
      const submitted = await controller.submitQuestion({ sender: child.webContents }, 'How did you improve onboarding conversion?');
      assert(controller.getBrief({ sender: child.webContents }).alwaysOnTop === true, 'the pin survives a question submission');
      const advanced = await controller.nextQuestion({ sender: child.webContents });
      assert(controller.getBrief({ sender: child.webContents }).alwaysOnTop === true, 'the pin survives Next question');
      assert(!('alwaysOnTop' in submitted) && !('alwaysOnTop' in advanced) && child.webContents.sent.every(item => !('alwaysOnTop' in item.value)), 'the pin is read on get-brief only, never added to submit, next or brief-updated payloads');
      controller.setAlwaysOnTop({ sender: child.webContents }, false);
      assert(controller.getBrief({ sender: child.webContents }).alwaysOnTop === false && child.alwaysOnTop === false, 'unpinning is reflected too');
      assert(controller.getBrief({ sender: owner.webContents }) === null, 'the canvas still cannot read the child display');
    },
  },
  {
    name: 'interview window: a crash while opening keeps its fixed message whichever signal arrives first, and a clean exit is only a closed window',
    async run() {
      for (const [reason, isCrash] of [['crashed', true], ['oom', true], ['clean-exit', false]]) {
        const pendingLoads = [];
        FakeWindow.loadURLHandler = child => new Promise((resolve, reject) => pendingLoads.push({ child, resolve, reject }));
        try {
          const context = makeController(); context.args.plan = null;
          const launched = settle(context.controller.launch({ sender: context.owner.webContents }, context.args));
          await tick();
          const child = context.controller.sessions.get(context.owner.id).child;
          // Electron closes a window asynchronously, so the pending load can reject before 'closed' is emitted.
          const realClose = child.close.bind(child);
          child.close = () => { setTimeout(realClose, 5); };
          child.webContents.emit('render-process-gone', {}, { reason });
          pendingLoads[0].reject(abortedLoad(child.url));
          const outcome = await withQuietConsoleError(async () => { const value = await launched; await tick(); await new Promise(resolve => setTimeout(resolve, 15)); return value; });
          if (isCrash) assert(outcome instanceof Error && outcome.message === 'Interview Window renderer stopped while opening.', `${reason}: a crash must reject with the fixed message even when the load rejection arrives first, got ${outcome?.message || JSON.stringify(outcome)}`);
          else assert(outcome?.ok === false && outcome.closed === true, `${reason}: a clean exit is a closed window, not a launch failure, got ${outcome?.message || JSON.stringify(outcome)}`);
          assert(context.controller.sessionCount() === 0, `${reason}: no session is left behind`);
        } finally { FakeWindow.loadURLHandler = null; }
      }
    },
  },
  {
    name: 'interview window: a companion closed during its first navigation is a closed outcome, not a launch failure',
    async run() {
      // Electron may reject a pending loadURL when its window closes, or never settle it.
      for (const electronRejects of [true, false]) {
        const label = electronRejects ? 'pending load rejects ERR_ABORTED after close' : 'pending load never settles';
        const held = () => {
          const pendingLoads = [];
          FakeWindow.loadURLHandler = child => new Promise((resolve, reject) => pendingLoads.push({ child, resolve, reject }));
          const context = makeController(); context.args.plan = null;
          return { ...context, pendingLoads };
        };
        const retire = (context, close) => {
          const child = context.controller.sessions.get(context.owner.id).child;
          close();
          if (electronRejects) context.pendingLoads[0].reject(abortedLoad(child.url));
        };
        try {
          // Launch A opens the companion, node B retargets it while it loads, then node B is deleted: A is healthy.
          let context = held();
          const a = settle(context.controller.launch({ sender: context.owner.webContents }, context.args));
          await tick();
          const b = settle(context.controller.launch({ sender: context.owner.webContents }, { ...structuredClone(context.args), nodeId: 'interview_node_2' }));
          await tick();
          assert(context.controller.sessions.get(context.owner.id).nodeId === 'interview_node_2', `${label}: B must retarget the loading companion`);
          const windowsBefore = FakeWindow.nextId;
          retire(context, () => context.controller.cleanupBySenderAndNode(context.owner.webContents, 'interview_node_2'));
          const [aResult, bResult] = await Promise.all([a, b]);
          assert(aResult?.ok === false && aResult.closed === true, `${label}: a healthy launch A must get a closed outcome, got ${aResult?.message || JSON.stringify(aResult)}`);
          assert(bResult instanceof Error && /cancelled/u.test(bResult.message), `${label}: the deleted node's own launch is cancelled, got ${bResult?.message}`);
          assert(context.controller.sessionCount() === 0 && FakeWindow.nextId === windowsBefore, `${label}: nothing is resurrected`);

          // The user closes the loading companion: the creator and a waiting reuse both get a closed outcome.
          context = held();
          const creator = settle(context.controller.launch({ sender: context.owner.webContents }, context.args));
          await tick();
          const waiter = settle(context.controller.launch({ sender: context.owner.webContents }, structuredClone(context.args)));
          await tick();
          const windowsBeforeClose = FakeWindow.nextId;
          retire(context, () => context.controller.sessions.get(context.owner.id).child.close());
          const settled = await Promise.all([creator, waiter]);
          assert(settled.every(value => value?.ok === false && value.closed === true), `${label}: a user close must not fail either launch, got ${settled.map(value => value?.message || JSON.stringify(value))}`);
          assert(FakeWindow.nextId === windowsBeforeClose && context.controller.sessionCount() === 0, `${label}: no replacement window is opened for a window the user closed`);

          // A launch whose own node was deleted mid-load keeps the cancellation, not a closed outcome.
          context = held();
          const own = settle(context.controller.launch({ sender: context.owner.webContents }, context.args));
          await tick();
          retire(context, () => context.controller.cleanupBySenderAndNode(context.owner.webContents, context.args.nodeId));
          const ownResult = await own;
          assert(ownResult instanceof Error && /cancelled/u.test(ownResult.message), `${label}: deleting the launching node cancels its launch, got ${ownResult?.message || JSON.stringify(ownResult)}`);

          // A renderer crash while opening is still a failure, with a fixed message, never a closed outcome.
          context = held();
          const crashed = settle(context.controller.launch({ sender: context.owner.webContents }, context.args));
          await tick();
          const crashChild = context.controller.sessions.get(context.owner.id).child;
          crashChild.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
          if (electronRejects) context.pendingLoads[0].reject(abortedLoad(crashChild.url));
          // The raw abort is logged in main; let that settle inside the quiet scope.
          const crashResult = await withQuietConsoleError(async () => { const outcome = await crashed; await tick(); return outcome; });
          assert(crashResult instanceof Error && crashResult.message === 'Interview Window renderer stopped while opening.', `${label}: a crash during the first navigation must reject with a fixed message, got ${crashResult?.message || JSON.stringify(crashResult)}`);
          assert(context.controller.sessionCount() === 0, `${label}: a crashed opening leaves no session`);
        } finally { FakeWindow.loadURLHandler = null; }
      }

      // Electron emits 'close' before it reports the abort and only then 'closed'.
      const pendingLoads = [];
      FakeWindow.loadURLHandler = child => new Promise((resolve, reject) => pendingLoads.push({ child, resolve, reject }));
      try {
        const closing = makeController(); closing.args.plan = null;
        const launched = settle(closing.controller.launch({ sender: closing.owner.webContents }, closing.args));
        await tick();
        const child = closing.controller.sessions.get(closing.owner.id).child;
        child.emit('close');
        pendingLoads[0].reject(abortedLoad(child.url));
        const result = await launched;
        assert(result?.ok === false && result.closed === true, `an abort reported while the window is closing is a closed outcome, got ${result?.message || JSON.stringify(result)}`);
        assert(closing.controller.sessionCount() === 0, 'and leaves no session behind');
        child.close();
      } finally { FakeWindow.loadURLHandler = null; }

      // A genuine load failure with the window alive still rejects.
      const failing = makeController(); FakeWindow.failLoad = true;
      try {
        const error = await withQuietConsoleError(() => failing.controller.launch({ sender: failing.owner.webContents }, failing.args).then(value => value, value => value));
        assert(error instanceof Error && error.message === 'Interview Window could not load its view.' && failing.controller.sessionCount() === 0, 'a genuine load failure keeps rejecting');
      } finally { FakeWindow.failLoad = false; }
    },
  },
  {
    name: 'interview window: a genuine first-navigation failure rejects every launch with a fixed message and logs the raw cause only in main',
    async run() {
      const rawLoadError = "ERR_FILE_NOT_FOUND (-6) loading 'file:///Users/someone/Applications/App.app/Contents/Resources/dist/index.html?view=interview'";
      const leaks = message => /load failed|ERR_FILE_NOT_FOUND|file:|\/Users\//u.test(message);
      // The synchronous-looking failure path (loadURL throws).
      const direct = makeController(); FakeWindow.failLoad = true;
      try {
        const error = await withQuietConsoleError(() => direct.controller.launch({ sender: direct.owner.webContents }, direct.args).then(() => null, value => value));
        assert(error && error.message === 'Interview Window could not load its view.' && !leaks(error.message), `the creator must get the fixed message, got ${error?.message}`);
      } finally { FakeWindow.failLoad = false; }
      // The creator and an overlapping reuse waiter await the same navigation.
      const pendingLoads = [];
      FakeWindow.loadURLHandler = child => new Promise((resolve, reject) => pendingLoads.push({ child, resolve, reject }));
      try {
        const { owner, controller, args } = makeController(); args.plan = null;
        const creator = settle(controller.launch({ sender: owner.webContents }, args));
        await tick();
        const waiter = settle(controller.launch({ sender: owner.webContents }, structuredClone(args)));
        await tick();
        pendingLoads[0].reject(Object.assign(new Error(rawLoadError), { errno: -6, code: 'ERR_FILE_NOT_FOUND' }));
        const [creatorError, waiterError] = await withQuietConsoleError(() => Promise.all([creator, waiter]));
        for (const [who, error] of [['creator', creatorError], ['overlapping reuse waiter', waiterError]]) {
          assert(error instanceof Error && error.message === 'Interview Window could not load its view.' && !leaks(error.message), `the ${who} must get the fixed message, got ${error?.message}`);
        }
        assert(controller.sessionCount() === 0 && owner.listenerCount('closed') === 0, 'a failed opening leaves no session or owner listener');
        const logged = getRecentLogs().filter(entry => entry.level === 'error' && entry.message.includes('ERR_FILE_NOT_FOUND'));
        assert(logged.length === 1 && logged[0].message.includes('[interview-window]'), 'the raw cause is logged once in main, for diagnosis');
      } finally { FakeWindow.loadURLHandler = null; }
    },
  },
];
