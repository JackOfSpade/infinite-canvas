import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { _resetNonApiAiHandoffLifecycle, abortNodeTasksAndWait, applyBugReportCode, assert, buildNonApiAiHandoffLifecycleMarkdown, callLLMDocument, callLLMRaw, callLLMText, callLLMVision, checkPromptFits, __durableStepKeysForTests, __reloadDurableStateForTests, __nonApiAiProgressScopeSnapshotForTests, __pruneInactiveEphemeralProgressScopesForTests, __selectDurableStepForTests, __selectUniqueAcceptedLegacyStepForTests, canonicalizeGeneratedUntrustedBoundaryNonces, deriveHandoffCode, durableRunHasAnyTask, durableRunSettlementSummary, electronPkg, fs, generateMarkdown, getKnownTaskIds, getNonApiAiHandoffLifecycle, handleSafe, HANDOFF_CODE_ALPHABET, hardenStructuredTaskPrompt, ipcMain, listingIdsForRootBatch, materializeNonApiPrompt, NON_API_AI_TRANSPORT, NonApiAiCodeMismatchError, registerNonApiAiHandlers, requestNonApiAi, runBoundedJobTaxonomy, runRewindableGroundedHandoff, SAFE_NON_API_AI_LOG_ERROR_CODES, SAFE_VALIDATION_DIAGNOSTIC_REASONS, taskModelRoutingSnapshot, validateCompensationEvidenceSubmission, validateJobPreferenceListingSubmission, validateNonApiAiSubmission, validateRoleFamilyExperienceBandsSubmission, wrapUntrustedText } from '../test-dependencies.js';
import { pendingManualHandoffsForActiveTasks } from '../../electron/ipc/bugReport.js';
import { __claimAcceptedResponseFingerprintForTests, __defaultSafeValidationDiagnosticForTests, __nonApiAiHandoffLifecycleAggregateCountForTests, __nonApiAiLogErrorCodeForTests, __promptForRetryForTests, DUPLICATE_RESPONSE_MIN_LENGTH, getNonApiAiHandoffLifecycleSnapshot, NonApiAiCodeMissingError, NonApiAiDuplicateResponseError, submitNonApiAiResponseForBridge } from '../../electron/ipc/nonApiAi.js';
import { getRecentLogs, logger } from '../../electron/logger.js';
import { isWorkflowSuccessor, selectionAfterHandoffSettlement, successorPreferenceAfterSettlement } from '../../src/utils/nonApiAiNavigation.js';
import { MANUAL_AI_PRE_SEARCH_RECOVERY_VERSION, STALE_MANUAL_AI_RESUME_MS, createManualAiPreSearchRecovery, exactStagedOfferSupersedesPreSearchManualAiResume, isLiveManualAiRecoveryBoardOwner, isStaleOrdinaryManualAiResume, manualAiPreSearchRecoveryForResume, staleOrdinaryManualAiResumeBlocksAdmission } from '../test-dependencies.js';

// A handful of representative marketplace tasks used below to prove routing
// and dispatch are task-agnostic now that every task shares the one manual
// transport. (The workspace 'text-polish' task that used to sit alongside
// these was removed outright along with its sole call site, the AI Polish
// Text context-menu action — there is no remaining non-job task that uses
// the raw-text request kind, so this list, and the test below, only exercise
// structured-text dispatch; callLLMRaw's own dispatch path is covered by the
// 'callLLMRaw is the deliberate exception' test above.)
const MARKETPLACE_AND_WORKSPACE_TASKS = [
  'vision-product-analysis',
  'price-synthesis',
  'bundle-price-synthesis',
  'platform-fit-assessment',
  'marketplace-hub-scan',
];

export default [
  {
    name: 'non-API AI: every career-profile compiler stage can be paused with its Job Search',
    run: () => {
      const dialogSource = readFileSync(new URL('../../src/components/NonApiAiDialog.jsx', import.meta.url), 'utf8');
      const searchSource = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const careerRecoveryGate = searchSource.indexOf('isCareerCompilationTask(resume?.task)');
      const jobRunInspection = searchSource.indexOf('window.electronAPI.peekJobRun', careerRecoveryGate);
      assert(dialogSource.includes("request.task.startsWith('career-profile-')")
        && searchSource.includes("task.startsWith('career-profile-')")
        // The optional access is intentional: a malformed/stale renderer
        // marker must not throw before the recovery path can fail closed.
        && careerRecoveryGate >= 0
        // Career work owns no job-run sidecar, so it must be routed before
        // normal saved-job recovery tries to inspect one.
        && careerRecoveryGate < jobRunInspection,
      'compile, every parallel audit, and repair must be pause/resume eligible as one pre-search career-profile workflow, before job-run recovery inspection');
      return { compilerTaskFamily: 'career-profile-*' };
    },
  },
  {
    name: 'handoff scheduler: every multi-item AI phase declares its centralized automatic or manual policy',
    run: () => {
      const scheduler = readFileSync(new URL('../../src/utils/handoffScheduler.js', import.meta.url), 'utf8');
      const sources = {
        preferences: readFileSync(new URL('../../electron/ipc/jobPreferences.js', import.meta.url), 'utf8'),
        jobs: readFileSync(new URL('../../electron/ipc/jobs.js', import.meta.url), 'utf8'),
        taxonomy: readFileSync(new URL('../../electron/ipc/jobTaxonomy.js', import.meta.url), 'utf8'),
        marketplace: readFileSync(new URL('../../electron/ipc/marketplace.js', import.meta.url), 'utf8'),
      };
      assert(scheduler.includes('export const DEFAULT_HANDOFF_CONCURRENCY = 10;')
        && scheduler.includes('export function resolveHandoffConcurrency(')
        && scheduler.includes('export async function mapAutomaticHandoffs(')
        && scheduler.includes('export async function mapManualHandoffWaves(')
        && scheduler.includes('export async function runAutomaticHandoffWorkers('),
      'the shared scheduler must own the worker cap plus the only automatic, manual-wave, and lazy-worker implementations');
      assert(!sources.preferences.includes('export async function mapWithConcurrency(')
        && !sources.preferences.includes('export async function mapWithRollingConcurrency('),
      'job preferences must re-export compatibility aliases only, never retain a second scheduler implementation');
      assert(Object.values(sources).every(source => source.includes("from '../../src/utils/handoffScheduler.js';")),
      'every multi-item AI owner must import the central scheduler directly rather than inherit it through another IPC module');
      assert(sources.preferences.includes('await mapAutomaticHandoffs(\n      descriptors,\n      HANDOFF_CONCURRENCY,')
        && sources.preferences.includes('await runAutomaticHandoffWorkers({')
        && sources.preferences.includes('async function runCompanyResearchPipeline(')
        && sources.preferences.includes('createDependencyReadyQueue(rawWave.map(')
        && sources.preferences.includes('const canPipelineFreshResearch = companyResearchPipelineEligible'),
      'role screens, adaptive listing evaluation, and dependency-ready company research must all use the automatic rolling policy');
      assert(sources.jobs.includes('mapAutomaticHandoffs(rawDescriptors, HANDOFF_CONCURRENCY')
        && sources.jobs.includes('mapAutomaticHandoffs(roleResearchBatches, HANDOFF_CONCURRENCY')
        && sources.jobs.includes('mapAutomaticHandoffs(assessmentBatchPlans, HANDOFF_CONCURRENCY')
        && sources.jobs.includes('mapAutomaticHandoffs(scoringBatches, HANDOFF_CONCURRENCY'),
      'role-family research, compensation, and scoring must refill the central automatic roster');
      assert(sources.taxonomy.includes('mapAutomaticHandoffs(\n      descriptors,\n      HANDOFF_CONCURRENCY,')
        && sources.marketplace.includes('resolved = await mapAutomaticHandoffs(')
        && sources.marketplace.includes('await mapStableHandoffQueue('),
      'taxonomy, price synthesis, and prepared marketplace scans must refill the central roster');
      assert(sources.jobs.includes('Career-file extraction carries a local document attachment')
        && sources.jobs.includes('await mapManualHandoffWaves(')
        && !sources.jobs.includes('wavePromises = wave.map'),
      'attachment extraction must use the central rolling policy and its orphan-cleanup contract');
      return { automaticOwners: 4, manualOwners: 2 };
    },
  },
  {
    name: 'non-API AI: delayed next batch keeps focus ahead of an older correction',
    run: () => {
      const olderCorrection = { requestId: 'A', nodeId: 'node', runId: 'run', task: 'job-scoring', batch: 1 };
      const completed = { requestId: 'B', nodeId: 'node', runId: 'run', task: 'job-scoring', batch: 2 };
      const delayedNext = { requestId: 'C', nodeId: 'node', runId: 'run', task: 'job-scoring', batch: 3 };
      const nextPhase = { requestId: 'D', nodeId: 'node', runId: 'run', task: 'job-taxonomy-plan', batch: 1 };
      const unrelated = { requestId: 'X', nodeId: 'other-node', runId: 'other-run', task: 'job-scoring', batch: 1 };
      const immediate = selectionAfterHandoffSettlement({ queue: [olderCorrection, completed, delayedNext], settledRequestId: 'B', activeRequestId: 'B', accepted: true });
      const delayed = selectionAfterHandoffSettlement({ queue: [olderCorrection, completed], settledRequestId: 'B', activeRequestId: 'B', accepted: true });
      const userSelection = selectionAfterHandoffSettlement({ queue: [olderCorrection, completed], settledRequestId: 'B', activeRequestId: 'A', accepted: true });
      const mixedQueue = selectionAfterHandoffSettlement({ queue: [olderCorrection, completed, unrelated, delayedNext], settledRequestId: 'B', activeRequestId: 'B', accepted: true });
      const delayedWithUnrelated = selectionAfterHandoffSettlement({ queue: [olderCorrection, completed, unrelated], settledRequestId: 'B', activeRequestId: 'B', accepted: true });
      const preserved = successorPreferenceAfterSettlement({ existing: delayedWithUnrelated.awaitingSuccessor, selection: userSelection, settledRequestId: 'X', activeRequestId: 'X' });
      assert(immediate.selectedRequestId === 'C' && immediate.awaitingSuccessor === null
        && delayed.selectedRequestId === 'A' && isWorkflowSuccessor(delayed.awaitingSuccessor, delayedNext)
        && isWorkflowSuccessor(delayed.awaitingSuccessor, nextPhase)
        && !isWorkflowSuccessor(delayed.awaitingSuccessor, { ...delayedNext, batch: 2 })
        && userSelection.selectedRequestId === 'A' && userSelection.awaitingSuccessor === null
        && mixedQueue.selectedRequestId === 'C' && delayedWithUnrelated.selectedRequestId === 'X'
        && isWorkflowSuccessor(delayedWithUnrelated.awaitingSuccessor, delayedNext)
        && preserved === delayedWithUnrelated.awaitingSuccessor,
      'an already-queued next batch is selected immediately, a delayed larger batch or next workflow phase becomes the intended successor, and unrelated queue activity cannot erase that continuation preference');
      return { immediate: immediate.focus, delayed: delayed.focus };
    },
  },
  {
    name: 'non-API AI: every known task id routes to the single manual transport',
    run: () => {
      // There is exactly one transport left in this app: every LLM call, job
      // and marketplace/workspace alike, goes through the human copy/paste
      // handoff. getKnownTaskIds()/taskModelRoutingSnapshot() are the only
      // routing surface left to assert against — there is no more per-task
      // allowlist, provider, or model to look up.
      const knownTasks = getKnownTaskIds();
      assert(knownTasks instanceof Set && knownTasks.size > 10 && !knownTasks.has('default'),
        'getKnownTaskIds() enumerates real call-site task ids and excludes the internal default fallback bucket');
      assert(!knownTasks.has('page-status-classify'),
        'a task id with no remaining call site is not resurrected in the known-task set');
      const snapshot = taskModelRoutingSnapshot();
      assert(snapshot.transport === NON_API_AI_TRANSPORT,
        'the routing snapshot names the single manual transport at its top level');
      for (const task of knownTasks) {
        assert(snapshot.tasks[task]?.transport === NON_API_AI_TRANSPORT
          && Object.keys(snapshot.tasks[task]).length === 1,
        `task '${task}' routes to the manual handoff transport with no per-task provider or model field left to report`);
      }
      assert(!('page-status-classify' in snapshot.tasks) && !('default' in snapshot.tasks),
        'the snapshot reports only real call-site tasks, never the deleted task id or the internal fallback bucket');
      return { taskCount: knownTasks.size };
    },
  },
  {
    name: 'non-API AI: llm.js imports no provider module and every entry point reaches requestNonApiAi',
    run: () => {
      // The old dual-transport router picked a live API branch per task; that
      // guarantee used to be checked by asserting manual-branch/provider-branch
      // ORDERING inside llm.js. With only one transport left, the guarantee
      // that actually matters is structural: llm.js cannot name a provider at
      // all, and every public call shape reaches the one transport function.
      const llmSource = readFileSync(new URL('../../electron/ipc/llm.js', import.meta.url), 'utf8');
      const lowered = llmSource.toLowerCase();
      const banned = ['gemini', 'claude', 'anthropic', 'apikey', 'providerfortask', 'modelfortask'];
      const present = banned.filter(token => lowered.includes(token));
      assert(present.length === 0,
        `llm.js must name no provider, credential, or removed routing helper; found: ${present.join(', ') || 'none'}`);
      assert(llmSource.includes("from './nonApiAi.js';")
        && llmSource.includes('NON_API_AI_TRANSPORT')
        && llmSource.includes('requestNonApiAi'),
      'llm.js imports only manual-handoff helpers, never a provider SDK module');
      for (const fn of ['callLLMText', 'callLLMRaw', 'callLLMVision', 'callLLMDocument']) {
        const start = llmSource.indexOf(`export async function ${fn}`);
        assert(start >= 0, `${fn} is exported from llm.js`);
        const nextExportAt = llmSource.indexOf('\nexport ', start + 1);
        const body = llmSource.slice(start, nextExportAt > 0 ? nextExportAt : llmSource.length);
        assert(body.includes('requestNonApiAi({'),
          `${fn} dispatches through requestNonApiAi — the single transport — with no provider branch to choose between`);
      }
      return { checkedFunctions: 4, bannedTokens: banned.length };
    },
  },
  {
    name: 'non-API AI: renderer handoff preserves request ownership and subscribes before replay',
    run: () => {
      const preloadSource = readFileSync(new URL('../../electron/preload.js', import.meta.url), 'utf8');
      const dialogSource = readFileSync(new URL('../../src/components/NonApiAiDialog.jsx', import.meta.url), 'utf8');
      const persistenceSource = readFileSync(new URL('../../src/hooks/useCanvasPersistence.js', import.meta.url), 'utf8');
      const appSource = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8');
      const mainSource = readFileSync(new URL('../../electron/main.js', import.meta.url), 'utf8');
      const transportSource = readFileSync(new URL('../../electron/ipc/nonApiAi.js', import.meta.url), 'utf8');
      assert(preloadSource.includes("cancelNonApiAiRequest: (requestId) => ipcRenderer.invoke('cancel-non-api-ai-request', { requestId })"),
        'the preload bridge exposes only a request-id-bound manual AI cancellation IPC');
      assert(preloadSource.includes("stepBackNonApiAiRequest: (requestId) => ipcRenderer.invoke('step-back-non-api-ai-request', { requestId })")
        && dialogSource.includes('activeRequest.canStepBack')
        && dialogSource.includes('Back one step')
        && dialogSource.includes('initialResponse'),
      'a rewindable follow-up exposes a request-bound Back action and restores the prior accepted paste for editing');
      const jobSearchSource = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const jobBoardSource = readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      assert(dialogSource.includes("new CustomEvent('non-api-ai-node-cancelled'")
        && dialogSource.includes('result.nodeCancelled && cancelledNodeId')
        && dialogSource.includes('detail: { nodeId: cancelledNodeId, runId: cancelledRunId }')
        && jobSearchSource.includes("document.addEventListener('non-api-ai-node-cancelled', onManualAiNodeCancelled)")
        && jobSearchSource.includes('stopHandler();')
        && jobSearchSource.includes('resetHandler(e, { preserveRecovery: true })'),
      'cancelling a node-owned manual AI request notifies its Job Search hub with exact run ownership before using the in-card saved-progress Stop path');
      assert(preloadSource.includes("revealNonApiAiAttachment: (requestId, filePath) => ipcRenderer.invoke('reveal-non-api-ai-attachment', { requestId, filePath })")
        && dialogSource.includes('activeRequest.attachments?.length > 0')
        && dialogSource.includes('Show in Finder'),
      'attachments are rendered outside the prompt with a request-bound Finder action');
      assert(preloadSource.includes("replayPendingNonApiAiRequests: () => ipcRenderer.invoke('replay-pending-non-api-ai-requests')"),
        'the preload bridge exposes a sender-owned pending-handoff replay seam');
      const requestListener = dialogSource.indexOf('api.onNonApiAiRequest(receiveRequest)');
      const settledListener = dialogSource.indexOf('api.onNonApiAiSettled(removeRequest)');
      const replay = dialogSource.indexOf('api.replayPendingNonApiAiRequests?.()');
      assert(requestListener >= 0 && settledListener > requestListener && replay > settledListener,
        'both live handoff listeners are installed before the dialog asks main to replay pending prompts');
      const selectorStart = dialogSource.indexOf('<nav aria-label="Pending AI handoff batches"');
      const selectorEnd = dialogSource.indexOf('</nav>', selectorStart);
      const selectorSource = dialogSource.slice(selectorStart, selectorEnd);
      assert(dialogSource.includes('window.electronAPI.cancelNonApiAiRequest(requestId)')
        && dialogSource.includes('Cancel task stops the owning job operation.')
        && dialogSource.includes("request.itemCount === 1 ? 'item' : 'items'")
        && dialogSource.includes('const count = Number.isFinite(request.itemCount)')
        && dialogSource.includes('const selectorLabel = applicationOrdinal')
        && dialogSource.includes('Number.isFinite(request.batch) ? String(request.batch)')
        // Chips stay plain numbers. Scoring keeps its batch number; an
        // application bundle keeps a stable per-bundle ordinal so ten parallel
        // chats cannot be renumbered underneath the person working through them.
        && dialogSource.includes('String(index + 1)')
        && dialogSource.includes('applicationOrdinalsRef')
        && dialogSource.includes('grid grid-cols-5 gap-1 sm:grid-cols-10')
        && !dialogSource.includes('overflow-x-auto custom-scrollbar')
        && selectorSource.includes('const selectorDescription =')
        && selectorSource.includes("isWorking ? 'action in progress' : null")
        && selectorSource.includes('<span>{selectorLabel}</span>')
        && !selectorSource.includes('handoffCode')
        && dialogSource.includes('{activeRequest?.handoffCode && !isBridgeHeldRequest && !isMcpRoutedRequest && (')
        && dialogSource.includes('isBridgeHeldPush(bridgeStatus, activeRequest?.bridgeClaimId)')
        && dialogSource.includes('const isBridgeHeldRequest = isBridgeHeldApplication || isBridgeHeldPushRequest')
        && dialogSource.includes("{isCancelling ? 'Cancelling…' : 'Cancel task'}")
        && dialogSource.includes('{activeRequest.handoffCode}')
        && dialogSource.includes('selectedRequestId')
        && dialogSource.includes('Pending AI handoff batches')
        && dialogSource.includes('mergedRequests.find(request => request.requestId === selectedRequestId)')
        // Application bundles and scoring batches are ONE queue: selection,
        // the chip strip, the pending count and the dock label all read the
        // merged list, so a bundle can never be stranded behind a scoring run.
        && dialogSource.includes('mergeDockQueue(requests, visibleApplicationItems)')
        && dialogSource.includes('subscribeApplicationHandoffs')
        && dialogSource.includes('submittingRequestIds.has(activeRequestId)')
        && dialogSource.includes('actionRequestIdsRef.current.has(activeRequestId)'),
      'the handoff UI exposes every pending batch, tracks each request action independently, and binds cancellation to its captured request');
      // Manual/application queues still need their numbered selector, but an
      // all-automatic MCP queue is claimed by one worker plan. In that mode
      // showing a button for every later batch falsely suggests that every
      // worker starter must be copied again. The dock instead labels the
      // automatic context in the header and leaves its one operational
      // summary to BridgeProgress below.
      const panelHeaderAt = dialogSource.indexOf('<header className="shrink-0 px-5 py-4 border-b border-white/10">');
      const promptStripAt = dialogSource.indexOf('<nav aria-label="Pending AI handoff batches"');
      assert(panelHeaderAt >= 0 && promptStripAt > panelHeaderAt
        && dialogSource.includes('const isAutomaticMcpQueue = mergedRequests.length > 0')
        && dialogSource.includes('{isAutomaticMcpQueue ? (')
        && dialogSource.includes('>Automatic</span>')
        && !dialogSource.includes('automaticWorkerQueueSummary')
        && dialogSource.includes(') : queueLabel && <span className="text-[11px] text-white/40">{queueLabel}</span>}')
        && selectorSource.includes('mergedRequests.map((request, index) => {')
        && /const queueLabel = useMemo\(\(\) => `\$\{mergedRequests\.length\} pending`/.test(dialogSource)
        && dialogSource.includes('1 handoff released now'),
      'automatic MCP queues replace redundant batch selectors and header telemetry with one worker-plan summary while manual queues retain their selector');
      // Two mis-pastes the HANDOFF- scans above structurally cannot see. An
      // application bundle answered in the wrong chat carries no HANDOFF-
      // stamp to disagree with, so bundle 2's answer dropped into bundle 1
      // reached the host and came back as a complaint about the ENVELOPE —
      // spending a round and handing the correction machinery a defect that
      // has nothing to do with the documents. And nothing anywhere noticed a
      // response already filed under a different prompt; that was only ever
      // found afterwards, in a bug report. Both are now caught before the
      // submit, so neither costs a handoff.
      assert(dialogSource.includes("import { assessPastedResponse, responseFingerprint } from '../utils/pasteIdentityGuard'")
        && dialogSource.includes('const pasteAssessment = useMemo(() => assessPastedResponse({')
        && dialogSource.includes('queuedRequests: mergedRequests,')
        && dialogSource.includes('priorSubmissions: submittedResponses,')
        && dialogSource.includes('|| Boolean(misdirectedPasteError)'),
      'the dock checks a pasted answer against every other queued prompt and against what it has already sent, before the submit');
      // Recorded on BOTH submit paths. A fingerprint stored for only one kind
      // of prompt would make the duplicate check silently one-directional:
      // an application answer re-pasted into a scoring prompt would be caught
      // while the reverse sailed through.
      const recordCall = 'recordSubmittedResponse(activeRequest, submittedIndex, activeResponse, Boolean(result?.accepted));';
      assert(dialogSource.split(recordCall).length - 1 === 2
        && dialogSource.includes('const submittedIndex = mergedRequests.findIndex(item => item.requestId === requestId);')
        && dialogSource.includes('accepted: Boolean(accepted),')
        && dialogSource.includes('next.length > SUBMITTED_RESPONSE_MEMORY'),
      'both the application and scoring submit paths record what they sent, with its accepted verdict, in a bounded store');
      // The notice must never reach the block. Re-sending identical text under
      // a rotated handoff code is a real repair — a code can rotate without
      // the documents changing — and a hard block there once trapped a live
      // round with no way out.
      assert(dialogSource.includes('const responseCrossPasteBlocked = Boolean(draftMismatchError) || Boolean(applicationCrossPasteError) || Boolean(misdirectedPasteError);')
        && !dialogSource.includes('Boolean(repeatedPasteNotice)')
        && dialogSource.includes('const repeatedPasteNotice = pasteAssessment.notice'),
      'a repeat of this prompt\u2019s own text informs without blocking, because re-sending under a rotated code is a legitimate repair');
      // A blocked paste has to be a repair, not a dead end: the text provably
      // is not this prompt's answer, and when the guard knows which queued
      // prompt owns it, getting there is one press.
      assert(dialogSource.includes('Go to {misdirectedOwnerName}')
        && dialogSource.includes('Clear this box')
        && dialogSource.includes('setSelectedRequestId(misdirectedOwnerRequestId);')
        && dialogSource.includes('onClick={() => setActiveResponse(\'\')}')
        && dialogSource.includes('{responseCrossPasteBlocked && ('),
      'a blocked paste offers the prompt that owns it and a way to empty the box, instead of only refusing');
      // One numbering rule. A message that says "Application 3" has to point
      // at a chip that reads 3; two rules would drift and send someone to the
      // wrong chat, which is the exact mistake this guard exists to stop.
      assert(dialogSource.includes('const describeQueuedPrompt = useCallback((request, index) => {')
        && dialogSource.includes('const { selectorLabel, label } = describeQueuedPrompt(request, index);')
        && dialogSource.includes('describeQueuedPrompt(mergedRequests[misdirectedOwnerIndex], misdirectedOwnerIndex).label'),
      'the chip strip and every guard message that names a prompt read one numbering rule');
      // A bundle past pasting keeps its chip AND its panel until it is
      // genuinely finished. It used to vanish the instant a response was
      // accepted — while the app was still rendering, measuring and saving —
      // and reappear if that work failed back into another round. Because a
      // bundle that leaves the queue releases its chip number, it could come
      // back wearing a different one, or find another bundle already wearing
      // its old one; the returning prompt was then unreadable as same-job or
      // new-job. Holding the entry holds the number.
      assert(dialogSource.includes('const applicationWorkingState = isApplicationRequest && activeRequest.working')
        && dialogSource.includes("? (activeRequest.workingState === 'blocked' ? 'blocked' : 'working')")
        && dialogSource.includes(') : applicationWorkingState ? (')
        && dialogSource.includes('Saving this application bundle\u2026')
        && dialogSource.includes('Needs a layout retry \u2014 press Retry layout check on its card')
        // TWO LINES, and structurally unable to become three: what the state
        // is, and which job it is. The paragraphs that used to sit here
        // explained the chip-number rule — a thing to understand once, not to
        // re-read on every save — and `truncate` on both rows is what stops a
        // long job title from wrapping into a third.
        && dialogSource.includes('<div className="truncate font-semibold text-white" title={workingHeadline}>')
        && dialogSource.includes('<div className="truncate text-violet-100/75"')
        && !dialogSource.includes('Nothing to paste while this runs.')
        && !dialogSource.includes('The documents are already written'),
      'an application bundle the app is still finishing keeps its panel, in a two-line state that asks for nothing');
      // The panel is floored so a short state cannot collapse it. A prompt with
      // its paste box runs ~47rem; a saving notice is two lines, and without a
      // floor the dock shrank the instant a response was accepted and sprang
      // back when the next prompt arrived. Capped by the viewport, because a
      // min-height that beats max-height pushes the submit button off a short
      // screen.
      assert(dialogSource.includes('min-h-[min(47rem,calc(100vh-6.5rem))] max-h-[calc(100vh-6.5rem)]'),
      'the dock panel keeps one height across every state instead of collapsing onto a short one, and its viewport cap subtracts the toolbar clearance');
      // The chip carries the same fact, and carries it as motion: a static dot
      // would read as one more settled state rather than as work still running.
      assert(dialogSource.includes('const isBundleSaving = Boolean(request.working);')
        && dialogSource.includes("request.retryReproducesFailure ? 'needs an app update' : 'needs a layout retry'")
        && dialogSource.includes('animate-spin text-violet-200'),
      'the chip distinguishes an app-fix block from a retryable layout check while preserving its saving state');
      // Focus must still advance. Before this the accepted item VANISHED and
      // activeRequest fell through to whatever was first, so advancing on
      // purpose is what PRESERVES that flow — without it the panel would newly
      // pin itself to a bundle that wants nothing from anyone.
      assert(dialogSource.includes('const nextWaiting = mergedRequests.find(item => item.requestId !== requestId && !item.working);'),
      'accepting a bundle still moves focus to the next prompt that actually wants a paste');
      // And the collapsed dock stops calling a bundle that wants nothing a
      // waiting handoff, which would be the same confusion in miniature.
      assert(dialogSource.includes('1 bundle saving')
        && dialogSource.includes('const savingCount = mergedRequests.filter(request => request.working).length;')
        && dialogSource.includes('1 handoff waiting'),
      'the collapsed dock names waiting and saving separately instead of calling both waiting');
      assert(dialogSource.includes('const awaitingSuccessorRef = useRef(null)')
        && dialogSource.includes("focus awaiting workflow successor")
        && dialogSource.includes('isWorkflowSuccessor(successor, incoming)')
        && dialogSource.includes('workflow successor issued; focus advanced from prior completed handoff')
        // A direct chip click cancels BOTH automatic preferences before it
        // selects: the settling run's queued successor, and a bundle whose
        // card asked for focus before discovery had published it. Matched
        // whitespace-tolerantly on purpose: what has to hold is the ORDER of
        // these three statements. Pinning their exact indentation turned
        // re-nesting the JSX above them into a failure that said nothing
        // about focus.
        && /awaitingSuccessorRef\.current = null;\s*\n\s*pendingFocusJobIdsRef\.current\.clear\(\);\s*\n\s*setSelectedRequestId\(request\.requestId\);/.test(dialogSource),
      'when the active handoff settles before its workflow can issue the next prompt, focus follows that same run’s successor instead of reverting to an older correction; a direct user selection cancels the automatic preference');
      // Overall progress through the task. A batch number alone does not answer
      // "how many are left" when the run is dozens of handoffs long.
      assert(dialogSource.includes('` · ${request.itemsDone}/${request.itemsTotal} done`')
        && dialogSource.includes('Number.isFinite(request.itemsDone) && Number.isFinite(request.itemsTotal)')
        && transportSource.includes('itemsDone: cleanProgressCount(itemsDone),')
        && transportSource.includes('itemsTotal: cleanProgressCount(itemsTotal),')
        && transportSource.includes('itemsDone: record.itemsDone,'),
      'the handoff dialog reports overall task progress, and the transport carries it through to the renderer');
      // cleanBatchNumber floors at 1; a progress counter reads 0 on the first
      // handoff and must not be blanked exactly when it is most reassuring.
      // Concurrency: independent batches must issue together, BOUNDED, and a
      // failure must tear its siblings down rather than leave prompts on screen
      // that nothing can cancel once the IPC layer drops the controller.
      const prefSource = readFileSync(new URL('../../electron/ipc/jobPreferences.js', import.meta.url), 'utf8');
      const jobsIpcSource = readFileSync(new URL('../../electron/ipc/jobs.js', import.meta.url), 'utf8');
      assert(jobsIpcSource.includes('hasExactDurableRawHandoff')
        && jobsIpcSource.includes('durableRunHasAnyTask(manualAiRunId')
        && jobsIpcSource.includes('legacyResearchMigrationNeeded: await legacyCompanyResearchPresent')
        && jobsIpcSource.includes('companyResearchPipelineEligible: !(await hasPackedCompanyAssessment)')
        && jobsIpcSource.includes('legacyResearchStepProbe: ({ prompt, task, grounding, hints })')
        && prefSource.includes('legacyResearchStepProbe({')
        && prefSource.includes('const legacyRequests = [];')
        && prefSource.includes('const freshRequests = [];'),
      'a resumed run keeps only its exact old company handoffs on the legacy contract, while unissued sibling employers enter packed batches');
      assert(prefSource.includes("from '../../src/utils/handoffScheduler.js';")
        && prefSource.includes('HANDOFF_CONCURRENCY as MANUAL_HANDOFF_CONCURRENCY,')
        && prefSource.includes('const plannedRootBatches = [];')
        && prefSource.includes('const nextPlannedRootBatch = async () => {')
        && prefSource.includes('await runAutomaticHandoffWorkers({')
        && prefSource.includes('async function runCompanyResearchPipeline(')
        && prefSource.includes('const canPipelineFreshResearch = companyResearchPipelineEligible')
        && prefSource.includes('async function assessCompletedCompanyResearch(')
        && prefSource.includes('const rawWaveResults = await mapAutomaticHandoffs(rawWave, HANDOFF_CONCURRENCY, executeRawDescriptor')
        && !prefSource.includes('researchStepStatusProbe')
        && !prefSource.includes('RESEARCH_CONCURRENCY'),
      'listing evaluation and company research use the centralized bounded automatic scheduler; cache/legacy layouts retain their required exact barrier');
      // CONTINUOUSLY adaptive, not calibrate-once: model verbosity drifts, so
      // each round re-derives its size from what the previous responses cost.
      assert(prefSource.includes('const { size: listingBatchSize, observedTokensPerMatch, recalled } = await roundSize(round);')
        && prefSource.includes('while (position < LISTING_EVAL_CONCURRENCY && cursor < pool.length) {')
        && prefSource.includes("const observedTokensPerMatch = (await calibration?.observedTokensPerMatch?.(items.length)) ?? null;"),
      'every round re-sizes itself from measured output rather than a fixed estimate');
      assert(transportSource.includes('const sessionCalibration = new Map();')
        && transportSource.includes('const seriesKey = calibrationSeriesKey(task, planItemCount);')
        && transportSource.includes('sessionCalibration.get(calibrationSeriesKey(task, planItemCount))?.samples || []')
        && transportSource.includes('sessionCalibration.clear();')
        && !transportSource.includes('state.calibration'),
      'response-size calibration is isolated to the current process and preference-plan size until the manual chat model/profile is identifiable');
      assert(transportSource.includes('handoffCodeVerificationVersion: effectiveSavedStep')
        && transportSource.includes('? (effectiveSavedStep.handoffCodeVerificationVersion || null)')
        && transportSource.includes(': HANDOFF_CODE_VERIFICATION_VERSION,'),
      'an exact pending pre-enforcement step keeps its code-optional contract; only a genuinely new handoff opts into code enforcement');
      // The declared output budget in the prompt must come from the SAME
      // measured rate the batch size did. When they diverged, a verbose model
      // correctly shrank the batch while the prompt still quoted the old static
      // budget — instructing the model to write less than the answer needs.
      assert(prefSource.includes('planItemCount: items.length, observedTokensPerMatch }'),
        'the measured rate rides on the hints so the declared output budget tracks the batch size');
      // Replay must reproduce the ORIGINAL layout: by replay time every sample
      // exists, so recomputing would choose a different size and the durable
      // step keys would miss — making the person redo answers already pasted.
      assert(prefSource.includes('const recalled = await calibration?.recallRoundSize?.(round, passKey);')
        && prefSource.includes('await calibration?.rememberRoundSize?.(round, size, passKey, observedTokensPerMatch);')
        && prefSource.includes('return { size: recalled.size, observedTokensPerMatch: recalled.rate ?? null, recalled: true };'),
      'a recorded round size is replayed in preference to recomputing an adaptive one');
      // The RATE is replayed too, not just the size. The rate sets the declared
      // output budget, which is written into the prompt and hashed into the
      // durable step key — re-reading a drifted live rate on replay would change
      // the prompt and make every accepted step miss its cache.
      assert(transportSource.includes('sizes[round] = { size: cleanSize, rate:')
        && prefSource.indexOf('const recalled = await calibration?.recallRoundSize')
           < prefSource.indexOf('const observedTokensPerMatch = (await calibration?.observedTokensPerMatch?.(items.length))'),
      'the rate in force when a round was first issued is recorded and replayed with its size');
      // One run can evaluate more than once (a post-run source append), and each
      // pass restarts its round counter — so a bare round index would let the
      // second pass inherit the first pass's layout for a different pool.
      assert(prefSource.includes('const passKey = `${pool.length}x${items.length}`;')
        && transportSource.includes('export async function recallRunRoundSize(runId, round, passKey'),
      'recorded round sizes are namespaced per evaluation pass, not just per round index');
      // batchTotal must NOT be reported once sizes adapt: it is unknowable
      // mid-run AND it is hashed into the durable step key.
      assert(!prefSource.includes('hints: { itemCount: batch.length, matchCount: batch.length * items.length, batch: thisBatchIndex, batchTotal')
        && prefSource.includes('batch: thisBatchIndex, itemsDone: listingsDone'),
      'adaptive listing evaluation omits a drifting batchTotal from its step key; itemsDone/itemsTotal carry progress instead');
      assert(prefSource.includes('listingAbort.abort(error);')
        && prefSource.includes('AbortSignal.any([signal, listingAbort.signal])'),
      'a failing worker aborts its in-flight siblings, so no orphaned prompt outlives the operation that owns it');
      // Batch numbers must be assigned while a durable descriptor group is
      // planned, not by whichever worker finishes first: the number is hashed
      // into the durable step key that makes a resumed run skip work already
      // accepted by the person.
      assert(prefSource.includes('thisBatchIndex: roundFirstBatch + position + 1,')
        && !prefSource.includes('batchIndex += 1;'),
      'each rolling root batch receives a stable planned number rather than a completion-order counter');
      // Progress must count COMPLETED work: with 10 in flight, issue order is no
      // longer completion order.
      assert(prefSource.includes('listingsDone += batch.length;')
        && prefSource.includes('itemsDone: listingsDone'),
      'pool progress counts merged batches, not the position of whichever prompt is on screen');

      assert(transportSource.includes('function cleanProgressCount(value)')
        && transportSource.includes('Number.isSafeInteger(number) && number >= 0'),
      'the progress counter admits zero and every safe total rather than reusing the 1-based batch-number sanitizer');
      // THE resume invariant: these are display-only. Hashing them would change
      // the step key and make a resumed run re-ask for answers already pasted.
      const stepKeyStart = transportSource.indexOf('function durableStepKey(');
      const stepKeyEnd = transportSource.indexOf('function selectDurableStepByLogicalOrRawKey(', stepKeyStart);
      const stepKeyBody = transportSource.slice(stepKeyStart, stepKeyEnd);
      assert(stepKeyStart >= 0 && stepKeyEnd > stepKeyStart
        && !stepKeyBody.includes('itemsDone') && !stepKeyBody.includes('itemsTotal'),
      'the durable step key must NOT hash the display-only progress counters, or a resumed run re-issues accepted handoffs');

      assert(dialogSource.includes('const [isExpanded, setIsExpanded] = useState(true)')
        && dialogSource.includes('const hadPendingRequestsRef = useRef(false);')
        && dialogSource.includes('useLayoutEffect(() => {')
        && dialogSource.includes('if (hasPendingRequests && !hadPendingRequestsRef.current) setIsExpanded(true);')
        && dialogSource.includes('Pending AI handoffs')
        && dialogSource.includes('Expand')
        && dialogSource.includes('Minimize')
        && dialogSource.includes('pointer-events-none fixed inset-0')
        && dialogSource.includes('pointer-events-auto fixed bottom-[5.5rem] right-4')
        && dialogSource.includes("data-handoff-dock={isExpanded ? 'expanded' : 'collapsed'}")
        && dialogSource.includes('role="region"')
        && !dialogSource.includes('aria-modal="true"')
        && !dialogSource.includes('aria-controls="non-api-ai-handoff-panel"')
        && !dialogSource.includes('updateModalCount')
        && !dialogSource.includes('trapFocus')
        && !dialogSource.includes('blockEscape'),
      'pending handoffs default to an expanded non-modal dock and reopen when a new queue appears; its controls own pointer events, do not point at an unmounted panel, and leave the canvas interactive without trapping keyboard focus');
      const ownerBadgeStart = dialogSource.indexOf('const ownerBadgeForNode = (nodeId) =>');
      const ownerBadgeEnd = dialogSource.indexOf('\n};', ownerBadgeStart) + 3;
      const ownerBadgeSource = dialogSource.slice(ownerBadgeStart, ownerBadgeEnd);
      assert(ownerBadgeStart >= 0
        && ownerBadgeSource.includes('Math.imul')
        && ownerBadgeSource.includes("return `Hub ${((hash >>> 0).toString(36).toUpperCase()).padStart(7, '0')}`;")
        && !ownerBadgeSource.includes('.slice(')
        && dialogSource.includes('const multipleHubQueue = useMemo(() =>')
        && dialogSource.includes('const chipLabel = ownerBadge ? `${ownerBadge} · ${label}` : label;')
        && dialogSource.includes('{multipleHubQueue && ownerBadgeForNode(activeRequest.nodeId) && ('),
      'a queue spanning Job Search hubs assigns each owner a deterministic privacy-safe badge in both its selectable chip and active handoff header, without exposing an id fragment');
      assert(appSource.lastIndexOf('<NonApiAiDialog />') > appSource.lastIndexOf('</ErrorBoundary>'),
        'the global handoff stays mounted above the canvas error boundary so an external-AI wait can still be cancelled after a renderer error');
      assert(transportSource.includes('NON_API_AI_HANDLER_CHANNELS')
        && transportSource.includes('ipcMain.removeHandler?.(channel)'),
      'manual-AI handlers can be safely re-registered by a controlled development reload without duplicate Electron IPC registrations');
      assert(mainSource.includes('hasPendingNonApiAiRequestsForSender(expectedSender)')
        && mainSource.includes("return { action: 'save', skipDocumentSessions, forceCanvasSave: true }")
        && mainSource.includes('await flushNonApiAiPersistence()')
        && dialogSource.includes("new CustomEvent('non-api-ai-node-pending'")
        && jobSearchSource.includes('backgroundJobResumeRequest(')
        && jobSearchSource.includes('automaticProviderRequest?.providerPhaseOnly !== true')
        && jobSearchSource.includes('handleResumeRun({ offer, providerPhaseOnly: true })')
        && jobSearchSource.includes('manualAiExplicitResumeRequest?.runId !== resume.runId')
        && jobSearchSource.includes('User continued saved manual AI run'),
      'a pending handoff auto-saves its canvas restart marker and flushes its draft ledger on close; only a provider-only staged recovery resumes automatically, while every semantic manual-AI handoff requires its exact user-authorized run id');
      const staleRecoveryBannerStart = jobSearchSource.indexOf('const pausedManualAiRecovery = savedManualAiRecovery?.pausedByUser === true;');
      const staleRecoveryBannerEnd = jobSearchSource.indexOf('\n\n  const banner = (', staleRecoveryBannerStart);
      const staleRecoveryBanner = jobSearchSource.slice(staleRecoveryBannerStart, staleRecoveryBannerEnd);
      assert(staleRecoveryBannerStart >= 0 && staleRecoveryBannerEnd > staleRecoveryBannerStart
        && !jobSearchSource.includes("retirementReason: 'discarded-stale-manual-ai-recovery'")
        && !jobSearchSource.includes('handleDiscardStaleManualAiRecovery')
        && staleRecoveryBanner.includes('const pausedManualAiRecovery = savedManualAiRecovery?.pausedByUser === true;')
        && staleRecoveryBanner.includes('This job search was stopped before source scraping began.')
        && staleRecoveryBanner.includes('Clear career data is the only way to remove it.')
        && staleRecoveryBanner.includes('onClick={handleContinueManualAiRecovery}')
        && !staleRecoveryBanner.includes('Start fresh'),
      'an aged or user-paused manual-AI recovery retains its exact marker: its banner offers explicit Resume and identifies Clear career data as the only removal action');
      const sliceSource = (start, end) => {
        const from = jobSearchSource.indexOf(start);
        const to = jobSearchSource.indexOf(end, from);
        return from >= 0 && to > from ? jobSearchSource.slice(from, to) : '';
      };
      const manualAutoResume = sliceSource(
        'const [manualAiExplicitResumeRequest, setManualAiExplicitResumeRequest] = useState(null);',
        'const handleContinueManualAiRecovery = useCallback',
      );
      const recoveryNow = 1_800_000_000_000;
      const ordinaryMarker = (updatedAt) => ({ runId: 'manual-recovery', updatedAt });
      assert(!isStaleOrdinaryManualAiResume(ordinaryMarker(recoveryNow - STALE_MANUAL_AI_RESUME_MS + 1), recoveryNow)
        && isStaleOrdinaryManualAiResume(ordinaryMarker(recoveryNow - STALE_MANUAL_AI_RESUME_MS), recoveryNow)
        && isStaleOrdinaryManualAiResume(ordinaryMarker(undefined), recoveryNow)
        && isStaleOrdinaryManualAiResume(ordinaryMarker(String(recoveryNow)), recoveryNow)
        && isStaleOrdinaryManualAiResume(ordinaryMarker(recoveryNow + 1), recoveryNow)
        && !isStaleOrdinaryManualAiResume({ runId: 'saved', updatedAt: recoveryNow - STALE_MANUAL_AI_RESUME_MS, task: 'job-scoring' }, recoveryNow)
        && !isStaleOrdinaryManualAiResume({ runId: 'retiring', updatedAt: recoveryNow - STALE_MANUAL_AI_RESUME_MS, retirementPending: true }, recoveryNow),
      'the executable stale predicate holds exact-24h, missing, malformed, and future ordinary markers while preserving recent, saved-scrape, and retirement recovery semantics');
      const preSearchRunId = 'accepted-pre-search';
      const preSearchStartedAt = recoveryNow - 10_000;
      const acceptedPreSearchMarker = {
        runId: preSearchRunId,
        updatedAt: preSearchStartedAt + 500,
        preSearchRecovery: createManualAiPreSearchRecovery({
          version: MANUAL_AI_PRE_SEARCH_RECOVERY_VERSION,
          manualAiRunId: preSearchRunId,
          nodeId: 'resume-node',
          startedAt: preSearchStartedAt,
          searchWindow: {
            startTimestamp: preSearchStartedAt,
            anchorTimestamp: preSearchStartedAt,
            completionTimestamp: null,
            capped: false,
            capReason: null,
            providerLookbackDays: 30,
          },
        }),
      };
      const matchingStagedOffer = {
        nodeId: 'resume-node',
        startedAt: preSearchStartedAt + 501,
        searchWindow: acceptedPreSearchMarker.preSearchRecovery.searchWindow,
      };
      assert(exactStagedOfferSupersedesPreSearchManualAiResume(
        matchingStagedOffer, acceptedPreSearchMarker, { nodeId: 'resume-node' },
      )
        && !exactStagedOfferSupersedesPreSearchManualAiResume(
          { ...matchingStagedOffer, startedAt: preSearchStartedAt + 499 }, acceptedPreSearchMarker, { nodeId: 'resume-node' },
        )
        && !exactStagedOfferSupersedesPreSearchManualAiResume(
          matchingStagedOffer, { ...acceptedPreSearchMarker, updatedAt: 'unknown' }, { nodeId: 'resume-node' },
        )
        && !exactStagedOfferSupersedesPreSearchManualAiResume(
          matchingStagedOffer, acceptedPreSearchMarker, { nodeId: 'other-node' },
        )
        && !exactStagedOfferSupersedesPreSearchManualAiResume(
          { ...matchingStagedOffer, nodeId: null }, acceptedPreSearchMarker, { nodeId: 'resume-node' },
        )
        && !exactStagedOfferSupersedesPreSearchManualAiResume(
          { ...matchingStagedOffer, searchWindow: { ...matchingStagedOffer.searchWindow, providerLookbackDays: 14 } }, acceptedPreSearchMarker, { nodeId: 'resume-node' },
        ),
      'an exact staged recovery may retire only an older accepted pre-search marker with the same frozen window; an older manifest, changed window, malformed marker timestamp, different owner, or owner-unknown offer fails closed');
      assert(jobSearchSource.includes('offer?.nodeId === nodeId')
        && jobSearchSource.includes('isExactStagedPreSearchReconciliation')
        && jobSearchSource.includes('inspectNonApiAiRun(marker.runId)')
        && jobSearchSource.includes("retirementReason: 'superseded-by-exact-staged-job-run'")
        && jobSearchSource.includes('let retirementAttempted = false;')
        && jobSearchSource.includes('marker.preSearchRecovery?.startedAt ?? \'missing\'')
        && jobSearchSource.includes('const reconciliationLatches = reconciledStagedPreSearchManualRunsRef.current;')
        && jobSearchSource.includes('if (!retirementAttempted) {\n          reconciliationLatches.delete(reconciliationKey);'),
      'the Job Search card reconciles an accepted pre-search marker only through the exact staged-run ownership transition');
      const staleMarker = ordinaryMarker(recoveryNow - STALE_MANUAL_AI_RESUME_MS);
      const laneCanStart = (marker, options = {}) => !staleOrdinaryManualAiResumeBlocksAdmission(marker, options);
      assert(!laneCanStart(staleMarker)
        && !laneCanStart(staleMarker, { manualAiRunId: staleMarker.runId })
        && laneCanStart(staleMarker, {
          manualAiRunId: staleMarker.runId,
          explicitResumeRunId: staleMarker.runId,
        })
        && laneCanStart(staleMarker, { boardOwnsRecovery: true }),
      'a stale marker arriving before any queued manual-AI lane starts blocks every generic matching run id, while only the exact explicit Resume capability or exact Board ownership may admit it');
      assert(isLiveManualAiRecoveryBoardOwner({ boardRunId: 'live-plan' })
        && !isLiveManualAiRecoveryBoardOwner({ boardRunId: 'orphan', missingPlan: true })
        && !isLiveManualAiRecoveryBoardOwner(null),
      'an orphaned Board-owner diagnostic with missingPlan is never treated as authority to bypass stale manual-AI recovery admission');
      assert(manualAutoResume.includes('manualAiExplicitResumeRequest?.runId !== resume.runId')
        && manualAutoResume.includes('current?.runId === resume.runId ? null : current')
        && manualAutoResume.indexOf('current?.runId === resume.runId ? null : current')
          > manualAutoResume.indexOf('const attemptToken = Symbol(`manual-ai-auto-resume:${resume.runId}`)'),
      'an explicit stale-recovery authorization is exact-id-bound and consumed when that attempt is admitted, so retries require another click');
      const staleAdmission = sliceSource(
        'const manualAiRecoveryNeedsDecision',
        '// Why a drop would bounce right now',
      );
      const genericRerun = sliceSource(
        'const handleRerun = useCallback',
        'const cancelBoardRun = useCallback',
      );
      const pipelineAdmission = sliceSource(
        'const runPipeline = useCallback',
        'const resumeScoring = useCallback',
      );
      assert(staleAdmission.includes('const controlsLocked = baseControlsLocked || manualAiRecoveryAdmissionLocked;')
        && jobSearchSource.includes('const errorControlsLocked = !!data.locked || !!data.queuedModuleRun || manualAiRecoveryAdmissionLocked;')
        && genericRerun.includes('Choose Resume for the saved manual-AI recovery, or use Clear career data to deliberately remove it before another search.')
        && !genericRerun.includes('Start fresh')
        && pipelineAdmission.includes('staleRecoveryBlockedAtLaneStart')
        && pipelineAdmission.includes('staleOrdinaryManualAiResumeBlocksAdmission(laneData.manualAiResume'),
      'a pending stale recovery locks normal controls and is rechecked at the shared-lane turn, while the exact user-authorized Resume remains admissible and Clear career data is the sole removal path');
      const scoringContinuation = sliceSource('const resumeScoring = useCallback', 'resumeScoringRef.current = resumeScoring;');
      const interruptedResume = sliceSource('const handleResumeRun = useCallback', 'resumeInterruptedRunRef.current = handleResumeRun;');
      const savedScrapeResume = sliceSource('const handleResumeSavedScrape = useCallback', 'resumeSavedScrapeRef.current = handleResumeSavedScrape;');
      const reanalysis = sliceSource('const handleReanalyze = useCallback', 'const cleanupRetirementPending = hasPendingManualAiRetirement(data);');
      assert(scoringContinuation.includes('staleEmptyContinuationBlockedAtLaneStart')
        && scoringContinuation.includes('staleContinuationBlockedAtLaneStart')
        && interruptedResume.includes('staleInterruptedResumeBlockedAtLaneStart')
        && savedScrapeResume.includes('staleSavedRecoveryBlockedAtLaneStart')
        && reanalysis.includes('staleRecoveryBlockedAtLaneStart'),
      'every standalone continuation rechecks stale admission both before and after its queue turn, so a marker that arrives while scoring, interrupted recovery, saved-scrape recovery, or re-analysis waits cannot mint manual AI');
      assert(jobSearchSource.includes('manualAiStaleRecoveryActionRunIdRef.current')
        && jobSearchSource.includes('className="nodrag px-2 py-0.5')
        && jobSearchSource.includes('disabled={baseControlsLocked || manualAiRecoveryActionBusy || !canvasFilePath}')
        && jobSearchSource.includes('onClick={handleContinueManualAiRecovery}')
        && !jobSearchSource.includes("cancellationReason: 'discarded-stale-manual-ai-recovery'"),
      'an explicit stale-recovery Resume remains single-action and exact-id-bound; it never exposes a competing discard path that could erase the saved marker');
      assert(mainSource.includes('async function flushNonApiAiPersistenceForLifecycle(win, actionType)')
        && mainSource.includes("if (!await flushNonApiAiPersistenceForLifecycle(win, 'close')) return;")
        && mainSource.includes("return flushNonApiAiPersistenceForLifecycle(win, 'quit');")
        && mainSource.includes('Could Not Save AI Draft')
        && mainSource.includes('`${verb} Without Saving AI Draft`')
        && mainSource.includes('return choice === 1;')
        && mainSource.includes('Could not flush Non-API AI persistence before')
        && mainSource.includes('Could not complete canvas window close safely')
        && mainSource.includes('Could not complete app quit safely'),
      'a rejected AI-draft durability barrier must keep close/quit fail-closed, explain the failure, and not escape an async Electron event listener');
      const closeCheck = mainSource.slice(mainSource.indexOf('async function checkUnsavedChanges'), mainSource.indexOf('// ── Window creation'));
      assert(closeCheck.indexOf('hasPendingNonApiAiRequestsForSender(expectedSender)')
          < closeCheck.indexOf('if (rendererState.hasUnsavedChanges)')
        && preloadSource.includes('const pendingNonApiAiDraftWrites = new Set()')
        && preloadSource.includes('await Promise.allSettled([...pendingNonApiAiDraftWrites])')
        && persistenceSource.indexOf('await window.electronAPI?.flushNonApiAiPersistence?.()')
          < persistenceSource.indexOf('sendQuitResponse(response, requestId);'),
      'pending handoffs force a save independently of the dirty flag, and shutdown waits for every draft write before replying');
      assert(!dialogSource.includes("new CustomEvent('non-api-ai-node-settled'")
        && !jobSearchSource.includes("document.addEventListener('non-api-ai-node-settled'")
        && !jobBoardSource.includes("document.addEventListener('non-api-ai-node-settled'")
        && jobSearchSource.includes('completeManualAiRun(effectiveManualAiRunId)')
        && jobBoardSource.includes('completeManualAiRun(manualAiRunId)'),
      'a prompt settlement no longer clears restart state; only committed workflow completion or cancellation does');
      assert(jobSearchSource.includes("manualAiRecoveryMode: 'append-scored-jobs'")
        && jobSearchSource.includes("resultMode === 'append'")
        && jobSearchSource.includes('recoveryMode: resume.recoveryMode'),
      'background scoring marks append recovery and consumes that mode again after restart');
      return { bridge: 'request-id-bound', replay: 'listener-first', registration: 'idempotent' };
    },
  },
  {
    name: 'non-API AI: pre-search recovery freezes the original window and exact ownership',
    run: () => {
      const originalWindow = {
        startTimestamp: 1_763_596_800_000,
        anchorTimestamp: 1_763_596_800_000,
        completionTimestamp: null,
        capped: true,
        capReason: 'no-completion',
        providerLookbackDays: 21,
      };
      const fingerprint = 'a'.repeat(64);
      const descriptor = createManualAiPreSearchRecovery({
        manualAiRunId: 'manual-run-1',
        nodeId: 'job-search-hub-1',
        searchWindow: originalWindow,
        profileFingerprint: fingerprint,
        startedAt: 1_765_420_123_456,
      });
      assert(descriptor?.version === MANUAL_AI_PRE_SEARCH_RECOVERY_VERSION
        && descriptor.manualAiRunId === 'manual-run-1'
        && descriptor.nodeId === 'job-search-hub-1'
        && descriptor.searchWindow.startTimestamp === originalWindow.startTimestamp
        && descriptor.searchWindow.anchorTimestamp === originalWindow.startTimestamp
        && descriptor.searchWindow.completionTimestamp === null
        && descriptor.searchWindow.capped === true
        && descriptor.searchWindow.capReason === 'no-completion'
        && descriptor.searchWindow.providerLookbackDays === 21
        && descriptor.profileFingerprint === fingerprint
        && descriptor.startedAt === 1_765_420_123_456
        && descriptor.searchWindow !== originalWindow,
      'a pre-search recovery writes a versioned copy of the original exact boundary, cap state, profile identity, and workflow start');
      originalWindow.providerLookbackDays = 1;
      assert(descriptor.searchWindow.providerLookbackDays === 21,
        'the persisted descriptor owns a copy of the frozen provider boundary rather than a mutable caller object');

      const resume = { runId: 'manual-run-1', preSearchRecovery: descriptor };
      const recovered = manualAiPreSearchRecoveryForResume(resume, {
        runId: 'manual-run-1',
        nodeId: 'job-search-hub-1',
      });
      assert(recovered?.manualAiRunId === 'manual-run-1'
        && recovered.nodeId === 'job-search-hub-1'
        && recovered.searchWindow.startTimestamp === 1_763_596_800_000
        && recovered.startedAt === 1_765_420_123_456,
      'Resume admits only the exact marker/run/hub tuple and returns its immutable original boundary');

      const invalidLookback = createManualAiPreSearchRecovery({
        ...descriptor,
        searchWindow: { ...descriptor.searchWindow, providerLookbackDays: 368 },
      });
      const invalidFingerprint = createManualAiPreSearchRecovery({
        ...descriptor,
        profileFingerprint: 'not-a-sha256',
      });
      const contradictoryAnchor = createManualAiPreSearchRecovery({
        ...descriptor,
        searchWindow: { ...descriptor.searchWindow, anchorTimestamp: descriptor.searchWindow.startTimestamp + 1 },
      });
      assert(invalidLookback === null
        && invalidFingerprint === null
        && contradictoryAnchor === null
        && manualAiPreSearchRecoveryForResume(resume, { runId: 'other-run', nodeId: 'job-search-hub-1' }) === null
        && manualAiPreSearchRecoveryForResume(resume, { runId: 'manual-run-1', nodeId: 'other-hub' }) === null
        && manualAiPreSearchRecoveryForResume({
          ...resume,
          preSearchRecovery: { ...descriptor, version: MANUAL_AI_PRE_SEARCH_RECOVERY_VERSION + 1 },
        }, { runId: 'manual-run-1', nodeId: 'job-search-hub-1' }) === null
        && manualAiPreSearchRecoveryForResume({
          ...resume,
          preSearchRecovery: { ...descriptor, startedAt: 0 },
        }, { runId: 'manual-run-1', nodeId: 'job-search-hub-1' }) === null,
      'invalid provider horizons, fingerprints, timestamps, versions, and ownership mismatches fail closed instead of becoming recovery authority');
      return { descriptorVersion: descriptor.version, frozenLookbackDays: descriptor.searchWindow.providerLookbackDays };
    },
  },
  {
    name: 'non-API AI: every Job Search recovery path owns one shared lane and workflow id',
    run: () => {
      const source = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const between = (start, end) => {
        const from = source.indexOf(start);
        const to = source.indexOf(end, from);
        return from >= 0 && to > from ? source.slice(from, to) : '';
      };
      const usaJobs = between('const triggerUSAJobsBackgroundSearch = useCallback', 'const handleJobsSettingsChange = useCallback');
      const paused = between('const resumeScoring = useCallback', 'useEffect(() => {\n    resumeScoringRef.current = resumeScoring;');
      const crashResume = between('const handleResumeRun = useCallback', 'resumeInterruptedRunRef.current = handleResumeRun;');
      const savedScrape = between('const handleResumeSavedScrape = useCallback', 'const autoResumedManualAiRunRef = useRef(null);');

      assert(usaJobs.includes("lane: 'job-search'")
        && usaJobs.includes('const manualAiRunId = createManualAiRunId(currentId);')
        && usaJobs.includes('manualAiRunId,')
        && usaJobs.includes('lease?.release();')
        && usaJobs.includes('processingRunsRef.current.finish(processingToken)')
        && usaJobs.includes('await resumeScoringRef.current?.()'),
      'the USAJobs append holds the shared job lane and one workflow id, then releases before handing off paused scoring so it cannot deadlock itself');
      assert(paused.includes("lane: 'job-search'")
        && paused.includes('const manualAiRunId = createManualAiRunId(currentId);')
        && paused.includes('completeManualAiRun(manualAiRunId);'),
      'paused-source scoring carries one manual-AI workflow id through preference evaluation, scoring, and terminal preference filtering');
      const crashLeaseAt = crashResume.indexOf('lease = await moduleRunQueue.acquireModuleRun');
      const crashDelegationAt = crashResume.indexOf('Interrupted-run queue delegated to Job Board');
      const crashProcessingAt = crashResume.indexOf('processingToken = processingRunsRef.current.start();');
      assert(crashResume.includes("lane: 'job-search'")
        && crashResume.includes('const manualAiRunId = options?.manualAiRunId || createManualAiRunId(currentId);')
        && crashResume.includes('if (!queueManagedByBoard) {')
        && crashResume.includes("error: 'A Board-managed resume requires an orchestrator node id.'")
        && crashLeaseAt >= 0 && crashDelegationAt > crashLeaseAt && crashProcessingAt > crashDelegationAt
        && crashResume.includes('manualAiRunId,')
        && crashResume.includes('lease?.release();')
        && crashResume.includes('completeManualAiRun(manualAiRunId);'),
      'crash recovery reuses an exact Board-provided workflow id when orchestrated, otherwise acquires the shared lane, and starts processing only after either admission path is established');
      assert(savedScrape.includes("lane: 'job-search'")
        && savedScrape.includes('if (!queueManagedByBoard) {')
        && savedScrape.includes("throw new Error('A board-managed recovery requires an orchestrator node id.')")
        && savedScrape.includes('options?.manualAiRunId || createManualAiRunId(id)')
        && savedScrape.includes("manualAiRecoveryMode: resultMode === 'append' ? 'append-scored-jobs' : 'resume-saved-scrape'")
        && savedScrape.includes('lease?.release();')
        && source.includes('isSavedScrapeManualAiResume(resume)')
        && source.includes('Saved recovery queue delegated to Job Board'),
      'saved-scrape recovery is lane-serialized when standalone, reuses the Board lease when orchestrated, and routes either saved replay mode back to the exact saved snapshot after restart');
      return { workflows: 4, lane: 'job-search' };
    },
  },
  {
    name: 'non-API AI: materialized prompt retains settings and schema but excludes attachment instructions',
    run: () => {
      const schema = {
        type: 'object', required: ['answer'], additionalProperties: false,
        properties: { answer: { type: 'string', minLength: 1 } },
      };
      const handoff = materializeNonApiPrompt({
        prompt: 'DYNAMIC JOBS PAYLOAD',
        cachedPrefix: 'STATIC SCORING RUBRIC',
        task: 'job-scoring',
        responseSchema: schema,
        grounding: true,
        maxOutputTokens: 4321,
        formulaSeed: 4000,
        transport: 'non-api-ai',
        handoffSettings: {
          requestKind: 'document',
          transport: 'non-api-ai',
          userContent: { cachedPrefix: null },
          thinking: { type: 'adaptive' },
          format: { type: 'provider-native-format-sentinel' },
          outputConfig: { effort: 'medium' },
          structuredOutput: { exactApplicationContract: 'appended below', nativeProviderSchema: 'outputConfig.format.schema' },
          apiKey: 'must-not-leak',
          nested: { authorization: 'must-not-leak-either', privateKey: 'must-not-leak-private', authToken: 'must-not-leak-token' },
        },
        attachmentPaths: ['/tmp/resume.pdf', '', null],
        requestKind: 'document',
        excludeModels: ['gemini-test'],
        retryOnTruncation: false,
      });
      assert(handoff.indexOf('STATIC SCORING RUBRIC') < handoff.indexOf('DYNAMIC JOBS PAYLOAD')
        && handoff.includes('Task: job-scoring')
        && handoff.includes('Request kind: document')
        && handoff.includes('Maximum output tokens: 4321')
        && handoff.includes('Output-cap formula seed: 4000')
        && handoff.includes('Transport: non-api-ai (manual copy/paste; no API request, provider selection, or provider fallback)')
        && handoff.includes('Grounded/web research: true')
        && handoff.includes('Retry-on-truncation setting: false')
        && handoff.includes('Handoff configuration (non-secret):')
        && handoff.includes('"transport": "non-api-ai"')
        && handoff.includes('"apiKey": "[redacted]"')
        && handoff.includes('"privateKey": "[redacted]"')
        && handoff.includes('"authToken": "[redacted]"')
        && !handoff.includes('Original API provider setting:')
        && !handoff.includes('Excluded API models:')
        && !handoff.includes('"thinking"')
        && !handoff.includes('provider-native-format-sentinel')
        && !handoff.includes('"outputConfig"')
        && !handoff.includes('"structuredOutput"')
        && !handoff.includes('"effort"')
        && !handoff.includes('nativeProviderSchema')
        && !handoff.includes('must-not-leak'),
      'the handoff retains useful request context while omitting model-specific execution controls and secrets');
      assert(!handoff.includes('/tmp/resume.pdf')
        && !handoff.includes('Attachments required:')
        && !handoff.includes('Attach this local file')
        && handoff.includes(JSON.stringify(schema, null, 2))
        && handoff.includes('--- REQUIRED RESPONSE FORMAT ---')
        && handoff.includes('exactly one fenced JSON code block labelled `json`')
        && handoff.includes('Inside the block, return only valid JSON matching this schema:')
        && !handoff.includes('Do not use Markdown code fences'),
      'attachment instructions stay outside the copyable prompt while the exact structured-output contract remains');
      // Two silent-corruption defences from observed structured handoffs. The
      // chat returned ~10 unrequested properties (billed against the stated
      // output cap, which is what truncates a long reply on a transport with no
      // cap-raise retry), and both a bare filename and a citation to an
      // automatically-created paste attachment rendered as cards that copy
      // back as empty strings. A card appended to existing text leaves no trace
      // for a validator; job scoring separately rejects contractually-required
      // evidence fields when the entire value becomes blank.
      assert(handoff.includes('Emit exactly the properties named in the schema, at every nesting level, and nothing else.')
        && handoff.includes('they spend the output budget above')
        && handoff.includes('automatic paste attachment')
        && handoff.includes('treat that attachment only as input')
        && handoff.includes('Never cite, name, link to, or otherwise reference the file that contains the prompt')
        && handoff.includes('Do not place file attachments or file cards')
        && handoff.includes('schema requires an http(s) URL')
        && handoff.includes('ordinary literal JSON string rather than a rich link')
        && handoff.includes('normally add a citation to the file containing this prompt, omit it')
        && handoff.includes('STRICT JSON SERIALIZATION CHECK')
        && handoff.includes('Never emit placeholder syntax such as value1 | value2, comments, ellipses, or type annotations')
        && handoff.includes('JSON-escape embedded double quotes, backslashes, tabs, carriage returns, and line breaks')
        && handoff.includes('every object member and array item has the required comma')
        && handoff.includes('strict JSON.parse-equivalent check')
        && handoff.includes('never omit required rows, evidence, source facts, or document text')
        && handoff.includes('Always finish and close the JSON')
        && handoff.lastIndexOf('STRICT JSON SERIALIZATION CHECK') > handoff.indexOf(JSON.stringify(schema, null, 2)),
      'the structured contract isolates the exact schema in a copyable code block and forbids chat-UI widgets that do not survive a plain-text copy');
      return { chars: handoff.length };
    },
  },
  {
    name: 'non-API AI: JSON-only response rules appear only when the task actually has a response schema',
    run: () => {
      // A free-text handoff has no JSON contract to constrain, so none of the
      // structured rules may leak into it. The plain-text-copy warning rides
      // inside the REQUIRED RESPONSE FORMAT block for that reason: it is worded
      // as a rule about JSON values, not about prose answers.
      const freeText = materializeNonApiPrompt({
        prompt: 'SUMMARIZE THIS',
        task: 'job-compensation-research',
        maxOutputTokens: 2048,
        requestKind: 'text',
      });
      assert(freeText.includes('Expected response format: free text')
        && !freeText.includes('--- REQUIRED RESPONSE FORMAT ---')
        && !freeText.includes('Emit exactly the properties named in the schema')
        && !freeText.includes('fenced JSON code block')
        && !freeText.includes('STRICT JSON SERIALIZATION CHECK')
        && !freeText.includes('no file attachments or file cards'),
      'a schema-less handoff carries no structured-output rules');

      const structured = materializeNonApiPrompt({
        prompt: 'EXTRACT THIS',
        task: 'resume-parse',
        maxOutputTokens: 4096,
        requestKind: 'structured-text',
        responseSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
      });
      assert(structured.includes('Expected response format: JSON')
        && structured.includes('Emit exactly the properties named in the schema')
        && structured.includes('exactly one fenced JSON code block labelled `json`')
        && structured.includes('automatic paste attachment')
        && structured.includes('Do not place file attachments or file cards')
        && structured.includes('schema requires an http(s) URL')
        && structured.includes('STRICT JSON SERIALIZATION CHECK'),
      'a schema-bearing handoff carries both rules');
      return { freeText: freeText.length, structured: structured.length };
    },
  },
  {
    name: 'non-API AI: displayed task prompts replace legacy pseudo-JSON without changing durable source bytes',
    run: () => {
      const visionSource = `Inspect the images.\n\nReturn a JSON object:\n{\n  "condition": "New | Used"\n}\n\nBe specific about what you can clearly see.`;
      const scoringSource = `Score these jobs.\n\nReturn JSON of the form { "scores": [ ... one object per job in the array I send next ... ] }:\n{\n  "priority": "required|important|preferred|contextual"\n}\n\nIMPORTANT SCORING RULES:\nUse evidence.`;
      const querySource = `Build searches.\n\nReturn a JSON object with four arrays of search query strings:\n\n{\n  "canonicalLocation": {} // STRUCTURED, per the rules above\n}\n\nBe creative with suggestedRoleQueries while remaining relevant.`;
      const fitSource = `Assess platforms.\n\nReturn a JSON object with one entry per platform id. The "reason" field is REQUIRED for unfit verdicts.\n{\n  "fit": "good" | "unfit"\n}\n\nNotes:\nUse exact ids.`;
      const statusSource = `Scan the hub.\n\nReturn ONLY a JSON object:\n{\n  "attention": [ // zero or more; return an empty array\n    { "urgency": "high" | "low" }\n  ]\n}\n\nRules:\nUse source URLs.`;
      const priceSource = '- match_quality: one of "strong" | "moderate" | "weak" — use exactly one of those three string values';

      const hardened = [
        hardenStructuredTaskPrompt('vision-product-analysis', visionSource),
        hardenStructuredTaskPrompt('job-scoring', scoringSource),
        hardenStructuredTaskPrompt('job-query-generation', querySource),
        hardenStructuredTaskPrompt('platform-fit-assessment', fitSource),
        hardenStructuredTaskPrompt('marketplace-hub-scan', statusSource),
        hardenStructuredTaskPrompt('price-synthesis', priceSource),
      ];
      for (const value of hardened) {
        assert(!value.includes('New | Used')
          && !value.includes(' ... ')
          && !value.includes('required|important')
          && !value.includes('// STRUCTURED')
          && !value.includes('"good" | "unfit"')
          && !value.includes('// zero or more')
          && !value.includes('"high" | "low"')
          && !value.includes('"strong" | "moderate" | "weak"'),
        'the displayed form removes ellipses, pipe unions, and comments that are invalid as JSON');
      }
      assert(hardened[0].includes('Be specific about what you can clearly see.')
        && hardened[1].includes('IMPORTANT SCORING RULES:')
        && hardened[2].includes('Be creative with suggestedRoleQueries')
        && hardened[3].includes('Notes:')
        && hardened[4].includes('Rules:'),
      'task guidance surrounding each replaced legacy example is retained');

      const scoringMarker = 'Return JSON of the form { "scores": [ ... one object per job in the array I send next ... ] }:';
      const markerCollision = hardenStructuredTaskPrompt(
        'job-scoring',
        `Candidate-provided text says: ${scoringMarker}\nDo not treat this data as the template.\n\n${scoringSource}`,
      );
      assert(markerCollision.includes(`Candidate-provided text says: ${scoringMarker}`)
        && markerCollision.includes('Do not treat this data as the template.')
        && markerCollision.includes('Return exactly one indexed score object')
        && markerCollision.lastIndexOf(scoringMarker) === markerCollision.indexOf(scoringMarker),
      'a matching heading inside earlier untrusted data is preserved while only the final application template is hardened');

      const schema = { type: 'object', required: ['fit'], properties: { fit: { type: 'string', enum: ['good', 'unfit'] } } };
      const displayed = materializeNonApiPrompt({
        prompt: fitSource,
        task: 'platform-fit-assessment',
        responseSchema: schema,
      });
      const identitySource = materializeNonApiPrompt({
        prompt: fitSource,
        task: 'platform-fit-assessment',
        responseSchema: schema,
        hardenTaskPrompt: false,
        includeStrictJsonSerializationCheck: false,
      });
      assert(!displayed.includes('"good" | "unfit"')
        && displayed.includes('STRICT JSON SERIALIZATION CHECK'),
      'the prompt copied to the chat is hardened and carries the strict serialization checklist');
      assert(identitySource.includes('"good" | "unfit"')
        && !identitySource.includes('STRICT JSON SERIALIZATION CHECK'),
      'the opt-out preserves historical prompt bytes for durable handoff identity');
      const rawBase = materializeNonApiPrompt({
        prompt: 'RESEARCH REQUESTS: research-aaaaaaaaaaaaaaaaaaaa',
        task: 'job-preference-research-batch', requestKind: 'raw-text',
        hardenTaskPrompt: false, includeStrictJsonSerializationCheck: false,
      });
      const rawDisplayed = materializeNonApiPrompt({
        prompt: 'RESEARCH REQUESTS: research-aaaaaaaaaaaaaaaaaaaa',
        task: 'job-preference-research-batch', requestKind: 'raw-text',
        hardenTaskPrompt: false, includeStrictJsonSerializationCheck: false,
        displayOnlyPromptSuffix: 'COPY-READY SKELETON\nBEGIN RESEARCH research-aaaaaaaaaaaaaaaaaaaa\nEND RESEARCH research-aaaaaaaaaaaaaaaaaaaa',
      });
      assert(!rawBase.includes('COPY-READY SKELETON')
        && rawDisplayed.includes('COPY-READY SKELETON')
        && rawDisplayed.includes('BEGIN RESEARCH research-aaaaaaaaaaaaaaaaaaaa'),
      'an actual-ID response skeleton is display-only: callers omit it from durable base materialization and append it only to the copied prompt');
      return { auditedPromptTypes: hardened.length };
    },
  },
  {
    name: 'non-API AI: display-only raw suffix reaches the copied prompt without entering durable base material',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const sent = [];
      const sender = {
        id: 718, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      const source = 'RESEARCH REQUESTS: research-aaaaaaaaaaaaaaaaaaaa';
      const suffix = 'COPY-READY RESEARCH OUTPUT SKELETON\nBEGIN RESEARCH research-aaaaaaaaaaaaaaaaaaaa\nEND RESEARCH research-aaaaaaaaaaaaaaaaaaaa';
      const durableBase = materializeNonApiPrompt({
        prompt: source, task: 'job-preference-research-batch', requestKind: 'raw-text',
        hardenTaskPrompt: false, includeStrictJsonSerializationCheck: false,
      });
      const durableBaseAgain = materializeNonApiPrompt({
        prompt: source, task: 'job-preference-research-batch', requestKind: 'raw-text',
        hardenTaskPrompt: false, includeStrictJsonSerializationCheck: false,
      });
      const expectedStepKey = __durableStepKeysForTests({
        materializedPrompt: durableBase,
        task: 'job-preference-research-batch',
        nodeId: 'display-suffix-node',
        attachmentPaths: [],
      }).logicalKey;
      handleSafe('non-api-display-suffix-test', async (_event, _args, signal) => ({
        result: await requestNonApiAi({
          prompt: source, task: 'job-preference-research-batch', requestKind: 'raw-text',
          displayOnlyPromptSuffix: suffix, signal,
        }),
      }));
      // This test deliberately inspects the freshly materialized final prompt;
      // a failed prior test process can leave a durable pending handoff behind,
      // so do not let that old row become this test's input on the next run.
      const run = ipcMain.__getInvokeHandler('non-api-display-suffix-test')({ sender }, { nodeId: 'display-suffix-node', manualAiRunId: `display-suffix-run-${Date.now()}` });
      for (let attempt = 0; attempt < 100 && !sent.some(item => item.channel === 'non-api-ai-request'); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const request = sent.filter(item => item.channel === 'non-api-ai-request').at(-1)?.payload;
      assert(durableBase === durableBaseAgain
        && !durableBase.includes('COPY-READY RESEARCH OUTPUT SKELETON')
        && request?.prompt.includes(suffix)
        && request?.stepKey === expectedStepKey,
      'the suffix is absent from the stable base material used for durable identity, does not change its exact durable key, and is present only in the final copyable prompt');
      await ipcMain.__getInvokeHandler('cancel-non-api-ai-request')({ sender }, { requestId: request.requestId });
      await run;
      return { displayOnly: true };
    },
  },
  {
    name: 'non-API AI: scoring batches stay stable and a complete taxonomy plan avoids a redundant handoff',
    run: async () => {
      const jobsSource = readFileSync(new URL('../../electron/ipc/jobs.js', import.meta.url), 'utf8');
      const scoringStart = jobsSource.indexOf('const scoreBatch = async');
      const scoringEnd = jobsSource.indexOf('\n    // Live per-batch scoring progress', scoringStart);
      const scoring = jobsSource.slice(scoringStart, scoringEnd);
      assert(scoring.includes('batch: context.topLevelBatch') && scoring.includes('batchTotal: scoringBatches.length'),
        'every manual scoring attempt, including a split/recovery child, keeps its original top-level batch identity');
      assert(jobsSource.includes('classifier chunk(s)')
        && jobsSource.includes('awaiting the global plan to determine whether classifier work is needed')
        && jobsSource.includes('assigned by the bounded plan — no classifier handoff needed'),
      'taxonomy progress labels 0/0 as classifier work and distinguishes plan-pending from planner-only completion');

      const hints = [];
      let activeClassifications = 0;
      let peakClassifications = 0;
      const taxonomyMeta = {};
      await runBoundedJobTaxonomy(Array.from({ length: 25 }, (_, index) => ({ title: `Role ${index}`, salary: '$100k', careerDirection: 'Engineering' })), {
        meta: taxonomyMeta,
        callText: async (_prompt, options) => {
          if (options.task === 'job-taxonomy-plan') {
            options.meta.model = 'plan-model';
            options.meta.fallback = { stage: 'plan', attempts: 1, counts: { rate_limit: 1 } };
            return {
              salaryRanges: [
                { label: '$150k+/yr', minSalary: 150000, maxSalary: 0 },
                { label: '$100k–$150k/yr', minSalary: 100000, maxSalary: 150000 },
                { label: 'Unspecified', minSalary: 0, maxSalary: 0 },
              ],
              roleFamilies: ['Engineering', 'Other'],
              directionRoleIndexes: [{ direction: 'Engineering', roleIndex: 0 }],
            };
          }
          hints.push(options.hints);
          activeClassifications += 1;
          peakClassifications = Math.max(peakClassifications, activeClassifications);
          options.meta.model = `classifier-${options.hints.batch}`;
          options.meta.fallback = { stage: `classifier-${options.hints.batch}`, attempts: 1, counts: { rate_limit: options.hints.batch } };
          if (options.hints.batch === 1) await new Promise(resolve => setTimeout(resolve, 10));
          activeClassifications -= 1;
          return { roleByIndex: Array.from({ length: options.hints.itemCount }, () => 0) };
        },
      });
      assert(hints.length === 0 && peakClassifications === 0,
        'a complete bounded planner mapping assigns every repeated direction without asking the user for a redundant classification paste');
      assert(JSON.stringify(taxonomyMeta.models) === JSON.stringify(['plan-model'])
        && taxonomyMeta.model === 'plan-model'
        && JSON.stringify(taxonomyMeta.fallbacks?.map(fallback => fallback.stage)) === JSON.stringify(['plan'])
        && taxonomyMeta.fallback?.stage === 'plan',
      'planner-only completion preserves its model diagnostics without fabricating a classifier stage');
      assert(jobsSource.includes("from '../../src/utils/handoffScheduler.js';")
        && jobsSource.includes('await mapAutomaticHandoffs(scoringBatches, HANDOFF_CONCURRENCY, async (batch, batchIndex) =>')
        && jobsSource.includes('completedScoringJobCount')
        && jobsSource.includes('scored: signal?.aborted ? completedScoringJobCount : scoredJobs.length'),
      'scoring uses the centralized automatic rolling scheduler, preserves separate completion progress, and reports completed work on abort without saving partial results');
      return { scoringStable: true, taxonomyBatches: hints.length, peakClassifications };
    },
  },
  {
    name: 'non-API AI: attachment metadata stays outside the prompt and Finder reveal is request-bound',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const attachmentPath = `/tmp/infinite-canvas-non-api-attachment-${process.pid}.md`;
      fs.writeFileSync(attachmentPath, '# Career evidence\n', 'utf8');
      const sent = [];
      const sender = {
        id: 706, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      const foreignSender = { ...sender, id: 707 };
      handleSafe('non-api-attachment-test', async (_event, _args, signal) => ({
        result: await requestNonApiAi({
          prompt: 'Extract career evidence.',
          task: 'career-file-extract',
          responseSchema: {
            type: 'object', required: ['text'], properties: { text: { type: 'string' } },
          },
          attachmentPaths: [attachmentPath, attachmentPath, ''],
          requestKind: 'structured-document',
          signal,
        }),
      }));

      try {
        const run = ipcMain.__getInvokeHandler('non-api-attachment-test');
        const pending = run({ sender }, { nodeId: 'node-attachment-test' });
        await new Promise(resolve => setImmediate(resolve));
        const request = sent.find(item => item.channel === 'non-api-ai-request')?.payload;
        assert(request?.attachments?.length === 1
          && request.attachments[0] === attachmentPath
          && !request.prompt.includes(attachmentPath)
          && !request.prompt.includes('Attachments required:'),
        'the renderer receives one deduplicated attachment path beside, never inside, its copyable prompt');

        const reveal = ipcMain.__getInvokeHandler('reveal-non-api-ai-attachment');
        const revealed = await reveal({ sender }, { requestId: request.requestId, filePath: attachmentPath });
        let foreignRejected = false;
        try {
          await reveal({ sender: foreignSender }, { requestId: request.requestId, filePath: attachmentPath });
        } catch {
          foreignRejected = true;
        }
        assert(revealed?.revealed === true && foreignRejected,
          'Finder reveal accepts only the originating renderer and an attachment on its pending request');

        const cancel = ipcMain.__getInvokeHandler('cancel-non-api-ai-request');
        await cancel({ sender }, { requestId: request.requestId });
        const result = await pending;
        assert(result.success === false && result.error === 'Manual AI job cancelled',
          'the attachment test handoff settles cleanly after cancellation');
        return { attachments: request.attachments.length, requestBound: true };
      } finally {
        fs.rmSync(attachmentPath, { force: true });
      }
    },
  },
  {
    name: 'non-API AI: structured submission repairs fenced JSON and canonicalizes enums before acceptance',
    run: () => {
      const schema = {
        type: 'object', required: ['condition', 'count'], additionalProperties: false,
        properties: {
          condition: { type: 'string', enum: ['New', 'Used'] },
          count: { type: 'integer', minimum: 1 },
        },
      };
      const value = validateNonApiAiSubmission({
        expectedHandoffCode: null,
        response: 'Here is the requested result:\n```json\n{ "condition": "new", "count": 2, }\n```',
        responseSchema: schema,
        task: 'job-scoring',
      });
      assert(value.condition === 'New' && value.count === 2,
        'a fenced response with a recoverable trailing comma is parsed and enum casing is normalized to the exact schema value');
      return value;
    },
  },
  {
    name: 'non-API AI: ChatGPT content-reference artifacts are removed before structured validation',
    run: () => {
      const schema = {
        type: 'object', required: ['evidence', 'score'], additionalProperties: false,
        properties: {
          evidence: { type: 'string', minLength: 1 },
          score: { type: 'integer', minimum: 1, maximum: 100 },
        },
      };
      const artifact = ':chatgpt-content-reference{index="0"}';
      let validatorRan = false;
      const value = validateNonApiAiSubmission({
        expectedHandoffCode: null,
        // This is the exact auto-inserted token found in the report. Its
        // unescaped quote makes an otherwise-complete JSON response invalid.
        response: `{"evidence":"The job requires seven years. ${artifact}","score":72}`,
        responseSchema: schema,
        task: 'job-preference-evaluation',
        responseValidator: (candidate) => {
          validatorRan = true;
          assert(candidate.score === 72 && candidate.evidence.includes('seven years'),
            'the normal schema-parsed value reaches the task-specific validator');
        },
      });
      assert(validatorRan
        && value.score === 72
        && !value.evidence.includes(':chatgpt-content-reference')
        && !JSON.stringify(value).includes(artifact),
      'the known transport artifact is absent from the accepted value without bypassing schema/domain validation');
      return { validatorRan, evidence: value.evidence };
    },
  },
  {
    name: 'non-API AI: invalid structured retries preserve a field-specific validation error',
    run: () => {
      const schema = {
        type: 'object', required: ['score'], additionalProperties: false,
        properties: { score: { type: 'integer', minimum: 1, maximum: 100 } },
      };
      let failure = null;
      try {
        validateNonApiAiSubmission({ expectedHandoffCode: null, response: '{"score": 101, "leaked": true}', responseSchema: schema, task: 'job-scoring' });
      } catch (error) { failure = error; }
      assert(failure?.code === 'STRUCTURED_OUTPUT_SCHEMA_INVALID'
        && failure.message.includes("task 'job-scoring'")
        && failure.message.includes('$.score')
        && failure.message.includes('$.leaked'),
      'a rejected paste exposes schema paths for correction without resolving the pending request');
      return { code: failure.code };
    },
  },
  {
    name: 'non-API AI: domain semantic validator can reject schema-valid pasted output for retry',
    run: () => {
      const schema = {
        type: 'object', required: ['scores'], additionalProperties: false,
        properties: { scores: { type: 'array', items: { type: 'object' } } },
      };
      let failure = null;
      try {
        validateNonApiAiSubmission({
          expectedHandoffCode: null,
          response: '{"scores":[{"index":7}]}', responseSchema: schema, task: 'job-scoring',
          responseValidator: (value) => {
            if (value.scores[0]?.index !== 0) throw new Error('Score row index must match its requested job index.');
          },
        });
      } catch (error) { failure = error; }
      assert(failure?.message === 'Score row index must match its requested job index.',
        'task-specific invariants run after JSON Schema validation and keep the request pending for a corrected paste');
      return { rejected: true };
    },
  },
  {
    name: 'non-API AI: callLLMVision forwards its image paths as attachments beside a structured-vision handoff',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const sent = [];
      const sender = {
        id: 731, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      const imagePaths = ['/tmp/non-api-vision-front.jpg', '/tmp/non-api-vision-back.jpg'];
      handleSafe('non-api-vision-test', async (_event, _args, signal) => ({
        result: await callLLMVision(imagePaths, 'Describe these product photos.', {
          signal, task: 'vision-product-analysis',
          responseSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
        }),
      }));
      const run = ipcMain.__getInvokeHandler('non-api-vision-test')({ sender }, { nodeId: 'node-vision-test' });
      await new Promise(resolve => setImmediate(resolve));
      const request = sent.find(item => item.channel === 'non-api-ai-request')?.payload;
      assert(request
        && JSON.stringify(request.attachments) === JSON.stringify(imagePaths)
        && request.prompt.includes('Request kind: structured-vision')
        && request.prompt.includes('Task: vision-product-analysis'),
      'callLLMVision hands its image paths through requestNonApiAi as Finder-revealable attachments beside a structured-vision handoff, not inlined in the prompt text');
      await ipcMain.__getInvokeHandler('cancel-non-api-ai-request')({ sender }, { requestId: request.requestId });
      await run;
      return { attachments: request.attachments.length };
    },
  },
  {
    name: 'non-API AI: callLLMDocument forwards a single file as an attachment beside a structured-document handoff',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const sent = [];
      const sender = {
        id: 732, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      const filePath = '/tmp/non-api-document-resume.pdf';
      handleSafe('non-api-document-test', async (_event, _args, signal) => ({
        result: await callLLMDocument(filePath, 'Extract the career profile.', {
          signal, task: 'career-file-extract',
          responseSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
        }),
      }));
      const run = ipcMain.__getInvokeHandler('non-api-document-test')({ sender }, { nodeId: 'node-document-test' });
      await new Promise(resolve => setImmediate(resolve));
      const request = sent.find(item => item.channel === 'non-api-ai-request')?.payload;
      assert(request
        && JSON.stringify(request.attachments) === JSON.stringify([filePath])
        && request.prompt.includes('Request kind: structured-document')
        && request.prompt.includes('Task: career-file-extract'),
      'callLLMDocument hands its single filePath through requestNonApiAi as one Finder-revealable attachment on a structured-document handoff');
      await ipcMain.__getInvokeHandler('cancel-non-api-ai-request')({ sender }, { requestId: request.requestId });
      await run;
      return { attachments: request.attachments.length };
    },
  },
  {
    // FIX regression test: callLLMVision used to have NO sensitive-path gate
    // at all — before every LLM call became a manual handoff, this was
    // enforced implicitly by assertAttachmentPathSafe() inside the deleted
    // callClaudeVision/callGeminiVision provider modules (one check per
    // element of imagePaths, run before any file was touched). A node's
    // imagePaths/filePath is sourced from loaded canvas JSON, so an
    // untrusted/shared canvas pointing a node at ~/.ssh/id_rsa etc. must
    // still be refused — and refused BEFORE the path is ever Finder-revealed
    // to the user as an attachment to paste into their own chat, i.e. before
    // requestNonApiAi dispatches a 'non-api-ai-request' at all.
    name: 'non-API AI: callLLMVision and callLLMDocument refuse a sensitive attachment path before any handoff is requested',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const sent = [];
      const sender = {
        id: 941, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      const visionSchema = { type: 'object', required: ['title'], properties: { title: { type: 'string' } } };

      // The sensitive path is second in the array — the gate must check
      // EVERY element, not just imagePaths[0].
      handleSafe('non-api-vision-sensitive-test', async (_event, _args, signal) => ({
        result: await callLLMVision(
          ['/Users/x/Pictures/product.jpg', '/Users/x/.ssh/id_rsa'],
          'Describe these product photos.',
          { signal, task: 'vision-product-analysis', responseSchema: visionSchema },
        ),
      }));
      // handleSafe never rethrows — a handler's throw comes back as a resolved
      // { success: false, error } payload, so assert on that shape rather
      // than expecting the invoke() promise itself to reject.
      const visionResult = await ipcMain.__getInvokeHandler('non-api-vision-sensitive-test')({ sender }, {});
      assert(visionResult?.success === false
        && visionResult?.error === 'Refusing to read a sensitive system/credential path as an AI attachment: /Users/x/.ssh/id_rsa',
        'callLLMVision throws callLLMDocument\'s exact sensitive-path error, naming the offending (non-first) path');
      assert(!sent.some(item => item.channel === 'non-api-ai-request'),
        'callLLMVision must throw before requestNonApiAi ever Finder-reveals the path or dispatches a handoff prompt');

      // callLLMDocument's own pre-existing gate is the regression baseline —
      // must still behave identically after adding callLLMVision's gate.
      handleSafe('non-api-document-sensitive-test', async (_event, _args, signal) => ({
        result: await callLLMDocument('/Users/x/.aws/credentials', 'Extract the career profile.', {
          signal, task: 'career-file-extract',
          responseSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
        }),
      }));
      const docResult = await ipcMain.__getInvokeHandler('non-api-document-sensitive-test')({ sender }, {});
      assert(docResult?.success === false
        && docResult?.error === 'Refusing to read a sensitive system/credential path as an AI attachment: /Users/x/.aws/credentials',
        'callLLMDocument keeps its own sensitive-path gate unchanged');
      assert(!sent.some(item => item.channel === 'non-api-ai-request'),
        'callLLMDocument must also throw before any handoff is requested');

      // A null/absent imagePaths (no attachments at all) must not crash the
      // gate's loop — only a REAL sensitive path throws. The handoff still
      // proceeds normally in this case, so drive it through to completion
      // (cancel) rather than leaving a dangling pending request.
      handleSafe('non-api-vision-null-paths-test', async (_event, _args, signal) => ({
        result: await callLLMVision(null, 'Describe this.', {
          signal, task: 'vision-product-analysis', responseSchema: visionSchema,
        }),
      }));
      const nullRun = ipcMain.__getInvokeHandler('non-api-vision-null-paths-test')({ sender }, {});
      await new Promise(resolve => setImmediate(resolve));
      const nullRequest = sent.find(item => item.channel === 'non-api-ai-request')?.payload;
      assert(nullRequest && Array.isArray(nullRequest.attachments) && nullRequest.attachments.length === 0,
        'a null imagePaths is guarded by Array.isArray in the gate loop (no crash) and reaches the handoff with zero attachments');
      await ipcMain.__getInvokeHandler('cancel-non-api-ai-request')({ sender }, { requestId: nullRequest.requestId });
      await nullRun;

      return { sensitivePathsRejected: 2 };
    },
  },
  {
    name: 'non-API AI: structured public LLM entry points reject a missing responseSchema, and callLLMRaw stays exempt',
    run: async () => {
      // assertStructuredResponseSchema() is the one shared guard: it must
      // still fire before any handoff is dispatched for every structured
      // entry point, so a caller can never silently get reparsed prose back
      // for what it asked to be schema-validated JSON.
      for (const invoke of [
        () => callLLMText('structured result'),
        () => callLLMVision([], 'structured result'),
        () => callLLMDocument('/tmp/fixture.pdf', 'structured result'),
      ]) {
        let caught = null;
        try { await invoke(); } catch (error) { caught = error; }
        assert(/requires a responseSchema/.test(caught?.message || ''),
          'structured public LLM calls cannot silently fall back to reparsed prose');
      }

      // callLLMRaw is the deliberate exception — prose/HTML/grounded research
      // has no JSON envelope to validate — so it must reach the manual
      // handoff dispatch with no responseSchema instead of throwing.
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const sent = [];
      const sender = {
        id: 911, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      handleSafe('non-api-raw-schema-exempt-test', async (_event, _args, signal) => ({
        result: await callLLMRaw('Prose response, no schema required.', { signal }),
      }));
      const run = ipcMain.__getInvokeHandler('non-api-raw-schema-exempt-test')({ sender }, { nodeId: 'node-raw-exempt' });
      await new Promise(resolve => setImmediate(resolve));
      const request = sent.find(item => item.channel === 'non-api-ai-request')?.payload;
      assert(request && request.prompt.includes('Request kind: raw-text'),
        'callLLMRaw reaches the manual handoff without a responseSchema — it is deliberately exempt from the structured-output guard');
      assert(request.prompt.includes('Retry-on-truncation setting: true'),
        'callLLMRaw keeps the existing default retry-on-truncation prompt setting when no override is supplied');
      await ipcMain.__getInvokeHandler('cancel-non-api-ai-request')({ sender }, { requestId: request.requestId });
      await run;
      return { guardedEntrypoints: 3, exemptEntrypoint: 'callLLMRaw' };
    },
  },
  {
    name: 'non-API AI: callLLMRaw forwards explicit retry policy and its response validator to the manual handoff',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const sent = [];
      const sender = {
        id: 912, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      handleSafe('non-api-raw-validator-thread-test', async (_event, _args, signal) => ({
        result: await callLLMRaw('Return a source-backed research digest.', {
          signal,
          task: 'job-preference-research-batch',
          retryOnTruncation: false,
          displayOnlyPromptSuffix: 'COPY-READY DISPLAY-ONLY RAW SKELETON',
          responseValidator: (value) => {
            if (!String(value).startsWith('validated:')) {
              throw new Error('Raw research digest must start with validated:.');
            }
          },
        }),
      }));
      const run = ipcMain.__getInvokeHandler('non-api-raw-validator-thread-test')({ sender }, { nodeId: 'node-raw-validator-thread' });
      await new Promise(resolve => setImmediate(resolve));
      const submit = ipcMain.__getInvokeHandler('submit-non-api-ai-response');
      const request = sent.find(item => item.channel === 'non-api-ai-request')?.payload;
      assert(request?.prompt.includes('Task: job-preference-research-batch')
        && request.prompt.includes('Request kind: raw-text')
        && request.prompt.includes('Retry-on-truncation setting: false')
        && request.prompt.includes('COPY-READY DISPLAY-ONLY RAW SKELETON'),
      'the raw batch handoff materializes its task, explicit false retry policy, and display-only response scaffold');
      const invalid = await submit({ sender }, {
        requestId: request.requestId,
        response: `Handoff: ${request.handoffCode}\n\nnot yet validated`,
      });
      const correction = sent.filter(item => item.channel === 'non-api-ai-request').at(-1)?.payload;
      assert(invalid.accepted === false
        && invalid.validationErrors?.[0] === 'Raw research digest must start with validated:.'
        && correction?.requestId === request.requestId
        && correction?.isCorrection === true,
      'a raw response validator rejects an invalid research digest and keeps the same handoff open for correction');
      const accepted = await submit({ sender }, {
        requestId: request.requestId,
        response: `Handoff: ${request.handoffCode}\n\nvalidated: source-backed digest`,
      });
      const result = await run;
      assert(accepted.accepted === true
        && result.success === true
        && result.result === 'validated: source-backed digest',
      'a corrected raw response reaches the caller only after the forwarded validator accepts it');
      return { retryOnTruncation: false, validatorForwarded: true };
    },
  },
  {
    name: 'non-API AI: every marketplace and workspace task reaches the manual handoff through callLLMText/callLLMRaw',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const sent = [];
      const sender = {
        id: 733, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      let counter = 0;
      for (const task of MARKETPLACE_AND_WORKSPACE_TASKS) {
        const channel = `non-api-marketplace-test-${counter}`;
        handleSafe(channel, async (_event, _args, signal) => ({
          result: await callLLMText('Return the requested JSON.', {
            signal, task,
            responseSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
          }),
        }));
        const run = ipcMain.__getInvokeHandler(channel)({ sender }, { nodeId: `node-marketplace-${counter}` });
        counter += 1;
        await new Promise(resolve => setImmediate(resolve));
        const request = sent[sent.length - 1]?.payload;
        assert(sent[sent.length - 1]?.channel === 'non-api-ai-request'
          && request?.prompt.includes(`Task: ${task}`)
          && request.prompt.includes('Request kind: structured-text'),
        `'${task}' dispatches through requestNonApiAi with its task id and request kind materialized into the handoff prompt, exactly like every job task`);
        await ipcMain.__getInvokeHandler('cancel-non-api-ai-request')({ sender }, { requestId: request.requestId });
        await run;
      }
      return { tasks: MARKETPLACE_AND_WORKSPACE_TASKS.length };
    },
  },
  {
    name: 'non-API AI: malformed and domain-invalid submissions reissue an actionable correction prompt before settling',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const sent = [];
      const sender = {
        id: 734, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      handleSafe('non-api-validator-thread-test', async (_event, _args, signal) => ({
        result: await callLLMText('Return the requested JSON.', {
          signal, task: 'test-manual-validation',
          responseSchema: { type: 'object', required: ['index'], properties: { index: { type: 'integer' } } },
          displayOnlyPromptSuffix: 'DISPLAY-ONLY STRUCTURED VALIDATION CHECK',
          responseValidator: (value) => {
            if (value.index !== 0) throw new Error('index must be 0 for this single-row request.');
          },
        }),
      }));
      const run = ipcMain.__getInvokeHandler('non-api-validator-thread-test')({ sender }, { nodeId: 'node-validator-thread' });
      await new Promise(resolve => setImmediate(resolve));
      const submit = ipcMain.__getInvokeHandler('submit-non-api-ai-response');
      const request = sent.find(item => item.channel === 'non-api-ai-request')?.payload;
      const malformed = await submit({ sender }, { requestId: request.requestId, response: `{"handoffCode":"${request.handoffCode}","index": "0" missing-comma}` });
      const syntaxCorrection = sent.filter(item => item.channel === 'non-api-ai-request').at(-1)?.payload;
      assert(malformed.accepted === false
        && malformed.validationErrors?.[0]?.includes('AI returned invalid JSON')
        && request.prompt.includes('DISPLAY-ONLY STRUCTURED VALIDATION CHECK')
        && syntaxCorrection?.requestId === request.requestId
        && syntaxCorrection.isCorrection === true
        && syntaxCorrection.prompt.includes('--- CORRECTION REQUIRED ---')
        && syntaxCorrection.prompt.includes('previous answer was not syntactically valid JSON')
        && syntaxCorrection.prompt.includes('Regenerate the entire answer')
        && syntaxCorrection.prompt.includes('JSON-escape every quote, backslash, or line break'),
      'malformed JSON keeps the same request pending and gives the chat a full regeneration prompt instead of only exposing a parser exception');
      const rejected = await submit({ sender }, { requestId: request.requestId, response: `{"handoffCode":"${request.handoffCode}","index": 7}` });
      const semanticCorrection = sent.filter(item => item.channel === 'non-api-ai-request').at(-1)?.payload;
      assert(rejected.accepted === false
        && rejected.validationErrors?.[0] === 'index must be 0 for this single-row request.'
        && semanticCorrection?.isCorrection === true
        && semanticCorrection.prompt.includes('failed the application\'s response checks'),
      'a schema-valid but semantically wrong paste is rejected by the caller-supplied validator before the invoke can settle');
      for (const invalidIndex of [2, 3, 4]) {
        const repeatedRejection = await submit({ sender }, { requestId: request.requestId, response: `{"handoffCode":"${request.handoffCode}","index": ${invalidIndex}}` });
        const repeatedCorrection = sent.filter(item => item.channel === 'non-api-ai-request').at(-1)?.payload;
        assert(repeatedRejection.accepted === false
          && repeatedCorrection?.requestId === request.requestId
          && repeatedCorrection?.isCorrection === true,
        `quality correction ${invalidIndex + 1} keeps the same request available instead of applying a rejection-pass cap`);
      }
      const accepted = await submit({ sender }, { requestId: request.requestId, response: `{"handoffCode":"${request.handoffCode}","index": 0}` });
      const result = await run;
      assert(accepted.accepted === true && result.success === true && result.result?.index === 0,
        'a corrected paste after more than three quality rejections settles the original callLLMText invocation with the validated value');
      return { malformedCorrected: true, qualityCorrections: 5, validated: true };
    },
  },
  {
    name: 'non-API AI: validation details remain in the correction UI but never enter the main-process log',
    run: async () => {
      const transportSource = readFileSync(new URL('../../electron/ipc/nonApiAi.js', import.meta.url), 'utf8');
      const validationLogLines = transportSource.split('\n').filter(line => /Rejected response for task|Ignoring invalid (legacy )?saved response/.test(line));
      assert(validationLogLines.length === 3
        && validationLogLines.every(line => line.includes('nonApiAiLogErrorCode(error)') && !line.includes('error?.message')),
      'all live and durable structured-response validation logs use only a fixed safe error code');

      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const sent = [];
      const sender = {
        id: 735, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      const privateSentinel = 'PRIVATE_VALIDATOR_DETAIL_MUST_NOT_ENTER_MAIN_LOGS';
      let reject = true;
      handleSafe('non-api-private-validation-test', async (_event, _args, signal) => ({
        result: await callLLMText('Return the requested JSON.', {
          signal,
          task: 'test-manual-validation',
          responseSchema: { type: 'object', required: ['index'], properties: { index: { type: 'integer' } } },
          responseValidator: () => {
            if (reject) throw new Error(privateSentinel);
          },
        }),
      }));
      const run = ipcMain.__getInvokeHandler('non-api-private-validation-test')({ sender }, { nodeId: 'node-private-validation' });
      await new Promise(resolve => setImmediate(resolve));
      const request = sent.find(item => item.channel === 'non-api-ai-request')?.payload;
      const submit = ipcMain.__getInvokeHandler('submit-non-api-ai-response');
      const rejected = await submit({ sender }, { requestId: request.requestId, response: `{"handoffCode":"${request.handoffCode}","index":0}` });
      const recentLogs = getRecentLogs();
      assert(rejected.accepted === false
        && rejected.validationErrors?.[0] === privateSentinel
        && recentLogs.some(entry => entry.message.includes("[Non-API AI] Rejected response for task 'test-manual-validation' (code=VALIDATION_FAILED)."))
        && !recentLogs.some(entry => entry.message.includes(privateSentinel)),
      'the renderer retains the precise correction detail while report-visible logs retain only a safe validation classification');
      reject = false;
      const accepted = await submit({ sender }, { requestId: request.requestId, response: `{"handoffCode":"${request.handoffCode}","index":0}` });
      const result = await run;
      assert(accepted.accepted === true && result.success === true,
        'redacting the log does not alter validation retry or successful settlement behavior');
      return { uiDetailPreserved: true, logRedacted: true };
    },
  },
  {
    name: 'non-API AI: compensation extraction cannot settle with missing indexes or invented comparable provenance',
    run: () => {
      let coverageFailure = null;
      try {
        validateCompensationEvidenceSubmission([
          { index: 0, comparableRanges: [], justification: '', sourceLinks: [] },
        ], ['USD', 'USD'], 'https://salary.example.test/source');
      } catch (error) { coverageFailure = error; }
      assert(coverageFailure?.message.includes('received 1/2 rows') && coverageFailure.message.includes('missing indexes: 1'),
        'a schema-valid compensation response must still cover every requested offer index exactly once');

      let provenanceFailure = null;
      try {
        validateCompensationEvidenceSubmission([
          {
            index: 0,
            comparableRanges: [{ min: 100000, max: 120000, currency: 'USD', comparable: true, sourceName: 'Invented', sourceUrl: 'https://invented.example.test/range' }],
            justification: '', sourceLinks: [],
          },
        ], ['USD'], 'https://salary.example.test/source');
      } catch (error) { provenanceFailure = error; }
      assert(provenanceFailure?.message.includes('assessment index 0') && provenanceFailure.message.includes('grounded research'),
        'a pasted comparable range must carry a usable source URL actually present in the preceding research');
      return { coverage: true, provenance: true };
    },
  },
  {
    name: 'non-API AI: experience-band extraction retries partial ladders but accepts an honest no-evidence result',
    run: () => {
      let malformed = null;
      try {
        validateRoleFamilyExperienceBandsSubmission({
          bands: [{ label: 'Early', minYears: 0, maxYears: 2 }],
          sources: [{ name: 'Career framework', url: 'https://career.example.test/framework' }],
        }, 'Software Engineering', 'https://different.example.test/source');
      } catch (error) { malformed = error; }
      assert(malformed?.message.includes('Invalid experience-band response'),
        'a partially grounded ladder remains in the handoff rather than silently failing the compensation cohort');
      const unavailable = validateRoleFamilyExperienceBandsSubmission({ bands: [], sources: [] }, 'Software Engineering', '');
      assert(unavailable.available === false,
        'an explicitly empty answer remains an honest no-evidence outcome, not an impossible regeneration loop');
      return { malformedRejected: true, emptyAccepted: true };
    },
  },
  {
    name: 'non-API AI: raw response remains verbatim and blank response is rejected',
    run: () => {
      const raw = 'Research result with useful prose.\n\nhttps://example.test/source';
      assert(validateNonApiAiSubmission({ expectedHandoffCode: null, response: raw, task: 'job-compensation-research' }) === raw,
        'free-text/grounded responses are returned unchanged rather than forced through JSON parsing');
      let failure = null;
      try { validateNonApiAiSubmission({ expectedHandoffCode: null, response: '  ', task: 'job-compensation-research' }); }
      catch (error) { failure = error; }
      assert(failure?.message === 'Paste a non-empty AI response before submitting.',
        'empty submissions are rejected before a manual request can settle');
      return { rawChars: raw.length };
    },
  },
  {
    name: 'non-API AI: implausible-paste gate catches a non-JSON clipboard mistake before schema validation',
    run: () => {
      const schema = {
        type: 'object', required: ['scores'], additionalProperties: false,
        properties: { scores: { type: 'array', items: { type: 'object' } } },
      };
      let failure = null;
      try {
        validateNonApiAiSubmission({
          expectedHandoffCode: null,
          response: 'Sorry, I no longer have access to that conversation.',
          responseSchema: schema, task: 'job-scoring',
        });
      } catch (error) { failure = error; }
      assert(failure?.message.includes("task 'job-scoring'")
        && failure.message.includes("no '{' or '['")
        && failure.message.includes('wrong clipboard content')
        && failure.message.includes("FULL response")
        && !failure.message.includes('missing required property'),
      'a paste with no JSON delimiters at all is rejected with an actionable clipboard hint instead of the misleading schema-shape complaint');
      return { rejected: true };
    },
  },
  {
    name: 'non-API AI: implausible-paste gate never rejects a genuinely valid response',
    run: () => {
      const schema = {
        type: 'object', required: ['scores'], additionalProperties: false,
        properties: {
          scores: {
            type: 'array',
            items: {
              type: 'object', required: ['index', 'matchScore'], additionalProperties: false,
              properties: { index: { type: 'integer' }, matchScore: { type: 'integer' } },
            },
          },
        },
      };
      const scores = Array.from({ length: 11 }, (_, index) => ({ index, matchScore: 50 + index }));
      const response = JSON.stringify({ scores });
      const value = validateNonApiAiSubmission({ expectedHandoffCode: null, response, responseSchema: schema, task: 'job-scoring' });
      assert(Array.isArray(value.scores) && value.scores.length === 11,
        'a real, fully-populated response clears the delimiter gate and reaches the caller unchanged');
      return { accepted: true, length: response.length };
    },
  },
  {
    name: 'non-API AI: no item-count length heuristic is applied — a short but schema-valid response is always accepted',
    run: () => {
      // itemCount describes the REQUEST, not a promise about the response's
      // shape: an aggregate answer, or a task that legitimately returns few
      // or no rows for many inputs, is short and still fully valid. The gate
      // therefore applies no length floor at all — only the '{'/'[' delimiter
      // check above runs. Prove it with a deliberately sparse reply (one
      // bare integer) against a much larger requested item count; a
      // length-vs-itemCount heuristic would have rejected this.
      const schema = {
        type: 'object', required: ['roleByIndex'], additionalProperties: false,
        properties: { roleByIndex: { type: 'array', items: { type: 'integer', minimum: 0 } } },
      };
      const response = '{"roleByIndex":[0]}';
      const value = validateNonApiAiSubmission({
        expectedHandoffCode: null,
        response, responseSchema: schema, task: 'job-taxonomy-classify', itemCount: 24,
      });
      assert(Array.isArray(value.roleByIndex) && value.roleByIndex.length === 1,
        'a short response that fully satisfies its schema is accepted no matter how much larger the unrelated itemCount hint is');
      return { accepted: true, length: response.length };
    },
  },
  {
    name: 'non-API AI: job prompt preflight is manual and never invokes a provider token counter',
    run: async () => {
      const fit = await checkPromptFits('x'.repeat(250_000), {
        task: 'job-scoring',
        cachedPrefix: 'STATIC PREFIX',
        responseSchema: { type: 'object', properties: {} },
        hints: { itemCount: 5 },
      });
      assert(fit.fits === true && fit.provider === 'non-api-ai' && fit.model === 'non-api-ai'
        && fit.via === 'manual' && fit.contextWindow === Number.MAX_SAFE_INTEGER,
      'job preflight returns the local manual transport contract without resolving credentials or contacting a token-count endpoint');
      return { via: fit.via, tokens: fit.tokens };
    },
  },
  {
    name: 'non-API AI: manual scoring dispatch uses the bounded per-item task formula, not a flat cap',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      // There is no learned/self-calibrating cap left on this transport (that
      // was API-only retry telemetry, now deleted along with the API path).
      // What still matters is that the manual handoff's stated output ceiling
      // is the real per-item job-scoring formula (1600 + itemCount*600), not
      // a stale or flat number, so the human's chat app gets an accurate
      // budget for the actual batch size.
      const sent = [];
      const sender = {
        id: 708, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      handleSafe('non-api-manual-cap-test', async (_event, _args, signal) => ({
        result: await callLLMText('RETURN COMPACT JSON.', {
          signal,
          task: 'job-scoring',
          hints: { itemCount: 22 },
          responseSchema: { type: 'object', required: ['result'], properties: { result: { type: 'string' } } },
        }),
      }));
      const run = ipcMain.__getInvokeHandler('non-api-manual-cap-test')({ sender }, { nodeId: 'manual-cap-node' });
      await new Promise(resolve => setImmediate(resolve));
      const request = sent.find(item => item.channel === 'non-api-ai-request')?.payload;
      assert(request?.itemCount === 22
        && request?.prompt.includes('Maximum output tokens: 14800')
        && request.prompt.includes('Output-cap formula seed: 14800')
        && !request.prompt.includes('Maximum output tokens: 48000'),
      'manual job scoring exposes its 22-item workload and uses the bounded per-item formula, never a flat historical cap');
      await ipcMain.__getInvokeHandler('cancel-non-api-ai-request')({ sender }, { requestId: request.requestId });
      await run;
      return { manualCap: 14800 };
    },
  },
  {
    name: 'non-API AI: Back one step replaces accepted research with the corrected paste',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const sent = [];
      const sender = {
        id: 709, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      handleSafe('non-api-step-back-test', async (_event, _args, signal) => {
        const pair = await runRewindableGroundedHandoff({
          research: ({ initialResponse }) => requestNonApiAi({
            prompt: 'RESEARCH STEP',
            task: 'test-manual-research',
            initialResponse,
            signal,
          }),
          extract: (research, manualHandoff) => requestNonApiAi({
            prompt: `EXTRACTION STEP\n${research}`,
            task: 'test-manual-extraction',
            responseSchema: {
              type: 'object', required: ['answer'], properties: { answer: { type: 'string' } },
            },
            ...manualHandoff,
            signal,
          }),
        });
        return { research: pair.groundedResearch, answer: pair.result.answer };
      });

      const run = ipcMain.__getInvokeHandler('non-api-step-back-test')({ sender }, { nodeId: 'node-step-back-test' });
      await new Promise(resolve => setImmediate(resolve));
      const requests = () => sent.filter(item => item.channel === 'non-api-ai-request').map(item => item.payload);
      const submit = ipcMain.__getInvokeHandler('submit-non-api-ai-response');
      const stepBackRequest = ipcMain.__getInvokeHandler('step-back-non-api-ai-request');
      const firstResearch = requests()[0];
      assert(firstResearch?.prompt.includes('RESEARCH STEP') && firstResearch.canStepBack === false,
        'the first handoff has no imaginary predecessor');
      const unavailable = await stepBackRequest({ sender }, { requestId: firstResearch.requestId });
      assert(unavailable.steppedBack === false,
        'the main process rejects Back when the active handoff has no real preceding step');
      await submit({ sender }, { requestId: firstResearch.requestId, response: `Handoff: ${firstResearch.handoffCode}\n\nWRONG RESEARCH` });
      await new Promise(resolve => setImmediate(resolve));

      const firstExtraction = requests()[1];
      assert(firstExtraction?.canStepBack === true
        && firstExtraction.stepBackLabel === 'Back to research'
        && firstExtraction.prompt.includes('WRONG RESEARCH'),
      'the extraction gate identifies its real preceding research handoff');
      const foreign = await stepBackRequest({ sender: { ...sender, id: 710 } }, { requestId: firstExtraction.requestId });
      assert(foreign.steppedBack === false,
        'a different renderer cannot rewind a sensitive pending handoff');
      const steppedBack = await stepBackRequest({ sender }, { requestId: firstExtraction.requestId });
      await new Promise(resolve => setImmediate(resolve));

      const replacementResearch = requests()[2];
      assert(steppedBack.steppedBack === true
        && replacementResearch?.prompt.includes('RESEARCH STEP')
        && replacementResearch.initialResponse === 'WRONG RESEARCH',
      'Back reissues the previous prompt with the accepted paste restored as an editable draft');
      await submit({ sender }, { requestId: replacementResearch.requestId, response: `Handoff: ${replacementResearch.handoffCode}\n\nCORRECT RESEARCH` });
      await new Promise(resolve => setImmediate(resolve));

      const replacementExtraction = requests()[3];
      assert(replacementExtraction?.prompt.includes('CORRECT RESEARCH')
        && !replacementExtraction.prompt.includes('WRONG RESEARCH'),
      'the downstream prompt is rebuilt from the corrected response, not the already-resolved wrong value');
      await submit({ sender }, { requestId: replacementExtraction.requestId, response: `{"handoffCode":"${replacementExtraction.handoffCode}","answer":"accepted"}` });
      const result = await run;
      assert(result.success === true && result.research === 'CORRECT RESEARCH' && result.answer === 'accepted',
        'the owning operation continues and returns only the corrected research result');
      return { rewound: true, corrected: true };
    },
  },
  {
    name: 'non-API AI: dialog cancellation is sender-owned and aborts the whole node task',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const sent = [];
      const senderA = {
        id: 701, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      const senderB = { ...senderA, id: 702, send: () => {} };
      handleSafe('non-api-cancel-node-test', async (_event, _args, signal) => ({
        result: await callLLMText('Return a result.', {
          signal, task: 'test-manual-replay', cachedPrefix: 'STATIC CACHED RUBRIC', responseSchema: {
            type: 'object', required: ['result'], properties: { result: { type: 'string' } },
          },
        }),
      }));
      const run = ipcMain.__getInvokeHandler('non-api-cancel-node-test')({ sender: senderA }, { nodeId: 'node-cancel-test' });
      await new Promise(resolve => setImmediate(resolve));
      const request = sent.find(item => item.channel === 'non-api-ai-request')?.payload;
      assert(request?.requestId && request.nodeId === 'node-cancel-test', 'the handoff retains node ownership for cancellation');
      const cancel = ipcMain.__getInvokeHandler('cancel-non-api-ai-request');
      const foreign = await cancel({ sender: senderB }, { requestId: request.requestId });
      assert(foreign.cancelled === false, 'a different renderer cannot cancel a sensitive pending request');
      const own = await cancel({ sender: senderA }, { requestId: request.requestId });
      const settled = await run;
      assert(own.cancelled === true && own.nodeCancelled === true
        && settled.success === false && settled.error === 'Manual AI job cancelled'
        && sent.some(item => item.channel === 'non-api-ai-settled' && item.payload?.cancelled),
      'the owner cancellation aborts the registered node task, rejects the handoff, and emits settlement instead of allowing retries');
      return { nodeCancelled: own.nodeCancelled };
    },
  },
  {
    name: 'non-API AI: acknowledged manual-run ids survive cancellation until explicit durable completion',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const sent = [];
      const sender = new EventEmitter();
      sender.id = 711;
      sender.isDestroyed = () => false;
      sender.send = (channel, payload) => sent.push({ channel, payload });
      const foreignSender = new EventEmitter();
      foreignSender.id = 712;
      foreignSender.isDestroyed = () => false;
      foreignSender.send = () => {};
      const runId = `cancel-ack-${process.pid}-${Date.now()}`;
      const nodeId = `cancel-ack-node-${process.pid}`;

      handleSafe('non-api-cancel-ack-ledger-test', async (_event, _args, signal) => ({
        result: await callLLMText('Return a result.', {
          signal, task: 'test-manual-replay', cachedPrefix: 'STATIC CACHED RUBRIC', responseSchema: {
            type: 'object', required: ['result'], properties: { result: { type: 'string' } },
          },
        }),
      }));
      const invocation = ipcMain.__getInvokeHandler('non-api-cancel-ack-ledger-test')(
        { sender },
        { nodeId, manualAiRunId: runId },
      );
      let request = null;
      for (let attempt = 0; attempt < 100 && !request; attempt += 1) {
        request = sent.find(item => item.channel === 'non-api-ai-request')?.payload || null;
        if (!request) await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert(request?.requestId && request.runId === runId,
        'the cancellable dialog exposes the same renderer-owned manual run id registered on its node task');

      const cancellation = await ipcMain.__getInvokeHandler('cancel-non-api-ai-request')(
        { sender },
        { requestId: request.requestId },
      );
      const cancelledInvocation = await invocation;
      assert(cancellation.cancelled === true
        && cancellation.settled === true
        && JSON.stringify(cancellation.manualAiRunIds) === JSON.stringify([runId])
        && cancelledInvocation.success === false,
      'dialog cancellation returns the acknowledged manual run id after its node task has settled');

      const rediscovered = await abortNodeTasksAndWait(nodeId, sender, undefined, 1_000);
      const foreign = await abortNodeTasksAndWait(nodeId, foreignSender, undefined, 1_000);
      assert(rediscovered.abortedCount === 0
        && rediscovered.settled === true
        && JSON.stringify(rediscovered.manualAiRunIds) === JSON.stringify([runId])
        && foreign.manualAiRunIds.length === 0,
      'a reload cancellation rediscovers the retained id after active-task unregister, without crossing renderer ownership');

      const completed = await ipcMain.__getInvokeHandler('complete-non-api-ai-run')(
        { sender },
        { runId },
      );
      const afterCompletion = await abortNodeTasksAndWait(nodeId, sender, undefined, 1_000);
      assert(completed.absent === true
        && afterCompletion.manualAiRunIds.length === 0,
      'only explicit renderer completion releases an acknowledgement, even when dialog cancellation already removed the durable handoff');

      let releaseUncooperative;
      const slowRunId = `${runId}-slow`;
      const slowNodeId = `${nodeId}-slow`;
      handleSafe('non-api-cancel-ack-timeout-test', async () => {
        await new Promise(resolve => { releaseUncooperative = resolve; });
        return { drained: true };
      });
      const slowInvocation = ipcMain.__getInvokeHandler('non-api-cancel-ack-timeout-test')(
        { sender },
        { nodeId: slowNodeId, manualAiRunId: slowRunId },
      );
      const timedOut = await abortNodeTasksAndWait(slowNodeId, sender, undefined, 1);
      const timedOutRetry = await abortNodeTasksAndWait(slowNodeId, sender, undefined, 1);
      assert(timedOut.settled === false
        && timedOutRetry.settled === false
        && JSON.stringify(timedOutRetry.manualAiRunIds) === JSON.stringify([slowRunId]),
      'a bounded cancellation timeout never releases its discovered run id');
      releaseUncooperative();
      await slowInvocation;
      const afterLateSettlement = await abortNodeTasksAndWait(slowNodeId, sender, undefined, 1_000);
      assert(JSON.stringify(afterLateSettlement.manualAiRunIds) === JSON.stringify([slowRunId]),
        'late task settlement unregisters execution without pretending the renderer durably recorded cleanup');
      await ipcMain.__getInvokeHandler('complete-non-api-ai-run')({ sender }, { runId: slowRunId });
      const afterSlowCompletion = await abortNodeTasksAndWait(slowNodeId, sender, undefined, 1_000);
      assert(afterSlowCompletion.manualAiRunIds.length === 0,
        'explicit completion also releases an acknowledgement retained across a cancellation timeout');
      return { rediscovered: 1, timeoutRetained: 1 };
    },
  },
  {
    name: 'non-API AI: an aged pending durable run survives a simulated main-process restart',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const sent = [];
      const sender = new EventEmitter();
      sender.id = 713;
      sender.isDestroyed = () => false;
      sender.send = (channel, payload) => sent.push({ channel, payload });
      const runId = `aged-pending-${process.pid}-${Date.now()}`;
      const nodeId = `aged-pending-node-${process.pid}`;
      handleSafe('non-api-aged-pending-test', async (_event, _args, signal) => ({
        result: await callLLMText('Return a result.', {
          signal,
          task: 'test-manual-replay',
          cachedPrefix: 'STATIC CACHED RUBRIC',
          responseSchema: { type: 'object', required: ['result'], properties: { result: { type: 'string' } } },
        }),
      }));
      const invocation = ipcMain.__getInvokeHandler('non-api-aged-pending-test')(
        { sender }, { nodeId, manualAiRunId: runId },
      );
      let request = null;
      for (let attempt = 0; attempt < 100 && !request; attempt += 1) {
        request = sent.find(item => item.channel === 'non-api-ai-request')?.payload || null;
        if (!request) await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert(request?.requestId && request.runId === runId, 'the pending handoff must have reached durable storage');
      await ipcMain.__getInvokeHandler('flush-non-api-ai-persistence')({ sender });
      const durablePath = `${electronPkg.app.getPath('userData')}/non-api-ai-handoffs.json`;
      const durable = JSON.parse(fs.readFileSync(durablePath, 'utf8'));
      durable.runs[runId].updatedAt = Date.now() - (366 * 24 * 60 * 60 * 1000);
      fs.writeFileSync(durablePath, JSON.stringify(durable));
      await __reloadDurableStateForTests();
      assert(await durableRunHasAnyTask(runId, ['test-manual-replay']),
        'an arbitrarily old pending run must remain recoverable after the next process loads it');
      await ipcMain.__getInvokeHandler('cancel-non-api-ai-request')({ sender }, { requestId: request.requestId });
      await invocation;
      await ipcMain.__getInvokeHandler('complete-non-api-ai-run')({ sender }, { runId });
    },
  },
  {
    name: 'non-API AI: dialog cancellation falls back to only the pending request without a node',
    run: async () => {
      const sent = [];
      const sender = {
        id: 703, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      handleSafe('non-api-cancel-request-test', async (_event, _args, signal) => ({
        result: await callLLMText('Return a result.', {
          signal, task: 'job-scoring', cachedPrefix: 'STATIC CACHED RUBRIC', responseSchema: {
            type: 'object', required: ['result'], properties: { result: { type: 'string' } },
          },
        }),
      }));
      const run = ipcMain.__getInvokeHandler('non-api-cancel-request-test')({ sender }, {});
      await new Promise(resolve => setImmediate(resolve));
      const request = sent.find(item => item.channel === 'non-api-ai-request')?.payload;
      const result = await ipcMain.__getInvokeHandler('cancel-non-api-ai-request')({ sender }, { requestId: request.requestId });
      const settled = await run;
      assert(result.cancelled === true && result.nodeCancelled === false
        && settled.success === false && settled.error === 'Manual AI job cancelled',
      'a request without node ownership still settles and rejects cleanly without touching unrelated work');
      return { nodeCancelled: result.nodeCancelled };
    },
  },
  {
    name: 'non-API AI: a remounted dialog replays only its pending prompts in creation order',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const sent = [];
      const senderA = {
        id: 704, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      const senderB = { ...senderA, id: 705, send: (channel, payload) => sent.push({ channel, payload, sender: 'B' }) };
      handleSafe('non-api-replay-test', async (_event, args, signal) => ({
        result: await callLLMText('Return a result.', {
          signal, task: 'test-manual-replay', cachedPrefix: 'STATIC CACHED RUBRIC', responseSchema: {
            type: 'object', required: ['result'], properties: { result: { type: 'string' } },
          },
          hints: { batch: args.batch, batchTotal: args.batchTotal },
        }),
      }));
      const run = ipcMain.__getInvokeHandler('non-api-replay-test');
      const first = run({ sender: senderA }, { nodeId: 'node-replay-first', batch: 1, batchTotal: 2 });
      const second = run({ sender: senderA }, { nodeId: 'node-replay-second', batch: 2, batchTotal: 2 });
      await new Promise(resolve => setImmediate(resolve));
      const initial = sent.filter(item => item.channel === 'non-api-ai-request').map(item => item.payload);
      assert(initial.length === 2, 'both initial handoff events are emitted before the simulated renderer reload');
      const handoffPrompt = initial[0]?.prompt || '';
      assert(handoffPrompt.includes('STATIC CACHED RUBRIC')
        && handoffPrompt.includes('Handoff configuration (non-secret):')
        && handoffPrompt.includes('"transport":')
        && handoffPrompt.includes('"cachedPrefix":')
        && handoffPrompt.includes('--- REQUIRED RESPONSE FORMAT ---')
        && !handoffPrompt.includes('Original API model setting:')
        && !handoffPrompt.includes('"thinking":')
        && !handoffPrompt.includes('"thinkingConfig":')
        && !handoffPrompt.includes('"effort":')
        && !handoffPrompt.includes('"outputConfig":')
        && !handoffPrompt.includes('"generationConfig":')
        && !handoffPrompt.includes('"modelFallbackPolicy":'),
      'live manual routing keeps provider-independent response requirements while omitting model execution controls');
      // Simulate a same-frame dialog/listener remount having missed its initial
      // events. Its newly-mounted listener calls the sender-owned replay IPC.
      const submit = ipcMain.__getInvokeHandler('submit-non-api-ai-response');
      const rejected = await submit({ sender: senderA }, { requestId: initial[0].requestId, response: `{"handoffCode":"${initial[0].handoffCode}"}` });
      assert(rejected.accepted === false,
        'the first pending request remains open after an invalid response before the simulated dialog remount');
      sent.length = 0;
      const replay = ipcMain.__getInvokeHandler('replay-pending-non-api-ai-requests');
      const foreign = await replay({ sender: senderB });
      assert(foreign.count === 0 && sent.length === 0,
        'another renderer cannot replay a different window\'s sensitive prompt');
      const own = await replay({ sender: senderA });
      const replayed = sent.filter(item => item.channel === 'non-api-ai-request').map(item => item.payload);
      assert(own.count === 2
        && replayed.length === 2
        && replayed[0].requestId === initial[0].requestId
        && replayed[1].requestId === initial[1].requestId
        && replayed[0].batch === 1 && replayed[0].batchTotal === 2
        && replayed[1].batch === 2 && replayed[1].batchTotal === 2
        && typeof replayed[0].validationError === 'string' && replayed[0].validationError.includes('is missing required property')
        && replayed.every(item => item.nodeId === 'node-replay-first' || item.nodeId === 'node-replay-second'),
      'the reconnected renderer receives exactly its pending prompts in original creation order, including retry guidance');
      const cancel = ipcMain.__getInvokeHandler('cancel-non-api-ai-request');
      await cancel({ sender: senderA }, { requestId: replayed[0].requestId });
      await cancel({ sender: senderA }, { requestId: replayed[1].requestId });
      const results = await Promise.all([first, second]);
      assert(results.every(result => result.success === false && result.error === 'Manual AI job cancelled'),
        'replayed test requests settle cleanly when their owner cancels them');
      return { replayed: own.count };
    },
  },
  {
    name: 'non-API AI: accepted steps and the active draft resume under the same workflow id',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const runId = `durable-resume-${process.pid}-${Date.now()}`;
      const schema = {
        type: 'object', required: ['answer'], additionalProperties: false,
        properties: { answer: { type: 'string' } },
      };
      handleSafe('non-api-durable-resume-test', async (_event, _args, signal) => {
        const first = await requestNonApiAi({ prompt: 'DURABLE STEP ONE', task: 'test-manual-durable', responseSchema: schema, batch: 1, batchTotal: 2, itemCount: 1, signal });
        const second = await requestNonApiAi({ prompt: `DURABLE STEP TWO\n${first.answer}`, task: 'test-manual-durable', responseSchema: schema, itemCount: 1, signal });
        return { first: first.answer, second: second.answer };
      });

      const firstSent = [];
      const firstSender = new EventEmitter();
      firstSender.id = 801;
      firstSender.isDestroyed = () => false;
      firstSender.send = (channel, payload) => firstSent.push({ channel, payload });
      const waitForRequestCount = async (sent, count) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const requests = sent.filter(item => item.channel === 'non-api-ai-request');
          if (requests.length >= count) return requests;
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        return sent.filter(item => item.channel === 'non-api-ai-request');
      };
      const invoke = ipcMain.__getInvokeHandler('non-api-durable-resume-test');
      const firstRun = invoke({ sender: firstSender }, { nodeId: 'durable-node', manualAiRunId: runId });
      const submit = ipcMain.__getInvokeHandler('submit-non-api-ai-response');
      const firstRequest = (await waitForRequestCount(firstSent, 1))[0]?.payload;
      assert(typeof firstRequest?.stepKey === 'string' && firstRequest.stepKey.length === 64,
        'a manual-only durable request receives a deterministic pre-handoff-code step key');
      const firstStepKey = firstRequest.stepKey;
      assert(firstRequest?.handoffCode,
        'the current request still receives a handoff code after its durable key is derived');
      await submit({ sender: firstSender }, { requestId: firstRequest.requestId, response: `{"handoffCode":"${firstRequest.handoffCode}","answer":"first accepted"}` });
      const secondRequest = (await waitForRequestCount(firstSent, 2))[1]?.payload;
      assert(secondRequest?.runId === runId && secondRequest?.stepKey,
        'durable requests expose their workflow and deterministic step identity to the renderer');
      await ipcMain.__getInvokeHandler('update-non-api-ai-draft')(
        { sender: firstSender },
        { requestId: secondRequest.requestId, response: '{"answer":"draft survives"}' },
      );
      assert(await durableRunHasAnyTask(runId, ['test-manual-durable'])
        && await durableRunHasAnyTask(runId, ['test-manual-durable'], { batchTotal: 'present' })
        && await durableRunHasAnyTask(runId, ['test-manual-durable'], { batchTotal: 'absent' })
        && !(await durableRunHasAnyTask(runId, ['job-preference-research'])),
      'the read-only compatibility probe sees only its owning live tasks and can distinguish old total-bearing layouts');
      const pendingSummary = await durableRunSettlementSummary(runId);
      assert(pendingSummary.found
        && pendingSummary.accepted === 1
        && pendingSummary.pending === 1
        && pendingSummary.other === 0
        && pendingSummary.acceptedOnly === false,
      'the recovery settlement probe distinguishes a partly accepted workflow from one safe to retire');
      firstSender.emit('did-start-navigation', {}, 'file:///restart.html', false, true);
      const interrupted = await firstRun;
      assert(interrupted.success === false && interrupted.error === 'Renderer navigated',
        'the original process-local continuation is allowed to terminate after its checkpoint is durable');

      const resumedSent = [];
      const resumedSender = new EventEmitter();
      resumedSender.id = 802;
      resumedSender.isDestroyed = () => false;
      resumedSender.send = (channel, payload) => resumedSent.push({ channel, payload });
      const resumedRun = invoke({ sender: resumedSender }, { nodeId: 'durable-node', manualAiRunId: runId });
      const resumedRequests = (await waitForRequestCount(resumedSent, 1)).map(item => item.payload);
      assert(resumedRequests.length === 1
        && resumedRequests[0].prompt.includes('DURABLE STEP TWO')
        && resumedRequests[0].initialResponse === '{"answer":"draft survives"}',
        'restart replays the accepted first step silently and restores the exact unfinished-step draft');
      assert(!resumedRequests.some(request => request.stepKey === firstStepKey),
        'the accepted first response replays without issuing its first handoff again');
      await submit({ sender: resumedSender }, { requestId: resumedRequests[0].requestId, response: `{"handoffCode":"${resumedRequests[0].handoffCode}","answer":"second accepted"}` });
      const completed = await resumedRun;
      assert(completed.success === true
        && completed.first === 'first accepted'
        && completed.second === 'second accepted',
      'the restarted workflow continues from the checkpoint and completes with both accepted values');
      const acceptedSummary = await durableRunSettlementSummary(runId);
      assert(acceptedSummary.found
        && acceptedSummary.accepted === 2
        && acceptedSummary.pending === 0
        && acceptedSummary.other === 0
        && acceptedSummary.acceptedOnly === true,
      'only a fully accepted durable workflow is eligible for exact staged-run reconciliation');
      await ipcMain.__getInvokeHandler('complete-non-api-ai-run')({ sender: resumedSender }, { runId });
      assert(!(await durableRunHasAnyTask(runId, ['test-manual-durable'])),
        'the compatibility probe stops selecting a legacy contract after its durable run is explicitly completed');
      return { resumedAt: 'step-two', draftRestored: true };
    },
  },
  {
    name: 'non-API AI: a ten-handoff window restores every code and draft after restart',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const runId = `durable-ten-wide-${process.pid}-${Date.now()}`;
      const schema = {
        type: 'object', required: ['answer'], additionalProperties: false,
        properties: { answer: { type: 'string' } },
      };
      handleSafe('non-api-durable-ten-wide-test', async (_event, _args, signal) => ({
        rows: await Promise.all(Array.from({ length: 10 }, (_, index) => requestNonApiAi({
          prompt: `DURABLE PARALLEL STEP ${index + 1}`,
          task: 'test-manual-ten-wide',
          batch: index + 1,
          batchTotal: 10,
          itemCount: 1,
          responseSchema: schema,
          signal,
        }))),
      }));
      const waitForRequests = async (sent, count) => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const requests = sent.filter(item => item.channel === 'non-api-ai-request').map(item => item.payload);
          if (requests.length >= count) return requests;
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        return sent.filter(item => item.channel === 'non-api-ai-request').map(item => item.payload);
      };
      const makeSender = (id, sent) => {
        const sender = new EventEmitter();
        sender.id = id;
        sender.isDestroyed = () => false;
        sender.send = (channel, payload) => sent.push({ channel, payload });
        return sender;
      };
      const invoke = ipcMain.__getInvokeHandler('non-api-durable-ten-wide-test');
      const updateDraft = ipcMain.__getInvokeHandler('update-non-api-ai-draft');
      const submit = ipcMain.__getInvokeHandler('submit-non-api-ai-response');

      const firstSent = [];
      const firstSender = makeSender(803, firstSent);
      const firstRun = invoke({ sender: firstSender }, { nodeId: 'durable-ten-node', manualAiRunId: runId });
      const firstRequests = await waitForRequests(firstSent, 10);
      assert(firstRequests.length === 10
        && new Set(firstRequests.map(request => request.handoffCode)).size === 10,
      'one workflow may durably expose ten distinct handoffs at the same time');
      await Promise.all(firstRequests.map(request => updateDraft(
        { sender: firstSender },
        { requestId: request.requestId, response: `draft-${request.batch}` },
      )));
      const originalByBatch = new Map(firstRequests.map(request => [request.batch, request]));
      firstSender.emit('did-start-navigation', {}, 'file:///restart.html', false, true);
      const interrupted = await firstRun;
      assert(interrupted.success === false && interrupted.error === 'Renderer navigated',
        'the ten-wide workflow checkpoints cleanly when its renderer restarts');

      const resumedSent = [];
      const resumedSender = makeSender(804, resumedSent);
      const resumedRun = invoke({ sender: resumedSender }, { nodeId: 'durable-ten-node', manualAiRunId: runId });
      const resumedRequests = await waitForRequests(resumedSent, 10);
      assert(resumedRequests.length === 10 && resumedRequests.every((request) => {
        const original = originalByBatch.get(request.batch);
        return original
          && request.handoffCode === original.handoffCode
          && request.stepKey === original.stepKey
          && request.initialResponse === `draft-${request.batch}`;
      }), 'restart must restore all ten pending identities, codes, and drafts without rotating them three at a time');
      await Promise.all(resumedRequests.map(request => submit(
        { sender: resumedSender },
        { requestId: request.requestId, response: JSON.stringify({ handoffCode: request.handoffCode, answer: `accepted-${request.batch}` }) },
      )));
      const completed = await resumedRun;
      assert(completed.success === true
        && completed.rows.length === 10
        && completed.rows.every((row, index) => row.answer === `accepted-${index + 1}`),
      'the restored ten-wide workflow accepts every exact response and rejoins results in batch order');
      await ipcMain.__getInvokeHandler('complete-non-api-ai-run')({ sender: resumedSender }, { runId });
      return { restored: resumedRequests.length, distinctCodes: new Set(resumedRequests.map(request => request.handoffCode)).size };
    },
  },
  {
    name: 'non-API AI: collision fallback code persists across durable restart',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const runId = `durable-code-collision-${process.pid}-${Date.now()}`;
      const schema = {
        type: 'object', required: ['answer'], additionalProperties: false,
        properties: { answer: { type: 'string' } },
      };
      const waitForRequest = async (sent) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const request = sent.find(item => item.channel === 'non-api-ai-request')?.payload;
          if (request) return request;
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        return sent.find(item => item.channel === 'non-api-ai-request')?.payload;
      };
      handleSafe('non-api-durable-code-collision-holder', async (_event, _args, signal) => (
        requestNonApiAi({ prompt: 'DURABLE COLLISION STEP', task: 'test-manual-collision', responseSchema: schema, signal })
      ));
      handleSafe('non-api-durable-code-collision-target', async (_event, _args, signal) => ({
        answer: (await requestNonApiAi({ prompt: 'DURABLE COLLISION STEP', task: 'test-manual-collision', responseSchema: schema, signal })).answer,
      }));

      const holderSent = [];
      const holderSender = new EventEmitter();
      holderSender.id = 804;
      holderSender.isDestroyed = () => false;
      holderSender.send = (channel, payload) => holderSent.push({ channel, payload });
      const holderRun = ipcMain.__getInvokeHandler('non-api-durable-code-collision-holder')(
        { sender: holderSender }, { nodeId: 'durable-code-node' },
      );
      const holderRequest = await waitForRequest(holderSent);
      assert(holderRequest?.handoffCode, 'the first live request reserves the base code');

      const firstSent = [];
      const firstSender = new EventEmitter();
      firstSender.id = 805;
      firstSender.isDestroyed = () => false;
      firstSender.send = (channel, payload) => firstSent.push({ channel, payload });
      const invokeTarget = ipcMain.__getInvokeHandler('non-api-durable-code-collision-target');
      const firstRun = invokeTarget(
        { sender: firstSender }, { nodeId: 'durable-code-node', manualAiRunId: runId },
      );
      const fallbackRequest = await waitForRequest(firstSent);
      assert(fallbackRequest?.handoffCode && fallbackRequest.handoffCode !== holderRequest.handoffCode,
        'the second live request atomically selects a distinct collision fallback code');
      const submit = ipcMain.__getInvokeHandler('submit-non-api-ai-response');
      await submit({ sender: firstSender }, {
        requestId: fallbackRequest.requestId,
        response: JSON.stringify({ handoffCode: fallbackRequest.handoffCode, answer: 'stored fallback answer' }),
      });
      const firstResult = await firstRun;
      assert(firstResult.success === true && firstResult.answer === 'stored fallback answer',
        'the fallback-stamped response is accepted and checkpointed');

      const cancelled = await ipcMain.__getInvokeHandler('cancel-non-api-ai-request')(
        { sender: holderSender }, { requestId: holderRequest.requestId },
      );
      const holderResult = await holderRun;
      assert(cancelled.cancelled === true && holderResult.success === false,
        'the original base-code holder is removed before restart simulation');

      const resumedSent = [];
      const resumedSender = new EventEmitter();
      resumedSender.id = 806;
      resumedSender.isDestroyed = () => false;
      resumedSender.send = (channel, payload) => resumedSent.push({ channel, payload });
      const resumedResult = await invokeTarget(
        { sender: resumedSender }, { nodeId: 'durable-code-node', manualAiRunId: runId },
      );
      assert(resumedResult.success === true && resumedResult.answer === 'stored fallback answer'
        && !resumedSent.some(item => item.channel === 'non-api-ai-request'),
      'restart reuses the persisted fallback code and consumes its stamped step without a new handoff');
      await ipcMain.__getInvokeHandler('complete-non-api-ai-run')({ sender: resumedSender }, { runId });
      return { fallbackCode: fallbackRequest.handoffCode, resumedWithoutPrompt: true };
    },
  },
  {
    name: 'non-API AI: an accepted legacy structured step replays only through its exact alias',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const runId = `legacy-replay-${process.pid}-${Date.now()}`;
      const legacySchema = {
        type: 'object', required: ['assessments'],
        properties: { assessments: { type: 'array' } },
      };
      const currentSchema = {
        type: 'object', required: ['assessments'],
        properties: { assessments: { type: 'array' } },
      };
      const legacyPrompt = 'EXACT LEGACY LISTING PROMPT';
      const legacyValidator = value => {
        if (!Array.isArray(value?.assessments) || value.assessments[0]?.index !== 0 || Object.hasOwn(value.assessments[0], 'listingId')) {
          throw new Error('legacy response shape required');
        }
      };
      const currentValidator = value => {
        if (value?.assessments?.[0]?.listingId !== 'v2-listing-id') throw new Error('v2 listing ID required');
      };
      handleSafe('legacy-replay-seed', async (_event, _args, signal) => requestNonApiAi({
        prompt: legacyPrompt, task: 'test-manual-legacy-replay', responseSchema: legacySchema,
        responseValidator: legacyValidator, batch: 3, batchTotal: null, itemCount: 1, signal,
      }));
      handleSafe('legacy-replay-current', async (_event, _args, signal) => requestNonApiAi({
        prompt: 'CURRENT V2 LISTING PROMPT', task: 'test-manual-legacy-replay', responseSchema: currentSchema,
        responseValidator: currentValidator,
        // The historical adaptive handoff explicitly carried no total. Its
        // alias must preserve null even when the current request carries an
        // unrelated total, or the accepted durable row is not discoverable.
        legacyReplay: { prompt: legacyPrompt, responseSchema: legacySchema, responseValidator: legacyValidator, batch: 3, batchTotal: null, itemCount: 1 },
        batch: 3, batchTotal: 9, itemCount: 1,
        signal,
      }));
      const sent = [];
      const sender = new EventEmitter();
      sender.id = 807;
      sender.isDestroyed = () => false;
      sender.send = (channel, payload) => sent.push({ channel, payload });
      const seed = ipcMain.__getInvokeHandler('legacy-replay-seed')(
        { sender }, { nodeId: 'legacy-replay-node', manualAiRunId: runId },
      );
      for (let attempt = 0; attempt < 100 && !sent.length; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
      const seedRequest = sent.find(item => item.channel === 'non-api-ai-request')?.payload;
      assert(seedRequest, 'the v1 seed request was issued once');
      await ipcMain.__getInvokeHandler('submit-non-api-ai-response')(
        { sender }, { requestId: seedRequest.requestId, response: JSON.stringify({ handoffCode: seedRequest.handoffCode, assessments: [{ index: 0, matches: [] }] }) },
      );
      const seeded = await seed;
      assert(seeded.success === true, 'the accepted legacy response was checkpointed');
      sent.length = 0;
      const replayed = await ipcMain.__getInvokeHandler('legacy-replay-current')(
        { sender }, { nodeId: 'legacy-replay-node', manualAiRunId: runId },
      );
      assert(replayed.success === true && replayed.assessments?.[0]?.index === 0
        && !Object.hasOwn(replayed.assessments[0], 'listingId')
        && !sent.some(item => item.channel === 'non-api-ai-request'),
      'a current request consumes only the accepted exact v1 alias with its explicit historical null batchTotal, without issuing a legacy-shaped fresh prompt');
      await ipcMain.__getInvokeHandler('complete-non-api-ai-run')({ sender }, { runId });
      return { acceptedLegacyReplayed: true, freshV2PromptNotIssued: true };
    },
  },
  {
    name: 'non-API AI: current and legacy durable replay revalidate domain rules before returning a cached response',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      _resetNonApiAiHandoffLifecycle();
      registerNonApiAiHandlers();
      const schema = {
        type: 'object', required: ['answer'], additionalProperties: false,
        properties: { answer: { type: 'string' } },
      };
      const waitForRequest = async (sent, count = 1) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const requests = sent.filter(item => item.channel === 'non-api-ai-request').map(item => item.payload);
          if (requests.length >= count) return requests.at(-1);
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        return null;
      };
      const sender = new EventEmitter();
      const sent = [];
      sender.id = 810;
      sender.isDestroyed = () => false;
      sender.send = (channel, payload) => sent.push({ channel, payload });
      const submitBridge = (request, response) => submitNonApiAiResponseForBridge({
        requestId: request.requestId,
        handoffCode: request.handoffCode,
        response,
        allowTasks: new Set(['career-profile-compile']),
        allowNodeIds: new Set(['validator-replay-node']),
      });

      const currentRunId = `current-validator-replay-${process.pid}-${Date.now()}`;
      const currentPrompt = 'CURRENT DURABLE VALIDATOR REPLAY';
      handleSafe('current-validator-replay-seed', async (_event, _args, signal) => ({
        value: await callLLMText(currentPrompt, {
          signal, task: 'career-profile-compile', responseSchema: schema,
          responseValidator: () => undefined,
        }),
      }));
      handleSafe('current-validator-replay-resume', async (_event, _args, signal) => ({
        value: await callLLMText(currentPrompt, {
          signal, task: 'career-profile-compile', responseSchema: schema,
          responseValidator: value => {
            if (value?.answer === 'stale') throw new Error('current durable response is domain-invalid');
          },
        }),
      }));
      const seededCurrent = ipcMain.__getInvokeHandler('current-validator-replay-seed')(
        { sender }, { nodeId: 'validator-replay-node', manualAiRunId: currentRunId },
      );
      const currentSeedRequest = await waitForRequest(sent);
      await submitBridge(currentSeedRequest, JSON.stringify({ handoffCode: currentSeedRequest.handoffCode, answer: 'stale' }));
      await seededCurrent;
      sent.length = 0;
      const resumedCurrent = ipcMain.__getInvokeHandler('current-validator-replay-resume')(
        { sender }, { nodeId: 'validator-replay-node', manualAiRunId: currentRunId },
      );
      const currentCorrection = await waitForRequest(sent);
      assert(currentCorrection?.requestId && currentCorrection.isCorrection === false
        && currentCorrection.prompt.includes(currentPrompt)
        && !sent.some(item => item.channel === 'non-api-ai-settled'),
      'a current accepted durable row whose validator now rejects is reissued, never returned as stale output');
      await submitBridge(currentCorrection, JSON.stringify({ handoffCode: currentCorrection.handoffCode, answer: 'fixed' }));
      const currentCompleted = await resumedCurrent;
      assert(currentCompleted.success === true && currentCompleted.value?.answer === 'fixed',
        'the current durable replay completes only after its replacement passes the current domain validator');
      await ipcMain.__getInvokeHandler('complete-non-api-ai-run')({ sender }, { runId: currentRunId });

      const legacyRunId = `legacy-validator-replay-${process.pid}-${Date.now()}`;
      const legacyPrompt = 'LEGACY DURABLE VALIDATOR REPLAY';
      const currentLegacyPrompt = 'CURRENT AFTER LEGACY VALIDATOR REPLAY';
      handleSafe('legacy-validator-replay-seed', async (_event, _args, signal) => ({
        value: await callLLMText(legacyPrompt, {
          signal, task: 'career-profile-compile', responseSchema: schema,
          responseValidator: () => undefined,
        }),
      }));
      handleSafe('legacy-validator-replay-resume', async (_event, _args, signal) => ({
        value: await callLLMText(currentLegacyPrompt, {
          signal, task: 'career-profile-compile', responseSchema: schema,
          responseValidator: value => {
            if (value?.answer !== 'fixed') throw new Error('replacement must satisfy the current contract');
          },
          legacyReplay: {
            prompt: legacyPrompt,
            responseSchema: schema,
            responseValidator: value => {
              if (value?.answer === 'stale') throw new Error('legacy durable response is domain-invalid');
            },
          },
        }),
      }));
      sent.length = 0;
      const seededLegacy = ipcMain.__getInvokeHandler('legacy-validator-replay-seed')(
        { sender }, { nodeId: 'validator-replay-node', manualAiRunId: legacyRunId },
      );
      const legacySeedRequest = await waitForRequest(sent);
      await submitBridge(legacySeedRequest, JSON.stringify({ handoffCode: legacySeedRequest.handoffCode, answer: 'stale' }));
      await seededLegacy;
      sent.length = 0;
      const resumedLegacy = ipcMain.__getInvokeHandler('legacy-validator-replay-resume')(
        { sender }, { nodeId: 'validator-replay-node', manualAiRunId: legacyRunId },
      );
      const legacyReplacement = await waitForRequest(sent);
      assert(legacyReplacement?.requestId && legacyReplacement.prompt.includes(currentLegacyPrompt)
        && !legacyReplacement.prompt.includes(legacyPrompt)
        && !sent.some(item => item.channel === 'non-api-ai-settled'),
      'an invalid accepted legacy alias is not returned and falls through to the current replacement contract');
      await submitBridge(legacyReplacement, JSON.stringify({ handoffCode: legacyReplacement.handoffCode, answer: 'fixed' }));
      const legacyCompleted = await resumedLegacy;
      assert(legacyCompleted.success === true && legacyCompleted.value?.answer === 'fixed',
        'the legacy replay completes only after a response passes a live validator');
      await ipcMain.__getInvokeHandler('complete-non-api-ai-run')({ sender }, { runId: legacyRunId });
      return { currentReissued: true, legacyReissued: true };
    },
  },
  {
    name: 'non-API AI: an exact pending legacy listing alias restores its prompt, code, and draft',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const runId = `legacy-pending-replay-${process.pid}-${Date.now()}`;
      const legacySchema = {
        type: 'object', required: ['assessments'],
        properties: { assessments: { type: 'array' } },
      };
      const currentSchema = {
        type: 'object', required: ['assessments'],
        properties: { assessments: { type: 'array' } },
      };
      const legacyPrompt = 'EXACT PENDING LEGACY LISTING PROMPT';
      const legacyValidator = value => {
        if (!Array.isArray(value?.assessments) || value.assessments[0]?.index !== 0 || Object.hasOwn(value.assessments[0], 'listingId')) {
          throw new Error('legacy response shape required');
        }
      };
      const currentValidator = value => {
        if (value?.assessments?.[0]?.listingId !== 'v2-listing-id') throw new Error('v2 listing ID required');
      };
      handleSafe('legacy-pending-replay-seed', async (_event, _args, signal) => requestNonApiAi({
        prompt: legacyPrompt, task: 'test-manual-legacy-pending', responseSchema: legacySchema,
        responseValidator: legacyValidator, batch: 3, batchTotal: null, itemCount: 1, signal,
      }));
      handleSafe('legacy-pending-replay-current', async (_event, _args, signal) => requestNonApiAi({
        prompt: 'CURRENT V2 LISTING PROMPT MUST NOT REPLACE THE DRAFT', task: 'test-manual-legacy-pending', responseSchema: currentSchema,
        responseValidator: currentValidator,
        legacyReplay: { prompt: legacyPrompt, responseSchema: legacySchema, responseValidator: legacyValidator, batch: 3, batchTotal: null, itemCount: 1 },
        batch: 3, batchTotal: 9, itemCount: 1,
        signal,
      }));
      const waitForRequest = async (sent) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const request = sent.find(item => item.channel === 'non-api-ai-request')?.payload;
          if (request) return request;
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        return sent.find(item => item.channel === 'non-api-ai-request')?.payload;
      };
      const firstSent = [];
      const firstSender = new EventEmitter();
      firstSender.id = 808;
      firstSender.isDestroyed = () => false;
      firstSender.send = (channel, payload) => firstSent.push({ channel, payload });
      const seed = ipcMain.__getInvokeHandler('legacy-pending-replay-seed')(
        { sender: firstSender }, { nodeId: 'legacy-pending-replay-node', manualAiRunId: runId },
      );
      const seedRequest = await waitForRequest(firstSent);
      assert(seedRequest?.handoffCode, 'the pending v1 listing request has a durable code to restore');
      await ipcMain.__getInvokeHandler('update-non-api-ai-draft')(
        { sender: firstSender }, { requestId: seedRequest.requestId, response: '{"assessments":[{"index":0,"matches":[]}]}' },
      );
      firstSender.emit('did-start-navigation', {}, 'file:///restart.html', false, true);
      const interrupted = await seed;
      assert(interrupted.success === false && interrupted.error === 'Renderer navigated',
        'the original pending v1 request is interrupted only after its draft is checkpointed');

      const resumedSent = [];
      const resumedSender = new EventEmitter();
      resumedSender.id = 809;
      resumedSender.isDestroyed = () => false;
      resumedSender.send = (channel, payload) => resumedSent.push({ channel, payload });
      const resumed = ipcMain.__getInvokeHandler('legacy-pending-replay-current')(
        { sender: resumedSender }, { nodeId: 'legacy-pending-replay-node', manualAiRunId: runId },
      );
      const restored = await waitForRequest(resumedSent);
      assert(restored?.prompt.includes(legacyPrompt)
        && !restored.prompt.includes('CURRENT V2 LISTING PROMPT MUST NOT REPLACE THE DRAFT')
        && restored.handoffCode === seedRequest.handoffCode
        && restored.batch === 3 && restored.batchTotal === null && restored.itemCount === 1
        && restored.initialResponse === '{"assessments":[{"index":0,"matches":[]}]}',
      'restart reissues the exact pending V1 listing handoff with its original code and draft, not a V2 replacement');
      await ipcMain.__getInvokeHandler('submit-non-api-ai-response')(
        { sender: resumedSender }, {
          requestId: restored.requestId,
          response: JSON.stringify({ handoffCode: restored.handoffCode, assessments: [{ index: 0, matches: [] }] }),
        },
      );
      const completed = await resumed;
      assert(completed.success === true && completed.assessments?.[0]?.index === 0
        && !Object.hasOwn(completed.assessments[0], 'listingId'),
      'the restored V1 validator accepts its V1 response and completes without issuing a V2 prompt');
      await ipcMain.__getInvokeHandler('complete-non-api-ai-run')({ sender: resumedSender }, { runId });
      return { prompt: 'legacy', draftRestored: true, codeRestored: true };
    },
  },
  {
    name: 'non-API AI: durable keys canonicalize generated boundary nonces without weakening legacy replay',
    run: () => {
      const schema = { type: 'object', required: ['assessments'], properties: { assessments: { type: 'array' } } };
      const firstPrompt = materializeNonApiPrompt({
        prompt: `LISTINGS: ${wrapUntrustedText('job-listings', '[{"title":"Engineer"}]')}`,
        task: 'job-preference-evaluation', responseSchema: schema,
      });
      const secondPrompt = materializeNonApiPrompt({
        prompt: `LISTINGS: ${wrapUntrustedText('job-listings', '[{"title":"Engineer"}]')}`,
        task: 'job-preference-evaluation', responseSchema: schema,
      });
      const keyInput = prompt => ({ materializedPrompt: prompt, task: 'job-preference-evaluation', nodeId: 'nonce-node', batch: 4, batchTotal: 9, itemCount: 1, attachmentPaths: [] });
      const firstKeys = __durableStepKeysForTests(keyInput(firstPrompt));
      const secondKeys = __durableStepKeysForTests(keyInput(secondPrompt));
      const firstTag = firstPrompt.match(/<untrusted-job-listings-[a-f0-9]{8}>/)?.[0];
      const secondTag = secondPrompt.match(/<untrusted-job-listings-[a-f0-9]{8}>/)?.[0];
      assert(firstTag && secondTag && firstTag !== secondTag
        && firstKeys.logicalKey === secondKeys.logicalKey
        && firstKeys.rawKey !== secondKeys.rawKey
        && canonicalizeGeneratedUntrustedBoundaryNonces(firstPrompt) === canonicalizeGeneratedUntrustedBoundaryNonces(secondPrompt),
      'displayed prompts retain distinct random untrusted-boundary tags while their new logical durable key is stable');

      const acceptedRaw = { status: 'accepted', task: 'job-preference-evaluation', batch: 4, batchTotal: 9, itemCount: 1 };
      assert(__selectDurableStepForTests({ [firstKeys.rawKey]: acceptedRaw }, firstKeys)?.step === acceptedRaw,
        'a reconstructable pre-canonical raw accepted key remains reachable before metadata fallback');
      const metadata = { task: 'job-preference-evaluation', batch: 4, batchTotal: 9, itemCount: 1 };
      const nonceChangedLegacySteps = { historical: acceptedRaw };
      assert(__selectDurableStepForTests(nonceChangedLegacySteps, secondKeys) === null
        && __selectUniqueAcceptedLegacyStepForTests(nonceChangedLegacySteps, metadata)?.step === acceptedRaw,
      'a unique accepted legacy step can recover when a changed nonce prevents raw-key reconstruction');
      const ambiguous = {
        first: acceptedRaw,
        second: { ...acceptedRaw },
        pending: { ...acceptedRaw, status: 'pending' },
      };
      assert(__selectUniqueAcceptedLegacyStepForTests(ambiguous, metadata) === null,
        'two accepted metadata matches are ambiguous and are never auto-consumed; pending steps are excluded');
      return { logicalNonceStable: true, rawCompatibility: true, uniqueLegacyFallback: true, ambiguousLegacyBlocked: true };
    },
  },
  {
    name: 'non-API AI: identical document prompts keep attachment-specific durable steps',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const runId = `durable-attachments-${process.pid}-${Date.now()}`;
      const schema = {
        type: 'object', required: ['answer'], additionalProperties: false,
        properties: { answer: { type: 'string' } },
      };
      handleSafe('non-api-durable-attachment-test', async (_event, _args, signal) => {
        const first = await requestNonApiAi({
          prompt: 'IDENTICAL DOCUMENT EXTRACTION PROMPT', task: 'career-file-extract',
          responseSchema: schema, attachmentPaths: ['/tmp/career-file-one.pdf'], signal,
        });
        const second = await requestNonApiAi({
          prompt: 'IDENTICAL DOCUMENT EXTRACTION PROMPT', task: 'career-file-extract',
          responseSchema: schema, attachmentPaths: ['/tmp/career-file-two.pdf'], signal,
        });
        return { first: first.answer, second: second.answer };
      });

      const sent = [];
      const sender = new EventEmitter();
      sender.id = 803;
      sender.isDestroyed = () => false;
      sender.send = (channel, payload) => sent.push({ channel, payload });
      const waitForRequests = async (count) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const requests = sent.filter(item => item.channel === 'non-api-ai-request');
          if (requests.length >= count) return requests.map(item => item.payload);
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        return sent.filter(item => item.channel === 'non-api-ai-request').map(item => item.payload);
      };

      const invoke = ipcMain.__getInvokeHandler('non-api-durable-attachment-test');
      const pending = invoke({ sender }, {
        nodeId: 'durable-attachment-node', runId, manualAiRunId: runId,
        manualAiRecoveryMode: 'append-scored-jobs',
      });
      const submit = ipcMain.__getInvokeHandler('submit-non-api-ai-response');
      const firstRequest = (await waitForRequests(1))[0];
      await submit({ sender }, { requestId: firstRequest.requestId, response: `{"handoffCode":"${firstRequest.handoffCode}","answer":"file one"}` });
      const requests = await waitForRequests(2);
      assert(requests.length === 2
        && requests[0].stepKey !== requests[1].stepKey
        && requests[0].attachments[0] !== requests[1].attachments[0]
        && requests[1].recoveryMode === 'append-scored-jobs',
      'same-prompt document handoffs have distinct opaque identities and retain their workflow recovery mode');
      await submit({ sender }, { requestId: requests[1].requestId, response: `{"handoffCode":"${requests[1].handoffCode}","answer":"file two"}` });
      const completed = await pending;
      assert(completed.success === true && completed.first === 'file one' && completed.second === 'file two',
        'the second attachment receives its own response instead of silently replaying the first file response');
      await ipcMain.__getInvokeHandler('complete-non-api-ai-run')({ sender }, { runId });
      return { attachmentSteps: requests.length, distinct: true };
    },
  },
  {
    name: 'non-API AI: shared display progress counts only durable accepted sibling submissions',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      _resetNonApiAiHandoffLifecycle();
      registerNonApiAiHandlers();
      const sent = [];
      const sender = {
        id: 725, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      const runId = `progress-scope-${process.pid}-${Date.now()}`;
      const schema = {
        type: 'object', required: ['answer'], additionalProperties: false,
        properties: { answer: { type: 'string' } },
      };
      let releaseLate;
      const lateGate = new Promise(resolve => { releaseLate = resolve; });
      const request = (batch, itemsDone, signal, itemCount = 12) => requestNonApiAi({
        prompt: `PROGRESS SCOPE BATCH ${batch}`,
        task: 'test-manual-progress', responseSchema: schema,
        batch, batchTotal: 3, itemCount, itemsDone, itemsTotal: 36, signal,
        progressScopeId: 'preference-pass-a', progressUnitId: `batch-${batch}`, progressUnits: itemCount,
      });
      handleSafe('non-api-progress-scope-test', async (_event, _args, signal) => {
        // Batch 2 deliberately arrives before batch 1: these are planned
        // caller offsets, not evidence that either handoff was submitted.
        const batch2 = request(2, 12, signal);
        const batch1 = request(1, 0, signal);
        await lateGate;
        const batch3 = request(3, 24, signal, 20);
        return { rows: await Promise.all([batch1, batch2, batch3]) };
      });
      const invoke = ipcMain.__getInvokeHandler('non-api-progress-scope-test');
      const submit = ipcMain.__getInvokeHandler('submit-non-api-ai-response');
      const run = invoke({ sender }, { nodeId: 'progress-scope-node', manualAiRunId: runId });
      const waitFor = async predicate => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const requests = sent.filter(item => item.channel === 'non-api-ai-request').map(item => item.payload);
          if (predicate(requests)) return requests;
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        return sent.filter(item => item.channel === 'non-api-ai-request').map(item => item.payload);
      };
      const latestByBatch = requests => new Map(requests.map(item => [item.batch, item]));
      const initial = await waitFor(requests => latestByBatch(requests).size >= 2);
      let latest = latestByBatch(initial);
      const batch1 = latest.get(1);
      const batch2 = latest.get(2);
      assert(batch1?.itemsDone === 0 && batch2?.itemsDone === 0,
        'two pending planned offsets converge on their shared zero baseline before any response is submitted');

      const rejected = await submit({ sender }, {
        requestId: batch1.requestId,
        response: JSON.stringify({ handoffCode: batch1.handoffCode }),
      });
      latest = latestByBatch(sent.filter(item => item.channel === 'non-api-ai-request').map(item => item.payload));
      assert(rejected.accepted === false && latest.get(1)?.itemsDone === 0 && latest.get(2)?.itemsDone === 0,
        'viewing, selecting, copying, and a rejected paste cannot advance display progress');

      // Submit batch 2 first and race a duplicate invocation while its durable
      // accepted checkpoint is in flight. Only one commit may charge 12 items.
      const batch2Answer = JSON.stringify({ handoffCode: batch2.handoffCode, answer: 'batch two' });
      const duplicate = await Promise.all([
        submit({ sender }, { requestId: batch2.requestId, response: batch2Answer }),
        submit({ sender }, { requestId: batch2.requestId, response: batch2Answer }),
      ]);
      latest = latestByBatch(await waitFor(requests => latestByBatch(requests).get(1)?.itemsDone === 12));
      assert(duplicate.filter(result => result.accepted).length === 1 && latest.get(1)?.itemsDone === 12,
        'an out-of-order durable acceptance advances pending siblings once, while a duplicate submit cannot double-count it');

      releaseLate();
      latest = latestByBatch(await waitFor(requests => latestByBatch(requests).has(3)));
      const batch3 = latest.get(3);
      assert(batch3?.itemsDone === 12,
        'a sibling issued after an accepted handoff starts at the current accepted count, not its planned offset');

      const batch3Answer = JSON.stringify({ handoffCode: batch3.handoffCode, answer: 'batch three' });
      await Promise.all([
        submit({ sender }, { requestId: batch3.requestId, response: batch3Answer }),
        submit({ sender }, { requestId: batch3.requestId, response: batch3Answer }),
      ]);
      latest = latestByBatch(await waitFor(requests => latestByBatch(requests).get(1)?.itemsDone === 32));
      assert(latest.get(1)?.itemsDone === 32,
        'each distinct accepted record contributes its own itemCount exactly once, regardless of acceptance order');

      await submit({ sender }, {
        requestId: batch1.requestId,
        response: JSON.stringify({ handoffCode: batch1.handoffCode, answer: 'batch one' }),
      });
      const completed = await run;
      const receipts = getNonApiAiHandoffLifecycle({ windowId: sender.id })
        .filter(receipt => receipt.runId === runId);
      assert(completed.success === true && receipts.length === 3
        && receipts.every(receipt => receipt.outcome === 'accepted' && receipt.itemsDone === 36),
      'accepted lifecycle receipts converge on the capped accepted-submission total rather than their original planned offsets');
      await ipcMain.__getInvokeHandler('complete-non-api-ai-run')({ sender }, { runId });
      return { baseline: 0, acceptedItems: 36, receipts: receipts.length };
    },
  },
  {
    name: 'non-API AI: explicit progress scopes preserve durable holes and isolate recovery passes',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      _resetNonApiAiHandoffLifecycle();
      registerNonApiAiHandlers();
      const sent = [];
      const sender = {
        id: 726, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      const runId = `progress-durable-hole-${process.pid}-${Date.now()}`;
      const schema = {
        type: 'object', required: ['answer'], additionalProperties: false,
        properties: { answer: { type: 'string' } },
      };
      const handoff = (prompt, {
        scope = 'pass-a', unit, units = 12, itemCount = units, itemsDone, batch, measureProgressUnits,
      }, signal) => requestNonApiAi({
        prompt, task: 'test-manual-progress', responseSchema: schema,
        batch, batchTotal: 3, itemCount, itemsDone, itemsTotal: 36,
        progressScopeId: scope, progressUnitId: unit, progressUnits: units, measureProgressUnits, signal,
      });
      const waitFor = async predicate => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const requests = sent.filter(item => item.channel === 'non-api-ai-request').map(item => item.payload);
          if (predicate(requests)) return requests;
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        return sent.filter(item => item.channel === 'non-api-ai-request').map(item => item.payload);
      };

      handleSafe('non-api-progress-durable-seed', async (_event, _args, signal) => ({
        result: await handoff('PROGRESS DURABLE UNIT TWO', { unit: 'unit-2', units: 12, itemCount: 5, itemsDone: 12, batch: 2 }, signal),
      }));
      const seed = ipcMain.__getInvokeHandler('non-api-progress-durable-seed')(
        { sender }, { nodeId: 'progress-durable-node', manualAiRunId: runId },
      );
      const submit = ipcMain.__getInvokeHandler('submit-non-api-ai-response');
      const seedRequest = (await waitFor(requests => requests.length >= 1)).at(-1);
      await submit({ sender }, {
        requestId: seedRequest.requestId,
        response: JSON.stringify({ handoffCode: seedRequest.handoffCode, answer: 'durably accepted' }),
      });
      await seed;

      // Simulate a fresh main process: durable accepted rows remain, whereas
      // display-only coordinator state does not. The resumed call must rebuild
      // that accepted hole before its still-pending siblings are displayed.
      _resetNonApiAiHandoffLifecycle();
      sent.length = 0;
      handleSafe('non-api-progress-durable-resume', async (_event, _args, signal) => {
        const replayed = await handoff('PROGRESS DURABLE UNIT TWO', { unit: 'unit-2', units: 12, itemCount: 5, itemsDone: 12, batch: 2 }, signal);
        const lowerBaseline = handoff('PROGRESS LOWER BASELINE', {
          unit: 'unit-1', itemsDone: 0, batch: 1, measureProgressUnits: () => 5,
        }, signal);
        const partialRecovery = handoff('PROGRESS RECOVERY FOR UNIT ONE', {
          unit: 'unit-1', itemsDone: 24, batch: 1, measureProgressUnits: () => 7,
        }, signal);
        const isolatedPass = handoff('PROGRESS ISOLATED PASS', { scope: 'pass-b', unit: 'unit-1', itemsDone: 0, batch: 1 }, signal);
        return { replayed, rows: await Promise.all([lowerBaseline, partialRecovery, isolatedPass]) };
      });
      const resumed = ipcMain.__getInvokeHandler('non-api-progress-durable-resume')(
        { sender }, { nodeId: 'progress-durable-node', manualAiRunId: runId },
      );
      const resumedRequests = await waitFor(requests => requests.length >= 3);
      const lower = resumedRequests.find(request => request.prompt.includes('PROGRESS LOWER BASELINE'));
      const recovery = resumedRequests.find(request => request.prompt.includes('PROGRESS RECOVERY FOR UNIT ONE'));
      const isolated = resumedRequests.find(request => request.prompt.includes('PROGRESS ISOLATED PASS'));
      assert(lower?.itemsDone === 5 && recovery?.itemsDone === 5 && isolated?.itemsDone === 0,
        'a durable accepted hole replays its five-item split contribution (not its 12-item unit cap); a later lower baseline preserves it, while a distinct scope starts independently');

      await submit({ sender }, {
        requestId: recovery.requestId,
        response: JSON.stringify({ handoffCode: recovery.handoffCode, answer: 'partial recovery' }),
      });
      const afterRecovery = (await waitFor(requests => requests.some(request => request.requestId === lower.requestId)))
        .filter(request => request.requestId === lower.requestId).at(-1);
      assert(afterRecovery?.itemsDone === 12,
        'a partial/recovery handoff contributes only its measured rows to the shared logical-unit cap, instead of charging the root unit again');

      await submit({ sender }, {
        requestId: lower.requestId,
        response: JSON.stringify({ handoffCode: lower.handoffCode, answer: 'lower unit' }),
      });
      await submit({ sender }, {
        requestId: isolated.requestId,
        response: JSON.stringify({ handoffCode: isolated.handoffCode, answer: 'isolated unit' }),
      });
      const completed = await resumed;
      const receipts = getNonApiAiHandoffLifecycle({ windowId: sender.id })
        .filter(receipt => receipt.runId === runId);
      assert(completed.success === true && receipts.length === 3
        && receipts.filter(receipt => receipt.task === 'test-manual-progress').every(receipt => receipt.itemsDone === 17 || receipt.itemsDone === 12),
      'resumed lifecycle receipts reflect capped per-step contributions, without cross-pass or recovery overcounting');
      await ipcMain.__getInvokeHandler('complete-non-api-ai-run')({ sender }, { runId });
      return { durableHole: true, recoveryDeduped: true, isolatedPass: true };
    },
  },
  {
    name: 'non-API AI: attempt-local abort preserves scoped sibling progress',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      _resetNonApiAiHandoffLifecycle();
      registerNonApiAiHandlers();
      const sent = [];
      const sender = {
        id: 728, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      const runId = `progress-attempt-abort-${process.pid}-${Date.now()}`;
      const schema = {
        type: 'object', required: ['answer'], additionalProperties: false,
        properties: { answer: { type: 'string' } },
      };
      let abortFirst;
      let releaseThird;
      const thirdGate = new Promise(resolve => { releaseThird = resolve; });
      const handoff = (label, batch, itemsDone, signal) => requestNonApiAi({
        prompt: `PROGRESS ATTEMPT ${label}`, task: 'test-manual-progress', responseSchema: schema,
        batch, batchTotal: 3, itemCount: 12, itemsDone, itemsTotal: 36,
        progressScopeId: 'attempt-pass', progressUnitId: `unit-${batch}`, progressUnits: 12, signal,
      });
      handleSafe('non-api-progress-attempt-abort', async (_event, _args, handlerSignal) => {
        const firstController = new AbortController();
        abortFirst = () => firstController.abort(new Error('Split this attempt'));
        const first = handoff('FIRST', 1, 0, firstController.signal);
        const second = handoff('SECOND', 2, 12, handlerSignal);
        await thirdGate;
        const third = handoff('THIRD', 3, 24, handlerSignal);
        return { results: await Promise.allSettled([first, second, third]) };
      });
      const invoke = ipcMain.__getInvokeHandler('non-api-progress-attempt-abort');
      const run = invoke({ sender }, { nodeId: 'progress-attempt-node', manualAiRunId: runId });
      const waitFor = async predicate => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const requests = sent.filter(item => item.channel === 'non-api-ai-request').map(item => item.payload);
          if (predicate(requests)) return requests;
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        return sent.filter(item => item.channel === 'non-api-ai-request').map(item => item.payload);
      };
      const initial = await waitFor(requests => requests.filter(request => request.prompt.includes('PROGRESS ATTEMPT')).length >= 2);
      const second = initial.find(request => request.prompt.includes('PROGRESS ATTEMPT SECOND'));
      const submit = ipcMain.__getInvokeHandler('submit-non-api-ai-response');
      await submit({ sender }, {
        requestId: second.requestId,
        response: JSON.stringify({ handoffCode: second.handoffCode, answer: 'second' }),
      });
      abortFirst();
      releaseThird();
      const third = (await waitFor(requests => requests.some(request => request.prompt.includes('PROGRESS ATTEMPT THIRD'))))
        .find(request => request.prompt.includes('PROGRESS ATTEMPT THIRD'));
      assert(third?.itemsDone === 12,
        'aborting one attempt leaves its scope alive, so a later sibling inherits the already accepted sibling contribution');
      await submit({ sender }, {
        requestId: third.requestId,
        response: JSON.stringify({ handoffCode: third.handoffCode, answer: 'third' }),
      });
      const completed = await run;
      const secondReceipt = getNonApiAiHandoffLifecycle({ windowId: sender.id })
        .find(receipt => receipt.requestId === second.requestId.slice(0, 12));
      assert(completed.success === true && completed.results[0].status === 'rejected'
        && completed.results[1].status === 'fulfilled' && completed.results[2].status === 'fulfilled'
        && secondReceipt?.itemsDone === 24,
      'the surviving sibling advances normally and its detached lifecycle receipt keeps the shared accepted count after an attempt-local abort');
      await ipcMain.__getInvokeHandler('complete-non-api-ai-run')({ sender }, { runId });
      return { preserved: true };
    },
  },
  {
    name: 'non-API AI: no-run display scopes retire on completion and prune only inactive leftovers',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      _resetNonApiAiHandoffLifecycle();
      registerNonApiAiHandlers();
      const sent = [];
      const sender = {
        id: 729, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      const schema = {
        type: 'object', required: ['answer'], additionalProperties: false,
        properties: { answer: { type: 'string' } },
      };
      const waitFor = async label => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const request = sent.filter(item => item.channel === 'non-api-ai-request')
            .map(item => item.payload).find(item => item.prompt.includes(label));
          if (request) return request;
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        return null;
      };
      const handoff = (label, units, signal) => requestNonApiAi({
        prompt: label, task: 'test-manual-progress', responseSchema: schema,
        batch: 1, batchTotal: 1, itemCount: units, itemsDone: 0, itemsTotal: units,
        progressScopeId: label, progressUnitId: 'unit-1', progressUnits: units, signal,
      });
      handleSafe('non-api-ephemeral-complete', async (_event, _args, signal) => ({
        result: await handoff('EPHEMERAL COMPLETE', 4, signal),
      }));
      const complete = ipcMain.__getInvokeHandler('non-api-ephemeral-complete')({ sender }, { nodeId: 'ephemeral-node' });
      const completeRequest = await waitFor('EPHEMERAL COMPLETE');
      await ipcMain.__getInvokeHandler('submit-non-api-ai-response')({ sender }, {
        requestId: completeRequest.requestId,
        response: JSON.stringify({ handoffCode: completeRequest.handoffCode, answer: 'done' }),
      });
      await complete;
      assert(__nonApiAiProgressScopeSnapshotForTests().inactiveEphemeral === 0,
        'a no-run scope retires immediately after its final accepted lifecycle receipt reaches itemsTotal');

      let abortAttempt;
      handleSafe('non-api-ephemeral-abort', async () => {
        const attempt = new AbortController();
        abortAttempt = () => attempt.abort(new Error('Attempt interrupted'));
        return { settled: await Promise.allSettled([handoff('EPHEMERAL INCOMPLETE', 4, attempt.signal)]) };
      });
      const incomplete = ipcMain.__getInvokeHandler('non-api-ephemeral-abort')({ sender }, { nodeId: 'ephemeral-node' });
      await waitFor('EPHEMERAL INCOMPLETE');
      const future = Date.now() + (31 * 60 * 1000);
      assert(__pruneInactiveEphemeralProgressScopesForTests(future) === 0
        && __nonApiAiProgressScopeSnapshotForTests().activeEphemeral === 1,
      'age pruning never evicts an active no-run handoff');
      abortAttempt();
      await incomplete;
      assert(__nonApiAiProgressScopeSnapshotForTests().inactiveEphemeral === 1
        && __pruneInactiveEphemeralProgressScopesForTests(future) === 1
        && __nonApiAiProgressScopeSnapshotForTests().inactiveEphemeral === 0,
      'an incomplete no-run scope remains available for a conservative gap window, then is pruned once inactive and stale');
      return { ephemeralRetired: true, stalePruned: true };
    },
  },
  {
    name: 'non-API AI: cancellation during an accepted durable write cannot revive progress',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      _resetNonApiAiHandoffLifecycle();
      registerNonApiAiHandlers();
      const sent = [];
      const sender = {
        id: 727, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      const runId = `progress-cancel-write-${process.pid}-${Date.now()}`;
      const schema = {
        type: 'object', required: ['answer'], additionalProperties: false,
        properties: { answer: { type: 'string' } },
      };
      handleSafe('non-api-progress-cancel-write', async (_event, _args, signal) => ({
        result: await requestNonApiAi({
          prompt: 'PROGRESS CANCEL DURING WRITE', task: 'test-manual-progress', responseSchema: schema,
          batch: 1, batchTotal: 1, itemCount: 12, itemsDone: 0, itemsTotal: 12,
          progressScopeId: 'cancel-write-pass', progressUnitId: 'unit-1', progressUnits: 12, signal,
        }),
      }));
      const invoke = ipcMain.__getInvokeHandler('non-api-progress-cancel-write');
      const run = invoke({ sender }, { nodeId: 'progress-cancel-node', manualAiRunId: runId });
      const waitForRequest = async () => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const request = sent.filter(item => item.channel === 'non-api-ai-request').at(-1)?.payload;
          if (request) return request;
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        return null;
      };
      const request = await waitForRequest();
      const originalWriteFile = fs.promises.writeFile;
      let releaseWrite;
      let writeStarted;
      const writeGate = new Promise(resolve => { releaseWrite = resolve; });
      const writeStartedGate = new Promise(resolve => { writeStarted = resolve; });
      let holdAcceptedWrite = true;
      fs.promises.writeFile = async (...args) => {
        if (holdAcceptedWrite && String(args[0]).includes('non-api-ai-handoffs.json')) {
          writeStarted();
          await writeGate;
        }
        return originalWriteFile(...args);
      };
      try {
        const submit = ipcMain.__getInvokeHandler('submit-non-api-ai-response');
        const submitting = submit({ sender }, {
          requestId: request.requestId,
          response: JSON.stringify({ handoffCode: request.handoffCode, answer: 'too late' }),
        });
        await writeStartedGate;
        const cancelling = ipcMain.__getInvokeHandler('cancel-non-api-ai-request')({ sender }, { requestId: request.requestId });
        // abortNodeTasks runs before its durable cleanup barrier, so the
        // request is settled while this accepted write remains intentionally
        // paused. Releasing it exercises the post-await transport guard.
        await new Promise(resolve => setImmediate(resolve));
        holdAcceptedWrite = false;
        releaseWrite();
        const [submitResult, cancelled, completed] = await Promise.all([submitting, cancelling, run]);
        const receipt = getNonApiAiHandoffLifecycle({ windowId: sender.id })
          .find(item => item.requestId === request.requestId.slice(0, 12));
        assert(submitResult.accepted === false && cancelled.cancelled === true
          && completed.success === false && receipt?.outcome === 'cancelled'
          && !receipt.acceptedAt && receipt.itemsDone === 0,
        'an abort during the awaited accepted write returns a non-accepted submit result and cannot commit progress, lifecycle acceptance, or a successful owner result');
      } finally {
        holdAcceptedWrite = false;
        releaseWrite?.();
        fs.promises.writeFile = originalWriteFile;
      }
      return { guarded: true };
    },
  },
  {
    name: 'non-API AI: failed initial durable admission settles lifecycle accounting instead of leaving a ghost pending handoff',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      _resetNonApiAiHandoffLifecycle();
      registerNonApiAiHandlers();
      const sent = [];
      const sender = {
        id: 731, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      const originalWriteFile = fs.promises.writeFile;
      let forced = false;
      fs.promises.writeFile = async (...args) => {
        if (String(args[0]).includes('non-api-ai-handoffs.json')) {
          forced = true;
          throw new Error('forced initial durable pending write failure');
        }
        return originalWriteFile(...args);
      };
      try {
        handleSafe('non-api-initial-durable-failure', async (_event, _args, signal) => ({
          result: await requestNonApiAi({
            prompt: 'TOP_SECRET_INITIAL_DURABLE_FAILURE_PROMPT', task: 'test-manual-initial-durable-failure',
            responseSchema: { type: 'object', required: ['result'], properties: { result: { type: 'string' } } },
            signal,
          }),
        }));
        const manualAiRunId = `initial-durable-failure-${Date.now()}`;
        const result = await ipcMain.__getInvokeHandler('non-api-initial-durable-failure')(
          { sender }, { nodeId: 'initial-durable-failure-node', manualAiRunId },
        );
        const snapshot = getNonApiAiHandoffLifecycleSnapshot({ windowId: sender.id });
        const markdown = buildNonApiAiHandoffLifecycleMarkdown(new Set(['initial-durable-failure-node']), sender.id);
        const replay = await ipcMain.__getInvokeHandler('replay-pending-non-api-ai-requests')({ sender });
        assert(forced && result.success === false && sent.length === 0 && replay.count === 0
          && snapshot.aggregate.issued === 1 && snapshot.aggregate.settled === 1
          && snapshot.aggregate.failed === 1 && snapshot.aggregate.accepted === 0
          && snapshot.aggregate.pendingAfterRejection === 0 && snapshot.lifecycles.length === 1
          && snapshot.lifecycles[0].outcome === 'failed' && snapshot.lifecycles[0].settledAt
          && markdown.includes('Cumulative registry (this process window): 1 issued · 1 settled')
          && markdown.includes('failed 1') && markdown.includes('workflow run scope present')
          && !markdown.includes(manualAiRunId) && !markdown.includes('TOP_SECRET_INITIAL_DURABLE_FAILURE_PROMPT'),
        'a failed initial durable write has one terminal failed receipt, no pending registry entry, and an honest redacted report');
      } finally {
        fs.promises.writeFile = originalWriteFile;
      }
      return { failedInitialWrites: 1 };
    },
  },
  {
    name: 'non-API AI: bug-report lifecycle is bounded, redacted, and proves reject/replay/accept settlement',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      _resetNonApiAiHandoffLifecycle();
      registerNonApiAiHandlers();
      const sent = [];
      const sender = {
        id: 721, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      handleSafe('non-api-lifecycle-report-test', async (_event, _args, signal) => ({
        result: await requestNonApiAi({
          prompt: 'TOP_SECRET_PROMPT must never be reported',
          task: 'test-manual-taxonomy',
          responseSchema: {
            type: 'object', required: ['result'], properties: { result: { type: 'string' } },
          },
          batch: 2, batchTotal: 3, itemCount: 24,
          attemptKind: 'partial-recovery', rootBatchSize: 24, signal,
        }),
      }));
      const run = ipcMain.__getInvokeHandler('non-api-lifecycle-report-test')({ sender }, { nodeId: 'handoff-report-node' });
      await new Promise(resolve => setImmediate(resolve));
      const request = sent.find(item => item.channel === 'non-api-ai-request')?.payload;
      const pendingLifecycle = getNonApiAiHandoffLifecycle({ windowId: sender.id });
      const matching = pendingManualHandoffsForActiveTasks([{
        nodeId: 'handoff-report-node',
        senderId: sender.id,
        taskDetails: [{ channel: 'non-api-lifecycle-report-test' }],
      }], pendingLifecycle);
      const wrongChannel = pendingManualHandoffsForActiveTasks([{
        nodeId: 'handoff-report-node',
        senderId: sender.id,
        taskDetails: [{ channel: 'different-ipc-task' }],
      }], pendingLifecycle);
      const wrongRun = pendingManualHandoffsForActiveTasks([{
        nodeId: 'handoff-report-node',
        senderId: sender.id,
        taskDetails: [{ channel: 'non-api-lifecycle-report-test', manualAiRunId: 'different-workflow' }],
      }], [{
        nodeId: 'handoff-report-node', windowId: sender.id,
        channel: 'non-api-lifecycle-report-test', runId: 'actual-workflow', outcome: 'pending',
      }]);
      const mixedControllers = pendingManualHandoffsForActiveTasks([{
        nodeId: 'handoff-report-node',
        senderId: sender.id,
        taskDetails: [
          { channel: 'non-api-lifecycle-report-test', manualAiRunId: 'actual-workflow' },
          { channel: 'unrelated-ipc-task', manualAiRunId: null },
        ],
      }], [{
        nodeId: 'handoff-report-node', windowId: sender.id,
        channel: 'non-api-lifecycle-report-test', runId: 'actual-workflow', outcome: 'pending',
      }]);
      const pendingReport = generateMarkdown({
        description: 'A manual taxonomy handoff is waiting.', filterCode: 'FULL',
        filterStats: {
          hasJobNodes: true, hasSellNodes: false,
          currentNodeIds: ['handoff-report-node', 'handoff-report-board'], omittedSections: [],
        },
        nodes: [
          { id: 'handoff-report-node', type: 'jobhub', data: {} },
          {
            id: 'handoff-report-board', type: 'jobboard', data: {
              boardScanResume: {
                phase: 'searches', selectedSearchModuleIds: ['handoff-report-node'],
                completedSourceRuns: {}, incompleteSearches: [],
                activeSourceIds: ['handoff-report-node', 'other-active-source'],
                awaitingSourceResolutions: [{ sourceId: 'handoff-report-node' }, { sourceId: 'other-pending-source' }],
              },
            },
          },
        ],
        edges: [], drawings: [], nodeInternals: [], nodeComponentStates: [], frontEndState: {}, eventLogs: [],
      }, sender.id).markdown;
      const submit = ipcMain.__getInvokeHandler('submit-non-api-ai-response');
      const rejected = await submit({ sender }, { requestId: request.requestId, response: `{"handoffCode":"${request.handoffCode}"}` });
      const replay = await ipcMain.__getInvokeHandler('replay-pending-non-api-ai-requests')({ sender });
      const accepted = await submit({ sender }, { requestId: request.requestId, response: `{"handoffCode":"${request.handoffCode}","result":"TOP_SECRET_RESPONSE"}` });
      await run;
      const lifecycle = getNonApiAiHandoffLifecycle({ windowId: sender.id });
      const receipt = lifecycle.find(item => item.requestId === request.requestId.slice(0, 12));
      const markdown = buildNonApiAiHandoffLifecycleMarkdown(new Set(['handoff-report-node']), sender.id);
      const focused = applyBugReportCode([
        '[Jobs] Taxonomy classifying: 1/1 chunk(s)',
        '[Non-API AI] Rejected response for task job-taxonomy-classify',
        'viewport changed source=interaction',
      ], {}, 'JOBHANDOFF');
      assert(request.attemptKind === 'partial-recovery' && request.rootBatchSize === 24
        && rejected.accepted === false && replay.count === 1 && accepted.accepted === true
        && receipt?.deliveries === 3 && receipt?.rejected === 1 && receipt?.reissues === 1
        && receipt?.attemptKind === 'partial-recovery' && receipt?.rootBatchSize === 24
        && receipt?.replays === 1 && receipt?.outcome === 'accepted' && receipt?.acceptedAt && receipt?.settledAt,
      'the lifecycle records initial delivery, validation rejection/reissue, remount replay, acceptance, and final settlement');
      const boardProgress = pendingReport.match(/Board `#[0-9a-f]{10}` searches · 1 selected · 0 completed · 2 active · 2 awaiting source resolution · this source active · this source awaiting resolution/);
      assert(matching.get('handoff-report-node')?.[0]?.task === 'test-manual-taxonomy'
        && wrongChannel.size === 0 && wrongRun.size === 0 && mixedControllers.size === 0
        && pendingReport.includes('⏳ awaiting handoff response: test-manual-taxonomy')
        && pendingReport.includes('IPC `non-api-lifecycle-report-test`')
        && boardProgress
        && !pendingReport.includes('handoff-report-board')
        && !pendingReport.includes('other-active-source')
        && !pendingReport.includes('other-pending-source')
        && !pendingReport.includes('TOP_SECRET_PROMPT'),
      'an active controller is correlated only to the same-node, same-channel pending manual handoff, and FULL keeps Board/source counts behind a one-way digest');
      assert(markdown.includes('Non-API AI Handoff Lifecycle')
        && markdown.includes('sent to local dock 3 time(s)')
        && markdown.includes('"Sent to local dock" is renderer delivery only, not')
        && markdown.includes('1 paste rejection(s)')
        && markdown.includes('1 reissued')
        && markdown.includes('1 replayed after dialog remount')
        && markdown.includes('**partial-row recovery** from 24-item root batch')
        && markdown.includes('workflow run scope missing')
        && markdown.includes('**accepted** in')
        && !markdown.includes(request.handoffCode)
        && !markdown.includes('TOP_SECRET_PROMPT')
        && !markdown.includes('TOP_SECRET_RESPONSE')
        && !markdown.includes('is missing required property'),
      'the report receipt exposes only bounded lifecycle metadata, never prompt, response, or validator text');
      assert(focused.matchedCodes.includes('JOBHANDOFF')
        && focused.filteredLogs.some(line => line.includes('Rejected response'))
        && focused.sectionExclusions.has('nodeInternals')
        && focused.sectionExclusions.has('nodes'),
      'JOBHANDOFF is a focused filter that keeps handoff evidence while dropping the heavy canvas payload');

      const taxonomyFilter = applyBugReportCode([], {}, 'TAXONOMY');
      const taxonomyReport = generateMarkdown({
        description: 'The taxonomy response appeared to be stuck.',
        filterCode: 'TAXONOMY',
        filterStats: {
          eventsShown: 0,
          eventsTotal: 0,
          omittedSections: [...taxonomyFilter.sectionExclusions],
          hasJobNodes: true,
          hasSellNodes: false,
          currentNodeIds: ['handoff-report-node'],
        },
        // Deliberately retain a sentinel despite the filter's exclusions: the
        // formatter must obey the exclusion metadata, just as it does after the
        // renderer removes the heavy node payload before IPC.
        nodes: [{ id: 'taxonomy-heavy-node-must-not-render', type: 'jobcard', data: { title: 'TOP_SECRET_NODE' } }],
        edges: [], drawings: [], nodeInternals: [], nodeComponentStates: [],
        frontEndState: {}, eventLogs: [],
      }, sender.id).markdown;
      assert(taxonomyReport.includes('## Non-API AI Handoff Lifecycle')
        && taxonomyReport.includes('test-manual-taxonomy')
        && taxonomyReport.includes('**accepted** in')
        && !taxonomyReport.includes('TOP_SECRET_PROMPT')
        && !taxonomyReport.includes('TOP_SECRET_RESPONSE')
        && !taxonomyReport.includes('TOP_SECRET_NODE'),
      'TAXONOMY retains its redacted manual taxonomy-handoff receipt while honoring heavy-node exclusions');
      return { deliveries: receipt.deliveries, replays: receipt.replays, filter: 'JOBHANDOFF+TAXONOMY' };
    },
  },
  {
    name: 'non-API AI: typed rejection diagnostics stay bounded, redacted, correlated, and actionable',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      _resetNonApiAiHandoffLifecycle();
      registerNonApiAiHandlers();
      const sent = [];
      const sender = {
        id: 719, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      const privateMessage = 'PRIVATE_VALIDATOR_MESSAGE /Users/private/secret.txt value=never-export';
      let diagnosticAttempt = 0;
      handleSafe('non-api-safe-diagnostic-test', async (_event, _args, signal) => ({
        result: await requestNonApiAi({
          prompt: 'TOP_SECRET_RAW_PROMPT', task: 'job-preference-research-batch', requestKind: 'raw-text', signal,
          responseValidator: () => {
            const error = new Error(privateMessage);
            error.code = 'JOB_PREFERENCE_RESEARCH_RESPONSE_INVALID';
            const diagnostic = {
              stage: 'research-sections', reason: 'MISSING_SECTION',
              expectedCount: 2, receivedCount: 1,
              markerCount: 2_000_000,
              path: '/Users/private/secret.txt', value: 'TOP_SECRET_DIAGNOSTIC_VALUE',
            };
            // Exercise both the current typed field and the supported legacy
            // alias while proving oversized/unlisted metadata is discarded.
            if (diagnosticAttempt === 0) error.validationDiagnostic = diagnostic;
            else error.diagnostic = diagnostic;
            diagnosticAttempt += 1;
            throw error;
          },
        }),
      }));
      const run = ipcMain.__getInvokeHandler('non-api-safe-diagnostic-test')({ sender }, { nodeId: 'safe-diagnostic-node' });
      await new Promise(resolve => setImmediate(resolve));
      const request = sent.find(item => item.channel === 'non-api-ai-request')?.payload;
      const submit = ipcMain.__getInvokeHandler('submit-non-api-ai-response');
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const rejected = await submit({ sender }, {
          requestId: request.requestId,
          response: `Handoff: ${request.handoffCode}\n\nTOP_SECRET_RAW_RESPONSE_${attempt}`,
        });
        assert(rejected.accepted === false && rejected.validationErrors?.[0] === privateMessage,
          'the renderer-local validation detail remains unchanged after a typed safe diagnostic is added');
      }
      const correction = sent.filter(item => item.channel === 'non-api-ai-request').at(-1)?.payload;
      const lifecycle = getNonApiAiHandoffLifecycle({ windowId: sender.id });
      const receipt = lifecycle.find(item => item.requestId === request.requestId.slice(0, 12));
      const copiedFailures = receipt?.failures;
      if (copiedFailures?.[0]) copiedFailures[0].validationDiagnostic.counts.expectedCount = 999;
      const unmutated = getNonApiAiHandoffLifecycle({ windowId: sender.id })
        .find(item => item.requestId === request.requestId.slice(0, 12));
      const markdown = buildNonApiAiHandoffLifecycleMarkdown(new Set(['safe-diagnostic-node']), sender.id);
      const focused = applyBugReportCode([
        '[Non-API AI] Rejected response for task job-preference-research-batch (code=JOB_PREFERENCE_RESEARCH_RESPONSE_INVALID).',
        'viewport changed source=interaction',
      ], {}, 'AIHANDOFF');
      assert(correction?.requestId === request.requestId
        && correction?.isCorrection === true
        && correction?.validationCode === 'JOB_PREFERENCE_RESEARCH_RESPONSE_INVALID'
        && correction?.validationDiagnostic?.stage === 'research-sections'
        && correction?.validationDiagnostic?.reason === 'MISSING_SECTION'
        && correction?.validationDiagnostic?.counts?.expectedCount === 2
        && correction?.validationDiagnostic?.counts?.receivedCount === 1
        && !Object.hasOwn(correction?.validationDiagnostic?.counts || {}, 'markerCount')
        && correction?.validationError === privateMessage
        && correction.prompt.includes('missing section')
        && correction.prompt.includes('expected 2, received 1')
        && !correction.prompt.includes(privateMessage)
        && !JSON.stringify(correction.validationDiagnostic).includes('TOP_SECRET_DIAGNOSTIC_VALUE'),
      'the reissued request keeps the full local detail but exposes only a typed safe diagnostic and uses it for actionable raw-research correction text');
      assert(unmutated?.rejected === 10
        && unmutated?.failures?.length === 8
        && unmutated.failures.every(failure => failure.at > 0
          && failure.validationCode === 'JOB_PREFERENCE_RESEARCH_RESPONSE_INVALID'
          && failure.validationDiagnostic?.reason === 'MISSING_SECTION'
          && failure.validationDiagnostic?.counts?.expectedCount === 2
          && !Object.hasOwn(failure.validationDiagnostic?.counts || {}, 'markerCount')
          && failure.responseChars > 0
          && /^[a-f0-9]{8}$/.test(failure.responseHash || ''))
        && unmutated?.failures?.[0]?.validationDiagnostic?.counts?.expectedCount === 2,
      'each retained rejection is correlated to this lifecycle with timestamp/code/reason/count/size/hash metadata, capped at eight and deep-copied to callers');
      assert(markdown.includes('rejection detail:')
        && markdown.includes('research-sections:MISSING_SECTION')
        && markdown.includes('expected 2, received 1')
        && markdown.includes('receipt tag `')
        && markdown.includes('2 earlier rejection detail(s) not retained (newest 8 shown)')
        && /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z JOB_PREFERENCE_RESEARCH_RESPONSE_INVALID/.test(markdown)
        && !markdown.includes(' · 0 item(s)')
        && !markdown.includes('response null chars')
        && !markdown.includes(privateMessage)
        && !markdown.includes('TOP_SECRET_RAW_PROMPT')
        && !markdown.includes('TOP_SECRET_RAW_RESPONSE')
        && !markdown.includes('TOP_SECRET_DIAGNOSTIC_VALUE'),
      'the bug-report lifecycle renders only compact typed failure metadata, never raw validation text, prompts, responses, paths, or values');
      assert(focused.matchedCodes.includes('AIHANDOFF')
        && focused.filteredLogs.some(line => line.includes('Rejected response'))
        && focused.sectionExclusions.has('nodes')
        && focused.sectionExclusions.has('nodeInternals'),
      'AIHANDOFF is a general focused filter for manual Non-API AI lifecycle evidence while FULL stays unfiltered');
      const finalResponse = await submit({ sender }, {
        requestId: request.requestId,
        response: `Handoff: ${request.handoffCode}\n\naccepted raw research`,
      });
      // The test validator intentionally rejects every raw response. Cancel the
      // owning controller after assertions so it leaves no pending handoff for
      // later tests.
      await ipcMain.__getInvokeHandler('cancel-non-api-ai-request')({ sender }, { requestId: request.requestId });
      await run;
      assert(finalResponse.accepted === false,
        'the diagnostic-only test never accepts an arbitrary raw response before its explicit cleanup');
      return { retainedFailures: receipt.failures.length, filter: 'AIHANDOFF' };
    },
  },
  {
    name: 'non-API AI: lifecycle aggregates survive detail eviction, retain live corrections, isolate windows, and cap inactive windows',
    run: async () => {
      const tick = () => new Promise(resolve => setImmediate(resolve));
      const schema = {
        type: 'object', required: ['result'], properties: { result: { type: 'string' } },
      };
      const responseFor = request => `{"handoffCode":"${request.handoffCode}","result":"ok"}`;
      const senderFor = (id, sent) => ({
        id, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      });

      // First prove that an early correction/recovery remains in the
      // cumulative, content-free accounting after 41 sequential requests push
      // its detailed row out of the 40-row FIFO.
      ipcMain.__clearInvokeHandlers();
      _resetNonApiAiHandoffLifecycle();
      registerNonApiAiHandlers();
      const recoverySent = [];
      const recoverySender = senderFor(732, recoverySent);
      handleSafe('non-api-lifecycle-aggregate-recovery', async (_event, _args, signal) => {
        const values = [];
        for (let index = 0; index < 41; index += 1) {
          values.push(await requestNonApiAi({
            prompt: `TOP_SECRET_AGGREGATE_PROMPT_${index}`,
            task: 'test-manual-aggregate', responseSchema: schema, signal,
          }));
        }
        return { values };
      });
      const recoveryRun = ipcMain.__getInvokeHandler('non-api-lifecycle-aggregate-recovery')({ sender: recoverySender }, {});
      const submit = ipcMain.__getInvokeHandler('submit-non-api-ai-response');
      for (let index = 0; index < 41; index += 1) {
        await tick();
        const request = recoverySent.filter(item => item.channel === 'non-api-ai-request').at(-1)?.payload;
        assert(request?.requestId, `aggregate recovery request ${index + 1} is delivered`);
        if (index === 0) {
          const rejected = await submit({ sender: recoverySender }, {
            requestId: request.requestId,
            response: `{"handoffCode":"${request.handoffCode}"}`,
          });
          assert(rejected.accepted === false, 'the first aggregate test request records a validation rejection');
          const correction = recoverySent.filter(item => item.channel === 'non-api-ai-request').at(-1)?.payload;
          assert(correction?.requestId === request.requestId, 'the rejected request is reissued before recovery');
          await submit({ sender: recoverySender }, { requestId: correction.requestId, response: responseFor(correction) });
        } else {
          await submit({ sender: recoverySender }, { requestId: request.requestId, response: responseFor(request) });
        }
      }
      await recoveryRun;
      const recovered = getNonApiAiHandoffLifecycleSnapshot({ windowId: recoverySender.id });
      const recoveredMarkdown = buildNonApiAiHandoffLifecycleMarkdown(new Set(), recoverySender.id);
      assert(recovered.sourceRetained === 40 && recovered.sourceEvicted === 1
        && recovered.lifecycles.length === 20 && recovered.aggregate.issued === 41
        && recovered.aggregate.settled === 41 && recovered.aggregate.accepted === 41
        && recovered.aggregate.rejectionAttempts === 1 && recovered.aggregate.requestsEverRejected === 1
        && recovered.aggregate.acceptedAfterRejection === 1 && recovered.aggregate.pendingAfterRejection === 0
        && recovered.aggregate.bridgeRejectionAttempts === 0 && recovered.aggregate.requestsEverBridgeRejected === 0
        && recovered.aggregate.acceptedAfterBridgeRejection === 0 && recovered.aggregate.pendingAfterBridgeRejection === 0
        && recoveredMarkdown.includes('Detailed receipts: 20 shown')
        && recoveredMarkdown.includes('1 earlier receipt(s) evicted by the source cap')
        && recoveredMarkdown.includes('Cumulative registry (this process window): 41 issued')
        && recoveredMarkdown.includes('Bridge-route reconciliation: 0 bridge validation rejection attempt(s)')
        && recoveredMarkdown.includes('workflow run scope missing')
        && !JSON.stringify(recovered.aggregate).includes('TOP_SECRET_AGGREGATE_PROMPT'),
      'cumulative lifecycle accounting survives FIFO eviction and contains only closed numeric state');

      // An evicted, still-open correction must be promoted from pendingRequests
      // into the visible snapshot rather than disappearing behind newer work.
      ipcMain.__clearInvokeHandlers();
      _resetNonApiAiHandoffLifecycle();
      registerNonApiAiHandlers();
      const activeSent = [];
      const activeSender = senderFor(733, activeSent);
      handleSafe('non-api-lifecycle-aggregate-active', async (_event, _args, signal) => {
        const early = requestNonApiAi({ prompt: 'TOP_SECRET_EARLY_PROMPT', task: 'test-manual-aggregate', responseSchema: schema, signal });
        const later = [];
        for (let index = 0; index < 40; index += 1) {
          later.push(await requestNonApiAi({ prompt: `TOP_SECRET_LATER_PROMPT_${index}`, task: 'test-manual-aggregate', responseSchema: schema, signal }));
        }
        await early;
        return { later };
      });
      const activeRun = ipcMain.__getInvokeHandler('non-api-lifecycle-aggregate-active')({ sender: activeSender }, {});
      await tick();
      const early = activeSent.find(item => item.channel === 'non-api-ai-request')?.payload;
      const earlyRejected = await submit({ sender: activeSender }, {
        requestId: early.requestId, response: `{"handoffCode":"${early.handoffCode}"}`,
      });
      assert(earlyRejected.accepted === false, 'the long-lived correction is rejected before later work fills the FIFO');
      const submittedLater = new Set();
      for (let index = 0; index < 40; index += 1) {
        let next = null;
        for (let attempt = 0; attempt < 20 && !next; attempt += 1) {
          await tick();
          next = activeSent
            .filter(item => item.channel === 'non-api-ai-request')
            .map(item => item.payload)
            .find(request => request.requestId !== early.requestId && !submittedLater.has(request.requestId));
        }
        assert(next?.requestId, `later request ${index + 1} is delivered while early correction remains pending`);
        submittedLater.add(next.requestId);
        await submit({ sender: activeSender }, { requestId: next.requestId, response: responseFor(next) });
      }
      const activeSnapshot = getNonApiAiHandoffLifecycleSnapshot({ windowId: activeSender.id });
      assert(activeSnapshot.sourceRetained === 40 && activeSnapshot.sourceEvicted === 1
        && activeSnapshot.activeRecoveredFromSourceEviction === 1
        && activeSnapshot.aggregate.issued === 41 && activeSnapshot.aggregate.settled === 40
        && activeSnapshot.aggregate.rejectionAttempts === 1 && activeSnapshot.aggregate.requestsEverRejected === 1
        && activeSnapshot.aggregate.acceptedAfterRejection === 0 && activeSnapshot.aggregate.pendingAfterRejection === 1
        && activeSnapshot.lifecycles.some(receipt => receipt.requestId === early.requestId.slice(0, 12)),
      'an active rejected request stays observable and is not falsely described as recovered after FIFO eviction');
      await ipcMain.__getInvokeHandler('cancel-non-api-ai-request')({ sender: activeSender }, { requestId: early.requestId });
      await activeRun;
      const afterCancel = getNonApiAiHandoffLifecycleSnapshot({ windowId: activeSender.id });
      assert(afterCancel.aggregate.cancelled === 1 && afterCancel.aggregate.pendingAfterRejection === 0,
        'pending-after-rejection is derived from live ownership and clears only when that request settles');

      // Bridge recovery needs its own route-specific fact. A local dock
      // correction above must not let the report claim that a bridge rejection
      // recovered, while a bridge rejection accepted through either route can.
      ipcMain.__clearInvokeHandlers();
      _resetNonApiAiHandoffLifecycle();
      registerNonApiAiHandlers();
      const bridgeSent = [];
      const bridgeSender = senderFor(734, bridgeSent);
      handleSafe('non-api-lifecycle-aggregate-bridge-recovery', async (_event, _args, signal) => ({
        result: await requestNonApiAi({ prompt: 'TOP_SECRET_BRIDGE_PROMPT', task: 'job-scoring', responseSchema: schema, signal }),
      }));
      const bridgeRun = ipcMain.__getInvokeHandler('non-api-lifecycle-aggregate-bridge-recovery')({ sender: bridgeSender }, {});
      await tick();
      const bridgeRequest = bridgeSent.find(item => item.channel === 'non-api-ai-request')?.payload;
      const bridgeRejected = await submitNonApiAiResponseForBridge({
        requestId: bridgeRequest.requestId, handoffCode: bridgeRequest.handoffCode,
        response: `{"handoffCode":"${bridgeRequest.handoffCode}"}`,
        allowTasks: new Set(['job-scoring']),
      });
      assert(bridgeRejected.outcome === 'rejected', 'a bridge submission records a route-specific validation rejection');
      const bridgeAccepted = await submitNonApiAiResponseForBridge({
        requestId: bridgeRequest.requestId, handoffCode: bridgeRequest.handoffCode,
        response: responseFor(bridgeRequest), allowTasks: new Set(['job-scoring']),
      });
      await bridgeRun;
      const bridgeRecovered = getNonApiAiHandoffLifecycleSnapshot({ windowId: bridgeSender.id });
      const bridgeRecoveredMarkdown = buildNonApiAiHandoffLifecycleMarkdown(new Set(), bridgeSender.id);
      assert(bridgeAccepted.outcome === 'accepted'
        && bridgeRecovered.aggregate.bridgeRejectionAttempts === 1
        && bridgeRecovered.aggregate.requestsEverBridgeRejected === 1
        && bridgeRecovered.aggregate.acceptedAfterBridgeRejection === 1
        && bridgeRecovered.aggregate.pendingAfterBridgeRejection === 0
        && bridgeRecoveredMarkdown.includes('1 bridge-rejected request(s) later accepted on that same lifecycle'),
      'only a same-lifecycle bridge rejection followed by acceptance records bridge recovery');

      const bridgePendingSent = [];
      const bridgePendingSender = senderFor(735, bridgePendingSent);
      handleSafe('non-api-lifecycle-aggregate-bridge-pending', async (_event, _args, signal) => ({
        result: await requestNonApiAi({ prompt: 'TOP_SECRET_BRIDGE_PENDING_PROMPT', task: 'job-scoring', responseSchema: schema, signal }),
      }));
      const bridgePendingRun = ipcMain.__getInvokeHandler('non-api-lifecycle-aggregate-bridge-pending')({ sender: bridgePendingSender }, {});
      await tick();
      const bridgePending = bridgePendingSent.find(item => item.channel === 'non-api-ai-request')?.payload;
      await submitNonApiAiResponseForBridge({
        requestId: bridgePending.requestId, handoffCode: bridgePending.handoffCode,
        response: `{"handoffCode":"${bridgePending.handoffCode}"}`,
        allowTasks: new Set(['job-scoring']),
      });
      handleSafe('non-api-lifecycle-aggregate-same-window-dock', async (_event, _args, signal) => ({
        result: await requestNonApiAi({ prompt: 'TOP_SECRET_SAME_WINDOW_DOCK_PROMPT', task: 'test-manual-aggregate', responseSchema: schema, signal }),
      }));
      const dockSameWindowRun = ipcMain.__getInvokeHandler('non-api-lifecycle-aggregate-same-window-dock')({ sender: bridgePendingSender }, {});
      await tick();
      const dockSameWindow = bridgePendingSent
        .filter(item => item.channel === 'non-api-ai-request')
        .map(item => item.payload)
        .find(request => request.requestId !== bridgePending.requestId);
      const dockRejected = await submit({ sender: bridgePendingSender }, {
        requestId: dockSameWindow.requestId, response: `{"handoffCode":"${dockSameWindow.handoffCode}"}`,
      });
      assert(dockRejected.accepted === false, 'a local rejection is recorded beside the unrecovered bridge rejection in the same window');
      await submit({ sender: bridgePendingSender }, { requestId: dockSameWindow.requestId, response: responseFor(dockSameWindow) });
      await dockSameWindowRun;
      const bridgeUnrecovered = getNonApiAiHandoffLifecycleSnapshot({ windowId: bridgePendingSender.id });
      assert(bridgeUnrecovered.aggregate.rejectionAttempts === 2
        && bridgeUnrecovered.aggregate.acceptedAfterRejection === 1
        && bridgeUnrecovered.aggregate.bridgeRejectionAttempts === 1
        && bridgeUnrecovered.aggregate.requestsEverBridgeRejected === 1
        && bridgeUnrecovered.aggregate.acceptedAfterBridgeRejection === 0
        && bridgeUnrecovered.aggregate.pendingAfterBridgeRejection === 1,
      'an unrecovered bridge rejection cannot borrow a same-window dock recovery from another lifecycle');
      await ipcMain.__getInvokeHandler('cancel-non-api-ai-request')({ sender: bridgePendingSender }, { requestId: bridgePending.requestId });
      await bridgePendingRun;

      // The compact per-window aggregate map prunes inactive windows, never
      // mixes their totals, and reset removes its accounting as well as detail.
      ipcMain.__clearInvokeHandlers();
      _resetNonApiAiHandoffLifecycle();
      registerNonApiAiHandlers();
      const capSent = [];
      handleSafe('non-api-lifecycle-aggregate-window-cap', async (_event, _args, signal) => ({
        result: await requestNonApiAi({ prompt: 'TOP_SECRET_CAP_PROMPT', task: 'test-manual-aggregate', responseSchema: schema, signal }),
      }));
      const capRuns = [];
      const capSenders = [];
      for (let index = 0; index < 65; index += 1) {
        const sender = senderFor(8_000 + index, capSent);
        capSenders.push(sender);
        capRuns.push(ipcMain.__getInvokeHandler('non-api-lifecycle-aggregate-window-cap')({ sender }, {}));
      }
      for (let attempt = 0; attempt < 20 && capSent.filter(item => item.channel === 'non-api-ai-request').length < 65; attempt += 1) await tick();
      const capRequests = capSent.filter(item => item.channel === 'non-api-ai-request').map(item => item.payload);
      assert(capRequests.length === 65, 'every isolated-window cap-test request is delivered');
      await Promise.all(capRequests.map((request, index) => submit({ sender: capSenders[index] }, {
        requestId: request.requestId, response: responseFor(request),
      })));
      await Promise.all(capRuns);
      const cappedWindows = capSenders.map(sender => getNonApiAiHandoffLifecycleSnapshot({ windowId: sender.id }));
      const postCapSender = senderFor(8_100, capSent);
      const postCapRun = ipcMain.__getInvokeHandler('non-api-lifecycle-aggregate-window-cap')({ sender: postCapSender }, {});
      await tick();
      const postCapRequest = capSent.filter(item => item.channel === 'non-api-ai-request').at(-1)?.payload;
      await submit({ sender: postCapSender }, { requestId: postCapRequest.requestId, response: responseFor(postCapRequest) });
      await postCapRun;
      const postCapWindow = getNonApiAiHandoffLifecycleSnapshot({ windowId: postCapSender.id });
      assert(__nonApiAiHandoffLifecycleAggregateCountForTests() <= 64
        && cappedWindows.some(snapshot => snapshot.aggregate.issued === 0)
        && cappedWindows.filter(snapshot => snapshot.aggregate.issued > 0)
          .every(snapshot => snapshot.aggregate.issued === 1 && snapshot.aggregate.accepted === 1)
        && postCapWindow.aggregate.issued === 1 && postCapWindow.aggregate.accepted === 1,
      'inactive window aggregates are capped and evicted independently without leaking totals into another window');
      _resetNonApiAiHandoffLifecycle();
      const reset = getNonApiAiHandoffLifecycleSnapshot({ windowId: recoverySender.id });
      assert(reset.sourceRetained === 0 && reset.sourceEvicted === 0 && reset.aggregate.issued === 0
        && __nonApiAiHandoffLifecycleAggregateCountForTests() === 0,
      'the test-only lifecycle reset clears both detailed and cumulative accounting');
      return { sourceCap: recovered.sourceRetained, aggregateCap: 64 };
    },
  },
  {
    name: 'non-API AI: structured research assessment diagnostics produce phase-correct JSON corrections',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      _resetNonApiAiHandoffLifecycle();
      registerNonApiAiHandlers();
      const sent = [];
      const sender = {
        id: 720, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      const reasons = [
        'ASSESSMENT_COVERAGE_INVALID',
        'ASSESSMENT_IDENTITY_INVALID',
        'ASSESSMENT_QUOTE_NOT_GROUNDED',
        'ASSESSMENT_URL_NOT_GROUNDED',
        'ASSESSMENT_SOURCE_DATE_NOT_GROUNDED',
      ];
      const privateMessage = 'PRIVATE_ASSESSMENT_VALIDATOR_TEXT research-secret-id';
      let attempt = 0;
      handleSafe('non-api-assessment-diagnostic-test', async (_event, _args, signal) => ({
        result: await callLLMText('Assess every supplied research identity.', {
          signal,
          task: 'test-manual-research-assessment',
          responseSchema: { type: 'object', required: ['assessments'], properties: { assessments: { type: 'array' } } },
          responseValidator: () => {
            const error = new Error(privateMessage);
            error.code = 'JOB_PREFERENCE_RESEARCH_RESPONSE_INVALID';
            error.validationDiagnostic = {
              stage: 'research-assessment',
              reason: reasons[Math.min(attempt, reasons.length - 1)],
              expectedCount: 27,
              receivedCount: 26,
              researchId: 'research-secret-id',
            };
            attempt += 1;
            throw error;
          },
        }),
      }));
      const run = ipcMain.__getInvokeHandler('non-api-assessment-diagnostic-test')({ sender }, { nodeId: 'assessment-diagnostic-node' });
      await new Promise(resolve => setImmediate(resolve));
      const request = sent.find(item => item.channel === 'non-api-ai-request')?.payload;
      const submit = ipcMain.__getInvokeHandler('submit-non-api-ai-response');
      const corrections = [];
      for (const reason of reasons) {
        const rejected = await submit({ sender }, {
          requestId: request.requestId,
          response: JSON.stringify({ handoffCode: request.handoffCode, assessments: [] }),
        });
        const correction = sent.filter(item => item.channel === 'non-api-ai-request').at(-1)?.payload;
        assert(rejected.accepted === false
          && rejected.validationErrors?.[0] === privateMessage
          && correction?.isCorrection === true
          && correction?.validationDiagnostic?.stage === 'research-assessment'
          && correction?.validationDiagnostic?.reason === reason
          && correction?.validationDiagnostic?.counts?.expectedCount === 27
          && correction?.validationDiagnostic?.counts?.receivedCount === 26
          && !JSON.stringify(correction.validationDiagnostic).includes('research-secret-id'),
        `the ${reason} diagnostic stays typed and redacted across the structured handoff boundary`);
        corrections.push(correction.prompt);
      }
      assert(corrections[0].includes('exactly one JSON assessment row for every requested researchId')
        && corrections[1].includes('Copy each researchId and preferenceId exactly')
        && corrections[2].includes('one short contiguous passage')
        && corrections[3].includes('literal http(s) URL')
        && corrections[4].includes('otherwise use an empty string')
        && corrections.every(prompt => prompt.includes('Return the complete JSON assessment again, not BEGIN/END RESEARCH sections.'))
        && corrections.every(prompt => !prompt.includes('Regenerate every requested BEGIN RESEARCH / END RESEARCH block')),
      'each structured assessment failure gets specific JSON/provenance correction text and never the raw-section retry instruction');

      const markdown = buildNonApiAiHandoffLifecycleMarkdown(new Set(['assessment-diagnostic-node']), sender.id);
      const dialogSource = readFileSync(new URL('../../src/components/NonApiAiDialog.jsx', import.meta.url), 'utf8');
      assert(reasons.every(reason => markdown.includes(`research-assessment:${reason}`))
        && !markdown.includes(privateMessage)
        && !markdown.includes('research-secret-id'),
      'the bug report retains every safe assessment reason while redacting validator and row content');
      assert(dialogSource.includes('correctionGuidanceFor(validationCode, activeRequest?.validationDiagnostic)')
        && dialogSource.includes('pasted JSON assessment')
        && dialogSource.includes("validationDiagnostic?.stage === 'research-assessment'")
        && !dialogSource.includes('{correctionGuidance || (isCorrection'),
      'the renderer selects assessment-specific rejection copy from the safe diagnostic stage');

      await ipcMain.__getInvokeHandler('cancel-non-api-ai-request')({ sender }, { requestId: request.requestId });
      await run;
      return { reasons: reasons.length, phase: 'research-assessment' };
    },
  },
  {
    name: 'non-API AI: compensation assessment diagnostics reach FULL as typed, redacted receipts',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      _resetNonApiAiHandoffLifecycle();
      registerNonApiAiHandlers();
      const sent = [];
      const sender = {
        id: 721, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      const reasons = [
        'COMPENSATION_COHORT_COVERAGE_INVALID',
        'COMPENSATION_COHORT_IDENTITY_INVALID',
        'COMPENSATION_ROLE_FAMILY_COVERAGE_INVALID',
        'COMPENSATION_ROLE_FAMILY_IDENTITY_INVALID',
        'COMPENSATION_ASSESSMENT_COVERAGE_INVALID',
        'COMPENSATION_RANGE_INVALID',
        'COMPENSATION_EVIDENCE_NOT_GROUNDED',
        'COMPENSATION_ROLE_FAMILY_EVIDENCE_NOT_GROUNDED',
      ];
      const privateMessage = 'PRIVATE_COMPENSATION_VALIDATOR_TEXT cohort-secret-id';
      let attempt = 0;
      handleSafe('non-api-compensation-diagnostic-test', async (_event, _args, signal) => ({
        result: await requestNonApiAi({
          prompt: 'TOP_SECRET_COMPENSATION_PROMPT', task: 'test-manual-compensation-assessment', requestKind: 'raw-text', signal,
          responseValidator: () => {
            const error = new Error(privateMessage);
            error.code = 'JOB_COMPENSATION_RESPONSE_INVALID';
            error.validationDiagnostic = {
              stage: 'compensation-assessment',
              reason: reasons[Math.min(attempt, reasons.length - 1)],
              expectedCount: 2,
              receivedCount: 1,
              cohortId: 'cohort-secret-id',
            };
            attempt += 1;
            throw error;
          },
        }),
      }));
      const run = ipcMain.__getInvokeHandler('non-api-compensation-diagnostic-test')({ sender }, { nodeId: 'compensation-diagnostic-node' });
      await new Promise(resolve => setImmediate(resolve));
      const request = sent.find(item => item.channel === 'non-api-ai-request')?.payload;
      const submit = ipcMain.__getInvokeHandler('submit-non-api-ai-response');
      for (const reason of reasons) {
        const rejected = await submit({ sender }, {
          requestId: request.requestId,
          response: `Handoff: ${request.handoffCode}\n\ncompensation answer`,
        });
        assert(rejected.accepted === false && rejected.validationErrors?.[0] === privateMessage,
          `the ${reason} rejection preserves its detailed message only in the active renderer`);
      }
      const markdown = buildNonApiAiHandoffLifecycleMarkdown(new Set(['compensation-diagnostic-node']), sender.id);
      assert(reasons.every(reason => markdown.includes(`compensation-assessment:${reason}`))
        && markdown.includes('JOB_COMPENSATION_RESPONSE_INVALID')
        && markdown.includes('expected 2, received 1')
        && !markdown.includes(privateMessage)
        && !markdown.includes('cohort-secret-id')
        && !markdown.includes('TOP_SECRET_COMPENSATION_PROMPT'),
      'FULL reports the typed compensation validation cause and counts without exporting private response, research, or cohort data');
      await ipcMain.__getInvokeHandler('cancel-non-api-ai-request')({ sender }, { requestId: request.requestId });
      await run;
      return { reasons: reasons.length, stage: 'compensation-assessment' };
    },
  },
  {
    // Regression test for a real drift: jobsSnapshot.js used to keep its own
    // hand-copied safeCodes/safeReasons Sets instead of building them from
    // SAFE_NON_API_AI_LOG_ERROR_CODES/SAFE_VALIDATION_DIAGNOSTIC_REASONS, so
    // adding DUPLICATE_RESPONSE to the transport did not add it to the
    // report's filter — the one rejection that proves a cross-paste happened
    // would have been silently dropped. jobsSnapshot.js now builds its Sets
    // from these two imports directly, so this sweeps every current member
    // of both through a real reject cycle and would fail the moment a future
    // addition to either allowlist stopped reaching the rendered report.
    name: 'non-API AI: every SAFE_NON_API_AI_LOG_ERROR_CODES/SAFE_VALIDATION_DIAGNOSTIC_REASONS member survives the bug-report filter',
    run: async () => {
      // Stage is required alongside reason, and three reason groups are only
      // accepted under their own matching stage (see cloneSafeValidationDiagnostic
      // in nonApiAi.js). Rather than re-typing that grouping here — which would
      // recreate exactly the kind of hand-copied list this test exists to stop
      // trusting — discover a working stage per reason using the transport's
      // own diagnostic constructor as the oracle.
      const stageCandidates = ['research-sections', 'research-assessment', 'compensation-assessment', 'transport', 'json', 'schema', 'domain'];
      const stageForReason = (reason) => stageCandidates.find((stage) => {
        const probe = __defaultSafeValidationDiagnosticForTests({ validationDiagnostic: { stage, reason } }, 'VALIDATION_FAILED');
        return probe?.stage === stage && probe?.reason === reason;
      });

      let nodeSeq = 0;
      const rejectOnceAndReadMarkdown = async ({ code, diagnostic }) => {
        ipcMain.__clearInvokeHandlers();
        _resetNonApiAiHandoffLifecycle();
        registerNonApiAiHandlers();
        nodeSeq += 1;
        const nodeId = `safe-allowlist-sweep-node-${nodeSeq}`;
        const sent = [];
        const sender = {
          id: 9000 + nodeSeq, isDestroyed: () => false, once: () => {}, removeListener: () => {},
          send: (channel, payload) => sent.push({ channel, payload }),
        };
        handleSafe('non-api-safe-allowlist-sweep-test', async (_event, _args, signal) => ({
          result: await requestNonApiAi({
            prompt: 'sweep prompt', task: 'job-preference-research-batch', requestKind: 'raw-text', signal,
            responseValidator: () => {
              const error = new Error('sweep validator message');
              error.code = code;
              if (diagnostic) error.validationDiagnostic = diagnostic;
              throw error;
            },
          }),
        }));
        const run = ipcMain.__getInvokeHandler('non-api-safe-allowlist-sweep-test')({ sender }, { nodeId });
        await new Promise(resolve => setImmediate(resolve));
        const request = sent.find(item => item.channel === 'non-api-ai-request')?.payload;
        const submit = ipcMain.__getInvokeHandler('submit-non-api-ai-response');
        await submit({ sender }, { requestId: request.requestId, response: `Handoff: ${request.handoffCode}\n\nsweep response` });
        const markdown = buildNonApiAiHandoffLifecycleMarkdown(new Set([nodeId]), sender.id);
        await ipcMain.__getInvokeHandler('cancel-non-api-ai-request')({ sender }, { requestId: request.requestId });
        await run;
        return markdown;
      };

      const missingCodes = [];
      for (const code of SAFE_NON_API_AI_LOG_ERROR_CODES) {
        const markdown = await rejectOnceAndReadMarkdown({ code });
        if (!markdown.includes(code)) missingCodes.push(code);
      }
      assert(missingCodes.length === 0,
        `every SAFE_NON_API_AI_LOG_ERROR_CODES member renders verbatim in the bug report (missing: ${missingCodes.join(', ') || 'none'})`);

      const unpairedReasons = [];
      const missingReasons = [];
      for (const reason of SAFE_VALIDATION_DIAGNOSTIC_REASONS) {
        const stage = stageForReason(reason);
        if (!stage) { unpairedReasons.push(reason); continue; }
        const markdown = await rejectOnceAndReadMarkdown({ code: 'VALIDATION_FAILED', diagnostic: { stage, reason } });
        if (!markdown.includes(`${stage}:${reason}`)) missingReasons.push(reason);
      }
      assert(unpairedReasons.length === 0,
        `every SAFE_VALIDATION_DIAGNOSTIC_REASONS member has a stage the transport itself accepts it under (unpaired: ${unpairedReasons.join(', ') || 'none'})`);
      assert(missingReasons.length === 0,
        `every SAFE_VALIDATION_DIAGNOSTIC_REASONS member renders verbatim in the bug report (missing: ${missingReasons.join(', ') || 'none'})`);

      return { codes: SAFE_NON_API_AI_LOG_ERROR_CODES.size, reasons: SAFE_VALIDATION_DIAGNOSTIC_REASONS.size };
    },
  },
  {
    name: 'non-API AI: AIHANDOFF narrows main-process logs but FULL keeps the global ring',
    run: () => {
      const unrelated = `UNRELATED_MAIN_PROCESS_AUDIT_${Date.now()}`;
      const handoffLog = `[Non-API AI] AIHANDOFF_MAIN_PROCESS_AUDIT_${Date.now()}`;
      logger.warn(unrelated);
      logger.warn(handoffLog);
      const basePayload = {
        description: 'A pasted manual AI response was rejected.',
        filterStats: { eventsShown: 0, eventsTotal: 0, omittedSections: [], currentNodeIds: [], currentJobHubIds: [] },
        nodes: [], edges: [], drawings: [], nodeInternals: [], nodeComponentStates: [],
        frontEndState: {}, eventLogs: [],
      };
      const focused = generateMarkdown({ ...basePayload, filterCode: 'AIHANDOFF' }).markdown;
      const full = generateMarkdown({ ...basePayload, filterCode: 'FULL' }).markdown;
      assert(focused.includes(handoffLog) && !focused.includes(unrelated)
        && full.includes(handoffLog) && full.includes(unrelated),
      'AIHANDOFF keeps manual-AI main-process evidence without exporting unrelated ring entries, while FULL remains global');
      return { focusedMainLogs: true };
    },
  },
  {
    name: 'non-API AI: main-frame navigation aborts its orphaned handoff instead of leaking it across reload',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const sent = [];
      const sender = new EventEmitter();
      sender.id = 706;
      sender.isDestroyed = () => false;
      sender.send = (channel, payload) => sent.push({ channel, payload });
      handleSafe('non-api-navigation-abort-test', async (_event, _args, signal) => ({
        result: await callLLMText('Return a result.', {
          signal, task: 'test-manual-retry-delivery', responseSchema: {
            type: 'object', required: ['result'], properties: { result: { type: 'string' } },
          },
        }),
      }));
      const run = ipcMain.__getInvokeHandler('non-api-navigation-abort-test')({ sender }, { nodeId: 'node-navigation-abort' });
      await new Promise(resolve => setImmediate(resolve));
      assert(sent.some(item => item.channel === 'non-api-ai-request'),
        'the handoff is pending before the renderer navigation begins');
      sender.emit('did-start-navigation', {}, 'file:///canvas/index.html', false, true);
      const result = await run;
      assert(result.success === false && result.error === 'Renderer navigated'
        && sent.some(item => item.channel === 'non-api-ai-settled' && item.payload?.cancelled),
      'a real main-frame reload aborts the old invoke and settles its handoff instead of retaining an unreachable promise');
      return { error: result.error };
    },
  },
  {
    name: 'non-API AI: a sender closing during delivery settles instead of leaking a pending request',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const sender = {
        id: 707, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: () => { throw new Error('WebContents is closing'); },
      };
      handleSafe('non-api-delivery-race-test', async (_event, _args, signal) => ({
        result: await callLLMText('Return a result.', {
          signal, task: 'job-scoring', responseSchema: {
            type: 'object', required: ['result'], properties: { result: { type: 'string' } },
          },
        }),
      }));
      const result = await ipcMain.__getInvokeHandler('non-api-delivery-race-test')({ sender }, { nodeId: 'node-delivery-race' });
      const replay = await ipcMain.__getInvokeHandler('replay-pending-non-api-ai-requests')({ sender });
      assert(result.success === false && result.error.includes('Originating window closed before the Non-API AI request could be shown.')
        && replay.count === 0,
      'a `.send()` close race removes the request and rejects its owning handler rather than retaining an unreachable handoff');
      return { replayed: replay.count };
    },
  },
  {
    name: 'non-API AI: a failed validation-retry delivery also settles its unreachable handoff',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const sent = [];
      let failDelivery = false;
      const sender = {
        id: 708, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => {
          if (failDelivery) throw new Error('WebContents is closing');
          sent.push({ channel, payload });
        },
      };
      handleSafe('non-api-retry-delivery-race-test', async (_event, _args, signal) => ({
        result: await callLLMText('Return a result.', {
          signal, task: 'test-manual-retry-delivery', responseSchema: {
            type: 'object', required: ['result'], properties: { result: { type: 'string' } },
          },
        }),
      }));
      const run = ipcMain.__getInvokeHandler('non-api-retry-delivery-race-test')({ sender }, { nodeId: 'node-retry-delivery-race' });
      await new Promise(resolve => setImmediate(resolve));
      const requestId = sent.find(item => item.channel === 'non-api-ai-request')?.payload?.requestId;
      failDelivery = true;
      const request = sent.find(item => item.channel === 'non-api-ai-request')?.payload;
      const submit = await ipcMain.__getInvokeHandler('submit-non-api-ai-response')({ sender }, { requestId, response: `{"handoffCode":"${request?.handoffCode}"}` });
      const result = await run;
      const replay = await ipcMain.__getInvokeHandler('replay-pending-non-api-ai-requests')?.({ sender });
      assert(submit.accepted === false
        && result.success === false && result.error.includes('Originating window closed before the Non-API AI request could be shown.')
        && replay?.count === 0,
      'a correction re-emit that loses its renderer tears down the same request instead of retaining it forever');
      return { replayed: replay.count };
    },
  },
  {
    name: 'non-API AI: the manual handoff queue is ordered by batch, not by arrival',
    run: () => {
      // A 1-job scoring batch used to reach the renderer FIRST. scoreBatch's
      // only pre-handoff await (checkPromptFits) was gated on `batch.length > 1`,
      // and requestNonApiAi sends its IPC synchronously — so inside the single
      // Promise.all dispatch pass the singleton skipped a microtask turn and
      // jumped the queue. A historical 61-job run presented as 5, 1, 2, 3, 4.
      const jobsSource = readFileSync(new URL('../../electron/ipc/jobs.js', import.meta.url), 'utf8');
      const scoreBatchBody = jobsSource.slice(
        jobsSource.indexOf('const scoreBatch = async (batch, context = {}) => {'),
        jobsSource.indexOf('const batchMeta = {};'),
      );
      const scoreBatchSource = jobsSource.slice(
        jobsSource.indexOf('const scoreBatch = async (batch, context = {}) => {'),
        jobsSource.indexOf('\n    // Live per-batch scoring progress'),
      );
      const preflightCalls = [...scoreBatchSource.matchAll(/await checkPromptFits\(/g)];
      assert(scoreBatchSource.length > 0 && preflightCalls.length === 1
        && !/if \(batch\.length > 1\) \{[\s\S]*await checkPromptFits\(/.test(scoreBatchSource),
      'every scoring batch has exactly one context-window preflight; concurrent dispatch order is intentionally not an invocation-order contract');
      assert(/if \(fit && !fit\.fits && batch\.length > 1\) \{/.test(scoreBatchBody),
        'the SPLIT stays guarded on batch.length > 1 — at length 1 mid is 1, the right half is empty, and scoreBatch would recurse forever');
      // A retry/split is causally dependent on the parent response. Keep its
      // children serial: dispatching both halves together while the other nine
      // top-level handoffs are still open would turn one completed prompt into
      // two replacements and exceed the fixed ten-prompt work set.
      assert(/const \[left, right\] = \[\s*await scoreBatch\(batch\.slice\(0, mid\), context\),\s*await scoreBatch\(batch\.slice\(mid\), context\),\s*\];/.test(scoreBatchSource)
        && !/Promise\.all\(\[\s*scoreBatch\(batch\.slice\(0, mid\), context\)/.test(scoreBatchSource),
      'a defensive scoring split resolves its two dependent children one at a time, so it cannot fan one active top-level slot into two handoffs');
      // Partial recovery is similarly a dependency of the response just
      // accepted for this SAME root batch. Awaiting it before scoreBatch
      // returns keeps the recovery inside its root slot before the automatic
      // scheduler may claim a fresh independent batch.
      assert(/const recovered = await scoreBatch\(missingJobs, \{ \.\.\.context, partialRecovery: true \}\);/.test(scoreBatchSource),
      'a partial-score recovery stays inside its original top-level batch instead of rotating a new independent batch into the active wave');
      // Bounded, not unbounded: the centralized scheduler maintains ten active
      // root slots and immediately replaces a completed independent batch. A
      // partial recovery remains inside its root slot, so it cannot fan out and
      // exceed the cap.
      assert(jobsSource.includes('await mapAutomaticHandoffs(scoringBatches, HANDOFF_CONCURRENCY, async (batch, batchIndex) =>'),
        'top-level batches use the shared rolling scheduler, so a completed independent batch refills its slot without exceeding the cap');

      // Renderer-side belt and braces: arrival order is not a contract, so the
      // queue sorts itself rather than trusting main to emit in order.
      const dialogSource = readFileSync(new URL('../../src/components/NonApiAiDialog.jsx', import.meta.url), 'utf8');
      assert(!dialogSource.includes('if (index === -1) return [...previous, incoming];')
        && dialogSource.includes('next.splice(at, 0, incoming);')
        && dialogSource.includes('&& queued.batch > incoming.batch'),
      'receiveRequest inserts a new handoff by batch number instead of appending it in arrival order');

      // Behavioural check of that insert, including the cases it must NOT reorder.
      const insert = (previous, incoming) => {
        const index = previous.findIndex(request => request.requestId === incoming.requestId);
        if (index >= 0) {
          const updated = [...previous];
          updated[index] = { ...updated[index], ...incoming };
          return updated;
        }
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
      };
      const scoringRequest = (batch) => ({ requestId: `r${batch}`, nodeId: 'hub', task: 'job-scoring', batch });
      const order = (arrival) => arrival.reduce((queue, request) => insert(queue, request), []).map(r => r.batch).join(',');
      assert(order([5, 1, 2, 3, 4].map(scoringRequest)) === '1,2,3,4,5'
        && order([1, 2, 3, 4, 5].map(scoringRequest)) === '1,2,3,4,5'
        && order([3, 5, 1, 4, 2].map(scoringRequest)) === '1,2,3,4,5',
      'any arrival order of one hub’s scoring batches presents ascending, so the chip strip matches the prompt numbering');

      const settled = [1, 2, 3].map(scoringRequest).reduce((queue, request) => insert(queue, request), []);
      assert(insert(settled, { ...scoringRequest(1), validationError: 'retry' }).map(r => r.batch).join(',') === '1,2,3',
        'a validation re-emit updates its request in place and never moves the chip the person is answering');

      const mixed = [
        scoringRequest(2),
        { requestId: 'taxonomy', nodeId: 'hub', task: 'job-taxonomy-plan' },
        scoringRequest(1),
        { requestId: 'other-hub', nodeId: 'other', task: 'job-scoring', batch: 1 },
      ].reduce((queue, request) => insert(queue, request), []);
      assert(mixed.map(r => r.requestId).join(',') === 'r1,r2,taxonomy,other-hub',
        'ordering is scoped to one node+task: unnumbered handoffs and other hubs keep arrival order instead of being interleaved');
      return { ordering: 'batch-ascending', scope: 'node+task' };
    },
  },
  {
    name: 'non-API AI: handoff code appears in prompt first-line banner, settings block, and rendered schema',
    run: () => {
      const schema = {
        type: 'object', required: ['handoffCode', 'answer'], additionalProperties: false,
        properties: {
          // A schema is not supposed to own this transport field. Keep a
          // conflicting declaration here to prove the rendered request const
          // cannot be overwritten by a future schema edit.
          handoffCode: { type: 'string', const: 'HANDOFF-STALE1' },
          answer: { type: 'string' },
        },
      };
      const code = 'HANDOFF-K7Q3M2';
      const originalSchema = JSON.stringify(schema);
      const prompt = materializeNonApiPrompt({
        prompt: 'TEST PROMPT',
        cachedPrefix: 'TEST PREFIX',
        task: 'job-preference-evaluation',
        batch: 36,
        batchTotal: 259,
        handoffCode: code,
        responseSchema: schema,
      });
      assert(prompt.startsWith('=== HANDOFF-K7Q3M2 · job-preference-evaluation · batch 36 of 259 ===\n\nTEST PREFIX\n\nTEST PROMPT'),
        'prompt begins with the exact handoff code banner as the first line before cachedPrefix');
      assert(prompt.includes('Handoff code: HANDOFF-K7Q3M2'),
        'settings block includes the Handoff code line');
      assert(prompt.includes('"handoffCode": {\n      "type": "string",\n      "const": "HANDOFF-K7Q3M2"\n    }'),
        'schema is rendered with handoffCode const property injected at top of properties');
      assert(!prompt.includes('HANDOFF-STALE1'),
        'a conflicting schema handoffCode declaration cannot replace the per-request const');
      assert(prompt.includes('The top-level `handoffCode` property must be copied verbatim'),
        'schema instructions include the handoffCode verbatim copy requirement');
      const stamped = validateNonApiAiSubmission({
        response: JSON.stringify({ handoffCode: code, answer: 'stamped answer' }),
        responseSchema: schema,
        task: 'job-preference-evaluation',
        expectedHandoffCode: code,
      });
      const codeFree = validateNonApiAiSubmission({
        requireHandoffCode: false,
        response: JSON.stringify({ answer: 'legacy answer' }),
        responseSchema: schema,
        task: 'job-preference-evaluation',
        expectedHandoffCode: code,
      });
      assert(stamped.answer === 'stamped answer' && !('handoffCode' in stamped)
        && codeFree.answer === 'legacy answer',
      'both stamped and code-free responses validate against the task schema after the transport field is stripped');
      assert(JSON.stringify(schema) === originalSchema,
        'prompt rendering and transport validation never mutate the caller schema');

      // Free-text prompt
      const freeText = materializeNonApiPrompt({
        prompt: 'RESEARCH THIS',
        task: 'job-compensation-research',
        handoffCode: code,
      });
      assert(freeText.startsWith('=== HANDOFF-K7Q3M2 · job-compensation-research ===\n\nRESEARCH THIS'),
        'free-text prompt begins with handoff code banner');
      assert(freeText.includes('Handoff: HANDOFF-K7Q3M2'),
        'free-text prompt requires Handoff: code on first line of response');
      return { bannerChecked: true };
    },
  },
  {
    name: 'non-API AI: deriveHandoffCode is deterministic across calls for the same logical request',
    run: () => {
      const args = {
        basePrompt: 'EVALUATE PREFERENCES',
        task: 'job-preference-evaluation',
        nodeId: 'node-123',
        batch: 38,
        batchTotal: 259,
        itemCount: 8,
        attachmentPaths: [],
      };
      const code1 = deriveHandoffCode(args);
      const code2 = deriveHandoffCode(args);
      assert(typeof code1 === 'string' && code1.startsWith('HANDOFF-') && code1.length === 14,
        'deriveHandoffCode returns a HANDOFF-XXXXXX string');
      assert(code1 === code2,
        'calling deriveHandoffCode twice with identical parameters yields identical code');
      const firstPrompt = `LISTINGS: ${wrapUntrustedText('job-listings', '[{"title":"Engineer"}]')}`;
      const secondPrompt = `LISTINGS: ${wrapUntrustedText('job-listings', '[{"title":"Engineer"}]')}`;
      const firstTag = firstPrompt.match(/<untrusted-job-listings-[a-f0-9]{8}>/)?.[0];
      const secondTag = secondPrompt.match(/<untrusted-job-listings-[a-f0-9]{8}>/)?.[0];
      const regeneratedCode1 = deriveHandoffCode({ ...args, basePrompt: firstPrompt });
      const regeneratedCode2 = deriveHandoffCode({ ...args, basePrompt: secondPrompt });
      assert(firstTag && secondTag && firstTag !== secondTag && regeneratedCode1 === regeneratedCode2,
        'distinct visible generated boundaries for the same logical prompt derive one stable handoff code');
      for (const ch of code1.slice(8)) {
        assert(HANDOFF_CODE_ALPHABET.includes(ch), `code character ${ch} belongs to HANDOFF_CODE_ALPHABET`);
      }
      return { code: code1 };
    },
  },
  {
    name: 'non-API AI: two different batches of the same task derive different handoff codes',
    run: () => {
      const common = {
        basePrompt: 'EVALUATE PREFERENCES',
        task: 'job-preference-evaluation',
        nodeId: 'node-123',
        batchTotal: 259,
        itemCount: 8,
        attachmentPaths: [],
      };
      const code38 = deriveHandoffCode({ ...common, batch: 38 });
      const code39 = deriveHandoffCode({ ...common, batch: 39 });
      assert(code38 !== code39,
        `batch 38 (${code38}) and batch 39 (${code39}) derive different codes`);
      return { code38, code39 };
    },
  },
  {
    name: 'non-API AI: validateNonApiAiSubmission rejects mismatched handoff codes with informative error',
    run: () => {
      const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
      let rejectedStructured = false;
      try {
        validateNonApiAiSubmission({
          response: JSON.stringify({ handoffCode: 'HANDOFF-W8NG11', ok: true }),
          responseSchema: schema,
          task: 'test-task',
          expectedHandoffCode: 'HANDOFF-C8RECT',
        });
      } catch (err) {
        rejectedStructured = true;
        assert(err instanceof NonApiAiCodeMismatchError || err.isCodeMismatch, 'throws code mismatch error');
        assert(err.message.includes('HANDOFF-W8NG11'), 'error message names observed code');
        assert(err.message.includes('HANDOFF-C8RECT'), 'error message names expected code');
        assert(err.message.includes('Nothing was saved'), 'error message states nothing was saved');
      }
      assert(rejectedStructured, 'structured submission with wrong handoffCode was rejected');

      let rejectedRaw = false;
      try {
        validateNonApiAiSubmission({
          response: 'Some text mentioning HANDOFF-W8NG22 somewhere in response',
          task: 'job-compensation-research',
          expectedHandoffCode: 'HANDOFF-C8RECT',
        });
      } catch (err) {
        rejectedRaw = true;
        assert(err.message.includes('HANDOFF-W8NG22') && err.message.includes('HANDOFF-C8RECT'),
          'raw sweep mismatch names both codes');
      }
      assert(rejectedRaw, 'raw text containing wrong handoff code was rejected');
      return { rejectedStructured, rejectedRaw };
    },
  },
  {
    name: 'non-API AI: legacy code-free responses remain compatible while current handoffs require their code',
    run: () => {
      const schema = { type: 'object', required: ['result'], properties: { result: { type: 'string' } } };
      const legacyResponse = JSON.stringify({ result: 'accepted legacy value' });
      const value = validateNonApiAiSubmission({
        requireHandoffCode: false,
        response: legacyResponse,
        responseSchema: schema,
        task: 'job-scoring',
        expectedHandoffCode: 'HANDOFF-EXPECT',
      });
      assert(value?.result === 'accepted legacy value',
        'a pre-enforcement durable response remains code-free compatible');
      let currentRejected = false;
      try {
        validateNonApiAiSubmission({
          response: legacyResponse,
          responseSchema: schema,
          task: 'job-scoring',
          expectedHandoffCode: 'HANDOFF-EXPECT',
          requireHandoffCode: true,
        });
      } catch (error) {
        currentRejected = error?.code === 'HANDOFF_CODE_MISSING'
          && error?.message.includes('HANDOFF-EXPECT');
      }
      assert(currentRejected,
        'a current handoff rejects a code-free structured response before it can be accepted');
      let quotedCodeRejected = false;
      try {
        validateNonApiAiSubmission({
          response: JSON.stringify({ result: 'The prompt mentioned HANDOFF-EXPECT, but the transport property is absent.' }),
          responseSchema: schema,
          task: 'job-scoring',
          expectedHandoffCode: 'HANDOFF-EXPECT',
          requireHandoffCode: true,
        });
      } catch (error) { quotedCodeRejected = error?.code === 'HANDOFF_CODE_MISSING'; }
      assert(quotedCodeRejected,
        'an expected token quoted inside structured content cannot impersonate the top-level transport property');
      return { acceptedLegacy: true, currentRejected, quotedCodeRejected };
    },
  },
  {
    name: 'non-API AI: an unstated handoff expectation fails loudly instead of accepting any paste',
    run: () => {
      const schema = { type: 'object', required: ['result'], properties: { result: { type: 'string' } } };
      const issuedCode = 'HANDOFF-K7Q3M2';
      // A complete, schema-valid answer that was written for a DIFFERENT
      // handoff. Nothing about its shape reveals that; only the code does.
      const foreignPaste = JSON.stringify({ handoffCode: 'HANDOFF-FRGN27', result: 'answer written for another handoff' });
      let omission = '';
      try {
        validateNonApiAiSubmission({ response: foreignPaste, responseSchema: schema, task: 'job-preference-evaluation' });
      } catch (error) { omission = String(error?.message || error); }
      assert(omission.includes('requires the handoff code') && omission.includes('different handoff'),
        `a caller that states no handoff expectation must fail loudly, not validate a foreign paste, got ${omission || 'silent acceptance'}`);

      // Naming the issued code is enough to get the full guard: the caller
      // does not also have to remember to ask for the requirement.
      let structuredMissing = '';
      try {
        validateNonApiAiSubmission({
          response: JSON.stringify({ result: 'code-free answer' }),
          responseSchema: schema,
          task: 'test-manual-code-bound',
          expectedHandoffCode: issuedCode,
        });
      } catch (error) { structuredMissing = error?.code || ''; }
      let rawMissing = '';
      try {
        validateNonApiAiSubmission({
          response: 'Research prose with no handoff header.',
          task: 'job-compensation-research',
          expectedHandoffCode: issuedCode,
        });
      } catch (error) { rawMissing = error?.code || ''; }
      assert(structuredMissing === 'HANDOFF_CODE_MISSING' && rawMissing === 'HANDOFF_CODE_MISSING',
        `a code-bearing handoff requires its code back by default on both transports, got ${structuredMissing || 'acceptance'} and ${rawMissing || 'acceptance'}`);

      // Both permissive modes survive, but each is now requested by name.
      const legacyStep = validateNonApiAiSubmission({
        response: JSON.stringify({ result: 'pre-enforcement answer' }),
        responseSchema: schema,
        task: 'job-preference-evaluation',
        expectedHandoffCode: issuedCode,
        requireHandoffCode: false,
      });
      const codelessStep = validateNonApiAiSubmission({
        response: JSON.stringify({ result: 'durable row recorded before codes existed' }),
        responseSchema: schema,
        task: 'job-preference-evaluation',
        expectedHandoffCode: null,
      });
      assert(legacyStep.result === 'pre-enforcement answer'
        && codelessStep.result === 'durable row recorded before codes existed',
      'a pre-enforcement durable step still validates when its call site declares that it carries no verifiable code');

      let contradiction = '';
      try {
        validateNonApiAiSubmission({
          response: JSON.stringify({ result: 'x' }),
          responseSchema: schema,
          task: 'job-preference-evaluation',
          expectedHandoffCode: null,
          requireHandoffCode: true,
        });
      } catch (error) { contradiction = String(error?.message || error); }
      assert(/never issued one/u.test(contradiction),
        `requiring a code that was never issued is a programming error, got ${contradiction || 'silent acceptance'}`);
      return { omissionRejected: true, structuredMissing, rawMissing };
    },
  },
  {
    name: 'non-API AI: handoffCode is stripped from validated structured response before return',
    run: () => {
      const schema = { type: 'object', required: ['result'], properties: { result: { type: 'string' } } };
      const response = JSON.stringify({ handoffCode: 'HANDOFF-MATCH1', result: 'clean result' });
      const value = validateNonApiAiSubmission({
        response,
        responseSchema: schema,
        task: 'job-scoring',
        expectedHandoffCode: 'HANDOFF-MATCH1',
      });
      assert(value?.result === 'clean result', 'result contains expected schema payload');
      assert(!('handoffCode' in value), 'handoffCode is stripped from returned object');
      return { stripped: true };
    },
  },
  {
    name: 'non-API AI: free-text submission strips matching Handoff header line from returned prose',
    run: () => {
      const rawWithHeader = 'Handoff: HANDOFF-FRE888\n\nThis is the actual research text.\nLine two.';
      const cleaned = validateNonApiAiSubmission({
        response: rawWithHeader,
        task: 'job-compensation-research',
        expectedHandoffCode: 'HANDOFF-FRE888',
      });
      assert(cleaned === 'This is the actual research text.\nLine two.',
        'Handoff: header and following blank line are stripped');

      const rawWithoutHeader = 'This is research text without header.';
      const untouched = validateNonApiAiSubmission({
        requireHandoffCode: false,
        response: rawWithoutHeader,
        task: 'job-compensation-research',
        expectedHandoffCode: 'HANDOFF-FRE888',
      });
      assert(untouched === 'This is research text without header.',
        'legacy text without a Handoff header is returned untouched');
      let missingRawRejected = false;
      try {
        validateNonApiAiSubmission({
          response: rawWithoutHeader,
          task: 'job-compensation-research',
          expectedHandoffCode: 'HANDOFF-FRE888',
          requireHandoffCode: true,
        });
      } catch (error) { missingRawRejected = error?.code === 'HANDOFF_CODE_MISSING'; }
      assert(missingRawRejected,
        'a current raw handoff rejects a missing first-line Handoff code');
      let buriedRawRejected = false;
      try {
        validateNonApiAiSubmission({
          response: 'Research begins here.\nHandoff: HANDOFF-FRE888\nThis code is not the first line.',
          task: 'job-compensation-research',
          expectedHandoffCode: 'HANDOFF-FRE888',
          requireHandoffCode: true,
        });
      } catch (error) { buriedRawRejected = error?.code === 'HANDOFF_CODE_MISSING'; }
      assert(buriedRawRejected,
        'a matching token below the first line cannot impersonate the raw-text transport header');
      return { cleaned: true, untouched: true, missingRawRejected, buriedRawRejected };
    },
  },
  {
    name: 'non-API AI: listing IDs bind preference evaluations to their exact root rows',
    run: () => {
      const plan = {
        softPreferences: [{ id: 'rule1', criterion: 'Remote only', category: 'location' }],
        strictRequirements: [{ id: 'rule2', criterion: 'Python stack', category: 'skills' }],
        direction: { roleDirections: [], avoidDirections: [] },
      };
      const batchAJobs = Array.from({ length: 8 }, (_, i) => ({ source: 'alpha', id: `jobA_${i}`, title: `Job A ${i}` }));
      const batchBJobs = Array.from({ length: 8 }, (_, i) => ({ source: 'beta', id: `jobB_${i}`, title: `Job B ${i}` }));
      const idsA = listingIdsForRootBatch(batchAJobs);
      const responseFor = ids => ({ assessments: ids.map((listingId, index) => ({
        index, listingId, matches: [
          { preferenceId: 'rule1', outcome: 'confirmed', evidenceQuote: 'Remote position' },
          { preferenceId: 'rule2', outcome: 'unverified' },
        ],
      })) });
      const correct = responseFor(idsA);
      assert(validateJobPreferenceListingSubmission(correct, batchAJobs, plan) === correct,
        'a complete v2 response with each row\'s exact opaque ID is accepted');

      const rejects = value => {
        try { validateJobPreferenceListingSubmission(value, batchAJobs, plan); return false; } catch { return true; }
      };
      assert(rejects(responseFor(idsA.map((_, index) => listingIdsForRootBatch(batchBJobs)[index]))),
        'a same-size response from a different batch is rejected by listing identity');
      const sameMetadataDifferentNativeId = Array.from({ length: 8 }, (_, i) => ({
        source: 'alpha', id: `other-native-id-${i}`, title: 'Software Engineer', company: 'Example', location: 'Toronto, ON',
      }));
      assert(rejects(responseFor(listingIdsForRootBatch(sameMetadataDifferentNativeId))),
        'distinct provider-native id values prevent same-source, same-title/location batches from aliasing');
      const missing = responseFor(idsA); delete missing.assessments[0].listingId;
      const swapped = responseFor(idsA); [swapped.assessments[0].listingId, swapped.assessments[1].listingId] = [swapped.assessments[1].listingId, swapped.assessments[0].listingId];
      const duplicate = responseFor(idsA); duplicate.assessments[1].listingId = duplicate.assessments[0].listingId;
      assert(rejects(missing) && rejects(swapped) && rejects(duplicate),
        'missing, swapped, and duplicate listing IDs are all rejected before a result can be accepted');

      const duplicateRoot = [
        { source: 'alpha', jobkey: 'same-id', title: 'Same copy' },
        { source: 'alpha', jobkey: 'same-id', title: 'Same copy' },
      ];
      const rootIds = listingIdsForRootBatch(duplicateRoot);
      const recovered = { assessments: [{ index: 0, listingId: rootIds[1], matches: [
        { preferenceId: 'rule1', outcome: 'unverified' },
        { preferenceId: 'rule2', outcome: 'unverified' },
      ] }] };
      assert(rootIds[0] !== rootIds[1]
        && listingIdsForRootBatch([duplicateRoot[1]])[0] !== rootIds[1]
        && validateJobPreferenceListingSubmission(recovered, [duplicateRoot[1]], plan, { listingIds: [rootIds[1]] }) === recovered,
        'partial recovery preserves the root batch ID while its remaining row is reindexed locally');
      return { v2Accepted: true, wrongBatchRejected: true, malformedIdsRejected: true, partialRootIdPreserved: true };
    },
  },
  {
    name: 'non-API AI: current pending records enforce handoff codes through the IPC submit path',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      _resetNonApiAiHandoffLifecycle();
      registerNonApiAiHandlers();
      const sent = [];
      const sender = {
        id: 888, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };

      handleSafe('test-collision-channel', async (_event, args, signal) => {
        return requestNonApiAi({
          prompt: `PROMPT FOR BATCH ${args.batch}`,
          task: 'test-manual-code-bound',
          batch: args.batch,
          batchTotal: 259,
          itemCount: 8,
          responseSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
          signal,
        });
      });

      // Issue batch 38
      const run38 = ipcMain.__getInvokeHandler('test-collision-channel')({ sender }, { batch: 38, nodeId: 'node-col' });
      await new Promise(resolve => setImmediate(resolve));
      const req38 = sent.find(item => item.payload?.batch === 38)?.payload;
      assert(req38?.handoffCode, 'req38 has a handoffCode');

      // Test code mismatch rejection on batch 38
      const submit = ipcMain.__getInvokeHandler('submit-non-api-ai-response');
      const mismatchResult = await submit({ sender }, {
        requestId: req38.requestId,
        response: JSON.stringify({ handoffCode: 'HANDOFF-W8NG99', ok: true }),
      });
      assert(mismatchResult.accepted === false, 'mismatch response is rejected');
      assert(mismatchResult.validationErrors[0].includes('HANDOFF-W8NG99')
        && mismatchResult.validationErrors[0].includes(req38.handoffCode),
        'rejection error names both codes');

      // A newly issued record is code-bound; a code-free historical response
      // must not be accepted into it.
      const missing38 = await submit({ sender }, {
        requestId: req38.requestId,
        response: JSON.stringify({ ok: true }),
      });
      assert(missing38.accepted === false && missing38.validationErrors[0].includes(req38.handoffCode),
        'batch 38 rejects a code-free response');
      const missingCodeCorrection = sent.filter(item => item.channel === 'non-api-ai-request').at(-1)?.payload;
      assert(missingCodeCorrection?.requestId === req38.requestId
        && missingCodeCorrection.isCorrection === true
        && missingCodeCorrection.prompt.includes('omitted the required transport identifier')
        && missingCodeCorrection.prompt.includes('exact `Handoff: ...` first line')
        && missingCodeCorrection.prompt.includes('exact `handoffCode` property'),
      'a missing code reissue repeats the safe transport contract without sourcing a code from the error');
      const accepted38 = await submit({ sender }, {
        requestId: req38.requestId,
        response: JSON.stringify({ handoffCode: req38.handoffCode, ok: true }),
      });
      assert(accepted38.accepted === true, 'batch 38 accepts its own stamped response');
      await run38;

      // Issue batch 39
      const run39 = ipcMain.__getInvokeHandler('test-collision-channel')({ sender }, { batch: 39, nodeId: 'node-col' });
      await new Promise(resolve => setImmediate(resolve));
      const req39 = sent.find(item => item.payload?.batch === 39)?.payload;
      assert(req39?.handoffCode && req39.handoffCode !== req38.handoffCode,
        'req39 has distinct handoffCode');

      // Attempt pasting a response stamped with batch 38's code into batch 39 -> rejected!
      const batch38StampedAnswer = JSON.stringify({ handoffCode: req38.handoffCode, ok: true });
      const rejectedCrossBatch = await submit({ sender }, {
        requestId: req39.requestId,
        response: batch38StampedAnswer,
      });
      assert(rejectedCrossBatch.accepted === false,
        'pasting batch 38 answer stamped with code 38 into batch 39 is rejected by code mismatch');

      const missing39 = await submit({ sender }, {
        requestId: req39.requestId,
        response: JSON.stringify({ ok: true }),
      });
      assert(missing39.accepted === false && missing39.validationErrors[0].includes(req39.handoffCode),
        'batch 39 also rejects a code-free response');
      const accepted39 = await submit({ sender }, {
        requestId: req39.requestId,
        response: JSON.stringify({ handoffCode: req39.handoffCode, ok: true }),
      });
      assert(accepted39.accepted === true, 'batch 39 accepts only its own stamped response');
      await run39;

      // Check markdown output
      const lifecycle = getNonApiAiHandoffLifecycle({ windowId: sender.id });
      const receipt38 = lifecycle.find(item => item.batch === 38);
      const receipt39 = lifecycle.find(item => item.batch === 39);
      assert(receipt38?.responseHash === receipt39?.failures?.[0]?.responseHash
        && receipt38.responseHash !== receipt39?.responseHash,
      'the process-keyed receipt tag correlates identical pasted bodies but distinguishes different accepted responses');
      const markdown = buildNonApiAiHandoffLifecycleMarkdown(new Set(['node-col']), sender.id);
      assert(!markdown.includes(req38.handoffCode), 'markdown redacts req38 handoff code');
      assert(!markdown.includes(req39.handoffCode), 'markdown redacts req39 handoff code');
      assert(markdown.includes('code mismatch rejection(s)'), 'markdown reports code mismatch rejection');
      assert(markdown.includes('receipt tag `'), 'markdown reports a process-keyed response receipt tag');
      return { lifecycleVerified: true, missingCodesRejected: true };
    },
  },
  {
    // Reproduces the confirmed 2026-09-17 corruption: a durable step restored
    // from before handoff-code enforcement existed has no code to compare
    // against, so a response with no code at all was accepted for TWO
    // different batches of one run. claimAcceptedResponseFingerprint is the
    // guard closing that hole; requestNonApiAi/submit-non-api-ai-response
    // cannot legitimately be driven into the pre-enforcement (code-optional)
    // state from a fresh call in this shared test process — every step this
    // process creates from scratch is stamped with the CURRENT enforcement
    // version — so this exercises the exact function the submit handler
    // calls, at the exact call site's inputs (a record's runId/stepKey/
    // handoffCode plus the raw pasted text).
    name: 'non-API AI: an accepted response cannot be silently accepted again for a different step',
    run: () => {
      _resetNonApiAiHandoffLifecycle();
      const body = 'A'.repeat(DUPLICATE_RESPONSE_MIN_LENGTH); // exactly at the floor, inclusive
      const recordA = { runId: 'run-dup-cross', stepKey: 'step-A', handoffCode: 'HANDOFF-AAAAAA' };
      const recordB = { runId: 'run-dup-cross', stepKey: 'step-B', handoffCode: 'HANDOFF-BBBBBB' };
      __claimAcceptedResponseFingerprintForTests(recordA, body);
      let error = null;
      try {
        __claimAcceptedResponseFingerprintForTests(recordB, body);
      } catch (err) { error = err; }
      assert(error instanceof NonApiAiDuplicateResponseError, 'a different step claiming the identical body is rejected with the new error class');
      assert(error.code === 'DUPLICATE_RESPONSE', 'the rejection carries the DUPLICATE_RESPONSE code');
      assert(error.message.includes('already accepted for a different prompt'), 'message states the response was already accepted for a different prompt');
      assert(error.message.includes('Nothing was saved'), 'message states nothing was saved');
      assert(error.message.includes(recordB.handoffCode), "message names THIS prompt's own handoff code as the repair");
      assert(!error.message.includes(recordA.handoffCode), 'message never names the other step\'s code, which may belong to a different run');
      return { rejected: true };
    },
  },
  {
    name: 'non-API AI: re-accepting the identical body for the SAME logical step is never a conflict',
    run: () => {
      _resetNonApiAiHandoffLifecycle();
      const body = 'B'.repeat(DUPLICATE_RESPONSE_MIN_LENGTH + 40);
      const record = { runId: 'run-dup-same', stepKey: 'step-same', handoffCode: 'HANDOFF-CCCCCC' };
      let threwFirst = false;
      try {
        __claimAcceptedResponseFingerprintForTests(record, body);
        __claimAcceptedResponseFingerprintForTests(record, body);
      } catch { threwFirst = true; }
      assert(!threwFirst, 'the same record object re-claiming its own accepted text never conflicts with itself');
      // Identity is stepKey, not object identity and not handoffCode: a
      // re-issued or stepped-back request builds a brand-new record for the
      // same logical step, sometimes with a different collision-fallback
      // handoffCode, and must still be able to re-accept the identical text.
      const reissuedRecord = { runId: 'run-dup-same', stepKey: 'step-same', handoffCode: 'HANDOFF-DDDDDD' };
      let threwReissued = false;
      try {
        __claimAcceptedResponseFingerprintForTests(reissuedRecord, body);
      } catch { threwReissued = true; }
      assert(!threwReissued, 'a re-issued request for the same step can still re-accept the identical text');
      // And runId is NOT part of that identity, which is the difference
      // between a guard and a trap. stepKey hashes the prompt, so a new run
      // asking the SAME question produces the same stepKey — and cancelling a
      // run discards every pasted response while inviting a retry of exactly
      // those prompts. Someone who still holds those answers and re-pastes
      // them must not be told their own correct answer belongs elsewhere.
      const retriedRunRecord = { runId: 'run-dup-same-RETRY', stepKey: 'step-same', handoffCode: 'HANDOFF-KKKKKK' };
      let threwRetriedRun = false;
      try {
        __claimAcceptedResponseFingerprintForTests(retriedRunRecord, body);
      } catch { threwRetriedRun = true; }
      assert(!threwRetriedRun, 'a retried run re-asking the same prompt can re-accept the answer already given to it');
      return { allowed: true };
    },
  },
  {
    name: 'non-API AI: short repeated answers below the duplicate-response floor never conflict across steps',
    run: () => {
      _resetNonApiAiHandoffLifecycle();
      const shortBody = 'C'.repeat(DUPLICATE_RESPONSE_MIN_LENGTH - 1);
      const recordA = { runId: 'run-dup-short', stepKey: 'short-A', handoffCode: 'HANDOFF-EEEEEE' };
      const recordB = { runId: 'run-dup-short', stepKey: 'short-B', handoffCode: 'HANDOFF-FFFFFF' };
      __claimAcceptedResponseFingerprintForTests(recordA, shortBody);
      let threw = false;
      try {
        __claimAcceptedResponseFingerprintForTests(recordB, shortBody);
      } catch { threw = true; }
      assert(!threw, `a ${shortBody.length}-char response (one under the ${DUPLICATE_RESPONSE_MIN_LENGTH}-char floor) is never fingerprinted, so it cannot conflict across two different steps`);
      // Incidental leading/trailing paste whitespace must not itself push a
      // short answer over the floor ("normalized" means trimmed length).
      const paddedShortBody = `   ${shortBody}   `;
      const recordC = { runId: 'run-dup-short', stepKey: 'short-C', handoffCode: 'HANDOFF-GGGGGG' };
      let threwPadded = false;
      try {
        __claimAcceptedResponseFingerprintForTests(recordC, paddedShortBody);
      } catch { threwPadded = true; }
      assert(!threwPadded, 'whitespace padding a below-floor response does not push it over the floor');
      return { belowFloorAllowed: true };
    },
  },
  {
    name: 'non-API AI: the accepted-response fingerprint registry is bounded and evicts its oldest entry first',
    run: () => {
      _resetNonApiAiHandoffLifecycle();
      const bodyFor = index => `${'D'.repeat(DUPLICATE_RESPONSE_MIN_LENGTH)}-${index}`;
      const firstBody = bodyFor(0);
      const firstRecord = { runId: 'run-dup-cap', stepKey: 'cap-step-0', handoffCode: 'HANDOFF-HHHHHH' };
      __claimAcceptedResponseFingerprintForTests(firstRecord, firstBody);
      // Fill the registry with many more distinct (step, body) pairs than any
      // reasonable cap could hold. The exact bound is a private implementation
      // detail (not exported), so this loop just needs to comfortably exceed
      // it rather than pin its precise value.
      const fillCount = 400;
      for (let index = 1; index <= fillCount; index += 1) {
        __claimAcceptedResponseFingerprintForTests(
          { runId: 'run-dup-cap', stepKey: `cap-step-${index}`, handoffCode: 'HANDOFF-IIIIII' },
          bodyFor(index),
        );
      }
      // The oldest fingerprint must have been evicted: the exact same body,
      // now claimed for yet another brand-new step, must be accepted rather
      // than flagged as a conflict with the long-since-forgotten first step.
      let threwForEvictedFingerprint = false;
      try {
        __claimAcceptedResponseFingerprintForTests(
          { runId: 'run-dup-cap', stepKey: 'cap-step-reused', handoffCode: 'HANDOFF-JJJJJJ' },
          firstBody,
        );
      } catch { threwForEvictedFingerprint = true; }
      assert(!threwForEvictedFingerprint, `the registry evicted its oldest entry after ${fillCount} newer claims, so the first body no longer conflicts with a brand-new step`);
      return { bounded: true, evictedOldestFirst: true };
    },
  },
  {
    name: 'non-API AI: DUPLICATE_RESPONSE is wired through the safe log and diagnostic classification lists',
    run: () => {
      const error = new NonApiAiDuplicateResponseError('HANDOFF-ZZZZZZ');
      assert(error.code === 'DUPLICATE_RESPONSE', 'the new error carries the DUPLICATE_RESPONSE code');
      assert(__nonApiAiLogErrorCodeForTests(error) === 'DUPLICATE_RESPONSE',
        'DUPLICATE_RESPONSE passes through the safe-log error-code allowlist unchanged instead of collapsing to VALIDATION_FAILED');
      const diagnostic = __defaultSafeValidationDiagnosticForTests(error, 'DUPLICATE_RESPONSE');
      assert(diagnostic.stage === 'transport' && diagnostic.reason === 'DUPLICATE_RESPONSE',
        'the diagnostic classifier maps DUPLICATE_RESPONSE to a transport-stage, DUPLICATE_RESPONSE-reason diagnostic');
      // cloneSafeValidationDiagnostic (the allowlist filter feeding a real
      // lifecycle receipt) must also accept this exact diagnostic rather than
      // silently dropping it. Round-trip it back through the classifier as an
      // already-typed diagnostic, exactly as a real rejection would carry it.
      const roundTripped = __defaultSafeValidationDiagnosticForTests({ validationDiagnostic: diagnostic }, 'DUPLICATE_RESPONSE');
      assert(roundTripped.stage === 'transport' && roundTripped.reason === 'DUPLICATE_RESPONSE',
        'a DUPLICATE_RESPONSE diagnostic survives the safe-diagnostic allowlist filter unmodified');
      return { wired: true };
    },
  },
  {
    name: 'non-API AI: a duplicate-response rejection reissues the original prompt unchanged, exactly like a code mismatch',
    run: () => {
      const duplicateRecord = { materializedPrompt: 'ORIGINAL PROMPT TEXT', validationCode: 'DUPLICATE_RESPONSE', responseSchema: null };
      const duplicateRetry = __promptForRetryForTests(duplicateRecord, new NonApiAiDuplicateResponseError('HANDOFF-JJJJJJ'));
      assert(duplicateRetry.prompt === duplicateRecord.materializedPrompt && duplicateRetry.isCorrection === false,
        'a duplicate-response rejection reissues the identical prompt with no correction annotation');
      const mismatchRecord = { materializedPrompt: 'ORIGINAL PROMPT TEXT', validationCode: 'HANDOFF_CODE_MISMATCH', responseSchema: null };
      const mismatchRetry = __promptForRetryForTests(mismatchRecord, new NonApiAiCodeMismatchError('HANDOFF-X', 'HANDOFF-Y'));
      assert(duplicateRetry.prompt === mismatchRetry.prompt && duplicateRetry.isCorrection === mismatchRetry.isCorrection,
        'a duplicate-response rejection reissues identically to a code-mismatch rejection');
      // A missing-code rejection, by contrast, DOES annotate a correction --
      // confirming the bypass above is specific to mismatch/duplicate, not a
      // side effect of some broader change to promptForRetry.
      const missingRecord = { materializedPrompt: 'ORIGINAL PROMPT TEXT', validationCode: 'HANDOFF_CODE_MISSING', responseSchema: null };
      const missingRetry = __promptForRetryForTests(missingRecord, new NonApiAiCodeMissingError('HANDOFF-Z'));
      assert(missingRetry.isCorrection === true && missingRetry.prompt !== missingRecord.materializedPrompt,
        'a missing-code rejection still annotates a correction, unlike mismatch/duplicate');
      return { matched: true };
    },
  },
  {
    name: 'non-API AI: code-mismatch and code-missing error messages are unchanged',
    run: () => {
      const mismatch = new NonApiAiCodeMismatchError('HANDOFF-W8NG11', 'HANDOFF-C8RECT');
      assert(mismatch.message === 'This response is stamped HANDOFF-W8NG11, but this prompt is HANDOFF-C8RECT — it is the answer to a different handoff. Nothing was saved. Find the chat whose prompt header reads HANDOFF-C8RECT and paste that answer here. (Each prompt carries its own code precisely so two batches of the same task cannot be swapped.)',
        `code-mismatch message text is unchanged, got: ${mismatch.message}`);
      assert(mismatch.code === 'HANDOFF_CODE_MISMATCH' && mismatch.isCodeMismatch === true, 'code-mismatch error shape is unchanged');

      const missing = new NonApiAiCodeMissingError('HANDOFF-EXPECT');
      assert(missing.message === 'This response is missing the required HANDOFF-EXPECT handoff code. Nothing was saved. Paste the complete response from the chat whose prompt header reads HANDOFF-EXPECT; its first line must be "Handoff: HANDOFF-EXPECT" (or, for JSON, include the matching handoffCode property).',
        `code-missing message text is unchanged, got: ${missing.message}`);
      assert(missing.code === 'HANDOFF_CODE_MISSING', 'code-missing error shape is unchanged');

      // Still exercised through the real validation entry point, unchanged.
      const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
      let mismatchThrown = null;
      try {
        validateNonApiAiSubmission({
          response: JSON.stringify({ handoffCode: 'HANDOFF-W8NG11', ok: true }),
          responseSchema: schema, task: 'test-task', expectedHandoffCode: 'HANDOFF-C8RECT',
        });
      } catch (err) { mismatchThrown = err; }
      assert(mismatchThrown?.message === mismatch.message, 'validateNonApiAiSubmission still throws the exact unchanged mismatch message');

      let missingThrown = null;
      try {
        validateNonApiAiSubmission({
          response: JSON.stringify({ ok: true }),
          responseSchema: schema, task: 'test-task', expectedHandoffCode: 'HANDOFF-EXPECT',
        });
      } catch (err) { missingThrown = err; }
      assert(missingThrown?.message === missing.message, 'validateNonApiAiSubmission still throws the exact unchanged missing-code message');
      return { unchanged: true };
    },
  },
  {
    // Bug report 2026-10-07: "i cant click settings button while ai handoffs
    // exist". The dock is a 32rem-wide panel pinned bottom-right; the canvas
    // toolbar (Settings is its LAST button) is a bottom-centre row. On any
    // window narrower than ~1700px the corner-anchored dock sat on top of that
    // row. The dock must stay above the toolbar row, so this derives the row's
    // height from the toolbar's own classes rather than trusting a number.
    name: 'non-API AI: the handoff dock is parked above the canvas toolbar row so Settings stays clickable',
    async run() {
      const dialogSource = readFileSync(new URL('../../src/components/NonApiAiDialog.jsx', import.meta.url), 'utf8');
      const toolbarSource = readFileSync(new URL('../../src/components/CanvasToolbar.jsx', import.meta.url), 'utf8');
      const spacingPx = (step) => Number(step) * 4; // Tailwind: 1 step = 0.25rem = 4px
      const panelMargin = toolbarSource.match(/<Panel position="bottom-center" className="[^"]*\bmb-(\d+)\b/);
      const barPadding = toolbarSource.match(/className="[^"]*\bglass-card rounded-full p-(\d+)\b/);
      const settingsButton = toolbarSource.match(/data-testid="canvas-settings-button"[\s\S]{0,200}?className="[^"]*\bp-(\d+)\b/);
      const settingsIcon = toolbarSource.match(/<Settings size=\{(\d+)\} \/>/);
      assert(panelMargin && barPadding && settingsButton && settingsIcon,
        'the toolbar row geometry (panel margin, bar padding, button padding, icon size) is still derivable from CanvasToolbar.jsx');
      const toolbarTopPx = spacingPx(panelMargin[1])
        + spacingPx(barPadding[1]) * 2
        + spacingPx(settingsButton[1]) * 2
        + Number(settingsIcon[1]);
      assert(toolbarTopPx === 74, `the toolbar row is 74px tall from the window bottom (derived ${toolbarTopPx}px) — if this changed, re-size the dock's bottom offset`);

      const dockOffset = dialogSource.match(/data-handoff-dock=\{[^}]+\}\s+className=\{`pointer-events-auto fixed bottom-\[([\d.]+)rem\] right-4/);
      assert(dockOffset, 'the dock container declares its bottom offset in rem next to its data-handoff-dock attribute');
      const dockBottomPx = Number(dockOffset[1]) * 16;
      const clears = (bottomPx) => bottomPx > toolbarTopPx;
      assert(clears(dockBottomPx), `the dock's bottom edge (${dockBottomPx}px) clears the toolbar row (${toolbarTopPx}px)`);
      assert(!clears(16), 'the check is not vacuous: the old corner anchor (bottom-4 = 16px) overlaps the toolbar row');

      // The panel's height caps must subtract the same offset plus the 1rem top
      // gap, or the taller-than-viewport case pushes the dock's header offscreen.
      const capRem = Number(dockOffset[1]) + 1;
      assert(dialogSource.includes(`max-h-[calc(100vh-${capRem}rem)]`) && dialogSource.includes(`min-h-[min(47rem,calc(100vh-${capRem}rem))]`),
        'the dock panel height caps subtract the bottom offset plus a 1rem top gap');
      assert(!dialogSource.includes('fixed bottom-4 right-4'), 'no dock container is anchored to the bottom-right corner any more');
      return { toolbarTopPx, dockBottomPx };
    },
  },
];
