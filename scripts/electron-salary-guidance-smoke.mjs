import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { closeDisposableElectron } from './close-disposable-electron.mjs';

// Exercise the built renderer in its own hidden profile and scratch canvases.
// These are saved display fixtures: no searches, providers, AI or live app.
const root = await fs.realpath(await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'ic-salary-guidance-')));
const env = { ...process.env, INFINITE_CANVAS_E2E: '1', INFINITE_CANVAS_E2E_BACKGROUND: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const pin = 'a'.repeat(64);
const marketRange = { min: 100000, max: 200000, currency: 'CAD', period: 'annual' };
const explanation = 'Your documented system ownership and relevant platform experience support this portion of the researched market.';
const personalRecommendation = {
  schemaVersion: 1,
  methodologyVersion: 1,
  status: 'personalized',
  range: { min: 110000, max: 130000, currency: 'CAD', period: 'annual' },
  desiredSalary: 125000,
  confidence: 'medium',
  explanation,
  limitations: ['Leadership responsibilities are not fully documented.'],
  careerSnapshotId: pin,
};
let application;

function canvasFixture(recommendation, careerSnapshotId = pin) {
  return {
    schemaVersion: 1,
    nodes: [{
      id: 'salary-guidance-card', type: 'jobcard', position: { x: 0, y: 0 },
      data: {
        title: 'Synthetic Platform Engineer', company: 'Synthetic', location: 'Toronto, Ontario, Canada',
        snippet: 'A saved synthetic role for salary guidance display verification.',
        matchScore: 80, careerSnapshotId,
        compensationAssessment: {
          schemaVersion: 1,
          status: 'market_recommendation',
          reasonCode: 'market_range_recommended',
          competitiveRange: marketRange,
          justification: 'The researched market range reflects comparable annual base salaries for this role and location.',
          comparisonLocation: 'Toronto, Ontario, Canada',
          researchedAt: '2026-10-23T12:00:00.000Z',
          sourceLinks: [],
          personalRecommendation: recommendation,
        },
      },
    }],
    edges: [], drawings: [],
  };
}

try {
  application = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], env });
  const page = await application.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Electron auto-dismisses some beforeunload prompts during background
  // navigation. Its event can race Playwright's default dialog auto-handler.
  page.on('dialog', dialog => { void dialog.accept().catch(() => {}); });
  // Requests are blocked only in this disposable process. Display assertions
  // must never depend on a remote source or accidentally start paid work.
  await application.evaluate(({ BrowserWindow, session }) => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    // Expanded-card measurements mark this scratch canvas dirty. Permit its
    // deliberate fixture navigations without any native unsaved-work prompt.
    BrowserWindow.getAllWindows()[0].webContents.on('will-prevent-unload', event => event.preventDefault());
  });
  await page.setViewportSize({ width: 1200, height: 1500 });
  await page.waitForLoadState('load');
  await page.waitForFunction(() => typeof window.electronAPI?.loadWorkspace === 'function');
  await page.locator('.react-flow').waitFor();
  // The welcome overlay mounts after canvas hydration. Seed only this scratch
  // profile before navigation so its animation cannot race a fixture click.
  await page.evaluate(() => localStorage.setItem('onboardingComplete', 'true'));
  const rendererUrl = new URL(page.url());

  async function showFixture(name, fixture) {
    const canvasFilePath = path.join(root, `${name}.json`);
    await fs.writeFile(canvasFilePath, JSON.stringify(fixture));
    const loaded = await page.evaluate(filePath => window.electronAPI.loadWorkspace({ filePath }), canvasFilePath);
    assert.equal(loaded.success, true, loaded.error || `${name} canvas must load`);
    const url = new URL(rendererUrl.href);
    url.searchParams.set('init', 'file');
    url.searchParams.set('file', canvasFilePath);
    await page.evaluate(() => {
      window.addEventListener('beforeunload', event => {
        event.stopImmediatePropagation();
        delete event.returnValue;
      }, { capture: true, once: true });
    });
    await page.goto(url.href);
    const skip = page.getByRole('button', { name: 'Skip', exact: true });
    if (await skip.isVisible()) await skip.click();
    const card = page.locator('.react-flow__node-jobcard[data-id="salary-guidance-card"]');
    const disclosure = card.getByRole('button', { name: 'Salary guidance (CAD)', exact: true });
    await disclosure.waitFor();
    await disclosure.click();
    await page.waitForFunction(() => document.querySelector('.react-flow__node-jobcard [aria-expanded="true"]'));
    return card;
  }

  const personalized = await showFixture('personalized', canvasFixture(personalRecommendation));
  await personalized.getByText('Desired salary to enter', { exact: true }).waitFor();
  const personalText = await personalized.innerText();
  assert.match(personalText, /CAD 125,000 \/ annual/, 'a form-ready single desired salary must be visible');
  assert.match(personalText, /Recommended range for you:\s*CAD 110,000–CAD 130,000 \/ annual/);
  assert.match(personalText, /Researched market range:\s*CAD 100,000–CAD 200,000 \/ annual/,
    'the full market range must remain distinguishable from the personal range');
  assert.ok(personalText.includes(explanation));
  assert.match(personalText, /Based on your career data\s*· Medium confidence/);
  assert.match(personalText, /Leadership responsibilities are not fully documented/);

  // Exercise the real Copy click handler and success toast with a page-local
  // write adapter. Reading or writing the person's shared desktop clipboard
  // would escape this disposable fixture, so the native clipboard is untouched.
  await page.evaluate(() => {
    if (typeof navigator.clipboard?.writeText !== 'function') throw new Error('Renderer clipboard write API must exist');
    window.__salarySmokeClipboardWrites = [];
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: async (value) => { window.__salarySmokeClipboardWrites.push(value); },
    });
  });
  await personalized.getByRole('button', { name: 'Copy desired salary number', exact: true }).click();
  await page.getByText('Desired salary copied', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__salarySmokeClipboardWrites), ['125000'],
    'Copy must send only the salary number to the clipboard write adapter');
  await personalized.screenshot({ path: '/tmp/ic-salary-guidance-smoke.png' });

  const stale = await showFixture('stale', canvasFixture(personalRecommendation, 'b'.repeat(64)));
  const staleText = await stale.innerText();
  assert.match(staleText, /Salary guidance is outdated because the career data changed/);
  assert.match(staleText, /Combine jobs again on the Job Board/);
  assert.equal(await stale.getByRole('button', { name: 'Copy desired salary number', exact: true }).count(), 0,
    'a stale salary answer must never offer Copy');
  assert.equal(await stale.getByText('Desired salary to enter', { exact: true }).count(), 0);
  assert.ok(!staleText.includes('125,000') && !staleText.includes('110,000–CAD 130,000'),
    'stale personal numbers must be hidden while market context remains visible');
  assert.match(staleText, /Researched market range:\s*CAD 100,000–CAD 200,000 \/ annual/);

  const estimate = await showFixture('market-estimate', canvasFixture({
    ...personalRecommendation,
    status: 'market_estimate', range: marketRange, desiredSalary: 150000, confidence: 'low', careerSnapshotId: '',
    explanation: 'Career evidence is insufficient for a personal valuation; this amount uses the full researched market range.',
    limitations: ['General market estimate, rather than a personalized salary valuation.'],
  }, ''));
  const estimateText = await estimate.innerText();
  assert.match(estimateText, /CAD 150,000 \/ annual/);
  assert.match(estimateText, /Estimated application range:\s*CAD 100,000–CAD 200,000 \/ annual/);
  assert.match(estimateText, /Market estimate · limited career evidence\s*· Low confidence/);
  assert.equal(await estimate.getByRole('button', { name: 'Copy desired salary number', exact: true }).count(), 1);
  assert.deepEqual(errors, [], 'salary guidance must render without uncaught runtime errors');
  console.log('PASS: built renderer shows personal salary guidance and full market context; Copy sends a numeric-only payload and shows success; stale answers hide figures/Copy; market estimates retain the full range with low confidence.');
} catch (error) {
  const page = application?.windows()[0];
  if (page) {
    console.error((await page.locator('body').innerText()).slice(0, 6000));
    await page.screenshot({ path: '/tmp/ic-salary-guidance-smoke-error.png' });
  }
  throw error;
} finally {
  try { await closeDisposableElectron(application); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
