#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function assertRealParentDirectories(root, absolute, file) {
  let parent = root;
  const relative = path.relative(root, path.dirname(absolute));
  for (const component of relative.split(path.sep).filter(Boolean)) {
    parent = path.join(parent, component);
    const entry = fs.lstatSync(parent);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Source manifest parent must be a real directory: ${JSON.stringify(file)}`);
    }
  }
}

/** Hash source paths and bytes for the launcher without writing file contents to its stamp. */
export function sourceManifestDigest(root, paths) {
  const directory = fs.realpathSync(root);
  const files = [...new Set(paths.map(file => String(file).replace(/^\.\//, '')))].sort();
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    const absolute = path.resolve(directory, file);
    if (!file || path.isAbsolute(file) || !absolute.startsWith(`${directory}${path.sep}`)) {
      throw new Error(`Source manifest received a path outside the workspace: ${JSON.stringify(file)}`);
    }
    hash.update(Buffer.from(`${Buffer.byteLength(file)}:${file}\0`, 'utf8'));
    try {
      assertRealParentDirectories(directory, absolute, file);
      const entry = fs.lstatSync(absolute);
      if (entry.isSymbolicLink()) {
        // Following it could read outside the workspace or block on a device.
        // Hashing only its link text would miss edits to an external .env or
        // source target, so fail closed instead of declaring the build fresh.
        throw new Error(`Source manifest does not support symlinks: ${JSON.stringify(file)}`);
      }
      if (!entry.isFile()) throw new Error(`Source manifest expected a regular file: ${JSON.stringify(file)}`);
      const noFollow = fs.constants.O_NOFOLLOW || 0;
      const handle = fs.openSync(absolute, fs.constants.O_RDONLY | noFollow);
      try {
        const opened = fs.fstatSync(handle);
        if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino) {
          throw new Error(`Source manifest file changed while opening: ${JSON.stringify(file)}`);
        }
        const contents = fs.readFileSync(handle);
        assertRealParentDirectories(directory, absolute, file);
        hash.update(Buffer.from(`file:${contents.length}:`, 'utf8'));
        hash.update(contents);
      } finally {
        fs.closeSync(handle);
      }
    } catch (error) {
      // A deleted tracked file remains in git ls-files. Its missing marker
      // changes the digest, so the launcher rebuilds after the deletion.
      if (error?.code !== 'ENOENT') throw error;
      hash.update('missing:');
    }
  }
  return hash.digest('hex');
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isDirectRun()) {
  try {
    const input = fs.readFileSync(0);
    if (input.length && input[input.length - 1] !== 0) throw new Error('Source manifest input must be NUL-delimited.');
    const files = input.length ? input.toString('utf8').slice(0, -1).split('\0') : [];
    process.stdout.write(`${sourceManifestDigest(process.cwd(), files)}\n`);
  } catch (error) {
    process.stderr.write(`Source manifest failed: ${error?.message || error}\n`);
    process.exitCode = 1;
  }
}
