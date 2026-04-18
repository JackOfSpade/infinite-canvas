import electronPkg from 'electron';
const { app, BrowserWindow, Menu, protocol } = electronPkg;
import path from 'path';
import { fileURLToPath } from 'url';
import { registerFilesystemHandlers, cleanupTempFiles } from './ipc/filesystem.js';
import { registerJobsHandlers } from './ipc/jobs.js';
import { registerMarketplaceHandlers } from './ipc/marketplace.js';
import { registerAccountsHandlers } from './ipc/accounts.js';
import { registerMonitorHandlers, closeAllMonitors } from './ipc/browserViewMonitor.js';
import { closeAllPages } from './ipc/browserPool.js';
import { closeStealthBrowser } from './ipc/stealthBrowser.js';
import { registerGeminiHandlers } from './ipc/gemini.js';
import { registerBugReportHandlers } from './ipc/bugReport.js';
import fs from 'fs';

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
const gotTheLock = app.requestSingleInstanceLock();

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
    
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('quit-request');
      
      const rendererState = await Promise.race([
        new Promise(resolve => {
          electronPkg.ipcMain.once('quit-response', (_e, { hasUnsavedChanges }) => resolve({ hasUnsavedChanges }));
        }),
        new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 1500))
      ]);

      if (rendererState.hasUnsavedChanges) {
        const choice = electronPkg.dialog.showMessageBoxSync(mainWindow, {
          type: 'warning',
          buttons: ['Close Without Saving', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          title: 'Unsaved Changes',
          message: 'You have unsaved changes. Are you sure you want to close this window? Your unsaved work will be lost.'
        });
        if (choice === 1) return; // User clicked Cancel
      }
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
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('will-navigate', (event, navigationUrl) => {
    try {
      const parsedUrl = new URL(navigationUrl);
      const isAllowedLocalhost = parsedUrl.hostname === 'localhost' || parsedUrl.hostname === '127.0.0.1';
      if (!parsedUrl.protocol.startsWith('file:') && !isAllowedLocalhost) {
        event.preventDefault();
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
  app.on('second-instance', () => {
    // Someone tried to run a second instance, we should focus our window.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    protocol.registerFileProtocol('local-file', (request, callback) => {
      let url = request.url.replace(/^local-file:\/\//, '');
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
          return callback({ error: -10 });
        }
        
        // Recursive/Inclusive blocklist check:
        // We block if the sensitive pattern exists ANYWHERE in the resolved path.
        if (sensitivePatterns.some(p => verificationPath.includes(p))) {
          console.warn(`[Security] Blocked access to sensitive path via local-file: ${targetPath}`);
          return callback({ error: -10 /* net::ERR_ACCESS_DENIED */ });
        }

        return callback({ path: targetPath });
      } catch (error) {
        console.error('Failed to register local-file protocol', error);
        return callback({ error: -2 }); // net::ERR_FAILED
      }
    });

    // Cleanup orphaned .tmp files from previous sessions
    cleanupTempFiles().catch(err => console.error('[Main] Cleanup failed:', err));

    registerFilesystemHandlers();
    registerJobsHandlers();
    registerMarketplaceHandlers();
    registerAccountsHandlers();
    registerMonitorHandlers();
    registerGeminiHandlers();
    registerBugReportHandlers();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

let isQuitting = false;
app.on('before-quit', async (event) => {
  if (isQuitting) return;
  event.preventDefault();

  // 1. Handshake with renderer to check for unsaved changes.
  // We give the renderer 1.5 seconds to respond. If it doesn't, we assume it's
  // hung or no listeners are active and proceed with a safe quit.
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('quit-request');
    
    // We wait for the renderer to report if it has unsaved changes.
    const rendererState = await Promise.race([
      new Promise(resolve => {
        electronPkg.ipcMain.once('quit-response', (_e, { hasUnsavedChanges }) => resolve({ hasUnsavedChanges }));
      }),
      new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 1500))
    ]);

    if (rendererState.hasUnsavedChanges) {
      const choice = electronPkg.dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        buttons: ['Quit Without Saving', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Unsaved Changes',
        message: 'You have unsaved changes. Are you sure you want to quit? Your unsaved work will be lost.'
      });
      if (choice === 1) {
        return; // User clicked Cancel
      }
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
    await Promise.race([
      cleanup(),
      new Promise(resolve => setTimeout(resolve, 2000))
    ]);
  } catch (err) {
    console.error('[Main] Error during cleanup:', err);
  } finally {
    app.quit();
  }
});
