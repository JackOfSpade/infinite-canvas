#!/usr/bin/env node
/*
 * Disposable acceptance launcher for the small career-import canvas.
 *
 * This deliberately does NOT edit Chromium's production Local Storage
 * LevelDB. Chromium owns checksums, manifests, write-ahead logs and
 * compaction; changing one byte in an .ldb/.log file is not a surgical
 * setting update. Instead, this starts the packaged application with a brand
 * new temporary --user-data-dir, sets its normal renderer localStorage value,
 * reloads, and proves that the fixture node rendered. The temporary profile is
 * deleted after the app exits unless --keep-profile was explicitly requested.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE_ROOT = path.join(ROOT, '.test-artifacts', 'blackbox-run', 'fixtures');
const DEFAULT_FIXTURE = path.join(FIXTURE_ROOT, 'career-import-d4471f24-fb63-4c24-bb04-d919f295b1c9.canvas');
const DEFAULT_APP = path.join(ROOT, 'release', 'mac-arm64', 'infinite-canvas.app', 'Contents', 'MacOS', 'infinite-canvas');
const SETTINGS_KEY = 'infiniteCanvas.settings';
const execFileAsync = promisify(execFile);

function usage() {
  return `
Usage:
  node .test-artifacts/blackbox-run/launch-career-fixture.mjs self-test
  node .test-artifacts/blackbox-run/launch-career-fixture.mjs launch --execute [--fixture FILE] [--app FILE] [--keep-profile]

Safety contract:
  - launch refuses while any packaged Infinite Canvas process is running;
  - launch uses a new temporary Chromium --user-data-dir, never production userData;
  - --fixture must be a regular non-link file below .test-artifacts/blackbox-run/fixtures;
  - --execute is required; temporary profile cleanup is automatic unless --keep-profile is supplied.
`;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (['execute', 'keep-profile'].includes(key)) options[key] = true;
    else {
      const value = rest[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
      options[key] = value;
    }
  }
  return { command, options };
}

function canonical(value) {
  return path.resolve(String(value || '')).normalize('NFC');
}

function isBelow(root, target) {
  const relative = path.relative(root, target);
  return Boolean(relative) && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function assertRegularFile(file, label) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-link file.`);
  return stat;
}

async function fixtureInfo(candidate) {
  const fixture = canonical(candidate || DEFAULT_FIXTURE);
  const fixtureRoot = await fs.realpath(FIXTURE_ROOT);
  if (!isBelow(fixtureRoot, fixture)) throw new Error(`Fixture must remain below ${fixtureRoot}.`);
  await assertRegularFile(fixture, 'Fixture');
  const raw = await fs.readFile(fixture, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed?.nodes) || parsed.nodes.length !== 1 || typeof parsed.nodes[0]?.id !== 'string') {
    throw new Error('Fixture must be the one-node acceptance canvas.');
  }
  return Object.freeze({
    fixture,
    nodeId: parsed.nodes[0].id,
    sha256: crypto.createHash('sha256').update(raw).digest('hex'),
  });
}

async function packagedAppPath(candidate) {
  const appPath = canonical(candidate || DEFAULT_APP);
  if (appPath !== canonical(DEFAULT_APP)) throw new Error('Only the repository packaged app is allowed.');
  await assertRegularFile(appPath, 'Packaged app executable');
  return appPath;
}

async function runningPackagedAppPids() {
  const { stdout } = await execFileAsync('/bin/ps', ['-axww', '-o', 'pid=,command='], { maxBuffer: 2 * 1024 * 1024 });
  const marker = '/infinite-canvas.app/Contents/';
  return String(stdout).split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+([\s\S]+)$/);
    if (!match || !match[2].includes(marker)) return [];
    return [Number(match[1])];
  }).filter(pid => Number.isInteger(pid) && pid > 1);
}

async function requireAppFullyStopped() {
  const pids = await runningPackagedAppPids();
  if (pids.length) throw new Error(`Refusing fixture launch while packaged Infinite Canvas is running (PIDs: ${pids.join(', ')}). Quit it completely first.`);
}

function profileRootPrefix() {
  return path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'infinite-canvas-career-fixture-');
}

async function launchFixture({ fixture: candidate, app: appCandidate, keepProfile = false }) {
  await requireAppFullyStopped();
  const fixture = await fixtureInfo(candidate);
  const executablePath = await packagedAppPath(appCandidate);
  const profile = await fs.mkdtemp(profileRootPrefix());
  let app = null;
  let result = null;
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    // This is the same safety mode used by the repository smoke suite: no
    // external bridge/tunnel is started from the disposable acceptance profile.
    env.INFINITE_CANVAS_E2E = '1';
    env.INFINITE_CANVAS_E2E_BACKGROUND = '1';
    app = await electron.launch({ executablePath, args: [`--user-data-dir=${profile}`], env });
    const page = await app.firstWindow({ timeout: 20_000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 20_000 });
    const rendererSetting = await page.evaluate(({ key, filePath }) => {
      const raw = localStorage.getItem(key);
      let settings = {};
      try {
        const parsed = raw ? JSON.parse(raw) : {};
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) settings = parsed;
      } catch { /* a disposable profile has no user settings to preserve */ }
      localStorage.setItem(key, JSON.stringify({ ...settings, lastOpenedWorkspace: filePath }));
      return JSON.parse(localStorage.getItem(key) || '{}').lastOpenedWorkspace || null;
    }, { key: SETTINGS_KEY, filePath: fixture.fixture });
    if (rendererSetting !== fixture.fixture) throw new Error('Temporary renderer Local Storage did not retain the fixture path.');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.locator(`.react-flow__node[data-id="${fixture.nodeId}"]`).waitFor({ state: 'attached', timeout: 20_000 });
    result = Object.freeze({
      ok: true,
      fixture: fixture.fixture,
      fixtureSha256: fixture.sha256,
      nodeId: fixture.nodeId,
      profile: keepProfile ? profile : null,
      productionUserDataTouched: false,
    });
    return result;
  } finally {
    try { await app?.close(); } catch { /* cleanup still removes only the temp profile */ }
    if (!keepProfile) await fs.rm(profile, { recursive: true, force: true });
  }
}

async function selfTest() {
  await fs.mkdir(FIXTURE_ROOT, { recursive: true });
  const tempRoot = await fs.mkdtemp(path.join(FIXTURE_ROOT, '.launcher-self-test-'));
  const tempFixture = path.join(tempRoot, 'fixture.canvas');
  const nodeId = 'career-fixture-launcher-self-test';
  try {
    await fs.writeFile(tempFixture, `${JSON.stringify({ nodes: [{ id: nodeId }] })}\n`, { encoding: 'utf8', mode: 0o600 });
    const fixture = await fixtureInfo(tempFixture);
    assert.equal(fixture.nodeId, nodeId);
    assert.match(fixture.sha256, /^[a-f0-9]{64}$/);
    assert.equal(isBelow(FIXTURE_ROOT, tempFixture), true);
    assert.equal(isBelow(FIXTURE_ROOT, path.join(ROOT, 'package.json')), false);
    assert.equal(canonical(DEFAULT_APP), DEFAULT_APP);
    return { ok: true, fixture: null, nodeId: fixture.nodeId, productionUserDataTouched: false };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(usage());
    return;
  }
  if (command === 'self-test') {
    process.stdout.write(`${JSON.stringify(await selfTest(), null, 2)}\n`);
    return;
  }
  if (command !== 'launch') throw new Error(`Unknown command: ${command}`);
  if (!options.execute) throw new Error('Refusing launch without --execute.');
  process.stdout.write(`${JSON.stringify(await launchFixture(options), null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`Career fixture launcher: ${error?.message || error}\n`);
  process.exitCode = 1;
});
