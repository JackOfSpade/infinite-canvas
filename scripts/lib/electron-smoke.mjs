import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function makeSmokeDir(prefix, { real = false } = {}) {
  const dir = await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), prefix));
  return real ? fs.realpath(dir) : dir;
}

export function smokeEnv(extra = {}) {
  const env = { ...process.env, INFINITE_CANVAS_E2E: '1', INFINITE_CANVAS_E2E_BACKGROUND: '1', ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

// Points the next reload at filePath and lets that reload skip the unsaved-work prompt.
export async function seedLastOpenedWorkspace(page, filePath) {
  await page.evaluate(target => {
    const key = 'infiniteCanvas.settings';
    localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) || '{}'), lastOpenedWorkspace: target }));
    window.addEventListener('beforeunload', event => { event.stopImmediatePropagation(); delete event.returnValue; }, { capture: true, once: true });
  }, filePath);
}

// Failure diagnostics must never replace the assertion error that triggered them.
export async function reportSmokeFailure(application, screenshotPath, chars = 5000) {
  try {
    const page = application?.windows()[0];
    if (!page) return;
    console.error((await page.locator('body').innerText()).slice(0, chars));
    await page.screenshot({ path: screenshotPath });
  } catch { /* the original failure is thrown by the caller */ }
}
