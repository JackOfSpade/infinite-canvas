// Rules for a Job Board that takes its listings from saved streams
// (electron/ipc/jobListingStream.js). Pure, so they are tested directly.

/** A stream has no search run to name; Board inputs built from one carry this id instead. */
export const JOB_BOARD_STREAM_RUN_PREFIX = 'stream:';

export function jobBoardStreamRunId(streamId) {
  return typeof streamId === 'string' && streamId ? `${JOB_BOARD_STREAM_RUN_PREFIX}${streamId}` : null;
}

export function isJobBoardStreamRunId(runId) {
  return typeof runId === 'string' && runId.startsWith(JOB_BOARD_STREAM_RUN_PREFIX);
}

/** How long a status line may be the latest and still mean "searching now". */
export const JOB_BOARD_STREAM_ACTIVE_STATUS_MAX_AGE_MS = 30 * 60 * 1000;

const SOURCE_NAMES = Object.freeze({
  indeed: 'Indeed', glassdoor: 'Glassdoor', ziprecruiter: 'ZipRecruiter', linkedin: 'LinkedIn', google: 'Google Jobs',
  dice: 'Dice', usajobs: 'USAJobs', remoteok: 'RemoteOK', weworkremotely: 'We Work Remotely',
});

function sourceName(sourceId) {
  if (typeof sourceId !== 'string' || !sourceId) return 'A platform';
  return SOURCE_NAMES[sourceId] || `${sourceId.charAt(0).toUpperCase()}${sourceId.slice(1)}`;
}

/**
 * The words a Board shows for the latest status line of a stream. The Search
 * side sends fixed codes and numbers only; every sentence is written here.
 * Returns `{ label, detail, active }`; `active` means the search is still
 * sending, so more listings should be expected.
 */
export function describeJobBoardStreamStatus(status, { now = Date.now() } = {}) {
  if (!status || typeof status !== 'object' || typeof status.code !== 'string') {
    return { label: 'No listings yet', detail: 'Nothing has arrived from this Job Search yet. Start it from its own card.', active: false };
  }
  const at = Number(status.at);
  const recent = Number.isFinite(at) && now - at <= JOB_BOARD_STREAM_ACTIVE_STATUS_MAX_AGE_MS;
  const name = sourceName(status.sourceId);
  const number = value => (Number.isSafeInteger(value) ? value : null);
  switch (status.code) {
    case 'run-started':
      return { label: 'Searching', detail: 'This Job Search has started. Listings appear here as it reads them.', active: recent };
    case 'source-progress': {
      const queryIndex = number(status.queryIndex);
      const queryTotal = number(status.queryTotal);
      const page = number(status.page);
      const where = [
        queryIndex != null ? `query ${queryIndex + 1}${queryTotal ? ` of ${queryTotal}` : ''}` : '',
        page != null ? `page ${page}` : '',
      ].filter(Boolean).join(', ');
      return {
        label: where ? `${name}: ${where}` : `${name}: reading`,
        detail: `${name} has sent ${number(status.sent) ?? 0} listing(s) in this run so far.`,
        active: recent,
      };
    }
    case 'source-finished':
      return { label: `${name} finished`, detail: `${name} has no more listings for this run. Other platforms may still be reading.`, active: recent };
    case 'source-stopped':
      return { label: `${name} stopped`, detail: `${name} stopped before it finished. See the Job Search card for what it needs.`, active: recent };
    case 'run-gathered':
      return { label: 'Search finishing', detail: 'Every platform has been read. Late descriptions may still arrive.', active: recent };
    case 'run-paused':
      return { label: 'Search paused', detail: 'This Job Search stopped with platforms unfinished. Continue it from its own card.', active: false };
    case 'run-finished':
      return { label: 'Search finished', detail: 'This Job Search finished. Everything it found has been sent.', active: false };
    case 'run-failed':
      return { label: 'Search failed', detail: 'This Job Search ended with an error. See its own card.', active: false };
    default:
      return { label: 'Search status unknown', detail: 'The latest status from this Job Search is not one this Board knows.', active: false };
  }
}

/** Wait before the next intake step: at once while there is a backlog, slower when idle, slower still after failures. */
export function nextJobBoardIntakeDelayMs({ done = true, failures = 0 } = {}) {
  if (failures > 0) return Math.min(15 * 60 * 1000, 30_000 * 2 ** Math.min(failures - 1, 5));
  return done ? 15_000 : 250;
}

/** While a search is still sending, the Board rebuilds its cards at most this often. */
export const JOB_BOARD_REBUILD_MIN_GAP_ACTIVE_MS = 5 * 60 * 1000;
/** Quiet time after the newest listing before a rebuild starts. */
export const JOB_BOARD_REBUILD_SETTLE_MS = 5_000;

/**
 * When a Board that is behind its listings should next rebuild its cards, as a
 * delay from now; null when it should not (nothing new, or it cannot build).
 * Rebuilding regroups every card, so while listings are still arriving it is
 * spaced out; once the search stops sending, the Board catches up at once.
 */
export function jobBoardRebuildDelayMs({ behind = false, canBuild = false, streamActive = false, lastBuildEndedAt = 0, failures = 0, now = Date.now() } = {}) {
  if (!behind || !canBuild) return null;
  const sinceBuild = Number.isFinite(lastBuildEndedAt) && lastBuildEndedAt > 0 ? now - lastBuildEndedAt : Infinity;
  if (failures > 0) {
    const backoff = Math.min(15 * 60 * 1000, 60_000 * 2 ** Math.min(failures - 1, 4));
    return Math.max(JOB_BOARD_REBUILD_SETTLE_MS, backoff - sinceBuild);
  }
  if (!streamActive) return JOB_BOARD_REBUILD_SETTLE_MS;
  return Math.max(JOB_BOARD_REBUILD_SETTLE_MS, JOB_BOARD_REBUILD_MIN_GAP_ACTIVE_MS - sinceBuild);
}
