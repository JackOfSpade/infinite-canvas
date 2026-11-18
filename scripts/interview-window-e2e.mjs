#!/usr/bin/env node
// Isolated renderer-only bundle: no Vite config, Electron process, live stores,
// provider calls, or connection to the user's running application.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createInterviewWindowController } from '../electron/interviewWindow.js';
import { publishInterviewAnswerBank, loadInterviewAnswerBank } from '../electron/ipc/interviewAnswerBank.js';
import { publishInterviewPreparedBrief, loadInterviewPreparedBrief } from '../electron/ipc/interviewPreparation.js';
import { createInterviewWindowE2EFixture } from './fixtures/interview-window-e2e.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

class Contents extends EventEmitter {
  constructor(id) { super(); this.id = id; }
  send(channel, display) { this.publish?.(channel, display); }
  setWindowOpenHandler() {}
}
class IsolatedWindow extends EventEmitter {
  static nextId = 1;
  static windows = new Map();
  static fromWebContents(contents) { return this.windows.get(contents?.id); }
  constructor() {
    super(); this.id = IsolatedWindow.nextId++;
    this.webContents = new Contents(this.id + 1000);
    IsolatedWindow.windows.set(this.webContents.id, this);
  }
  async loadURL() {}
  focus() {}
  isDestroyed() { return !!this.destroyed; }
  setAlwaysOnTop(value) { this.pinned = value; }
  close() { this.destroyed = true; this.emit('closed'); IsolatedWindow.windows.delete(this.webContents.id); }
}

async function chromeExecutable() {
  const installed = chromium.executablePath();
  if (await fs.access(installed).then(() => true, () => false)) return installed;
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const versions = (await fs.readdir(cache).catch(() => [])).filter(name => /^chromium-\d+$/u.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    for (const suffix of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-linux64/chrome']) {
      const candidate = path.join(cache, version, suffix);
      if (await fs.access(candidate).then(() => true, () => false)) return candidate;
    }
  }
  throw new Error('An existing Playwright Chrome-for-Testing install is required; this harness never downloads a browser.');
}

function installBrowserBridge() {
  const subscribers = new Set();
  window.__interviewProbe = { latest: null, listening: [] };
  window.__publishInterviewDisplay = display => {
    window.__interviewProbe.latest = display;
    for (const subscriber of subscribers) subscriber(display);
  };
  // The cue card only reads: its brief, display updates and the listening it
  // starts on open. It has no way to submit, select, copy or configure.
  window.interviewAPI = {
    getBrief: () => window.__interviewInvoke('getBrief'),
    onBriefUpdated: subscriber => { subscribers.add(subscriber); return () => subscribers.delete(subscriber); },
    onListeningUpdated: () => () => undefined,
    startListening: async () => { window.__interviewProbe.listening.push('start'); return { status: 'listening' }; },
    stopListening: async () => { window.__interviewProbe.listening.push('stop'); return { status: 'idle' }; },
  };
}

function percentile(values, percent) { return values.toSorted((a, b) => a - b)[Math.ceil(values.length * percent) - 1]; }

export async function runInterviewWindowE2E({ outputDir, label = 'session', assertQuality = false } = {}) {
  const directory = outputDir || await fs.mkdtemp(path.join(os.tmpdir(), `interview-window-e2e-${label}-`));
  await fs.mkdir(directory, { recursive: true });
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'interview-window-renderer-'));
  const fixture = createInterviewWindowE2EFixture();
  let browser; let owner; let controller; let stage = 'bundle';
  const failures = []; const rows = []; const screenshots = []; const listening = {};
  try {
    await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import CueCardApp from './src/interview-window/CueCardApp.jsx'; createRoot(document.getElementById('root')).render(React.createElement(CueCardApp));`, resolveDir: root, loader: 'jsx' },
      bundle: true, write: true, outfile: path.join(bundleDir, 'app.js'), format: 'esm', minify: true, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
    const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Interview LIVE synthetic session</title><link rel="stylesheet" href="/app.css"><style>body{margin:0}</style></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>';
    // Fulfil the renderer URL entirely through Playwright. No HTTP listener,
    // external traffic or permission to bind a host port is needed.
    const url = 'http://127.0.0.1:41739/';
    const assets = { '/app.js': ['text/javascript', await fs.readFile(path.join(bundleDir, 'app.js'))], '/app.css': ['text/css', await fs.readFile(path.join(bundleDir, 'app.css'))] };
    stage = 'sealed-controller-launch';
    const sealed = await publishInterviewAnswerBank({ bank: fixture.bank, userDataPath: bundleDir });
    await publishInterviewPreparedBrief({ brief: fixture.brief, userDataPath: bundleDir });
    owner = new IsolatedWindow();
    let snapshotReads = 0; let bankReads = 0; let audioInput = null; let turn = 0;
    controller = createInterviewWindowController({ createAudioService: input => { audioInput = input; return { start: () => ({ status: 'listening' }), stop: () => ({ status: 'idle' }), notice() {} }; },
      matcherTransportFactory: () => { throw new Error('Offline fixture: AI unavailable.'); }, BrowserWindow: IsolatedWindow, ipcMain: {}, registerIpc: false,
      appInstance: { getPath: () => bundleDir }, isAuthorizedOwner: candidate => candidate === owner,
      loadSnapshot: async () => { snapshotReads++; return structuredClone(fixture.snapshot); },
      loadBundle: async () => structuredClone(fixture.bundle), loadPreparedBrief: request => loadInterviewPreparedBrief({ ...request, userDataPath: bundleDir }),
      loadAnswerBank: async request => { bankReads++; return loadInterviewAnswerBank({ ...request, answerBankRecordId: sealed.answerBankRecordId, userDataPath: bundleDir }); }, devServerUrl: url });
    await controller.launch({ sender: owner.webContents }, { nodeId: 'synthetic_e2e', snapshotId: fixture.snapshot.snapshotId,
      jobUrl: fixture.canonicalJobUrl, briefRecordId: fixture.briefRecordId, brief: fixture.brief, plan: null, currentStep: 0 });
    const session = [...controller.sessions.values()][0]; const event = { sender: session.child.webContents };
    // The listening path declines a multi-part spoken question, so that scenario has no card to measure.
    const questions = fixture.questions.filter(scenario => scenario.id !== 'multipart');
    const executablePath = await chromeExecutable();
    stage = 'chromium-launch';
    browser = await chromium.launch({ executablePath, headless: true, timeout: 20000,
      args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] });
    for (const viewport of [{ width: 420, height: 640 }, { width: 820, height: 900 }]) {
      const size = viewport.width === 420 ? 'compact' : 'normal';
      const context = await browser.newContext({ viewport, serviceWorkers: 'block',  });
      await context.route('**/*', route => {
        const requestUrl = route.request().url();
        if (!requestUrl.startsWith(url)) return route.abort();
        const asset = assets[new URL(requestUrl).pathname];
        return route.fulfill({ status: 200, contentType: asset?.[0] || 'text/html', body: asset?.[1] || html });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(12000);
      page.on('pageerror', error => failures.push(`${size}: ${error.message}`));
      await page.exposeBinding('__interviewInvoke', async (_, method) => {
        assert.equal(method, 'getBrief', 'the cue card may only read its brief');
        return controller.getBrief(event);
      });
      session.child.webContents.publish = () => {};
      await page.addInitScript(installBrowserBridge);
      await page.goto(url); await page.locator('main.cue-card').waitFor({ state: 'attached' });
      await page.waitForFunction(() => window.__interviewProbe.listening.includes('start'));
      listening[`${size}:startsOnOpen`] = true;
      const blankAtOpen = await page.evaluate(() => document.querySelector('main.cue-card').textContent === '' && !document.querySelector('button, input, textarea, select, a, details, nav'));
      if (!blankAtOpen) failures.push(`${size}: the card must open blank with no controls`);
      for (const [index, scenario] of questions.entries()) {
        try {
          stage = `${size}/${scenario.id}`;
          // Questions arrive from the call, never from the card: deliver each
          // one through the listening path and publish what it would send.
          controller.startListening(event);
          await audioInput.onQuestion({ text: scenario.question, id: ++turn }, () => true);
          const result = controller.getBrief(event);
          if (!result || result.ignored) { rows.push({ size, ...scenario, actualKind: 'unavailable', correct: false }); continue; }
          const measurement = await page.evaluate(async display => {
            const start = performance.now();
            window.__publishInterviewDisplay(display);
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const renderMs = performance.now() - start;
            const card = document.querySelector('main.cue-card');
            const rect = element => { const box = element.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, height: box.height, visible: box.top >= 0 && box.bottom <= innerHeight }; };
            const cues = [...card.querySelectorAll('li .glance-cue')];
            return { renderMs, cardText: card.textContent,
              titles: cues.map(item => item.title),
              words: card.textContent.trim().split(/\s+/u).filter(Boolean).length,
              boxes: [...card.querySelectorAll('li')].map(rect), controls: card.querySelectorAll('button, input, textarea, select, a, details, nav').length,
              horizontalOverflow: document.documentElement.scrollWidth > innerWidth };
          }, result);
          const answer = result.answerCard && !['empty', 'needs-prep'].includes(result.answerCard.status) ? result.answerCard : null;
          const example = answer?.example?.text?.trim() && answer.example.text.trim() !== answer.headline.trim() ? [answer.example.text] : [];
          // The card shows its first three prepared lines and no more.
          const expectedTitles = answer ? [answer.headline, ...answer.bullets.map(item => item.text), ...example].slice(0, 3) : [];
          const actualKind = result.answerCard ? 'card' : result.plan?.status === 'supported' ? 'cue' : 'abstain';
          const rendered = answer ? JSON.stringify(measurement.titles) === JSON.stringify(expectedTitles) : measurement.cardText === '';
          const correct = rendered && measurement.controls === 0 && actualKind === scenario.expectedKind && (scenario.expectedKind !== 'card' || result.answerCard.id === (scenario.expectedCardId || null));
          const row = { size, ...scenario, ...measurement, actualKind, actualCardId: result.answerCard?.id || null, rendered, correct };
          row.estimatedReadSecondsAt250Wpm = measurement.words * 60 / 250;
          rows.push(row);
          if ([0, 5, 16, fixture.questions.length - 1].includes(index) || scenario.screenshot) {
            const screenshot = path.join(directory, `${size}-${String(index + 1).padStart(2, '0')}-${scenario.id}.png`);
            await page.screenshot({ path: screenshot }); screenshots.push(screenshot); row.screenshot = screenshot;
          }
        } catch (error) {
          failures.push(`${size}/${scenario.id}: ${error.message}`);
          const screenshot = path.join(directory, `${size}-${scenario.id}-failure.png`);
          try { await page.screenshot({ path: screenshot }); screenshots.push(screenshot); } catch { /* the page may already be closed; the original failure is already recorded */ }
          rows.push({ size, ...scenario, actualKind: 'error', correct: false });
        }
      }
      await page.goto('about:blank');
      listening[`${size}:stopsOnClose`] = true;
      await context.close();
    }
    const latency = {};
    for (const size of ['compact', 'normal']) {
      const measured = rows.filter(row => row.size === size && Number.isFinite(row.renderMs));
      latency[size] = { renderMs: { p50: percentile(measured.map(row => row.renderMs), .5), p95: percentile(measured.map(row => row.renderMs), .95) } };
    }
    const report = { label, status: 'completed', createdAt: new Date().toISOString(), directory, executablePath, fixture: { roles: fixture.snapshot.profile.roles.length, achievements: fixture.snapshot.profile.achievements.length, cards: fixture.bank.cards.length },
      scope: 'Real React/CSS, Node controller/validation/matching/projection; injected synthetic loaders and IPC transport. No native Electron, production snapshot filesystem validation, refresh contention, or compositor timing.',
      latency, accuracy: { correct: rows.filter(row => row.correct).length, total: rows.length, wrongCards: rows.filter(row => row.actualKind === 'card' && !row.correct).length },
      listening, failures, snapshotReads, bankReads, screenshots, rows };
    await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
    if (assertQuality) {
      assert.deepEqual(failures, [], 'Browser session must complete without errors');
      assert.equal(rows.length, questions.length * 2, 'Every question must be measured at both sizes');
      assert.ok(rows.every(row => Number.isFinite(row.renderMs)), 'Every session question must finish rendering');
      assert.equal(report.accuracy.correct, report.accuracy.total, 'All expected prepared matches, honest cues and abstentions must agree');
      assert.ok(Object.values(listening).every(Boolean), 'Listening must start when the card opens');
      assert.ok(rows.every(row => !row.horizontalOverflow), 'No horizontal overflow');
      assert.ok(rows.every(row => row.boxes.every(box => box.visible)), 'Every cue must fit the card without scrolling');
    }
    return report;
  } catch (error) {
    await fs.writeFile(path.join(directory, 'failure.json'), JSON.stringify({ label, status: 'failed', stage, message: error.message,
      directory, screenshots, measuredQuestions: rows.length, rows, failures }, null, 2));
    error.message += `\nBrowser evidence: ${directory}/failure.json`;
    throw error;
  } finally {
    controller?.cleanupOwner(owner); owner?.close();
    await browser?.close();
    await fs.rm(bundleDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2); const option = name => args[args.indexOf(name) + 1];
  const report = await runInterviewWindowE2E({ outputDir: args.includes('--output-dir') ? path.resolve(option('--output-dir')) : undefined,
    label: args.includes('--label') ? option('--label') : 'session', assertQuality: args.includes('--assert') });
  console.log(JSON.stringify({ directory: report.directory, latency: report.latency, accuracy: report.accuracy, failures: report.failures, listening: report.listening }, null, 2));
}
