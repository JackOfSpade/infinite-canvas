const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // --- Existing channels ---
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  saveWorkspace: (data) => ipcRenderer.invoke('save-workspace', data),
  loadWorkspace: () => ipcRenderer.invoke('load-workspace'),
  scanDirectory: (dirPath) => ipcRenderer.invoke('scan-directory', dirPath),
  startFileWatch: (filePath) => ipcRenderer.invoke('start-file-watch', filePath),
  stopFileWatch: (filePath) => ipcRenderer.invoke('stop-file-watch', filePath),
  
  onFileChanged: (callback) => {
    const fn = (event, filePath) => callback(filePath);
    ipcRenderer.on('file-changed', fn);
    return () => ipcRenderer.removeListener('file-changed', fn);
  },
  
  onMenuOpen: (callback) => {
    const fn = (event, ...args) => callback(...args);
    ipcRenderer.on('menu-open', fn);
    return () => ipcRenderer.removeListener('menu-open', fn);
  },
  onMenuSave: (callback) => {
    const fn = (event, ...args) => callback(...args);
    ipcRenderer.on('menu-save', fn);
    return () => ipcRenderer.removeListener('menu-save', fn);
  },

  // --- Monitoring channels (Gemini AI-powered) ---
  registerListing: (args) => ipcRenderer.invoke('register-listing', args),
  checkListing: (args) => ipcRenderer.invoke('check-listing', args),

  // Push event: main process sends monitoring activity updates
  onMonitoringActivity: (callback) => {
    const fn = (event, data) => callback(data);
    ipcRenderer.on('monitoring-activity', fn);
    return () => ipcRenderer.removeListener('monitoring-activity', fn);
  },
});
