/**
 * Robust UUID generator that works reliably across secure and non-secure contexts.
 * In environments like custom local-file:// protocols where window.crypto might be
 * restricted, this safely falls back to a math-based UUID v4 implementation.
 */
export function generateId() {
  if (typeof window !== 'undefined' && window.crypto && window.crypto.randomUUID) {
    try {
      return window.crypto.randomUUID();
    } catch {
      // Fallback if randomUUID throws (e.g. strict CSP or context errors)
    }
  }
  // Fallback UUID v4 generator

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}
