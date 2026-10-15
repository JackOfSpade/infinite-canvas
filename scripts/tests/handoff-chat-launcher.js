import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { createChatLauncher } from '../../electron/ipc/handoffBridge/chatLauncher.js';
import { pickUserChromePid } from '../../electron/ipc/browser/appleEvents.js';
import { registerHandoffBridgeUi } from '../../electron/ipc/handoffBridge/ui.js';
import { IPC_CHANNELS } from '../../electron/ipc/handoffBridge/contracts.js';
import { isUiRestartContext } from '../../electron/ipc/handoffBridge/restartContext.js';

function harness(options = {}) {
  const calls = [];
  const states = [];
  let tick = 0;
  let day = 0;
  let chatOrdinal = 0;
  let selectedModel = options.model || 'GPT-6';
  let appleEventsEnabled = options.appleEventsOff !== true;
  let effortPosition = options.effortPosition ?? 3;
  let upsellDismissed = false;
  let activeUrl = 'https://chatgpt.com/';
  let chromeRestarted = false;
  const launcher = createChatLauncher({
    now: () => day * 86_400_000 + (tick += 500), delay: async () => {},
    onState: (...values) => states.push(values),
    run: async (script, args) => {
      calls.push({ script, args });
      if (!appleEventsEnabled && script === launcher.scripts.EXEC) throw new Error('JavaScript through AppleScript is turned off');
      if (script === launcher.scripts.OPEN) { chatOrdinal += 1; activeUrl = args[1]; chromeRestarted = false; return `100:${199 + chatOrdinal}`; }
      if (script === launcher.scripts.CLOSE) return '';
      if (script === launcher.scripts.URL) {
        if (chromeRestarted) throw new Error('tab no longer exists');
        if (options.noNavigation) return 'https://chatgpt.com/';
        if (activeUrl === 'https://chatgpt.com/') activeUrl = `https://chatgpt.com/c/unique-chat-${122 + chatOrdinal}`;
        return activeUrl;
      }
      const code = args[2];
      if (code === "'ready'") return 'ready';
      if (code.includes('return JSON.stringify({ready:')) return JSON.stringify({ ready: !options.noEditor, empty: true, attachments: options.staleAttachment ? 1 : 0, url: activeUrl });
      if (code.includes('window.__icBridgeUploads ||= ')) return 'ready';
      if (code.includes('b.push(')) return 'appended';
      if (code.includes('transfer.items.add(new File')) return options.uploadFailed ? 'failed' : 'attached';
      if (code.includes('const expected =')) return JSON.stringify({ complete: true, progress: 0 });
      if (code.includes("return 'cleared'")) return 'cleared';
      if (code.includes("document.execCommand('insertText'")) return options.insertMismatch ? 'mismatch' : 'match';
      if (code.includes('const models =')) return JSON.stringify({ model: selectedModel, topModel: 'GPT-6', topSelected: selectedModel === 'GPT-6', min: 0, max: options.maxPosition ?? 4, now: effortPosition, label: effortPosition === 4 ? 'Pro' : effortPosition === 3 ? 'Extra High' : 'High', sliderReady: true, locked: options.lockedPro === true && effortPosition === 4 });
      if (code.includes('const visible =')) return JSON.stringify({ blocked: options.upsellPro === true && effortPosition === 4 && !upsellDismissed });
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
      if (code.includes('const signedIn =')) return JSON.stringify({ signedIn: !options.unknownAccount });
      if (code.includes('const agent =')) return JSON.stringify({ reason: options.diagnosis || 'none', assistantPresent: true });
      if (code.includes("button[aria-label=\"Select ChatGPT model\"]")) return 'opened';
      if (code.includes("button[aria-label=\"Open profile menu\"]")) return 'opened';
      if (code.includes("button[aria-label=\"Send\"]")) return 'clicked';
      if (code.includes('empty:')) return JSON.stringify({ empty: true });
      throw new Error('unexpected fake command');
    },
  });
  return { launcher, calls, states, nextDay: () => { day += 1; }, enableAppleEvents: () => { appleEventsEnabled = true; }, restartChrome: () => { chromeRestarted = true; } };
}

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
  { name: 'chat launcher: application uses rightmost Pro effort, then falls back if unavailable', async run() {
    const first = harness();
    const pro = await first.launcher.launch({ owner: 'worker:1:1', starter, application: true });
    assert.equal(pro.ok, true);
    assert.equal(pro.observed.effortPosition, 4);
    assert.equal(pro.observed.fallback, false);
    const second = harness({ proUnavailable: true });
    const fallback = await second.launcher.launch({ owner: 'worker:1:1', starter, application: true });
    assert.equal(fallback.ok, true);
    assert.equal(fallback.observed.effortPosition, 3);
    assert.equal(fallback.observed.fallback, true);
  } },
  { name: 'chat launcher: locked or upsell Pro falls back for the local day', async run() {
    for (const option of ['lockedPro', 'upsellPro']) {
      const h = harness({ [option]: true });
      const first = await h.launcher.launch({ owner: 'worker:1:1', starter, application: true });
      assert.equal(first.ok, true);
      assert.equal(first.observed.effortPosition, 3);
      assert.equal(first.observed.fallback, true);
      const movesBefore = h.calls.filter(item => item.args?.[2]?.includes('const slider = document.querySelector')).length;
      const second = await h.launcher.launch({ owner: 'worker:1:2', starter, application: true });
      assert.equal(second.ok, true);
      assert.equal(second.observed.effortPosition, 3);
      assert.equal(h.calls.filter(item => item.args?.[2]?.includes('const slider = document.querySelector')).length, movesBefore);
      h.nextDay();
      const third = await h.launcher.launch({ owner: 'worker:1:3', starter, application: true });
      assert.equal(third.ok, true);
      assert.equal(third.observed.fallback, true);
      assert(h.calls.filter(item => item.args?.[2]?.includes('const slider = document.querySelector')).length > movesBefore);
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
    ['quiet', 'answer_silent', 'restartWorker'],
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
  { name: 'chat launcher: usage limit replaces an unpresented worker at the next effort', async run() {
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
      chatLauncher: { launch: async () => { launches++; return { ok: true }; }, close: async () => true,
        diagnose: async () => ({ reason: launches === 1 ? 'usage_limit' : 'none' }),
        markProUnavailable: () => calls.push('cap'), owns: () => true, observation: () => null },
      getCanvasWindows: () => [], launchPresentationTimeoutMs: 8, launchDiagnosisIntervalMs: 1,
    });
    ui.publishStatus(snapshot);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(launches, 2);
    assert(calls.includes('cap'));
    assert(calls.some(item => item?.failedLaunch === true));
    ui.dispose();
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
      chatLauncher: { launch: async () => ({ ok: true }), close: async () => true,
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
      chatLauncher: { launch: async () => { launches++; if (resolved) snapshot.chat.pool.workers[0].firstCallAt = Date.now(); return { ok: true }; },
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
    'plugin_missing', 'send_not_confirmed', 'safety_block',
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
        launch: async () => { launches += 1; return { ok: false, reason, sendAttempted: reason === 'send_not_confirmed' }; },
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
];
