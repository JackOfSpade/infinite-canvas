import Store from 'electron-store';
import electronPkg from 'electron';
import { handleSafe } from './ipcUtils.js';
import { normalizeMarketplaceWatchUrls } from '../../src/utils/marketplaceWatchUrls.js';
import { isValidCompensationExperienceBandLadder } from './jobCompensation.js';
import { logger } from '../logger.js';

const { BrowserWindow, safeStorage } = electronPkg;

// ── API-key encryption at rest ──────────────────────────────────────────────
// electron-store persists settings as plain JSON in userData — readable by
// any other local process/user/malware, or swept up whole by an unrelated
// "zip my userData for support" ask. safeStorage ties encryption to the OS
// user's own login (macOS Keychain / Windows DPAPI / Linux Secret Service),
// unlike electron-store's own `encryptionKey` option, which would just be a
// fixed string baked into the app — extractable from the bundle, so
// obfuscation rather than real protection.
//
// Encrypted values are stored as `ENC_PREFIX + base64(safeStorage output)` so
// a legacy plaintext value written before this change (or a value written
// while safeStorage was unavailable) is still readable — decryptSecret only
// attempts to decrypt strings carrying the prefix, everything else passes
// through as-is.
const ENC_PREFIX = 'safeStorage:v1:';
const JOBS_SECRET_KEYS = ['usajobsApiKey', 'diceApiKey'];

// Bootstrap Dice key: used until the app captures a live one from dice.com. It
// is ALSO the settings-schema default, so its presence in the store proves
// nothing — see hasStoredDiceApiKey.
const DICE_BOOTSTRAP_API_KEY = '1YAt0R9wBg4WfsF9VB2778F5CHLAPMVW3WAZcKd8';

export function encryptSecret(plain) {
  if (!plain || typeof plain !== 'string') return plain;
  // Already encrypted — return unchanged. Without this, update-settings'
  // shallow-merge (below) re-runs this over the RAW on-disk value for every
  // secret key in a section on EVERY save, even one that didn't touch the key
  // at all — double-encrypting it. decryptSecret only strips one ENC_PREFIX
  // layer, so a double-encrypted value "decrypts" to the literal
  // ENC_PREFIX-tagged ciphertext string instead of the real secret, silently
  // breaking the credential on the next unrelated settings change.
  if (plain.startsWith(ENC_PREFIX)) return plain;
  if (!safeStorage?.isEncryptionAvailable?.()) return plain; // e.g. some headless Linux — fall back to plaintext rather than block saving
  try {
    return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64');
  } catch (err) {
    logger.warn('[Settings] Failed to encrypt a secret field, storing as plaintext:', err?.message || err);
    return plain;
  }
}

// Memoized on the raw ciphertext string. getJobsSettings/getDiceApiKey are
// called from every API-source fetch — often several times per job search —
// and each miss hit the OS keychain/DPAPI/Secret Service
// (safeStorage.decryptString), not free in-process work. Safe with zero
// explicit invalidation: safeStorage encrypts with a fresh IV each call, so an
// actual credential change (re-encrypted by update-settings) always produces
// a NEW ciphertext string — a different Map key — while an untouched secret's
// ciphertext (preserved as-is by encryptSecret's idempotency guard) keeps
// hitting the same cached entry.
const decryptCache = new Map();

export function decryptSecret(stored) {
  if (typeof stored !== 'string' || !stored.startsWith(ENC_PREFIX)) return stored; // legacy plaintext, or not a string
  if (decryptCache.has(stored)) return decryptCache.get(stored);
  let result;
  try {
    result = safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'));
  } catch (err) {
    // Undecryptable (e.g. the userData folder was copied to a different
    // machine/user — safeStorage keys don't travel). Fail closed: an empty
    // key surfaces as "not configured" in the UI rather than crashing.
    logger.warn('[Settings] Failed to decrypt a secret field:', err?.message || err);
    result = '';
  }
  decryptCache.set(stored, result);
  return result;
}

function encryptSectionSecrets(keys, obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  for (const key of keys) {
    if (key in out) out[key] = encryptSecret(out[key]);
  }
  return out;
}

function decryptSectionSecrets(keys, obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  for (const key of keys) {
    if (key in out) out[key] = decryptSecret(out[key]);
  }
  return out;
}

// Broadcasts a payload to every alive renderer. Used so that nodes already
// mounted in the canvas can react to settings changes (e.g. clear "API key
// missing" errors) instead of requiring an app reload.
function broadcastToAllRenderers(channel, payload) {
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
      // Aggregate seller pages scanned by the Marketplace Status Module, keyed
      // by platformId: dashboards, notification centers, messages, sold-items
      // tabs, etc. Legacy per-listing checks also use them as extra evidence.
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
        diceApiKey: DICE_BOOTSTRAP_API_KEY,
      },
    },
  });

  // One-shot cleanup: the app dropped all live LLM API transport in favor of
  // the non-API human copy/paste handoff (see nonApiAi.js) — there is no more
  // key, model, or account credential to configure. A pre-existing install
  // may still have an `ai` section (possibly holding an encrypted key) and a
  // model quota-health cache left on disk from before this change; nothing
  // reads either anymore, so drop them silently rather than let stale
  // credential material linger on disk or let some other reader choke on a
  // shape it no longer expects. Never invents a replacement value; it only
  // deletes.
  try {
    if (_store.has('ai')) _store.delete('ai');
    if (_store.has('geminiModelRuntimeState')) _store.delete('geminiModelRuntimeState');
  } catch { /* never block startup on settings migration */ }

  return _store;
}

export function tryGetStore() {
  try {
    return getStore();
  } catch {
    return null;
  }
}

// The renderer's Settings UI round-trips the actual key value into an
// editable input (not a masked placeholder), so both get-settings and
// update-settings's return value must hand back DECRYPTED secrets — only
// the on-disk representation (what electron-store actually persists) is
// encrypted. IPC to the renderer is a much lower bar of trust than a
// plaintext file any other local process could read.
function decryptedStoreSnapshot(s) {
  const data = s.store;
  return {
    ...data,
    jobs: decryptSectionSecrets(JOBS_SECRET_KEYS, data.jobs),
  };
}

/**
 * Merge one `updates[section]` object onto the section's current stored
 * value — the core of update-settings' "shallow-merge per top-level section"
 * contract (a partial update, e.g. only one jobs field, must not wipe sibling
 * keys). Exported (pure, no store/encryption side effects) so this behavior
 * is directly unit-testable.
 */
export function mergeSettingsSection(section, current, value) {
  return { ...(current || {}), ...value };
}

export function registerSettingsHandlers() {
  handleSafe('get-settings', async () => {
    return decryptedStoreSnapshot(getStore());
  });

  // Shallow-merges per top-level section so a partial update (e.g. only
  // changing one jobs field) doesn't wipe sibling keys.
  handleSafe('update-settings', async (_event, updates) => {
    const s = getStore();
    for (const [section, value] of Object.entries(updates || {})) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        let merged = mergeSettingsSection(section, s.get(section), value);
        if (section === 'jobs') merged = encryptSectionSecrets(JOBS_SECRET_KEYS, merged);
        s.set(section, merged);
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
    return decryptedStoreSnapshot(s);
  });
}

/**
 * Per-source credentials for job-search APIs. USAJobs and Dice require keys;
 * the structure leaves room to add more sources without another getter.
 * Indeed needs none — it runs a real local Chrome (indeedBrowser.js), not a
 * scraping proxy. A Scrapfly key used to live here for an Indeed REST path that
 * no longer exists; it was removed because the bug report advertised it as a
 * missing Indeed dependency and sent every Indeed investigation down a dead end.
 * Falls back to process.env for back-compat with users still using the old
 * .env-based config (purely additive — UI-configured values take precedence).
 */
export function getJobsSettings() {
  const jobs = decryptSectionSecrets(JOBS_SECRET_KEYS, tryGetStore()?.get('jobs') || {});
  return {
    usajobsApiKey:  jobs.usajobsApiKey  || process.env.USAJOBS_API_KEY  || '',
    usajobsEmail:   jobs.usajobsEmail   || process.env.USAJOBS_EMAIL    || '',
  };
}

export function getDiceApiKey() {
  const stored = tryGetStore()?.get('jobs.diceApiKey');
  return decryptSecret(stored) || DICE_BOOTSTRAP_API_KEY;
}

/**
 * Has a LIVE Dice key been captured from dice.com, as opposed to the bootstrap
 * default baked in below?
 *
 * Two things make the obvious checks wrong, and both would put a falsehood in
 * the bug report. getDiceApiKey never returns empty, so truthiness on it is
 * always true. And the settings SCHEMA seeds `jobs.diceApiKey` with the
 * bootstrap value, so a fresh install already has a stored key — meaning
 * "is something stored?" is also always true. The only honest test is whether
 * the effective key DIFFERS from the bootstrap constant.
 */
export function hasStoredDiceApiKey() {
  const effective = decryptSecret(tryGetStore()?.get('jobs.diceApiKey'));
  return !!effective && effective !== DICE_BOOTSTRAP_API_KEY;
}

export function saveDiceApiKey(key) {
  if (typeof key === 'string' && key.length > 10) tryGetStore()?.set('jobs.diceApiKey', encryptSecret(key));
}

// Persistent cache of Glassdoor location → numeric locId (its search location
// FILTER is keyed by locId; the locKeyword text alone is ignored). A locId is a
// stable platform id (Denver = 1148170 forever), and resolving it requires a
// Cloudflare-gated, in-browser autocomplete call — so caching it means that
// lookup happens at most once per location, ever. Keyed by lowercased location.
//
// `country` records the ISO the live autocomplete result was VALIDATED against.
// It is what lets a country-scoped request (e.g. "Canada") be served from cache
// instead of re-resolving every run: without it the cached pair is just an
// opaque number that proves nothing about the market it selects. Entries written
// before this field existed have no `country` and are deliberately re-resolved,
// except for the exact Canada/US nation roots upgraded by manualScraper.
export function getGlassdoorLocId(locationKey) {
  const map = tryGetStore()?.get('jobs.glassdoorLocIds') || {};
  return map[String(locationKey || '').trim().toLowerCase()] || null;
}

/** Whole map, for diagnostics: which locations can skip the live lookup. */
export function getGlassdoorLocIdCache() {
  return tryGetStore()?.get('jobs.glassdoorLocIds') || {};
}

export function saveGlassdoorLocId(locationKey, value) {
  const key = String(locationKey || '').trim().toLowerCase();
  if (!key || !value?.locId) return;
  const store = tryGetStore();
  if (!store) return;
  const map = store.get('jobs.glassdoorLocIds') || {};
  const entry = { locId: String(value.locId), locT: value.locT || 'C' };
  if (typeof value.country === 'string' && /^[A-Z]{2}$/.test(value.country)) {
    entry.country = value.country;
    entry.verifiedAt = Date.now();
  }
  map[key] = entry;
  store.set('jobs.glassdoorLocIds', map);
}

// Persisted, compact role-family → experience-band research. Salary-market
// research needs a role-appropriate experience label; this cache keeps that
// grounded lookup from repeating for every job search or application restart.
// It is deliberately separate from location IDs because entries carry source
// provenance and a verification date rather than an opaque platform id.
function roleFamilyExperienceBandCacheKey(roleFamily) {
  return String(roleFamily || '').trim().toLowerCase().slice(0, 180);
}

/**
 * Copy persisted entries into a prototype-free dictionary. Role-family names
 * originate in listing/model data and valid JavaScript property names include
 * `__proto__` and `constructor`; a normal object would interpret those through
 * its prototype instead of as independent cache keys.
 */
export function normalizeRoleFamilyExperienceBandCache(raw) {
  const out = Object.create(null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) out[key] = value;
  return out;
}

export function getRoleFamilyExperienceBandCache() {
  return normalizeRoleFamilyExperienceBandCache(tryGetStore()?.get('jobs.roleFamilyExperienceBands'));
}

/** Prototype-safe lookup shared by the store-backed getter and pure tests. */
export function roleFamilyExperienceBandCacheEntry(cache, roleFamily) {
  const key = roleFamilyExperienceBandCacheKey(roleFamily);
  if (!key) return null;
  const normalized = normalizeRoleFamilyExperienceBandCache(cache);
  return Object.hasOwn(normalized, key) ? normalized[key] : null;
}

export function getRoleFamilyExperienceBands(roleFamily) {
  return roleFamilyExperienceBandCacheEntry(getRoleFamilyExperienceBandCache(), roleFamily);
}

export function saveRoleFamilyExperienceBands(roleFamily, value) {
  const key = roleFamilyExperienceBandCacheKey(roleFamily);
  if (!key || !value || typeof value !== 'object') return;
  const store = tryGetStore();
  if (!store) return;
  const bands = (Array.isArray(value.bands) ? value.bands : [])
    .map((band) => {
      const label = String(band?.label || '').trim().slice(0, 80);
      const minYears = Number(band?.minYears);
      const maxYears = band?.maxYears == null ? null : Number(band.maxYears);
      if (!label || !Number.isFinite(minYears) || minYears < 0 || (maxYears != null && (!Number.isFinite(maxYears) || maxYears < minYears))) return null;
      return { label, minYears, maxYears };
    })
    .filter(Boolean)
    .slice(0, 12);
  const sources = (Array.isArray(value.sources) ? value.sources : [])
    .map((source) => {
      const name = String(source?.name || source?.title || '').trim().slice(0, 160);
      const url = String(source?.url || source?.sourceUrl || '').trim();
      try {
        const parsed = new URL(url);
        if (!name || !/^https?:$/.test(parsed.protocol)) return null;
      } catch { return null; }
      return { name, url };
    })
    .filter(Boolean)
    .slice(0, 5);
  if (!isValidCompensationExperienceBandLadder(bands) || !sources.length) return;
  const map = getRoleFamilyExperienceBandCache();
  map[key] = {
    roleFamily: String(value.roleFamily || roleFamily).trim().slice(0, 180),
    bands,
    sources,
    verifiedDate: typeof value.verifiedDate === 'string' ? value.verifiedDate : new Date().toISOString(),
    ...(value.reusedFrom ? { reusedFrom: String(value.reusedFrom).trim().slice(0, 180) } : {}),
  };
  store.set('jobs.roleFamilyExperienceBands', map);
}

/**
 * Platform-wide hub pages (dashboard, notifications, etc.) configured through
 * Settings → Marketplace Monitors. Marketplace Status scans only these pages;
 * legacy per-listing checks use them as extra evidence alongside a listing URL.
 */
export function getMarketplaceWatchUrls(platformId) {
  if (!platformId) return [];
  const all = tryGetStore()?.get('marketplaceWatchUrls') || {};
  return normalizeMarketplaceWatchUrls(all[platformId]);
}
