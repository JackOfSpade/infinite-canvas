import fs from 'node:fs';
import path from 'node:path';
import { assert } from './testHelpers.js';
import { writeFakeCloudflaredLauncher } from './fixtures/handoff-bridge/bridgeFixtures.js';
import { createFakeProcessTable } from './fixtures/handoff-bridge/fakeProcessTable.js';
import { createFakeSpawn } from './fixtures/handoff-bridge/fakeSpawn.js';

const fakeUrl = new URL('./fixtures/handoff-bridge/fake-cloudflared.js', import.meta.url);

export default [
  {
    name: 'handoff bridge: tunnel: injected spawn and process table model lifecycle without a child process',
    async run() {
      const table = createFakeProcessTable({ parentPid: 1000 });
      const spawn = createFakeSpawn({ processTable: table, pidStart: 2000 });
      const child = spawn('/synthetic/cloudflared', ['tunnel', '--loglevel', 'info'], { shell: false, detached: true });
      await Promise.resolve();
      assert(spawn.calls.length === 1 && spawn.last().command === '/synthetic/cloudflared', 'fake spawn must record one absolute executable');
      assert(spawn.last().options.shell === false && table.isAlive(child.pid), 'the fake child must begin alive with shell disabled');
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
      child.__writeStderr('synthetic line');
      assert(stderr === 'synthetic line', 'stdout and stderr must be observable without OS pipes');
      child.kill('SIGTERM');
      await Promise.resolve();
      assert(!table.isAlive(child.pid) && table.get(child.pid).signals.join(',') === 'SIGTERM', 'TERM must settle the injected child and process row');

      const stubborn = table.add({ pid: 2100, pgid: 2100, ignoreSignals: ['SIGTERM'] });
      table.add({ pid: 2101, ppid: stubborn.pid, pgid: stubborn.pgid, ignoreSignals: ['SIGTERM'] });
      table.killGroup(stubborn.pgid, 'SIGTERM');
      assert(table.isAlive(2100) && table.isAlive(2101), 'a TERM-ignoring group must remain alive for escalation tests');
      table.killGroup(stubborn.pgid, 'SIGKILL');
      assert(!table.isAlive(2100) && !table.isAlive(2101), 'KILL must terminate the whole injected group');
    },
  },
  {
    name: 'handoff bridge: tunnel: generated shell launcher pins absolute paths and is executable',
    run: () => {
      const fixture = writeFakeCloudflaredLauncher();
      try {
        assert(fixture.text.startsWith('#!/bin/sh\nexec '), 'launcher must be a plain sh exec wrapper');
        assert(fixture.text.includes(JSON.stringify(process.execPath)), 'launcher must pin the absolute Node executable');
        assert(fixture.text.includes(JSON.stringify(path.resolve(fixture.fake))), 'launcher must pin the absolute fake script');
        assert(fixture.text.endsWith(' "$@"\n'), 'launcher must preserve argv without shell interpolation');
        assert((fs.statSync(fixture.directory).mode & 0o777) === 0o755, 'launcher directory must be 0755');
        assert((fs.statSync(fixture.launcher).mode & 0o777) === 0o755, 'launcher must be executable');
      } finally {
        fixture.cleanup();
      }
      assert(!fs.existsSync(fixture.directory), 'launcher fixture must clean its temporary directory');
    },
  },
  {
    name: 'handoff bridge: tunnel: fake cloudflared modes are import-inert and cover supervisor failures',
    run: () => {
      const source = fs.readFileSync(fakeUrl, 'utf8');
      for (const mode of ['ready', 'crash-on-start', 'crash-after-ready', 'hang-no-ready', 'ignore-sigterm', 'secret-in-log', 'record-argv-env', 'spawn-child', 'exit-clean-unrequested', 'reject-flag']) {
        assert(source.includes(`'${mode}'`), `fake cloudflared must retain ${mode} mode`);
      }
      assert(source.includes('path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)'), 'importing the fake must never execute a mode');
      assert(source.includes("if (mode === 'ignore-sigterm') return"), 'ignore-sigterm must install a real no-op handler');
      assert(source.includes("spawn(process.execPath"), 'spawn-child must use an absolute executable only out of band');
    },
  },
];
