import { useSyncExternalStore } from 'react';
import { getHandoffBridgeStatus, subscribeHandoffBridgeStatus } from '../utils/handoffBridgeStore.js';
import { bridgeHeldKey } from '../utils/bridgeHeldApplication.js';

// The bridge-held key for one job (see bridgeHeldKey). Reads the shared status
// store, so it adds no IPC; and because the snapshot is a primitive, a job card
// re-renders only when its own held state changes, not on every status push.
export function useBridgeHeldKey(jobId) {
  return useSyncExternalStore(
    subscribeHandoffBridgeStatus,
    () => bridgeHeldKey(getHandoffBridgeStatus(), jobId),
    () => null,
  );
}
