import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { closeDisposableElectron } from './close-disposable-electron.mjs';

// Real permission errors in a disposable app/profile. Never writes a user's canvas.
const root = await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'ic-autosave-recovery-'));
const canvas = path.join(root, 'canvas.json');
const env = { ...process.env, INFINITE_CANVAS_E2E: '1', INFINITE_CANVAS_E2E_BACKGROUND: '1' };
delete env.ELECTRON_RUN_AS_NODE;
let application;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
const savedText = async () => JSON.parse(await fs.readFile(canvas, 'utf8')).nodes.find(node => node.id === 'autosave-note').data.text;
try {
  await fs.writeFile(canvas, JSON.stringify({ schemaVersion: 1, nodes: [
    { id: 'autosave-note', type: 'text', position: { x: 0, y: 0 }, data: { text: 'Saved baseline' } },
  ], edges: [], drawings: [] }));
  application = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], env });
  const page = await application.firstWindow();
  const errors = [];
  let refusals = 0;
  application.process().stderr.on('data', chunk => { refusals += String(chunk).split('[save-workspace] failed:').length - 1; });
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof window.electronAPI?.loadWorkspace === 'function');
  await page.getByText('Skip', { exact: true }).click({ timeout: 1000 }).catch(() => {});
  await page.evaluate(filePath => {
    const key = 'infiniteCanvas.settings';
    localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) || '{}'), lastOpenedWorkspace: filePath }));
    window.addEventListener('beforeunload', event => { event.stopImmediatePropagation(); delete event.returnValue; }, { capture: true, once: true });
  }, canvas);
  await page.reload();
  await page.getByText('Skip', { exact: true }).click({ timeout: 1000 }).catch(() => {});
  const note = page.locator('.react-flow__node[data-id="autosave-note"]');
  await note.getByText('Saved baseline', { exact: true }).last().waitFor();
  async function edit(before, after) {
    await note.getByText(before, { exact: true }).last().dblclick();
    const editor = note.locator('[contenteditable="true"]');
    await editor.fill(after);
    await editor.evaluate(element => element.blur());
  }
  await fs.chmod(canvas, 0o400);
  await edit('Saved baseline', 'Recovered without another edit');
  await until(() => refusals > 0, 'real read-only autosave refusal');
  assert.equal(await savedText(), 'Saved baseline');
  await fs.chmod(canvas, 0o600);
  await until(async () => await savedText() === 'Recovered without another edit', 'automatic retry after file permissions recover');

  // Reproduce the report's exact host refusal. Recovery may retry, but it
  // must never mutate the inode while another name still points at it.
  const alias = path.join(root, 'linked-canvas.json');
  const watched = await page.evaluate(async filePath => {
    window.__autosaveWatchChanges = [];
    window.__autosaveWatchStop = window.electronAPI.onFileChanged(changedPath => {
      if (changedPath === filePath) window.__autosaveWatchChanges.push(Date.now());
    });
    return window.electronAPI.startFileWatch(filePath);
  }, canvas);
  assert.equal(watched.success, true);
  await fs.link(canvas, alias);
  const beforeLink = refusals;
  await edit('Recovered without another edit', 'Recovered after transient hard link');
  await until(() => refusals > beforeLink, 'real hard-link autosave refusal');
  await page.getByText('Auto-save Failed', { exact: true }).waitFor({ timeout: 35000 });
  assert.equal(refusals - beforeLink, 4, 'hard link outlasts all quick retries');
  assert.equal(await savedText(), 'Recovered without another edit');
  assert.equal(JSON.parse(await fs.readFile(alias, 'utf8')).nodes[0].data.text, 'Recovered without another edit');
  const changesWhileLinked = await page.evaluate(() => window.__autosaveWatchChanges.length);
  await sleep(1500);
  assert.equal(await page.evaluate(() => window.__autosaveWatchChanges.length), changesWhileLinked,
    'the watcher must not notify while the target has another hard link');
  await fs.unlink(alias);
  await until(async () => await page.evaluate(() => window.__autosaveWatchChanges.length) > changesWhileLinked,
    'document watcher revalidates and resumes after the transient hard link');
  await until(async () => await savedText() === 'Recovered after transient hard link', 'safe polling recovery after hard link disappears', 40000);

  const before = refusals;
  await fs.chmod(canvas, 0o400);
  await edit('Recovered after transient hard link', 'Retained through repeated failure');
  await page.getByText('Auto-save Failed', { exact: true }).waitFor({ timeout: 35000 });
  assert.equal(refusals - before, 4, 'initial attempt plus three bounded retries');
  assert.equal(await savedText(), 'Recovered after transient hard link');
  assert.match(await page.locator('body').innerText(), /Your changes are still unsaved/);
  await fs.chmod(canvas, 0o600);
  await until(async () => await savedText() === 'Retained through repeated failure', 'save after persistent-error recovery without another edit', 40000);
  await page.getByText('Auto-save Restored', { exact: true }).waitFor();
  await page.evaluate(async filePath => {
    window.__autosaveWatchStop();
    await window.electronAPI.stopFileWatch(filePath);
  }, canvas);
  assert.deepEqual(errors, []);
  console.log('PASS: real read-only and hard-link autosave failures recover without another edit; persistent refusals preserve disk data and recover visibly; document notifications resume safely after a hard link disappears.');
} finally {
  await closeDisposableElectron(application);
  await fs.rm(root, { recursive: true, force: true });
}
