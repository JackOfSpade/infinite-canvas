import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

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

// Poll `read` until `accept(value)` holds, then return that value. On timeout
// the failure message is `format(label, lastValue)`, so it names what was last
// seen. Asserting the instant an input event returns races React's commit,
// which is the smokes' main flake source.
export async function pollUntil(read, accept, label, {
  timeoutMs = 5000,
  intervalMs = 100,
  format = (text, value) => `${text} (last=${JSON.stringify(value)})`,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) assert.fail(format(label, value));
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

// Bundle an inline CommonJS entry with esbuild and run it in a real Electron
// process that is killed after `timeoutMs`. Resolves with the captured output;
// rejects when the process errors, times out or exits non-zero. `echo` also
// forwards the output to this process as it arrives.
export async function runInlineElectronEntry({
  source, sourcefile, resolveDir, outfile, cwd = resolveDir, timeoutMs, define, echo = false, failureLabel,
}) {
  const { build } = await import('esbuild');
  const { default: electronPath } = await import('electron');
  await build({
    stdin: { contents: source, resolveDir, sourcefile },
    outfile, bundle: true, platform: 'node', format: 'cjs', packages: 'external', ...(define ? { define } : {}),
  });
  const env = { ...process.env, INFINITE_CANVAS_E2E_BACKGROUND: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    const child = spawn(electronPath, [outfile], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; if (echo) process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { output += chunk; if (echo) process.stderr.write(chunk); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`${failureLabel} exited ${code}\n${output.slice(-5000)}`));
    });
  });
}
