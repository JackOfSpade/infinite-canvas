// The one regular-expression escaper. Kept dependency-free so the renderer and
// the main process can both import it.
export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
