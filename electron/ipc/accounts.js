/**
 * Accounts IPC handlers — platform login, session management.
 * Opens visible browser windows for login and checks cookie health.
 */
/* global process */
import { ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  openLoginWindow,
  getSessionStatus,
  getAllSessionStatuses,
  getSupportedPlatforms,
  getSellMonitorPlatforms,
  getSellMonitorConfig,
} from './stealthBrowser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../../');

/**
 * Register all Accounts IPC handlers.
 */
export function registerAccountsHandlers() {
  // Get system config status (Gemini, USAJobs, etc)
  ipcMain.handle('get-system-config-status', () => {
    // We can infer existence from process.env if loaded, but safer to check explicitly
    // Or, since Vite loads .env, we can just check process.env or check the file.
    let hasGemini = !!process.env.GEMINI_API_KEY;
    if (!hasGemini) {
      try {
        const envPath = path.join(ROOT_DIR, '.env');
        const content = fs.readFileSync(envPath, 'utf8');
        hasGemini = content.includes('GEMINI_API_KEY=');
      } catch (e) {
        void e;
      }
    }
    
    let hasServiceAccount = false;
    try {
      hasServiceAccount = fs.existsSync(path.join(ROOT_DIR, 'service-account.json'));
    } catch (e) {
      void e;
    }

    return {
      gemini: { connected: hasGemini, name: 'Gemini AI API' },
      serviceAccount: { connected: hasServiceAccount, name: 'Google Cloud Service Account' }
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
      console.error('[Accounts] Failed to check sessions:', error.message);
      return [];
    }
  });

  // Check session for a SINGLE platform (fast — no login prompt)
  ipcMain.handle('check-platform-session', async (_event, { platformId }) => {
    try {
      return await getSessionStatus(platformId);
    } catch (error) {
      console.error(`[Accounts] Session check failed for ${platformId}:`, error.message);
      return { platform: platformId, connected: false };
    }
  });

  // Open a visible login window for a specific platform
  ipcMain.handle('open-login-window', async (_event, { platformId }) => {
    try {
      return await openLoginWindow(platformId);
    } catch (error) {
      console.error(`[Accounts] Login window failed for ${platformId}:`, error.message);
      return { success: false, error: error.message };
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
      await openLoginWindow(platformId);

      // Step 3: Re-check session after login window closed
      const postLogin = await getSessionStatus(platformId);
      return { ...postLogin, loginOpened: true };
    } catch (error) {
      console.error(`[Accounts] Check-and-login failed for ${platformId}:`, error.message);
      return { platform: platformId, connected: false, loginOpened: false, error: error.message };
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
      console.error(`[Accounts] Auth check failed for ${platformId}:`, error.message);
      return { platform: platformId, connected: false, name: config.name };
    }
  });
}
