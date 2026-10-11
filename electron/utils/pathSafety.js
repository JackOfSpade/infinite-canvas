/**
 * Filesystem path helpers shared across main-process modules.
 *
 * `isWithinDirectory` is a path-traversal containment check used to keep
 * portable-image relinking and missing-preview recovery from climbing out of an
 * intended root via `..` segments or absolute escapes. Keeping a single
 * implementation avoids the two former copies drifting (one had lost its
 * null-guard).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * True when `candidatePath` resolves to `rootDir` itself or a descendant of it.
 * Rejects `..` escapes and absolute paths that land outside the root.
 */
export function isWithinDirectory(rootDir, candidatePath) {
  if (!rootDir || !candidatePath) return false;
  const relative = path.relative(path.resolve(rootDir), path.resolve(candidatePath));
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// These are macOS-owned root aliases, not a general `/private` equivalence.
// `lstat` still rejects every symlink component below these prefixes; this
// normalization only accounts for the spelling that macOS `realpath` returns.
const MACOS_SYSTEM_PATH_ALIASES = [
  ['/etc', '/private/etc'],
  ['/tmp', '/private/tmp'],
  ['/var', '/private/var'],
];

function normalizeMacOSSystemPathAlias(value) {
  if (process.platform !== 'darwin') return value;
  const lowerCaseValue = value.toLowerCase();
  for (const [lexicalPrefix, canonicalPrefix] of MACOS_SYSTEM_PATH_ALIASES) {
    if (lowerCaseValue === lexicalPrefix || lowerCaseValue.startsWith(`${lexicalPrefix}/`)) {
      return `${canonicalPrefix}${value.slice(lexicalPrefix.length)}`;
    }
  }
  return value;
}

function pathsReferToSameCanonicalSpelling(left, right) {
  const normalize = value => {
    const resolved = normalizeMacOSSystemPathAlias(path.resolve(value).normalize('NFC'));
    return process.platform === 'win32' || process.platform === 'darwin'
      ? resolved.toLowerCase()
      : resolved;
  };
  return normalize(left) === normalize(right);
}

/**
 * Create a directory below an already-existing canonical root without ever
 * traversing a pre-existing symbolic-link component.
 *
 * `mkdir({ recursive: true })` performs its traversal before a caller can
 * inspect the result. If `Applied Jobs/Company` (or `.local-ai/jobs`) is a
 * symlink, that seemingly contained mkdir can therefore create directories
 * outside the intended root before a later `realpath` check rejects it. Walk
 * one component at a time instead, validating each parent before continuing.
 *
 * This protects against links that exist when the operation begins. Portable
 * Node filesystem APIs cannot make a whole multi-component traversal atomic
 * against another same-user process replacing a parent between syscalls.
 */
export async function ensureDirectoryWithinRoot(rootDir, targetDir, { mode = 0o700, label = 'Directory' } = {}) {
  const root = path.resolve(String(rootDir || ''));
  const target = path.resolve(String(targetDir || ''));
  if (!rootDir || !targetDir || !isWithinDirectory(root, target)) {
    throw new Error(`${label} escaped its trusted root.`);
  }

  const rootStat = await fs.promises.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`${label} root must be a regular directory.`);
  }
  const realRoot = await fs.promises.realpath(root);
  if (!pathsReferToSameCanonicalSpelling(root, realRoot)) {
    throw new Error(`${label} root must not traverse a symbolic link.`);
  }

  const relative = path.relative(root, target);
  if (!relative) return realRoot;

  let current = root;
  for (const part of relative.split(path.sep)) {
    if (!part || part === '.' || part === '..') {
      throw new Error(`${label} contains an unsafe path component.`);
    }
    current = path.join(current, part);
    let stat;
    try {
      stat = await fs.promises.lstat(current);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      try {
        await fs.promises.mkdir(current, { mode });
      } catch (mkdirError) {
        // Another benign creator can win this exact component. Re-inspect it
        // below; a link or non-directory winner is still rejected.
        if (mkdirError?.code !== 'EEXIST') throw mkdirError;
      }
      stat = await fs.promises.lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${label} must not traverse a symbolic link or non-directory component.`);
    }
    const realCurrent = await fs.promises.realpath(current);
    if (!pathsReferToSameCanonicalSpelling(current, realCurrent)
      || !isWithinDirectory(realRoot, realCurrent)) {
      throw new Error(`${label} resolved outside its trusted root.`);
    }
  }
  return current;
}

// Write JSON to `targetPath` via a same-directory temp file + rename so a
// reader never observes a partially-written file, and best-effort clean up
// the temp file whether the rename succeeded or not. This exact shape (temp
// write, rename, finally-unlink) used to be reimplemented independently at
// several call sites with drifting details (mode, formatting, temp-name
// entropy); options below let each caller keep its own prior behavior.
export async function atomicWriteJson(targetPath, data, { mode = 0o600, pretty = true, ensureDir = false } = {}) {
  if (ensureDir) {
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  }
  const temp = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${crypto.randomUUID()}.tmp`);
  const serialized = pretty ? `${JSON.stringify(data, null, 2)}\n` : JSON.stringify(data);
  try {
    await fs.promises.writeFile(temp, serialized, { encoding: 'utf8', mode });
    await fs.promises.rename(temp, targetPath);
  } finally {
    await fs.promises.unlink(temp).catch(() => {});
  }
}

/** True when `filePath` exists and is a regular file. */
export function isExistingFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** Async twin of `isExistingFile` — true when `filePath` exists and is a regular file. */
export async function isExistingFileAsync(filePath) {
  try {
    return (await fs.promises.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

// Sensitive system/config roots and credential-store files. A canvas is a
// portable, loadable JSON document (File ▸ Open Canvas, or a shared canvas
// file) whose document/image nodes carry arbitrary `filePath` strings — an
// untrusted or malicious canvas can claim any path on disk belongs to a node.
// This is a blocklist, not an allowlist (a legitimate attachment added via
// the native file picker or an OS drag-drop can genuinely live anywhere on
// the user's disk, so a strict "must be under the canvas directory" allowlist
// would break normal use) — it can't be exhaustive, but it covers the
// highest-value credential/config targets an attacker would go for.
const SENSITIVE_PATH_PATTERNS = [
  '/.ssh/', '/.aws/', '/.config/',
  '/.netrc', '/.npmrc', '/.docker/', '/.bash_history', '/.zsh_history',
  '/.gnupg/', '/keychains/', '/library/keychains/',
  'ntuser.dat', 'system32', 'windows/debug',
];

// Unix system roots are sensitive only at the start of a path: `/etc/passwd`
// is a system file, `~/Documents/etc/receipt.pdf` and `~/dev/shot.png` are
// ordinary attachments a substring match used to reject.
const SENSITIVE_ROOT_PATTERNS = ['/etc/', '/var/', '/proc/', '/sys/', '/dev/'];

// Callers pass realpath output, and macOS firmlinks resolve /etc → /private/etc
// and /var → /private/var, so the anchor tolerates a leading `/private`. The
// optional drive segment keeps `C:\var` anchored too.
const SENSITIVE_ROOT_PREFIX_RE = /^(?:\/[a-z]:)?(?:\/private(?=\/))?/u;

// `.env`/`.env.local` are credential stores; `.environment-shots/` is not, so
// match the whole path component rather than a bare prefix.
const SENSITIVE_DOTENV_PATTERNS = ['/.env/', '/.env.'];

// These collection roots are dangerous mutation targets themselves, but their
// descendants are legitimate user storage (shared attachments and mounted
// external drives). Credential patterns above still apply within them.
const SENSITIVE_EXACT_PATHS = new Set(['/users/shared', '/volumes']);

// Interview Helper keeps verified application material and main-process-issued
// prepared briefs under these app-private directory components. The workspace
// writer also keeps its crash-recovery payloads in a host-only store. A
// renderer can otherwise name an arbitrary path through generic canvas file
// IPC, so treating each *component* (rather than one installation-specific
// absolute path) as sensitive keeps those authority records private across
// user-data roots and test installations. `verificationPath` below is padded
// with separators, which deliberately matches the directory itself and
// descendants but not an ordinary filename such as
// `my-interview-helper-artifacts.json`.
const SENSITIVE_APP_PRIVATE_STORE_COMPONENTS = [
  'interview-helper-artifacts',
  'interview-helper-prepared-briefs',
  // Host-owned career inputs/snapshots contain the same source material that
  // Interview Helper consumes. They must not become renderer-readable merely
  // because a canvas supplies a userData-looking absolute pathname.
  'career-input-staging',
  'career-snapshot-store',
  'renderer-workspace-write-journal',
  // Pathname-only image decoders receive copies only in this host workspace;
  // renderer filesystem IPC must not enumerate or reuse those transient bytes.
  'local-file-protocol-transcodes',
];

// Component names protect portable test stores and known private namespaces.
// The actual Electron userData root is installation-specific, though, and can
// also hold browser profiles, encrypted settings, or a newly-added host store
// whose component name is not in the list above. Register it at main-process
// boot so renderer-facing generic file routes deny the entire host namespace,
// while trusted host modules continue to use isSensitivePath/system policy as
// appropriate for their own storage maintenance.
const RENDERER_PRIVATE_APP_ROOTS = new Set();

function normalizeRendererPrivatePath(value) {
  let normalized = normalizeMacOSSystemPathAlias(path.resolve(String(value || '')).normalize('NFC'));
  // Full Unicode case folding: APFS/NTFS resolve 'ſ' (U+017F) as 's', which
  // toLowerCase() leaves unchanged, so a lowercase-only fold could be bypassed.
  if (process.platform === 'win32' || process.platform === 'darwin') normalized = normalized.toUpperCase().toLowerCase();
  return normalized;
}

function isWithinRendererPrivateRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * Register the app-owned userData root as a renderer-denied namespace.
 * Both its lexical and currently canonical spellings are remembered so a
 * public-looking symlink cannot make a generic renderer path enumerate the
 * app profile. This is intentionally process-local state set by main code,
 * not a global filesystem allow/deny heuristic for ordinary user folders.
 */
export function registerRendererPrivateAppRoot(rootPath) {
  if (typeof rootPath !== 'string' || !rootPath.trim() || !path.isAbsolute(rootPath)) return;
  const lexical = path.resolve(rootPath).normalize('NFC');
  RENDERER_PRIVATE_APP_ROOTS.add(normalizeRendererPrivatePath(lexical));
  try {
    RENDERER_PRIVATE_APP_ROOTS.add(normalizeRendererPrivatePath(fs.realpathSync.native(lexical)));
  } catch {
    // First run can legitimately precede creation of userData. The lexical
    // root still blocks renderer-created descendants; later registration can
    // add the canonical spelling once Electron has created it.
  }
}

// One definition of "this path names an app-private store directory" for both
// isSensitivePath and isRendererPrivateAppPath, with the same full case fold.
function matchesAppPrivateStoreComponent(rawPath) {
  const normalizedPath = String(rawPath).replace(/[\\/]+/g, '/').replace(/^\/+|\/+$/g, '').toUpperCase().toLowerCase();
  const verificationPath = `/${normalizedPath}/`;
  return SENSITIVE_APP_PRIVATE_STORE_COMPONENTS.some(component => verificationPath.includes(`/${component}/`));
}

/**
 * True when `resolvedPath` is inside the app's own private data: a known
 * private store directory, or the registered userData root. Unlike
 * isRendererSensitivePath this does NOT apply the system/credential policy,
 * so an ordinary temp or user folder is not refused. For flows that accept a
 * renderer-named location but only need to keep it out of app-private data.
 */
export function isRendererPrivateAppPath(resolvedPath) {
  if (!resolvedPath) return false;
  if (matchesAppPrivateStoreComponent(resolvedPath)) return true;
  const candidate = normalizeRendererPrivatePath(resolvedPath);
  return [...RENDERER_PRIVATE_APP_ROOTS].some(root => isWithinRendererPrivateRoot(root, candidate));
}

/**
 * True when `resolvedPath` matches a sensitive system/config/credential path
 * and, by default, one of the renderer-denied app-private stores above.
 * Host-owned flows that are creating/maintaining one of those stores should
 * use isSystemSensitivePath instead of accidentally treating their own
 * private root as an untrusted attachment path.
 */
export function isSensitivePath(resolvedPath, { includeAppPrivate = true } = {}) {
  if (!resolvedPath) return false;
  const rawPath = String(resolvedPath);
  // Pad both ends with a separator so directory patterns also match the exact
  // directory itself (`/Users/x/.ssh`, `/etc`, `C:\Users\x\.aws`), not only a
  // child path with a trailing slash after the sensitive component.
  // Fold through upper case so spellings a case-insensitive volume resolves
  // identically (for example U+017F for 's') cannot evade the component checks.
  const normalizedPath = rawPath.replace(/[\\/]+/g, '/').replace(/^\/+|\/+$/g, '').toUpperCase().toLowerCase();
  const verificationPath = `/${normalizedPath}/`;
  const exactPath = `/${normalizedPath}`;
  const isUnixRoot = /^\/+$/u.test(rawPath);
  const isWindowsRoot = /^[a-zA-Z]:[\\/]?$/u.test(rawPath);
  if (isUnixRoot || isWindowsRoot) return true;
  if (SENSITIVE_EXACT_PATHS.has(exactPath)) return true;
  const rootAnchoredPath = verificationPath.replace(SENSITIVE_ROOT_PREFIX_RE, '');
  if (SENSITIVE_ROOT_PATTERNS.some(p => rootAnchoredPath.startsWith(p))) return true;
  if (SENSITIVE_DOTENV_PATTERNS.some(p => verificationPath.includes(p))) return true;
  if (includeAppPrivate && matchesAppPrivateStoreComponent(rawPath)) return true;
  return SENSITIVE_PATH_PATTERNS.some(p => verificationPath.includes(p));
}

/** System/config/credential policy only; for trusted host maintenance flows. */
export function isSystemSensitivePath(resolvedPath) {
  return isSensitivePath(resolvedPath, { includeAppPrivate: false });
}

/** Renderer policy: generic filesystem IPC must never enter app userData. */
export function isRendererSensitivePath(resolvedPath) {
  if (isSensitivePath(resolvedPath)) return true;
  if (!resolvedPath) return false;
  const candidate = normalizeRendererPrivatePath(resolvedPath);
  return [...RENDERER_PRIVATE_APP_ROOTS].some(root => isWithinRendererPrivateRoot(root, candidate));
}
