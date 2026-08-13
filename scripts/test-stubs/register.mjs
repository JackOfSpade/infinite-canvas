// Entry point for `node --import`: registers the electron/electron-store
// stub loader before scripts/test-runner.js's own imports resolve.
import * as nodeModule from 'node:module';
import { resolve } from './loader.mjs';

if (typeof nodeModule.registerHooks === 'function') {
  nodeModule.registerHooks({ resolve });
} else {
  nodeModule.register('./loader.mjs', import.meta.url);
}
