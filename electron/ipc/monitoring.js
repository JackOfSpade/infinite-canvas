/**
 * Monitoring IPC handlers — powered by Gemini AI for live page analysis.
 * No data is stored. Each "check" is a fresh, on-demand interpretation.
 */
import { ipcMain } from 'electron';
import { fetchPageHtml, analyzeWithGemini } from './gemini.js';

/**
 * Register all monitoring IPC handlers.
 * @param {() => import('electron').BrowserWindow | null} getMainWindow
 */
export function registerMonitoringHandlers(getMainWindow) {

  // ── Register a new listing (extract title from URL) ──────────────────────
  ipcMain.handle('register-listing', async (_event, { url, platform }) => {
    try {
      const urlObj = new URL(url.startsWith('http') ? url : `https://${url}`);
      const pathParts = urlObj.pathname.split('/').filter(Boolean);
      const fakeTitle = pathParts.length > 0
        ? pathParts[pathParts.length - 1].replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
        : `${platform} Listing`;
      return { success: true, title: fakeTitle };
    } catch {
      return { success: true, title: `${platform} Listing` };
    }
  });

  // ── Check listing — the core Gemini-powered analysis ─────────────────────
  ipcMain.handle('check-listing', async (_event, { url, platform }) => {
    if (!url || !url.trim()) {
      return { success: false, error: 'No URL provided. Set a URL first.' };
    }

    try {
      console.log(`[Gemini] Checking listing: ${url} (${platform})`);

      // Step 1: Fetch the raw HTML
      const html = await fetchPageHtml(url);
      console.log(`[Gemini] Fetched ${html.length} chars of HTML`);

      // Step 2: Send to Gemini for live interpretation
      const result = await analyzeWithGemini(html, url, platform);
      console.log(`[Gemini] Analysis complete: ${result.signals?.length || 0} signals found`);

      return {
        success: true,
        title: result.title || null,
        signals: (result.signals || []).map((s, i) => ({
          id: `sig-${Date.now()}-${i}`,
          type: s.type || 'Info',
          description: s.description || '',
          severity: s.severity || 'info',
          timestamp: new Date().toLocaleTimeString(),
          read: false,
        })),
        checkedAt: new Date().toLocaleTimeString(),
      };
    } catch (error) {
      console.error('[Gemini] Check failed:', error.message);
      return {
        success: false,
        error: error.message,
      };
    }
  });
}
