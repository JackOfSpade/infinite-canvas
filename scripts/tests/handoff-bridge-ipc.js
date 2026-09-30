import { assert } from './testHelpers.js';
import { IPC_CHANNELS, IPC_EVENTS, PUBLISH_JOBS_EXAMPLE } from '../../electron/ipc/handoffBridge/contracts.js';
import { registerHandoffBridgeUi } from '../../electron/ipc/handoffBridge/ui.js';
import { createHandoffBridgeTray } from '../../electron/ipc/handoffBridge/tray.js';
import { CONSTANTS } from '../../electron/ipc/handoffBridge/constants.js';

const JOB = '550e8400-e29b-41d4-a716-446655440000';
const EXTRA_JOB = '660e8400-e29b-41d4-a716-446655440000';
const PATH = '/tmp/synthetic.canvas';
function fakeIpc() { const handlers = new Map(); const listeners = new Map(); return { handlers, listeners, handle: (c, fn) => handlers.set(c, fn), removeHandler: c => handlers.delete(c), on: (c, fn) => listeners.set(c, fn), removeListener: (c, fn) => { if (listeners.get(c) === fn) listeners.delete(c); } }; }
function fakeClock(start = 0) {
  let stamp = start; const tasks = [];
  const timers = {
    setTimeout(fn, delay = 0) {
      const task = { at: stamp + Math.max(0, Number(delay) || 0), fn, active: true };
      tasks.push(task); return { task, unref() {} };
    },
    clearTimeout(handle) { if (handle?.task) handle.task.active = false; },
  };
  const advance = target => {
    stamp = target;
    for (;;) {
      const due = tasks.filter(task => task.active && task.at <= stamp).sort((left, right) => left.at - right.at)[0];
      if (!due) break;
      due.active = false; due.fn();
    }
  };
  return { now: () => stamp, timers, advance, pending: () => tasks.filter(task => task.active) };
}
function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle(turns = 4) {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}
function setup({ windows = null, getCanvasWindows = null, controller = {}, dialogs = {}, application = {}, engine = {}, push = {}, clipboard = {}, store = {}, tunnel = {}, oauth = {}, enableConsent = {}, onSetupMutation = null, processStartedAt, validateHostname, now, timers, Notification, ipc: providedIpc = null } = {}) {
  const ipc = providedIpc || fakeIpc(); const sender = { id: 9, __isCanvasRenderer: true, sent: [], send(channel, value) { this.sent.push({ channel, value }); } };
  const window = { __canvasFilePath: PATH, webContents: sender, isDestroyed: () => false };
  const canvasWindows = getCanvasWindows || (() => windows === null ? [window] : windows);
  const api = registerHandoffBridgeUi({ ipc, getCanvasWindows: canvasWindows, processStartedAt, validateHostname, now, timers, Notification, controller: { snapshot: () => ({ enabled: true, setup: { tunnelReachable: true }, config: { hostname: 'bridge.example.com', scope: { applications: true, scoring: false }, autoStart: false }, limits: { releaseTtlHours: 24, chatKeyMaxAgeHours: 24, idlePauseMinutes: 1440 }, prefs: { sourcePolicy: 'enforce', pairingNetworkCheck: true }, pauseCause: null, autoRelease: false }), subscribe: () => () => undefined, enable: async () => ({ success: true }), disable: async () => ({ success: true }), pause: async () => ({ success: true }), resume: async () => ({ success: true }), revokeAll: async () => ({ success: true }), forget: async () => ({ success: true }), release: async () => ({ success: true, released: 1 }), unrelease: async () => ({ success: true }), ackAlarm: async () => ({ success: true }), getActivity: async () => [], reloadConfig: async () => ({ success: true }), ...controller }, store: { writeConfig: async () => ({ ok: true }), ...store }, dialogs: { ask: async () => ({ ok: true }), choose: async () => ({ ok: true, filePath: '/tmp/file' }), ...dialogs }, application: { describeForConfirm: async () => ({ ok: true, canvasFilePath: PATH, items: [{ jobId: JOB, title: 'Ada Lovelace', company: 'Example' }] }), ...application }, engine: { hold: async () => ({ ok: true }), resume: async () => ({ ok: true }), ...engine }, push, clipboard, tunnel: { chooseBinary: async () => ({ ok: true }), getApprovalDetails: async () => ({ ok: true, version: '2026.9.3', sha256: 'a'.repeat(64) }), approveBinary: async () => ({ ok: true }), chooseCredentials: async () => ({ ok: true }), restart: async () => ({ ok: true }), reapOrphans: async () => ({ ok: true, reaped: 1 }), getLog: async () => [], ...tunnel }, oauth: { openPairing: async () => ({ ok: true, expiresAt: 1, pairingCode: '23456-789AB' }), cancelPairing: async () => ({ ok: true }), ...oauth }, enableConsent: { describe: async () => ({ hostname: 'bridge.example.com', idlePauseMinutes: 1440, items: [], long: true }), accept: async () => ({ ok: true }), ...enableConsent }, onSetupMutation });
  return { ipc, sender, window, api, event: { sender } };
}
const invoke = (h, channel, payload) => h.ipc.handlers.get(channel)(h.event, payload);

export default [
  { name: 'handoff bridge: ipc: contract exposes exactly 24 invokes, one publish send and three events', run: () => {
    const channelValues = Object.values(IPC_CHANNELS); assert(channelValues.length === 25 && new Set(channelValues).size === 25, 'IPC channel names must be closed and unique');
    assert(IPC_CHANNELS.PUBLISH_JOBS === 'handoff-bridge:publish-jobs' && channelValues.filter(channel => channel !== IPC_CHANNELS.PUBLISH_JOBS).length === 24, 'publish-jobs is sole send-only channel');
    assert(Object.values(IPC_EVENTS).length === 3 && new Set(Object.values(IPC_EVENTS)).size === 3, 'main-to-renderer events must be closed'); assert(!JSON.stringify({ IPC_CHANNELS, IPC_EVENTS, PUBLISH_JOBS_EXAMPLE }).includes('label'), 'IPC never carries renderer labels');
  } },
  { name: 'handoff bridge: ipc: registers exactly the frozen invokes and one publish listener', run: () => {
    const h = setup(); assert(h.api.registration.ok && h.api.registration.invokes === 24 && h.api.registration.expectedInvokes === 24 && h.api.registration.publish, 'registration exposes a closed complete-route fact'); assert(h.ipc.handlers.size === 24 && h.ipc.listeners.size === 1 && h.ipc.listeners.has(IPC_CHANNELS.PUBLISH_JOBS), 'all and only contract channels register');
    assert([...h.ipc.handlers.keys()].every(channel => Object.values(IPC_CHANNELS).includes(channel)), 'no unlisted invoke channel is permitted');
  } },
  { name: 'handoff bridge: ipc: partial or missing IPC registration is reported false and leaves no route behind', run: () => {
    const handlers = new Map(); const listeners = new Map(); let failedOnce = false;
    const throwingIpc = {
      handlers, listeners,
      handle(channel, handler) {
        handlers.set(channel, handler);
        if (!failedOnce && channel === IPC_CHANNELS.CHOOSE_BINARY) { failedOnce = true; throw new Error('synthetic handler failure'); }
      },
      removeHandler(channel) { handlers.delete(channel); },
      on(channel, listener) { listeners.set(channel, listener); },
      removeListener(channel, listener) { if (listeners.get(channel) === listener) listeners.delete(channel); },
    };
    const partial = setup({ ipc: throwingIpc });
    assert(!partial.api.registration.ok && partial.api.registration.invokes < partial.api.registration.expectedInvokes,
      'a throwing invoke registration is not reported as a working bridge');
    assert(handlers.size === 0 && listeners.size === 0,
      'a failed registration removes every earlier invoke and publisher listener before returning');

    const missingHandlers = new Map(); const missingListeners = new Map();
    const missingHandleIpc = {
      handlers: missingHandlers, listeners: missingListeners,
      removeHandler(channel) { missingHandlers.delete(channel); },
      on(channel, listener) { missingListeners.set(channel, listener); },
      removeListener(channel, listener) { if (missingListeners.get(channel) === listener) missingListeners.delete(channel); },
    };
    const missing = setup({ ipc: missingHandleIpc });
    assert(!missing.api.registration.ok && missing.api.registration.invokes === 0 && missingHandlers.size === 0 && missingListeners.size === 0,
      'a missing ipc.handle fails closed without creating an invoke or publisher route');

    const publisherHandlers = new Map(); const publisherListeners = new Map();
    const throwingPublisherIpc = {
      handlers: publisherHandlers, listeners: publisherListeners,
      handle(channel, handler) { publisherHandlers.set(channel, handler); },
      removeHandler(channel) { publisherHandlers.delete(channel); },
      on(channel, listener) { publisherListeners.set(channel, listener); throw new Error('synthetic publisher failure'); },
      removeListener(channel, listener) { if (publisherListeners.get(channel) === listener) publisherListeners.delete(channel); },
    };
    const publisherFailure = setup({ ipc: throwingPublisherIpc });
    assert(!publisherFailure.api.registration.ok && publisherHandlers.size === 0 && publisherListeners.size === 0,
      'a publisher that retains then throws is also removed with every invoke before returning');

    let noopPublishers = 0;
    const noopHandleIpc = {
      handle() {}, removeHandler() {}, on() { noopPublishers += 1; }, removeListener() {},
      __getInvokeHandler: () => undefined,
    };
    const noop = setup({ ipc: noopHandleIpc });
    assert(!noop.api.registration.ok && noop.api.registration.invokes === 0 && noopPublishers === 0,
      'where an IPC test seam exposes handler introspection, a no-op handle is not treated as a registered bridge');
  } },
  { name: 'handoff bridge: ipc: a failed replacement clears old and new bridge routes', run: () => {
    const ipc = fakeIpc();
    const initial = setup({ ipc });
    assert(initial.api.registration.ok && ipc.handlers.size === 24 && ipc.listeners.size === 1,
      'the regression begins with a complete prior bridge registry');

    const realHandle = ipc.handle;
    let threw = false;
    ipc.handle = (channel, handler) => {
      realHandle(channel, handler);
      if (!threw && channel === IPC_CHANNELS.CHOOSE_BINARY) {
        threw = true;
        throw new Error('synthetic replacement failure');
      }
    };
    const replacement = setup({ ipc });
    assert(!replacement.api.registration.ok,
      'a replacement that throws while registering an invoke is not working');
    assert(ipc.handlers.size === 0 && ipc.listeners.size === 0,
      'a failed replacement must clear both retained old routes and newly attempted routes');
  } },
  { name: 'handoff bridge: ipc: failed replacement cleanup isolates publisher removal faults', run: () => {
    const ipc = fakeIpc();
    const initial = setup({ ipc });
    assert(initial.api.registration.ok && ipc.listeners.size === 1,
      'the cleanup-fault regression begins with a registered publisher');

    const realHandle = ipc.handle;
    const realRemoveListener = ipc.removeListener;
    let threw = false;
    ipc.handle = (channel, handler) => {
      realHandle(channel, handler);
      if (channel === IPC_CHANNELS.CHOOSE_BINARY) throw new Error('synthetic replacement failure');
    };
    ipc.removeListener = (channel, listener) => {
      if (!threw) {
        threw = true;
        throw new Error('synthetic listener removal fault');
      }
      realRemoveListener(channel, listener);
    };
    const replacement = setup({ ipc });
    assert(!replacement.api.registration.ok && threw,
      'the replacement and its first publisher cleanup attempt both fail');
    assert(ipc.handlers.size === 0 && ipc.listeners.size === 0,
      'a listener-removal fault cannot prevent remaining publisher cleanup or invoke rollback');

    ipc.handle = realHandle;
    ipc.removeListener = () => { throw new Error('stale publisher ownership would fail this registration'); };
    const recovered = setup({ ipc });
    assert(recovered.api.registration.ok && ipc.listeners.size === 1,
      'failed cleanup deletes publisher ownership even when a later registration cannot remove a stale listener');
  } },
  { name: 'handoff bridge: ipc: sender guard applies to every invoke and publish route', async run() {
    const h = setup(); const hostile = { sender: { id: 99, __isCanvasRenderer: false } };
    for (const handler of h.ipc.handlers.values()) { const result = await handler(hostile, {}); assert(result.code === 'SENDER', 'every invoke must reject non-canvas sender'); }
    h.ipc.listeners.get(IPC_CHANNELS.PUBLISH_JOBS)(hostile, PUBLISH_JOBS_EXAMPLE); assert(h.api.candidates().size === 0, 'publish must reject non-canvas sender');
  } },
  { name: 'handoff bridge: ipc: every native dialog has a window and no-window calls fail closed', async run() {
    let dialogCalls = 0; const h = setup({ windows: [], dialogs: { ask: async () => { dialogCalls++; return { ok: true }; } } });
    for (const channel of [IPC_CHANNELS.SET_ENABLED, IPC_CHANNELS.SAVE_CONFIG, IPC_CHANNELS.OPEN_PAIRING, IPC_CHANNELS.NEW_CHAT, IPC_CHANNELS.RELEASE]) {
      const result = await invoke(h, channel, channel === IPC_CHANNELS.SET_ENABLED ? { enabled: true } : channel === IPC_CHANNELS.SAVE_CONFIG ? { patch: {} } : channel === IPC_CHANNELS.RELEASE ? { items: [{ jobId: JOB }] } : undefined);
      assert(result.code === 'NO_WINDOW', `${channel} must require a canvas parent`);
    }
    assert(dialogCalls === 0, 'no-window must never issue a parentless dialog');
  } },
  { name: 'handoff bridge: ipc: unavailable enable refuses before consent or a native dialog', async run() {
    let described = 0; let dialogCalls = 0; let enabled = 0;
    const h = setup({
      controller: {
        snapshot: () => ({
          enabled: false,
          availability: { ok: false, reason: 'e2e' },
          setup: { tunnelReachable: false },
          config: { hostname: null, scope: { applications: true, scoring: false } },
          limits: { idlePauseMinutes: 1440 },
        }),
        enable: async () => { enabled += 1; return { success: true }; },
      },
      enableConsent: { describe: async () => { described += 1; return {}; } },
      dialogs: { ask: async () => { dialogCalls += 1; return { ok: true }; } },
    });
    const result = await invoke(h, IPC_CHANNELS.SET_ENABLED, { enabled: true });
    assert(result.success === false && result.code === 'UNAVAILABLE', 'the authoritative availability ladder must keep its fixed IPC code');
    assert(described === 0 && dialogCalls === 0 && enabled === 0, 'an unavailable enable must have no consent, dialog, or controller side effect');
  } },
  { name: 'handoff bridge: ipc: enable maps closed startup failures without relaying details', async run() {
    const expected = new Map([
      ['env_disabled', 'UNAVAILABLE'], ['e2e', 'UNAVAILABLE'], ['unpackaged', 'UNAVAILABLE'],
      ['no_hostname', 'UNAVAILABLE'], ['no_binary', 'UNAVAILABLE'], ['binary_untrusted', 'UNAVAILABLE'], ['no_credentials', 'UNAVAILABLE'], ['config_invalid', 'UNAVAILABLE'],
      ['socket_unavailable', 'UNAVAILABLE'], ['tunnel_failed', 'UNAVAILABLE'], ['not_enabled', 'UNAVAILABLE'],
      ['CANCELLED', 'DECLINED'], ['DECLINED', 'DECLINED'], ['BUSY', 'BUSY'], ['busy', 'BUSY'], ['NO_WINDOW', 'NO_WINDOW'], ['no_window', 'NO_WINDOW'], ['UNAVAILABLE', 'UNAVAILABLE'],
      ['state_unreadable', 'UNAVAILABLE'], ['persist_failed', 'UNAVAILABLE'], ['unexpected_platform_fault', 'UNAVAILABLE'],
    ]);
    for (const [startupCode, fixedCode] of expected) {
      const h = setup({ controller: { enable: async () => ({ success: false, code: startupCode, detail: '/private/synthetic-secret.sock', message: 'synthetic internal message' }) } });
      const result = await invoke(h, IPC_CHANNELS.SET_ENABLED, { enabled: true });
      assert(result.success === false && result.code === fixedCode,
        `${startupCode} must map to its fixed enable category`);
      assert(JSON.stringify(result) === JSON.stringify({ success: false, code: fixedCode }),
        'enable failure must not relay a refusal detail or message');
    }
  } },
  { name: 'handoff bridge: ipc: release resolves canonical main path and ignores hostile renderer text', async run() {
    const seen = []; const h = setup({ controller: { release: async value => { seen.push(value); return { success: true, released: 1 }; } } });
    h.ipc.listeners.get(IPC_CHANNELS.PUBLISH_JOBS)(h.event, { v: 1, seq: 1, jobs: [{ jobId: JOB, canvasFilePath: PATH, dockState: 'awaiting', sig: 's' }] });
    const result = await invoke(h, IPC_CHANNELS.RELEASE, { items: [{ jobId: JOB, label: '<script>steal</script>' }] });
    assert(result.code === 'INVALID' && seen.length === 0, 'release payload allows jobId only and never relays a label');
    const accepted = await invoke(h, IPC_CHANNELS.RELEASE, { items: [{ jobId: JOB }] });
    assert(accepted.success && JSON.stringify(seen[0]) === JSON.stringify({ jobs: [{ jobId: JOB, canvasFilePath: PATH }] }), 'controller receives canonical {jobs:[jobId,canvasFilePath]}');
  } },
  { name: 'handoff bridge: ipc: publication is per sender, monotonic and cleans up on unmount', run: () => {
    const hints = []; const h = setup({ engine: { hint: value => hints.push(value) } }); const publish = h.ipc.listeners.get(IPC_CHANNELS.PUBLISH_JOBS);
    publish(h.event, { v: 1, seq: 2, jobs: [{ jobId: JOB, canvasFilePath: PATH, dockState: 'awaiting', sig: 's' }] }); assert(h.api.candidates().size === 1 && h.sender.sent.length === 0 && JSON.stringify(hints) === JSON.stringify([{ jobId: JOB }]), 'publication hints a new job but never emits a renderer job-change');
    publish(h.event, { v: 1, seq: 1, jobs: [] }); assert(h.api.candidates().get(h.sender.id).seq === 2, 'older sequence cannot replace candidates');
    publish(h.event, { v: 1, unmount: true }); assert(h.api.candidates().size === 0, 'unmount removes sender candidates, never completes a job');
  } },
  { name: 'handoff bridge: ipc: candidate keep-alive expires at 30 seconds and live-window loss removes it immediately', run: () => {
    const clock = fakeClock(); const windows = []; const h = setup({ now: clock.now, timers: clock.timers, getCanvasWindows: () => windows });
    windows.push(h.window);
    const publish = h.ipc.listeners.get(IPC_CHANNELS.PUBLISH_JOBS);
    const payload = { v: 1, seq: 1, jobs: [{ jobId: JOB, canvasFilePath: PATH, dockState: 'awaiting', sig: 'keep-alive' }] };
    publish(h.event, payload);
    clock.advance(29_999);
    assert(h.api.candidates().size === 1, 'a live canvas publication remains available until its full keep-alive interval elapses');
    clock.advance(30_000);
    assert(h.api.candidates().size === 0, 'a crashed canvas candidate expires exactly at the bounded 30-second keep-alive');
    publish(h.event, { ...payload, seq: 2 });
    assert(h.api.candidates().size === 1, 'a fresh monotonic publication restores its own candidate entry');
    windows.length = 0;
    assert(h.api.candidates().size === 0, 'closing a live canvas removes its candidate without waiting for the keep-alive timeout');
    windows.push(h.window);
    publish(h.event, { ...payload, seq: 3 });
    publish(h.event, { v: 1, unmount: true });
    assert(h.api.candidates().size === 0, 'an explicit renderer unmount uses the same removal path and never changes job state');
  } },
  { name: 'handoff bridge: ipc: clipboard uses prepare write commit and abandons failure', async run() {
    const calls = []; const good = setup({ controller: { prepareChat: async () => ({ commitToken: 't', starter: 'synthetic', chatOrdinal: 1 }), commitChat: async token => { calls.push(['commit', token]); return { success: true }; }, abandonChat: async token => { calls.push(['abandon', token]); return { success: true }; } }, clipboard: { writeText: text => calls.push(['write', text]), readText: () => '', clear() {} } });
    assert((await invoke(good, IPC_CHANNELS.NEW_CHAT)).success && JSON.stringify(calls.slice(0, 2)) === JSON.stringify([['write', 'synthetic'], ['commit', 't']]), 'clipboard write must happen before epoch commit');
    const badCalls = []; const bad = setup({ controller: { prepareChat: async () => ({ commitToken: 't', starter: 'synthetic' }), commitChat: async () => { badCalls.push('commit'); }, abandonChat: async () => { badCalls.push('abandon'); } }, clipboard: { writeText() { throw new Error('denied'); } } });
    assert((await invoke(bad, IPC_CHANNELS.NEW_CHAT)).code === 'CLIPBOARD_FAILED' && JSON.stringify(badCalls) === JSON.stringify(['abandon']), 'clipboard failure abandons prepared chat and never commits');
  } },
  { name: 'handoff bridge: ipc: a re-copied starter is reported as recopied with its ordinal, and a rotated one is not', async run() {
    const calls = [];
    const make = prepared => setup({ controller: { prepareChat: async () => prepared, commitChat: async token => { calls.push(['commit', token]); return { success: true }; }, abandonChat: async () => ({ success: true }) }, clipboard: { writeText: text => calls.push(['write', text]), readText: () => '', clear() {} } });
    const again = await invoke(make({ commitToken: 'r', starter: 'synthetic', chatOrdinal: 3, recopied: true }), IPC_CHANNELS.NEW_CHAT);
    assert(again.success === true && again.recopied === true && again.chatOrdinal === 3 && again.copied === true, 'main tells the renderer this was a re-copy of chat 3');
    assert(JSON.stringify(calls) === JSON.stringify([['write', 'synthetic'], ['commit', 'r']]), 'a re-copy still writes the clipboard before committing');
    const fresh = await invoke(make({ commitToken: 'f', starter: 'synthetic', chatOrdinal: 4 }), IPC_CHANNELS.NEW_CHAT);
    assert(fresh.success === true && fresh.chatOrdinal === 4 && !('recopied' in fresh), 'a rotated chat carries no recopied flag');
    const truthy = await invoke(make({ commitToken: 'x', starter: 'synthetic', chatOrdinal: 5, recopied: 'yes' }), IPC_CHANNELS.NEW_CHAT);
    assert(!('recopied' in truthy), 'only a literal true is forwarded');
  } },
  { name: 'handoff bridge: ipc: a re-copy restarts the single clipboard-clear clock, so an earlier press never wipes it early', async run() {
    const clock = fakeClock(); let clipboardText = ''; let clears = 0;
    const clipboard = { writeText: text => { clipboardText = text; }, readText: () => clipboardText, clear() { clears += 1; clipboardText = ''; } };
    const h = setup({ now: clock.now, timers: clock.timers, clipboard, controller: { prepareChat: async () => ({ commitToken: 'r', starter: 'synthetic-starter', chatOrdinal: 1, recopied: true }), commitChat: async () => ({ success: true }), abandonChat: async () => ({ success: true }) } });
    const wait = CONSTANTS.CLIPBOARD_CLEAR_MS;
    assert((await invoke(h, IPC_CHANNELS.NEW_CHAT)).success === true && clock.pending().length === 1, 'the first copy schedules one clear');
    clock.advance(wait - 10_000);
    assert((await invoke(h, IPC_CHANNELS.NEW_CHAT)).success === true, 'the second copy succeeds');
    assert(clock.pending().length === 1, 'the second copy replaces the pending clear rather than adding a second one');
    clock.advance(wait);
    assert(clears === 0 && clipboardText === 'synthetic-starter', 'the first copy\'s deadline passes without wiping the newer, byte-identical copy');
    clock.advance(wait - 10_000 + wait);
    assert(clears === 1 && clipboardText === '' && clock.pending().length === 0, 'the newest copy is cleared one full window after IT was written');
  } },
  { name: 'handoff bridge: ipc: the clipboard clear still leaves text the person copied in the meantime', async run() {
    const clock = fakeClock(); let clipboardText = ''; let clears = 0;
    const clipboard = { writeText: text => { clipboardText = text; }, readText: () => clipboardText, clear() { clears += 1; clipboardText = ''; } };
    const h = setup({ now: clock.now, timers: clock.timers, clipboard, controller: { prepareChat: async () => ({ commitToken: 'n', starter: 'synthetic-starter', chatOrdinal: 2 }), commitChat: async () => ({ success: true }), abandonChat: async () => ({ success: true }) } });
    await invoke(h, IPC_CHANNELS.NEW_CHAT);
    clipboardText = 'something else';
    clock.advance(CONSTANTS.CLIPBOARD_CLEAR_MS);
    assert(clears === 0 && clipboardText === 'something else', 'a conditional clear never wipes unrelated clipboard text');
  } },
  { name: 'handoff bridge: ipc: a closed chat canvas abandons prepared work before clipboard or commit', async run() {
    for (const channel of [IPC_CHANNELS.NEW_CHAT, IPC_CHANNELS.CONTINUE_CHAT]) {
      const prepared = deferred(); let windows = []; const calls = [];
      const h = setup({
        getCanvasWindows: () => windows,
        controller: {
          prepareChat: async () => prepared.promise,
          abandonChat: async token => { calls.push(['abandon', token]); return { success: true }; },
          commitChat: async token => { calls.push(['commit', token]); return { success: true }; },
        },
        clipboard: { writeText: text => calls.push(['write', text]), readText: () => '', clear() {} },
      });
      windows = [h.window];
      const pending = invoke(h, channel); await settle();
      windows = [];
      prepared.resolve({ commitToken: 'opaque-token', starter: 'synthetic', chatOrdinal: 1 });
      const result = await pending;
      assert(result.code === 'NO_WINDOW' && JSON.stringify(calls) === JSON.stringify([['abandon', 'opaque-token']]),
        `${channel} must abandon a late preparation without writing the clipboard or committing the chat`);
    }
  } },
  { name: 'handoff bridge: ipc: New chat passes only an opaque guarded sender for deferred restart confirmation', async run() {
    let received = null;
    const h = setup({ controller: {
      prepareChat: async value => { received = value; return { commitToken: 't', starter: 'synthetic', chatOrdinal: 1 }; },
      commitChat: async () => ({ success: true }),
    }, clipboard: { writeText() {}, readText: () => '', clear() {} } });
    assert((await invoke(h, IPC_CHANNELS.NEW_CHAT)).success
      && received?.kind === 'new' && received.restartContext?.sender === h.sender
      && Object.isFrozen(received.restartContext)
      && !JSON.stringify(received).includes(PATH),
    'New chat provides the controller only a guarded sender context, never renderer path data');
  } },
  { name: 'handoff bridge: ipc: starter clipboard clear is 120 seconds, conditional, and never erases a replacement', async run() {
    const matchingClock = fakeClock(); let matchingClipboard = ''; let matchingClears = 0;
    const matching = setup({ now: matchingClock.now, timers: matchingClock.timers,
      controller: { prepareChat: async () => ({ commitToken: 'matching', starter: 'synthetic starter', chatOrdinal: 1 }), commitChat: async () => ({ success: true }) },
      clipboard: { writeText: text => { matchingClipboard = text; }, readText: () => matchingClipboard, clear: () => { matchingClears += 1; matchingClipboard = ''; } },
    });
    assert((await invoke(matching, IPC_CHANNELS.NEW_CHAT)).success && matchingClock.pending().length === 1, 'a committed starter installs one best-effort clear timer');
    assert(matchingClock.pending()[0].at === 120_000, 'the clear timer is exactly the promised 120 seconds');
    matchingClock.advance(120_000);
    assert(matchingClears === 1 && matchingClipboard === '', 'the bridge clears only its still-current starter after 120 seconds');

    const changedClock = fakeClock(); let changedClipboard = ''; let changedClears = 0;
    const changed = setup({ now: changedClock.now, timers: changedClock.timers,
      controller: { prepareChat: async () => ({ commitToken: 'changed', starter: 'synthetic starter', chatOrdinal: 2 }), commitChat: async () => ({ success: true }) },
      clipboard: { writeText: text => { changedClipboard = text; }, readText: () => changedClipboard, clear: () => { changedClears += 1; changedClipboard = ''; } },
    });
    assert((await invoke(changed, IPC_CHANNELS.NEW_CHAT)).success, 'a second starter can commit independently');
    changedClipboard = 'Marisol Quenby changed this clipboard value';
    changedClock.advance(120_000);
    assert(changedClears === 0 && changedClipboard === 'Marisol Quenby changed this clipboard value', 'conditional clear preserves a user-replaced clipboard value');
  } },
  { name: 'handoff bridge: ipc: every exposure-raising config change has fixed native consent', async run() {
    const asked = []; let writes = 0;
    const h = setup({ dialogs: { ask: async (_sender, kind) => { asked.push(kind); return { ok: true }; } }, controller: { snapshot: () => ({ config: { hostname: 'bridge.example.com', scope: { applications: true, scoring: false }, autoStart: false }, prefs: { sourcePolicy: 'enforce', pairingNetworkCheck: true }, autoRelease: false }) } });
    const handler = h.ipc.handlers.get(IPC_CHANNELS.SAVE_CONFIG);
    const result = await handler(h.event, { patch: { hostname: 'next.example.com', scope: { scoring: true }, autoStart: true, autoRelease: true, prefs: { sourcePolicy: 'alert', pairingNetworkCheck: false } } });
    assert(result.success && JSON.stringify(asked) === JSON.stringify(['scoring', 'autoStart', 'autoRelease', 'sourcePolicy', 'networkCheck']), 'main must confirm every setting that expands exposure while an unlinked address saves directly');
    const cancelled = setup({ dialogs: { ask: async () => ({ ok: false, code: 'DECLINED' }) }, controller: { snapshot: () => ({ config: { hostname: 'bridge.example.com', scope: { applications: true, scoring: false } }, prefs: { sourcePolicy: 'enforce', pairingNetworkCheck: true }, autoRelease: false }) }, store: { async writeConfig() { writes++; return { ok: true }; } } });
    const declined = await cancelled.ipc.handlers.get(IPC_CHANNELS.SAVE_CONFIG)(cancelled.event, { patch: { scope: { scoring: true } } });
    assert(declined.code === 'DECLINED' && writes === 0, 'cancelled fixed consent must leave config unchanged');
  } },
  { name: 'handoff bridge: ipc: alert-to-off and every longer-or-disabled limit require one native consent', async run() {
    const asked = []; const h = setup({ dialogs: { ask: async (_sender, kind) => { asked.push(kind); return { ok: true }; } }, controller: { snapshot: () => ({ config: { hostname: 'bridge.example.com', scope: { applications: true, scoring: false } }, limits: { releaseTtlHours: 24, chatKeyMaxAgeHours: 24, idlePauseMinutes: 60, jobsPerChat: 2, epochSoftBytes: 500000, epochHardBytes: 750000 }, prefs: { sourcePolicy: 'alert', pairingNetworkCheck: true }, autoRelease: false }) } });
    const result = await invoke(h, IPC_CHANNELS.SAVE_CONFIG, { patch: { prefs: { sourcePolicy: 'off' }, limits: { releaseTtlHours: 0, chatKeyMaxAgeHours: 48, jobsPerChat: 3, epochSoftBytes: 0, epochHardBytes: 800000 } } });
    assert(result.success && JSON.stringify(asked) === JSON.stringify(['sourcePolicy', 'limits']), 'alert-to-off and every limit expansion or disable must have one native consent');
  } },
  { name: 'handoff bridge: ipc: anomaly Resume confirms only bounded facts from a relevant unacknowledged alarm', async run() {
    const asks = []; let resumes = 0;
    const status = { config: { hostname: 'bridge.example.com', scope: { applications: true, scoring: false } }, limits: {}, prefs: {}, autoRelease: false, pauseCause: 'anomaly', alarms: [{ id: 'rate_limited-17', kind: 'rate_limited', at: 17, acknowledged: false, client_name: 'hostile', count: 999 }] };
    const h = setup({ controller: { snapshot: () => status, resume: async () => { resumes += 1; return { success: true }; } }, dialogs: { ask: async (_sender, kind, details) => { asks.push([kind, details]); return { ok: true }; } } });
    const result = await invoke(h, IPC_CHANNELS.RESUME);
    assert(result.success && resumes === 1 && JSON.stringify(asks) === JSON.stringify([['resume', { reason: 'anomaly', count: 50, minutes: 1, at: 17 }]]), 'Resume must use one native confirm with only the closed alarm threshold facts');
    status.alarms[0].acknowledged = true;
    const blocked = await invoke(h, IPC_CHANNELS.RESUME);
    assert(blocked.code === 'NOT_READY' && resumes === 1 && asks.length === 1, 'anomaly Resume fails closed when no relevant unacknowledged alarm remains');
  } },
  { name: 'handoff bridge: ipc: user and idle Resume work headlessly while anomaly Resume remains parented', async run() {
    let resumes = 0; let asks = 0;
    for (const pauseCause of ['user', 'idle']) {
      const h = setup({ windows: [], controller: { snapshot: () => ({ pauseCause }), resume: async () => { resumes += 1; return { success: true }; } }, dialogs: { ask: async () => { asks += 1; return { ok: true }; } } });
      assert((await invoke(h, IPC_CHANNELS.RESUME)).success, `${pauseCause} Resume must call the controller with no canvas window`);
    }
    const anomaly = setup({ windows: [], controller: { snapshot: () => ({ pauseCause: 'anomaly', alarms: [{ id: 'rate_limited-1', kind: 'rate_limited', at: 1, acknowledged: false }] }), resume: async () => { resumes += 1; return { success: true }; } }, dialogs: { ask: async () => { asks += 1; return { ok: true }; } } });
    assert((await invoke(anomaly, IPC_CHANNELS.RESUME)).code === 'NO_WINDOW' && resumes === 2 && asks === 0,
      'anomaly Resume must neither invoke the controller nor open an unparented native acknowledgement');
  } },
  { name: 'handoff bridge: ipc: headless controls keep only non-lifecycle recovery mutations and every parented route fails NO_WINDOW', async run() {
    const calls = { pause: 0, resume: 0, revoke: 0, disable: 0, enable: 0, release: 0 }; let dialogCalls = 0; let pauseCause = 'user';
    const h = setup({ windows: [], dialogs: { ask: async () => { dialogCalls += 1; return { ok: true }; }, choose: async () => { dialogCalls += 1; return { ok: true, filePath: '/tmp/never-chosen' }; } }, controller: {
      snapshot: () => ({ enabled: true, setup: { tunnelReachable: true }, config: { hostname: 'bridge.example.com', scope: { applications: true, scoring: false } }, limits: {}, prefs: { sourcePolicy: 'enforce', pairingNetworkCheck: true }, autoRelease: false, pauseCause, alarms: [{ kind: 'rate_limited', at: 1, acknowledged: false }] }),
      pause: async () => { calls.pause += 1; return { success: true }; },
      resume: async () => { calls.resume += 1; return { success: true }; },
      revokeAll: async () => { calls.revoke += 1; return { success: true }; },
      disable: async () => { calls.disable += 1; return { success: true }; },
      enable: async () => { calls.enable += 1; return { success: true }; },
      release: async () => { calls.release += 1; return { success: true }; },
    } });
    assert((await invoke(h, IPC_CHANNELS.PAUSE)).success, 'user Pause remains available while no window is open');
    assert((await invoke(h, IPC_CHANNELS.RESUME)).success, 'user Resume remains available while no window is open');
    pauseCause = 'idle';
    assert((await invoke(h, IPC_CHANNELS.RESUME)).success, 'idle Resume remains available while no window is open');
    assert((await invoke(h, IPC_CHANNELS.REVOKE_ALL)).success && (await invoke(h, IPC_CHANNELS.SET_ENABLED, { enabled: false })).code === 'NO_WINDOW',
      'revoke remains available headlessly, but an exact live canvas window owns every bridge lifecycle mutation');
    pauseCause = 'anomaly';
    assert((await invoke(h, IPC_CHANNELS.RESUME)).code === 'NO_WINDOW' && calls.resume === 2,
      'anomaly Resume stays blocked before both the controller and a parentless security acknowledgement');
    const parentedOnly = [
      [IPC_CHANNELS.SET_ENABLED, { enabled: true }], [IPC_CHANNELS.SAVE_CONFIG, { patch: { hostname: 'next.example.com' } }],
      [IPC_CHANNELS.CHOOSE_BINARY], [IPC_CHANNELS.APPROVE_BINARY], [IPC_CHANNELS.CHOOSE_CREDENTIALS], [IPC_CHANNELS.OPEN_PAIRING],
      [IPC_CHANNELS.NEW_CHAT], [IPC_CHANNELS.CONTINUE_CHAT], [IPC_CHANNELS.FORGET_SETUP], [IPC_CHANNELS.RELEASE, { items: [{ jobId: JOB }] }],
      [IPC_CHANNELS.RELEASE_PUSH, { hubs: ['a'.repeat(64)] }],
    ];
    for (const [channel, payload] of parentedOnly) {
      const result = await invoke(h, channel, payload);
      assert(result.code === 'NO_WINDOW', `${channel} must fail closed without a canvas parent`);
    }
    assert(dialogCalls === 0 && calls.enable === 0 && calls.release === 0 && calls.pause === 1 && calls.revoke === 1 && calls.disable === 0,
      'no-window confirmation routes neither open a native sheet nor reach an exposure-raising port');
  } },
  { name: 'handoff bridge: ipc: alarm acknowledgement accepts only a bounded identifier and a positive controller acknowledgement', async run() {
    let acknowledgements = 0;
    const h = setup({ controller: { ackAlarm: async () => { acknowledgements += 1; return { ok: true }; } } });
    const malformed = await invoke(h, IPC_CHANNELS.ACK_ALARM, { id: 'alarm with renderer text' });
    assert(malformed.code === 'NOT_FOUND' && acknowledgements === 0, 'a malformed acknowledgement id must not reach the controller');
    const failed = setup({ controller: { ackAlarm: async () => ({ ok: false, code: 'not_found' }) } });
    assert((await invoke(failed, IPC_CHANNELS.ACK_ALARM, { id: 'alarm-1' })).code === 'NOT_FOUND', 'an acknowledgement stays fail-closed without a positive controller result');
  } },
  { name: 'handoff bridge: ipc: binary approval needs main-derived details and cancellation does not approve', async run() {
    let approved = 0; const asked = [];
    const h = setup({ dialogs: { ask: async (_sender, kind, details) => { asked.push([kind, details]); return { ok: false, code: 'DECLINED' }; } }, tunnel: { approveBinary: async () => { approved++; return { ok: true }; } } });
    // The test fake deliberately supplies the approval details through the
    // tunnel port; renderer payload never participates in this IPC.
    const result = await invoke(h, IPC_CHANNELS.APPROVE_BINARY);
    assert(result.code === 'DECLINED' && approved === 0 && asked[0][0] === 'binaryApproval', 'cancelled binary approval must not call the tunnel approve port');
    const pin = 'b'.repeat(64); let forwarded = null;
    const bound = setup({
      tunnel: {
        getApprovalDetails: async () => ({ ok: true, sha256: pin, version: '2026.9.3' }),
        approveBinary: async expectedPin => { forwarded = expectedPin; return { ok: true }; },
      },
    });
    const confirmed = await invoke(bound, IPC_CHANNELS.APPROVE_BINARY, { sha256: 'renderer-cannot-choose-the-pin' });
    assert(confirmed.success && forwarded === pin,
      'approval forwards only the main-derived confirmed pin, never renderer payload data');
  } },
  { name: 'handoff bridge: ipc: setup refresh follows each acknowledged durable setup mutation', async run() {
    const invalidations = [];
    const h = setup({ onSetupMutation: async kind => { invalidations.push(kind); return { success: true }; } });
    assert((await invoke(h, IPC_CHANNELS.CHOOSE_BINARY)).success && JSON.stringify(invalidations) === JSON.stringify(['chooseBinary']), 'choosing a durable binary refreshes the off-state only after the adapter acknowledges it');
    assert((await invoke(h, IPC_CHANNELS.APPROVE_BINARY)).success && JSON.stringify(invalidations) === JSON.stringify(['chooseBinary', 'approveBinary']), 'approval follows the selected binary refresh only after the adapter acknowledges durable trust');
    assert((await invoke(h, IPC_CHANNELS.CHOOSE_CREDENTIALS)).success && JSON.stringify(invalidations) === JSON.stringify(['chooseBinary', 'approveBinary', 'chooseCredentials']), 'credentials follow their acknowledged durable mutation');
    const failedBinary = setup({ tunnel: { chooseBinary: async () => ({ ok: false, code: 'INVALID' }) }, onSetupMutation: async () => { invalidations.push('bad-binary'); return { success: true }; } });
    assert((await invoke(failedBinary, IPC_CHANNELS.CHOOSE_BINARY)).success === false && !invalidations.includes('bad-binary'), 'a failed binary selection never refreshes or detaches a graph speculatively');
    const failed = setup({ tunnel: { approveBinary: async () => ({ ok: false, code: 'NOT_READY' }) }, onSetupMutation: async () => { invalidations.push('bad'); return { success: true }; } });
    assert((await invoke(failed, IPC_CHANNELS.APPROVE_BINARY)).success === false && !invalidations.includes('bad'), 'failed approval never detaches a graph speculatively');
    const detachedFailure = setup({ onSetupMutation: async () => ({ ok: false }) });
    assert((await invoke(detachedFailure, IPC_CHANNELS.APPROVE_BINARY)).code === 'INTERNAL', 'an ambiguous hard-detach acknowledgement fails closed after mutation');
  } },
  { name: 'handoff bridge: ipc: stop orphan has no renderer arguments and succeeds only after a real reap', async run() {
    const calls = [];
    const h = setup({ tunnel: { reapOrphans: async (...args) => { calls.push(args); return { ok: true, reaped: 1 }; } } });
    const good = await invoke(h, IPC_CHANNELS.STOP_ORPHAN, { pid: 99999, configPath: '/tmp/hostile.yml' });
    assert(good.success && calls.length === 1 && calls[0].length === 0,
      'the renderer payload cannot name a process or config; the fixed main setup port receives no arguments');
    for (const result of [{ ok: true, reaped: 0 }, { ok: true, reaped: '1' }, { ok: false, reaped: 1 }]) {
      const none = setup({ tunnel: { reapOrphans: async () => result } });
      assert((await invoke(none, IPC_CHANNELS.STOP_ORPHAN)).code === 'NOT_FOUND',
        'a no-op or ambiguous reap result must not claim a stopped orphan');
    }
  } },
  { name: 'handoff bridge: ipc: publish listener is owned, removable and idempotent', run: () => {
    const ipc = fakeIpc(); const first = setup({ ipc }); const second = setup({ ipc });
    assert(ipc.listeners.size === 1, 're-registration replaces, never stacks, the publisher');
    first.api.dispose(); assert(ipc.listeners.size === 1, 'disposing an old registration must not remove the active listener');
    second.api.dispose(); assert(ipc.listeners.size === 0, 'dispose removes the active publish listener and candidates');
  } },
  { name: 'handoff bridge: ipc: hold-job preserves boolean intent and activity/status are bounded', async run() {
    const calls = []; const h = setup({ engine: { hold: async (...args) => { calls.push(['hold', ...args]); return { ok: true }; }, resume: async (...args) => { calls.push(['resume', ...args]); return { ok: true }; } }, controller: { getActivity: async () => Array.from({ length: 250 }, () => ({ at: 1, kind: 'get-served', outcome: 'served', message: 'secret' })) } });
    assert((await invoke(h, IPC_CHANNELS.HOLD_JOB, { jobId: JOB, held: true })).success && (await invoke(h, IPC_CHANNELS.HOLD_JOB, { jobId: JOB, held: false })).success, 'hold state accepts a real boolean');
    assert(calls[0][0] === 'hold' && calls[1][0] === 'resume', 'false resumes rather than holding again'); const activity = await invoke(h, IPC_CHANNELS.GET_ACTIVITY);
    assert(activity.items.length === 200 && activity.items.every(item => item.kind === 'get-served' && item.outcome === 'served') && !JSON.stringify(activity).includes('secret'), 'hyphenated closed activity is capped and strips arbitrary fields');
  } },
  { name: 'handoff bridge: ipc: Activity rejects unknown kinds instead of coercing them to renderer copy', async run() {
    const h = setup({ controller: { getActivity: async () => [
      { at: 1, kind: 'get-served', outcome: 'served', message: 'secret' },
      { at: 2, kind: 'unknown-from-input', outcome: 'free-text', message: 'secret' },
    ] } });
    const activity = await invoke(h, IPC_CHANNELS.GET_ACTIVITY);
    assert(JSON.stringify(activity.items) === JSON.stringify([{ kind: 'get-served', at: 1, outcome: 'served' }]) && !JSON.stringify(activity).includes('secret'),
      'only frozen Activity kinds and outcomes can cross IPC; hostile values are dropped');
  } },
  { name: 'handoff bridge: ipc: publication only hints new or changed signatures and main notification targets its owner', run: () => {
    const hints = []; const h = setup({ engine: { hint: value => hints.push(value) } }); const publish = h.ipc.listeners.get(IPC_CHANNELS.PUBLISH_JOBS);
    const payload = { v: 1, seq: 1, jobs: [{ jobId: JOB, canvasFilePath: PATH, dockState: 'awaiting', sig: 'a' }] };
    publish(h.event, payload); publish(h.event, { ...payload, seq: 2 });
    publish(h.event, { ...payload, seq: 3, jobs: [{ ...payload.jobs[0], sig: 'b' }] });
    assert(JSON.stringify(hints) === JSON.stringify([{ jobId: JOB }, { jobId: JOB }]), 'unchanged publication must not invalidate engine work');
    assert(h.api.notifyJobChanged({ jobId: JOB, canvasFilePath: PATH }) && h.sender.sent.length === 1 && h.sender.sent[0].channel === IPC_EVENTS.JOB_CHANGED, 'only a main-owned bridge mutation may notify the owning live window');
  } },
  { name: 'handoff bridge: ipc: status broadcasts coalesce to four per second and fan out to every canvas', run: () => {
    const clock = fakeClock(); let subscriber = null; const windows = [];
    const h = setup({ now: clock.now, timers: clock.timers, getCanvasWindows: () => windows, controller: { subscribe: fn => { subscriber = fn; return () => undefined; } } });
    const secondSent = []; const second = { __canvasFilePath: '/tmp/second.canvas', isDestroyed: () => false, webContents: { id: 10, send(channel, value) { secondSent.push({ channel, value, at: clock.now() }); } } };
    windows.push(h.window, second);
    const firstSent = h.sender.sent;
    h.sender.send = (channel, value) => { firstSent.push({ channel, value, at: clock.now() }); };
    const emit = seq => subscriber({ v: 1, seq, at: clock.now(), enabled: true });
    emit(1);
    for (let seq = 2; seq <= 100; seq += 1) {
      clock.advance((seq - 1) * 10);
      emit(seq);
    }
    clock.advance(1_250);
    const firstStatus = firstSent.filter(item => item.channel === IPC_EVENTS.STATUS).map(item => ({ seq: item.value.seq, at: item.at }));
    const secondStatus = secondSent.filter(item => item.channel === IPC_EVENTS.STATUS).map(item => ({ seq: item.value.seq, at: item.at }));
    assert(firstStatus.length === secondStatus.length && firstStatus.length === 5, 'each status flush reaches every current canvas exactly once');
    assert(firstStatus.every(item => firstStatus.filter(other => other.at >= item.at && other.at < item.at + 1_000).length <= 4), 'no canvas receives more than four status messages per rolling second');
    assert(firstStatus.at(-1).seq === 100 && secondStatus.at(-1).seq === 100, 'bursts coalesce to the newest snapshot rather than replaying stale status');
  } },
  { name: 'handoff bridge: ipc: enable skips routine notifications while tray and Dock alarms remain independent', async run() {
    const notificationSpecs = []; let shown = 0; let enabled = 0;
    class DeniedNotification {
      constructor(spec) { notificationSpecs.push(spec); }
      show() { shown += 1; throw new Error('permission-denied'); }
    }
    const h = setup({ Notification: DeniedNotification, controller: { enable: async () => { enabled += 1; return { success: true }; } } });
    const result = await invoke(h, IPC_CHANNELS.SET_ENABLED, { enabled: true });
    assert(result.success && enabled === 1 && shown === 0 && notificationSpecs.length === 0,
      'enabling is an explicitly initiated routine action and must not create an OS permission prompt');

    const badges = []; let menu = null;
    class FakeTray { on() {} setContextMenu(value) { menu = value; } setToolTip() {} destroy() {} }
    const tray = createHandoffBridgeTray({
      Tray: FakeTray,
      Menu: { buildFromTemplate: value => value },
      nativeImage: { createFromDataURL: () => ({}) },
      app: { dock: { setBadge: value => badges.push(value) } },
      getCanvasWindows: () => [],
      controller: { pause() {}, resume() {}, disable() {} },
      notify: () => { throw new Error('permission-denied'); },
    });
    const alarmStatus = { enabled: true, serving: 'paused', pauseCause: 'anomaly', tunnel: { state: 'up' }, alarms: [{ kind: 'rate_limited', acknowledged: false, at: 1 }] };
    const view = tray.apply(alarmStatus); tray.alarm(alarmStatus);
    assert(view.glyph === 'alarm' && view.badge === '!' && badges.at(-1) === '!' && Array.isArray(menu),
      'the real tray truth table and Dock badge remain alarmed even when generic notifications are denied');
    tray.destroy();
  } },
  { name: 'handoff bridge: ipc: enable revalidates its exact canvas owner after deferred consent and native confirmation', async run() {
    const describe = deferred(); let asks = 0; let enables = 0; let windows = [];
    const h = setup({
      getCanvasWindows: () => windows,
      enableConsent: { describe: () => describe.promise, accept: async () => ({ ok: true }) },
      dialogs: { ask: async () => { asks += 1; return { ok: true }; } },
      controller: { enable: async () => { enables += 1; return { success: true }; } },
    });
    windows = [h.window];
    const duringDescribe = invoke(h, IPC_CHANNELS.SET_ENABLED, { enabled: true });
    windows = [];
    describe.resolve({ hostname: 'bridge.example.com', idlePauseMinutes: 1440, items: [], long: true });
    const describeResult = await duringDescribe;
    assert(describeResult.code === 'NO_WINDOW' && asks === 0 && enables === 0,
      'a canvas destroyed while enable consent describes must not reach a native sheet or controller');

    const confirm = deferred(); let destroyed = false;
    const h2 = setup({
      getCanvasWindows: () => destroyed ? [] : [h.window],
      dialogs: { ask: () => { asks += 1; return confirm.promise; } },
      controller: { enable: async () => { enables += 1; return { success: true }; } },
    });
    const duringConfirm = invoke(h2, IPC_CHANNELS.SET_ENABLED, { enabled: true });
    await settle();
    destroyed = true;
    confirm.resolve({ ok: true });
    const confirmResult = await duringConfirm;
    assert(confirmResult.code === 'NO_WINDOW' && enables === 0,
      'a canvas destroyed while its enable sheet is pending must not start the bridge');

    const replacement = { ...h.window, webContents: h.sender, isDestroyed: () => false };
    const replacementConfirm = deferred(); let replaced = false;
    const h3 = setup({
      getCanvasWindows: () => replaced ? [replacement] : [h.window],
      dialogs: { ask: () => replacementConfirm.promise },
      controller: { enable: async () => { enables += 1; return { success: true }; } },
    });
    const duringReplacement = invoke(h3, IPC_CHANNELS.SET_ENABLED, { enabled: true });
    await settle();
    replaced = true;
    replacementConfirm.resolve({ ok: true });
    const replacementResult = await duringReplacement;
    assert(replacementResult.code === 'NO_WINDOW' && enables === 0,
      'a replacement window with the same sender id cannot inherit a prior enable confirmation');
  } },
  { name: 'handoff bridge: ipc: every setup confirmation or chooser loses authority with its canvas window', async run() {
    const anomalyStatus = { pauseCause: 'anomaly', alarms: [{ id: 'rate_limited-1', kind: 'rate_limited', at: 1, acknowledged: false }] };
    const cases = [
      ['save config', IPC_CHANNELS.SAVE_CONFIG, { patch: { scope: { scoring: true } } }, 'ask', hit => ({ store: { writeConfig: async () => { hit(); return { ok: true }; } } })],
      ['choose binary', IPC_CHANNELS.CHOOSE_BINARY, undefined, 'choose', hit => ({ tunnel: { chooseBinary: async () => { hit(); return { ok: true }; } } })],
      ['approve binary', IPC_CHANNELS.APPROVE_BINARY, undefined, 'ask', hit => ({ tunnel: { approveBinary: async () => { hit(); return { ok: true }; } } })],
      ['choose credentials', IPC_CHANNELS.CHOOSE_CREDENTIALS, undefined, 'choose', hit => ({ tunnel: { chooseCredentials: async () => { hit(); return { ok: true }; } } })],
      ['anomaly resume', IPC_CHANNELS.RESUME, undefined, 'ask', hit => ({ controller: { snapshot: () => anomalyStatus, resume: async () => { hit(); return { success: true }; } } })],
      ['forget setup', IPC_CHANNELS.FORGET_SETUP, undefined, 'ask', hit => ({ controller: { forget: async () => { hit(); return { success: true }; } } })],
      ['release push', IPC_CHANNELS.RELEASE_PUSH, { hubs: ['a'.repeat(64)] }, 'ask', hit => ({ push: { release: async () => { hit(); return { ok: true }; } } })],
    ];
    for (const [label, channel, payload, dialogKind, optionsFor] of cases) {
      const response = deferred(); let windows = []; let dialogCalls = 0; let mutations = 0;
      const dialogs = dialogKind === 'choose'
        ? { choose: () => { dialogCalls += 1; return response.promise; } }
        : { ask: () => { dialogCalls += 1; return response.promise; } };
      const h = setup({ getCanvasWindows: () => windows, dialogs, ...optionsFor(() => { mutations += 1; }) });
      windows = [h.window];
      const pending = invoke(h, channel, payload);
      await settle();
      assert(dialogCalls === 1, `${label} race must reach its native ${dialogKind} before losing authority`);
      windows = [];
      response.resolve(dialogKind === 'choose' ? { ok: true, filePath: '/tmp/synthetic-selection' } : { ok: true });
      const result = await pending;
      assert(result.code === 'NO_WINDOW' && mutations === 0,
        `${label} must not mutate or expose bridge state after its native ${dialogKind} loses the exact canvas owner`);
    }
  } },
  { name: 'handoff bridge: ipc: authorized durable setup mutations finish their consistency follow-up after window loss', async run() {
    const cases = [
      ['save config', IPC_CHANNELS.SAVE_CONFIG, { patch: { scope: { scoring: true } } }, gate => ({
        store: { writeConfig: () => gate.promise },
        controller: { reloadConfig: async () => ({ success: true }) },
      })],
      ['choose binary', IPC_CHANNELS.CHOOSE_BINARY, undefined, gate => ({
        tunnel: { chooseBinary: () => gate.promise }, onSetupMutation: async () => ({ ok: true }),
      })],
      ['approve binary', IPC_CHANNELS.APPROVE_BINARY, undefined, gate => ({
        tunnel: { approveBinary: () => gate.promise }, onSetupMutation: async () => ({ ok: true }),
      })],
      ['choose credentials', IPC_CHANNELS.CHOOSE_CREDENTIALS, undefined, gate => ({
        tunnel: { chooseCredentials: () => gate.promise }, onSetupMutation: async () => ({ ok: true }),
      })],
    ];
    for (const [label, channel, payload, optionsFor] of cases) {
      const gate = deferred(); let windows = []; let followUps = 0;
      const options = optionsFor(gate);
      if (options.controller?.reloadConfig) {
        const reloadConfig = options.controller.reloadConfig;
        options.controller.reloadConfig = async () => { followUps += 1; return reloadConfig(); };
      } else {
        const onSetupMutation = options.onSetupMutation;
        options.onSetupMutation = async () => { followUps += 1; return onSetupMutation(); };
      }
      const h = setup({ getCanvasWindows: () => windows, ...options });
      windows = [h.window];
      const pending = invoke(h, channel, payload);
      await settle();
      windows = [];
      gate.resolve({ ok: true });
      const result = await pending;
      assert(result.success && followUps === 1,
        `${label} must finish its mandatory runtime consistency follow-up after an authorized durable mutation`);
    }
  } },
  { name: 'handoff bridge: ipc: rejects duplicate publication ids and validates push hub keys', async run() {
    let released = 0; const h = setup({ push: { release: async () => { released++; return { ok: true }; } } }); const publish = h.ipc.listeners.get(IPC_CHANNELS.PUBLISH_JOBS);
    publish(h.event, { v: 1, seq: 1, jobs: [{ jobId: JOB, canvasFilePath: PATH, dockState: 'awaiting', sig: 'a' }, { jobId: JOB, canvasFilePath: PATH, dockState: 'working', sig: 'b' }] });
    assert(h.api.candidates().size === 0, 'duplicate job ids are refused before candidate replacement');
    const invalid = await invoke(h, IPC_CHANNELS.RELEASE_PUSH, { hubs: ['not-a-hub-key'] });
    const valid = await invoke(h, IPC_CHANNELS.RELEASE_PUSH, { hubs: ['a'.repeat(64)] });
    assert(invalid.code === 'INVALID' && valid.success && released === 1, 'push routes accept only canonical 64-hex hub keys');
  } },
  { name: 'handoff bridge: ipc: config shape and hostname are checked before a dialog or write', async run() {
    let asked = 0; let writes = 0; const h = setup({ dialogs: { ask: async () => { asked++; return { ok: true }; } }, store: { writeConfig: async () => { writes++; return { ok: true }; } } });
    const invalid = await invoke(h, IPC_CHANNELS.SAVE_CONFIG, { patch: { hostname: 'BAD.EXAMPLE.COM' } });
    assert(invalid.code === 'INVALID' && asked === 0 && writes === 0, 'invalid renderer hostname must not reach native consent or the store');
    const errors = setup({ store: { writeConfig: async () => ({ ok: false, code: 'INVALID', fieldErrors: { hostname: 'FORMAT', 'bad field': 'LEAK' } }) } });
    const result = await invoke(errors, IPC_CHANNELS.SAVE_CONFIG, { patch: {} });
    assert(result.code === 'INVALID' && JSON.stringify(result.fieldErrors) === JSON.stringify({ hostname: 'FORMAT' }), 'only bounded field errors return through IPC');
  } },
  { name: 'handoff bridge: ipc: an injected hostname validator must return true, never a hostile string', async run() {
    let asked = 0; let writes = 0;
    const h = setup({ validateHostname: () => 'hostile.example.com', dialogs: { ask: async () => { asked += 1; return { ok: true }; } }, store: { writeConfig: async () => { writes += 1; return { ok: true }; } } });
    const result = await invoke(h, IPC_CHANNELS.SAVE_CONFIG, { patch: { hostname: 'hostile.example.com' } });
    assert(result.code === 'INVALID' && asked === 0 && writes === 0, 'a non-boolean validator result must not reach consent or persistence');
  } },
  { name: 'handoff bridge: ipc: pairing gets the persisted enforce-or-off network policy', async run() {
    const calls = []; const h = setup({ controller: { snapshot: () => ({ enabled: true, setup: { tunnelReachable: true }, config: { hostname: 'bridge.example.com', scope: { applications: true, scoring: false }, pluginName: 'infinite_canvas' }, prefs: { sourcePolicy: 'enforce', pairingNetworkCheck: false }, limits: {}, autoRelease: false }) }, oauth: { openPairing: async value => { calls.push(value); return { ok: true, expiresAt: 1, pairingCode: '23456-789AB' }; } } });
    const result = await invoke(h, IPC_CHANNELS.OPEN_PAIRING);
    assert(result.success && result.pairingCode === '23456-789AB' && result.expiresAt === 1 && calls[0].networkCheck === 'off' && calls[0].hostname === 'bridge.example.com', 'pairing must receive the persisted network check as an enum and return its validated formatted code only to the opening call');
    assert(h.sender.sent.length === 0 && !JSON.stringify(h.api).includes('23456-789AB'), 'a direct pairing-code reply must not become a renderer event or retained UI registry state');
    let malformedCancelled = 0;
    const malformed = setup({ oauth: { openPairing: async () => ({ ok: true, expiresAt: 2, pairingCode: 'not-a-pairing-code' }), cancelPairing: async () => { malformedCancelled += 1; return { ok: true }; } } });
    const malformedResult = await invoke(malformed, IPC_CHANNELS.OPEN_PAIRING);
    assert(malformedResult.success === false && malformedResult.code === 'INTERNAL' && malformedCancelled === 1 && !Object.hasOwn(malformedResult, 'pairingCode'),
      'a malformed direct pairing capability is cancelled and never crosses IPC as a partial success');
  } },
  { name: 'handoff bridge: ipc: pairing needs readiness but has no routine pre-confirmation', async run() {
    let asks = 0; let opened = 0;
    const off = setup({ controller: { snapshot: () => ({ enabled: false, setup: { tunnelReachable: true } }) }, dialogs: { ask: async () => { asks += 1; return { ok: true }; } }, oauth: { openPairing: async () => { opened += 1; return { ok: true }; } } });
    assert((await invoke(off, IPC_CHANNELS.OPEN_PAIRING)).code === 'TUNNEL_NOT_READY' && asks === 0 && opened === 0, 'off status reaches neither a native pairing sheet nor OAuth');
    const status = { enabled: true, setup: { tunnelReachable: true }, config: { hostname: 'bridge.example.com', scope: { applications: true, scoring: false } }, prefs: { sourcePolicy: 'enforce', pairingNetworkCheck: true }, limits: {}, autoRelease: false };
    let reads = 0;
    const raced = setup({ controller: { snapshot: () => { reads += 1; return reads === 1 ? status : { ...status, enabled: false }; } }, dialogs: { ask: async () => { asks += 1; return { ok: true }; } }, oauth: { openPairing: async () => { opened += 1; return { ok: true }; } } });
    assert((await invoke(raced, IPC_CHANNELS.OPEN_PAIRING)).code === 'TUNNEL_NOT_READY' && asks === 0 && opened === 0,
      'the status is rechecked immediately before OAuth without adding a routine native sheet');
  } },
  { name: 'handoff bridge: ipc: pairing rechecks the exact canvas before opening OAuth', async run() {
    let opened = 0; let reads = 0; let windows = [];
    const status = { enabled: true, setup: { tunnelReachable: true }, config: { hostname: 'bridge.example.com', scope: { applications: true, scoring: false } }, prefs: { sourcePolicy: 'enforce', pairingNetworkCheck: true }, limits: {}, autoRelease: false };
    const h = setup({
      getCanvasWindows: () => windows,
      controller: { snapshot: () => { reads += 1; if (reads === 1) windows = []; return status; } },
      oauth: { openPairing: async () => { opened += 1; return { ok: true }; } },
    });
    windows = [h.window];
    assert((await invoke(h, IPC_CHANNELS.OPEN_PAIRING)).code === 'NO_WINDOW' && opened === 0,
      'removing the requesting canvas between readiness and OAuth cannot borrow a different window');
  } },
  { name: 'handoff bridge: ipc: pairing rechecks the canvas after its final status read', async run() {
    let opened = 0; let reads = 0; let windows = [];
    const status = { enabled: true, setup: { tunnelReachable: true }, config: { hostname: 'bridge.example.com', scope: { applications: true, scoring: false } }, prefs: { sourcePolicy: 'enforce', pairingNetworkCheck: true }, limits: {}, autoRelease: false };
    const h = setup({
      getCanvasWindows: () => windows,
      controller: { snapshot: () => { reads += 1; if (reads === 2) windows = []; return status; } },
      oauth: { openPairing: async () => { opened += 1; return { ok: true }; } },
    });
    windows = [h.window];
    assert((await invoke(h, IPC_CHANNELS.OPEN_PAIRING)).code === 'NO_WINDOW' && opened === 0,
      'a canvas removed by the second readiness read cannot open an OAuth pairing flow');
  } },
  { name: 'handoff bridge: ipc: a canvas that closes while pairing opens receives no code and cancels pairing', async run() {
    let cancellations = 0; let windows = [];
    const h = setup({
      getCanvasWindows: () => windows,
      oauth: {
        openPairing: async () => {
          windows = [];
          return { ok: true, expiresAt: 1, pairingCode: '23456-789AB' };
        },
        cancelPairing: async () => { cancellations += 1; return { ok: true }; },
      },
    });
    windows = [h.window];
    const result = await invoke(h, IPC_CHANNELS.OPEN_PAIRING);
    assert(result.code === 'NO_WINDOW' && cancellations === 1 && !Object.hasOwn(result, 'pairingCode'),
      'the post-await window guard clears a late pairing and never returns its code to a closed canvas');
  } },
  { name: 'handoff bridge: ipc: outstanding-work disable has one main-owned critical confirmation', async run() {
    let asks = 0; let disables = 0;
    const status = { enabled: true, chat: { outstanding: { stage: 'resume' } }, setup: { tunnelReachable: true }, config: { hostname: 'bridge.example.com', scope: { applications: true, scoring: false } }, limits: {}, prefs: {}, autoRelease: false };
    const h = setup({ controller: { snapshot: () => status, disable: async () => { disables += 1; return { success: true }; } }, dialogs: { ask: async (_sender, kind) => { asks += 1; return kind === 'disable' ? { ok: true } : { ok: false }; } } });
    assert((await invoke(h, IPC_CHANNELS.SET_ENABLED, { enabled: false, confirmed: true })).success && asks === 1 && disables === 1,
      'hostile renderer acknowledgement fields cannot bypass the one native disable sheet');
    const ordinary = setup({ controller: { snapshot: () => ({ ...status, chat: { outstanding: false } }), disable: async () => { disables += 1; return { success: true }; } }, dialogs: { ask: async () => { asks += 1; return { ok: true }; } } });
    assert((await invoke(ordinary, IPC_CHANNELS.SET_ENABLED, { enabled: false })).success && asks === 1 && disables === 2,
      'a normal stop remains immediate and never opens a routine popup');
    let windowlessAsks = 0; let windowlessDisables = 0;
    const windowlessOrdinary = setup({
      windows: [],
      controller: { snapshot: () => ({ ...status, chat: { outstanding: null } }), disable: async () => { windowlessDisables += 1; return { success: true }; } },
      dialogs: { ask: async () => { windowlessAsks += 1; return { ok: true }; } },
    });
    assert((await invoke(windowlessOrdinary, IPC_CHANNELS.SET_ENABLED, { enabled: false })).code === 'NO_WINDOW'
      && windowlessAsks === 0 && windowlessDisables === 0,
    'a canvas without its exact live window cannot perform even an ordinary popup-free hard stop');
    const declined = setup({ controller: { snapshot: () => status, disable: async () => { disables += 1; return { success: true }; } }, dialogs: { ask: async () => ({ ok: false, code: 'DECLINED' }) } });
    assert((await invoke(declined, IPC_CHANNELS.SET_ENABLED, { enabled: false })).code === 'DECLINED' && disables === 2,
      'declining the one critical stop sheet leaves serving untouched');
    const absent = setup({ windows: [], controller: { snapshot: () => status, disable: async () => { disables += 1; return { success: true }; } }, dialogs: { ask: async () => { asks += 1; return { ok: true }; } } });
    assert((await invoke(absent, IPC_CHANNELS.SET_ENABLED, { enabled: false })).code === 'NO_WINDOW' && asks === 1 && disables === 2,
      'outstanding work with no live requesting canvas shows no sheet and does not disable');
    const sheet = deferred(); let windows = [];
    const raced = setup({
      getCanvasWindows: () => windows,
      controller: { snapshot: () => status, disable: async () => { disables += 1; return { success: true }; } },
      dialogs: { ask: async () => sheet.promise },
    });
    windows = [raced.window];
    const pending = invoke(raced, IPC_CHANNELS.SET_ENABLED, { enabled: false }); await settle();
    windows = []; sheet.resolve({ ok: true });
    assert((await pending).code === 'NO_WINDOW' && disables === 2,
      'closing the canvas while the critical stop sheet is pending leaves the bridge running');
  } },
  { name: 'handoff bridge: ipc: repeat enable skips the native sheet and defers restart acknowledgement', async run() {
    const calls = []; let asks = 0; let accepts = 0;
    const h = setup({
      enableConsent: { describe: async () => ({ hostname: 'bridge.example.com', idlePauseMinutes: 1440, items: [], long: false }), accept: async () => { accepts += 1; return { ok: true }; } },
      dialogs: { ask: async () => { asks += 1; return { ok: true }; } },
      controller: { enable: async value => { calls.push(value); return { success: true }; } },
    });
    assert((await invoke(h, IPC_CHANNELS.SET_ENABLED, { enabled: true })).success
      && asks === 0 && accepts === 0
      && JSON.stringify(calls) === JSON.stringify([{ confirmed: true, restartConfirmed: false }]),
    'a repeat enable starts directly but leaves the first New chat/Continue restart acknowledgement intact');
  } },
  { name: 'handoff bridge: ipc: a repeat enable loses authority if its consent lookup outlives its canvas', async run() {
    const describe = deferred(); let windows = []; let enabled = 0;
    const h = setup({
      getCanvasWindows: () => windows,
      enableConsent: { describe: () => describe.promise },
      controller: { enable: async () => { enabled += 1; return { success: true }; } },
    });
    windows = [h.window];
    const pending = invoke(h, IPC_CHANNELS.SET_ENABLED, { enabled: true });
    windows = [];
    describe.resolve({ hostname: 'bridge.example.com', idlePauseMinutes: 1440, items: [], long: false });
    assert((await pending).code === 'NO_WINDOW' && enabled === 0,
      'skipping a routine sheet never lets a stale sender start the bridge after its async consent lookup');
  } },
  { name: 'handoff bridge: ipc: linked hostname changes use one main-owned link-break confirmation', async run() {
    const asks = []; const writes = [];
    const h = setup({
      dialogs: { ask: async (_sender, kind, details) => { asks.push([kind, details]); return { ok: true }; } },
      store: { writeConfig: async patch => { writes.push(patch); return writes.length === 1 ? { ok: false, code: 'LINK_WOULD_BREAK' } : { ok: true }; } },
    });
    const result = await invoke(h, IPC_CHANNELS.SAVE_CONFIG, { patch: { hostname: 'next.example.com' }, confirmBreak: true });
    assert(result.success && JSON.stringify(asks) === JSON.stringify([['linkBreak', { hostname: 'next.example.com' }]])
      && writes.length === 2 && writes[0].confirmBreak === false && writes[1].confirmBreak === true,
    'a renderer confirmBreak flag is ignored; the serialized link-break result earns exactly one main-owned confirmation and retry');
  } },
  { name: 'handoff bridge: ipc: a concurrent pairing open preserves the fixed BUSY result', async run() {
    const h = setup({ oauth: { openPairing: async () => ({ ok: false, code: 'BUSY' }) } });
    const result = await invoke(h, IPC_CHANNELS.OPEN_PAIRING);
    assert(result.success === false && result.code === 'BUSY', 'the renderer must not mistake an in-flight native pairing gate for tunnel failure');
  } },
  { name: 'handoff bridge: ipc: tunnel log relay drops non-text, oversized and invisible values', async run() {
    const h = setup({ tunnel: { getLog: async () => ['redacted ok', 7, 'x'.repeat(1025), 'bad\u202etext', ...Array.from({ length: 101 }, () => 'line')] } });
    const result = await invoke(h, IPC_CHANNELS.GET_TUNNEL_LOG);
    assert(result.success && result.lines[0] === 'redacted ok' && result.lines.length === 97 && result.lines.every(line => typeof line === 'string' && line.length <= 1024), 'IPC relays only bounded trusted redacted strings');
  } },
  { name: 'handoff bridge: ipc: only a closed tunnel-not-serving startup diagnosis receives actionable renderer feedback', async run() {
    const actionable = setup({
      controller: {
        enable: async () => ({ success: false, code: 'tunnel_failed', diagnostic: { cause: 'readiness-timeout', tunnel: { probe: { reason: 'tunnel-not-serving' } } } }),
      },
      enableConsent: { describe: async () => ({ hostname: 'bridge.example.com', idlePauseMinutes: 1440, items: [], long: false }) },
    });
    const generic = setup({
      controller: {
        enable: async () => ({ success: false, code: 'tunnel_failed', diagnostic: { cause: 'hostile internal detail', tunnel: { probe: { reason: 'hostile internal detail' } } } }),
      },
      enableConsent: { describe: async () => ({ hostname: 'bridge.example.com', idlePauseMinutes: 1440, items: [], long: false }) },
    });
    assert((await invoke(actionable, IPC_CHANNELS.SET_ENABLED, { enabled: true })).code === 'TUNNEL_NOT_SERVING'
      && (await invoke(generic, IPC_CHANNELS.SET_ENABLED, { enabled: true })).code === 'UNAVAILABLE',
    'only the fixed Cloudflare tunnel-not-serving diagnostic crosses the startup IPC boundary');
  } },
  { name: 'handoff bridge: ipc: long enable consent persists after enable and fails closed on persistence error', async run() {
    const calls = []; const good = setup({ controller: { enable: async value => { calls.push(value); return { success: true }; } }, enableConsent: { accept: async details => { calls.push(details.long ? 'accept-long' : 'accept-short'); return { ok: true }; } } });
    assert((await invoke(good, IPC_CHANNELS.SET_ENABLED, { enabled: true })).success && JSON.stringify(calls) === JSON.stringify([{ confirmed: true, restartConfirmed: true }, 'accept-long']), 'a successful long enable records internal consent after transport enablement and satisfies this launch restart acknowledgement');
    const failed = []; const bad = setup({ controller: { enable: async () => ({ success: true }), disable: async () => { failed.push('disable'); return { success: true }; } }, enableConsent: { accept: async () => ({ ok: false }) } });
    const result = await invoke(bad, IPC_CHANNELS.SET_ENABLED, { enabled: true });
    assert(result.code === 'UNAVAILABLE' && JSON.stringify(failed) === JSON.stringify(['disable']), 'unpersisted long consent immediately disables the bridge and exposes no consent state');
  } },
  { name: 'handoff bridge: ipc: unrelease-push accepts only a canonical hub key', async run() {
    let called = 0; const h = setup({ push: { unrelease: async () => { called++; return { ok: true }; } } });
    assert((await invoke(h, IPC_CHANNELS.UNRELEASE_PUSH, { hub: 'bad' })).code === 'INVALID', 'malformed opaque hub key never reaches controller');
    assert((await invoke(h, IPC_CHANNELS.UNRELEASE_PUSH, { hub: 'a'.repeat(64) })).success && called === 1, 'canonical hub key routes once');
  } },
  { name: 'handoff bridge: ipc: auto-release requires disk provenance strictly after process launch', async run() {
    const releases = []; const startedAt = Date.parse('2026-01-01T00:00:00.000Z');
    const h = setup({ processStartedAt: startedAt, controller: { snapshot: () => ({ config: { hostname: 'bridge.example.com' }, prefs: {}, autoRelease: true }), release: async value => { releases.push(value); return { success: true }; } }, application: { describeForConfirm: async () => ({ ok: true, canvasFilePath: PATH, items: [{ jobId: JOB, createdAt: '2026-01-01T00:00:00.000Z' }] }) } });
    h.ipc.listeners.get(IPC_CHANNELS.PUBLISH_JOBS)(h.event, { v: 1, seq: 1, jobs: [{ jobId: JOB, canvasFilePath: PATH, dockState: 'awaiting', sig: 'new' }] });
    await new Promise(resolve => setImmediate(resolve));
    assert(releases.length === 0, 'a job stamped exactly at launch is not main-created after this process began');
  } },
  { name: 'handoff bridge: ipc: release and auto-release intersect adapter rows with exact published ids', async run() {
    const releases = []; const dialogs = [];
    const explicit = setup({
      controller: { release: async value => { releases.push(value); return { success: true, released: value.jobs.length }; } },
      dialogs: { ask: async (_sender, kind, details) => { dialogs.push([kind, details]); return { ok: true }; } },
      application: { describeForConfirm: async () => ({ ok: true, canvasFilePath: PATH, items: [{ jobId: JOB, title: 'Ada Lovelace' }, { jobId: EXTRA_JOB, title: 'extra synthetic' }] }) },
    });
    explicit.ipc.listeners.get(IPC_CHANNELS.PUBLISH_JOBS)(explicit.event, { v: 1, seq: 1, jobs: [{ jobId: JOB, canvasFilePath: PATH, dockState: 'awaiting', sig: 'one' }] });
    assert((await invoke(explicit, IPC_CHANNELS.RELEASE, { items: [{ jobId: JOB }] })).success
      && JSON.stringify(releases) === JSON.stringify([{ jobs: [{ jobId: JOB, canvasFilePath: PATH }] }])
      && dialogs[0][1].items.length === 1 && dialogs[0][1].items[0].jobId === JOB,
    'an overbroad describe result may neither appear in confirmation nor reach release');

    const missing = []; const incomplete = setup({
      controller: { release: async value => { missing.push(value); return { success: true }; } },
      application: { describeForConfirm: async () => ({ ok: true, canvasFilePath: PATH, items: [{ jobId: EXTRA_JOB }] }) },
    });
    incomplete.ipc.listeners.get(IPC_CHANNELS.PUBLISH_JOBS)(incomplete.event, { v: 1, seq: 1, jobs: [{ jobId: JOB, canvasFilePath: PATH, dockState: 'awaiting', sig: 'one' }] });
    assert((await invoke(incomplete, IPC_CHANNELS.RELEASE, { items: [{ jobId: JOB }] })).success === false && missing.length === 0,
      'explicit release fails closed when any exact requested row is missing');

    const duplicateReleases = []; const duplicateDialogs = [];
    const duplicate = setup({
      controller: { release: async value => { duplicateReleases.push(value); return { success: true }; } },
      dialogs: { ask: async (...args) => { duplicateDialogs.push(args); return { ok: true }; } },
      application: { describeForConfirm: async () => ({ ok: true, canvasFilePath: PATH, items: [{ jobId: JOB, title: 'first row' }, { jobId: JOB, title: 'duplicate row' }] }) },
    });
    duplicate.ipc.listeners.get(IPC_CHANNELS.PUBLISH_JOBS)(duplicate.event, { v: 1, seq: 1, jobs: [{ jobId: JOB, canvasFilePath: PATH, dockState: 'awaiting', sig: 'duplicate' }] });
    assert((await invoke(duplicate, IPC_CHANNELS.RELEASE, { items: [{ jobId: JOB }] })).success === false
      && duplicateDialogs.length === 0 && duplicateReleases.length === 0,
    'duplicate adapter rows for one requested id are ambiguous and must fail before native confirmation or release');

    const automatic = []; const startedAt = Date.parse('2026-01-01T00:00:00.000Z');
    const autoStatus = { enabled: true, serving: 'live', config: { hostname: 'bridge.example.com' }, prefs: {}, autoRelease: true };
    const auto = setup({ processStartedAt: startedAt,
      controller: { snapshot: () => autoStatus, release: async value => { automatic.push(value); return { success: true }; } },
      application: { describeForConfirm: async () => ({ ok: true, canvasFilePath: PATH, items: [
        { jobId: JOB, createdAt: '2026-01-01T00:00:00.001Z' }, { jobId: EXTRA_JOB, createdAt: '2026-01-01T00:00:00.001Z' },
      ] }) },
    });
    auto.ipc.listeners.get(IPC_CHANNELS.PUBLISH_JOBS)(auto.event, { v: 1, seq: 1, jobs: [{ jobId: JOB, canvasFilePath: PATH, dockState: 'awaiting', sig: 'auto' }] });
    await new Promise(resolve => setImmediate(resolve));
    assert(JSON.stringify(automatic) === JSON.stringify([{ jobs: [{ jobId: JOB, canvasFilePath: PATH }], auto: true }]),
      'auto-release must intersect post-launch adapter rows with the exact awaiting publication, and mark itself unattended');
  } },
  { name: 'handoff bridge: ipc: auto-release is one-shot per job: keep-alives never re-describe or re-release, and an Unrelease sticks', async run() {
    const startedAt = Date.parse('2026-01-01T00:00:00.000Z');
    const status = { enabled: true, serving: 'live', config: { hostname: 'bridge.example.com' }, prefs: {}, autoRelease: true };
    const released = []; let describes = 0; const thirdArgs = [];
    const h = setup({ processStartedAt: startedAt,
      controller: { snapshot: () => status, release: async value => { released.push(value); return { success: true, ok: true, count: 1 }; } },
      application: { describeForConfirm: async (_path, _ids, options) => { describes++; thirdArgs.push(options); return { ok: true, canvasFilePath: PATH, items: [{ jobId: JOB, createdAt: '2026-01-01T00:00:00.001Z' }] }; } } });
    const publish = h.ipc.listeners.get(IPC_CHANNELS.PUBLISH_JOBS);
    const jobs = [{ jobId: JOB, canvasFilePath: PATH, dockState: 'awaiting', sig: 'a' }];
    publish(h.event, { v: 1, seq: 1, jobs }); await settle(12);
    // The renderer force-publishes the same state every 30 s.
    for (let seq = 2; seq <= 4; seq += 1) { publish(h.event, { v: 1, seq, jobs }); await settle(12); }
    assert(released.length === 1 && describes === 1, `three keep-alives after the first publication must not re-run the pipeline (released ${released.length}, described ${describes})`);
    assert(thirdArgs[0]?.requireAll === false, 'the auto path asks for a partial answer so one vanished job cannot hide the rest');
    // A person withdraws the release (the controller unreleases); the next keep-alive must not undo it.
    publish(h.event, { v: 1, seq: 5, jobs: [{ ...jobs[0], sig: 'b' }] }); await settle(12);
    assert(released.length === 1, 'a changed signature on an already-handled job does not re-release it either');
    // Once the job leaves the dock, and a later card with the same id is not a thing, the memory is dropped.
    publish(h.event, { v: 1, seq: 6, jobs: [] }); await settle(12);
    publish(h.event, { v: 1, seq: 7, jobs }); await settle(12);
    assert(released.length === 2, 'after the job left the publication it is a fresh candidate again');
  } },
  { name: 'handoff bridge: ipc: a job that already holds a lane is never re-described or re-released when its card leaves and re-enters the publication between stages', async run() {
    const startedAt = Date.parse('2026-01-01T00:00:00.000Z');
    const status = { enabled: true, serving: 'live', config: { hostname: 'bridge.example.com' }, prefs: {}, autoRelease: true, queue: { jobs: [] } };
    const released = []; let describes = 0;
    const h = setup({ processStartedAt: startedAt,
      controller: { snapshot: () => status, release: async value => { released.push(value); status.queue.jobs = [{ jobId: JOB, phase: 'awaiting' }]; return { success: true, ok: true, count: 1 }; } },
      application: { describeForConfirm: async () => { describes++; return { ok: true, canvasFilePath: PATH, items: [{ jobId: JOB, createdAt: '2026-01-01T00:00:00.001Z' }] }; } } });
    const publish = h.ipc.listeners.get(IPC_CHANNELS.PUBLISH_JOBS);
    const jobs = [{ jobId: JOB, canvasFilePath: PATH, dockState: 'awaiting', sig: 'stage-1' }];
    publish(h.event, { v: 1, seq: 1, jobs }); await settle(12);
    assert(released.length === 1 && describes === 1, 'the first publication releases once');
    // Each stage change: the card is neither working nor awaiting for a moment (not published), then awaiting again.
    for (let stage = 2; stage <= 6; stage += 1) {
      publish(h.event, { v: 1, seq: stage * 2 - 2, jobs: [] }); await settle(12);
      publish(h.event, { v: 1, seq: stage * 2 - 1, jobs: [{ ...jobs[0], sig: `stage-${stage}` }] }); await settle(12);
    }
    assert(released.length === 1 && describes === 1, `five later stages must not add a describe or a release (released ${released.length}, described ${describes})`);
    // The lane is removed (an Unrelease or a discard) and the card comes back: it is a fresh candidate, exactly as before.
    status.queue.jobs = [];
    publish(h.event, { v: 1, seq: 100, jobs: [] }); await settle(12);
    publish(h.event, { v: 1, seq: 101, jobs }); await settle(12);
    assert(released.length === 2, 'without a lane the job is released again');
  } },
  { name: 'handoff bridge: ipc: a failed or partial auto-release is retried on the next publication, not remembered as handled', async run() {
    const startedAt = Date.parse('2026-01-01T00:00:00.000Z');
    const status = { enabled: true, serving: 'live', config: { hostname: 'bridge.example.com' }, prefs: {}, autoRelease: true };
    let attempts = 0; let outcome = { success: false, ok: false, code: 'lane_limit' };
    const h = setup({ processStartedAt: startedAt,
      controller: { snapshot: () => status, release: async () => { attempts++; return outcome; } },
      application: { describeForConfirm: async () => ({ ok: true, canvasFilePath: PATH, items: [{ jobId: JOB, createdAt: '2026-01-01T00:00:00.001Z' }] }) } });
    const publish = h.ipc.listeners.get(IPC_CHANNELS.PUBLISH_JOBS);
    const jobs = [{ jobId: JOB, canvasFilePath: PATH, dockState: 'awaiting', sig: 'a' }];
    publish(h.event, { v: 1, seq: 1, jobs }); await settle(12);
    outcome = { success: true, ok: true, count: 1 };
    publish(h.event, { v: 1, seq: 2, jobs }); await settle(12);
    publish(h.event, { v: 1, seq: 3, jobs }); await settle(12);
    assert(attempts === 2, `the refused release is retried once it can succeed and then stops (attempts ${attempts})`);
    status.autoRelease = false;
    publish(h.event, { v: 1, seq: 4, jobs }); await settle(12);
    status.autoRelease = true;
    publish(h.event, { v: 1, seq: 5, jobs }); await settle(12);
    assert(attempts === 3, 'turning auto-release off and on again starts a fresh session for it');
  } },
  { name: 'handoff bridge: ipc: a job that vanishes from the publication (Discard bundle) hints the engine so its lane is re-read', run: () => {
    const hints = []; const h = setup({ engine: { hint: value => hints.push(value) } }); const publish = h.ipc.listeners.get(IPC_CHANNELS.PUBLISH_JOBS);
    publish(h.event, { v: 1, seq: 1, jobs: [{ jobId: JOB, canvasFilePath: PATH, dockState: 'awaiting', sig: 'a' }] });
    publish(h.event, { v: 1, seq: 2, jobs: [] });
    assert(JSON.stringify(hints) === JSON.stringify([{ jobId: JOB }, { jobId: JOB }]), 'appearing and disappearing are both state changes');
    publish(h.event, { v: 1, seq: 3, jobs: [] });
    assert(hints.length === 2, 'an unchanged empty publication hints nothing');
  } },
  { name: 'handoff bridge: ipc: Disable during a deferred describe or confirmation cannot release', async run() {
    const published = { v: 1, seq: 1, jobs: [{ jobId: JOB, canvasFilePath: PATH, dockState: 'awaiting', sig: 'race' }] };
    const describeGate = {};
    describeGate.promise = new Promise(resolve => { describeGate.resolve = resolve; });
    const firstStatus = { enabled: true, serving: 'live', config: { hostname: 'bridge.example.com' }, prefs: {}, autoRelease: false };
    let firstReleases = 0;
    const describeRace = setup({ controller: { snapshot: () => firstStatus, release: async () => { firstReleases++; return { success: true }; } }, application: { describeForConfirm: async () => describeGate.promise } });
    describeRace.ipc.listeners.get(IPC_CHANNELS.PUBLISH_JOBS)(describeRace.event, published);
    const first = invoke(describeRace, IPC_CHANNELS.RELEASE, { items: [{ jobId: JOB }] }); await Promise.resolve(); firstStatus.enabled = false;
    describeGate.resolve({ ok: true, canvasFilePath: PATH, items: [{ jobId: JOB }] });
    assert((await first).code === 'NOT_READY' && firstReleases === 0, 'Disable during describe must stop release before the native confirmation');

    let resolveConfirm; const confirm = new Promise(resolve => { resolveConfirm = resolve; });
    const secondStatus = { enabled: true, serving: 'live', config: { hostname: 'bridge.example.com' }, prefs: {}, autoRelease: false };
    let secondReleases = 0;
    const confirmRace = setup({ controller: { snapshot: () => secondStatus, release: async () => { secondReleases++; return { success: true }; } }, dialogs: { ask: async () => confirm } });
    confirmRace.ipc.listeners.get(IPC_CHANNELS.PUBLISH_JOBS)(confirmRace.event, published);
    const second = invoke(confirmRace, IPC_CHANNELS.RELEASE, { items: [{ jobId: JOB }] }); await Promise.resolve(); secondStatus.enabled = false; resolveConfirm({ ok: true });
    assert((await second).code === 'NOT_READY' && secondReleases === 0, 'Disable during native confirmation must stop release into an old or replacement runtime');
  } },
  { name: 'handoff bridge: ipc: explicit and automatic release revalidate a captured window and publication after every await', async run() {
    const payload = { v: 1, seq: 1, jobs: [{ jobId: JOB, canvasFilePath: PATH, dockState: 'awaiting', sig: 'race' }] };
    const cases = [
      ['destroyed', 'NO_WINDOW', h => { h.window.isDestroyed = () => true; }],
      ['repointed', 'NO_WINDOW', h => { h.window.__canvasFilePath = '/tmp/repointed.canvas'; }],
      ['unmounted', 'UNKNOWN_JOB', (h, publish) => publish(h.event, { v: 1, unmount: true })],
      ['replaced publication', 'UNKNOWN_JOB', (h, publish) => publish(h.event, { ...payload, seq: 2, jobs: [{ ...payload.jobs[0], dockState: 'working', sig: 'replacement' }] })],
    ];
    for (const [label, code, mutate] of cases) {
      const describe = deferred(); const windows = []; let releases = 0;
      const h = setup({ getCanvasWindows: () => windows,
        controller: { snapshot: () => ({ enabled: true, serving: 'live', config: { hostname: 'bridge.example.com' }, prefs: {}, autoRelease: false }), release: async () => { releases += 1; return { success: true }; } },
        application: { describeForConfirm: async () => describe.promise },
      });
      windows.push(h.window);
      const publish = h.ipc.listeners.get(IPC_CHANNELS.PUBLISH_JOBS);
      publish(h.event, payload);
      const pending = invoke(h, IPC_CHANNELS.RELEASE, { items: [{ jobId: JOB }] });
      await settle();
      mutate(h, publish);
      describe.resolve({ ok: true, canvasFilePath: PATH, items: [{ jobId: JOB }] });
      assert((await pending).code === code && releases === 0, `${label} context must fail closed before native confirmation or release`);
    }

    const confirm = deferred(); const confirmationWindows = []; let confirmationAsks = 0; let confirmationReleases = 0;
    const confirmation = setup({ getCanvasWindows: () => confirmationWindows,
      controller: { snapshot: () => ({ enabled: true, serving: 'live', config: { hostname: 'bridge.example.com' }, prefs: {}, autoRelease: false }), release: async () => { confirmationReleases += 1; return { success: true }; } },
      application: { describeForConfirm: async () => ({ ok: true, canvasFilePath: PATH, items: [{ jobId: JOB }] }) },
      dialogs: { ask: async () => { confirmationAsks += 1; return confirm.promise; } },
    });
    confirmationWindows.push(confirmation.window);
    confirmation.ipc.listeners.get(IPC_CHANNELS.PUBLISH_JOBS)(confirmation.event, payload);
    const afterConfirm = invoke(confirmation, IPC_CHANNELS.RELEASE, { items: [{ jobId: JOB }] });
    await settle();
    assert(confirmationAsks === 1, 'the confirmation race must reach the native await before invalidating its window');
    confirmation.window.__canvasFilePath = '/tmp/repointed-after-confirm.canvas';
    confirm.resolve({ ok: true });
    assert((await afterConfirm).code === 'NO_WINDOW' && confirmationReleases === 0,
      'a repointed window while the native confirmation is open cannot release the earlier publication');

    for (const [label, _code, mutate] of cases) {
      const describe = deferred(); const windows = []; const releases = [];
      const h = setup({ processStartedAt: 0, getCanvasWindows: () => windows,
        controller: { snapshot: () => ({ enabled: true, serving: 'live', config: { hostname: 'bridge.example.com' }, prefs: {}, autoRelease: true }), release: async value => { releases.push(value); return { success: true }; } },
        application: { describeForConfirm: async () => describe.promise },
      });
      windows.push(h.window);
      const publish = h.ipc.listeners.get(IPC_CHANNELS.PUBLISH_JOBS);
      publish(h.event, payload);
      await settle();
      mutate(h, publish);
      describe.resolve({ ok: true, canvasFilePath: PATH, items: [{ jobId: JOB, createdAt: '2026-01-01T00:00:00.001Z' }] });
      await settle(12);
      assert(releases.length === 0, `auto-release must reject a ${label} captured context before controller.release`);
    }
  } },
  { name: 'handoff bridge: ipc: every state mutation fails closed on a missing or throwing port acknowledgement', async run() {
    const failure = kind => async () => {
      if (kind === 'throw') throw new Error('secret-from-port-must-not-cross-ipc');
      return undefined;
    };
    const cases = [
      ['enable', IPC_CHANNELS.SET_ENABLED, { enabled: true }, kind => ({ controller: { enable: failure(kind) } })],
      ['disable', IPC_CHANNELS.SET_ENABLED, { enabled: false }, kind => ({ controller: { disable: failure(kind) } })],
      ['save', IPC_CHANNELS.SAVE_CONFIG, { patch: {} }, kind => ({ store: { writeConfig: failure(kind) } })],
      ['choose binary', IPC_CHANNELS.CHOOSE_BINARY, undefined, kind => ({ tunnel: { chooseBinary: failure(kind) } })],
      ['approve binary', IPC_CHANNELS.APPROVE_BINARY, undefined, kind => ({ tunnel: { approveBinary: failure(kind) } })],
      ['choose credentials', IPC_CHANNELS.CHOOSE_CREDENTIALS, undefined, kind => ({ tunnel: { chooseCredentials: failure(kind) } })],
      ['restart', IPC_CHANNELS.RESTART_TUNNEL, undefined, kind => ({ tunnel: { restart: failure(kind) } })],
      ['stop orphan', IPC_CHANNELS.STOP_ORPHAN, undefined, kind => ({ tunnel: { reapOrphans: failure(kind) } })],
      ['open pairing', IPC_CHANNELS.OPEN_PAIRING, undefined, kind => ({ oauth: { openPairing: failure(kind) } })],
      ['cancel pairing', IPC_CHANNELS.CANCEL_PAIRING, undefined, kind => ({ oauth: { cancelPairing: failure(kind) } })],
      ['pause', IPC_CHANNELS.PAUSE, undefined, kind => ({ controller: { pause: failure(kind) } })],
      ['resume', IPC_CHANNELS.RESUME, undefined, kind => ({ controller: { resume: failure(kind) } })],
      ['revoke', IPC_CHANNELS.REVOKE_ALL, undefined, kind => ({ controller: { revokeAll: failure(kind) } })],
      ['forget', IPC_CHANNELS.FORGET_SETUP, undefined, kind => ({ controller: { forget: failure(kind) } })],
      ['unrelease', IPC_CHANNELS.UNRELEASE, { jobId: JOB }, kind => ({ controller: { unrelease: failure(kind) } })],
      ['release push', IPC_CHANNELS.RELEASE_PUSH, { hubs: ['a'.repeat(64)] }, kind => ({ push: { release: failure(kind) } })],
      ['unrelease push', IPC_CHANNELS.UNRELEASE_PUSH, { hub: 'a'.repeat(64) }, kind => ({ push: { unrelease: failure(kind) } })],
      ['hold', IPC_CHANNELS.HOLD_JOB, { jobId: JOB, held: true }, kind => ({ engine: { hold: failure(kind) } })],
      ['ack', IPC_CHANNELS.ACK_ALARM, { id: 'alarm-1' }, kind => ({ controller: { ackAlarm: failure(kind) } })],
      ['chat commit', IPC_CHANNELS.NEW_CHAT, undefined, kind => ({ controller: { prepareChat: async () => ({ commitToken: 'token', starter: 'synthetic' }), commitChat: failure(kind) }, clipboard: { writeText() {}, readText: () => '', clear() {} } })],
    ];
    for (const [label, channel, payload, options] of cases) {
      for (const kind of ['missing', 'throw']) {
        const h = setup(options(kind));
        const result = await invoke(h, channel, payload);
        assert(result.success === false && !JSON.stringify(result).includes('secret-from-port-must-not-cross-ipc'), `${label} ${kind} acknowledgement must be a fixed failure`);
      }
    }
    for (const kind of ['missing', 'throw']) {
      const h = setup({ controller: { release: failure(kind) } });
      h.ipc.listeners.get(IPC_CHANNELS.PUBLISH_JOBS)(h.event, { v: 1, seq: 1, jobs: [{ jobId: JOB, canvasFilePath: PATH, dockState: 'awaiting', sig: 'fail-closed' }] });
      const result = await invoke(h, IPC_CHANNELS.RELEASE, { items: [{ jobId: JOB }] });
      assert(result.success === false && !JSON.stringify(result).includes('secret-from-port-must-not-cross-ipc'), `release ${kind} acknowledgement must be a fixed failure`);
    }
  } },
];
