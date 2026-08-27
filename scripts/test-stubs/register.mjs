// Entry point for `node --import`: registers the electron/electron-store
// stub loader before scripts/test-runner.js's own imports resolve.
import * as nodeModule from 'node:module';
import { resolve } from './loader.mjs';
import { blockUnexpectedNetworkRequest } from './networkGuard.mjs';

// Unit tests must be deterministic and must never spend a real provider/API
// request. Individual tests that exercise a transport replace this guard with
// a purpose-built fake and restore it in `finally`, so an unmocked request is
// an actionable test failure rather than a flaky network dependency. The
// separate `test:job-apis` availability probe remains intentionally live; set
// IC_TEST_ALLOW_NETWORK=1 only when a deliberate integration test needs to
// bypass the unit-runner guard.
const isUnitRunner = /(?:^|[\\/])test-runner\.js$/.test(String(process.argv[1] || ''));
if (isUnitRunner && process.env.IC_TEST_ALLOW_NETWORK !== '1') {
  globalThis.fetch = async (input) => blockUnexpectedNetworkRequest(input);
}

if (typeof nodeModule.registerHooks === 'function') {
  nodeModule.registerHooks({ resolve });
} else {
  nodeModule.register('./loader.mjs', import.meta.url);
}
