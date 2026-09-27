import { assert } from './testHelpers.js';
import { CONSTANTS } from '../../electron/ipc/handoffBridge/constants.js';
import { createHandoffBridgeController } from '../../electron/ipc/handoffBridge/controller.js';
import { createOAuthServer } from '../../electron/ipc/handoffBridge/oauth.js';
import { createPairingOrchestrator, ownEgressMatches } from '../../electron/ipc/handoffBridge/pairing.js';
import { PROBE_MAX_BYTES, createProbeAuthenticator, probeOwnEgress, publicProbe, socketPublicProbe } from '../../electron/ipc/handoffBridge/egressProbe.js';
import { createHandoffBridgePower } from '../../electron/ipc/handoffBridge/power.js';
import { createHandoffBridgeTray, snapshotToTray } from '../../electron/ipc/handoffBridge/tray.js';
import { createHandoffBridgeDialogs } from '../../electron/ipc/handoffBridge/uiDialogs.js';
import { createHandoffBridgeLog } from '../../electron/ipc/handoffBridge/log.js';
import { composeHandoffBridge, registerHandoffBridgeHandlers, scheduleHandoffBridgeLaunch, startHandoffBridge, stopHandoffBridge } from '../../electron/ipc/handoffBridge/index.js';
import { createFakeClock } from './fixtures/handoff-bridge/fakeClock.js';
import { faultAt, withLeakCheck } from './fixtures/handoff-bridge/harness.js';

const HOST = 'bridge.example.com';
const JOB = '550e8400-e29b-41d4-a716-446655440000';
const NOOP = () => undefined;

function fakeTimers() {
  const timers = new Map(); let next = 0;
  const add = fn => { const id = ++next; timers.set(id, fn); return { id, unref: NOOP }; };
  return { setTimeout: add, setInterval: add, clearTimeout: id => timers.delete(id?.id ?? id), clearInterval: id => timers.delete(id?.id ?? id), pending: () => timers.size, fireAll: () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } } };
}

function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settle(turns = 8) {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

function enginePort(overrides = {}) {
  const calls = { get: 0, submit: 0, hold: 0, release: [] };
  return {
    calls,
    status: () => ({ queue: { applications: { ready: 1, working: 0, needsYou: 0, held: 0, done: 0 }, jobs: [{ jobId: JOB, phase: 'awaiting', stage: 'resume', servedToChat: 1, changedAt: 1 }] }, chat: { state: 'none', jobsCap: 2 }, counts: {} }),
    async get() { calls.get++; return { status: 'empty' }; }, async submit() { calls.submit++; return { status: 'accepted' }; },
    async release(value) { calls.release.push(value); return { ok: true }; }, async unrelease() { return { ok: true }; }, async hold() { calls.hold++; return { ok: true }; },
    async pause() { return { ok: true }; }, async resume() {}, async tick() {}, async close() {}, async clearPushHubs() { return { ok: true }; }, async revokeAll() { return { ok: true }; }, async setLimits() {},
    async newChat() { return { chatOrdinal: 1, starter: 'synthetic' }; }, async continueChat() { return { chatOrdinal: 2, starter: 'synthetic' }; }, ...overrides,
  };
}

function controllerHarness(overrides = {}) {
  let stamp = 1_000_000; const timers = overrides.timers || fakeTimers(); const currentNow = typeof overrides.now === 'function' ? overrides.now : () => stamp; const engine = overrides.engine || enginePort(); const auditLines = []; const notifications = [];
  const listener = { async start() { return { ok: true }; }, async stop() {}, async quiesce() {}, async drain() {} };
  const tunnel = { async start() { return { ok: true }; }, async stop() {}, status: () => ({ state: 'online', credentialsMode: 'ok' }) };
  const controller = createHandoffBridgeController({
    now: currentNow, timers, config: { hostname: HOST, limits: { idlePauseMinutes: 1440, releaseTtlHours: 24, chatKeyMaxAgeHours: 24, jobsPerChat: 2, epochSoftBytes: 500000, epochHardBytes: 750000 }, prefs: { sourcePolicy: 'enforce' } },
    windows: { getCanvasWindows: () => [{ webContents: { id: 7 } }] }, engine, listener, tunnel,
    store: { async setEnabled() { return true; } }, audit: { append: async (event, fields) => auditLines.push({ event, fields }), async flush() { return { ok: true }; } },
    ui: { confirmEnable: async () => ({ response: 1 }), confirmRestart: async () => ({ response: 1 }), notify: kind => notifications.push(kind) },
    selfProbe: async () => ({ ok: true }), publicProbe: async () => ({ ok: true }), sourcePolicy: async () => true,
    oauth: { linkStatus: () => [], pairingStatus: () => ({}), async revokeAll() { return { ok: true }; }, async closePairing() { return { ok: true }; }, async flush() { return { ok: true }; } }, ...overrides,
  });
  return { controller, engine, timers, auditLines, notifications, setNow: value => { stamp = value; }, now: currentNow };
}

function lifecycleHarness(overrides = {}) {
  const clock = createFakeClock(1_000_000);
  const lifecycle = { listener: false, child: false, pending: 0 };
  const track = fn => (...args) => {
    const value = fn(...args);
    lifecycle.pending += 1;
    return Promise.resolve(value).finally(() => { lifecycle.pending -= 1; });
  };
  const listener = {
    start: track(() => { lifecycle.listener = true; return { ok: true }; }),
    quiesce: track(NOOP), drain: track(NOOP), close: track(() => { lifecycle.listener = false; }),
  };
  const tunnel = {
    start: track(() => { lifecycle.child = true; return { ok: true }; }),
    stop: track(() => { lifecycle.child = false; }), status: () => ({ state: 'online' }),
  };
  const engine = enginePort();
  for (const method of ['get', 'submit', 'hold', 'pause', 'resume', 'tick', 'close', 'clearPushHubs', 'revokeAll', 'setLimits', 'release', 'unrelease']) {
    if (typeof engine[method] === 'function') engine[method] = track(engine[method]);
  }
  const store = { setEnabled: track(() => true) };
  const oauth = {
    linkStatus: () => [], pairingStatus: () => ({}), revokeAll: track(() => ({ ok: true })),
    closePairing: track(() => ({ ok: true })), flush: track(() => ({ ok: true })),
  };
  const ui = {
    confirmEnable: track(() => ({ response: 1 })), confirmRestart: track(() => ({ response: 1 })), notify: NOOP,
  };
  const selfProbe = track(() => ({ ok: true }));
  const publicProbe = track(() => ({ ok: true }));
  const applied = typeof overrides === 'function'
    ? overrides({ listener, tunnel, engine, store, oauth, ui, selfProbe, publicProbe }) || {}
    : overrides;
  const result = controllerHarness({ timers: clock, now: clock.now, listener, tunnel, engine, store, oauth, ui, selfProbe, publicProbe, ...applied });
  return { ...result, clock, lifecycle, ports: { listener, tunnel, engine, store, oauth, ui, selfProbe, publicProbe } };
}

function faultMethod(port, method, mode, kth = 1) {
  const injected = faultAt({ [method]: port[method] }, kth, { mode, error: new Error(`${method}-${mode}`) });
  return { ...port, [method]: injected.port[method] };
}

function faultFunction(fn, mode) {
  const injected = faultAt({ call: fn }, 1, { mode, error: new Error(`call-${mode}`) });
  return (...args) => injected.port.call(...args);
}

function assertLifecycleClear(harness, label) {
  assert(harness.clock.pendingCount() === 0 && harness.lifecycle.pending === 0 && !harness.lifecycle.listener && !harness.lifecycle.child,
    `${label} must leave no controller timer, pending port, listener, or child`);
}

function fakeRequest({ statusCode = 200, body = JSON.stringify({ resource: `https://${HOST}/mcp` }), capture = [] } = {}) {
  return (...args) => {
    const options = typeof args[0] === 'string' ? args[1] : args[0]; const callback = typeof args[0] === 'string' ? args[2] : args[1]; capture.push(options);
    const handlers = {}; return { on: (event, fn) => { handlers[event] = fn; }, setTimeout: (_ms, fn) => { handlers.timeout = fn; }, destroy: NOOP, end: () => {
      const responseHandlers = {}; const response = { statusCode, headers: {}, on: (event, fn) => { responseHandlers[event] = fn; }, resume: NOOP };
      callback(response); responseHandlers.data?.(Buffer.from(body)); responseHandlers.end?.();
    } };
  };
}

function closingRequest() {
  return (_options, callback) => {
    const handlers = {}; const responseHandlers = {};
    const response = { statusCode: 200, headers: {}, on: (event, fn) => { responseHandlers[event] = fn; }, resume: NOOP };
    return {
      on: (event, fn) => { handlers[event] = fn; }, setTimeout: NOOP, destroy: NOOP,
      end: () => { callback(response); responseHandlers.close?.(); },
    };
  };
}

function oauthResponse() {
  const headers = {};
  return {
    status: 0,
    headers,
    headersSent: false,
    writableEnded: false,
    text: '',
    setHeader(name, value) { headers[String(name).toLowerCase()] = String(value); },
    writeHead(status, values = {}) {
      this.status = status; this.headersSent = true;
      for (const [name, value] of Object.entries(values)) headers[String(name).toLowerCase()] = String(value);
    },
    end(value = '') { this.text += String(value); this.writableEnded = true; },
  };
}

async function authorizeGet(oauth, { source = '203.0.113.44', query = 'client_id=https%3A%2F%2Fsynthetic.example%2Fclient.json' } = {}) {
  const response = oauthResponse();
  await oauth.handle({ method: 'GET', url: `/oauth/authorize?${query}`, headers: { 'cf-connecting-ip': source } }, response, '/oauth/authorize', {
    rateFailure: () => false,
    observeAuthenticatedServerRoute: NOOP,
    source,
  });
  return response;
}

function scriptedProbeRequest(script, capture = []) {
  return (...args) => {
    const target = typeof args[0] === 'string' ? args[0] : null;
    const options = target === null ? args[0] : args[1];
    const callback = target === null ? args[1] : args[2];
    const handlers = {};
    let destroyed = 0;
    const request = {
      on(event, fn) { handlers[event] = fn; return request; },
      setTimeout(ms, fn) { handlers.requestTimeout = { ms, fn }; return request; },
      destroy() { destroyed += 1; },
      end() {
        script({
          target,
          options,
          callback,
          handlers,
          get destroyed() { return destroyed; },
          response({ statusCode = 200, headers = {}, chunks = [], end = true, event = null } = {}) {
            const responseHandlers = {};
            const response = {
              statusCode,
              headers,
              on(name, fn) { responseHandlers[name] = fn; return response; },
              resume: NOOP,
            };
            callback(response);
            for (const chunk of chunks) responseHandlers.data?.(chunk);
            if (end) responseHandlers.end?.();
            if (event) responseHandlers[event]?.();
          },
        });
      },
    };
    capture.push({ target, options, handlers, request, get destroyed() { return destroyed; } });
    return request;
  };
}

export default [
  { name: 'handoff bridge: controls: B0 pins the security and scheduling constants', run: () => {
    assert(CONSTANTS.MCP_AUTH_INFLIGHT === 24 && CONSTANTS.MCP_BODY_READ === 8, 'authenticated pool sizes must stay pinned');
    assert(CONSTANTS.ANON_BODY_READ === 3 && CONSTANTS.ANON_GET_INFLIGHT === 16, 'anonymous pools must stay isolated and pinned');
    assert(CONSTANTS.OAUTH_BODY_CAP_BYTES === 8 * 1024 && CONSTANTS.MAX_CONNECTIONS === 256, 'OAuth cap and server capacity must remain bounded');
    assert(CONSTANTS.KEEP_ALIVE_TIMEOUT_MS === 65_000 && CONSTANTS.INGRESS_KEEP_ALIVE_TIMEOUT_MS === 30_000, 'origin keep-alive must exceed tunnel ingress keep-alive');
    assert(CONSTANTS.REFRESH_IDLE_MS === 3 * 24 * 60 * 60_000 && CONSTANTS.REFRESH_ABSOLUTE_MS === 14 * 24 * 60 * 60_000, 'refresh lifetimes must stay 3d idle and 14d absolute');
    assert(CONSTANTS.IDLE_PAUSE_MINUTES === 1440 && CONSTANTS.KEEP_AWAKE_ENABLED === false, 'idle pause and keep-awake defaults must remain explicit');
  } },
  { name: 'handoff bridge: controls: authenticated outcomes, versions, and fixed faults project through one closed Activity logger', async run() {
    const lines = []; let getIndex = 0; let submitIndex = 0;
    const log = createHandoffBridgeLog({ logger: { info: line => lines.push(line) }, now: () => 1_000 });
    const engine = enginePort({
      async get() { return { status: ['waiting', 'queue_empty'][getIndex++] }; },
      async submit() { return { status: ['duplicate', 'junk', 'held'][submitIndex++] }; },
    });
    const h = controllerHarness({ engine, log });
    const context = { sourceAllowed: true, grant: { linkId: 'synthetic' }, session: 'synthetic', handoffCode: 'synthetic', response: 'synthetic' };
    assert((await h.controller.enable()).success, 'fixture must be live before the authenticated tool projection');
    assert((await h.controller.get(context)).status === 'waiting' && (await h.controller.get(context)).status === 'queue_empty', 'fixture get outcomes must reach the controller');
    for (const expected of ['duplicate', 'junk', 'held']) assert((await h.controller.submit(context)).status === expected, `${expected} submit fixture must reach the controller`);
    const items = h.controller.getActivity(); const kinds = new Set(items.map(item => item.kind));
    for (const kind of ['get-waiting', 'get-empty', 'submit-duplicate', 'submit-junk', 'submit-held']) assert(kinds.has(kind), `${kind} must be a closed Activity projection`);
    assert(h.controller.snapshot(false).activityVersion === log.getVersion() && items.every(item => !Object.hasOwn(item, 'message')),
      'status reads the logger version and activity never forwards arbitrary diagnostic fields');
    await h.controller.disable();

    const anonymousLines = []; const anonymousLog = createHandoffBridgeLog({ logger: { info: line => anonymousLines.push(line) }, now: () => 1 });
    const anonymous = controllerHarness({ log: anonymousLog, sourcePolicy: async () => false });
    await anonymous.controller.enable(); const before = JSON.stringify({ lines: anonymousLines, activity: anonymousLog.getRecent(), version: anonymousLog.getVersion() });
    assert((await anonymous.controller.get({ source: '203.0.113.8' })).status === 'unauthorized', 'wrong-network request remains anonymous and fixed');
    assert(JSON.stringify({ lines: anonymousLines, activity: anonymousLog.getRecent(), version: anonymousLog.getVersion() }) === before,
      'pre-auth source rejection cannot enter either app logger or Activity ring');
    await anonymous.controller.disable();

    const faultLines = []; const faultLog = createHandoffBridgeLog({ logger: { info: line => faultLines.push(line) }, now: () => 1 });
    const fault = controllerHarness({ log: faultLog, listener: { async start() { return false; }, async stop() {}, async quiesce() {}, async drain() {} } });
    assert((await fault.controller.enable()).code === 'socket_unavailable', 'fixture must produce the fixed controller listener fault');
    assert(faultLines.includes('[HandoffBridge] listener_error code=socket_unavailable') && !faultLines.some(line => line.includes('[HandoffBridge] socket_unavailable')),
      'controller faults must use a valid listener_error projection instead of an invalid free log code');
  } },
  { name: 'handoff bridge: controls: composition preserves an injected log port instead of replacing it', run: () => {
    const received = []; const injected = {
      record: (code, fields) => received.push({ code, fields }),
      getRecent: () => [{ kind: 'get-served', at: 1, outcome: 'served', message: 'must-not-cross' }],
      getVersion: () => 9,
    };
    const engine = enginePort();
    const graph = composeHandoffBridge({
      userData: '/tmp/ic-b6-injected-log',
      config: { hostname: HOST, scope: { applications: true, scoring: false }, limits: { idlePauseMinutes: 1440 }, prefs: { sourcePolicy: 'enforce', pairingNetworkCheck: true } },
      tunnelState: { binaryPath: '/tmp/fake-cloudflared', binaryTrusted: true, credentialsPath: '/tmp/fake-credentials' },
      deps: {
        log: injected, engine, laneStore: { loadLanes: () => [] }, application: { describeForConfirm: async () => ({ items: [] }) }, push: { get: async () => ({ status: 'queue_empty' }), submit: async () => ({ status: 'unknown_handoff' }) },
        audit: { append: async () => true }, oauth: { linkStatus: () => [], pairingStatus: () => ({}), authenticate: async () => null, closePairing: NOOP },
        listener: { start: async () => ({ ok: true }), stop: async () => undefined, status: () => ({}) },
        tunnel: { start: async () => ({ ok: true }), stop: async () => undefined, status: () => ({ state: 'off' }) },
        dialogs: { ask: async () => ({ ok: false }), showCode: async () => ({ ok: false }), showNotice: async () => ({ ok: true }) },
        power: { dispose: NOOP }, tray: { destroy: NOOP }, getCanvasWindows: () => [],
      },
    });
    try {
      assert(graph.log === injected && graph.controller.snapshot(false).activityVersion === 9,
        'a supplied test logger remains the exact shared graph logger and supplies status versioning');
      assert(JSON.stringify(graph.controller.getActivity()) === JSON.stringify([{ kind: 'get-served', at: 1, outcome: 'served' }]) && received.length === 0,
        'controller reads the injected activity projection without forwarding an arbitrary field or manufacturing a replacement record');
    } finally { graph.power.dispose?.(); graph.tray.destroy?.(); }
  } },
  { name: 'handoff bridge: controls: registration app logger is inherited by manual and scheduled starts', async run() {
    await stopHandoffBridge();
    const handlers = new Map(); const listeners = new Map();
    const ipc = {
      handle: (channel, fn) => handlers.set(channel, fn), removeHandler: channel => handlers.delete(channel),
      on: (channel, fn) => listeners.set(channel, fn), removeListener: channel => listeners.delete(channel),
      __getInvokeHandler: channel => handlers.get(channel),
    };
    const userData = '/tmp/ic-b6-app-logger'; const appLogger = { info: NOOP }; const captured = [];
    const config = { hostname: HOST, autoStart: true, scope: { applications: true, scoring: false }, limits: { idlePauseMinutes: 1440 }, prefs: { sourcePolicy: 'enforce', pairingNetworkCheck: true } };
    const runtime = () => ({
      controller: { snapshot: () => ({ enabled: false, serving: 'off', paused: false, pauseCause: null }), enable: async () => ({ success: true }), disable: async () => ({ success: true }), shutdownForQuit: async () => ({ success: true }) },
      listener: {}, tunnel: {}, power: { dispose: NOOP }, tray: { destroy: NOOP },
    });
    assert(registerHandoffBridgeHandlers({ ipcMain: ipc, deps: {
      userData, isPackaged: true, env: {}, appLogger, getCanvasWindows: () => [],
      tunnelState: { binaryPath: '/tmp/fake-cloudflared', binaryTrusted: true, credentialsPath: '/tmp/fake-credentials' },
      readConfig: () => ({ state: 'ok', config }),
      compose: value => { captured.push(value.deps); return runtime(); },
    } }), 'fixture registration must establish the inherited bootstrap dependency bag');
    try {
      assert((await startHandoffBridge({ reason: 'manual', deps: { userData, isPackaged: true, env: {}, enabled: true } })).success
        && captured[0]?.appLogger === appLogger,
      'a direct manual start merges the registered app logger into composition');
      await stopHandoffBridge();
      const launchTimers = [];
      scheduleHandoffBridgeLaunch({
        userData,
        setTimeoutImpl: fn => { launchTimers.push(fn); return { unref: NOOP }; },
        stat: async () => { throw new Error('no pidfile'); },
        readConfig: () => ({ state: 'ok', config }),
        start: ({ reason, deps }) => startHandoffBridge({ reason, deps: { ...deps, userData, isPackaged: true, env: {} } }),
      });
      await launchTimers[0](); await settle(20);
      assert(captured[1]?.appLogger === appLogger,
        'the auto-start path also merges the registered app logger rather than silently constructing an unconnected logger');
    } finally { await stopHandoffBridge(); handlers.clear(); listeners.clear(); }
  } },
  { name: 'handoff bridge: controls: composed pairing writes one code-free ledger and app-log lifecycle pair', async run() {
    const parent = { isDestroyed: () => false }; const sheet = deferred(); const audit = []; const lines = [];
    const graph = composeHandoffBridge({
      userData: '/tmp/ic-b6-pairing-lifecycle',
      config: { hostname: HOST, scope: { applications: true, scoring: false }, limits: { idlePauseMinutes: 1440 }, prefs: { sourcePolicy: 'enforce', pairingNetworkCheck: true } },
      tunnelState: { binaryPath: '/tmp/fake-cloudflared', binaryTrusted: true, credentialsPath: '/tmp/fake-credentials' },
      deps: {
        now: () => 1_000, timers: fakeTimers(), appLogger: { info: line => lines.push(line) },
        audit: { append: (event, fields, at) => { audit.push({ event, fields, at }); return Promise.resolve(true); } },
        oauth: { openPairing: () => '23456-789AB', closePairing: NOOP, linkStatus: () => [], pairingStatus: () => ({}), authenticate: async () => null },
        probeOwnEgress: async () => ({ ok: true }), engine: enginePort(), laneStore: { loadLanes: () => [] },
        application: { describeForConfirm: async () => ({ items: [] }) }, push: { get: async () => ({ status: 'queue_empty' }), submit: async () => ({ status: 'unknown_handoff' }) },
        listener: { start: async () => ({ ok: true }), stop: async () => undefined, status: () => ({}) },
        tunnel: { start: async () => ({ ok: true }), stop: async () => undefined, status: () => ({ state: 'off' }) },
        dialog: { showMessageBox: () => sheet.promise }, power: { dispose: NOOP }, tray: { destroy: NOOP }, getCanvasWindows: () => [parent],
      },
    });
    try {
      const probe = graph.pairing.probeAuthenticator.issue();
      assert(probe && graph.pairing.recordOwnEgress({ header: probe.header, address: '203.0.113.9' }), 'composition fixture must seed only an authenticated synthetic own-egress observation');
      assert((await graph.pairing.open({ hostname: HOST, parentWindow: parent })).ok, 'the real composed dialog port must open its native sheet');
      graph.pairing.cancel('linked'); graph.pairing.cancel('linked'); sheet.resolve({ response: 0 }); await settle();
      const lifecycle = audit.filter(entry => entry.event === 'pairing_opened' || entry.event === 'pairing_closed');
      assert(JSON.stringify(lifecycle) === JSON.stringify([
        { event: 'pairing_opened', fields: { cause: 'user' }, at: 1_000 },
        { event: 'pairing_closed', fields: { cause: 'linked' }, at: 1_000 },
      ]) && JSON.stringify(lines) === JSON.stringify([
        '[HandoffBridge] pairing_opened cause=user', '[HandoffBridge] pairing_closed cause=linked',
      ]), 'composition writes exactly one closed pairing lifecycle pair to its security ledger and app logger');
      assert(!JSON.stringify({ lifecycle, lines, activity: graph.log.getRecent() }).includes('23456'), 'the composition lifecycle path cannot retain or log the pairing code');
    } finally { graph.pairing.cancel(); graph.power.dispose?.(); graph.tray.destroy?.(); }
  } },
  { name: 'handoff bridge: controls: E1 cancel, start order and failure leave no serving transport', async run() {
    const cancelled = controllerHarness({ ui: { confirmEnable: async () => ({ response: 0 }) } });
    assert((await cancelled.controller.enable()).code === 'CANCELLED' && cancelled.controller.snapshot().serving === 'off', 'stub-default dialog cancellation must enable nothing');
    const order = []; const live = controllerHarness({ listener: { async start() { order.push('listener'); return { ok: true }; }, async quiesce() {}, async drain() {}, async stop() { order.push('listener-stop'); } }, tunnel: { async start() { order.push('tunnel'); return { ok: true }; }, async stop() { order.push('tunnel-stop'); }, status: () => ({ state: 'online' }) }, selfProbe: async () => { order.push('self'); return { ok: true }; }, publicProbe: async () => { order.push('public'); return { ok: true }; } });
    assert((await live.controller.enable()).success && order.join(',') === 'listener,self,tunnel,public', 'listener must self-probe before tunnel/public probe');
    await live.controller.disable(); assert(order.includes('tunnel-stop') && order.includes('listener-stop'), 'hard stop must stop both transport owners');
  } },
  { name: 'handoff bridge: controls: E3 source policy precedes authentication and never pauses', async run() {
    let authenticated = 0; const h = controllerHarness({ sourcePolicy: async () => false, oauth: { linkStatus: () => [], pairingStatus: () => ({}), authenticate: async () => { authenticated++; return { ok: true }; } } });
    await h.controller.enable(); const result = await h.controller.get({ source: '203.0.113.10', token: 'synthetic' });
    assert(result.status === 'unauthorized' && authenticated === 0, 'wrong network must be refused before token/key logic');
    assert(h.controller.snapshot().serving === 'live' && h.controller.snapshot().counts.sourceRejected === 1, 'source mismatch is counted and never pauses');
  } },
  { name: 'handoff bridge: controls: E15 zero canvas windows gates get and submit before adapters', async run() {
    const engine = enginePort(); const h = controllerHarness({ engine, windows: { getCanvasWindows: () => [] } }); await h.controller.enable();
    const get = await h.controller.get({ sourceAllowed: true }); const submit = await h.controller.submit({ sourceAllowed: true });
    assert(get.status === 'app_unavailable' && submit.status === 'app_unavailable' && engine.calls.get === 0 && engine.calls.submit === 0, 'window hold must precede every adapter call');
  } },
  { name: 'handoff bridge: controls: E7 credential anomalies pause only at threshold and slide', async run() {
    const h = controllerHarness(); await h.controller.enable();
    for (let index = 0; index < 4; index++) h.controller.onSecurityEvent({ authenticated: true, kind: 'unknown_key' });
    h.controller.onSecurityEvent({ authenticated: false, kind: 'unknown_key' }); assert(h.controller.snapshot().serving === 'live', 'anonymous noise never pauses');
    h.controller.onSecurityEvent({ authenticated: true, kind: 'unknown_key' }); assert(h.controller.snapshot().pauseCause === 'anomaly', 'fifth credential event pauses');
    await h.controller.resume(); h.setNow(h.now() + 10 * 60_000 + 1); h.controller.onSecurityEvent({ authenticated: true, kind: 'unknown_key' });
    assert(h.controller.snapshot().serving === 'live', 'expired anomaly window must not retain stale events');
  } },
  { name: 'handoff bridge: controls: every authenticated anomaly class pauses only at its documented threshold', async run() {
    for (const [kind, threshold] of [['unknown_handoff', 5], ['misrouted', 5], ['rate_limited', 50], ['held_cap', 3]]) {
      const h = controllerHarness(); await h.controller.enable();
      for (let index = 1; index < threshold; index += 1) h.controller.onSecurityEvent({ authenticated: true, kind });
      assert(h.controller.snapshot(false).serving === 'live', `${kind} below threshold must not pause`);
      h.controller.onSecurityEvent({ authenticated: true, kind });
      assert(h.controller.snapshot(false).pauseCause === 'anomaly', `${kind} threshold must pause`);
    }
  } },
  { name: 'handoff bridge: controls: every E7 anomaly window expires independently before its exact threshold can pause', async run() {
    const windowed = [
      ['unknown_key', 5, 10 * 60_000],
      ['unknown_handoff', 5, 10 * 60_000],
      ['misrouted', 5, 10 * 60_000],
      ['rate_limited', 50, 60_000],
      ['held_cap', 3, 60 * 60_000],
    ];
    for (const [kind, threshold, windowMs] of windowed) {
      const h = controllerHarness(); await h.controller.enable();
      for (let count = 1; count < threshold; count += 1) h.controller.onSecurityEvent({ authenticated: true, kind });
      assert(h.controller.snapshot(false).serving === 'live', `${kind} must remain live one event below its threshold`);
      h.setNow(h.now() + windowMs + 1);
      h.controller.onSecurityEvent({ authenticated: true, kind });
      assert(h.controller.snapshot(false).serving === 'live', `${kind} must discard events outside its sliding window`);
      for (let count = 2; count <= threshold; count += 1) {
        h.controller.onSecurityEvent({ authenticated: true, kind });
        assert(h.controller.snapshot(false).pauseCause === (count === threshold ? 'anomaly' : null),
          `${kind} must pause exactly on the ${threshold}th in-window authenticated event`);
      }
      await h.controller.disable();
    }
    for (const kind of ['refresh_reuse', 'code_reuse']) {
      let revocations = 0;
      const h = controllerHarness({ oauth: {
        linkStatus: () => [], pairingStatus: () => ({}),
        async revokeAll() { revocations += 1; return { ok: true }; },
        async closePairing() { return { ok: true }; }, async flush() { return { ok: true }; },
      } });
      await h.controller.enable();
      assert(h.controller.onSecurityEvent({ authenticated: true, kind }) === true, `${kind} is an immediate authenticated revocation class`);
      await settle(20);
      assert(revocations === 1 && h.controller.snapshot(false).pauseCause === 'revoked', `${kind} must revoke rather than share a threshold window`);
      await h.controller.disable();
    }
  } },
  { name: 'handoff bridge: controls: a resumed anomaly safely retriggers on the next thresholded event', async run() {
    const h = controllerHarness(); await h.controller.enable();
    for (let index = 0; index < 5; index += 1) h.controller.onSecurityEvent({ authenticated: true, kind: 'unknown_key' });
    await h.controller.resume();
    h.controller.onSecurityEvent({ authenticated: true, kind: 'unknown_key' });
    assert(h.controller.snapshot(false).pauseCause === 'anomaly', 'a live bridge must not get a free anomaly window after Resume');
  } },
  { name: 'handoff bridge: controls: anonymous security floods only increment closed counters and never pause', async run() {
    const h = controllerHarness(); await h.controller.enable();
    const kinds = ['unknown_key', 'unknown_handoff', 'misrouted', 'rate_limited', 'held_cap', 'refresh_reuse', 'code_reuse'];
    for (let index = 0; index < 50_000; index += 1) {
      h.controller.onSecurityEvent({ authenticated: false, kind: kinds[index % kinds.length] });
      h.controller.onAnonymous();
    }
    assert(h.controller.onTransportCount('mcp_anon') && h.controller.onTransportCount('host_mismatch')
      && h.controller.onTransportCount('source_mismatch') && h.controller.onTransportCount('permit_leak'), 'HTTP closed counter classes must be accepted');
    const status = h.controller.snapshot(false);
    assert(status.serving === 'live' && status.pauseCause === null && status.counts.anonymousRequests === 50_002
      && status.counts.sourceRejected === 1 && status.counts.permitLeaks === 1 && h.auditLines.length === 0,
    'anonymous noise must retain no anomaly state or audit/log side effect that can pause the bridge');
    await h.controller.disable();
  } },
  { name: 'handoff bridge: controls: pause fails closed while the bridge is off', async run() {
    let pauses = 0;
    const h = controllerHarness({ engine: enginePort({ async pause() { pauses += 1; return { ok: true }; } }) });
    const result = await h.controller.pause();
    assert(result.success === false && result.code === 'NOT_READY' && pauses === 0 && h.controller.snapshot(false).serving === 'off',
      'the off-state Pause IPC result must be NOT_READY without touching the engine');
  } },
  { name: 'handoff bridge: controls: status preserves renderer exit enums, push kind, and only safe sources', run: () => {
    const engine = enginePort({ status: () => ({ queue: { applications: {}, jobs: [] }, chat: { outstanding: { kind: 'push', task: 'job-scoring' }, jobsCap: 2 }, counts: {} }) });
    const h = controllerHarness({ engine, tunnel: { status: () => ({ state: 'failed', lastExit: 'unrequested-exit-loop' }) }, oauth: { linkStatus: () => [{ sources: ['203.0.113.0/24', 'Marisol Quenby', '999.999.999.0/24', '2001:db8:1234::/48'] }], pairingStatus: () => ({}) } });
    const status = h.controller.snapshot(false);
    assert(status.tunnel.lastExit === 'unrequested-exit-loop' && status.chat.outstanding.kind === 'push', 'controller status must remain in renderer vocabulary without relabeling push work');
    assert(JSON.stringify(status.link.sources) === JSON.stringify(['203.0.113.0/24', '2001:db8:1234::/48']), 'status must expose only canonical safe source prefixes');
  } },
  { name: 'handoff bridge: controls: teardown is ordered and start hangs time out with all owned ports closed', async run() {
    const order = [];
    const h = controllerHarness({
      listener: { start: () => new Promise(() => undefined), async quiesce() { order.push('quiesce'); }, async drain() { order.push('drain'); }, async close() { order.push('close'); } },
      tunnel: { async start() { order.push('start'); return { ok: true }; }, async stop() { order.push('tunnel-stop'); }, status: () => ({ state: 'off' }) },
    });
    const pending = h.controller.enable(); for (let index = 0; index < 8; index += 1) await Promise.resolve(); h.timers.fireAll();
    const result = await pending;
    assert(result.success === false && result.code === 'socket_unavailable', 'a hanging listener start must fail through the fixed socket code');
    assert(order.join(',') === 'quiesce,drain,tunnel-stop,close', 'every failed start must quiesce, drain, stop the child, then close the listener');
  } },
  { name: 'handoff bridge: controls: Disable fences a hung start immediately and late start completions cannot revive it', async run() {
    for (const phase of ['listener', 'tunnel', 'probe']) {
      const pending = deferred(); const order = []; const writes = [];
      const listener = {
        async start() { order.push('listener-start'); return phase === 'listener' ? pending.promise : { ok: true }; },
        async quiesce() { order.push('quiesce'); }, async drain() { order.push('drain'); }, async close() { order.push('close'); },
      };
      const tunnel = {
        async start() { order.push('tunnel-start'); return phase === 'tunnel' ? pending.promise : { ok: true }; },
        async stop() { order.push('tunnel-stop'); }, status: () => ({ state: 'off' }),
      };
      const h = controllerHarness({
        listener,
        tunnel,
        selfProbe: async () => ({ ok: true }),
        publicProbe: async () => { order.push('probe'); return phase === 'probe' ? pending.promise : { ok: true }; },
        store: { async setEnabled(value) { writes.push(value); return true; } },
      });
      const enabling = h.controller.enable();
      await settle(20);
      const target = phase === 'listener' ? 'listener-start' : phase === 'tunnel' ? 'tunnel-start' : 'probe';
      assert(order.includes(target), `${phase} fixture must reach its delayed startup port before Disable`);
      const disabling = h.controller.disable();
      assert(h.controller.snapshot(false).serving === 'off' && (await h.controller.get({ sourceAllowed: true })).status === 'app_unavailable', `${phase} Disable must close the accepting gate before any teardown await`);
      await disabling;
      pending.resolve({ ok: true });
      await enabling;
      await settle();
      assert(h.controller.snapshot(false).serving === 'off', `${phase} late completion must not make the bridge live`);
      assert(writes.includes(false) && writes.lastIndexOf(false) >= writes.lastIndexOf(true), `${phase} cancellation must leave the durable flag disabled`);
      assert(h.timers.pending() === 0, `${phase} cancellation must leave no controller timer behind`);
    }
  } },
  { name: 'handoff bridge: controls: one shutdown budget bounds every hung teardown owner and still attempts all ports', async run() {
    for (const hung of ['quiesce', 'drain', 'tunnel-stop', 'close', 'clear', 'pairing-close']) {
      const order = [];
      const listener = {
        async start() { return { ok: true }; },
        quiesce: () => { order.push('quiesce'); return hung === 'quiesce' ? new Promise(() => undefined) : Promise.resolve(); },
        drain: () => { order.push('drain'); return hung === 'drain' ? new Promise(() => undefined) : Promise.resolve(); },
        close: () => { order.push('close'); return hung === 'close' ? new Promise(() => undefined) : Promise.resolve(); },
      };
      const tunnel = { async start() { return { ok: true }; }, stop: () => { order.push('tunnel-stop'); return hung === 'tunnel-stop' ? new Promise(() => undefined) : Promise.resolve(); }, status: () => ({ state: 'off' }) };
      const engine = enginePort({ clearPushHubs: () => { order.push('clear'); return hung === 'clear' ? new Promise(() => undefined) : Promise.resolve({ ok: true }); } });
      const oauth = { linkStatus: () => [], pairingStatus: () => ({}), async revokeAll() { return { ok: true }; }, closePairing: () => { order.push('pairing-close'); return hung === 'pairing-close' ? new Promise(() => undefined) : Promise.resolve(true); }, async flush() { return { ok: true }; } };
      const h = controllerHarness({ listener, tunnel, engine, oauth });
      await h.controller.enable();
      const disabling = h.controller.disable();
      await settle(); h.timers.fireAll(); await settle();
      const result = await disabling;
      assert(result.success && h.controller.snapshot(false).serving === 'off', `${hung} teardown fault must still complete hard-off within the shared shutdown budget`);
      assert(['quiesce', 'drain', 'tunnel-stop', 'close', 'clear', 'pairing-close'].every(step => order.includes(step)), `${hung} must not prevent later cleanup owners from being attempted`);
      assert(h.timers.pending() === 0, `${hung} teardown must not leak controller timers after the shared budget`);
    }
  } },
  { name: 'handoff bridge: controls: Disable starts durable-off before teardown and shares its one deadline with persistence', async run() {
    await withLeakCheck(async () => {
      for (const persistence of ['reject', 'hang']) {
        const clock = createFakeClock(0); const order = []; const late = deferred();
        const listener = {
          async start() { return { ok: true }; }, async quiesce() { order.push('quiesce'); }, async drain() { order.push('drain'); }, async close() { order.push('close'); },
        };
        const tunnel = { async start() { return { ok: true }; }, async stop() { order.push('tunnel-stop'); }, status: () => ({ state: 'off' }) };
        const engine = enginePort({ async clearPushHubs() { order.push('clear'); return { ok: true }; } });
        const oauth = { linkStatus: () => [], pairingStatus: () => ({}), async revokeAll() { return { ok: true }; }, async closePairing() { order.push('pairing-close'); return { ok: true }; }, async flush() { return { ok: true }; } };
        const h = controllerHarness({
          now: clock.now, timers: clock, listener, tunnel, engine, oauth,
          store: { setEnabled: value => { order.push(`persist:${value}`); return value ? true : persistence === 'reject' ? Promise.reject(new Error('durable-off')) : late.promise; } },
        });
        await h.controller.enable();
        let settled = false; const stopping = h.controller.disable().then(value => { settled = true; return value; });
        assert(h.controller.snapshot(false).serving === 'off', `${persistence} must close the in-memory accepting gate synchronously`);
        await settle(20);
        assert(order.indexOf('persist:false') >= 0 && order.indexOf('persist:false') < order.indexOf('quiesce'), `${persistence} durable-off attempt must begin before teardown awaits`);
        assert(['quiesce', 'drain', 'tunnel-stop', 'close', 'clear', 'pairing-close'].every(step => order.includes(step)), `${persistence} must still attempt every teardown owner`);
        if (persistence === 'hang') {
          clock.advance(24_999); await settle();
          assert(!settled, 'a durable-off seam may use, but must not exceed, the one 25 second shutdown deadline');
          clock.advance(1); await settle();
        }
        const result = await stopping;
        assert(result.success === false && result.code === 'persist_failed' && clock.pendingCount() === 0, `${persistence} durable failure must be bounded and leave no controller timer`);
        if (persistence === 'hang') { late.reject(new Error('late durable-off')); await settle(); }
      }
      const clock = createFakeClock(0);
      const fast = controllerHarness({ now: clock.now, timers: clock, store: {} });
      await fast.controller.enable();
      assert((await fast.controller.disable()).success && clock.pendingCount() === 0, 'the absent production persistence seam remains a fast no-op');
    });
  } },
  { name: 'handoff bridge: controls: faultAt gate awaits leave the next get tick and Disable usable', async run() {
    await withLeakCheck(async () => {
      for (const mode of ['throw', 'reject']) {
        const scenarios = [
          { label: 'source policy', first: 'unauthorized', configure: () => ({ sourcePolicy: faultFunction(async () => true, mode) }) },
          { label: 'authenticate', first: 'unauthorized', configure: ports => ({ oauth: faultMethod(ports.oauth, 'authenticate', mode) }) },
          { label: 'deadline tick', first: 'app_unavailable', configure: ports => ({ engine: faultMethod(ports.engine, 'tick', mode) }) },
          { label: 'rate', first: 'rate_limited', configure: () => ({ rate: faultFunction(async () => true, mode) }) },
          { label: 'engine get', first: 'error_retryable', configure: ports => ({ engine: faultMethod(ports.engine, 'get', mode) }) },
        ];
        for (const scenario of scenarios) {
          const h = lifecycleHarness(ports => {
            const oauth = { ...ports.oauth, authenticate: async () => ({ linkId: 'synthetic' }) };
            return { oauth, ...scenario.configure({ ...ports, oauth }) };
          });
          assert((await h.controller.enable()).success, `${scenario.label}/${mode} fixture must reach live serving`);
          assert((await h.controller.get({ source: '203.0.113.10' })).status === scenario.first, `${scenario.label}/${mode} must become its fixed gate outcome`);
          assert((await h.controller.get({ source: '203.0.113.10' })).status === 'empty', `${scenario.label}/${mode} must leave the next get usable`);
          assert((await h.controller.tick()).success, `${scenario.label}/${mode} must leave the next tick usable`);
          assert((await h.controller.disable()).success, `${scenario.label}/${mode} must leave Disable usable`);
          await settle();
          assertLifecycleClear(h, `${scenario.label}/${mode}`);
        }
      }
    });
  } },
  { name: 'handoff bridge: controls: faultAt enable and Disable awaits recover without owned state', async run() {
    await withLeakCheck(async () => {
      for (const mode of ['throw', 'reject']) {
        const enableScenarios = [
          { label: 'config read', configure: ports => {
            const store = { ...ports.store, readConfig: async () => ({ config: { hostname: HOST } }) };
            return { store: faultMethod(store, 'readConfig', mode) };
          } },
          { label: 'engine limits', configure: ports => ({ engine: faultMethod(ports.engine, 'setLimits', mode) }) },
          { label: 'enable confirmation', configure: ports => ({ ui: faultMethod(ports.ui, 'confirmEnable', mode) }) },
          { label: 'durable enable', configure: ports => ({ store: faultMethod(ports.store, 'setEnabled', mode) }) },
          { label: 'listener start', configure: ports => ({ listener: faultMethod(ports.listener, 'start', mode) }) },
          { label: 'self probe', configure: ports => ({ selfProbe: faultFunction(ports.selfProbe, mode) }) },
          { label: 'tunnel start', configure: ports => ({ tunnel: faultMethod(ports.tunnel, 'start', mode) }) },
          { label: 'public probe', configure: ports => ({ publicProbe: faultFunction(ports.publicProbe, mode) }) },
        ];
        for (const scenario of enableScenarios) {
          const h = lifecycleHarness(ports => {
            const oauth = { ...ports.oauth, authenticate: async () => ({ linkId: 'synthetic' }) };
            return { oauth, ...scenario.configure({ ...ports, oauth }) };
          });
          assert((await h.controller.enable()).success === false, `${scenario.label}/${mode} must not leave a failed enable pending`);
          assert((await h.controller.enable()).success, `${scenario.label}/${mode} must allow a following enable`);
          assert((await h.controller.get({ source: '203.0.113.10' })).status === 'empty', `${scenario.label}/${mode} must leave the next get usable`);
          assert((await h.controller.tick()).success && (await h.controller.disable()).success, `${scenario.label}/${mode} must leave tick and Disable usable`);
          await settle();
          assertLifecycleClear(h, `${scenario.label}/${mode}`);
        }
        const disableScenarios = [
          { label: 'durable off', failed: true, configure: ports => ({ store: faultMethod(ports.store, 'setEnabled', mode, 2) }) },
          { label: 'quiesce', configure: ports => ({ listener: faultMethod(ports.listener, 'quiesce', mode) }) },
          { label: 'drain', configure: ports => ({ listener: faultMethod(ports.listener, 'drain', mode) }) },
          { label: 'tunnel stop', configure: ports => ({ tunnel: faultMethod(ports.tunnel, 'stop', mode) }) },
          { label: 'listener close', configure: ports => ({ listener: faultMethod(ports.listener, 'close', mode) }) },
          { label: 'clear push hubs', configure: ports => ({ engine: faultMethod(ports.engine, 'clearPushHubs', mode) }) },
          { label: 'pairing close', configure: ports => ({ oauth: faultMethod(ports.oauth, 'closePairing', mode) }) },
        ];
        for (const scenario of disableScenarios) {
          const h = lifecycleHarness(ports => {
            const oauth = { ...ports.oauth, authenticate: async () => ({ linkId: 'synthetic' }) };
            return { oauth, ...scenario.configure({ ...ports, oauth }) };
          });
          await h.controller.enable();
          const first = await h.controller.disable();
          assert(first.success === !scenario.failed && h.controller.snapshot(false).serving === 'off', `${scenario.label}/${mode} must retain the hard-off gate`);
          assert((await h.controller.get({ source: '203.0.113.10' })).status === 'app_unavailable', `${scenario.label}/${mode} must leave the next get closed but usable`);
          assert((await h.controller.tick()).success && (await h.controller.disable()).success, `${scenario.label}/${mode} must leave following tick and Disable usable`);
          await settle();
          assertLifecycleClear(h, `${scenario.label}/${mode}`);
        }
      }
    });
  } },
  { name: 'handoff bridge: controls: faultAt tick and quit hold resume never retain controller ownership', async run() {
    await withLeakCheck(async () => {
      for (const mode of ['throw', 'reject']) {
        const tick = lifecycleHarness(ports => ({ engine: faultMethod(ports.engine, 'tick', mode) }));
        await tick.controller.enable();
        assert((await tick.controller.tick()).success === false && (await tick.controller.tick()).success, `${mode} tick fault must leave the next tick usable`);
        await tick.controller.disable(); await settle(); assertLifecycleClear(tick, `${mode} tick`);

        for (const method of ['pause', 'resume']) {
          const h = lifecycleHarness(ports => {
            const oauth = { ...ports.oauth, authenticate: async () => ({ linkId: 'synthetic' }) };
            return { oauth, engine: faultMethod(ports.engine, method, mode) };
          });
          await h.controller.enable();
          assert((await h.controller.holdForQuit()).success && h.controller.snapshot(false).pauseCause === 'quit', `${method}/${mode} quit hold must close new calls`);
          const restored = await h.controller.resumeAfterQuitCancel();
          if (method === 'resume') assert(restored.success === false && (await h.controller.resumeAfterQuitCancel()).success, `${method}/${mode} retry must restore a cancelled quit`);
          else assert(restored.success, `${method}/${mode} hold failure is isolated from local quiescing`);
          assert((await h.controller.get({ source: '203.0.113.10' })).status === 'empty' && (await h.controller.tick()).success,
            `${method}/${mode} must leave the next get and tick usable`);
          assert((await h.controller.disable()).success, `${method}/${mode} must leave Disable usable`);
          await settle();
          assertLifecycleClear(h, `${method}/${mode} quit`);
        }
      }
    });
  } },
  { name: 'handoff bridge: controls: controller reloads persisted config before a real enable', async run() {
    const limits = [];
    const h = controllerHarness({
      config: { hostname: 'stale.example.com' },
      engine: enginePort({ async setLimits(value) { limits.push(value); } }),
      store: {
        async readConfig() { return { config: { hostname: 'loaded.example.com', limits: { idlePauseMinutes: 3 }, prefs: { sourcePolicy: 'off' } } }; },
        async setEnabled() { return true; },
      },
    });
    const result = await h.controller.enable();
    assert(result.success && h.controller.snapshot(false).config.hostname === 'loaded.example.com' && limits.some(value => value.idlePauseMinutes === 3), 'persisted config must replace the construction-time fallback before enable starts');
  } },
  { name: 'handoff bridge: controls: Forget requires an explicit durable config wipe after revocation and disable', async run() {
    let wipes = 0;
    const success = controllerHarness({ store: { async setEnabled() { return true; }, async forget() { wipes += 1; return true; } } });
    await success.controller.enable();
    const forgotten = await success.controller.forget();
    const forgottenStatus = success.controller.snapshot(false);
    assert(forgotten.success === true && wipes === 1 && forgottenStatus.serving === 'off' && forgottenStatus.config.hostname === null,
      'Forget must clear in-memory setup only after its durable config wipe succeeds');
    const failed = controllerHarness({ store: { async setEnabled() { return true; } } });
    await failed.controller.enable();
    const result = await failed.controller.forget();
    assert(result.success === false && result.code === 'persist_failed' && failed.controller.snapshot(false).serving === 'off', 'a missing or ambiguous wipe adapter must fail closed after making the bridge inert');
  } },
  { name: 'handoff bridge: controls: served-after-idle records only enumerated audit and activity facts', async run() {
    const records = []; const engine = enginePort({ async get() { return { status: 'served' }; } });
    const h = controllerHarness({ engine, log: { record: (code, fields) => records.push({ code, fields }) }, oauth: { linkStatus: () => [], pairingStatus: () => ({}), authenticate: async () => ({ linkId: 'synthetic' }) } });
    await h.controller.enable(); h.setNow(h.now() + 13 * 60 * 60_000);
    assert((await h.controller.get({ sourceAllowed: true })).status === 'served', 'fixture must serve after a human-idle interval');
    assert(h.notifications.includes('served-after-idle') && h.auditLines.some(line => line.event === 'served' && line.fields.outcome === 'served-after-idle')
      && records.some(line => line.code === 'tool_call' && line.fields.outcome === 'served-after-idle'),
    'served-after-idle must emit safe audit, Activity and notification facts');
  } },
  { name: 'handoff bridge: controls: served-after-idle emits one generic notification and serve ledger line per hour', async run() {
    const records = []; const engine = enginePort({ async get() { return { status: 'served' }; } });
    const h = controllerHarness({ engine, log: { record: (code, fields) => records.push({ code, fields }) } });
    await h.controller.enable();
    h.setNow(h.now() + 13 * 60 * 60_000);
    assert((await h.controller.get({ sourceAllowed: true, grant: { linkId: 'synthetic-link' } })).status === 'served', 'the first over-12h result must be served');
    h.setNow(h.now() + 60 * 60_000 - 1);
    assert((await h.controller.get({ sourceAllowed: true, grant: { linkId: 'synthetic-link' } })).status === 'served', 'a sub-hour follow-up must still be served');
    h.setNow(h.now() + 1);
    assert((await h.controller.get({ sourceAllowed: true, grant: { linkId: 'synthetic-link' } })).status === 'served', 'the one-hour boundary follow-up must still be served');
    await settle();
    const serveLines = h.auditLines.filter(line => line.event === 'served');
    const activity = records.filter(line => line.code === 'tool_call' && line.fields.outcome === 'served-after-idle');
    const expectedLedgerFields = JSON.stringify({ tool: 'get', outcome: 'served-after-idle', stage: 'none' });
    const expectedActivityFields = JSON.stringify({ tool: 'get', outcome: 'served-after-idle' });
    assert(JSON.stringify(h.notifications) === JSON.stringify(['served-after-idle', 'served-after-idle']),
      'the first served result notifies once, a result before one hour is suppressed, and the one-hour boundary repeats once');
    assert(serveLines.length === 2 && serveLines.every(line => JSON.stringify(line.fields) === expectedLedgerFields)
      && activity.length === 2 && activity.every(line => JSON.stringify(line.fields) === expectedActivityFields),
    'each generic notification must correspond to an actual closed serve-ledger line and Activity fact');
  } },
  { name: 'handoff bridge: controls: only a successful live pairing action resets the human deadline', async run() {
    const engine = enginePort({ async get() { return { status: 'served' }; } });
    const h = controllerHarness({ engine }); await h.controller.enable();
    h.setNow(h.now() + 13 * 60 * 60_000);
    h.controller.onAnonymous();
    assert((await h.controller.get({ sourceAllowed: true, grant: { linkId: 'synthetic-link' } })).status === 'served'
      && h.notifications.length === 1, 'an anonymous pairing-adjacent signal cannot reset the human idle/serve clock');
    assert(h.controller.notePairingAction() === true && h.controller.snapshot(false).serving === 'live',
      'only a completed main-owned pairing action may reset the live human clock');
    h.setNow(h.now() + 12 * 60 * 60_000);
    await h.controller.get({ sourceAllowed: true, grant: { linkId: 'synthetic-link' } });
    assert(h.notifications.length === 1, 'a successful pairing action suppresses the serve-after-idle notice through the strict 12-hour boundary');
    h.setNow(h.now() + 1);
    await h.controller.get({ sourceAllowed: true, grant: { linkId: 'synthetic-link' } });
    assert(h.notifications.length === 2, 'the reset clock must still notify once a served result is more than 12 hours after the successful pairing action');
    await h.controller.pause('user');
    assert(h.controller.notePairingAction() === true && h.controller.snapshot(false).pauseCause === 'user',
      'a successful pairing action records human presence but never silently lifts an existing pause');
    await h.controller.disable();
    assert(h.controller.notePairingAction() === false && h.controller.snapshot(false).serving === 'off',
      'failed or off-state pairing paths have no controller clock side effect');
  } },
  { name: 'handoff bridge: controls: manual enable is its once-per-launch restart confirmation', async run() {
    let enableConfirms = 0; let restartConfirms = 0;
    const h = controllerHarness({ ui: { confirmEnable: async () => { enableConfirms += 1; return { response: 1 }; }, confirmRestart: async () => { restartConfirms += 1; return { response: 1 }; } } });
    await h.controller.enable();
    assert(await h.controller.confirmRestart() && enableConfirms === 1 && restartConfirms === 0, 'manual enable must not prompt a second restart confirmation');
  } },
  { name: 'handoff bridge: controls: 2,000 authenticated calls cannot reset the human idle deadline', async run() {
    const h = controllerHarness(); await h.controller.enable();
    for (let index = 0; index < 2_000; index += 1) await h.controller.get({ sourceAllowed: true, grant: { linkId: 'synthetic' } });
    h.setNow(h.now() + 30 * 60 * 60_000); assert((await h.controller.tick()).success && h.controller.snapshot(false).pauseCause === 'idle', 'first tick after jump applies idle pause');
    assert(h.notifications.includes('bridge-on'), 'bridge-on nudge uses last human action, not RPC activity'); await h.controller.resume(); assert(h.controller.snapshot().serving === 'live', 'Resume lifts a soft idle pause');
  } },
  { name: 'handoff bridge: controls: a 30h first tick applies release lapse and advances the engine clock', async run() {
    const calls = []; const engine = enginePort({ async hold(...args) { calls.push(['hold', ...args]); return { ok: true }; }, async tick(stamp) { calls.push(['tick', stamp]); return { ok: true }; } });
    const h = controllerHarness({ engine, config: { hostname: HOST, limits: { releaseTtlHours: 1, idlePauseMinutes: 1440 }, prefs: { sourcePolicy: 'enforce' } } });
    await h.controller.enable(); await h.controller.release({ jobs: [{ jobId: JOB, canvasFilePath: '/tmp/synthetic.canvas' }] });
    h.setNow(h.now() + 30 * 60 * 60_000); await h.controller.tick();
    assert(calls.some(call => call[0] === 'hold' && call[2] === 'lapsed') && calls.some(call => call[0] === 'tick'), 'first post-sleep tick lapses released work and advances engine deadlines');
  } },
  { name: 'handoff bridge: controls: the first authenticated request after 30h applies lapse key expiry and idle together', async run() {
    const calls = []; let limits = null; let keyExpired = false; let authenticated = 0;
    const engine = enginePort({
      async setLimits(value) { limits = value; },
      async hold(jobId, reason) { calls.push(['hold', jobId, reason]); return { ok: true }; },
      async tick(stamp) {
        calls.push(['tick', stamp]);
        keyExpired = limits?.chatKeyMaxAgeHours === 24 && stamp >= 1_000_000 + 24 * 60 * 60_000;
        return { ok: true };
      },
      async get() { calls.push(['get']); return { status: 'served' }; },
    });
    const h = controllerHarness({
      engine,
      config: {
        hostname: HOST,
        limits: { releaseTtlHours: 24, chatKeyMaxAgeHours: 24, idlePauseMinutes: 1440, jobsPerChat: 2, epochSoftBytes: 500000, epochHardBytes: 750000 },
        prefs: { sourcePolicy: 'enforce' },
      },
      oauth: {
        linkStatus: () => [], pairingStatus: () => ({}),
        async authenticate() { authenticated += 1; return { linkId: 'synthetic-link' }; },
        async revokeAll() { return { ok: true }; }, async closePairing() { return { ok: true }; }, async flush() { return { ok: true }; },
      },
    });
    await h.controller.enable();
    assert((await h.controller.release({ jobs: [{ jobId: JOB, canvasFilePath: '/tmp/synthetic.canvas' }] })).ok, 'fixture must establish a released lane before the sleep jump');
    h.setNow(1_000_000 + 30 * 60 * 60_000);
    const result = await h.controller.get({ source: '203.0.113.44' });
    assert(result.status === 'paused' && result.reason === 'idle' && authenticated === 1,
      'the request-owned authenticated gate must reach deadline processing and stop at the idle soft pause');
    assert(keyExpired && calls.some(call => call[0] === 'hold' && call[1] === JOB && call[2] === 'lapsed')
      && calls.filter(call => call[0] === 'tick').length === 1 && !calls.some(call => call[0] === 'get'),
    'one request-owned clock pass must lapse release evidence, deliver key expiry to the engine, and fence the adapter');
  } },
  { name: 'handoff bridge: controls: E3 auto-start cannot serve until a restart confirmation', async run() {
    let confirms = 0; const h = controllerHarness({ ui: { confirmEnable: async () => ({ response: 1 }), confirmRestart: async () => { confirms++; return { response: 0 }; } } });
    assert((await h.controller.enable({ autoStart: true })).success && h.controller.snapshot().hold === 'restart', 'auto-start preserves restart hold');
    assert((await h.controller.continueChat()).code === 'DECLINED' && confirms === 1 && h.controller.snapshot().hold === 'restart', 'declined confirm leaves lanes held');
  } },
  { name: 'handoff bridge: controls: quit restores only its own pause cause', async run() {
    const h = controllerHarness(); await h.controller.enable(); await h.controller.holdForQuit(); await h.controller.resumeAfterQuitCancel(); assert(h.controller.snapshot().serving === 'live', 'cancelled quit restores live');
    await h.controller.pause('user'); await h.controller.holdForQuit(); await h.controller.resumeAfterQuitCancel(); assert(h.controller.snapshot().pauseCause === 'user', 'cancelled quit never erases a user pause');
  } },
  { name: 'handoff bridge: controls: status is closed and excludes free text and paths', run: () => {
    const engine = enginePort({ status: () => ({ queue: { jobs: [{ jobId: JOB, phase: 'awaiting', stage: 'resume', reason: 'secret prompt', servedToChat: 7, changedAt: 1 }] }, counts: {} }) });
    const h = controllerHarness({ engine, tunnel: { status: () => ({ state: 'online', credentialsMode: '0777', binary: { path: '/private/token', version: 'v', sha256Prefix: 'abc', approved: true } }) } }); const status = h.controller.snapshot(false);
    assert(!JSON.stringify(status).includes('/private/token') && !JSON.stringify(status).includes('secret prompt'), 'status excludes paths/free text');
    assert(status.v === 1 && status.power.keepAwake === false && Object.keys(status.power).length === 1, 'power exposes only the measured switch');
  } },
  { name: 'handoff bridge: controls: status drops tunnel identifiers and malformed binary/probe diagnostics', run: () => {
    const h = controllerHarness({ tunnel: { status: () => ({ state: 'online', tunnelId: '550e8400-e29b-41d4-a716-446655440000', binary: { approved: true, version: 'version from stderr', sha256Prefix: 'UPPERCASE' }, probe: { state: 'raw diagnostic', reason: 'secret /tmp/path' } }) } });
    const status = h.controller.snapshot(false);
    assert(status.tunnel.tunnelId === null && status.tunnel.binary.version === null && status.tunnel.binary.sha256Prefix === null && status.tunnel.probe.state === 'failing' && status.tunnel.probe.reason === 'other', 'status maps tunnel diagnostics into closed public values only');
  } },
  { name: 'handoff bridge: controls: revoke waits for every durable step and remains paused on a failed acknowledgement', async run() {
    const order = []; const h = controllerHarness({ engine: enginePort({ async pause() { order.push('pause'); return { ok: true }; }, async revokeAll() { order.push('release'); return { ok: true }; }, async clearPushHubs() { order.push('clear'); return { ok: true }; } }), oauth: { linkStatus: () => [], async revokeAll() { order.push('oauth-revoke'); return { ok: true }; }, async closePairing() { order.push('close'); return { ok: true }; }, async flush() { order.push('oauth-flush'); return { ok: false }; } }, audit: { append: async () => undefined, async flush() { order.push('audit-flush'); return { ok: true }; } } });
    await h.controller.enable(); const result = await h.controller.revokeAll();
    assert(result.success === false && h.controller.snapshot(false).pauseCause === 'revoked' && ['oauth-revoke', 'close', 'release', 'clear', 'oauth-flush'].every(step => order.includes(step)) && order.at(-1) === 'oauth-flush', 'a failed durable flush returns only after required prior revocation steps and remains fail-closed');
  } },
  { name: 'handoff bridge: controls: revoke accepts the real OAuth closePairing acknowledgement and flushes last', async run() {
    const order = [];
    const h = controllerHarness({
      engine: enginePort({ async pause() { order.push('pause'); return { ok: true }; }, async revokeAll() { order.push('release'); return { ok: true }; }, async clearPushHubs() { order.push('clear'); return { ok: true }; } }),
      oauth: {
        linkStatus: () => [], async revokeLink() { order.push('oauth-revoke'); return true; },
        closePairing() { order.push('close'); return true; }, async flush() { order.push('oauth-flush'); return true; },
      },
      audit: { append: async () => undefined, async flush() { order.push('audit-flush'); return true; } },
    });
    await h.controller.enable();
    const result = await h.controller.revokeAll();
    const durable = ['close', 'release', 'clear', 'oauth-flush', 'audit-flush'];
    assert(result.success && order.filter(step => step === 'pause').length === 1 && order.indexOf('pause') < order.indexOf('close')
      && durable.every((step, index) => order.indexOf(step) >= 0 && (index === 0 || order.indexOf(durable[index - 1]) < order.indexOf(step))),
    'revoke must perform exactly one durable engine pause before its real-shape OAuth close and ordered durable writes');
  } },
  { name: 'handoff bridge: controls: a closed authorize flood creates no fetch dialog or transaction', async run() {
    let metadataFetches = 0; let consentDialogs = 0; let unarmedSignals = 0;
    const oauth = createOAuthServer({
      issuer: `https://${HOST}`,
      pairingGate: () => false,
      fetchClientMetadata: async () => { metadataFetches += 1; return null; },
      fetchJwks: async () => null,
      onConsentRequested: () => { consentDialogs += 1; },
      onAuthorizeWithoutWindow: () => { unarmedSignals += 1; },
    });
    for (let index = 0; index < 500; index += 1) {
      const response = await authorizeGet(oauth, { source: '203.0.113.44' });
      assert(response.status === 403, 'every closed authorize request must receive the fixed 403 before query processing');
    }
    const stats = oauth.stats();
    assert(metadataFetches === 0 && consentDialogs === 0 && stats.pendingTransactions === 0 && stats.clients === 0 && stats.pairings === 0
      && unarmedSignals === 500, 'a closed authorize flood may increment only its bounded status counter, never fetch, dialog, or allocate a transaction');
  } },
  { name: 'handoff bridge: controls: a mismatched pairing network is 403 before fetch dialog or transaction', async run() {
    const stamp = 1_000_000; let pairing; let metadataFetches = 0; let consentDialogs = 0; let codeSheets = 0;
    const oauth = createOAuthServer({
      issuer: `https://${HOST}`,
      pairingGate: request => pairing?.pairingGate(request) === true,
      fetchClientMetadata: async () => { metadataFetches += 1; return null; },
      fetchJwks: async () => null,
      onConsentRequested: () => { consentDialogs += 1; },
    });
    pairing = createPairingOrchestrator({
      oauth,
      now: () => stamp,
      timers: fakeTimers(),
      egressProbe: async ({ authenticator }) => {
        const token = authenticator.issue();
        assert(token && pairing.recordOwnEgress({ header: token.header, address: '203.0.113.40' }), 'fixture must establish only its synthetic own-egress address');
        return { ok: true };
      },
      showCode: ({ onShown }) => { onShown?.(); codeSheets += 1; return new Promise(() => undefined); },
      showNotice: () => { consentDialogs += 1; },
    });
    assert((await pairing.open({ hostname: HOST, parentWindow: { isDestroyed: () => false } })).ok && codeSheets === 1,
      'fixture must open exactly one local pairing sheet before testing a foreign network');
    const before = oauth.stats();
    const response = await authorizeGet(oauth, { source: '203.0.113.41' });
    const after = oauth.stats();
    assert(response.status === 403 && metadataFetches === 0 && consentDialogs === 0 && codeSheets === 1,
      'a network mismatch must stop before metadata fetches or any additional native dialog');
    assert(before.pendingTransactions === 0 && after.pendingTransactions === 0 && before.pairings === 1 && after.pairings === 1,
      'a network mismatch must neither create a transaction nor consume the operator-owned pairing window');
    pairing.cancel();
  } },
  { name: 'handoff bridge: controls: pairing gates own network, expiry and reconnect hints', async run() {
    let now = 1; let shown = null; let hints = 0; const oauth = { openPairing: () => '23456-789AB', closePairing: NOOP }; let pairing;
    pairing = createPairingOrchestrator({ oauth, now: () => now, showCode: value => { shown = value.code; value.onShown?.(); return new Promise(() => undefined); }, egressProbe: async ({ authenticator }) => { const token = authenticator.issue(); pairing.recordOwnEgress({ header: token.header, address: '2001:db8:1:2::1' }); return { ok: true }; }, hint: () => { hints++; } });
    assert((await pairing.open({ hostname: HOST, parentWindow: { isDestroyed: () => false } })).ok && shown === '23456789AB', 'only sheet receives pairing code');
    assert(pairing.pairingGate({ source: '2001:db8:1:2::42' }) && !pairing.pairingGate({ source: '2001:db8:1:3::42' }), 'IPv6 pairing compares /64'); pairing.onDisconnected({ reason: 'refresh_expired' });
    assert(pairing.maybeHint({ source: '2001:db8:1:2::/64', linkState: 'needs-renewal', knownFamily: true }) && !pairing.maybeHint({ source: '2001:db8:1:2::42', linkState: 'needs-renewal', knownFamily: true }) && hints === 1, 'the HTTP IPv6 /64 source key is hintable and rate limited');
    now += 15 * 60_000 + 1; assert(!pairing.networkMatches('2001:db8:1:2::42'), 'egress expires after 15 minutes'); assert(ownEgressMatches('2001:db8::1', '2001:db8:0:0::2') && !ownEgressMatches('2001:db8::1', '2001:db9::2'), 'IPv6 comparison is /64');
  } },
  { name: 'handoff bridge: controls: pairing rejects an absent parent before probe or OAuth and expires without a request', async run() {
    let probes = 0; let opens = 0; let closes = 0; let aborted = 0; let expiry;
    const timers = { setTimeout: fn => { expiry = fn; return { unref() {} }; }, clearTimeout: () => { aborted++; } };
    const oauth = { openPairing: () => { opens++; return '23456-789AB'; }, closePairing: () => { closes++; } };
    let pairing;
    pairing = createPairingOrchestrator({ oauth, timers, egressProbe: async ({ authenticator }) => { probes++; pairing.recordOwnEgress({ header: authenticator.issue().header, address: '203.0.113.7' }); return { ok: true }; }, showCode: ({ onShown }) => { onShown?.(); return new Promise(() => undefined); } });
    assert((await pairing.open({ hostname: HOST })).code === 'NO_WINDOW' && probes === 0 && opens === 0, 'no parent must fail before network probe, OAuth transaction or code creation');
    const parent = { isDestroyed: () => false };
    assert((await pairing.open({ hostname: HOST, parentWindow: parent })).ok && probes === 1 && opens === 1, 'parented pairing may create its one code sheet');
    expiry();
    assert(!pairing.status().open && closes === 1 && aborted === 1, 'TTL expiry aborts/closes pairing even with no tick or request');
    let malformed; let malformedCloses = 0;
    malformed = createPairingOrchestrator({ oauth: { openPairing: () => '23456789AB', closePairing: () => { malformedCloses += 1; } }, timers, egressProbe: async ({ authenticator }) => { malformed.recordOwnEgress({ header: authenticator.issue().header, address: '203.0.113.8' }); return { ok: true }; } });
    assert((await malformed.open({ hostname: HOST, parentWindow: parent })).code === 'NOT_READY' && malformedCloses === 1, 'a malformed OAuth code is refused and immediately closes the hidden OAuth pairing');
  } },
  { name: 'handoff bridge: controls: one opening probe owns concurrent pairing opens', async run() {
    const pendingProbe = deferred(); let probes = 0; let oauthOpens = 0; let sheets = 0; let pairing;
    const parent = { isDestroyed: () => false };
    pairing = createPairingOrchestrator({
      oauth: { openPairing: () => { oauthOpens += 1; return '23456-789AB'; }, closePairing: NOOP },
      egressProbe: async ({ authenticator }) => {
        probes += 1;
        const result = await pendingProbe.promise;
        const token = authenticator.issue();
        pairing.recordOwnEgress({ header: token?.header, address: '203.0.113.9' });
        return result;
      },
      showCode: ({ onShown }) => { onShown?.(); sheets += 1; return new Promise(() => undefined); },
    });
    const first = pairing.open({ hostname: HOST, parentWindow: parent });
    const second = await pairing.open({ hostname: HOST, parentWindow: parent });
    assert(second.code === 'BUSY' && probes === 1 && oauthOpens === 0 && sheets === 0, 'the in-flight probe must synchronously reject every concurrent opener');
    pendingProbe.resolve({ ok: true });
    const opened = await first;
    assert(opened.ok && probes === 1 && oauthOpens === 1 && sheets === 1 && pairing.status().open, 'only the gate owner may create one OAuth code and one native sheet');
  } },
  { name: 'handoff bridge: controls: OAuth terminal pairing callbacks abort only local sheet state', async run() {
    let aborts = 0; let oauthCloses = 0; let pairing;
    const timers = fakeTimers();
    pairing = createPairingOrchestrator({
      timers,
      oauth: { openPairing: () => '23456-789AB', closePairing: () => { oauthCloses += 1; } },
      egressProbe: async ({ authenticator }) => {
        pairing.recordOwnEgress({ header: authenticator.issue()?.header, address: '203.0.113.10' });
        return { ok: true };
      },
      showCode: ({ signal, onShown }) => {
        signal?.addEventListener?.('abort', () => { aborts += 1; });
        onShown?.();
        return new Promise(() => undefined);
      },
    });
    assert((await pairing.open({ hostname: HOST, parentWindow: { isDestroyed: () => false } })).ok, 'fixture pairing opens its native sheet');
    assert(pairing.onOAuthPairingClosed('denied') && !pairing.status().open && aborts === 1 && oauthCloses === 0 && timers.pending() === 0,
      'deny callback must abort the native sheet/timer without recursively closing OAuth');
    assert((await pairing.open({ hostname: HOST, parentWindow: { isDestroyed: () => false } })).ok, 'the next user-authorized pairing can open after denial');
    assert(pairing.onOAuthPairingClosed('locked') && !pairing.status().open && aborts === 2 && oauthCloses === 0 && timers.pending() === 0,
      'the fifteenth-wrong-code callback must close the second native sheet without reentering OAuth');
    assert(pairing.onOAuthPairingClosed('unknown') === false, 'the pairing callback accepts only the closed enum');
  } },
  { name: 'handoff bridge: controls: probe nonce issuance prunes expiry and fails closed at a tiny cap', run: () => {
    let stamp = 10; let sequence = 0;
    const authenticator = createProbeAuthenticator({ now: () => stamp, randomBytes: size => Buffer.alloc(size, ++sequence) });
    const issued = Array.from({ length: 8 }, () => authenticator.issue({ ttlMs: 5 }));
    assert(issued.every(Boolean) && authenticator.issue({ ttlMs: 5 }) === null, 'eight live missed observations are the explicit fail-closed cap');
    stamp = 16;
    const renewed = authenticator.issue({ ttlMs: 5 });
    assert(renewed && !authenticator.verify(issued[0].header), 'issue must prune expired nonces before admitting a fresh probe');
    assert(JSON.stringify(Object.keys(authenticator).sort()) === JSON.stringify(['clearExpired', 'issue', 'verify']), 'probe authentication exposes no nonce count, expiry diagnostics, or secret');
  } },
  { name: 'handoff bridge: controls: a forged own-egress HMAC cannot add or consume an observation', run: () => {
    let stamp = 1_000_000; let publishes = 0;
    const authenticator = createProbeAuthenticator({
      key: Buffer.alloc(32, 7),
      now: () => stamp,
      randomBytes: size => Buffer.alloc(size, 9),
    });
    const pairing = createPairingOrchestrator({ authenticator, now: () => stamp, onState: () => { publishes += 1; } });
    const token = authenticator.issue();
    assert(token, 'fixture must issue its one synthetic observation token');
    const replacement = token.header.endsWith('A') ? 'B' : 'A';
    const forged = `${token.header.slice(0, -1)}${replacement}`;
    assert(pairing.recordOwnEgress({ header: forged, address: '203.0.113.40' }) === false
      && pairing.status().ownEgressFresh === false && pairing.networkMatches('203.0.113.40') === false && publishes === 0,
    'a forged HMAC must add no egress record, emit no pairing state, and expose no matching network');
    assert(pairing.recordOwnEgress({ header: token.header, address: '203.0.113.40' }) === true
      && pairing.networkMatches('203.0.113.40') && publishes === 1,
    'rejecting a forged header must not consume the valid one-shot observation that follows it');
  } },
  { name: 'handoff bridge: controls: a 500-request consent flood coalesces native notices', async run() {
    const sender = { id: 17, __isCanvasRenderer: true }; const parent = { webContents: sender, isDestroyed: () => false };
    const specs = []; let releaseCode;
    const dialogs = createHandoffBridgeDialogs({
      getCanvasWindows: () => [parent],
      dialog: { showMessageBox: (_window, spec) => {
        specs.push(spec);
        if (spec.title === 'ChatGPT pairing code') return new Promise(resolve => { releaseCode = resolve; });
        return Promise.resolve({ response: 0 });
      } },
    });
    const showing = dialogs.showCode({ parentWindow: parent, code: '23456789AB' });
    for (let index = 0; index < 500; index += 1) dialogs.showNotice({ parentWindow: parent, kind: 'link-requested' });
    for (let index = 0; index < 500; index += 1) dialogs.showNotice({ parentWindow: parent, kind: index % 2 ? 'linked' : 'pairing-closed' });
    releaseCode({ response: 0 });
    await showing;
    await new Promise(resolve => setImmediate(resolve));
    const notices = specs.filter(spec => spec.title === 'Handoff bridge');
    assert(notices.filter(spec => spec.message === 'ChatGPT is requesting access to the Handoff bridge.').length === 1 && notices.length <= 3,
      'a valid authorize flood retains one fixed consent notice and bounds every queued notice kind');
  } },
  { name: 'handoff bridge: controls: native hostname sheets reject non-boolean validator results', async run() {
    const sender = { id: 21, __isCanvasRenderer: true }; const parent = { webContents: sender, isDestroyed: () => false };
    let shown = 0;
    const dialogs = createHandoffBridgeDialogs({
      getCanvasWindows: () => [parent], validateHostname: () => 'hostile.example.com',
      dialog: { showMessageBox: async () => { shown += 1; return { response: 1 }; } },
    });
    const result = await dialogs.ask(sender, 'hostname', { hostname: 'hostile.example.com' });
    assert(result.code === 'INVALID' && shown === 0, 'a string validator result must not become native hostname copy');
  } },
  { name: 'handoff bridge: controls: public probes are bounded dual-family and socket-only in test mode', async run() {
    const requests = []; const own = await probeOwnEgress({ hostname: HOST, request: fakeRequest({ capture: requests }), authenticator: { issue: () => ({ nonce: 'n', header: 'n.m' }) }, lookup: (_h, _o, cb) => cb(null, '203.0.113.5', 4) });
    assert(own.ok && requests.length === 2 && requests.map(value => value.family).join(',') === '4,6' && requests.every(value => !Object.hasOwn(value, 'rejectUnauthorized')), 'egress tries v4/v6 and never weakens TLS');
    const socketOptions = []; const socket = await socketPublicProbe({ request: fakeRequest({ capture: socketOptions }), socketPath: '/tmp/synthetic.sock', hostname: HOST });
    assert(socket.ok && socketOptions[0].socketPath === '/tmp/synthetic.sock' && !Object.hasOwn(socketOptions[0], 'host') && !Object.hasOwn(socketOptions[0], 'port'), 'test mode public probe must use only socketPath');
    const privateRequests = []; await publicProbe({ hostname: HOST, request: fakeRequest({ capture: privateRequests }), lookup: (_h, _o, cb) => cb(null, '127.0.0.1', 4) });
    let lookupError = null; privateRequests[0].lookup(HOST, {}, error => { lookupError = error; }); assert(lookupError, 'public probe lookup refuses loopback DNS before a connection');
  } },
  { name: 'handoff bridge: controls: egress public and socket probes classify guarded DNS cap timeout origin and refusal without hostname dialing', async run() {
    let privateLookupCalls = 0; let privateConnections = 0;
    const privateCapture = [];
    const privateDns = await publicProbe({
      hostname: HOST,
      lookup: (hostname, options, callback) => {
        privateLookupCalls += 1;
        assert(hostname === HOST && options.all === true && options.verbatim === true, 'the public probe must give the TLS lookup a guarded all-address resolver');
        callback(null, [{ address: '127.0.0.1', family: 4 }]);
      },
      request: scriptedProbeRequest(({ options, handlers }) => {
        options.lookup(HOST, {}, error => {
          if (!error) privateConnections += 1;
          handlers.error?.(error);
        });
      }, privateCapture),
    });
    assert(privateDns.ok === false && privateDns.code === 'hostname-not-public' && privateLookupCalls === 1 && privateConnections === 0
      && privateCapture[0].destroyed === 1, 'a private DNS answer must be refused by the guarded lookup before any public hostname connection');

    const capCapture = []; const capTimers = [];
    const capped = await publicProbe({
      hostname: HOST,
      lookup: () => { throw new Error('the body-cap fixture must not resolve a hostname'); },
      request: scriptedProbeRequest(({ response }) => response({ chunks: [Buffer.alloc(PROBE_MAX_BYTES), Buffer.from('x')] }), capCapture),
      setTimeoutImpl: (fn, ms) => { const timer = { fn, ms }; capTimers.push(timer); return timer; },
      clearTimeoutImpl: timer => { timer.cleared = true; },
    });
    assert(capped.ok === false && capped.code === 'too_large' && capCapture[0].destroyed === 1 && capTimers.length === 1 && capTimers[0].cleared,
      'a public probe body beyond the fixed 16 KiB cap must destroy the request and clear its deadline');

    const refusedCapture = [];
    const refused = await publicProbe({
      hostname: HOST,
      lookup: () => { throw new Error('the refusal fixture must not resolve a hostname'); },
      request: scriptedProbeRequest(({ handlers }) => { handlers.error?.({ code: 'ECONNREFUSED' }); }, refusedCapture),
    });
    assert(refused.ok === false && refused.code === 'refused' && refusedCapture[0].target === `https://${HOST}/.well-known/oauth-protected-resource/mcp`
      && refusedCapture[0].options.servername === HOST && !Object.hasOwn(refusedCapture[0].options, 'rejectUnauthorized'),
    'a public refusal must retain default TLS verification and map to the closed refused class');

    let timeout = null; const timeoutClears = []; const timeoutCapture = [];
    const pendingTimeout = socketPublicProbe({
      request: scriptedProbeRequest(NOOP, timeoutCapture),
      socketPath: '/tmp/synthetic.sock',
      hostname: HOST,
      timeoutMs: 7,
      setTimeoutImpl: (fn, ms) => { timeout = { fn, ms }; return 'socket-deadline'; },
      clearTimeoutImpl: value => timeoutClears.push(value),
    });
    await settle();
    assert(timeout?.ms === 7 && timeoutCapture[0].target === null, 'the socket probe must arm its injected bounded deadline without a hostname target');
    timeout.fn();
    const timedOut = await pendingTimeout;
    assert(timedOut.ok === false && timedOut.code === 'timeout' && timeoutCapture[0].destroyed === 1 && timeoutClears.includes('socket-deadline'),
      'a socket probe timeout must destroy its request and settle in the fixed timeout class');

    const socketCapture = [];
    const wrongOrigin = await socketPublicProbe({
      request: scriptedProbeRequest(({ target, options, response }) => {
        assert(target === null && options.socketPath === '/tmp/synthetic.sock' && options.headers.host === HOST
          && !Object.hasOwn(options, 'host') && !Object.hasOwn(options, 'hostname') && !Object.hasOwn(options, 'port') && !Object.hasOwn(options, 'lookup'),
        'the test-mode socket probe must not resolve or connect to a hostname');
        response({ chunks: [Buffer.from(JSON.stringify({ resource: 'https://wrong-origin.synthetic/mcp' }))] });
      }, socketCapture),
      socketPath: '/tmp/synthetic.sock',
      hostname: HOST,
    });
    assert(wrongOrigin.ok === false && wrongOrigin.code === 'wrong-origin' && socketCapture.length === 1,
      'a socket response from the wrong protected-resource origin must fail closed without hostname dialing');
  } },
  { name: 'handoff bridge: controls: bounded probe settles a close without leaking a timeout', async run() {
    const cleared = []; const result = await socketPublicProbe({ request: closingRequest(), socketPath: '/tmp/synthetic.sock', hostname: HOST, setTimeoutImpl: () => 'fallback', clearTimeoutImpl: value => cleared.push(value) });
    assert(result.ok === false && result.code === 'edge-unreachable' && cleared.includes('fallback'), 'closed response is a fixed probe failure and clears its fallback timeout');
  } },
  { name: 'handoff bridge: controls: E15 keep-awake is a strict no-op when disabled and owned-window scoped when enabled', run: () => {
    const offCalls = []; let offTimers = 0; const off = createHandoffBridgePower({ enabled: false, timers: { setTimeout: () => { offTimers += 1; return 1; }, clearTimeout: NOOP }, getCanvasWindows: () => [{ webContents: { id: 1, setBackgroundThrottling: value => offCalls.push(value) } }], powerSaveBlocker: { start: () => offCalls.push('start'), stop: () => offCalls.push('stop') } });
    off.update({ hostLane: true, recentChat: true, hostWindowIds: [1] }); off.stop(); assert(offCalls.length === 0, 'off switch may not even touch optional Electron power ports');
    assert(offTimers === 0, 'off switch must not schedule a keep-awake expiry timer');
    const calls = []; const first = { webContents: { id: 1, setBackgroundThrottling: value => calls.push(['throttle', 1, value]) } }; const second = { webContents: { id: 2, setBackgroundThrottling: value => calls.push(['throttle', 2, value]) } };
    const on = createHandoffBridgePower({ enabled: true, getCanvasWindows: () => [first, second], powerSaveBlocker: { start: kind => { calls.push(['start', kind]); return 4; }, stop: id => calls.push(['stop', id]) } });
    on.update({ hostLane: true, recentChat: false, hostWindowIds: [2] }); on.update({ hostLane: false, recentChat: false, hostWindowIds: [] });
    assert(JSON.stringify(calls) === JSON.stringify([['throttle', 2, false], ['start', 'prevent-app-suspension'], ['throttle', 2, true], ['stop', 4]]), 'enabled mode wakes only owning host window and releases every resource');
  } },
  { name: 'handoff bridge: controls: raw supervisor online is normalized to public up and only up lights the tray', run: () => {
    const h = controllerHarness({ tunnel: { status: () => ({ state: 'online', credentialsMode: 'ok' }) } });
    const status = h.controller.snapshot(false);
    assert(status.tunnel.state === 'up' && status.setup.tunnelReachable === true,
      'the raw online supervisor state must become public up without weakening setup reachability');
    for (const state of ['degraded', 'failed']) {
      const unreachable = controllerHarness({ tunnel: { status: () => ({ state, serving: 'live', credentialsMode: 'ok' }) } }).controller.snapshot(false);
      assert(unreachable.tunnel.state === state && unreachable.setup.tunnelReachable === false,
        `${state} may retain a local serving diagnostic but must never be a pairing-reachable public tunnel`);
    }
    assert(snapshotToTray({ enabled: true, serving: 'live', tunnel: { state: 'up' }, chat: { state: 'working' } }).glyph === 'active',
      'only the public up state may light an active tray glyph');
    for (const state of ['online', 'live', 'starting', 'degraded', 'failed', 'unknown', undefined]) {
      assert(snapshotToTray({ enabled: true, serving: 'live', tunnel: { state }, chat: { state: 'working' } }).glyph === 'idle',
        `${String(state)} must fail closed to an idle tray glyph`);
    }
  } },
  { name: 'handoff bridge: controls: tray transitions use closed icons, one link-expiry nudge, and unlinked recovery actions', async run() {
    const createdUris = []; const images = []; const badges = []; const menus = []; const opened = []; const nudges = []; let revoked = 0;
    class FakeTray {
      constructor(image) { images.push(['initial', image]); }
      on() {}
      setImage(image) { images.push(['update', image]); }
      setContextMenu(menu) { menus.push(menu); }
      setToolTip() {}
      destroy() {}
    }
    const tray = createHandoffBridgeTray({
      Tray: FakeTray,
      Menu: { buildFromTemplate: value => value },
      nativeImage: { createFromDataURL: uri => { createdUris.push(uri); return { uri }; } },
      app: { dock: { setBadge: badge => badges.push(badge) } },
      getCanvasWindows: () => [],
      controller: { pause: NOOP, resume: NOOP, disable: NOOP, revokeAll: () => { revoked += 1; } },
      onOpenPanel: value => opened.push(value), notify: kind => nudges.push(kind),
    });
    const base = { enabled: true, serving: 'live', tunnel: { state: 'off' }, chat: { state: 'none' }, link: { state: 'linked', expiresSoon: false } };
    tray.apply(base); tray.apply(base);
    assert(images.filter(([kind]) => kind === 'update').length === 0 && !menus.at(-1).some(item => item.label === 'Connect ChatGPT'),
      'an already-idle linked bridge has no redundant image update or reconnect action');
    tray.apply({ ...base, tunnel: { state: 'up' } });
    tray.apply({ ...base, tunnel: { state: 'up' }, chat: { state: 'working' } });
    tray.apply({ ...base, serving: 'paused', tunnel: { state: 'up' } });
    tray.apply({ ...base, serving: 'paused', tunnel: { state: 'up' }, alarms: [{ acknowledged: false }] });
    assert(images.filter(([kind]) => kind === 'update').length === 4 && new Set(createdUris).size === 5 && badges.includes('⏸') && badges.at(-1) === '!',
      'idle/live/active/paused/alarm use distinct embedded images and each glyph transition updates exactly once');
    tray.apply({ ...base, tunnel: { state: 'up' }, link: { state: 'unlinked', expiresSoon: false } });
    const recovery = menus.at(-1);
    await recovery.find(item => item.label === 'Connect ChatGPT').click();
    await recovery.find(item => item.label === 'Revoke all').click();
    assert(JSON.stringify(opened) === JSON.stringify([{ panel: 'bridge', step: 3 }]) && revoked === 1,
      'only an explicitly unlinked status offers the step-three connect recovery and Revoke all reaches the controller');
    const expiring = { ...base, tunnel: { state: 'up' }, link: { state: 'linked', expiresSoon: true } };
    tray.apply(expiring); tray.apply(expiring);
    tray.apply({ ...expiring, link: { state: 'linked', expiresSoon: false } });
    tray.apply(expiring);
    tray.apply({ ...expiring, enabled: false });
    tray.apply(expiring);
    assert(JSON.stringify(nudges) === JSON.stringify(['link-expiring', 'link-expiring', 'link-expiring']),
      'an expiring link gets one generic nudge per episode, reset only by renewal or bridge off');
    tray.destroy();
  } },
  { name: 'handoff bridge: controls: E15 awaiting work and recent calls have bounded keep-awake ownership', run: () => {
    let stamp = 1_000_000; const timers = []; const calls = [];
    const timerPort = {
      setTimeout(fn, ms) { const entry = { fn, ms, cleared: false, unref() {} }; timers.push(entry); return entry; },
      clearTimeout(entry) { if (entry) entry.cleared = true; },
    };
    const power = createHandoffBridgePower({ enabled: true, now: () => stamp, timers: timerPort,
      powerSaveBlocker: { start: kind => { calls.push(['start', kind]); return 12; }, stop: id => calls.push(['stop', id]) },
      getCanvasWindows: () => [{ webContents: { id: 1, setBackgroundThrottling: value => calls.push(['throttle', value]) } }],
    });
    power.update({ awaitingLane: true, hostLane: false, lastCallAt: null, hostWindowIds: [] });
    assert(power.isActive() && JSON.stringify(calls) === JSON.stringify([['start', 'prevent-app-suspension']]),
      'an awaiting lane starts the blocker without relaxing any renderer throttle');
    power.update({ awaitingLane: false, hostLane: false, lastCallAt: stamp, hostWindowIds: [] });
    const expiry = timers.at(-1);
    assert(expiry?.ms === CONSTANTS.KEEP_AWAKE_MINUTES * 60_000 && !expiry.cleared,
      'a recent bridge call schedules one bounded unref expiry');
    stamp += CONSTANTS.KEEP_AWAKE_MINUTES * 60_000;
    expiry.fn();
    assert(!power.isActive() && JSON.stringify(calls) === JSON.stringify([['start', 'prevent-app-suspension'], ['stop', 12]]),
      'the expiry releases the blocker without a controller status publication');
    power.update({ lastCallAt: stamp, hostWindowIds: [] });
    const pending = timers.at(-1); power.dispose();
    assert(pending.cleared, 'dispose clears a pending recent-call timer');
  } },
  { name: 'handoff bridge: controls: alarm visuals survive notification denial and tray confirms only with a parent', async run() {
    const calls = []; let resume = 0;
    const fakeTray = class { on() {} setContextMenu(menu) { calls.push(['menu', menu]); } setToolTip() {} destroy() {} };
    const tray = createHandoffBridgeTray({ Tray: fakeTray, Menu: { buildFromTemplate: value => value }, nativeImage: { createFromDataURL: () => ({}) }, app: { dock: { setBadge: value => calls.push(['badge', value]) } }, getCanvasWindows: () => [], controller: { resume: async () => { resume++; } }, dialogs: { ask: async () => ({ ok: true }) }, notify: () => { throw new Error('permission denied'); } });
    tray.alarm({ enabled: true, serving: 'paused', pauseCause: 'anomaly', alarms: [{ acknowledged: false }], tunnel: { state: 'up' } });
    assert(calls.some(value => JSON.stringify(value) === JSON.stringify(['badge', '!'])), 'notification denial cannot suppress Dock alarm badge');
    const menu = calls.find(value => value[0] === 'menu')[1]; const resumeItem = menu.find(item => item.label === 'Resume');
    assert(resumeItem.enabled === false, 'anomaly resume requiring a native sheet is disabled without a canvas parent');
    void resumeItem.click?.(); assert(resume === 0, 'tray never opens a parentless confirmation');
  } },
  { name: 'handoff bridge: controls: Tray anomaly Resume confirms once with a relevant closed alarm', async run() {
    const calls = []; let resumes = 0; const sender = { id: 7 }; const window = { webContents: sender, isDestroyed: () => false, show: () => calls.push('show'), focus: () => calls.push('focus') };
    const fakeTray = class { on() {} setContextMenu(menu) { calls.push(['menu', menu]); } setToolTip() {} destroy() {} };
    const tray = createHandoffBridgeTray({ Tray: fakeTray, Menu: { buildFromTemplate: value => value }, nativeImage: { createFromDataURL: () => ({}) }, app: { dock: { setBadge: NOOP } }, getCanvasWindows: () => [window], controller: { resume: async () => { resumes += 1; } }, dialogs: { ask: async (parent, kind, details) => { calls.push(['ask', parent, kind, details]); return { ok: true }; } } });
    tray.apply({ enabled: true, serving: 'paused', pauseCause: 'anomaly', alarms: [{ id: 'held_caps-20', kind: 'held_caps', at: 20, acknowledged: false, count: 999, remote: 'hostile' }], tunnel: { state: 'up' } });
    const resumeItem = calls.find(value => value[0] === 'menu')[1].find(item => item.label === 'Resume');
    await resumeItem.click();
    const ask = calls.find(value => value[0] === 'ask');
    assert(resumes === 1 && ask?.[1] === sender && JSON.stringify(ask.slice(2)) === JSON.stringify(['resume', { reason: 'anomaly', count: 3, minutes: 60, at: 20 }]), 'Tray must focus a canvas parent and issue one bounded native confirmation before resuming');
  } },
  { name: 'handoff bridge: controls: idle chat preparation resumes only the idle soft pause', async run() {
    const engine = enginePort({
      async prepareChat() { return { copied: true, sessionCode: 'SYNTHETIC', chatOrdinal: 1, commit: () => true }; },
    });
    const h = controllerHarness({ engine }); await h.controller.enable(); await h.controller.pause('idle');
    const prepared = await h.controller.prepareChat({ kind: 'new' });
    assert(prepared.copied === true && h.controller.snapshot(false).serving === 'live', 'a human new-chat action lifts idle only');
    await h.controller.pause('anomaly');
    const blocked = await h.controller.prepareChat({ kind: 'continue' });
    assert(blocked.status === 'paused' && blocked.reason === 'anomaly' && engine.calls.get === 0, 'anomaly pause cannot be bypassed by chat preparation');
  } },
  { name: 'handoff bridge: controls: alert source policy audits without rejecting and push keys remain controller-gated', async run() {
    const keys = [];
    const engine = enginePort({
      async refreshPushHubs() { return true; },
      async selectPushHubKey(key) { keys.push(key); return true; },
      async unselectPushHubKey(key) { keys.push(`-${key}`); return true; },
    });
    const h = controllerHarness({ engine, config: { hostname: HOST, scope: { applications: true, scoring: true }, limits: { idlePauseMinutes: 1440 }, prefs: { sourcePolicy: 'alert' } }, sourcePolicy: async () => false,
      oauth: { linkStatus: () => [], pairingStatus: () => ({}), authenticate: async () => ({ linkId: 'synthetic' }) } });
    await h.controller.enable();
    assert((await h.controller.get({ source: '203.0.113.10' })).status === 'empty' && h.controller.snapshot(false).serving === 'live', 'alert policy keeps a valid caller serving');
    assert(h.auditLines.some(line => line.event === 'source_mismatch'), 'alert policy records the fixed source-mismatch audit event');
    const key = 'a'.repeat(64);
    assert((await h.controller.releasePushHubs([key])).ok && keys[0] === key, 'opaque hub keys are selected by controller only');
    assert((await h.controller.unreleasePushHub(key)).ok && keys[1] === `-${key}`, 'unrelease uses the matching opaque key');
  } },
  { name: 'handoff bridge: controls: empty restart ords request all canonical restart lanes', async run() {
    let received = 'unset'; let described = null;
    const engine = enginePort({ async restartJobs(ords) { received = ords; return [{ ord: 3, jobId: JOB, canvasFilePath: '/tmp/canvas.ic' }]; } });
    const h = controllerHarness({ engine, describeRestart: ({ groups }) => { described = groups; return { items: [] }; } });
    await h.controller.enable();
    assert(received === undefined && described?.length === 1 && described[0].laneOrds[0] === 3,
      'empty restart details must mean all engine restart lanes, never an empty selection');
  } },
  { name: 'handoff bridge: controls: status preserves timestamped OAuth progress and exact hub keys only', run: () => {
    const exact = 'a'.repeat(64);
    const engine = enginePort({ status: () => ({ queue: { applications: {}, jobs: [], push: { selectedHubs: [exact, 'safe-but-not-a-hash'], discovered: [{ key: exact, pending: 1 }, { key: 'wrong', pending: 1 }] } }, chat: {}, counts: {} }) });
    const h = controllerHarness({ engine, oauth: { linkStatus: () => [{ progress: { discoveryFetched: 1234, approved: true } }], pairingStatus: () => ({}) } });
    const status = h.controller.snapshot(false);
    assert(status.link.progress.discoveryFetched === 1234 && status.link.progress.approved === true,
      'closed status must retain safe boolean-or-timestamp link progress');
    assert(JSON.stringify(status.push.selectedHubs) === JSON.stringify([exact]) && status.push.discovered.length === 1,
      'push hub keys must be exactly 64 lowercase hexadecimal characters');
  } },
  { name: 'handoff bridge: controls: starting public-probe state reaches no policy auth tick or engine port', async run() {
    const probe = deferred(); let policyCalls = 0; let authCalls = 0; let tickCalls = 0;
    const engine = enginePort({ async tick() { tickCalls++; } });
    const h = controllerHarness({ engine, publicProbe: async () => probe.promise,
      sourcePolicy: async () => { policyCalls++; return true; },
      oauth: { linkStatus: () => [], pairingStatus: () => ({}), authenticate: async () => { authCalls++; return { linkId: 'synthetic' }; } },
    });
    const enabling = h.controller.enable(); await settle(20);
    assert(h.controller.snapshot(false).serving === 'starting', 'fixture must pause at the public probe');
    const denied = await h.controller.get({ source: '203.0.113.10' });
    assert(denied.status === 'app_unavailable' && policyCalls === 0 && authCalls === 0 && tickCalls === 0 && engine.calls.get === 0,
      'starting is not a serving state and must not reach a policy, auth, tick, or engine adapter');
    probe.resolve({ ok: true }); assert((await enabling).success, 'probe completion must still make the original Enable live');
  } },
  { name: 'handoff bridge: controls: Disable invalidates deferred gate continuations before any engine request', async run() {
    // Each asynchronous policy boundary gets its own fixture. The old request
    // must never cross into an engine (or a replacement epoch) after Disable.
    const sourceGate = deferred();
    const source = controllerHarness({ sourcePolicy: async () => sourceGate.promise,
      oauth: { linkStatus: () => [], pairingStatus: () => ({}), authenticate: async () => ({ linkId: 'synthetic' }) } });
    await source.controller.enable(); const sourceRequest = source.controller.get({ source: '203.0.113.10' }); await settle(); await source.controller.disable(); sourceGate.resolve(true); await sourceRequest;
    assert(source.engine.calls.get === 0, 'Disable during source policy must stop the engine request');

    const authGate = deferred();
    const auth = controllerHarness({ oauth: { linkStatus: () => [], pairingStatus: () => ({}), authenticate: async () => authGate.promise } });
    await auth.controller.enable(); const authRequest = auth.controller.get({ source: '203.0.113.10' }); await settle(); await auth.controller.disable(); authGate.resolve({ linkId: 'synthetic' }); await authRequest;
    assert(auth.engine.calls.get === 0, 'Disable during bearer authentication must stop the engine request');

    let tickCalls = 0;
    const tick = controllerHarness({ engine: enginePort({ async tick() { tickCalls++; } }) });
    await tick.controller.enable(); const tickRequest = tick.controller.tick(); await tick.controller.disable(); await tickRequest;
    assert(tickCalls === 0, 'Disable before the tick continuation must stop its engine port call');

    const rateGate = deferred();
    const rate = controllerHarness({ rate: async () => rateGate.promise,
      oauth: { linkStatus: () => [], pairingStatus: () => ({}), authenticate: async () => ({ linkId: 'synthetic' }) } });
    await rate.controller.enable(); const rateRequest = rate.controller.get({ source: '203.0.113.10' }); await settle(); await rate.controller.disable(); rateGate.resolve(true); await rateRequest;
    assert(rate.engine.calls.get === 0, 'Disable during rate policy must stop the engine request');
  } },
  { name: 'handoff bridge: controls: deferred release and scope reload cannot mutate a disabled or replacement runtime', async run() {
    const releaseGate = deferred(); let releaseCalls = 0;
    const engine = enginePort({ async release() { releaseCalls++; return releaseGate.promise; } });
    const h = controllerHarness({ engine }); await h.controller.enable();
    const releasing = h.controller.release({ jobs: [{ jobId: JOB, canvasFilePath: '/tmp/bridge.canvas' }] }); await settle();
    await h.controller.disable(); releaseGate.resolve({ ok: true });
    assert((await releasing).code === 'NOT_READY' && releaseCalls === 1, 'a release that finishes after Disable must not report success into the old epoch');

    let config = { hostname: HOST, scope: { applications: false, scoring: true }, limits: { idlePauseMinutes: 1440 }, prefs: { sourcePolicy: 'enforce' } };
    const scopes = []; const scoped = controllerHarness({ getConfig: async () => config,
      engine: enginePort({ async setScope(value) { scopes.push(value); }, async release() { throw new Error('scope must block release'); } }) });
    await scoped.controller.enable();
    assert(scopes.some(value => value.applications === false && value.scoring === true), 'Enable must synchronize persisted scope into the engine before serving');
    assert((await scoped.controller.release({ jobs: [{ jobId: JOB, canvasFilePath: '/tmp/bridge.canvas' }] })).code === 'disabled', 'applications-off must block release at controller boundary');
    config = { ...config, scope: { applications: true, scoring: false } }; await scoped.controller.reloadConfig();
    assert(scopes.some(value => value.applications === true && value.scoring === false), 'reload must immediately synchronize an independent scope downgrade');
  } },
  { name: 'handoff bridge: controls: terminal lane pruning also drops release deadline evidence', async run() {
    let live = true; let holds = 0; const engine = enginePort({
      status: () => ({ queue: { applications: {}, jobs: live ? [{ jobId: JOB, phase: 'done' }] : [] }, chat: {}, counts: {} }),
      async tick() { live = false; }, async hold() { holds++; return { ok: true }; },
    });
    const h = controllerHarness({ engine, config: { hostname: HOST, limits: { idlePauseMinutes: 1440, releaseTtlHours: 24 }, prefs: { sourcePolicy: 'enforce' } } });
    await h.controller.enable(); await h.controller.release({ jobs: [{ jobId: JOB, canvasFilePath: '/tmp/bridge.canvas' }] });
    h.setNow(h.now() + 60 * 60_000); await h.controller.tick();
    h.setNow(h.now() + 24 * 60 * 60_000); await h.controller.tick();
    assert(holds === 0, 'once the engine prunes terminal evidence the controller must not retain an unbounded lapsed-release timer entry');
  } },
  { name: 'handoff bridge: controls: reconnect hint publishes status only and never opens a notification path', run: () => {
    const h = controllerHarness();
    const before = h.auditLines.length;
    assert(h.controller.onReconnectHint() === true && h.notifications.length === 0 && h.auditLines.length === before,
      'a qualified pairing reconnect hint may change status but has no panel, notification, audit, or logging side effect');
  } },
  { name: 'handoff bridge: controls: Disable cannot revive service through deferred resume or chat preparation paths', async run() {
    const ordinaryResume = deferred();
    const ordinary = controllerHarness({ engine: enginePort({ async resume() { return ordinaryResume.promise; } }) });
    await ordinary.controller.enable(); await ordinary.controller.pause('user');
    const resuming = ordinary.controller.resume(); await settle(); await ordinary.controller.disable(); ordinaryResume.resolve({ ok: true });
    assert((await resuming).success === false && ordinary.controller.snapshot(false).serving === 'off' && ordinary.controller.snapshot(false).enabled === false,
      'a stale ordinary Resume must not set live after Disable');

    const quitResume = deferred();
    const quit = controllerHarness({ engine: enginePort({ async resume() { return quitResume.promise; } }) });
    await quit.controller.enable(); await quit.controller.holdForQuit();
    const restoring = quit.controller.resumeAfterQuitCancel(); await settle(); await quit.controller.disable(); quitResume.resolve({ ok: true });
    assert((await restoring).success === false && quit.controller.snapshot(false).serving === 'off',
      'a stale quit-cancel resume must not restore live service after Disable');

    const idleResume = deferred(); let idlePrepared = 0;
    const idle = controllerHarness({ engine: enginePort({ async resume() { return idleResume.promise; }, async prepareChat() { idlePrepared++; return { copied: true, sessionCode: 'synthetic', chatOrdinal: 1, commit: () => true }; } }), restartConfirmed: true });
    await idle.controller.enable(); await idle.controller.pause('idle');
    const preparingIdle = idle.controller.prepareChat({ kind: 'new' }); await settle(); await idle.controller.disable(); idleResume.resolve({ ok: true });
    assert((await preparingIdle).status === 'app_unavailable' && idlePrepared === 0 && idle.controller.snapshot(false).serving === 'off',
      'Disable during idle auto-resume must not continue into engine.prepareChat');

    const confirmGate = deferred(); let confirmedPrepared = 0;
    const confirmed = controllerHarness({ engine: enginePort({ async prepareChat() { confirmedPrepared++; return { copied: true, sessionCode: 'synthetic', chatOrdinal: 1, commit: () => true }; } }), ui: { confirmRestart: async () => confirmGate.promise } });
    await confirmed.controller.enable(); const waitingConfirm = confirmed.controller.prepareChat({ kind: 'new' }); await settle(); await confirmed.controller.disable(); confirmGate.resolve({ response: 1 });
    assert((await waitingConfirm).status === 'app_unavailable' && confirmedPrepared === 0 && confirmed.controller.snapshot(false).serving === 'off',
      'Disable during restart confirmation must not mutate restart state or mint a prepared capability');

    const prepareGate = deferred();
    const latePrepared = controllerHarness({ engine: enginePort({ async prepareChat() { return prepareGate.promise; } }), restartConfirmed: true });
    await latePrepared.controller.enable(); const waitingPrepare = latePrepared.controller.prepareChat({ kind: 'new' }); await settle(); await latePrepared.controller.disable();
    prepareGate.resolve({ copied: true, sessionCode: 'synthetic', chatOrdinal: 1, commit: () => true });
    const result = await waitingPrepare;
    assert(result.status === 'app_unavailable' && result.commitToken === undefined && latePrepared.controller.snapshot(false).serving === 'off',
      'Disable during engine preparation must discard the late uncommitted capability');
  } },
  { name: 'handoff bridge: controls: stale async release, config, revoke, forget, and unrelease paths remain in their old lifecycle', async run() {
    const key = 'a'.repeat(64);
    const selectGate = deferred(); let selected = 0; let unselected = 0;
    const hubs = controllerHarness({
      config: { hostname: HOST, scope: { applications: true, scoring: true }, limits: { idlePauseMinutes: 1440 }, prefs: { sourcePolicy: 'enforce' } },
      engine: enginePort({
        async refreshPushHubs() { return true; },
        async selectPushHubKey() { await selectGate.promise; selected += 1; return true; },
        async unselectPushHubKey() { selected -= 1; unselected += 1; return true; },
      }),
    });
    await hubs.controller.enable(); const releasing = hubs.controller.releasePushHubs([key]); await settle(); await hubs.controller.disable(); selectGate.resolve();
    assert((await releasing).code === 'NOT_READY' && selected === 0 && unselected === 1,
      'a delayed hub selection after Disable is rolled back on its captured engine');

    const reloadGate = deferred(); let scopeCalls = 0; let limitCalls = 0;
    let persisted = { hostname: HOST, scope: { applications: true, scoring: false }, limits: { idlePauseMinutes: 1440 }, prefs: { sourcePolicy: 'enforce' } };
    const reloading = controllerHarness({ getConfig: async () => persisted, engine: enginePort({
      async setScope() { scopeCalls += 1; if (scopeCalls === 2) return reloadGate.promise; return true; },
      async setLimits() { limitCalls += 1; return true; },
    }) });
    await reloading.controller.enable(); const limitsBeforeReload = limitCalls;
    persisted = { ...persisted, scope: { applications: false, scoring: true } };
    const reload = reloading.controller.reloadConfig(); await settle(); await reloading.controller.disable(); reloadGate.resolve(true);
    assert((await reload).code === 'NOT_READY' && limitCalls === limitsBeforeReload,
      'Disable during a reload scope boundary cannot apply limits or publish a stale configuration');

    const unreleaseGate = deferred();
    const unrelease = controllerHarness({ engine: enginePort({ async unrelease() { return unreleaseGate.promise; } }) });
    await unrelease.controller.enable(); const removing = unrelease.controller.unrelease(JOB); await settle(); await unrelease.controller.disable(); unreleaseGate.resolve({ ok: true });
    assert((await removing).code === 'NOT_READY' && unrelease.controller.snapshot(false).serving === 'off',
      'a delayed unrelease cannot report or mutate after its engine has been disabled');

    const revokeGate = deferred(); let oauthRevokes = 0;
    const revoking = controllerHarness({ engine: enginePort({ async pause() { return revokeGate.promise; } }), oauth: {
      linkStatus: () => [], pairingStatus: () => ({}), authenticate: async () => ({ linkId: 'synthetic' }),
      async revokeAll() { oauthRevokes += 1; return { ok: true }; }, async closePairing() { return { ok: true }; }, async flush() { return { ok: true }; },
    } });
    await revoking.controller.enable(); const revoke = revoking.controller.revokeAll(); await settle(); await revoking.controller.disable(); revokeGate.resolve({ ok: true });
    assert((await revoke).code === 'NOT_READY' && oauthRevokes === 0,
      'Disable during revocation prevents later OAuth and engine cleanup calls from an old lifecycle');

    const forgetGate = deferred(); let wipes = 0;
    const forgetting = controllerHarness({ engine: enginePort({ async pause() { return forgetGate.promise; } }), store: {
      async setEnabled() { return true; }, async forget() { wipes += 1; return true; },
    } });
    await forgetting.controller.enable(); const forget = forgetting.controller.forget(); await settle(); await forgetting.controller.disable(); forgetGate.resolve({ ok: true });
    assert((await forget).code === 'NOT_READY' && wipes === 0,
      'a stale Forget operation never reaches the durable config wipe after external Disable');
  } },
  { name: 'handoff bridge: controls: delayed hub unselection cannot report success after Disable', async run() {
    const key = 'a'.repeat(64); const removal = deferred(); let calls = 0;
    const h = controllerHarness({
      config: { hostname: HOST, scope: { applications: true, scoring: true }, limits: { idlePauseMinutes: 1440 }, prefs: { sourcePolicy: 'enforce' } },
      engine: enginePort({ async unselectPushHubKey() { calls += 1; return removal.promise; } }),
    });
    await h.controller.enable();
    const pending = h.controller.unreleasePushHub(key); await settle();
    await h.controller.disable(); removal.resolve(true);
    assert((await pending).code === 'NOT_READY' && calls === 1 && h.controller.snapshot(false).serving === 'off',
      'an unselect completion from the old engine must not mutate or report success in a later lifecycle');
  } },
  { name: 'handoff bridge: controls: quit drains an admitted submit but Disable fences it immediately', async run() {
    const makeFixture = () => {
      const clock = createFakeClock(1_000_000); const admission = deferred(); const drained = deferred(); const order = [];
      let persisted = 0; let closed = 0;
      const engine = enginePort({
        async submit() {
          order.push('submit');
          await admission.promise;
          if (closed) return { status: 'retry' };
          persisted += 1; order.push('persist'); return { status: 'accepted' };
        },
        async close() { closed += 1; order.push('engine-close'); },
      });
      const listener = {
        async start() { return { ok: true }; },
        quiesce() { order.push('quiesce'); },
        drain() { order.push('drain'); return drained.promise; },
        async close() { order.push('listener-close'); },
      };
      const tunnel = { async start() { return { ok: true }; }, async stop() { order.push('tunnel-stop'); }, status: () => ({ state: 'online' }) };
      const harness = controllerHarness({ now: clock.now, timers: clock, engine, listener, tunnel });
      return {
        ...harness, clock, admission, drained, order,
        get persisted() { return persisted; }, get closed() { return closed; },
      };
    };
    const submitArgs = { sourceAllowed: true, grant: { linkId: 'synthetic' }, session: 'synthetic', handoffCode: 'synthetic', response: 'synthetic' };

    const graceful = makeFixture(); await graceful.controller.enable();
    const admitted = graceful.controller.submit(submitArgs); await settle();
    const stopping = graceful.controller.shutdownForQuit(); await settle();
    assert(graceful.controller.snapshot(false).serving === 'off' && graceful.closed === 0
      && graceful.order.includes('quiesce') && graceful.order.includes('drain'),
    'quit must synchronously refuse new work and quiesce, yet leave its admitted submit unfenced through drain');
    graceful.admission.resolve(); await settle(); graceful.drained.resolve(true);
    await stopping; await admitted;
    assert(graceful.persisted === 1 && graceful.closed >= 1
      && graceful.order.indexOf('persist') < graceful.order.indexOf('engine-close') && graceful.clock.pendingCount() === 0,
    'an admitted submit persists before graceful quit closes the engine and leaves no fake timer');

    const capped = makeFixture(); await capped.controller.enable();
    const late = capped.controller.submit(submitArgs); await settle();
    const cappedStop = capped.controller.shutdownForQuit(); await settle(); capped.clock.advance(10_000); await settle();
    await cappedStop;
    assert(capped.closed >= 1, 'the fixed 10 second drain sub-cap must fence the engine before late work can finish');
    capped.admission.resolve(); await late;
    assert(capped.persisted === 0 && capped.clock.pendingCount() === 0,
      'a submit that outlives the quit drain cap cannot persist after the engine fence');

    const hard = makeFixture(); await hard.controller.enable();
    const manual = hard.controller.submit(submitArgs); await settle();
    const disabled = hard.controller.disable();
    assert(hard.controller.snapshot(false).serving === 'off' && hard.closed >= 1,
      'interactive Disable must fence the engine synchronously rather than borrow quit grace');
    hard.admission.resolve(); hard.drained.resolve(true); await disabled; await manual;
    assert(hard.persisted === 0 && hard.clock.pendingCount() === 0,
      'manual Disable keeps the hard source fence even when a submit was already admitted');
  } },
  { name: 'handoff bridge: controls: pairing lifecycle logs only a real code sheet and closes it exactly once', async run() {
    const parent = { isDestroyed: () => false }; const events = []; const lines = []; const timers = fakeTimers(); const sheet = deferred();
    const log = createHandoffBridgeLog({ logger: { info: line => lines.push(line) }, now: () => 1_000 });
    const dialogs = createHandoffBridgeDialogs({
      getCanvasWindows: () => [parent],
      dialog: { showMessageBox: () => sheet.promise },
    });
    let pairing;
    const lifecycle = (event, cause) => {
      events.push({ event, cause });
      log.record(event, { cause });
    };
    pairing = createPairingOrchestrator({
      timers,
      oauth: { openPairing: () => '23456-789AB', closePairing: NOOP },
      egressProbe: async ({ authenticator }) => {
        const token = authenticator.issue();
        assert(token && pairing.recordOwnEgress({ header: token.header, address: '203.0.113.7' }), 'fixture must establish a synthetic egress observation');
        return { ok: true };
      },
      showCode: value => dialogs.showCode(value),
      onOpened: () => lifecycle('pairing_opened', 'user'),
      onClosed: cause => lifecycle('pairing_closed', cause),
    });
    assert((await pairing.open({ hostname: HOST, parentWindow: parent })).ok && pairing.status().open,
      'a native sheet accepted by the dialog adapter becomes a live pairing');
    assert(JSON.stringify(events) === JSON.stringify([{ event: 'pairing_opened', cause: 'user' }])
      && lines[0] === '[HandoffBridge] pairing_opened cause=user', 'only a live native sheet writes the opening security/app-log facts');
    pairing.cancel('linked'); pairing.cancel('linked'); sheet.resolve({ response: 0 }); await settle();
    assert(JSON.stringify(events) === JSON.stringify([{ event: 'pairing_opened', cause: 'user' }, { event: 'pairing_closed', cause: 'linked' }])
      && lines.filter(line => line === '[HandoffBridge] pairing_closed cause=linked').length === 1,
    'one real sheet emits exactly one closed lifecycle pair despite cancel and sheet completion racing');
    assert(!JSON.stringify({ events, lines, activity: log.getRecent() }).includes('23456'), 'pairing lifecycle facts never include the pairing code');

    let shown = 0; const dialogSheet = deferred();
    const callbackDialog = createHandoffBridgeDialogs({ getCanvasWindows: () => [parent], dialog: { showMessageBox: () => dialogSheet.promise } });
    const first = callbackDialog.showCode({ parentWindow: parent, code: '23456789AB', onShown: () => { shown += 1; } });
    assert(shown === 1, 'a successfully submitted native sheet must invoke its code-free shown callback once');
    assert((await callbackDialog.showCode({ parentWindow: parent, code: '23456789AB', onShown: () => { shown += 10; } })).code === 'BUSY' && shown === 1,
      'a busy native dialog must not claim a second live pairing sheet');
    dialogSheet.resolve({ response: 0 }); await first;
    assert((await callbackDialog.showCode({ parentWindow: parent, code: 'invalid', onShown: () => { shown += 10; } })).code === 'INVALID'
      && (await callbackDialog.showCode({ code: '23456789AB', onShown: () => { shown += 10; } })).code === 'NO_WINDOW' && shown === 1,
    'invalid and parentless code-sheet attempts must not invoke the lifecycle callback');

    const failedEvents = [];
    const makeFailedPairing = ({ oauthCode = '23456-789AB', showCode = async () => ({ ok: false }) } = {}) => {
      let candidate;
      candidate = createPairingOrchestrator({
        timers: fakeTimers(), oauth: { openPairing: () => oauthCode, closePairing: NOOP }, showCode,
        egressProbe: async ({ authenticator }) => {
          const token = authenticator.issue(); candidate.recordOwnEgress({ header: token.header, address: '203.0.113.8' }); return { ok: true };
        },
        onOpened: () => failedEvents.push('opened'), onClosed: () => failedEvents.push('closed'),
      });
      return candidate;
    };
    const absentParent = makeFailedPairing();
    assert((await absentParent.open({ hostname: HOST })).code === 'NO_WINDOW', 'a no-window open must fail before probe, OAuth, or native sheet');
    const malformed = makeFailedPairing({ oauthCode: '23456789AB' });
    assert((await malformed.open({ hostname: HOST, parentWindow: parent })).code === 'NOT_READY', 'a malformed OAuth pairing code must fail closed');
    const rejectedSheet = makeFailedPairing();
    await rejectedSheet.open({ hostname: HOST, parentWindow: parent }); await settle();
    assert(failedEvents.length === 0, 'no-window, malformed, and rejected-sheet opens emit neither pairing lifecycle fact');

    let unacknowledged; let oauthCloses = 0; let expiryTimers = 0; const unacknowledgedEvents = [];
    unacknowledged = createPairingOrchestrator({
      timers: { setTimeout: () => { expiryTimers += 1; return 1; }, clearTimeout: NOOP },
      oauth: { openPairing: () => '23456-789AB', closePairing: () => { oauthCloses += 1; } },
      // This adapter returns a promise but deliberately does not prove a
      // native sheet exists until a later turn. That acknowledgement is too
      // late to arm a code or lifecycle fact.
      showCode: value => { Promise.resolve().then(() => value.onShown?.()); return Promise.resolve({ ok: true }); },
      egressProbe: async ({ authenticator }) => {
        const token = authenticator.issue(); unacknowledged.recordOwnEgress({ header: token.header, address: '203.0.113.11' }); return { ok: true };
      },
      onOpened: () => unacknowledgedEvents.push('opened'), onClosed: () => unacknowledgedEvents.push('closed'),
    });
    const notLive = await unacknowledged.open({ hostname: HOST, parentWindow: parent }); await settle();
    assert(notLive.code === 'NOT_READY' && oauthCloses === 1 && expiryTimers === 0 && !unacknowledged.status().open
      && unacknowledgedEvents.length === 0,
    'an unacknowledged or late shown callback closes OAuth immediately without timer, code state, audit, logger, or lifecycle hook');

    let declinedCloses = 0; let declined;
    declined = createPairingOrchestrator({
      oauth: { openPairing: () => '23456-789AB', closePairing: () => { declinedCloses += 1; } },
      showCode: () => { throw new Error('sheet adapter refused'); },
      egressProbe: async ({ authenticator }) => {
        const token = authenticator.issue(); declined.recordOwnEgress({ header: token.header, address: '203.0.113.12' }); return { ok: true };
      },
    });
    assert((await declined.open({ hostname: HOST, parentWindow: parent })).code === 'DECLINED' && declinedCloses === 1 && !declined.status().open,
      'a synchronous sheet refusal has the fixed declined result and cannot leave an OAuth pairing code behind');
  } },
];
