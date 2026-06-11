/**
 * Lazy, failure-tolerant electron-store facade — the shared pattern behind the
 * telemetry stores (scrape-budgets, scrape-verification, token-budgets).
 *
 * Lazy-initialized because `new Store()` calls `app.getPath('userData')`, which
 * requires the Electron app to be ready; module-level construction runs before
 * app.whenReady() and makes electron-store v11 throw ("Please specify the
 * `projectName` option"). Construction is deferred to first use, and if it
 * still fails (e.g. plain-node test runner) reads return undefined and writes
 * are dropped — right for learned telemetry, wrong for critical user data.
 */
import Store from 'electron-store';

export function lazyStore(name) {
  let store = null;
  const tryGet = () => {
    try { return store ??= new Store({ name }); } catch { return null; }
  };
  return {
    get: (...args) => tryGet()?.get(...args),
    set: (...args) => tryGet()?.set(...args),
  };
}
