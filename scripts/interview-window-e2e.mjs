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
  const versions = (await fs.readdir(cache)).filter(name => /^chromium-\d+$/u.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
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
  window.__interviewProbe = { revision: 0, metrics: [], latest: null, pinApplied: false };
  window.__publishInterviewDisplay = display => {
    window.__interviewProbe.latest = display;
    window.__interviewProbe.revision++;
    for (const subscriber of subscribers) subscriber(display);
  };
  const invoke = async (method, value) => {
    const result = await window.__interviewInvoke(method, value);
    if (method === 'setAlwaysOnTop') window.__interviewProbe.pinApplied = result === true;
    if (['submitQuestion', 'followUpQuestion'].includes(method)) {
      window.__interviewProbe.latest = result;
      window.__interviewProbe.revision++;
    }
    return result;
  };
  window.interviewAPI = {
    getBrief: () => invoke('getBrief'), submitQuestion: value => invoke('submitQuestion', value),
    followUpQuestion: value => invoke('followUpQuestion', value), nextQuestion: () => invoke('nextQuestion'),
    close: () => invoke('close'), setAlwaysOnTop: value => invoke('setAlwaysOnTop', value),
    onBriefUpdated: subscriber => { subscribers.add(subscriber); return () => subscribers.delete(subscriber); },
  };
  // Start at the actual key event, before React's submit handler. Observe the
  // committed answer and wait through a rendering opportunity (two rAFs).
  // This is a paint proxy, not compositor/pixel instrumentation.
  window.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey || event.repeat || !event.target.matches('textarea')) return;
    const start = performance.now(); const revision = window.__interviewProbe.revision;
    const metric = { start, commitMs: null, firstPaintMs: null, fullRenderMs: null };
    window.__interviewProbe.metrics.push(metric);
    let scheduled = false; let lastMutation = start;
    const ready = () => {
      const display = window.__interviewProbe.latest;
      if (window.__interviewProbe.revision <= revision || !display) return false;
      const selector = display.answerCard ? '.answer-headline-text' : display.plan?.status === 'supported' ? '.evidence-card h2' : '.interview-warning[role="status"]';
      const element = document.querySelector(selector);
      if (!element) return false;
      const question = display.question || display.plan?.question || display.answerCard?.question;
      if (display.plan?.status === 'unsupported') return element.textContent.includes(display.plan.question);
      if (document.querySelector('.locked-question-preview')?.textContent !== question) return false;
      if (display.answerCard) return element.textContent === display.answerCard.headline
        && [...document.querySelectorAll('.spoken-bullets li > span:not(.answer-stage):not(.answer-citation-refs)')].map(item => item.textContent).join('\n') === display.answerCard.bullets.map(item => item.text).join('\n');
      return document.querySelector('.evidence-card p')?.textContent === display.plan.steps[display.plan.currentStep || 0]?.cue;
    };
    const observer = new MutationObserver(() => { lastMutation = performance.now(); check(); });
    const check = () => {
      if (scheduled || !ready()) return;
      scheduled = true; metric.commitMs = performance.now() - start;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        metric.firstPaintMs = performance.now() - start;
        const settled = () => {
          if (document.querySelector('[aria-busy="true"]') || performance.now() - lastMutation < 16) { requestAnimationFrame(settled); return; }
          requestAnimationFrame(() => { metric.fullRenderMs = performance.now() - start; observer.disconnect(); });
        };
        settled();
      }));
    };
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
    requestAnimationFrame(function poll() { check(); if (!scheduled) requestAnimationFrame(poll); });
  }, true);
}

function percentile(values, percent) { return values.toSorted((a, b) => a - b)[Math.ceil(values.length * percent) - 1]; }

export async function runInterviewWindowE2E({ outputDir, label = 'session', assertQuality = false } = {}) {
  const directory = outputDir || await fs.mkdtemp(path.join(os.tmpdir(), `interview-window-e2e-${label}-`));
  await fs.mkdir(directory, { recursive: true });
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'interview-window-renderer-'));
  const fixture = createInterviewWindowE2EFixture();
  let browser; let owner; let controller; let stage = 'bundle';
  const failures = []; const rows = []; const screenshots = []; const keyboard = {};
  try {
    await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import InterviewWindowApp from './src/interview-window/InterviewWindowApp.jsx'; createRoot(document.getElementById('root')).render(React.createElement(InterviewWindowApp));`, resolveDir: root, loader: 'jsx' },
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
    let snapshotReads = 0; let bankReads = 0;
    controller = createInterviewWindowController({ matcherTransportFactory: () => { throw new Error('Offline fixture: AI unavailable.'); }, BrowserWindow: IsolatedWindow, ipcMain: {}, registerIpc: false,
      appInstance: { getPath: () => bundleDir }, isAuthorizedOwner: candidate => candidate === owner,
      loadSnapshot: async () => { snapshotReads++; return structuredClone(fixture.snapshot); },
      loadBundle: async () => structuredClone(fixture.bundle), loadPreparedBrief: request => loadInterviewPreparedBrief({ ...request, userDataPath: bundleDir }),
      loadAnswerBank: async request => { bankReads++; return loadInterviewAnswerBank({ ...request, answerBankRecordId: sealed.answerBankRecordId, userDataPath: bundleDir }); }, devServerUrl: url });
    await controller.launch({ sender: owner.webContents }, { nodeId: 'synthetic_e2e', snapshotId: fixture.snapshot.snapshotId,
      jobUrl: fixture.canonicalJobUrl, briefRecordId: fixture.briefRecordId, brief: fixture.brief, plan: null, currentStep: 0 });
    const session = [...controller.sessions.values()][0]; const event = { sender: session.child.webContents };
    const executablePath = await chromeExecutable();
    stage = 'chromium-launch';
    browser = await chromium.launch({ executablePath, headless: true, timeout: 20000,
      args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] });
    for (const viewport of [{ width: 420, height: 640 }, { width: 820, height: 900 }]) {
      const size = viewport.width === 420 ? 'compact' : 'normal';
      controller.setAlwaysOnTop(event, false);
      const context = await browser.newContext({ viewport, serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'] });
      await context.route('**/*', route => {
        const requestUrl = route.request().url();
        if (!requestUrl.startsWith(url)) return route.abort();
        const asset = assets[new URL(requestUrl).pathname];
        return route.fulfill({ status: 200, contentType: asset?.[0] || 'text/html', body: asset?.[1] || html });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(12000);
      page.on('pageerror', error => failures.push(`${size}: ${error.message}`));
      await page.exposeBinding('__interviewInvoke', async (_, method, value) => {
        assert.ok(['getBrief', 'submitQuestion', 'followUpQuestion', 'nextQuestion', 'close', 'setAlwaysOnTop'].includes(method));
        return controller[method](event, value);
      });
      session.child.webContents.publish = (channel, display) => {
        if (channel === 'interview-window:brief-updated') void page.evaluate(value => window.__publishInterviewDisplay(value), display).catch(() => {});
      };
      controller.nextQuestion(event);
      await page.addInitScript(installBrowserBridge);
      await page.goto(url); await page.locator('#interview-question').waitFor();
      await page.waitForFunction(() => document.activeElement === document.querySelector('#interview-question'));
      keyboard[`${size}:initialFocus`] = true;
      await page.getByLabel('Keep this window on top').check();
      await page.waitForFunction(() => window.__interviewProbe.pinApplied);
      keyboard[`${size}:pin`] = session.child.pinned === true;
      // Pinning is a deliberate pointer interaction that moves focus. Return
      // to typing as a candidate would; later Next/follow-up focus is automatic.
      await page.locator('#interview-question').click();
      for (const [index, scenario] of fixture.questions.entries()) {
        try {
          stage = `${size}/${scenario.id}`;
          if (scenario.followUp) {
            const followButton = page.getByRole('button', { name: 'Follow-up', exact: true });
            if (!await followButton.count()) { rows.push({ size, ...scenario, actualKind: 'unavailable', correct: false }); continue; }
            await followButton.click();
          } else if (await page.locator('#interview-question').count() === 0) {
            await page.keyboard.press(index % 2 ? 'Control+Enter' : 'Meta+Enter');
          }
          const input = page.locator(scenario.followUp ? '#interview-follow-up' : '#interview-question');
          await input.waitFor();
          await page.waitForFunction(selector => document.activeElement === document.querySelector(selector), scenario.followUp ? '#interview-follow-up' : '#interview-question');
          const focused = await input.evaluate(element => document.activeElement === element);
          keyboard[`${size}:focus:${scenario.id}`] = focused;
          // Real key events, including the submitted Enter; never fill().
          // Accelerated transcription cadence; every character still goes
          // through Chromium's real key/input path. Latency starts at Enter.
          await input.pressSequentially(scenario.question, { delay: 30 });
          const metricCount = await page.evaluate(() => window.__interviewProbe.metrics.length);
          await input.press('Enter');
          await page.waitForFunction(count => window.__interviewProbe.metrics.length === count + 1 && window.__interviewProbe.metrics.at(-1)?.fullRenderMs != null, metricCount);
          const measurement = await page.evaluate(() => {
            const probe = window.__interviewProbe; const display = probe.latest;
            const headline = document.querySelector('.answer-headline-text, .evidence-card h2');
            const bullets = [...document.querySelectorAll('.spoken-bullets li')];
            const rect = element => { const box = element.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, height: box.height, visible: box.top >= 0 && box.bottom <= innerHeight }; };
            return { ...probe.metrics.at(-1), actualKind: display.answerCard ? 'card' : display.plan?.status === 'supported' ? 'cue' : 'abstain',
              actualCardId: display.answerCard?.id || null, renderedQuestion: display.question || display.plan?.question || display.answerCard?.question,
              headline: headline?.textContent || '', headlineBox: headline ? rect(headline) : null,
              bulletWords: bullets.map(item => item.textContent.trim().split(/\s+/u).length), bulletBoxes: bullets.map(rect),
              horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
              controlsVisible: [...document.querySelectorAll('nav button')].filter(button => /Next question|Copy/.test(button.textContent)).every(button => rect(button).visible),
              headlineAndBulletWords: [headline?.textContent || '', ...bullets.map(item => item.textContent)].join(' ').trim().split(/\s+/u).length,
              copyExpected: display.answerCard ? [display.answerCard.headline, ...display.answerCard.bullets.map(item => item.text), ...display.answerCard.evidence.map(item => item.quote)] : display.plan.steps.map(item => item.cue) };
          });
          const expectedCardId = scenario.expectedCardId || null;
          const correct = measurement.actualKind === scenario.expectedKind && (scenario.expectedKind !== 'card' || measurement.actualCardId === expectedCardId);
          const row = { size, ...scenario, ...measurement, correct };
          row.estimatedReadSecondsAt250Wpm = measurement.headlineAndBulletWords * 60 / 250;
          rows.push(row);
          if ([0, 5, 16, fixture.questions.length - 1].includes(index) || scenario.screenshot) {
            const screenshot = path.join(directory, `${size}-${String(index + 1).padStart(2, '0')}-${scenario.id}.png`);
            await page.screenshot({ path: screenshot }); screenshots.push(screenshot); row.screenshot = screenshot;
          }
          if (measurement.actualKind !== 'abstain') {
            await page.getByRole('button', { name: measurement.actualKind === 'card' ? 'Copy answer' : 'Copy cues', exact: true }).click();
            const copied = await page.evaluate(() => navigator.clipboard.readText());
            keyboard[`${size}:copy:${scenario.id}`] = measurement.copyExpected.every(text => copied.includes(text));
          }
        } catch (error) {
          failures.push(`${size}/${scenario.id}: ${error.message}`);
          const screenshot = path.join(directory, `${size}-${scenario.id}-failure.png`);
          await page.screenshot({ path: screenshot }); screenshots.push(screenshot);
          rows.push({ size, ...scenario, actualKind: 'error', correct: false });
          controller.nextQuestion(event); await page.reload(); await page.locator('#interview-question').waitFor();
        }
      }
      // Shift+Enter must stay in the editable question and not invoke lookup.
      controller.nextQuestion(event); await page.reload();
      const input = page.locator('#interview-question'); await input.waitFor(); await input.pressSequentially('A multiline');
      const before = snapshotReads; await input.press('Shift+Enter'); await input.pressSequentially('question');
      keyboard[`${size}:shiftEnter`] = (await input.inputValue()).includes('\n') && snapshotReads === before;
      await context.close();
    }
    const latency = {};
    for (const size of ['compact', 'normal']) {
      const measured = rows.filter(row => row.size === size && Number.isFinite(row.firstPaintMs));
      latency[size] = Object.fromEntries(['firstPaintMs', 'fullRenderMs'].map(key => [key, { p50: percentile(measured.map(row => row[key]), .5), p95: percentile(measured.map(row => row[key]), .95) }]));
    }
    const report = { label, status: 'completed', createdAt: new Date().toISOString(), directory, executablePath, fixture: { roles: fixture.snapshot.profile.roles.length, achievements: fixture.snapshot.profile.achievements.length, cards: fixture.bank.cards.length },
      scope: 'Real React/CSS, Node controller/validation/matching/projection; injected synthetic loaders and IPC transport. No native Electron, production snapshot filesystem validation, refresh contention, or compositor timing.',
      latency, accuracy: { correct: rows.filter(row => row.correct).length, total: rows.length, wrongCards: rows.filter(row => row.actualKind === 'card' && !row.correct).length },
      keyboard, failures, snapshotReads, bankReads, screenshots, rows };
    await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
    if (assertQuality) {
      assert.deepEqual(failures, [], 'Browser session must complete without errors');
      assert.equal(rows.length, fixture.questions.length * 2, 'Every question must be measured at both sizes');
      assert.ok(rows.every(row => Number.isFinite(row.fullRenderMs)), 'Every session question must finish rendering');
      assert.equal(report.accuracy.correct, report.accuracy.total, 'All expected prepared matches, honest cues and abstentions must agree');
      assert.ok(Object.values(keyboard).every(Boolean), 'Keyboard focus, pin, multiline and clipboard checks must pass');
      assert.ok(rows.every(row => !row.horizontalOverflow), 'No horizontal overflow');
      assert.ok(rows.every(row => row.actualKind !== 'card' || (row.headlineBox.visible && row.bulletBoxes.every(box => box.visible) && row.controlsVisible)), 'Prepared headline, bullets and controls must fit');
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
    await fs.rm(bundleDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2); const option = name => args[args.indexOf(name) + 1];
  const report = await runInterviewWindowE2E({ outputDir: args.includes('--output-dir') ? path.resolve(option('--output-dir')) : undefined,
    label: args.includes('--label') ? option('--label') : 'session', assertQuality: args.includes('--assert') });
  console.log(JSON.stringify({ directory: report.directory, latency: report.latency, accuracy: report.accuracy, failures: report.failures, keyboardFailures: Object.entries(report.keyboard).filter(([, passed]) => !passed).map(([key]) => key) }, null, 2));
}
