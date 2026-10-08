#!/usr/bin/env node
/*
 * Deliberately small, disposable driver for a real Local-AI filesystem
 * application handoff.  It owns backup/pinning/queue inspection only; the
 * application still owns snapshot validation, result validation, rendering,
 * and bundle saving.
 *
 * Live mutations require BOTH --execute and the exact production --canvas
 * spelling.  `self-test` is the one exception: it creates an isolated temp
 * canvas and uses the same production exports through the Electron test stub.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';
import { JSDOM } from 'jsdom';
import { atomicWriteJson } from '../../electron/utils/pathSafety.js';
import { createAuthorityLedgerStore, openAuthorityLedgerStore } from '../../electron/ipc/applicationAuthorityLedgerStore.js';
import {
  buildCareerSourceCorpus,
  careerSnapshotStorageRoot,
  compileAuditedCareerSnapshot,
  readPinnedCareerSnapshot,
  validateCurrentCareerSnapshot,
  verbatimCareerTranscriptionAuditReceipt,
  writeCareerSnapshotAtomically,
} from '../../electron/ipc/careerSnapshot.js';
import {
  __projectLocalApplicationJobForAcceptanceHarness,
  __reserveNextLocalApplicationJobIdForAcceptanceHarness,
  discoverLocalApplicationJobs,
  localApplicationStatus,
  queueLocalApplicationJob,
} from '../../electron/ipc/localAiApplication.js';
import { formatOriginalJobListingMarkdown, sanitizeApplicationBundlePart } from '../../electron/ipc/applicationBundle.js';
import {
  __captureApplicationSyncWorkspaceIdentityForTests,
  __resetApplicationSyncWorkspacesForTests,
  registerApplicationSyncWorkspace,
} from '../../electron/ipc/applicationSync.js';
import {
  captureRegularFileSnapshot,
  sameFileIdentity,
  sameSnapshotBytes,
} from '../../scripts/acceptance/currentCareerSnapshotResolver.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CANVAS = '/Users/jack/Desktop/Job Search/canvas.json';
const DEFAULT_USER_DATA = '/Users/jack/Library/Application Support/infinite-canvas';
const CAREER_IMPORT_HUB_ID = 'd4471f24-fb63-4c24-bb04-d919f295b1c9';
const DEFAULT_CAREER_IMPORT_SOURCE = path.join(path.dirname(DEFAULT_CANVAS), 'Work Experience.md');
const DEFAULT_CAREER_IMPORT_FIXTURE = path.join(
  HERE,
  'fixtures',
  `career-import-${CAREER_IMPORT_HUB_ID}.canvas`,
);
const CAREER_IMPORT_DOCUMENT_ID = `${CAREER_IMPORT_HUB_ID}-career-source`;
const DEFAULT_CAREER_IMPORT_DOCUMENT_FIXTURE = path.join(
  HERE,
  'fixtures',
  `career-import-${CAREER_IMPORT_HUB_ID}-with-document.canvas`,
);
const CAREER_IMPORT_BOARD_ID = `${CAREER_IMPORT_HUB_ID}-board`;
const CAREER_IMPORT_BOARD_EDGE_ID = `${CAREER_IMPORT_HUB_ID}-to-board`;
const DEFAULT_CAREER_IMPORT_CONNECTED_FIXTURE = path.join(
  HERE,
  'fixtures',
  // Electron's command-line loader deliberately accepts only .json canvas
  // documents. Keep the disposable board fixture launchable without asking
  // the operator to rename it (which would defeat the no-overwrite guard).
  `career-import-${CAREER_IMPORT_HUB_ID}-with-document-and-board.canvas.json`,
);
const TARGETS = Object.freeze({
  snowflake: {
    id: 'board-1c3589c5-0bbd-4552-a031-8a0836776b33-1791309926380-job-0',
    company: 'Snowflake', title: 'Software Engineer– Cortex AI Frontend',
  },
  retool: {
    id: 'board-1c3589c5-0bbd-4552-a031-8a0836776b33-1791309926380-job-2',
    company: 'Retool', title: 'Software Engineer, AI Product Engineer',
  },
  anthropic: {
    id: 'board-1c3589c5-0bbd-4552-a031-8a0836776b33-1791309926380-job-9',
    company: 'Anthropic', title: 'Product Engineer, Computer Use',
  },
  affirm: {
    id: 'board-1c3589c5-0bbd-4552-a031-8a0836776b33-1791309926380-job-13',
    company: 'Affirm', title: 'Software Engineer II, Backend (Identity Decisioning)',
  },
});
const MUTATING_COMMANDS = new Set(['publish-snapshot', 'backup', 'pin-and-queue', 'repair-held-authority-receipt', 'restore']);
const APPLICATION_AUTHORITY_STORE_NAMESPACE = 'application-authority';
// APFS/HFS and Node may round an explicitly restored timestamp by a few
// microseconds.  A millisecond is intentionally the largest tolerated delta:
// content, paths, types, sizes, hashes, and permissions remain exact.
const MTIME_RESOLUTION_TOLERANCE_MS = 1;

function usage() {
  return `
Usage (run from the repository root):
  node --import ./scripts/test-stubs/register.mjs ${path.relative(process.cwd(), path.join(HERE, 'application-acceptance-harness.mjs'))} <command> [options]

Commands:
  career-import-fixture [--include-document] [--connected-board] [--source-canvas FILE] [--career-file FILE] [--output FILE]
  career-import-fixture-self-test
  publish-snapshot --run-id NAME --snapshot FILE --snapshot-id SHA256 --execute
  backup --run-id NAME --execute
  pin-and-queue --run-id NAME --card snowflake|retool|anthropic|affirm --snapshot-id SHA256 --execute
  repair-held-authority-receipt --run-id NAME --job-id UUID --execute
  inspect --run-id NAME --job-id UUID
  restore --run-id NAME [--keep-published-snapshot] --execute
  self-test

Shared options:
  --canvas ${DEFAULT_CANVAS}
  --user-data ${DEFAULT_USER_DATA}
  --run-root ${path.join(HERE, 'runs')}

Live safety: every mutating command requires --execute, --canvas must be the
exact production canvas path, and --user-data must be the exact production
Infinite Canvas user-data path.  The test-only --allow-nonproduction option is
accepted only by self-test helpers and is never needed for a live run.

Before a live restore, fully quit Infinite Canvas. Application Sync keeps its
capability registry in memory; a running app could otherwise later persist a
stale registry snapshot over this run-scoped rollback.

repair-held-authority-receipt is a one-time crash-boundary repair only. It
requires a run-owned queued review job, a matching selected-card pointer, and
a held authority-store journal whose already-published root is the journal's
next digest. It backs up the exact manifest bytes beneath that run and adds
only the compact manifest paste.authorityStore receipt. It intentionally does
not remove/finalize the journal: the fixed app does that after reopening the
matching manifest receipt.

Career-import fixture safety: this command reads the source canvas and career
file only. It writes a new, no-overwrite fixture below .test-artifacts/blackbox-run.
The default fixture never records the career-file path. --include-document adds
one locked document node pointing at that file for the in-canvas drag path; it
does not copy, move, rename, or write the source file. --connected-board adds
one empty Job Board and its single ordinary connection to the empty Search;
this is a disposable connected-workflow fixture, not a saved search result.
`;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (['execute', 'allow-nonproduction', 'include-document', 'connected-board', 'keep-published-snapshot'].includes(key)) options[key] = true;
    else {
      const value = rest[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
      options[key] = value;
    }
  }
  return { command, options };
}

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function canonical(value) { return path.resolve(String(value || '')).normalize('NFC'); }
function sameExistingPath(left, right) {
  if (canonical(left) === canonical(right)) return true;
  try { return fs.realpathSync(left) === fs.realpathSync(right); }
  catch { return false; }
}
function snapshotId(value) {
  const id = String(value || '').trim();
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('A lowercase 64-character --snapshot-id is required.');
  return id;
}
function runId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(id)) throw new Error('--run-id must contain only letters, digits, dot, underscore, or hyphen.');
  return id;
}
function required(options, name) {
  if (!options[name]) throw new Error(`--${name} is required.`);
  return options[name];
}
function assertRegularFile(file, label) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-link file.`);
  return stat;
}
function assertRegularDirectory(dir, label) {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-link directory.`);
  return stat;
}
function lstatIfPresent(target) {
  try { return fs.lstatSync(target); }
  catch (error) {
    // existsSync treats a dangling symlink as absent. That is not an absent
    // rollback target: it is an unsafe filesystem entry which must fail
    // closed instead of surviving a seemingly successful cleanup.
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}
function assertLiveTarget(options, { mutate = false, allowNonproduction = false } = {}) {
  const canvas = canonical(options.canvas || DEFAULT_CANVAS);
  const userData = canonical(options['user-data'] || DEFAULT_USER_DATA);
  if (mutate && !options.execute) throw new Error('Refusing mutation without --execute.');
  if (!allowNonproduction && (canvas !== DEFAULT_CANVAS || userData !== DEFAULT_USER_DATA)) {
    throw new Error('Refusing non-production target. Use the exact default --canvas and --user-data paths.');
  }
  assertRegularFile(canvas, 'Canvas');
  assertRegularDirectory(path.dirname(canvas), 'Canvas directory');
  if (mutate) assertRegularDirectory(userData, 'Electron user-data directory');
  return { canvas, userData, canvasRoot: fs.realpathSync(path.dirname(canvas)) };
}
function patchStubUserData(userData) {
  // The test stub intentionally exposes a mutable app object.  Queue and
  // snapshot exports therefore use precisely the real user-data root instead
  // of a private temporary root.
  app.getPath = name => name === 'userData' ? userData : path.join(userData, name);
}
function runDirectory(options, id = required(options, 'run-id')) {
  const root = canonical(options['run-root'] || path.join(HERE, 'runs'));
  if (path.dirname(root) !== canonical(HERE) && !root.startsWith(`${canonical(HERE)}${path.sep}`)) {
    throw new Error('--run-root must stay below .test-artifacts/blackbox-run.');
  }
  return path.join(root, runId(id));
}
function relativeTarget(root, target) {
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Unsafe snapshot target.');
  return rel;
}
function safeChild(root, relative, label = 'path') {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new Error(`Unsafe ${label}.`);
  const normalized = path.normalize(relative);
  if (normalized === '.' || normalized === '..' || normalized.startsWith(`..${path.sep}`)) throw new Error(`Unsafe ${label}.`);
  const target = path.resolve(root, normalized);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error(`Unsafe ${label}.`);
  return target;
}
function rootOrSafeChild(root, relative, label = 'path') {
  return relative ? safeChild(root, relative, label) : root;
}
function assertSafeAncestors(root, target, label) {
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error(`${label} escaped its canonical root.`);
  let current = root;
  assertRegularDirectory(current, `${label} root`);
  const relative = target === root ? '' : path.relative(root, target);
  const parts = relative ? relative.split(path.sep) : [];
  // Do not lstat the final component: callers may be intentionally creating it.
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    if (!lstatIfPresent(current)) break;
    assertRegularDirectory(current, `${label} parent`);
  }
}
function byteRecord(file) {
  const bytes = fs.readFileSync(file);
  const stat = fs.statSync(file);
  return { bytes: bytes.length, sha256: sha256(bytes), mode: stat.mode & 0o777, mtimeMs: stat.mtimeMs };
}
function treeManifest(root) {
  const rootStat = lstatIfPresent(root);
  if (!rootStat) return { present: false, entries: [] };
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`Snapshot root ${root} must be a regular non-link directory.`);
  const entries = [];
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      const rel = relativeTarget(root, full);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`Refusing to snapshot symbolic link: ${full}`);
      if (stat.isDirectory()) { entries.push({ path: rel, type: 'dir', mode: stat.mode & 0o777 }); walk(full); }
      else if (stat.isFile()) entries.push({ path: rel, type: 'file', ...byteRecord(full) });
      else throw new Error(`Unsupported filesystem entry in snapshot: ${full}`);
    }
  };
  walk(root);
  return { present: true, rootMode: rootStat.mode & 0o777, entries };
}
function pathState(target, label = target) {
  const stat = lstatIfPresent(target);
  if (!stat) return { present: false };
  if (stat.isSymbolicLink()) throw new Error(`${label} is a symbolic link.`);
  if (stat.isFile()) return { present: true, type: 'file', ...byteRecord(target) };
  if (stat.isDirectory()) return { present: true, type: 'dir', tree: treeManifest(target) };
  throw new Error(`${label} is not a regular file or directory.`);
}
function directoryState(target, label = target) {
  const stat = lstatIfPresent(target);
  if (!stat) return { present: false };
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-link directory.`);
  return { present: true, mode: stat.mode & 0o777 };
}
function assertDirectoryStateMatches(actual, expected, label) {
  if (Boolean(actual?.present) !== Boolean(expected?.present)) throw new Error(`${label} directory presence differs from its expected test-owned state.`);
  if (expected?.present && actual.mode !== expected.mode) throw new Error(`${label} directory mode differs from its expected test-owned state.`);
}
function stateDigest(state) { return sha256(JSON.stringify(state)); }
function manifestDigest(manifest) { return sha256(JSON.stringify(manifest)); }
function assertPathStateMatches(actual, expected, label) {
  if (Boolean(actual?.present) !== Boolean(expected?.present)) throw new Error(`${label} presence differs from its expected test-owned state.`);
  if (!expected?.present) return;
  if (actual.type !== expected.type) throw new Error(`${label} type differs from its expected test-owned state.`);
  if (expected.type === 'file') assertByteRecordMatches(actual, expected, label);
  else assertTreeManifestMatches(actual.tree, expected.tree, label);
}
function backupPathState(backupRoot, relative, label) {
  return pathState(safeChild(backupRoot, relative, label), `${label} backup`);
}
function manifestPathState(manifest, relative) {
  if (!manifest?.present) return { present: false };
  const normalized = path.normalize(relative);
  const entry = (manifest.entries || []).find(candidate => candidate.path === normalized);
  if (!entry) return { present: false };
  if (entry.type === 'file') return { present: true, type: 'file', bytes: entry.bytes, sha256: entry.sha256, mode: entry.mode, mtimeMs: entry.mtimeMs };
  const prefix = `${normalized}${path.sep}`;
  return {
    present: true,
    type: 'dir',
    tree: {
      present: true,
      rootMode: entry.mode,
      entries: (manifest.entries || []).filter(candidate => candidate.path.startsWith(prefix)).map(candidate => ({
        ...candidate, path: candidate.path.slice(prefix.length),
      })),
    },
  };
}
function manifestDirectoryState(manifest, relative = '') {
  if (!manifest?.present) return { present: false };
  if (!relative) return { present: true, mode: manifest.rootMode };
  const entry = (manifest.entries || []).find(candidate => candidate.path === path.normalize(relative));
  if (!entry) return { present: false };
  if (entry.type !== 'dir') throw new Error(`Baseline directory target is not a directory: ${relative}`);
  return { present: true, mode: entry.mode };
}
function ownershipPath(destination) { return path.join(destination, 'ownership.json'); }
function readOwnership(destination) {
  const file = ownershipPath(destination);
  assertRegularFile(file, 'Ownership manifest');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value?.version !== 1 || !value?.paths || typeof value.paths !== 'object') throw new Error('Ownership manifest is invalid. Refusing cleanup.');
  return value;
}
function writeOwnership(destination, ownership) {
  const file = ownershipPath(destination);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(ownership, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function syncRegistryPath(userData) { return path.join(userData, 'application-sync-workspaces.json'); }
// A current paste job also writes a host-owned, job-keyed authority anchor in
// Electron user-data.  Unlike the private job folder this intentionally
// survives the application's normal successful-save cleanup, so acceptance
// rollback must explicitly reserve and restore it.  Treating only .local-ai
// as run-owned would otherwise leave a real test job's durable anchor behind.
function authorityAnchorStorageRoot(userData) { return path.join(userData, 'local-ai-authority-anchors'); }
function readSyncRegistry(file, { allowMissing = true } = {}) {
  if (!lstatIfPresent(file)) {
    if (allowMissing) return { present: false, mode: 0o600, value: { version: 2, workspaces: [] } };
    throw new Error('Application Sync registry is missing.');
  }
  const snapshot = captureRegularFileSnapshot(file, 'Application Sync registry');
  if (snapshot.bytes > 2 * 1024 * 1024) throw new Error('Application Sync registry is too large.');
  const value = JSON.parse(snapshot.content.toString('utf8'));
  if (value?.version !== 2 || !Array.isArray(value.workspaces)) throw new Error('Application Sync registry is malformed.');
  for (const entry of value.workspaces) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || !/^[a-f0-9]{64}$/i.test(entry.token || '') || typeof entry.workspaceDir !== 'string' || !path.isAbsolute(entry.workspaceDir)
      || !entry.identity || typeof entry.identity !== 'object' || !path.isAbsolute(entry.identity.realWorkspaceDir || '')
      || !/^\d{1,32}$/.test(String(entry.identity.dev || '')) || !/^\d{1,32}$/.test(String(entry.identity.ino || ''))) {
      throw new Error('Application Sync registry contains an unsafe workspace entry.');
    }
  }
  return { present: true, mode: snapshot.mode, value, snapshot };
}
function assertSyncRegistrySnapshotUnchanged(file, before) {
  const after = readSyncRegistry(file, { allowMissing: true });
  if (Boolean(after.present) !== Boolean(before?.present)
    || (before?.present && (!sameFileIdentity(after.snapshot.identity, before.snapshot.identity)
      || !sameSnapshotBytes(after.snapshot, before.snapshot)))) {
    throw new Error('Application Sync registry changed after rollback validation. Refusing to overwrite it.');
  }
  return after;
}
function syncWorkspaceEntries(registry, workspace) {
  return registry.value.workspaces.filter(entry => canonical(entry.workspaceDir) === canonical(workspace));
}
function writeSyncRegistry(file, registry, baseline) {
  if (!registry.value.workspaces.length && !baseline.present) { fs.unlinkSync(file); return; }
  const parent = path.dirname(file); assertRegularDirectory(parent, 'Application Sync registry parent');
  const temp = path.join(parent, `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, `${JSON.stringify(registry.value, null, 2)}\n`, { mode: baseline.mode || 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}
function syncRegistryValuesEqual(left, right) {
  // The order is part of Application Sync's persisted state.  Do not sort or
  // otherwise normalize it: doing so could turn an unrelated concurrent
  // registry change into an apparently baseline-equivalent rollback.
  return JSON.stringify(left?.value) === JSON.stringify(right?.value);
}
function reserveSyncWorkspaceCandidates({ destination, ownership, baseline, userData, leaves, appliedJobs, useLiveRegistryBaseline = false }) {
  // No-secret acceptance runs retain only the baseline registry digest in the
  // artifact. They may inspect the live registry in memory to prove none of
  // their pre-reserved isolated candidates already has a capability; no token
  // bytes are persisted outside Electron user-data.
  const backup = readSyncRegistry(useLiveRegistryBaseline ? syncRegistryPath(userData) : path.join(destination, 'application-sync-workspaces.json'));
  if (backup.present !== Boolean(baseline.applicationSync?.present)) throw new Error('Application Sync backup disagrees with baseline.');
  ownership.syncWorkspaces ||= {};
  for (const relative of leaves) {
    const workspace = safeChild(appliedJobs, relative, 'Reserved Application Sync workspace');
    if (ownership.syncWorkspaces[relative]) throw new Error('Application Sync workspace is already reserved.');
    const entries = syncWorkspaceEntries(backup, workspace);
    if (entries.length > 1) throw new Error('Application Sync baseline has duplicate candidate workspace entries.');
    ownership.syncWorkspaces[relative] = { workspace, before: entries[0] || null, after: null };
  }
  writeOwnership(destination, ownership);
}
function claimSyncWorkspaceOwnership({ destination, ownership, userData, outputDir }) {
  const match = Object.entries(ownership.syncWorkspaces || {}).find(([, entry]) => canonical(entry.workspace) === canonical(outputDir));
  if (!match) throw new Error('Saved Application Sync workspace was not pre-reserved.');
  const [key, reservation] = match;
  const registry = readSyncRegistry(syncRegistryPath(userData), { allowMissing: false });
  const html = fs.readFileSync(path.join(outputDir, 'Application.html'), 'utf8');
  const dom = new JSDOM(html); let sync;
  try { sync = JSON.parse(dom.window.document.querySelector('#ic-application-bundle-data[type="application/json"]')?.textContent || '{}').sync; }
  finally { dom.window.close(); }
  const token = typeof sync?.token === 'string' ? sync.token : '';
  const entries = syncWorkspaceEntries(registry, outputDir);
  const stat = fs.statSync(outputDir); const real = fs.realpathSync(outputDir);
  if (entries.length !== 1 || !/^http:\/\/127\.0\.0\.1:43192\/application-sync$/.test(String(sync?.endpoint || '')) || sync?.version !== 2 || !/^[a-f0-9]{64}$/i.test(token) || entries[0].token !== token
    || canonical(entries[0].identity.realWorkspaceDir) !== canonical(real)
    || entries[0].identity.dev !== String(stat.dev) || entries[0].identity.ino !== String(stat.ino)) {
    throw new Error('Application Sync registry entry does not match the saved candidate capability and workspace identity.');
  }
  reservation.after = entries[0]; writeOwnership(destination, ownership); return key;
}
function packagedProductionAppCommandIsRunning(commands) {
  return String(commands).split('\n').some(line => /release\/mac-arm64\/infinite-canvas\.app\/Contents\/MacOS\/infinite-canvas(?:\s|$)/.test(line));
}
function assertProductionAppStopped(allowNonproduction) {
  if (allowNonproduction || process.platform !== 'darwin') return;
  const commands = execFileSync('/bin/ps', ['-ax', '-o', 'command='], { encoding: 'utf8' });
  if (packagedProductionAppCommandIsRunning(commands)) {
    throw new Error('Quit the packaged Infinite Canvas app before restore; its in-memory Sync registry could overwrite this rollback.');
  }
}
function ownedKey(area, relative) { return `${area}:${relative}`; }
function expectedOwnedState(ownership, key, fallback) { return ownership.paths[key]?.after || fallback; }
function reserveOwnedPath({ destination, ownership, area, relative, root, before, source = null }) {
  const key = ownedKey(area, relative);
  if (ownership.paths[key]) throw new Error(`Ownership already reserved for ${key}.`);
  assertPathStateMatches(pathState(safeChild(root, relative, key), key), before, `${key} before mutation`);
  ownership.paths[key] = { area, relative, before, after: before, beforeDigest: stateDigest(before), afterDigest: stateDigest(before), source };
  writeOwnership(destination, ownership);
  return ownership.paths[key];
}
function recordOwnedPath({ destination, ownership, area, relative, root, backupRoot, before, after, source = null }) {
  const key = ownedKey(area, relative);
  const prior = ownership.paths[key];
  assertPathStateMatches(pathState(safeChild(root, relative, key), key), after, `${key} after mutation`);
  ownership.paths[key] = {
    area, relative, before: prior?.before || before, after,
    beforeDigest: stateDigest(prior?.before || before), afterDigest: stateDigest(after), source,
  };
  writeOwnership(destination, ownership);
  return ownership.paths[key];
}
function updateOwnedPath({ destination, ownership, area, relative, root, source = null }) {
  const key = ownedKey(area, relative);
  const prior = ownership.paths[key];
  if (!prior) throw new Error(`No pre-mutation ownership record exists for ${key}.`);
  const current = pathState(safeChild(root, relative, key), key);
  ownership.paths[key] = { ...prior, after: current, afterDigest: stateDigest(current), source: source || prior.source };
  writeOwnership(destination, ownership);
  return ownership.paths[key];
}
function localAiJobSidecars(jobId) {
  return [
    { kind: 'phase-stamp', relative: path.join('phase-stamps', `${jobId}.json`), parent: 'phase-stamps', maxBytes: 4_000 },
    { kind: 'handoff-receipt', relative: path.join('handoff-receipts', `${jobId}.json`), parent: 'handoff-receipts', maxBytes: 64_000 },
  ];
}
function assertLocalAiJobSidecar(target, sidecar, canvas) {
  const stat = assertRegularFile(target, `Run-owned Local-AI ${sidecar.kind}`);
  if (stat.size > sidecar.maxBytes) throw new Error(`Run-owned Local-AI ${sidecar.kind} exceeds its bounded envelope.`);
  const value = JSON.parse(fs.readFileSync(target, 'utf8'));
  if (value?.jobId !== sidecar.jobId || !sameExistingPath(value?.canvasFilePath, canvas)) {
    throw new Error(`Run-owned Local-AI ${sidecar.kind} no longer matches its reserved job/canvas identity.`);
  }
}
function reserveLocalAiJobSidecars({ destination, ownership, baseline, localAiRoot, jobId }) {
  for (const sidecar of localAiJobSidecars(jobId)) {
    const before = manifestPathState(baseline.localAi, sidecar.relative);
    const entry = reserveOwnedPath({
      destination, ownership, area: 'local-ai', relative: sidecar.relative, root: localAiRoot, before,
    });
    entry.localAiSidecar = { ...sidecar, jobId };
    entry.ancestors = [{
      relative: sidecar.parent,
      before: manifestDirectoryState(baseline.localAi, sidecar.parent),
      after: directoryState(path.join(localAiRoot, sidecar.parent), `Local-AI ${sidecar.kind} parent`),
    }];
    writeOwnership(destination, ownership);
  }
}
function updateLocalAiJobSidecarOwnership({ destination, ownership, localAiRoot, canvas, jobId = null }) {
  for (const entry of Object.values(ownership.paths)) {
    const sidecar = entry?.area === 'local-ai' ? entry.localAiSidecar : null;
    if (!sidecar || (jobId && sidecar.jobId !== jobId)) continue;
    const target = safeChild(localAiRoot, entry.relative, `Run-owned Local-AI ${sidecar.kind}`);
    const current = pathState(target, `Run-owned Local-AI ${sidecar.kind}`);
    if (current.present) {
      if (current.type !== 'file') throw new Error(`Run-owned Local-AI ${sidecar.kind} is not a regular file.`);
      assertLocalAiJobSidecar(target, sidecar, canvas);
    }
    const updated = updateOwnedPath({ destination, ownership, area: 'local-ai', relative: entry.relative, root: localAiRoot });
    updated.ancestors = (updated.ancestors || []).map(ancestor => ({
      ...ancestor,
      after: directoryState(path.join(localAiRoot, ancestor.relative), `Local-AI ${sidecar.kind} parent`),
    }));
    writeOwnership(destination, ownership);
  }
}
function assertAuthorityAnchorFile(target, jobId) {
  const stat = assertRegularFile(target, 'Run-owned authority anchor');
  if (stat.size > 8_000) throw new Error('Run-owned authority anchor exceeds its bounded envelope.');
  const value = JSON.parse(fs.readFileSync(target, 'utf8'));
  if (value?.jobId !== jobId) throw new Error('Run-owned authority anchor no longer matches its reserved job identity.');
}
function reserveAuthorityAnchorFiles({ destination, ownership, baseline, userData, jobId, skipExistingIntegrityKey = false }) {
  const root = authorityAnchorStorageRoot(userData);
  const rootBefore = manifestDirectoryState(baseline.authorityAnchors);
  // The key is created lazily with the first anchor. It is not job-keyed, but
  // it is a deterministic side effect of this run and must be restored before
  // an absent pre-run root can be removed. The anchor itself remains tightly
  // bound to this pre-reserved UUID.
  const keyBefore = manifestPathState(baseline.authorityAnchors, '.integrity-key');
  // A real user-data root can already have the HMAC key used by other jobs.
  // It is read, not changed, while writing a new job anchor. A caller that
  // cannot retain a private copy may opt into this narrow mode only when that
  // key already exists; it remains outside this run's ownership and the
  // baseline whole-tree digest still detects any concurrent mutation.
  if (skipExistingIntegrityKey && !keyBefore.present) {
    throw new Error('Refusing no-secret anchor mode without an existing authority integrity key.');
  }
  const records = skipExistingIntegrityKey ? [[`${jobId}.json`, 'anchor']] : [['.integrity-key', 'key'], [`${jobId}.json`, 'anchor']];
  for (const [relative, kind] of records) {
    const before = manifestPathState(baseline.authorityAnchors, relative);
    const entry = reserveOwnedPath({
      destination, ownership, area: 'authority-anchor', relative, root, before,
    });
    entry.authorityAnchor = { kind, jobId };
    entry.ancestors = [{ relative: '', before: rootBefore, after: directoryState(root, 'Authority anchor root') }];
    writeOwnership(destination, ownership);
  }
}
function updateAuthorityAnchorOwnership({ destination, ownership, userData, jobId = null }) {
  const root = authorityAnchorStorageRoot(userData);
  for (const entry of Object.values(ownership.paths)) {
    const anchor = entry?.area === 'authority-anchor' ? entry.authorityAnchor : null;
    if (!anchor || (jobId && anchor.jobId !== jobId)) continue;
    const target = safeChild(root, entry.relative, `Run-owned authority ${anchor.kind}`);
    const current = pathState(target, `Run-owned authority ${anchor.kind}`);
    if (anchor.kind === 'anchor' && current.present) {
      if (current.type !== 'file') throw new Error('Run-owned authority anchor is not a regular file.');
      assertAuthorityAnchorFile(target, anchor.jobId);
    }
    const updated = updateOwnedPath({ destination, ownership, area: 'authority-anchor', relative: entry.relative, root });
    updated.ancestors = (updated.ancestors || []).map(ancestor => ({
      ...ancestor, after: directoryState(root, 'Authority anchor root'),
    }));
    writeOwnership(destination, ownership);
  }
}
function regularJson(file, label) {
  assertRegularFile(file, label);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function reservedJobIdentityMatches(target, reservation) {
  if (!reservation || !fs.existsSync(target)) return false;
  try {
    assertRegularDirectory(target, 'Reserved Local-AI job');
    const manifest = regularJson(path.join(target, 'manifest.json'), 'Reserved Local-AI manifest');
    const input = regularJson(path.join(target, 'input.json'), 'Reserved Local-AI input');
    return manifest?.id === reservation.jobId && input?.jobId === reservation.jobId
      && sameExistingPath(manifest?.canvasFilePath, reservation.canvas)
      && sameExistingPath(input?.canvasFilePath, reservation.canvas);
  } catch { return false; }
}
function reservedBundleIdentityMatches(target, reservation, before) {
  if (!reservation || !fs.existsSync(target)) return false;
  try {
    assertRegularDirectory(target, 'Reserved application bundle');
    const entries = fs.readdirSync(target);
    if (!before?.present && entries.length === 0) return true;
    const listing = path.join(target, 'Original Job Listing.md');
    return assertRegularFile(listing, 'Reserved application listing')
      && byteRecord(listing).sha256 === reservation.listingSha256;
  } catch { return false; }
}
function copyTree(source, destination) {
  if (!fs.existsSync(source)) return false;
  assertRegularDirectory(source, `Source tree ${source}`);
  fs.cpSync(source, destination, { recursive: true, dereference: false, preserveTimestamps: true, errorOnExist: true });
  return true;
}
function atomicReplaceBytes(source, destination, mode, mtimeMs = null) {
  const parent = path.dirname(destination);
  assertRegularDirectory(parent, 'Restore destination directory');
  const temp = path.join(parent, `.${path.basename(destination)}.blackbox-restore-${crypto.randomUUID()}.tmp`);
  try {
    fs.copyFileSync(source, temp, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, destination);
    if (Number.isFinite(mtimeMs)) fs.utimesSync(destination, mtimeMs / 1_000, mtimeMs / 1_000);
  } finally { fs.rmSync(temp, { force: true }); }
}
function assertSafeTree(root, label) {
  const rootStat = lstatIfPresent(root);
  if (!rootStat) return;
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`${label} must be a regular non-link directory.`);
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`${label} contains a symbolic link: ${full}`);
      if (stat.isDirectory()) walk(full);
      else if (!stat.isFile()) throw new Error(`${label} contains an unsupported entry: ${full}`);
    }
  };
  walk(root);
}
function removeSafeTree(root, label) {
  if (!lstatIfPresent(root)) return;
  assertSafeTree(root, label);
  fs.rmSync(root, { recursive: true, force: false });
}
function reconcileTreeFromBackup(backup, destination, manifest, expectedRoot, label) {
  if (!destination.startsWith(`${expectedRoot}${path.sep}`)) throw new Error('Restore tree escaped canvas root.');
  if (!manifest?.present) { removeSafeTree(destination, label); return; }
  assertRegularDirectory(backup, `${label} backup`);
  assertSafeTree(backup, `${label} backup`);
  if (fs.existsSync(destination)) assertSafeTree(destination, label);
  else fs.mkdirSync(destination, { recursive: false, mode: manifest.rootMode ?? 0o700 });

  const expected = new Map((manifest.entries || []).map(entry => [entry.path, entry]));
  const actual = treeManifest(destination);
  for (const entry of actual.entries.sort((a, b) => b.path.length - a.path.length || b.path.localeCompare(a.path))) {
    const wanted = expected.get(entry.path);
    const target = path.join(destination, entry.path);
    if (wanted && wanted.type !== entry.type) throw new Error(`${label} type mismatch at ${entry.path}; refusing replacement.`);
    if (!wanted) {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) throw new Error(`${label} extra symbolic link: ${entry.path}`);
      if (stat.isDirectory()) fs.rmdirSync(target);
      else if (stat.isFile()) fs.unlinkSync(target);
      else throw new Error(`${label} unsupported extra entry: ${entry.path}`);
    }
  }
  for (const entry of (manifest.entries || []).filter(entry => entry.type === 'dir')) {
    const target = path.join(destination, entry.path);
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: false, mode: entry.mode });
    else assertRegularDirectory(target, `${label} directory ${entry.path}`);
  }
  for (const entry of (manifest.entries || []).filter(entry => entry.type === 'file')) {
    const source = path.join(backup, entry.path);
    const target = path.join(destination, entry.path);
    assertRegularFile(source, `${label} backup file ${entry.path}`);
    if (fs.existsSync(target)) assertRegularFile(target, `${label} file ${entry.path}`);
    fs.copyFileSync(source, target);
    fs.chmodSync(target, entry.mode);
    if (Number.isFinite(entry.mtimeMs)) fs.utimesSync(target, entry.mtimeMs / 1_000, entry.mtimeMs / 1_000);
  }
}
function restoreTreeMetadata(destination, manifest) {
  if (!manifest?.present) return;
  assertRegularDirectory(destination, 'Restored tree root');
  // cpSync on macOS may apply the process umask to directories.  Reapply the
  // backup manifest after copying, including files, so a rollback restores the
  // recorded permissions instead of merely equivalent bytes.
  for (const entry of manifest.entries || []) {
    const target = path.join(destination, entry.path);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || (entry.type === 'dir' ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error(`Restored tree entry changed type: ${entry.path}`);
    }
    fs.chmodSync(target, entry.mode);
    if (entry.type === 'file' && Number.isFinite(entry.mtimeMs)) {
      fs.utimesSync(target, entry.mtimeMs / 1_000, entry.mtimeMs / 1_000);
    }
  }
  // Baselines created before rootMode was recorded remain compatible; their
  // nested entries are still restored and verified strictly.
  if (Number.isInteger(manifest.rootMode)) fs.chmodSync(destination, manifest.rootMode);
}
function mtimeWithinFilesystemResolution(actual, expected) {
  return Number.isFinite(actual) && Number.isFinite(expected)
    && Math.abs(actual - expected) <= MTIME_RESOLUTION_TOLERANCE_MS;
}
function assertByteRecordMatches(actual, expected, label) {
  for (const key of ['bytes', 'sha256', 'mode']) {
    if (actual?.[key] !== expected?.[key]) throw new Error(`${label} ${key} differs from baseline.`);
  }
  if (!mtimeWithinFilesystemResolution(actual.mtimeMs, expected.mtimeMs)) {
    throw new Error(`${label} mtime differs from baseline beyond ${MTIME_RESOLUTION_TOLERANCE_MS}ms.`);
  }
}
function assertTreeManifestMatches(actual, expected, label) {
  if (Boolean(actual?.present) !== Boolean(expected?.present)) throw new Error(`${label} presence differs from baseline.`);
  if (!expected?.present) return;
  if (Number.isInteger(expected.rootMode) && actual.rootMode !== expected.rootMode) {
    throw new Error(`${label} root mode differs from baseline.`);
  }
  if (!Array.isArray(actual.entries) || !Array.isArray(expected.entries) || actual.entries.length !== expected.entries.length) {
    throw new Error(`${label} entry count differs from baseline.`);
  }
  for (let index = 0; index < expected.entries.length; index += 1) {
    const found = actual.entries[index];
    const wanted = expected.entries[index];
    if (found?.path !== wanted?.path || found?.type !== wanted?.type) {
      throw new Error(`${label} entry ${index} path or type differs from baseline.`);
    }
    if (wanted.type === 'dir') {
      if (found.mode !== wanted.mode) throw new Error(`${label} directory mode differs: ${wanted.path}`);
    } else {
      assertByteRecordMatches(found, wanted, `${label} file ${wanted.path}`);
    }
  }
}
function assertOptionalFileMatches(actual, expected, label) {
  if (Boolean(actual?.present) !== Boolean(expected?.present)) throw new Error(`${label} presence differs from baseline.`);
  if (expected?.present) assertByteRecordMatches(actual, expected, label);
}
function walkNodes(nodes, visitor) {
  for (const node of nodes || []) {
    visitor(node);
    if (Array.isArray(node?.data?.canvasData?.nodes)) walkNodes(node.data.canvasData.nodes, visitor);
  }
}
function findTargetNode(data, card) {
  let found = null;
  walkNodes(data?.nodes, node => {
    if (node?.id !== card.id) return;
    if (found) throw new Error(`Duplicate target card ID ${card.id}.`);
    if (node.type !== 'jobcard' || node?.data?.company !== card.company || node?.data?.title !== card.title) {
      throw new Error(`Target ${card.id} no longer matches expected ${card.company} / ${card.title}.`);
    }
    found = node;
  });
  if (!found) throw new Error(`Target card ${card.id} is absent.`);
  return found;
}

// Canvas bytes are a useful final CAS fence, but Local-AI legitimately advances
// the selected card's private pointer while a handoff is running (stage,
// revision, receipt state, etc.).  Treat that one pointer as owned state only
// after proving that every other parsed canvas value is still identical to the
// baseline.  This is deliberately semantic rather than byte-for-byte: the
// production atomic JSON writer may reserialize an otherwise unchanged canvas.
function jsonValuesEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftArray = Array.isArray(left); const rightArray = Array.isArray(right);
  if (leftArray !== rightArray) return false;
  if (leftArray) {
    if (left.length !== right.length) return false;
    return left.every((value, index) => jsonValuesEqual(value, right[index]));
  }
  const leftKeys = Object.keys(left); const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(key => Object.hasOwn(right, key) && jsonValuesEqual(left[key], right[key]));
}

function replaceOptionalOwnValue(target, key, source) {
  if (Object.hasOwn(source, key)) target[key] = jsonClone(source[key]);
  else delete target[key];
}

function isBenignReactFlowMeasurement(value) {
  // React Flow persists this renderer-derived cache alongside a node.  Keep
  // this deliberately narrower than a generic "layout" exception: a caller
  // may change only a finite width/height pair, never position, style, or an
  // arbitrary object hidden inside `measured`.
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('width') || !keys.includes('height')) return false;
  return ['width', 'height'].every(key => Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 100_000);
}

function normalizeOwnedCanvasPresentationState(projectedCard, currentCard, baselineCard) {
  // Selection and measured bounds are renderer/UI caches, not job-card
  // content. The packaged app can persist them when it opens the isolated
  // canvas or when the Local-AI completion banner changes the card's rendered
  // height. They are allowed only on the exact reserved card and are projected
  // back to the trusted baseline before the ordinary whole-canvas comparison.
  if (Object.hasOwn(currentCard, 'selected') && typeof currentCard.selected !== 'boolean') {
    throw new Error('Selected card has an invalid presentation selection state.');
  }
  if (Object.hasOwn(currentCard, 'measured') && !isBenignReactFlowMeasurement(currentCard.measured)) {
    throw new Error('Selected card has an invalid presentation measurement state.');
  }
  replaceOptionalOwnValue(projectedCard, 'selected', baselineCard);
  replaceOptionalOwnValue(projectedCard, 'measured', baselineCard);
}

function assertOwnedCanvasPointerProgress({ baselineData, currentData, reservation, canvas }) {
  const card = reservation?.card;
  if (!card || typeof reservation?.snapshotId !== 'string' || typeof reservation?.jobId !== 'string') {
    throw new Error('Canvas ownership has no trusted selected-card reservation.');
  }
  const baselineCard = findTargetNode(baselineData, card);
  const currentCard = findTargetNode(currentData, card);
  if (currentCard?.data?.careerSnapshotId !== reservation.snapshotId) {
    throw new Error('Selected card no longer carries this run\'s reserved career snapshot.');
  }
  const pointer = currentCard?.data?.localApplication;
  const expectedFolder = path.join(path.dirname(canvas), '.local-ai', 'jobs', reservation.jobId);
  const pointerFolder = typeof pointer?.folder === 'string' ? pointer.folder : null;
  if (!pointer || typeof pointer !== 'object' || Array.isArray(pointer)
    || pointer.id !== reservation.jobId || !sameExistingPath(pointer.canvasFilePath, canvas)
    || !sameExistingPath(pointerFolder, expectedFolder)) {
    throw new Error(`Selected card no longer carries this run's reserved Local-AI pointer (id=${pointer?.id === reservation.jobId}, canvas=${sameExistingPath(pointer?.canvasFilePath, canvas)}, folder=${sameExistingPath(pointerFolder, expectedFolder)}).`);
  }
  // Restore the target card's two owned fields plus its strictly validated
  // React-Flow presentation cache in a clone and require exact structural
  // equality everywhere else. This rejects another card edit, a board/layout
  // mutation, or a mutation to any non-pointer target-card field.
  const projected = jsonClone(currentData);
  const projectedCard = findTargetNode(projected, card);
  replaceOptionalOwnValue(projectedCard.data, 'careerSnapshotId', baselineCard.data || {});
  replaceOptionalOwnValue(projectedCard.data, 'localApplication', baselineCard.data || {});
  normalizeOwnedCanvasPresentationState(projectedCard, currentCard, baselineCard);
  if (!jsonValuesEqual(projected, baselineData)) {
    throw new Error('Canvas changed outside this run\'s reserved card pointer; refusing rollback.');
  }
}

function queuePointerReservationFromReceipt(destination, ownership, jobId = null) {
  const canvasEntry = ownership.paths[ownedKey('canvas', 'canvas.json')];
  if (!canvasEntry?.after || !fs.existsSync(destination)) return null;
  const matches = [];
  for (const name of fs.readdirSync(destination).filter(value => /^queue-[A-Za-z0-9._-]+\.json$/.test(value))) {
    try {
      const receipt = regularJson(safeChild(destination, name, 'Queue receipt'), 'Queue receipt');
      if ((!jobId && typeof receipt?.localJob?.id !== 'string') || (jobId && receipt?.localJob?.id !== jobId)
        || !receipt?.card || receipt?.canvasAfter == null) continue;
      const card = selectedCard(receipt.card.name);
      if (receipt.card.id !== card.id || receipt.card.company !== card.company || receipt.card.title !== card.title) continue;
      const id = snapshotId(receipt.snapshotId);
      assertByteRecordMatches(receipt.canvasAfter, canvasEntry.after, 'Queue receipt canvas state');
      matches.push({ card, snapshotId: id, jobId: receipt.localJob.id });
    } catch { /* an unrelated or stale receipt never grants ownership */ }
  }
  // A legacy run can be adopted only if exactly one receipt proves the
  // original post-queue canvas state. Ambiguity is never an ownership grant.
  return matches.length === 1 ? matches[0] : null;
}

function reattestRunCreatedLocalAiJobTree({ canvas, canvasRoot, destination, ownership }) {
  const canvasEntry = ownership.paths[ownedKey('canvas', 'canvas.json')];
  if (!canvasEntry) return false;
  // The queued canvas pointer is the authority for the one job this run may
  // refresh. Prefer its durable reservation, then recover an older run's
  // pointer only from the exact queue receipt already bound to this canvas.
  const reservation = canvasEntry.applicationPointer || queuePointerReservationFromReceipt(destination, ownership);
  if (!reservation || typeof reservation.jobId !== 'string' || !/^[a-f0-9-]{36}$/i.test(reservation.jobId)) return false;
  const relative = path.join('jobs', reservation.jobId);
  const entry = ownership.paths[ownedKey('local-ai', relative)];
  // A pre-existing job path, a different Local-AI entry, or an unfinished
  // reservation never receives a broadened restore privilege.
  if (!entry || entry.area !== 'local-ai' || entry.relative !== relative || entry.before?.present !== false || entry.pendingJob) return false;
  const localAiRoot = path.join(canvasRoot, '.local-ai');
  const target = safeChild(localAiRoot, relative, 'Run-created Local-AI job');
  // Inspect may already have observed the application's terminal cleanup and
  // recorded this owned path as absent. There is then nothing to refresh;
  // ordinary preflight remains the authority for that exact absent state.
  if (!fs.existsSync(target)) return false;
  assertSafeAncestors(canvasRoot, target, 'Run-created Local-AI job');
  assertRegularDirectory(target, 'Run-created Local-AI job');
  assertSafeTree(target, 'Run-created Local-AI job');
  if (!reservedJobIdentityMatches(target, { jobId: reservation.jobId, canvas })) {
    throw new Error('Run-created Local-AI job no longer matches its reserved job/canvas identity.');
  }
  updateOwnedPath({ destination, ownership, area: 'local-ai', relative, root: localAiRoot });
  return true;
}

function reattestRunOwnedLocalAiSidecars({ canvas, canvasRoot, destination, ownership }) {
  const canvasEntry = ownership.paths[ownedKey('canvas', 'canvas.json')];
  const reservation = canvasEntry?.applicationPointer || queuePointerReservationFromReceipt(destination, ownership);
  if (!reservation?.jobId) return false;
  const localAiRoot = path.join(canvasRoot, '.local-ai');
  updateLocalAiJobSidecarOwnership({ destination, ownership, localAiRoot, canvas, jobId: reservation.jobId });
  return true;
}

function attestOwnedCanvasPointerProgress({ canvas, destination, ownership, jobId = null }) {
  const entry = ownership.paths[ownedKey('canvas', 'canvas.json')];
  if (!entry) return false;
  const reservation = entry.applicationPointer || queuePointerReservationFromReceipt(destination, ownership, jobId);
  if (!reservation) return false;
  if (jobId && reservation.jobId !== jobId) return false;
  const baselineData = loadCanvas(path.join(destination, 'canvas.json'));
  const currentData = loadCanvas(canvas);
  assertOwnedCanvasPointerProgress({ baselineData, currentData, reservation, canvas });
  // Legacy runs written before applicationPointer was added can safely adopt
  // the reservation only when their queue receipt is tied to the existing
  // owned post-queue canvas digest (checked above).
  entry.applicationPointer = reservation;
  updateOwnedPath({ destination, ownership, area: 'canvas', relative: 'canvas.json', root: path.dirname(canvas) });
  return true;
}

function heldAuthorityReceiptJobId(value) {
  const id = String(value || '').trim();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) {
    throw new Error('--job-id must be a UUID.');
  }
  return id;
}

function assertCompactAuthorityStoreReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || Object.keys(receipt).sort().join(',') !== 'digest,revision,streams,version'
    || !Number.isSafeInteger(receipt.version) || !Number.isSafeInteger(receipt.revision)
    || receipt.revision < 0 || !/^[a-f0-9]{64}$/i.test(receipt.digest || '')
    || !receipt.streams || typeof receipt.streams !== 'object' || Array.isArray(receipt.streams)) {
    throw new Error('Authority store did not produce a compact public receipt.');
  }
  for (const [stream, value] of Object.entries(receipt.streams)) {
    if (!/^[a-z][a-z0-9-]{0,39}$/u.test(stream)
      || !value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'count,digest,head'
      || !Number.isSafeInteger(value.count) || value.count < 1
      || typeof value.head !== 'string' || !value.head
      || !/^[a-f0-9]{64}$/i.test(value.digest || '')) {
      throw new Error('Authority store receipt contains an invalid public stream summary.');
    }
  }
  return receipt;
}

function assertHeldAuthorityRepairJob({ canvas, destination, ownership, jobId: requestedJobId }) {
  const jobId = heldAuthorityReceiptJobId(requestedJobId);
  const canvasRoot = fs.realpathSync(path.dirname(canvas));
  const localAiRoot = path.join(canvasRoot, '.local-ai');
  assertRegularDirectory(localAiRoot, 'Local-AI root');
  const jobRelative = path.join('jobs', jobId);
  const jobFolder = safeChild(localAiRoot, jobRelative, 'Run-owned Local-AI job');
  assertSafeAncestors(canvasRoot, jobFolder, 'Run-owned Local-AI job');
  assertRegularDirectory(jobFolder, 'Run-owned Local-AI job');
  const entry = ownership.paths[ownedKey('local-ai', jobRelative)];
  if (!entry || entry.area !== 'local-ai' || entry.relative !== jobRelative || !entry.after?.present || entry.after.type !== 'dir' || entry.pendingJob) {
    throw new Error('Job is not a completed run-owned Local-AI reservation.');
  }
  const manifestPath = path.join(jobFolder, 'manifest.json');
  const inputPath = path.join(jobFolder, 'input.json');
  assertRegularFile(manifestPath, 'Run-owned job manifest');
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const input = regularJson(inputPath, 'Run-owned job input');
  const hasExactCanvas = value => typeof value === 'string' && canonical(value) === canonical(canvas);
  const hasExactCanvasRoot = value => typeof value === 'string' && canonical(value) === canvasRoot;
  if (manifest?.id !== jobId || input?.jobId !== jobId
    || !hasExactCanvas(manifest?.canvasFilePath) || !hasExactCanvas(input?.canvasFilePath)
    || !hasExactCanvasRoot(manifest?.canvasRoot) || !hasExactCanvasRoot(input?.canvasRoot)) {
    throw new Error('Job, input, manifest, and canvas identities do not exactly agree.');
  }
  if (manifest.status !== 'queued' || !manifest.paste || typeof manifest.paste !== 'object' || Array.isArray(manifest.paste)
    || manifest.paste.stage !== 'review' || Object.hasOwn(manifest.paste, 'authorityStore')) {
    throw new Error('Job is not an un-published queued review manifest.');
  }
  const canvasEntry = ownership.paths[ownedKey('canvas', 'canvas.json')];
  if (!canvasEntry?.applicationPointer || canvasEntry.applicationPointer.jobId !== jobId) {
    throw new Error('Run ownership does not reserve this job on the selected canvas card.');
  }
  // This compares the live canvas with the run baseline while allowing only
  // the exact selected-card pointer this run reserved; it also refreshes the
  // canvas ownership CAS state before the manifest-only repair.
  if (!attestOwnedCanvasPointerProgress({ canvas, destination, ownership, jobId })) {
    throw new Error('Selected canvas pointer is not owned by this run.');
  }
  return { jobId, canvasRoot, localAiRoot, jobRelative, jobFolder, manifestPath, manifestBytes, manifest, input };
}

export async function repairHeldAuthorityReceipt({ canvas, userData, destination, jobId: requestedJobId, execute = false, allowNonproduction = false }) {
  if (!execute) throw new Error('Refusing held authority receipt repair without --execute.');
  if (!allowNonproduction && (canonical(canvas) !== DEFAULT_CANVAS || canonical(userData) !== DEFAULT_USER_DATA)) {
    throw new Error('Refusing a non-production held authority receipt repair target.');
  }
  assertProductionAppStopped(allowNonproduction);
  assertRegularDirectory(destination, 'Run directory');
  const baseline = regularJson(path.join(destination, 'baseline.json'), 'Run baseline');
  if (baseline?.canvas?.path !== canvas || baseline?.userData !== userData) {
    throw new Error('Backup belongs to another canvas or user-data root.');
  }
  const ownership = readOwnership(destination);
  const checked = assertHeldAuthorityRepairJob({ canvas, destination, ownership, jobId: requestedJobId });
  const store = await openAuthorityLedgerStore(path.join(checked.jobFolder, 'context'), { namespace: APPLICATION_AUTHORITY_STORE_NAMESPACE });
  const journal = store.pendingJournal;
  if (!journal || journal.hold !== true || store.state?.digest !== journal.next || store.state?.digest === journal.previous) {
    throw new Error('Authority store is not held at the published journal next root.');
  }
  const receipt = assertCompactAuthorityStoreReceipt(store.receipt());
  if (receipt.digest !== journal.next) throw new Error('Authority store receipt does not name the held journal next root.');
  const backupPath = safeChild(destination, `authority-receipt-${checked.jobId}.manifest.before.json`, 'Manifest backup');
  assertSafeAncestors(destination, backupPath, 'Manifest backup');
  // `wx` is both the durable preimage and a one-time-repair fuse: an operator
  // cannot silently overwrite the exact before bytes from an earlier attempt.
  fs.writeFileSync(backupPath, checked.manifestBytes, { mode: 0o600, flag: 'wx' });
  assert.equal(fs.readFileSync(backupPath).equals(checked.manifestBytes), true, 'manifest backup must preserve exact bytes');
  const nextManifest = jsonClone(checked.manifest);
  nextManifest.paste.authorityStore = receipt;
  const manifestMode = fs.statSync(checked.manifestPath).mode & 0o777;
  await atomicWriteJson(checked.manifestPath, nextManifest, { mode: manifestMode, pretty: false, ensureDir: false });
  const reread = regularJson(checked.manifestPath, 'Repaired job manifest');
  const projection = jsonClone(reread);
  delete projection.paste.authorityStore;
  if (!jsonValuesEqual(projection, checked.manifest) || !jsonValuesEqual(reread?.paste?.authorityStore, receipt)) {
    throw new Error('Held authority receipt repair changed more than paste.authorityStore.');
  }
  // The store journal is deliberately left held. The application is the only
  // component allowed to observe this receipt and finalize that transaction.
  if (!fs.existsSync(path.join(checked.jobFolder, 'context', `${APPLICATION_AUTHORITY_STORE_NAMESPACE}.journal.json`))) {
    throw new Error('Authority journal unexpectedly disappeared during manifest receipt publication.');
  }
  updateOwnedPath({ destination, ownership, area: 'local-ai', relative: checked.jobRelative, root: checked.localAiRoot });
  return { version: 1, jobId: checked.jobId, manifestBackup: backupPath, authorityStore: receipt, journal: 'held' };
}
function selectedCard(name) {
  const card = TARGETS[String(name || '').toLowerCase()];
  if (!card) throw new Error(`--card must be one of: ${Object.keys(TARGETS).join(', ')}.`);
  return card;
}
function jobPayload(data) {
  const keys = ['title', 'company', 'snippet', 'location', 'salary', 'url', 'source', 'posted', 'language', 'postingVariants'];
  return Object.fromEntries(keys.filter(key => data[key] !== undefined).map(key => [key, data[key]]));
}

// The one-card wrapper must prove that its isolated job really carries the
// selected saved listing into the production queue, rather than merely
// proving that a card with the expected identity was present in its fixture.
// Keep this projection beside the queue call so the test does not re-create a
// second, drift-prone list of job-card fields.
export function projectSavedJobCardForAcceptanceHarness(data) {
  return __projectLocalApplicationJobForAcceptanceHarness(jobPayload(data));
}
function applicationBundleCandidates(job) {
  const company = sanitizeApplicationBundlePart(job?.company, 'Company');
  const location = sanitizeApplicationBundlePart(job?.location, 'Unknown Location');
  const role = sanitizeApplicationBundlePart(job?.title, 'Role');
  const listing = formatOriginalJobListingMarkdown(job || {});
  const candidates = [role];
  for (const hexLength of [8, 16]) {
    const suffix = sha256(listing).slice(0, hexLength);
    const wrapper = ` (${suffix})`;
    const truncated = [...role].slice(0, Math.max(0, 100 - wrapper.length)).join('');
    candidates.push(sanitizeApplicationBundlePart(`${truncated}${wrapper}`, `Application (${suffix})`));
  }
  return {
    listingSha256: sha256(listing),
    company, location,
    // The output root itself may be created by the first bundle save. It is
    // metadata-only ownership, like its descendants: pruning it is permitted
    // only when this run created it and it is empty after every owned leaf is
    // restored, so a concurrent bundle remains untouched.
    ancestors: ['', company, path.join(company, location)],
    leaves: [...new Set(candidates)].map(name => path.join(company, location, name)),
  };
}
function reserveApplicationBundleCandidates({ destination, ownership, baseline, appliedJobs, job }) {
  const plan = applicationBundleCandidates(job);
  for (const relative of plan.leaves) {
    const entry = reserveOwnedPath({
      destination, ownership, area: 'applied-jobs', relative, root: appliedJobs,
      before: manifestPathState(baseline.appliedJobs, relative),
    });
    entry.pendingBundle = { listingSha256: plan.listingSha256 };
    entry.ancestors = plan.ancestors.map(ancestor => ({
      relative: ancestor,
      before: manifestDirectoryState(baseline.appliedJobs, ancestor),
      after: directoryState(rootOrSafeChild(appliedJobs, ancestor, 'Application bundle ancestor'), 'Application bundle ancestor'),
    }));
    writeOwnership(destination, ownership);
  }
  return plan;
}
function updateBundleCandidateAncestors(ownership, appliedJobs) {
  for (const entry of Object.values(ownership.paths)) {
    if (entry.area !== 'applied-jobs' || !entry.pendingBundle) continue;
    entry.ancestors = (entry.ancestors || []).map(ancestor => ({
      ...ancestor,
      after: directoryState(rootOrSafeChild(appliedJobs, ancestor.relative, 'Application bundle ancestor'), 'Application bundle ancestor'),
    }));
  }
}
function claimReceiptBundleOwnership({ destination, ownership, appliedJobs, outputDir }) {
  const outputRelative = relativeTarget(appliedJobs, canonical(outputDir));
  const bundleAfter = pathState(safeChild(appliedJobs, outputRelative, 'Application bundle'), 'Application bundle');
  const key = ownedKey('applied-jobs', outputRelative);
  const candidate = ownership.paths[key];
  if (!candidate) throw new Error('Receipt outputDir is not a pre-reserved application bundle candidate. Refusing to claim it.');
  // Restore performs an inspect immediately before cleanup. Once an earlier
  // inspection has consumed this reservation, accept only the same recorded
  // post-claim tree; a changed bundle or different path never gains ownership.
  if (!candidate.pendingBundle) {
    assertPathStateMatches(bundleAfter, candidate.after, 'Previously claimed receipt application bundle');
    return bundleAfter;
  }
  if (!reservedBundleIdentityMatches(safeChild(appliedJobs, outputRelative, 'Application bundle'), candidate.pendingBundle, candidate.before)) {
    throw new Error('Receipt application bundle does not contain the expected frozen job listing.');
  }
  updateBundleCandidateAncestors(ownership, appliedJobs);
  updateOwnedPath({ destination, ownership, area: 'applied-jobs', relative: outputRelative, root: appliedJobs });
  delete ownership.paths[key].pendingBundle;
  writeOwnership(destination, ownership);
  return bundleAfter;
}
function loadCanvas(canvas) { return JSON.parse(fs.readFileSync(canvas, 'utf8')); }

function isWithin(parent, target) {
  const rel = path.relative(parent, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function assertFixtureOutputPath(value) {
  const output = canonical(value || DEFAULT_CAREER_IMPORT_FIXTURE);
  const fixtureRoot = fs.realpathSync(HERE);
  if (!isWithin(canonical(HERE), output)) {
    throw new Error('Fixture --output must stay below .test-artifacts/blackbox-run.');
  }
  if (fs.existsSync(output)) throw new Error(`Refusing to overwrite existing fixture: ${output}`);
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  const resolvedParent = fs.realpathSync(path.dirname(output));
  if (!isWithin(fixtureRoot, resolvedParent)) {
    throw new Error('Fixture output parent resolved outside .test-artifacts/blackbox-run.');
  }
  return output;
}

function jsonClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function findCareerImportHub(data) {
  let found = null;
  walkNodes(data?.nodes, node => {
    if (node?.id !== CAREER_IMPORT_HUB_ID) return;
    if (found) throw new Error(`Duplicate Job Search hub ID ${CAREER_IMPORT_HUB_ID}.`);
    if (node.type !== 'jobhub') {
      throw new Error(`Expected ${CAREER_IMPORT_HUB_ID} to be a jobhub, found ${String(node.type)}.`);
    }
    found = node;
  });
  if (!found) throw new Error(`Job Search hub ${CAREER_IMPORT_HUB_ID} is absent from the source canvas.`);
  return found;
}

function finitePosition(position) {
  if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y)) {
    throw new Error('Source Job Search hub has no finite canvas position.');
  }
  return { x: position.x, y: position.y };
}

// These are the only source-hub values intentionally retained. They are raw
// pre-run search choices, not career identity or a previous run's derived
// state. Every omitted field either pins a previous career upload, owns a
// recovery transaction, contains results, or is renderer-only state.
function cleanCareerImportHub(source) {
  const sourceData = source?.data || {};
  const data = {
    hubState: 'empty',
    collectionLimits: jsonClone(sourceData.collectionLimits) || {
      jobsPerPlatform: null,
      pagesPerPlatform: null,
    },
    searchLocation: jsonClone(sourceData.searchLocation) || {
      city: '', subdivision: '', country: '', countryCode: null,
    },
    remoteResidences: jsonClone(sourceData.remoteResidences) || {},
  };
  for (const key of ['jobPreferences', 'preferredLocation', 'targetRole', 'initialLookbackDays', 'enabledSourceIds']) {
    if (sourceData[key] !== undefined) data[key] = jsonClone(sourceData[key]);
  }
  return {
    id: CAREER_IMPORT_HUB_ID,
    type: 'jobhub',
    position: finitePosition(source.position),
    selected: false,
    dragging: false,
    data,
  };
}

function careerImportDocumentPosition(hubPosition) {
  // Keep the source document beside the hub, not overlapping it, so both are
  // visible after the fixture's normal fit-to-view. The values mirror the
  // compact document node (180px) and Job Search hub (280px) dimensions.
  return { x: hubPosition.x + 360, y: hubPosition.y + 30 };
}

function buildCareerImportDocument(hubPosition, careerFile) {
  // The production OS-drop factory uses only { filename, filePath } for a
  // document node (src/utils/dragUtils.js). `locked` is the one intentional
  // safety addition: DocumentNode treats it as read-only, while the hub-drop
  // extractor still accepts this node because it keys only on type/filePath.
  return {
    id: CAREER_IMPORT_DOCUMENT_ID,
    type: 'document',
    position: careerImportDocumentPosition(hubPosition),
    selected: false,
    dragging: false,
    data: {
      filename: path.basename(careerFile),
      filePath: careerFile,
      locked: true,
    },
  };
}

function careerImportBoardPosition(hubPosition) {
  // Put the board below the source Search. This keeps the document source to
  // the right and leaves a readable, conventional Search → Board edge.
  return { x: hubPosition.x + 10, y: hubPosition.y + 390 };
}

function buildCareerImportBoard(hubPosition) {
  return {
    id: CAREER_IMPORT_BOARD_ID,
    type: 'jobboard',
    position: careerImportBoardPosition(hubPosition),
    selected: false,
    dragging: false,
    // Do not persist a selection array: the board's normal compatibility
    // behavior selects its one connected Search, while it has no results or
    // pending execution state to resurrect.
    data: { hubState: 'empty' },
  };
}

function buildCareerImportBoardEdge() {
  // This precisely matches the ordinary React Flow connection shape emitted
  // by useCanvasActions (animated smoothstep edge with the shared style).
  return {
    id: CAREER_IMPORT_BOARD_EDGE_ID,
    source: CAREER_IMPORT_HUB_ID,
    target: CAREER_IMPORT_BOARD_ID,
    type: 'smoothstep',
    animated: true,
    style: { strokeWidth: 3, opacity: 0.8 },
  };
}

function assertCareerImportFixture(data, {
  sourceCanvas = null,
  careerFile = null,
  includeDocument = false,
  connectedBoard = false,
} = {}) {
  if (connectedBoard && !includeDocument) {
    throw new Error('A connected-board career-import fixture requires --include-document.');
  }
  const expectedNodes = 1 + (includeDocument ? 1 : 0) + (connectedBoard ? 1 : 0);
  if (!data || !Array.isArray(data.nodes) || data.nodes.length !== expectedNodes) {
    throw new Error(`Career-import fixture must contain exactly ${expectedNodes} root node${expectedNodes === 1 ? '' : 's'}.`);
  }
  const expectedEdges = connectedBoard ? 1 : 0;
  if (!Array.isArray(data.edges) || data.edges.length !== expectedEdges || !Array.isArray(data.drawings) || data.drawings.length !== 0) {
    throw new Error(`Career-import fixture must contain exactly ${expectedEdges} edge${expectedEdges === 1 ? '' : 's'} and no drawings.`);
  }
  const hub = data.nodes.find(node => node?.id === CAREER_IMPORT_HUB_ID);
  if (hub?.id !== CAREER_IMPORT_HUB_ID || hub?.type !== 'jobhub' || hub?.data?.hubState !== 'empty') {
    throw new Error('Career-import fixture hub is not the required empty Job Search hub.');
  }
  const forbidden = [
    'locked', 'inputLocked', 'careerSnapshotId', 'careerData', 'resumeProfile',
    'resumeSummary', 'resumeFingerprint', 'resumeContext', 'filePath', 'filePaths',
    'careerFilePaths', 'careerImportGeneration', 'careerImportFreshCapability',
    'careerImportConsumption', 'jobRunId', 'manualAiResume', 'manualAiCleanupReceipts',
    'terminalFinalizationRecovery', 'queuedModuleRun', 'pendingJobs', 'pendingCareerData',
    'scoredJobs', 'searchWindow', 'canvasData',
  ];
  for (const key of forbidden) {
    if (Object.hasOwn(hub.data, key) && hub.data[key] != null) {
      throw new Error(`Career-import fixture retained forbidden hub field: ${key}.`);
    }
  }
  const serialized = JSON.stringify(data);
  if (sourceCanvas && serialized.includes(canonical(sourceCanvas))) {
    throw new Error('Career-import fixture must not retain a source canvas path.');
  }
  const documents = data.nodes.filter(node => node?.type === 'document');
  if (!includeDocument) {
    if (documents.length !== 0 || (careerFile && serialized.includes(canonical(careerFile)))) {
      throw new Error('Pathless career-import fixture must not retain a career-file path.');
    }
  } else {
    if (documents.length !== 1) throw new Error('Document fixture must contain exactly one source document node.');
    const document = documents[0];
    if (document.id !== CAREER_IMPORT_DOCUMENT_ID
      || document.data?.filename !== path.basename(careerFile)
      || document.data?.filePath !== canonical(careerFile)
      || document.data?.locked !== true
      || !Number.isFinite(document.position?.x)
      || !Number.isFinite(document.position?.y)) {
      throw new Error('Document fixture source node does not match the real career file contract.');
    }
  }
  const boards = data.nodes.filter(node => node?.type === 'jobboard');
  if (!connectedBoard) {
    if (boards.length !== 0) throw new Error('Non-board fixture must not contain a Job Board.');
  } else {
    if (boards.length !== 1) throw new Error('Connected fixture must contain exactly one Job Board.');
    const board = boards[0];
    if (board.id !== CAREER_IMPORT_BOARD_ID
      || board.data?.hubState !== 'empty'
      || !Number.isFinite(board.position?.x)
      || !Number.isFinite(board.position?.y)
      || Object.keys(board.data || {}).some(key => key !== 'hubState')) {
      throw new Error('Connected fixture Job Board is not the required empty board.');
    }
    const edge = data.edges[0];
    if (edge?.id !== CAREER_IMPORT_BOARD_EDGE_ID
      || edge.source !== CAREER_IMPORT_HUB_ID
      || edge.target !== CAREER_IMPORT_BOARD_ID
      || edge.type !== 'smoothstep'
      || edge.animated !== true
      || edge.style?.strokeWidth !== 3
      || edge.style?.opacity !== 0.8) {
      throw new Error('Connected fixture does not contain the required Job Search → Job Board edge.');
    }
  }
  return hub;
}

export function createCareerImportFixture({
  sourceCanvas = DEFAULT_CANVAS,
  careerFile = DEFAULT_CAREER_IMPORT_SOURCE,
  output = null,
  includeDocument = false,
  connectedBoard = false,
} = {}) {
  const source = canonical(sourceCanvas);
  const sourceCareerFile = canonical(careerFile);
  assertRegularFile(source, 'Source canvas');
  // This is intentionally only a preflight: the file is never read, copied,
  // moved, renamed, or written. The packaged app reads it only after the
  // operator explicitly drags it onto the fixture hub.
  assertRegularFile(sourceCareerFile, 'Career file');
  if (connectedBoard && !includeDocument) {
    throw new Error('--connected-board requires --include-document.');
  }
  const destination = assertFixtureOutputPath(output || (
    connectedBoard ? DEFAULT_CAREER_IMPORT_CONNECTED_FIXTURE
      : includeDocument ? DEFAULT_CAREER_IMPORT_DOCUMENT_FIXTURE : DEFAULT_CAREER_IMPORT_FIXTURE
  ));
  if (destination === source || destination === sourceCareerFile) {
    throw new Error('Fixture output must not replace a source file.');
  }
  const sourceBytes = fs.readFileSync(source);
  const sourceData = JSON.parse(sourceBytes);
  const hub = cleanCareerImportHub(findCareerImportHub(sourceData));
  const document = includeDocument ? buildCareerImportDocument(hub.position, sourceCareerFile) : null;
  const board = connectedBoard ? buildCareerImportBoard(hub.position) : null;
  const fixture = {
    nodes: [hub, ...(document ? [document] : []), ...(board ? [board] : [])],
    edges: board ? [buildCareerImportBoardEdge()] : [],
    drawings: [],
    schemaVersion: Number.isInteger(sourceData.schemaVersion) ? sourceData.schemaVersion : 0,
  };
  assertCareerImportFixture(fixture, { sourceCanvas: source, careerFile: sourceCareerFile, includeDocument, connectedBoard });
  fs.writeFileSync(destination, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  // Re-read the actual bytes, not the in-memory object, so this command is a
  // structural fixture proof as well as a writer.
  assertCareerImportFixture(loadCanvas(destination), { sourceCanvas: source, careerFile: sourceCareerFile, includeDocument, connectedBoard });
  return {
    fixture: destination,
    sourceCanvas: source,
    careerFile: sourceCareerFile,
    hubId: CAREER_IMPORT_HUB_ID,
    documentNodeId: document?.id || null,
    boardNodeId: board?.id || null,
    dragTarget: 'the empty Job Search hub showing “Drop your career files”',
    acceptedCue: 'Use as resume',
  };
}

function careerImportFixtureSelfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-career-import-fixture-'));
  const outputs = [];
  try {
    const sourceCareerFile = path.join(root, 'Work Experience.md');
    const careerBytes = 'Fixture career source remains untouched.\n';
    fs.writeFileSync(sourceCareerFile, careerBytes, { mode: 0o600 });
    const sourceCanvas = path.join(root, 'source.json');
    const source = {
      schemaVersion: 7,
      nodes: [{
        id: 'container', type: 'group', position: { x: 0, y: 0 }, data: {
          canvasData: { nodes: [{
            id: CAREER_IMPORT_HUB_ID, type: 'jobhub', position: { x: 123, y: 456 }, data: {
              hubState: 'done', inputLocked: true, careerFilePaths: [sourceCareerFile],
              careerData: 'do not copy', resumeProfile: { title: 'do not copy' },
              scoredJobs: [{ title: 'do not copy' }], jobRunId: 'old-run',
              collectionLimits: { jobsPerPlatform: 5, pagesPerPlatform: 2 },
              searchLocation: { city: 'Toronto', subdivision: 'Ontario', country: 'Canada', countryCode: 'CA' },
              remoteResidences: { canada: { city: 'Toronto', subdivision: 'Ontario', country: 'Canada', countryCode: 'CA' } },
              jobPreferences: 'Product Engineer', enabledSourceIds: ['linkedin'],
            },
          }], edges: [], drawings: [] },
        },
      }], edges: [], drawings: [],
    };
    fs.writeFileSync(sourceCanvas, JSON.stringify(source), { mode: 0o600 });
    const output = path.join(HERE, 'fixtures', `.self-test-${crypto.randomUUID()}.canvas`);
    const documentOutput = path.join(HERE, 'fixtures', `.self-test-${crypto.randomUUID()}-with-document.canvas`);
    const connectedOutput = path.join(HERE, 'fixtures', `.self-test-${crypto.randomUUID()}-with-document-and-board.canvas`);
    outputs.push(output, documentOutput, connectedOutput);
    const sourceBefore = fs.readFileSync(sourceCanvas);
    const careerBefore = fs.readFileSync(sourceCareerFile);
    const result = createCareerImportFixture({ sourceCanvas, careerFile: sourceCareerFile, output });
    const fixture = loadCanvas(output);
    assert.equal(result.hubId, CAREER_IMPORT_HUB_ID);
    assert.equal(fixture.nodes.length, 1);
    assert.equal(fixture.nodes[0].position.x, 123);
    assert.equal(fixture.nodes[0].data.hubState, 'empty');
    assert.equal(fixture.nodes[0].data.careerFilePaths, undefined);
    assert.equal(fixture.nodes[0].data.scoredJobs, undefined);
    assert.equal(fs.readFileSync(sourceCanvas).equals(sourceBefore), true);
    assert.equal(fs.readFileSync(sourceCareerFile).equals(careerBefore), true);
    assert.throws(() => createCareerImportFixture({ sourceCanvas, careerFile: sourceCareerFile, output }), /Refusing to overwrite/);
    const documentResult = createCareerImportFixture({
      sourceCanvas,
      careerFile: sourceCareerFile,
      output: documentOutput,
      includeDocument: true,
    });
    const documentFixture = loadCanvas(documentOutput);
    const documentNode = documentFixture.nodes.find(node => node.id === CAREER_IMPORT_DOCUMENT_ID);
    assert.equal(documentResult.documentNodeId, CAREER_IMPORT_DOCUMENT_ID);
    assert.equal(documentFixture.nodes.length, 2);
    assert.deepEqual(documentNode.data, {
      filename: 'Work Experience.md', filePath: sourceCareerFile, locked: true,
    });
    assert.equal(documentNode.position.x, 483);
    assert.equal(documentNode.position.y, 486);
    assert.throws(
      () => createCareerImportFixture({ sourceCanvas, careerFile: sourceCareerFile, connectedBoard: true }),
      /requires --include-document/,
    );
    const connectedResult = createCareerImportFixture({
      sourceCanvas,
      careerFile: sourceCareerFile,
      output: connectedOutput,
      includeDocument: true,
      connectedBoard: true,
    });
    const connectedFixture = loadCanvas(connectedOutput);
    const board = connectedFixture.nodes.find(node => node.id === CAREER_IMPORT_BOARD_ID);
    assert.equal(connectedResult.boardNodeId, CAREER_IMPORT_BOARD_ID);
    assert.equal(connectedFixture.nodes.length, 3);
    assert.deepEqual(board.data, { hubState: 'empty' });
    assert.deepEqual(board.position, { x: 133, y: 846 });
    assert.deepEqual(connectedFixture.edges, [buildCareerImportBoardEdge()]);
    assert.equal(connectedFixture.edges[0].source, CAREER_IMPORT_HUB_ID);
    assert.equal(connectedFixture.edges[0].target, CAREER_IMPORT_BOARD_ID);
    assert.equal(fs.readFileSync(sourceCanvas).equals(sourceBefore), true);
    assert.equal(fs.readFileSync(sourceCareerFile).equals(careerBefore), true);
    return { ok: true, hubId: CAREER_IMPORT_HUB_ID };
  } finally {
    for (const output of outputs) fs.rmSync(output, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}
async function saveCanvasAtomic(canvas, data) {
  const mode = fs.statSync(canvas).mode & 0o777;
  await atomicWriteJson(canvas, data, { mode, pretty: false, ensureDir: false });
}
function statusProjection(result) {
  // `localApplicationStatus` is the production export; IPC wraps it in
  // `{ localJob }`, while this direct harness deliberately receives it raw.
  const local = result?.localJob || result?.localApplication || result || null;
  return local ? {
    id: local.id, status: local.status, mode: local.mode || null, stage: local.stage || null,
    message: local.message || null, resultSha256: local.resultSha256 || null,
    receipt: local.receipt ? { status: local.receipt.status, outputDir: local.receipt.outputDir, resultSha256: local.receipt.resultSha256 } : null,
  } : null;
}

export async function publishSnapshot({ snapshotFile = null, snapshotId: requestedId, userData, destination = null, execute = false, allowNonproduction = false }) {
  if (!execute) throw new Error('Refusing snapshot publish without --execute.');
  if (!destination) throw new Error('Refusing snapshot publish without a pre-existing --run-id ownership manifest. Run backup first.');
  const id = snapshotId(requestedId);
  const root = canonical(userData);
  if (!allowNonproduction && root !== DEFAULT_USER_DATA) throw new Error('Refusing a non-production user-data root.');
  assertRegularDirectory(root, 'Electron user-data directory');
  patchStubUserData(root);
  if (!snapshotFile) {
    throw new Error('This harness only publishes an already current approved snapshot. Import the source in the packaged app to compile and audit a new v5 snapshot; do not synthesize one from --profile/--source.');
  }
  const resolvedSnapshotFile = canonical(snapshotFile);
  assertRegularFile(resolvedSnapshotFile, 'Snapshot');
  const snapshot = JSON.parse(fs.readFileSync(resolvedSnapshotFile, 'utf8'));
  const validation = validateCurrentCareerSnapshot(snapshot, { expectedSnapshotId: id });
  if (!validation.valid) throw new Error(`Snapshot is not current approved production data: ${validation.errors.slice(0, 4).join(' | ')}`);
  if (snapshot.snapshotId !== id) throw new Error(`--snapshot-id does not match snapshot content (${snapshot.snapshotId || 'missing'}).`);
  const baseline = JSON.parse(fs.readFileSync(path.join(destination, 'baseline.json'), 'utf8'));
  if (baseline.userData !== root) throw new Error('Backup belongs to another user-data root.');
  const ownership = readOwnership(destination);
  const store = careerSnapshotStorageRoot(root);
  const relative = path.join('career-snapshots', `${id}.json`);
  // The production writer can create both private directories and this one
  // immutable file. Check the file against the pre-mutation backup before it
  // is allowed to publish, then own only that exact file (never the store).
  const before = manifestPathState(baseline.careerSnapshotStore, relative);
  const currentBefore = pathState(safeChild(store, relative, 'Career snapshot'), 'Career snapshot');
  assertPathStateMatches(currentBefore, expectedOwnedState(ownership, ownedKey('snapshot', relative), before), 'Career snapshot');
  const published = await writeCareerSnapshotAtomically(store, snapshot);
  const read = await readPinnedCareerSnapshot(store, id);
  if (!read) throw new Error('Snapshot write returned but production pinned-snapshot reader rejected it.');
  const after = pathState(safeChild(store, relative, 'Career snapshot'), 'Career snapshot');
  const owned = recordOwnedPath({
    destination, ownership, area: 'snapshot', relative, root: store,
    backupRoot: path.join(destination, 'career-snapshot-store'), before, after,
    source: { path: resolvedSnapshotFile, sha256: byteRecord(resolvedSnapshotFile).sha256, snapshotId: id },
  });
  // The writer may create/chmod these two directories. They are recorded as
  // metadata-only ancestors: an unrelated snapshot added under either one is
  // not a reason to delete it, but an overlapping chmod fails closed.
  owned.ancestors = [
    { relative: '', before: directoryState(store, 'Career snapshot store'), after: directoryState(store, 'Career snapshot store') },
    { relative: 'career-snapshots', before: directoryState(path.join(store, 'career-snapshots'), 'Career snapshot directory'), after: directoryState(path.join(store, 'career-snapshots'), 'Career snapshot directory') },
  ];
  // The pre-publish states are read from the immutable baseline backup, not
  // from the now-mutated live directories.
  owned.ancestors[0].before = manifestDirectoryState(baseline.careerSnapshotStore);
  owned.ancestors[1].before = manifestDirectoryState(baseline.careerSnapshotStore, 'career-snapshots');
  writeOwnership(destination, ownership);
  return { published, snapshotId: id, roles: read.profile?.roles?.length || 0, sourceSha256: byteRecord(resolvedSnapshotFile).sha256 };
}

export function backupRun({ canvas, userData, destination, execute = false, allowNonproduction = false, copyPrivateUserDataBaseline = true, copyApplicationSyncBaseline = copyPrivateUserDataBaseline }) {
  if (!execute) throw new Error('Refusing backup creation without --execute.');
  if (!allowNonproduction && (canonical(canvas) !== DEFAULT_CANVAS || canonical(userData) !== DEFAULT_USER_DATA)) throw new Error('Refusing non-production backup target.');
  if (fs.existsSync(destination)) throw new Error(`Backup destination already exists: ${destination}`);
  const canvasRoot = fs.realpathSync(path.dirname(canvas));
  const localAi = path.join(canvasRoot, '.local-ai');
  const appliedJobs = path.join(canvasRoot, 'Applied Jobs');
  const careerSnapshotStore = careerSnapshotStorageRoot(userData);
  const authorityAnchors = authorityAnchorStorageRoot(userData);
  const sync = path.join(userData, 'application-sync-workspaces.json');
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
  try {
    fs.copyFileSync(canvas, path.join(destination, 'canvas.json'), fs.constants.COPYFILE_EXCL);
    if (fs.existsSync(localAi)) copyTree(localAi, path.join(destination, 'local-ai'));
    if (fs.existsSync(appliedJobs)) copyTree(appliedJobs, path.join(destination, 'Applied Jobs'));
    // The no-secret mode retains only hashes/modes/tree metadata in
    // baseline.json. It is valid only for a run that neither publishes a
    // snapshot nor claims a pre-existing anchor/Sync entry for restoration.
    if (copyPrivateUserDataBaseline && fs.existsSync(careerSnapshotStore)) copyTree(careerSnapshotStore, path.join(destination, 'career-snapshot-store'));
    if (copyPrivateUserDataBaseline && fs.existsSync(authorityAnchors)) copyTree(authorityAnchors, path.join(destination, 'authority-anchors'));
    // Application Sync is deliberately independent from career snapshots and
    // authority-anchor keys. A no-secret career backup can still retain this
    // small registry's exact bytes, which is necessary to restore formatting,
    // mode, mtime, and existing workspace capabilities after removing only a
    // receipt-claimed isolated workspace entry.
    if (copyApplicationSyncBaseline && fs.existsSync(sync)) fs.copyFileSync(sync, path.join(destination, 'application-sync-workspaces.json'), fs.constants.COPYFILE_EXCL);
    const manifest = {
      version: 3, createdAt: new Date().toISOString(), canvas, canvasRoot, userData,
      canvas: { path: canvas, ...byteRecord(canvas) },
      localAi: treeManifest(localAi), appliedJobs: treeManifest(appliedJobs),
      careerSnapshotStore: treeManifest(careerSnapshotStore),
      authorityAnchors: treeManifest(authorityAnchors),
      applicationSync: fs.existsSync(sync) ? { present: true, ...byteRecord(sync) } : { present: false },
    };
    fs.writeFileSync(path.join(destination, 'baseline.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(ownershipPath(destination), `${JSON.stringify({ version: 1, createdAt: manifest.createdAt, paths: {} }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    return manifest;
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

export async function pinAndQueue({ canvas, userData, destination, cardName, requestedSnapshotId, execute = false, allowNonproduction = false, skipExistingAuthorityIntegrityKey = false, useLiveApplicationSyncBaseline = false }) {
  if (!execute) throw new Error('Refusing pin/queue without --execute.');
  if (!allowNonproduction && (canonical(canvas) !== DEFAULT_CANVAS || canonical(userData) !== DEFAULT_USER_DATA)) throw new Error('Refusing non-production queue target.');
  const baseline = JSON.parse(fs.readFileSync(path.join(destination, 'baseline.json'), 'utf8'));
  if (baseline.canvas.path !== canvas || baseline.userData !== userData) throw new Error('Backup belongs to another canvas or user-data root.');
  const ownership = readOwnership(destination);
  const card = selectedCard(cardName);
  const id = snapshotId(requestedSnapshotId);
  patchStubUserData(userData);
  const snapshot = await readPinnedCareerSnapshot(careerSnapshotStorageRoot(userData), id);
  if (!snapshot) throw new Error('The requested approved career snapshot is missing or invalid in this Electron user-data root.');
  const data = loadCanvas(canvas);
  const node = findTargetNode(data, card);
  const existing = await discoverLocalApplicationJobs(canvas);
  if (existing.length) throw new Error(`Refusing to queue while ${existing.length} actionable Local-AI job(s) already exist; process exactly one at a time.`);
  const canvasBefore = { present: true, type: 'file', ...byteRecord(canvas) };
  const baselineCanvas = { present: true, type: 'file', ...baseline.canvas };
  assertPathStateMatches(canvasBefore, expectedOwnedState(ownership, ownedKey('canvas', 'canvas.json'), baselineCanvas), 'Canvas');
  const syncBeforeQueue = syncRegistryPath(userData);
  assertOptionalFileMatches(fs.existsSync(syncBeforeQueue) ? { present: true, ...byteRecord(syncBeforeQueue) } : { present: false }, baseline.applicationSync, 'Application Sync registry before queue');
  const localAiRoot = path.join(fs.realpathSync(path.dirname(canvas)), '.local-ai');
  if (fs.existsSync(localAiRoot)) assertSafeTree(localAiRoot, '.local-ai');
  const queuedJobPayload = projectSavedJobCardForAcceptanceHarness(node.data);
  const appliedJobs = path.join(fs.realpathSync(path.dirname(canvas)), 'Applied Jobs');
  // Reserve every production resolver candidate before the job exists, so a
  // renderer/dock cannot save even the base path before ownership is durable.
  const bundleCandidates = reserveApplicationBundleCandidates({ destination, ownership, baseline, appliedJobs, job: queuedJobPayload });
  reserveSyncWorkspaceCandidates({ destination, ownership, baseline, userData, leaves: bundleCandidates.leaves, appliedJobs, useLiveRegistryBaseline: useLiveApplicationSyncBaseline });
  const before = byteRecord(canvas);
  const reservedJobId = crypto.randomUUID();
  const jobRelative = path.join('jobs', reservedJobId);
  const jobBefore = manifestPathState(baseline.localAi, jobRelative);
  if (jobBefore.present) throw new Error('Refusing to queue into a pre-existing Local-AI job path.');
  const jobReservation = reserveOwnedPath({
    destination, ownership, area: 'local-ai', relative: jobRelative, root: localAiRoot, before: jobBefore,
  });
  jobReservation.pendingJob = { jobId: reservedJobId, canvas };
  writeOwnership(destination, ownership);
  // The app writes these deterministic, job-keyed metadata sidecars outside
  // jobs/<id>. Reserve both before queueing so a phase stamp or terminal
  // receipt can never escape the run's rollback boundary.
  reserveLocalAiJobSidecars({ destination, ownership, baseline, localAiRoot, jobId: reservedJobId });
  reserveAuthorityAnchorFiles({ destination, ownership, baseline, userData, jobId: reservedJobId, skipExistingIntegrityKey: skipExistingAuthorityIntegrityKey });
  const jobIdReservation = __reserveNextLocalApplicationJobIdForAcceptanceHarness(reservedJobId);
  if (jobIdReservation.id !== reservedJobId || !/^[a-f0-9]{64}$/i.test(jobIdReservation.capability || '')) {
    throw new Error('Acceptance-harness job reservation did not return its opaque one-shot capability.');
  }
  const queued = await queueLocalApplicationJob({
    nodeId: node.id, canvasFilePath: canvas, transport: 'paste', careerSnapshotId: id,
    job: queuedJobPayload, additionalNotes: String(node.data.additionalNotes || ''),
    reasoning: node.data.reasoning, matchScore: node.data.matchScore,
    __acceptanceHarnessReservationCapability: jobIdReservation.capability,
  });
  if (queued.id !== reservedJobId || canonical(queued.folder) !== safeChild(localAiRoot, jobRelative, 'Reserved Local-AI job')) {
    throw new Error('Queue did not honor the pre-reserved Local-AI job identity.');
  }
  try {
    node.data.careerSnapshotId = id;
    delete node.data.localApplication; // includes Affirm's stale failed paste pointer when explicitly selected
    node.data.localApplication = { ...queued, prompt: undefined };
    delete node.data.localApplication.prompt;
    await saveCanvasAtomic(canvas, data);
  } catch (error) {
    // The app-authored folder contains private career context.  If the pointer
    // could not be committed, remove it through the production ownership API.
    const { discardLocalApplicationJob } = await import('../../electron/ipc/localAiApplication.js');
    await discardLocalApplicationJob(queued.id, canvas).catch(() => {});
    throw error;
  }
  const reread = findTargetNode(loadCanvas(canvas), card);
  if (reread.data.careerSnapshotId !== id || reread.data.localApplication?.id !== queued.id) {
    throw new Error('Queued Local-AI job was not durably pinned to the selected card.');
  }
  const canvasAfter = { present: true, type: 'file', ...byteRecord(canvas) };
  const ownedCanvas = recordOwnedPath({
    destination, ownership, area: 'canvas', relative: 'canvas.json', root: path.dirname(canvas), backupRoot: destination,
    before: baselineCanvas, after: canvasAfter,
  });
  // The queue write itself is only the first legal state of this pointer. The
  // controlled app is allowed to advance this exact card/job pairing while it
  // processes the handoff; inspect re-attests its canvas scope before updating
  // the byte-level CAS used by restore.
  ownedCanvas.applicationPointer = { card, snapshotId: id, jobId: queued.id };
  writeOwnership(destination, ownership);
  const jobAfter = pathState(safeChild(localAiRoot, jobRelative, 'Local-AI job'), 'Local-AI job');
  if (!jobAfter.present || jobAfter.type !== 'dir') throw new Error('Queued Local-AI job did not create its expected owned directory.');
  updateOwnedPath({ destination, ownership, area: 'local-ai', relative: jobRelative, root: localAiRoot });
  updateLocalAiJobSidecarOwnership({ destination, ownership, localAiRoot, canvas, jobId: reservedJobId });
  updateAuthorityAnchorOwnership({ destination, ownership, userData, jobId: reservedJobId });
  delete ownership.paths[ownedKey('local-ai', jobRelative)].pendingJob;
  const frozenInput = regularJson(path.join(queued.folder, 'input.json'), 'Queued Local-AI input');
  const frozenCandidates = applicationBundleCandidates(frozenInput.job);
  if (frozenCandidates.listingSha256 !== applicationBundleCandidates(queuedJobPayload).listingSha256
    || JSON.stringify(frozenCandidates.leaves) !== JSON.stringify(bundleCandidates.leaves)) {
    throw new Error('Queued job bundle candidates differ from the pre-reserved production projection.');
  }
  writeOwnership(destination, ownership);
  const receipt = {
    version: 1, queuedAt: new Date().toISOString(), card: { name: cardName, ...card },
    snapshotId: id, canvasBefore: before, canvasAfter: byteRecord(canvas),
    localJob: { ...queued, prompt: undefined }, bundleCandidates: bundleCandidates.leaves,
  };
  fs.writeFileSync(path.join(destination, `queue-${cardName}.json`), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return receipt;
}

export async function inspectJob({ canvas, userData, destination, jobId }) {
  patchStubUserData(userData);
  const status = await localApplicationStatus(jobId, canvas);
  const jobFolder = path.join(path.dirname(canvas), '.local-ai', 'jobs', jobId);
  const files = fs.existsSync(jobFolder) ? treeManifest(jobFolder) : { present: false, entries: [] };
  // Status is deliberately read first: it is the production ownership and
  // frozen-input validator.  This report then exposes only manifest metadata
  // and artifact hashes/counts, never private career or generated prose.
  let manifest = null;
  if (files.present) {
    const manifestPath = path.join(jobFolder, 'manifest.json');
    const stat = fs.lstatSync(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Job manifest is not a trusted regular file.');
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest = {
      id: parsed.id, version: parsed.version, status: parsed.status, transport: parsed.transport,
      createdAt: parsed.createdAt || null, canvasFilePath: parsed.canvasFilePath || null,
      fileNames: Array.isArray(parsed.files) ? parsed.files.slice() : [],
    };
  }
  const outputDir = status?.receipt?.outputDir || null;
  const canvasRoot = fs.realpathSync(path.dirname(canvas));
  const output = outputDir && canonical(outputDir).startsWith(`${canvasRoot}${path.sep}`) && fs.existsSync(outputDir)
    ? { path: outputDir, files: treeManifest(outputDir) }
    : { path: outputDir, files: { present: false, entries: [] } };
  // Inspection is the only point at which a production receipt names a
  // generated bundle. Record that concrete path as owned before cleanup can
  // touch it; sibling bundles remain deliberately outside the manifest.
  if (destination) {
    const ownership = readOwnership(destination);
    const baseline = JSON.parse(fs.readFileSync(path.join(destination, 'baseline.json'), 'utf8'));
    // A controlled app may have advanced only this run's selected card pointer
    // since queueing. Re-attest that narrow structural delta before replacing
    // the canvas CAS state; all other canvas edits remain fail-closed.
    attestOwnedCanvasPointerProgress({ canvas, destination, ownership, jobId });
    const localAiRoot = path.join(canvasRoot, '.local-ai');
    const jobRelative = path.join('jobs', jobId);
    if (ownership.paths[ownedKey('local-ai', jobRelative)]) {
      updateOwnedPath({ destination, ownership, area: 'local-ai', relative: jobRelative, root: localAiRoot });
    }
    updateLocalAiJobSidecarOwnership({ destination, ownership, localAiRoot, canvas, jobId });
    if (outputDir && output.files.present) {
      const appliedJobs = path.join(canvasRoot, 'Applied Jobs');
      claimReceiptBundleOwnership({ destination, ownership, appliedJobs, outputDir });
      claimSyncWorkspaceOwnership({ destination, ownership, userData, outputDir });
    }
  }
  const report = { version: 1, inspectedAt: new Date().toISOString(), canvas, jobId, status: statusProjection(status), manifest, jobFolder, files, output };
  if (destination) fs.writeFileSync(path.join(destination, `inspect-${jobId}.json`), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return report;
}

// A stopped acceptance run can contain a deliberately malformed application
// authority store that today's `localApplicationStatus` quite correctly
// refuses to parse. Cleanup must not broaden that parser failure into either
// an abandoned private job tree or authority to delete an arbitrary path.
// This recovery helper never interprets the authority store. It re-attests
// only the UUID/canvas/root identity frozen in this run's already-reserved job
// folder, the exact selected-card pointer reserved at queue time, and the
// already-reserved bundle candidate set. The ordinary restore remains the
// sole code that removes anything.
export function adoptReservedCorruptJobStateForRestore({
  canvas,
  userData,
  destination,
  jobId: requestedJobId,
  bundleCandidates,
}) {
  const jobId = heldAuthorityReceiptJobId(requestedJobId);
  if (!Array.isArray(bundleCandidates) || !bundleCandidates.length
    || bundleCandidates.some(relative => typeof relative !== 'string' || !relative
      || path.isAbsolute(relative) || path.normalize(relative) !== relative)) {
    throw new Error('Corruption-safe cleanup requires the non-empty pre-reserved bundle candidate list.');
  }
  const expectedCandidates = [...new Set(bundleCandidates.map(relative => path.normalize(relative)))];
  if (expectedCandidates.length !== bundleCandidates.length) {
    throw new Error('Corruption-safe cleanup bundle candidates must be unique.');
  }
  const baseline = JSON.parse(fs.readFileSync(path.join(destination, 'baseline.json'), 'utf8'));
  if (baseline.canvas.path !== canvas || baseline.userData !== userData) {
    throw new Error('Backup belongs to another canvas or user-data root.');
  }
  const ownership = readOwnership(destination);
  const canvasRoot = fs.realpathSync(path.dirname(canvas));
  const canvasEntry = ownership.paths[ownedKey('canvas', 'canvas.json')];
  const reservation = canvasEntry?.applicationPointer;
  if (!reservation || reservation.jobId !== jobId) {
    throw new Error('Corruption-safe cleanup job id is not the selected-card reservation.');
  }

  const jobRelative = path.join('jobs', jobId);
  const jobEntry = ownership.paths[ownedKey('local-ai', jobRelative)];
  if (!jobEntry || jobEntry.area !== 'local-ai' || jobEntry.relative !== jobRelative
    || jobEntry.before?.present !== false || jobEntry.pendingJob) {
    throw new Error('Corruption-safe cleanup job tree was not pre-reserved as a new run-owned path.');
  }
  const jobFolder = safeChild(path.join(canvasRoot, '.local-ai'), jobRelative, 'Corrupt run-owned Local-AI job');
  assertSafeAncestors(canvasRoot, jobFolder, 'Corrupt run-owned Local-AI job');
  assertRegularDirectory(jobFolder, 'Corrupt run-owned Local-AI job');
  assertSafeTree(jobFolder, 'Corrupt run-owned Local-AI job');
  const jobManifest = regularJson(path.join(jobFolder, 'manifest.json'), 'Corrupt run-owned Local-AI manifest');
  const input = regularJson(path.join(jobFolder, 'input.json'), 'Corrupt run-owned Local-AI input');
  if (jobManifest?.id !== jobId || input?.jobId !== jobId
    || jobManifest?.transport !== 'paste'
    || !sameExistingPath(jobManifest?.canvasFilePath, canvas)
    || !sameExistingPath(input?.canvasFilePath, canvas)
    || !sameExistingPath(jobManifest?.canvasRoot, canvasRoot)
    || !sameExistingPath(input?.canvasRoot, canvasRoot)) {
    throw new Error('Corruption-safe cleanup manifest/input identity does not match the reserved job, canvas, and root.');
  }
  const frozenPlan = applicationBundleCandidates(input.job);
  if (JSON.stringify(frozenPlan.leaves) !== JSON.stringify(expectedCandidates)) {
    throw new Error('Corruption-safe cleanup candidate list does not match the frozen job input.');
  }

  const reservedCandidates = Object.values(ownership.paths)
    .filter(entry => entry?.area === 'applied-jobs')
    .map(entry => entry.relative)
    .sort();
  if (JSON.stringify(reservedCandidates) !== JSON.stringify([...expectedCandidates].sort())) {
    throw new Error('Corruption-safe cleanup candidate list does not exactly match the ownership reservations.');
  }
  const appliedJobs = path.join(canvasRoot, 'Applied Jobs');
  const existingCandidates = expectedCandidates.filter(relative => fs.existsSync(safeChild(appliedJobs, relative, 'Reserved corrupt-run bundle')));
  if (existingCandidates.length > 1) {
    throw new Error('Corruption-safe cleanup found more than one materialized reserved bundle candidate.');
  }
  for (const relative of existingCandidates) {
    const entry = ownership.paths[ownedKey('applied-jobs', relative)];
    const target = safeChild(appliedJobs, relative, 'Reserved corrupt-run bundle');
    assertSafeAncestors(canvasRoot, target, 'Reserved corrupt-run bundle');
    assertSafeTree(target, 'Reserved corrupt-run bundle');
    if (entry.pendingBundle && !reservedBundleIdentityMatches(target, entry.pendingBundle, entry.before)) {
      throw new Error('Corruption-safe cleanup reserved bundle does not match its frozen listing identity.');
    }
  }

  // Re-attest the exact card pointer before changing any ownership CAS state.
  // This rejects every canvas edit other than the reserved pointer and narrow
  // renderer measurement/selection cache handled by the ordinary harness.
  if (!attestOwnedCanvasPointerProgress({ canvas, destination, ownership, jobId })) {
    throw new Error('Corruption-safe cleanup could not attest the reserved selected-card pointer.');
  }
  if (!reattestRunCreatedLocalAiJobTree({ canvas, canvasRoot, destination, ownership })) {
    throw new Error('Corruption-safe cleanup could not adopt the exact reserved job tree.');
  }
  reattestRunOwnedLocalAiSidecars({ canvas, canvasRoot, destination, ownership });

  for (const relative of existingCandidates) {
    const entry = ownership.paths[ownedKey('applied-jobs', relative)];
    const target = safeChild(appliedJobs, relative, 'Reserved corrupt-run bundle');
    if (!entry.pendingBundle) {
      assertPathStateMatches(pathState(target, 'Reserved corrupt-run bundle'), entry.after, 'Previously adopted corrupt-run bundle');
      continue;
    }
    // A completed bundle has an Application Sync capability that must be
    // claimed with the existing strict token/workspace identity checks. An
    // incomplete crash-window bundle has no capability yet; its exact tree is
    // still hashed into ownership before the ordinary restore removes it.
    if (fs.existsSync(path.join(target, 'Application.html'))) {
      claimReceiptBundleOwnership({ destination, ownership, appliedJobs, outputDir: target });
      claimSyncWorkspaceOwnership({ destination, ownership, userData, outputDir: target });
    } else {
      updateBundleCandidateAncestors(ownership, appliedJobs);
      updateOwnedPath({ destination, ownership, area: 'applied-jobs', relative, root: appliedJobs });
      delete ownership.paths[ownedKey('applied-jobs', relative)].pendingBundle;
      writeOwnership(destination, ownership);
    }
  }

  const adopted = readOwnership(destination);
  assertOwnedPreflight({ ownership: adopted, canvas, canvasRoot, userData });
  const adoptedJob = adopted.paths[ownedKey('local-ai', jobRelative)];
  return {
    version: 1,
    jobId,
    canvas,
    jobFolder,
    canvasAfterDigest: adopted.paths[ownedKey('canvas', 'canvas.json')]?.afterDigest || null,
    jobTreeAfterDigest: adoptedJob?.afterDigest || null,
    materializedBundleCandidates: existingCandidates.map(relative => ({
      relative,
      afterDigest: adopted.paths[ownedKey('applied-jobs', relative)]?.afterDigest || null,
    })),
  };
}

function ensureDestinationParent(root, target, label) {
  const parent = path.dirname(target);
  if (!parent.startsWith(`${root}${path.sep}`) && parent !== root) throw new Error(`${label} escaped its restore root.`);
  const relative = path.relative(root, parent);
  let current = root;
  for (const part of relative ? relative.split(path.sep) : []) {
    current = path.join(current, part);
    if (fs.existsSync(current)) assertRegularDirectory(current, `${label} parent`);
    else fs.mkdirSync(current, { mode: 0o700 });
  }
}
function removeOwnedPath(target, label) {
  const stat = lstatIfPresent(target);
  if (!stat) return;
  if (stat.isSymbolicLink()) throw new Error(`${label} is a symbolic link; refusing cleanup.`);
  if (stat.isFile()) fs.unlinkSync(target);
  else if (stat.isDirectory()) removeSafeTree(target, label);
  else throw new Error(`${label} is unsupported; refusing cleanup.`);
}
function restoreOwnedPath({ entry, root, backupRoot, label }) {
  const target = safeChild(root, entry.relative, label);
  const source = safeChild(backupRoot, entry.relative, `${label} backup`);
  const baseline = entry.before;
  if (!baseline.present) {
    // This directory/file was created by this run. Preflight has already
    // proven it still has exactly the recorded test-produced state.
    removeOwnedPath(target, label);
    return;
  }
  ensureDestinationParent(root, target, label);
  if (baseline.type === 'file') {
    assertRegularFile(source, `${label} backup`);
    if (fs.existsSync(target)) assertRegularFile(target, label);
    atomicReplaceBytes(source, target, baseline.mode, baseline.mtimeMs);
    return;
  }
  assertRegularDirectory(source, `${label} backup`);
  if (fs.existsSync(target)) {
    // An existing baseline directory is restored in place. This protects its
    // identity and never deletes a user-owned directory merely to roll back.
    reconcileTreeFromBackup(source, target, baseline.tree, root, label);
    restoreTreeMetadata(target, baseline.tree);
  } else {
    fs.cpSync(source, target, { recursive: true, dereference: false, preserveTimestamps: true, errorOnExist: true });
    restoreTreeMetadata(target, baseline.tree);
  }
}
function ownedRootFor(area, { canvas, canvasRoot, userData }) {
  if (area === 'canvas') return path.dirname(canvas);
  if (area === 'local-ai') return path.join(canvasRoot, '.local-ai');
  if (area === 'applied-jobs') return path.join(canvasRoot, 'Applied Jobs');
  if (area === 'snapshot') return careerSnapshotStorageRoot(userData);
  if (area === 'authority-anchor') return authorityAnchorStorageRoot(userData);
  throw new Error(`Unknown ownership area: ${area}`);
}
function ownedBackupRootFor(area, destination) {
  if (area === 'canvas') return destination;
  if (area === 'local-ai') return path.join(destination, 'local-ai');
  if (area === 'applied-jobs') return path.join(destination, 'Applied Jobs');
  if (area === 'snapshot') return path.join(destination, 'career-snapshot-store');
  if (area === 'authority-anchor') return path.join(destination, 'authority-anchors');
  throw new Error(`Unknown ownership area: ${area}`);
}
function assertOwnedPreflight({ ownership, canvas, canvasRoot, userData }) {
  for (const [key, entry] of Object.entries(ownership.paths)) {
    if (!entry || typeof entry.relative !== 'string' || !entry.after || !entry.before) throw new Error(`Invalid ownership entry ${key}.`);
    const root = ownedRootFor(entry.area, { canvas, canvasRoot, userData });
    const target = safeChild(root, entry.relative, key);
    // Existing roots and every existing parent must be ordinary directories;
    // never follow a symlink while comparing or cleaning a live path.
    const anchor = (entry.area === 'snapshot' || entry.area === 'authority-anchor')
      ? userData : (entry.area === 'canvas' ? path.dirname(canvas) : canvasRoot);
    assertSafeAncestors(anchor, target, key);
    const actual = pathState(target, key);
    try {
      assertPathStateMatches(actual, entry.after, key);
    } catch (error) {
      const pendingJob = entry.area === 'local-ai' && !entry.after.present
        && reservedJobIdentityMatches(target, entry.pendingJob);
      const pendingBundle = entry.area === 'applied-jobs'
        && reservedBundleIdentityMatches(target, entry.pendingBundle, entry.before);
      if (!pendingJob && !pendingBundle) throw error;
    }
    if (entry.source) {
      assertRegularFile(entry.source.path, 'Published snapshot source');
      if (byteRecord(entry.source.path).sha256 !== entry.source.sha256) {
        throw new Error('Published snapshot source SHA-256 differs from the recorded ownership manifest.');
      }
    }
    if (entry.area === 'snapshot') {
      const store = careerSnapshotStorageRoot(userData);
      for (const ancestor of entry.ancestors || []) {
        const targetDirectory = ancestor.relative ? safeChild(store, ancestor.relative, `${key} ancestor`) : store;
        assertDirectoryStateMatches(directoryState(targetDirectory, `${key} ancestor`), ancestor.after, `${key} ancestor`);
      }
    }
    if (entry.area === 'authority-anchor') {
      const anchorRoot = authorityAnchorStorageRoot(userData);
      for (const ancestor of entry.ancestors || []) {
        const targetDirectory = ancestor.relative ? safeChild(anchorRoot, ancestor.relative, `${key} ancestor`) : anchorRoot;
        assertDirectoryStateMatches(directoryState(targetDirectory, `${key} ancestor`), ancestor.after, `${key} ancestor`);
      }
    }
    if (entry.area === 'applied-jobs') {
      const appliedJobs = path.join(canvasRoot, 'Applied Jobs');
      for (const ancestor of entry.ancestors || []) {
        const ancestorPath = rootOrSafeChild(appliedJobs, ancestor.relative, `${key} ancestor`);
        // A pending candidate can legitimately create an ancestor that did
        // not exist at reservation time.  It does not, however, justify
        // overwriting metadata on a directory that predated the run: reject a
        // concurrent chmod before restore can reapply baseline metadata.
        // Once a candidate is claimed, its recorded after-state is complete
        // and every ancestor is checked normally.
        if (!entry.pendingBundle || ancestor.before?.present) {
          assertDirectoryStateMatches(directoryState(ancestorPath, `${key} ancestor`), ancestor.after, `${key} ancestor`);
        }
      }
    }
    if (entry.area === 'local-ai' && entry.localAiSidecar) {
      const localAiRoot = path.join(canvasRoot, '.local-ai');
      for (const ancestor of entry.ancestors || []) {
        assertDirectoryStateMatches(
          directoryState(path.join(localAiRoot, ancestor.relative), `${key} ancestor`),
          ancestor.after,
          `${key} ancestor`,
        );
      }
    }
  }
}

function restoreSnapshotAncestorMetadata(entry, userData) {
  const store = careerSnapshotStorageRoot(userData);
  for (const ancestor of [...(entry.ancestors || [])].reverse()) {
    const target = ancestor.relative ? safeChild(store, ancestor.relative, 'Career snapshot ancestor') : store;
    if (ancestor.before?.present) {
      assertRegularDirectory(target, 'Career snapshot ancestor');
      fs.chmodSync(target, ancestor.before.mode);
      continue;
    }
    // A directory created solely for this snapshot is removed only when it is
    // now empty. A concurrent snapshot or any other child survives intact.
    if (fs.existsSync(target)) {
      assertRegularDirectory(target, 'Career snapshot ancestor');
      if (fs.readdirSync(target).length === 0) fs.rmdirSync(target);
    }
  }
}
function restoreAuthorityAnchorAncestorMetadata(entry, userData) {
  const root = authorityAnchorStorageRoot(userData);
  for (const ancestor of [...(entry.ancestors || [])].reverse()) {
    const target = ancestor.relative ? safeChild(root, ancestor.relative, 'Authority anchor ancestor') : root;
    if (ancestor.before?.present) {
      assertRegularDirectory(target, 'Authority anchor ancestor');
      fs.chmodSync(target, ancestor.before.mode);
      continue;
    }
    // Never remove a concurrent job's anchor (or an app-owned key) merely
    // because this run created the directory. Exact post-rollback tree
    // verification will deliberately report that unresolved concurrent state.
    if (fs.existsSync(target)) {
      assertRegularDirectory(target, 'Authority anchor ancestor');
      if (fs.readdirSync(target).length === 0) fs.rmdirSync(target);
    }
  }
}
function restoreBundleAncestorMetadata(entry, canvasRoot) {
  const appliedJobs = path.join(canvasRoot, 'Applied Jobs');
  for (const ancestor of [...(entry.ancestors || [])].reverse()) {
    const target = rootOrSafeChild(appliedJobs, ancestor.relative, 'Application bundle ancestor');
    if (ancestor.before?.present) {
      assertRegularDirectory(target, 'Application bundle ancestor');
      fs.chmodSync(target, ancestor.before.mode);
      continue;
    }
    if (fs.existsSync(target)) {
      assertRegularDirectory(target, 'Application bundle ancestor');
      if (fs.readdirSync(target).length === 0) fs.rmdirSync(target);
    }
  }
}
function restoreLocalAiSidecarAncestorMetadata(entry, canvasRoot) {
  const localAiRoot = path.join(canvasRoot, '.local-ai');
  for (const ancestor of [...(entry.ancestors || [])].reverse()) {
    const target = safeChild(localAiRoot, ancestor.relative, 'Local-AI sidecar ancestor');
    if (ancestor.before?.present) {
      assertRegularDirectory(target, 'Local-AI sidecar ancestor');
      fs.chmodSync(target, ancestor.before.mode);
      continue;
    }
    // Preserve a concurrent sibling rather than deleting its parent. The
    // whole-tree verification below will name that remaining unowned state
    // instead of reporting a clean rollback.
    if (fs.existsSync(target)) {
      assertRegularDirectory(target, 'Local-AI sidecar ancestor');
      if (fs.readdirSync(target).length === 0) fs.rmdirSync(target);
    }
  }
}
function assertSyncWorkspacePreflight(ownership, userData) {
  const owned = Object.values(ownership.syncWorkspaces || {}).filter(entry => entry?.after);
  if (!owned.length) return null;
  const registry = readSyncRegistry(syncRegistryPath(userData), { allowMissing: false });
  for (const entry of owned) {
    const matches = syncWorkspaceEntries(registry, entry.workspace);
    if (matches.length !== 1 || JSON.stringify(matches[0]) !== JSON.stringify(entry.after)) {
      throw new Error('Application Sync candidate workspace entry differs from its recorded test-owned state.');
    }
  }
  return registry;
}
function planSyncWorkspaceRollback(ownership, userData, destination, baseline, registry, { afterValidationForTest = null } = {}) {
  if (!registry) return;
  const workspaces = [...registry.value.workspaces];
  for (const entry of Object.values(ownership.syncWorkspaces || {}).filter(entry => entry?.after)) {
    const index = workspaces.findIndex(candidate => canonical(candidate.workspaceDir) === canonical(entry.workspace));
    if (index < 0 || JSON.stringify(workspaces[index]) !== JSON.stringify(entry.after)) {
      throw new Error('Application Sync candidate workspace entry changed before rollback.');
    }
    if (entry.before) workspaces[index] = entry.before;
    else workspaces.splice(index, 1);
  }
  const restored = { ...registry, value: { ...registry.value, workspaces } };
  const baselineRecord = baseline.applicationSync || { present: false, mode: 0o600 };
  const baselineFile = path.join(destination, 'application-sync-workspaces.json');
  let useBaselineBytes = false;
  // When this scoped merge exactly reconstructs the baseline, copy the
  // captured bytes rather than serializing an equivalent object.  Besides
  // preserving formatting, this restores the original mode and mtime.  A
  // concurrent unrelated entry necessarily makes the values differ, so it
  // continues through the narrow merge path below and survives cleanup.
  if (baselineRecord.present) {
    const baselineRegistry = readSyncRegistry(baselineFile, { allowMissing: false });
    if (syncRegistryValuesEqual(restored, baselineRegistry)) {
      useBaselineBytes = true;
    }
  }
  if (afterValidationForTest !== null) {
    if (typeof afterValidationForTest !== 'function') throw new TypeError('afterSyncValidationForTest must be a function when supplied.');
    afterValidationForTest({ file: syncRegistryPath(userData), registry: restored });
  }
  // A scoped merge is safe only while its descriptor-bound source is still
  // current. This revalidation happens before *any* owned rollback begins;
  // a concurrent registry writer therefore leaves both its entry and every
  // other acceptance artifact untouched.
  assertSyncRegistrySnapshotUnchanged(syncRegistryPath(userData), registry);
  return { registry, restored, baselineRecord, baselineFile, useBaselineBytes };
}
function commitSyncWorkspaceRollback(plan, userData) {
  if (!plan) return;
  // Recheck immediately before the pathname mutation as well. Node has no
  // conditional rename primitive, but this fail-closed fence covers both the
  // planning window and time spent restoring the independent owned paths.
  assertSyncRegistrySnapshotUnchanged(syncRegistryPath(userData), plan.registry);
  if (plan.useBaselineBytes) {
    atomicReplaceBytes(plan.baselineFile, syncRegistryPath(userData), plan.baselineRecord.mode, plan.baselineRecord.mtimeMs);
    return;
  }
  writeSyncRegistry(syncRegistryPath(userData), plan.restored, plan.baselineRecord);
}

export async function restoreRun({ canvas, userData, destination, keepPublishedSnapshot = false, execute = false, allowNonproduction = false, afterSyncValidationForTest = null }) {
  if (!execute) throw new Error('Refusing restore without --execute.');
  if (!allowNonproduction && (canonical(canvas) !== DEFAULT_CANVAS || canonical(userData) !== DEFAULT_USER_DATA)) throw new Error('Refusing non-production restore target.');
  assertProductionAppStopped(allowNonproduction);
  const baseline = JSON.parse(fs.readFileSync(path.join(destination, 'baseline.json'), 'utf8'));
  if (baseline.canvas.path !== canvas || baseline.userData !== userData) throw new Error('Backup belongs to another canvas or user-data root.');
  const ownership = readOwnership(destination);
  const canvasRoot = fs.realpathSync(path.dirname(canvas));
  // An older in-flight job may no longer pass today's source-manifest
  // validation, so rollback must not depend on inspect. Before the ordinary
  // full-byte ownership preflight, re-attest only a receipt-bound selected
  // card pointer advance and refresh its CAS state. The helper rejects any
  // other canvas mutation and grants nothing when the receipt is ambiguous.
  attestOwnedCanvasPointerProgress({
    canvas,
    destination,
    ownership,
    jobId: ownership.paths[ownedKey('canvas', 'canvas.json')]?.applicationPointer?.jobId || null,
  });
  // A queued job can legitimately advance its own manifest/context before an
  // operator ever runs inspect. Re-attest only that reserved, run-created
  // directory from the selected-card pointer, then retain the ordinary
  // byte/tree preflight for every other owned path.
  reattestRunCreatedLocalAiJobTree({ canvas, canvasRoot, destination, ownership });
  reattestRunOwnedLocalAiSidecars({ canvas, canvasRoot, destination, ownership });
  assertOwnedPreflight({ ownership, canvas, canvasRoot, userData });
  const sync = path.join(userData, 'application-sync-workspaces.json');
  const syncRegistry = assertSyncWorkspacePreflight(ownership, userData);
  if (!syncRegistry) assertOptionalFileMatches(fs.existsSync(sync) ? { present: true, ...byteRecord(sync) } : { present: false }, baseline.applicationSync, 'Application Sync registry');
  const syncRollback = planSyncWorkspaceRollback(
    ownership,
    userData,
    destination,
    baseline,
    syncRegistry,
    { afterValidationForTest: afterSyncValidationForTest },
  );
  for (const entry of Object.values(ownership.paths)) {
    if (keepPublishedSnapshot && entry.area === 'snapshot') continue;
    restoreOwnedPath({
      entry,
      root: ownedRootFor(entry.area, { canvas, canvasRoot, userData }),
      backupRoot: ownedBackupRootFor(entry.area, destination),
      label: `${entry.area}:${entry.relative}`,
    });
    if (entry.area === 'snapshot') restoreSnapshotAncestorMetadata(entry, userData);
    if (entry.area === 'authority-anchor') restoreAuthorityAnchorAncestorMetadata(entry, userData);
    if (entry.area === 'applied-jobs') restoreBundleAncestorMetadata(entry, canvasRoot);
    if (entry.area === 'local-ai' && entry.localAiSidecar) restoreLocalAiSidecarAncestorMetadata(entry, canvasRoot);
  }
  commitSyncWorkspaceRollback(syncRollback, userData);
  const localAi = path.join(canvasRoot, '.local-ai');
  const appliedJobs = path.join(canvasRoot, 'Applied Jobs');
  const snapshotStore = careerSnapshotStorageRoot(userData);
  const authorityAnchors = authorityAnchorStorageRoot(userData);
  const verification = {
    canvas: byteRecord(canvas), localAi: treeManifest(localAi), appliedJobs: treeManifest(appliedJobs),
    careerSnapshotStore: treeManifest(snapshotStore),
    authorityAnchors: treeManifest(authorityAnchors),
    applicationSync: fs.existsSync(sync) ? { present: true, ...byteRecord(sync) } : { present: false },
    owned: {},
  };
  verification.localAiDigest = manifestDigest(verification.localAi);
  verification.appliedJobsDigest = manifestDigest(verification.appliedJobs);
  verification.careerSnapshotStoreDigest = manifestDigest(verification.careerSnapshotStore);
  verification.authorityAnchorsDigest = manifestDigest(verification.authorityAnchors);
  for (const [key, entry] of Object.entries(ownership.paths)) {
    const actual = pathState(safeChild(ownedRootFor(entry.area, { canvas, canvasRoot, userData }), entry.relative, key), key);
    const expected = keepPublishedSnapshot && entry.area === 'snapshot' ? entry.after : entry.before;
    assertPathStateMatches(actual, expected, `${key} after cleanup`);
    verification.owned[key] = { expectedDigest: stateDigest(expected), actualDigest: stateDigest(actual) };
    if (entry.source) {
      assertRegularFile(entry.source.path, 'Published snapshot source');
      const sourceSha256 = byteRecord(entry.source.path).sha256;
      if (sourceSha256 !== entry.source.sha256) throw new Error('Published snapshot source SHA-256 differs from the recorded ownership manifest.');
      verification.owned[key].sourceSha256 = sourceSha256;
    }
  }
  if (!syncRegistry) assertOptionalFileMatches(verification.applicationSync, baseline.applicationSync, 'Application Sync registry');
  if (ownership.paths[ownedKey('canvas', 'canvas.json')]) assertByteRecordMatches(verification.canvas, baseline.canvas, 'Canvas');
  try {
    assertTreeManifestMatches(verification.localAi, baseline.localAi, 'Local-AI tree after cleanup');
  } catch (error) {
    throw new Error(`Local-AI tree still contains unowned or unreverted state after rollback: ${error.message}`);
  }
  try {
    assertTreeManifestMatches(verification.authorityAnchors, baseline.authorityAnchors || { present: false, entries: [] }, 'Authority anchor tree after cleanup');
  } catch (error) {
    throw new Error(`Authority anchor tree still contains unowned or unreverted state after rollback: ${error.message}`);
  }
  return verification;
}

export async function applicationSyncRollbackSelfTest(root) {
  const exercise = async ({ name, baselineRegistryPresent, rejectOverlappingEdit }) => {
    // Application Sync rejects the macOS /var -> /private/var traversal, so
    // keep this isolated fixture under the physical temporary-root spelling.
    const fixtureRoot = path.join(fs.realpathSync(root), name);
    const userData = path.join(fixtureRoot, 'user-data');
    const canvas = path.join(fixtureRoot, 'canvas.json');
    const destination = path.join(fixtureRoot, 'run');
    const job = {
      company: `Sync ${name}`, title: 'Rollback Engineer', location: 'Toronto, ON',
      snippet: 'Exercise exact Application Sync rollback.', url: `https://example.test/${name}`,
      source: 'fixture', posted: 'today', language: 'en',
    };
    const plan = applicationBundleCandidates(job);
    const appliedJobs = path.join(fixtureRoot, 'Applied Jobs');
    const workspace = path.join(appliedJobs, plan.leaves[0]);
    const baselineHtml = '<title>baseline sync workspace</title>';
    const baselineListing = 'baseline sync listing\n';
    fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    fs.writeFileSync(canvas, '{"nodes":[],"edges":[],"drawings":[]}\n', { mode: 0o600 });
    fs.writeFileSync(path.join(workspace, 'Application.html'), baselineHtml, { mode: 0o600 });
    fs.writeFileSync(path.join(workspace, 'Original Job Listing.md'), baselineListing, { mode: 0o600 });
    const baselineWorkspaceIdentity = fs.statSync(workspace);
    patchStubUserData(userData);
    await __resetApplicationSyncWorkspacesForTests();
    const sync = syncRegistryPath(userData);
    const baselineToken = '1'.repeat(64);
    if (baselineRegistryPresent) {
      await registerApplicationSyncWorkspace(workspace, baselineToken);
      // Deliberately retain formatting the production serializer would not
      // recreate.  A clean rollback must copy this captured baseline byte for
      // byte, not merely write an equivalent JSON object.
      const parsed = JSON.parse(fs.readFileSync(sync, 'utf8'));
      fs.writeFileSync(sync, `{\n    "version": ${parsed.version},\n    "workspaces": ${JSON.stringify(parsed.workspaces, null, 4)}\n}\n`, { mode: 0o640 });
      fs.utimesSync(sync, 1_700_000_000.125, 1_700_000_000.125);
    }
    const baselineSync = baselineRegistryPresent ? byteRecord(sync) : { present: false };
    backupRun({ canvas, userData, destination, execute: true, allowNonproduction: true });
    const baseline = JSON.parse(fs.readFileSync(path.join(destination, 'baseline.json'), 'utf8'));
    const ownership = readOwnership(destination);
    reserveApplicationBundleCandidates({ destination, ownership, baseline, appliedJobs, job });
    reserveSyncWorkspaceCandidates({ destination, ownership, baseline, userData, leaves: plan.leaves, appliedJobs });

    // Simulate a save into the pre-existing candidate: its bundle is changed
    // in place and Application Sync rotates its one workspace capability.
    const savedToken = '2'.repeat(64);
    fs.writeFileSync(path.join(workspace, 'Original Job Listing.md'), formatOriginalJobListingMarkdown(job), { mode: 0o600 });
    fs.writeFileSync(path.join(workspace, 'Application.html'), `<script id="ic-application-bundle-data" type="application/json">{"sync":{"endpoint":"http://127.0.0.1:43192/application-sync","version":2,"token":"${savedToken}"}}</script>`, { mode: 0o600 });
    const firstClaim = claimReceiptBundleOwnership({ destination, ownership, appliedJobs, outputDir: workspace });
    // Restore performs a final inspect after an operator inspection. The
    // consumed reservation must therefore remain idempotently claimable only
    // while its exact owned bundle tree is unchanged.
    assert.deepEqual(claimReceiptBundleOwnership({ destination, ownership, appliedJobs, outputDir: workspace }), firstClaim);
    await registerApplicationSyncWorkspace(workspace, savedToken);
    claimSyncWorkspaceOwnership({ destination, ownership, userData, outputDir: workspace });

    // Include a deliberately changed owned canvas.  A registry capability
    // conflict must be rejected before either this or the bundle is restored.
    const canvasRelative = path.basename(canvas);
    const canvasBefore = { present: true, type: 'file', ...byteRecord(canvas) };
    reserveOwnedPath({ destination, ownership, area: 'canvas', relative: canvasRelative, root: fixtureRoot, before: canvasBefore });
    fs.writeFileSync(canvas, '{"nodes":[{"id":"saved"}],"edges":[],"drawings":[]}\n', { mode: 0o600 });
    updateOwnedPath({ destination, ownership, area: 'canvas', relative: canvasRelative, root: fixtureRoot });

    // An unrelated registry capability published after the rollback plan is
    // validated must make cleanup fail before it restores any owned path. The
    // new entry remains on disk; the harness must never replace it from its
    // earlier in-memory registry copy.
    const beforeAfterValidationCanvas = byteRecord(canvas);
    const beforeAfterValidationBundle = pathState(workspace, 'post-validation Application Sync bundle');
    const registryBeforeAfterValidation = fs.readFileSync(sync);
    await assert.rejects(
      () => restoreRun({
        canvas,
        userData,
        destination,
        execute: true,
        allowNonproduction: true,
        afterSyncValidationForTest: () => {
          const changed = JSON.parse(fs.readFileSync(sync, 'utf8'));
          changed.workspaces.push({
            token: '4'.repeat(64),
            workspaceDir: path.join(fixtureRoot, 'concurrent-after-validation'),
            identity: {
              realWorkspaceDir: path.join(fixtureRoot, 'concurrent-after-validation'),
              dev: '1', ino: '2',
            },
          });
          fs.writeFileSync(sync, `${JSON.stringify(changed, null, 2)}\n`, { mode: 0o600 });
        },
      }),
      /Application Sync registry changed after rollback validation/i,
    );
    assertByteRecordMatches(byteRecord(canvas), beforeAfterValidationCanvas, 'Application Sync post-validation conflict canvas');
    assertPathStateMatches(pathState(workspace, 'post-validation Application Sync bundle'), beforeAfterValidationBundle, 'Application Sync post-validation conflict bundle');
    assert.equal(JSON.parse(fs.readFileSync(sync, 'utf8')).workspaces.some(entry => entry.token === '4'.repeat(64)), true, 'post-validation concurrent registry entry must survive the rejected rollback');
    fs.writeFileSync(sync, registryBeforeAfterValidation, { mode: 0o600 });

    if (rejectOverlappingEdit) {
      const afterSaveCanvas = byteRecord(canvas);
      const afterSaveBundle = pathState(workspace, 'saved Application Sync bundle');
      const afterSaveWorkspaceIdentity = fs.statSync(workspace);
      const edited = readSyncRegistry(sync, { allowMissing: false });
      const index = edited.value.workspaces.findIndex(entry => canonical(entry.workspaceDir) === canonical(workspace));
      assert.ok(index >= 0, 'simulated save must have exactly one target Application Sync entry');
      edited.value.workspaces[index] = {
        ...edited.value.workspaces[index], token: '3'.repeat(64),
        identity: { ...edited.value.workspaces[index].identity, ino: '999999' },
      };
      fs.writeFileSync(sync, `${JSON.stringify(edited.value, null, 2)}\n`, { mode: 0o600 });
      await assert.rejects(
        () => restoreRun({ canvas, userData, destination, execute: true, allowNonproduction: true }),
        /candidate workspace entry differs/i,
      );
      assertByteRecordMatches(byteRecord(canvas), afterSaveCanvas, 'Application Sync conflict canvas');
      assertPathStateMatches(pathState(workspace, 'saved Application Sync bundle'), afterSaveBundle, 'Application Sync conflict bundle');
      assert.equal(fs.statSync(workspace).ino, afterSaveWorkspaceIdentity.ino, 'Application Sync conflict must not replace the candidate bundle directory');
      const claimed = readOwnership(destination).syncWorkspaces[plan.leaves[0]].after;
      fs.writeFileSync(sync, `${JSON.stringify({ version: 2, workspaces: [claimed] }, null, 2)}\n`, { mode: 0o600 });
    }

    await restoreRun({ canvas, userData, destination, execute: true, allowNonproduction: true });
    assertByteRecordMatches(byteRecord(canvas), canvasBefore, 'Application Sync restored canvas');
    assert.equal(fs.statSync(workspace).dev, baselineWorkspaceIdentity.dev, 'pre-existing Application Sync bundle must retain its device');
    assert.equal(fs.statSync(workspace).ino, baselineWorkspaceIdentity.ino, 'pre-existing Application Sync bundle must be restored in place');
    assert.equal(fs.readFileSync(path.join(workspace, 'Application.html'), 'utf8'), baselineHtml);
    assert.equal(fs.readFileSync(path.join(workspace, 'Original Job Listing.md'), 'utf8'), baselineListing);
    if (baselineRegistryPresent) {
      assertByteRecordMatches(byteRecord(sync), baselineSync, 'Application Sync clean rollback registry');
      assert.equal(fs.readFileSync(sync).equals(fs.readFileSync(path.join(destination, 'application-sync-workspaces.json'))), true, 'Application Sync clean rollback registry must use the captured baseline bytes');
    } else {
      assert.equal(fs.existsSync(sync), false, 'a first-created empty Application Sync registry must be removed on rollback');
    }
  };

  assert.equal(packagedProductionAppCommandIsRunning('/Users/jack/Desktop/My Apps/infinite-canvas/release/mac-arm64/infinite-canvas.app/Contents/MacOS/infinite-canvas'), true, 'production restore guard must recognize the actual lower-case packaged executable');
  assert.equal(packagedProductionAppCommandIsRunning('/Applications/Infinite Canvas.app/Contents/MacOS/Infinite Canvas'), false, 'production restore guard must not check the obsolete display-name executable');
  await exercise({ name: 'sync-preexisting', baselineRegistryPresent: true, rejectOverlappingEdit: true });
  await exercise({ name: 'sync-first-created', baselineRegistryPresent: false, rejectOverlappingEdit: false });
}

export async function heldAuthorityReceiptRepairSelfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-held-authority-receipt-'));
  try {
    const realRoot = fs.realpathSync(root);
    const userData = path.join(realRoot, 'user-data'); fs.mkdirSync(userData, { mode: 0o700 });
    const canvas = path.join(realRoot, 'canvas.json');
    const jobId = '123e4567-e89b-12d3-a456-426614174000';
    const snapshotId = 'b'.repeat(64);
    const fixture = { nodes: [{ id: 'outer', type: 'group', data: { canvasData: { nodes: [{
      id: TARGETS.snowflake.id, type: 'jobcard', data: {
        company: TARGETS.snowflake.company, title: TARGETS.snowflake.title, snippet: 'Fixture.', location: 'Toronto, ON',
      }, position: { x: 0, y: 0 },
    }] } } }], edges: [], drawings: [] };
    fs.writeFileSync(canvas, JSON.stringify(fixture), { mode: 0o600 });
    const destination = path.join(realRoot, 'repair-run'); fs.mkdirSync(destination, { mode: 0o700 });
    const baselineCanvas = { present: true, type: 'file', ...byteRecord(canvas) };
    fs.copyFileSync(canvas, path.join(destination, 'canvas.json'), fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(path.join(destination, 'baseline.json'), `${JSON.stringify({
      version: 3, canvas: { path: canvas, ...byteRecord(canvas) }, userData,
    }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    const jobFolder = path.join(realRoot, '.local-ai', 'jobs', jobId);
    const context = path.join(jobFolder, 'context'); fs.mkdirSync(context, { recursive: true, mode: 0o700 });
    const manifest = { id: jobId, canvasFilePath: canvas, canvasRoot: realRoot, status: 'queued', paste: { stage: 'review' } };
    const input = { jobId, canvasFilePath: canvas, canvasRoot: realRoot };
    fs.writeFileSync(path.join(jobFolder, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
    fs.writeFileSync(path.join(jobFolder, 'input.json'), JSON.stringify(input), { mode: 0o600 });
    const store = await createAuthorityLedgerStore(context, { namespace: APPLICATION_AUTHORITY_STORE_NAMESPACE, genesis: { fixture: true } });
    await store.appendReceiptPage('listing', [{ id: 'listing-000000000001', text: 'fixture' }], { holdJournal: true });
    const current = jsonClone(fixture);
    const card = findTargetNode(current, TARGETS.snowflake);
    card.data.careerSnapshotId = snapshotId;
    card.data.localApplication = { id: jobId, canvasFilePath: canvas, folder: jobFolder };
    await saveCanvasAtomic(canvas, current);
    const currentCanvas = { present: true, type: 'file', ...byteRecord(canvas) };
    const jobRelative = path.join('jobs', jobId);
    const jobAfter = pathState(jobFolder, 'Held authority receipt fixture job');
    const ownership = {
      version: 1, createdAt: new Date().toISOString(), paths: {
        [ownedKey('canvas', 'canvas.json')]: {
          area: 'canvas', relative: 'canvas.json', before: baselineCanvas, after: currentCanvas,
          beforeDigest: stateDigest(baselineCanvas), afterDigest: stateDigest(currentCanvas),
          applicationPointer: { card: TARGETS.snowflake, snapshotId, jobId },
        },
        [ownedKey('local-ai', jobRelative)]: {
          area: 'local-ai', relative: jobRelative, before: { present: false }, after: jobAfter,
          beforeDigest: stateDigest({ present: false }), afterDigest: stateDigest(jobAfter),
        },
      },
    };
    writeOwnership(destination, ownership);
    const manifestPath = path.join(jobFolder, 'manifest.json');
    const beforeBytes = fs.readFileSync(manifestPath);
    await assert.rejects(
      () => repairHeldAuthorityReceipt({ canvas, userData, destination, jobId, allowNonproduction: true }),
      /without --execute/i,
    );
    assert.equal(fs.readFileSync(manifestPath).equals(beforeBytes), true, 'missing --execute must not touch the manifest');
    const alreadyPublished = jsonClone(manifest); alreadyPublished.paste.authorityStore = { invalid: true };
    fs.writeFileSync(manifestPath, JSON.stringify(alreadyPublished), { mode: 0o600 });
    await assert.rejects(
      () => repairHeldAuthorityReceipt({ canvas, userData, destination, jobId, execute: true, allowNonproduction: true }),
      /un-published queued review manifest/i,
    );
    assert.equal(fs.existsSync(path.join(destination, `authority-receipt-${jobId}.manifest.before.json`)), false, 'rejected receipt publication must not create a backup');
    fs.writeFileSync(manifestPath, beforeBytes, { mode: 0o600 });
    const result = await repairHeldAuthorityReceipt({ canvas, userData, destination, jobId, execute: true, allowNonproduction: true });
    const backup = path.join(destination, `authority-receipt-${jobId}.manifest.before.json`);
    assert.equal(fs.readFileSync(backup).equals(beforeBytes), true, 'repair backup must retain the exact manifest preimage');
    const expected = jsonClone(manifest); expected.paste.authorityStore = result.authorityStore;
    assert.deepEqual(regularJson(manifestPath, 'Repaired fixture manifest'), expected, 'repair must add only the compact authority receipt');
    assert.equal(fs.existsSync(path.join(context, `${APPLICATION_AUTHORITY_STORE_NAMESPACE}.journal.json`)), true, 'repair must leave the held journal for the application');
    assert.deepEqual(readOwnership(destination).paths[ownedKey('local-ai', jobRelative)].after, pathState(jobFolder, 'Repaired fixture job'), 'repair must refresh only the run-owned job tree state');
    return { ok: true, jobId };
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

async function selfTest() {
  await heldAuthorityReceiptRepairSelfTest();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-acceptance-harness-'));
  const userData = path.join(root, 'user-data'); fs.mkdirSync(userData);
  const canvas = path.join(root, 'canvas.json');
  const fixture = { nodes: [{ id: 'outer', type: 'group', data: { canvasData: { nodes: [{
    id: TARGETS.snowflake.id, type: 'jobcard', data: {
      company: TARGETS.snowflake.company, title: TARGETS.snowflake.title, snippet: 'Build reliable systems.', location: 'Toronto, ON',
      url: 'https://example.test/jobs/1', source: 'fixture', posted: 'today', language: 'en',
    }, position: { x: 0, y: 0 },
  }] } } }], edges: [], drawings: [] };
  fs.writeFileSync(canvas, JSON.stringify(fixture), { mode: 0o600 });
  // The direct-only reservation must not become a global "next queue id": a
  // normal queue invocation (the route used by renderer IPC) cannot consume
  // it, while an exact opaque capability consumes it even if queue validation
  // then fails before writing anything.
  const nonInterceptableReservation = __reserveNextLocalApplicationJobIdForAcceptanceHarness(crypto.randomUUID());
  await assert.rejects(() => queueLocalApplicationJob({ canvasFilePath: path.join(root, 'not-a-canvas.json'), transport: 'paste' }));
  assert.throws(() => __reserveNextLocalApplicationJobIdForAcceptanceHarness(crypto.randomUUID()), /already reserved/i);
  await assert.rejects(() => queueLocalApplicationJob({
    canvasFilePath: path.join(root, 'not-a-canvas.json'), transport: 'paste',
    __acceptanceHarnessReservationCapability: nonInterceptableReservation.capability,
  }));
  const consumedReservation = __reserveNextLocalApplicationJobIdForAcceptanceHarness(crypto.randomUUID());
  await assert.rejects(() => queueLocalApplicationJob({
    canvasFilePath: path.join(root, 'not-a-canvas.json'), transport: 'paste',
    __acceptanceHarnessReservationCapability: consumedReservation.capability,
  }));
  const localFixtureDirectory = path.join(root, '.local-ai', 'restricted', 'nested');
  fs.mkdirSync(localFixtureDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(root, '.local-ai'), 0o700);
  fs.chmodSync(path.join(root, '.local-ai', 'restricted'), 0o710);
  fs.chmodSync(localFixtureDirectory, 0o750);
  const localFixtureFile = path.join(localFixtureDirectory, 'baseline.txt');
  fs.writeFileSync(localFixtureFile, 'private baseline\n', { mode: 0o640 });
  const fractionalMtimeMs = 1_700_000_000_000.625;
  fs.utimesSync(localFixtureFile, fractionalMtimeMs / 1_000, fractionalMtimeMs / 1_000);
  const appliedFixtureDirectory = path.join(root, 'Applied Jobs', 'restricted');
  fs.mkdirSync(appliedFixtureDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(root, 'Applied Jobs'), 0o700);
  fs.chmodSync(appliedFixtureDirectory, 0o750);
  const appliedFixtureFile = path.join(appliedFixtureDirectory, 'baseline.txt');
  fs.writeFileSync(appliedFixtureFile, 'application baseline\n', { mode: 0o600 });
  fs.utimesSync(appliedFixtureFile, fractionalMtimeMs / 1_000, fractionalMtimeMs / 1_000);
  const existingJob = path.join(root, '.local-ai', 'jobs', 'preexisting-job');
  const affirmFixtureJob = {
    title: TARGETS.affirm.title, company: TARGETS.affirm.company, location: 'Toronto, ON',
    snippet: 'Build reliable identity systems.', url: 'https://example.test/jobs/affirm', source: 'fixture', posted: 'today', language: 'en',
  };
  const affirmPlan = applicationBundleCandidates(affirmFixtureJob);
  const existingBundle = path.join(root, 'Applied Jobs', affirmPlan.leaves[0]);
  fs.mkdirSync(existingJob, { recursive: true, mode: 0o700 });
  fs.mkdirSync(existingBundle, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(existingJob, 'manifest.json'), '{"baseline":true}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(existingBundle, 'Application.html'), '<title>existing baseline</title>', { mode: 0o600 });
  fs.writeFileSync(path.join(existingBundle, 'Original Job Listing.md'), 'baseline affirm listing\n', { mode: 0o600 });
  // Application Sync intentionally refuses paths which merely traverse the
  // macOS /var -> /private/var alias, so use the physical temporary root for
  // this capability fixture while the rest of the filesystem fixture can use
  // the convenient mkdtemp spelling.
  const syncWorkspace = path.join(fs.realpathSync(root), 'Applied Jobs', 'Acme', 'Software Engineer');
  fs.mkdirSync(syncWorkspace, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(syncWorkspace, 'Application.html'), '<!doctype html><title>baseline</title>', { mode: 0o600 });
  const syncToken = 'a'.repeat(64);
  const source = path.join(root, 'Work Experience.md');
  const text = 'Ada Lovelace\nada@example.test\nSoftware Engineer at Acme\nJanuary 2020 to Present\nBuilt Python service used by 50 users.\n';
  fs.writeFileSync(source, text);
  const corpus = buildCareerSourceCorpus([{ name: 'Work Experience.md', text, legacyText: text, contentHash: sha256(text), transcriptionAudit: verbatimCareerTranscriptionAuditReceipt() }]);
  const evidence = corpus.segments.map(segment => segment.id);
  const profile = { identity: { name: 'Ada Lovelace', contacts: ['ada@example.test'], evidenceSegmentIds: evidence }, roles: [{ id: 'role-acme', title: 'Software Engineer', employer: 'Acme', startDate: 'January 2020', endDate: 'Present', location: '', achievementIds: ['achievement-service'], skillIds: ['skill-python'], evidenceSegmentIds: evidence }], achievements: [{ id: 'achievement-service', roleId: 'role-acme', claim: 'Built Python service used by 50 users.', technologies: ['Python'], technologyReferences: [{ technology: 'Python', disposition: 'skill', relationship: 'independent', relationshipGroup: '', relationshipEvidence: 'Python', evidenceSegmentIds: evidence }], metrics: [{ label: 'users', value: '50', unit: 'users', evidenceSegmentIds: evidence }], evidenceSegmentIds: evidence }], projects: [], skills: [{ id: 'skill-python', name: 'Python', category: 'language', capabilityKind: 'language', supportMode: 'direct', directEvidenceSegmentIds: evidence, indexEligible: true, roleIds: ['role-acme'], evidenceSegmentIds: evidence }], education: [], certifications: [], otherEvidence: [], segmentCoverage: corpus.segments.map(segment => ({ segmentId: segment.id, disposition: 'achievement', entityIds: ['identity', 'role-acme', 'achievement-service', 'skill-python'] })) };
  // Exercise the current production compiler rather than constructing an
  // envelope by hand. Page-plan/reconciliation/current audit receipts evolve
  // with the immutable snapshot contract, so a hand-built v4-style fixture
  // stopped proving that this harness can publish a currently approved pin.
  const pageProfile = {
    ...structuredClone(profile),
    rolePatches: [],
    projectPatches: [],
    continuationState: {
      roles: { mode: 'clear', ids: [] },
      projects: { mode: 'clear', ids: [] },
    },
  };
  const compiled = await compileAuditedCareerSnapshot({
    sourceFiles: [{
      name: 'Work Experience.md', text, legacyText: text, contentHash: sha256(text),
      transcriptionAudit: verbatimCareerTranscriptionAuditReceipt(),
    }],
    // This is a deterministic stand-in for only the AI boundary: the
    // production compiler still pages, validates, reconciles, and seals every
    // audit receipt before the harness writes anything.
    callText: async (_prompt, { task } = {}) => {
      if (task === 'career-profile-compile') return pageProfile;
      if (typeof task === 'string' && task.startsWith('career-profile-audit-')) return { findings: [] };
      throw new Error(`Unexpected self-test career task: ${String(task)}`);
    },
    workerCount: 1,
    now: () => '2026-01-01T00:00:00.000Z',
  });
  const snapshot = compiled.snapshot;
  const snapshotFile = path.join(root, 'approved.json'); fs.writeFileSync(snapshotFile, JSON.stringify(snapshot));
  const destination = path.join(root, 'run');
  let completed = false;
  try {
    patchStubUserData(userData);
    await __resetApplicationSyncWorkspacesForTests();
    await registerApplicationSyncWorkspace(syncWorkspace, syncToken);
    backupRun({ canvas, userData, destination, execute: true, allowNonproduction: true });
    await publishSnapshot({ snapshotFile, snapshotId: snapshot.snapshotId, userData, destination, execute: true, allowNonproduction: true });
    const baselineWorkspaceIdentity = fs.statSync(syncWorkspace);
    const queued = await pinAndQueue({ canvas, userData, destination, cardName: 'snowflake', requestedSnapshotId: snapshot.snapshotId, execute: true, allowNonproduction: true });
    assert.equal(queued.localJob.mode, 'paste');
    assert.equal(fs.existsSync(path.join(queued.localJob.folder, 'manifest.json')), true);
    const queuedPhaseStamp = path.join(root, '.local-ai', 'phase-stamps', `${queued.localJob.id}.json`);
    assert.equal(fs.existsSync(queuedPhaseStamp), true, 'queue must materialize its deterministic phase stamp inside the reserved sidecar path');
    const queuedHandoffReceipt = path.join(root, '.local-ai', 'handoff-receipts', `${queued.localJob.id}.json`);
    fs.mkdirSync(path.dirname(queuedHandoffReceipt), { recursive: true, mode: 0o700 });
    fs.writeFileSync(queuedHandoffReceipt, JSON.stringify({ jobId: queued.localJob.id, canvasFilePath: canvas }), { mode: 0o600 });
    updateLocalAiJobSidecarOwnership({
      destination, ownership: readOwnership(destination), localAiRoot: path.join(root, '.local-ai'), canvas, jobId: queued.localJob.id,
    });
    assert.equal(fs.existsSync(queuedHandoffReceipt), true, 'the reserved terminal handoff receipt path must accept a matching job/canvas sidecar');
    const queuedAuthorityAnchor = path.join(authorityAnchorStorageRoot(userData), `${queued.localJob.id}.json`);
    assert.equal(fs.existsSync(queuedAuthorityAnchor), true, 'queue must materialize its job-keyed authority anchor inside the reserved host sidecar path');
    const report = await inspectJob({ canvas, userData, destination, jobId: queued.localJob.id });
    assert.equal(report.status.status, 'queued');
    // The app can advance only the selected card's pointer while the worker is
    // active. Simulate that durable progress, including the pre-fix manifest
    // shape with no explicit pointer reservation, then prove inspect adopts
    // only the queue-digest-bound reservation. A concurrent canvas edit must
    // still fail before it can update the restore CAS state.
    const legacyOwnership = readOwnership(destination);
    delete legacyOwnership.paths[ownedKey('canvas', 'canvas.json')].applicationPointer;
    writeOwnership(destination, legacyOwnership);
    const progressedCanvas = loadCanvas(canvas);
    const progressedCard = findTargetNode(progressedCanvas, TARGETS.snowflake);
    progressedCard.data.localApplication = {
      ...progressedCard.data.localApplication,
      stage: 'resume', revision: 7, message: 'Paste-back application handoff is ready for resume.',
    };
    // Opening a live card selects it, and its changed handoff banner can make
    // React Flow persist a fresh renderer measurement. Neither is card
    // content or a user-arranged position.
    progressedCard.selected = true;
    progressedCard.measured = { width: 280, height: 438 };
    await saveCanvasAtomic(canvas, progressedCanvas);
    const concurrentCanvas = loadCanvas(canvas);
    concurrentCanvas.nodes[0].data.concurrentAcceptanceMutation = true;
    await saveCanvasAtomic(canvas, concurrentCanvas);
    await assert.rejects(
      () => inspectJob({ canvas, userData, destination, jobId: queued.localJob.id }),
      /Canvas changed outside this run's reserved card pointer/i,
    );
    const repairedCanvas = loadCanvas(canvas);
    delete repairedCanvas.nodes[0].data.concurrentAcceptanceMutation;
    await saveCanvasAtomic(canvas, repairedCanvas);
    const malformedMeasurementCanvas = loadCanvas(canvas);
    findTargetNode(malformedMeasurementCanvas, TARGETS.snowflake).measured.unexpected = true;
    await saveCanvasAtomic(canvas, malformedMeasurementCanvas);
    await assert.rejects(
      () => inspectJob({ canvas, userData, destination, jobId: queued.localJob.id }),
      /Selected card has an invalid presentation measurement state/i,
    );
    const validMeasurementCanvas = loadCanvas(canvas);
    delete findTargetNode(validMeasurementCanvas, TARGETS.snowflake).measured.unexpected;
    await saveCanvasAtomic(canvas, validMeasurementCanvas);
    await inspectJob({ canvas, userData, destination, jobId: queued.localJob.id });
    const attestedCanvas = readOwnership(destination).paths[ownedKey('canvas', 'canvas.json')];
    assert.equal(attestedCanvas.applicationPointer.jobId, queued.localJob.id);
    assert.equal(attestedCanvas.after.sha256, byteRecord(canvas).sha256, 'inspect must refresh the canvas CAS after app-owned pointer progress');
    // Simulate the production save's final registration without reading a
    // bundle back through the harness: only a pre-reserved candidate whose
    // HTML capability and directory identity match the registry is claimed.
    const syncCandidate = path.join(fs.realpathSync(root), 'Applied Jobs', queued.bundleCandidates[0]);
    const savedSyncToken = 'b'.repeat(64);
    const queuedInput = regularJson(path.join(queued.localJob.folder, 'input.json'), 'queued input');
    fs.mkdirSync(syncCandidate, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(syncCandidate, 'Original Job Listing.md'), formatOriginalJobListingMarkdown(queuedInput.job), { mode: 0o600 });
    fs.writeFileSync(path.join(syncCandidate, 'Application.html'), `<script id="ic-application-bundle-data" type="application/json">{"sync":{"endpoint":"http://127.0.0.1:43192/application-sync","version":2,"token":"${savedSyncToken}"}}</script>`, { mode: 0o600 });
    await registerApplicationSyncWorkspace(syncCandidate, savedSyncToken);
    claimSyncWorkspaceOwnership({ destination, ownership: readOwnership(destination), userData, outputDir: syncCandidate });
    const concurrentWorkspace = path.join(fs.realpathSync(root), 'Applied Jobs', 'Concurrent Sync');
    fs.mkdirSync(concurrentWorkspace, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(concurrentWorkspace, 'Application.html'), '<main>concurrent</main>', { mode: 0o600 });
    await registerApplicationSyncWorkspace(concurrentWorkspace, 'c'.repeat(64));
    // Reserve two baseline directories before the simulated test writes them.
    // Restore must repair each in place rather than deleting the directory a
    // user already owned before the acceptance run began.
    const ownership = readOwnership(destination);
    const crashJobId = crypto.randomUUID();
    const crashJobRelative = path.join('jobs', crashJobId);
    const crashJobRoot = path.join(root, '.local-ai');
    const crashReservation = reserveOwnedPath({
      destination, ownership, area: 'local-ai', relative: crashJobRelative, root: crashJobRoot,
      before: manifestPathState(JSON.parse(fs.readFileSync(path.join(destination, 'baseline.json'))).localAi, crashJobRelative),
    });
    crashReservation.pendingJob = { jobId: crashJobId, canvas };
    writeOwnership(destination, ownership);
    const crashJobDir = path.join(crashJobRoot, crashJobRelative);
    fs.mkdirSync(crashJobDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(crashJobDir, 'manifest.json'), JSON.stringify({ id: crashJobId, canvasFilePath: canvas }), { mode: 0o600 });
    fs.writeFileSync(path.join(crashJobDir, 'input.json'), JSON.stringify({ jobId: crashJobId, canvasFilePath: canvas }), { mode: 0o600 });
    const unreservedReceiptDir = path.join(root, 'Applied Jobs', 'Unreserved Receipt', 'Toronto', 'Role');
    fs.mkdirSync(unreservedReceiptDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(unreservedReceiptDir, 'Original Job Listing.md'), 'not this job\n', { mode: 0o600 });
    await assert.rejects(async () => claimReceiptBundleOwnership({
      destination, ownership, appliedJobs: path.join(root, 'Applied Jobs'), outputDir: unreservedReceiptDir,
    }), /pre-reserved application bundle candidate/i);
    const existingJobRelative = path.join('jobs', 'preexisting-job');
    const existingBundleRelative = affirmPlan.leaves[0];
    reserveOwnedPath({
      destination, ownership, area: 'local-ai', relative: existingJobRelative, root: path.join(root, '.local-ai'),
      before: manifestPathState(JSON.parse(fs.readFileSync(path.join(destination, 'baseline.json'))).localAi, existingJobRelative),
    });
    reserveApplicationBundleCandidates({
      destination, ownership, baseline: JSON.parse(fs.readFileSync(path.join(destination, 'baseline.json'))),
      appliedJobs: path.join(root, 'Applied Jobs'), job: affirmFixtureJob,
    });
    const existingJobIdentity = fs.statSync(existingJob);
    const existingBundleIdentity = fs.statSync(existingBundle);
    fs.writeFileSync(path.join(existingJob, 'manifest.json'), '{"mutated":true}\n', { mode: 0o644 });
    fs.writeFileSync(path.join(existingBundle, 'Application.html'), '<title>mutated</title>', { mode: 0o644 });
    fs.writeFileSync(path.join(existingBundle, 'Original Job Listing.md'), formatOriginalJobListingMarkdown(affirmFixtureJob), { mode: 0o644 });
    updateOwnedPath({ destination, ownership, area: 'local-ai', relative: existingJobRelative, root: path.join(root, '.local-ai') });
    // Leave the existing Affirm-like replacement in its pending state: a
    // crash before inspect still proves cleanup accepts only its frozen
    // listing identity and restores the pre-existing directory in place.
    // These are unrelated concurrent additions. They must survive because
    // cleanup owns only the queued job/canvas/snapshot paths, never either
    // whole live root.
    const unrelatedLocal = path.join(root, '.local-ai', 'concurrent-note.txt');
    const unrelatedAuthorityAnchor = path.join(authorityAnchorStorageRoot(userData), 'concurrent-anchor.json');
    const unrelatedBundle = path.join(root, 'Applied Jobs', 'Concurrent', 'Keep Me');
    const affirmConcurrentSibling = path.join(path.dirname(existingBundle), 'Concurrent Sibling');
    const anthropicFixtureJob = {
      title: TARGETS.anthropic.title, company: TARGETS.anthropic.company, location: 'Toronto, ON',
      snippet: 'Build safe computer-use systems.', url: 'https://example.test/jobs/anthropic', source: 'fixture', posted: 'today', language: 'en',
    };
    const anthropicPlan = reserveApplicationBundleCandidates({
      destination, ownership, baseline: JSON.parse(fs.readFileSync(path.join(destination, 'baseline.json'))),
      appliedJobs: path.join(root, 'Applied Jobs'), job: anthropicFixtureJob,
    });
    const anthropicBundle = path.join(root, 'Applied Jobs', anthropicPlan.leaves[0]);
    fs.mkdirSync(anthropicBundle, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(anthropicBundle, 'Original Job Listing.md'), formatOriginalJobListingMarkdown(anthropicFixtureJob), { mode: 0o600 });
    fs.writeFileSync(path.join(anthropicBundle, 'Application.html'), '<title>new anthropic-like bundle</title>', { mode: 0o600 });
    fs.writeFileSync(unrelatedLocal, 'leave me alone\n', { mode: 0o600 });
    fs.writeFileSync(unrelatedAuthorityAnchor, JSON.stringify({ jobId: 'concurrent' }), { mode: 0o600 });
    fs.mkdirSync(unrelatedBundle, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(unrelatedBundle, 'Application.html'), '<title>concurrent</title>', { mode: 0o600 });
    fs.mkdirSync(affirmConcurrentSibling, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(affirmConcurrentSibling, 'Application.html'), '<title>affirm sibling</title>', { mode: 0o600 });
    // A pending candidate means a newly-created ancestor can be absent at
    // reservation time, but it must never waive the metadata fence for this
    // pre-existing company/location namespace.  Refuse before an in-place
    // restore could overwrite a concurrent chmod or any sibling content.
    const affirmNamespace = path.dirname(existingBundle);
    const affirmNamespaceMode = fs.statSync(affirmNamespace).mode & 0o777;
    assert.equal(reservedBundleIdentityMatches(
      existingBundle,
      ownership.paths[ownedKey('applied-jobs', existingBundleRelative)].pendingBundle,
      ownership.paths[ownedKey('applied-jobs', existingBundleRelative)].before,
    ), true, 'the crash-window baseline bundle must retain its frozen-listing identity');
    fs.chmodSync(affirmNamespace, affirmNamespaceMode ^ 0o040);
    const canvasBeforeAncestorConflict = byteRecord(canvas).sha256;
    await assert.rejects(() => restoreRun({ canvas, userData, destination, execute: true, allowNonproduction: true }), /directory mode differs/i);
    assert.equal(byteRecord(canvas).sha256, canvasBeforeAncestorConflict, 'ancestor metadata conflict must fail before any owned path is restored');
    fs.chmodSync(affirmNamespace, affirmNamespaceMode);
    await assert.rejects(
      () => restoreRun({ canvas, userData, destination, execute: true, allowNonproduction: true }),
      /Local-AI tree still contains unowned or unreverted state after rollback/i,
    );
    const baseline = JSON.parse(fs.readFileSync(path.join(destination, 'baseline.json')));
    assert.equal(byteRecord(canvas).sha256, baseline.canvas.sha256);
    assert.equal(fs.existsSync(path.join(queued.localJob.folder)), false, 'owned job directory must be removed in the same cleanup cycle');
    assert.equal(fs.existsSync(queuedPhaseStamp), false, 'reserved phase stamp must be removed with its run-owned job');
    assert.equal(fs.existsSync(path.join(root, '.local-ai', 'phase-stamps')), false, 'a run-created empty phase-stamp directory must be pruned');
    assert.equal(fs.existsSync(queuedHandoffReceipt), false, 'reserved terminal handoff receipt must be removed with its run-owned job');
    assert.equal(fs.existsSync(path.dirname(queuedHandoffReceipt)), false, 'a run-created empty handoff-receipt directory must be pruned');
    assert.equal(fs.existsSync(queuedAuthorityAnchor), false, 'reserved authority anchor must be removed with its run-owned job');
    assert.equal(fs.readFileSync(unrelatedAuthorityAnchor, 'utf8'), '{"jobId":"concurrent"}', 'an unrelated concurrent authority anchor must survive the scoped rollback');
    assert.equal(fs.existsSync(crashJobDir), false, 'a crash-window reserved job must be removed only after its id/canvas identity validates');
    assert.equal(fs.existsSync(anthropicBundle), false, 'a pending Anthropic-like test bundle must be removed immediately after identity validation');
    assert.equal(fs.existsSync(path.join(root, 'Applied Jobs', anthropicPlan.company)), false, 'test-created company/location ancestors must not remain empty');
    assert.equal(fs.readFileSync(path.join(existingJob, 'manifest.json'), 'utf8'), '{"baseline":true}\n');
    assert.equal(fs.readFileSync(path.join(existingBundle, 'Application.html'), 'utf8'), '<title>existing baseline</title>');
    assert.equal(fs.readFileSync(path.join(existingBundle, 'Original Job Listing.md'), 'utf8'), 'baseline affirm listing\n');
    assert.equal(fs.statSync(existingJob).ino, existingJobIdentity.ino, 'pre-existing job directory must be restored in place');
    assert.equal(fs.statSync(existingBundle).ino, existingBundleIdentity.ino, 'pre-existing bundle directory must be restored in place');
    assert.equal(fs.readFileSync(unrelatedLocal, 'utf8'), 'leave me alone\n');
    assert.equal(fs.readFileSync(path.join(unrelatedBundle, 'Application.html'), 'utf8'), '<title>concurrent</title>');
    assert.equal(fs.readFileSync(path.join(affirmConcurrentSibling, 'Application.html'), 'utf8'), '<title>affirm sibling</title>');
    assert.equal(fs.existsSync(unreservedReceiptDir), true, 'inspect must never claim or delete an arbitrary receipt path');
    assert.equal(fs.existsSync(path.join(careerSnapshotStorageRoot(userData), 'career-snapshots', `${snapshot.snapshotId}.json`)), false, 'default cleanup must restore the snapshot store exactly');
    const restoredWorkspaceIdentity = fs.statSync(syncWorkspace);
    assert.equal(restoredWorkspaceIdentity.dev, baselineWorkspaceIdentity.dev, 'in-place Applied Jobs restore must preserve workspace device');
    assert.equal(restoredWorkspaceIdentity.ino, baselineWorkspaceIdentity.ino, 'in-place Applied Jobs restore must preserve workspace inode');
    const restoredSync = JSON.parse(fs.readFileSync(path.join(userData, 'application-sync-workspaces.json'), 'utf8'));
    assert.deepEqual(restoredSync.workspaces.map(entry => [entry.token, entry.workspaceDir]), [[syncToken, syncWorkspace], ['c'.repeat(64), concurrentWorkspace]], 'restore must remove only its saved candidate capability and preserve concurrent registry entries');
    assert.deepEqual(restoredSync.workspaces[0].identity, {
      realWorkspaceDir: fs.realpathSync(syncWorkspace),
      dev: String(restoredWorkspaceIdentity.dev),
      ino: String(restoredWorkspaceIdentity.ino),
    }, 'saved registry identity must exactly describe the preserved workspace');

    // Restore, not inspect, must be able to adopt an old queue receipt. This
    // models a job created before current source validation rules existed.
    // Prove the direct path still rejects an unrelated canvas edit before it
    // records the allowed pointer advance or touches any owned target.
    const directRestoreDestination = path.join(root, 'direct-pointer-restore-run');
    backupRun({ canvas, userData, destination: directRestoreDestination, execute: true, allowNonproduction: true });
    await publishSnapshot({ snapshotFile, snapshotId: snapshot.snapshotId, userData, destination: directRestoreDestination, execute: true, allowNonproduction: true });
    const directQueued = await pinAndQueue({
      canvas, userData, destination: directRestoreDestination, cardName: 'snowflake',
      requestedSnapshotId: snapshot.snapshotId, execute: true, allowNonproduction: true,
    });
    const directLegacyOwnership = readOwnership(directRestoreDestination);
    delete directLegacyOwnership.paths[ownedKey('canvas', 'canvas.json')].applicationPointer;
    writeOwnership(directRestoreDestination, directLegacyOwnership);
    // The job tree itself may advance before any inspect invocation. This
    // stays identity-preserving but intentionally differs from queue-time
    // ownership so restore must perform the narrow re-attestation below.
    const directManifestPath = path.join(directQueued.localJob.folder, 'manifest.json');
    const directManifest = regularJson(directManifestPath, 'Direct restore fixture manifest');
    directManifest.restorationFixtureAdvance = { stage: 'review', revision: 12 };
    fs.writeFileSync(directManifestPath, JSON.stringify(directManifest), { mode: 0o600 });
    const directProgressedCanvas = loadCanvas(canvas);
    const directProgressedCard = findTargetNode(directProgressedCanvas, TARGETS.snowflake);
    directProgressedCard.data.localApplication = {
      ...directProgressedCard.data.localApplication,
      stage: 'resume', revision: 12, message: 'Older in-flight handoff progressed without a fresh inspect.',
    };
    await saveCanvasAtomic(canvas, directProgressedCanvas);
    const directConcurrentCanvas = loadCanvas(canvas);
    directConcurrentCanvas.nodes[0].data.directRestoreConcurrentEdit = true;
    await saveCanvasAtomic(canvas, directConcurrentCanvas);
    await assert.rejects(
      () => restoreRun({ canvas, userData, destination: directRestoreDestination, execute: true, allowNonproduction: true }),
      /Canvas changed outside this run's reserved card pointer/i,
    );
    const directRepairedCanvas = loadCanvas(canvas);
    delete directRepairedCanvas.nodes[0].data.directRestoreConcurrentEdit;
    await saveCanvasAtomic(canvas, directRepairedCanvas);
    await restoreRun({ canvas, userData, destination: directRestoreDestination, execute: true, allowNonproduction: true });
    const directRestoredBaseline = JSON.parse(fs.readFileSync(path.join(directRestoreDestination, 'baseline.json'), 'utf8'));
    assert.equal(byteRecord(canvas).sha256, directRestoredBaseline.canvas.sha256, 'restore must directly roll back a receipt-bound pointer advance');
    const directAttestedOwnership = readOwnership(directRestoreDestination).paths[ownedKey('canvas', 'canvas.json')];
    assert.equal(directAttestedOwnership.applicationPointer.jobId, directQueued.localJob.id, 'restore must adopt the exact job id from its queue receipt');
    assert.equal(fs.existsSync(directQueued.localJob.folder), false, 'direct pointer restore must remove only the receipt-bound job folder');

    // A corrupt authority store can make normal status inspection impossible,
    // but it must not make cleanup depend on parsing that store. Prove the
    // narrow recovery path accepts only the frozen manifest/input identity,
    // hashes the exact reserved tree and one pre-reserved partial bundle into
    // CAS, and then lets the ordinary restore remove those owned paths.
    const corruptDestination = path.join(root, 'corrupt-job-restore-run');
    backupRun({ canvas, userData, destination: corruptDestination, execute: true, allowNonproduction: true });
    await publishSnapshot({ snapshotFile, snapshotId: snapshot.snapshotId, userData, destination: corruptDestination, execute: true, allowNonproduction: true });
    const corruptQueued = await pinAndQueue({
      canvas, userData, destination: corruptDestination, cardName: 'snowflake',
      requestedSnapshotId: snapshot.snapshotId, execute: true, allowNonproduction: true,
    });
    const corruptInputPath = path.join(corruptQueued.localJob.folder, 'input.json');
    const corruptInputBytes = fs.readFileSync(corruptInputPath);
    const corruptInput = regularJson(corruptInputPath, 'Corrupt recovery fixture input');
    const corruptMarker = path.join(corruptQueued.localJob.folder, 'context', 'deliberately-corrupt-ledger-fragment.json');
    fs.writeFileSync(corruptMarker, '{"missingPage":"index-requirements-audit-000000000000-000000000001.json"}\n', { mode: 0o600 });
    const partialBundle = path.join(root, 'Applied Jobs', corruptQueued.bundleCandidates[0]);
    fs.mkdirSync(partialBundle, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(partialBundle, 'Original Job Listing.md'), formatOriginalJobListingMarkdown(corruptInput.job), { mode: 0o600 });
    corruptInput.jobId = crypto.randomUUID();
    fs.writeFileSync(corruptInputPath, JSON.stringify(corruptInput), { mode: 0o600 });
    assert.throws(
      () => adoptReservedCorruptJobStateForRestore({
        canvas, userData, destination: corruptDestination, jobId: corruptQueued.localJob.id,
        bundleCandidates: corruptQueued.bundleCandidates,
      }),
      /manifest\/input identity/i,
      'corruption-safe adoption must reject a mismatched frozen input identity before granting cleanup authority',
    );
    fs.writeFileSync(corruptInputPath, corruptInputBytes, { mode: 0o600 });
    assert.throws(
      () => adoptReservedCorruptJobStateForRestore({
        canvas, userData, destination: corruptDestination, jobId: corruptQueued.localJob.id,
        bundleCandidates: [...corruptQueued.bundleCandidates, 'Unreserved/Arbitrary/Path'],
      }),
      /candidate list does not match/i,
      'corruption-safe adoption must reject any bundle path outside the frozen reservation set',
    );
    // existsSync reports a dangling symlink as absent. It must never turn an
    // unmaterialized candidate into an apparently clean absent path: cleanup
    // must fail closed rather than leave a hostile filesystem entry behind.
    assert.ok(corruptQueued.bundleCandidates.length > 1, 'fixture requires a second reserved candidate for dangling-link coverage');
    const danglingReservedBundle = path.join(root, 'Applied Jobs', corruptQueued.bundleCandidates[1]);
    fs.symlinkSync(path.join(root, 'missing-reserved-bundle-target'), danglingReservedBundle);
    assert.throws(
      () => adoptReservedCorruptJobStateForRestore({
        canvas, userData, destination: corruptDestination, jobId: corruptQueued.localJob.id,
        bundleCandidates: corruptQueued.bundleCandidates,
      }),
      /symbolic link/i,
      'corruption-safe adoption must reject a dangling symlink at an unmaterialized reserved candidate',
    );
    fs.unlinkSync(danglingReservedBundle);
    const corruptAdoption = adoptReservedCorruptJobStateForRestore({
      canvas, userData, destination: corruptDestination, jobId: corruptQueued.localJob.id,
      bundleCandidates: corruptQueued.bundleCandidates,
    });
    assert.match(corruptAdoption.jobTreeAfterDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual(corruptAdoption.materializedBundleCandidates.map(entry => entry.relative), [corruptQueued.bundleCandidates[0]]);
    assert.match(corruptAdoption.materializedBundleCandidates[0].afterDigest, /^[a-f0-9]{64}$/);
    await restoreRun({ canvas, userData, destination: corruptDestination, execute: true, allowNonproduction: true });
    assert.equal(fs.existsSync(corruptQueued.localJob.folder), false, 'corruption-safe restore must remove only the exact reserved job tree');
    assert.equal(fs.existsSync(partialBundle), false, 'corruption-safe restore must remove the exact pre-reserved partial bundle');

    // A malformed identity must remain fail-closed: the narrow refresh never
    // turns a run-created path into authority for an arbitrary job folder.
    const mismatchDestination = path.join(root, 'mismatch-job-restore-run');
    backupRun({ canvas, userData, destination: mismatchDestination, execute: true, allowNonproduction: true });
    await publishSnapshot({ snapshotFile, snapshotId: snapshot.snapshotId, userData, destination: mismatchDestination, execute: true, allowNonproduction: true });
    const mismatchQueued = await pinAndQueue({
      canvas, userData, destination: mismatchDestination, cardName: 'snowflake',
      requestedSnapshotId: snapshot.snapshotId, execute: true, allowNonproduction: true,
    });
    const mismatchInputPath = path.join(mismatchQueued.localJob.folder, 'input.json');
    const mismatchInputBytes = fs.readFileSync(mismatchInputPath);
    const mismatchInput = regularJson(mismatchInputPath, 'Mismatch fixture input');
    mismatchInput.jobId = crypto.randomUUID();
    fs.writeFileSync(mismatchInputPath, JSON.stringify(mismatchInput), { mode: 0o600 });
    const canvasBeforeIdentityFailure = byteRecord(canvas).sha256;
    await assert.rejects(
      () => restoreRun({ canvas, userData, destination: mismatchDestination, execute: true, allowNonproduction: true }),
      /no longer matches its reserved job\/canvas identity/i,
    );
    assert.equal(byteRecord(canvas).sha256, canvasBeforeIdentityFailure, 'identity failure must occur before any restore mutation');
    fs.writeFileSync(mismatchInputPath, mismatchInputBytes, { mode: 0o600 });
    await restoreRun({ canvas, userData, destination: mismatchDestination, execute: true, allowNonproduction: true });
    assert.equal(fs.existsSync(mismatchQueued.localJob.folder), false, 'a repaired matching run-created job must still clean up normally');

    // A first save is allowed to materialize the output root.  That root is
    // still test-created state, not a blanket cleanup target: with no
    // concurrent child it is pruned back to the genuinely absent baseline.
    const absentOutputRoot = path.join(root, 'absent-output-root');
    fs.mkdirSync(absentOutputRoot, { mode: 0o700 });
    const absentOutputCanvas = path.join(absentOutputRoot, 'canvas.json');
    fs.writeFileSync(absentOutputCanvas, JSON.stringify({ nodes: [], edges: [], drawings: [] }), { mode: 0o600 });
    const absentOutputDestination = path.join(root, 'absent-output-run');
    backupRun({ canvas: absentOutputCanvas, userData, destination: absentOutputDestination, execute: true, allowNonproduction: true });
    const absentOutputBaseline = JSON.parse(fs.readFileSync(path.join(absentOutputDestination, 'baseline.json'), 'utf8'));
    const absentOutputOwnership = readOwnership(absentOutputDestination);
    const absentOutputPlan = reserveApplicationBundleCandidates({
      destination: absentOutputDestination,
      ownership: absentOutputOwnership,
      baseline: absentOutputBaseline,
      appliedJobs: path.join(absentOutputRoot, 'Applied Jobs'),
      job: anthropicFixtureJob,
    });
    const absentOutputBundle = path.join(absentOutputRoot, 'Applied Jobs', absentOutputPlan.leaves[0]);
    fs.mkdirSync(absentOutputBundle, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(absentOutputBundle, 'Original Job Listing.md'), formatOriginalJobListingMarkdown(anthropicFixtureJob), { mode: 0o600 });
    await restoreRun({ canvas: absentOutputCanvas, userData, destination: absentOutputDestination, execute: true, allowNonproduction: true });
    assert.equal(fs.existsSync(path.join(absentOutputRoot, 'Applied Jobs')), false, 'an empty test-created Applied Jobs root must be pruned back to its absent baseline');

    const keepDestination = path.join(root, 'keep-run');
    backupRun({ canvas, userData, destination: keepDestination, execute: true, allowNonproduction: true });
    await publishSnapshot({ snapshotFile, snapshotId: snapshot.snapshotId, userData, destination: keepDestination, execute: true, allowNonproduction: true });
    await restoreRun({ canvas, userData, destination: keepDestination, keepPublishedSnapshot: true, execute: true, allowNonproduction: true });
    assert.equal(fs.existsSync(path.join(careerSnapshotStorageRoot(userData), 'career-snapshots', `${snapshot.snapshotId}.json`)), true, 'keep mode must retain only the ownership-recorded approved snapshot');
    await restoreRun({ canvas, userData, destination: keepDestination, execute: true, allowNonproduction: true });
    assert.equal(fs.existsSync(careerSnapshotStorageRoot(userData)), false, 'a later default cleanup must still restore the original empty snapshot store');

    // A second isolated ownership cycle proves an edit inside an owned target
    // is rejected before the canvas can be restored or any cleanup can delete.
    const conflictDestination = path.join(root, 'conflict-run');
    backupRun({ canvas, userData, destination: conflictDestination, execute: true, allowNonproduction: true });
    await publishSnapshot({ snapshotFile, snapshotId: snapshot.snapshotId, userData, destination: conflictDestination, execute: true, allowNonproduction: true });
    const conflictQueued = await pinAndQueue({ canvas, userData, destination: conflictDestination, cardName: 'snowflake', requestedSnapshotId: snapshot.snapshotId, execute: true, allowNonproduction: true });
    fs.writeFileSync(path.join(conflictQueued.localJob.folder, 'manifest.json'), '{"concurrent":true}\n');
    const canvasBeforeRejectedCleanup = byteRecord(canvas).sha256;
    await assert.rejects(() => restoreRun({ canvas, userData, destination: conflictDestination, execute: true, allowNonproduction: true }), /differs from baseline|expected test-owned state|no longer matches its reserved job\/canvas identity/i);
    assert.equal(byteRecord(canvas).sha256, canvasBeforeRejectedCleanup, 'preflight failure must not partially restore canvas');
    const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
    fs.unlinkSync(path.join(conflictQueued.localJob.folder, 'manifest.json'));
    fs.symlinkSync(outside, path.join(conflictQueued.localJob.folder, 'manifest.json'));
    await assert.rejects(() => restoreRun({ canvas, userData, destination: conflictDestination, execute: true, allowNonproduction: true }), /symbolic link|no longer matches its reserved job\/canvas identity/i);
    await applicationSyncRollbackSelfTest(root);
    completed = true;
    return { ok: true, jobId: queued.localJob.id };
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
    catch (cleanupError) {
      // Preserve the earlier assertion/production failure rather than masking
      // it with a best-effort temporary-fixture cleanup error.
      if (completed) throw cleanupError;
    }
  }
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === '--help' || command === 'help') { process.stdout.write(usage()); return; }
  if (command === 'career-import-fixture') {
    const result = createCareerImportFixture({
      sourceCanvas: options['source-canvas'] || DEFAULT_CANVAS,
      careerFile: options['career-file'] || DEFAULT_CAREER_IMPORT_SOURCE,
      output: options.output,
      includeDocument: options['include-document'] === true,
      connectedBoard: options['connected-board'] === true,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === 'career-import-fixture-self-test') {
    process.stdout.write(`${JSON.stringify(careerImportFixtureSelfTest(), null, 2)}\n`);
    return;
  }
  if (command === 'self-test') { process.stdout.write(`${JSON.stringify(await selfTest(), null, 2)}\n`); return; }
  if (!['publish-snapshot', 'backup', 'pin-and-queue', 'repair-held-authority-receipt', 'inspect', 'restore'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const target = assertLiveTarget(options, { mutate: MUTATING_COMMANDS.has(command) });
  const destination = runDirectory(options);
  let result;
  if (command === 'publish-snapshot') result = await publishSnapshot({ snapshotFile: options.snapshot, snapshotId: required(options, 'snapshot-id'), userData: target.userData, destination, execute: options.execute });
  if (command === 'backup') result = backupRun({ canvas: target.canvas, userData: target.userData, destination, execute: options.execute });
  if (command === 'pin-and-queue') result = await pinAndQueue({ canvas: target.canvas, userData: target.userData, destination, cardName: required(options, 'card'), requestedSnapshotId: required(options, 'snapshot-id'), execute: options.execute });
  if (command === 'repair-held-authority-receipt') result = await repairHeldAuthorityReceipt({ canvas: target.canvas, userData: target.userData, destination, jobId: required(options, 'job-id'), execute: options.execute });
  if (command === 'inspect') result = await inspectJob({ canvas: target.canvas, userData: target.userData, destination, jobId: required(options, 'job-id') });
  if (command === 'restore') result = await restoreRun({ canvas: target.canvas, userData: target.userData, destination, keepPublishedSnapshot: options['keep-published-snapshot'] === true, execute: options.execute });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

// This file is also a deliberately small library for more tightly-scoped,
// disposable acceptance fixtures.  Do not run its CLI while it is imported:
// callers use the exported guarded operations and retain ownership of their
// own isolated roots.
if (process.argv[1] && canonical(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`Application acceptance harness: ${error?.message || error}\n`); process.exitCode = 1; });
}
