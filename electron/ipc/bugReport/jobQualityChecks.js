import { hasMojibake } from '../../../src/utils/textEncoding.js';

/**
 * Pure job-data-quality heuristics used by jobsSnapshot.js's field-quality
 * checks. Previously buried as closures inside a ~1000-line markdown-
 * formatting function, only reachable by constructing a full bug-report
 * payload and grepping the output — extracted here so they're unit-testable
 * directly.
 */

// A bare comma-grouped thousands range ("70,000 - 95,000") is a salary that
// merely lost its currency symbol — accept it as monetary so a source that
// serves numeric-only pay isn't flagged "garbage". Truly ambiguous tiny
// values ("40 - 50") still don't match (no thousands grouping), which is
// the right call — they're uninformative in a salary field.
export function looksLikeMoney(s) {
  return /\$|\d+\s*k\b|\d{1,3}(?:,\d{3})+|per (?:hour|year|week|month)|\/h(?:r|our)|\/yr|\/year|hourly|annually|\ba year\b|\ban hour\b/i.test(s);
}

// Re-exported from textEncoding.js rather than reimplemented — that module's
// own comment already flags this as "the same signal the bug-report
// field-quality check uses," so this used to be a live, if small,
// duplication of the exact same C1-control-char test.
export { hasMojibake };

const MOJIBAKE_LOW_CODE = 0x80;
const MOJIBAKE_HIGH_CODE = 0x9f;
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

/**
 * First mojibake excerpt around the corruption (bad bytes replaced with the
 * Unicode replacement char), for a bug-report sample. Returns null if `text`
 * has no mojibake. Walks code points directly rather than a second C1-range
 * regex literal, reusing hasMojibake's own definition of "is corrupted."
 */
export function mojibakeExcerpt(text, radius = 18) {
  const blob = text || '';
  if (!hasMojibake(blob)) return null;
  let idx = -1;
  for (let i = 0; i < blob.length; i++) {
    const code = blob.charCodeAt(i);
    if (code >= MOJIBAKE_LOW_CODE && code <= MOJIBAKE_HIGH_CODE) { idx = i; break; }
  }
  if (idx === -1) return null; // unreachable given the hasMojibake guard above
  const slice = blob.slice(Math.max(0, idx - radius), idx + radius);
  let out = '';
  for (let i = 0; i < slice.length; i++) {
    const code = slice.charCodeAt(i);
    out += (code >= MOJIBAKE_LOW_CODE && code <= MOJIBAKE_HIGH_CODE) ? REPLACEMENT_CHAR : slice[i];
  }
  return out.replace(/\s+/g, ' ');
}
