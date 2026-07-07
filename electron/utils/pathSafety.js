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
  '/users/shared/', '/volumes/',
];

/** True when `resolvedPath` matches a sensitive system/config/credential pattern. */
export function isSensitivePath(resolvedPath) {
  if (!resolvedPath) return false;
  const verificationPath = String(resolvedPath).split(path.sep).join('/').toLowerCase();
  const isUnixRoot = resolvedPath === '/';
  const isWindowsRoot = /^[a-zA-Z]:\\?$/.test(resolvedPath);
  if (isUnixRoot || isWindowsRoot) return true;
  return SENSITIVE_PATH_PATTERNS.some(p => verificationPath.includes(p));
}
