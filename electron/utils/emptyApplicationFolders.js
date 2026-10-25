import fs from 'node:fs/promises';
import path from 'node:path';
import { isWithinDirectory } from './pathSafety.js';

// Only Finder's regular .DS_Store file counts as empty. Other hidden files,
// directories and symbolic links are content, and must survive cleanup.
async function assertRegularDirectory(directory) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || await fs.realpath(directory) !== directory) {
    throw new Error('Empty-folder cleanup requires a directory without symbolic links.');
  }
}

async function removeEmptyDirectory(directory) {
  try {
    await assertRegularDirectory(directory);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    if (entries.some(entry => entry.name !== '.DS_Store' || !entry.isFile())) return false;
    if (entries.length) await fs.unlink(path.join(directory, '.DS_Store'));
    // Never use recursive removal: a new file arriving after the emptiness
    // check must cause rmdir to refuse rather than lose that file.
    await fs.rmdir(directory);
    return true;
  } catch (error) {
    if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) return false;
    throw error;
  }
}

export async function pruneEmptyApplicationParents(bundleDirectory, canvasRoot) {
  const bundle = path.resolve(bundleDirectory);
  // Saved destinations always have the shape outputRoot/company/location/role.
  // Preserve outputRoot itself, including when a routine uses a custom root.
  const outputRoot = path.dirname(path.dirname(path.dirname(bundle)));
  const canvas = path.resolve(canvasRoot);
  if (outputRoot === canvas || !isWithinDirectory(canvas, outputRoot)) return [];
  await assertRegularDirectory(canvas);
  await assertRegularDirectory(outputRoot);
  const removed = [];
  for (let directory = path.dirname(bundle); directory !== outputRoot; directory = path.dirname(directory)) {
    if (!await removeEmptyDirectory(directory)) break;
    removed.push(directory);
  }
  return removed;
}

// One-time maintenance uses the same empty-directory rule, bottom-up, and
// always leaves the chosen Applied Jobs root in place.
export async function cleanupEmptyApplicationFolders(rootDirectory) {
  const root = path.resolve(rootDirectory);
  await assertRegularDirectory(root);
  const removed = [];
  async function visit(directory) {
    await assertRegularDirectory(directory);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const child = path.join(directory, entry.name);
      await visit(child);
      if (await removeEmptyDirectory(child)) removed.push(child);
    }
  }
  await visit(root);
  return removed;
}
