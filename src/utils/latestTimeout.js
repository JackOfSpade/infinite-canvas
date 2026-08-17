/**
 * Schedule only the latest delayed action for a mutable timeout ref.
 *
 * Replacing an already-pending action is important for interactions such as
 * keyboard navigation: an earlier delayed selection must not apply after the
 * user has already selected something else.
 */
export function replaceTimeout(timeoutRef, callback, delay) {
  if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
  timeoutRef.current = setTimeout(() => {
    timeoutRef.current = null;
    callback();
  }, delay);
}

/** Cancel the current delayed action, if any. */
export function cancelTimeout(timeoutRef) {
  if (timeoutRef.current === null) return;
  clearTimeout(timeoutRef.current);
  timeoutRef.current = null;
}
