/**
 * EventLogger — lightweight session event ring buffer.
 *
 * Records semantic user actions as timestamped strings.
 * Used by the Bug Report feature to reconstruct reproduction steps.
 *
 * Memory safety: enforces a generous 15 MB internal ceiling.
 * At export time, the Bug Report handler dynamically budgets how many
 * events fit within the 10 MB file cap (see electron/ipc/bugReport.js).
 */

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB internal ceiling

class EventLoggerSingleton {
  constructor() {
    this.logs = [];
    this.currentBytes = 0;
    this.bootTimestamp = new Date().toISOString();
    this.log('Application started');
  }

  /**
   * Append a timestamped event to the log.
   * @param {string} message — Human-readable description of the event
   */
  log(message) {
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
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
}

export const EventLogger = new EventLoggerSingleton();
