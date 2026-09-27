import { assert } from './testHelpers.js';
import { CONSTANTS } from '../../electron/ipc/handoffBridge/constants.js';

export default [{
  name: 'handoff bridge: controls: B0 pins the security and scheduling constants',
  run: () => {
    assert(CONSTANTS.MCP_AUTH_INFLIGHT === 24 && CONSTANTS.MCP_BODY_READ === 8, 'authenticated pool sizes must stay pinned');
    assert(CONSTANTS.ANON_BODY_READ === 3 && CONSTANTS.ANON_GET_INFLIGHT === 16, 'anonymous pools must stay isolated and pinned');
    assert(CONSTANTS.OAUTH_BODY_CAP_BYTES === 8 * 1024 && CONSTANTS.MAX_CONNECTIONS === 256, 'OAuth cap and server capacity must remain bounded');
    assert(CONSTANTS.KEEP_ALIVE_TIMEOUT_MS === 65_000 && CONSTANTS.INGRESS_KEEP_ALIVE_TIMEOUT_MS === 30_000, 'origin keep-alive must exceed tunnel ingress keep-alive');
    assert(CONSTANTS.REFRESH_IDLE_MS === 3 * 24 * 60 * 60_000 && CONSTANTS.REFRESH_ABSOLUTE_MS === 14 * 24 * 60 * 60_000, 'refresh lifetimes must stay 3d idle and 14d absolute');
    assert(CONSTANTS.IDLE_PAUSE_MINUTES === 1440 && CONSTANTS.KEEP_AWAKE_ENABLED === false, 'idle pause and keep-awake defaults must remain explicit');
  },
}];
