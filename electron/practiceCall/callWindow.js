import path from 'node:path';
import { pathToFileURL } from 'node:url';
import electronPkg from 'electron';
import { createCallStore, isPracticeCallId } from './callStore.js';
import { createPracticeCallService } from './callService.js';
import { createReplayHandler } from './replayProtocol.js';

// Same import as interviewWindow.js: works in the CommonJS main bundle (no import.meta) and under the test stub.
const electron = () => electronPkg;
const WINDOW_PREFIX = 'practice-call-window:';
const WINDOW_CHANNELS = Object.freeze([
  'get-state', 'agree-model-download', 'answer', 'hang-up', 'set-muted', 'send-chat',
  'set-typing', 'get-prepared-cards', 'get-replay', 'delete-recording', 'close',
]);

function childUrl({ devServerUrl, distHtmlPath, replay = false, callId = null }) {
  const search = new URLSearchParams({ view: 'practice-call' });
  if (replay) search.set('replay', '1');
  if (callId) search.set('callId', callId);
  if (devServerUrl) return new URL(`?${search.toString()}`, new URL(devServerUrl)).toString();
  return `${pathToFileURL(distHtmlPath).toString()}?${search.toString()}`;
}

function trustedOwner(event, owner, authorized, nodeId) {
  try {
    if (typeof authorized !== 'function') return false;
    const sender = event?.senderFrame ?? event?.sender ?? null;
    if (!authorized(sender, nodeId)) return false;
    if (!owner) return true;
    if (owner.isDestroyed?.()) return false;
    return !event?.senderFrame || event.senderFrame === owner.webContents.mainFrame;
  } catch {
    return false;
  }
}

/**
 * One practice-call window per call plus the canvas- and window-facing IPC.
 * The window is sandboxed with the practice-call preload and the same URL
 * contract as interviewWindow (`?view=practice-call`).
 */
export function createPracticeCallController(deps = {}) {
  const runtime = deps.BrowserWindow && deps.ipcMain ? {} : electron();
  const BrowserWindow = deps.BrowserWindow ?? runtime.BrowserWindow;
  const ipcMain = deps.ipcMain ?? runtime.ipcMain;
  const appInstance = deps.appInstance ?? runtime.app;
  if (typeof BrowserWindow !== 'function' || !ipcMain || typeof deps.isAuthorizedOwner !== 'function') throw new TypeError('Practice call window dependencies are unavailable.');
  const userDataPath = deps.userDataPath ?? appInstance?.getPath?.('userData');
  if (typeof userDataPath !== 'string' || !userDataPath) throw new TypeError('Practice call window requires the user data path.');
  const rootDir = deps.rootDir ?? path.join(userDataPath, 'practice-calls');
  const store = deps.store ?? createCallStore({ rootDir });
  const service = deps.service ?? createPracticeCallService({
    store, userDataPath,
    ...(deps.registry ? { registry: deps.registry } : {}),
    ...(typeof deps.callText === 'function' ? { callText: deps.callText } : {}),
    ...(typeof deps.transcribe === 'function' ? { transcribe: deps.transcribe } : {}),
    ...(deps.serviceOptions || {}),
  });
  const devServerUrl = deps.devServerUrl ?? null;
  const distHtmlPath = deps.distHtmlPath ?? path.join(process.cwd(), 'dist', 'index.html');
  const preloadPath = deps.preloadPath ?? path.join(process.cwd(), 'dist-electron', 'practiceCallPreload.js');
  const registerIpc = deps.registerIpc !== false;
  const getOwner = deps.getOwner ?? (() => null);
  let win = null;
  let current = null;
  // R10: the mode is read when the window closes, so it must follow window reuse.
  let winMode = null;
  const windowAlive = () => !!win && !win.isDestroyed?.();
  const alreadyRunning = () => ({
    ...(service.getState?.() ?? {}), phase: 'error',
    error: { code: 'already-running', message: 'A practice call is already running.' },
  });
  const send = (channel, payload) => { if (windowAlive()) { try { win.webContents.send(channel, payload); } catch { /* window is going away */ } } };
  service.onState?.(state => send(`${WINDOW_PREFIX}state`, state));
  service.onEvent?.(event => send(`${WINDOW_PREFIX}event`, event));
  service.onReplayUpdated?.(replay => send(`${WINDOW_PREFIX}replay-updated`, replay));

  // R10: a replay window is closed before a fresh call window replaces it.
  function closeReplayWindow() {
    const open = win;
    win = null;
    winMode = null;
    current = null;
    try { open?.close?.(); } catch { /* already closing */ }
  }

  function openWindow({ replay = false, callId = null } = {}) {
    if (windowAlive()) {
      winMode = replay ? 'replay' : 'call';
      try { win.show(); win.focus(); } catch { /* window is going away */ }
      return win;
    }
    const options = {
      width: 960, height: 640, title: 'Practice call', backgroundColor: '#111018', show: false,
      webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true },
    };
    winMode = replay ? 'replay' : 'call';
    win = new BrowserWindow(options);
    const created = win;
    created.once?.('ready-to-show', () => { try { created.show(); } catch { /* closed before show */ } });
    created.on?.('closed', () => {
      if (win !== created) return;
      const mode = winMode;
      win = null;
      winMode = null;
      if (mode === 'call') Promise.resolve(service.abandon?.()).catch(() => {});
      else current = null;
    });
    if (devServerUrl) created.loadURL(childUrl({ devServerUrl, distHtmlPath, replay, callId }));
    else created.loadFile(distHtmlPath, { search: `view=practice-call${replay ? '&replay=1' : ''}${callId ? `&callId=${encodeURIComponent(callId)}` : ''}` });
    return created;
  }

  const guardCanvas = handler => async (event, args) => {
    if (!trustedOwner(event, getOwner(), deps.isAuthorizedOwner, args?.nodeId)) throw new Error('Practice call request was not authorized.');
    return handler(args);
  };
  const guardWindow = handler => async (event, ...args) => {
    if (!windowAlive() || !trustedOwner(event, win, deps.isAuthorizedOwner, current?.nodeId)) throw new Error('Practice call window request was not authorized.');
    return handler(...args);
  };

  const handlers = {
    async [WINDOW_PREFIX + 'get-state']() { return service.getState(); },
    async [WINDOW_PREFIX + 'agree-model-download']() { return service.agreeModelDownload(); },
    async [WINDOW_PREFIX + 'answer']() { return service.answer(); },
    async [WINDOW_PREFIX + 'hang-up']() { return service.hangUp(); },
    async [WINDOW_PREFIX + 'set-muted'](muted) { return service.setMuted(muted); },
    async [WINDOW_PREFIX + 'send-chat'](text) { return service.sendChat(text); },
    async [WINDOW_PREFIX + 'set-typing'](typing) { return service.setTyping(typing); },
    async [WINDOW_PREFIX + 'get-prepared-cards']() { return service.getPreparedCards(); },
    async [WINDOW_PREFIX + 'get-replay']() { return service.getReplay(current?.callId ?? service.getState().callId); },
    async [WINDOW_PREFIX + 'delete-recording']() { return service.deleteRecording(current?.callId ?? service.getState().callId); },
    async [WINDOW_PREFIX + 'close']() { if (windowAlive()) win.close(); return null; },
  };
  if (registerIpc) {
    ipcMain.handle('practice-call:start', guardCanvas(async args => {
      // R10: a live call window wins with the service's already-running state;
      // a replay window is replaced by a fresh call window.
      if (windowAlive() && winMode === 'call') return alreadyRunning();
      if (windowAlive() && winMode === 'replay') closeReplayWindow();
      const state = await service.start(args);
      if (state?.phase !== 'error') {
        current = { callId: state?.callId ?? null, nodeId: args?.nodeId ?? null, replay: false };
        openWindow({ callId: state?.callId ?? null });
      }
      return state;
    }));
    ipcMain.handle('practice-call:open-replay', guardCanvas(async args => {
      if (!args || !isPracticeCallId(args.callId) || typeof args.nodeId !== 'string') throw new TypeError('Practice call replay requires a valid call.');
      const record = await store.readRecord(args.callId);
      if (!record || record.nodeId !== args.nodeId) throw new Error('That practice call is not available.');
      current = { callId: args.callId, nodeId: args.nodeId, replay: true };
      openWindow({ replay: true, callId: args.callId });
      return { callId: args.callId };
    }));
    ipcMain.handle('practice-call:list', guardCanvas(async args => {
      if (!args || typeof args.nodeId !== 'string' || !args.nodeId) throw new TypeError('Practice calls require a node id.');
      return service.list(args.nodeId);
    }));
    for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, guardWindow(handler));
  }
  return Object.freeze({
    service, store, openWindow,
    getWindow: () => (windowAlive() ? win : null),
    dispose() {
      if (registerIpc) {
        for (const channel of ['practice-call:start', 'practice-call:open-replay', 'practice-call:list', ...Object.keys(handlers)]) {
          try { ipcMain.removeHandler(channel); } catch { /* not registered */ }
        }
      }
      if (windowAlive()) win.close();
      win = null;
    },
  });
}

export { WINDOW_CHANNELS, WINDOW_PREFIX, childUrl, createReplayHandler };
