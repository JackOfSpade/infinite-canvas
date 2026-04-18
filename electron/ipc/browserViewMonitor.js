import { logger } from '../logger.js';
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
import electronPkg from 'electron';
const { BrowserWindow } = electronPkg;
import { handleSafe } from './ipcUtils.js';

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

// ── Notification Helpers ────────────────────────────────────────────────────

function getMainWindow() {
  const monitorWinIds = new Set();
  for (const m of monitors.values()) {
    if (m.window?.id != null) monitorWinIds.add(m.window.id);
  }
  return BrowserWindow.getAllWindows().find(
    w => !w.isDestroyed() && !monitorWinIds.has(w.id)
  );
}

/**
 * Send an IPC event to the main renderer window if it is alive.
 * Silently no-ops if no main window is found or its webContents is destroyed.
 */
function sendToMain(channel, payload) {
  const mainWin = getMainWindow();
  if (mainWin && mainWin.webContents && !mainWin.webContents.isDestroyed()) {
    mainWin.webContents.send(channel, payload);
  }
}

function notifyDataChange(monitor) {
  sendToMain('monitor-data-changed', {
    id: monitor.id,
    platform: monitor.platform,
    itemCount: monitor.lastData.length,
    dataVersion: monitor.dataVersion,
    data: monitor.lastData,
  });
}

function notifySessionExpired(monitor) {
  sendToMain('monitor-session-expired', {
    id: monitor.id,
    platform: monitor.platform,
  });
}

function notifyMonitorPaused(monitor) {
  sendToMain('monitor-paused', {
    id: monitor.id,
    platform: monitor.platform,
    consecutiveErrors: monitor.consecutiveErrors,
  });
}

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
    logger.error(`[Monitor ${id}] Failed to load ${url}:`, err?.message || String(err));
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
      logger.info(`[Monitor ${id}] Setup complete — starting background monitoring`);
      startMonitoring(id);
    }
  });

  // Clean up if the window is destroyed externally (crash, OS force-quit, etc.).
  win.on('closed', () => {
    stopMonitor(id);
  });

  logger.info(`[Monitor ${id}] Opened for ${platform} at ${url}`);
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

  logger.info(`[Monitor ${id}] Background monitoring started (refresh: ${monitor.refreshIntervalMs / 1000}s)`);

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
    // Guard: the window may have been destroyed externally between the status check above
    // and this point (e.g. OS force-quit during a scheduled refresh).
    if (!monitor.window || monitor.window.isDestroyed()) {
      stopMonitor(id);
      return;
    }

    // Reload the page
    const wc = monitor.window.webContents;
    if (!wc || wc.isDestroyed()) {
      stopMonitor(id);
      return;
    }

    await wc.loadURL(monitor.url);
    if (!monitors.has(id)) return;

    // Wait for page to settle (network idle equivalent)
    await new Promise(r => setTimeout(r, 3000));
    if (!monitors.has(id)) return;

    // Re-fetch the live monitor record — the 3-second wait above is a meaningful
    // async gap during which stopMonitor() could have been called, the status
    // changed to 'paused', or the window could have been destroyed externally.
    const liveMonitor = monitors.get(id);
    if (!liveMonitor || liveMonitor.status === 'paused') return;
    if (liveMonitor.window.isDestroyed() || wc.isDestroyed()) {
      stopMonitor(id);
      return;
    }

    // Execute extractor JS in the page context
    const data = await wc.executeJavaScript(liveMonitor.extractorJS);
    if (!monitors.has(id)) return;

    liveMonitor.consecutiveErrors = 0;
    liveMonitor.lastRefreshTime = Date.now();

    // Reset backoff on success
    liveMonitor.refreshIntervalMs = liveMonitor.baseRefreshMs;

    // Diff: check if data has changed
    const newDataStr = JSON.stringify(data);
    const oldDataStr = JSON.stringify(liveMonitor.lastData);

    if (newDataStr !== oldDataStr && Array.isArray(data) && data.length > 0) {
      const prevCount = liveMonitor.lastData.length;
      liveMonitor.lastData = data;
      liveMonitor.dataVersion++;

      logger.info(`[Monitor ${id}] Data changed: ${prevCount} → ${data.length} items (v${liveMonitor.dataVersion})`);

      // Notify the renderer about the update
      notifyDataChange(liveMonitor);
    } else {
      logger.info(`[Monitor ${id}] Refresh OK — no changes (${(data || []).length} items)`);
    }

    // Check for session expiry signals (guard destroyed wc before getURL)
    if (wc.isDestroyed()) return;
    const pageUrl = wc.getURL();
    if (isSessionExpired(liveMonitor.platform, pageUrl)) {
      liveMonitor.status = 'expired';
      clearTimeout(liveMonitor.timer);
      liveMonitor.timer = null;
      logger.warn(`[Monitor ${id}] Session expired — user must re-authenticate`);
      notifySessionExpired(liveMonitor);
      return;
    }
  } catch (error) {
    if (!monitors.has(id)) return;
    const m = monitors.get(id);
    m.consecutiveErrors++;
    logger.error(`[Monitor ${id}] Refresh failed (attempt ${m.consecutiveErrors}):`, error?.message || String(error));

    // Exponential backoff: double the interval on each consecutive error
    if (m.consecutiveErrors > 1) {
      m.refreshIntervalMs = Math.min(
        MAX_REFRESH_INTERVAL_MS,
        m.refreshIntervalMs * 2
      );
      logger.warn(`[Monitor ${id}] Backoff: next refresh in ${m.refreshIntervalMs / 1000}s`);
    }

    // After 5 consecutive errors, pause the monitor
    if (m.consecutiveErrors >= 5) {
      m.status = 'paused';
      clearTimeout(m.timer);
      m.timer = null;
      logger.error(`[Monitor ${id}] Paused after 5 consecutive errors`);
      notifyMonitorPaused(m);
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

  monitors.delete(id); // Delete immediately to prevent reentrancy loops from window.destroy()
  
  if (monitor.timer) {
    clearTimeout(monitor.timer);
    monitor.timer = null;
  }

  if (monitor.window && !monitor.window.isDestroyed()) {
    monitor.window.destroy();
  }

  logger.info(`[Monitor ${id}] Stopped and cleaned up`);
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
  if (monitor.window && !monitor.window.isDestroyed()) {
    monitor.window.show();
    monitor.window.loadURL(monitor.url).catch(err => {
      logger.error(`[Monitor ${id}] Failed to reload URL for re-auth:`, err?.message || String(err));
    });
  }

  logger.info(`[Monitor ${id}] Reopened for re-authentication`);
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

// ── IPC Handler Registration ────────────────────────────────────────────────

export function registerMonitorHandlers() {
  // Open a new monitor window (user sees it, logs in, closes to start)
  handleSafe('open-monitor', async (_event, opts) => {
    return openMonitor(opts);
  });

  // Force-start monitoring (skip waiting for window close)
  handleSafe('start-monitoring', async (_event, { id }) => {
    startMonitoring(id);
    return { success: true };
  });

  // Stop and close a monitor
  handleSafe('stop-monitor', async (_event, { id }) => {
    stopMonitor(id);
    return { success: true };
  });

  // Reopen for re-authentication
  handleSafe('reopen-monitor', async (_event, { id }) => {
    reopenMonitor(id);
    return { success: true };
  });

  // Get status of all monitors
  handleSafe('get-monitors', async () => {
    return { monitors: getActiveMonitors() };
  });

  // Get the latest data from a specific monitor
  handleSafe('get-monitor-data', async (_event, { id }) => {
    const monitor = monitors.get(id);
    if (!monitor) throw new Error('Monitor not found');
    return {
      id: monitor.id,
      platform: monitor.platform,
      data: monitor.lastData,
      dataVersion: monitor.dataVersion,
      lastRefreshTime: monitor.lastRefreshTime,
    };
  });

  logger.info('[MonitorManager] IPC handlers registered');
}

/**
 * Clean up all monitors on app quit.
 */
export function closeAllMonitors() {
  for (const id of monitors.keys()) {
    stopMonitor(id);
  }
}
