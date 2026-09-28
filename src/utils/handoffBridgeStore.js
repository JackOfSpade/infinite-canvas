import { EMPTY_BRIDGE_STATUS, normalizeBridgeStatus } from './handoffBridgeStatus.js';

let snapshot = EMPTY_BRIDGE_STATUS;
let listeners = new Set();
let references = 0;
let unsubscribeIpc = null;
let syncGeneration = 0;
let hasSnapshot = false;
let requestToken = 0;
let activeBridgeApi = null;

function apiFor(supplied) {
  try { return supplied || globalThis.window?.electronAPI || null; } catch { return null; }
}
function apiMethod(api, name) {
  try {
    const method = api?.[name];
    return typeof method === 'function' ? method : null;
  } catch {
    return null;
  }
}
function notify() { for (const listener of [...listeners]) { try { listener(); } catch { /* subscriber faults are isolated */ } } }

export function hasHandoffBridgeApi(api) { return Boolean(apiMethod(apiFor(api), 'handoffBridgeGetStatus')); }
// This is renderer-local state, not part of the frozen main-process snapshot.
// A missing initial snapshot means the preload is still being queried; it is
// deliberately distinct from an authoritative unavailable snapshot.
export function hasHandoffBridgeStatusSnapshot() { return hasSnapshot; }
export function getHandoffBridgeStatus() { return snapshot; }
export function subscribeHandoffBridgeStatus(listener) { if (typeof listener !== 'function') return () => {}; listeners.add(listener); return () => listeners.delete(listener); }
export function applyHandoffBridgeStatus(raw) {
  const next = normalizeBridgeStatus(raw);
  if (next === EMPTY_BRIDGE_STATUS || (hasSnapshot && next.seq <= snapshot.seq)) return snapshot;
  snapshot = next;
  hasSnapshot = true;
  invalidatePendingReplay();
  notify();
  return snapshot;
}

function invalidatePendingReplay() {
  // A later explicit replay must win over any older pending preload promise.
  requestToken += 1;
}

function isAuthoritativeStatus(raw) {
  try {
    const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const nullableScalarPaths = new Set(['availability.reason', 'chat.expiresInMs']);
    const hasStatusShape = (value, template, path = '') => {
      if (Array.isArray(template)) return Array.isArray(value);
      if (isRecord(template)) {
        if (!isRecord(value)) return false;
        return Object.keys(template).every(key => {
          const nextPath = path ? `${path}.${key}` : key;
          return Object.hasOwn(value, key) && hasStatusShape(value[key], template[key], nextPath);
        });
      }
      // A null in the frozen renderer sentinel is a deliberately nullable
      // status leaf. Its concrete value is normalized below; functions,
      // symbols and undefined are never status data.
      if (template === null) return value === null || ['string', 'number', 'boolean', 'object'].includes(typeof value);
      if (value === null) return nullableScalarPaths.has(path);
      if (typeof template === 'number') return Number.isSafeInteger(value) && value >= 0;
      return typeof value === typeof template;
    };
    if (!isRecord(raw) || raw.v !== 1
      || !Number.isSafeInteger(raw.seq) || raw.seq < 0
      || !Number.isSafeInteger(raw.at) || raw.at < 0
      || !hasStatusShape(raw, EMPTY_BRIDGE_STATUS)) return false;
    const records = [
      raw.availability, raw.config, raw.limits, raw.prefs, raw.setup, raw.tunnel,
      raw.link, raw.chat, raw.queue, raw.push, raw.counts, raw.windows, raw.power,
    ];
    if (records.some(value => !isRecord(value))) return false;
    const nestedRecords = [
      raw.config.scope, raw.tunnel.probe, raw.link.pairing, raw.link.progress,
      raw.link.unarmedRequests, raw.queue.applications, raw.queue.scoring,
      raw.counts.acceptedByStage,
    ];
    if (nestedRecords.some(value => !isRecord(value))) return false;
    const arrays = [raw.alarms, raw.link.sources, raw.chat.previous, raw.queue.jobs, raw.push.selectedHubs, raw.push.discovered];
    if (arrays.some(value => !Array.isArray(value))) return false;
    if (typeof raw.availability.ok !== 'boolean' || typeof raw.enabled !== 'boolean'
      || typeof raw.autoStart !== 'boolean' || typeof raw.autoRelease !== 'boolean'
      || typeof raw.paused !== 'boolean' || typeof raw.serving !== 'string'
      || typeof raw.config.scope.applications !== 'boolean' || typeof raw.config.scope.scoring !== 'boolean'
      || typeof raw.config.telemetryInBugReports !== 'boolean'
      || typeof raw.windows.canvasOpen !== 'boolean' || typeof raw.power.keepAwake !== 'boolean') return false;
    return normalizeBridgeStatus(raw) !== EMPTY_BRIDGE_STATUS;
  } catch {
    return false;
  }
}

function requestReplay(bridgeApi, generation) {
  if (generation !== syncGeneration || references === 0) return;
  const getStatus = apiMethod(bridgeApi, 'handoffBridgeGetStatus');
  if (!getStatus) return;
  const token = ++requestToken;
  Promise.resolve().then(() => getStatus.call(bridgeApi)).then(result => {
    if (token !== requestToken || generation !== syncGeneration || references === 0) return;
    const raw = result?.status ?? result;
    if (result?.success !== false && isAuthoritativeStatus(raw)) {
      invalidatePendingReplay();
      applyHandoffBridgeStatus(raw);
    }
  }).catch(() => {});
}

export function startHandoffBridgeStatusSync(api) {
  const bridgeApi = apiFor(api);
  references += 1;
  let stopped = false;
  const stopOnce = () => {
    if (stopped) return;
    stopped = true;
    stop();
  };
  if (references !== 1) return stopOnce;
  const generation = ++syncGeneration;
  activeBridgeApi = bridgeApi;
  // Subscribe before replay: an event racing getStatus cannot be lost.
  const subscribe = apiMethod(bridgeApi, 'onHandoffBridgeStatus');
  if (subscribe) {
    try {
      unsubscribeIpc = subscribe.call(bridgeApi, raw => {
        if (generation === syncGeneration && references > 0 && isAuthoritativeStatus(raw)) {
          invalidatePendingReplay();
          applyHandoffBridgeStatus(raw);
        }
      });
    } catch { unsubscribeIpc = null; }
  }
  requestReplay(bridgeApi, generation);
  return stopOnce;
}
export function retryHandoffBridgeStatusSync() {
  if (references === 0 || !activeBridgeApi) return false;
  requestReplay(activeBridgeApi, syncGeneration);
  return true;
}
function stop() {
  if (references === 0) return;
  references -= 1;
  if (references !== 0) return;
  try { if (typeof unsubscribeIpc === 'function') unsubscribeIpc(); } catch { /* optional preload cleanup */ }
  unsubscribeIpc = null;
  invalidatePendingReplay();
  activeBridgeApi = null;
  syncGeneration += 1;
}
export function __resetHandoffBridgeStoreForTests() { try { if (typeof unsubscribeIpc === 'function') unsubscribeIpc(); } catch { /* best-effort test reset */ } invalidatePendingReplay(); snapshot = EMPTY_BRIDGE_STATUS; listeners = new Set(); references = 0; unsubscribeIpc = null; hasSnapshot = false; activeBridgeApi = null; syncGeneration += 1; }
