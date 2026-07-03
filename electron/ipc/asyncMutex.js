// Shared FIFO async-mutex factory backing sharedProfileLock.js,
// marketplaceBrowserLock.js, and statusCheckLock.js — three near-identical
// hand-rolled implementations of the same pattern, kept in sync by hand
// until now. See each of those files for WHY they're separate queues.
//
// Kept dependency-free (no electron / puppeteer imports — AsyncLocalStorage
// is a plain Node core built-in) so it stays unit-testable in the plain-node
// test runner.
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Create one FIFO mutex: `withLock(fn, signal?)` runs `fn` exclusively with
 * respect to every other call through the SAME returned `withLock`, in FIFO
 * order. A rejected (or resolved) `fn` does NOT wedge the queue — the next
 * caller still runs.
 *
 * Reentrancy guard: the original per-file implementations had no defense
 * against `withLock` being called again from within its own `fn` (directly,
 * or transitively through something `fn` awaits) — that reassigns the tail
 * to a promise that depends on the very `fn()` call the nested call would
 * then wait behind, deadlocking forever with no error and no timeout. One
 * caller (jobs.js) already hit this once and worked around it purely by
 * convention/comment ("we must NOT nest withSharedProfileLock calls") rather
 * than the lock itself being safe. AsyncLocalStorage marks every async
 * frame spawned inside a critical section, so a reentrant call throws a
 * clear error instead of hanging.
 *
 * @param {object} [opts]
 * @param {string} [opts.name] — used in error/log messages (e.g. 'sharedProfileLock')
 * @param {boolean} [opts.supportsAbort] — if true, withLock's optional `signal`
 *   is checked at turn-start; an already-aborted signal skips `fn` entirely
 *   and rejects with an AbortError instead of running it.
 * @returns {{ withLock: Function, getQueueDepth: () => number }}
 */
export function createFifoLock({ name = 'lock', supportsAbort = false } = {}) {
  let _tail = Promise.resolve();
  // Acquirers that have enqueued but whose critical section hasn't settled
  // yet (the one running + everyone waiting). Surfaced for a "queued behind
  // N" banner/log by callers that opt in via getQueueDepth().
  let _pending = 0;
  const als = new AsyncLocalStorage();

  function withLock(fn, signal = null) {
    if (als.getStore()) {
      throw new Error(`${name}: reentrant withLock() call detected from within its own critical section — this would deadlock waiting on itself. Restructure the caller so it doesn't nest the same lock.`);
    }
    _pending++;
    const result = _tail.then(() => {
      if (supportsAbort && signal?.aborted) {
        const err = new Error(`Aborted before acquiring the ${name}`);
        err.name = 'AbortError';
        throw err;
      }
      return als.run(true, () => fn());
    });
    // Advance the tail regardless of outcome so one failure/abort doesn't
    // wedge the queue; the caller still observes `result`'s resolution/rejection.
    _tail = result.then(() => {}, () => {});
    const settle = () => { _pending--; };
    result.then(settle, settle);
    return result;
  }

  function getQueueDepth() {
    return _pending;
  }

  return { withLock, getQueueDepth };
}
