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
