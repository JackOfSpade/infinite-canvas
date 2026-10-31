import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assert } from './testHelpers.js';
import { bundleComponent, withDom } from './fixtures/handoff-bridge/mountComponent.js';
import { createInterviewWindowE2EFixture } from '../fixtures/interview-window-e2e.mjs';
import { runInterviewWindowE2E } from '../interview-window-e2e.mjs';
import { createInterviewWindowController, projectInterviewDisplay } from '../../electron/interviewWindow.js';
import { loadInterviewAnswerBank, publishInterviewAnswerBank } from '../../electron/ipc/interviewAnswerBank.js';
import { loadInterviewPreparedBrief, publishInterviewPreparedBrief } from '../../electron/ipc/interviewPreparation.js';

class FixtureContents extends EventEmitter {
  constructor(id) { super(); this.id = id; }
  send() {}
  setWindowOpenHandler() {}
}
class FixtureWindow extends EventEmitter {
  static nextId = 1;
  static windows = new Map();
  static fromWebContents(contents) { return this.windows.get(contents?.id); }
  constructor() {
    super(); this.id = FixtureWindow.nextId++;
    this.webContents = new FixtureContents(this.id + 1000);
    FixtureWindow.windows.set(this.webContents.id, this);
  }
  async loadURL() {}
  focus() {}
  isDestroyed() { return !!this.destroyed; }
  close() { this.destroyed = true; this.emit('closed'); FixtureWindow.windows.delete(this.webContents.id); }
}

async function flush() { await Promise.resolve(); await Promise.resolve(); }
function button(window, label) { return [...window.document.querySelectorAll('button')].find(item => item.textContent === label); }

export default [
  {
    name: 'interview window realistic session: sealed controller preserves truth across all 27 candidate questions',
    async run() {
      const fixture = createInterviewWindowE2EFixture();
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'interview-window-session-test-'));
      const owner = new FixtureWindow(); let controller;
      try {
        assert(fixture.snapshot.profile.roles.length === 6 && fixture.snapshot.profile.achievements.length === 36, 'realistic fixture must retain six roles and 36 complete metric achievements');
        assert(fixture.bank.cards.length === 16 && fixture.bank.evidence.length === 20 && fixture.questions.length === 27, 'fixture includes 16 cards, 20 cited fields including additional extension evidence and 27 independently expected questions');
        const publishedBrief = await publishInterviewPreparedBrief({ brief: fixture.brief, userDataPath: directory });
        const publishedBank = await publishInterviewAnswerBank({ bank: fixture.bank, userDataPath: directory });
        let snapshotReads = 0; let bankReads = 0;
        controller = createInterviewWindowController({ matcherTransportFactory: () => { throw new Error('Offline fixture: AI unavailable.'); }, BrowserWindow: FixtureWindow, ipcMain: {}, registerIpc: false,
          appInstance: { getPath: () => directory }, isAuthorizedOwner: candidate => candidate === owner,
          loadSnapshot: async () => { snapshotReads += 1; return structuredClone(fixture.snapshot); },
          loadBundle: async () => structuredClone(fixture.bundle),
          loadPreparedBrief: request => loadInterviewPreparedBrief({ ...request, userDataPath: directory }),
          loadAnswerBank: async () => { bankReads += 1; return loadInterviewAnswerBank({ answerBankRecordId: publishedBank.answerBankRecordId,
            userDataPath: directory, snapshot: fixture.snapshot, brief: fixture.brief, bundle: fixture.bundle }); },
          devServerUrl: 'http://127.0.0.1:41739/' });
        await controller.launch({ sender: owner.webContents }, { nodeId: 'synthetic_session_test', snapshotId: fixture.snapshot.snapshotId,
          jobUrl: fixture.canonicalJobUrl, briefRecordId: publishedBrief.briefRecordId, brief: fixture.brief, plan: null, currentStep: 0 });
        const session = [...controller.sessions.values()][0]; const event = { sender: session.child.webContents };
        const savedFields = new Set(Object.values(fixture.snapshot.profile).flat().flatMap(entity =>
          ['claim', 'description', 'name', 'title', 'employer', 'text', 'label', 'credential', 'institution'].map(field => entity[field]).filter(Boolean)));
        let kafkaCues; let matched = 0; let cues = 0; let abstained = 0;
        for (const scenario of fixture.questions) {
          if (!scenario.followUp) controller.nextQuestion(event);
          const display = await controller[scenario.followUp ? 'followUpQuestion' : 'submitQuestion'](event, scenario.question);
          const kind = display.answerCard ? 'card' : display.plan?.status === 'supported' ? 'cue' : 'abstain';
          assert(kind === scenario.expectedKind, `${scenario.id}: expected ${scenario.expectedKind}, received ${kind}`);
          if (kind === 'card') {
            matched += 1;
            assert(display.answerCard.id === scenario.expectedCardId, `${scenario.id}: a confident card must answer the intended question`);
            const card = display.answerCard;
            const ids = new Set([card.headlineEvidenceIds, ...card.bullets.map(item => item.evidenceIds), card.example.evidenceIds,
              ...card.optionalExtension.map(item => item.evidenceIds)].flat());
            assert(card.evidence.length === ids.size && card.evidence.every(item => ids.has(item.id)), `${scenario.id}: display source count must match every cited field exactly`);
            assert(card.evidence.every(item => fixture.bank.evidence.some(source => source.id === item.id && source.text === item.quote)), `${scenario.id}: every displayed source quote must stay complete and unchanged`);
          } else if (kind === 'cue') {
            cues += 1;
            assert(display.plan.steps.every(step => savedFields.has(step.cue)), `${scenario.id}: fallback cues must be exact approved fields`);
            if (scenario.id === 'cue-kafka') {
              kafkaCues = display.plan.steps.map(step => step.cue);
              assert(kafkaCues.some(cue => cue.includes('Kafka consumer lag from 18 minutes to 40 seconds')), 'Kafka question must anchor the saved Kafka result');
            }
            if (scenario.followUp) assert(JSON.stringify(display.plan.steps.map(step => step.cue)) === JSON.stringify(kafkaCues), 'dependent result follow-up must preserve the same exact Kafka story');
            if (scenario.id === 'multipart') assert(display.plan.missingComponents.includes('lesson'), 'multipart question must disclose that the saved Kafka story has no documented lesson');
          } else {
            abstained += 1;
            assert(display.answerCard === null && display.plan.steps.length === 0 && !session.locked, `${scenario.id}: unsupported questions must show no confident card or unsafe evidence`);
          }
        }
        assert(snapshotReads === 28 && bankReads === 28, 'launch and all 27 submits must keep authoritative snapshot and sealed-bank reads');
        return { questions: fixture.questions.length, matched, cues, abstained, wrongCards: 0, snapshotReads, bankReads };
      } finally {
        controller?.cleanupOwner(owner); owner.close();
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'interview window realistic UI: submitted wording survives card-only reload and Edit, with independent optional points',
    async run() {
      const fixture = createInterviewWindowE2EFixture();
      const typed = 'Tell me about leadng a team.';
      const blank = projectInterviewDisplay({ brief: fixture.brief, snapshotId: fixture.snapshot.snapshotId, currentStep: 0, answerBank: fixture.bank });
      const answered = projectInterviewDisplay({ brief: fixture.brief, snapshotId: fixture.snapshot.snapshotId, currentStep: 0,
        answerBank: fixture.bank, answerCard: fixture.bank.cards.find(card => card.id === 'leadership'), question: typed });
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
        window.interviewAPI = { getBrief: async () => answered, onBriefUpdated: () => () => undefined,
          nextQuestion: async () => blank, close: async () => true, setAlwaysOnTop: async () => true };
        const root = bundle.module.createRoot(window.document.getElementById('root'));
        try {
          await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
          assert(window.document.querySelector('.locked-question-preview').textContent === typed, 'a reloaded card-only view must identify the actual submitted wording rather than replace it with the catalog question');
          assert(!window.document.querySelector('.evidence-card'), 'card-only regression must not rely on an underlying cue plan');
          const example = window.document.querySelector('.optional-extension');
          assert(example.tagName === 'DETAILS' && !example.open && example.querySelector('summary').textContent === 'Optional extension', 'additional career detail must start behind an accessible optional disclosure');
          example.querySelector('summary').click();
          assert(example.open && example.querySelectorAll('.extension-points li').length === 2, 'expanding the extension must reveal both independently grounded points');
          for (const point of answered.answerCard.optionalExtension) {
            assert(example.textContent.includes(point.text) && example.textContent.includes(point.exampleHook), 'each optional point retains its own wording and example hook');
          }
          assert(window.document.querySelector('.prepared-answer-recall .spoken-example').textContent.includes(answered.answerCard.example.text), 'the original concrete example stays in the prepared answer');
          const citation = example.querySelector('.answer-citation-ref');
          assert(citation && citation.getAttribute('aria-label').startsWith('Show exact cited evidence'), 'expanded concrete example must retain its native citation button');
          await bundle.module.act(async () => { citation.click(); await flush(); });
          const evidence = window.document.querySelector('.answer-evidence');
          assert(evidence.open && evidence.contains(window.document.activeElement), 'example citation must expand and focus its exact saved source');
          await bundle.module.act(async () => { button(window, 'Edit question').click(); await flush(); });
          const input = window.document.querySelector('#interview-question');
          assert(input.value === typed && window.document.activeElement === input, 'Edit must preserve the actual paraphrase/typo and restore typing focus');
        } finally { await bundle.module.act(async () => root.unmount()); await bundle.dispose(); }
      });
    },
  },
  {
    name: 'interview window end-to-end Chromium: real key events, sealed controller, paints, clipboard and compact layout',
    async run() {
      // Required integration test: unavailable Chromium is a failure, never a
      // skip or a substitute DOM timing result.
      const report = await runInterviewWindowE2E({ assertQuality: true, label: 'suite' });
      return { accuracy: report.accuracy, latency: report.latency, directory: report.directory };
    },
  },
];
