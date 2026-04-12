const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // --- Existing channels ---
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  saveWorkspace: (data) => ipcRenderer.invoke('save-workspace', data),
  loadWorkspace: () => ipcRenderer.invoke('load-workspace'),
  scanDirectory: (dirPath) => ipcRenderer.invoke('scan-directory', dirPath),
  
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

  // --- Monitoring channels (DUMMY backend) ---
  registerListing: (args) => ipcRenderer.invoke('register-listing', args),
  startMonitoring: (args) => ipcRenderer.invoke('start-monitoring', args),
  stopMonitoring: (args) => ipcRenderer.invoke('stop-monitoring', args),
  getActivityLog: (args) => ipcRenderer.invoke('get-activity-log', args),
  updateMonitorSettings: (args) => ipcRenderer.invoke('update-monitor-settings', args),

  // Push event: main process sends monitoring activity updates
  onMonitoringActivity: (callback) => {
    const fn = (event, data) => callback(data);
    ipcRenderer.on('monitoring-activity', fn);
    return () => ipcRenderer.removeListener('monitoring-activity', fn);
  },
});
