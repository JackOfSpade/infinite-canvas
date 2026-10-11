import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureDirectoryWithinRoot, isSensitivePath, isWithinDirectory } from './utils/pathSafety.js';

/**
 * Decode the filesystem path carried by a local-file:// request.
 *
 * WHATWG URL parsing treats `C:` as a hostname in `local-file://C:/...`.
 * Reconstruct that drive-letter form on Windows while preserving the normal
 * pathname behavior for the triple-slash URLs generated on macOS/Linux.
 */
export function decodeLocalFileRequestPath(requestUrl, platform = process.platform) {
  const fallbackPath = String(requestUrl || '')
    .replace(/^local-file:\/\//, '')
    .split('?')[0]
    .split('#')[0];

  let encodedPath = fallbackPath;
  try {
    const parsed = new URL(requestUrl);
    encodedPath = parsed.pathname || fallbackPath;

    if (parsed.hostname) {
      if (platform === 'win32' && /^[a-zA-Z]$/.test(parsed.hostname)) {
        encodedPath = `${parsed.hostname}:${parsed.pathname}`;
      } else if (platform === 'win32') {
        encodedPath = `//${parsed.hostname}${parsed.pathname}`;
      } else {
        // Chromium can canonicalize `local-file:///private/tmp/...` to
        // `local-file://private/tmp/...` before the protocol handler sees it.
        // For this filesystem-only custom scheme the hostname is the first path
        // segment, not a network authority.
        encodedPath = `/${parsed.hostname}${parsed.pathname}`;
      }
    } else if (platform === 'win32' && /^\/[a-zA-Z]:\//.test(encodedPath)) {
      encodedPath = encodedPath.slice(1);
    }
  } catch {
    // Legacy Windows backslash URLs are not valid WHATWG URLs. The fallback
    // above intentionally preserves their path text.
  }

  return decodeURIComponent(encodedPath);
}

// The local-file protocol serves renderer-controlled paths.  A path check
// followed by createReadStream(path) is not a safe binding: a renderer (or a
// malicious canvas it loaded) can arrange for the spelling to change between
// those two operations.  Keep the file descriptor that passed validation and
// stream from that descriptor instead.  This module stays Electron-free so
// the boundary can be exercised in ordinary Node regression tests.

const NO_FOLLOW_FLAG = fs.constants.O_NOFOLLOW || 0;
const NO_FOLLOW_FALLBACK_CODES = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM']);
const PRIVATE_PROTOCOL_WORK_ROOT = 'local-file-protocol-transcodes';
const PRIVATE_PROTOCOL_WORK_PREFIX = 'operation-';
const PRIVATE_PROTOCOL_DIRECTORY_MODE = 0o700;
const PRIVATE_PROTOCOL_FILE_MODE = 0o600;

function localFileError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function localFileUnsafePathError() {
  return localFileError('LOCAL_FILE_UNSAFE_PATH', 'Access to this local file is restricted.');
}

function localFileHardlinkError() {
  return localFileError('LOCAL_FILE_HARDLINK_UNSUPPORTED', 'Files with multiple hard links cannot be served to the canvas.');
}

function localFilePathChangedError() {
  return localFileError('LOCAL_FILE_PATH_CHANGED', 'The local file changed while it was being opened.');
}

function localFileNotRegularError() {
  return localFileError('LOCAL_FILE_NOT_REGULAR', 'Only regular local files can be served.');
}

function localFilePrivateStorageError(message = 'The private local-file workspace is no longer safe to use.') {
  return localFileError('LOCAL_FILE_PRIVATE_STORAGE_UNSAFE', message);
}

function localFilePrivateOutputError(message = 'The local-file conversion output changed while it was being prepared.') {
  return localFileError('LOCAL_FILE_PRIVATE_OUTPUT_UNSAFE', message);
}

function localFilePathsEqual(left, right, platform = process.platform) {
  const platformPath = platform === 'win32' ? path.win32 : path;
  let normalizedLeft = platformPath.resolve(left).normalize('NFC');
  let normalizedRight = platformPath.resolve(right).normalize('NFC');
  // macOS realpath canonicalizes these system-owned aliases below /private.
  // They are not user-controlled symlink equivalences, and treating them as a
  // path swap would make the app-owned helper unusable when a test/runtime
  // userData directory happens to live below the system temp hierarchy.
  if (platform === 'darwin') {
    const normalizeMacAlias = value => value
      .replace(/^\/tmp(?=\/|$)/u, '/private/tmp')
      .replace(/^\/var(?=\/|$)/u, '/private/var')
      .replace(/^\/etc(?=\/|$)/u, '/private/etc');
    normalizedLeft = normalizeMacAlias(normalizedLeft);
    normalizedRight = normalizeMacAlias(normalizedRight);
  }
  if (platform === 'win32' || platform === 'darwin') {
    normalizedLeft = normalizedLeft.replace(/^\\\\\?\\/u, '').toLowerCase();
    normalizedRight = normalizedRight.replace(/^\\\\\?\\/u, '').toLowerCase();
  }
  return normalizedLeft === normalizedRight;
}

function hasSameIdentity(left, right) {
  return !!left && !!right && left.dev === right.dev && left.ino === right.ino;
}

function assertRegularSingleLink(stat) {
  if (!stat?.isFile?.() || stat.isSymbolicLink?.()) throw localFileNotRegularError();
  if (typeof stat.nlink === 'number' && stat.nlink > 1) throw localFileHardlinkError();
}

function identityFor(stat) {
  return { dev: stat?.dev, ino: stat?.ino };
}

function isSafePrivateLeafName(value) {
  return typeof value === 'string'
    && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value)
    && value !== '.'
    && value !== '..';
}

async function assertPrivateProtocolDirectory(directory, { rootDirectory = null } = {}) {
  const normalizedDirectory = path.resolve(String(directory || '')).normalize('NFC');
  if (!directory || !path.isAbsolute(normalizedDirectory)) throw localFilePrivateStorageError();
  let stat;
  let resolvedDirectory;
  try {
    [stat, resolvedDirectory] = await Promise.all([
      fs.promises.lstat(normalizedDirectory),
      fs.promises.realpath(normalizedDirectory),
    ]);
  } catch (error) {
    throw localFilePrivateStorageError(error?.code === 'ENOENT'
      ? 'The private local-file workspace disappeared before it could be used.'
      : undefined);
  }
  if (!stat.isDirectory?.() || stat.isSymbolicLink?.()
      || !localFilePathsEqual(normalizedDirectory, resolvedDirectory)) {
    throw localFilePrivateStorageError();
  }
  if (rootDirectory) {
    let resolvedRoot;
    try { resolvedRoot = await fs.promises.realpath(rootDirectory); } catch { throw localFilePrivateStorageError(); }
    if (!isWithinDirectory(resolvedRoot, resolvedDirectory) || localFilePathsEqual(resolvedRoot, resolvedDirectory)) {
      throw localFilePrivateStorageError();
    }
  }
  return { normalizedDirectory, resolvedDirectory, identity: identityFor(stat) };
}

/**
 * Create an app-owned conversion workspace below Electron's userData root.
 *
 * Do not use os.tmpdir() here.  A renderer can cause this protocol to invoke
 * pathname-only image decoders, and a shared temp directory gives a same-user
 * symlink attacker a writable namespace around those decoder outputs.  The
 * fixed parent is host-owned and renderer-denied by pathSafety; every unique
 * child is then created by mkdtemp and re-proved as a direct 0700 directory.
 */
export async function createPrivateLocalFileWorkDirectory(userDataPath) {
  const userData = path.resolve(String(userDataPath || '')).normalize('NFC');
  if (!userDataPath || !path.isAbsolute(userData)) throw localFilePrivateStorageError();
  let storageRoot;
  try {
    storageRoot = await ensureDirectoryWithinRoot(
      userData,
      path.join(userData, PRIVATE_PROTOCOL_WORK_ROOT),
      { mode: PRIVATE_PROTOCOL_DIRECTORY_MODE, label: 'Local-file protocol workspace' },
    );
    await fs.promises.chmod(storageRoot, PRIVATE_PROTOCOL_DIRECTORY_MODE);
    await assertPrivateProtocolDirectory(storageRoot, { rootDirectory: userData });
  } catch (error) {
    if (error?.code === 'LOCAL_FILE_PRIVATE_STORAGE_UNSAFE') throw error;
    throw localFilePrivateStorageError();
  }

  let directory;
  try {
    directory = await fs.promises.mkdtemp(path.join(storageRoot, PRIVATE_PROTOCOL_WORK_PREFIX));
    await fs.promises.chmod(directory, PRIVATE_PROTOCOL_DIRECTORY_MODE);
    await assertPrivateProtocolDirectory(directory, { rootDirectory: storageRoot });
    return { directory, storageRoot };
  } catch (error) {
    // Never recursively remove a path that failed its identity proof.  A
    // hostile replacement is left for ordinary userData cleanup rather than
    // allowing this protocol to chase a substituted directory.
    if (directory) {
      try { await removePrivateLocalFileWorkDirectory(directory, { storageRoot }); } catch { /* fail closed */ }
    }
    if (error?.code === 'LOCAL_FILE_PRIVATE_STORAGE_UNSAFE') throw error;
    throw localFilePrivateStorageError();
  }
}

/**
 * Reserve one internal conversion path with an exclusive, no-follow handle.
 * Callers write source bytes through the returned descriptor, never by
 * reopening filePath.  Existing entries (including a planted symlink) are a
 * typed refusal rather than a cache hit or a path that an external decoder may
 * inherit.
 */
export async function reservePrivateLocalFile(workDirectory, basename) {
  if (!isSafePrivateLeafName(basename)) throw localFilePrivateOutputError();
  const beforeDirectory = await assertPrivateProtocolDirectory(workDirectory);
  const filePath = path.resolve(beforeDirectory.normalizedDirectory, basename).normalize('NFC');
  if (path.dirname(filePath) !== beforeDirectory.normalizedDirectory
      || !isWithinDirectory(beforeDirectory.normalizedDirectory, filePath)) {
    throw localFilePrivateOutputError();
  }

  const createFlags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL;
  let handle;
  try {
    try {
      handle = await fs.promises.open(filePath, createFlags | NO_FOLLOW_FLAG, PRIVATE_PROTOCOL_FILE_MODE);
    } catch (error) {
      // O_EXCL|O_CREAT itself refuses an existing final symlink. If this host
      // does not expose O_NOFOLLOW for creation, retain O_EXCL rather than
      // turning a reservation into a normal path-following open.
      if (!NO_FOLLOW_FLAG || NO_FOLLOW_FALLBACK_CODES.has(error?.code)) {
        handle = await fs.promises.open(filePath, createFlags, PRIVATE_PROTOCOL_FILE_MODE);
      } else if (error?.code === 'EEXIST') {
        throw localFilePrivateOutputError('A local-file conversion path was already reserved.');
      } else {
        throw error;
      }
    }
    const [handleStat, lexicalStat, afterDirectory] = await Promise.all([
      handle.stat(),
      fs.promises.lstat(filePath),
      assertPrivateProtocolDirectory(workDirectory),
    ]);
    assertRegularSingleLink(handleStat);
    assertRegularSingleLink(lexicalStat);
    if (!hasSameIdentity(handleStat, lexicalStat)
        || !hasSameIdentity(beforeDirectory.identity, afterDirectory.identity)) {
      throw localFilePrivateOutputError();
    }
    await handle.chmod(PRIVATE_PROTOCOL_FILE_MODE);
    let closed = false;
    return {
      filePath,
      handle,
      identity: identityFor(handleStat),
      close: async () => {
        if (closed) return;
        closed = true;
        await handle.close().catch(() => {});
      },
    };
  } catch (error) {
    await handle?.close?.().catch(() => {});
    if (error?.code === 'EEXIST') {
      throw localFilePrivateOutputError('A local-file conversion path was already reserved.');
    }
    throw error;
  }
}

/**
 * Give a pathname-only external converter its own unpredictable, host-owned
 * output namespace.  macOS sips writes a temporary file and renames it into
 * `--out`; it cannot use an already-open output descriptor (and therefore
 * cannot safely use a pre-reserved final file).  A newly-created 0700 child
 * directory is the capability passed to sips instead.  We also reserve an
 * unpredictable 0600 marker through O_EXCL|O_NOFOLLOW, so later validation
 * proves that the namespace is still the one this process created before its
 * output is read.
 *
 * This is intentionally a host-only mutation boundary, not a claim that
 * portable Node has openat-style immunity against an arbitrary same-UID OS
 * process. Renderer IPC cannot name, enumerate, or mutate this namespace;
 * a detected replacement is typed and no resulting bytes are returned.
 */
export async function createPrivateLocalFileOutputDirectory(workDirectory) {
  const parent = await assertPrivateProtocolDirectory(workDirectory);
  let directory;
  let marker;
  try {
    directory = await fs.promises.mkdtemp(path.join(parent.normalizedDirectory, 'sips-output-'));
    await fs.promises.chmod(directory, PRIVATE_PROTOCOL_DIRECTORY_MODE);
    await assertPrivateProtocolDirectory(directory, { rootDirectory: parent.normalizedDirectory });
    marker = await reservePrivateLocalFile(directory, `owner-${randomUUID()}.nonce`);
    const markerPath = marker.filePath;
    const markerIdentity = marker.identity;
    await marker.close();
    marker = null;
    return {
      directory,
      markerPath,
      markerIdentity,
    };
  } catch (error) {
    await marker?.close?.().catch(() => {});
    if (directory) {
      try { await removePrivateLocalFileWorkDirectory(directory, { storageRoot: parent.normalizedDirectory }); } catch { /* fail closed */ }
    }
    throw error;
  }
}

/** Prove that an O_EXCL-created converter namespace marker is still intact. */
export async function assertPrivateLocalFileReservation(workDirectory, reservation) {
  if (!reservation?.filePath || !reservation?.identity) throw localFilePrivateOutputError();
  const before = await assertPrivateProtocolDirectory(workDirectory);
  const markerPath = path.resolve(reservation.filePath).normalize('NFC');
  if (path.dirname(markerPath) !== before.normalizedDirectory) throw localFilePrivateOutputError();
  let pinned;
  try {
    pinned = await openPinnedLocalFile(markerPath, { isSensitive: () => false });
    const current = await assertPinnedLocalFileBinding(pinned);
    const after = await assertPrivateProtocolDirectory(workDirectory);
    if (!hasSameIdentity(current, reservation.identity)
        || !hasSameIdentity(before.identity, after.identity)) {
      throw localFilePrivateOutputError();
    }
  } catch (error) {
    if (error?.code === 'LOCAL_FILE_PATH_CHANGED' || error?.code === 'LOCAL_FILE_NOT_REGULAR'
        || error?.code === 'LOCAL_FILE_HARDLINK_UNSUPPORTED') {
      throw localFilePrivateOutputError();
    }
    throw error;
  } finally {
    await pinned?.close?.().catch(() => {});
  }
}

/**
 * Read an externally-produced conversion result only after binding a fresh
 * direct, single-link descriptor.  No bytes are returned until a second
 * identity check succeeds, so a cache/output replacement cannot become a
 * private-file read through the local-file protocol.
 */
export async function readPrivateLocalFile(workDirectory, filePath) {
  const before = await assertPrivateProtocolDirectory(workDirectory);
  const normalizedPath = path.resolve(String(filePath || '')).normalize('NFC');
  if (path.dirname(normalizedPath) !== before.normalizedDirectory) throw localFilePrivateOutputError();
  let pinned;
  try {
    // This file lives in the host-owned temporary workspace, which is itself
    // intentionally renderer-denied. Do not apply the renderer's generic
    // sensitive-path block a second time; prove descriptor identity instead.
    pinned = await openPinnedLocalFile(normalizedPath, { isSensitive: () => false });
    await assertPinnedLocalFileBinding(pinned);
    const bytes = await pinned.handle.readFile();
    await assertPinnedLocalFileBinding(pinned);
    const after = await assertPrivateProtocolDirectory(workDirectory);
    if (!hasSameIdentity(before.identity, after.identity)) throw localFilePrivateOutputError();
    return bytes;
  } catch (error) {
    if (error?.code === 'LOCAL_FILE_PATH_CHANGED' || error?.code === 'LOCAL_FILE_NOT_REGULAR'
        || error?.code === 'LOCAL_FILE_HARDLINK_UNSUPPORTED') {
      throw localFilePrivateOutputError();
    }
    throw error;
  } finally {
    await pinned?.close?.().catch(() => {});
  }
}

/** Best-effort cleanup that never recursively follows a substituted workdir. */
export async function removePrivateLocalFileWorkDirectory(workDirectory, { storageRoot = null } = {}) {
  try {
    await assertPrivateProtocolDirectory(workDirectory, { rootDirectory: storageRoot });
  } catch {
    return false;
  }
  await fs.promises.rm(workDirectory, { recursive: true, force: true });
  return true;
}

/**
 * Guard a missing local-file preview before its bounded relink search walks
 * the parent hierarchy.  The eventual file may not exist yet, so walk upward
 * to the nearest real entry and reattach the missing suffix only after that
 * canonical ancestor has passed the private-store policy.
 */
export async function assertLocalFileLookupPathAllowed(filePath, {
  realpath = fs.promises.realpath,
  isSensitive = isSensitivePath,
} = {}) {
  const normalizedPath = path.resolve(String(filePath || '')).normalize('NFC');
  if (!filePath || isSensitive(normalizedPath)) throw localFileUnsafePathError();
  let probePath = normalizedPath;
  const missingSuffix = [];
  for (;;) {
    try {
      const resolvedProbe = await realpath(probePath);
      const resolvedPath = missingSuffix.length
        ? path.join(resolvedProbe, ...missingSuffix)
        : resolvedProbe;
      if (isSensitive(resolvedPath)) throw localFileUnsafePathError();
      return { normalizedPath, resolvedPath };
    } catch (error) {
      if (error?.code === 'LOCAL_FILE_UNSAFE_PATH') throw error;
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      const parentPath = path.dirname(probePath);
      if (parentPath === probePath) throw error;
      missingSuffix.unshift(path.basename(probePath));
      probePath = parentPath;
    }
  }
}

async function inspectLocalFileBinding(filePath, {
  lstat = fs.promises.lstat,
  realpath = fs.promises.realpath,
  isSensitive = isSensitivePath,
  platform = process.platform,
} = {}) {
  const normalizedPath = path.resolve(String(filePath || '')).normalize('NFC');
  if (!filePath || isSensitive(normalizedPath)) throw localFileUnsafePathError();

  const parentPath = path.dirname(normalizedPath);
  // Reject the lexical final link before resolving it.  Aside from avoiding
  // an unnecessary private-target lookup, this ensures the subsequent
  // descriptor always corresponds to a direct regular entry.
  const lexicalStat = await lstat(normalizedPath);
  assertRegularSingleLink(lexicalStat);
  const parentStat = await lstat(parentPath);
  if (!parentStat.isDirectory?.() || parentStat.isSymbolicLink?.()) {
    throw localFilePathChangedError();
  }
  const parentRealPath = await realpath(parentPath);
  if (isSensitive(parentRealPath)) throw localFileUnsafePathError();
  const resolvedPath = await realpath(normalizedPath);
  if (isSensitive(resolvedPath)) throw localFileUnsafePathError();
  if (!localFilePathsEqual(parentPath, parentRealPath, platform)) {
    throw localFilePathChangedError();
  }
  // A final symlink is not a stable renderer capability.  A public symbolic
  // link can be atomically retargeted to a private store after policy checks;
  // serving only direct regular entries makes the later handle binding honest.
  if (!localFilePathsEqual(normalizedPath, resolvedPath, platform)) throw localFilePathChangedError();

  const resolvedStat = await lstat(resolvedPath);
  assertRegularSingleLink(resolvedStat);
  if (!hasSameIdentity(lexicalStat, resolvedStat)) throw localFilePathChangedError();
  return {
    normalizedPath,
    resolvedPath,
    parentPath,
    parentIdentity: { dev: parentStat.dev, ino: parentStat.ino },
    identity: { dev: lexicalStat.dev, ino: lexicalStat.ino },
  };
}

async function assertLocalFileHandleMatchesBinding(handle, binding) {
  const handleStat = await handle.stat();
  assertRegularSingleLink(handleStat);
  const current = await inspectLocalFileBinding(binding.normalizedPath, {
    lstat: binding.lstat,
    realpath: binding.realpath,
    isSensitive: binding.isSensitive,
    platform: binding.platform,
  });
  if (!hasSameIdentity(handleStat, binding.identity)
      || !hasSameIdentity(current.identity, binding.identity)
      || !hasSameIdentity(current.parentIdentity, binding.parentIdentity)
      || !localFilePathsEqual(current.resolvedPath, binding.resolvedPath, binding.platform)) {
    throw localFilePathChangedError();
  }
  return handleStat;
}

async function openLocalFileNoFollow(filePath, {
  open = fs.promises.open,
  beforeFallbackOpen = null,
} = {}) {
  const flags = fs.constants.O_RDONLY | NO_FOLLOW_FLAG;
  if (!NO_FOLLOW_FLAG) {
    if (beforeFallbackOpen) await beforeFallbackOpen();
    return { handle: await open(filePath, fs.constants.O_RDONLY), noFollowFallback: true };
  }
  try {
    return { handle: await open(filePath, flags), noFollowFallback: false };
  } catch (error) {
    if (!NO_FOLLOW_FALLBACK_CODES.has(error?.code)) throw error;
    if (beforeFallbackOpen) await beforeFallbackOpen();
    return { handle: await open(filePath, fs.constants.O_RDONLY), noFollowFallback: true };
  }
}

/**
 * Open a direct, public, single-link local file and bind the returned handle
 * to the exact entry that passed policy.  No caller may stream by pathname
 * after this succeeds; use createPinnedLocalReadStream instead.
 *
 * On filesystems where O_NOFOLLOW is unavailable, the fallback may transiently
 * open a swapped target, but it reads no bytes and rejects it unless the final
 * lexical entry, parent, resolved path, and handle identity all still match.
 */
export async function openPinnedLocalFile(filePath, {
  open = fs.promises.open,
  lstat = fs.promises.lstat,
  realpath = fs.promises.realpath,
  isSensitive = isSensitivePath,
  platform = process.platform,
  beforeOpen = null,
  beforeFallbackOpen = null,
} = {}) {
  const initial = await inspectLocalFileBinding(filePath, { lstat, realpath, isSensitive, platform });
  const binding = { ...initial, lstat, realpath, isSensitive, platform };
  if (beforeOpen) await beforeOpen({ ...initial });

  let opened;
  try {
    try {
      opened = await openLocalFileNoFollow(initial.normalizedPath, { open, beforeFallbackOpen });
    } catch (error) {
      // POSIX O_NOFOLLOW reports a raced final symlink as ELOOP.  Surface it
      // as the same typed fail-closed path replacement as the post-open
      // identity checks instead of letting the protocol misclassify it as a
      // benign missing-file response.
      if (error?.code === 'ELOOP') throw localFilePathChangedError();
      throw error;
    }
    const handleStat = await assertLocalFileHandleMatchesBinding(opened.handle, binding);

    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await opened.handle.close().catch(() => {});
    };
    return {
      handle: opened.handle,
      filePath: initial.normalizedPath,
      stat: handleStat,
      binding,
      noFollowFallback: opened.noFollowFallback,
      close,
    };
  } catch (error) {
    await opened?.handle?.close?.().catch(() => {});
    throw error;
  }
}

/**
 * Re-prove a held local-file descriptor immediately before consuming it.
 * This catches an observed hard-link/identity swap during protocol work such
 * as cache lookup or preview setup; callers still stream the descriptor, never
 * a path.  Node has no portable *at API for the final external-process sliver.
 */
export async function assertPinnedLocalFileBinding(pinnedFile) {
  if (!pinnedFile?.handle || !pinnedFile.binding) {
    throw new TypeError('A pinned local file binding is required.');
  }
  return assertLocalFileHandleMatchesBinding(pinnedFile.handle, pinnedFile.binding);
}

/** Stream from the already-validated descriptor; never reopen `filePath`. */
export function createPinnedLocalReadStream(pinnedFile, { start, end, closeOnEnd = true } = {}) {
  if (!pinnedFile?.handle || typeof pinnedFile.close !== 'function') {
    throw new TypeError('A pinned local file handle is required.');
  }
  const options = { fd: pinnedFile.handle.fd, autoClose: false };
  if (Number.isInteger(start)) options.start = start;
  if (Number.isInteger(end)) options.end = end;
  let stream;
  try {
    // Node ignores `path` when `fd` is supplied. `null` makes that guarantee
    // obvious in review and avoids a second pathname resolution in libuv.
    stream = fs.createReadStream(null, options);
  } catch (error) {
    void pinnedFile.close();
    throw error;
  }
  const release = () => { void pinnedFile.close(); };
  if (closeOnEnd) stream.once('end', release);
  // An interrupted copy must not leave the descriptor live even when the
  // caller intentionally retains it after a successful materialization.
  stream.once('error', release);
  stream.once('close', release);
  return stream;
}

export function isLocalFileSafetyError(error) {
  return new Set([
    'LOCAL_FILE_UNSAFE_PATH',
    'LOCAL_FILE_HARDLINK_UNSUPPORTED',
    'LOCAL_FILE_PATH_CHANGED',
    'LOCAL_FILE_NOT_REGULAR',
    'LOCAL_FILE_PRIVATE_STORAGE_UNSAFE',
    'LOCAL_FILE_PRIVATE_OUTPUT_UNSAFE',
  ]).has(error?.code);
}
