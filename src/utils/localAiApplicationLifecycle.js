/**
 * Pure Local AI card lifecycle decisions.
 *
 * A job-card component can unmount because a board is hidden, which is not
 * the same thing as deleting its canvas node. Keep those two outcomes
 * explicit so async IPC results cannot orphan private job folders or save a
 * deleted card's documents.
 */
const REPLACEABLE_LOCAL_APPLICATION_STATUSES = new Set([
  'saved',
  'invalid',
  'failed',
  'revision-exhausted',
  // The status poll's non-terminal answer for a job written by another app
  // build: nothing is recorded against the job, and its message names
  // Generate as one of the two ways forward.
  'blocked',
]);

export function canRegenerateLocalApplication(localApplication) {
  return !hasLinkedLocalApplicationOutput(localApplication)
    && REPLACEABLE_LOCAL_APPLICATION_STATUSES.has(localApplication?.status);
}

// Only the main process's missing-output verdict releases a saved link. Keep
// it protected during a status error or while the mount-time probe is pending.
export function hasLinkedLocalApplicationOutput(localApplication) {
  return !!localApplication && localApplication.savedOutputMissing !== true
    && localApplication.savedReceiptMissing !== true
    && (localApplication.status === 'saved' || !!localApplication.savedDir || !!localApplication.receipt?.outputDir);
}

// A Generate click can wait for dock capacity while its live card changes.
// Re-evaluate the operational fences before creating a private handoff, and
// admit obsolete queue entries so they can retire without waiting for a slot.
export function queuedLocalApplicationStartDecision(node, owningBoard = null) {
  if (node?.type !== 'jobcard') return { allowed: false, reason: 'card-missing' };
  if (node.data?.locked || owningBoard?.data?.locked) return { allowed: false, reason: 'card-locked' };
  const current = node.data?.localApplication;
  if (hasLinkedLocalApplicationOutput(current)) return { allowed: false, reason: 'bundle-saved' };
  if (current && !canRegenerateLocalApplication(current)) return { allowed: false, reason: 'handoff-pending' };
  return { allowed: true };
}

/**
 * Regeneration is the only renderer action that may retire a prior Local AI
 * handoff. It may happen only after a newly queued replacement was accepted by
 * the live card, and it may target only the exact terminal handoff the user
 * chose to replace.
 */
export function replacedLocalApplicationForCleanup(prior, replacement, replacementAccepted) {
  if (!replacementAccepted || !replacement?.id || !prior?.id || prior.id === replacement.id) return null;
  return canRegenerateLocalApplication(prior) ? prior : null;
}

export function queuedLocalApplicationSettlement(node, localJob, expectedPriorLocalApplication = null) {
  if (!localJob?.id || node?.type !== 'jobcard') {
    return { action: 'discard', reason: node ? 'invalid-card' : 'card-missing' };
  }
  const current = node.data?.localApplication;
  // Do not let a late first request overwrite a newer handoff for the same
  // card. A deliberate regeneration is the one exception: the caller records
  // the exact terminal handoff it intends to replace before queueing, and the
  // live node must still own that same id/status when the response settles.
  if (current?.id && current.id !== localJob.id) {
    const replacesExpectedTerminal = current.id === expectedPriorLocalApplication?.id
      && current.status === expectedPriorLocalApplication?.status
      && canRegenerateLocalApplication(current);
    if (!replacesExpectedTerminal) return { action: 'discard', reason: 'handoff-changed' };
  }
  return { action: 'persist', localJob };
}

export function canSaveImportedLocalApplication(node, jobId) {
  return Boolean(
    jobId
      && node?.type === 'jobcard'
      && node?.data?.localApplication?.id === jobId,
  );
}
