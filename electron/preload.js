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

// Every document node used to subscribe directly to ipcRenderer's one
// file-changed event. Duplicated nodes therefore turned one OS notification
// into many renderer callbacks with no way to identify that they were the
// same event. Keep one native listener and fan it out with a monotonically
// increasing notification ID; existing one-argument callbacks remain valid.
const fileChangedSubscribers = new Set();
let fileChangedNotificationId = 0;
let fileChangedListener = null;

function onFileChanged(callback) {
  const subscriber = (filePath, notificationId) => callback(filePath, notificationId);
  fileChangedSubscribers.add(subscriber);
  if (!fileChangedListener) {
    fileChangedListener = (_event, filePath) => {
      const notificationId = ++fileChangedNotificationId;
      // One disposed/third-party renderer callback must not prevent sibling
      // duplicate document nodes from receiving this OS change. Snapshot first
      // so cleanup during delivery also cannot mutate this notification's fanout.
      for (const listener of [...fileChangedSubscribers]) {
        try {
          listener(filePath, notificationId);
        } catch (error) {
          console.error('file-changed subscriber failed:', error);
        }
      }
    };
    ipcRenderer.on('file-changed', fileChangedListener);
  }
  return () => {
    fileChangedSubscribers.delete(subscriber);
    if (fileChangedSubscribers.size === 0 && fileChangedListener) {
      ipcRenderer.removeListener('file-changed', fileChangedListener);
      fileChangedListener = null;
    }
  };
}

// Draft updates are intentionally non-blocking while the user types. Keep the
// promises in preload (which also owns the quit bridge) so shutdown can await
// every update before asking main to flush its deferred disk checkpoint.
const pendingNonApiAiDraftWrites = new Set();
function updateNonApiAiDraft(requestId, response) {
  const write = ipcRenderer.invoke('update-non-api-ai-draft', { requestId, response });
  pendingNonApiAiDraftWrites.add(write);
  void write.then(
    () => pendingNonApiAiDraftWrites.delete(write),
    () => pendingNonApiAiDraftWrites.delete(write),
  );
  return write;
}

async function flushNonApiAiPersistence() {
  while (pendingNonApiAiDraftWrites.size > 0) {
    await Promise.allSettled([...pendingNonApiAiDraftWrites]);
  }
  return ipcRenderer.invoke('flush-non-api-ai-persistence');
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
  deleteOSFile: (filePath, protectedPaths = []) => ipcRenderer.invoke('delete-os-file', {
    filePath,
    protectedPaths,
  }),
  readTextFile: (filePath) => ipcRenderer.invoke('read-text-file', filePath),
  writeTextFile: (filePath, content, expectedDiskContent, expectedTargetToken) => ipcRenderer.invoke('write-text-file', {
    filePath,
    content,
    expectedContent: expectedDiskContent,
    expectedTargetToken,
  }),

  // Report which canvas file this window currently has open so the main
  // process can avoid opening the same file in a second window.
  setWindowFile: (filePath) => ipcRenderer.send('window:set-current-file', filePath),

  onFileChanged,
  // Fired when the open canvas file is renamed on disk (e.g. in Finder) and the
  // main process followed it by inode. Payload: the new absolute path.
  onCanvasFileRenamed: createListener('canvas:file-renamed'),
  onMenuSave: createListener('menu-save'),
  onMenuExportPng: createListener('menu-export-png'),
  onQuitRequest: createListener('quit-request'),
  onQuitCommitRequest: createListener('quit-commit-request'),
  onQuitCommitRelease: createListener('quit-commit-release'),
  sendQuitResponse: (state, requestId) => ipcRenderer.send('quit-response', {
    ...(typeof state === 'object' && state !== null ? state : { hasUnsavedChanges: state }),
    requestId,
  }),
  sendQuitCommitAck: (requestId) => ipcRenderer.send('quit-commit-ack', { requestId }),
  
  // Custom dialogs wrapper
  promptUnsavedChanges: (actionName) => ipcRenderer.invoke('prompt-unsaved-changes', actionName),
  onRequestSaveAndRespond: createListener('request-save-and-respond'),
  sendSaveResponse: (success, requestId) => ipcRenderer.send('save-response', { success, requestId }),

  // ── Jobs Module ─────────────────────────────────────────────────────────
  generateJobQueries: (args) => ipcRenderer.invoke('generate-job-queries', args),
  interpretJobPreferences: (args) => ipcRenderer.invoke('interpret-job-preferences', args),
  evaluateJobPreferences: (args) => ipcRenderer.invoke('evaluate-job-preferences', args),
  resolveJobSearchLocation: (args) => ipcRenderer.invoke('resolve-job-search-location', args),
  searchJobs: (args) => ipcRenderer.invoke('search-jobs', args),
  searchJobsSingleSource: (args) => ipcRenderer.invoke('search-jobs-single-source', args),
  scoreJobs: (args) => ipcRenderer.invoke('score-jobs', args),
  saveJobAnalysisSnapshot: (args) => ipcRenderer.invoke('save-job-analysis-snapshot', args),
  getLastJobAnalysisSnapshot: (args) => ipcRenderer.invoke('get-last-job-analysis-snapshot', args),
  discardJobAnalysisSnapshot: (args) => ipcRenderer.invoke('discard-job-analysis-snapshot', args),
  parseCareerData: (args) => ipcRenderer.invoke('parse-career-data', args),
  // Local AI is intentionally a manual, file-based handoff. These handlers
  // never invoke or automate a local coding agent; the user runs the documented
  // provider-neutral routine and returns here to validate/import result.json.
  queueLocalApplication: (args) => ipcRenderer.invoke('queue-local-application', args),
  discardLocalApplication: (args) => ipcRenderer.invoke('discard-local-application', args),
  getLocalApplicationStatus: (args) => ipcRenderer.invoke('get-local-application-status', args),
  discoverLocalApplications: (args) => ipcRenderer.invoke('discover-local-applications', args),
  openLocalApplicationFolder: (args) => ipcRenderer.invoke('open-local-application-folder', args),
  importLocalApplication: (args) => ipcRenderer.invoke('import-local-application', args),
  saveApplication: (args) => ipcRenderer.invoke('save-application', args),
  discardApplication: (args) => ipcRenderer.invoke('discard-application', args),
  appendJobsHistory: (args) => ipcRenderer.invoke('append-jobs-history', args),

  onJobSourceProgress: createListener('job-source-progress'),
  // Per-batch AI-scoring progress (real-time path). Payload: { nodeId, scored, total, batch, batchTotal }.
  onScoringProgress: createListener('scoring-progress'),
  // Grounded cash-pay research follows fit scoring. Payload: { nodeId, processed, total }.
  onCompensationProgress: createListener('compensation-progress'),
  resolveJobSource: (args) => ipcRenderer.invoke('resolve-job-source', args),
  resumeJobSource:  (args) => ipcRenderer.invoke('resume-job-source', args),
  // Crash/quit recovery: detect an incomplete prior run, or clear it. Resuming
  // re-invokes searchJobs({ resume:true }), so no separate resume channel is needed.
  peekJobRun:     (args) => ipcRenderer.invoke('peek-job-run', args),
  completeJobRun: (args) => ipcRenderer.invoke('complete-job-run', args),
  discardJobRun:  (args) => ipcRenderer.invoke('discard-job-run', args),
  discardUnknownOwnerJobRun: (args) => ipcRenderer.invoke('discard-unknown-owner-job-run', args),
  pollJobBatch:    (args) => ipcRenderer.invoke('poll-job-batch', args),
  discardJobBatch: (args) => ipcRenderer.invoke('discard-job-batch', args),
  recordResolveMerge: (args) => ipcRenderer.invoke('record-resolve-merge', args),
  bucketJobs: (args) => ipcRenderer.invoke('bucket-jobs', args),
  // Board Combine runs this after global taxonomy validation and before cards
  // are built, so compensation context is still available on the full jobs.
  researchJobCompensation: (args) => ipcRenderer.invoke('research-job-compensation', args),

  // ── Non-API AI handoff ─────────────────────────────────────────────────
  // The main process emits a fully materialized prompt here when a job task
  // needs the user to run it in their own AI chat.  Keeping the request id in
  // both directions lets a renderer retry a validation failure without ever
  // resolving a different pending AI call.
  onNonApiAiRequest: createListener('non-api-ai-request'),
  onNonApiAiSettled: createListener('non-api-ai-settled'),
  // Subscribe before asking the main process to replay sender-owned pending
  // handoffs so an app-level dialog remount cannot leave a live prompt in the
  // listener/replay gap. A true renderer navigation cancels its job instead.
  replayPendingNonApiAiRequests: () => ipcRenderer.invoke('replay-pending-non-api-ai-requests'),
  submitNonApiAiResponse: (args) => ipcRenderer.invoke('submit-non-api-ai-response', args),
  updateNonApiAiDraft,
  flushNonApiAiPersistence,
  completeNonApiAiRun: (runId) => ipcRenderer.invoke('complete-non-api-ai-run', { runId }),
  stepBackNonApiAiRequest: (requestId) => ipcRenderer.invoke('step-back-non-api-ai-request', { requestId }),
  cancelNonApiAiRequest: (requestId) => ipcRenderer.invoke('cancel-non-api-ai-request', { requestId }),
  revealNonApiAiAttachment: (requestId, filePath) => ipcRenderer.invoke('reveal-non-api-ai-attachment', { requestId, filePath }),

  // ── Price Check Module ──────────────────────────────────────────────────
  analyzePhotos: (args) => ipcRenderer.invoke('analyze-photos', args),
  scrapePriceComps: (args) => ipcRenderer.invoke('scrape-price-comps', args),
  rescrapeSource: (args) => ipcRenderer.invoke('rescrape-source', args),
  synthesizePrice: (args) => ipcRenderer.invoke('synthesize-price', args),
  synthesizeBundlePrice: (args) => ipcRenderer.invoke('synthesize-bundle-price', args),
  assessPlatformFit: (args) => ipcRenderer.invoke('assess-platform-fit', args),
  resolveCaptcha: (args) => ipcRenderer.invoke('resolve-captcha', args),
  // ── Marketplace Status Module ───────────────────────────────────────────
  // Scrapes each platform's aggregate notification hub (the watch URLs in
  // Settings) for anything needing the seller's attention — NOT per-listing.
  checkMarketplaceStatus: (args) => ipcRenderer.invoke('check-marketplace-status', args),
  onMarketplaceStatusProgress: createListener('marketplace-status-progress'),
  checkSellMonitorAuth: async (args) => {
    const res = await ipcRenderer.invoke('check-sell-monitor-auth', args);
    return res.success ? res : { platform: args.platformId, connected: false };
  },
  checkJobPlatformAuth: async (args) => {
    const res = await ipcRenderer.invoke('check-job-platform-auth', args);
    return res.success ? res : { platform: args.platformId, connected: false };
  },

  onPriceSourceProgress: createListener('price-source-progress'),
  // Emitted while a sell-side browser op is serialized behind another (queued
  // behind N), then with queuedBehind:0 once it acquires the shared browser.
  onPriceQueueStatus: createListener('price-queue-status'),

  // ── Accounts Module ───────────────────────────────────────────────────
  getVerifyState: async () => {
    const res = await ipcRenderer.invoke('get-verify-state');
    return res.success ? res : { verifying: [], statuses: {} };
  },
  onSessionVerifyStart:  createListener('accounts:verify-start'),
  onSessionVerifyUpdate: createListener('accounts:verify-update'),
  onSessionVerifyDone:   createListener('accounts:verify-done'),
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
    return await ipcRenderer.invoke('clear-browser-session');
  },
  resetPlatformSession: async (args) => {
    return await ipcRenderer.invoke('reset-platform-session', args);
  },

  // ── AI Tools ────────────────────────────────────────────────────────────
  aiPolishText: (text) => ipcRenderer.invoke('ai-polish-text', text),
  // AI provider availability/quota: live probe ("Check availability") and the
  // last-known passive status for the Settings panel.
  checkAIAvailability: (args) => ipcRenderer.invoke('check-ai-availability', args),
  getAIStatus: () => ipcRenderer.invoke('get-ai-status'),
  // Live Claude family -> resolved model id map, for the Settings panel's
  // per-live-group (Judgment/Extraction/Light) family dropdowns — see llm.js
  // registerLlmHandlers().
  getClaudeModelMap: () => ipcRenderer.invoke('get-claude-model-map'),
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
  cancelNodeTask: (nodeId, cause = null) => ipcRenderer.send('cancel-node-task', nodeId, cause),
});
