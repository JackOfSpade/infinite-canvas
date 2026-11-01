#!/usr/bin/env node

// Explicit macOS regression smoke: real Chrome, a disposable profile, and a
// loopback-only fixture. Never opens the app or reads a user's Chrome profile.
// Run: node scripts/browser-tab-restore-smoke.mjs [--chrome-path /path/to/Chrome]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { chromium } from 'playwright';
import { prepareBackgroundScrapeLaunchOptions, createBackgroundScrapePage } from '../electron/ipc/browser/backgroundScrapeBrowser.js';
import { clearOwnedBrowserTabRestoreState } from '../electron/ipc/browser/tabRestoreState.js';

if (process.platform !== 'darwin') {
  console.log('SKIP browser tab restore smoke: this regression uses macOS headed-window restoration.');
  process.exit(0);
}
const argv = process.argv.slice(2);
assert.ok(argv.length === 0 || (argv.length === 2 && argv[0] === '--chrome-path'),
  'Usage: node scripts/browser-tab-restore-smoke.mjs [--chrome-path /path/to/Chrome]');
const executablePath = argv[1] ? path.resolve(argv[1]) : chromium.executablePath();
await fs.access(executablePath);
puppeteer.use(StealthPlugin());

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ic-tab-restore-smoke-'));
const userDataDir = path.join(temporary, 'browser-data');
const server = http.createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (request.url === '/seed') {
    response.setHeader('Set-Cookie', 'tab_restore_probe=retained; Max-Age=86400; Path=/; SameSite=Lax');
  }
  response.end('<!doctype html><title>Tab restore fixture</title><p>Local browser regression fixture</p>');
});
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let browser = null;
let childStillRunning = false;

async function closeBrowser() {
  if (!browser) return;
  const owned = browser;
  browser = null;
  const child = owned.process();
  const exited = () => !child || child.exitCode !== null || child.signalCode !== null;
  let timer;
  try {
    await Promise.race([
      owned.close().catch(() => {}),
      new Promise(resolve => { timer = setTimeout(resolve, 5000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  // A CDP disconnect is not proof the process released its profile lock.
  const deadline = Date.now() + 2000;
  while (!exited() && Date.now() < deadline) await delay(50);
  if (!exited()) {
    child.kill('SIGKILL'); // Only the child created by this smoke.
    const killDeadline = Date.now() + 2000;
    while (!exited() && Date.now() < killDeadline) await delay(50);
  }
  childStillRunning = !exited();
  assert.ok(!childStillRunning, 'Owned smoke Chrome must exit before profile cleanup');
}

function launchOptions(headless) {
  const options = {
    executablePath,
    userDataDir,
    headless,
    timeout: 15_000,
    defaultViewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,900',
      '--disable-component-update',
      '--disable-sync',
      // External requests cannot leave this fixture; loopback remains direct.
      '--proxy-server=http://127.0.0.1:9',
      '--proxy-bypass-list=127.0.0.1;localhost',
    ],
  };
  return headless ? options : prepareBackgroundScrapeLaunchOptions(options);
}

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  browser = await puppeteer.launch(launchOptions(true));
  const seedPage = (await browser.pages())[0];
  assert.ok(seedPage, 'Headless setup should contain Puppeteer’s startup tab');
  await seedPage.goto(`${origin}/seed`, { waitUntil: 'load', timeout: 5000 });
  await seedPage.evaluate(() => localStorage.setItem('tab_restore_probe', 'retained'));
  await seedPage.goto('about:blank');
  for (let index = 0; index < 5; index += 1) await browser.newPage();
  const seededTabs = (await browser.pages()).length;
  assert.equal(seededTabs, 6);
  await closeBrowser();

  // Pin the old failure: suppression delays restoration until the first
  // explicit window, then all six saved automation tabs appear alongside it.
  browser = await puppeteer.launch(launchOptions(false));
  assert.equal((await browser.pages()).length, 0);
  const baselinePage = await createBackgroundScrapePage(browser, { width: 1280, height: 900 });
  await baselinePage.goto(`${origin}/baseline`, { waitUntil: 'load', timeout: 5000 });
  const restoreDeadline = Date.now() + 5000;
  let baselinePages;
  do {
    baselinePages = await browser.pages();
    if (baselinePages.length >= seededTabs + 1) break;
    await delay(100);
  } while (Date.now() < restoreDeadline);
  const restoredBlanks = baselinePages.filter(page => page.url() === 'about:blank').length;
  assert.equal(restoredBlanks, seededTabs, 'Baseline must reproduce the old restored-blank-tab failure');
  console.log(`PASS baseline reproduced: ${baselinePages.length} pages, ${restoredBlanks} restored blank tabs`);
  await closeBrowser();

  for (let cycle = 1; cycle <= 2; cycle += 1) {
    const cleanup = await clearOwnedBrowserTabRestoreState(userDataDir, userDataDir);
    assert.equal(cleanup.outcome, 'cleared');
    assert.ok(cleanup.removed > 0, 'The real helper should remove saved tab metadata');
    browser = await puppeteer.launch(launchOptions(false));
    assert.equal((await browser.pages()).length, 0);
    const page = await createBackgroundScrapePage(browser, { width: 1280, height: 900 });
    await page.goto(`${origin}/fixed-${cycle}`, { waitUntil: 'load', timeout: 5000 });
    // Observe beyond the restore burst rather than checking only the moment
    // createTarget returns, when the old implementation also had one page.
    const observationDeadline = Date.now() + 2000;
    do {
      const pages = await browser.pages();
      assert.equal(pages.length, 1, `Cycle ${cycle}: saved tabs must not reappear`);
      assert.equal(pages[0], page, 'The explicitly owned scrape page must survive');
      await delay(100);
    } while (Date.now() < observationDeadline);
    const state = await page.evaluate(() => ({ cookie: document.cookie, stored: localStorage.getItem('tab_restore_probe') }));
    assert.match(state.cookie, /(?:^|;\s*)tab_restore_probe=retained(?:;|$)/);
    assert.equal(state.stored, 'retained', 'Website storage must survive tab-state cleanup');
    console.log(`PASS fixed relaunch ${cycle}: 1 page, 0 restored blanks, cookie and localStorage retained`);
    await closeBrowser();
  }
} finally {
  try {
    await closeBrowser();
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (!childStillRunning) await fs.rm(temporary, { recursive: true, force: true });
  }
}
