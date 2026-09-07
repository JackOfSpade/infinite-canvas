// A clear is durable node state, while analysis sidecars are canvas-scoped.
// Keep the eligibility rule independent of the renderer so it can be tested
// without mounting a JobSearchNode.
const MAX_JAVASCRIPT_DATE_MS = 8_640_000_000_000_000;

export function normalizeJobAnalysisClearWatermark(value) {
  const normalize = (timestamp) => (
    Number.isSafeInteger(timestamp)
      && timestamp > 0
      && Number.isFinite(new Date(timestamp).getTime())
      ? timestamp
      : null
  );
  if (typeof value === 'number') {
    return normalize(value);
  }
  // Persisted older canvases can contain JSON's decimal representation, but
  // never coerce booleans, whitespace, fractions, or Date.parse-like strings.
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    return normalize(Number(value));
  }
  return null;
}

export function nextJobAnalysisClearWatermark(previousValue, nowValue = Date.now()) {
  const previous = normalizeJobAnalysisClearWatermark(previousValue);
  const now = normalizeJobAnalysisClearWatermark(nowValue) ?? Date.now();
  if (previous == null) return now;
  // Do not overflow the JavaScript Date range just to advance a pathological
  // persisted value. At its absolute maximum every real current sidecar is
  // already older; retaining that valid maximum is safer than writing an
  // invalid watermark that future readers would silently discard.
  const afterPrevious = previous < MAX_JAVASCRIPT_DATE_MS ? previous + 1 : previous;
  return Math.max(now, afterPrevious);
}

// A clear can share its Date.now() millisecond with a newly-started run. Keep
// the cleared run token beside the watermark so that tie has a durable,
// deterministic ordering after an app restart. This deliberately mirrors the
// main-process sidecar identifier contract: no coercion and no broad
// user-provided strings become recovery provenance.
export function normalizeJobAnalysisClearRunId(value) {
  if (typeof value !== 'string') return null;
  const runId = value.trim();
  return runId.length > 0
    && runId.length <= 200
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(runId)
    ? runId
    : null;
}

function snapshotCreatedAtMs(value) {
  const normalize = (timestamp) => (
    Number.isSafeInteger(timestamp)
      && timestamp > 0
      && Number.isFinite(new Date(timestamp).getTime())
      ? timestamp
      : null
  );
  if (typeof value === 'number') return normalize(value);
  if (typeof value !== 'string') return null;
  return normalize(Date.parse(value));
}

export function isJobAnalysisSnapshotAfterClear(snapshot, meta, jobAnalysisClearedAt, jobAnalysisClearedRunId = null) {
  const watermark = normalizeJobAnalysisClearWatermark(jobAnalysisClearedAt);
  // A missing watermark means this hub has never explicitly cleared its
  // recovery material, so retain backwards compatibility with old snapshots.
  if (!Number.isFinite(watermark) || watermark <= 0) return true;

  const createdAt = snapshotCreatedAtMs(meta?.createdAt ?? snapshot?.createdAt);
  if (createdAt == null) return false;

  // A delayed write from the exact run that was cleared is never recoverable,
  // even if its timestamp arrives after the clear boundary. The main process
  // applies the same exact-run tombstone before it writes sidecars.
  const clearedRunId = normalizeJobAnalysisClearRunId(jobAnalysisClearedRunId);
  const snapshotRunId = normalizeJobAnalysisClearRunId(meta?.runId ?? snapshot?.runId);
  if (clearedRunId && snapshotRunId === clearedRunId) return false;

  if (createdAt > watermark) return true;
  // Date.now has millisecond precision. At the exact boundary, a separately
  // identified run is newer than the cleared one; legacy hubs without the
  // persisted token stay conservative and keep the historical `>` rule.
  return createdAt === watermark && !!clearedRunId && !!snapshotRunId;
}

// `discard-job-analysis-snapshot` reports ownership per artifact. A completely
// absent bundle, or one proven to belong to another hub, is an expected no-op;
// everything else that fails needs an honest warning because old recovery data
// may still be resumable.
export function careerFilesCleanupNeedsWarning(cleanup) {
  for (const { kind, status, value } of cleanup) {
    if (status === 'rejected' || value?.success !== true) return true;
    if (kind !== 'analysis') {
      if (value?.ok !== true) return true;
      continue;
    }
    if (value?.reason === 'cleanup-failed') return true;
    if (value?.ok !== true) {
      const artifacts = Object.values(value?.artifacts || {});
      const safeForeignNoop = value?.reason === 'ownership-mismatch'
        && artifacts.length > 0
        && artifacts.every(artifact => ['missing', 'ownership-mismatch', 'foreign-paired', 'post-clear', 'post-clear-paired', 'cleared'].includes(artifact?.state));
      if (!safeForeignNoop) return true;
    }
  }
  return false;
}
