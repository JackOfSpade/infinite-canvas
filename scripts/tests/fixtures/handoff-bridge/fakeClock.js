// Deterministic timer port for bridge tests. It models the timer operations
// the bridge uses without installing a process-global clock or real handles.
export function createFakeClock(startAt = 1_700_000_000_000) {
  let now = startAt;
  let nextId = 1;
  const timers = new Map();

  const normalizeDelay = delay => Math.max(0, Number.isFinite(Number(delay)) ? Number(delay) : 0);
  const intervalDelay = delay => Math.max(1, normalizeDelay(delay));
  const schedule = (fn, delay, repeat = null) => {
    if (typeof fn !== 'function') throw new TypeError('Fake timer callback must be a function');
    const id = nextId++;
    const timer = {
      id,
      at: now + normalizeDelay(delay),
      fn,
      repeat,
      unrefed: false,
      cleared: false,
      unref() { this.unrefed = true; return this; },
      ref() { this.unrefed = false; return this; },
      hasRef() { return !this.unrefed; },
      refresh() { this.at = now + normalizeDelay(this.repeat ?? delay); return this; },
    };
    timers.set(id, timer);
    return timer;
  };
  const clear = timer => {
    const id = typeof timer === 'object' ? timer?.id : timer;
    const entry = timers.get(id);
    if (entry) entry.cleared = true;
    timers.delete(id);
  };
  const nextDue = () => [...timers.values()]
    .filter(timer => !timer.cleared && timer.at <= now)
    .sort((a, b) => a.at - b.at || a.id - b.id)[0] || null;
  const runDue = (limit = 10_000) => {
    let count = 0;
    for (;;) {
      const timer = nextDue();
      if (!timer) return count;
      if (++count > limit) throw new Error('fake clock timer limit exceeded');
      if (timer.repeat === null) timers.delete(timer.id);
      else timer.at += timer.repeat;
      timer.fn();
    }
  };
  const pending = () => [...timers.values()].filter(timer => !timer.cleared);

  return Object.freeze({
    now: () => now,
    Date: Object.freeze({ now: () => now }),
    setTimeout: (fn, delay) => schedule(fn, delay),
    clearTimeout: clear,
    setInterval: (fn, delay) => schedule(fn, intervalDelay(delay), intervalDelay(delay)),
    clearInterval: clear,
    advance(ms, limit) { now += normalizeDelay(ms); return runDue(limit); },
    runAll(limit = 10_000) {
      let count = 0;
      while (pending().length) {
        if (count >= limit) throw new Error('fake clock timer limit exceeded');
        now = Math.min(...pending().map(timer => timer.at));
        count += runDue(limit - count);
      }
      return count;
    },
    pending,
    pendingRefed: () => pending().filter(timer => !timer.unrefed),
    pendingCount: () => pending().length,
  });
}
