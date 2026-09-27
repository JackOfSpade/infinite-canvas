import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assert } from './testHelpers.js';
import { bundleComponent } from './fixtures/handoff-bridge/mountComponent.js';
import { mountInStrictMode } from './fixtures/handoff-bridge/renderHarness.js';
import { withTimeout } from './fixtures/handoff-bridge/harness.js';

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
];
