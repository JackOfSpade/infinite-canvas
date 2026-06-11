import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'infinite-canvas-e2e-'));
const workspacePath = path.join(userDataDir, 'roundtrip.json');
const env = { ...process.env };
const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';

// Codex and some CI environments use Electron as a Node runtime. Playwright
// needs the normal Electron runtime for renderer automation.
delete env.ELECTRON_RUN_AS_NODE;
env.INFINITE_CANVAS_E2E = '1';

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

async function clickPane(page, x, y) {
  await page.locator('.react-flow__pane').click({ position: { x, y } });
}

async function openNodeMenu(page, node) {
  await node.click({ button: 'right', position: { x: 5, y: 5 } });
  await page.locator('.context-menu-enter').waitFor();
}

try {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    env,
  });

  const page = await app.firstWindow();
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
  await clickPane(page, 850, 250);
  assert.equal(await nodeCount(page, 'group'), 1, 'nested-canvas placement should create a group');
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
  await page.keyboard.press('Escape');
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor({ state: 'hidden' });

  step('exercise sidebar drag/drop panels and issue reporter');
  await page.locator('button[title="Jobs"]').click();
  await expectVisible(page, 'Job Search Module');
  await page.getByText('Job Search Module', { exact: true }).locator('..').dragTo(
    page.locator('.react-flow__pane'),
    { targetPosition: { x: 700, y: 300 } },
  );
  assert.equal(await nodeCount(page, 'jobhub'), 1, 'dragging Job Search module should create a hub');

  await page.getByText('Job Board Module', { exact: true }).locator('..').dragTo(
    page.locator('.react-flow__pane'),
    { targetPosition: { x: 120, y: 150 } },
  );
  assert.equal(await nodeCount(page, 'jobboard'), 1, 'dragging Job Board module should create a board');

  await page.locator('button[title="Sell"]').click();
  await expectVisible(page, 'Price Check Module');
  // (380, 600) is clear of the jobhub just dropped at (700, 300) — hubs are
  // 280×350, so the old (800, 420) target landed ON the jobhub and the module
  // drop was (correctly) rejected rather than spawning a sellhub. The bottom-
  // right corner is out too: the minimap panel obscures it from hit-testing.
  await page.getByText('Price Check Module', { exact: true }).locator('..').dragTo(
    page.locator('.react-flow__pane'),
    { targetPosition: { x: 380, y: 600 } },
  );
  assert.equal(await nodeCount(page, 'sellhub'), 1, 'dragging Marketplace module should create a hub');

  await page.getByText('Marketplace Status Module', { exact: true }).locator('..').dragTo(
    page.locator('.react-flow__pane'),
    { targetPosition: { x: 850, y: 80 } },
  );
  assert.equal(
    await nodeCount(page, 'marketplacestatus'), 1,
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
  await page.getByText('Clear Everything', { exact: true }).dblclick();
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
  console.log('Electron smoke test passed');
} finally {
  await app?.evaluate(({ app: electronApp }) => {
    setTimeout(() => electronApp.exit(0), 0);
  }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 250));
  await fs.rm(userDataDir, { recursive: true, force: true });
}
