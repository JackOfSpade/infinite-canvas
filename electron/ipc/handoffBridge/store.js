import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONSTANTS } from './constants.js';
import { isValidHostname, isValidPluginName } from '../../../src/utils/handoffBridgeConfig.js';

export const CONFIG_VERSION = 1;

const DEFAULT_LIMITS = Object.freeze({
  releaseTtlHours: 0,
  chatKeyMaxAgeHours: 0,
  idlePauseMinutes: 1440,
  jobsPerChat: 2,
  epochSoftBytes: 0,
  epochHardBytes: 0,
});
const LIMIT_KEYS = Object.freeze(Object.keys(DEFAULT_LIMITS));
const SOURCE_POLICIES = new Set(['enforce', 'alert', 'off']);
const CONFIG_FIELDS = new Set([
  'hostname', 'pluginName', 'scope', 'autoStart', 'autoRelease', 'limits',
  'prefs', 'telemetryInBugReports', 'consentVersion',
]);
const PERSISTED_CONFIG_FIELDS = new Set(['v', ...CONFIG_FIELDS]);
const PATCH_FIELDS = new Set([...CONFIG_FIELDS, 'confirmBreak']);
const SCOPE_FIELDS = new Set(['applications', 'scoring', 'marketplace']);
const PREFS_FIELDS = new Set(['sourcePolicy', 'pairingNetworkCheck']);
// Config mutations share one queue per file. Forget must run behind an already
// accepted save, otherwise a delayed save could recreate setup after Forget.
const configQueues = new Map();

function freezeConfig(config) {
  Object.freeze(config.scope);
  Object.freeze(config.limits);
  Object.freeze(config.prefs);
  return Object.freeze(config);
}

export function configPathFor(userDataPath) {
  return path.join(userDataPath, 'handoff-bridge', 'config.json');
}

export function emptyConfig() {
  return freezeConfig({
    v: CONFIG_VERSION,
    hostname: null,
    pluginName: 'infinite_canvas',
    // A fresh bridge is ready for every reviewed, text-only handoff family.
    // Existing persisted `false` values remain explicit opt-outs when read.
    scope: { applications: true, scoring: true, marketplace: true },
    autoStart: true,
    // This controls newly created application bundles only. Reviewed push hubs
    // have a separate main-owned auto-selection policy and explicit opt-outs.
    autoRelease: true,
    limits: { ...DEFAULT_LIMITS },
    prefs: { sourcePolicy: 'enforce', pairingNetworkCheck: true },
    telemetryInBugReports: false,
    consentVersion: 0,
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeLimits(value) {
  if (value === undefined) return { ...DEFAULT_LIMITS };
  if (!ownKeysAre(value, new Set(LIMIT_KEYS))) return null;
  const limits = { ...DEFAULT_LIMITS };
  for (const key of LIMIT_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    const item = value[key];
    if (!Number.isSafeInteger(item) || item < 0) return null;
    limits[key] = item;
  }
  // These two exact values were historical invisible defaults: there was no
  // settings control that let a person choose them. Treat an existing pair as
  // a migration to the new opt-in rollover policy, while preserving any
  // deliberately different positive safety budget.
  if (limits.epochSoftBytes === 500_000 && limits.epochHardBytes === 900_000) {
    limits.epochSoftBytes = DEFAULT_LIMITS.epochSoftBytes;
    limits.epochHardBytes = DEFAULT_LIMITS.epochHardBytes;
  }
  if (!Number.isInteger(limits.jobsPerChat) || limits.jobsPerChat < CONSTANTS.JOBS_PER_CHAT_MIN || limits.jobsPerChat > CONSTANTS.JOBS_PER_CHAT_MAX) return null;
  if (limits.epochSoftBytes > limits.epochHardBytes) return null;
  return limits;
}

function normalizeConfig(value) {
  if (!ownKeysAre(value, PERSISTED_CONFIG_FIELDS) || value.v !== CONFIG_VERSION) return null;
  const defaults = emptyConfig();
  const hostname = Object.hasOwn(value, 'hostname') ? value.hostname : defaults.hostname;
  const pluginName = Object.hasOwn(value, 'pluginName') ? value.pluginName : defaults.pluginName;
  const rawScope = Object.hasOwn(value, 'scope') ? value.scope : defaults.scope;
  const prefs = Object.hasOwn(value, 'prefs') ? value.prefs : defaults.prefs;
  const limits = normalizeLimits(value.limits);
  // A real stored config can predate a scope field that was added later (the
  // way an older v1 config predates consentVersion or telemetryInBugReports
  // above). ownKeysAre only refuses an *unknown* key; a scope missing
  // marketplace is not malformed, it is a legacy shape. Fill each missing
  // sub-field from the default here, the same way every top-level field above
  // does, so a two-key {applications, scoring} scope survives instead of
  // rejecting the whole config. Such a legacy config cannot auto-start until
  // the current consent version is accepted, so the newly disclosed default
  // cannot expose marketplace work under an old receipt.
  const scope = isPlainObject(rawScope) ? {
    applications: Object.hasOwn(rawScope, 'applications') ? rawScope.applications : defaults.scope.applications,
    scoring: Object.hasOwn(rawScope, 'scoring') ? rawScope.scoring : defaults.scope.scoring,
    marketplace: Object.hasOwn(rawScope, 'marketplace') ? rawScope.marketplace : defaults.scope.marketplace,
  } : rawScope;
  if ((hostname !== null && !isValidHostname(hostname))
      || (pluginName !== '' && !isValidPluginName(pluginName))
      || !ownKeysAre(rawScope, SCOPE_FIELDS)
      || typeof scope.applications !== 'boolean'
      || typeof scope.scoring !== 'boolean'
      || typeof scope.marketplace !== 'boolean'
      || !ownKeysAre(prefs, PREFS_FIELDS)
      || !SOURCE_POLICIES.has(prefs.sourcePolicy)
      || typeof prefs.pairingNetworkCheck !== 'boolean'
      || !limits) return null;
  const autoStart = Object.hasOwn(value, 'autoStart') ? value.autoStart : defaults.autoStart;
  const autoRelease = Object.hasOwn(value, 'autoRelease') ? value.autoRelease : defaults.autoRelease;
  const telemetryInBugReports = Object.hasOwn(value, 'telemetryInBugReports')
    ? value.telemetryInBugReports
    : defaults.telemetryInBugReports;
  const consentVersion = Object.hasOwn(value, 'consentVersion') ? value.consentVersion : defaults.consentVersion;
  if (typeof autoStart !== 'boolean' || typeof autoRelease !== 'boolean'
      || typeof telemetryInBugReports !== 'boolean'
      || !Number.isInteger(consentVersion) || consentVersion < 0) return null;
  return freezeConfig({
    v: CONFIG_VERSION,
    hostname,
    // Older v1 configs allowed an empty name. Resolve it on read instead of
    // asking the chat-start path to handle a value the starter rejects.
    pluginName: pluginName || defaults.pluginName,
    scope: { applications: scope.applications, scoring: scope.scoring, marketplace: scope.marketplace },
    autoStart,
    autoRelease,
    limits,
    prefs: { sourcePolicy: prefs.sourcePolicy, pairingNetworkCheck: prefs.pairingNetworkCheck },
    telemetryInBugReports,
    consentVersion,
  });
}

function ownKeysAre(value, allowed) {
  return isPlainObject(value) && Object.keys(value).every(key => allowed.has(key));
}

function fieldError(fieldErrors, field, code = 'FORMAT') {
  fieldErrors[field] = code;
}

function mergePatch(current, patch) {
  if (!isPlainObject(patch)) return { fieldErrors: { patch: 'FORMAT' } };
  const fieldErrors = {};
  for (const key of Object.keys(patch)) {
    if (!PATCH_FIELDS.has(key)) fieldError(fieldErrors, key, 'UNKNOWN');
  }
  if (Object.keys(fieldErrors).length) return { fieldErrors };

  const next = {
    v: CONFIG_VERSION,
    hostname: current.hostname,
    pluginName: current.pluginName,
    scope: { ...current.scope },
    autoStart: current.autoStart,
    autoRelease: current.autoRelease,
    limits: { ...current.limits },
    prefs: { ...current.prefs },
    telemetryInBugReports: current.telemetryInBugReports,
    consentVersion: current.consentVersion,
  };

  if (Object.hasOwn(patch, 'hostname')) {
    if (patch.hostname !== null && !isValidHostname(patch.hostname)) fieldError(fieldErrors, 'hostname');
    else next.hostname = patch.hostname;
  }
  if (Object.hasOwn(patch, 'pluginName')) {
    if (patch.pluginName !== '' && !isValidPluginName(patch.pluginName)) fieldError(fieldErrors, 'pluginName');
    else next.pluginName = patch.pluginName;
  }
  if (Object.hasOwn(patch, 'scope')) {
    if (!ownKeysAre(patch.scope, SCOPE_FIELDS)) fieldError(fieldErrors, 'scope');
    else {
      for (const key of SCOPE_FIELDS) {
        if (Object.hasOwn(patch.scope, key)) {
          if (typeof patch.scope[key] !== 'boolean') fieldError(fieldErrors, `scope.${key}`);
          else next.scope[key] = patch.scope[key];
        }
      }
    }
  }
  for (const key of ['autoStart', 'autoRelease', 'telemetryInBugReports']) {
    if (Object.hasOwn(patch, key)) {
      if (typeof patch[key] !== 'boolean') fieldError(fieldErrors, key);
      else next[key] = patch[key];
    }
  }
  if (Object.hasOwn(patch, 'limits')) {
    if (!ownKeysAre(patch.limits, new Set(LIMIT_KEYS))) fieldError(fieldErrors, 'limits');
    else {
      for (const key of LIMIT_KEYS) {
        if (!Object.hasOwn(patch.limits, key)) continue;
        const value = patch.limits[key];
        if (!Number.isSafeInteger(value) || value < 0) fieldError(fieldErrors, `limits.${key}`);
        else next.limits[key] = value;
      }
      // The range lives in constants.js; repeating the numbers here is how the
      // two drift apart and a legal value starts being rejected on save.
      if (!Number.isInteger(next.limits.jobsPerChat)
          || next.limits.jobsPerChat < CONSTANTS.JOBS_PER_CHAT_MIN
          || next.limits.jobsPerChat > CONSTANTS.JOBS_PER_CHAT_MAX) fieldError(fieldErrors, 'limits.jobsPerChat');
      if (next.limits.epochSoftBytes > next.limits.epochHardBytes) fieldError(fieldErrors, 'limits');
    }
  }
  if (Object.hasOwn(patch, 'prefs')) {
    if (!ownKeysAre(patch.prefs, PREFS_FIELDS)) fieldError(fieldErrors, 'prefs');
    else {
      if (Object.hasOwn(patch.prefs, 'sourcePolicy')) {
        if (!SOURCE_POLICIES.has(patch.prefs.sourcePolicy)) fieldError(fieldErrors, 'prefs.sourcePolicy');
        else next.prefs.sourcePolicy = patch.prefs.sourcePolicy;
      }
      if (Object.hasOwn(patch.prefs, 'pairingNetworkCheck')) {
        if (typeof patch.prefs.pairingNetworkCheck !== 'boolean') fieldError(fieldErrors, 'prefs.pairingNetworkCheck');
        else next.prefs.pairingNetworkCheck = patch.prefs.pairingNetworkCheck;
      }
    }
  }
  if (Object.hasOwn(patch, 'consentVersion')) {
    if (!Number.isSafeInteger(patch.consentVersion) || patch.consentVersion < 0) fieldError(fieldErrors, 'consentVersion');
    else next.consentVersion = patch.consentVersion;
  }
  if (Object.keys(fieldErrors).length) return { fieldErrors };
  return { config: freezeConfig(next) };
}

function callFs(fsImpl, method, ...args) {
  if (typeof fsImpl[method] !== 'function') return undefined;
  return fsImpl[method](...args);
}

function assertSafeExistingConfig(fsImpl, filePath) {
  if (typeof fsImpl.lstatSync !== 'function') return true;
  try {
    const stat = fsImpl.lstatSync(filePath);
    return stat.isFile();
  } catch (error) {
    return error?.code === 'ENOENT';
  }
}

function atomicWriteConfig(filePath, config, { fsImpl, randomBytes }) {
  const directory = path.dirname(filePath);
  let fd;
  let temporaryPath;
  try {
    callFs(fsImpl, 'mkdirSync', directory, { recursive: true, mode: 0o700 });
    callFs(fsImpl, 'chmodSync', directory, 0o700);
    if (!assertSafeExistingConfig(fsImpl, filePath)) throw Object.assign(new Error('unsafe config'), { code: 'EUNSAFE' });
    const encoded = Buffer.from(`${JSON.stringify(config)}\n`);
    for (let attempt = 0; attempt < 8; attempt++) {
      temporaryPath = path.join(directory, `.config.${process.pid}.${randomBytes(12).toString('hex')}.tmp`);
      try {
        fd = fsImpl.openSync(temporaryPath, 'wx', 0o600);
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST' || attempt === 7) throw error;
      }
    }
    let offset = 0;
    while (offset < encoded.length) {
      const written = fsImpl.writeSync(fd, encoded, offset, encoded.length - offset, offset);
      if (!Number.isInteger(written) || written < 1) throw Object.assign(new Error('short config write'), { code: 'EWRITE' });
      offset += written;
    }
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd);
    fd = undefined;
    fsImpl.renameSync(temporaryPath, filePath);
    temporaryPath = undefined;
    callFs(fsImpl, 'chmodSync', filePath, 0o600);
    // fsyncing the containing directory makes the rename durable on filesystems
    // that support it; a compact fake filesystem need not expose this operation.
    const directoryFd = callFs(fsImpl, 'openSync', directory, fs.constants.O_RDONLY);
    if (directoryFd !== undefined) {
      try { callFs(fsImpl, 'fsyncSync', directoryFd); }
      finally { callFs(fsImpl, 'closeSync', directoryFd); }
    }
    return true;
  } finally {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch { /* best-effort cleanup */ }
    }
    if (temporaryPath) {
      try { fsImpl.unlinkSync(temporaryPath); } catch { /* never mask the write error */ }
    }
  }
}

function enqueueConfigMutation(filePath, operation) {
  const previous = configQueues.get(filePath) || Promise.resolve();
  const mutation = previous.catch(() => undefined).then(operation);
  const settled = mutation.finally(() => {
    if (configQueues.get(filePath) === settled) configQueues.delete(filePath);
  });
  configQueues.set(filePath, settled);
  return settled;
}

function fsyncConfigDirectory(filePath, fsImpl) {
  // Small injected filesystem fakes need not model directory descriptors. A
  // real implementation that exposes both calls must make the unlink durable.
  if (typeof fsImpl.openSync !== 'function' || typeof fsImpl.fsyncSync !== 'function') return;
  const directoryFd = fsImpl.openSync(path.dirname(filePath), fs.constants.O_RDONLY);
  try {
    fsImpl.fsyncSync(directoryFd);
  } finally {
    if (typeof fsImpl.closeSync === 'function') fsImpl.closeSync(directoryFd);
  }
}

function forgetConfigFile(filePath, fsImpl) {
  try {
    // lstat, rather than stat, makes a symlink an explicit refusal. Do not
    // attempt an unlink if the target is anything other than a regular file.
    if (typeof fsImpl.lstatSync !== 'function' || typeof fsImpl.unlinkSync !== 'function') return false;
    let stat;
    try {
      stat = fsImpl.lstatSync(filePath);
    } catch (error) {
      return error?.code === 'ENOENT';
    }
    if (stat.isSymbolicLink?.() || typeof stat.isFile !== 'function' || !stat.isFile()) return false;
    fsImpl.unlinkSync(filePath);
    fsyncConfigDirectory(filePath, fsImpl);
    return true;
  } catch {
    return false;
  }
}

// Reading is deliberately tolerant: a corrupted or unknown version does not
// get rewritten merely because the app launched.
export function readConfig(userDataPath, { fsImpl = fs } = {}) {
  try {
    if (!assertSafeExistingConfig(fsImpl, configPathFor(userDataPath))) {
      return { config: emptyConfig(), state: 'unreadable' };
    }
    const parsed = JSON.parse(fsImpl.readFileSync(configPathFor(userDataPath), 'utf8'));
    const config = normalizeConfig(parsed);
    if (!config) return { config: emptyConfig(), state: 'unreadable' };
    return { config, state: 'ok' };
  } catch (error) {
    if (error?.code === 'ENOENT') return { config: emptyConfig(), state: 'missing' };
    return { config: emptyConfig(), state: 'unreadable' };
  }
}

/**
 * Persist a user-approved configuration patch. Confirmation is deliberately an
 * injected capability: the store has no Electron or renderer dependency and
 * cannot silently treat a renderer value as a native approval.
 */
export function writeConfig(userDataPath, patch, {
  fsImpl = fs,
  linked = false,
  isLinked = null,
  // A caller may need its write to be conditional on the exact config which
  // earned a native confirmation.  Run the predicate inside this serialized
  // mutation, immediately after the authoritative read, so a queued hostname
  // change cannot have an earlier sheet bless its replacement configuration.
  isCurrentConfig = null,
  // The composition layer owns the closed definition of disclosure-relevant
  // config. Compare it in this queue so a changed configuration and the
  // retirement of an old receipt are one atomic durable mutation.
  isConsentConfigChanged = null,
  confirmHostnameChange = async () => false,
  randomBytes = crypto.randomBytes,
} = {}) {
  const filePath = configPathFor(userDataPath);
  return enqueueConfigMutation(filePath, async () => {
    const loaded = readConfig(userDataPath, { fsImpl });
    if (loaded.state === 'unreadable') return { ok: false, code: 'STATE_UNREADABLE' };
    if (typeof isCurrentConfig === 'function') {
      let current = false;
      try { current = isCurrentConfig(loaded.config) === true; } catch { current = false; }
      if (!current) return { ok: false, code: 'CONSENT_STALE' };
    }
    const merged = mergePatch(loaded.config, patch);
    if (merged.fieldErrors) return { ok: false, code: 'INVALID', fieldErrors: merged.fieldErrors };

    let consentConfigChanged = false;
    if (typeof isConsentConfigChanged === 'function') {
      try { consentConfigChanged = isConsentConfigChanged(loaded.config, merged.config) === true; }
      catch { return { ok: false, code: 'STATE_UNREADABLE' }; }
    }
    // A v2 receipt never survives a change to the disclosure fingerprint.
    // The UI cannot patch consentVersion, but the cleared receipt is still
    // persisted here rather than in a later, separately queued write.
    const nextConfig = consentConfigChanged && merged.config.consentVersion !== 0
      ? freezeConfig({ ...merged.config, consentVersion: 0 })
      : merged.config;

    const hostnameChanged = nextConfig.hostname !== loaded.config.hostname;
    // The linked fact is security-sensitive and this callback is serialized.
    // Resolve an injected synchronous checker here, not before a caller waits
    // behind another config mutation. A checker failure is fail-closed.
    const linkedNow = () => {
      if (typeof isLinked !== 'function') return linked === true;
      try { return isLinked() !== false; } catch { return true; }
    };
    if (hostnameChanged && linkedNow() && patch.confirmBreak !== true) {
      return { ok: false, code: 'LINK_WOULD_BREAK' };
    }
    if (hostnameChanged) {
      let confirmed = false;
      try { confirmed = await confirmHostnameChange({ previous: loaded.config.hostname, next: merged.config.hostname }); }
      catch { confirmed = false; }
      if (confirmed !== true) return { ok: false, code: 'DECLINED' };
    }

    try {
      // The native hostname confirmation is asynchronous. Check the live
      // linked state again in the same turn immediately before the sync write.
      if (hostnameChanged && linkedNow() && patch.confirmBreak !== true) {
        return { ok: false, code: 'LINK_WOULD_BREAK' };
      }
      atomicWriteConfig(filePath, nextConfig, { fsImpl, randomBytes });
      return { ok: true, config: nextConfig, consentConfigChanged };
    } catch {
      return { ok: false, code: 'STATE_UNREADABLE' };
    }
  });
}

/**
 * Remove only the user-approved setup config. This intentionally does not
 * touch tunnel state, OAuth state, ledgers, lanes, or the containing directory.
 */
export function forgetConfig(userDataPath, { fsImpl = fs } = {}) {
  let filePath;
  try {
    filePath = configPathFor(userDataPath);
  } catch {
    return Promise.resolve(false);
  }
  return enqueueConfigMutation(filePath, () => forgetConfigFile(filePath, fsImpl));
}
