// FIFO async-mutex factory. Each caller (sharedProfileLock.js, statusCheckLock.js,
// jobRoleScreenVerdicts.js, listingLivenessCalibration.js) creates its own
// queue from it, so unrelated work never waits behind another queue.
//
// Kept dependency-free (no electron or puppeteer imports; AsyncLocalStorage is
// a Node core module) so it stays unit-testable in the plain-node test runner.
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Create one FIFO mutex: `withLock(fn, signal?)` runs `fn` exclusively with
 * respect to every other call through the SAME returned `withLock`, in FIFO
 * order. A rejected (or resolved) `fn` does NOT wedge the queue: the next
 * caller still runs.
 *
 * Reentrancy guard: calling `withLock` again from within its own `fn`
 * (directly, or through something `fn` awaits) would make the nested call wait
 * behind the very `fn` that is waiting for it, a deadlock with no error and no
 * timeout. AsyncLocalStorage marks every async frame spawned inside a critical
 * section, so a reentrant call throws a clear error instead of hanging.
 *
 * @param {object} [opts]
 * @param {string} [opts.name] — used in error/log messages (e.g. 'sharedProfileLock')
 * @param {boolean} [opts.supportsAbort] — if true, withLock's optional `signal`
 *   is checked at turn-start; an already-aborted signal skips `fn` entirely
 *   and rejects with an AbortError instead of running it.
 * @returns {{ withLock: Function, getQueueDepth: () => number, getSnapshot: () => object }}
 */
export function createFifoLock({ name = 'lock', supportsAbort = false } = {}) {
  let _tail = Promise.resolve();
  // Acquirers that have enqueued but whose critical section hasn't settled
  // yet (the one running + everyone waiting). Surfaced for a "queued behind
  // N" banner/log by callers that opt in via getQueueDepth().
  let _pending = 0;
  // Metadata is deliberately supplied by the caller, never inferred from a
  // closure/function name (which is unstable after minification). It makes a
  // profile-lock collision answer "which app workflow owned our FIFO?" without
  // recording user content or URLs.
  let _active = null;
  const als = new AsyncLocalStorage();
  // AsyncLocalStorage context propagates into timers/promises created by a
  // critical section even after that section has returned. Track which owner
  // tokens are still physically active so deferred descendants may acquire
  // normally once their originating section has released the mutex.
  const activeOwners = new Set();

  function withLock(fn, signal = null, { label = null } = {}) {
    if (activeOwners.has(als.getStore())) {
      throw new Error(`${name}: reentrant withLock() call detected from within its own critical section — this would deadlock waiting on itself. Restructure the caller so it doesn't nest the same lock.`);
    }
    _pending++;
    let started = false;
    let detachAbortListener = () => {};
    const execution = _tail.then(async () => {
      started = true;
      detachAbortListener();
      if (supportsAbort && signal?.aborted) {
        const err = new Error(`Aborted before acquiring the ${name}`);
        err.name = 'AbortError';
        throw err;
      }
      _active = { label: typeof label === 'string' && label ? label.slice(0, 120) : null, since: Date.now() };
      const owner = Symbol(name);
      activeOwners.add(owner);
      try {
        return await als.run(owner, () => fn());
      } finally {
        activeOwners.delete(owner);
        _active = null;
      }
    });
    // Advance the tail regardless of outcome so one failure/abort doesn't
    // wedge the queue. This MUST follow the real execution, not the caller's
    // abortable view below: letting an early-aborted waiter advance the tail
    // would start the next critical section while the current holder still ran.
    _tail = execution.then(() => {}, () => {});

    let result = execution;
    if (supportsAbort && signal?.addEventListener) {
      result = new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          detachAbortListener();
          fn(value);
        };
        const onAbort = () => {
          // Once fn has begun, its own cooperative signal handling owns
          // cancellation. Rejecting only the caller while fn kept the mutex
          // would make lifecycle and error reporting disagree.
          if (!started) {
            const err = new Error(`Aborted while waiting for the ${name}`);
            err.name = 'AbortError';
            finish(reject, err);
          }
        };
        detachAbortListener = () => signal.removeEventListener('abort', onAbort);
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
        execution.then(
          value => finish(resolve, value),
          error => finish(reject, error),
        );
      });
    }
    // Queue depth is physical FIFO occupancy, not whether one caller already
    // stopped awaiting. An early-aborted caller still has a no-op execution
    // queued behind the holder, so keep it in diagnostics until that execution
    // reaches and settles at its turn.
    const settle = () => { _pending--; };
    execution.then(settle, settle);
    return result;
  }

  function getQueueDepth() {
    return _pending;
  }

  function getSnapshot() {
    return {
      queueDepth: _pending,
      active: _active ? { ..._active } : null,
    };
  }

  return { withLock, getQueueDepth, getSnapshot };
}

/**
 * Keyed promise-tail mutex: `withKeyedLock(key, fn)` runs `fn` after every
 * earlier call with the same key has settled, whether it resolved or rejected.
 * Different keys never wait on one another. An idle key is dropped from the map
 * so an unbounded set of keys over a long session does not leak, and a newer
 * call queued behind this one keeps its entry. The tail map is exposed as
 * `withKeyedLock.tails`.
 */
export function createKeyedLock() {
  const tails = new Map();
  function withKeyedLock(key, fn) {
    const prior = tails.get(key) || Promise.resolve();
    const result = prior.then(fn, fn);
    const tail = result.then(() => {}, () => {});
    tails.set(key, tail);
    return result.finally(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
  }
  // Exposed so a caller that renames its keys can move the queued tails too.
  withKeyedLock.tails = tails;
  return withKeyedLock;
}
