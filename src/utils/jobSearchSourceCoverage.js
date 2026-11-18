/**
 * Per-platform job-search coverage bookmarks.
 *
 * Dates, not page numbers, are the bookmark because result pages shift between
 * scrapes: the same page number can expose different postings on every run. A
 * platform's bookmark advances only when that platform finished its walk in a
 * run. Hitting the user's page/job cap still counts as finished, because
 * holding the bookmark would only widen every later request without collecting
 * older rows. Bookmarks store the walk START (not its completion) so postings
 * published while a walk is in flight are picked up by the next walk.
 */
import {
  jobSearchHistoricalAnchor,
  jobSearchNextAnchor,
  resolveJobSearchDateWindow,
} from './jobSearchDateWindow.js';
import { normalizeCompletionTimestamp } from './completionTimestamp.js';
import { getCountryApplicableJobSourceIds } from './jobSourceCountryScope.js';

const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainRecord(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeSourceId(value) {
  return typeof value === 'string' && value.length > 0 && !PROTO_KEYS.has(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function uniqueSourceIds(sourceIds) {
  if (!Array.isArray(sourceIds)) return [];
  const seen = new Set();
  const ids = [];
  for (const id of sourceIds) {
    if (!isSafeSourceId(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** Project a resolved window into the durable/UI-facing shape. */
export function serializeJobSearchWindow(window, anchorSource) {
  return {
    startTimestamp: window.startTimestamp,
    anchorTimestamp: window.anchorTimestamp,
    completionTimestamp: window.completionTimestamp,
    capped: window.capped,
    capReason: window.capReason,
    providerLookbackDays: window.providerLookbackDays,
    anchorSource,
  };
}

/** Normalize the durable per-platform bookmark map at the trust boundary. */
export function normalizeSourceCoverage(raw) {
  const normalized = {};
  if (!isPlainRecord(raw)) return normalized;
  for (const sourceId of Object.keys(raw)) {
    if (!isSafeSourceId(sourceId)) continue;
    const entry = raw[sourceId];
    if (!isPlainRecord(entry)) continue;
    const coverageStartedAt = normalizeCompletionTimestamp(entry.coverageStartedAt);
    if (coverageStartedAt == null) continue;
    const completedAt = normalizeCompletionTimestamp(entry.completedAt) ?? coverageStartedAt;
    normalized[sourceId] = {
      coverageStartedAt,
      completedAt,
      runId: typeof entry.runId === 'string' && entry.runId.trim() ? entry.runId : null,
    };
  }
  return normalized;
}

/**
 * A platform's last COMPLETED scrape is reused for this long. Re-runs then
 * target only the platforms that failed or were blocked, instead of re-walking
 * platforms that finished today (their rows would mostly be filtered by seen
 * history anyway).
 */
export const JOB_SOURCE_RESCRAPE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function rescrapeNowMs(now) {
  const value = now instanceof Date ? now.getTime() : Number(now);
  return Number.isFinite(value) ? value : NaN;
}

/**
 * Split selected platforms into the ones a fresh run must scrape (`due`) and
 * the ones whose last completed scrape is still inside the interval (`fresh`).
 *
 * Only this node's own per-platform completion counts: the hub-level
 * `lastCompletedRunAt` says nothing about a platform that never finished, so
 * it must never make a platform fresh. A future `completedAt` (clock skew) is
 * due as well, otherwise a skewed timestamp would block that platform forever.
 */
export function partitionSourcesByRescrapeAge(data, sourceIds, now = Date.now()) {
  const nowMs = rescrapeNowMs(now);
  const sourceCoverage = normalizeSourceCoverage(data?.sourceCoverage);
  const due = [];
  const fresh = [];
  for (const sourceId of uniqueSourceIds(sourceIds)) {
    const completedAt = hasOwn(sourceCoverage, sourceId)
      ? sourceCoverage[sourceId].completedAt
      : null;
    if (
      completedAt != null
      && completedAt <= nowMs
      && nowMs - completedAt < JOB_SOURCE_RESCRAPE_INTERVAL_MS
    ) {
      fresh.push({
        sourceId,
        completedAt,
        nextEligibleAt: completedAt + JOB_SOURCE_RESCRAPE_INTERVAL_MS,
      });
      continue;
    }
    due.push(sourceId);
  }
  return { due, fresh };
}

/**
 * The platforms whose bookmarks decide how far back a scan reaches.
 *
 * A platform that cannot serve the search's country (Dice and USAJobs on a
 * Canada search) is skipped by every run, so its bookmark can never move. Left
 * in, that frozen date became the start of every later scan and the card kept
 * naming the platform as "catching up". It keeps its bookmark, so it resumes
 * from there if the country later changes. When no platform applies, the
 * selection is returned unchanged and the run's own preflight reports it.
 */
export function coverageSourceIdsForLocation(sourceIds, searchLocationText) {
  const ids = uniqueSourceIds(sourceIds);
  const applicable = getCountryApplicableJobSourceIds(ids, String(searchLocationText || '').trim());
  return applicable.length > 0 ? applicable : ids;
}

/** Prefer a platform's own bookmark; otherwise fall back to the hub anchor. */
export function jobSearchSourceAnchor(
  data,
  nodeId,
  sourceId,
  normalizedCoverage = normalizeSourceCoverage(data?.sourceCoverage),
) {
  if (isSafeSourceId(sourceId)) {
    const sourceCoverage = normalizedCoverage;
    if (hasOwn(sourceCoverage, sourceId)) {
      return { timestamp: sourceCoverage[sourceId].coverageStartedAt, source: 'source-coverage' };
    }
  }
  return jobSearchNextAnchor(data, nodeId);
}

/**
 * Resolve one window per platform and the broadest (earliest start) window
 * that a run must cover so no finished platform is re-scraped needlessly and
 * no unfinished platform misses a day.
 */
export function resolveJobSearchSourceWindows(
  data,
  nodeId,
  sourceIds,
  now = new Date(),
  initialLookbackDays,
) {
  const ids = uniqueSourceIds(sourceIds);
  if (ids.length === 0) {
    const runAnchor = jobSearchNextAnchor(data, nodeId);
    const runWindow = serializeJobSearchWindow(
      resolveJobSearchDateWindow(runAnchor.timestamp, now, initialLookbackDays),
      runAnchor.source,
    );
    return { sourceWindows: {}, runWindow, runAnchor };
  }

  const sourceWindows = {};
  const normalizedCoverage = normalizeSourceCoverage(data?.sourceCoverage);
  let runWindow = null;
  let runAnchor = null;
  for (const sourceId of ids) {
    const anchor = jobSearchSourceAnchor(data, nodeId, sourceId, normalizedCoverage);
    const window = serializeJobSearchWindow(
      resolveJobSearchDateWindow(anchor.timestamp, now, initialLookbackDays),
      anchor.source,
    );
    sourceWindows[sourceId] = window;
    // Strictly smaller keeps the first input order on ties.
    if (runWindow == null || window.startTimestamp < runWindow.startTimestamp) {
      runWindow = window;
      runAnchor = anchor;
    }
  }
  return { sourceWindows, runWindow, runAnchor };
}

const MAX_FINISHED_QUERIES_PER_SOURCE = 200;
const MAX_FINISHED_QUERY_LENGTH = 300;

function finishedQueryList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const query of value) {
    if (typeof query !== 'string' || !query || query.length > MAX_FINISHED_QUERY_LENGTH || seen.has(query)) continue;
    seen.add(query);
    out.push(query);
    if (out.length >= MAX_FINISHED_QUERIES_PER_SOURCE) break;
  }
  return out;
}

/**
 * Normalize the saved per-platform query progress at the trust boundary.
 *
 * A platform blocked part-way through its queries keeps the ones it finished:
 * `finishedQueries` are the exact query texts, `bookmarkAt` is the platform's
 * bookmark those walks started from (null when it had none), `oldestStartedAt`
 * is the earliest run start among the walks that finished them, and
 * `locationKey` is the search location they were run for.
 */
export function normalizeSourceQueryProgress(raw) {
  const normalized = {};
  if (!isPlainRecord(raw)) return normalized;
  for (const sourceId of Object.keys(raw)) {
    if (!isSafeSourceId(sourceId)) continue;
    const entry = raw[sourceId];
    if (!isPlainRecord(entry)) continue;
    const finishedQueries = finishedQueryList(entry.finishedQueries);
    const oldestStartedAt = normalizeCompletionTimestamp(entry.oldestStartedAt);
    if (finishedQueries.length === 0 || oldestStartedAt == null) continue;
    normalized[sourceId] = {
      finishedQueries,
      oldestStartedAt,
      bookmarkAt: normalizeCompletionTimestamp(entry.bookmarkAt),
      locationKey: typeof entry.locationKey === 'string' ? entry.locationKey : '',
    };
  }
  return normalized;
}

/** Saved progress that still belongs to the platform's current bookmark. */
function currentSourceQueryProgress(data) {
  const progress = normalizeSourceQueryProgress(data?.sourceQueryProgress);
  const sourceCoverage = normalizeSourceCoverage(data?.sourceCoverage);
  const current = {};
  for (const sourceId of Object.keys(progress)) {
    const bookmarkAt = hasOwn(sourceCoverage, sourceId) ? sourceCoverage[sourceId].coverageStartedAt : null;
    if (progress[sourceId].bookmarkAt === bookmarkAt) current[sourceId] = progress[sourceId];
  }
  return current;
}

/**
 * Queries each platform already finished since its bookmark, for the next run
 * to skip. Only progress recorded for the same search location counts, and
 * only for the platforms taking part in this run.
 */
export function sourceFinishedQueriesForRun(data, sourceIds, searchLocationText) {
  const locationKey = String(searchLocationText || '').trim();
  const progress = currentSourceQueryProgress(data);
  const out = {};
  for (const sourceId of uniqueSourceIds(sourceIds)) {
    if (!hasOwn(progress, sourceId) || progress[sourceId].locationKey !== locationKey) continue;
    out[sourceId] = [...progress[sourceId].finishedQueries];
  }
  return out;
}

/**
 * Build the next `sourceCoverage` map for a completed (or capped) run.
 *
 * Seeding uses the PRE-commit hub history so a platform that did not finish,
 * or was turned off for this run, keeps its old bookmark even after the
 * hub-level date moves forward.
 */
export function buildSourceCoverageCommitPatch(
  data,
  {
    runId,
    collectionStartedAt,
    collectionCompletedAt,
    completedSourceIds,
    knownSourceIds,
    sourceQueryProgress,
    locationKey,
  },
  nodeId,
) {
  const start = normalizeCompletionTimestamp(collectionStartedAt);
  if (start == null) return {};
  const completed = normalizeCompletionTimestamp(collectionCompletedAt) ?? start;
  const next = normalizeSourceCoverage(data?.sourceCoverage);
  // Read against the PRE-commit bookmarks, before any of them move below.
  const priorProgress = currentSourceQueryProgress(data);

  const hubAnchor = jobSearchHistoricalAnchor(data, nodeId).timestamp;
  if (hubAnchor != null) {
    const seededCompletedAt = normalizeCompletionTimestamp(data?.lastCompletedRunAt) ?? hubAnchor;
    for (const sourceId of uniqueSourceIds(knownSourceIds)) {
      if (hasOwn(next, sourceId)) continue;
      next[sourceId] = {
        coverageStartedAt: hubAnchor,
        completedAt: seededCompletedAt,
        runId: null,
      };
    }
  }

  const advanceRunId = typeof runId === 'string' && runId.length > 0 ? runId : null;
  const completedIds = uniqueSourceIds(completedSourceIds);
  for (const sourceId of completedIds) {
    const existing = hasOwn(next, sourceId) ? next[sourceId] : null;
    // Some of this platform's queries may have finished in an earlier, blocked
    // run and been skipped here. They were only read up to THAT run's start, so
    // the bookmark moves to the oldest of the starts, never past it.
    const coveredFrom = hasOwn(priorProgress, sourceId)
      ? Math.min(start, priorProgress[sourceId].oldestStartedAt)
      : start;
    next[sourceId] = {
      coverageStartedAt: Math.max(existing?.coverageStartedAt ?? -Infinity, coveredFrom),
      completedAt: Math.max(existing?.completedAt ?? -Infinity, completed),
      runId: advanceRunId,
    };
  }

  // A finished platform starts clean. An unfinished one adds the queries this
  // run finished to those it already had, so the next run skips them all.
  const nextProgress = { ...priorProgress };
  for (const sourceId of completedIds) delete nextProgress[sourceId];
  const reported = isPlainRecord(sourceQueryProgress) ? sourceQueryProgress : {};
  for (const sourceId of Object.keys(reported)) {
    if (!isSafeSourceId(sourceId) || completedIds.includes(sourceId)) continue;
    const finished = finishedQueryList(reported[sourceId]?.finishedQueries);
    if (finished.length === 0) continue;
    const prior = hasOwn(priorProgress, sourceId) ? priorProgress[sourceId] : null;
    const sameLocation = prior && prior.locationKey === String(locationKey || '').trim();
    nextProgress[sourceId] = {
      finishedQueries: finishedQueryList([...(sameLocation ? prior.finishedQueries : []), ...finished]),
      oldestStartedAt: sameLocation ? Math.min(prior.oldestStartedAt, start) : start,
      bookmarkAt: null,
      locationKey: String(locationKey || '').trim(),
    };
  }
  // An unfinished platform's bookmark does not move in this commit, though the
  // seeding above may have just written it down for the first time. Tie every
  // kept entry to the bookmark as it now stands so it is still recognised next run.
  for (const sourceId of Object.keys(nextProgress)) {
    nextProgress[sourceId] = {
      ...nextProgress[sourceId],
      bookmarkAt: hasOwn(next, sourceId) ? next[sourceId].coverageStartedAt : null,
    };
  }
  const hadProgress = Object.keys(normalizeSourceQueryProgress(data?.sourceQueryProgress)).length > 0;
  return {
    sourceCoverage: next,
    ...(hadProgress || Object.keys(nextProgress).length > 0 ? { sourceQueryProgress: nextProgress } : {}),
  };
}

/**
 * Platforms that took part in a run and whose date will NOT move forward when
 * the staged result is committed. Each one re-reads the same days next scan,
 * so the caller warns loudly instead of letting it repeat unnoticed. A platform
 * whose date moves at all (even only to an earlier blocked run's start) made
 * progress and is not listed. `resumesFrom` is the date its next scan starts at.
 */
export function sourcesWithoutDateProgress(data, pendingSourceCoverage, nodeId, knownSourceIds = []) {
  const participating = uniqueSourceIds(pendingSourceCoverage?.participatingSourceIds);
  if (participating.length === 0) return [];
  const patch = buildSourceCoverageCommitPatch(data, { ...pendingSourceCoverage, knownSourceIds }, nodeId);
  if (!patch.sourceCoverage) return [];
  const before = normalizeSourceCoverage(data?.sourceCoverage);
  const after = patch.sourceCoverage;
  const afterData = { ...data, ...patch };
  return participating
    .filter(sourceId => !hasOwn(after, sourceId) || !hasOwn(before, sourceId)
      ? !uniqueSourceIds(pendingSourceCoverage?.completedSourceIds).includes(sourceId)
      : after[sourceId].coverageStartedAt <= before[sourceId].coverageStartedAt)
    .map(sourceId => ({ sourceId, resumesFrom: jobSearchSourceAnchor(afterData, nodeId, sourceId).timestamp }));
}

/**
 * Move a card's dates from the collection record kept with its saved scrape.
 *
 * The normal path stages a run's completion on the card when the search
 * response arrives and commits it at terminal cleanup. When that staging never
 * happened (the card declined it, or the app restarted first), the rows can
 * still be scored and shown from the saved scrape while every date stays put,
 * and the next scan re-walks days it already covered. The main process writes
 * the same facts into the saved scrape; this applies them once those rows are
 * on the card.
 *
 * Returns null when there is nothing proven to move:
 * - the record names a different run than the card's results;
 * - the card already holds a staged completion for this run (terminal cleanup
 *   owns that commit);
 * - nothing would move forward.
 * Each platform moves only if the record lists it as finished. The card-level
 * date moves only for a full collection.
 */
export function buildCollectionEvidenceCommitPatch(data, evidence, nodeId, knownSourceIds = []) {
  if (!isPlainRecord(evidence)) return null;
  const runId = typeof evidence.runId === 'string' && evidence.runId ? evidence.runId : null;
  if (!runId || data?.jobRunId !== runId) return null;
  if (data?.pendingCollectionCompletion?.runId === runId || data?.pendingSourceCoverage?.runId === runId) return null;
  const startedAt = normalizeCompletionTimestamp(evidence.startedAt);
  const completedAt = normalizeCompletionTimestamp(evidence.completedAt);
  if (startedAt == null || completedAt == null || completedAt < startedAt) return null;

  const patch = {};
  if (Array.isArray(evidence.completedSourceIds) && evidence.completedSourceIds.length > 0) {
    const before = normalizeSourceCoverage(data?.sourceCoverage);
    const { sourceCoverage, sourceQueryProgress: progressAfter } = buildSourceCoverageCommitPatch(data, {
      runId,
      collectionStartedAt: startedAt,
      collectionCompletedAt: completedAt,
      completedSourceIds: evidence.completedSourceIds,
      knownSourceIds,
    }, nodeId);
    const moved = uniqueSourceIds(evidence.completedSourceIds).some(sourceId => (
      !hasOwn(before, sourceId)
      || sourceCoverage[sourceId].coverageStartedAt > before[sourceId].coverageStartedAt
      || sourceCoverage[sourceId].completedAt > before[sourceId].completedAt
    ));
    if (moved) {
      patch.sourceCoverage = sourceCoverage;
      if (progressAfter) patch.sourceQueryProgress = progressAfter;
    }
  }
  if (evidence.disposition === 'full') {
    const previousCompletedAt = normalizeCompletionTimestamp(data?.lastCompletedRunAt);
    const previousCoverageStartedAt = normalizeCompletionTimestamp(data?.lastSearchCoverageStartedAt);
    if (previousCompletedAt == null || completedAt > previousCompletedAt) patch.lastCompletedRunAt = completedAt;
    if (previousCoverageStartedAt == null || startedAt > previousCoverageStartedAt) {
      patch.lastSearchCoverageStartedAt = startedAt;
    }
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Newest normalized completion recorded at the hub or on any platform. With
 * `sourceIds`, only those platforms count, so a platform that is switched off
 * cannot supply the date the card shows.
 */
export function latestSourceCompletedAt(data, sourceIds = null) {
  const timestamps = [];
  const hubCompletedAt = normalizeCompletionTimestamp(data?.lastCompletedRunAt);
  if (hubCompletedAt != null) timestamps.push(hubCompletedAt);
  const sourceCoverage = normalizeSourceCoverage(data?.sourceCoverage);
  const shown = Array.isArray(sourceIds) ? new Set(sourceIds) : null;
  for (const sourceId of Object.keys(sourceCoverage)) {
    if (shown && !shown.has(sourceId)) continue;
    timestamps.push(sourceCoverage[sourceId].completedAt);
  }
  return timestamps.length === 0 ? null : Math.max(...timestamps);
}

/** Platforms whose bookmark is older than the newest one, oldest first. */
export function sourcesBehindLatest(data, nodeId, sourceIds) {
  const normalizedCoverage = normalizeSourceCoverage(data?.sourceCoverage);
  const anchors = uniqueSourceIds(sourceIds)
    .map(sourceId => ({ sourceId, timestamp: jobSearchSourceAnchor(data, nodeId, sourceId, normalizedCoverage).timestamp }));
  if (anchors.length < 2) return [];
  const timestamps = anchors.map(anchor => anchor.timestamp).filter(timestamp => timestamp != null);
  if (timestamps.length === 0) return [];
  const newest = Math.max(...timestamps);
  return anchors
    .filter(anchor => anchor.timestamp != null && anchor.timestamp < newest)
    .sort((left, right) => left.timestamp - right.timestamp)
    .map(anchor => ({ sourceId: anchor.sourceId, coverageStartedAt: anchor.timestamp }));
}
