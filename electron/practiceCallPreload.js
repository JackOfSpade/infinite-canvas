// CommonJS preload for the sandboxed practice-call window.
const { contextBridge, ipcRenderer } = require('electron');

const PREFIX = 'practice-call-window:';
const MAX_CHAT = 2000;

function fail(message) { throw new TypeError(`practiceCallAPI: ${message}`); }
function booleanArg(value, name) { if (typeof value !== 'boolean') fail(`${name} expects a boolean`); return value; }
function chatText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_CHAT) fail(`sendChat expects 1-${MAX_CHAT} characters`);
  return value;
}
function subscribe(channel, cb) {
  if (typeof cb !== 'function') fail('subscription expects a function');
  const listener = (_event, payload) => { try { cb(payload); } catch { /* renderer callback errors stay in the renderer */ } };
  ipcRenderer.on(channel, listener);
  let active = true;
  return () => { if (!active) return; active = false; ipcRenderer.removeListener(channel, listener); };
}
const invoke = (name, ...args) => ipcRenderer.invoke(`${PREFIX}${name}`, ...args);

const practiceCallAPI = Object.freeze({
  getState: () => invoke('get-state'),
  onState: cb => subscribe(`${PREFIX}state`, cb),
  onEvent: cb => subscribe(`${PREFIX}event`, cb),
  agreeModelDownload: () => invoke('agree-model-download'),
  answer: () => invoke('answer'),
  hangUp: () => invoke('hang-up'),
  setMuted: muted => invoke('set-muted', booleanArg(muted, 'setMuted')),
  sendChat: text => invoke('send-chat', chatText(text)),
  setTyping: typing => invoke('set-typing', booleanArg(typing, 'setTyping')),
  getPreparedCards: () => invoke('get-prepared-cards'),
  getReplay: () => invoke('get-replay'),
  onReplayUpdated: cb => subscribe(`${PREFIX}replay-updated`, cb),
  deleteRecording: () => invoke('delete-recording'),
  close: () => invoke('close'),
});

contextBridge.exposeInMainWorld('practiceCallAPI', practiceCallAPI);
