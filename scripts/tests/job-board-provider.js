import { assert } from './testHelpers.js';
import { readFileSync } from 'node:fs';
import { isJobBoardUserCancellation, isLegacyUnbucketedJobBoard, validateJobBoardTaxonomy } from '../../src/utils/jobBoardAiProvider.js';
import { attachCompensationRemoteResidences, combineSignature, emptyReplacementIneligibilityReason, isLegacyCombineSignature, moduleCombineFingerprint, moduleFingerprint, normalizeJobMatchScore, parseCombineSignature, staleReason, unionScoredJobs } from '../../src/nodes/jobboard/mergeJobs.js';
import { buildJobTreeNodes, compareJobsByFitAndPreference } from '../../src/nodes/jobsearch/buildJobTree.js';
import { allocateJobBoardAdmissionOrder, findJobSearchBoardActiveRecoveryOwner, findJobSearchBoardCancellablePausedSourceOwner, findJobSearchBoardPausedContinuationOwner, findJobSearchBoardRecoveryOwner, getConnectedJobSearchIds, getSelectedConnectedJobSearchIds, isJobSearchBoardPausedContinuationBlocked, isJobSearchConnectedToBoard, jobBoardModuleReadiness, jobBoardSelectionPresentation, moveJobSearchExecutionOrder, normalizeJobBoardAdmissionOrder, normalizeJobBoardRecoveryTimestamp, orderJobSearchIds, remapCopiedJobBoardSelections, remapCopiedJobModuleReferences, toggleSelectedJobSearchId } from '../../src/utils/jobBoardSearchSelection.js';
import { createModuleRunQueue } from '../../src/utils/moduleRunQueue.js';
import { createJobSearchCoordinatorRegistry } from '../../src/utils/jobSearchCoordinatorRegistry.js';
import { exactPausedSourceContinuation, exactPausedSourceTerminalOutcome, isMergeableTerminalJobSearchOutcome, resolveExactPausedJobBoardTerminal, terminalJobSearchOutcome } from '../../src/utils/jobBoardPausedSourceContinuation.js';
import { effectiveJobSourceCardRunId } from '../../src/utils/jobSourceWarningPolicy.js';
import { sanitizeNodesForSave } from '../../src/utils/serializationUtils.js';
import { collectDeletedBoardChildClaims, retireDeletedManualAiRuns } from '../../src/utils/canvasInteractions.js';
import { collectJobBoardsAffectedByDeletion, getActiveJobBoardSearchReferenceIds, getClearCanvasRetainedNodes, getJobWorkflowDeletionLifecycleRevision, isClearCanvasDeletionFenceIntact, isJobWorkflowDeletionPending, jobBoardHasCancellableRecovery, markJobWorkflowDeletionPending, settleJobWorkflowDeletion, subscribeJobWorkflowDeletionLifecycle } from '../../src/utils/nodeDeletionLifecycle.js';
import { boundedCombinedSourceRuns } from '../../src/utils/jobBoardProvenance.js';
import { exactInterruptedRecoveryAdmission, exactInterruptedRecoveryBackendFailure } from '../../src/utils/jobBoardRecoveryAdmission.js';
import { cancelJobBoardChildrenSequentially, promoteJobBoardPausedSourceResolution, runJobBoardChildFanout } from '../../src/utils/jobBoardChildFanout.js';
import { classifyJobBoardSourceAdmission, completedJobSearchOutcomeMatches, jobSearchOutcomeReceiptMatches, partitionJobBoardSourceAdmissions } from '../../src/utils/jobBoardSourceAdmission.js';
import { jobCareerImportBoardAdmission, jobCareerImportConsumptionPatch, retryableUnstartedJobCareerImportCapability } from '../../src/utils/jobCareerImportCapability.js';
import { buildJobHubCareerClearPatch } from '../../src/utils/hubDropEligibility.js';
import { providerTotalShortfallRecoveryReceipt, resolveManualSourceStopReason, zipRecruiterProviderShortfallRecoveryOutcome, zipRecruiterProviderTotalShortfallWarning } from '../../electron/ipc/browser/manualScraper.js';

export default [
  {
    name: 'Job Board reuses terminal searches, admits only fresh imports, and fences changed completed inputs',
    run() {
      const terminal = {
        id: 'terminal-search',
        type: 'jobhub',
        data: {
          hubState: 'done',
          jobRunId: 'terminal-run',
          resultDisposition: 'scored',
          scoredJobs: [{ title: 'Product Manager', company: 'Example', url: 'https://jobs.example.test/pm', matchScore: 88 }],
        },
      };
      const terminalAdmission = classifyJobBoardSourceAdmission(terminal);
      const freshSource = {
        id: 'fresh-search',
        type: 'jobhub',
        data: {
          hubState: 'empty', inputLocked: true, careerFilePaths: ['/tmp/new-career.pdf'],
          careerImportGeneration: 'career-import:fresh-search:one',
          careerImportFreshCapability: 'career-import:fresh-search:one',
          careerImportConsumption: null,
        },
      };
      const freshImport = classifyJobBoardSourceAdmission(freshSource);
      const pausedSource = {
        id: 'paused-search',
        type: 'jobhub',
        data: {
          hubState: 'sources-ready',
          inputLocked: true,
          careerFilePaths: ['/tmp/new-career.pdf'],
          jobRunId: 'paused-run',
        },
      };
      const paused = classifyJobBoardSourceAdmission(pausedSource);
      const tokenlessPausedSource = {
        id: 'tokenless-paused-search',
        type: 'jobhub',
        data: { hubState: 'sources-ready', inputLocked: true, careerFilePaths: ['/tmp/new-career.pdf'] },
      };
      const tokenlessPaused = classifyJobBoardSourceAdmission(tokenlessPausedSource);
      const legacyPositive = {
        id: 'legacy-positive-search',
        type: 'jobhub',
        data: {
          hubState: 'done',
          scoredJobs: [{ title: 'Legacy Product Manager', company: 'Example', url: 'https://jobs.example.test/legacy', matchScore: 71 }],
        },
      };
      const reanalysisPreserved = {
        id: 'reanalysis-preserved-search',
        type: 'jobhub',
        data: {
          hubState: 'done', jobRunId: 'preserved-run', resultDisposition: 'scored',
          errorMessage: null, reanalysisNotice: 'Temporary scorer failure',
          scoredJobs: [{ title: 'Preserved Product Manager', company: 'Example', url: 'https://jobs.example.test/preserved', matchScore: 81 }],
        },
      };
      const terminalWithoutMergeableResults = classifyJobBoardSourceAdmission({
        id: 'collection-only',
        type: 'jobhub',
        data: {
          hubState: 'done', jobRunId: 'collection-run', resultDisposition: 'collection-only',
          collectionOnly: true, scoredJobs: [],
        },
      });
      const partialModernReceipt = {
        id: 'partial-modern-search',
        type: 'jobhub',
        data: {
          hubState: 'done', jobRunId: 'partial-run',
          scoredJobs: [{ title: 'Partial Receipt', company: 'Example', url: 'https://jobs.example.test/partial', matchScore: 72 }],
        },
      };
      const expected = terminalAdmission.outcome;
      const legacyAdmission = classifyJobBoardSourceAdmission(legacyPositive);
      const preservedAdmission = classifyJobBoardSourceAdmission(reanalysisPreserved);
      const partialAdmission = classifyJobBoardSourceAdmission(partialModernReceipt);
      const partition = partitionJobBoardSourceAdmissions([
        terminal,
        freshSource,
        pausedSource,
        tokenlessPausedSource,
        legacyPositive,
      ]);
      const mutatedSameRun = {
        ...terminal,
        data: {
          ...terminal.data,
          scoredJobs: [{ ...terminal.data.scoredJobs[0], matchScore: 12 }],
        },
      };
      const board = readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      const search = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const selection = readFileSync(new URL('../../src/nodes/jobboard/JobBoardSearchSelection.jsx', import.meta.url), 'utf8');
      const sourceReadyAt = board.indexOf("if (sourceAdmission.kind === 'continue-existing') {");
      const freshPlatformAt = board.indexOf('const runnableSources = getRunnableJobSourceIds(');
      const terminalBoundaryAt = search.indexOf('const ordinaryDoneAdmission = classifyJobBoardSourceAdmission(liveNode);');
      const genericRerunAt = search.indexOf("} else if (recoverInterruptedJobRun || window.electronAPI?.peekJobRun) {");

      assert(terminalAdmission.kind === 'reuse-terminal'
        && freshImport.kind === 'fresh-imported-input'
        && paused.kind === 'continue-existing'
        && tokenlessPaused.kind === 'continuation-requires-run-token'
        && terminalWithoutMergeableResults.kind === 'terminal-requires-fresh-input'
        && partialAdmission.kind === 'terminal-requires-fresh-input',
      'terminal Job Searches must be reusable rather than fresh-scanned; only a cleared and re-imported empty hub is fresh-scan eligible; a paused source requires its exact run token to continue');
      assert(legacyAdmission.kind === 'reuse-terminal'
        && preservedAdmission.kind === 'reuse-terminal'
        && partition.reusable.map(entry => entry.sourceId).join(',') === 'terminal-search,legacy-positive-search'
        && partition.fresh.map(entry => entry.sourceId).join(',') === 'fresh-search'
        && partition.continuations.map(entry => entry.sourceId).join(',') === 'paused-search'
        && partition.blocked.map(entry => entry.sourceId).join(',') === 'tokenless-paused-search',
      'admission partitioning must dispatch only fresh sources, preserve an exact paused generation, and reuse both legacy-positive and failed-but-restored terminal results');
      const legacyReceipt = { runId: null, resultDisposition: null, fingerprint: legacyAdmission.outcome.fingerprint };
      const changedLegacyPositive = {
        ...legacyPositive,
        data: { ...legacyPositive.data, scoredJobs: [{ ...legacyPositive.data.scoredJobs[0], matchScore: 11 }] },
      };
      assert(completedJobSearchOutcomeMatches(terminal, expected)
        && !completedJobSearchOutcomeMatches(mutatedSameRun, expected)
        && completedJobSearchOutcomeMatches(legacyPositive, legacyAdmission.outcome)
        && completedJobSearchOutcomeMatches(legacyPositive, legacyReceipt)
        && !completedJobSearchOutcomeMatches(changedLegacyPositive, legacyReceipt)
        && !completedJobSearchOutcomeMatches(partialModernReceipt, legacyReceipt)
        && jobSearchOutcomeReceiptMatches({ ...legacyAdmission.outcome, legacyPositiveResult: true }, legacyReceipt),
      'a completed source must match its recorded fingerprint as well as run id/disposition before Combine; only an exact null/null legacy receipt bridges normalized legacy provenance');
      const continuationReadiness = jobBoardModuleReadiness({
        hubState: 'sources-ready', ready: true, boardAction: 'continue', statusLabel: 'Resume saved scoring',
      });
      const tokenlessReadiness = jobBoardModuleReadiness({ hubState: 'sources-ready' });
      const mixedPresentation = jobBoardSelectionPresentation([
        { boardAction: 'reuse' }, { boardAction: 'continue', statusLabel: 'Resume saved scoring' },
      ]);
      const tokenlessPresentation = jobBoardSelectionPresentation([{ boardAction: 'continue-blocked' }]);
      assert(continuationReadiness.ready === true
        && tokenlessReadiness.ready === false
        && mixedPresentation.runLabel === 'Resume & combine'
        && mixedPresentation.title.startsWith('Continue the selected Job Search state')
        && tokenlessPresentation.unreadyMessage.startsWith('A selected paused Job Search has no recoverable run token'),
      'selector readiness must honor an explicit Board continuation before raw sources-ready fallback, and paused continuation wording must outrank reuse-only wording');
      assert(board.includes('completedOutcomes.set(sourceId, admission.outcome);')
        && board.includes('!completedJobSearchOutcomeMatches(source, expected)')
        && sourceReadyAt >= 0
        && freshPlatformAt > sourceReadyAt
        && terminalBoundaryAt >= 0
        && genericRerunAt > terminalBoundaryAt
        && board.includes("title: 'Choose Job Search sources'")
        && board.includes('Waiting to start or continue selected sources')
        && board.includes('Waiting to combine saved results')
        && board.includes('manually clear career data, and import fresh files in Job Search before using the Board')
        && selection.includes('Job Search sources')
        && selection.includes('Prioritize this search earlier for recovery and result reconciliation'),
      'Board admission/UI must reuse completed inputs, classify sources-ready before fresh platform checks, fence the executor before generic rerun, and describe parallel-fanout ordering honestly');
      assert(board.includes('partitionJobBoardSourceAdmissions(selectedSourceNodes)')
        && board.includes('initialContinuationSourceIds.has(sourceId)')
        && board.includes('awaitingSourceResolution: pausedContinuation')
        && board.includes('Waiting for ${label} to finish its existing paused search…')
        && search.includes("hubState === 'sources-ready'")
        && search.includes("return searchRunOutcome('paused'")
        && !search.includes('reanalysisPreservedResults')
        && search.includes('reanalysisNotice: error?.message || String(error)')
        && selection.includes('jobBoardSelectionPresentation(selectedRows.map(({ module }) => module))'),
      'a pre-existing sources-ready source must receive a durable Board continuation receipt and pause at the child boundary instead of reaching provider work');
      return { terminalReused: true, freshImportEligible: true, pausedPreserved: true, fingerprintFenced: true, legacyReused: true, preservedReanalysisReused: true };
    },
  },
  {
    name: 'Job Board fresh import capability is one-shot and exact-plan recoverable',
    run() {
      const capability = 'career-import:capability-search:new';
      const fresh = {
        id: 'capability-search',
        type: 'jobhub',
        data: {
          hubState: 'empty', inputLocked: true, careerFilePaths: ['/tmp/capability.pdf'],
          careerImportGeneration: capability,
          careerImportFreshCapability: capability,
          careerImportConsumption: null,
        },
      };
      const admitted = classifyJobBoardSourceAdmission(fresh);
      const initialBoardClaim = jobCareerImportBoardAdmission(fresh.data, {
        capability,
        boardRunId: 'board-capability-run',
        nodeId: fresh.id,
      });
      const claimedData = {
        ...fresh.data,
        ...jobCareerImportConsumptionPatch({
          capability,
          boardRunId: 'board-capability-run',
          origin: 'job-board',
        }),
      };
      const exactReloadClaim = jobCareerImportBoardAdmission(claimedData, {
        capability,
        boardRunId: 'board-capability-run',
        nodeId: fresh.id,
      });
      const wrongBoardClaim = jobCareerImportBoardAdmission(claimedData, {
        capability,
        boardRunId: 'different-board-run',
        nodeId: fresh.id,
      });
      // Compatibility for the shipped ordering bug: login preflight used to
      // spend this exact Board capability before parsing files or starting a
      // provider run. Build the actual persisted, legacy (unversioned) shape
      // explicitly; every newly written claim is versioned and one-shot.
      const { admissionVersion: _legacyAdmissionVersion, ...legacyConsumption } = claimedData.careerImportConsumption;
      const preflightPoisoned = {
        ...claimedData,
        hubState: 'empty',
        careerImportConsumption: legacyConsumption,
        // Setup bookkeeping was written before the old login gate. Neither
        // field proves parsing or provider work, and errorMessage is absent
        // after the app's transient-state persistence cleanup.
        lastCompletedRunAt: 1789300522917,
        locationSnapshot: { searchLocation: { mode: 'city', value: 'Toronto, ON' } },
      };
      const preflightRetryCapability = retryableUnstartedJobCareerImportCapability(preflightPoisoned, {
        nodeId: fresh.id,
      });
      const preflightRetryAdmission = classifyJobBoardSourceAdmission({
        ...fresh,
        data: preflightPoisoned,
      });
      const reclaimBoardRunId = 'board-after-login';
      const preflightReclaim = jobCareerImportBoardAdmission(preflightPoisoned, {
        capability,
        boardRunId: reclaimBoardRunId,
        nodeId: fresh.id,
      });
      const reclaimedPreflightData = {
        ...preflightPoisoned,
        ...jobCareerImportConsumptionPatch({
          capability,
          boardRunId: reclaimBoardRunId,
          origin: 'job-board',
        }),
      };
      const reclaimedPreflightClaim = jobCareerImportBoardAdmission(reclaimedPreflightData, {
        capability,
        boardRunId: reclaimBoardRunId,
        nodeId: fresh.id,
      });
      const poisonedStartedShapes = [
        { resumeProfile: { name: 'Parsed' } },
        { careerData: 'parsed career corpus' },
        { resumeSummary: 'parsed summary' },
        { resumeFingerprint: 'parsed-fingerprint' },
        { jobRunId: 'provider-run' },
        { manualAiResume: { runId: 'manual-run' } },
        { manualAiCleanupReceipts: [{ runId: 'cleanup-run' }] },
        { pendingJobs: [{ title: 'Pending' }] },
        { pendingJobs: [] },
        { queries: ['provider query'] },
        { terminalFinalizationRecovery: { kind: 'terminal-finalization', runId: 'terminal-run' } },
        { resultDisposition: 'empty-complete' },
        { scoredJobs: [{ title: 'Completed' }] },
        { scoredJobs: [] },
        { finalSourceCounts: { google: 1 } },
        { careerFilePaths: [] },
        { careerImportConsumption: { ...legacyConsumption, admissionVersion: 2 } },
        { careerImportConsumption: { ...preflightPoisoned.careerImportConsumption, origin: 'standalone' } },
        { careerImportConsumption: { ...preflightPoisoned.careerImportConsumption, generation: 'different-generation' } },
      ];
      const allStartedShapesBlocked = poisonedStartedShapes.every((patch) => {
        const candidate = { ...preflightPoisoned, ...patch };
        return retryableUnstartedJobCareerImportCapability(candidate, { nodeId: fresh.id }) === null
          && classifyJobBoardSourceAdmission({ ...fresh, data: candidate }).kind === 'fresh-import-requires-clear'
          && jobCareerImportBoardAdmission(candidate, {
            capability,
            boardRunId: reclaimBoardRunId,
            nodeId: fresh.id,
          }).kind === 'missing';
      });
      // Official duplication removes these fields, but imported/tampered
      // canvases can still carry an old data object. The capability itself is
      // node-scoped; a copied Search must not spend the original Search's
      // one-shot fresh-import allowance.
      const copiedCapabilitySource = {
        id: 'copied-capability-search',
        type: 'jobhub',
        data: { ...fresh.data },
      };
      const copiedAdmission = classifyJobBoardSourceAdmission(copiedCapabilitySource);
      const copiedChildClaim = jobCareerImportBoardAdmission(copiedCapabilitySource.data, {
        capability,
        boardRunId: 'board-capability-run',
        nodeId: copiedCapabilitySource.id,
      });
      const exactNodeClaim = jobCareerImportBoardAdmission(fresh.data, {
        capability,
        boardRunId: 'board-capability-run',
        nodeId: fresh.id,
      });
      // A custom/imported node id may contain the capability delimiter. Parse
      // its owner at the final delimiter: a shorter id must not steal that
      // capability just because it is a string prefix of the real owner.
      const colonOwnerId = 'a:b';
      const colonCapability = 'career-import:a:b:entropy';
      const colonOwnedSource = {
        id: colonOwnerId,
        type: 'jobhub',
        data: {
          hubState: 'empty', inputLocked: true, careerFilePaths: ['/tmp/custom-id.pdf'],
          careerImportGeneration: colonCapability,
          careerImportFreshCapability: colonCapability,
          careerImportConsumption: null,
        },
      };
      const delimiterCollisionSource = { ...colonOwnedSource, id: 'a' };
      const colonOwnerAdmission = classifyJobBoardSourceAdmission(colonOwnedSource);
      const delimiterCollisionAdmission = classifyJobBoardSourceAdmission(delimiterCollisionSource);
      const delimiterCollisionChildClaim = jobCareerImportBoardAdmission(
        delimiterCollisionSource.data,
        { capability: colonCapability, boardRunId: 'board-capability-run', nodeId: 'a' },
      );
      const failedOrReset = classifyJobBoardSourceAdmission({
        ...fresh,
        data: { ...claimedData, hubState: 'empty', errorMessage: 'Provider failed' },
      });
      const terminal = classifyJobBoardSourceAdmission({
        id: 'already-done',
        type: 'jobhub',
        data: {
          hubState: 'done', jobRunId: 'terminal-run', resultDisposition: 'scored',
          scoredJobs: [{ title: 'Saved', company: 'Example', url: 'https://jobs.example/saved', matchScore: 80 }],
        },
      });
      const cleared = buildJobHubCareerClearPatch();
      const reimported = classifyJobBoardSourceAdmission({
        ...fresh,
        data: {
          ...claimedData,
          ...cleared,
          inputLocked: true,
          careerFilePaths: ['/tmp/reimported.pdf'],
          careerImportGeneration: 'career-import:capability-search:two',
          careerImportFreshCapability: 'career-import:capability-search:two',
          careerImportConsumption: null,
        },
      });
      const search = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const loginPreflightAt = search.indexOf('// Authenticate before spending a fresh-import capability.');
      const freshCapabilityClaimAt = search.indexOf('// A retained profile/files field is not a fresh Board capability.');
      const freshCapabilityConsumptionAt = search.indexOf("origin: 'job-board',", freshCapabilityClaimAt);
      assert(admitted.kind === 'fresh-imported-input'
        && admitted.freshImportCapability === capability
        && initialBoardClaim.kind === 'fresh'
        && exactReloadClaim.kind === 'owned'
        && wrongBoardClaim.kind === 'missing'
        && copiedAdmission.kind === 'fresh-import-requires-clear'
        && copiedChildClaim.kind === 'missing'
        && exactNodeClaim.kind === 'fresh'
        && colonOwnerAdmission.kind === 'fresh-imported-input'
        && delimiterCollisionAdmission.kind === 'fresh-import-requires-clear'
        && delimiterCollisionChildClaim.kind === 'missing'
        && failedOrReset.kind === 'fresh-import-requires-clear'
        && terminal.kind === 'reuse-terminal'
        && reimported.kind === 'fresh-imported-input',
      'only one newly imported capability may start a fresh Board search; failed/reset retained inputs, copied/tampered tokens, and delimiter-prefix custom node IDs fail closed, the same durable Board plan may recover its claim, terminal results remain dispatch-free, and Clear + re-import mints the next capability');
      assert(preflightRetryCapability === capability
        && preflightRetryAdmission.kind === 'fresh-imported-input'
        && preflightRetryAdmission.freshImportCapability === capability
        && preflightReclaim.kind === 'reclaimable-unstarted'
        && reclaimedPreflightClaim.kind === 'owned'
        && reclaimedPreflightData.careerImportConsumption.admissionVersion === 2
        && allStartedShapesBlocked,
      'only the legacy pre-fix Board-owned, file-retaining, wholly unstarted login-gate shape may move its import capability to a new Board run; setup metadata is allowed, while parsed, provider-started, manual, pending, terminal, standalone, versioned, malformed, and fileless shapes stay blocked');
      assert(loginPreflightAt >= 0
        && freshCapabilityClaimAt > loginPreflightAt
        && freshCapabilityConsumptionAt > loginPreflightAt,
      'the browser-login preflight must complete before a Job Board spends a fresh career-import capability, so signing in after a rejected attempt leaves the Board retryable');
      assert(search.includes('Reclaimed legacy unstarted Board import for post-login retry board=${boardRunId}'),
        'a successful legacy capability reclaim must emit a compact Job Search event proving the compatibility path and new Board run without logging career data');
      return { startsOnce: true, exactRecovery: true, resetBlocked: true, copiedCapabilityBlocked: true, delimiterCollisionBlocked: true, reimportEnabled: true, loginGateRetryable: true, preFixImportReclaimed: true };
    },
  },
  {
    name: 'Job Board selector refreshes recovery-owned source readiness after plan transitions',
    run() {
      const board = readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      const signatureStart = board.indexOf('function normalizeBoardRecoverySourceIds');
      const signatureEnd = board.indexOf('  useEffect(() => {', signatureStart);
      const connectedModulesStart = board.indexOf('const connectedModules = useMemo');
      const connectedModulesEnd = board.indexOf('  const connectedModuleIds = useMemo', connectedModulesStart);
      const signature = board.slice(signatureStart, signatureEnd);
      const connectedModules = board.slice(connectedModulesStart, connectedModulesEnd);
      const connectedSigStart = board.indexOf('const connectedSig = useStore');
      const connectedSigEnd = board.indexOf('const boardRecoverySig = useStore', connectedSigStart);
      const connectedSig = board.slice(connectedSigStart, connectedSigEnd);
      const ownershipSignatureStart = board.indexOf('const boardRecoverySig = useStore');
      const ownershipSignatureEnd = board.indexOf('  useEffect(() => {', ownershipSignatureStart);
      const ownershipSignature = board.slice(ownershipSignatureStart, ownershipSignatureEnd);

      assert(signatureStart >= 0 && signatureEnd > signatureStart
        && signature.includes('new Set(')
        && signature.includes('].sort();')
        && signature.includes('selectedSearchModuleIds:')
        && signature.includes('activeSourceIds:')
        && signature.includes('completedSourceRunIds:')
        && signature.includes('combineSourceRunIds:')
        && signature.includes('cancellationCleanupSourceIds:')
        && signature.includes('cancellation?.sourceId')
        && signature.includes('cancellation?.sourceIds'),
      'the recovery ownership signature helpers must deterministically normalize every scan-plan and cancellation source-id collection used by owner election');
      assert(ownershipSignatureStart >= 0 && ownershipSignatureEnd > ownershipSignatureStart
        && ownershipSignature.includes('const canvasNodes = Array.isArray(store.nodes) ? store.nodes : [];')
        && ownershipSignature.includes('canvasNodes.forEach((node, canvasIndex) => {')
        && ownershipSignature.includes('canvasIndex,')
        && !ownershipSignature.includes('node.position')
        && ownershipSignature.includes("plan?.version === 1 && typeof plan.boardRunId === 'string' && !!plan.boardRunId")
        && ownershipSignature.includes('startedAt: normalizeJobBoardRecoveryTimestamp(plan.startedAt)')
        && ownershipSignature.includes('admissionOrder: normalizeJobBoardAdmissionOrder(plan.admissionOrder)')
        && ownershipSignature.includes("typeof cancellation?.boardRunId === 'string'")
        && ownershipSignature.includes('cancellationSourceIds.length > 0')
        && ownershipSignature.includes('startedAt: normalizeJobBoardRecoveryTimestamp(cancellation.startedAt)')
        && ownershipSignature.includes('admissionOrder: normalizeJobBoardAdmissionOrder(cancellation.admissionOrder)')
        && ownershipSignature.includes("typeof manual?.runId === 'string'")
        && ownershipSignature.includes('manual.retirementPending !== true')
        && ownershipSignature.includes('const manualStartedAt = normalizeJobBoardRecoveryTimestamp(manual?.startedAt)')
        && ownershipSignature.includes('?? normalizeJobBoardRecoveryTimestamp(manual?.updatedAt)')
        && ownershipSignature.includes('sourceIds: manualCombineSourceIds')
        && ownershipSignature.includes('const boardSearchEdges = new Set();')
        && ownershipSignature.includes('boardId: board.id')
        && ownershipSignature.includes('searchId: search.id')
        && ownershipSignature.includes('owners.push(...boardSearchEdges);'),
      'the recovery ownership signature must mirror owner-election eligibility, preserve its canvas-order tie-break without drag churn, and normalize undirected duplicate edges');
      assert(connectedModulesStart >= 0 && connectedModulesEnd > connectedModulesStart
        && connectedModules.includes('boardRecoverySig,')
        && connectedModules.includes('findJobSearchBoardActiveRecoveryOwner'),
      'connected module readiness must recompute when a Board recovery plan is cleared or moves sources between selected, active, completed, combine, or cleanup ownership');
      const probeEffectStart = board.indexOf('const generation = ++interruptedRecoveryProbeGenerationRef.current;');
      const probeEffectEnd = board.indexOf("  useEffect(() => {\n    const onRecoveryLedgerChanged", probeEffectStart);
      const probeEffect = board.slice(probeEffectStart, probeEffectEnd);
      assert(probeEffectStart >= 0 && probeEffectEnd > probeEffectStart
        && probeEffect.includes('findJobSearchBoardActiveRecoveryOwner')
        && probeEffect.includes('boardRecoverySig,'),
      'interrupted-recovery probes must refresh when ordering changes elect a different Board owner');
      assert(connectedSigStart >= 0 && connectedSigEnd > connectedSigStart
        && connectedSig.includes('const sourceCanvasOrder = new Map();')
        && connectedSig.includes('(Array.isArray(s.nodes) ? s.nodes : []).forEach((node) => {')
        && connectedSig.includes('sourceCanvasOrder.set(node.id, sourceCanvasOrder.size);')
        && connectedSig.includes('sourceCanvasOrder: sourceCanvasOrder.get(nid) ?? null')
        && connectedSig.includes('careerImportAdmission: {')
        && connectedSig.includes('generation: n.data?.careerImportGeneration || null')
        && connectedSig.includes('freshCapability: n.data?.careerImportFreshCapability || null')
        && connectedSig.includes('n.data.careerImportConsumption.generation || null')
        && connectedSig.includes('n.data.careerImportConsumption.capability || null')
        && connectedSig.includes('n.data.careerImportConsumption.origin || null')
        && connectedSig.includes('n.data.careerImportConsumption.boardRunId || null')
        && connectedSig.includes('n.data.careerImportConsumption.admissionVersion ?? null')
        && connectedSig.includes('admissionKind: classifyJobBoardSourceAdmission(n).kind')
        && connectedSig.includes("hasTerminalFinalizationRecovery: n.data?.terminalFinalizationRecovery?.kind === 'terminal-finalization'")
        && connectedSig.includes('recoveryProbeSignature: interruptedRecoveryProbeSignature(n.data)')
        && connectedSig.includes('hasCancellationPendingManualAiCleanup: hasCancellationPendingManualAiCleanup(n.data)')
        && !connectedSig.includes('careerImportConsumption.consumedAt')
        && !connectedSig.includes('resumeProfile:')
        && !connectedSig.includes('careerData:')
        && !connectedSig.includes('pendingJobs:')
        && !connectedSig.includes('queries:')
        && !connectedSig.includes('scrapeWarnings:'),
      'connected module readiness must refresh for relative source order, derived admission, terminal-finalization, cleanup, and exact-recovery inputs without serializing profile, query, or warning content');
      const readinessStart = board.indexOf('function moduleSearchReadiness');
      const readinessEnd = board.indexOf('// This is deliberately only a preflight hint.', readinessStart);
      const readiness = board.slice(readinessStart, readinessEnd);
      assert(readinessStart >= 0 && readinessEnd > readinessStart
        && readiness.includes('if (hasCancellationPendingManualAiCleanup(sourceData))')
        && !readiness.includes('(sourceData.manualAiCleanupReceipts || []).some(')
        && board.includes('if (!Array.isArray(receipts)) return [];')
        && board.includes("typeof receipt?.runId !== 'string' || !receipt.runId"),
      'readiness must use the canonical cleanup-receipt normalizer so malformed non-arrays and pending receipts without durable run ids cannot throw or change selector state');
      return { recoveryOwnershipInvalidatesSelector: true, ownershipSourceIdsAndOrderingCovered: true, probeOwnershipInvalidates: true, sourceOrderInvalidatesSelector: true, importAdmissionInvalidatesSelector: true, malformedCleanupSafe: true };
    },
  },
  {
    name: 'Job Board fresh child fan-out starts every runner before any manual handoff settles',
    async run() {
      const started = [];
      const resolvers = new Map();
      const fanout = runJobBoardChildFanout(['search-a', 'search-b', 'search-c'], (sourceId) => {
        started.push(sourceId);
        return new Promise((resolve) => { resolvers.set(sourceId, resolve); });
      });
      await Promise.resolve();
      await Promise.resolve();
      assert(JSON.stringify(started) === JSON.stringify(['search-a', 'search-b', 'search-c']),
        'all selected child runners must issue before the first manual handoff settles');
      const persistedWhilePending = [];
      let fanoutFinished = false;
      // B settles while A/C remain at their manual boundary. The Board's
      // streaming receipt hook is the crash/reload fence: it must run before
      // the all-children join can finish.
      const crashSafeFanout = runJobBoardChildFanout(['handoff-a', 'terminal-b'], (sourceId) => (
        sourceId === 'handoff-a'
          ? new Promise(() => {})
          : Promise.resolve({ status: 'completed', runId: 'run-b' })
      ), {
        onSettled: ({ sourceId, result }) => {
          persistedWhilePending.push({ sourceId, runId: result?.runId || null });
        },
      });
      void crashSafeFanout.then(() => { fanoutFinished = true; });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      assert(JSON.stringify(persistedWhilePending) === JSON.stringify([{ sourceId: 'terminal-b', runId: 'run-b' }])
        && fanoutFinished === false,
      'a terminal sibling must publish its durable receipt before another child handoff settles or the fan-out join returns');
      const commitFailure = await runJobBoardChildFanout(['search-persist-failure'], async () => (
        { status: 'completed', runId: 'failed-commit-run' }
      ), {
        onSettled: async () => { throw new Error('receipt write failed'); },
      });
      assert(commitFailure[0]?.persistenceError?.message === 'receipt write failed',
        'a failed per-child settlement commit must remain visible to the Board final join instead of being silently treated as durable');
      // Settle deliberately out of order.  The helper preserves selected order
      // so the Board can reconcile its durable receipts deterministically.
      resolvers.get('search-c')({ status: 'completed', runId: 'c' });
      resolvers.get('search-a')({ status: 'completed', runId: 'a' });
      resolvers.get('search-b')({ status: 'completed', runId: 'b' });
      const settled = await fanout;
      assert(JSON.stringify(settled.map(item => item.sourceId)) === JSON.stringify(['search-a', 'search-b', 'search-c'])
        && JSON.stringify(settled.map(item => item.result?.runId)) === JSON.stringify(['a', 'b', 'c']),
      'out-of-order child completion must reconcile in the Board selection order');
      const cancelled = [];
      const cancellation = cancelJobBoardChildrenSequentially(['search-a', 'search-b', 'search-c'], async (sourceId) => {
        cancelled.push(sourceId);
        if (sourceId === 'search-a') throw new Error('first child cleanup failed');
        return { sourceId, cancelled: true };
      });
      assert(JSON.stringify(cancelled) === JSON.stringify(['search-a']),
        'multi-child cancellation must serialize durable receipt writes rather than race them');
      await cancellation.then(
        () => { throw new Error('expected the first child cancellation failure'); },
        () => {},
      );
      assert(JSON.stringify(cancelled) === JSON.stringify(['search-a', 'search-b', 'search-c']),
        'multi-child cancellation must still reach every active child');
      const promoted = promoteJobBoardPausedSourceResolution({
        awaitingSourceResolutions: [
          { sourceId: 'search-a', jobRunId: 'run-a' },
          { sourceId: 'search-c', jobRunId: 'run-c' },
        ],
        activeSourceIds: ['search-a', 'search-c'],
        activeSourceRollbacks: { 'search-c': { sourceId: 'search-c', version: 1 } },
        activeSourceManualAiRunIds: { 'search-a': 'manual-a', 'search-c': 'manual-c' },
        consumedSourceId: 'search-a',
      });
      assert(promoted.activeSourceId === 'search-c'
        && promoted.awaitingSourceResolution?.jobRunId === 'run-c'
        && promoted.awaitingSourceResolutions.length === 1
        && promoted.activeSourceRollback?.sourceId === 'search-c'
        && promoted.activeSourceManualAiRunIds?.['search-c'] === 'manual-c'
        && !promoted.activeSourceManualAiRunIds?.['search-a'],
      'after one source-card pause settles, the next durable paused child must be promoted without losing its rollback or exact manual-AI cancellation fence');
      const disconnected = promoteJobBoardPausedSourceResolution({
        activeSourceId: 'search-a',
        activeSourceIds: ['search-a', 'search-b'],
        activeSourceRollbacks: {
          'search-a': { sourceId: 'search-a' },
          'search-b': { sourceId: 'search-b' },
        },
        activeSourceManualAiRunIds: { 'search-a': 'manual-a', 'search-b': 'manual-b' },
        consumedSourceId: 'search-a',
      });
      assert(disconnected.activeSourceId === 'search-b'
        && disconnected.activeSourceIds.length === 1
        && disconnected.activeSourceRollbacks?.['search-b']?.sourceId === 'search-b'
        && disconnected.activeSourceManualAiRunIds?.['search-b'] === 'manual-b'
        && !disconnected.activeSourceManualAiRunIds?.['search-a'],
      'removing one active child must retain exact ownership for a still-running sibling while deleting every disconnected child receipt');
      return { started, reconciled: settled.map(item => item.sourceId), cancelled };
    },
  },
  {
    name: 'Legacy Job Source warning cards adopt only their exact current paused generation',
    run() {
      const legacyProgress = {
        status: 'error',
        warning: { code: 'captcha', severity: 'block' },
      };
      const hubData = {
        hubState: 'sources-ready',
        jobRunId: 'legacy-paused-run',
        scrapeWarnings: [{ sourceId: 'indeed', code: 'captcha', severity: 'block' }],
      };
      const standaloneRunId = effectiveJobSourceCardRunId(
        legacyProgress,
        legacyProgress,
        hubData,
        'indeed',
      );
      const boardNodes = [
        { id: 'legacy-search', type: 'jobhub', data: hubData },
        {
          id: 'legacy-board', type: 'jobboard', data: {
            boardScanResume: {
              version: 1,
              boardRunId: 'legacy-board-run',
              phase: 'searches',
              selectedSearchModuleIds: ['legacy-search'],
              activeSourceId: 'legacy-search',
              awaitingSourceResolution: {
                sourceId: 'legacy-search', jobRunId: 'legacy-paused-run',
              },
            },
          },
        },
      ];
      const boardEdges = [{ source: 'legacy-board', target: 'legacy-search' }];
      const boardOwnedRunId = effectiveJobSourceCardRunId(
        legacyProgress,
        legacyProgress,
        hubData,
        'indeed',
      );
      const boardOwner = findJobSearchBoardPausedContinuationOwner(
        'legacy-search', boardOwnedRunId, boardNodes, boardEdges,
      );
      const cancellableDeletionOwner = findJobSearchBoardCancellablePausedSourceOwner(
        'legacy-search', boardOwnedRunId, boardNodes, boardEdges,
      );
      const solvedContinuationNodes = boardNodes.map((node) => (
        node.id === 'legacy-search'
          ? { ...node, data: {
            ...node.data,
            hubState: 'scoring',
            scrapeWarnings: [],
          } }
          : node
      ));
      const defaultSolvedContinuationOwner = findJobSearchBoardCancellablePausedSourceOwner(
        'legacy-search', boardOwnedRunId, solvedContinuationNodes, boardEdges,
      );
      const resolverOwnedSolvedContinuation = findJobSearchBoardCancellablePausedSourceOwner(
        'legacy-search', boardOwnedRunId, solvedContinuationNodes, boardEdges,
        { allowInFlightContinuation: true },
      );
      const staleRunId = effectiveJobSourceCardRunId(
        { ...legacyProgress, jobRunId: 'older-run' },
        legacyProgress,
        hubData,
        'indeed',
      );
      const explicitMissingRunId = effectiveJobSourceCardRunId(
        { ...legacyProgress, jobRunId: null },
        legacyProgress,
        hubData,
        'indeed',
      );
      const mismatchedGateRunId = effectiveJobSourceCardRunId(
        legacyProgress,
        legacyProgress,
        {
          ...hubData,
          scrapeWarnings: [{ sourceId: 'linkedin', code: 'captcha', severity: 'block' }],
        },
        'indeed',
      );
      const sourceCard = readFileSync(new URL('../../src/nodes/JobSourceCardNode.jsx', import.meta.url), 'utf8');
      assert(standaloneRunId === 'legacy-paused-run'
        && boardOwnedRunId === 'legacy-paused-run'
        && boardOwner?.orchestratorNodeId === 'legacy-board'
        && cancellableDeletionOwner?.orchestratorNodeId === 'legacy-board'
        && defaultSolvedContinuationOwner === null
        && resolverOwnedSolvedContinuation?.orchestratorNodeId === 'legacy-board'
        && staleRunId === 'older-run'
        && explicitMissingRunId === null
        && mismatchedGateRunId === null,
      'a tokenless legacy warning card may adopt only its matching sources-ready gate for standalone, exact Board recovery, or Board-owned deletion; an explicit old/null token and another source gate remain fenced');
      assert(sourceCard.includes('const jobRunId = effectiveJobSourceCardRunId(')
        && sourceCard.includes('const sourceJobRunId = effectiveJobSourceCardRunId(')
        && sourceCard.includes('const cardJobRunId = effectiveJobSourceCardRunId(')
        && sourceCard.includes('const cardOwnsExactInFlightBoardContinuation = !cardOwnsCurrentGate')
        && sourceCard.includes('&& resolveStartedRef.current')
        && sourceCard.includes('{ allowInFlightContinuation: cardOwnsExactInFlightBoardContinuation }')
        && sourceCard.includes('const automaticCleanDismissal = automaticCleanDismissalRef.current')
        && sourceCard.includes('if (automaticCleanDismissal) return;')
        && sourceCard.includes('automaticCleanDismissalRef.current = true;')
        && sourceCard.includes('React Flow returns deletedNodes for an accepted deletion')
        && sourceCard.includes('jobRunId: sourceJobRunId,')
        && sourceCard.includes('detail: { hubId: data.hubId, sourceId: data.sourceId, jobRunId }'),
      'legacy-card Solve, Skip, and unmount cleanup must reuse their one effective generation through source events or exact Board cancellation, while automatic clean-card dismissal leaves a valid Board continuation alone');
      return { standaloneAccepted: true, boardAccepted: true, deletionAccepted: true, solvedContinuationDeletionAccepted: true, automaticCleanDismissalPreserved: true, staleRejected: true, mismatchedGateRejected: true };
    },
  },
  {
    name: 'Job workflow deletion lifecycle wakes recovery on reversible mark and settle',
    run() {
      const before = getJobWorkflowDeletionLifecycleRevision();
      const notifications = [];
      const unsubscribe = subscribeJobWorkflowDeletionLifecycle(() => {
        notifications.push(getJobWorkflowDeletionLifecycleRevision());
      });
      const workflowNodes = [
        { id: 'deletion-board', type: 'jobboard', data: {} },
        {
          id: 'container', type: 'group', data: {
            canvasData: { nodes: [{ id: 'deletion-search', type: 'jobhub', data: {} }] },
          },
        },
      ];
      const ids = markJobWorkflowDeletionPending(workflowNodes);
      const overlappingIds = markJobWorkflowDeletionPending(workflowNodes);
      let firstTransactionSettled = false;
      try {
        assert(JSON.stringify(ids.sort()) === JSON.stringify(['deletion-board', 'deletion-search'])
          && JSON.stringify(overlappingIds.sort()) === JSON.stringify(ids)
          && isJobWorkflowDeletionPending('deletion-board')
          && isJobWorkflowDeletionPending('deletion-search')
          && notifications.length === 1
          && notifications[0] === before + 1,
        'marking a reversible deletion must synchronously publish every nested Board/Search guard without republishing an overlapping guard');
        settleJobWorkflowDeletion(ids);
        firstTransactionSettled = true;
        assert(isJobWorkflowDeletionPending('deletion-board')
          && isJobWorkflowDeletionPending('deletion-search')
          && notifications.length === 1,
        'settling one overlapping deletion transaction must not wake recovery while another boundary still owns the guard');
      } finally {
        if (!firstTransactionSettled) settleJobWorkflowDeletion(ids);
        settleJobWorkflowDeletion(overlappingIds);
        unsubscribe();
      }
      assert(!isJobWorkflowDeletionPending('deletion-board')
        && !isJobWorkflowDeletionPending('deletion-search')
        && notifications.length === 2
        && notifications[1] === before + 2,
      'aborting or committing the deletion must publish guard settlement so retained recovery effects can run again');
      const removedSearch = { id: 'removed-search', type: 'jobhub', data: {} };
      const idleLockedBoard = { id: 'idle-locked-board', type: 'jobboard', data: { locked: true } };
      const recoveredBoard = {
        id: 'recovered-board', type: 'jobboard', data: {
          boardScanResume: {
            boardRunId: 'board-run',
            selectedSearchModuleIds: ['removed-search'],
          },
        },
      };
      const cleanupOnlyBoard = {
        id: 'cleanup-only-board', type: 'jobboard', data: {
          manualAiResume: {
            runId: 'retired-run',
            retirementPending: true,
            combineSourceRuns: [{ sourceId: 'removed-search' }],
          },
        },
      };
      const deletedBoard = { id: 'deleted-board', type: 'jobboard', data: {} };
      const affected = collectJobBoardsAffectedByDeletion(
        [removedSearch, idleLockedBoard, recoveredBoard, cleanupOnlyBoard, deletedBoard],
        [{ source: 'idle-locked-board', target: 'removed-search' }],
        new Set(['removed-search', 'deleted-board']),
      ).map(board => board.id).sort();
      assert(JSON.stringify(affected) === JSON.stringify([
        'deleted-board', 'idle-locked-board', 'recovered-board',
      ])
        && !jobBoardHasCancellableRecovery(idleLockedBoard)
        && jobBoardHasCancellableRecovery(recoveredBoard)
        && !jobBoardHasCancellableRecovery(cleanupOnlyBoard),
      'deletion must elect a pre-marker edge-connected Board and a disconnected durable owner, always include a deleted Board, ignore a disconnected cleanup-only receipt, and allow a locked but genuinely idle Board to acknowledge none safely');
      const fanoutBoard = {
        id: 'fanout-board', type: 'jobboard', data: {
          boardScanResume: {
            version: 1, boardRunId: 'fanout-run', phase: 'searches',
            activeSourceId: 'search-a', activeSourceIds: ['search-a', 'search-b'],
          },
          boardCancellation: { sourceIds: ['search-b', 'search-c'] },
        },
      };
      const fanoutClaims = collectDeletedBoardChildClaims([fanoutBoard]);
      const fanoutReferences = getActiveJobBoardSearchReferenceIds(fanoutBoard).sort();
      assert(JSON.stringify(fanoutClaims.map(claim => claim.sourceId).sort()) === JSON.stringify(['search-a', 'search-b'])
        && JSON.stringify(fanoutReferences) === JSON.stringify(['search-a', 'search-b', 'search-c']),
      'deletion fallbacks must claim each live fan-out child while ownership detection includes plural active and cancellation sources');
      const clearActions = readFileSync(new URL('../../src/hooks/useCanvasActions.js', import.meta.url), 'utf8');
      const osDeletion = readFileSync(new URL('../../src/hooks/useCanvasOSDeletion.js', import.meta.url), 'utf8');
      assert(clearActions.includes('...(Array.isArray(plan?.activeSourceIds) ? plan.activeSourceIds : [])')
        && osDeletion.includes('...(Array.isArray(plan?.activeSourceIds) ? plan.activeSourceIds : [])')
        && clearActions.includes('activeSourceIds.forEach(sourceId =>')
        && osDeletion.includes('activeSourceIds.forEach(sourceId =>'),
      'Clear Canvas and OS deletion must cancel every surviving active Board child when an unmounted Board falls back to direct child cleanup');
      const retainedAfterClear = getClearCanvasRetainedNodes([
        { id: 'locked-board', type: 'jobboard', data: { locked: true } },
        { id: 'board-group', type: 'jobgroup', data: { hubId: 'locked-board' } },
        { id: 'board-card', type: 'jobcard', data: { hubId: 'locked-board' } },
        { id: 'locked-search', type: 'jobhub', data: { locked: true } },
        { id: 'source-card', type: 'jobsourcecard', data: { hubId: 'locked-search' } },
        { id: 'removed-board', type: 'jobboard', data: {} },
        { id: 'orphan-lock', type: 'jobcard', data: { locked: true, hubId: 'removed-board' } },
        { id: 'locked-note', type: 'text', data: { locked: true } },
        { id: 'unlocked-note', type: 'text', data: {} },
      ]).map(node => node.id);
      assert(JSON.stringify(retainedAfterClear) === JSON.stringify([
        'locked-board', 'board-group', 'board-card', 'locked-search', 'source-card', 'locked-note',
      ]),
      'Clear Canvas must preserve a locked Board/Search together with every owned display child, retain ordinary locked nodes, and never leave a locked orphan whose workflow root was removed');
      const initialClearGraph = [
        { id: 'board', type: 'jobboard', data: {} },
        { id: 'board-card-before', type: 'jobcard', data: { hubId: 'board' } },
        { id: 'locked-search', type: 'jobhub', data: { locked: true } },
        { id: 'second-locked-search', type: 'jobhub', data: { locked: true } },
      ];
      assert(isClearCanvasDeletionFenceIntact(initialClearGraph, [
        { id: 'board', type: 'jobboard', data: { boardCancellation: { operationId: 'cancel' } } },
        { id: 'board-card-restored', type: 'jobcard', data: { hubId: 'board' } },
        { id: 'locked-search', type: 'jobhub', data: { locked: true } },
        { id: 'second-locked-search', type: 'jobhub', data: { locked: true } },
      ], [
        { source: 'board', target: 'board-card-before' },
        { source: 'board', target: 'locked-search' },
      ], [
        { source: 'board', target: 'board-card-restored' },
        { source: 'locked-search', target: 'board' },
      ])
        && !isClearCanvasDeletionFenceIntact(initialClearGraph, [
          ...initialClearGraph,
          { id: 'late-board', type: 'jobboard', data: {} },
        ])
        && !isClearCanvasDeletionFenceIntact(initialClearGraph, [
          { id: 'board', type: 'jobboard', data: {} },
          { id: 'board-card-before', type: 'jobcard', data: { hubId: 'board' } },
          { id: 'locked-search', type: 'jobhub', data: { locked: false } },
          { id: 'second-locked-search', type: 'jobhub', data: { locked: true } },
        ])
        && !isClearCanvasDeletionFenceIntact(
          initialClearGraph,
          initialClearGraph,
          [{ source: 'board', target: 'locked-search' }],
          [{ source: 'board', target: 'second-locked-search' }],
        ),
      'Clear Canvas must permit exact cancellation-owned child restoration but fail closed when a root/workflow is added, its retention lock changes, or a root connection is rewired during asynchronous cleanup');
      return { marked: ids.length, notifications, affected, retainedAfterClear };
    },
  },
  {
    name: 'Job Board search selection defaults legacy boards to all connections and preserves an explicit allow-list',
    run() {
      const graphOrder = getConnectedJobSearchIds(
        'board',
        [
          { id: 'search-b', type: 'jobhub' },
          { id: 'note', type: 'text' },
          { id: 'search-a', type: 'jobhub' },
          { id: 'board', type: 'jobboard' },
        ],
        [
          { source: 'search-a', target: 'board' },
          { source: 'board', target: 'search-b' },
          { source: 'note', target: 'board' },
          { source: 'search-b', target: 'board' },
        ],
      );
      assert(JSON.stringify(graphOrder) === JSON.stringify(['search-b', 'search-a']),
        'connected searches must accept either loose-edge direction, ignore other node types, deduplicate edges, and retain canvas-node order');

      const connected = ['search-b', 'search-a', 'search-b', '', null, 'search-c'];
      assert(
        JSON.stringify(getSelectedConnectedJobSearchIds(undefined, connected))
          === JSON.stringify(['search-b', 'search-a', 'search-c'])
        && JSON.stringify(getSelectedConnectedJobSearchIds(null, connected))
          === JSON.stringify(['search-b', 'search-a', 'search-c']),
        'a board saved before selection existed must scan every live connection once, in connection order',
      );
      assert(
        JSON.stringify(getSelectedConnectedJobSearchIds([], connected)) === JSON.stringify([]),
        'an explicit empty allow-list must remain scan-none rather than falling back to the legacy scan-all default',
      );
      assert(
        JSON.stringify(getSelectedConnectedJobSearchIds(
          ['search-a', 'disconnected-search', 'search-a', false, 'search-c'],
          connected,
        )) === JSON.stringify(['search-a', 'search-c']),
        'selection resolution must discard invalid, duplicate, and disconnected ids without letting saved order reorder the live queue',
      );

      const deselectedFromLegacyDefault = toggleSelectedJobSearchId(undefined, 'search-a', connected);
      const selectedFromExplicitEmpty = toggleSelectedJobSearchId([], 'search-c', connected);
      const ignoredDisconnectedToggle = toggleSelectedJobSearchId(['search-a'], 'disconnected-search', connected);
      assert(JSON.stringify(deselectedFromLegacyDefault) === JSON.stringify(['search-b', 'search-c']),
        'the first toggle on a legacy board must begin from all connected modules, then deselect only the requested one');
      assert(JSON.stringify(selectedFromExplicitEmpty) === JSON.stringify(['search-c']),
        'an explicit empty selection can add one connected module without selecting its siblings');
      assert(JSON.stringify(ignoredDisconnectedToggle) === JSON.stringify(['search-a']),
        'a stale UI action for a disconnected module must not add it to the board allow-list');
      assert(toggleSelectedJobSearchId(undefined, 'disconnected-search', connected) === undefined,
        'a stale disconnected toggle must preserve the missing/default-all representation instead of freezing today\'s connections into an explicit subset');

      const whileBDisconnected = toggleSelectedJobSearchId(
        ['search-a', 'search-b'],
        'search-c',
        ['search-a', 'search-c'],
      );
      const afterBReconnects = getSelectedConnectedJobSearchIds(
        whileBDisconnected,
        ['search-a', 'search-b', 'search-c'],
      );
      assert(JSON.stringify(whileBDisconnected) === JSON.stringify(['search-a', 'search-c', 'search-b'])
        && JSON.stringify(afterBReconnects) === JSON.stringify(['search-a', 'search-b', 'search-c']),
      'toggling a visible Search while another selected Search is disconnected must preserve that hidden intent and restore it on reconnect');

      const executionOrder = orderJobSearchIds(
        ['search-c', 'search-a', 'disconnected-search', 'search-c'],
        ['search-a', 'search-b', 'search-c'],
      );
      const movedExecutionOrder = moveJobSearchExecutionOrder(
        ['search-c', 'search-a', 'disconnected-search'],
        ['search-a', 'search-b', 'search-c'],
        'search-b',
        'up',
      );
      assert(JSON.stringify(executionOrder) === JSON.stringify(['search-c', 'search-a', 'search-b'])
        && JSON.stringify(movedExecutionOrder) === JSON.stringify([
          'search-c', 'search-b', 'search-a', 'disconnected-search',
        ])
        && JSON.stringify(orderJobSearchIds(undefined, ['search-a', 'search-b'])) === JSON.stringify(['search-a', 'search-b']),
      'execution priority must be separate from selection membership, tolerate stale ids, and fall back to canvas order for legacy Boards and new connections');

      const boardSource = readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      const toggleStart = boardSource.indexOf('const toggleSearchModule = useCallback');
      const toggleEnd = boardSource.indexOf('\n\n  // Positive scored jobs', toggleStart);
      const toggleHandler = boardSource.slice(toggleStart, toggleEnd);
      assert(toggleHandler.includes('const toggleSearchModule = useCallback((moduleId, checked) => {')
        && toggleHandler.includes('const connectedAtEvent = getConnectedJobSearchIds(id, getNodes(), getEdges());')
        && toggleHandler.includes('if (!connectedAtEvent.includes(moduleId)) return;')
        && toggleHandler.includes('updateGlobal(id, (node) => {')
        && toggleHandler.includes('const liveConnectedIds = getConnectedJobSearchIds(id, getNodes(), getEdges());')
        && toggleHandler.includes('if (!liveConnectedIds.includes(moduleId)) return null;')
        && toggleHandler.includes('const liveSelection = node?.data?.selectedSearchModuleIds;')
        && toggleHandler.includes('currentlySelected === checked')
        && toggleHandler.includes('liveSelection,')
        && toggleHandler.includes('moduleId,\n        liveConnectedIds,'),
      'the checkbox handler must reject an edge-removal race, derive rapid toggles from functional live node data, and idempotently honor each event\'s checked state');
      const scanStart = boardSource.indexOf('const handleSearchSelected = useCallback');
      const scanEnd = boardSource.indexOf('const settleRecoveredCombine = useCallback', scanStart);
      const scanHandler = boardSource.slice(scanStart, scanEnd);
      assert(boardSource.includes('const executionOrderedConnectedIds = useMemo(')
        && boardSource.includes('const executionOrderedModules = useMemo(() => {')
        && boardSource.includes('const moveSearchModule = useCallback((moduleId, direction) => {')
        && scanHandler.includes('const configuredSelectedIds = orderJobSearchIds(')
        && scanHandler.includes('liveBoardData.searchExecutionOrder,')
        && scanHandler.includes('selectedSearchModuleIds: transactionSelectedIds,'),
      'the Board must display and admit the explicit execution priority while freezing its resolved sequential order in the durable scan plan');
      return { legacyDefault: 3, explicitEmpty: 0, selected: ['search-a', 'search-c'], reconnectPreserved: true, executionOrder: ['search-c', 'search-a', 'search-b'] };
    },
  },
  {
    name: 'Job Board search selector gives duplicate labels stable visible and accessible discriminators',
    run() {
      const selection = readFileSync(new URL('../../src/nodes/jobboard/JobBoardSearchSelection.jsx', import.meta.url), 'utf8');
      const selectionPolicy = readFileSync(new URL('../../src/utils/jobBoardSearchSelection.js', import.meta.url), 'utf8');
      assert(selectionPolicy.includes("'evaluating-preferences', 'scoring',")
        && selection.includes('const idsByLabel = new Map();')
        && selection.includes('const suffix = shortestUniqueIdSuffix(row.module.id, peerIds);')
        && selection.includes('if (peerIds.length < 2) return { ...row, discriminator: null };')
        && selection.includes('peerId.slice(-length) !== suffix')
        && selection.includes('{discriminator.visible}')
        && selection.includes('aria-label={discriminator?.accessibleName || `Select ${label} to start or continue`}')
        && selection.includes('jobBoardModuleReadiness(module)'),
      'the selector must render every active Search phase consistently, and only colliding role/location labels receive a stable visible and accessible node-id suffix');
      return { collisionScoped: true, visible: true, accessible: true };
    },
  },
  {
    name: 'Job Board primary action makes enabled and disabled idle states distinct',
    run() {
      const selection = readFileSync(new URL('../../src/nodes/jobboard/JobBoardSearchSelection.jsx', import.meta.url), 'utf8');
      assert(selection.includes('const primaryActionDisabledReason = !running && !recoveryError && !canRun')
        && selection.includes('aria-describedby={primaryActionDisabledReason ? actionDisabledReasonId : undefined}')
        && selection.includes('data-action-state={running ? \'running\' : (canRun ? \'enabled\' : \'disabled\')}')
        && selection.includes('id={actionDisabledReasonId}')
        && selection.includes("'border-indigo-300/80 bg-indigo-500 text-white shadow-[0_0_16px_rgba(99,102,241,0.45)]")
        && selection.includes("'border-white/10 bg-white/[0.04] text-white/35 shadow-none opacity-70'")
        && selection.includes("'border-rose-500/25 bg-rose-500/15 text-rose-100 hover:bg-rose-500/25 disabled:opacity-40'"),
      'an available idle Board action must have an unmistakable primary treatment, while a disabled action is explicitly muted and exposes its reason without changing the running Cancel treatment');
      return { enabledPrimary: true, disabledMuted: true, disabledReasonDescribed: true, runningCancelPreserved: true };
    },
  },
  {
    name: 'Job Board recovery ignores a plan cleared before stale-effect re-entry',
    run() {
      const board = readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      const identityStart = board.indexOf('function isCurrentBoardScanResume(livePlan, expectedPlan)');
      const admissionStart = board.indexOf('const handleSearchSelected = useCallback');
      const admissionEnd = board.indexOf('const settleRecoveredCombine = useCallback', admissionStart);
      const admission = board.slice(admissionStart, admissionEnd);
      const recoveryStart = board.indexOf('// A Board-owned child can survive an app restart');
      const recoveryEffectStart = board.indexOf('\n  useEffect(() => {', recoveryStart);
      const recoveryEnd = board.indexOf('\n  useEffect(() => {', recoveryEffectStart + 1);
      const recovery = board.slice(recoveryStart, recoveryEnd);
      const admissionGuardAt = admission.indexOf('if (resumePlan && !isCurrentBoardScanResume(');
      const recoveryGuardAt = recovery.indexOf('if (!isCurrentBoardScanResume(getNode(id)?.data?.boardScanResume, plan))');
      const recoveryLogAt = recovery.indexOf('EventLogger.log(`[JobBoard] Resuming interrupted selected search');
      assert(identityStart >= 0
        && admissionGuardAt >= 0
        && admission.includes("return { status: 'superseded' };")
        && recoveryGuardAt >= 0
        && recoveryLogAt > recoveryGuardAt,
      'a recovery effect rendered before plan retirement must check the live Board plan before logging/re-entering, and its handler must reject the same stale plan at admission');
      return { liveIdentityGuarded: true, staleAdmissionRejected: true, ghostRecoveryLogPrevented: true };
    },
  },
  {
    name: 'Job Board combine signatures preserve imported delimiter-bearing ids',
    run() {
      const unusualId = 'search|west=priority';
      const anotherId = 'search=east|priority';
      const signature = combineSignature([
        { id: unusualId, fingerprint: '7:one' },
        { id: anotherId, fingerprint: '7:two' },
      ]);
      const parsed = parseCombineSignature(signature);
      assert(signature.startsWith('8:')
        && parsed.valid
        && parsed.entries.length === 2
        && parsed.entries.some(([id, fingerprint]) => id === unusualId && fingerprint === '7:one')
        && parsed.entries.some(([id, fingerprint]) => id === anotherId && fingerprint === '7:two'),
      'versioned combine signatures must preserve every unusual imported node id as one exact source identity');
      assert(combineSignature([{ id: unusualId, fingerprint: '7:one' }])
        !== combineSignature([{ id: 'search', fingerprint: 'priority=7:one' }]),
      'delimiter-bearing ids and fingerprints must not collide with a different source/fingerprint pair');
      assert(combineSignature([
        { id: 'search-a', fingerprint: '7:11:22' },
        { id: 'search-b', fingerprint: '7:33:44' },
      ]) === 'search-a=7:11:22|search-b=7:33:44',
      'ordinary v7 Board signatures must retain their delimiter form so existing durable equality/recovery fences remain current after upgrade');
      const reservedPrefixSignature = combineSignature([{ id: '8:imported-search', fingerprint: '7:55:66' }]);
      assert(reservedPrefixSignature.startsWith('8:[[')
        && parseCombineSignature(reservedPrefixSignature).valid
        && parseCombineSignature(reservedPrefixSignature).entries[0][0] === '8:imported-search'
        && !isLegacyCombineSignature(reservedPrefixSignature),
      'an imported id beginning with the reserved v8 prefix must use structured serialization instead of being misread as corrupt v8 data');
      const historicalPrefixSignature = '8:historical-import=7:55:66';
      assert(parseCombineSignature(historicalPrefixSignature).valid
        && parseCombineSignature(historicalPrefixSignature).entries[0][0] === '8:historical-import'
        && !isLegacyCombineSignature(historicalPrefixSignature),
      'a valid pre-v8 delimiter signature whose imported id starts with 8: must remain readable after upgrade');
      assert(!parseCombineSignature('8:not-json').valid
        && !parseCombineSignature('unparseable-row').valid
        && !isLegacyCombineSignature('8:not-json')
        && staleReason('8:not-json', [{ id: 'search-a', fingerprint: '7:11:22' }]) === '1 added',
      'a bare malformed v8 prefix must fail closed instead of being split into a synthetic source id or adopted as legacy provenance');
      const corruptV8 = '8:[["search-a","7:11:22"]';
      assert(!parseCombineSignature(corruptV8).valid
        && !isLegacyCombineSignature(corruptV8)
        && staleReason(corruptV8, [{ id: 'search-a', fingerprint: '7:11:22' }]) === '1 added',
      'a corrupt v8 signature must not be adopted as legacy: the Board sees a live-input mismatch and marks its old cascade stale');

      const originals = [
        { id: 'board', type: 'jobboard', data: { resultCount: 1, combineSignature: signature } },
        { id: unusualId, type: 'jobhub', data: { hubState: 'done', scoredJobs: [] } },
        { id: 'card', type: 'jobcard', data: { hubId: 'board', originHubId: unusualId } },
      ];
      const copied = remapCopiedJobModuleReferences(
        originals,
        [
          { id: 'copy-board', type: 'jobboard', data: {} },
          { id: 'copy-search|west=priority', type: 'jobhub', data: { hubState: 'done', scoredJobs: [] } },
          { id: 'copy-card', type: 'jobcard', data: {} },
        ],
        new Map([
          ['board', 'copy-board'],
          [unusualId, 'copy-search|west=priority'],
          ['card', 'copy-card'],
        ]),
      );
      const copiedSignature = parseCombineSignature(copied[0].data.combineSignature);
      assert(copiedSignature.valid
        && copiedSignature.entries.some(([id, fingerprint]) => (
          id === 'copy-search|west=priority'
          && fingerprint === moduleCombineFingerprint([], {})
        ))
        && copiedSignature.entries.some(([id, fingerprint]) => id === anotherId && fingerprint === '7:two'),
      'a complete copied Board must remap a delimiter-bearing Search id without truncating it or losing external historical provenance');
      return { signatureFormat: 'v8', unusualIdsRoundTrip: true, malformedFailsClosed: true };
    },
  },
  {
    name: 'Batch duplicate and paste remap explicit Job Board search selections',
    run() {
      const originals = [
        {
          id: 'board-subset', type: 'jobboard',
          data: {
            selectedSearchModuleIds: ['search-b', 'missing-search'],
            searchExecutionOrder: ['search-b', 'search-a', 'missing-search'],
            queuedModuleRun: { position: 1 },
            manualAiResume: { runId: 'old-manual-run' },
            boardScanResume: { boardRunId: 'old-board-run' },
          },
        },
        { id: 'board-none', type: 'jobboard', data: { selectedSearchModuleIds: [] } },
        { id: 'board-default', type: 'jobboard', data: {} },
        { id: 'search-a', type: 'jobhub', data: {} },
        { id: 'search-b', type: 'jobhub', data: {} },
      ];
      const clones = [
        { id: 'copy-board-subset', type: 'jobboard', data: { resultCount: 2 } },
        { id: 'copy-board-none', type: 'jobboard', data: {} },
        { id: 'copy-board-default', type: 'jobboard', data: {} },
        { id: 'copy-search-a', type: 'jobhub', data: {} },
        { id: 'copy-search-b', type: 'jobhub', data: {} },
      ];
      const idMap = new Map(originals.map((node, index) => [node.id, clones[index].id]));
      const copiedEdges = [
        { source: 'board-subset', target: 'search-a' },
        { source: 'search-b', target: 'board-subset' },
      ];
      const remapped = remapCopiedJobBoardSelections(originals, clones, idMap, copiedEdges);
      const subset = remapped.find(node => node.id === 'copy-board-subset');
      const none = remapped.find(node => node.id === 'copy-board-none');
      const defaultAll = remapped.find(node => node.id === 'copy-board-default');

      assert(JSON.stringify(subset.data.selectedSearchModuleIds) === JSON.stringify(['copy-search-b'])
        && JSON.stringify(subset.data.searchExecutionOrder) === JSON.stringify(['copy-search-b', 'copy-search-a'])
        && subset.data.resultCount === 2
        && !('queuedModuleRun' in subset.data)
        && !('manualAiResume' in subset.data)
        && !('boardScanResume' in subset.data),
      'a copied Board must translate its selection and independent execution priority only to Job Searches present in the same batch while preserving sanitized durable data and never restoring original run markers');
      assert(Array.isArray(none.data.selectedSearchModuleIds) && none.data.selectedSearchModuleIds.length === 0,
        'an explicit scan-none Board selection must remain explicit after a batch copy');
      assert(!Object.prototype.hasOwnProperty.call(defaultAll.data, 'selectedSearchModuleIds'),
        'a missing Board allow-list must remain missing so legacy/default-all behavior is preserved');

      const boardOnly = remapCopiedJobBoardSelections(
        [{ id: 'board-only', type: 'jobboard', data: { selectedSearchModuleIds: ['old-search'], searchExecutionOrder: ['old-search'] } }],
        [{ id: 'copy-board-only', type: 'jobboard', data: {} }],
        new Map([['board-only', 'copy-board-only']]),
        [],
      )[0];
      assert(!Object.prototype.hasOwnProperty.call(boardOnly.data, 'selectedSearchModuleIds'),
        'a Board copied without any connected Search must retain cloneNode default-all behavior for connections added later');
      assert(!Object.prototype.hasOwnProperty.call(boardOnly.data, 'searchExecutionOrder'),
        'a Board copied without a connected Search must not retain execution ids pointing at the original canvas');

      const unselectedConnection = remapCopiedJobBoardSelections(
        [
          { id: 'board-with-a', type: 'jobboard', data: { selectedSearchModuleIds: ['search-b-not-copied'] } },
          { id: 'search-a-only', type: 'jobhub', data: {} },
        ],
        [
          { id: 'copy-board-with-a', type: 'jobboard', data: {} },
          { id: 'copy-search-a-only', type: 'jobhub', data: {} },
        ],
        new Map([['board-with-a', 'copy-board-with-a'], ['search-a-only', 'copy-search-a-only']]),
        [{ source: 'board-with-a', target: 'search-a-only' }],
      )[0];
      assert(Array.isArray(unselectedConnection.data.selectedSearchModuleIds)
        && unselectedConnection.data.selectedSearchModuleIds.length === 0,
      'a copied edge to an explicitly unselected Search must remain unselected instead of reverting to default-all');

      const temporarilyDisconnectedSelection = remapCopiedJobBoardSelections(
        [
          { id: 'board-reconnect', type: 'jobboard', data: { selectedSearchModuleIds: ['search-b-reconnect'] } },
          { id: 'search-a-reconnect', type: 'jobhub', data: {} },
          { id: 'search-b-reconnect', type: 'jobhub', data: {} },
        ],
        [
          { id: 'copy-board-reconnect', type: 'jobboard', data: {} },
          { id: 'copy-search-a-reconnect', type: 'jobhub', data: {} },
          { id: 'copy-search-b-reconnect', type: 'jobhub', data: {} },
        ],
        new Map([
          ['board-reconnect', 'copy-board-reconnect'],
          ['search-a-reconnect', 'copy-search-a-reconnect'],
          ['search-b-reconnect', 'copy-search-b-reconnect'],
        ]),
        [{ source: 'board-reconnect', target: 'search-a-reconnect' }],
      )[0];
      assert(JSON.stringify(temporarilyDisconnectedSelection.data.selectedSearchModuleIds)
        === JSON.stringify(['copy-search-b-reconnect']),
      'a copied selected Search must retain its allow-list identity while temporarily disconnected, so reconnecting the copy does not lose the user’s selection intent');

      const actions = readFileSync(new URL('../../src/hooks/useCanvasActions.js', import.meta.url), 'utf8');
      assert((actions.match(/remapCopiedJobModuleReferences\(/g) || []).length === 2,
        'both direct duplicate and clipboard paste must run the graph-aware Board selection remap after allocating the complete batch id map');
      return {
        subset: subset.data.selectedSearchModuleIds,
        explicitNone: none.data.selectedSearchModuleIds,
        defaultAll: true,
        boardOnlyDefaultAll: true,
        disconnectedCopiedSelection: temporarilyDisconnectedSelection.data.selectedSearchModuleIds,
      };
    },
  },
  {
    name: 'Batch duplicate and paste isolate copied Job Board and Job Search child ownership',
    run() {
      const remoteResidences = {
        canada: { city: 'Toronto', subdivision: 'ON', countryCode: 'CA' },
      };
      const originalScoredJobs = [{
        title: 'Platform Engineer',
        company: 'Acme',
        url: 'https://example.test/job/1',
        matchScore: 91,
        originHubId: 'search',
      }];
      const originalFingerprint = moduleCombineFingerprint(originalScoredJobs, remoteResidences);
      const originals = [
        {
          id: 'board', type: 'jobboard',
          data: {
            hubState: 'done',
            resultCount: 2,
            selectedSearchModuleIds: ['search'],
            combineSignature: combineSignature([{ id: 'search', fingerprint: originalFingerprint }]),
            combineSourceRuns: boundedCombinedSourceRuns([
              { id: 'search', runId: 'search-run' },
            ]),
          },
        },
        {
          id: 'search', type: 'jobhub',
          data: {
            hubState: 'done',
            scoredJobs: originalScoredJobs,
            preferenceCandidatePool: [{
              title: 'Saved candidate',
              company: 'Acme',
              originHubId: 'search',
            }],
            remoteResidences,
          },
        },
        { id: 'root-group', type: 'jobgroup', data: { hubId: 'board', childIds: ['role-group', 'job-card', 'not-copied'] } },
        { id: 'role-group', type: 'jobgroup', data: { hubId: 'board', childIds: ['job-card'] } },
        { id: 'job-card', type: 'jobcard', data: { hubId: 'board', originHubId: 'search' } },
        { id: 'source-card', type: 'jobsourcecard', data: { hubId: 'search', sourceId: 'indeed' } },
        { id: 'external-origin-card', type: 'jobcard', data: { hubId: 'board', originHubId: 'search-not-copied' } },
      ];
      const clones = originals.map(node => ({
        ...node,
        id: `copy-${node.id}`,
        data: { ...(node.data || {}) },
      }));
      const idMap = new Map(originals.map(node => [node.id, `copy-${node.id}`]));
      const remapped = remapCopiedJobModuleReferences(
        originals,
        clones,
        idMap,
        [
          { source: 'board', target: 'search' },
          { source: 'search', target: 'source-card' },
          { source: 'board', target: 'root-group' },
        ],
      );
      const byId = new Map(remapped.map(node => [node.id, node]));

      assert(byId.get('copy-root-group').data.hubId === 'copy-board'
        && byId.get('copy-role-group').data.hubId === 'copy-board'
        && byId.get('copy-job-card').data.hubId === 'copy-board'
        && byId.get('copy-external-origin-card').data.hubId === 'copy-board',
      'every copied result node must be owned by the copied Board rather than remain in the original Board cascade');
      assert(byId.get('copy-source-card').data.hubId === 'copy-search',
        'a copied source card must be owned by the copied Job Search rather than remain in the original Search lifecycle');
      assert(JSON.stringify(byId.get('copy-root-group').data.childIds) === JSON.stringify(['copy-role-group', 'copy-job-card'])
        && JSON.stringify(byId.get('copy-role-group').data.childIds) === JSON.stringify(['copy-job-card']),
      'copied group trees must translate copied child ids and drop references to children outside the batch');
      assert(byId.get('copy-job-card').data.originHubId === 'copy-search'
        && byId.get('copy-external-origin-card').data.originHubId === 'search-not-copied',
      'copied cards must follow copied origin Searches without destroying intentional external provenance');
      const copiedSearch = byId.get('copy-search');
      const copiedFingerprint = moduleCombineFingerprint(copiedSearch.data.scoredJobs, remoteResidences);
      assert(copiedSearch.data.scoredJobs[0].originHubId === 'copy-search'
        && copiedSearch.data.preferenceCandidatePool[0].originHubId === 'copy-search'
        && originalScoredJobs[0].originHubId === 'search'
        && originals[1].data.preferenceCandidatePool[0].originHubId === 'search',
      'stored scored and saved-preference candidate provenance must follow a copied Search without mutating the original result generation or letting later re-analysis restore old ownership');
      assert(byId.get('copy-board').data.combineSourceRuns[0].sourceHubId === 'copy-search'
        && !Object.hasOwn(byId.get('copy-board').data.combineSourceRuns[0], 'sourceId')
        && byId.get('copy-board').data.combineSourceRuns[0].runId === 'search-run'
        && byId.get('copy-board').data.combineSignature
          === combineSignature([{ id: 'copy-search', fingerprint: copiedFingerprint }]),
      'a fully copied completed cascade must remap its real bounded sourceHubId receipt and rebuild its versioned signature against copied Search ids, rather than mounting immediately stale or pointing Clear/report provenance back to the original Search');

      const legacyReceiptCopy = remapCopiedJobModuleReferences(
        [
          { id: 'legacy-board', type: 'jobboard', data: { combineSourceRuns: [{ sourceId: 'search', runId: 'legacy-run', fingerprint: originalFingerprint }] } },
          originals[1],
        ],
        [
          { id: 'copy-legacy-board', type: 'jobboard', data: {} },
          { id: 'copy-search', type: 'jobhub', data: copiedSearch.data },
        ],
        new Map([['legacy-board', 'copy-legacy-board'], ['search', 'copy-search']]),
      )[0];
      assert(legacyReceiptCopy.data.combineSourceRuns[0].sourceId === 'copy-search'
        && legacyReceiptCopy.data.combineSourceRuns[0].fingerprint === copiedFingerprint
        && !Object.hasOwn(legacyReceiptCopy.data.combineSourceRuns[0], 'sourceHubId'),
      'legacy sourceId recovery receipts must still remap and retain their legacy schema without being mistaken for bounded completed-Board provenance');

      const historicalFingerprint = '7:historical-search-fingerprint';
      const externalFingerprint = '7:historical-external-fingerprint';
      const clearedBoardCopy = remapCopiedJobModuleReferences(
        [
          {
            id: 'cleared-board', type: 'jobboard', data: {
              clearProvenance: {
                clearedAt: 1_750_000_000_000,
                priorResultCount: 3,
                priorSourceRuns: [
                  { sourceHubId: 'search', runId: 'search-run' },
                  { sourceHubId: 'external-search', runId: 'external-run' },
                ],
                priorCombineSignature: combineSignature([
                  { id: 'search', fingerprint: historicalFingerprint },
                  { id: 'external-search', fingerprint: externalFingerprint },
                ]),
              },
            },
          },
          originals[1],
        ],
        [
          { id: 'copy-cleared-board', type: 'jobboard', data: {} },
          { id: 'copy-search', type: 'jobhub', data: copiedSearch.data },
        ],
        new Map([['cleared-board', 'copy-cleared-board'], ['search', 'copy-search']]),
      )[0];
      assert(JSON.stringify(clearedBoardCopy.data.clearProvenance.priorSourceRuns) === JSON.stringify([
        { sourceHubId: 'copy-search', runId: 'search-run' },
        { sourceHubId: 'external-search', runId: 'external-run' },
      ])
        && clearedBoardCopy.data.clearProvenance.priorCombineSignature === combineSignature([
          { id: 'copy-search', fingerprint: historicalFingerprint },
          { id: 'external-search', fingerprint: externalFingerprint },
        ])
        && clearedBoardCopy.data.clearProvenance.clearedAt === 1_750_000_000_000
        && clearedBoardCopy.data.clearProvenance.priorResultCount === 3,
      'a copied cleared Board must remap only copied Search identities while preserving external source references and every historical fingerprint/count field exactly');

      const partialCopy = remapCopiedJobModuleReferences(
        originals.slice(0, 2),
        clones.slice(0, 2),
        new Map([['board', 'copy-board'], ['search', 'copy-search']]),
        [{ source: 'board', target: 'search' }],
      );
      assert(partialCopy[0].data.hubState === 'empty'
        && !Object.hasOwn(partialCopy[0].data, 'resultCount')
        && !Object.hasOwn(partialCopy[0].data, 'combineSignature')
        && !Object.hasOwn(partialCopy[0].data, 'combineSourceRuns'),
      'a Board copied without its complete result-card cascade must start empty instead of falsely reporting results whose cards were not copied');

      const partialCascadeCopy = remapCopiedJobModuleReferences(
        originals,
        [
          { id: 'partial-board', type: 'jobboard', data: {} },
          { id: 'partial-search', type: 'jobhub', data: {} },
          { id: 'partial-card', type: 'jobcard', data: { hubId: 'board', originHubId: 'search' } },
        ],
        new Map([['board', 'partial-board'], ['search', 'partial-search'], ['job-card', 'partial-card']]),
        [{ source: 'board', target: 'search' }, { source: 'board', target: 'job-card' }],
      );
      assert(partialCascadeCopy.length === 2
        && partialCascadeCopy.every(node => node.type !== 'jobcard')
        && partialCascadeCopy.find(node => node.id === 'partial-board')?.data.hubState === 'empty',
      'a partial Board cascade copy must drop copied board-owned cards/groups too, so an empty cloned Board cannot leave orphaned visible results');

      const legacyNoCountCopy = remapCopiedJobModuleReferences(
        [{ id: 'legacy-board', type: 'jobboard', data: { hubState: 'done', combineSignature: 'search=7:1:2' } }],
        [{ id: 'copy-legacy-board', type: 'jobboard', data: {} }],
        new Map([['legacy-board', 'copy-legacy-board']]),
      )[0];
      assert(legacyNoCountCopy.data.hubState === 'empty'
        && !Object.hasOwn(legacyNoCountCopy.data, 'combineSignature'),
      'a legacy terminal Board with no result count or copied cards is unverified and must start empty rather than masquerade as a completed zero-result copy');

      const actions = readFileSync(new URL('../../src/hooks/useCanvasActions.js', import.meta.url), 'utf8');
      assert((actions.match(/const retainedNewNodeIds = new Set\(newNodes\.map/g) || []).length === 2
        && actions.includes('retainedNewNodeIds.has(source) && retainedNewNodeIds.has(target)'),
      'direct duplicate and clipboard paste must omit edges to display children removed from an incomplete Board cascade copy');
      return {
        boardChildren: 4,
        searchChildren: 1,
        treeReferencesIsolated: true,
        originSearchRemapped: true,
        completedSignatureRemapped: true,
      };
    },
  },
  {
    name: 'A pending Search recovery remains owned by its exact Job Board transaction',
    run() {
      const nodes = [
        {
          id: 'search', type: 'jobhub',
          data: { manualAiResume: { runId: 'manual-run', orchestratorNodeId: 'board-a', boardRunId: 'board-a-run' } },
        },
        {
          id: 'board-b', type: 'jobboard',
          data: { boardScanResume: { version: 1, boardRunId: 'board-b-run', phase: 'searches', activeSourceId: 'search', selectedSearchModuleIds: ['search'] } },
        },
        {
          id: 'board-a', type: 'jobboard',
          data: { boardScanResume: { version: 1, boardRunId: 'board-a-run', phase: 'searches', activeSourceId: 'search', selectedSearchModuleIds: ['search'] } },
        },
      ];
      const edges = [
        { source: 'search', target: 'board-a' },
        { source: 'board-b', target: 'search' },
      ];
      const owner = findJobSearchBoardRecoveryOwner('search', 'manual-run', nodes, edges);
      const mapOwner = findJobSearchBoardRecoveryOwner('search', 'manual-run', new Map(nodes.map(node => [node.id, node])), edges);
      assert(owner?.orchestratorNodeId === 'board-a' && owner?.boardRunId === 'board-a-run'
        && JSON.stringify(mapOwner) === JSON.stringify(owner),
      'the child marker must disambiguate competing durable Board plans regardless of node collection shape');
      assert(findJobSearchBoardRecoveryOwner('search', 'different-run', nodes, edges) === null,
        'a Board plan must never claim a different manual-AI generation');
      const mismatchedNodes = nodes.map(node => node.id === 'search'
        ? { ...node, data: { manualAiResume: { runId: 'manual-run', orchestratorNodeId: 'deleted-board', boardRunId: 'deleted-run' } } }
        : node);
      const missingOwner = findJobSearchBoardRecoveryOwner('search', 'manual-run', mismatchedNodes, edges);
      assert(missingOwner?.missingPlan === true
        && missingOwner.orchestratorNodeId === 'deleted-board'
        && missingOwner.boardRunId === 'deleted-run',
      'an explicit child owner that matches no live plan must fail closed instead of falling back to a competing Board');
      return owner;
    },
  },
  {
    name: 'Job coordinator preserves exact closing cancellers but never dispatches a retired Search runner',
    run: async () => {
      const registry = createJobSearchCoordinatorRegistry();
      const calls = [];
      const unregisterSearch = registry.registerSearchModule(
        'shared-search',
        () => calls.push('stale-runner'),
        (options) => calls.push(`search-cancel:${options.reason}`),
      );
      const pendingRunner = registry.runSearchModule('shared-search');
      unregisterSearch();
      // Cancellation is intentionally still callable synchronously during the
      // two-microtask unmount cleanup grace window.
      const closingSearchCancelPromise = registry.cancelSearchModule(
        'shared-search',
        { reason: 'unmount-cleanup' },
      );
      const staleRunnerError = await pendingRunner.then(
        () => null,
        error => error?.code,
      );
      const closingSearchCancel = await closingSearchCancelPromise;
      const unregisterOldBoard = registry.registerBoardModule(
        'shared-board',
        (options) => {
          calls.push(`old-board-cancel:${options.reason}`);
          return { cancelled: true, owner: 'old' };
        },
      );
      unregisterOldBoard();
      const closingBoardCancel = await registry.cancelBoardModule(
        'shared-board',
        { reason: 'unmount-cleanup' },
      );
      const unregisterNewBoard = registry.registerBoardModule(
        'shared-board',
        (options) => {
          calls.push(`new-board-cancel:${options.reason}`);
          return { cancelled: true, owner: 'new' };
        },
      );
      // A stale cleanup must not remove the replacement registration when its
      // deferred identity cleanup arrives.
      await Promise.resolve();
      await Promise.resolve();
      const replacementBoardCancel = await registry.cancelBoardModule(
        'shared-board',
        { reason: 'replacement-check' },
      );
      unregisterNewBoard();
      assert(staleRunnerError === 'JOB_SEARCH_MODULE_UNAVAILABLE'
        && JSON.stringify(calls) === JSON.stringify([
          'search-cancel:unmount-cleanup',
          'old-board-cancel:unmount-cleanup',
          'new-board-cancel:replacement-check',
        ])
        && closingSearchCancel === 1
        && closingBoardCancel?.owner === 'old'
        && replacementBoardCancel?.owner === 'new',
      `closing registry entries must retain only exact cancellation authority, got ${JSON.stringify({ staleRunnerError, closingSearchCancel, closingBoardCancel, replacementBoardCancel, calls })}`);
      return { staleRunnerError, calls, closingBoardCancel, replacementBoardCancel };
    },
  },
  {
    name: 'Job Board recovery arbitration preserves monotonic admission order across equal timestamp plans',
    run() {
      // Put the later Board first in canvas order to reproduce the former tie:
      // both clicks persisted the same Date.now() value, so canvas order would
      // elect B ahead of the queue's actual A -> B admission order after reload.
      const equalTimestampNodes = [
        { id: 'search', type: 'jobhub', data: {} },
        {
          id: 'board-b', type: 'jobboard', data: {
            boardScanResume: {
              version: 1, boardRunId: 'board-b-run', phase: 'searches',
              selectedSearchModuleIds: ['search'], startedAt: 1234, admissionOrder: 2,
            },
          },
        },
        {
          id: 'board-a', type: 'jobboard', data: {
            boardScanResume: {
              version: 1, boardRunId: 'board-a-run', phase: 'searches',
              selectedSearchModuleIds: ['search'], startedAt: 1234, admissionOrder: 1,
            },
          },
        },
      ];
      const edges = [
        { source: 'board-a', target: 'search' },
        { source: 'board-b', target: 'search' },
      ];
      const owner = findJobSearchBoardActiveRecoveryOwner('search', equalTimestampNodes, edges);
      const legacyNodes = equalTimestampNodes.map((node) => node.type !== 'jobboard'
        ? node
        : {
            ...node,
            data: {
              ...node.data,
              boardScanResume: { ...node.data.boardScanResume, admissionOrder: undefined },
            },
          });
      const legacyOwner = findJobSearchBoardActiveRecoveryOwner('search', legacyNodes, edges);
      const cancellationNodes = equalTimestampNodes.map((node) => node.type !== 'jobboard'
        ? node
        : {
            ...node,
            data: {
              boardCancellation: {
                version: 1,
                boardRunId: node.data.boardScanResume.boardRunId,
                sourceId: 'search',
                startedAt: 1234,
                admissionOrder: node.data.boardScanResume.admissionOrder,
              },
            },
          });
      const cancellationOwner = findJobSearchBoardActiveRecoveryOwner(
        'search',
        cancellationNodes,
        edges,
      );
      const allocatedAfterReload = allocateJobBoardAdmissionOrder([
        {
          id: 'persisted-high-water', type: 'jobboard',
          data: { boardScanResume: { admissionOrder: 700 } },
        },
      ]);
      const allocatedAfterCancellationOnlyReload = allocateJobBoardAdmissionOrder([
        {
          id: 'cancellation-high-water', type: 'jobboard',
          data: { boardCancellation: { admissionOrder: 900 } },
        },
      ]);
      const allocatedNext = allocateJobBoardAdmissionOrder([]);
      const allocatedAfterMalformedHighWater = allocateJobBoardAdmissionOrder([
        {
          id: 'malformed-high-water', type: 'jobboard',
          data: { boardScanResume: { admissionOrder: [999999] } },
        },
      ]);
      const malformedOrderElection = findJobSearchBoardActiveRecoveryOwner(
        'search',
        [
          { id: 'search', type: 'jobhub', data: {} },
          {
            // The malformed Board is newer by timestamp. Its coercible `true`
            // must not become order 1 and leap ahead of the earlier valid run.
            id: 'malformed-order-board', type: 'jobboard', data: { boardScanResume: {
              version: 1, boardRunId: 'malformed-order-run', phase: 'searches',
              selectedSearchModuleIds: ['search'], startedAt: 200, admissionOrder: true,
            } },
          },
          {
            id: 'valid-order-board', type: 'jobboard', data: { boardScanResume: {
              version: 1, boardRunId: 'valid-order-run', phase: 'searches',
              selectedSearchModuleIds: ['search'], startedAt: 100, admissionOrder: 2,
            } },
          },
        ],
        [
          { source: 'malformed-order-board', target: 'search' },
          { source: 'valid-order-board', target: 'search' },
        ],
      );
      const malformedTimestampValues = [null, '', 0, 'not-a-timestamp'];
      const ownerFor = (invalidValue, marker) => findJobSearchBoardActiveRecoveryOwner(
        'search',
        [
          { id: 'search', type: 'jobhub', data: {} },
          {
            id: `invalid-${marker}`, type: 'jobboard', data: marker === 'plan'
              ? { boardScanResume: {
                version: 1, boardRunId: `invalid-${marker}-run`, phase: 'searches',
                selectedSearchModuleIds: ['search'], startedAt: invalidValue,
              } }
              : marker === 'cancellation'
                ? { boardCancellation: {
                  version: 1, boardRunId: `invalid-${marker}-run`, sourceId: 'search', startedAt: invalidValue,
                } }
                : { manualAiResume: {
                  runId: `invalid-${marker}-run`, startedAt: invalidValue, updatedAt: invalidValue,
                  combineSourceRuns: [{ sourceId: 'search' }],
                } },
          },
          {
            id: `valid-${marker}`, type: 'jobboard', data: marker === 'plan'
              ? { boardScanResume: {
                version: 1, boardRunId: `valid-${marker}-run`, phase: 'searches',
                selectedSearchModuleIds: ['search'], startedAt: 300,
              } }
              : marker === 'cancellation'
                ? { boardCancellation: {
                  version: 1, boardRunId: `valid-${marker}-run`, sourceId: 'search', startedAt: 300,
                } }
                : { manualAiResume: {
                  runId: `valid-${marker}-run`, startedAt: 300,
                  combineSourceRuns: [{ sourceId: 'search' }],
                } },
          },
        ],
        [
          { source: `invalid-${marker}`, target: 'search' },
          { source: `valid-${marker}`, target: 'search' },
        ],
      );
      const malformedTimestampOwnersAreValid = malformedTimestampValues.every((value) => (
        ['plan', 'cancellation', 'combine'].every((marker) => (
          ownerFor(value, marker)?.orchestratorNodeId === `valid-${marker}`
        ))
      ));
      const legacyUpdatedAtFallbackOwner = findJobSearchBoardActiveRecoveryOwner(
        'search',
        [
          { id: 'search', type: 'jobhub', data: {} },
          { id: 'fallback-combine', type: 'jobboard', data: { manualAiResume: {
            runId: 'fallback-combine-run', startedAt: null, updatedAt: 100,
            combineSourceRuns: [{ sourceId: 'search' }],
          } } },
          { id: 'later-combine', type: 'jobboard', data: { manualAiResume: {
            runId: 'later-combine-run', startedAt: 200,
            combineSourceRuns: [{ sourceId: 'search' }],
          } } },
        ],
        [
          { source: 'fallback-combine', target: 'search' },
          { source: 'later-combine', target: 'search' },
        ],
      );
      assert(owner?.orchestratorNodeId === 'board-a'
        && owner?.boardRunId === 'board-a-run'
        && legacyOwner?.orchestratorNodeId === 'board-b'
        && cancellationOwner?.orchestratorNodeId === 'board-a'
        && allocatedAfterReload >= 701
        && allocatedAfterCancellationOnlyReload >= 901
        && allocatedNext === allocatedAfterCancellationOnlyReload + 1
        && allocatedAfterMalformedHighWater === allocatedNext + 1
        && [true, [1], {}, null, '', 0, 1.5, '1.5'].every((value) => (
          normalizeJobBoardAdmissionOrder(value) === null
        ))
        && normalizeJobBoardAdmissionOrder(42) === 42
        && normalizeJobBoardAdmissionOrder('43') === 43
        && malformedOrderElection?.orchestratorNodeId === 'valid-order-board'
        && normalizeJobBoardRecoveryTimestamp(null) === null
        && normalizeJobBoardRecoveryTimestamp('') === null
        && normalizeJobBoardRecoveryTimestamp(0) === null
        && normalizeJobBoardRecoveryTimestamp('not-a-timestamp') === null
        && normalizeJobBoardRecoveryTimestamp('42') === 42
        && malformedTimestampOwnersAreValid
        && legacyUpdatedAtFallbackOwner?.orchestratorNodeId === 'fallback-combine',
      `equal timestamp plans and cancellation receipts must recover in durable admission order while malformed timestamps/orders lose to valid plans, cannot poison allocation, and legacy manual Combine falls back to updatedAt, got ${JSON.stringify({ owner, legacyOwner, cancellationOwner, allocatedAfterReload, allocatedAfterCancellationOnlyReload, allocatedNext, allocatedAfterMalformedHighWater, malformedOrderElection, malformedTimestampOwnersAreValid, legacyUpdatedAtFallbackOwner })}`);
      return { owner, legacyOwner, cancellationOwner, allocatedAfterReload, allocatedAfterCancellationOnlyReload, allocatedNext, allocatedAfterMalformedHighWater, malformedOrderElection, malformedTimestampOwnersAreValid, legacyUpdatedAtFallbackOwner };
    },
  },
  {
    name: 'A waiting Board grants source continuation only to its exact paused Search generation',
    run() {
      const plan = {
        version: 1,
        boardRunId: 'board-a-run',
        phase: 'searches',
        startedAt: 10,
        admissionOrder: 1,
        selectedSearchModuleIds: ['search'],
        activeSourceId: 'search',
        awaitingSourceResolution: { sourceId: 'search', jobRunId: 'search-run' },
      };
      const baseNodes = [
        { id: 'search', type: 'jobhub', data: { hubState: 'sources-ready', jobRunId: 'search-run' } },
        { id: 'board-b', type: 'jobboard', data: {
          boardScanResume: {
            version: 1,
            boardRunId: 'board-b-run',
            phase: 'searches',
            startedAt: 11,
            admissionOrder: 2,
            selectedSearchModuleIds: ['search'],
          },
        } },
        { id: 'board-a', type: 'jobboard', data: { boardScanResume: plan } },
      ];
      const edges = [
        { source: 'board-a', target: 'search' },
        { source: 'board-b', target: 'search' },
      ];
      const eligible = findJobSearchBoardPausedContinuationOwner(
        'search',
        'search-run',
        baseNodes,
        edges,
      );
      const withPatch = (patch) => baseNodes.map((node) => {
        if (node.id === 'search') return { ...node, data: { ...node.data, ...(patch.search || {}) } };
        if (node.id === 'board-a') return {
          ...node,
          data: {
            ...node.data,
            ...(patch.board || {}),
            boardScanResume: {
              ...node.data.boardScanResume,
              ...(patch.plan || {}),
            },
          },
        };
        return node;
      });
      const staleGeneration = findJobSearchBoardPausedContinuationOwner('search', 'newer-run', baseNodes, edges);
      const noLongerPaused = findJobSearchBoardPausedContinuationOwner(
        'search',
        'search-run',
        withPatch({ search: { hubState: 'scoring' } }),
        edges,
      );
      const cancelled = findJobSearchBoardPausedContinuationOwner(
        'search',
        'search-run',
        withPatch({ board: { boardCancellation: { boardRunId: 'board-a-run', sourceId: 'search' } } }),
        edges,
      );
      const locked = findJobSearchBoardPausedContinuationOwner(
        'search',
        'search-run',
        withPatch({ board: { locked: true } }),
        edges,
      );
      const lockedCancellationOwner = findJobSearchBoardPausedContinuationOwner(
        'search',
        'search-run',
        withPatch({ board: { locked: true } }),
        edges,
        { allowLocked: true },
      );
      const lockedRemovalOwner = findJobSearchBoardCancellablePausedSourceOwner(
        'search',
        'search-run',
        withPatch({ board: { locked: true } }),
        edges,
      );
      const preHandoffPlan = {
        ...plan,
        awaitingSourceResolution: null,
        activeSourceRollback: {
          version: 1,
          sourceId: 'search',
          previousData: {},
          sourceGraph: { nodes: [], edges: [] },
        },
      };
      const preHandoffNodes = baseNodes.map(node => (
        node.id === 'board-a'
          ? { ...node, data: { ...node.data, boardScanResume: preHandoffPlan } }
          : node
      ));
      const preHandoffCancellationOwner = findJobSearchBoardCancellablePausedSourceOwner(
        'search',
        'search-run',
        preHandoffNodes,
        edges,
      );
      const preHandoffWithoutRollback = findJobSearchBoardCancellablePausedSourceOwner(
        'search',
        'search-run',
        baseNodes.map(node => (
          node.id === 'board-a'
            ? { ...node, data: { ...node.data, boardScanResume: { ...preHandoffPlan, activeSourceRollback: null } } }
            : node
        )),
        edges,
      );
      const cancellationHandoffOwner = findJobSearchBoardCancellablePausedSourceOwner(
        'search',
        'search-run',
        withPatch({ board: { boardCancellation: { boardRunId: 'board-a-run', sourceId: 'search' } } }),
        edges,
      );
      const boardManualAiRecovery = findJobSearchBoardPausedContinuationOwner(
        'search',
        'search-run',
        withPatch({ board: { manualAiResume: { runId: 'unrelated-board-prompt' } } }),
        edges,
      );
      const boardCleanupRecovery = findJobSearchBoardPausedContinuationOwner(
        'search',
        'search-run',
        withPatch({ board: { manualAiCleanupReceipts: [{ runId: 'unrelated-board-cleanup' }] } }),
        edges,
      );
      const wrongAwaitingToken = findJobSearchBoardPausedContinuationOwner(
        'search',
        'search-run',
        withPatch({ plan: { awaitingSourceResolution: { sourceId: 'search', jobRunId: 'old-run' } } }),
        edges,
      );
      const disconnected = findJobSearchBoardPausedContinuationOwner('search', 'search-run', baseNodes, [
        { source: 'board-b', target: 'search' },
      ]);
      const continuationBlockedByCancellation = isJobSearchBoardPausedContinuationBlocked(
        'search',
        'search-run',
        withPatch({ board: { boardCancellation: { boardRunId: 'board-a-run', sourceId: 'search' } } }),
        edges,
      );
      const continuationBlockedByEpochBump = isJobSearchBoardPausedContinuationBlocked(
        'search',
        'search-run',
        withPatch({ search: { jobRunId: 'newer-search-run' } }),
        edges,
      );
      const exactContinuationAllowed = !isJobSearchBoardPausedContinuationBlocked(
        'search',
        'search-run',
        baseNodes,
        edges,
      );
      const standaloneContinuationAllowed = !isJobSearchBoardPausedContinuationBlocked(
        'standalone',
        'search-run',
        [{ id: 'standalone', type: 'jobhub', data: { hubState: 'sources-ready', jobRunId: 'search-run' } }],
        [],
      );
      assert(eligible?.orchestratorNodeId === 'board-a'
        && eligible?.boardRunId === 'board-a-run'
        && staleGeneration === null
        && noLongerPaused === null
        && cancelled === null
        && locked === null
        && lockedCancellationOwner?.orchestratorNodeId === 'board-a'
        && lockedCancellationOwner?.boardRunId === 'board-a-run'
        && lockedRemovalOwner?.orchestratorNodeId === 'board-a'
        && lockedRemovalOwner?.boardRunId === 'board-a-run'
        && preHandoffCancellationOwner?.orchestratorNodeId === 'board-a'
        && preHandoffCancellationOwner?.boardRunId === 'board-a-run'
        && preHandoffWithoutRollback === null
        && cancellationHandoffOwner?.orchestratorNodeId === 'board-a'
        && cancellationHandoffOwner?.boardRunId === 'board-a-run'
        && boardManualAiRecovery === null
        && boardCleanupRecovery === null
        && wrongAwaitingToken === null
        && disconnected === null,
      `only an elected Board's still-connected sources-ready handoff may continue, got ${JSON.stringify({ eligible, staleGeneration, noLongerPaused, cancelled, locked, boardManualAiRecovery, boardCleanupRecovery, wrongAwaitingToken, disconnected })}`);
      assert(continuationBlockedByCancellation
        && continuationBlockedByEpochBump
        && exactContinuationAllowed
        && standaloneContinuationAllowed,
      `a late source result must be fenced after Board cancellation or a Search epoch bump, while exact paused and standalone continuations remain eligible: ${JSON.stringify({ continuationBlockedByCancellation, continuationBlockedByEpochBump, exactContinuationAllowed, standaloneContinuationAllowed })}`);
      return { eligible, exactGeneration: true, cancellationFenced: true, epochFence: true };
    },
  },
  {
    name: 'Paused Board source continuation survives clean resolution and scoring-state save sanitization',
    run() {
      const plan = {
        version: 1,
        boardRunId: 'board-run',
        phase: 'searches',
        activeSourceId: 'search',
        awaitingSourceResolution: { sourceId: 'search', jobRunId: 'search-run' },
      };
      const cleanPausedSearch = {
        hubState: 'sources-ready',
        jobRunId: 'search-run',
        pendingJobs: [{ title: 'Already gathered' }],
        // Non-gating warnings must not prevent the exact continuation.
        scrapeWarnings: [{ sourceId: 'usajobs', severity: 'info', code: 'config-missing' }],
      };
      const cleanContinuation = exactPausedSourceContinuation(plan, 'search', cleanPausedSearch);
      const stillBlocked = exactPausedSourceContinuation(plan, 'search', {
        ...cleanPausedSearch,
        scrapeWarnings: [{ sourceId: 'linkedin', severity: 'error', code: 'linkedin-rate-limited' }],
      });
      const wrongGeneration = exactPausedSourceContinuation(plan, 'search', {
        ...cleanPausedSearch,
        jobRunId: 'newer-search-run',
      });

      // This is the real reload transition: a save during the post-resolution
      // scorer resets its processing hub to empty and strips in-memory jobs,
      // while the Board's exact awaiting descriptor remains durable.
      const savedNodes = sanitizeNodesForSave([
        {
          id: 'search',
          type: 'jobhub',
          position: { x: 0, y: 0 },
          data: {
            ...cleanPausedSearch,
            hubState: 'scoring',
            scrapeWarnings: [],
            resultDisposition: null,
          },
        },
        {
          id: 'board',
          type: 'jobboard',
          position: { x: 0, y: 0 },
          data: { boardScanResume: plan },
        },
      ]);
      const reloadedSearch = savedNodes.find(node => node.id === 'search').data;
      const reloadedPlan = savedNodes.find(node => node.id === 'board').data.boardScanResume;
      const stagedRecovery = exactPausedSourceContinuation(reloadedPlan, 'search', reloadedSearch);
      // Groups are independently saved canvases.  Assert the same exact
      // Board/Search receipt survives at a nested level, where a shallow save
      // would otherwise make the parent Board look recoverable while its child
      // Search lost the matching generation.
      const nestedSavedNodes = sanitizeNodesForSave([{
        id: 'nested-group',
        type: 'group',
        position: { x: 0, y: 0 },
        data: {
          canvasData: {
            nodes: [
              {
                id: 'search', type: 'jobhub', position: { x: 0, y: 0 }, data: {
                  ...cleanPausedSearch,
                  hubState: 'scoring', scrapeWarnings: [], resultDisposition: null,
                },
              },
              { id: 'board', type: 'jobboard', position: { x: 0, y: 0 }, data: { boardScanResume: plan } },
            ],
            edges: [{ id: 'nested-board-search', source: 'board', target: 'search' }],
            drawings: [],
          },
        },
      }]);
      const nestedNodes = nestedSavedNodes[0].data.canvasData.nodes;
      const nestedStagedRecovery = exactPausedSourceContinuation(
        nestedNodes.find(node => node.id === 'board').data.boardScanResume,
        'search',
        nestedNodes.find(node => node.id === 'search').data,
      );
      const terminalDone = exactPausedSourceContinuation(plan, 'search', {
        hubState: 'done',
        jobRunId: 'search-run',
        resultDisposition: 'empty-complete',
      });
      // A save can land after Test Mode has committed its terminal Search state
      // but before the Board records the child outcome. Recovery must not turn
      // that terminal-but-unscored result into a completed Combine input.
      const reloadedCollectionOnlySource = {
        id: 'search',
        type: 'jobhub',
        data: {
          hubState: 'done',
          jobRunId: 'search-run',
          resultDisposition: 'collection-only',
          aiSkipped: true,
          collectionOnly: true,
          testMode: true,
          scoredJobs: [],
        },
      };
      const reloadedCollectionOnlyOutcome = terminalJobSearchOutcome(reloadedCollectionOnlySource);
      const reloadedCompletedRuns = {};
      const reloadedIncomplete = [];
      if (isMergeableTerminalJobSearchOutcome(
        reloadedCollectionOnlySource,
        reloadedCollectionOnlyOutcome,
      )) {
        reloadedCompletedRuns.search = reloadedCollectionOnlyOutcome;
      } else {
        reloadedIncomplete.push({ sourceId: 'search', status: 'non-mergeable' });
      }
      const reloadedIncompleteSource = {
        ...reloadedCollectionOnlySource,
        data: {
          ...reloadedCollectionOnlySource.data,
          jobRunId: 'incomplete-search-run',
          resultDisposition: 'incomplete',
          aiSkipped: false,
          collectionOnly: false,
          testMode: false,
        },
      };
      const reloadedIncompleteOutcome = terminalJobSearchOutcome(reloadedIncompleteSource);
      const incompleteReceiptClassification = !reloadedIncompleteOutcome
        ? 'incomplete'
        : isMergeableTerminalJobSearchOutcome(
          reloadedIncompleteSource,
          reloadedIncompleteOutcome,
        )
          ? 'mergeable'
          : 'non-mergeable';
      const boardSource = readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      const recoveryStart = boardSource.indexOf('// A Board-owned child can survive an app restart');
      const recoveryEnd = boardSource.indexOf("document.addEventListener('non-api-ai-node-cancelled'", recoveryStart);
      const recovery = boardSource.slice(recoveryStart, recoveryEnd);

      assert(cleanContinuation?.mode === 'finish-paused-scoring'
        && !stillBlocked
        && !wrongGeneration
        && reloadedSearch.hubState === 'empty'
        && !Object.hasOwn(reloadedSearch, 'pendingJobs')
        && stagedRecovery?.mode === 'recover-staged-scoring'
        && stagedRecovery.jobRunId === 'search-run'
        && nestedNodes.find(node => node.id === 'search').data.hubState === 'empty'
        && nestedStagedRecovery?.mode === 'recover-staged-scoring'
        && nestedStagedRecovery.jobRunId === 'search-run'
        && !terminalDone
        && reloadedCollectionOnlyOutcome?.resultDisposition === 'collection-only'
        && !Object.hasOwn(reloadedCompletedRuns, 'search')
        && reloadedIncomplete[0]?.status === 'non-mergeable'
        && reloadedIncompleteOutcome === null
        && incompleteReceiptClassification === 'incomplete'
        && recovery.includes('if (!terminal)')
        && recovery.includes("status: 'incomplete'")
        && (recovery.match(/isMergeableTerminalJobSearchOutcome\(/g) || []).length >= 2,
      `only the exact clean paused generation may finish, and its save-sanitized scoring shape must recover the same staged run at root or nested canvas level without treating a terminal collection-only result as combinable or an incomplete receipt as Test Mode: ${JSON.stringify({ cleanContinuation, stillBlocked, wrongGeneration, reloadedSearch, stagedRecovery, nestedStagedRecovery, terminalDone, reloadedCollectionOnlyOutcome, reloadedCompletedRuns, reloadedIncomplete, reloadedIncompleteOutcome, incompleteReceiptClassification })}`);
      return { clean: cleanContinuation.mode, sanitized: stagedRecovery.mode, nestedSanitized: nestedStagedRecovery.mode };
    },
  },
  {
    name: 'A solved or skipped paused source resumes its Board run, scans the remainder, and combines retained results',
    run() {
      const plan = {
        version: 1,
        boardRunId: 'board-pause-run',
        phase: 'searches',
        activeSourceId: 'paused-search',
        selectedSearchModuleIds: ['paused-search', 'refresh-search'],
        awaitingSourceResolution: {
          sourceId: 'paused-search',
          jobRunId: 'paused-search-run',
        },
      };
      const sourceWaitingForSolve = {
        id: 'paused-search',
        type: 'jobhub',
        data: {
          hubState: 'sources-ready',
          jobRunId: 'paused-search-run',
          pendingJobs: [{ title: 'Solved source row' }],
          scrapeWarnings: [],
        },
      };
      // This is the source-card Solve result: it keeps the source generation
      // and publishes a clean terminal receipt before the waiting Board gets a
      // lane turn.  The Board must adopt it rather than restart a query.
      const solvedSource = {
        ...sourceWaitingForSolve,
        data: {
          ...sourceWaitingForSolve.data,
          hubState: 'done',
          resultDisposition: 'scored',
          scoredJobs: [{
            title: 'Solved role', company: 'Northstar', location: 'Toronto',
            url: 'https://jobs.example/solved', matchScore: 88,
          }],
        },
      };
      const solvedLaneOutcome = exactPausedSourceTerminalOutcome({
        boardRunId: plan.boardRunId,
        resumePlan: plan,
        livePlan: plan,
        sourceId: solvedSource.id,
        source: solvedSource,
      });
      const completedSourceRuns = new Map();
      if (solvedLaneOutcome.status === 'adopted') {
        completedSourceRuns.set(solvedSource.id, solvedLaneOutcome.outcome);
      }

      // The next selected Search is the ordinary Board-owned runner result.
      const refreshedSelectedSource = {
        id: 'refresh-search',
        type: 'jobhub',
        data: {
          hubState: 'done', jobRunId: 'refresh-search-run', resultDisposition: 'scored',
          scoredJobs: [{
            title: 'Refreshed role', company: 'Southstar', location: 'Remote',
            url: 'https://jobs.example/refreshed', matchScore: 81,
          }],
        },
      };
      completedSourceRuns.set(refreshedSelectedSource.id, terminalJobSearchOutcome(refreshedSelectedSource));

      // It was deliberately not selected for this Board run. Its completed
      // rows still belong in the all-connected final combine.
      const retainedUnselectedSource = {
        id: 'retained-search',
        type: 'jobhub',
        data: {
          hubState: 'done', jobRunId: 'retained-search-run', resultDisposition: 'scored',
          scoredJobs: [{
            title: 'Retained role', company: 'Eaststar', location: 'Ottawa',
            url: 'https://jobs.example/retained', matchScore: 77,
          }],
        },
      };
      const allConnectedSources = [solvedSource, refreshedSelectedSource, retainedUnselectedSource];
      const finalCombineInput = unionScoredJobs(allConnectedSources.map(source => source.data.scoredJobs));

      // Skip is also a terminal source-card completion, but with no rows. It
      // must advance the exact same Board transaction rather than leave it
      // waiting for another Board click.
      const skippedSource = {
        ...sourceWaitingForSolve,
        data: {
          ...sourceWaitingForSolve.data,
          hubState: 'done',
          resultDisposition: 'empty-complete',
          scoredJobs: [],
        },
      };
      const skippedLaneOutcome = exactPausedSourceTerminalOutcome({
        boardRunId: plan.boardRunId,
        resumePlan: plan,
        livePlan: plan,
        sourceId: skippedSource.id,
        source: skippedSource,
      });
      const staleGeneration = exactPausedSourceTerminalOutcome({
        boardRunId: plan.boardRunId,
        resumePlan: plan,
        livePlan: plan,
        sourceId: solvedSource.id,
        source: {
          ...solvedSource,
          data: { ...solvedSource.data, jobRunId: 'newer-search-run' },
        },
      });
      const collectionOnlySource = {
        id: 'test-only-search',
        type: 'jobhub',
        data: {
          hubState: 'done',
          jobRunId: 'test-only-run',
          resultDisposition: 'collection-only',
          aiSkipped: true,
          collectionOnly: true,
          testMode: true,
          scoredJobs: [],
        },
      };
      const collectionOnlyOutcome = terminalJobSearchOutcome(collectionOnlySource);
      // A new run must clear the prior test-only provenance before it becomes
      // a normal scored Board input. This models the fresh-run reset at the
      // Job Search admission boundary rather than letting stale flags poison a
      // later result from the same module.
      const freshScoredAfterCollectionOnly = {
        ...collectionOnlySource,
        data: {
          ...collectionOnlySource.data,
          jobRunId: 'fresh-scored-run',
          resultDisposition: 'scored',
          aiSkipped: false,
          collectionOnly: false,
          testMode: false,
          scoredJobs: [{
            title: 'Fresh scored role', company: 'Northstar', location: 'Remote',
            url: 'https://jobs.example/fresh-scored', matchScore: 84,
          }],
        },
      };
      const freshScoredOutcome = terminalJobSearchOutcome(freshScoredAfterCollectionOnly);

      assert(exactPausedSourceContinuation(plan, sourceWaitingForSolve.id, sourceWaitingForSolve.data)?.mode === 'finish-paused-scoring'
        && solvedLaneOutcome.status === 'adopted'
        && solvedLaneOutcome.expectedRunId === 'paused-search-run'
        && completedSourceRuns.get('paused-search')?.runId === 'paused-search-run'
        && completedSourceRuns.get('refresh-search')?.runId === 'refresh-search-run'
        && finalCombineInput.length === 3
        && finalCombineInput.some(job => job.url === 'https://jobs.example/solved')
        && finalCombineInput.some(job => job.url === 'https://jobs.example/refreshed')
        && finalCombineInput.some(job => job.url === 'https://jobs.example/retained')
        && skippedLaneOutcome.status === 'adopted'
        && skippedLaneOutcome.outcome.resultDisposition === 'empty-complete'
        && isMergeableTerminalJobSearchOutcome(solvedSource, solvedLaneOutcome.outcome)
        && isMergeableTerminalJobSearchOutcome(skippedSource, skippedLaneOutcome.outcome)
        && collectionOnlyOutcome?.resultDisposition === 'collection-only'
        && !isMergeableTerminalJobSearchOutcome(collectionOnlySource, collectionOnlyOutcome)
        && freshScoredOutcome?.resultDisposition === 'scored'
        && isMergeableTerminalJobSearchOutcome(freshScoredAfterCollectionOnly, freshScoredOutcome)
        && staleGeneration.status === 'generation-changed',
      `an exact source-card Solve/Skip must advance the original Board generation, run the remaining selected source, and combine every completed connection while rejecting a changed generation; collection-only/Test Mode completion is terminal but cannot replace the Board: ${JSON.stringify({ solvedLaneOutcome, completedSourceRuns: Object.fromEntries(completedSourceRuns), finalCombineInput, skippedLaneOutcome, collectionOnlyOutcome, staleGeneration })}`);
      return {
        adoptedRun: solvedLaneOutcome.expectedRunId,
        remainingSelectedRan: completedSourceRuns.has('refresh-search'),
        allConnectedCombineCount: finalCombineInput.length,
        skipped: skippedLaneOutcome.status,
      };
    },
  },
  {
    name: 'Historical Board pause resolves the same Search generation and publishes cards without a replacement scan',
    async run() {
      const pausedSource = {
        id: 'report-paused-search',
        type: 'jobhub',
        data: {
          hubState: 'sources-ready',
          jobRunId: 'report-search-run',
          inputLocked: true,
          careerFilePaths: ['/tmp/report-career.pdf'],
          // These rows already exist when a source-card Solve/Skip action is
          // requested. They are not a new provider/parse input.
          pendingJobs: [{ title: 'Gathered before source resolution' }],
          scrapeWarnings: [{ sourceId: 'linkedin', severity: 'error', code: 'linkedin-rate-limited' }],
        },
      };
      const terminalModern = {
        id: 'report-reused-modern',
        type: 'jobhub',
        data: {
          hubState: 'done', jobRunId: 'modern-complete-run', resultDisposition: 'scored',
          scoredJobs: [{
            title: 'Modern completed role', company: 'Northstar', location: 'Toronto',
            url: 'https://jobs.example/report-modern', matchScore: 87,
          }],
        },
      };
      const terminalLegacy = {
        id: 'report-reused-legacy',
        type: 'jobhub',
        data: {
          hubState: 'done',
          scoredJobs: [{
            title: 'Legacy completed role', company: 'Eaststar', location: 'Remote',
            url: 'https://jobs.example/report-legacy', matchScore: 79,
          }],
        },
      };
      // This represents the only fresh case: the person manually cleared the
      // previous career identity and subsequently imported this new one.
      const clearThenReimport = {
        id: 'report-fresh-after-clear',
        type: 'jobhub',
        data: {
          hubState: 'empty', inputLocked: true,
          careerFilePaths: ['/tmp/report-fresh-career.pdf'],
          careerImportGeneration: 'career-import:report-fresh-after-clear:one',
          careerImportFreshCapability: 'career-import:report-fresh-after-clear:one',
          careerImportConsumption: null,
        },
      };
      const tokenlessPaused = {
        id: 'report-tokenless-pause',
        type: 'jobhub',
        data: {
          hubState: 'sources-ready', inputLocked: true,
          careerFilePaths: ['/tmp/report-tokenless-career.pdf'],
        },
      };
      const admissions = partitionJobBoardSourceAdmissions([
        pausedSource, terminalModern, terminalLegacy, clearThenReimport, tokenlessPaused,
      ]);
      const plan = {
        version: 1,
        boardRunId: 'report-board-run',
        phase: 'searches',
        activeSourceId: pausedSource.id,
        selectedSearchModuleIds: [pausedSource.id, clearThenReimport.id],
        awaitingSourceResolution: { sourceId: pausedSource.id, jobRunId: 'report-search-run' },
        awaitingSourceResolutions: [{ sourceId: pausedSource.id, jobRunId: 'report-search-run' }],
      };

      // Before the person solves/skips the source warning, no child is allowed
      // to start a replacement provider search. Once resolved, the Board owns
      // exactly this existing source generation and completes its gathered rows.
      const blockedContinuation = exactPausedSourceContinuation(plan, pausedSource.id, pausedSource.data);
      const resolvedPausedSource = {
        ...pausedSource,
        data: { ...pausedSource.data, scrapeWarnings: [] },
      };
      const continuation = exactPausedSourceContinuation(
        plan,
        resolvedPausedSource.id,
        resolvedPausedSource.data,
      );
      const settledPausedSource = {
        ...resolvedPausedSource,
        data: {
          ...resolvedPausedSource.data,
          hubState: 'done',
          resultDisposition: 'scored',
          pendingJobs: null,
          scoredJobs: [{
            title: 'Resolved existing role', company: 'Glassdoor recovery', location: 'Toronto',
            url: 'https://jobs.example/report-resolved', matchScore: 91,
          }],
        },
      };
      const adopted = resolveExactPausedJobBoardTerminal({
        boardRunId: plan.boardRunId,
        resumePlan: plan,
        livePlan: plan,
        sourceId: settledPausedSource.id,
        source: settledPausedSource,
      });

      // The Board sends only genuinely fresh, manually-cleared/re-imported
      // input to its child fan-out. Counters represent the only locations where
      // a provider, career parse, or generic rerun would be allowed to happen.
      const freshCalls = { provider: 0, parse: 0, handleRerun: 0 };
      const childCalls = new Map();
      const freshResults = await runJobBoardChildFanout(
        admissions.fresh.map(entry => entry.sourceId),
        async (sourceId) => {
          childCalls.set(sourceId, (childCalls.get(sourceId) || 0) + 1);
          freshCalls.provider += 1;
          freshCalls.parse += 1;
          freshCalls.handleRerun += 1;
          return { status: 'completed', sourceId, runId: 'fresh-after-clear-run' };
        },
      );
      const freshTerminal = {
        ...clearThenReimport,
        data: {
          ...clearThenReimport.data,
          hubState: 'done', jobRunId: 'fresh-after-clear-run', resultDisposition: 'scored',
          scoredJobs: [{
            title: 'Fresh imported role', company: 'Newstart', location: 'Remote',
            url: 'https://jobs.example/report-fresh', matchScore: 83,
          }],
        },
      };

      const completedSourceRuns = new Map([
        [terminalModern.id, terminalJobSearchOutcome(terminalModern)],
        [terminalLegacy.id, terminalJobSearchOutcome(terminalLegacy)],
        [settledPausedSource.id, adopted.outcome],
        [freshTerminal.id, terminalJobSearchOutcome(freshTerminal)],
      ]);
      const combinePlan = {
        ...plan,
        phase: 'combine',
        awaitingSourceResolution: null,
        awaitingSourceResolutions: [],
        completedSourceRuns: Object.fromEntries(completedSourceRuns),
      };
      const mergeStats = {};
      const mergedJobs = unionScoredJobs([
        settledPausedSource.data.scoredJobs,
        terminalModern.data.scoredJobs,
        terminalLegacy.data.scoredJobs,
        freshTerminal.data.scoredJobs,
      ], mergeStats);
      const displayModel = buildJobTreeNodes({
        displayedJobs: mergedJobs,
        bucketTree: { roles: [{ name: 'Recovered roles', jobIndices: mergedJobs.map((_, index) => index) }] },
        originalPos: { x: 0, y: 0 }, hubId: 'report-board', baseNodeId: 'report-board-results',
      });

      // A save during scoring removes renderer-only pending rows but leaves the
      // Board's durable descriptor; reload must recover the same run, not scan.
      const reloaded = sanitizeNodesForSave([
        {
          id: pausedSource.id, type: 'jobhub', position: { x: 0, y: 0 },
          data: { ...resolvedPausedSource.data, hubState: 'scoring', pendingJobs: [{ title: 'staged' }] },
        },
        { id: 'report-board', type: 'jobboard', position: { x: 0, y: 0 }, data: { boardScanResume: plan } },
      ]);
      const reloadSource = reloaded.find(node => node.id === pausedSource.id)?.data;
      const reloadPlan = reloaded.find(node => node.id === 'report-board')?.data?.boardScanResume;
      const reloadContinuation = exactPausedSourceContinuation(reloadPlan, pausedSource.id, reloadSource);
      const cancelledNodes = [
        { id: pausedSource.id, type: 'jobhub', data: resolvedPausedSource.data },
        {
          id: 'report-board', type: 'jobboard', data: {
            boardScanResume: plan,
            boardCancellation: { boardRunId: plan.boardRunId, sourceId: pausedSource.id },
          },
        },
      ];
      const cancellationBlocksContinuation = isJobSearchBoardPausedContinuationBlocked(
        pausedSource.id,
        'report-search-run',
        cancelledNodes,
        [{ id: 'report-edge', source: 'report-board', target: pausedSource.id }],
      );

      assert(admissions.reusable.map(entry => entry.sourceId).join(',') === `${terminalModern.id},${terminalLegacy.id}`
        && admissions.continuations.map(entry => entry.sourceId).join(',') === pausedSource.id
        && admissions.fresh.map(entry => entry.sourceId).join(',') === clearThenReimport.id
        && admissions.blocked.map(entry => entry.sourceId).join(',') === tokenlessPaused.id
        && blockedContinuation === null
        && continuation?.mode === 'finish-paused-scoring'
        && adopted.status === 'adopted'
        && adopted.mergeable === true
        && adopted.expectedRunId === 'report-search-run'
        && freshResults.length === 1
        && freshCalls.provider === 1
        && freshCalls.parse === 1
        && freshCalls.handleRerun === 1
        && !childCalls.has(pausedSource.id)
        && !childCalls.has(terminalModern.id)
        && !childCalls.has(terminalLegacy.id)
        && !childCalls.has(tokenlessPaused.id)
        && completedSourceRuns.get(pausedSource.id)?.runId === 'report-search-run'
        && completedSourceRuns.get(terminalModern.id)?.runId === 'modern-complete-run'
        && completedSourceRuns.get(terminalLegacy.id)?.legacyPositiveResult === true
        && combinePlan.phase === 'combine'
        && combinePlan.awaitingSourceResolution === null
        && mergedJobs.length === 4
        && mergeStats.unique === 4
        && displayModel.newNodes.filter(node => node.type === 'jobcard').length === 4
        && displayModel.newNodes.every(node => node.data?.hubId === 'report-board')
        && reloadContinuation?.mode === 'recover-staged-scoring'
        && cancellationBlocksContinuation,
      `a Board-owned paused Search must resolve, adopt, combine, and display its exact run while only cleared/re-imported data starts fresh work: ${JSON.stringify({ admissions: Object.fromEntries(Object.entries(admissions).map(([key, value]) => [key, value.map(entry => entry.sourceId)])), blockedContinuation, continuation, adopted, freshCalls, childCalls: Object.fromEntries(childCalls), combinePlan, mergedJobs: mergedJobs.length, displayCards: displayModel.newNodes.filter(node => node.type === 'jobcard').length, reloadContinuation, cancellationBlocksContinuation })}`);
      return {
        adoptedRun: adopted.expectedRunId,
        freshDispatches: freshCalls.provider,
        displayedCards: displayModel.newNodes.filter(node => node.type === 'jobcard').length,
        reloadRun: reloadContinuation?.jobRunId,
      };
    },
  },
  {
    name: 'Deleting a Board atomically retires every persisted child-cancellation manual-AI id',
    async run() {
      const deletedBoard = {
        id: 'board-delete',
        type: 'jobboard',
        data: {
          manualAiResume: { runId: 'primary-run' },
          boardScanResume: {
            combineManualAiRunId: 'combine-run',
            activeSourceManualAiRunIds: {
              'search-a': 'fanout-search-a-run',
              'search-b': 'fanout-search-b-run',
            },
            cancellationCleanup: {
              manualAiRunId: 'child-legacy-run',
              manualAiRunIds: ['child-ack-a', 'child-ack-b', 'child-legacy-run'],
            },
            cancellationCleanupsBySource: {
              'search-a': { manualAiRunId: 'child-search-a-run' },
              'search-b': { manualAiRunIds: ['child-search-b-run', 'child-search-b-ack-run'] },
            },
            recoverableFailure: { manualAiRunId: 'recovery-run' },
          },
          boardCancellation: {
            manualAiRunIds: ['board-cancel-run'],
            childCleanup: {
              manualAiRunId: 'board-child-legacy-run',
              manualAiRunIds: ['board-child-ack-run'],
            },
          },
          manualAiCleanupReceipts: [{ runId: 'superseded-run' }],
        },
      };
      const expectedRunIds = new Set([
        'primary-run',
        'combine-run',
        'fanout-search-a-run',
        'fanout-search-b-run',
        'child-legacy-run',
        'child-ack-a',
        'child-ack-b',
        'child-search-a-run',
        'child-search-b-run',
        'child-search-b-ack-run',
        'recovery-run',
        'board-cancel-run',
        'board-child-legacy-run',
        'board-child-ack-run',
        'superseded-run',
        'ack-only-run',
      ]);
      const cancellationCalls = [];
      let completedRunIds = null;
      const priorWindow = globalThis.window;
      try {
        globalThis.window = {
          electronAPI: {
            cancelNodeTaskAndWait: async (nodeId, reason) => {
              cancellationCalls.push({ nodeId, reason });
              return { settled: true, manualAiRunIds: ['ack-only-run', 'child-ack-b'] };
            },
            completeNonApiAiRuns: async (runIds) => {
              completedRunIds = [...runIds];
              return { completed: true, clearedRunIds: [...runIds], absentRunIds: [] };
            },
          },
        };
        const retired = await retireDeletedManualAiRuns([deletedBoard]);
        assert(cancellationCalls.length === 1
          && cancellationCalls[0].nodeId === 'board-delete'
          && cancellationCalls[0].reason === 'node-deleted',
        'Board deletion must first obtain an acknowledged cancellation for the exact workflow node');
        assert(completedRunIds?.length === expectedRunIds.size
          && completedRunIds.every(runId => expectedRunIds.has(runId))
          && retired.length === expectedRunIds.size
          && retired.every(({ runId }) => expectedRunIds.has(runId)),
        'Board deletion must atomically retire legacy ids, every active fan-out child handoff, every source-keyed cancellation cleanup, persisted childCleanup array id, cleanup receipt, and acknowledgement-only id exactly once');
      } finally {
        globalThis.window = priorWindow;
      }
      return { retiredRunIds: expectedRunIds.size, cancellationAcknowledged: true };
    },
  },
  {
    name: 'A standalone pending Board Combine reserves its exact shared Search inputs',
    run() {
      const nodes = [
        { id: 'search', type: 'jobhub', data: { hubState: 'done' } },
        {
          id: 'board-a', type: 'jobboard', data: {
            manualAiResume: {
              runId: 'standalone-combine-a',
              updatedAt: 100,
              combineInputSignature: 'search=7:1:123',
              combineSourceRuns: [{ sourceId: 'search', runId: 'search-run-a', resultDisposition: 'scored', fingerprint: '7:1:123' }],
            },
          },
        },
        {
          id: 'board-b', type: 'jobboard', data: {
            boardScanResume: {
              version: 1,
              boardRunId: 'scan-b',
              startedAt: 200,
              phase: 'searches',
              activeSourceId: null,
              selectedSearchModuleIds: ['search'],
            },
          },
        },
      ];
      const edges = [
        { source: 'board-a', target: 'search' },
        { source: 'search', target: 'board-b' },
      ];
      const owner = findJobSearchBoardActiveRecoveryOwner('search', nodes, edges);
      assert(owner?.orchestratorNodeId === 'board-a' && owner.boardRunId === 'standalone-combine-a',
        `a pending standalone Combine must keep its shared Search reserved until recovery retires it, got ${JSON.stringify(owner)}`);
      const withoutExactInput = nodes.map(node => node.id === 'board-a'
        ? { ...node, data: { manualAiResume: { ...node.data.manualAiResume, combineSourceRuns: [] } } }
        : node);
      const fallback = findJobSearchBoardActiveRecoveryOwner('search', withoutExactInput, edges);
      assert(fallback?.orchestratorNodeId === 'board-b' && fallback.boardRunId === 'scan-b',
        'a malformed/empty manual marker must not reserve Searches it cannot prove were inputs');
      const committedCleanup = nodes.map(node => node.id === 'board-a'
        ? {
            ...node,
            data: {
              manualAiResume: {
                ...node.data.manualAiResume,
                retirementPending: true,
                committedResult: true,
              },
            },
          }
        : node);
      const ownerDuringCleanup = findJobSearchBoardActiveRecoveryOwner('search', committedCleanup, edges);
      assert(ownerDuringCleanup?.orchestratorNodeId === 'board-b'
        && ownerDuringCleanup.boardRunId === 'scan-b',
      'a cleanup-only marker for an already committed/superseded Combine must not reserve immutable Search inputs or block another Board while backend retirement is retried');
      return owner;
    },
  },
  {
    name: 'Connected Job Search modules defer fresh scans to their live Job Board owner',
    run() {
      const nodes = [
        { id: 'search-a', type: 'jobhub' },
        { id: 'search-b', type: 'jobhub' },
        { id: 'board-a', type: 'jobboard' },
        { id: 'board-b', type: 'jobboard' },
        { id: 'note', type: 'text' },
      ];
      const edges = [
        { source: 'search-a', target: 'board-a' },
        { source: 'board-b', target: 'search-b' },
        { source: 'search-a', target: 'note' },
        { source: 'note', target: 'board-b' },
        { source: 'search-a', target: 'missing-board' },
      ];
      assert(isJobSearchConnectedToBoard('search-a', nodes, edges)
        && isJobSearchConnectedToBoard('search-b', new Map(nodes.map(node => [node.id, node])), edges),
      'Board ownership must be detected in either edge direction from both React Flow node arrays and nodeLookup maps');
      assert(!isJobSearchConnectedToBoard('note', nodes, edges)
        && !isJobSearchConnectedToBoard('missing-search', nodes, edges)
        && !isJobSearchConnectedToBoard('search-a', nodes.filter(node => node.id !== 'board-a'), edges),
      'non-search nodes, missing searches, and dangling Board edges must not invent a live Board owner');

      const search = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const done = readFileSync(new URL('../../src/nodes/jobsearch/JobSearchDoneState.jsx', import.meta.url), 'utf8');
      const legacyAutoStart = search.slice(
        search.indexOf('const autoStartPath ='),
        search.indexOf('// Handle file drops directly onto this node'),
      );
      const retryStart = search.indexOf('const handleRetryFailed = useCallback');
      const retryEnd = search.indexOf('const savedAnalysisWarning', retryStart);
      const retry = search.slice(retryStart, retryEnd);
      assert(search.includes('store => isJobSearchConnectedToBoard(id, store.nodeLookup, store.edges)')
        && search.includes("if (!queueManagedByBoard && deferDirectSearchToBoard('Direct re-run')) {")
        && search.includes("if (!queueManagedByBoard && deferDirectSearchToBoard('Interrupted-run resume')) {")
        && search.includes("if (!queueManagedByBoard && deferDirectSearchToBoard('Saved-scrape resume')) {")
        && search.includes("deferDirectSearchToBoard(\n      'Career-file drop'")
        && search.includes('if (managedByJobBoard || activeBoardRecoveryOwnerKey) {\n      EventLogger.log(`[JobSearch][${id}] Legacy file auto-start suppressed')
        && search.includes('This Job Search is reserved by an interrupted Job Board run.')
        && search.includes('This interrupted Search is reserved by its Job Board.')
        && search.includes('This saved Search recovery is reserved by its Job Board.')
        && search.includes('const boardRecoveryOwnsActions = managedByJobBoard || !!activeBoardRecoveryOwnerKey;')
        && search.includes('const pausedBoardContinuationOwnerKey = useStore(')
        && search.includes('findJobSearchBoardPausedContinuationOwner(\n        id,\n        jobRunId,\n        store.nodeLookup,\n        store.edges,')
        && search.includes('dedupeKey: `job-search-run-from-board:${id}`,')
        && search.includes('onRetry={boardRecoveryOwnsActions ? null : handleRetryFailed}')
        && search.includes('onRerun={boardRecoveryOwnsActions ? null : handleRerun}')
        && search.includes('onReanalyze={boardRecoveryOwnsActions || data.terminalFinalizationRecovery ? null : handleReanalyze}')
        && search.includes('{hasRunnableCareerInput && !controlsLocked && !boardRecoveryOwnsActions && (')
        && search.includes('|| boardRecoveryOwnsActions\n    ) return;')
        && search.includes('onClearCareerFiles={activeBoardRecoveryOwnerKey ? null : handleClearCareerFiles}')
        && search.includes('boardRecoveryPending={!managedByJobBoard && !!activeBoardRecoveryOwnerKey}')
        && legacyAutoStart.indexOf('if (managedByJobBoard || activeBoardRecoveryOwnerKey)') >= 0
        && legacyAutoStart.indexOf('autoStartedFilePathRef.current = autoStartPath;') > legacyAutoStart.indexOf('if (managedByJobBoard || activeBoardRecoveryOwnerKey)')
        && legacyAutoStart.includes("const claimedByBoard = ['paused', 'not-ready'].includes(outcome?.status)")
        && legacyAutoStart.includes("outcome?.error === 'This Job Search is pending deletion.'")
        && legacyAutoStart.includes('findJobSearchBoardActiveRecoveryOwner(id, getNodes(), getEdges())')
        && legacyAutoStart.includes('[activeBoardRecoveryOwnerKey, data.filePath, deletionLifecycleRevision, getEdges, getNodes, hubState, id, managedByJobBoard, startProcessing]')
        && retryStart >= 0 && retryEnd > retryStart
        && retry.indexOf('const supersededCleanupReceipts = normalizeManualAiCleanupReceipts') >= 0
        && retry.indexOf('if (manualRetirement?.runId && manualRetirement.retirementPending)')
          > retry.indexOf('const supersededCleanupReceipts = normalizeManualAiCleanupReceipts')
        && retry.indexOf("if (deferDirectSearchToBoard('Error retry')) return;")
          > retry.indexOf('if (manualRetirement?.runId && manualRetirement.retirementPending)')
        && done.includes('The connected Job Board reuses these completed results.')
        && done.includes('manually choose Clear career data and import fresh files in Job Search first')
        && done.includes('boardRecoveryPending = false')
        && done.includes('A previous Job Board recovery is settling.'),
      'connected modules and disconnected-but-reserved recoveries must suppress every child launch/clear action, leaving the durable recovery in its owning Board while retaining standalone compatibility');
      return { edgeDirections: 2, connectedStartsDeferred: true, standaloneCompatibility: true, disconnectRecovery: true, disconnectActionsHidden: true };
    },
  },
  {
    name: 'Job Board recovery hides non-continuation source-ready scoring while preserving the exact paused continuation',
    run() {
      const search = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const sourcesReady = readFileSync(new URL('../../src/nodes/jobsearch/JobSearchSourcesReadyState.jsx', import.meta.url), 'utf8');
      const nodes = [
        { id: 'search', type: 'jobhub', data: { hubState: 'sources-ready', jobRunId: 'paused-run' } },
        { id: 'board', type: 'jobboard', data: { boardScanResume: {
          version: 1,
          boardRunId: 'board-run',
          phase: 'searches',
          selectedSearchModuleIds: ['search'],
          activeSourceId: 'search',
          awaitingSourceResolution: { sourceId: 'search', jobRunId: 'paused-run' },
        } } },
      ];
      const edges = [{ source: 'board', target: 'search' }];
      const exactContinuation = findJobSearchBoardPausedContinuationOwner(
        'search', 'paused-run', nodes, edges,
      );
      const staleContinuation = findJobSearchBoardPausedContinuationOwner(
        'search', 'newer-run', nodes, edges,
      );
      const scoreCurrentStart = search.indexOf('const handleScoreCurrentResults = useCallback');
      const scoreCurrentEnd = search.indexOf('// Keep the ref up-to-date', scoreCurrentStart);
      const scoreCurrent = search.slice(scoreCurrentStart, scoreCurrentEnd);
      assert(exactContinuation?.orchestratorNodeId === 'board'
        && staleContinuation === null
        && search.includes('const pausedBoardContinuationOwnerKey = useStore(')
        && search.includes('onScoreCurrent={activeBoardRecoveryOwnerKey && !pausedBoardContinuationOwnerKey\n                ? null\n                : handleScoreCurrentResults}')
        && scoreCurrent.includes('const liveBoardRecoveryOwner = findJobSearchBoardActiveRecoveryOwner(')
        && scoreCurrent.includes('const livePausedBoardContinuationOwner = findJobSearchBoardPausedContinuationOwner(')
        && scoreCurrent.includes('if (liveBoardRecoveryOwner && !livePausedBoardContinuationOwner)')
        && sourcesReady.includes("const canScoreCurrent = !locked\n    && jobsAvailable > 0\n    && typeof onScoreCurrent === 'function';")
        && sourcesReady.includes('{canScoreCurrent && (')
        && sourcesReady.includes("{canScoreCurrent\n          ? 'Solve or skip each blocked card")
        && sourcesReady.includes("no extra Board action is needed.'}"),
      'only the exact paused Board child keeps Score current results; stale Board-owned cards omit the callback, button, and phantom copy, while the handler re-proves ownership before mutating');
      return { exactContinuation: true, staleContinuationBlocked: true };
    },
  },
  {
    name: 'Job Search recovery cards give one owner and one continuation path',
    run() {
      const search = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const recoveryStart = search.indexOf('const showUnfinishedRunBanner = Boolean(');
      const savedPanelStart = search.indexOf('const savedAnalysisPanel = shouldShowSavedAnalysisPanel ? (', recoveryStart);
      const resumeBannerStart = search.indexOf('const resumeBanner = showUnfinishedRunBanner ? (', savedPanelStart);
      const bannerStart = search.indexOf('const banner = (', resumeBannerStart);
      const savedPanel = search.slice(savedPanelStart, resumeBannerStart);
      const resumeBanner = search.slice(resumeBannerStart, bannerStart);
      assert(recoveryStart >= 0
        && search.includes('const shouldShowSavedAnalysisPanel = !!savedAnalysisMeta && !showUnfinishedRunBanner;')
        && savedPanel.includes('{boardRecoveryOwnsActions && (')
        && savedPanel.includes('Saved results are kept for reference.')
        && savedPanel.includes('Start searches from the connected Job Board with Search selected & combine.')
        && savedPanel.includes('previous Job Board recovery settles')
        && savedPanel.includes('{!boardRecoveryOwnsActions && (')
        && savedPanel.includes('onClick={handleResumeSavedScrape}')
        && savedPanel.includes("'Re-score saved results'")
        && !savedPanel.includes('Resume saved scrape')
        && savedPanel.includes('>\n          Open prompt\n        </button>')
        && resumeBanner.includes("boardRecoveryOwnsActions && resumeRunActionable\n          ? ' Continue from the connected Job Board with Search selected & combine. Start fresh discards this unfinished run.'")
        && resumeBanner.includes('{!boardRecoveryOwnsActions && resumeRunActionable && <button'),
      'an unfinished-run banner must suppress the competing Saved Scrape card; a connected or still-reserved Board owns continuation, while standalone Searches keep direct recovery actions with unambiguous labels');
      return { unfinishedBannerSuppressesSavedScrape: true, boardOwnsContinuation: true, disconnectReservationSuppressesActions: true, standaloneRescore: true };
    },
  },
  {
    name: 'Job Search explicit manual-AI cancellation cannot race its auto-retirement effect',
    run() {
      const search = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const settlementStart = search.indexOf('const settleManualAiRetirement = useCallback');
      const settlementEnd = search.indexOf('const completeManualAiRun = useCallback', settlementStart);
      const settlement = search.slice(settlementStart, settlementEnd);
      const intentClaimAt = settlement.indexOf('attemptedManualAiCleanupRunIdsRef.current.add(runId);');
      const intentPublishAt = settlement.indexOf('updateGlobal(id, (node) => {', intentClaimAt);

      const autoStart = search.indexOf('const autoResumedManualAiRunRef = useRef(null);');
      const autoEnd = search.indexOf('const handleDismissError = useCallback', autoStart);
      const autoRecovery = search.slice(autoStart, autoEnd);
      const retirementAt = autoRecovery.indexOf('if (resume.retirementPending) {');
      const inFlightGuardAt = autoRecovery.indexOf(
        'if (attemptedManualAiCleanupRunIdsRef.current.has(resume.runId)) return;',
        retirementAt,
      );
      const recoveryClaimAt = autoRecovery.indexOf(
        'attemptedManualAiCleanupRunIdsRef.current.add(resume.runId);',
        inFlightGuardAt,
      );
      const autoClaimAt = autoRecovery.indexOf(
        'autoResumedManualAiRunRef.current = resume.runId;',
        retirementAt,
      );
      const cleanupInvokeAt = autoRecovery.indexOf('void settleManualAiRetirement({', retirementAt);

      assert(settlementStart >= 0 && settlementEnd > settlementStart
        && intentClaimAt >= 0 && intentPublishAt > intentClaimAt
        && autoStart >= 0 && autoEnd > autoStart && retirementAt >= 0
        && inFlightGuardAt > retirementAt
        && recoveryClaimAt > inFlightGuardAt
        && autoClaimAt > recoveryClaimAt
        && cleanupInvokeAt > autoClaimAt,
      'explicit cancellation must claim the run before publishing its pending marker, and auto-retirement must refuse that in-flight run before starting duplicate cleanup');
      return { prePublishClaim: true, duplicateRetirementFenced: true };
    },
  },
  {
    name: 'Job Search shares active Board-child cancellation cleanup and releases failed reload leases',
    run() {
      const search = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const cancelStart = search.indexOf('const cancelBoardRun = useCallback');
      const cancelEnd = search.indexOf('const runForJobBoard = useCallback', cancelStart);
      const cancellation = search.slice(cancelStart, cancelEnd);

      const noControlAt = cancellation.indexOf('if (!control) {');
      const leaseReservationAt = cancellation.indexOf(
        'const cancellationLeasePromise = queueManagedExternally',
        noControlAt,
      );
      const protectedTryAt = cancellation.indexOf('try {', leaseReservationAt);
      const initialIntentAt = cancellation.indexOf(
        'const boardCleanupIntentPersisted = await persistChildCancellationCleanup({',
        leaseReservationAt,
      );
      const failedLeaseCancelAt = cancellation.indexOf(
        'moduleRunQueue.cancelQueuedRunsForNode(',
        initialIntentAt,
      );
      const failedLeaseObserveAt = cancellation.indexOf(
        'cancellationLease = await cancellationLeasePromise;',
        failedLeaseCancelAt,
      );
      const leaseReleaseAt = cancellation.indexOf('cancellationLease?.release();', failedLeaseObserveAt);

      const alreadyRolledBackAt = cancellation.indexOf('if (control.rollbackApplied) {');
      const sharedRollbackAt = cancellation.indexOf('control.rollbackPromise,', alreadyRolledBackAt);
      const sharedRetryCallAt = cancellation.indexOf('control.cleanupArtifacts()', alreadyRolledBackAt);
      const performCleanupAt = cancellation.indexOf('const performCleanupArtifacts = async () => {');
      const cleanupFactoryAt = cancellation.indexOf('control.cleanupArtifacts = () => {', performCleanupAt);
      const reuseAt = cancellation.indexOf(
        'if (control.cleanupPromise) return control.cleanupPromise;',
        cleanupFactoryAt,
      );
      const createAttemptAt = cancellation.indexOf(
        'const cleanupAttempt = Promise.resolve().then(performCleanupArtifacts);',
        reuseAt,
      );
      const publishAttemptAt = cancellation.indexOf(
        'control.cleanupPromise = cleanupAttempt;',
        createAttemptAt,
      );
      const rejectedResetAt = cancellation.indexOf(
        'if (control.cleanupPromise === cleanupAttempt) control.cleanupPromise = null;',
        publishAttemptAt,
      );
      const firstSettlementAt = cancellation.indexOf(
        'const [rollbackResult, cleanupResult] = await Promise.allSettled([',
        rejectedResetAt,
      );
      const firstRollbackAt = cancellation.indexOf('control.rollbackPromise,', firstSettlementAt);
      const firstCleanupCallAt = cancellation.indexOf('control.cleanupArtifacts()', firstSettlementAt);
      const cleanupCallCount = cancellation.match(/control\.cleanupArtifacts\(\)/g)?.length || 0;

      assert(noControlAt >= 0 && leaseReservationAt > noControlAt
        && protectedTryAt > leaseReservationAt && initialIntentAt > protectedTryAt
        && failedLeaseCancelAt > initialIntentAt
        && failedLeaseObserveAt > failedLeaseCancelAt && leaseReleaseAt > failedLeaseObserveAt,
      'reload cancellation must reserve its safety lease before the first await, while protecting the initial durable-intent commit so every rejected path cancels/observes and releases that lease');
      assert(alreadyRolledBackAt >= 0 && sharedRollbackAt > alreadyRolledBackAt
        && sharedRetryCallAt > sharedRollbackAt
        && performCleanupAt > sharedRetryCallAt && cleanupFactoryAt > performCleanupAt
        && reuseAt > cleanupFactoryAt && createAttemptAt > reuseAt
        && publishAttemptAt > createAttemptAt && rejectedResetAt > publishAttemptAt
        && firstSettlementAt > rejectedResetAt && firstRollbackAt > firstSettlementAt
        && firstCleanupCallAt > firstRollbackAt
        && cleanupCallCount === 2,
      'the first caller and every concurrent cancellation surface must share one rollback and one memoized cleanup attempt; only rejection may clear that attempt for an explicit retry');
      return { sharedCleanupAttempt: true, rejectedAttemptRetryable: true, reloadLeaseReleased: true };
    },
  },
  {
    name: 'Job Board primary manual-AI retirement is attempted once until explicit Retry',
    run() {
      const board = readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      const autoStart = board.indexOf('useEffect(() => {\n    const resume = data.manualAiResume;');
      const autoEnd = board.indexOf('const handleRetryRecovery = useCallback', autoStart);
      const autoRecovery = board.slice(autoStart, autoEnd);
      const retirementAt = autoRecovery.indexOf('if (resume.retirementPending) {');
      const guardAt = autoRecovery.indexOf(
        'if (attemptedSupersededCleanupRunIdsRef.current.has(resume.runId)) return;',
        retirementAt,
      );
      const claimAt = autoRecovery.indexOf(
        'attemptedSupersededCleanupRunIdsRef.current.add(resume.runId);',
        guardAt,
      );
      const autoClaimAt = autoRecovery.indexOf(
        'autoResumedManualAiRunRef.current = resume.runId;',
        retirementAt,
      );
      const cleanupAt = autoRecovery.indexOf('void retireBoardCleanupReceipt(resume)', retirementAt);

      const retryStart = autoEnd;
      const retryEnd = board.indexOf('\n  const ', retryStart + 'const handleRetryRecovery'.length);
      const retry = board.slice(retryStart, retryEnd);
      const primaryRetryAt = retry.indexOf('if (liveData.manualAiResume?.retirementPending) {');
      const releaseAt = retry.indexOf(
        'attemptedSupersededCleanupRunIdsRef.current.delete(manualRunId);',
        primaryRetryAt,
      );
      const reclaimAt = retry.indexOf(
        'attemptedSupersededCleanupRunIdsRef.current.add(manualRunId);',
        releaseAt,
      );
      const retryCleanupAt = retry.indexOf(
        'void retireBoardCleanupReceipt(liveData.manualAiResume)',
        primaryRetryAt,
      );

      assert(autoStart >= 0 && autoEnd > autoStart && retirementAt >= 0
        && guardAt > retirementAt && claimAt > guardAt
        && autoClaimAt > claimAt && cleanupAt > autoClaimAt
        && primaryRetryAt >= 0 && releaseAt > primaryRetryAt
        && reclaimAt > releaseAt && retryCleanupAt > reclaimAt,
      'mount recovery must claim a primary retirement before cleanup, while explicit Retry must refresh and reclaim that exact id before invoking another attempt');
      return { automaticAttemptBounded: true, explicitRetryReclaims: true };
    },
  },
  {
    name: 'Job queue prioritizes paused-search continuations ahead of fresh Board requests without breaking FIFO classes',
    run: async () => {
      const queue = createModuleRunQueue();
      const starts = [];
      const positions = new Map();
      const callbacks = (nodeId) => ({
        onQueued: ({ position }) => positions.set(nodeId, position),
        onQueueUpdate: ({ position }) => positions.set(nodeId, position),
        onStart: () => starts.push(nodeId),
      });

      const active = await queue.acquireModuleRun({
        nodeId: 'active-board', lane: 'job-search', ...callbacks('active-board'),
      });
      const freshOnePromise = queue.acquireModuleRun({
        nodeId: 'fresh-board-1', lane: 'job-search', ...callbacks('fresh-board-1'),
      });
      const continuationOnePromise = queue.acquireModuleRun({
        nodeId: 'paused-search-1', lane: 'job-search', priority: 'continuation', ...callbacks('paused-search-1'),
      });
      const freshTwoPromise = queue.acquireModuleRun({
        nodeId: 'fresh-board-2', lane: 'job-search', ...callbacks('fresh-board-2'),
      });
      const continuationTwoPromise = queue.acquireModuleRun({
        nodeId: 'paused-search-2', lane: 'job-search', priority: 'continuation', ...callbacks('paused-search-2'),
      });

      const queuedOrder = queue.getSnapshot().lanes['job-search']?.queued.map(entry => entry.nodeId);
      assert(JSON.stringify(queuedOrder) === JSON.stringify([
        'paused-search-1', 'paused-search-2', 'fresh-board-1', 'fresh-board-2',
      ]),
      `continuations must overtake fresh work while remaining FIFO within both classes, got ${JSON.stringify(queuedOrder)}`);
      assert(positions.get('paused-search-1') === 1
        && positions.get('paused-search-2') === 2
        && positions.get('fresh-board-1') === 3
        && positions.get('fresh-board-2') === 4,
      `every queued UI marker must be renumbered after priority insertion, got ${JSON.stringify(Object.fromEntries(positions))}`);

      active.release();
      const continuationOne = await continuationOnePromise;
      continuationOne.release();
      const continuationTwo = await continuationTwoPromise;
      continuationTwo.release();
      const freshOne = await freshOnePromise;
      freshOne.release();
      const freshTwo = await freshTwoPromise;
      freshTwo.release();

      assert(JSON.stringify(starts) === JSON.stringify([
        'active-board', 'paused-search-1', 'paused-search-2', 'fresh-board-1', 'fresh-board-2',
      ]) && queue.getSnapshot().lanes['job-search'] == null,
      `the live lane must follow priority/FIFO order and fully drain, got ${JSON.stringify({ starts, snapshot: queue.getSnapshot() })}`);
      return { starts, finalPositions: Object.fromEntries(positions) };
    },
  },
  {
    name: 'Job Board owns the selected-search and combine queue transaction without nested leases',
    run() {
      const board = readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      const search = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const coordinator = readFileSync(new URL('../../src/contexts/JobSearchCoordinatorContext.jsx', import.meta.url), 'utf8');
      const coordinatorRegistry = readFileSync(new URL('../../src/utils/jobSearchCoordinatorRegistry.js', import.meta.url), 'utf8');
      const app = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8');
      const selectionUi = readFileSync(new URL('../../src/nodes/jobboard/JobBoardSearchSelection.jsx', import.meta.url), 'utf8');
      const sourcesReadyUi = readFileSync(new URL('../../src/nodes/jobsearch/JobSearchSourcesReadyState.jsx', import.meta.url), 'utf8');
      const sourceCardUi = readFileSync(new URL('../../src/nodes/JobSourceCardNode.jsx', import.meta.url), 'utf8');

      const scanStart = board.indexOf('const handleSearchSelected = useCallback');
      const scanEnd = board.indexOf('\n  useEffect(() => {', scanStart);
      const scan = board.slice(scanStart, scanEnd);
      const combineStart = board.indexOf('const handleCombine = useCallback');
      const combineEnd = board.indexOf('const handleSearchSelected = useCallback', combineStart);
      const combine = board.slice(combineStart, combineEnd);
      assert(scanStart >= 0 && scanEnd > scanStart,
        'the Board selected-search coordinator must have a bounded handler that this test can inspect');
      const connectedSigStart = board.indexOf('const connectedSig = useStore');
      const connectedSigEnd = board.indexOf('const boardRecoverySig = useStore', connectedSigStart);
      const connectedSig = board.slice(connectedSigStart, connectedSigEnd);
      const boardRecoverySigEnd = board.indexOf('const connectedModules = useMemo', connectedSigEnd);
      const boardRecoverySig = board.slice(connectedSigEnd, boardRecoverySigEnd);
      assert(connectedSig.includes('manualAiResumeTask: n.data?.manualAiResume?.task ||')
        && connectedSig.includes('manualAiRecoveryMode: n.data?.manualAiResume?.recoveryMode ||')
        && connectedSig.includes('manualAiRetirementPending: n.data?.manualAiResume?.retirementPending === true')
        && connectedSig.includes('hasCancellationPendingManualAiCleanup: hasCancellationPendingManualAiCleanup(n.data)')
        && connectedSig.includes('canonicalLocation: n.data?.canonicalLocation ||'),
      'the reactive connected-Search key must wake readiness for same-run manual mode/cleanup transitions and legacy canonical-location changes');
      assert(boardRecoverySigEnd > connectedSigEnd
        && boardRecoverySig.includes('retirementPending: manual.retirementPending === true,'),
      'the global Board ownership key must wake a yielded shared-Search recovery when a standalone Combine becomes cleanup-only and stops reserving that Search');
      const readinessStart = board.indexOf('function moduleSearchReadiness');
      const readinessEnd = board.indexOf('\nfunction captureJobSearchRollback', readinessStart);
      const readiness = board.slice(readinessStart, readinessEnd);
      assert(readiness.includes('if (isJobWorkflowDeletionPending(node?.id))')
        && readiness.includes("statusLabel: 'Deletion pending'")
        && readiness.includes('if (ACTIVE_SEARCH_STATES.has(hubState))'),
      'a pending deletion must be non-runnable before a live hub state can be treated as busy');
      const liveAdmissionAt = scan.indexOf('const liveBoardDataAtAdmission = getNode(id)?.data || data;');
      const liveLockGuardAt = scan.indexOf('|| liveBoardDataAtAdmission.locked', liveAdmissionAt);
      assert(liveAdmissionAt >= 0 && liveLockGuardAt > liveAdmissionAt
        && !scan.slice(liveAdmissionAt, liveLockGuardAt + 80).includes('|| data.locked'),
      'selected-search admission must read the Board lock from the live store so an invocation cannot start after a stale render was newly locked');

      const liveGraphAt = scan.indexOf('const liveNodes = getNodes();');
      const selectionAt = scan.indexOf('getSelectedConnectedJobSearchIds(liveBoardData.selectedSearchModuleIds, connectedIds)');
      const leaseAt = scan.indexOf('await moduleRunQueue.acquireModuleRun', selectionAt);
      const postLeaseLockAt = scan.indexOf('if (getNode(id)?.data?.locked) {', leaseAt);
      const fanoutAt = scan.indexOf('const parallelFreshChildren = !resumePlan');
      const fanoutPlanAt = scan.indexOf('const fanoutPlanCommitted = await waitForBoardPlanCommit({', fanoutAt);
      const fanoutLaunchAt = scan.indexOf('const childResults = await runJobBoardChildFanout(selectedIds, async (sourceId) => {', fanoutPlanAt);
      const fanoutJoinAt = scan.indexOf('EventLogger.log(`[JobBoard] scan fresh child fan-out settled', fanoutLaunchAt);
      const loopAt = scan.indexOf('for (const sourceId of sourceIdsToRunSerially)');
      const executionConnectionAt = scan.indexOf('const stillConnected = getEdges().some', loopAt);
      const terminalPausedAdoptionAt = scan.indexOf('const pausedLaneOutcome = resolveExactPausedJobBoardTerminal({', executionConnectionAt);
      const turnReadinessAt = scan.indexOf('let turnReadiness = moduleSearchReadiness(turnSourceNode, verifyingPlatformsRef.current', executionConnectionAt);
      const rollbackPersistAt = scan.indexOf('persistScanResume({\n          activeSourceId: sourceId,', turnReadinessAt);
      const childPlanCommitAt = scan.indexOf('const childPlanCommitted = await waitForBoardPlanCommit({', rollbackPersistAt);
      const childCancellationAt = scan.indexOf('const childCancelled = () => cancelled() || !getEdges().some', executionConnectionAt);
      const invokeAt = scan.indexOf('await jobSearchCoordinator.runSearchModule(sourceId', childCancellationAt);
      const completionGateAt = scan.indexOf("if (result?.status !== 'completed')", invokeAt);
      const combinePlanCommitAt = scan.indexOf('const combinePlanCommitted = await waitForBoardPlanCommit({', completionGateAt);
      const combineAt = scan.indexOf('const combineOutcome = await handleCombine({', completionGateAt);
      const releaseAt = scan.indexOf('lease?.release();', combineAt);
      assert(liveGraphAt >= 0 && selectionAt > liveGraphAt && leaseAt > selectionAt
        && postLeaseLockAt > leaseAt && fanoutAt > postLeaseLockAt
        && fanoutPlanAt > fanoutAt && fanoutLaunchAt > fanoutPlanAt && fanoutJoinAt > fanoutLaunchAt
        && loopAt > fanoutJoinAt
        && executionConnectionAt > loopAt && terminalPausedAdoptionAt > executionConnectionAt
        && turnReadinessAt > terminalPausedAdoptionAt
        && rollbackPersistAt > turnReadinessAt && childPlanCommitAt > rollbackPersistAt
        && childCancellationAt > childPlanCommitAt
        && invokeAt > childCancellationAt && completionGateAt > invokeAt
        && combinePlanCommitAt > completionGateAt && combineAt > combinePlanCommitAt && releaseAt > combineAt,
      'the Board must durably commit its admission and multi-child rollback receipts before fanning fresh children out, join their outcomes before the serial/recovery path or Combine, adopt an already-terminal exact paused child before recovery/readiness can rerun it, and release its one transaction lease only afterward');
      const fanout = scan.slice(fanoutAt, loopAt);
      assert(fanout.includes('activeSourceIds: [...selectedIds]')
        && fanout.includes('activeSourceRollbacks')
        && fanout.includes('selectedIds.forEach(sourceId => activeSearchModuleIdsRef.current.add(sourceId));')
        && fanout.includes('runJobBoardChildFanout(selectedIds, async (sourceId) =>')
        && fanout.includes('const recordFreshChildSettlement = async ({ sourceId, result, error }) =>')
        && fanout.includes('await waitForBoardPlanCommit({')
        && fanout.includes('completedSourceRuns: Object.fromEntries(completedOutcomes)')
        && fanout.includes('fanoutTerminalSourceIds.has(sourceId)')
        && fanout.includes('fanoutCleanupFailureSourceIds')
        && fanout.includes('const settlementCommitFailure = childResults.find(item => item.persistenceError);')
        && fanout.indexOf('const settlementCommitFailure = childResults.find(item => item.persistenceError);')
          < fanout.indexOf('const pausedSources = [];')
        && fanout.includes('activeSearchModuleIdsRef.current.delete(sourceId)')
        && fanout.includes("if (result?.status === 'cancelled') {")
        && fanout.includes("status: 'disconnected'")
        && fanout.includes('firstPaused')
        && fanout.includes('sourceIdsToRunSerially = [];'),
      'fresh selected children must all be admitted against one durable multi-child plan before any manual handoff can block the Board; outcomes are reconciled in selection order, an individually disconnected child cannot abort its siblings, source-card pauses remain a separate terminal gate, and Combine cannot run until the joined child set is terminal');
      const manualCancelStart = board.indexOf('const onManualAiNodeCancelled = (event) =>');
      const manualCancelEnd = board.indexOf("document.addEventListener('non-api-ai-node-cancelled'", manualCancelStart);
      const manualCancel = board.slice(manualCancelStart, manualCancelEnd);
      assert(manualCancel.includes('const cancelledActiveChild = !!(')
        && manualCancel.includes('activeChildIds.has(cancelledNodeId)')
        && manualCancel.includes('childMarker?.orchestratorNodeId === id')
        && manualCancel.includes('childMarker?.boardRunId === childPlan?.boardRunId')
        && manualCancel.includes('child manual-AI cancellation aborting fan-out')
        && manualCancel.includes('void handleCancelRun();'),
      'cancelling one active child handoff must route through the exact Board transaction so sibling child handoffs are also cancelled');
      const terminalPausedAdoption = scan.slice(terminalPausedAdoptionAt, turnReadinessAt);
      assert(terminalPausedAdoption.includes('boardRunId,')
        && terminalPausedAdoption.includes('resumePlan: iterationPlan,')
        && terminalPausedAdoption.includes('livePlan: getNode(id)?.data?.boardScanResume || null,')
        && terminalPausedAdoption.includes("pausedLaneOutcome.status === 'adopted'")
        && terminalPausedAdoption.includes('pausedLaneOutcome.mergeable')
        && terminalPausedAdoption.includes("status: 'non-mergeable'")
        && terminalPausedAdoption.includes('completedOutcomes.set(sourceId, pausedLaneOutcome.outcome)')
        && terminalPausedAdoption.includes('awaitingSourceResolution: null')
        && terminalPausedAdoption.includes('recoverableFailure: null')
        && terminalPausedAdoption.includes("pausedLaneOutcome.status === 'generation-changed'")
        && terminalPausedAdoption.includes('changed before its paused source continuation could finish')
        && terminalPausedAdoption.includes('continue;'),
      'a Board that queues behind a source-card continuation must consume only the exact paused run once it is terminal, fail closed on a changed generation, clear an adopted handoff atomically, and leave any manual-AI retirement marker to the child cleanup path');
      assert(scan.slice(postLeaseLockAt, loopAt).includes('autoResumedBoardScanRef.current = null;')
        && scan.slice(postLeaseLockAt, loopAt).includes('scan deferred because Board was locked at its lane turn'),
      'a Board locked while queued must yield before touching children and unlatch its durable recovery plan for an unlock retry');
      const scanRecoveryStart = board.indexOf('// A Board-owned child can survive an app restart');
      const scanRecoveryEnd = board.indexOf("document.addEventListener('non-api-ai-node-cancelled'", scanRecoveryStart);
      const scanRecovery = board.slice(scanRecoveryStart, scanRecoveryEnd);
      assert(scanRecovery.includes('const sourceRecoveryOwner = sourceData.manualAiResume?.runId')
        && scanRecovery.includes('} else if (ACTIVE_SEARCH_STATES.has(sourceData.hubState)) {')
        && scanRecovery.includes('connectedSig, data.boardCancellation'),
      'reload recovery must wake on child state changes and let only the exact plan owner replay a paused source inside its reacquired Board lane');
      assert(scan.includes('const boardRunId = resumePlan?.boardRunId || `job-board-scan:${id}:${entropy}`')
        && scan.includes('const admissionPlanCommitted = await waitForBoardPlanCommit({')
        && scan.includes('The Job Board scan recovery plan was not committed before queue admission.')
        && scan.includes('nodeId: id,')
        && scan.includes('cancellationNodeIds: transactionSelectedIds')
        && scan.includes("kind: 'job-board-search'")
        && scan.includes("lane: 'job-search'")
        && scan.includes('orchestratorNodeId: id,')
        && scan.includes('boardRunId,')
        && scan.includes('isCancelled: childCancelled,')
        && scan.includes('queueManagedByScan: true,')
        && scan.includes('expectedCombineSourceRuns: combineSourceRuns,')
        && scan.includes('The Job Board combine recovery plan was not committed before processing started.')
        && scan.indexOf('await moduleRunQueue.acquireModuleRun', leaseAt + 1) === -1,
      'the whole scan must be Board-owned in the shared lane, cancellable by either owner, correlated by an exact durable Board run id, and use no per-child lease');
      assert(scan.includes('scanRunRef.current')
        && scan.includes('stillConnected')
        && scan.includes('remainsConnected')
        && scan.includes('const incompleteSearches = Array.isArray(resumePlan?.incompleteSearches)')
        && scan.includes('scan module incomplete; continuing')
        && scan.includes('if (incompleteSearches.length > 0)')
        && scan.includes("if (result?.status === 'paused')")
        && scan.includes('awaitingSourceResolution: {')
        && scan.includes('activeSourceRollback,')
        && scan.includes('scan waiting for source resolution')
        && scan.includes('const completedOutcomes = new Map(Object.entries(resumePlan?.completedSourceRuns || {}))')
        && scan.includes("outcome?.resultDisposition === 'collection-only'")
        && scan.includes("outcome?.resultDisposition === 'incomplete'")
        && scan.includes("status: incompleteOutcome ? 'incomplete' : 'non-mergeable'")
        && scan.includes('isMergeableTerminalJobSearchOutcome(completedSource, completedOutcome)')
        && scan.includes('needs hiring-fit scoring before this Board can combine')
        && scan.includes('const supersededSourceId = [...completedOutcomes.keys()].find')
        && scan.includes('!completedJobSearchOutcomeMatches(source, expected)'),
      'duplicate admission and disconnects must be guarded, a paused child must retain its exact rollback/run handoff until its source-card continuation finishes, and exact child outcomes must still match before auto-combine');
      const freshRunSetupAt = search.indexOf('// Destructive fresh-run setup belongs after queue admission.');
      const freshRunSetupEnd = search.indexOf('// Step 2: Query construction', freshRunSetupAt);
      const freshRunSetup = search.slice(freshRunSetupAt, freshRunSetupEnd);
      assert(freshRunSetupAt >= 0
        && freshRunSetupEnd > freshRunSetupAt
        && freshRunSetup.includes('aiSkipped: false')
        && freshRunSetup.includes('collectionOnly: false')
        && freshRunSetup.includes('testMode: false'),
      'every fresh Job Search admission must clear prior collection-only/Test Mode provenance before provider work, while paused/recovery continuations retain their current terminal disposition');
      assert(scanRecovery.includes('const awaitingSourceResolution = plan.awaitingSourceResolution;')
        && scanRecovery.includes('exactReplayHandoff = (')
        && scanRecovery.includes('sourceData.manualAiResume?.runId')
        && scanRecovery.includes('terminalJobSearchOutcome(source)')
        && scanRecovery.includes('exactPausedSourceContinuation(')
        && scanRecovery.includes('const retainedPausedDescriptor = (')
        && scanRecovery.includes('exactReplayHandoff\n      || exactPausedSourceContinuation(')
        && scanRecovery.includes('awaitingSourceResolutions: retainedPausedDescriptor')
        && scanRecovery.includes('promoteJobBoardPausedSourceResolution({'),
      'a reloaded Board must retain the exact paused source descriptor through a clean/manual continuation or a sanitizer-restored staged-score replay, while still requiring an exact terminal receipt before completion');
      assert(combineStart >= 0 && combineEnd > combineStart
        && combine.includes('const liveBoardDataAtAdmission = getNode(id)?.data || {};')
        && combine.includes('|| liveBoardDataAtAdmission.locked')
        && combine.includes('const queueManagedByScan = afterSearch')
        && combine.includes('if (!queueManagedByScan) {')
        && combine.includes('combine continuing inside scan queue turn'),
      'the final Combine must reject a live locked Board, reuse the active scan transaction, and let standalone Combine acquire its own lane turn');
      const recoveredTokenAt = combine.indexOf('const claimedManualAiRunId = createManualAiRunId(id);');
      const recoveredTokenClaimGuardAt = combine.indexOf('combineRecoveryTokenClaimRef.current = recoveryTokenClaim;');
      const recoveredTokenUpdateAt = combine.indexOf('updateGlobal(id, (node) => {', recoveredTokenAt);
      const recoveredTokenCommitAt = combine.indexOf('const recoveryTokenCommitted = await waitForBoardPlanCommit({', recoveredTokenUpdateAt);
      const activeCombineTokenAt = combine.indexOf("const combineToken = Symbol('job-board-combine');");
      const firstProviderAt = combine.indexOf('window.electronAPI.bucketJobs', activeCombineTokenAt);
      assert(recoveredTokenAt >= 0
        && recoveredTokenUpdateAt > recoveredTokenAt
        && recoveredTokenCommitAt > recoveredTokenUpdateAt
        && activeCombineTokenAt > recoveredTokenCommitAt
        && firstProviderAt > activeCombineTokenAt
        && combine.includes('if (combineRunRef.current || combineRecoveryTokenClaimRef.current)')
        && recoveredTokenClaimGuardAt >= 0
        && recoveredTokenClaimGuardAt < recoveredTokenAt
        && combine.includes('const durableManualAiRunId = recoveryPlanAtClaim.combineManualAiRunId || null;')
        && combine.includes('manualAiRunId = durableManualAiRunId;')
        && combine.slice(recoveredTokenUpdateAt, recoveredTokenCommitAt).includes("currentPlan.phase !== 'combine'")
        && combine.slice(recoveredTokenUpdateAt, recoveredTokenCommitAt).includes('currentPlan.boardRunId !== expectedBoardRunId')
        && combine.slice(recoveredTokenUpdateAt, recoveredTokenCommitAt).includes('currentPlan.combineManualAiRunId')
        && combine.slice(recoveredTokenUpdateAt, recoveredTokenCommitAt).includes('currentPlan.updatedAt !== recoveryPlanAtClaim.updatedAt')
        && combine.slice(recoveredTokenUpdateAt, recoveredTokenCommitAt).includes('combineManualAiRunId: claimedManualAiRunId')
        && combine.slice(recoveredTokenCommitAt, activeCombineTokenAt).includes('if (!recoveryTokenCommitted)')
        && combine.slice(recoveredTokenCommitAt, activeCombineTokenAt).includes('cancellationInFlightRef.current || liveDataAfterClaim.boardCancellation')
        && combine.slice(recoveredTokenCommitAt, activeCombineTokenAt).includes('liveDataAfterClaim.boardCancellation')
        && combine.slice(recoveredTokenCommitAt, activeCombineTokenAt).includes('liveDataAfterClaim.locked')
        && combine.slice(recoveredTokenCommitAt, activeCombineTokenAt).includes('combineRecoveryTokenClaimRef.current = null;'),
      'a recovered phase=combine receipt must adopt an already durable token, or exclusively claim, atomically install, and visibly verify one fresh token before it starts an in-memory Combine or any provider work');
      const scanQueueMarkerClearAt = scan.indexOf('updateGlobal(id, { queuedModuleRun: null });', leaseAt);
      const scanDeletionStartGuardAt = scan.indexOf('isJobWorkflowDeletionPending(id)', scanQueueMarkerClearAt);
      const combineLeaseAt = combine.indexOf('await moduleRunQueue.acquireModuleRun');
      const combineQueueMarkerClearAt = combine.indexOf('updateGlobal(id, { queuedModuleRun: null });', combineLeaseAt);
      const combineDeletionStartGuardAt = combine.indexOf('cancelled() || isJobWorkflowDeletionPending(id)', combineQueueMarkerClearAt);
      assert(scanQueueMarkerClearAt > leaseAt && scanDeletionStartGuardAt > scanQueueMarkerClearAt
        && scan.includes('transactionSelectedIds.some(sourceId => isJobWorkflowDeletionPending(sourceId))')
        && combineLeaseAt >= 0 && combineQueueMarkerClearAt > combineLeaseAt
        && combineDeletionStartGuardAt > combineQueueMarkerClearAt
        && combine.includes('inputsAtCombine.all.some(module => isJobWorkflowDeletionPending(module.id))')
        && combine.includes('const boardDeletionPending = isJobWorkflowDeletionPending(id);')
        && combine.includes('liveStateBeforeCommit.all.some(module => isJobWorkflowDeletionPending(module.id))')
        && combine.includes('await completeManualAiRun(manualAiRunId);'),
      'queued Boards must clear their queue marker and reject pending Board/selected-Search deletion at lane start, while Combine rejects connected Search deletion before provider work and durably retires its manual handoff before any Board/Search deletion can cross commit');
      assert(scan.includes("if (result?.status === 'cancelled')")
        && scan.includes('scan yielding after child deletion cancellation')
        && scan.includes('scan yielding after child deletion error')
        && scan.includes('scan yielding before combine while deletion is pending'),
      'a child cancellation caused by reversible deletion must retain the exact parent plan and never masquerade as a user cancellation or continue into Combine');
      assert(scan.includes("combineOutcome?.status === 'busy'")
        && scan.includes("combineOutcome?.status === 'not-ready'")
        && scan.includes("combineOutcome?.status === 'cancelled'")
        && scan.includes("combineOutcome?.status === 'superseded'")
        && scan.includes("combineOutcome?.status !== 'completed'")
        && scan.includes('scan combine deferred')
        && scan.includes('scan combine superseded')
        && scan.includes('autoResumedBoardScanRef.current = null;')
        && scan.includes('autoResumedManualAiRunRef.current = null;')
        && scan.includes('clearExactBoardScanResume(updateGlobal, id, boardRunId)'),
      'the parent scan must retain its exact Combine receipt for transient/cancelled outcomes, retire a superseded receipt without claiming success, and only log completion for an exact completed result');
      const settleStart = board.indexOf('const settleRecoveredCombine = useCallback');
      const settleEnd = board.indexOf('// A Board-owned child can survive an app restart', settleStart);
      const settle = board.slice(settleStart, settleEnd);
      assert(settleEnd > settleStart
        && settle.includes("outcome?.status === 'busy'")
        && settle.includes("outcome?.status === 'not-ready'")
        && settle.includes("outcome?.status === 'cancelled'")
        && settle.includes('autoResumedBoardScanRef.current = null;')
        && settle.includes('autoResumedManualAiRunRef.current = null;')
        && settle.includes('return false;'),
      'a queued/provider-time lock or other nonterminal recovered Combine outcome must release both one-shot recovery latches so the unchanged exact receipt can retry after the blocker changes');
      const recoveryEffectStart = board.indexOf('// A Board-owned child can survive an app restart');
      const recoveryEffectEnd = board.indexOf('const onManualAiNodeCancelled', recoveryEffectStart);
      const recoveryEffect = board.slice(recoveryEffectStart, recoveryEffectEnd);
      const manualRecoveryStart = board.indexOf('const resume = data.manualAiResume;', recoveryEffectEnd);
      const manualRecoveryEnd = board.indexOf('const handleRetryRecovery', manualRecoveryStart);
      const manualRecovery = board.slice(manualRecoveryStart, manualRecoveryEnd);
      assert(board.includes('function boardRecoveryTouchesPendingDeletion(')
        && recoveryEffect.includes('boardRecoveryTouchesPendingDeletion(id, plan, data.manualAiResume)')
        && recoveryEffect.includes('autoResumedBoardScanRef.current = null;')
        && recoveryEffect.includes('deletionLifecycleRevision')
        && manualRecovery.includes('boardRecoveryTouchesPendingDeletion(id, data.boardScanResume, resume)')
        && manualRecovery.includes('autoResumedManualAiRunRef.current = null;'),
      'Board scan/manual recovery must yield without consuming its one-shot latch while the Board or any exact input is pending reversible deletion, then wake on lifecycle settlement');
      const retryRecoveryStart = board.indexOf('const handleRetryRecovery = useCallback');
      const retryRecoveryEnd = board.indexOf('const durableRecoveryActive', retryRecoveryStart);
      const retryRecovery = board.slice(retryRecoveryStart, retryRecoveryEnd);
      assert(recoveryEffect.includes('expectedBoardRunId: plan.boardRunId,')
        && recoveryEffect.includes("plan.combineManualAiRunId || 'unclaimed'")
        && retryRecovery.includes('expectedBoardRunId: plan.boardRunId,'),
      'automatic and explicit phase=combine recovery must bind a newly claimed manual-AI token to the exact durable Board run and wake when that durable claim changes');

      const pipelineStart = search.indexOf('const runPipeline = useCallback');
      const pipelineEnd = search.indexOf('const startProcessing = useCallback', pipelineStart);
      const pipeline = search.slice(pipelineStart, pipelineEnd);
      const childRunnerStart = search.indexOf('const runForJobBoard = useCallback');
      const childRunnerEnd = search.indexOf('// Re-score the currently displayed listings', childRunnerStart);
      const childRunner = search.slice(childRunnerStart, childRunnerEnd);
      const childCancelStart = search.indexOf('const cancelBoardRun = useCallback');
      const childCancel = search.slice(childCancelStart, childRunnerStart);
      const activeChildCancelStart = childCancel.indexOf('control.cancelled = true;');
      const activeChildCancel = childCancel.slice(activeChildCancelStart);
      const activeAcknowledgementAt = activeChildCancel.indexOf(
        'const acknowledgement = await window.electronAPI.cancelNodeTaskAndWait(id, reason);',
      );
      const activeDiscoveryAt = activeChildCancel.indexOf(
        'for (const acknowledgedRunId of acknowledgement?.manualAiRunIds || [])',
        activeAcknowledgementAt,
      );
      const activeSettlementAt = activeChildCancel.indexOf(
        'await settleManualAiRetirement({',
        activeDiscoveryAt,
      );
      const activeParentFenceAt = activeChildCancel.indexOf(
        'beforeRetirement: acknowledgedIds => persistChildCancellationCleanup({',
        activeSettlementAt,
      );
      assert(pipelineStart >= 0 && pipelineEnd > pipelineStart
        && pipeline.includes('if (!queueManagedByBoard) {\n        lease = await moduleRunQueue.acquireModuleRun')
        && pipeline.includes("if (!orchestratorNodeId) throw new Error('A board-managed search requires an orchestrator node id.')")
        && childRunnerStart >= 0 && childRunnerEnd > childRunnerStart
        && childRunner.includes('queueManagedByBoard: true')
        && childRunner.includes('const runFreshBoardImport = () => {')
        && childRunner.includes("runOrigin: 'job-board-scan'")
        && childRunner.includes('parentCancelled: cancelled')
        && childRunner.includes('jobSearchCoordinator.registerSearchModule(id, runForJobBoard, cancelBoardRun)'),
      'a Board-invoked child must bypass only its top-level lane acquisition while retaining exact orchestration identity and parent cancellation; otherwise it deadlocks behind the Board lease');

      const outcomeDeclarationAt = childRunner.indexOf('let outcome;');
      const savedRecoveryAt = childRunner.indexOf('if (isSavedScrapeManualAiResume(effectiveManualAiResume))', outcomeDeclarationAt);
      const savedRecoveryInvokeAt = childRunner.indexOf('outcome = await resumeSavedScrapeRef.current?.({', savedRecoveryAt);
      const interruptedRecoveryAt = childRunner.indexOf('} else if (recoverInterruptedJobRun || window.electronAPI?.peekJobRun)', savedRecoveryInvokeAt);
      const interruptedRecoveryInvokeAt = childRunner.indexOf('outcome = await resumeInterruptedRunRef.current?.({', interruptedRecoveryAt);
      const missingLedgerFallbackAt = childRunner.indexOf("if (outcome?.status === 'not-found')", interruptedRecoveryInvokeAt);
      const freshRunAt = childRunner.indexOf('outcome = await runFreshBoardImport();', missingLedgerFallbackAt);
      const terminalGateAt = childRunner.indexOf("if (!outcome || outcome.status !== 'completed')", freshRunAt);
      const committedWaitAt = childRunner.indexOf('const committed = await waitForCommittedSearchOutcome({', terminalGateAt);
      assert(childRunner.includes('const manualAiRunId = effectiveManualAiResume?.runId || createManualAiRunId(id);')
        && outcomeDeclarationAt >= 0 && savedRecoveryAt > outcomeDeclarationAt
        && savedRecoveryInvokeAt > savedRecoveryAt && interruptedRecoveryAt > savedRecoveryInvokeAt
        && interruptedRecoveryInvokeAt > interruptedRecoveryAt
        && missingLedgerFallbackAt > interruptedRecoveryInvokeAt && freshRunAt > missingLedgerFallbackAt
        && terminalGateAt > freshRunAt && committedWaitAt > terminalGateAt
        && childRunner.includes('jobCareerImportBoardAdmission(getNode(id)?.data, {')
        && childRunner.includes('outcome,')
        && !childRunner.includes('const liveAfter = getNode'),
      'the child runner must distinguish saved-manual, interrupted-ledger (with safe not-found fallback), and fresh execution, then wait until the exact terminal run/disposition is committed before the Board snapshots live inputs');
      assert(childCancelStart >= 0
        && childCancel.includes('control.orchestratorNodeId !== orchestratorNodeId')
        && childCancel.includes('control.boardRunId !== boardRunId')
        && childCancel.includes('control.cancelled = true;')
        && childCancel.includes('epoch.bump();')
        && childCancel.includes('processingRunsRef.current.cancel();')
        && childCancel.includes('boardRunRollbackPatch(control.previousData, id)')
        && childCancel.includes('cancelNodeTaskAndWait(id, reason)')
        && childCancel.includes('acknowledgement?.settled !== true')
        && activeChildCancelStart >= 0
        && activeChildCancel.includes('const controlManualAiRunIds = control.manualAiRunIds instanceof Set')
        && activeChildCancel.includes(': new Set([control.manualAiRunId].filter(Boolean));')
        && activeChildCancel.includes('manualAiRunIds: [...controlManualAiRunIds],')
        && activeAcknowledgementAt >= 0 && activeDiscoveryAt > activeAcknowledgementAt
        && activeSettlementAt > activeDiscoveryAt && activeParentFenceAt > activeSettlementAt
        && activeChildCancel.includes('manualAiRunIds: acknowledgedIds,')
        && activeChildCancel.includes('acknowledgedRunIds: [...controlManualAiRunIds],')
        && !activeChildCancel.includes('await retireManualAiRunDurably(control.manualAiRunId)')
        && childCancel.includes('liveRunId !== priorRunId')
        && childCancel.includes('cancelQueuedRunsForNode(\n            cancellationLeaseOwnerId,')
        && !childCancel.includes('cancelQueuedRunsForNode(id'),
      'child cancellation must verify exact Board ownership, invalidate late continuations, restore the pre-run snapshot, durably fan out every acknowledged manual-AI id through both Search and Board receipts before retirement, clean only the abandoned run artifacts, and leave other Boards’ queued turns intact');

      assert(coordinator.includes('createJobSearchCoordinatorRegistry')
        && coordinator.includes('registry.registerSearchModule')
        && coordinator.includes('registry.cancelBoardModule')
        && coordinatorRegistry.includes('const registration = { runner, canceller, closing: false };')
        && coordinatorRegistry.includes('searchRegistrations.get(nodeId) !== registration')
        && coordinatorRegistry.includes('registration.closing = true;')
        && coordinatorRegistry.includes("'JOB_SEARCH_MODULE_UNAVAILABLE'")
        && coordinatorRegistry.includes('return registration.runner(options);')
        && coordinatorRegistry.includes('return Promise.resolve(registration.canceller(options));')
        && coordinatorRegistry.includes('const registration = { canceller, closing: false };'),
      'the coordinator registry must normalize runner settlement, start exact cancellation authorization synchronously, normalize cancellation throws, reject unavailable modules, and prevent stale effect cleanup from deleting a newer registration');
      assert(app.includes('<ModuleRunQueueProvider>')
        && app.includes('<JobSearchCoordinatorProvider>')
        && app.indexOf('<ModuleRunQueueProvider>') < app.indexOf('<JobSearchCoordinatorProvider>'),
      'the app must provide one canvas-wide search registry inside the shared module queue boundary');
      assert(board.includes('<JobBoardSearchSelection')
        && board.includes('selectedIds={selectedSearchModuleIds}')
        && board.includes('onRun={handleSearchSelected}')
        && board.includes('onCancel={handleCancelRun}')
        && board.includes('onMove={moveSearchModule}')
        && board.includes('Fresh searches may start in parallel. The shown order controls recovery and result reconciliation; completed searches are reused without another scan. Selection controls which sources start or continue; the board combines all connected completed results.')
        && selectionUi.includes('<input\n                    type="checkbox"')
        && selectionUi.includes('<div\n                key={module.id}')
        && selectionUi.includes('</label>\n                {typeof onMove ===')
        && selectionUi.includes('role="group" aria-label={`Recovery and reconciliation order for ${label}`}')
        && selectionUi.includes('Move ${label} earlier')
        && selectionUi.includes('Move ${label} later')
        && selectionUi.includes('jobBoardSelectionPresentation(selectedRows.map(({ module }) => module))')
        && selectionUi.includes("running ? 'Cancel current run'")
        && jobBoardSelectionPresentation([]).runLabel === 'Search selected & combine'
        && jobBoardSelectionPresentation([{ boardAction: 'reuse' }]).runLabel === 'Combine saved results'
        && !selectionUi.includes('onCombineSaved')
        && sourcesReadyUi.includes('it then continues automatically; no extra Board action is needed')
        && sourceCardUi.includes('scoring and any waiting Job Board continue automatically.'),
      'the Board must expose controlled per-connection selection, a live cancellation action, and clear automatic continuation after manual-source resolution without a second combine button');

      const userCancelStart = board.indexOf('const handleCancelRun = useCallback');
      const userCancelEnd = board.indexOf('const handleCombine = useCallback', userCancelStart);
      const userCancel = board.slice(userCancelStart, userCancelEnd);
      assert(userCancelStart >= 0 && userCancelEnd > userCancelStart
        && userCancel.includes('const cancellationIntentPromise = persistBoardCancellationIntent(reason);')
        && userCancel.includes('epoch.bump();')
        && userCancel.includes('const childCancellation = cancelActiveSearchModule(reason, { allowStale: true });')
        && userCancel.includes('const boardCancellation = cancelBoardTaskAndRetireManualAi(reason);')
        && userCancel.includes('await Promise.all([childCancellation, boardCancellation]);')
        && userCancel.includes("moduleRunQueue.cancelQueuedRunsForNode(id, 'Job Board run cancelled')")
        && userCancel.includes('node?.data?.boardCancellation?.operationId !== cancellationIntent.operationId')
        && userCancel.includes('boardCancellation: null,')
        && userCancel.includes('...(planOwned ? { boardScanResume: null } : {})')
        && !userCancel.includes('clearBoardChildren()'),
      'Cancel current run must first persist exact cancellation authority, then stop queued, child, and Board work, and retire only matching recovery receipts while preserving the existing result cascade');
      assert(board.includes('const activeCombineManualAiRunRef = useRef(null);')
        && board.includes('activeCombineManualAiRunRef.current = {')
        && board.includes('token: combineToken,')
        && board.includes('runId: manualAiRunId,')
        && board.includes('startedAt: combineStartedAt,')
        && board.includes('activeCombineManualAiRunRef.current?.token === combineToken')
        && board.includes('const retireActiveCombineManualAiRun = useCallback')
        && board.includes('const runIds = expectedRunId')
        && board.includes(': new Set([active?.runId, persistedRunId].filter(Boolean));')
        && board.includes('const retireBoardCleanupReceipt = useCallback')
        && board.includes('if (receipt.cancellationPending === true)')
        && board.includes('const acknowledgement = await window.electronAPI.cancelNodeTaskAndWait(')
        && board.includes('for (const runId of acknowledgement?.manualAiRunIds || [])')
        && board.includes('const persistAcknowledgedBoardManualAiRunIds = useCallback')
        && board.includes('manualAiRunIds: [...new Set([')
        && board.includes('const allCommitted = runIds.every(runId => (')
        && board.includes("throw new Error('The acknowledged Job Board manual-AI cleanup receipts were not committed.')"),
      'Board cancellation must synchronously retain and token-scope every known or acknowledgement-discovered manual-AI run id, and verify its durable cleanup receipt before retirement');

      const cleanupStart = board.indexOf('const cleanupBoard = useCallback');
      const cleanupEnd = board.indexOf('useUnmountEffect(cleanupBoard)', cleanupStart);
      const clearStart = board.indexOf('const handleClear = useCallback');
      const clearEnd = board.indexOf('const completeManualAiRun', clearStart);
      const cancelStart = board.indexOf('const cancelActiveSearchModule = useCallback');
      const cancelEnd = board.indexOf('const cleanupBoard = useCallback', cancelStart);
      const cancelActive = board.slice(cancelStart, cancelEnd);
      assert(cancelStart >= 0
        && cancelActive.includes('const liveBoardData = getNode(id)?.data || data;')
        && cancelActive.includes('const durablePlan = liveBoardData.boardScanResume || data.boardScanResume;')
        && cancelActive.includes('const durableCancellation = liveBoardData.boardCancellation || data.boardCancellation || null;')
        && cancelActive.includes('const sourceIds = new Set((Array.isArray(requestedSourceIds)')
        && cancelActive.includes('...activeSearchModuleIdsRef.current')
        && cancelActive.includes('durablePlan.activeSourceIds')
        && cancelActive.includes("durablePlan?.phase === 'searches' ? durablePlan.activeSourceId : null")
        && cancelActive.includes('durableCancellation?.sourceId')
        && cancelActive.includes('|| durableCancellation?.boardRunId')
        && cancelActive.includes('jobSearchCoordinator.cancelSearchModule(sourceId')
        && cancelActive.includes('orchestratorNodeId: id,')
        && cancelActive.includes('boardRunId,')
        && cancelActive.includes('queueManagedExternally: !!scanLaneLeaseOwnerRef.current')
        && cancelActive.includes('durablePlanOverride: durablePlan ||')
        && cancelActive.includes("error?.code === 'JOB_SEARCH_MODULE_UNAVAILABLE' && !sourceExistsAnywhere")
        && cancelActive.includes('cancelNodeTaskAndWait(sourceId, reason)'),
      'Board cancellation must address every live fan-out child through the coordinator with the exact Board run identity, falling back to durable singular/plural recovery ownership after reload');
      for (const section of [board.slice(cleanupStart, cleanupEnd), board.slice(clearStart, clearEnd)]) {
        assert(section.includes('cancelActiveSearchModule(')
          && section.includes('moduleRunQueue.cancelQueuedRunsForNode(id'),
        'Clear and unmount must remove the Board queue entry and roll back only the source module whose Board-owned turn is active');
      }
      return { selection: 'live allow-list', queueOwner: 'jobboard', nestedLeaseBypassed: true };
    },
  },
  {
    name: 'Job Search preserves Board ownership across queue, cancellation, and source-card rollback races',
    run() {
      const board = readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      const search = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const sourceCard = readFileSync(new URL('../../src/nodes/JobSourceCardNode.jsx', import.meta.url), 'utf8');
      const dialog = readFileSync(new URL('../../src/components/NonApiAiDialog.jsx', import.meta.url), 'utf8');

      const resetStart = search.indexOf('const resetHandler = useCallback');
      const resetEnd = search.indexOf('// Non-API scoring is controlled', resetStart);
      const reset = search.slice(resetStart, resetEnd);
      const exactRouteStart = search.indexOf('const cancelActiveBoardChild = useCallback');
      const exactRoute = search.slice(exactRouteStart, resetStart);
      const ownedQueueCancelAt = reset.indexOf('moduleRunQueue.cancelQueuedRunsOwnedByNode(id)');
      const durableOwnerAt = reset.indexOf('let durableBoardOwner = findJobSearchBoardActiveRecoveryOwner(');
      const durableParentCancelAt = reset.indexOf('jobSearchCoordinator.cancelBoardModule(', durableOwnerAt);
      const lockGuardAt = reset.indexOf('if (getNode(id)?.data?.locked ?? data.locked)');
      assert(exactRouteStart >= 0
        && exactRoute.includes('const control = boardRunControlRef.current;')
        && exactRoute.includes('orchestratorNodeId: control.orchestratorNodeId')
        && exactRoute.includes('boardRunId: control.boardRunId')
        && reset.indexOf("cancelActiveBoardChild('board-child-cancelled')") >= 0
        && reset.indexOf("cancelActiveBoardChild('board-child-cancelled')") < lockGuardAt
        && durableOwnerAt > reset.indexOf("cancelActiveBoardChild('board-child-cancelled')")
        && durableParentCancelAt > durableOwnerAt
        && ownedQueueCancelAt < durableParentCancelAt
        && reset.indexOf('while (durableBoardOwner)') > durableOwnerAt
        && reset.includes('const cancelledQueuedBoardOwners = new Set();')
        && reset.includes('await waitForRendererCommitFrame();')
        && reset.indexOf('durableBoardOwner = findJobSearchBoardActiveRecoveryOwner(', durableParentCancelAt) > durableParentCancelAt
        && reset.includes('cancelledQueuedBoardOwners.has(durableOwnerKey)')
        && reset.includes('boardRunId: durableBoardOwner.boardRunId')
        && reset.includes('durableBoardData?.boardScanResume?.activeSourceIds?.includes(id)')
        && reset.includes('durableBoardData?.boardCancellation?.sourceIds?.includes(id)')
        && search.includes('boardPlan?.activeSourceManualAiRunIds?.[id]')
        && search.includes('cancellationCleanupsBySource')
        && search.includes('const nextSourceCleanup = {')
        && search.includes('cancellationCleanup: { ...nextSourceCleanup },')
        && lockGuardAt > durableParentCancelAt
        && ownedQueueCancelAt > reset.indexOf('epoch.bump();')
        && reset.indexOf('processingRunsRef.current.cancel();') < durableParentCancelAt
        && reset.includes('const resetData = getNode(id)?.data || data;')
        && !reset.includes('moduleRunQueue.cancelQueuedRunsForNode(id)'),
      'the Search cancel button must route mounted and every durable A+B queued owner through exact Board identities, then cancel only Search-owned queued work so no uncancelled Board alias races the reset');

      // "Solve all blocked sources": one press drives every blocked source in
      // order. These pin the four ways it can go wrong invisibly — a deadlock,
      // a hang, a silently skipped source, and a bypassed ownership guard.
      const solveAllStart = search.indexOf('const handleSolveAllBlockedSources = useCallback(async () =>');
      const solveAllEnd = search.indexOf('  }, [\n    activeEnabledSourceIds, addToast, data, ensureBlockedSourceCards,', solveAllStart);
      assert(solveAllStart >= 0 && solveAllEnd > solveAllStart, 'the Solve-all driver must exist and be delimited');
      const solveAll = search.slice(solveAllStart, solveAllEnd);
      // Each card takes the shared 'job-search' lane for its own Solve and a
      // lane has exactly one active holder, so a driver lease deadlocks on the
      // first source.
      assert(!solveAll.includes('acquireModuleRun') && !solveAll.includes('moduleRunQueue'),
        'the Solve-all driver must hold NO moduleRunQueue lease — the cards it drives take the shared lane themselves');
      // Same ownership re-proof as Score-current, so a stale click fails closed.
      assert(solveAll.includes('if (isJobWorkflowDeletionPending(id)) return;')
        && solveAll.includes("if (liveData.hubState !== 'sources-ready') return;")
        && solveAll.includes('if (processingRunsRef.current.active || scoringContinuationAdmissionRef.current) return;')
        && solveAll.includes('if (hasPendingManualAiRetirement(liveData)) return;')
        && solveAll.includes('if (liveBoardRecoveryOwner && !livePausedBoardContinuationOwner) {'),
      'Solve all must re-prove deletion, hub state, in-flight scoring and Board ownership before driving any card');
      assert(solveAll.includes('ensureBlockedSourceCards(scrapeWarningsRef.current);')
        && solveAll.indexOf('ensureBlockedSourceCards(scrapeWarningsRef.current);') < solveAll.indexOf('const blockedSourceIds = []'),
      'every blocked source must have a card before the driver tries to drive it');
      assert(solveAll.includes('canAttemptJobSourceResolve(w)'),
        'only sources whose warning offers a real recovery action are driven — a terminal hard block has nothing to Solve');
      // The ack is what distinguishes "no listener" from "still working": a
      // freshly spawned card is in the node store before its effect registers.
      assert(solveAll.includes("document.addEventListener('job-source-solve-ack', onAck);")
        && solveAll.includes("document.addEventListener('job-source-solve-done', onDone);")
        && solveAll.includes("if (!acked) settle('not-delivered');")
        && solveAll.includes("if (outcome === 'not-delivered') {"),
      'an unanswered request must resolve as not-delivered and retry once, never hang the sequence');
      assert(solveAll.includes("while (outcome === 'busy'"),
        'a source that reports busy must be retried, not silently treated as done — that would skip a genuinely blocked source');
      assert(solveAll.includes("if (outcome === 'board-owned' || outcome === 'stale-run' || outcome === 'hub-locked') break;"),
        'ownership changing mid-sequence stops the walk instead of stacking one toast per remaining source');
      assert(sourceCard.includes("document.addEventListener('job-source-solve-request', onSolveRequest);")
        && sourceCard.includes('solveRequestIdRef.current = detail.requestId;')
        && sourceCard.includes('void handleSolveRef.current?.();')
        && sourceCard.includes('if (!solveRequestId || solveDoneEmitted) return;')
        && sourceCard.includes('finishSolveRequest(solveOutcome, solveOutcomeExtra);'),
      'the card answers the hub through its OWN Solve (keeping every guard) and reports exactly one terminal signal per request');

      const manualCancelStart = search.indexOf('const onManualAiNodeCancelled = (event) =>');
      const manualCancelEnd = search.indexOf("document.addEventListener('non-api-ai-node-cancelled'", manualCancelStart);
      const manualCancel = search.slice(manualCancelStart, manualCancelEnd);
      const unscopedCancelGuardAt = manualCancel.indexOf('if (!detail.runId)');
      const genericManualResetAt = manualCancel.indexOf('resetHandler()');
      assert(manualCancelStart >= 0
        && manualCancel.includes('cancelledBoardManualAiRunIdsRef.current.has(detail.runId)')
        && unscopedCancelGuardAt >= 0
        && genericManualResetAt > unscopedCancelGuardAt
        && manualCancel.slice(unscopedCancelGuardAt, genericManualResetAt).includes('return;')
        // Ownership is captured when the confirmation prompt OPENS, not when
        // the cancel executes: the confirm is async and a settled event can
        // swap the active request underneath it. The dispatched detail must
        // still carry that exact captured identity.
        && dialog.includes('runId: activeRequest?.runId || null,')
        && dialog.includes('const cancelledRunId = runId || null;')
        && dialog.includes('detail: { nodeId: cancelledNodeId, runId: cancelledRunId }')
        // The destructive click is gated behind a confirmation, and cancelling
        // must not leave the run eligible for the auto-resume effect — which
        // would relaunch a full multi-source search seconds later.
        && dialog.includes('onClick={requestCancelConfirm}')
        && dialog.includes('title="Cancel this AI task?"')
        && manualCancel.includes('rememberBoundedRunId(cancelledBoardManualAiRunIdsRef.current, detail.runId);'),
      'manual-AI cancellation must be confirmed, carry and correlate the exact run id, block its own auto-resume, and fail closed on an unscoped legacy event before generic Reset so it cannot erase a newer Search or Board run');

      const pipelineStart = search.indexOf('const runPipeline = useCallback');
      const pipelineEnd = search.indexOf('const startProcessing = useCallback', pipelineStart);
      const pipeline = search.slice(pipelineStart, pipelineEnd);
      const acquireAt = pipeline.indexOf('lease = await moduleRunQueue.acquireModuleRun');
      const ownershipAt = pipeline.indexOf('isJobSearchConnectedToBoard(currentId, getNodes(), getEdges())', acquireAt);
      const refusalAt = pipeline.indexOf('if (standaloneBecameBoardManaged)', ownershipAt);
      const queueMarkerClearAt = pipeline.indexOf('updateGlobal(currentId, { queuedModuleRun: null });', refusalAt);
      const refusalReturnAt = pipeline.indexOf("return searchRunOutcome('not-ready'", queueMarkerClearAt);
      const processingStartAt = pipeline.indexOf('processingToken = processingRunsRef.current.start();', refusalReturnAt);
      const destructiveSetupAt = pipeline.indexOf('scrapeWarningsRef.current = [];', processingStartAt);
      const refusalBlock = pipeline.slice(refusalAt, processingStartAt);
      assert(acquireAt >= 0 && ownershipAt > acquireAt && refusalAt > ownershipAt
        && queueMarkerClearAt > refusalAt && refusalReturnAt > queueMarkerClearAt
        && processingStartAt > refusalReturnAt && destructiveSetupAt > processingStartAt
        && !pipeline.includes('restoreStandaloneQueueSnapshot')
        && !refusalBlock.includes('scoredJobs:') && !refusalBlock.includes('hubState:')
        && pipeline.indexOf('lease?.release();', destructiveSetupAt) > destructiveSetupAt,
      'a standalone Search that becomes Board-connected while queued must clear only its queue marker, preserve every live edit/result, refuse before processing or destructive setup, and still release its lane');

      const interruptedResumeStart = search.indexOf('const handleResumeRun = useCallback');
      const interruptedResumeEnd = search.indexOf('resumeInterruptedRunRef.current = handleResumeRun;', interruptedResumeStart);
      const interruptedResume = search.slice(interruptedResumeStart, interruptedResumeEnd);
      const savedResumeStart = search.indexOf('const handleResumeSavedScrape = useCallback');
      const savedResumeEnd = search.indexOf('resumeSavedScrapeRef.current = handleResumeSavedScrape;', savedResumeStart);
      const savedResume = search.slice(savedResumeStart, savedResumeEnd);
      assert((pipeline.match(/findJobSearchBoardActiveRecoveryOwner\(currentId, getNodes\(\), getEdges\(\)\)/g) || []).length >= 2
        && pipeline.indexOf('findJobSearchBoardActiveRecoveryOwner(\n        id,', pipeline.indexOf('const runPipeline'))
          < pipeline.indexOf('const liveData = getNode(id)?.data || data;')
        && (interruptedResume.match(/findJobSearchBoardActiveRecoveryOwner\(/g) || []).length >= 4
        && interruptedResume.includes('This interrupted Search was reserved by its Job Board while queued.')
        && (savedResume.match(/findJobSearchBoardActiveRecoveryOwner\(/g) || []).length >= 3
        && savedResume.includes('const activeBoardOwner = findJobSearchBoardActiveRecoveryOwner(')
        && savedResume.indexOf('findJobSearchBoardActiveRecoveryOwner(id, getNodes(), getEdges())')
          < savedResume.indexOf('const admissionData = getNode(id)?.data || data;'),
      'fresh, interrupted-ledger, and saved-scrape direct entrypoints must honor disconnected durable Board reservations before admission and re-elect ownership after their queued lane turn');

      const deletionPendingStartChecks = search.match(
        /isJobWorkflowDeletionPending\((?:currentId|id)\)\) throw new Error\('Node deleted'\);/g,
      ) || [];
      const laneCommitBarriers = search.match(/if \(lease\) await waitForRendererCommitFrame\(\);/g) || [];
      assert(deletionPendingStartChecks.length >= 8
        && laneCommitBarriers.length >= 7
        && search.includes('if (emptyContinuationLease) await waitForRendererCommitFrame();')
        && pipeline.includes("node?.data?.queuedModuleRun?.label === 'Job search'")
        && search.includes("node?.data?.queuedModuleRun?.label === 'Resuming job search'")
        && search.includes("node?.data?.queuedModuleRun?.label === 'Re-evaluating saved jobs'")
        && search.includes("node?.data?.queuedModuleRun?.label === 'Resuming saved job search'")
        && sourceCard.includes('!hubNode || isJobWorkflowDeletionPending(data.hubId) || hubData.locked'),
      'every queued Job Search lane entrypoint and Source Solve must recheck a pending deletion at lease start, then retire only its own queue marker if an OS confirmation aborts the start');

      const continuationStart = search.indexOf('const resumeScoring = useCallback');
      const continuationEnd = search.indexOf('resumeScoringRef.current = resumeScoring;', continuationStart);
      const continuation = search.slice(continuationStart, continuationEnd);
      const continuationAdmissionAt = continuation.indexOf(
        'const boardConnectedAtContinuationAdmission = !queueManagedExternally',
      );
      const emptyFenceAt = continuation.indexOf(
        '!boardConnectedAtContinuationAdmission\n                && isJobSearchConnectedToBoard(id, getNodes(), getEdges())',
        continuationAdmissionAt,
      );
      const emptyRefusalAt = continuation.indexOf(
        'if (standaloneEmptyContinuationClaimedByBoard)',
        emptyFenceAt,
      );
      const emptySnapshotAt = continuation.indexOf(
        'await window.electronAPI?.saveJobAnalysisSnapshot?.({',
        emptyRefusalAt,
      );
      const scoringFenceAt = continuation.indexOf(
        '!boardConnectedAtContinuationAdmission\n              && isJobSearchConnectedToBoard(currentId, getNodes(), getEdges())',
        emptySnapshotAt,
      );
      const scoringRefusalAt = continuation.indexOf(
        'if (standaloneContinuationClaimedByBoard)',
        scoringFenceAt,
      );
      const continuationProcessingAt = continuation.indexOf(
        'processingToken = processingRunsRef.current.start();',
        scoringRefusalAt,
      );
      const emptyRefusalBlock = continuation.slice(emptyRefusalAt, emptySnapshotAt);
      const scoringRefusalBlock = continuation.slice(scoringRefusalAt, continuationProcessingAt);
      assert(continuationStart >= 0 && continuationEnd > continuationStart
        && continuationAdmissionAt >= 0
        && emptyFenceAt > continuationAdmissionAt
        && emptyRefusalAt > emptyFenceAt && emptySnapshotAt > emptyRefusalAt
        && scoringFenceAt > emptySnapshotAt
        && scoringRefusalAt > scoringFenceAt
        && continuationProcessingAt > scoringRefusalAt
        && !emptyRefusalBlock.includes('pendingJobs:')
        && !emptyRefusalBlock.includes("hubState: 'done'")
        && !scoringRefusalBlock.includes('pendingJobs:')
        && !scoringRefusalBlock.includes('scrapeWarnings:')
        && !scoringRefusalBlock.includes('jobRunId:'),
      'both paused-scoring branches must reject a standalone continuation that becomes Board-connected at its lane turn before snapshots, processing, or pending-run state are changed');

      const continuationClaimAt = continuation.indexOf(
        'const priorContinuationAdmission = scoringContinuationAdmissionRef.current;',
      );
      const externalAdoptionAt = continuation.indexOf(
        'scoringContinuationAdmissionRef.current = {',
        continuationClaimAt,
      );
      const continuationLeaseAt = continuation.indexOf(
        'emptyContinuationLease = await moduleRunQueue.acquireModuleRun',
        externalAdoptionAt,
      );
      const supersededEmptyAt = continuation.indexOf(
        'if (!ownsContinuationAdmission())',
        continuationLeaseAt,
      );
      const emptyLiveReadAt = continuation.indexOf(
        'const continuationData = getNode(id)?.data || null;',
        supersededEmptyAt,
      );
      const emptyDurableOwnerAt = continuation.indexOf(
        'findJobSearchBoardActiveRecoveryOwner(id, getNodes(), getEdges())',
        supersededEmptyAt,
      );
      const scoringLeaseAt = continuation.indexOf(
        'lease = await moduleRunQueue.acquireModuleRun',
        emptyLiveReadAt,
      );
      const supersededScoringAt = continuation.indexOf(
        'if (!ownsContinuationAdmission())',
        scoringLeaseAt,
      );
      const scoringLiveReadAt = continuation.indexOf(
        'const continuationData = getNode(currentId)?.data || null;',
        supersededScoringAt,
      );
      const scoringDurableOwnerAt = continuation.indexOf(
        'findJobSearchBoardActiveRecoveryOwner(currentId, getNodes(), getEdges())',
        supersededScoringAt,
      );
      assert(search.includes('const scoringContinuationAdmissionRef = useRef(null);')
        && continuationClaimAt >= 0
        && externalAdoptionAt > continuationClaimAt
        && continuation.includes('if (queueManagedExternally && priorContinuationAdmission)')
        && continuation.includes('clearContinuationQueueMarker();')
        && continuationLeaseAt > externalAdoptionAt
        && supersededEmptyAt > continuationLeaseAt
        && emptyDurableOwnerAt > supersededEmptyAt
        && emptyDurableOwnerAt < emptyLiveReadAt
        && emptyLiveReadAt > supersededEmptyAt
        && scoringLeaseAt > emptyLiveReadAt
        && supersededScoringAt > scoringLeaseAt
        && scoringDurableOwnerAt > supersededScoringAt
        && scoringDurableOwnerAt < scoringLiveReadAt
        && scoringLiveReadAt > supersededScoringAt
        && continuation.slice(emptyLiveReadAt, scoringLeaseAt).includes("continuationData?.hubState !== 'sources-ready'")
        && continuation.slice(emptyLiveReadAt, scoringLeaseAt).includes('continuationRunId !== requestedJobRunId')
        && continuation.slice(scoringLiveReadAt).includes("continuationData?.hubState !== 'sources-ready'")
        && continuation.slice(scoringLiveReadAt).includes('continuationRunId !== requestedJobRunId')
        && (continuation.match(/if \(ownsContinuationAdmission\(\)\) scoringContinuationAdmissionRef\.current = null;/g) || []).length >= 2,
      'a Source-owned continuation must supersede rather than await a click queued behind that Source lease, while both stale queued branches re-read and match the exact live paused generation before mutating or scoring');

      const scoreCurrentStart = search.indexOf('const handleScoreCurrentResults = useCallback');
      const scoreCurrentEnd = search.indexOf('// Keep the ref up-to-date', scoreCurrentStart);
      const scoreCurrent = search.slice(scoreCurrentStart, scoreCurrentEnd);
      const sourceSkipStart = sourceCard.indexOf("onClick={(e) => {\n              e.stopPropagation();\n              if (\n                sourceOwnershipBlocked");
      const sourceSkipEnd = sourceCard.indexOf("document.dispatchEvent(new CustomEvent('job-source-skip'", sourceSkipStart);
      const sourceSkip = sourceCard.slice(sourceSkipStart, sourceSkipEnd);
      const sourceSkipDispatchEnd = sourceCard.indexOf('}));', sourceSkipEnd) + 4;
      const sourceSkipDispatch = sourceCard.slice(sourceSkipEnd, sourceSkipDispatchEnd);
      const solveStart = sourceCard.indexOf('const handleSolve = async () =>');
      const solveEnd = sourceCard.indexOf('// Hub state via reactive store selectors', solveStart);
      const solve = sourceCard.slice(solveStart, solveEnd);
      const solveLeaseAt = solve.indexOf('lease = await acquireModuleRun({');
      const solveLiveOwnerAt = solve.indexOf('findJobSearchBoardActiveRecoveryOwner(data.hubId, getNodes(), getEdges())', solveLeaseAt);
      const solveRetryMutationAt = solve.indexOf("new CustomEvent('job-source-retry-start'", solveLeaseAt);
      const resolveFailedStart = search.indexOf('const onResolveFailed = (e) =>');
      const resolveFailedEnd = search.indexOf("document.addEventListener('job-source-resolve-failed'", resolveFailedStart);
      const resolveFailed = search.slice(resolveFailedStart, resolveFailedEnd);
      const onSkipStart = search.indexOf('const onSkip = (e) => {');
      const onSkipEnd = search.indexOf("document.addEventListener('job-source-skip'", onSkipStart);
      const onSkip = search.slice(onSkipStart, onSkipEnd);
      assert(scoreCurrent.includes('if (isJobWorkflowDeletionPending(id)) return;')
        && scoreCurrent.indexOf('isJobWorkflowDeletionPending(id)') < scoreCurrent.indexOf('scrapeWarningsRef.current = [];')
        && scoreCurrent.includes('const liveNodes = getNodes();')
        && scoreCurrent.includes('const liveEdges = getEdges();')
        && scoreCurrent.includes('const liveBoardRecoveryOwner = findJobSearchBoardActiveRecoveryOwner(')
        && scoreCurrent.includes('      liveNodes,\n      liveEdges,')
        && scoreCurrent.includes("const liveData = getNode(id)?.data || data;")
        && scoreCurrent.includes("if (liveData.hubState !== 'sources-ready') return;")
        && scoreCurrent.includes('if (processingRunsRef.current.active || scoringContinuationAdmissionRef.current) return;')
        && scoreCurrent.indexOf('scoringContinuationAdmissionRef.current') < scoreCurrent.indexOf('scrapeWarningsRef.current = [];')
        && scoreCurrent.indexOf('findJobSearchBoardActiveRecoveryOwner') < scoreCurrent.indexOf('scrapeWarningsRef.current = [];')
        && sourceSkipStart >= 0 && sourceSkipEnd > sourceSkipStart
        && sourceSkip.includes('findJobSearchBoardActiveRecoveryOwner(data.hubId, getNodes(), getEdges())')
        && sourceSkip.indexOf('findJobSearchBoardActiveRecoveryOwner') < sourceSkip.indexOf('setDismissed(true);')
        && sourceSkip.includes('const sourceJobRunId = effectiveJobSourceCardRunId(')
        && sourceSkip.includes('(hubDataAtSkip.jobRunId || null) !== sourceJobRunId')
        && sourceSkipDispatch.includes('jobRunId: sourceJobRunId')
        && onSkip.includes('const skippedJobRunId = e.detail?.jobRunId || null;')
        && onSkip.includes('const activeJobRunId = jobRunIdRef.current || null;')
        && onSkip.includes('skippedJobRunId !== activeJobRunId')
        && onSkip.includes('activeBoardOwner && !skippedJobRunId')
        && solveLeaseAt >= 0
        && solveLiveOwnerAt > solveLeaseAt
        && solveRetryMutationAt > solveLiveOwnerAt
        && solve.includes('const jobRunId = effectiveJobSourceCardRunId(')
        && solve.includes('const hubDataAtClick = getNode(data.hubId)?.data || {};')
        && !solve.includes('requestedHubData.jobRunId')
        && solve.includes('(hubDataAtClick.jobRunId || null) !== jobRunId')
        && solve.includes('restorative: true')
        && resolveFailed.includes("isJobWorkflowDeletionPending(id) && e.detail?.restorative !== true")
        && board.includes('const manualHandoffMatchesPausedGeneration = !Object.hasOwn(')
        && board.includes('sourceData.manualAiResume?.jobRunId === expectedRunId')
        && search.includes("jobRunId: existing?.runId === detail.runId && Object.hasOwn(existing, 'jobRunId')")
        && solve.includes('hubData.pendingTargetRole\n            ?? hubData.activeTargetRole\n            ?? hubData.targetRole'),
      'Score-current and source Skip/Dismiss must reject stale generations before changing warnings or card state, while Solve keeps the card token through post-lease Board validation and a waiting Board fences new manual-AI markers to that same paused generation');

      const rerunStart = search.indexOf('const handleRerun = useCallback');
      const rerunEnd = search.indexOf('const cancelBoardRun = useCallback', rerunStart);
      const rerun = search.slice(rerunStart, rerunEnd);
      assert(!rerun.includes('scrapeWarningsRef.current = []')
        && !rerun.includes("new CustomEvent('job-source-progress-reset'")
        && !rerun.includes('jobRunIdRef.current = null'),
      'handleRerun must not invalidate prior results, recovery, or source-card progress before queue admission');

      const runnerStart = search.indexOf('const runForJobBoard = useCallback');
      const runnerEnd = search.indexOf('// Re-score the currently displayed listings', runnerStart);
      const runner = search.slice(runnerStart, runnerEnd);
      const requestedFinalizationAt = runner.indexOf('const requestedFinalizationRecovery =');
      const requestedRetirementAt = runner.indexOf('const requestedManualRetirementRecovery =');
      const effectiveManualResumeAt = runner.indexOf('const effectiveManualAiResume =');
      const readinessAt = runner.indexOf('const notReady = boardRunReadiness(liveNode');
      const earlyParentCancellationAt = runner.indexOf("if (typeof isCancelled === 'function' && isCancelled())");
      const liveNodeAt = runner.indexOf('const liveNode = getNode(id);');
      const controlAt = runner.indexOf('const control = {');
      const invokeAt = runner.indexOf('let outcome;', controlAt);
      const readinessHelperStart = search.indexOf('function boardRunReadiness');
      const readinessHelperEnd = search.indexOf('function terminalCommitMismatchReason', readinessHelperStart);
      const readinessHelper = search.slice(readinessHelperStart, readinessHelperEnd);
      assert(requestedFinalizationAt >= 0
        && requestedRetirementAt > requestedFinalizationAt
        && effectiveManualResumeAt > requestedRetirementAt
        && earlyParentCancellationAt >= 0 && earlyParentCancellationAt < liveNodeAt
        && readinessAt > effectiveManualResumeAt
        && controlAt > readinessAt && invokeAt > controlAt
        && runner.includes('processing: processingRunsRef.current.active')
        && runner.includes('platformsVerifying: platformsVerifyingRef.current,')
        && runner.includes('terminalFinalizationRecovery: !!effectiveFinalizationRecovery || !!requestedManualRetirementRecovery')
        && runner.includes('} else if (effectiveManualAiResume?.retirementPending)')
        && runner.includes('} else if (requestedManualRetirementRecovery)')
        && runner.includes('} else if (exactPausedScoringContinuation)')
        && runner.includes('pausedScoringContinuation: exactPausedScoringContinuation')
        && runner.includes('} else if (isSavedScrapeManualAiResume(effectiveManualAiResume))')
        && runner.includes('} else if (recoverInterruptedJobRun || window.electronAPI?.peekJobRun)')
        && readinessHelper.includes('if (hasCancellationPendingManualAiCleanup(liveData))')
        && readinessHelper.indexOf('if (hasCancellationPendingManualAiCleanup(liveData))')
          < readinessHelper.indexOf('if (!recoveryOwner || (')
        && search.includes('const BOARD_BUSY_SEARCH_STATES = new Set(PROCESSING_STATES);')
        && readinessHelper.includes('&& !pausedScoringContinuation'),
      'the Board child executor must fence unfinished cancellation cleanup and revalidate live paused, batch, active, connection-verification, recovery, location, source, and career-input state before creating a run or clearing recovery');

      const exactCancelStart = search.indexOf('const cancelBoardRun = useCallback');
      const exactCancel = search.slice(exactCancelStart, runnerStart);
      const reloadCancellationStart = exactCancel.indexOf('if (!control) {');
      const reloadCancellationEnd = exactCancel.indexOf('if (control.rollbackApplied) {', reloadCancellationStart);
      const reloadCancellation = exactCancel.slice(reloadCancellationStart, reloadCancellationEnd);
      const retirementStart = search.indexOf('const settleManualAiRetirement = useCallback');
      const retirementEnd = search.indexOf('const completeManualAiRun = useCallback', retirementStart);
      const retirement = search.slice(retirementStart, retirementEnd);
      const intentCommitAt = retirement.indexOf(
        "throw new Error('The Job Search cancellation intent was not committed before task cancellation.')",
      );
      const acknowledgementAt = retirement.indexOf(
        'const acknowledgement = await window.electronAPI.cancelNodeTaskAndWait(',
        intentCommitAt,
      );
      const discoveredAt = retirement.indexOf(
        'for (const acknowledgedRunId of acknowledgement?.manualAiRunIds || [])',
        acknowledgementAt,
      );
      const durableIdsAt = retirement.indexOf('const acknowledgedRunIds = [...runIds];', discoveredAt);
      const durableCommitAt = retirement.indexOf(
        "'The acknowledged manual-AI cleanup receipts were not committed to the canvas.'",
        durableIdsAt,
      );
      const parentReceiptAt = retirement.indexOf(
        "if (!acknowledgementError && typeof beforeRetirement === 'function')",
        durableCommitAt,
      );
      const parentReceiptAwaitAt = retirement.indexOf(
        'await beforeRetirement([...runIds]);',
        parentReceiptAt,
      );
      const retireAllAt = retirement.indexOf(
        ': await Promise.all([...runIds].map(async (retirementRunId) => {',
        parentReceiptAwaitAt,
      );
      const reconciliationAt = retirement.indexOf('let reconciliationCommitted = false;', retireAllAt);
      assert(retirementStart >= 0 && retirementEnd > retirementStart
        && retirement.includes('const cancellationWasPreAcknowledged = Array.isArray(acknowledgedRunIds);')
        && retirement.includes('...(cancellationWasPreAcknowledged ? acknowledgedRunIds : [])')
        && retirement.includes('cancellationPending: true,')
        && intentCommitAt >= 0 && acknowledgementAt > intentCommitAt
        && discoveredAt > acknowledgementAt && durableIdsAt > discoveredAt
        && durableCommitAt > durableIdsAt && parentReceiptAt > durableCommitAt
        && parentReceiptAwaitAt > parentReceiptAt && retireAllAt > parentReceiptAwaitAt
        && retirement.includes('const successfulRunIds = new Set(')
        && retirement.includes("status: 'rejected', reason: error")
        && reconciliationAt > retireAllAt
        && retirement.includes('const failuresCommitted = failedResults.every(failed => (')
        && retirement.includes("throw new Error('The manual-AI cleanup result was not committed to the canvas.')"),
      'Search manual-AI retirement must durably record cancellation intent before acknowledgement, fan out every acknowledgement-discovered id to Search and parent receipts before completion, preserve per-id failures, and verify final cleanup reconciliation before releasing ownership');
      const restoreStart = search.indexOf('const restoreBoardSourceGraph = useCallback');
      const restoreEnd = search.indexOf('useUnmountEffect(cleanupAllJobChildren)', restoreStart);
      const sourceGraphRestore = search.slice(restoreStart, restoreEnd);
      assert(runner.includes('previousSourceGraph: durableRollbackAtAdmission')
        && runner.includes('? safeClone(durableRollbackAtAdmission.sourceGraph || { nodes: [], edges: [] })')
        && runner.includes(': captureJobSourceGraph(id, getNodes(), getEdges())')
        && exactCancel.includes('const durablePlanClaim = boardPlan?.version === 1')
        && exactCancel.includes("&& boardPlan.phase === 'searches'")
        && exactCancel.includes('&& (boardPlan.activeSourceId === id')
        && exactCancel.includes('boardPlan.activeSourceIds) && boardPlan.activeSourceIds.includes(id)')
        && exactCancel.includes('const persistChildCancellationCleanup = async (cleanupPatch = {}) => {')
        && exactCancel.includes('...(Array.isArray(sourceCleanup.manualAiRunIds)')
        && exactCancel.includes('manualAiRunIds,\n          commitNonce,')
        && exactCancel.includes('requestedRunIds.every(runId => liveRunIds.has(runId))')
        && exactCancel.includes("throw new Error('The Job Board child-cancellation receipt was not committed to the canvas.')")
        && reloadCancellationStart >= 0 && reloadCancellationEnd > reloadCancellationStart
        && reloadCancellation.includes('const cancellationManualAiRunIds = new Set([')
        && reloadCancellation.includes('...(Array.isArray(persistedCleanup?.manualAiRunIds)')
        && exactCancel.includes('const cancellationLeasePromise = queueManagedExternally')
        && exactCancel.includes("kind: 'job-search-cancel'")
        && reloadCancellation.includes('const acknowledgement = await window.electronAPI.cancelNodeTaskAndWait(id, reason);')
        && reloadCancellation.includes('for (const acknowledgedRunId of acknowledgement?.manualAiRunIds || [])')
        && reloadCancellation.indexOf('await settleManualAiRetirement({')
          > reloadCancellation.indexOf('for (const acknowledgedRunId of acknowledgement?.manualAiRunIds || [])')
        && reloadCancellation.includes('acknowledgedRunIds: [...cancellationManualAiRunIds],')
        && reloadCancellation.includes('beforeRetirement: acknowledgedIds => persistChildCancellationCleanup({')
        && reloadCancellation.includes('manualAiRunIds: acknowledgedIds,')
        && reloadCancellation.indexOf('cancellationLease = await cancellationLeasePromise;')
          > reloadCancellation.indexOf('await settleManualAiRetirement({')
        && !reloadCancellation.includes('await retireManualAiRunDurably(cancellationManualAiRunId);')
        && exactCancel.includes('restoreBoardSourceGraph(control.previousSourceGraph, activeRunId)')
        && exactCancel.includes("const canRestoreCanvas = isMountedRef.current && getNode(id)?.type === 'jobhub';")
        && exactCancel.includes('control.rollbackPromise = Promise.resolve(true);')
        && exactCancel.includes('const performCleanupArtifacts = async () => {')
        && exactCancel.includes('control.cleanupArtifacts = () => {')
        && exactCancel.includes('if (control.cleanupPromise) return control.cleanupPromise;')
        && exactCancel.includes('await abortAndDiscoverRun();')
        && exactCancel.includes('const controlManualAiRunIds = control.manualAiRunIds instanceof Set')
        && exactCancel.includes('acknowledgedRunIds: [...controlManualAiRunIds],')
        && exactCancel.includes('beforeRetirement: acknowledgedIds => persistChildCancellationCleanup({')
        && !exactCancel.includes('await retireManualAiRunDurably(control.manualAiRunId);')
        && runner.includes('const cancellation = await cancelBoardRun({')
        && pipeline.includes('await control.rollbackPromise;')
        && sourceGraphRestore.includes("if (!isMountedRef.current || getNode(id)?.type !== 'jobhub') return false;")
        && sourceGraphRestore.includes("current.some(node => node?.id === id && node.type === 'jobhub')")
        && search.includes("new CustomEvent('job-source-progress-restore'")
        && sourceCard.includes("document.addEventListener('job-source-progress-restore', onRestore)")
        && sourceCard.includes('progressRunGuardRef.current = restoredState.guard;')
        && sourceCard.includes('setProgress(restoredState.progress, { persistTerminal: false });')
        && sourceCard.includes('data._boardRollbackProgressRestore')
        && sourceCard.includes('appliedRollbackReceiptNonceRef.current === receipt.nonce'),
      'exact Board rollback must settle before the Board releases its lane, restore source nodes/edges only while the original canvas is mounted, and apply each local-progress receipt once without rewriting its terminal timestamp');

      return {
        exactChildCancellation: true,
        liveReadiness: true,
        standaloneQueueFence: true,
        sourceGraphRollback: true,
      };
    },
  },
  {
    name: 'Job Search automatic continuations honor Board ownership at admission and lane start',
    run() {
      const search = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');

      const usaStart = search.indexOf('const triggerUSAJobsBackgroundSearch = useCallback');
      const usaEnd = search.indexOf('const handleJobsSettingsChange = useCallback', usaStart);
      const usa = search.slice(usaStart, usaEnd);
      const usaMarkerAt = usa.indexOf('const clearOwnQueueMarker = () => updateGlobal(currentId, (node) => (');
      const usaAdmissionAt = usa.indexOf('if (boardConnectionOwnsRefresh())', usaMarkerAt);
      const usaRecoveryAt = usa.indexOf('const recoveryReservation = () =>', usaAdmissionAt);
      const usaDuplicateGuardAt = usa.indexOf('if (usaJobsRefreshAdmissionRef.current)', usaRecoveryAt);
      const usaAdmissionGuardAt = usa.indexOf('if (localQueueAdmissionRef.current)', usaDuplicateGuardAt);
      const usaAdmissionTokenAt = usa.indexOf('const admissionToken = Symbol(`usajobs-refresh:${currentId}`);', usaAdmissionGuardAt);
      const usaRefreshClaimAt = usa.indexOf('usaJobsRefreshAdmissionRef.current = admissionToken;', usaAdmissionTokenAt);
      const usaAdmissionClaimAt = usa.indexOf('localQueueAdmissionRef.current = admissionToken;', usaRefreshClaimAt);
      const usaLeaseAt = usa.indexOf('lease = await moduleRunQueue.acquireModuleRun', usaAdmissionClaimAt);
      const usaStartFenceAt = usa.indexOf('if (boardConnectionOwnsRefresh())', usaLeaseAt);
      const usaClaimedAt = usa.indexOf('if (refreshClaimedByBoard)', usaStartFenceAt);
      const usaLiveReadAt = usa.indexOf('refreshData = getNode(currentId)?.data || null;', usaClaimedAt);
      const usaProviderAt = usa.indexOf('window.electronAPI.searchJobsSingleSource', usaLiveReadAt);
      const usaAdmissionRefusal = usa.slice(usaAdmissionAt, usaRecoveryAt);
      const usaQueuedRefusal = usa.slice(usaClaimedAt, usaLiveReadAt);
      const usaFinallyAt = usa.lastIndexOf('} finally {');
      const usaAdmissionReleaseAt = usa.indexOf(
        'if (localQueueAdmissionRef.current === admissionToken)',
        usaFinallyAt,
      );
      const usaRefreshReleaseAt = usa.indexOf(
        'if (usaJobsRefreshAdmissionRef.current === admissionToken)',
        usaAdmissionReleaseAt,
      );
      assert(usaStart >= 0 && usaEnd > usaStart
        && usaMarkerAt >= 0
        && search.includes('const usaJobsRefreshAdmissionRef = useRef(null);')
        && usa.includes("node?.data?.queuedModuleRun?.label === 'Refreshing USAJobs'")
        && usaAdmissionAt > usaMarkerAt && usaRecoveryAt > usaAdmissionAt
        && usaDuplicateGuardAt > usaRecoveryAt
        && usaAdmissionGuardAt > usaDuplicateGuardAt
        && usaAdmissionTokenAt > usaAdmissionGuardAt
        && usaRefreshClaimAt > usaAdmissionTokenAt
        && usaAdmissionClaimAt > usaRefreshClaimAt
        && usaLeaseAt > usaAdmissionClaimAt
        && usaStartFenceAt > usaLeaseAt
        && usaClaimedAt > usaStartFenceAt
        && usaLiveReadAt > usaClaimedAt
        && usaProviderAt > usaLiveReadAt
        && usa.slice(usaDuplicateGuardAt, usaAdmissionGuardAt).includes('return;')
        && usa.slice(usaDuplicateGuardAt, usaAdmissionGuardAt).includes('pendingUSAJobsRefreshRef.current = false;')
        && usa.slice(usaAdmissionGuardAt, usaAdmissionTokenAt).includes('return;')
        && usa.slice(usaAdmissionGuardAt, usaAdmissionTokenAt).includes('pendingUSAJobsRefreshRef.current = true;')
        && usaFinallyAt > usaProviderAt
        && usaAdmissionReleaseAt > usaFinallyAt
        && usaRefreshReleaseAt > usaAdmissionReleaseAt
        && usaAdmissionRefusal.includes('pendingUSAJobsRefreshRef.current = false;')
        && usaAdmissionRefusal.includes('clearOwnQueueMarker();')
        && usaQueuedRefusal.includes('pendingUSAJobsRefreshRef.current = false;')
        && usaQueuedRefusal.includes('clearOwnQueueMarker();')
        && !usaAdmissionRefusal.includes('scoredJobs:')
        && !usaAdmissionRefusal.includes('pendingJobs:')
        && !usaAdmissionRefusal.includes('hubState:')
        && !usaQueuedRefusal.includes('scoredJobs:')
        && !usaQueuedRefusal.includes('pendingJobs:')
        && !usaQueuedRefusal.includes('hubState:'),
      'USAJobs background refresh must coalesce only its own duplicate admission, preserve the latch behind unrelated local work, drop at both Board-ownership fences, and identity-release without changing results');

      const usaWakeEffectStart = search.indexOf('// A credentials change may arrive while a recovered Board owns this Search.');
      const usaWakeEffectEnd = search.indexOf('// (Results-cascade filters', usaWakeEffectStart);
      const usaWakeEffect = search.slice(usaWakeEffectStart, usaWakeEffectEnd);
      assert(usaWakeEffect.includes('if (processingRunsRef.current.active || localQueueAdmissionRef.current) return;')
        && usaWakeEffect.includes('data.queuedModuleRun?.label')
        && usaWakeEffect.includes('data.queuedModuleRun?.position')
        && usaWakeEffect.includes('hubState'),
      'a provider-refresh latch deferred by unrelated local work must react when that workflow leaves its queued/running state and retry after its admission ref is released');

      return { usaJobsBoardFence: true };
    },
  },
  {
    name: 'Job Board treats manual-AI cancellation as control flow, not a combine failure',
    run() {
      assert(isJobBoardUserCancellation({ success: false, error: 'Manual AI job cancelled' })
        && isJobBoardUserCancellation(new Error('Manual AI job cancelled'))
        && isJobBoardUserCancellation({ errorCode: 'JOB_TASK_CANCELLED' })
        && !isJobBoardUserCancellation({ success: false, error: 'Taxonomy response was invalid' }),
      'only explicit user-cancellation envelopes/errors may bypass board failure handling');

      const board = readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      const taxonomyCancellation = board.indexOf('stage=taxonomy');
      const taxonomyFailure = board.indexOf('Bucketing failed; preserving prior board');
      const compensationCancellation = board.indexOf('stage=compensation');
      const compensationFailure = board.indexOf('Compensation research failed; preserving prior board');
      assert(taxonomyCancellation >= 0 && taxonomyCancellation < taxonomyFailure
        && compensationCancellation >= 0 && compensationCancellation < compensationFailure
        && board.includes('stage=pipeline'),
      'all board stages must recognize manual cancellation before logging a failure or raising the outer failure toast');
      return { neutralCancellation: true, stages: ['taxonomy', 'compensation', 'pipeline'] };
    },
  },
  {
    name: 'Interrupted Board scans retain exact child ownership through queue and reload recovery',
    run() {
      const board = readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      const search = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const scanStart = board.indexOf('const handleSearchSelected = useCallback');
      const scanEnd = board.indexOf('\n  useEffect(() => {', scanStart);
      const scan = board.slice(scanStart, scanEnd);
      const savedResumeStart = search.indexOf('const handleResumeSavedScrape = useCallback');
      const savedResumeEnd = search.indexOf('resumeSavedScrapeRef.current = handleResumeSavedScrape', savedResumeStart);
      const savedResume = search.slice(savedResumeStart, savedResumeEnd);

      assert(scan.includes('const queuedRecoverySourceIds = [...new Set([')
        && scan.includes('const queuedRecoverySourceId = queuedRecoverySourceIds[0] || null;')
        && scan.includes('activeSourceIds: queuedRecoverySourceIds,')
        && scan.includes('activeSourceRollbacks: queuedRecoverySourceRollbacks,')
        && scan.includes('activeSourceId: queuedRecoverySourceId,')
        && scan.includes('findJobSearchBoardRecoveryOwner(sourceId, childManualAiResume.runId')
        && scan.includes('recoveryOwner.orchestratorNodeId === id && recoveryOwner.boardRunId === boardRunId')
        && scan.includes('manualAiResume: childManualAiResume,'),
      'a recovered Board must preserve its active child while queued and admit the saved handoff only for the exact parent run');
      assert(search.includes('orchestratorNodeId: boardControl.orchestratorNodeId')
        && search.includes('boardRunId: boardControl.boardRunId')
        && search.includes('findJobSearchBoardRecoveryOwner(id, resume.runId, getNodes(), getEdges())')
        && savedResume.includes('standaloneRecoveryClaimedByBoard = true;')
        && savedResume.includes('Queued saved recovery deferred to its durable Job Board owner'),
      'the child restart marker must persist its Board identity, suppress standalone auto-resume, and recheck that owner when a queued saved recovery starts');
      return { parentPlanDurable: true, exactOwner: true, standaloneRecoveryFenced: true };
    },
  },
  {
    name: 'Job Board recovery ignores self-authored plan churn and retires fully-accounted incomplete scans safely',
    run() {
      const board = readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      const identityStart = board.indexOf('function jobBoardSearchRecoveryKey(');
      const identityEnd = board.indexOf('\n\n// A collection-only', identityStart);
      const identity = board.slice(identityStart, identityEnd);
      const recoveryStart = board.indexOf('// A Board-owned child can survive an app restart');
      const recoveryEnd = board.indexOf("document.addEventListener('non-api-ai-node-cancelled'", recoveryStart);
      const recovery = board.slice(recoveryStart, recoveryEnd);
      const recoveryKeyStart = recovery.indexOf('const verificationSignature =');
      const recoveryKeyEnd = recovery.indexOf('if (autoResumedBoardScanRef.current === recoveryKey)', recoveryKeyStart);
      const recoveryKey = recovery.slice(recoveryKeyStart, recoveryKeyEnd);
      const scanStart = board.indexOf('const handleSearchSelected = useCallback');
      const scanEnd = board.indexOf('\n  const settleRecoveredCombine', scanStart);
      const scan = board.slice(scanStart, scanEnd);
      assert(identityStart >= 0 && identityEnd > identityStart
        && identity.includes('plan?.boardRunId || \'\'')
        && identity.includes('plan?.phase || \'searches\'')
        && identity.includes('connectedSignature || \'\'')
        && identity.includes('verificationSignature || \'\'')
        && identity.includes('return JSON.stringify([')
        && !identity.includes('updatedAt')
        && !identity.includes('activeSourceId')
        && !identity.includes('recoverableFailure'),
      'the one-shot recovery identity must retain stable Board phase plus external Search and verification state while excluding self-authored plan fields and timestamps');
      // `connectedSignature` incorporates JSON sourced from editable Search
      // fields. It may contain a delimiter, so components need framing rather
      // than a raw join: these two distinct recovery inputs must not collide.
      const framedRecoveryKey = (...parts) => JSON.stringify(parts);
      assert(
        framedRecoveryKey('run', 'searches', 'a|b', 'c')
          !== framedRecoveryKey('run', 'searches', 'a', 'b|c'),
        'the recovery key must frame components so delimiter-bearing Search data cannot alias another external state',
      );
      assert(recoveryKeyStart >= 0 && recoveryKeyEnd > recoveryKeyStart
        && recovery.includes('const exactRecoveryBlockedByGlobalVerification = selectedSearchModuleIds.some')
        && recoveryKey.includes("'exact-recovery-verifying'")
        && recoveryKey.includes('const verificationSignature = [')
        && recoveryKey.includes('const recoveryKey = jobBoardSearchRecoveryKey(')
        && recoveryKey.includes('plan,\n      connectedSig,\n      verificationSignature,')
        && recoveryKey.includes('const searchRecoveryError = searchRecoveryErrorRef.current;')
        && recoveryKey.includes("const hasChangedSearchRecoveryInput = plan.phase === 'searches'")
        && recoveryKey.includes('(recoveryError && !hasChangedSearchRecoveryInput)')
        && recoveryKey.includes('const setSearchRecoveryError = (message) => {')
        && recoveryKey.includes('searchRecoveryErrorRef.current = { key: recoveryKey, message };')
        && recoveryKey.includes('if (recoveryError && hasChangedSearchRecoveryInput) {')
        && recoveryKey.includes('searchRecoveryErrorRef.current = null;')
        && recoveryKey.includes('recoveryWaitingForVerification')
        && recovery.includes('const relevantVerifyingPlatforms = new Set(')
        && recovery.includes('moduleSearchReadiness(getNode(sourceId), new Set([platformId]))')
        && recovery.includes('foreignRecoveryWaitSigRef.current === boardRecoverySig'),
      'a connected Search or verification completion wakes recovery, including after an error, whereas progress timestamps cannot re-admit the same plan');

      // Contract for the two recovery-error/latch races. The error's immutable
      // Search input is deliberately independent from the latch, whose values
      // may be `cleanup:` or `combine:` tokens. A changed key is retryable only
      // once selected verification is complete; returning to the original key
      // after a transient check keeps the error visible and manual.
      const mayConsumeSearchRecoveryChange = ({ errorKey, currentKey, verificationPending }) => (
        errorKey !== currentKey && !verificationPending
      );
      const recoveryStateA = framedRecoveryKey('run', 'searches', 'connected-a', '');
      const transientVerificationStateB = framedRecoveryKey('run', 'searches', 'connected-a', 'platform-a');
      const consumedVerificationStateC = framedRecoveryKey('run', 'searches', 'connected-b', '');
      const cleanupLatch = `cleanup:${recoveryStateA}:source-a`;
      assert(
        cleanupLatch !== recoveryStateA
          && !mayConsumeSearchRecoveryChange({
            errorKey: recoveryStateA,
            currentKey: recoveryStateA,
            verificationPending: false,
          })
          && !mayConsumeSearchRecoveryChange({
            errorKey: recoveryStateA,
            currentKey: transientVerificationStateB,
            verificationPending: true,
          })
          && !mayConsumeSearchRecoveryChange({
            errorKey: recoveryStateA,
            currentKey: recoveryStateA,
            verificationPending: false,
          })
          && mayConsumeSearchRecoveryChange({
            errorKey: recoveryStateA,
            currentKey: consumedVerificationStateC,
            verificationPending: false,
          }),
        'cleanup/combine latches cannot erase a Search error, and a transient verification state cannot consume it before a usable Search result arrives',
      );

      // Mirrors the production selection partition: an incomplete terminal
      // outcome is accounted work, not another child that recovery may start.
      const pendingSearchIds = (selectedIds, completedSourceRuns, incompleteSearches) => {
        const completed = new Set(Object.keys(completedSourceRuns || {}));
        const incomplete = new Set((incompleteSearches || []).map(entry => entry?.sourceId).filter(Boolean));
        return selectedIds.filter(id => !completed.has(id) && !incomplete.has(id));
      };
      const allComplete = pendingSearchIds(['a', 'b'], { a: {}, b: {} }, []);
      const allAccountedWithAttention = pendingSearchIds(['a', 'b', 'c'], { a: {} }, [
        { sourceId: 'b', status: 'paused' }, { sourceId: 'c', status: 'failed' },
      ]);
      const guardAt = scan.indexOf('resumePlan && selectedIds.length === 0 && incompleteSearches.length > 0');
      const scanTokenAt = scan.indexOf('const scanToken = Symbol(boardRunId);');
      const persistAt = scan.indexOf('persistScanResume();');
      const laneAt = scan.indexOf('await moduleRunQueue.acquireModuleRun({');
      assert(allComplete.length === 0 && allAccountedWithAttention.length === 0
        && scan.includes('const incompleteIds = new Set(incompleteSearches.map(entry => entry?.sourceId).filter(Boolean));')
        && scan.includes('const selectedIds = transactionSelectedIds.filter(sourceId => (')
        && scan.includes('!completedOutcomes.has(sourceId) && !incompleteIds.has(sourceId)')
        && guardAt >= 0 && guardAt < scanTokenAt && guardAt < persistAt && guardAt < laneAt
        && scan.slice(guardAt, scanTokenAt).includes('clearExactBoardScanResume(')
        && scan.slice(guardAt, scanTokenAt).includes('clearExactBoardScanResume(updateGlobal, id, resumePlan.boardRunId);'),
      'a resumed scan whose selected Searches are all complete or incomplete must take its exact-run attention exit before owning a token, persisting, or acquiring the lane; all-complete recovery remains eligible to combine');

      const careerIdentityFields = /\b(careerData|resumeProfile|careerFilePaths|filePaths|filePath)\b/;
      const exactClearStart = board.indexOf('function clearExactBoardScanResume');
      const exactClearEnd = board.indexOf('\n// A collection-only', exactClearStart);
      const exactClear = board.slice(exactClearStart, exactClearEnd);
      assert(!careerIdentityFields.test(exactClear)
        && exactClear.includes('node?.data?.boardScanResume?.boardRunId !== boardRunId')
        && exactClear.includes('return { boardScanResume: null };'),
      'the all-accounted attention exit clears only the exact Board run and never mutates retained career data, profile, or file paths');

      return { selfPlanChurnIgnored: true, externalSearchWake: true, recoveryErrorLatchIndependent: true, allCompleteMayCombine: true, incompleteExitBeforeAdmission: true, careerInputRetained: true };
    },
  },
  {
    name: 'Job Board taxonomy validation rejects incomplete API output before board replacement',
    run() {
      const valid = validateJobBoardTaxonomy({
        roles: [{ name: 'Engineering', jobIndices: [0, 1] }],
      }, 2);
      assert(valid.valid, `complete role taxonomy should be valid: ${valid.reason}`);
      const missing = validateJobBoardTaxonomy({ roles: [{ name: 'Engineering', jobIndices: [0] }] }, 2);
      const duplicate = validateJobBoardTaxonomy({ roles: [{ name: 'Engineering', jobIndices: [0, 0] }] }, 1);
      assert(!missing.valid && !duplicate.valid,
        'incomplete or duplicate role assignment must abort before it can replace a board');
      return { completeAccepted: true, invalidRejected: true };
    },
  },
  {
    name: 'Job Board hides editable legacy flat cards until a successful Re-combine',
    run() {
      const flatNodes = [{ type: 'jobcard', data: { hubId: 'board' } }];
      assert(isLegacyUnbucketedJobBoard({ hubState: 'done', jobTaxonomy: null }, flatNodes, 'board'),
        'an editable done board with direct cards and no taxonomy must be marked stale');
      assert(!isLegacyUnbucketedJobBoard({ hubState: 'done', jobTaxonomy: null, locked: true }, flatNodes, 'board'),
        'a locked snapshot must retain its historical view');
      assert(!isLegacyUnbucketedJobBoard({ hubState: 'done', jobTaxonomy: { roles: [] } }, flatNodes, 'board'),
        'a board with persisted taxonomy is not the legacy flat-card case');
      return { legacyFlatBoardHidden: true, lockedSnapshotPreserved: true };
    },
  },
  {
    name: 'Job Board compensation context follows each union job’s origin without mutating scored-job storage',
    run() {
      const sourceJobs = [
        { title: 'Remote US role', originHubId: 'search-us' },
        { title: 'Remote CA role', originHubId: 'search-ca' },
        { title: 'Legacy origin', originHubId: 'missing' },
      ];
      const residences = {
        'search-us': { usa: { city: 'Denver', subdivision: 'Colorado', country: 'United States' } },
        'search-ca': { canada: { city: 'Toronto', subdivision: 'Ontario', country: 'Canada' } },
      };
      const attached = attachCompensationRemoteResidences(sourceJobs, residences);
      assert(attached !== sourceJobs && attached.every((job, index) => job !== sourceJobs[index]),
        'the per-origin attachment helper must clone the union and its jobs');
      assert(attached[0].compensationRemoteResidences === residences['search-us']
        && attached[1].compensationRemoteResidences === residences['search-ca'],
      'each job must receive the residence map owned by its originHubId');
      assert(Object.keys(attached[2].compensationRemoteResidences).length === 0,
        'an unknown legacy origin must fail safely with no invented residence');
      assert(sourceJobs.every(job => !Object.hasOwn(job, 'compensationRemoteResidences')),
        'attaching transient research context must not mutate source modules’ stored scored jobs');
      return { origins: attached.length, sourceUntouched: true };
    },
  },
  {
    name: 'Job Board merge retains unlinked requisitions and compares legacy numeric score strings numerically',
    run() {
      const higherLegacyScore = { title: 'Analyst', company: 'Acme', url: 'https://jobs.example/analyst', matchScore: '80' };
      const lowerLegacyScore = { ...higherLegacyScore, matchScore: '9' };
      const unlinkedA = { title: 'Developer', company: 'Acme', location: 'Toronto', originHubId: 'search-a', matchScore: 70 };
      const unlinkedB = { ...unlinkedA, originHubId: 'search-b', matchScore: 75 };
      const stats = {};
      const merged = unionScoredJobs([[lowerLegacyScore, unlinkedA], [higherLegacyScore, unlinkedB]], stats);

      assert(merged.length === 3, `separate rows without listing URLs must not collapse into one, got ${merged.length}`);
      assert(merged[0] === higherLegacyScore,
        'numeric-looking legacy scores must compare numerically, so 80 beats 9 rather than lexicographically losing to it');
      assert(stats.collisions === 1 && stats.collisionUpgrades === 1,
        `only the linked duplicate should register as a score-upgrade collision, got ${JSON.stringify(stats)}`);
      return { jobs: merged.length, scoreUpgrades: stats.collisionUpgrades };
    },
  },
  {
    name: 'Job Board taxonomy score projection preserves legacy numeric score strings',
    run() {
      assert(normalizeJobMatchScore('80') === 80,
        'a persisted numeric score string must reach taxonomy bucketing as 80, not a zero fallback');
      assert(normalizeJobMatchScore(' 72.5 ') === 72.5,
        'numeric strings retain fractional scores used by a legacy canvas');
      assert(normalizeJobMatchScore('not-a-score') === 0 && normalizeJobMatchScore(Infinity) === 0,
        'invalid/non-finite values still use the safe zero fallback');
      const board = readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      assert(board.includes('matchScore: normalizeJobMatchScore(j.matchScore)'),
        'the IPC taxonomy projection must use the shared score normalization boundary');
      return { numericString: normalizeJobMatchScore('80') };
    },
  },
  {
    name: 'Job Board fingerprint invalidates cards when their visible fit audit changes',
    run() {
      const base = {
        title: 'Engineer', company: 'Acme', matchScore: 82,
        fitAssessment: {
          auditStatus: 'audited',
          confidence: { effective: 'high', groundedRequirementCount: 2, requirementCount: 2 },
          requirementRows: [{
            requirement: 'Build services', effectiveStatus: 'direct', scoreImpact: 'scoring', materialGap: false,
            grounding: { requirementGrounded: true, candidateClaimGrounded: true },
          }],
        },
      };
      const changedGap = {
        ...base,
        fitAssessment: {
          ...base.fitAssessment,
          requirementRows: [{
            ...base.fitAssessment.requirementRows[0],
            effectiveStatus: 'not_documented', materialGap: true,
            grounding: { requirementGrounded: true, candidateClaimGrounded: false },
          }],
        },
      };
      assert(moduleFingerprint([base]) !== moduleFingerprint([changedGap]),
        'a changed rendered fit-audit status/gap must mark the board stale for Re-combine');
      assert(moduleFingerprint([base]).startsWith('7:'), 'fit-audit-aware fingerprints use the current v7 format');

      const rejectedEvidenceCountOnly = {
        ...base,
        fitAssessment: {
          ...base.fitAssessment,
          requirementRows: [{
            ...base.fitAssessment.requirementRows[0],
            grounding: {
              ...base.fitAssessment.requirementRows[0].grounding,
              rejectedJobEvidence: ['first', 'second'],
            },
          }],
        },
      };
      const rejectedEvidenceOneItem = {
        ...rejectedEvidenceCountOnly,
        fitAssessment: {
          ...rejectedEvidenceCountOnly.fitAssessment,
          requirementRows: [{
            ...rejectedEvidenceCountOnly.fitAssessment.requirementRows[0],
            grounding: {
              ...rejectedEvidenceCountOnly.fitAssessment.requirementRows[0].grounding,
              rejectedJobEvidence: ['first'],
            },
          }],
        },
      };
      assert(moduleFingerprint([rejectedEvidenceCountOnly]) === moduleFingerprint([rejectedEvidenceOneItem]),
        'the number of rejected evidence excerpts is not card-visible and must not stale a board');
      const hiddenCoverageA = {
        ...base,
        fitAssessment: { ...base.fitAssessment, confidence: { effective: 'high', groundedRequirementCount: -1, requirementCount: 2 } },
      };
      const hiddenCoverageB = {
        ...base,
        fitAssessment: { ...base.fitAssessment, confidence: { effective: 'high', groundedRequirementCount: -99, requirementCount: 2 } },
      };
      assert(moduleFingerprint([hiddenCoverageA]) === moduleFingerprint([hiddenCoverageB]),
        'malformed coverage values hidden by the card must not stale a board');
      return { fingerprintChanged: true };
    },
  },
  {
    name: 'Job Board keeps hiring fit primary and uses Job Preferences only as a stable within-fit tie-break',
    run() {
      const fitFirst = { title: 'Higher fit', matchScore: 91, preferenceAssessment: { preferenceScore: -50 } };
      const preferenceFirst = { title: 'Preferred equal fit', matchScore: 80, preferenceAssessment: { preferenceScore: 20 } };
      const neutralEqualFit = { title: 'Neutral equal fit', matchScore: 80, preferenceAssessment: { preferenceScore: 0 } };
      const stableA = { title: 'Original first', matchScore: 70, preferenceAssessment: { preferenceScore: 5 } };
      const stableB = { title: 'Original second', matchScore: 70, preferenceAssessment: { preferenceScore: 5 } };
      const ordered = [neutralEqualFit, stableA, preferenceFirst, fitFirst, stableB]
        .sort(compareJobsByFitAndPreference);
      assert(ordered[0] === fitFirst && ordered[1] === preferenceFirst && ordered[2] === neutralEqualFit,
        'a higher hiring fit must always win; only equal-fit rows are ordered by the preference score');
      assert(ordered[3] === stableA && ordered[4] === stableB,
        'a complete fit/preference tie must preserve source order without an invented lexical tie-break');
      const changedPreference = {
        ...neutralEqualFit,
        preferenceAssessment: {
          preferenceScore: 12, status: 'accepted', summary: 'Matches Job Preferences',
          matches: [{ preferenceId: 'free-lunch', outcome: 'confirmed', source: 'web', sourceDate: '2026-08-31', verifiedAt: '2026-09-03T12:00:00.000Z' }],
        },
      };
      assert(moduleFingerprint([neutralEqualFit]) !== moduleFingerprint([changedPreference]),
        'a changed card-visible Job Preferences assessment must make Re-combine available');
      const refreshedEvidence = {
        ...changedPreference,
        preferenceAssessment: {
          ...changedPreference.preferenceAssessment,
          matches: [{ ...changedPreference.preferenceAssessment.matches[0], verifiedAt: '2026-09-04T12:00:00.000Z' }],
        },
      };
      assert(moduleFingerprint([changedPreference]) !== moduleFingerprint([refreshedEvidence]),
        'updated independently verified preference evidence must make Re-combine available');
      const tree = readFileSync(new URL('../../src/nodes/jobsearch/buildJobTree.js', import.meta.url), 'utf8');
      assert(tree.includes('preferenceAssessment: job.preferenceAssessment')
        && tree.includes('.sort(compareJobsByFitAndPreference)'),
      'tree construction must preserve the preference assessment and use the shared comparator for cards');
      return { orderedTitles: ordered.map(job => job.title), preferenceFingerprintChanged: true };
    },
  },
  {
    name: 'Job Board asks to replace only a stale authoritative empty result and rechecks it on confirm',
    run() {
      const staleEmpty = {
        stale: true,
        allConnectedModulesDone: true,
        readyModuleCount: 0,
      };
      assert(emptyReplacementIneligibilityReason(staleEmpty) === null,
        'a stale board fed only by terminal zero-result searches may request confirmation');
      assert(emptyReplacementIneligibilityReason({ ...staleEmpty, stale: false }) === 'the board is no longer stale',
        'a non-stale board with the same terminal zero result must not open a replacement confirmation');
      assert(emptyReplacementIneligibilityReason({ ...staleEmpty, allConnectedModulesDone: false }) === 'one or more connected searches are no longer terminal',
        'a search that changes state while the prompt is open must block the destructive replacement');
      assert(emptyReplacementIneligibilityReason({ ...staleEmpty, readyModuleCount: 1 }) === 'one or more connected searches now have jobs',
        'fresh positive jobs arriving while the prompt is open must block the destructive replacement');

      // The full ReactFlow dialog is intentionally not unit-mounted here. Pin
      // that both UI transition points use the shared predicate: the initial
      // click must not open a doomed dialog and confirm must re-check current
      // inputs rather than trusting the state that opened it.
      const board = readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      const confirmStart = board.indexOf('const confirmEmptyReplacement');
      const confirmEnd = board.indexOf('const cleanupBoard', confirmStart);
      const confirm = board.slice(confirmStart, confirmEnd);
      const combineStart = board.indexOf('const handleCombine');
      const combineEnd = board.indexOf('\n  return (', combineStart);
      const combine = board.slice(combineStart, combineEnd);
      assert(combine.includes('if (canReplaceWithEmpty) {\n        requestEmptyReplacement();')
        && combine.includes("title: 'Board already current'"),
      'the non-stale terminal-zero path must show an informational result instead of opening a confirmation');
      assert(confirm.includes('const liveBoard = getNode(id);')
        && confirm.includes('liveBoardData.locked')
        && confirm.includes('const liveInputs = liveCombineInputs(id, getNodes(), getEdges());')
        && confirm.includes('const liveBlockReason = emptyReplacementIneligibilityReason({')
        && confirm.includes('readyModuleCount: liveInputs.ready.length')
        && confirm.includes('reason=${liveBlockReason}')
        && confirm.indexOf('if (liveBlockReason)') < confirm.indexOf('clearBoardChildren();'),
      'confirmation must re-read the live graph and refuse a newly locked, running, nonterminal, positive, or current Board before deleting its cascade');
      return { staleEmptyPrompts: true, currentEmptyDoesNotPrompt: true, changedInputsBlocked: true };
    },
  },
  {
    name: 'Job Board compensation seam stays ordered, node-scoped, bridged, and transient',
    run() {
      // A full ReactFlow + Electron IPC harness would test frameworks rather
      // than this small seam. Pin the exact source-level ordering and cleanup
      // contract, while the per-origin data transform above is exercised as
      // real executable code.
      const board = readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      const preload = readFileSync(new URL('../../electron/preload.js', import.meta.url), 'utf8');
      const main = readFileSync(new URL('../../electron/ipc/jobs.js', import.meta.url), 'utf8');
      const combineStart = board.indexOf('const handleCombine');
      const combineEnd = board.indexOf('\n  return (', combineStart);
      const combine = board.slice(combineStart, combineEnd);
      const combineBusyAt = combine.indexOf("if (combineRunRef.current || combineRecoveryTokenClaimRef.current) return { status: 'busy' };");
      const scanBusyAt = combine.indexOf("if (scanRunRef.current && options?.afterSearch !== true) return { status: 'busy' };");
      const combineTokenAt = combine.indexOf("const combineToken = Symbol('job-board-combine');");
      const combineClaimAt = combine.indexOf('combineRunRef.current = combineToken;', combineTokenAt);
      assert(combineBusyAt >= 0 && scanBusyAt > combineBusyAt
        && combineTokenAt > scanBusyAt && combineClaimAt > combineTokenAt,
      'Combine must synchronously report duplicate/competing scan admission as busy before claiming its ref token, so two same-turn calls cannot both start before React commits combining=true');
      assert(combine.includes('if (combineRunRef.current === combineToken)')
        && combine.includes('combineRunRef.current = null;')
        && combine.indexOf('setCompensationProgress(null);', combine.indexOf('if (combineRunRef.current === combineToken)'))
          > combine.indexOf('if (combineRunRef.current === combineToken)'),
      'only the active Combine may release the synchronous run lock or clear its progress after settlement');
      const cleanupStart = board.indexOf('const cleanupBoard');
      const clearStart = board.indexOf('const handleClear');
      const clearEnd = board.indexOf('const handleCombine', clearStart);
      const cleanupBlock = board.slice(cleanupStart, clearStart);
      const clearBlock = board.slice(clearStart, clearEnd);
      // Match the call PREFIX, not the whole call: each cancel site now passes
      // its own cause label (`cancelNodeTask(id, 'board-cleared')`) so the bug
      // report can name why a run stopped. The ordering invariant is unchanged.
      const releasesBeforeCancellation = (section) => {
        const cancelAt = section.indexOf('cancelBoardTaskAndRetireManualAi(');
        return cancelAt >= 0
          && section.indexOf('combineRunRef.current = null;') >= 0
          && section.indexOf('compensationRequestIdRef.current = null;') >= 0
          && section.indexOf('combineRunRef.current = null;') < cancelAt
          && section.indexOf('compensationRequestIdRef.current = null;') < cancelAt;
      };
      assert(releasesBeforeCancellation(cleanupBlock) && releasesBeforeCancellation(clearBlock),
        'Clear and unmount cleanup must synchronously release the Combine lock and request id before starting acknowledged backend/manual-AI cancellation');
      const unmountIntentAt = cleanupBlock.indexOf("const cancellationIntentPromise = persistBoardCancellationIntent('board-unmounted');");
      const unmountChildCancelAt = cleanupBlock.indexOf("const childCancellation = cancelActiveSearchModule('board-unmounted', { allowStale: true });");
      const unmountChildObservationAt = cleanupBlock.indexOf('const childCancellationResult = childCancellation.then(', unmountChildCancelAt);
      const unmountIntentWaitAt = cleanupBlock.indexOf('void cancellationIntentPromise.then(async (intent) => {');
      assert(unmountIntentAt >= 0 && unmountChildCancelAt > unmountIntentAt
        && unmountChildObservationAt > unmountChildCancelAt
        && unmountIntentWaitAt > unmountChildObservationAt
        && cleanupBlock.includes('if (!childResult.ok) throw childResult.error;'),
      'unmount must capture and immediately observe the exact closing Search canceller before awaiting the Board receipt’s renderer-frame acknowledgement, so navigation cannot turn it into an unavailable broad fallback or leak a fast cancellation rejection');
      assert(clearBlock.includes('if (getNode(id)?.data?.locked) {')
        && clearBlock.indexOf('if (getNode(id)?.data?.locked) {')
          < clearBlock.indexOf('const cancellationIntentPromise = persistBoardCancellationIntent'),
      'a stale or programmatic Clear invocation must recheck the live Board lock before cancelling work or deleting the frozen snapshot');
      const acknowledgedCancelStart = board.indexOf('const cancelBoardTaskAndRetireManualAi = useCallback');
      const acknowledgedCancelEnd = board.indexOf('const cleanupBoard = useCallback', acknowledgedCancelStart);
      const acknowledgedCancel = board.slice(acknowledgedCancelStart, acknowledgedCancelEnd);
      const acknowledgementAt = acknowledgedCancel.indexOf(
        'const acknowledgement = await window.electronAPI.cancelNodeTaskAndWait(id, reason);',
      );
      const settledAt = acknowledgedCancel.indexOf('if (acknowledgement?.settled !== true)', acknowledgementAt);
      const discoveredAt = acknowledgedCancel.indexOf(
        'for (const runId of acknowledgement?.manualAiRunIds || [])',
        settledAt,
      );
      const durableIdsAt = acknowledgedCancel.indexOf(
        'await persistAcknowledgedBoardManualAiRunIds([...runIds], reason);',
        discoveredAt,
      );
      const retireAllAt = acknowledgedCancel.indexOf(
        'await Promise.all([...runIds].map(runId => (',
        durableIdsAt,
      );
      assert(acknowledgedCancel.includes('const acknowledgement = await window.electronAPI.cancelNodeTaskAndWait(id, reason);')
        && acknowledgedCancel.includes('if (acknowledgement?.settled !== true)')
        && acknowledgedCancel.includes('for (const runId of acknowledgement?.manualAiRunIds || [])')
        && acknowledgementAt >= 0 && settledAt > acknowledgementAt
        && discoveredAt > settledAt && durableIdsAt > discoveredAt && retireAllAt > durableIdsAt,
      'the shared Board cancellation helper must wait for exact task settlement, include run ids discovered by acknowledgement, commit every id to durable cleanup ownership, and only then retire every handoff before Clear/unmount can finish');
      const bucket = combine.indexOf('await window.electronAPI.bucketJobs');
      const taxonomy = combine.indexOf('validateJobBoardTaxonomy', bucket);
      const compensation = combine.indexOf('await window.electronAPI?.researchJobCompensation', taxonomy);
      const enrichedUnion = combine.indexOf('union = compensationResult.jobs', compensation);
      const build = combine.indexOf('buildJobTreeNodes', enrichedUnion);
      assert(bucket >= 0 && taxonomy > bucket && compensation > taxonomy && enrichedUnion > compensation && build > enrichedUnion,
        'Combine must validate bucketing before compensation, then build cards only from the enriched returned union');
      const snapshot = combine.indexOf("new CustomEvent('canvas-take-snapshot')", build);
      const clear = combine.indexOf('clearBoardChildren();', build);
      const add = combine.indexOf('addElementsGlobally(id, newNodes, newEdges', clear);
      const publish = combine.indexOf("hubState: 'done'", add);
      const completion = combine.indexOf('[JobBoard] combine completed', publish);
      assert(snapshot > build && clear > snapshot && add > clear && publish > add && completion > publish,
        'a successful Re-combine must build first, snapshot once, replace the old cascade, then publish/log the completed board');
      assert(combine.includes('union = attachCompensationRemoteResidences(union, remoteResidencesByOrigin)'),
        'Combine must attach each origin module’s residence map to the full union before the IPC call');
      assert(board.includes('const activeRequestId = compensationRequestIdRef.current;')
        && board.includes('if (!activeRequestId || payload?.nodeId !== id || payload?.requestId !== activeRequestId) return;'),
      'board compensation progress must require a truthy active request plus exact node/request ids, rejecting stale, unscoped, and idle null/null events');
      assert(preload.includes("researchJobCompensation: (args) => ipcRenderer.invoke('research-job-compensation', args)"),
        'the preload bridge must expose the board-stage compensation IPC');
      assert(combine.includes('requestId: compensationRequestId')
        && board.includes('const compensationRequestId = `board-compensation:${id}:${entropy}`;'),
      'each board Combine must create and send a unique compensation request id');

      const handlerStart = main.indexOf("handleSafe('research-job-compensation'");
      const handlerEnd = main.indexOf("handleSafe('bucket-jobs'", handlerStart);
      const handler = main.slice(handlerStart, handlerEnd);
      const finallyStart = handler.indexOf('} finally {');
      const cleanup = handler.indexOf('delete job?.compensationRemoteResidences', finallyStart);
      assert(handlerStart >= 0 && handlerEnd > handlerStart && finallyStart >= 0 && cleanup > finallyStart,
        'the main handler must strip renderer-injected residences in finally on success, failure, and cancellation');
      assert(handler.includes('{ jobs, nodeId, requestId = null, remoteResidences }')
        && handler.includes('event, nodeId, requestId, signal')
        && main.includes('requestId: requestId || null'),
      'the optional request id must travel through IPC and every compensation progress event without breaking non-board callers');
      const bucketHandlerStart = main.indexOf("handleSafe('bucket-jobs'");
      const bucketHandler = main.slice(bucketHandlerStart, main.indexOf("handleSafe('resolve-job-source'", bucketHandlerStart));
      assert(bucketHandler.includes('runBoundedJobTaxonomy(jobs')
        && bucketHandler.includes('strategy: \'bounded-plan-chunks\'')
        && bucketHandler.includes('inspectJobBoardRoleByIndex(result?.roleByIndex')
        && bucketHandler.includes('normalizeJobBoardRoleByIndex(result?.roleByIndex'),
      'Job Board bucketing uses bounded plan/classify calls and validates exact all-job coverage before normalization');
      assert(bucketHandler.includes('taxonomyChunksCompleted: taxonomyProgress.completedBatches')
        && bucketHandler.includes('taxonomyChunkCount: taxonomyProgress.batchCount')
        && bucketHandler.includes('taxonomyVocabularySize: taxonomyProgress.vocabularySize')
        && bucketHandler.includes('taxonomyPlannedAssignments: taxonomyProgress.plannedAssignments')
        && bucketHandler.includes('taxonomyClassifiedAssignments: taxonomyProgress.classifiedAssignments')
        && !bucketHandler.includes('taxonomyChunksCompleted: result?.batchCount'),
      'successful bucketing telemetry retains bounded-run progress instead of reading orchestration fields stripped by taxonomy sanitization');
      return {
        ordering: ['bucket', 'taxonomy', 'compensation', 'build', 'snapshot', 'clear', 'add', 'publish'],
        exactNodeProgress: true,
        transactionalReplacement: true,
        transientCleanup: true,
      };
    },
  },
  {
    name: 'Job Board Combine leases the job lane and snapshots live inputs before commit',
    run() {
      // The queue's executable FIFO/cancellation coverage lives in
      // job-run-staging. Pin this component's integration and ordering without
      // mounting a ReactFlow/Electron tree.
      const board = readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      const combineStart = board.indexOf('const handleCombine');
      const combineEnd = board.indexOf('\n  return (', combineStart);
      const combine = board.slice(combineStart, combineEnd);
      const cleanupStart = board.indexOf('const cleanupBoard');
      const clearStart = board.indexOf('const handleClear');
      const clearEnd = board.indexOf('const completeManualAiRun', clearStart);
      const cleanup = board.slice(cleanupStart, clearStart);
      const clear = board.slice(clearStart, clearEnd);
      const leaseAt = combine.indexOf('await moduleRunQueue.acquireModuleRun');
      const snapshotAt = combine.indexOf('const inputsAtCombine = liveCombineInputs(id, getNodes(), getEdges());');
      const guardAt = combine.indexOf('const liveStateBeforeCommit = liveCombineInputs(id, getNodes(), getEdges());');
      const clearChildrenAt = combine.indexOf('clearBoardChildren();', guardAt);
      const historyAt = combine.indexOf('appendJobsHistory', guardAt);
      const committedBoundaryAt = combine.indexOf(
        'committedCombineRef.current = { token: combineToken, manualAiRunId };',
        clearChildrenAt,
      );
      const manualCleanupAt = combine.indexOf(
        'await completeManualAiRun(manualAiRunId);',
        committedBoundaryAt,
      );
      assert(board.includes("import { useModuleRunQueue } from '../contexts/useModuleRunQueue';")
        && board.includes('const moduleRunQueue = useModuleRunQueue();')
        && leaseAt >= 0 && combine.includes("lane: 'job-search'")
        && snapshotAt > leaseAt && combine.includes('lease?.release()')
        && cleanup.includes("cancelQueuedRunsForNode(id, 'Job Board unmounted')")
        && clear.includes("cancelQueuedRunsForNode(id, 'Job Board cleared')"),
      'Combine holds one job-search lease and Clear/unmount remove an unstarted queued combine');
      assert(combine.includes('const completedAtCombine = inputsAtCombine.completed;')
        && combine.includes('const readyAtCombine = inputsAtCombine.ready;')
        && combine.indexOf("if (getNode(id)?.data?.locked) return { status: 'not-ready', error: 'Unlock this Job Board first.' };") > leaseAt
        && combine.indexOf("if (getNode(id)?.data?.locked) {", snapshotAt) > snapshotAt
        && combine.indexOf('await completeManualAiRun(manualAiRunId);', snapshotAt) < guardAt
        && combine.includes('boardInputSignature(\n          liveInputsBeforeCommit,\n          liveStateBeforeCommit.all,')
        && combine.includes('boundedCombinedSourceRuns(completedAtCombine)')
        && combine.includes('moduleCount: completedAtCombine.length')
        && guardAt > snapshotAt && clearChildrenAt > guardAt && historyAt > guardAt
        && combine.includes('combine superseded before commit'),
      'post-queue live inputs drive the union/provenance, live locks stop both queued and post-provider work, and a second signature check runs before card deletion or history writes');
      assert(combine.includes('const historyWrite = window.electronAPI?.appendJobsHistory?.({')
        && combine.includes('void Promise.resolve(historyWrite).then(')
        && !combine.includes('await window.electronAPI?.appendJobsHistory'),
      'history persistence must drain after the visible Board commit without leaving a cancellable run that can falsely report rollback success');
      const cancelStart = board.indexOf('const handleCancelRun = useCallback');
      const cancelEnd = board.indexOf('useEffect(() => jobSearchCoordinator.registerBoardModule', cancelStart);
      const cancel = board.slice(cancelStart, cancelEnd);
      const manualCancelledHandlerAt = board.indexOf('const onManualAiNodeCancelled = (event) =>');
      const manualPendingHandlerAt = board.indexOf('const onPending = (event) =>', manualCancelledHandlerAt);
      const manualCancelledHandler = board.slice(manualCancelledHandlerAt, manualPendingHandlerAt);
      const manualPendingHandler = board.slice(
        manualPendingHandlerAt,
        board.indexOf("document.addEventListener('non-api-ai-node-pending'", manualPendingHandlerAt),
      );
      const retirementStart = board.indexOf('const retireActiveCombineManualAiRun = useCallback');
      const retirementEnd = board.indexOf('const persistAcknowledgedBoardManualAiRunIds = useCallback', retirementStart);
      const retirement = board.slice(retirementStart, retirementEnd);
      assert(committedBoundaryAt > clearChildrenAt
        && manualCleanupAt > committedBoundaryAt
        && cancel.includes('const committedCombine = committedCombineRef.current;')
        && cancel.includes('combineRunRef.current === committedCombine.token')
        && cancel.includes('liveData.manualAiResume?.committedResult === true')
        && cancel.includes("const committedCleanupMustSettle = !!liveData.boardCancellation || reason === 'node-deleted';")
        && cancel.includes('if (committedResultAlreadyVisible && !committedCleanupMustSettle)')
        && cancel.includes('if (committedResultAlreadyVisible) {')
        && cancel.includes('committed-run cleanup completed without rollback')
        && cancel.includes("if (reason === 'node-deleted') {")
        && cancel.includes("return { status: 'cancelled', cancelled: true };")
        && cancel.includes("return { status: 'completed', cancelled: false };")
        && board.includes('setFinalizingCommittedCombine(true);')
        && board.includes('recoveryCanCancel={!cleanupOnlyRecovery && !cancellationCleanupActive && !finalizingCommittedCombine}'),
      'after the replacement cascade is committed, Combine must cross a synchronous non-cancellable boundary before awaiting durable manual-AI cleanup, and an imperative late Cancel must report completion instead of a false rollback');
      const durableCommitAt = combine.indexOf('manualAiResume: manualAiRunId ? {', committedBoundaryAt);
      const durablePlanClearAt = combine.indexOf('boardScanResume: null,', committedBoundaryAt);
      const retirementPendingAt = combine.indexOf('retirementPending: true,', durableCommitAt);
      const committedResultAt = combine.indexOf('committedResult: true,', durableCommitAt);
      assert(durableCommitAt > committedBoundaryAt
        && durablePlanClearAt > committedBoundaryAt
        && retirementPendingAt > durableCommitAt
        && committedResultAt > retirementPendingAt
        && manualCleanupAt > committedResultAt
        && board.indexOf('if (resume.retirementPending) {') >= 0,
      'the visible Board commit must atomically replace its replayable scan/manual markers with a durable cleanup-only receipt, so reload before completion retires the run instead of re-running Combine');
      const cleanupCommitGuardAt = retirement.indexOf('let cleanupRemovalCommitted = false;');
      const cleanupCommitErrorAt = retirement.indexOf(
        "throw new Error('The Job Board manual-AI cleanup result was not committed to the canvas.');",
        cleanupCommitGuardAt,
      );
      const retiredTombstoneAt = retirement.indexOf(
        'rememberBoundedRunId(retiredCombineManualAiRunIdsRef.current, runId);',
        cleanupCommitErrorAt,
      );
      assert(cleanupCommitGuardAt >= 0
        && retirement.includes('cleanupRemovalCommitted = true;')
        && cleanupCommitErrorAt > cleanupCommitGuardAt
        && retiredTombstoneAt > cleanupCommitErrorAt
        && retirement.includes('retirementReceipt.retryCombineAfterRetirement === true')
        && retirement.includes('combineManualAiRunId: null,')
        && retirement.includes('const retryPlanReleased = retirementReceipts.get(runId)?.retryCombineAfterRetirement !== true')
        && (combine.match(/completeManualAiRun\(manualAiRunId, \{ retryCombineAfterRetirement: true \}\)/g) || []).length === 2,
      'backend completion must not become a mount-local retired tombstone until marker/receipt removal is observable; a delayed canvas update must throw into the durable retry-receipt path');
      assert(combine.includes('rememberBoundedRunId(committedCombineManualAiRunIdsRef.current, manualAiRunId);')
        && manualCancelledHandler.includes('if (!cancelledRunId) {')
        && manualCancelledHandler.includes('ignored manual-AI cancellation without a run')
        && manualCancelledHandler.indexOf('if (!cancelledRunId) {')
          < manualCancelledHandler.indexOf('handleCancelRun();')
        && manualCancelledHandler.includes('committedCombineManualAiRunIdsRef.current.has(cancelledRunId)')
        && manualCancelledHandler.includes('liveData.manualAiResume?.committedResult === true')
        && manualCancelledHandler.includes("retireActiveCombineManualAiRun(cancelledRunId, 'post-commit-cleanup')")
        && manualCancelledHandler.indexOf('committedCombineManualAiRunIdsRef.current.has(cancelledRunId)')
          < manualCancelledHandler.lastIndexOf('handleCancelRun();')
        && manualPendingHandler.includes('committedCombineManualAiRunIdsRef.current.has(detail.runId)')
        && manualPendingHandler.includes('liveData.manualAiResume?.committedResult === true')
        && manualPendingHandler.includes("retireActiveCombineManualAiRun(detail.runId, 'post-commit-cleanup')")
        && manualPendingHandler.indexOf('committedCombineManualAiRunIdsRef.current.has(detail.runId)')
          < manualPendingHandler.lastIndexOf('updateGlobal(id,'),
      'late pending/cancel events must carry an exact run id, and committed runs stay tombstoned after the active token clears so they may only retry retirement, never recreate recovery or cancel the displayed Board');
      const noInputsAt = combine.indexOf('if (readyAtCombine.length === 0)');
      const noInputsBlock = combine.slice(noInputsAt, combine.indexOf('const exactSourceRunsAtCombine', noInputsAt));
      assert(noInputsAt > snapshotAt
        && noInputsBlock.includes('if (options?.manualAiRunId)')
        && noInputsBlock.includes('autoResumedManualAiRunRef.current = null;')
        && noInputsBlock.includes('completeManualAiRun(manualAiRunId);'),
      'a queued crash-recovery Combine whose live inputs disappeared must retire its obsolete manual-AI marker instead of suppressing that run forever');
      return {
        sharedLane: true,
        liveSnapshot: true,
        precommitGuard: true,
        committedCleanupNonCancellable: true,
        committedCleanupReloadSafe: true,
        cleanupRemovalCommitVerified: true,
        committedLateEventsRetiredOnly: true,
        obsoleteRecoveryRetired: true,
      };
    },
  },
  {
    name: 'Untitled Board pauses resume in-memory while disconnected cancellation cannot leave a false Retry',
    run() {
      const board = readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      const scanStart = board.indexOf('const handleSearchSelected = useCallback');
      const scanEnd = board.indexOf('\n  useEffect(() => {', scanStart);
      const scan = board.slice(scanStart, scanEnd);
      const recoveryStart = board.indexOf('// A Board-owned child can survive an app restart');
      const recoveryEnd = board.indexOf('const onManualAiNodeCancelled', recoveryStart);
      const recovery = board.slice(recoveryStart, recoveryEnd);
      const disconnectStart = board.indexOf('// An edge removal is an ownership event');
      const disconnectEnd = board.indexOf('const persistBoardCancellationIntent', disconnectStart);
      const disconnect = board.slice(disconnectStart, disconnectEnd);

      assert(board.includes('const inMemoryUntitledBoardRunIdsRef = useRef(new Set());')
        && scan.includes('if (!canvasFilePath && !resumePlan) {')
        && scan.includes('rememberBoundedRunId(inMemoryUntitledBoardRunIdsRef.current, boardRunId);')
        && recovery.includes('const canResumePlanInThisRenderer = !!canvasFilePath')
        && recovery.includes('|| inMemoryUntitledBoardRunIdsRef.current.has(plan.boardRunId);')
        && recovery.includes('!canResumePlanInThisRenderer'),
      'a fresh untitled Board run must remember only its mount-local run id, so a source-card pause resumes remaining searches and Combine in this renderer but an unscoped restored plan still fails closed after reload or a true component unmount');

      const recoveryDisconnectGuard = recovery.indexOf('const disconnectCancellationKey = `${plan.boardRunId}:${activeSourceId}`;');
      const pausedSourceError = recovery.indexOf("setSearchRecoveryError('The paused Job Search changed before it could finish.");
      const exactCancellationPlanGuard = disconnect.indexOf('livePlan?.activeSourceId !== sourceId');
      const clearAfterPlan = disconnect.indexOf('setRecoveryError(null);', exactCancellationPlanGuard);
      const cancellationFailure = disconnect.indexOf('setRecoveryError(error?.message ||', clearAfterPlan);
      assert(recoveryDisconnectGuard >= 0
        && pausedSourceError > recoveryDisconnectGuard
        && recovery.slice(recoveryDisconnectGuard, pausedSourceError).includes('disconnectCancellationRef.current === disconnectCancellationKey')
        && exactCancellationPlanGuard >= 0
        && clearAfterPlan > exactCancellationPlanGuard
        && cancellationFailure > clearAfterPlan,
      'an awaited Search edge removal must suppress only its in-flight paused-source recovery error, clear it after the exact plan is retired, and retain the visible Retry error when exact cancellation genuinely fails');
      assert(disconnect.includes('const cancellationCleanupsBySource = {')
        && disconnect.includes('delete cancellationCleanupsBySource[disconnectedSourceId];')
        && disconnect.includes('const remainingCleanup = Object.values(cancellationCleanupsBySource)[0] || null;')
        && disconnect.includes('cancellationCleanupsBySource,')
        && disconnect.includes('cancellationCleanup: remainingCleanup,')
        && disconnect.includes('!nextPlan.cancellationCleanupsBySource?.[disconnectedSourceId]')
        && disconnect.includes('nextPlan.cancellationCleanup?.sourceId !== disconnectedSourceId'),
      'after one fanned-out child cancellation succeeds, reload recovery must see only the remaining source-keyed cleanup receipts and never retry the retired child through the legacy singular bridge');
      return { untitledPauseResumesOnlyInMemory: true, disconnectCancellationErrorRaceClosed: true };
    },
  },
  {
    name: 'Job Search rechecks platform verification at the live queue turn without blocking Board-owned saved scoring',
    run() {
      const search = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const pipelineStart = search.indexOf('const runPipeline = useCallback');
      const pipelineEnd = search.indexOf('const startProcessing = useCallback', pipelineStart);
      const pipeline = search.slice(pipelineStart, pipelineEnd);
      const interruptedStart = search.indexOf('const handleResumeRun = useCallback');
      const interruptedEnd = search.indexOf('resumeInterruptedRunRef.current = handleResumeRun;', interruptedStart);
      const interrupted = search.slice(interruptedStart, interruptedEnd);
      const savedStart = search.indexOf('const handleResumeSavedScrape = useCallback');
      const savedEnd = search.indexOf('resumeSavedScrapeRef.current = handleResumeSavedScrape;', savedStart);
      const saved = search.slice(savedStart, savedEnd);
      const rerunStart = search.indexOf('const handleRerun = useCallback');
      const rerunEnd = search.indexOf('const cancelBoardRun = useCallback', rerunStart);
      const rerun = search.slice(rerunStart, rerunEnd);

      assert(pipelineStart >= 0 && pipelineEnd > pipelineStart
        && search.includes('const platformsVerifyingRef = useRef(platformsVerifying);')
        && search.includes('platformsVerifyingRef.current = platformsVerifying;')
        && pipeline.includes('if (platformsVerifyingRef.current)')
        && pipeline.includes('|| hasPendingManualAiRetirement(laneTurnData)'),
      'a fresh search that waited in the shared lane must recheck platform verification before clearing state or contacting providers');
      assert(interruptedStart >= 0 && interruptedEnd > interruptedStart
        && interrupted.includes('if (platformsVerifyingRef.current)')
        && interrupted.includes('|| hasPendingManualAiRetirement(liveData)'),
      'an interrupted provider run must also consult live verification at its queued turn rather than the render that created its Resume callback');
      assert(savedStart >= 0 && savedEnd > savedStart
        && saved.includes('|| (!queueManagedByBoard && platformsVerifyingRef.current)')
        && saved.includes('|| (!queueManagedByBoard && platformsVerifyingRef.current)\n        || ('),
      'standalone saved-scrape recovery must recheck a queued connection gate, while an exact Board-owned scoring replay stays runnable because it uses no platform');
      assert(search.includes('transientReason = null,')
        && search.includes("transientReason: 'platforms-verifying'")
        && search.includes("...(typeof transientReason === 'string' && transientReason ? { transientReason } : {}),"),
      'the child must machine-tag a live verification refusal so the Board can distinguish it from a terminal setup failure');
      assert(pipeline.includes("...(queueManagedByBoard ? { transientReason: 'platforms-verifying' } : {}),")
        && interrupted.includes("...(queueManagedByBoard ? { transientReason: 'platforms-verifying' } : {}),")
        && rerunStart >= 0 && rerunEnd > rerunStart
        && rerun.includes("...(queueManagedByBoard ? { transientReason: 'platforms-verifying' } : {}),"),
      'fresh, interrupted, and rerun paths must preserve the verification tag through their later queue-turn gates when their caller is a Job Board');
      return { queuedFreshVerificationFence: true, interruptedResumeUsesLiveVerification: true, boardSavedReplayBypassesProviderGate: true, verificationRefusalTagged: true, lateGateTagsPreserved: true };
    },
  },
  {
    name: 'Exact interrupted-recovery admission is location-safe and yields while platforms verify',
    run() {
      const sourceData = {
        resumeProfile: { name: 'Ada' },
        resumeFingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        canonicalLocation: 'Denver, Colorado, USA',
      };
      const manifest = {
        found: true,
        resumable: true,
        nodeId: 'search-1',
        runId: 'run-1',
        queries: ['senior engineer', ' '],
        profileFingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        locationRecorded: true,
        canonicalLocation: 'Denver, CO',
      };
      const admitted = exactInterruptedRecoveryAdmission({
        info: manifest,
        nodeId: 'search-1',
        sourceData,
      });
      const verifying = exactInterruptedRecoveryAdmission({
        info: manifest,
        nodeId: 'search-1',
        sourceData,
        platformsVerifying: true,
      });
      const changedLocation = exactInterruptedRecoveryAdmission({
        info: { ...manifest, canonicalLocation: 'Toronto, Ontario, Canada' },
        nodeId: 'search-1',
        sourceData,
      });
      const legacyLocation = exactInterruptedRecoveryAdmission({
        info: { ...manifest, locationRecorded: false },
        nodeId: 'search-1',
        sourceData,
      });
      const noQueries = exactInterruptedRecoveryAdmission({
        info: { ...manifest, queries: [' ', null] },
        nodeId: 'search-1',
        sourceData,
      });
      const wrongOwner = exactInterruptedRecoveryAdmission({
        info: { ...manifest, nodeId: 'search-2' },
        nodeId: 'search-1',
        sourceData,
      });
      const noProfile = exactInterruptedRecoveryAdmission({
        info: manifest,
        nodeId: 'search-1',
        sourceData: { ...sourceData, resumeProfile: null },
      });
      const noManifestFingerprint = exactInterruptedRecoveryAdmission({
        info: { ...manifest, profileFingerprint: null },
        nodeId: 'search-1',
        sourceData,
      });
      const changedProfile = exactInterruptedRecoveryAdmission({
        info: { ...manifest, profileFingerprint: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
        nodeId: 'search-1',
        sourceData,
      });
      const malformedProfile = exactInterruptedRecoveryAdmission({
        info: { ...manifest, profileFingerprint: 'not-a-profile-fingerprint' },
        nodeId: 'search-1',
        sourceData,
      });

      assert(admitted.ok && admitted.runId === 'run-1'
        && admitted.queries.length === 1
        && verifying.ok === false && verifying.reason === 'platforms-verifying'
        && changedLocation.ok === false && changedLocation.reason === 'location-mismatch'
        && legacyLocation.ok === false && legacyLocation.reason === 'missing-location'
        && noQueries.ok === false && noQueries.reason === 'missing-queries'
        && wrongOwner.ok === false && wrongOwner.reason === 'wrong-owner'
        && noProfile.ok === false && noProfile.reason === 'missing-profile'
        && noManifestFingerprint.ok === false && noManifestFingerprint.reason === 'missing-profile-fingerprint'
        && changedProfile.ok === false && changedProfile.reason === 'profile-fingerprint-mismatch'
        && malformedProfile.ok === false && malformedProfile.reason === 'missing-profile-fingerprint',
      'an exact manifest is admitted only with a current matching location, profile, and queries; a verification transition yields rather than admitting a stale preflight');
      return {
        exactManifestAdmitted: true,
        verificationYielded: true,
        malformedAndMismatchedManifestsRejected: 8,
      };
    },
  },
  {
    name: 'Exact Board resume token refusals stay in the recovery inspection lane',
    run() {
      const missing = exactInterruptedRecoveryBackendFailure({
        success: false,
        resumeRunMissing: true,
        error: 'The recovery manifest is gone.',
      }, 'board-run-1');
      const replaced = exactInterruptedRecoveryBackendFailure({
        success: false,
        resumeRunMismatch: true,
        error: 'A newer recovery replaced it.',
      }, 'board-run-1');
      const changedProfile = exactInterruptedRecoveryBackendFailure({
        success: false,
        resumeProfileMismatch: true,
        error: 'The career profile changed.',
      }, 'board-run-1');
      const missingProfile = exactInterruptedRecoveryBackendFailure({
        success: false,
        resumeProfileMissing: true,
        error: 'The recovery predates profile-safe metadata.',
      }, 'board-run-1');
      const ordinaryProviderFailure = exactInterruptedRecoveryBackendFailure({
        success: false,
        error: 'The provider timed out.',
      }, 'board-run-1');
      const tokenlessLegacyFailure = exactInterruptedRecoveryBackendFailure({
        success: false,
        resumeRunMissing: true,
      }, null);
      const successfulRecovery = exactInterruptedRecoveryBackendFailure({
        success: true,
        resumeRunMissing: true,
      }, 'board-run-1');

      assert(missing?.reason === 'run-missing'
        && missing.runId === 'board-run-1'
        && missing.error === 'The recovery manifest is gone.'
        && replaced?.reason === 'run-mismatch'
        && replaced.runId === 'board-run-1'
        && replaced.error === 'A newer recovery replaced it.'
        && changedProfile?.reason === 'profile-mismatch'
        && changedProfile.error === 'The career profile changed.'
        && missingProfile?.reason === 'profile-missing'
        && missingProfile.error === 'The recovery predates profile-safe metadata.'
        && ordinaryProviderFailure === null
        && tokenlessLegacyFailure === null
        && successfulRecovery === null,
      'only a failed token-bearing exact recovery is classified as an inspection failure; ordinary provider and legacy failures keep their normal paths');
      return { missingTokenRetained: true, replacedTokenRetained: true, profileTokenRetained: true, ordinaryFailuresUnchanged: true };
    },
  },
  {
    name: 'A disconnected active Board recovery continues to reserve its Search actions',
    run() {
      const nodes = [
        { id: 'search-1', type: 'jobhub', data: { hubState: 'done' } },
        {
          id: 'board-1',
          type: 'jobboard',
          data: {
            boardScanResume: {
              version: 1,
              boardRunId: 'board-run-1',
              phase: 'searches',
              selectedSearchModuleIds: ['search-1'],
              activeSourceId: 'search-1',
              startedAt: 1,
            },
          },
        },
      ];
      const disconnectedOwner = findJobSearchBoardActiveRecoveryOwner('search-1', nodes, []);
      const queuedDisconnectedPlan = {
        ...nodes[1],
        data: {
          boardScanResume: {
            ...nodes[1].data.boardScanResume,
            activeSourceId: null,
          },
        },
      };
      const nonOwner = findJobSearchBoardActiveRecoveryOwner(
        'search-1', [nodes[0], queuedDisconnectedPlan], [],
      );
      const settledOwner = findJobSearchBoardActiveRecoveryOwner(
        'search-1', [{ ...nodes[0] }, { id: 'board-1', type: 'jobboard', data: {} }], [],
      );
      const nonPrimaryNodes = [
        { id: 'search-2', type: 'jobhub', data: { hubState: 'done' } },
        {
          id: 'board-2',
          type: 'jobboard',
          data: { boardScanResume: {
            version: 1,
            boardRunId: 'board-run-2',
            phase: 'searches',
            selectedSearchModuleIds: ['search-1', 'search-2'],
            activeSourceId: 'search-1',
            activeSourceIds: ['search-1', 'search-2'],
            startedAt: 2,
          } },
        },
      ];
      const disconnectedNonPrimaryOwner = findJobSearchBoardActiveRecoveryOwner(
        'search-2', nonPrimaryNodes, [],
      );

      assert(disconnectedOwner?.orchestratorNodeId === 'board-1'
        && disconnectedOwner?.boardRunId === 'board-run-1'
        && disconnectedNonPrimaryOwner?.orchestratorNodeId === 'board-2'
        && disconnectedNonPrimaryOwner?.boardRunId === 'board-run-2'
        && nonOwner === null
        && settledOwner === null,
      'removing the visible Board edge must not release either the primary or a fanned-out active child recovery until its Board plan settles; a merely queued or retired Board has no such reservation');
      return { disconnectedActiveOwnerRetained: true, queuedPlanNotOverreserved: true, settledPlanReleased: true };
    },
  },
  {
    name: 'Job Board admits only an exact disabled-platform manifest recovery and never falls back fresh on token drift',
    run() {
      const board = readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      const search = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const selection = readFileSync(new URL('../../src/nodes/jobboard/JobBoardSearchSelection.jsx', import.meta.url), 'utf8');
      const runnerStart = search.indexOf('const runForJobBoard = useCallback');
      const runnerEnd = search.indexOf('// Re-score the currently displayed listings', runnerStart);
      const runner = search.slice(runnerStart, runnerEnd);
      const resumeStart = search.indexOf('const handleResumeRun = useCallback');
      const resumeEnd = search.indexOf('resumeInterruptedRunRef.current = handleResumeRun;', resumeStart);
      const resume = search.slice(resumeStart, resumeEnd);
      const exactRecoveryAt = runner.indexOf('} else if (exactInterruptedRecovery) {');
      const genericRecoveryAt = runner.indexOf('} else if (recoverInterruptedJobRun || window.electronAPI?.peekJobRun) {');
      const exactBackendFailureAt = resume.indexOf('const exactRecoveryFailure = queueManagedByBoard');
      const exactBackendFailureReturnAt = resume.indexOf("return searchRunOutcome('recovery-inspection-failed', exactRecoveryFailure);", exactBackendFailureAt);
      const genericBackendFailureAt = resume.indexOf('if (!searchResult?.success) {', exactBackendFailureAt);

      assert(board.includes("import { exactInterruptedRecoveryAdmission } from '../utils/jobBoardRecoveryAdmission';")
        && board.includes('async function inspectExactResumableJobRun(canvasFilePath, nodeId, sourceData, {')
        && board.includes('const admission = exactInterruptedRecoveryAdmission({')
        && board.includes('platformsVerifying,')
        && board.includes("readiness?.statusLabel === 'Needs platform'")
        && board.includes("sourceData?.hubState !== 'sources-ready'")
        && board.includes("statusLabel: 'Resume saved recovery'")
        && board.includes('const [interruptedRecoveryProbes, setInterruptedRecoveryProbes] = useState({});')
        && board.includes('&& !hasActivePlatformVerification(verifyingPlatforms)')
        && board.includes('hasActivePlatformVerification(verifyingPlatformsRef.current)')
        && board.includes('const failedCachedProbes = admissionReadiness.filter(')
        && board.includes('currentProbe?.runId === cachedRecoveryProbe.runId')
        && board.includes('Waiting for ${label} connection checks…')
        && board.includes('const scanPreflightRef = useRef(null);')
        && board.includes('if (scanPreflightRef.current) return;')
        && board.includes('scanPreflightRef.current = preflightToken;')
        && board.includes('if (scanPreflightRef.current === preflightToken) scanPreflightRef.current = null;')
        && selection.includes('!hasUnreadySelection')
        && board.includes('interruptedRecoveryRunId,'),
      'only an exact, owned, resumable manifest may bypass an all-disabled current platform selection; Source-card Resolve/Skip remains the sole sources-ready continuation');
      const transientBoundaryAt = board.indexOf("if (result?.transientReason === 'platforms-verifying')");
      const cancelledBoundaryAt = board.indexOf("if (result?.status === 'cancelled')", transientBoundaryAt);
      assert(transientBoundaryAt >= 0
        && cancelledBoundaryAt > transientBoundaryAt
        && board.slice(transientBoundaryAt, cancelledBoundaryAt).includes('activeSourceRollback,')
        && board.slice(transientBoundaryAt, cancelledBoundaryAt).includes('autoResumedBoardScanRef.current = null;')
        && board.slice(transientBoundaryAt, cancelledBoundaryAt).includes('scan yielding to child platform verification'),
      'a verification transition after the final manifest peek must preserve the exact active child receipt at the returned-result boundary, then release the recovery latch for a later retry');
      assert(search.includes("new CustomEvent('job-run-recovery-ledger-changed'")
        && search.includes('detail: { hubId: id, canvasFilePath, runId }')
        && board.includes("document.addEventListener('job-run-recovery-ledger-changed', onRecoveryLedgerChanged)")
        && board.includes('delete next[hubId];')
        && board.indexOf('interruptedRecoveryProbeGenerationRef.current += 1;')
          < board.indexOf('delete next[hubId];'),
      'a successful Start fresh invalidates an in-flight probe before removing the matching connected-Board recovery cache, so an old peek cannot repopulate Resume afterward');
      assert(runner.includes('interruptedRecoveryRunId = null')
        && runner.includes('interruptedRecovery: exactInterruptedRecovery')
        && exactRecoveryAt >= 0
        && genericRecoveryAt > exactRecoveryAt
        && runner.slice(exactRecoveryAt, genericRecoveryAt).includes('expectedRunId: interruptedRecoveryRunId')
        && runner.slice(exactRecoveryAt, genericRecoveryAt).includes("outcome?.status === 'not-found' || outcome?.status === 'stale-recovery-found'")
        && resume.includes('discovered.runId !== options.expectedRunId')
        && resume.includes("return searchRunOutcome('recovery-inspection-failed'")
        && exactBackendFailureAt >= 0
        && exactBackendFailureReturnAt > exactBackendFailureAt
        && genericBackendFailureAt > exactBackendFailureReturnAt,
      'the child rechecks the exact preflight token, permits its frozen provider breadth only for that recovery, and returns a missing/replaced backend token to the Board inspection lane before generic provider-failure handling');
      const postInspectionVerificationYield = board.indexOf('recovered scan waiting for platform verification after manifest inspection');
      const reinspectionVerificationYield = board.indexOf('recovered scan waiting for platform verification after manifest reinspection');
      const preflightVerificationYield = board.indexOf('recovered scan waiting for platform verification id=');
      const globalVerificationMarker = board.indexOf("'exact-recovery-verifying'");
      assert(postInspectionVerificationYield >= 0
        && board.slice(postInspectionVerificationYield - 700, postInspectionVerificationYield).includes('autoResumedBoardScanRef.current = null;')
        && reinspectionVerificationYield >= 0
        && board.slice(reinspectionVerificationYield - 700, reinspectionVerificationYield).includes('autoResumedBoardScanRef.current = null;')
        && preflightVerificationYield >= 0
        && board.slice(preflightVerificationYield - 700, preflightVerificationYield).includes('autoResumedBoardScanRef.current = null;')
        && globalVerificationMarker >= 0
        && board.slice(globalVerificationMarker - 900, globalVerificationMarker).includes('exactRecoveryBlockedByGlobalVerification'),
      'every Board verification yield releases its one-shot scan latch, and an all-disabled exact recovery keys the global verification transition so it wakes after session checks settle');
      return {
        exactManifestRequired: true,
        sourcesReadyPreserved: true,
        staleTokenFailsClosed: true,
        verificationYieldsWakeRecovery: true,
      };
    },
  },
  {
    name: 'ZipRecruiter retries one verified blank shortfall page and retains an incomplete outcome when it stays blank',
    run() {
      const base = {
        sourceId: 'ziprecruiter',
        claimedTotal: 120,
        providerGathered: 48,
        pageNum: 3,
        maxPages: 20,
        hasNextUrl: true,
        pageIdentityValid: true,
      };
      const firstBlank = zipRecruiterProviderShortfallRecoveryOutcome({
        ...base,
        retryAttempted: false,
        extractedRows: 0,
      });
      const recovered = zipRecruiterProviderShortfallRecoveryOutcome({
        ...base,
        retryAttempted: true,
        documentReloaded: true,
        extractedRows: 24,
      });
      const staleDocument = zipRecruiterProviderShortfallRecoveryOutcome({
        ...base,
        retryAttempted: true,
        documentReloaded: false,
        extractedRows: 24,
      });
      const persistentlyBlank = zipRecruiterProviderShortfallRecoveryOutcome({
        ...base,
        retryAttempted: true,
        documentReloaded: true,
        extractedRows: 0,
      });
      const unverifiedPage = zipRecruiterProviderShortfallRecoveryOutcome({
        ...base,
        pageIdentityValid: false,
        retryAttempted: false,
        extractedRows: 0,
      });
      const blockedRetryStop = resolveManualSourceStopReason({
        sourceSkipped: true,
        hitProviderTotalShortfall: true,
      });
      const durableReceipt = providerTotalShortfallRecoveryReceipt({
        pageNum: 3,
        attempts: 1,
        status: 'rows-reloaded-no-new-identities',
        rawRows: 24,
        newProviderRows: 0,
        shortfall: 72,
        url: 'https://www.ziprecruiter.com/jobs-search/3?search=private+query&token=secret',
      });
      const persistentWarning = zipRecruiterProviderTotalShortfallWarning({
        claimedTotal: 120,
        providerGathered: 48,
        retryStatus: 'blank-after-reload',
      });
      const scraper = readFileSync(new URL('../../electron/ipc/browser/manualScraper.js', import.meta.url), 'utf8');
      const jobsIpc = readFileSync(new URL('../../electron/ipc/jobs.js', import.meta.url), 'utf8');

      assert(firstBlank === 'retry'
        && recovered === 'recovered'
        && staleDocument === 'shortfall'
        && persistentlyBlank === 'shortfall'
        && unverifiedPage === 'shortfall'
        && blockedRetryStop === 'blocked',
      'only the first blank, verified ZipRecruiter page below its advertised total gets one direct reload; recovery requires a replaced document and rows, while a second blank or unverified page remains explicitly incomplete');
      assert(durableReceipt?.status === 'rows-reloaded-no-new-identities'
        && durableReceipt.rawRows === 24
        && durableReceipt.newProviderRows === 0
        && durableReceipt.shortfall === 72
        && !Object.hasOwn(durableReceipt, 'url')
        && !JSON.stringify(durableReceipt).includes('private+query'),
      'a reload that only re-serves known identities remains distinguishable from new rows, and the direct URL/query never enters the durable source receipt');
      assert(persistentWarning?.code === 'provider-total-shortfall'
        && persistentWarning.severity === 'warn'
        && persistentWarning.evidence.includes('48 of ~120')
        && persistentWarning.suggestion.includes('Rerun this source later')
        && !JSON.stringify(persistentWarning).includes('private+query'),
      'a persistent shortfall is a visible, non-gating rerun-later warning: partial rows continue, but coverage never silently reads as complete');
      assert(scraper.includes('const shortfallRetry = providerTotalShortfallRecoveryReceipt(providerTotalShortfallRecovery);')
        && scraper.includes('...(shortfallRetry ? { shortfallRetry } : {}),')
        && scraper.includes('const reloadReplacedDocument = await page.evaluate(marker => (')
        && scraper.includes('documentReloaded: true,')
        && scraper.includes("if (retryReady === 'hard-block' || retryReady === 'skip') {")
        && scraper.includes('sourceSkipped = true;')
        && jobsIpc.includes('sourceResults[sourceId].directContinuation = { ...result.directContinuation };')
        && jobsIpc.includes('bySource[sid].directContinuation = data.directContinuation;'),
      'the safe retry receipt travels through the existing jobs aggregation and terminal-source projection instead of being dropped as an unrecognized scraper field');
      return { oneRetryAllowed: true, rowsRecovered: true, staleDocumentRejected: true, blockedRetrySurfaced: true, persistentBlankRetained: true, persistentWarningVisible: true, pageIdentityRequired: true, duplicateReloadRetained: true, durableUrlRedacted: true };
    },
  },
];
