import { normalizeCompletionTimestamp } from './completionTimestamp.js';

/** Defaults and bounds for the one-time, first-search date picker. */
export const JOB_SEARCH_DEFAULT_INITIAL_LOOKBACK_DAYS = 21;
export const JOB_SEARCH_MIN_INITIAL_LOOKBACK_DAYS = 1;
export const JOB_SEARCH_MAX_INITIAL_LOOKBACK_DAYS = 180;
// History is deliberately independent from the first-search picker. A year
// bounds each newly resolved automatic window while avoiding the old 21-day
// gap when a person scans less frequently.
export const JOB_SEARCH_MAX_AUTOMATIC_HISTORY_LOOKBACK_DAYS = 365;
// A local-midnight boundary can span one extra DST hour and almost a full
// launch day, so a newly persisted provider horizon needs two overlap days at
// the one-year safety boundary. A later manual recovery recomputes its trusted
// runtime horizon from the immutable start and can legitimately exceed this
// persisted-input bound.
export const JOB_SEARCH_MAX_PROVIDER_LOOKBACK_DAYS = 367;
// Compatibility name for existing callers; it describes the automatic-history
// safety backstop, not the persisted first-search preference.
export const JOB_SEARCH_MAX_LOOKBACK_DAYS = JOB_SEARCH_MAX_AUTOMATIC_HISTORY_LOOKBACK_DAYS;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Normalize the persisted first-search preference at the trust boundary. */
export function normalizeJobSearchInitialLookbackDays(value) {
  if (value == null || (typeof value === 'string' && !value.trim())) {
    return JOB_SEARCH_DEFAULT_INITIAL_LOOKBACK_DAYS;
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    return JOB_SEARCH_DEFAULT_INITIAL_LOOKBACK_DAYS;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return JOB_SEARCH_DEFAULT_INITIAL_LOOKBACK_DAYS;
  return Math.min(
    JOB_SEARCH_MAX_INITIAL_LOOKBACK_DAYS,
    Math.max(JOB_SEARCH_MIN_INITIAL_LOOKBACK_DAYS, Math.floor(parsed)),
  );
}

/**
 * Recover the start timestamp embedded in modern run ids
 * (`${nodeId}-${Date.now()}`). Older completed hubs can predate the dedicated
 * `lastCompletedRunAt` field; using the run start is a conservative fallback
 * because it may add overlap but can never create a missing-time gap.
 */
export function legacyJobRunStartedAt(jobRunId, nodeId) {
  if (typeof jobRunId !== 'string' || typeof nodeId !== 'string' || !nodeId) return null;
  const prefix = `${nodeId}-`;
  if (!jobRunId.startsWith(prefix)) return null;
  return normalizeCompletionTimestamp(jobRunId.slice(prefix.length));
}

export function jobSearchCompletionAnchor(
  lastCompletedRunAt,
  jobRunId,
  nodeId,
) {
  const completedAt = normalizeCompletionTimestamp(lastCompletedRunAt);
  if (completedAt != null) return { timestamp: completedAt, source: 'last-completed' };
  const legacyStartedAt = legacyJobRunStartedAt(jobRunId, nodeId);
  return legacyStartedAt == null
    ? { timestamp: null, source: 'default-cap' }
    : { timestamp: legacyStartedAt, source: 'legacy-run-start' };
}

/**
 * Choose the no-gap anchor for the next successful-run rescan.
 *
 * `lastCompletedRunAt` remains the real user-facing collection completion.
 * The separate coverage timestamp exists because a successful crash recovery
 * can reuse providers that finished on the preceding calendar day.
 */
export function jobSearchRescanAnchor(
  lastSearchCoverageStartedAt,
  lastCompletedRunAt,
  jobRunId,
  nodeId,
) {
  // A successfully completed run can span local midnight, especially when a
  // crash-resume reuses providers that had already finished. Starting the next
  // scan on the overall completion date would then leave a gap for those
  // earlier providers. Prefer the original start of the successful run as the
  // conservative coverage watermark, while retaining lastCompletedRunAt for
  // the user-facing "Last scraped" timestamp.
  const coverageStartedAt = normalizeCompletionTimestamp(lastSearchCoverageStartedAt);
  if (coverageStartedAt != null) {
    return { timestamp: coverageStartedAt, source: 'last-coverage-start' };
  }
  return jobSearchCompletionAnchor(lastCompletedRunAt, jobRunId, nodeId);
}

/**
 * Recover the trustworthy history available to a persisted hub.
 *
 * `searchWindow.completionTimestamp` is deliberately the final fallback: it
 * exists only for a run that began from earlier history, unlike its effective
 * cap start/anchor timestamp which would manufacture history for a first run.
 */
export function jobSearchHistoricalAnchor(data, nodeId) {
  const coverageStartedAt = normalizeCompletionTimestamp(data?.lastSearchCoverageStartedAt);
  if (coverageStartedAt != null) return { timestamp: coverageStartedAt, source: 'last-coverage-start' };
  const completedAt = normalizeCompletionTimestamp(data?.lastCompletedRunAt);
  if (completedAt != null) return { timestamp: completedAt, source: 'last-completed' };
  const legacyStartedAt = data?.hubState === 'done'
    ? legacyJobRunStartedAt(data?.jobRunId, nodeId)
    : null;
  if (legacyStartedAt != null) return { timestamp: legacyStartedAt, source: 'legacy-run-start' };
  const savedWindowCompletion = normalizeCompletionTimestamp(data?.searchWindow?.completionTimestamp);
  return savedWindowCompletion == null
    ? { timestamp: null, source: 'default-cap' }
    : { timestamp: savedWindowCompletion, source: 'saved-window-completion' };
}

/** Resolve the next collection anchor. Trustworthy history always wins. */
export function jobSearchNextAnchor(data, nodeId) {
  const historical = jobSearchHistoricalAnchor(data, nodeId);
  return historical.timestamp == null
    ? { timestamp: null, source: 'initial-lookback' }
    : historical;
}

/**
 * Return local midnight for the calendar date containing `date`.
 *
 * Constructing from local calendar fields (rather than subtracting 24-hour
 * chunks) keeps the boundary correct across daylight-saving changes.
 */
export function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Return a deliberately broad relative-day request that reaches an exact
 * timestamp from `now`.
 *
 * Providers commonly interpret "N days" as N x 24 hours before the request
 * instant. Adding one after flooring makes the provider boundary strictly
 * earlier than our exact client boundary even when the elapsed duration is an
 * exact multiple of 24 hours. The final posted-since filter removes that safe
 * overfetch. Calendar-derived timestamps keep this DST-safe: a 23-hour day
 * needs no unnecessary extra day, while a 25-hour day naturally receives one.
 */
export function providerLookbackDaysForStart(startTimestamp, now = new Date()) {
  const clock = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  const start = startTimestamp instanceof Date
    ? startTimestamp.getTime()
    : Number(startTimestamp);
  if (!Number.isFinite(clock.getTime()) || !Number.isFinite(start)) {
    throw new TypeError('Valid dates are required to resolve a provider lookback horizon.');
  }
  const elapsedMs = Math.max(0, clock.getTime() - start);
  return Math.max(1, Math.floor(elapsedMs / DAY_MS) + 1);
}

/**
 * Resolve the inclusive local-date window for a Job Search collection.
 *
 * A rescan deliberately begins at local midnight on the last successful run's
 * conservative coverage date (normally its start date). That one-date overlap
 * protects postings published while a prior run was in flight, including a
 * run recovered across midnight. Providers receive enough whole 24-hour units
 * to reach that midnight because their "last N days" controls commonly begin
 * at the current time of day; `providerLookbackDays` is intentionally a broad
 * retrieval bound and callers must exact-filter their returned rows at
 * `startTimestamp`.
 *
 * @param {unknown} lastCompletedRunAt Durable rescan anchor timestamp.
 * @param {Date} [now] Injectable clock for deterministic callers/tests.
 * @param {unknown} [initialLookbackDays] First-search date range, ignored
 * when a trustworthy completed-history anchor is available.
 * @returns {{
 *   startTimestamp: number,
 *   startDate: Date,
 *   anchorTimestamp: number,
 *   completionTimestamp: number | null,
 *   capped: boolean,
 *   capReason: 'no-completion' | 'invalid-completion' | 'future-completion' | 'older-than-max-lookback' | null,
 *   providerLookbackDays: number,
 * }}
 */
export function resolveJobSearchDateWindow(lastCompletedRunAt, now = new Date(), initialLookbackDays = JOB_SEARCH_DEFAULT_INITIAL_LOOKBACK_DAYS) {
  const clock = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (!Number.isFinite(clock.getTime())) {
    throw new TypeError('A valid current date is required to resolve a Job Search date window.');
  }

  const todayStart = startOfLocalDay(clock);
  const completionTimestamp = normalizeCompletionTimestamp(lastCompletedRunAt);
  const firstSearchDays = normalizeJobSearchInitialLookbackDays(initialLookbackDays);
  // A valid historical anchor must never inherit the first-search picker.
  // It gets a separate bounded automatic policy so the next scan continues
  // from completion even after the former 21-day window has elapsed.
  const hasUsableHistory = completionTimestamp != null && completionTimestamp <= clock.getTime();
  const capDays = hasUsableHistory
    ? JOB_SEARCH_MAX_AUTOMATIC_HISTORY_LOOKBACK_DAYS
    : firstSearchDays;
  const capStart = new Date(todayStart.getFullYear(), todayStart.getMonth(), todayStart.getDate() - capDays);

  let startDate = capStart;
  let capped = true;
  let capReason = completionTimestamp == null
    ? (lastCompletedRunAt == null ? 'no-completion' : 'invalid-completion')
    : null;

  if (completionTimestamp != null) {
    const completionDate = new Date(completionTimestamp);
    if (completionTimestamp > clock.getTime()) {
      capReason = 'future-completion';
    } else {
      const completionDay = startOfLocalDay(completionDate);
      if (completionDay.getTime() < capStart.getTime()) {
        capReason = 'older-than-max-lookback';
      } else {
        startDate = completionDay;
        capped = false;
      }
    }
  }

  const startTimestamp = startDate.getTime();
  return {
    startTimestamp,
    startDate: new Date(startTimestamp),
    // This is the effective inclusive anchor. `completionTimestamp` preserves
    // the raw successful completion instant when consumers need to display it.
    anchorTimestamp: startTimestamp,
    completionTimestamp,
    capped,
    capReason,
    // Providers commonly interpret N days as N×24 hours back from right now,
    // not as calendar dates. Keep their cutoff strictly earlier than the exact
    // boundary, including at exact 24-hour multiples; the client-side filter
    // removes this deliberate overfetch.
    providerLookbackDays: providerLookbackDaysForStart(startTimestamp, clock),
  };
}
