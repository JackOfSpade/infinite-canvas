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
import { EMPTY_BRIDGE_STATUS, normalizeBridgeStatus } from '../../src/utils/handoffBridgeStatus.js';
import { deriveBridgeHealth } from '../../src/utils/handoffBridgeView.js';
import { __resetBridgeUiForTests } from '../../src/utils/handoffBridgeUiStore.js';
import { IPC_ERROR_COPY } from '../../src/utils/handoffBridgeCopy.js';

const NOW = 1_700_000_000_000;
const root = path.resolve('.');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');
function status(seq, extra = {}) {
  const merge = (target, patch) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const prior = target[key] && typeof target[key] === 'object' && !Array.isArray(target[key]) ? target[key] : {};
        target[key] = merge({ ...prior }, value);
      } else target[key] = value;
    }
    return target;
  };
  const base = JSON.parse(JSON.stringify(EMPTY_BRIDGE_STATUS));
  Object.assign(base, { v: 1, seq, at: NOW, enabled: true, autoStart: false, autoRelease: false, serving: 'live', paused: false }); base.availability = { ...base.availability, ok: true };
  Object.assign(base.config, { hostname: null, pluginName: 'Infinite Canvas', mcpUrl: null, telemetryInBugReports: false }); base.config.scope = { ...base.config.scope, applications: true, scoring: false };
  Object.assign(base.setup, { hostnameOk: true, binaryApproved: true, credentialsOk: true, tunnelReachable: true, linked: true, toolsListed: true, firstCallSeen: true });
  Object.assign(base.tunnel, { state: 'up' }); base.tunnel.probe = { ...base.tunnel.probe, state: 'ok' }; Object.assign(base.link, { state: 'linked' }); Object.assign(base.chat, { state: 'none' }); base.windows.canvasOpen = true;
  return merge(base, extra);
}

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
        const odd = index % 5 === 0 ? { v: 1, seq: index, availability: { ok: true }, enabled: true, tunnel: { state: next() % 2 ? 'up' : 'not-real' }, queue: { jobs: Array.from({ length: next() % 70 }, () => ({ jobId: String(next()), phase: next() % 2 ? 'awaiting' : 'unknown' })) }, leak: { label: 'Marisol Quenby', code: '555-0101' } } : [null, {}, { v: 9 }][next() % 3];
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
      const app = source('src/App.jsx'); const settings = source('src/components/SettingsPanel.jsx'); const setup = source('src/components/HandoffBridgeSetup.jsx'); const sidebar = source('src/components/Sidebar.jsx'); const panel = source('src/components/HandoffBridgePanel.jsx'); const dialog = source('src/components/HandoffBridgeSetupDialog.jsx'); const confirmDialog = source('src/components/ConfirmDialog.jsx'); const trigger = source('src/components/HandoffBridgeTrigger.jsx'); const styles = source('src/index.css');
      assert(app.includes('<HandoffBridgeGuard label="panel">') && app.indexOf('<HandoffBridgePanel') > app.indexOf('<NonApiAiDialog'), 'App must mount the guarded panel after the non-API dialog');
      assert(settings.includes('<HandoffBridgeGuard label="settings">') && settings.includes('<HandoffBridgeSetup'), 'Settings must mount its guarded bridge section');
      assert(sidebar.includes('<HandoffBridgeTrigger />'), 'Sidebar must mount the bridge trigger');
      assert(app.indexOf('<HandoffBridgeSetupDialog') > app.indexOf('<HandoffBridgePanel') && !panel.includes('<HandoffBridgeSetupDialog'), 'App must own setup independently so Settings survives a panel boundary failure');
      for (const text of [panel, dialog]) assert(!text.includes('dangerouslySetInnerHTML'), 'bridge surfaces must not inject HTML');
      assert(!dialog.includes('handoffBridgeCopyServerUrl'), 'Copy server URL must use an existing IPC channel or a non-secret renderer clipboard helper');
      assert(!dialog.includes('openExternalFailureMessage') && dialog.includes('externalLinkFailure'), 'bridge-visible external-link failures must use bridge copy');
      assert(dialog.includes('LINK_PROGRESS_KEYS') && !dialog.includes('Object.values(status.link.progress)'), 'link-progress rows must use their explicit status keys, never object enumeration order');
      assert(dialog.includes('role="dialog"') && dialog.includes('aria-modal="true"') && dialog.includes('onKeyDown={trapFocus}'), 'setup must retain labelled modal semantics and a local focus trap');
      assert(!dialog.includes('status.seq'), 'setup inputs must not remount and discard a draft when status refreshes');
      assert(dialog.includes('canAccessStep') && dialog.includes('disabled={!canAdvance}'), 'setup navigation must keep prerequisite steps inaccessible');
      assert(dialog.includes('w-[min(560px,calc(100vw-2rem))]') && dialog.includes('max-h-[85vh]'), 'setup must retain narrow-viewport width and height limits');
      assert(confirmDialog.includes('role="dialog"') && confirmDialog.includes('aria-modal="true"') && confirmDialog.includes('onKeyDown={trapFocus}') && confirmDialog.includes('max-w-full'), 'nested bridge confirmations must retain accessible, narrow-viewport modal behavior');
      assert(settings.includes('max-w-[calc(100vw-2rem)]') && settings.includes('min-w-0') && !settings.includes('overflow-x-hidden'), 'Settings must remain inside a narrow viewport without clipping other Settings content');
      assert(setup.includes('flex-wrap') && setup.includes('min-w-0') && setup.includes('bridge-button-danger'), 'bridge Settings controls must wrap long labels and actions instead of overflowing');
      assert(panel.includes('max-w-[calc(100vw-2rem)]') && panel.includes('left-3') && panel.includes('sm:left-14'), 'bridge popover must remain within a narrow viewport');
      for (const className of ['bridge-button-primary', 'bridge-button-secondary', 'bridge-button-danger']) assert(new RegExp(`\\.${className}(?:,|\\s*\\{)`).test(styles), `${className} must have a shared CSS definition`);
      for (const rule of ['display: inline-flex', 'max-width: 100%', 'min-height: 2.25rem', 'overflow-wrap: anywhere', ':disabled']) assert(styles.includes(rule), `bridge buttons must retain the compact responsive rule ${rule}`);
      assert(trigger.includes("health.badge > 9 ? '9+'"), 'the trigger badge must cap visibly at 9+');
      assert(!panel.includes('now || Date.now()'), 'new-chat confirmation must use state time, never a wall-clock fallback');
      assert(!dialog.includes('${BRIDGE_SETUP_COPY.stepComplete}') && !dialog.includes('${BRIDGE_SETUP_COPY.stepPending}'), 'setup progress must use icons or CSS, not visible glyph text');
      assert(dialog.includes('LINK_WOULD_BREAK') && dialog.includes('confirmBreak'), 'hostname changes that would break a link must offer an explicit confirm-and-retry flow');
      for (const count of ['getServed', 'submitAccepted', 'submitRejected', 'submitDuplicate', 'submitJunk', 'stallNotices', 'tunnelRestarts']) assert(panel.includes(`status.counts.${count}`), `panel counts must include ${count}`);
      for (const method of ['handoffBridgeSetEnabled', 'handoffBridgeSaveConfig', 'handoffBridgeChooseBinary', 'handoffBridgeApproveBinary', 'handoffBridgeChooseCredentials', 'handoffBridgeRestartTunnel', 'handoffBridgeGetTunnelLog', 'handoffBridgeOpenPairing', 'handoffBridgeCancelPairing', 'handoffBridgeNewChat']) assert(panel.includes(method) || dialog.includes(method), `renderer IPC method ${method} must be reachable through an accessible control`);
    },
  },
  {
    name: 'handoff bridge: render: setup dialog retains drafts, gates steps and traps focus',
    async run() {
      const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ic-handoff-setup-dialog-'));
      const entry = path.join(directory, 'SetupDialogProbe.jsx');
      const dialog = path.resolve('src/components/HandoffBridgeSetupDialog.jsx'); const store = path.resolve('src/utils/handoffBridgeStore.js'); const uiStore = path.resolve('src/utils/handoffBridgeUiStore.js');
      await fsPromises.writeFile(entry, `import React from 'react';\nimport { HandoffBridgeSetupDialog } from ${JSON.stringify(dialog)};\nexport { applyHandoffBridgeStatus, __resetHandoffBridgeStoreForTests } from ${JSON.stringify(store)};\nexport { openBridgeSetup, __resetBridgeUiForTests } from ${JSON.stringify(uiStore)};\nexport function SetupDialogProbe() { return <HandoffBridgeSetupDialog />; }\n`);
      const controller = new AbortController(); let bundle;
      try {
        bundle = await withTimeout(bundleComponent(entry, { signal: controller.signal }), 5000);
        await withDom(async window => withConsoleCollector(async entries => {
          const priorRects = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'getClientRects');
          const priorCustomEvent = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent');
          Object.defineProperty(window.HTMLElement.prototype, 'getClientRects', { configurable: true, value: () => [{ width: 1, height: 1 }] });
          Object.defineProperty(globalThis, 'CustomEvent', { configurable: true, writable: true, value: window.CustomEvent });
          let rootNode;
          try {
            const enableCalls = [];
            const enableResults = [{ success: false, code: 'INTERNAL' }, { success: true }];
            const setupCalls = [];
            window.electronAPI = {
              handoffBridgeGetStatus: async () => ({ status: status(1) }),
              onHandoffBridgeStatus: () => () => {},
              handoffBridgeChooseBinary: async () => { setupCalls.push('binary'); return { success: true }; },
              handoffBridgeApproveBinary: async () => { setupCalls.push('approve'); return { success: true }; },
              handoffBridgeChooseCredentials: async () => { setupCalls.push('credentials'); return { success: true }; },
              handoffBridgeSetEnabled: async ({ enabled }) => {
                enableCalls.push(enabled);
                return enableResults.shift() || { success: false, code: 'INTERNAL' };
              },
            };
            bundle.module.__resetHandoffBridgeStoreForTests(); bundle.module.__resetBridgeUiForTests();
            rootNode = bundle.module.createRoot(window.document.getElementById('root'));
            const incomplete = status(1, { setup: { hostnameOk: true, binaryApproved: true, credentialsOk: true, tunnelReachable: false, linked: true, toolsListed: false, firstCallSeen: false } });
            await bundle.module.act(async () => { rootNode.render(bundle.module.React.createElement(bundle.module.SetupDialogProbe)); bundle.module.applyHandoffBridgeStatus(incomplete); bundle.module.openBridgeSetup(4); });
            const lockedDialog = window.document.querySelector('[role="dialog"]');
            assert(lockedDialog?.getAttribute('aria-modal') === 'true' && window.document.activeElement === lockedDialog, 'setup must focus its labelled modal when opened');
            assert(lockedDialog.textContent.includes('Tunnel'), 'a direct request for First chat must stop at Tunnel when a previously linked bridge is unreachable');
            assert(lockedDialog.textContent.includes('The bridge is starting. Wait for the tunnel to be online before continuing.'), 'an enabled bridge that is not reachable must state that it is waiting for the tunnel');
            const lockedSteps = [...lockedDialog.querySelectorAll('button[aria-label^="Go to"]')];
            assert(lockedSteps.slice(2).every(button => button.disabled), 'plugin and first-chat progress controls must stay disabled before their prerequisites');
            assert([...lockedDialog.querySelectorAll('button')].find(button => button.textContent.includes('Next'))?.disabled, 'Next must be disabled while tunnel setup is incomplete');

            const bootstrapSelection = status(2, {
              enabled: false,
              serving: 'off',
              setup: { hostnameOk: true, binaryApproved: false, credentialsOk: false, tunnelReachable: false, linked: false, toolsListed: false, firstCallSeen: false },
              tunnel: { state: 'off', binary: null, probe: { state: 'off' } },
              link: { state: 'unlinked' },
            });
            await bundle.module.act(async () => { bundle.module.applyHandoffBridgeStatus(bootstrapSelection); bundle.module.openBridgeSetup(2); });
            const bootstrapDialog = window.document.querySelector('[role="dialog"]');
            const chooseBinary = [...bootstrapDialog.querySelectorAll('button')].find(button => button.textContent.includes('Choose cloudflared'));
            const approveBinary = [...bootstrapDialog.querySelectorAll('button')].find(button => button.textContent.includes('Approve cloudflared'));
            const chooseCredentials = [...bootstrapDialog.querySelectorAll('button')].find(button => button.textContent.includes('Choose credentials'));
            assert(chooseBinary && approveBinary && !approveBinary.disabled && chooseCredentials?.disabled,
              'a bootstrap status without presentation-only binary details must still permit main to authoritatively approve a chosen binary, while credentials await durable approval');
            assert(bootstrapDialog.textContent.includes('Tunnel program: Not selected')
              && !bootstrapDialog.textContent.includes('Tunnel program: Not selected · Needs approval'),
            'an absent binary must not be described as awaiting approval');
            await bundle.module.act(async () => { chooseBinary.click(); await Promise.resolve(); await Promise.resolve(); });
            assert(setupCalls[0] === 'binary' && !approveBinary.disabled,
              'a successful binary choice must leave Approve callable without inventing a renderer trusted state');
            const selectedBootstrap = status(3, {
              enabled: false,
              serving: 'off',
              setup: { hostnameOk: true, binaryApproved: false, credentialsOk: false, tunnelReachable: false, linked: false, toolsListed: false, firstCallSeen: false },
              tunnel: { state: 'off', binary: { approved: false }, probe: { state: 'off' } },
              link: { state: 'unlinked' },
            });
            await bundle.module.act(async () => { bundle.module.applyHandoffBridgeStatus(selectedBootstrap); await Promise.resolve(); await Promise.resolve(); });
            assert(bootstrapDialog.textContent.includes('Tunnel program: Selected · Needs approval')
              && bootstrapDialog.textContent.includes('Approve cloudflared before continuing.')
              && !bootstrapDialog.textContent.includes('Choose and approve cloudflared before continuing.'),
            'a redacted off-state binary selection must be visible and ask for approval without asking for reselection');
            await bundle.module.act(async () => { approveBinary.click(); await Promise.resolve(); await Promise.resolve(); });
            assert(setupCalls[1] === 'approve', 'Approve must delegate selection validation and native consent to main');
            const approvedBootstrap = status(4, {
              enabled: false,
              serving: 'off',
              setup: { hostnameOk: true, binaryApproved: true, credentialsOk: false, tunnelReachable: false, linked: false, toolsListed: false, firstCallSeen: false },
              tunnel: { state: 'off', binary: null, probe: { state: 'off' } },
              link: { state: 'unlinked' },
            });
            await bundle.module.act(async () => { bundle.module.applyHandoffBridgeStatus(approvedBootstrap); await Promise.resolve(); await Promise.resolve(); });
            assert(!chooseCredentials.disabled, 'durable binary approval must unlock credentials even when bootstrap cannot retain a presentation-only binary version');
            await bundle.module.act(async () => { chooseCredentials.click(); await Promise.resolve(); await Promise.resolve(); });
            assert(setupCalls[2] === 'credentials', 'the unlocked credentials action must reach its main-process authority');

            const redactedPath = '/Users/ada/Library/Application Support/bridge/tunnel.json';
            const redactedPin = 'a'.repeat(64);
            const redactedTunnelId = '123e4567-e89b-42d3-a456-426614174000';
            const offMissingAddress = status(5, {
              enabled: false,
              serving: 'off',
              setup: {
                hostnameOk: false, binaryApproved: true, credentialsOk: true,
                tunnelReachable: false, linked: false, toolsListed: false, firstCallSeen: false,
                binaryPath: redactedPath, pin: redactedPin, tunnelId: redactedTunnelId,
              },
              tunnel: {
                state: 'off', binary: null, probe: { state: 'off' },
                binaryPath: redactedPath, pin: redactedPin, credentialsPath: redactedPath, tunnelSecret: redactedTunnelId,
              },
              link: { state: 'unlinked' },
            });
            await bundle.module.act(async () => { bundle.module.applyHandoffBridgeStatus(offMissingAddress); bundle.module.openBridgeSetup(2); });
            const offMissingAddressDialog = window.document.querySelector('[role="dialog"]');
            assert(offMissingAddressDialog.textContent.includes('Tunnel program: Selected · Approved')
              && offMissingAddressDialog.textContent.includes('Credentials file: Selected')
              && offMissingAddressDialog.textContent.includes('Save the public address before continuing.')
              && !offMissingAddressDialog.textContent.includes('Choose and approve cloudflared before continuing.')
              && !offMissingAddressDialog.textContent.includes('Choose the credentials file before continuing.')
              && !offMissingAddressDialog.textContent.includes('Tunnel program: Not selected')
              && !offMissingAddressDialog.textContent.includes('Credentials file: Not selected')
              && !offMissingAddressDialog.textContent.includes(redactedPath)
              && !offMissingAddressDialog.textContent.includes(redactedPin)
              && !offMissingAddressDialog.textContent.includes(redactedTunnelId),
            'a redacted off-state must summarize saved setup without inventing missing selections or exposing setup secrets');

            const offReady = status(6, {
              enabled: false,
              serving: 'off',
              setup: { hostnameOk: true, binaryApproved: true, credentialsOk: true, tunnelReachable: false, linked: false, toolsListed: false, firstCallSeen: false },
              tunnel: { state: 'off', probe: { state: 'off' } },
              link: { state: 'unlinked' },
            });
            await bundle.module.act(async () => { bundle.module.applyHandoffBridgeStatus(offReady); bundle.module.openBridgeSetup(2); });
            const offReadyDialog = window.document.querySelector('[role="dialog"]');
            const enableBridge = [...offReadyDialog.querySelectorAll('button')].find(button => button.textContent.includes('Turn on bridge'));
            assert(enableBridge && !enableBridge.disabled && offReadyDialog.textContent.includes('Tunnel setup is saved. Turn on the bridge to start the tunnel.'), 'a saved off-state tunnel must expose the in-dialog enable action and explain why plugin setup is locked');
            await bundle.module.act(async () => { enableBridge.click(); await Promise.resolve(); await Promise.resolve(); });
            assert(enableCalls.length === 1 && enableCalls[0] === true && !enableBridge.disabled, 'a failed enable must remain non-optimistic, retain the saved off-state and allow a retry');
            assert(offReadyDialog.textContent.includes('Something went wrong in the bridge. Try again; if it repeats, copy a bug report.'), 'an in-dialog enable failure must show only fixed feedback');
            await bundle.module.act(async () => { enableBridge.click(); await Promise.resolve(); await Promise.resolve(); });
            assert(enableCalls.length === 2 && enableBridge.disabled && enableBridge.textContent.includes('Turning on bridge'), 'a successful enable request must show a bounded pending state until main publishes status');
            const starting = status(7, {
              enabled: true,
              serving: 'starting',
              setup: { hostnameOk: true, binaryApproved: true, credentialsOk: true, tunnelReachable: false, linked: false, toolsListed: false, firstCallSeen: false },
              tunnel: { state: 'starting', probe: { state: 'checking' } },
              link: { state: 'unlinked' },
            });
            await bundle.module.act(async () => { bundle.module.applyHandoffBridgeStatus(starting); await Promise.resolve(); await Promise.resolve(); });
            assert(!offReadyDialog.textContent.includes('Something went wrong in the bridge. Try again; if it repeats, copy a bug report.') && offReadyDialog.textContent.includes('The bridge is starting. Wait for the tunnel to be online before continuing.'), 'a newer main status must clear prior enable feedback and state the live tunnel wait');
            await bundle.module.act(async () => { bundle.module.applyHandoffBridgeStatus(status(8)); await Promise.resolve(); await Promise.resolve(); });
            assert(![...offReadyDialog.querySelectorAll('button[aria-label^="Go to"]')][2].disabled && ![...offReadyDialog.querySelectorAll('button')].find(button => button.textContent.includes('Next'))?.disabled, 'the online status refresh must unlock Plugin and link without remounting setup');

            await bundle.module.act(async () => { bundle.module.applyHandoffBridgeStatus(status(9)); bundle.module.openBridgeSetup(2); });
            const liveDialog = window.document.querySelector('[role="dialog"]');
            const hostname = liveDialog.querySelector('input[aria-label="Public address"]');
            hostname.value = 'draft.example.com';
            hostname.dispatchEvent(new window.Event('input', { bubbles: true }));
            await bundle.module.act(async () => { bundle.module.applyHandoffBridgeStatus(status(10, { config: { hostname: 'saved.example.com' } })); });
            assert(hostname.value === 'draft.example.com', 'a newer status sequence must not replace an address draft');

            const focusable = [...liveDialog.querySelectorAll('button:not([disabled]), input:not([disabled])')];
            const first = focusable[0]; const last = focusable[focusable.length - 1];
            last.focus();
            const tab = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
            await bundle.module.act(async () => { last.dispatchEvent(tab); });
            assert(tab.defaultPrevented && window.document.activeElement === first, 'Tab from the final setup control must wrap inside the dialog');
            await bundle.module.act(async () => rootNode.unmount());
            rootNode = null;
            assert(entries.length === 0, 'setup dialog interaction must emit no console warnings or errors');
          } finally {
            if (rootNode) await bundle.module.act(async () => rootNode.unmount());
            if (priorRects) Object.defineProperty(window.HTMLElement.prototype, 'getClientRects', priorRects);
            else delete window.HTMLElement.prototype.getClientRects;
            if (priorCustomEvent) Object.defineProperty(globalThis, 'CustomEvent', priorCustomEvent);
            else delete globalThis.CustomEvent;
          }
        }));
      } finally {
        __resetHandoffBridgeStoreForTests(); __resetBridgeUiForTests(); controller.abort(); await bundle?.dispose(); await fsPromises.rm(directory, { recursive: true, force: true });
      }
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
    name: 'handoff bridge: render: Settings checks a live preload before showing a real unavailable-build state',
    async run() {
      const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ic-handoff-availability-'));
      const entry = path.join(directory, 'AvailabilityProbe.jsx'); const setup = path.resolve('src/components/HandoffBridgeSetup.jsx'); const store = path.resolve('src/utils/handoffBridgeStore.js');
      await fsPromises.writeFile(entry, `import React from 'react';\nimport { HandoffBridgeSetup } from ${JSON.stringify(setup)};\nexport { __resetHandoffBridgeStoreForTests } from ${JSON.stringify(store)};\nexport function AvailabilityProbe() { return <HandoffBridgeSetup />; }\n`);
      const controller = new AbortController(); let bundle;
      try {
        bundle = await withTimeout(bundleComponent(entry, { signal: controller.signal }), 5000);
        await withDom(async window => withConsoleCollector(async entries => {
          let resolveStatus;
          window.electronAPI = {
            handoffBridgeGetStatus: () => new Promise(resolve => { resolveStatus = resolve; }),
            onHandoffBridgeStatus: () => () => {},
          };
          bundle.module.__resetHandoffBridgeStoreForTests();
          const rootNode = bundle.module.createRoot(window.document.getElementById('root'));
          try {
            await bundle.module.act(async () => { rootNode.render(bundle.module.React.createElement(bundle.module.AvailabilityProbe)); await Promise.resolve(); await Promise.resolve(); });
            const enabled = window.document.querySelector('input[type="checkbox"]');
            assert(window.document.body.textContent.includes('Checking bridge availability') && !window.document.body.textContent.includes('unavailable in this build') && !window.document.body.textContent.includes('Bridge off') && !window.document.body.textContent.includes('Turn on the bridge when') && enabled?.disabled,
              'a live preload with an unresolved first status must be visibly checking, hide stale off copy, and keep bridge controls inert');
            const retry = [...window.document.querySelectorAll('button')].find(button => button.textContent.includes('Try again'));
            assert(retry && !retry.disabled, 'an unresolved live preload must offer a person-initiated status retry without starting the bridge');
            await bundle.module.act(async () => { resolveStatus({ status: status(1, { availability: { ok: false, reason: 'dev-build' } }) }); await Promise.resolve(); await Promise.resolve(); });
            assert(!window.document.body.textContent.includes('Checking bridge availability') && window.document.body.textContent.includes('unavailable in this build') && enabled.disabled,
              'only an authoritative unavailable snapshot may show the unavailable-build message');
          } finally {
            await bundle.module.act(async () => rootNode.unmount());
          }
          assert(entries.length === 0, 'availability state transitions must not emit console output');
        }));
      } finally { bundle?.module.__resetHandoffBridgeStoreForTests(); controller.abort(); await bundle?.dispose(); await fsPromises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'handoff bridge: render: Settings manually retries a hung availability replay without accepting its late result',
    async run() {
      const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ic-handoff-availability-retry-'));
      const entry = path.join(directory, 'AvailabilityRetryProbe.jsx'); const setup = path.resolve('src/components/HandoffBridgeSetup.jsx'); const store = path.resolve('src/utils/handoffBridgeStore.js');
      await fsPromises.writeFile(entry, `import React from 'react';\nimport { HandoffBridgeSetup } from ${JSON.stringify(setup)};\nexport { __resetHandoffBridgeStoreForTests } from ${JSON.stringify(store)};\nexport function AvailabilityRetryProbe() { return <HandoffBridgeSetup />; }\n`);
      const controller = new AbortController(); let bundle;
      try {
        bundle = await withTimeout(bundleComponent(entry, { signal: controller.signal }), 5000);
        await withDom(async window => withConsoleCollector(async entries => {
          let calls = 0; let resolveInitial; let resolveRetry;
          window.electronAPI = {
            handoffBridgeGetStatus: () => {
              calls += 1;
              return new Promise(resolve => {
                if (calls === 1) resolveInitial = resolve;
                else resolveRetry = resolve;
              });
            },
            onHandoffBridgeStatus: () => () => {},
          };
          bundle.module.__resetHandoffBridgeStoreForTests();
          const rootNode = bundle.module.createRoot(window.document.getElementById('root'));
          try {
            await bundle.module.act(async () => { rootNode.render(bundle.module.React.createElement(bundle.module.AvailabilityRetryProbe)); await Promise.resolve(); await Promise.resolve(); });
            const retry = [...window.document.querySelectorAll('button')].find(button => button.textContent.includes('Try again'));
            assert(retry && calls === 1, 'the first unresolved replay must expose one manual retry action');
            await bundle.module.act(async () => { retry.click(); await Promise.resolve(); await Promise.resolve(); });
            assert(calls === 2, 'clicking Try again must issue a fresh status request while the first request is hung');
            await bundle.module.act(async () => { resolveRetry({ status: status(20, { enabled: false }) }); await Promise.resolve(); await Promise.resolve(); });
            const enabled = window.document.querySelector('input[type="checkbox"]');
            assert(!window.document.body.textContent.includes('Checking bridge availability') && !enabled.disabled && window.document.body.textContent.includes('Bridge off'), 'a successful manual retry must leave checking and restore controls from the authoritative status');
            await bundle.module.act(async () => { resolveInitial({ status: status(99, { availability: { ok: false, reason: 'dev-build' } }) }); await Promise.resolve(); await Promise.resolve(); });
            assert(!window.document.body.textContent.includes('unavailable in this build') && !enabled.disabled, 'a late initial result must not change the DOM after a newer manual retry wins');
            Object.defineProperty(window.electronAPI, 'handoffBridgeSetEnabled', { configurable: true, get() { throw new Error('synthetic action getter'); } });
            await bundle.module.act(async () => { enabled.click(); await Promise.resolve(); await Promise.resolve(); });
            assert(window.document.body.textContent.includes('Something went wrong in the bridge'), 'a throwing Settings action accessor must return fixed feedback instead of crashing the renderer');
            Object.defineProperty(window.electronAPI, 'handoffBridgeSetEnabled', { configurable: true, value: () => {
              const hostileResult = {};
              Object.defineProperty(hostileResult, 'success', { get() { throw new Error('synthetic result getter'); } });
              return hostileResult;
            } });
            await bundle.module.act(async () => { enabled.click(); await Promise.resolve(); await Promise.resolve(); });
            assert(window.document.body.textContent.includes('Something went wrong in the bridge'), 'a throwing resolved action-result getter must become fixed feedback instead of escaping the caller');
          } finally {
            await bundle.module.act(async () => rootNode.unmount());
          }
          assert(entries.length === 0, 'manual availability retry must not emit console output');
        }));
      } finally { bundle?.module.__resetHandoffBridgeStoreForTests(); controller.abort(); await bundle?.dispose(); await fsPromises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'handoff bridge: render: an unavailable enable action cannot relabel an available build',
    async run() {
      const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ic-handoff-enable-feedback-'));
      const entry = path.join(directory, 'EnableFeedbackProbe.jsx'); const setup = path.resolve('src/components/HandoffBridgeSetup.jsx'); const store = path.resolve('src/utils/handoffBridgeStore.js');
      await fsPromises.writeFile(entry, `import React from 'react';\nimport { HandoffBridgeSetup } from ${JSON.stringify(setup)};\nexport { __resetHandoffBridgeStoreForTests } from ${JSON.stringify(store)};\nexport function EnableFeedbackProbe() { return <HandoffBridgeSetup />; }\n`);
      const controller = new AbortController(); let bundle;
      try {
        bundle = await withTimeout(bundleComponent(entry, { signal: controller.signal }), 5000);
        await withDom(async window => withConsoleCollector(async entries => {
          const off = status(1, { enabled: false, serving: 'off', paused: false });
          let setterCalls = 0;
          window.electronAPI = {
            handoffBridgeGetStatus: async () => ({ status: off }),
            onHandoffBridgeStatus: () => () => {},
          };
          bundle.module.__resetHandoffBridgeStoreForTests();
          const rootNode = bundle.module.createRoot(window.document.getElementById('root'));
          try {
            await bundle.module.act(async () => { rootNode.render(bundle.module.React.createElement(bundle.module.EnableFeedbackProbe)); await Promise.resolve(); await Promise.resolve(); });
            const enabled = window.document.querySelector('input[type="checkbox"]');
            assert(enabled && !enabled.disabled && window.document.body.textContent.includes('Bridge off'), 'an authoritative available off snapshot must keep Settings controls enabled');

            await bundle.module.act(async () => { enabled.click(); await Promise.resolve(); await Promise.resolve(); });
            assert(window.document.body.textContent.includes(IPC_ERROR_COPY.UNAVAILABLE) && !window.document.body.textContent.includes('The bridge is not available in this build.') && !enabled.disabled && window.document.body.textContent.includes('Bridge off'), 'a missing enable action must retain the authoritative off state and show neutral action feedback instead of a false build verdict');

            window.electronAPI.handoffBridgeSetEnabled = async () => { setterCalls += 1; return { success: false, code: 'UNAVAILABLE' }; };
            await bundle.module.act(async () => { enabled.click(); await Promise.resolve(); await Promise.resolve(); });
            assert(setterCalls === 1 && window.document.body.textContent.includes(IPC_ERROR_COPY.UNAVAILABLE) && !window.document.body.textContent.includes('The bridge is not available in this build.') && !enabled.disabled && window.document.body.textContent.includes('Bridge off'), 'an unavailable enable response must remain action feedback and never override the available status card');
          } finally {
            await bundle.module.act(async () => rootNode.unmount());
          }
          assert(entries.length === 0, 'contradictory enable feedback must emit no console output');
        }));
      } finally { bundle?.module.__resetHandoffBridgeStoreForTests(); controller.abort(); await bundle?.dispose(); await fsPromises.rm(directory, { recursive: true, force: true }); }
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
    name: 'handoff bridge: render: every active Settings checkbox waits for a newer status and sends its exact patch',
    async run() {
      const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ic-handoff-checkboxes-'));
      const entry = path.join(directory, 'CheckboxProbe.jsx'); const setup = path.resolve('src/components/HandoffBridgeSetup.jsx'); const store = path.resolve('src/utils/handoffBridgeStore.js');
      await fsPromises.writeFile(entry, `import React from 'react';\nimport { HandoffBridgeSetup } from ${JSON.stringify(setup)};\nexport { applyHandoffBridgeStatus, getHandoffBridgeStatus, __resetHandoffBridgeStoreForTests } from ${JSON.stringify(store)};\nexport function CheckboxProbe() { return <HandoffBridgeSetup />; }\n`);
      const controller = new AbortController(); let bundle; __resetHandoffBridgeStoreForTests();
      const snapshot = (seq, extra = {}) => status(seq, {
        enabled: false,
        autoStart: false,
        autoRelease: false,
        config: { scope: { applications: true, scoring: false }, telemetryInBugReports: false },
        ...extra,
      });
      try {
        bundle = await withTimeout(bundleComponent(entry, { signal: controller.signal }), 5000);
        await withDom(async window => withConsoleCollector(async entries => {
          const saves = []; const enables = []; const statusListeners = [];
          const emit = value => statusListeners.forEach(listener => listener(value));
          const persisted = {
            enabled: false,
            autoStart: false,
            autoRelease: false,
            scope: { applications: true, scoring: false },
          };
          let nextSequence = 1;
          const publishSaved = () => emit(snapshot(++nextSequence, {
            enabled: persisted.enabled,
            autoStart: persisted.autoStart,
            autoRelease: persisted.autoRelease,
            config: {
              scope: { ...persisted.scope },
            },
          }));
          window.electronAPI = {
            handoffBridgeGetStatus: async () => ({ status: snapshot(1) }),
            onHandoffBridgeStatus: listener => { statusListeners.push(listener); return () => statusListeners.splice(statusListeners.indexOf(listener), 1); },
            handoffBridgeSaveConfig: async ({ patch }) => {
              saves.push(patch);
              // Preserve one failure path: no renderer-side optimism may make
              // a rejected durable auto-release change appear unchecked.
              if (patch.autoRelease === false) return { success: false, code: 'INTERNAL' };
              if (patch.scope) Object.assign(persisted.scope, patch.scope);
              if (Object.hasOwn(patch, 'autoStart')) persisted.autoStart = patch.autoStart;
              if (Object.hasOwn(patch, 'autoRelease')) persisted.autoRelease = patch.autoRelease;
              // The original failure was two sibling saves from one stale
              // render. Withhold the first acknowledgement snapshot so the
              // Scoring save alone must carry both durable scope values.
              if (patch.scope?.applications === false) return { success: true };
              publishSaved();
              return { success: true };
            },
            handoffBridgeSetEnabled: async ({ enabled }) => {
              enables.push(enabled);
              persisted.enabled = enabled;
              publishSaved();
              return { success: true };
            },
          };
          const rootNode = bundle.module.createRoot(window.document.getElementById('root'));
          const checkbox = label => {
            const row = [...window.document.querySelectorAll('label')].find(item => item.textContent.trim() === label);
            assert(row, `checkbox label ${label} must exist`);
            return row.querySelector('input[type="checkbox"]');
          };
          try {
            await bundle.module.act(async () => {
              rootNode.render(bundle.module.React.createElement(bundle.module.CheckboxProbe));
              bundle.module.applyHandoffBridgeStatus(snapshot(1));
              await Promise.resolve(); await Promise.resolve();
            });
            const applications = checkbox('Applications');
            const scoring = checkbox('Let ChatGPT handle scoring handoffs');
            assert(!window.document.body.textContent.includes('Include bridge counts in bug reports'), 'the unimplemented bug-report telemetry option must not present a no-op control');
            assert(applications.checked && !scoring.checked, 'the initial scope must enable applications only');
            await bundle.module.act(async () => { applications.click(); scoring.click(); await Promise.resolve(); await Promise.resolve(); });
            assert(JSON.stringify(saves.slice(0, 2)) === JSON.stringify([
              { scope: { applications: false } },
              { scope: { scoring: true } },
            ]), 'rapid independent scope changes must not resend a stale sibling value that overwrites the preceding click');
            assert(bundle.module.getHandoffBridgeStatus().seq === 2 && !applications.checked && scoring.checked, 'the delayed sibling acknowledgement must carry the combined authoritative scope state');

            const autoStart = checkbox('Turn on when the app starts');
            const autoRelease = checkbox('Automatically release new application handoffs this session');
            assert(!autoStart.checked && !autoRelease.checked, 'the initial startup and auto-release preferences must be off');
            await bundle.module.act(async () => { autoStart.click(); await Promise.resolve(); await Promise.resolve(); });
            assert(JSON.stringify(saves[2]) === JSON.stringify({ autoStart: true })
              && bundle.module.getHandoffBridgeStatus().seq === 3 && autoStart.checked,
            'auto-start must send its exact durable preference patch and wait for its newer main status');
            await bundle.module.act(async () => { autoRelease.click(); await Promise.resolve(); await Promise.resolve(); });
            assert(JSON.stringify(saves[3]) === JSON.stringify({ autoRelease: true })
              && bundle.module.getHandoffBridgeStatus().seq === 4 && autoRelease.checked,
            'auto-release must send its exact durable preference patch and wait for its newer main status');

            const enabled = checkbox('Turn on the ChatGPT bridge');
            assert(!enabled.checked, 'the initial master enable switch must be off');
            await bundle.module.act(async () => { enabled.click(); await Promise.resolve(); await Promise.resolve(); });
            assert(JSON.stringify(enables) === JSON.stringify([true])
              && bundle.module.getHandoffBridgeStatus().seq === 5 && enabled.checked,
            'the master switch must call its dedicated port and wait for the newer main status');

            await bundle.module.act(async () => { autoRelease.click(); await Promise.resolve(); await Promise.resolve(); });
            assert(JSON.stringify(saves[4]) === JSON.stringify({ autoRelease: false }), 'the controlled failure must request the auto-release value the user selected');
            assert(bundle.module.getHandoffBridgeStatus().seq === 5 && autoRelease.checked, 'a failed config save must not optimistically change a controlled checkbox');
            assert(window.document.body.textContent.includes('Something went wrong in the bridge. Try again; if it repeats, copy a bug report.'), 'a failed checkbox save must provide fixed feedback instead of pretending it was saved');
            assert(entries.length === 0, 'checkbox status transitions must emit no console warnings or errors');
          } finally {
            await bundle.module.act(async () => rootNode.unmount());
          }
        }));
      } finally { __resetHandoffBridgeStoreForTests(); controller.abort(); await bundle?.dispose(); await fsPromises.rm(directory, { recursive: true, force: true }); }
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
            const hostile = sequence % 3 === 0 ? { v: 1, seq: sequence, availability: { ok: true }, enabled: true, setup: { hostnameOk: true, binaryApproved: true, credentialsOk: true, linked: true }, tunnel: { state: sequence % 2 ? 'up' : 'hostile-state', binary: { path: '/Users/ada/secret' } }, link: { state: 'linked' }, chat: { state: 'working', outstanding: { stage: sequence % 2 ? 'resume' : 'hostile text', task: 'job-scoring' } }, queue: { applications: { ready: sequence % 4 }, jobs: [{ jobId: 'not-a-uuid', phase: 'awaiting' }] }, leak: { label: 'Marisol Quenby', code: '555-0101' } } : status(sequence, { power: { keepAwake: sequence % 2 === 0 } });
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
          const selected = keepAwake ? 'During bridge work, the app asks macOS to stay awake' : 'During bridge work, your Mac may sleep'; const other = keepAwake ? 'During bridge work, your Mac may sleep' : 'During bridge work, the app asks macOS to stay awake'; const text = window.document.body.textContent;
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
