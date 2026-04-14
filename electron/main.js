/* global process */
import { app, BrowserWindow, Menu } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { registerFilesystemHandlers } from './ipc/filesystem.js';
import { registerJobsHandlers } from './ipc/jobs.js';
import { registerMarketplaceHandlers } from './ipc/marketplace.js';
import { registerAccountsHandlers } from './ipc/accounts.js';
import { registerMonitorHandlers, closeAllMonitors } from './ipc/browserViewMonitor.js';
import { closeStealthBrowser } from './ipc/stealthBrowser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  setupApplicationMenu(mainWindow);
}

// ── Application menu ─────────────────────────────────────────────────────────

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
        { label: 'Open Canvas', accelerator: 'CmdOrCtrl+O', click: () => win.webContents.send('menu-open') },
        { label: 'Save Canvas', accelerator: 'CmdOrCtrl+S', click: () => win.webContents.send('menu-save') },
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

app.whenReady().then(() => {
  registerFilesystemHandlers();
  registerJobsHandlers();
  registerMarketplaceHandlers();
  registerAccountsHandlers();
  registerMonitorHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  closeAllMonitors();
  await closeStealthBrowser();
});
