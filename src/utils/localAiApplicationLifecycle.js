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

// A saved bundle prevents duplicate generation, but does not own a posting
// lookup. Other unresolved Local AI states keep their existing busy fence.
export function localApplicationBlocksOfficialPostingLookup(localApplication) {
  return !!localApplication && localApplication.status !== 'saved'
    && !canRegenerateLocalApplication(localApplication);
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
export function queuedLocalApplicationStartDecision(node, owningBoard = null, documentScope = null) {
  if (node?.type !== 'jobcard') return { allowed: false, reason: 'card-missing' };
  if (node.data?.locked || owningBoard?.data?.locked) return { allowed: false, reason: 'card-locked' };
  const current = node.data?.localApplication;
  // A saved folder blocks only the document it already holds.
  if (documentScope) {
    if (savedApplicationDocuments(node.data)[documentScope]) return { allowed: false, reason: 'bundle-saved' };
    if (localApplicationBlocksOfficialPostingLookup(current)) return { allowed: false, reason: 'handoff-pending' };
    return { allowed: true };
  }
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
    // A second document stacks on a saved one: the saved pointer moves aside to
    // priorSavedApplication rather than being retired.
    const stacksOnSaved = hasLinkedLocalApplicationOutput(current)
      && (localJob.documentScope === 'resume' || localJob.documentScope === 'cover')
      && !documentsOfSavedPointer(current)[localJob.documentScope];
    const replacesExpectedTerminal = current.id === expectedPriorLocalApplication?.id
      && current.status === expectedPriorLocalApplication?.status
      && (canRegenerateLocalApplication(current) || stacksOnSaved);
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

// ---------------------------------------------------------------------------
// Résumé and Cover letter buttons
// ---------------------------------------------------------------------------
//
// One card drives one job at a time through `data.localApplication`. While a
// second document's job holds that pointer, the saved job it replaced waits in
// `data.priorSavedApplication`, so the first document stays visible and openable.

const NO_DOCUMENTS = Object.freeze({ resume: false, cover: false });

// A job created before the split has no scope and produces both documents, and
// a saved pointer from then has no record of what it holds: both, by default.
function documentsOfJob(local) {
  if (local?.documentScope === 'resume') return { resume: true, cover: false };
  if (local?.documentScope === 'cover') return { resume: false, cover: true };
  return { resume: true, cover: true };
}

function documentsOfSavedPointer(local) {
  const saved = local?.savedDocuments;
  if (saved && typeof saved.resume === 'boolean' && typeof saved.cover === 'boolean') return saved;
  return documentsOfJob(local);
}

/** The saved pointer this card can open right now, whichever field holds it. */
export function savedApplicationPointer(data) {
  if (hasLinkedLocalApplicationOutput(data?.localApplication)) return data.localApplication;
  return hasLinkedLocalApplicationOutput(data?.priorSavedApplication) ? data.priorSavedApplication : null;
}

/** Which documents exist in this card's saved folder. */
export function savedApplicationDocuments(data) {
  const local = data?.localApplication;
  if (hasLinkedLocalApplicationOutput(local)) {
    if (local.savedDocuments) return documentsOfSavedPointer(local);
    // Saved, but this pointer has not yet read its folder back. A merge can only
    // have added to what the earlier pointer already held.
    const own = documentsOfJob(local);
    const prior = hasLinkedLocalApplicationOutput(data?.priorSavedApplication) ? documentsOfSavedPointer(data.priorSavedApplication) : NO_DOCUMENTS;
    return { resume: own.resume || prior.resume, cover: own.cover || prior.cover };
  }
  return hasLinkedLocalApplicationOutput(data?.priorSavedApplication) ? documentsOfSavedPointer(data.priorSavedApplication) : NO_DOCUMENTS;
}

/** Which documents this card's unfinished job is producing. */
export function activeApplicationDocuments(data) {
  const local = data?.localApplication;
  return local && localApplicationBlocksOfficialPostingLookup(local) ? documentsOfJob(local) : NO_DOCUMENTS;
}

/**
 * @param runningDocument the document whose run is being prepared or queued in
 *   this renderer, before any job pointer exists.
 */
export function applicationDocumentButtonState(kind, { data, runningDocument = null } = {}) {
  const exists = savedApplicationDocuments(data)[kind] === true;
  const inProgress = activeApplicationDocuments(data)[kind] === true || runningDocument === kind;
  const queued = data?.queuedApplicationDocument === kind;
  return { exists, inProgress, queued, disabled: exists || inProgress || queued };
}

/** A job is busy, or being set up, so another document has to wait its turn. */
export function applicationDocumentMustWait(data, runningDocument = null) {
  return Boolean(runningDocument) || localApplicationBlocksOfficialPostingLookup(data?.localApplication || null);
}

/**
 * What the card holds after one job is discarded: the saved document that job
 * was stacked on, if any. Null when this discard did not target the live job.
 */
export function localApplicationAfterDiscard(data, jobId) {
  if (data?.localApplication?.id !== jobId) return null;
  return { localApplication: data?.priorSavedApplication || null, priorSavedApplication: null };
}
