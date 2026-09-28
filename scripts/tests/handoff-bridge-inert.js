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
import { readTunnelState } from '../../electron/ipc/handoffBridge/tunnel/files.js';
import { clearFailedStartDiagnostic, getFailedStartDiagnostic, recordFailedStartDiagnostic } from '../../electron/ipc/handoffBridge/telemetry.js';
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

function bridgeClock(start = 0) {
  let stamp = start;
  const tasks = [];
  const timers = {
    setTimeout(fn, delay = 0) {
      const task = { at: stamp + Math.max(0, Number(delay) || 0), fn, active: true };
      tasks.push(task);
      return { task, unref() {} };
    },
    clearTimeout(handle) { if (handle?.task) handle.task.active = false; },
  };
  const advance = target => {
    stamp = target;
    for (;;) {
      const task = tasks.filter(item => item.active && item.at <= stamp).sort((left, right) => left.at - right.at)[0];
      if (!task) break;
      task.active = false;
      task.fn();
    }
  };
  return { now: () => stamp, timers, advance };
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
    name: 'handoff bridge: inert: a failed composed enable retains its closed receipt after runtime detach',
    async run() {
      await stopHandoffBridge(); clearFailedStartDiagnostic();
      const graph = {
        config: { telemetryInBugReports: true },
        controller: {
          snapshot: () => ({ enabled: false, serving: 'error', paused: false, pauseCause: null, config: { telemetryInBugReports: true } }), subscribe: () => () => undefined,
          enable: async () => ({ success: false, code: 'tunnel_failed', diagnostic: { phase: 'tunnel-start', cause: 'config-rejected', tunnel: { state: 'failed', lastExit: 'config-rejected', probe: { state: 'failing', reason: 'timeout', consecutiveFailures: 2 } }, startedAt: 10 } }),
          disable: async () => ({ success: true }),
        },
        listener: { stop() {} }, tunnel: { status: () => ({ state: 'failed', lastExit: 'config-rejected' }), dispose() {} },
        power: { dispose() {} }, tray: { destroy() {} }, pairing: { cancel() {} }, oauth: { closePairing() {} }, audit: { flush() {} }, engine: { close() {} },
      };
      try {
        const result = await startHandoffBridge({ deps: completeStartDeps({ compose: () => graph, activate: true, confirmed: true }) });
        const retained = getFailedStartDiagnostic();
        assert(result.success === false && retained?.telemetry === true && retained.phase === 'tunnel-start'
          && retained.cause === 'config-rejected' && retained.tunnel.lastExit === 'config-rejected' && retained.tunnel.probe.reason === 'timeout',
        'a failed runtime must detach without discarding its closed supervisor-start receipt');
      } finally { clearFailedStartDiagnostic(); await stopHandoffBridge(); }
    },
  },
  {
    name: 'handoff bridge: inert: an already-attached controller retains a failed-enable receipt',
    async run() {
      await stopHandoffBridge(); clearFailedStartDiagnostic();
      const graph = {
        config: { telemetryInBugReports: true },
        controller: {
          snapshot: () => ({ enabled: false, serving: 'error', paused: false, pauseCause: null, config: { telemetryInBugReports: true } }), subscribe: () => () => undefined,
          enable: async () => ({ success: false, code: 'tunnel_failed', diagnostic: { phase: 'tunnel-start', cause: 'config-rejected', tunnel: { state: 'failed', lastExit: 'config-rejected' }, startedAt: 10 } }),
          disable: async () => ({ success: true }),
        },
        listener: { stop() {} }, tunnel: { status: () => ({ state: 'failed', lastExit: 'config-rejected' }), dispose() {} },
        power: { dispose() {} }, tray: { destroy() {} }, pairing: { cancel() {} }, oauth: { closePairing() {} }, audit: { flush() {} }, engine: { close() {} },
      };
      try {
        const deps = completeStartDeps({ compose: () => graph });
        assert((await startHandoffBridge({ deps })).success, 'the inert attached graph must be available before its first explicit Enable');
        const result = await startHandoffBridge({ deps: { ...deps, activate: true, confirmed: true } });
        const retained = getFailedStartDiagnostic();
        assert(result.success === false && retained?.telemetry === true && retained.phase === 'tunnel-start' && retained.cause === 'config-rejected',
          'an attached-controller Enable failure must preserve its fixed receipt instead of bypassing the diagnostic sink');
      } finally { clearFailedStartDiagnostic(); await stopHandoffBridge(); }
    },
  },
  {
    name: 'handoff bridge: inert: failed-start telemetry uses the controller\'s current preference, never a stale graph config',
    async run() {
      await stopHandoffBridge(); clearFailedStartDiagnostic();
      const failed = telemetryInBugReports => ({
        success: false, code: 'tunnel_failed',
        status: { enabled: false, serving: 'error', config: { telemetryInBugReports } },
        diagnostic: { phase: 'tunnel-start', cause: 'config-rejected', tunnel: { state: 'failed', lastExit: 'config-rejected' }, startedAt: 10, at: 11 },
      });
      const graph = staleTelemetry => ({
        // This is the captured composition input. It intentionally disagrees
        // with the result status, as it can after controller.reloadConfig().
        config: { telemetryInBugReports: staleTelemetry },
        controller: {
          snapshot: () => ({ enabled: false, serving: 'error', paused: false, pauseCause: null, config: { telemetryInBugReports: staleTelemetry } }),
          subscribe: () => () => undefined,
          enable: async () => failed(!staleTelemetry), disable: async () => ({ success: true }),
        },
        listener: { stop() {} }, tunnel: { status: () => ({ state: 'failed', lastExit: 'config-rejected' }), dispose() {} },
        power: { dispose() {} }, tray: { destroy() {} }, pairing: { cancel() {} }, oauth: { closePairing() {} }, audit: { flush() {} }, engine: { close() {} },
      });
      try {
        // A stale opt-in must not record after the active controller's opt-out.
        let result = await startHandoffBridge({ deps: completeStartDeps({ compose: () => graph(true), activate: true, confirmed: true }) });
        assert(result.code === 'tunnel_failed' && getFailedStartDiagnostic() === null,
          'an authoritative opt-out in the failed result suppresses a stale composition opt-in');
        await stopHandoffBridge(); clearFailedStartDiagnostic();

        // Conversely, an opt-in adopted by reloadConfig must be honored even
        // when the original graph was composed while telemetry was off.
        result = await startHandoffBridge({ deps: completeStartDeps({ compose: () => graph(false), activate: true, confirmed: true }) });
        assert(result.code === 'tunnel_failed' && getFailedStartDiagnostic()?.telemetry === true,
          'an authoritative opt-in in the failed result records the closed receipt despite a stale composition opt-out');
        await stopHandoffBridge(); clearFailedStartDiagnostic();

        const hostileResult = failed(true);
        Object.defineProperty(hostileResult.status, 'config', { get: () => { throw new Error('unreadable preference'); } });
        result = await startHandoffBridge({ deps: completeStartDeps({ compose: () => ({
          ...graph(true), controller: { ...graph(true).controller, enable: async () => hostileResult },
        }), activate: true, confirmed: true }) });
        assert(result.code === 'tunnel_failed' && getFailedStartDiagnostic() === null,
          'an unreadable current preference fails closed instead of retaining optional telemetry');
      } finally { clearFailedStartDiagnostic(); await stopHandoffBridge(); }
    },
  },
  {
    name: 'handoff bridge: inert: a cancelled attached enable leaves no failed-start receipt',
    async run() {
      await stopHandoffBridge(); clearFailedStartDiagnostic();
      const graph = {
        config: { telemetryInBugReports: true },
        controller: {
          snapshot: () => ({ enabled: false, serving: 'off', paused: false, pauseCause: null }), subscribe: () => () => undefined,
          enable: async () => ({ success: false, code: 'CANCELLED' }), disable: async () => ({ success: true }),
        },
        listener: { stop() {} }, tunnel: { status: () => ({ state: 'off' }), dispose() {} },
        power: { dispose() {} }, tray: { destroy() {} }, pairing: { cancel() {} }, oauth: { closePairing() {} }, audit: { flush() {} }, engine: { close() {} },
      };
      try {
        const deps = completeStartDeps({ compose: () => graph });
        assert((await startHandoffBridge({ deps })).success, 'the cancellation fixture must attach before explicit Enable');
        const result = await startHandoffBridge({ deps: { ...deps, activate: true, confirmed: true } });
        assert(result.code === 'CANCELLED' && getFailedStartDiagnostic() === null,
          'a declined/cancelled Enable is not a bridge failure and must not create a report receipt');
      } finally { clearFailedStartDiagnostic(); await stopHandoffBridge(); }
    },
  },
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
    name: 'handoff bridge: inert: explicit main packaging state wins over an ambient Electron fallback',
    async run() {
      await stopHandoffBridge();
      let compositions = 0;
      const graph = () => ({
        controller: {
          snapshot: () => ({ enabled: false, serving: 'off', paused: false, pauseCause: null, config: { telemetryInBugReports: true } }),
          disable: async () => ({ success: true }),
        },
        listener: {}, tunnel: {}, power: { dispose() {} }, tray: { destroy() {} },
      });
      try {
        const packaged = await startHandoffBridge({ deps: completeStartDeps({
          app: { isPackaged: false }, isPackaged: true,
          compose: () => { compositions += 1; return graph(); },
        }) });
        assert(packaged.success && compositions === 1,
          'the explicit packaged main dependency permits production composition even if an ambient fallback says dev');
        await stopHandoffBridge();
        const devBuild = await startHandoffBridge({ deps: completeStartDeps({
          app: { isPackaged: true }, isPackaged: false,
          compose: () => { compositions += 1; return graph(); },
        }) });
        assert(devBuild.code === 'unpackaged' && compositions === 1,
          'the explicit dev main dependency remains closed even if an ambient fallback says packaged');
      } finally { await stopHandoffBridge(); }
    },
  },
  {
    name: 'handoff bridge: inert: bootstrap status uses the explicit main packaging state before composition',
    async run() {
      await stopHandoffBridge();
      const canvas = liveCanvas(87);
      const base = {
        userData: SAFE_PATHS.userData,
        getCanvasWindows: () => [canvas],
        readConfig: () => ({ state: 'ok', config: READY_CONFIG }),
        readTunnelState: () => READY_SETUP,
      };
      const packagedIpc = bridgeIpc();
      try {
        assert(registerHandoffBridgeHandlers({ ipcMain: packagedIpc, deps: {
          ...base, app: { isPackaged: false }, isPackaged: true,
        } }), 'a complete fake IPC registry installs the bootstrap status route');
        const packaged = await packagedIpc.handlers.get(IPC_CHANNELS.GET_STATUS)({ sender: canvas.webContents });
        assert(packaged.success && packaged.status?.availability?.ok === true,
          'a packaged main context must not inherit an ambient development fallback before any graph is composed');

        const devIpc = bridgeIpc();
        assert(registerHandoffBridgeHandlers({ ipcMain: devIpc, deps: {
          ...base, app: { isPackaged: true }, isPackaged: false,
        } }), 'a replacement fake IPC registry installs its own bootstrap status route');
        const devBuild = await devIpc.handlers.get(IPC_CHANNELS.GET_STATUS)({ sender: canvas.webContents });
        assert(devBuild.success && devBuild.status?.availability?.ok === false && devBuild.status?.availability?.reason === 'dev-build',
          'an explicit development main context remains unavailable even when an ambient fallback claims packaged');
      } finally { await stopHandoffBridge(); }
    },
  },
  {
    name: 'handoff bridge: inert: explicit packaging state controls SET_ENABLED before a graph can compose',
    async run() {
      await stopHandoffBridge();
      const canvas = liveCanvas(88);
      let packagedCompositions = 0; let packagedEnables = 0; let enableOutcome = 'success';
      const graph = () => ({
        config: { telemetryInBugReports: true },
        controller: {
          snapshot: () => ({ enabled: false, serving: 'off', paused: false, pauseCause: null, config: { telemetryInBugReports: true } }),
          subscribe: () => () => undefined,
          enable: async () => {
            packagedEnables += 1;
            return enableOutcome === 'failure'
              ? { success: false, code: 'tunnel_failed', diagnostic: { phase: 'tunnel-start', cause: 'config-rejected', at: 123, startedAt: 100, tunnel: { state: 'failed', lastExit: 'config-rejected' } } }
              : { success: true };
          },
          disable: async () => ({ success: true }),
        },
        listener: {}, tunnel: {}, power: { dispose() {} }, tray: { destroy() {} },
      });
      const base = {
        userData: SAFE_PATHS.userData,
        getCanvasWindows: () => [canvas],
        readConfig: () => ({ state: 'ok', config: { ...READY_CONFIG, consentVersion: 1 } }),
        readTunnelState: () => READY_SETUP,
        dialogs: { ask: async () => ({ ok: true }) },
      };
      try {
        const packagedIpc = bridgeIpc();
        assert(registerHandoffBridgeHandlers({ ipcMain: packagedIpc, deps: {
          ...base, app: { isPackaged: false }, isPackaged: true,
          compose: () => { packagedCompositions += 1; return graph(); },
        } }), 'the packaged registration installs SET_ENABLED');
        const enabled = await packagedIpc.handlers.get(IPC_CHANNELS.SET_ENABLED)({ sender: canvas.webContents }, { enabled: true });
        assert(enabled.success && packagedCompositions === 1 && packagedEnables === 1,
          'explicit packaged state reaches the normal enable path despite an ambient development fallback');
        enableOutcome = 'failure';
        const failedRetry = await packagedIpc.handlers.get(IPC_CHANNELS.SET_ENABLED)({ sender: canvas.webContents }, { enabled: true });
        assert(failedRetry.success === false && getFailedStartDiagnostic()?.cause === 'config-rejected',
          'the active controller route retains the closed failure receipt rather than bypassing the runtime wrapper');
        enableOutcome = 'success';
        const successfulRetry = await packagedIpc.handlers.get(IPC_CHANNELS.SET_ENABLED)({ sender: canvas.webContents }, { enabled: true });
        assert(successfulRetry.success && getFailedStartDiagnostic() === null,
          'a successful attached retry clears the prior failed-start receipt before a later FULL report');
        await stopHandoffBridge();

        let devCompositions = 0;
        const devIpc = bridgeIpc();
        assert(registerHandoffBridgeHandlers({ ipcMain: devIpc, deps: {
          ...base, app: { isPackaged: true }, isPackaged: false,
          compose: () => { devCompositions += 1; return graph(); },
        } }), 'the development registration installs SET_ENABLED');
        const refused = await devIpc.handlers.get(IPC_CHANNELS.SET_ENABLED)({ sender: canvas.webContents }, { enabled: true });
        assert(refused.success === false && refused.code === 'UNAVAILABLE' && devCompositions === 0,
          'explicit development state refuses before consent or graph composition despite an ambient packaged fallback');
      } finally { await stopHandoffBridge(); }
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
      const ipc = { handlers: [], invokeHandlers: new Map(), handle(channel, handler) { this.handlers.push(channel); this.invokeHandlers.set(channel, handler); }, removeHandler(channel) { this.invokeHandlers.delete(channel); }, on(channel) { this.handlers.push(channel); }, removeListener() {}, __getInvokeHandler(channel) { return this.invokeHandlers.get(channel); } };
      const result = await startHandoffBridge({ deps: { env: {}, isPackaged: true, enabled: false, app: { getPath: () => { binds++; return '/not/read'; } }, readConfig: () => { writes++; return null; } } });
      assert(registerHandoffBridgeHandlers({ ipcMain: ipc, deps: { getCanvasWindows: () => [] } }), 'a complete inert fake IPC registry must register every bridge route');
      assert(result.code === 'not_enabled' && binds === 0 && writes === 0, 'off bridge must not bind, write or spawn');
      assert(ipc.handlers.length === 25, 'off equivalence permits exactly 24 invokes and publish-jobs');
      await stopHandoffBridge();
    },
  },
  {
    name: 'handoff bridge: inert: failed registration suppresses auto-start scheduling before any start can run',
    async run() {
      const originalLock = electronPkg.app.requestSingleInstanceLock;
      let scheduleRegistered;
      try {
        electronPkg.app.requestSingleInstanceLock = () => false;
        const mainUrl = new URL('../../electron/main.js', import.meta.url);
        mainUrl.search = `?handoff-bridge-registration-gate=${Date.now()}`;
        ({ scheduleRegisteredHandoffBridgeLaunch: scheduleRegistered } = await import(mainUrl.href));
      } finally {
        if (originalLock === undefined) delete electronPkg.app.requestSingleInstanceLock;
        else electronPkg.app.requestSingleInstanceLock = originalLock;
      }
      let schedules = 0; let starts = 0;
      const schedule = options => {
        schedules += 1;
        options.start?.({ reason: 'auto-start' });
        return 'scheduled';
      };
      const autoStart = { autoStart: true, start: () => { starts += 1; } };
      const failed = scheduleRegistered({ registered: false, schedule, options: autoStart });
      assert(failed === null && schedules === 0 && starts === 0,
        'a failed bridge registration leaves a persisted autoStart unable to schedule or invoke its start path');
      const registered = scheduleRegistered({ registered: true, schedule, options: autoStart });
      assert(registered === 'scheduled' && schedules === 1 && starts === 1,
        'the regression has a positive control: a complete registration still owns the existing delayed start path');
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
    name: 'handoff bridge: inert: durable setup mutations republish the real off-state bootstrap facts',
    async run() {
      await stopHandoffBridge();
      const originalLock = electronPkg.app.requestSingleInstanceLock;
      electronPkg.app.requestSingleInstanceLock = () => false;
      let createSetup;
      try {
        const mainUrl = new URL('../../electron/main.js', import.meta.url);
        mainUrl.search = `?handoff-bridge-bootstrap-projection=${Date.now()}`;
        ({ createHandoffBridgeTunnelSetup: createSetup } = await import(mainUrl.href));
      } finally {
        if (originalLock === undefined) delete electronPkg.app.requestSingleInstanceLock;
        else electronPkg.app.requestSingleInstanceLock = originalLock;
      }

      const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-bridge-setup-projection-'));
      const source = path.join(userData, 'source-cloudflared');
      const copiedBinary = path.join(userData, 'handoff-bridge', 'tunnel', 'bin', 'cloudflared-deadbeef');
      const credentials = path.join(userData, 'selected-tunnel.json');
      const pin = 'd'.repeat(64);
      const tunnelId = '550e8400-e29b-41d4-a716-446655440000';
      const ipc = bridgeIpc(); const canvas = liveCanvas(110); const clock = bridgeClock();
      let setup;
      try {
        // The setup adapter uses its production writeTunnelState default; only
        // filesystem inspection/copying is replaced so this test stays local.
        setup = createSetup(userData, {
          prepareBinaryImpl: async () => ({ ok: true, copyPath: copiedBinary, sha256: pin, version: '2026.9.3' }),
          inspectCredentialsImpl: value => ({ ok: true, credentialsPath: value, tunnelId, credentialsMode: '0600' }),
          statSync: () => ({ size: 42 }),
          codesignImpl: () => ({ verified: true, summary: 'ad-hoc signed' }),
          now: () => 1,
        });
        assert(registerHandoffBridgeHandlers({ ipcMain: ipc, deps: {
          env: {}, isPackaged: true, userData, getCanvasWindows: () => [canvas],
          readConfig: () => ({ state: 'ok', config: READY_CONFIG }), readTunnelState,
          tunnelSetup: setup, now: clock.now, timers: clock.timers,
          dialogs: {
            ask: async () => ({ ok: true }),
            choose: async (_sender, kind) => ({ ok: true, filePath: kind === 'binary' ? source : credentials }),
          },
        } }), 'the production setup adapter registers through the off-state bridge composition');

        const event = { sender: canvas.webContents };
        const get = ipc.handlers.get(IPC_CHANNELS.GET_STATUS);
        const baseline = await get(event);
        assert(baseline.success && !baseline.status.enabled && !baseline.status.setup.binaryApproved && !baseline.status.setup.credentialsOk,
          'the real tunnel parser projects an initially empty durable setup as incomplete');
        const selected = await ipc.handlers.get(IPC_CHANNELS.CHOOSE_BINARY)(event);
        clock.advance(clock.now() + 250);
        const selectedStatus = await get(event);
        const selectedWire = JSON.stringify(selectedStatus.status);
        const selectedEvents = canvas.sent.filter(entry => entry.channel === IPC_EVENTS.STATUS).map(entry => entry.value);
        assert(selected.success && !selectedStatus.status.enabled
          && selectedStatus.status.seq > baseline.status.seq
          && !selectedStatus.status.setup.binaryApproved && !selectedStatus.status.setup.credentialsOk
          && selectedStatus.status.tunnel.binary?.approved === false,
        'binary selection republishes a newer redacted off-state draft without treating it as approved');
        assert(selectedEvents.some(value => value.seq === selectedStatus.status.seq
          && value.tunnel.binary?.approved === false),
        'the renderer status subscription receives the selected binary draft after batched IPC delivery');
        assert(!selectedWire.includes(copiedBinary) && !selectedWire.includes(pin) && !selectedWire.includes(tunnelId),
          'the selected bootstrap projection does not expose the binary path, pin, or tunnel identifier');

        const approved = await ipc.handlers.get(IPC_CHANNELS.APPROVE_BINARY)(event);
        clock.advance(clock.now() + 250);
        const approvedStatus = await get(event);
        const approvedWire = JSON.stringify(approvedStatus.status);
        const approvedEvents = canvas.sent.filter(entry => entry.channel === IPC_EVENTS.STATUS).map(entry => entry.value);
        assert(approved.success && !approvedStatus.status.enabled
          && approvedStatus.status.seq > selectedStatus.status.seq
          && approvedStatus.status.setup.binaryApproved && !approvedStatus.status.setup.credentialsOk,
        'approval re-reads the production tunnel.json and publishes a newer off-state bootstrap projection');
        assert(approvedEvents.some(value => value.seq === approvedStatus.status.seq
          && value.setup.binaryApproved && !value.setup.credentialsOk),
        'the renderer status subscription receives the approved bootstrap projection after batched IPC delivery');
        assert(!approvedWire.includes(copiedBinary) && !approvedWire.includes(pin) && !approvedWire.includes(tunnelId),
          'the approved bootstrap projection does not expose binary paths, pins, or tunnel identifiers');

        const chosen = await ipc.handlers.get(IPC_CHANNELS.CHOOSE_CREDENTIALS)(event);
        clock.advance(clock.now() + 250);
        const credentialStatus = await get(event);
        const credentialWire = JSON.stringify(credentialStatus.status);
        const credentialEvents = canvas.sent.filter(entry => entry.channel === IPC_EVENTS.STATUS).map(entry => entry.value);
        assert(chosen.success && !credentialStatus.status.enabled
          && credentialStatus.status.seq > approvedStatus.status.seq
          && credentialStatus.status.setup.binaryApproved && credentialStatus.status.setup.credentialsOk,
        'credential selection re-reads the production tunnel.json and publishes both durable setup facts while off');
        assert(credentialEvents.some(value => value.seq === credentialStatus.status.seq
          && value.setup.binaryApproved && value.setup.credentialsOk),
        'the renderer status subscription receives the credential-ready bootstrap projection after batched IPC delivery');
        assert(!credentialWire.includes(copiedBinary) && !credentialWire.includes(credentials)
          && !credentialWire.includes(pin) && !credentialWire.includes(tunnelId),
        'the credential-ready bootstrap projection keeps all setup paths, pins, and tunnel identifiers private');
      } finally {
        await stopHandoffBridge();
        await setup?.clearSession?.();
        fs.rmSync(userData, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'handoff bridge: inert: off config saves advance public status and merge independent scope fields',
    async run() {
      await stopHandoffBridge();
      const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-bridge-status-'));
      const ipc = bridgeIpc(); const canvas = liveCanvas(109);
      const clock = bridgeClock();
      try {
        assert(registerHandoffBridgeHandlers({ ipcMain: ipc, deps: {
          isPackaged: true, userData, getCanvasWindows: () => [canvas],
          dialogs: { ask: async () => ({ ok: true }) },
          now: clock.now, timers: clock.timers,
        } }), 'a fresh local IPC registry installs the off-bridge status projection');
        const get = ipc.handlers.get(IPC_CHANNELS.GET_STATUS);
        const save = ipc.handlers.get(IPC_CHANNELS.SAVE_CONFIG);
        const first = await get({ sender: canvas.webContents });
        assert(first.success && Number.isSafeInteger(first.status.seq) && first.status.autoStart === false,
          'a fresh registration reads its own default bootstrap state instead of reusing the prior cached user-data projection');
        const unchanged = await get({ sender: canvas.webContents });
        assert(unchanged.status.seq === first.status.seq, 'repeated unchanged off status reads retain their public sequence');
        assert((await save({ sender: canvas.webContents }, { patch: { autoStart: true } })).success,
          'an off-bridge auto-start preference persists after fixed consent');
        const published = canvas.sent.filter(entry => entry.channel === IPC_EVENTS.STATUS).at(-1)?.value;
        const afterAutoStart = await get({ sender: canvas.webContents });
        assert(published?.seq > first.status.seq && afterAutoStart.status.seq >= published.seq && afterAutoStart.status.autoStart,
          'an off config save publishes a strictly newer status that carries the saved value');
        assert((await save({ sender: canvas.webContents }, { patch: { scope: { applications: false } } })).success,
          'the first partial scope patch saves');
        assert((await save({ sender: canvas.webContents }, { patch: { scope: { scoring: true } } })).success,
          'the second partial scope patch saves independently after scoring consent');
        const persisted = JSON.parse(fs.readFileSync(path.join(userData, 'handoff-bridge', 'config.json'), 'utf8'));
        assert(persisted.scope.applications === false && persisted.scope.scoring === true,
          'partial scope patches merge at the durable boundary instead of restoring a stale sibling field');
        const beforeAttach = (await get({ sender: canvas.webContents })).status.seq;
        let notifyActive;
        let activeStatus = { v: 1, seq: 0, enabled: true, serving: 'live', paused: false, config: { scope: { applications: false, scoring: true } } };
        let throwActiveSnapshot = false;
        const graph = {
          controller: {
            snapshot: () => {
              if (throwActiveSnapshot) throw new Error('synthetic active snapshot failure');
              return activeStatus;
            },
            subscribe: listener => { notifyActive = listener; return () => {}; },
            disable: async () => ({ success: true }),
          },
        };
        assert((await startHandoffBridge({ deps: completeStartDeps({ userData, compose: () => graph }) })).success,
          'an inert attached graph is sufficient to exercise the public status owner transition');
        const attached = await get({ sender: canvas.webContents });
        assert(attached.status.seq > beforeAttach, 'attaching a fresh controller advances the public status sequence');
        activeStatus = { ...activeStatus, seq: 1, paused: true };
        const readBeforeCallback = await get({ sender: canvas.webContents });
        const beforeRelay = canvas.sent.filter(entry => entry.channel === IPC_EVENTS.STATUS).length;
        notifyActive?.(activeStatus);
        clock.advance(250);
        const afterRelay = canvas.sent.filter(entry => entry.channel === IPC_EVENTS.STATUS);
        const advancedActive = await get({ sender: canvas.webContents });
        assert(afterRelay.length === beforeRelay + 1 && afterRelay.at(-1)?.value.seq === readBeforeCallback.status.seq,
          'an equal active callback relays once when a status read observed that sequence first');
        const staleSameSequence = activeStatus;
        activeStatus = { ...activeStatus, setup: { tunnelReachable: true } };
        const reachabilityRead = await get({ sender: canvas.webContents });
        assert(reachabilityRead.status.seq > advancedActive.status.seq && reachabilityRead.status.setup.tunnelReachable,
          'an authoritative read advances when tunnel reachability changes at the same controller sequence');
        const beforeStaleSameSequence = canvas.sent.filter(entry => entry.channel === IPC_EVENTS.STATUS).length;
        notifyActive?.(staleSameSequence);
        clock.advance(500);
        const afterStaleSameSequence = canvas.sent.filter(entry => entry.channel === IPC_EVENTS.STATUS);
        const afterStaleSameSequenceRead = await get({ sender: canvas.webContents });
        assert(afterStaleSameSequence.length === beforeStaleSameSequence
          && afterStaleSameSequenceRead.status.seq === reachabilityRead.status.seq
          && afterStaleSameSequenceRead.status.setup.tunnelReachable,
        'a delayed equal-sequence callback cannot roll back a GET-observed reachability change');
        throwActiveSnapshot = true;
        const failedRead = await get({ sender: canvas.webContents });
        throwActiveSnapshot = false;
        assert(failedRead.status.seq === reachabilityRead.status.seq && failedRead.status.enabled,
          'a failed active status read retains the newest public projection instead of returning an older bootstrap cache');
        notifyActive?.(activeStatus);
        clock.advance(500);
        assert(canvas.sent.filter(entry => entry.channel === IPC_EVENTS.STATUS).length === afterStaleSameSequence.length + 1,
          'a matching equal-sequence callback relays the GET-observed projection exactly once');
        notifyActive?.({ ...activeStatus, seq: 0, paused: false });
        const delayedActive = await get({ sender: canvas.webContents });
        assert(reachabilityRead.status.seq > attached.status.seq && reachabilityRead.status.paused && delayedActive.status.seq === reachabilityRead.status.seq && delayedActive.status.paused,
          'a delayed lower-sequence active callback cannot replace the current public projection');
        await stopHandoffBridge();
        const detached = await get({ sender: canvas.webContents });
        assert(detached.status.seq > reachabilityRead.status.seq && detached.status.enabled === false,
          'detaching a controller advances to a distinct closed bootstrap projection');
      } finally {
        await stopHandoffBridge();
        fs.rmSync(userData, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'handoff bridge: inert: a cross-root IPC re-registration detaches the old graph before exposing the new root',
    async run() {
      await stopHandoffBridge();
      const oldUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-bridge-old-root-'));
      const newUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-bridge-new-root-'));
      const oldHostname = 'b-aaaaaaaaaaaaaaaaaaaa.lullascape.com';
      const newHostname = 'b-bbbbbbbbbbbbbbbbbbbb.lullascape.com';
      const oldIpc = bridgeIpc(); const newIpc = bridgeIpc(); const canvas = liveCanvas(110);
      let oldDisabled = 0; let staleCallback; let writeTarget = null;
      const oldConfig = { ...READY_CONFIG, hostname: oldHostname };
      const newConfig = { ...READY_CONFIG, hostname: newHostname };
      try {
        assert(registerHandoffBridgeHandlers({ ipcMain: oldIpc, deps: {
          isPackaged: true, userData: oldUserData, getCanvasWindows: () => [canvas],
          readConfig: () => ({ state: 'ok', config: oldConfig }),
        } }), 'the old root registers its local IPC ports');
        assert((await startHandoffBridge({ deps: completeStartDeps({
          userData: oldUserData,
          readConfig: () => ({ state: 'ok', config: oldConfig }),
          compose: () => ({
            userData: oldUserData,
            controller: {
              snapshot: () => ({ ...liveStatus(oldHostname), seq: 1 }),
              subscribe: listener => { staleCallback = listener; return () => {}; },
              disable: async () => { oldDisabled += 1; return { success: true }; },
            },
            listener: {}, tunnel: {}, power: {}, tray: {},
          }),
        }) })).success, 'the old root can attach a synthetic live graph');

        recordFailedStartDiagnostic({ telemetry: true, phase: 'tunnel-start', cause: 'config-rejected', tunnel: { state: 'failed', lastExit: 'config-rejected' } });
        assert(getFailedStartDiagnostic()?.telemetry === true, 'the old root fixture must seed a retained opted-in receipt');
        assert(registerHandoffBridgeHandlers({ ipcMain: newIpc, deps: {
          isPackaged: true, userData: newUserData, getCanvasWindows: () => [canvas],
          dialogs: { ask: async () => ({ ok: true }) },
          readConfig: () => ({ state: 'ok', config: newConfig }),
          writeConfig: async (target, patch) => {
            writeTarget = target;
            return { ok: true, config: { ...newConfig, ...patch } };
          },
        } }), 'a distinct user-data root replaces its IPC registry');
        assert(oldDisabled === 1, 'cross-root registration starts hard-off disposal of the old graph synchronously');

        const get = newIpc.handlers.get(IPC_CHANNELS.GET_STATUS);
        const save = newIpc.handlers.get(IPC_CHANNELS.SAVE_CONFIG);
        const beforeStale = await get({ sender: canvas.webContents });
        assert(beforeStale.success && beforeStale.status.enabled === false && beforeStale.status.serving === 'off'
          && beforeStale.status.config.hostname === newHostname,
        'the replacement registry exposes only a closed bootstrap status from its own root');
        staleCallback?.({ ...liveStatus(oldHostname), seq: 2 });
        const afterStale = await get({ sender: canvas.webContents });
        assert(afterStale.status.seq === beforeStale.status.seq && afterStale.status.config.hostname === newHostname,
          'a late callback from the detached old controller cannot republish old-root state');
        assert((await save({ sender: canvas.webContents }, { patch: { autoStart: true } })).success && writeTarget === newUserData,
          'the replacement registry saves only to its new user-data root');
        assert(getFailedStartDiagnostic() === null,
          'cross-root IPC registration must discard the prior root\'s optional failed-start receipt');
      } finally {
        clearFailedStartDiagnostic(); await stopHandoffBridge();
        fs.rmSync(oldUserData, { recursive: true, force: true });
        fs.rmSync(newUserData, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'handoff bridge: inert: a direct cross-root start cannot retain another root\'s failed-start receipt',
    async run() {
      await stopHandoffBridge(); clearFailedStartDiagnostic();
      const oldUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-bridge-start-old-root-'));
      const newUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-bridge-start-new-root-'));
      const graph = userData => ({
        userData,
        controller: {
          snapshot: () => ({ enabled: false, serving: 'off', paused: false, pauseCause: null, config: { telemetryInBugReports: false } }),
          subscribe: () => () => {}, disable: async () => ({ success: true }),
        },
        listener: {}, tunnel: {}, power: {}, tray: {},
      });
      try {
        assert((await startHandoffBridge({ deps: completeStartDeps({ userData: oldUserData, compose: () => graph(oldUserData) }) })).success,
          'the old root graph must attach before testing a direct root switch');
        await stopHandoffBridge();
        recordFailedStartDiagnostic({ telemetry: true, phase: 'tunnel-start', cause: 'config-rejected', tunnel: { state: 'failed', lastExit: 'config-rejected' } });
        assert((await startHandoffBridge({ deps: completeStartDeps({ userData: newUserData, compose: () => graph(newUserData) }) })).success
          && getFailedStartDiagnostic() === null,
        'direct start with a new user-data root must clear the old root\'s optional receipt before composing');
      } finally {
        clearFailedStartDiagnostic(); await stopHandoffBridge();
        fs.rmSync(oldUserData, { recursive: true, force: true });
        fs.rmSync(newUserData, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'handoff bridge: inert: a failed first snapshot publishes closed state for the newly attached root',
    async run() {
      await stopHandoffBridge();
      const oldUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-bridge-attach-old-'));
      const newUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-bridge-attach-new-'));
      const oldHostname = 'b-cccccccccccccccccccc.lullascape.com';
      const newHostname = 'b-dddddddddddddddddddd.lullascape.com';
      const ipc = bridgeIpc(); let emitNew; let throwInitial = true;
      const oldConfig = { ...READY_CONFIG, hostname: oldHostname };
      const newConfig = { ...READY_CONFIG, hostname: newHostname };
      try {
        assert(registerHandoffBridgeHandlers({ ipcMain: ipc, deps: {
          isPackaged: true, userData: oldUserData, getCanvasWindows: () => [],
          readConfig: () => ({ state: 'ok', config: oldConfig }),
        } }), 'the old root installs the controller bridge');
        assert((await startHandoffBridge({ deps: completeStartDeps({
          userData: oldUserData,
          readConfig: () => ({ state: 'ok', config: oldConfig }),
          compose: () => ({
            userData: oldUserData,
            controller: {
              snapshot: () => ({ ...liveStatus(oldHostname), seq: 1 }),
              subscribe: () => () => {}, disable: async () => ({ success: true }),
            },
            listener: {}, tunnel: {}, power: {}, tray: {},
          }),
        }) })).success, 'a first graph supplies an old live projection');
        await stopHandoffBridge();
        assert((await startHandoffBridge({ deps: completeStartDeps({
          userData: newUserData,
          readConfig: () => ({ state: 'ok', config: newConfig }),
          compose: () => ({
            userData: newUserData,
            controller: {
              snapshot: () => {
                if (throwInitial) throw new Error('synthetic first snapshot failure');
                return { ...liveStatus(newHostname), seq: 2 };
              },
              subscribe: listener => { emitNew = listener; return () => {}; },
              disable: async () => ({ success: true }),
            },
            listener: {}, tunnel: {}, power: {}, tray: {},
          }),
        }) })).success, 'a replacement graph may attach even when its first snapshot fails');
        const closed = getHandoffBridgeStatus();
        assert(closed.enabled === false && closed.serving === 'off' && closed.config.hostname === newHostname,
          'a failed first snapshot cannot relabel the old live state as the new controller');
        throwInitial = false;
        emitNew?.({ ...liveStatus(newHostname), seq: 2 });
        const recovered = getHandoffBridgeStatus();
        assert(recovered.seq > closed.seq && recovered.enabled && recovered.serving === 'live' && recovered.config.hostname === newHostname,
          'a later valid callback still advances from the safe closed projection');
      } finally {
        await stopHandoffBridge();
        fs.rmSync(oldUserData, { recursive: true, force: true });
        fs.rmSync(newUserData, { recursive: true, force: true });
      }
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
    name: 'handoff bridge: inert: binary selection fences a pending enable through the registered IPC route',
    async run() {
      await stopHandoffBridge();
      const ipc = bridgeIpc(); const canvas = liveCanvas(73); const enableGate = deferred();
      let composed = 0; let enables = 0; let disables = 0;
      const setup = { ...READY_SETUP, pin: 'd'.repeat(64), approvedAt: 1 };
      assert(registerHandoffBridgeHandlers({ ipcMain: ipc, deps: {
        isPackaged: true, userData: SAFE_PATHS.userData, getCanvasWindows: () => [canvas],
        readConfig: () => ({ state: 'ok', config: READY_CONFIG }), readTunnelState: () => setup,
        tunnelSetup: { chooseBinary: async () => ({ ok: true }) },
        dialogs: { choose: async () => ({ ok: true, filePath: '/tmp/replacement-cloudflared' }) },
      } }), 'the pending-enable fixture registers the production setup mutation route');
      const compose = () => {
        composed += 1;
        return {
          controller: {
            snapshot: () => liveStatus(), subscribe: () => () => undefined,
            enable: async () => { enables += 1; return enableGate.promise; },
            disable: async () => { disables += 1; return { success: true }; },
          }, listener: {}, tunnel: {}, power: {}, tray: {},
        };
      };
      const pendingStart = startHandoffBridge({ deps: completeStartDeps({
        compose, tunnelState: setup, readConfig: undefined, activate: true, confirmed: true,
      }) });
      await Promise.resolve(); await Promise.resolve();
      assert(composed === 1 && enables === 1 && getHandoffBridgeStatus().enabled,
        'the candidate is attached while its enable operation remains pending');

      const selected = await ipc.handlers.get(IPC_CHANNELS.CHOOSE_BINARY)({ sender: canvas.webContents });
      assert(selected.success && disables === 1 && !getHandoffBridgeStatus().enabled,
        'an acknowledged replacement selection hard-detaches the pending candidate before it can serve');
      enableGate.resolve({ success: true });
      const stale = await pendingStart;
      assert(stale.success === false && stale.code === 'not_enabled'
        && composed === 1 && disables === 1 && !getHandoffBridgeStatus().enabled,
      'a resolved stale enable is fenced, disposed once, and cannot revive the detached graph');
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
      let setup = { ...READY_SETUP, pin: 'c'.repeat(64), approvedAt: 1 };
      const replacementPin = 'd'.repeat(64);
      const tunnelSetup = {
        getApprovalDetails: async () => ({ ok: true, version: '2026.9.3', sha256: setup.pin }),
        approveBinary: async expectedPin => {
          if (expectedPin !== setup.pin) return { ok: false, code: 'NOT_READY' };
          setup = { ...setup, binaryTrusted: true, approvedAt: 2 };
          return { ok: true };
        },
        chooseCredentials: async () => ({ ok: true }),
        chooseBinary: async () => {
          setup = {
            ...setup,
            binaryPath: `${TMP}/bin/replacement-cloudflared`,
            pin: replacementPin,
            approvedAt: null,
            binaryTrusted: false,
          };
          return { ok: true };
        },
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
      assert((await ipc.handlers.get(IPC_CHANNELS.CHOOSE_BINARY)(event)).success
        && setup.pin === replacementPin && setup.approvedAt === null && setup.binaryTrusted === false
        && disabled === 2 && getHandoffBridgeStatus().enabled === false && !getHandoffBridgeStatus().setup.binaryApproved,
      'a replacement binary selection persists an unapproved setup and detaches the graph that captured the former executable');
      const blockedRestart = await startHandoffBridge({ deps: completeStartDeps({ compose, tunnelState: setup, readConfig: undefined, activate: true, confirmed: true }) });
      assert(blockedRestart.success === false && blockedRestart.code === 'binary_untrusted' && disabled === 2 && composed === 2,
        'the unapproved replacement blocks restart without composing or disposing another graph');
      assert((await ipc.handlers.get(IPC_CHANNELS.APPROVE_BINARY)(event)).success
        && setup.pin === replacementPin && setup.approvedAt === 2 && setup.binaryTrusted === true
        && disabled === 2 && getHandoffBridgeStatus().enabled === false && getHandoffBridgeStatus().setup.binaryApproved,
      'approval restores trust for that exact replacement without reviving the detached graph');
      assert((await startHandoffBridge({ deps: completeStartDeps({ compose, tunnelState: setup, readConfig: undefined, activate: true, confirmed: true }) })).success
        && composed === 3 && disabled === 2,
      'only approval permits the replacement binary to compose a fresh runtime');
      assert((await ipc.handlers.get(IPC_CHANNELS.CHOOSE_CREDENTIALS)(event)).success
        && disabled === 3 && getHandoffBridgeStatus().enabled === false && composed === 3,
      'acknowledged credentials detach the approved replacement graph and never auto-restart');
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
        // Adapters are created by distinct IPC registrations. The second one
        // can be asked first, so hydration must belong to their shared session
        // rather than to whichever adapter happened to construct first.
        const hydrationRoot = path.join(root, 'shared-hydration');
        let hydrationReads = 0;
        const hydrationDisk = normalize({ binaryPath: copy, pin, approvedAt: null });
        const hydrationDeps = {
          ...deps,
          readTunnelStateImpl: () => { hydrationReads += 1; return hydrationDisk; },
          writeTunnelStateImpl: async (_userData, candidate) => normalize(candidate),
        };
        const hydrationFirst = createSetup(hydrationRoot, hydrationDeps);
        const hydrationSecond = createSetup(hydrationRoot, hydrationDeps);
        sessions.push(hydrationFirst, hydrationSecond);
        const [secondDetails, firstDetails] = await Promise.all([
          hydrationSecond.getApprovalDetails(), hydrationFirst.getApprovalDetails(),
        ]);
        assert(hydrationReads === 1 && secondDetails.ok && firstDetails.ok
          && secondDetails.sha256 === pin && firstDetails.sha256 === pin,
        'two setup adapters share exactly one durable hydration even when the later adapter reads first');

        const setup = createSetup(root, deps); sessions.push(setup);
        assert((await setup.chooseBinary(source)).ok && disk?.binaryPath === copy && disk?.approvedAt === null && !disk?.credentialsPath,
          'an accepted binary selection durably records only its unapproved copy and pin');
        failWrite = true;
        assert((await setup.chooseCredentials(credentials)).code === 'STATE_UNREADABLE',
          'a credentials selection reports the fixed durable-write failure');
        failWrite = false;
        assert((await setup.approveBinary(pin)).ok && writes.at(-1).credentialsPath === undefined && disk?.approvedAt === stamp,
          'failed credential staging rolls back memory, so later approval cannot persist its stale path');
        assert((await setup.chooseCredentials(credentials)).ok && disk?.credentialsPath === credentials && disk?.binaryTrusted === true,
          'accepted credentials are persisted with the already-approved binary state');
        await setup.clearSession();
        const restarted = createSetup(root, deps); sessions.push(restarted);
        const details = await restarted.getApprovalDetails();
        assert(details.ok && details.sha256 === pin,
          'a reset shared setup session rehydrates the durable partial schema rather than depending on stale process memory');
        assert((await restarted.chooseCredentials(replacementCredentials)).ok
          && writes.at(-1).approvedAt === stamp && disk?.credentialsPath === replacementCredentials && disk?.binaryTrusted === true,
        'a restart derives trust and retained approval from the stored result while persisting a later credentials mutation');

        // Native file chooser completions may overlap. Hold the binary write
        // until the credentials completion has queued behind it: the second
        // durable candidate must retain the first selection instead of taking
        // a stale pre-write snapshot and later erasing it.
        const concurrentRoot = path.join(root, 'concurrent');
        let concurrentDisk = null;
        const concurrentWrites = [];
        let firstWriteStarted;
        const firstWriteReady = new Promise(resolve => { firstWriteStarted = resolve; });
        let releaseFirstWrite;
        const firstWriteGate = new Promise(resolve => { releaseFirstWrite = resolve; });
        const concurrent = createSetup(concurrentRoot, {
          ...deps,
          readTunnelStateImpl: () => concurrentDisk,
          writeTunnelStateImpl: async (_userData, candidate) => {
            concurrentWrites.push({ ...candidate });
            if (concurrentWrites.length === 1) {
              firstWriteStarted();
              await firstWriteGate;
            }
            concurrentDisk = normalize(candidate);
            return concurrentDisk;
          },
        });
        sessions.push(concurrent);
        const binarySelection = concurrent.chooseBinary(source);
        await firstWriteReady;
        const credentialsSelection = concurrent.chooseCredentials(credentials);
        await Promise.resolve();
        releaseFirstWrite();
        assert((await binarySelection).ok && (await credentialsSelection).ok
          && concurrentWrites.length === 2
          && concurrentWrites[0].binaryPath === copy && !concurrentWrites[0].credentialsPath
          && concurrentWrites[1].binaryPath === copy && concurrentWrites[1].credentialsPath === credentials
          && concurrentDisk?.binaryPath === copy && concurrentDisk?.credentialsPath === credentials,
        'overlapping setup selections serialize snapshot, mutation, durable write and rollback so neither accepted selection is lost');
        const resetCache = concurrent.clearSession();
        const sharedAdapter = createSetup(concurrentRoot, {
          ...deps,
          readTunnelStateImpl: () => concurrentDisk,
          writeTunnelStateImpl: async (_userData, candidate) => {
            concurrentDisk = normalize(candidate);
            return concurrentDisk;
          },
        });
        sessions.push(sharedAdapter);
        await resetCache;
        assert((await concurrent.chooseCredentials(replacementCredentials)).ok
          && (await sharedAdapter.getApprovalDetails()).ok
          && concurrentDisk?.credentialsPath === replacementCredentials,
        'a cleared registered adapter remains usable and every same-root adapter shares its rehydrated cache and queue');

        // Clear itself is queued behind an in-flight mutation. Once the write
        // finishes, it resets only memory; the original adapter may then read
        // and act on the durable result without a main-process re-registration.
        const orderedRoot = path.join(root, 'clear-after-write');
        let orderedDisk = null;
        let orderedWriteStarted;
        const orderedWriteReady = new Promise(resolve => { orderedWriteStarted = resolve; });
        let releaseOrderedWrite;
        const orderedWriteGate = new Promise(resolve => { releaseOrderedWrite = resolve; });
        const ordered = createSetup(orderedRoot, {
          ...deps,
          readTunnelStateImpl: () => orderedDisk,
          writeTunnelStateImpl: async (_userData, candidate) => {
            orderedWriteStarted();
            await orderedWriteGate;
            orderedDisk = normalize(candidate);
            return orderedDisk;
          },
        });
        sessions.push(ordered);
        const pendingSelection = ordered.chooseBinary(source);
        await orderedWriteReady;
        const orderedClear = ordered.clearSession();
        releaseOrderedWrite();
        assert((await pendingSelection).ok && (await orderedClear) === true
          && (await ordered.getApprovalDetails()).ok && orderedDisk?.binaryPath === copy,
        'clear waits for an already-started durable mutation, then the same adapter rehydrates and remains usable');

        // A native chooser may take time copying and hashing. Queue that work,
        // not just its final write: otherwise a later chooser can commit first
        // and an earlier completion can overwrite it out of invocation order.
        const invocationRoot = path.join(root, 'invocation-order');
        const sourceA = path.join(root, 'source-a');
        const sourceB = path.join(root, 'source-b');
        const copyA = path.join(root, 'copy-a');
        const copyB = path.join(root, 'copy-b');
        const pinA = 'c'.repeat(64);
        const pinB = 'd'.repeat(64);
        let invocationDisk = null;
        const invocationWrites = [];
        let firstPrepareStarted;
        const firstPrepareReady = new Promise(resolve => { firstPrepareStarted = resolve; });
        let releaseFirstPrepare;
        const firstPrepareGate = new Promise(resolve => { releaseFirstPrepare = resolve; });
        const invocation = createSetup(invocationRoot, {
          ...deps,
          readTunnelStateImpl: () => invocationDisk,
          prepareBinaryImpl: async ({ sourcePath }) => {
            if (sourcePath === sourceA) {
              firstPrepareStarted();
              await firstPrepareGate;
              return { ok: true, copyPath: copyA, sha256: pinA, version: '2026.9.3' };
            }
            return { ok: true, copyPath: copyB, sha256: pinB, version: '2026.9.4' };
          },
          writeTunnelStateImpl: async (_userData, candidate) => {
            invocationWrites.push({ ...candidate });
            invocationDisk = normalize(candidate);
            return invocationDisk;
          },
        });
        sessions.push(invocation);
        const firstInvocation = invocation.chooseBinary(sourceA);
        await firstPrepareReady;
        const secondInvocation = invocation.chooseBinary(sourceB);
        await Promise.resolve();
        releaseFirstPrepare();
        assert((await firstInvocation).ok && (await secondInvocation).ok
          && invocationWrites.length === 2 && invocationWrites[0].pin === pinA && invocationWrites[1].pin === pinB
          && invocationDisk?.pin === pinB,
        'a deferred first binary selection commits before a later selection, preserving chooser invocation order');

        // Forget must enqueue after an initiated (but still copying) selection.
        // The observable rehydrate after Forget proves its cache reset happened
        // after the durable write, rather than overtaking pre-queue preparation.
        const clearDuringPrepareRoot = path.join(root, 'clear-during-prepare');
        let clearDuringPrepareDisk = null;
        const clearDuringPrepareEvents = [];
        let clearPrepareStarted;
        const clearPrepareReady = new Promise(resolve => { clearPrepareStarted = resolve; });
        let releaseClearPrepare;
        const clearPrepareGate = new Promise(resolve => { releaseClearPrepare = resolve; });
        const clearDuringPrepare = createSetup(clearDuringPrepareRoot, {
          ...deps,
          readTunnelStateImpl: () => {
            clearDuringPrepareEvents.push('read');
            return clearDuringPrepareDisk;
          },
          prepareBinaryImpl: async () => {
            clearPrepareStarted();
            await clearPrepareGate;
            return { ok: true, copyPath: copyA, sha256: pinA, version: '2026.9.3' };
          },
          writeTunnelStateImpl: async (_userData, candidate) => {
            clearDuringPrepareEvents.push('write');
            clearDuringPrepareDisk = normalize(candidate);
            return clearDuringPrepareDisk;
          },
        });
        sessions.push(clearDuringPrepare);
        const pendingPrepare = clearDuringPrepare.chooseBinary(sourceA);
        await clearPrepareReady;
        const clearDuringPrepareResult = clearDuringPrepare.clearSession();
        releaseClearPrepare();
        assert((await pendingPrepare).ok && (await clearDuringPrepareResult) === true
          && (await clearDuringPrepare.getApprovalDetails()).ok
          && JSON.stringify(clearDuringPrepareEvents) === JSON.stringify(['read', 'write', 'read']),
        'Forget queues behind binary preparation and resets cache only after its durable selection commits');

        // The approval sheet is built from the old digest. If another native
        // chooser commits before the person confirms it, that sheet must not
        // approve the replacement binary merely because approval was queued.
        const approvalRoot = path.join(root, 'approval-pin');
        const approvalPinA = 'e'.repeat(64);
        const approvalPinB = 'f'.repeat(64);
        const approvalCopyA = path.join(root, 'approval-copy-a');
        const approvalCopyB = path.join(root, 'approval-copy-b');
        let approvalDisk = normalize({ binaryPath: approvalCopyA, pin: approvalPinA, approvedAt: null });
        const approvalWrites = [];
        const approval = createSetup(approvalRoot, {
          ...deps,
          readTunnelStateImpl: () => approvalDisk,
          prepareBinaryImpl: async () => ({ ok: true, copyPath: approvalCopyB, sha256: approvalPinB, version: '2026.9.4' }),
          writeTunnelStateImpl: async (_userData, candidate) => {
            approvalWrites.push({ ...candidate });
            approvalDisk = normalize(candidate);
            return approvalDisk;
          },
        });
        sessions.push(approval);
        const oldApprovalDetails = await approval.getApprovalDetails();
        assert(oldApprovalDetails.ok && oldApprovalDetails.sha256 === approvalPinA
          && (await approval.chooseBinary(sourceB)).ok
          && (await approval.approveBinary(oldApprovalDetails.sha256)).code === 'NOT_READY'
          && approvalWrites.length === 1 && approvalDisk?.pin === approvalPinB && approvalDisk?.approvedAt === null,
        'approval binds to the digest shown in its sheet and refuses a replacement binary selected before confirmation');

        // A failed binary copy is kept entirely in its transaction candidate.
        // A concurrent read and approval must still address the prior durable
        // binary, never the uncommitted copy that will be rolled back.
        const transactionRoot = path.join(root, 'transaction');
        const committedPin = 'b'.repeat(64);
        const committedCopy = path.join(root, 'committed-cloudflared');
        let transactionDisk = normalize({ binaryPath: committedCopy, pin: committedPin, approvedAt: null });
        const transactionWrites = [];
        let selectionWriteStarted;
        const selectionWriteReady = new Promise(resolve => { selectionWriteStarted = resolve; });
        let releaseSelectionWrite;
        const selectionWriteGate = new Promise(resolve => { releaseSelectionWrite = resolve; });
        let failSelectionWrite = false;
        const transactional = createSetup(transactionRoot, {
          ...deps,
          readTunnelStateImpl: () => transactionDisk,
          writeTunnelStateImpl: async (_userData, candidate) => {
            transactionWrites.push({ ...candidate });
            if (transactionWrites.length === 1) {
              selectionWriteStarted();
              await selectionWriteGate;
              if (failSelectionWrite) throw new Error('selected copy failed to persist');
            }
            transactionDisk = normalize(candidate);
            return transactionDisk;
          },
        });
        sessions.push(transactional);
        const failedSelection = transactional.chooseBinary(source);
        await selectionWriteReady;
        const stagedDetails = transactional.getApprovalDetails();
        const priorApproval = transactional.approveBinary(committedPin);
        failSelectionWrite = true;
        releaseSelectionWrite();
        const [failedSelectionResult, stagedDetailsResult, priorApprovalResult] = await Promise.all([failedSelection, stagedDetails, priorApproval]);
        assert(failedSelectionResult.code === 'STATE_UNREADABLE' && stagedDetailsResult.ok && stagedDetailsResult.sha256 === committedPin
          && priorApprovalResult.ok && transactionWrites.length === 2
          && transactionWrites[1].binaryPath === committedCopy && transactionWrites[1].pin === committedPin
          && transactionWrites[1].approvedAt === stamp && transactionDisk?.binaryPath === committedCopy
          && transactionDisk?.binaryTrusted === true,
        'a failed staged binary never leaks to details or causes a queued approval to approve the wrong binary');
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
