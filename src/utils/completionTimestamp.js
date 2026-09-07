/**
 * Normalize the durable completion timestamp stored on Job Search hubs.
 *
 * Older canvases may hold a decimal-integer string, so those remain compatible.
 * Hexadecimal and exponent forms are intentionally not accepted as persisted
 * timestamp encodings. All other coercions are deliberately refused: `Number(null)` and
 * `Number(false)` both produce plausible-looking epoch values even though no
 * completion was recorded.
 */
export function normalizeCompletionTimestamp(value) {
  let timestamp;
  if (typeof value === 'number') {
    timestamp = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    timestamp = Number(trimmed);
  } else {
    return null;
  }

  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) return null;
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? timestamp : null;
}

export function formatCompletionTimestamp(value, locales = undefined) {
  const timestamp = normalizeCompletionTimestamp(value);
  if (timestamp == null) return null;
  return new Date(timestamp).toLocaleString(locales, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function completionTimestampIso(value) {
  const timestamp = normalizeCompletionTimestamp(value);
  return timestamp == null ? null : new Date(timestamp).toISOString();
}
