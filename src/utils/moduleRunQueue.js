let nextRunId = 1;

function describeEntry(entry, position = 0) {
  if (!entry) return null;
  return {
    id: entry.id,
    nodeId: entry.nodeId || null,
    kind: entry.kind || 'module',
    label: entry.label || 'Module run',
    position,
  };
}

function safeCall(fn, arg) {
  if (typeof fn !== 'function') return;
  try {
    fn(arg);
  } catch {
    // Queue callbacks update UI only; never let them corrupt queue state.
  }
}

export function createModuleRunQueue({ onChange = null } = {}) {
  let active = null;
  const queued = [];

  const snapshot = () => ({
    active: describeEntry(active, 0),
    queued: queued.map((entry, index) => describeEntry(entry, index + 1)),
  });

  const emitChange = () => {
    safeCall(onChange, snapshot());
  };

  const updateQueuedPositions = () => {
    queued.forEach((entry, index) => {
      safeCall(entry.onQueueUpdate, { ...describeEntry(entry, index + 1), position: index + 1 });
    });
  };

  const finishActive = (entry) => {
    if (!entry || entry.released) return;
    entry.released = true;
    safeCall(entry.onFinish, describeEntry(entry, 0));
    if (active?.id === entry.id) active = null;
    emitChange();
    drain();
  };

  const startEntry = (entry) => {
    active = entry;
    emitChange();
    Promise.resolve()
      .then(() => {
        if (entry.cancelled) throw new Error(entry.cancelReason || 'Node deleted');
        if (typeof entry.onStart === 'function') {
          entry.onStart({ ...describeEntry(entry, 0), wasQueued: !!entry.wasQueued });
        }
      })
      .then(() => {
        entry.resolve({
          ...describeEntry(entry, 0),
          release: () => finishActive(entry),
        });
      })
      .catch((error) => {
        entry.reject(error);
        finishActive(entry);
      });
  };

  function drain() {
    if (active) return;
    const next = queued.shift();
    updateQueuedPositions();
    if (!next) {
      emitChange();
      return;
    }
    next.wasQueued = true;
    startEntry(next);
  }

  const acquireModuleRun = (options = {}) => new Promise((resolve, reject) => {
    const entry = {
      id: `module-run-${nextRunId++}`,
      nodeId: options.nodeId || null,
      kind: options.kind || 'module',
      label: options.label || 'Module run',
      onQueued: options.onQueued,
      onQueueUpdate: options.onQueueUpdate,
      onStart: options.onStart,
      onFinish: options.onFinish,
      onCancel: options.onCancel,
      resolve,
      reject,
      released: false,
      cancelled: false,
      cancelReason: null,
      wasQueued: false,
    };

    if (active) {
      entry.wasQueued = true;
      queued.push(entry);
      const position = queued.length;
      safeCall(entry.onQueued, { ...describeEntry(entry, position), position });
      emitChange();
      return;
    }

    startEntry(entry);
  });

  const runExclusive = async (options, fn) => {
    const lease = await acquireModuleRun(options);
    try {
      return await fn();
    } finally {
      lease.release();
    }
  };

  const cancelQueuedRunsForNode = (nodeId, reason = 'Node deleted') => {
    if (!nodeId) return 0;
    let cancelled = 0;
    for (let i = queued.length - 1; i >= 0; i--) {
      const entry = queued[i];
      if (entry.nodeId !== nodeId) continue;
      queued.splice(i, 1);
      entry.cancelled = true;
      entry.cancelReason = reason;
      safeCall(entry.onCancel, describeEntry(entry, 0));
      entry.reject(new Error(reason));
      cancelled++;
    }
    if (cancelled > 0) {
      updateQueuedPositions();
      emitChange();
    }
    return cancelled;
  };

  return {
    acquireModuleRun,
    runExclusive,
    cancelQueuedRunsForNode,
    getSnapshot: snapshot,
  };
}
