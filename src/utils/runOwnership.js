/**
 * Synchronous ownership guard for async work that may be cancelled and replaced
 * before the old promise settles. A stale owner's `finish()` is a no-op, so its
 * finally block cannot mark a newer run idle.
 */
export function createRunOwnershipGuard() {
  let activeToken = null;

  return {
    get active() {
      return activeToken !== null;
    },

    start() {
      if (activeToken !== null) return null;
      const token = Symbol('run-owner');
      activeToken = token;
      return token;
    },

    finish(token) {
      if (token == null || activeToken !== token) return false;
      activeToken = null;
      return true;
    },

    cancel() {
      activeToken = null;
    },
  };
}
