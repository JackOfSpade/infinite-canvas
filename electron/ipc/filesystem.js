/**
 * Filesystem IPC handlers — scan directories, open files/URLs, save/load workspaces.
 */
import electronPkg from 'electron';
const { shell, dialog } = electronPkg;
import { handleSafe } from './ipcUtils.js';
import { logger } from '../logger.js';
import path from 'path';
import fs from 'fs';
import { createHash, randomUUID } from 'crypto';
import {
  rememberMissingPreviewSearchRoot,
  resolveMissingPreviewPath,
} from './missingPreviewRelink.js';
import { isProductImageExtension } from '../../src/utils/fileExtensions.js';
import { isWithinDirectory, isExistingFileAsync, isSensitivePath } from '../utils/pathSafety.js';
import { isBackgroundE2E, backgroundE2EDisabledError } from '../utils/backgroundE2e.js';
import { rebindJobRunRecoveryOwners } from './jobRunStaging.js';
import { rebindJobContinuationOwners } from './jobContinuation.js';
import { rebindJobAnalysisRecoveryOwners } from './jobAnalysisPaths.js';
import { withCanvasRecoveryRebind } from './canvasRecoveryPaths.js';
import { prepareCanvasRecoveryRebind } from './marketplaceRecoveryStore.js';

// Extensions the 'open-file' handler will hand to the OS shell. Covers the
// image/document/media/archive types this app's own drop/preview handling
// already deals in (see src/utils/fileExtensions.js, fileDisplayUtils.js),
// plus common office formats — deliberately excludes anything executable or
// installer-shaped (.exe/.app/.dmg/.pkg/.deb/.appimage/.sh/.command/
// .workflow/.scpt/.jar/etc.) and script formats a canvas document node could
// otherwise be used to launch.
const ALLOWED_OPEN_FILE_EXTS = new Set([
  // Images
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico',
  '.heic', '.heif', '.tiff', '.tif', '.avif', '.jxl',
  // Documents
  '.pdf', '.docx', '.rtf', '.txt', '.md',
  // Spreadsheets / presentations
  '.csv', '.xlsx', '.pptx',
  // Data / plain-text formats safe to view (never executed by double-click)
  '.json', '.yaml', '.yml', '.xml', '.ini', '.log', '.toml', '.env',
  // Source/code files normally associated with an editor. Script-associated
  // formats (.js/.jsx/.py/.rb/.php/.sh and similar) stay excluded because an
  // OS association may execute them rather than display them.
  '.ts', '.tsx', '.go', '.rs', '.java',
  '.c', '.cpp', '.h', '.cs', '.swift', '.kt',
  // Audio
  '.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a',
  // Video
  '.mp4', '.mov', '.webm', '.avi', '.mkv', '.wmv',
  // Archives retained for existing product UX. This app hands the container to
  // the OS archive handler; it never launches an archived member directly.
  '.zip', '.tar', '.gz', '.rar', '.7z',
]);

/** True when `filePath`'s extension is on the open-file allowlist. Pure/exported for testability. */
export function isAllowedOpenFileExt(filePath) {
  return ALLOWED_OPEN_FILE_EXTS.has(path.extname(String(filePath || '')).toLowerCase());
}

/**
 * Resolve an OS-open request to the regular file it will actually launch.
 * Checking only the renderer-supplied suffix lets `notes.txt -> payload.app`
 * bypass the allowlist because shell.openPath follows the link itself.
 */
async function inspectAllowedOpenFilePath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim() || !path.isAbsolute(filePath)) {
    throw new Error('A valid absolute file path is required.');
  }
  const normalizedPath = path.normalize(filePath);
  if (!isAllowedOpenFileExt(normalizedPath)) {
    const ext = path.extname(normalizedPath).toLowerCase();
    throw new Error(`Opening "${ext || '(no extension)'}" files is restricted for security reasons.`);
  }
  const lexicalStat = await fs.promises.lstat(normalizedPath);
  if (!lexicalStat.isFile() || lexicalStat.isSymbolicLink()) {
    throw new Error('Only regular document and media files can be opened. Symbolic links are restricted.');
  }
  const resolvedPath = await fs.promises.realpath(normalizedPath);
  if (!isAllowedOpenFileExt(resolvedPath)) {
    throw new Error('The selected document resolves to a restricted file type.');
  }
  const canonicalStat = await fs.promises.lstat(resolvedPath);
  if (!canonicalStat.isFile() || canonicalStat.isSymbolicLink()
      || !hasSameIdentity(canonicalStat, { dev: lexicalStat.dev, ino: lexicalStat.ino })) {
    throw new Error('Only regular document and media files can be opened.');
  }
  const parentPath = path.dirname(resolvedPath);
  const parentStat = await fs.promises.lstat(parentPath);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
      || await fs.promises.realpath(parentPath) !== parentPath) {
    throw new Error('The selected document parent is not a stable canonical directory.');
  }
  return {
    normalizedPath,
    resolvedPath,
    targetIdentity: { dev: canonicalStat.dev, ino: canonicalStat.ino },
    parentPath,
    parentIdentity: { dev: parentStat.dev, ino: parentStat.ino },
  };
}

async function assertAllowedOpenFileIdentity(target) {
  const [resolvedAgain, targetStat, parentPathAgain, parentStat] = await Promise.all([
    fs.promises.realpath(target.normalizedPath),
    fs.promises.lstat(target.resolvedPath),
    fs.promises.realpath(target.parentPath),
    fs.promises.lstat(target.parentPath),
  ]);
  if (resolvedAgain !== target.resolvedPath
      || !targetStat.isFile() || targetStat.isSymbolicLink()
      || !hasSameIdentity(targetStat, target.targetIdentity)
      || parentPathAgain !== target.parentPath
      || !parentStat.isDirectory() || parentStat.isSymbolicLink()
      || !hasSameIdentity(parentStat, target.parentIdentity)) {
    throw new Error('The selected document changed before it could be opened.');
  }
}

export async function resolveAllowedOpenFilePath(filePath) {
  const target = await inspectAllowedOpenFilePath(filePath);
  await assertAllowedOpenFileIdentity(target);
  return target.resolvedPath;
}

const ALLOWED_TEXT_EDIT_EXTS = new Set(['.md', '.txt']);
const MAX_OS_DELETE_PROTECTION_PATHS = 512;
const MAX_OS_DELETE_PROTECTION_PATH_LENGTH = 4096;

/** True when a document is one of the two formats the renderer exposes as editable. */
function isAllowedTextEditExt(filePath) {
  return ALLOWED_TEXT_EDIT_EXTS.has(path.extname(String(filePath || '')).toLowerCase());
}

function osDeleteProtectedError() {
  const error = new Error('The item is still represented by another canvas node and was kept on disk.');
  error.code = 'OS_DELETE_PROTECTED';
  return error;
}

function isResolvedDescendant(candidateDirectory, survivorPath) {
  const relative = path.relative(candidateDirectory, survivorPath);
  return relative !== '' && relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function inspectDeletionProtectionPath(filePath, { lstat, realpath }) {
  const normalizedPath = path.normalize(filePath);
  const lexicalStat = await lstat(normalizedPath);
  const resolvedPath = await realpath(normalizedPath);
  const resolvedStat = await lstat(resolvedPath);
  if (!resolvedStat.isFile() && !resolvedStat.isDirectory()) throw osDeleteProtectedError();
  return {
    normalizedPath,
    resolvedPath,
    resolvedIdentity: { dev: resolvedStat.dev, ino: resolvedStat.ino },
    // A final symlink is a removable directory entry, not a directory to
    // recurse through. Its resolved target still participates in same-target
    // protection below; ambiguous/broken links fail conservatively.
    isDirectory: lexicalStat.isDirectory() && !lexicalStat.isSymbolicLink(),
  };
}

/**
 * Defense in depth for the renderer's pre-delete duplicate filter. Protection
 * paths are untrusted hints: malformed, unavailable, or excessive entries can
 * only refuse a trash request; they never grant broader filesystem authority.
 */
export async function assertDeleteTargetNotRepresented(filePath, protectedPaths = [], {
  sender = null,
  validate = validateMutablePath,
  lstat = fs.promises.lstat,
  realpath = fs.promises.realpath,
} = {}) {
  const safePath = await validate(filePath, { sender });
  if (!Array.isArray(protectedPaths)
      || protectedPaths.length > MAX_OS_DELETE_PROTECTION_PATHS) {
    throw osDeleteProtectedError();
  }
  if (protectedPaths.length === 0) return safePath;

  let candidate;
  try {
    candidate = await inspectDeletionProtectionPath(safePath, { lstat, realpath });
  } catch {
    // Preserve existing candidate authorization errors above, but once a
    // survivor list is present any ambiguity in target resolution is a reason
    // to keep the OS item rather than risk deleting a live representation.
    throw osDeleteProtectedError();
  }

  for (const survivorPath of protectedPaths) {
    if (typeof survivorPath !== 'string' || !survivorPath.trim()
        || survivorPath.length > MAX_OS_DELETE_PROTECTION_PATH_LENGTH
        || !path.isAbsolute(survivorPath)) {
      throw osDeleteProtectedError();
    }
    let survivor;
    try {
      survivor = await inspectDeletionProtectionPath(survivorPath, { lstat, realpath });
    } catch {
      throw osDeleteProtectedError();
    }
    if (candidate.resolvedPath === survivor.resolvedPath
        || hasSameIdentity(candidate.resolvedIdentity, survivor.resolvedIdentity)
        // A represented symlink located inside this folder is itself moved to
        // Trash when the folder is moved, even if that symlink resolves outside
        // the folder. Protect both the resolved target hierarchy and the
        // normalized lexical hierarchy; protection-list entries can only make
        // this destructive operation refuse, never expand its authority.
        || (candidate.isDirectory && (
          isResolvedDescendant(candidate.resolvedPath, survivor.resolvedPath)
          || isResolvedDescendant(candidate.normalizedPath, survivor.normalizedPath)
        ))) {
      throw osDeleteProtectedError();
    }
  }
  return safePath;
}

/**
 * Share one durable directory watcher per target path. Watching the file itself
 * is not durable: an atomic save replaces its inode, which makes macOS stop
 * delivering later events through that watcher. A parent-directory watch keeps
 * following the same basename across each replacement.
 *
 * `start()` reserves the sender count before its asynchronous access check. A
 * React effect cleanup can therefore call `stop()` while that check is pending
 * without allowing a late registration to leak a watcher/client count.
 */
export function createFileWatchRegistry({
  watch = fs.watch,
  watchFile = fs.watchFile,
  unwatchFile = fs.unwatchFile,
  access = fs.promises.access,
  realpath = fs.promises.realpath,
  retryMs = 1000,
  pollInterval = 1000,
  // A directory watcher can remain open while silently dropping one rename on
  // a virtual, networked, or heavily loaded filesystem. One bounded stat per
  // second is still low-frequency beside the 20ms failure fallback, but keeps
  // an atomic save from becoming invisible to an otherwise healthy watcher for
  // half a minute.
  verificationInterval = 1_000,
  onError = (error, filePath) => logger.warn(`[FileSystem] Watcher error for ${filePath}:`, error),
} = {}) {
  const activeWatchers = new Map();
  const MISSING_WATCH_TARGET_CODES = new Set(['ENOENT', 'ENOTDIR']);

  const broadcast = (filePath, entry) => {
    if (activeWatchers.get(filePath) !== entry) return;
    for (const clientSender of [...entry.clients.keys()]) {
      try {
        if (clientSender.isDestroyed()) {
          removeSender(clientSender, filePath, { all: true });
        } else {
          clientSender.send('file-changed', filePath);
        }
      } catch {
        // WebContents can be destroyed between isDestroyed() and send(). Do
        // not let a native fs callback throw; release every refcount it owns.
        removeSender(clientSender, filePath, { all: true });
      }
    }
  };

  const stopPolling = (filePath, entry) => {
    if (!entry.pollListener) return;
    try { unwatchFile(entry.watchPath || filePath, entry.pollListener); } catch { /* ignore */ }
    entry.pollListener = null;
  };

  const stopVerificationPolling = (filePath, entry) => {
    if (!entry.verificationPollListener) return;
    try {
      unwatchFile(entry.verificationPath || entry.watchPath || filePath, entry.verificationPollListener);
    } catch { /* ignore */ }
    entry.verificationPollListener = null;
    entry.verificationPath = null;
  };

  const closeEntry = (filePath, entry) => {
    if (activeWatchers.get(filePath) !== entry) return;
    activeWatchers.delete(filePath);
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
    if (entry.aliasRetryTimer) clearTimeout(entry.aliasRetryTimer);
    entry.aliasRetryTimer = null;
    stopPolling(filePath, entry);
    stopVerificationPolling(filePath, entry);
    stopAliasPolling(filePath, entry);
    try { entry.watcher?.close(); } catch { /* ignore */ }
    entry.watcher = null;
    try { entry.aliasWatcher?.close(); } catch { /* ignore */ }
    entry.aliasWatcher = null;
    entry.rebindQueued = false;
  };

  const scheduleRetry = (filePath, entry) => {
    if (entry.retryTimer || activeWatchers.get(filePath) !== entry || entry.clients.size === 0) return;
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      attachNativeWatcher(filePath, entry);
    }, retryMs);
  };

  const scheduleAliasRetry = (filePath, entry) => {
    if (entry.aliasRetryTimer || activeWatchers.get(filePath) !== entry || entry.clients.size === 0) return;
    entry.aliasRetryTimer = setTimeout(() => {
      entry.aliasRetryTimer = null;
      attachAliasWatcher(filePath, entry);
    }, retryMs);
  };

  const recoverNativeWatcher = (filePath, entry, watcher, error = null) => {
    // Both a real FSWatcher error and an unexpected close mean this native
    // subscription is no longer trustworthy. Deliberate shutdown removes the
    // entry first, and error recovery clears entry.watcher before close(), so
    // those later close events cannot start a duplicate fallback/retry loop.
    if (entry.watcher !== watcher || activeWatchers.get(filePath) !== entry) return;
    entry.watcher = null;
    try { watcher.close(); } catch { /* ignore */ }
    if (error) onError(error, filePath);
    // A close can stand in for the final directory event. Refresh
    // conservatively, then retain subscribers with polling until reattach.
    broadcast(filePath, entry);
    startPolling(filePath, entry);
    void rebindLexicalTarget(filePath, entry);
    scheduleRetry(filePath, entry);
  };

  const startPolling = (filePath, entry) => {
    if (entry.pollListener || activeWatchers.get(filePath) !== entry || entry.clients.size === 0) return;
    // The high-frequency fallback poll subsumes the healthy-native-watch
    // verifier while the latter is detached/unavailable.
    stopVerificationPolling(filePath, entry);
    const pollListener = (current, previous) => {
      if (activeWatchers.get(filePath) !== entry || entry.pollListener !== pollListener) return;
      if (current.mtimeMs !== previous.mtimeMs
          || current.ctimeMs !== previous.ctimeMs
          || current.size !== previous.size
          || current.ino !== previous.ino
          || current.nlink !== previous.nlink) {
        // A native watcher can be unavailable while a regular lexical file is
        // replaced by a symlink. Re-resolve before future events follow an old
        // directory as though it were still the target.
        void rebindLexicalTarget(filePath, entry);
        broadcast(filePath, entry);
      }
    };
    entry.pollListener = pollListener;
    try {
      // Follow the canonical target just like the native directory watcher.
      // fs.watchFile usually follows a final symlink itself, but explicitly
      // using the resolved path also covers aliases whose parent differs from
      // their target's parent.
      watchFile(entry.watchPath || filePath, { interval: pollInterval }, pollListener);
    } catch (error) {
      entry.pollListener = null;
      onError(error, filePath);
    }
  };

  const startVerificationPolling = (filePath, entry) => {
    if (entry.verificationPollListener || activeWatchers.get(filePath) !== entry
        || entry.clients.size === 0 || entry.pollListener) return;
    const verificationPath = entry.watchPath || filePath;
    const pollListener = (current, previous) => {
      if (activeWatchers.get(filePath) !== entry
          || entry.verificationPollListener !== pollListener) return;
      if (current.mtimeMs !== previous.mtimeMs
          || current.ctimeMs !== previous.ctimeMs
          || current.size !== previous.size
          || current.ino !== previous.ino
          || current.nlink !== previous.nlink) {
        // fs.watch may silently lose events on network/virtual filesystems.
        // Keep a deliberately low-frequency stat check even while its native
        // directory watcher remains live, so an otherwise invisible change
        // still reaches the renderer and rebinds a replaced lexical target.
        void rebindLexicalTarget(filePath, entry);
        broadcast(filePath, entry);
      }
    };
    entry.verificationPollListener = pollListener;
    entry.verificationPath = verificationPath;
    try {
      watchFile(verificationPath, { interval: verificationInterval }, pollListener);
    } catch (error) {
      entry.verificationPollListener = null;
      entry.verificationPath = null;
      onError(error, filePath);
    }
  };

  const stopAliasPolling = (filePath, entry) => {
    if (!entry.aliasPollListener) return;
    try { unwatchFile(filePath, entry.aliasPollListener); } catch { /* ignore */ }
    entry.aliasPollListener = null;
  };

  const startAliasPolling = (filePath, entry) => {
    if (entry.aliasPollListener || activeWatchers.get(filePath) !== entry || entry.clients.size === 0) return;
    const pollListener = (current, previous) => {
      if (activeWatchers.get(filePath) !== entry || entry.aliasPollListener !== pollListener) return;
      if (current.mtimeMs !== previous.mtimeMs
          || current.ctimeMs !== previous.ctimeMs
          || current.size !== previous.size
          || current.ino !== previous.ino
          || current.nlink !== previous.nlink) {
        void rebindLexicalTarget(filePath, entry);
      }
    };
    entry.aliasPollListener = pollListener;
    try {
      // Poll the lexical path rather than the resolved target so an absent
      // filename can become observable when it is created later.
      watchFile(filePath, { interval: pollInterval }, pollListener);
      // watchFile starts from a snapshot; probe after registration so creation
      // during setup is not lost as an initial baseline.
      void rebindLexicalTarget(filePath, entry);
    } catch (error) {
      entry.aliasPollListener = null;
      onError(error, filePath);
    }
  };

  const detachTargetWatch = (filePath, entry) => {
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
    stopPolling(filePath, entry);
    stopVerificationPolling(filePath, entry);
    const watcher = entry.watcher;
    entry.watcher = null;
    try { watcher?.close(); } catch { /* ignore */ }
  };

  const needsAliasWatch = (entry) => entry.aliasDir !== entry.dir || entry.aliasBasename !== entry.basename;
  const needsLexicalWatch = (entry) => entry.awaitingTarget || needsAliasWatch(entry);

  const detachAliasWatch = (entry) => {
    if (entry.aliasRetryTimer) clearTimeout(entry.aliasRetryTimer);
    entry.aliasRetryTimer = null;
    stopAliasPolling(entry.filePath, entry);
    const watcher = entry.aliasWatcher;
    entry.aliasWatcher = null;
    try { watcher?.close(); } catch { /* ignore */ }
  };

  const attachNativeWatcher = (filePath, entry) => {
    if (entry.watcher || activeWatchers.get(filePath) !== entry || entry.clients.size === 0) return;
    let watcher = null;
    try {
      watcher = watch(entry.dir, (eventType, filename) => {
        if (entry.watcher !== watcher || activeWatchers.get(filePath) !== entry) return;
        // Some platforms omit filename. Forward those events conservatively:
        // they may be for this target, whereas a named sibling is provably not.
        if (filename != null && String(filename) !== entry.basename) return;
        // A regular path can itself be replaced by a final symlink. Normal
        // atomic saves resolve to the same target, while an actual retarget is
        // rebound asynchronously without ever changing the renderer contract.
        if (eventType === 'rename') void rebindLexicalTarget(filePath, entry);
        broadcast(filePath, entry);
      });
      entry.watcher = watcher;
      stopPolling(filePath, entry);
      startVerificationPolling(filePath, entry);
      watcher.on('error', (error) => {
        recoverNativeWatcher(filePath, entry, watcher, error);
      });
      watcher.once('close', () => recoverNativeWatcher(filePath, entry, watcher));
      // Close the realpath→watch attachment race for aliases and paths that
      // were replaced by a final symlink during setup.
      void rebindLexicalTarget(filePath, entry);
    } catch (error) {
      onError(error, filePath);
      startPolling(filePath, entry);
      scheduleRetry(filePath, entry);
    }
  };

  const recoverAliasWatcher = (filePath, entry, watcher, error = null) => {
    if (entry.aliasWatcher !== watcher || activeWatchers.get(filePath) !== entry) return;
    entry.aliasWatcher = null;
    try { watcher.close(); } catch { /* ignore */ }
    if (error) onError(error, filePath);
    // A close/error may have hidden an alias replacement. Re-resolve now and
    // keep retrying the lexical parent watcher while clients remain.
    void rebindLexicalTarget(filePath, entry);
    startAliasPolling(filePath, entry);
    scheduleAliasRetry(filePath, entry);
  };

  const attachAliasWatcher = (filePath, entry) => {
    if (!needsLexicalWatch(entry) || entry.aliasWatcher
        || activeWatchers.get(filePath) !== entry || entry.clients.size === 0) return;
    let watcher = null;
    try {
      watcher = watch(entry.aliasDir, (_eventType, filename) => {
        if (entry.aliasWatcher !== watcher || activeWatchers.get(filePath) !== entry) return;
        // A null filename is not safely ignorable: it can be the alias itself.
        if (filename != null && String(filename) !== entry.aliasBasename) return;
        void rebindLexicalTarget(filePath, entry);
      });
      entry.aliasWatcher = watcher;
      stopAliasPolling(filePath, entry);
      watcher.on('error', (error) => recoverAliasWatcher(filePath, entry, watcher, error));
      watcher.once('close', () => recoverAliasWatcher(filePath, entry, watcher));
      // The lexical watcher is now armed; immediately re-resolve so a creation
      // or retarget inside watch() setup cannot be missed indefinitely.
      void rebindLexicalTarget(filePath, entry);
    } catch (error) {
      onError(error, filePath);
      startAliasPolling(filePath, entry);
      scheduleAliasRetry(filePath, entry);
    }
  };

  const rebindLexicalTarget = async (filePath, entry) => {
    if (activeWatchers.get(filePath) !== entry || entry.clients.size === 0) return;
    if (entry.rebinding) {
      entry.rebindQueued = true;
      return;
    }
    entry.rebinding = true;
    try {
      const canonicalPath = await realpath(filePath);
      if (activeWatchers.get(filePath) !== entry || entry.clients.size === 0) return;
      if (canonicalPath === entry.watchPath && !entry.awaitingTarget) return;

      // Keep the old target alive until the new referent is known. This avoids
      // losing the only parent watcher during a delete-then-create symlink swap.
      detachTargetWatch(filePath, entry);
      entry.watchPath = canonicalPath;
      entry.dir = path.dirname(canonicalPath);
      entry.basename = path.basename(canonicalPath);
      entry.awaitingTarget = false;
      attachNativeWatcher(filePath, entry);
      if (needsAliasWatch(entry)) attachAliasWatcher(filePath, entry);
      else detachAliasWatch(entry);
      // The lexical node now refers to another file, even if the target emitted
      // no content event. Tell its renderer session to reread/classify it.
      broadcast(filePath, entry);
    } catch (error) {
      // A dangling alias commonly occurs during delete-then-create replacement.
      // Retain the old target watcher until a later lexical event can rebind.
      if (activeWatchers.get(filePath) === entry && entry.clients.size > 0
          && !(entry.awaitingTarget && MISSING_WATCH_TARGET_CODES.has(error?.code))) {
        onError(error, filePath);
      }
    } finally {
      if (activeWatchers.get(filePath) === entry) {
        entry.rebinding = false;
        if (entry.rebindQueued) {
          entry.rebindQueued = false;
          void rebindLexicalTarget(filePath, entry);
        }
      }
    }
  };

  const removeSender = (sender, filePath, { all = false } = {}) => {
    const entry = activeWatchers.get(filePath);
    if (!entry || !entry.clients.has(sender)) return;
    const remaining = all ? 0 : entry.clients.get(sender) - 1;
    if (remaining > 0) entry.clients.set(sender, remaining);
    else entry.clients.delete(sender);
    if (entry.clients.size === 0) closeEntry(filePath, entry);
  };

  const ensureSenderCleanup = (sender) => {
    if (sender.__fsWatchCleanupAttached) return;
    sender.__fsWatchCleanupAttached = true;
    sender.once('destroyed', () => {
      for (const filePath of [...activeWatchers.keys()]) {
        removeSender(sender, filePath, { all: true });
      }
    });
  };

  const start = async (sender, filePath) => {
    // IPC may be queued just as a renderer is torn down. Do not reserve a
    // client count or attach its destroyed WebContents to cleanup bookkeeping.
    if (!sender || sender.isDestroyed?.()) return;
    let entry = activeWatchers.get(filePath);
    if (entry) {
      entry.clients.set(sender, (entry.clients.get(sender) || 0) + 1);
      ensureSenderCleanup(sender);
      await entry.starting;
      return;
    }

    entry = {
      clients: new Map([[sender, 1]]),
      filePath,
      aliasDir: path.dirname(filePath),
      aliasBasename: path.basename(filePath),
      dir: path.dirname(filePath),
      basename: path.basename(filePath),
      // The registry remains keyed by the renderer spelling so start/stop and
      // broadcasts retain their existing contract. The OS watcher follows the
      // canonical target, however: a final symlink can live in a completely
      // different directory from the file it resolves to.
      watchPath: filePath,
      watcher: null,
      aliasWatcher: null,
      aliasPollListener: null,
      pollListener: null,
      verificationPollListener: null,
      verificationPath: null,
      retryTimer: null,
      aliasRetryTimer: null,
      rebinding: false,
      rebindQueued: false,
      awaitingTarget: false,
      starting: null,
    };
    activeWatchers.set(filePath, entry);
    ensureSenderCleanup(sender);

    entry.starting = (async () => {
      try {
        await access(filePath);
        // A cleanup may have removed the reservation while access was pending.
        if (activeWatchers.get(filePath) !== entry || entry.clients.size === 0) return;

        const canonicalPath = await realpath(filePath);
        // The caller can unmount while realpath is in flight too. Do not let
        // that late result resurrect a closed entry or attach a watcher.
        if (activeWatchers.get(filePath) !== entry || entry.clients.size === 0) return;
        entry.watchPath = canonicalPath;
        entry.dir = path.dirname(canonicalPath);
        entry.basename = path.basename(canonicalPath);

        attachNativeWatcher(filePath, entry);
        attachAliasWatcher(filePath, entry);
      } catch (error) {
        if (MISSING_WATCH_TARGET_CODES.has(error?.code)
            && activeWatchers.get(filePath) === entry && entry.clients.size > 0) {
          // Retain one exact lexical parent subscription for a missing path.
          // Other validation/permission failures still reject and clean up.
          entry.awaitingTarget = true;
          attachAliasWatcher(filePath, entry);
          return;
        }
        closeEntry(filePath, entry);
        throw error;
      } finally {
        entry.starting = null;
      }
    })();
    await entry.starting;
  };

  return { start, stop: (sender, filePath) => removeSender(sender, filePath) };
}

const fileWatchRegistry = createFileWatchRegistry();

/**
 * Module-level recursive directory scanner.
 * Uses lstat to detect symlinks and a `visited` realpath set to prevent loops.
 *
 * The walk is strictly sequential — children are awaited one at a time in the
 * for-loop below, so at most one readdir/lstat is ever in flight. A previous
 * activeScans/MAX_SCAN_CONCURRENCY busy-wait gate was removed: with sequential
 * recursion `activeScans` only ever equaled the current depth, so on any tree
 * deeper than the core count every live frame held a slot while awaiting its
 * single descendant and the gate could never drain — a hard deadlock (the only
 * escape was closing the window). Being serial, the scan needs no EMFILE bound.
 */
async function scanPath(currentPath, visited, sender = null, depth = 0) {
  // Prevent infinite recursion from symlink loops or massive trees
  if (depth > 15) return null;

  // Guard: Abort recursion if the window that requested it was closed
  if (sender && sender.isDestroyed()) return null;

  try {
    let realPath = currentPath;
    try { realPath = await fs.promises.realpath(currentPath); } catch { /* ignore */ }
    if (visited.has(realPath)) return null;
    visited.add(realPath);

    // Skip notoriously large or transient directories/files to prevent thread lock/pollution
    const base = path.basename(currentPath);
    if (base === 'node_modules' || base === '.git' || base === '.DS_Store' || base.endsWith('.tmp')) return null;

    // Use lstat to handle symlinks correctly (don't blindly follow if we've seen the path)
    const stats = await fs.promises.lstat(currentPath);
    
    if (stats.isDirectory()) {
      const dirItems = await fs.promises.readdir(currentPath);
      
      // Process sub-directories sequentially or in small batches to preserve concurrency limit
      const children = [];
      for (const item of dirItems) {
        const child = await scanPath(path.join(currentPath, item), visited, sender, depth + 1);
        if (child) children.push(child);
        if (sender && sender.isDestroyed()) return null;
      }
      
      return {
        id: 'group-' + randomUUID(),
        type: 'group',
        title: base || currentPath,
        filePath: currentPath,
        collapsed: true,
        items: children,
      };
    }
    
    return {
      id: 'doc-' + randomUUID(),
      type: 'document',
      filename: base,
      filePath: currentPath,
    };
  } catch (err) {
    // Possible edge case: file deleted between readdir and lstat
    logger.warn(`[Filesystem] Skipping inaccessible path: ${currentPath}`, err?.message || String(err));
    return null;
  }
}

/**
 * Helper to perform an atomic write (write to tmp then rename).
 */
// Cleanup is deliberately age-gated for artifacts from another interrupted
// process. Temps created by this process receive the stronger exact-path guard
// below, even if an unusually slow write outlives that age threshold.
const activeOwnedTempPaths = new Set();

export async function atomicWriteFile(targetPath, data) {
  let finalPath = targetPath;
  try {
    // Resolve symlinks so we write to the actual destination, preserving the link structure
    finalPath = await fs.promises.realpath(targetPath);
  } catch {
    // If realpath fails (e.g. file doesn't exist yet), use targetPath as-is
  }

  const tmpPath = `${finalPath}.__ic_atomic_${randomUUID()}.tmp`;
  let mode = 0o600;
  try { mode = (await fs.promises.stat(finalPath)).mode & 0o777; }
  catch { /* New files default to owner-only; existing files keep their mode. */ }
  activeOwnedTempPaths.add(tmpPath);
  try {
    const handle = await fs.promises.open(tmpPath, 'w', mode);
    try {
      await handle.writeFile(data, { encoding: 'utf8' });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(tmpPath, finalPath);
    const directory = await fs.promises.open(path.dirname(finalPath), 'r').catch(() => null);
    if (directory) {
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } catch (err) {
    // Clean up tmp file if write succeeded but rename failed
    try { await fs.promises.unlink(tmpPath); } catch { /* ignore */ }
    throw err;
  } finally {
    activeOwnedTempPaths.delete(tmpPath);
  }
}

const RECOVERY_REBIND_JOURNAL_VERSION = 1;
function recoveryRebindJournalPath(oldCanvasPath, newCanvasPath, journalDirectory = path.dirname(newCanvasPath)) {
  const digest = createHash('sha256').update(`${path.resolve(oldCanvasPath)}\u0000${path.resolve(newCanvasPath)}`).digest('hex').slice(0, 24);
  return path.join(journalDirectory, `.ic-recovery-rebind-${digest}.json`);
}

function recoveryRebindJournalPaths(oldCanvasPath, newCanvasPath) {
  const targetJournal = recoveryRebindJournalPath(oldCanvasPath, newCanvasPath);
  const sourceDirectory = path.dirname(oldCanvasPath);
  return sourceDirectory === path.dirname(newCanvasPath)
    ? [targetJournal]
    : [targetJournal, recoveryRebindJournalPath(oldCanvasPath, newCanvasPath, sourceDirectory)];
}

async function writeRecoveryRebindJournal(journalPath, journal) {
  const existing = await fs.promises.lstat(journalPath).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error('Recovery rebind journal path is unsafe.');
  }
  if (existing) {
    // The deterministic journal name is an ownership slot, not an invitation
    // to overwrite a user-created regular JSON file or a stale transaction.
    // Only this exact transaction may advance its own prepared record to the
    // canvas-written phase (or rewrite the same phase after a retry).
    const prior = await readRecoveryRebindJournal(journalPath);
    const sameOwner = prior
      && path.resolve(prior.oldCanvasPath) === path.resolve(journal.oldCanvasPath)
      && path.resolve(prior.newCanvasPath) === path.resolve(journal.newCanvasPath)
      && prior.canvasDigest === journal.canvasDigest
      && prior.previousTargetDigest === journal.previousTargetDigest
      && JSON.stringify(prior.renameAttestation || null) === JSON.stringify(journal.renameAttestation || null);
    const allowedPhase = sameOwner
      && ((prior.phase === journal.phase) || (prior.phase === 'prepared' && journal.phase === 'canvas-written'));
    if (!allowedPhase) throw new Error('Recovery rebind journal path conflicts with another transaction.');
  }
  const temp = `${journalPath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.promises.open(temp, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(journal)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    // rename replaces only the journal directory entry; unlike atomicWriteFile
    // it never follows a pre-existing journal symlink.
    await fs.promises.rename(temp, journalPath);
    const directory = await fs.promises.open(path.dirname(journalPath), 'r').catch(() => null);
    if (directory) {
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    await handle?.close().catch(() => {});
    await fs.promises.unlink(temp).catch(() => {});
  }
}

async function readRecoveryRebindJournal(journalPath) {
  try {
    const stat = await fs.promises.lstat(journalPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) return null;
    const parsed = JSON.parse(await fs.promises.readFile(journalPath, 'utf8'));
    if (parsed?.version !== RECOVERY_REBIND_JOURNAL_VERSION
      || typeof parsed.oldCanvasPath !== 'string' || typeof parsed.newCanvasPath !== 'string'
      || !/^[a-f0-9]{64}$/.test(parsed.canvasDigest || '')
      || !(parsed.previousTargetDigest == null || /^[a-f0-9]{64}$/.test(parsed.previousTargetDigest))
      || !(parsed.renameAttestation == null
        || (Number.isSafeInteger(parsed.renameAttestation.dev) && Number.isSafeInteger(parsed.renameAttestation.ino)
          && parsed.renameAttestation.ino > 0))) return null;
    const oldPath = path.resolve(parsed.oldCanvasPath);
    const newPath = path.resolve(parsed.newCanvasPath);
    if (!recoveryRebindJournalPaths(oldPath, newPath).includes(journalPath)
      || !['prepared', 'canvas-written'].includes(parsed.phase)) return null;
    return parsed;
  } catch { return null; }
}

async function fsyncDirectory(directory) {
  const handle = await fs.promises.open(directory, 'r').catch(() => null);
  if (!handle) return;
  try { await handle.sync(); } finally { await handle.close(); }
}

async function clearRecoveryRebindJournals(oldCanvasPath, newCanvasPath) {
  const journalPaths = recoveryRebindJournalPaths(oldCanvasPath, newCanvasPath);
  await Promise.all(journalPaths.map(journalPath => fs.promises.unlink(journalPath).catch(error => {
    if (error?.code !== 'ENOENT') throw error;
  })));
  await Promise.all([...new Set(journalPaths.map(journalPath => path.dirname(journalPath)))].map(fsyncDirectory));
}

/**
 * Validate a renderer-requested mutation target. Canvas JSON is portable and
 * therefore untrusted: a node can claim an arbitrary path, but it must not use
 * the delete/editor IPC to modify credentials, system state, or the canvas file
 * that is currently open. Returns the normalized path the OS operation should
 * receive (preserving a final symlink rather than trashing its target).
 */
async function inspectMutablePath(filePath, { sender = null, textOnly = false } = {}) {
  if (typeof filePath !== 'string' || !filePath.trim() || !path.isAbsolute(filePath)) {
    throw new Error('A valid absolute file path is required.');
  }
  const normalizedPath = path.normalize(filePath);
  const resolvedPath = await fs.promises.realpath(normalizedPath);
  if (isSensitivePath(normalizedPath) || isSensitivePath(resolvedPath)) {
    throw new Error('Modifying this sensitive system or credential path is restricted.');
  }
  if (textOnly && !isAllowedTextEditExt(resolvedPath)) {
    throw new Error('Only .md and .txt documents can be edited from the canvas.');
  }

  const targetStat = await fs.promises.lstat(resolvedPath);
  if (textOnly && (!targetStat.isFile() || targetStat.isSymbolicLink())) {
    throw new Error('Only regular text files can be edited from the canvas.');
  }

  if (sender?.__canvasPath) {
    let canvasPath = path.resolve(sender.__canvasPath);
    try { canvasPath = await fs.promises.realpath(canvasPath); } catch { /* stale canvas path */ }
    const containsCanvas = targetStat.isDirectory() && isWithinDirectory(resolvedPath, canvasPath);
    if (resolvedPath === canvasPath || containsCanvas) {
      throw new Error('The open canvas (or a folder containing it) cannot be modified through a canvas node.');
    }
  }

  if (!textOnly) return { normalizedPath, resolvedPath };
  const expectedParentPath = path.dirname(resolvedPath);
  const parentPath = await fs.promises.realpath(expectedParentPath);
  if (parentPath !== expectedParentPath
      || await fs.promises.realpath(normalizedPath) !== resolvedPath) {
    throw new Error('The text file path changed while it was being validated.');
  }
  const parentStat = await fs.promises.lstat(parentPath);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error('The text file parent must be a regular directory.');
  }
  return {
    normalizedPath,
    resolvedPath,
    parentPath,
    targetIdentity: { dev: targetStat.dev, ino: targetStat.ino },
    parentIdentity: { dev: parentStat.dev, ino: parentStat.ino },
    mode: targetStat.mode & 0o777,
  };
}

/**
 * Whether the spelling supplied by the renderer traverses any symlink. This
 * is deliberately lexical: realpath alone cannot distinguish a harmless
 * case/Unicode spelling difference from a final symlink that can later be
 * retargeted. It is used only to opt a read into renderer session sharing;
 * failures are conservatively treated as alias-unsafe by the caller.
 */
async function pathContainsSymlinkComponent(normalizedPath) {
  const root = path.parse(normalizedPath).root;
  const relative = path.relative(root, normalizedPath);
  let current = root;
  for (const segment of relative.split(path.sep)) {
    if (!segment) continue;
    current = path.join(current, segment);
    if ((await fs.promises.lstat(current)).isSymbolicLink()) return true;
  }
  return false;
}

/**
 * Validate a renderer-requested mutation target. Text edits return the
 * canonical target rather than the caller-controlled symlink spelling; delete
 * keeps the lexical path so trashing a link does not trash its referent.
 */
export async function validateMutablePath(filePath, { sender = null, textOnly = false } = {}) {
  const inspected = await inspectMutablePath(filePath, { sender, textOnly });
  return textOnly ? inspected.resolvedPath : inspected.normalizedPath;
}

function hasSameIdentity(stat, identity) {
  return stat.dev === identity.dev && stat.ino === identity.ino;
}

const TEXT_TARGET_REPLACEMENT_CODES = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'ESTALE']);
const TEXT_TARGET_REVALIDATION_MESSAGE = 'The text file path changed while it was being validated.';
const TEXT_FILE_HARDLINK_UNSUPPORTED = 'TEXT_FILE_HARDLINK_UNSUPPORTED';
// This code has deliberately narrower semantics than a generic write error:
// the replacement has already reached the filesystem, but the parent directory
// could not be synced after it. The renderer must retain it until an idempotent
// retry verifies that durability barrier rather than treating its own watcher
// notification as a normal successful save.
const TEXT_FILE_DURABILITY_UNVERIFIED = 'TEXT_FILE_DURABILITY_UNVERIFIED';
const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set(['EISDIR', 'EINVAL', 'ENOTSUP', 'EOPNOTSUPP']);

function textFileConflictError() {
  const error = new Error('The text file changed since this edit was loaded.');
  error.code = 'TEXT_FILE_CONFLICT';
  return error;
}

function textFileHardlinkUnsupportedError() {
  const error = new Error(
    'Text files with multiple hard links cannot be edited safely. Break the hard link before saving changes.',
  );
  error.code = TEXT_FILE_HARDLINK_UNSUPPORTED;
  return error;
}

function throwTextTargetMutationAsConflict(error) {
  if (TEXT_TARGET_REPLACEMENT_CODES.has(error?.code)
      || error?.message === TEXT_TARGET_REVALIDATION_MESSAGE) {
    throw textFileConflictError();
  }
  throw error;
}

async function withTextTargetMutationConflict(operation) {
  try {
    return await operation();
  } catch (error) {
    throwTextTargetMutationAsConflict(error);
  }
}

async function assertMutableTextTargetIdentity(target) {
  const [targetStat, currentResolvedPath] = await withTextTargetMutationConflict(() => Promise.all([
    fs.promises.lstat(target.resolvedPath),
    // The canonical inode alone is insufficient for a lexical symlink path:
    // L can be retargeted from A to B after inspection while A remains intact.
    // Every post-I/O assertion must prove that the caller's original spelling
    // still resolves to the target identity we approved.
    fs.promises.realpath(target.normalizedPath),
  ]));
  if (!targetStat.isFile() || targetStat.isSymbolicLink()
      || !hasSameIdentity(targetStat, target.targetIdentity)
      || currentResolvedPath !== target.resolvedPath) {
    throw textFileConflictError();
  }
  await assertMutableTextParentIdentity(target);
  return targetStat;
}

async function assertMutableTextTargetSingleLink(target) {
  const targetStat = await assertMutableTextTargetIdentity(target);
  // Atomic rename replaces one directory entry, which would silently detach
  // this spelling from every other hard link. Reads are harmless and an
  // idempotent parent-fsync retry is still allowed, but a content-changing
  // replacement must reject rather than splitting what appeared to be one file.
  if (targetStat.nlink > 1) throw textFileHardlinkUnsupportedError();
}

async function assertMutableTextParentIdentity(target) {
  const [parentStat, currentParentPath] = await withTextTargetMutationConflict(() => Promise.all([
    fs.promises.lstat(target.parentPath),
    fs.promises.realpath(target.parentPath),
  ]));
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
      || currentParentPath !== target.parentPath
      || !hasSameIdentity(parentStat, target.parentIdentity)) {
    throw textFileConflictError();
  }
}

/**
 * A synced temporary file alone is not a durable atomic replacement: the
 * directory entry created by rename must also reach stable storage. POSIX
 * permits fsync on a directory; Windows does not reliably expose a directory
 * handle, so only that known unsupported shape is a successful no-op. Other
 * errors deliberately surface after the rename: the next idempotent CAS retry
 * will sync the directory again rather than claiming an unverified save.
 */
export async function syncTextParentDirectory(parentPath, {
  open = fs.promises.open,
  platform = process.platform,
} = {}) {
  let directoryHandle = null;
  try {
    directoryHandle = await open(parentPath, 'r');
    await directoryHandle.sync();
    return true;
  } catch (error) {
    const unsupported = UNSUPPORTED_DIRECTORY_SYNC_CODES.has(error?.code)
      || (platform === 'win32' && error?.code === 'EPERM');
    if (unsupported) return false;
    throw error;
  } finally {
    // A close failure means the durability barrier was not fully observed; do
    // not mask it as a successful save.
    if (directoryHandle) await directoryHandle.close();
  }
}

async function syncValidatedTextWriteParent(parentPath) {
  try {
    await syncTextParentDirectory(parentPath);
  } catch (error) {
    const durabilityError = new Error(
      'The text file was replaced, but its containing directory could not be synchronized. Retry the save to confirm it is durable.',
    );
    durabilityError.code = TEXT_FILE_DURABILITY_UNVERIFIED;
    durabilityError.durabilityErrorCode = error?.code;
    throw durabilityError;
  }
}

/**
 * Read an editable text document through the exact same validated UTF-8 path
 * used by compare-and-swap writes. In particular, do not route an editor
 * baseline through Response.text(): the web UTF-8 decoder removes a leading
 * BOM, whereas Node's UTF-8 strings (and the writer's CAS baseline) retain it.
 *
 * This read intentionally does not acquire the write FIFO. A later atomic
 * replacement is harmless: the CAS writer remains the final authority and
 * reports a normal conflict rather than overwriting a newer disk version. The
 * canonical path is a stable logical-target token: it survives this writer's
 * atomic inode replacement, but changes if a lexical final symlink is retargeted.
 */
export async function readValidatedTextFile(filePath, { sender = null } = {}) {
  const target = await inspectMutablePath(filePath, { sender, textOnly: true });
  // Sweep only this opened document directory, asynchronously and with the
  // stale-age guard below, so text temp recovery never delays a read or
  // touches a live writer's private temp.
  void cleanupTempFiles(target.parentPath).catch((error) => {
    logger.warn(`[FileSystem] Text temp cleanup failed for ${target.parentPath}:`, error);
  });
  const content = await withTextTargetMutationConflict(
    () => fs.promises.readFile(target.resolvedPath, 'utf8'),
  );
  // Do not hand the renderer a baseline from a target that was replaced while
  // it was being read. The resulting conflict/read error is safer than a
  // misleading expected-content value for a different inode.
  await assertMutableTextTargetIdentity(target);
  let sessionIdentityToken;
  let directIdentityCandidate = false;
  try {
    // A direct path may differ from realpath only in case or Unicode form and
    // is safe to coalesce. Any symlink component is deliberately omitted: its
    // target token remains a CAS precondition, but it must never select or be
    // selected as a shared renderer editing session.
    directIdentityCandidate = !await pathContainsSymlinkComponent(target.normalizedPath);
  } catch {
    // Sharing is an optimization; ambiguity must preserve independent sessions.
  }
  if (directIdentityCandidate) {
    // Classification itself walks the lexical path asynchronously. Re-prove
    // both the referent and parent after that walk, then classify once more,
    // so a direct→symlink or symlink→direct replacement spanning the
    // original post-read assertion cannot receive a stale merge token. These
    // identity assertions deliberately live outside the best-effort catch:
    // returning old bytes after a proven path change would be unsafe even if
    // sharing were disabled.
    await assertMutableTextTargetIdentity(target);
    let remainedDirect = false;
    try {
      remainedDirect = !await pathContainsSymlinkComponent(target.normalizedPath);
    } catch {
      // Sharing is an optimization; ambiguity must preserve independent sessions.
    }
    if (remainedDirect) {
      await assertMutableTextTargetIdentity(target);
      sessionIdentityToken = target.resolvedPath;
    }
  }
  return { content, targetToken: target.resolvedPath, sessionIdentityToken };
}

// Text writes originate from independent document nodes (and potentially
// independent renderer windows), so their renderer-side write chains cannot
// serialize each other. Keep the critical compare-and-replace sequence FIFO
// per real path in the main process instead. Each tail is always resolved in
// `finally`, so a rejected write can never poison later saves for that file.
const textWriteLocks = new Map();

async function withTextWriteLock(canonicalPath, operation) {
  const previous = textWriteLocks.get(canonicalPath) || Promise.resolve();
  let release;
  const tail = new Promise((resolve) => { release = resolve; });
  textWriteLocks.set(canonicalPath, tail);

  // A prior operation may reject; its `finally` has still released its tail,
  // and this operation must retain FIFO ordering rather than inherit its error.
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (textWriteLocks.get(canonicalPath) === tail) textWriteLocks.delete(canonicalPath);
  }
}

const RETRY_TEXT_WRITE_WITH_NEW_CANONICAL_PATH = Symbol('retry-text-write-with-new-canonical-path');

/**
 * Validate and atomically replace an existing text document without following
 * a caller-controlled path again after validation. Identity checks before and
 * after creating the private temporary file close the useful symlink/rename
 * swap windows available through the renderer IPC. The final rename replaces a
 * last-moment target symlink itself; it never follows that link.
 */
export async function writeValidatedTextFile(filePath, content, {
  sender = null,
  expectedContent,
  expectedTargetToken,
} = {}) {
  if (typeof content !== 'string') throw new Error('Text file content must be a string.');
  if (expectedContent !== undefined && typeof expectedContent !== 'string') {
    throw new Error('Expected text content must be a string when provided.');
  }
  if (expectedTargetToken !== undefined && typeof expectedTargetToken !== 'string') {
    throw new Error('Expected text target token must be a string when provided.');
  }

  // Resolve once to choose a canonical lock. Re-resolve after acquiring it: a
  // symlink could have been repointed while queued, in which case release this
  // lock and join the FIFO for the newly resolved canonical target instead.
  for (;;) {
    let initialTarget;
    try {
      initialTarget = await inspectMutablePath(filePath, { sender, textOnly: true });
    } catch (error) {
      // A loaded editor supplies a baseline. If its target disappeared or the
      // final symlink changed before it reached the FIFO, surface the same
      // Reload/Keep mine decision instead of an opaque save failure. Legacy
      // callers intentionally keep their pre-existing validation semantics.
      if (expectedContent !== undefined || expectedTargetToken !== undefined) {
        throwTextTargetMutationAsConflict(error);
      }
      throw error;
    }
    void cleanupTempFiles(initialTarget.parentPath).catch((error) => {
      logger.warn(`[FileSystem] Text temp cleanup failed for ${initialTarget.parentPath}:`, error);
    });
    // Content alone cannot distinguish a delayed/missed watcher notification
    // after a final symlink L was retargeted from A to byte-identical B. Bind a
    // session's precondition to the canonical logical target it actually read.
    if (expectedTargetToken !== undefined && initialTarget.resolvedPath !== expectedTargetToken) {
      throw textFileConflictError();
    }
    const result = await withTextWriteLock(initialTarget.resolvedPath, async () => {
      const target = await withTextTargetMutationConflict(
        () => inspectMutablePath(filePath, { sender, textOnly: true }),
      );
      if (expectedTargetToken !== undefined && target.resolvedPath !== expectedTargetToken) {
        throw textFileConflictError();
      }
      if (target.resolvedPath !== initialTarget.resolvedPath) {
        // A precondition belongs to the file the renderer loaded. Retrying on
        // a newly repointed symlink would apply that old baseline to a different
        // referent, so surface the normal Reload/Keep mine decision instead.
        if (expectedContent !== undefined || expectedTargetToken !== undefined) {
          throw textFileConflictError();
        }
        return RETRY_TEXT_WRITE_WITH_NEW_CANONICAL_PATH;
      }

      await withTextTargetMutationConflict(
        () => fs.promises.access(target.resolvedPath, fs.constants.W_OK),
      );
      await assertMutableTextTargetIdentity(target);

      // Read only after the path and identity are established inside the lock.
      // A repeated write of the already-requested content is idempotent; every
      // other mismatch is a genuine stale-baseline conflict.
      const currentContent = await withTextTargetMutationConflict(
        () => fs.promises.readFile(target.resolvedPath, 'utf8'),
      );
      await assertMutableTextTargetIdentity(target);
      if (expectedContent !== undefined
          && currentContent !== expectedContent
          && currentContent !== content) {
        throw textFileConflictError();
      }
      // A prior invocation can complete rename and then fail its directory
      // sync. Treat an idempotent retry as another durability attempt rather
      // than returning success before the parent directory is confirmed.
      if (currentContent === content) {
        await syncValidatedTextWriteParent(target.parentPath);
        return target.resolvedPath;
      }

      // Check only after the idempotent branch above: hard-linked previews are
      // readable and an already-completed replacement can still retry its
      // directory durability barrier without changing content.
      await assertMutableTextTargetSingleLink(target);

      const tmpPath = path.join(target.parentPath, `.__ic_text_${randomUUID()}.tmp`);
      let tmpCreated = false;
      try {
        const handle = await withTextTargetMutationConflict(
          () => fs.promises.open(tmpPath, 'wx', target.mode),
        );
        tmpCreated = true;
        activeOwnedTempPaths.add(tmpPath);
        try {
          // fs.open applies process umask to its creation mode. Restore the
          // target's exact bits on the already-private O_EXCL temp before the
          // existing fsync so rename cannot drop group/other write access.
          await handle.chmod(target.mode);
          await handle.writeFile(content, { encoding: 'utf8' });
          await handle.sync();
        } finally {
          await handle.close();
        }
        await assertMutableTextTargetSingleLink(target);
        // Identity checks catch atomic replacement, but an external editor can
        // also modify this inode in place. Re-read immediately before rename so
        // an expected-baseline write does not overwrite that newer content.
        if (expectedContent !== undefined) {
          const contentBeforeRename = await withTextTargetMutationConflict(
            () => fs.promises.readFile(target.resolvedPath, 'utf8'),
          );
          await assertMutableTextTargetSingleLink(target);
          if (contentBeforeRename !== currentContent && contentBeforeRename !== content) {
            throw textFileConflictError();
          }
        }
        // Node exposes no descriptor-relative, no-follow rename that can pin a
        // mutable final symlink through this syscall. The immediately preceding
        // identity assertion rejects every observed retarget; a retarget in the
        // unavoidable final check→rename OS window can still replace the former
        // canonical referent (never the new symlink referent). A later CAS or
        // watcher reconciliation detects that change rather than redirecting a
        // write into the newly selected file.
        // A hard link may be added while the private temp is being written, so
        // repeat the freshly-lstat-verified single-link check immediately
        // before the irreversible directory-entry replacement.
        await assertMutableTextTargetSingleLink(target);
        await withTextTargetMutationConflict(() => fs.promises.rename(tmpPath, target.resolvedPath));
        tmpCreated = false;
        await syncValidatedTextWriteParent(target.parentPath);
        return target.resolvedPath;
      } finally {
        if (tmpCreated) {
          // Do not follow a replaced parent merely to clean up. If its identity no
          // longer matches, the old directory (and temp) is outside our safe handle.
          try {
            await assertMutableTextParentIdentity(target);
            await fs.promises.unlink(tmpPath);
          } catch { /* best-effort cleanup without traversing a changed parent */ }
        }
        activeOwnedTempPaths.delete(tmpPath);
      }
    });

    if (result !== RETRY_TEXT_WRITE_WITH_NEW_CANONICAL_PATH) return result;
  }
}

/**
 * Helper to construct the sidecar path for a given canvas path.
 */
function getSidecarPath(filePath) {
  return filePath.endsWith('.json') ? filePath.slice(0, -5) + '.progress.json' : filePath + '.progress.json';
}

// Recovery sidecars deliberately use a full canonical canvas path in their
// filename. A Save As or Finder rename therefore needs a main-process
// transaction, before this IPC reports the adopted path to the renderer. The
// individual stores preserve their own owner/run/input proof and fail closed on
// any conflict rather than allowing a stale path to overwrite new work.
async function rebindJobRecoveryOwnersForCanvasPath(oldPath, newPath) {
  if (!oldPath || path.resolve(oldPath) === path.resolve(newPath)) return { success: true };
  return withCanvasRecoveryRebind(oldPath, newPath, async ({ oldPath: oldOwner, newPath: newOwner, installAlias }) => {
    const marketplace = await prepareCanvasRecoveryRebind(oldOwner, newOwner);
    if (!marketplace?.success) return { success: false, reason: marketplace?.reason || 'marketplace-migration-prepare-failed' };
    const analysis = await rebindJobAnalysisRecoveryOwners(oldOwner, newOwner, { alreadyExclusive: true });
    if (!analysis?.success) {
      await marketplace.rollback?.();
      return { success: false, reason: analysis?.reason || 'analysis-migration-failed' };
    }
    const continuation = await rebindJobContinuationOwners(oldOwner, newOwner);
    if (!continuation?.success) {
      await rebindJobAnalysisRecoveryOwners(newOwner, oldOwner, { alreadyExclusive: true });
      await marketplace.rollback?.();
      return { success: false, reason: continuation?.reason || 'continuation-migration-failed' };
    }
    const staging = await rebindJobRunRecoveryOwners(oldOwner, newOwner);
    if (!staging?.success) {
      await rebindJobContinuationOwners(newOwner, oldOwner);
      await rebindJobAnalysisRecoveryOwners(newOwner, oldOwner, { alreadyExclusive: true });
      await marketplace.rollback?.();
      return { success: false, reason: staging.reason || 'staging-migration-failed' };
    }
    const marketplaceCommit = await marketplace.commit?.();
    if (!marketplaceCommit?.success) {
      await rebindJobRunRecoveryOwners(newOwner, oldOwner);
      await rebindJobContinuationOwners(newOwner, oldOwner);
      await rebindJobAnalysisRecoveryOwners(newOwner, oldOwner, { alreadyExclusive: true });
      await marketplace.rollback?.();
      return { success: false, reason: marketplaceCommit?.reason || 'marketplace-migration-commit-failed' };
    }
    installAlias();
    return { success: true, migratedCount: (analysis.migratedCount || 0) + (continuation.migratedCount || 0) + (staging.migratedCount || 0) + (marketplaceCommit.migratedCount || marketplace.migratedCount || 0) };
  });
}

async function reconcileRecoveryRebindJournalForCanvas(targetPath) {
  const directory = path.dirname(targetPath);
  let entries;
  try { entries = await fs.promises.readdir(directory); } catch { return { reconciled: false }; }
  const journals = entries.filter(name => name.startsWith('.ic-recovery-rebind-') && name.endsWith('.json'));
  for (const name of journals) {
    const journalPath = path.join(directory, name);
    const journal = await readRecoveryRebindJournal(journalPath);
    if (!journal || (path.resolve(journal.newCanvasPath) !== path.resolve(targetPath)
      && path.resolve(journal.oldCanvasPath) !== path.resolve(targetPath))) continue;
    const targetBytes = await fs.promises.readFile(journal.newCanvasPath).catch(() => null);
    const targetDigest = targetBytes
      ? createHash('sha256').update(targetBytes).digest('hex')
      : null;
    if (targetDigest !== journal.canvasDigest) {
      const targetStat = await fs.promises.lstat(journal.newCanvasPath).catch(() => null);
      const finderRenameAttested = journal.phase === 'prepared'
        && journal.renameAttestation
        && targetStat?.isFile()
        && !targetStat.isSymbolicLink()
        && targetStat.dev === journal.renameAttestation.dev
        && targetStat.ino === journal.renameAttestation.ino;
      if (finderRenameAttested) {
        const rebind = await rebindJobRecoveryOwnersForCanvasPath(journal.oldCanvasPath, journal.newCanvasPath);
        if (!rebind.success) return { reconciled: false, pending: true, reason: rebind.reason || 'recovery-migration-failed' };
        await clearRecoveryRebindJournals(journal.oldCanvasPath, journal.newCanvasPath);
        return {
          reconciled: true,
          migratedCount: rebind.migratedCount || 0,
          finderRename: true,
          adoptedCanvasPath: journal.newCanvasPath,
        };
      }
      // A crash before target publication leaves only a prepared journal; it
      // must never cause an unrelated later JSON file at the same name to
      // inherit another canvas's recovery state.
      if (journal.phase === 'prepared'
        && ((!targetBytes && journal.previousTargetDigest == null)
          || (targetDigest && targetDigest === journal.previousTargetDigest))) {
        await clearRecoveryRebindJournals(journal.oldCanvasPath, journal.newCanvasPath);
        return { reconciled: false, rolledBack: true };
      }
      return { reconciled: false, pending: true, reason: 'canvas-digest-mismatch' };
    }
    const rebind = await rebindJobRecoveryOwnersForCanvasPath(journal.oldCanvasPath, journal.newCanvasPath);
    if (!rebind.success) return { reconciled: false, pending: true, reason: rebind.reason || 'recovery-migration-failed' };
    await clearRecoveryRebindJournals(journal.oldCanvasPath, journal.newCanvasPath);
    return { reconciled: true, migratedCount: rebind.migratedCount || 0, adoptedCanvasPath: journal.newCanvasPath };
  }
  return { reconciled: false };
}

export const __recoveryRebindJournalForTests = {
  recoveryRebindJournalPath,
  recoveryRebindJournalPaths,
  writeRecoveryRebindJournal,
  readRecoveryRebindJournal,
  reconcileRecoveryRebindJournalForCanvas,
};

/**
 * Record the canvas file's identity (inode + device) on the renderer's
 * WebContents after a load or save. A rename preserves the inode, so this is the
 * fingerprint we use later to recognise the same file under a new name. Must be
 * called *after* any write — atomicWriteFile renames a temp over the target, so
 * the canvas inode changes on every save. Best-effort; ino==0 filesystems opt out.
 */
function rememberCanvasInode(sender, filePath) {
  try {
    const st = fs.statSync(filePath);
    if (sender && !sender.isDestroyed?.() && st.ino) {
      sender.__canvasInode = { ino: st.ino, dev: st.dev };
      sender.__canvasPath = filePath;
      ensureCanvasWatcher(sender, filePath);
    }
  } catch { /* best-effort; reconciliation simply won't trigger */ }
}

/**
 * The path the renderer hands us for a save is whatever it last knew. If the user
 * renamed the canvas in Finder while the app held it open, that path is stale: an
 * atomic write would resurrect the OLD name (recreating e.g. canvas.json next to
 * their renamed file) and silently split further edits — and every job sidecar —
 * across two files. A rename keeps the inode, so when the known path no longer
 * resolves to the inode we recorded, scan its directory for whoever now carries
 * it and follow the file to its new name. Returns the original path unchanged when
 * nothing was recorded, the file is untouched, or the inode can't be found (the
 * file was deleted or moved out of the directory — there's nowhere to follow it).
 *
 * ONLY the window's own canvas path is reconciled. A save aimed at any OTHER
 * path is an explicit retarget (a new file / programmatic write), and "requested
 * path missing + our inode lives elsewhere in that directory" describes that
 * case just as well as a Finder rename — following the inode there hijacks the
 * NEW file's contents into the PREVIOUSLY-saved canvas (the new path is never
 * created and the old file is silently overwritten; observed when two saves to
 * different names in one directory came from the same window).
 */
async function reconcileRenamedCanvas(sender, knownPath) {
  const tracked = sender?.__canvasInode;
  if (!tracked?.ino) return knownPath;
  if (!sender.__canvasPath || path.resolve(sender.__canvasPath) !== path.resolve(knownPath)) {
    return knownPath; // saving somewhere other than "the canvas" — honor it verbatim
  }
  try {
    const st = await fs.promises.stat(knownPath);
    if (st.ino === tracked.ino && st.dev === tracked.dev) return knownPath;
  } catch { /* knownPath is gone — fall through to the inode search */ }

  const dir = path.dirname(knownPath);
  let entries;
  try { entries = await fs.promises.readdir(dir); } catch { return knownPath; }
  for (const name of entries) {
    const candidate = path.join(dir, name);
    try {
      const st = await fs.promises.stat(candidate);
      if (st.ino === tracked.ino && st.dev === tracked.dev) {
        logger.info(`[FileSystem] Canvas renamed on disk: ${knownPath} → ${candidate} (followed by inode)`);
        return candidate;
      }
    } catch { /* unreadable entry — skip */ }
  }
  return knownPath;
}

/**
 * Per-renderer watcher that closes the rename "sliver" save-time reconciliation
 * leaves open: a save only fires on the next write, so a job action triggered
 * right after a Finder rename (no intervening edit/autosave) would still use the
 * old base name. Watching the canvas's *directory* — which survives the rename,
 * unlike a watch on the file itself — lets us follow the rename eagerly and push
 * the new path to the renderer, so currentFile (and every sidecar derived from
 * it) corrects at once instead of waiting for the next save.
 */
const canvasWatchers = new Map(); // WebContents -> { watcher, dir, timer }

function stopCanvasWatcher(sender) {
  const entry = canvasWatchers.get(sender);
  if (!entry) return;
  clearTimeout(entry.timer);
  try { entry.watcher.close(); } catch { /* ignore */ }
  canvasWatchers.delete(sender);
}

function ensureCanvasWatcher(sender, filePath) {
  const dir = path.dirname(filePath);
  const existing = canvasWatchers.get(sender);
  if (existing && existing.dir === dir) return; // already watching the right directory
  stopCanvasWatcher(sender);

  let watcher;
  try {
    watcher = fs.watch(dir, () => {
      const entry = canvasWatchers.get(sender);
      if (!entry) return;
      // A rename emits a burst of events; coalesce them and reconcile once.
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => { handleCanvasDirChange(sender).catch(() => {}); }, 250);
    });
  } catch (err) {
    logger.warn(`[FileSystem] Could not watch canvas directory ${dir}:`, err);
    return;
  }
  watcher.on('error', (err) => {
    logger.warn(`[FileSystem] Canvas watcher error for ${dir}:`, err);
    stopCanvasWatcher(sender);
  });
  canvasWatchers.set(sender, { watcher, dir, timer: null });

  if (!sender.__canvasWatchCleanup) {
    sender.__canvasWatchCleanup = true;
    sender.once('destroyed', () => stopCanvasWatcher(sender));
  }
}

async function handleCanvasDirChange(sender) {
  if (!sender || sender.isDestroyed?.()) return;
  const knownPath = sender.__canvasPath;
  if (!knownPath) return;
  const resolved = await reconcileRenamedCanvas(sender, knownPath);
  if (resolved === knownPath) return; // unchanged, or the rename couldn't be located — nothing to do
  const journalRecovery = await reconcileRecoveryRebindJournalForCanvas(resolved);
  if (journalRecovery.pending) {
    logger.error(`[FileSystem] Finder-rename recovery journal remains pending: ${journalRecovery.reason || 'unknown'}`);
    if (!sender.isDestroyed()) sender.send('canvas:file-rename-recovery-failed');
    return;
  }
  // A Finder rename has already published the same canvas inode at `resolved`.
  // Still journal it before touching any recovery sidecar: a process death in
  // the migration then has an exact, dual-directory restart transaction rather
  // than stranding the old path hash. The inode attestation prevents an
  // unrelated same-name JSON from inheriting this owner on recovery.
  const renamedStat = await fs.promises.lstat(resolved).catch(() => null);
  if (!renamedStat?.isFile() || renamedStat.isSymbolicLink()) {
    if (!sender.isDestroyed()) sender.send('canvas:file-rename-recovery-failed');
    return;
  }
  const renamedBytes = await fs.promises.readFile(resolved).catch(() => null);
  if (!renamedBytes) {
    if (!sender.isDestroyed()) sender.send('canvas:file-rename-recovery-failed');
    return;
  }
  const digest = createHash('sha256').update(renamedBytes).digest('hex');
  const journalPaths = recoveryRebindJournalPaths(knownPath, resolved);
  try {
    await Promise.all(journalPaths.map(journalPath => writeRecoveryRebindJournal(journalPath, {
      version: RECOVERY_REBIND_JOURNAL_VERSION,
      oldCanvasPath: path.resolve(knownPath),
      newCanvasPath: path.resolve(resolved),
      phase: 'canvas-written',
      canvasDigest: digest,
      previousTargetDigest: digest,
      renameAttestation: { dev: renamedStat.dev, ino: renamedStat.ino },
    })));
  } catch (error) {
    logger.error(`[FileSystem] Could not publish Finder-rename recovery journal: ${error?.message || error}`);
    if (!sender.isDestroyed()) sender.send('canvas:file-rename-recovery-failed');
    return;
  }
  const recoveryRebind = await rebindJobRecoveryOwnersForCanvasPath(knownPath, resolved);
  if (!recoveryRebind.success) {
    logger.error(`[FileSystem] Refused Finder-rename path adoption after recovery rebind failure: ${recoveryRebind.reason}`);
    if (!sender.isDestroyed()) sender.send('canvas:file-rename-recovery-failed');
    return;
  }
  try { await clearRecoveryRebindJournals(knownPath, resolved); } catch (error) {
    // Recovery was committed, so keep the journal as an idempotent startup
    // replay rather than falsely exposing an unjournaled rename.
    logger.error(`[FileSystem] Could not durably clear Finder-rename journal: ${error?.message || error}`);
    if (!sender.isDestroyed()) sender.send('canvas:file-rename-recovery-failed');
    return;
  }
  rememberCanvasInode(sender, resolved); // re-fingerprint at the new name (same dir → watcher unchanged)
  if (!sender.isDestroyed()) sender.send('canvas:file-renamed', resolved);
  logger.info(`[FileSystem] Canvas followed on-disk rename, notified renderer → ${resolved}`);
}

function relativePortablePath(canvasPath, filePath) {
  if (!canvasPath || !filePath || typeof filePath !== 'string') return null;
  if (!path.isAbsolute(filePath)) return filePath;
  const rel = path.relative(path.dirname(canvasPath), filePath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.includes(path.sep) ? rel : `.${path.sep}${rel}`;
}

// existsSync-equivalent async existence check: true for directories too
// (unlike isExistingFileAsync, which requires a regular file). Used wherever
// the prior synchronous code called fs.existsSync directly.
async function pathExists(targetPath) {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolvePortablePath(canvasPath, filePath, relativePath) {
  const baseDir = path.dirname(canvasPath);
  if (filePath && typeof filePath === 'string' && await pathExists(filePath)) return filePath;
  if (filePath && typeof filePath === 'string') {
    const candidate = path.join(baseDir, path.basename(filePath));
    if (await pathExists(candidate)) return candidate;
  }
  if (relativePath && typeof relativePath === 'string') {
    const candidate = path.resolve(baseDir, relativePath);
    // `relativeFilePath` is persisted in a portable canvas and can therefore
    // come from an untrusted file. It may name only a descendant of the canvas
    // directory; accepting ../ escapes here turns a portable-path fallback
    // into an arbitrary absolute-path substitution.
    if (isWithinDirectory(baseDir, candidate) && await pathExists(candidate)) return candidate;
  }
  return filePath;
}

function isImagePath(filePath) {
  return typeof filePath === 'string' && isProductImageExtension(path.extname(filePath));
}

export async function resolvePortableImagePath(canvasPath, filePath, relativePath) {
  const baseDir = path.dirname(canvasPath);
  const absoluteCandidate = typeof filePath === 'string' && filePath.length > 0
    ? (path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(baseDir, filePath))
    : null;
  const relativeCandidate = typeof relativePath === 'string' && relativePath.length > 0
    ? path.resolve(baseDir, relativePath)
    : null;
  const safeRelativeCandidate = isWithinDirectory(baseDir, relativeCandidate) ? relativeCandidate : null;

  // Prefer the exact stored path, then the exact portable relative path. While
  // each still exists, register the hierarchy the local-file protocol should
  // search if the image is moved later in this session.
  if (absoluteCandidate && await isExistingFileAsync(absoluteCandidate)) {
    const searchRoot = isWithinDirectory(baseDir, absoluteCandidate)
      ? baseDir
      : path.dirname(absoluteCandidate);
    rememberMissingPreviewSearchRoot(absoluteCandidate, searchRoot);
    return absoluteCandidate;
  }
  if (safeRelativeCandidate && await isExistingFileAsync(safeRelativeCandidate)) {
    rememberMissingPreviewSearchRoot(safeRelativeCandidate, baseDir);
    return safeRelativeCandidate;
  }

  const missingPath = safeRelativeCandidate || absoluteCandidate;
  if (!missingPath) return filePath;

  // Workspace-contained images search from the workspace folder down. External
  // images search from their own original folder down. Neither path may broaden
  // upward to a parent folder.
  const belongsToWorkspaceHierarchy = !!safeRelativeCandidate || isWithinDirectory(baseDir, missingPath);
  const searchRoot = belongsToWorkspaceHierarchy ? baseDir : path.dirname(missingPath);
  rememberMissingPreviewSearchRoot(missingPath, searchRoot);
  const relink = await resolveMissingPreviewPath(missingPath, { searchRoot });

  if (relink.status === 'found') {
    rememberMissingPreviewSearchRoot(relink.path, searchRoot);
    if (!relink.cached) {
      logger.info(`[FileSystem] Relinked missing preview image within current hierarchy: ${missingPath} → ${relink.path} (root ${relink.root}, scanned ${relink.entriesScanned} entries)`);
    }
    return relink.path;
  }
  if (!relink.cached && (relink.status === 'ambiguous' || relink.status === 'limit')) {
    logger.warn(`[FileSystem] Could not relink missing preview image (${relink.status}) within ${relink.root}: ${missingPath} (scanned ${relink.entriesScanned} entries)`);
  }
  return missingPath;
}

function traverseCanvasNodes(nodes, fn) {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    fn(node);
    if (node?.type === 'group' && node.data?.canvasData?.nodes) {
      traverseCanvasNodes(node.data.canvasData.nodes, fn);
    }
  }
}

// Async sibling of traverseCanvasNodes for callers whose per-node callback
// does fs work. Awaits fn for each node sequentially (same order as the sync
// walk) before recursing into a group's nested canvas — never Promise.all,
// so nodes are still visited and awaited one at a time.
async function traverseCanvasNodesAsync(nodes, fn) {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    await fn(node);
    if (node?.type === 'group' && node.data?.canvasData?.nodes) {
      await traverseCanvasNodesAsync(node.data.canvasData.nodes, fn);
    }
  }
}

function annotatePortableFilePaths(data, canvasPath) {
  traverseCanvasNodes(data?.nodes, (node) => {
    const d = node?.data;
    if (!d) return;

    const rel = relativePortablePath(canvasPath, d.filePath);
    if (rel) d.relativeFilePath = rel;
    else delete d.relativeFilePath;
    if (typeof d.filePath === 'string' && path.isAbsolute(d.filePath) && isImagePath(d.filePath)) {
      rememberMissingPreviewSearchRoot(
        d.filePath,
        rel ? path.dirname(canvasPath) : path.dirname(d.filePath),
      );
    }

    if (Array.isArray(d.imagePaths)) {
      d.relativeImagePaths = d.imagePaths.map((p) => {
        const rel = relativePortablePath(canvasPath, p);
        if (typeof p === 'string' && path.isAbsolute(p)) {
          rememberMissingPreviewSearchRoot(p, rel ? path.dirname(canvasPath) : path.dirname(p));
        }
        return rel;
      });
      if (!d.relativeImagePaths.some(Boolean)) delete d.relativeImagePaths;
    } else {
      delete d.relativeImagePaths;
    }
  });
}

export async function resolvePortableFilePaths(data, canvasPath) {
  await traverseCanvasNodesAsync(data?.nodes, async (node) => {
    const d = node?.data;
    if (!d) return;

    if (d.filePath) {
      d.filePath = isImagePath(d.filePath) || isImagePath(d.filename)
        ? await resolvePortableImagePath(canvasPath, d.filePath, d.relativeFilePath)
        : await resolvePortablePath(canvasPath, d.filePath, d.relativeFilePath);
      const rel = relativePortablePath(canvasPath, d.filePath);
      if (rel) d.relativeFilePath = rel;
      else delete d.relativeFilePath;
    }

    if (Array.isArray(d.imagePaths)) {
      // Sequential, not Promise.all: each resolvePortableImagePath call can
      // read/write the shared missing-preview search-root map and result
      // cache, so resolving out of order (or concurrently) could change which
      // entries get evicted/reused and reorder the resulting log lines.
      const resolvedImagePaths = [];
      for (let i = 0; i < d.imagePaths.length; i += 1) {
        resolvedImagePaths.push(await resolvePortableImagePath(canvasPath, d.imagePaths[i], d.relativeImagePaths?.[i]));
      }
      d.imagePaths = resolvedImagePaths;
      const rels = d.imagePaths.map(p => relativePortablePath(canvasPath, p));
      if (rels.some(Boolean)) d.relativeImagePaths = rels;
      else delete d.relativeImagePaths;
    }
  });
}

/**
 * Extracts volatile transient/paused state from the nodes array and returns it,
 * while stripping the transient keys and resetting states in the original nodes
 * array (mutating it).
 */
function extractSidecarData(nodes) {
  const hubs = [];
  const cards = [];

  const traverseAndExtract = (nodeList) => {
    if (!Array.isArray(nodeList)) return;
    for (const n of nodeList) {
      if (n.type === 'jobhub' && n.data?.hubState === 'sources-ready') {
        const d = n.data;
        hubs.push({
          id: n.id,
          hubState: d.hubState,
          scrapeWarnings: d.scrapeWarnings,
          pendingJobs: d.pendingJobs,
          pendingTargetRole: d.pendingTargetRole,
          errorMessage: d.errorMessage,
          isRateLimit: d.isRateLimit,
        });
        
        // Strip transient/paused fields from main file data
        d.hubState = 'empty';
        delete d.scrapeWarnings;
        delete d.pendingJobs;
        delete d.pendingTargetRole;
        delete d.errorMessage;
        delete d.isRateLimit;
      } else if (n.type === 'jobsourcecard' && n.data?.persistedProgress) {
        cards.push({
          id: n.id,
          persistedProgress: n.data.persistedProgress,
        });
        
        // Strip transient/paused progress from main file data
        delete n.data.persistedProgress;
      }
      
      if (n.type === 'group' && n.data?.canvasData?.nodes) {
        traverseAndExtract(n.data.canvasData.nodes);
      }
    }
  };

  traverseAndExtract(nodes);
  return { hubs, cards };
}

/**
 * Merges saved transient/paused sidecar states back into the matching nodes.
 */
function mergeSidecarData(nodes, sidecarData) {
  if (!sidecarData) return;
  const hubsMap = new Map((sidecarData.hubs || []).map(h => [h.id, h]));
  const cardsMap = new Map((sidecarData.cards || []).map(c => [c.id, c]));

  const traverseAndMerge = (nodeList) => {
    if (!Array.isArray(nodeList)) return;
    for (const n of nodeList) {
      if (n.type === 'jobhub' && hubsMap.has(n.id)) {
        const sidecarHub = hubsMap.get(n.id);
        n.data = n.data || {};
        n.data.hubState = sidecarHub.hubState || 'sources-ready';
        if (sidecarHub.scrapeWarnings !== undefined) n.data.scrapeWarnings = sidecarHub.scrapeWarnings;
        if (sidecarHub.pendingJobs !== undefined) n.data.pendingJobs = sidecarHub.pendingJobs;
        if (sidecarHub.pendingTargetRole !== undefined) n.data.pendingTargetRole = sidecarHub.pendingTargetRole;
        if (sidecarHub.errorMessage !== undefined) n.data.errorMessage = sidecarHub.errorMessage;
        if (sidecarHub.isRateLimit !== undefined) n.data.isRateLimit = sidecarHub.isRateLimit;
      } else if (n.type === 'jobsourcecard' && cardsMap.has(n.id)) {
        const sidecarCard = cardsMap.get(n.id);
        n.data = n.data || {};
        if (sidecarCard.persistedProgress !== undefined) n.data.persistedProgress = sidecarCard.persistedProgress;
      }

      if (n.type === 'group' && n.data?.canvasData?.nodes) {
        traverseAndMerge(n.data.canvasData.nodes);
      }
    }
  };

  traverseAndMerge(nodes);
}

export function registerFilesystemHandlers() {
  handleSafe('scan-directory', async (event, dirPath) => {
    const visited = new Set();
    const result = await scanPath(dirPath, visited, event.sender);
    
    if (!result) throw new Error('Directory skip or unreadable');
    return result.type === 'document' ? { isFile: true, file: result } : result;
  });

  handleSafe('open-file', async (_event, filePath) => {
    if (isBackgroundE2E()) throw backgroundE2EDisabledError('Opening a file in the OS');
    // Security Guard: allowlist of expected document/media extensions rather
    // than a denylist of known-executable ones. A denylist is inherently
    // incomplete (the old one missed .jar/.dmg/.pkg/.deb/.appimage/.command/
    // .workflow/.scpt/.desktop, any of which shell.openPath would happily
    // launch) — and since a filePath here can originate from a loaded canvas
    // node (untrusted JSON, not just files the user explicitly picked), the
    // set of things this app will hand to the OS shell should be the
    // documents/media it actually deals in, not "everything that isn't on a
    // list of known-bad extensions."
    const safeTarget = await inspectAllowedOpenFilePath(filePath);
    // Keep this identity check adjacent to the OS call. The canvas may point
    // anywhere on disk, so canonical path + file/parent identity are the
    // containment boundary rather than a fixed application-owned directory.
    await assertAllowedOpenFileIdentity(safeTarget);
    const err = await shell.openPath(safeTarget.resolvedPath);
    if (err) throw new Error(err);
  });

  handleSafe('open-external', async (_event, url) => {
    if (isBackgroundE2E()) throw backgroundE2EDisabledError('Opening an external URL');
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Invalid protocol: ${parsed.protocol}. Only http and https are allowed for external links.`);
    }
    await shell.openExternal(url);
  });

  handleSafe('save-workspace', async (event, args) => {
    const { data, filePath } = args;
    let targetPath = filePath;
    // Keep the renderer-provided owner spelling until the recovery rebind has
    // committed. `reconcileRenamedCanvas` may replace targetPath with a Finder
    // rename, and a future Save As may supply another absolute target.
    let priorCanvasPath = typeof filePath === 'string' && filePath.trim() ? filePath : null;
    const pendingRebind = event.sender.__pendingCanvasRecoveryRebind || null;
    if (pendingRebind?.newCanvasPath) {
      // A prior Save wrote the new canvas but intentionally withheld renderer
      // adoption until recovery ownership could commit. Retry the same durable
      // transaction rather than resurrecting the stale old spelling.
      targetPath = pendingRebind.newCanvasPath;
      priorCanvasPath = pendingRebind.oldCanvasPath;
    }
    if (!targetPath) {
      if (isBackgroundE2E()) return { canceled: true };
      const { canceled, filePath: dialogPath } = await dialog.showSaveDialog({
        title: 'Save Canvas',
        defaultPath: 'canvas.json',
        filters: [{ name: 'JSON Files', extensions: ['json'] }],
      });
      if (canceled || !dialogPath) return { canceled: true };
      targetPath = dialogPath;
    } else {
      // Follow a Finder rename so autosave writes to the renamed file instead of
      // resurrecting the old name. The renderer adopts the returned filePath, so
      // currentFile — and every job sidecar derived from it — self-corrects.
      targetPath = await reconcileRenamedCanvas(event.sender, targetPath);
    }

    // The renderer-side sanitizer already preserves actionable paused state
    // directly on the nodes we keep. Re-embedding job progress into a top-level
    // transientProgress blob caused it to be written back on every save, which
    // then replayed on every reload. Keep load-time migration for legacy files,
    // but stop generating fresh embedded progress on save.
    delete data.transientProgress;
    annotatePortableFilePaths(data, targetPath);
    const serializedCanvas = JSON.stringify(data);

    // Delete legacy separate sidecar progress file if present
    try {
      const sidecarPath = getSidecarPath(targetPath);
      if (fs.existsSync(sidecarPath)) {
        await fs.promises.unlink(sidecarPath);
        logger.info(`[FileSystem] Cleaned up legacy separate progress sidecar: ${sidecarPath}`);
      }
    } catch { /* ignore */ }

    const needsRecoveryRebind = !!priorCanvasPath
      && path.resolve(priorCanvasPath) !== path.resolve(targetPath);
    const journalPaths = needsRecoveryRebind
      ? recoveryRebindJournalPaths(priorCanvasPath, targetPath)
      : null;
    const priorTargetBytes = journalPaths
      ? await fs.promises.readFile(targetPath).catch(() => null)
      : null;
    const previousTargetDigest = priorTargetBytes
      ? createHash('sha256').update(priorTargetBytes).digest('hex')
      : null;
    const [oldTargetStat, newTargetStat] = journalPaths
      ? await Promise.all([
        fs.promises.lstat(priorCanvasPath).catch(() => null),
        fs.promises.lstat(targetPath).catch(() => null),
      ])
      : [null, null];
    const trackedInode = event.sender.__canvasInode;
    const renameAttestation = journalPaths
      && !oldTargetStat
      && newTargetStat?.isFile()
      && !newTargetStat.isSymbolicLink()
      && trackedInode?.ino === newTargetStat.ino
      && trackedInode?.dev === newTargetStat.dev
      ? { dev: newTargetStat.dev, ino: newTargetStat.ino }
      : null;
    if (journalPaths) {
      await Promise.all(journalPaths.map(journalPath => writeRecoveryRebindJournal(journalPath, {
        version: RECOVERY_REBIND_JOURNAL_VERSION,
        oldCanvasPath: path.resolve(priorCanvasPath),
        newCanvasPath: path.resolve(targetPath),
        phase: 'prepared',
        canvasDigest: createHash('sha256').update(serializedCanvas).digest('hex'),
        previousTargetDigest,
        ...(renameAttestation ? { renameAttestation } : {}),
      })));
    }

    // Production Hardening: Use atomic write to prevent data corruption. The
    // prepared journal makes a crash after this point deterministic: opening
    // the target completes the exact sidecar rebind before exposing recovery.
    await atomicWriteFile(targetPath, serializedCanvas);
    if (journalPaths) {
      await Promise.all(journalPaths.map(journalPath => writeRecoveryRebindJournal(journalPath, {
        version: RECOVERY_REBIND_JOURNAL_VERSION,
        oldCanvasPath: path.resolve(priorCanvasPath),
        newCanvasPath: path.resolve(targetPath),
        phase: 'canvas-written',
        canvasDigest: createHash('sha256').update(serializedCanvas).digest('hex'),
        previousTargetDigest,
        ...(renameAttestation ? { renameAttestation } : {}),
      })));
    }

    const recoveryRebind = await rebindJobRecoveryOwnersForCanvasPath(priorCanvasPath, targetPath);
    if (!recoveryRebind.success) {
      // The canvas bytes are safely written, but do not tell the renderer to
      // adopt a path whose recovery ownership could not be proven. A retry
      // reconciling the still-recorded inode can finish the rebind; meanwhile
      // no new external work is admitted by the recovery ownership gates.
      event.sender.__pendingCanvasRecoveryRebind = journalPaths
        ? { oldCanvasPath: priorCanvasPath, newCanvasPath: targetPath, journalPaths }
        : null;
      logger.error(`[FileSystem] Refused canvas-path adoption after recovery rebind failure: ${recoveryRebind.reason}`);
      return { error: 'Could not safely move recovery data to the renamed canvas. Please retry Save before continuing work.' };
    }
    if (journalPaths) await clearRecoveryRebindJournals(priorCanvasPath, targetPath);
    event.sender.__pendingCanvasRecoveryRebind = null;

    // Re-fingerprint: the atomic rename gave the canvas a fresh inode, so record
    // it now to recognise this exact file if it's renamed before the next save.
    rememberCanvasInode(event.sender, targetPath);

    // Background cleanup of any orphaned .tmp files in this specific directory
    cleanupTempFiles(path.dirname(targetPath)).catch(err => logger.warn('Save cleanup failed:', err));

    return { filePath: targetPath };
  });

  handleSafe('load-workspace', async (event, opts) => {
    let targetPath = opts?.filePath;
    
    if (!targetPath) {
      if (isBackgroundE2E()) return { canceled: true };
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: 'Open Canvas',
        properties: ['openFile'],
        filters: [{ name: 'JSON Files', extensions: ['json'] }],
      });
      if (canceled || filePaths.length === 0) return { canceled: true };
      targetPath = filePaths[0];
    }

    const journalRecovery = await reconcileRecoveryRebindJournalForCanvas(targetPath);
    if (journalRecovery.pending) {
      throw new Error('Recovery ownership migration is still pending for this canvas. Retry opening it after resolving the filesystem error.');
    }
    // A last-opened old spelling can be gone after a Finder rename. Successful
    // journal reconciliation proves the exact new canvas digest/attestation,
    // so adopt only that recorded target before any existence/read/fingerprint
    // check. This never follows an arbitrary directory JSON.
    if (journalRecovery.adoptedCanvasPath) targetPath = journalRecovery.adoptedCanvasPath;

    if (!fs.existsSync(targetPath)) throw new Error('File does not exist');
    
    const stats = fs.statSync(targetPath);
    if (stats.size === 0) throw new Error('Workspace file is empty (0 bytes)');
    // Static safety bound (not adaptive): a workspace JSON larger than this would
    // OOM the V8 string parser on read. Fixed by design.
    const MAX_WORKSPACE_BYTES = 100 * 1024 * 1024; // 100MB
    if (stats.size > MAX_WORKSPACE_BYTES) throw new Error(`Workspace file is excessively large (${(stats.size/1024/1024).toFixed(2)}MB). Limit is 100MB.`);

    const content = await fs.promises.readFile(targetPath, 'utf-8');
    try {
      const data = JSON.parse(content);
      await resolvePortableFilePaths(data, targetPath);
      logger.info(`[FileSystem] Loaded workspace: ${targetPath} (${stats.size} bytes)`);

      // Clean up legacy separate progress sidecar file if it exists
      try {
        const sidecarPath = getSidecarPath(targetPath);
        if (fs.existsSync(sidecarPath)) {
          try {
            const sidecarContent = await fs.promises.readFile(sidecarPath, 'utf-8');
            const sidecarData = JSON.parse(sidecarContent);
            mergeSidecarData(data.nodes || [], sidecarData);
            logger.info(`[FileSystem] Migrated and merged legacy progress sidecar data from ${sidecarPath}`);
          } catch (err) {
            logger.error(`[FileSystem] Failed to parse legacy sidecar data: ${sidecarPath}`, err);
          }
          await fs.promises.unlink(sidecarPath);
          logger.info(`[FileSystem] Deleted legacy progress sidecar file: ${sidecarPath}`);
        }
      } catch { /* ignore */ }

      // Check for embedded transientProgress
      if (data.transientProgress) {
        const sidecarData = data.transientProgress;
        // Merge progress back into the nodes for V8/React Flow memory
        mergeSidecarData(data.nodes || [], sidecarData);
        logger.info('[FileSystem] Restored embedded transient progress into React Flow memory nodes');
        
        // Immediately delete/strip the saved state from the file on disk
        delete data.transientProgress;
        
        try {
          const cleanData = JSON.parse(JSON.stringify(data));
          // Strip nodes in cleanData so the disk copy is fully clean
          extractSidecarData(cleanData.nodes || []);
          delete cleanData.transientProgress;
          
          await atomicWriteFile(targetPath, JSON.stringify(cleanData));
          logger.info(`[FileSystem] Immediately deleted saved transient progress from disk file: ${targetPath}`);
        } catch (err) {
          logger.error(`[FileSystem] Failed to write clean canvas to disk after loading: ${targetPath}`, err);
        }
      }
      
      // Cleanup any orphaned .tmp files left over from past crashes in this directory
      cleanupTempFiles(path.dirname(targetPath)).catch(err => logger.warn('Load cleanup failed:', err));

      // Fingerprint the file we just loaded so the next save can tell if it was
      // renamed underneath us. Done last: the transient-progress path above may
      // have atomically rewritten it, changing the inode.
      rememberCanvasInode(event.sender, targetPath);

      return { data, filePath: targetPath };
    } catch (jsonErr) {
      logger.error(`[FileSystem] Failed to parse workspace JSON at ${targetPath}:`, jsonErr);
      throw new Error('Invalid workspace file format. File may be corrupted or malformed.');
    }
  });

  handleSafe('start-file-watch', async (event, filePath) => {
    await fileWatchRegistry.start(event.sender, filePath);
  });


  handleSafe('stop-file-watch', async (event, filePath) => {
    fileWatchRegistry.stop(event.sender, filePath);
  });

  handleSafe('delete-os-file', async (event, request) => {
    if (isBackgroundE2E()) return { canceled: true };
    // Preserve the old string payload for an already-open renderer while the
    // preload bridge rolls out the survivor-protection object payload.
    const filePath = typeof request === 'string' ? request : request?.filePath;
    const protectedPaths = typeof request === 'string' ? [] : request?.protectedPaths;
    const safePath = await assertDeleteTargetNotRepresented(filePath, protectedPaths, {
      sender: event.sender,
    });
    await shell.trashItem(safePath);
  });

  handleSafe('read-text-file', async (event, filePath) => (
    readValidatedTextFile(filePath, { sender: event.sender })
  ));

  handleSafe('write-text-file', async (event, {
    filePath,
    content,
    expectedContent,
    expectedTargetToken,
  }) => {
    await writeValidatedTextFile(filePath, content, {
      sender: event.sender,
      expectedContent,
      expectedTargetToken,
    });
  });
}

/**
 * Startup Cleanup Logic: Finds and deletes orphaned .tmp files left over from
 * previous sessions (atomic write failures or app crashes).
 *
 * @param {string} [targetDir] - Directory to scan. Defaults to process.cwd() in dev.
 */
const cleanupNextEligibleAt = new Map();
const OWNED_TEMP_MAX_AGE_MS = 60 * 60 * 1000;
const OWNED_TEMP_RESCAN_MS = 15 * 60 * 1000;
const OWNED_TEMP_RETRY_MS = 60 * 1000;
const TEXT_TEMP_FILE_PATTERN = /^\.__ic_text_[0-9a-f-]{36}\.tmp$/i;

function isOwnedTempFileName(fileName) {
  return (fileName.includes('.__ic_atomic_') && fileName.endsWith('.tmp'))
    || TEXT_TEMP_FILE_PATTERN.test(fileName);
}

/**
 * Remove only stale, regular files with one of our temp filename shapes.
 * `lstat` deliberately refuses a filename-shaped symlink rather than
 * following it, and the age gate protects a live/in-flight writer.
 * Exported for deterministic non-GUI regression coverage.
 */
export async function cleanupStaleOwnedTempFiles(targetDir, {
  readdir = fs.promises.readdir,
  lstat = fs.promises.lstat,
  unlink = fs.promises.unlink,
  now = () => Date.now(),
  maxAgeMs = OWNED_TEMP_MAX_AGE_MS,
  isActivePath = candidatePath => activeOwnedTempPaths.has(candidatePath),
} = {}) {
  const files = await readdir(targetDir);
  const nowMs = now();
  let nextEligibleAt = null;
  for (const fileName of files) {
    if (!isOwnedTempFileName(fileName)) continue;
    const candidatePath = path.join(targetDir, fileName);
    try {
      const stats = await lstat(candidatePath);
      if (!stats.isFile() || stats.isSymbolicLink() || isActivePath(candidatePath)) continue;
      if (nowMs - stats.mtimeMs <= maxAgeMs) {
        const eligibleAt = stats.mtimeMs + maxAgeMs + 1;
        nextEligibleAt = nextEligibleAt === null
          ? eligibleAt
          : Math.min(nextEligibleAt, eligibleAt);
        continue;
      }
      await unlink(candidatePath);
    } catch { /* concurrent writers/deletes must not fail a load or save */ }
  }
  return { nextEligibleAt };
}

// Bounded per-directory wrapper invoked by canvas and opened text documents.
async function cleanupTempFiles(targetDir) {
  const dir = targetDir || process.cwd();
  const nowMs = Date.now();
  const scheduledAt = cleanupNextEligibleAt.get(dir);
  if (scheduledAt && nowMs < scheduledAt) return;

  // Normal failed writes clean up immediately. Leftovers come from process
  // interruption or a parent replacement where following the old path is
  // unsafe. Re-sweep at a bounded cadence, and sooner when a currently-fresh
  // artifact ages past the safe deletion threshold during a long app session.
  try {
    const { nextEligibleAt } = await cleanupStaleOwnedTempFiles(dir, { now: () => nowMs });
    cleanupNextEligibleAt.set(dir, Math.min(
      nowMs + OWNED_TEMP_RESCAN_MS,
      nextEligibleAt ?? Infinity,
    ));
  } catch (err) {
    // A transient unavailable/network directory must be eligible for a later
    // retry rather than being permanently marked clean.
    cleanupNextEligibleAt.set(dir, nowMs + OWNED_TEMP_RETRY_MS);
    logger.warn('[Filesystem] Startup cleanup failed:', err?.message || String(err));
  }
}
