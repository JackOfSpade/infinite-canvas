import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electronPkg from 'electron';
import { CONSTANTS } from './constants.js';
import { IPC_CHANNELS, STATUS_SNAPSHOT_EXAMPLE } from './contracts.js';
import { fixedError } from './errors.js';
import { readConfig } from './store.js';

let registered = false;
let startPromise = null;
let state = 'off';
let pauseCause = null;
let stateBeforeQuit = null;

function safelyUnderTmp(candidate, tmpdir, realpath) {
  if (typeof candidate !== 'string' || typeof tmpdir !== 'string' || !path.isAbsolute(candidate)) return false;
  if (candidate.split(path.sep).includes('..')) return false;
  try {
    const root = realpath(path.resolve(tmpdir));
    const resolved = realpath(path.resolve(candidate));
    return resolved === root || resolved.startsWith(`${root}${path.sep}`);
  } catch {
    return false;
  }
}

// The smoke boundary is security-sensitive. This is the only bridge module
// allowed to read INFINITE_CANVAS_HANDOFF_BRIDGE_* variables.
export function resolveTestMode({
  env = {},
  isPackaged,
  paths = {},
  tmpdir = os.tmpdir(),
  realpath = fs.realpathSync.native,
} = {}) {
  if (env.INFINITE_CANVAS_HANDOFF_BRIDGE_TEST !== '1' || isPackaged) return false;
  if (typeof realpath !== 'function') return false;
  if (!['binaryPath', 'credentialsPath', 'userData'].every(key => safelyUnderTmp(paths[key], tmpdir, realpath))) return false;
  const socketPath = path.join(paths.userData, CONSTANTS.SOCKET_RELATIVE_PATH);
  return Buffer.byteLength(socketPath) <= CONSTANTS.SOCKET_PATH_MAX_BYTES;
}

function isE2e(env) {
  return env.INFINITE_CANVAS_E2E === '1' || env.INFINITE_CANVAS_E2E_BACKGROUND === '1';
}

function environmentRefusal(env, isPackaged, testMode) {
  if (env.INFINITE_CANVAS_HANDOFF_BRIDGE === '0') return 'env_disabled';
  if (isE2e(env) && !testMode) return 'e2e';
  if (!isPackaged && env.INFINITE_CANVAS_HANDOFF_BRIDGE_DEV !== '1' && !testMode) return 'unpackaged';
  return null;
}

export function refusalForStart({
  env = process.env,
  isPackaged = electronPkg.app?.isPackaged,
  paths = {},
  tmpdir = os.tmpdir(),
  enabled = false,
  config = null,
  setup = {},
  stateUnreadable = false,
} = {}) {
  const testMode = resolveTestMode({ env, isPackaged, paths, tmpdir });
  const environment = environmentRefusal(env, isPackaged, testMode);
  if (environment) return environment;
  if (!enabled) return 'not_enabled';
  if (!config?.hostname) return 'no_hostname';
  if (!setup.binaryPath) return 'no_binary';
  if (!setup.binaryTrusted) return 'binary_untrusted';
  if (!setup.credentialsPath) return 'no_credentials';
  if (!setup.configValid) return 'config_invalid';
  if (setup.socketUnavailable) return 'socket_unavailable';
  if (setup.tunnelFailed) return 'tunnel_failed';
  if (stateUnreadable) return 'state_unreadable';
  return null;
}

function unavailableSnapshot(reason) {
  const availabilityReason = reason === 'env_disabled'
    ? 'env-disabled'
    : reason === 'e2e'
      ? 'e2e'
      : reason === 'unpackaged'
        ? 'dev-build'
        : null;
  return {
    ...STATUS_SNAPSHOT_EXAMPLE,
    availability: { ok: availabilityReason === null, reason: availabilityReason },
    serving: 'off',
    pauseCause: null,
  };
}

function refusalResult(reason, requestReason) {
  return { success: false, ...fixedError(reason), status: unavailableSnapshot(reason), reason: requestReason };
}

export function getHandoffBridgeStatus() {
  return { ...STATUS_SNAPSHOT_EXAMPLE, serving: state, paused: state === 'paused', pauseCause };
}

export function registerHandoffBridgeHandlers({ ipcMain = electronPkg.ipcMain } = {}) {
  if (registered && typeof ipcMain?.__getInvokeHandler === 'function' && !ipcMain.__getInvokeHandler(IPC_CHANNELS.GET_STATUS)) {
    registered = false;
  }
  if (registered) return false;
  const handle = typeof ipcMain?.handle === 'function' ? ipcMain.handle.bind(ipcMain) : null;
  if (!handle) return false;
  handle(IPC_CHANNELS.GET_STATUS, async () => ({ success: true, status: getHandoffBridgeStatus() }));
  registered = true;
  return true;
}

function appFor(deps) {
  return deps.app || electronPkg.app;
}

function packagedFor(deps, app) {
  return deps.isPackaged ?? app?.isPackaged ?? false;
}

function needsTestModeValidation(env, isPackaged) {
  return env.INFINITE_CANVAS_HANDOFF_BRIDGE_TEST === '1' && (isE2e(env) || !isPackaged);
}

function userDataFor(deps, app) {
  return deps.userData ?? app?.getPath?.('userData') ?? '';
}

// Deliberately not async: simultaneous callers receive the identical memoized
// Promise and cannot begin duplicate launch attempts.
export function startHandoffBridge({ reason = 'manual', deps = {} } = {}) {
  if (startPromise) return startPromise;
  const env = deps.env || process.env;
  if (env.INFINITE_CANVAS_HANDOFF_BRIDGE === '0') return Promise.resolve(refusalResult('env_disabled', reason));

  const app = appFor(deps);
  const isPackaged = packagedFor(deps, app);
  const validateTestMode = needsTestModeValidation(env, isPackaged);
  const tunnel = deps.tunnel || {};
  let userData = '';
  let testMode = false;

  // TEST cannot lift E2E/unpackaged until the constrained paths have passed.
  // Config is intentionally untouched until all environment gates pass.
  if (validateTestMode) {
    userData = userDataFor(deps, app);
    testMode = resolveTestMode({
      env,
      isPackaged,
      paths: { binaryPath: tunnel.binaryPath, credentialsPath: tunnel.credentialsPath, userData },
      tmpdir: deps.tmpdir || os.tmpdir(),
    });
  }
  const environment = environmentRefusal(env, isPackaged, testMode);
  if (environment) return Promise.resolve(refusalResult(environment, reason));
  if (deps.enabled !== true) return Promise.resolve(refusalResult('not_enabled', reason));

  if (!userData) userData = userDataFor(deps, app);
  if (!validateTestMode) {
    testMode = resolveTestMode({
      env,
      isPackaged,
      paths: { binaryPath: tunnel.binaryPath, credentialsPath: tunnel.credentialsPath, userData },
      tmpdir: deps.tmpdir || os.tmpdir(),
    });
  }

  const operation = (async () => {
    let configResult;
    try {
      configResult = (deps.readConfig || readConfig)(userData, deps);
    } catch {
      return refusalResult('state_unreadable', reason);
    }
    if (!configResult || typeof configResult !== 'object') return refusalResult('state_unreadable', reason);
    if (configResult.state === 'unreadable') return refusalResult('state_unreadable', reason);
    const refusal = refusalForStart({
      env,
      isPackaged,
      paths: { binaryPath: tunnel.binaryPath, credentialsPath: tunnel.credentialsPath, userData },
      tmpdir: deps.tmpdir || os.tmpdir(),
      enabled: true,
      config: configResult.config,
      setup: {
        binaryPath: tunnel.binaryPath,
        binaryTrusted: tunnel.binaryTrusted,
        credentialsPath: tunnel.credentialsPath,
        configValid: configResult.state === 'ok' || configResult.state === 'missing',
        socketUnavailable: tunnel.socketUnavailable,
        tunnelFailed: tunnel.tunnelFailed,
      },
      stateUnreadable: false,
    });
    if (refusal) return refusalResult(refusal, reason);
    state = 'starting';
    pauseCause = null;
    return { success: true, status: getHandoffBridgeStatus(), reason, testMode };
  })();
  startPromise = operation.finally(() => { startPromise = null; });
  return startPromise;
}

// main.js owns the one three-second timeout. The callback does exactly one
// pidfile stat and config read; it never invokes ps/reaping without a pidfile.
export function scheduleHandoffBridgeLaunch({
  userData = '',
  setTimeoutImpl = setTimeout,
  stat = async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  readConfig: loadConfig = readConfig,
  reapOrphans = async () => undefined,
  start = startHandoffBridge,
  delayMs = 3_000,
} = {}) {
  return setTimeoutImpl(async () => {
    const pidfile = path.join(userData, 'handoff-bridge', 'tunnel', 'tunnel.pid.json');
    let pidfileExists = false;
    try {
      await stat(pidfile);
      pidfileExists = true;
    } catch {
      // Missing or inaccessible pidfiles never cause launch-time ps activity.
    }
    let configResult;
    try {
      configResult = loadConfig(userData);
    } catch {
      return;
    }
    if (pidfileExists) {
      try { await reapOrphans({ reason: 'launch', pidfile }); } catch { return; }
    }
    if (configResult?.config?.autoStart) {
      try { void Promise.resolve(start({ reason: 'auto-start' })).catch(() => undefined); } catch { /* fire-and-forget */ }
    }
  }, delayMs);
}

export async function stopHandoffBridge() {
  state = 'off';
  pauseCause = null;
  stateBeforeQuit = null;
  delete globalThis.__icHandoffBridgeTest;
  return { success: true, status: getHandoffBridgeStatus() };
}

export async function holdHandoffBridgeForQuit() {
  if (state === 'off' || pauseCause === 'quit') return { success: true, status: getHandoffBridgeStatus() };
  stateBeforeQuit = { state, pauseCause };
  state = 'paused';
  pauseCause = 'quit';
  return { success: true, status: getHandoffBridgeStatus() };
}

export async function resumeHandoffBridgeAfterQuitCancel() {
  if (pauseCause === 'quit' && stateBeforeQuit) {
    state = stateBeforeQuit.state;
    pauseCause = stateBeforeQuit.pauseCause;
  }
  stateBeforeQuit = null;
  return { success: true, status: getHandoffBridgeStatus() };
}

export function __resetHandoffBridgeForTests() {
  registered = false;
  startPromise = null;
  state = 'off';
  pauseCause = null;
  stateBeforeQuit = null;
  delete globalThis.__icHandoffBridgeTest;
}
