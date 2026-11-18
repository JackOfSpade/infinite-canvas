import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFile } from '../../electron/utils/atomicWrite.js';

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-')); }
const leftovers = dir => fs.readdirSync(dir).filter(name => name.endsWith('.tmp') || name.includes('.tmp-'));

export default [{
  name: 'atomic write replaces the file, uses mode 0600 and leaves no temp file',
  async run() {
    const dir = scratch();
    try {
      const target = path.join(dir, 'a.json');
      fs.writeFileSync(target, 'old');
      await atomicWriteFile(target, 'new');
      assert.equal(fs.readFileSync(target, 'utf8'), 'new');
      assert.equal(fs.statSync(target).mode & 0o777, 0o600);
      assert.deepEqual(leftovers(dir), []);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  },
}, {
  name: 'atomic write creates the parent directory only when asked',
  async run() {
    const dir = scratch();
    try {
      const target = path.join(dir, 'x', 'y', 'a.txt');
      await assert.rejects(atomicWriteFile(target, 'v'), { code: 'ENOENT' });
      await atomicWriteFile(target, 'v', { mkdir: true });
      assert.equal(fs.readFileSync(target, 'utf8'), 'v');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  },
}, {
  name: 'atomic write refuses a pre-existing temp path (wx) and never publishes it',
  async run() {
    const dir = scratch();
    try {
      const target = path.join(dir, 'a.json');
      const temp = path.join(dir, 'a.json.tmp');
      fs.writeFileSync(target, 'keep');
      for (const syncFile of [false, true]) {
        fs.writeFileSync(temp, 'planted');
        await assert.rejects(atomicWriteFile(target, 'new', { tempPath: temp, syncFile }), { code: 'EEXIST' });
      }
      assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  },
}, {
  name: 'atomic write removes its temp file and keeps the old content when the rename fails',
  async run() {
    const dir = scratch();
    try {
      const target = path.join(dir, 'target');
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'inside'), 'x');
      for (const cleanup of ['unlink', 'rm']) {
        await assert.rejects(atomicWriteFile(target, 'new', { cleanup }));
        assert.deepEqual(leftovers(dir), [], cleanup);
      }
      assert.equal(fs.statSync(target).isDirectory(), true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  },
}, {
  name: 'atomic write with cleanup off leaves a failed temp file, and an injected fs is the only fs used',
  async run() {
    const calls = [];
    const fake = {
      mkdir: async () => calls.push('mkdir'),
      writeFile: async (file, data, options) => calls.push(['writeFile', file, data, options]),
      rename: async () => { calls.push('rename'); throw new Error('rename failed'); },
    };
    await assert.rejects(atomicWriteFile('/virtual/state.json', 'data', {
      fs: fake, mkdir: true, encoding: null, flag: null, tempPath: '/virtual/state.json.tmp', cleanup: false,
    }), /rename failed/);
    assert.deepEqual(calls, ['mkdir', ['writeFile', '/virtual/state.json.tmp', 'data', { mode: 0o600 }], 'rename']);
  },
}, {
  name: 'atomic write honours an abort signal before the rename and removes the temp file',
  async run() {
    const dir = scratch();
    try {
      const target = path.join(dir, 'a.json');
      fs.writeFileSync(target, 'old');
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(atomicWriteFile(target, 'new', { signal: controller.signal, syncFile: true }), { name: 'AbortError' });
      await assert.rejects(atomicWriteFile(target, 'new', {
        signal: controller.signal, abortError: () => Object.assign(new Error('custom'), { name: 'Custom' }),
      }), { name: 'Custom' });
      assert.equal(fs.readFileSync(target, 'utf8'), 'old');
      assert.deepEqual(leftovers(dir), []);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  },
}, {
  name: 'atomic write syncs the file and the parent directory, strict or best effort',
  async run() {
    const dir = scratch();
    const realOpen = fs.promises.open;
    const opened = [];
    const synced = [];
    fs.promises.open = async (file, ...rest) => {
      const handle = await realOpen.call(fs.promises, file, ...rest);
      opened.push(String(file));
      const realSync = handle.sync.bind(handle);
      handle.sync = async () => { synced.push(String(file)); return realSync(); };
      return handle;
    };
    try {
      const target = path.join(dir, 'a.json');
      await atomicWriteFile(target, 'one', { syncFile: true, syncDirectory: 'strict' });
      assert.equal(synced.length, 2, 'file then directory');
      assert.equal(synced[1], dir);
      assert.equal(fs.readFileSync(target, 'utf8'), 'one');

      synced.length = 0;
      await atomicWriteFile(target, 'two');
      assert.deepEqual(synced, [], 'no sync unless asked');

      // A failing directory sync throws when strict and is ignored when best effort.
      fs.promises.open = async (file, ...rest) => {
        const handle = await realOpen.call(fs.promises, file, ...rest);
        if (String(file) === dir) handle.sync = async () => { throw new Error('EINVAL'); };
        return handle;
      };
      await assert.rejects(atomicWriteFile(target, 'three', { syncDirectory: 'strict' }), /EINVAL/);
      await atomicWriteFile(target, 'four', { syncDirectory: 'best-effort' });
      assert.equal(fs.readFileSync(target, 'utf8'), 'four');
    } finally {
      fs.promises.open = realOpen;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
}];
