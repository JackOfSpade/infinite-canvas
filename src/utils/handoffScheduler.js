// One concurrency policy for AI handoffs. Automatic bridge workers should keep
// every available slot busy; manual-only docks keep a stable visible wave so a
// just-completed prompt is not replaced beneath the person answering siblings.
export const HANDOFF_CONCURRENCY = 10;

function workerCountFor(workerCount) {
  const requested = Math.floor(Number(workerCount));
  return Math.max(1, Number.isFinite(requested) ? requested : 1);
}

function abortError(signal) {
  return signal?.reason || new Error('Automatic handoff work was cancelled.');
}

// AbortSignal.any is available in the Electron/Node versions we ship, but the
// scheduler is also imported by lightweight test and build environments. Keep
// the same "either source aborts every sibling" contract in those runtimes
// instead of silently preferring the caller signal over our failure controller.
function combinedAbortSignal(signals) {
  const active = signals.filter(Boolean);
  if (active.length <= 1) return { signal: active[0] || null, dispose: () => {} };
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any(active), dispose: () => {} };
  }
  const controller = new AbortController();
  const listeners = [];
  const forward = source => {
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  for (const source of active) {
    if (source.aborted) {
      forward(source);
      break;
    }
    const listener = () => forward(source);
    source.addEventListener('abort', listener, { once: true });
    listeners.push([source, listener]);
  }
  return {
    signal: controller.signal,
    dispose: () => listeners.forEach(([source, listener]) => source.removeEventListener('abort', listener)),
  };
}

function abortRace(signal) {
  if (!signal) return { promise: null, dispose: () => {} };
  let listener;
  const promise = new Promise((resolve, reject) => {
    listener = () => reject(abortError(signal));
    if (signal.aborted) listener();
    else signal.addEventListener('abort', listener, { once: true });
  });
  return {
    promise,
    dispose: () => signal.removeEventListener('abort', listener),
  };
}

/**
 * Keep a manual-only dock visually stable while sharing the same failure and
 * cleanup contract as automatic workers. A failed item aborts its visible
 * siblings, waits for their pending requests to leave the dock, and only then
 * rejects; the next wave is never revealed after failure.
 */
export async function mapManualHandoffWaves(items, limit, work, { signal, abortController } = {}) {
  const source = Array.isArray(items) ? items : [];
  const output = new Array(source.length);
  const width = workerCountFor(limit);
  const controller = abortController || new AbortController();
  const combined = combinedAbortSignal([signal, controller.signal]);
  const workerSignal = combined.signal;

  try {
    for (let start = 0; start < source.length; start += width) {
      if (workerSignal.aborted) throw abortError(workerSignal);
      let firstError = null;
      const wave = source.slice(start, start + width);
      const pending = wave.map(async (item, offset) => {
        try {
          const value = await work(item, start + offset, { signal: workerSignal });
          output[start + offset] = value;
        } catch (error) {
          if (!firstError) {
            firstError = error;
            if (!controller.signal.aborted) controller.abort(error);
          }
          throw error;
        }
      });
      await Promise.allSettled(pending);
      if (firstError) throw firstError;
      if (workerSignal.aborted) throw abortError(workerSignal);
    }
    return output;
  } finally {
    combined.dispose();
  }
}

/**
 * Drain a lazy automatic-handoff queue through a bounded worker roster.
 *
 * `claim` may return a value (or promise for one) or null/undefined when the
 * queue is exhausted. Claims are serialized so a dependency-ready planner can
 * safely materialize its next item lazily. On the first failure, no worker may
 * begin another claim; the shared controller is aborted, running workers are
 * allowed to settle, and that first error is rethrown after the roster drains.
 */
export async function runAutomaticHandoffWorkers({ workerCount, claim, work, signal, abortController } = {}) {
  if (typeof claim !== 'function') throw new TypeError('runAutomaticHandoffWorkers requires a claim function.');
  if (typeof work !== 'function') throw new TypeError('runAutomaticHandoffWorkers requires a work function.');
  const controller = abortController || new AbortController();
  const combined = combinedAbortSignal([signal, controller.signal]);
  const workerSignal = combined.signal;
  let firstError = workerSignal.aborted ? abortError(workerSignal) : null;
  let claimTail = Promise.resolve();

  const fail = (error) => {
    if (firstError) return;
    firstError = error;
    if (!controller.signal.aborted) controller.abort(error);
  };
  const claimNext = async () => {
    const previous = claimTail;
    let release;
    claimTail = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      if (firstError || workerSignal.aborted) {
        if (!firstError && workerSignal.aborted) fail(abortError(workerSignal));
        return null;
      }
      const racedAbort = abortRace(workerSignal);
      let claimed;
      try {
        const pendingClaim = Promise.resolve().then(() => claim({ signal: workerSignal }));
        claimed = racedAbort.promise
          ? await Promise.race([pendingClaim, racedAbort.promise])
          : await pendingClaim;
      } finally {
        racedAbort.dispose();
      }
      // A lazy planner may suspend while it calculates the next descriptor.
      // Re-check after that await so an abort that arrived meanwhile cannot
      // turn a just-planned descriptor into a newly issued handoff.
      if (firstError || workerSignal.aborted) {
        if (!firstError && workerSignal.aborted) fail(abortError(workerSignal));
        return null;
      }
      return claimed;
    } finally {
      release();
    }
  };
  const runWorker = async () => {
    while (!firstError) {
      const claimed = await claimNext().catch(error => {
        fail(error);
        return null;
      });
      if (claimed == null || firstError) return;
      try {
        await work(claimed, { signal: workerSignal });
      } catch (error) {
        fail(error);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: workerCountFor(workerCount) }, runWorker));
    if (firstError) throw firstError;
  } finally {
    combined.dispose();
  }
}

/**
 * A dependency planner for automatic pipelines whose later descriptors become
 * runnable while earlier descriptors are still in flight. The queue owns no
 * workers and starts no work; it only tells the shared roster what is ready.
 *
 * `complete()` must be called once for every claimed descriptor. A descriptor
 * may add successors before it completes, so `pending` cannot reach zero until
 * the whole dependency graph has drained.
 */
export function createDependencyReadyQueue(initial = []) {
  const ready = Array.isArray(initial) ? [...initial] : [];
  // A newly released dependent phase can be more useful than an unclaimed
  // independent descriptor (for example, it lets research assessment overlap
  // a slow raw tail). Keep that policy here rather than growing a second local
  // scheduler at each pipeline. FIFO is preserved within both priority and
  // ordinary lanes.
  const priorityReady = [];
  let pending = ready.length;
  const waiters = new Set();

  const notify = () => {
    const current = [...waiters];
    waiters.clear();
    current.forEach(wake => wake());
  };
  const waitForChange = signal => new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      waiters.delete(wake);
      signal?.removeEventListener('abort', onAbort);
    };
    const wake = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError(signal));
    };
    waiters.add(wake);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });

  return {
    add(item, { front = false } = {}) {
      (front ? priorityReady : ready).push(item);
      pending += 1;
      notify();
    },
    complete() {
      if (pending <= 0) throw new Error('Dependency-ready queue completed more descriptors than it scheduled.');
      pending -= 1;
      notify();
    },
    async claim({ signal } = {}) {
      while (priorityReady.length === 0 && ready.length === 0 && pending > 0) {
        if (signal?.aborted) throw abortError(signal);
        await waitForChange(signal);
      }
      if (signal?.aborted) throw abortError(signal);
      return priorityReady.shift() ?? ready.shift() ?? null;
    },
  };
}

export async function mapAutomaticHandoffs(items, limit, work, { signal, abortController } = {}) {
  const source = Array.isArray(items) ? items : [];
  const output = new Array(source.length);
  const width = Math.min(source.length, workerCountFor(limit));
  if (width === 0) return output;
  let nextIndex = 0;
  await runAutomaticHandoffWorkers({
    workerCount: width,
    signal,
    abortController,
    claim: () => {
      const index = nextIndex;
      nextIndex += 1;
      return index < source.length ? { item: source[index], index } : null;
    },
    work: async ({ item, index }, context) => { output[index] = await work(item, index, context); },
  });
  return output;
}

// Generic aliases keep non-AI bounded work on the same proven scheduler
// without making those callers pretend they are handoff phases. The aliases
// deliberately share the implementations above; there is still only one
// rolling worker loop to maintain.
export {
  runAutomaticHandoffWorkers as runRollingWorkers,
  mapAutomaticHandoffs as mapWithRollingConcurrency,
};
