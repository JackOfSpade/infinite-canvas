// CommonJS preload for the main window of the standalone Interview Helper app.
//
// It exposes `window.electronAPI` with the same method names the shared
// Interview Helper components already call in Infinite Canvas, limited to what
// this app's main process registers, plus `window.interviewAppAPI` for the
// things the canvas used to provide (saved state, file and folder choosers).
const { contextBridge, ipcRenderer, webUtils } = require('electron');

function createListener(channel) {
  return (callback) => {
    const fn = (_event, data) => callback(data);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  };
}

contextBridge.exposeInMainWorld('electronAPI', {
  getPathForFile: file => webUtils.getPathForFile(file),

  // Career data
  parseCareerData: args => ipcRenderer.invoke('parse-career-data', args),
  inspectCareerCompileResume: args => ipcRenderer.invoke('inspect-career-compile-resume', args),
  onCareerCompileProgress: createListener('career-compile-progress'),
  loadInterviewHelperCareerSnapshot: args => ipcRenderer.invoke('load-interview-helper-career-snapshot', args),

  // Applications and preparation
  listInterviewApplicationFolders: (args) => {
    const { nodeId } = args || {};
    return ipcRenderer.invoke('list-interview-application-folders', { nodeId, canvasFilePath: null });
  },
  selectInterviewApplicationFolder: (args) => {
    const { nodeId, token } = args || {};
    return ipcRenderer.invoke('select-interview-application-folder', { nodeId, token });
  },
  loadInterviewApplicationBundle: args => ipcRenderer.invoke('load-interview-preparation-bundle', args),
  loadInterviewPreparedBrief: (args) => {
    const { nodeId, briefRecordId, snapshotId, jobUrl, bundleArtifactId, bundleArtifactDigest } = args || {};
    return ipcRenderer.invoke('load-interview-prepared-brief', {
      nodeId, briefRecordId, snapshotId, canonicalJobUrl: jobUrl, bundleArtifactId, bundleArtifactDigest,
    });
  },
  prepareInterviewBrief: (args) => {
    const { nodeId, snapshotId, jobUrl, bundleArtifactId, manualAiRunId } = args || {};
    return ipcRenderer.invoke('build-interview-brief', {
      nodeId, snapshotId, canonicalJobUrl: jobUrl, bundleArtifactId, manualAiRunId,
    });
  },

  // Q&A
  loadInterviewQa: (args) => {
    const { nodeId, snapshotId = null } = args || {};
    return ipcRenderer.invoke('load-interview-qa', { nodeId, snapshotId });
  },
  saveInterviewQaCard: (args) => {
    const { nodeId, scope, card } = args || {};
    return ipcRenderer.invoke('save-interview-qa-card', { nodeId, scope, card });
  },
  addInterviewQaCard: (args) => {
    const { nodeId, scope, card } = args || {};
    return ipcRenderer.invoke('add-interview-qa-card', { nodeId, scope, card });
  },
  deleteInterviewQaCard: (args) => {
    const { nodeId, scope, cardId } = args || {};
    return ipcRenderer.invoke('delete-interview-qa-card', { nodeId, scope, cardId });
  },

  // Interview view and practice call
  launchInterviewWindow: args => ipcRenderer.invoke('interview-window:launch', args),
  startPracticeCall: ({ nodeId, briefRecordId, snapshotId, canonicalJobUrl, bundleArtifactId, bundleArtifactDigest, steering }) => ipcRenderer.invoke('practice-call:start', {
    nodeId, briefRecordId, snapshotId, canonicalJobUrl, bundleArtifactId, bundleArtifactDigest,
    ...(typeof steering === 'string' ? { steering } : {}),
  }),
  openPracticeReplay: ({ nodeId, callId }) => ipcRenderer.invoke('practice-call:open-replay', { nodeId, callId }),
  listPracticeCalls: ({ nodeId }) => ipcRenderer.invoke('practice-call:list', { nodeId }),

  // Claude worker: progress, pause and accounts
  onNonApiAiRequest: createListener('non-api-ai-request'),
  onNonApiAiSettled: createListener('non-api-ai-settled'),
  replayPendingNonApiAiRequests: () => ipcRenderer.invoke('replay-pending-non-api-ai-requests'),
  cancelNonApiAiRequest: requestId => ipcRenderer.invoke('cancel-non-api-ai-request', { requestId }),
  completeNonApiAiRun: runId => ipcRenderer.invoke('complete-non-api-ai-run', { runId }),
  completeNonApiAiRuns: runIds => ipcRenderer.invoke('complete-non-api-ai-runs', { runIds }),
  getClaudeTaskStatus: () => ipcRenderer.invoke('get-claude-task-status'),
  getClaudeTaskActivity: () => ipcRenderer.invoke('get-claude-task-activity'),
  onClaudeTaskActivity: createListener('claude-task:activity'),
  holdClaude: key => ipcRenderer.invoke('claude-pause:hold', { key }),
  releaseClaude: key => ipcRenderer.invoke('claude-pause:release', { key }),
  drainClaude: key => ipcRenderer.invoke('claude-pause:drain', { key }),
  stopRunningClaude: key => ipcRenderer.invoke('claude-pause:stop-running', { key }),
  resumeClaudeUsageNow: () => ipcRenderer.invoke('claude-usage:resume-now'),
  listClaudeAccounts: () => ipcRenderer.invoke('claude-accounts:list'),
  addClaudeAccount: () => ipcRenderer.invoke('claude-accounts:add'),
  removeClaudeAccount: id => ipcRenderer.invoke('claude-accounts:remove', { id }),
  cancelClaudeAccountLogin: () => ipcRenderer.invoke('claude-accounts:cancel-login'),

  cancelNodeTask: (nodeId, cause = null, manualAiRunIds = []) => ipcRenderer.send('cancel-node-task', nodeId, cause, manualAiRunIds),
  cancelNodeTaskAndWait: (nodeId, cause = null, manualAiRunIds = []) => ipcRenderer.invoke('cancel-node-task-and-wait', {
    nodeId, cause, manualAiRunIds,
  }),
});

contextBridge.exposeInMainWorld('interviewAppAPI', Object.freeze({
  loadState: () => ipcRenderer.invoke('interview-app:load-state'),
  saveState: state => ipcRenderer.invoke('interview-app:save-state', state),
  chooseCareerFiles: () => ipcRenderer.invoke('interview-app:choose-career-files'),
  chooseAppliedJobsFolder: () => ipcRenderer.invoke('interview-app:choose-applied-jobs-folder'),
  readCanvasInterviews: () => ipcRenderer.invoke('interview-app:read-canvas-interviews'),
  resolveInterviewTypedJob: (args) => {
    const { nodeId, text } = args || {};
    return ipcRenderer.invoke('resolve-interview-typed-job', { nodeId, text });
  },
  // Career files of any type are converted to text before the text-only compile reads them.
  convertCareerFiles: (args) => {
    const { nodeId, filePaths } = args || {};
    return ipcRenderer.invoke('convert-interview-career-files', { nodeId, filePaths });
  },
  // Shows one converted text file in the file manager; the renderer names it only by an opaque token.
  revealConvertedCareerFile: (args) => {
    const { token } = args || {};
    return ipcRenderer.invoke('interview-app:reveal-converted-career-file', { token });
  },
}));
