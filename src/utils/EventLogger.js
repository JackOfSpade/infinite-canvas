/**
 * EventLogger — lightweight session event ring buffer.
 *
 * Records semantic user actions as timestamped strings.
 * Used by the Bug Report feature to reconstruct reproduction steps.
 *
 * Memory safety: enforces a 500 KB ring buffer (~6,000 lines).
 * At export time, the Bug Report handler budgets up to 500 KB for events
 * within the file (see electron/ipc/bugReport.js).
 *
 * Also auto-captures JS errors and unhandled promise rejections so they
 * appear in the event timeline alongside user actions.
 */
import { TIMINGS } from './timings.js';

const MAX_BYTES = 500 * 1024; // 500 KB — covers ~6,000 lines at avg 85 bytes/line.
// The entire useful event history for an immediate-report workflow is 20–50 lines;
// even a 1-hour heavy session generates <3,000 lines. 15 MB was 200× too large.

/**
 * Safe object-to-string for logging. Prevents JSON.stringify circular ref crashes.
 */
function safeStringify(obj) {
  if (obj instanceof Error) return obj.message;
  if (typeof obj !== 'object' || obj === null) return String(obj);
  try {
    return JSON.stringify(obj);
  } catch {
    // If it fails (likely circular or complex), fall back to basic type summary.
    // Wrap property access in try-catch in case 'obj' is a proxy that throws on access.
    try {
      if (Array.isArray(obj)) return `Array(${obj.length})`;
      const keys = Object.keys(obj);
      return `Object(${keys.slice(0, 5).join(',')}${keys.length > 5 ? '...' : ''})`;
    } catch {
      return 'Object(unreadable)';
    }
  }
}

class EventLoggerSingleton {
  constructor() {
    this.logs = [];
    this.currentBytes = 0;
    this.bootTimestamp = new Date().toISOString();
    this._lastMsg   = null;
    this._lastCount = 0;
    this._nodeStates = new Map();
    this._lastSaveError = null;
    this._installErrorCapture();
    this.log('Application started');
  }

  /**
   * Capture the most recent workspace save failure so it appears prominently
   * in bug reports. Without this, the actual reason (EACCES, ENOSPC, etc.)
   * was lost — only the generic "Save Failed" toast remained.
   */
  recordSaveError(reason, filePath) {
    this._lastSaveError = {
      reason: typeof reason === 'string' ? reason : safeStringify(reason),
      filePath: filePath || null,
      timestamp: new Date().toISOString(),
    };
    this.error('Save failed:', reason, filePath ? `(path=${filePath})` : '');
  }

  getLastSaveError() {
    return this._lastSaveError;
  }

  /**
   * Append a timestamped event to the log.
   * @param {string} message — Human-readable description of the event
   */
  log(message) {
    const now = new Date();
    const hms = now.toLocaleTimeString('en-US', { hour12: false });
    const ms  = String(now.getMilliseconds()).padStart(3, '0');
    const timestamp = `${hms}.${ms}`;

    // Deduplicate consecutive identical messages (e.g. ResizeObserver floods).
    // Instead of 40 identical lines, emit one line + a "(×N)" suffix when it stops.
    if (this._lastMsg === message) {
      this._lastCount++;
      // Replace the last entry in the ring with the updated count.
      if (this.logs.length > 0) {
        const prev = this.logs[this.logs.length - 1];
        const updated = prev.replace(/ \(×\d+\)$/, '') + ` (×${this._lastCount})`;
        this.currentBytes -= prev.length;
        this.logs[this.logs.length - 1] = updated;
        this.currentBytes += updated.length;
      }
      return;
    }
    this._lastMsg   = message;
    this._lastCount = 1;

    const entry = `[${timestamp}] ${message}`;

    this.logs.push(entry);
    this.currentBytes += entry.length;

    // Trim oldest entries if we exceed the memory ceiling
    while (this.currentBytes > MAX_BYTES && this.logs.length > 0) {
      this.currentBytes -= this.logs.shift().length;
    }
  }

  /** Returns all recorded events (chronological order, oldest first). */
  getLogs() {
    return this.logs;
  }

  /** Returns approximate in-memory byte count of the log buffer. */
  getByteCount() {
    return this.currentBytes;
  }

  // ── Component state registry ───────────────────────────────────────────────
  // CanvasNode / SellHubNode re-register via an effect whenever the snapshotted
  // fields change, so the bug report can capture "what was each node's React
  // state at the moment the user clicked Generate Report" — e.g. isEditing,
  // isResizing, edgeCursorStyle. Catches things the JSON application state doesn't expose.

  registerNodeState(id, state) {
    this._nodeStates.set(id, state);
  }

  /**
   * Append a timestamped error event to the log.
   * Accepts the same signature as console.error — a leading message string
   * and optional extra arguments (errors, objects) that are safe-stringified.
   * @param {string} message
   * @param {...any} args
   */
  error(message, ...args) {
    const extras = args.length ? ' ' + args.map(a => safeStringify(a)).join(' ') : '';
    this.log(`ERROR: ${message}${extras}`);
  }

  unregisterNodeState(id) {
    this._nodeStates.delete(id);
  }

  /** Returns a snapshot of all live CanvasNode component states. */
  getNodeStates() {
    return Array.from(this._nodeStates.entries()).map(([id, s]) => ({ id, ...s }));
  }

  /**
   * Install global error listeners so JS errors and unhandled promise
   * rejections automatically appear in the event timeline. This makes
   * bug reports show errors in context (e.g. "error thrown, then resize
   * jumped") without requiring manual try/catch everywhere.
   */
  _installErrorCapture() {
    if (typeof window === 'undefined') return;

    window.addEventListener('error', (e) => {
      const loc = e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno})` : '';
      this.log(`JS-ERROR: ${e?.message || String(e)}${loc}`);
    });

    window.addEventListener('unhandledrejection', (e) => {
      const msg = e.reason?.message || String(e.reason) || 'unknown rejection';
      this.log(`UNHANDLED-PROMISE: ${msg}`);
    });

    // Capture explicitly handled errors logged via console.error/warn
    const origError = console.error;
    console.error = (...args) => {
      const msg = args.map(a => safeStringify(a)).join(' ');
      this.log(`CONSOLE-ERROR: ${msg}`);
      origError.apply(console, args);
    };

    const origWarn = console.warn;
    console.warn = (...args) => {
      const msg = args.map(a => safeStringify(a)).join(' ');
      this.log(`CONSOLE-WARN: ${msg}`);
      origWarn.apply(console, args);
    };

    // Capture paste events to help debug clipboard-related issues
    window.addEventListener('paste', (e) => {
      const types = e.clipboardData?.types || [];
      const text = e.clipboardData?.getData('text/plain') || '';
      const summary = text.length > 50 ? text.slice(0, 50) + '...' : text;
      this.log(`PASTE: types=[${Array.from(types).join(',')}] text="${summary.replace(/\\n/g, '\\\\n')}"`);
    });

    // Capture settings changes to help diagnose configuration/API key updates
    const initSettingsListener = () => {
      if (window.electronAPI?.onSettingsChanged) {
        window.electronAPI.onSettingsChanged((payload) => {
          this.log(`SETTINGS-CHANGED: sections=[${payload?.changedSections?.join(', ') || 'none'}]`);
        });
        return true;
      }
      return false;
    };

    if (!initSettingsListener()) {
      const handle = setInterval(() => {
        if (initSettingsListener()) {
          clearInterval(handle);
        }
      }, TIMINGS.SETTINGS_LISTENER_POLL_MS);
      setTimeout(() => clearInterval(handle), TIMINGS.SETTINGS_LISTENER_GIVEUP_MS);
    }
  }
}

export const EventLogger = new EventLoggerSingleton();
