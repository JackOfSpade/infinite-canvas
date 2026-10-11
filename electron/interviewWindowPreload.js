const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('interviewAPI', Object.freeze({
  getBrief: () => ipcRenderer.invoke('interview-window:get-brief'),
  submitQuestion: (question) => {
    if (typeof question !== 'string' || question.length > 2000) return Promise.reject(new TypeError('Interview question must be a bounded string.'));
    return ipcRenderer.invoke('interview-window:submit-question', question);
  },
  nextQuestion: () => ipcRenderer.invoke('interview-window:next-question'),
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
}));
