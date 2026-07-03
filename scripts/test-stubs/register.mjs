// Entry point for `node --import`: registers the electron/electron-store
// stub loader before scripts/test-runner.js's own imports resolve.
import { register } from 'node:module';

register('./loader.mjs', import.meta.url);
