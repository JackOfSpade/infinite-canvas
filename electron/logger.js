/**
 * Centralized logging utility for the main process.
 * Suppresses info/debug logs in production to prevent spam.
 * Errors and warnings are always logged.
 *
 * Also captures the last N entries in an in-memory ring buffer. The bug
 * report harness reads this buffer so a "the IPC silently failed" report
 * actually shows the [Accounts] / [StealthBrowser] / etc. lines that
 * normally only land in the terminal stdout (which the user almost never
 * has open). Each entry is { ts, level, message }.
 *
 * Deliberately electron-free: `process.defaultApp` is true only when running
 * unpackaged from source (set directly by Electron on the global `process`,
 * no import needed) and is otherwise equivalent to `app.isPackaged` being
 * false. Avoiding the `electron` import here keeps this module — and every
 * file that only needs it for logging — usable from plain Node (e.g. the
 * unit test runner) without requiring a real Electron binary.
 */
const isProd = typeof process !== 'undefined' && !process.defaultApp;

const RING_BUFFER_SIZE = 200;
const ringBuffer = [];

function formatArg(a) {
  if (a == null) return String(a);
  if (typeof a === 'string') return a;
  if (a instanceof Error) return `${a.message}${a.stack ? '\n' + a.stack : ''}`;
  try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
  catch { return String(a); }
}

function pushRing(level, args) {
  ringBuffer.push({
    ts: Date.now(),
    level,
    message: args.map(formatArg).join(' '),
  });
  if (ringBuffer.length > RING_BUFFER_SIZE) ringBuffer.shift();
}

export function getRecentLogs(limit = RING_BUFFER_SIZE) {
  const start = Math.max(0, ringBuffer.length - limit);
  return ringBuffer.slice(start);
}

export const logger = {
  info: (...args) => {
    pushRing('info', args);
    if (!isProd) {
      console.log(...args);
    }
  },
  debug: (...args) => {
    pushRing('debug', args);
    if (!isProd) {
      console.debug(...args);
    }
  },
  warn: (...args) => {
    pushRing('warn', args);
    console.warn(...args);
  },
  error: (...args) => {
    pushRing('error', args);
    console.error(...args);
  }
};

export default logger;
