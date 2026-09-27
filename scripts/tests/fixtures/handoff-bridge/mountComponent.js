import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { build, stop as stopEsbuild } from 'esbuild';
import { JSDOM } from 'jsdom';

function abortError() {
  const error = new Error('Component bundle aborted');
  error.name = 'AbortError';
  return error;
}

async function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) throw abortError();
  let abort;
  const aborted = new Promise((resolve, reject) => {
    abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export async function bundleComponent(entry, {
  signal,
  buildImpl = build,
  loadModule = url => import(url),
  onDirectory = () => undefined,
} = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ic-handoff-render-'));
  onDirectory(directory);
  const messageChannels = [];
  let messageChannelDescriptor;
  let messageChannelPatched = false;
  let disposePromise;
  const dispose = () => {
    if (!disposePromise) disposePromise = (async () => {
      signal?.removeEventListener('abort', onAbort);
      if (messageChannelPatched) {
        if (messageChannelDescriptor) Object.defineProperty(globalThis, 'MessageChannel', messageChannelDescriptor);
        else delete globalThis.MessageChannel;
        messageChannelPatched = false;
      }
      for (const channel of messageChannels) {
        channel.port1?.close?.();
        channel.port2?.close?.();
      }
      stopEsbuild();
      await fs.rm(directory, { recursive: true, force: true });
    })();
    return disposePromise;
  };
  const onAbort = () => { void dispose(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const throwIfAborted = () => { if (signal?.aborted) throw abortError(); };
  try {
    throwIfAborted();
    const outfile = path.join(directory, 'bundle.mjs');
    // Keeping these imports in the entry makes React, createRoot and act come
    // from the same bundled module graph as the component under test.
    const wrapper = path.join(directory, 'entry.mjs');
    const target = path.resolve(entry);
    const require = createRequire(import.meta.url);
    const react = require.resolve('react');
    const reactDom = require.resolve('react-dom/client');
    const nodeModules = path.dirname(path.dirname(react));
    await fs.writeFile(wrapper, `import React, { act } from ${JSON.stringify(react)};\nimport { createRoot } from ${JSON.stringify(reactDom)};\nexport { React, act, createRoot };\nexport * from ${JSON.stringify(target)};\n`);
    await raceAbort(buildImpl({
      entryPoints: [wrapper], bundle: true, platform: 'node', format: 'esm', outfile,
      banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url); const __icImportMetaGlob = () => ({}); const __icImportMetaEnv = {};" },
      define: { 'import.meta.glob': '__icImportMetaGlob', 'import.meta.env': '__icImportMetaEnv' },
      nodePaths: [nodeModules],
      logLevel: 'silent',
    }), signal);
    throwIfAborted();
    messageChannelDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'MessageChannel');
    const NativeMessageChannel = globalThis.MessageChannel;
    if (typeof NativeMessageChannel === 'function') {
      class TrackedMessageChannel extends NativeMessageChannel {
        constructor(...args) {
          super(...args);
          messageChannels.push(this);
        }
      }
      Object.defineProperty(globalThis, 'MessageChannel', { configurable: true, writable: true, value: TrackedMessageChannel });
      messageChannelPatched = true;
    }
    const bundledModule = await raceAbort(loadModule(`${pathToFileURL(outfile).href}?t=${Date.now()}`), signal);
    throwIfAborted();
    return Object.freeze({
      directory,
      outfile,
      module: bundledModule,
      dispose,
    });
  } catch (error) {
    await dispose();
    throw error;
  }
}

export async function withDom(fn) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://example.com/' });
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'IS_REACT_ACT_ENVIRONMENT'];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const values = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: callback => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  try {
    for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
    return await fn(dom.window);
  } finally {
    for (const key of keys) {
      const descriptor = previous.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  }
}
