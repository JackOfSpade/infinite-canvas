import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { ipcMain } from 'electron';
import { registerApplicationBundleWatchHandlers } from '../../electron/ipc/applicationBundleWatch.js';

async function withWatchFixture(run) {
  const originalWatch = fs.watch;
  const originalRealpath = fs.promises.realpath;
  const watcherInstances = [];
  const senders = [];
  fs.promises.realpath = async () => '/synthetic/application-watch';
  fs.watch = () => {
    const watcher = new EventEmitter();
    watcher.closed = false;
    watcher.close = () => { watcher.closed = true; };
    watcherInstances.push(watcher);
    return watcher;
  };
  registerApplicationBundleWatchHandlers();
  const handler = ipcMain.__getInvokeHandler('watch-application-bundles');
  const createSender = (send = () => {}) => {
    const sender = new EventEmitter();
    sender.destroyed = false;
    sender.isDestroyed = () => sender.destroyed;
    sender.send = send;
    sender.destroy = () => { sender.destroyed = true; sender.emit('destroyed'); };
    senders.push(sender);
    return sender;
  };
  try {
    await run({
      watcherInstances, createSender,
      watch: sender => handler({ sender }, { canvasFilePath: '/synthetic/application-watch/canvas.json' }),
    });
  } finally {
    for (const sender of senders) sender.destroy();
    fs.watch = originalWatch;
    fs.promises.realpath = originalRealpath;
  }
}

function scheduleChange(watcher, filename) {
  const originalSetTimeout = globalThis.setTimeout;
  const timer = { callback: null };
  globalThis.setTimeout = callback => { timer.callback = callback; return timer; };
  try { watcher.emit('change', 'rename', filename); }
  finally { globalThis.setTimeout = originalSetTimeout; }
  assert.equal(typeof timer.callback, 'function', 'the filesystem event must schedule a notification');
  return timer;
}

export default [
  {
    name: 'application bundle watch: unavailable renderer frames cannot crash notifications to other windows',
    async run() {
      await withWatchFixture(async ({ watcherInstances, createSender, watch }) => {
        const sent = [];
        const unavailable = createSender(() => { throw new Error('Render frame disposed'); });
        const healthy = createSender((channel, payload) => sent.push({ channel, payload }));
        assert.deepEqual(await watch(unavailable), { watching: true });
        assert.deepEqual(await watch(healthy), { watching: true });
        assert.equal(watcherInstances.length, 1, 'windows watching the same canvas share its filesystem watcher');
        const timer = scheduleChange(watcherInstances[0], null);
        assert.doesNotThrow(() => timer.callback(), 'a send failure from a debounce timer is contained');
        assert.deepEqual(sent, [{ channel: 'application-bundles-changed', payload: { paths: ['/synthetic/application-watch'] } }],
          'filename-free events conservatively invalidate saved folders and still reach healthy windows');
        unavailable.destroy();
        assert.equal(watcherInstances[0].closed, false, 'another subscribed window keeps the watcher alive');
        healthy.destroy();
        assert.equal(watcherInstances[0].closed, true, 'the last window releases the watcher');
      });
    },
  },
  {
    name: 'application bundle watch: renderer teardown during path resolution cannot leave an unowned watcher',
    async run() {
      await withWatchFixture(async ({ watcherInstances, createSender, watch }) => {
        let releasePath;
        fs.promises.realpath = () => new Promise(resolve => { releasePath = resolve; });
        const sender = createSender();
        const pending = watch(sender);
        sender.destroy();
        releasePath('/synthetic/application-watch');
        assert.deepEqual(await pending, { watching: false });
        assert.equal(watcherInstances.length, 0, 'a destroyed sender never creates a filesystem watcher');
        assert.equal(sender.listenerCount('destroyed'), 0, 'its already-fired teardown event receives no stale listener');
      });
    },
  },
  {
    name: 'application bundle watch: filesystem errors clear debounce work and sender listeners before a retry',
    async run() {
      await withWatchFixture(async ({ watcherInstances, createSender, watch }) => {
        const sender = createSender();
        await watch(sender);
        const timer = scheduleChange(watcherInstances[0], 'Applied Jobs/Example');
        const originalClearTimeout = globalThis.clearTimeout;
        const cancelled = [];
        globalThis.clearTimeout = handle => cancelled.push(handle);
        try { watcherInstances[0].emit('error', new Error('Filesystem watcher unavailable')); }
        finally { globalThis.clearTimeout = originalClearTimeout; }
        assert.equal(watcherInstances[0].closed, true);
        assert(cancelled.includes(timer), 'an errored watcher cannot send a stale delayed notification');
        assert.equal(sender.listenerCount('destroyed'), 0, 'failed subscriptions leave no teardown listeners behind');
        assert.deepEqual(await watch(sender), { watching: true });
        assert.equal(watcherInstances.length, 2, 'a later subscription creates a fresh watcher');
        assert.equal(sender.listenerCount('destroyed'), 1, 'only the current subscription remains');
      });
    },
  },
];
