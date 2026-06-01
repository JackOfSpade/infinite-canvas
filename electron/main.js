import electronPkg from 'electron';
const { app, BrowserWindow, Menu, protocol } = electronPkg;
import path from 'path';
import { registerFilesystemHandlers } from './ipc/filesystem.js';
import { registerJobsHandlers } from './ipc/jobs.js';
import { registerJobApplicationHandlers } from './ipc/jobApplication.js';
import { registerMarketplaceHandlers } from './ipc/marketplace.js';
import { registerAccountsHandlers, verifyAllPlatforms } from './ipc/accounts.js';
import { registerMonitorHandlers, closeAllMonitors } from './ipc/browserViewMonitor.js';
import { closeAllPages } from './ipc/browserPool.js';
import { closeStealthBrowser } from './ipc/stealthBrowser.js';
import { registerGeminiHandlers } from './ipc/gemini.js';
import { registerBugReportHandlers } from './ipc/bugReport.js';
import { registerNetworkHandlers } from './ipc/network.js';
import { registerSettingsHandlers } from './ipc/settings.js';
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
    const saveHandler = (_e, { success }) => { clearTimeout(saveTimeoutId); resolve(success); };
    electronPkg.ipcMain.once('save-response', saveHandler);
    safeMenuSend(win, 'request-save-and-respond');
    saveTimeoutId = setTimeout(() => {
      electronPkg.ipcMain.removeListener('save-response', saveHandler);
      resolve(false);
    }, 3000);
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

  win.webContents.send('quit-request');
  
  const rendererState = await new Promise(resolve => {
    let timeoutId;
    const handler = (_e, { hasUnsavedChanges }) => {
      clearTimeout(timeoutId);
      resolve({ hasUnsavedChanges });
    };

    electronPkg.ipcMain.once('quit-response', handler);

    timeoutId = setTimeout(() => {
      electronPkg.ipcMain.removeListener('quit-response', handler);
      resolve({ timeout: true });
    }, 1500);
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

    event.preventDefault();

    const result = await checkUnsavedChanges(win, 'close');
    if (result.action === 'cancel') return;

    if (result.action === 'save') {
      const saved = await requestSaveAndWait(win);
      if (!saved) return;
    }

    win.destroy(); // Safe to destroy now
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
        electronPkg.shell.openExternal(details.url);
      }
    } catch {
      // Ignore invalid URLs
    }
    return { action: 'deny' };
  });

  contents.on('will-attach-webview', (event) => event.preventDefault());

  contents.on('will-navigate', (event, navigationUrl) => {
    try {
      const parsedUrl = new URL(navigationUrl);
      const isAllowedLocalhost = parsedUrl.hostname === 'localhost' || parsedUrl.hostname === '127.0.0.1';
      if (!parsedUrl.protocol.startsWith('file:') && !isAllowedLocalhost) {
        event.preventDefault();
        if (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') {
          electronPkg.shell.openExternal(navigationUrl);
        }
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
      let url = request.url.replace(/^local-file:\/\//, '');
      url = url.split('?')[0].split('#')[0]; // Strip query and hash
      try {
        const decodedPath = decodeURIComponent(url);
        // ── Protocol Security Hardening ──────────────────────────────────────────
        // 1. Resolve to an absolute path immediately to catch relative traversal attempts.
        // 2. Normalize segments. 
        // 3. Resolve real path to prevent symlink-based blocklist bypasses.
        const absolutePath = path.resolve(decodedPath);
        const normalizedPath = path.normalize(absolutePath);
        
        let targetPath = normalizedPath;
        try { targetPath = fs.realpathSync(normalizedPath); } catch { /* ignore */ }
        
        // Convert to Unix-style separators for consistent verification across platforms
        const verificationPath = targetPath.split(path.sep).join('/').toLowerCase();
        
        // Block sensitive system roots and configuration files
        const sensitivePatterns = [
          '/etc/', '/var/', '/proc/', '/sys/', '/dev/', 
          '/.ssh/', '/.aws/', '/.config/', '/.env',
          'ntuser.dat', 'system32', 'windows/debug',
          '/users/shared/', '/volumes/'
        ];

        // Explicitly block accessing the root directory directly
        const isUnixRoot = targetPath === '/';
        const isWindowsRoot = !!targetPath.match(/^[a-zA-Z]:\\?$/);
        
        if (isUnixRoot || isWindowsRoot) {
          console.warn(`[Security] Blocked direct root access via local-file: ${targetPath}`);
          return new Response('Access Denied', { status: 403 });
        }
        
        // Recursive/Inclusive blocklist check:
        // We block if the sensitive pattern exists ANYWHERE in the resolved path.
        if (sensitivePatterns.some(p => verificationPath.includes(p))) {
          console.warn(`[Security] Blocked access to sensitive path via local-file: ${targetPath}`);
          return new Response('Access Denied', { status: 403 });
        }

        // Verify the file exists and get its extension before any branch
        // (HEIC transcoding and range-streaming both need these).
        let stat;
        try { stat = fs.statSync(targetPath); }
        catch { return new Response('Not Found', { status: 404 }); }
        if (!stat.isFile()) return new Response('Not Found', { status: 404 });

        const ext = path.extname(targetPath).toLowerCase();
        const contentType = LOCAL_FILE_MIME_TYPES[ext] || 'application/octet-stream';

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
    registerMarketplaceHandlers();
    registerAccountsHandlers();
    registerMonitorHandlers();
    registerGeminiHandlers();
    registerBugReportHandlers();
    registerNetworkHandlers();
    registerSettingsHandlers();

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

    // Verify all platforms immediately. Cache starts empty each launch so there's
    // nothing to trust. Progress events are broadcast to every canvas window so
    // hub nodes can block drops until their platforms are confirmed.
    verifyAllPlatforms({
      notify: (event, data) => {
        for (const win of canvasWindows) {
          if (!win.isDestroyed()) win.webContents.send(event, data);
        }
      },
    }).catch(() => {});

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
        closeStealthBrowser(true)
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
