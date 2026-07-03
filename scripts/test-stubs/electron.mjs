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
import os from 'node:os';
import path from 'node:path';

const userDataDir = path.join(os.tmpdir(), 'infinite-canvas-test-stub');

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

export const ipcMain = {
  handle: () => {},
  handleOnce: () => {},
  removeHandler: () => {},
  on: () => {},
  once: () => {},
  removeListener: () => {},
  removeAllListeners: () => {},
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

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (s) => Buffer.from(s, 'utf8'),
  decryptString: (buf) => Buffer.from(buf).toString('utf8'),
};

const electron = {
  app, ipcMain, dialog, shell, BrowserWindow, BrowserView, protocol, Menu,
  nativeImage, contextBridge, ipcRenderer, safeStorage,
};

export default electron;
