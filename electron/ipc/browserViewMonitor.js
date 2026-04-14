/**
 * Tier 4 — BrowserView Monitor Manager
 *
 * Manages persistent background monitors for hostile platforms (Facebook, etc.)
 * that require human-assisted authentication and continuous monitoring.
 *
 * Architecture:
 *   - Each monitor is a hidden BrowserWindow (not BrowserView — deprecated in Electron 30+)
 *   - Human opens the window, navigates + logs in, bot takes over
 *   - Bot periodically refreshes and re-extracts data in the background
 *   - Session expiry detection → notifies user to re-authenticate
 *   - Exponential backoff: 30s → 60s → 120s → 300s (5 min cap)
 *
 * Memory budget: ~50-150MB per instance. Default cap: 5 concurrent monitors.
 *
 * Public API:
 *   registerMonitorHandlers()  — register IPC handlers
 *   openMonitor(opts)          — open a new monitor window for user setup
 *   startMonitoring(id)        — hide window, begin background refresh loop
 *   stopMonitor(id)            — stop monitoring and close the window
 *   getActiveMonitors()        — list all active monitors with status
 */
import { ipcMain, BrowserWindow } from 'electron';

// ── Configuration ───────────────────────────────────────────────────────────

const MAX_CONCURRENT_MONITORS = 3;  // 24GB system: ~450MB budget leaves room for DaVinci + Chrome
const MIN_REFRESH_INTERVAL_MS = 30_000;      // 30s minimum
const MAX_REFRESH_INTERVAL_MS = 300_000;      // 5 min cap
const DEFAULT_REFRESH_INTERVAL_MS = 60_000;   // 1 min default
const SESSION_CHECK_INTERVAL_MS = 600_000;    // Check session health every 10 min

// ── Monitor State ───────────────────────────────────────────────────────────

/** @type {Map<string, Monitor>} */
const monitors = new Map();

/**
 * @typedef {Object} Monitor
 * @property {string} id                  — Unique monitor ID
 * @property {string} platform            — Platform identifier (e.g., 'facebook', 'glassdoor')
 * @property {string} url                 — URL being monitored
 * @property {string} extractorJS         — JS to run in page for data extraction
 * @property {BrowserWindow} window       — Electron BrowserWindow instance
 * @property {'setup'|'monitoring'|'paused'|'expired'} status
 * @property {number} refreshIntervalMs   — Current refresh interval (subject to backoff)
 * @property {number} baseRefreshMs       — Original refresh interval (for backoff reset)
 * @property {NodeJS.Timeout|null} timer  — Active refresh timer
 * @property {number} consecutiveErrors   — Error counter for backoff
 * @property {number} lastRefreshTime     — Timestamp of last successful refresh
 * @property {any[]} lastData             — Most recent extracted data
 * @property {number} dataVersion         — Increments on each data change (for diffing)
 */

let monitorIdCounter = 0;



// ── Core Monitor Operations ─────────────────────────────────────────────────

/**
 * Open a new monitor window for user setup.
 * The window is VISIBLE so the user can navigate, log in, etc.
 * Once the page is ready, call `startMonitoring(id)` to hide it and begin refreshing.
 *
 * @param {Object} opts
 * @param {string} opts.platform      — Platform ID (e.g., 'facebook')
 * @param {string} opts.url           — URL to load initially
 * @param {string} opts.extractorJS   — JS extractor to run on each refresh
 * @param {number} [opts.refreshMs]   — Refresh interval (default 60s)
 * @returns {{ id: string }} — Monitor ID for subsequent calls
 */
function openMonitor({ platform, url, extractorJS, refreshMs = DEFAULT_REFRESH_INTERVAL_MS }) {
  if (monitors.size >= MAX_CONCURRENT_MONITORS) {
    throw new Error(`Monitor limit reached (${MAX_CONCURRENT_MONITORS}). Close an existing monitor first.`);
  }

  const id = `monitor-${platform}-${++monitorIdCounter}`;
  const clampedRefresh = Math.max(MIN_REFRESH_INTERVAL_MS, Math.min(MAX_REFRESH_INTERVAL_MS, refreshMs));

  // Create a visible BrowserWindow with persistent session data
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    show: true,
    title: `Monitor: ${platform} — Log in, then close this window to start monitoring`,
    webPreferences: {
      // Use persistent partition that shares cookies with the stealth browser
      partition: 'persist:scraper',
      nodeIntegration: false,
      contextIsolation: true,
      // No preload needed — we use executeJavaScript directly
    },
  });

  // Load the initial URL
  win.loadURL(url).catch(err => {
    console.error(`[Monitor ${id}] Failed to load ${url}:`, err.message);
  });

  const monitor = {
    id,
    platform,
    url,
    extractorJS,
    window: win,
    status: 'setup',
    refreshIntervalMs: clampedRefresh,
    baseRefreshMs: clampedRefresh,
    timer: null,
    consecutiveErrors: 0,
    lastRefreshTime: 0,
    lastData: [],
    dataVersion: 0,
  };

  monitors.set(id, monitor);

  // When user closes the setup window → auto-start monitoring in background
  win.on('close', (e) => {
    if (monitor.status === 'setup') {
      e.preventDefault();
      console.log(`[Monitor ${id}] Setup complete — starting background monitoring`);
      startMonitoring(id);
    }
  });

  // Clean up if window is destroyed unexpectedly
  win.on('closed', () => {
    stopMonitor(id);
  });

  console.log(`[Monitor ${id}] Opened for ${platform} at ${url}`);
  return { id };
}

/**
 * Hide the monitor window and begin the background refresh loop.
 * The first extraction happens immediately; then repeats on the configured interval.
 */
function startMonitoring(id) {
  const monitor = monitors.get(id);
  if (!monitor) throw new Error(`Monitor ${id} not found`);

  if (monitor.status === 'monitoring') return; // Already running

  monitor.status = 'monitoring';
  monitor.window.hide();

  console.log(`[Monitor ${id}] Background monitoring started (refresh: ${monitor.refreshIntervalMs / 1000}s)`);

  // Run first extraction immediately
  refreshMonitor(id);

  // Start the refresh loop
  scheduleNextRefresh(id);
}

/**
 * Execute the extractor JS against the monitor's page and diff the results.
 */
async function refreshMonitor(id) {
  const monitor = monitors.get(id);
  if (!monitor || monitor.status === 'paused') return;

  try {
    // Reload the page
    const wc = monitor.window.webContents;
    await wc.loadURL(monitor.url);

    // Wait for page to settle (network idle equivalent)
    await new Promise(r => setTimeout(r, 3000));

    // Execute extractor JS in the page context
    const data = await wc.executeJavaScript(monitor.extractorJS);

    monitor.consecutiveErrors = 0;
    monitor.lastRefreshTime = Date.now();

    // Reset backoff on success
    monitor.refreshIntervalMs = monitor.baseRefreshMs;

    // Diff: check if data has changed
    const newDataStr = JSON.stringify(data);
    const oldDataStr = JSON.stringify(monitor.lastData);

    if (newDataStr !== oldDataStr && Array.isArray(data) && data.length > 0) {
      const prevCount = monitor.lastData.length;
      monitor.lastData = data;
      monitor.dataVersion++;

      console.log(`[Monitor ${id}] Data changed: ${prevCount} → ${data.length} items (v${monitor.dataVersion})`);

      // Notify the renderer about the update
      notifyDataChange(monitor);
    } else {
      console.log(`[Monitor ${id}] Refresh OK — no changes (${(data || []).length} items)`);
    }

    // Check for session expiry signals
    const pageUrl = wc.getURL();
    if (isSessionExpired(monitor.platform, pageUrl)) {
      monitor.status = 'expired';
      clearInterval(monitor.timer);
      monitor.timer = null;
      console.warn(`[Monitor ${id}] Session expired — user must re-authenticate`);
      notifySessionExpired(monitor);
      return;
    }
  } catch (error) {
    monitor.consecutiveErrors++;
    console.error(`[Monitor ${id}] Refresh failed (attempt ${monitor.consecutiveErrors}):`, error.message);

    // Exponential backoff: double the interval on each consecutive error
    if (monitor.consecutiveErrors > 1) {
      monitor.refreshIntervalMs = Math.min(
        MAX_REFRESH_INTERVAL_MS,
        monitor.refreshIntervalMs * 2
      );
      console.warn(`[Monitor ${id}] Backoff: next refresh in ${monitor.refreshIntervalMs / 1000}s`);
    }

    // After 5 consecutive errors, pause the monitor
    if (monitor.consecutiveErrors >= 5) {
      monitor.status = 'paused';
      clearTimeout(monitor.timer);
      monitor.timer = null;
      console.error(`[Monitor ${id}] Paused after 5 consecutive errors`);
      notifyMonitorPaused(monitor);
    }
  }
}

/**
 * Schedule the next refresh using the current (possibly backed-off) interval.
 */
function scheduleNextRefresh(id) {
  const monitor = monitors.get(id);
  if (!monitor || monitor.status !== 'monitoring') return;

  // Add jitter: ±10% to avoid synchronized refresh patterns
  const jitter = monitor.refreshIntervalMs * 0.1 * (Math.random() * 2 - 1);
  const delay = Math.round(monitor.refreshIntervalMs + jitter);

  monitor.timer = setTimeout(async () => {
    await refreshMonitor(id);
    scheduleNextRefresh(id); // Reschedule (interval may have changed due to backoff)
  }, delay);
}

/**
 * Stop a monitor and clean up its resources.
 */
function stopMonitor(id) {
  const monitor = monitors.get(id);
  if (!monitor) return;

  if (monitor.timer) {
    clearTimeout(monitor.timer);
    monitor.timer = null;
  }

  if (monitor.window && !monitor.window.isDestroyed()) {
    monitor.window.destroy();
  }

  monitors.delete(id);
  console.log(`[Monitor ${id}] Stopped and cleaned up`);
}

/**
 * Re-open the monitor window for the user to re-authenticate.
 */
function reopenMonitor(id) {
  const monitor = monitors.get(id);
  if (!monitor) throw new Error(`Monitor ${id} not found`);

  // Stop refresh loop
  if (monitor.timer) {
    clearTimeout(monitor.timer);
    monitor.timer = null;
  }

  monitor.status = 'setup';
  monitor.consecutiveErrors = 0;
  monitor.refreshIntervalMs = monitor.baseRefreshMs;

  // Show the window for re-auth
  monitor.window.show();
  monitor.window.loadURL(monitor.url);

  console.log(`[Monitor ${id}] Reopened for re-authentication`);
}

/**
 * Get status of all active monitors.
 */
function getActiveMonitors() {
  return Array.from(monitors.values()).map(m => ({
    id: m.id,
    platform: m.platform,
    url: m.url,
    status: m.status,
    refreshIntervalMs: m.refreshIntervalMs,
    lastRefreshTime: m.lastRefreshTime,
    itemCount: m.lastData.length,
    dataVersion: m.dataVersion,
    consecutiveErrors: m.consecutiveErrors,
  }));
}

// ── Session Expiry Detection ────────────────────────────────────────────────

/**
 * Check if the current page URL indicates a session has expired.
 * Each platform redirects to different login pages when auth drops.
 */
function isSessionExpired(platform, currentUrl) {
  const url = currentUrl.toLowerCase();
  const patterns = {
    facebook: ['/login', '/checkpoint', '/recover'],
    glassdoor: ['/profile/login', '/member/login'],
    ziprecruiter: ['/authn/login', '/login'],
    indeed: ['/auth', '/account/login'],
    ebay: ['/signin'],
    poshmark: ['/login'],
    mercari: ['/login'],
  };

  const checks = patterns[platform] || ['/login', '/signin', '/auth'];
  return checks.some(pattern => url.includes(pattern));
}

// ── Notification Helpers ────────────────────────────────────────────────────

function getMainWindow() {
  const windows = BrowserWindow.getAllWindows();
  return windows.find(w => !w.isDestroyed() && w.webContents.getURL().includes('localhost'));
}

function notifyDataChange(monitor) {
  const mainWin = getMainWindow();
  if (mainWin) {
    mainWin.webContents.send('monitor-data-changed', {
      id: monitor.id,
      platform: monitor.platform,
      itemCount: monitor.lastData.length,
      dataVersion: monitor.dataVersion,
      data: monitor.lastData,
    });
  }
}

function notifySessionExpired(monitor) {
  const mainWin = getMainWindow();
  if (mainWin) {
    mainWin.webContents.send('monitor-session-expired', {
      id: monitor.id,
      platform: monitor.platform,
    });
  }
}

function notifyMonitorPaused(monitor) {
  const mainWin = getMainWindow();
  if (mainWin) {
    mainWin.webContents.send('monitor-paused', {
      id: monitor.id,
      platform: monitor.platform,
      consecutiveErrors: monitor.consecutiveErrors,
    });
  }
}

// ── IPC Handler Registration ────────────────────────────────────────────────

export function registerMonitorHandlers() {
  // Open a new monitor window (user sees it, logs in, closes to start)
  ipcMain.handle('open-monitor', async (_event, opts) => {
    try {
      return openMonitor(opts);
    } catch (error) {
      return { error: error.message };
    }
  });

  // Force-start monitoring (skip waiting for window close)
  ipcMain.handle('start-monitoring', async (_event, { id }) => {
    try {
      startMonitoring(id);
      return { success: true };
    } catch (error) {
      return { error: error.message };
    }
  });

  // Stop and close a monitor
  ipcMain.handle('stop-monitor', async (_event, { id }) => {
    stopMonitor(id);
    return { success: true };
  });

  // Reopen for re-authentication
  ipcMain.handle('reopen-monitor', async (_event, { id }) => {
    try {
      reopenMonitor(id);
      return { success: true };
    } catch (error) {
      return { error: error.message };
    }
  });

  // Get status of all monitors
  ipcMain.handle('get-monitors', async () => {
    return getActiveMonitors();
  });

  // Get the latest data from a specific monitor
  ipcMain.handle('get-monitor-data', async (_event, { id }) => {
    const monitor = monitors.get(id);
    if (!monitor) return { error: 'Monitor not found' };
    return {
      id: monitor.id,
      platform: monitor.platform,
      data: monitor.lastData,
      dataVersion: monitor.dataVersion,
      lastRefreshTime: monitor.lastRefreshTime,
    };
  });

  console.log('[MonitorManager] IPC handlers registered');
}

/**
 * Clean up all monitors on app quit.
 */
export function closeAllMonitors() {
  for (const [id] of monitors) {
    stopMonitor(id);
  }
}
