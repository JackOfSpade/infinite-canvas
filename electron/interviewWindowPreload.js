const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('interviewAPI', Object.freeze({
  getBrief: () => ipcRenderer.invoke('interview-window:get-brief'),
  submitQuestion: (question) => {
    if (typeof question !== 'string' || question.length > 2000) return Promise.reject(new TypeError('Interview question must be a bounded string.'));
    return ipcRenderer.invoke('interview-window:submit-question', question);
  },
  followUpQuestion: (question) => {
    if (typeof question !== 'string' || question.length > 2000) return Promise.reject(new TypeError('Interview question must be a bounded string.'));
    return ipcRenderer.invoke('interview-window:follow-up-question', question);
  },
  selectPreparedCard: (cardId) => {
    if (typeof cardId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(cardId)) return Promise.reject(new TypeError('Interview prepared answer ID is invalid.'));
    return ipcRenderer.invoke('interview-window:select-prepared-card', cardId);
  },
  nextQuestion: () => ipcRenderer.invoke('interview-window:next-question'),
  getListeningState: () => ipcRenderer.invoke('interview-window:get-listening-state'),
  startListening: () => ipcRenderer.invoke('interview-window:start-listening'),
  stopListening: () => ipcRenderer.invoke('interview-window:stop-listening'),
  useTranscriptQuestion: () => ipcRenderer.invoke('interview-window:use-transcript-question'),
  onListeningUpdated: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('Interview listening callback must be a function.');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('interview-window:listening-updated', listener);
    return () => ipcRenderer.removeListener('interview-window:listening-updated', listener);
  },
  onBriefUpdated: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('Interview update callback must be a function.');
    const listener = (_event, brief) => callback(brief);
    ipcRenderer.on('interview-window:brief-updated', listener);
    return () => ipcRenderer.removeListener('interview-window:brief-updated', listener);
  },
  close: () => ipcRenderer.invoke('interview-window:close'),
  setAlwaysOnTop: (value) => {
    if (typeof value !== 'boolean') return Promise.reject(new TypeError('Always-on-top must be a boolean.'));
    return ipcRenderer.invoke('interview-window:set-always-on-top', value);
  },
  setLatencyMode: (value) => {
    if (!['auto', 'recall', 'continuation'].includes(value)) return Promise.reject(new TypeError('Interview display mode is invalid.'));
    return ipcRenderer.invoke('interview-window:set-latency-mode', value);
  },
}));
