import { useRef, useEffect, useCallback, useMemo } from 'react';

/**
 * useEpochCancellation — guards against late async settlements after a
 * user-triggered cancel (Reset / reroute / unmount).
 *
 * The pattern: a long-running pipeline captures the current epoch at start,
 * then re-checks after every await. If the epoch has changed, the user
 * cancelled — and the late settlement must NOT mutate state (state was
 * reverted by the cancel handler; overwriting it would bounce the UI back
 * to a "done" state the user just dismissed, or strand orphan nodes whose
 * hub no longer exists to consume their events).
 *
 * Usage:
 *   const epoch = useEpochCancellation();
 *
 *   const runPipeline = async () => {
 *     const cancelled = epoch.start();
 *     await stepOne();
 *     if (cancelled()) return;
 *     ...
 *   };
 *
 *   const handleCancel = () => {
 *     epoch.bump();           // every in-flight pipeline starts returning early
 *     window.electronAPI?.cancelNodeTask?.(id);   // abort the backend too
 *   };
 *
 * Auto-bumps on component unmount so any pipeline mid-flight when the hub
 * is removed drops its remaining work instead of trying to spawn orphan
 * nodes onto a canvas that no longer has a parent hub.
 *
 * The returned object is stable across renders — safe to include directly
 * in useCallback / useEffect dependency arrays without triggering needless
 * re-creation.
 */
export function useEpochCancellation() {
  const epochRef = useRef(0);
  useEffect(() => {
    return () => { epochRef.current += 1; };
  }, []);

  /** Capture the current epoch and return a `cancelled()` predicate. */
  const start = useCallback(() => {
    const myEpoch = epochRef.current;
    return () => myEpoch !== epochRef.current;
  }, []);

  /** Bump the epoch — any pipeline that called `start()` before this point
   *  will see `cancelled()` return true on its next check. */
  const bump = useCallback(() => {
    epochRef.current += 1;
  }, []);

  return useMemo(() => ({ start, bump }), [start, bump]);
}
