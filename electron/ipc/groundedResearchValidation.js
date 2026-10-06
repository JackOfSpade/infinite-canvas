// Raw grounded-research handoffs intentionally stay as text because their
// citations and excerpts feed a separate, structured assessment step. Keep a
// small explicit validation contract on that text: it is both the bridge's
// default-deny eligibility signal and protection against silently truncating
// evidence before the assessment can inspect it.
export function validateGroundedResearchText(value, { maxChars = 120_000 } = {}) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
    throw new TypeError('Grounded research maxChars must be a positive integer.');
  }
  if (typeof value !== 'string' || !value.trim()) {
    const error = new Error('Grounded research must be non-empty text.');
    error.code = 'VALIDATION_FAILED';
    throw error;
  }
  if (value.length > maxChars) {
    const error = new Error('Grounded research exceeded its bounded evidence limit.');
    error.code = 'VALIDATION_FAILED';
    throw error;
  }
  return value;
}
