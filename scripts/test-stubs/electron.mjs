// Minimal stand-in for the `electron` package, used only when running
// scripts/test-runner.js under plain Node (never inside a real Electron
// process — the test runner is always invoked via `node`, not `electron`).
//
// Without this, importing `electron` in an environment where the Electron
// binary hasn't been downloaded (e.g. a network-restricted sandbox) throws
// synchronously at require-time, which cascades into every file that
// transitively imports electron/logger.js — including otherwise pure-logic
// modules the test runner exercises. See docs/code-quality-audit note in the
// PR description for the full trace. This stub is wired in via
// scripts/test-stubs/register.mjs (a Node loader hook), not by editing
// application source.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Each test process needs its own durable-looking userData directory: several
// application modules exercise real file persistence through app.getPath(). A
// fixed temp path lets concurrent `npm test` invocations overwrite each other.
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-canvas-test-stub-'));

// The app writes nested state below this directory during tests. Remove the
// whole process-private root synchronously once Node has completed the suite;
// failure here is harmless because the OS temp-directory policy remains a
// fallback and cleanup must never hide a test result.
process.once('exit', () => {
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 2 });
  } catch {
    // Best-effort cleanup only.
  }
});

export const app = {
  isPackaged: false,
  getPath: (name) => path.join(userDataDir, name),
  getName: () => 'infinite-canvas',
  getVersion: () => '0.0.0-test',
  whenReady: () => Promise.resolve(),
  on: () => {},
  once: () => {},
  quit: () => {},
  exit: () => {},
};

const invokeHandlers = new Map();

export const ipcMain = {
  handle: (channel, handler) => { invokeHandlers.set(channel, handler); },
  handleOnce: () => {},
  removeHandler: () => {},
  on: () => {},
  once: () => {},
  removeListener: () => {},
  removeAllListeners: () => {},
  __getInvokeHandler: (channel) => invokeHandlers.get(channel),
  __clearInvokeHandlers: () => invokeHandlers.clear(),
};

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
  showMessageBox: async () => ({ response: 0 }),
  showMessageBoxSync: () => 0,
  showErrorBox: () => {},
};

export const shell = {
  openExternal: async () => {},
  openPath: async () => '',
  showItemInFolder: () => {},
  trashItem: async () => {},
};

class StubWebContents {
  send() {}
  isDestroyed() { return false; }
  executeJavaScript() { return Promise.resolve(undefined); }
}

export class BrowserWindow {
  constructor() {
    this.webContents = new StubWebContents();
  }
  static getAllWindows() { return []; }
  static getFocusedWindow() { return null; }
  loadURL() { return Promise.resolve(); }
  loadFile() { return Promise.resolve(); }
  on() {}
  once() {}
  isDestroyed() { return false; }
  destroy() {}
  close() {}
}

export class BrowserView {
  constructor() {
    this.webContents = new StubWebContents();
  }
}

export const protocol = {
  handle: () => {},
  registerSchemesAsPrivileged: () => {},
};

export const Menu = {
  setApplicationMenu: () => {},
  buildFromTemplate: () => ({}),
};

export const nativeImage = {
  createFromPath: () => ({ isEmpty: () => true }),
  createEmpty: () => ({ isEmpty: () => true }),
};

export const contextBridge = {
  exposeInMainWorld: () => {},
};

export const ipcRenderer = {
  invoke: async () => undefined,
  send: () => {},
  on: () => {},
  removeListener: () => {},
};

let clipboardText = '';
export const clipboard = {
  writeText: (value) => { clipboardText = String(value); },
  readText: () => clipboardText,
};

// Not real encryption (this is a plain-Node test stub — no OS keychain to
// hook into) — a functional round-trip so callers exercising the real
// safeStorage.isEncryptionAvailable()===true code path get meaningful
// coverage, rather than only ever hitting the "unavailable" fallback branch.
export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(String(s), 'utf8'),
  decryptString: (buf) => Buffer.from(buf).toString('utf8'),
};

const electron = {
  app, ipcMain, dialog, shell, BrowserWindow, BrowserView, protocol, Menu,
  nativeImage, contextBridge, ipcRenderer, clipboard, safeStorage,
};

export default electron;
