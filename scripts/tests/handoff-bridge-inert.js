import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import electronPkg from 'electron';
import { assert } from './testHelpers.js';
import {
  __resetHandoffBridgeForTests,
  getHandoffBridgeStatus,
  holdHandoffBridgeForQuit,
  refusalForStart,
  registerHandoffBridgeHandlers,
  resolveTestMode,
  resumeHandoffBridgeAfterQuitCancel,
  scheduleHandoffBridgeLaunch,
  startHandoffBridge,
  stopHandoffBridge,
} from '../../electron/ipc/handoffBridge/index.js';

const TMP = '/tmp/bridge-test';
const SAFE_PATHS = Object.freeze({
  binaryPath: `${TMP}/bin/cloudflared`,
  credentialsPath: `${TMP}/credentials/tunnel.json`,
  userData: `${TMP}/user-data`,
});
const READY_CONFIG = Object.freeze({ hostname: 'b-0123456789abcdef0123.lullascape.com' });
const READY_SETUP = Object.freeze({
  binaryPath: SAFE_PATHS.binaryPath,
  binaryTrusted: true,
  credentialsPath: SAFE_PATHS.credentialsPath,
  configValid: true,
});
const indexUrl = new URL('../../electron/ipc/handoffBridge/index.js', import.meta.url);
const registerUrl = new URL('../test-stubs/register.mjs', import.meta.url);

function completeStartDeps(overrides = {}) {
  return {
    env: {},
    isPackaged: true,
    enabled: true,
    userData: SAFE_PATHS.userData,
    tunnel: READY_SETUP,
    readConfig: () => ({ state: 'ok', config: READY_CONFIG }),
    ...overrides,
  };
}

export default [
  {
    name: 'handoff bridge: inert: I-01 import has no process, listener, spawn, write or timer machinery',
    run: () => {
      const source = fs.readFileSync(indexUrl, 'utf8');
      for (const forbidden of ['node:child_process', 'createServer', '.listen(', 'spawn(', 'setInterval(', 'process.on(']) {
        assert(!source.includes(forbidden), `inert index import must not contain ${forbidden}`);
      }
      assert(!source.includes('mkdirSync(') && !source.includes('writeFileSync('), 'inert index import must not write state');
      const probe = `
        import fs from 'node:fs';
        import http from 'node:http';
        import net from 'node:net';
        import childProcess from 'node:child_process';
        const electronPkg = (await import('electron')).default;
        await Promise.all([
          import(${JSON.stringify(new URL('../../electron/ipc/handoffBridge/constants.js', import.meta.url).href)}),
          import(${JSON.stringify(new URL('../../electron/ipc/handoffBridge/contracts.js', import.meta.url).href)}),
          import(${JSON.stringify(new URL('../../electron/ipc/handoffBridge/errors.js', import.meta.url).href)}),
          import(${JSON.stringify(new URL('../../electron/ipc/handoffBridge/store.js', import.meta.url).href)}),
        ]);
        const effects = { bind: 0, spawn: 0, write: 0, timer: 0, processOn: 0, appOn: 0, ipcHandle: 0 };
        const patch = (object, key, effect) => {
          const original = object[key];
          object[key] = function (...args) { effects[effect]++; return original.apply(this, args); };
        };
        patch(http, 'createServer', 'bind');
        patch(net, 'createServer', 'bind');
        patch(net, 'connect', 'bind');
        patch(childProcess, 'spawn', 'spawn');
        for (const key of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'unlinkSync']) patch(fs, key, 'write');
        patch(globalThis, 'setTimeout', 'timer');
        patch(globalThis, 'setInterval', 'timer');
        patch(process, 'on', 'processOn');
        patch(electronPkg.app, 'on', 'appOn');
        patch(electronPkg.ipcMain, 'handle', 'ipcHandle');
        await import(${JSON.stringify(indexUrl.href)} + '?inert-probe=1');
        console.log(JSON.stringify(effects));
      `;
      const child = spawnSync(process.execPath, [
        '--import', fileURLToPath(registerUrl), '--input-type=module', '--eval', probe,
      ], { cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8', timeout: 5000 });
      assert(child.status === 0, `inert import child failed: ${child.stderr || child.error?.message || child.status}`);
      const effects = JSON.parse(child.stdout.trim().split('\n').at(-1));
      assert(Object.values(effects).every(value => value === 0), `inert import produced side effects: ${JSON.stringify(effects)}`);
    },
  },
  {
    name: 'handoff bridge: inert: I-02 refusal ladder covers all twelve reasons in precedence order',
    run: () => {
      const base = { env: {}, isPackaged: true, paths: SAFE_PATHS, tmpdir: TMP, enabled: true, config: READY_CONFIG, setup: READY_SETUP };
      const cases = [
        [{ env: { INFINITE_CANVAS_HANDOFF_BRIDGE: '0', INFINITE_CANVAS_E2E: '1' } }, 'env_disabled'],
        [{ env: { INFINITE_CANVAS_E2E: '1' } }, 'e2e'],
        [{ isPackaged: false }, 'unpackaged'],
        [{ enabled: false }, 'not_enabled'],
        [{ config: null }, 'no_hostname'],
        [{ setup: { ...READY_SETUP, binaryPath: '' } }, 'no_binary'],
        [{ setup: { ...READY_SETUP, binaryTrusted: false } }, 'binary_untrusted'],
        [{ setup: { ...READY_SETUP, credentialsPath: '' } }, 'no_credentials'],
        [{ setup: { ...READY_SETUP, configValid: false } }, 'config_invalid'],
        [{ setup: { ...READY_SETUP, socketUnavailable: true } }, 'socket_unavailable'],
        [{ setup: { ...READY_SETUP, tunnelFailed: true } }, 'tunnel_failed'],
        [{ stateUnreadable: true }, 'state_unreadable'],
      ];
      for (const [overrides, expected] of cases) {
        assert(refusalForStart({ ...base, ...overrides }) === expected, `expected ${expected}`);
      }
    },
  },
  {
    name: 'handoff bridge: inert: I-03 environment and disabled refusals make zero injected calls',
    async run() {
      __resetHandoffBridgeForTests();
      let calls = 0;
      const poisoned = () => { calls++; throw new Error('must not be called'); };
      for (const env of [{ INFINITE_CANVAS_HANDOFF_BRIDGE: '0' }, { INFINITE_CANVAS_E2E: '1' }]) {
        const result = await startHandoffBridge({ deps: { env, isPackaged: true, enabled: true, app: { getPath: poisoned }, readConfig: poisoned } });
        assert(result.success === false, 'environment gate must refuse');
      }
      const disabled = await startHandoffBridge({ deps: { env: {}, isPackaged: true, enabled: false, app: { getPath: poisoned }, readConfig: poisoned } });
      assert(disabled.code === 'not_enabled' && calls === 0, 'disabled bridge must not read userData or config');
    },
  },
  {
    name: 'handoff bridge: inert: I-04 corrupt state fails closed and is never rewritten',
    async run() {
      __resetHandoffBridgeForTests();
      let writes = 0;
      const result = await startHandoffBridge({ deps: completeStartDeps({
        readConfig: () => ({ state: 'unreadable', config: READY_CONFIG, write: () => { writes++; } }),
      }) });
      assert(result.code === 'state_unreadable' && writes === 0, 'unknown/corrupt state must remain byte-untouched');
    },
  },
  {
    name: 'handoff bridge: inert: I-05 registration is idempotent after Electron handlers clear',
    async run() {
      __resetHandoffBridgeForTests();
      electronPkg.ipcMain.__clearInvokeHandlers();
      assert(registerHandoffBridgeHandlers(), 'first registration should install handler');
      assert(!registerHandoffBridgeHandlers(), 'second registration should be inert');
      electronPkg.ipcMain.__clearInvokeHandlers();
      assert(registerHandoffBridgeHandlers(), 'clearing Electron handlers must permit registration again');
      await stopHandoffBridge();
    },
  },
  {
    name: 'handoff bridge: inert: I-06 start is memoized and stop and quit hooks are harmless while off',
    async run() {
      __resetHandoffBridgeForTests();
      const first = startHandoffBridge({ deps: completeStartDeps() });
      const second = startHandoffBridge({ deps: completeStartDeps() });
      assert(first === second, 'concurrent starts must return one memoized promise');
      await first;
      assert(getHandoffBridgeStatus().serving === 'starting', 'a successful inert start may only enter starting');
      await holdHandoffBridgeForQuit();
      assert(getHandoffBridgeStatus().pauseCause === 'quit', 'quit must quiesce serving immediately');
      await resumeHandoffBridgeAfterQuitCancel();
      assert(getHandoffBridgeStatus().serving === 'starting', 'cancelled quit restores the prior serving state');
      await stopHandoffBridge();
      await holdHandoffBridgeForQuit();
      await resumeHandoffBridgeAfterQuitCancel();
      assert(getHandoffBridgeStatus().serving === 'off', 'never-started quit hooks are no-ops');
    },
  },
  {
    name: 'handoff bridge: inert: I-15 deferred launch does one pid stat and config read without a pidfile',
    async run() {
      const timers = [];
      let stats = 0;
      let reads = 0;
      let reaps = 0;
      const timer = scheduleHandoffBridgeLaunch({
        userData: SAFE_PATHS.userData,
        setTimeoutImpl: (fn, ms) => { timers.push({ fn, ms }); return 'launch-timer'; },
        stat: async () => { stats++; throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
        readConfig: () => { reads++; return { state: 'missing', config: { autoStart: false } }; },
        reapOrphans: async () => { reaps++; },
      });
      assert(timer === 'launch-timer' && timers.length === 1 && timers[0].ms === 3000, 'launch must schedule exactly one caller-owned timeout');
      assert(stats === 0 && reads === 0 && reaps === 0, 'scheduling must not do immediate startup work');
      await timers[0].fn();
      assert(stats === 1 && reads === 1 && reaps === 0, 'no pidfile means no reaper or process inspection');
    },
  },
  {
    name: 'handoff bridge: inert: I-16 test mode only lifts E2E and unpackaged for safe temporary paths',
    run: () => {
      const testEnv = { INFINITE_CANVAS_HANDOFF_BRIDGE_TEST: '1' };
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-b0-'));
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-b0-out-'));
      const paths = {
        binaryPath: path.join(root, 'bin', 'cloudflared'),
        credentialsPath: path.join(root, 'credentials', 'tunnel.json'),
        userData: path.join(root, 'u'),
      };
      try {
        fs.mkdirSync(path.dirname(paths.binaryPath), { recursive: true });
        fs.mkdirSync(path.dirname(paths.credentialsPath), { recursive: true });
        fs.mkdirSync(paths.userData, { recursive: true });
        fs.writeFileSync(paths.binaryPath, 'synthetic binary');
        fs.writeFileSync(paths.credentialsPath, '{}');
        fs.writeFileSync(path.join(outside, 'cloudflared'), 'synthetic outside binary');
        fs.symlinkSync(outside, path.join(root, 'escape'));

        assert(resolveTestMode({ env: testEnv, isPackaged: false, paths, tmpdir: root }), 'all canonical temporary paths enable test mode');
        const invalid = [
          { isPackaged: true, paths },
          { isPackaged: false, paths: { ...paths, binaryPath: '/opt/cloudflared' } },
          { isPackaged: false, paths: { ...paths, binaryPath: path.join(root, 'escape', 'cloudflared') } },
          { isPackaged: false, paths: { ...paths, userData: '../bridge-test/user-data' } },
          { isPackaged: false, paths: { ...paths, userData: `${root}/nested/../u` } },
          { isPackaged: false, paths: { ...paths, userData: `${root}-copy/u` } },
          { isPackaged: false, paths: { ...paths, userData: `${root}/${'x'.repeat(100)}` } },
        ];
        for (const candidate of invalid) {
          assert(!resolveTestMode({ env: testEnv, tmpdir: root, ...candidate }), 'unsafe, escaping, missing or packaged test mode must be ignored');
        }
        for (const env of [{ INFINITE_CANVAS_E2E: '1' }, { INFINITE_CANVAS_E2E_BACKGROUND: '1' }]) {
          assert(refusalForStart({ env, isPackaged: false, paths, tmpdir: root, enabled: true, config: READY_CONFIG, setup: READY_SETUP }) === 'e2e', 'every E2E variant without TEST must refuse');
        }
        const lifted = refusalForStart({
          env: { ...testEnv, INFINITE_CANVAS_E2E: '1' },
          isPackaged: false,
          paths,
          tmpdir: root,
          enabled: false,
          config: READY_CONFIG,
          setup: READY_SETUP,
        });
        assert(lifted === 'not_enabled', 'valid TEST lifts only the E2E refusal, not the disabled state');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
  },
];
