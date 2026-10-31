/**
 * Real main-process Interview Window session with synthetic inputs and a real
 * temporary, sealed answer-bank store. This measures controller work, not paint.
 * Run: node --import ./scripts/test-stubs/register.mjs scripts/interview-window-controller-session.mjs --output /tmp/interview-controller.json
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createInterviewWindowController } from '../electron/interviewWindow.js';
import { loadInterviewAnswerBank, publishInterviewAnswerBank } from '../electron/ipc/interviewAnswerBank.js';
import { createInterviewWindowE2EFixture } from './fixtures/interview-window-e2e.mjs';

class SyntheticWebContents extends EventEmitter {
  constructor(id) { super(); this.id = id; this.sent = []; }
  send(channel, display) { this.sent.push({ channel, display }); }
  setWindowOpenHandler() {}
}

/** Lifecycle shell only: no Electron process, native app or app data is opened. */
class SyntheticBrowserWindow extends EventEmitter {
  static nextId = 0;
  static windows = new Map();
  static fromWebContents(contents) { return this.windows.get(contents?.id) || null; }
  constructor(options) {
    super();
    this.id = ++SyntheticBrowserWindow.nextId;
    this.options = options;
    this.webContents = new SyntheticWebContents(this.id + 10_000);
    SyntheticBrowserWindow.windows.set(this.webContents.id, this);
  }
  isDestroyed() { return !!this.destroyed; }
  async loadURL() {}
  focus() {}
  close() { this.destroyed = true; this.emit('closed'); SyntheticBrowserWindow.windows.delete(this.webContents.id); }
  setAlwaysOnTop(value) { this.alwaysOnTop = value; }
}

function percentile(samples, fraction) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? null;
}

export async function runInterviewWindowControllerSession({ fixture = createInterviewWindowE2EFixture() } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'interview-controller-session-'));
  const owner = new SyntheticBrowserWindow({ synthetic: true });
  let controller;
  const reads = { snapshot: 0, bank: 0 };
  try {
    const sealed = await publishInterviewAnswerBank({ bank: fixture.bank, userDataPath: root });
    if (sealed.answerBankRecordId !== fixture.answerBankRecordId) throw new Error('Synthetic answer-bank seal mismatch.');
    controller = createInterviewWindowController({ matcherTransportFactory: () => { throw new Error('Offline fixture: AI unavailable.'); },
      BrowserWindow: SyntheticBrowserWindow, ipcMain: {}, registerIpc: false,
      appInstance: { getPath: () => root },
      isAuthorizedOwner: candidate => candidate === owner,
      loadSnapshot: async () => { reads.snapshot += 1; return structuredClone(fixture.snapshot); },
      loadBundle: async () => structuredClone(fixture.bundle),
      loadPreparedBrief: async () => structuredClone(fixture.brief),
      loadAnswerBank: async ({ snapshot, brief, bundle, userDataPath }) => {
        reads.bank += 1;
        return loadInterviewAnswerBank({ answerBankRecordId: sealed.answerBankRecordId, userDataPath,
          snapshot, brief, bundle, canonicalJobUrl: fixture.canonicalJobUrl, bundleArtifactId: fixture.bundleArtifactId });
      },
      devServerUrl: 'http://127.0.0.1:5173/',
    });
    await controller.launch({ sender: owner.webContents }, {
      nodeId: 'interview_e2e_synthetic', snapshotId: fixture.snapshot.snapshotId,
      jobUrl: fixture.canonicalJobUrl, briefRecordId: fixture.briefRecordId,
      brief: fixture.brief, plan: null, currentStep: 0,
    });
    const session = [...controller.sessions.values()][0];
    const event = { sender: session.child.webContents };
    const rows = [];
    for (const scenario of fixture.questions) {
      if (!scenario.followUp) controller.nextQuestion(event);
      const started = performance.now();
      const display = await (scenario.followUp
        ? controller.followUpQuestion(event, scenario.question)
        : controller.submitQuestion(event, scenario.question));
      const latencyMs = performance.now() - started;
      const actualKind = display.answerCard ? 'card' : display.plan?.status === 'supported' ? 'cue' : 'abstain';
      const actualCardId = display.answerCard?.id ?? null;
      rows.push({ ...scenario, actualKind, actualCardId,
        correct: scenario.expectedKind === actualKind && scenario.expectedCardId === actualCardId,
        latencyMs,
        preservedQuestion: display.question ?? display.plan?.question ?? null,
        displayedCardQuestion: display.answerCard?.question ?? null,
        headline: display.answerCard?.headline ?? display.plan?.steps?.[0]?.cue ?? display.plan?.message ?? null,
        bullets: display.answerCard?.bullets?.map(item => item.text) ?? [],
        gaps: display.plan?.missingComponents ?? [],
        cueSteps: display.plan?.steps ?? [],
        followUpAvailable: !!session.anchorPlan,
        locked: session.locked,
      });
    }
    return {
      measurement: 'Node controller only, using injected approved snapshot/brief/bundle and a freshly sealed answer bank reloaded from an isolated temporary store on each question. Excludes browser paint, native Electron IPC, career snapshot disk validation and refresh contention.',
      fixture: { roles: fixture.snapshot.profile.roles.length, achievements: fixture.snapshot.profile.achievements.length,
        cards: fixture.bank.cards.length, answerBankRecordId: sealed.answerBankRecordId },
      summary: { count: rows.length, correct: rows.filter(row => row.correct).length,
        wrongCards: rows.filter(row => row.actualKind === 'card' && row.actualCardId !== row.expectedCardId).length,
        unsafeCues: rows.filter(row => row.expectedKind === 'abstain' && row.actualKind === 'cue').length,
        p50: percentile(rows.map(row => row.latencyMs), 0.5), p95: percentile(rows.map(row => row.latencyMs), 0.95),
        reads },
      rows,
    };
  } finally {
    controller?.cleanupOwner(owner);
    owner.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runInterviewWindowControllerSession();
  const outputIndex = process.argv.indexOf('--output');
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
  if (output) await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ...report.summary, ...(output ? { output } : {}) })}\n`);
}
