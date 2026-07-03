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
 *   - Adaptive cadence: polls faster when a listing is changing, slower when
 *     stable, and eases off under system load (all within 30s–5min bounds)
 *   - Session expiry detection → notifies user to re-authenticate
 *   - Exponential backoff on errors (×2 per failure, 5 min cap)
 *
 * Memory budget: ~50-150MB per instance. Concurrent-monitor cap is derived from
 * system RAM (~1 per 8GB, clamped 2–5).
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
import os from 'os';
import { handleSafe } from './ipcUtils.js';
import { logger } from '../logger.js';

// ── Configuration ───────────────────────────────────────────────────────────

// Hard safety bounds — adaptation NEVER crosses these.
const MIN_REFRESH_INTERVAL_MS = 30_000;   // 30s floor — never hammer a platform faster
const MAX_REFRESH_INTERVAL_MS = 300_000;  // 5 min cap

const DEFAULT_REFRESH_INTERVAL_MS = 60_000; // starting cadence before adaptation kicks in

// Adaptive change-frequency cadence: base cadence is no longer flat. A refresh
// that DETECTS A CHANGE means the listing is volatile → tighten toward MIN to
// catch the next change sooner; a refresh with NO change means it's stable →
// relax toward MAX and stop burning reloads on a quiet page. Both bounded.
const VOLATILE_TIGHTEN = 0.6;  // ×interval when data changed (poll faster)
const STABLE_RELAX     = 1.4;  // ×interval when nothing changed (poll slower)

// Error backoff (separate from change-adaptation — an error isn't a stability signal).
const BACKOFF_MULTIPLIER     = 2;  // ×interval per consecutive error
const MAX_CONSECUTIVE_ERRORS = 5;  // pause the monitor after this many in a row

const JITTER_RATIO    = 0.1;   // ±10% so monitors don't refresh in lockstep
const MAX_LOAD_FACTOR = 2.5;   // cap on how far system load can stretch cadence
const MONITOR_SETTLE_MS = 3000; // beat after a reload for the page to hydrate before extracting

// Hard ceiling on one refresh cycle (reload + settle + extract). Without this,
// a hung page (dead network, a captcha wall that never resolves, an infinite
// extractor loop) leaves wc.loadURL/executeJavaScript pending forever —
// refreshMonitor() never resolves, so scheduleNextRefresh() (only called
// AFTER refreshMonitor settles, see below) never fires again. The monitor
// silently stops updating for good, with no error and no backoff. Treating a
// timeout as a normal refresh error routes it through the existing
// consecutiveErrors backoff/pause path instead.
const REFRESH_TIMEOUT_MS = 45_000;

// Concurrency cap derived from system RAM (each monitor is a hidden
// BrowserWindow, ~50–150MB + a page reload per cycle): ~1 per 8GB, clamped so a
// small box keeps ≥2 and a large one caps at 5. A 24GB machine resolves to 3
// (the previous hardcoded value).
const MAX_CONCURRENT_MONITORS = (() => {
  let gb = 24;
  try { gb = os.totalmem() / 1024 ** 3; } catch { /* fall back to default */ }
  return Math.max(2, Math.min(5, Math.round(gb / 8)));
})();

/** Clamp any interval to the hard safety bounds. */
const clampInterval = (ms) => Math.max(MIN_REFRESH_INTERVAL_MS, Math.min(MAX_REFRESH_INTERVAL_MS, ms));

/**
 * Race `promise` against a `ms`-timeout that rejects with a clear message
 * naming what hung. Does not cancel `promise` itself (loadURL/executeJavaScript
 * have no cancellation hook) — it only stops US from waiting on it forever.
 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Count monitors currently in the active refresh loop. */
function countActiveMonitors() {
  let n = 0;
  for (const m of monitors.values()) if (m.status === 'monitoring') n++;
  return n;
}

/**
 * Multiplier (≥1, capped at MAX_LOAD_FACTOR) that stretches refresh cadence
 * under load — more concurrent monitors and a CPU-oversubscribed machine both
 * ease the pool off. Never shrinks cadence (factor ≥ 1), so it only ever slows
 * polling, never speeds it past the per-monitor interval.
 */
function systemLoadFactor() {
  let factor = 1;
  factor += Math.max(0, countActiveMonitors() - 1) * 0.2;  // each extra monitor adds reload pressure
  try {
    const cores = os.cpus()?.length || 1;
    const load1 = os.loadavg?.()[0] || 0;  // 0 on Windows — guarded so we only use it where meaningful
    if (load1 > 0) factor += Math.max(0, load1 / cores - 1) * 0.5;
  } catch { /* ignore — load avg unavailable */ }
  return Math.min(MAX_LOAD_FACTOR, factor);
}

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
 * @property {number} refreshIntervalMs   — Next refresh delay (adaptiveBaseMs, or backed-off on errors)
 * @property {number} adaptiveBaseMs       — Change-frequency-driven cadence (tightens/relaxes within MIN/MAX)
 * @property {number} baseRefreshMs       — Original configured interval (reset target on re-auth)
 * @property {NodeJS.Timeout|null} timer  — Active refresh timer
 * @property {number} consecutiveErrors   — Error counter for backoff
 * @property {number} lastRefreshTime     — Timestamp of last successful refresh
 * @property {any[]} lastData             — Most recent extracted data
 * @property {number} dataVersion         — Increments on each data change (for diffing)
 * @property {boolean} refreshing         — True while a refreshMonitor() call is in flight, for reentrancy
 */

let monitorIdCounter = 0;

// ── Notification Helpers ────────────────────────────────────────────────────

function getMainWindows() {
  const monitorWinIds = new Set();
  for (const m of monitors.values()) {
    if (m.window?.id != null) monitorWinIds.add(m.window.id);
  }
  return BrowserWindow.getAllWindows().filter(
    w => !w.isDestroyed() && !monitorWinIds.has(w.id)
  );
}

/**
 * Send an IPC event to every non-monitor renderer window that is alive — not
 * just the first one found. A user with more than one app window open (e.g. a
 * second canvas) previously had monitor notifications silently delivered to
 * only whichever window happened to be first in getAllWindows(), leaving
 * every other window's UI unaware a monitor changed/expired/paused.
 * Silently no-ops if no window is found or a given webContents is destroyed.
 */
function sendToMain(channel, payload) {
  for (const win of getMainWindows()) {
    if (win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
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
  const clampedRefresh = clampInterval(refreshMs);

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
    adaptiveBaseMs: clampedRefresh,
    baseRefreshMs: clampedRefresh,
    timer: null,
    consecutiveErrors: 0,
    lastRefreshTime: 0,
    lastData: [],
    dataVersion: 0,
    refreshing: false,
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

  // Reentrancy guard: startMonitoring() fires the first refresh WITHOUT
  // awaiting it, then immediately schedules the next one on a timer that can
  // elapse (as little as MIN_REFRESH_INTERVAL_MS × (1 - JITTER_RATIO)) before
  // that first call finishes on a slow page. Without this guard, both calls
  // would run concurrently against the SAME webContents (racing loadURL /
  // executeJavaScript) and mutate the same monitor record (double-counted
  // errors, garbled diffs, duplicate notifications).
  if (monitor.refreshing) {
    logger.warn(`[Monitor ${id}] Skipping refresh — previous refresh still in flight`);
    return;
  }
  monitor.refreshing = true;

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

    await withTimeout(wc.loadURL(monitor.url), REFRESH_TIMEOUT_MS, `[Monitor ${id}] loadURL`);
    if (!monitors.has(id)) return;

    // Wait for page to settle (network idle equivalent)
    await new Promise(r => setTimeout(r, MONITOR_SETTLE_MS));
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
    const data = await withTimeout(wc.executeJavaScript(liveMonitor.extractorJS), REFRESH_TIMEOUT_MS, `[Monitor ${id}] executeJavaScript`);
    if (!monitors.has(id)) return;

    liveMonitor.consecutiveErrors = 0;
    liveMonitor.lastRefreshTime = Date.now();

    // Diff: check if data has changed
    const newDataStr = JSON.stringify(data);
    const oldDataStr = JSON.stringify(liveMonitor.lastData);
    const changed = newDataStr !== oldDataStr && Array.isArray(data) && data.length > 0;

    if (changed) {
      liveMonitor.lastData = data;
      liveMonitor.dataVersion++;
      notifyDataChange(liveMonitor);
    }

    // Adaptive cadence: tighten toward MIN when the listing is changing, relax
    // toward MAX when it's stable. This is the success path, so it also clears
    // any error backoff by anchoring refreshIntervalMs to the adaptive base.
    liveMonitor.adaptiveBaseMs = clampInterval(
      liveMonitor.adaptiveBaseMs * (changed ? VOLATILE_TIGHTEN : STABLE_RELAX),
    );
    liveMonitor.refreshIntervalMs = liveMonitor.adaptiveBaseMs;
    const cadenceSec = Math.round(liveMonitor.adaptiveBaseMs / 1000);

    if (changed) {
      logger.info(`[Monitor ${id}] Data changed: → ${data.length} items (v${liveMonitor.dataVersion}) — cadence ↓ ${cadenceSec}s`);
    } else {
      logger.info(`[Monitor ${id}] Refresh OK — no changes (${(data || []).length} items) — cadence ↑ ${cadenceSec}s`);
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

    // Exponential backoff: grow the interval on each consecutive error. This
    // rides on top of refreshIntervalMs and is cleared by the next success
    // (which re-anchors to adaptiveBaseMs). Bounded by the hard MAX.
    if (m.consecutiveErrors > 1) {
      m.refreshIntervalMs = clampInterval(m.refreshIntervalMs * BACKOFF_MULTIPLIER);
      logger.warn(`[Monitor ${id}] Backoff: next refresh in ${m.refreshIntervalMs / 1000}s`);
    }

    // After too many consecutive errors, pause the monitor.
    if (m.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      m.status = 'paused';
      clearTimeout(m.timer);
      m.timer = null;
      logger.error(`[Monitor ${id}] Paused after ${MAX_CONSECUTIVE_ERRORS} consecutive errors`);
      notifyMonitorPaused(m);
    }
  } finally {
    monitor.refreshing = false;
  }
}

/**
 * Schedule the next refresh using the current (possibly backed-off) interval.
 */
function scheduleNextRefresh(id) {
  const monitor = monitors.get(id);
  if (!monitor || monitor.status !== 'monitoring') return;

  // Stretch the per-monitor interval by current system load (more monitors /
  // CPU pressure → ease off), then add ±jitter so monitors don't refresh in
  // lockstep. Clamped to the hard MIN/MAX bounds.
  const loaded = clampInterval(monitor.refreshIntervalMs * systemLoadFactor());
  const jitter = loaded * JITTER_RATIO * (Math.random() * 2 - 1);
  const delay = Math.round(loaded + jitter);

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
  monitor.adaptiveBaseMs = monitor.baseRefreshMs;  // forget learned volatility on re-auth

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
    adaptiveBaseMs: m.adaptiveBaseMs,
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
export function isSessionExpired(platform, currentUrl) {
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
