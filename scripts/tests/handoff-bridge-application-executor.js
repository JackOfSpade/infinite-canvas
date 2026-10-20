import assert from 'node:assert/strict';
import { IPC_CHANNELS } from '../../electron/ipc/handoffBridge/contracts.js';
import { createHandoffBridgeController } from '../../electron/ipc/handoffBridge/controller.js';
import { registerHandoffBridgeUi } from '../../electron/ipc/handoffBridge/ui.js';

// The bridge stops taking APPLICATION jobs when a local Claude Code runner
// owns them ('claude-code'); every other task and the default are unchanged.
const HOST = 'bridge.example.com';
const JOB = '550e8400-e29b-41d4-a716-446655440000';
const PATH = '/tmp/synthetic.canvas';
const HUB = 'a'.repeat(64);
const NOOP = () => undefined;

function fakeTimers() {
  const timers = new Map(); let next = 0;
  const add = fn => { const id = ++next; timers.set(id, fn); return { id, unref: NOOP }; };
  return { setTimeout: add, setInterval: add, clearTimeout: id => timers.delete(id?.id ?? id), clearInterval: id => timers.delete(id?.id ?? id) };
}

function enginePort() {
  const calls = { release: [], selected: [] };
  return {
    calls,
    status: () => ({ queue: { applications: { ready: 0, working: 0, needsYou: 0, held: 0, done: 0 }, jobs: [] }, chat: { state: 'none', jobsCap: 2 }, counts: {} }),
    async get() { return { status: 'empty' }; }, async submit() { return { status: 'accepted' }; },
    async release(value) { calls.release.push(value); return { ok: true }; }, async unrelease() { return { ok: true }; }, async hold() { return { ok: true }; },
    async pause() { return { ok: true }; }, async resume() {}, async tick() {}, async close() {}, async clearPushHubs() { return { ok: true }; }, async revokeAll() { return { ok: true }; }, async setLimits() {},
    async refreshPushHubs() { return true; },
    async selectPushHubKey(key) { calls.selected.push(key); return true; },
    async unselectPushHubKey() { return true; },
    async newChat() { return { chatOrdinal: 1, starter: 'synthetic' }; }, async continueChat() { return { chatOrdinal: 2, starter: 'synthetic' }; },
  };
}

async function liveController(extra = {}) {
  const engine = enginePort();
  const controller = createHandoffBridgeController({
    now: () => 1_000_000, timers: fakeTimers(),
    config: { hostname: HOST, scope: { applications: true, scoring: true, marketplace: false }, limits: { idlePauseMinutes: 1440, releaseTtlHours: 24, chatKeyMaxAgeHours: 24, jobsPerChat: 2, epochSoftBytes: 500000, epochHardBytes: 750000 }, prefs: { sourcePolicy: 'enforce' } },
    windows: { getCanvasWindows: () => [{ webContents: { id: 7 } }] }, engine,
    listener: { async start() { return { ok: true }; }, async stop() {}, async quiesce() {}, async drain() { return true; } },
    tunnel: { async start() { return { ok: true }; }, async stop() {}, status: () => ({ state: 'online', credentialsMode: 'ok' }) },
    store: { async setEnabled() { return true; } }, audit: { append: async () => undefined, async flush() { return { ok: true }; } },
    ui: { confirmEnable: async () => ({ response: 1 }), confirmRestart: async () => ({ response: 1 }), notify: NOOP },
    selfProbe: async () => ({ ok: true }), publicProbe: async () => ({ ok: true }), sourcePolicy: async () => true,
    oauth: { linkStatus: () => [], pairingStatus: () => ({}), async revokeAll() { return { ok: true }; }, async closePairing() { return { ok: true }; }, async flush() { return { ok: true }; } },
    ...extra,
  });
  await controller.enable();
  return { controller, engine };
}

function uiHarness({ applicationExecutor, releases, describes, asks }) {
  const handlers = new Map(); const listeners = new Map();
  const ipc = { handle: (c, fn) => handlers.set(c, fn), removeHandler: c => handlers.delete(c), on: (c, fn) => listeners.set(c, fn), removeListener: (c, fn) => { if (listeners.get(c) === fn) listeners.delete(c); } };
  const sender = { id: 9, __isCanvasRenderer: true, sent: [], send(channel, value) { this.sent.push({ channel, value }); } };
  const window = { __canvasFilePath: PATH, webContents: sender, isDestroyed: () => false };
  const status = { enabled: true, serving: 'live', setup: { tunnelReachable: true }, config: { hostname: HOST, scope: { applications: true, scoring: false } }, prefs: {}, autoRelease: true, queue: { jobs: [] } };
  registerHandoffBridgeUi({
    ipc, getCanvasWindows: () => [window], processStartedAt: Date.parse('2026-01-01T00:00:00.000Z'),
    ...(applicationExecutor ? { applicationExecutor } : {}),
    controller: { snapshot: () => status, subscribe: () => NOOP, release: async value => { releases.push(value); return { success: true, ok: true, count: value.jobs.length }; } },
    dialogs: { ask: async () => { asks.push(1); return { ok: true }; }, choose: async () => ({ ok: true, filePath: '/tmp/file' }) },
    application: { describeForConfirm: async () => { describes.push(1); return { ok: true, canvasFilePath: PATH, items: [{ jobId: JOB, title: 'Ada', company: 'Example', createdAt: '2026-01-01T00:00:00.001Z' }] }; } },
    engine: { hold: async () => ({ ok: true }), resume: async () => ({ ok: true }) },
    store: { writeConfig: async () => ({ ok: true }) },
  });
  return { handlers, listeners, event: { sender } };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

export default [
  {
    name: 'handoff bridge executor: the default executor still releases applications to the engine',
    async run() {
      const { controller, engine } = await liveController();
      const result = await controller.release({ jobs: [{ jobId: JOB, canvasFilePath: PATH }] });
      assert.equal(result.ok, true);
      assert.equal(engine.calls.release.length, 1);
      assert.deepEqual(engine.calls.release[0].jobs, [{ jobId: JOB, canvasFilePath: PATH }]);
    },
  },
  {
    name: 'handoff bridge executor: claude-code refuses application releases without touching the engine',
    async run() {
      const { controller, engine } = await liveController({ applicationExecutor: 'claude-code' });
      const result = await controller.release({ jobs: [{ jobId: JOB, canvasFilePath: PATH }] });
      assert.deepEqual(result, { ok: false, code: 'disabled', reason: 'claude-code' });
      assert.equal(engine.calls.release.length, 0);
      const auto = await controller.release({ jobs: [{ jobId: JOB, canvasFilePath: PATH }], auto: true });
      assert.deepEqual(auto, { ok: false, code: 'disabled', reason: 'claude-code' });
      assert.equal(engine.calls.release.length, 0);
    },
  },
  {
    name: 'handoff bridge executor: claude-code still releases push hubs',
    async run() {
      const { controller, engine } = await liveController({ applicationExecutor: 'claude-code' });
      const result = await controller.releasePushHubs([HUB]);
      assert.equal(result.ok, true);
      assert.deepEqual(engine.calls.selected, [HUB]);
    },
  },
  {
    name: 'handoff bridge executor: the snapshot exposes the application executor',
    async run() {
      const claude = await liveController({ applicationExecutor: 'claude-code' });
      assert.equal(claude.controller.snapshot(false).applicationExecutor, 'claude-code');
      const fallback = await liveController();
      assert.equal(fallback.controller.snapshot(false).applicationExecutor, 'chatgpt-bridge');
      const unknown = await liveController({ applicationExecutor: 'something-else' });
      assert.equal(unknown.controller.snapshot(false).applicationExecutor, 'chatgpt-bridge');
    },
  },
  {
    name: 'handoff bridge executor: auto-release with claude-code makes zero release calls, the default still releases',
    async run() {
      const jobs = [{ jobId: JOB, canvasFilePath: PATH, dockState: 'awaiting', sig: 'auto' }];
      const claude = { releases: [], describes: [], asks: [] };
      const h = uiHarness({ applicationExecutor: 'claude-code', ...claude });
      for (let seq = 1; seq <= 3; seq += 1) { h.listeners.get(IPC_CHANNELS.PUBLISH_JOBS)(h.event, { v: 1, seq, jobs }); await flush(); }
      assert.equal(claude.releases.length, 0);
      assert.equal(claude.describes.length, 0);
      // Control: the same publication releases under the default executor.
      const bridge = { releases: [], describes: [], asks: [] };
      const d = uiHarness({ ...bridge });
      d.listeners.get(IPC_CHANNELS.PUBLISH_JOBS)(d.event, { v: 1, seq: 1, jobs }); await flush();
      assert.deepEqual(bridge.releases, [{ jobs: [{ jobId: JOB, canvasFilePath: PATH }], auto: true }]);
    },
  },
  {
    name: 'handoff bridge executor: manual release with claude-code returns DISABLED without a sheet or release',
    async run() {
      const claude = { releases: [], describes: [], asks: [] };
      const h = uiHarness({ applicationExecutor: 'claude-code', ...claude });
      const result = await h.handlers.get(IPC_CHANNELS.RELEASE)(h.event, { items: [{ jobId: JOB }] });
      assert.deepEqual(result, { success: false, code: 'DISABLED' });
      assert.equal(claude.releases.length, 0);
      assert.equal(claude.describes.length, 0);
      assert.equal(claude.asks.length, 0);
    },
  },
];
