import { useEffect, useRef } from 'react';

/**
 * Fires `onEscape` on every Escape keydown while this component is mounted
 * (and `enabled`). Extracted because Dialog/ConfirmDialog/ContextMenu/
 * SettingsPanel each independently reimplemented "register a window keydown
 * listener, check e.key === 'Escape', call a callback, clean up on unmount"
 * with subtly different guards — this hook only centralizes that listener
 * plumbing. Each caller still owns its OWN close/dedup semantics inside the
 * callback (e.g. ConfirmDialog's resolveOnce, Dialog's closingRef) since
 * those genuinely differ per component.
 *
 * The callback is read from a ref on every keydown rather than being an
 * effect dependency, so callers don't need to useCallback it to avoid
 * needless resubscription — only `capture`/`enabled` changing re-subscribes.
 *
 * @param {(e: KeyboardEvent) => void} onEscape
 * @param {{ capture?: boolean, enabled?: boolean }} [opts]
 *   capture — listen in the capture phase, e.g. to run before ReactFlow's
 *     own keydown handlers (see PhotoLightbox for why that matters there).
 *   enabled — skip registering the listener entirely (e.g. SettingsPanel
 *     stays mounted at all times and only wants this live while isOpen).
 */
export function useEscapeToClose(onEscape, { capture = false, enabled = true } = {}) {
  const onEscapeRef = useRef(onEscape);
  useEffect(() => { onEscapeRef.current = onEscape; });

  useEffect(() => {
    if (!enabled) return undefined;
    const handleKey = (e) => {
      if (e.key === 'Escape') onEscapeRef.current(e);
    };
    window.addEventListener('keydown', handleKey, capture);
    return () => window.removeEventListener('keydown', handleKey, capture);
  }, [capture, enabled]);
}
