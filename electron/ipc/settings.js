import Store from 'electron-store';
import electronPkg from 'electron';
import fs from 'fs';
import { handleSafe } from './ipcUtils.js';
import { normalizeMarketplaceWatchUrls } from '../../src/utils/marketplaceWatchUrls.js';
import { isValidCompensationExperienceBandLadder } from './jobCompensation.js';
import { logger } from '../logger.js';

const { dialog, BrowserWindow, safeStorage } = electronPkg;

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
const AI_SECRET_KEYS = ['anthropicApiKey', 'geminiApiKey'];
const JOBS_SECRET_KEYS = ['usajobsApiKey', 'scrapflyApiKey', 'diceApiKey'];
const GEMINI_MODEL_RUNTIME_STATE_KEY = 'geminiModelRuntimeState';

// ── Claude live-group family selection ──────────────────────────────────────
// Mirrors llm.js's GROUP_DEFAULT_FAMILY and modelResolver's family tokens —
// duplicated here (not imported) rather than reused, to avoid a settings.js
// <-> llm.js import cycle: llm.js already imports getAISettings FROM this
// module to resolve which model serves each task, and modelResolver.js (the
// other place these tokens live) already imports getAISettings too. Family
// tokens are extremely low-churn (four tiers, added on the order of once a
// year), so the duplication cost is small next to the cycle it would create.
// Application generation is a Local AI handoff, so it has no API model family
// to configure. Keep only groups served by live Gemini/Claude API calls here.
// A legacy persisted `generation` key is deliberately dropped on read and on
// the next settings write because no live API route consumes it.
const CLAUDE_MODEL_GROUP_DEFAULTS = Object.freeze({ judgment: 'OPUS', extraction: 'SONNET', light: 'HAIKU' });
const VALID_CLAUDE_FAMILY_TOKENS = new Set(['FABLE', 'OPUS', 'SONNET', 'HAIKU']);
const VALID_AI_PROVIDERS = new Set(['gemini', 'claude']);

/**
 * Keep the API-provider setting forward-compatible and safe to consume.
 * Local AI used to be a selectable provider, but application generation now
 * uses its separate local handoff. An edited, legacy, or otherwise invalid
 * value falls back to Gemini instead of reaching an LLM dispatch path which
 * cannot serve it.
 */
export function normalizeAIProvider(value) {
  return VALID_AI_PROVIDERS.has(value) ? value : 'gemini';
}

/**
 * Validate + backfill the persisted `ai.claudeModels` for the live API task
 * groups. Legacy `generation` is intentionally omitted: application work is
 * now local-only, so carrying that picker into snapshots would imply it still
 * controls something. Invalid live values fall back to their own default.
 */
export function normalizeClaudeModels(raw) {
  // `analysis` was the pre-redesign catch-all. Preserve a non-default legacy
  // choice across both groups it split into; an old SONNET value is
  // indistinguishable from the old default, so it adopts the new defaults
  // (Judgment=Opus, Extraction=Sonnet) instead of silently weakening Judgment.
  const legacyAnalysis = VALID_CLAUDE_FAMILY_TOKENS.has(raw?.analysis) ? raw.analysis : null;
  const migratedLegacyChoice = legacyAnalysis && legacyAnalysis !== 'SONNET' ? legacyAnalysis : null;
  const out = {};
  for (const [group, def] of Object.entries(CLAUDE_MODEL_GROUP_DEFAULTS)) {
    const v = raw?.[group];
    out[group] = VALID_CLAUDE_FAMILY_TOKENS.has(v) ? v : (migratedLegacyChoice || def);
  }
  return out;
}

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

// Memoized on the raw ciphertext string. getAISettings/getJobsSettings/
// getDiceApiKey are called from every LLM helper and API-source fetch — often
// several times per job search/scoring batch — and each miss hit the OS
// keychain/DPAPI/Secret Service (safeStorage.decryptString), not free
// in-process work. Safe with zero explicit invalidation: safeStorage encrypts
// with a fresh IV each call, so an actual credential change (re-encrypted by
// update-settings) always produces a NEW ciphertext string — a different Map
// key — while an untouched secret's ciphertext (preserved as-is by
// encryptSecret's idempotency guard) keeps hitting the same cached entry.
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
        // Per-live-group Claude family. Application Generate is handled by
        // Local AI and therefore deliberately has no API model setting.
        claudeModels: { judgment: 'OPUS', extraction: 'SONNET', light: 'HAIKU' },
      },
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
        diceApiKey: '1YAt0R9wBg4WfsF9VB2778F5CHLAPMVW3WAZcKd8',
        // Scrapfly API key for Indeed scraping. Indeed's anti-bot is too strong
        // for Puppeteer alone; Scrapfly's ASP (anti-scraping protection) bypass
        // proxies through residential IPs + fingerprint spoofing. Get a key at
        // scrapfly.io — the Hobby plan is free for light usage.
        scrapflyApiKey: '',
      },
    },
  });

  // One-shot migrations: model selection moved from user-controlled to
  // per-task auto-selection in llm.js TASK_MODELS, and Local AI stopped being
  // an API-provider choice. Strip stale model fields and replace only the
  // legacy `provider: 'local'` value with Gemini. Spreading the stored object
  // preserves encrypted API keys and Claude group choices byte-for-byte.
  try {
    const ai = _store.get('ai') || {};
    const hasLegacyModel = 'claudeModel' in ai || 'geminiModel' in ai;
    const hasLegacyLocalProvider = ai.provider === 'local';
    if (hasLegacyModel || hasLegacyLocalProvider) {
      const { claudeModel: _drop1, geminiModel: _drop2, ...rest } = ai;
      _store.set('ai', {
        ...rest,
        ...(hasLegacyLocalProvider ? { provider: 'gemini' } : {}),
      });
    }
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

/**
 * Normalize the non-secret, credential-hash-scoped Gemini model-health cache.
 * Expired suppression and warning rows are discarded on read/write so a past
 * quota event cannot grow the settings file indefinitely or reappear after it
 * should have naturally cleared.
 */
export function normalizeGeminiModelRuntimeState(raw, now = Date.now()) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, record] of Object.entries(raw)) {
    if (typeof key !== 'string' || key.length === 0 || key.length > 1024 || !record || typeof record !== 'object') continue;
    const suppressedUntil = Number(record.suppressedUntil);
    const activeSuppression = Number.isFinite(suppressedUntil) && suppressedUntil > now ? suppressedUntil : null;
    const sourceRuntime = record.runtime;
    const warnUntil = Number(sourceRuntime?.warnUntil);
    const activeRuntime = sourceRuntime && typeof sourceRuntime === 'object'
      && Number.isFinite(warnUntil) && warnUntil > now
      && typeof sourceRuntime.model === 'string' && sourceRuntime.model.length > 0
      && typeof sourceRuntime.classification === 'string' && sourceRuntime.classification.length > 0
      ? {
          model: sourceRuntime.model.slice(0, 200),
          classification: sourceRuntime.classification.slice(0, 100),
          message: typeof sourceRuntime.message === 'string' ? sourceRuntime.message.slice(0, 300) : '',
          observedAt: Number.isFinite(Number(sourceRuntime.observedAt)) ? Number(sourceRuntime.observedAt) : now,
          suppressedUntil: activeSuppression,
          warnUntil,
        }
      : null;
    if (activeSuppression || activeRuntime) {
      out[key] = { ...(activeSuppression ? { suppressedUntil: activeSuppression } : {}), ...(activeRuntime ? { runtime: activeRuntime } : {}) };
    }
  }
  return out;
}

/** Read Gemini health state without exposing API-key material (keys are hashes). */
export function getGeminiModelRuntimeState() {
  return normalizeGeminiModelRuntimeState(tryGetStore()?.get(GEMINI_MODEL_RUNTIME_STATE_KEY));
}

/** Persist the complete, normalized Gemini model-health snapshot. */
export function saveGeminiModelRuntimeState(snapshot) {
  const store = tryGetStore();
  if (!store) return false;
  store.set(GEMINI_MODEL_RUNTIME_STATE_KEY, normalizeGeminiModelRuntimeState(snapshot));
  return true;
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
    // claudeModels goes through the same normalizeClaudeModels() as
    // getAISettings() — the renderer sees only live, valid API groups, never
    // a legacy application-generation token with no effect.
    ai: {
      ...decryptSectionSecrets(AI_SECRET_KEYS, data.ai),
      provider: normalizeAIProvider(data.ai?.provider),
      claudeModels: normalizeClaudeModels(data.ai?.claudeModels),
    },
    jobs: decryptSectionSecrets(JOBS_SECRET_KEYS, data.jobs),
  };
}

/**
 * Merge one `updates[section]` object onto the section's current stored
 * value — the core of update-settings' "shallow-merge per top-level section"
 * contract (a partial update, e.g. only `ai.serviceAccountPath`, must not
 * wipe sibling keys). Exported (pure, no store/encryption side effects) so
 * the nested-merge behavior below is directly unit-testable.
 *
 * `ai.claudeModels` is itself a {judgment,extraction,light} object.
 * SettingsPanel's updateAISetting/updateClaudeModelGroup send ONE changed
 * top-level `ai` key per call, so a single family-dropdown change arrives as
 * `{ claudeModels: { judgment: 'FABLE' } }`. A bare top-level shallow merge
 * (`{ ...current, ...value }`) would REPLACE `claudeModels` wholesale with
 * that partial object, silently dropping sibling groups back to
 * undefined — getAISettings() papers over it with defaults on the next read,
 * but the user's OTHER two picks would be gone, not just the one they
 * changed. Deep-merge this one nested key instead of trusting the top-level
 * shallow merge to handle it.
 */
export function mergeSettingsSection(section, current, value) {
  const merged = { ...(current || {}), ...value };
  if (section === 'ai') {
    // Normalize on every AI write, including an unrelated credential update.
    // That makes a legacy persisted `generation` selection self-cleaning
    // without treating a read as a surprising disk mutation.
    const requestedModels = value?.claudeModels && typeof value.claudeModels === 'object'
      ? value.claudeModels
      : {};
    merged.claudeModels = normalizeClaudeModels({
      ...normalizeClaudeModels(current?.claudeModels),
      ...requestedModels,
    });
  }
  return merged;
}

export function registerSettingsHandlers() {
  handleSafe('get-settings', async () => {
    return decryptedStoreSnapshot(getStore());
  });

  // Shallow-merges per top-level section so a partial update (e.g. only
  // changing `ai.serviceAccountPath`) doesn't wipe sibling keys — see
  // mergeSettingsSection() for the one nested exception (ai.claudeModels).
  handleSafe('update-settings', async (_event, updates) => {
    const s = getStore();
    for (const [section, value] of Object.entries(updates || {})) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        let merged = mergeSettingsSection(section, s.get(section), value);
        if (section === 'ai') {
          // Provider is a small closed enum. Normalize at the persistence
          // boundary too, rather than merely making renderer snapshots look
          // valid while a malformed on-disk setting continues to exist.
          merged.provider = normalizeAIProvider(merged.provider);
          merged = encryptSectionSecrets(AI_SECRET_KEYS, merged);
        }
        else if (section === 'jobs') merged = encryptSectionSecrets(JOBS_SECRET_KEYS, merged);
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
  const ai = decryptSectionSecrets(AI_SECRET_KEYS, tryGetStore()?.get('ai') || {});
  // Every caller (every LLM call in the app) needs a fully-populated,
  // validated claudeModels — see normalizeClaudeModels()'s doc for why a
  // raw/missing/corrupted value can't just pass through here.
  return {
    ...ai,
    provider: normalizeAIProvider(ai.provider),
    claudeModels: normalizeClaudeModels(ai.claudeModels),
  };
}

/**
 * Per-source credentials for job-search APIs. USAJobs and Scrapfly/Indeed
 * require keys; the structure leaves room to add more sources without another getter.
 * Falls back to process.env for back-compat with users still using the old
 * .env-based config (purely additive — UI-configured values take precedence).
 */
export function getJobsSettings() {
  const jobs = decryptSectionSecrets(JOBS_SECRET_KEYS, tryGetStore()?.get('jobs') || {});
  return {
    usajobsApiKey:  jobs.usajobsApiKey  || process.env.USAJOBS_API_KEY  || '',
    usajobsEmail:   jobs.usajobsEmail   || process.env.USAJOBS_EMAIL    || '',
    scrapflyApiKey: jobs.scrapflyApiKey || process.env.SCRAPFLY_API_KEY || '',
  };
}

export function getDiceApiKey() {
  const stored = tryGetStore()?.get('jobs.diceApiKey');
  return decryptSecret(stored) || '1YAt0R9wBg4WfsF9VB2778F5CHLAPMVW3WAZcKd8';
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
