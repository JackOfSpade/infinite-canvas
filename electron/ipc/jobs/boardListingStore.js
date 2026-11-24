/**
 * A Job Board's own saved record of every listing it has taken from the
 * listing streams it reads (jobListingStream.js), and how far it has read.
 *
 * One append-only file per Board. Each line is one record; the newest record
 * for a key wins:
 *
 *   row     { key, streamId, runId, state, reason?, mark, job? }
 *           A listing and what the Board decided about it:
 *             scored    judged and scored; `job` is the scored row a card is built from
 *             filtered  the search's (or the Board's) preferences ruled it out; `job` kept
 *                       so different preferences can judge it again
 *             waiting   no readable description yet; `job` kept until an update brings one
 *             unscored  could not be scored yet (no approved career data, or scoring failed)
 *             dropped   will not be shown: already seen, applied to, deleted from this
 *                       Board, wrong language or wrong role. No `job` is kept.
 *           `mark` is what the listing said when it was judged, so the same
 *           listing arriving again unchanged costs nothing and a changed one is
 *           judged again.
 *   pos     { streamId, position }   how far this Board has read that stream
 *   run     { streamId, runId, run } the inputs of a search run (its preferences,
 *                                    career data, location), kept so a listing can be
 *                                    judged by the search that found it after a restart
 *   status  { streamId, status }     the latest status line from that stream
 *
 * A position record is always written AFTER the row records it covers, in the
 * same durable append. So a crash can leave rows without their position (the
 * same stream records are read again and found unchanged) but never a position
 * without its rows: no listing is skipped.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeJobListingStreamPosition } from '../jobListingStream.js';

export const BOARD_LISTING_STATES = Object.freeze(['scored', 'filtered', 'waiting', 'unscored', 'dropped']);
export const BOARD_LISTING_DROP_REASONS = Object.freeze(['seen', 'applied', 'deleted', 'language', 'role']);
/** States whose listing text is kept, because it may be judged again. */
const STATES_WITH_JOB = new Set(['scored', 'filtered', 'waiting', 'unscored']);

/** What a listing says, for telling an unchanged re-read from a real change. */
export function boardListingMark(job) {
  return crypto.createHash('sha1').update(JSON.stringify(job ?? null)).digest('hex');
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 24);
}

/**
 * Where a Board's record lives: beside the canvas that holds the Board, named
 * by fixed-length hashes so no id can escape the folder.
 */
export function boardListingStorePath(canvasFilePath, boardId) {
  if (typeof canvasFilePath !== 'string' || !path.isAbsolute(canvasFilePath)) return null;
  if (typeof boardId !== 'string' || !boardId) return null;
  const base = path.basename(canvasFilePath).replace(/\.json$/iu, '');
  return path.join(path.dirname(canvasFilePath), `${base}.board-listings.${hash(canvasFilePath)}.${hash(boardId)}.jsonl`);
}

export function emptyBoardListingState() {
  return { rows: new Map(), positions: new Map(), runs: new Map(), statuses: new Map(), records: 0 };
}

function applyRecord(state, record) {
  if (!record || typeof record !== 'object') return;
  state.records += 1;
  if (record.t === 'row' && typeof record.key === 'string' && record.key && BOARD_LISTING_STATES.includes(record.state)) {
    state.rows.set(record.key, {
      key: record.key,
      streamId: typeof record.streamId === 'string' ? record.streamId : null,
      runId: typeof record.runId === 'string' ? record.runId : null,
      state: record.state,
      reason: typeof record.reason === 'string' ? record.reason : null,
      mark: typeof record.mark === 'string' ? record.mark : null,
      job: STATES_WITH_JOB.has(record.state) && record.job && typeof record.job === 'object' ? record.job : null,
      at: Number(record.at) || 0,
    });
  } else if (record.t === 'pos' && typeof record.streamId === 'string') {
    state.positions.set(record.streamId, normalizeJobListingStreamPosition(record.position));
  } else if (record.t === 'run' && typeof record.streamId === 'string' && typeof record.runId === 'string') {
    state.runs.set(`${record.streamId}\n${record.runId}`, record.run && typeof record.run === 'object' ? record.run : {});
  } else if (record.t === 'status' && typeof record.streamId === 'string' && record.status && typeof record.status === 'object') {
    state.statuses.set(record.streamId, record.status);
  } else if (record.t === 'forget' && typeof record.streamId === 'string') {
    // The Board stopped reading this stream: its position and status go, its
    // listings stay (cards already shown are not taken away).
    state.positions.delete(record.streamId);
    state.statuses.delete(record.streamId);
  }
}

// The folded record is kept in memory while the file is unchanged, so a Board
// with thousands of listings is not re-read on every intake step.
const cache = new Map();

async function fileSignature(filePath) {
  const stat = await fs.promises.stat(filePath).catch(() => null);
  return stat ? `${stat.size}:${stat.mtimeMs}` : 'absent';
}

/** The Board's current record, folded from its file (newest record per key wins). */
export async function loadBoardListingState(storePath) {
  if (typeof storePath !== 'string' || !storePath) return emptyBoardListingState();
  const signature = await fileSignature(storePath);
  const cached = cache.get(storePath);
  if (cached?.signature === signature) return cached.state;
  const state = emptyBoardListingState();
  if (signature !== 'absent') {
    const text = await fs.promises.readFile(storePath, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { applyRecord(state, JSON.parse(line)); } catch { /* a line torn by a crash */ }
    }
  }
  cache.set(storePath, { signature, state });
  return state;
}

const writeChains = new Map();
function serialized(storePath, work) {
  const previous = writeChains.get(storePath) || Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  writeChains.set(storePath, next);
  const clear = () => { if (writeChains.get(storePath) === next) writeChains.delete(storePath); };
  next.then(clear, clear);
  return next;
}

/**
 * Append records durably, in the order given, and return the updated record.
 * Row records must come before the position record that covers them.
 */
export async function appendBoardListingRecords(storePath, records, { now } = {}) {
  const at = Number(now);
  if (typeof storePath !== 'string' || !storePath) throw new Error('A Board listing store path is required.');
  if (!Number.isFinite(at)) throw new Error('A timestamp is required to save Board listings.');
  const list = (Array.isArray(records) ? records : []).filter(record => record && typeof record === 'object' && typeof record.t === 'string');
  return serialized(storePath, async () => {
    const state = await loadBoardListingState(storePath);
    if (list.length === 0) return state;
    const stamped = list.map(record => ({ ...record, at }));
    const handle = await fs.promises.open(storePath, 'a+', 0o600);
    try {
      const { size } = await handle.stat();
      let separator = '';
      if (size > 0) {
        const last = Buffer.alloc(1);
        await handle.read(last, 0, 1, size - 1);
        if (last[0] !== 0x0a) separator = '\n';
      }
      await handle.writeFile(`${separator}${stamped.map(record => JSON.stringify(record)).join('\n')}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    for (const record of stamped) applyRecord(state, record);
    cache.set(storePath, { signature: await fileSignature(storePath), state });
    return state;
  });
}

/**
 * Rewrite the file with only the newest record per key. Called when the file
 * holds far more records than it needs; the content it folds to is unchanged.
 */
export async function compactBoardListingStore(storePath, { now, minRecords = 2000, ratio = 3 } = {}) {
  const at = Number(now);
  if (typeof storePath !== 'string' || !storePath || !Number.isFinite(at)) return false;
  return serialized(storePath, async () => {
    const state = await loadBoardListingState(storePath);
    const needed = state.rows.size + state.positions.size + state.runs.size + state.statuses.size;
    if (state.records < minRecords || state.records < needed * ratio) return false;
    const lines = [];
    for (const [key, run] of state.runs) {
      const [streamId, runId] = key.split('\n');
      lines.push({ t: 'run', streamId, runId, run, at });
    }
    for (const row of state.rows.values()) {
      lines.push({ t: 'row', key: row.key, streamId: row.streamId, runId: row.runId, state: row.state,
        ...(row.reason ? { reason: row.reason } : {}), mark: row.mark, ...(row.job ? { job: row.job } : {}), at: row.at || at });
    }
    for (const [streamId, status] of state.statuses) lines.push({ t: 'status', streamId, status, at });
    // Positions last, as in every append: never a position ahead of its rows.
    for (const [streamId, position] of state.positions) lines.push({ t: 'pos', streamId, position, at });
    const tmp = `${storePath}.${process.pid}.compact.tmp`;
    const handle = await fs.promises.open(tmp, 'w', 0o600);
    try {
      await handle.writeFile(lines.length ? `${lines.map(record => JSON.stringify(record)).join('\n')}\n` : '', 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(tmp, storePath);
    cache.delete(storePath);
    await loadBoardListingState(storePath);
    return true;
  });
}

/** Remove a Board's record entirely (the Board was deleted). */
export async function removeBoardListingStore(storePath) {
  if (typeof storePath !== 'string' || !storePath) return false;
  cache.delete(storePath);
  await fs.promises.rm(storePath, { force: true });
  return true;
}

/** Counts by state, and by drop reason, for the Board's own display and the bug report. */
export function summarizeBoardListingState(state) {
  const counts = { scored: 0, filtered: 0, waiting: 0, unscored: 0, dropped: 0 };
  const dropped = {};
  for (const row of state?.rows?.values?.() || []) {
    counts[row.state] = (counts[row.state] || 0) + 1;
    if (row.state === 'dropped' && row.reason) dropped[row.reason] = (dropped[row.reason] || 0) + 1;
  }
  return { ...counts, droppedByReason: dropped, total: state?.rows?.size || 0 };
}
