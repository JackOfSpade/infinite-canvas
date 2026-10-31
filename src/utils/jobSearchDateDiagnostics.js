// Observation only: these receipts never participate in search admission or
// date-window selection. Keep a small saved history through result clearing.
import { normalizeCompletionTimestamp } from './completionTimestamp.js';

export const JOB_SEARCH_DATE_DIAGNOSTICS_LIMIT = 8;
const EVENTS = new Set(['collection', 'finalization', 'clear']);
const REASONS = new Set([
  'full-collection-staged', 'user-finished-partial', 'unfinished-sources',
  'completion-committed', 'terminal-not-completed', 'partial-collection',
  'missing-pending-completion', 'pending-run-mismatch', 'pending-career-mismatch',
  'invalid-pending-completion', 'finalization-failed',
  'clear-scrape', 'clear-career', 'clear-all',
]);
const DISPOSITIONS = new Set(['full', 'user-finished-partial', 'unfinished-sources', 'unknown']);
const TIMESTAMPS = [
  'previousCompletedAt', 'previousCoverageStartedAt', 'nextCompletedAt',
  'nextCoverageStartedAt', 'collectionStartedAt', 'collectionCompletedAt',
];

function timestamp(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 8.64e15 ? value : null;
}

function sanitizeEntry(value) {
  if (!value || value.version !== 1 || !EVENTS.has(value.event)
    || !REASONS.has(value.reason) || timestamp(value.recordedAt) == null) return null;
  const entry = {
    version: 1,
    event: value.event,
    // Run IDs are opaque local correlation only. Reports hash them.
    runId: typeof value.runId === 'string' && /^[A-Za-z0-9._:-]{1,180}$/.test(value.runId)
      ? value.runId : null,
    recordedAt: value.recordedAt,
    reason: value.reason,
    collectionDisposition: DISPOSITIONS.has(value.collectionDisposition)
      ? value.collectionDisposition : 'unknown',
  };
  for (const field of TIMESTAMPS) entry[field] = timestamp(value[field]);
  return entry;
}

export function sanitizeJobSearchDateDiagnostics(value) {
  return Array.isArray(value)
    ? value.slice(-JOB_SEARCH_DATE_DIAGNOSTICS_LIMIT).map(sanitizeEntry).filter(Boolean)
    : [];
}

export function jobSearchDateDiagnosticPatch(data, {
  event, reason, runId = null, searchResult = null, nextData = data, recordedAt = Date.now(),
} = {}) {
  const history = sanitizeJobSearchDateDiagnostics(data?.jobSearchDateDiagnostics);
  const priorCollection = runId
    ? history.findLast(entry => entry.runId === runId && entry.collectionDisposition !== 'unknown')
    : null;
  const collectionDisposition = searchResult
    ? searchResult.collectionDisposition === 'user-finished-partial'
      ? 'user-finished-partial'
      : searchResult.hasUnfinishedSources === true ? 'unfinished-sources' : 'full'
    : priorCollection?.collectionDisposition || 'unknown';
  const entry = sanitizeEntry({
    version: 1, event, reason, runId, recordedAt, collectionDisposition,
    previousCompletedAt: normalizeCompletionTimestamp(data?.lastCompletedRunAt),
    previousCoverageStartedAt: normalizeCompletionTimestamp(data?.lastSearchCoverageStartedAt),
    nextCompletedAt: normalizeCompletionTimestamp(nextData?.lastCompletedRunAt),
    nextCoverageStartedAt: normalizeCompletionTimestamp(nextData?.lastSearchCoverageStartedAt),
    collectionStartedAt: searchResult
      ? normalizeCompletionTimestamp(searchResult.collectionStartedAt) : priorCollection?.collectionStartedAt,
    collectionCompletedAt: searchResult
      ? normalizeCompletionTimestamp(searchResult.collectionCompletedAt) : priorCollection?.collectionCompletedAt,
  });
  return { jobSearchDateDiagnostics: entry
    ? [...history, entry].slice(-JOB_SEARCH_DATE_DIAGNOSTICS_LIMIT) : history };
}

export function jobSearchDateRetentionReason(data, { runId, terminalStatus, careerSnapshotId } = {}) {
  if (terminalStatus !== 'completed') return 'terminal-not-completed';
  if (data?.partialCollectionRunId === runId) return 'partial-collection';
  const pending = data?.pendingCollectionCompletion;
  if (!pending) return 'missing-pending-completion';
  if (pending.runId !== runId) return 'pending-run-mismatch';
  if (careerSnapshotId && pending.careerSnapshotId !== careerSnapshotId) return 'pending-career-mismatch';
  return 'invalid-pending-completion';
}
