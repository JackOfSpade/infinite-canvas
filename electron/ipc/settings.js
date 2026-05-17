import Store from 'electron-store';
import electronPkg from 'electron';
import fs from 'fs';
import { handleSafe } from './ipcUtils.js';

const { dialog, BrowserWindow } = electronPkg;

// Broadcasts a payload to every alive renderer. Used so that nodes already
// mounted in the canvas can react to settings changes (e.g. clear "API key
// missing" errors, surface a "re-analyze with real AI" CTA on stale mock data)
// instead of requiring an app reload.
function broadcastToAllRenderers(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

const store = new Store({
  defaults: {
    ai: {
      provider: 'gemini',
      geminiModel: 'gemini-2.5-flash',
      claudeModel: 'claude-3-5-sonnet-latest',
      anthropicApiKey: '',
      geminiApiKey: '',
      // Absolute path to a Google service-account JSON. When set, takes
      // precedence over the legacy `process.cwd()/service-account.json`
      // lookup, so the user can keep the file anywhere on disk and reuse
      // it across canvases without copying.
      serviceAccountPath: '',
    },
  },
});

export function registerSettingsHandlers() {
  handleSafe('get-settings', async () => {
    return store.store;
  });

  // Shallow-merges per top-level section so a partial update (e.g. only
  // changing `ai.serviceAccountPath`) doesn't wipe sibling keys.
  handleSafe('update-settings', async (_event, updates) => {
    for (const [section, value] of Object.entries(updates || {})) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        store.set(section, { ...(store.get(section) || {}), ...value });
      } else {
        store.set(section, value);
      }
    }
    // Tell every renderer the settings just changed so live nodes can react
    // (drop mock data, clear "key missing" errors, etc.) without an app reload.
    // We deliberately send only `changedSections` — not the values — so keys
    // never round-trip through extra channels.
    broadcastToAllRenderers('settings-changed', {
      changedSections: Object.keys(updates || {}),
    });
    return store.store;
  });

  // Native file picker for the service-account JSON. Returns the chosen
  // absolute path (or null if the user canceled). The renderer is responsible
  // for then calling update-settings to persist it.
  handleSafe('pick-service-account-file', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Select Google service-account.json',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePaths?.[0]) return { path: null };
    return { path: filePaths[0] };
  });
}

export function getAISettings() {
  return store.get('ai');
}

/**
 * Resolves the active service-account.json path:
 *   1. Explicit user-configured path in settings (preferred).
 *   2. Legacy `process.cwd()/service-account.json` (back-compat for repo dev).
 * Returns null if neither exists or is readable.
 */
export function resolveServiceAccountPath() {
  const ai = getAISettings() || {};
  const candidates = [
    ai.serviceAccountPath,
    `${process.cwd()}/service-account.json`,
  ].filter(Boolean);
  for (const p of candidates) {
    try { fs.accessSync(p, fs.constants.R_OK); return p; } catch { /* try next */ }
  }
  return null;
}
