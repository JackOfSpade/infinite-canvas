const { contextBridge, ipcRenderer } = require('electron');

// The cue card only reads its brief and display updates, and starts and stops
// the listening it owns. It has no way to submit, select, copy or configure.
contextBridge.exposeInMainWorld('interviewAPI', Object.freeze({
  getBrief: () => ipcRenderer.invoke('interview-window:get-brief'),
  startListening: () => ipcRenderer.invoke('interview-window:start-listening'),
  stopListening: () => ipcRenderer.invoke('interview-window:stop-listening'),
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
}));
