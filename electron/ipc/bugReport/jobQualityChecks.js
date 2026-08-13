import { hasMojibake } from '../../../src/utils/textEncoding.js';

/**
 * Pure job-data-quality heuristics used by jobsSnapshot.js's field-quality
 * checks. Previously buried as closures inside a ~1000-line markdown-
 * formatting function, only reachable by constructing a full bug-report
 * payload and grepping the output — extracted here so they're unit-testable
 * directly.
 */

// A bare comma-grouped thousands range ("70,000 - 95,000") is a salary that
// merely lost its currency symbol — accept it as monetary. Truly ambiguous
// tiny bare values ("40 - 50") still don't match (no thousands grouping,
// currency symbol, or cadence word) — there's no positive evidence they were
// ever meant as pay, so classifyUnparseableSalary (below) puts them on the
// prose side rather than asserting a lost-cadence extractor bug it can't prove.
//
// NOT the arbiter of a source's salary health anymore — parseSalaryToNumeric
// (the real annualizer the app buckets jobs with, src/nodes/jobsearch/
// buildJobTree.js) is. A source can pass looksLikeMoney on every value it
// carries and still have most of them annualize to 0 — e.g. USAJobs'
// "$22.31 - $22.31 / PH" reads as money here but the annualizer can't resolve
// "/ PH" as a cadence, so the job silently lands in the "Unspecified" bucket.
// jobsSnapshot.js's field-quality checks now ask the annualizer first whether
// a present salary actually became usable, and only reach for this function
// afterward, to split the unparseable ones into prose vs cadence-lost.
export function looksLikeMoney(s) {
  // "401k" is excluded from the k-suffix branch unless a "$" is also present —
  // it's a retirement-plan term, not salary shorthand, and parseSalaryToNumeric
  // carries the identical special case ("a benefits blurb ... is never pay").
  // Without this exclusion, "401k matching" would read as money and
  // classifyUnparseableSalary would wrongly call it a cadence-lost extractor
  // bug instead of prose with nothing to extract.
  return /\$|\b(?!401\s*k\b)\d+\s*k\b|\d{1,3}(?:,\d{3})+|per (?:hour|year|week|month)|\/h(?:r|our)|\/yr|\/year|hourly|annually|\ba year\b|\ban hour\b/i.test(s);
}

/**
 * Splits a PRESENT salary string that the real annualizer (parseSalaryToNumeric,
 * src/nodes/jobsearch/buildJobTree.js) could not turn into a usable annual
 * figure — i.e. the job silently landed in the "Unspecified" salary bucket even
 * though the source DID provide a value. Two different root causes collapse to
 * the same annualizer output of 0, and the fix for each differs, so callers
 * should report them separately instead of folding them into one "garbage"
 * bucket the way the old salary-quality check did:
 *
 *   'lost-cadence' — still looks like an attempt at money (per looksLikeMoney)
 *                    but the annualizer couldn't recover a cadence from it
 *                    (e.g. "$20 - $24", "$22.31 - $22.31 / PH"). OUR bug — the
 *                    extractor captured a rate but dropped or never carried its
 *                    per-hour/per-year unit — and it's fixable.
 *   'prose'        — never looked like money at all (e.g. "Competitive",
 *                    "401k matching"). Nothing to extract; not our bug.
 *
 * Callers are expected to gate the call on `parseSalaryToNumeric(s) === 0` —
 * this function only decides WHY a salary was unparseable, not WHETHER it was.
 */
export function classifyUnparseableSalary(s) {
  return looksLikeMoney(s) ? 'lost-cadence' : 'prose';
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
