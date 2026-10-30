import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { createChatLauncher } from '../../electron/ipc/handoffBridge/chatLauncher.js';
import { pickUserChromePid } from '../../electron/ipc/browser/appleEvents.js';
import { buildWorkerStarterMessage } from '../../src/utils/handoffBridgeConfig.js';
import { registerHandoffBridgeUi as registerRealHandoffBridgeUi } from '../../electron/ipc/handoffBridge/ui.js';
import { IPC_CHANNELS, IPC_EVENTS } from '../../electron/ipc/handoffBridge/contracts.js';
import { applyHandoffBridgeStatus, getHandoffBridgeStatus, __resetHandoffBridgeStoreForTests } from '../../src/utils/handoffBridgeStore.js';
import { IPC_ERROR_COPY } from '../../src/utils/handoffBridgeCopy.js';
import { clearBridgeChatOpenDiagnostic, getBridgeChatOpenDiagnostic, clearBridgeLaunchDiagnostic, getBridgeLaunchDiagnostic } from '../../electron/ipc/handoffBridge/telemetry.js';
import { isUiRestartContext } from '../../electron/ipc/handoffBridge/restartContext.js';
import { observedChatContext } from '../../electron/ipc/handoffBridge/observedChatContext.js';

// These scheduler fixtures predate the observed-chat transport. Bootstrap the
// controller double with the same begin/confirm/cancel handshake; confirmation
// still requires the opaque observation the real UI minted from a landed id.
// Negative launch outcomes and all existing scheduling assertions stay intact.
let syntheticChatOrdinal = 0;
function registerHandoffBridgeUi(options) {
  const pending = new Set();
  return registerRealHandoffBridgeUi({ ...options, controller: {
    beginObservedChat: async ({ sessionCode }) => {
      assert.match(sessionCode, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{26}$/u);
      pending.add(sessionCode);
      return true;
    },
    confirmObservedChat: async ({ sessionCode, observation }) => {
      const proof = observedChatContext(observation);
      const began = pending.delete(sessionCode);
      return began && proof?.fresh === true;
    },
    cancelObservedChat: async ({ sessionCode }) => { pending.delete(sessionCode); return true; },
    ...options.controller,
  } });
}

function harness(options = {}) {
  const calls = [];
  const states = [];
  let tick = 0;
  let day = 0;
  let chatOrdinal = 0;
  let closeFailures = options.closeFailures ?? 0;
  let modelReads = 0;
  let selectedModel = options.model || 'GPT-6';
  let appleEventsEnabled = options.appleEventsOff !== true;
  let effortPosition = options.effortPosition ?? 3;
  let upsellDismissed = false;
  let activeUrl = 'https://chatgpt.com/';
  let chromeRestarted = false;
  let nativeTabClosed = false;
  let urlReadError = options.urlReadError === true;
  let mode = options.mode || 'work';
  let modeReads = 0;
  let draft = options.draft ?? '';
  let unknownAccount = options.unknownAccount === true;
  const launcher = createChatLauncher({
    now: () => day * 86_400_000 + (tick += 500), delay: async () => {},
    onState: (...values) => { states.push(values); options.onState?.(...values); },
    run: async (script, args) => {
      calls.push({ script, args });
      if (!appleEventsEnabled && script === launcher.scripts.EXEC) throw new Error('JavaScript through AppleScript is turned off');
      if (script === launcher.scripts.OPEN) { chatOrdinal += 1; activeUrl = args[1]; chromeRestarted = false; nativeTabClosed = false; return `100:${199 + chatOrdinal}`; }
      if (script === launcher.scripts.CLOSE_CHAT) return String(options.duplicateTabs ?? 0);
      if (script === launcher.scripts.CLOSE) {
        if (closeFailures > 0) { closeFailures -= 1; throw Object.assign(new Error('Chrome is busy'), { killed: true }); }
        nativeTabClosed = options.closeInvalidatesTab === true; return '';
      }
      if (nativeTabClosed) throw new Error('owned tab was closed');
      if (script === launcher.scripts.FOCUS) return 'focused';
      if (script === launcher.scripts.URL) {
        if (urlReadError) throw new Error('Chrome stopped responding after Send');
        if (chromeRestarted) throw new Error('tab no longer exists');
        if (options.noNavigation) return 'https://chatgpt.com/';
        if (activeUrl === 'https://chatgpt.com/') activeUrl = `https://chatgpt.com/c/unique-chat-${122 + chatOrdinal}`;
        return activeUrl;
      }
      const code = args[2];
      if (code.includes("const controls = [...document.querySelectorAll('button[aria-pressed]')];")) {
        modeReads++;
        return options.modeFlipsBeforeSend && modeReads > 1 ? 'work' : mode;
      }
      if (code.includes("const buttons = [...document.querySelectorAll('button[aria-pressed]')]")) {
        if (options.modeUnavailable) return 'unavailable';
        if (!options.modeStuck) mode = 'chat';
        return 'selected';
      }
      if (code === "'ready'") return 'ready';
      if (code.includes('return JSON.stringify({ready:')) return JSON.stringify({ ready: !options.noEditor, empty: draft === '', draft, attachments: options.staleAttachment ? 1 : 0, url: activeUrl });
      if (code.includes('window.__icBridgeUploads ||= ')) return 'ready';
      if (code.includes('b.push(')) return 'appended';
      if (code.includes('transfer.items.add(new File')) return options.uploadFailed ? 'failed' : 'attached';
      if (code.includes('const expected =')) return JSON.stringify({ complete: true, progress: 0 });
      if (code.includes("return 'cleared'")) return 'cleared';
      if (code.includes("document.execCommand('insertText'")) {
        if (options.insertMismatch) return 'mismatch';
        // ChatGPT keeps an unsent composer draft across new tabs.
        draft = JSON.parse(code.match(/insertText', false, ("(?:[^"\\]|\\.)*")/u)[1]); return 'match';
      }
      if (code.includes('const models =')) { modelReads += 1; return JSON.stringify({ model: selectedModel, topModel: 'GPT-6', topSelected: selectedModel === 'GPT-6', min: 0, max: options.maxPosition ?? 4, now: effortPosition, label: effortPosition === 4 ? 'Pro' : effortPosition === 3 ? 'Extra High' : 'High', sliderReady: modelReads > (options.partialModelReads || 0) && !(options.sliderOnlyForTop && selectedModel !== 'GPT-6'), locked: options.lockedPro === true && effortPosition === 4 }); }
      if (code.includes('const visible =') && !code.includes('const agent =')) return JSON.stringify({ blocked: options.upsellPro === true && effortPosition === 4 && !upsellDismissed });
      if (code.includes('const dialog =')) { upsellDismissed = true; return 'closed'; }
      if (code.includes('const item = [...')) { if (!options.selectionStuck) selectedModel = 'GPT-6'; return 'selected'; }
      if (code.includes('const slider = document.querySelector')) {
        if (!options.stuckEffort && !(options.proUnavailable && effortPosition === 3 && code.includes('ArrowRight'))) effortPosition += code.includes('ArrowRight') ? 1 : -1;
        if (effortPosition === 4) upsellDismissed = false;
        return 'moved';
      }
      if (code.includes("return 'closed'")) return 'closed';
      if (code.includes("!!document.querySelector('[role=\"menu\"]')")) return 'false';
      if (code.includes("!document.querySelector('[role=\"menu\"]')")) return 'true';
      if (code.includes('const signedIn =')) return JSON.stringify({ signedIn: !unknownAccount });
      if (code.includes('const agent =')) return JSON.stringify(options.diagnosisResult
        || { reason: options.diagnosis || 'none', assistantPresent: true });
      if (code.includes("button[aria-label=\"Select ChatGPT model\"]")) return 'opened';
      if (code.includes("button[aria-label=\"Open profile menu\"]")) return 'opened';
      if (code.includes("button[aria-label=\"Send\"]")) { draft = ''; return 'clicked'; }
      if (code.includes('empty:')) return JSON.stringify({ empty: true });
      throw new Error('unexpected fake command');
    },
  });
  return { launcher, calls, states, setDraft: value => { draft = value; }, setUnknownAccount: value => { unknownAccount = value; }, setMode: value => { mode = value; }, navigate: url => { activeUrl = url; }, nextDay: () => { day += 1; }, enableAppleEvents: () => { appleEventsEnabled = true; }, restartChrome: () => { chromeRestarted = true; }, recoverChrome: () => { urlReadError = false; } };
}

const flush = async (turns = 40) => { for (let turn = 0; turn < turns; turn++) await new Promise(resolve => setImmediate(resolve)); };

// A dock with one connected pool worker whose owned tab is diagnosed by a
// controllable fake. `tick(ms)` advances the clock and fires the 15s
// observation timer (or republishes status when none is armed).
function observedWorkerUi({ worker, clock, diagnosis, controller = {}, launchResult }) {
  const calls = [];
  const diagnoses = [];
  const handlers = new Map();
  let observationTimer = null;
  const snapshot = { autoLaunchChats: true, serving: 'live', config: { pluginName: 'Infinite Canvas' },
    chat: { pool: { active: true, generation: 31, workerCount: 1, workers: [worker] } } };
  const ui = registerHandoffBridgeUi({
    ipc: { handle: (key, value) => handlers.set(key, value), removeHandler() {}, on() {}, removeListener() {} },
    now: () => clock.now,
    timers: { setTimeout(fn, ms) { if (ms === 15_000) observationTimer = fn; return { unref() {} }; }, clearTimeout() {} },
    controller: { snapshot: () => snapshot, subscribe: () => () => {},
      restartWorker: async args => {
        calls.push(['restart', { ...args }]);
        worker.firstCallAt = null; worker.lastCallAt = null; worker.state = 'ready'; worker.quietReason = null; worker.restarts++;
        return { copied: true, sessionCode: '3'.repeat(26), workerCount: 1 };
      }, ...controller },
    chatLauncher: { owns: owner => owner === 'worker:31:1',
      diagnose: async owner => { diagnoses.push(owner); return diagnosis(); },
      close: async owner => { calls.push(['close', owner]); return true; },
      launch: async () => {
        calls.push(['launch']);
        if (launchResult) return launchResult;
        worker.firstCallAt = clock.now; worker.lastCallAt = clock.now; worker.state = 'waiting';
        return { ok: true, chatId: `synthetic-launcher-chat-${++syntheticChatOrdinal}` };
      } },
    getCanvasWindows: () => [],
  });
  const launch = async () => (await handlers.get(IPC_CHANNELS.GET_STATUS)({ sender: { __isCanvasRenderer: true } }))
    .status.chat.pool.workers[0].launch || null;
  return { ui, calls, diagnoses, snapshot, launch, armed: () => typeof observationTimer === 'function',
    publish: async () => { ui.publishStatus(snapshot); await flush(); },
    tick: async ms => {
      clock.now += ms;
      const fire = observationTimer;
      observationTimer = null;
      if (fire) fire(); else ui.publishStatus(snapshot);
      await flush();
    } };
}
const noStop = { reason: 'none', assistantPresent: true, responding: false };
const responding = { reason: 'none', assistantPresent: true, responding: true };

const starter = 'private-session-code-do-not-log';
const cases = [
  ['Apple Events JavaScript off', { appleEventsOff: true }, 'apple_events_js_off'],
  ['editor never appears', { noEditor: true }, 'editor_timeout'],
  ['insert mismatch', { insertMismatch: true }, 'insert_mismatch'],
  ['model selection refused', { model: 'GPT-5.6 Sol', selectionStuck: true }, 'model_selection_failed'],
  ['effort control refused', { effortPosition: 2, stuckEffort: true }, 'effort_unavailable'],
  ['account unknown', { unknownAccount: true }, 'account_unknown'],
  ['send did not navigate', { noNavigation: true }, 'send_not_confirmed'],
];

export default [
  { name: 'chat launcher: a stopped launch\'s own starter left in the composer is replaced; a person\'s draft still blocks', async run() {
    const h = harness({ unknownAccount: true });
    assert.equal((await h.launcher.launch({ owner: 'draft', starter })).reason, 'account_unknown');
    h.setUnknownAccount(false);
    const retried = await h.launcher.launch({ owner: 'draft', starter });
    assert.equal(retried.ok, true, 'the retry is not blocked by the starter the first attempt typed');
    const person = harness({ draft: 'my own unsent note' });
    assert.equal((await person.launcher.launch({ owner: 'person', starter })).reason, 'editor_not_empty');
  } },
  { name: 'chat launcher: restart_cap keeps the tab and never launches or retries a replacement', async run() {
    const clock = { now: Date.now() };
    const worker = { ordinal: 1, state: 'waiting', firstCallAt: clock.now - 600_000, lastCallAt: clock.now - 61_000, restarts: 3 };
    const attempts = [];
    const h = observedWorkerUi({ worker, clock, diagnosis: () => ({ reason: 'delivery_timeout', assistantPresent: true, responding: false }),
      controller: { restartWorker: async args => { attempts.push(args); return { copied: false, status: 'restart_cap' }; } } });
    try {
      await h.publish();
      await h.tick(60_000);
      await h.tick(60_000);
      assert.equal(attempts.length, 1, 'the refused replacement is final for this incarnation');
      assert.equal(attempts[0].automatic, true);
      assert.deepEqual(h.calls, [], 'the existing tab stays open and no launch follows');
    } finally { h.ui.dispose(); }
  } },
  { name: 'chat launcher: explicitly selects and verifies Chat before typing and sending', async run() {
    const { launcher, calls } = harness();
    const result = await launcher.launch({ owner: 'mode', starter });
    assert.equal(result.ok, true);
    assert.equal(result.observed.mode, 'chat');
    const codes = calls.map(call => call.args?.[2] || '');
    const select = codes.findIndex(code => code.includes('const buttons ='));
    const insert = codes.findIndex(code => code.includes("document.execCommand('insertText'"));
    assert.ok(select >= 0 && select < insert);
    const read = codes.find(code => code.includes('const controls ='));
    const choose = codes[select];
    const dom = new JSDOM('<button aria-pressed="false">Chat</button><button aria-pressed="true"><span>Work</span></button><form><div contenteditable="true" role="textbox" aria-label="Work with ChatGPT"></div></form>');
    const document = dom.window.document;
    assert.equal(runInNewContext(read, { document }), 'work');
    document.querySelector('button').onclick = () => {
      document.querySelectorAll('button')[0].setAttribute('aria-pressed', 'true');
      document.querySelectorAll('button')[1].setAttribute('aria-pressed', 'false');
      document.querySelector('[role="textbox"]').setAttribute('aria-label', 'Ask ChatGPT');
    };
    assert.equal(runInNewContext(choose, { document }), 'selected');
    assert.equal(runInNewContext(read, { document }), 'chat');
    document.querySelectorAll('button').forEach(button => button.remove());
    assert.equal(runInNewContext(read, { document }), 'chat', 'existing Chat composer is recognized without a switcher');
    document.querySelector('[role="textbox"]').setAttribute('aria-label', 'Work with ChatGPT');
    assert.equal(runInNewContext(read, { document }), 'work');
    dom.window.close();
  } },
  { name: 'chat launcher: unavailable, stuck, changed and existing Work modes never send', async run() {
    for (const options of [{ modeUnavailable: true }, { modeStuck: true }, { modeFlipsBeforeSend: true }]) {
      const { launcher, calls } = harness(options);
      assert.equal((await launcher.launch({ owner: 'mode', starter })).ok, false);
      assert.equal(calls.some(call => call.args?.[2]?.includes('button[aria-label="Send"]')), false);
    }
    const { launcher, calls, setMode } = harness();
    assert.equal((await launcher.launch({ owner: 'existing-mode', starter })).ok, true);
    setMode('work');
    calls.length = 0;
    const continued = await launcher.launch({ owner: 'existing-mode', starter, continueChat: true });
    assert.equal(continued.reason, 'chat_mode_mismatch');
    assert.equal(calls.some(call => call.args?.[2]?.includes("document.execCommand('insertText'")), false);
  } },
  { name: 'chat launcher: opening an expanded model picker does not toggle it closed', async run() {
    const { launcher, calls } = harness();
    await launcher.launch({ owner: 'expanded-menu', starter });
    const script = calls.find(call => call.args?.[2]?.includes('button[aria-label="Select ChatGPT model"]')).args[2];
    let clicks = 0;
    const button = { getAttribute: () => 'true', dispatchEvent: () => { clicks++; } };
    assert.equal(runInNewContext(script, { document: { querySelector: () => button } }), 'opened');
    assert.equal(clicks, 0);
  } },
  { name: 'chat launcher: a model slider that never mounts cannot send a worker starter', async run() {
    const { launcher, calls } = harness({ partialModelReads: Infinity });
    assert.equal((await launcher.launch({ owner: 'missing-slider', starter })).ok, false);
    assert.equal(calls.some(call => call.args?.[2]?.includes('button[aria-label="Send"]')), false);
  } },
  { name: 'chat launcher: waits for the selected model slider to finish mounting', async run() {
    const { launcher, calls } = harness({ partialModelReads: 4 });
    assert.equal((await launcher.launch({ owner: 'delayed-menu', starter })).ok, true);
    const scripts = calls.map(call => call.args?.[2] || '');
    assert.equal(scripts.filter(code => code.includes('button[aria-label="Select ChatGPT model"]')).length, 1,
      'a partially mounted picker must settle without another toggle closing it');
  } },
  { name: 'chat launcher: selects the latest model before requiring its effort slider', async run() {
    const { launcher } = harness({ model: 'Earlier model', sliderOnlyForTop: true });
    const result = await launcher.launch({ owner: 'switch-model', starter });
    assert.equal(result.ok, true);
    assert.equal(result.observed.model, 'GPT-6');
    assert.equal(result.observed.effort, 'Extra High');
  } },
  { name: 'chat launcher: stale Open recovery cannot launch after connection, pool replacement or window removal', async run() {
    for (const change of ['connected', 'pool', 'window']) {
      let resolveReveal; const reveal = new Promise(resolve => { resolveReveal = resolve; });
      const handlers = new Map(); const sender = { id: 814, __isCanvasRenderer: true };
      const window = { webContents: sender, isDestroyed: () => false }; let present = true;
      const worker = { ordinal: 1, state: 'available', firstCallAt: null };
      const snapshot = { serving: 'live', autoLaunchChats: true, chat: { pool: { active: true, generation: 63, workerCount: 1, workers: [worker] } } };
      let launches = 0;
      const ui = registerHandoffBridgeUi({
        ipc: { handle: (key, value) => handlers.set(key, value), removeHandler() {}, on() {}, removeListener() {} },
        controller: { snapshot: () => snapshot, subscribe: () => () => {}, copyWorkerStarter: async () => { launches++; return null; } },
        chatLauncher: { reveal: async () => reveal, owns: () => false, close: async () => { launches++; } },
        getCanvasWindows: () => present ? [window] : [],
      });
      try {
        const opening = handlers.get(IPC_CHANNELS.OPEN_WORKER_CHAT)({ sender }, { generation: 63, workerOrdinal: 1 });
        await new Promise(resolve => setImmediate(resolve));
        if (change === 'connected') { worker.state = 'working'; worker.firstCallAt = Date.now(); }
        else if (change === 'pool') snapshot.chat.pool.generation = 64;
        else present = false;
        resolveReveal({ ok: false, reason: 'tab_not_owned' });
        const result = await opening;
        assert.equal(result.code, change === 'connected' ? 'WORKER_CHAT_UNAVAILABLE' : change === 'pool' ? 'WORKER_CHAT_ENDED' : 'NO_WINDOW');
        assert.equal(launches, 0, 'stale recovery cannot close or rekey another live chat');
      } finally { ui.dispose(); }
    }
  } },
  { name: 'chat launcher: explicit Retry preserves a worker that connects before its queued launch starts', async run() {
    const handlers = new Map(); const sender = { id: 815, __isCanvasRenderer: true };
    const window = { webContents: sender, isDestroyed: () => false };
    const worker = { ordinal: 1, state: 'available', firstCallAt: null };
    const snapshot = { serving: 'live', autoLaunchChats: true, config: {}, chat: { pool: { active: true, generation: 65, workerCount: 1, workers: [worker] } } };
    let launches = 0; let closes = 0;
    const ui = registerHandoffBridgeUi({
      ipc: { handle: (key, value) => handlers.set(key, value), removeHandler() {}, on() {}, removeListener() {} },
      controller: { snapshot: () => snapshot, subscribe: () => () => {},
        copyWorkerStarter: async () => ({ copied: true, sessionCode: '2'.repeat(26), workerCount: 1 }), abandonWorkerStarter: async () => true },
      chatLauncher: { owns: () => true, close: async () => { closes++; },
        launch: async () => { launches++; return { ok: false, reason: 'chrome_timeout' }; } },
      timers: { setTimeout() { return { unref() {} }; }, clearTimeout() {} }, getCanvasWindows: () => [window],
    });
    try {
      ui.publishStatus(snapshot);
      for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setImmediate(resolve));
      const retry = handlers.get(IPC_CHANNELS.RETRY_WORKER_LAUNCH)({ sender }, { generation: 65, workerOrdinal: 1 });
      worker.state = 'working'; worker.firstCallAt = Date.now();
      await retry;
      for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setImmediate(resolve));
      assert.equal(launches, 1); assert.equal(closes, 0);
    } finally { ui.dispose(); }
  } },
  { name: 'chat launcher: published status marks exactly the workers whose Chrome tab the app owns as openable', async run() {
    const handlers = new Map(); const published = [];
    const sender = { id: 816, __isCanvasRenderer: true, send: (channel, payload) => { if (channel === IPC_EVENTS.STATUS) published.push(payload); } };
    const window = { webContents: sender, isDestroyed: () => false };
    const snapshot = { serving: 'live', autoLaunchChats: false, config: {}, chat: { pool: { active: true, generation: 66, workerCount: 2, workers: [
      { ordinal: 1, state: 'working', firstCallAt: Date.now(), completed: 3 },
      { ordinal: 2, state: 'waiting', firstCallAt: Date.now(), completed: 1 },
    ] } } };
    const owned = [];
    const ui = registerHandoffBridgeUi({
      ipc: { handle: (key, value) => handlers.set(key, value), removeHandler() {}, on() {}, removeListener() {} },
      controller: { snapshot: () => snapshot, subscribe: () => () => {} },
      chatLauncher: { owns: owner => { owned.push(owner); return owner === 'worker:66:1'; }, close: async () => true,
        launch: async () => { throw new Error('a healthy pool must not launch'); } },
      timers: { setTimeout() { return { unref() {} }; }, clearTimeout() {} }, getCanvasWindows: () => [window],
    });
    try {
      ui.publishStatus(snapshot);
      for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setImmediate(resolve));
      assert(published.length >= 1, 'the status reaches the canvas renderer');
      const workers = published.at(-1).chat.pool.workers;
      assert.equal(workers.length, 2);
      assert.equal(workers[0].ordinal, 1); assert.equal(workers[0].canOpenChat, true);
      assert.equal(workers[1].ordinal, 2); assert.equal(workers[1].canOpenChat, false);
      assert.equal(workers[0].launch, null, 'worker 1 has no launch progress yet is still openable');
      assert.equal(workers[1].launch, null);
      assert(owned.includes('worker:66:1') && owned.includes('worker:66:2'), 'ownership is asked per exact worker owner');
    } finally { ui.dispose(); }
  } },
  { name: 'chat launcher: Open preserves the original tab when Send landed but confirmation failed', async run() {
    const h = harness({ urlReadError: true });
    const result = await h.launcher.launch({ owner: 'worker:1:1', starter });
    assert.equal(result.sendAttempted, true);
    assert.equal(result.ok, false);
    h.recoverChrome(); h.navigate('https://chatgpt.com/c/unconfirmed-worker-chat');
    assert.equal((await h.launcher.reveal('worker:1:1')).ok, true);
    assert.equal(h.calls.filter(call => call.script === h.launcher.scripts.OPEN).length, 1, 'Open keeps the existing sent tab');
    assert.equal(h.calls.filter(call => call.args?.[2]?.includes('button[aria-label="Send"]')).length, 1, 'Open never repeats Send');
  } },
  { name: 'chat launcher: Open recovers a missing unstarted worker once and never replaces an answered chat', async run() {
    const handlers = new Map(); const sender = { id: 813, __isCanvasRenderer: true };
    const window = { webContents: sender, isDestroyed: () => false };
    const worker = { ordinal: 1, state: 'available', firstCallAt: null, completed: 4, restarts: 4 };
    const snapshot = { serving: 'live', autoLaunchChats: true, config: { pluginName: 'Infinite Canvas' },
      chat: { pool: { active: true, generation: 62, workerCount: 1, workers: [worker] } } };
    let launches = 0; let starters = 0; let owns = false;
    const ui = registerHandoffBridgeUi({
      ipc: { handle: (key, value) => handlers.set(key, value), removeHandler() {}, on() {}, removeListener() {} },
      controller: { snapshot: () => snapshot, subscribe: () => () => {},
        copyWorkerStarter: async () => { starters++; return { copied: true, sessionCode: '2'.repeat(26), workerCount: 1 }; },
        restartWorker: async () => { throw new Error('must not replace credentials'); } },
      chatLauncher: { owns: () => owns, reveal: async () => ({ ok: false, reason: 'tab_not_owned' }), close: async () => true,
        launch: async () => { launches++; owns = true; worker.firstCallAt = Date.now(); worker.state = 'working'; return { ok: true, chatId: `synthetic-launcher-chat-${++syntheticChatOrdinal}` }; } },
      getCanvasWindows: () => [window], launchPresentationTimeoutMs: 8,
    });
    try {
      const open = () => handlers.get(IPC_CHANNELS.OPEN_WORKER_CHAT)({ sender }, { generation: 62, workerOrdinal: 1 });
      const results = await Promise.all([open(), open()]);
      assert(results.every(result => result.success && result.started), 'stale Open presses start recovery instead of returning a retry loop');
      for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve));
      assert.equal(launches, 1); assert.equal(starters, 1);
      owns = false;
      assert.equal((await open()).code, 'WORKER_CHAT_UNAVAILABLE');
      assert.equal(starters, 1, 'Open never resets a connected worker’s capability');
    } finally { ui.dispose(); }
  } },
  { name: 'chat launcher: replacement launch survives status callbacks carrying the previous session_full result', async run() {
    let ui;
    const worker = { ordinal: 1, state: 'available', lastOutcome: 'session_full', firstCallAt: null, completed: 4, restarts: 4 };
    const snapshot = { serving: 'live', autoLaunchChats: true, config: { pluginName: 'Infinite Canvas' },
      chat: { pool: { active: true, generation: 61, workerCount: 1, workers: [worker] } } };
    const h = harness({ closeInvalidatesTab: true, onState(_owner, stage) {
      if (stage === 'sent') { worker.firstCallAt = Date.now(); worker.state = 'working'; worker.lastOutcome = 'served'; }
      ui?.publishStatus(snapshot);
    } });
    ui = registerHandoffBridgeUi({
      ipc: { handle() {}, removeHandler() {}, on() {}, removeListener() {} },
      controller: { snapshot: () => snapshot, subscribe: () => () => {},
        copyWorkerStarter: async () => ({ copied: true, sessionCode: '2'.repeat(26), workerCount: 1 }),
        abandonWorkerStarter: async () => true },
      chatLauncher: h.launcher, getCanvasWindows: () => [], launchPresentationTimeoutMs: 8,
      timers: { setTimeout() { return { unref() {} }; }, clearTimeout() {} },
    });
    try {
      ui.publishStatus(snapshot);
      for (let turn = 0; turn < 40; turn++) await new Promise(resolve => setImmediate(resolve));
      assert.equal(h.calls.filter(call => call.script === h.launcher.scripts.CLOSE).length, 0, 'a prior incarnation result must never close the new tab');
      assert.equal(h.states.at(-1)?.[1], 'sent');
      assert.equal(h.launcher.owns('worker:61:1'), true);
      assert.equal((await h.launcher.reveal('worker:61:1')).ok, true);
    } finally { ui.dispose(); }
  } },
  ...cases.map(([name, options, reason]) => ({ name: `chat launcher: ${name}`, async run() {
    const { launcher, states } = harness(options);
    const result = await launcher.launch({ owner: 'worker:1:1', starter });
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
    assert.equal(states.at(-1)[1], 'failed');
    assert(!JSON.stringify(states).includes(starter));
  } })),
  { name: 'chat launcher: JavaScript readiness can recover on its existing owned tab', async run() {
    const h = harness({ appleEventsOff: true });
    assert.equal((await h.launcher.launch({ owner: 'worker:1:1', starter })).reason, 'apple_events_js_off');
    assert.equal(await h.launcher.javascriptReady('worker:1:1'), false);
    h.enableAppleEvents();
    assert.equal(await h.launcher.javascriptReady('worker:1:1'), true);
    await h.launcher.close('worker:1:1');
  } },
  { name: 'chat launcher: success and owned tab cleanup', async run() {
    const { launcher, calls, states } = harness();
    assert(launcher.scripts.OPEN.includes('const chrome = Application(Number(argv[0]));'), 'scripts address the person\'s Chrome by process id');
    assert(launcher.scripts.OPEN.includes('t = w.activeTab;') && launcher.scripts.OPEN.includes('t.url = targetUrl;'));
    const result = await launcher.launch({ owner: 'worker:1:1', starter });
    assert.equal(result.ok, true);
    assert.equal(result.chatId, 'unique-chat-123');
    assert.equal(states.at(-1)[1], 'sent');
    assert.equal(launcher.owns('worker:1:1'), true);
    assert.equal(await launcher.close('worker:1:1'), true);
    assert.equal(launcher.owns('worker:1:1'), false);
    assert(calls.some(item => item.script === launcher.scripts.CLOSE));
    await launcher.launch({ owner: 'worker:1:2', starter });
    assert.deepEqual(calls.filter(item => item.script === launcher.scripts.OPEN).map(item => item.args[0]), ['0', '0']);
    await launcher.closeAll();
    assert.equal(launcher.owns('worker:1:2'), false);
    assert.equal(calls.filter(item => item.script === launcher.scripts.CLOSE).length, 2);
    assert(calls.some(item => item.args?.[2]?.includes('[data-model-picker-power-slider] [role="slider"]')));
    assert(calls.some(item => item.args?.[2]?.includes('[data-model-picker-power-slider]')));
    assert(!JSON.stringify(states).includes(starter));
  } },
  { name: 'chat launcher: Open is independent of setup and reports specific reveal failures', async run() {
    const handlers = new Map();
    const sender = { id: 83, __isCanvasRenderer: true };
    const window = { webContents: sender, isDestroyed: () => false };
    const snapshot = { serving: 'off', autoLaunchChats: false, config: { telemetryInBugReports: true }, setup: { linked: false },
      chat: { pool: { active: true, generation: 3, workers: [{ ordinal: 1, state: 'ready' }] } } };
    let result = { ok: true, outcome: 'focused' };
    let calls = 0;
    const ui = registerHandoffBridgeUi({
      ipc: { handle: (key, value) => handlers.set(key, value), removeHandler() {}, on() {}, removeListener() {} },
      controller: { snapshot: () => snapshot, subscribe: () => () => {} },
      chatLauncher: { reveal: async owner => { assert.equal(owner, 'worker:3:1'); calls++; return result; }, owns: () => true, close: async () => true },
      getCanvasWindows: () => [window],
    });
    clearBridgeChatOpenDiagnostic();
    try {
      const open = () => handlers.get(IPC_CHANNELS.OPEN_WORKER_CHAT)({ sender }, { generation: 3, workerOrdinal: 1 });
      assert.equal((await open()).success, true, 'revealing an existing chat does not require setup, linking or a running tunnel');
      result = { ok: false, reason: 'activation_failed' };
      const failed = await open();
      assert.equal(failed.code, 'WORKER_CHAT_OPEN_FAILED');
      assert(!IPC_ERROR_COPY[failed.code].includes('setup'));
      result = { ok: false, reason: 'tab_not_owned' };
      assert.equal((await open()).code, 'WORKER_CHAT_UNAVAILABLE');
      snapshot.chat.pool.active = false;
      assert.equal((await open()).code, 'WORKER_CHAT_ENDED');
      assert.equal(calls, 3, 'a stale worker cannot reveal an unrelated chat');
      assert.deepEqual(getBridgeChatOpenDiagnostic().map(row => row.reason), [null, 'activation_failed', 'tab_not_owned', 'worker_ended']);
    } finally { ui.dispose(); clearBridgeChatOpenDiagnostic(); }
  } },
  { name: 'chat launcher: native opening script reuses regular Chrome windows and preserves the selected tab', run() {
    const { launcher } = harness();
    for (const fixture of [
      { modes: ['normal'], remembered: '0', expected: '100', created: false },
      { modes: ['normal'], remembered: '999', expected: '100', created: false },
      { modes: ['incognito', 'normal'], remembered: '0', expected: '101', created: false },
      { modes: ['normal', 'normal'], remembered: '101', expected: '101', created: false },
      { modes: ['incognito', 'normal'], remembered: '100', expected: '101', created: false },
      { modes: [], remembered: '0', expected: '900', created: true },
      { modes: ['incognito'], remembered: '0', expected: '900', created: true },
    ]) {
      let created = 0; let restored = 0;
      const makeWindow = (id, mode) => {
        let selected = 1;
        const w = { id: () => id, mode: () => mode, tabs: [{ id: () => '200' }], activeTab: { id: () => '201' } };
        Object.defineProperty(w, 'activeTabIndex', { get: () => () => selected, set: value => { selected = value; } });
        return w;
      };
      const all = fixture.modes.map((mode, i) => makeWindow(String(100 + i), mode));
      const windows = () => all;
      Object.defineProperty(windows, 'length', { value: all.length });
      for (let i = 0; i < all.length; i++) windows[i] = all[i];
      windows.byId = id => { const w = all.find(w => w.id() === String(id)); if (!w) throw new Error('closed'); return w; };
      const chrome = { windows, Tab: ({ url }) => ({ id: () => '201', url }), Window: () => ({ make: () => { created++; return makeWindow('900', 'normal'); } }) };
      const run = runInNewContext(`${launcher.scripts.OPEN}; run`, { Application: () => chrome, ObjC: { import() {} },
        $: { NSWorkspace: { sharedWorkspace: { frontmostApplication: { activateWithOptions: () => { restored++; } } } } } });
      assert.equal(run(['777', fixture.remembered, 'https://chatgpt.com/']), `${fixture.expected}:201`);
      assert.equal(created, fixture.created ? 1 : 0);
      assert.equal(restored, 1);
      for (const w of all) assert.equal(w.activeTabIndex(), 1, 'automatic startup does not steal the selected tab');
    }
  } },
  { name: 'chat launcher: native foreground script accepts Chrome text IDs and restores the exact minimized window', run() {
    const { launcher } = harness();
    for (const tabId of ['200', 200]) {
      const changes = [];
      const w = { tabs: () => [{ id: () => '199' }, { id: () => tabId }],
        set minimized(value) { changes.push(['minimized', value]); },
        set visible(value) { changes.push(['visible', value]); },
        set activeTabIndex(value) { changes.push(['tab', value]); },
        set index(value) { changes.push(['index', value]); } };
      const chrome = { windows: { byId: id => { assert.equal(id, 100); return w; } }, activate: () => changes.push(['activate']) };
      const run = runInNewContext(`${launcher.scripts.FOCUS}; run`, { Application: () => chrome });
      assert.equal(run(['777', '100', '200']), 'focused');
      assert.deepEqual(changes, [['minimized', false], ['visible', true], ['tab', 2], ['index', 1], ['activate']]);
      changes.length = 0;
      assert.equal(run(['777', '100', '999']), 'missing');
      assert.deepEqual(changes, [], 'missing target must not activate an unrelated tab');
    }
  } },
  { name: 'chat launcher: focus reveals only the exact owned worker chat', async run() {
    const h = harness();
    await h.launcher.launch({ owner: 'worker:1:1', starter });
    assert.equal(await h.launcher.focus('worker:1:2'), false);
    assert.equal(await h.launcher.focus('worker:1:1'), true);
    assert.equal(h.calls.filter(call => call.script === h.launcher.scripts.FOCUS).length, 1);
    h.navigate('https://chatgpt.com/c/unrelated-chat');
    assert.equal(await h.launcher.focus('worker:1:1'), true);
    assert.equal(h.calls.filter(call => call.script === h.launcher.scripts.FOCUS).length, 2);
    assert(h.calls.some(call => call.script === h.launcher.scripts.OPEN && call.args[1] === 'https://chatgpt.com/c/unique-chat-123'));
    assert.equal(h.calls.filter(call => call.args?.[2]?.includes('button[aria-label="Send"]')).length, 1, 'Open never sends another starter');
  } },
  { name: 'chat launcher: Open restores the exact conversation after Chrome closes without sending again', async run() {
    const h = harness();
    const launched = await h.launcher.launch({ owner: 'worker:1:1', starter });
    h.restartChrome();
    assert.equal(await h.launcher.focus('worker:1:1'), true);
    assert(h.calls.some(call => call.script === h.launcher.scripts.OPEN && call.args[1] === `https://chatgpt.com/c/${launched.chatId}`));
    assert.equal(h.calls.filter(call => call.args?.[2]?.includes('button[aria-label="Send"]')).length, 1);
  } },
  { name: 'chat launcher: Open can reveal the owned unsent tab after a model-menu failure', async run() {
    const h = harness({ effortPosition: 2, stuckEffort: true, noNavigation: true });
    assert.equal((await h.launcher.launch({ owner: 'worker:1:1', starter })).ok, false);
    assert.equal(await h.launcher.focus('worker:1:1'), true);
    assert.equal(h.calls.filter(call => call.script === h.launcher.scripts.OPEN).length, 1);
  } },
  { name: 'chat launcher: continue reopens its recorded chat after Chrome restarts', async run() {
    const h = harness();
    const first = await h.launcher.launch({ owner: 'chat:1', starter });
    assert.equal(first.ok, true);
    h.restartChrome();
    assert.equal(h.launcher.owns('chat:1'), true);
    const continued = await h.launcher.launch({ owner: 'chat:1', starter: 'continue-message', continueChat: true });
    assert.equal(continued.ok, true);
    assert.equal(continued.chatId, first.chatId);
    assert.equal(h.calls.filter(item => item.script === h.launcher.scripts.OPEN).at(-1).args[1], `https://chatgpt.com/c/${first.chatId}`);
    await h.launcher.close('chat:1');
    assert.equal(h.launcher.owns('chat:1'), false);
    assert.equal((await h.launcher.launch({ owner: 'chat:1', starter, continueChat: true })).reason, 'tab_not_owned');
  } },
  { name: 'chat launcher: top model and highest non-Pro effort are selected positionally', async run() {
    const { launcher } = harness({ model: 'GPT-5.6 Sol', effortPosition: 1 });
    const result = await launcher.launch({ owner: 'worker:1:1', starter });
    assert.equal(result.ok, true);
    assert.equal(result.observed.model, 'GPT-6');
    assert.equal(result.observed.effortPosition, 3);
  } },
  { name: 'chat launcher: a shorter effort control uses its rightmost position', async run() {
    const { launcher } = harness({ effortPosition: 2, maxPosition: 3 });
    const result = await launcher.launch({ owner: 'worker:1:1', starter });
    assert.equal(result.ok, true);
    assert.equal(result.observed.effortPosition, 3);
  } },
  { name: 'chat launcher: application workers always use Extra High, including when Pro is available', async run() {
    for (const options of [{}, { effortPosition: 4 }, { proUnavailable: true }, { lockedPro: true }, { upsellPro: true }]) {
      const h = harness(options);
      const result = await h.launcher.launch({ owner: 'worker:1:1', starter, application: true });
      assert.equal(result.ok, true);
      assert.equal(result.observed.effortPosition, 3);
      assert.equal(result.observed.effort, 'Extra High');
      assert.equal(result.observed.fallback, false);
      assert(!h.calls.some(item => item.args?.[2]?.includes("key:'ArrowRight'")), 'never attempt the Pro position');
    }
  } },
  { name: 'chat launcher: attachments are chunked and bound to one handoff before Send', async run() {
    const h = harness();
    const result = await h.launcher.launch({ owner: 'worker:1:1', starter,
      attachmentHandoffCode: 'HANDOFF-234567',
      attachments: [{ name: 'photo.png', mime: 'image/png', bytes: new Uint8Array(150_000).fill(7) }],
    });
    assert.equal(result.ok, true);
    const appendCalls = h.calls.filter(item => item.args?.[2]?.includes('b.push('));
    assert(appendCalls.length >= 3);
    assert(appendCalls.every(item => item.args[2].length < 70_000));
    assert(h.calls.some(item => item.args?.[2]?.includes('The files attached to this chat belong only to handoff HANDOFF-234567')));
    assert(h.calls.findIndex(item => item.args?.[2]?.includes('const expected ='))
      < h.calls.findIndex(item => item.args?.[2]?.includes('button[aria-label="Send"]')));
  } },
  { name: 'chat launcher: ChatGPT filename collision suffix still confirms the completed upload', async run() {
    const h = harness();
    assert.equal((await h.launcher.launch({ owner: 'worker:1:1', starter,
      attachmentHandoffCode: 'HANDOFF-234567',
      attachments: [{ name: 'source-0001.pdf', mime: 'application/pdf', bytes: new Uint8Array([1]) }],
    })).ok, true);
    const script = h.calls.find(item => item.args?.[2]?.includes('const expected ='))?.args[2];
    assert(script);
    const state = displayName => JSON.parse(runInNewContext(script, { document: { querySelectorAll(selector) {
      return selector.includes('aria-label^="Remove "')
        ? [{ getAttribute: () => `Remove ${displayName}` }] : [];
    } } }));
    assert.equal(state('source-0001.pdf').complete, true);
    assert.equal(state('source-0001(1).pdf').complete, true);
    assert.equal(state('different.pdf').complete, false);
  } },
  { name: 'chat launcher: a ChatGPT "Connect <plugin>" consent dialog reads as reconnect_required', async run() {
    const h = harness();
    assert.equal((await h.launcher.launch({ owner: 'worker:1:1', starter })).ok, true);
    // Evaluate the launcher's exact in-page diagnosis code against a fake DOM.
    await h.launcher.diagnose('worker:1:1', 'Infinite Canvas');
    const script = h.calls.at(-1)?.args?.[2];
    assert(script && script.includes('[role="dialog"]'), 'diagnosis inspects visible dialogs');
    const page = dialogText => JSON.parse(runInNewContext(script, { document: { querySelectorAll(selector) {
      if (selector === '[role="dialog"]') return dialogText ? [{ innerText: dialogText, offsetWidth: 400, offsetHeight: 300, getClientRects: () => [1] }] : [];
      return [];
    } } }));
    // Text captured from the live tab on 2026-10-14.
    assert.equal(page('Connect Infinite Canvas\nPermissions always respected\nChatGPT is strictly limited to permissions you\'ve explicitly set.\nConnectors may introduce risk').reason, 'reconnect_required');
    assert.equal(page('Reconnect Infinite Canvas\nYour Infinite Canvas connection has expired.').reason, 'reconnect_required');
    assert.equal(page('Connect Google Drive\nPermissions always respected').reason, 'none', 'another app\'s consent dialog is not ours');
    assert.equal(page(null).reason, 'none');
  } },
  { name: 'chat launcher: inline tool approval is detected without clicking or reading payload data', async run() {
    const h = harness();
    await h.launcher.launch({ owner: 'worker:1:1', starter });
    await h.launcher.diagnose('worker:1:1', 'infinite_canvas');
    const script = h.calls.at(-1).args[2];
    const visible = { offsetWidth: 100, getClientRects: () => [1] };
    const page = (heading, labels, hidden = false) => JSON.parse(runInNewContext(script, { document: { querySelectorAll(selector) {
      if (selector !== 'form') return [];
      return [{ ...visible, ...(hidden ? { offsetWidth: 0, getClientRects: () => [] } : {}), parentElement: { innerText: heading },
        querySelectorAll: () => labels.map(innerText => ({ ...visible, innerText })) }];
    } } }));
    assert.equal(page('Infinite Canvas\nAllow ChatGPT to use Infinite Canvas?', ['DenyEsc', 'Allow once⏎']).reason, 'approval_required');
    assert.equal(page('Allow ChatGPT to use Other App?', ['Deny', 'Allow once']).reason, 'none');
    assert.equal(page('Allow ChatGPT to use Infinite Canvas?', ['Deny', 'Allow once'], true).reason, 'none');
    assert.equal(page('Career text mentioning approval', ['Deny', 'Allow once']).reason, 'none');
  } },
  { name: 'chat launcher: visible ChatGPT delivery failures are distinct from a still-generating answer or quoted text', async run() {
    const h = harness();
    await h.launcher.launch({ owner: 'worker:1:1', starter });
    await h.launcher.diagnose('worker:1:1');
    const script = h.calls.at(-1).args[2];
    const element = (innerText, visible = true) => ({ innerText, offsetWidth: visible ? 100 : 0,
      getClientRects: () => visible ? [1] : [], getAttribute: () => null });
    const page = ({ error = '', hidden = false, stop = false, conversation = false, prose = '' } = {}) => JSON.parse(runInNewContext(script, { document: {
      querySelectorAll(selector) {
        if (selector === '[data-chatgpt-agent-turn-start]') return conversation ? [] : [{ parentElement: { innerText: prose } }];
        if (selector === 'main [role="alert"]') return error ? [element(error, !hidden)] : [];
        if (selector === 'main button') return [...(stop ? [element('Stop')] : []), ...(conversation ? [element('Try again')] : [])];
        return [];
      },
      querySelector: () => element(conversation ? 'Could not load this ChatGPT conversation' : prose),
    } }));
    assert.equal(page({ error: 'Message delivery timed out. Please try again.' }).reason, 'delivery_timeout');
    assert.equal(page({ error: 'Message delivery timed out. Please try again.\nRetry' }).reason, 'delivery_timeout');
    assert.equal(page({ conversation: true }).reason, 'conversation_unavailable');
    assert.equal(page({ error: 'Message delivery timed out. Please try again.', stop: true }).reason, 'none');
    assert.deepEqual(page({ error: 'Message delivery timed out. Please try again.', stop: true }).responding, true);
    assert.deepEqual(page({ stop: true }), { reason: 'none', assistantPresent: true, responding: true });
    assert.deepEqual(page({}), { reason: 'none', assistantPresent: true, responding: false }, 'an absent Stop control is reported without asserting a failure');
    assert.equal(page({ error: 'Message delivery timed out. Please try again.\nRetry' }).responding, false);
    assert.equal(page({ conversation: true }).responding, false);
    assert.equal(page({ error: 'Message delivery timed out. Please try again.', hidden: true }).reason, 'none');
    assert.equal(page({ prose: 'Message delivery timed out. Please try again.' }).reason, 'none');
    assert.equal(page({ error: 'An unrelated alert' }).reason, 'none');
  } },
  { name: 'chat launcher: diagnosis never inspects a worker tab navigated to another chat', async run() {
    const h = harness();
    await h.launcher.launch({ owner: 'worker:1:1', starter });
    h.navigate('https://chatgpt.com/c/unrelated-chat');
    const before = h.calls.length;
    assert.equal((await h.launcher.diagnose('worker:1:1')).reason, 'chat_changed');
    assert.equal(h.calls.length - before, 1, 'only the URL is checked; unrelated page content is never read');
  } },
  { name: 'chat launcher: connected delivery failures recover only their quiet owner and ignore stale diagnosis', async run() {
    for (const reason of ['delivery_timeout', 'conversation_unavailable']) {
      for (const stale of [false, true]) {
        let completeDiagnosis;
        const diagnosis = new Promise(resolve => { completeDiagnosis = resolve; });
        const calls = [];
        const worker = { ordinal: 1, state: 'quiet', quietReason: 'answer_silent', firstCallAt: 1, lastCallAt: 1, restarts: 0 };
        const snapshot = { autoLaunchChats: true, serving: 'live', config: { pluginName: 'Infinite Canvas' },
          chat: { pool: { active: true, generation: 21, workerCount: 2, workers: [worker,
            { ordinal: 2, state: 'working', firstCallAt: 2, lastCallAt: 2 }] } } };
        const ui = registerHandoffBridgeUi({
          ipc: { handle() {}, removeHandler() {}, on() {}, removeListener() {} },
          controller: { snapshot: () => snapshot, subscribe: () => () => {},
            restartWorker: async args => {
              calls.push(['restart', args.workerOrdinal]);
              worker.firstCallAt = null; worker.lastCallAt = null; worker.state = 'ready'; worker.restarts++;
              return { copied: true, sessionCode: '3'.repeat(26), workerCount: 2 };
            } },
          chatLauncher: { owns: owner => owner === 'worker:21:1', diagnose: () => diagnosis,
            close: async owner => { calls.push(['close', owner]); return true; },
            launch: async () => {
              calls.push(['launch', 1]); worker.firstCallAt = Date.now(); worker.state = 'working';
              return { ok: true, chatId: `synthetic-launcher-chat-${++syntheticChatOrdinal}` };
            } },
          getCanvasWindows: () => [],
        });
        try {
          ui.publishStatus(snapshot);
          await new Promise(resolve => setImmediate(resolve));
          if (stale) { worker.lastCallAt = 3; worker.state = 'working'; }
          completeDiagnosis({ reason });
          for (let turn = 0; turn < 8; turn++) await new Promise(resolve => setImmediate(resolve));
          assert.deepEqual(calls, stale ? [] : [['restart', 1], ['close', 'worker:21:1'], ['launch', 1]]);
        } finally { ui.dispose(); }
      }
    }
  } },
  { name: 'chat launcher: connected consent waits preserve the chat and clear after approval disappears', async run() {
    let tick = 20_000;
    let diagnosis = 'approval_required';
    let checks = 0;
    let closes = 0;
    let diagnosisTick;
    let diagnosisTimerCleared = false;
    const snapshot = { serving: 'live', autoLaunchChats: true, config: { pluginName: 'infinite_canvas' },
      chat: { pool: { active: true, generation: 41, workers: [{ ordinal: 1, state: 'quiet', quietReason: 'answer_silent', firstCallAt: 1 }] } } };
    const handlers = new Map();
    const sender = { id: 81, __isCanvasRenderer: true };
    const window = { webContents: sender, isDestroyed: () => false };
    const focused = [];
    const ui = registerHandoffBridgeUi({
      ipc: { handle: (key, value) => handlers.set(key, value), removeHandler() {}, on() {}, removeListener() {} },
      controller: { snapshot: () => snapshot, subscribe: listener => { listener(snapshot); return () => {}; } }, now: () => tick,
      timers: { setTimeout(fn, ms) { if (ms === 15_000) diagnosisTick = fn; return { unref() {} }; }, clearTimeout() { diagnosisTimerCleared = true; } },
      chatLauncher: { focus: async owner => { focused.push(owner); return true; }, owns: () => true, close: async () => { closes++; }, diagnose: async () => { checks++; return { reason: diagnosis }; } },
      getCanvasWindows: () => [window],
    });
    ui.publishStatus(snapshot);
    await new Promise(resolve => setImmediate(resolve));
    const status = () => handlers.get(IPC_CHANNELS.GET_STATUS)({ sender: { __isCanvasRenderer: true } });
    assert.equal((await status()).status.chat.pool.workers[0].launch.reason, 'approval_required');
    const open = payload => handlers.get(IPC_CHANNELS.OPEN_WORKER_CHAT)({ sender }, payload);
    assert.equal((await open({ generation: 40, workerOrdinal: 1 })).success, false);
    assert.equal((await open({ generation: 41, workerOrdinal: 2 })).success, false);
    assert.equal((await open({ generation: 41, workerOrdinal: 1, url: 'untrusted' })).success, false);
    assert.equal((await open({ generation: 41, workerOrdinal: 1 })).success, true);
    assert.deepEqual(focused, ['worker:41:1']);

    ui.publishStatus(snapshot);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(checks, 1, 'status bursts do not hammer Chrome');
    tick += 15_000; diagnosis = 'none'; diagnosisTick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await status()).status.chat.pool.workers[0].launch.reason, null);
    assert.equal(closes, 0, 'a consent wait never replaces the worker');
    assert.equal(checks, 2, 'approval is rechecked without a status change or MCP call');
    tick += 15_000; diagnosis = 'approval_required'; diagnosisTick();
    await new Promise(resolve => setImmediate(resolve));
    snapshot.chat.pool.workers[0].state = 'idle';
    ui.publishStatus(snapshot);
    assert.equal((await status()).status.chat.pool.workers[0].launch.reason, null, 'cancellation clears a stale approval alert');
    ui.dispose();
    assert.equal(diagnosisTimerCleared, true, 'disposing the dock stops observation');
  } },
  { name: 'chat launcher: a fresh relaunch closes the owner’s previously recorded tab before opening', async run() {
    const h = harness();
    assert.equal((await h.launcher.launch({ owner: 'worker:1:1', starter })).ok, true);
    const before = h.calls.length;
    assert.equal((await h.launcher.launch({ owner: 'worker:1:1', starter })).ok, true);
    const later = h.calls.slice(before);
    const closes = later.map((call, index) => ({ call, index })).filter(({ call }) => call.script === h.launcher.scripts.CLOSE);
    assert.deepEqual(closes.map(({ call }) => call.args.map(String)), [['100', '200']]);
    const open = later.findIndex(call => call.script === h.launcher.scripts.OPEN);
    assert.ok(open > closes[0].index, 'the old tab is closed before the new one opens');
  } },
  { name: 'chat launcher: close also closes duplicate tabs of exactly the retiring chat', async run() {
    const h = harness();
    await h.launcher.launch({ owner: 'worker:1:1', starter });
    await h.launcher.launch({ owner: 'worker:1:2', starter });
    const before = h.calls.length;
    assert.equal(await h.launcher.close('worker:1:1'), true);
    const later = h.calls.slice(before);
    assert.deepEqual(later.filter(call => call.script === h.launcher.scripts.CLOSE).map(call => call.args.map(String)), [['100', '200']]);
    assert.deepEqual(later.filter(call => call.script === h.launcher.scripts.CLOSE_CHAT).map(call => call.args), [['unique-chat-123']],
      'only the retiring chat id is scanned for; the other worker’s chat is not');
    assert.equal(h.launcher.owns('worker:1:2'), true);

    // The JXA scan closes exact matches (with optional slash/query/hash) only.
    const windows = [['https://chatgpt.com/c/unique-chat-123', 'https://chatgpt.com/c/unique-chat-124', 'https://chatgpt.com/c/unique-chat-123/'],
      ['https://chatgpt.com/c/unique-chat-1234', 'https://chatgpt.com/c/unique-chat-123?model=x', 'https://chatgpt.com/c/unique-chat-123#end',
        'https://example.com/c/unique-chat-123', 'https://chatgpt.com/']];
    const chrome = { windows: () => windows.map(urls => ({ tabs: () => urls.map(url => ({ url: () => url,
      close: () => urls.splice(urls.indexOf(url), 1) })) })) };
    let pid = null;
    const count = runInNewContext(`${h.launcher.scripts.CLOSE_CHAT}\nrun(['42', 'unique-chat-123'])`, { Application: value => { pid = value; return chrome; } });
    assert.equal(pid, 42);
    assert.equal(count, '4');
    assert.deepEqual(windows, [['https://chatgpt.com/c/unique-chat-124'],
      ['https://chatgpt.com/c/unique-chat-1234', 'https://example.com/c/unique-chat-123', 'https://chatgpt.com/']]);
  } },
  { name: 'chat launcher: a close that fails while Chrome is busy is retried on the next launcher call', async run() {
    const h = harness({ closeFailures: 1 });
    await h.launcher.launch({ owner: 'worker:1:1', starter });
    assert.equal(await h.launcher.close('worker:1:1'), false);
    assert.equal(h.launcher.owns('worker:1:1'), false);
    const before = h.calls.length;
    assert.equal((await h.launcher.launch({ owner: 'worker:1:2', starter })).ok, true);
    const later = h.calls.slice(before);
    const retry = later.findIndex(call => call.script === h.launcher.scripts.CLOSE);
    assert.deepEqual(later[retry].args.map(String), ['100', '200']);
    assert.ok(retry < later.findIndex(call => call.script === h.launcher.scripts.OPEN), 'the retry runs at the start of the launch');
    assert.equal(later.filter(call => call.script === h.launcher.scripts.CLOSE).length, 1);
    const settled = h.calls.length;
    await h.launcher.close('worker:9:9');
    assert.equal(h.calls.slice(settled).filter(call => call.script === h.launcher.scripts.CLOSE).length, 0, 'a closed tab is not retried again');
  } },
  { name: 'chat launcher: a waiting worker with a visible delivery failure and a minute of silence is replaced', async run() {
    const clock = { now: Date.now() };
    const worker = { ordinal: 1, state: 'waiting', firstCallAt: clock.now - 600_000, lastCallAt: clock.now - 61_000, restarts: 0 };
    const h = observedWorkerUi({ worker, clock, diagnosis: () => ({ reason: 'delivery_timeout', assistantPresent: true, responding: false }) });
    try {
      await h.publish();
      assert.deepEqual(h.diagnoses, ['worker:31:1']);
      assert.deepEqual(h.calls, [['restart', { generation: 31, workerOrdinal: 1, observedFailure: true, automatic: true }], ['close', 'worker:31:1'], ['launch']]);
    } finally { h.ui.dispose(); }
  } },
  { name: 'chat launcher: a waiting worker that polled recently is not diagnosed', async run() {
    const clock = { now: Date.now() };
    const worker = { ordinal: 1, state: 'waiting', firstCallAt: clock.now - 600_000, lastCallAt: clock.now - 39_000, restarts: 0 };
    const h = observedWorkerUi({ worker, clock, diagnosis: () => ({ reason: 'delivery_timeout', assistantPresent: true, responding: false }) });
    try {
      await h.publish();
      assert.deepEqual(h.diagnoses, []);
      assert.equal(h.armed(), true, 'observation stays armed so the worker is looked at once it is overdue');
      await h.tick(500);
      assert.deepEqual(h.diagnoses, []);
      await h.tick(1_000);
      assert.deepEqual(h.diagnoses, ['worker:31:1'], 'a poll 40s overdue is looked at without a status change');
    } finally { h.ui.dispose(); }
  } },
  { name: 'chat launcher: a waiting worker silent under a minute is not yet replaced', async run() {
    const clock = { now: Date.now() };
    const worker = { ordinal: 1, state: 'waiting', firstCallAt: clock.now - 600_000, lastCallAt: clock.now - 45_000, restarts: 0 };
    const h = observedWorkerUi({ worker, clock, diagnosis: () => ({ reason: 'delivery_timeout', assistantPresent: true, responding: false }) });
    try {
      await h.publish();
      assert.deepEqual(h.diagnoses, ['worker:31:1']);
      assert.deepEqual(h.calls, []);
      assert.equal((await h.launch())?.reason, 'delivery_timeout');
      await h.tick(16_000);
      assert.deepEqual(h.calls, [['restart', { generation: 31, workerOrdinal: 1, observedFailure: true, automatic: true }], ['close', 'worker:31:1'], ['launch']]);
    } finally { h.ui.dispose(); }
  } },
  { name: 'chat launcher: repeated quiet no-Stop observations remain provisional through a later accepted handoff', async run() {
    const clock = { now: Date.now() };
    const worker = { ordinal: 1, state: 'quiet', quietReason: 'answer_silent', firstCallAt: clock.now - 600_000, lastCallAt: clock.now - 400_000, restarts: 0 };
    const h = observedWorkerUi({ worker, clock, diagnosis: () => noStop });
    try {
      await h.publish();
      for (let look = 0; look < 6; look++) await h.tick(15_000);
      assert.equal((await h.launch())?.reason ?? null, null, 'absence of a Stop control does not prove the overdue answer stopped');
      assert.equal(worker.state, 'quiet');
      assert.equal(worker.quietReason, 'answer_silent', 'the engine retains its honest overdue-answer diagnosis');
      assert.deepEqual(h.calls, [], 'the owned chat and capability remain intact');
      worker.lastCallAt = ++clock.now; worker.lastOutcome = 'accepted'; worker.completed = 1; worker.state = 'waiting';
      await h.publish();
      assert.equal((await h.launch())?.reason ?? null, null);
      assert.deepEqual(h.calls, [], 'later authenticated acceptance needs no replacement or warning recovery');
    } finally { h.ui.dispose(); }
  } },
  { name: 'chat launcher: temporary tool gaps stay provisional through acceptance and an overdue-answer transition', async run() {
    const clock = { now: Date.now() };
    const worker = { ordinal: 1, state: 'working', firstCallAt: clock.now - 600_000, lastCallAt: clock.now - 400_000, restarts: 0 };
    const h = observedWorkerUi({ worker, clock, diagnosis: () => noStop });
    try {
      await h.publish();
      for (let look = 0; look < 4; look++) await h.tick(15_000);
      assert.equal((await h.launch())?.reason ?? null, null, 'a no-Stop tool gap is not a failed chat while the engine still owns progressing work');
      assert.deepEqual(h.calls, []);
      worker.lastCallAt = ++clock.now; worker.lastOutcome = 'accepted'; worker.completed = 1; worker.state = 'waiting';
      await h.publish();
      assert.equal((await h.launch())?.reason ?? null, null, 'the completed handoff needed no warning or replacement');
      worker.lastCallAt = ++clock.now; worker.lastOutcome = 'served'; worker.state = 'working';
      await h.tick(15_000);
      assert.equal((await h.launch())?.reason ?? null, null);
      worker.state = 'quiet'; worker.quietReason = 'answer_silent';
      await h.tick(400_000);
      assert.deepEqual(h.calls, [], 'an overdue answer remains provisional without an explicit failure');
      await h.tick(15_000);
      assert.deepEqual(h.calls, [], 'repeated quiet no-Stop observations never authorize replacing owned work');
      assert.equal((await h.launch())?.reason ?? null, null);
    } finally { h.ui.dispose(); }
  } },
  { name: 'chat launcher: delayed explicit failure observations are fenced by bridge liveness, replacement incarnation and quiet transition', async run() {
    for (const change of ['newer-bridge-call', 'replacement-incarnation', 'quiet-transition']) {
      const clock = { now: Date.now() };
      const worker = { ordinal: 1, state: change === 'quiet-transition' ? 'working' : 'quiet', quietReason: 'answer_silent',
        firstCallAt: clock.now - 600_000, lastCallAt: clock.now - 400_000, restarts: 0 };
      let resolveDiagnosis; let pending = true;
      const diagnosis = new Promise(resolve => { resolveDiagnosis = resolve; });
      const h = observedWorkerUi({ worker, clock, diagnosis: () => pending ? diagnosis : { ...noStop, reason: 'delivery_timeout' } });
      h.snapshot.autoLaunchChats = false;
      try {
        await h.publish();
        if (change === 'newer-bridge-call') worker.lastCallAt = ++clock.now;
        if (change === 'replacement-incarnation') { worker.restarts++; worker.firstCallAt = ++clock.now; }
        worker.state = 'quiet'; worker.quietReason = 'answer_silent';
        pending = false; resolveDiagnosis({ ...noStop, reason: 'delivery_timeout' }); await flush();
        assert.equal((await h.launch())?.reason ?? null, null, `${change} invalidates the pending observation`);
        await h.tick(400_000);
        assert.equal((await h.launch()).reason, 'delivery_timeout', 'a fresh explicit failure belongs to the current owner and lifecycle');
        assert.deepEqual(h.calls, []);
      } finally { resolveDiagnosis(noStop); h.ui.dispose(); }
    }
  } },
  { name: 'chat launcher: unknown and explicit absent response controls never become stopped evidence', async run() {
    const observation = { reason: 'none', assistantPresent: true, responding: false };
    const backend = harness({ diagnosisResult: observation });
    assert.equal((await backend.launcher.launch({ owner: 'worker:31:1', starter })).ok, true);
    const clock = { now: Date.now() };
    const worker = { ordinal: 1, state: 'quiet', quietReason: 'answer_silent', firstCallAt: clock.now - 600_000, lastCallAt: clock.now - 400_000, restarts: 0 };
    const h = observedWorkerUi({ worker, clock, diagnosis: () => backend.launcher.diagnose('worker:31:1') });
    h.snapshot.autoLaunchChats = false;
    try {
      await h.publish();
      assert.equal((await h.launch())?.reason ?? null, null, 'an absent response control does not establish a stopped chat');
      for (const unknown of [undefined, null, 0, 'false', {}, []]) {
        observation.responding = unknown;
        assert.equal((await backend.launcher.diagnose('worker:31:1')).responding, null);
        await h.tick(15_000);
        assert.equal((await h.launch())?.reason ?? null, null, 'partial or malformed data does not create a stopped warning');
      }
      observation.responding = false;
      await h.tick(15_000);
      assert.equal((await h.launch())?.reason ?? null, null, 'a fresh absent response control remains provisional');
      await h.tick(15_000);
      assert.equal((await h.launch())?.reason ?? null, null, 'repeated complete no-Stop observations remain provisional');
      observation.responding = true;
      await h.tick(15_000);
      assert.equal((await h.launch())?.reason ?? null, null, 'a visible response control also leaves the healthy chat intact');
      assert.deepEqual(h.calls, [], 'inconclusive observations cannot replace an answer-owning worker');
    } finally { h.ui.dispose(); await backend.launcher.close('worker:31:1'); }
  } },
  { name: 'chat launcher: a newer bridge call clears an observed transport warning without restarting the recovered worker', async run() {
    for (const reason of ['delivery_timeout', 'conversation_unavailable']) {
      const clock = { now: Date.now() };
      const worker = { ordinal: 1, state: 'working', quietReason: 'answer_silent',
        firstCallAt: clock.now - 600_000, lastCallAt: clock.now - 400_000, restarts: 0 };
      const h = observedWorkerUi({ worker, clock,
        diagnosis: () => ({ ...noStop, reason }) });
      try {
        await h.publish();
        assert.equal((await h.launch()).reason, reason);
        const diagnoses = h.diagnoses.length;
        worker.lastCallAt = ++clock.now;
        worker.lastOutcome = 'accepted'; worker.completed = 1; worker.state = 'waiting';
        await h.publish();
        assert.equal((await h.launch()).stage, 'presented');
        assert.equal((await h.launch()).reason, null, 'authenticated liveness supersedes the earlier tab observation');
        for (let poll = 0; poll < 4; poll++) {
          worker.lastCallAt = clock.now + 15_000; worker.lastOutcome = 'waiting';
          await h.tick(15_000);
        }
        assert.equal((await h.launch()).reason, null);
        assert.equal(h.diagnoses.length, diagnoses, 'healthy polling needs no additional DOM diagnosis to clear its warning');
        assert.deepEqual(h.calls, [], 'recovered work keeps its chat and capability');
      } finally { h.ui.dispose(); }
    }
  } },
  { name: 'chat launcher: bridge liveness preserves launch, consent and refusal failures and cannot clear another incarnation observation', async run() {
    for (const reason of ['delivery_timeout', 'approval_required', 'reconnect_required', 'safety_block', 'send_not_confirmed']) {
      const clock = { now: Date.now() };
      const worker = { ordinal: 1, state: 'ready', firstCallAt: null, lastCallAt: null, restarts: 0 };
      const h = observedWorkerUi({ worker, clock, diagnosis: () => noStop,
        controller: { copyWorkerStarter: async () => ({ copied: true, sessionCode: '3'.repeat(26), workerCount: 1 }) },
        launchResult: { ok: false, reason } });
      try {
        await h.publish();
        assert.equal((await h.launch()).reason, reason);
        worker.firstCallAt = clock.now; worker.lastCallAt = ++clock.now; worker.state = 'waiting';
        await h.publish();
        assert.equal((await h.launch()).reason, reason, 'only a connected-tab observation is cleared by later liveness');
      } finally { h.ui.dispose(); }
    }
    const clock = { now: Date.now() };
    const worker = { ordinal: 1, state: 'quiet', quietReason: 'answer_silent', firstCallAt: clock.now - 600_000, lastCallAt: clock.now - 400_000, restarts: 0 };
    const h = observedWorkerUi({ worker, clock, diagnosis: () => ({ ...noStop, reason: 'delivery_timeout' }) });
    h.snapshot.autoLaunchChats = false;
    try {
      await h.publish(); await h.tick(15_000);
      assert.equal((await h.launch()).reason, 'delivery_timeout');
      worker.restarts++; worker.firstCallAt = clock.now; worker.lastCallAt = ++clock.now; worker.state = 'waiting';
      await h.publish();
      assert.equal((await h.launch()).reason, 'delivery_timeout', 'another incarnation cannot acknowledge this observation');
    } finally { h.ui.dispose(); }
  } },
  { name: 'chat launcher: a not-responding look never clears a delivery failure', async run() {
    const clock = { now: Date.now() };
    const worker = { ordinal: 1, state: 'working', firstCallAt: clock.now - 600_000, lastCallAt: clock.now - 400_000, restarts: 0 };
    let next = { reason: 'delivery_timeout', assistantPresent: true, responding: false };
    const h = observedWorkerUi({ worker, clock, diagnosis: () => next });
    try {
      await h.publish();
      assert.equal((await h.launch()).reason, 'delivery_timeout');
      next = noStop; await h.tick(15_000);
      assert.equal((await h.launch()).reason, 'delivery_timeout');
      next = responding; await h.tick(15_000);
      assert.equal((await h.launch()).reason, null);
      assert.deepEqual(h.calls, []);
    } finally { h.ui.dispose(); }
  } },
  { name: 'chat launcher: response-control visibility alone never replaces working, waiting or quiet chats', async run() {
    for (const observation of [noStop, responding]) {
      for (const [state, quietReason] of [['working', null], ['quiet', 'answer_silent'], ['waiting', null]]) {
        const clock = { now: Date.now() };
        const worker = { ordinal: 1, state, quietReason, firstCallAt: clock.now - 900_000, lastCallAt: clock.now - 400_000, restarts: 0 };
        const h = observedWorkerUi({ worker, clock, diagnosis: () => observation });
        try {
          await h.publish();
          for (let look = 0; look < 4; look++) await h.tick(15_000);
          assert.equal(h.diagnoses.length, 5, `${state} worker is observed`);
          assert.equal((await h.launch())?.reason ?? null, null);
          assert.deepEqual(h.calls, [], `${state} worker requires affirmative failure evidence before replacement`);
        } finally { h.ui.dispose(); }
      }
    }
  } },
  { name: 'chat launcher: idle workers are never diagnosed', async run() {
    const clock = { now: Date.now() };
    const worker = { ordinal: 1, state: 'idle', firstCallAt: clock.now - 900_000, lastCallAt: clock.now - 400_000, restarts: 0 };
    const h = observedWorkerUi({ worker, clock, diagnosis: () => ({ reason: 'delivery_timeout', assistantPresent: true, responding: false }) });
    try {
      await h.publish();
      await h.tick(15_000);
      await h.tick(15_000);
      assert.deepEqual(h.diagnoses, []);
      assert.equal(h.calls.some(([kind]) => kind === 'restart' || kind === 'launch'), false);
    } finally { h.ui.dispose(); }
  } },
  { name: 'chat launcher: a restart whose attachment preparation fails has already closed the old tab', async run() {
    const clock = { now: Date.now() };
    const worker = { ordinal: 1, state: 'waiting', firstCallAt: clock.now - 600_000, lastCallAt: clock.now - 61_000, restarts: 0 };
    const abandoned = [];
    const h = observedWorkerUi({ worker, clock, diagnosis: () => ({ reason: 'delivery_timeout', assistantPresent: true, responding: false }),
      controller: { prepareWorkerAttachment: async () => ({ status: 'failed', reason: 'read_error' }),
        abandonWorkerStarter: async args => { abandoned.push(args.workerOrdinal); } } });
    try {
      await h.publish();
      assert.deepEqual(h.calls, [['restart', { generation: 31, workerOrdinal: 1, observedFailure: true, automatic: true }], ['close', 'worker:31:1']]);
      assert.deepEqual(abandoned, [1]);
      assert.equal((await h.launch())?.reason, 'attachment_prepare_read_error');
    } finally { h.ui.dispose(); }
  } },
  { name: 'chat launcher: restored attachment or failed upload never sends', async run() {
    for (const options of [{ staleAttachment: true }, { uploadFailed: true }]) {
      const h = harness(options);
      const result = await h.launcher.launch({ owner: 'worker:1:1', starter,
        attachmentHandoffCode: 'HANDOFF-234567',
        attachments: [{ name: 'photo.png', mime: 'image/png', bytes: new Uint8Array([1]) }],
      });
      assert.equal(result.ok, false);
      assert(!h.calls.some(item => item.args?.[2]?.includes('button[aria-label="Send"]')));
    }
  } },
  ...[
    ['available', null, 'copyWorkerStarter'],
    ['quiet', 'fresh_context_required', 'restartWorker'],
    ['quiet', 'polling_stopped', 'restartWorker'],
  ].map(([state, quietReason, method]) => ({ name: `chat launcher: auto launch ${state} ${quietReason || ''} once`, async run() {
    const handlers = new Map();
    const calls = [];
    let abandoned = 0;
    const snapshot = {
      autoLaunchChats: true, serving: 'live', config: { pluginName: 'infinite_canvas' },
      chat: { pool: { active: true, generation: 7, workerCount: 1, workers: [{ ordinal: 1, state, quietReason, restarts: 0 }] } },
    };
    const controller = {
      snapshot: () => snapshot, subscribe: () => () => {},
      copyWorkerStarter: async () => { calls.push('copyWorkerStarter'); return { copied: true, sessionCode: '2'.repeat(26), generation: 7, workerOrdinal: 1, workerCount: 1 }; },
      restartWorker: async () => { calls.push('restartWorker'); return { copied: true, sessionCode: '2'.repeat(26), generation: 7, workerOrdinal: 1, workerCount: 1 }; },
      abandonWorkerStarter: async () => { abandoned++; return true; },
    };
    const ui = registerHandoffBridgeUi({
      ipc: { handle: (key, value) => handlers.set(key, value), removeHandler: key => handlers.delete(key), on() {}, removeListener() {} },
      controller, chatLauncher: { launch: async () => ({ ok: false, reason: 'chrome_unavailable' }), close: async () => true, owns: () => false, rekey: () => false },
      getCanvasWindows: () => [],
    });
    assert.equal(ui.registration.ok, true);
    ui.publishStatus(snapshot);
    ui.publishStatus(snapshot);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, [method]);
    assert.equal(abandoned, 1);
    ui.dispose();
  } })),
  { name: 'chat launcher: worker retries after Chrome Apple Events JavaScript is enabled', async run() {
    let retryTick;
    let launches = 0;
    let closes = 0;
    const snapshot = { autoLaunchChats: true, serving: 'live', config: { pluginName: 'infinite_canvas' },
      chat: { pool: { active: true, generation: 8, workerCount: 1,
        workers: [{ ordinal: 1, state: 'available', restarts: 0 }] } } };
    const ui = registerHandoffBridgeUi({
      ipc: { handle() {}, removeHandler() {}, on() {}, removeListener() {} },
      controller: {
        snapshot: () => snapshot, subscribe: () => () => {},
        copyWorkerStarter: async () => ({ copied: true, sessionCode: '2'.repeat(26), generation: 8, workerOrdinal: 1, workerCount: 1 }),
        abandonWorkerStarter: async () => true,
      },
      chatLauncher: {
        launch: async () => { launches += 1; return { ok: false, reason: launches === 1 ? 'apple_events_js_off' : 'chrome_unavailable' }; },
        javascriptReady: async () => true, close: async () => { closes += 1; return true; },
        owns: () => true, rekey: () => false,
      },
      timers: { setTimeout(fn, ms) { if (ms === 15_000) retryTick = fn; return { unref() {} }; }, clearTimeout() {} },
      getCanvasWindows: () => [],
    });
    ui.publishStatus(snapshot);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(launches, 1);
    assert.equal(typeof retryTick, 'function');
    await retryTick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closes, 1);
    assert.equal(launches, 2);
    ui.dispose();
  } },
  { name: 'chat launcher: an idle retired worker closes only its owned tab', async run() {
    const handlers = new Map();
    const closed = [];
    const snapshot = { autoLaunchChats: true, serving: 'live', chat: { pool: {
      active: true, generation: 9, workerCount: 1,
      workers: [{ ordinal: 1, state: 'idle', lastOutcome: 'queue_empty' }],
    } } };
    const ui = registerHandoffBridgeUi({
      ipc: { handle: (key, value) => handlers.set(key, value), removeHandler: key => handlers.delete(key), on() {}, removeListener() {} },
      controller: { snapshot: () => snapshot, subscribe: () => () => {} },
      chatLauncher: { owns: owner => owner === 'worker:9:1', close: async owner => { closed.push(owner); return true; } },
      getCanvasWindows: () => [],
    });
    ui.publishStatus(snapshot);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(closed, ['worker:9:1']);
    ui.dispose();
  } },
  { name: 'chat launcher: career compile work retains the application work flag; other push work does not', async run() {
    for (const [task, expected] of [['career-profile-audit-skills', true], ['resume-parse', true], ['job-scoring', false]]) {
      const handlers = new Map();
      const seen = [];
      const snapshot = { autoLaunchChats: true, serving: 'live', config: { pluginName: 'Infinite Canvas' },
        queue: { applications: { ready: 0, working: 0 }, scoring: { pending: 1, tasks: [{ task, pending: 1 }] } },
        chat: { pool: { active: true, generation: 16, workerCount: 1, workers: [{ ordinal: 1, state: 'available', restarts: 0 }] } } };
      const ui = registerHandoffBridgeUi({
        ipc: { handle: (key, value) => handlers.set(key, value), removeHandler: key => handlers.delete(key), on() {}, removeListener() {} },
        controller: { snapshot: () => snapshot, subscribe: () => () => {},
          copyWorkerStarter: async () => ({ copied: true, sessionCode: '2'.repeat(26), workerCount: 1 }) },
        chatLauncher: { launch: async args => { seen.push(args.application); return { ok: true, chatId: `synthetic-launcher-chat-${++syntheticChatOrdinal}` }; }, close: async () => true,
          diagnose: async () => ({ reason: 'none' }), owns: () => true, observation: () => null },
        getCanvasWindows: () => [], launchPresentationTimeoutMs: 8, launchDiagnosisIntervalMs: 1,
      });
      ui.publishStatus(snapshot);
      await new Promise(resolve => setTimeout(resolve, 40));
      assert(seen.length >= 1, `${task}: a worker launch happened`);
      assert.equal(seen[0], expected, `${task}: application effort flag`);
      ui.dispose();
    }
  } },
  { name: 'chat launcher: main-process launch failures reach the renderer without a controller sequence change', async run() {
    const handlers = new Map();
    const sender = { id: 4, __isCanvasRenderer: true };
    const window = { webContents: { id: 4, send() {} }, isDestroyed: () => false };
    const snapshot = { v: 1, seq: 40, at: Date.now(), autoLaunchChats: true, serving: 'live', config: { pluginName: 'Infinite Canvas' },
      chat: { pool: { active: true, generation: 25, workerCount: 1, workers: [{ ordinal: 1, state: 'available', completed: 0 }] } } };
    const ui = registerHandoffBridgeUi({
      ipc: { handle: (key, value) => handlers.set(key, value), removeHandler() {}, on() {}, removeListener() {} },
      controller: { snapshot: () => snapshot, subscribe: () => () => {},
        copyWorkerStarter: async () => ({ copied: true, sessionCode: '2'.repeat(26), workerCount: 1 }) },
      chatLauncher: { launch: async () => ({ ok: true, chatId: `synthetic-launcher-chat-${++syntheticChatOrdinal}` }), close: async () => true,
        diagnose: async () => ({ reason: 'reconnect_required' }), owns: () => true },
      getCanvasWindows: () => [window], launchPresentationTimeoutMs: 8, launchDiagnosisIntervalMs: 1,
    });
    __resetHandoffBridgeStoreForTests();
    try {
      const getStatus = () => handlers.get(IPC_CHANNELS.GET_STATUS)({ sender });
      const before = (await getStatus()).status;
      applyHandoffBridgeStatus(before);
      ui.publishStatus(snapshot);
      await new Promise(resolve => setTimeout(resolve, 35));
      const after = (await getStatus()).status;
      assert.equal(before.seq, after.seq);
      assert(after.uiRevision > before.uiRevision);
      applyHandoffBridgeStatus(after);
      assert.equal(getHandoffBridgeStatus().chat.pool.workers[0].launch.reason, 'reconnect_required');
      applyHandoffBridgeStatus(before);
      assert.equal(getHandoffBridgeStatus().chat.pool.workers[0].launch.reason, 'reconnect_required', 'old replay cannot erase the failure');
    } finally { ui.dispose(); __resetHandoffBridgeStoreForTests(); }
  } },
  { name: 'chat launcher: first-call approval notifies once, preserves the tab and resumes the pool after approval', async run() {
    const notifications = [];
    const launches = [];
    const closes = [];
    const snapshot = { autoLaunchChats: true, serving: 'live', config: { pluginName: 'Infinite Canvas', telemetryInBugReports: true },
      chat: { pool: { active: true, generation: 25, workerCount: 2, workers: [
        { ordinal: 1, state: 'available', restarts: 0 }, { ordinal: 2, state: 'available', restarts: 0 },
      ] } } };
    const ui = registerHandoffBridgeUi({
      ipc: { handle() {}, removeHandler() {}, on() {}, removeListener() {} },
      controller: { snapshot: () => snapshot, subscribe: () => () => {},
        copyWorkerStarter: async () => ({ copied: true, sessionCode: '2'.repeat(26), workerCount: 2 }) },
      chatLauncher: { launch: async ({ owner }) => {
        launches.push(owner);
        if (owner === 'worker:25:2') snapshot.chat.pool.workers[1].firstCallAt = Date.now();
        return { ok: true, chatId: `synthetic-launcher-chat-${++syntheticChatOrdinal}` };
      }, close: async owner => { closes.push(owner); return true; },
        diagnose: async () => ({ reason: 'approval_required' }), owns: () => true },
      notifyLaunchProblem: kind => notifications.push(kind),
      getCanvasWindows: () => [], launchPresentationTimeoutMs: 8, launchDiagnosisIntervalMs: 1,
    });
    clearBridgeLaunchDiagnostic();
    try {
      ui.publishStatus(snapshot);
      await new Promise(resolve => setTimeout(resolve, 35));
      assert.deepEqual(notifications, ['approval-required']);
      assert(getBridgeLaunchDiagnostic().some(entry => entry.workerOrdinal === 1 && entry.reason === 'approval_required'));
      assert.deepEqual(launches, ['worker:25:1']);
      assert.deepEqual(closes, [], 'approval must keep the exact chat alive');
      snapshot.chat.pool.workers[0] = { ...snapshot.chat.pool.workers[0], state: 'working', firstCallAt: Date.now() };
      ui.publishStatus(snapshot);
      await new Promise(resolve => setTimeout(resolve, 35));
      assert.deepEqual(launches, ['worker:25:1', 'worker:25:2']);
      assert.deepEqual(notifications, ['approval-required']);
      assert.deepEqual(closes, []);
    } finally { ui.dispose(); clearBridgeLaunchDiagnostic(); }
  } },
  { name: 'chat launcher: usage limit preserves the unpresented worker without retrying at Pro effort', async run() {
    const handlers = new Map();
    const calls = [];
    const snapshot = { autoLaunchChats: true, serving: 'live', config: { pluginName: 'Infinite Canvas' },
      queue: { applications: { ready: 1, working: 0 } },
      chat: { pool: { active: true, generation: 15, workerCount: 1, workers: [{ ordinal: 1, state: 'available', restarts: 0 }] } } };
    let launches = 0;
    const ui = registerHandoffBridgeUi({
      ipc: { handle: (key, value) => handlers.set(key, value), removeHandler: key => handlers.delete(key), on() {}, removeListener() {} },
      controller: { snapshot: () => snapshot, subscribe: () => () => {},
        copyWorkerStarter: async () => ({ copied: true, sessionCode: '2'.repeat(26), workerCount: 1 }),
        restartWorker: async args => { calls.push(args); return { copied: true, sessionCode: '3'.repeat(26), workerCount: 1 }; } },
      chatLauncher: { launch: async () => { launches++; return { ok: true, chatId: `synthetic-launcher-chat-${++syntheticChatOrdinal}` }; }, close: async () => true,
        diagnose: async () => ({ reason: launches === 1 ? 'usage_limit' : 'none' }),
        markProUnavailable: () => calls.push('cap'), owns: () => true, observation: () => null },
      getCanvasWindows: () => [], launchPresentationTimeoutMs: 8, launchDiagnosisIntervalMs: 1,
    });
    ui.publishStatus(snapshot);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(launches, 1);
    assert.deepEqual(calls, []);
    ui.dispose();
  } },
  { name: 'chat launcher: queued replacement and delayed retry preserve a worker that reconnects', async run() {
    for (const delayedRetry of [false, true]) {
      const calls = []; let retry;
      const worker = { ordinal: 1, state: delayedRetry ? 'available' : 'quiet', quietReason: delayedRetry ? null : 'polling_stopped', restarts: 0 };
      const snapshot = { autoLaunchChats: true, serving: 'live', config: { pluginName: 'Infinite Canvas' },
        chat: { pool: { active: true, generation: 21, workerCount: 1, workers: [worker] } } };
      const ui = registerHandoffBridgeUi({
        ipc: { handle() {}, removeHandler() {}, on() {}, removeListener() {} },
        controller: { snapshot: () => snapshot, subscribe: () => () => {},
          copyWorkerStarter: async () => ({ copied: true, sessionCode: '2'.repeat(26), workerCount: 1 }),
          abandonWorkerStarter: async () => true,
          restartWorker: async () => { calls.push('restart'); return { copied: false, status: 'not_quiet' }; } },
        chatLauncher: { owns: () => true, close: async () => { calls.push('close'); return true; },
          launch: async () => { calls.push('launch'); return { ok: false, reason: 'chrome_timeout' }; } },
        timers: { setTimeout(fn, ms) { if (ms === 15_000) retry = fn; return { unref() {} }; }, clearTimeout() {} },
        getCanvasWindows: () => [],
      });
      try {
        ui.publishStatus(snapshot);
        if (delayedRetry) await new Promise(resolve => setImmediate(resolve));
        worker.state = 'working'; worker.quietReason = null; worker.firstCallAt = Date.now();
        if (delayedRetry) { assert.equal(typeof retry, 'function'); await retry(); }
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(calls, delayedRetry ? ['launch'] : [], 'no delayed replacement may close or rekey a now-active chat');
      } finally { ui.dispose(); }
    }
  } },
  { name: 'chat launcher: unanswered long-running handoffs are never automatically closed or rekeyed', async run() {
    const calls = [];
    const worker = { ordinal: 1, state: 'quiet', quietReason: 'answer_silent', restarts: 0, firstCallAt: 1, completed: 0 };
    const snapshot = { autoLaunchChats: true, serving: 'live', config: { pluginName: 'Infinite Canvas' },
      chat: { pool: { active: true, generation: 20, workerCount: 1, workers: [worker] } } };
    const ui = registerHandoffBridgeUi({
      ipc: { handle() {}, removeHandler() {}, on() {}, removeListener() {} },
      controller: { snapshot: () => snapshot, subscribe: () => () => {},
        restartWorker: async () => { calls.push('rekey'); return { copied: true, sessionCode: '3'.repeat(26), workerCount: 1 }; } },
      chatLauncher: { launch: async () => { calls.push('launch'); return { ok: true, chatId: `synthetic-launcher-chat-${++syntheticChatOrdinal}` }; },
        close: async () => { calls.push('close'); return true; }, owns: () => true },
      getCanvasWindows: () => [],
    });
    try {
      // Repeated quiet observations, including the report's 3 replacements /
      // zero completions state, must preserve a possibly-thinking worker.
      for (const restarts of [0, 1, 3, 14]) {
        worker.restarts = restarts;
        ui.publishStatus(snapshot); ui.publishStatus(snapshot);
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.deepEqual(calls, []);
    } finally { ui.dispose(); }
  } },
  { name: 'chat launcher: safety block uses the engine quiet-window restart path', async run() {
    const calls = [];
    const worker = { ordinal: 1, state: 'available', restarts: 0 };
    const snapshot = { autoLaunchChats: true, serving: 'live', config: { pluginName: 'Infinite Canvas' },
      chat: { pool: { active: true, generation: 20, workerCount: 1, workers: [worker] } } };
    const ui = registerHandoffBridgeUi({
      ipc: { handle() {}, removeHandler() {}, on() {}, removeListener() {} },
      controller: { snapshot: () => snapshot, subscribe: () => () => {},
        copyWorkerStarter: async () => ({ copied: true, sessionCode: '2'.repeat(26), workerCount: 1 }),
        restartWorker: async args => { calls.push(args); return { copied: true, sessionCode: '3'.repeat(26), workerCount: 1 }; } },
      chatLauncher: { launch: async () => ({ ok: true, chatId: `synthetic-launcher-chat-${++syntheticChatOrdinal}` }), close: async () => true,
        diagnose: async () => ({ reason: 'safety_block' }), owns: () => true, observation: () => null },
      getCanvasWindows: () => [], launchPresentationTimeoutMs: 8, launchDiagnosisIntervalMs: 1,
    });
    ui.publishStatus(snapshot);
    await new Promise(resolve => setTimeout(resolve, 35));
    worker.state = 'quiet'; worker.quietReason = 'answer_silent'; worker.restarts = 1;
    ui.publishStatus(snapshot);
    await new Promise(resolve => setTimeout(resolve, 35));
    assert(calls.length >= 1, 'the quiet worker must restart after the safety block');
    ui.dispose();
  } },
  { name: 'chat launcher: missing plugin pauses the queue and Retry replaces the key', async run() {
    const handlers = new Map();
    const notifications = [];
    const restarts = [];
    const sender = { id: 4, __isCanvasRenderer: true };
    const window = { webContents: { id: 4, send() {} }, isDestroyed: () => false };
    const snapshot = { autoLaunchChats: true, serving: 'live', config: { pluginName: 'Infinite Canvas' },
      chat: { pool: { active: true, generation: 16, workerCount: 2, workers: [
        { ordinal: 1, state: 'available', restarts: 0 }, { ordinal: 2, state: 'available', restarts: 0 },
      ] } } };
    let launches = 0;
    let resolved = false;
    const ui = registerHandoffBridgeUi({
      ipc: { handle: (key, value) => handlers.set(key, value), removeHandler: key => handlers.delete(key), on() {}, removeListener() {} },
      controller: { snapshot: () => snapshot, subscribe: () => () => {},
        copyWorkerStarter: async () => ({ copied: true, sessionCode: '2'.repeat(26), workerCount: 2 }),
        restartWorker: async args => { restarts.push(args); return { copied: true, sessionCode: '3'.repeat(26), workerCount: 2 }; } },
      chatLauncher: { launch: async () => { launches++; if (resolved) snapshot.chat.pool.workers[0].firstCallAt = Date.now(); return { ok: true, chatId: `synthetic-launcher-chat-${++syntheticChatOrdinal}` }; },
        close: async () => true, diagnose: async () => ({ reason: resolved ? 'none' : 'plugin_missing' }),
        accountName: () => 'Example', owns: () => true, observation: () => null },
      notifyLaunchProblem: kind => notifications.push(kind),
      getCanvasWindows: () => [window], launchPresentationTimeoutMs: 8, launchDiagnosisIntervalMs: 1,
    });
    ui.publishStatus(snapshot);
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(launches, 1);
    assert.deepEqual(notifications, ['plugin-missing']);
    const account = await handlers.get(IPC_CHANNELS.GET_LAUNCH_ACCOUNT)({ sender }, { generation: 16, workerOrdinal: 1 });
    assert.equal(account.displayName, 'Example');
    assert(!JSON.stringify(ui.candidates()).includes('Example'));
    resolved = true;
    const retry = await handlers.get(IPC_CHANNELS.RETRY_WORKER_LAUNCH)({ sender }, { generation: 16, workerOrdinal: 1 });
    assert.equal(retry.success, true);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert(restarts.some(item => item.failedLaunch === true));
    assert(launches >= 2);
    ui.dispose();
  } },
  ...[
    ['scoring work waits with no pool', { serving: 'live', queue: { scoring: { pending: 1 } } }, 1],
    ['an application bundle is unread with no pool', { serving: 'live', queue: { jobs: [{ phase: 'unread' }] } }, 1],
    ['an idle-paused bridge has waiting work', { serving: 'paused', paused: true, pauseCause: 'idle', queue: { scoring: { pending: 2 } } }, 1],
    ['a bundle that was mid-run at quit is held for restart', { serving: 'live', hold: 'restart', queue: { jobs: [{ phase: 'held', reason: 'restart' }] } }, 1],
    ['a bundle is held for another reason', { serving: 'live', queue: { jobs: [{ phase: 'held', reason: 'user_hold' }] } }, 0],
    ['nothing is waiting', { serving: 'live', queue: { scoring: { pending: 0 }, jobs: [{ phase: 'done' }] } }, 0],
    ['the post-launch restart hold is up (auto-launch is the consent)', { serving: 'live', hold: 'restart', queue: { scoring: { pending: 1 } } }, 1],
    ['no canvas window is open', { serving: 'live', hold: 'no-window', queue: { scoring: { pending: 1 } } }, 0],
    ['a manual pause is the person\'s decision', { serving: 'paused', paused: true, pauseCause: 'manual', queue: { scoring: { pending: 1 } } }, 0],
    ['a pool is already active', { serving: 'live', queue: { scoring: { pending: 1 } }, chat: { pool: { active: true, generation: 3, workerCount: 1, workers: [] } } }, 0],
  ].map(([label, extra, expected]) => ({ name: `chat launcher: pool auto-start when ${label}`, async run() {
    let starts = 0;
    const snapshot = { autoLaunchChats: true, config: { pluginName: 'infinite_canvas' }, chat: { pool: { active: false } }, ...extra };
    const ui = registerHandoffBridgeUi({
      ipc: { handle() {}, removeHandler() {}, on() {}, removeListener() {} },
      controller: {
        snapshot: () => snapshot, subscribe: () => () => {},
        startWorkerPool: async args => {
          starts += 1;
          assert(isUiRestartContext(args?.restartContext), 'the automatic start carries the UI restart capability, never a renderer payload');
          return { success: true, started: true, generation: 1, workerCount: 1 };
        },
      },
      chatLauncher: { launch: async () => ({ ok: false, reason: 'chrome_unavailable' }), close: async () => true, owns: () => false, rekey: () => false },
      timers: { setTimeout: () => ({ unref() {} }), clearTimeout() {} },
      getCanvasWindows: () => [],
    });
    ui.publishStatus(snapshot);
    ui.publishStatus(snapshot);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(starts, expected, `startWorkerPool calls when ${label}`);
    ui.dispose();
  } })),
  { name: 'chat launcher: pool auto-start retries after queue_empty and stops on dispose', async run() {
    let starts = 0;
    let clock = 1_000_000;
    const pending = [];
    const snapshot = { autoLaunchChats: true, serving: 'live', config: { pluginName: 'infinite_canvas' },
      chat: { pool: { active: false } }, queue: { scoring: { pending: 1 } } };
    const ui = registerHandoffBridgeUi({
      ipc: { handle() {}, removeHandler() {}, on() {}, removeListener() {} },
      controller: {
        snapshot: () => snapshot, subscribe: () => () => {},
        startWorkerPool: async () => { starts += 1; return { success: false, code: 'QUEUE_EMPTY' }; },
      },
      chatLauncher: { launch: async () => ({ ok: false, reason: 'chrome_unavailable' }), close: async () => true, owns: () => false, rekey: () => false },
      now: () => clock,
      timers: { setTimeout: (fn, ms) => { const handle = { fn, ms, unref() {} }; pending.push(handle); return handle; }, clearTimeout() {} },
      getCanvasWindows: () => [],
    });
    ui.publishStatus(snapshot);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(starts, 1);
    ui.publishStatus(snapshot);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(starts, 1, 'a second status inside the retry window does not hammer the planner');
    const retry = pending.find(handle => handle.ms === 30_000);
    assert(retry, 'a retry is armed after queue_empty');
    clock += 30_000;
    retry.fn();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(starts, 2, 'the armed retry looks again without a new status');
    ui.dispose();
    clock += 30_000;
    ui.publishStatus(snapshot);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(starts, 2, 'nothing starts after dispose');
  } },
  { name: 'chat launcher: a one-off launch failure retries in a fresh tab, then stops after three tries', async run() {
    const pending = [];
    let launches = 0;
    let closes = 0;
    const snapshot = { autoLaunchChats: true, serving: 'live', config: { pluginName: 'infinite_canvas' },
      chat: { pool: { active: true, generation: 9, workerCount: 1, workers: [{ ordinal: 1, state: 'available', restarts: 0 }] } } };
    const ui = registerHandoffBridgeUi({
      ipc: { handle() {}, removeHandler() {}, on() {}, removeListener() {} },
      controller: {
        snapshot: () => snapshot, subscribe: () => () => {},
        copyWorkerStarter: async () => ({ copied: true, sessionCode: '2'.repeat(26), generation: 9, workerOrdinal: 1, workerCount: 1 }),
        abandonWorkerStarter: async () => true,
      },
      chatLauncher: {
        launch: async () => { launches += 1; return { ok: false, reason: 'editor_timeout' }; },
        close: async () => { closes += 1; return true; }, owns: () => true, rekey: () => false,
      },
      timers: { setTimeout: (fn, ms) => { const handle = { fn, ms, unref() {} }; pending.push(handle); return handle; }, clearTimeout() {} },
      getCanvasWindows: () => [],
    });
    const settle = () => new Promise(resolve => setTimeout(resolve, 5));
    ui.publishStatus(snapshot);
    await settle();
    assert.equal(launches, 1);
    for (const [index, delay] of [15_000, 45_000, 90_000].entries()) {
      const retry = pending.filter(handle => handle.ms === delay).at(-1);
      assert(retry, `retry ${index + 1} is armed after ${delay} ms`);
      await retry.fn();
      await settle();
      assert.equal(launches, index + 2, `retry ${index + 1} opens a new launch`);
    }
    assert(closes >= 3, 'each retry closes the failed tab first');
    assert.equal(pending.filter(handle => [15_000, 45_000, 90_000].includes(handle.ms)).length, 3,
      'exactly three retries are ever scheduled');
    ui.publishStatus(snapshot);
    await settle();
    assert.equal(launches, 4, 'after three retries the worker waits for Retry instead of looping');
    ui.dispose();
  } },
  ...[
    'plugin_missing', 'send_not_confirmed', 'safety_block', 'chrome_unavailable_after_send',
  ].map(reason => ({ name: `chat launcher: ${reason} is never retried automatically as a one-off failure`, async run() {
    const pending = [];
    let launches = 0;
    const snapshot = { autoLaunchChats: true, serving: 'live', config: { pluginName: 'infinite_canvas' },
      chat: { pool: { active: true, generation: 10, workerCount: 1, workers: [{ ordinal: 1, state: 'available', restarts: 0 }] } } };
    const ui = registerHandoffBridgeUi({
      ipc: { handle() {}, removeHandler() {}, on() {}, removeListener() {} },
      controller: {
        snapshot: () => snapshot, subscribe: () => () => {},
        copyWorkerStarter: async () => ({ copied: true, sessionCode: '2'.repeat(26), generation: 10, workerOrdinal: 1, workerCount: 1 }),
        abandonWorkerStarter: async () => true,
      },
      chatLauncher: {
        launch: async () => { launches += 1; return { ok: false, reason: reason === 'chrome_unavailable_after_send' ? 'chrome_unavailable' : reason,
          sendAttempted: ['send_not_confirmed', 'chrome_unavailable_after_send'].includes(reason) }; },
        close: async () => true, owns: () => true, rekey: () => false, javascriptReady: async () => false,
      },
      timers: { setTimeout: (fn, ms) => { const handle = { fn, ms, unref() {} }; pending.push(handle); return handle; }, clearTimeout() {} },
      getCanvasWindows: () => [],
    });
    ui.publishStatus(snapshot);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(launches, 1);
    assert(!pending.some(handle => [15_000, 45_000, 90_000].includes(handle.ms)), `${reason} schedules no one-off retry`);
    ui.dispose();
  } })),
  { name: 'chat launcher: every launch outcome is written to the serve ledger as reason codes only', async run() {
    const records = [];
    const pending = [];
    const snapshot = { autoLaunchChats: true, serving: 'live', config: { pluginName: 'infinite_canvas' },
      chat: { pool: { active: true, generation: 11, workerCount: 1, workers: [{ ordinal: 1, state: 'available', restarts: 0 }] } } };
    const ui = registerHandoffBridgeUi({
      ipc: { handle() {}, removeHandler() {}, on() {}, removeListener() {} },
      controller: {
        snapshot: () => snapshot, subscribe: () => () => {},
        copyWorkerStarter: async () => ({ copied: true, sessionCode: '2'.repeat(26), generation: 11, workerOrdinal: 1, workerCount: 1 }),
        abandonWorkerStarter: async () => true,
      },
      chatLauncher: { launch: async () => ({ ok: false, reason: 'tab_open_failed' }), close: async () => true, owns: () => true, rekey: () => false },
      recordLaunch: fields => records.push(fields),
      timers: { setTimeout: (fn, ms) => { const handle = { fn, ms, unref() {} }; pending.push(handle); return handle; }, clearTimeout() {} },
      getCanvasWindows: () => [],
    });
    ui.publishStatus(snapshot);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert(records.some(item => item.outcome === 'failed' && item.reason === 'tab_open_failed'), JSON.stringify(records));
    assert(records.some(item => item.outcome === 'retrying' && item.reason === 'tab_open_failed' && item.count === 1));
    const text = JSON.stringify(records);
    assert(!text.includes('2222222222') && !/chatgpt|starter|http/i.test(text), 'no session code, starter or URL is logged');
    const { makeAuditLine } = await import('../../electron/ipc/handoffBridge/audit.js');
    for (const fields of records) assert(JSON.stringify(makeAuditLine({ at: 1, event: 'launch', fields })).includes('"ev":"launch"'), 'every record passes the ledger whitelist');
    ui.dispose();
  } },
  { name: 'chat launcher: targets the person\'s own Chrome, never the app\'s headless or login Chrome', run() {
    const app = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const ps = [
      `84903 ${app} --no-first-run --user-data-dir=/Users/x/Library/Application Support/infinite-canvas/browser-data --headless=new --remote-debugging-port=0`,
      `70001 ${app} --remote-debugging-port=9222`,
      `70002 ${app} --user-data-dir=/Users/x/Library/Application Support/infinite-canvas/browser-data --no-first-run`,
      `70003 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer`,
      `60486 ${app}`,
    ].join('\n');
    assert.equal(pickUserChromePid(ps), 60486);
    assert.equal(pickUserChromePid(ps.split('\n').filter(line => !line.startsWith('60486')).join('\n')), null,
      'with only app-owned Chromes running there is no user Chrome to script');
    assert.equal(pickUserChromePid(`  512 ${app} --restore-last-session`), 512, 'ordinary user flags are fine');
  } },
  { name: 'chat launcher: our own starter text never reads as a ChatGPT usage limit (live page layout)', async run() {
    const h = harness();
    assert.equal((await h.launcher.launch({ owner: 'worker:1:1', starter })).ok, true);
    await h.launcher.diagnose('worker:1:1', 'Infinite Canvas');
    const script = h.calls.at(-1)?.args?.[2];
    const realStarter = buildWorkerStarterMessage({ pluginName: 'Infinite Canvas', sessionCode: '2'.repeat(26), workerNumber: 1, workerCount: 1, resuming: true });
    // Layout observed 2026-10-15: the agent marker's parent is ChatGPT's turn;
    // its grandparent also holds "You said: <starter>".
    const page = (assistantText, userText = realStarter) => {
      const turn = { innerText: assistantText };
      const marker = { parentElement: turn };
      turn.parentElement = { innerText: `You said:\n${userText}\n${assistantText}` };
      return JSON.parse(runInNewContext(script, { document: { querySelectorAll(selector) {
        return selector === '[data-chatgpt-agent-turn-start]' ? [marker] : [];
      } } }));
    };
    assert(/rate limit/i.test(realStarter), 'the starter really does mention rate limits');
    assert.equal(page('Calling Infinite Canvas get_handoff').reason, 'none', 'the starter in the user turn is not read');
    assert.equal(page('If I hit a rate limit I will back off and retry.').reason, 'none', 'a model talking about rate limits is not a limit');
    assert.equal(page('Calling Infinite Canvas get_handoff', 'If you see "usage limit reached", stop.').reason, 'none',
      'only ChatGPT\'s own turn is read, never the person\'s message');
    assert.equal(page('You\'ve reached your usage limit for GPT-6. Try again tomorrow.').reason, 'usage_limit');
    assert.equal(page('You\'ve hit the Pro limit. Try again after 4:00 PM.').reason, 'usage_limit');
  } },
  { name: 'chat launcher: a retry still relaunches when the worker state changes while it waits', async run() {
    const pending = [];
    let launches = 0;
    const worker = { ordinal: 1, state: 'quiet', quietReason: 'fresh_context_required', restarts: 0 };
    const snapshot = { autoLaunchChats: true, serving: 'live', config: { pluginName: 'infinite_canvas' },
      chat: { pool: { active: true, generation: 12, workerCount: 1, workers: [worker] } } };
    const ui = registerHandoffBridgeUi({
      ipc: { handle() {}, removeHandler() {}, on() {}, removeListener() {} },
      controller: {
        snapshot: () => snapshot, subscribe: () => () => {},
        // A restart moves the worker to 'available' (its starter was abandoned).
        restartWorker: async () => { worker.state = 'available'; worker.quietReason = null; worker.restarts += 1; return { copied: true, sessionCode: '2'.repeat(26), generation: 12, workerOrdinal: 1, workerCount: 1 }; },
        copyWorkerStarter: async () => ({ copied: true, sessionCode: '2'.repeat(26), generation: 12, workerOrdinal: 1, workerCount: 1 }),
        abandonWorkerStarter: async () => true,
      },
      chatLauncher: {
        launch: async () => { launches += 1; return { ok: false, reason: 'chrome_timeout' }; },
        close: async () => true, owns: () => true, rekey: () => false,
      },
      timers: { setTimeout: (fn, ms) => { const handle = { fn, ms, unref() {} }; pending.push(handle); return handle; }, clearTimeout() {} },
      getCanvasWindows: () => [],
    });
    const settle = () => new Promise(resolve => setTimeout(resolve, 5));
    ui.publishStatus(snapshot);
    await settle();
    assert.equal(launches, 1, 'the restart launch ran once');
    ui.publishStatus(snapshot);
    await settle();
    assert.equal(launches, 1, 'the changed state does not relaunch before the retry delay');
    const retry = pending.find(handle => handle.ms === 15_000);
    assert(retry, 'a retry is scheduled');
    await retry.fn();
    await settle();
    assert.equal(launches, 2, 'the retry relaunches even though the attempt key changed');
    ui.dispose();
  } },
];
