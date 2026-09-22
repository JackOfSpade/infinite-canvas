/**
 * Application-bundle handoffs, expressed as items of the global AI handoff
 * dock (NonApiAiDialog).
 *
 * Why this module exists: two copy/paste handoff protocols grew up
 * independently. Job scoring uses the PUSH transport in electron/ipc/nonApiAi.js
 * — the main process sends 'non-api-ai-request' the moment a prompt exists,
 * and the dock queues up to MANUAL_HANDOFF_CONCURRENCY of them side by side.
 * Application bundles use the PULL transport in electron/ipc/localAiApplication.js
 * — nothing is ever pushed; a surface asks getLocalApplicationHandoff for the
 * job's current stage prompt, and the durable state machine lives in the job
 * folder on disk (so it survives a restart, which a pending promise cannot).
 *
 * Rewriting the durable paste state machine onto the push transport would
 * rewrite the central mechanism of a ~7900-line file. Instead this module
 * adapts the pull protocol into the SHAPE the dock already renders, so one
 * queue, one chip strip, and one set of focus rules cover both. The dock reads
 * `requestId`/`prompt`/`handoffCode`/`task`/`nodeId`/`runId`/`batch` off every
 * item regardless of kind; `kind: 'application'` is what routes submit, draft
 * persistence, and cancellation to the durable IPC surface instead.
 *
 * Everything here is pure except the subscription store at the bottom, which
 * exists because NonApiAiDialog mounts in App.jsx OUTSIDE the canvas provider
 * tree (deliberately — an open handoff must outlive a Canvas crash) while
 * discovery needs canvas node data from inside it.
 */

// How many application bundles may await a pasted response at once. Matches
// MANUAL_HANDOFF_CONCURRENCY (electron/ipc/jobPreferences.js) so the dock caps
// application prompts exactly where it caps scoring prompts: this is a limit on
// how many prompts one person can juggle in their AI chat, not a resource
// quota. The chip strip is laid out `sm:grid-cols-10` for the same reason.
export const APPLICATION_HANDOFF_LIMIT = 10;

// Application statuses that never occupy a dock slot. A job is owned by its
// polling/import machinery in these states and has no prompt to paste against:
// 'saved'/'failed' are terminal, 'importing'/'completed'/'paste-completed'
// are the app's own work after the final stage was accepted.
export const APPLICATION_DOCK_IDLE_STATUSES = Object.freeze([
  'saved', 'failed', 'importing', 'completed', 'paste-completed',
  // Past the paste phase: the result exists and it is the LAYOUT check that
  // must be retried, from the card's own action. getLocalApplicationHandoff
  // has no prompt to hand back for one, so counting it would spend a dock
  // slot on a bundle that can never show a prompt — and would light a
  // Continue action that opens nothing. Mirrors LOCAL_AI_CARD_POLL_IDLE_STATUSES.
  'render-retry-required',
]);

const PUSH_HANDOFF_CODE_RE = /^HANDOFF-[2-9A-HJ-NP-Z]{6}$/;

const isPasteApplication = (localApplication) => (
  localApplication?.mode === 'paste' || localApplication?.transport === 'paste'
);

/**
 * The dock's cross-paste guard scans a pasted answer for any well-formed
 * `HANDOFF-XXXXXX` stamp that disagrees with the active prompt's own code.
 * Application prompts carry a base64url code of a different alphabet and never
 * embed a `HANDOFF-` stamp, so the comparison is only meaningful for push
 * handoffs — running it against an application item would describe the prompt
 * with a code its text does not contain. The guard still fires when a SCORING
 * answer is pasted into an application prompt, because that answer carries a
 * stamp while the expected code is not in that format: see dockCodeMismatch.
 */
export function usesPushHandoffCode(request) {
  return PUSH_HANDOFF_CODE_RE.test(String(request?.handoffCode || ''));
}

/**
 * Job cards whose application bundle is waiting on a pasted response. Pure so
 * the cap and the queue are derived from one rule; `allNodes` is the canvas's
 * full node list (every level), as enumerateAllNodes returns it.
 */
export function selectApplicationHandoffCandidates(allNodes) {
  const out = [];
  for (const node of Array.isArray(allNodes) ? allNodes : []) {
    if (node?.type !== 'jobcard') continue;
    const local = node?.data?.localApplication;
    if (!local?.id || !isPasteApplication(local)) continue;
    if (APPLICATION_DOCK_IDLE_STATUSES.includes(local.status)) continue;
    out.push(node);
  }
  return out;
}

/**
 * How many application bundles currently hold a dock slot. Generate is refused
 * at the limit: an eleventh prompt cannot be worked on and would only make the
 * chip strip lie about what is actionable.
 */
export function countActiveApplicationHandoffs(allNodes, dismissedRequestIds = null) {
  const candidates = selectApplicationHandoffCandidates(allNodes);
  if (!dismissedRequestIds || dismissedRequestIds.size === 0) return candidates.length;
  // A bundle the person dismissed as unfinishable is not on screen, so it must
  // not hold a slot against the next Generate. Its job folder survives until
  // its own status poll marks it failed; the cap follows the dock, not the disk.
  return candidates.filter(node => (
    !dismissedRequestIds.has(applicationRequestId(node.data.localApplication.id))
  )).length;
}

export function applicationLimitMessage(limit = APPLICATION_HANDOFF_LIMIT) {
  return `${limit} application bundles are already waiting for a pasted response. Finish or discard one of them, then press Generate again.`;
}

/**
 * A stable dock id for one application job. Prefixed so it can never collide
 * with a push transport requestId, and derived only from the job id so the
 * item keeps its draft, its chip position, and its selection across refreshes.
 */
export function applicationRequestId(jobId) {
  return `application:${String(jobId || '')}`;
}

export function isApplicationRequestId(requestId) {
  return String(requestId || '').startsWith('application:');
}

const STAGE_LABELS = {
  'evidence-plan': 'Evidence plan',
  resume: 'Résumé',
  'cover-letter': 'Cover letter',
  review: 'Review and edit',
};

export function applicationStageLabel(stage) {
  return STAGE_LABELS[stage] || 'Application handoff';
}

/**
 * Adapt one job's durable handoff record into a dock item.
 *
 * `handoff` is exactly what getLocalApplicationHandoff returns:
 * { jobId, stage, revision, handoffCode, baseHashes, prompt, draft,
 *   corrections?, correctionPrompt? }.
 *
 * Field choices that matter to the dock's existing logic:
 *  - `runId` is the job id, and `task` is the stage. Advancing a stage keeps
 *    runId and changes task, which is exactly isWorkflowSuccessor's rule for
 *    "the prompt the person just advanced to" — so stage N+1 takes focus on
 *    its own, with no special case in nonApiAiNavigation.js.
 *  - `batch` is deliberately absent. Batch numbers are an ordering contract
 *    among siblings of one scoring task; application jobs are independent, and
 *    a number here would reorder them against each other on every refresh.
 *    The chip strip falls back to the item's position, which is the plain
 *    numbering the dock already shows for unnumbered prompts.
 *  - `isCorrection` follows the presence of corrections, so the dock's
 *    existing correction banner and Copy-correction-prompt label apply.
 */
export function applicationDockRequest({ node, handoff, canvasFilePath = null }) {
  const local = node?.data?.localApplication;
  if (!node?.id || !local?.id || !handoff?.handoffCode || typeof handoff.prompt !== 'string') return null;
  const corrections = Array.isArray(handoff.corrections) ? handoff.corrections.filter(Boolean) : [];
  const company = typeof node.data?.company === 'string' ? node.data.company.trim() : '';
  const title = typeof node.data?.title === 'string' ? node.data.title.trim() : '';
  return {
    kind: 'application',
    requestId: applicationRequestId(local.id),
    jobId: local.id,
    canvasFilePath: local.canvasFilePath || canvasFilePath || null,
    nodeId: node.id,
    runId: local.id,
    task: handoff.stage || local.stage || 'application',
    stage: handoff.stage || '',
    revision: Number.isFinite(Number(handoff.revision)) ? Number(handoff.revision) : null,
    handoffCode: handoff.handoffCode,
    prompt: handoff.prompt,
    initialResponse: typeof handoff.draft === 'string' ? handoff.draft : '',
    corrections,
    correctionPrompt: typeof handoff.correctionPrompt === 'string' ? handoff.correctionPrompt : '',
    isCorrection: corrections.length > 0,
    label: company || title || 'Application',
    subject: [title, company].filter(Boolean).join(' · '),
  };
}

/**
 * A bundle whose own frozen state failed its integrity check: no response this
 * job can still take repairs it, so it gets an item with no prompt and no
 * response box, only the explanation and the action that replaces it.
 *
 * The same fault reaches the dock two ways — caught by submit, or read by a
 * routine discovery pass. Without this the discovery path would drop the job
 * silently, leaving a card that advertises a pending bundle the dock shows
 * nothing for.
 */
export function brokenApplicationDockRequest({ node, message, canvasFilePath = null }) {
  const local = node?.data?.localApplication;
  const text = typeof message === 'string' ? message.trim() : '';
  if (!node?.id || !local?.id || !text) return null;
  const company = typeof node.data?.company === 'string' ? node.data.company.trim() : '';
  const title = typeof node.data?.title === 'string' ? node.data.title.trim() : '';
  return {
    kind: 'application',
    requestId: applicationRequestId(local.id),
    jobId: local.id,
    canvasFilePath: local.canvasFilePath || canvasFilePath || null,
    nodeId: node.id,
    runId: local.id,
    task: local.stage || 'application',
    stage: local.stage || '',
    revision: null,
    handoffCode: '',
    prompt: '',
    initialResponse: '',
    corrections: [],
    correctionPrompt: '',
    isCorrection: false,
    integrityMessage: text,
    label: company || title || 'Application',
    subject: [title, company].filter(Boolean).join(' · '),
  };
}

/**
 * Assign each bundle the number shown on its chip, and order the queue by it.
 *
 * Mutates `ordinals` (jobId -> number) in place and returns the items sorted by
 * that number. The contract, in one line: a NEW bundle takes the lowest number
 * no bundle currently in the queue is using.
 *
 * Why numbers cannot simply be positions: these chips are how someone keeps up
 * to ten parallel AI chats straight. Position renumbers everything below any
 * change — a scoring handoff arriving, or bundle 2 of 5 finishing — so the chat
 * a person has open as "4" silently becomes someone else's "3" mid-paste. A
 * number is therefore assigned ONCE and never recomputed while its bundle
 * lives.
 *
 * A finished bundle releases its number, and only then can a new bundle reuse
 * it. That keeps the strip dense (1..N with no growing gaps) without ever
 * renumbering a bundle that is still being worked on.
 */
export function assignApplicationOrdinals(ordinals, items) {
  const live = Array.isArray(items) ? items.filter(Boolean) : [];
  const liveJobIds = new Set(live.map(item => item.jobId));
  // Release first, so a number freed by a finished bundle is available to a
  // new one arriving in the very same pass.
  for (const jobId of [...ordinals.keys()]) {
    if (!liveJobIds.has(jobId)) ordinals.delete(jobId);
  }
  for (const item of live) {
    if (ordinals.has(item.jobId)) continue;
    // Recomputed per item, not hoisted: two bundles can arrive in one pass and
    // the second must see the number the first just took.
    const taken = new Set(ordinals.values());
    let next = 1;
    while (taken.has(next)) next += 1;
    ordinals.set(item.jobId, next);
  }
  return [...live].sort((a, b) => (ordinals.get(a.jobId) || 0) - (ordinals.get(b.jobId) || 0));
}

/**
 * The dock's single ordered queue.
 *
 * Push handoffs lead: they belong to a job run that is blocked until they are
 * answered, while an application bundle waits on disk indefinitely and loses
 * nothing by being answered later. Within each group the caller's order is
 * kept — the push list is already sorted by batch on insert, and application
 * items keep discovery order so a refresh never shuffles the chips under a
 * person mid-paste.
 */
export function mergeDockQueue(pushRequests, applicationRequests) {
  const push = Array.isArray(pushRequests) ? pushRequests.filter(Boolean) : [];
  const application = Array.isArray(applicationRequests) ? applicationRequests.filter(Boolean) : [];
  const seen = new Set(push.map(request => request.requestId));
  return [...push, ...application.filter(request => !seen.has(request.requestId))];
}

/**
 * Keep the previously published item for a job when a refresh cannot re-read
 * it. A transient IPC failure must not evict a prompt the person is part way
 * through answering; the job itself is still on disk and still pending.
 */
export function retainUnreadableApplicationItems(next, previous, candidateJobIds = null) {
  const fresh = Array.isArray(next) ? next.filter(Boolean) : [];
  const stale = Array.isArray(previous) ? previous.filter(Boolean) : [];
  const covered = new Set(fresh.map(item => item.jobId));
  const retained = stale.filter(item => {
    if (!item.unreadable || covered.has(item.jobId)) return false;
    // A job that is no longer a candidate has genuinely left the dock — it
    // settled through its own poll or import, which this discovery never
    // re-reads. Without this it would be carried forward on every pass
    // forever, because only a successful re-read can clear the flag and a
    // settled job is never re-read.
    return !candidateJobIds || candidateJobIds.has(item.jobId);
  });
  return [...fresh, ...retained];
}

// ---------------------------------------------------------------------------
// Cross-tree store
// ---------------------------------------------------------------------------

let publishedItems = [];
const listeners = new Set();

export function getApplicationHandoffs() {
  return publishedItems;
}

// A listener is a renderer subscriber. One that throws must not stop the queue
// reaching the others, and must not propagate into whichever caller happened to
// trigger the delivery — for the immediate replay below that caller is the
// subscriber's own effect, where an exception would take the dock down.
function deliver(listener) {
  try { listener(publishedItems); } catch { /* a dock listener must never break discovery */ }
}

export function publishApplicationHandoffs(items) {
  publishedItems = Array.isArray(items) ? items.filter(Boolean) : [];
  for (const listener of [...listeners]) deliver(listener);
}

export function subscribeApplicationHandoffs(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  deliver(listener);
  return () => { listeners.delete(listener); };
}

// Test seam: the store is module-level, so a suite that publishes items must
// be able to return it to a known empty state.
export function __resetApplicationHandoffsForTests() {
  publishedItems = [];
  listeners.clear();
  dismissedBundles = new Set();
}

// ---------------------------------------------------------------------------
// Focus requests
// ---------------------------------------------------------------------------

const FOCUS_EVENT = 'application-handoff-focus';

/**
 * A job card asking the dock to open on its bundle. The card no longer owns a
 * modal, so "Continue AI handoff" is a request to select an item in the one
 * queue — which may already be showing a different prompt the person chose.
 */
export function requestApplicationHandoffFocus(jobId) {
  if (!jobId || typeof document === 'undefined') return;
  document.dispatchEvent(new CustomEvent(FOCUS_EVENT, { detail: { jobId: String(jobId) } }));
}

export function subscribeApplicationHandoffFocus(listener) {
  if (typeof listener !== 'function' || typeof document === 'undefined') return () => {};
  const handler = (event) => {
    const jobId = event?.detail?.jobId;
    if (jobId) listener(String(jobId));
  };
  document.addEventListener(FOCUS_EVENT, handler);
  return () => { document.removeEventListener(FOCUS_EVENT, handler); };
}

// ---------------------------------------------------------------------------
// Dismissed broken bundles
// ---------------------------------------------------------------------------

// Bundles the person dismissed as unfinishable. Held here, not only in the
// dock's React state, because the Generate cap is evaluated in JobCardNode —
// a different tree — and must agree with what the dock is actually showing.
let dismissedBundles = new Set();

export function getDismissedApplicationBundles() {
  return dismissedBundles;
}

export function setDismissedApplicationBundles(next) {
  dismissedBundles = next instanceof Set ? new Set(next) : new Set();
}

// ---------------------------------------------------------------------------
// Draft durability
// ---------------------------------------------------------------------------

const draftFlushers = new Set();
const pendingDraftWrites = new Set();

/**
 * Application draft writes are debounced in the renderer, so at any moment a
 * pasted edit may exist only as a scheduled timer that has not yet issued its
 * IPC. Push handoff drafts get their shutdown guarantee from preload, which
 * tracks every outstanding `update-non-api-ai-draft` invoke and awaits them in
 * flushNonApiAiPersistence — but that Set can only hold calls preload itself
 * made, and it cannot fire a timer that has not run. So the dock registers its
 * own flusher here and the quit handshake drains both halves: fire the pending
 * timers, then await the writes they issue.
 *
 * Without this, a response pasted in the last ~350ms before Cmd+Q is lost: the
 * window is destroyed with the timer still queued, and the job folder keeps the
 * previous text. The dock's unmount cleanup cannot cover it, because the dock
 * is mounted once for the life of the window and is never unmounted before that
 * destruction.
 */
export function registerApplicationDraftFlusher(flush) {
  if (typeof flush !== 'function') return () => {};
  draftFlushers.add(flush);
  return () => { draftFlushers.delete(flush); };
}

export function trackApplicationDraftWrite(write) {
  if (!write || typeof write.then !== 'function') return write;
  pendingDraftWrites.add(write);
  const forget = () => { pendingDraftWrites.delete(write); };
  void write.then(forget, forget);
  return write;
}

export async function flushApplicationDraftWrites() {
  for (const flush of [...draftFlushers]) {
    // A flusher issues writes synchronously; one that throws must not strand
    // the drafts belonging to every other pending item.
    try { flush(); } catch { /* keep draining the rest */ }
  }
  // A flushed timer can itself register a new write, so drain until settled
  // rather than awaiting a single snapshot — the same loop preload runs.
  while (pendingDraftWrites.size > 0) {
    await Promise.allSettled([...pendingDraftWrites]);
  }
}

// ---------------------------------------------------------------------------
// Refresh requests
// ---------------------------------------------------------------------------

const REFRESH_EVENT = 'application-handoff-refresh';

/**
 * The dock asking discovery to re-read one job (or every job, with no id).
 *
 * The dock owns submission because it owns the response draft, but the durable
 * stage machine is what decides whether that response advanced the job, opened
 * a correction round, or finished it. Rather than have the dock mutate the
 * published queue from a submit result it only partly understands, it asks the
 * owner of discovery to re-read the authoritative state from the job folder.
 */
export function requestApplicationHandoffRefresh(jobId = null) {
  if (typeof document === 'undefined') return;
  document.dispatchEvent(new CustomEvent(REFRESH_EVENT, {
    detail: { jobId: jobId ? String(jobId) : null },
  }));
}

export function subscribeApplicationHandoffRefresh(listener) {
  if (typeof listener !== 'function' || typeof document === 'undefined') return () => {};
  const handler = (event) => { listener(event?.detail?.jobId || null); };
  document.addEventListener(REFRESH_EVENT, handler);
  return () => { document.removeEventListener(REFRESH_EVENT, handler); };
}
