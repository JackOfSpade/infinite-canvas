import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bundleComponent, withDom } from './fixtures/handoff-bridge/mountComponent.js';

async function withAutosave(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ic-autosave-test-'));
  const entry = path.join(directory, 'AutosaveProbe.jsx');
  await fs.writeFile(entry, `import { useCanvasInitialization } from ${JSON.stringify(path.resolve('src/hooks/useCanvasInitialization.js'))};
export { EventLogger } from ${JSON.stringify(path.resolve('src/utils/EventLogger.js'))};
export function Probe(props) { useCanvasInitialization(props); return null; }`);
  let bundle;
  try {
    bundle = await bundleComponent(entry);
    await withDom(async window => {
      const { React, act, createRoot, Probe, EventLogger } = bundle.module;
      const root = createRoot(window.document.getElementById('root'));
      const nativeSetTimeout = globalThis.setTimeout;
      const nativeClearTimeout = globalThis.clearTimeout;
      const timers = new Map();
      let sequence = 0;
      globalThis.setTimeout = (fn, ms, ...args) => {
        if (ms >= 500) { const id = ++sequence; timers.set(id, { fn: () => fn(...args), ms }); return id; }
        return nativeSetTimeout(fn, ms, ...args);
      };
      globalThis.clearTimeout = id => { if (!timers.delete(id)) nativeClearTimeout(id); };
      const writes = [], toasts = [], dirty = [], dismissed = [];
      const props = {
        nodes: [{ id: 'note', type: 'text', position: { x: 0, y: 0 }, data: { text: 'Unsaved revision' } }],
        edges: [], drawings: [], currentFile: '/workspace/canvas.json',
        hasUnsavedChanges: true, setCurrentFile: () => {}, setHasUnsavedChanges: value => dirty.push(value),
        saveStateRef: { current: 'idle' }, saveOperationRef: { current: null },
        quitGateRef: { current: { generation: 0, frozen: false } },
        addToast: value => { toasts.push(value); return `toast-${toasts.length}`; },
        removeToast: value => dismissed.push(value),
      };
      let write = async () => ({ success: true, filePath: props.currentFile });
      window.electronAPI = { saveWorkspace: async args => { writes.push(args); return write(args); } };
      const render = async patch => { Object.assign(props, patch); await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Probe, props)))); };
      const fire = async () => {
        const next = timers.entries().next().value;
        assert.ok(next, 'autosave has a scheduled attempt');
        timers.delete(next[0]);
        await act(async () => { await next[1].fn(); });
        return next[1].ms;
      };
      try {
        await render({});
        await run({ props, writes, toasts, dirty, dismissed, timers, fire, render, EventLogger, setWrite: next => { write = next; } });
      } finally {
        await act(async () => root.unmount());
        globalThis.setTimeout = nativeSetTimeout;
        globalThis.clearTimeout = nativeClearTimeout;
      }
    });
  } finally { await bundle?.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
}

export default [
  { name: 'Autosave retries a transient host path refusal without another edit and releases the writer lock', async run() {
    await withAutosave(async ({ props, writes, dirty, toasts, fire, setWrite, EventLogger }) => {
      setWrite(async () => writes.length === 1
        ? { success: false, errorCode: 'RENDERER_WORKSPACE_PATH_CHANGED', error: 'Path changed during inspection.' }
        : { success: true, filePath: props.currentFile });
      await fire();
      assert.equal(props.saveStateRef.current, 'idle');
      assert.equal(props.saveOperationRef.current, null);
      assert.equal(EventLogger.getLastSaveError().filePath, props.currentFile);
      assert.ok(!dirty.includes(false), 'a refused write cannot mark changes clean');
      await fire();
      assert.equal(writes.length, 2);
      assert.equal(dirty.at(-1), false);
      assert.equal(toasts.length, 0, 'briefly recovering failures do not raise a persistent-failure warning');
    });
  } },
  { name: 'Autosave backs off sustained failures, warns once, and recovers without another edit', async run() {
    await withAutosave(async ({ props, writes, dirty, dismissed, toasts, timers, fire, render, setWrite }) => {
      setWrite(async () => ({ success: false, errorCode: 'ENOSPC', error: 'Disk full.' }));
      const delays = [];
      for (let index = 0; index < 4; index++) delays.push(await fire());
      assert.deepEqual(delays.slice(1), [2000, 5000, 15000]);
      assert.equal(writes.length, 4);
      assert.equal(timers.size, 1, 'persistent failures retain a low-frequency recovery check');
      assert.ok(!dirty.includes(false));
      assert.deepEqual(toasts.map(item => item.title), ['Auto-save Failed']);
      assert.equal(toasts[0].duration, 0, 'the unsaved warning stays visible until dismissed or recovered');
      assert.match(toasts[0].description, /still unsaved.*Disk full/);
      assert.match(toasts[0].description, /keep retrying/);
      for (let index = 0; index < 6; index++) assert.equal(await fire(), 30000);
      assert.equal(toasts.length, 1, 'long failures do not spam warnings');
      await render({ nodes: props.nodes.map(node => ({ ...node, data: { text: 'Later revision' } })) });
      await fire();
      assert.equal(toasts.length, 1, 'more edits do not spam warnings');
      setWrite(async () => ({ success: true, filePath: props.currentFile }));
      await fire();
      assert.equal(writes.at(-1).data.nodes[0].data.text, 'Later revision');
      assert.equal(dirty.at(-1), false);
      assert.equal(toasts.at(-1).title, 'Auto-save Restored');
      assert.deepEqual(dismissed, ['toast-1'], 'recovery removes the obsolete failure warning');
      assert.equal(timers.size, 0, 'a successful save stops recovery polling');
    });
  } },
  { name: 'Autosave retry cannot cross a workspace switch or write during a quit fence', async run() {
    await withAutosave(async ({ props, writes, timers, fire, render, setWrite }) => {
      setWrite(async () => ({ success: false, error: 'Temporary write refusal.' }));
      await fire();
      const oldRetry = timers.values().next().value.fn;
      await render({ currentFile: '/workspace/other.json', nodes: props.nodes.map(node => ({ ...node, data: { text: 'Other workspace' } })) });
      await oldRetry();
      assert.equal(writes.length, 1, 'a cancelled retry never writes old or new workspace bytes');
      props.quitGateRef.current.frozen = true;
      await fire();
      assert.equal(writes.length, 1, 'a quit fence prevents the retry from starting');
    });
  } },
  { name: 'Autosave retries thrown serialization and IPC failures without leaking an unhandled promise', async run() {
    await withAutosave(async ({ props, writes, dirty, fire, render, setWrite }) => {
      let flushes = 0;
      await render({ flushStack: () => { if (++flushes === 1) throw new Error('Snapshot busy'); return { nodes: props.nodes, edges: [], drawings: [] }; } });
      setWrite(async () => { if (writes.length === 1) throw new Error('IPC unavailable'); return { success: true, filePath: props.currentFile }; });
      await fire();
      assert.equal(writes.length, 0);
      await fire();
      assert.equal(props.saveStateRef.current, 'idle');
      await fire();
      assert.equal(writes.length, 2);
      assert.equal(dirty.at(-1), false);
    });
  } },
  { name: 'A successful manual save cancels queued autosave recovery and resets the retry allowance', async run() {
    await withAutosave(async ({ props, writes, timers, fire, render, setWrite }) => {
      setWrite(async () => ({ success: false, error: 'Temporary refusal.' }));
      await fire();
      await render({ hasUnsavedChanges: false });
      await fire();
      assert.equal(writes.length, 1, 'a manual save makes the queued retry unnecessary');
      await render({ hasUnsavedChanges: true, nodes: props.nodes.map(node => ({ ...node, data: { text: 'New edit after manual save' } })) });
      await fire();
      assert.equal(writes.length, 2);
      assert.equal(timers.size, 1, 'a later edit gets a fresh retry allowance');
    });
  } },
];
