import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fsyncDirectory } from './pathSafety.js';

/**
 * Write `data` to `filePath` through a same-directory temp file and a rename,
 * so a reader never observes a partial file. One helper replaces several
 * hand-rolled copies whose on-disk behaviour differed; each difference is an
 * option so every caller keeps exactly what it did before.
 *
 * options:
 *  - fs: promises-style fs (default: fs.promises at call time). Injected fakes work.
 *  - encoding: write encoding ('utf8' default; pass null for Buffer data).
 *  - mode: temp file mode (default 0o600).
 *  - flag: writeFile flag when syncFile is false ('wx' default; pass null for the
 *    fs default 'w').
 *  - openFlags: flags for fs.open when syncFile is true (default 'wx').
 *  - tempPath: string or (filePath) => string. Default is an unguessable hidden
 *    sibling name.
 *  - mkdir: create the parent directory (recursive) first.
 *  - syncFile: open the temp file, write, fsync, close (instead of writeFile).
 *  - syncDirectory: false | 'strict' | 'best-effort'. After the rename, fsync the
 *    parent directory. 'strict' lets a failed sync throw; 'best-effort' swallows it.
 *  - signal / abortError: checked after the file is written and before the
 *    rename; an aborted signal throws abortError(signal) (or signal.reason).
 *  - cleanup: 'unlink' (default), 'rm' (fs.rm force) or false (leave the temp).
 */
export async function atomicWriteFile(filePath, data, options = {}) {
  const {
    fs: fsApi = fs.promises,
    encoding = 'utf8',
    mode = 0o600,
    flag = 'wx',
    openFlags = 'wx',
    tempPath,
    mkdir = false,
    syncFile = false,
    syncDirectory = false,
    signal,
    abortError,
    cleanup = 'unlink',
  } = options;

  if (mkdir) await fsApi.mkdir(path.dirname(filePath), { recursive: true });
  const temp = typeof tempPath === 'function'
    ? tempPath(filePath)
    : tempPath || path.join(path.dirname(filePath), `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  let handle = null;
  try {
    if (syncFile) {
      handle = await fsApi.open(temp, openFlags, mode);
      await handle.writeFile(data, encoding || undefined);
      await handle.sync();
      await handle.close();
      handle = null;
    } else {
      const writeOptions = { mode };
      if (encoding) writeOptions.encoding = encoding;
      if (flag) writeOptions.flag = flag;
      await fsApi.writeFile(temp, data, writeOptions);
    }
    if (signal?.aborted) {
      throw typeof abortError === 'function' ? abortError(signal) : (signal.reason ?? new Error('Write aborted before commit.'));
    }
    await fsApi.rename(temp, filePath);
    if (syncDirectory === 'strict') {
      await fsyncDirectory(path.dirname(filePath));
    } else if (syncDirectory === 'best-effort') {
      try { await fsyncDirectory(path.dirname(filePath)); } catch { /* directory fsync is best effort on filesystems that reject it */ }
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (cleanup === 'unlink') await fsApi.unlink(temp).catch(() => {});
    else if (cleanup === 'rm') await fsApi.rm(temp, { force: true }).catch(() => {});
  }
}
