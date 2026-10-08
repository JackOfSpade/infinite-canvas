#!/usr/bin/env node
/*
 * Disposable, one-card, real-queue acceptance fixture.
 *
 * This is intentionally an orchestrator, not another queue implementation.
 * It delegates pinned-snapshot validation, paste-job creation, bundle-candidate
 * reservation, receipt inspection, and rollback to
 * application-acceptance-harness.mjs's production-export driver.  Its only
 * source read is the exact saved card in the production canvas.  Every write
 * is confined to a brand-new run directory below this artifact directory.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  adoptReservedCorruptJobStateForRestore,
  backupRun,
  inspectJob,
  pinAndQueue,
  projectSavedJobCardForAcceptanceHarness,
  restoreRun,
} from './application-acceptance-harness.mjs';
import {
  CAREER_SNAPSHOT_COMPILATION_CONTRACT,
  careerSnapshotPath,
  careerSnapshotStorageRoot,
} from '../../electron/ipc/careerSnapshot.js';
import {
  captureRegularFileSnapshot,
  currentCareerSourceIdentityFromFile as currentCareerSourceIdentity,
  snapshotByteRecord as byteRecordFromSnapshot,
  resolveCurrentApprovedCareerSnapshot,
  runCurrentSnapshotResolutionSelfTest,
} from '../../scripts/acceptance/currentCareerSnapshotResolver.mjs';
import { deferOwnedBridgeLaneCleanup } from '../../scripts/acceptance/bridgeLaneCleanup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNS_ROOT = path.join(HERE, 'live-one-card');
const PRODUCTION_CANVAS = '/Users/jack/Desktop/Job Search/canvas.json';
const PRODUCTION_USER_DATA = '/Users/jack/Library/Application Support/infinite-canvas';
const WORK_EXPERIENCE = '/Users/jack/Desktop/Job Search/Work Experience.md';
const PACKAGED_APP = path.join(HERE, '..', '..', 'release', 'mac-arm64', 'infinite-canvas.app', 'Contents', 'MacOS', 'infinite-canvas');
const RUN_MANIFEST = 'one-card-live-acceptance.json';
const SHA256_RE = /^[a-f0-9]{64}$/;
const CARDS = Object.freeze({
  anthropic: {
    id: 'board-1c3589c5-0bbd-4552-a031-8a0836776b33-1791309926380-job-9',
    company: 'Anthropic', title: 'Product Engineer, Computer Use',
  },
  affirm: {
    id: 'board-1c3589c5-0bbd-4552-a031-8a0836776b33-1791309926380-job-13',
    company: 'Affirm', title: 'Software Engineer II, Backend (Identity Decisioning)',
  },
});

function usage() {
  return `
Usage (from the repository root):
  node --import ./scripts/test-stubs/register.mjs \\
    .test-artifacts/blackbox-run/one-card-live-acceptance.mjs prepare \\
    --run-id NAME --card anthropic|affirm --execute

  node --import ./scripts/test-stubs/register.mjs \\
    .test-artifacts/blackbox-run/one-card-live-acceptance.mjs inspect --run-id NAME

  node --import ./scripts/test-stubs/register.mjs \\
    .test-artifacts/blackbox-run/one-card-live-acceptance.mjs launch --run-id NAME --execute

  node --import ./scripts/test-stubs/register.mjs \\
    .test-artifacts/blackbox-run/one-card-live-acceptance.mjs restore --run-id NAME [--preserve-changed-protected-state] --execute

  node --import ./scripts/test-stubs/register.mjs \\
    .test-artifacts/blackbox-run/one-card-live-acceptance.mjs restore-corrupt --run-id NAME [--preserve-changed-protected-state] --execute

  node --import ./scripts/test-stubs/register.mjs \\
    .test-artifacts/blackbox-run/one-card-live-acceptance.mjs recover --run-id NAME [--preserve-changed-protected-state] --execute

  node --import ./scripts/test-stubs/register.mjs \\
    .test-artifacts/blackbox-run/one-card-live-acceptance.mjs self-test

Safety contract:
  - prepare reads ${PRODUCTION_CANVAS}, ${WORK_EXPERIENCE}, and the already
    present approved snapshot in production user-data; it never republishes it;
  - it writes only a new ${RUNS_ROOT}/NAME directory;
  - the queued production paste job has that isolated canvasFilePath/root;
  - the job uses production user-data so the existing bridge/OAuth/plugin
    setup is available, while all job and bundle paths remain isolated;
  - launch starts the packaged app with its default production user-data and
    the isolated JSON canvas; Chromium caches are intentionally unowned;
  - restore requires every owned digest to match and never copies secrets;
  - restore-corrupt is only for a stopped run whose owned authority store no
    longer parses: it attests the exact manifest/input/card reservation,
    adopts only that pre-reserved job tree and bundle candidate set into CAS,
    then invokes the same ordinary restore;
  - --preserve-changed-protected-state is an explicit cleanup-only override:
    it never writes bridge config/tunnel files, but snapshots their current
    bytes and rejects a concurrent change before fixture finalization.
`;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (key === 'execute' || key === 'preserve-changed-protected-state') options[key] = true;
    else {
      const value = rest[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
      options[key] = value;
    }
  }
  return { command, options };
}

function canonical(value) { return path.resolve(String(value || '')).normalize('NFC'); }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function runId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(id)) throw new Error('--run-id must contain only letters, digits, dot, underscore, or hyphen.');
  return id;
}
function required(options, key) {
  if (!options[key]) throw new Error(`--${key} is required.`);
  return options[key];
}
function assertRegularFile(file, label) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-link file.`);
  return stat;
}
function assertRegularDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-link directory.`);
  return stat;
}
function lstatIfPresent(target) {
  try { return fs.lstatSync(target); }
  catch (error) {
    // existsSync treats a dangling symlink as absent. That is never a safe
    // bridge-state absence: fail closed rather than following or preserving
    // an unsafe entry during cleanup.
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}
function isBelow(root, target, { allowRoot = false } = {}) {
  const relative = path.relative(root, target);
  return (allowRoot && !relative) || Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function safeChild(root, relative, label) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new Error(`Unsafe ${label}.`);
  const target = path.resolve(root, relative);
  if (!isBelow(root, target)) throw new Error(`Unsafe ${label}.`);
  return target;
}
function byteRecord(file) {
  const bytes = fs.readFileSync(file);
  const stat = fs.statSync(file);
  return Object.freeze({ bytes: bytes.length, sha256: sha256(bytes), mode: stat.mode & 0o777, mtimeMs: stat.mtimeMs });
}
const regularFileSnapshot = captureRegularFileSnapshot;
function bridgeFileState(userData, relative, label) {
  const userDataRoot = canonical(userData);
  assertRegularDirectory(userDataRoot, 'Bridge user-data root');
  const realUserDataRoot = fs.realpathSync(userDataRoot);
  const file = safeChild(userDataRoot, path.join('handoff-bridge', relative), label);
  const parent = path.dirname(file);
  const parentRelative = path.relative(userDataRoot, parent);
  let current = userDataRoot;
  for (const part of parentRelative ? parentRelative.split(path.sep) : []) {
    current = path.join(current, part);
    const stat = lstatIfPresent(current);
    if (!stat) return Object.freeze({ present: false, file, userDataRoot, realUserDataRoot });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} parent must be a regular non-link directory.`);
    const realCurrent = fs.realpathSync(current);
    if (!isBelow(realUserDataRoot, realCurrent, { allowRoot: true })) {
      throw new Error(`${label} parent escaped the trusted bridge root.`);
    }
  }
  const stat = lstatIfPresent(file);
  if (!stat) return Object.freeze({ present: false, file, userDataRoot, realUserDataRoot });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-link file.`);
  const realFile = fs.realpathSync(file);
  if (!isBelow(realUserDataRoot, realFile)) throw new Error(`${label} escaped the trusted bridge root.`);
  return Object.freeze({ present: true, file, userDataRoot, realUserDataRoot, snapshot: regularFileSnapshot(file, label) });
}
function treeRecord(root) {
  if (!lstatIfPresent(root)) return { present: false, entries: [] };
  assertRegularDirectory(root, 'Bridge state root');
  const entries = [];
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(current, entry.name); const relative = path.relative(root, target); const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) throw new Error(`Bridge state contains a symbolic link: ${target}`);
      if (stat.isDirectory()) { entries.push({ path: relative, type: 'dir', mode: stat.mode & 0o777 }); walk(target); }
      else if (stat.isFile()) entries.push({ path: relative, type: 'file', ...byteRecord(target) });
      else throw new Error(`Bridge state contains an unsupported entry: ${target}`);
    }
  };
  walk(root); return { present: true, rootMode: fs.statSync(root).mode & 0o777, entries };
}
function sameTreeRecord(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function protectedBridgeState(userData = PRODUCTION_USER_DATA) {
  // oauth-state.json is intentionally excluded: authenticated connector use
  // persists clients/codes/refresh/access records there. Its structure is
  // checked separately, never reverted or byte-compared.
  const files = ['config.json', 'tunnel/config.yml', 'tunnel/tunnel.json'];
  return Object.fromEntries(files.map(relative => {
    const state = bridgeFileState(userData, relative, `Protected bridge state ${relative}`);
    if (!state.present) return [relative, { present: false }];
    return [relative, { present: true, ...byteRecordFromSnapshot(state.snapshot) }];
  }));
}
function assertProtectedBridgeState(expected, userData = PRODUCTION_USER_DATA) {
  const currentState = protectedBridgeState(userData);
  for (const [relative, before] of Object.entries(expected || {})) {
    const current = currentState[relative] || { present: false };
    if (Boolean(current.present) !== Boolean(before.present) || (before.present && (current.bytes !== before.bytes || current.sha256 !== before.sha256 || current.mode !== before.mode))) {
      throw new Error(`Protected bridge state changed: ${relative}. Refusing to overwrite bridge config or tunnel selection.`);
    }
  }
}
function protectedBridgeStateForCleanup(expected, { preserveChangedProtectedState = false, userData = PRODUCTION_USER_DATA } = {}) {
  if (!preserveChangedProtectedState) {
    assertProtectedBridgeState(expected, userData);
    return expected;
  }
  // This opt-in grants no write authority over bridge state. It merely changes
  // the CAS record used after owned rollback, so a user-selected config/tunnel
  // change survives while a concurrent change still fails closed.
  return protectedBridgeState(userData);
}
function assertOAuthStateStructure(userData = PRODUCTION_USER_DATA) {
  const state = bridgeFileState(userData, 'oauth-state.json', 'OAuth state');
  if (!state.present) return;
  const { file } = state;
  const stat = assertRegularFile(file, 'OAuth state');
  if (stat.size > 4 * 1024 * 1024) throw new Error('OAuth state exceeds its bounded envelope.');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value?.v !== 1 || !['clients', 'codes', 'families', 'refresh', 'access'].every(key => Array.isArray(value?.[key]))) {
    throw new Error('OAuth state is malformed; refusing to treat a session mutation as trusted.');
  }
}
function deferBridgeLaneCleanup(jobId, canvas) {
  // Restore runs only after the packaged app exits. A new Node process cannot
  // join the bridge runtime's in-memory serialization, and Node has no safe
  // conditional rename rooted at a held directory descriptor. Never turn a
  // test cleanup into a pathname rewrite of live bridge state.
  return deferOwnedBridgeLaneCleanup({ jobId, canvasFilePath: canonical(canvas) });
}
function assertByteRecord(actual, expected, label) {
  for (const key of ['bytes', 'sha256', 'mode']) {
    if (actual?.[key] !== expected?.[key]) throw new Error(`${label} ${key} drifted.`);
  }
  if (!Number.isFinite(actual?.mtimeMs) || !Number.isFinite(expected?.mtimeMs) || Math.abs(actual.mtimeMs - expected.mtimeMs) > 1) {
    throw new Error(`${label} mtime drifted.`);
  }
  // Legacy rollback baselines predate ctime recording, so accept their shape
  // for cleanup. Fresh resolver attestations include ctime and must bind it
  // exactly: a writer can restore mtime after an in-place mutation.
  if (Object.hasOwn(expected || {}, 'ctimeMs')
    && (!Number.isFinite(actual?.ctimeMs) || actual.ctimeMs !== expected.ctimeMs)) {
    throw new Error(`${label} ctime drifted.`);
  }
}
function assertSafeTree(root, label) {
  if (!fs.existsSync(root)) return;
  assertRegularDirectory(root, label);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`${label} contains a symbolic link: ${target}`);
    if (stat.isDirectory()) assertSafeTree(target, label);
    else if (!stat.isFile()) throw new Error(`${label} contains an unsupported entry: ${target}`);
  }
}
function removeOwnedTree(target, root, label) {
  if (!isBelow(root, target)) throw new Error(`Refusing to remove ${label} outside its run root.`);
  if (!lstatIfPresent(target)) return;
  assertSafeTree(target, label);
  fs.rmSync(target, { recursive: true, force: false });
}
function removeFixtureLocalAiScaffold(paths, baseline, { afterValidationForTest = null } = {}) {
  const fixtureLocalAi = safeChild(paths.root, '.local-ai', 'owned fixture Local-AI root');
  const fixtureJobs = safeChild(fixtureLocalAi, 'jobs', 'owned fixture Local-AI jobs root');
  const expected = baseline?.localAi;
  // `prepare` establishes exactly this empty scaffold before backup. Do not
  // treat a generic run-root subtree as disposable after restore: it may have
  // gained a job from another process between rollback verification and this
  // wrapper's final fixture cleanup.
  if (!expected?.present || !Array.isArray(expected.entries)
    || expected.entries.length !== 1 || expected.entries[0]?.path !== 'jobs'
    || expected.entries[0]?.type !== 'dir') {
    throw new Error('Fixture Local-AI baseline is not the exact empty jobs scaffold.');
  }
  const assertExactScaffold = () => {
    const rootStat = lstatIfPresent(fixtureLocalAi);
    if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error('Owned fixture Local-AI root is missing, non-directory, or symbolic link.');
    }
    const jobsStat = lstatIfPresent(fixtureJobs);
    if (!jobsStat || !jobsStat.isDirectory() || jobsStat.isSymbolicLink()) {
      throw new Error('Owned fixture Local-AI jobs root is missing, non-directory, or symbolic link.');
    }
    if (!sameTreeRecord(treeRecord(fixtureLocalAi), expected)) {
      throw new Error('Owned fixture Local-AI tree changed after rollback verification.');
    }
    if (fs.readdirSync(fixtureJobs).length !== 0) {
      throw new Error('Owned fixture Local-AI jobs root is no longer empty.');
    }
  };
  assertExactScaffold();
  if (afterValidationForTest !== null) {
    if (typeof afterValidationForTest !== 'function') throw new TypeError('afterValidationForTest must be a function when supplied.');
    afterValidationForTest({ fixtureLocalAi, fixtureJobs });
  }
  // Re-attest immediately before mutation. Use non-recursive rmdir calls so
  // even a late file cannot be swept up if the final pathname race is lost.
  assertExactScaffold();
  try {
    fs.rmdirSync(fixtureJobs);
    fs.rmdirSync(fixtureLocalAi);
  } catch (error) {
    throw new Error(`Owned fixture Local-AI scaffold changed during cleanup: ${error?.message || error}`);
  }
  if (lstatIfPresent(fixtureLocalAi)) {
    throw new Error('Owned fixture Local-AI scaffold survived cleanup.');
  }
}
function writeJsonNew(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}
function writeJsonReplace(file, value) {
  const parent = path.dirname(file);
  assertRegularDirectory(parent, 'Run manifest parent');
  const temporary = path.join(parent, `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function ensureRunsRoot() {
  const parent = path.dirname(RUNS_ROOT);
  assertRegularDirectory(parent, 'Blackbox artifact root');
  if (fs.existsSync(RUNS_ROOT)) assertRegularDirectory(RUNS_ROOT, 'One-card run root');
  else fs.mkdirSync(RUNS_ROOT, { mode: 0o700 });
  return fs.realpathSync(RUNS_ROOT);
}
function runDirectory(id) { return safeChild(ensureRunsRoot(), runId(id), 'run directory'); }
function runPaths(id) {
  const root = runDirectory(id);
  return Object.freeze({
    root,
    canvas: safeChild(root, 'canvas.json', 'fixture canvas'),
    rollback: safeChild(root, 'rollback', 'rollback directory'),
    manifest: safeChild(root, RUN_MANIFEST, 'run manifest'),
  });
}
function walkNodes(nodes, visit) {
  for (const node of nodes || []) {
    visit(node);
    if (Array.isArray(node?.data?.canvasData?.nodes)) walkNodes(node.data.canvasData.nodes, visit);
  }
}
function extractTargetCard(canvas, card) {
  let match = null;
  walkNodes(canvas?.nodes, node => {
    if (node?.id !== card.id) return;
    if (match) throw new Error(`Duplicate target card ${card.id}.`);
    if (node.type !== 'jobcard' || node?.data?.company !== card.company || node?.data?.title !== card.title) {
      throw new Error(`Target ${card.id} does not match the expected ${card.company} / ${card.title}.`);
    }
    match = node;
  });
  if (!match) throw new Error(`Target card ${card.id} is absent from the production canvas.`);
  // JSON cloning proves the source node is data-only and ensures no reference
  // can survive into the isolated fixture.
  return JSON.parse(JSON.stringify(match));
}

// These checks deliberately validate the *test inputs*, not the application
// generator.  The live fixture deep-clones each saved card without changing
// its data, so a title-only or accidentally duplicated saved card would
// otherwise turn an apparently two-listing black-box exercise into a weak,
// misleading test. Keep this content-agnostic: it must not encode facts about
// a particular employer, role, or candidate.
export function rawSavedListingText(card) {
  const text = card?.data?.snippet;
  if (typeof text !== 'string') throw new Error(`Target ${card?.id || 'card'} has no textual job listing.`);
  return text;
}

// This is deliberately presentation-only. It lets the anti-overfitting guard
// compare semantic listing vocabulary across ordinary layout differences; it
// is not the byte/character representation frozen into input.json.
export function normalizedListingTextForAcceptance(card) {
  const text = rawSavedListingText(card);
  const normalized = text.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (normalized.length < 1_500) {
    throw new Error(`Target ${card.id} has only ${normalized.length} listing characters; choose a saved listing with a complete description.`);
  }
  return normalized;
}

// The production queue owns safety normalization through safeJob(). The
// acceptance harness must compare that exact queue-safe projection to the raw
// selected-card body, then compare every projected field with input.json.
// Never substitute normalizedListingTextForAcceptance here: it intentionally
// erases layout whitespace for anti-overfitting only.
export function assertFrozenQueuedJobMatchesSavedCard(card, queuedInput) {
  const rawListing = rawSavedListingText(card);
  const expectedQueuedJob = projectSavedJobCardForAcceptanceHarness(card?.data);
  if (expectedQueuedJob.snippet !== rawListing) {
    throw new Error('Queue-safe projection did not preserve the exact selected saved job listing text.');
  }
  if (JSON.stringify(queuedInput?.job) !== JSON.stringify(expectedQueuedJob)) {
    throw new Error('Production queue did not preserve the exact selected saved job listing in its frozen input.');
  }
  return expectedQueuedJob;
}

function listingVocabulary(text) {
  // Terms rather than raw characters make this robust to formatting and
  // boilerplate.  The minimum token length excludes punctuation fragments and
  // the most common glue words without requiring an employer-specific list.
  return new Set((text.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}/gu) || []));
}
function assertMeaningfullyDifferentSavedListings(canvas) {
  const selected = Object.values(CARDS).map(card => ({ card, node: extractTargetCard(canvas, card) }));
  for (const { node } of selected) normalizedListingTextForAcceptance(node);
  for (let left = 0; left < selected.length; left += 1) {
    for (let right = left + 1; right < selected.length; right += 1) {
      const first = selected[left]; const second = selected[right];
      const firstText = normalizedListingTextForAcceptance(first.node); const secondText = normalizedListingTextForAcceptance(second.node);
      if (firstText === secondText) {
        throw new Error(`Saved listings ${first.card.id} and ${second.card.id} have identical descriptions; select materially different listings for black-box acceptance.`);
      }
      const firstTerms = listingVocabulary(firstText); const secondTerms = listingVocabulary(secondText);
      const shared = [...firstTerms].filter(term => secondTerms.has(term)).length;
      const union = new Set([...firstTerms, ...secondTerms]).size;
      // A 0.75 unique-term overlap permits normal engineering vocabulary and
      // shared legal/benefits copy, while rejecting effectively duplicate
      // listings under two card identities.
      if (!union || shared / union >= 0.75) {
        throw new Error(`Saved listings ${first.card.id} and ${second.card.id} are too similar for an anti-overfitting acceptance cycle.`);
      }
    }
  }
  return selected;
}
function isSha256(value) { return typeof value === 'string' && SHA256_RE.test(value); }

// This identity is deliberately reconstructed from the human-owned file, not
// discovered by picking the newest item in career-snapshots.  The compiler's
// lookup key is known before any AI work: ordered source name/content hashes
// plus the *currently loaded* compilation contract.  Thus a schema/prompt
// revision naturally selects its new immutable address, while old pins never
// become a fallback candidate for a fresh application run.

async function attestCurrentPinnedSnapshot() {
  assertRegularDirectory(PRODUCTION_USER_DATA, 'Production Electron user-data');
  const source = currentCareerSourceIdentity(WORK_EXPERIENCE);
  const attestation = await resolveCurrentApprovedCareerSnapshot({
    storageRoot: careerSnapshotStorageRoot(PRODUCTION_USER_DATA), sourceIdentity: source,
  });
  return Object.freeze({ workExperience: source.file, ...attestation });
}

function validSnapshotAttestation(value) {
  const base = Boolean(value && isSha256(value.id) && isSha256(value.workExperienceSha256)
    && canonical(value.productionPath) === careerSnapshotPath(careerSnapshotStorageRoot(PRODUCTION_USER_DATA), value.id)
    && Number.isFinite(value.bytes) && value.bytes > 0 && isSha256(value.sha256)
    && Number.isFinite(value.mode) && Number.isFinite(value.mtimeMs));
  if (!base) return false;
  const currentFields = ['workExperienceName', 'inputFingerprint', 'sourceFingerprint', 'compilationContract', 'sourceCount'];
  const hasCurrentFields = currentFields.every(key => Object.hasOwn(value, key));
  if (!hasCurrentFields) {
    // A run prepared by the preceding harness version may still need its
    // *cleanup*. Its run-owned job/input/receipt checks below bind the pinned
    // ID again, and this narrow shape cannot be used to prepare a new run.
    // Retaining it avoids stranding a disposable historical run after a
    // compiler upgrade while never weakening fresh-source selection.
    return Object.keys(value).sort().join(',') === 'bytes,id,mode,mtimeMs,productionPath,sha256,workExperienceSha256';
  }
  return isSha256(value.inputFingerprint) && isSha256(value.sourceFingerprint)
    && isSha256(value.compilationContract)
    && typeof value.workExperienceName === 'string' && value.workExperienceName === path.basename(WORK_EXPERIENCE)
    && Number.isInteger(value.sourceCount) && value.sourceCount === 1;
}
function readManifest(paths) {
  assertRegularFile(paths.manifest, 'One-card run manifest');
  const value = JSON.parse(fs.readFileSync(paths.manifest, 'utf8'));
  if (value?.version !== 1 || canonical(value?.root) !== paths.root || canonical(value?.canvas) !== paths.canvas
    || value?.userData !== PRODUCTION_USER_DATA || canonical(value?.rollback) !== paths.rollback
    || !CARDS[value?.card] || !validSnapshotAttestation(value?.snapshot)
    || !value?.protectedBridgeState || typeof value.protectedBridgeState !== 'object'
    || !/^[a-f0-9-]{36}$/i.test(value?.queue?.jobId || '')) {
    throw new Error('One-card run manifest is malformed or points outside the owned run.');
  }
  return value;
}
function readRecoveryManifest(paths) {
  assertRegularFile(paths.manifest, 'Partial-run recovery manifest');
  const value = JSON.parse(fs.readFileSync(paths.manifest, 'utf8'));
  if (value?.version !== 1 || value?.recoveryRequired !== true || canonical(value?.root) !== paths.root
    || canonical(value?.canvas) !== paths.canvas || value?.userData !== PRODUCTION_USER_DATA
    || canonical(value?.rollback) !== paths.rollback || !CARDS[value?.card]
    || !validSnapshotAttestation(value?.snapshot) || !value?.queue?.partial || value?.queue?.jobId !== null) {
    throw new Error('Partial-run recovery manifest is malformed or not recoverable.');
  }
  return value;
}
function assertPreparedFixture(paths, manifest) {
  assertRegularFile(paths.canvas, 'Isolated fixture canvas');
  const fixture = JSON.parse(fs.readFileSync(paths.canvas, 'utf8'));
  if (!Array.isArray(fixture.nodes) || fixture.nodes.length !== 1 || fixture.edges?.length || fixture.drawings?.length) {
    throw new Error('Isolated fixture is not a minimal one-card canvas.');
  }
  const node = fixture.nodes[0]; const expected = CARDS[manifest.card];
  if (node?.id !== expected.id || node?.type !== 'jobcard' || node?.data?.company !== expected.company || node?.data?.title !== expected.title) {
    throw new Error('Isolated fixture no longer contains the reserved job card.');
  }
  return fixture;
}
function assertCorruptionSafeRunIdentity(paths, manifest) {
  const fixture = assertPreparedFixture(paths, manifest);
  const expected = CARDS[manifest.card];
  const jobId = manifest.queue.jobId;
  const expectedFolder = safeChild(paths.root, path.join('.local-ai', 'jobs', jobId), 'reserved corrupt-run job folder');
  if (canonical(manifest.queue.folder) !== expectedFolder) {
    throw new Error('Corruption-safe cleanup run manifest job folder is not the exact reserved job path.');
  }
  assertRegularDirectory(expectedFolder, 'Corrupt run-owned Local-AI job');
  const jobManifestFile = safeChild(expectedFolder, 'manifest.json', 'corrupt-run job manifest');
  const inputFile = safeChild(expectedFolder, 'input.json', 'corrupt-run job input');
  assertRegularFile(jobManifestFile, 'Corrupt run-owned job manifest');
  assertRegularFile(inputFile, 'Corrupt run-owned job input');
  const jobManifest = JSON.parse(fs.readFileSync(jobManifestFile, 'utf8'));
  const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  if (jobManifest?.id !== jobId || input?.jobId !== jobId || jobManifest?.transport !== 'paste'
    || canonical(jobManifest?.canvasFilePath) !== paths.canvas || canonical(input?.canvasFilePath) !== paths.canvas
    || canonical(jobManifest?.canvasRoot) !== paths.root || canonical(input?.canvasRoot) !== paths.root
    || input?.nodeId !== expected.id || input?.careerSnapshotId !== manifest.snapshot.id
    || input?.job?.company !== expected.company || input?.job?.title !== expected.title) {
    throw new Error('Corruption-safe cleanup manifest/input identity does not exactly match this run, card, canvas, and snapshot.');
  }
  const candidates = manifest.queue.bundleCandidates;
  if (!Array.isArray(candidates) || !candidates.length || candidates.some(relative => typeof relative !== 'string' || !relative
    || path.isAbsolute(relative) || path.normalize(relative) !== relative)
    || new Set(candidates).size !== candidates.length) {
    throw new Error('Corruption-safe cleanup run manifest has an invalid reserved bundle candidate set.');
  }
  for (const relative of candidates) safeChild(path.join(paths.root, 'Applied Jobs'), relative, 'reserved corrupt-run bundle candidate');
  const receiptFile = safeChild(paths.rollback, `queue-${manifest.card}.json`, 'corrupt-run queue receipt');
  assertRegularFile(receiptFile, 'Corrupt-run queue receipt');
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  if (receipt?.localJob?.id !== jobId || receipt?.card?.name !== manifest.card || receipt?.card?.id !== expected.id
    || receipt?.card?.company !== expected.company || receipt?.card?.title !== expected.title
    || canonical(receipt?.localJob?.folder) !== expectedFolder || canonical(receipt?.localJob?.canvasFilePath) !== paths.canvas
    || receipt?.snapshotId !== manifest.snapshot.id || JSON.stringify(receipt?.bundleCandidates) !== JSON.stringify(candidates)) {
    throw new Error('Corruption-safe cleanup queue receipt does not exactly bind the run manifest reservation.');
  }
  const pointer = fixture.nodes[0]?.data?.localApplication;
  if (fixture.nodes[0]?.data?.careerSnapshotId !== manifest.snapshot.id || pointer?.id !== jobId
    || canonical(pointer?.folder) !== expectedFolder || canonical(pointer?.canvasFilePath) !== paths.canvas) {
    throw new Error('Corruption-safe cleanup card pointer does not match the exact reserved job and snapshot.');
  }
  return { fixture, jobManifest, input, jobId, jobFolder: expectedFolder, bundleCandidates: candidates };
}
function assertNoPackagedAppRunning() {
  if (process.platform !== 'darwin') return;
  const commands = execFileSync('/bin/ps', ['-ax', '-o', 'command='], { encoding: 'utf8' });
  if (String(commands).split('\n').some(line => line.includes('/infinite-canvas.app/Contents/MacOS/infinite-canvas'))) {
    throw new Error('Quit Infinite Canvas completely before this operation; a running app can race production user-data or consume the launch single-instance request.');
  }
}

function assertSameCurrentCareerAttestation(before, after) {
  assertByteRecord(after.workExperience, before.workExperience, 'Work Experience source');
  assertByteRecord(after.snapshot, before.snapshot, 'Current approved snapshot');
  for (const key of ['id', 'productionPath', 'workExperienceName', 'workExperienceSha256', 'inputFingerprint', 'sourceFingerprint', 'compilationContract', 'sourceCount']) {
    if (after?.[key] !== before?.[key]) throw new Error(`Current career snapshot ${key} drifted.`);
  }
}

async function prepare({ id, cardName }) {
  const card = CARDS[cardName];
  if (!card) throw new Error('--card must be anthropic or affirm.');
  assertNoPackagedAppRunning();
  const paths = runPaths(id);
  if (fs.existsSync(paths.root)) throw new Error(`Run directory already exists: ${paths.root}`);
  assertRegularFile(PRODUCTION_CANVAS, 'Production canvas source');
  const sourceBefore = byteRecord(PRODUCTION_CANVAS);
  const provenance = await attestCurrentPinnedSnapshot();
  const protectedBridgeBefore = protectedBridgeState();
  let created = false; let queueAttempted = false;
  try {
    fs.mkdirSync(paths.root, { mode: 0o700 }); created = true;
    // Queue creation makes this parent lazily. Establish it as a fixture-owned
    // empty baseline first, so the reusable production rollback can prove the
    // job folder is gone without treating its empty parent as an unowned
    // concurrent .local-ai tree.
    fs.mkdirSync(path.join(paths.root, '.local-ai', 'jobs'), { recursive: true, mode: 0o700 });
    const source = JSON.parse(fs.readFileSync(PRODUCTION_CANVAS, 'utf8'));
    assertMeaningfullyDifferentSavedListings(source);
    const exactCard = extractTargetCard(source, card);
    const fixture = {
      schemaVersion: Number.isInteger(source.schemaVersion) ? source.schemaVersion : 0,
      nodes: [exactCard], edges: [], drawings: [],
    };
    fs.writeFileSync(paths.canvas, `${JSON.stringify(fixture, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    // Guard source immutability immediately before any production queue API.
    assertByteRecord(byteRecord(PRODUCTION_CANVAS), sourceBefore, 'Production canvas source');
    const beforeQueueProvenance = await attestCurrentPinnedSnapshot();
    assertSameCurrentCareerAttestation(provenance, beforeQueueProvenance);
    // Do not copy user-data secrets into the run artifact. The production
    // harness still records exact hashes/tree metadata and owns only this
    // fresh job's anchor; existing registry/key/bridge state remains guarded,
    // never claimed for rewrite.
    backupRun({ canvas: paths.canvas, userData: PRODUCTION_USER_DATA, destination: paths.rollback, execute: true, allowNonproduction: true, copyPrivateUserDataBaseline: false, copyApplicationSyncBaseline: true });
    queueAttempted = true;
    const queue = await pinAndQueue({
      canvas: paths.canvas, userData: PRODUCTION_USER_DATA, destination: paths.rollback,
      cardName, requestedSnapshotId: provenance.id, execute: true, allowNonproduction: true,
      skipExistingAuthorityIntegrityKey: true,
      useLiveApplicationSyncBaseline: true,
    });
    const jobId = queue?.localJob?.id;
    if (!/^[a-f0-9-]{36}$/i.test(jobId || '')) throw new Error('Production queue did not return a UUID job id.');
    const jobFolder = safeChild(paths.root, path.join('.local-ai', 'jobs', jobId), 'queued job folder');
    assertRegularDirectory(jobFolder, 'Queued Local-AI job');
    const queuedManifest = JSON.parse(fs.readFileSync(path.join(jobFolder, 'manifest.json'), 'utf8'));
    const queuedInput = JSON.parse(fs.readFileSync(path.join(jobFolder, 'input.json'), 'utf8'));
    // The acceptance exercise is only meaningful when generation receives the
    // exact saved listing selected above. The card identity checks alone would
    // still pass if an adapter later dropped, replaced, or shortened its
    // listing body while queuing. Compare the queue-time safe projection and
    // its full frozen payload, rather than the presentation-normalized text
    // used only by the anti-overfitting input guard.
    assertFrozenQueuedJobMatchesSavedCard(exactCard, queuedInput);
    const root = fs.realpathSync(paths.root);
    if (canonical(queuedManifest?.canvasFilePath) !== paths.canvas || canonical(queuedInput?.canvasFilePath) !== paths.canvas
      || canonical(queuedManifest?.canvasRoot) !== root || queuedManifest?.transport !== 'paste'
      || queuedInput?.careerSnapshotId !== provenance.id) {
      throw new Error('Production queue did not bind the paste job to the isolated canvas and root.');
    }
    const afterQueueProvenance = await attestCurrentPinnedSnapshot();
    assertSameCurrentCareerAttestation(provenance, afterQueueProvenance);
    for (const relative of queue.bundleCandidates || []) {
      const candidate = safeChild(path.join(paths.root, 'Applied Jobs'), relative, 'reserved bundle candidate');
      if (!isBelow(paths.root, candidate)) throw new Error('Reserved bundle candidate escaped the isolated run.');
    }
    const manifest = {
      version: 1, createdAt: new Date().toISOString(), root: paths.root, canvas: paths.canvas, userData: PRODUCTION_USER_DATA, rollback: paths.rollback,
      card: cardName,
      source: { canvas: PRODUCTION_CANVAS, ...sourceBefore, cardSha256: sha256(JSON.stringify(exactCard)) },
      snapshot: {
        id: provenance.id,
        productionPath: provenance.productionPath,
        workExperienceName: provenance.workExperienceName,
        workExperienceSha256: provenance.workExperienceSha256,
        inputFingerprint: provenance.inputFingerprint,
        sourceFingerprint: provenance.sourceFingerprint,
        compilationContract: provenance.compilationContract,
        sourceCount: provenance.sourceCount,
        ...provenance.snapshot,
      },
      // Hash/metadata only: no bridge config, OAuth material, tokens, or log
      // contents are copied to this run. A change is a preflight conflict,
      // never permission to overwrite the user's bridge state.
      protectedBridgeState: protectedBridgeBefore,
      queue: { jobId, folder: jobFolder, bundleCandidates: queue.bundleCandidates || [] },
    };
    writeJsonNew(paths.manifest, manifest);
    return { ok: true, runId: id, card: cardName, canvas: paths.canvas, userData: PRODUCTION_USER_DATA, jobId, bundleCandidates: manifest.queue.bundleCandidates, workExperienceSha256: provenance.workExperienceSha256, snapshotId: provenance.id };
  } catch (error) {
    // A partially created fixture can contain frozen career context. It is
    // never useful, so remove only the directory this invocation just made.
    // Once queueing starts, production user-data has a new authority anchor.
    // Keep the ownership manifest/rollback evidence for an explicit recovery;
    // never delete that evidence and pretend the partial live mutation vanished.
    if (created && !queueAttempted) removeOwnedTree(paths.root, ensureRunsRoot(), 'failed one-card run');
    if (created && queueAttempted && fs.existsSync(paths.rollback)) {
      // The guarded harness can restore a reservation even if queueing failed
      // after creating its anchor/job but before this wrapper had a job id.
      // Prefer that scoped rollback over a dead manifest with an unusable id.
      try {
        await restoreRun({ canvas: paths.canvas, userData: PRODUCTION_USER_DATA, destination: paths.rollback, execute: true, allowNonproduction: true });
        removeOwnedTree(paths.root, ensureRunsRoot(), 'recovered partial one-card run');
      } catch (recoveryError) {
        if (!fs.existsSync(paths.manifest)) writeJsonNew(paths.manifest, {
          version: 1, root: paths.root, canvas: paths.canvas, userData: PRODUCTION_USER_DATA, rollback: paths.rollback, card: cardName,
          snapshot: {
            id: provenance.id, productionPath: provenance.productionPath, workExperienceName: provenance.workExperienceName,
            workExperienceSha256: provenance.workExperienceSha256, inputFingerprint: provenance.inputFingerprint,
            sourceFingerprint: provenance.sourceFingerprint, compilationContract: provenance.compilationContract,
            sourceCount: provenance.sourceCount, ...provenance.snapshot,
          },
          protectedBridgeState: protectedBridgeBefore, queue: { jobId: null, partial: true }, recoveryRequired: true,
          recoveryError: String(recoveryError?.message || recoveryError),
        });
      }
    }
    throw error;
  }
}

async function inspect({ id }) {
  const paths = runPaths(id); const manifest = readManifest(paths);
  assertPreparedFixture(paths, manifest);
  const report = await inspectJob({ canvas: paths.canvas, userData: PRODUCTION_USER_DATA, destination: paths.rollback, jobId: manifest.queue.jobId });
  const result = { ok: true, runId: id, jobId: manifest.queue.jobId, status: report.status, output: report.output };
  writeJsonReplace(paths.manifest, { ...manifest, lastInspection: { at: new Date().toISOString(), status: report.status?.status || null } });
  return result;
}

async function launch({ id }) {
  const paths = runPaths(id); const manifest = readManifest(paths);
  assertPreparedFixture(paths, manifest);
  assertNoPackagedAppRunning();
  assertRegularFile(PACKAGED_APP, 'Packaged app executable');
  // Codex's test host exports ELECTRON_RUN_AS_NODE=1.  A packaged Electron
  // executable inherits that flag unless we explicitly remove it, at which
  // point it treats the canvas argument as a Node module rather than opening
  // the application.  The real desktop process must never run in Node mode.
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(PACKAGED_APP, [paths.canvas, '--acceptance-no-native-menu'], { detached: true, stdio: 'ignore', env: environment });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 500);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`Packaged app exited before canvas startup (code ${code}, signal ${signal || 'none'}).`)); });
  });
  try { process.kill(child.pid, 0); } catch { throw new Error('Packaged app is not alive after canvas launch.'); }
  child.unref();
  const command = [PACKAGED_APP, paths.canvas, '--acceptance-no-native-menu'];
  writeJsonReplace(paths.manifest, { ...manifest, launch: { at: new Date().toISOString(), pid: child.pid, command } });
  return { ok: true, runId: id, pid: child.pid, command, canvas: paths.canvas, userData: PRODUCTION_USER_DATA, nonHarnessOwnedRisk: ['Chromium caches and preferences', 'append-only bridge logs and retired-chat digests'] };
}

async function restore({ id, preserveChangedProtectedState = false }) {
  const paths = runPaths(id); const manifest = readManifest(paths);
  assertNoPackagedAppRunning();
  assertPreparedFixture(paths, manifest);
  const protectedStateForCleanup = protectedBridgeStateForCleanup(manifest.protectedBridgeState, { preserveChangedProtectedState });
  assertOAuthStateStructure();
  // Inspection re-attests an advanced card pointer and may claim exactly one
  // receipt-declared pre-reserved bundle before the harness does its CAS
  // cleanup. No arbitrary bundle path is ever adopted.
  await inspect({ id });
  await restoreRun({ canvas: paths.canvas, userData: PRODUCTION_USER_DATA, destination: paths.rollback, execute: true, allowNonproduction: true });
  const bridgeLaneCleanup = deferBridgeLaneCleanup(manifest.queue.jobId, paths.canvas);
  assertProtectedBridgeState(protectedStateForCleanup);
  assertOAuthStateStructure();
  const baseline = JSON.parse(fs.readFileSync(path.join(paths.rollback, 'baseline.json'), 'utf8'));
  assertByteRecord(byteRecord(paths.canvas), baseline.canvas, 'Restored isolated fixture');
  const registry = path.join(PRODUCTION_USER_DATA, 'application-sync-workspaces.json');
  if (baseline.applicationSync?.present) assertByteRecord(byteRecord(registry), baseline.applicationSync, 'Restored isolated Application Sync registry');
  else if (fs.existsSync(registry)) throw new Error('Isolated Application Sync registry was not restored to its absent baseline.');
  // This empty .local-ai/jobs scaffold was created by prepare before backup.
  // Remove it only when it still exactly equals that baseline; no recursive
  // deletion is allowed at this final race boundary.
  removeFixtureLocalAiScaffold(paths, baseline);
  // The baseline fixture is itself owned exclusively by this run. Remove only
  // it after the production rollback has removed/repaired the owned job,
  // bundle candidate, snapshot, sidecars, and registry.
  assertRegularFile(paths.canvas, 'Owned fixture canvas');
  fs.unlinkSync(paths.canvas);
  writeJsonReplace(paths.manifest, { ...readManifest(paths), restoredAt: new Date().toISOString(), fixtureRemoved: true });
  return {
    ok: true, runId: id, fixtureRemoved: paths.canvas, jobId: manifest.queue.jobId,
    applicationSyncRestored: true, bridgeLaneCleanup,
    preservedChangedProtectedState: preserveChangedProtectedState,
  };
}

async function restoreCorrupt({ id, preserveChangedProtectedState = false }) {
  const paths = runPaths(id); const manifest = readManifest(paths);
  assertNoPackagedAppRunning();
  const identity = assertCorruptionSafeRunIdentity(paths, manifest);
  const protectedStateForCleanup = protectedBridgeStateForCleanup(manifest.protectedBridgeState, { preserveChangedProtectedState });
  assertOAuthStateStructure();
  // Do not call localApplicationStatus here: this mode exists precisely for a
  // source-aware status parse failure inside this already-reserved tree.
  const adoption = adoptReservedCorruptJobStateForRestore({
    canvas: paths.canvas,
    userData: PRODUCTION_USER_DATA,
    destination: paths.rollback,
    jobId: identity.jobId,
    bundleCandidates: identity.bundleCandidates,
  });
  writeJsonReplace(paths.manifest, {
    ...manifest,
    corruptionSafeInspection: { at: new Date().toISOString(), ...adoption },
  });
  await restoreRun({ canvas: paths.canvas, userData: PRODUCTION_USER_DATA, destination: paths.rollback, execute: true, allowNonproduction: true });
  const bridgeLaneCleanup = deferBridgeLaneCleanup(manifest.queue.jobId, paths.canvas);
  assertProtectedBridgeState(protectedStateForCleanup);
  assertOAuthStateStructure();
  const baseline = JSON.parse(fs.readFileSync(path.join(paths.rollback, 'baseline.json'), 'utf8'));
  assertByteRecord(byteRecord(paths.canvas), baseline.canvas, 'Restored isolated fixture');
  const registry = path.join(PRODUCTION_USER_DATA, 'application-sync-workspaces.json');
  if (baseline.applicationSync?.present) assertByteRecord(byteRecord(registry), baseline.applicationSync, 'Restored isolated Application Sync registry');
  else if (fs.existsSync(registry)) throw new Error('Isolated Application Sync registry was not restored to its absent baseline.');
  removeFixtureLocalAiScaffold(paths, baseline);
  assertRegularFile(paths.canvas, 'Owned fixture canvas');
  fs.unlinkSync(paths.canvas);
  writeJsonReplace(paths.manifest, {
    ...readManifest(paths),
    restoredAt: new Date().toISOString(),
    fixtureRemoved: true,
    corruptionSafeRestore: true,
  });
  return {
    ok: true,
    runId: id,
    fixtureRemoved: paths.canvas,
    jobId: manifest.queue.jobId,
    applicationSyncRestored: true,
    bridgeLaneCleanup,
    preservedChangedProtectedState: preserveChangedProtectedState,
    adoption,
  };
}

async function recover({ id, preserveChangedProtectedState = false }) {
  const paths = runPaths(id); const manifest = readRecoveryManifest(paths);
  assertNoPackagedAppRunning();
  const protectedStateForCleanup = protectedBridgeStateForCleanup(manifest.protectedBridgeState, { preserveChangedProtectedState });
  assertOAuthStateStructure();
  assertRegularFile(paths.canvas, 'Partial isolated fixture canvas');
  assertRegularDirectory(paths.rollback, 'Partial rollback directory');
  await restoreRun({ canvas: paths.canvas, userData: PRODUCTION_USER_DATA, destination: paths.rollback, execute: true, allowNonproduction: true });
  assertProtectedBridgeState(protectedStateForCleanup);
  assertOAuthStateStructure();
  // `restoreRun` has already verified all owned paths against its baseline.
  // This wrapper owns the remaining evidence tree and may now discard it.
  removeOwnedTree(paths.root, ensureRunsRoot(), 'recovered partial one-card run');
  return { ok: true, runId: id, recovered: true, preservedChangedProtectedState: preserveChangedProtectedState };
}

async function selfTest() {
  // Keep this command portable and non-invasive: live-only paths are resolved
  // by prepare/launch/restore, while self-test proves the local guards using
  // temporary fixtures and the resolver's isolated fixture only.
  const resolverProof = await runCurrentSnapshotResolutionSelfTest();
  const guardRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-bridge-guard-'));
  try {
    const bridge = path.join(guardRoot, 'handoff-bridge'); fs.mkdirSync(path.join(bridge, 'tunnel'), { recursive: true, mode: 0o700 });
    const config = path.join(bridge, 'config.json'); fs.writeFileSync(config, '{"enabled":true}\n', { mode: 0o600 });
    const tunnelConfig = path.join(bridge, 'tunnel', 'config.yml'); fs.writeFileSync(tunnelConfig, 'tunnel: fixture\n', { mode: 0o600 });
    const tunnelJson = path.join(bridge, 'tunnel', 'tunnel.json'); fs.writeFileSync(tunnelJson, '{"fixture":true}\n', { mode: 0o600 });
    const guard = protectedBridgeState(guardRoot);
    fs.writeFileSync(config, '{"enabled":false}\n', { mode: 0o600 });
    assert.throws(() => assertProtectedBridgeState(guard, guardRoot), /Protected bridge state changed/);
    assert.throws(
      () => protectedBridgeStateForCleanup(guard, { userData: guardRoot }),
      /Protected bridge state changed/,
      'default cleanup must refuse a changed protected bridge config before owned rollback',
    );
    const preserved = protectedBridgeStateForCleanup(guard, { preserveChangedProtectedState: true, userData: guardRoot });
    assert.deepEqual(preserved, protectedBridgeState(guardRoot), 'opt-in cleanup must snapshot the currently selected protected bridge state');
    assertProtectedBridgeState(preserved, guardRoot);
    fs.writeFileSync(tunnelJson, '{"fixture":"concurrent-change"}\n', { mode: 0o600 });
    assert.throws(
      () => assertProtectedBridgeState(preserved, guardRoot),
      /Protected bridge state changed: tunnel\/tunnel\.json/,
      'opt-in cleanup must detect a protected bridge mutation after its snapshot',
    );
    fs.writeFileSync(tunnelJson, '{"fixture":true}\n', { mode: 0o600 });
    fs.writeFileSync(config, '{"enabled":true}\n', { mode: 0o600 });
    fs.unlinkSync(config);
    assert.throws(() => assertProtectedBridgeState(guard, guardRoot), /Protected bridge state changed/);
    const absentGuard = protectedBridgeState(guardRoot);
    fs.writeFileSync(config, '{"enabled":true}\n', { mode: 0o600 });
    assert.throws(() => assertProtectedBridgeState(absentGuard, guardRoot), /Protected bridge state changed/);

    // The stopped harness must never directly rewrite lanes.json. A byte/inode
    // CAS still has an unavoidable last-check -> pathname-rename window in
    // Node. Mutate the original lane file and swap the bridge parent after the
    // cleanup request validates its arguments; neither file may be overwritten.
    const laneUserData = path.join(guardRoot, 'lane-user-data'); fs.mkdirSync(laneUserData, { mode: 0o700 });
    const outsideBridge = path.join(guardRoot, 'outside-bridge'); fs.mkdirSync(outsideBridge, { mode: 0o700 });
    const laneCanvas = path.join(guardRoot, 'lane-fixture.json');
    const ownedLane = { jobId: 'owned-lane', canvasFilePath: laneCanvas, phase: 'held' };
    const unrelatedLane = { jobId: 'unrelated-lane', canvasFilePath: laneCanvas, phase: 'held' };
    const outsideLanes = path.join(outsideBridge, 'lanes.json');
    const outsideBytes = Buffer.from(`${JSON.stringify({ v: 1, lanes: [unrelatedLane] })}\n`);
    fs.writeFileSync(outsideLanes, outsideBytes, { mode: 0o640 });
    const laneBridge = path.join(laneUserData, 'handoff-bridge'); fs.mkdirSync(laneBridge, { mode: 0o700 });
    const laneFile = path.join(laneBridge, 'lanes.json');
    const concurrentBytes = Buffer.from(`${JSON.stringify({ v: 1, lanes: [ownedLane, unrelatedLane, { jobId: 'concurrent-lane', canvasFilePath: laneCanvas, phase: 'awaiting' }] })}\n`);
    fs.writeFileSync(laneFile, `${JSON.stringify({ v: 1, lanes: [ownedLane, unrelatedLane] })}\n`, { mode: 0o640 });
    const movedBridge = `${laneBridge}.moved`;
    const outsideBefore = fs.readFileSync(outsideLanes);
    const deferred = deferOwnedBridgeLaneCleanup({
      jobId: '12345678-1234-1234-1234-123456789abc',
      canvasFilePath: laneCanvas,
      afterValidationForTest: () => {
        fs.writeFileSync(laneFile, concurrentBytes, { mode: 0o640 });
        fs.renameSync(laneBridge, movedBridge);
        fs.symlinkSync(outsideBridge, laneBridge);
      },
    });
    assert.equal(deferred.removed, false);
    assert.equal(deferred.deferred, true);
    assert.equal(fs.readFileSync(outsideLanes).equals(outsideBefore), true, 'deferred bridge cleanup must not overwrite an attacker-selected external lane file');
    assert.equal(fs.readFileSync(path.join(movedBridge, 'lanes.json')).equals(concurrentBytes), true, 'deferred bridge cleanup must preserve a post-validation concurrent lane update');
    assert.equal(fs.lstatSync(laneBridge).isSymbolicLink(), true, 'adversarial parent swap must remain visible rather than being traversed for a write');

    // Final fixture cleanup must never turn the empty scaffold permission into
    // authority over a late job, and a dangling link must fail rather than be
    // mistaken for an absent directory by existsSync.
    const scaffoldRun = path.join(guardRoot, 'fixture-cleanup-run');
    const scaffoldLocalAi = path.join(scaffoldRun, '.local-ai');
    const scaffoldJobs = path.join(scaffoldLocalAi, 'jobs');
    fs.mkdirSync(scaffoldJobs, { recursive: true, mode: 0o700 });
    const scaffoldPaths = { root: scaffoldRun };
    const scaffoldBaseline = { localAi: treeRecord(scaffoldLocalAi) };
    assert.throws(
      () => removeFixtureLocalAiScaffold(scaffoldPaths, scaffoldBaseline, {
        afterValidationForTest: () => fs.mkdirSync(path.join(scaffoldJobs, 'late-job'), { mode: 0o700 }),
      }),
      /Local-AI tree changed after rollback verification|jobs root is no longer empty/i,
      'late Local-AI job must reject final scaffold cleanup',
    );
    assert.equal(fs.existsSync(path.join(scaffoldJobs, 'late-job')), true, 'late Local-AI job must survive rejected final cleanup');
    fs.rmdirSync(path.join(scaffoldJobs, 'late-job'));
    removeFixtureLocalAiScaffold(scaffoldPaths, scaffoldBaseline);
    assert.equal(lstatIfPresent(scaffoldLocalAi), null, 'exact empty scaffold must be removed non-recursively');

    fs.mkdirSync(scaffoldJobs, { recursive: true, mode: 0o700 });
    const linkBaseline = { localAi: treeRecord(scaffoldLocalAi) };
    const movedScaffold = `${scaffoldLocalAi}.moved`;
    assert.throws(
      () => removeFixtureLocalAiScaffold(scaffoldPaths, linkBaseline, {
        afterValidationForTest: () => {
          fs.renameSync(scaffoldLocalAi, movedScaffold);
          fs.symlinkSync(path.join(guardRoot, 'missing-fixture-local-ai'), scaffoldLocalAi);
        },
      }),
      /missing, non-directory, or symbolic link/i,
      'dangling fixture Local-AI symlink must reject cleanup',
    );
    assert.equal(fs.lstatSync(scaffoldLocalAi).isSymbolicLink(), true, 'dangling fixture Local-AI symlink must remain visible after rejection');
    fs.unlinkSync(scaffoldLocalAi);
    fs.rmSync(movedScaffold, { recursive: true, force: true });
  } finally { fs.rmSync(guardRoot, { recursive: true, force: true }); }
  return {
    ok: true, portable: true, productionCanvasTouched: false, productionUserDataMutated: false, bridgeConfigTouched: false,
    protectedBridgeMutationTests: true, protectedBridgePreservationTests: true, bridgeLaneDeferredCleanupTests: true,
    fixtureLocalAiCleanupRaceTests: true,
    currentSnapshotResolverTests: resolverProof,
  };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === 'help' || command === '--help') { process.stdout.write(usage()); return; }
  if (options['preserve-changed-protected-state'] && !['restore', 'restore-corrupt', 'recover'].includes(command)) {
    throw new Error('--preserve-changed-protected-state is valid only with restore, restore-corrupt, or recover.');
  }
  if (command === 'self-test') { process.stdout.write(`${JSON.stringify(await selfTest(), null, 2)}\n`); return; }
  const id = required(options, 'run-id');
  if (command === 'prepare') {
    if (!options.execute) throw new Error('Refusing fixture creation and real queueing without --execute.');
    process.stdout.write(`${JSON.stringify(await prepare({ id, cardName: required(options, 'card') }), null, 2)}\n`); return;
  }
  if (command === 'inspect') { process.stdout.write(`${JSON.stringify(await inspect({ id }), null, 2)}\n`); return; }
  if (command === 'launch') {
    if (!options.execute) throw new Error('Refusing packaged-app launch without --execute.');
    process.stdout.write(`${JSON.stringify(await launch({ id }), null, 2)}\n`); return;
  }
  if (command === 'restore') {
    if (!options.execute) throw new Error('Refusing cleanup without --execute.');
    process.stdout.write(`${JSON.stringify(await restore({ id, preserveChangedProtectedState: options['preserve-changed-protected-state'] === true }), null, 2)}\n`); return;
  }
  if (command === 'restore-corrupt') {
    if (!options.execute) throw new Error('Refusing corruption-safe cleanup without --execute.');
    process.stdout.write(`${JSON.stringify(await restoreCorrupt({ id, preserveChangedProtectedState: options['preserve-changed-protected-state'] === true }), null, 2)}\n`); return;
  }
  if (command === 'recover') {
    if (!options.execute) throw new Error('Refusing partial-run recovery without --execute.');
    process.stdout.write(`${JSON.stringify(await recover({ id, preserveChangedProtectedState: options['preserve-changed-protected-state'] === true }), null, 2)}\n`); return;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && canonical(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`One-card live acceptance: ${error?.message || error}\n`); process.exitCode = 1; });
}
