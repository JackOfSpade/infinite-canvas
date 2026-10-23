import { validationFailure } from './validationFailure.js';
import { collector, templatesFor } from './validationLines.js';
export const TEXT_CORRECTION_TEMPLATES = templatesFor('text.');
// Raw grounded-research handoffs intentionally stay as text because their
// citations and excerpts feed a separate, structured assessment step. Keep a
// small explicit validation contract on that text: it is both the bridge's
// default-deny eligibility signal and protection against silently truncating
// evidence before the assessment can inspect it.
function validateGroundedResearchTextCore(value, { maxChars = 120_000 } = {}) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
    throw new TypeError('Grounded research maxChars must be a positive integer.');
  }
  if (typeof value !== 'string' || !value.trim()) {
    const error = validationFailure({ message: 'Grounded research must be non-empty text.', code: null });
    error.code = 'VALIDATION_FAILED';
    throw error;
  }
  if (value.length > maxChars) {
    const error = validationFailure({ message: 'Grounded research exceeded its bounded evidence limit.', code: null });
    error.code = 'VALIDATION_FAILED';
    throw error;
  }
  return value;
}

export function validateGroundedResearchText(value, options = {}) {
  try { return validateGroundedResearchTextCore(value, options); } catch (error) {
    const issues = collector();
    const max = options.maxChars ?? 120_000;
    if (!Number.isSafeInteger(max) || max < 1) throw error;
    issues.add(typeof value !== 'string' || !value.trim() ? 'text.empty' : 'text.too-long', '', { raw: typeof value === 'string' ? value.length : 0 });
    issues.fail({ templates: TEXT_CORRECTION_TEMPLATES, vars: { max: options.maxChars ?? 120_000 }, error });
    throw error;
  }
}
