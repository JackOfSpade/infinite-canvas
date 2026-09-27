import { EMPTY_BRIDGE_STATUS, normalizeBridgeStatus } from './handoffBridgeStatus.js';

let snapshot = EMPTY_BRIDGE_STATUS;
let listeners = new Set();
let references = 0;
let unsubscribeIpc = null;
let syncGeneration = 0;
let hasSnapshot = false;

const apiFor = supplied => supplied || globalThis.window?.electronAPI;
function notify() { for (const listener of [...listeners]) { try { listener(); } catch { /* subscriber faults are isolated */ } } }

export function hasHandoffBridgeApi(api) { return typeof apiFor(api)?.handoffBridgeGetStatus === 'function'; }
export function getHandoffBridgeStatus() { return snapshot; }
export function subscribeHandoffBridgeStatus(listener) { if (typeof listener !== 'function') return () => {}; listeners.add(listener); return () => listeners.delete(listener); }
export function applyHandoffBridgeStatus(raw) {
  const next = normalizeBridgeStatus(raw);
  if (next === EMPTY_BRIDGE_STATUS || (hasSnapshot && next.seq <= snapshot.seq)) return snapshot;
  snapshot = next;
  hasSnapshot = true;
  notify();
  return snapshot;
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
  // Subscribe before replay: an event racing getStatus cannot be lost.
  const subscribe = bridgeApi?.onHandoffBridgeStatus;
  if (typeof subscribe === 'function') {
    try {
      unsubscribeIpc = subscribe.call(bridgeApi, raw => {
        if (generation === syncGeneration && references > 0) applyHandoffBridgeStatus(raw);
      });
    } catch { unsubscribeIpc = null; }
  }
  const getStatus = bridgeApi?.handoffBridgeGetStatus;
  if (typeof getStatus === 'function') {
    Promise.resolve().then(() => getStatus.call(bridgeApi)).then(result => {
      if (generation !== syncGeneration || references === 0) return;
      if (result?.success === false) return;
      applyHandoffBridgeStatus(result?.status ?? result);
    }).catch(() => {});
  }
  return stopOnce;
}
function stop() {
  if (references === 0) return;
  references -= 1;
  if (references !== 0) return;
  try { if (typeof unsubscribeIpc === 'function') unsubscribeIpc(); } catch { /* optional preload cleanup */ }
  unsubscribeIpc = null;
  syncGeneration += 1;
}
export function __resetHandoffBridgeStoreForTests() { try { if (typeof unsubscribeIpc === 'function') unsubscribeIpc(); } catch { /* best-effort test reset */ } snapshot = EMPTY_BRIDGE_STATUS; listeners = new Set(); references = 0; unsubscribeIpc = null; hasSnapshot = false; syncGeneration += 1; }
