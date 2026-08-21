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

function pathsReferToSameCanonicalSpelling(left, right) {
  const normalize = value => {
    const resolved = path.resolve(value).normalize('NFC');
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

/** True when `filePath` exists and is a regular file. */
export function isExistingFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
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
  '/etc/', '/var/', '/proc/', '/sys/', '/dev/',
  '/.ssh/', '/.aws/', '/.config/', '/.env',
  '/.netrc', '/.npmrc', '/.docker/', '/.bash_history', '/.zsh_history',
  '/.gnupg/', '/keychains/', '/library/keychains/',
  'ntuser.dat', 'system32', 'windows/debug',
];

// These collection roots are dangerous mutation targets themselves, but their
// descendants are legitimate user storage (shared attachments and mounted
// external drives). Credential patterns above still apply within them.
const SENSITIVE_EXACT_PATHS = new Set(['/users/shared', '/volumes']);

/** True when `resolvedPath` matches a sensitive system/config/credential pattern. */
export function isSensitivePath(resolvedPath) {
  if (!resolvedPath) return false;
  const rawPath = String(resolvedPath);
  // Pad both ends with a separator so directory patterns also match the exact
  // directory itself (`/Users/x/.ssh`, `/etc`, `C:\Users\x\.aws`), not only a
  // child path with a trailing slash after the sensitive component.
  const normalizedPath = rawPath.replace(/[\\/]+/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
  const verificationPath = `/${normalizedPath}/`;
  const exactPath = `/${normalizedPath}`;
  const isUnixRoot = /^\/+$/u.test(rawPath);
  const isWindowsRoot = /^[a-zA-Z]:[\\/]?$/u.test(rawPath);
  if (isUnixRoot || isWindowsRoot) return true;
  if (SENSITIVE_EXACT_PATHS.has(exactPath)) return true;
  return SENSITIVE_PATH_PATTERNS.some(p => verificationPath.includes(p));
}
