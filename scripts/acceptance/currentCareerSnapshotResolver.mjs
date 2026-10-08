/*
 * Current-career authority resolver shared by the disposable live acceptance
 * wrapper and its tracked unit test.  It deliberately has no dependency on a
 * run directory, production canvas, or Electron user-data path.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CAREER_SNAPSHOT_COMPILATION_CONTRACT,
  careerSnapshotId,
  careerSnapshotInputFingerprint,
  careerSnapshotPath,
  readCareerSnapshot,
} from '../../electron/ipc/careerSnapshot.js';

const SHA256_RE = /^[a-f0-9]{64}$/;
let snapshotCaptureHookForTests = null;

// Narrow deterministic seam for proving descriptor/path revalidation. It is
// deliberately unavailable to production callers unless a test installs it.
export function __setCurrentCareerSnapshotCaptureHookForTests(hook) {
  snapshotCaptureHookForTests = typeof hook === 'function' ? hook : null;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function assertRegularFile(file, label) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-link file.`);
  }
  return stat;
}

export function sameFileIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

export function sameSnapshotBytes(left, right) {
  return left?.bytes === right?.bytes
    && left?.sha256 === right?.sha256
    && left?.mode === right?.mode
    && left?.mtimeMs === right?.mtimeMs
    && left?.ctimeMs === right?.ctimeMs;
}

export function snapshotByteRecord(snapshot) {
  return Object.freeze({
    bytes: snapshot.bytes,
    sha256: snapshot.sha256,
    mode: snapshot.mode,
    mtimeMs: snapshot.mtimeMs,
    ctimeMs: snapshot.ctimeMs,
  });
}

export function captureRegularFileSnapshot(file, label) {
  const before = assertRegularFile(file, label);
  const noFollow = process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW || 0);
  let handle;
  try {
    handle = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(handle);
    const beforeIdentity = { dev: before.dev, ino: before.ino };
    const openedIdentity = { dev: opened.dev, ino: opened.ino };
    if (!opened.isFile() || !sameFileIdentity(beforeIdentity, openedIdentity)
      || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs) {
      throw new Error(`${label} changed while it was being opened.`);
    }
    const content = fs.readFileSync(handle);
    if (snapshotCaptureHookForTests) snapshotCaptureHookForTests({ file, handle, before, opened, content });
    const afterRead = fs.fstatSync(handle);
    const afterPath = assertRegularFile(file, label);
    const afterReadIdentity = { dev: afterRead.dev, ino: afterRead.ino };
    const afterPathIdentity = { dev: afterPath.dev, ino: afterPath.ino };
    if (!sameFileIdentity(openedIdentity, afterReadIdentity) || !sameFileIdentity(openedIdentity, afterPathIdentity)
      || afterRead.size !== opened.size || afterRead.mtimeMs !== opened.mtimeMs || afterRead.ctimeMs !== opened.ctimeMs
      || afterPath.size !== opened.size || afterPath.mtimeMs !== opened.mtimeMs || afterPath.ctimeMs !== opened.ctimeMs) {
      throw new Error(`${label} changed while it was being read.`);
    }
    return Object.freeze({
      bytes: content.length,
      sha256: sha256(content),
      mode: afterRead.mode & 0o777,
      mtimeMs: afterRead.mtimeMs,
      ctimeMs: afterRead.ctimeMs,
      identity: afterReadIdentity,
      content,
    });
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function isSha256(value) {
  return typeof value === 'string' && SHA256_RE.test(value);
}

// The address is derived from exactly what the importer receives.  Do not
// normalize, trim, or guess a historical snapshot address here.
export function currentCareerSourceIdentityFromBytes(bytes, { name = 'Work Experience.md' } = {}) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) {
    throw new Error('Work Experience source must be a non-empty UTF-8 file.');
  }
  const sourceName = String(name || '');
  if (!sourceName || sourceName.includes('/') || sourceName.includes('\\')) {
    throw new Error('Work Experience source name is unsafe.');
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new Error('Work Experience source is not lossless UTF-8.');
  }
  const contentHash = sha256(text);
  const inputFingerprint = careerSnapshotInputFingerprint([{ name: sourceName, contentHash }]);
  return Object.freeze({
    name: sourceName,
    text,
    contentHash,
    inputFingerprint,
    snapshotId: careerSnapshotId(inputFingerprint),
    compilationContract: CAREER_SNAPSHOT_COMPILATION_CONTRACT,
  });
}

export function currentCareerSourceIdentityFromFile(file) {
  const fileSnapshot = captureRegularFileSnapshot(file, 'Work Experience source');
  return Object.freeze({
    ...currentCareerSourceIdentityFromBytes(fileSnapshot.content, { name: path.basename(file) }),
    file: snapshotByteRecord(fileSnapshot),
  });
}

function assertCurrentApprovedSnapshot(snapshot, expected) {
  if (!snapshot || snapshot.snapshotId !== expected.snapshotId || snapshot.status !== 'approved'
    || snapshot.compilationContract !== expected.compilationContract
    || snapshot.inputFingerprint !== expected.inputFingerprint || !isSha256(snapshot.sourceFingerprint)) {
    throw new Error('The current-contract approved snapshot is absent or does not match this Work Experience source identity.');
  }
  if (!Array.isArray(snapshot.sources) || snapshot.sources.length !== 1) {
    throw new Error('The approved snapshot is not exclusively derived from the current Work Experience.md source.');
  }
  const [source] = snapshot.sources;
  if (source?.id !== 'source-0001' || source.name !== expected.name
    || source.contentHash !== expected.contentHash || source.compilationTextHash !== expected.contentHash
    || source.legacyTextHash !== expected.contentHash || source.text !== expected.text || source.legacyText !== expected.text) {
    throw new Error('The approved snapshot is not proven to be the exact current Work Experience.md transcription.');
  }
}

export async function resolveCurrentApprovedCareerSnapshot({
  storageRoot,
  sourceIdentity,
  readSnapshot = readCareerSnapshot,
} = {}) {
  if (!storageRoot || !sourceIdentity || !isSha256(sourceIdentity.snapshotId)
    || !isSha256(sourceIdentity.inputFingerprint) || !isSha256(sourceIdentity.contentHash)
    || sourceIdentity.compilationContract !== CAREER_SNAPSHOT_COMPILATION_CONTRACT) {
    throw new Error('Current career snapshot resolution requires a complete current source identity.');
  }
  const snapshotFile = careerSnapshotPath(storageRoot, sourceIdentity.snapshotId);
  const before = captureRegularFileSnapshot(snapshotFile, 'Current approved snapshot');
  const snapshot = await readSnapshot(storageRoot, sourceIdentity.snapshotId);
  const after = captureRegularFileSnapshot(snapshotFile, 'Current approved snapshot');
  if (!sameFileIdentity(before.identity, after.identity) || !sameSnapshotBytes(before, after)) {
    throw new Error('Current approved snapshot changed while it was being verified.');
  }
  assertCurrentApprovedSnapshot(snapshot, sourceIdentity);
  return Object.freeze({
    id: sourceIdentity.snapshotId,
    productionPath: snapshotFile,
    workExperienceName: sourceIdentity.name,
    workExperienceSha256: sourceIdentity.contentHash,
    inputFingerprint: sourceIdentity.inputFingerprint,
    sourceFingerprint: snapshot.sourceFingerprint,
    compilationContract: sourceIdentity.compilationContract,
    snapshot: snapshotByteRecord(before),
    sourceCount: 1,
  });
}

/** Isolated proof for the no-scan/current-contract resolver; never reads user data. */
export async function runCurrentSnapshotResolutionSelfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-current-snapshot-'));
  try {
    const sourceIdentity = currentCareerSourceIdentityFromBytes(Buffer.from('Career source\n', 'utf8'));
    const directory = path.join(root, 'career-snapshots');
    fs.mkdirSync(directory, { mode: 0o700 });
    const expectedFile = careerSnapshotPath(root, sourceIdentity.snapshotId);
    fs.writeFileSync(expectedFile, '{"fixture":"current"}\n', { mode: 0o600 });
    fs.writeFileSync(path.join(directory, `${'f'.repeat(64)}.json`), '{"fixture":"stale"}\n', { mode: 0o600 });
    const source = {
      id: 'source-0001', name: sourceIdentity.name, contentHash: sourceIdentity.contentHash,
      compilationTextHash: sourceIdentity.contentHash, legacyTextHash: sourceIdentity.contentHash,
      text: sourceIdentity.text, legacyText: sourceIdentity.text,
    };
    const valid = {
      snapshotId: sourceIdentity.snapshotId, status: 'approved', compilationContract: sourceIdentity.compilationContract,
      inputFingerprint: sourceIdentity.inputFingerprint, sourceFingerprint: 'a'.repeat(64), sources: [source],
    };
    let requestedId = null;
    const resolved = await resolveCurrentApprovedCareerSnapshot({
      storageRoot: root,
      sourceIdentity,
      readSnapshot: async (_storageRoot, snapshotId) => {
        requestedId = snapshotId;
        return valid;
      },
    });
    assert.equal(requestedId, sourceIdentity.snapshotId, 'resolver must request only the deterministically derived current address');
    assert.equal(resolved.id, sourceIdentity.snapshotId);
    assert.throws(
      () => currentCareerSourceIdentityFromBytes(Buffer.from([0xc3, 0x28])),
      /lossless UTF-8/,
      'resolver must not derive an identity from replacement-decoded source bytes',
    );
    await assert.rejects(
      () => resolveCurrentApprovedCareerSnapshot({ storageRoot: root, sourceIdentity, readSnapshot: async () => null }),
      /current-contract approved snapshot is absent/i,
      'a historical/missing reader result must not become a fallback authority',
    );
    await assert.rejects(
      () => resolveCurrentApprovedCareerSnapshot({
        storageRoot: root,
        sourceIdentity,
        readSnapshot: async () => ({ ...valid, compilationContract: 'b'.repeat(64) }),
      }),
      /does not match this Work Experience source identity/i,
      'a non-current compilation contract must be rejected even at the expected address',
    );
    await assert.rejects(
      () => resolveCurrentApprovedCareerSnapshot({
        storageRoot: root,
        sourceIdentity,
        readSnapshot: async () => ({ ...valid, sources: [{ ...source, text: 'different', legacyText: 'different' }] }),
      }),
      /exact current Work Experience\.md transcription/i,
      'a snapshot with mismatched source text must be rejected',
    );
    await assert.rejects(
      () => resolveCurrentApprovedCareerSnapshot({
        storageRoot: root,
        sourceIdentity,
        readSnapshot: async () => ({ ...valid, sources: [source, { ...source, id: 'source-0002' }] }),
      }),
      /exclusively derived/i,
      'an ambiguous multi-source snapshot must not be selected for this one-file run',
    );
    await assert.rejects(
      () => resolveCurrentApprovedCareerSnapshot({
        storageRoot: root,
        sourceIdentity,
        readSnapshot: async () => {
          fs.writeFileSync(expectedFile, '{"fixture":"changed"}\n', { mode: 0o600 });
          return valid;
        },
      }),
      /changed while it was being verified/i,
      'a concurrent snapshot write must fail the pre/post verification CAS',
    );
    const captureFile = path.join(root, 'capture-race.md');
    const outsideFile = path.join(root, 'outside-race.md');
    fs.writeFileSync(captureFile, 'stable source\n', { mode: 0o600 });
    fs.writeFileSync(outsideFile, 'outside source\n', { mode: 0o600 });
    let restoredMutationMtime = false;
    __setCurrentCareerSnapshotCaptureHookForTests(({ file, before }) => {
      // Same byte length and restored mtime force the ctime check to be the
      // observable mutation signal rather than an easy size/mtime mismatch.
      fs.writeFileSync(file, 'tamper source\n', { mode: 0o600 });
      fs.utimesSync(file, before.atimeMs / 1_000, before.mtimeMs / 1_000);
      const restored = fs.statSync(file);
      restoredMutationMtime = restored.size === before.size && restored.mtimeMs === before.mtimeMs;
    });
    assert.throws(
      () => captureRegularFileSnapshot(captureFile, 'Capture race source'),
      /changed while it was being read/i,
      'an in-place same-size/mtime-restored write after descriptor read must be rejected by ctime',
    );
    assert.equal(restoredMutationMtime, true, 'capture mutation fixture must restore the original size and mtime');
    assert.equal(sameSnapshotBytes(
      { bytes: 14, sha256: 'a'.repeat(64), mode: 0o600, mtimeMs: 1, ctimeMs: 1 },
      { bytes: 14, sha256: 'a'.repeat(64), mode: 0o600, mtimeMs: 1, ctimeMs: 2 },
    ), false, 'resolver CAS records must treat a ctime-only difference as a conflict');
    fs.writeFileSync(captureFile, 'stable source\n', { mode: 0o600 });
    __setCurrentCareerSnapshotCaptureHookForTests(({ file }) => {
      const moved = `${file}.moved`;
      fs.renameSync(file, moved);
      fs.symlinkSync(outsideFile, file);
    });
    assert.throws(
      () => captureRegularFileSnapshot(captureFile, 'Capture symlink race source'),
      /regular non-link|changed while it was being read/i,
      'a path replacement after descriptor open must be rejected without following the symlink',
    );
    __setCurrentCareerSnapshotCaptureHookForTests(null);
    return {
      currentAddressOnly: true,
      rejectsHistoricalFallback: true,
      rejectsSourceMismatch: true,
      rejectsAmbiguousSourceSet: true,
      snapshotCas: true,
      captureMutationCas: true,
      captureCtimeCas: true,
      snapshotCtimeCas: true,
      captureSymlinkCas: true,
    };
  } finally {
    __setCurrentCareerSnapshotCaptureHookForTests(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
