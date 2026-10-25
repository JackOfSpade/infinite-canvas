/** Optional private compiler reuse receipts. Approved snapshots remain authority. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDirectoryWithinRoot } from '../utils/pathSafety.js';
import { validateCareerIncrementalState } from './careerSnapshot.js';

export const CAREER_INCREMENTAL_MAX_FILE_BYTES = 64 * 1024 * 1024;
const DIRECTORY = 'incremental-compilations';
const HASH = /^[a-f0-9]{64}$/u;

function snapshotIdFor(snapshot) {
  if (snapshot?.status !== 'approved' || !HASH.test(snapshot.snapshotId)) throw new Error('Career compiler reuse requires an approved snapshot.');
  return snapshot.snapshotId;
}

async function directoryFor(root, create = false) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Career compiler reuse requires an absolute private root.');
  const canonicalRoot = await ensureDirectoryWithinRoot(root, root, { label: 'Career compiler reuse' });
  const directory = path.join(canonicalRoot, DIRECTORY);
  if (create) return ensureDirectoryWithinRoot(canonicalRoot, directory, { label: 'Career compiler reuse' });
  const stat = await fs.promises.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.promises.realpath(directory) !== directory) {
    throw new Error('Career compiler reuse directory must be a private regular directory.');
  }
  return directory;
}

const sameFile = (before, after) => after.isFile() && !after.isSymbolicLink()
  && before.dev === after.dev && before.ino === after.ino && before.size === after.size
  && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;

/** Missing, corrupt, oversized or stale optimization data always means full compilation. */
export async function readCareerIncrementalState(root, snapshot) {
  let handle;
  try {
    const id = snapshotIdFor(snapshot);
    const directory = await directoryFor(root);
    const file = path.join(directory, `${id}.json`);
    const initial = await fs.promises.lstat(file);
    if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1
      || initial.size > CAREER_INCREMENTAL_MAX_FILE_BYTES) return null;
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    if (!sameFile(initial, opened) || opened.nlink !== 1) return null;
    // A bounded read also protects against a file growing after its stat.
    const buffer = Buffer.alloc(initial.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== initial.size || !sameFile(initial, await handle.stat())
      || !sameFile(initial, await fs.promises.lstat(file)) || await fs.promises.realpath(file) !== file) return null;
    const state = JSON.parse(buffer.subarray(0, length).toString('utf8'));
    return validateCareerIncrementalState(snapshot, state) ? state : null;
  } catch { return null; }
  finally { await handle?.close().catch(() => {}); }
}

/** Publish receipts only after their exact approved snapshot has been verified. */
export async function writeCareerIncrementalState(root, snapshot, state) {
  const id = snapshotIdFor(snapshot);
  if (!validateCareerIncrementalState(snapshot, state)) throw new Error('Career compiler reuse state does not match its approved snapshot.');
  const bytes = `${JSON.stringify(state)}\n`;
  if (Buffer.byteLength(bytes, 'utf8') > CAREER_INCREMENTAL_MAX_FILE_BYTES) throw new Error('Career compiler reuse state exceeds its private size limit.');
  const directory = await directoryFor(root, true);
  const destination = path.join(directory, `${id}.json`);
  const temporary = path.join(directory, `.${id}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.promises.open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporary, destination);
    const parent = await fs.promises.open(directory, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
    return destination;
  } finally {
    await handle?.close().catch(() => {});
    await fs.promises.unlink(temporary).catch(() => {});
  }
}
