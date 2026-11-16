// Main process of the standalone Interview Helper app.
//
// Interview Helper used to be a node inside Infinite Canvas. It is packaged
// here as its own app (own bundle id, build output and Electron profile) so
// either app can be rebuilt and relaunched without touching the other. All
// feature code is imported from the shared modules under electron/ and src/.
import electronPkg from 'electron';
import path from 'path';
import { logger } from '../logger.js';
import { pathToFileURL } from 'node:url';
import { configureCareerSnapshotDataRoot, registerCareerDataHandlers } from '../ipc/jobs.js';
import { loadInterviewHelperCareerSnapshot, registerInterviewHelperHandlers } from '../ipc/interviewHelper.js';
import { loadInterviewPreparationBundle, registerInterviewPreparationHandlers } from '../ipc/interviewPreparation.js';
import { createInterviewWindowController } from '../interviewWindow.js';
import { createInterviewTalkingPoints } from '../interviewTalkingPoints.js';
import { createPracticeCallController, createReplayHandler } from '../practiceCall/callWindow.js';
import { createPracticeAudioHelper, practiceAudioHelperPath } from '../interviewPracticeAudio.js';
import { getInterviewPracticeRegistry } from '../ipc/interviewPracticeRegistry.js';
import { createInterviewClaudeTransport } from '../ipc/interviewClaudeTransport.js';
import { recheckClaudeUsageAfterWake } from '../ipc/claudePause.js';
import { recordClaudePauseEvent } from '../ipc/claudePauseDiagnostics.js';
import { registerNetworkHandlers } from '../ipc/network.js';
import { flushNonApiAiPersistence, registerNonApiAiHandlers } from '../ipc/nonApiAi.js';
import { registerClaudePauseHandlers, registerClaudeTaskActivityHandler, registerClaudeTaskStatusHandler, startClaudeTaskWorker, wakeClaudeTaskWorker } from '../ipc/claudeTaskWorker.js';
import { registerRendererPrivateAppRoot } from '../utils/pathSafety.js';
import { createInterviewSessionStore, readInterviewHelperNodesFromCanvas } from './sessionStore.js';
import { interviewAppDataRoots } from './dataRoots.js';

const { app, BrowserWindow, dialog, ipcMain, protocol, shell } = electronPkg;

// The profile folder must be this app's own: two running Electron apps cannot
// share one. Set before `ready`, and before anything reads the path.
app.setName('Interview Helper');
const roots = interviewAppDataRoots({ appDataPath: app.getPath('appData'), env: process.env });
app.setPath('userData', roots.profile);

// Interview data (prepared briefs, answer banks, Q&A, practice calls, career
// snapshots) stays in the folder Infinite Canvas created, so nothing is copied.
// The shared stores take their root from `appInstance.getPath('userData')`.
const dataApp = Object.freeze({
  getPath: name => (name === 'userData' ? roots.data : app.getPath(name)),
  getAppPath: () => app.getAppPath(),
  get isPackaged() { return app.isPackaged; },
});

const RENDERER_DIR = path.join(__dirname, '../dist-interview');
const RENDERER_HTML = path.join(RENDERER_DIR, 'interview.html');
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || null;
const asarUnpacked = file => file.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);

function isOwnRendererUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.search = ''; url.hash = '';
    const own = DEV_SERVER_URL ? new URL('interview.html', DEV_SERVER_URL).toString() : pathToFileURL(RENDERER_HTML).toString();
    return url.toString() === own;
  } catch { return false; }
}

let mainWindow = null;
let interviewWindowController = null;
let practiceCallController = null;
let quitting = false;

const isMainWindow = owner => !!owner && owner === mainWindow && !owner.isDestroyed();
function ownerOf(sender) {
  try {
    const contents = sender?.webContents ?? electronPkg.webContents?.fromFrame?.(sender) ?? sender;
    return BrowserWindow.fromWebContents(contents) || null;
  } catch { return null; }
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); return mainWindow; }
  const win = new BrowserWindow({
    width: 1180, height: 860, minWidth: 720, minHeight: 520,
    title: 'Interview Helper', backgroundColor: '#111018', show: false,
    webPreferences: {
      preload: path.join(__dirname, 'interviewAppPreload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      // Preparation keeps running while the window is behind a call app.
      backgroundThrottling: false,
    },
  });
  mainWindow = win;
  win.webContents.__isInterviewAppRenderer = true;
  win.once('ready-to-show', () => { try { win.show(); } catch { /* closed before show */ } });
  win.on('closed', () => {
    interviewWindowController?.cleanupOwner(win);
    if (mainWindow === win) mainWindow = null;
  });
  if (DEV_SERVER_URL) win.loadURL(new URL('interview.html?view=interview-helper', DEV_SERVER_URL).toString());
  else win.loadFile(RENDERER_HTML, { search: 'view=interview-helper' });
  return win;
}

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    // Source links in the Q&A open in the default browser; nothing opens in-app.
    if (contents.__isInterviewAppRenderer) {
      try { if (['http:', 'https:'].includes(new URL(url).protocol)) void shell.openExternal(url); } catch { /* invalid link */ }
    }
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.on('will-navigate', (event, navigationUrl) => {
    // Every window of this app shows one page of its own renderer bundle.
    if (!isOwnRendererUrl(navigationUrl)) event.preventDefault();
  });
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  protocol.registerSchemesAsPrivileged([
    // Replay audio of practice calls; only known call ids are served.
    { scheme: 'practice-call', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
  app.on('second-instance', () => { if (app.isReady()) createMainWindow(); });

  app.whenReady().then(async () => {
    await roots.ensure();
    // The shared data folder holds private stores; no renderer may read it by path.
    try { registerRendererPrivateAppRoot(roots.data); registerRendererPrivateAppRoot(roots.profile); } catch { /* guard is advisory here */ }
    configureCareerSnapshotDataRoot(roots.data);

    const sessions = createInterviewSessionStore({ filePath: path.join(roots.data, 'interview-helper-sessions.json') });
    const guarded = handler => async (event, ...args) => {
      // Only the top frame of this app's own window may read or change saved interviews.
      if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || (event.senderFrame && event.senderFrame.parent)) throw new Error('Interview Helper request was not authorized.');
      return handler(...args);
    };
    ipcMain.handle('interview-app:load-state', guarded(() => sessions.load()));
    ipcMain.handle('interview-app:save-state', guarded(state => sessions.save(state)));
    ipcMain.handle('interview-app:choose-career-files', guarded(async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose career files', properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Career data (text)', extensions: ['md', 'txt'] }],
      });
      return result.canceled ? [] : result.filePaths;
    }));
    ipcMain.handle('interview-app:choose-applied-jobs-folder', guarded(async () => {
      const current = (await sessions.load()).appliedJobsFolder;
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose your Applied Jobs folder', properties: ['openDirectory'],
        ...(current ? { defaultPath: current } : {}),
      });
      return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
    }));
    ipcMain.handle('interview-app:read-canvas-interviews', guarded(async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose an Infinite Canvas file', properties: ['openFile'],
        filters: [{ name: 'Canvas', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePaths[0]) return { cancelled: true };
      // Read-only: the canvas file is never written from this app.
      return { ...(await readInterviewHelperNodesFromCanvas(result.filePaths[0])), canvasFolder: path.dirname(result.filePaths[0]) };
    }));

    registerCareerDataHandlers();
    registerInterviewHelperHandlers({ appInstance: dataApp });
    registerInterviewPreparationHandlers({
      appInstance: dataApp,
      // No canvas here: the list comes from the folder chosen in this app.
      resolveAppliedJobsRoot: async () => (await sessions.load()).appliedJobsFolder || null,
    });
    interviewWindowController = createInterviewWindowController({
      BrowserWindow, ipcMain, appInstance: dataApp,
      isAuthorizedOwner: isMainWindow,
      loadSnapshot: ({ snapshotId, userDataPath }) => loadInterviewHelperCareerSnapshot({ snapshotId, userDataPath }),
      loadBundle: ({ artifactId, userDataPath }) => loadInterviewPreparationBundle({ artifactId, userDataPath }),
      preloadPath: path.join(__dirname, 'interviewWindowPreload.js'),
      // Live talking points for questions no prepared card answers.
      createTalkingPoints: createInterviewTalkingPoints,
      devServerUrl: DEV_SERVER_URL ? new URL('interview.html', DEV_SERVER_URL).toString() : null,
      distHtmlPath: RENDERER_HTML,
    });
    try {
      const reviewTransport = createInterviewClaudeTransport();
      const practiceCallText = ({ prompt, schema, signal } = {}) => reviewTransport.callText(prompt, {
        signal, task: 'practice-review', claudeStage: 'qa-practice-review', responseSchema: schema,
      });
      const helperPath = practiceAudioHelperPath({ packaged: app.isPackaged, projectDir: app.getAppPath() || process.cwd() });
      practiceCallController = createPracticeCallController({
        BrowserWindow, ipcMain, appInstance: dataApp,
        isAuthorizedOwner: sender => { const owner = ownerOf(sender); return !!owner && !owner.isDestroyed() && (isMainWindow(owner) || owner === practiceCallController?.getWindow()); },
        preloadPath: path.join(__dirname, 'practiceCallPreload.js'),
        devServerUrl: DEV_SERVER_URL ? new URL('interview.html', DEV_SERVER_URL).toString() : null,
        distHtmlPath: RENDERER_HTML,
        callText: practiceCallText,
        registry: getInterviewPracticeRegistry(),
        serviceOptions: {
          callText: practiceCallText, registry: getInterviewPracticeRegistry(),
          inferenceWorkerPath: asarUnpacked(path.join(__dirname, 'inferenceWorkerThread.js')),
          // The packaged helper lives in Resources; the default only knows the project folder.
          helperFactory: options => createPracticeAudioHelper({ ...options, helperPath }),
        },
      });
      protocol.handle('practice-call', createReplayHandler({ store: practiceCallController.store }));
    } catch (error) {
      logger.warn(`[PracticeCall] unavailable: ${error?.message || error}`);
    }

    registerNetworkHandlers({ onNodeDeleted: (sender, nodeId) => interviewWindowController?.cleanupBySenderAndNode(sender, nodeId) });
    registerNonApiAiHandlers();
    // Career compilation is answered by the local Claude Code CLI through this worker.
    startClaudeTaskWorker({ userData: roots.profile, nativeImage: electronPkg.nativeImage, getAllWindows: () => BrowserWindow.getAllWindows() });
    registerClaudeTaskStatusHandler({ ipcMain });
    registerClaudeTaskActivityHandler({ ipcMain });
    registerClaudePauseHandlers({ ipcMain });
    try {
      electronPkg.powerMonitor.on('suspend', () => recordClaudePauseEvent({ kind: 'system-suspend' }));
      electronPkg.powerMonitor.on('resume', () => {
        try { recordClaudePauseEvent({ kind: 'system-resume' }); recheckClaudeUsageAfterWake(); wakeClaudeTaskWorker(); } catch { /* a wake re-check cannot affect the app */ }
      });
    } catch { /* no power monitor: timers alone still resume the work */ }
    createMainWindow();
    app.on('activate', () => createMainWindow());
  }).catch(error => {
    logger.error(`[InterviewApp] startup failed: ${error?.stack || error}`);
    dialog.showErrorBox('Interview Helper could not start', String(error?.message || error));
    app.exit(1);
  });

  app.on('window-all-closed', () => { app.quit(); });
  app.on('before-quit', event => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    Promise.resolve()
      .then(() => flushNonApiAiPersistence())
      .catch(() => {})
      .finally(() => { try { practiceCallController?.dispose(); } catch { /* already closed */ } app.exit(0); });
  });
}
