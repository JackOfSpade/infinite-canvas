/**
 * Navigation policy for the canvas renderer, which owns the privileged preload
 * bridge. Kept independent of Electron so it can be tested under plain Node.
 */
import { fileURLToPath } from 'node:url';
import { isWithinDirectory } from './utils/pathSafety.js';

/**
 * True only for the bundled renderer in production, or the exact configured
 * Vite origin while developing. Query strings and routes are intentionally
 * allowed because they are renderer state, not a new origin.
 */
export function isTrustedCanvasNavigation(navigationUrl, { devServerUrl, distDir } = {}) {
  try {
    const parsed = new URL(navigationUrl);
    if (devServerUrl) return parsed.origin === new URL(devServerUrl).origin;
    return parsed.protocol === 'file:'
      && typeof distDir === 'string'
      && isWithinDirectory(distDir, fileURLToPath(parsed));
  } catch {
    return false;
  }
}
