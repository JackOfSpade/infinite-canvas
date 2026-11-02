import electronPkg from 'electron';
const { app, BrowserWindow, Menu, protocol, nativeImage } = electronPkg;
import path from 'path';
import { registerFilesystemHandlers } from './ipc/filesystem.js';
import { resolveMissingPreviewPath } from './ipc/missingPreviewRelink.js';
import {
  assertPrivateLocalFileReservation,
  assertLocalFileLookupPathAllowed,
  assertPinnedLocalFileBinding,
  createPrivateLocalFileOutputDirectory,
  createPrivateLocalFileWorkDirectory,
  createPinnedLocalReadStream,
  decodeLocalFileRequestPath,
  isLocalFileSafetyError,
  openPinnedLocalFile,
  readPrivateLocalFile,
  removePrivateLocalFileWorkDirectory,
  reservePrivateLocalFile,
} from './localFileProtocol.js';
import { isProductImageExtension } from '../src/utils/fileExtensions.js';
import { isExistingFile, isRendererSensitivePath } from './utils/pathSafety.js';
import {
  initialCanvasWindowSpec,
  openOrFocusCanvasWindow,
  resolveSafeCanvasFilePath,
  secondInstanceCanvasWindowSpec,
} from './canvasCommandLine.js';
import { isTrustedCanvasNavigation } from './canvasNavigation.js';
import { logger } from './logger.js';
import { attachRendererRecovery, hasStoppedRenderer, recordRendererCrash } from './rendererRecovery.js';
import { registerJobsHandlers } from './ipc/jobs.js';
import { loadInterviewHelperCareerSnapshot, registerInterviewHelperHandlers } from './ipc/interviewHelper.js';
import { loadInterviewPreparationBundle, registerInterviewPreparationHandlers } from './ipc/interviewPreparation.js';
import { createInterviewWindowController, isTrustedInterviewNavigation } from './interviewWindow.js';
import { registerJobApplicationHandlers } from './ipc/jobApplication.js';
import { getLocalApplicationHandoff, registerLocalAiApplicationHandlers, submitLocalApplicationHandoff, stopLocalApplicationJob, subscribeLocalApplicationDiscards } from './ipc/localAiApplication.js';
import { createClaudeApplicationRunner, registerClaudeApplicationRunnerHandlers } from './ipc/claudeApplicationRunner.js';
import { registerApplicationGenerationGateHandlers } from './ipc/applicationGenerationGate.js';
import { registerApplicationBundleWatchHandlers } from './ipc/applicationBundleWatch.js';
import { startApplicationSyncServer, stopApplicationSyncServer } from './ipc/applicationSync.js';
import { assertDesignSystemIntact } from './ipc/resumeHtml.js';
import { registerMarketplaceHandlers } from './ipc/marketplace.js';
import { registerAccountsHandlers, schedulePlatformVerification, verifyAllPlatforms } from './ipc/accounts.js';
import { closeAllPages } from './ipc/browserPool.js';
import { closeAllAuthWindows, closeStealthBrowser } from './ipc/stealthBrowser.js';
import { registerBugReportHandlers } from './ipc/bugReport.js';
import { pruneSavedBugReports } from './ipc/bugReport/reportFile.js';
import { registerNetworkHandlers } from './ipc/network.js';
import { registerSettingsHandlers } from './ipc/settings.js';
import { flushNonApiAiPersistence, hasPendingNonApiAiRequestsForSender, registerNonApiAiHandlers } from './ipc/nonApiAi.js';
import { registerClaudeTaskStatusHandler, startClaudeTaskWorker } from './ipc/claudeTaskWorker.js';
import { beginSenderQuitPause, releaseSenderQuitPause, drainSenderNodeTasksForQuit, handleSafe } from './ipc/ipcUtils.js';
import { startPracticeConnector, stopPracticeConnector } from './ipc/practiceConnector/index.js';
import fs from 'fs';
import { Readable } from 'node:stream';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { isBackgroundE2E as isBackgroundE2ERuntime, runBackgroundE2EShutdownCleanup } from './utils/backgroundE2e.js';
import { acceptanceActivationPolicy, shouldSuppressNativeApplicationMenu } from './utils/acceptanceNoNativeMenu.js';
import { createPendingGlobalQuitDeferral } from './utils/quitDeferral.js';
import { createQuitAutosaveAttempt } from './utils/quitAutosave.js';

const execFile = promisify(execFileCb);

// Electron smoke runs must remain invisible to the person using the desktop.
// This is intentionally a separate flag from INFINITE_CANVAS_E2E: lightweight
// automation can still opt into normal windows, whereas the Playwright smoke
// explicitly requests a background-only renderer.
const isBackgroundE2E = isBackgroundE2ERuntime();
// Unlike background smoke this remains a visible, focusable, fully featured
// application.  It suppresses only the native menu for the disposable
// computer-use acceptance fixture (see acceptanceNoNativeMenu.js).
const suppressNativeApplicationMenu = shouldSuppressNativeApplicationMenu({ isBackgroundE2E, commandLine: process.argv });
// This must happen before app readiness/window construction: hiding the Dock
// after ready can still allow a launch-time activation flash on macOS.
if (isBackgroundE2E && process.platform === 'darwin') {
  app.setActivationPolicy?.('prohibited');
} else {
  const acceptancePolicy = acceptanceActivationPolicy({ commandLine: process.argv });
  if (acceptancePolicy) app.setActivationPolicy?.(acceptancePolicy);
}

// Minimal extension → MIME map for media types served via local-file://.
// Chromium's media stack needs a sensible Content-Type to commit to a decoder pipeline,
// and an explicit type avoids relying on sniffing for partial-content responses.
const LOCAL_FILE_MIME_TYPES = {
  '.mp4':  'video/mp4',
  '.m4v':  'video/mp4',
  '.mov':  'video/quicktime',
  '.webm': 'video/webm',
  '.mkv':  'video/x-matroska',
  '.ogv':  'video/ogg',
  '.mp3':  'audio/mpeg',
  '.m4a':  'audio/mp4',
  '.aac':  'audio/aac',
  '.wav':  'audio/wav',
  '.ogg':  'audio/ogg',
  '.flac': 'audio/flac',
  '.opus': 'audio/opus',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
  '.bmp':  'image/bmp',
  '.avif': 'image/avif',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

// Raster image formats Chromium CANNOT decode in an <img>, so the local-file
// protocol transcodes them to JPEG via sips before serving (HEIC/HEIF lack an
// H.265 decoder; TIFF/JXL aren't supported either). Everything Chromium handles
// natively (jpg/png/gif/webp/bmp/avif/ico/svg) streams through untouched.
const DISPLAY_TRANSCODE_EXT = new Set(['.heic', '.heif', '.tiff', '.tif', '.jxl']);
const MARKETPLACE_PREVIEW_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif', '.ico',
  '.heic', '.heif', '.tiff', '.tif', '.jxl',
]);
const MARKETPLACE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
const MARKETPLACE_PREVIEW_DEFAULT_DIMENSION = 1600;
const MARKETPLACE_PREVIEW_QUALITY_STEPS = [82, 72, 60, 48, 36, 24];
const MARKETPLACE_PREVIEW_CACHE_MAX_BYTES = 80 * 1024 * 1024;
const marketplacePreviewCache = new Map();
// Main-process Claude Code application runner (created after app ready).
let claudeApplicationRunner;
let marketplacePreviewCacheBytes = 0;

function clampNumber(value, fallback, min, max) {
  // Number(null) === 0 (finite), so a missing query param must be rejected
  // before the Number() coercion — otherwise an absent maxBytes/maxDimension
  // silently clamps to `min` instead of using `fallback`.
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function resizeNativeImageToFit(image, maxDimension) {
  const size = image.getSize();
  const width = Number(size?.width) || 0;
  const height = Number(size?.height) || 0;
  if (width <= 0 || height <= 0) return image;

  const scale = Math.min(1, maxDimension / Math.max(width, height));
  if (scale >= 1) return image;

  return image.resize({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    quality: 'best',
  });
}

function encodeNativeImageUnderLimit(image, { maxBytes, maxDimension }) {
  let dimension = maxDimension;
  while (dimension >= 128) {
    const resized = resizeNativeImageToFit(image, dimension);
    if (!resized || resized.isEmpty()) return null;

    for (const quality of MARKETPLACE_PREVIEW_QUALITY_STEPS) {
      const buffer = resized.toJPEG(quality);
      if (buffer.length <= maxBytes) return buffer;
    }

    dimension = Math.floor(dimension * 0.65);
  }
  return null;
}

/**
 * sips only accepts a pathname or directory for --out and internally stages a
 * temporary file before rename.  Give it a fresh host-only directory rather
 * than a shared os.tmpdir filename; bind the expected result before returning
 * any bytes.  This deliberately has no disk cache: an untrusted cache hit is
 * worse than a repeat conversion, while the in-memory preview LRU above never
 * reopens a filesystem path.
 */
async function createPrivateSipsJpegBuffer(filePath, workDirectory, sipsArgs, sourceReservation = null) {
  if (sourceReservation) {
    await assertPrivateLocalFileReservation(workDirectory, sourceReservation);
  }
  const output = await createPrivateLocalFileOutputDirectory(workDirectory);
  const outputPath = path.join(output.directory, 'source.jpg');
  try {
    await execFile('/usr/bin/sips', [...sipsArgs, filePath, '--out', output.directory]);
    await assertPrivateLocalFileReservation(output.directory, {
      filePath: output.markerPath,
      identity: output.markerIdentity,
    });
    return await readPrivateLocalFile(output.directory, outputPath);
  } finally {
    // The converter namespace is a private child created for this one call.
    // Its cleanup helper refuses a substituted top-level directory rather than
    // recursively chasing a symlink during an error path.
    await removePrivateLocalFileWorkDirectory(output.directory, { storageRoot: workDirectory }).catch(() => {});
  }
}

async function createSipsPreviewBuffer(filePath, {
  maxBytes,
  maxDimension,
  workDirectory,
  sourceReservation,
}) {
  let dimension = maxDimension;
  while (dimension >= 128) {
    for (const quality of MARKETPLACE_PREVIEW_QUALITY_STEPS) {
      try {
        const buffer = await createPrivateSipsJpegBuffer(filePath, workDirectory, [
          '-Z', String(dimension),
          '-s', 'format', 'jpeg',
          '-s', 'formatOptions', String(quality),
        ], sourceReservation);
        if (buffer.length <= maxBytes) return buffer;
      } catch {
        return null;
      }
    }
    dimension = Math.floor(dimension * 0.65);
  }
  return null;
}

async function createMarketplacePreviewBuffer(filePath, {
  maxBytes,
  maxDimension,
  workDirectory,
  sourceReservation,
}) {
  await assertPrivateLocalFileReservation(workDirectory, sourceReservation);
  const sourceImage = nativeImage.createFromPath(filePath);
  if (sourceImage && !sourceImage.isEmpty()) {
    const directBuffer = encodeNativeImageUnderLimit(sourceImage, { maxBytes, maxDimension });
    if (directBuffer) return directBuffer;
  }

  const sipsBuffer = await createSipsPreviewBuffer(filePath, {
    maxBytes,
    maxDimension,
    workDirectory,
    sourceReservation,
  });
  if (sipsBuffer) return sipsBuffer;

  const thumbnail = await nativeImage.createThumbnailFromPath(filePath, {
    width: maxDimension,
    height: maxDimension,
  });
  if (!thumbnail || thumbnail.isEmpty()) return null;
  return encodeNativeImageUnderLimit(thumbnail, { maxBytes, maxDimension });
}

// External image decoders accept only a pathname.  Do not hand them a
// renderer-controlled pathname after it has been checked: copy the already
// pinned descriptor to a private, unpredictable temp directory first.  The
// decoder therefore sees exactly the bytes whose identity was approved by the
// local-file protocol, even if the renderer spelling is replaced meanwhile.
async function materializePinnedLocalFile(pinnedFile, extension = '') {
  const workspace = await createPrivateLocalFileWorkDirectory(app.getPath('userData'));
  const safeExtension = /^\.[a-z0-9]{1,16}$/iu.test(extension) ? extension.toLowerCase() : '';
  let reservation = null;
  const sourcePath = path.join(workspace.directory, `source${safeExtension}`);
  try {
    reservation = await reservePrivateLocalFile(workspace.directory, path.basename(sourcePath));
    const sourceReservation = {
      filePath: reservation.filePath,
      identity: reservation.identity,
    };
    const input = createPinnedLocalReadStream(pinnedFile, { start: 0, closeOnEnd: false });
    // Write through the O_EXCL|O_NOFOLLOW descriptor returned by the private
    // workspace reservation. No renderer-controlled pathname is reopened.
    const output = fs.createWriteStream(null, { fd: reservation.handle.fd, autoClose: false });
    await new Promise((resolve, reject) => {
      const fail = error => {
        input.destroy();
        output.destroy();
        reject(error);
      };
      input.once('error', fail);
      output.once('error', fail);
      output.once('finish', resolve);
      input.pipe(output);
    });
    await reservation.close();
    reservation = null;
    return {
      sourcePath,
      workDirectory: workspace.directory,
      sourceReservation,
      cleanup: () => removePrivateLocalFileWorkDirectory(workspace.directory, { storageRoot: workspace.storageRoot }),
    };
  } catch (error) {
    await reservation?.close().catch(() => {});
    await pinnedFile.close().catch(() => {});
    await removePrivateLocalFileWorkDirectory(workspace.directory, { storageRoot: workspace.storageRoot }).catch(() => {});
    throw error;
  }
}

function getMarketplacePreviewCache(key) {
  const hit = marketplacePreviewCache.get(key);
  if (!hit) return null;
  marketplacePreviewCache.delete(key);
  marketplacePreviewCache.set(key, hit);
  return hit.buffer;
}

function setMarketplacePreviewCache(key, buffer) {
  // Two protocol requests for the same source can finish their preview work at
  // nearly the same time. Replacing an existing entry must first remove its
  // prior byte count; otherwise one Map entry is charged twice and the LRU
  // budget eventually evicts healthy, unrelated previews too early.
  const previous = marketplacePreviewCache.get(key);
  if (previous) {
    marketplacePreviewCache.delete(key);
    marketplacePreviewCacheBytes -= previous.bytes || 0;
  }
  marketplacePreviewCache.set(key, { buffer, bytes: buffer.length });
  marketplacePreviewCacheBytes += buffer.length;

  while (marketplacePreviewCacheBytes > MARKETPLACE_PREVIEW_CACHE_MAX_BYTES) {
    const oldestKey = marketplacePreviewCache.keys().next().value;
    if (!oldestKey) break;
    const oldest = marketplacePreviewCache.get(oldestKey);
    marketplacePreviewCache.delete(oldestKey);
    marketplacePreviewCacheBytes -= oldest?.bytes || 0;
  }
}

// In the Rollup CJS bundle, __dirname and __filename are CJS globals — no
// declaration needed. This file is always built as CJS (see vite.config.js).

// ── Global Exception Handlers ────────────────────────────────────────────────
// Prevents the main process from crashing unexpectedly in production due to 
// unhandled promise rejections or rogue callbacks from external dependencies.
process.on('uncaughtException', (err) => {
  console.error('[Main Process] Uncaught Exception:', err);
  // Log but do not exit — keeps the window alive even if a background task fails
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Main Process] Unhandled Rejection at:', promise, 'reason:', reason);
});

// ── Multi-window state ─────────────────────────────────────────────────────
// The app supports several canvas windows open at once (File ▸ New Canvas,
// File ▸ Open Canvas, or relaunching the app). Each window is an independent
// canvas; shared resources (browser pool, stealth browser, electron-store,
// localStorage) live once in this single main process and are deliberately
// shared — running multiple OS processes would fight over those.
const canvasWindows = new Set();
let interviewWindowController = null;
// Most-recently focused canvas window — menu actions target this so File ▸ Save
// etc. act on the window the user is actually looking at.
let lastFocusedCanvasWindow = null;
// Cascades successive windows so they don't land exactly on top of each other.
let newWindowOffset = 0;
let isQuitting = false;
let quitHandshakeInFlight = false;
const pendingGlobalQuit = createPendingGlobalQuitDeferral();
// A late renderer response from a timed-out close request must never satisfy
// a later request for the same window.
let rendererHandshakeRequestId = 0;
// Background quit cleanup is asynchronous. Keep its promise visible so a
// second app.quit/window-all-closed event can still prevent its default exit
// while the first event releases the browser profile and loopback server.
let backgroundE2ECleanupInFlight = null;
const gotTheLock = app.requestSingleInstanceLock();

/** The canvas window a menu action should target: focused, else most-recent. */
function getTargetCanvasWindow() {
  const focused = electronPkg.BrowserWindow.getFocusedWindow();
  if (focused && canvasWindows.has(focused) && !focused.isDestroyed()) return focused;
  if (lastFocusedCanvasWindow && !lastFocusedCanvasWindow.isDestroyed()) return lastFocusedCanvasWindow;
  for (const win of canvasWindows) if (!win.isDestroyed()) return win;
  return null;
}

/**
 * Ask a window's renderer to save, and resolve once it reports back. There is
 * deliberately no fixed timeout: for a never-saved canvas the renderer's save
 * routes through a native, human-paced Save dialog (filesystem.js's
 * 'save-workspace' handler, `dialog.showSaveDialog`) whose duration is
 * unbounded, and a short race here would abandon the close/quit while that
 * dialog is still open on screen. The only thing that can make a reply
 * genuinely impossible is the window itself going away, so that's the sole
 * early-out. Shared by the per-window close handler and the app-wide quit
 * handler.
 */
function requestSaveAndWait(win, { skipDocumentSessions = false, forceCanvasSave = false } = {}) {
  return new Promise(resolve => {
    const expectedSender = win.webContents;
    const requestId = ++rendererHandshakeRequestId;
    let settled = false;
    const finish = (success) => {
      if (settled) return;
      settled = true;
      electronPkg.ipcMain.removeListener('save-response', saveHandler);
      expectedSender.removeListener('destroyed', onDestroyed);
      expectedSender.removeListener('did-start-navigation', onMainFrameNavigation);
      expectedSender.removeListener('render-process-gone', onRenderProcessGone);
      resolve(success);
    };
    const saveHandler = (event, { success, requestId: responseRequestId } = {}) => {
      if (event.sender !== expectedSender || responseRequestId !== requestId) return;
      finish(Boolean(success));
    };
    const onDestroyed = () => finish(false);
    // A reload preserves WebContents but discards the renderer callback that
    // received this request. Do not leave the save promise/listener hanging.
    const onMainFrameNavigation = (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) finish(false);
    };
    const onRenderProcessGone = () => finish(false);
    electronPkg.ipcMain.on('save-response', saveHandler);
    expectedSender.once('destroyed', onDestroyed);
    expectedSender.on('did-start-navigation', onMainFrameNavigation);
    expectedSender.once('render-process-gone', onRenderProcessGone);
    if (!safeMenuSend(win, 'request-save-and-respond', {
      requestId,
      skipDocumentSessions,
      forceCanvasSave,
    })) finish(false);
  });
}

function requestQuitCommitAndWait(win) {
  // A dead renderer has no mutable editor to fence and cannot ACK. Continue
  // to checkUnsavedChanges, which still requires explicit native confirmation
  // before abandoning unverified work. Hung/live renderers keep the fence.
  if (hasStoppedRenderer(win)) return Promise.resolve(true);
  return new Promise(resolve => {
    const expectedSender = win.webContents;
    const requestId = ++rendererHandshakeRequestId;
    let timer;
    let settled = false;
    const finish = (success) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      electronPkg.ipcMain.removeListener('quit-commit-ack', handler);
      expectedSender.removeListener('destroyed', onUnavailable);
      expectedSender.removeListener('did-start-navigation', onNavigation);
      expectedSender.removeListener('render-process-gone', onUnavailable);
      resolve(success);
    };
    const handler = (event, { requestId: responseRequestId } = {}) => {
      if (event.sender === expectedSender && responseRequestId === requestId) finish(true);
    };
    const onUnavailable = () => finish(false);
    const onNavigation = (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) finish(false);
    };
    electronPkg.ipcMain.on('quit-commit-ack', handler);
    expectedSender.once('destroyed', onUnavailable);
    expectedSender.on('did-start-navigation', onNavigation);
    expectedSender.once('render-process-gone', onUnavailable);
    timer = setTimeout(() => finish(false), 1500);
    if (!safeMenuSend(win, 'quit-commit-request', { requestId })) finish(false);
  });
}

function requestQuitPauseAndWait(win) {
  if (win.isDestroyed() || hasStoppedRenderer(win)) return Promise.resolve({ success: false });
  return new Promise(resolve => {
    const expectedSender = win.webContents;
    const requestId = ++rendererHandshakeRequestId;
    let timer;
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      electronPkg.ipcMain.removeListener('quit-pause-ack', handler);
      expectedSender.removeListener('destroyed', onUnavailable);
      expectedSender.removeListener('did-start-navigation', onNavigation);
      expectedSender.removeListener('render-process-gone', onUnavailable);
      resolve(result);
    };
    const handler = (event, { requestId: responseRequestId, success, requiresCanvasSave } = {}) => {
      if (event.sender !== expectedSender || responseRequestId !== requestId) return;
      finish({ success: success === true, requiresCanvasSave: requiresCanvasSave === true });
    };
    const onUnavailable = () => finish({ success: false });
    const onNavigation = (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) onUnavailable();
    };
    electronPkg.ipcMain.on('quit-pause-ack', handler);
    expectedSender.once('destroyed', onUnavailable);
    expectedSender.on('did-start-navigation', onNavigation);
    expectedSender.once('render-process-gone', onUnavailable);
    timer = setTimeout(onUnavailable, 120000);
    if (!safeMenuSend(win, 'quit-pause-request', { requestId })) onUnavailable();
  });
}

function releaseQuitCommit(windows) {
  for (const win of windows) safeMenuSend(win, 'quit-commit-release');
}

/**
 * Show the standard "unsaved changes" warning and map the user's choice to a
 * verb. `verbButton` is the middle-button suffix ("Quit"/"Close"/"Proceed");
 * `verbPhrase` is the in-sentence action ("quit" / "close this window" / …).
 * Returns 'save' | 'proceed' | 'cancel'. Shared by the window-close handshake
 * and the renderer-initiated 'prompt-unsaved-changes' IPC so both read identically.
 */
function showUnsavedChangesDialog(win, verbButton, verbPhrase) {
  // A hidden background test must never surface a native modal. Its disposable
  // workspace is intentionally allowed to close without a save handshake.
  if (isBackgroundE2E) return 'proceed';
  const choice = electronPkg.dialog.showMessageBoxSync(win, {
    type: 'warning',
    buttons: ['Save', `${verbButton} Without Saving`, 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    title: 'Unsaved Changes',
    message: `You have unsaved changes. Do you want to save before you ${verbPhrase}? Your unsaved work will be lost otherwise.`,
  });
  return choice === 0 ? 'save' : choice === 1 ? 'proceed' : 'cancel';
}

/**
 * A shared Markdown/text document could not be settled. Its draft is not a
 * canvas payload, so a canvas Save As dialog cannot repair it. Ask explicitly
 * before discarding it, then let the ordinary canvas-dirty prompt run too.
 */
function showDocumentSaveFailureDialog(win, actionType) {
  if (isBackgroundE2E) return 'proceed';
  const verb = actionType === 'quit' ? 'Quit' : 'Close';
  const choice = electronPkg.dialog.showMessageBoxSync(win, {
    type: 'warning',
    buttons: ['Keep Editing', `${verb} Without Saving`],
    defaultId: 0,
    cancelId: 0,
    title: 'Text File Needs Attention',
    message: 'A Markdown or text file has unsaved changes or a save conflict. Keep editing to resolve it, or close without saving that file.',
  });
  return choice === 1 ? 'proceed' : 'cancel';
}

/**
 * Unlike a reported document conflict, a timed-out renderer tells us nothing
 * about either its text sessions or its canvas dirty flag. Only an explicit
 * whole-window discard may proceed; treating it as a document-only failure
 * could accidentally skip a dirty canvas prompt.
 */
function showUnverifiedSaveStateDialog(win, actionType) {
  if (isBackgroundE2E) return 'proceed';
  const verb = actionType === 'quit' ? 'Quit' : 'Close';
  const choice = electronPkg.dialog.showMessageBoxSync(win, {
    type: 'warning',
    buttons: ['Keep Window Open', `${verb} Without Saving`],
    defaultId: 0,
    cancelId: 0,
    title: 'Could Not Verify Unsaved Changes',
    message: `The app could not verify whether this window has unsaved changes. Keep it open to protect all work, or ${verb.toLowerCase()} without saving any unverified work.`,
  });
  return choice === 1 ? 'proceed' : 'cancel';
}

/**
 * The Non-API AI response ledger is a separate durability boundary from the
 * canvas and shared text files. A rejected barrier must fail closed without
 * escaping an async Electron event listener as an unhandled rejection.
 */
async function flushNonApiAiPersistenceForLifecycle(win, actionType) {
  try {
    await flushNonApiAiPersistence();
    return true;
  } catch (error) {
    const verb = actionType === 'quit' ? 'Quit' : 'Close';
    logger.error(`[Main] Could not flush Non-API AI persistence before ${actionType}: ${error?.message || error}`);
    if (isBackgroundE2E || !win || win.isDestroyed()) return false;
    try {
      const choice = electronPkg.dialog.showMessageBoxSync(win, {
        type: 'error',
        buttons: ['Keep Editing', `${verb} Without Saving AI Draft`],
        defaultId: 0,
        cancelId: 0,
        title: 'Could Not Save AI Draft',
        message: `The app could not finish saving a pending AI handoff draft. Keep editing to protect it, or ${verb.toLowerCase()} without saving that draft.`,
      });
      return choice === 1;
    } catch (dialogError) {
      // A native close can race the explanatory dialog. Preserve the original
      // fail-closed result and keep this event listener rejection-free.
      logger.warn(`[Main] Could not show AI draft save failure dialog: ${dialogError?.message || dialogError}`);
    }
    return false;
  }
}

/**
 * Perform a handshake with the renderer to check for unsaved changes.
 * Fixes a listener leak where a timeout previously left a dangling ipcMain.once listener.
 */
async function checkUnsavedChanges(win, actionType = 'close') {
  // Avoid even asking a background renderer for state: a closing test process
  // must not revive/focus it while awaiting a quit handshake.
  if (isBackgroundE2E) return { action: 'proceed' };
  if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) {
    return { action: 'proceed' };
  }

  if (hasStoppedRenderer(win)) return { action: showUnverifiedSaveStateDialog(win, actionType) };

  const expectedSender = win.webContents;
  const requestId = ++rendererHandshakeRequestId;

  const rendererState = await new Promise(resolve => {
    let timeoutId;
    let settled = false;
    const finish = (state) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      electronPkg.ipcMain.removeListener('quit-response', handler);
      expectedSender.removeListener('destroyed', onDestroyed);
      expectedSender.removeListener('did-start-navigation', onMainFrameNavigation);
      expectedSender.removeListener('render-process-gone', onRenderProcessGone);
      resolve(state);
    };
    const handler = (event, { hasUnsavedChanges, documentSaveFailed = false, draftSaveFailed = false, requestId: responseRequestId } = {}) => {
      if (event.sender !== expectedSender || responseRequestId !== requestId) return;
      finish({ hasUnsavedChanges, documentSaveFailed, draftSaveFailed });
    };
    const onDestroyed = () => finish({ destroyed: true });
    const onMainFrameNavigation = (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) finish({ timeout: true });
    };
    const onRenderProcessGone = () => finish({ timeout: true });

    electronPkg.ipcMain.on('quit-response', handler);
    expectedSender.once('destroyed', onDestroyed);
    expectedSender.on('did-start-navigation', onMainFrameNavigation);
    expectedSender.once('render-process-gone', onRenderProcessGone);

    timeoutId = setTimeout(() => {
      // The response could be delayed behind a document flush or the renderer
      // could be hung. We cannot safely infer either document or canvas state.
      finish({ timeout: true });
    }, 1500);

    if (!safeMenuSend(win, 'quit-request', { requestId })) {
      // The renderer was no longer reachable. Treat its state as unverified
      // so the normal fail-closed prompt, rather than a guessed clean state,
      // decides whether the window may be destroyed.
      finish({ timeout: true });
    }
  });

  if (rendererState.destroyed || win.isDestroyed() || expectedSender.isDestroyed()) {
    return { action: 'proceed' };
  }

  if (rendererState.timeout) {
    return { action: showUnverifiedSaveStateDialog(win, actionType) };
  }
  if (rendererState.draftSaveFailed) {
    try {
      electronPkg.dialog.showMessageBoxSync(win, {
        type: 'error', buttons: ['Keep Open'], title: 'Could Not Save AI Draft',
        message: 'An application or AI response draft could not be saved. The window will stay open so you can retry.',
      });
    } catch { /* Keep the window open even if its explanatory dialog failed. */ }
    return { action: 'cancel' };
  }

  // A document conflict/read/write failure is resolved in its own editor; do
  // not route it through canvas Save As, which cannot repair the local file.
  // An explicit discard may continue to the regular canvas prompt below.
  let skipDocumentSessions = false;
  if (rendererState.documentSaveFailed) {
    if (showDocumentSaveFailureDialog(win, actionType) !== 'proceed') {
      return { action: 'cancel' };
    }
    // The user explicitly chose to discard this document draft. Preserve it
    // in memory until the window actually closes, but do not let a subsequent
    // canvas Save request re-run the same failed document settlement.
    skipDocumentSessions = true;
  }

  // Pending manual handoffs always require a canvas checkpoint. The renderer's
  // dirty flag can lag the just-delivered prompt marker by one commit; gating
  // this on that flag creates an immediate-close window where the durable
  // response ledger survives but the node marker needed to resume does not.
  if (hasPendingNonApiAiRequestsForSender(expectedSender)) {
    // The renderer dirty ref can lag delivery of a manual-AI handoff marker.
    // Force its canvas checkpoint even when that ref still reads clean.
    return { action: 'save', skipDocumentSessions, forceCanvasSave: true };
  }

  if (rendererState.hasUnsavedChanges) {
    const verbButton = actionType === 'quit' ? 'Quit' : 'Close';
    const verbPhrase = actionType === 'quit' ? 'quit' : 'close this window';
    return { action: showUnsavedChangesDialog(win, verbButton, verbPhrase), skipDocumentSessions };
  }

  return { action: 'proceed', skipDocumentSessions };
}

// ── Window creation ──────────────────────────────────────────────────────────

/**
 * Open a new canvas window.
 *
 * @param {{ mode?: 'auto'|'blank'|'file', filePath?: string }} [initSpec]
 *   How the freshly-mounted renderer should populate itself:
 *     - 'auto'  → restore the last opened workspace (used on first launch /
 *                 dock re-activation).
 *     - 'blank' → start empty (New Canvas, relaunch).
 *     - 'file'  → load the given canvas file silently (Open Canvas).
 *   The intent is passed to the renderer via the loaded URL's query string so
 *   it is available synchronously at mount with no IPC round-trip.
 */
function createWindow(initSpec = { mode: 'auto' }) {
  // A committed global quit owns the window set. Do not admit a new editable
  // canvas between its first validation pass and final destruction.
  if (quitHandshakeInFlight || isQuitting) return null;
  // Cascade so a second/third window doesn't perfectly cover the first.
  const offset = newWindowOffset;
  newWindowOffset = (newWindowOffset + 30) % 150;

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    // Playwright drives this hidden WebContents over CDP; it does not need a
    // native focused window. Keep the smoke entirely out of the user's task
    // switcher and prevent Electron from activating it over their work.
    show: !isBackgroundE2E,
    focusable: !isBackgroundE2E,
    skipTaskbar: isBackgroundE2E,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      // Never throttle: this app runs long renderer-driven work (job pipelines,
      // handoff import/settle polls, startup recovery) and is often launched
      // behind other windows. MEASURED 2026-10-06: a packaged relaunch at 16:57
      // sat occluded and its canvas "ready" step — gated on requestAnimationFrame
      // — did not fire until the window was first shown at 19:30 (elapsed
      // 9133588ms), stalling startup recovery for 2.5h. Also keeps the hidden
      // Playwright window's timers and frames deterministic.
      backgroundThrottling: false,
    },
  });
  if (isBackgroundE2E) win.setAlwaysOnTop(false);
  if (isBackgroundE2E) {
    // Removing the native menu also removes Electron's Cmd/Ctrl+S accelerator.
    // Preserve that smoke coverage through this one hidden WebContents only;
    // never register a global shortcut that could intercept the user's desktop.
    win.webContents.on('before-input-event', (event, input) => {
      const primaryModifier = process.platform === 'darwin'
        ? input.meta && !input.control
        : input.control && !input.meta;
      if (input.type !== 'keyDown'
          || input.isAutoRepeat
          || !primaryModifier
          || input.alt
          || input.shift
          || String(input.key).toLowerCase() !== 's') return;
      event.preventDefault();
      safeMenuSend(win, 'menu-save');
    });
  }
  // Used by the global webContents guard below. Set before loadURL/loadFile so
  // every top-level navigation of this privileged renderer is checked.
  win.webContents.__isCanvasRenderer = true;
  if (canvasWindows.size > 0) {
    const [bx, by] = win.getPosition();
    win.setPosition(bx + offset, by + offset);
  }

  canvasWindows.add(win);
  lastFocusedCanvasWindow = win;
  win.on('focus', () => { lastFocusedCanvasWindow = win; });

  const loadCanvas = (spec) => {
    const query = { init: spec?.mode || 'auto' };
    if (spec?.mode === 'file' && spec.filePath) query.file = spec.filePath;
    if (process.env.VITE_DEV_SERVER_URL) {
      const devUrl = new URL(process.env.VITE_DEV_SERVER_URL);
      for (const [key, value] of Object.entries(query)) devUrl.searchParams.set(key, value);
      return win.loadURL(devUrl.href);
    }
    return win.loadFile(path.join(__dirname, '../dist/index.html'), { query });
  };
  // A native crash bypasses React's ErrorBoundary. Keep recovery in the main
  // process, bound to this window's last host-verified saved canvas path.
  const detachRecovery = attachRendererRecovery(win, {
    isQuitting: () => isQuitting || quitHandshakeInFlight || win.__closeHandshakeInFlight === true,
    record: details => recordRendererCrash(app.getPath('userData'), details, win.webContents.__canvasPath),
    showMessageBox: (...args) => electronPkg.dialog.showMessageBox(...args),
    reload: () => loadCanvas(win.webContents.__canvasPath
      ? { mode: 'file', filePath: win.webContents.__canvasPath } : initSpec),
    log: message => logger.error(`[RendererRecovery] ${message}`),
  });
  win.once('closed', detachRecovery);
  loadCanvas(initSpec).catch(() => logger.error('[Main] Failed to load canvas renderer'));

  // ── Spellcheck context menu ──────────────────────────────────────────────
  // Chromium's spellchecker is on by default and underlines misspelled words.
  // Electron exposes the suggestions and a one-call replacement API; we only
  // surface this menu when the right-click actually lands on a misspelled word
  // so the renderer's own canvas/node context menus continue to work.
  win.webContents.on('context-menu', (_event, params) => {
    if (isBackgroundE2E) return;
    if (!params.misspelledWord) return;
    const template = params.dictionarySuggestions.map(suggestion => ({
      label: suggestion,
      click: () => win.webContents.replaceMisspelling(suggestion),
    }));
    if (template.length === 0) {
      template.push({ label: 'No suggestions', enabled: false });
    }
    template.push(
      { type: 'separator' },
      {
        label: 'Add to Dictionary',
        click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      },
    );
    Menu.buildFromTemplate(template).popup({ window: win });
  });

  win.on('close', async (event) => {
    if (isQuitting) return; // Let before-quit handle it
    // preventDefault() unconditionally, on EVERY close event — including a
    // rapid second one below. It must run before the reentrancy check: if
    // the guard branch below returns first, an in-flight handshake's second
    // 'close' event falls through to Electron's default action and destroys
    // the window immediately, skipping the unsaved-changes prompt entirely
    // (exactly what this guard was meant to prevent, not cause).
    event.preventDefault();

    // An app-wide quit is already asking this window about the same durable
    // state. Do not race it with a second per-window handshake or dialog.
    if (quitHandshakeInFlight) return;

    // A rapid double-close (e.g. two quick clicks on the OS close button
    // before the first handshake resolves) would otherwise register two
    // concurrent quit-response/save-response IPC listeners against the same
    // window, letting a single renderer response trigger both handlers.
    // The default action is already prevented above, so this second event
    // safely no-ops and lets the in-flight handshake finish on its own.
    if (win.__closeHandshakeInFlight) return;

    win.__closeHandshakeInFlight = true;
    let commitRequested = false;
    let closeSucceeded = false;
    try {
      // Freeze first, then perform exactly one check/save/discard pass. A
      // body-inert-only close could still lose a promise/timer mutation between
      // the check and destruction; the renderer ACK proves its Canvas state
      // gate is live. Do not preflight before this: a deliberate "Close
      // Without Saving" leaves dirty state and would otherwise prompt twice.
      commitRequested = true;
      if (!await requestQuitCommitAndWait(win)) return;

      const result = await checkUnsavedChanges(win, 'close');
      if (result.action === 'cancel') return;

      if (result.action === 'save') {
        const saved = await requestSaveAndWait(win, {
          skipDocumentSessions: result.skipDocumentSessions,
          forceCanvasSave: result.forceCanvasSave,
        });
        if (!saved) return;
      }

      if (!await flushNonApiAiPersistenceForLifecycle(win, 'close')) return;

      try {
        win.destroy(); // Safe to destroy now
        closeSucceeded = true;
      } catch (error) {
        // BrowserWindow can race native destruction after the successful
        // handshake. This async event handler must not turn that into an
        // unhandled rejection; leave the still-live window available to retry.
        logger.warn(`[Main] Could not destroy canvas window after close: ${error?.message || error}`);
      }
    } catch (error) {
      // Electron does not consume rejected promises returned by EventEmitter
      // listeners. Keep every unexpected close-handshake failure local so the
      // renderer can be released and the user can safely retry.
      logger.error(`[Main] Could not complete canvas window close safely: ${error?.message || error}`);
    } finally {
      // A sent request can have made the renderer inert even when its ACK was
      // lost. Release on cancellation, save/flush rejection, or a destroy race;
      // a successfully destroyed renderer needs no release.
      if (commitRequested && !win.isDestroyed()) releaseQuitCommit([win]);
      win.__closeHandshakeInFlight = false;
      // A global quit that arrived during this close cannot begin yet because
      // it would register a competing renderer handshake. Consume that intent
      // on every terminal result: only a successful destruction resumes it,
      // while Cancel, a save failure, or a commit failure leaves the app open.
      if (pendingGlobalQuit.consumeAfterClose(closeSucceeded) && !isQuitting) {
        setImmediate(() => {
          // The close event and its in-flight guard have fully unwound before
          // this retrigger, so before-quit starts one global handshake rather
          // than recursively deferring itself against the completed close.
          if (!isQuitting) app.quit();
        });
      }
    }
  });

  win.on('closed', () => {
    interviewWindowController?.cleanupOwner(win);
    canvasWindows.delete(win);
    if (lastFocusedCanvasWindow === win) lastFocusedCanvasWindow = null;
  });

  return win;
}

/**
 * Show the open dialog and load the chosen canvas in a *new* window, leaving
 * the current window untouched. Backs File ▸ Open Canvas (and ⌘O).
 */
async function openCanvasInNewWindow() {
  if (isBackgroundE2E) return { canceled: true };
  const parent = getTargetCanvasWindow();
  const dialogOpts = {
    title: 'Open Canvas',
    properties: ['openFile'],
    filters: [{ name: 'JSON Files', extensions: ['json'] }],
  };
  const { canceled, filePaths } = parent && !parent.isDestroyed()
    ? await electronPkg.dialog.showOpenDialog(parent, dialogOpts)
    : await electronPkg.dialog.showOpenDialog(dialogOpts);
  if (canceled || !filePaths || filePaths.length === 0) return;

  const filePath = resolveSafeCanvasFilePath(filePaths[0]);
  if (!filePath) return;
  openOrFocusCanvasWindow(filePath, { canvasWindows, createWindow });
}

// ── Application menu ─────────────────────────────────────────────────────────

/** Send a channel to a window's renderer only if it is alive. */
function safeMenuSend(win, channel, payload) {
  if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) return false;
  try {
    if (payload === undefined) win.webContents.send(channel);
    else win.webContents.send(channel, payload);
    return true;
  } catch {
    // WebContents can be destroyed after the liveness checks. Callers that
    // await a renderer reply use the false result to remove their listeners
    // and preserve the fail-closed durability policy.
    return false;
  }
}

function openExternalSafely(url) {
  if (isBackgroundE2E) return;
  void electronPkg.shell.openExternal(url).catch((error) => {
    logger.warn(`[Main] Failed to open external URL: ${error?.message || error}`);
  });
}

function setupApplicationMenu() {
  // A native menu brings back macOS roles such as About, Services, Unhide,
  // fullscreen, and Close. None are meaningful for the hidden smoke renderer,
  // and several can surface/focus desktop UI.
  if (suppressNativeApplicationMenu) {
    Menu.setApplicationMenu(null);
    return;
  }
  const isMac = process.platform === 'darwin';

  // Menu items act on whichever canvas window is focused at click time, so a
  // single application menu correctly drives any of the open windows.
  const sendToFocused = (channel) => safeMenuSend(getTargetCanvasWindow(), channel);

  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Canvas',    accelerator: 'CmdOrCtrl+N',       click: () => { if (!isBackgroundE2E) createWindow({ mode: 'blank' }); } },
        { label: 'Open Canvas…',  accelerator: 'CmdOrCtrl+O',       click: () => { openCanvasInNewWindow(); } },
        { label: 'Save Canvas',   accelerator: 'CmdOrCtrl+S',       click: () => sendToFocused('menu-save') },
        { type: 'separator' },
        { label: 'Export as PNG', accelerator: 'CmdOrCtrl+Shift+E', click: () => sendToFocused('menu-export-png') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── App lifecycle ────────────────────────────────────────────────────────────

app.on('web-contents-created', (_, contents) => {
  contents.setWindowOpenHandler((details) => {
    // Only the user-facing canvas is allowed to hand a web link to the OS.
    // Auth/monitor pages are third-party content, and generated application
    // HTML can contain model-authored markup; letting either trigger
    // shell.openExternal via target=_blank turns an otherwise isolated window
    // into an OS side effect. Every popup is still denied in Electron itself.
    if (!contents.__isCanvasRenderer) return { action: 'deny' };
    try {
      const parsedUrl = new URL(details.url);
      if (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') {
        openExternalSafely(details.url);
      }
    } catch {
      // Ignore invalid URLs
    }
    return { action: 'deny' };
  });

  contents.on('will-attach-webview', (event) => event.preventDefault());

  contents.on('will-navigate', (event, navigationUrl) => {
    // Auth/monitor BrowserWindows need to follow their remote flows. Only the
    // canvas and the narrow Interview Helper child have application preload
    // bridges, so both get a strict, surface-specific top-level allowlist.
    if (!contents.__isCanvasRenderer && !contents.__isInterviewHelperRenderer) return;
    try {
      const parsedUrl = new URL(navigationUrl);
      const trusted = contents.__isInterviewHelperRenderer
        ? isTrustedInterviewNavigation(navigationUrl, {
            devServerUrl: process.env.VITE_DEV_SERVER_URL,
            distHtmlPath: path.join(__dirname, '../dist/index.html'),
          })
        : isTrustedCanvasNavigation(navigationUrl, {
            devServerUrl: process.env.VITE_DEV_SERVER_URL,
            distDir: path.join(__dirname, '../dist'),
          });
      if (trusted) return;

      event.preventDefault();
      if (contents.__isCanvasRenderer && (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:')) {
        openExternalSafely(navigationUrl);
      }
    } catch {
      // Malformed or non-http URL (e.g. about:blank, javascript:) — block navigation
      event.preventDefault();
    }
  });
});

if (!gotTheLock) {
  app.quit();
} else {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'local-file',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        bypassCSP: true,
        corsEnabled: true,
        stream: true,
      }
    }
  ]);

  app.on('second-instance', (_event, commandLine) => {
    // The single-instance lock funnels every relaunch (e.g. double-clicking the
    // app again) into this one process. A supplied canvas opens (or focuses) its
    // canonical file window; an ordinary relaunch still creates a blank canvas.
    if (isBackgroundE2E) return;
    const initSpec = secondInstanceCanvasWindowSpec(commandLine);
    if (initSpec.mode === 'file') {
      openOrFocusCanvasWindow(initSpec.filePath, { canvasWindows, createWindow });
    } else {
      createWindow(initSpec);
    }
  });

  // ── Chromium flags ──────────────────────────────────────────────────────────
  // Disable VideoToolbox hardware H.264/HEVC acceleration on macOS.
  // VideoToolbox hits kVTVideoDecoderBadDataErr (-12909) on certain MP4
  // encodings at specific keyframe boundaries, causing MEDIA_ERR_DECODE (code 3)
  // at consistent timestamps. The software (FFmpeg) decoder handles these files
  // correctly. This flag has no meaningful quality/performance impact at typical
  // canvas-preview sizes and is only applied when the app actually starts.
  app.commandLine.appendSwitch('disable-accelerated-video-decode');
  // Keep renderers at full speed when the window is occluded/backgrounded (see
  // the backgroundThrottling note in createWindow). These are process-wide, so
  // they also cover timers and frames that webPreferences alone does not.
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

  app.whenReady().then(() => {
    // macOS otherwise creates/activates a Dock presence even for a hidden
    // BrowserWindow. The smoke launch must never surface over desktop apps.
    if (isBackgroundE2E && process.platform === 'darwin') app.dock?.hide?.();
    // Prune expired/excess saved bug reports (see bugReport/reportFile.js)
    // before anything else in this callback. Copy-to-clipboard paths must
    // remain readable across a restart, so this is retention cleanup rather
    // than a wholesale previous-session clear. It must be FIRE-AND-FORGET (`.then`/`.catch`,
    // no `await`) and impossible to throw synchronously: this whole callback is
    // one function body, so an uncaught throw anywhere in it — including from a
    // rejected promise awaited here — would abort every later step, up to and
    // including `createWindow()` below. pruneSavedBugReports() itself already
    // never throws/rejects (every failure path resolves with `{ error }`), but
    // it is wrapped in `.catch` anyway as a second line of defense.
    // Placed first (not just "early") for the same reason: nothing after it in
    // this callback should ever be able to delay app startup on a slow/locked
    // disk, and nothing before it exists to race against.
    // The single-instance lock (`gotTheLock` above) plus the `second-instance`
    // handler (which opens a new window in this SAME process rather than
    // spawning another one) guarantee this callback — and therefore this prune
    // — runs exactly once per real app session.
    pruneSavedBugReports()
      .then((r) => {
        if (r.error) logger.warn(`[BugReport] could not prune saved reports: ${r.error}`);
        else if (r.removed > 0) logger.info(`[BugReport] pruned ${r.removed} expired/excess saved report(s)`);
      })
      .catch((err) => logger.warn(`[BugReport] could not prune saved reports: ${err?.message || err}`));

    protocol.handle('local-file', async (request) => {
      let requestParams = new URLSearchParams();
      let pinnedFile = null;
      try {
        requestParams = new URL(request.url).searchParams;
      } catch { /* malformed legacy URL; path decoder below has its own fallback */ }
      try {
        const decodedPath = decodeLocalFileRequestPath(request.url);
        // ── Protocol Security Hardening ──────────────────────────────────────────
        // 1. Resolve to an absolute path immediately to catch relative traversal attempts.
        // 2. Normalize segments. 
        // 3. Bind the resolved regular file through the descriptor guard below.
        const absolutePath = path.resolve(decodedPath);
        const normalizedPath = path.normalize(absolutePath);
        const previewMode = requestParams.get('preview');
        const requestedExt = path.extname(normalizedPath).toLowerCase();
        const isImageRequest = isProductImageExtension(requestedExt);
        
        let targetPath = normalizedPath;

        // Prove the lexical path and its nearest resolved ancestor are outside
        // the complete renderer-denied userData namespace before even the
        // missing-preview existence probe below. That probe is metadata-only,
        // but it must not become an oracle for host-private store entries.
        await assertLocalFileLookupPathAllowed(normalizedPath, { isSensitive: isRendererSensitivePath });

        if (
          isImageRequest
          && !isExistingFile(targetPath)
        ) {
          // A missing preview can trigger a bounded hierarchy search. The
          // generic guard above has already checked its nearest real ancestor.
          const relink = await resolveMissingPreviewPath(normalizedPath);
          if (relink.status === 'found') {
            targetPath = relink.path;
            if (!relink.cached) {
              logger.info(`[local-file] Relinked missing preview image within current hierarchy: ${normalizedPath} → ${targetPath} (root ${relink.root}, scanned ${relink.entriesScanned} entries)`);
            }
          } else if (!relink.cached && (relink.status === 'ambiguous' || relink.status === 'limit')) {
            logger.warn(`[local-file] Could not relink missing preview image (${relink.status}) within ${relink.root}: ${normalizedPath} (scanned ${relink.entriesScanned} entries)`);
          }
        }
        
        // Block sensitive system roots, config, and credential-store files
        // (shared with the AI-attachment read gate in nonApiAi.js — renderer
        // policy also denies the complete app-owned userData namespace).
        if (isRendererSensitivePath(targetPath)) {
          logger.warn(`[Security] Blocked access to sensitive path via local-file: ${targetPath}`);
          return new Response('Access Denied', { status: 403 });
        }

        // Bind a direct, regular, single-link descriptor before any branch
        // can read bytes.  In particular, do not validate `targetPath` and
        // later createReadStream(targetPath): a pathname replacement in that
        // gap could otherwise redirect the protocol to private application
        // material.
        try { pinnedFile = await openPinnedLocalFile(targetPath, { isSensitive: isRendererSensitivePath }); }
        catch (error) {
          if (isLocalFileSafetyError(error)) {
            logger.warn(`[Security] Blocked unsafe local-file target: ${targetPath} (${error.code})`);
            return new Response('Access Denied', { status: 403 });
          }
          if (isImageRequest) {
            logger.warn(`[local-file] Image preview target not found after relink: request=${request.url} normalized=${normalizedPath} target=${targetPath} (${error?.code || error?.message || 'stat failed'})`);
          }
          return new Response('Not Found', { status: 404 });
        }
        const stat = pinnedFile.stat;
        targetPath = pinnedFile.filePath;

        const ext = path.extname(targetPath).toLowerCase();
        const contentType = LOCAL_FILE_MIME_TYPES[ext] || 'application/octet-stream';
        if (previewMode === 'marketplace' && MARKETPLACE_PREVIEW_EXT.has(ext)) {
          const maxBytes = clampNumber(
            requestParams.get('maxBytes'),
            MARKETPLACE_PREVIEW_MAX_BYTES,
            64 * 1024,
            MARKETPLACE_PREVIEW_MAX_BYTES,
          );
          const maxDimension = clampNumber(
            requestParams.get('maxDimension'),
            MARKETPLACE_PREVIEW_DEFAULT_DIMENSION,
            128,
            4096,
          );
          const cacheKey = `${targetPath}|${stat.mtimeMs}|${stat.size}|${maxBytes}|${maxDimension}`;
          const cachedPreview = getMarketplacePreviewCache(cacheKey);
          if (cachedPreview) {
            await pinnedFile.close();
            pinnedFile = null;
            return new Response(cachedPreview, {
              status: 200,
              headers: {
                'Content-Type': 'image/jpeg',
                'Content-Length': String(cachedPreview.length),
                'Cache-Control': 'no-cache',
              },
            });
          }
          await assertPinnedLocalFileBinding(pinnedFile);
          const materialized = await materializePinnedLocalFile(pinnedFile, ext);
          let previewBuffer;
          try {
            previewBuffer = await createMarketplacePreviewBuffer(materialized.sourcePath, {
              maxBytes,
              maxDimension,
              workDirectory: materialized.workDirectory,
              sourceReservation: materialized.sourceReservation,
            });
          } finally {
            await materialized.cleanup();
          }
          if (previewBuffer) {
            setMarketplacePreviewCache(cacheKey, previewBuffer);
            await pinnedFile.close();
            pinnedFile = null;
            return new Response(previewBuffer, {
              status: 200,
              headers: {
                'Content-Type': 'image/jpeg',
                'Content-Length': String(previewBuffer.length),
                'Cache-Control': 'no-cache',
              },
            });
          }
          if (stat.size > maxBytes) {
            await pinnedFile.close();
            pinnedFile = null;
            return new Response('Preview unavailable', { status: 415 });
          }
        }

        // ── Non-native image → JPEG transcoding via sips ──────────────────────
        // Chromium can't decode HEIC/HEIF (no H.265 decoder), TIFF, or JXL, so
        // raw bytes render as a broken image. sips is Apple's built-in image tool
        // (ships with every Mac since 10.3) on the full Core Image / ImageIO
        // stack — it reads all of these and emits JPEG for compact transfer.
        // Conversion deliberately has no on-disk cache. A cache path is another
        // renderer-adjacent read surface, while this one-shot private workspace
        // can bind the exact sips result before returning it.
        if (DISPLAY_TRANSCODE_EXT.has(ext)) {
          try {
            await assertPinnedLocalFileBinding(pinnedFile);
            const materialized = await materializePinnedLocalFile(pinnedFile, ext);
            let jpegBuf;
            try {
              jpegBuf = await createPrivateSipsJpegBuffer(materialized.sourcePath, materialized.workDirectory, [
                '-s', 'format', 'jpeg',
                '-s', 'formatOptions', '85',
              ], materialized.sourceReservation);
            } finally {
              await materialized.cleanup();
            }
            await pinnedFile.close();
            pinnedFile = null;
            return new Response(jpegBuf, {
              status: 200,
              headers: {
                'Content-Type':   'image/jpeg',
                'Content-Length': String(jpegBuf.length),
                'Cache-Control':  'no-cache',
              },
            });
          } catch (imgErr) {
            await pinnedFile?.close().catch(() => {});
            pinnedFile = null;
            console.error(`[local-file] ${ext} sips transcode failed:`, imgErr);
            return new Response('Image decode error', { status: 500 });
          }
        }

        // ── Range-aware streaming ────────────────────────────────────────────────
        // Honor HTTP Range requests so HTMLMediaElement reports the source as
        // seekable. Without `Accept-Ranges: bytes` and 206 partial-content
        // responses, Chromium leaves video.seekable empty and silently ignores
        // timeline clicks even when the file is fully buffered.
        const total = stat.size;

        const rangeHeader = request.headers.get('range');
        if (rangeHeader) {
          const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
          if (m) {
            let start = m[1] === '' ? NaN : parseInt(m[1], 10);
            let end   = m[2] === '' ? NaN : parseInt(m[2], 10);
            // Suffix range: bytes=-N → last N bytes
            if (Number.isNaN(start) && !Number.isNaN(end)) {
              start = Math.max(0, total - end);
              end = total - 1;
            } else {
              if (Number.isNaN(start)) start = 0;
              if (Number.isNaN(end))   end   = total - 1;
            }
            if (start > end || start >= total) {
              await pinnedFile.close();
              pinnedFile = null;
              return new Response('Range Not Satisfiable', {
                status: 416,
                headers: { 'Content-Range': `bytes */${total}` },
              });
            }
            end = Math.min(end, total - 1);
            const chunkSize = end - start + 1;
            await assertPinnedLocalFileBinding(pinnedFile);
            const stream = createPinnedLocalReadStream(pinnedFile, { start, end });
            pinnedFile = null; // the stream owns descriptor cleanup now
            return new Response(Readable.toWeb(stream), {
              status: 206,
              headers: {
                'Content-Type':   contentType,
                'Content-Length': String(chunkSize),
                'Content-Range':  `bytes ${start}-${end}/${total}`,
                'Accept-Ranges':  'bytes',
                'Cache-Control':  'no-cache',
              },
            });
          }
          // Malformed Range — fall through to full-body 200.
        }

        await assertPinnedLocalFileBinding(pinnedFile);
        const stream = createPinnedLocalReadStream(pinnedFile);
        pinnedFile = null; // the stream owns descriptor cleanup now
        return new Response(Readable.toWeb(stream), {
          status: 200,
          headers: {
            'Content-Type':   contentType,
            'Content-Length': String(total),
            'Accept-Ranges':  'bytes',
            'Cache-Control':  'no-cache',
          },
        });
      } catch (error) {
        await pinnedFile?.close().catch(() => {});
        if (isLocalFileSafetyError(error)) {
          logger.warn(`[Security] Blocked unsafe local-file target after binding (${error.code})`);
          return new Response('Access Denied', { status: 403 });
        }
        console.error('Failed to handle local-file protocol', error);
        return new Response('Internal Error', { status: 500 });
      }
    });

    registerFilesystemHandlers();
    registerJobsHandlers();
    registerInterviewHelperHandlers();
    registerInterviewPreparationHandlers();
    interviewWindowController = createInterviewWindowController({
      BrowserWindow,
      ipcMain: electronPkg.ipcMain,
      appInstance: app,
      isAuthorizedOwner: owner => canvasWindows.has(owner) && !owner.isDestroyed(),
      loadSnapshot: ({ snapshotId, userDataPath }) => loadInterviewHelperCareerSnapshot({ snapshotId, userDataPath }),
      loadBundle: ({ artifactId, userDataPath }) => loadInterviewPreparationBundle({ artifactId, userDataPath }),
      preloadPath: path.join(__dirname, 'interviewWindowPreload.js'),
      devServerUrl: process.env.VITE_DEV_SERVER_URL || null,
      distHtmlPath: path.join(__dirname, '../dist/index.html'),
    });
    registerJobApplicationHandlers();
    registerLocalAiApplicationHandlers();
    try {
      const claudeRunnerRoot = path.join(app.getPath('userData'), 'claude-application-runner');
      let claudeRunnerNotify = () => {};
      claudeApplicationRunner = createClaudeApplicationRunner({
        api: {
          getHandoff: getLocalApplicationHandoff,
          submitHandoff: submitLocalApplicationHandoff,
          stopHandoff: stopLocalApplicationJob,
          subscribeDiscards: subscribeLocalApplicationDiscards,
        },
        stateFile: path.join(claudeRunnerRoot, 'state.json'),
        workspaceDir: path.join(claudeRunnerRoot, 'workspace'),
        logger,
        notify: state => claudeRunnerNotify(state),
      });
      claudeRunnerNotify = registerClaudeApplicationRunnerHandlers({
        handleSafe,
        runner: claudeApplicationRunner,
        getAllWindows: () => BrowserWindow.getAllWindows(),
      });
      claudeApplicationRunner.load().catch(error => logger.warn(`[main] Claude application runner state failed to load: ${error?.message || error}`));
    } catch (error) {
      logger.error(`[main] Claude application runner failed to start: ${error?.message || error}`);
    }
    registerApplicationGenerationGateHandlers();
    registerApplicationBundleWatchHandlers();
    startApplicationSyncServer().catch((err) => logger.warn(`[main] Application sync service failed to start: ${err?.message || err}`));
    registerMarketplaceHandlers();
    registerAccountsHandlers();
    registerBugReportHandlers();
    registerNetworkHandlers({
      onNodeDeleted: (sender, nodeId) => (
        interviewWindowController?.cleanupBySenderAndNode(sender, nodeId)
      ),
    });
    registerSettingsHandlers();
    registerNonApiAiHandlers();
    // Every AI task is answered by the local Claude Code CLI.
    startClaudeTaskWorker({ userData: app.getPath('userData'), nativeImage: electronPkg.nativeImage });
    registerClaudeTaskStatusHandler({ ipcMain: electronPkg.ipcMain });
    // Startup assertion for the résumé design-system coupling surface (design
    // doc §9). Job Application Design System/ is owned by an external design source and replaced
    // wholesale from time to time; this never throws or blocks startup — its
    // only job is to log "a reconnect is needed" instead of letting the app
    // silently generate résumés/cover letters against a stale contract.
    Promise.resolve(assertDesignSystemIntact()).catch((err) => {
      logger.warn(`[main] assertDesignSystemIntact() rejected unexpectedly (should be impossible — it must log and return, not throw): ${err?.message || err}`);
    });

    electronPkg.ipcMain.handle('prompt-unsaved-changes', async (event, actionName) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      return showUnsavedChangesDialog(win, 'Proceed', actionName || 'proceed');
    });

    // The renderer reports which canvas file each window currently has open so
    // we can (a) avoid opening the same file in two windows and (b) target the
    // right window. Tracked directly on the BrowserWindow instance.
    electronPkg.ipcMain.on('window:set-current-file', (event, filePath) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win && !win.isDestroyed()) {
        win.__canvasFilePath = filePath || null;
      }
    });

    setupApplicationMenu();
    createWindow(initialCanvasWindowSpec(process.argv));
    // The practice-interview connector owns the tunnel and its hostname.
    startPracticeConnector({ userData: app.getPath('userData') }).catch(error => {
      logger.warn(`[PracticeConnector] start failed: ${error?.message || error}`);
    });

    if (process.env.INFINITE_CANVAS_E2E !== '1') {
      // Mark every platform pending before the delayed worker pool begins. The
      // renderer can mount and show accurate "Checking connections" state, and
      // auth-gated actions can await their selected platform instead of reading
      // an empty/stale cache during this grace period.
      schedulePlatformVerification();
      // Let the renderer mount and auto-load the workspace before launching the
      // Chrome-based marketplace/account verifier windows. The verifier still runs
      // every normal launch; UI automation disables it to stay isolated and avoid
      // leaving unrelated browser processes behind.
      setTimeout(() => {
        verifyAllPlatforms({
          notify: (event, data) => {
            for (const win of canvasWindows) {
              if (!win.isDestroyed()) win.webContents.send(event, data);
            }
          },
          // Per-platform failures are already logged inside verifyAllPlatforms
          // itself — anything reaching this outer catch is an unexpected bug
          // (e.g. in pool setup), so it should never vanish silently.
        }).catch((err) => logger.error('[Main] verifyAllPlatforms failed:', err));
      }, 2500);
    }

    app.on('activate', () => {
      // macOS: re-opening from the dock with no windows restores the last
      // session. Count only canvas windows — hidden monitor windows don't count.
      if (!isBackgroundE2E && canvasWindows.size === 0) createWindow({ mode: 'auto' });
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

async function shutdownClaudeApplicationRunner() {
  try {
    if (claudeApplicationRunner) await claudeApplicationRunner.shutdown();
  } catch (error) {
    try { logger.warn(`[main] Claude application runner shutdown failed: ${error?.message || error}`); } catch { /* never throw during quit */ }
  }
}

app.on('before-quit', async (event) => {
  if (isBackgroundE2E && !(process.env.INFINITE_CANVAS_E2E_QUIT_HANDSHAKE === '1' && !app.isPackaged)) {
    // Do not run renderer handshakes, restore/minimize windows, or focus a
    // hidden smoke window. Still close every owned background resource before
    // forcing the disposable process down, otherwise a headless browser can
    // retain its profile lock and poison the next smoke run.
    event.preventDefault();
    // app.quit() can be re-entered while this event awaits cleanup (for
    // example, a last-window close on non-macOS). Every re-entry must keep
    // default termination suppressed until this owner calls app.exit().
    if (backgroundE2ECleanupInFlight) return;
    isQuitting = true;
    backgroundE2ECleanupInFlight = runBackgroundE2EShutdownCleanup({
      closeAllAuthWindows,
      closeAllPages,
      closeStealthBrowser,
      stopApplicationSyncServer,
      stopPracticeConnector,
    });
    try {
      await Promise.allSettled([shutdownClaudeApplicationRunner()]);
      await backgroundE2ECleanupInFlight;
    } finally {
      app.exit(0);
    }
    return;
  }
  // app.quit() can be re-entered while normal shutdown awaits browser/profile
  // cleanup. Keep Electron's default termination suppressed until our final
  // app.exit() owns the durable end of that cleanup.
  if (isQuitting) {
    event.preventDefault();
    return;
  }
  event.preventDefault();

  // A user can click a window close control just as Cmd+Q arrives. Its
  // per-window handshake owns the renderer reply until it finishes; defer the
  // app-wide quit rather than registering a competing listener/dialog. The
  // close finalizer consumes this intent and retriggers only if it succeeds.
  if ([...canvasWindows].some(win => win.__closeHandshakeInFlight)) {
    pendingGlobalQuit.defer();
    return;
  }

  // A rapid second quit request must not register a second set of renderer IPC
  // listeners or show duplicate unsaved-change dialogs while the first
  // handshake is waiting. The first event already prevented Electron's default
  // quit, so subsequent events can safely no-op until it completes or cancels.
  if (quitHandshakeInFlight) return;
  quitHandshakeInFlight = true;
  const commitWindows = [...canvasWindows].filter(win => !win.isDestroyed());
  const quitAttempt = createQuitAutosaveAttempt({
    windows: commitWindows,
    beginPause: win => beginSenderQuitPause(win.webContents),
    releasePause: win => releaseSenderQuitPause(win.webContents),
    pauseRenderer: requestQuitPauseAndWait,
    // An admitted bundle import can spend a minute verifying PDFs. Give its
    // durable transaction time to finish before treating the quit as failed.
    drainSender: win => drainSenderNodeTasksForQuit(win.webContents, { timeoutMs: 120000 }),
    flushPersistence: flushNonApiAiPersistence,
    freezeRenderer: requestQuitCommitAndWait,
    saveRenderer: (win, paused) => requestSaveAndWait(win, {
      forceCanvasSave: paused.requiresCanvasSave || hasPendingNonApiAiRequestsForSender(win.webContents),
    }),
    releaseRenderer: win => releaseQuitCommit([win]),
    windowsAreCurrent: () => commitWindows.length === [...canvasWindows].filter(win => !win.isDestroyed()).length
      && commitWindows.every(win => canvasWindows.has(win) && !win.isDestroyed()),
  });

  try {
    if (!await quitAttempt.run()) return;

    isQuitting = true;
    // All canvas windows have paused and saved. Destroy them before cleanup:
    // leaving an editable renderer alive here would allow new edits that the
    // final app.exit() could drop. The `isQuitting` close branch and reentrant
    // before-quit guard keep window-all-closed from taking over termination.
    for (const win of [...canvasWindows]) {
      try {
        if (!win.isDestroyed()) win.destroy();
      } catch (error) {
        // A window can race destruction between the check and destroy. Keep
        // the committed quit's cleanup/app.exit owner alive for every other
        // window instead of stranding `isQuitting` before its finalizer.
        logger.warn(`[Main] Could not destroy canvas window during quit: ${error?.message || error}`);
      }
    }

    // Cleanup with safety timeout
    try {
      const cleanup = async () => {
        const practiceConnectorStop = stopPracticeConnector();
        const claudeRunnerStop = shutdownClaudeApplicationRunner();
        // Visible login/native-auth windows own the same persistent profile.
        // Close and await them first so the singleton cannot race their final
        // cookie checkpoint during quit.
        await closeAllAuthWindows();
        await Promise.allSettled([
          closeAllPages(),
          closeStealthBrowser(true),
          stopApplicationSyncServer(),
          practiceConnectorStop,
          claudeRunnerStop,
        ]);
      };

      // A Chrome profile shutdown is a durability boundary for login cookies.
      // Give owned auth browsers enough time for the 2.5s cookie checkpoint,
      // graceful 12s exit deadline, and bounded TERM/KILL fallback;
      // the former 2s app.exit backstop could terminate the main process while
      // Chrome was still checkpointing the Cookies database.
      let forceQuitTimeoutId;
      try {
        await Promise.race([
          cleanup(),
          new Promise(resolve => { forceQuitTimeoutId = setTimeout(resolve, 25000); }),
        ]);
      } finally {
        if (forceQuitTimeoutId) clearTimeout(forceQuitTimeoutId);
      }
    } catch (err) {
      console.error('[Main] Error during cleanup:', err);
    } finally {
      app.exit(0);
    }
  } catch (error) {
    // `before-quit` is also an EventEmitter callback; an escaped rejection is
    // reported as an unhandledRejection rather than a recoverable failed quit.
    logger.error(`[Main] Could not complete app quit safely: ${error?.message || error}`);
    const win = commitWindows.find(candidate => !candidate.isDestroyed());
    if (win && !isBackgroundE2E) {
      try {
        await electronPkg.dialog.showMessageBox(win, {
          type: 'error', buttons: ['Keep Open'], title: 'Quit paused',
          message: 'The app could not finish pausing and saving. Your windows will stay open.',
          detail: error?.message || 'Please retry after resolving the save issue.',
        });
      } catch { /* The owning window may already have closed. */ }
    }
  } finally {
    // On a cancelled/failed save, allow a later explicit quit to try again.
    // A successful path sets isQuitting and exits from the inner finally.
    if (!isQuitting) {
      try { await quitAttempt.release(); }
      catch (error) { logger.error(`[Main] Could not release quit pause: ${error?.message || error}`); }
      finally { quitHandshakeInFlight = false; }
    }
  }
});
