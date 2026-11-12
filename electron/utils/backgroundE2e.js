/**
 * The full Electron smoke test has a hidden, non-activating renderer. Keep
 * every native UI / OS-handoff boundary behind this one explicit opt-in flag
 * so a test run cannot steal desktop focus or launch another application.
 */
export function isBackgroundE2E(env = process.env) {
  return env?.INFINITE_CANVAS_E2E_BACKGROUND === '1';
}

export const BACKGROUND_E2E_DISABLED_CODE = 'BACKGROUND_E2E_DISABLED';

// Headless Chromium normally exits much sooner, but its owned profile may need
// up to 12 seconds to release during shutdown. Keep this finite so a wedged
// browser cannot make the background smoke process linger indefinitely.
export const BACKGROUND_E2E_SHUTDOWN_TIMEOUT_MS = 15_000;

/** A stable error for a headed browser action intentionally blocked in smoke mode. */
export function backgroundE2EDisabledError(operation) {
  const error = new Error(`${operation} is disabled during the background Electron smoke test.`);
  error.code = BACKGROUND_E2E_DISABLED_CODE;
  return error;
}

/**
 * Close background-smoke resources without involving a renderer or native UI.
 *
 * This deliberately takes its dependencies as callbacks so the sequencing and
 * timeout can be covered by the deterministic unit runner without importing
 * Electron's main process. Start all close operations together: the background
 * mode refuses every headed-auth launch, and this guarantees a bad/slow closer
 * cannot prevent the independent page pool or loopback server from stopping.
 */
export async function runBackgroundE2EShutdownCleanup({
  closeAllAuthWindows,
  closeAllPages,
  closeStealthBrowser,
  stopApplicationSyncServer,
  timeoutMs = BACKGROUND_E2E_SHUTDOWN_TIMEOUT_MS,
} = {}) {
  const cleanup = Promise.allSettled([
    Promise.resolve().then(() => closeAllAuthWindows()),
    Promise.resolve().then(() => closeAllPages()),
    Promise.resolve().then(() => closeStealthBrowser(true)),
    Promise.resolve().then(() => stopApplicationSyncServer()),
  ]);

  let timeoutId = null;
  let timedOut = false;
  try {
    await Promise.race([
      cleanup,
      new Promise(resolve => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          resolve();
        }, Math.max(0, Number(timeoutMs) || 0));
      }),
    ]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
  return { timedOut };
}
