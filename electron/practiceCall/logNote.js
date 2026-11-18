/**
 * Best-effort log lines for the practice call. A logging fault never reaches the call.
 * `logNote` prefixes the line and uses info when the logger has it, else warn; `logWarn`
 * writes the message as given to warn only.
 */
export function logNote(logger, message) {
  try { (logger?.info ?? logger?.warn)?.call(logger, `[PracticeCall] ${message}`); } catch { /* logging is best effort */ }
}

export function logWarn(logger, message) {
  try { logger?.warn?.(message); } catch { /* logging is best effort */ }
}
