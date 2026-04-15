/**
 * EventLogger — lightweight session event ring buffer.
 *
 * Records semantic user actions as timestamped strings.
 * Used by the Bug Report feature to reconstruct reproduction steps.
 *
 * Memory safety: enforces a generous 15 MB internal ceiling.
 * At export time, the Bug Report handler dynamically budgets how many
 * events fit within the 10 MB file cap (see electron/ipc/bugReport.js).
 *
 * Also auto-captures JS errors and unhandled promise rejections so they
 * appear in the event timeline alongside user actions.
 */

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB internal ceiling

class EventLoggerSingleton {
  constructor() {
    this.logs = [];
    this.currentBytes = 0;
    this.bootTimestamp = new Date().toISOString();
    this._installErrorCapture();
    this.log('Application started');
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
      this._lastCount = (this._lastCount || 1) + 1;
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
  // CanvasNode instances call registerNodeState on every render so the bug
  // report can snapshot "what was each node's React state at the moment the
  // user clicked Generate Report" — e.g. isEditing, isResizing, edgeCursorStyle.
  // This catches things the JSON application state (Zustand) doesn't expose.

  registerNodeState(id, state) {
    if (!this._nodeStates) this._nodeStates = new Map();
    this._nodeStates.set(id, state);
  }

  unregisterNodeState(id) {
    this._nodeStates?.delete(id);
  }

  /** Returns a snapshot of all live CanvasNode component states. */
  getNodeStates() {
    if (!this._nodeStates) return [];
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
      this.log(`JS-ERROR: ${e.message}${loc}`);
    });

    window.addEventListener('unhandledrejection', (e) => {
      const msg = e.reason?.message || String(e.reason) || 'unknown rejection';
      this.log(`UNHANDLED-PROMISE: ${msg}`);
    });
  }
}

export const EventLogger = new EventLoggerSingleton();
