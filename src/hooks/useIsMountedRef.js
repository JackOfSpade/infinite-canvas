import { useEffect, useRef } from 'react';

/**
 * Returns a stable ref that reflects the component's committed mount state.
 *
 * Setting the ref back to true in the effect setup is required for React
 * StrictMode, which intentionally runs setup -> cleanup -> setup in development.
 */
export function useIsMountedRef() {
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  return isMountedRef;
}
