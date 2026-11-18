import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assert } from './testHelpers.js';
import { createInterviewWindowE2EFixture } from '../fixtures/interview-window-e2e.mjs';
import { runInterviewWindowE2E } from '../interview-window-e2e.mjs';
import { createInterviewWindowController } from '../../electron/interviewWindow.js';
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


export default [
  {
    name: 'interview window realistic session: sealed controller preserves truth across all 27 candidate questions heard through the listening path',
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
        let audioInput = null; let turn = 0;
        controller = createInterviewWindowController({ createAudioService: input => { audioInput = input; return { start: () => ({ status: 'listening' }), stop: () => ({ status: 'idle' }), notice() {} }; },
          matcherTransportFactory: () => { throw new Error('Offline fixture: AI unavailable.'); }, BrowserWindow: FixtureWindow, ipcMain: {}, registerIpc: false,
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
          // Questions arrive from the call: deliver each one the way the listening path does.
          controller.startListening(event);
          const shownBefore = controller.getBrief(event);
          await audioInput.onQuestion({ text: scenario.question, id: ++turn }, () => true);
          const display = controller.getBrief(event);
          if (scenario.id === 'multipart') {
            // The listening path declines a multi-part question and leaves the card as it was.
            assert(display === shownBefore, 'a multi-part spoken question must leave the current display untouched');
            continue;
          }
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
        assert(snapshotReads === 1 && bankReads === 1, 'the launch alone reads the authoritative snapshot and sealed bank; detected questions reuse the verified copies');
        return { questions: fixture.questions.length, matched, cues, abstained, wrongCards: 0, snapshotReads, bankReads };
      } finally {
        controller?.cleanupOwner(owner); owner.close();
        await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
  },
  {
    name: 'cue card end-to-end Chromium: sealed controller, cues-only rendering, auto-listen and compact layout',
    async run() {
      // Required integration test: unavailable Chromium is a failure, never a
      // skip or a substitute DOM timing result. The one exception is CI's Linux
      // job, which declares that it installs no browser.
      if (process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD) return { skipped: 'no browser in this environment' };
      const report = await runInterviewWindowE2E({ assertQuality: true, label: 'suite' });
      return { accuracy: report.accuracy, latency: report.latency, directory: report.directory };
    },
  },
];
