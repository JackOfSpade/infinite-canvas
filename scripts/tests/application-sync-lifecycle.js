import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import {
  __applicationSyncStatePathForTests,
  __resetApplicationSyncWorkspacesForTests,
  applicationSyncStatusSnapshot,
  startApplicationSyncServer,
  stopApplicationSyncServer,
} from '../../electron/ipc/applicationSync.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

async function withSyncServerFixture(run) {
  await stopApplicationSyncServer();
  await __resetApplicationSyncWorkspacesForTests();
  const originalCreateServer = http.createServer;
  const originalReadFile = fs.promises.readFile;
  const servers = [];
  let stateReader = async () => { throw Object.assign(new Error('No saved state'), { code: 'ENOENT' }); };
  let nextListen = deferred();
  fs.promises.readFile = (target, ...args) => String(target) === __applicationSyncStatePathForTests()
    ? stateReader() : originalReadFile.call(fs.promises, target, ...args);
  http.createServer = () => {
    const current = new EventEmitter();
    current.listening = false;
    current.closed = 0;
    current.listen = (_port, _host, callback) => {
      current.finishListen = () => { current.listening = true; callback(); };
      nextListen.resolve(current);
      return current;
    };
    current.close = callback => { current.listening = false; current.closed += 1; callback(); };
    servers.push(current);
    return current;
  };
  try {
    await run({
      servers,
      setStateReader: reader => { stateReader = reader; },
      waitForListen: () => nextListen.promise,
      nextListen: () => { nextListen = deferred(); },
    });
  } finally {
    await stopApplicationSyncServer();
    http.createServer = originalCreateServer;
    fs.promises.readFile = originalReadFile;
    await __resetApplicationSyncWorkspacesForTests();
  }
}

export default [
  {
    name: 'application Sync lifecycle: runtime accept errors remain contained and visible in diagnostics',
    async run() {
      await withSyncServerFixture(async ({ waitForListen }) => {
        const starting = startApplicationSyncServer();
        const current = await waitForListen();
        current.finishListen();
        assert.equal(await starting, true);
        assert.doesNotThrow(() => current.emit('error', new Error('accept EMFILE')),
          'an HTTP server error after bind must not crash the main process');
        assert.equal(applicationSyncStatusSnapshot().lastError, 'accept EMFILE');
      });
    },
  },
  {
    name: 'application Sync lifecycle: concurrent startup callers share the actual bind result',
    async run() {
      await withSyncServerFixture(async ({ servers, waitForListen }) => {
        const first = startApplicationSyncServer();
        let secondSettled = false;
        const second = startApplicationSyncServer().then(result => { secondSettled = true; return result; });
        const current = await waitForListen();
        await Promise.resolve();
        assert.equal(servers.length, 1, 'startup creates only one HTTP server');
        assert.equal(secondSettled, false, 'no caller reports success while the bind is still pending');
        current.emit('error', Object.assign(new Error('Port already in use'), { code: 'EADDRINUSE' }));
        assert.deepEqual(await Promise.all([first, second]), [false, false], 'every caller observes the same bind failure');
        assert.equal(applicationSyncStatusSnapshot().serverListening, false);
      });
    },
  },
  {
    name: 'application Sync lifecycle: quitting during registry loading cannot start a late server',
    async run() {
      await withSyncServerFixture(async ({ servers, setStateReader }) => {
        const read = deferred();
        const entered = deferred();
        setStateReader(() => { entered.resolve(); return read.promise; });
        const starting = startApplicationSyncServer();
        await entered.promise;
        const stopping = stopApplicationSyncServer();
        read.reject(Object.assign(new Error('No saved state'), { code: 'ENOENT' }));
        assert.equal(await starting, false, 'a startup predating shutdown is cancelled');
        await stopping;
        assert.equal(servers.length, 0, 'the cancelled startup never binds a new HTTP server');
      });
    },
  },
  {
    name: 'application Sync lifecycle: quitting during bind closes that exact server and permits a clean restart',
    async run() {
      await withSyncServerFixture(async ({ servers, waitForListen, nextListen }) => {
        const starting = startApplicationSyncServer();
        const current = await waitForListen();
        const stopping = stopApplicationSyncServer();
        assert.doesNotThrow(() => current.finishListen(), 'the delayed bind callback never dereferences a cleared global server');
        assert.equal(await starting, false, 'a shutdown-bound startup cannot report an available service');
        await stopping;
        assert.equal(current.closed, 1, 'shutdown closes the server created by its pending startup');
        assert.equal(applicationSyncStatusSnapshot().serverListening, false);
        nextListen();
        const restarted = startApplicationSyncServer();
        const replacement = await waitForListen();
        replacement.finishListen();
        assert.equal(await restarted, true);
        assert.equal(servers.length, 2);
        assert.equal(applicationSyncStatusSnapshot().serverListening, true, 'a later startup remains usable');
      });
    },
  },
];
