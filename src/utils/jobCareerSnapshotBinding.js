// Versioned binding for renderer-held career-derived state.  A snapshot id is
// the authority boundary; fingerprints and projections can coincide across
// distinct approved source records, so they are never sufficient cache keys.

export const JOB_CAREER_QUERY_CACHE_STRATEGY_VERSION = 7;

export function normalizedJobCareerSnapshotId(value) {
  const snapshotId = typeof value === 'string' ? value.trim() : '';
  return /^[a-f0-9]{64}$/u.test(snapshotId) ? snapshotId : null;
}

export function careerSnapshotBindingMatches(metadata, careerSnapshotId) {
  const expected = normalizedJobCareerSnapshotId(careerSnapshotId);
  return !!expected && normalizedJobCareerSnapshotId(metadata?.careerSnapshotId) === expected;
}

// A terminal/recovery write must remain bound to both the exact Job Search
// generation and the immutable career corpus that authorized it.  Keeping
// this comparison central prevents a late async callback from updating a new
// run that happens to reuse the same canvas node.
export function exactJobRunCareerSnapshotBindingMatches(metadata, {
  runId,
  careerSnapshotId,
} = {}) {
  const expectedRunId = typeof runId === 'string' ? runId.trim() : '';
  return !!expectedRunId
    && metadata?.jobRunId === expectedRunId
    && careerSnapshotBindingMatches(metadata, careerSnapshotId);
}

// Provider completion is the one intentional null-run transition: the fresh
// renderer has dispatched a backend run but has not yet copied its token onto
// the hub.  It may claim that token exactly once while still in the captured
// searching state. A resumed run already has to match exactly.
export function canClaimJobRunCollectionCompletion(metadata, {
  runId,
  careerSnapshotId,
  hubState = 'searching',
} = {}) {
  const expectedRunId = typeof runId === 'string' ? runId.trim() : '';
  return !!expectedRunId
    && hubState === 'searching'
    && metadata?.hubState === hubState
    && careerSnapshotBindingMatches(metadata, careerSnapshotId)
    && (metadata?.jobRunId == null || metadata.jobRunId === expectedRunId);
}

export function buildJobCareerQueryCacheKey({
  careerSnapshotId,
  resumeFingerprint,
  jobPreferences,
  preferredLocation,
} = {}) {
  const snapshotId = normalizedJobCareerSnapshotId(careerSnapshotId);
  // A missing/legacy id deliberately produces no reusable key. Callers must
  // require a current approved pin before accepting this value.
  if (!snapshotId) return null;
  return JSON.stringify({
    strategyVersion: JOB_CAREER_QUERY_CACHE_STRATEGY_VERSION,
    careerSnapshotId: snapshotId,
    resumeFingerprint: String(resumeFingerprint || ''),
    jobPreferences: String(jobPreferences || '').trim(),
    preferredLocation: String(preferredLocation || '').trim(),
  });
}
