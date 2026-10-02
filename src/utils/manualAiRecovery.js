import { JOB_SEARCH_MAX_PROVIDER_LOOKBACK_DAYS } from './jobSearchDateWindow.js';

export const STALE_MANUAL_AI_RESUME_MS = 24 * 60 * 60 * 1000;
export const MANUAL_AI_PRE_SEARCH_RECOVERY_VERSION = 1;

const JOB_SEARCH_WINDOW_CAP_REASONS = new Set([
  'no-completion',
  'invalid-completion',
  'future-completion',
  'older-than-max-lookback',
  'legacy-max-age-days',
]);

function nonEmptyIdentifier(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validTimestamp(value) {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0
    && Number.isFinite(new Date(value).getTime());
}

function validSha256Fingerprint(value) {
  const fingerprint = typeof value === 'string' ? value.trim() : '';
  return /^[a-f0-9]{64}$/.test(fingerprint) ? fingerprint : '';
}

// This mirrors the persisted Job Search window contract without importing an
// Electron-only staging module into the renderer.  A pre-search manual-AI
// pause has no staging manifest yet, so this is its durable, exact boundary.
function normalizeFrozenJobSearchWindow(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const startTimestamp = validTimestamp(value.startTimestamp)
    ? value.startTimestamp
    : null;
  const rawProviderLookbackDays = value.providerLookbackDays;
  const providerLookbackDays = (typeof rawProviderLookbackDays === 'number'
    || (typeof rawProviderLookbackDays === 'string' && rawProviderLookbackDays.trim()))
    ? Number(rawProviderLookbackDays)
    : NaN;
  if (startTimestamp == null
    || !Number.isSafeInteger(providerLookbackDays)
    || providerLookbackDays < 1
    || providerLookbackDays > JOB_SEARCH_MAX_PROVIDER_LOOKBACK_DAYS) return null;

  // `anchorTimestamp` is derived from the exact start.  Accept old windows
  // that omitted it, but never turn a contradictory anchor into a recovery
  // that could silently shift the search boundary.
  if (value.anchorTimestamp != null
    && (!validTimestamp(value.anchorTimestamp) || value.anchorTimestamp !== startTimestamp)) {
    return null;
  }

  const completionTimestamp = value.completionTimestamp == null
    ? null
    : validTimestamp(value.completionTimestamp)
      ? value.completionTimestamp
      : null;
  if (value.completionTimestamp != null && completionTimestamp == null) return null;

  if (typeof value.capped !== 'boolean') return null;
  const capReason = value.capReason == null ? null : value.capReason;
  if (capReason != null
    && (typeof capReason !== 'string' || !JOB_SEARCH_WINDOW_CAP_REASONS.has(capReason))) {
    return null;
  }

  return {
    startTimestamp,
    anchorTimestamp: startTimestamp,
    completionTimestamp,
    capped: value.capped,
    capReason,
    providerLookbackDays,
  };
}

function normalizeManualAiPreSearchRecovery(value, { requireVersion = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (requireVersion ? value.version !== MANUAL_AI_PRE_SEARCH_RECOVERY_VERSION
    : value.version != null && value.version !== MANUAL_AI_PRE_SEARCH_RECOVERY_VERSION) {
    return null;
  }

  const manualAiRunId = nonEmptyIdentifier(value.manualAiRunId);
  const nodeId = nonEmptyIdentifier(value.nodeId);
  const startedAt = validTimestamp(value.startedAt) ? value.startedAt : null;
  const searchWindow = normalizeFrozenJobSearchWindow(value.searchWindow);
  const profileFingerprint = value.profileFingerprint == null
    ? ''
    : validSha256Fingerprint(value.profileFingerprint);
  if (!manualAiRunId || !nodeId || startedAt == null || !searchWindow
    || (value.profileFingerprint != null && !profileFingerprint)) return null;

  return {
    version: MANUAL_AI_PRE_SEARCH_RECOVERY_VERSION,
    manualAiRunId,
    nodeId,
    searchWindow,
    ...(profileFingerprint ? { profileFingerprint } : {}),
    startedAt,
  };
}

/**
 * Create the durable capability for a manual-AI pause before a provider run
 * has been staged.  The saved date boundary belongs to this workflow start;
 * a later Resume must pass it through unchanged rather than resolve "today"
 * again.
 */
export function createManualAiPreSearchRecovery(value) {
  return normalizeManualAiPreSearchRecovery(value);
}

/**
 * Return a validated pre-search recovery only when the persisted marker and
 * current hub both prove exact ownership.  This is intentionally fail-closed:
 * a malformed or mismatched descriptor may be inspected or started fresh, but
 * must never become authority for an old provider search.
 */
export function manualAiPreSearchRecoveryForResume(resume, { runId, nodeId } = {}) {
  const expectedRunId = nonEmptyIdentifier(runId);
  const expectedNodeId = nonEmptyIdentifier(nodeId);
  if (!resume || typeof resume !== 'object' || Array.isArray(resume)
    || !expectedRunId || !expectedNodeId || resume.runId !== expectedRunId) {
    return null;
  }
  const recovery = normalizeManualAiPreSearchRecovery(resume.preSearchRecovery, {
    requireVersion: true,
  });
  if (!recovery
    || recovery.manualAiRunId !== expectedRunId
    || recovery.nodeId !== expectedNodeId) return null;
  return recovery;
}

const SAVED_SCRAPE_MANUAL_AI_RECOVERY_MODES = new Set([
  'resume-saved-scrape',
  'append-scored-jobs',
]);

export function isSavedScrapeManualAiResume(resume) {
  return resume?.task === 'job-scoring'
    || SAVED_SCRAPE_MANUAL_AI_RECOVERY_MODES.has(resume?.recoveryMode);
}

// Board selection returns `{ missingPlan: true }` for an orphan so the caller
// can retire it. That diagnostic object is deliberately not execution
// authority for an otherwise stale manual-AI handoff.
export function isLiveManualAiRecoveryBoardOwner(owner) {
  return !!owner && owner.missingPlan !== true;
}

// A normal manual handoff can restart a provider search. Only a valid, recent
// marker may do that automatically; an explicit user stop, unknown, future,
// or aged timestamp must wait for an explicit Resume/discard decision.
export function isStaleOrdinaryManualAiResume(resume, now = Date.now()) {
  if (
    !resume?.runId
    || resume.retirementPending
    || isSavedScrapeManualAiResume(resume)
  ) return false;
  // A pre-provider handoff has no staging manifest to surface in the ordinary
  // job-run Resume banner. Treat an explicit Stop as an action-required
  // recovery marker so the existing Resume affordance remains visible while
  // the automatic recovery effect is fenced off.
  if (resume.pausedByUser === true) return true;
  const updatedAt = resume.updatedAt;
  return typeof updatedAt !== 'number'
    || !Number.isFinite(updatedAt)
    || updatedAt <= 0
    || updatedAt > now
    || now - updatedAt >= STALE_MANUAL_AI_RESUME_MS;
}

// A run id alone is not authority to consume an old handoff: generic code can
// mint one. The renderer records a synchronous capability only for the exact
// Resume click, while a Board must prove it owns this recovery separately.
export function staleOrdinaryManualAiResumeBlocksAdmission(resume, {
  manualAiRunId = null,
  explicitResumeRunId = null,
  boardOwnsRecovery = false,
} = {}) {
  if (!isStaleOrdinaryManualAiResume(resume)) return false;
  return !boardOwnsRecovery && !(
    typeof resume?.runId === 'string'
    && resume.runId === manualAiRunId
    && resume.runId === explicitResumeRunId
  );
}
