import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assert } from './testHelpers.js';
import { bundleComponent, withDom } from './fixtures/handoff-bridge/mountComponent.js';

export default [
  {
    name: 'issue reporter: blank descriptions leave both report delivery actions available',
    run: async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ic-issue-reporter-'));
      const entry = path.join(directory, 'IssueReporterProbe.jsx');
      const component = path.resolve('src/components/IssueReporterDialog.jsx');
      await fs.writeFile(entry, `import React from 'react';\nimport { IssueReporterDialog } from ${JSON.stringify(component)};\nexport const submissions = [];\nexport function IssueReporterProbe() { return <IssueReporterDialog isOpen={true} onClose={() => {}} onSubmit={async (...args) => { submissions.push(args); }} />; }\n`);
      let bundle;
      try {
        bundle = await bundleComponent(entry);
        await withDom(async window => {
          const storageDescriptors = new Map(['localStorage', 'sessionStorage', 'Event', 'CustomEvent']
            .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
          Object.defineProperties(globalThis, {
            localStorage: { configurable: true, writable: true, value: window.localStorage },
            sessionStorage: { configurable: true, writable: true, value: window.sessionStorage },
            Event: { configurable: true, writable: true, value: window.Event },
            CustomEvent: { configurable: true, writable: true, value: window.CustomEvent },
          });
          const attachEventDescriptor = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'attachEvent');
          Object.defineProperty(window.HTMLElement.prototype, 'attachEvent', { configurable: true, value: () => {} });
          const root = bundle.module.createRoot(window.document.getElementById('root'));
          try {
            await bundle.module.act(async () => {
              root.render(bundle.module.React.createElement(bundle.module.IssueReporterProbe));
            });
            const copy = [...window.document.querySelectorAll('button')]
              .find(button => button.textContent.includes('Copy to Clipboard'));
            const save = [...window.document.querySelectorAll('button')]
              .find(button => button.textContent.includes('Save to File'));
            assert(copy && save && !copy.disabled && !save.disabled,
              'blank descriptions must not disable Copy to Clipboard or Save to File');

            const form = window.document.querySelector('form');
            assert(form, 'the issue reporter must render its delivery form');
            await bundle.module.act(async () => {
              form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
            });
            assert(bundle.module.submissions.length === 1
              && bundle.module.submissions[0][0] === ''
              && bundle.module.submissions[0][2] === 'clipboard',
            `the blank description must reach the selected delivery path, got ${JSON.stringify(bundle.module.submissions)}`);
          } finally {
            await bundle.module.act(async () => root.unmount());
            for (const [key, descriptor] of storageDescriptors) {
              if (descriptor) Object.defineProperty(globalThis, key, descriptor);
              else delete globalThis[key];
            }
            if (attachEventDescriptor) Object.defineProperty(window.HTMLElement.prototype, 'attachEvent', attachEventDescriptor);
            else delete window.HTMLElement.prototype.attachEvent;
          }
        });
      } finally {
        await bundle?.dispose();
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  },
];
