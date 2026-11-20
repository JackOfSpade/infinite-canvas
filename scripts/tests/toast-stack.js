import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bundleComponent, withDom } from './fixtures/practice-connector/mountComponent.js';

async function stackBundle() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'toast-stack-'));
  const entry = path.join(directory, 'ToastProbe.jsx');
  const source = file => JSON.stringify(path.resolve(file));
  await fs.writeFile(entry, `
import React from ${source('node_modules/react/index.js')};
import { ToastProvider, useToast } from ${source('src/components/ToastProvider.jsx')};
function Grab({ onReady }) { onReady(useToast()); return null; }
export function ToastProbe({ onReady }) {
  return <ToastProvider><Grab onReady={onReady} /></ToastProvider>;
}
`);
  try { return { bundle: await bundleComponent(entry), directory }; }
  catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
}

export default [
  {
    name: 'toasts never auto-dismiss, stack newest on top, fan out on hover, and leave only by X or Clear all',
    async run() {
      const { bundle, directory } = await stackBundle();
      try {
        const { React, act, createRoot, ToastProbe } = bundle.module;
        await withDom(async window => {
          let api = null;
          const root = createRoot(window.document.getElementById('root'));
          await act(async () => root.render(React.createElement(ToastProbe, { onReady: value => { api = value; } })));
          const stack = () => window.document.querySelector('[data-testid="toast-stack"]');
          const titles = () => [...window.document.querySelectorAll('.text-sm.font-semibold')]
            .filter(node => !node.closest('[aria-hidden="true"]')).map(node => node.textContent);
          const dismiss = title => window.document.querySelector(`button[aria-label="Dismiss ${title}"]`);

          await act(async () => { api.addToast({ title: 'First', duration: 5 }); });
          await act(async () => new Promise(resolve => setTimeout(resolve, 40)));
          assert.deepEqual(titles(), ['First'], 'a toast with a duration is still shown after it elapses');

          await act(async () => {
            api.addToast({ title: 'Second' });
            api.addToast({ title: 'Third' });
            api.addToast({ title: 'Fourth' });
            api.addToast({ title: 'Fifth' });
          });
          assert.equal(stack().dataset.expanded, 'false');
          assert.deepEqual(titles(), ['Fifth'], 'collapsed: only the newest card shows its text');
          const behind = window.document.querySelectorAll('[data-testid="toast-stack"] [aria-hidden="true"][inert][data-stack-peek="true"] [data-testid="toast-stack-edge"]');
          assert.equal(behind.length, 3, 'three inert card edges peek out behind the top one');
          assert.match(stack().textContent, /\+4 more/);

          const frontX = dismiss('Fifth');
          await act(async () => {
            stack().firstElementChild.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, relatedTarget: window.document.body }));
          });
          assert.equal(stack().dataset.expanded, 'true', 'hover fans the stack out');
          assert.deepEqual(titles(), ['Fifth', 'Fourth', 'Third', 'Second', 'First']);
          assert.equal(dismiss('Fifth'), frontX, 'opening the stack keeps the same DOM nodes, so a focused X keeps focus');
          const order = [...stack().querySelectorAll('button')].map(node => node.textContent.trim() || node.getAttribute('aria-label'));
          assert.equal(order.at(-1), 'Clear all', 'Clear all sits below the cards, never where the top X was');

          await act(async () => dismiss('Third').click());
          assert.deepEqual(titles(), ['Fifth', 'Fourth', 'Second', 'First'], 'X removes only its own toast');

          const clearAll = [...window.document.querySelectorAll('button')].find(node => node.textContent.trim() === 'Clear all');
          await act(async () => clearAll.click());
          assert.deepEqual(titles(), []);

          await act(async () => { api.addToast({ title: 'Later A' }); api.addToast({ title: 'Later B' }); });
          assert.equal(stack().dataset.expanded, 'false', 'a new stack after Clear all starts collapsed');
          await act(async () => root.unmount());
        });
      } finally {
        await bundle.dispose();
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  },
];
