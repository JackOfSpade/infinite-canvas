// Node module-resolution hook: redirects bare 'electron' and 'electron-store'
// imports to the stubs in this directory. Registered via register.mjs, which
// is loaded with `node --import` before scripts/test-runner.js runs.
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const STUBS = {
  electron: pathToFileURL(path.join(here, 'electron.mjs')).href,
  'electron-store': pathToFileURL(path.join(here, 'electron-store.mjs')).href,
};

export async function resolve(specifier, context, nextResolve) {
  if (Object.prototype.hasOwnProperty.call(STUBS, specifier)) {
    return { url: STUBS[specifier], shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
