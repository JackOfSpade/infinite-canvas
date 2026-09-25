import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ArrowLeft, Check, ChevronDown, ChevronUp, ClipboardCopy, FolderOpen, LoaderCircle, Paperclip, Send, XCircle } from 'lucide-react';
import { ConfirmDialog } from './ConfirmDialog';
import { EventLogger } from '../utils/EventLogger';
import { isWorkflowSuccessor, selectionAfterHandoffSettlement, successorPreferenceAfterSettlement } from '../utils/nonApiAiNavigation';
import { assessPastedResponse, responseFingerprint } from '../utils/pasteIdentityGuard';
import { applicationRequestId, applicationStageLabel, assignApplicationOrdinals, mergeDockQueue, registerApplicationDraftFlusher, requestApplicationHandoffRefresh, setDismissedApplicationBundles, subscribeApplicationHandoffFocus, subscribeApplicationHandoffs, trackApplicationDraftWrite, usesPushHandoffCode } from '../utils/applicationHandoffDock';
// A failed submit result may carry the job-integrity code: the job's own
// frozen state failed, not the pasted response, and no further paste can
// answer that. See applicationHandoffDock.js's doc comment for the shared
// dock contract this file adapts application handoffs into.
import { jobIntegrityFailureMessage } from '../utils/localAiFallback';

const stringifyValidationError = (value) => {
  if (Array.isArray(value)) return value.filter(Boolean).join('\n');
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    return value.message || value.error || JSON.stringify(value);
  }
  return '';
};

const PREFERENCE_RESEARCH_RESPONSE_INVALID_CODES = new Set([
  'JOB_PREFERENCE_RESEARCH_RESPONSE_INVALID',
  // Kept for corrections reissued by builds that used the pre-namespaced code.
  'PREFERENCE_RESEARCH_RESPONSE_INVALID',
]);

const COMPENSATION_RESPONSE_INVALID_CODE = 'JOB_COMPENSATION_RESPONSE_INVALID';

const correctionGuidanceFor = (validationCode, validationDiagnostic) => {
  if (validationCode === COMPENSATION_RESPONSE_INVALID_CODE) {
    const reason = validationDiagnostic?.reason;
    if (reason === 'COMPENSATION_ROLE_FAMILY_COVERAGE_INVALID') {
      return 'The app rejected this compensation research before using it because it needs one role-family ladder for every requested researchId. Copy the correction prompt into the same AI chat, then paste the complete regenerated answer below.';
    }
    if (reason === 'COMPENSATION_ROLE_FAMILY_IDENTITY_INVALID') {
      return 'The app rejected this compensation research before using it because every researchId and role family must appear exactly once. Copy the correction prompt into the same AI chat, then paste the complete regenerated answer below.';
    }
    if (reason === 'COMPENSATION_ROLE_FAMILY_EVIDENCE_NOT_GROUNDED') {
      return 'The app rejected this compensation research before using it because each role-family result needs a direct source URL, quote, and date from its matching section; cached rows must remain empty. Copy the correction prompt into the same AI chat, then paste the complete regenerated answer below.';
    }
    if (reason === 'COMPENSATION_COHORT_COVERAGE_INVALID' || reason === 'COMPENSATION_ASSESSMENT_COVERAGE_INVALID') {
      return 'The app rejected this compensation assessment before using it because it needs one assessment for every supplied index. Copy the correction prompt into the same AI chat, then paste the complete regenerated answer below.';
    }
    if (reason === 'COMPENSATION_COHORT_IDENTITY_INVALID') {
      return 'The app rejected this compensation assessment before using it because one or more entries did not match the supplied cohort. Copy the correction prompt into the same AI chat, then paste the complete regenerated answer below.';
    }
    if (reason === 'COMPENSATION_RANGE_INVALID') {
      return 'The app rejected this compensation assessment before using it because a comparable result needs a positive annual range and the target currency. Copy the correction prompt into the same AI chat, then paste the complete regenerated answer below.';
    }
    if (reason === 'COMPENSATION_EVIDENCE_NOT_GROUNDED') {
      return 'The app rejected this compensation assessment before using it because each result needs a literal source URL, quote, and date from the same grounded cohort. Copy the correction prompt into the same AI chat, then paste the complete regenerated answer below.';
    }
    return 'The app rejected this compensation assessment before using it. Copy the correction prompt into the same AI chat, then paste the complete regenerated answer below.';
  }
  if (PREFERENCE_RESEARCH_RESPONSE_INVALID_CODES.has(validationCode)) {
    if (validationDiagnostic?.stage === 'research-sections') {
      return 'The app rejected the pasted raw research before using it because its required BEGIN/END section contract was incomplete or malformed. Nothing was applied. Copy the updated correction prompt into the same AI chat, then paste the full regenerated answer below.';
    }
    if (validationDiagnostic?.stage === 'research-assessment') {
      return 'The app rejected the pasted JSON assessment before using it because one or more rows did not match the required research identity or evidence provenance. Nothing was applied. Copy the updated correction prompt into the same AI chat, then paste the full regenerated answer below.';
    }
    return 'The app rejected the pasted Job Preference research answer before using it because it failed the required response checks. Nothing was applied. Copy the updated correction prompt into the same AI chat, then paste the full regenerated answer below.';
  }
  if (validationCode === 'HANDOFF_CODE_MISSING') {
    return 'The app rejected the pasted chat answer before using it because it lacked this request stamp. Nothing was applied. Copy the updated correction prompt into the same AI chat, then paste the full regenerated answer below.';
  }
  return 'The app rejected the previous answer before using it. Copy the correction prompt into the same AI chat, then paste the complete regenerated answer below.';
};

const formatValidationDiagnostic = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const reason = typeof value.reason === 'string' && /^[A-Z0-9_]{1,80}$/.test(value.reason)
    ? value.reason.toLowerCase().replace(/_/g, ' ')
    : '';
  // VALIDATION_FAILED is the transport's catch-all receipt, not an actionable
  // diagnosis. After the person edits the draft the detailed error is cleared;
  // do not replace it with the same generic banner from the screenshot.
  if (!reason || value.reason === 'VALIDATION_FAILED') return '';
  const countLabels = {
    expectedCount: 'expected',
    receivedCount: 'received',
    sectionCount: 'sections',
    missingCount: 'missing',
    duplicateCount: 'duplicate',
    unknownCount: 'unknown',
    emptyCount: 'empty',
    markerCount: 'markers',
  };
  const counts = Object.entries(countLabels).flatMap(([key, label]) => {
    const number = Number(value.counts?.[key]);
    return Number.isInteger(number) && number >= 0 && number <= 1_000_000
      ? [`${label} ${number}`]
      : [];
  });
  return `Validation check: ${reason}${counts.length ? ` (${counts.join(', ')})` : ''}.`;
};

// A pasted response carrying a well-formed HANDOFF-XXXXXX stamp that disagrees
// with the code this prompt actually expects is the answer to a DIFFERENT
// prompt (a sibling batch, or — for an application item — an unrelated
// scoring task, since an application code never has this shape at all).
// Built fresh on every call rather than shared as a module-level `/g` regex:
// a shared instance would carry `lastIndex` state across an early `break`
// between unrelated calls (the push scan and the application scan both use
// this), silently skipping matches on the next read of the same text.
// How many submitted responses the dock remembers for its duplicate check.
// Bounded because a long run sends hundreds; the mistake this catches — a
// chat answered once and pasted back a second time — happens within a few
// prompts of the first paste, never hundreds later.
const SUBMITTED_RESPONSE_MEMORY = 40;

const findMismatchedHandoffStamp = (text, expectedCode) => {
  const regex = /\bHANDOFF-([2-9A-HJ-NP-Z]{6})\b/gi;
  const normalizedExpected = String(expectedCode || '').trim().toUpperCase();
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match[0].toUpperCase() !== normalizedExpected) return match[0].toUpperCase();
  }
  return null;
};

const requestLabel = (request) => {
  if (!request) return 'AI response';
  const task = request.task || 'AI response';
  const attemptLabel = request.attemptKind === 'partial-recovery'
    ? 'partial recovery for '
    : request.attemptKind === 'split' ? 'split retry for ' : '';
  const itemLabel = Number.isFinite(request.itemCount)
    ? ` · ${request.itemCount} ${request.itemCount === 1 ? 'item' : 'items'}`
    : '';
  const rootLabel = request.attemptKind !== 'initial'
    && Number.isFinite(request.rootBatchSize)
    && request.rootBatchSize !== request.itemCount
    ? ` · ${request.rootBatchSize}-item root batch`
    : '';
  // Overall progress through the task, not just this handoff's position in the
  // batch list: with ~25 batches the useful question is "how many left", and a
  // batch number alone does not answer it when batches vary in size.
  const progressLabel = Number.isFinite(request.itemsDone) && Number.isFinite(request.itemsTotal)
    && request.itemsTotal > 0
    ? ` · ${request.itemsDone}/${request.itemsTotal} done`
    : '';
  if (Number.isFinite(request.batch) && Number.isFinite(request.batchTotal)) {
    return `${task} · ${attemptLabel}batch ${request.batch} of ${request.batchTotal}${itemLabel}${rootLabel}${progressLabel}`;
  }
  if (Number.isFinite(request.batch)) return `${task} · ${attemptLabel}batch ${request.batch}${itemLabel}${rootLabel}${progressLabel}`;
  return `${task}${attemptLabel ? ` · ${attemptLabel.trim()}` : ''}${itemLabel}${rootLabel}${progressLabel}`;
};

// requestLabel's batch/progress vocabulary describes a push scoring task and
// says nothing true about an application bundle (no batch, no item count).
// Branch here instead of teaching requestLabel a second, unrelated shape.
const dockItemSummary = (request) => {
  if (!request) return 'AI response';
  if (request.kind === 'application') {
    const revisionLabel = Number.isFinite(request.revision) ? ` · revision ${request.revision}` : '';
    const subjectLabel = request.subject ? ` · ${request.subject}` : '';
    return `${applicationStageLabel(request.stage)}${revisionLabel}${subjectLabel}`;
  }
  return requestLabel(request);
};

// Single source of truth for "which check ids does this escalation actually
// name" — every caller below (the gate, the headline, and the singular/plural
// wording in the panel banner) must agree on this list, because a
// `checkIds` entry that is falsy-but-present (e.g. `['']` or `[null]`, which
// nothing in electron/ipc/localAiApplication.js currently sends, but this
// file must not trust that) is not a name at all. Filtering once here means
// the gate and the render can never see a different count than each other.
const escalationCheckIds = (escalation) => (
  Array.isArray(escalation?.checkIds) ? escalation.checkIds.filter(Boolean) : []
);

// True only for a `rejectionEscalation` that actually says something: the
// object exists, `active` is true, and it names at least one check id (after
// the falsy-filtering above). Every call site below gates on this rather
// than on `request.rejectionEscalation` alone, because a defensive
// `{ active: true, checkIds: [] }` — or one whose ids are all falsy — would
// otherwise pass a truthy check and then render an empty subject in
// `escalationHeadline`.
const hasActiveEscalation = (escalation) => (
  escalation?.active === true && escalationCheckIds(escalation).length > 0
);

// One sentence naming WHICH check is stuck and HOW MANY times in a row, in
// the same wording pasteRejectionEscalationBlock (electron/ipc/localAiApplication.js)
// puts inside the correction prompt itself — so a person who has already read
// that paragraph in a prior round recognizes this badge/banner as the same
// fact, not a second, differently-worded claim about their own stuck loop.
// Deliberately reimplemented rather than imported: that function lives in the
// main process and builds a multi-paragraph instruction block; this is a
// single human-facing headline for a renderer badge, and importing main-
// process prompt machinery into the renderer is not a trade worth making for
// one shared sentence.
const escalationHeadline = (escalation) => {
  const ids = escalationCheckIds(escalation);
  if (!ids.length) return '';
  const subject = ids.length === 1 ? `Check "${ids[0]}"` : `Checks ${ids.map(id => `"${id}"`).join(', ')}`;
  const verb = ids.length === 1 ? 'has' : 'have';
  const streak = Number.isFinite(escalation?.streak) ? escalation.streak : 0;
  return `${subject} ${verb} now rejected ${streak} consecutive response${streak === 1 ? '' : 's'} in a row.`;
};

// Same falsy-filtering discipline as escalationCheckIds, and for the same
// reason: `correctionsRecovered.checkIds` is a durable-trace echo (electron/
// ipc/localAiApplication.js), copied onto the dock item verbatim, never
// computed in this file — so a defensive-but-empty array, or one holding only
// falsy entries, must not be read as "named checks" here either. UNLIKE
// escalationCheckIds' own gate (hasActiveEscalation), an empty result here
// does NOT disqualify the notice: the contract itself documents `checkIds` as
// "may be empty" — a rejection round can be entirely uncoded (see
// pasteRejectionCheckIds' own `uncodedErrors`) and a restart can genuinely
// recover "N rejections, 0 named checks", which is still worth saying, just
// without a checks clause (see correctionsRecoveredSummary below).
const correctionsRecoveredCheckIds = (recovered) => (
  Array.isArray(recovered?.checkIds) ? recovered.checkIds.filter(Boolean) : []
);

// True only for a `correctionsRecovered` that the main process actually set
// this round: electron/ipc/localAiApplication.js sets `active: true` only
// when THIS field exists at all (see applicationHandoffDock.js's own comment
// on the field) — there is no "present but inactive" shape to additionally
// guard against the way `rejectionEscalation` has, so the object existing and
// `active === true` is the whole gate.
const hasActiveCorrectionsRecovered = (recovered) => recovered?.active === true;

// `lastAt` is the durable trace's own ISO timestamp (Paste Rejections.json),
// never something this file computed, so an unparsable value must degrade to
// omitting the clause it feeds, not to rendering "Invalid Date" or throwing.
const formatCorrectionsRecoveredAt = (lastAt) => {
  if (typeof lastAt !== 'string' || !lastAt) return '';
  const date = new Date(lastAt);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '';
};

// The notice's one sentence of fact, read directly off the durable-trace
// fields the main process rehydrated (active, itemCount, checkIds,
// rejectionCount, lastAt — see localAiApplication.js's correctionsRecovered
// doc comment for what each one is). Every field is read defensively,
// independently of the others, because this object crossed a process
// restart via disk rather than living memory: a partial or malformed shape
// must degrade the one clause it feeds and leave the rest of the sentence
// intact, never throw and never block the notice from rendering at all.
const correctionsRecoveredSummary = (recovered) => {
  const ids = correctionsRecoveredCheckIds(recovered);
  const rejectionCount = Number.isFinite(recovered?.rejectionCount) ? recovered.rejectionCount : null;
  const itemCount = Number.isFinite(recovered?.itemCount) ? recovered.itemCount : null;
  const lastAt = formatCorrectionsRecoveredAt(recovered?.lastAt);
  const itemClause = itemCount != null
    ? `${itemCount} outstanding correction item${itemCount === 1 ? '' : 's'}`
    : 'outstanding corrections';
  const rejectionClause = rejectionCount != null
    ? `rejected ${rejectionCount} time${rejectionCount === 1 ? '' : 's'} in a row`
    : 'rejected before this restart';
  const checkClause = ids.length
    ? ` on ${ids.length === 1 ? `check "${ids[0]}"` : `checks ${ids.map(id => `"${id}"`).join(', ')}`}`
    : '';
  const atClause = lastAt ? `, most recently at ${lastAt}` : '';
  return `This stage already has ${itemClause} from before a restart — ${rejectionClause}${checkClause}${atClause}.`;
};

// What the person is being asked to fix this round. A correction round keeps
// its stage's handoff code, so this is what distinguishes one round from the
// next for the same prompt.
const correctionSignature = (item) => (
  Array.isArray(item?.corrections) ? item.corrections.join('\u0000') : ''
);

const attachmentName = (filePath) => String(filePath || '').split(/[/\\]/).filter(Boolean).pop() || 'Attachment';

// Node ids are opaque persistence keys, not useful labels for a person who
// returns to several pending Job Search hubs. Give each owner a short,
// deterministic badge without displaying (or deriving a readable fragment
// from) that internal identifier.
const ownerBadgeForNode = (nodeId) => {
  const value = typeof nodeId === 'string' ? nodeId.trim() : '';
  if (!value) return null;
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return `Hub ${((hash >>> 0).toString(36).toUpperCase()).padStart(7, '0')}`;
};

/**
 * Global manual-AI handoff dock. A pending request is deliberately never
 * dismissed: Minimize only collapses this renderer UI, while Cancel task
 * rejects the matching request and cancels its owning job operation.
 */
export function NonApiAiDialog() {
  const [requests, setRequests] = useState([]);
  const [selectedRequestId, setSelectedRequestId] = useState(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [drafts, setDrafts] = useState({});
  const [errors, setErrors] = useState({});
  const [submittingRequestIds, setSubmittingRequestIds] = useState(() => new Set());
  const [steppingBackRequestIds, setSteppingBackRequestIds] = useState(() => new Set());
  const [cancellingRequestIds, setCancellingRequestIds] = useState(() => new Set());
  const [acceptedRequestIds, setAcceptedRequestIds] = useState(() => new Set());
  const [copiedRequestId, setCopiedRequestId] = useState(null);
  // Per-request opt-in to the full stage prompt during a correction round —
  // see showingFullRestartPrompt below for why this exists at all. Keyed by
  // requestId, like submittingRequestIds, so switching the active bundle
  // never leaks one bundle's reveal state onto another's.
  const [fullPromptRequestIds, setFullPromptRequestIds] = useState(() => new Set());
  // Holds the full ownership tuple captured when the confirm opens. The confirm
  // is async and a settled event can swap the active request underneath it, so
  // the prompt must act on what the user was actually looking at.
  const [cancelConfirmTarget, setCancelConfirmTarget] = useState(null);
  // Application-bundle items, published by discovery outside the canvas
  // provider tree (see applicationHandoffDock.js). Kept separate from the
  // push `requests` state and merged only for rendering, so the push
  // settle/replay effect below never has to reason about a second kind.
  const [applicationItems, setApplicationItems] = useState([]);
  const [discardingRequestIds, setDiscardingRequestIds] = useState(() => new Set());
  // A job-integrity failure takes no further paste; keyed by requestId so one
  // broken bundle does not affect any other item in the queue.
  const [brokenApplicationMessages, setBrokenApplicationMessages] = useState({});
  // Broken bundles the person has read and waved away. A fault OBSERVED BY
  // DISCOVERY lives on the published item, so discovery republishes it every
  // pass — clearing the message alone would let it reappear a moment later.
  // The bundle leaves the dock for good once its status poll marks the job
  // failed; until then this keeps Dismiss meaning what it says.
  const [dismissedBrokenRequestIds, setDismissedBrokenRequestIds] = useState(() => new Set());
  // Content fingerprints of every response this dock has actually sent — never
  // the text itself. State, not a ref, because the guard below is computed
  // during render and has to re-read this the moment a submit lands.
  // Whether a response was ACCEPTED is load-bearing rather than bookkeeping:
  // an answer this dock REJECTED may simply have been pasted into the wrong
  // prompt, and filing it where it belongs is the repair — so only an answer
  // accepted SOMEWHERE ELSE is proof of a duplicate.
  const [submittedResponses, setSubmittedResponses] = useState([]);
  const dockButtonRef = useRef(null);
  const copiedTimerRef = useRef(null);
  // The dock's two scrollers: the prompt box, and the panel body around it.
  // Both are reused for every prompt this dock ever shows, so their scroll
  // offsets have to be managed by hand — see the reset below, written next to
  // the text it belongs to.
  const promptFieldRef = useRef(null);
  const panelBodyRef = useRef(null);
  const promptScrollIdentityRef = useRef(null);
  const activeRequestIdRef = useRef(null);
  const requestsRef = useRef([]);
  const applicationItemsRef = useRef([]);
  // jobId -> the number shown on its chip. Assigned ONCE, when a bundle first
  // appears, and never recomputed: these chips are how someone keeps ten
  // parallel chats straight, so a bundle that was "3" has to stay "3" for its
  // whole life. Position cannot supply that — a scoring handoff arriving, or
  // any earlier bundle finishing, would renumber everything underneath them.
  // A finished bundle releases its number for the next NEW bundle to reuse,
  // which keeps the strip dense without ever renumbering a live one.
  const applicationOrdinalsRef = useRef(new Map());
  // Per-requestId debounce state for application draft saves, mirroring
  // ApplicationPasteDialog's draftTimerRef/pendingDraftRef but keyed because
  // several application items can be mid-edit across the dock's lifetime.
  const applicationDraftTimersRef = useRef(new Map());
  const actionRequestIdsRef = useRef(new Set());
  // A completed prompt can produce its successor only after its settled event
  // reaches this renderer. If there was no already-queued next item, do not
  // let the old correction prompt become the lasting selection in that gap.
  // The tuple also prevents an unrelated hub from stealing focus.
  const awaitingSuccessorRef = useRef(null);
  // Job cards asking the dock to open on their bundle. The request is raised
  // the moment Generate returns, which is BEFORE discovery has read that job's
  // first prompt off disk and published it — so the target usually is not in
  // the queue yet. Remember the job ids and apply one when its item arrives,
  // rather than selecting a requestId that does not exist and falling back to
  // whatever happens to be first. A Set, not one slot: queueing several
  // bundles in a row is the whole point of the 10-slot dock, and two Generate
  // presses before either is discovered must not cancel each other out.
  const pendingFocusJobIdsRef = useRef(new Set());

  // Push handoffs lead, application bundles trail; see mergeDockQueue's own
  // doc comment. Everything below — selection, the chip strip, drafts,
  // errors — is derived from this merged list, never from `requests` alone.
  const visibleApplicationItems = useMemo(() => (
    dismissedBrokenRequestIds.size === 0
      ? applicationItems
      : applicationItems.filter(item => !dismissedBrokenRequestIds.has(item.requestId))
  ), [applicationItems, dismissedBrokenRequestIds]);
  const mergedRequests = useMemo(() => mergeDockQueue(requests, visibleApplicationItems), [requests, visibleApplicationItems]);
  // Publish dismissals where the Generate cap can read them: JobCardNode lives
  // in another tree and must not count a bundle this dock has stopped showing.
  useEffect(() => {
    setDismissedApplicationBundles(dismissedBrokenRequestIds);
  }, [dismissedBrokenRequestIds]);
  const activeRequest = mergedRequests.find(request => request.requestId === selectedRequestId) || mergedRequests[0] || null;
  const activeRequestId = activeRequest?.requestId || null;
  // Async clipboard/IPC completions must never update whichever queued prompt
  // happened to become active while they were in flight.
  activeRequestIdRef.current = activeRequestId;
  const activeResponse = activeRequestId ? (drafts[activeRequestId] || '') : '';
  const activeError = activeRequestId ? (errors[activeRequestId] || '') : '';
  // The main process already supplies the specific local validation message.
  // Use the sterile typed receipt only as a fallback, rather than showing a
  // duplicate JSON blob beneath that human-readable message.
  const activeValidationDetails = activeError || formatValidationDiagnostic(activeRequest?.validationDiagnostic);

  const isApplicationRequest = activeRequest?.kind === 'application';
  // The same fault, whichever way it reached the dock: caught by submit(), or
  // read by a routine discovery pass that published a prompt-less item.
  const brokenApplicationMessage = isApplicationRequest && activeRequestId
    ? (brokenApplicationMessages[activeRequestId] || activeRequest.integrityMessage || '')
    : '';
  // Past pasting, not yet finished. The dock keeps showing these — see the
  // panel branch below for why vanishing here was the bug.
  const applicationWorkingState = isApplicationRequest && activeRequest.working
    ? (activeRequest.workingState === 'blocked' ? 'blocked' : 'working')
    : null;
  // The blocked headline names the card button by its exact label: this panel
  // is the one place the dock points at an affordance it does not own, and it
  // is now the only line that can carry it.
  const workingHeadline = applicationWorkingState === 'blocked'
    ? 'Needs a layout retry — press Retry layout check on its card'
    : 'Saving this application bundle…';
  const activeApplicationCorrections = isApplicationRequest ? (activeRequest.corrections || []) : [];
  // A correction round shows ONE prompt BY DEFAULT: the correction. The full
  // stage prompt existed only to start the answer over in a FRESH chat, which
  // is not how this is normally used — the correction is written for the chat
  // that already holds the stage context, and offering both made the person
  // choose between two things that look interchangeable and are not.
  const showingApplicationCorrection = isApplicationRequest
    && activeApplicationCorrections.length > 0;
  // The one case the correction cannot answer: the chat itself is anchored on
  // a stale envelope (e.g. a handoffCode a fit-revision rotated behind the
  // chat's back — see the CONTENT gate in validatePasteResponse), and a
  // correction written FOR that chat cannot break its own anchor. The full
  // stage prompt is self-contained and carries the CURRENT shared fields, so
  // it is the one artifact that can — but only pasted into a NEW chat; the
  // anchored chat would just echo the same stale code again. Reveal it as a
  // subordinate, explicitly-labelled escape hatch per request, never a peer
  // toggle, so it cannot read as interchangeable with the correction above.
  const showingFullRestartPrompt = showingApplicationCorrection
    && fullPromptRequestIds.has(activeRequestId);
  const activeApplicationPrompt = isApplicationRequest
    ? (showingApplicationCorrection && !showingFullRestartPrompt ? (activeRequest.correctionPrompt || '') : (activeRequest.prompt || ''))
    : '';
  // Exactly what the prompt box shows. Rendered, copied and scrolled from
  // this one value, so the three can never disagree about which prompt is on
  // screen.
  const displayedPrompt = isApplicationRequest ? activeApplicationPrompt : (activeRequest?.prompt || '');
  // A textarea keeps its scroll offset when its value changes, and this one is
  // reused for every prompt in the queue. So submitting a response from
  // halfway down a long prompt opened the NEXT prompt at that same offset:
  // mid-sentence in a document nobody had read yet, with nothing on screen
  // saying the box had moved on, and the shared fields a new prompt has to be
  // read from scrolled out of view above. Send it back to the top whenever the
  // text changes identity: a stage accepted and re-coded, a correction
  // reissued against the same code, a different chip selected, or the
  // full-stage prompt revealed. Scrolling WITHIN one prompt is untouched,
  // because the identity holds still while the person reads. Layout effect,
  // not effect: the reset has to land in the same frame as the new text, or
  // the old offset paints first and the box visibly jumps.
  //
  // The panel body around it is a second scroller with the same fault, so it
  // rides the same trigger — it is the same event, a new prompt. Its height
  // genuinely differs prompt to prompt (the attachments block, the error
  // banner, the fix-count chip and the full-prompt escape hatch all come and
  // go), so a leftover offset there does not merely hold position near the
  // buttons: it lands on unrelated content, or pushes the buttons off the
  // bottom of a shorter prompt.
  const promptScrollIdentity = [
    activeRequestId || '',
    activeRequest?.handoffCode || '',
    String(activeRequest?.revision ?? ''),
    correctionSignature(activeRequest),
    showingFullRestartPrompt ? 'full-stage' : 'as-shown',
    displayedPrompt,
  ].join('\n');
  useLayoutEffect(() => {
    if (promptScrollIdentityRef.current === promptScrollIdentity) return;
    const field = promptFieldRef.current;
    const body = panelBodyRef.current;
    // Nothing to do while the dock is collapsed: both scrollers mount at the
    // top on their own, and recording an identity neither of them displayed
    // would skip the reset for whichever prompt is showing when it reopens.
    if (!field && !body) return;
    promptScrollIdentityRef.current = promptScrollIdentity;
    if (field) {
      field.scrollTop = 0;
      field.scrollLeft = 0;
    }
    // The body scrolls vertically only; leaving scrollLeft alone keeps this
    // from asserting a horizontal offset the panel never has.
    if (body) body.scrollTop = 0;
  }, [promptScrollIdentity]);

  // ONE numbering rule for the whole dock. The chip strip reads it, and so
  // does every message that has to NAME another prompt — a person told "this
  // belongs to Application 3" has to find a chip that reads 3. Two rules would
  // eventually disagree and send them to the wrong chat, which is the exact
  // mistake this guard exists to stop.
  const describeQueuedPrompt = useCallback((request, index) => {
    if (!request) return { selectorLabel: '', label: 'another prompt' };
    const applicationOrdinal = request.kind === 'application'
      ? applicationOrdinalsRef.current.get(request.jobId)
      : null;
    const selectorLabel = applicationOrdinal
      ? String(applicationOrdinal)
      : Number.isFinite(request.batch) ? String(request.batch) : String(index + 1);
    const count = Number.isFinite(request.itemCount) ? ` · ${request.itemCount}` : '';
    // The positional fallback is last: a prompt recorded for the duplicate
    // check may have left the queue by the time its label is read, and there
    // is no honest position for it then.
    const label = applicationOrdinal
      ? `Application ${applicationOrdinal}`
      : Number.isFinite(request.batch)
        ? `Batch ${request.batch}${count}`
        : Number.isFinite(index) && index >= 0
          ? `Prompt ${index + 1}${count}`
          : 'another prompt';
    return { selectorLabel, label };
  }, []);

  // Push prompts always carry a HANDOFF-XXXXXX stamp, so this scan only ever
  // fires for push items; an application item's base64url code never matches
  // usesPushHandoffCode, and comparing it against this shape would describe
  // the prompt with a code its own text does not contain.
  let detectedMismatch = null;
  if (usesPushHandoffCode(activeRequest) && activeResponse) {
    detectedMismatch = findMismatchedHandoffStamp(activeResponse, activeRequest.handoffCode);
  }
  const draftMismatchError = detectedMismatch
    ? `This response is stamped ${detectedMismatch}, but this prompt is ${activeRequest.handoffCode} — it is the answer to a different handoff. Nothing was saved. Find the chat whose prompt header reads ${activeRequest.handoffCode} and paste that answer here. (Each prompt carries its own code precisely so two batches of the same task cannot be swapped.)`
    : '';
  // The mirror image for an application item: any well-formed HANDOFF-XXXXXX
  // stamp in the pasted text is a job-SCORING answer, not this application's
  // own code, pasted into the wrong prompt.
  let applicationCrossPasteError = '';
  if (isApplicationRequest && activeResponse) {
    const stamp = findMismatchedHandoffStamp(activeResponse, activeRequest.handoffCode);
    if (stamp) {
      applicationCrossPasteError = `This response is stamped ${stamp}, which is a job-scoring handoff code. This prompt is the ${applicationStageLabel(activeRequest.stage).toLowerCase()} bundle for ${activeRequest.subject || 'this application'}, and it does not use that kind of code. Nothing was saved. Find the application prompt for this job in your AI chat and paste that answer here instead.`;
    }
  }
  // Neither scan above can see the two mistakes this one is for. A `HANDOFF-`
  // stamp is the only thing they read, so an application bundle answered in
  // the wrong chat — bundle 2's answer pasted into bundle 1 — carries no stamp
  // to disagree with and sails past both; the host catches it on jobId, but
  // only after a round trip that hands the correction machinery a complaint
  // about the envelope instead of the documents. And nothing at all noticed a
  // response that was already filed under a different prompt.
  //
  // This guard only ever matches a value the QUEUE ALREADY HOLDS — another
  // pending prompt's code, its job id, or a fingerprint this dock itself sent
  // and saw accepted. It never infers a conflict from a value merely being
  // unfamiliar, because a wrong block stops a submit with no way around it.
  const pasteAssessment = useMemo(() => assessPastedResponse({
    response: activeResponse,
    activeRequest,
    queuedRequests: mergedRequests,
    priorSubmissions: submittedResponses,
  }), [activeResponse, activeRequest, mergedRequests, submittedResponses]);
  const misdirectedOwnerIndex = pasteAssessment.block?.ownerRequestId
    ? mergedRequests.findIndex(request => request.requestId === pasteAssessment.block.ownerRequestId)
    : -1;
  const misdirectedOwnerRequestId = misdirectedOwnerIndex >= 0
    ? mergedRequests[misdirectedOwnerIndex].requestId
    : null;
  // The owning prompt may have settled since it took this answer, so fall back
  // to the label recorded when it was sent rather than naming nothing.
  const misdirectedOwnerName = misdirectedOwnerIndex >= 0
    ? describeQueuedPrompt(mergedRequests[misdirectedOwnerIndex], misdirectedOwnerIndex).label
    : (pasteAssessment.block?.ownerLabel || 'another prompt');
  let misdirectedPasteError = '';
  // Silent when either older scan already spoke: they describe the same paste
  // in more specific terms, and two red paragraphs saying one thing reads as
  // two problems.
  if (pasteAssessment.block && !draftMismatchError && !applicationCrossPasteError) {
    misdirectedPasteError = pasteAssessment.block.reason === 'already-submitted'
      ? `This exact response was already sent for ${misdirectedOwnerName} and accepted there. Nothing was saved. If this prompt is still unanswered, its own answer is in the chat whose prompt header reads ${activeRequest.handoffCode || 'this prompt’s code'} — paste that here instead.`
      : `This response answers ${misdirectedOwnerName}: it ${pasteAssessment.block.detail}. Nothing was saved. Send it to that prompt, and paste this prompt’s own answer here.`;
  }
  // Never blocks. Re-sending identical text under a rotated code is a genuine
  // repair — a handoff code can rotate without the documents changing, and a
  // hard block there once trapped a live round with no way out — so this only
  // says what it sees.
  const repeatedPasteNotice = pasteAssessment.notice
    ? 'This is the same text that was already sent for this prompt. If it was refused, the correction above asks for a regenerated answer — re-sending it unchanged spends another round on the same result.'
    : '';
  const responseCrossPasteBlocked = Boolean(draftMismatchError) || Boolean(applicationCrossPasteError) || Boolean(misdirectedPasteError);
  // An application rejection already states itself twice over: the header line
  // says the previous answer did not validate, and the correction prompt the
  // person is about to copy carries every fix verbatim. Repeating the
  // validator's own text in a red box below only crowded the paste area off
  // screen. A cross-paste block is different — it stops a submit, and nothing
  // else says why — so that one still shows.
  const effectiveError = isApplicationRequest
    ? [applicationCrossPasteError, misdirectedPasteError].filter(Boolean).join('\n')
    : [...new Set([draftMismatchError, misdirectedPasteError, activeValidationDetails].filter(Boolean))].join('\n');
  const isSubmitting = activeRequestId ? submittingRequestIds.has(activeRequestId) : false;
  const isSteppingBack = activeRequestId ? steppingBackRequestIds.has(activeRequestId) : false;
  const isCancelling = activeRequestId ? cancellingRequestIds.has(activeRequestId) : false;
  const isDiscarding = activeRequestId ? discardingRequestIds.has(activeRequestId) : false;
  const isAccepted = activeRequestId ? acceptedRequestIds.has(activeRequestId) : false;
  const isCopied = copiedRequestId === activeRequestId;
  const isCorrection = activeRequest?.isCorrection === true;
  const validationCode = typeof activeRequest?.validationCode === 'string'
    ? activeRequest.validationCode
    : '';
  const correctionGuidance = isCorrection
    ? correctionGuidanceFor(validationCode, activeRequest?.validationDiagnostic)
    : '';
  // Set only for an application round whose correction prompt actually
  // carried an escalation block — never recomputed, only read off the item
  // applicationDockRequest copied it onto (see that function's own header).
  // Independent of showingFullRestartPrompt below: switching to the full
  // stage prompt changes which TEXT is on screen, not whether this round is
  // the one where a check got stuck, so the banner has to survive that
  // toggle rather than disappear the moment someone reaches for the escape
  // hatch.
  const activeRejectionEscalation = isApplicationRequest && hasActiveEscalation(activeRequest?.rejectionEscalation)
    ? activeRequest.rejectionEscalation
    : null;
  // Mirrors activeRejectionEscalation immediately above: gated on
  // isApplicationRequest first so a non-application request never reads this
  // field at all, then on hasActiveCorrectionsRecovered so an absent,
  // undefined, or `active`-false payload — including every build that
  // predates this field — resolves to null and the notice below simply does
  // not render, exactly as if this field did not exist.
  const activeCorrectionsRecovered = isApplicationRequest && hasActiveCorrectionsRecovered(activeRequest?.correctionsRecovered)
    ? activeRequest.correctionsRecovered
    : null;

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onNonApiAiRequest || !api?.onNonApiAiSettled) return undefined;

    const removeRequest = (payload) => {
      const requestId = typeof payload === 'string' ? payload : payload?.requestId;
      if (!requestId) return;
      const currentRequests = requestsRef.current;
      const selection = selectionAfterHandoffSettlement({
        queue: currentRequests,
        settledRequestId: requestId,
        activeRequestId: activeRequestIdRef.current,
        accepted: payload?.accepted === true,
      });
      awaitingSuccessorRef.current = successorPreferenceAfterSettlement({
        existing: awaitingSuccessorRef.current,
        selection,
        settledRequestId: requestId,
        activeRequestId: activeRequestIdRef.current,
      });
      if (selection.focus === 'awaiting-successor') {
        EventLogger.log('[Manual AI] handoff settled; focus awaiting workflow successor');
      } else if (selection.focus === 'queued-successor') {
        EventLogger.log('[Manual AI] handoff settled; focus advanced to queued successor');
      } else if (selection.focus === 'preserved') {
        EventLogger.log('[Manual AI] handoff settled; preserved user-selected handoff');
      } else {
        EventLogger.log('[Manual AI] handoff settled; focus cleared');
      }
      setRequests(previous => previous.filter(request => request.requestId !== requestId));
      setSelectedRequestId(selection.selectedRequestId);
      setDrafts(previous => {
        if (!(requestId in previous)) return previous;
        const { [requestId]: _removed, ...remaining } = previous;
        return remaining;
      });
      setErrors(previous => {
        if (!(requestId in previous)) return previous;
        const { [requestId]: _removed, ...remaining } = previous;
        return remaining;
      });
      setSubmittingRequestIds(previous => {
        if (!previous.has(requestId)) return previous;
        const next = new Set(previous);
        next.delete(requestId);
        return next;
      });
      setSteppingBackRequestIds(previous => {
        if (!previous.has(requestId)) return previous;
        const next = new Set(previous);
        next.delete(requestId);
        return next;
      });
      setCancellingRequestIds(previous => {
        if (!previous.has(requestId)) return previous;
        const next = new Set(previous);
        next.delete(requestId);
        return next;
      });
      setAcceptedRequestIds(previous => {
        if (!previous.has(requestId)) return previous;
        const next = new Set(previous);
        next.delete(requestId);
        return next;
      });
      setCopiedRequestId(previous => previous === requestId ? null : previous);
      setFullPromptRequestIds(previous => {
        if (!previous.has(requestId)) return previous;
        const next = new Set(previous);
        next.delete(requestId);
        return next;
      });
    };

    const receiveRequest = (incoming) => {
      if (!incoming?.requestId || typeof incoming.prompt !== 'string') return;
      const successor = awaitingSuccessorRef.current;
      if (isWorkflowSuccessor(successor, incoming)) {
        // The workflow issued this only after the selected prompt settled.
        // Prefer it over an older correction that merely happened to be the
        // last remaining item while the continuation was being prepared.
        awaitingSuccessorRef.current = null;
        setSelectedRequestId(incoming.requestId);
        EventLogger.log('[Manual AI] workflow successor issued; focus advanced from prior completed handoff');
      }
      if (incoming.nodeId && incoming.runId) {
        document.dispatchEvent(new CustomEvent('non-api-ai-node-pending', {
          detail: {
            nodeId: incoming.nodeId,
            runId: incoming.runId,
            task: incoming.task || null,
            stepKey: incoming.stepKey || null,
            recoveryMode: incoming.recoveryMode || null,
          },
        }));
      }
      const validationError = stringifyValidationError(incoming.validationError);
      setRequests(previous => {
        const index = previous.findIndex(request => request.requestId === incoming.requestId);
        if (index >= 0) {
          const next = [...previous];
          next[index] = { ...next[index], ...incoming };
          return next;
        }
        // Arrival order is not a stable batch-order contract: concurrent
        // handoffs independently perform durable lookups and preflight work
        // before reaching the renderer. Insert by batch number so the chip
        // strip, the `requests[0]` default selection, and removeRequest's
        // adjacency fallback follow the order the person is asked to work
        // through. Ordering is scoped to one owner (same node + task);
        // unrelated or unnumbered handoffs retain arrival order.
        const next = [...previous];
        let at = next.length;
        for (let i = 0; i < next.length; i += 1) {
          const queued = next[i];
          if (queued.nodeId === incoming.nodeId
            && queued.task === incoming.task
            && Number.isFinite(queued.batch)
            && Number.isFinite(incoming.batch)
            && queued.batch > incoming.batch) { at = i; break; }
        }
        next.splice(at, 0, incoming);
        return next;
      });
      if (typeof incoming.initialResponse === 'string' && incoming.initialResponse) {
        setDrafts(previous => (
          previous[incoming.requestId] === undefined
            ? { ...previous, [incoming.requestId]: incoming.initialResponse }
            : previous
        ));
        // A non-empty initial response is emitted only by a genuine rewind.
        // Bring that reissued predecessor to the front even if unrelated
        // handoffs are also queued in the global dialog.
        setSelectedRequestId(incoming.requestId);
      }
      if (validationError) {
        setErrors(previous => ({ ...previous, [incoming.requestId]: validationError }));
        setAcceptedRequestIds(previous => {
          if (!previous.has(incoming.requestId)) return previous;
          const next = new Set(previous);
          next.delete(incoming.requestId);
          return next;
        });
      }
    };

    // Both listeners are registered before replaying outstanding prompts.
    // This closes both races: a job can issue its first request from a sibling
    // mount effect, and this app-level dialog can remount while the same
    // renderer frame remains live. `receiveRequest` de-duplicates replays by
    // request id. A true renderer navigation cancels its job in the main
    // process rather than preserving a prompt with no response UI.
    const unsubscribeRequest = api.onNonApiAiRequest(receiveRequest);
    const unsubscribeSettled = api.onNonApiAiSettled(removeRequest);
    void api.replayPendingNonApiAiRequests?.().catch(() => {
      // The ordinary live IPC listeners still work if an older main process
      // does not yet provide replay support.
    });
    return () => {
      unsubscribeRequest?.();
      unsubscribeSettled?.();
    };
  }, []);

  requestsRef.current = requests;
  applicationItemsRef.current = applicationItems;

  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, []);

  // A job card pointing the person at its bundle: after Generate, and from
  // the card's own Continue action. The card owns no dialog any more, so this
  // is the only way either control reaches a prompt.
  useEffect(() => {
    return subscribeApplicationHandoffFocus((jobId) => {
      const requestId = applicationRequestId(jobId);
      // Already queued: select it now. Not yet: remember it for the discovery
      // pass that publishes it (see the subscription below).
      // An explicit ask from the card outranks a prior Dismiss: the person is
      // pointing at this exact bundle, so put it back in the queue.
      setDismissedBrokenRequestIds(previous => {
        if (!previous.has(requestId)) return previous;
        const next = new Set(previous);
        next.delete(requestId);
        return next;
      });
      if (applicationItemsRef.current.some(item => item.requestId === requestId)) {
        pendingFocusJobIdsRef.current.delete(jobId);
        awaitingSuccessorRef.current = null;
        setSelectedRequestId(requestId);
        setIsExpanded(true);
        EventLogger.log('[Manual AI] application bundle focused in the handoff dock');
        return;
      }
      pendingFocusJobIdsRef.current.add(jobId);
    });
  }, []);

  // Adapt whatever discovery has published into this dock's per-requestId
  // dictionaries. An application item's requestId is stable across its whole
  // life (it is derived from the job id, not minted per prompt), so unlike a
  // settled push handoff — which simply disappears and is replaced by a
  // request with a NEW id — the same requestId here can go on to describe a
  // different prompt entirely once its handoffCode changes underneath it.
  useEffect(() => {
    return subscribeApplicationHandoffs((items) => {
      const previousItems = applicationItemsRef.current;
      const previousByRequestId = new Map(previousItems.map(item => [item.requestId, item]));
      const nextIds = new Set(items.map(item => item.requestId));

      const clearRequestEphemeralState = (requestId, { keepDraft = false } = {}) => {
        if (!keepDraft) {
          setDrafts(previous => {
            if (!(requestId in previous)) return previous;
            const { [requestId]: _cleared, ...remaining } = previous;
            return remaining;
          });
        }
        setErrors(previous => {
          if (!(requestId in previous)) return previous;
          const { [requestId]: _cleared, ...remaining } = previous;
          return remaining;
        });
        setAcceptedRequestIds(previous => {
          if (!previous.has(requestId)) return previous;
          const next = new Set(previous);
          next.delete(requestId);
          return next;
        });
        setBrokenApplicationMessages(previous => {
          if (!(requestId in previous)) return previous;
          const { [requestId]: _cleared, ...remaining } = previous;
          return remaining;
        });
        // The full-prompt reveal answers ONE anchored round (see the comment
        // above showingFullRestartPrompt). Without this, a reveal opened on
        // e.g. a résumé-stage correction stayed set through this same stable
        // requestId's later, unrelated cover-letter-stage correction — it
        // would open on "Full stage prompt" instead of that round's
        // correction, and the amber fix-count chip (gated on
        // !showingFullRestartPrompt) would stay hidden behind it.
        setFullPromptRequestIds(previous => {
          if (!previous.has(requestId)) return previous;
          const next = new Set(previous);
          next.delete(requestId);
          return next;
        });
      };

      for (const item of items) {
        const prior = previousByRequestId.get(item.requestId);
        // Not handoffCode alone: the durable stage machine mints a NEW code
        // only when it ACCEPTS a response (localAiApplication.js advances the
        // stage and re-codes there). An ordinary JSON-parse or schema
        // rejection deliberately reissues the SAME code with fresh
        // corrections, so keying the reset on the code alone would leave a
        // correction round showing the previous round's "full prompt" toggle
        // and stale error. Treat a changed correction set as a new prompt too.
        if (prior && prior.handoffCode === item.handoffCode
          && correctionSignature(prior) === correctionSignature(item)) continue;
        // A fresh prompt under this same requestId — the stage advanced, or a
        // rejection reissued a correction. Discovery is authoritative now, so
        // adopt its saved draft and drop whatever this dock tracked for the
        // prompt that just settled, the same way a settled push handoff's
        // dictionaries are cleared below.
        clearRequestEphemeralState(item.requestId, { keepDraft: true });
        const codeChanged = !prior || prior.handoffCode !== item.handoffCode;
        setDrafts(previous => {
          const current = previous[item.requestId];
          const restored = item.initialResponse || '';
          if (current === restored) return previous;
          // A CHANGED CODE means the stage was accepted and this is a new
          // prompt: the old draft answered the stage that just closed, and
          // the textarea was disabled behind "Accepted" while that settled,
          // so nothing of the person's can be sitting in it.
          if (codeChanged) return { ...previous, [item.requestId]: restored };
          // Same code, new corrections: an ordinary rejection, where submit()
          // has already emptied the box on purpose. Never restore a draft
          // here. `initialResponse` is whatever is ON DISK, and the durable
          // clear that follows a rejection is asynchronous — so a refresh
          // that lands first would put the just-rejected text straight back
          // into a box the person watched empty. submit() clears
          // isSubmitting in its finally, re-enabling the textarea
          // IMMEDIATELY, so they may also already be typing the replacement;
          // either way this dock's copy is the authority for a correction
          // round and discovery has nothing to add to it.
          return previous;
        });
      }

      for (const prior of previousItems) {
        if (nextIds.has(prior.requestId)) continue;
        // The job left the dock entirely (discarded, or its final stage
        // completed). Clear every dictionary keyed by its requestId, and any
        // debounced draft write still in flight for it — a late write for a
        // job that is already gone must not resurrect a file the person just
        // watched disappear.
        clearRequestEphemeralState(prior.requestId);
        setSubmittingRequestIds(previous => {
          if (!previous.has(prior.requestId)) return previous;
          const next = new Set(previous);
          next.delete(prior.requestId);
          return next;
        });
        setDiscardingRequestIds(previous => {
          if (!previous.has(prior.requestId)) return previous;
          const next = new Set(previous);
          next.delete(prior.requestId);
          return next;
        });
        setCopiedRequestId(previous => previous === prior.requestId ? null : previous);
        setDismissedBrokenRequestIds(previous => {
          if (!previous.has(prior.requestId)) return previous;
          const next = new Set(previous);
          next.delete(prior.requestId);
          return next;
        });
        const timers = applicationDraftTimersRef.current;
        const pendingTimer = timers.get(prior.requestId);
        if (pendingTimer) {
          clearTimeout(pendingTimer.timer);
          timers.delete(prior.requestId);
        }
      }

      // A card asked for this bundle before discovery could publish it. Now
      // that it exists, select it and open the dock — otherwise pressing
      // Generate (or Continue AI handoff) appears to do nothing at all.
      // Consume the FIRST awaited focus that has now arrived, and only that
      // one — the rest stay pending so each card's request is honoured as its
      // own bundle appears, instead of the newest press winning outright.
      const awaitingFocus = pendingFocusJobIdsRef.current;
      let focused = false;
      for (const focusJobId of [...awaitingFocus]) {
        const focusRequestId = applicationRequestId(focusJobId);
        if (!items.some(item => item.requestId === focusRequestId)) continue;
        // Every id whose bundle has now arrived is satisfied, even though only
        // the first one is shown. Leaving the others queued would let a bundle
        // the person asked for minutes ago seize the panel on some later,
        // unrelated publish, yanking them off the prompt they are working on.
        awaitingFocus.delete(focusJobId);
        if (focused) continue;
        focused = true;
        awaitingSuccessorRef.current = null;
        setSelectedRequestId(focusRequestId);
        setIsExpanded(true);
        EventLogger.log('[Manual AI] application bundle focused in the handoff dock');
      }

      // Render in ordinal order, not discovery order: the underlying node
      // enumeration is free to change between passes, and the chips must not
      // move under someone mid-paste.
      const ordered = assignApplicationOrdinals(applicationOrdinalsRef.current, items);
      applicationItemsRef.current = ordered;
      setApplicationItems(ordered);
    });
  }, []);

  // A pending debounced application draft write must survive this dock
  // unmounting, the same way ApplicationPasteDialog flushes on close — an
  // in-flight window-close/unmount is not a reason to drop the last edit.
  useEffect(() => () => {
    for (const [, pending] of applicationDraftTimersRef.current) {
      clearTimeout(pending.timer);
      if (window.electronAPI?.updateLocalApplicationDraft) {
        void window.electronAPI.updateLocalApplicationDraft(pending.payload).catch(() => {});
      }
    }
  }, []);

  const scheduleApplicationDraftSave = useCallback((requestId, payload) => {
    if (!window.electronAPI?.updateLocalApplicationDraft) return;
    const timers = applicationDraftTimersRef.current;
    const existing = timers.get(requestId);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      timers.delete(requestId);
      // Tracked so the quit handshake can await this write; a debounced edit
      // must not trail window destruction.
      trackApplicationDraftWrite(window.electronAPI.updateLocalApplicationDraft(payload)).catch(() => {});
    }, 350);
    timers.set(requestId, { timer, payload });
  }, []);

  const flushApplicationDraftSave = useCallback((requestId) => {
    const timers = applicationDraftTimersRef.current;
    const pending = timers.get(requestId);
    if (!pending) return;
    timers.delete(requestId);
    clearTimeout(pending.timer);
    if (window.electronAPI?.updateLocalApplicationDraft) {
      trackApplicationDraftWrite(window.electronAPI.updateLocalApplicationDraft(pending.payload)).catch(() => {});
    }
  }, []);

  // Shutdown drains this: fire every debounced draft NOW so its IPC exists to
  // be awaited. Registered once for the dock's whole life, because the dock is
  // never unmounted before the window is destroyed.
  useEffect(() => registerApplicationDraftFlusher(() => {
    for (const requestId of [...applicationDraftTimersRef.current.keys()]) {
      flushApplicationDraftSave(requestId);
    }
  }), [flushApplicationDraftSave]);

  const setActiveResponse = useCallback((response) => {
    if (!activeRequestId) return;
    setDrafts(previous => ({ ...previous, [activeRequestId]: response }));
    if (isApplicationRequest) {
      // Debounced the same way ApplicationPasteDialog debounces its own
      // draft writes, so a fast keystroke stream does not IPC on every char.
      scheduleApplicationDraftSave(activeRequestId, {
        jobId: activeRequest.jobId,
        canvasFilePath: activeRequest.canvasFilePath,
        handoffCode: activeRequest.handoffCode,
        draft: response,
      });
    } else {
      // Queue every edit in the main process. Writes are serialized there, and
      // the window-close handshake waits for that queue before destroying the
      // renderer, so even a close immediately after Paste retains the draft.
      void window.electronAPI?.updateNonApiAiDraft?.(activeRequestId, response).catch(() => {});
    }
    setErrors(previous => {
      if (!previous[activeRequestId]) return previous;
      const { [activeRequestId]: _cleared, ...remaining } = previous;
      return remaining;
    });
  }, [activeRequest, activeRequestId, isApplicationRequest, scheduleApplicationDraftSave]);

  const copyPrompt = useCallback(async () => {
    if (!activeRequest) return;
    const textToCopy = displayedPrompt;
    if (!textToCopy) return;
    const requestId = activeRequest.requestId;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.');
      // Whatever is on screen is what gets copied — for an application item
      // showing corrections, that is the correction prompt, not the original.
      await navigator.clipboard.writeText(textToCopy);
      setCopiedRequestId(requestId);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => {
        copiedTimerRef.current = null;
        setCopiedRequestId(previous => previous === requestId ? null : previous);
      }, 2000);
    } catch (error) {
      setErrors(previous => ({
        ...previous,
        [requestId]: error?.message || 'Could not copy the prompt. Select it and copy manually.',
      }));
    }
  }, [activeRequest, displayedPrompt]);

  const revealAttachment = useCallback(async (filePath) => {
    if (!activeRequestId || !filePath) return;
    const requestId = activeRequestId;
    try {
      if (!window.electronAPI?.revealNonApiAiAttachment) {
        throw new Error('Showing attachments in Finder is unavailable.');
      }
      await window.electronAPI.revealNonApiAiAttachment(requestId, filePath);
    } catch (error) {
      setErrors(previous => ({
        ...previous,
        [requestId]: error?.message || 'Could not show that attachment in Finder.',
      }));
    }
  }, [activeRequestId]);

  // Remembered the moment a response leaves this dock, accepted or not, so
  // the guard above can recognise it if it is pasted somewhere else. Only a
  // fingerprint is kept: the text itself is already on disk where it belongs,
  // and a second copy here would be a second thing to leak.
  const recordSubmittedResponse = useCallback((request, index, response, accepted) => {
    const fingerprint = responseFingerprint(response);
    // Short answers are never fingerprinted at all — they can legitimately
    // repeat across prompts, and a false duplicate has no escape.
    if (!fingerprint || !request?.requestId) return;
    const { label } = describeQueuedPrompt(request, index);
    setSubmittedResponses(previous => {
      const next = previous.filter(entry => !(
        entry.fingerprint === fingerprint && entry.requestId === request.requestId
      ));
      next.push({
        fingerprint,
        requestId: request.requestId,
        handoffCode: request.handoffCode || '',
        jobId: request.jobId || '',
        label,
        accepted: Boolean(accepted),
      });
      return next.length > SUBMITTED_RESPONSE_MEMORY
        ? next.slice(next.length - SUBMITTED_RESPONSE_MEMORY)
        : next;
    });
  }, [describeQueuedPrompt]);

  const submit = useCallback(async (event) => {
    event?.preventDefault();
    if (!activeRequestId || !activeResponse.trim() || isSubmitting || isSteppingBack || isCancelling || isDiscarding || isAccepted) return;
    if (responseCrossPasteBlocked) return;
    if (actionRequestIdsRef.current.has(activeRequestId)) return;

    if (isApplicationRequest) {
      if (!window.electronAPI?.submitLocalApplicationHandoff) {
        setErrors(previous => ({ ...previous, [activeRequestId]: 'Application response submission is unavailable.' }));
        return;
      }
      const requestId = activeRequestId;
      const { jobId, canvasFilePath, handoffCode } = activeRequest;
      // Read before the await: the queue can shift underneath a slow submit,
      // and this label has to name the prompt the answer actually went to.
      const submittedIndex = mergedRequests.findIndex(item => item.requestId === requestId);
      actionRequestIdsRef.current.add(requestId);
      // The submitted response is authoritative for this handoff code. Flush
      // (not merely cancel) any debounced draft write in flight so a slower
      // save from an earlier keystroke cannot land after this stage moves on
      // and silently overwrite the next stage's draft under a now-stale code.
      flushApplicationDraftSave(requestId);
      setSubmittingRequestIds(previous => new Set(previous).add(requestId));
      setErrors(previous => {
        const { [requestId]: _cleared, ...remaining } = previous;
        return remaining;
      });
      try {
        const result = await window.electronAPI.submitLocalApplicationHandoff({
          jobId, canvasFilePath, handoffCode, response: activeResponse,
        });
        recordSubmittedResponse(activeRequest, submittedIndex, activeResponse, Boolean(result?.accepted));
        if (!result?.accepted) {
          // The job failed on state this response never supplied, so there is
          // no correction round to send back: stop asking for a paste it
          // cannot use instead of inviting one more that fails the same way.
          const brokenMessage = jobIntegrityFailureMessage(result);
          if (brokenMessage) {
            setBrokenApplicationMessages(previous => ({ ...previous, [requestId]: brokenMessage }));
            return;
          }
          const detail = stringifyValidationError(result?.validationErrors) ||
            stringifyValidationError(result?.error) ||
            'That response could not be validated. Adjust it and try again.';
          setErrors(previous => ({ ...previous, [requestId]: detail }));
          // Clear the box the moment the answer is rejected. What is in it is
          // the text the app just refused, and the correction asks for the
          // COMPLETE regenerated answer — so every character of it has to go
          // anyway. Leaving it there invited pasting on top of a 3,800-character
          // block that has to be selected away first, and made a fresh paste
          // look appended rather than replacing.
          setDrafts(previous => (previous[requestId] === '' ? previous : { ...previous, [requestId]: '' }));
          // The durable draft is cleared too, so reopening this bundle later
          // does not restore the rejected text the dock just discarded.
          flushApplicationDraftSave(requestId);
          if (window.electronAPI?.updateLocalApplicationDraft) {
            trackApplicationDraftWrite(window.electronAPI.updateLocalApplicationDraft({
              jobId, canvasFilePath: activeRequest.canvasFilePath, handoffCode: activeRequest.handoffCode, draft: '',
            })).catch(() => {});
          }
          // The next discovery read supplies whatever corrections and revised
          // prompt the durable stage machine issued for this rejection.
          requestApplicationHandoffRefresh(jobId);
          return;
        }
        // Do not close optimistically: discovery re-reads the authoritative
        // stage, and this item's requestId reappears — unchanged or advanced
        // — once that refresh republishes it.
        setAcceptedRequestIds(previous => new Set(previous).add(requestId));
        // This bundle now keeps its chip while the app finishes it. Before
        // that it VANISHED here and focus fell through to whatever was first,
        // so advancing deliberately is what PRESERVES the old flow rather
        // than changing it — otherwise the panel would newly pin itself to a
        // bundle that wants nothing from anyone. Only once, from here: a
        // later click back onto the saving chip sticks, because nothing
        // re-runs this.
        const nextWaiting = mergedRequests.find(item => item.requestId !== requestId && !item.working);
        if (nextWaiting) {
          awaitingSuccessorRef.current = null;
          setSelectedRequestId(nextWaiting.requestId);
        }
        requestApplicationHandoffRefresh(jobId);
      } catch (error) {
        setErrors(previous => ({
          ...previous,
          [requestId]: error?.message || 'Could not submit that response. Please try again.',
        }));
      } finally {
        actionRequestIdsRef.current.delete(requestId);
        setSubmittingRequestIds(previous => {
          if (!previous.has(requestId)) return previous;
          const next = new Set(previous);
          next.delete(requestId);
          return next;
        });
      }
      return;
    }

    if (!window.electronAPI?.submitNonApiAiResponse) {
      setErrors(previous => ({ ...previous, [activeRequestId]: 'Manual AI response submission is unavailable.' }));
      return;
    }

    const requestId = activeRequestId;
    const submittedIndex = mergedRequests.findIndex(item => item.requestId === requestId);
    actionRequestIdsRef.current.add(requestId);
    setSubmittingRequestIds(previous => new Set(previous).add(requestId));
    setErrors(previous => {
      const { [activeRequestId]: _cleared, ...remaining } = previous;
      return remaining;
    });
    try {
      const result = await window.electronAPI.submitNonApiAiResponse({
        requestId,
        response: activeResponse,
      });
      recordSubmittedResponse(activeRequest, submittedIndex, activeResponse, Boolean(result?.accepted));
      if (result?.accepted) {
        // Do not close optimistically. The settled event is the authoritative
        // signal that this particular request has left the main-process queue.
        setAcceptedRequestIds(previous => new Set(previous).add(requestId));
      } else {
        const detail = stringifyValidationError(result?.validationErrors) ||
          stringifyValidationError(result?.error) ||
          'That response could not be validated. Adjust it and try again.';
        setErrors(previous => ({ ...previous, [requestId]: detail }));
      }
    } catch (error) {
      setErrors(previous => ({
        ...previous,
        [requestId]: error?.message || 'Could not submit that response. Please try again.',
      }));
    } finally {
      actionRequestIdsRef.current.delete(requestId);
      setSubmittingRequestIds(previous => {
        if (!previous.has(requestId)) return previous;
        const next = new Set(previous);
        next.delete(requestId);
        return next;
      });
    }
  }, [activeRequest, activeRequestId, activeResponse, flushApplicationDraftSave, isAccepted, isApplicationRequest, isCancelling, isDiscarding, isSteppingBack, isSubmitting, mergedRequests, recordSubmittedResponse, responseCrossPasteBlocked]);

  const stepBack = useCallback(async () => {
    if (!activeRequestId || !activeRequest?.canStepBack || isSubmitting || isSteppingBack || isCancelling || isAccepted) return;
    if (actionRequestIdsRef.current.has(activeRequestId)) return;
    if (!window.electronAPI?.stepBackNonApiAiRequest) {
      setErrors(previous => ({ ...previous, [activeRequestId]: 'Returning to the previous AI step is unavailable.' }));
      return;
    }

    const requestId = activeRequestId;
    actionRequestIdsRef.current.add(requestId);
    setSteppingBackRequestIds(previous => new Set(previous).add(requestId));
    setErrors(previous => {
      const { [requestId]: _cleared, ...remaining } = previous;
      return remaining;
    });
    try {
      const result = await window.electronAPI.stepBackNonApiAiRequest(requestId);
      if (!result?.steppedBack) {
        setErrors(previous => ({
          ...previous,
          [requestId]: result?.error || 'Could not return to the previous AI step.',
        }));
      }
      // The settled event removes this request; its owning workflow then
      // emits the preceding prompt as a new request with the accepted paste
      // restored for editing.
    } catch (error) {
      setErrors(previous => ({
        ...previous,
        [requestId]: error?.message || 'Could not return to the previous AI step.',
      }));
    } finally {
      actionRequestIdsRef.current.delete(requestId);
      setSteppingBackRequestIds(previous => {
        if (!previous.has(requestId)) return previous;
        const next = new Set(previous);
        next.delete(requestId);
        return next;
      });
    }
  }, [activeRequest, activeRequestId, isAccepted, isCancelling, isSteppingBack, isSubmitting]);

  const performCancelTask = useCallback(async ({ requestId, nodeId, runId }) => {
    // Entry guards live in requestCancelConfirm; re-check only what can have
    // changed while the confirmation was open.
    if (!requestId || actionRequestIdsRef.current.has(requestId)) return;
    if (!requestsRef.current.some(request => request.requestId === requestId)) return;

    // Ownership was captured when the prompt opened: the settled event can
    // change the selected request while the confirm is up or while the
    // cancellation is in flight.
    const cancelledNodeId = nodeId || null;
    const cancelledRunId = runId || null;
    actionRequestIdsRef.current.add(requestId);
    setCancellingRequestIds(previous => new Set(previous).add(requestId));
    try {
      const result = await window.electronAPI.cancelNonApiAiRequest(requestId);
      if (!result?.cancelled) {
        setErrors(previous => ({
          ...previous,
          [requestId]: result?.error || 'This task is no longer pending and could not be cancelled.',
        }));
      } else if (result.nodeCancelled && cancelledNodeId) {
        // The main process can abort the request immediately, but the owning
        // React component does not otherwise know that the user chose Cancel
        // in this app-level dialog. Include the immutable run identity so the
        // owner can route an active Board child through exact rollback without
        // letting a late event reset a newer run on the same node.
        document.dispatchEvent(new CustomEvent('non-api-ai-node-cancelled', {
          detail: { nodeId: cancelledNodeId, runId: cancelledRunId },
        }));
      }
      // As with accepted responses, wait for the request-specific settled
      // event instead of closing whichever item happens to be active now.
    } catch (error) {
      setErrors(previous => ({
        ...previous,
        [requestId]: error?.message || 'Could not cancel this task. Please try again.',
      }));
    } finally {
      actionRequestIdsRef.current.delete(requestId);
      setCancellingRequestIds(previous => {
        if (!previous.has(requestId)) return previous;
        const next = new Set(previous);
        next.delete(requestId);
        return next;
      });
    }
  }, []);

  const requestCancelConfirm = useCallback(() => {
    if (!activeRequestId || isSubmitting || isSteppingBack || isCancelling || isAccepted) return;
    if (actionRequestIdsRef.current.has(activeRequestId)) return;
    if (!window.electronAPI?.cancelNonApiAiRequest) {
      setErrors(previous => ({ ...previous, [activeRequestId]: 'Manual AI task cancellation is unavailable.' }));
      return;
    }
    EventLogger.log('ConfirmDialog requested: title="Cancel this AI task?"');
    setCancelConfirmTarget({
      kind: 'push',
      requestId: activeRequestId,
      nodeId: activeRequest?.nodeId || null,
      runId: activeRequest?.runId || null,
      label: activeRequest ? requestLabel(activeRequest) : '',
    });
  }, [activeRequest, activeRequestId, isAccepted, isCancelling, isSteppingBack, isSubmitting]);

  const requestApplicationDiscardConfirm = useCallback(() => {
    if (!activeRequestId || !isApplicationRequest || isSubmitting || isDiscarding || isAccepted) return;
    if (actionRequestIdsRef.current.has(activeRequestId)) return;
    if (!window.electronAPI?.discardLocalApplication) {
      setErrors(previous => ({ ...previous, [activeRequestId]: 'Discarding this application bundle is unavailable.' }));
      return;
    }
    EventLogger.log('ConfirmDialog requested: title="Discard this application bundle?"');
    setCancelConfirmTarget({
      kind: 'application',
      requestId: activeRequestId,
      jobId: activeRequest.jobId,
      canvasFilePath: activeRequest.canvasFilePath,
      nodeId: activeRequest.nodeId || null,
      label: activeRequest.subject || activeRequest.label || '',
    });
  }, [activeRequest, activeRequestId, isAccepted, isApplicationRequest, isDiscarding, isSubmitting]);

  // Self-dismiss if the item settles (push) or leaves the dock (application)
  // while the confirm is open, so Confirm can never act on a request id that
  // is already gone.
  useEffect(() => {
    if (cancelConfirmTarget && !mergedRequests.some(request => request.requestId === cancelConfirmTarget.requestId)) {
      setCancelConfirmTarget(null);
    }
  }, [cancelConfirmTarget, mergedRequests]);

  const performDiscardApplication = useCallback(async ({ requestId, jobId, canvasFilePath, nodeId }) => {
    if (!requestId || actionRequestIdsRef.current.has(requestId)) return;
    actionRequestIdsRef.current.add(requestId);
    setDiscardingRequestIds(previous => new Set(previous).add(requestId));
    try {
      const result = await window.electronAPI.discardLocalApplication({ jobId, canvasFilePath });
      if (result?.success === false) {
        setErrors(previous => ({
          ...previous,
          [requestId]: result?.error || 'Could not discard this application bundle. Please try again.',
        }));
        return;
      }
      // The IPC call only deletes the on-disk bundle. The job card's own
      // node.data.localApplication pointer is renderer state this dock
      // cannot reach from outside the canvas provider tree — without
      // clearing it too, the fallback manager would resurrect the same job
      // folder on its very next discovery pass. JobCardNode listens for this
      // event and clears that pointer.
      document.dispatchEvent(new CustomEvent('application-handoff-discarded', {
        detail: { jobId, nodeId },
      }));
      requestApplicationHandoffRefresh(jobId);
    } catch (error) {
      setErrors(previous => ({
        ...previous,
        [requestId]: error?.message || 'Could not discard this application bundle. Please try again.',
      }));
    } finally {
      actionRequestIdsRef.current.delete(requestId);
      setDiscardingRequestIds(previous => {
        if (!previous.has(requestId)) return previous;
        const next = new Set(previous);
        next.delete(requestId);
        return next;
      });
    }
  }, []);


  // Mirrors ApplicationPasteDialog's broken-job "Close": there is no further
  // action this dock can take on a job-integrity failure, so this only stops
  // showing the message and moves focus off it, the same way closing that
  // modal used to reveal whatever the person was looking at before it opened.
  const dismissBrokenApplication = useCallback(() => {
    if (!activeRequestId) return;
    const requestId = activeRequestId;
    setBrokenApplicationMessages(previous => {
      if (!(requestId in previous)) return previous;
      const { [requestId]: _cleared, ...remaining } = previous;
      return remaining;
    });
    setDismissedBrokenRequestIds(previous => {
      if (previous.has(requestId)) return previous;
      const next = new Set(previous);
      next.add(requestId);
      return next;
    });
    setSelectedRequestId(previous => previous === requestId ? null : previous);
  }, [activeRequestId]);

  const minimize = useCallback(() => {
    setIsExpanded(false);
    // Collapsing removes the button that initiated this action. Return focus
    // to the still-available compact control without making the dock modal.
    requestAnimationFrame(() => dockButtonRef.current?.focus());
  }, []);

  // Shown at every depth, including one. The chip strip below it is always on
  // screen now, so a count that blanked itself at one left the header reflowing
  // for no reason while contradicting the collapsed dock, which says "1 handoff
  // waiting" for that same state.
  const queueLabel = useMemo(() => `${mergedRequests.length} pending`, [mergedRequests.length]);

  const multipleHubQueue = useMemo(() => {
    const owners = new Set(mergedRequests
      .map(request => typeof request.nodeId === 'string' ? request.nodeId.trim() : '')
      .filter(Boolean));
    return owners.size > 1;
  }, [mergedRequests]);

  if (!activeRequest) return null;

  // "Waiting" stopped being the whole truth once a bundle holds its slot
  // while the app saves it. Calling a bundle that wants nothing from you a
  // waiting handoff is the same kind of confusion this change set out to
  // remove, so the collapsed dock names both states.
  const savingCount = mergedRequests.filter(request => request.working).length;
  const waitingCount = mergedRequests.length - savingCount;
  const dockLabel = savingCount === 0
    ? (waitingCount === 1 ? '1 handoff waiting' : `${waitingCount} handoffs waiting`)
    : waitingCount === 0
      ? (savingCount === 1 ? '1 bundle saving' : `${savingCount} bundles saving`)
      : `${waitingCount} waiting · ${savingCount} saving`;

  return createPortal(
    // The dock normally sits above everything (z-11000/11001). ConfirmDialog
    // self-portals to the body at z-10000, so while the cancel confirmation is
    // open the dock must drop BELOW it — otherwise the opaque dock panel covers
    // the confirm card (entirely, on a narrow viewport) and its buttons cannot
    // be clicked. Dropping the dock is preferable to raising ConfirmDialog,
    // which would change the stacking of every other call site.
    <div
      className={`pointer-events-none fixed inset-0 ${cancelConfirmTarget ? 'z-[9998]' : 'z-[11000]'}`}
      role="presentation"
    >
      <div className={`pointer-events-auto fixed bottom-4 right-4 ${cancelConfirmTarget ? 'z-[9999]' : 'z-[11001]'} w-[min(32rem,calc(100vw-2rem))]`}>
        {!isExpanded ? (
          <button
            ref={dockButtonRef}
            type="button"
            onClick={() => setIsExpanded(true)}
            aria-expanded="false"
            className="ml-auto flex max-w-full items-center gap-2 rounded-xl border border-violet-400/35 bg-neutral-900/95 px-3.5 py-2.5 text-left text-sm text-white shadow-xl backdrop-blur transition-colors hover:border-violet-300/60 hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-violet-400/70"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-violet-400/25 bg-violet-500/15">
              <ClipboardCopy size={14} className="text-violet-200" aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block font-medium">Pending AI handoffs</span>
              <span aria-live="polite" aria-atomic="true" className="block text-xs text-white/55">{dockLabel}</span>
            </span>
            <span className="ml-1 inline-flex items-center gap-1 text-xs font-medium text-violet-200">
              Expand <ChevronUp size={15} aria-hidden="true" />
            </span>
          </button>
        ) : (
      <section
        id="non-api-ai-handoff-panel"
        role="region"
        aria-labelledby="non-api-ai-dialog-title"
        aria-busy={isSubmitting || isSteppingBack || isCancelling || isDiscarding || isAccepted || applicationWorkingState === 'working'}
        // A prompt with its paste box runs ~47rem tall; a saving notice is a
        // couple of lines. Without a floor the panel collapsed the instant a
        // response was accepted and sprang back when the next prompt arrived,
        // so the dock jumped around under the pointer. The floor is capped by
        // the viewport rather than set flat, because a min-height that beats
        // max-height would push the submit button off a short screen.
        className="min-h-[min(47rem,calc(100vh-2rem))] max-h-[calc(100vh-2rem)] overflow-hidden rounded-2xl border border-violet-400/25 bg-neutral-900 shadow-2xl flex flex-col"
      >
        <header className="shrink-0 px-5 py-4 border-b border-white/10">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 h-8 w-8 shrink-0 rounded-lg bg-violet-500/15 border border-violet-400/25 flex items-center justify-center">
              <ClipboardCopy size={16} className="text-violet-300" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 id="non-api-ai-dialog-title" className="text-sm font-semibold text-white">
                  Non-API AI handoff
                </h2>
                {activeRequest?.handoffCode && (
                  <span className="inline-flex rounded border border-violet-400/30 bg-violet-500/15 px-2 py-0.5 font-mono text-xs font-semibold tracking-wider text-violet-200">
                    {activeRequest.handoffCode}
                  </span>
                )}
              </div>
              <p aria-live="polite" aria-atomic="true" className="mt-0.5 text-xs text-white/55 break-words">
                {multipleHubQueue && ownerBadgeForNode(activeRequest.nodeId) && (
                  <span className="mr-1.5 inline-flex rounded border border-violet-400/25 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-violet-200">
                    {ownerBadgeForNode(activeRequest.nodeId)}
                  </span>
                )}
                {dockItemSummary(activeRequest)}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {queueLabel && <span className="text-[11px] text-white/40">{queueLabel}</span>}
              <button
                type="button"
                onClick={minimize}
                aria-label="Minimize pending AI handoffs"
                className="inline-flex items-center gap-1 rounded-md border border-white/15 px-2 py-1.5 text-xs font-medium text-white/70 transition-colors hover:border-violet-300/40 hover:bg-violet-500/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-violet-400/70"
              >
                <ChevronDown size={14} aria-hidden="true" />
                Minimize
              </button>
            </div>
          </div>
          {/*
            The strip stays on screen at every queue depth, including one. These
            numbers are how someone keeps up to ten parallel AI chats straight,
            and a bundle's number appears NOWHERE else in this panel — so hiding
            the strip once the queue drains to a single prompt would delete the
            only on-screen answer to "which chat is this prompt from?" at exactly
            the moment the last chat is being finished. A lone chip also holds
            the position and size it had in a full strip, so nothing jumps as
            siblings settle.
          */}
          <nav aria-label="Pending AI handoff batches" className="mt-3">
            <div className="grid grid-cols-5 gap-1 sm:grid-cols-10">
              {mergedRequests.map((request, index) => {
                const selected = request.requestId === activeRequestId;
                const hasDraft = Boolean(drafts[request.requestId]?.trim());
                const hasError = Boolean(errors[request.requestId]);
                const isWorking = submittingRequestIds.has(request.requestId)
                  || steppingBackRequestIds.has(request.requestId)
                  || cancellingRequestIds.has(request.requestId)
                  || discardingRequestIds.has(request.requestId)
                  || acceptedRequestIds.has(request.requestId);
                // The BUNDLE's own state, not an action this dock started:
                // the app is finishing it and no paste is possible. Kept
                // separate because it outlives any one action and is the
                // reason this chip is still on screen at all.
                const isBundleSaving = Boolean(request.working);
                // A chip whose round got stuck on the SAME check three (or
                // more) times running — see hasActiveEscalation's own header.
                // Rendered as a ring + icon rather than folded into the plain
                // hasError dot below: a correction round already turns that
                // dot red, so a THIRD rejection of the same check would look
                // identical to a first, which is exactly the invisibility
                // this exists to fix (see this file's module header for the
                // measured incident: 16 rounds on one check, nothing on
                // screen told the person their loop was the same one).
                const isEscalated = hasActiveEscalation(request.rejectionEscalation);
                // A full handoff code is already shown in the prompt header.
                // These controls only select a queued prompt, so one batch
                // number per button keeps ten concurrent prompts visible. The
                // rule itself lives in describeQueuedPrompt because a guard
                // message that names a prompt has to use the same one.
                const { selectorLabel, label } = describeQueuedPrompt(request, index);
                const ownerBadge = multipleHubQueue ? ownerBadgeForNode(request.nodeId) : null;
                const chipLabel = ownerBadge ? `${ownerBadge} · ${label}` : label;
                const statusLabel = [
                  // Leads the list: a stuck check outranks every other status
                  // word here, and the ring on the button itself carries no
                  // text of its own, so the accessible name is the only place
                  // this sentence exists at all for someone who cannot see it.
                  isEscalated ? `stuck — ${escalationHeadline(request.rejectionEscalation)}` : null,
                  isBundleSaving
                    ? (request.workingState === 'blocked' ? 'needs a layout retry' : 'still saving')
                    : null,
                  hasDraft ? 'response pasted' : null,
                  isWorking ? 'action in progress' : null,
                  hasError ? 'needs correction' : null,
                ].filter(Boolean).join(', ');
                const selectorDescription = `${chipLabel}: ${dockItemSummary(request)}${statusLabel ? `, ${statusLabel}` : ''}`;
                return (
                  <button
                    key={request.requestId}
                    type="button"
                    onClick={() => {
                      // A direct choice is stronger than an in-flight
                      // completion's automatic successor preference, and
                      // than a bundle whose card asked for focus before
                      // discovery had published it.
                      awaitingSuccessorRef.current = null;
                      pendingFocusJobIdsRef.current.clear();
                      setSelectedRequestId(request.requestId);
                      EventLogger.log(`[Manual AI] user selected queued handoff${Number.isFinite(request.batch) ? ` batch=${request.batch}` : ''}`);
                    }}
                    // Switching the panel to another hub's handoff while the
                    // confirm is open would let the prompt say one thing and
                    // cancel another.
                    disabled={!!cancelConfirmTarget}
                    aria-current={selected ? 'page' : undefined}
                    aria-label={selectorDescription}
                    title={selectorDescription}
                    className={`inline-flex min-w-0 items-center justify-center gap-1 rounded-md border px-1.5 py-1.5 text-xs font-medium tabular-nums transition-colors ${selected
                      ? 'border-violet-300/60 bg-violet-500/20 text-violet-100'
                      : 'border-white/10 bg-black/20 text-white/60 hover:border-violet-400/35 hover:text-white/85'}${
                      // A ring survives the button's own selected/unselected
                      // color swap above, so the same chip still reads as
                      // stuck whether or not it is the one currently open —
                      // the failure this exists for is a person who never
                      // reopens it because nothing here told them to.
                      isEscalated ? ' ring-2 ring-red-400/80 ring-offset-1 ring-offset-neutral-900' : ''}`}
                  >
                    <span>{selectorLabel}</span>
                    {/*
                      A spinner rather than a dot while the app finishes the
                      bundle: the number staying put is the point, and a
                      static dot would read as one more settled state rather
                      than as work still running.
                    */}
                    {isBundleSaving ? (
                      request.workingState === 'blocked'
                        ? <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-amber-300" />
                        : <LoaderCircle size={10} className="animate-spin text-violet-200" aria-hidden="true" />
                    ) : isEscalated ? (
                      // A triangle rather than the plain color dot below: an
                      // ordinary correction already turns that dot red, so
                      // the THIRD rejection of the same check needs a shape
                      // that does not already mean "needs correction".
                      <AlertTriangle size={10} className="shrink-0 text-red-300" aria-hidden="true" />
                    ) : (hasDraft || isWorking || hasError) && (
                      <span
                        aria-hidden="true"
                        className={`h-1.5 w-1.5 rounded-full ${hasError ? 'bg-red-300' : isWorking ? 'bg-amber-300' : 'bg-emerald-300'}`}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </nav>
        </header>

        <form ref={panelBodyRef} onSubmit={submit} className="min-h-0 flex-1 overflow-y-auto p-5 flex flex-col gap-4 custom-scrollbar">
          {brokenApplicationMessage ? (
            // No prompt and no response box: this job takes no further paste,
            // and the message already names the action that replaces it.
            <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-3 text-xs leading-relaxed text-red-200 whitespace-pre-wrap">
              <XCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              <div className="min-w-0">
                <div className="font-semibold text-red-100">This application cannot be finished</div>
                <div className="mt-1">{brokenApplicationMessage}</div>
                <button
                  type="button"
                  onClick={dismissBrokenApplication}
                  className="mt-3 rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-[11px] font-medium text-white/75 transition-colors hover:bg-white/10 hover:text-white"
                >
                  Dismiss
                </button>
              </div>
            </div>
          ) : applicationWorkingState ? (
            // The response was accepted and the app is finishing the bundle:
            // rendering it, measuring the pages, writing the files. Nothing
            // here is actionable, and that is exactly why the entry used to
            // disappear — which is what made a RETURNING prompt unreadable.
            // A bundle that leaves the queue releases its chip number, so one
            // that came back from a failed save could return wearing a
            // different number, or find another bundle already wearing its
            // old one. Holding the entry holds the number, and the number is
            // how someone knows this is still the same job.
            <div
              role="status"
              aria-live="polite"
              className="flex items-start gap-3 rounded-lg border border-violet-400/25 bg-violet-500/10 px-3 py-3 text-xs leading-relaxed text-violet-100"
            >
              {applicationWorkingState === 'working' ? (
                <LoaderCircle size={15} className="mt-0.5 shrink-0 animate-spin text-violet-200" aria-hidden="true" />
              ) : (
                <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-300" aria-hidden="true" />
              )}
              {/*
                Two lines, and `truncate` on both so it cannot grow into a
                third: what this state is, and which job it belongs to. The
                paragraph that used to sit here explained the chip-number
                rule, which is a thing to understand once, not to re-read on
                every save.
              */}
              <div className="min-w-0">
                <div className="truncate font-semibold text-white" title={workingHeadline}>
                  {workingHeadline}
                </div>
                <div className="truncate text-violet-100/75" title={activeRequest.subject || activeRequest.label || ''}>
                  {activeRequest.subject || activeRequest.label || 'This application'}
                </div>
              </div>
            </div>
          ) : (
            <>
              {activeCorrectionsRecovered && (
                // THE BUG this notice exists for: a restart discards the
                // in-memory `pasteCorrectionsByJob` entry (electron/ipc/
                // localAiApplication.js's own header), so the person is
                // otherwise handed a clean-looking prompt with no sign this
                // stage was already rejected N times — and the chat they'd
                // normally continue is not known to still be open, so
                // pasting the correction as if it were is not safe advice
                // either. Amber, not the escalation banner's red below: this
                // reports a STATE (what this process inherited from disk),
                // not a live gate failing again in front of the person right
                // now, and it needs to read as a different KIND of notice,
                // not a redder or calmer version of the same one. Placed
                // first and `role="alert"` for the same reason as the
                // escalation banner — the first thing on screen, announced
                // unprompted — but see that banner's own updated gate just
                // below for why the two never render together: this one's
                // summary sentence already carries the rejection count and
                // the check id(s) the escalation banner would otherwise
                // repeat, and showing both would print the same numbers
                // twice, in two different colors, for one restart.
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-lg border border-amber-400/40 bg-amber-500/15 px-3 py-3 text-xs leading-relaxed text-amber-100"
                >
                  <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-300" aria-hidden="true" />
                  <div className="min-w-0">
                    <div className="font-semibold text-amber-50">
                      Corrections carried over from before a restart
                    </div>
                    <div className="mt-1 text-amber-100/80">
                      {correctionsRecoveredSummary(activeCorrectionsRecovered)}
                    </div>
                    <div className="mt-1.5 font-semibold text-amber-50">
                      The chat that produced that earlier draft is not known to still be open. The prompt below is
                      the self-contained version meant for a NEW chat — not a continuation of that one.
                    </div>
                  </div>
                </div>
              )}
              {activeRejectionEscalation && !activeCorrectionsRecovered && (
                // The one thing on this panel a skim cannot miss: red (not
                // the amber this file uses for an ordinary correction),
                // `role="alert"` so a screen reader announces it unprompted,
                // and placed ABOVE the intro paragraph so it is the first
                // thing on screen — not spliced into prose that already
                // looked identical to the last three rounds. See
                // hasActiveEscalation's own header for why this is gated on
                // the escalation being ACTIVE, not merely present. Also gated
                // on !activeCorrectionsRecovered — see that notice's own
                // comment for why the two must not stack.
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-lg border border-red-400/40 bg-red-500/15 px-3 py-3 text-xs leading-relaxed text-red-100"
                >
                  <AlertTriangle size={15} className="mt-0.5 shrink-0 text-red-300" aria-hidden="true" />
                  <div className="min-w-0">
                    <div className="font-semibold text-red-50">
                      Stuck on the same check: {escalationHeadline(activeRejectionEscalation)}
                    </div>
                    <div className="mt-1 text-red-100/80">
                      Re-reading the same feedback and rewriting the prose around it has not worked. Make a literal
                      edit to exactly what {escalationCheckIds(activeRejectionEscalation).length === 1 ? 'that check names' : 'those checks name'},
                      not a rewrite of the paragraph or bullet it lives in.
                    </div>
                    {activeRejectionEscalation.trimmedFromPrompt && (
                      // The one case the copied prompt text cannot say this
                      // itself — see localAiApplication.js's rejectionEscalation
                      // doc comment (escalationTrimmed): the block was cut to
                      // fit the stage-prompt length budget, so this sentence
                      // in the UI is the ONLY place the guidance above still
                      // reaches the person before they paste.
                      <div className="mt-1.5 font-semibold text-amber-200">
                        This guidance was cut from the copied prompt to keep it a reasonable length — it is not in the
                        text below. Read it here before you copy and paste.
                      </div>
                    )}
                  </div>
                </div>
              )}
              <p className="text-sm leading-relaxed text-white/70">
                {isCorrection
                  ? 'The previous answer did not validate. Copy this correction prompt into the same AI chat, then replace the response below with the complete regenerated answer.'
                  : 'Copy this exact prompt into your AI chat, then paste its complete response below. This task stays open until the response validates or the running job is cancelled.'}
              </p>

              {activeRequest.attachments?.length > 0 && (
                <section aria-labelledby="non-api-ai-attachments-title" className="rounded-lg border border-amber-400/25 bg-amber-500/10 p-3">
                  <div className="flex items-center gap-2 text-amber-100">
                    <Paperclip size={14} aria-hidden="true" />
                    <h3 id="non-api-ai-attachments-title" className="text-xs font-semibold uppercase tracking-wider">Attachments required</h3>
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-amber-100/70">Attach {activeRequest.attachments.length === 1 ? 'this file' : 'these files'} to your AI chat before sending the prompt.</p>
                  <ul className="mt-2 space-y-2">
                    {activeRequest.attachments.map((filePath) => (
                      <li key={filePath} className="flex items-center gap-2 rounded-md border border-white/10 bg-black/20 p-2">
                        <span className="min-w-0 flex-1 font-mono text-xs text-white/75 break-all" title={filePath}>{filePath}</span>
                        <button
                          type="button"
                          onClick={() => revealAttachment(filePath)}
                          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-amber-300/30 bg-amber-400/10 px-2.5 py-1.5 text-xs font-medium text-amber-100 transition-colors hover:bg-amber-400/20"
                          title={`Show ${attachmentName(filePath)} in Finder`}
                        >
                          <FolderOpen size={13} aria-hidden="true" />
                          Show in Finder
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <div className="flex flex-col gap-2 min-h-0">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <label htmlFor="non-api-ai-prompt" className="text-xs font-medium text-white/65 uppercase tracking-wider">
                      {isApplicationRequest && showingApplicationCorrection
                        ? (showingFullRestartPrompt ? 'Full stage prompt' : 'Correction prompt')
                        : 'Prompt'}
                    </label>
                    {isApplicationRequest && showingApplicationCorrection && !showingFullRestartPrompt && (
                      <span className="inline-flex rounded border border-amber-400/30 bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-100">
                        {activeApplicationCorrections.length === 1 ? '1 fix to send' : `${activeApplicationCorrections.length} fixes to send`}
                      </span>
                    )}
                    {/*
                      A second badge, not a swap of the one above: "N fixes to
                      send" answers "how much text is this round", which is
                      still true and still useful, while this answers a
                      different question — "have I seen this exact fix
                      before" — that badge cannot answer because it reads the
                      same on round 1 and round 4 of the identical check. Red
                      rather than amber so it cannot be mistaken for a variant
                      of the count badge it sits beside.
                    */}
                    {activeRejectionEscalation && !showingFullRestartPrompt && (
                      <span
                        title={escalationHeadline(activeRejectionEscalation)}
                        className="inline-flex items-center gap-1 rounded border border-red-400/40 bg-red-500/20 px-2 py-0.5 text-[11px] font-semibold text-red-100"
                      >
                        <AlertTriangle size={11} aria-hidden="true" />
                        Stuck{Number.isFinite(activeRejectionEscalation.streak) ? ` ×${activeRejectionEscalation.streak}` : ''}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    {isApplicationRequest && showingApplicationCorrection && (
                      <button
                        type="button"
                        onClick={() => setFullPromptRequestIds(previous => {
                          const next = new Set(previous);
                          if (next.has(activeRequestId)) next.delete(activeRequestId);
                          else next.add(activeRequestId);
                          return next;
                        })}
                        className="text-[11px] font-medium text-white/40 underline decoration-dotted underline-offset-2 transition-colors hover:text-white/70"
                        title={showingFullRestartPrompt
                          ? 'Return to the correction prompt for this chat'
                          : 'Only if this AI chat has lost track of the current stage: copy this into a NEW chat to start the answer over from scratch'}
                      >
                        {showingFullRestartPrompt ? 'Back to correction' : 'Chat lost the thread? Start over in a new chat'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={copyPrompt}
                      className="inline-flex items-center gap-1.5 rounded-md border border-violet-400/30 bg-violet-500/15 px-3 py-1.5 text-xs font-medium text-violet-200 hover:bg-violet-500/25 transition-colors"
                    >
                      {isCopied ? <Check size={13} aria-hidden="true" /> : <ClipboardCopy size={13} aria-hidden="true" />}
                      {isCopied
                        ? 'Copied'
                        : showingFullRestartPrompt
                          ? 'Copy full prompt'
                          : (isApplicationRequest ? showingApplicationCorrection : isCorrection) ? 'Copy correction prompt' : 'Copy prompt'}
                    </button>
                  </div>
                </div>
                <textarea
                  id="non-api-ai-prompt"
                  ref={promptFieldRef}
                  readOnly
                  value={displayedPrompt}
                  onFocus={(event) => event.currentTarget.select()}
                  className="h-48 w-full resize-y rounded-lg border border-white/10 bg-black/35 p-3 font-mono text-xs leading-relaxed text-white/80 outline-none focus:border-violet-400/60"
                  aria-label="Prompt to send to your AI chat"
                  spellCheck={false}
                />
              </div>

              <div className="flex flex-col gap-2 min-h-0">
                <label htmlFor="non-api-ai-response" className="text-xs font-medium text-white/65 uppercase tracking-wider">Paste AI response</label>
                <textarea
                  id="non-api-ai-response"
                  value={activeResponse}
                  onChange={(event) => setActiveResponse(event.target.value)}
                  disabled={isSubmitting || isSteppingBack || isCancelling || isDiscarding || isAccepted || !!cancelConfirmTarget}
                  placeholder="Paste the full response here…"
                  className="h-44 w-full resize-y rounded-lg border border-white/15 bg-black/45 p-3 font-mono text-xs leading-relaxed text-white placeholder:text-white/30 outline-none focus:border-violet-400/60 disabled:opacity-60"
                  aria-describedby={effectiveError || (correctionGuidance && !isApplicationRequest) ? 'non-api-ai-validation-error' : undefined}
                  spellCheck={false}
                />
              </div>

              {repeatedPasteNotice && (
                <p className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-100/90">
                  {repeatedPasteNotice}
                </p>
              )}

              {(effectiveError || (correctionGuidance && !isApplicationRequest)) && (
                <div id="non-api-ai-validation-error" role="alert" className="flex items-start gap-2 rounded-lg border border-red-400/25 bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-200 whitespace-pre-wrap">
                  <XCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                  <div className="min-w-0">
                    {correctionGuidance && <p>{correctionGuidance}</p>}
                    {effectiveError && <p className={correctionGuidance ? 'mt-2 text-red-100/80' : undefined}>{effectiveError}</p>}
                    {/*
                      A blocked paste is a dead end without these. The text in
                      the box provably is not this prompt's answer, so clearing
                      it is always the right move; and when the guard knows
                      which queued prompt the text belongs to, the repair is
                      one press instead of a hunt through ten open chats.
                    */}
                    {responseCrossPasteBlocked && (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {misdirectedOwnerRequestId && (
                          <button
                            type="button"
                            onClick={() => {
                              // Same two cancellations a chip press makes: a
                              // deliberate choice outranks both automatic
                              // focus preferences.
                              awaitingSuccessorRef.current = null;
                              pendingFocusJobIdsRef.current.clear();
                              setSelectedRequestId(misdirectedOwnerRequestId);
                              EventLogger.log('[Manual AI] user followed a misdirected paste to the prompt that owns it');
                            }}
                            className="rounded-md border border-red-300/35 bg-red-500/10 px-2.5 py-1 text-[11px] font-medium text-red-100 transition-colors hover:border-red-200/60 hover:bg-red-500/20 focus:outline-none focus:ring-2 focus:ring-red-300/60"
                          >
                            Go to {misdirectedOwnerName}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setActiveResponse('')}
                          className="rounded-md border border-white/20 bg-white/5 px-2.5 py-1 text-[11px] font-medium text-white/75 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-violet-400/70"
                        >
                          Clear this box
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="shrink-0 flex flex-wrap items-center justify-between gap-3 pt-1">
                <span className="min-w-48 flex-1 text-xs text-white/40" aria-live="polite">
                  {isApplicationRequest
                    ? (isAccepted ? 'Response accepted — continuing task…' : isDiscarding ? 'Discarding this application bundle…' : 'Responses are saved privately with this application, and each accepted revision is appended to its generation log. Discard bundle deletes this application and its private job folder; the job card keeps its listing, and Generate can start a fresh one.')
                    : (isAccepted ? 'Response accepted — continuing task…' : isSteppingBack ? 'Returning to the previous AI step…' : isCancelling ? 'Cancelling the owning job operation…' : 'Cancel task stops the owning job operation. Every response you already pasted for this run is discarded. You can retry as many times as needed.')}
                </span>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {activeRequest.canStepBack && (
                    <button
                      type="button"
                      onClick={stepBack}
                      disabled={isSubmitting || isSteppingBack || isCancelling || isAccepted || !!cancelConfirmTarget}
                      className="inline-flex items-center gap-1.5 rounded-md border border-white/20 px-3 py-2 text-sm font-medium text-white/75 transition-colors hover:border-violet-300/40 hover:bg-violet-500/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                      title="Return to the previous AI prompt and edit its accepted response"
                    >
                      {isSteppingBack ? <LoaderCircle size={15} className="animate-spin" aria-hidden="true" /> : <ArrowLeft size={15} aria-hidden="true" />}
                      {isSteppingBack ? 'Going back…' : (activeRequest.stepBackLabel || 'Back one step')}
                    </button>
                  )}
                  {isApplicationRequest ? (
                    <button
                      type="button"
                      onClick={requestApplicationDiscardConfirm}
                      disabled={isSubmitting || isDiscarding || isAccepted || !!cancelConfirmTarget}
                      className="rounded-md border border-red-400/30 px-3 py-2 text-sm font-medium text-red-200 transition-colors hover:bg-red-500/15 disabled:cursor-not-allowed disabled:opacity-50"
                      title="Delete this application bundle and its private job folder"
                    >
                      {isDiscarding ? 'Discarding…' : 'Discard bundle'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={requestCancelConfirm}
                      disabled={isSubmitting || isSteppingBack || isCancelling || isAccepted || !!cancelConfirmTarget}
                      className="rounded-md border border-red-400/30 px-3 py-2 text-sm font-medium text-red-200 transition-colors hover:bg-red-500/15 disabled:cursor-not-allowed disabled:opacity-50"
                      title="Cancel the job operation waiting for this AI response"
                    >
                      {isCancelling ? 'Cancelling…' : 'Cancel task'}
                    </button>
                  )}
                  <button
                    type="submit"
                    disabled={!activeResponse.trim() || responseCrossPasteBlocked || isSubmitting || isSteppingBack || isCancelling || isDiscarding || isAccepted || !!cancelConfirmTarget}
                    className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isSubmitting ? <LoaderCircle size={15} className="animate-spin" aria-hidden="true" /> : <Send size={15} aria-hidden="true" />}
                    {isSubmitting ? 'Validating…' : isAccepted ? 'Accepted' : 'Submit response'}
                  </button>
                </div>
              </div>
            </>
          )}
        </form>
      </section>
        )}
      </div>
      {/* Sibling of the expanded/minimized branch so the prompt survives a
          Minimize. ConfirmDialog self-portals at z-[10000] and self-registers
          with the modal stack; while it is open the dock wrappers above drop to
          z-[9998]/z-[9999] so the confirm paints on top and the backdrop
          intercepts clicks on the dock. The dock controls are ALSO disabled —
          belt and braces, and so a click that does reach one (e.g. via keyboard
          focus, which the backdrop does not intercept) cannot switch the panel
          to a different hub's handoff and desync the prompt from its target.
          No onAbort: there is nothing to roll back. */}
      {cancelConfirmTarget && (
        cancelConfirmTarget.kind === 'application' ? (
          <ConfirmDialog
            title="Discard this application bundle?"
            message={`${cancelConfirmTarget.label ? `${cancelConfirmTarget.label}\n\n` : ''}This deletes the application bundle and its private job folder. Every AI response you have already pasted for it is discarded and cannot be restored. The job card keeps its listing, and pressing Generate starts a fresh application.`}
            confirmLabel="Discard bundle"
            cancelLabel="Keep working"
            variant="danger"
            onConfirm={() => {
              const target = cancelConfirmTarget;
              setCancelConfirmTarget(null);
              EventLogger.log('ConfirmDialog CONFIRMED');
              void performDiscardApplication(target);
            }}
            onCancel={() => {
              setCancelConfirmTarget(null);
              EventLogger.log('ConfirmDialog CANCELLED');
            }}
          />
        ) : (
          <ConfirmDialog
            title="Cancel this AI task?"
            message={`${cancelConfirmTarget.label ? `${cancelConfirmTarget.label}\n\n` : ''}This stops the whole job operation waiting on this handoff, not just this prompt. Every AI response you have already pasted for this run is discarded and cannot be restored. Job data already scraped and saved to disk is kept.`}
            confirmLabel="Cancel task"
            cancelLabel="Keep working"
            variant="danger"
            onConfirm={() => {
              const target = cancelConfirmTarget;
              setCancelConfirmTarget(null);
              EventLogger.log('ConfirmDialog CONFIRMED');
              void performCancelTask(target);
            }}
            onCancel={() => {
              setCancelConfirmTarget(null);
              EventLogger.log('ConfirmDialog CANCELLED');
            }}
          />
        )
      )}
    </div>,
    document.body,
  );
}
