import { useSyncExternalStore } from 'react';
import { getHandoffBridgeStatus, subscribeHandoffBridgeStatus } from '../utils/handoffBridgeStore.js';

export function useHandoffBridgeStatus() {
  return useSyncExternalStore(subscribeHandoffBridgeStatus, getHandoffBridgeStatus, getHandoffBridgeStatus);
}
