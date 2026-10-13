import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assert } from './testHelpers.js';
import { bundleComponent, withDom } from './fixtures/handoff-bridge/mountComponent.js';

function setInput(window, input, value) {
  input.focus();
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  descriptor.set.call(input, value);
  input.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
}

function matchCount(window) {
  const badge = [...window.document.querySelectorAll('[data-search-bar] span')]
    .find(element => /^\d+ match(?:es)?$/.test(element.textContent.trim()));
  return badge?.textContent.trim() || null;
}

async function waitForMatchCount(act, window, expected) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (matchCount(window) === expected) return;
    await act(async () => new Promise(resolve => setTimeout(resolve, 25)));
  }
  assert(false, `expected ${expected}, got ${matchCount(window)}`);
}

export default [{
  name: 'canvas search: match count follows node edits without changing the query',
  run: async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ic-search-bar-'));
    const entry = path.join(directory, 'SearchBarProbe.jsx');
    const searchBarPath = path.resolve('src/components/SearchBar.jsx');
    await fs.writeFile(entry, `
      import React, { useEffect } from 'react';
      import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
      import { SearchBar } from ${JSON.stringify(searchBarPath)};
      export function SearchBarProbe({ onReady }) {
        return <ReactFlowProvider defaultNodes={[{ id: 'one', type: 'text', position: { x: 0, y: 0 }, data: { text: 'alpha' } }]} initialWidth={1000} initialHeight={700}>
          <Controller onReady={onReady} />
        </ReactFlowProvider>;
      }
      function Controller({ onReady }) {
        const flow = useReactFlow();
        useEffect(() => onReady(flow), [flow, onReady]);
        return <SearchBar />;
      }
    `);

    let bundle;
    try {
      await withDom(async window => {
        bundle = await bundleComponent(entry);
        const attachEventDescriptor = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'attachEvent');
        Object.defineProperty(window.HTMLElement.prototype, 'attachEvent', { configurable: true, value: () => {} });
        let flow;
        const root = bundle.module.createRoot(window.document.getElementById('root'));
        try {
          await bundle.module.act(async () => {
            root.render(bundle.module.React.createElement(bundle.module.SearchBarProbe, { onReady: next => { flow = next; } }));
          });
          assert(flow, 'the search probe mounted in a React Flow provider');
          const input = window.document.querySelector('[data-search-bar] input');
          assert(input, 'the search input rendered');

          await bundle.module.act(async () => setInput(window, input, 'alpha'));
          await waitForMatchCount(bundle.module.act, window, '1 match');

          await bundle.module.act(async () => flow.setNodes(nodes => nodes.map(node => ({ ...node, data: { text: 'beta' } }))));
          assert(flow.getNodes()[0]?.data?.text === 'beta', `React Flow updated the node text, got ${JSON.stringify(flow.getNodes())}`);
          await waitForMatchCount(bundle.module.act, window, '0 matches');

          await bundle.module.act(async () => flow.setNodes(nodes => [...nodes, {
            id: 'two', type: 'text', position: { x: 20, y: 20 }, data: { text: 'alpha again' },
          }]));
          await waitForMatchCount(bundle.module.act, window, '1 match');

          await bundle.module.act(async () => flow.setNodes([]));
          await waitForMatchCount(bundle.module.act, window, '0 matches');
        } finally {
          await bundle.module.act(async () => root.unmount());
          if (attachEventDescriptor) Object.defineProperty(window.HTMLElement.prototype, 'attachEvent', attachEventDescriptor);
          else delete window.HTMLElement.prototype.attachEvent;
        }
      });
    } finally {
      await bundle?.dispose();
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
}];
