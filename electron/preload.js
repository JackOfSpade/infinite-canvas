const { contextBridge, ipcRenderer, webUtils } = require('electron');

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

  // ── Filesystem ──────────────────────────────────────────────────────────
  getPathForFile: (file) => webUtils.getPathForFile(file),
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  fetchUrlTitle: async (url) => {
    const res = await ipcRenderer.invoke('fetch-url-title', url);
    return res.success ? (res.title || null) : null;
  },
  saveWorkspace: (data) => ipcRenderer.invoke('save-workspace', data),
  loadWorkspace: (opts) => ipcRenderer.invoke('load-workspace', opts),
  scanDirectory: (dirPath) => ipcRenderer.invoke('scan-directory', dirPath),
  startFileWatch: (filePath) => ipcRenderer.invoke('start-file-watch', filePath),
  stopFileWatch: (filePath) => ipcRenderer.invoke('stop-file-watch', filePath),
  deleteOSFile: (filePath) => ipcRenderer.invoke('delete-os-file', filePath),
  writeTextFile: (filePath, content) => ipcRenderer.invoke('write-text-file', { filePath, content }),
  saveFileDialog: (args) => ipcRenderer.invoke('save-file-dialog', args),

  onFileChanged: createListener('file-changed'),
  onMenuNew: createListener('menu-new'),
  onMenuOpen: createListener('menu-open'),
  onMenuSave: createListener('menu-save'),
  onMenuExportPng: createListener('menu-export-png'),
  onQuitRequest: createListener('quit-request'),
  sendQuitResponse: (hasUnsavedChanges) => ipcRenderer.send('quit-response', { hasUnsavedChanges }),
  
  // Custom dialogs wrapper
  promptUnsavedChanges: (actionName) => ipcRenderer.invoke('prompt-unsaved-changes', actionName),
  onRequestSaveAndRespond: createListener('request-save-and-respond'),
  sendSaveResponse: (success) => ipcRenderer.send('save-response', { success }),

  // ── Jobs Module ─────────────────────────────────────────────────────────
  parseResume: (args) => ipcRenderer.invoke('parse-resume', args),
  generateJobQueries: (args) => ipcRenderer.invoke('generate-job-queries', args),
  searchJobs: (args) => ipcRenderer.invoke('search-jobs', args),
  searchJobsSingleSource: (args) => ipcRenderer.invoke('search-jobs-single-source', args),
  scoreJobs: (args) => ipcRenderer.invoke('score-jobs', args),
  generateCoverLetter: (args) => ipcRenderer.invoke('generate-cover-letter', args),
  generateInterviewPrep: (args) => ipcRenderer.invoke('generate-interview-prep', args),
  loadJobsHistory: (args) => ipcRenderer.invoke('load-jobs-history', args),
  appendJobsHistory: (args) => ipcRenderer.invoke('append-jobs-history', args),

  onJobSourceProgress: createListener('job-source-progress'),
  resolveJobSource: (args) => ipcRenderer.invoke('resolve-job-source', args),
  bucketJobs: (args) => ipcRenderer.invoke('bucket-jobs', args),

  // ── Marketplace Module ──────────────────────────────────────────────────
  analyzePhotos: (args) => ipcRenderer.invoke('analyze-photos', args),
  scrapePriceComps: (args) => ipcRenderer.invoke('scrape-price-comps', args),
  rescrapeSource: (args) => ipcRenderer.invoke('rescrape-source', args),
  synthesizePrice: (args) => ipcRenderer.invoke('synthesize-price', args),
  assessPlatformFit: (args) => ipcRenderer.invoke('assess-platform-fit', args),
  resolveCaptcha: (args) => ipcRenderer.invoke('resolve-captcha', args),
  checkListingStatus: (args) => ipcRenderer.invoke('check-listing-status', args),
  getSellPlatforms: async () => {
    const res = await ipcRenderer.invoke('get-sell-platforms');
    return res.success ? (res.platforms || []) : [];
  },
  checkSellMonitorAuth: async (args) => {
    const res = await ipcRenderer.invoke('check-sell-monitor-auth', args);
    return res.success ? res : { platform: args.platformId, connected: false };
  },

  onPriceSourceProgress: createListener('price-source-progress'),

  // ── Accounts Module ───────────────────────────────────────────────────
  getPlatforms: async () => {
    const res = await ipcRenderer.invoke('get-platforms');
    return res.success ? (res.platforms || []) : [];
  },
  getSessionStatuses: async () => {
    const res = await ipcRenderer.invoke('get-session-statuses');
    return res.success ? (res.statuses || []) : [];
  },
  getCachedSessionStatuses: async () => {
    const res = await ipcRenderer.invoke('get-cached-session-statuses');
    return res.success ? (res.statuses || []) : [];
  },
  getSystemConfigStatus: async () => {
    const res = await ipcRenderer.invoke('get-system-config-status');
    return res.success ? (res.config || {}) : {};
  },
  checkPlatformSession: async (args) => {
    const res = await ipcRenderer.invoke('check-platform-session', args);
    return res.success ? res : { platform: args.platformId, connected: false };
  },
  openLoginWindow: async (args) => {
    // Pass the full IPC response through. Previously this bridge replaced
    // any !success response with a bare `{ success: false }`, dropping the
    // `error` field, the `connected` verdict, and the `reason` string —
    // which left the renderer with no signal about why a login attempt
    // failed and forced a generic fallback toast that hid real bugs.
    return await ipcRenderer.invoke('open-login-window', args);
  },
  checkAndLogin: async (args) => {
    const res = await ipcRenderer.invoke('check-and-login', args);
    return res.success ? res : { platform: args.platformId, connected: false, loginOpened: false };
  },

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

  // ── Settings ────────────────────────────────────────────────────────────
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: (updates) => ipcRenderer.invoke('update-settings', updates),
  pickServiceAccountFile: () => ipcRenderer.invoke('pick-service-account-file'),
  onSettingsChanged: createListener('settings-changed'),

  // ── Lifecycle Control ────────────────────────────────────────────────────
  cancelNodeTask: (nodeId) => ipcRenderer.send('cancel-node-task', nodeId),
});
