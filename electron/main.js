import electronPkg from 'electron';
const { app, BrowserWindow, Menu, protocol } = electronPkg;
import path from 'path';
import { fileURLToPath } from 'url';
import { registerFilesystemHandlers } from './ipc/filesystem.js';
import { registerJobsHandlers } from './ipc/jobs.js';
import { registerMarketplaceHandlers } from './ipc/marketplace.js';
import { registerAccountsHandlers } from './ipc/accounts.js';
import { registerMonitorHandlers, closeAllMonitors } from './ipc/browserViewMonitor.js';
import { closeStealthBrowser } from './ipc/stealthBrowser.js';
import { registerGeminiHandlers } from './ipc/gemini.js';
import { registerBugReportHandlers } from './ipc/bugReport.js';

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
    { role: 'viewMenu' },
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
      if (!parsedUrl.protocol.startsWith('file:') && !parsedUrl.origin.includes('localhost')) {
        event.preventDefault();
      }
    } catch {
      // Malformed or non-http URL (e.g. about:blank, javascript:) — block navigation
      event.preventDefault();
    }
  });
});

app.whenReady().then(() => {
  protocol.registerFileProtocol('local-file', (request, callback) => {
    let url = request.url.replace(/^local-file:\/\//, '');
    try {
      const decodedPath = decodeURIComponent(url);
      const normalizedPath = path.normalize(decodedPath);
      
      return callback({ path: normalizedPath });
    } catch (error) {
      console.error('Failed to register local-file protocol', error);
      return callback({ error: -2 }); // net::ERR_FAILED
    }
  });

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

let isQuitting = false;
app.on('before-quit', async (event) => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;

  // Cleanup with safety timeout
  try {
    const cleanup = async () => {
      closeAllMonitors();
      await closeStealthBrowser();
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
