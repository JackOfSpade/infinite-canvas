// CommonJS preload for the sandboxed practice-call window.
const { contextBridge, ipcRenderer } = require('electron');

const PREFIX = 'practice-call-window:';
const MAX_CHAT = 2000;
const MAX_PAD = 20000;

function fail(message) { throw new TypeError(`practiceCallAPI: ${message}`); }
function booleanArg(value, name) { if (typeof value !== 'boolean') fail(`${name} expects a boolean`); return value; }
function chatText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_CHAT) fail(`sendChat expects 1-${MAX_CHAT} characters`);
  return value;
}
function padText(value) {
  if (typeof value !== 'string') fail('updatePad expects a string');
  return value.slice(0, MAX_PAD);
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
  onLeaveRequested: cb => subscribe(`${PREFIX}leave-requested`, cb),
  agreeModelDownload: () => invoke('agree-model-download'),
  answer: () => invoke('answer'),
  hangUp: options => invoke('hang-up', { feedback: options?.feedback !== false }),
  setMuted: muted => invoke('set-muted', booleanArg(muted, 'setMuted')),
  sendChat: text => invoke('send-chat', chatText(text)),
  setTyping: typing => invoke('set-typing', booleanArg(typing, 'setTyping')),
  setPaused: paused => invoke('set-paused', booleanArg(paused, 'setPaused')),
  updatePad: text => invoke('update-pad', padText(text)),
  getPreparedCards: () => invoke('get-prepared-cards'),
  getReplay: () => invoke('get-replay'),
  onReplayUpdated: cb => subscribe(`${PREFIX}replay-updated`, cb),
  deleteRecording: () => invoke('delete-recording'),
  close: () => invoke('close'),
});

contextBridge.exposeInMainWorld('practiceCallAPI', practiceCallAPI);
