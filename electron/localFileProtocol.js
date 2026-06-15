/**
 * Decode the filesystem path carried by a local-file:// request.
 *
 * WHATWG URL parsing treats `C:` as a hostname in `local-file://C:/...`.
 * Reconstruct that drive-letter form on Windows while preserving the normal
 * pathname behavior for the triple-slash URLs generated on macOS/Linux.
 */
export function decodeLocalFileRequestPath(requestUrl, platform = process.platform) {
  const fallbackPath = String(requestUrl || '')
    .replace(/^local-file:\/\//, '')
    .split('?')[0]
    .split('#')[0];

  let encodedPath = fallbackPath;
  try {
    const parsed = new URL(requestUrl);
    encodedPath = parsed.pathname || fallbackPath;

    if (parsed.hostname) {
      if (platform === 'win32' && /^[a-zA-Z]$/.test(parsed.hostname)) {
        encodedPath = `${parsed.hostname}:${parsed.pathname}`;
      } else if (platform === 'win32') {
        encodedPath = `//${parsed.hostname}${parsed.pathname}`;
      } else {
        // Chromium can canonicalize `local-file:///private/tmp/...` to
        // `local-file://private/tmp/...` before the protocol handler sees it.
        // For this filesystem-only custom scheme the hostname is the first path
        // segment, not a network authority.
        encodedPath = `/${parsed.hostname}${parsed.pathname}`;
      }
    } else if (platform === 'win32' && /^\/[a-zA-Z]:\//.test(encodedPath)) {
      encodedPath = encodedPath.slice(1);
    }
  } catch {
    // Legacy Windows backslash URLs are not valid WHATWG URLs. The fallback
    // above intentionally preserves their path text.
  }

  return decodeURIComponent(encodedPath);
}
