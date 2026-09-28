export const STALE_MANUAL_AI_RESUME_MS = 24 * 60 * 60 * 1000;

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
// marker may do that automatically; an unknown, future, or aged timestamp must
// wait for an explicit Resume/Start fresh decision.
export function isStaleOrdinaryManualAiResume(resume, now = Date.now()) {
  if (
    !resume?.runId
    || resume.retirementPending
    || isSavedScrapeManualAiResume(resume)
  ) return false;
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
