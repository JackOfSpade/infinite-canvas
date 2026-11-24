/**
 * One step of a Job Board taking listings from the streams it reads.
 *
 * The Board never asks a Job Search for anything. It reads each stream from its
 * own saved position, judges what it reads, and saves the outcome
 * (boardListingStore.js). A step takes a small number of records so that an
 * interrupted step redoes little; the caller repeats steps until every stream
 * is at its end.
 *
 * For each new or changed listing, in order:
 *   1. already decided and unchanged → nothing to do;
 *   2. deleted from this Board, applied to, or already shown earlier → dropped;
 *   3. no readable description yet → waiting (an update may bring one);
 *   4. wrong language → dropped;
 *   5. judged against the preferences of the search that found it (or the
 *      Board's own, when it has some): wrong role → dropped, ruled out → filtered;
 *   6. scored against the career data.
 *
 * Every outside effect comes in through `deps`, so this file has no Electron or
 * AI imports and is tested with plain functions.
 */
import { jobAndVariantKeys } from '../../../src/utils/jobListingIdentity.js';
import { boardListingMark } from './boardListingStore.js';

/** Listings judged per step: about one scoring batch, so little is redone after an interruption. */
export const BOARD_INTAKE_LISTINGS_PER_STEP = 20;
/** Stream records read per step (status lines and unchanged re-reads cost nothing). */
export const BOARD_INTAKE_RECORDS_PER_STEP = 400;

const runKey = (streamId, runId) => `${streamId}\n${runId}`;

function emptyCounts() {
  return { read: 0, unchanged: 0, scored: 0, filtered: 0, waiting: 0, unscored: 0, seen: 0, applied: 0, deleted: 0, language: 0, role: 0 };
}

/**
 * @param {object}   args
 * @param {string[]} args.streamIds       the streams this Board reads (its connected Job Searches)
 * @param {object}   args.state           the Board's current record (loadBoardListingState)
 * @param {string[]} [args.deletedKeys]   listing keys the user deleted from this Board
 * @param {string}   [args.careerSnapshotId] the Board's own career data, when it has some; otherwise each
 *                                         listing is scored on the career data of the search that found it
 * @param {object}   args.deps
 * @param {function} args.deps.readStream        (streamId, position, { limit }) → { records, position, atEnd }
 * @param {function} args.deps.loadSeen          () → { dropSeen(jobs) → { kept, seen, applied } }  one load per step
 * @param {function} args.deps.hasDescription    (job) → boolean
 * @param {function} args.deps.filterLanguage    (jobs) → jobs kept
 * @param {function} args.deps.evaluate          ({ jobs, run, streamId }) → { accepted, filtered }  rows judged; a row in neither was the wrong role
 * @param {function} args.deps.score             ({ jobs, careerSnapshotId }) → scored rows, same order (a row may come back unscored)
 * @param {function} args.deps.save              (records) → saves them durably, in order
 * @returns {{ counts, streams: { [streamId]: { position, atEnd, status } }, done: boolean }}
 */
export async function runBoardIntakeStep({ streamIds, state, deletedKeys = [], careerSnapshotId = null, deps,
  listingsPerStep = BOARD_INTAKE_LISTINGS_PER_STEP, recordsPerStep = BOARD_INTAKE_RECORDS_PER_STEP }) {
  const counts = emptyCounts();
  const streams = {};
  const deleted = new Set(Array.isArray(deletedKeys) ? deletedKeys : []);
  const ids = [...new Set((Array.isArray(streamIds) ? streamIds : []).filter(id => typeof id === 'string' && id))];
  let seen = null;
  let done = true;
  let budget = Math.max(1, Math.floor(listingsPerStep));

  for (const streamId of ids) {
    const startPosition = state.positions.get(streamId) || null;
    if (budget <= 0) {
      streams[streamId] = { position: startPosition, atEnd: false, status: state.statuses.get(streamId) || null };
      done = false;
      continue;
    }
    const read = await deps.readStream(streamId, startPosition, { limit: recordsPerStep });
    const records = [];
    const runs = new Map();
    let latestStatus = null;
    // Listings to judge, newest content per key. Reading stops once this step
    // has as many as it will judge; the position then stops there too.
    const candidates = new Map();
    let position = startPosition;
    let stoppedEarly = false;
    for (const record of read.records) {
      if (record.type === 'status') {
        if (record.code === 'run-started' && typeof record.runId === 'string') {
          runs.set(record.runId, record.run && typeof record.run === 'object' ? record.run : {});
          records.push({ t: 'run', streamId, runId: record.runId, run: runs.get(record.runId) });
        }
        const { next: _next, run: _run, ...status } = record;
        latestStatus = status;
        position = record.next;
        continue;
      }
      const key = typeof record.key === 'string' ? record.key : null;
      const job = record.job && typeof record.job === 'object' ? record.job : null;
      if (!key || !job) { position = record.next; continue; }
      counts.read += 1;
      const mark = boardListingMark(job);
      const known = candidates.get(key) || state.rows.get(key);
      const decidedForGood = known?.state === 'dropped' && ['seen', 'applied', 'deleted'].includes(known.reason);
      if (!candidates.has(key) && (known?.mark === mark || decidedForGood)) {
        counts.unchanged += 1;
        position = record.next;
        continue;
      }
      if (!candidates.has(key) && candidates.size >= budget) { stoppedEarly = true; break; }
      candidates.set(key, { key, job, mark, streamId, runId: typeof record.runId === 'string' ? record.runId : null, wasShown: state.rows.get(key)?.state === 'scored' });
      position = record.next;
    }
    budget -= candidates.size;

    const judged = await judgeListings({
      entries: [...candidates.values()], streamId, counts, deleted, careerSnapshotId, deps,
      runFor: runId => runs.get(runId) || state.runs.get(runKey(streamId, runId)) || {},
      seenLoader: async () => (seen ||= await deps.loadSeen()),
    });
    records.push(...judged);
    if (latestStatus) records.push({ t: 'status', streamId, status: latestStatus });
    const moved = JSON.stringify(position) !== JSON.stringify(startPosition);
    // The position goes last: never ahead of the rows it covers.
    if (moved) records.push({ t: 'pos', streamId, position });
    if (records.length > 0) await deps.save(records);
    const atEnd = !stoppedEarly && read.atEnd === true;
    if (!atEnd) done = false;
    streams[streamId] = { position, atEnd, status: latestStatus || state.statuses.get(streamId) || null };
  }
  return { counts, streams, done };
}

/**
 * Judge a set of listings and return the row records to save. Shared by the
 * stream intake above and by re-evaluation of listings the Board already holds.
 * Each entry: { key, job, mark, runId, wasShown }.
 */
async function judgeListings({ entries, streamId, counts, deleted, careerSnapshotId, deps, runFor, seenLoader }) {
  const pending = entries.map(entry => ({ ...entry, state: null, reason: null }));
  const decide = (entry, nextState, reason = null) => {
    entry.state = nextState;
    entry.reason = reason;
    const bucket = reason && nextState === 'dropped' ? reason : nextState;
    counts[bucket] = (counts[bucket] || 0) + 1;
  };
  const undecided = () => pending.filter(entry => entry.state == null);

  for (const entry of undecided()) {
    if (jobAndVariantKeys(entry.job).some(key => deleted.has(key))) decide(entry, 'dropped', 'deleted');
  }
  // A listing already on this Board is being updated, not seen for the first
  // time: the record of having shown it must not remove it.
  const fresh = undecided().filter(entry => !entry.wasShown);
  if (fresh.length > 0) {
    const seen = await seenLoader();
    const result = seen.dropSeen(fresh.map(entry => entry.job));
    const seenSet = new Set(result.seen || []);
    const appliedSet = new Set(result.applied || []);
    for (const entry of fresh) {
      if (appliedSet.has(entry.job)) decide(entry, 'dropped', 'applied');
      else if (seenSet.has(entry.job)) decide(entry, 'dropped', 'seen');
    }
  }
  for (const entry of undecided()) {
    if (!deps.hasDescription(entry.job)) decide(entry, 'waiting');
  }
  {
    const rest = undecided();
    const kept = new Set(deps.filterLanguage(rest.map(entry => entry.job)));
    for (const entry of rest) if (!kept.has(entry.job)) decide(entry, 'dropped', 'language');
  }
  // Judge each listing by the search run that found it.
  const byRun = new Map();
  for (const entry of undecided()) {
    const id = entry.runId || '';
    if (!byRun.has(id)) byRun.set(id, []);
    byRun.get(id).push(entry);
  }
  for (const [runId, group] of byRun) {
    const run = runFor(runId);
    const judged = await deps.evaluate({ jobs: group.map(entry => entry.job), run, streamId: group[0].streamId || streamId });
    // Rows come back as new objects; each names the position it was sent at.
    const acceptedAt = new Map((judged.accepted || []).map(item => [item.index, item.job]));
    const filteredAt = new Map((judged.filtered || []).map(item => [item.index, item.job]));
    const toScore = [];
    group.forEach((entry, index) => {
      if (acceptedAt.has(index)) { entry.job = acceptedAt.get(index); toScore.push(entry); }
      else if (filteredAt.has(index)) { entry.job = filteredAt.get(index); decide(entry, 'filtered'); }
      else decide(entry, 'dropped', 'role');
    });
    if (toScore.length === 0) continue;
    const career = careerSnapshotId || (typeof run.careerSnapshotId === 'string' ? run.careerSnapshotId : null);
    if (!career) { for (const entry of toScore) decide(entry, 'unscored', 'no-career'); continue; }
    const scored = await deps.score({ jobs: toScore.map(entry => entry.job), careerSnapshotId: career });
    toScore.forEach((entry, index) => {
      const row = scored?.[index];
      if (row && typeof row === 'object' && row.unscored !== true && Number.isFinite(Number(row.matchScore))) {
        entry.job = row;
        decide(entry, 'scored');
      } else {
        decide(entry, 'unscored', 'scoring-failed');
      }
    });
  }
  return pending.map(entry => ({
    t: 'row', key: entry.key, streamId: entry.streamId || streamId, runId: entry.runId, state: entry.state,
    ...(entry.reason ? { reason: entry.reason } : {}), mark: entry.mark,
    ...(entry.state !== 'dropped' ? { job: entry.job } : {}),
  }));
}

/**
 * Judge again listings the Board already holds: ones that could not be scored
 * (no career data then, or scoring failed), or every kept listing after the
 * Board's career data or preferences changed. `select(row)` picks them. Takes
 * a limited number per step; returns how many are left.
 */
export async function runBoardReevaluationStep({ state, select, deletedKeys = [], careerSnapshotId = null, deps,
  listingsPerStep = BOARD_INTAKE_LISTINGS_PER_STEP }) {
  const counts = emptyCounts();
  const chosen = [...state.rows.values()].filter(row => row.job && select(row));
  const batch = chosen.slice(0, Math.max(1, Math.floor(listingsPerStep)));
  if (batch.length === 0) return { counts, remaining: 0, done: true };
  let seen = null;
  const byStream = new Map();
  for (const row of batch) {
    const id = row.streamId || '';
    if (!byStream.has(id)) byStream.set(id, []);
    byStream.get(id).push(row);
  }
  const records = [];
  for (const [streamId, rows] of byStream) {
    records.push(...await judgeListings({
      entries: rows.map(row => ({ key: row.key, job: stripJudgement(row.job), mark: row.mark, runId: row.runId, streamId, wasShown: row.state === 'scored' })),
      streamId, counts, deleted: new Set(Array.isArray(deletedKeys) ? deletedKeys : []), careerSnapshotId, deps,
      runFor: runId => state.runs.get(runKey(streamId, runId)) || {},
      seenLoader: async () => (seen ||= await deps.loadSeen()),
    }));
  }
  counts.read = batch.length;
  if (records.length > 0) await deps.save(records);
  return { counts, remaining: chosen.length - batch.length, done: chosen.length === batch.length };
}

// A listing judged again starts from what the search sent: an earlier
// preference verdict must not be read as the new one.
function stripJudgement(job) {
  if (!job || typeof job !== 'object') return job;
  const { preferenceAssessment: _preference, ...rest } = job;
  return rest;
}
