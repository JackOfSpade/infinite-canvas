import { normalizeExternalHttpUrl } from './urlSafety.js';

/**
 * Dispatch a user-owned web URL without treating Electron's handleSafe failure
 * envelope as success. Browser fallback is retained for renderer-only builds.
 */
export async function openExternalUrl(rawUrl, { dispatcher, fallback } = {}) {
  const url = normalizeExternalHttpUrl(rawUrl);
  if (!url) return { ok: false, reason: 'invalid-url' };
  if (typeof dispatcher === 'function') {
    try {
      const result = await dispatcher(url);
      // Electron's handleSafe contract always marks a successful invoke
      // explicitly. Treat a missing/malformed payload as a failure rather
      // than silently claiming an OS browser was opened.
      if (result?.success !== true) return { ok: false, reason: 'dispatch-failed', error: String(result?.error || '') };
      return { ok: true, url };
    } catch (error) {
      return { ok: false, reason: 'dispatch-failed', error: String(error?.message || error || '') };
    }
  }
  if (typeof fallback === 'function') {
    try {
      // `noopener` as a feature is allowed to return null even when opening
      // succeeds, which makes it indistinguishable from popup blocking. Open
      // synchronously (before this async function reaches another await), then
      // sever the returned WindowProxy's opener ourselves.
      const opened = fallback(url, '_blank');
      // Browsers return null when popup policy blocks window.open(). This is
      // especially likely for a deferred click, and must reach the same toast
      // path as an Electron dispatch failure.
      if (opened == null) return { ok: false, reason: 'dispatch-failed', error: 'Browser blocked the popup' };
      try { opened.opener = null; } catch { /* cross-origin/browser policy: best effort */ }
      return { ok: true, url, fallback: true };
    } catch (error) {
      return { ok: false, reason: 'dispatch-failed', error: String(error?.message || error || '') };
    }
  }
  return { ok: false, reason: 'dispatcher-unavailable' };
}

/** Brief user-safe copy; detailed host/OS errors remain out of toast UI. */
export function openExternalFailureMessage(result) {
  if (result?.reason === 'invalid-url') return 'No safe web link is available.';
  if (result?.reason === 'dispatcher-unavailable') return 'Opening links is unavailable right now.';
  return 'Could not open the link. Please try again.';
}
