// Shared, dependency-free grammar for the narrow dash-punctuation exception.
// Candidate prose may use an en dash only when it joins two ordinary numeric
// or month/year date endpoints. Typed résumé date fields are deliberately
// handled by their caller because their source equality has a separate gate.
const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const MONTH_YEAR = `${MONTH}(?:\\.?\\s+|,\\s*|\\.,\\s*)\\d{4}\\b`;
const ACTIVE_ROLE_ENDPOINT = '(?:present|current|ongoing)\\b|\\(\\s*present\\s*\\)';
const RIGHT_ENDPOINT = new RegExp(`^\\s*(?:\\d|${ACTIVE_ROLE_ENDPOINT}|${MONTH_YEAR})`, 'i');

/** True only when the en dash at `index` joins a supported date or numeric range. */
export function enDashIsRange(text, index) {
  const value = String(text || '');
  const before = value.slice(Math.max(0, index - 32), index);
  const after = value.slice(index + 1, index + 34);
  return /\d\s*$/.test(before) && RIGHT_ENDPOINT.test(after);
}
