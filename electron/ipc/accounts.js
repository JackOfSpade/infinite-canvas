/**
 * Accounts IPC handlers — platform login, session management.
 * Opens visible browser windows for login and checks cookie health.
 */

import electronPkg from 'electron';
const { ipcMain, app } = electronPkg;
import fs from 'fs';
import path from 'path';
import {
  openLoginWindow,
  getSessionStatus,
  getAllSessionStatuses,
  getSupportedPlatforms,
  getSellMonitorPlatforms,
  getSellMonitorConfig,
} from './stealthBrowser.js';

// ── Session status disk cache ─────────────────────────────────────────────────────────
// Avoids launching Chrome just to display status on panel open.
// In-memory copy is the single source of truth during the process lifetime;
// disk is the persistence layer between sessions.
let _statusCache = null;

// Resolved lazily on first access (after app is ready and getPath is available).
let _statusCachePath = null;
function getStatusCachePath() {
  if (!_statusCachePath) _statusCachePath = path.join(app.getPath('userData'), 'session-status-cache.json');
  return _statusCachePath;
}
async function readStatusCache() {
  if (_statusCache) return _statusCache;
  try {
    const p = getStatusCachePath();
    const data = await fs.promises.readFile(p, 'utf8').catch(() => null);
    if (!data) { _statusCache = {}; return _statusCache; }
    _statusCache = JSON.parse(data);
    return _statusCache;
  } catch { _statusCache = {}; return _statusCache; }
}
async function writeStatusCache(platformId, connected) {
  try {
    const cache = await readStatusCache(); // returns the in-memory object
    cache[platformId] = { connected, ts: Date.now() };
    // _statusCache is already mutated (same object reference); persist to disk.
    await fs.promises.writeFile(getStatusCachePath(), JSON.stringify(cache));
  } catch (e) {
    console.warn('[Accounts] Cache write failed:', e?.message || String(e));
  }
}

/**
 * Register all Accounts IPC handlers.
 */
export function registerAccountsHandlers() {
  // Get CACHED session statuses — instant, no Chrome launch.
  // Use this for panel display. The full (Chrome-based) check is get-session-statuses.
  ipcMain.handle('get-cached-session-statuses', async () => {
    const cache = await readStatusCache();
    return Object.entries(cache).map(([platform, v]) => ({
      platform, connected: v.connected,
    }));
  });

  // Get system config status (Gemini, USAJobs, etc)
  ipcMain.handle('get-system-config-status', async () => {
    let hasGemini = !!process.env.GEMINI_API_KEY;
    if (!hasGemini) {
      try {
        const content = await fs.promises.readFile(path.join(process.cwd(), '.env'), 'utf8');
        // Use a start-of-line anchor so commented-out lines (e.g. #GEMINI_API_KEY=) aren't matched.
        hasGemini = /^GEMINI_API_KEY=/m.test(content);
      } catch { /* env file absent */ }
    }

    let hasServiceAccount = false;
    try {
      await fs.promises.stat(path.join(process.cwd(), 'service-account.json'));
      hasServiceAccount = true;
    } catch { /* stat fails if absent */ }

    return {
      gemini:         { connected: hasGemini,          name: 'Gemini AI API' },
      serviceAccount: { connected: hasServiceAccount,  name: 'Google Cloud Service Account' },
    };
  });

  // Get list of supported platforms
  ipcMain.handle('get-platforms', () => {
    return getSupportedPlatforms();
  });

  // Get connection status for all platforms
  ipcMain.handle('get-session-statuses', async () => {
    try {
      return await getAllSessionStatuses();
    } catch (error) {
      console.error('[Accounts] Failed to check sessions:', error?.message || String(error));
      return [];
    }
  });

  // Check session for a SINGLE platform (fast — no login prompt)
  ipcMain.handle('check-platform-session', async (_event, { platformId }) => {
    try {
      return await getSessionStatus(platformId);
    } catch (error) {
      console.error(`[Accounts] Session check failed for ${platformId}:`, error?.message || String(error));
      return { platform: platformId, connected: false };
    }
  });

  // Open a visible login window for a specific platform
  ipcMain.handle('open-login-window', async (_event, { platformId }) => {
    try {
      const result = await openLoginWindow(platformId, _event.sender);
      // After the login window closes, optimistically mark as connected.
      // The user manually closed the window after logging in, so we trust they succeeded.
      // Avoids a second Chrome launch just for verification.
      await writeStatusCache(platformId, true);
      return result;
    } catch (error) {
      console.error(`[Accounts] Login window failed for ${platformId}:`, error?.message || String(error));
      return { success: false, error: error?.message || String(error) };
    }
  });

  // Check-and-login flow: check session → if not logged in, open login → verify
  // Returns { connected: boolean, platform: string, loginOpened: boolean }
  ipcMain.handle('check-and-login', async (_event, { platformId }) => {
    try {
      // Step 1: Quick session check
      const status = await getSessionStatus(platformId);
      if (status.connected) {
        return { ...status, loginOpened: false };
      }

      // Step 2: Not logged in — open login window (blocks until user closes it)
      console.log(`[Accounts] ${platformId} not logged in — opening login window`);
      await openLoginWindow(platformId, _event.sender);

      // Step 3: Re-check session after login window closed
      const postLogin = await getSessionStatus(platformId);
      
      if (_event.sender.isDestroyed()) {
        return { platform: platformId, connected: postLogin.connected, loginOpened: true };
      }

      return { ...postLogin, loginOpened: true };
    } catch (error) {
      console.error(`[Accounts] Check-and-login failed for ${platformId}:`, error?.message || String(error));
      return { platform: platformId, connected: false, loginOpened: false, error: error?.message || String(error) };
    }
  });

  // ── Sell Monitor Auth (moved from marketplace.js — these are auth concerns) ──

  // Returns which platforms need login for sell monitoring
  ipcMain.handle('get-sell-platforms', () => {
    return getSellMonitorPlatforms();
  });

  // Before sell monitoring: check if the user is logged into the platform.
  // Returns { platform, connected, name, sellerUrl }
  ipcMain.handle('check-sell-monitor-auth', async (_event, { platformId }) => {
    const config = getSellMonitorConfig(platformId);
    if (!config) {
      return { platform: platformId, connected: false, error: 'Unknown platform' };
    }

    try {
      const status = await getSessionStatus(platformId);
      return {
        ...status,
        name: config.name,
        sellerUrl: config.sellerUrl,
      };
    } catch (error) {
      console.error(`[Accounts] Auth check failed for ${platformId}:`, error?.message || String(error));
      return { platform: platformId, connected: false, name: config.name };
    }
  });
}
