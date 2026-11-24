// What each Job Board currently holds from the listing streams it reads, kept
// in the window so the Board can decide what to show without asking the app
// process on every render. The app process owns the saved record
// (electron/ipc/jobs/boardListingStore.js); this is only its latest copy.
//
// While a Board is building its cards from a snapshot, that snapshot is held
// still: listings that arrive meanwhile wait, and are picked up by the next
// build. Without this a long scrape, which adds listings all the time, would
// make every build look out of date before it could finish.

const EMPTY = Object.freeze({
  version: 0,
  rowsByStream: new Map(),
  filteredByStream: new Map(),
  statuses: {},
  summary: null,
});

const boards = new Map(); // boardId -> { current, pending, holds }
const listeners = new Set();

function entry(boardId) {
  let value = boards.get(boardId);
  if (!value) {
    value = { current: EMPTY, pending: null, holds: 0 };
    boards.set(boardId, value);
  }
  return value;
}

function emit() {
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* a listener must not stop the others */ }
  }
}

function group(rows) {
  const byStream = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const streamId = typeof row?.originHubId === 'string' ? row.originHubId : '';
    if (!streamId) continue;
    if (!byStream.has(streamId)) byStream.set(streamId, []);
    byStream.get(streamId).push(row);
  }
  return byStream;
}

/** The snapshot a Board reads from. Stable identity until something changes. */
export function jobBoardIntakeSnapshot(boardId) {
  return boards.get(boardId)?.current || EMPTY;
}

/** Version of everything, for subscribing a component. */
export function jobBoardIntakeVersion(boardId) {
  const value = boards.get(boardId);
  return value ? `${value.current.version}:${value.pending ? value.pending.version : ''}:${value.holds}` : '0::0';
}

/** True when listings arrived while a build held the snapshot still. */
export function jobBoardIntakeHasWaiting(boardId) {
  return !!boards.get(boardId)?.pending;
}

export function subscribeJobBoardIntake(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Replace a Board's copy with what the app process returned (`board-intake-state`). */
export function setJobBoardIntakeState(boardId, { rows = [], filtered = [], statuses = {}, summary = null } = {}) {
  if (typeof boardId !== 'string' || !boardId) return;
  const value = entry(boardId);
  const latest = value.pending || value.current;
  const next = {
    version: latest.version + 1,
    rowsByStream: group(rows),
    filteredByStream: group(filtered),
    statuses: statuses && typeof statuses === 'object' ? statuses : {},
    summary,
  };
  if (value.holds > 0) {
    // Status lines are display only, so they pass through a held snapshot.
    value.current = { ...value.current, statuses: next.statuses, summary: next.summary };
    value.pending = next;
  } else {
    value.current = next;
    value.pending = null;
  }
  emit();
}

/**
 * Hold a Board's listings still while it builds cards. Returns the release
 * function; releasing applies whatever arrived meanwhile. Safe to call twice.
 */
export function holdJobBoardIntake(boardId) {
  const value = entry(boardId);
  value.holds += 1;
  let released = false;
  emit();
  return () => {
    if (released) return;
    released = true;
    value.holds = Math.max(0, value.holds - 1);
    if (value.holds === 0 && value.pending) {
      value.current = value.pending;
      value.pending = null;
    }
    emit();
  };
}

export function forgetJobBoardIntake(boardId) {
  if (boards.delete(boardId)) emit();
}
