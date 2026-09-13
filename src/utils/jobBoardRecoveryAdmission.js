import { normalizeLocationInput } from './jobLocation.js';

function normalizeResumeProfileFingerprint(value) {
  const fingerprint = typeof value === 'string' ? value.trim() : '';
  return /^[a-f0-9]{64}$/.test(fingerprint) ? fingerprint : '';
}

// The Board's disabled-platform recovery affordance is deliberately narrower
// than normal Search readiness.  It may reuse the manifest's frozen provider
// breadth, but only after proving that the manifest is still the exact,
// location-safe run owned by this Search.  Keeping the policy pure makes the
// click-time and lane-time checks testable without mounting a React node.
export function exactInterruptedRecoveryAdmission({
  info,
  nodeId,
  sourceData,
  platformsVerifying = false,
} = {}) {
  if (platformsVerifying) return { ok: false, reason: 'platforms-verifying' };
  if (!info?.found) return { ok: false, reason: 'not-found' };
  if (info.resumable !== true) return { ok: false, reason: 'not-resumable' };
  if (typeof nodeId !== 'string' || !nodeId || info.nodeId !== nodeId) {
    return { ok: false, reason: 'wrong-owner' };
  }
  if (typeof info.runId !== 'string' || !info.runId.trim()) {
    return { ok: false, reason: 'missing-run-id' };
  }
  if (!(sourceData?.resumeProfile && typeof sourceData.resumeProfile === 'object'
    && !Array.isArray(sourceData.resumeProfile))) {
    return { ok: false, reason: 'missing-profile' };
  }
  // A profile object alone is not an identity contract: it can have been
  // replaced after the interrupted rows were staged. The parse pipeline's
  // full-content fingerprint is opaque, but pins recovery to that exact input
  // without sending any career material through this admission boundary.
  const sourceFingerprint = normalizeResumeProfileFingerprint(sourceData?.resumeFingerprint);
  const manifestFingerprint = normalizeResumeProfileFingerprint(info.profileFingerprint);
  if (!manifestFingerprint) return { ok: false, reason: 'missing-profile-fingerprint' };
  if (!sourceFingerprint) return { ok: false, reason: 'missing-current-profile-fingerprint' };
  if (sourceFingerprint !== manifestFingerprint) {
    return { ok: false, reason: 'profile-fingerprint-mismatch' };
  }
  const queries = Array.isArray(info.queries)
    ? info.queries.filter(query => typeof query === 'string' && query.trim())
    : [];
  if (queries.length === 0) return { ok: false, reason: 'missing-queries' };
  if (info.locationRecorded !== true) return { ok: false, reason: 'missing-location' };

  const sourceLocation = normalizeLocationInput(
    sourceData.canonicalLocation || sourceData.preferredLocation || '',
  ).boardReady;
  const manifestLocation = normalizeLocationInput(info.canonicalLocation || '').boardReady;
  if (sourceLocation !== manifestLocation) return { ok: false, reason: 'location-mismatch' };

  return {
    ok: true,
    runId: info.runId,
    queries,
    canonicalLocation: manifestLocation,
    profileFingerprint: manifestFingerprint,
  };
}

export function canAdmitExactInterruptedRecovery(options) {
  return exactInterruptedRecoveryAdmission(options).ok;
}

// `resumeRunId` is a compare-and-clear capability. When the main process
// reports that it vanished or was replaced after the Board's preflight, keep
// that result in the recovery lane instead of treating it as an ordinary
// provider failure. Keeping this classification pure makes the renderer's
// token-failure path directly testable.
export function exactInterruptedRecoveryBackendFailure(result, expectedRunId) {
  const runId = typeof expectedRunId === 'string' ? expectedRunId.trim() : '';
  if (!runId || result?.success !== false) return null;

  const reason = result.resumeRunMismatch === true
    ? 'run-mismatch'
    : result.resumeRunMissing === true
      ? 'run-missing'
      : result.resumeProfileMismatch === true
        ? 'profile-mismatch'
        : result.resumeProfileMissing === true
          ? 'profile-missing'
      : null;
  if (!reason) return null;

  return {
    reason,
    runId,
    error: typeof result.error === 'string' && result.error.trim()
      ? result.error
      : 'The saved Job Search recovery changed before the Job Board could resume it.',
  };
}
