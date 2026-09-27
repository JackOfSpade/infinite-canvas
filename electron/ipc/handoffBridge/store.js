import fs from 'node:fs';
import path from 'node:path';
import { isValidHostname, isValidPluginName } from '../../../src/utils/handoffBridgeConfig.js';

export const CONFIG_VERSION = 1;

const DEFAULT_LIMITS = Object.freeze({
  releaseTtlHours: 0,
  chatKeyMaxAgeHours: 0,
  idlePauseMinutes: 1440,
  jobsPerChat: 2,
  epochSoftBytes: 500_000,
  epochHardBytes: 900_000,
});
const LIMIT_KEYS = Object.freeze(Object.keys(DEFAULT_LIMITS));
const SOURCE_POLICIES = new Set(['enforce', 'alert', 'off']);

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
    pluginName: '',
    scope: { applications: true, scoring: false },
    autoStart: false,
    autoRelease: false,
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
  if (!isPlainObject(value)) return null;
  const limits = { ...DEFAULT_LIMITS };
  for (const key of LIMIT_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    const item = value[key];
    if (!Number.isFinite(item) || item < 0) return null;
    limits[key] = item;
  }
  if (!Number.isInteger(limits.jobsPerChat) || limits.jobsPerChat < 1 || limits.jobsPerChat > 3) return null;
  if (limits.epochSoftBytes > limits.epochHardBytes) return null;
  return limits;
}

function normalizeConfig(value) {
  if (!isPlainObject(value) || value.v !== CONFIG_VERSION) return null;
  const defaults = emptyConfig();
  const hostname = Object.hasOwn(value, 'hostname') ? value.hostname : defaults.hostname;
  const pluginName = Object.hasOwn(value, 'pluginName') ? value.pluginName : defaults.pluginName;
  const scope = Object.hasOwn(value, 'scope') ? value.scope : defaults.scope;
  const prefs = Object.hasOwn(value, 'prefs') ? value.prefs : defaults.prefs;
  const limits = normalizeLimits(value.limits);
  if ((hostname !== null && !isValidHostname(hostname))
      || (pluginName !== '' && !isValidPluginName(pluginName))
      || !isPlainObject(scope)
      || typeof scope.applications !== 'boolean'
      || typeof scope.scoring !== 'boolean'
      || !isPlainObject(prefs)
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
    pluginName,
    scope: { applications: scope.applications, scoring: scope.scoring },
    autoStart,
    autoRelease,
    limits,
    prefs: { sourcePolicy: prefs.sourcePolicy, pairingNetworkCheck: prefs.pairingNetworkCheck },
    telemetryInBugReports,
    consentVersion,
  });
}

// Reading is deliberately tolerant: a corrupted or unknown version does not
// get rewritten merely because the app launched.
export function readConfig(userDataPath, { fsImpl = fs } = {}) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(configPathFor(userDataPath), 'utf8'));
    const config = normalizeConfig(parsed);
    if (!config) return { config: emptyConfig(), state: 'unreadable' };
    return { config, state: 'ok' };
  } catch (error) {
    if (error?.code === 'ENOENT') return { config: emptyConfig(), state: 'missing' };
    return { config: emptyConfig(), state: 'unreadable' };
  }
}
