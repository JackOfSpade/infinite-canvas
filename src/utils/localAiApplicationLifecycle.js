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
]);

export function canRegenerateLocalApplication(localApplication) {
  return REPLACEABLE_LOCAL_APPLICATION_STATUSES.has(localApplication?.status);
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
