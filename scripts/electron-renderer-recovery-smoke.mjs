import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { closeDisposableElectron } from './close-disposable-electron.mjs';

// A disposable hidden app tests an actual native renderer death. Never attach
// to, crash, reload or write the person's running application/profile.
const root = await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'ic-renderer-recovery-'));
const canvas = path.join(root, 'recovery.json');
const profile = path.join(root, 'profile');
const env = { ...process.env, INFINITE_CANVAS_E2E: '1', INFINITE_CANVAS_E2E_BACKGROUND: '1' };
delete env.ELECTRON_RUN_AS_NODE;
let application;
try {
  await fs.writeFile(canvas, JSON.stringify({ schemaVersion: 1,
    nodes: [{ id: 'recovery-note', type: 'text', position: { x: 0, y: 0 }, data: { text: 'Saved recovery fixture' } }],
    edges: [], drawings: [],
  }));
  application = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env });
  const page = await application.firstWindow();
  await page.waitForFunction(() => typeof window.electronAPI?.loadWorkspace === 'function');
  await page.waitForLoadState('load');
  const loaded = await page.evaluate(filePath => window.electronAPI.loadWorkspace({ filePath }), canvas);
  assert.ok(loaded.data?.nodes?.length === 1, loaded.error || 'saved fixture must load');
  // Replace only the disposable app's native dialog so this test cannot pop a
  // desktop modal. The real recovery handler still selects its own file path.
  await application.evaluate(({ dialog }) => {
    globalThis.__recoveryDialogs = [];
    dialog.showMessageBox = async (_win, options) => {
      globalThis.__recoveryDialogs.push(options);
      return { response: 0 };
    };
  });
  const crashed = page.waitForEvent('crash');
  await application.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    globalThis.__recoveredCanvas = new Promise(resolve => contents.once('did-finish-load', resolve));
    contents.forcefullyCrashRenderer();
  });
  await crashed;
  await application.evaluate(() => globalThis.__recoveredCanvas);
  // The same WebContents must become a working canvas again after recovery.
  const recovered = await application.evaluate(async ({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const until = Date.now() + 30_000;
    do {
      try { if (await contents.executeJavaScript("document.body.innerText.includes('Saved recovery fixture')")) return true; } catch { /* navigation settling */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < until);
    return false;
  });
  assert.ok(recovered, 'same window must restore its saved canvas after native renderer death');
  const dialogs = await application.evaluate(() => globalThis.__recoveryDialogs);
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].buttons[0], 'Reload saved canvas');
  const receipts = JSON.parse(await fs.readFile(path.join(profile, 'renderer-crashes.json'), 'utf8'));
  assert.equal(receipts.length, 1);
  assert.ok(['crashed', 'killed'].includes(receipts[0].reason));
  assert.ok(receipts[0].savedWorkspaceBytes > 0);
  assert.ok(!JSON.stringify(receipts).includes(root));
  // After choosing to leave a second crashed window open, normal Close must
  // reach its discard/close path instead of waiting forever for a dead ACK.
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await application.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    globalThis.__secondCrash = new Promise(resolve => win.webContents.once('render-process-gone', resolve));
    win.webContents.forcefullyCrashRenderer();
  });
  await application.evaluate(() => globalThis.__secondCrash);
  await application.evaluate(({ BrowserWindow }) => new Promise(resolve => {
    const win = BrowserWindow.getAllWindows()[0];
    const timeout = setTimeout(() => resolve({ closed: false, stopped: win.__rendererStopped, closing: win.__closeHandshakeInFlight }), 4000);
    win.once('closed', () => { clearTimeout(timeout); resolve({ closed: true }); });
    win.close();
  }));
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 0);
  console.log('PASS: native renderer crash → one recovery dialog → same window restores the host-verified saved canvas; durable receipt verified.');
} finally {
  try { await closeDisposableElectron(application); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
