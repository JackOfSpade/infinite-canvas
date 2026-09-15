import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { buildResumeDocument } from '../electron/ipc/resumeHtml.js';
import { BACKGROUND_E2E_SHUTDOWN_TIMEOUT_MS } from '../electron/utils/backgroundE2e.js';

// `applicationPdfReconcile` must leave pdf.js to Electron main's Node resolver.
// If Vite inlines it, pdf.js selects the browser worker path and PDF import
// fails at runtime with a fake-worker `window is not defined` error.
const mainBundle = await fs.readFile(path.resolve('dist-electron/main.cjs'), 'utf8');
assert.match(mainBundle, /pdfjs-dist\/legacy\/build\/pdf\.mjs/,
  'the Electron main bundle must retain the native pdf.js runtime specifier');
assert.doesNotMatch(mainBundle, /Setting up fake worker/,
  'the Electron main bundle must not inline pdf.js browser-worker implementation');

const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'infinite-canvas-e2e-'));
const previewFixtureRoot = await fs.mkdtemp(path.join(
  process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(),
  'infinite-canvas-preview-e2e-',
));
const workspacePath = path.join(userDataDir, 'roundtrip.json');
const env = { ...process.env };
const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';

// Codex and some CI environments use Electron as a Node runtime. Playwright
// needs the normal Electron runtime for renderer automation.
delete env.ELECTRON_RUN_AS_NODE;
env.INFINITE_CANVAS_E2E = '1';
env.INFINITE_CANVAS_E2E_BACKGROUND = '1';

let app;
const rendererErrors = [];

async function expectVisible(page, text) {
  await page.getByText(text, { exact: true }).filter({ visible: true }).first().waitFor();
}

function step(label) {
  console.log(`- ${label}`);
}

async function clickToolbar(page, label) {
  const labelNode = page.getByText(label, { exact: true });
  await labelNode.evaluate((node) => {
    const button = node.closest('.relative')?.querySelector('button');
    if (!button) throw new Error(`Toolbar button not found for "${node.textContent}"`);
    button.click();
  });
}

async function nodeCount(page, type) {
  const suffix = type ? `-${type}` : '';
  return page.locator(`.react-flow__node${suffix}`).count();
}

// Poll a locator count until the predicate holds — asserting the instant an
// input event returns races React's commit, which is the e2e's main flake source.
async function waitForCount(locator, predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = await locator.count();
    if (predicate(n)) return n;
    if (Date.now() > deadline) assert.fail(`${label} (count=${n})`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForCheckbox(locator, checked, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await locator.isChecked() === checked) return;
    if (Date.now() > deadline) assert.fail(`${label} (checked=${await locator.isChecked()})`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForAsync(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) assert.fail(label);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForFileContent(filePath, expected, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let actual;
  for (;;) {
    try {
      actual = await fs.readFile(filePath, 'utf8');
      if (actual === expected) return;
    } catch (error) {
      actual = `<read failed: ${error?.message || error}>`;
    }
    if (Date.now() > deadline) {
      assert.fail(`${label} (expected=${JSON.stringify(expected)}, actual=${JSON.stringify(actual)})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

let atomicReplaceSequence = 0;
async function replaceFileAtomically(filePath, content) {
  const tmpPath = path.join(
    path.dirname(filePath),
    `.__smoke_${process.pid}_${Date.now()}_${atomicReplaceSequence += 1}.tmp`,
  );
  try {
    await fs.writeFile(tmpPath, content, 'utf8');
    await fs.rename(tmpPath, filePath);
  } finally {
    await fs.rm(tmpPath, { force: true });
  }
}

// The sidebar expands over 300ms and moves/resizes the React Flow pane with
// it. Playwright can see the module card as soon as its first pixels are
// visible, but a drag begun then can use a stale target rectangle and release
// outside the pane. Wait for two equal layout samples before any sidebar-to-
// canvas drag so this smoke test exercises the actual DnD path deterministically.
async function waitForStableBox(locator, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  for (;;) {
    const box = await locator.boundingBox();
    if (box && previous
      && Math.abs(box.x - previous.x) < 1
      && Math.abs(box.y - previous.y) < 1
      && Math.abs(box.width - previous.width) < 1
      && Math.abs(box.height - previous.height) < 1) {
      return box;
    }
    if (Date.now() > deadline) assert.fail(`${label} did not reach stable layout`);
    previous = box;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
}

// Retain the final drop payload in failures: it distinguishes a lost sidebar
// MIME payload from a renderer-side insertion failure without tracing every
// intermediate browser DnD event.
async function beginDndTrace(page) {
  await page.evaluate(() => {
    const trace = [];
    const record = (event) => {
      const types = event.dataTransfer ? Array.from(event.dataTransfer.types || []) : [];
      trace.push({
        type: event.type,
        target: event.target?.className || event.target?.tagName || '',
        clientX: event.clientX,
        clientY: event.clientY,
        types,
        nodeType: event.dataTransfer?.getData('app/node-type') || '',
      });
    };
    document.addEventListener('drop', record, true);
    window.__smokeDndTrace = { trace, record };
  });
}

async function endDndTrace(page) {
  return page.evaluate(() => {
    const state = window.__smokeDndTrace;
    if (!state) return [];
    document.removeEventListener('drop', state.record, true);
    delete window.__smokeDndTrace;
    return state.trace;
  });
}

// Module drops over a nested-canvas group intentionally become children of
// that group. This smoke has already created one parent group by this point,
// so choose a point proved to be outside every visible group rather than
// assuming a historical coordinate remains top-level-safe.
async function findTopLevelModuleDropPosition(page) {
  const position = await page.evaluate(() => {
    const paneElement = document.querySelector('.react-flow__pane');
    if (!paneElement) return null;
    const paneBox = paneElement.getBoundingClientRect();
    const groupBoxes = [...document.querySelectorAll('.react-flow__node-group')]
      .map((element) => element.getBoundingClientRect());
    const candidates = [
      { x: Math.min(600, Math.max(220, Math.floor(paneBox.width - 320))), y: 100 },
      { x: 280, y: 100 },
      { x: 280, y: 520 },
      { x: Math.max(220, Math.floor(paneBox.width - 220)), y: 520 },
    ];
    const withinPane = ({ x, y }) => x >= 0 && y >= 0 && x < paneBox.width && y < paneBox.height;
    const withinGroup = ({ x, y }) => groupBoxes.some((box) => {
      const clientX = paneBox.left + x;
      const clientY = paneBox.top + y;
      return clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom;
    });
    return candidates.find((candidate) => withinPane(candidate) && !withinGroup(candidate)) || null;
  });
  assert.ok(position, 'the smoke needs a visible pane coordinate outside every nested-canvas group');
  return position;
}

async function waitForWorkspaceNodeData(page, filePath, nodeType, predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const data = await page.evaluate(async ({ path: workspaceFile, type }) => {
      const loaded = await window.electronAPI.loadWorkspace({ filePath: workspaceFile });
      return loaded.data.nodes.find(node => node.type === type)?.data;
    }, { path: filePath, type: nodeType });
    if (predicate(data)) return data;
    if (Date.now() > deadline) assert.fail(`${label} (data=${JSON.stringify(data)})`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function clickPane(page, x, y) {
  await page.locator('.react-flow__pane').click({ position: { x, y } });
}

async function openNodeMenu(page, node) {
  await node.click({ button: 'right', position: { x: 5, y: 5 } });
  await page.locator('.context-menu-enter').waitFor();
}

// Fixtures deliberately change the persisted workspace out from under the
// renderer. Stop only the app's browser beforeunload guard for the following
// controlled reload; accepting that dialog through Playwright races Chromium's
// reload bookkeeping, while a real user-facing app window remains guarded.
async function reloadFixture(page) {
  await page.evaluate(() => {
    window.addEventListener('beforeunload', event => event.stopImmediatePropagation(), {
      capture: true,
      once: true,
    });
  });
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
}

try {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    env,
  });

  const page = await app.firstWindow();
  const backgroundWindowState = await app.evaluate(({ BrowserWindow, Menu, app: electronApp }) => {
    const windows = BrowserWindow.getAllWindows();
    return {
      windows: windows.map((window) => ({
        visible: window.isVisible(),
        focusable: window.isFocusable(),
        focused: window.isFocused(),
        alwaysOnTop: window.isAlwaysOnTop(),
      })),
      activationPolicy: typeof electronApp.getActivationPolicy === 'function'
        ? electronApp.getActivationPolicy()
        : null,
      applicationMenuNull: Menu.getApplicationMenu() === null,
    };
  });
  assert.equal(backgroundWindowState.windows.length, 1,
    'background smoke must launch exactly one canvas BrowserWindow');
  assert.deepEqual(backgroundWindowState.windows[0], {
    visible: false,
    focusable: false,
    focused: false,
    alwaysOnTop: false,
  }, 'background smoke must not expose or activate its canvas BrowserWindow');
  assert.equal(backgroundWindowState.applicationMenuNull, true,
    'background smoke must not install a native application menu');
  if (process.platform === 'darwin' && backgroundWindowState.activationPolicy !== null) {
    assert.equal(backgroundWindowState.activationPolicy, 'prohibited',
      'background smoke must prohibit macOS app activation when Electron exposes the policy');
  }
  // All subsequent renderer documents are test fixtures. Prevent their
  // beforeunload guard from registering so a late Chromium dialog cannot race
  // Playwright's navigation machinery. The initial document is handled by
  // reloadFixture's one-shot capture listener below; this init script applies
  // only after that first controlled reload.
  await page.addInitScript(() => {
    const addEventListener = window.addEventListener.bind(window);
    window.addEventListener = (type, listener, options) => {
      if (type === 'beforeunload') return;
      return addEventListener(type, listener, options);
    };
  });
  page.on('pageerror', (error) => rendererErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') rendererErrors.push(`console: ${message.text()}`);
  });
  await page.waitForLoadState('domcontentloaded');
  step('dismiss onboarding');
  await expectVisible(page, 'Welcome to Infinite Canvas');
  await page.getByText('Skip', { exact: true }).click();
  await page.getByText('Welcome to Infinite Canvas', { exact: true }).waitFor({ state: 'hidden' });

  assert.equal(await nodeCount(page), 0, 'new isolated canvas should start empty');
  assert.ok(
    await page.evaluate(() => Object.keys(window.electronAPI || {}).length > 80),
    'preload API should be exposed',
  );

  step('round-trip workspace and settings IPC');
  const ipcRoundTrip = await page.evaluate(async (filePath) => {
    const sample = {
      schemaVersion: 1,
      nodes: [{ id: 'roundtrip-node', type: 'text', position: { x: 1, y: 2 }, data: { text: 'roundtrip' } }],
      edges: [],
      drawings: [],
    };
    const save = await window.electronAPI.saveWorkspace({ data: sample, filePath });
    const load = await window.electronAPI.loadWorkspace({ filePath });
    const updatedSettings = await window.electronAPI.updateSettings({
      jobs: { usajobsEmail: 'e2e@example.com' },
    });
    const settings = await window.electronAPI.getSettings();
    return { save, load, updatedSettings, settings };
  }, workspacePath);
  assert.equal(ipcRoundTrip.save.filePath, workspacePath, 'save-workspace should use the requested path');
  assert.equal(ipcRoundTrip.load.data.nodes[0].data.text, 'roundtrip', 'load-workspace should return saved data');
  assert.equal(ipcRoundTrip.settings.jobs.usajobsEmail, 'e2e@example.com', 'settings update should persist');
  assert.equal(ipcRoundTrip.updatedSettings.jobs.usajobsEmail, 'e2e@example.com', 'settings update should return merged data');

  // ── Marketplace listing reminder + status module, against a loaded canvas ─
  // Exercises the load→migrate→render pipeline the blank-canvas steps can't
  // reach: a saved sellhub (priced, shared reminder weeks set) + a listing
  // card saved WITHOUT createdAt (schemaVersion 2) whose id carries the real
  // spawn timestamp. On load the v3 migration must recover that date, the
  // overdue reminder must fire (pulsing border + ack strip), Marketplace Status
  // must detect the listing and dedupe watch URLs, search must find the item on
  // both hub and card, and the ack must clear the pulse.
  step('load fixture: reminder and Marketplace Status render correctly');
  const fixtureDir = path.join(previewFixtureRoot, 'workspace');
  const fixturePath = path.join(fixtureDir, 'reminder-fixture.json');
  const originalPhotoPath = path.join(fixtureDir, 'original', 'product-photo.png');
  const movedPhotoPath = path.join(fixtureDir, 'archive', 'product-photo.png');
  const originalSvgPath = path.join(fixtureDir, 'original', 'product-photo.svg');
  const movedSvgPath = path.join(fixtureDir, 'archive', 'product-photo.svg');
  const parentPhotoDecoy = path.join(previewFixtureRoot, 'product-photo.png');
  const parentSvgDecoy = path.join(previewFixtureRoot, 'product-photo.svg');
  const validPhotoFixture = path.resolve('build/icon.png');
  await fs.mkdir(path.dirname(movedPhotoPath), { recursive: true });
  await fs.copyFile(validPhotoFixture, movedPhotoPath);
  await fs.copyFile(validPhotoFixture, parentPhotoDecoy);
  // A directory can remain at the stale image path after a reorganization. It
  // is not a valid preview and must not prevent the descendant search.
  await fs.mkdir(originalPhotoPath, { recursive: true });
  await fs.writeFile(movedSvgPath, '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>');
  await fs.writeFile(parentSvgDecoy, '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="blue"/></svg>');
  // 2025-05-01T12:00Z — ~1 year before "now", so a 1-week cadence is overdue.
  const spawnMs = Date.UTC(2025, 4, 1, 12, 0, 0);
  await page.evaluate(async ({ filePath, originalPhotoPath: photoPath, originalSvgPath: svgPath, spawnMs: ts }) => {
    const fixture = {
      schemaVersion: 2, // pre-createdAt schema — load must run the v3 migration
      nodes: [
        {
          id: 'fixture-sellhub', type: 'sellhub', position: { x: 80, y: 160 },
          data: {
            hubState: 'priced',
            product: { generated_title: 'Acme Widget Deluxe', brand: 'Acme', model: 'WD-100', condition: 'used_good', category: 'electronics' },
            pricing: { recommended_price: 42, quick_sell_price: 35, max_profit_price: 55, justification: 'e2e fixture' },
            imagePaths: [photoPath, svgPath],
            priceDropReminderWeeks: 1,
            priceDropMustSellDate: '',
            priceDropTargetPrice: 10,
            priceDropStartingTier: 'best',
            priceDropPlanStartingPrice: 42,
            priceDropPlanStartedAt: new Date(ts).toISOString(),
          },
        },
        {
          id: 'fixture-document-image', type: 'document', position: { x: 80, y: 500 },
          data: { filename: 'product-photo.png', filePath: photoPath },
        },
        {
          id: `mkt-fixture-sellhub-ebay-${ts}`, type: 'marketplacecard', position: { x: 560, y: 160 },
          data: {
            platformId: 'ebay', hubId: 'fixture-sellhub', listingUrl: '', notes: '', status: 'unknown',
            productSnapshot: { title: 'Acme Widget Deluxe', price: 42 },
          },
        },
        {
          id: 'fixture-marketplace-status', type: 'marketplacestatus', position: { x: 840, y: 160 },
          data: {
            platformStatus: {
              ebay: {
                status: 'unknown',
                message: 'Could not read this platform’s hub pages.',
                summary: '',
                attention: [],
                sources: [],
                lastChecked: '2026-06-01T12:00:00.000Z',
              },
            },
          },
        },
      ],
      edges: [],
      drawings: [],
    };
    await window.electronAPI.saveWorkspace({ data: fixture, filePath });
    await window.electronAPI.updateSettings({
      marketplaceWatchUrls: {
        ebay: [
          ' https://www.ebay.com/sh/ovw ',
          'https://www.ebay.com/sh/ovw',
        ],
      },
    });
    // Point session-restore at the fixture; the reload below auto-loads it.
    const KEY = 'infiniteCanvas.settings';
    const settings = JSON.parse(localStorage.getItem(KEY) || '{}');
    settings.lastOpenedWorkspace = filePath;
    localStorage.setItem(KEY, JSON.stringify(settings));
  }, { filePath: fixturePath, originalPhotoPath, originalSvgPath, spawnMs });
  await reloadFixture(page);
  await page.locator('.react-flow__node-sellhub').waitFor();
  await page.locator('.react-flow__node-marketplacecard').waitFor();
  const marketplaceStatus = page.locator('.react-flow__node-marketplacestatus');
  await marketplaceStatus.waitFor();

  // The original image path is broken. Loading searches only this workspace
  // hierarchy and relinks the exact filename below it, ignoring the same-name
  // decoy in the parent folder.
  const relinkedPaths = await page.evaluate(async (filePath) => {
    const loaded = await window.electronAPI.loadWorkspace({ filePath });
    return {
      sellHub: loaded.data.nodes.find(node => node.type === 'sellhub')?.data?.imagePaths,
      document: loaded.data.nodes.find(node => node.id === 'fixture-document-image')?.data?.filePath,
    };
  }, fixturePath);
  assert.equal(relinkedPaths.sellHub?.[0], movedPhotoPath, 'workspace load should relink moved SellHub preview within the current hierarchy');
  assert.equal(relinkedPaths.sellHub?.[1], movedSvgPath, 'workspace load should relink every accepted SellHub image format');
  assert.equal(relinkedPaths.document, movedPhotoPath, 'workspace load should relink moved document-image previews');
  const relinkedPreview = page.locator('.react-flow__node-sellhub img[alt="Product photo 1"]');
  await relinkedPreview.waitFor({ state: 'attached' });
  const previewProbe = await relinkedPreview.evaluate(async (image) => {
    const response = await fetch(image.src);
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      bytes: (await response.arrayBuffer()).byteLength,
    };
  });
  assert.equal(previewProbe.status, 200, `relinked preview request should succeed: ${JSON.stringify(previewProbe)}`);
  assert.ok(previewProbe.bytes > 0 && previewProbe.contentType?.startsWith('image/'),
    `relinked preview should return image bytes: ${JSON.stringify(previewProbe)}`);
  const runtimeRelinkProbe = await page.evaluate(async ({ pngPath, svgPath }) => {
    const localUrl = (filePath) => (
      `local-file://${filePath.replace(/%/g, '%25').replace(/ /g, '%20').replace(/#/g, '%23').replace(/\?/g, '%3F')}`
    );
    const direct = await fetch(localUrl(pngPath));
    const svg = await fetch(`${localUrl(svgPath)}?preview=marketplace`);
    const svgText = await svg.text();
    const report = await window.electronAPI.generateBugReportMarkdown({
      description: 'e2e moved-image relink probe',
      nodes: [],
      edges: [],
      drawings: [],
      frontEndState: {},
      eventLogs: [],
    });
    return {
      direct: { status: direct.status, contentType: direct.headers.get('content-type'), bytes: (await direct.arrayBuffer()).byteLength },
      svg: { status: svg.status, contentType: svg.headers.get('content-type'), bytes: svgText.length, movedMarker: svgText.includes('fill="red"') },
      // The clipboard path no longer returns the report body — it writes the
      // full report to an app-managed file and returns a short pointer. Hand
      // the pointer contract back to Node, which can actually read that file;
      // this is the only place the redesigned flow runs in a real Electron
      // process against a real userData directory.
      report: {
        success: report?.success === true,
        delivery: report?.delivery || null,
        savedPath: report?.savedPath || null,
        clipboardText: String(report?.clipboardText || ''),
        bytes: report?.bytes ?? null,
      },
    };
  }, { pngPath: originalPhotoPath, svgPath: originalSvgPath });
  const savedReport = runtimeRelinkProbe.report;
  assert.equal(savedReport.success && savedReport.delivery, 'file-pointer',
    `Copy to Clipboard should save a report file and return a pointer: ${JSON.stringify(savedReport)}`);
  const savedReportBody = await fs.readFile(savedReport.savedPath, 'utf8');
  assert.ok(savedReportBody.includes('## Issue Description'),
    'the saved report file should contain the full report body');
  assert.equal(Buffer.byteLength(savedReportBody), savedReport.bytes,
    'the reported byte count should match the bytes actually written');
  // The whole point of the redesign: what lands on the clipboard is a short
  // pointer, not the report. Guard both halves — it names the file, and it is
  // nowhere near the size of the thing it points at.
  assert.ok(savedReport.clipboardText.includes(savedReport.savedPath),
    `the clipboard pointer should name the saved file: ${savedReport.clipboardText.slice(0, 400)}`);
  assert.ok(savedReport.clipboardText.length < 4_000
    && savedReport.clipboardText.length < savedReportBody.length,
  `the clipboard pointer should stay far smaller than the report it points at (pointer ${savedReport.clipboardText.length} vs report ${savedReportBody.length})`);
  const relinkDiagnostics = savedReportBody
    .split('\n')
    .filter(line => line.includes('product-photo') || line.includes('[local-file]'))
    .slice(-20);
  assert.equal(runtimeRelinkProbe.direct.status, 200,
    `plain document-image requests should relink without a marketplace preview query: ${JSON.stringify(runtimeRelinkProbe.direct)} · report diagnostics: ${JSON.stringify(relinkDiagnostics)}`);
  assert.equal(runtimeRelinkProbe.svg.status, 200,
    `accepted SVG preview requests should relink at runtime: ${JSON.stringify(runtimeRelinkProbe.svg)}`);
  assert.equal(runtimeRelinkProbe.svg.contentType, 'image/svg+xml',
    `runtime SVG relink should preserve its image content type: ${JSON.stringify(runtimeRelinkProbe.svg)}`);
  assert.equal(runtimeRelinkProbe.svg.movedMarker, true,
    `runtime SVG relink should use the descendant image, not the same-name parent decoy: ${JSON.stringify(runtimeRelinkProbe.svg)}`);
  await page.waitForFunction(() => {
    const image = document.querySelector('.react-flow__node-sellhub img[alt="Product photo 1"]');
    return image?.complete && image.naturalWidth > 0;
  });
  await page.waitForFunction(() => {
    const svg = document.querySelector('.react-flow__node-sellhub img[alt="Product photo 2"]');
    const documentImage = document.querySelector('.react-flow__node-document img[alt="product-photo.png"]');
    return svg?.complete && svg.naturalWidth > 0
      && documentImage?.complete && documentImage.naturalWidth > 0;
  });
  assert.equal(await page.locator('.react-flow__node-sellhub').getByText('Missing', { exact: true }).count(), 0,
    'auto-relinked preview should render instead of the missing-image state');

  // Migration recovered the card's TRUE creation date from its id suffix.
  await page.locator('.react-flow__node-marketplacecard').getByText(/^Created .*2025/).waitFor();
  // The overdue reminder fired: pulsing border + the ack strip.
  await page.locator('.react-flow__node-marketplacecard .price-reminder-pulse, .react-flow__node-marketplacecard.price-reminder-pulse').waitFor();
  await expectVisible(page, 'Still listed — consider lowering the price.');

  // Static glow is opened from a visible card control, accepts arbitrary valid
  // CSS colors, rejects invalid input, and keeps the reminder pulse outermost.
  step('customize listing-card static glow from its visible palette button');
  const listingCard = page.locator('.react-flow__node-marketplacecard .marketplace-listing-card');
  const glowTrigger = listingCard.getByRole('button', { name: 'Customize static glow' });
  await glowTrigger.waitFor();
  await glowTrigger.click();
  await page.getByRole('heading', { name: 'Customize', exact: true }).waitFor();
  const glowInput = page.getByText('Static Glow', { exact: true }).locator('..').locator('input[type="text"]');
  await glowInput.fill('#00ff00');
  await page.waitForFunction(() => {
    const card = document.querySelector('.marketplace-listing-card');
    return card?.classList.contains('marketplace-static-glow')
      && getComputedStyle(card).borderColor === 'rgb(0, 255, 0)';
  });
  const layeredGlow = await listingCard.evaluate((card) => {
    const style = getComputedStyle(card);
    return {
      animationName: style.animationName,
      ringSpread: style.getPropertyValue('--price-reminder-ring-spread').trim(),
      haloBlur: style.getPropertyValue('--price-reminder-halo-blur').trim(),
    };
  });
  assert.equal(layeredGlow.animationName, 'price-reminder-pulse', 'static glow should not replace the reminder animation');
  assert.equal(layeredGlow.ringSpread, '10px', 'reminder ring should expand outside the static glow');
  assert.equal(layeredGlow.haloBlur, '34px', 'reminder halo should expand outside the static glow');

  await glowInput.fill('not-a-color');
  await glowInput.press('Tab');
  assert.equal(await glowInput.inputValue(), '#00ff00', 'invalid glow input should restore the last applied color');
  assert.equal(await listingCard.evaluate(card => getComputedStyle(card).borderColor), 'rgb(0, 255, 0)',
    'invalid glow input should not alter the rendered card');
  await glowInput.fill('inherit');
  await glowInput.press('Tab');
  assert.equal(await glowInput.inputValue(), '#00ff00', 'CSS-wide keywords should not invalidate the glow shadows');

  await glowInput.fill('rgba(255, 0, 0, 0)');
  await waitForCount(page.locator('.marketplace-static-glow'), n => n === 0, 'fully transparent glow should clear');
  const pulseWithoutStatic = await listingCard.evaluate((card) => {
    const style = getComputedStyle(card);
    return {
      ringSpread: style.getPropertyValue('--price-reminder-ring-spread').trim(),
      haloBlur: style.getPropertyValue('--price-reminder-halo-blur').trim(),
    };
  });
  assert.equal(pulseWithoutStatic.ringSpread, '5px', 'cleared glow should restore the normal reminder ring');
  assert.equal(pulseWithoutStatic.haloBlur, '24px', 'cleared glow should restore the normal reminder halo');
  await glowInput.fill('#00ff00');
  await page.locator('.marketplace-static-glow').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('heading', { name: 'Customize', exact: true }).waitFor({ state: 'hidden' });

  // The hub shows this item's reminder cadence.
  assert.equal(
    await page.getByLabel('Price-drop reminder interval in weeks').inputValue(), '1',
    'hub priced state should show the shared reminder weeks',
  );
  const sellHub = page.locator('.react-flow__node-sellhub');
  const mustSellInput = sellHub.getByLabel('Must sell by');
  const targetPriceInput = sellHub.getByLabel('Target price by must-sell date');
  assert.equal(await mustSellInput.inputValue(), '', 'hub should show that the optional must-sell date is initially unset');
  assert.equal(await targetPriceInput.inputValue(), '10', 'hub should show the persisted target price');

  const bestStartingTier = sellHub.getByRole('button', { name: 'Use Best price as price-drop starting value' });
  const maxStartingTier = sellHub.getByRole('button', { name: 'Use Max price as price-drop starting value' });
  assert.equal(await bestStartingTier.getAttribute('aria-pressed'), 'true', 'Best should be the selected starting tier');
  await maxStartingTier.click();
  assert.equal(await maxStartingTier.getAttribute('aria-pressed'), 'true', 'price tiers should be selectable starting values');
  await sellHub.getByText(/^Price-drop starting value: \$55\./).waitFor();

  const futureMustSellDate = new Date(Date.now() + 35 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await mustSellInput.fill(futureMustSellDate);
  await targetPriceInput.fill('5');
  await targetPriceInput.press('Tab');
  await sellHub.getByText(/^Steps from \$55 down to \$5 across \d+ reminder/).waitFor();
  await page.getByText(/^Set price to \$/).waitFor();
  // A must-sell date REQUIRES a target: clearing it warns and deactivates the
  // plan (no suggested price; reminders revert to the generic cadence).
  await targetPriceInput.fill('');
  await targetPriceInput.press('Tab');
  await sellHub.getByText(/^Enter a target price/).waitFor();
  await expectVisible(page, 'Still listed — consider lowering the price.');
  await targetPriceInput.fill('5');
  await targetPriceInput.press('Tab');
  await page.getByText(/^Set price to \$/).waitFor();
  // A target at or above the starting price warns and yields no suggestion.
  await targetPriceInput.fill('60');
  await targetPriceInput.press('Tab');
  await sellHub.getByText(/^Target must be below the starting price/).waitFor();
  await targetPriceInput.fill('5');
  await targetPriceInput.press('Tab');
  // Malformed input reverts to the last valid target.
  await targetPriceInput.fill('abc');
  await targetPriceInput.press('Tab');
  assert.equal(await targetPriceInput.inputValue(), '5', 'malformed target price should restore the last valid value');
  // A zero target means the user wants the item to become free by the deadline.
  await targetPriceInput.fill('0');
  await targetPriceInput.press('Tab');
  assert.equal(await targetPriceInput.inputValue(), '0', 'zero target price should persist as a free-listing target');
  await sellHub.getByText(/^Steps from \$55 down to \$0 across \d+ reminder/).waitFor();
  // Clearing the date falls back to a generic reminder (no suggested price).
  await mustSellInput.fill('');
  await expectVisible(page, 'Still listed — consider lowering the price.');
  await mustSellInput.fill(futureMustSellDate);
  await page.getByText(/^Set price to \$/).waitFor();

  // A genuinely overdue reminder remains pending until acknowledgment. Editing
  // the plan must not silently clear it just because the revised next cadence
  // point would be in the future.
  const reminderInput = page.getByLabel('Price-drop reminder interval in weeks');
  await reminderInput.fill('1000');
  await reminderInput.press('Tab');
  await page.waitForTimeout(250);
  assert.equal(await page.locator('.price-reminder-pulse').count(), 1,
    'lengthening the cadence should not clear an already-due reminder');
  assert.equal(await page.getByText('I lowered the price', { exact: true }).count(), 1,
    'an already-due reminder should remain actionable after cadence edits');
  await reminderInput.fill('1');
  await reminderInput.press('Tab');

  await marketplaceStatus.getByText('1 listing across 1 platform', { exact: true }).waitFor();
  await marketplaceStatus.getByText('1 listing · 1 watch URL', { exact: true }).waitFor();
  await marketplaceStatus.getByText('Check All (1)', { exact: true }).waitFor();
  await marketplaceStatus.getByText('Unknown', { exact: true }).waitFor();
  assert.equal(await marketplaceStatus.getByText('Not checked', { exact: true }).count(), 0,
    'a completed but inconclusive hub scan should not be labeled Not checked');

  // Firing the reminder must not falsely claim the user already lowered price.
  await page.keyboard.press(`${modKey}+s`);
  const firedReminderData = await waitForWorkspaceNodeData(
    page,
    fixturePath,
    'marketplacecard',
    data => data?.priceDropReminderDue === true,
    'save should persist the fired reminder state',
  );
  assert.equal(firedReminderData.priceDropReminderDue, true, 'fired reminder should persist its due flag');
  assert.equal(firedReminderData.lastPriceDropAt, undefined, 'firing alone must not write lastPriceDropAt');
  assert.equal(firedReminderData.staticGlowColor, '#00ff00', 'save should persist the listing-card static glow');
  const savedReminderPlan = await waitForWorkspaceNodeData(
    page,
    fixturePath,
    'sellhub',
    data => data?.priceDropStartingTier === 'max'
      && data?.priceDropTargetPrice === 0
      && data?.priceDropPlanStartingPrice === 55,
    'save should persist the must-sell reminder plan',
  );
  assert.equal(savedReminderPlan.priceDropMustSellDate, futureMustSellDate, 'save should persist the must-sell date');
  assert.equal(savedReminderPlan.priceDropPlanStartingPrice, 55,
    'editing the plan should snapshot the selected tier price');
  assert.equal(savedReminderPlan.priceDropPlanStartedAt, undefined,
    'editing the plan should not replace the oldest-card schedule with a separate plan-start timestamp');

  // Re-selecting the active tier re-snapshots its current value without
  // changing the shared oldest-card schedule.
  await maxStartingTier.click();
  await page.keyboard.press(`${modKey}+s`);
  const reselectedReminderPlan = await waitForWorkspaceNodeData(
    page,
    fixturePath,
    'sellhub',
    data => data?.priceDropStartingTier === 'max' && data?.priceDropPlanStartingPrice === 55,
    're-selecting the active tier should preserve its snapshotted starting value',
  );
  assert.equal(reselectedReminderPlan.priceDropPlanStartingPrice, 55,
    'same-tier selection should retain the selected current tier value');
  assert.equal(reselectedReminderPlan.priceDropPlanStartedAt, undefined,
    'same-tier selection should leave the oldest-card schedule unchanged');

  // Search finds the item on BOTH the hub and its listing card.
  await page.keyboard.press(`${modKey}+f`);
  const fixtureSearch = page.locator('[data-search-bar] input');
  await fixtureSearch.fill('Acme Widget Deluxe');
  await expectVisible(page, '2 matches');
  await page.keyboard.press('Escape');

  // Acknowledge: "I lowered the price" clears the pulse and the strip.
  await page.getByText('I lowered the price', { exact: true }).click();
  await waitForCount(page.locator('.price-reminder-pulse'), (n) => n === 0, 'ack should clear the reminder pulse');
  assert.equal(await page.locator('.marketplace-static-glow').count(), 1, 'ack should leave the static glow in place');
  assert.equal(
    await page.getByText(/^Set price to \$/).count(), 0,
    'ack should remove the reminder strip',
  );

  // Editing the plan changes future suggestion math but does not manufacture a
  // reminder before the next cadence interval.
  const extendedMustSellDate = new Date(Date.now() + 70 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await mustSellInput.fill(extendedMustSellDate);
  await page.waitForTimeout(250);
  assert.equal(await page.getByText(/^Set price to \$/).count(), 0,
    'editing the must-sell date should not immediately demand another price drop');
  assert.equal(await page.locator('.price-reminder-pulse').count(), 0,
    'editing the must-sell date should keep an acknowledged listing clear');

  // Reminder input normalization runs through the real blur-commit UI.
  await reminderInput.fill('1.5 weeks');
  await reminderInput.press('Tab');
  assert.equal(await reminderInput.inputValue(), '', 'malformed reminder cadence should normalize to off');
  await reminderInput.fill('.5');
  await reminderInput.press('Tab');
  assert.equal(await reminderInput.inputValue(), '0.5', 'decimal reminder cadence should normalize and persist');
  await page.waitForTimeout(250);
  assert.equal(await page.getByText(/^Set price to \$/).count(), 0,
    'editing the cadence should wait for the next interval instead of re-suggesting immediately');
  assert.equal(await page.locator('.price-reminder-pulse').count(), 0,
    'editing the cadence should keep an acknowledged listing clear');

  // The fire + ack wrote node data — save silently (the file path is known) so
  // the restore-blank reload below isn't blocked by the unsaved-changes guard.
  await page.keyboard.press(`${modKey}+s`);
  const acknowledgedReminderData = await waitForWorkspaceNodeData(
    page,
    fixturePath,
    'marketplacecard',
    data => data?.priceDropReminderDue === false && Number.isFinite(Date.parse(data?.lastPriceDropAt)),
    'save should persist the acknowledged reminder state',
  );
  assert.equal(acknowledgedReminderData.priceDropReminderDue, false, 'ack should persist a cleared due flag');
  assert.ok(Number.isFinite(Date.parse(acknowledgedReminderData.lastPriceDropAt)), 'ack should persist the actual price-drop timestamp');

  // Back to a blank canvas for the rest of the suite.
  await page.evaluate(() => {
    const KEY = 'infiniteCanvas.settings';
    const settings = JSON.parse(localStorage.getItem(KEY) || '{}');
    settings.lastOpenedWorkspace = null;
    localStorage.setItem(KEY, JSON.stringify(settings));
  });
  await reloadFixture(page);
  await waitForCount(page.locator('.react-flow__node'), (n) => n === 0, 'restored blank canvas should be empty');
  // The workspace-load path clears its transient dirty marker after React has
  // committed the blank canvas. Let that cleanup finish before the next reload
  // so Electron never raises a beforeunload confirmation for test scaffolding.
  await page.waitForTimeout(250);

  // ── Shared Markdown-file duplicate sync ─────────────────────────────────
  // This is deliberately a real Electron path, not a registry unit test: two
  // document nodes share one local file, renderer sessions, IPC writing, the
  // main-process watcher, and local-file reads all participate. Everything is
  // under the disposable preview fixture root.
  step('sync duplicated Markdown document nodes through disk and conflicts');
  const markdownSyncDir = path.join(previewFixtureRoot, 'markdown-sync');
  const markdownSyncFile = path.join(markdownSyncDir, 'shared.md');
  const markdownSyncWorkspace = path.join(markdownSyncDir, 'markdown-sync.json');
  // A leading UTF-8 BOM is deliberately part of the CAS baseline. Browser
  // Response.text() would strip it, whereas the validated text-read IPC must
  // retain it exactly for the first full editor replacement below.
  const initialMarkdown = '\uFEFF# Shared draft\r\n\r\nInitial value — café.\r\n';
  const initialMarkdownTextarea = initialMarkdown.replace(/\r\n|\r/g, '\n');
  await fs.mkdir(markdownSyncDir, { recursive: true });
  await fs.writeFile(markdownSyncFile, initialMarkdown, 'utf8');
  await page.evaluate(async ({ filePath, markdownPath }) => {
    const fixture = {
      schemaVersion: 3,
      nodes: [
        {
          id: 'markdown-sync-a', type: 'document', position: { x: 50, y: 80 },
          width: 560, height: 400,
          data: { filename: 'shared.md', filePath: markdownPath, isExpanded: true, expandedWidth: 560, expandedHeight: 400 },
        },
        {
          id: 'markdown-sync-b', type: 'document', position: { x: 650, y: 80 },
          width: 560, height: 400,
          data: { filename: 'shared.md', filePath: markdownPath, isExpanded: true, expandedWidth: 560, expandedHeight: 400 },
        },
      ],
      edges: [],
      drawings: [],
    };
    await window.electronAPI.saveWorkspace({ data: fixture, filePath });
    const KEY = 'infiniteCanvas.settings';
    const settings = JSON.parse(localStorage.getItem(KEY) || '{}');
    settings.lastOpenedWorkspace = filePath;
    localStorage.setItem(KEY, JSON.stringify(settings));
  }, { filePath: markdownSyncWorkspace, markdownPath: markdownSyncFile });
  step('load duplicated Markdown fixture');
  await reloadFixture(page);
  await waitForCount(page.locator('.react-flow__node-document'), (n) => n === 2,
    'Markdown duplicate fixture should load both document nodes');

  const markdownNodeA = page.locator('.react-flow__node-document[data-id="markdown-sync-a"]');
  const markdownNodeB = page.locator('.react-flow__node-document[data-id="markdown-sync-b"]');
  const markdownEditorA = markdownNodeA.getByLabel('Edit shared.md');
  const markdownEditorB = markdownNodeB.getByLabel('Edit shared.md');
  await markdownEditorA.waitFor();
  await markdownEditorB.waitFor();
  step('exercise Markdown duplicate synchronization');
  const waitForSyncedMarkdown = (content, label) => waitForAsync(async () => (
    await markdownEditorA.inputValue() === content && await markdownEditorB.inputValue() === content
  ), label);
  assert.equal(initialMarkdown[0], '\uFEFF', 'the Markdown fixture must begin with a UTF-8 BOM');
  assert.equal(await markdownEditorA.inputValue(), initialMarkdownTextarea, 'first duplicate should present the BOM-prefixed CRLF baseline as textarea LF');
  assert.equal(await markdownEditorB.inputValue(), initialMarkdownTextarea, 'second duplicate should present the same shared textarea baseline');

  step('Markdown: CRLF and BOM survive a real textarea edit');
  const crlfEditedTextarea = `${initialMarkdownTextarea}Edited without changing line endings.`;
  const crlfEditedDisk = `${initialMarkdown}Edited without changing line endings.`;
  await markdownEditorA.fill(crlfEditedTextarea);
  await waitForFileContent(markdownSyncFile, crlfEditedDisk,
    'an actual textarea edit must retain the CRLF disk convention and BOM');
  await waitForSyncedMarkdown(crlfEditedTextarea,
    'both duplicate textarea views must retain the same shared CRLF presentation draft');

  step('Markdown: local edits mirror and persist');
  const editFromA = '# Shared draft\n\nEdited from A.';
  await markdownEditorA.fill(editFromA);
  await waitForSyncedMarkdown(editFromA, 'editing A should immediately mirror in B');
  await waitForFileContent(markdownSyncFile, editFromA.replace(/\n/g, '\r\n'),
    'editing A should persist the shared file using the established CRLF convention');

  const editFromB = '# Shared draft\n\nEdited from B.';
  await markdownEditorB.fill(editFromB);
  await waitForSyncedMarkdown(editFromB, 'editing B should immediately mirror in A');
  await waitForFileContent(markdownSyncFile, editFromB.replace(/\n/g, '\r\n'),
    'editing B should persist the shared file using the established CRLF convention');

  // Exercise the real renderer quit-durability handshake without asking main
  // to close this hidden smoke window. The request is sent immediately after
  // a duplicate edit, while its normal debounce is still eligible to be
  // pending; the renderer must flush the shared session before it replies.
  step('Markdown: quit bridge flushes an immediate shared draft');
  const quitBridgeDraft = '# Shared draft\n\nFlushed by the non-closing quit bridge.';
  await markdownEditorA.fill(quitBridgeDraft);
  const quitBridgeRequestId = `smoke-quit-durability-${Date.now()}`;
  const quitBridgeResponse = await app.evaluate(({ BrowserWindow, ipcMain }, requestId) => {
    const window = BrowserWindow.getAllWindows()[0];
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        ipcMain.removeListener('quit-response', handler);
        reject(new Error('Timed out waiting for the matching quit durability response'));
      }, 5_000);
      const handler = (event, response = {}) => {
        if (event.sender !== window.webContents || response.requestId !== requestId) return;
        clearTimeout(timeoutId);
        ipcMain.removeListener('quit-response', handler);
        resolve(response);
      };
      ipcMain.on('quit-response', handler);
      window.webContents.send('quit-request', { requestId });
    });
  }, quitBridgeRequestId);
  assert.equal(quitBridgeResponse.documentSaveFailed, false,
    'the non-closing quit bridge should settle the immediate shared Markdown draft');
  await waitForFileContent(markdownSyncFile, quitBridgeDraft.replace(/\n/g, '\r\n'),
    'the quit bridge should persist its final shared Markdown draft using the established CRLF convention');
  await waitForSyncedMarkdown(quitBridgeDraft,
    'the quit bridge should leave both Markdown duplicate views converged');

  step('Markdown: repeated external saves remain observable');
  const externalAtomicOne = '# External\n\nAtomic replacement one.';
  await replaceFileAtomically(markdownSyncFile, externalAtomicOne);
  await waitForSyncedMarkdown(externalAtomicOne, 'first external atomic replacement should reach both views');
  const externalAtomicTwo = '# External\n\nAtomic replacement two.';
  await replaceFileAtomically(markdownSyncFile, externalAtomicTwo);
  await waitForSyncedMarkdown(externalAtomicTwo, 'second external atomic replacement should reach both views');
  const externalDirect = '# External\n\nDirect write.';
  await fs.writeFile(markdownSyncFile, externalDirect, 'utf8');
  await waitForSyncedMarkdown(externalDirect, 'external direct write should reach both views after atomic replacements');

  step('Markdown: collapsed duplicate reloads current disk content');
  await markdownNodeA.getByTitle('Collapse Preview').click();
  await markdownEditorA.waitFor({ state: 'detached' });
  const whileCollapsed = '# External\n\nChanged while A is collapsed.';
  await replaceFileAtomically(markdownSyncFile, whileCollapsed);
  await waitForAsync(async () => await markdownEditorB.inputValue() === whileCollapsed,
    'expanded duplicate should update while the peer is collapsed');
  await markdownNodeA.getByTitle('Preview File').click();
  await markdownEditorA.waitFor();
  await waitForSyncedMarkdown(whileCollapsed, 're-expanded duplicate should load the current shared file');

  step('Markdown: external conflict reload is safe');
  const dirtyBeforeReload = '# Local\n\nKeep this draft until conflict resolution.';
  await markdownEditorA.fill(dirtyBeforeReload);
  await waitForSyncedMarkdown(dirtyBeforeReload, 'dirty shared draft should mirror before the external conflict');
  const externalConflictOne = '# External\n\nDisk version wins on Reload.';
  await replaceFileAtomically(markdownSyncFile, externalConflictOne);
  await markdownNodeA.getByText('File changed on disk', { exact: true }).waitFor();
  await markdownNodeB.getByText('File changed on disk', { exact: true }).waitFor();
  await page.waitForTimeout(1000); // exceed the document debounce: stale draft must remain suspended
  assert.equal(await fs.readFile(markdownSyncFile, 'utf8'), externalConflictOne,
    'an external change during a dirty shared draft must not be overwritten before the user chooses');
  await markdownNodeA.getByText('Reload', { exact: true }).click();
  await waitForSyncedMarkdown(externalConflictOne, 'Reload should converge both duplicates to the disk version');
  await waitForCount(markdownNodeA.getByText('File changed on disk', { exact: true }), (n) => n === 0,
    'Reload should clear A conflict banner');
  await waitForCount(markdownNodeB.getByText('File changed on disk', { exact: true }), (n) => n === 0,
    'Reload should clear B conflict banner');

  step('Markdown: external conflict Keep mine converges');
  const dirtyBeforeKeep = '# Local\n\nKeep mine must win deliberately.';
  await markdownEditorB.fill(dirtyBeforeKeep);
  await waitForSyncedMarkdown(dirtyBeforeKeep, 'B dirty draft should mirror before Keep mine conflict');
  const externalConflictTwo = '# External\n\nDisk version loses on Keep mine.';
  await fs.writeFile(markdownSyncFile, externalConflictTwo, 'utf8');
  await markdownNodeA.getByText('File changed on disk', { exact: true }).waitFor();
  await markdownNodeB.getByText('File changed on disk', { exact: true }).waitFor();
  await markdownNodeB.getByText('Keep mine', { exact: true }).click();
  await waitForFileContent(markdownSyncFile, dirtyBeforeKeep, 'Keep mine should persist the shared draft');
  await waitForSyncedMarkdown(dirtyBeforeKeep, 'Keep mine should converge both duplicates on the persisted draft');
  await waitForCount(markdownNodeA.getByText('File changed on disk', { exact: true }), (n) => n === 0,
    'Keep mine should clear A conflict banner');
  await waitForCount(markdownNodeB.getByText('File changed on disk', { exact: true }), (n) => n === 0,
    'Keep mine should clear B conflict banner');

  step('Markdown: one duplicate can be removed safely');
  await markdownNodeA.click();
  await page.keyboard.press('Delete');
  await markdownNodeA.waitFor({ state: 'detached' });
  await waitForCount(page.getByRole('heading', { name: 'Delete from OS?', exact: true }), (n) => n === 0,
    'deleting one duplicate must not offer to trash the shared local file');
  const afterRemovingA = '# External\n\nB remains subscribed.';
  await fs.writeFile(markdownSyncFile, afterRemovingA, 'utf8');
  await waitForAsync(async () => await markdownEditorB.inputValue() === afterRemovingA,
    'removing one duplicate must leave the remaining watcher subscribed');

  await page.evaluate(() => {
    const KEY = 'infiniteCanvas.settings';
    const settings = JSON.parse(localStorage.getItem(KEY) || '{}');
    settings.lastOpenedWorkspace = null;
    localStorage.setItem(KEY, JSON.stringify(settings));
  });
  await reloadFixture(page);
  await waitForCount(page.locator('.react-flow__node'), (n) => n === 0, 'Markdown sync fixture should cleanly return to a blank canvas');

  // Create and edit a text node, then verify history controls.
  step('create, edit, undo, and redo text');
  await clickToolbar(page, 'Add Text');
  await clickPane(page, 500, 280);
  assert.equal(await nodeCount(page, 'text'), 1, 'text placement should create a node');
  const textEditor = page.locator('.react-flow__node-text [contenteditable="true"]');
  await textEditor.fill('Smoke test text');
  await textEditor.press('Escape');
  await page.locator('.react-flow__node-text').getByText('Smoke test text', { exact: true }).filter({ visible: true }).waitFor();

  await clickToolbar(page, 'Undo');
  assert.equal(await nodeCount(page), 0, 'undo should remove the created node');
  await clickToolbar(page, 'Redo');
  assert.equal(await nodeCount(page, 'text'), 1, 'redo should restore the created node');
  await page.locator('.react-flow__node-text').getByText('Smoke test text', { exact: true }).filter({ visible: true }).waitFor();

  step('exercise search, placement cancel, duplicate, copy, and paste');
  await page.keyboard.press(`${modKey}+f`);
  const searchInput = page.locator('[data-search-bar] input');
  await searchInput.fill('Smoke test text');
  await expectVisible(page, '1 match');
  await page.keyboard.press('Escape');
  assert.equal(await searchInput.inputValue(), '', 'Escape should clear search');

  const countBeforeCanceledPlacement = await nodeCount(page);
  await page.keyboard.press('t');
  await page.keyboard.press('Escape');
  await clickPane(page, 850, 250);
  assert.equal(await nodeCount(page), countBeforeCanceledPlacement, 'Escape should cancel text placement');

  const firstTextNode = page.locator('.react-flow__node-text').first();
  await firstTextNode.click();
  await page.keyboard.press(`${modKey}+d`);
  assert.equal(await nodeCount(page, 'text'), 2, 'duplicate shortcut should clone selected node');
  await page.keyboard.press(`${modKey}+c`);
  await page.keyboard.press(`${modKey}+v`);
  assert.equal(await nodeCount(page, 'text'), 3, 'copy/paste shortcuts should clone selected node');

  step('exercise text node context actions');
  // The three text nodes share identical text, and react-flow re-orders node DOM
  // on selection — a bare .first() can resolve to a DIFFERENT node between
  // actions. Pin one node by its data-id so every context action and assertion
  // targets the same node, and poll for the style commit instead of asserting
  // the instant the click returns.
  const stickyId = await firstTextNode.getAttribute('data-id');
  const stickyNode = page.locator(`.react-flow__node[data-id="${stickyId}"]`);
  await openNodeMenu(page, stickyNode);
  await page.locator('.context-menu-enter').getByText('Make Sticky Note', { exact: true }).click();
  await page.waitForFunction((id) => {
    const el = document.querySelector(`.react-flow__node[data-id="${id}"] > div`);
    return el && getComputedStyle(el).backgroundColor !== 'rgba(0, 0, 0, 0)';
  }, stickyId).catch(() => {
    throw new assert.AssertionError({ message: 'sticky-note action should apply a background' });
  });
  await openNodeMenu(page, stickyNode);
  await page.locator('.context-menu-enter').getByText('Lock Node', { exact: true }).click();
  await openNodeMenu(page, stickyNode);
  assert.ok(
    await page.locator('.context-menu-enter').getByText('Delete', { exact: true }).isDisabled(),
    'locked nodes should disable deletion',
  );
  await page.locator('.context-menu-enter').getByText('Unlock Node', { exact: true }).click();

  // Pane context menu should open, clamp, and dismiss with Escape.
  step('open and dismiss pane context menu');
  await page.locator('.react-flow__pane').click({
    button: 'right',
    position: { x: 700, y: 300 },
  });
  await page.locator('.context-menu-enter').getByText('Add Text', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.context-menu-enter').count(), 0, 'Escape should close context menu');

  // Link creation and URL editing cover node-level context menu + generic Dialog.
  step('create link and edit URL');
  await clickToolbar(page, 'Add Link');
  await clickPane(page, 700, 420);
  assert.equal(await nodeCount(page, 'link'), 1, 'link placement should create a node');
  const linkEditor = page.locator('.react-flow__node-link [contenteditable="true"]');
  await linkEditor.fill('Example');
  await linkEditor.press('Escape');
  await openNodeMenu(page, page.locator('.react-flow__node-link'));
  await page.locator('.context-menu-enter').getByText('Edit URL', { exact: true }).click();
  await page.getByRole('heading', { name: 'Edit URL', exact: true }).waitFor();
  await page.getByPlaceholder('https://...').fill('example.com');
  await page.getByText('Done', { exact: true }).click();
  await page.getByRole('heading', { name: 'Edit URL', exact: true }).waitFor({ state: 'hidden' });

  step('create and navigate a nested canvas');
  await clickToolbar(page, 'Nested Canvas');
  // `clickToolbar` invokes the button from page context so it does not wait
  // for React's placement-mode commit.  Wait for the visible placement cursor
  // before sending the next, real pointer event; otherwise the pane click can
  // race the state update and be treated as an ordinary deselect click.
  await page.locator('div.fixed.pointer-events-none.z-50:has(svg[viewBox="0 0 24 24"])').waitFor();
  await clickPane(page, 850, 250);
  await waitForCount(page.locator('.react-flow__node-group'), (count) => count === 1,
    'nested-canvas placement should create a group');
  await page.locator('.react-flow__node-group').dblclick();
  const backToParent = page.locator('button[title="Back to parent canvas"]');
  await backToParent.waitFor();
  // The back button mounts at the dive animation's midpoint state swap, while
  // the fade-in is still running — and pane double-click is guarded by
  // navigation.isAnimating. Wait for the transition overlay to unmount.
  await page.locator('.canvas-transition-overlay').waitFor({ state: 'detached' });
  await page.locator('.react-flow__pane').dblclick({ position: { x: 500, y: 260 } });
  assert.equal(await nodeCount(page, 'text'), 1, 'double-click should create text inside nested canvas');
  const nestedTextEditor = page.locator('.react-flow__node-text [contenteditable="true"]');
  await nestedTextEditor.fill('Nested smoke text');
  await nestedTextEditor.press('Escape');
  await backToParent.click();
  await backToParent.waitFor({ state: 'hidden' });
  await page.locator('.canvas-transition-overlay').waitFor({ state: 'detached' });
  assert.equal(await nodeCount(page, 'group'), 1, 'returning to parent should preserve nested canvas');

  // Tool state, option menus, settings, and sidebar panels.
  step('exercise tool options and settings');
  await clickToolbar(page, 'Snap to Grid');
  await clickToolbar(page, 'Pen Tool');
  assert.equal(await page.locator('[data-drawing-mode="pen"]').count(), 1, 'pen tool should activate');
  const drawingPolylines = page.locator('svg.pointer-events-none polyline');
  const drawingCountBefore = await drawingPolylines.count();
  const paneBox = await page.locator('.react-flow__pane').boundingBox();
  assert.ok(paneBox, 'canvas pane should have a bounding box');
  await page.mouse.move(paneBox.x + 450, paneBox.y + 520);
  await page.mouse.down();
  await page.mouse.move(paneBox.x + 500, paneBox.y + 550, { steps: 5 });
  await page.mouse.up();
  await waitForCount(drawingPolylines, (n) => n > drawingCountBefore, 'pen drag should create a drawing');
  await clickToolbar(page, 'Undo');
  await waitForCount(drawingPolylines, (n) => n === drawingCountBefore, 'undo should remove the drawing');
  await clickToolbar(page, 'Redo');
  await waitForCount(drawingPolylines, (n) => n > drawingCountBefore, 'redo should restore the drawing');
  await page.getByText('Pen Tool', { exact: true }).evaluate((node) => {
    node.closest('.relative')?.querySelector('button')?.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }),
    );
  });
  await expectVisible(page, 'Color');
  await clickPane(page, 800, 500);

  await page.getByText('Eraser', { exact: true }).evaluate((node) => {
    node.closest('.relative')?.querySelector('button')?.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }),
    );
  });
  await expectVisible(page, 'Erase by Object');
  await clickPane(page, 800, 500);

  await clickToolbar(page, 'Settings');
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  const settingsPanel = page.locator('.onboarding-panel').filter({
    has: page.getByRole('heading', { name: 'Settings', exact: true }),
  });
  // Every AI call is a human copy/paste handoff now — there is no provider to
  // pick, no API key to store, and no model family to configure. Settings must
  // therefore expose NO AI-provider surface at all. This asserts the ABSENCE of
  // the whole removed section, so a partially-reinstated control (a stray key
  // field, a leftover family dropdown) fails here rather than shipping a
  // setting that silently governs nothing.
  const removedAIControls = [
    'Gemini API', 'Claude API', 'Local AI', 'Check availability', 'Browse…',
  ];
  for (const name of removedAIControls) {
    assert.equal(
      await settingsPanel.getByRole('button', { name, exact: true }).count(), 0,
      `Settings must not expose the removed AI control "${name}"`,
    );
  }
  const removedAILabels = [
    'AI Models & APIs', 'Judgment', 'Extraction', 'Light', 'Generation',
    'Local AI Handoff', 'Service Account', 'Gemini API Key', 'Anthropic API Key',
  ];
  for (const label of removedAILabels) {
    assert.equal(
      await settingsPanel.getByText(label, { exact: true }).count(), 0,
      `Settings must not expose the removed AI control "${label}"`,
    );
  }
  assert.equal(
    await settingsPanel.getByPlaceholder('sk-ant-api...').count(), 0,
    'Settings must not expose an Anthropic API key field',
  );

  await page.keyboard.press('Escape');
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor({ state: 'hidden' });

  step('exercise sidebar drag/drop panels and issue reporter');
  await page.locator('button[title="Jobs"]').click();
  await expectVisible(page, 'Job Search Module');
  const jobModuleCard = page.getByText('Job Search Module', { exact: true }).locator('..');
  const canvasPane = page.locator('.react-flow__pane');
  // Module drops land via HTML5 DnD + a React state commit. The sidebar's
  // width transition shifts the canvas beneath the target position, so settle
  // both endpoints before the gesture; then poll for React's node commit.
  await waitForStableBox(jobModuleCard, 'Job Search module card');
  await waitForStableBox(canvasPane, 'canvas pane after opening Jobs sidebar');
  const jobDropPosition = await findTopLevelModuleDropPosition(page);
  await beginDndTrace(page);
  await jobModuleCard.dragTo(
    canvasPane,
    { targetPosition: jobDropPosition },
  );
  const jobDragTrace = await endDndTrace(page);
  const serialisedJobDragTrace = JSON.stringify(jobDragTrace);
  assert(jobDragTrace.some((event) => event.type === 'drop' && event.nodeType === 'jobhub'),
  `Job Search DnD must carry app/node-type to the pane drop (trace=${serialisedJobDragTrace})`);
  try {
    await waitForCount(
      page.locator('.react-flow__node-jobhub'),
      (n) => n === 1,
      `dragging Job Search module should create a hub (trace=${serialisedJobDragTrace})`,
    );
  } catch (error) {
    assert.fail(`${error.message}; rendererErrors=${JSON.stringify(rendererErrors)}`);
  }

  // This is intentionally UI-only: changing a platform must not initiate a
  // scrape. It proves the real rendered Job Search module exposes every scoped
  // source and that its controlled allow-list commits an off/on selection.
  step('Job Search platform allow-list renders and toggles without scraping');
  const jobHub = page.locator('.react-flow__node-jobhub');
  const jobPlatforms = jobHub.getByRole('group', { name: 'Job platforms', exact: true });
  await jobPlatforms.waitFor();
  const platformCheckboxes = jobPlatforms.getByRole('checkbox');
  assert.equal(await platformCheckboxes.count(), 9, 'Job platforms should render every production-scoped source');
  const indeedPlatform = jobPlatforms.getByRole('checkbox', { name: 'Indeed', exact: true });
  await waitForCheckbox(indeedPlatform, true, 'Indeed should be selected by default on a new Job Search module');
  // The React Flow minimap can overlap this node at some test-window sizes.
  // Keyboard activation is geometry-independent and also covers the accessible
  // interaction path for the native checkbox.
  await indeedPlatform.focus();
  await page.keyboard.press('Space');
  await waitForCheckbox(indeedPlatform, false, 'toggling Indeed off should commit the hub allow-list');
  await page.keyboard.press('Space');
  await waitForCheckbox(indeedPlatform, true, 'toggling Indeed on should restore the hub allow-list');

  // Phase B deleted the standalone Target role box and merged it into one
  // free-text "Search Brief" box (still wired to data.jobPreferences on the
  // wire — only the visible label changed). The Boolean-operator advisory
  // was specific to the old literal single-role gate (a typed "NOT"/"-term"
  // there was broadcast to boards verbatim as a doomed search operator); it
  // was deleted along with the box, so there is nothing left to smoke-test
  // for it. What replaces that guarantee is structural: the merged box must
  // actually be present, under its new name, with the old box gone.
  step('Job Search input is a single merged Search Brief box; the old Target role box is gone');
  const briefInput = jobHub.getByRole('textbox', { name: /^Search Brief/i });
  await briefInput.waitFor();
  assert.equal(
    await jobHub.getByRole('textbox', { name: /^Target role/i }).count(), 0,
    'the standalone Target role box must not exist alongside the merged Search Brief box',
  );

  await briefInput.fill('Senior Product Manager roles at large established companies.');
  assert.equal(
    await briefInput.inputValue(), 'Senior Product Manager roles at large established companies.',
    'the typed brief is written through to the hub',
  );

  await page.getByText('Job Board Module', { exact: true }).locator('..').dragTo(
    page.locator('.react-flow__pane'),
    { targetPosition: { x: 120, y: 150 } },
  );
  await waitForCount(page.locator('.react-flow__node-jobboard'), (n) => n === 1, 'dragging Job Board module should create a board');

  await page.locator('button[title="Sell"]').click();
  await expectVisible(page, 'Price Check Module');
  // This is left of the top-level Job Search module's group-safe drop point.
  // The bottom-right corner is out too: the minimap panel obscures it from
  // hit-testing.
  await page.getByText('Price Check Module', { exact: true }).locator('..').dragTo(
    page.locator('.react-flow__pane'),
    { targetPosition: { x: 380, y: 600 } },
  );
  await waitForCount(page.locator('.react-flow__node-sellhub'), (n) => n === 1, 'dragging Marketplace module should create a hub');

  await page.getByText('Marketplace Status Module', { exact: true }).locator('..').dragTo(
    page.locator('.react-flow__pane'),
    { targetPosition: { x: 850, y: 80 } },
  );
  await waitForCount(
    page.locator('.react-flow__node-marketplacestatus'), (n) => n === 1,
    'dragging Marketplace Status module should create a monitor',
  );

  await page.locator('button[title="Stats"]').click();
  await expectVisible(page, 'Dashboard');

  await page.locator('button[title="Report a Bug"]').click();
  await page.getByRole('heading', { name: 'Report an Issue', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('heading', { name: 'Report an Issue', exact: true }).waitFor({ state: 'hidden' });

  // Destructive flow must preserve state on cancel and clear on confirmation.
  step('cancel and confirm clear-canvas flow');
  const countBeforeClear = await nodeCount(page);
  await clickToolbar(page, 'Clear Canvas');
  await page.getByRole('heading', { name: 'Clear Canvas', exact: true }).waitFor();
  await page.getByText('Keep Canvas', { exact: true }).click();
  await page.getByRole('heading', { name: 'Clear Canvas', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await nodeCount(page), countBeforeClear, 'canceling clear should preserve nodes');

  await clickToolbar(page, 'Clear Canvas');
  await page.getByText('Clear Unlocked Content', { exact: true }).dblclick();
  await page.getByRole('heading', { name: 'Clear Canvas', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await nodeCount(page), 0, 'confirming clear should remove all nodes');
  assert.equal(await page.title(), 'Untitled*', 'a cleared untitled workspace should remain marked unsaved');

  await clickToolbar(page, 'Undo');
  assert.equal(
    await nodeCount(page),
    countBeforeClear,
    'a rapid confirmation must execute once so one undo restores the canvas',
  );

  assert.deepEqual(rendererErrors, [], 'renderer should not emit runtime errors');

  // Exercise the generated workspace's screen-pagination script in real
  // Chromium. Fixed-height, break-inside blocks make this deterministic: five
  // 180px blocks fit in the letter type area, so 26 blocks require six shadow
  // columns/pages. This specifically guards the fifth-column undercount that
  // occurs when CSS advances by content width while columnIndexOf divides by
  // the outer paper width.
  step('generated application preview reports every shadow page');
  const paginationBlocks = Array.from(
    { length: 26 },
    (_, index) => `<p id="pagination-block-${index + 1}">Pagination block ${index + 1}</p>`,
  ).join('');
  const paginationHtml = buildResumeDocument({
    resumeMainHtml: `<main class="page" role="document">${paginationBlocks}</main>`,
    variantAttrs: 'data-page="letter" data-density="comfortable"',
    docId: 'pagination-smoke',
  }).replace(
    '</style>',
    'main.page > p { box-sizing:border-box;height:180px;margin:0;break-inside:avoid; }</style>',
  );
  await page.setContent(paginationHtml, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(document.querySelector('#ic-resume-panel .ic-page-stage')?.dataset.icPageCount));
  const paginationState = await page.evaluate(() => {
    const stage = document.querySelector('#ic-resume-panel .ic-page-stage');
    const pageElement = stage?.querySelector('main.page');
    const firstBlock = pageElement?.querySelector('[id^="pagination-block-"]');
    const pageStyle = pageElement ? getComputedStyle(pageElement) : null;
    const blockStyle = firstBlock ? getComputedStyle(firstBlock) : null;
    return {
      count: stage?.dataset.icPageCount || '',
      hasRecompute: typeof window.icPageGuidesRecompute === 'function',
      blockCount: pageElement?.querySelectorAll('[id^="pagination-block-"]').length || 0,
      pageWidth: pageElement?.getBoundingClientRect().width || 0,
      pageMinHeight: pageStyle?.minHeight || '',
      paddingTop: pageStyle?.paddingTop || '',
      paddingSide: pageStyle?.paddingLeft || '',
      blockHeight: blockStyle?.height || '',
    };
  });
  assert.equal(
    paginationState.count,
    '6',
    `screen pagination should retain all six fixed-height shadow columns: ${JSON.stringify(paginationState)}`,
  );
  assert.deepEqual(rendererErrors, [], 'generated pagination workspace should not emit runtime errors');
  console.log('Electron smoke test passed');
} finally {
  // Playwright's ElectronApplication.close() explicitly calls app.quit(), which
  // reaches main's background before-quit cleanup. A POSIX SIGTERM is only a
  // process signal and is not an Electron lifecycle contract, so it must remain
  // a last-resort kill rather than the primary shutdown path.
  if (app) {
    const electronProcess = app.process();
    if (electronProcess.exitCode === null) {
      let timeoutId;
      try {
        await Promise.race([
          app.close(),
          new Promise(resolve => {
            // Main gives background cleanup a bounded window to release a
            // headless Chromium profile and loopback server before app.exit().
            // Keep a margin before the hard-kill fallback for event-loop lag.
            timeoutId = setTimeout(resolve, BACKGROUND_E2E_SHUTDOWN_TIMEOUT_MS + 5_000);
          }),
        ]);
      } catch (error) {
        // A rejected app.close() must not skip the SIGKILL fallback or either
        // disposable-root cleanup below.
        console.warn(`Electron smoke shutdown failed: ${error?.message || error}`);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    }
    if (electronProcess.exitCode === null) {
      electronProcess.kill('SIGKILL');
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  await Promise.allSettled([
    fs.rm(userDataDir, { recursive: true, force: true }),
    fs.rm(previewFixtureRoot, { recursive: true, force: true }),
  ]);
}
