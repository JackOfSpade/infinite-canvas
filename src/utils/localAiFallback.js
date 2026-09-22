/**
 * Shared plumbing between JobCardNode's mounted Local AI workflow and the
 * canvas-level fallback manager (useLocalAiFallbackManager).
 *
 * Why this exists: the Local AI handoff used to be driven ONLY by a poll
 * interval inside JobCardNode. Hidden cards unmount (collapse, a board hiding
 * stale results, nested-canvas navigation), which silently killed the poll —
 * A local coding agent would write result.json and wait forever on a manifest nobody
 * was ever going to update. The canvas-level manager keeps every pending job
 * alive; this module gives both drivers one source of truth for who owns a
 * job at any moment (exactly one driver: the mounted card if there is one,
 * otherwise the manager).
 */

export const LOCAL_AI_RESULT_SETTLE_MS = 6_000;
export const LOCAL_AI_POLL_INTERVAL_MS = 2_500;

// A transient status-IPC failure (a canvas re-save renaming files under the
// resolver, a momentary FS error) is surfaced only after this many consecutive
// failing polls. Drivers label it `status-error`, which remains pollable, so a
// later successful check reconnects the handoff automatically.
export const LOCAL_AI_STATUS_ERROR_STREAK_LIMIT = 3;

// Statuses the MOUNTED CARD's poll loop leaves alone (JobCardNode's effect).
// 'importing' is here because the card is itself mid-import when it holds it.
export const LOCAL_AI_CARD_POLL_IDLE_STATUSES = Object.freeze([
  'saved', 'failed', 'importing', 'render-retry-required',
]);

// Statuses the FALLBACK MANAGER leaves alone. Deliberately narrower than the
// card's list: a persisted 'importing' with NO mounted card means the driving
// renderer died (or the card unmounted mid-import) — the on-disk job is safe
// to validate again, so the manager resumes it. An import genuinely still
// running in the main process rejects the retry with LOCAL_AI_IMPORT_IN_FLIGHT,
// which the manager treats as "wait for the next tick". A manual render retry
// also remains manager-owned while its card is hidden so the canvas can expose
// the hash-bound retry action without automatically re-importing the result.
export const LOCAL_AI_FALLBACK_IDLE_STATUSES = Object.freeze([
  'saved', 'failed',
]);

// LOCAL_AI_JOB_INTEGRITY_CODE, as electron/ipc/pasteApplicationAssembly.js
// spells it and handleSafe hands it back on a failed IPC result. It marks the
// one failure class that the response now on screen cannot answer: what failed
// is state the job already holds — its career corpus, its listing, the
// evidence plan and identity its first stage accepted, its input record — and
// no response this job can still take supplies any of them. Two of those did
// arrive in a pasted response, at a stage that has since closed, so this is
// not "a defect the app authored"; it is one no remaining round can reach.
export const LOCAL_AI_JOB_INTEGRITY_ERROR_CODE = 'LOCAL_AI_JOB_INTEGRITY';

// Said only when the main process somehow sent the code without its sentence.
// The action is the one the main process names, so the two cannot disagree.
const BROKEN_JOB_FALLBACK_MESSAGE = 'This application job cannot be completed, and no pasted response can repair it. Press Generate on the job card to build this application again from current career data and the current listing.';

/**
 * The message to show for a failure that reports a broken job, or '' when it
 * is anything else.
 *
 * A paste surface branches on this BEFORE it treats a failure as a correction
 * round: a correction round asks for another paste, and asking for one here is
 * asking a person to keep answering a rejection that cannot be answered.
 *
 * Two shapes carry the same fault, because the drivers read the same failure
 * at two different distances. A status poll or a paste submit reads the IPC
 * result itself ({ success: false, errorCode, error }, as handleSafe builds
 * it). An import has a bundle save AFTER its IPC, so it rethrows that result
 * as an Error ({ code, message }) and one catch covers both steps — the same
 * way its LOCAL_AI_RESULT_CHANGED / LOCAL_AI_IMPORT_IN_FLIGHT branches read
 * it. Answering only the first shape leaves the import catch judging the same
 * fault a second way, so both are read here, once. An IPC result always
 * carries `success`; a rethrown Error never does, so neither shape can be
 * mistaken for the other.
 */
export function jobIntegrityFailureMessage(result) {
  if (!result || typeof result !== 'object') return '';
  const isIpcResult = result.success !== undefined;
  if (isIpcResult && result.success !== false) return '';
  if ((isIpcResult ? result.errorCode : result.code) !== LOCAL_AI_JOB_INTEGRITY_ERROR_CODE) return '';
  const reported = isIpcResult ? result.error : result.message;
  const message = typeof reported === 'string' ? reported.trim() : '';
  return message || BROKEN_JOB_FALLBACK_MESSAGE;
}

/**
 * The card state a STATUS POLL or an IMPORT must adopt for a failure reporting
 * a broken job, or null for anything else.
 *
 * Both drivers treat a failed status IPC as transient: three consecutive
 * failures park the card at 'status-error … Retrying automatically…', which is
 * in neither driver's idle list, so the poll runs forever. That is the right
 * answer for a canvas re-save renaming files under the resolver, and the wrong
 * one for a job whose own manifest, input record or frozen corpus can no
 * longer be read — retrying reproduces it every 2.5 seconds and names no
 * action. 'failed' is terminal in both idle lists and re-enables Generate,
 * which is the action the main process's sentence names.
 *
 * Both import catches need the same answer for a different reason: every
 * branch they have parks the job at 'completed', which the card renders as a
 * finished result and neither driver's idle list stops. A job the main
 * process has just declared unfinishable would be shown as one that finished,
 * and the poll that follows would start the settle/import cycle over.
 */
export function brokenLocalAiJobDriveState(result) {
  const message = jobIntegrityFailureMessage(result);
  return message ? { status: 'failed', message } : null;
}

// ── Mounted-card registry ────────────────────────────────────────────────────
// Module-level so the manager (a different component tree) can consult it
// synchronously before every poll/import/state write. A card registers for its
// whole mounted lifetime; membership therefore means "this card's own effect
// is driving its Local AI job right now".
const mountedJobCards = new Set();

export function registerMountedJobCard(id) {
  if (id) mountedJobCards.add(id);
}

export function unregisterMountedJobCard(id) {
  mountedJobCards.delete(id);
}

export function isJobCardMounted(id) {
  return mountedJobCards.has(id);
}

/**
 * Pure selection of the jobs the fallback manager should drive this tick:
 * job cards holding a pending Local AI job whose card component is not
 * mounted (hidden cascade, collapsed group, a parent canvas level, …).
 * `isMounted` is injectable for tests.
 */
export function selectFallbackLocalAiJobs(allNodes, isMounted = isJobCardMounted) {
  const out = [];
  for (const node of Array.isArray(allNodes) ? allNodes : []) {
    if (node?.type !== 'jobcard') continue;
    const local = node?.data?.localApplication;
    if (!local?.id) continue;
    if (LOCAL_AI_FALLBACK_IDLE_STATUSES.includes(local.status)) continue;
    if (isMounted(node.id)) continue;
    out.push(node);
  }
  return out;
}

/**
 * App-owned Local AI folders can outlive their result card: a user may delete
 * the card while the local coding agent is still writing result.json.  The
 * canvas manager discovers those folders from the current saved canvas and
 * drives them without recreating a card.  A live card always wins ownership,
 * including one that is currently hidden or otherwise unmounted.
 */
export function selectOrphanedLocalAiJobs(discoveredJobs, knownJobIds) {
  const known = knownJobIds instanceof Set ? knownJobIds : new Set(knownJobIds || []);
  const seen = new Set();
  return (Array.isArray(discoveredJobs) ? discoveredJobs : []).filter((job) => {
    const id = String(job?.id || '');
    if (!id || seen.has(id) || known.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// ── Saved-bundle Finder/Explorer reveal ─────────────────────────────────────
// Both drivers can be the one that turns a job terminal 'saved': the mounted
// card when it runs its own import+save, or this manager when the card was
// hidden. Whichever one performed THAT save is the only one that should ask
// the main process to open its output folder, and only once per job — a
// later status re-observation of the same terminal 'saved' patch (a poll
// tick, an ownership handover adopting the manager's write) must not reopen
// it. `revealedRef` is a Set the caller owns so this stays scoped to one
// component/hook instance instead of leaking a module-level record across
// unrelated cards. The main process re-derives the exact directory from its
// own durable receipt for this jobId — this call never sends it a path.
export function revealSavedLocalApplicationOutputOnce({ jobId, canvasFilePath, revealedRef, api, onError } = {}) {
  const electronApi = api || (typeof window !== 'undefined' ? window.electronAPI : null);
  if (!jobId || !revealedRef || revealedRef.has(jobId) || !electronApi?.openLocalApplicationOutput) return;
  revealedRef.add(jobId);
  electronApi.openLocalApplicationOutput({ jobId, canvasFilePath })
    .then((result) => {
      if (!result?.opened && !result?.skipped) onError?.(result?.error || 'Could not open the saved application folder.');
    })
    .catch((error) => onError?.(error?.message || String(error)));
}
