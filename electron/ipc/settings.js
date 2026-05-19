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
      anthropicApiKey: '',
      geminiApiKey: '',
      // Absolute path to a Google service-account JSON. When set, takes
      // precedence over the legacy `process.cwd()/service-account.json`
      // lookup, so the user can keep the file anywhere on disk and reuse
      // it across canvases without copying.
      serviceAccountPath: '',
    },
    // Extra URLs to scrape during a marketplace listing status check, keyed
    // by platformId. The listing's own URL is always checked; these are
    // platform-wide "places the status might surface" — the seller dashboard,
    // notifications center, sold-items tab. AI classification of each URL
    // runs in parallel and the strongest signal wins, which is what makes
    // the system robust to "the SOLD notification lives in the activity feed,
    // not on the listing page yet."
    marketplaceWatchUrls: {},
  },
});

// One-shot migration: model selection moved from user-controlled to
// per-task auto-selection in llm.js TASK_MODELS. Strip the persisted
// `claudeModel` / `geminiModel` so they don't show up in get-settings
// payloads (which would confuse renderers that still display them) and
// can't be accidentally re-read by any new code path. Safe even when the
// fields are already absent.
try {
  const ai = store.get('ai') || {};
  if ('claudeModel' in ai || 'geminiModel' in ai) {
    const { claudeModel: _drop1, geminiModel: _drop2, ...rest } = ai;
    store.set('ai', rest);
  }
} catch { /* never block startup on settings migration */ }

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
 * Watch URLs configured for a given platform's status check. The listing's
 * own URL is always checked separately by the caller; this returns the
 * platform-wide extras (dashboard, notifications, etc.) the user has added
 * via Settings → Marketplace.
 */
export function getMarketplaceWatchUrls(platformId) {
  if (!platformId) return [];
  const all = store.get('marketplaceWatchUrls') || {};
  const list = all[platformId];
  return Array.isArray(list) ? list.filter(u => typeof u === 'string' && u.trim().length > 0) : [];
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
