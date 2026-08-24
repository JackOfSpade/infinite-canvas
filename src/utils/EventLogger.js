/**
 * EventLogger — lightweight session event ring buffer.
 *
 * Records semantic user actions as timestamped strings.
 * Used by the Bug Report feature to reconstruct reproduction steps.
 *
 * Memory safety: enforces a 500 KB ring buffer (~6,000 lines). File export
 * preserves that captured ring in full; clipboard export applies its own
 * character budget (see electron/ipc/bugReport.js).
 *
 * Also auto-captures JS errors and unhandled promise rejections so they
 * appear in the event timeline alongside user actions.
 */
import { TIMINGS } from './timings.js';

const MAX_BYTES = 500 * 1024; // 500 KB — covers ~6,000 lines at avg 85 bytes/line.
// The entire useful event history for an immediate-report workflow is 20–50 lines;
// even a 1-hour heavy session generates <3,000 lines. 15 MB was 200× too large.

// String#length counts UTF-16 code units, not UTF-8 bytes. Bug reports are
// exported as UTF-8, so use the same unit for the in-memory ceiling and the
// downstream file budget. Keep one encoder for the session because logging can
// happen on hot paths such as ResizeObserver updates.
const textEncoder = new TextEncoder();
export function utf8ByteLength(value) {
  return textEncoder.encode(String(value)).byteLength;
}

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
    this._resizeRun = null;
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

    // Any other event ends an in-progress resize run (see logNodeResize).
    this._resizeRun = null;

    // Deduplicate consecutive identical messages (e.g. ResizeObserver floods).
    // Instead of 40 identical lines, emit one line + a "(×N)" suffix when it stops.
    if (this._lastMsg === message) {
      this._lastCount++;
      // Replace the last entry in the ring with the updated count.
      if (this.logs.length > 0) {
        const prev = this.logs[this.logs.length - 1];
        this._replaceLastEntry(prev.replace(/ \(×\d+\)$/, '') + ` (×${this._lastCount})`);
      }
      return;
    }
    this._lastMsg   = message;
    this._lastCount = 1;

    const entry = `[${timestamp}] ${message}`;

    this.logs.push(entry);
    this.currentBytes += utf8ByteLength(entry);

    // Trim oldest entries if we exceed the memory ceiling
    while (this.currentBytes > MAX_BYTES && this.logs.length > 0) {
      this.currentBytes -= utf8ByteLength(this.logs.shift());
    }
  }

  /** Overwrite the newest ring entry, keeping the byte accounting honest. */
  _replaceLastEntry(line) {
    const prev = this.logs[this.logs.length - 1];
    this.currentBytes -= utf8ByteLength(prev);
    this.logs[this.logs.length - 1] = line;
    this.currentBytes += utf8ByteLength(line);

    // A coalesced resize line grows as its frame count/span is updated. Keep
    // replacement writes subject to the same ring limit as appended entries.
    while (this.currentBytes > MAX_BYTES && this.logs.length > 0) {
      this.currentBytes -= utf8ByteLength(this.logs.shift());
    }
  }

  /**
   * Record a node dimension change, collapsing a consecutive run of frames for
   * the SAME node into one line.
   *
   * React Flow's ResizeObserver reports content-driven auto-height one frame at
   * a time, so a single hub node settling from 139px to 100px wrote ~40 lines,
   * each differing by a pixel or two. The generic (×N) dedup above can't touch
   * those — every message is unique — so they filled over half of a bug report's
   * retained event budget and pushed 104 genuinely useful older events out of
   * the clipboard export. The diagnostic signal is the SPAN ("it shrank 139→100
   * over 22 frames"), never the intermediate pixels.
   *
   * The line keeps the run's FIRST timestamp so it stays ordered against its
   * neighbours, matching how (×N) dedup behaves.
   */
  logNodeResize(id, width, height) {
    const dim = v => (Number.isFinite(v) ? Math.round(v) : v);
    const w = dim(width);
    const h = dim(height);
    const run = this._resizeRun;

    if (run && run.id === id && this.logs[this.logs.length - 1] === run.line) {
      run.count++;
      run.w = w;
      run.h = h;
      this._replaceLastEntry(this._formatResizeRun(run));
      run.line = this.logs[this.logs.length - 1];
      return;
    }

    this.log(`node resized id=${id} w=${w} h=${h}`);
    const line = this.logs[this.logs.length - 1];
    this._resizeRun = {
      id, count: 1, fromW: w, fromH: h, w, h, line,
      prefix: (line.match(/^\[[^\]]*\]\s/) || [''])[0],
    };
    // The run owns this line now — keep (×N) dedup from rewriting it too.
    this._lastMsg = null;
  }

  _formatResizeRun(run) {
    const spans = [];
    if (run.fromW !== run.w) spans.push(`w ${run.fromW}→${run.w}`);
    if (run.fromH !== run.h) spans.push(`h ${run.fromH}→${run.h}`);
    const detail = spans.length ? `, ${spans.join(', ')}` : '';
    return `${run.prefix}node resized id=${run.id} w=${run.w} h=${run.h} (×${run.count}${detail})`;
  }

  /** Returns all recorded events (chronological order, oldest first). */
  getLogs() {
    return this.logs;
  }

  /** Returns the UTF-8 byte count of the log buffer. */
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

    // Capture focus entering a form control so the timeline shows WHICH field
    // the user was interacting with when something went wrong — e.g. a native
    // date/select popup flickering shut while a background task re-renders the
    // node. Pairs with task-timing sections (startup verify, etc.) to place the
    // interaction next to concurrent churn. Low-volume: fires once when focus
    // enters a field (not per keystroke); consecutive repeats collapse via dedup.
    window.addEventListener('focusin', (e) => {
      const el = e.target;
      if (!el || typeof el.tagName !== 'string') return;
      const tag = el.tagName.toLowerCase();
      if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return;
      const kind = tag === 'input' ? (el.getAttribute('type') || 'text') : tag;
      const label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
      const nodeId = el.closest?.('.react-flow__node')?.getAttribute('data-id') || '';
      this.log(`[Focus] ${kind}${label ? ` "${label.slice(0, 40)}"` : ''}${nodeId ? ` node=${nodeId.slice(0, 8)}` : ''}`);
    });

    // Capture paste metadata to help debug clipboard-related issues without
    // retaining pasted content (which may contain passwords, tokens, or other
    // sensitive user data) in a bug-report timeline.
    window.addEventListener('paste', (e) => {
      const types = e.clipboardData?.types || [];
      const text = e.clipboardData?.getData('text/plain') || '';
      this.log(`PASTE: types=[${Array.from(types).join(',')}] textLength=${text.length}`);
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
