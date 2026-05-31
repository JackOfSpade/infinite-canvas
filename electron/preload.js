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

  // Report which canvas file this window currently has open so the main
  // process can avoid opening the same file in a second window.
  setWindowFile: (filePath) => ipcRenderer.send('window:set-current-file', filePath),

  onFileChanged: createListener('file-changed'),
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
  getResumeFingerprint: (args) => ipcRenderer.invoke('get-resume-fingerprint', args),
  generateJobQueries: (args) => ipcRenderer.invoke('generate-job-queries', args),
  searchJobs: (args) => ipcRenderer.invoke('search-jobs', args),
  searchJobsSingleSource: (args) => ipcRenderer.invoke('search-jobs-single-source', args),
  scoreJobs: (args) => ipcRenderer.invoke('score-jobs', args),
  saveJobAnalysisSnapshot: (args) => ipcRenderer.invoke('save-job-analysis-snapshot', args),
  getLastJobAnalysisSnapshot: (args) => ipcRenderer.invoke('get-last-job-analysis-snapshot', args),
  generateCoverLetter: (args) => ipcRenderer.invoke('generate-cover-letter', args),
  generateInterviewPrep: (args) => ipcRenderer.invoke('generate-interview-prep', args),
  parseCareerData: (args) => ipcRenderer.invoke('parse-career-data', args),
  generateApplication: (args) => ipcRenderer.invoke('generate-application', args),
  saveApplication: (args) => ipcRenderer.invoke('save-application', args),
  loadJobsHistory: (args) => ipcRenderer.invoke('load-jobs-history', args),
  appendJobsHistory: (args) => ipcRenderer.invoke('append-jobs-history', args),

  onJobSourceProgress: createListener('job-source-progress'),
  resolveJobSource: (args) => ipcRenderer.invoke('resolve-job-source', args),
  resumeJobSource:  (args) => ipcRenderer.invoke('resume-job-source', args),
  // Crash/quit recovery: detect an incomplete prior run, or clear it. Resuming
  // re-invokes searchJobs({ resume:true }), so no separate resume channel is needed.
  peekJobRun:     (args) => ipcRenderer.invoke('peek-job-run', args),
  completeJobRun: (args) => ipcRenderer.invoke('complete-job-run', args),
  discardJobRun:  (args) => ipcRenderer.invoke('discard-job-run', args),
  pollJobBatch:    (args) => ipcRenderer.invoke('poll-job-batch', args),
  discardJobBatch: (args) => ipcRenderer.invoke('discard-job-batch', args),
  recordResolveMerge: (args) => ipcRenderer.invoke('record-resolve-merge', args),
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
  getJobPlatforms: async () => {
    const res = await ipcRenderer.invoke('get-job-platforms');
    return res.success ? (res.platforms || []) : [];
  },
  checkJobPlatformAuth: async (args) => {
    const res = await ipcRenderer.invoke('check-job-platform-auth', args);
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
  getVerifyState: async () => {
    const res = await ipcRenderer.invoke('get-verify-state');
    return res.success ? res : { verifying: [], statuses: {} };
  },
  onSessionVerifyStart:  createListener('accounts:verify-start'),
  onSessionVerifyUpdate: createListener('accounts:verify-update'),
  onSessionVerifyDone:   createListener('accounts:verify-done'),
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
  clearBrowserSession: async () => {
    const res = await ipcRenderer.invoke('clear-browser-session');
    return res?.success ?? false;
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
  // AI provider availability/quota: live probe ("Check availability") and the
  // last-known passive status for the Settings panel.
  checkAIAvailability: (args) => ipcRenderer.invoke('check-ai-availability', args),
  getAIStatus: () => ipcRenderer.invoke('get-ai-status'),
  exportBugReport:             (payload) => ipcRenderer.invoke('export-bug-report', payload),
  generateBugReportMarkdown:   (payload) => ipcRenderer.invoke('generate-bug-report-markdown', payload),

  // ── Settings ────────────────────────────────────────────────────────────
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: (updates) => ipcRenderer.invoke('update-settings', updates),
  pickServiceAccountFile: () => ipcRenderer.invoke('pick-service-account-file'),
  onSettingsChanged: createListener('settings-changed'),

  // ── Chrome manual-launch handshake ──────────────────────────────────────
  // Fired when the app couldn't auto-launch Chrome with the debug port and
  // needs the user to do it manually. Payload: { terminalCommand, port }.
  onChromeLaunchNeeded:    createListener('browser-chrome-launch-needed'),
  // Fired when the user's manually-launched Chrome is detected on the debug
  // port and puppeteer has connected — clears the instruction overlay.
  onChromeLaunchConnected: createListener('browser-chrome-connected'),
  // Fired when the 5-minute wait expires or the task is aborted.
  onChromeLaunchDismissed: createListener('browser-chrome-launch-dismissed'),

  // ── Lifecycle Control ────────────────────────────────────────────────────
  cancelNodeTask: (nodeId) => ipcRenderer.send('cancel-node-task', nodeId),
});
