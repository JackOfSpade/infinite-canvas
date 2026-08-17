import electronPkg from 'electron';
const { app, BrowserWindow, Menu, protocol, nativeImage } = electronPkg;
import path from 'path';
import { registerFilesystemHandlers } from './ipc/filesystem.js';
import { resolveMissingPreviewPath } from './ipc/missingPreviewRelink.js';
import { decodeLocalFileRequestPath } from './localFileProtocol.js';
import { isProductImageExtension } from '../src/utils/fileExtensions.js';
import { isExistingFile, isSensitivePath } from './utils/pathSafety.js';
import { isTrustedCanvasNavigation } from './canvasNavigation.js';
import { logger } from './logger.js';
import { registerJobsHandlers } from './ipc/jobs.js';
import { registerJobApplicationHandlers } from './ipc/jobApplication.js';
import { startApplicationSyncServer, stopApplicationSyncServer } from './ipc/applicationSync.js';
import { registerAppliedJobsHandlers } from './ipc/appliedJobs.js';
import { primeClaudeModels } from './ipc/modelResolver.js';
import { assertDesignSystemIntact } from './ipc/resumeHtml.js';
import { registerMarketplaceHandlers } from './ipc/marketplace.js';
import { registerAccountsHandlers, verifyAllPlatforms } from './ipc/accounts.js';
import { registerMonitorHandlers, closeAllMonitors } from './ipc/browserViewMonitor.js';
import { closeAllPages } from './ipc/browserPool.js';
import { closeStealthBrowser } from './ipc/stealthBrowser.js';
import { registerGeminiHandlers } from './ipc/gemini.js';
import { registerBugReportHandlers } from './ipc/bugReport.js';
import { registerNetworkHandlers } from './ipc/network.js';
import { registerSettingsHandlers } from './ipc/settings.js';
import { registerLlmHandlers } from './ipc/llm.js';
import fs from 'fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

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
let marketplacePreviewCacheBytes = 0;

function clampNumber(value, fallback, min, max) {
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

async function createSipsPreviewBuffer(filePath, { maxBytes, maxDimension }) {
  let dimension = maxDimension;
  while (dimension >= 128) {
    for (const quality of MARKETPLACE_PREVIEW_QUALITY_STEPS) {
      const tmpOut = path.join(os.tmpdir(), `ic_marketplace_preview_${crypto.randomUUID()}.jpg`);
      try {
        await execFile('/usr/bin/sips', [
          '-Z', String(dimension),
          '-s', 'format', 'jpeg',
          '-s', 'formatOptions', String(quality),
          filePath,
          '--out', tmpOut,
        ]);
        const buffer = await fs.promises.readFile(tmpOut);
        if (buffer.length <= maxBytes) return buffer;
      } catch {
        return null;
      } finally {
        fs.promises.unlink(tmpOut).catch(() => {});
      }
    }
    dimension = Math.floor(dimension * 0.65);
  }
  return null;
}

async function createMarketplacePreviewBuffer(filePath, { maxBytes, maxDimension }) {
  const sourceImage = nativeImage.createFromPath(filePath);
  if (sourceImage && !sourceImage.isEmpty()) {
    const directBuffer = encodeNativeImageUnderLimit(sourceImage, { maxBytes, maxDimension });
    if (directBuffer) return directBuffer;
  }

  const sipsBuffer = await createSipsPreviewBuffer(filePath, { maxBytes, maxDimension });
  if (sipsBuffer) return sipsBuffer;

  const thumbnail = await nativeImage.createThumbnailFromPath(filePath, {
    width: maxDimension,
    height: maxDimension,
  });
  if (!thumbnail || thumbnail.isEmpty()) return null;
  return encodeNativeImageUnderLimit(thumbnail, { maxBytes, maxDimension });
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
// canvas; shared resources (browser pool, stealth browser, monitors,
// electron-store, localStorage) live once in this single main process and are
// deliberately shared — running multiple OS processes would fight over those.
//
// `canvasWindows` tracks only the user-facing canvas windows; it excludes the
// hidden BrowserWindows the monitor module spins up (see browserViewMonitor.js).
const canvasWindows = new Set();
// Most-recently focused canvas window — menu actions target this so File ▸ Save
// etc. act on the window the user is actually looking at.
let lastFocusedCanvasWindow = null;
// Cascades successive windows so they don't land exactly on top of each other.
let newWindowOffset = 0;
let isQuitting = false;
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
 * Ask a window's renderer to save, and resolve once it reports back (or times
 * out). Shared by the per-window close handler and the app-wide quit handler.
 */
function requestSaveAndWait(win) {
  return new Promise(resolve => {
    let saveTimeoutId;
    const expectedSender = win.webContents;
    const saveHandler = (event, { success } = {}) => {
      if (event.sender !== expectedSender) return;
      clearTimeout(saveTimeoutId);
      electronPkg.ipcMain.removeListener('save-response', saveHandler);
      resolve(Boolean(success));
    };
    electronPkg.ipcMain.on('save-response', saveHandler);
    saveTimeoutId = setTimeout(() => {
      electronPkg.ipcMain.removeListener('save-response', saveHandler);
      resolve(false);
    }, 3000);
    safeMenuSend(win, 'request-save-and-respond');
  });
}

/**
 * Show the standard "unsaved changes" warning and map the user's choice to a
 * verb. `verbButton` is the middle-button suffix ("Quit"/"Close"/"Proceed");
 * `verbPhrase` is the in-sentence action ("quit" / "close this window" / …).
 * Returns 'save' | 'proceed' | 'cancel'. Shared by the window-close handshake
 * and the renderer-initiated 'prompt-unsaved-changes' IPC so both read identically.
 */
function showUnsavedChangesDialog(win, verbButton, verbPhrase) {
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
 * Perform a handshake with the renderer to check for unsaved changes.
 * Fixes a listener leak where a timeout previously left a dangling ipcMain.once listener.
 */
async function checkUnsavedChanges(win, actionType = 'close') {
  if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) {
    return { action: 'proceed' };
  }

  const expectedSender = win.webContents;

  const rendererState = await new Promise(resolve => {
    let timeoutId;
    const handler = (event, { hasUnsavedChanges } = {}) => {
      if (event.sender !== expectedSender) return;
      clearTimeout(timeoutId);
      electronPkg.ipcMain.removeListener('quit-response', handler);
      resolve({ hasUnsavedChanges });
    };

    electronPkg.ipcMain.on('quit-response', handler);

    timeoutId = setTimeout(() => {
      electronPkg.ipcMain.removeListener('quit-response', handler);
      resolve({ timeout: true });
    }, 1500);

    safeMenuSend(win, 'quit-request');
  });

  if (rendererState.hasUnsavedChanges) {
    const verbButton = actionType === 'quit' ? 'Quit' : 'Close';
    const verbPhrase = actionType === 'quit' ? 'quit' : 'close this window';
    return { action: showUnsavedChangesDialog(win, verbButton, verbPhrase) };
  }

  return { action: 'proceed' };
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
  // Cascade so a second/third window doesn't perfectly cover the first.
  const offset = newWindowOffset;
  newWindowOffset = (newWindowOffset + 30) % 150;

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
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

  const query = { init: initSpec?.mode || 'auto' };
  if (initSpec?.mode === 'file' && initSpec.filePath) query.file = initSpec.filePath;

  if (process.env.VITE_DEV_SERVER_URL) {
    const devUrl = new URL(process.env.VITE_DEV_SERVER_URL);
    for (const [k, v] of Object.entries(query)) devUrl.searchParams.set(k, v);
    win.loadURL(devUrl.href).catch(err => console.error('Failed to load dev server:', err));
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'), { query }).catch(err => console.error('Failed to load local file:', err));
  }

  // ── Spellcheck context menu ──────────────────────────────────────────────
  // Chromium's spellchecker is on by default and underlines misspelled words.
  // Electron exposes the suggestions and a one-call replacement API; we only
  // surface this menu when the right-click actually lands on a misspelled word
  // so the renderer's own canvas/node context menus continue to work.
  win.webContents.on('context-menu', (_event, params) => {
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

    // A rapid double-close (e.g. two quick clicks on the OS close button
    // before the first handshake resolves) would otherwise register two
    // concurrent quit-response/save-response IPC listeners against the same
    // window, letting a single renderer response trigger both handlers.
    // The default action is already prevented above, so this second event
    // safely no-ops and lets the in-flight handshake finish on its own.
    if (win.__closeHandshakeInFlight) return;

    win.__closeHandshakeInFlight = true;
    try {
      const result = await checkUnsavedChanges(win, 'close');
      if (result.action === 'cancel') return;

      if (result.action === 'save') {
        const saved = await requestSaveAndWait(win);
        if (!saved) return;
      }

      win.destroy(); // Safe to destroy now
    } finally {
      win.__closeHandshakeInFlight = false;
    }
  });

  win.on('closed', () => {
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

  const filePath = filePaths[0];
  // If this canvas is already open in a window, just focus it rather than
  // opening a duplicate that would fight over the same file on auto-save.
  for (const win of canvasWindows) {
    if (win.isDestroyed()) continue;
    if (win.__canvasFilePath && win.__canvasFilePath === filePath) {
      if (win.isMinimized()) win.restore();
      win.focus();
      return;
    }
  }

  createWindow({ mode: 'file', filePath });
}

// ── Application menu ─────────────────────────────────────────────────────────

/** Send a channel to a window's renderer only if it is alive. */
function safeMenuSend(win, channel) {
  if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
    win.webContents.send(channel);
  }
}

function openExternalSafely(url) {
  void electronPkg.shell.openExternal(url).catch((error) => {
    logger.warn(`[Main] Failed to open external URL: ${error?.message || error}`);
  });
}

function setupApplicationMenu() {
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
        { label: 'New Canvas',    accelerator: 'CmdOrCtrl+N',       click: () => createWindow({ mode: 'blank' }) },
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
    // canvas has the application's preload bridge and therefore needs this
    // strict top-level navigation allowlist.
    if (!contents.__isCanvasRenderer) return;
    try {
      const parsedUrl = new URL(navigationUrl);
      if (isTrustedCanvasNavigation(navigationUrl, {
        devServerUrl: process.env.VITE_DEV_SERVER_URL,
        distDir: path.join(__dirname, '../dist'),
      })) return;

      event.preventDefault();
      if (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') {
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

  app.on('second-instance', () => {
    // The single-instance lock funnels every relaunch (e.g. double-clicking the
    // app again) into this one process. Instead of just focusing the existing
    // window, open a fresh blank canvas window so relaunching gives the user a
    // genuinely new workspace alongside what they already have open.
    createWindow({ mode: 'blank' });
  });

  // ── Chromium flags ──────────────────────────────────────────────────────────
  // Disable VideoToolbox hardware H.264/HEVC acceleration on macOS.
  // VideoToolbox hits kVTVideoDecoderBadDataErr (-12909) on certain MP4
  // encodings at specific keyframe boundaries, causing MEDIA_ERR_DECODE (code 3)
  // at consistent timestamps. The software (FFmpeg) decoder handles these files
  // correctly. This flag has no meaningful quality/performance impact at typical
  // canvas-preview sizes and is only applied when the app actually starts.
  app.commandLine.appendSwitch('disable-accelerated-video-decode');

  app.whenReady().then(() => {
    protocol.handle('local-file', async (request) => {
      let requestParams = new URLSearchParams();
      try {
        requestParams = new URL(request.url).searchParams;
      } catch { /* malformed legacy URL; path decoder below has its own fallback */ }
      try {
        const decodedPath = decodeLocalFileRequestPath(request.url);
        // ── Protocol Security Hardening ──────────────────────────────────────────
        // 1. Resolve to an absolute path immediately to catch relative traversal attempts.
        // 2. Normalize segments. 
        // 3. Resolve real path to prevent symlink-based blocklist bypasses.
        const absolutePath = path.resolve(decodedPath);
        const normalizedPath = path.normalize(absolutePath);
        const previewMode = requestParams.get('preview');
        const requestedExt = path.extname(normalizedPath).toLowerCase();
        const isImageRequest = isProductImageExtension(requestedExt);
        
        let targetPath = normalizedPath;
        try { targetPath = fs.realpathSync(normalizedPath); } catch { /* ignore */ }

        if (
          isImageRequest
          && !isExistingFile(targetPath)
        ) {
          const relink = resolveMissingPreviewPath(normalizedPath);
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
        // (shared with the AI-attachment read gate in claude.js/gemini.js —
        // see isSensitivePath's doc comment for why this is a blocklist, not
        // an allowlist).
        if (isSensitivePath(targetPath)) {
          logger.warn(`[Security] Blocked access to sensitive path via local-file: ${targetPath}`);
          return new Response('Access Denied', { status: 403 });
        }

        // Verify the file exists and get its extension before any branch
        // (HEIC transcoding and range-streaming both need these).
        let stat;
        try { stat = fs.statSync(targetPath); }
        catch (error) {
          if (isImageRequest) {
            logger.warn(`[local-file] Image preview target not found after relink: request=${request.url} normalized=${normalizedPath} target=${targetPath} (${error?.code || error?.message || 'stat failed'})`);
          }
          return new Response('Not Found', { status: 404 });
        }
        if (!stat.isFile()) return new Response('Not Found', { status: 404 });

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
            return new Response(cachedPreview, {
              status: 200,
              headers: {
                'Content-Type': 'image/jpeg',
                'Content-Length': String(cachedPreview.length),
                'Cache-Control': 'no-cache',
              },
            });
          }
          const previewBuffer = await createMarketplacePreviewBuffer(targetPath, {
            maxBytes,
            maxDimension,
          });
          if (previewBuffer) {
            setMarketplacePreviewCache(cacheKey, previewBuffer);
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
            return new Response('Preview unavailable', { status: 415 });
          }
        }

        // ── Non-native image → JPEG transcoding via sips ──────────────────────
        // Chromium can't decode HEIC/HEIF (no H.265 decoder), TIFF, or JXL, so
        // raw bytes render as a broken image. sips is Apple's built-in image tool
        // (ships with every Mac since 10.3) on the full Core Image / ImageIO
        // stack — it reads all of these and emits JPEG for compact transfer.
        // Result is CACHED on disk keyed by source path+mtime+size: the previous
        // no-cache path re-ran sips on every fetch (a multi-MB HEIC took ~1-2s
        // each → visible "loading" flicker). The cache invalidates automatically
        // when the file changes, and reuses one temp JPEG across all re-renders.
        if (DISPLAY_TRANSCODE_EXT.has(ext)) {
          const key = crypto.createHash('sha1')
            .update(`${targetPath}|${stat.mtimeMs}|${stat.size}`).digest('hex');
          const cachePath = path.join(os.tmpdir(), `ic_imgcache_${key}.jpg`);
          try {
            let jpegBuf;
            try {
              jpegBuf = await fs.promises.readFile(cachePath); // cache hit — no sips
            } catch {
              // Convert to a UNIQUE temp then atomically rename into the cache
              // slot, so two concurrent first-renders of the same image can't
              // collide on one deterministic --out path (the Error 13 sips
              // rename race). A lost rename race is fine — the winner's file is
              // identical bytes; fall back to the temp if the cache read misses.
              const tmpOut = path.join(os.tmpdir(), `ic_imgtmp_${crypto.randomUUID()}.jpg`);
              await execFile('/usr/bin/sips', [
                '-s', 'format', 'jpeg',
                '-s', 'formatOptions', '85',
                targetPath,
                '--out', tmpOut,
              ]);
              await fs.promises.rename(tmpOut, cachePath).catch(() => {});
              jpegBuf = await fs.promises.readFile(cachePath).catch(() => fs.promises.readFile(tmpOut));
              fs.promises.unlink(tmpOut).catch(() => {});
            }
            return new Response(jpegBuf, {
              status: 200,
              headers: {
                'Content-Type':   'image/jpeg',
                'Content-Length': String(jpegBuf.length),
                'Cache-Control':  'no-cache', // revalidate, but served from the disk cache (no re-convert)
              },
            });
          } catch (imgErr) {
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
              return new Response('Range Not Satisfiable', {
                status: 416,
                headers: { 'Content-Range': `bytes */${total}` },
              });
            }
            end = Math.min(end, total - 1);
            const chunkSize = end - start + 1;
            const stream = fs.createReadStream(targetPath, { start, end });
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

        const stream = fs.createReadStream(targetPath);
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
        console.error('Failed to handle local-file protocol', error);
        return new Response('Internal Error', { status: 500 });
      }
    });

    registerFilesystemHandlers();
    registerJobsHandlers();
    registerJobApplicationHandlers();
    startApplicationSyncServer().catch((err) => logger.warn(`[main] Application sync service failed to start: ${err?.message || err}`));
    registerAppliedJobsHandlers();
    registerMarketplaceHandlers();
    registerAccountsHandlers();
    registerMonitorHandlers();
    registerGeminiHandlers();
    registerBugReportHandlers();
    registerNetworkHandlers();
    registerSettingsHandlers();
    registerLlmHandlers();

    // Warm the Claude model resolver before anything can call an LLM. It
    // never throws (falls back to MODEL_FLOOR on any failure — see
    // modelResolver.js's own doc) and this call is fire-and-forget so it
    // can't delay window creation. Priming matters because prompt caches are
    // MODEL-SCOPED: if resolution happened lazily on the first LLM call
    // instead, a resolution that flipped mid-run (e.g. a second window
    // priming concurrently) would silently invalidate every cached prefix
    // and re-bill it at full rate (design doc §8.3 guard 2).
    primeClaudeModels().catch((err) => {
      logger.warn(`[main] primeClaudeModels() rejected unexpectedly (should be impossible — it catches internally): ${err?.message || err}`);
    });

    // Startup assertion for the résumé design-system coupling surface (design
    // doc §9). resume_design_system/ is owned by Claude design and replaced
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
      if (win && !win.isDestroyed()) win.__canvasFilePath = filePath || null;
    });

    setupApplicationMenu();
    createWindow({ mode: 'auto' });

    if (process.env.INFINITE_CANVAS_E2E !== '1') {
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
      if (canvasWindows.size === 0) createWindow({ mode: 'auto' });
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

app.on('before-quit', async (event) => {
  if (isQuitting) return;
  event.preventDefault();

  // 1. Handshake with each open canvas window to check for unsaved changes.
  // Each window gets 1.5s to respond; a hung/unresponsive renderer is treated
  // as "no unsaved changes" so a stuck window can't block quit forever. If any
  // window cancels (or a requested save fails), we abort the whole quit.
  for (const win of [...canvasWindows]) {
    if (win.isDestroyed()) continue;
    const result = await checkUnsavedChanges(win, 'quit');
    if (result.action === 'cancel') return;
    if (result.action === 'save') {
      if (win.isMinimized()) win.restore();
      win.focus();
      const saved = await requestSaveAndWait(win);
      if (!saved) return;
    }
  }

  isQuitting = true;

  // Cleanup with safety timeout
  try {
    const cleanup = async () => {
      await Promise.allSettled([
        closeAllMonitors(),
        closeAllPages(),
        closeStealthBrowser(true),
        stopApplicationSyncServer(),
      ]);
    };
    
    // Give cleanup 2 seconds to finish, then force quit
    let forceQuitTimeoutId;
    try {
      await Promise.race([
        cleanup(),
        new Promise(resolve => { forceQuitTimeoutId = setTimeout(resolve, 2000); })
      ]);
    } finally {
      if (forceQuitTimeoutId) clearTimeout(forceQuitTimeoutId);
    }
  } catch (err) {
    console.error('[Main] Error during cleanup:', err);
  } finally {
    app.exit(0);
  }
});
