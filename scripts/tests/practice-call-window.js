import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPracticeCallController } from '../../electron/practiceCall/callWindow.js';

const cases = [];
const test = (name, run) => cases.push({ name: `practice call window: ${name}`, run });

async function harness({ phase = 'ringing' } = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-window-'));
  const windows = [];
  class FakeWindow {
    constructor(options) {
      this.options = options; this.destroyed = false; this.handlers = {}; this.focused = 0;
      this.webContents = { send() {}, mainFrame: {} };
      windows.push(this);
    }
    once(name, fn) { this.handlers[name] = fn; }
    on(name, fn) { this.handlers[name] = fn; }
    isDestroyed() { return this.destroyed; }
    show() {} focus() { this.focused += 1; } loadURL(url) { this.url = url; }
    loadFile(file, options) { this.file = file; this.search = options.search; }
    close() { if (this.destroyed) return; this.destroyed = true; this.handlers.closed?.(); }
  }
  const ipc = new Map();
  const ipcMain = { handle: (channel, fn) => ipc.set(channel, fn), removeHandler: channel => ipc.delete(channel) };
  const invoke = (channel, ...args) => ipc.get(channel)({}, ...args);
  const calls = { start: 0, abandon: 0, showReplay: [], hangUp: [] };
  const service = {
    phase,
    padCalls: [],
    updatePad(text) { this.padCalls.push(['update', text]); return { phase: this.phase }; },
    pauseCalls: [],
    setPaused(value) { this.pauseCalls.push(value); return { phase: this.phase }; },
    onState() {}, onEvent() {}, onReplayUpdated() {},
    getState() { return { phase: this.phase, callId: 'call-1' }; },
    async start() { calls.start += 1; return { phase: this.phase = 'ringing', callId: 'call-1' }; },
    async abandon() { calls.abandon += 1; return { phase: 'replay' }; },
    showReplay(callId) { calls.showReplay.push(callId); this.phase = 'replay'; return { phase: 'replay', callId }; },
    async hangUp(options) { calls.hangUp.push(options); return { phase: 'replay' }; },
  };
  const controller = createPracticeCallController({
    BrowserWindow: FakeWindow, ipcMain, isAuthorizedOwner: () => true, userDataPath: tmp,
    store: { readRecord: async callId => ({ callId, nodeId: 'n1' }) }, service,
  });
  return { windows, invoke, calls, service, controller };
}

test('a replay opens on the service replay phase for that call in a fresh window', async () => {
  const { windows, invoke, calls, service } = await harness({ phase: 'replay' });
  const result = await invoke('practice-call:open-replay', { nodeId: 'n1', callId: 'call-7' });
  assert.deepEqual(result, { callId: 'call-7' });
  assert.deepEqual(calls.showReplay, ['call-7'], 'the service enters its replay phase for the chosen call');
  assert.equal(windows.length, 1);
  assert.equal(windows[0].search, 'view=practice-call&replay=1&callId=call-7');
  await invoke('practice-call:open-replay', { nodeId: 'n1', callId: 'call-8' });
  assert.equal(windows[0].destroyed, true, 'an open replay window is closed first');
  assert.equal(windows.length, 2);
  assert.equal(windows[1].search, 'view=practice-call&replay=1&callId=call-8');
  assert.equal(service.phase, 'replay');
  assert.equal(calls.abandon, 0, 'replacing a replay window never abandons a call');
});

test('a replay is refused while a call is in progress and the call window is only focused', async () => {
  const { windows, invoke, calls } = await harness({ phase: 'ringing' });
  await invoke('practice-call:start', { nodeId: 'n1' });
  assert.equal(windows.length, 1);
  const before = windows[0].focused;
  const refused = await invoke('practice-call:open-replay', { nodeId: 'n1', callId: 'call-7' });
  assert.deepEqual(refused, { success: false, error: 'Finish the call in progress before opening a replay.' });
  assert.equal(windows.length, 1, 'no second window opens');
  assert.equal(windows[0].destroyed, false);
  assert.ok(windows[0].focused > before, 'the call window is brought forward');
  assert.deepEqual(calls.showReplay, [], 'the service state is untouched');
  windows[0].close();
  assert.equal(calls.abandon, 1, 'the live call window still abandons its call when closed');
});

test('start refuses only while the call is running; a finished or failed window is replaced', async () => {
  for (const running of ['consent', 'downloading', 'precheck', 'ringing', 'connecting', 'in-call', 'ended', 'analyzing']) {
    const { windows, invoke, calls, service } = await harness({ phase: 'ringing' });
    await invoke('practice-call:start', { nodeId: 'n1' });
    service.phase = running;
    const blocked = await invoke('practice-call:start', { nodeId: 'n1' });
    assert.equal(blocked.error?.code, 'already-running', `${running} is still running`);
    assert.equal(calls.start, 1);
    assert.equal(windows.length, 1);
  }
  for (const finished of ['error', 'replay']) {
    const { windows, invoke, calls, service } = await harness({ phase: 'ringing' });
    await invoke('practice-call:start', { nodeId: 'n1' });
    service.phase = finished;
    const state = await invoke('practice-call:start', { nodeId: 'n1' });
    assert.equal(state.phase, 'ringing', `a new call starts after ${finished}`);
    assert.equal(calls.start, 2);
    assert.equal(windows.length, 2);
    assert.equal(windows[0].destroyed, true, 'the old window is closed');
    assert.equal(calls.abandon, 0, 'closing the old finished window does not abandon anything');
  }
});

// The setup before the call rings takes many seconds in a real call. The window used to open only
// after it, so the audio check screen was never seen and nothing showed while the hub waited.
test('the window opens when setup begins, not when the call finally rings', async () => {
  const { windows, invoke, service } = await harness({ phase: 'ringing' });
  const listeners = new Set();
  service.onState = listener => { listeners.add(listener); return () => listeners.delete(listener); };
  let release;
  service.start = async () => {
    for (const listener of listeners) listener({ phase: 'precheck', callId: 'call-7' });
    await new Promise(resolve => { release = resolve; });
    service.phase = 'ringing';
    return { phase: 'ringing', callId: 'call-7' };
  };
  const pending = invoke('practice-call:start', { nodeId: 'n1' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(windows.length, 1, 'the window is open while setup is still running');
  assert.match(windows[0].search, /callId=call-7/u);
  release();
  await pending;
  assert.equal(windows.length, 1, 'the ringing state reuses that window');
  assert.equal(listeners.size, 0, 'the setup watcher is removed');

  const refused = await harness({ phase: 'ringing' });
  refused.service.start = async () => ({ phase: 'error', error: { code: 'start-failed', message: 'Prepare this interview before practicing.' } });
  const state = await refused.invoke('practice-call:start', { nodeId: 'n1' });
  assert.equal(state.phase, 'error');
  assert.equal(refused.windows.length, 0, 'a start refused outright opens no window');
});

// service.start awaits several things before its first setup phase; a replay opened in that gap
// used to take the window and hide the starting call.
test('a replay is refused while a call is starting and a replay window never survives into the call', async () => {
  const { windows, invoke, calls, service } = await harness({ phase: 'replay' });
  const listeners = new Set();
  service.onState = listener => { listeners.add(listener); return () => listeners.delete(listener); };
  let release;
  service.start = async () => {
    await new Promise(resolve => { release = resolve; });
    for (const listener of listeners) listener({ phase: 'precheck', callId: 'call-9' });
    service.phase = 'ringing';
    return { phase: 'ringing', callId: 'call-9' };
  };
  const pending = invoke('practice-call:start', { nodeId: 'n1' });
  await new Promise(resolve => setTimeout(resolve, 0));
  const refused = await invoke('practice-call:open-replay', { nodeId: 'n1', callId: 'call-7' });
  assert.deepEqual(refused, { success: false, error: 'Finish the call in progress before opening a replay.' });
  assert.equal(windows.length, 0);
  assert.deepEqual(calls.showReplay, []);
  release();
  await pending;
  assert.equal(windows.length, 1);
  assert.match(windows[0].search, /^view=practice-call&callId=call-9$/u, 'the call window is not a replay window');
  const after = await invoke('practice-call:open-replay', { nodeId: 'n1', callId: 'call-7' });
  assert.equal(after.success, false, 'the refusal ends with the start');
});

test('a refused start brings the running call window forward', async () => {
  const { windows, invoke } = await harness({ phase: 'ringing' });
  await invoke('practice-call:start', { nodeId: 'n1' });
  const before = windows[0].focused;
  const blocked = await invoke('practice-call:start', { nodeId: 'n1' });
  assert.equal(blocked.error?.code, 'already-running');
  assert.ok(windows[0].focused > before, 'the call window is focused');
});

test('declining without feedback closes the window with the call', async () => {
  const { windows, invoke, calls } = await harness({ phase: 'ringing' });
  await invoke('practice-call:start', { nodeId: 'n1' });
  await invoke('practice-call-window:hang-up', { feedback: false });
  assert.deepEqual(calls.hangUp, [{ feedback: false }]);
  assert.equal(windows[0].destroyed, true);
});

test('the pad handlers forward to the service', async () => {
  const { invoke, service } = await harness({ phase: 'ringing' });
  await invoke('practice-call:start', { nodeId: 'n1' });
  await invoke('practice-call-window:update-pad', 'print(1)');
  assert.deepEqual(service.padCalls, [['update', 'print(1)']]);
});

test('the set-paused handler forwards to the service', async () => {
  const { invoke, service } = await harness({ phase: 'ringing' });
  await invoke('practice-call:start', { nodeId: 'n1' });
  await invoke('practice-call-window:set-paused', true);
  await invoke('practice-call-window:set-paused', false);
  assert.deepEqual(service.pauseCalls, [true, false]);
});

export default cases;

// Seen in the built app: quitting during a call left only a half-written recording and no record.
test('quitting the app during a call ends it without a review first, and does nothing when no call is running', async () => {
  const live = await harness({ phase: 'ringing' });
  await live.invoke('practice-call:start', { nodeId: 'n1' });
  live.service.phase = 'in-call';
  await live.controller.shutdown();
  assert.deepEqual(live.calls.hangUp, [{ feedback: false }]);

  const idle = await harness({ phase: 'replay' });
  await idle.controller.shutdown();
  assert.deepEqual(idle.calls.hangUp, []);

  // A call that never finishes hanging up cannot hold the quit.
  const stuck = await harness({ phase: 'in-call' });
  stuck.service.hangUp = () => new Promise(() => {});
  await stuck.controller.shutdown({ timeoutMs: 20 });
});
