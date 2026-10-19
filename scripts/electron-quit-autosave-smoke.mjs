import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

// A hidden disposable process exercises the production quit handshake. It
// never attaches to the running app or calls a provider/model.
const root = await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'ic-quit-autosave-'));
const canvas = path.join(root, 'quit.json');
const profile = path.join(root, 'profile');
const env = { ...process.env, INFINITE_CANVAS_E2E: '1', INFINITE_CANVAS_E2E_BACKGROUND: '1', INFINITE_CANVAS_E2E_QUIT_HANDSHAKE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
let application;
try {
  const search = { id: 'hidden-search', type: 'jobhub', position: { x: 0, y: 0 }, data: {
    hubState: 'empty', locked: true, manualAiResume: {
      runId: 'synthetic-accepted-run', task: 'job-preference-research', pausedByUser: true,
      preSearchRecovery: { stage: 'preferences', syntheticAcceptedText: 'Keep this exact recovery payload' },
    },
  } };
  const board = { id: 'hidden-board', type: 'jobboard', position: { x: 400, y: 0 }, data: {
    locked: true, selectedSearchModuleIds: ['hidden-search'],
    boardScanResume: { version: 1, phase: 'searches', boardRunId: 'synthetic-board-run',
      selectedSearchModuleIds: ['hidden-search'], activeSourceIds: ['hidden-search'] },
  } };
  const fixture = { schemaVersion: 1, nodes: [
    { id: 'quit-note', type: 'text', position: { x: 0, y: 0 }, data: { text: 'Original saved text' } },
    { id: 'hidden-work', type: 'group', position: { x: 500, y: 0 }, data: {
      label: 'Saved work', canvasData: { nodes: [search, board], edges: [], drawings: [] },
    } },
  ], edges: [], drawings: [] };
  await fs.writeFile(canvas, JSON.stringify(fixture));
  application = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env });
  const page = await application.firstWindow();
  const errors = [];
  const lifecycleErrors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') lifecycleErrors.push(message.text()); });
  application.process().stderr.on('data', chunk => lifecycleErrors.push(String(chunk)));
  await page.waitForFunction(() => typeof window.electronAPI?.loadWorkspace === 'function');
  const skip = page.getByText('Skip', { exact: true });
  await skip.click({ timeout: 5000 }).catch(() => {});
  await page.evaluate(filePath => {
    const key = 'infiniteCanvas.settings';
    localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) || '{}'), lastOpenedWorkspace: filePath }));
    window.addEventListener('beforeunload', event => { event.stopImmediatePropagation(); delete event.returnValue; }, { capture: true, once: true });
  }, canvas);
  await page.reload();
  await page.getByText('Skip', { exact: true }).click({ timeout: 1000 }).catch(() => {});
  const note = page.locator('.react-flow__node[data-id="quit-note"]');
  await note.getByText('Original saved text', { exact: true }).last().waitFor();
  await application.evaluate(({ dialog }) => {
    globalThis.__quitDialogs = [];
    dialog.showMessageBoxSync = (_win, options) => { globalThis.__quitDialogs.push(options.title); return 0; };
    dialog.showMessageBox = async (_win, options) => { globalThis.__quitDialogs.push(options.title); return { response: 0 }; };
  });
  // A real failed file write must keep the app alive and release inert. The
  // recovery markers published during this attempt must survive the retry.
  await fs.chmod(canvas, 0o400);
  await note.getByText('Original saved text', { exact: true }).last().dblclick();
  await note.locator('[contenteditable="true"]').fill('Text saved automatically on quit');
  await application.evaluate(({ app }) => { setImmediate(() => app.quit()); });
  try {
    await page.waitForFunction(() => document.body.inert === false && /Save Failed|Save Error/.test(document.body.innerText), null, { timeout: 30_000 });
  } catch (error) {
    throw new Error(`${error.message}\n${lifecycleErrors.join('\n')}\n${await page.locator('body').innerText()}`);
  }
  assert.equal(JSON.parse(await fs.readFile(canvas, 'utf8')).nodes[0].data.text, 'Original saved text');
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  assert.deepEqual(await application.evaluate(() => globalThis.__quitDialogs), [], 'healthy quit never asks Save/Discard; a write failure stays open');
  await fs.chmod(canvas, 0o600);
  const closed = application.waitForEvent('close', { timeout: 45_000 });
  await application.evaluate(({ app }) => { setImmediate(() => app.quit()); });
  await closed;
  application = null;
  const saved = JSON.parse(await fs.readFile(canvas, 'utf8'));
  assert.equal(saved.nodes.find(node => node.id === 'quit-note').data.text, 'Text saved automatically on quit');
  const hidden = saved.nodes.find(node => node.id === 'hidden-work').data.canvasData.nodes;
  const savedSearch = hidden.find(node => node.id === 'hidden-search');
  assert.equal(savedSearch.data.manualAiResume.runId, search.data.manualAiResume.runId);
  assert.deepEqual(savedSearch.data.manualAiResume.preSearchRecovery, search.data.manualAiResume.preSearchRecovery);
  assert.equal(savedSearch.data.manualAiResume.autoResumeEligible, false);
  assert.equal(hidden.find(node => node.id === 'hidden-board').data.boardScanResume.autoResumeEligible, false);
  assert.deepEqual(errors, []);
  // An untouched untitled canvas has no checkpoint to name. It must still
  // quit without opening Save As or getting stuck on the hidden dialog guard.
  application = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'blank-profile')}`], env });
  const blank = await application.firstWindow();
  await blank.waitForFunction(() => typeof window.electronAPI?.sendQuitPauseAck === 'function');
  await blank.locator('.react-flow').waitFor();
  const blankClosed = application.waitForEvent('close', { timeout: 30_000 });
  await application.evaluate(({ app }) => { setImmediate(() => app.quit()); });
  await blankClosed;
  application = null;
  console.log('PASS: production Quit pauses hidden workflows and automatically saves the canvas; failed save keeps the window usable and a retry preserves exact recovery data.');
} finally {
  try {
    if (application) {
      // Test cleanup only: bypass the production handshake if an assertion
      // failed while the deliberately unwritable fixture was still open.
      await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await application.close().catch(() => {});
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
