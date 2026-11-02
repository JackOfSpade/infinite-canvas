function resourceCounts(ignored) {
  const counts = new Map();
  for (const resource of process.getActiveResourcesInfo()) {
    if (ignored.includes(resource)) continue;
    counts.set(resource, (counts.get(resource) || 0) + 1);
  }
  return counts;
}

function newResources(before, after) {
  return [...after.entries()]
    .flatMap(([type, count]) => Array(Math.max(0, count - (before.get(type) || 0))).fill(type));
}

// Detect multiplicity, not merely a newly introduced resource type, and run
// the comparison even when the body rejects.
export async function withLeakCheck(fn, { ignored = ['PipeWrap', 'TTYWrap'] } = {}) {
  const before = resourceCounts(ignored);
  let result;
  let failure;
  try {
    result = await fn();
  } catch (error) {
    failure = error;
  }
  const leaked = newResources(before, resourceCounts(ignored));
  if (leaked.length) {
    const leakError = new Error(`leaked active resources: ${leaked.join(', ')}`);
    if (failure) leakError.cause = failure;
    throw leakError;
  }
  if (failure) throw failure;
  return result;
}

// A dependency-port wrapper for failure sweeps. It can synchronously throw or
// asynchronously reject on exactly one call, leaving the remaining calls live.
export function faultAt(port, kth, options = new Error('injected fault')) {
  const normalized = options instanceof Error
    ? { error: options, mode: 'throw' }
    : { error: options?.error || new Error('injected fault'), mode: options?.mode || 'throw' };
  if (!Number.isInteger(kth) || kth < 1) throw new RangeError('faultAt kth must be a positive integer');
  if (!['throw', 'reject'].includes(normalized.mode)) throw new TypeError('faultAt mode must be throw or reject');
  let count = 0;
  const calls = [];
  const wrapped = {};
  for (const [name, value] of Object.entries(port || {})) {
    wrapped[name] = typeof value !== 'function' ? value : function wrappedPortMethod(...args) {
      count++;
      calls.push({ name, args });
      if (count === kth) {
        if (normalized.mode === 'reject') return Promise.reject(normalized.error);
        throw normalized.error;
      }
      return value.apply(this, args);
    };
  }
  return Object.freeze({ port: Object.freeze(wrapped), calls, count: () => count });
}

export async function withTimeout(promise, timeoutMs, {
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
  message = 'operation timed out',
} = {}) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeoutImpl(() => reject(new Error(message)), timeoutMs);
    timer?.unref?.();
  });
  try {
    return await Promise.race([Promise.resolve(promise), timeout]);
  } finally {
    if (timer !== undefined) clearTimeoutImpl(timer);
  }
}

export function makeBridgeHarness(overrides = {}) {
  const calls = [];
  const port = (name, result = undefined) => (...args) => { calls.push({ name, args }); return result; };
  return {
    calls,
    ports: {
      counters: { increment: port('counter') },
      emit: port('emit'),
      audit: { write: port('audit') },
      logger: { record: port('log') },
      ...overrides.ports,
    },
    ...overrides,
  };
}
