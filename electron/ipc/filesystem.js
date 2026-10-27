/**
 * Filesystem IPC handlers — scan directories, open files/URLs, save/load workspaces.
 */
import electronPkg from 'electron';
const { shell, dialog, app } = electronPkg;
import { handleSafe } from './ipcUtils.js';
import { logger } from '../logger.js';
import { recordWorkspaceWriteOutcome } from './workspaceIoDiagnostics.js';
import path from 'path';
import fs from 'fs';
import { createHash, randomUUID } from 'crypto';
import {
  rememberMissingPreviewSearchRoot,
  resolveMissingPreviewPath,
} from './missingPreviewRelink.js';
import { isProductImageExtension } from '../../src/utils/fileExtensions.js';
import {
  isWithinDirectory,
  isExistingFileAsync,
  isRendererSensitivePath,
  registerRendererPrivateAppRoot,
} from '../utils/pathSafety.js';
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

function privateRendererPathError() {
  const error = new Error('Access to private application data is restricted.');
  error.code = 'PRIVATE_RENDERER_PATH';
  return error;
}

function openFileHardlinkUnsupportedError() {
  const error = new Error('Files with multiple hard links cannot be opened from the canvas. Break the hard link before opening it.');
  error.code = 'OPEN_FILE_HARDLINK_UNSUPPORTED';
  return error;
}

/**
 * Reject a renderer-controlled path that reaches a sensitive component through
 * either its spelling or an existing symlink.  Missing save targets still
 * resolve their nearest existing ancestor so `safe-link/new.json` cannot
 * create a file below a private store through a parent symlink.
 *
 * This is intentionally a narrow filesystem-IPC seam: app-owned Interview
 * stores call their own main-process APIs and never pass through this guard.
 */
export async function assertRendererFilesystemPathAllowed(filePath, {
  allowMissing = false,
  realpath = fs.promises.realpath,
} = {}) {
  if (typeof filePath !== 'string' || !filePath.trim()) return null;
  const normalizedPath = path.resolve(filePath);
  if (isRendererSensitivePath(normalizedPath)) throw privateRendererPathError();

  let probePath = normalizedPath;
  const missingSuffix = [];
  for (;;) {
    try {
      const resolvedProbe = await realpath(probePath);
      const resolvedPath = missingSuffix.length
        ? path.join(resolvedProbe, ...missingSuffix)
        : resolvedProbe;
      if (isRendererSensitivePath(resolvedPath)) throw privateRendererPathError();
      return { normalizedPath, resolvedPath };
    } catch (error) {
      if (error?.code === 'PRIVATE_RENDERER_PATH') throw error;
      if (!allowMissing || (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR')) {
        // Existing callers retain their own normal lstat/read error behavior;
        // this guard only needs a canonical spelling when one is available.
        return { normalizedPath, resolvedPath: null };
      }
      const parent = path.dirname(probePath);
      if (parent === probePath) return { normalizedPath, resolvedPath: null };
      missingSuffix.unshift(path.basename(probePath));
      probePath = parent;
    }
  }
}

/**
 * Resolve an OS-open request to the regular file it will actually launch.
 * Checking only the renderer-supplied suffix lets `notes.txt -> payload.app`
 * bypass the allowlist because shell.openPath follows the link itself.
 */
export async function inspectAllowedOpenFilePath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim() || !path.isAbsolute(filePath)) {
    throw new Error('A valid absolute file path is required.');
  }
  const normalizedPath = path.resolve(filePath);
  await assertRendererFilesystemPathAllowed(normalizedPath);
  if (!isAllowedOpenFileExt(normalizedPath)) {
    const ext = path.extname(normalizedPath).toLowerCase();
    throw new Error(`Opening "${ext || '(no extension)'}" files is restricted for security reasons.`);
  }
  const lexicalStat = await fs.promises.lstat(normalizedPath);
  if (typeof lexicalStat.nlink === 'number' && lexicalStat.nlink > 1) {
    throw openFileHardlinkUnsupportedError();
  }
  if (!lexicalStat.isFile() || lexicalStat.isSymbolicLink()) {
    throw new Error('Only single-link regular document and media files can be opened. Symbolic and hard links are restricted.');
  }
  const resolvedPath = await fs.promises.realpath(normalizedPath);
  if (isRendererSensitivePath(resolvedPath)) throw privateRendererPathError();
  if (!isAllowedOpenFileExt(resolvedPath)) {
    throw new Error('The selected document resolves to a restricted file type.');
  }
  const canonicalStat = await fs.promises.lstat(resolvedPath);
  if (typeof canonicalStat.nlink === 'number' && canonicalStat.nlink > 1) {
    throw openFileHardlinkUnsupportedError();
  }
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
  if (typeof targetStat.nlink === 'number' && targetStat.nlink > 1) {
    throw openFileHardlinkUnsupportedError();
  }
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
const RENDERER_PRIVATE_STORE_DIRECTORY_NAMES = Object.freeze([
  'interview-helper-artifacts',
  'interview-helper-prepared-briefs',
  'career-input-staging',
  'career-snapshot-store',
  'renderer-workspace-write-journal',
  'local-file-protocol-transcodes',
]);

/** True when a document is one of the two formats the renderer exposes as editable. */
function isAllowedTextEditExt(filePath) {
  return ALLOWED_TEXT_EDIT_EXTS.has(path.extname(String(filePath || '')).toLowerCase());
}

function osDeleteProtectedError() {
  const error = new Error('The item is still represented by another canvas node and was kept on disk.');
  error.code = 'OS_DELETE_PROTECTED';
  return error;
}

function isSameOrAncestorPath(candidatePath, protectedPath) {
  let candidate = path.resolve(candidatePath).normalize('NFC');
  let protectedRoot = path.resolve(protectedPath).normalize('NFC');
  // `path.relative` is ordinarily case-aware, while Windows and the usual
  // macOS volume used by userData are case-insensitive. Fold conservatively:
  // an extra refusal is safe, whereas `C:\\App` deleting `c:\\app\\userData`
  // (or a case-variant macOS ancestor) is not. The actual path handed to the
  // OS remains the validated original spelling.
  if (process.platform === 'win32' || process.platform === 'darwin') {
    if (process.platform === 'win32' && candidate.startsWith('\\\\?\\')) candidate = candidate.slice(4);
    if (process.platform === 'win32' && protectedRoot.startsWith('\\\\?\\')) protectedRoot = protectedRoot.slice(4);
    candidate = candidate.toLowerCase();
    protectedRoot = protectedRoot.toLowerCase();
  }
  const relative = path.relative(candidate, protectedRoot);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// Keep the first survivor check entirely lexical.  In particular, a renderer
// must not be able to learn whether `userData/browser-data/secret.json`
// exists merely by placing it in `protectedPaths` and observing an lstat or
// realpath branch.  Canonical/alias validation still follows for public
// spellings, but only after this zero-I/O rejection.
function isLexicallyRendererPrivateDeleteProtectionPath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim() || !path.isAbsolute(filePath)) return true;
  let userDataPath;
  try { userDataPath = app?.getPath?.('userData'); } catch { return true; }
  if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) return true;
  registerRendererPrivateAppRoot(userDataPath);
  const candidate = path.resolve(filePath);
  if (isRendererSensitivePath(candidate)) return true;
  const roots = [
    path.resolve(userDataPath),
    ...RENDERER_PRIVATE_STORE_DIRECTORY_NAMES.map(name => path.join(path.resolve(userDataPath), name)),
  ];
  return roots.some(root => isSameOrAncestorPath(candidate, root));
}

/**
 * The generic trash IPC must not be able to remove an app-private root by
 * naming its parent. Component blocklists only catch descendants; `userData`
 * itself deliberately has an installation-specific name, so protect its
 * lexical and real locations plus every private store rooted beneath it.
 */
export async function assertRendererDeletePathDoesNotContainPrivateRoots(filePath, {
  userDataPath = app?.getPath?.('userData'),
  realpath = fs.promises.realpath,
} = {}) {
  if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) {
    // A missing host root must not broaden a destructive renderer capability.
    throw privateRendererPathError();
  }
  const lexicalUserDataPath = path.resolve(userDataPath);
  let realUserDataPath = lexicalUserDataPath;
  try { realUserDataPath = await realpath(lexicalUserDataPath); } catch { /* checked lexically below */ }

  const protectedRoots = new Set([
    lexicalUserDataPath,
    realUserDataPath,
    ...RENDERER_PRIVATE_STORE_DIRECTORY_NAMES.flatMap(name => [
      path.join(lexicalUserDataPath, name),
      path.join(realUserDataPath, name),
    ]),
  ]);
  const lexicalCandidate = path.resolve(filePath);
  const candidateForms = new Set([lexicalCandidate]);
  try { candidateForms.add(await realpath(lexicalCandidate)); } catch { /* final lstat validation owns normal errors */ }

  for (const candidate of candidateForms) {
    for (const protectedRoot of protectedRoots) {
      if (isSameOrAncestorPath(candidate, protectedRoot)) throw privateRendererPathError();
    }
  }
  return lexicalCandidate;
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
  // Survivor paths arrive directly from renderer state.  Check the renderer
  // boundary before the identity inspector gets a chance to lstat/realpath
  // them; otherwise a private survivor becomes an existence oracle through
  // the protected-list validation branch.
  assertRendererPathAllowed = assertRendererFilesystemPathAllowed,
  assertDeletePathDoesNotContainPrivateRoots = assertRendererDeletePathDoesNotContainPrivateRoots,
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
    if (isLexicallyRendererPrivateDeleteProtectionPath(survivorPath)) {
      throw osDeleteProtectedError();
    }
    try {
      // Registering the root is normally done at handler setup, but this
      // exported helper is also used directly by focused tests.  Keep its
      // renderer boundary self-contained rather than depending on call order.
      try { registerRendererPrivateAppRoot(app?.getPath?.('userData')); } catch { /* fail closed below if needed */ }
      await assertRendererPathAllowed(survivorPath, { allowMissing: true });
      // This catches userData itself and its ancestors, which are intentionally
      // not descendants of the registered root.  A private or ambiguous
      // survivor only makes deletion refuse; no private metadata is returned.
      await assertDeletePathDoesNotContainPrivateRoots(survivorPath);
    } catch {
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
  // Watch requests come from a renderer and each native watcher carries an
  // OS handle.  Count *unique targets*, not refcounted duplicate starts, so a
  // React retry cannot consume the quota while a compromised renderer cannot
  // turn this into an unbounded descriptor registry.
  maxTargetsPerSender = 64,
  maxTargets = 512,
  // Kept injectable for the pure watcher regression suite.  The production
  // value is the host platform, where fs.watch's filename spelling follows
  // the native filesystem's case rules.
  platform = process.platform,
  // Production supplies an identity-aware validator below.  The dependency is
  // optional so the pure watcher mechanics remain testable with synthetic
  // paths/watchers.
  validateTarget = null,
  onError = (error, filePath) => logger.warn(`[FileSystem] Watcher error for ${filePath}:`, error),
} = {}) {
  const activeWatchers = new Map();
  const senderTargets = new WeakMap();
  const cleanupAttached = new WeakSet();
  const MISSING_WATCH_TARGET_CODES = new Set(['ENOENT', 'ENOTDIR']);
  const senderTargetCap = Number.isFinite(maxTargetsPerSender)
    ? Math.max(1, Math.floor(maxTargetsPerSender))
    : 64;
  const globalTargetCap = Number.isFinite(maxTargets)
    ? Math.max(1, Math.floor(maxTargets))
    : 512;

  const normalizedWatchKey = filePath => {
    let normalized = path.resolve(String(filePath || '')).normalize('NFC');
    // A case-variant spelling must not open another native watcher on the
    // same Windows file.  Preserve the first renderer spelling for messages;
    // the map key alone is case-folded.
    if (platform === 'win32') normalized = normalized.toLowerCase();
    return normalized;
  };

  // Windows directory events are not required to preserve the case supplied
  // by the watch request.  Keys are already case-folded above, but comparing
  // the callback basename literally would make a retarget or replacement
  // invisible whenever the native event uses a different case.  Keep the
  // original request spelling for renderer notifications; fold only this
  // native-name comparison.
  const watchBasenameMatches = (filename, expected) => filename == null
    || (platform === 'win32'
      ? String(filename).toLowerCase() === String(expected).toLowerCase()
      : String(filename) === String(expected));

  const watchLimitError = scope => {
    const error = new Error(scope === 'sender'
      ? `This window is already watching ${senderTargetCap} files.`
      : `The application is already watching ${globalTargetCap} files.`);
    error.code = 'FILE_WATCH_LIMIT_EXCEEDED';
    error.scope = scope;
    error.limit = scope === 'sender' ? senderTargetCap : globalTargetCap;
    return error;
  };

  const targetsForSender = sender => {
    let targets = senderTargets.get(sender);
    if (!targets) {
      targets = new Set();
      senderTargets.set(sender, targets);
    }
    return targets;
  };

  const releaseSenderTarget = (sender, filePath) => {
    const targets = senderTargets.get(sender);
    if (!targets) return;
    targets.delete(filePath);
  };

  const releaseEntryClients = (filePath, entry) => {
    for (const sender of entry.clients.keys()) releaseSenderTarget(sender, filePath);
    entry.clients.clear();
  };

  const broadcast = (filePath, entry) => {
    if (activeWatchers.get(filePath) !== entry) return;
    for (const clientSender of [...entry.clients.keys()]) {
      try {
        if (clientSender.isDestroyed()) {
          removeSender(clientSender, filePath, { all: true });
        } else {
          clientSender.send('file-changed', entry.requestPath || filePath);
        }
      } catch {
        // WebContents can be destroyed between isDestroyed() and send(). Do
        // not let a native fs callback throw; release every refcount it owns.
        removeSender(clientSender, filePath, { all: true });
      }
    }
  };

  // A directory watcher observes names, not a capability to the file those
  // names currently resolve to.  Re-check the lexical target before notifying
  // a renderer so a later private-store swap terminates the subscription.
  // A watch-only hard-link refusal suspends notifications until revalidated;
  // cloud sync can temporarily add a second name to an otherwise safe file.
  // Safe regular replacements may rebind (ordinary atomic text saves rely on
  // that), but every new identity must pass the same single-link policy.
  const validateEntry = (filePath, entry, reason) => {
    if (typeof validateTarget !== 'function') return Promise.resolve(true);
    const prior = entry.validationTail || Promise.resolve();
    const checked = prior.catch(() => {}).then(async () => {
      if (activeWatchers.get(filePath) !== entry || entry.clients.size === 0) return false;
      try {
        entry.targetValidation = await validateTarget(entry.requestPath || filePath, {
          previous: entry.targetValidation || null,
          reason,
        });
        entry.validationSuspended = false;
        if (entry.validationRetryTimer) clearTimeout(entry.validationRetryTimer);
        entry.validationRetryTimer = null;
        return activeWatchers.get(filePath) === entry && entry.clients.size > 0;
      } catch (error) {
        if (activeWatchers.get(filePath) === entry) {
          if (error?.code === 'RENDERER_WORKSPACE_PATH_CHANGED' && error.watchTargetLinked === true) {
            // This lease observes metadata only. It must not notify/read while
            // linked, but need not permanently lose its subscribers. Retry the
            // full lexical/private-path validation even if fs.watch drops the
            // unlink event. Ordinary workspace/read/write refusals stay fatal.
            if (!entry.validationSuspended) onError(error, entry.requestPath || filePath);
            entry.validationSuspended = true;
            if (!entry.validationRetryTimer) {
              entry.validationRetryTimer = setTimeout(() => {
                entry.validationRetryTimer = null;
                void rebindLexicalTarget(filePath, entry);
                broadcastValidated(filePath, entry, 'hardlink-recovery');
              }, retryMs);
            }
          } else {
            onError(error, entry.requestPath || filePath);
            closeEntry(filePath, entry);
          }
        }
        return false;
      }
    });
    entry.validationTail = checked.catch(() => {});
    return checked;
  };

  const broadcastValidated = (filePath, entry, reason = 'event') => {
    if (typeof validateTarget !== 'function') {
      broadcast(filePath, entry);
      return;
    }
    if (entry.broadcastValidationPending) {
      entry.broadcastValidationQueued = true;
      return;
    }
    entry.broadcastValidationPending = true;
    void validateEntry(filePath, entry, reason)
      .then(valid => { if (valid) broadcast(filePath, entry); })
      .finally(() => {
        if (activeWatchers.get(filePath) !== entry) return;
        entry.broadcastValidationPending = false;
        if (entry.broadcastValidationQueued) {
          entry.broadcastValidationQueued = false;
          broadcastValidated(filePath, entry, 'coalesced-event');
        }
      });
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
    // Closing for an access/identity failure can happen while subscribers are
    // still present. Release their quota reservations here rather than waiting
    // for a renderer cleanup that may never arrive after a typed refusal.
    releaseEntryClients(filePath, entry);
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
    if (entry.aliasRetryTimer) clearTimeout(entry.aliasRetryTimer);
    entry.aliasRetryTimer = null;
    if (entry.validationRetryTimer) clearTimeout(entry.validationRetryTimer);
    entry.validationRetryTimer = null;
    stopPolling(filePath, entry);
    stopVerificationPolling(filePath, entry);
    stopAliasPolling(filePath, entry);
    try { entry.watcher?.close(); } catch { /* ignore */ }
    entry.watcher = null;
    try { entry.aliasWatcher?.close(); } catch { /* ignore */ }
    entry.aliasWatcher = null;
    entry.rebindQueued = false;
    entry.broadcastValidationPending = false;
    entry.broadcastValidationQueued = false;
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
    broadcastValidated(filePath, entry, 'native-recovery');
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
        broadcastValidated(filePath, entry, 'poll');
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
        broadcastValidated(filePath, entry, 'verification-poll');
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
        if (!watchBasenameMatches(filename, entry.basename)) return;
        // A regular path can itself be replaced by a final symlink. Normal
        // atomic saves resolve to the same target, while an actual retarget is
        // rebound asynchronously without ever changing the renderer contract.
        if (eventType === 'rename') void rebindLexicalTarget(filePath, entry);
        broadcastValidated(filePath, entry, eventType === 'rename' ? 'rename' : 'native-event');
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
        if (!watchBasenameMatches(filename, entry.aliasBasename)) return;
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
      if (!(await validateEntry(filePath, entry, 'rebind'))) return;
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
      broadcastValidated(filePath, entry, 'rebind');
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
    else {
      entry.clients.delete(sender);
      releaseSenderTarget(sender, filePath);
    }
    if (entry.clients.size === 0) closeEntry(filePath, entry);
  };

  const ensureSenderCleanup = (sender) => {
    if (cleanupAttached.has(sender)) return;
    cleanupAttached.add(sender);
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
    const requestPath = path.resolve(String(filePath || '')).normalize('NFC');
    const watchKey = normalizedWatchKey(requestPath);
    const senderTargetSet = targetsForSender(sender);
    let entry = activeWatchers.get(watchKey);
    if (entry) {
      if (entry.clients.has(sender)) {
        // Keep historical refcount semantics for paired start/stop calls, but
        // charge only one quota slot for this deduplicated target.
        entry.clients.set(sender, entry.clients.get(sender) + 1);
      } else {
        if (senderTargetSet.size >= senderTargetCap) throw watchLimitError('sender');
        senderTargetSet.add(watchKey);
        entry.clients.set(sender, 1);
      }
      ensureSenderCleanup(sender);
      await entry.starting;
      return;
    }

    if (senderTargetSet.size >= senderTargetCap) throw watchLimitError('sender');
    if (activeWatchers.size >= globalTargetCap) throw watchLimitError('global');

    entry = {
      clients: new Map([[sender, 1]]),
      filePath: watchKey,
      requestPath,
      aliasDir: path.dirname(watchKey),
      aliasBasename: path.basename(watchKey),
      dir: path.dirname(watchKey),
      basename: path.basename(watchKey),
      // The registry remains keyed by the renderer spelling so start/stop and
      // broadcasts retain their existing contract. The OS watcher follows the
      // canonical target, however: a final symlink can live in a completely
      // different directory from the file it resolves to.
      watchPath: watchKey,
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
      targetValidation: null,
      validationTail: Promise.resolve(),
      validationSuspended: false,
      validationRetryTimer: null,
      broadcastValidationPending: false,
      broadcastValidationQueued: false,
    };
    senderTargetSet.add(watchKey);
    activeWatchers.set(watchKey, entry);
    ensureSenderCleanup(sender);

    entry.starting = (async () => {
      try {
        if (typeof validateTarget === 'function') {
          entry.targetValidation = await validateTarget(requestPath, {
            previous: null,
            reason: 'start',
          });
        }
        await access(watchKey);
        // A cleanup may have removed the reservation while access was pending.
        if (activeWatchers.get(watchKey) !== entry || entry.clients.size === 0) return;

        const canonicalPath = await realpath(watchKey);
        // The caller can unmount while realpath is in flight too. Do not let
        // that late result resurrect a closed entry or attach a watcher.
        if (activeWatchers.get(watchKey) !== entry || entry.clients.size === 0) return;
        entry.watchPath = canonicalPath;
        entry.dir = path.dirname(canonicalPath);
        entry.basename = path.basename(canonicalPath);

        attachNativeWatcher(watchKey, entry);
        attachAliasWatcher(watchKey, entry);
      } catch (error) {
        if (MISSING_WATCH_TARGET_CODES.has(error?.code)
            && activeWatchers.get(watchKey) === entry && entry.clients.size > 0) {
          // Retain one exact lexical parent subscription for a missing path.
          // Other validation/permission failures still reject and clean up.
          entry.awaitingTarget = true;
          attachAliasWatcher(watchKey, entry);
          return;
        }
        closeEntry(watchKey, entry);
        throw error;
      } finally {
        entry.starting = null;
      }
    })();
    await entry.starting;
  };

  const getCounts = sender => ({
    targets: activeWatchers.size,
    subscriptions: [...activeWatchers.values()]
      .reduce((total, entry) => total + [...entry.clients.values()].reduce((sum, count) => sum + count, 0), 0),
    senderTargets: sender ? (senderTargets.get(sender)?.size || 0) : undefined,
  });

  return {
    start,
    stop: (sender, filePath) => removeSender(sender, normalizedWatchKey(filePath)),
    getCounts,
  };
}

const fileWatchRegistry = createFileWatchRegistry({
  // Follow only a public, regular, single-link resolved target before
  // registration and after each watch event. Public aliases remain supported;
  // a retarget into a private store closes the watcher. A temporary multi-link
  // inode suspends notifications until full validation succeeds again.
  validateTarget: filePath => inspectRendererWatchPath(filePath, { allowMissing: true }),
});

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
export async function scanPath(currentPath, visited, sender = null, depth = 0) {
  // Prevent infinite recursion from symlink loops or massive trees
  if (depth > 15) return null;

  // Guard: Abort recursion if the window that requested it was closed
  if (sender && sender.isDestroyed()) return null;

  try {
    const normalizedPath = path.resolve(currentPath);
    if (isRendererSensitivePath(normalizedPath)) return null;
    let realPath = normalizedPath;
    try { realPath = await fs.promises.realpath(normalizedPath); } catch { /* ignore */ }
    if (isRendererSensitivePath(realPath)) return null;
    if (visited.has(realPath)) return null;
    visited.add(realPath);

    // Skip notoriously large or transient directories/files to prevent thread lock/pollution
    const base = path.basename(normalizedPath);
    if (base === 'node_modules' || base === '.git' || base === '.DS_Store' || base.endsWith('.tmp')) return null;

    // Use lstat to handle symlinks correctly (don't blindly follow if we've seen the path)
    const stats = await fs.promises.lstat(normalizedPath);
    
    if (stats.isDirectory()) {
      const dirItems = await fs.promises.readdir(normalizedPath);
      
      // Process sub-directories sequentially or in small batches to preserve concurrency limit
      const children = [];
      for (const item of dirItems) {
        const child = await scanPath(path.join(normalizedPath, item), visited, sender, depth + 1);
        if (child) children.push(child);
        if (sender && sender.isDestroyed()) return null;
      }
      
      return {
        id: 'group-' + randomUUID(),
        type: 'group',
        title: base || normalizedPath,
        filePath: normalizedPath,
        collapsed: true,
        items: children,
      };
    }
    
    return {
      id: 'doc-' + randomUUID(),
      type: 'document',
      filename: base,
      filePath: normalizedPath,
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

function rendererWorkspacePathChangedError(reason = 'binding-changed') {
  const error = new Error(reason === 'target-hardlink'
    ? 'Another file entry shares this workspace file, which can happen during cloud sync. Saving is paused to protect both copies. Retry after syncing finishes, or use Save As to save a separate copy.'
    : 'The workspace path changed while it was being accessed. Please retry the operation.');
  error.code = 'RENDERER_WORKSPACE_PATH_CHANGED';
  error.workspacePathCheck = reason;
  return error;
}

function rendererWorkspaceRecoveryAmbiguousError() {
  const error = new Error(
    'An interrupted first save left a file that cannot be proven to belong to this workspace. The file was left untouched; choose a new location or resolve it before retrying.',
  );
  // This is deliberately distinct from a generic path-change retry. Callers
  // can present recovery guidance without ever treating an unproven final
  // entry as safe to overwrite, delete, or expose.
  error.code = 'RENDERER_WORKSPACE_RECOVERY_AMBIGUOUS';
  error.recoveryStatus = 'first-save-placeholder-unproven';
  return error;
}

const NO_FOLLOW_FLAG = fs.constants.O_NOFOLLOW || 0;
const NO_FOLLOW_FALLBACK_CODES = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM']);
const RENDERER_WORKSPACE_JOURNAL_DIR = 'renderer-workspace-write-journal';
const RENDERER_WORKSPACE_JOURNAL_VERSION = 3;
const RENDERER_WORKSPACE_FIRST_SAVE_MARKER_PREFIX = 'ICWS-FIRST-SAVE-v1:';
const RENDERER_WORKSPACE_FIRST_SAVE_NONCE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Node has no portable openat(2)/renameat(2)/unlinkat(2) API. In particular,
 * macOS exposes `/dev/fd/N` but does not let Node traverse it as a directory,
 * and Windows has no equivalent namespace. Do not paper over that gap with a
 * supposedly-race-free path recheck.
 *
 * The authority boundary is therefore deliberately narrower: the renderer can
 * request a workspace operation, but never a directory mutation primitive. All
 * workspace writes/deletes below are serialized per canonical target in the
 * main process, and recovery sidecar/journal paths are derived there. The
 * renderer has no IPC that can rename or create a symlink while one of these
 * leases is live.
 * An independently privileged same-user process can always race a pathname on
 * platforms where Node lacks *at syscalls; that hostile-local-process problem
 * is outside this renderer authority boundary and every observed replacement
 * still fails closed. Payload I/O itself is stronger: it is pinned to a file
 * handle, so a late path swap cannot redirect bytes to an Interview store.
 */
const rendererWorkspaceLocks = new Map();

async function withRendererWorkspaceLock(lockKey, operation) {
  const prior = rendererWorkspaceLocks.get(lockKey) || Promise.resolve();
  let release;
  const tail = new Promise(resolve => { release = resolve; });
  rendererWorkspaceLocks.set(lockKey, tail);
  await prior.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (rendererWorkspaceLocks.get(lockKey) === tail) rendererWorkspaceLocks.delete(lockKey);
  }
}

function normalizeRendererWorkspacePath(value, { foldCase = process.platform === 'win32' || process.platform === 'darwin' } = {}) {
  let normalized = path.resolve(value).normalize('NFC');
  // Some Windows filesystem providers return a verbatim `\\?\\` realpath
  // while the renderer/native dialog supplied a normal drive spelling.
  if (process.platform === 'win32' && normalized.startsWith('\\\\?\\')) {
    normalized = normalized.slice(4);
  }
  return foldCase ? normalized.toLowerCase() : normalized;
}

function sameRendererWorkspacePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const normalizedLeft = normalizeRendererWorkspacePath(left);
  const normalizedRight = normalizeRendererWorkspacePath(right);
  // Windows is normally case-insensitive, and macOS volumes can be either.
  // Every accepted path is also identity-bound below, so case folding here only
  // avoids rejecting the same directory when the OS canonicalizes its spelling.
  return normalizedLeft === normalizedRight;
}

// Renderer saves from multiple windows share this key. On Windows, realpath
// providers are not required to return the spelling with a stable drive/path
// case, so a case-folded capability key is necessary to make the serialization
// claim real rather than merely likely. macOS additionally folds for the
// common case-insensitive volume; extra serialization on a case-sensitive
// volume is harmless because the later identity checks still distinguish files.
function rendererWorkspaceLockKey(filePath) {
  return normalizeRendererWorkspacePath(filePath);
}

/**
 * Freeze the public identity of a renderer-controlled workspace path before
 * I/O.  The broad renderer guard is deliberately repeated immediately before
 * opening a handle: a safe spelling can be swapped for a link into an
 * Interview Helper store after an earlier IPC-boundary check.
 */
export async function inspectRendererWorkspacePath(filePath, { allowMissing = false } = {}) {
  const guarded = await assertRendererFilesystemPathAllowed(filePath, { allowMissing });
  const canonicalPath = guarded?.resolvedPath || path.resolve(filePath);
  const parentPath = path.dirname(canonicalPath);
  let parentRealPath;
  let parentStat;
  try {
    [parentRealPath, parentStat] = await Promise.all([
      fs.promises.realpath(parentPath),
      fs.promises.lstat(parentPath),
    ]);
  } catch (error) {
    if (allowMissing && (error?.code === 'ENOENT' || error?.code === 'ENOTDIR')) {
      throw rendererWorkspacePathChangedError('parent-unavailable');
    }
    throw error;
  }
  if (!sameRendererWorkspacePath(parentRealPath, parentPath)
      || !parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw rendererWorkspacePathChangedError(!parentStat.isDirectory() ? 'parent-not-directory'
      : parentStat.isSymbolicLink() ? 'parent-symlink' : 'parent-path-mismatch');
  }

  let targetStat = null;
  try {
    targetStat = await fs.promises.lstat(canonicalPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (!allowMissing) throw error;
  }
  if (targetStat) {
    if (!targetStat.isFile() || targetStat.isSymbolicLink()
        // A public hard link can name an Interview-store inode without any
        // sensitive path component. Workspace documents do not need hard-link
        // semantics, so reject ambiguity before either reads or writes.
        || (typeof targetStat.nlink === 'number' && targetStat.nlink > 1)
        || !sameRendererWorkspacePath(await fs.promises.realpath(canonicalPath), canonicalPath)) {
      throw rendererWorkspacePathChangedError(targetStat.isSymbolicLink() ? 'target-symlink'
        : !targetStat.isFile() ? 'target-not-file'
          : targetStat.nlink > 1 ? 'target-hardlink' : 'target-path-mismatch');
    }
  }
  return {
    originalPath: filePath,
    canonicalPath,
    parentPath,
    parentIdentity: { dev: parentStat.dev, ino: parentStat.ino },
    targetIdentity: targetStat ? { dev: targetStat.dev, ino: targetStat.ino } : null,
    mode: targetStat ? targetStat.mode & 0o777 : 0o600,
    exists: !!targetStat,
  };
}

/**
 * Watch subscriptions have no byte-read or mutation authority, so retain the
 * longstanding public-symlink UX while treating the resolved regular target
 * as the capability.  Unlike a workspace save/read, a directory watcher must
 * deliberately follow a safe alias across ordinary atomic replacements; its
 * registry repeats this inspection before every renderer notification.
 */
export async function inspectRendererWatchPath(filePath, { allowMissing = false } = {}) {
  const guarded = await assertRendererFilesystemPathAllowed(filePath, { allowMissing });
  const canonicalPath = guarded?.resolvedPath || path.resolve(filePath);
  let targetStat = null;
  try {
    targetStat = await fs.promises.lstat(canonicalPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (!allowMissing) throw error;
  }
  if (targetStat && (!targetStat.isFile() || targetStat.isSymbolicLink()
      || (typeof targetStat.nlink === 'number' && targetStat.nlink > 1))) {
    if (targetStat.isFile() && !targetStat.isSymbolicLink() && targetStat.nlink > 1) {
      const error = new Error('Document change notifications are paused while the file has another hard link.');
      error.code = 'RENDERER_WORKSPACE_PATH_CHANGED';
      error.watchTargetLinked = true;
      throw error;
    }
    throw rendererWorkspacePathChangedError();
  }
  return {
    originalPath: filePath,
    canonicalPath,
    targetIdentity: targetStat ? { dev: targetStat.dev, ino: targetStat.ino } : null,
    exists: !!targetStat,
  };
}

async function assertRendererWorkspacePathUnchanged(target) {
  const guarded = await assertRendererFilesystemPathAllowed(target.canonicalPath, { allowMissing: !target.exists });
  if (!guarded?.resolvedPath || !sameRendererWorkspacePath(guarded.resolvedPath, target.canonicalPath)) {
    throw rendererWorkspacePathChangedError();
  }
  const [parentRealPath, parentStat, targetStat] = await Promise.all([
    fs.promises.realpath(target.parentPath),
    fs.promises.lstat(target.parentPath),
    fs.promises.lstat(target.canonicalPath).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error)),
  ]);
  if (!sameRendererWorkspacePath(parentRealPath, target.parentPath)
      || !parentStat.isDirectory() || parentStat.isSymbolicLink()
      || !hasSameIdentity(parentStat, target.parentIdentity)) {
    throw rendererWorkspacePathChangedError();
  }
  if (!target.exists) {
    if (targetStat) throw rendererWorkspacePathChangedError();
    return null;
  }
  if (!targetStat || !targetStat.isFile() || targetStat.isSymbolicLink()
      || !hasSameIdentity(targetStat, target.targetIdentity)) {
    throw rendererWorkspacePathChangedError();
  }
  return targetStat;
}

async function openNoFollowWorkspaceHandle(filePath, flags, mode) {
  try {
    return await fs.promises.open(filePath, flags | NO_FOLLOW_FLAG, mode);
  } catch (error) {
    // Some Windows/network filesystems reject O_NOFOLLOW. Falling back is safe
    // only because the opened handle is identity-bound before it is read or
    // mutated; a final symlink can at most be opened and immediately rejected.
    if (!NO_FOLLOW_FLAG || !NO_FOLLOW_FALLBACK_CODES.has(error?.code)) throw error;
    return fs.promises.open(filePath, flags, mode);
  }
}

/**
 * Prove that a handle is still the exact public workspace entry that was
 * approved. This check deliberately happens *after* open: if a parent was
 * swapped between validation and open, the handle's identity cannot be made to
 * match both the old public file and the newly resolved private spelling.
 */
async function assertRendererWorkspaceHandleBinding(target, handleStat, {
  allowCreated = false,
} = {}) {
  const guarded = await assertRendererFilesystemPathAllowed(target.canonicalPath, { allowMissing: false });
  const [parentRealPath, parentStat, entryStat] = await Promise.all([
    fs.promises.realpath(target.parentPath),
    fs.promises.lstat(target.parentPath),
    fs.promises.lstat(target.canonicalPath),
  ]);
  if (!guarded?.resolvedPath || !sameRendererWorkspacePath(guarded.resolvedPath, target.canonicalPath)
      || !sameRendererWorkspacePath(parentRealPath, target.parentPath)
      || !parentStat.isDirectory() || parentStat.isSymbolicLink()
      || !hasSameIdentity(parentStat, target.parentIdentity)
      || !entryStat.isFile() || entryStat.isSymbolicLink()
      || (typeof entryStat.nlink === 'number' && entryStat.nlink > 1)
      || !handleStat?.isFile?.() || !hasSameIdentity(entryStat, handleStat)
      || (typeof handleStat?.nlink === 'number' && handleStat.nlink > 1)
      || (target.exists && !hasSameIdentity(handleStat, target.targetIdentity))
      || (!target.exists && !allowCreated)) {
    throw rendererWorkspacePathChangedError();
  }
  return {
    ...target,
    exists: true,
    targetIdentity: { dev: handleStat.dev, ino: handleStat.ino },
    mode: handleStat.mode & 0o777,
  };
}

async function openRendererWorkspaceFileHandle(target, {
  writable = false,
  create = false,
} = {}) {
  await assertRendererWorkspacePathUnchanged(target);
  const flags = writable ? fs.constants.O_RDWR : fs.constants.O_RDONLY;
  let handle;
  let created = false;
  try {
    handle = await openNoFollowWorkspaceHandle(target.canonicalPath, flags, target.mode);
  } catch (error) {
    if (!create || target.exists || error?.code !== 'ENOENT') throw error;
    // O_EXCL means an existing private record cannot be overwritten if an
    // external actor wins the final-name race. If an unsupported platform
    // follows a swapped *parent*, the post-open binding below rejects before
    // any renderer bytes are written. Node cannot remove that zero-length
    // external artifact safely without unlinkat. Renderer code cannot create
    // or repoint a link in this lease (that mutation capability is not exposed
    // by any IPC); an independently privileged local process is outside the
    // renderer authority boundary and still receives no renderer/private bytes.
    handle = await openNoFollowWorkspaceHandle(
      target.canonicalPath,
      flags | fs.constants.O_CREAT | fs.constants.O_EXCL,
      target.mode,
    );
    created = true;
  }
  try {
    const handleStat = await handle.stat();
    const boundTarget = await assertRendererWorkspaceHandleBinding(target, handleStat, { allowCreated: created });
    return { handle, target: boundTarget, created };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

function workspacePayloadBuffer(data) {
  // Recovery integrity is byte-exact: equivalent JSON spellings are not
  // canonicalized or reserialized before their WAL digest is recorded. The
  // only invariant is replaying exactly the bytes the renderer asked to save.
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  return Buffer.from(String(data), 'utf8');
}

function workspaceFirstSaveMarker(creationNonce) {
  if (typeof creationNonce !== 'string' || !RENDERER_WORKSPACE_FIRST_SAVE_NONCE_RE.test(creationNonce)) {
    throw rendererWorkspaceRecoveryAmbiguousError();
  }
  // This is intentionally not JSON. If a power loss also loses the private
  // WAL directory entry, a caller gets an invalid-workspace failure rather
  // than silently accepting a placeholder as a real canvas. The WAL digest is
  // over the caller's exact UTF-8 bytes; JSON canonicalization is neither
  // performed nor needed for replay.
  return Buffer.from(`${RENDERER_WORKSPACE_FIRST_SAVE_MARKER_PREFIX}${creationNonce}\n`, 'utf8');
}

async function writeHandleBufferAt(handle, payload, position = 0) {
  let offset = 0;
  while (offset < payload.length) {
    const { bytesWritten } = await handle.write(payload, offset, payload.length - offset, position + offset);
    if (!bytesWritten) throw new Error('Could not write the complete workspace payload.');
    offset += bytesWritten;
  }
}

async function writeWorkspaceHandle(handle, payload) {
  await handle.truncate(0);
  await writeHandleBufferAt(handle, payload);
  await handle.truncate(payload.length);
  await handle.sync();
  const after = await handle.stat();
  if (!after.isFile() || after.size !== payload.length) throw rendererWorkspacePathChangedError();
}

async function writeWorkspaceFirstSaveMarker(handle, creationNonce) {
  const marker = workspaceFirstSaveMarker(creationNonce);
  await handle.truncate(0);
  await writeHandleBufferAt(handle, marker);
  await handle.truncate(marker.length);
  await handle.sync();
  const after = await handle.stat();
  if (!after.isFile() || after.size !== marker.length) throw rendererWorkspacePathChangedError();
}

async function hasWorkspaceFirstSaveMarker(handle, creationNonce) {
  const marker = workspaceFirstSaveMarker(creationNonce);
  const stat = await handle.stat();
  if (!stat.isFile() || stat.size !== marker.length) return false;
  const actual = Buffer.allocUnsafe(marker.length);
  let offset = 0;
  while (offset < actual.length) {
    const { bytesRead } = await handle.read(actual, offset, actual.length - offset, offset);
    if (!bytesRead) return false;
    offset += bytesRead;
  }
  const after = await handle.stat();
  return hasSameIdentity(after, stat)
    && after.size === stat.size
    && after.mtimeMs === stat.mtimeMs
    && after.ctimeMs === stat.ctimeMs
    && actual.equals(marker);
}

async function assertWorkspaceHandlePayload(handle, payload) {
  const before = await handle.stat();
  if (!before.isFile() || before.size !== payload.length) throw rendererWorkspacePathChangedError();
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(payload.length, 1)));
  let position = 0;
  while (position < before.size) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, before.size - position),
      position,
    );
    if (!bytesRead) throw rendererWorkspacePathChangedError();
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  const after = await handle.stat();
  if (!hasSameIdentity(after, before)
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
      || digest.digest('hex') !== createHash('sha256').update(payload).digest('hex')) {
    throw rendererWorkspacePathChangedError();
  }
}

function workspaceMutationJournalName(target) {
  // Windows names are case-insensitive, so two case spellings must resolve to
  // one host record just as they resolve to one process-local mutation lease.
  // Do not fold macOS here: a case-sensitive volume may legitimately contain
  // two distinct canvas names and host recovery records must remain distinct.
  const key = normalizeRendererWorkspacePath(target.canonicalPath, {
    foldCase: process.platform === 'win32',
  });
  return `${createHash('sha256').update(key).digest('hex')}.journal`;
}

async function rendererWorkspaceJournalDirectory() {
  const userDataPath = app?.getPath?.('userData');
  if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) {
    throw new Error('The application workspace recovery store is unavailable.');
  }
  // Electron owns userData; never accept a renderer-supplied root here. The
  // final component is a fixed host-private namespace and is blocked by the
  // renderer path guard in pathSafety.
  await fs.promises.mkdir(userDataPath, { recursive: true, mode: 0o700 });
  const userDataStat = await fs.promises.lstat(userDataPath);
  if (!userDataStat.isDirectory() || userDataStat.isSymbolicLink()) {
    throw new Error('The application workspace recovery store is unsafe.');
  }
  const realUserDataPath = await fs.promises.realpath(userDataPath);
  const directory = path.join(realUserDataPath, RENDERER_WORKSPACE_JOURNAL_DIR);
  try {
    await fs.promises.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const [stat, realDirectory] = await Promise.all([
    fs.promises.lstat(directory),
    fs.promises.realpath(directory),
  ]);
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || !sameRendererWorkspacePath(realDirectory, directory)) {
    throw new Error('The application workspace recovery store is unsafe.');
  }
  return directory;
}

async function writeWorkspaceMutationJournal(target, payload, {
  // A first-save record is intentionally created before O_EXCL. Its nonce is
  // later written to the just-created inode as a short, fsynced marker before
  // that inode can receive renderer bytes. That lets recovery distinguish an
  // owned placeholder from a same-name file created by somebody else.
  creationNonce = target.exists ? null : randomUUID(),
} = {}) {
  if (!target.exists && (typeof creationNonce !== 'string'
      || !RENDERER_WORKSPACE_FIRST_SAVE_NONCE_RE.test(creationNonce))) {
    throw rendererWorkspaceRecoveryAmbiguousError();
  }
  const directory = await rendererWorkspaceJournalDirectory();
  const journalPath = path.join(directory, workspaceMutationJournalName(target));
  const expectedAbsent = !target.exists;
  const header = Buffer.from(`${JSON.stringify({
    version: RENDERER_WORKSPACE_JOURNAL_VERSION,
    canonicalPath: target.canonicalPath,
    targetIdentity: target.targetIdentity,
    parentIdentity: target.parentIdentity,
    expectedAbsent,
    ...(expectedAbsent ? { creationNonce } : {}),
    payloadBytes: payload.length,
    payloadDigest: createHash('sha256').update(payload).digest('hex'),
  })}\n`, 'utf8');
  const tempPath = path.join(directory, `.${path.basename(journalPath)}.${randomUUID()}.tmp`);
  let handle = null;
  let tempCreated = false;
  try {
    handle = await openNoFollowWorkspaceHandle(
      tempPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    tempCreated = true;
    await writeHandleBufferAt(handle, header);
    await writeHandleBufferAt(handle, payload, header.length);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(tempPath, journalPath);
    tempCreated = false;
    // `false` is the explicit Windows/no-directory-fsync result. It is kept
    // as metadata rather than being mistaken for a namespace durability
    // guarantee; the payload and marker handles themselves are still fsynced.
    const directorySyncConfirmed = await syncTextParentDirectory(directory);
    return { journalPath, creationNonce: expectedAbsent ? creationNonce : null, directorySyncConfirmed };
  } finally {
    await handle?.close().catch(() => {});
    if (tempCreated) await fs.promises.unlink(tempPath).catch(() => {});
  }
}

async function readWorkspaceMutationJournal(target) {
  const directory = await rendererWorkspaceJournalDirectory();
  const journalPath = path.join(directory, workspaceMutationJournalName(target));
  let bytes;
  try {
    bytes = await fs.promises.readFile(journalPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const newline = bytes.indexOf(0x0a);
  if (newline < 1) throw new Error('The application workspace recovery record is invalid.');
  let header;
  try {
    header = JSON.parse(bytes.subarray(0, newline).toString('utf8'));
  } catch {
    throw new Error('The application workspace recovery record is invalid.');
  }
  const payload = bytes.subarray(newline + 1);
  // Version 1 records were written only after an existing/new final entry had
  // already been bound, so they always have the exact-inode semantics below.
  // Version 2 introduced a provisional expected-absent record but had no
  // ownership marker; a v2 record can be resumed only while its target is
  // still absent, and can never trust an entry that already exists. Keep old
  // exact records recoverable across an update rather than turning an
  // interrupted save into a permanently opaque file.
  const legacyExactEntry = header?.version === 1;
  const markerCapableEntry = header?.version === RENDERER_WORKSPACE_JOURNAL_VERSION;
  const provisionalEntry = header?.version === 2 || markerCapableEntry;
  const expectedAbsent = provisionalEntry
    ? header.expectedAbsent === true
    : false;
  const creationNonce = expectedAbsent && markerCapableEntry ? header.creationNonce : null;
  if ((!legacyExactEntry && !provisionalEntry)
      || (provisionalEntry
        && typeof header.expectedAbsent !== 'boolean')
      || !sameRendererWorkspacePath(header.canonicalPath, target.canonicalPath)
      || !Number.isSafeInteger(header.payloadBytes) || header.payloadBytes < 0
      || header.payloadBytes !== payload.length
      || !/^[a-f0-9]{64}$/u.test(header.payloadDigest || '')
      || (expectedAbsent && markerCapableEntry
        && (typeof creationNonce !== 'string' || !RENDERER_WORKSPACE_FIRST_SAVE_NONCE_RE.test(creationNonce)))
      || createHash('sha256').update(payload).digest('hex') !== header.payloadDigest) {
    throw rendererWorkspacePathChangedError();
  }
  if (expectedAbsent) {
    if (header.targetIdentity != null || !header.parentIdentity
        || !hasSameIdentity(header.parentIdentity, target.parentIdentity)) {
      throw rendererWorkspacePathChangedError();
    }
  } else if (!header.targetIdentity || !target.exists || !target.targetIdentity
      || !hasSameIdentity(header.targetIdentity, target.targetIdentity)
      || (header.parentIdentity && !hasSameIdentity(header.parentIdentity, target.parentIdentity))) {
    throw rendererWorkspacePathChangedError();
  }
  return { journalPath, payload, expectedAbsent, creationNonce };
}

async function clearWorkspaceMutationJournal(journalPath) {
  await fs.promises.unlink(journalPath);
  return syncTextParentDirectory(path.dirname(journalPath));
}

async function recoverRendererWorkspaceMutation(target) {
  const journal = await readWorkspaceMutationJournal(target);
  if (!journal) return false;
  let opened;
  try {
    opened = await openRendererWorkspaceFileHandle(target, {
      writable: true,
      create: journal.expectedAbsent && !target.exists,
    });
  } catch (error) {
    // A pathname can appear between our missing-target inspection and O_EXCL.
    // It was not created by this recovery lease, so convert the normal EEXIST
    // into the explicit fail-closed recovery state rather than retrying against
    // or mutating its bytes.
    if (journal.expectedAbsent && !target.exists && error?.code === 'EEXIST') {
      throw rendererWorkspaceRecoveryAmbiguousError();
    }
    throw error;
  }
  let finalJournal = journal;
  try {
    if (journal.expectedAbsent) {
      if (target.exists) {
        // A v2 provisional record predates the marker protocol. It has no
        // proof that this existing path entry was created by us, so touching it
        // would be an unsafe overwrite. A v3 marker must be an exact match
        // before recovery can turn its owned placeholder into canvas bytes.
        if (!journal.creationNonce
            || !await hasWorkspaceFirstSaveMarker(opened.handle, journal.creationNonce)) {
          throw rendererWorkspaceRecoveryAmbiguousError();
        }
      } else {
        // O_EXCL just created this entry. Bind it first, then make the marker
        // durable before the exact journal can authorize a payload write.
        // A v2 journal predates persisted nonces. It is still safe to resume
        // only because this invocation won O_EXCL while the target was absent;
        // a later crash before its exact rewrite is conservatively ambiguous.
        await writeWorkspaceFirstSaveMarker(opened.handle, journal.creationNonce || randomUUID());
        await assertRendererWorkspaceHandleBinding(opened.target, await opened.handle.stat());
      }
      // Persist the exact O_EXCL-created inode before it can receive canvas
      // bytes. The marker is self-healed by the following payload write.
      await assertRendererWorkspaceHandleBinding(opened.target, await opened.handle.stat());
      finalJournal = await writeWorkspaceMutationJournal(opened.target, journal.payload);
    }
    // The WAL write itself performs no canvas I/O, so repeat the binding proof
    // immediately before the first destructive truncate/write. This catches
    // an observed parent replacement or newly-added hard link during journal
    // publication rather than writing a payload through a stale handle.
    await assertRendererWorkspaceHandleBinding(opened.target, await opened.handle.stat());
    await writeWorkspaceHandle(opened.handle, journal.payload);
    await assertWorkspaceHandlePayload(opened.handle, journal.payload);
    await assertRendererWorkspaceHandleBinding(opened.target, await opened.handle.stat());
  } finally {
    await opened.handle.close().catch(() => {});
  }
  await clearWorkspaceMutationJournal(finalJournal.journalPath);
  return true;
}

/** Read through a bound handle and verify its public entry before exposing bytes. */
export async function readRendererWorkspaceFile(filePath, {
  maxBytes = null,
  encoding = 'utf8',
  // Test seams prove that a replacement after open/read is never returned as
  // successful content. Production callers do not receive these callbacks.
  beforeRead = null,
  beforeFinalVerification = null,
} = {}) {
  const initialTarget = typeof filePath === 'string'
    ? await inspectRendererWorkspacePath(filePath, { allowMissing: true })
    : filePath;
  if (!initialTarget) throw rendererWorkspacePathChangedError();
  return withRendererWorkspaceLock(rendererWorkspaceLockKey(initialTarget.canonicalPath), async () => {
    // A pending write-ahead record is host-owned and can finish only against
    // the exact inode it recorded (or the staged first-save entry). Never
    // parse a potentially partial canvas.
    let target = await inspectRendererWorkspacePath(initialTarget.canonicalPath, { allowMissing: true });
    await recoverRendererWorkspaceMutation(target);
    target = await inspectRendererWorkspacePath(initialTarget.canonicalPath);
    const opened = await openRendererWorkspaceFileHandle(target);
    try {
      const stat = await opened.handle.stat();
      await assertRendererWorkspaceHandleBinding(opened.target, stat);
      if (maxBytes != null && stat.size > maxBytes) {
        // A size refusal must not become an ambiguous success for a path that
        // was replaced immediately after its handle opened. No bytes are
        // returned here, but callers still use this result to report the path.
        const after = await opened.handle.stat();
        if (!hasSameIdentity(after, stat)
            || after.size !== stat.size
            || after.mtimeMs !== stat.mtimeMs
            || after.ctimeMs !== stat.ctimeMs) {
          throw rendererWorkspacePathChangedError();
        }
        await assertRendererWorkspaceHandleBinding(opened.target, after);
        return { target: opened.target, stat: after, content: null, tooLarge: true };
      }
      if (beforeRead) await beforeRead({ target: opened.target, handle: opened.handle, stat });
      const content = encoding == null
        ? await opened.handle.readFile()
        : await opened.handle.readFile({ encoding });
      if (beforeFinalVerification) await beforeFinalVerification({ target: opened.target, handle: opened.handle, stat });
      // An external replacement after the read must not be represented as a
      // successful load of the renderer's requested path.
      const after = await opened.handle.stat();
      if (!hasSameIdentity(after, stat)
          || after.size !== stat.size
          || after.mtimeMs !== stat.mtimeMs
          || after.ctimeMs !== stat.ctimeMs) {
        throw rendererWorkspacePathChangedError();
      }
      await assertRendererWorkspaceHandleBinding(opened.target, after);
      return { target: opened.target, stat, content, tooLarge: false };
    } finally {
      await opened.handle.close().catch(() => {});
    }
  });
}

async function readRendererWorkspaceBytesIfPresent(filePath) {
  try {
    return (await readRendererWorkspaceFile(filePath, { encoding: null })).content;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Write through a handle anchored to the inspected public inode. The historic
 * export name remains for callers, but this is intentionally not a namespace
 * `rename()` on macOS/Windows: Node cannot make that rename both portable and
 * descriptor-relative. A host-private write-ahead record makes a crash during
 * the in-place phase recoverable on the next save/load; success means the
 * handle was synced, its public binding still matched, and that record cleared.
 * The payload file is fsynced, but a platform that does not expose directory
 * fsync (notably Windows) cannot certify journal-directory metadata durability;
 * `returnMetadata` exposes that state rather than claiming namespace-atomic
 * power-loss semantics. The unavoidable O_EXCL→marker crash sliver likewise
 * fails closed with `RENDERER_WORKSPACE_RECOVERY_AMBIGUOUS`; it never trusts,
 * deletes, overwrites, or returns the unproven final entry.
 */
export async function atomicWriteRendererWorkspaceFile(filePath, data, options = {}) {
  try {
    const result = await writeRendererWorkspaceFile(filePath, data, options);
    recordWorkspaceWriteOutcome();
    return result;
  } catch (error) {
    recordWorkspaceWriteOutcome(error);
    throw error;
  }
}

async function writeRendererWorkspaceFile(filePath, data, {
  // Test seams model both the validation→open gap and late swaps after a
  // handle is bound; production callers do not supply these callbacks.
  beforeOpen = null,
  beforeFirstSaveMarker = null,
  beforeBindJournal = null,
  beforeWrite = null,
  beforeFinalVerification = null,
  // Retain the former name as a non-production compatibility seam for focused
  // regression callers while making its timing explicit above.
  beforePublishedVerification = null,
  // Direct callers historically receive a string. IPC callers opt into this
  // metadata so Windows/no-directory-fsync hosts never receive a misleading
  // full power-loss durability implication from a successful handle write.
  returnMetadata = false,
} = {}) {
  const initialTarget = typeof filePath === 'string'
    ? await inspectRendererWorkspacePath(filePath, { allowMissing: true })
    : filePath;
  return withRendererWorkspaceLock(rendererWorkspaceLockKey(initialTarget.canonicalPath), async () => {
    let target = await inspectRendererWorkspacePath(initialTarget.canonicalPath, { allowMissing: true });
    const payload = workspacePayloadBuffer(data);
    await recoverRendererWorkspaceMutation(target);
    target = await inspectRendererWorkspacePath(initialTarget.canonicalPath, { allowMissing: true });
    let opened = null;
    let mutationJournal = null;
    // Node's Windows directory-handle behavior cannot certify a directory
    // metadata flush even if a provider accepts `sync()`. Keep the success
    // contract honest by reporting that platform as unverified rather than
    // inferring POSIX fsync semantics from a best-effort call.
    let journalDirectorySyncConfirmed = process.platform !== 'win32';
    try {
      // Existing files are bound before their recovery record is staged. For a
      // missing target, stage first so a crash immediately after O_EXCL file
      // creation can still finish the exact payload on next open.
      if (!target.exists) {
        mutationJournal = await writeWorkspaceMutationJournal(target, payload);
        journalDirectorySyncConfirmed = journalDirectorySyncConfirmed
          && mutationJournal.directorySyncConfirmed !== false;
      }
      if (beforeOpen) await beforeOpen({ target });
      opened = await openRendererWorkspaceFileHandle(target, { writable: true, create: true });
      await assertRendererWorkspaceHandleBinding(opened.target, await opened.handle.stat());
      if (!target.exists) {
        // Make the provisional journal's unpredictable capability visible on
        // the exact inode before any callback or renderer payload. A crash
        // after this point can only resume a placeholder bearing this nonce.
        if (beforeFirstSaveMarker) {
          await beforeFirstSaveMarker({ target: opened.target, handle: opened.handle, created: opened.created });
        }
        await writeWorkspaceFirstSaveMarker(opened.handle, mutationJournal.creationNonce);
        await assertRendererWorkspaceHandleBinding(opened.target, await opened.handle.stat());
      }
      if (!target.exists && beforeBindJournal) {
        await beforeBindJournal({ target: opened.target, handle: opened.handle, created: opened.created });
      }
      // Upgrade a first-save provisional record to an exact handle identity
      // before writing a single renderer byte. This makes a later replacement
      // unambiguously rejectable on recovery.
      if (!target.exists || !mutationJournal) {
        await assertRendererWorkspaceHandleBinding(opened.target, await opened.handle.stat());
        mutationJournal = await writeWorkspaceMutationJournal(opened.target, payload);
        journalDirectorySyncConfirmed = journalDirectorySyncConfirmed
          && mutationJournal.directorySyncConfirmed !== false;
      }
      if (beforeWrite) await beforeWrite({ target: opened.target, handle: opened.handle, created: opened.created });

      // Re-prove the path after every callback and WAL publication. A handle
      // pins bytes, but an added hard link could otherwise make that public
      // inode simultaneously reachable from a private store. The remaining
      // check→write OS sliver is the documented no-*at external-process
      // limitation; renderer code has no mutation primitive in this lease.
      await assertRendererWorkspaceHandleBinding(opened.target, await opened.handle.stat());
      await writeWorkspaceHandle(opened.handle, payload);
      const contentDigest = createHash('sha256').update(payload).digest('hex');
      const verification = beforeFinalVerification || beforePublishedVerification;
      if (verification) {
        await verification({
          target: opened.target,
          handle: opened.handle,
          contentDigest,
          created: opened.created,
          // Compatibility for focused callers that used the former
          // post-rename seam. This is now the pinned public entry, not a temp.
          finalPath: opened.target.canonicalPath,
          tempIdentity: opened.target.targetIdentity,
        });
      }
      await assertWorkspaceHandlePayload(opened.handle, payload);
      await assertRendererWorkspaceHandleBinding(opened.target, await opened.handle.stat());
      const clearDirectorySyncConfirmed = await clearWorkspaceMutationJournal(mutationJournal.journalPath);
      journalDirectorySyncConfirmed = journalDirectorySyncConfirmed
        && clearDirectorySyncConfirmed !== false;
      mutationJournal = null;
      const result = {
        filePath: opened.target.canonicalPath,
        // `payload-fsynced` is deliberately narrower than a power-loss
        // namespace-atomic promise. The false state is observable by the IPC
        // caller and means the journal directory could not be synced (the
        // normal Windows limitation), so retry/recovery guidance can remain
        // honest without making ordinary Windows saves unusable.
        recoveryStatus: journalDirectorySyncConfirmed
          ? 'payload-fsynced-and-wal-directory-synced'
          : 'wal-directory-durability-unverified',
      };
      return returnMetadata ? result : result.filePath;
    } catch (error) {
      // A staged first-save record that never produced a bound handle has no
      // bytes to recover. Removing only this host-private record lets a later
      // deliberate save retry normally; any entry a raced parent open created
      // contains no renderer payload and was never treated as success.
      if (!opened && mutationJournal) {
        await clearWorkspaceMutationJournal(mutationJournal.journalPath).catch(() => {});
        mutationJournal = null;
      }
      throw error;
    } finally {
      // A retained journal is intentional: it is the durable proof needed to
      // finish a partially completed in-place write after a crash or failure.
      // Preserve the typed pre-open failure (for example a path-bind or
      // first-save recovery refusal).  A `finally` TypeError here used to
      // obscure that cause whenever opening the public entry itself failed.
      if (opened) await opened.handle.close().catch(() => {});
    }
  });
}

/**
 * Remove a host-derived sidecar/journal after binding it to a regular public
 * file. `unlink` has no FileHandle form in Node, so physical removal is the one
 * narrow operation protected by the serialized main-process capability boundary
 * documented above. It is never exposed as a renderer-selected unlink IPC.
 */
async function removeRendererWorkspaceFileIfPresent(filePath, {
  beforeDelete = null,
} = {}) {
  const initialTarget = await inspectRendererWorkspacePath(filePath, { allowMissing: true });
  return withRendererWorkspaceLock(rendererWorkspaceLockKey(initialTarget.canonicalPath), async () => {
    let target = await inspectRendererWorkspacePath(initialTarget.canonicalPath, { allowMissing: true });
    await recoverRendererWorkspaceMutation(target);
    target = await inspectRendererWorkspacePath(initialTarget.canonicalPath, { allowMissing: true });
    if (!target.exists) return false;
    const opened = await openRendererWorkspaceFileHandle(target);
    let handleClosed = false;
    try {
      await assertRendererWorkspaceHandleBinding(opened.target, await opened.handle.stat());
      if (beforeDelete) await beforeDelete({ target: opened.target, handle: opened.handle });
      // Reject every observed directory/file replacement before the sole
      // pathname-only primitive. A compromised renderer cannot manufacture a
      // swap in this host-only lease, and a separate local process is the
      // documented Node-*at limitation rather than an implied guarantee.
      await assertRendererWorkspaceHandleBinding(opened.target, await opened.handle.stat());
      // Windows commonly refuses to unlink an open FileHandle. The capability
      // proof and renderer-operation lease remain in force after close; closing
      // here keeps ordinary sidecar/journal deletion functional on Windows.
      await opened.handle.close();
      handleClosed = true;
      await fs.promises.unlink(opened.target.canonicalPath);
      await syncTextParentDirectory(opened.target.parentPath);
      return true;
    } finally {
      if (!handleClosed) await opened.handle.close().catch(() => {});
    }
  });
}

const RECOVERY_REBIND_JOURNAL_VERSION = 1;
/**
 * Recovery ownership is a path-keyed host capability. Unlike a display path,
 * its Windows key must not depend on the case returned by a dialog, watcher,
 * or filesystem provider: all of those spellings name the same entry on the
 * normal case-insensitive Windows namespace. Keep this separate from the
 * general workspace normalizer so focused tests can model Windows on macOS.
 */
function normalizeRecoveryRebindPath(value, { platform = process.platform } = {}) {
  let normalized = path.resolve(value).normalize('NFC');
  if (platform === 'win32' && normalized.startsWith('\\\\?\\')) normalized = normalized.slice(4);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function sameRecoveryRebindPath(left, right, options = {}) {
  return typeof left === 'string' && typeof right === 'string'
    && normalizeRecoveryRebindPath(left, options) === normalizeRecoveryRebindPath(right, options);
}

function recoveryRebindJournalPath(
  oldCanvasPath,
  newCanvasPath,
  journalDirectory = path.dirname(newCanvasPath),
  options = {},
) {
  const digest = createHash('sha256').update(
    `${normalizeRecoveryRebindPath(oldCanvasPath, options)}\u0000${normalizeRecoveryRebindPath(newCanvasPath, options)}`,
  ).digest('hex').slice(0, 24);
  return path.join(journalDirectory, `.ic-recovery-rebind-${digest}.json`);
}

function recoveryRebindJournalPaths(oldCanvasPath, newCanvasPath, options = {}) {
  const targetJournal = recoveryRebindJournalPath(oldCanvasPath, newCanvasPath, path.dirname(newCanvasPath), options);
  const sourceDirectory = path.dirname(oldCanvasPath);
  return sameRecoveryRebindPath(sourceDirectory, path.dirname(newCanvasPath), options)
    ? [targetJournal]
    : [targetJournal, recoveryRebindJournalPath(oldCanvasPath, newCanvasPath, sourceDirectory, options)];
}

async function writeRecoveryRebindJournal(journalPath, journal) {
  // Journal paths derive from renderer-selected canvas directories. Bind their
  // preflight/read/write to the same no-follow workspace seam so a late parent
  // swap cannot make recovery bookkeeping inspect or create private records.
  const canonicalJournal = {
    ...journal,
    oldCanvasPath: normalizeRecoveryRebindPath(journal.oldCanvasPath),
    newCanvasPath: normalizeRecoveryRebindPath(journal.newCanvasPath),
  };
  const existingTarget = await inspectRendererWorkspacePath(journalPath, { allowMissing: true });
  if (existingTarget.exists) {
    // The deterministic journal name is an ownership slot, not an invitation
    // to overwrite a user-created regular JSON file or a stale transaction.
    // Only this exact transaction may advance its own prepared record to the
    // canvas-written phase (or rewrite the same phase after a retry).
    const prior = await readRecoveryRebindJournal(journalPath);
    const sameOwner = prior
      && sameRecoveryRebindPath(prior.oldCanvasPath, canonicalJournal.oldCanvasPath)
      && sameRecoveryRebindPath(prior.newCanvasPath, canonicalJournal.newCanvasPath)
      && prior.canvasDigest === canonicalJournal.canvasDigest
      && prior.previousTargetDigest === canonicalJournal.previousTargetDigest
      && JSON.stringify(prior.renameAttestation || null) === JSON.stringify(canonicalJournal.renameAttestation || null);
    const allowedPhase = sameOwner
      && ((prior.phase === canonicalJournal.phase) || (prior.phase === 'prepared' && canonicalJournal.phase === 'canvas-written'));
    if (!allowedPhase) throw new Error('Recovery rebind journal path conflicts with another transaction.');
  }
  await atomicWriteRendererWorkspaceFile(journalPath, `${JSON.stringify(canonicalJournal)}\n`);
}

async function readRecoveryRebindJournal(journalPath) {
  try {
    const { content, tooLarge } = await readRendererWorkspaceFile(journalPath, { maxBytes: 16 * 1024 });
    if (tooLarge) return null;
    const parsed = JSON.parse(content);
    if (parsed?.version !== RECOVERY_REBIND_JOURNAL_VERSION
      || typeof parsed.oldCanvasPath !== 'string' || typeof parsed.newCanvasPath !== 'string'
      || !/^[a-f0-9]{64}$/.test(parsed.canvasDigest || '')
      || !(parsed.previousTargetDigest == null || /^[a-f0-9]{64}$/.test(parsed.previousTargetDigest))
      || !(parsed.renameAttestation == null
        || (Number.isSafeInteger(parsed.renameAttestation.dev) && Number.isSafeInteger(parsed.renameAttestation.ino)
          && parsed.renameAttestation.ino > 0))) return null;
    const oldPath = normalizeRecoveryRebindPath(parsed.oldCanvasPath);
    const newPath = normalizeRecoveryRebindPath(parsed.newCanvasPath);
    if (!recoveryRebindJournalPaths(oldPath, newPath).some(candidate => sameRecoveryRebindPath(candidate, journalPath))
      || !['prepared', 'canvas-written'].includes(parsed.phase)) return null;
    return { ...parsed, oldCanvasPath: oldPath, newCanvasPath: newPath };
  } catch { return null; }
}

async function fsyncDirectory(directory) {
  const handle = await fs.promises.open(directory, 'r').catch(() => null);
  if (!handle) return;
  try { await handle.sync(); } finally { await handle.close(); }
}

async function clearRecoveryRebindJournals(oldCanvasPath, newCanvasPath) {
  const journalPaths = recoveryRebindJournalPaths(oldCanvasPath, newCanvasPath);
  await Promise.all(journalPaths.map(journalPath => removeRendererWorkspaceFileIfPresent(journalPath)));
  await Promise.all([...new Set(journalPaths.map(journalPath => path.dirname(journalPath)))].map(fsyncDirectory));
}

/**
 * Validate a renderer-requested mutation target. Canvas JSON is portable and
 * therefore untrusted: a node can claim an arbitrary path, but it must not use
 * the delete/editor IPC to modify credentials, system state, or the canvas file
 * that is currently open. Returns the normalized path the OS operation should
 * receive (preserving a final symlink rather than trashing its target).
 */
async function inspectMutablePath(filePath, {
  sender = null,
  textOnly = false,
  // Main-process/internal previews retain their historic read-only hard-link
  // behavior. Renderer IPC explicitly opts in, because a public hard-link can
  // otherwise name an Interview-store inode without a sensitive pathname.
  rejectHardlinks = false,
} = {}) {
  if (typeof filePath !== 'string' || !filePath.trim() || !path.isAbsolute(filePath)) {
    throw new Error('A valid absolute file path is required.');
  }
  const normalizedPath = path.resolve(filePath);
  // Reject the renderer spelling before realpath/lstat so a private store is
  // never probed through the generic editor/delete IPC.
  if (isRendererSensitivePath(normalizedPath)) {
    throw privateRendererPathError();
  }
  const resolvedPath = await fs.promises.realpath(normalizedPath);
  if (isRendererSensitivePath(resolvedPath)) {
    throw privateRendererPathError();
  }
  if (textOnly && !isAllowedTextEditExt(resolvedPath)) {
    throw new Error('Only .md and .txt documents can be edited from the canvas.');
  }

  const targetStat = await fs.promises.lstat(resolvedPath);
  if (textOnly && (!targetStat.isFile() || targetStat.isSymbolicLink())) {
    throw new Error('Only regular text files can be edited from the canvas.');
  }
  if (textOnly && rejectHardlinks
      && typeof targetStat.nlink === 'number' && targetStat.nlink > 1) {
    throw textFileHardlinkUnsupportedError();
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

function isUnsupportedDirectorySyncError(error, platform = process.platform) {
  return UNSUPPORTED_DIRECTORY_SYNC_CODES.has(error?.code)
    || (platform === 'win32' && error?.code === 'EPERM');
}

async function syncOpenedDirectoryHandle(directoryHandle, { platform = process.platform } = {}) {
  try {
    await directoryHandle.sync();
    return true;
  } catch (error) {
    if (isUnsupportedDirectorySyncError(error, platform)) return false;
    throw error;
  }
}

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

async function assertMutableTextTargetIdentity(target, { rejectHardlinks = false } = {}) {
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
  if (rejectHardlinks && typeof targetStat.nlink === 'number' && targetStat.nlink > 1) {
    throw textFileHardlinkUnsupportedError();
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
    return await syncOpenedDirectoryHandle(directoryHandle, { platform });
  } catch (error) {
    if (isUnsupportedDirectorySyncError(error, platform)) return false;
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
export async function readValidatedTextFile(filePath, {
  sender = null,
  // Only the renderer-facing IPC sets this. Main-process preview callers keep
  // the historic read-only hard-link behavior; they are not a renderer path
  // capability and cannot expose their result over this IPC.
  rejectHardlinks = false,
} = {}) {
  const target = await inspectMutablePath(filePath, { sender, textOnly: true, rejectHardlinks });
  // Sweep only this opened document directory, asynchronously and with the
  // stale-age guard below, so text temp recovery never delays a read or
  // touches a live writer's private temp.
  void cleanupTempFiles(target.parentPath).catch((error) => {
    logger.warn(`[FileSystem] Text temp cleanup failed for ${target.parentPath}:`, error);
  });
  let content;
  if (!rejectHardlinks) {
    // Preserve the legacy main-process-only preview semantics. Renderer IPC
    // takes the stricter handle-pinned branch below.
    content = await withTextTargetMutationConflict(
      () => fs.promises.readFile(target.resolvedPath, 'utf8'),
    );
    await assertMutableTextTargetIdentity(target, { rejectHardlinks });
  } else {
    // Pin the renderer editor baseline to one opened regular-file handle. A
    // path-based read could be redirected by a final/parent replacement
    // between inspection and `readFile`; the post-read check alone cannot
    // prove which inode supplied bytes. The no-follow fallback keeps this
    // generic IPC from becoming a hard-link/private-store disclosure route on
    // platforms without O_NOFOLLOW support.
    let handle = null;
    try {
      handle = await withTextTargetMutationConflict(
        () => openNoFollowWorkspaceHandle(target.resolvedPath, fs.constants.O_RDONLY),
      );
      const before = await withTextTargetMutationConflict(() => handle.stat());
      if (!before.isFile() || !hasSameIdentity(before, target.targetIdentity)) {
        throw textFileConflictError();
      }
      if (typeof before.nlink === 'number' && before.nlink > 1) {
        throw textFileHardlinkUnsupportedError();
      }
      await assertMutableTextTargetIdentity(target, { rejectHardlinks: true });
      content = await withTextTargetMutationConflict(
        () => handle.readFile({ encoding: 'utf8' }),
      );
      const after = await withTextTargetMutationConflict(() => handle.stat());
      if (!hasSameIdentity(after, before)
          || after.size !== before.size
          || after.mtimeMs !== before.mtimeMs
          || after.ctimeMs !== before.ctimeMs) {
        throw textFileConflictError();
      }
      // Do not hand the renderer a baseline from a target that was replaced
      // while it was being read. The resulting conflict/read error is safer
      // than a misleading expected-content value for a different inode.
      await assertMutableTextTargetIdentity(target, { rejectHardlinks: true });
    } finally {
      await handle?.close();
    }
  }
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
    await assertMutableTextTargetIdentity(target, { rejectHardlinks });
    let remainedDirect = false;
    try {
      remainedDirect = !await pathContainsSymlinkComponent(target.normalizedPath);
    } catch {
      // Sharing is an optimization; ambiguity must preserve independent sessions.
    }
    if (remainedDirect) {
      await assertMutableTextTargetIdentity(target, { rejectHardlinks });
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
  // Renderer IPC opts into an early hard-link refusal so its public spelling
  // cannot act as an alias for an app-private inode. Internal direct callers
  // retain the historic read-only/idempotent hard-link behavior.
  rejectHardlinks = false,
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
      initialTarget = await inspectMutablePath(filePath, { sender, textOnly: true, rejectHardlinks });
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
        () => inspectMutablePath(filePath, { sender, textOnly: true, rejectHardlinks }),
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
      await assertMutableTextTargetIdentity(target, { rejectHardlinks });

      // Read only after the path and identity are established inside the lock.
      // A repeated write of the already-requested content is idempotent; every
      // other mismatch is a genuine stale-baseline conflict.
      const currentContent = await withTextTargetMutationConflict(
        () => fs.promises.readFile(target.resolvedPath, 'utf8'),
      );
      await assertMutableTextTargetIdentity(target, { rejectHardlinks });
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
  if (!oldPath || sameRecoveryRebindPath(oldPath, newPath)) return { success: true };
  const canonicalOldPath = normalizeRecoveryRebindPath(oldPath);
  const canonicalNewPath = normalizeRecoveryRebindPath(newPath);
  return withCanvasRecoveryRebind(canonicalOldPath, canonicalNewPath, async ({ oldPath: oldOwner, newPath: newOwner, installAlias }) => {
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
  const target = await inspectRendererWorkspacePath(targetPath, { allowMissing: true });
  const directory = target.parentPath;
  let entries;
  try { entries = await fs.promises.readdir(directory); } catch { return { reconciled: false }; }
  // Do not parse even a journal filename list obtained after a substituted
  // canvas parent. The handle-bound journal reads below protect payloads; this
  // repeated directory identity proof keeps the discovery step fail-closed too.
  await assertRendererWorkspacePathUnchanged(target);
  const journals = entries.filter(name => name.startsWith('.ic-recovery-rebind-') && name.endsWith('.json'));
  for (const name of journals) {
    const journalPath = path.join(directory, name);
    const journal = await readRecoveryRebindJournal(journalPath);
    if (!journal || (!sameRecoveryRebindPath(journal.newCanvasPath, targetPath)
      && !sameRecoveryRebindPath(journal.oldCanvasPath, targetPath))) continue;
    // A journal is durable but not an authority to cross into a renderer-
    // forbidden private store. Check both sides before its recovery migration
    // or its target bytes are touched.
    await assertRendererFilesystemPathAllowed(journal.oldCanvasPath, { allowMissing: true });
    await assertRendererFilesystemPathAllowed(journal.newCanvasPath, { allowMissing: true });
    const targetBytes = await readRendererWorkspaceBytesIfPresent(journal.newCanvasPath);
    const targetDigest = targetBytes
      ? createHash('sha256').update(targetBytes).digest('hex')
      : null;
    if (targetDigest !== journal.canvasDigest) {
      const target = await inspectRendererWorkspacePath(journal.newCanvasPath, { allowMissing: true });
      const finderRenameAttested = journal.phase === 'prepared'
        && journal.renameAttestation
        && target.exists
        && target.targetIdentity?.dev === journal.renameAttestation.dev
        && target.targetIdentity?.ino === journal.renameAttestation.ino;
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
  normalizeRecoveryRebindPath,
  sameRecoveryRebindPath,
  recoveryRebindJournalPath,
  recoveryRebindJournalPaths,
  writeRecoveryRebindJournal,
  readRecoveryRebindJournal,
  reconcileRecoveryRebindJournalForCanvas,
  removeRendererWorkspaceFileIfPresent,
};

/**
 * Record the canvas file's identity (inode + device) on the renderer's
 * WebContents after a load or save. A rename preserves the inode, so this is the
 * fingerprint we use later to recognise the same file under a new name. Must be
 * called *after* any write. Workspace writes are handle-pinned in place so the
 * inode normally remains stable; a host/editor replacement can still change it.
 * Best-effort; ino==0 filesystems opt out.
 */
async function rememberCanvasInode(sender, filePath) {
  try {
    // Do not let the post-save/load bookkeeping reopen an untrusted pathname
    // with statSync. It must use the same guarded public identity as the
    // payload operation that just completed.
    const target = await inspectRendererWorkspacePath(filePath);
    if (sender && !sender.isDestroyed?.() && target.targetIdentity?.ino) {
      sender.__canvasInode = { ino: target.targetIdentity.ino, dev: target.targetIdentity.dev };
      sender.__canvasPath = target.canonicalPath;
      await ensureCanvasWatcher(sender, target.canonicalPath);
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
  if (!sender.__canvasPath || !sameRecoveryRebindPath(sender.__canvasPath, knownPath)) {
    return knownPath; // saving somewhere other than "the canvas" — honor it verbatim
  }
  try {
    const knownTarget = await inspectRendererWorkspacePath(knownPath, { allowMissing: true });
    if (knownTarget.exists
        && knownTarget.targetIdentity?.ino === tracked.ino
        && knownTarget.targetIdentity?.dev === tracked.dev) {
      return knownTarget.canonicalPath;
    }

    const entries = await fs.promises.readdir(knownTarget.parentPath);
    // The directory listing itself must not turn a formerly public canvas
    // parent into a private-store discovery oracle after a parent swap.
    await assertRendererWorkspacePathUnchanged(knownTarget);
    for (const name of entries) {
      const candidate = path.join(knownTarget.parentPath, name);
      try {
        const candidateTarget = await inspectRendererWorkspacePath(candidate, { allowMissing: true });
        if (candidateTarget.exists
            && candidateTarget.targetIdentity?.ino === tracked.ino
            && candidateTarget.targetIdentity?.dev === tracked.dev) {
          logger.info(`[FileSystem] Canvas renamed on disk: ${knownPath} → ${candidateTarget.canonicalPath} (followed by inode)`);
          return candidateTarget.canonicalPath;
        }
      } catch { /* unreadable/replaced/private entry — skip */ }
    }
  } catch {
    // A path replacement leaves the caller's original spelling in place. The
    // save/load operation that invoked us performs its own adjacent guard and
    // will fail closed instead of adopting an unverified candidate.
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

async function ensureCanvasWatcher(sender, filePath) {
  let target;
  try {
    target = await inspectRendererWorkspacePath(filePath, { allowMissing: true });
  } catch {
    return;
  }
  const dir = target.parentPath;
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
  let renamedWorkspace;
  try {
    // A watcher notification can race a parent substitution just like an IPC
    // load. Bind the bytes and identity before using this rename candidate to
    // migrate any recovery ownership.
    renamedWorkspace = await readRendererWorkspaceFile(resolved, { encoding: null });
  } catch {
    if (!sender.isDestroyed()) sender.send('canvas:file-rename-recovery-failed');
    return;
  }
  const renamedStat = renamedWorkspace.stat;
  const renamedBytes = renamedWorkspace.content;
  if (!renamedBytes) {
    if (!sender.isDestroyed()) sender.send('canvas:file-rename-recovery-failed');
    return;
  }
  const digest = createHash('sha256').update(renamedBytes).digest('hex');
  const journalPaths = recoveryRebindJournalPaths(knownPath, resolved);
  try {
    await Promise.all(journalPaths.map(journalPath => writeRecoveryRebindJournal(journalPath, {
      version: RECOVERY_REBIND_JOURNAL_VERSION,
      oldCanvasPath: normalizeRecoveryRebindPath(knownPath),
      newCanvasPath: normalizeRecoveryRebindPath(resolved),
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
  await rememberCanvasInode(sender, resolved); // re-fingerprint at the new name (same dir → watcher unchanged)
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
  // The renderer's generic filesystem endpoints have no legitimate reason to
  // inspect Electron's own profile. Remember both userData spellings before
  // installing any handler so new/private host components are protected even
  // when their names are not part of the portable component blocklist.
  try { registerRendererPrivateAppRoot(app?.getPath?.('userData')); } catch { /* app not ready: component guards remain active */ }

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
    // A canvas can contain arbitrary file paths and this IPC also accepts a
    // direct renderer target. Reject either half of a pending rename before
    // journal reconciliation, sidecar migration, or any write is attempted.
    if (targetPath) await assertRendererFilesystemPathAllowed(targetPath, { allowMissing: true });
    if (priorCanvasPath) await assertRendererFilesystemPathAllowed(priorCanvasPath, { allowMissing: true });
    if (!targetPath) {
      if (isBackgroundE2E()) return { canceled: true };
      const { canceled, filePath: dialogPath } = await dialog.showSaveDialog({
        title: 'Save Canvas',
        defaultPath: 'canvas.json',
        filters: [{ name: 'JSON Files', extensions: ['json'] }],
      });
      if (canceled || !dialogPath) return { canceled: true };
      targetPath = dialogPath;
      await assertRendererFilesystemPathAllowed(targetPath, { allowMissing: true });
    } else {
      // Follow a Finder rename so autosave writes to the renamed file instead of
      // resurrecting the old name. The renderer adopts the returned filePath, so
      // currentFile — and every job sidecar derived from it — self-corrects.
      targetPath = await reconcileRenamedCanvas(event.sender, targetPath);
    }
    // A Finder rename or dialog result is a fresh untrusted path boundary.
    // Keep this ahead of the first mutation below (including sidecar cleanup).
    await assertRendererFilesystemPathAllowed(targetPath, { allowMissing: true });

    // The renderer-side sanitizer already preserves actionable paused state
    // directly on the nodes we keep. Re-embedding job progress into a top-level
    // transientProgress blob caused it to be written back on every save, which
    // then replayed on every reload. Keep load-time migration for legacy files,
    // but stop generating fresh embedded progress on save.
    delete data.transientProgress;
    annotatePortableFilePaths(data, targetPath);
    const serializedCanvas = JSON.stringify(data);

    // Delete legacy separate sidecar progress file if present. Bind this
    // sibling deletion just like the canvas write: a path swap after the
    // renderer guard must not turn a harmless cleanup into a private-store
    // mutation.
    try {
      const sidecarPath = getSidecarPath(targetPath);
      if (await removeRendererWorkspaceFileIfPresent(sidecarPath)) {
        logger.info(`[FileSystem] Cleaned up legacy separate progress sidecar: ${sidecarPath}`);
      }
    } catch { /* ignore */ }

    const needsRecoveryRebind = !!priorCanvasPath
      && !sameRecoveryRebindPath(priorCanvasPath, targetPath);
    const journalPaths = needsRecoveryRebind
      ? recoveryRebindJournalPaths(priorCanvasPath, targetPath)
      : null;
    const priorTargetBytes = journalPaths
      ? await readRendererWorkspaceBytesIfPresent(targetPath)
      : null;
    const previousTargetDigest = priorTargetBytes
      ? createHash('sha256').update(priorTargetBytes).digest('hex')
      : null;
    const [oldTarget, newTarget] = journalPaths
      ? await Promise.all([
        inspectRendererWorkspacePath(priorCanvasPath, { allowMissing: true }),
        inspectRendererWorkspacePath(targetPath, { allowMissing: true }),
      ])
      : [null, null];
    const trackedInode = event.sender.__canvasInode;
    const renameAttestation = journalPaths
      && !oldTarget?.exists
      && newTarget?.exists
      && trackedInode?.ino === newTarget.targetIdentity?.ino
      && trackedInode?.dev === newTarget.targetIdentity?.dev
      ? { dev: newTarget.targetIdentity.dev, ino: newTarget.targetIdentity.ino }
      : null;
    if (journalPaths) {
      await Promise.all(journalPaths.map(journalPath => writeRecoveryRebindJournal(journalPath, {
        version: RECOVERY_REBIND_JOURNAL_VERSION,
        oldCanvasPath: normalizeRecoveryRebindPath(priorCanvasPath),
        newCanvasPath: normalizeRecoveryRebindPath(targetPath),
        phase: 'prepared',
        canvasDigest: createHash('sha256').update(serializedCanvas).digest('hex'),
        previousTargetDigest,
        ...(renameAttestation ? { renameAttestation } : {}),
      })));
    }

    // The handle-pinned writer records its complete payload in a host-private
    // write-ahead journal before truncating the canvas. A crash after this
    // point is recovered by finishing that exact payload on next save/load;
    // the prepared rebind journal then completes ownership migration.
    const workspaceWrite = await atomicWriteRendererWorkspaceFile(targetPath, serializedCanvas, {
      returnMetadata: true,
    });
    if (journalPaths) {
      await Promise.all(journalPaths.map(journalPath => writeRecoveryRebindJournal(journalPath, {
        version: RECOVERY_REBIND_JOURNAL_VERSION,
        oldCanvasPath: normalizeRecoveryRebindPath(priorCanvasPath),
        newCanvasPath: normalizeRecoveryRebindPath(targetPath),
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

    // Re-fingerprint after the durable handle write so a later Finder rename is
    // still recognised before the next save.
    await rememberCanvasInode(event.sender, targetPath);

    // Workspace persistence no longer creates a same-directory temporary
    // entry. Deliberately do not sweep a renderer-selected parent by pathname:
    // Node has no descriptor-relative unlink for that legacy cleanup path.
    // Validated text-document flows retain their own bounded temp cleanup.

    return {
      filePath: workspaceWrite.filePath,
      // A deliberately narrow, typed status: successful bytes were fsynced to
      // the bound public handle, while Windows may be unable to confirm the
      // WAL directory metadata reached stable storage. Do not infer a fully
      // crash-atomic namespace publication from the latter state.
      workspaceRecoveryStatus: workspaceWrite.recoveryStatus,
    };
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

    // Do this before looking for recovery journals: those journals can cause
    // recovery-owner migration and must never be consulted for a private
    // Interview authority record.
    await assertRendererFilesystemPathAllowed(targetPath, { allowMissing: true });

    const journalRecovery = await reconcileRecoveryRebindJournalForCanvas(targetPath);
    if (journalRecovery.pending) {
      throw new Error('Recovery ownership migration is still pending for this canvas. Retry opening it after resolving the filesystem error.');
    }
    // A last-opened old spelling can be gone after a Finder rename. Successful
    // journal reconciliation proves the exact new canvas digest/attestation,
    // so adopt only that recorded target before any existence/read/fingerprint
    // check. This never follows an arbitrary directory JSON.
    if (journalRecovery.adoptedCanvasPath) targetPath = journalRecovery.adoptedCanvasPath;
    await assertRendererFilesystemPathAllowed(targetPath);

    // Read from a no-follow descriptor bound to the checked regular-file inode
    // rather than resolving the renderer path and later reopening it by name.
    // This closes the guard→read path-swap window into app-private stores.
    const MAX_WORKSPACE_BYTES = 100 * 1024 * 1024; // 100MB
    let workspace;
    try {
      workspace = await readRendererWorkspaceFile(targetPath, { maxBytes: MAX_WORKSPACE_BYTES });
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error('File does not exist');
      throw error;
    }
    const { stat: stats, content } = workspace;
    if (stats.size === 0) throw new Error('Workspace file is empty (0 bytes)');
    // Static safety bound (not adaptive): a workspace JSON larger than this would
    // OOM the V8 string parser on read. Fixed by design.
    if (workspace.tooLarge) throw new Error(`Workspace file is excessively large (${(stats.size/1024/1024).toFixed(2)}MB). Limit is 100MB.`);
    try {
      const data = JSON.parse(content);
      await resolvePortableFilePaths(data, targetPath);
      logger.info(`[FileSystem] Loaded workspace: ${targetPath} (${stats.size} bytes)`);

      // Clean up legacy separate progress sidecar file if it exists
      try {
        const sidecarPath = getSidecarPath(targetPath);
        const sidecarTarget = await inspectRendererWorkspacePath(sidecarPath, { allowMissing: true });
        if (sidecarTarget.exists) {
          try {
            const { content: sidecarContent } = await readRendererWorkspaceFile(sidecarTarget);
            const sidecarData = JSON.parse(sidecarContent);
            mergeSidecarData(data.nodes || [], sidecarData);
            logger.info(`[FileSystem] Migrated and merged legacy progress sidecar data from ${sidecarPath}`);
          } catch (err) {
            logger.error(`[FileSystem] Failed to parse legacy sidecar data: ${sidecarPath}`, err);
          }
          if (await removeRendererWorkspaceFileIfPresent(sidecarPath)) {
            logger.info(`[FileSystem] Deleted legacy progress sidecar file: ${sidecarPath}`);
          }
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
          
          await atomicWriteRendererWorkspaceFile(targetPath, JSON.stringify(cleanData));
          logger.info(`[FileSystem] Immediately deleted saved transient progress from disk file: ${targetPath}`);
        } catch (err) {
          logger.error(`[FileSystem] Failed to write clean canvas to disk after loading: ${targetPath}`, err);
        }
      }
      
      // See the matching save-path note: workspace writes use a host-private
      // journal, so a broad untrusted-parent temp cleanup is neither needed
      // nor an authority we retain after loading a renderer-selected canvas.

      // Fingerprint the file we just loaded so the next save can tell if it was
      // renamed underneath us. Done last because transient-progress recovery
      // may have completed a handle-pinned write before we expose the canvas.
      await rememberCanvasInode(event.sender, targetPath);

      return { data, filePath: targetPath };
    } catch (jsonErr) {
      logger.error(`[FileSystem] Failed to parse workspace JSON at ${targetPath}:`, jsonErr);
      throw new Error('Invalid workspace file format. File may be corrupted or malformed.');
    }
  });

  handleSafe('start-file-watch', async (event, filePath) => {
    // A watcher does not return bytes itself, but a private inode observed
    // through a public hard-link alias could become a timing oracle for
    // another renderer route. Its resolved target must remain single-link and
    // public; the registry repeats this capability check on every event.
    await inspectRendererWatchPath(filePath, { allowMissing: true });
    // Keep the renderer's normalized spelling as the subscription key so its
    // paired stop IPC releases the exact reservation even when realpath
    // canonicalizes case on a macOS/Windows volume.  The registry's validator
    // repeats the capability inspection before every notification.
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
      // Do this inside the target validator so neither the duplicate-path
      // inspector nor shell.trashItem gets to probe a userData ancestor.
      validate: async (candidatePath, { sender }) => {
        const validatedPath = await validateMutablePath(candidatePath, { sender });
        await assertRendererDeletePathDoesNotContainPrivateRoots(validatedPath);
        return validatedPath;
      },
    });
    // `shell.trashItem` accepts only a pathname, not an anchored handle. Keep
    // its last guard immediately adjacent to the host-only OS call; the same
    // renderer capability boundary documented for derived workspace deletes
    // applies here as well.
    await assertRendererFilesystemPathAllowed(safePath);
    await shell.trashItem(safePath);
  });

  handleSafe('read-text-file', async (event, filePath) => (
    readValidatedTextFile(filePath, { sender: event.sender, rejectHardlinks: true })
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
      rejectHardlinks: true,
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
