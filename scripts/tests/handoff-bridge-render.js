import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assert } from './testHelpers.js';
import { bundleComponent } from './fixtures/handoff-bridge/mountComponent.js';
import { mountInStrictMode } from './fixtures/handoff-bridge/renderHarness.js';
import { withConsoleCollector } from './fixtures/handoff-bridge/renderHarness.js';
import { withDom } from './fixtures/handoff-bridge/mountComponent.js';
import { withTimeout } from './fixtures/handoff-bridge/harness.js';
import { __resetHandoffBridgeStoreForTests, applyHandoffBridgeStatus, getHandoffBridgeStatus } from '../../src/utils/handoffBridgeStore.js';
import { normalizeBridgeStatus } from '../../src/utils/handoffBridgeStatus.js';
import { deriveBridgeHealth } from '../../src/utils/handoffBridgeView.js';
import { __resetBridgeUiForTests } from '../../src/utils/handoffBridgeUiStore.js';

const NOW = 1_700_000_000_000;
const root = path.resolve('.');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');
function status(seq, extra = {}) { return { v: 1, seq, at: NOW, availability: { ok: true }, enabled: true, serving: 'live', setup: { hostnameOk: true, binaryApproved: true, credentialsOk: true, tunnelReachable: true, linked: true, toolsListed: true, firstCallSeen: true }, tunnel: { state: 'online', probe: { state: 'ok' } }, link: { state: 'linked' }, chat: { state: 'none' }, queue: { applications: {}, scoring: {} }, ...extra }; }

function sameDescriptor(first, second) {
  return ['configurable', 'enumerable', 'writable', 'value', 'get', 'set'].every(key => first?.[key] === second?.[key]);
}

export default [
  {
    name: 'handoff bridge: render: one bundled React mounts two hooks under StrictMode and restores navigator',
    async run() {
      const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ic-handoff-component-'));
      const entry = path.join(directory, 'TwoHookProbe.js');
      await fsPromises.writeFile(entry, "export function TwoHookProbe({ React }) { const [count] = React.useState(2); const ref = React.useRef('hooks'); return React.createElement('span', { 'data-ref': ref.current }, String(count)); }\n");
      const before = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
      const controller = new AbortController();
      let bundle;
      try {
        bundle = await withTimeout(bundleComponent(entry, { signal: controller.signal }), 5000);
        const html = await withTimeout(mountInStrictMode({
          React: bundle.module.React,
          createRoot: bundle.module.createRoot,
          act: bundle.module.act,
          Component: bundle.module.TwoHookProbe,
          props: { React: bundle.module.React },
        }), 5000);
        assert(html.includes('data-ref="hooks"') && html.includes('>2<'), 'the two-hook component must mount from the self-contained bundle');
        assert(sameDescriptor(before, Object.getOwnPropertyDescriptor(globalThis, 'navigator')), 'jsdom must restore the exact navigator descriptor');
      } finally {
        controller.abort();
        await bundle?.dispose();
        await fsPromises.rm(directory, { recursive: true, force: true });
      }
      assert(!bundle || !fs.existsSync(bundle.directory), 'bundle output must be removed after the test');
    },
  },
  {
    name: 'handoff bridge: render: real SettingsPanel graph bundles and mounts with import meta shims',
    async run() {
      const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ic-handoff-settings-'));
      const entry = path.join(directory, 'SettingsProbe.jsx');
      const settingsPanel = path.resolve('src/components/SettingsPanel.jsx');
      const toastProvider = path.resolve('src/components/ToastProvider.jsx');
      await fsPromises.writeFile(entry, `import React from 'react';\nimport { SettingsPanel } from ${JSON.stringify(settingsPanel)};\nimport { ToastProvider } from ${JSON.stringify(toastProvider)};\nexport function SettingsProbe() { return <ToastProvider><SettingsPanel isOpen={false} onClose={() => {}} settings={{}} updateSetting={() => {}} updateShortcut={() => {}} resetShortcuts={() => {}} /></ToastProvider>; }\n`);
      const controller = new AbortController();
      let bundle;
      try {
        bundle = await withTimeout(bundleComponent(entry, { signal: controller.signal }), 5000);
        const html = await withTimeout(mountInStrictMode({
          React: bundle.module.React,
          createRoot: bundle.module.createRoot,
          act: bundle.module.act,
          Component: bundle.module.SettingsProbe,
        }), 5000);
        assert(html.includes('id="root"'), 'the closed real SettingsPanel must mount without import.meta or hook errors');
      } finally {
        controller.abort();
        await bundle?.dispose();
        await fsPromises.rm(directory, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'handoff bridge: render: abort settles and restores MessageChannel and owned output',
    async run() {
      const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ic-handoff-failure-'));
      const entry = path.join(directory, 'FailureProbe.js');
      await fsPromises.writeFile(entry, 'export const FailureProbe = true;\n');
      const before = Object.getOwnPropertyDescriptor(globalThis, 'MessageChannel');
      const controller = new AbortController();
      let bundleDirectory = '';
      let markLoadStarted;
      const loadStarted = new Promise(resolve => { markLoadStarted = resolve; });
      let threw = false;
      try {
        const pending = bundleComponent(entry, {
          signal: controller.signal,
          onDirectory: value => { bundleDirectory = value; },
          loadModule: () => {
            markLoadStarted();
            return new Promise(() => undefined);
          },
        });
        await withTimeout(loadStarted, 5000);
        controller.abort();
        await withTimeout(pending, 5000);
      } catch (error) {
        threw = error.name === 'AbortError';
      } finally {
        controller.abort();
        await fsPromises.rm(directory, { recursive: true, force: true });
      }
      assert(threw, 'aborting a pending module load must settle with AbortError');
      assert(sameDescriptor(before, Object.getOwnPropertyDescriptor(globalThis, 'MessageChannel')), 'abort must restore the exact MessageChannel descriptor');
      assert(bundleDirectory && !fs.existsSync(bundleDirectory), 'abort must remove its owned bundle directory');
    },
  },
  {
    name: 'handoff bridge: render: persistent bridge root accepts forward and reverse state transitions',
    async run() {
      const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ic-handoff-matrix-'));
      const entry = path.join(directory, 'MatrixProbe.jsx'); const panel = path.resolve('src/components/HandoffBridgePanel.jsx'); const store = path.resolve('src/utils/handoffBridgeStore.js'); const uiStore = path.resolve('src/utils/handoffBridgeUiStore.js');
      await fsPromises.writeFile(entry, `import React from 'react';\nimport { HandoffBridgePanel } from ${JSON.stringify(panel)};\nexport { applyHandoffBridgeStatus, getHandoffBridgeStatus, __resetHandoffBridgeStoreForTests } from ${JSON.stringify(store)};\nexport { openBridgePopover, __resetBridgeUiForTests } from ${JSON.stringify(uiStore)};\nexport function MatrixProbe() { return <HandoffBridgePanel />; }\n`);
      const controller = new AbortController(); let bundle;
      const matrix = [
        status(1, { enabled: false }),
        status(2, { setup: { hostnameOk: false } }),
        status(3, { chat: { state: 'working' } }),
        status(4, { paused: true, pauseCause: 'user' }),
        status(5),
      ];
      try {
        bundle = await withTimeout(bundleComponent(entry, { signal: controller.signal }), 5000);
        await withDom(async window => withConsoleCollector(async entries => {
          window.electronAPI = { handoffBridgeGetStatus: async () => ({ status: matrix[0] }), onHandoffBridgeStatus: () => () => {}, handoffBridgeGetActivity: async () => ({ items: [] }), handoffBridgePublishJobs: () => undefined };
          bundle.module.__resetHandoffBridgeStoreForTests(); bundle.module.__resetBridgeUiForTests(); const rootNode = bundle.module.createRoot(window.document.getElementById('root'));
          await bundle.module.act(async () => { rootNode.render(bundle.module.React.createElement(bundle.module.MatrixProbe)); bundle.module.openBridgePopover(); });
          for (const item of matrix) await bundle.module.act(async () => bundle.module.applyHandoffBridgeStatus(item));
          assert(bundle.module.getHandoffBridgeStatus().seq === 5 && window.document.body.textContent.includes('Ready'), 'a mounted root must reach ready through forward transitions');
          for (const item of [...matrix].reverse().map((value, index) => ({ ...value, seq: 6 + index }))) await bundle.module.act(async () => bundle.module.applyHandoffBridgeStatus(item));
          assert(bundle.module.getHandoffBridgeStatus().seq === 10 && window.document.body.textContent.includes('Bridge off'), 'the same mounted root must render reverse transitions');
          await bundle.module.act(async () => rootNode.unmount()); assert(entries.length === 0, 'mounted transition matrix must emit no console output');
        }));
      } finally { controller.abort(); await bundle?.dispose(); await fsPromises.rm(directory, { recursive: true, force: true }); __resetHandoffBridgeStoreForTests(); }
    },
  },
  {
    name: 'handoff bridge: render: 300 snapshot render-state fuzz cases never throw or retain hostile keys',
    run() {
      __resetHandoffBridgeStoreForTests();
      let seed = 0x517a;
      const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
      for (let index = 1; index <= 300; index += 1) {
        const odd = index % 5 === 0 ? { v: 1, seq: index, availability: { ok: true }, enabled: true, tunnel: { state: next() % 2 ? 'online' : 'not-real' }, queue: { jobs: Array.from({ length: next() % 70 }, () => ({ jobId: String(next()), phase: next() % 2 ? 'awaiting' : 'unknown' })) }, leak: { label: 'Marisol Quenby', code: '555-0101' } } : [null, {}, { v: 9 }][next() % 3];
        const normalized = normalizeBridgeStatus(odd);
        const health = deriveBridgeHealth(normalized, NOW);
        assert(typeof health.id === 'string' && !Object.hasOwn(normalized, 'leak'), `snapshot ${index} must remain display-safe`);
        applyHandoffBridgeStatus(odd);
      }
      assert(getHandoffBridgeStatus().seq <= 300, 'fuzz snapshots must preserve monotonic store sequencing');
      __resetHandoffBridgeStoreForTests();
    },
  },
  {
    name: 'handoff bridge: render: source wiring is guarded, accessible and uses only the frozen renderer IPC surface',
    run() {
      const app = source('src/App.jsx'); const settings = source('src/components/SettingsPanel.jsx'); const sidebar = source('src/components/Sidebar.jsx'); const panel = source('src/components/HandoffBridgePanel.jsx'); const dialog = source('src/components/HandoffBridgeSetupDialog.jsx'); const trigger = source('src/components/HandoffBridgeTrigger.jsx');
      assert(app.includes('<HandoffBridgeGuard label="panel">') && app.indexOf('<HandoffBridgePanel') > app.indexOf('<NonApiAiDialog'), 'App must mount the guarded panel after the non-API dialog');
      assert(settings.includes('<HandoffBridgeGuard label="settings">') && settings.includes('<HandoffBridgeSetup'), 'Settings must mount its guarded bridge section');
      assert(sidebar.includes('<HandoffBridgeTrigger />'), 'Sidebar must mount the bridge trigger');
      assert(app.indexOf('<HandoffBridgeSetupDialog') > app.indexOf('<HandoffBridgePanel') && !panel.includes('<HandoffBridgeSetupDialog'), 'App must own setup independently so Settings survives a panel boundary failure');
      for (const text of [panel, dialog]) assert(!text.includes('dangerouslySetInnerHTML'), 'bridge surfaces must not inject HTML');
      assert(!dialog.includes('handoffBridgeCopyServerUrl'), 'Copy server URL must use an existing IPC channel or a non-secret renderer clipboard helper');
      assert(!dialog.includes('openExternalFailureMessage') && dialog.includes('externalLinkFailure'), 'bridge-visible external-link failures must use bridge copy');
      assert(trigger.includes("health.badge > 9 ? '9+'"), 'the trigger badge must cap visibly at 9+');
      assert(!panel.includes('now || Date.now()'), 'new-chat confirmation must use state time, never a wall-clock fallback');
      assert(!dialog.includes('${BRIDGE_SETUP_COPY.stepComplete}') && !dialog.includes('${BRIDGE_SETUP_COPY.stepPending}'), 'setup progress must use icons or CSS, not visible glyph text');
      assert(dialog.includes('LINK_WOULD_BREAK') && dialog.includes('confirmBreak'), 'hostname changes that would break a link must offer an explicit confirm-and-retry flow');
      for (const count of ['getServed', 'submitAccepted', 'submitRejected', 'submitDuplicate', 'submitJunk', 'stallNotices', 'tunnelRestarts']) assert(panel.includes(`status.counts.${count}`), `panel counts must include ${count}`);
      for (const method of ['handoffBridgeSetEnabled', 'handoffBridgeSaveConfig', 'handoffBridgeChooseBinary', 'handoffBridgeApproveBinary', 'handoffBridgeChooseCredentials', 'handoffBridgeRestartTunnel', 'handoffBridgeGetTunnelLog', 'handoffBridgeOpenPairing', 'handoffBridgeCancelPairing', 'handoffBridgeNewChat']) assert(panel.includes(method) || dialog.includes(method), `renderer IPC method ${method} must be reachable through an accessible control`);
    },
  },
  {
    name: 'handoff bridge: render: all three guarded surfaces mount empty against an older preload',
    async run() {
      const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ic-handoff-preload-'));
      const entry = path.join(directory, 'NoPreloadProbe.jsx');
      const panel = path.resolve('src/components/HandoffBridgePanel.jsx'); const setup = path.resolve('src/components/HandoffBridgeSetup.jsx'); const dialog = path.resolve('src/components/HandoffBridgeSetupDialog.jsx'); const trigger = path.resolve('src/components/HandoffBridgeTrigger.jsx'); const sidebar = path.resolve('src/components/Sidebar.jsx');
      await fsPromises.writeFile(entry, `import React from 'react';\nimport { HandoffBridgePanel } from ${JSON.stringify(panel)};\nimport { HandoffBridgeSetup } from ${JSON.stringify(setup)};\nimport { HandoffBridgeSetupDialog } from ${JSON.stringify(dialog)};\nimport { HandoffBridgeTrigger } from ${JSON.stringify(trigger)};\nimport { Sidebar } from ${JSON.stringify(sidebar)};\nexport function NoPreloadProbe() { return <><HandoffBridgePanel /><HandoffBridgeSetup /><HandoffBridgeSetupDialog /><HandoffBridgeTrigger /><Sidebar onReportBugClick={() => {}} /></>; }\n`);
      const controller = new AbortController(); let bundle;
      try {
        bundle = await withTimeout(bundleComponent(entry, { signal: controller.signal }), 5000);
        const html = await withTimeout(mountInStrictMode({ React: bundle.module.React, createRoot: bundle.module.createRoot, act: bundle.module.act, Component: bundle.module.NoPreloadProbe }), 5000);
        assert(!html.includes('ChatGPT bridge') && !html.includes('Set up ChatGPT bridge'), 'all guarded surfaces must render nothing without bridge preload keys');
      } finally { controller.abort(); await bundle?.dispose(); await fsPromises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'handoff bridge: render: strict-mode interaction cleanup and keep-awake note are real DOM behaviour',
    async run() {
      const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ic-handoff-interaction-'));
      const entry = path.join(directory, 'InteractionProbe.jsx'); const panel = path.resolve('src/components/HandoffBridgePanel.jsx'); const setup = path.resolve('src/components/HandoffBridgeSetup.jsx'); const store = path.resolve('src/utils/handoffBridgeStore.js'); const uiStore = path.resolve('src/utils/handoffBridgeUiStore.js');
      await fsPromises.writeFile(entry, `import React from 'react';\nimport { HandoffBridgePanel } from ${JSON.stringify(panel)};\nimport { HandoffBridgeSetup } from ${JSON.stringify(setup)};\nexport { applyHandoffBridgeStatus } from ${JSON.stringify(store)};\nexport { openBridgePopover } from ${JSON.stringify(uiStore)};\nexport function InteractionProbe() { return <><HandoffBridgePanel /><HandoffBridgeSetup /></>; }\n`);
      const controller = new AbortController(); let bundle; __resetHandoffBridgeStoreForTests(); __resetBridgeUiForTests();
      try {
        bundle = await withTimeout(bundleComponent(entry, { signal: controller.signal }), 5000);
        await withDom(async window => withConsoleCollector(async entries => {
          const calls = []; const listeners = []; const domAdds = []; const domRemoves = []; let resolvePause; let resolveActivity;
          const windowAdd = window.addEventListener.bind(window); const windowRemove = window.removeEventListener.bind(window); const documentAdd = window.document.addEventListener.bind(window.document); const documentRemove = window.document.removeEventListener.bind(window.document);
          window.addEventListener = (type, listener, options) => { domAdds.push(`window:${type}`); return windowAdd(type, listener, options); }; window.removeEventListener = (type, listener, options) => { domRemoves.push(`window:${type}`); return windowRemove(type, listener, options); }; window.document.addEventListener = (type, listener, options) => { domAdds.push(`document:${type}`); return documentAdd(type, listener, options); }; window.document.removeEventListener = (type, listener, options) => { domRemoves.push(`document:${type}`); return documentRemove(type, listener, options); };
          window.electronAPI = { handoffBridgeGetStatus: async () => ({ status: status(1) }), onHandoffBridgeStatus: listener => { listeners.push(listener); return () => listeners.splice(listeners.indexOf(listener), 1); }, handoffBridgeGetActivity: () => new Promise(resolve => { resolveActivity = resolve; }), handoffBridgePause: () => new Promise(resolve => { resolvePause = resolve; }), handoffBridgePublishJobs: payload => calls.push(payload) };
          const rootNode = bundle.module.createRoot(window.document.getElementById('root'), { onCaughtError: () => undefined });
          await bundle.module.act(async () => { rootNode.render(bundle.module.React.createElement(bundle.module.React.StrictMode, null, bundle.module.React.createElement(bundle.module.InteractionProbe))); await Promise.resolve(); await Promise.resolve(); });
          await bundle.module.act(async () => { bundle.module.applyHandoffBridgeStatus(status(2)); bundle.module.openBridgePopover(); });
          assert(window.document.body.textContent.includes('may sleep') || window.document.body.textContent.includes('asks macOS not to put your Mac to sleep'), 'panel and settings must expose one keep-awake note');
          const buttons = [...window.document.querySelectorAll('button')]; assert(buttons.every(button => button.getAttribute('aria-label') || button.textContent.trim()), 'every interactive button must have an accessible name');
          const pause = buttons.find(button => button.textContent.includes('Pause')); assert(pause, 'open panel must expose a Pause action'); await bundle.module.act(async () => { pause.click(); });
          await bundle.module.act(async () => rootNode.unmount());
          resolvePause?.({ success: true }); resolveActivity?.({ items: [] }); await Promise.resolve(); await Promise.resolve();
          assert(listeners.length === 0, 'StrictMode unmount must release bridge listeners'); assert(domRemoves.filter(item => item === 'window:keydown').length >= 1 && domRemoves.filter(item => item === 'document:pointerdown').length >= 1, `StrictMode must remove popover DOM listeners (${JSON.stringify({ domAdds, domRemoves })})`); assert(entries.length === 0, `render must emit no console warning or error: ${entries.map(entry => entry.args.join(' ')).join(' | ')}`); assert(calls.every(payload => payload.jobs.every(job => !Object.hasOwn(job, 'label'))), 'publisher payloads must never carry labels');
        }));
      } finally { __resetHandoffBridgeStoreForTests(); __resetBridgeUiForTests(); controller.abort(); await bundle?.dispose(); await fsPromises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'handoff bridge: render: a bridge boundary isolates a failed child and recovers on a newer status sequence',
    async run() {
      const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ic-handoff-boundary-'));
      const entry = path.join(directory, 'BoundaryProbe.jsx'); const boundary = path.resolve('src/components/HandoffBridgeBoundary.jsx');
      await fsPromises.writeFile(entry, `import React from 'react';\nimport { HandoffBridgeBoundary } from ${JSON.stringify(boundary)};\nexport function BoundaryProbe({ boom, seq }) { const Bad = () => { if (boom) throw new Error('synthetic'); return <span data-recovered="yes">Recovered</span>; }; return <><HandoffBridgeBoundary resetKey={seq} label="panel"><Bad /></HandoffBridgeBoundary><span data-sibling="yes">Sibling remains</span></>; }\n`);
      const controller = new AbortController(); let bundle;
      try {
        bundle = await withTimeout(bundleComponent(entry, { signal: controller.signal }), 5000);
        await withDom(async window => withConsoleCollector(async entries => {
          const rootNode = bundle.module.createRoot(window.document.getElementById('root'), { onCaughtError: () => undefined });
          await bundle.module.act(async () => rootNode.render(bundle.module.React.createElement(bundle.module.BoundaryProbe, { boom: true, seq: 1 })));
          assert(window.document.body.textContent.includes('Sibling remains'), 'a failed bridge child must not unmount its healthy sibling');
          await bundle.module.act(async () => rootNode.render(bundle.module.React.createElement(bundle.module.BoundaryProbe, { boom: false, seq: 2 })));
          assert(window.document.querySelector('[data-recovered="yes"]'), 'a newer bridge status sequence must reset and recover the boundary');
          await bundle.module.act(async () => rootNode.unmount());
          assert(entries.length === 0, 'boundary recovery must not emit console warnings or errors');
        }));
      } finally { controller.abort(); await bundle?.dispose(); await fsPromises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'handoff bridge: render: mounted persistent UI survives 300 hostile status transitions',
    async run() {
      const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ic-handoff-mounted-fuzz-'));
      const entry = path.join(directory, 'MountedFuzzProbe.jsx'); const panel = path.resolve('src/components/HandoffBridgePanel.jsx'); const setup = path.resolve('src/components/HandoffBridgeSetup.jsx'); const store = path.resolve('src/utils/handoffBridgeStore.js'); const uiStore = path.resolve('src/utils/handoffBridgeUiStore.js');
      await fsPromises.writeFile(entry, `import React from 'react';\nimport { HandoffBridgePanel } from ${JSON.stringify(panel)};\nimport { HandoffBridgeSetup } from ${JSON.stringify(setup)};\nexport { applyHandoffBridgeStatus, __resetHandoffBridgeStoreForTests } from ${JSON.stringify(store)};\nexport { openBridgePopover, __resetBridgeUiForTests } from ${JSON.stringify(uiStore)};\nexport function MountedFuzzProbe() { return <><HandoffBridgePanel /><HandoffBridgeSetup /></>; }\n`);
      const controller = new AbortController(); let bundle;
      try {
        bundle = await withTimeout(bundleComponent(entry, { signal: controller.signal }), 5000);
        await withDom(async window => withConsoleCollector(async entries => {
          const listeners = []; window.electronAPI = { handoffBridgeGetStatus: async () => ({ status: status(1) }), onHandoffBridgeStatus: listener => { listeners.push(listener); return () => listeners.splice(listeners.indexOf(listener), 1); }, handoffBridgeGetActivity: async () => ({ items: [] }), handoffBridgePublishJobs: () => undefined };
          const rootNode = bundle.module.createRoot(window.document.getElementById('root'));
          await bundle.module.act(async () => { rootNode.render(bundle.module.React.createElement(bundle.module.React.StrictMode, null, bundle.module.React.createElement(bundle.module.MountedFuzzProbe))); bundle.module.openBridgePopover(); });
          for (let sequence = 1; sequence <= 300; sequence += 1) {
            const hostile = sequence % 3 === 0 ? { v: 1, seq: sequence, availability: { ok: true }, enabled: true, setup: { hostnameOk: true, binaryApproved: true, credentialsOk: true, linked: true }, tunnel: { state: sequence % 2 ? 'online' : 'hostile-state', binary: { path: '/Users/ada/secret' } }, link: { state: 'linked' }, chat: { state: 'working', outstanding: { stage: sequence % 2 ? 'resume' : 'hostile text', task: 'job-scoring' } }, queue: { applications: { ready: sequence % 4 }, jobs: [{ jobId: 'not-a-uuid', phase: 'awaiting' }] }, leak: { label: 'Marisol Quenby', code: '555-0101' } } : status(sequence, { power: { keepAwake: sequence % 2 === 0 } });
            await bundle.module.act(async () => { bundle.module.applyHandoffBridgeStatus(hostile); });
          }
          assert(!window.document.body.textContent.includes('Marisol Quenby') && !window.document.body.textContent.includes('555-0101'), 'mounted renderer fuzz must not render hostile snapshot fields');
          await bundle.module.act(async () => rootNode.unmount());
          assert(listeners.length === 0 && entries.length === 0, 'mounted fuzz must balance listeners and emit no console output');
        }));
      } finally { controller.abort(); await bundle?.dispose(); await fsPromises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'handoff bridge: render: each keep-awake value renders exactly one note in both bridge surfaces',
    async run() {
      const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ic-handoff-awake-'));
      const entry = path.join(directory, 'AwakeProbe.jsx'); const panel = path.resolve('src/components/HandoffBridgePanel.jsx'); const setup = path.resolve('src/components/HandoffBridgeSetup.jsx'); const store = path.resolve('src/utils/handoffBridgeStore.js'); const uiStore = path.resolve('src/utils/handoffBridgeUiStore.js');
      await fsPromises.writeFile(entry, `import React from 'react';\nimport { HandoffBridgePanel } from ${JSON.stringify(panel)};\nimport { HandoffBridgeSetup } from ${JSON.stringify(setup)};\nexport { applyHandoffBridgeStatus, __resetHandoffBridgeStoreForTests } from ${JSON.stringify(store)};\nexport { openBridgePopover, __resetBridgeUiForTests } from ${JSON.stringify(uiStore)};\nexport function AwakeProbe() { return <><HandoffBridgePanel /><HandoffBridgeSetup /></>; }\n`);
      const controller = new AbortController(); let bundle;
      try {
        bundle = await withTimeout(bundleComponent(entry, { signal: controller.signal }), 5000);
        for (const keepAwake of [false, true]) await withDom(async window => withConsoleCollector(async entries => {
          window.electronAPI = { handoffBridgeGetStatus: async () => ({ status: status(1, { power: { keepAwake } }) }), onHandoffBridgeStatus: () => () => {}, handoffBridgeGetActivity: async () => ({ items: [] }), handoffBridgePublishJobs: () => undefined };
          bundle.module.__resetHandoffBridgeStoreForTests(); bundle.module.__resetBridgeUiForTests(); const rootNode = bundle.module.createRoot(window.document.getElementById('root'));
          await bundle.module.act(async () => { rootNode.render(bundle.module.React.createElement(bundle.module.AwakeProbe)); bundle.module.applyHandoffBridgeStatus(status(2, { power: { keepAwake } })); bundle.module.openBridgePopover(); });
          const selected = keepAwake ? 'asks macOS not to put your Mac to sleep' : 'Your Mac may sleep'; const other = keepAwake ? 'Your Mac may sleep' : 'asks macOS not to put your Mac to sleep'; const text = window.document.body.textContent;
          assert(text.split(selected).length - 1 === 2 && !text.includes(other), 'the selected keep-awake sentence must appear once in panel and once in Settings only');
          await bundle.module.act(async () => rootNode.unmount()); assert(entries.length === 0, 'keep-awake render must have no console output');
        }));
      } finally { controller.abort(); await bundle?.dispose(); await fsPromises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'handoff bridge: render: open real SettingsPanel mounts the guarded bridge section',
    async run() {
      const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ic-handoff-settings-open-'));
      const entry = path.join(directory, 'SettingsOpenProbe.jsx'); const settings = path.resolve('src/components/SettingsPanel.jsx'); const toast = path.resolve('src/components/ToastProvider.jsx'); const store = path.resolve('src/utils/handoffBridgeStore.js');
      await fsPromises.writeFile(entry, `import React from 'react';\nimport { SettingsPanel } from ${JSON.stringify(settings)};\nimport { ToastProvider } from ${JSON.stringify(toast)};\nexport { applyHandoffBridgeStatus, __resetHandoffBridgeStoreForTests } from ${JSON.stringify(store)};\nexport function SettingsOpenProbe() { return <ToastProvider><SettingsPanel isOpen={true} onClose={() => {}} settings={{}} updateSetting={() => {}} updateShortcut={() => {}} resetShortcuts={() => {}} /></ToastProvider>; }\n`);
      const controller = new AbortController(); let bundle;
      try {
        bundle = await withTimeout(bundleComponent(entry, { signal: controller.signal }), 5000);
        await withDom(async window => withConsoleCollector(async entries => {
          const priorCustomEvent = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent');
          Object.defineProperty(globalThis, 'CustomEvent', { configurable: true, writable: true, value: window.CustomEvent });
          window.electronAPI = {
            handoffBridgeGetStatus: async () => ({ status: status(1) }), onHandoffBridgeStatus: () => () => {}, handoffBridgePublishJobs: () => undefined,
            getSettings: async () => ({ jobs: {}, marketplaceWatchUrls: {} }), checkJobPlatformAuth: async () => ({ connected: false }), checkSellMonitorAuth: async () => ({ connected: false }), updateSettings: async () => ({ success: true }),
          };
          try {
            bundle.module.__resetHandoffBridgeStoreForTests(); const rootNode = bundle.module.createRoot(window.document.getElementById('root'));
            await bundle.module.act(async () => { rootNode.render(bundle.module.React.createElement(bundle.module.SettingsOpenProbe)); bundle.module.applyHandoffBridgeStatus(status(2)); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
            assert(window.document.body.textContent.includes('Marketplace Monitors') && window.document.body.textContent.includes('ChatGPT bridge'), 'the open real SettingsPanel must render the bridge section after Marketplace Monitors');
            await bundle.module.act(async () => rootNode.unmount()); assert(entries.length === 0, 'open real SettingsPanel must emit no console output');
          } finally { if (priorCustomEvent) Object.defineProperty(globalThis, 'CustomEvent', priorCustomEvent); else delete globalThis.CustomEvent; }
        }));
      } finally { controller.abort(); await bundle?.dispose(); await fsPromises.rm(directory, { recursive: true, force: true }); __resetHandoffBridgeStoreForTests(); }
    },
  },
];
