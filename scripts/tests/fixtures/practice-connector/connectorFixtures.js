import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function createSocketFsNet({ existing = null, connect = 'missing', uid = process.getuid?.() ?? 0, mode = 0o600, directoryMode = 0o700 } = {}) {
  const entries = new Map();
  const socketPath = existing || '/tmp/ic-handoff/b.sock';
  if (existing) entries.set(existing, { type: 'socket', uid, mode });
  const errorFor = value => {
    const error = new Error(value);
    error.code = value;
    return error;
  };
  const fsPort = {
    existsSync: target => entries.has(target),
    lstatSync: target => {
      const entry = entries.get(target);
      if (!entry) throw errorFor('ENOENT');
      return { isSocket: () => entry.type === 'socket', uid: entry.uid, mode: entry.mode };
    },
    chmodSync: (target, nextMode) => {
      const entry = entries.get(target);
      if (!entry) throw errorFor('ENOENT');
      entry.mode = nextMode;
    },
    unlinkSync: target => {
      if (!entries.has(target)) throw errorFor('ENOENT');
      entries.delete(target);
    },
    statSync: target => ({ uid, mode: directoryMode, isDirectory: () => true, path: target }),
  };
  const netPort = {
    connect: (options, onConnect) => {
      const socket = {
        once(event, callback) {
          if (event === 'connect' && connect === 'live') queueMicrotask(callback);
          if (event === 'error' && connect !== 'live') queueMicrotask(() => callback(errorFor(connect === 'permission' ? 'EACCES' : 'ECONNREFUSED')));
          return socket;
        },
        destroy() { socket.destroyed = true; },
        destroyed: false,
        options,
      };
      if (connect === 'live' && typeof onConnect === 'function') queueMicrotask(onConnect);
      return socket;
    },
  };
  return Object.freeze({ fs: fsPort, net: netPort, entries, socketPath, connect });
}

// The launcher is generated at test time. It never asks PATH to find Node:
// both executable paths are absolute and the caller owns cleanup.
export function writeFakeCloudflaredLauncher() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-handoff-fake-'));
  fs.chmodSync(directory, 0o755);
  const fake = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fake-cloudflared.js');
  const launcher = path.join(directory, 'cloudflared-launcher');
  fs.writeFileSync(launcher, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} "$@"\n`, { mode: 0o755 });
  fs.chmodSync(launcher, 0o755);
  return Object.freeze({
    directory,
    launcher,
    fake,
    text: fs.readFileSync(launcher, 'utf8'),
    cleanup() { fs.rmSync(directory, { recursive: true, force: true }); },
  });
}
