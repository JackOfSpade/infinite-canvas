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
      const app = source('src/App.jsx'); const settings = source('src/components/SettingsPanel.jsx'); const setup = source('src/components/HandoffBridgeSetup.jsx'); const sidebar = source('src/components/Sidebar.jsx'); const panel = source('src/components/HandoffBridgePanel.jsx'); const dialog = source('src/components/HandoffBridgeSetupDialog.jsx'); const confirmDialog = source('src/components/ConfirmDialog.jsx'); const styles = source('src/index.css');
      assert(app.includes('<HandoffBridgeGuard label="panel">') && app.indexOf('<HandoffBridgePanel') > app.indexOf('<NonApiAiDialog'), 'App must mount the guarded panel after the non-API dialog');
      assert(settings.includes('<HandoffBridgeGuard label="settings">') && settings.includes('<HandoffBridgeSetup'), 'Settings must mount its guarded bridge section');
      // The bridge has no rail button: a dedicated trigger beside the bug
      // report made the bridge a second operational surface competing with the
      // dock that already shows the same handoffs. Settings owns the panel and
      // setup entry points instead, and the component is gone rather than
      // orphaned.
      assert(!sidebar.includes('HandoffBridgeTrigger'), 'the Sidebar must not carry a bridge trigger of its own');
      assert(!fs.existsSync(path.resolve('src/components/HandoffBridgeTrigger.jsx')), 'the removed trigger component must not linger unreferenced');
      assert(setup.includes('BRIDGE_UI_COPY.openPanel'), 'Settings must keep the only entry point that opens the panel');
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
      assert(!panel.includes('<details') && !panel.includes('safetyDetails') && !panel.includes('BRIDGE_COPY.hygiene') && !panel.includes('BRIDGE_COPY.dockNote') && !panel.includes('BRIDGE_COPY.keepAwake'), 'panel must not render or reference the removed safety and privacy notes');
      for (const className of ['bridge-button-primary', 'bridge-button-secondary', 'bridge-button-danger']) assert(new RegExp(`\\.${className}(?:,|\\s*\\{)`).test(styles), `${className} must have a shared CSS definition`);
      for (const rule of ['display: inline-flex', 'max-width: 100%', 'min-height: 2.25rem', 'overflow-wrap: anywhere', ':disabled']) assert(styles.includes(rule), `bridge buttons must retain the compact responsive rule ${rule}`);
      assert(panel.includes("if (id === 'open-pairing')") && panel.includes('openBridgeSetup(3)')
        && !panel.includes("'open-pairing': 'handoffBridgeOpenPairing'"),
      'the panel renewal action must enter the setup surface that owns the direct pairing-code response');
      assert(!dialog.includes('${BRIDGE_SETUP_COPY.stepComplete}') && !dialog.includes('${BRIDGE_SETUP_COPY.stepPending}'), 'setup progress must use icons or CSS, not visible glyph text');
      assert(!dialog.includes('ConfirmDialog') && !dialog.includes('LINK_WOULD_BREAK') && !dialog.includes('confirmBreak') && !dialog.includes('pendingAddress'), 'the renderer must leave linked-address confirmation to one authoritative main-process dialog');
      assert(!setup.includes("confirm === 'off'") && !panel.includes("confirm === 'off'")
        && setup.includes("void call('handoffBridgeSetEnabled', { enabled: event.target.checked });")
        && panel.includes("onClick={() => void call('handoffBridgeSetEnabled', { enabled: false })}"), 'renderer controls must leave the one critical outstanding-work stop confirmation to main');
      assert(setup.includes("onClick={() => void call('handoffBridgeForgetSetup')}") && !setup.includes("confirm === 'forget'"), 'Forget setup must use the single authoritative main-process confirmation');
      for (const count of ['getServed', 'submitAccepted', 'submitRejected', 'submitDuplicate', 'submitJunk', 'stallNotices', 'tunnelRestarts']) assert(panel.includes(`status.counts.${count}`), `panel counts must include ${count}`);
      for (const method of ['handoffBridgeSetEnabled', 'handoffBridgeSaveConfig', 'handoffBridgeChooseBinary', 'handoffBridgeApproveBinary', 'handoffBridgeChooseCredentials', 'handoffBridgeRestartTunnel', 'handoffBridgeGetTunnelLog', 'handoffBridgeOpenPairing', 'handoffBridgeCancelPairing', 'handoffBridgeNewChat']) assert(panel.includes(method) || dialog.includes(method), `renderer IPC method ${method} must be reachable through an accessible control`);
      assert(!panel.includes("setConfirm('new')") && !panel.includes('confirm === \'new\'')
        && !source('src/components/BridgeProgress.jsx').includes('confirmNew')
        && panel.includes('BRIDGE_PROGRESS_COPY.copiedAgain(result.chatOrdinal, pluginName)') && panel.includes('result.recopied === true'),
      'Copy starter must directly invoke main from both renderer surfaces while main alone decides re-copy wording');
    },
  },
  {
    name: 'handoff bridge: render: active critical confirmation has stable accessible name and description links',
    async run() {
      const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ic-handoff-confirm-dialog-'));
      const entry = path.join(directory, 'ConfirmDialogProbe.jsx');
      const confirmDialog = path.resolve('src/components/ConfirmDialog.jsx');
      await fsPromises.writeFile(entry, `import React from 'react';\nimport { ConfirmDialog } from ${JSON.stringify(confirmDialog)};\nexport function ConfirmDialogProbe() { return <ConfirmDialog title="Turn off bridge?" message="Pending work will no longer be available to ChatGPT." confirmLabel="Turn off" cancelLabel="Keep on" onConfirm={() => {}} onCancel={() => {}} variant="warning" />; }\n`);
      const controller = new AbortController(); let bundle;
      try {
        bundle = await withTimeout(bundleComponent(entry, { signal: controller.signal }), 5000);
        await withDom(async window => withConsoleCollector(async entries => {
          const priorCustomEvent = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent');
          Object.defineProperty(globalThis, 'CustomEvent', { configurable: true, writable: true, value: window.CustomEvent });
          const rootNode = bundle.module.createRoot(window.document.getElementById('root'));
          try {
            await bundle.module.act(async () => rootNode.render(bundle.module.React.createElement(bundle.module.ConfirmDialogProbe)));
            const dialog = window.document.querySelector('[role="dialog"]');
            const titleId = dialog?.getAttribute('aria-labelledby');
            const messageId = dialog?.getAttribute('aria-describedby');
            const title = titleId && window.document.getElementById(titleId);
            const message = messageId && window.document.getElementById(messageId);
            assert(titleId && messageId && title && message, 'an active critical dialog must point to real title and description elements');
            assert(title.textContent === 'Turn off bridge?' && message.textContent === 'Pending work will no longer be available to ChatGPT.', 'the accessible dialog links must resolve its active critical warning text');
            await bundle.module.act(async () => rootNode.render(bundle.module.React.createElement(bundle.module.ConfirmDialogProbe)));
            assert(dialog.getAttribute('aria-labelledby') === titleId && dialog.getAttribute('aria-describedby') === messageId, 'accessible title and description IDs must remain stable while the dialog stays active');
          } finally {
            await bundle.module.act(async () => rootNode.unmount());
            if (priorCustomEvent) Object.defineProperty(globalThis, 'CustomEvent', priorCustomEvent);
            else delete globalThis.CustomEvent;
          }
          assert(entries.length === 0, 'critical confirmation accessibility must mount without console output');
        }));
      } finally {
        controller.abort();
        await bundle?.dispose();
        await fsPromises.rm(directory, { recursive: true, force: true });
      }
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
          let rootNode; let priorClipboard;
          try {
            const enableCalls = [];
            const pendingEnable = [];
            const configPatches = [];
            const setupCalls = [];
            const copiedValues = [];
            const pairingCalls = [];
            let clipboardShouldFail = false;
            let delayedClipboardValue = null;
            let releaseDelayedClipboard = null;
            let nextPairingResult = { success: true, pairingCode: '23456-789AB', expiresAt: Date.now() + 60_000 };
            priorClipboard = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard');
            Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText: async value => {
              if (value === delayedClipboardValue) {
                await new Promise(resolve => {
                  releaseDelayedClipboard = () => {
                    copiedValues.push(value);
                    resolve();
                  };
                });
                return;
              }
              if (clipboardShouldFail) throw new Error('synthetic clipboard rejection');
              copiedValues.push(value);
            } } });
            window.electronAPI = {
              handoffBridgeGetStatus: async () => ({ status: status(1) }),
              onHandoffBridgeStatus: () => () => {},
              handoffBridgeChooseBinary: async () => { setupCalls.push('binary'); return { success: true }; },
              handoffBridgeApproveBinary: async () => { setupCalls.push('approve'); return { success: true }; },
              handoffBridgeChooseCredentials: async () => { setupCalls.push('credentials'); return { success: true }; },
              handoffBridgeSaveConfig: async ({ patch }) => { configPatches.push(patch); return { success: true }; },
              handoffBridgeSetEnabled: async ({ enabled }) => {
                enableCalls.push(enabled);
                if (enableCalls.length === 2) return { success: true };
                return new Promise(resolve => pendingEnable.push(resolve));
              },
              handoffBridgeOpenPairing: async () => { pairingCalls.push('open'); return nextPairingResult; },
              handoffBridgeCancelPairing: async () => { pairingCalls.push('cancel'); return { success: true }; },
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
            assert(enableCalls.length === 1 && enableCalls[0] === true && enableBridge.disabled && enableBridge.textContent.includes('Turning on bridge'), 'an in-flight enable remains pending despite later status refreshes');
            const transientEnabled = status(7, {
              enabled: true,
              serving: 'starting',
              setup: { hostnameOk: true, binaryApproved: true, credentialsOk: true, tunnelReachable: false, linked: false, toolsListed: false, firstCallSeen: false },
              tunnel: { state: 'starting', probe: { state: 'checking' } },
              link: { state: 'unlinked' },
            });
            await bundle.module.act(async () => { bundle.module.applyHandoffBridgeStatus(transientEnabled); await Promise.resolve(); await Promise.resolve(); });
            await bundle.module.act(async () => {
              pendingEnable[0]({ success: false, code: 'TUNNEL_NOT_SERVING' });
              await Promise.resolve(); await Promise.resolve();
              await new Promise(resolve => setTimeout(resolve, 0));
            });
            const offProgress = status(8, {
              enabled: false,
              serving: 'starting',
              setup: { hostnameOk: true, binaryApproved: true, credentialsOk: true, tunnelReachable: false, linked: false, toolsListed: false, firstCallSeen: false },
              tunnel: { state: 'degraded', probe: { state: 'failing', reason: 'tunnel-not-serving', consecutiveFailures: 5 } },
              link: { state: 'unlinked' },
            });
            await bundle.module.act(async () => { bundle.module.applyHandoffBridgeStatus(offProgress); await Promise.resolve(); await Promise.resolve(); });
            const failedEnable = [...offReadyDialog.querySelectorAll('button')].find(button => button.textContent.includes('Turn on bridge'));
            assert(failedEnable && !failedEnable.disabled, 'a failed enable before the final off status must allow retry');
            assert(offReadyDialog.textContent.includes(IPC_ERROR_COPY.TUNNEL_NOT_SERVING), 'a rejected enable response must survive its stale transient enabled snapshot and explain the Cloudflare tunnel-target fix once main publishes off');
            await bundle.module.act(async () => { failedEnable.click(); await Promise.resolve(); await Promise.resolve(); });
            const completedEnable = [...offReadyDialog.querySelectorAll('button')].find(button => button.textContent.includes('Turn on bridge'));
            assert(enableCalls.length === 2 && completedEnable && !completedEnable.disabled, 'a successful enable response clears the in-flight state instead of leaving the setup action disabled');
            const starting = status(9, {
              enabled: true,
              serving: 'starting',
              setup: { hostnameOk: true, binaryApproved: true, credentialsOk: true, tunnelReachable: false, linked: false, toolsListed: false, firstCallSeen: false },
              tunnel: { state: 'starting', probe: { state: 'checking' } },
              link: { state: 'unlinked' },
            });
            await bundle.module.act(async () => { bundle.module.applyHandoffBridgeStatus(starting); await Promise.resolve(); await Promise.resolve(); });
            assert(!offReadyDialog.textContent.includes('Something went wrong in the bridge. Try again; if it repeats, copy a bug report.') && offReadyDialog.textContent.includes('The bridge is starting. Wait for the tunnel to be online before continuing.'), 'a newer main status must clear prior enable feedback and state the live tunnel wait');
            await bundle.module.act(async () => { bundle.module.applyHandoffBridgeStatus(status(10)); await Promise.resolve(); await Promise.resolve(); });
            assert(![...offReadyDialog.querySelectorAll('button[aria-label^="Go to"]')][2].disabled && ![...offReadyDialog.querySelectorAll('button')].find(button => button.textContent.includes('Next'))?.disabled, 'the online status refresh must unlock Plugin and link without remounting setup');

            const offForRetry = status(11, {
              enabled: false,
              serving: 'off',
              setup: { hostnameOk: true, binaryApproved: true, credentialsOk: true, tunnelReachable: false, linked: false, toolsListed: false, firstCallSeen: false },
              tunnel: { state: 'off', probe: { state: 'off' } },
              link: { state: 'unlinked' },
            });
            await bundle.module.act(async () => { bundle.module.applyHandoffBridgeStatus(offForRetry); bundle.module.openBridgeSetup(2); });
            const retryDialog = window.document.querySelector('[role="dialog"]');
            const retryEnable = [...retryDialog.querySelectorAll('button')].find(button => button.textContent.includes('Turn on bridge'));
            const telemetry = retryDialog.querySelector('input[type="checkbox"]');
            assert(telemetry && !telemetry.checked, 'Advanced tunnel setup must expose the persisted bridge-diagnostics preference');
            assert(retryDialog.textContent.includes('Include bridge diagnostics in FULL bug reports'),
              'the diagnostics preference uses the setup copy contract');
            await bundle.module.act(async () => { retryEnable.click(); await Promise.resolve(); await Promise.resolve(); telemetry.click(); await Promise.resolve(); await Promise.resolve(); });
            assert(configPatches.some(patch => patch.telemetryInBugReports === true) && !retryEnable.disabled,
              'changing bridge diagnostics clears the old enable request and persists only the telemetry preference');
            await bundle.module.act(async () => {
              bundle.module.applyHandoffBridgeStatus(status(12, {
                enabled: false,
                serving: 'off',
                config: { telemetryInBugReports: true },
                setup: { hostnameOk: true, binaryApproved: true, credentialsOk: true, tunnelReachable: false, linked: false, toolsListed: false, firstCallSeen: false },
                tunnel: { state: 'off', probe: { state: 'off' } },
                link: { state: 'unlinked' },
              }));
              await Promise.resolve(); await Promise.resolve();
            });
            assert(retryDialog.querySelector('input[type="checkbox"]')?.checked, 'the diagnostics checkbox follows the persisted status snapshot');
            await bundle.module.act(async () => { retryEnable.click(); await Promise.resolve(); await Promise.resolve(); pendingEnable[1]({ success: false, code: 'INTERNAL' }); await Promise.resolve(); await Promise.resolve(); });
            assert(!retryDialog.textContent.includes('Something went wrong in the bridge. Try again; if it repeats, copy a bug report.') && retryEnable.disabled,
              'a stale failed enable response cannot overwrite a newer pending attempt');
            await bundle.module.act(async () => { pendingEnable[2]({ success: false, code: 'INTERNAL' }); await Promise.resolve(); await Promise.resolve(); });
            assert(retryDialog.textContent.includes('Something went wrong in the bridge. Try again; if it repeats, copy a bug report.'),
              'the current failed enable response remains visible after newer status snapshots');

            await bundle.module.act(async () => { bundle.module.applyHandoffBridgeStatus(status(13)); bundle.module.openBridgeSetup(2); });
            const liveDialog = window.document.querySelector('[role="dialog"]');
            const hostname = liveDialog.querySelector('input[aria-label="Public address"]');
            hostname.value = 'draft.example.com';
            hostname.dispatchEvent(new window.Event('input', { bubbles: true }));
            await bundle.module.act(async () => { bundle.module.applyHandoffBridgeStatus(status(14, { config: { hostname: 'saved.example.com' } })); });
            assert(hostname.value === 'draft.example.com', 'a newer status sequence must not replace an address draft');

            await bundle.module.act(async () => {
              bundle.module.applyHandoffBridgeStatus(status(15, {
                config: { hostname: 'bridge.example.com', pluginName: 'infinite_canvas', mcpUrl: 'https://bridge.example.com/mcp' },
                link: { state: 'unlinked', pairing: { open: false } },
              }));
              bundle.module.openBridgeSetup(3);
              await Promise.resolve(); await Promise.resolve();
            });
            const pluginDialog = window.document.querySelector('[role="dialog"]');
            const copyFeedback = target => pluginDialog.querySelector(`[data-copy-feedback-for="${target}"]`);
            assert(pluginDialog.textContent.includes('infinite_canvas') && pluginDialog.textContent.includes('https://bridge.example.com/mcp'),
              'Plugin and link shows the exact suggested plugin name and the configured MCP server URL');
            await bundle.module.act(async () => {
              pluginDialog.querySelector('button[aria-label="Copy plugin name"]').click();
              await Promise.resolve(); await Promise.resolve();
            });
            assert(copyFeedback('plugin-name')?.getAttribute('role') === 'status'
              && copyFeedback('plugin-name')?.textContent.includes('Copied plugin name.')
              && !copyFeedback('server-url') && !copyFeedback('pairing-code'),
            'copying the plugin name must show an inline, accessible success confirmation at that value only');
            await bundle.module.act(async () => {
              pluginDialog.querySelector('button[aria-label="Copy server URL"]').click();
              await Promise.resolve(); await Promise.resolve();
            });
            assert(JSON.stringify(copiedValues) === JSON.stringify(['infinite_canvas', 'https://bridge.example.com/mcp']),
              'the displayed plugin name and MCP URL are directly click-to-copy values');
            assert(copyFeedback('server-url')?.getAttribute('role') === 'status'
              && copyFeedback('server-url')?.textContent.includes('Copied server URL.')
              && !copyFeedback('plugin-name') && !copyFeedback('pairing-code'),
            'copying a new value must move the inline confirmation to the latest copied server URL');
            delayedClipboardValue = 'infinite_canvas';
            await bundle.module.act(async () => {
              pluginDialog.querySelector('button[aria-label="Copy plugin name"]').click();
              await Promise.resolve(); await Promise.resolve();
            });
            assert(typeof releaseDelayedClipboard === 'function', 'the out-of-order copy test must hold the first clipboard completion');
            clipboardShouldFail = true;
            await bundle.module.act(async () => {
              pluginDialog.querySelector('button[aria-label="Copy server URL"]').click();
              await Promise.resolve(); await Promise.resolve();
            });
            assert(pluginDialog.textContent.includes(IPC_ERROR_COPY.CLIPBOARD_FAILED)
              && !copyFeedback('plugin-name') && !copyFeedback('server-url') && !copyFeedback('pairing-code'),
            'a newer clipboard failure clears prior success feedback instead of claiming the server URL was copied');
            delayedClipboardValue = null;
            await bundle.module.act(async () => {
              releaseDelayedClipboard();
              await Promise.resolve(); await Promise.resolve();
            });
            assert(pluginDialog.textContent.includes(IPC_ERROR_COPY.CLIPBOARD_FAILED)
              && !copyFeedback('plugin-name') && !copyFeedback('server-url') && !copyFeedback('pairing-code'),
            'a delayed earlier clipboard success cannot overwrite the feedback from a later clipboard failure');
            clipboardShouldFail = false;
            await bundle.module.act(async () => {
              bundle.module.applyHandoffBridgeStatus(status(16, {
                config: { hostname: 'bridge.example.com', pluginName: 'My Bridge 2', mcpUrl: 'https://bridge.example.com/mcp' },
                link: { state: 'unlinked', pairing: { open: false } },
              }));
              await Promise.resolve(); await Promise.resolve();
            });
            const customPluginName = pluginDialog.querySelector('button[aria-label="Copy plugin name"]');
            assert(customPluginName?.textContent.includes('My Bridge 2') && !customPluginName.textContent.includes('infinite_canvas'),
              'an existing custom plugin name is shown exactly so it stays consistent with the chat starter');
            await bundle.module.act(async () => { customPluginName.click(); await Promise.resolve(); await Promise.resolve(); });
            assert(copiedValues.at(-1) === 'My Bridge 2', 'the configured custom plugin name is the value copied to ChatGPT');
            await bundle.module.act(async () => {
              bundle.module.applyHandoffBridgeStatus(status(17, {
                config: { hostname: 'bridge.example.com', pluginName: 'infinite_canvas', mcpUrl: 'https://bridge.example.com/mcp' },
                link: { state: 'unlinked', pairing: { open: false } },
              }));
              await Promise.resolve(); await Promise.resolve();
            });
            const openPairing = [...pluginDialog.querySelectorAll('button')].find(button => button.textContent.includes('Open pairing'));
            let resolvePairingOpen;
            nextPairingResult = new Promise(resolve => { resolvePairingOpen = resolve; });
            await bundle.module.act(async () => {
              // Fire both events before React can commit the disabled state.
              // The synchronous ref guard must still admit only one IPC.
              openPairing.click();
              openPairing.click();
              await Promise.resolve(); await Promise.resolve();
            });
            assert(pairingCalls.filter(value => value === 'open').length === 1
              && openPairing.disabled && openPairing.getAttribute('aria-busy') === 'true',
            'a fast double-click must create one pairing request and expose its in-flight state');
            await bundle.module.act(async () => {
              resolvePairingOpen({ success: true, pairingCode: '23456-789AB', expiresAt: Date.now() + 60_000 });
              await Promise.resolve(); await Promise.resolve();
            });
            const pairingCode = pluginDialog.querySelector('button[aria-label="Copy pairing code"]');
            assert(pairingCalls[0] === 'open' && pairingCode?.textContent.includes('23456-789AB') && openPairing.getAttribute('aria-busy') === null,
              'a direct successful pairing reply displays its ephemeral code inside the setup panel');
            await bundle.module.act(async () => { pairingCode.click(); await Promise.resolve(); await Promise.resolve(); });
            assert(copiedValues.at(-1) === '23456-789AB', 'the displayed pairing code is click-to-copy');
            assert(copyFeedback('pairing-code')?.getAttribute('role') === 'status'
              && copyFeedback('pairing-code')?.textContent.includes('Copied pairing code.')
              && !copyFeedback('plugin-name') && !copyFeedback('server-url'),
            'copying a pairing code must move the inline confirmation to the code, rather than leaving it at an earlier value');
            clipboardShouldFail = true;
            await bundle.module.act(async () => { pairingCode.click(); await Promise.resolve(); await Promise.resolve(); });
            assert(pluginDialog.textContent.includes(IPC_ERROR_COPY.CLIPBOARD_FAILED)
              && pluginDialog.querySelector('button[aria-label="Copy pairing code"]')
              && !copyFeedback('plugin-name') && !copyFeedback('server-url') && !copyFeedback('pairing-code'),
            'a clipboard rejection gives fixed feedback without clearing the code or claiming any value was copied');
            clipboardShouldFail = false;
            await bundle.module.act(async () => {
              bundle.module.applyHandoffBridgeStatus(status(18, { link: { state: 'unlinked', pairing: { open: false } } }));
              await Promise.resolve(); await Promise.resolve();
            });
            assert(!pluginDialog.querySelector('button[aria-label="Copy pairing code"]'),
              'a pairing code clears after this dialog has observed its live pairing close');
            nextPairingResult = { success: true, pairingCode: '23456-789AB', expiresAt: Date.now() + 60_000 };
            await bundle.module.act(async () => { openPairing.click(); await Promise.resolve(); await Promise.resolve(); });
            const cancelPairing = [...pluginDialog.querySelectorAll('button')].find(button => button.textContent.includes('Cancel pairing'));
            await bundle.module.act(async () => { cancelPairing.click(); await Promise.resolve(); await Promise.resolve(); });
            assert(pairingCalls.includes('cancel') && !pluginDialog.querySelector('button[aria-label="Copy pairing code"]'),
              'Cancel pairing clears the local code before it asks main to close the pairing');
            nextPairingResult = { success: false, code: 'TUNNEL_NOT_READY' };
            await bundle.module.act(async () => { openPairing.click(); await Promise.resolve(); await Promise.resolve(); });
            assert(!pluginDialog.querySelector('button[aria-label="Copy pairing code"]'),
              'a failed new pairing attempt cannot retain the prior code');

            const originalNow = Date.now;
            try {
              let fakeNow = originalNow();
              Date.now = () => fakeNow;
              nextPairingResult = { success: true, pairingCode: '34567-89ABC', expiresAt: fakeNow + 60_000 };
              await bundle.module.act(async () => { openPairing.click(); await Promise.resolve(); await Promise.resolve(); });
              const expiringCode = pluginDialog.querySelector('button[aria-label="Copy pairing code"]');
              const copiedBeforeExpiry = copiedValues.length;
              assert(expiringCode?.textContent.includes('34567-89ABC'), 'a fresh pairing code renders before its declared expiry');
              fakeNow += 60_001;
              await bundle.module.act(async () => { expiringCode.click(); await Promise.resolve(); await Promise.resolve(); });
              assert(copiedValues.length === copiedBeforeExpiry && !pluginDialog.querySelector('button[aria-label="Copy pairing code"]'),
                'an expired code cannot be copied even when its timer callback has been delayed');
            } finally {
              Date.now = originalNow;
            }

            let resolveClosedBeforeReply;
            nextPairingResult = new Promise(resolve => { resolveClosedBeforeReply = resolve; });
            await bundle.module.act(async () => { openPairing.click(); await Promise.resolve(); await Promise.resolve(); });
            await bundle.module.act(async () => {
              bundle.module.applyHandoffBridgeStatus(status(19, { link: { state: 'unlinked', pairing: { open: true, expiresAt: Date.now() + 60_000 } } }));
              await Promise.resolve(); await Promise.resolve();
            });
            await bundle.module.act(async () => {
              bundle.module.applyHandoffBridgeStatus(status(20, { link: { state: 'unlinked', pairing: { open: false, expiresAt: null } } }));
              await Promise.resolve(); await Promise.resolve();
            });
            await bundle.module.act(async () => {
              resolveClosedBeforeReply({ success: true, pairingCode: '45678-9ABCD', expiresAt: Date.now() + 60_000 });
              await Promise.resolve(); await Promise.resolve();
            });
            assert(!pluginDialog.querySelector('button[aria-label="Copy pairing code"]') && !openPairing.disabled && openPairing.getAttribute('aria-busy') === null,
              'a native open-to-closed publication wins over a queued direct success and cannot resurrect its code');

            const focusable = [...liveDialog.querySelectorAll('button:not([disabled]), input:not([disabled])')];
            const first = focusable[0]; const last = focusable[focusable.length - 1];
            last.focus();
            const tab = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
            await bundle.module.act(async () => { last.dispatchEvent(tab); });
            assert(tab.defaultPrevented && window.document.activeElement === first, 'Tab from the final setup control must wrap inside the dialog');

            let resolveAfterDismiss;
            nextPairingResult = new Promise(resolve => { resolveAfterDismiss = resolve; });
            const cancelsBeforeDismiss = pairingCalls.filter(value => value === 'cancel').length;
            await bundle.module.act(async () => { openPairing.click(); await Promise.resolve(); await Promise.resolve(); });
            const closeSetup = pluginDialog.querySelector('button[aria-label="Close setup"]');
            await bundle.module.act(async () => { closeSetup.click(); await Promise.resolve(); await Promise.resolve(); });
            assert(!window.document.querySelector('[role="dialog"]')
              && pairingCalls.filter(value => value === 'cancel').length === cancelsBeforeDismiss + 1,
            'closing setup immediately cancels the pairing attempt this renderer owns');
            await bundle.module.act(async () => {
              resolveAfterDismiss({ success: true, pairingCode: '56789-ABCDE', expiresAt: Date.now() + 60_000 });
              await Promise.resolve(); await Promise.resolve();
            });
            assert(pairingCalls.filter(value => value === 'cancel').length === cancelsBeforeDismiss + 2,
              'a synthetic late success after dismissal is cancelled again instead of silently arming');
            await bundle.module.act(async () => { bundle.module.openBridgeSetup(3); await Promise.resolve(); await Promise.resolve(); });
            let reopenedDialog = window.document.querySelector('[role="dialog"]');
            assert(reopenedDialog && !reopenedDialog.querySelector('button[aria-label="Copy pairing code"]'),
              'reopening setup after a stale result cannot reveal its discarded pairing code');

            await bundle.module.act(async () => {
              bundle.module.applyHandoffBridgeStatus(status(21, { link: { state: 'unlinked', pairing: { open: true, expiresAt: Date.now() + 60_000 } } }));
              await Promise.resolve(); await Promise.resolve();
            });
            const cancelsBeforeForeignClose = pairingCalls.filter(value => value === 'cancel').length;
            await bundle.module.act(async () => {
              reopenedDialog.querySelector('button[aria-label="Close setup"]').click();
              await Promise.resolve(); await Promise.resolve();
            });
            assert(pairingCalls.filter(value => value === 'cancel').length === cancelsBeforeForeignClose,
              'closing a renderer that did not open the published pairing leaves the owning window session alone');

            await bundle.module.act(async () => {
              bundle.module.applyHandoffBridgeStatus(status(22, { link: { state: 'unlinked', pairing: { open: false, expiresAt: null } } }));
              bundle.module.openBridgeSetup(3);
              await Promise.resolve(); await Promise.resolve();
            });
            reopenedDialog = window.document.querySelector('[role="dialog"]');
            const reopenedOpenPairing = [...reopenedDialog.querySelectorAll('button')].find(button => button.textContent.includes('Open pairing'));
            nextPairingResult = { success: true, pairingCode: '6789A-BCDEF', expiresAt: Date.now() + 60_000 };
            await bundle.module.act(async () => { reopenedOpenPairing.click(); await Promise.resolve(); await Promise.resolve(); });
            assert(reopenedDialog.querySelector('button[aria-label="Copy pairing code"]'), 'the unmount case begins with a renderer-owned live pairing');
            const cancelsBeforeUnmount = pairingCalls.filter(value => value === 'cancel').length;
            await bundle.module.act(async () => rootNode.unmount());
            rootNode = null;
            assert(pairingCalls.filter(value => value === 'cancel').length === cancelsBeforeUnmount + 1,
              'unmounting setup cancels its renderer-owned live pairing exactly once');
            assert(entries.length === 0, 'setup dialog interaction must emit no console warnings or errors');
          } finally {
            if (rootNode) await bundle.module.act(async () => rootNode.unmount());
            if (priorRects) Object.defineProperty(window.HTMLElement.prototype, 'getClientRects', priorRects);
            else delete window.HTMLElement.prototype.getClientRects;
            if (priorCustomEvent) Object.defineProperty(globalThis, 'CustomEvent', priorCustomEvent);
            else delete globalThis.CustomEvent;
            if (priorClipboard) Object.defineProperty(window.navigator, 'clipboard', priorClipboard);
            else delete window.navigator.clipboard;
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
      const panel = path.resolve('src/components/HandoffBridgePanel.jsx'); const setup = path.resolve('src/components/HandoffBridgeSetup.jsx'); const dialog = path.resolve('src/components/HandoffBridgeSetupDialog.jsx'); const sidebar = path.resolve('src/components/Sidebar.jsx');
      await fsPromises.writeFile(entry, `import React from 'react';\nimport { HandoffBridgePanel } from ${JSON.stringify(panel)};\nimport { HandoffBridgeSetup } from ${JSON.stringify(setup)};\nimport { HandoffBridgeSetupDialog } from ${JSON.stringify(dialog)};\nimport { Sidebar } from ${JSON.stringify(sidebar)};\nexport function NoPreloadProbe() { return <><HandoffBridgePanel /><HandoffBridgeSetup /><HandoffBridgeSetupDialog /><Sidebar onReportBugClick={() => {}} /></>; }\n`);
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
          const priorCustomEvent = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent');
          Object.defineProperty(globalThis, 'CustomEvent', { configurable: true, writable: true, value: window.CustomEvent });
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

            await bundle.module.act(async () => {
              bundle.module.applyHandoffBridgeStatus(snapshot(6, {
                enabled: true,
                autoStart: true,
                autoRelease: true,
                config: { scope: { applications: false, scoring: true } },
                chat: { state: 'working', outstanding: { stage: 'resume' } },
              }));
            });
            await bundle.module.act(async () => { enabled.click(); await Promise.resolve(); await Promise.resolve(); });
            assert(JSON.stringify(enables) === JSON.stringify([true, false])
              && !window.document.body.textContent.includes('ChatGPT has an unanswered handoff.'),
            'Settings must send an outstanding-work stop directly to the one authoritative main-process confirmation');

            await bundle.module.act(async () => { autoRelease.click(); await Promise.resolve(); await Promise.resolve(); });
            assert(JSON.stringify(saves[4]) === JSON.stringify({ autoRelease: false }), 'the controlled failure must request the auto-release value the user selected');
            assert(bundle.module.getHandoffBridgeStatus().seq === 6 && autoRelease.checked, 'a failed config save must not optimistically change a controlled checkbox');
            assert(window.document.body.textContent.includes('Something went wrong in the bridge. Try again; if it repeats, copy a bug report.'), 'a failed checkbox save must provide fixed feedback instead of pretending it was saved');
            assert(entries.length === 0, 'checkbox status transitions must emit no console warnings or errors');
          } finally {
            await bundle.module.act(async () => rootNode.unmount());
            if (priorCustomEvent) Object.defineProperty(globalThis, 'CustomEvent', priorCustomEvent);
            else delete globalThis.CustomEvent;
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
    name: 'handoff bridge: render: each keep-awake value renders once in Settings, never the panel',
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
          const selected = keepAwake ? 'During bridge work, the app asks macOS to keep your Mac awake' : 'During bridge work, your Mac may sleep'; const other = keepAwake ? 'During bridge work, your Mac may sleep' : 'During bridge work, the app asks macOS to keep your Mac awake'; const text = window.document.body.textContent;
          assert(!window.document.querySelector('details') && !text.includes('Safety and privacy') && !text.includes('Use a dedicated ChatGPT Project') && !text.includes('Copy/paste still works') && !text.includes('Review every resume and cover letter'), 'the panel must not render the removed safety or privacy disclosure and notes');
          assert(text.split(selected).length - 1 === 1 && !text.includes(other), 'the selected keep-awake sentence must appear in Settings only');
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
  {
    name: 'handoff bridge: render: BridgeProgress renders every state accessibly, drives the existing chat IPC, and survives malformed status',
    async run() {
      const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ic-bridge-progress-'));
      const entry = path.join(directory, 'ProgressProbe.jsx'); const component = path.resolve('src/components/BridgeProgress.jsx');
      await fsPromises.writeFile(entry, `import React from 'react';\nimport { BridgeProgress } from ${JSON.stringify(component)};\nexport function ProgressProbe(props) { return <BridgeProgress {...props} />; }\n`);
      const controller = new AbortController(); let bundle;
      const JOB = '11111111-1111-4111-8111-111111111111';
      const clock = Date.now();
      // The engine's per-job proof: a job this chat holds and is answering carries servedAt + awaitingAnswer.
      const job = (extra = {}) => ({ jobId: JOB, phase: 'awaiting', stage: 'resume', reason: null, servedToChat: 1, changedAt: clock - 600000, servedAt: extra.servedToChat === null ? null : clock - 120000, answeredAt: null, awaitingAnswer: extra.servedToChat !== null, stalled: false, stalledSince: null, ...extra });
      const working = (extra = {}) => ({ ordinal: 1, state: 'working', startedAt: clock - 300000, firstCallAt: clock - 290000, lastCallAt: clock - 20000, lastCallKind: 'get', calls: 3, jobsAssigned: 1, jobsCap: 2, outstanding: { servedAt: clock - 120000, kind: 'application', stage: 'resume', stalled: false, stalledSince: null, stallsLastHour: 0 }, ...extra });
      const view = (jobExtra, chatExtra, top = {}) => normalizeBridgeStatus({ ...status(1, { chat: working(chatExtra), queue: { jobs: [job(jobExtra)] } }), at: clock, ...top });
      const scenario = async (name, { status: given, item = { jobId: JOB, stage: 'resume', corrections: [] }, api = {}, check }) => {
        await withDom(async window => withConsoleCollector(async entries => {
          const calls = []; const timers = new Set();
          const priorSetInterval = globalThis.setInterval; const priorClearInterval = globalThis.clearInterval;
          const priorCustomEvent = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent');
          Object.defineProperty(globalThis, 'CustomEvent', { configurable: true, writable: true, value: window.CustomEvent });
          globalThis.setInterval = (fn, ms) => { const id = priorSetInterval(fn, ms); timers.add(id); return id; };
          globalThis.clearInterval = id => { timers.delete(id); return priorClearInterval(id); };
          window.electronAPI = { handoffBridgeNewChat: async () => { calls.push('new'); return { success: true }; }, handoffBridgeContinueChat: async () => { calls.push('continue'); return { success: true }; }, ...api };
          const rootNode = bundle.module.createRoot(window.document.getElementById('root'));
          try {
            await bundle.module.act(async () => { rootNode.render(bundle.module.React.createElement(bundle.module.React.StrictMode, null, bundle.module.React.createElement(bundle.module.ProgressProbe, { status: given, item }))); await Promise.resolve(); });
            await check({ window, calls, timers, entries, rootNode, act: bundle.module.act });
          } finally {
            await bundle.module.act(async () => rootNode.unmount());
            globalThis.setInterval = priorSetInterval; globalThis.clearInterval = priorClearInterval;
            if (priorCustomEvent) Object.defineProperty(globalThis, 'CustomEvent', priorCustomEvent); else delete globalThis.CustomEvent;
          }
          assert(timers.size === 0, `${name}: every interval the component started must be cleared on unmount`);
          assert(entries.length === 0, `${name}: render must emit no console output: ${entries.map(entry => entry.args.join(' ')).join(' | ')}`);
        }));
      };
      const text = window => window.document.body.textContent;
      const live = window => window.document.querySelector('[role="status"][aria-live="polite"]');
      const button = (window, label) => [...window.document.querySelectorAll('button')].find(item => item.textContent.trim() === label);
      try {
        bundle = await withTimeout(bundleComponent(entry, { signal: controller.signal }), 8000);

        await scenario('awaiting-first-call', {
          status: view({ servedToChat: null, stage: 'evidence-plan' }, { state: 'awaiting-first-call', calls: 0, lastCallAt: null, firstCallAt: null, outstanding: null }),
          item: { jobId: JOB, stage: 'evidence-plan' },
          async check({ window, calls, timers, act }) {
            assert(window.document.querySelector('section[aria-label="ChatGPT progress"]'), 'the progress region must be labelled');
            assert(text(window).includes('Waiting for chat 1'), 'first-call headline');
            const list = window.document.querySelector('ol[aria-label="Application steps"]');
            assert(list && list.querySelectorAll('li').length === 4, 'the stepper is an ordered list of four steps');
            assert(!/Last heard|\bfor \d/.test(text(window)), 'a chat that never called has no timer line');
            assert(timers.size === 0, `no timer anchors means no interval while mounted: ${timers.size}`);
            const current = [...list.querySelectorAll('li[aria-current="step"]')];
            assert(current.length === 1 && current[0].textContent.includes('Evidence plan') && current[0].textContent.includes('current step'), 'exactly one step is aria-current, and its state is also text');
            const start = button(window, 'Copy starter');
            assert(start && !start.disabled, 'the first-call state offers the panel\'s Copy starter button');
            await act(async () => { start.click(); await Promise.resolve(); await Promise.resolve(); });
            assert(calls.join() === 'new', `the button must call the existing handoffBridgeNewChat exactly once: ${calls}`);
            assert(text(window).includes('Copied. Now switch to ChatGPT, open a new chat, type @ and pick Infinite Canvas, then paste and send.'), 'a successful start tells the person what was copied');
          },
        });

        await scenario('awaiting-first-call: a second press re-copies without a renderer confirmation', {
          status: view({ servedToChat: null, stage: 'evidence-plan' }, { state: 'awaiting-first-call', calls: 0, lastCallAt: clock - 5000, firstCallAt: null, outstanding: null }),
          item: { jobId: JOB, stage: 'evidence-plan' },
          api: { handoffBridgeNewChat: async () => ({ success: true, copied: true, recopied: true, chatOrdinal: 1 }) },
          async check({ window, act }) {
            await act(async () => { button(window, 'Copy starter').click(); await Promise.resolve(); await Promise.resolve(); });
            assert(!text(window).includes('Copy a starter for a new chat?'), 'an unused chat never asks for confirmation, even with a recent timestamp');
            assert(text(window).includes('Copied again: the same starter for chat 1. Paste it into a new ChatGPT chat with Infinite Canvas selected.'), `the note says it was a re-copy: ${text(window)}`);
          },
        });

        await scenario('awaiting-first-call: main rotated after all, so the note is the ordinary one', {
          status: view({ servedToChat: null, stage: 'evidence-plan' }, { state: 'awaiting-first-call', calls: 0, lastCallAt: null, firstCallAt: null, outstanding: null }),
          item: { jobId: JOB, stage: 'evidence-plan' },
          api: { handoffBridgeNewChat: async () => ({ success: true, copied: true, chatOrdinal: 2 }) },
          async check({ window, act }) {
            await act(async () => { button(window, 'Copy starter').click(); await Promise.resolve(); await Promise.resolve(); });
            assert(text(window).includes('Copied. Now switch to ChatGPT, open a new chat, type @ and pick Infinite Canvas, then paste and send.') && !text(window).includes('Copied again'), 'main decision wins: no re-copy claim when main rotated');
          },
        });

        await scenario('writing the resume', {
          status: view({}, {}),
          async check({ window, timers, act }) {
            const region = live(window);
            assert(region && region.getAttribute('aria-live') === 'polite' && region.textContent.includes('ChatGPT is working on: Résumé') && region.textContent.includes('In progress'), 'the headline and its tone word sit in the polite live region');
            assert([...window.document.querySelectorAll('[role="status"], [aria-live]')].every(item => !item.textContent.includes('Last heard') && !/\bfor \d/.test(item.textContent)), 'the ticking timer lines must stay outside every live region');
            const states = [...window.document.querySelectorAll('ol[aria-label="Application steps"] li')].map(item => item.textContent);
            assert(states[0].includes('done') && states[1].includes('current step') && states[2].includes('not started yet'), `step states must be text, not colour alone: ${states.join(' | ')}`);
            assert(/for 2 min/.test(text(window)) && /Last heard from ChatGPT (just now|\d+s ago)/.test(text(window)), `elapsed and last-heard lines: ${text(window)}`);
            assert(!window.document.querySelector('button'), 'a job ChatGPT is writing needs no button');
            assert(timers.size === 1, `exactly one interval while mounted with timer lines: ${timers.size}`);
            const realNow = Date.now; Date.now = () => realNow() + 90000;
            try {
              await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
              assert(/for 3 min/.test(text(window)) && /Last heard from ChatGPT 1 min ago/.test(text(window)), `the timer lines must tick with the clock: ${text(window)}`);
            } finally { Date.now = realNow; }
          },
        });

        await scenario('stalled', {
          // The engine's stalledSince is when the quiet BEGAN (here the serve), not when it crossed the 5 minute threshold.
          status: view({ servedAt: clock - 9 * 60000, stalled: true, stalledSince: clock - 9 * 60000 }, { outstanding: { servedAt: clock - 9 * 60000, kind: 'application', stage: 'resume', stalled: true, stalledSince: clock - 9 * 60000, stallsLastHour: 1 }, lastCallAt: clock - 20000 }),
          async check({ window, calls, act }) {
            assert(live(window).textContent.includes('Needs attention') && live(window).textContent.includes('ChatGPT has been quiet for 9 min'), 'stalled is worded and toned in text, with the real quiet age (served 9 minutes ago)');
            assert(/for 9 min/.test(text(window)), `and its timer line agrees: ${text(window)}`);
            const start = button(window, 'Copy chat starter'); assert(start, 'stalled offers Copy chat starter');
            await act(async () => { start.click(); await Promise.resolve(); await Promise.resolve(); });
            assert(calls.join() === 'new', `Copy chat starter directly calls handoffBridgeNewChat for an active chat: ${calls}`);
            assert(!text(window).includes('Copy a starter for a new chat?') && !text(window).includes('Keep chat 1'),
              'an active chat never produces a renderer confirmation');
          },
        });

        await scenario('ended chat is continued', {
          status: view({ servedToChat: null }, { state: 'ended' }),
          async check({ window, calls, timers, act }) {
            assert(timers.size === 1, `a last-heard line alone still ticks: ${timers.size}`);
            const next = button(window, 'Copy Continue'); assert(next, 'an ended chat offers Copy Continue');
            await act(async () => { next.click(); await Promise.resolve(); await Promise.resolve(); });
            assert(calls.join() === 'continue' && text(window).includes('Copied. Now switch to ChatGPT, paste it into the existing chat, and send.'), 'Copy Continue calls the existing handoffBridgeContinueChat with no confirmation');
          },
        });

        await scenario('needs_user', {
          status: view({ phase: 'needs_user', reason: 'write_failed' }, {}),
          async check({ window, timers }) {
            assert(timers.size === 1 && /for 10 min/.test(text(window)) && !text(window).includes('Last heard'), `a since-only view ticks one interval: ${timers.size} ${text(window)}`);
            assert(live(window).textContent.includes('Problem') && live(window).textContent.includes('This job needs you') && live(window).textContent.includes('The app could not save this answer.'), 'needs_user names the problem in text');
            assert(!window.document.querySelector('button'), 'needs_user offers no chat button');
            assert(window.document.querySelectorAll('li[aria-current="step"]').length === 1, 'the stopped step is still marked');
          },
        });

        await scenario('a disabled bridge cannot start a chat', {
          status: view({ servedToChat: null }, { state: 'full' }, { serving: 'off' }),
          async check({ window, calls, act }) {
            const start = button(window, 'Copy chat starter'); assert(start && start.disabled, 'the panel\'s gate (live, reachable, linked) also disables this button');
            await act(async () => { start.click(); await Promise.resolve(); });
            assert(calls.length === 0, 'a disabled button must not call IPC');
          },
        });

        const setupWith = patch => ({ setup: { ...status(1).setup, ...patch } });
        for (const [label, top] of [
          ['the tunnel is unreachable', setupWith({ tunnelReachable: false })],
          ['ChatGPT is not linked', setupWith({ linked: false })],
          ['the bridge is turned off', { enabled: false }],
          ['the bridge is paused', { paused: true }],
        ]) {
          await scenario(`the button is gated when ${label}`, {
            // A held restart is the one stopped state that still offers a chat button, even while paused.
            status: view({ phase: 'held', reason: 'restart' }, { state: 'full' }, top),
            async check({ window, calls, act }) {
              const start = button(window, 'Copy chat starter'); assert(start && start.disabled, `the panel's whole gate applies: ${label}`);
              await act(async () => { start.click(); await Promise.resolve(); });
              assert(calls.length === 0, `no IPC while ${label}`);
            },
          });
        }
        await scenario('the same button is enabled when every gate passes', {
          status: view({ phase: 'held', reason: 'restart' }, { state: 'full' }),
          async check({ window }) { const start = button(window, 'Copy chat starter'); assert(start && !start.disabled, 'the gate opens when the bridge is live, reachable, linked and not paused'); },
        });
        await scenario('a paused bridge is forwarded to the derivation', {
          status: view({}, {}, { paused: true }),
          async check({ window }) {
            assert(live(window).textContent.includes('Paused') && live(window).textContent.includes('Needs attention') && !live(window).textContent.includes('ChatGPT is working on'), `a paused bridge must not read as being written: ${live(window).textContent}`);
          },
        });
        await scenario('an unread job never claims the app is reading it', {
          status: view({ phase: 'unread', servedToChat: null }, {}),
          async check({ window }) {
            assert(live(window).textContent.includes('Not read yet') && !/reading/i.test(live(window).textContent), `unread copy: ${live(window).textContent}`);
            assert(!window.document.querySelector('button'), 'a job behind a working chat needs no button');
          },
        });
        await scenario('a full chat that holds the job keeps the working line and offers no new chat', {
          status: view({}, { state: 'full' }),
          async check({ window }) {
            assert(live(window).textContent.includes('ChatGPT is working on: Résumé') && live(window).textContent.includes('at its limit'), live(window).textContent);
            assert(!window.document.querySelector('button'), 'no Copy chat starter while ChatGPT may be answering');
          },
        });
        await scenario('a host job does not claim ChatGPT answered everything', {
          status: view({ phase: 'host', stage: null }, {}),
          item: { jobId: JOB },
          async check({ window }) {
            assert(live(window).textContent.includes('The app is saving this') && !live(window).textContent.includes('ChatGPT'), live(window).textContent);
            assert(window.document.querySelectorAll('ol[aria-label="Application steps"] li svg').length === 0, 'no step shows the done tick');
          },
        });

        await scenario('an accepted answer with the next stage not yet served is not "ChatGPT is working"', {
          status: view({ stage: 'cover-letter', servedAt: null, awaitingAnswer: false, answeredAt: clock - 30000 }, {}),
          item: { jobId: JOB, stage: 'cover-letter', corrections: [] },
          async check({ window, timers }) {
            assert(live(window).textContent.includes('Queued for ChatGPT') && !live(window).textContent.includes('ChatGPT is working on'), `served-but-answered must read as queued: ${live(window).textContent}`);
            assert(!/\bfor \d/.test(text(window)), 'and claims no elapsed "working" timer');
            assert(timers.size === 1 && /Last heard from ChatGPT/.test(text(window)), 'only the chat\'s last-heard line remains');
          },
        });
        await scenario('a second job\'s timer and stall are its own, not the chat\'s first outstanding lane', {
          status: view({ servedAt: clock - 60000 }, { jobsAssigned: 2, outstanding: { servedAt: clock - 20 * 60000, kind: 'application', stage: 'evidence-plan', stalled: true, stalledSince: clock - 15 * 60000, stallsLastHour: 1 } }),
          async check({ window }) {
            assert(live(window).textContent.includes('ChatGPT is working on: Résumé') && !live(window).textContent.includes('quiet'), `another lane's stall must not paint this job stalled: ${live(window).textContent}`);
            assert(/for 1 min/.test(text(window)) && !/for 20 min/.test(text(window)), `the elapsed line is this job's own hand-over time: ${text(window)}`);
          },
        });

        await scenario('the timer refreshes the clock the moment its lines appear', {
          status: view({ servedToChat: null }, { state: 'awaiting-first-call', calls: 0, lastCallAt: null, firstCallAt: null, outstanding: null }),
          async check({ window, rootNode, timers, act }) {
            assert(timers.size === 0, 'no lines, no interval');
            const realNow = Date.now; Date.now = () => realNow() + 90000;
            try {
              // Same root element type as the first render, so this is an update and not a remount.
              const React = bundle.module.React;
              await act(async () => { rootNode.render(React.createElement(React.StrictMode, null, React.createElement(bundle.module.ProgressProbe, { status: view({}, {}), item: { jobId: JOB, stage: 'resume', corrections: [] } }))); await Promise.resolve(); });
              assert(/for 3 min/.test(text(window)), `the first frame after the lines appear must already use the current clock, not the mount-time one: ${text(window)}`);
              assert(timers.size === 1, 'the interval starts once there is a line to update');
            } finally { Date.now = realNow; }
          },
        });

        await scenario('a double click starts one chat, and the button works again afterwards', {
          status: view({ servedToChat: null }, { state: 'ended', lastCallAt: clock - 600000 }),
          async check({ window, calls, act }) {
            let release; const gate = new Promise(resolve => { release = resolve; });
            window.electronAPI.handoffBridgeContinueChat = async () => { calls.push('continue'); await gate; return { success: true }; };
            const next = button(window, 'Copy Continue');
            await act(async () => { next.click(); next.click(); await Promise.resolve(); });
            assert(calls.join() === 'continue', `two synchronous clicks must call the IPC once: ${calls}`);
            assert(button(window, 'Copy Continue').disabled, 'the button is disabled while its call is pending');
            await act(async () => { button(window, 'Copy Continue').click(); await Promise.resolve(); });
            assert(calls.length === 1, 'a click while pending is ignored');
            await act(async () => { release(); await gate; await Promise.resolve(); await Promise.resolve(); });
            assert(!button(window, 'Copy Continue').disabled && text(window).includes('Copied. Now switch to ChatGPT, paste it into the existing chat, and send.'), 'the button is free again once the call settles');
            await act(async () => { button(window, 'Copy Continue').click(); await Promise.resolve(); await Promise.resolve(); });
            assert(calls.length === 2, 'a later click goes through');
          },
        });
        await scenario('a double click on Copy chat starter calls the IPC once', {
          status: view({ phase: 'held', reason: 'restart' }, { state: 'full', lastCallAt: clock - 600000 }),
          async check({ window, calls, act }) {
            const start = button(window, 'Copy chat starter');
            await act(async () => { start.click(); start.click(); await Promise.resolve(); await Promise.resolve(); });
            assert(calls.join() === 'new', `a fast double click must not mint two chats: ${calls}`);
          },
        });
        await scenario('a failed call frees the button too', {
          status: view({ servedToChat: null }, { state: 'ended' }),
          api: { handoffBridgeContinueChat: async () => { throw new Error('boom'); } },
          async check({ window, act }) {
            await act(async () => { button(window, 'Copy Continue').click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
            assert(!button(window, 'Copy Continue').disabled, 'a rejected IPC must still clear the busy state');
          },
        });

        await scenario('a failed action reports the shared error copy', {
          status: view({ servedToChat: null }, { state: 'ended' }),
          api: { handoffBridgeContinueChat: async () => ({ success: false, code: 'NO_CHAT', message: 'PRIVATE DETAIL' }) },
          async check({ window, act }) {
            await act(async () => { button(window, 'Copy Continue').click(); await Promise.resolve(); await Promise.resolve(); });
            assert(text(window).includes(IPC_ERROR_COPY.NO_CHAT) && !text(window).includes('PRIVATE DETAIL'), 'failures show closed IPC copy only');
          },
        });

        for (const [label, given, item] of [
          ['hostile raw status', { queue: { jobs: 'x' }, chat: 7, paused: 'yes' }, { jobId: JOB, corrections: 5 }],
          ['undefined status and item', undefined, undefined],
          ['unknown phase', normalizeBridgeStatus({ ...status(1, { queue: { jobs: [job({ phase: 'weird' })] } }), at: clock }), { jobId: JOB }],
          ['job missing from queue', view({}, {}), { jobId: '22222222-2222-4222-8222-222222222222' }],
        ]) {
          await scenario(`malformed: ${label}`, {
            status: given, item,
            async check({ window }) {
              assert(live(window).textContent.includes('Checking on this job'), `${label} must degrade to the neutral generic line`);
              assert(window.document.querySelectorAll('ol[aria-label="Application steps"] li').length === 4 && !window.document.querySelector('button'), 'the stepper still renders and no action is offered');
            },
          });
        }
      } finally { controller.abort(); await bundle?.dispose(); await fsPromises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'handoff bridge: render: the per-job answer fields are sanitised to times and booleans, and nothing else about a job passes',
    run() {
      const JOB = '11111111-1111-4111-8111-111111111111';
      const jobs = normalizeBridgeStatus(status(1, { queue: { jobs: [
        { jobId: JOB, phase: 'awaiting', servedAt: NOW, answeredAt: NOW - 5, awaitingAnswer: true, stalled: true, stalledSince: NOW + 1, leak: 'PRIVATE_PROMPT' },
        { jobId: '22222222-2222-4222-8222-222222222222', phase: 'awaiting', servedAt: 'yesterday', answeredAt: -1, awaitingAnswer: 'true', stalled: 1, stalledSince: NaN },
        { jobId: '33333333-3333-4333-8333-333333333333', phase: 'awaiting' },
      ] } })).queue.jobs;
      const [first, second, third] = jobs;
      assert(first.servedAt === NOW && first.answeredAt === NOW - 5 && first.awaitingAnswer === true && first.stalled === true && first.stalledSince === NOW + 1, 'valid per-job fields pass');
      assert(second.servedAt === null && second.answeredAt === null && second.awaitingAnswer === false && second.stalled === false && second.stalledSince === null,
        'a non-time is null and a non-boolean is false (a truthy string or 1 is not proof)');
      assert(third.servedAt === null && third.awaitingAnswer === false && third.stalled === false, 'absent fields default to no claim');
      assert(!JSON.stringify(jobs).includes('PRIVATE_PROMPT'), 'unknown job keys still die in the normaliser');
    },
  },
  {
    name: 'handoff bridge: render: the real dock hides the paste UI only while ChatGPT holds the job; a kept, handed-back, gone or finished lane shows the normal paste UI',
    async run() {
      const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ic-bridge-dock-gate-'));
      const entry = path.join(directory, 'DockGateProbe.jsx');
      const dialog = path.resolve('src/components/NonApiAiDialog.jsx'); const dockStore = path.resolve('src/utils/applicationHandoffDock.js'); const bridgeStore = path.resolve('src/utils/handoffBridgeStore.js');
      await fsPromises.writeFile(entry, `import React from 'react';\nimport { NonApiAiDialog } from ${JSON.stringify(dialog)};\nexport { publishApplicationHandoffs, applicationDockRequest, __resetApplicationHandoffsForTests } from ${JSON.stringify(dockStore)};\nexport { applyHandoffBridgeStatus, __resetHandoffBridgeStoreForTests } from ${JSON.stringify(bridgeStore)};\nexport function DockGateProbe() { return <NonApiAiDialog />; }\n`);
      const controller = new AbortController(); let bundle;
      const JOB = '11111111-1111-4111-8111-111111111111';
      const laneStatus = (seq, phase) => status(seq, { queue: { jobs: phase ? [{ jobId: JOB, phase, stage: 'resume', reason: phase === 'held' ? 'user_hold' : null, servedToChat: null, changedAt: NOW }] : [] } });
      try {
        bundle = await withTimeout(bundleComponent(entry, { signal: controller.signal }), 20000);
        const seen = {};
        for (const phase of [null, 'held', 'needs_user', 'gone', 'done', 'unread', 'awaiting', 'host']) {
          await withDom(async window => withConsoleCollector(async entries => {
            const priorCustomEvent = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent');
            Object.defineProperty(globalThis, 'CustomEvent', { configurable: true, writable: true, value: window.CustomEvent });
            window.electronAPI = {
              handoffBridgeGetStatus: async () => ({ status: laneStatus(1, phase) }), onHandoffBridgeStatus: () => () => {}, handoffBridgeGetActivity: async () => ({ items: [] }), handoffBridgePublishJobs: () => undefined,
              onNonApiAiRequest: () => () => {}, onNonApiAiSettled: () => () => {}, onNonApiAiCancelled: () => () => {},
            };
            bundle.module.__resetHandoffBridgeStoreForTests(); bundle.module.__resetApplicationHandoffsForTests();
            const rootNode = bundle.module.createRoot(window.document.getElementById('root'));
            try {
              const item = bundle.module.applicationDockRequest({
                node: { id: 'node-1', data: { title: 'Engineer', company: 'Acme', localApplication: { id: JOB, mode: 'paste', status: 'queued', stage: 'resume' } } },
                handoff: { jobId: JOB, stage: 'resume', revision: 1, handoffCode: 'CODE-123', prompt: 'SYNTHETIC_STAGE_PROMPT', draft: '' },
              });
              assert(item, 'the dock item builds');
              await bundle.module.act(async () => {
                rootNode.render(bundle.module.React.createElement(bundle.module.DockGateProbe));
                bundle.module.applyHandoffBridgeStatus(laneStatus(2, phase));
                bundle.module.publishApplicationHandoffs([item]);
                await Promise.resolve(); await Promise.resolve();
              });
              // The dock starts collapsed to one "Pending AI handoffs" button.
              const openButton = window.document.querySelector('button[aria-expanded="false"]');
              assert(openButton && /Pending AI handoffs/.test(openButton.textContent), 'the collapsed dock offers its expand button');
              await bundle.module.act(async () => { openButton.click(); await Promise.resolve(); });
              const text = window.document.body.textContent;
              seen[phase] = { working: text.includes('Handed to ChatGPT'), noPasteWording: !/No paste/i.test(text), chip: text.includes('CODE-123'), paste: text.includes('SYNTHETIC_STAGE_PROMPT') || Boolean(window.document.querySelector('textarea')) };
            } finally {
              await bundle.module.act(async () => rootNode.unmount());
              if (priorCustomEvent) Object.defineProperty(globalThis, 'CustomEvent', priorCustomEvent); else delete globalThis.CustomEvent;
            }
            assert(entries.length === 0, `the dock must render without console output (${phase}): ${entries.map(entry => entry.args.join(' ')).join(' | ')}`);
          }));
        }
        for (const phase of [null, 'held', 'needs_user', 'gone', 'done']) {
          assert(seen[phase].paste && !seen[phase].working, `a job in phase ${phase} must show the normal paste UI, not "Handed to ChatGPT": ${JSON.stringify(seen[phase])}`);
          assert(seen[phase].chip, `a paste-flow item (${phase}) keeps its handoff-code chip: ${JSON.stringify(seen[phase])}`);
        }
        for (const phase of ['unread', 'awaiting', 'host']) {
          assert(seen[phase].working && !seen[phase].paste, `a job ChatGPT holds (${phase}) shows the working state and no paste UI: ${JSON.stringify(seen[phase])}`);
          assert(!seen[phase].chip && seen[phase].noPasteWording, `a job ChatGPT holds (${phase}) hides the handoff-code chip and never says "No paste": ${JSON.stringify(seen[phase])}`);
        }
      } finally { controller.abort(); await bundle?.dispose(); await fsPromises.rm(directory, { recursive: true, force: true }); __resetHandoffBridgeStoreForTests(); }
    },
  },
];
