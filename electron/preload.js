const { contextBridge, ipcRenderer } = require('electron');

/**
 * Creates a listener wrapper for IPC channels.
 * Returns a cleanup function that removes the listener.
 */
function createListener(channel) {
  return (callback) => {
    const fn = (_event, data) => callback(data);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  };
}

contextBridge.exposeInMainWorld('electronAPI', {
  // Generic IPC invoke — used for channels without a typed helper
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),

  // ── Filesystem ──────────────────────────────────────────────────────────
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  fetchUrlTitle: (url) => ipcRenderer.invoke('fetch-url-title', url),
  saveWorkspace: (data) => ipcRenderer.invoke('save-workspace', data),
  loadWorkspace: () => ipcRenderer.invoke('load-workspace'),
  scanDirectory: (dirPath) => ipcRenderer.invoke('scan-directory', dirPath),
  startFileWatch: (filePath) => ipcRenderer.invoke('start-file-watch', filePath),
  stopFileWatch: (filePath) => ipcRenderer.invoke('stop-file-watch', filePath),
  deleteOSFile: (filePath) => ipcRenderer.invoke('delete-os-file', filePath),

  onFileChanged: createListener('file-changed'),
  onMenuOpen: createListener('menu-open'),
  onMenuSave: createListener('menu-save'),
  onMenuExportPng: createListener('menu-export-png'),

  // ── Jobs Module ─────────────────────────────────────────────────────────
  parseResume: (args) => ipcRenderer.invoke('parse-resume', args),
  generateJobQueries: (args) => ipcRenderer.invoke('generate-job-queries', args),
  searchJobs: (args) => ipcRenderer.invoke('search-jobs', args),
  scoreJobs: (args) => ipcRenderer.invoke('score-jobs', args),
  generateCoverLetter: (args) => ipcRenderer.invoke('generate-cover-letter', args),

  onJobSourceProgress: createListener('job-source-progress'),

  // ── Marketplace Module ──────────────────────────────────────────────────
  analyzePhotos: (args) => ipcRenderer.invoke('analyze-photos', args),
  researchPrice: (args) => ipcRenderer.invoke('research-price', args),
  getSellPlatforms: () => ipcRenderer.invoke('get-sell-platforms'),
  checkSellMonitorAuth: (args) => ipcRenderer.invoke('check-sell-monitor-auth', args),

  onPriceSourceProgress: createListener('price-source-progress'),

  // ── Accounts Module ───────────────────────────────────────────────────
  getPlatforms: () => ipcRenderer.invoke('get-platforms'),
  getSessionStatuses: () => ipcRenderer.invoke('get-session-statuses'),
  getCachedSessionStatuses: () => ipcRenderer.invoke('get-cached-session-statuses'),
  getSystemConfigStatus: () => ipcRenderer.invoke('get-system-config-status'),
  checkPlatformSession: (args) => ipcRenderer.invoke('check-platform-session', args),
  openLoginWindow: (args) => ipcRenderer.invoke('open-login-window', args),
  checkAndLogin: (args) => ipcRenderer.invoke('check-and-login', args),

  // ── Tier 4 Monitor Module ─────────────────────────────────────────────
  // Human-assisted BrowserView monitors for hostile platforms (Facebook, etc.)
  openMonitor: (args) => ipcRenderer.invoke('open-monitor', args),
  startMonitoring: (args) => ipcRenderer.invoke('start-monitoring', args),
  stopMonitor: (args) => ipcRenderer.invoke('stop-monitor', args),
  reopenMonitor: (args) => ipcRenderer.invoke('reopen-monitor', args),
  getMonitors: () => ipcRenderer.invoke('get-monitors'),
  getMonitorData: (args) => ipcRenderer.invoke('get-monitor-data', args),

  onMonitorDataChanged: createListener('monitor-data-changed'),
  onMonitorSessionExpired: createListener('monitor-session-expired'),
  onMonitorPaused: createListener('monitor-paused'),

  // ── AI Tools ────────────────────────────────────────────────────────────
  aiPolishText: (text) => ipcRenderer.invoke('ai-polish-text', text),
  exportBugReport:             (payload) => ipcRenderer.invoke('export-bug-report', payload),
  generateBugReportMarkdown:   (payload) => ipcRenderer.invoke('generate-bug-report-markdown', payload),
});
