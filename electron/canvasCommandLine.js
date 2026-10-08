import fs from 'node:fs';
import path from 'node:path';
import { isExistingFile, isSensitivePath } from './utils/pathSafety.js';

/**
 * Resolve a command-line (or native file-picker) candidate to the one spelling
 * used for window routing.  Canvas files are user-provided JSON documents, so
 * accept only an existing regular file and never allow a path that resolves
 * into one of the credential/system locations blocked elsewhere in the main
 * process.
 */
export function resolveSafeCanvasFilePath(candidate, {
  cwd = process.cwd(),
  realpathSync = fs.realpathSync.native || fs.realpathSync,
  isExistingFileImpl = isExistingFile,
  isSensitivePathImpl = isSensitivePath,
} = {}) {
  if (typeof candidate !== 'string' || !candidate || candidate.startsWith('-')) return null;
  if (path.extname(candidate).toLowerCase() !== '.json') return null;

  let canonicalPath;
  try {
    canonicalPath = realpathSync(path.resolve(cwd, candidate));
  } catch {
    return null;
  }

  if (!isExistingFileImpl(canonicalPath) || isSensitivePathImpl(canonicalPath)) return null;
  return canonicalPath;
}

/** Find the first safe canvas path supplied on an Electron command line. */
export function canvasPathFromCommandLine(commandLine, options = {}) {
  if (!Array.isArray(commandLine)) return null;
  for (const argument of commandLine) {
    const filePath = resolveSafeCanvasFilePath(argument, options);
    if (filePath) return filePath;
  }
  return null;
}

/** Initial-launch behavior: a requested canvas wins over normal session restore. */
export function initialCanvasWindowSpec(commandLine, options = {}) {
  const filePath = canvasPathFromCommandLine(commandLine, options);
  return filePath ? { mode: 'file', filePath } : { mode: 'auto' };
}

/** Relaunch behavior: a requested canvas wins over the normal blank canvas. */
export function secondInstanceCanvasWindowSpec(commandLine, options = {}) {
  const filePath = canvasPathFromCommandLine(commandLine, options);
  return filePath ? { mode: 'file', filePath } : { mode: 'blank' };
}

/**
 * Keep one editable window per canonical canvas path.  Returning a small
 * result makes this route independently testable without a live Electron app.
 */
export function openOrFocusCanvasWindow(filePath, {
  canvasWindows,
  createWindow,
} = {}) {
  for (const win of canvasWindows || []) {
    if (!win || win.isDestroyed?.()) continue;
    if (win.__canvasFilePath !== filePath) continue;
    if (win.isMinimized?.()) win.restore?.();
    win.focus?.();
    return { action: 'focused', window: win };
  }
  return { action: 'opened', window: createWindow?.({ mode: 'file', filePath }) || null };
}
