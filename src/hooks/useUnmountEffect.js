import { useEffect, useRef } from 'react';

/**
 * Run `fn` exactly once, on the component's final unmount, with no stale
 * closure. The ref pattern keeps the effect's dep array empty (so it never
 * re-fires) while still letting `fn` close over fresh values from each
 * render — useful when the cleanup needs to read state set after mount
 * (e.g. cascade-delete child nodes whose ids were collected during the
 * component's life).
 */
export function useUnmountEffect(fn) {
  const ref = useRef(fn);
  const setupGenerationRef = useRef(0);
  const cleanedRef = useRef(false);
  // Mirror the latest `fn` into the ref AFTER each render so the unmount
  // cleanup below reads the freshest closure. Doing this inside an effect
  // (rather than during render) satisfies React's "no refs during render"
  // rule without losing the freshness guarantee — effects run after render
  // but before the next render, so the ref is always current by the time
  // any subsequent unmount fires.
  useEffect(() => {
    ref.current = fn;
  });
  useEffect(() => {
    const generation = setupGenerationRef.current + 1;
    setupGenerationRef.current = generation;
    cleanedRef.current = false;
    return () => {
      // React StrictMode deliberately runs effect setup → cleanup → setup on
      // mount. Defer one microtask so the replay setup can invalidate this
      // generation; a real unmount has no replacement setup and runs once.
      Promise.resolve().then(() => {
        if (
          setupGenerationRef.current === generation
          && !cleanedRef.current
        ) {
          cleanedRef.current = true;
          ref.current();
        }
      });
    };
  }, []);
}
