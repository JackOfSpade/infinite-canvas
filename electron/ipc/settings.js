import Store from 'electron-store';
import electronPkg from 'electron';
import fs from 'fs';
import { handleSafe } from './ipcUtils.js';

const { dialog, BrowserWindow } = electronPkg;

// Broadcasts a payload to every alive renderer. Used so that nodes already
// mounted in the canvas can react to settings changes (e.g. clear "API key
// missing" errors) instead of requiring an app reload.
export function broadcastToAllRenderers(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

// Lazy-initialized: `new Store()` calls `app.getPath('userData')` which requires
// the Electron app to be ready. Creating the store at module evaluation time
// (before app.whenReady()) causes electron-store v11 to throw "Please specify
// the `projectName` option" because `defaultCwd` is undefined at that point.
// All callers of `store` go through `getStore()` which defers init until first use.
let _store = null;
function getStore() {
  if (_store) return _store;
  _store = new Store({
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
      // Per-source credentials for job-search APIs that require keys. Used by
      // electron/ipc/jobs.js fetchApiSources. Storing here (vs .env) lets the
      // user configure via the Settings UI and persists across sessions.
      jobs: {
        usajobsApiKey: '',
        usajobsEmail: '',
        // Dice's internal API key (extracted from their web app). Auto-refreshed
        // when the app detects a 500 from dhigroupinc.com — this default is the
        // bootstrap value used until a live key is captured from dice.com.
        diceApiKey: '1YAt0R9wBg4WfsF9VB2778F5CHLAPMVW3WAZcKd8',
        // Scrapfly API key for Indeed scraping. Indeed's anti-bot is too strong
        // for Puppeteer alone; Scrapfly's ASP (anti-scraping protection) bypass
        // proxies through residential IPs + fingerprint spoofing. Get a key at
        // scrapfly.io — the Hobby plan is free for light usage.
        scrapflyApiKey: '',
      },
    },
  });

  // One-shot migration: model selection moved from user-controlled to
  // per-task auto-selection in llm.js TASK_MODELS. Strip the persisted
  // `claudeModel` / `geminiModel` so they don't show up in get-settings
  // payloads (which would confuse renderers that still display them) and
  // can't be accidentally re-read by any new code path. Safe even when the
  // fields are already absent.
  try {
    const ai = _store.get('ai') || {};
    if ('claudeModel' in ai || 'geminiModel' in ai) {
      const { claudeModel: _drop1, geminiModel: _drop2, ...rest } = ai;
      _store.set('ai', rest);
    }
  } catch { /* never block startup on settings migration */ }

  return _store;
}

function tryGetStore() {
  try {
    return getStore();
  } catch {
    return null;
  }
}

export function registerSettingsHandlers() {
  handleSafe('get-settings', async () => {
    return getStore().store;
  });

  // Shallow-merges per top-level section so a partial update (e.g. only
  // changing `ai.serviceAccountPath`) doesn't wipe sibling keys.
  handleSafe('update-settings', async (_event, updates) => {
    const s = getStore();
    for (const [section, value] of Object.entries(updates || {})) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        s.set(section, { ...(s.get(section) || {}), ...value });
      } else {
        s.set(section, value);
      }
    }
    // Tell every renderer the settings just changed so live nodes can react
    // (clear "key missing" errors, etc.) without an app reload.
    // We deliberately send only `changedSections` — not the values — so keys
    // never round-trip through extra channels.
    broadcastToAllRenderers('settings-changed', {
      changedSections: Object.keys(updates || {}),
    });
    return s.store;
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
  return tryGetStore()?.get('ai') || {};
}

/**
 * Per-source credentials for job-search APIs. USAJobs and Scrapfly/Indeed
 * require keys; the structure leaves room to add more sources without another getter.
 * Falls back to process.env for back-compat with users still using the old
 * .env-based config (purely additive — UI-configured values take precedence).
 */
export function getJobsSettings() {
  const jobs = tryGetStore()?.get('jobs') || {};
  return {
    usajobsApiKey:  jobs.usajobsApiKey  || process.env.USAJOBS_API_KEY  || '',
    usajobsEmail:   jobs.usajobsEmail   || process.env.USAJOBS_EMAIL    || '',
    scrapflyApiKey: jobs.scrapflyApiKey || process.env.SCRAPFLY_API_KEY || '',
  };
}

export function getDiceApiKey() {
  return tryGetStore()?.get('jobs.diceApiKey') || '1YAt0R9wBg4WfsF9VB2778F5CHLAPMVW3WAZcKd8';
}

export function saveDiceApiKey(key) {
  if (typeof key === 'string' && key.length > 10) tryGetStore()?.set('jobs.diceApiKey', key);
}

/**
 * Watch URLs configured for a given platform's status check. The listing's
 * own URL is always checked separately by the caller; this returns the
 * platform-wide extras (dashboard, notifications, etc.) the user has added
 * via Settings → Marketplace.
 */
export function getMarketplaceWatchUrls(platformId) {
  if (!platformId) return [];
  const all = tryGetStore()?.get('marketplaceWatchUrls') || {};
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
