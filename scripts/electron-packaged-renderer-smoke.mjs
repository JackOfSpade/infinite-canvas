#!/usr/bin/env node

// Check the actual packaged renderer dependency boundary and launch its native
// Playwright copy. This process never runs the app entry, loads a workspace,
// attaches to user Chrome, or uses an existing browser profile.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  assert.ok(['--app-path', '--asar-path', '--electron-path', '--chrome-path'].includes(flag), `Unknown argument: ${flag}`);
  const value = process.argv[index + 1];
  assert.ok(value && !value.startsWith('--'), `Missing value for ${flag}`);
  options[flag.slice(2)] = path.resolve(value);
}
const appPath = options['app-path'] || path.join(root, 'release/mac-arm64/infinite-canvas.app');
const asarPath = options['asar-path'] || path.join(appPath, 'Contents/Resources/app.asar');
const electronPath = options['electron-path'] || path.join(root, process.platform === 'darwin'
  ? 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
  : process.platform === 'win32' ? 'node_modules/electron/dist/electron.exe' : 'node_modules/electron/dist/electron');
await fs.access(asarPath);
await fs.access(electronPath);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ic-packaged-renderer-smoke-'));
const probePath = path.join(temporary, 'probe.cjs');
const probe = String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { app } = require('electron');
const config = ${JSON.stringify({ temporary, asarPath, chromePath: options['chrome-path'] || null })};
for (const name of ['userData', 'sessionData']) {
  const directory = path.join(config.temporary, name);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  app.setPath(name, directory);
}
app.disableHardwareAcceleration();
app.dock?.hide();
const result = { ok: false, isolatedUserData: true, stages: [] };
let browser;
let exiting = false;
async function finish(exitCode) {
  if (exiting) return;
  exiting = true;
  clearTimeout(deadline);
  await browser?.close().catch(() => {});
  console.log('IC_PACKAGED_RENDERER_SMOKE ' + JSON.stringify(result));
  app.exit(exitCode);
}
const deadline = setTimeout(() => {
  result.error = 'Isolated packaged renderer probe timed out';
  void finish(1);
}, 25000);
app.whenReady().then(async () => {
  try {
    result.stages.push('isolated-electron-ready');
    const chunkRoot = path.join(config.asarPath, 'dist-electron');
    let rendererChunk;
    for (const name of fs.readdirSync(chunkRoot).filter(name => name.endsWith('.cjs'))) {
      const source = fs.readFileSync(path.join(chunkRoot, name), 'utf8');
      if (!source.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp')) continue;
      assert.match(source, /\b(?:require|import)\(\s*['"\x60]playwright['"\x60]\s*\)/u,
        'The built official renderer must resolve Playwright as a native package; its package-relative runtime cannot be bundled');
      rendererChunk = path.join(chunkRoot, name);
      break;
    }
    assert.ok(rendererChunk, 'The packaged official renderer implementation must be present');
    result.stages.push('compiled-native-import-verified');
    const nativeRequire = createRequire(rendererChunk);
    const modulePath = nativeRequire.resolve('playwright');
    assert.ok(modulePath.startsWith(config.asarPath + path.sep), 'Use the packaged dependency rather than a development copy');
    const { chromium } = nativeRequire('playwright');
    result.stages.push('packaged-playwright-loaded');
    const installedBrowser = chromium.executablePath();
    result.stages.push('browser-metadata-resolved');
    const candidates = config.chromePath ? [config.chromePath] : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', installedBrowser]
      : [installedBrowser];
    const executablePath = candidates.find(candidate => fs.existsSync(candidate));
    assert.ok(executablePath, 'An installed Chromium executable is required for this smoke');
    browser = await chromium.launch({ executablePath, headless: true, timeout: 10000,
      proxy: { server: 'http://127.0.0.1:9', bypass: '<-loopback>' },
      args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run',
        '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
    result.stages.push('own-headless-browser-launched');
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
    await context.route('**/*', route => route.abort());
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    await page.setContent('<!doctype html><title>Packaged renderer smoke</title><p>Synthetic fixture</p>');
    assert.equal(await page.title(), 'Packaged renderer smoke');
    assert.equal(page.url(), 'about:blank');
    result.stages.push('synthetic-document-read');
    result.ok = true;
  } catch (error) {
    result.error = String(error?.message || error).slice(0, 4000);
  } finally { await finish(result.ok ? 0 : 1); }
}).catch(error => {
  result.error = String(error?.message || error).slice(0, 4000);
  void finish(1);
});
`;
try {
  await fs.writeFile(probePath, probe, { mode: 0o600 });
  const environment = { ...process.env, INFINITE_CANVAS_E2E: '1', INFINITE_CANVAS_E2E_BACKGROUND: '1' };
  delete environment.ELECTRON_RUN_AS_NODE;
  let output;
  try {
    output = await promisify(execFile)(electronPath, [probePath], {
      env: environment, timeout: 35000, maxBuffer: 512 * 1024,
    });
  } catch (error) {
    throw new Error(`Packaged renderer smoke failed:\n${error.stdout || error.stderr || error.message}`);
  }
  const receipt = output.stdout.split('\n').find(line => line.startsWith('IC_PACKAGED_RENDERER_SMOKE '));
  assert.ok(receipt, 'Isolated Electron must return a packaged renderer receipt');
  const result = JSON.parse(receipt.slice('IC_PACKAGED_RENDERER_SMOKE '.length));
  assert.equal(result.ok, true, result.error);
  console.log(`Packaged official renderer smoke passed: ${result.stages.join(' → ')}`);
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
