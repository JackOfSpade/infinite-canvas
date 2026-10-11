import crypto from 'node:crypto';

/**
 * Pure text helpers for the identity strings the HOST owns in a generated
 * document (a role's title/company/dates/location, a project's name, an
 * education or certification record's fields).
 *
 * The approved snapshot spells each of these one way, and the host demands that
 * spelling byte for byte. A writer that reproduces the same string in another
 * surface form (letter case, a typographic dash or quote, a doubled space, a
 * compatibility form) has still named that entity, so the host writes the
 * approved spelling itself instead of bouncing the document back. A value that
 * differs in anything beyond that surface form is a different value and is
 * refused with the exact text the host expects.
 *
 * No imports from the authority or the renderer, so any validator can use it.
 */

// The width one expected value may take in a correction message. A rendered
// identity field never exceeds the structured résumé's own short-text ceiling,
// so a legitimate approved value is never cut; this only bounds a malformed one.
export const HOST_OWNED_EXPECTED_VALUE_MAX_CHARS = 300;

// Every dash, hyphen and minus form that is not the ASCII hyphen-minus. NFKC
// already folds a few of them (U+FF0D, U+FE63), the rest are listed explicitly.
const DASH_VARIANTS = /[\u2010-\u2015\u2212\u2E3A\u2E3B\uFE58\uFE63\uFF0D]/gu;
// Typographic single and double quotation marks, and the angle quotation marks.
const SINGLE_QUOTE_VARIANTS = /[\u2018-\u201B\u2032\u2035\u2039\u203A\u02BC]/gu;
const DOUBLE_QUOTE_VARIANTS = /[\u201C-\u201F\u2033\u2036\u00AB\u00BB]/gu;
// The same whitespace/control class the career projection collapses when it
// prints a name, so the text a writer copies from the projection and the raw
// approved value reduce to one key.
// eslint-disable-next-line no-control-regex
const SPACE_RUNS = /[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu;

/**
 * The comparison key two surface forms of one host-owned string share:
 * Unicode compatibility composition, dash and quote variants folded to one
 * form, whitespace runs collapsed, trimmed, letter case folded. Deliberately
 * nothing more: punctuation, digits and letters are never dropped, so a
 * different name, date or title never collapses onto an approved one.
 */
export function hostOwnedSurfaceKey(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(DASH_VARIANTS, '-')
    .replace(SINGLE_QUOTE_VARIANTS, '\'')
    .replace(DOUBLE_QUOTE_VARIANTS, '"')
    .replace(SPACE_RUNS, ' ')
    .trim()
    .toLowerCase();
}

/** Whether two strings are the same host-owned value in different surface forms. */
export function sameHostOwnedValue(left, right) {
  return typeof left === 'string' && typeof right === 'string' && hostOwnedSurfaceKey(left) === hostOwnedSurfaceKey(right);
}

/** SHA-256 hex of a string's UTF-8 bytes; a log records this and never the text. */
export function hostOwnedValueSha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/** One approved value as a JSON string literal, cut at the display bound. */
export function boundedExpectedValue(value) {
  const characters = Array.from(String(value ?? ''));
  return JSON.stringify(characters.length > HOST_OWNED_EXPECTED_VALUE_MAX_CHARS
    ? `${characters.slice(0, HOST_OWNED_EXPECTED_VALUE_MAX_CHARS).join('')}\u2026`
    : characters.join(''));
}

/**
 * The learnable clause a correction message appends for a host-owned field:
 * these are identity strings the host copies from the approved snapshot, not
 * generation advice, so naming the expected string is the repair itself.
 */
export function expectedExactlyClause(label, value) {
  return `${label} expected exactly: ${boundedExpectedValue(value)}`;
}
