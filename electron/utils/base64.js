/** Check base64 text without a quantified regex whose stack grows with input. */
export function isBase64Text(value) {
  if (typeof value !== 'string' || value.length === 0 || /[^A-Za-z0-9+/=]/u.test(value)) return false;
  const padding = value.indexOf('=');
  // Both existing callers permit unpadded text. If padding is present, it
  // must be one or two terminal characters after a non-empty body.
  return padding === -1 || (padding > 0
    && (padding === value.length - 1 || (padding === value.length - 2 && value.endsWith('=='))));
}
