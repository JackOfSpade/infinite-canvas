import electronPkg from 'electron';
const { app, BrowserWindow, Menu, protocol } = electronPkg;
import path from 'path';
import { fileURLToPath } from 'url';
import { registerFilesystemHandlers } from './ipc/filesystem.js';
import { registerJobsHandlers } from './ipc/jobs.js';
import { registerMarketplaceHandlers } from './ipc/marketplace.js';
import { registerAccountsHandlers } from './ipc/accounts.js';
import { registerMonitorHandlers, closeAllMonitors } from './ipc/browserViewMonitor.js';
import { closeAllPages } from './ipc/browserPool.js';
import { closeStealthBrowser } from './ipc/stealthBrowser.js';
import { registerGeminiHandlers } from './ipc/gemini.js';
import { registerBugReportHandlers } from './ipc/bugReport.js';
import { registerNetworkHandlers } from './ipc/network.js';
import fs from 'fs';
import { Readable } from 'node:stream';

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
  '.txt':  'text/plain; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

let mainWindow = null;
let isQuitting = false;
const gotTheLock = app.requestSingleInstanceLock();

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
    const actionStr = actionType === 'quit' ? 'Quit' : 'Close';
    const msgStr = actionType === 'quit' ? 'quit' : 'close this window';
    
    const choice = electronPkg.dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Save', `${actionStr} Without Saving`, 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      title: 'Unsaved Changes',
      message: `You have unsaved changes. Do you want to save before you ${msgStr}? Your unsaved work will be lost otherwise.`
    });
    
    if (choice === 0) return { action: 'save' };
    if (choice === 1) return { action: 'proceed' };
    return { action: 'cancel' };
  }
  
  return { action: 'proceed' };
}

// ── Window creation ──────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL).catch(err => console.error('Failed to load dev server:', err));
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html')).catch(err => console.error('Failed to load local file:', err));
  }

  mainWindow.on('close', async (event) => {
    if (isQuitting) return; // Let before-quit handle it

    event.preventDefault();
    
    const result = await checkUnsavedChanges(mainWindow, 'close');
    if (result.action === 'cancel') return;
    
    if (result.action === 'save') {
      const saved = await new Promise(resolve => {
        let saveTimeoutId;
        const saveHandler = (_e, { success }) => { clearTimeout(saveTimeoutId); resolve(success); };
        electronPkg.ipcMain.once('save-response', saveHandler);
        safeMenuSend(mainWindow, 'request-save-and-respond');
        saveTimeoutId = setTimeout(() => {
          electronPkg.ipcMain.removeListener('save-response', saveHandler);
          resolve(false);
        }, 3000);
      });
      if (!saved) return;
    }
    
    mainWindow.destroy(); // Safe to destroy now
  });

  setupApplicationMenu(mainWindow);
}

// ── Application menu ─────────────────────────────────────────────────────────

/** Send a channel to a window's renderer only if it is alive. */
function safeMenuSend(win, channel) {
  if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
    win.webContents.send(channel);
  }
}

function setupApplicationMenu(win) {
  const isMac = process.platform === 'darwin';

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
        { label: 'New Canvas',    accelerator: 'CmdOrCtrl+N',       click: () => safeMenuSend(win, 'menu-new') },
        { label: 'Open Canvas',   accelerator: 'CmdOrCtrl+O',       click: () => safeMenuSend(win, 'menu-open') },
        { label: 'Save Canvas',   accelerator: 'CmdOrCtrl+S',       click: () => safeMenuSend(win, 'menu-save') },
        { type: 'separator' },
        { label: 'Export as PNG', accelerator: 'CmdOrCtrl+Shift+E', click: () => safeMenuSend(win, 'menu-export-png') },
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
    // Someone tried to run a second instance, we should focus our window.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
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

  app.whenReady().then(() => {
    protocol.handle('local-file', (request) => {
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

        // ── Range-aware streaming ────────────────────────────────────────────────
        // Honor HTTP Range requests so HTMLMediaElement reports the source as
        // seekable. Without `Accept-Ranges: bytes` and 206 partial-content
        // responses, Chromium leaves video.seekable empty and silently ignores
        // timeline clicks even when the file is fully buffered.
        let stat;
        try { stat = fs.statSync(targetPath); }
        catch { return new Response('Not Found', { status: 404 }); }
        if (!stat.isFile()) return new Response('Not Found', { status: 404 });

        const total = stat.size;
        const ext = path.extname(targetPath).toLowerCase();
        const contentType = LOCAL_FILE_MIME_TYPES[ext] || 'application/octet-stream';

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

    // (Legacy startup cleanup removed: cleanupTempFiles is now triggered dynamically 
    // when saving/loading workspaces to ensure we target the correct local directories).

    registerFilesystemHandlers();
    registerJobsHandlers();
    registerMarketplaceHandlers();
    registerAccountsHandlers();
    registerMonitorHandlers();
    registerGeminiHandlers();
    registerBugReportHandlers();
    registerNetworkHandlers();

    electronPkg.ipcMain.handle('prompt-unsaved-changes', async (event, actionName) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const msgStr = actionName || 'proceed';
      const choice = electronPkg.dialog.showMessageBoxSync(win, {
        type: 'warning',
        buttons: ['Save', `Proceed Without Saving`, 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        title: 'Unsaved Changes',
        message: `You have unsaved changes. Do you want to save before you ${msgStr}? Your unsaved work will be lost otherwise.`
      });
      if (choice === 0) return 'save';
      if (choice === 1) return 'proceed';
      return 'cancel';
    });

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

app.on('before-quit', async (event) => {
  if (isQuitting) return;
  event.preventDefault();

  // 1. Handshake with renderer to check for unsaved changes.
  // We give the renderer 1.5 seconds to respond. If it doesn't, we assume it's
  // hung or no listeners are active and proceed with a safe quit.
  const result = await checkUnsavedChanges(mainWindow, 'quit');
  if (result.action === 'cancel') return;
  
  if (result.action === 'save') {
    const saved = await new Promise(resolve => {
      let saveTimeoutId;
      const saveHandler = (_e, { success }) => { clearTimeout(saveTimeoutId); resolve(success); };
      electronPkg.ipcMain.once('save-response', saveHandler);
      safeMenuSend(mainWindow, 'request-save-and-respond');
      saveTimeoutId = setTimeout(() => {
        electronPkg.ipcMain.removeListener('save-response', saveHandler);
        resolve(false);
      }, 3000);
    });
    if (!saved) return;
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
