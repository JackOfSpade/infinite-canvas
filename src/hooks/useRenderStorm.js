import { useRef, useEffect } from 'react';
import { EventLogger } from '../utils/EventLogger';

/**
 * Logs a single `[RenderStorm]` event when a component re-renders abnormally
 * fast — the fingerprint of an effect/state feedback loop or a prop that's
 * unstable on every parent render. Surfaces in bug reports (the RENDER filter
 * code, and FULL) so "the canvas is janking / a node keeps flickering / fans
 * spinning" reports show the culprit node and the rate, instead of leaving the
 * cause invisible (re-renders otherwise emit nothing).
 *
 * Low-volume by design: it counts commits in a sliding window and emits ONE
 * event per burst (then a cooldown) — never per render, which would flood the
 * timeline and the clipboard cap. A sustained-but-slow re-render source (e.g.
 * startup verification re-rendering a hub ~once/sec) deliberately does NOT trip
 * it; that flicker class is diagnosed from the `[Focus]` timeline + the report's
 * task-timing sections instead.
 *
 * Effect-based (post-commit) so it never calls EventLogger during render, which
 * the React Compiler forbids. The refs are write-only bookkeeping — not read in
 * render — so they don't interfere with compiler memoization.
 */
export function useRenderStorm(label, { threshold = 20, windowMs = 1000, cooldownMs = 5000 } = {}) {
  const stampsRef = useRef([]);
  const lastReportRef = useRef(0);

  // No dependency array: runs after every commit so it can count renders.
  useEffect(() => {
    const now = Date.now();
    const stamps = stampsRef.current;
    stamps.push(now);
    while (stamps.length && now - stamps[0] > windowMs) stamps.shift();
    if (stamps.length >= threshold && now - lastReportRef.current > cooldownMs) {
      lastReportRef.current = now;
      EventLogger.log(`[RenderStorm] ${label}: ${stamps.length} renders in ${windowMs}ms`);
      stamps.length = 0;
    }
  });
}
