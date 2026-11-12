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

/** Prefer a platform's own bookmark; otherwise fall back to the hub anchor. */
export function jobSearchSourceAnchor(data, nodeId, sourceId) {
  if (isSafeSourceId(sourceId)) {
    const sourceCoverage = normalizeSourceCoverage(data?.sourceCoverage);
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
  let runWindow = null;
  let runAnchor = null;
  for (const sourceId of ids) {
    const anchor = jobSearchSourceAnchor(data, nodeId, sourceId);
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
  },
  nodeId,
) {
  const start = normalizeCompletionTimestamp(collectionStartedAt);
  if (start == null) return {};
  const completed = normalizeCompletionTimestamp(collectionCompletedAt) ?? start;
  const next = normalizeSourceCoverage(data?.sourceCoverage);

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
  for (const sourceId of uniqueSourceIds(completedSourceIds)) {
    const existing = hasOwn(next, sourceId) ? next[sourceId] : null;
    next[sourceId] = {
      coverageStartedAt: Math.max(existing?.coverageStartedAt ?? -Infinity, start),
      completedAt: Math.max(existing?.completedAt ?? -Infinity, completed),
      runId: advanceRunId,
    };
  }

  return { sourceCoverage: next };
}

/** Newest normalized completion recorded at the hub or on any platform. */
export function latestSourceCompletedAt(data) {
  const timestamps = [];
  const hubCompletedAt = normalizeCompletionTimestamp(data?.lastCompletedRunAt);
  if (hubCompletedAt != null) timestamps.push(hubCompletedAt);
  const sourceCoverage = normalizeSourceCoverage(data?.sourceCoverage);
  for (const sourceId of Object.keys(sourceCoverage)) {
    timestamps.push(sourceCoverage[sourceId].completedAt);
  }
  return timestamps.length === 0 ? null : Math.max(...timestamps);
}

/** Platforms whose bookmark is older than the newest one, oldest first. */
export function sourcesBehindLatest(data, nodeId, sourceIds) {
  const anchors = uniqueSourceIds(sourceIds)
    .map(sourceId => ({ sourceId, timestamp: jobSearchSourceAnchor(data, nodeId, sourceId).timestamp }));
  if (anchors.length < 2) return [];
  const timestamps = anchors.map(anchor => anchor.timestamp).filter(timestamp => timestamp != null);
  if (timestamps.length === 0) return [];
  const newest = Math.max(...timestamps);
  return anchors
    .filter(anchor => anchor.timestamp != null && anchor.timestamp < newest)
    .sort((left, right) => left.timestamp - right.timestamp)
    .map(anchor => ({ sourceId: anchor.sourceId, coverageStartedAt: anchor.timestamp }));
}
