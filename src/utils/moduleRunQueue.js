let nextRunId = 1;

// Calls that do not opt into a lane intentionally retain the original app-wide
// FIFO behavior. Marketplace and application work rely on that quota guard.
const DEFAULT_LANE = 'global';

function normalizeLane(lane) {
  return typeof lane === 'string' && lane.trim() ? lane.trim() : DEFAULT_LANE;
}

function describeEntry(entry, position = 0) {
  if (!entry) return null;
  return {
    id: entry.id,
    nodeId: entry.nodeId || null,
    kind: entry.kind || 'module',
    label: entry.label || 'Module run',
    lane: entry.lane,
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
  // A lane is independently FIFO. Callers that share a resource (for example
  // the single job-search manual-AI handoff) use one common lane; unrelated
  // lanes retain independent scheduling.
  const lanes = new Map();

  const getLane = (laneName) => {
    const lane = normalizeLane(laneName);
    if (!lanes.has(lane)) lanes.set(lane, { active: null, queued: [] });
    return [lane, lanes.get(lane)];
  };

  const removeIdleLane = (lane) => {
    const state = lanes.get(lane);
    if (state && !state.active && state.queued.length === 0) lanes.delete(lane);
  };

  const snapshot = () => {
    const activeRuns = [];
    const queued = [];
    const laneSnapshots = {};

    lanes.forEach((state, lane) => {
      const active = describeEntry(state.active, 0);
      const waiting = state.queued.map((entry, index) => describeEntry(entry, index + 1));
      if (active) activeRuns.push(active);
      queued.push(...waiting);
      laneSnapshots[lane] = { active, queued: waiting };
    });

    // `active` and `queued` remain available for existing consumers. Prefer the
    // legacy global lane when it is occupied, so application-card UI keeps the
    // exact single-queue interpretation it had before lanes existed.
    const globalActive = lanes.get(DEFAULT_LANE)?.active || null;
    return {
      active: describeEntry(globalActive, 0) || activeRuns[0] || null,
      queued,
      activeRuns,
      lanes: laneSnapshots,
    };
  };

  const emitChange = () => {
    safeCall(onChange, snapshot());
  };

  const updateQueuedPositions = (lane) => {
    const state = lanes.get(lane);
    if (!state) return;
    state.queued.forEach((entry, index) => {
      safeCall(entry.onQueueUpdate, { ...describeEntry(entry, index + 1), position: index + 1 });
    });
  };

  const finishActive = (entry) => {
    if (!entry || entry.released) return;
    entry.released = true;
    safeCall(entry.onFinish, describeEntry(entry, 0));
    const state = lanes.get(entry.lane);
    if (state?.active?.id === entry.id) state.active = null;
    emitChange();
    drain(entry.lane);
  };

  const startEntry = (entry) => {
    const [, state] = getLane(entry.lane);
    state.active = entry;
    emitChange();
    Promise.resolve()
      .then(() => {
        if (entry.cancelled) throw new Error(entry.cancelReason || 'Node deleted');
        // `active` means this entry owns the lane, but it is not yet safe to
        // start external work until this turn has actually reached onStart.
        // Deletion/reset can happen between acquireModuleRun() returning and
        // this microtask. Keep that tiny admission window cancellable rather
        // than allowing a removed node to open a worker after its queue entry
        // was already considered active.
        entry.started = true;
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

  function drain(lane) {
    const state = lanes.get(lane);
    if (!state || state.active) return;
    const next = state.queued.shift();
    updateQueuedPositions(lane);
    if (!next) {
      removeIdleLane(lane);
      emitChange();
      return;
    }
    next.wasQueued = true;
    startEntry(next);
  }

  const acquireModuleRun = (options = {}) => new Promise((resolve, reject) => {
    const lane = normalizeLane(options.lane);
    const entry = {
      id: `module-run-${nextRunId++}`,
      nodeId: options.nodeId || null,
      kind: options.kind || 'module',
      label: options.label || 'Module run',
      lane,
      // A run can be logically owned by a parent module while a transient
      // child UI initiated it. Keep the parent as `nodeId` for scheduling and
      // diagnostics, but let removal of either owner cancel an unstarted run.
      // (Job Source cards resolve against their hub in the main process.)
      cancellationNodeIds: Array.isArray(options.cancellationNodeIds)
        ? options.cancellationNodeIds.filter((value) => typeof value === 'string' && value)
        : [],
      onQueued: options.onQueued,
      onQueueUpdate: options.onQueueUpdate,
      onStart: options.onStart,
      onFinish: options.onFinish,
      onCancel: options.onCancel,
      continuationPriority: options.priority === 'continuation',
      resolve,
      reject,
      released: false,
      started: false,
      cancelled: false,
      cancelReason: null,
      wasQueued: false,
    };
    const [, state] = getLane(lane);

    if (state.active) {
      entry.wasQueued = true;
      if (entry.continuationPriority) {
        // A user-resolved paused source is the continuation of work that has
        // already reached a decision boundary. Keep FIFO within that class,
        // but place it before unrelated Board/Search requests that arrived
        // while the prompt was open.
        const insertionIndex = state.queued.findIndex(candidate => !candidate.continuationPriority);
        if (insertionIndex === -1) state.queued.push(entry);
        else state.queued.splice(insertionIndex, 0, entry);
      } else {
        state.queued.push(entry);
      }
      const position = state.queued.indexOf(entry) + 1;
      safeCall(entry.onQueued, { ...describeEntry(entry, position), position });
      updateQueuedPositions(lane);
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

  const cancelQueuedRunsMatchingNode = (
    nodeId,
    reason = 'Node deleted',
    { includeCancellationAliases = true } = {},
  ) => {
    if (!nodeId) return 0;
    let cancelled = 0;
    const affectedLanes = [];
    lanes.forEach((state, lane) => {
      let laneChanged = false;
      for (let i = state.queued.length - 1; i >= 0; i--) {
        const entry = state.queued[i];
        if (
          entry.nodeId !== nodeId
          && (!includeCancellationAliases || !entry.cancellationNodeIds.includes(nodeId))
        ) continue;
        state.queued.splice(i, 1);
        entry.cancelled = true;
        entry.cancelReason = reason;
        safeCall(entry.onCancel, describeEntry(entry, 0));
        entry.reject(new Error(reason));
        cancelled++;
        laneChanged = true;
      }
      // startEntry assigns an entry to `active` synchronously, but invokes
      // onStart in the next microtask. Treat that pre-start admission window
      // like a queued entry: no user code or external worker has begun yet,
      // and cancellation must prevent it from doing so. Once `started` is
      // true the owner is responsible for aborting its actual task; the queue
      // only releases its lane when that owner settles its lease.
      const active = state.active;
      if (
        active
        && !active.started
        && (
          active.nodeId === nodeId
          || (includeCancellationAliases && active.cancellationNodeIds.includes(nodeId))
        )
      ) {
        active.released = true;
        active.cancelled = true;
        active.cancelReason = reason;
        state.active = null;
        safeCall(active.onCancel, describeEntry(active, 0));
        active.reject(new Error(reason));
        cancelled++;
        laneChanged = true;
      }
      if (laneChanged) affectedLanes.push(lane);
    });
    if (cancelled > 0) {
      affectedLanes.forEach((lane) => {
        updateQueuedPositions(lane);
        removeIdleLane(lane);
      });
      emitChange();
      // Match normal release semantics: observers see the cancelled entry
      // gone before the next waiting entry starts. Deferring drain until every
      // lane has been examined also prevents a replacement entry from being
      // accidentally considered part of the same cancellation sweep.
      affectedLanes.forEach(drain);
    }
    return cancelled;
  };

  const cancelQueuedRunsForNode = (nodeId, reason = 'Node deleted') => (
    cancelQueuedRunsMatchingNode(nodeId, reason, { includeCancellationAliases: true })
  );

  // Resetting a still-mounted child must cancel only work that child actually
  // enqueued. Parent workflows register it as a cancellation alias so DELETE
  // can tear down the whole dependency, but a child-level Reset is not
  // permission to remove a separately-owned queued Board transaction.
  const cancelQueuedRunsOwnedByNode = (nodeId, reason = 'Node reset') => (
    cancelQueuedRunsMatchingNode(nodeId, reason, { includeCancellationAliases: false })
  );

  return {
    acquireModuleRun,
    runExclusive,
    cancelQueuedRunsForNode,
    cancelQueuedRunsOwnedByNode,
    getSnapshot: snapshot,
  };
}
