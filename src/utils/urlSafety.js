/**
 * URL and HTML-attribute helpers for renderer-owned, potentially untrusted
 * content. Keep URL admission close to the renderer boundary: IPC validation
 * is a separate defense, but callers must not ask Electron to dispatch an
 * arbitrary scheme in the first place.
 */
const HTML_ATTRIBUTE_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function hasControlCharacter(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1F || code === 0x7F) return true;
  }
  return false;
}

/** Returns the trimmed string form of a URL input, or '' when it is empty or has a control character. */
function cleanUrlInput(value) {
  const raw = String(value ?? '').trim();
  return !raw || hasControlCharacter(raw) ? '' : raw;
}

export function escapeHtmlAttribute(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => HTML_ATTRIBUTE_ESCAPES[character]);
}

function toUrl(value) {
  const raw = cleanUrlInput(value);
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Returns a canonical http(s) URL suitable for Electron's external browser dispatcher. */
export function normalizeExternalHttpUrl(value) {
  const raw = cleanUrlInput(value);
  if (!raw) return '';

  // LinkNode historically accepted a bare domain. Do this only when no URI
  // scheme is present; never turn an untrusted scheme into a safe-looking URL.
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  const url = toUrl(candidate);
  return url && (url.protocol === 'http:' || url.protocol === 'https:') ? url.href : '';
}

/**
 * Markdown previews also support in-document relative links and the app's
 * read-only local-file protocol. Attribute escaping remains mandatory.
 */
export function normalizeMarkdownUrl(value) {
  const raw = cleanUrlInput(value);
  if (!raw) return '';
  // A leading '//' or '/\\' is a protocol-relative host, not a path.
  const isRootPath = raw.startsWith('/') && raw[1] !== '/' && raw[1] !== '\\';
  if (raw.startsWith('#') || isRootPath || raw.startsWith('./') || raw.startsWith('../')) return raw;

  const url = toUrl(raw);
  if (!url) return '';
  return ['http:', 'https:', 'mailto:', 'tel:', 'local-file:'].includes(url.protocol) ? url.href : '';
}
