import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import electronPkg from 'electron';
import { assert } from './testHelpers.js';
import { runBackgroundE2EShutdownCleanup } from '../../electron/utils/backgroundE2e.js';
import { CONSTANTS } from '../../electron/ipc/handoffBridge/constants.js';
import { IPC_CHANNELS, IPC_EVENTS } from '../../electron/ipc/handoffBridge/contracts.js';
import {
  appendClosedHandoffAudit,
  composeHandoffBridge,
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
const COMPOSITION_START_CONTEXT = Object.freeze({ env: {}, isPackaged: true, tmpdir: TMP });
const indexUrl = new URL('../../electron/ipc/handoffBridge/index.js', import.meta.url);
const registerUrl = new URL('../test-stubs/register.mjs', import.meta.url);

function completeStartDeps(overrides = {}) {
  return {
    env: {},
    isPackaged: true,
    enabled: true,
    userData: SAFE_PATHS.userData,
    tunnelState: READY_SETUP,
    readConfig: () => ({ state: 'ok', config: READY_CONFIG }),
    ...overrides,
  };
}

function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function bridgeIpc() {
  const handlers = new Map(); const listeners = new Map();
  return {
    handlers, listeners,
    handle(channel, handler) { handlers.set(channel, handler); },
    removeHandler(channel) { handlers.delete(channel); },
    on(channel, listener) { listeners.set(channel, listener); },
    removeListener(channel, listener) { if (listeners.get(channel) === listener) listeners.delete(channel); },
    __getInvokeHandler(channel) { return handlers.get(channel); },
  };
}

function liveCanvas(id = 71) {
  const sent = [];
  const webContents = { id, __isCanvasRenderer: true, sent, send(channel, value) { sent.push({ channel, value }); } };
  return { webContents, sent, __canvasFilePath: '/tmp/bridge-regression.canvas', isDestroyed: () => false, show() {}, focus() {} };
}

function liveStatus(hostname = READY_CONFIG.hostname) {
  return {
    enabled: true, serving: 'live', paused: false, pauseCause: null,
    config: { hostname, scope: { applications: true, scoring: false } },
    prefs: { sourcePolicy: 'enforce', pairingNetworkCheck: true },
    limits: { idlePauseMinutes: 1440 }, autoRelease: false,
    setup: { tunnelReachable: true },
  };
}

function deterministicTimers() {
  const pending = new Set(); let sequence = 0;
  const add = fn => {
    const timer = { id: ++sequence, fn, unref() { return timer; } };
    pending.add(timer);
    return timer;
  };
  const clear = timer => { pending.delete(timer); };
  return {
    setTimeout: add, clearTimeout: clear,
    setInterval: add, clearInterval: clear,
    pending: () => pending.size,
  };
}

// This is deliberately an in-process request seam, never a socket or network
// client. It lets the composed public-probe branch prove which request shape
// it selected while returning the fixed protected-resource document.
function successfulProbeRequest(calls, hostname) {
  return (...args) => {
    const target = typeof args[0] === 'string' ? args[0] : null;
    const options = target === null ? args[0] : args[1];
    const callback = target === null ? args[1] : args[2];
    calls.push({ target, options });
    const handlers = new Map();
    const request = {
      on(event, fn) { handlers.set(event, fn); return request; },
      setTimeout() { return request; },
      destroy() {},
      end() {
        const responseHandlers = new Map();
        const response = {
          statusCode: 200,
          headers: {},
          on(event, fn) { responseHandlers.set(event, fn); return response; },
          resume() {},
        };
        callback(response);
        responseHandlers.get('data')?.(Buffer.from(JSON.stringify({ resource: `https://${hostname}/mcp` })));
        responseHandlers.get('end')?.();
      },
    };
    return request;
  };
}

function compositionEngine() {
  return {
    status: () => ({
      queue: { applications: { ready: 0, working: 0, needsYou: 0, held: 0, done: 0 }, scoring: { pending: 0 }, jobs: [] },
      chat: { state: 'none', jobsCap: 2 }, counts: {},
    }),
    powerState: () => ({}),
    async setScope() {}, async setLimits() {}, async pause() { return { ok: true }; }, async resume() {},
    async tick() {}, async close() {}, async clearPushHubs() { return { ok: true }; }, async revokeAll() { return { ok: true }; },
  };
}

function createCompositionGraph({ testMode = false, now = () => 0, pairingOpen = async () => ({ ok: false, code: 'TUNNEL_NOT_READY' }) } = {}) {
  const hostname = READY_CONFIG.hostname;
  const config = {
    ...READY_CONFIG,
    limits: { idlePauseMinutes: 1, releaseTtlHours: 0, chatKeyMaxAgeHours: 0, jobsPerChat: 2, epochSoftBytes: 500_000, epochHardBytes: 750_000 },
    prefs: { sourcePolicy: 'enforce', pairingNetworkCheck: true }, scope: { applications: true, scoring: false },
  };
  const timers = deterministicTimers(); const publicCalls = []; const socketCalls = [];
  const parent = liveCanvas(testMode ? 82 : 81);
  const engine = compositionEngine();
  const listener = {
    status: () => ({}), async start() { return { ok: true }; }, async selfProbe() { return { ok: true }; },
    async quiesce() {}, async drain() {}, async close() {}, async stop() {},
  };
  const tunnelSupervisor = {
    status: () => ({ state: 'online', credentialsMode: 'ok' }), async start() { return { ok: true }; },
    async stop() {}, async dispose() {},
  };
  const oauth = {
    authenticate: async () => null, linkStatus: () => [], closePairing() {}, revokeAll: async () => ({ ok: true }), flush: async () => true,
  };
  const pairing = {
    open: pairingOpen, cancel() {}, status: () => ({ open: false }), pairingGate: () => false,
    recordOwnEgress: () => false, onOAuthPairingClosed: () => false, onConsentRequested: () => false,
    onLinked: () => false, onDisconnected: () => false, maybeHint: () => false,
  };
  const graph = composeHandoffBridge({
    userData: `${TMP}/composition-${testMode ? 'test' : 'production'}`,
    config,
    tunnelState: { ...READY_SETUP, pin: 'a'.repeat(64), approvedAt: 1 },
    testMode,
    deps: {
      now, timers, engine, listener, tunnelSupervisor, oauth, pairing,
      audit: { append: () => Promise.resolve(true), flush: async () => true }, laneStore: {}, application: {}, push: {},
      dialogs: { ask: async () => ({ ok: true }) }, power: { update() {}, dispose() {} }, tray: { apply() {}, destroy() {} },
      getCanvasWindows: () => [parent], requestHandler: () => undefined,
      readConfig: () => ({ state: 'ok', config }), writeEnabled: async () => true,
      publicRequest: successfulProbeRequest(publicCalls, hostname), socketRequest: successfulProbeRequest(socketCalls, hostname),
    },
  });
  return { graph, parent, timers, publicCalls, socketCalls };
}

async function disposeCompositionGraph(graph) {
  try { await graph?.controller?.disable?.(); } catch { /* test cleanup is best effort */ }
  try { graph?.unsubscribeUi?.(); } catch { /* no platform resource exists in this fixture */ }
  try { graph?.power?.dispose?.(); } catch { /* no platform resource exists in this fixture */ }
  try { graph?.tray?.destroy?.(); } catch { /* no platform resource exists in this fixture */ }
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
      await stopHandoffBridge();
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
      await stopHandoffBridge();
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
      await stopHandoffBridge();
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
      await stopHandoffBridge();
      let compositions = 0;
      const compose = () => {
        compositions += 1;
        return {
          controller: {
            snapshot: () => ({ serving: 'off', paused: false, pauseCause: null, enabled: false }),
            async enable() { return { success: true }; },
            async disable() {},
          },
          listener: {}, tunnel: {}, power: {}, tray: {},
        };
      };
      const first = startHandoffBridge({ deps: completeStartDeps({ compose }) });
      const second = startHandoffBridge({ deps: completeStartDeps({ compose }) });
      await first;
      await second;
      assert(compositions === 1, 'a delayed/manual duplicate start must route to the attached graph, never compose twice');
      assert(getHandoffBridgeStatus().serving === 'off', 'an unattached runtime remains closed until explicit activation');
      await holdHandoffBridgeForQuit();
      assert(getHandoffBridgeStatus().pauseCause === null, 'quit is a no-op before serving begins');
      await resumeHandoffBridgeAfterQuitCancel();
      assert(getHandoffBridgeStatus().serving === 'off', 'cancelled quit leaves a closed runtime closed');
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
  {
    name: 'handoff bridge: inert: I-07 through I-14 bridge-off equivalence has only documented registration and launch effects',
    async run() {
      let binds = 0; let writes = 0;
      const ipc = { handlers: [], handle(channel) { this.handlers.push(channel); }, removeHandler() {}, on(channel) { this.handlers.push(channel); }, __getInvokeHandler() { return null; } };
      const result = await startHandoffBridge({ deps: { env: {}, isPackaged: true, enabled: false, app: { getPath: () => { binds++; return '/not/read'; } }, readConfig: () => { writes++; return null; } } });
      registerHandoffBridgeHandlers({ ipcMain: ipc, deps: { getCanvasWindows: () => [] } });
      assert(result.code === 'not_enabled' && binds === 0 && writes === 0, 'off bridge must not bind, write or spawn');
      assert(ipc.handlers.length === 25, 'off equivalence permits exactly 24 invokes and publish-jobs');
      await stopHandoffBridge();
    },
  },
  {
    name: 'handoff bridge: inert: I-17 test pairing hook exists only for safe test mode and dies on stop',
    async run() {
      await stopHandoffBridge();
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-bridge-hook-'));
      const setup = { binaryPath: path.join(root, 'binary'), binaryTrusted: true, credentialsPath: path.join(root, 'credentials'), pin: 'd'.repeat(64), approvedAt: 1 };
      try {
        fs.writeFileSync(setup.binaryPath, 'binary'); fs.writeFileSync(setup.credentialsPath, '{}');
        let displayedCode = null;
        const composed = [];
        const compose = args => {
          composed.push({ testMode: args?.testMode === true, pin: args?.tunnelState?.pin });
          return { readPairingCode: () => displayedCode, controller: { async enable() { return { success: true }; }, async disable() {} }, listener: {}, tunnel: {}, power: {}, tray: {} };
        };
        const start = await startHandoffBridge({ deps: { env: { INFINITE_CANVAS_HANDOFF_BRIDGE_TEST: '1', INFINITE_CANVAS_E2E: '1' }, isPackaged: false, enabled: true, userData: root, tmpdir: os.tmpdir(), tunnelState: setup, readConfig: () => ({ state: 'ok', config: READY_CONFIG }), compose, activate: true, confirmed: true } });
        assert(start.success && globalThis.__icHandoffBridgeTest?.readPairingCode() === null, 'test hook returns null while no native pairing sheet is live');
        assert(composed.length === 1 && composed[0].testMode && composed[0].pin === setup.pin,
          'safe test mode reaches composition as one boolean while retaining the app-copy pin');
        displayedCode = '23456789AB';
        assert(globalThis.__icHandoffBridgeTest?.readPairingCode() === '23456789AB', 'test hook exposes only the currently displayed pairing code');
        await stopHandoffBridge(); assert(!Object.hasOwn(globalThis, '__icHandoffBridgeTest'), 'hard stop deletes test-only hook');
        const production = await startHandoffBridge({ deps: { env: {}, isPackaged: true, enabled: true, userData: root, tunnelState: setup, readConfig: () => ({ state: 'ok', config: READY_CONFIG }), compose } });
        assert(production.success && !Object.hasOwn(globalThis, '__icHandoffBridgeTest'), 'production composition never installs hook');
        assert(composed.length === 2 && !composed[1].testMode && composed[1].pin === setup.pin,
          'the production composition retains the same pin but never receives the test trust profile');
      } finally { await stopHandoffBridge(); fs.rmSync(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'handoff bridge: inert: B6 composition selects public versus socket trust probes without a network client',
    async run() {
      await stopHandoffBridge();
      const production = createCompositionGraph({ testMode: false });
      try {
        const enabled = await production.graph.controller.enable({ confirmed: true, startContext: COMPOSITION_START_CONTEXT });
        assert(enabled.success && production.graph.testMode === false, `the production graph must become live without a test-mode capability: ${JSON.stringify(enabled)}`);
        assert(production.publicCalls.length === 1 && production.socketCalls.length === 0, 'production uses only its guarded public probe seam');
        const request = production.publicCalls[0];
        assert(request.target === `https://${READY_CONFIG.hostname}/.well-known/oauth-protected-resource/mcp`
          && request.options.servername === READY_CONFIG.hostname && typeof request.options.lookup === 'function'
          && !Object.hasOwn(request.options, 'socketPath') && !Object.hasOwn(request.options, 'rejectUnauthorized'),
        'production probe is hostname/TLS/guarded-lookup based and retains default TLS verification');
      } finally {
        await disposeCompositionGraph(production.graph);
      }

      const test = createCompositionGraph({ testMode: true });
      try {
        const enabled = await test.graph.controller.enable({ confirmed: true, startContext: COMPOSITION_START_CONTEXT });
        assert(enabled.success && test.graph.testMode === true, 'the test graph must retain its explicit composition profile');
        assert(test.socketCalls.length === 1 && test.publicCalls.length === 0, 'test mode replaces the public edge request with exactly one socket probe');
        const request = test.socketCalls[0];
        assert(request.target === null && request.options.socketPath === test.graph.socketPath
          && request.options.headers?.host === READY_CONFIG.hostname
          && !Object.hasOwn(request.options, 'host') && !Object.hasOwn(request.options, 'port') && !Object.hasOwn(request.options, 'lookup'),
        'test probe carries only the configured Host over the shared Unix socket and cannot resolve or dial a hostname');
      } finally {
        await disposeCompositionGraph(test.graph);
      }
    },
  },
  {
    name: 'handoff bridge: inert: only a successful native pairing sheet resets the human idle clock',
    async run() {
      let stamp = 0;
      const successful = createCompositionGraph({ now: () => stamp, pairingOpen: async () => ({ ok: true, expiresAt: stamp + 600_000 }) });
      try {
        const enabled = await successful.graph.controller.enable({ confirmed: true, startContext: COMPOSITION_START_CONTEXT });
        assert(enabled.success, `successful-pairing fixture must be live first: ${JSON.stringify(enabled)}`);
        stamp = 59_000;
        const paired = await successful.graph.openPairing({ parentWindow: successful.parent });
        assert(paired.ok, 'a native pairing sheet that actually opened is the one pairing result that may count as human action');
        stamp = 60_000;
        await successful.graph.controller.tick();
        assert(successful.graph.controller.snapshot().serving === 'live', 'a successful native pairing sheet resets the idle deadline');
        stamp = 119_000;
        await successful.graph.controller.tick();
        assert(successful.graph.controller.snapshot().paused && successful.graph.controller.snapshot().pauseCause === 'idle', 'the reset clock still expires normally after one full idle period');
        stamp = 119_001;
        assert((await successful.graph.openPairing({ parentWindow: successful.parent })).ok
          && successful.graph.controller.snapshot().paused && successful.graph.controller.snapshot().pauseCause === 'idle',
        'pairing can reset its clock while paused but must never silently lift an existing idle pause');
      } finally {
        await disposeCompositionGraph(successful.graph);
      }

      stamp = 0;
      const failed = createCompositionGraph({ now: () => stamp, pairingOpen: async () => ({ ok: false, code: 'TUNNEL_NOT_READY' }) });
      try {
        assert((await failed.graph.controller.enable({ confirmed: true, startContext: COMPOSITION_START_CONTEXT })).success, 'failed-pairing fixture must be live first');
        stamp = 59_000;
        const pairing = await failed.graph.openPairing({ parentWindow: failed.parent });
        assert(!pairing.ok, 'a failed pairing attempt must remain a failed native action');
        stamp = 60_000;
        await failed.graph.controller.tick();
        assert(failed.graph.controller.snapshot().paused && failed.graph.controller.snapshot().pauseCause === 'idle',
          'a failed pairing attempt must not refresh the human-action deadline');
      } finally {
        await disposeCompositionGraph(failed.graph);
      }
    },
  },
  {
    name: 'handoff bridge: inert: B6 composition rejects an overlong shared socket path before any port is constructed',
    run: () => {
      const userData = `/tmp/${'x'.repeat(150)}`;
      let thrown = null;
      try { composeHandoffBridge({ userData, config: READY_CONFIG, tunnelState: READY_SETUP, deps: { getCanvasWindows: () => [] } }); } catch (error) { thrown = error; }
      assert(thrown?.code === 'path_too_long', 'a socket path over 100 bytes must fail before listener/tunnel construction and never fall back to TCP');
    },
  },
  {
    name: 'handoff bridge: inert: no exported reset hook remains outside the specified pairing hook',
    run: () => {
      const source = fs.readFileSync(indexUrl, 'utf8');
      assert(!source.includes('__resetHandoffBridgeForTests'), 'production bridge code must not retain a test reset hook');
      assert(source.includes('__icHandoffBridgeTest'), 'the specified pairing hook remains the only test-only global');
    },
  },
  {
    name: 'handoff bridge: inert: closed OAuth and HTTP audit mapper keeps only exact enumerated facts',
    async run() {
      const rawRoute = '/oauth/token?payload=route-secret';
      const rawIp = '203.0.113.199';
      const rawOrigin = 'https://origin.secret.example:8443/path?payload=origin-secret';
      const rawPayload = 'payload-secret';
      const rawClient = 'client-secret';
      const rawLink = 'link-secret';
      const poison = {
        route: rawRoute,
        ip: rawIp,
        origin: rawOrigin,
        payload: rawPayload,
        client: rawClient,
        linkId: rawLink,
        clientKind: 'cimd',
      };
      const seen = [];
      const audit = { append: (event, fields, stamp) => { seen.push({ event, fields, stamp }); return Promise.resolve(true); } };
      const cases = [
        ['link_created', {}, 'link_created', { kind: 'cimd' }],
        ['link_replaced', {}, 'link_replaced', { kind: 'cimd' }],
        ['link_revoked', {}, 'link_revoked', { kind: 'cimd' }],
        ['refresh_reuse', {}, 'refresh_reuse', { kind: 'cimd' }],
        ['code_reuse', {}, 'code_reuse', { kind: 'cimd' }],
        ['refresh_expired', {}, 'link_revoked', { kind: 'cimd', reason: 'refresh_expired' }],
        ['token_revoked_by_client', {}, 'link_revoked', { kind: 'cimd', reason: 'client' }],
        ['source_mismatch', { route: 'oauth/token', statusClass: '2xx' }, 'source_mismatch', { route: 'token', statusClass: '2xx' }],
        ['permit_leak', { pool: 'mcp_auth' }, 'permit_leak', { kind: 'mcp_auth' }],
        ['origin_seen', { route: 'oauth/revoke', secFetchSite: 'SAME-SITE' }, 'origin_seen', { route: 'revoke', source: 'other', kind: 'same-site' }],
        ['rate_lru_aggregate_only', {}, 'anonymous_summary', { kind: 'rate_lru', count: 1 }],
      ];
      for (const [index, [event, extra, mappedEvent, fields]] of cases.entries()) {
        const stamp = 4_000 + index;
        assert(appendClosedHandoffAudit(audit, event, { ...poison, ...extra }, stamp), `${event} must be accepted by the closed mapper`);
        assert(JSON.stringify(seen.at(-1)) === JSON.stringify({ event: mappedEvent, fields, stamp }), `${event} must project exactly its closed field set`);
      }
      const rawStamp = 4_100;
      assert(appendClosedHandoffAudit(audit, 'source_mismatch', { ...poison, statusClass: 'not-a-status' }, rawStamp), 'a supported event with hostile values remains a closed projection');
      assert(JSON.stringify(seen.at(-1)) === JSON.stringify({ event: 'source_mismatch', fields: { route: 'other', statusClass: '4xx' }, stamp: rawStamp }), 'unknown route and status values collapse to their closed enums');
      const beforeUnknown = seen.length;
      assert(!appendClosedHandoffAudit(audit, 'future_transport_event', poison, 4_101) && seen.length === beforeUnknown, 'unknown transport events must neither append nor widen the vocabulary');
      const rejected = appendClosedHandoffAudit({ append: () => Promise.reject(new Error('expected audit rejection')) }, 'link_created', poison, 4_102);
      assert(rejected, 'a rejected asynchronous audit append remains best-effort');
      await new Promise(resolve => setImmediate(resolve));
      const serialized = JSON.stringify(seen);
      for (const secret of [rawRoute, rawIp, rawOrigin, rawPayload, rawClient, rawLink]) {
        assert(!serialized.includes(secret), 'raw transport route, IP, origin, payload, client, and link facts must never cross into audit');
      }
    },
  },
  {
    name: 'handoff bridge: inert: composition restores restart-normalized lanes through loadLanes only',
    async run() {
      const stamp = 987_654;
      let loadStamp = null;
      let rawReads = 0;
      const restored = [
        { ord: 1, jobId: '550e8400-e29b-41d4-a716-446655440000', canvasFilePath: '/tmp/restart.canvas', releasedAt: 1, phase: 'held', reason: 'restart', heldFrom: 'awaiting', counters: {} },
        { ord: 2, jobId: '660e8400-e29b-41d4-a716-446655440000', canvasFilePath: '/tmp/held.canvas', releasedAt: 2, phase: 'held', reason: 'user_hold', heldFrom: 'awaiting', counters: {} },
        { ord: 3, jobId: '770e8400-e29b-41d4-a716-446655440000', canvasFilePath: '/tmp/review.canvas', releasedAt: 3, phase: 'needs_user', reason: 'job_broken', heldFrom: 'awaiting', counters: {} },
      ];
      const application = {
        read: async () => ({ kind: 'done' }), status: async () => ({ kind: 'done' }), submit: async () => ({ kind: 'done' }), describeForConfirm: async () => ({ items: [] }),
      };
      const push = { status: () => ({}), get: async () => ({ kind: 'done' }), submit: async () => ({ kind: 'done' }) };
      let graph;
      try {
        graph = composeHandoffBridge({
          userData: '/tmp/ic-normalized-lanes',
          config: { ...READY_CONFIG, limits: {}, prefs: { sourcePolicy: 'enforce' }, scope: { applications: true, scoring: false } },
          tunnelState: READY_SETUP,
          deps: {
            now: () => stamp,
            laneStore: {
              loadLanes: value => { loadStamp = value; return restored; },
              readLanes: () => { rawReads += 1; throw new Error('raw lanes must not compose an engine'); },
            },
            audit: { append: () => Promise.resolve(true), flush: () => Promise.resolve(true) },
            application,
            push,
            listener: { status: () => ({}), start: async () => undefined, stop: async () => undefined },
            tunnel: { status: () => ({}), start: async () => undefined, stop: async () => undefined },
            dialogs: {},
            getCanvasWindows: () => [],
          },
        });
        const jobs = graph.engine.snapshot().queue.jobs.map(job => ({ jobId: job.jobId, phase: job.phase, reason: job.reason }));
        assert(loadStamp === stamp && rawReads === 0, 'engine composition must call laneStore.loadLanes(now), never raw readLanes');
        assert(JSON.stringify(jobs) === JSON.stringify([
          { jobId: restored[0].jobId, phase: 'held', reason: 'restart' },
          { jobId: restored[1].jobId, phase: 'held', reason: 'user_hold' },
          { jobId: restored[2].jobId, phase: 'needs_user', reason: 'job_broken' },
        ]), 'restart-normalized work holds for confirmation while original held and needs-user reasons survive');
      } finally {
        await graph?.engine?.close?.();
        graph?.power?.dispose?.();
        graph?.tray?.destroy?.();
      }
    },
  },
  {
    name: 'handoff bridge: inert: real OAuth renewal reconnect composition publishes status only once per minute',
    async run() {
      let now = 10_000_000;
      const hostname = READY_CONFIG.hostname;
      const issuer = `https://${hostname}`;
      const clientId = 'https://chatgpt.com/oauth/client.json';
      const familyId = 'reconnect-family';
      const refresh = 'reconnect-refresh-token';
      const callbacks = [];
      const audit = [];
      const logs = [];
      let sheets = 0;
      let notices = 0;
      const state = {
        v: 1,
        issuer,
        clients: [{
          id: clientId, clientKind: 'cimd', clientHost: 'chatgpt.com', name: 'ChatGPT',
          redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
          grantTypes: ['authorization_code', 'refresh_token'], authMethods: ['none'], jwksUri: null, metadataHash: 'fixture',
        }],
        codes: [],
        families: [{
          id: familyId, clientId, clientKind: 'cimd', requested: [], createdAt: now - 1_000, lastRefreshedAt: now - 1_000,
          idleExpiresAt: now - 1, absoluteExpiresAt: now + CONSTANTS.REFRESH_ABSOLUTE_MS,
          sourcePrefix: '203.0.113.0/24', renewalCause: null, renewalAt: null, revoked: false, revokedAt: 0,
        }],
        refresh: [{ hash: createHash('sha256').update(refresh).digest('hex'), familyId, supersededAt: null, successor: null, grace: null }],
        access: [],
      };
      const timers = {
        setTimeout: fn => { callbacks.push(fn); return fn; },
        clearTimeout: value => { const index = callbacks.indexOf(value); if (index >= 0) callbacks.splice(index, 1); },
        setInterval: () => null,
        clearInterval: () => undefined,
      };
      const application = {
        read: async () => ({ kind: 'done' }), status: async () => ({ kind: 'done' }), submit: async () => ({ kind: 'done' }), describeForConfirm: async () => ({ items: [] }),
      };
      const push = { status: () => ({}), get: async () => ({ kind: 'done' }), submit: async () => ({ kind: 'done' }) };
      const response = () => ({
        headersSent: false,
        writableEnded: false,
        setHeader() {},
        writeHead(status) { this.status = status; this.headersSent = true; },
        end(text = '') { this.text = String(text); this.writableEnded = true; },
      });
      const callClosedAuthorize = async source => {
        const res = response();
        await graph.oauth.handle({ method: 'GET', url: '/oauth/authorize', headers: {} }, res, '/oauth/authorize', {
          source,
          rateFailure: () => false,
          observeAuthenticatedServerRoute: () => undefined,
        });
        return res;
      };
      const flushStatus = () => { while (callbacks.length) callbacks.shift()(); };
      let graph;
      try {
        graph = composeHandoffBridge({
          userData: '/tmp/ic-reconnect-composition',
          config: { ...READY_CONFIG, limits: {}, prefs: { sourcePolicy: 'enforce', pairingNetworkCheck: true }, scope: { applications: true, scoring: false } },
          tunnelState: READY_SETUP,
          deps: {
            now: () => now,
            timers,
            oauthStore: { read: () => state, commit: () => true, flush: () => true },
            audit: { append: (...entry) => { audit.push(entry); return Promise.resolve(true); }, flush: () => Promise.resolve(true) },
            log: { record: (...entry) => logs.push(entry) },
            application,
            push,
            listener: { status: () => ({}), start: async () => undefined, stop: async () => undefined },
            tunnel: { status: () => ({}), start: async () => undefined, stop: async () => undefined },
            dialogs: { showCode: async () => { sheets += 1; }, showNotice: async () => { notices += 1; }, ask: async () => ({ ok: true }) },
            getCanvasWindows: () => [],
          },
        });
        const refreshBody = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId, resource: `${issuer}/mcp` }).toString();
        const refreshRequest = Readable.from([Buffer.from(refreshBody)]);
        refreshRequest.method = 'POST';
        refreshRequest.url = '/oauth/token';
        refreshRequest.headers = { 'content-type': 'application/x-www-form-urlencoded' };
        refreshRequest.complete = true;
        const refreshResponse = response();
        await graph.oauth.handle(refreshRequest, refreshResponse, '/oauth/token', {
          source: '203.0.113.44',
          sourcePrefix: '203.0.113.0/24',
          rateFailure: () => false,
          observeAuthenticatedServerRoute: () => undefined,
        });
        assert(refreshResponse.status === 400 && graph.oauth.linkStatus()[0]?.state === 'needs-renewal', 'a real expired refresh must create the OAuth renewal marker before any hint');
        const proof = graph.pairing.probeAuthenticator.issue();
        assert(graph.pairing.recordOwnEgress({ header: proof.header, address: '203.0.113.44' }), 'a verified public probe records the local egress family');
        const auditBeforeAnonymous = audit.length;
        const logBeforeAnonymous = logs.length;
        let statusPublishes = 0;
        graph.controller.subscribe(() => { statusPublishes += 1; });
        assert((await callClosedAuthorize('203.0.113.45')).status === 403 && statusPublishes === 0, 'a wrong own-egress family cannot publish a reconnect hint');
        now += CONSTANTS.OWN_EGRESS_TTL_MS + 1;
        assert((await callClosedAuthorize('203.0.113.44')).status === 403 && statusPublishes === 0, 'a stale own-egress observation cannot publish a reconnect hint');
        const renewedProof = graph.pairing.probeAuthenticator.issue();
        assert(graph.pairing.recordOwnEgress({ header: renewedProof.header, address: '203.0.113.44' }), 'a fresh verified egress observation restores the local-only gate');
        assert((await callClosedAuthorize('203.0.113.44')).status === 403 && callbacks.length === 1, 'a real renewal from fresh own egress queues one status-only hint');
        flushStatus();
        assert(statusPublishes === 1, 'the qualified reconnect request publishes status exactly once');
        await callClosedAuthorize('203.0.113.44');
        now += 59_999;
        await callClosedAuthorize('203.0.113.44');
        assert(callbacks.length === 0 && statusPublishes === 1, 'repeat reconnect requests remain inert for the first 60 seconds');
        now += 1;
        await callClosedAuthorize('203.0.113.44');
        flushStatus();
        assert(statusPublishes === 2, 'the next qualified reconnect hint is allowed exactly at the next one-minute window');
        assert(sheets === 0 && notices === 0 && audit.length === auditBeforeAnonymous && logs.length === logBeforeAnonymous,
          'closed authorize reconnect hints never open a sheet or notice, or append audit or application log entries');
      } finally {
        await graph?.engine?.close?.();
        graph?.power?.dispose?.();
        graph?.tray?.destroy?.();
      }
    },
  },
  {
    name: 'handoff bridge: inert: off bootstrap is lazy, closed, secret-free and broadcasts without composing',
    async run() {
      await stopHandoffBridge();
      const ipc = bridgeIpc(); const canvas = liveCanvas();
      let configReads = 0; let tunnelReads = 0; let sideEffects = 0;
      const pin = 'a'.repeat(64);
      const config = {
        ...READY_CONFIG, pluginName: 'Safe Plugin', autoStart: true, autoRelease: true,
        scope: { applications: false, scoring: true }, limits: { idlePauseMinutes: 12 },
        prefs: { sourcePolicy: 'alert', pairingNetworkCheck: false }, telemetryInBugReports: true,
      };
      assert(registerHandoffBridgeHandlers({ ipcMain: ipc, deps: {
        isPackaged: true, userData: '/tmp/bridge-bootstrap-state', getCanvasWindows: () => [canvas],
        readConfig: () => { configReads += 1; return { state: 'ok', config }; },
        readTunnelState: () => { tunnelReads += 1; return { binaryPath: '/private/secret/binary', credentialsPath: '/private/secret/credentials.json', pin, approvedAt: 1, tunnelId: 'tunnel-secret' }; },
        writeConfig: () => { sideEffects += 1; }, bind: () => { sideEffects += 1; }, spawn: () => { sideEffects += 1; }, timers: { setTimeout: () => { sideEffects += 1; } },
      } }), 'bootstrap registration installs the global UI ports');
      assert(configReads === 0 && tunnelReads === 0 && sideEffects === 0, 'registration is read/write/process/timer inert');
      const result = await ipc.handlers.get(IPC_CHANNELS.GET_STATUS)({ sender: canvas.webContents });
      const status = result.status; const wire = JSON.stringify(status);
      assert(result.success && status.enabled === false && status.serving === 'off' && status.autoStart && status.autoRelease, 'off status projects durable config without enabling a graph');
      assert(status.config.hostname === READY_CONFIG.hostname && status.config.pluginName === 'Safe Plugin' && status.config.mcpUrl?.endsWith('/mcp') && status.setup.hostnameOk && status.setup.binaryApproved && status.setup.credentialsOk, 'bootstrap preserves only allowed setup/config facts');
      assert(!wire.includes('/private/secret') && !wire.includes(pin) && !wire.includes('tunnel-secret'), 'bootstrap status never projects paths, pins, ids or arbitrary setup data');
      assert(configReads === 1 && tunnelReads === 1 && sideEffects === 0, 'only the status read touches injected state and it creates no platform owner');
      await stopHandoffBridge();
      const broadcast = canvas.sent.find(entry => entry.channel === IPC_EVENTS.STATUS)?.value;
      assert(broadcast?.enabled === false && broadcast?.serving === 'off' && !JSON.stringify(broadcast).includes('/private/secret'), 'off broadcasts use the same closed bootstrap projection');
    },
  },
  {
    name: 'handoff bridge: inert: disable detaches every owner and the next enable composes a fresh graph',
    async run() {
      await stopHandoffBridge();
      const calls = []; const graphs = [];
      const compose = () => {
        const id = graphs.length + 1;
        const graph = {
          controller: {
            snapshot: () => liveStatus(), subscribe: () => () => calls.push(`controller-unsubscribe-${id}`),
            enable: async () => { calls.push(`enable-${id}`); return { success: true }; },
            disable: async () => { calls.push(`disable-${id}`); return { success: true }; },
          },
          unsubscribeUi: () => calls.push(`ui-unsubscribe-${id}`),
          power: { dispose: () => calls.push(`power-${id}`) }, tray: { destroy: () => calls.push(`tray-${id}`) },
          listener: { stop: () => calls.push(`listener-${id}`) }, tunnel: { dispose: () => calls.push(`tunnel-${id}`) },
          pairing: { cancel: () => calls.push(`pairing-${id}`) }, oauth: { closePairing: () => calls.push(`oauth-${id}`) },
          audit: { flush: () => calls.push(`audit-${id}`) }, engine: { close: () => calls.push(`engine-${id}`) },
        };
        graphs.push(graph); return graph;
      };
      const first = await startHandoffBridge({ deps: completeStartDeps({ compose, activate: true, confirmed: true }) });
      assert(first.success && graphs.length === 1, 'first explicit enable creates one graph');
      const stopped = await stopHandoffBridge();
      for (const owner of ['disable', 'ui-unsubscribe', 'power', 'tray', 'listener', 'tunnel', 'pairing', 'oauth', 'audit', 'engine']) assert(calls.some(value => value === `${owner}-1`), `disable disposes ${owner}`);
      assert(stopped.success && getHandoffBridgeStatus().enabled === false && getHandoffBridgeStatus().serving === 'off', 'hard-off detaches even while retaining global IPC registration');
      const second = await startHandoffBridge({ deps: completeStartDeps({ compose, activate: true, confirmed: true }) });
      assert(second.success && graphs.length === 2 && graphs[0] !== graphs[1], 'a later explicit enable composes a new graph rather than reusing disposed owners');
      await stopHandoffBridge();
    },
  },
  {
    name: 'handoff bridge: inert: exported quit stop uses graceful controller shutdown while renderer Disable remains hard and escalates it',
    async run() {
      await stopHandoffBridge();
      const calls = []; const graceful = deferred(); const canvas = liveCanvas(96); const ipc = bridgeIpc();
      const compose = () => ({
        controller: {
          snapshot: () => liveStatus(), subscribe: () => () => undefined,
          enable: async () => ({ success: true }),
          shutdownForQuit: async () => { calls.push('graceful'); return graceful.promise; },
          disable: async () => { calls.push('hard'); return { success: true }; },
        },
        listener: {}, tunnel: {}, power: {}, tray: {},
      });
      assert((await startHandoffBridge({ deps: completeStartDeps({ compose, activate: true, confirmed: true }) })).success,
        'fixture attaches the controllable runtime');
      assert(registerHandoffBridgeHandlers({ ipcMain: ipc, deps: { isPackaged: true, userData: SAFE_PATHS.userData, getCanvasWindows: () => [canvas] } }),
        'the local renderer bridge registration is available for the Disable selection');
      const stopping = stopHandoffBridge(); await Promise.resolve();
      assert(calls.join(',') === 'graceful', 'the exported app-quit helper selects shutdownForQuit instead of interactive Disable');
      const manual = ipc.handlers.get(IPC_CHANNELS.SET_ENABLED)({ sender: canvas.webContents }, { enabled: false });
      await Promise.resolve();
      assert(calls.join(',') === 'graceful,hard', 'a renderer Disable racing detached graceful shutdown escalates the same graph to its hard fence');
      graceful.resolve({ success: true });
      const [stopped, disabled] = await Promise.all([stopping, manual]);
      assert(stopped.success && disabled.success && calls.filter(value => value === 'graceful').length === 1 && calls.filter(value => value === 'hard').length === 1,
        'concurrent stop and Disable share one disposal while preserving the explicit hard escalation');
      await stopHandoffBridge();
    },
  },
  {
    name: 'handoff bridge: inert: stale start cannot revive after hard-off and duplicate enables share one live operation',
    async run() {
      await stopHandoffBridge();
      let releaseOld; const oldEnable = new Promise(resolve => { releaseOld = resolve; });
      let compositions = 0; let enables = 0;
      const compose = () => {
        const id = ++compositions;
        return {
          controller: {
            snapshot: () => liveStatus(), subscribe: () => () => undefined,
            enable: async () => { enables += 1; return id === 1 ? oldEnable : { success: true }; },
            disable: async () => ({ success: true }),
          },
          listener: {}, tunnel: {}, power: {}, tray: {},
        };
      };
      const old = startHandoffBridge({ deps: completeStartDeps({ compose, activate: true, confirmed: true }) });
      await Promise.resolve(); await Promise.resolve();
      const duplicate = startHandoffBridge({ deps: completeStartDeps({ compose, activate: true, confirmed: true }) });
      await Promise.resolve();
      assert(compositions === 1 && enables === 1, 'manual/auto duplicate starts route to the one attached controller operation');
      await stopHandoffBridge();
      const fresh = await startHandoffBridge({ deps: completeStartDeps({ compose, activate: true, confirmed: true }) });
      releaseOld({ success: true });
      const stale = await old; await duplicate;
      assert(fresh.success && stale.success === false && compositions === 2 && getHandoffBridgeStatus().enabled === true, 'a delayed old start is fenced and cannot replace the fresh graph');
      await stopHandoffBridge();
    },
  },
  {
    name: 'handoff bridge: inert: hostname and acknowledged setup mutations hard-invalidate the captured graph',
    async run() {
      await stopHandoffBridge();
      const ipc = bridgeIpc(); const canvas = liveCanvas(72); const nextHostname = 'c-0123456789abcdef0123.lullascape.com';
      let persisted = { ...READY_CONFIG, scope: { applications: true, scoring: false }, prefs: { sourcePolicy: 'enforce', pairingNetworkCheck: true } };
      let composed = 0; let disabled = 0; let reloads = 0;
      const setup = { ...READY_SETUP, pin: 'c'.repeat(64), approvedAt: 1 };
      const tunnelSetup = {
        getApprovalDetails: async () => ({ ok: true, version: '2026.9.3', sha256: 'c'.repeat(64) }),
        approveBinary: async () => ({ ok: true }), chooseCredentials: async () => ({ ok: true }), chooseBinary: async () => ({ ok: true }),
      };
      assert(registerHandoffBridgeHandlers({ ipcMain: ipc, deps: {
        isPackaged: true, userData: SAFE_PATHS.userData, getCanvasWindows: () => [canvas], tunnelSetup,
        dialogs: { ask: async () => ({ ok: true }), choose: async () => ({ ok: true, filePath: '/tmp/credentials.json' }) },
        readConfig: () => ({ state: 'ok', config: persisted }), readTunnelState: () => setup,
        writeConfig: async (_userData, patch) => { persisted = { ...persisted, ...patch, scope: { ...persisted.scope, ...(patch.scope || {}) }, prefs: { ...persisted.prefs, ...(patch.prefs || {}) } }; return { ok: true }; },
      } }), 'global UI ports register before the first graph');
      const compose = () => {
        composed += 1;
        return {
          controller: {
            snapshot: () => liveStatus(persisted.hostname), subscribe: () => () => undefined,
            enable: async () => ({ success: true }), disable: async () => { disabled += 1; return { success: true }; },
            reloadConfig: async () => { reloads += 1; return { success: true }; },
          }, listener: {}, tunnel: {}, power: {}, tray: {},
        };
      };
      assert((await startHandoffBridge({ deps: completeStartDeps({ compose, tunnelState: setup, readConfig: undefined, activate: true, confirmed: true }) })).success, 'the initial graph starts');
      const event = { sender: canvas.webContents };
      const saved = await ipc.handlers.get(IPC_CHANNELS.SAVE_CONFIG)(event, { patch: { hostname: nextHostname } });
      assert(saved.success && disabled === 1 && reloads === 0 && getHandoffBridgeStatus().enabled === false && getHandoffBridgeStatus().config.hostname === nextHostname, 'hostname save detaches first and reloads only the fresh bootstrap state');
      assert((await startHandoffBridge({ deps: completeStartDeps({ compose, tunnelState: setup, readConfig: undefined, activate: true, confirmed: true }) })).success, 'a later explicit enable creates the post-hostname graph');
      assert((await ipc.handlers.get(IPC_CHANNELS.APPROVE_BINARY)(event)).success && disabled === 2 && getHandoffBridgeStatus().enabled === false, 'acknowledged approval invalidates the graph it would otherwise stale-capture');
      assert((await startHandoffBridge({ deps: completeStartDeps({ compose, tunnelState: setup, readConfig: undefined, activate: true, confirmed: true }) })).success, 'approval requires a later explicit fresh enable');
      assert((await ipc.handlers.get(IPC_CHANNELS.CHOOSE_CREDENTIALS)(event)).success && disabled === 3 && getHandoffBridgeStatus().enabled === false && composed === 3, 'acknowledged credentials also detach and never auto-restart');
      await stopHandoffBridge();
    },
  },
  {
    name: 'handoff bridge: inert: tunnel state never shadows an injected supervisor and power owns one resume probe',
    run: () => {
      const listeners = new Map(); let probes = 0; let fences = 0;
      const monitor = {
        on(event, fn) { const values = listeners.get(event) || []; values.push(fn); listeners.set(event, values); },
        removeListener(event, fn) { listeners.set(event, (listeners.get(event) || []).filter(value => value !== fn)); },
      };
      const supervisor = { status: () => ({ state: 'online' }), probe: () => { probes += 1; }, stop() {}, start() {} };
      const graph = composeHandoffBridge({
        userData: SAFE_PATHS.userData,
        config: { ...READY_CONFIG, limits: {}, prefs: {}, scope: { applications: true, scoring: false } },
        tunnelState: { ...READY_SETUP, pin: 'b'.repeat(64), approvedAt: 1 },
        deps: {
          tunnel: supervisor, powerMonitor: monitor, getCanvasWindows: () => [],
          audit: {}, laneStore: { read: () => ({ lanes: [] }) }, application: {}, push: {}, oauth: { authenticate() {}, linkStatus: () => [], closePairing() {} },
          engine: { onPowerResume: () => { fences += 1; }, powerState: () => ({}) }, listener: {}, requestHandler: () => undefined,
          controller: { snapshot: () => liveStatus(), subscribe: () => () => undefined }, pairing: { status: () => ({}), cancel() {} }, dialogs: {}, tray: {},
        },
      });
      assert(graph.tunnel.status().state === 'online', 'persisted tunnel state is not mistaken for the injected live supervisor');
      assert((listeners.get('resume') || []).length === 1, 'composition installs exactly one platform resume listener');
      listeners.get('resume')[0]();
      assert(probes === 1 && fences === 1, 'the one resume callback fences engine work and asks the composed supervisor for one probe');
      graph.power.dispose();
      assert((listeners.get('resume') || []).length === 0, 'hard disposal removes the sole resume listener');
    },
  },
  {
    name: 'handoff bridge: inert: setup selections persist partial state, roll back on durable failure, and survive a fresh session',
    async run() {
      const originalLock = electronPkg.app.requestSingleInstanceLock;
      electronPkg.app.requestSingleInstanceLock = () => false;
      let createSetup;
      try {
        const mainUrl = new URL('../../electron/main.js', import.meta.url);
        mainUrl.search = `?handoff-bridge-setup-test=${Date.now()}`;
        ({ createHandoffBridgeTunnelSetup: createSetup } = await import(mainUrl.href));
      } finally {
        if (originalLock === undefined) delete electronPkg.app.requestSingleInstanceLock;
        else electronPkg.app.requestSingleInstanceLock = originalLock;
      }
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-b6-setup-'));
      const source = path.join(root, 'source-cloudflared');
      const copy = path.join(root, 'handoff-bridge', 'tunnel', 'bin', 'cloudflared-deadbeef');
      const credentials = path.join(root, 'credentials-a.json');
      const replacementCredentials = path.join(root, 'credentials-b.json');
      const pin = 'a'.repeat(64); const stamp = 1_234_567;
      let disk = null; let failWrite = false; const writes = []; const sessions = [];
      const normalize = candidate => {
        const stored = { v: 1 };
        if (typeof candidate?.binaryPath === 'string') {
          stored.binaryPath = candidate.binaryPath;
          stored.pin = candidate.pin;
          stored.approvedAt = Number.isFinite(candidate.approvedAt) ? candidate.approvedAt : null;
        }
        if (typeof candidate?.credentialsPath === 'string') stored.credentialsPath = candidate.credentialsPath;
        stored.binaryTrusted = Boolean(stored.binaryPath && Number.isFinite(stored.approvedAt));
        return Object.freeze(stored);
      };
      const deps = {
        readTunnelStateImpl: () => disk,
        writeTunnelStateImpl: async (_userData, candidate) => {
          writes.push({ ...candidate });
          if (failWrite) throw new Error('durable write failed');
          disk = normalize(candidate);
          return disk;
        },
        prepareBinaryImpl: async () => ({ ok: true, copyPath: copy, sha256: pin, version: '2026.9.3' }),
        inspectCredentialsImpl: value => ({ ok: true, credentialsPath: value, tunnelId: '550e8400-e29b-41d4-a716-446655440000', credentialsMode: '0600' }),
        statSync: () => ({ size: 42 }), codesignImpl: () => ({ verified: true, summary: 'ad-hoc signed' }), now: () => stamp,
      };
      try {
        const setup = createSetup(root, deps); sessions.push(setup);
        assert((await setup.chooseBinary(source)).ok && disk?.binaryPath === copy && disk?.approvedAt === null && !disk?.credentialsPath,
          'an accepted binary selection durably records only its unapproved copy and pin');
        failWrite = true;
        assert((await setup.chooseCredentials(credentials)).code === 'STATE_UNREADABLE',
          'a credentials selection reports the fixed durable-write failure');
        failWrite = false;
        assert((await setup.approveBinary()).ok && writes.at(-1).credentialsPath === undefined && disk?.approvedAt === stamp,
          'failed credential staging rolls back memory, so later approval cannot persist its stale path');
        assert((await setup.chooseCredentials(credentials)).ok && disk?.credentialsPath === credentials && disk?.binaryTrusted === true,
          'accepted credentials are persisted with the already-approved binary state');
        await setup.clearSession();
        const restarted = createSetup(root, deps); sessions.push(restarted);
        const details = await restarted.getApprovalDetails();
        assert(details.ok && details.sha256 === pin,
          'a fresh setup session rehydrates the durable partial schema rather than depending on old process memory');
        assert((await restarted.chooseCredentials(replacementCredentials)).ok
          && writes.at(-1).approvedAt === stamp && disk?.credentialsPath === replacementCredentials && disk?.binaryTrusted === true,
        'a restart derives trust and retained approval from the stored result while persisting a later credentials mutation');
      } finally {
        for (const setup of sessions) await setup.clearSession?.();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'handoff bridge: inert: background E2E cleanup invokes the bridge stop callback once and leaves no live owner on repeats',
    async run() {
      await stopHandoffBridge();
      const live = { listener: true, tunnel: true, platform: true, engine: true };
      let gracefulStops = 0; let hardStops = 0; let callbackCalls = 0;
      const graph = {
        controller: {
          snapshot: () => live.listener || live.tunnel || live.platform || live.engine
            ? liveStatus()
            : { ...liveStatus(), enabled: false, serving: 'off', paused: false, pauseCause: null },
          subscribe: () => () => undefined,
          async enable() { return { success: true }; },
          async shutdownForQuit() { gracefulStops += 1; live.listener = false; live.tunnel = false; live.engine = false; return { success: true }; },
          async disable() { hardStops += 1; live.listener = false; live.tunnel = false; live.engine = false; return { success: true }; },
        },
        listener: { stop() { live.listener = false; } },
        tunnel: { dispose() { live.tunnel = false; } },
        engine: { close() { live.engine = false; } },
        power: { dispose() { live.platform = false; } },
        tray: { destroy() {} },
      };
      const started = await startHandoffBridge({ deps: completeStartDeps({ compose: () => graph, activate: true, confirmed: true }) });
      assert(started.success, 'the background cleanup fixture must attach one live bridge graph');
      const baseClosers = {
        closeAllAuthWindows: async () => undefined,
        closeAllPages: async () => undefined,
        closeStealthBrowser: async () => undefined,
        stopApplicationSyncServer: async () => undefined,
      };
      const stop = async () => { callbackCalls += 1; return stopHandoffBridge(); };
      try {
        const first = await runBackgroundE2EShutdownCleanup({ ...baseClosers, stopHandoffBridge: stop, timeoutMs: 100 });
        assert(!first.timedOut && callbackCalls === 1 && gracefulStops === 1 && hardStops === 0,
          'background cleanup must call the app-quit bridge stop path, not the renderer hard-disable path');
        assert(!live.listener && !live.tunnel && !live.platform && !live.engine && getHandoffBridgeStatus().serving === 'off',
          'background cleanup leaves no listener, tunnel, platform owner, engine, or live bridge status');
        const second = await runBackgroundE2EShutdownCleanup({ ...baseClosers, stopHandoffBridge: stop, timeoutMs: 100 });
        assert(!second.timedOut && callbackCalls === 2 && gracefulStops === 1 && hardStops === 0
          && !live.listener && !live.tunnel && !live.platform && !live.engine,
        'a re-entered background cleanup invokes an idempotent stop and cannot revive a detached resource');
        const main = fs.readFileSync(new URL('../../electron/main.js', import.meta.url), 'utf8');
        assert(/runBackgroundE2EShutdownCleanup\(\{[\s\S]*?stopApplicationSyncServer,\s*stopHandoffBridge,/.test(main),
          'the background-E2E production call must pass the optional bridge stop callback after sync-server cleanup');
      } finally {
        await stopHandoffBridge();
      }
    },
  },
];
