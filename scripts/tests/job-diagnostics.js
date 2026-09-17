import { ALL_COMP_SOURCE_IDS, buildJobCompletionAssessment, filterJobsByAge, getJobSearchTransientKeysForSave, COL_X, assert, applyBugReportCode, buildCoverLetterDocument, buildJobRecoverySnapshot, buildJobTreeNodes, buildJobsPipelineSnapshot, buildOverlayScript, buildResumeDocument, buildScoringAudit, calibratedScoreForJob, canonicalSalaryRangeLabel, chunkScoringBatches, combineSignature, computeJobTreeView, computeLayoutPositions, countMatchingDescendantCards, dedupAgainstHistory, dedupJobsAcrossSources, dedupeJobsByKey, deriveBoardCardStats, electronPkg, assertRetainedResumeRoleBullets, extractExecutedGoogleQueryStrings, extractSalaryFromText, extractVariantAttrs, extractZipRecruiterDomSalaryText, filterHandledJobSourceWarnings, filterJobsByDescriptionEvidence, formatGlassdoorCacheProvenance, formatJsonLdSalary, formatPipelineState, formatSourceEvent, formatUSAJobsSalary, fs, generateMarkdown, getApplicationTelemetry, getGlassdoorLocIdCache, getJobAnalysisPaths, getJobsTelemetry, getManualScraperTelemetry, getStats, getStatsSignature, inspectJobBoardRoleByIndex, isDualMode, isIgnorableManualBrowserTelemetry, isJobCardVisible, isJobSourceWarningGating, isLegacyCombineSignature, isRemoteOkSponsoredPlacement, jobSourceWarningAction, jobTitleCompanyKey, jobTitleCompanyLocationKey, jobTitleCompanyUrlKey, linkedInBrowserUnavailableResult, linkedInBrowserUnavailableWarning, linkedInSameIpRetryDecision, looksLikeMoney, mergeExpandedJobDetail, mergeRecoveredScoreRows, mergeResolvedSourceItems, mergeSourceProgress, moduleFingerprint, normalizeBandsWithRepairs, normalizeCompWarnings, normalizeDetailNavigationUrl, normalizeJobBoardRoleByIndex, normalizeRangesWithRepairs, parseSalaryToNumeric, path, prepareLiveScoringResults, reconcileZipRecruiterDomSalary, recordApplicationTelemetry, recordJobSourceProgress, recordJobsBoardScope, recordJobsSourceScope, recordLinkedinResolveAttempt, recordResolveMergeOutcome, recordManualScraperTelemetry, resetManualScraperTelemetry, replaceApplicationBundleAtomically, reserveSharedProfile, resolveNodePresence, retainedResumeRolesWithoutBullets, salaryRangeAnomaly, salaryRangeMetadata, sanitizeJobTaxonomy, saveGlassdoorLocId, scoringAuditRowsFromBatches, shouldNavigateForDescription, descriptionNavigationDecision, isUnavailableDetailPage, shouldReflowMeasuredJobCard, sourceJobKey, staleReason, summarizeScoringInputQuality, targetPageCountForJob, tryGetStore, unionScoredJobs, uniqueJobsAcrossSources, uniqueJobsNotIn, validateJobBoardRoleTaxonomy, validateJobScoringSubmission, zipRecruiterRetryAfterMs } from '../test-dependencies.js';
import { __canWriteJobResolveTelemetryForTests, __recordJobSourceResolvePassForTests } from '../test-dependencies.js';
import { buildNativeChallengeHistoryEvidence } from '../test-dependencies.js';
import { redactNodeForIssueReport } from '../test-dependencies.js';
import { collapseConsecutiveIdentical, postPipelineRecoveryAttemptCount } from '../test-dependencies.js';
import { __createDescriptionRecoveryCheckpointForTests, __loadDescriptionRecoveryCheckpointForTests, __loadJobAnalysisSnapshotForTests, ipcMain, registerBugReportHandlers } from '../test-dependencies.js';
import { buildMainProcessLogsMarkdown, newestFirstLogLines, timestampedLogLines } from '../test-dependencies.js';
import { formatEventLogEntry, localIsoTimestampWithOffset } from '../../src/utils/EventLogger.js';
import { descriptionPanelFailureAttribution } from '../../electron/ipc/browser/manualScraper.js';
// Imported directly rather than through test-dependencies.js (a file this task
// must not touch): clipboardCap.js has zero electron/module dependencies, so
// this is safe and mirrors the EventLogger.js direct-import pattern above.
import { enforceClipboardMarkdownCap, collapseEventBursts, collapseLogRepeats } from '../../electron/ipc/bugReport/clipboardCap.js';
// Same direct-import rationale as above: these auth-history renderers are new
// exports of bugReport.js and test-dependencies.js is outside this task's file
// scope. generateMarkdown (re-exported through test-dependencies) covers the
// end-to-end path; these pure builders are what let a test seed a fixture ring,
// which the live auth-window ring offers no seam for.
import { buildAuthLifecycleTableMarkdown, buildNativeChallengeSessionMarkdown, formatAuthHistoryTruncationNote, selectAuthHistoryForReport } from '../../electron/ipc/bugReport.js';
import { SAVED_REPORT_MAX_AGE_MS, SAVED_REPORT_RETENTION, __resetSavedBugReportPruneForTests, buildClipboardPointer, pruneSavedBugReports, savedBugReportDir, writeSavedBugReport } from '../../electron/ipc/bugReport/reportFile.js';
import { buildFilterSummaryMarkdown } from '../test-dependencies.js';
import { listDescriptionRecoveryCheckpointsSync } from '../test-dependencies.js';
import { createSourceProgressRunGuard, descriptionRecoveryCheckpointWriteFailureWarning, isJobSourceResolveBusyHubState, reconcileJobSourceWarnings } from '../test-dependencies.js';
import { ADVANCE_CONTROL_LABEL_PATTERNS, buildResolvedDescriptionWarning, canAttemptJobSourceResolve, challengeHeartbeatIntervalMs, CHALLENGE_INTERSTITIAL_MAX_CHARS, classifyManualChallengeSignals, descriptionPanelPacing, formatChallengeTextEvidence, hasManualHardBlockText, hasManualVerificationText, isAppcastTemporaryRestriction, isDetachedDetailFrameError, isZipRecruiterDetailErrorShell, isZipRecruiterClosedDetailRedirect, mergeDescriptionDetailMissWarning, pinGlassdoorDetailUrlToListHost, resolveManualChallengeTransition, resolveManualDetailChallengeDisposition, zipRecruiterAppcastRestrictionBackoffMs, zipRecruiterDetailErrorShellBackoffMs } from '../test-dependencies.js';
import { planPartialScoreRecovery } from '../test-dependencies.js';
import { reconcileSearchFunnel } from '../test-dependencies.js';
import { sanitizeLastRunReceipt } from '../test-dependencies.js';
import { reconcileGlassdoorSalaryFromDescription } from '../test-dependencies.js';
import { JOB_COLLECTION_PAGE_CEILING, JSDOM, PDFLib, getApplicationSyncTelemetry, inspectApplicationExport, mergeSelectedApplicationPanel, recordApplicationSyncTelemetry } from '../test-dependencies.js';
import { applicationVariantAttrsForJob } from '../test-dependencies.js';
import { fixedPageTypeAreaHeight, formatUnderfilledTypeAreaUtilization, pageTextMeasurementExpression, resumeIsMateriallyUnderfilled, resumeTypeAreaUtilization } from '../test-dependencies.js';
import { reconcileTitleRelevanceFunnel, recordIssuedManualQuery } from '../test-dependencies.js';
import { createApplicationConvergenceTracker } from '../test-dependencies.js';
import { assertResponseMatchesSchema, buildJobAnalysisSnapshot, JOB_DESCRIPTION_EVIDENCE_MIN_CHARS, JOB_SCORING_SCHEMA, mergeDescriptionRecoverySourceJobs, RESUME_PARSE_SCHEMA, snapshotDescriptionRecoveryJobs } from '../test-dependencies.js';
import { buildLoginVerificationTimingMarkdown, formatLoginVerificationTimingResult } from '../../electron/ipc/bugReport.js';
import { buildJobBoardDiagnostics, buildJobLinkSnapshot, handoffElapsed, manualAiBoardProgressForNode, receiptElapsed } from '../../electron/ipc/bugReport/jobsSnapshot.js';
import { redactReportUrlsInText, renderSessionTraceBlocks } from '../../electron/ipc/bugReport/helpers.js';
import { __listDescriptionRecoveryCheckpointsForTests, __withLockedLinkedInEnrichmentForTests, authenticatedIndeedScrapeStatus, indeedWarningRequiresManualVerification, registerJobsHandlers, withFreshManualScraperTelemetry } from '../../electron/ipc/jobs.js';
import { logger } from '../../electron/logger.js';
import { GLASSDOOR_EXTRACTOR, recordActivityBeat, setActivitySink, scrapeManualSources } from '../test-dependencies.js';
import { isTerminalSourceStatus } from '../test-dependencies.js';
import { clipReportText } from '../test-dependencies.js';
import { composeDetailBlockReprobeResult, didDetailBlockReprobeRecover } from '../test-dependencies.js';
import { getJobDescriptionRecoveryCheckpointPath } from '../../electron/ipc/jobAnalysisPaths.js';
import { jobRunPathScopeForCanvas, lastRunReceiptPathForCanvas } from '../../electron/ipc/jobRunStaging.js';
import { __runWithIpcRequestContextForTests } from '../../electron/ipc/ipcUtils.js';
import { __recordJobSourceDispatchForTests, __resetJobsTelemetryForTests } from '../../electron/ipc/jobs.js';
import { boundedCombinedSourceRuns, normalizeBoardResultCount } from '../../src/utils/jobBoardProvenance.js';
import { collectCompactJobBoardTopology } from '../../src/utils/jobBoardReportTopology.js';
import os from 'node:os';
import { appendJobsHistory, loadJobsHistory } from '../../electron/ipc/jobsHistory.js';

export default [
  {
    name: 'job diagnostics never joins ambiguous terminal receipts to another hub snapshot',
    run: () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-receipt-snapshot-join-'));
      const canvas = path.join(dir, 'canvas.json');
      const hubA = 'receipt-snapshot-hub-a';
      const hubB = 'receipt-snapshot-hub-b';
      const writeGeneration = (hubId, runId, count) => {
        const analysis = getJobAnalysisPaths(canvas, path.join(dir, 'analysis'), hubId);
        fs.writeFileSync(analysis.jsonPath, JSON.stringify({ runId, sourceHubId: hubId, canvasFilePath: canvas, jobs: Array.from({ length: count }, () => ({})) }));
        fs.writeFileSync(lastRunReceiptPathForCanvas(canvas, hubId), JSON.stringify({
          runId, nodeId: hubId, terminal: { status: 'completed', outcome: 'populated', scoreReadyCount: count }, cleanup: { attempted: true, cleared: true },
        }));
      };
      try {
        writeGeneration(hubA, 'shared-prefix-run-a', 3);
        writeGeneration(hubB, 'shared-prefix-run-b', 12);
        const ambiguous = buildJobCompletionAssessment(canvas, new Set([hubA, hubB]), [], 0, new Set([hubA, hubB]));
        assert(ambiguous.includes('Terminal receipt: ⚠️ ambiguous across 2 current Job Search hubs')
          && ambiguous.includes('Saved score-ready snapshot: ambiguous terminal receipts')
          && ambiguous.includes('multiple terminal receipt generations are present; no single run was selected for compact reconciliation')
          && !ambiguous.includes('terminal receipt is not completed')
          && !ambiguous.includes('12 job(s)'),
        'multiple completed current receipts must state ambiguity rather than borrowing either hub’s snapshot or claiming one failed');

        // A selected live hub is the only admissible path to a matching
        // generation; matching by owner alone is insufficient after a rerun.
        const selected = buildJobCompletionAssessment(canvas, new Set([hubA]), [], 0, new Set([hubA]));
        assert(selected.includes('Saved score-ready snapshot: 3 job(s)')
          && selected.includes('run `shared-prefix-run-a`')
          && !selected.includes('12 job(s)'),
        'one current receipt joins only its exact owner/run snapshot');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return { receiptScopes: 2 };
    },
  },
  {
    name: 'job diagnostics bound oversized snapshots and retain Board transaction metadata',
    run: () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-board-diagnostic-bounds-'));
      const canvas = path.join(dir, 'canvas.json');
      const hubId = 'sameprefix-source-A';
      const secondHubId = 'sameprefix-source-B';
      const boardId = 'sameprefix-board-A';
      const twinBoardId = 'sameprefix-board-B';
      try {
        const analysis = getJobAnalysisPaths(canvas, path.join(dir, 'analysis'), hubId);
        fs.writeFileSync(analysis.jsonPath, JSON.stringify({
          runId: 'sameprefix-run-A', sourceHubId: hubId, canvasFilePath: canvas, createdAt: '2026-09-13T00:00:00.000Z', gatheredJobCount: 7,
          jobs: [{ description: 'x'.repeat(4 * 1024 * 1024) }],
        }));
        const recovery = buildJobRecoverySnapshot(canvas, new Set([hubId]), new Set([hubId]));
        assert(recovery.includes('TOO_LARGE') && recovery.includes('bounded header only, unverified')
          && recovery.includes('7 score-ready (header claim)'),
        'oversized snapshots expose only a bounded, explicitly unverified header');

        const board = { id: boardId, type: 'jobboard', data: {
          hubState: 'empty', resultCount: 0, stale: false,
          selectedSearchModuleIds: [hubId, secondHubId],
          boardScanResume: { phase: 'awaiting-source', boardRunId: 'sameprefix-run-board', activeSourceId: hubId, awaitingSourceId: secondHubId, completedSourceRuns: [{ sourceHubId: hubId, runId: 'sameprefix-run-A' }] },
          combineSignature: '8:[["sameprefix-source-A","a"],["sameprefix-source-B","b"]]',
          // The manual-combine receipt deliberately uses sourceId rather than
          // persisted sourceHubId. FULL diagnostics must retain this pair.
          combineSourceRuns: [{ sourceId: secondHubId, runId: 'sameprefix-combine-B' }],
          recoverableFailure: { stage: 'combine' }, cancellationCleanup: { status: 'rolled-back' }, clearProvenance: { priorResultCount: 4 },
        } };
        const twinBoard = { id: twinBoardId, type: 'jobboard', data: { hubState: 'empty', resultCount: 0 } };
        // The only real Board↔Search edge is after more than 2,000 unrelated
        // edges. Diagnostics and completion assembly must inspect it exactly.
        const lateLiveEdge = { id: 'edge-live', source: hubId, target: boardId };
        const longEdges = [
          ...Array.from({ length: 2_001 }, (_, index) => ({ id: `unrelated-${index}`, source: `x-${index}`, target: `y-${index}` })),
          lateLiveEdge,
          { id: 'edge-b', source: secondHubId, target: boardId },
        ];
        const boardReport = buildJobBoardDiagnostics([
          { id: hubId, type: 'jobhub', data: {} }, { id: secondHubId, type: 'jobhub', data: {} }, board, twinBoard,
          { id: 'group-1', type: 'jobgroup', data: { hubId: boardId } }, { id: 'card-1', type: 'jobcard', data: { hubId: boardId } },
        ], longEdges);
        const sourceLabels = [...boardReport.matchAll(/samepref…[a-f0-9]+/g)].map(match => match[0]);
        const boardLabels = [...boardReport.matchAll(/- Board `([^`]+)`:/g)].map(match => match[1]);
        assert(boardReport.includes('connected=') && boardReport.includes('groups=1 · cards=1')
          && boardReport.includes('phase=awaiting-source') && boardReport.includes('recoverable-failure=recorded')
          && boardReport.includes('cancellation=recorded') && boardReport.includes('clear=recorded (prior results 4)')
          && boardReport.includes('combine-source-runs=1')
          && new Set(sourceLabels).size >= 2
          && boardLabels.length === 2 && new Set(boardLabels).size === 2
          && !boardReport.includes(hubId) && !boardReport.includes(secondHubId)
          && !boardReport.includes(boardId) && !boardReport.includes(twinBoardId),
        'Board diagnostics retain sourceId combine receipts, scan late live edges, and keep colliding labels distinct across individual Board rows');

        fs.writeFileSync(lastRunReceiptPathForCanvas(canvas, hubId), JSON.stringify({
          runId: 'sameprefix-run-A', nodeId: hubId,
          terminal: { status: 'completed', outcome: 'populated', scoreReadyCount: 7 }, cleanup: { attempted: true, cleared: true },
        }));
        const full = generateMarkdown({
          description: 'empty connected Board correlation fixture', filterCode: 'FULL',
          filterStats: { hasJobNodes: true, hasSellNodes: false, currentNodeIds: [hubId, boardId], currentJobHubIds: [hubId], jobBoardStates: [], jobBoardStateCount: 0, omittedSections: [] },
          nodes: [{ id: hubId, type: 'jobhub', data: {} }, board],
          edges: longEdges, drawings: [], frontEndState: { currentFile: canvas }, nodeInternals: [], nodeComponentStates: [], eventLogs: [],
        }).markdown;
        assert(full.includes('Job Board consumers: 1/1 correlate to this source run'),
          'a Board omitted from compact filter stats still inherits its live Job Search edge for completion correlation');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return { boundedSnapshot: true, emptyConnectedBoard: true };
    },
  },
  {
    name: 'late panel failures retain the issuing card attribution',
    run: () => {
      const current = { startIndex: 8, key: 'next-card', title: 'Next card' };
      const issuing = { startIndex: 7, key: 'previous-card', title: 'Previous card' };
      const late = descriptionPanelFailureAttribution(issuing, current);
      const beforeFirstRequest = descriptionPanelFailureAttribution(null, current);
      assert(late.startIndex === 7 && late.key === 'previous-card' && late.title === 'Previous card',
        'a response delivered during the between-card cooldown must defer and report the request that caused it, not the next card');
      assert(beforeFirstRequest.startIndex === 8 && beforeFirstRequest.key === 'next-card',
        'without an issued request, late-panel attribution must safely retain the current fallback');
      return { lateIndex: late.startIndex + 1, fallbackIndex: beforeFirstRequest.startIndex + 1 };
    },
  },
  {
    name: 'Job completion diagnostics preserve opaque delimiter-bearing Board correlations and reject malformed v8 pairs',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId,
        search: telemetry.search,
        resolves: telemetry.resolves,
        scoring: telemetry.scoring,
        bucketing: telemetry.bucketing,
        pipeline: telemetry.pipeline,
        history: telemetry.history,
      };
      const sourceId = 'imported|search=west';
      const boardId = 'v8-provenance-board';
      const canvas = path.join(os.tmpdir(), `ic-v8-provenance-${Date.now()}-${Math.random()}.json`);
      try {
        // No receipt or snapshot is needed here: this is the public diagnostic
        // seam that maps a Board's durable provenance to the active hub.
        Object.assign(telemetry, {
          nodeId: sourceId,
          search: null,
          resolves: {},
          scoring: null,
          bucketing: null,
          pipeline: null,
          history: null,
        });
        const validSignature = combineSignature([{ id: sourceId, fingerprint: 'v8-fingerprint' }]);
        const assessmentFor = (board) => buildJobCompletionAssessment(
          canvas,
          new Set([sourceId, boardId]),
          [{ id: boardId, stale: false, ...board }],
          1,
        );
        const valid = buildJobCompletionAssessment(canvas, new Set([sourceId, boardId]), [{
          id: boardId,
          hubState: 'done',
          resultCount: 1,
          mergeUnique: 1,
          combineSignature: validSignature,
          connectedSourceHubIds: [],
          stale: false,
        }], 1);
        const connected = assessmentFor({
          hubState: 'empty',
          resultCount: 0,
          mergeUnique: null,
          combineSignature: null,
          connectedSourceHubIds: [sourceId],
        });
        const cleared = assessmentFor({
          hubState: 'empty',
          resultCount: 0,
          mergeUnique: null,
          combineSignature: null,
          connectedSourceHubIds: [],
          clearProvenance: {
            priorSourceRuns: [{ sourceHubId: sourceId, runId: 'cleared-run' }],
          },
        });
        const malformed = assessmentFor({
          hubState: 'done',
          resultCount: 1,
          mergeUnique: 1,
          // The renderer classifies a v8 pair with a non-string fingerprint as
          // invalid. Diagnostics must not use its id as correlation evidence.
          combineSignature: `8:${JSON.stringify([[sourceId, 7]])}`,
          connectedSourceHubIds: [],
        });
        assert(validSignature.startsWith('8:[[')
          && valid.includes('1/1 correlate to this source run')
          && !valid.includes('none correlate to this source run'),
        'a valid structured signature preserves delimiter-bearing source ids for exact Board correlation');
        assert(connected.includes('1/1 correlate to this source run')
          && cleared.includes('1/1 correlate to this source run')
          && !connected.includes(sourceId) && !cleared.includes(sourceId),
          'connected-edge and clear-receipt ownership paths preserve the same opaque delimiter-bearing id for correlation');
        assert(malformed.includes('1 recorded · none correlate to this source run')
          && !malformed.includes('1/1 correlate to this source run'),
        'a malformed structured signature with a non-string fingerprint cannot certify Board correlation');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { delimiterBearingId: true, connectedAndClearCorrelate: true, malformedFingerprintRejected: true };
    },
  },
  {
    name: 'Job completion assessment redacts colliding unsafe Board ids across stale, clear, taxonomy, and consumer facts',
    run: () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-completion-board-redaction-'));
      const canvas = path.join(dir, 'canvas.json');
      const sourceId = 'completion-redaction-source';
      const runId = 'completion-redaction-run';
      // These deliberately share a redaction prefix and contain imported/custom
      // punctuation that must never cross into the support-report prose.
      const staleBoardId = 'sameprefix-board/unsafe?stale';
      const clearBoardId = 'sameprefix-board/unsafe?clear';
      const unionBoardId = 'sameprefix-board/unsafe?union';
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId,
        search: telemetry.search,
        resolves: telemetry.resolves,
        scoring: telemetry.scoring,
        bucketing: telemetry.bucketing,
        pipeline: telemetry.pipeline,
        history: telemetry.history,
        preferences: telemetry.preferences,
      };
      try {
        const completedAt = Date.now();
        fs.writeFileSync(canvas, '{}', 'utf8');
        const analysis = getJobAnalysisPaths(canvas, path.join(dir, 'analysis'), sourceId);
        fs.mkdirSync(path.dirname(analysis.jsonPath), { recursive: true });
        fs.writeFileSync(analysis.jsonPath, JSON.stringify({
          runId, sourceHubId: sourceId, canvasFilePath: canvas, gatheredJobCount: 1, jobs: [{}],
        }), 'utf8');
        fs.writeFileSync(lastRunReceiptPathForCanvas(canvas, sourceId), JSON.stringify({
          runId, nodeId: sourceId, completedAt,
          terminal: { status: 'completed', outcome: 'populated', scoreReadyCount: 1 },
          cleanup: { attempted: true, cleared: true },
        }), 'utf8');
        Object.assign(telemetry, {
          nodeId: sourceId,
          search: { runId, kept: 1, bySource: {} },
          resolves: {},
          scoring: { input: 1, scored: 1, placeholders: 0, unscored: 0, failedBatches: 0 },
          bucketing: { input: 2, missing: 0, duplicated: 0 },
          pipeline: { runId, phase: 'completed' },
          history: null,
          preferences: null,
        });
        const assessment = buildJobCompletionAssessment(canvas, new Set([sourceId]), [
          {
            id: staleBoardId, hubState: 'done', resultCount: 1, mergeUnique: 1,
            combineSignature: combineSignature([{ id: sourceId, fingerprint: 'stale' }]),
            connectedSourceHubIds: [sourceId], stale: true,
          },
          {
            id: clearBoardId, hubState: 'empty', resultCount: 0, renderedCardCount: 0, mergeUnique: null,
            connectedSourceHubIds: [sourceId], stale: false,
            clearProvenance: {
              clearedAt: completedAt + 1,
              priorCombineSignature: combineSignature([{ id: sourceId, fingerprint: 'before-clear' }]),
              priorResultCount: 1,
              priorSourceRuns: [{ sourceHubId: sourceId, runId }],
            },
          },
          {
            id: unionBoardId, hubState: 'done', resultCount: 2, mergeUnique: 2, renderedCardCount: 2,
            combineSignature: combineSignature([
              { id: sourceId, fingerprint: 'current' },
              { id: 'completion-redaction-sibling', fingerprint: 'sibling' },
            ]),
            connectedSourceHubIds: [sourceId], stale: false,
          },
        ], 3, new Set([sourceId]));
        const labels = [...assessment.matchAll(/`(id…[a-f0-9]+)`/g)].map(match => match[1]);
        const clearLabel = assessment.match(/deliberately cleared: `(id…[a-f0-9]+)`/)?.[1];
        assert(assessment.includes('BOARD REFRESH REQUIRED')
          && assessment.includes('was deliberately cleared after this run')
          && assessment.includes('deliberately cleared:')
          && assessment.includes('input is Job Board')
          && ![staleBoardId, clearBoardId, unionBoardId].some(id => assessment.includes(id))
          && new Set(labels).size === 3
          && !!clearLabel
          && labels.filter(label => label === clearLabel).length >= 2,
        'one completion-wide label context redacts every unsafe Board id while retaining distinct labels and a stable clear-reference across assessment lines');
      } finally {
        Object.assign(telemetry, saved);
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return { redactedBoards: 3, stableClearLabel: true };
    },
  },
  {
    name: 'manual scraper: cooldown re-probe treats confirmed unavailable rows as recovery and preserves their counters',
    run: async () => {
      // Mock the exact shape `expandDescriptions` returns when every probe
      // listing reaches a confirmed closed/not-found detail page. No full
      // description was expanded, but this is positive terminal evidence that
      // the throttle no longer owns the request.
      const allUnavailableProbe = {
        jobs: [],
        descError: null,
        descWarning: null,
        expandedCount: 0,
        unavailableDetailDropped: 2,
      };
      assert(didDetailBlockReprobeRecover(allUnavailableProbe),
        'confirmed unavailable detail outcomes clear a cooldown block even when no description text expanded');
      const allUnavailableComposite = composeDetailBlockReprobeResult(allUnavailableProbe, {
        jobs: [], descError: null, descWarning: null, expandedCount: 0, unavailableDetailDropped: 0,
      });
      assert(allUnavailableComposite.unavailableDetailDropped === 2
        && allUnavailableComposite.expandedCount === 0
        && allUnavailableComposite.jobs.length === 0,
      'an all-unavailable probe retains its terminal removal count through the successful composite branch');

      const probe = { ...allUnavailableProbe, unavailableDetailDropped: 1 };
      const rest = {
        jobs: [{ id: 'usable-rest-row' }], descError: null, descWarning: null,
        expandedCount: 1, unavailableDetailDropped: 2,
      };
      const composite = composeDetailBlockReprobeResult(probe, rest);
      assert(composite.expandedCount === 1 && composite.unavailableDetailDropped === 3
        && composite.jobs.length === 1,
      'successful probe/rest composition sums unavailable removals instead of losing either branch');

      const ordinaryMiss = {
        jobs: [{ id: 'ambiguous-probe-row' }], descError: null,
        descWarning: { code: 'description-detail-miss' }, expandedCount: 0,
        unavailableDetailDropped: 0,
      };
      assert(!didDetailBlockReprobeRecover(ordinaryMiss),
        'an ordinary zero-description miss is not mistaken for throttle recovery');
      const blocked = composeDetailBlockReprobeResult(ordinaryMiss, null, [{ id: 'untouched-rest-row' }], 'description-rate-limited');
      assert(blocked.unavailableDetailDropped === 0
        && blocked.jobs[1]?.descriptionDeferredReason === 'description-rate-limited',
      'an ambiguous probe retains the block and defers its untouched remainder without inventing unavailable removals');
      return { unavailable: allUnavailableComposite.unavailableDetailDropped, compositeUnavailable: composite.unavailableDetailDropped };
    },
  },
  {
    name: 'issue reports redact Job Preferences and retain only safe job counts',
    run: () => {
      const secret = 'private preference text must never appear';
      const redacted = redactNodeForIssueReport({
        id: 'jobhub-private', type: 'jobhub', data: {
          jobPreferences: secret,
          activeJobPreferences: secret,
          pendingJobPreferences: secret,
          jobPreferencePlan: { general: [{ text: secret }] },
          jobPreferencesInterpretation: { summary: secret },
          preferenceEvaluation: { accepted: [{ evidence: secret }] },
          preferenceCandidatePool: [{ title: secret, description: secret }],
          scoredJobs: [{ title: secret }, { title: 'another job' }],
          hubState: 'done',
        },
      });
      const serialized = JSON.stringify(redacted);
      assert(!serialized.includes(secret), 'issue-report renderer payload never includes raw Job Preferences or candidate evidence');
      assert(redacted.data.scoredJobsCount === 2 && redacted.data.preferenceCandidatePoolCount === 1,
        'issue-report renderer payload retains safe counts for diagnostics');
    },
},
  {
    name: 'Board transaction diagnostics retain nested canvas-local connectivity without cross-level joins',
    run: () => {
      const sharedBoardId = 'same-board-id';
      const rootSourceId = 'root-source-only';
      const nestedSourceId = 'nested-source-only';
      const nestedBoard = { id: sharedBoardId, type: 'jobboard', data: { hubState: 'done', resultCount: 2 } };
      const report = buildJobBoardDiagnostics([
        { id: sharedBoardId, type: 'jobboard', data: { hubState: 'empty', resultCount: 0 } },
        { id: rootSourceId, type: 'jobhub', data: {} },
        {
          id: 'container-group', type: 'group', data: {
            canvasData: {
              nodes: [
                nestedBoard,
                { id: nestedSourceId, type: 'jobhub', data: {} },
                { id: 'nested-card', type: 'jobcard', hidden: true, data: { hubId: sharedBoardId } },
                { id: 'nested-result-group', type: 'jobgroup', data: { hubId: sharedBoardId } },
              ],
              edges: [{ id: 'nested-link', source: nestedSourceId, target: sharedBoardId }],
            },
          },
        },
      ], [{ id: 'root-link', source: rootSourceId, target: sharedBoardId }]);
      const rows = report.split('\n').filter(line => line.startsWith('- Board '));
      assert(rows.length === 2
        && rows.some(line => line.includes('scope=root') && line.includes('groups=0 · cards=0'))
        && rows.some(line => line.includes('scope=nested canvas 1 (depth 1)') && line.includes('groups=1 · cards=1 · hidden-children=1')),
      `nested Board/card/group facts must be rendered from their own canvas level, got:\n${report}`);
      const sourceLines = report.split('\n').filter(line => line.includes('  - Sources:'));
      assert(sourceLines.length === 2
        && sourceLines.some(line => line.includes('…root-sou'))
        && sourceLines.some(line => line.includes('…nested-s'))
        && sourceLines.every(line => !line.includes('…root-sou`, `…nested-s')),
      `same Board id in separate levels must not merge root/nested connections, got:\n${report}`);
      assert(!report.includes(sharedBoardId) && !report.includes(rootSourceId) && !report.includes(nestedSourceId),
        'nested diagnostics must retain the Board section’s opaque-id redaction');
      return { boards: rows.length, nestedCanvas: true };
    },
  },
  {
    name: 'Job Board report topology keeps sibling duplicate ids local and reports bounded no-Board inspection',
    run: () => {
      const duplicateBoardId = 'duplicated-imported-board';
      const topology = collectCompactJobBoardTopology([
        {
          id: 'first-group', type: 'group', data: { canvasData: {
            nodes: [
              { id: duplicateBoardId, type: 'jobboard', data: {} },
              { id: 'first-source', type: 'jobhub', data: {} },
              { id: 'first-card', type: 'jobcard', data: { hubId: duplicateBoardId } },
            ],
            edges: [{ source: duplicateBoardId, target: 'first-source' }],
          } },
        },
        {
          id: 'second-group', type: 'group', data: { canvasData: {
            nodes: [
              { id: duplicateBoardId, type: 'jobboard', data: {} },
              { id: 'second-source', type: 'jobhub', data: {} },
            ],
            edges: [{ source: duplicateBoardId, target: 'second-source' }],
          } },
        },
      ], []);
      assert(topology.boards.length === 2
        && topology.boards[0].scope !== topology.boards[1].scope
        && topology.boards[0].connectedSourceHubIds.join(',') === 'first-source'
        && topology.boards[1].connectedSourceHubIds.join(',') === 'second-source'
        && topology.boards[0].renderedCardCount === 1,
      'compact JOBS/RECOVERY Board provenance must retain sibling canvas scope and never cross-link duplicate imported ids');

      const beyondNodeBudget = Array.from({ length: 10_001 }, (_, index) => ({ id: `ordinary-${index}`, type: 'document', data: {} }));
      beyondNodeBudget.push({ id: 'late-board', type: 'jobboard', data: {} });
      const bounded = buildJobBoardDiagnostics(beyondNodeBudget, []);
      assert(bounded.includes('## Job Board Transaction & Display Diagnostics')
        && bounded.includes('Boards rendered: 0 of 0 discovered')
        && bounded.includes('node budget'),
      'a Board beyond the node budget must produce an explicit bounded FULL diagnostic rather than silently disappearing');

      const hostile = { id: 'hostile-but-valid-id', type: 'jobboard' };
      Object.defineProperty(hostile, 'data', { get: () => { throw new Error('diagnostic getter must not run'); } });
      const safeReport = buildJobBoardDiagnostics([hostile, { id: 'source', type: 'jobhub', data: {} }], [{ source: 'source', target: hostile.id }]);
      assert(safeReport.includes('state=`not retained`') && !safeReport.includes('diagnostic getter must not run'),
        'a throwing Board payload getter must omit only that Board metadata, not make the full diagnostic fail');

      const unreadableLength = new Proxy([], {
        get(target, key, receiver) {
          if (key === 'length') throw new Error('private canvas length');
          return Reflect.get(target, key, receiver);
        },
      });
      const unreadableTopology = collectCompactJobBoardTopology([
        { id: 'unreadable-group', type: 'group', data: { canvasData: { nodes: unreadableLength, edges: [] } } },
      ], []);
      assert(unreadableTopology.boards.length === 0
        && unreadableTopology.omissions.includes('unreadable canvas nodes'),
        'a proxy-backed nested canvas whose length getter throws must produce a bounded omission rather than aborting report export');

      const nestedBehindUnreadableEdges = buildJobBoardDiagnostics([
        {
          id: 'edge-hostile-group', type: 'group', data: { canvasData: {
            nodes: [{ id: 'nested-after-edge-failure', type: 'jobboard', data: { hubState: 'done' } }],
            edges: [],
          } },
        },
      ], new Proxy([], { get(target, key, receiver) {
        if (key === 'length') throw new Error('private root edge state');
        return Reflect.get(target, key, receiver);
      } }));
      assert(nestedBehindUnreadableEdges.includes('nested canvas 1 (depth 1)')
        && nestedBehindUnreadableEdges.includes('unreadable canvas edges')
        && !nestedBehindUnreadableEdges.includes('private root edge state'),
      'an unreadable parent edge collection does not suppress safe nested Board diagnostics');

      const wideCanvas = Array.from({ length: 300 }, (_, index) => ({
        id: `wide-group-${index}`, type: 'group', data: { canvasData: { nodes: [], edges: [] } },
      }));
      const wideTopology = collectCompactJobBoardTopology(wideCanvas, []);
      const wideFull = buildJobBoardDiagnostics(wideCanvas, []);
      assert(wideTopology.omissions.includes('canvas-level budget')
        && wideFull.includes('canvas-level budget'),
      'both compact and FULL walkers bound queued child canvases, not only levels eventually inspected');

      const hostileClear = new Proxy({}, {
        get() { throw new Error('private clear provenance must not escape'); },
      });
      const resilientCompletion = buildJobCompletionAssessment(null, new Set(), [{
        id: 'hostile-clear-board', clearProvenance: hostileClear,
      }], 1, new Set());
      assert(resilientCompletion.includes('## Job Completion Assessment')
        && !resilientCompletion.includes('private clear provenance must not escape'),
      'an unreadable compact clear-provenance object must be omitted locally rather than collapsing the completion assessment');

      const privateSourceHubId = 'private-combine-source-id';
      const completion = generateMarkdown({
        description: 'opaque Board provenance fixture', filterCode: 'FULL',
        filterStats: { hasJobNodes: true, hasSellNodes: false, currentNodeIds: ['opaque-board'], currentJobHubIds: [], omittedSections: [] },
        nodes: [{ id: 'opaque-board', type: 'jobboard', data: { combineSignature: `${privateSourceHubId}=private-fingerprint` } }],
        edges: [], drawings: [], frontEndState: {}, nodeInternals: [{ id: 'opaque-board', type: 'jobboard', position: {}, selected: false }], nodeComponentStates: [], eventLogs: [],
      }).markdown;
      assert(completion.includes('combineSignature: present (opaque source provenance)') && !completion.includes(privateSourceHubId),
        'Node Diagnostics must retain a Board signature presence fact without leaking source ids embedded in the serialized signature');

      const privateStalePayload = 'query=private-role&token=do-not-export';
      const staleReport = generateMarkdown({
        description: 'opaque stale reason fixture', filterCode: 'FULL',
        filterStats: { hasJobNodes: true, hasSellNodes: false, currentNodeIds: ['stale-board'], currentJobHubIds: [], omittedSections: [] },
        nodes: [{ id: 'stale-board', type: 'jobboard', data: { stale: true, staleReason: privateStalePayload } }],
        edges: [], drawings: [], frontEndState: {}, nodeInternals: [{ id: 'stale-board', type: 'jobboard', position: {}, selected: false }], nodeComponentStates: [], eventLogs: [],
      }).markdown;
      assert(staleReport.includes('staleReason: recorded (details withheld)') && !staleReport.includes(privateStalePayload),
        'an arbitrary persisted Board stale reason is reduced to a presence fact instead of exporting query/token text');

      const privateManualBoardId = 'manual-board/private?opaque';
      const manualProgress = manualAiBoardProgressForNode([{
        id: privateManualBoardId, type: 'jobboard', data: { boardScanResume: {
          phase: 'awaiting-source', selectedSearchModuleIds: ['manual-source'], completedSourceRuns: {}, activeSourceId: 'manual-source',
        } },
      }], 'manual-source');
      assert(manualProgress.includes('Board `…id`') && !manualProgress.includes(privateManualBoardId),
        'manual handoff Board context redacts custom Board ids instead of using the raw short-id formatter');
      return { compactScopes: topology.boards.length, boundedNoBoard: true, getterSafe: true, rawSignatureLeak: false, handoffBoardRedacted: true };
    },
  },
  {
    name: 'Job-link diagnostics bound cyclic, deep, and oversized renderer payloads',
    run: () => {
      const root = [{
        source: 'google', title: 'Normal listing', company: 'Acme', location: 'Toronto',
        url: 'https://www.google.com/search?htidocid=normal&token=not-exported',
      }];
      let cursor = root;
      for (let index = 0; index < 200; index++) {
        const next = [];
        cursor.push({ next });
        cursor = next;
      }
      cursor.push(root); // Explicit cycle; the walker must not recurse forever.
      root.push(...Array.from({ length: 6 }, (_, outer) => Array.from({ length: 200 }, (_, inner) => ({
        source: 'google', title: `Large listing ${outer}-${inner}`, company: 'Acme', location: 'Toronto',
        url: `https://www.google.com/search?htidocid=${outer}-${inner}&token=not-exported`,
      }))));
      const report = buildJobLinkSnapshot(root);
      assert(report.includes('## Job Listing Link Diagnostics')
        && report.includes('Normal listing')
        && report.includes('Inspection was bounded')
        && report.includes('depth budget')
        && report.includes('row budget'),
      `cyclic/deep/oversized payload must produce bounded, explicit diagnostics, got:\n${report.slice(0, 3_000)}`);
      assert(!report.includes('token='),
        'bounded link diagnostics must preserve existing URL query/token redaction');
      return { bounded: true };
    },
  },
  {
    name: 'Job-link diagnostics cover ordinary wide canvases and bound hostile arrays separately',
    run: () => {
      const ordinaryCanvas = [
        ...Array.from({ length: 292 }, (_, index) => ({
          source: 'dice', title: `Ordinary listing ${index}`, company: 'Acme', location: 'Toronto',
          url: `https://careers.example.test/jobs/${index}`,
        })),
        ...Array.from({ length: 102 }, (_, index) => ({
          id: `group-${index}`, type: 'jobgroup', data: { expanded: false },
        })),
      ];
      const ordinary = buildJobLinkSnapshot(ordinaryCanvas);
      assert(ordinary.includes('Unique job rows inspected: 292')
        && !ordinary.includes('Unique job rows inspected: 292 (bounded sample)')
        && ordinary.includes('`dice`: 292 total'),
      `a 394-node canvas with 292 cards must be fully inspected, got:\n${ordinary.slice(0, 3_000)}`);

      const hostile = Array.from({ length: 5_001 }, (_, index) => ({
        source: 'dice', title: `Hostile listing ${index}`, company: 'Acme', location: 'Toronto',
        url: `https://careers.example.test/jobs/${index}`,
      }));
      const bounded = buildJobLinkSnapshot(hostile);
      assert(bounded.includes('Unique job rows inspected: 1000 (bounded sample)')
        && bounded.includes('per-array child budget')
        && bounded.includes('row budget'),
      `a >5,000-item hostile array must be explicitly bounded, got:\n${bounded.slice(0, 3_000)}`);
      return { ordinaryNodes: ordinaryCanvas.length, ordinaryCards: 292, hostileItems: hostile.length };
    },
  },
{
    name: 'job recovery diagnostics survive restart without in-memory pipeline telemetry',
    run: () => {
      const dir = fs.mkdtempSync(path.join('/tmp', 'ic-job-recovery-report-'));
      const canvas = path.join(dir, 'canvas.json');
      const nodeId = 'recovery-hub';
      const analysisPaths = getJobAnalysisPaths(canvas, path.join(dir, 'unsaved-analysis'));
      try {
        fs.writeFileSync(path.join(dir, 'canvas.jobs-run.json'), JSON.stringify({
          runId: 'interrupted-run', stage: 'gathered', lastUpdated: 1_700_000_000_000,
          inputs: { nodeId, jobPreferences: 'private preference text must never appear' },
          sources: { google: { status: 'done' }, linkedin: { status: 'blocked' } },
        }), 'utf8');
        fs.writeFileSync(path.join(dir, 'canvas.jobs-staging.jsonl'),
          `${JSON.stringify({ sourceId: 'google', job: { title: 'must never appear' } })}\n{torn`, 'utf8');
        fs.writeFileSync(analysisPaths.jsonPath, JSON.stringify({
          runId: 'interrupted-run', sourceHubId: nodeId, canvasFilePath: canvas,
          createdAt: 1_700_000_000_100, jobs: [{ title: 'must never appear' }],
          descriptionRecoveryJobs: [{}], profile: { workHistory: [{}], skills: ['x', 'y'] },
          prompt: 'manual AI prompt must never appear', response: 'manual AI response must never appear',
          jobPreferences: 'private preference text must never appear',
        }), 'utf8');
        fs.writeFileSync(analysisPaths.lastSuccessJsonPath, JSON.stringify({
          runId: 'older-run', sourceHubId: 'deleted-hub', canvasFilePath: path.join(dir, 'other.json'),
          createdAt: 1_699_000_000_000, jobs: [{ title: 'also private' }, {}], profile: { skills: [] },
        }), 'utf8');

        const recovery = buildJobRecoverySnapshot(canvas, new Set([nodeId]));
        assert(recovery.includes('stage **gathered**')
          && recovery.includes('`google`=done, `linkedin`=blocked')
          && recovery.includes('1 parseable row(s) · 1 torn/unparseable row(s)')
          && recovery.includes('1 score-ready job(s) · 1 recovery-pool job(s)')
          && recovery.includes('hub `recovery-hub` is present in this canvas')
          && recovery.includes('Last successful saved scrape: absent · ⚠️ unowned artifact ignored'),
        'recovery diagnostics retain owned stage/source/snapshot counts and reject a legacy snapshot for another hub or canvas after restart');
        assert(!recovery.includes('must never appear') && !recovery.includes('also private'),
          'recovery diagnostics never export raw job content or Job Preferences');
        assert(!recovery.includes('manual AI prompt') && !recovery.includes('manual AI response'),
          'recovery diagnostics never export prompt or response text');

        const base = {
          description: 'Interrupted manual copy/paste job scoring.', nodes: [{ id: nodeId, type: 'jobhub', data: {} }], edges: [], drawings: [],
          frontEndState: { currentFile: canvas }, nodeInternals: [], nodeComponentStates: [], eventLogs: [],
        };
        const full = generateMarkdown({ ...base, filterCode: 'FULL' }).markdown;
        const focused = generateMarkdown({
          ...base,
          filterCode: 'RECOVERY',
          // Mirrors the renderer after RECOVERY intentionally strips nodes.
          nodes: [],
          filterStats: {
            hasJobNodes: true, hasSellNodes: false,
            currentNodeIds: [nodeId],
            omittedSections: ['nodes', 'edges', 'drawings', 'nodeInternals', 'nodeComponentStates', 'imageState', 'mediaState'],
          },
        }).markdown;
        assert(full.includes('## Job Recovery Diagnostics') && focused.includes('## Job Recovery Diagnostics')
          && focused.includes('Run manifest: parseable') && focused.includes('Current saved scrape: parseable')
          && focused.includes('hub `recovery-hub` is present in this canvas')
          && !focused.includes('⚠️ hub `recovery-hub` is not present in this canvas'),
        'FULL and filtered RECOVERY render durable recovery facts with the deep hub index even when this process has no jobs telemetry');
        return { stagedRows: 1, tornRows: 1 };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
  },
},
{
    name: 'job recovery diagnostics enumerate independently scoped hub ledgers and terminal receipts',
    run: () => {
      const dir = fs.mkdtempSync(path.join('/tmp', 'ic-scoped-job-recovery-report-'));
      const canvas = path.join(dir, 'canvas.json');
      const hubA = 'scoped-recovery-hub-a';
      const hubB = 'scoped-recovery-hub-b';
      const runPath = (kind, hubId, suffix) => {
        const scope = jobRunPathScopeForCanvas(canvas, hubId);
        return path.join(dir, `canvas.${kind}.${scope.canvasHash}.${scope.ownerHash}.${suffix}`);
      };
      const receipt = (runId, nodeId, status = 'completed') => ({
        runId, nodeId,
        startedAt: 1_700_000_000_000, completedAt: 1_700_000_001_000,
        terminal: { status, outcome: status === 'completed' ? 'populated' : 'incomplete', scoreReadyCount: 1 },
        stagingStarted: true, cleanup: { attempted: status === 'completed', cleared: status === 'completed' },
        sources: { google: { count: 1, providerGathered: 1, relevanceDropped: 0 } },
        prompt: 'PRIVATE SCOPED RECEIPT PROMPT', response: 'PRIVATE SCOPED RECEIPT RESPONSE',
      });
      try {
        fs.writeFileSync(runPath('jobs-run', hubA, 'json'), JSON.stringify({
          runId: 'scoped-run-a', stage: 'gathered', lastUpdated: 1_700_000_000_500,
          inputs: { nodeId: hubA, jobPreferences: 'PRIVATE SCOPED PREFERENCES' },
          sources: { google: { status: 'done' } },
        }), 'utf8');
        fs.writeFileSync(runPath('jobs-staging', hubA, 'jsonl'),
          `${JSON.stringify({ sourceId: 'google', job: { title: 'PRIVATE SCOPED JOB' } })}\n{torn`, 'utf8');
        fs.writeFileSync(runPath('jobs-run', hubB, 'json'), JSON.stringify({
          runId: 'scoped-run-b', stage: 'sources-ready', lastUpdated: 1_700_000_000_700,
          inputs: { nodeId: hubB }, sources: { linkedin: { status: 'blocked' } },
        }), 'utf8');
        fs.writeFileSync(runPath('jobs-last-run', hubA, 'json'), JSON.stringify(receipt('scoped-run-a', hubA)), 'utf8');
        fs.writeFileSync(runPath('jobs-last-run', hubB, 'json'), JSON.stringify(receipt('scoped-run-b', hubB, 'aborted')), 'utf8');
        const analysisA = getJobAnalysisPaths(canvas, path.join(dir, 'unsaved-analysis'), hubA);
        const analysisB = getJobAnalysisPaths(canvas, path.join(dir, 'unsaved-analysis'), hubB);
        fs.writeFileSync(analysisA.jsonPath, JSON.stringify({
          runId: 'scoped-run-a', sourceHubId: hubA, canvasFilePath: canvas, createdAt: 1_700_000_000_800,
          gatheredJobCount: 1, jobs: [{ title: 'PRIVATE SCOPED SNAPSHOT A' }], profile: { skills: ['x'] },
        }), 'utf8');
        fs.writeFileSync(analysisB.jsonPath, JSON.stringify({
          runId: 'scoped-run-b', sourceHubId: hubB, canvasFilePath: canvas, createdAt: 1_700_000_000_900,
          gatheredJobCount: 1, jobs: [{ title: 'PRIVATE SCOPED SNAPSHOT B' }], profile: { skills: ['y'] },
        }), 'utf8');
        fs.writeFileSync(analysisA.lastSuccessJsonPath, JSON.stringify({
          runId: 'scoped-success-a', sourceHubId: hubA, canvasFilePath: canvas, createdAt: 1_700_000_001_000,
          jobs: [{}], profile: {},
        }), 'utf8');
        fs.writeFileSync(analysisB.lastSuccessJsonPath, JSON.stringify({
          runId: 'scoped-success-b', sourceHubId: hubB, canvasFilePath: canvas, createdAt: 1_700_000_001_100,
          jobs: [{}], profile: {},
        }), 'utf8');

        const recovery = buildJobRecoverySnapshot(canvas, new Set([hubA, hubB]));
        assert(recovery.includes('Recovery sidecars: 2 independently owned ledger scope(s) retained')
          && recovery.includes('Run manifest 1/2: parseable · stage **gathered** · run `scoped-run-a`')
          && recovery.includes('Run manifest 2/2: parseable · stage **sources-ready** · run `scoped-run-b`')
          && recovery.includes('Staging ledger 1/2: present · 1 parseable row(s) · 1 torn/unparseable row(s)')
          && recovery.includes('Staging ledger 2/2: absent'),
        'recovery diagnostics list each scoped manifest/staging pair instead of selecting one canvas-wide owner');
        assert(recovery.includes('Terminal run receipts: 2 retained across independently recoverable Job Search hubs.')
          && recovery.includes('Terminal run receipt 1/2: ✅ completed')
          && recovery.includes('Terminal run receipt 2/2: ⏹️ aborted')
          && recovery.includes('hub `scoped-recovery-hub-a` is present in this canvas')
          && recovery.includes('hub `scoped-recovery-hub-b` is present in this canvas'),
        'recovery diagnostics retain each hub-scoped terminal receipt independently');
        assert(recovery.includes('Current saved scrapes: 2 owner-scoped bundle(s) retained; each is independently ownership-verified.')
          && recovery.includes('Current saved scrape 1/2: parseable')
          && recovery.includes('Current saved scrape 2/2: parseable')
          && recovery.includes('Last successful saved scrapes: 2 owner-scoped bundle(s) retained; each is independently ownership-verified.')
          && recovery.includes('Last successful saved scrape 1/2: parseable')
          && recovery.includes('Last successful saved scrape 2/2: parseable'),
        'recovery diagnostics enumerate each current hub’s owner-scoped current and last-success analysis metadata');
        const assessment = buildJobCompletionAssessment(canvas, new Set([hubA, hubB]));
        assert(assessment.includes('Terminal receipt: ⚠️ ambiguous across 2 current Job Search hubs')
          && assessment.includes('Saved score-ready snapshot: ambiguous terminal receipts.')
          && assessment.includes('multiple terminal receipt generations are present; no single run was selected for compact reconciliation')
          && !assessment.includes('terminal receipt is not completed')
          && !assessment.includes('DURABLE OUTPUT COMPLETE'),
        'completion assessment leaves concurrent receipts/snapshots unjoined rather than pairing arbitrary owner generations');

        fs.writeFileSync(analysisA.jsonPath, JSON.stringify({
          runId: 'conflicting-owner-run', sourceHubId: hubA, nodeId: hubB,
          canvasFilePath: canvas, jobs: [{ title: 'PRIVATE CONFLICTING OWNER' }],
        }), 'utf8');
        const conflictingOwner = buildJobRecoverySnapshot(canvas, new Set([hubA, hubB]));
        assert(conflictingOwner.includes('⚠️ unowned artifact ignored')
          && !conflictingOwner.includes('conflicting-owner-run')
          && !conflictingOwner.includes('PRIVATE CONFLICTING OWNER'),
        'a snapshot with disagreeing root owner fields is ignored rather than attributed to either hub');

        fs.writeFileSync(analysisA.jsonPath, '{malformed modern snapshot', 'utf8');
        fs.writeFileSync(analysisA.legacyCanvasJsonPath, JSON.stringify({
          runId: 'legacy-fallback-a', sourceHubId: hubA, canvasFilePath: canvas, jobs: [{}], profile: {},
        }), 'utf8');
        const malformedPrimary = buildJobRecoverySnapshot(canvas, new Set([hubA, hubB]));
        assert(malformedPrimary.includes('run `legacy-fallback-a`')
          && malformedPrimary.includes('⚠️ malformed modern artifact ignored before legacy fallback'),
        'a malformed owner-scoped primary can use an exact legacy fallback only with an explicit integrity warning');

        fs.writeFileSync(analysisB.jsonPath, JSON.stringify({
          runId: 'conflicting-canvas-run', sourceHubId: hubB, nodeId: hubB,
          canvasFilePath: canvas,
          snapshotContext: { canvasFilePath: path.join(dir, 'other-canvas.json'), sourceHubId: hubB, nodeId: hubB },
          jobs: [{ title: 'PRIVATE CONFLICTING CANVAS' }],
        }), 'utf8');
        const conflictingCanvas = buildJobRecoverySnapshot(canvas, new Set([hubA, hubB]));
        assert(conflictingCanvas.includes('⚠️ unowned artifact ignored')
          && !conflictingCanvas.includes('conflicting-canvas-run')
          && !conflictingCanvas.includes('PRIVATE CONFLICTING CANVAS'),
        'a snapshot with disagreeing root/context canvas fields is ignored rather than reported as a current hub bundle');
        for (const secret of ['PRIVATE SCOPED JOB', 'PRIVATE SCOPED PREFERENCES', 'PRIVATE SCOPED RECEIPT PROMPT', 'PRIVATE SCOPED RECEIPT RESPONSE', 'PRIVATE SCOPED SNAPSHOT A', 'PRIVATE SCOPED SNAPSHOT B']) {
          assert(!recovery.includes(secret), `scoped recovery report must redact ${secret}`);
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return { hubs: 2, receipts: 2 };
    },
  },
  {
    name: 'job recovery diagnostics inspect a shared legacy snapshot once across current Job Search hubs',
    run: () => {
      const dir = fs.mkdtempSync(path.join('/tmp', 'ic-legacy-job-recovery-report-'));
      const canvas = path.join(dir, 'canvas.json');
      const hubs = ['legacy-owner-a', 'legacy-owner-b', 'legacy-owner-c', 'legacy-owner-d', 'legacy-owner-e', 'legacy-owner-f'];
      try {
        const paths = getJobAnalysisPaths(canvas, path.join(dir, 'unsaved-analysis'), hubs[0]);
        // This path predates per-hub analysis sidecars, so every hub derives
        // the same candidate filename. Only A may own the embedded metadata.
        fs.writeFileSync(paths.legacyCanvasJsonPath, JSON.stringify({
          runId: 'legacy-owned-run', sourceHubId: hubs[0], canvasFilePath: canvas,
          createdAt: 1_700_000_000_000, gatheredJobCount: 1, jobs: [{}], profile: {},
        }), 'utf8');
        const recovery = buildJobRecoverySnapshot(canvas, new Set([...hubs, 'job-board', 'document-card']), new Set(hubs));
        const currentRows = recovery.match(/Current saved scrape(?: \d+\/\d+)?:/g) || [];
        assert(currentRows.length === 1
          && recovery.includes('Current saved scrape: parseable (legacy ownership verified)')
          && !recovery.includes('Current saved scrapes:')
          && !recovery.includes('⚠️ unowned artifact ignored'),
        'one verified legacy artifact is attributed only to its owner, not rendered as six sibling absent/unowned bundles');
        const report = generateMarkdown({
          description: 'legacy recovery sidecar attribution', filterCode: 'FULL',
          nodes: [
            ...hubs.map(id => ({ id, type: 'jobhub', data: {} })),
            { id: 'job-board', type: 'jobboard', data: {} },
            { id: 'document-card', type: 'document', data: {} },
          ],
          edges: [], drawings: [], nodeInternals: [], nodeComponentStates: [], eventLogs: [],
          frontEndState: { currentFile: canvas },
        }).markdown;
        const reportRows = report.match(/Current saved scrape(?: \d+\/\d+)?:/g) || [];
        assert(reportRows.length === 1
          && !report.includes('Current saved scrapes:')
          && !report.includes('⚠️ unowned artifact ignored'),
        'the report entry point passes only typed Job Search owners to both recovery and completion diagnostics');
        return { hubCount: hubs.length, renderedCurrentRows: currentRows.length };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
{
    name: 'job recovery diagnostics bound sidecar inspection and redact hostile snapshot run metadata',
    run: () => {
      const dir = fs.mkdtempSync(path.join('/tmp', 'ic-bounded-job-recovery-report-'));
      const canvas = path.join(dir, 'canvas.json');
      const hubId = 'bounded-recovery-hub';
      const secret = 'PRIVATE SNAPSHOT RUN https://example.test/secret\nnext-line';
      try {
        const analysis = getJobAnalysisPaths(canvas, path.join(dir, 'unsaved-analysis'), hubId);
        fs.writeFileSync(analysis.jsonPath, JSON.stringify({
          runId: secret, sourceHubId: hubId, canvasFilePath: canvas,
          createdAt: '2026-09-08T22:00:00.000Z', gatheredJobCount: 1, jobs: [{}], profile: {},
        }), 'utf8');
        // The current cap is intentionally exceeded by one ledger scope. Keep
        // the large JSONL on a retained scope so the report must take its
        // bounded-read path rather than merely omit the whole file.
        const stagingRows = `${JSON.stringify({ sourceId: 'google', job: { title: secret } })}\n`;
        for (let index = 0; index < 13; index++) {
          const scope = `bounded-scope-${String(index).padStart(2, '0')}`;
          const manifestPath = path.join(dir, `canvas.jobs-run.${scope}.json`);
          const stagingPath = path.join(dir, `canvas.jobs-staging.${scope}.jsonl`);
          fs.writeFileSync(manifestPath, JSON.stringify({
            runId: `bounded-run-${index}`, stage: 'gathered', inputs: { nodeId: hubId }, sources: {},
          }), 'utf8');
          // Newest retained stale scope wins after active hubs, so place the
          // oversized ledger on the newest scope rather than relying on a
          // lexicographic scan order. Set the timestamps explicitly because
          // Docker overlay filesystems can give rapid sequential writes the
          // same mtime, which would legitimately invoke the lexical tie-break.
          if (index === 12) fs.writeFileSync(stagingPath, stagingRows.repeat(6_000), 'utf8');
          const mtime = new Date(1_700_000_000_000 + (index * 1_000));
          fs.utimesSync(manifestPath, mtime, mtime);
          if (index === 12) fs.utimesSync(stagingPath, mtime, mtime);
        }
        const recovery = buildJobRecoverySnapshot(canvas, new Set([hubId]), new Set([hubId]));
        assert(recovery.includes('run `not recorded`')
          && !recovery.includes(secret)
          && !recovery.includes('https://example.test/secret'),
        'snapshot run metadata is allowlisted before report rendering, so a modified sidecar cannot leak prompt/URL/newline content');
        assert(recovery.includes('Recovery sidecars: 12 independently owned ledger scope(s) retained')
          && recovery.includes('1 additional recovery ledger scope(s) were not inspected (report safety limit)')
          && recovery.includes('first 256 KiB inspected;')
          && recovery.includes('later byte(s) omitted'),
        'recovery reporting caps scoped ledger rows and bounds a large JSONL inspection while disclosing both limits');

        const injectedOwner = 'HOSTILE MANIFEST OWNER\n## injected report heading';
        fs.writeFileSync(path.join(dir, `canvas.jobs-run.${hubId}.json`), JSON.stringify({
          runId: 'safe-run', stage: 'gathered', inputs: { nodeId: injectedOwner }, sources: {},
        }), 'utf8');
        fs.writeFileSync(path.join(dir, `canvas.jobs-last-run.${hubId}.json`), JSON.stringify({
          runId: 'safe-receipt', nodeId: 'different-hub', startedAt: 1_700_000_000_000, completedAt: 1_700_000_001_000,
          terminal: { status: 'completed', outcome: 'populated' }, cleanup: { attempted: true, cleared: true },
        }), 'utf8');
        const hostile = buildJobRecoverySnapshot(canvas, new Set([hubId]), new Set([hubId]));
        assert(!hostile.includes(injectedOwner)
          && !hostile.includes('injected report heading')
          && hostile.includes('manifest owner does not match the scoped artifact filename')
          && hostile.includes('receipt owner does not match the scoped artifact filename'),
        'manifest and receipt scope ownership are verified before rendering, so corrupt metadata cannot inject Markdown or impersonate another hub');

        fs.writeFileSync(path.join(dir, `canvas.jobs-run.${hubId}.json`), 'x'.repeat(600_000), 'utf8');
        const oversized = buildJobRecoverySnapshot(canvas, new Set([hubId]), new Set([hubId]));
        assert(oversized.includes('⚠️ unreadable (`TOO_LARGE`)'),
          'JSON sidecars use the same bounded regular-file reader as JSONL staging instead of synchronously parsing an unbounded manifest');

        const outside = path.join(dir, 'outside-private-data.txt');
        fs.writeFileSync(outside, 'PRIVATE SYMLINK TARGET', 'utf8');
        fs.symlinkSync(outside, path.join(dir, `canvas.jobs-staging.${hubId}.jsonl`));
        const linked = buildJobRecoverySnapshot(canvas, new Set([hubId]), new Set([hubId]));
        assert(!linked.includes('PRIVATE SYMLINK TARGET')
          && linked.includes('Staging ledger 1/12: absent'),
        'recovery discovery rejects symlinked sidecars before a report can follow an external file or block on a special file');
        return { retainedScopes: 12, omittedScopes: 1 };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'job recovery diagnostics validate ordinary roughly four MiB owner-scoped snapshots without exposing their job payload',
    run: () => {
      const dir = fs.mkdtempSync(path.join('/tmp', 'ic-normal-large-job-snapshot-'));
      const canvas = path.join(dir, 'canvas.json');
      const hubId = 'normal-large-snapshot-hub';
      const secret = 'PRIVATE NORMAL LARGE SNAPSHOT JOB PAYLOAD';
      try {
        const analysis = getJobAnalysisPaths(canvas, path.join(dir, 'unsaved-analysis'), hubId);
        const snapshot = {
          version: 2,
          createdAt: '2026-09-09T00:00:00.000Z',
          nodeId: hubId,
          sourceHubId: hubId,
          runId: 'normal-large-snapshot-run',
          canvasFilePath: canvas,
          gatheredJobCount: 12,
          sourceGatheredCount: 12,
          profile: {},
          jobs: [{ title: secret, description: 'x'.repeat(Math.floor(3.9 * 1024 * 1024)) }],
        };
        fs.writeFileSync(analysis.jsonPath, JSON.stringify(snapshot), 'utf8');
        const bytes = fs.statSync(analysis.jsonPath).size;
        assert(bytes > 3.8 * 1024 * 1024 && bytes <= 4 * 1024 * 1024,
          `fixture must exercise the bounded four MiB snapshot window, got ${bytes} bytes`);

        const recovery = buildJobRecoverySnapshot(canvas, new Set([hubId]), new Set([hubId]));
        assert(recovery.includes('Current saved scrape: parseable')
          && recovery.includes('run `normal-large-snapshot-run`')
          && recovery.includes(`hub \`${hubId}\` is present in this canvas`)
          && !recovery.includes('TOO_LARGE')
          && !recovery.includes('⚠️ unowned artifact ignored'),
        'a normal roughly four MiB owner-scoped snapshot remains parseable and ownership-verified under the bounded snapshot reader');
        assert(!recovery.includes(secret)
          && !recovery.includes('x'.repeat(120)),
        'large snapshot job content remains redacted even when the metadata reader parses it for safe counts and ownership');
        return { bytes, parseable: true, payloadRedacted: true };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'job recovery diagnostics distinguish oversized snapshots from malformed or unowned artifacts',
    run: () => {
      const dir = fs.mkdtempSync(path.join('/tmp', 'ic-oversized-job-snapshot-'));
      const canvas = path.join(dir, 'canvas.json');
      const hubId = 'oversized-snapshot-hub';
      const secret = 'PRIVATE OVERSIZED SNAPSHOT PAYLOAD';
      try {
        const analysis = getJobAnalysisPaths(canvas, path.join(dir, 'unsaved-analysis'), hubId);
        const oversized = {
          version: 2,
          createdAt: '2026-09-09T00:00:00.000Z',
          nodeId: hubId,
          sourceHubId: hubId,
          runId: 'oversized-snapshot-run',
          canvasFilePath: canvas,
          gatheredJobCount: 1,
          jobs: [{ title: secret, description: 'x'.repeat(4 * 1024 * 1024) }],
        };
        fs.writeFileSync(analysis.jsonPath, JSON.stringify(oversized), 'utf8');
        assert(fs.statSync(analysis.jsonPath).size > 4 * 1024 * 1024,
          'fixture must exceed the bounded snapshot limit');

        const tooLarge = buildJobRecoverySnapshot(canvas, new Set([hubId]), new Set([hubId]));
        assert(tooLarge.includes('⚠️ unreadable (`TOO_LARGE`)')
          && !tooLarge.includes('⚠️ unowned artifact ignored')
          && !tooLarge.includes('⚠️ malformed modern artifact ignored before legacy fallback')
          && !tooLarge.includes(secret),
        'a valid-but-oversized snapshot is stated as unverified by size, never mislabeled as malformed or unowned, and never leaks payload');

        fs.writeFileSync(analysis.jsonPath, '{malformed modern snapshot', 'utf8');
        fs.writeFileSync(analysis.legacyCanvasJsonPath, JSON.stringify({
          version: 2,
          createdAt: '2026-09-09T00:00:00.000Z',
          nodeId: hubId,
          sourceHubId: hubId,
          runId: 'legacy-valid-snapshot-run',
          canvasFilePath: canvas,
          gatheredJobCount: 1,
          jobs: [{}],
        }), 'utf8');
        const malformed = buildJobRecoverySnapshot(canvas, new Set([hubId]), new Set([hubId]));
        assert(malformed.includes('run `legacy-valid-snapshot-run`')
          && malformed.includes('⚠️ malformed modern artifact ignored before legacy fallback')
          && !malformed.includes('⚠️ unowned artifact ignored'),
        'a genuinely malformed modern snapshot remains distinguishable and may use an ownership-verified legacy fallback');
        return { oversized: true, malformedFallback: true };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'job recovery reads a validated first-property metadata envelope for oversized snapshots',
    run: () => {
      const dir = fs.mkdtempSync(path.join('/tmp', 'ic-oversized-envelope-snapshot-'));
      const canvas = path.join(dir, 'canvas.json');
      const hubId = 'envelope-snapshot-hub';
      const secondHubId = 'envelope-snapshot-invalid-hub';
      const secret = 'PRIVATE OVERSIZED ENVELOPE JOB PAYLOAD';
      const createdAt = '2026-09-13T08:00:00.000Z';
      const metadataFor = (ownerId, runId, overrides = {}) => ({
        schemaVersion: 1, createdAt, canvasFilePath: canvas, sourceHubId: ownerId, nodeId: ownerId, runId,
        gatheredJobCount: 7, candidatePoolJobCount: 9, descriptionRecoveryJobCount: 2, ...overrides,
      });
      const oversizedPayload = (metadata, { first = true, rootOverrides = {} } = {}) => {
        const root = {
          version: 2, createdAt, canvasFilePath: canvas, sourceHubId: metadata.sourceHubId, nodeId: metadata.nodeId,
          runId: metadata.runId, gatheredJobCount: metadata.gatheredJobCount,
          jobs: Array.from({ length: metadata.candidatePoolJobCount }, (_, index) => ({
            title: index === 0 ? secret : `safe row ${index}`,
            description: index === 0 ? 'x'.repeat(4 * 1024 * 1024) : '',
          })),
          descriptionRecoveryJobs: Array.from({ length: metadata.descriptionRecoveryJobCount }, () => ({})), ...rootOverrides,
        };
        return JSON.stringify(first ? { reportMetadata: metadata, ...root } : {
          version: root.version, reportMetadata: metadata, ...Object.fromEntries(Object.entries(root).filter(([key]) => key !== 'version')),
        });
      };
      const pathsFor = (ownerId) => getJobAnalysisPaths(canvas, path.join(dir, 'analysis'), ownerId);
      const writeSnapshot = (ownerId, text) => fs.writeFileSync(pathsFor(ownerId).jsonPath, text, 'utf8');
      const receiptPath = lastRunReceiptPathForCanvas(canvas, hubId);
      let originalReadSync = null;
      try {
        const metadata = metadataFor(hubId, 'envelope-valid-run');
        writeSnapshot(hubId, oversizedPayload(metadata));
        assert(fs.statSync(pathsFor(hubId).jsonPath).size > 4 * 1024 * 1024,
          'metadata-envelope fixture must exceed the legacy four MiB full-parse limit');
        fs.writeFileSync(receiptPath, JSON.stringify({
          runId: metadata.runId, nodeId: hubId,
          terminal: { status: 'completed', outcome: 'populated', scoreReadyCount: 7 },
          cleanup: { attempted: true, cleared: true },
        }), 'utf8');

        const readLengths = [];
        originalReadSync = fs.readSync;
        fs.readSync = (...args) => {
          readLengths.push(Number(args[3]) || 0);
          return originalReadSync(...args);
        };
        const recovery = buildJobRecoverySnapshot(canvas, new Set([hubId]), new Set([hubId]));
        const completion = buildJobCompletionAssessment(canvas, new Set([hubId]), [], 0, new Set([hubId]));
        fs.readSync = originalReadSync;
        originalReadSync = null;
        assert(Math.max(...readLengths) <= 16 * 1024,
          `oversized snapshot reader must request only its bounded metadata prefix, got ${Math.max(...readLengths)} bytes`);
        assert(recovery.includes('ownership-verified report metadata only (bounded prefix)')
          && recovery.includes('7 score-ready job(s) · 9 retained for preference re-evaluation')
          && recovery.includes('2 recovery-pool job(s)')
          && recovery.includes('field audit omitted (metadata-only bounded prefix)')
          && recovery.includes('run `envelope-valid-run`')
          && recovery.includes(`hub \`${hubId}\` is present in this canvas`)
          && recovery.includes('canvas matches this report')
          && !recovery.includes(secret),
        'a valid oversized writer envelope supplies exact owned counts while job payload and field audit remain omitted');
        assert(completion.includes('Saved score-ready snapshot: 7 job(s) · 9 retained for preference re-evaluation · run `envelope-valid-run`')
          && completion.includes('The saved snapshot was verified from ownership/count metadata only; its job payload was not inspected.')
          && !completion.includes(secret),
        'completion reconciliation accepts a matching metadata-only snapshot without loading job contents');

        const telemetry = getJobsTelemetry();
        const savedTelemetry = {
          nodeId: telemetry.nodeId, windowId: telemetry.windowId, pipeline: telemetry.pipeline,
          search: telemetry.search, resolves: telemetry.resolves,
        };
        try {
          Object.assign(telemetry, {
            nodeId: hubId, windowId: null, pipeline: null, resolves: {},
            search: {
              ts: Date.now(), runId: metadata.runId, queries: 1, raw: 7, deduped: 7, kept: 7,
              ageDropped: 0, roleDropped: 0, historyDropped: 0, relevanceDropped: 0, bySource: {},
            },
          });
          const pipeline = buildJobsPipelineSnapshot(new Set([hubId]), null, canvas);
          assert(pipeline.includes('ownership-verified report metadata only; snippet, salary, and field-quality audits were skipped')
            && !pipeline.includes('does not match the current search run')
            && !pipeline.includes('0 jobs — no snippet, salary, or field-quality rows to report'),
          'the live pipeline labels an owned metadata-only snapshot as intentionally unaudited, never stale or empty');

          telemetry.search = { ...telemetry.search, runId: 'stale-envelope-run' };
          const stalePipeline = buildJobsPipelineSnapshot(new Set([hubId]), null, canvas);
          assert(stalePipeline.includes('Saved scrape snapshot does not match the current search run')
            && !stalePipeline.includes('Saved scrape snapshot (current run): ownership-verified report metadata only')
            && !stalePipeline.includes(secret),
          'a metadata-only snapshot must still match the live run token before pipeline output calls it current');
        } finally {
          Object.assign(telemetry, savedTelemetry);
        }

        const boundaryOwner = `h${'x'.repeat(199)}`;
        const boundaryMetadata = metadataFor(boundaryOwner, `r${'y'.repeat(199)}`, {
          gatheredJobCount: 7, candidatePoolJobCount: 10, descriptionRecoveryJobCount: 0,
        });
        writeSnapshot(boundaryOwner, oversizedPayload(boundaryMetadata));
        const boundary = buildJobRecoverySnapshot(canvas, new Set([boundaryOwner]), new Set([boundaryOwner]));
        assert(boundary.includes('ownership-verified report metadata only (bounded prefix)')
          && boundary.includes('7 score-ready job(s) · 10 retained for preference re-evaluation')
          && !boundary.includes('report metadata envelope invalid'),
        'the metadata reader accepts the writer’s 200-character identifier boundary and valid preference-pool counts');

        writeSnapshot(hubId, oversizedPayload(metadata, { first: false }));
        const nonFirst = buildJobRecoverySnapshot(canvas, new Set([hubId]), new Set([hubId]));
        assert(nonFirst.includes('report metadata envelope not-first; oversized payload was not loaded')
          && !nonFirst.includes(secret)
          && !nonFirst.includes('unowned artifact ignored'),
        'a reportMetadata object outside the first top-level property is rejected without scanning or leaking the payload');

        writeSnapshot(hubId, oversizedPayload(metadataFor(hubId, 'malformed-envelope-run', { schemaVersion: 2 })));
        const malformed = buildJobRecoverySnapshot(canvas, new Set([hubId]), new Set([hubId]));
        assert(malformed.includes('report metadata envelope invalid; oversized payload was not loaded')
          && !malformed.includes(secret),
        'a malformed metadata schema is rejected before ownership/count diagnostics are trusted');

        writeSnapshot(hubId, oversizedPayload(metadataFor(hubId, 'impossible-count-envelope', {
          gatheredJobCount: 10, candidatePoolJobCount: 7,
        })));
        const impossibleCounts = buildJobRecoverySnapshot(canvas, new Set([hubId]), new Set([hubId]));
        assert(impossibleCounts.includes('report metadata envelope invalid; oversized payload was not loaded')
          && !impossibleCounts.includes('10 score-ready job(s)'),
        'the reader rejects a metadata envelope whose score-ready count exceeds its retained candidate pool, matching writer accounting');

        writeSnapshot(hubId, oversizedPayload(metadataFor(hubId, 'epoch-envelope', {
          createdAt: '1970-01-01T00:00:00.000Z',
        })));
        const epochEnvelope = buildJobRecoverySnapshot(canvas, new Set([hubId]), new Set([hubId]));
        assert(epochEnvelope.includes('report metadata envelope invalid; oversized payload was not loaded'),
          'the reader fail-closes epoch-zero metadata timestamps, which do not provide a recordable report age');

        const foreignMetadata = metadataFor('foreign-envelope-owner', 'foreign-envelope-run');
        writeSnapshot(hubId, oversizedPayload(foreignMetadata));
        const scopeMismatch = buildJobRecoverySnapshot(canvas, new Set([hubId]), new Set([hubId]));
        assert(scopeMismatch.includes('report metadata scope does not match this owner/canvas; oversized payload was not loaded')
          && !scopeMismatch.includes(secret)
          && !scopeMismatch.includes('unowned artifact ignored'),
        'a structurally valid envelope with mismatched owner scope is rejected explicitly, not relabeled as an unowned payload');

        const smallRoot = {
          version: 2, createdAt, canvasFilePath: canvas, sourceHubId: hubId, nodeId: hubId,
          runId: 'small-metadata-mismatch', gatheredJobCount: 1, jobs: [{}], descriptionRecoveryJobs: [],
        };
        const smallMetadata = metadataFor(hubId, 'small-metadata-mismatch');
        writeSnapshot(hubId, JSON.stringify({ reportMetadata: smallMetadata, ...smallRoot }));
        const payloadMismatch = buildJobRecoverySnapshot(canvas, new Set([hubId]), new Set([hubId]));
        assert(payloadMismatch.includes('report metadata does not match the parsed snapshot payload')
          && !payloadMismatch.includes('unowned artifact ignored'),
        'snapshots within the legacy limit remain fully parsed and cross-checked against their metadata envelope');

        const fractionalMetadata = metadataFor(hubId, 'small-fractional-created-at', {
          gatheredJobCount: 1, candidatePoolJobCount: 1, descriptionRecoveryJobCount: 0,
        });
        const fractionalRoot = {
          version: 2, createdAt: Date.parse(createdAt) + 0.5, canvasFilePath: canvas, sourceHubId: hubId, nodeId: hubId,
          runId: 'small-fractional-created-at', gatheredJobCount: 1, jobs: [{}], descriptionRecoveryJobs: [],
        };
        writeSnapshot(hubId, JSON.stringify({ reportMetadata: fractionalMetadata, ...fractionalRoot }));
        const fractionalCreatedAt = buildJobRecoverySnapshot(canvas, new Set([hubId]), new Set([hubId]));
        assert(fractionalCreatedAt.includes('report metadata does not match the parsed snapshot payload'),
          'the reader rejects fractional root timestamps even when Date serialization would round them into the envelope timestamp');

        const smallMatchingMetadata = metadataFor(hubId, 'small-nonfirst-envelope', {
          gatheredJobCount: 1, candidatePoolJobCount: 1, descriptionRecoveryJobCount: 0,
        });
        const smallMatchingRoot = {
          version: 2, createdAt, canvasFilePath: canvas, sourceHubId: hubId, nodeId: hubId,
          runId: 'small-nonfirst-envelope', gatheredJobCount: 1, jobs: [{}], descriptionRecoveryJobs: [],
        };
        writeSnapshot(hubId, JSON.stringify({
          version: 2, reportMetadata: smallMatchingMetadata,
          ...Object.fromEntries(Object.entries(smallMatchingRoot).filter(([key]) => key !== 'version')),
        }));
        const smallNonFirst = buildJobRecoverySnapshot(canvas, new Set([hubId]), new Set([hubId]));
        assert(smallNonFirst.includes('report metadata does not match the parsed snapshot payload')
          && !smallNonFirst.includes('ownership-verified report metadata only'),
        'a modern envelope is rejected when reportMetadata is not the first parsed top-level property');

        const numericMetadata = metadataFor(hubId, 'small-numeric-extension', {
          gatheredJobCount: 1, candidatePoolJobCount: 1, descriptionRecoveryJobCount: 0,
        });
        const numericRoot = {
          version: 2, createdAt, canvasFilePath: canvas, sourceHubId: hubId, nodeId: hubId,
          runId: 'small-numeric-extension', gatheredJobCount: 1, jobs: [{}], descriptionRecoveryJobs: [],
        };
        // This is the writer's physical order: reportMetadata first, followed
        // by an integer-like extension key. JSON.parse enumerates "0" first,
        // so the reader must validate raw serialized order rather than relying
        // on Object.keys(parsed)[0].
        writeSnapshot(hubId, `{"reportMetadata":${JSON.stringify(numericMetadata)},"0":"extension",${Object.entries(numericRoot).map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`).join(',')}}`);
        const numericFirst = buildJobRecoverySnapshot(canvas, new Set([hubId]), new Set([hubId]));
        assert(numericFirst.includes('Current saved scrape: parseable')
          && numericFirst.includes('run `small-numeric-extension`')
          && !numericFirst.includes('report metadata does not match the parsed snapshot payload'),
        'a writer-format snapshot with an integer-like extension key remains valid when its metadata is physically first');

        const duplicateFirstMetadata = metadataFor(hubId, 'small-duplicate-first', {
          gatheredJobCount: 1, candidatePoolJobCount: 1, descriptionRecoveryJobCount: 0,
        });
        const duplicateEffectiveMetadata = metadataFor(hubId, 'small-duplicate-effective', {
          gatheredJobCount: 1, candidatePoolJobCount: 1, descriptionRecoveryJobCount: 0,
        });
        const duplicateRoot = { ...numericRoot, runId: 'small-duplicate-effective' };
        writeSnapshot(hubId, `{"reportMetadata":${JSON.stringify(duplicateFirstMetadata)},"reportMetadata":${JSON.stringify(duplicateEffectiveMetadata)},${Object.entries(duplicateRoot).map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`).join(',')}}`);
        const duplicateMetadata = buildJobRecoverySnapshot(canvas, new Set([hubId]), new Set([hubId]));
        assert(duplicateMetadata.includes('report metadata does not match the parsed snapshot payload')
          && !duplicateMetadata.includes('run `small-duplicate-effective`'),
        'a later duplicate reportMetadata key cannot override the raw first envelope used for ownership validation');

        const legacyFallback = {
          version: 2, createdAt, canvasFilePath: canvas, sourceHubId: hubId, nodeId: hubId,
          runId: 'legacy-after-envelope-rejection', gatheredJobCount: 1, jobs: [{}], descriptionRecoveryJobs: [],
        };
        fs.writeFileSync(pathsFor(hubId).legacyCanvasJsonPath, JSON.stringify(legacyFallback), 'utf8');
        const envelopeRejectedFallback = buildJobRecoverySnapshot(canvas, new Set([hubId]), new Set([hubId]));
        assert(envelopeRejectedFallback.includes('run `legacy-after-envelope-rejection`')
          && envelopeRejectedFallback.includes('⚠️ modern report metadata envelope rejected before legacy fallback')
          && !envelopeRejectedFallback.includes('run `small-duplicate-effective`'),
        'an owned legacy fallback retains the warning that its modern primary rejected a metadata envelope');

        const validAgain = metadataFor(hubId, 'envelope-valid-again');
        writeSnapshot(hubId, oversizedPayload(validAgain));
        const nonFirstSecond = metadataFor(secondHubId, 'envelope-nonfirst-second');
        writeSnapshot(secondHubId, oversizedPayload(nonFirstSecond, { first: false }));
        const mixed = buildJobRecoverySnapshot(canvas, new Set([hubId, secondHubId]), new Set([hubId, secondHubId]));
        assert(mixed.includes('Current saved scrapes: 2 owner-scoped bundle(s) retained; at least one is unverified or invalid; see individual rows below.')
          && !mixed.includes('Current saved scrapes: 2 owner-scoped bundle(s) retained; each is independently ownership-verified.'),
        'plural recovery headings do not claim verification when an invalid oversized envelope is also listed');
      } finally {
        if (originalReadSync) fs.readSync = originalReadSync;
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return { boundedPrefixBytes: 16 * 1024, scoreReady: 7, candidatePool: 9 };
    },
  },
{
    name: 'job recovery diagnostics list bounded metadata-only description-recovery checkpoints by hub and run',
    run: () => {
      const dir = fs.mkdtempSync(path.join('/tmp', 'ic-description-recovery-checkpoints-'));
      const canvas = path.join(dir, 'canvas.json');
      const hubA = 'checkpoint-hub-a';
      const hubB = 'checkpoint-hub-b';
      const runA = 'checkpoint-run-a-123456789';
      const runB = 'checkpoint-run-b-987654321';
      const secret = 'PRIVATE CHECKPOINT JOB TEXT';
      const hostileNodeId = `checkpoint-hostile\`\n${secret}`;
      const hostileRunId = `checkpoint-hostile-run\`\n${secret}`;
      const writeCheckpoint = (hubId, runId, createdAt, jobs, recoveryJobs) => {
        const checkpointPath = getJobDescriptionRecoveryCheckpointPath(canvas, runId, path.join(dir, 'unsaved-analysis'));
        fs.writeFileSync(checkpointPath, JSON.stringify({
          version: 1, canvasFilePath: canvas, sourceHubId: hubId, nodeId: hubId, runId, createdAt,
          gatheredJobCount: jobs.length, sourceGatheredCount: jobs.length + 1,
          jobs, descriptionRecoveryJobs: recoveryJobs,
          profile: { name: secret }, prompt: secret,
        }), 'utf8');
      };
      try {
        writeCheckpoint(hubA, runA, '2026-09-05T16:00:00.000Z', [{ title: secret }, {}, {}], [{ title: secret }, {}]);
        writeCheckpoint(hubB, runB, '2026-09-05T16:05:00.000Z', [{ title: secret }], [{ title: secret }, {}, {}, {}]);
        const analysisPaths = getJobAnalysisPaths(canvas, path.join(dir, 'unsaved-analysis'));
        const prefix = `job-search-${analysisPaths.namespace}-description-recovery-`;
        fs.writeFileSync(path.join(dir, `${prefix}malformed.json`), '{not json', 'utf8');
        fs.writeFileSync(getJobDescriptionRecoveryCheckpointPath(canvas, 'checkpoint-run-ownership', path.join(dir, 'unsaved-analysis')), JSON.stringify({
          sourceHubId: hubA, nodeId: hubB, runId: 'checkpoint-run-ownership', createdAt: '2026-09-05T16:06:00.000Z', jobs: [], descriptionRecoveryJobs: [],
        }), 'utf8');
        fs.writeFileSync(getJobDescriptionRecoveryCheckpointPath(canvas, 'checkpoint-run-path-a', path.join(dir, 'unsaved-analysis')), JSON.stringify({
          sourceHubId: hubA, nodeId: hubA, runId: 'checkpoint-run-path-b', createdAt: '2026-09-05T16:07:00.000Z', jobs: [], descriptionRecoveryJobs: [],
        }), 'utf8');
        // The path hash can legitimately identify an opaque run token, and the
        // sidecar's exact ownership can match it. It still must never inject
        // new Markdown lines/backticks or private text into FULL/JOBRESOLVE.
        fs.writeFileSync(getJobDescriptionRecoveryCheckpointPath(canvas, hostileRunId, path.join(dir, 'unsaved-analysis')), JSON.stringify({
          sourceHubId: hostileNodeId, nodeId: hostileNodeId, runId: hostileRunId,
          createdAt: '2026-09-05T16:08:00.000Z', jobs: [], descriptionRecoveryJobs: [],
        }), 'utf8');

        const listed = listDescriptionRecoveryCheckpointsSync(canvas);
        assert(listed.checkpoints.length === 2 && listed.ignored.metadataInvalid === 1
          && !JSON.stringify(listed).includes(secret)
          && !JSON.stringify(listed).includes(hostileNodeId)
          && !JSON.stringify(listed).includes(hostileRunId),
        'the synchronous checkpoint metadata boundary rejects hostile ownership tokens before a report can render them');

        const recovery = buildJobRecoverySnapshot(canvas, new Set([hubA, hubB]));
        assert(recovery.includes('Description-recovery checkpoints: 2 parseable, ownership-verified checkpoint(s)')
          && recovery.includes('hub `…nt-hub-a` (present in this canvas)')
          && recovery.includes('hub `…nt-hub-b` (present in this canvas)')
          && recovery.includes('run `…23456789`')
          && recovery.includes('run `…87654321`')
          && recovery.includes('created ') && recovery.includes('updated ')
          && recovery.includes('3 score-ready job(s) · 2 recovery-pool row(s)')
          && recovery.includes('1 score-ready job(s) · 4 recovery-pool row(s)'),
        'recovery diagnostics show separate, metadata-only hub/run checkpoints with created/updated ages and safe row counts');
        assert(recovery.includes('Ignored checkpoint file(s): 1 malformed, 1 ownership-invalid, 1 path-invalid, 1 unsafe metadata')
          && !recovery.includes(secret) && !recovery.includes(hostileNodeId) && !recovery.includes(hostileRunId)
          && !recovery.includes('malformed.json'),
        'malformed, stale, and hostile checkpoint metadata are counted without exposing their content, identifiers, filenames, or paths');

        const base = {
          description: 'Google Solve says recovery checkpoint is not ready.', nodes: [{ id: hubA, type: 'jobhub', data: {} }, { id: hubB, type: 'jobhub', data: {} }], edges: [], drawings: [],
          frontEndState: { currentFile: canvas }, nodeInternals: [], nodeComponentStates: [], eventLogs: [],
        };
        const full = generateMarkdown({ ...base, filterCode: 'FULL' }).markdown;
        const jobResolve = generateMarkdown({
          ...base, filterCode: 'JOBRESOLVE', nodes: [],
          filterStats: {
            hasJobNodes: true, hasSellNodes: false, currentNodeIds: [hubA, hubB],
            omittedSections: ['nodes', 'edges', 'drawings', 'nodeInternals', 'nodeComponentStates', 'imageState', 'mediaState', 'sessionTraces', 'jobAuditDetail'],
          },
        }).markdown;
        assert(full.includes('Description-recovery checkpoints: 2 parseable')
          && jobResolve.includes('## Job Recovery Diagnostics')
          && jobResolve.includes('Description-recovery checkpoints: 2 parseable')
          && !full.includes(secret) && !jobResolve.includes(secret)
          && !full.includes(hostileNodeId) && !jobResolve.includes(hostileRunId),
        'FULL and JOBRESOLVE retain only safe checkpoint metadata even when JOBRESOLVE drops node payloads');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return { checkpoints: 2, ignored: 3 };
    },
},
{
    name: 'job recovery diagnostics bound checkpoint discovery and reject unsafe or oversized checkpoint sidecars',
    run: async () => {
      const dir = fs.mkdtempSync(path.join('/tmp', 'ic-description-recovery-safe-listing-'));
      const canvas = path.join(dir, 'canvas.json');
      const hubId = 'checkpoint-safe-hub';
      const secret = 'PRIVATE CHECKPOINT SYMLINK TARGET';
      const writeCheckpoint = (runId, createdAt = '2026-09-08T20:00:00.000Z') => {
        const checkpointPath = getJobDescriptionRecoveryCheckpointPath(canvas, runId, path.join(dir, 'unsaved-analysis'));
        fs.writeFileSync(checkpointPath, JSON.stringify({
          canvasFilePath: canvas, sourceHubId: hubId, nodeId: hubId, runId, createdAt,
          jobs: [], descriptionRecoveryJobs: [],
        }), 'utf8');
        return checkpointPath;
      };
      try {
        const secretPath = path.join(dir, 'checkpoint-secret.json');
        fs.writeFileSync(secretPath, JSON.stringify({ secret }), 'utf8');
        const unsafePath = getJobDescriptionRecoveryCheckpointPath(canvas, 'checkpoint-unsafe-run', path.join(dir, 'unsaved-analysis'));
        fs.symlinkSync(secretPath, unsafePath);
        const oversizedPath = getJobDescriptionRecoveryCheckpointPath(canvas, 'checkpoint-oversized-run', path.join(dir, 'unsaved-analysis'));
        fs.writeFileSync(oversizedPath, 'x'.repeat(513 * 1024), 'utf8');

        const unsafeListed = listDescriptionRecoveryCheckpointsSync(canvas);
        assert(unsafeListed.ignored.unsafe === 1
          && unsafeListed.ignored.oversized === 1
          && !JSON.stringify(unsafeListed).includes(secret),
        'checkpoint diagnostics only read bounded regular files without exposing symlink targets');
        const unsafeRecovery = buildJobRecoverySnapshot(canvas, new Set([hubId]));
        assert(unsafeRecovery.includes('1 over the safe metadata-read limit')
          && unsafeRecovery.includes('1 unsafe file type/read')
          && !unsafeRecovery.includes(secret),
        'the recovery report discloses unsafe/oversized checkpoint omissions without exposing a filename or private target content');
        const asyncUnsafe = await __listDescriptionRecoveryCheckpointsForTests(canvas);
        assert(asyncUnsafe.length === 0 && !JSON.stringify(asyncUnsafe).includes(secret),
          'the ordinary async recovery IPC listing applies the same no-follow and bounded-read policy as report diagnostics');

        fs.unlinkSync(unsafePath);
        fs.unlinkSync(oversizedPath);
        for (let index = 0; index < 50; index++) writeCheckpoint(`checkpoint-bounded-${index}`);
        const listed = listDescriptionRecoveryCheckpointsSync(canvas);
        const asyncListed = await __listDescriptionRecoveryCheckpointsForTests(canvas);
        assert(listed.ignored.unsafe === 0
          && listed.ignored.oversized === 0
          && listed.candidateLimitReached === true
          && listed.checkpoints.length <= 48
          && asyncListed.length <= 48,
        'checkpoint diagnostics cap matching sidecars before an abandoned recovery folder can make report assembly unbounded');

        const recovery = buildJobRecoverySnapshot(canvas, new Set([hubId]));
        assert(recovery.includes('safe matching-file limit'),
          'the recovery report discloses matching-checkpoint discovery truncation rather than silently claiming a complete listing');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return { matchingLimit: 48, unsafe: 1, oversized: 1 };
    },
},
{
    name: 'durable terminal receipt proves saved output after restart without claiming live stages',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, search: telemetry.search, resolves: telemetry.resolves,
        scoring: telemetry.scoring, bucketing: telemetry.bucketing, pipeline: telemetry.pipeline,
        history: telemetry.history,
      };
      const dir = fs.mkdtempSync(path.join('/tmp', 'ic-durable-output-restart-'));
      const canvas = path.join(dir, 'canvas.json');
      const nodeId = 'durable-restart-hub';
      const runId = 'durable-restart-run';
      const analysisPaths = getJobAnalysisPaths(canvas, path.join(dir, 'analysis'), nodeId);
      const runScope = jobRunPathScopeForCanvas(canvas, nodeId);
      const receiptPath = path.join(dir, `canvas.jobs-last-run.${runScope.canvasHash}.${runScope.ownerHash}.json`);
      try {
        fs.writeFileSync(analysisPaths.jsonPath, JSON.stringify({
          runId, sourceHubId: nodeId, canvasFilePath: canvas, createdAt: Date.now(),
          jobs: [{}, {}, {}],
        }), 'utf8');
        fs.writeFileSync(receiptPath, JSON.stringify({
          runId, nodeId, startedAt: 1_700_000_000_000, completedAt: 1_700_000_239_600,
          terminal: { status: 'completed', outcome: 'populated', scoreReadyCount: 3 },
          cleanup: { attempted: true, cleared: true },
          // A provider total is intentionally absent: the restart verdict must
          // say output is durable without pretending this proves collection.
          sources: {
            dice: { count: 3, providerGathered: 3, pagesWalked: 5, relevanceDropped: 0, stopReason: 'job-limit', cap: { type: 'jobs-per-platform', limit: 50 } },
            // A duplicate/repeated page is an incomplete walk, but is not a
            // failed HTTP page. The receipt must preserve that distinction.
            indeed: { count: 1, providerGathered: 1, relevanceDropped: 0, truncated: true, stopReason: 'no-new-rows' },
          },
        }), 'utf8');
        Object.assign(telemetry, {
          nodeId, search: null, resolves: {}, scoring: null, bucketing: null,
          pipeline: null, history: null,
        });

        const assessment = buildJobCompletionAssessment(canvas, new Set([nodeId]));
        const recovery = buildJobRecoverySnapshot(canvas, new Set([nodeId]));
        assert(assessment.includes('✅ **DURABLE OUTPUT COMPLETE**')
          && assessment.includes('Live search/scoring telemetry was not retained after restart')
          && assessment.includes('Scoring: not retained in this process.')
          && assessment.includes('Taxonomy: not retained in this process.')
          && assessment.includes('`dice` reported no candidate corpus size — coverage unproven')
          && !assessment.includes('✅ **VERIFIED COMPLETE**'),
        'same-run receipt and owned saved snapshot establish durable output only, without upgrading absent live stages to VERIFIED');
        assert(recovery.includes('Run manifest: absent — expected: a validated terminal receipt and same-run saved snapshot prove a clean prior-process finish')
          && recovery.includes('Staging ledger: absent — expected: a validated terminal receipt and same-run saved snapshot prove a clean prior-process finish')
          && recovery.includes('Jobs per platform cap 50')
          && recovery.includes('5 successfully fetched API page(s) (fan-out total)')
          && recovery.includes('walk stopped after a repeated/no-new-rows page; coverage is unproven')
          && !recovery.includes('walk truncated by a failed page')
          && recovery.includes('elapsed 4m')
          && !recovery.includes('3m60s'),
        'a validated prior-process receipt makes cleaned recovery sidecars expected and carries duration rounding into minutes');
        assert(receiptElapsed(0, 239_600) === ' · elapsed 4m'
          && receiptElapsed(null, null) === ''
          && receiptElapsed(true, 239_600) === ''
          && handoffElapsed(239_600) === '4m'
          && !handoffElapsed(239_600).includes('60s'),
        'receipt and manual-handoff duration helpers normalize rounded minute boundaries without fabricating absent receipt timing');

        const receiptWithScoring = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        receiptWithScoring.scoring = { input: 3, selected: 3, scored: 3, placeholders: 0, unscored: 0, failedBatches: 0 };
        fs.writeFileSync(receiptPath, JSON.stringify(receiptWithScoring), 'utf8');
        const withDurableScoring = buildJobCompletionAssessment(canvas, new Set([nodeId]));
        assert(withDurableScoring.includes('DURABLE OUTPUT COMPLETE')
          && withDurableScoring.includes('The receipt also retains matching final scoring counters.')
          && withDurableScoring.includes('Scoring: durable terminal receipt — input 3 → scored 3'),
        'new receipts can add run-scoped scoring evidence without making it mandatory for the legacy durable-output verdict');

        const malformedBudget = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        malformedBudget.scoring = {
          input: 4, selected: 3, scored: 3, placeholders: 0,
          unscored: 0, failedBatches: 0, cappedForBudget: 0,
        };
        fs.writeFileSync(receiptPath, JSON.stringify(malformedBudget), 'utf8');
        const budgetMismatch = buildJobCompletionAssessment(canvas, new Set([nodeId]));
        assert(budgetMismatch.includes('⚠️ **INDETERMINATE**')
          && budgetMismatch.includes('durable receipt scoring is incomplete'),
        'a retained budget cap must reconcile input = selected + capped before durable output can be green');

        const malformedPartition = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        malformedPartition.scoring = {
          input: 3, selected: 3, scored: 2, placeholders: 0,
          unscored: 0, failedBatches: 0,
        };
        fs.writeFileSync(receiptPath, JSON.stringify(malformedPartition), 'utf8');
        const partitionMismatch = buildJobCompletionAssessment(canvas, new Set([nodeId]));
        assert(partitionMismatch.includes('⚠️ **INDETERMINATE**')
          && partitionMismatch.includes('durable receipt scoring is incomplete'),
        'selected scoring input must reconcile as scored + unscored before durable output can be green');
        fs.writeFileSync(receiptPath, JSON.stringify(receiptWithScoring), 'utf8');

        fs.writeFileSync(analysisPaths.jsonPath, JSON.stringify({
          runId, sourceHubId: nodeId, canvasFilePath: canvas, createdAt: Date.now(), jobs: [{}, {}],
        }), 'utf8');
        const mismatch = buildJobCompletionAssessment(canvas, new Set([nodeId]));
        assert(mismatch.includes('⚠️ **INDETERMINATE**')
          && mismatch.includes('terminal score-ready 3 ≠ saved score-ready 2'),
        'a durable receipt/snapshot count mismatch remains indeterminate after restart');

        // A count match alone cannot make an intentionally incomplete/unknown
        // terminal result a successful score-ready output after restart.
        fs.writeFileSync(analysisPaths.jsonPath, JSON.stringify({
          runId, sourceHubId: nodeId, canvasFilePath: canvas, createdAt: Date.now(), jobs: [{}, {}, {}],
        }), 'utf8');
        for (const outcome of ['incomplete', 'unknown']) {
          const nonSuccessful = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
          nonSuccessful.terminal.outcome = outcome;
          fs.writeFileSync(receiptPath, JSON.stringify(nonSuccessful), 'utf8');
          const assessmentForOutcome = buildJobCompletionAssessment(canvas, new Set([nodeId]));
          assert(assessmentForOutcome.includes('⚠️ **INDETERMINATE**')
            && !assessmentForOutcome.includes('DURABLE OUTPUT COMPLETE'),
          `a completed ${outcome} receipt must not claim durable scored output`);
        }
      } finally {
        Object.assign(telemetry, saved);
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return { durableOutput: 3 };
    },
},
{
    name: 'durable terminal receipt reconciles signed run-scoped source recovery after restart',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, search: telemetry.search, resolves: telemetry.resolves,
        scoring: telemetry.scoring, bucketing: telemetry.bucketing, pipeline: telemetry.pipeline,
        history: telemetry.history,
      };
      const dir = fs.mkdtempSync(path.join('/tmp', 'ic-durable-recovery-receipt-'));
      const canvas = path.join(dir, 'canvas.json');
      const nodeId = 'durable-recovery-hub';
      const runId = 'durable-recovery-run';
      const analysisPaths = getJobAnalysisPaths(canvas, path.join(dir, 'analysis'));
      const receiptPath = path.join(dir, 'canvas.jobs-last-run.json');
      try {
        Object.assign(telemetry, {
          nodeId, search: null, pipeline: null, scoring: null, bucketing: null,
          history: null, resolves: { stale: { runId: 'later-run', cumulativeMergeNet: 999 } },
        });
        fs.writeFileSync(analysisPaths.jsonPath, JSON.stringify({
          runId, sourceHubId: nodeId, canvasFilePath: canvas, createdAt: Date.now(),
          jobs: Array.from({ length: 149 }, () => ({})),
        }), 'utf8');
        fs.writeFileSync(receiptPath, JSON.stringify({
          runId, nodeId, startedAt: 1_700_000_000_000, completedAt: 1_700_000_239_600,
          terminal: { status: 'completed', outcome: 'populated', scoreReadyCount: 149 },
          funnel: { raw: 200, relevanceDropped: 0, deduped: 160, ageDropped: 0, roleDropped: 11, historyDropped: 0, descriptionEvidenceDropped: 0, kept: 129 },
          recovery: { mergeNet: 20, sourceId: 'MUST NOT PERSIST', jobs: [{ title: 'MUST NOT PERSIST' }] },
          scoring: { input: 149, selected: 149, scored: 149, placeholders: 0, unscored: 0, failedBatches: 0 },
          cleanup: { attempted: true, cleared: true },
        }), 'utf8');
        const positive = buildJobCompletionAssessment(canvas, new Set([nodeId]));
        const positiveRecovery = buildJobRecoverySnapshot(canvas, new Set([nodeId]));
        assert(positive.includes('129 initial score-ready + 20 recovered = 149 terminal scoring input.')
          && positive.includes('recovery net +20')
          && positiveRecovery.includes('recovery +20 = 149 terminal scoring input')
          && !positive.includes('MUST NOT PERSIST') && !positiveRecovery.includes('MUST NOT PERSIST'),
        'a redacted +20 recovery aggregate must reconcile initial funnel and terminal scorer after restart without retaining job content');

        // Recovery is pre-preference accounting. The complete candidate pool
        // still has 149 rows, while 29 are deliberately filtered before the
        // scorer receives its 120-row subset; comparing recovery to selected
        // scorer input would falsely reject this otherwise durable run.
        fs.writeFileSync(analysisPaths.jsonPath, JSON.stringify({
          runId, sourceHubId: nodeId, canvasFilePath: canvas, createdAt: Date.now(),
          jobs: Array.from({ length: 149 }, () => ({})), gatheredJobCount: 120,
        }), 'utf8');
        fs.writeFileSync(receiptPath, JSON.stringify({
          runId, nodeId, startedAt: 1_700_000_000_000, completedAt: 1_700_000_239_600,
          terminal: { status: 'completed', outcome: 'populated', scoreReadyCount: 120 },
          funnel: { raw: 200, relevanceDropped: 0, deduped: 160, ageDropped: 0, roleDropped: 11, historyDropped: 0, descriptionEvidenceDropped: 0, kept: 129 },
          recovery: { mergeNet: 20 },
          scoring: { input: 120, selected: 120, scored: 120, placeholders: 0, unscored: 0, failedBatches: 0 },
          cleanup: { attempted: true, cleared: true },
        }), 'utf8');
        const partialPreferences = buildJobCompletionAssessment(canvas, new Set([nodeId]));
        assert(partialPreferences.includes('✅ **DURABLE OUTPUT COMPLETE**')
          && partialPreferences.includes('129 initial score-ready + 20 recovered = 149 candidate pool − 29 preference-filtered = 120 terminal scoring input.'),
        'durable recovery must state the full candidate-pool-to-preference-to-scorer arithmetic after restart');

        // A signed recovery field is a durable accounting assertion. It cannot
        // be allowed to coexist with an unrelated candidate pool and still
        // earn a green restart-only verdict merely because score-ready output
        // happened to match.
        const inconsistentRecovery = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        inconsistentRecovery.recovery = { mergeNet: 19 };
        fs.writeFileSync(receiptPath, JSON.stringify(inconsistentRecovery), 'utf8');
        const recoveryMismatch = buildJobCompletionAssessment(canvas, new Set([nodeId]));
        assert(recoveryMismatch.includes('⚠️ **INDETERMINATE**')
          && recoveryMismatch.includes('durable recovery 129 initial +19 = 148 ≠ saved preference candidate pool 149'),
        'an inconsistent durable recovery aggregate must prevent a false-green output verdict');

        fs.writeFileSync(analysisPaths.jsonPath, JSON.stringify({
          runId, sourceHubId: nodeId, canvasFilePath: canvas, createdAt: Date.now(),
          jobs: Array.from({ length: 129 }, () => ({})),
        }), 'utf8');
        fs.writeFileSync(receiptPath, JSON.stringify({
          runId, nodeId, startedAt: 1_700_000_000_000, completedAt: 1_700_000_239_600,
          terminal: { status: 'completed', outcome: 'populated', scoreReadyCount: 129 },
          funnel: { raw: 200, relevanceDropped: 0, deduped: 160, ageDropped: 0, roleDropped: 11, historyDropped: 0, descriptionEvidenceDropped: 0, kept: 149 },
          recovery: { mergeNet: -20 },
          scoring: { input: 129, selected: 129, scored: 129, placeholders: 0, unscored: 0, failedBatches: 0 },
          cleanup: { attempted: true, cleared: true },
        }), 'utf8');
        const negative = buildJobCompletionAssessment(canvas, new Set([nodeId]));
        assert(negative.includes('149 initial score-ready − 20 removed by recovery = 129 terminal scoring input.')
          && negative.includes('recovery net −20'),
        'a signed negative recovery aggregate must reconcile removals rather than being clamped to zero');
      } finally {
        Object.assign(telemetry, saved);
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return { initial: 129, recovered: 20, terminal: 149 };
    },
},
{
    name: 'failed terminal finalization retains the owned description-recovery checkpoint',
    run: async () => {
      const dir = fs.mkdtempSync(path.join('/tmp', 'ic-terminal-checkpoint-retain-'));
      const canvas = path.join(dir, 'canvas.json');
      const nodeId = 'checkpoint-retain-hub';
      const runId = 'checkpoint-retain-run';
      try {
        const created = await __createDescriptionRecoveryCheckpointForTests({
          version: 1,
          canvasFilePath: canvas,
          sourceHubId: nodeId,
          nodeId,
          runId,
          createdAt: new Date().toISOString(),
          jobs: [{ title: 'recoverable row' }],
          descriptionRecoveryJobs: [{ title: 'deferred row' }],
        });
        assert(created.saved, 'fixture creates a run-owned description-recovery checkpoint');

        // No manifest exists, so the token-scoped completion transaction fails.
        // Its checkpoint must remain loadable for the recovery path instead of
        // being retired by an unconditional terminal cleanup.
        registerJobsHandlers();
        const complete = ipcMain.__getInvokeHandler('complete-job-run');
        const sender = {
          id: 991,
          isDestroyed: () => false,
          once: () => {},
          on: () => {},
          removeListener: () => {},
        };
        const result = await complete({ sender }, {
          canvasFilePath: canvas,
          nodeId,
          runId,
          terminalStatus: 'completed',
          terminalOutcome: 'populated',
          scoreReadyCount: 1,
        });
        const retained = await __loadDescriptionRecoveryCheckpointForTests(canvas, nodeId, runId);
        assert(result.success === true && result.ok === false && result.tokenMismatch === true
          && result.checkpointCleanup?.removed === false
          && result.checkpointCleanup?.reason === 'terminal-not-finalized'
          && retained?.snapshot?.runId === runId,
        'a token/receipt failure leaves the current-run recovery checkpoint usable rather than retiring it');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return { retained: true };
    },
},
{
    name: 'job completion assessment is retained in an uncapped FULL report and reconciles recovered scoring',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search,
        resolves: telemetry.resolves, scoring: telemetry.scoring, bucketing: telemetry.bucketing,
        pipeline: telemetry.pipeline,
      };
      const dir = fs.mkdtempSync(path.join('/tmp', 'ic-job-completion-assessment-'));
      const canvas = path.join(dir, 'canvas.json');
      const nodeId = 'completion-hub';
      const runId = 'completion-run-16';
      const analysisPaths = getJobAnalysisPaths(canvas, path.join(dir, 'analysis'));
      try {
        fs.writeFileSync(analysisPaths.jsonPath, JSON.stringify({
          runId, sourceHubId: nodeId, canvasFilePath: canvas, createdAt: Date.now(),
          jobs: Array.from({ length: 16 }, () => ({})),
        }), 'utf8');
        fs.writeFileSync(path.join(dir, 'canvas.jobs-last-run.json'), JSON.stringify({
          runId, nodeId, startedAt: Date.now() - 10_000, completedAt: Date.now(),
          terminal: { status: 'completed', outcome: 'populated', scoreReadyCount: 16 }, stagingStarted: true,
          cleanup: { attempted: true, cleared: true },
          funnel: { raw: 307, deduped: 307, kept: 8, relevanceDropped: 0, ageDropped: 0, roleDropped: 0, historyDropped: 0, descriptionEvidenceDropped: 0 },
          sources: { dice: { count: 16, providerGathered: 16, stopReason: 'empty-page' } },
        }), 'utf8');
        Object.assign(telemetry, {
          nodeId, windowId: null,
          pipeline: { phase: 'completed', active: false, startedAt: Date.now() - 10_000, ts: Date.now(), runId },
          search: {
            ts: Date.now() - 9_000, queries: 1, raw: 307, deduped: 307, ageDropped: 0,
            roleDropped: 0, historyDropped: 0, relevanceDropped: 0, kept: 8, runId,
            bySource: { dice: { count: 16, providerGathered: 16, stopReason: 'empty-page' } },
            // Deliberately larger than the former clipboard cap. The full audit
            // must remain available alongside the completion assessment.
            remoteRelevance: {
              indeed: Array.from({ length: 300 }, (_, index) => ({
                title: `Cap fixture job ${index} ${'evidence '.repeat(24)}`,
                company: 'Cap Fixture Co', matched: [{ query: 'Software Architect', matchedTerms: ['software', 'architect'], requiredMatches: 2 }],
              })),
            },
          },
          resolves: {
            indeed: { ts: Date.now() - 8_000, hasMergeTelemetry: true, cumulativeMergeNet: 8, merge: { pendingBefore: 8, pendingAfter: 16 } },
          },
          scoring: { ts: Date.now() - 7_000, input: 16, selectedForScoring: 16, scored: 16, placeholders: 0, unscored: 0, batches: 2, failedBatches: 0 },
          bucketing: { ts: Date.now() - 6_000, input: 16, roleCount: 1, missing: 0, duplicated: 0, bandSummary: [], salaryRangeLabels: [], roleSummary: [], taxonomyAudit: [] },
        });

        const reportPayload = {
          description: 'Verify the whole run completed.', filterCode: 'FULL',
          filterStats: { hasJobNodes: true, hasSellNodes: false, currentNodeIds: [nodeId], omittedSections: [] },
          nodes: [{ id: nodeId, type: 'jobhub', data: {} }], edges: [], drawings: [],
          frontEndState: { currentFile: canvas }, nodeInternals: [], nodeComponentStates: [], eventLogs: [],
        };
        // The uncapped path (Save to file / no options) — the fixture's 300-row
        // remoteRelevance audit is deliberately larger than the clipboard cap,
        // and this path must keep every byte of it regardless.
        const report = generateMarkdown(reportPayload);

        assert(report.markdown.length > 50_000 && !report.hardTruncated,
          'uncapped completion assessment report exceeds the 50k clipboard ceiling without truncation');
        assert(report.markdown.includes('## Job Completion Assessment')
          && report.markdown.includes('✅ **VERIFIED COMPLETE**')
          && report.markdown.includes('8 initial score-ready + 8 recovered = 16 expected scoring input')
          && report.markdown.includes('input 16 → scored 16')
          && report.markdown.includes('terminal score-ready 16')
          && report.markdown.includes('Saved score-ready snapshot: 16 job(s)')
          && report.markdown.includes('Run correlation: ✅ pipeline + search + receipt + snapshot agree on `completion-run-16`'),
        'completion assessment reconciles search recovery, scoring, taxonomy, receipt, and saved snapshot in the full report');
        assert(report.markdown.indexOf('## Job Completion Assessment') < report.markdown.indexOf('## Job Search Pipeline')
          && report.markdown.includes('### Scoring'),
        'assessment is ordered before the long pipeline without clipping detailed scoring evidence in the uncapped report');

        // The capped path (Copy to clipboard / generate-bug-report-markdown)
        // must still surface the completion verdict even though the fixture's
        // 300-row audit forces a hard truncation — the whole point of the cap
        // is that the highest-value evidence (here, the completion verdict
        // near the top of the base) survives even when a later section doesn't.
        const capped = generateMarkdown(reportPayload, null, { maxChars: 50_000 });
        assert(capped.hardTruncated && capped.markdown.length <= 50_000,
          'completion assessment fixture must exercise the hard 50k clipboard cap');
        assert(capped.markdown.includes('## Job Completion Assessment')
          && capped.markdown.includes('✅ **VERIFIED COMPLETE**')
          && capped.markdown.includes('8 initial score-ready + 8 recovered = 16 expected scoring input')
          && capped.markdown.includes('input 16 → scored 16')
          && capped.markdown.includes('terminal score-ready 16')
          && capped.markdown.includes('Saved score-ready snapshot: 16 job(s)')
          && capped.markdown.includes('Run correlation: ✅ pipeline + search + receipt + snapshot agree on `completion-run-16`'),
        'capped completion assessment still reconciles search recovery, scoring, taxonomy, receipt, and saved snapshot before the cap');
        assert(capped.markdown.indexOf('## Job Completion Assessment') < capped.markdown.indexOf('## Job Search Pipeline'),
          'capped assessment is ordered before the long pipeline that the cap clips');

        // A current, non-stale board is part of the claimed completion only
        // when it names this source in its saved combine provenance and its
        // rendered result count still agrees with both the merge receipt and a
        // single-source run. This catches a board whose stale marker was lost
        // or whose visible cascade/count was manually changed after Combine.
        const boardComplete = generateMarkdown({
          description: 'Verify the completed source reached its current board.', filterCode: 'FULL',
          filterStats: {
            hasJobNodes: true, hasSellNodes: false, currentNodeIds: [nodeId, 'current-board'], omittedSections: [],
            jobBoardStates: [{
              id: 'current-board', hubState: 'done', resultCount: 16, mergeUnique: 16,
              combineSignature: `${nodeId}=current-fingerprint`, connectedSourceHubIds: [nodeId], stale: false,
            }],
            jobBoardStateCount: 1,
          },
          nodes: [{ id: nodeId, type: 'jobhub', data: {} }, { id: 'current-board', type: 'jobboard', data: {} }], edges: [], drawings: [],
          frontEndState: { currentFile: canvas }, nodeInternals: [], nodeComponentStates: [], eventLogs: [],
        }).markdown;
        const boardCompleteAssessment = boardComplete.slice(boardComplete.indexOf('## Job Completion Assessment'), boardComplete.indexOf('## Job Search Pipeline'));
        assert(boardCompleteAssessment.includes('✅ **VERIFIED COMPLETE**')
          && boardCompleteAssessment.includes('1/1 correlate to this source run'),
        'a non-stale single-source board with matching merge and run counts remains fully verified');

        const boardCountMismatch = generateMarkdown({
          description: 'A non-stale board has the wrong visible result count.', filterCode: 'FULL',
          filterStats: {
            hasJobNodes: true, hasSellNodes: false, currentNodeIds: [nodeId, 'count-mismatch-board'], omittedSections: [],
            jobBoardStates: [{
              id: 'count-mismatch-board', hubState: 'done', resultCount: 15, mergeUnique: 15,
              combineSignature: `${nodeId}=current-fingerprint`, connectedSourceHubIds: [nodeId], stale: false,
            }],
            jobBoardStateCount: 1,
          },
          nodes: [{ id: nodeId, type: 'jobhub', data: {} }, { id: 'count-mismatch-board', type: 'jobboard', data: {} }], edges: [], drawings: [],
          frontEndState: { currentFile: canvas }, nodeInternals: [], nodeComponentStates: [], eventLogs: [],
        }).markdown;
        const boardCountAssessment = boardCountMismatch.slice(boardCountMismatch.indexOf('## Job Completion Assessment'), boardCountMismatch.indexOf('## Job Search Pipeline'));
        assert(boardCountAssessment.includes('⚠️ **INDETERMINATE**')
          && boardCountAssessment.includes('results 15 ≠ current run 16')
          && !boardCountAssessment.includes('count-mismatch-board')
          && !boardCountAssessment.includes('✅ **VERIFIED COMPLETE**'),
        'a non-stale one-source board with a mismatched result count cannot inherit the search-only green verdict');

        const boardSourceMismatch = generateMarkdown({
          description: 'A board edge points at this run but its combine baseline does not.', filterCode: 'FULL',
          filterStats: {
            hasJobNodes: true, hasSellNodes: false, currentNodeIds: [nodeId, 'source-mismatch-board'], omittedSections: [],
            jobBoardStates: [{
              id: 'source-mismatch-board', hubState: 'done', resultCount: 16, mergeUnique: 16,
              combineSignature: 'other-source=old-fingerprint', connectedSourceHubIds: [nodeId], stale: false,
            }],
            jobBoardStateCount: 1,
          },
          nodes: [{ id: nodeId, type: 'jobhub', data: {} }, { id: 'source-mismatch-board', type: 'jobboard', data: {} }], edges: [], drawings: [],
          frontEndState: { currentFile: canvas }, nodeInternals: [], nodeComponentStates: [], eventLogs: [],
        }).markdown;
        const boardSourceAssessment = boardSourceMismatch.slice(boardSourceMismatch.indexOf('## Job Completion Assessment'), boardSourceMismatch.indexOf('## Job Search Pipeline'));
        assert(boardSourceAssessment.includes('⚠️ **INDETERMINATE**')
          && boardSourceAssessment.includes('lacks combined-source correlation for source hub')
          && !boardSourceAssessment.includes('✅ **VERIFIED COMPLETE**'),
        'a connected non-stale board whose saved combine source omits this run cannot be certified as current');

        // An empty connected board without a durable clear receipt must not be
        // treated as evidence that the finished source reached a board.
        const clearedBoard = generateMarkdown({
          description: 'A connected Job Board was explicitly cleared after this run completed.', filterCode: 'FULL',
          filterStats: {
            hasJobNodes: true, hasSellNodes: false, currentNodeIds: [nodeId, 'cleared-board'], omittedSections: [],
            jobBoardStates: [{
              id: 'cleared-board', hubState: 'empty', resultCount: 0, mergeUnique: null,
              combineSignature: null, connectedSourceHubIds: [nodeId], stale: false,
            }],
            jobBoardStateCount: 1,
          },
          nodes: [{ id: nodeId, type: 'jobhub', data: {} }, { id: 'cleared-board', type: 'jobboard', data: {} }], edges: [], drawings: [],
          frontEndState: { currentFile: canvas }, nodeInternals: [], nodeComponentStates: [], eventLogs: [],
        }).markdown;
        const clearedBoardAssessment = clearedBoard.slice(clearedBoard.indexOf('## Job Completion Assessment'), clearedBoard.indexOf('## Job Search Pipeline'));
        assert(clearedBoardAssessment.includes('⚠️ **INDETERMINATE**')
          && clearedBoardAssessment.includes('is `empty`, not done')
          && !clearedBoardAssessment.includes('cleared-board')
          && !clearedBoardAssessment.includes('✅ **VERIFIED COMPLETE**'),
        'an empty connected board without clear provenance cannot certify that the completed source remains consumed');

        const clearedAfterCompletion = generateMarkdown({
          description: 'A board that consumed this run was deliberately cleared afterwards.', filterCode: 'FULL',
          filterStats: {
            hasJobNodes: true, hasSellNodes: false, currentNodeIds: [nodeId, 'cleared-after-completion'], omittedSections: [],
            jobBoardStates: [{
              id: 'cleared-after-completion', hubState: 'empty', resultCount: 0, renderedCardCount: 0, mergeUnique: null,
              combineSignature: null, connectedSourceHubIds: [nodeId], stale: false,
              clearProvenance: {
                clearedAt: Date.now() + 60_000,
                priorCombineSignature: `${nodeId}=before-user-clear`,
                priorResultCount: 16,
                priorSourceRuns: [{ sourceHubId: nodeId, runId }],
              },
            }],
            jobBoardStateCount: 1,
          },
          nodes: [{ id: nodeId, type: 'jobhub', data: {} }, { id: 'cleared-after-completion', type: 'jobboard', data: {} }], edges: [], drawings: [],
          frontEndState: { currentFile: canvas }, nodeInternals: [], nodeComponentStates: [], eventLogs: [],
        }).markdown;
        const clearedAfterCompletionAssessment = clearedAfterCompletion.slice(clearedAfterCompletion.indexOf('## Job Completion Assessment'), clearedAfterCompletion.indexOf('## Job Search Pipeline'));
        assert(clearedAfterCompletionAssessment.includes('✅ **VERIFIED COMPLETE**')
          && clearedAfterCompletionAssessment.includes('was deliberately cleared after this run (prior results 16); its result cards are no longer present.')
          && clearedAfterCompletionAssessment.includes('deliberately cleared:')
          && !clearedAfterCompletionAssessment.includes('cleared-after-completion')
          && !clearedAfterCompletionAssessment.includes('is `empty`, not done'),
        'a non-stale empty board with post-receipt, same-hub clear provenance proves a deliberate removal instead of downgrading the completed search');

        const fallbackClearedAfterCompletion = generateMarkdown({
          description: 'A direct FULL payload keeps the bounded board-clear receipt.', filterCode: 'FULL',
          filterStats: { hasJobNodes: true, hasSellNodes: false, currentNodeIds: [nodeId, 'fallback-cleared-board'], omittedSections: [] },
          nodes: [
            { id: nodeId, type: 'jobhub', data: {} },
            {
              id: 'fallback-cleared-board', type: 'jobboard', data: {
                hubState: 'empty', resultCount: 0, stale: false,
                clearProvenance: {
                  clearedAt: Date.now() + 60_000,
                  priorCombineSignature: `${nodeId}=before-user-clear`, priorResultCount: 16,
                  priorSourceRuns: [{ sourceHubId: nodeId, runId }],
                },
              },
            },
          ],
          edges: [], drawings: [], frontEndState: { currentFile: canvas }, nodeInternals: [], nodeComponentStates: [], eventLogs: [],
        }).markdown;
        const fallbackClearAssessment = fallbackClearedAfterCompletion.slice(fallbackClearedAfterCompletion.indexOf('## Job Completion Assessment'), fallbackClearedAfterCompletion.indexOf('## Job Search Pipeline'));
        assert(fallbackClearAssessment.includes('✅ **VERIFIED COMPLETE**')
          && fallbackClearAssessment.includes('was deliberately cleared after this run')
          && !fallbackClearAssessment.includes('fallback-cleared-board'),
        'the bug-report fallback board mapping retains sanitized clear provenance and a zero rendered-card count');

        const rejectedClearProvenance = (clearProvenance) => generateMarkdown({
          description: 'Only a correlated post-completion clear receipt changes the board verdict.', filterCode: 'FULL',
          filterStats: {
            hasJobNodes: true, hasSellNodes: false, currentNodeIds: [nodeId, 'rejected-clear-receipt'], omittedSections: [],
            jobBoardStates: [{
              id: 'rejected-clear-receipt', hubState: 'empty', resultCount: 0, mergeUnique: null,
              combineSignature: null, connectedSourceHubIds: [nodeId], stale: false, clearProvenance,
            }],
            jobBoardStateCount: 1,
          },
          nodes: [{ id: nodeId, type: 'jobhub', data: {} }, { id: 'rejected-clear-receipt', type: 'jobboard', data: {} }], edges: [], drawings: [],
          frontEndState: { currentFile: canvas }, nodeInternals: [], nodeComponentStates: [], eventLogs: [],
        }).markdown;
        const tooEarlyClear = rejectedClearProvenance({
          clearedAt: 0, priorCombineSignature: `${nodeId}=old-run`, priorResultCount: 16,
          priorSourceRuns: [{ sourceHubId: nodeId, runId }],
        });
        const outOfRangeClear = rejectedClearProvenance({
          clearedAt: Number.MAX_SAFE_INTEGER, priorCombineSignature: `${nodeId}=old-run`, priorResultCount: 16,
          priorSourceRuns: [{ sourceHubId: nodeId, runId }],
        });
        const uncorrelatedClear = rejectedClearProvenance({
          clearedAt: Date.now() + 60_000, priorCombineSignature: 'other-hub=old-run', priorResultCount: 16,
          priorSourceRuns: [{ sourceHubId: 'other-hub', runId }],
        });
        const legacySameHubClear = rejectedClearProvenance({
          clearedAt: Date.now() + 60_000, priorCombineSignature: `${nodeId}=old-run`, priorResultCount: 16,
        });
        // A board can have displayed a prior run from this same hub while a
        // newer terminal receipt arrives before the stale marker renders.
        // Exact run provenance is required; a hub-only signature must not turn
        // that race into a false green completion verdict.
        const priorRunSameHubClear = rejectedClearProvenance({
          clearedAt: Date.now() + 60_000, priorCombineSignature: `${nodeId}=old-run`, priorResultCount: 16,
          priorSourceRuns: [{ sourceHubId: nodeId, runId: 'completion-run-previous' }],
        });
        const coerciveBoardCounts = generateMarkdown({
          description: 'Boolean board counts must not become a zero-card clear receipt.', filterCode: 'FULL',
          filterStats: {
            hasJobNodes: true, hasSellNodes: false, currentNodeIds: [nodeId, 'rejected-clear-receipt'], omittedSections: [],
            jobBoardStates: [{
              id: 'rejected-clear-receipt', hubState: 'empty', resultCount: false, renderedCardCount: false, mergeUnique: null,
              combineSignature: null, connectedSourceHubIds: [nodeId], stale: false,
              clearProvenance: {
                clearedAt: Date.now() + 60_000, priorCombineSignature: `${nodeId}=old-run`, priorResultCount: 16,
                priorSourceRuns: [{ sourceHubId: nodeId, runId }],
              },
            }],
            jobBoardStateCount: 1,
          },
          nodes: [{ id: nodeId, type: 'jobhub', data: {} }, { id: 'rejected-clear-receipt', type: 'jobboard', data: {} }], edges: [], drawings: [],
          frontEndState: { currentFile: canvas }, nodeInternals: [], nodeComponentStates: [], eventLogs: [],
        }).markdown;
        for (const rejected of [tooEarlyClear, outOfRangeClear, uncorrelatedClear, legacySameHubClear, priorRunSameHubClear, coerciveBoardCounts]) {
          const assessment = rejected.slice(rejected.indexOf('## Job Completion Assessment'), rejected.indexOf('## Job Search Pipeline'));
          assert(assessment.includes('⚠️ **INDETERMINATE**')
            && assessment.includes('is `empty`, not done')
            && !assessment.includes('rejected-clear-receipt')
            && !assessment.includes('deliberately cleared'),
          'a too-early/out-of-Date-range, unrelated, legacy, or prior-run clear receipt must not certify this run\'s board consumption');
        }

        const completionReceiptPath = path.join(dir, 'canvas.jobs-last-run.json');
        const validReceipt = fs.readFileSync(completionReceiptPath, 'utf8');
        try {
          fs.writeFileSync(completionReceiptPath, JSON.stringify({
            ...JSON.parse(validReceipt),
            completedAt: Number.MAX_SAFE_INTEGER,
          }), 'utf8');
          const invalidReceiptTimestamp = rejectedClearProvenance({
            clearedAt: Date.now() + 60_000, priorCombineSignature: `${nodeId}=old-run`, priorResultCount: 16,
            priorSourceRuns: [{ sourceHubId: nodeId, runId }],
          });
          const assessment = invalidReceiptTimestamp.slice(invalidReceiptTimestamp.indexOf('## Job Completion Assessment'), invalidReceiptTimestamp.indexOf('## Job Search Pipeline'));
          assert(assessment.includes('⚠️ **INDETERMINATE**')
            && assessment.includes('is `empty`, not done')
            && !assessment.includes('rejected-clear-receipt')
            && !assessment.includes('deliberately cleared'),
          'an out-of-JavaScript-Date-range receipt completion timestamp cannot certify a board clear');
        } finally {
          fs.writeFileSync(completionReceiptPath, validReceipt, 'utf8');
        }

        const staleClear = generateMarkdown({
          description: 'A stale board must still require refresh even if it has a clear receipt.', filterCode: 'FULL',
          filterStats: {
            hasJobNodes: true, hasSellNodes: false, currentNodeIds: [nodeId, 'stale-clear-receipt'], omittedSections: [],
            jobBoardStates: [{
              id: 'stale-clear-receipt', hubState: 'empty', resultCount: 0, mergeUnique: null,
              combineSignature: null, connectedSourceHubIds: [nodeId], stale: true, staleReason: 'inputs changed',
              clearProvenance: {
                clearedAt: Date.now() + 60_000,
                priorCombineSignature: `${nodeId}=before-user-clear`, priorResultCount: 16,
                priorSourceRuns: [{ sourceHubId: nodeId, runId }],
              },
            }],
            jobBoardStateCount: 1,
          },
          nodes: [{ id: nodeId, type: 'jobhub', data: {} }, { id: 'stale-clear-receipt', type: 'jobboard', data: {} }], edges: [], drawings: [],
          frontEndState: { currentFile: canvas }, nodeInternals: [], nodeComponentStates: [], eventLogs: [],
        }).markdown;
        const staleClearAssessment = staleClear.slice(staleClear.indexOf('## Job Completion Assessment'), staleClear.indexOf('## Job Search Pipeline'));
        assert(staleClearAssessment.includes('BOARD REFRESH REQUIRED')
          && !staleClearAssessment.includes('deliberately cleared'),
        'a stale board cannot be certified from clear provenance, even when it names the source and postdates completion');

        telemetry.pipeline = { ...telemetry.pipeline, runId: 'pipeline-token-mismatch' };
        const mixedRun = generateMarkdown({
          description: 'Do not combine mismatched run telemetry.', filterCode: 'FULL',
          filterStats: { hasJobNodes: true, hasSellNodes: false, currentNodeIds: [nodeId], omittedSections: [] },
          nodes: [{ id: nodeId, type: 'jobhub', data: {} }], edges: [], drawings: [],
          frontEndState: { currentFile: canvas }, nodeInternals: [], nodeComponentStates: [], eventLogs: [],
        }).markdown;
        const mixedAssessment = mixedRun.slice(mixedRun.indexOf('## Job Completion Assessment'), mixedRun.indexOf('## Job Search Pipeline'));
        assert(mixedAssessment.includes('⚠️ **INDETERMINATE**')
          && mixedAssessment.includes('run tokens disagree')
          && mixedAssessment.includes('pipeline `pipeline-token-mismatch`')
          && mixedAssessment.includes('search `completion-run-16`'),
        'completion assessment detects a pipeline/search run-token mismatch instead of borrowing the matching receipt and snapshot');
        telemetry.pipeline = { ...telemetry.pipeline, runId };

        const receiptPath = path.join(dir, 'canvas.jobs-last-run.json');
        const unclearedReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        unclearedReceipt.cleanup = { attempted: true, cleared: false };
        fs.writeFileSync(receiptPath, JSON.stringify(unclearedReceipt), 'utf8');
        const uncleared = generateMarkdown({
          description: 'Do not certify a run whose recovery cleanup failed.', filterCode: 'FULL',
          filterStats: { hasJobNodes: true, hasSellNodes: false, currentNodeIds: [nodeId], omittedSections: [] },
          nodes: [{ id: nodeId, type: 'jobhub', data: {} }], edges: [], drawings: [],
          frontEndState: { currentFile: canvas }, nodeInternals: [], nodeComponentStates: [], eventLogs: [],
        }).markdown;
        const unclearedAssessment = uncleared.slice(uncleared.indexOf('## Job Completion Assessment'), uncleared.indexOf('## Non-API AI Handoff Lifecycle'));
        assert(unclearedAssessment.includes('⚠️ **INDETERMINATE**')
          && unclearedAssessment.includes('terminal cleanup was not confirmed')
          && unclearedAssessment.includes('cleanup not confirmed')
          && !unclearedAssessment.includes('✅ **VERIFIED COMPLETE**'),
        'completion assessment never certifies a completed receipt whose recovery-sidecar cleanup was not confirmed');
        unclearedReceipt.cleanup = { attempted: true, cleared: true };
        fs.writeFileSync(receiptPath, JSON.stringify(unclearedReceipt), 'utf8');

        // A genuine zero-result run intentionally never enters scoring or the
        // Job Board's taxonomy pass.  The explicit terminal outcome, empty
        // search/recovery funnel, and run-owned empty snapshot are the evidence
        // that those stages were vacuously complete rather than forgotten.
        fs.writeFileSync(analysisPaths.jsonPath, JSON.stringify({
          runId, sourceHubId: nodeId, canvasFilePath: canvas, createdAt: Date.now(), jobs: [],
        }), 'utf8');
        fs.writeFileSync(receiptPath, JSON.stringify({
          runId, nodeId, startedAt: Date.now() - 5_000, completedAt: Date.now(),
          terminal: { status: 'completed', outcome: 'zero' }, stagingStarted: true,
          cleanup: { attempted: true, cleared: true },
          funnel: { raw: 229, deduped: 1, kept: 0, relevanceDropped: 228, ageDropped: 0, roleDropped: 1, historyDropped: 0, descriptionEvidenceDropped: 0 },
          sources: { dice: { count: 0, providerGathered: 0, stopReason: 'empty-page' } },
        }), 'utf8');
        telemetry.pipeline = { phase: 'completed', active: false, startedAt: Date.now() - 5_000, ts: Date.now(), runId };
        telemetry.search = {
          ts: Date.now() - 4_000, queries: 1, raw: 229, deduped: 1, ageDropped: 0,
          roleDropped: 1, historyDropped: 0, relevanceDropped: 228, kept: 0, runId,
          bySource: { dice: { count: 0, providerGathered: 0, stopReason: 'empty-page' } },
        };
        telemetry.resolves = {};
        telemetry.scoring = null;
        telemetry.bucketing = null;
        const zeroResult = generateMarkdown({
          description: 'Verify a completed zero-result run.', filterCode: 'FULL',
          filterStats: { hasJobNodes: true, hasSellNodes: false, currentNodeIds: [nodeId], omittedSections: [] },
          nodes: [{ id: nodeId, type: 'jobhub', data: {} }], edges: [], drawings: [],
          frontEndState: { currentFile: canvas }, nodeInternals: [], nodeComponentStates: [], eventLogs: [],
        }).markdown;
        const zeroAssessment = zeroResult.slice(zeroResult.indexOf('## Job Completion Assessment'), zeroResult.indexOf('## Job Listing Link Diagnostics'));
        assert(zeroAssessment.includes('✅ **VERIFIED COMPLETE**')
          && zeroAssessment.includes('0 initial score-ready = 0 expected scoring input')
          && zeroAssessment.includes('Scoring: not required — zero score-ready jobs.')
          && zeroAssessment.includes('Taxonomy: not required — zero scored jobs.')
          && zeroAssessment.includes('Saved score-ready snapshot: 0 job(s)')
          && zeroAssessment.includes('Run correlation: ✅ pipeline + search + receipt + snapshot agree'),
        'completion assessment verifies an explicitly completed zero-result run without impossible scoring/taxonomy telemetry');

        // A connected board that has never been combined remains in its normal
        // empty state. It has no result cascade to reconcile when this search
        // itself produced zero jobs, so its edge must not downgrade the
        // independently receipt/snapshot-proven completion.
        const zeroWithPristineBoard = generateMarkdown({
          description: 'A zero-result run does not require an untouched connected board to Combine.', filterCode: 'FULL',
          filterStats: {
            hasJobNodes: true, hasSellNodes: false, currentNodeIds: [nodeId, 'pristine-zero-board'], omittedSections: [],
            jobBoardStates: [{
              id: 'pristine-zero-board', hubState: 'empty', resultCount: 0, mergeUnique: null,
              combineSignature: null, connectedSourceHubIds: [nodeId], renderedCardCount: 0, stale: false,
            }],
            jobBoardStateCount: 1,
          },
          nodes: [{ id: nodeId, type: 'jobhub', data: {} }, { id: 'pristine-zero-board', type: 'jobboard', data: {} }], edges: [], drawings: [],
          frontEndState: { currentFile: canvas }, nodeInternals: [], nodeComponentStates: [], eventLogs: [],
        }).markdown;
        const pristineZeroAssessment = zeroWithPristineBoard.slice(zeroWithPristineBoard.indexOf('## Job Completion Assessment'), zeroWithPristineBoard.indexOf('## Job Listing Link Diagnostics'));
        assert(pristineZeroAssessment.includes('✅ **VERIFIED COMPLETE**')
          && !pristineZeroAssessment.includes('is `empty`, not done'),
        'a pristine connected Job Board does not make a fully evidenced zero-result run indeterminate');

        const zeroWithHiddenBoardCard = generateMarkdown({
          description: 'A hidden card means an empty board is not pristine.', filterCode: 'FULL',
          filterStats: {
            hasJobNodes: true, hasSellNodes: false, currentNodeIds: [nodeId, 'hidden-card-zero-board'], omittedSections: [],
            jobBoardStates: [{
              id: 'hidden-card-zero-board', hubState: 'empty', resultCount: 0, mergeUnique: null,
              combineSignature: null, connectedSourceHubIds: [nodeId], renderedCardCount: 1, stale: false,
            }],
            jobBoardStateCount: 1,
          },
          nodes: [{ id: nodeId, type: 'jobhub', data: {} }, { id: 'hidden-card-zero-board', type: 'jobboard', data: {} }], edges: [], drawings: [],
          frontEndState: { currentFile: canvas }, nodeInternals: [], nodeComponentStates: [], eventLogs: [],
        }).markdown;
        const hiddenCardZeroAssessment = zeroWithHiddenBoardCard.slice(zeroWithHiddenBoardCard.indexOf('## Job Completion Assessment'), zeroWithHiddenBoardCard.indexOf('## Job Listing Link Diagnostics'));
        assert(hiddenCardZeroAssessment.includes('⚠️ **INDETERMINATE**')
          && hiddenCardZeroAssessment.includes('is `empty`, not done')
          && !hiddenCardZeroAssessment.includes('hidden-card-zero-board'),
        'a board with hidden or orphaned cards cannot use the pristine empty-board exemption');

        const zeroWithPositiveSibling = generateMarkdown({
          description: 'A connected positive sibling means an empty board is not pristine.', filterCode: 'FULL',
          filterStats: {
            hasJobNodes: true, hasSellNodes: false, currentNodeIds: [nodeId, 'positive-sibling', 'multi-source-zero-board'], omittedSections: [],
            jobBoardStates: [{
              id: 'multi-source-zero-board', hubState: 'empty', resultCount: 0, mergeUnique: null,
              combineSignature: null, connectedSourceHubIds: [nodeId, 'positive-sibling'], renderedCardCount: 0, stale: false,
            }],
            jobBoardStateCount: 1,
          },
          nodes: [{ id: nodeId, type: 'jobhub', data: {} }, { id: 'positive-sibling', type: 'jobhub', data: {} }, { id: 'multi-source-zero-board', type: 'jobboard', data: {} }], edges: [], drawings: [],
          frontEndState: { currentFile: canvas }, nodeInternals: [], nodeComponentStates: [], eventLogs: [],
        }).markdown;
        const positiveSiblingZeroAssessment = zeroWithPositiveSibling.slice(zeroWithPositiveSibling.indexOf('## Job Completion Assessment'), zeroWithPositiveSibling.indexOf('## Job Listing Link Diagnostics'));
        assert(positiveSiblingZeroAssessment.includes('⚠️ **INDETERMINATE**')
          && positiveSiblingZeroAssessment.includes('is `empty`, not done')
          && !positiveSiblingZeroAssessment.includes('multi-source-zero-board'),
        'an uncombined positive sibling cannot be hidden behind a zero-result source exemption');

        const staleBoardResult = generateMarkdown({
          description: 'Search completed but the attached board still shows its prior run.', filterCode: 'JOBS',
          filterStats: {
            hasJobNodes: true, hasSellNodes: false, currentNodeIds: [nodeId, 'stale-board'],
            omittedSections: ['nodes', 'edges', 'drawings', 'nodeInternals', 'nodeComponentStates', 'imageState', 'mediaState'],
            jobBoardStates: [{ id: 'stale-board', hubState: 'done', resultCount: 16, stale: true, staleReason: '1 updated' }],
            jobBoardStateCount: 1,
          },
          nodes: [], edges: [], drawings: [], frontEndState: { currentFile: canvas },
          nodeInternals: [], nodeComponentStates: [], eventLogs: [],
        }).markdown;
        const staleBoardAssessment = staleBoardResult.slice(staleBoardResult.indexOf('## Job Completion Assessment'), staleBoardResult.indexOf('## Job Search Pipeline'));
        assert(staleBoardAssessment.includes('⚠️ **SEARCH COMPLETE; BOARD REFRESH REQUIRED**')
          && staleBoardAssessment.includes('1/1 stale')
          && staleBoardAssessment.includes('16 cached result(s) hidden pending board action')
          && staleBoardAssessment.includes('(1 updated)'),
        'focused JOBS reports retain compact stale-board semantics after their heavy node payload is filtered out');
        const issueReporterSource = fs.readFileSync(path.resolve('src/hooks/useIssueReporter.js'), 'utf8');
        assert(issueReporterSource.includes('jobBoardStates: allJobBoardStates.slice(0, 25)')
          && issueReporterSource.includes('jobBoardStateCount: allJobBoardStates.length')
          && issueReporterSource.includes("combineSignature: typeof safeReportField(data, 'combineSignature')")
          && issueReporterSource.includes("mergeUnique: reportBoardCount(safeReportField(safeReportField(data, 'mergeStats'), 'unique'))")
          && issueReporterSource.includes('connectedSourceHubIds:'),
        'the renderer stamps bounded board count, merge, and source-correlation facts before JOBS/RECOVERY filters remove the node payload');

        // These process-global stage records do not carry run tokens.  If an
        // older populated run left them behind, the newer explicit-zero proof
        // must still win instead of comparing 0 current jobs with stale counts.
        telemetry.scoring = { ts: Date.now() - 10_000, input: 16, selectedForScoring: 16, scored: 16, placeholders: 0, unscored: 0, batches: 2, failedBatches: 0 };
        telemetry.bucketing = { ts: Date.now() - 9_000, input: 16, roleCount: 1, missing: 0, duplicated: 0 };
        const zeroWithStaleStages = generateMarkdown({
          description: 'Do not borrow stage telemetry from the prior run.', filterCode: 'FULL',
          filterStats: { hasJobNodes: true, hasSellNodes: false, currentNodeIds: [nodeId], omittedSections: [] },
          nodes: [{ id: nodeId, type: 'jobhub', data: {} }], edges: [], drawings: [],
          frontEndState: { currentFile: canvas }, nodeInternals: [], nodeComponentStates: [], eventLogs: [],
        }).markdown;
        const staleZeroAssessment = zeroWithStaleStages.slice(zeroWithStaleStages.indexOf('## Job Completion Assessment'), zeroWithStaleStages.indexOf('## Job Listing Link Diagnostics'));
        assert(staleZeroAssessment.includes('✅ **VERIFIED COMPLETE**')
          && !staleZeroAssessment.includes('search/recovery 0 ≠ scoring input 16')
          && !staleZeroAssessment.includes('scored 16 ≠ saved score-ready 0'),
        'a current explicit-zero run ignores uncorrelated scoring/taxonomy telemetry left by a prior run');

        // Preference filtering differs from a zero-result search: the saved
        // snapshot intentionally retains its post-history candidate pool for a
        // later preference edit, while terminal score-ready count is zero.
        // Recovery diagnostics must accept the receipt and avoid falsely
        // comparing that retained pool with a scoring stage that was skipped.
        const preferenceFilteredRunId = 'completion-run-preference-filtered';
        fs.writeFileSync(analysisPaths.jsonPath, JSON.stringify({
          runId: preferenceFilteredRunId, sourceHubId: nodeId, canvasFilePath: canvas,
          createdAt: Date.now(), jobs: [{}, {}],
          preferenceEvaluation: { counts: { input: 2, accepted: 0, filtered: 2 } },
        }), 'utf8');
        fs.writeFileSync(receiptPath, JSON.stringify({
          runId: preferenceFilteredRunId, nodeId, startedAt: Date.now() - 5_000, completedAt: Date.now(),
          terminal: { status: 'completed', outcome: 'preference-filtered', scoreReadyCount: 0 }, stagingStarted: true,
          cleanup: { attempted: true, cleared: true },
          funnel: { raw: 2, deduped: 2, kept: 2, relevanceDropped: 0, ageDropped: 0, roleDropped: 0, historyDropped: 0, descriptionEvidenceDropped: 0 },
          sources: { dice: { count: 2, providerGathered: 2, stopReason: 'empty-page' } },
        }), 'utf8');
        telemetry.pipeline = { phase: 'completed', active: false, startedAt: Date.now() - 5_000, ts: Date.now(), runId: preferenceFilteredRunId };
        telemetry.search = { ts: Date.now() - 4_000, queries: 1, raw: 2, deduped: 2, ageDropped: 0, roleDropped: 0, historyDropped: 0, relevanceDropped: 0, kept: 2, runId: preferenceFilteredRunId, bySource: { dice: { count: 2, providerGathered: 2, stopReason: 'empty-page' } } };
        telemetry.resolves = {};
        const preferenceFilteredReport = generateMarkdown({
          description: 'Verify a completed preference-filtered run.', filterCode: 'FULL',
          filterStats: { hasJobNodes: true, hasSellNodes: false, currentNodeIds: [nodeId], omittedSections: [] },
          nodes: [{ id: nodeId, type: 'jobhub', data: {} }], edges: [], drawings: [],
          frontEndState: { currentFile: canvas }, nodeInternals: [], nodeComponentStates: [], eventLogs: [],
        }).markdown;
        const preferenceFilteredAssessment = preferenceFilteredReport.slice(preferenceFilteredReport.indexOf('## Job Completion Assessment'), preferenceFilteredReport.indexOf('## Job Listing Link Diagnostics'));
        assert(preferenceFilteredReport.includes('all post-history jobs filtered by Job Preferences; scoring intentionally skipped')
          && preferenceFilteredAssessment.includes('✅ **VERIFIED COMPLETE**')
          && preferenceFilteredAssessment.includes('Scoring: intentionally skipped — Job Preferences filtered every post-history candidate.')
          && preferenceFilteredAssessment.includes('Taxonomy: intentionally skipped — no preference-accepted jobs reached the board.')
          && !preferenceFilteredAssessment.includes('terminal score-ready 0 ≠ saved score-ready 2'),
        'preference-filtered receipts remain recovery-valid and reconcile their retained candidate pool without inventing a scoring mismatch');

        const preferenceFilteredWithPristineBoard = generateMarkdown({
          description: 'A preference-filtered run does not require an untouched connected board to Combine.', filterCode: 'FULL',
          filterStats: {
            hasJobNodes: true, hasSellNodes: false, currentNodeIds: [nodeId, 'pristine-preference-board'], omittedSections: [],
            jobBoardStates: [{
              id: 'pristine-preference-board', hubState: 'empty', resultCount: 0, mergeUnique: null,
              combineSignature: null, connectedSourceHubIds: [nodeId], renderedCardCount: 0, stale: false,
            }],
            jobBoardStateCount: 1,
          },
          nodes: [{ id: nodeId, type: 'jobhub', data: {} }, { id: 'pristine-preference-board', type: 'jobboard', data: {} }], edges: [], drawings: [],
          frontEndState: { currentFile: canvas }, nodeInternals: [], nodeComponentStates: [], eventLogs: [],
        }).markdown;
        const pristinePreferenceAssessment = preferenceFilteredWithPristineBoard.slice(preferenceFilteredWithPristineBoard.indexOf('## Job Completion Assessment'), preferenceFilteredWithPristineBoard.indexOf('## Job Listing Link Diagnostics'));
        assert(pristinePreferenceAssessment.includes('✅ **VERIFIED COMPLETE**')
          && !pristinePreferenceAssessment.includes('is `empty`, not done'),
        'a pristine connected board does not make a fully evidenced preference-filtered run indeterminate');

        // A preference-filtered receipt has zero score-ready jobs by design,
        // but its candidate pool is the only recovery copy of listings the
        // user may later reconsider. Do not let a truncated snapshot receive
        // the same green completion verdict merely because scoring was skipped.
        fs.writeFileSync(analysisPaths.jsonPath, JSON.stringify({
          runId: preferenceFilteredRunId, sourceHubId: nodeId, canvasFilePath: canvas,
          createdAt: Date.now(), gatheredJobCount: 0, jobs: [{}],
          preferenceEvaluation: { counts: { input: 2, accepted: 0, filtered: 2 } },
        }), 'utf8');
        const truncatedPreferenceReport = generateMarkdown({
          description: 'Detect a truncated preference candidate pool.', filterCode: 'FULL',
          filterStats: { hasJobNodes: true, hasSellNodes: false, currentNodeIds: [nodeId], omittedSections: [] },
          nodes: [{ id: nodeId, type: 'jobhub', data: {} }], edges: [], drawings: [],
          frontEndState: { currentFile: canvas }, nodeInternals: [], nodeComponentStates: [], eventLogs: [],
        }).markdown;
        const truncatedPreferenceAssessment = truncatedPreferenceReport.slice(truncatedPreferenceReport.indexOf('## Job Completion Assessment'), truncatedPreferenceReport.indexOf('## Job Listing Link Diagnostics'));
        assert(truncatedPreferenceAssessment.includes('⚠️ **INDETERMINATE**')
          && truncatedPreferenceAssessment.includes('saved preference candidate pool 1 ≠ post-history candidates 2'),
        'preference-filtered completion requires a complete retained candidate pool, without comparing it to score-ready zero');

        const jobsBackend = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
        const freshRunResetStart = jobsBackend.indexOf('// Reset per-run state at search START');
        const freshRunResetEnd = jobsBackend.indexOf('// Fresh per-source event trail for this run', freshRunResetStart);
        const freshRunReset = jobsBackend.slice(freshRunResetStart, freshRunResetEnd);
        assert(freshRunResetStart >= 0 && freshRunResetEnd > freshRunResetStart
          && freshRunReset.includes('jobsTelemetry.search = null;')
          && freshRunReset.includes('jobsTelemetry.scoring = null;')
          && freshRunReset.includes('jobsTelemetry.scoringHeartbeat = null;'),
        'a fresh search clears prior search/scoring telemetry before any await, so mid-run and zero-run FULL reports cannot mix runs');

        // Recovery can subtract as well as add. An exact description retry may
        // prove one pending listing unavailable, leaving a 3→2 scoring queue.
        // The compact assessment must use that signed renderer delta just like
        // the detailed pipeline reconciliation does.
        const subtractiveRunId = 'completion-run-subtractive-recovery';
        fs.writeFileSync(analysisPaths.jsonPath, JSON.stringify({
          runId: subtractiveRunId, sourceHubId: nodeId, canvasFilePath: canvas,
          createdAt: Date.now(), jobs: [{}, {}],
        }), 'utf8');
        fs.writeFileSync(receiptPath, JSON.stringify({
          runId: subtractiveRunId, nodeId, startedAt: Date.now() - 5_000, completedAt: Date.now(),
          terminal: { status: 'completed', outcome: 'populated', scoreReadyCount: 2 }, stagingStarted: true,
          cleanup: { attempted: true, cleared: true },
          funnel: { raw: 3, deduped: 3, kept: 3, relevanceDropped: 0, ageDropped: 0, roleDropped: 0, historyDropped: 0, descriptionEvidenceDropped: 0 },
          sources: { dice: { count: 3, providerGathered: 3, stopReason: 'empty-page' } },
        }), 'utf8');
        telemetry.pipeline = { phase: 'completed', active: false, startedAt: Date.now() - 5_000, ts: Date.now(), runId: subtractiveRunId };
        telemetry.search = {
          ts: Date.now() - 4_000, queries: 1, raw: 3, deduped: 3, ageDropped: 0,
          roleDropped: 0, historyDropped: 0, relevanceDropped: 0, kept: 3, runId: subtractiveRunId,
          bySource: { dice: { count: 3, providerGathered: 3, stopReason: 'empty-page' } },
        };
        telemetry.resolves = {
          indeed: {
            ts: Date.now() - 3_000, kind: 'description-retry', hasMergeTelemetry: true,
            cumulativeMergeNet: -1, merge: { pendingBefore: 3, pendingAfter: 2 },
          },
        };
        telemetry.scoring = { ts: Date.now() - 2_000, input: 2, selectedForScoring: 2, scored: 2, placeholders: 0, unscored: 0, batches: 1, failedBatches: 0 };
        telemetry.bucketing = { ts: Date.now() - 1_000, input: 2, roleCount: 1, missing: 0, duplicated: 0 };
        const subtractive = generateMarkdown({
          description: 'Verify recovery that removed an unavailable row.', filterCode: 'FULL',
          filterStats: { hasJobNodes: true, hasSellNodes: false, currentNodeIds: [nodeId], omittedSections: [] },
          nodes: [{ id: nodeId, type: 'jobhub', data: {} }], edges: [], drawings: [],
          frontEndState: { currentFile: canvas }, nodeInternals: [], nodeComponentStates: [], eventLogs: [],
        }).markdown;
        const subtractiveAssessment = subtractive.slice(subtractive.indexOf('## Job Completion Assessment'), subtractive.indexOf('## Job Listing Link Diagnostics'));
        assert(subtractiveAssessment.includes('✅ **VERIFIED COMPLETE**')
          && subtractiveAssessment.includes('3 initial score-ready − 1 removed by recovery = 2 expected scoring input')
          && subtractiveAssessment.includes('input 2 → scored 2'),
        'completion assessment preserves a signed recovery queue delta instead of clamping a removal to zero');

        const unrelated = generateMarkdown({
          description: 'Do not borrow another canvas run.', filterCode: 'FULL',
          // A filtered report carries this deep id index even after its nodes
          // are stripped. An empty index must not inherit process-global jobs
          // telemetry from completion-hub.
          filterStats: { hasJobNodes: true, hasSellNodes: false, currentNodeIds: [], omittedSections: ['nodes'] },
          nodes: [], edges: [], drawings: [], frontEndState: { currentFile: canvas },
          nodeInternals: [], nodeComponentStates: [], eventLogs: [],
        }).markdown;
        const assessment = unrelated.slice(unrelated.indexOf('## Job Completion Assessment'), unrelated.indexOf('## Non-API AI Handoff Lifecycle'));
        assert(assessment.includes('⚠️ **INDETERMINATE**')
          && assessment.includes('Scoring: not retained in this process.')
          && !assessment.includes('input 16 → scored 16'),
        'completion assessment refuses process-global live telemetry when the report has no matching hub id');
      } finally {
        Object.assign(telemetry, saved);
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return { scored: 16, recovered: 8 };
    },
  },
{
    name: 'job recovery diagnostics retain a redacted prior-process terminal receipt and call absence unknown',
    run: () => {
      const telemetry = getJobsTelemetry();
      const savedPipeline = telemetry.pipeline;
      const dir = fs.mkdtempSync(path.join('/tmp', 'ic-job-last-run-receipt-'));
      const canvas = path.join(dir, 'canvas.json');
      const nodeId = 'receipt-hub';
      const receiptPath = path.join(dir, 'canvas.jobs-last-run.json');
      try {
        // Simulate a fresh Electron process: no in-memory pipeline telemetry is
        // available, while the compact terminal receipt survives its predecessor.
        telemetry.pipeline = null;
        fs.writeFileSync(receiptPath, JSON.stringify({
          runId: 'prior-run-42', nodeId,
          startedAt: 1_700_100_000_000, completedAt: 1_700_100_093_000,
          terminal: { status: 'completed', outcome: 'populated' },
          stagingStarted: true, cleanup: { attempted: true, cleared: true },
          funnel: {
            raw: 13, relevanceDropped: 2, deduped: 11, ageDropped: 4,
            roleDropped: 2, historyDropped: 1, descriptionEvidenceDropped: 0, kept: 4,
          },
          sources: {
            google: {
              count: 11, providerGathered: 13, relevanceDropped: 2,
              stopReason: 'end-of-results',
              revealOutcomes: [{
                queryIndex: 1, queryTotal: 1, exit: 'end-of-list', count: 191, iterations: 29,
                query: 'PRIVATE QUERY', url: 'https://private.example/?token=SECRET_URL_TOKEN',
              }],
              warning: { code: 'rate-limit', severity: 'block', evidence: 'PRIVATE WARNING EVIDENCE' },
              url: 'https://private.example/?token=SECRET_URL_TOKEN',
              jobs: [{ title: 'PRIVATE JOB TITLE' }],
            },
          },
          queries: ['PRIVATE QUERY'],
          profile: { name: 'PRIVATE PROFILE' },
          prompt: 'PRIVATE PROMPT', response: 'PRIVATE RESPONSE', error: 'PRIVATE ERROR BODY',
        }), 'utf8');

        const recovery = buildJobRecoverySnapshot(canvas, new Set([nodeId]));
        assert(recovery.includes('Last terminal run receipt: ✅ completed')
          // States the OBSERVATION (no live phase could be correlated), not the
          // inference that the receipt came from an earlier process — which was
          // provably false whenever several live hubs made the funnel accessor
          // fail closed on runs that had just finished in THIS process.
          && recovery.includes('receipt not correlated to a live run — no live pipeline telemetry was attributable in this process')
          && !recovery.includes('previous-process receipt')
          && recovery.includes('Initial-search funnel: 13 raw → 11 deduped → 4 kept')
          && recovery.includes('`google`: 13 candidate identities traversed → 11 usable row(s) retained')
          && recovery.includes('warning rate-limit (block)')
          && recovery.includes('`google` scroll reveal: q1/1 191 card(s) after 29 reveal pass(es) — board end marker reached')
          && recovery.includes('✅ every query reached the board end marker'),
        'a prior-process receipt preserves terminal status, timing/funnel, source warning codes, and provenance');
        for (const secret of ['PRIVATE WARNING EVIDENCE', 'SECRET_URL_TOKEN', 'PRIVATE JOB TITLE', 'PRIVATE QUERY', 'PRIVATE PROFILE', 'PRIVATE PROMPT', 'PRIVATE RESPONSE', 'PRIVATE ERROR BODY']) {
          assert(!recovery.includes(secret), `terminal receipt must redact ${secret}`);
        }

        const base = {
          description: 'Did the previous search complete?', nodes: [{ id: nodeId, type: 'jobhub', data: {} }], edges: [], drawings: [],
          frontEndState: { currentFile: canvas }, nodeInternals: [], nodeComponentStates: [], eventLogs: [],
        };
        const full = generateMarkdown({ ...base, filterCode: 'FULL' }).markdown;
        const focused = generateMarkdown({
          ...base,
          filterCode: 'RECOVERY', nodes: [],
          filterStats: {
            hasJobNodes: true, hasSellNodes: false, currentNodeIds: [nodeId],
            omittedSections: ['nodes', 'edges', 'drawings', 'nodeInternals', 'nodeComponentStates', 'imageState', 'mediaState'],
          },
        }).markdown;
        assert(full.includes('Last terminal run receipt: ✅ completed')
          && focused.includes('Last terminal run receipt: ✅ completed')
          && focused.includes('hub `receipt-hub` is present in this canvas'),
        'FULL and RECOVERY retain the durable terminal receipt after a simulated restart');
        assert(full.includes('Detailed live per-job evidence appears in Job Search Pipeline only when retained in this process.'),
          'restart diagnostics clarify that live per-job pipeline evidence is process-retained, not durable receipt data');

        fs.unlinkSync(receiptPath);
        const absent = buildJobRecoverySnapshot(canvas, new Set([nodeId]));
        assert(absent.includes('Last terminal run receipt: absent') && absent.includes('completion of any prior-process run is **unknown**'),
          'missing durable receipt explicitly leaves prior-process completion unknown');
      } finally {
        telemetry.pipeline = savedPipeline;
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return { ok: true };
    },
  },
{
    name: 'FULL and JOBLINK reports expose broken Google URL shapes without query values',
    run: () => {
      const legacyUrl = 'https://www.google.com/search?ibp=htl;jobs&q&htidocid=SecretOpaqueId%3D%3D#fpstate=tldetail&htivrt=jobs&htiq';
      const jobData = {
        source: 'google', title: 'AI Platform Architect', company: 'Aalo Atomics', location: 'Austin, TX',
        url: legacyUrl, matchScore: 70,
      };
      const directWithBlankRawQuery = {
        source: 'google', title: 'Healthy Direct Link', company: 'Acme', location: 'Toronto, ON',
        url: 'https://careers.example.test/job/healthy',
        googleCardUrl: 'https://www.google.com/search?ibp=htl;jobs&q&htidocid=HealthyDirectId',
      };
      const missingDirect = {
        source: 'google', title: 'Missing Direct Link', company: 'Peraton', location: 'Virginia', url: '',
        googleCardUrl: 'https://www.google.com/search?ibp=htl;jobs&q&htidocid=MissingDirectId',
      };
      const trulyMissing = {
        source: 'google', title: 'Truly Missing Link', company: 'No Link', location: 'Anywhere', url: '', googleCardUrl: '',
      };
      const nodes = [
        { id: 'job-card', type: 'jobcard', data: jobData },
        { id: 'board', type: 'jobboard', data: { results: [{ ...jobData }] } },
        { id: 'direct-card', type: 'jobcard', data: directWithBlankRawQuery },
        { id: 'missing-card', type: 'jobcard', data: missingDirect },
        { id: 'truly-missing-card', type: 'jobcard', data: trulyMissing },
      ];
      const base = {
        description: 'Google listing links open a broken page.', nodes, edges: [], drawings: [],
        frontEndState: {},
        nodeInternals: nodes.filter(node => node.type === 'jobcard').map(node => ({
          id: node.id, type: node.type, position: { x: 0, y: 0 }, selected: false,
        })),
        nodeComponentStates: [], eventLogs: [],
      };
      const full = generateMarkdown({ ...base, filterCode: 'FULL' }).markdown;
      const nodeSection = full.split('## Node Diagnostics')[1]?.split('\n## ')[0] || '';
      assert(nodeSection.includes('link: Google fallback')
        && nodeSection.includes('link: direct')
        && nodeSection.includes('link: missing')
        && !nodeSection.includes('SecretOpaqueId')
        && !nodeSection.includes('MissingDirectId'),
      'Node Diagnostics reports the effective job-card link state without exposing raw Google-card tokens');
      const focused = generateMarkdown({
        ...base,
        filterCode: 'JOBLINK',
        filterStats: { hasJobNodes: true, hasSellNodes: false, currentNodeIds: nodes.map(node => node.id), omittedSections: ['edges', 'drawings', 'nodeInternals', 'nodeComponentStates', 'imageState', 'mediaState'] },
      }).markdown;
      for (const report of [full, focused]) {
        const section = report.split('## Job Listing Link Diagnostics')[1]?.split('\n## ')[0] || '';
        assert(section.includes('Unique job rows inspected: 4')
          && section.includes('1 internal Google route(s) exposed as public')
          && section.includes('1 direct Apply-on URL(s)')
          && section.includes('2 missing direct Apply-on URL(s) (1 retain a Google identity fallback)')
          && section.includes('3 legacy `ibp=htl;jobs`')
          && section.includes('3 blank raw search query')
          && section.includes('"Missing Direct Link"')
          && section.includes('public=missing-direct (Google fallback available)')
          && !section.includes('"Healthy Direct Link"'),
        'FULL/JOBLINK must surface the structural Google link defect and dedupe card/board copies');
        assert(!section.includes('SecretOpaqueId'),
          'job-link diagnostics must never export opaque query/fragment values');
      }
      return { unique: 4, blankQuery: 3 };
    },
  },
{
    name: 'Bug report exports keep every routine node diagnostic row',
    run: () => {
      const nodes = Array.from({ length: 20 }, (_, index) => ({
        id: `card${String(index).padStart(4, '0')}`, type: 'jobcard', data: {},
      }));
      const nodeInternals = nodes.map(node => ({
        id: node.id, type: node.type, position: { x: 0, y: 0 },
        measured: { width: 240, height: 100 },
      }));
      const payload = {
        description: 'Node export fidelity fixture.', nodes, edges: [], drawings: [],
        frontEndState: {}, nodeInternals,
        // Expanded score disclosures are deliberate audit state and remain in
        // the complete node inventory.
        nodeComponentStates: [
          { id: 'card0017', reasoningExpanded: true },
          { id: 'card0018', scoreAuditExpanded: true },
          { id: 'card0019', compensationExpanded: true },
        ],
        eventLogs: [],
      };
      const fileReport = generateMarkdown(payload).markdown;
      assert(nodes.every(node => fileReport.includes(`| \`${node.id}\``))
        && !fileReport.includes('routine jobcard row(s) omitted'),
      'Save to file retains every routine jobcard row with no omission footer');

      // Clipboard generation (maxChars set) samples ROUTINE_JOBCARD_CAP=15
      // routine cards and omits the rest — a collapsed cascade spawns hundreds
      // of hidden-by-default routine cards, and without this cap they alone
      // can consume the whole clipboard budget before the far more valuable
      // logs/event history ever render. Anomalous cards (an expanded hiring-fit
      // disclosure, here card0017-19) are never sampled away.
      const clipboardReport = generateMarkdown(payload, null, { maxChars: 1_000_000 }).markdown;
      assert(clipboardReport.includes('| `card0014`')
        && !clipboardReport.includes('| `card0015`')
        && clipboardReport.includes('reasoningExpanded')
        && clipboardReport.includes('scoreAuditExpanded')
        && clipboardReport.includes('compensationExpanded')
        && clipboardReport.includes('2 routine jobcard row(s) omitted to preserve the clipboard budget'),
      'clipboard generation samples routine cards but retains every expanded hiring-fit disclosure as a flagged anomaly');
      return { fileRows: nodes.length, clipboardRows: 18 };
    },
  },
{
    // The header contract this guards: `## Report Filtering` states how many
    // event lines the FULL/filter selection kept, computed BEFORE the
    // clipboard cap ever runs. If the cap later sheds oldest events, that
    // sentence would still read "kept all N line(s)" while the copied
    // markdown actually holds fewer — the report asserting something untrue
    // about itself. clarifyCappedFilterSummary rewrites the sentence whenever
    // trimming (or folding) changed what the clipboard actually retained.
    name: 'Clipboard cap rewrites the filter-summary sentence whenever it trims or folds',
    run: () => {
      const ts = (i) => `12:00:${String(Math.floor(i / 60)).padStart(2, '0')}.${String(i % 60).padStart(3, '0')}`;
      const events = Array.from({ length: 200 }, (_, i) => `[${ts(i)}] EVT ${i} something happened on the canvas`);
      const fullFilterSummary = buildFilterSummaryMarkdown({
        filterCode: 'FULL',
        filterStats: { eventsShown: events.length, eventsTotal: events.length, omittedSections: [] },
      });
      assert(fullFilterSummary.includes(`event log kept all ${events.length} line(s)`),
        'fixture sanity: the FULL filter summary must claim it kept every event before any cap runs');

      // Roomy budget: nothing trimmed, nothing folded — the pre-cap sentence
      // is still true, so clarifyCappedFilterSummary must leave it untouched.
      const roomy = enforceClipboardMarkdownCap('# Bug Report\n' + fullFilterSummary + '\n', events, [], 1_000_000);
      assert(roomy.markdown.includes(`event log kept all ${events.length} line(s)`),
        'a report that fits under the cap keeps the untouched "kept all N line(s)" sentence — nothing was trimmed');

      // A tight cap forces the cap to shed oldest events. The header's claim
      // must be rewritten so it can never say "kept all" while lines were
      // actually dropped from the copied markdown.
      const tight = enforceClipboardMarkdownCap('# Bug Report\n' + fullFilterSummary + '\n', events, [], 3_000);
      assert(tight.trimmedEventCount > 0,
        'fixture sanity: a 3,000-char cap over 200 event lines must trim at least one event');
      assert(!tight.markdown.includes(`event log kept all ${events.length} line(s)`),
        'the clipboard cap must never let the header claim "kept all N line(s)" once lines were dropped');
      const retained = events.length - tight.trimmedEventCount;
      assert(tight.markdown.includes(`event log selected all ${events.length} line(s) before clipboard capping`)
        && tight.markdown.includes(`clipboard retained ${retained} of ${events.length} event line(s)`),
      'the rewritten sentence states what FULL selected before capping and what the clipboard actually retained after it');
      return { retained, trimmed: tight.trimmedEventCount };
    },
  },
{
    name: 'Bug report clipboard cap reserves the logs + event timeline',
    run: () => {
      const ts = (i) => `12:00:${String(Math.floor(i / 60)).padStart(2, '0')}.${String(i % 60).padStart(3, '0')}`;
      // Fixture event/log lines carry a recognized `[HH:MM:SS.mmm]` capture
      // timestamp (the legacy shape `timestampedLogLines` still passes through
      // unchanged) so the cap's char-budget math matches real captured lines —
      // an unstamped raw line would instead get a "(timestamp assigned at
      // report export)" marker spliced in, which would throw off every exact
      // byte-budget assertion below. The log lines additionally start with a
      // bracketed non-word module tag (`[Marketplace]`) rather than a bare
      // level word, so they never accidentally match collapseLogRepeats' own
      // fold pattern — this test is about EVENT trimming, not log folding
      // (log folding gets its own dedicated test below).
      const events = Array.from({ length: 200 }, (_, i) => `[${ts(i)}] EVT ${i} something happened on the canvas`);
      const logs = Array.from({ length: 60 }, (_, i) => `[${ts(i)}] [Marketplace] LOG ${i} scrape/resolve detail line`);
      const fullFilterSummary = buildFilterSummaryMarkdown({
        filterCode: 'FULL',
        filterStats: { eventsShown: events.length, eventsTotal: events.length, omittedSections: [] },
      });

      // Small base, tiny cap unreachable: nothing truncated, everything present.
      const roomy = enforceClipboardMarkdownCap('# Bug Report\nbody\n', events, logs, 1_000_000);
      assert(!roomy.truncated && roomy.markdown.includes('## Event History') && roomy.markdown.includes('## Recent Main-Process Logs'),
        'Clipboard cap: roomy budget keeps logs + full event history untouched');
      assert(roomy.markdown.includes('Up to 200 lines from the main process') && !roomy.markdown.includes('Last ~60 lines'),
        'Main-process log heading matches the current 200-line ring-buffer request');
      assert(roomy.markdown.includes('Timestamps:** full ISO UTC')
        && roomy.markdown.includes('Timestamps:** full local ISO with numeric UTC offset'),
      'Clipboard cap: timestamp bases are labeled for main-process (UTC) and renderer (local) evidence');
      assert(roomy.markdown.includes('EVT 0 ') && roomy.markdown.includes('EVT 199 '),
        'Clipboard cap: roomy budget keeps both oldest and newest events');

      // The normal file/export path does not invoke the clipboard cap. Its
      // independently assembled Event History heading must carry the same local
      // time basis as the cap helper's shared tail.
      const uncapped = generateMarkdown({
        description: 'Timestamp-basis regression fixture.',
        nodes: [], edges: [], drawings: [], frontEndState: {},
        nodeInternals: [], nodeComponentStates: [], eventLogs: ['12:00:00 renderer event'],
      }).markdown;
      assert(uncapped.includes('## Event History\n> **Order within this section:** newest first')
        && uncapped.includes('Timestamps:** full local ISO with numeric UTC offset'),
      'Uncapped report labels renderer Event History timestamps with the shared local-ISO basis');
      assert(uncapped.includes('## Runtime Identity') && uncapped.includes('timezone ') && uncapped.includes('UTC offset '),
        'FULL report renders runtime versions and the date/timezone correlation anchor it already collects');

      // Phase 1: base fits but full tail doesn't — oldest events trimmed first,
      // newest events + the logs survive.
      const cap = 8_000;
      const smallBase = '# Bug Report\n' + fullFilterSummary + '\n' + 'x'.repeat(2_000) + '\n';
      const phase1 = enforceClipboardMarkdownCap(smallBase, events, logs, cap);
      assert(phase1.markdown.length <= cap, `Clipboard cap: phase-1 output must respect the cap (${phase1.markdown.length} <= ${cap})`);
      assert(phase1.trimmedEventCount > 0 && !phase1.hardTruncated, 'Clipboard cap: phase-1 should trim oldest events, not hard-truncate');
      assert(phase1.markdown.includes('EVT 199 ') && !phase1.markdown.includes('EVT 0 '),
        'Clipboard cap: phase-1 keeps the NEWEST events and sheds the oldest');
      assert(phase1.markdown.includes('## Recent Main-Process Logs') && phase1.markdown.includes('LOG 59'),
        'Clipboard cap: phase-1 must not sacrifice the main-process logs');
      assert(phase1.markdown.includes(`clipboard retained ${events.length - phase1.trimmedEventCount} of ${events.length} event line(s)`)
        && !phase1.markdown.includes(`event log kept all ${events.length} line(s)`),
      'Clipboard cap: phase-1 FULL summary reports final retained events, not the pre-cap selection');
      assert(phase1.markdown.includes(`retained ${events.length - phase1.trimmedEventCount} of ${events.length} most-recent event line(s)`)
        && phase1.markdown.includes(`${logs.length - phase1.trimmedLogCount} of ${logs.length} most-recent main-process log line(s)`),
      'Clipboard cap: phase-1 banner quantifies retained event and log lines');

      // Phase 2: the static base ALONE exceeds the cap (the bug from this report).
      // The logs + most-recent events MUST survive; the base tail is what gets cut.
      const giantBase = '# Bug Report\n' + fullFilterSummary + '\nNARRATIVE TOP\n' + 'Z'.repeat(40_000) + '\n## Node Diagnostics\nNODE TAIL\n';
      const phase2 = enforceClipboardMarkdownCap(giantBase, events, logs, cap);
      assert(phase2.markdown.length <= cap, `Clipboard cap: phase-2 output must respect the cap (${phase2.markdown.length} <= ${cap})`);
      assert(phase2.hardTruncated, 'Clipboard cap: phase-2 should flag a hard truncation');
      assert(phase2.markdown.includes('## Event History') && phase2.markdown.includes('EVT 199 '),
        'Clipboard cap: phase-2 MUST preserve the recent event timeline (regression guard)');
      assert(phase2.markdown.includes('Timestamps:** full ISO UTC')
        && phase2.markdown.includes('Timestamps:** full local ISO with numeric UTC offset'),
      'Clipboard hard cap preserves both timestamp-basis notes with the retained diagnostics');
      assert(phase2.markdown.includes('## Recent Main-Process Logs') && phase2.markdown.includes('LOG 59'),
        'Clipboard cap: phase-2 MUST preserve the main-process logs (regression guard)');
      assert(phase2.markdown.includes('NARRATIVE TOP') && !phase2.markdown.includes('NODE TAIL'),
        'Clipboard cap: phase-2 keeps the curated top of the base and sheds its low-value tail');
      assert(phase2.markdown.includes(`clipboard retained ${events.length - phase2.trimmedEventCount} of ${events.length} event line(s)`)
        && !phase2.markdown.includes(`event log kept all ${events.length} line(s)`),
      'Clipboard cap: hard-capped FULL summary reports final retained events, not the pre-cap selection');
      assert(phase2.markdown.includes(`retained ${events.length - phase2.trimmedEventCount} of ${events.length} most-recent event line(s)`)
        && phase2.markdown.includes(`${logs.length - phase2.trimmedLogCount} of ${logs.length} most-recent main-process log line(s)`),
      'Clipboard cap: hard-cap banner quantifies retained event and log lines');
      assert(phase2.markdown.includes('static report content')
        && phase2.markdown.includes('oldest event history line(s)')
        && phase2.markdown.includes('oldest main-process log line(s)')
        && phase2.markdown.includes('Report content after this point was omitted by the clipboard cap')
        && !phase2.markdown.includes('older timeline entries')
        && !phase2.markdown.includes('static node/session tail'),
      'Clipboard cap: hard-cap copy names only the static/event/log content actually omitted');

      // A hard cap can truncate the large static base while preserving EVERY
      // event. Its banner must not claim that older event/timeline entries were
      // lost merely because other content was cut (the real FULL-report case).
      const shortEvents = Array.from({ length: 8 }, (_, i) => `[${ts(i)}] SHORT EVT ${i}`);
      const longLogs = Array.from({ length: 60 }, (_, i) => `[${ts(i)}] [Main] LONG LOG ${i} ${'detail '.repeat(12)}`);
      const staticAndLogsOnly = enforceClipboardMarkdownCap(giantBase, shortEvents, longLogs, cap);
      assert(staticAndLogsOnly.hardTruncated && staticAndLogsOnly.trimmedEventCount === 0
        && staticAndLogsOnly.trimmedLogCount > 0,
      'Clipboard cap: fixture hard-truncates static/log content while retaining the full event history');
      assert(staticAndLogsOnly.markdown.includes(`retained ${shortEvents.length} of ${shortEvents.length} most-recent event line(s)`)
        && !staticAndLogsOnly.markdown.includes('oldest event history line(s)')
        && !staticAndLogsOnly.markdown.includes('older timeline entries')
        && staticAndLogsOnly.markdown.includes('oldest main-process log line(s)'),
      'Clipboard cap: hard-cap banner does not claim event loss when every event was retained');

      // Name both kinds of static loss. The exact cap assertion is especially
      // important here because adding the names makes the banner longer and
      // therefore leaves less room for the base than the initial generic pass.
      const namedHardBase = '# Bug Report\n## Kept Summary\n' + 'A'.repeat(5_000)
        + '\n## Partial Audit\n' + 'B'.repeat(5_000)
        + '\n## Dropped Diagnostics\nbody\n## Also Dropped\nbody\n';
      const namedHard = enforceClipboardMarkdownCap(namedHardBase, events, logs, cap);
      assert(namedHard.hardTruncated && namedHard.markdown.length <= cap,
        `Clipboard cap: named hard-cap output respects the exact cap (${namedHard.markdown.length} <= ${cap})`);
      assert(namedHard.markdown.includes('3 section(s) dropped: Partial Audit, Dropped Diagnostics, Also Dropped')
        && namedHard.markdown.includes('"Kept Summary" cut mid-section'),
      'Clipboard cap: hard-cap banner names whole dropped sections and the section cut in progress');

      // This begins on the soft path (the base plus reserved tail fits), then
      // the event/log notice tips it into its secondary static hard-cap path.
      // It must use the same final-cut section diagnostics as the direct hard
      // path rather than reporting the stale generic or first-pass omission.
      const secondaryCap = 2_000;
      const secondarySections = Array.from({ length: 12 }, (_, i) => `## S${i}\n${String(i).repeat(84)}\n`).join('');
      const secondaryEvents = Array.from({ length: 100 }, (_, i) => `[${ts(i)}] EVENT ${i} ${'x'.repeat(18)}`);
      // `[S]` (bracket, not a bare level word) keeps this fixture out of
      // collapseLogRepeats' own fold pattern — see the file-level comment above.
      const secondaryLogs = Array.from({ length: 60 }, (_, i) => `[${ts(i)}] [S] LOG ${i} ${'x'.repeat(18)}`);
      const secondaryHard = enforceClipboardMarkdownCap(secondarySections, secondaryEvents, secondaryLogs, secondaryCap);
      assert(secondaryHard.hardTruncated && secondaryHard.markdown.length <= secondaryCap,
        `Clipboard cap: secondary hard-cap output respects the exact cap (${secondaryHard.markdown.length} <= ${secondaryCap})`);
      assert(secondaryHard.markdown.includes('2 section(s) dropped: S10, S11')
        && secondaryHard.markdown.includes('"S9" cut mid-section'),
      'Clipboard cap: secondary hard-cap banner names the final dropped and partial sections');

      // A `##` cut mid-body silently took its `###` children with it: the
      // heading scan is /^## (.+)$/gm, so named diagnostics (the Non-API AI
      // handoff receipt, the Glassdoor location cache) disappeared with the
      // notice reporting only that the PARENT was "cut mid-section". The
      // subsection tally is reported separately — folding it into the `##`
      // count would misstate how many top-level sections were lost.
      const subsectionBase = '# Bug Report\n## Kept Summary\n' + 'A'.repeat(4_000)
        + '\n## Big Section\n' + 'B'.repeat(4_000)
        + '\n### Handoff Lifecycle\nbody\n### Location Cache\nbody\n'
        + '\n## Dropped Whole\nbody\n';
      const subsectionCut = enforceClipboardMarkdownCap(subsectionBase, events, logs, cap);
      assert(subsectionCut.markdown.includes('subsection(s) lost with them: ')
        && subsectionCut.markdown.includes('Handoff Lifecycle')
        && !/\d+ section\(s\) dropped:[^;]*Handoff Lifecycle/.test(subsectionCut.markdown),
      'Clipboard cap: dropped ### subsections are named in their own clause, never folded into the ## dropped-section tally');

      // The base is being cut mid-document either way, so spending only the
      // FLOOR on the tail wasted budget the static cut could not use. The tail
      // grows toward the full logs+events, bounded at half the cap so the
      // static prefix stays meaningful.
      const grownEvents = Array.from({ length: 120 }, (_, i) => `[${ts(i)}] EVENT ${i} ${'x'.repeat(40)}`);
      const grownLogs = Array.from({ length: 125 }, (_, i) => `[${ts(i)}] [G] LOG ${i} ${'y'.repeat(45)}`);
      const grownBase = '# Bug Report\n## Job Search Pipeline\n'
        + Array.from({ length: 500 }, (_, i) => `- audit row ${i}: ${'P'.repeat(70)}`).join('\n')
        + '\n\n## Dropped Diagnostics\nbody\n';
      const grownCap = 50_000;
      const grown = enforceClipboardMarkdownCap(grownBase, grownEvents, grownLogs, grownCap);
      const retainedEvents = grownEvents.length - grown.trimmedEventCount;
      const retainedLogs = grownLogs.length - grown.trimmedLogCount;
      assert(grown.hardTruncated && grown.markdown.length <= grownCap,
        `Clipboard cap: grown-tail hard-cap output still respects the exact cap (${grown.markdown.length} <= ${grownCap})`);
      assert(retainedEvents === grownEvents.length && retainedLogs === grownLogs.length,
        `Clipboard cap: a hard-truncated report spends leftover budget on the tail instead of the floor (kept ${retainedEvents}/${grownEvents.length} events, ${retainedLogs}/${grownLogs.length} logs)`);
      assert(grown.markdown.includes(`retained ${retainedEvents} of ${grownEvents.length} most-recent event line(s)`)
        && grown.markdown.includes(`${retainedLogs} of ${grownLogs.length} most-recent main-process log line(s)`),
      'Clipboard cap: the banner reports the tail actually retained, not the floor it started from');
      assert(grown.markdown.length >= grownCap * 0.9,
        `Clipboard cap: the grown tail keeps overall utilisation high (${grown.markdown.length} of ${grownCap})`);

      // A single board re-combine tears down hundreds of uniquely-id'd nodes in
      // a couple of milliseconds. Capture-time collapsers cannot merge unique
      // ids, so those bursts arrive whole and can eat most of the retained-event
      // budget; the clipboard path folds them at render time only.
      const teardownStamp = 'board-6f7c1a2e-3b9d-4c05-8e21-0d4a7b6c9e13-1755820000000';
      const burstTs = (i) => `12:00:${String(Math.floor(i / 100)).padStart(2, '0')}.${String(i % 100).padStart(3, '0')}`;
      const teardownBurst = Array.from({ length: 300 }, (_, i) => `[${burstTs(i)}] node removed id=${teardownStamp}-job-${i}`);
      const distinctEvents = Array.from({ length: 50 }, (_, i) => `[12:01:${String(i % 60).padStart(2, '0')}.000] DISTINCT-${i} unique canvas activity`);
      const FOLD_SIGNATURE = /×\d+ \(id prefix/;

      // Save to file is the uncapped artifact and the primary evidence for
      // "my card disappeared" reports: every raw id must survive it verbatim.
      const savedToFile = generateMarkdown({
        description: 'Burst-fold save-to-file fidelity fixture.',
        nodes: [], edges: [], drawings: [], frontEndState: {},
        nodeInternals: [], nodeComponentStates: [], eventLogs: teardownBurst,
      }).markdown;
      assert(teardownBurst.every((line) => savedToFile.includes(line)) && !FOLD_SIGNATURE.test(savedToFile),
        'Save to file keeps every raw node-removed id: burst folding must never reach the uncapped export');

      const roomyBurst = enforceClipboardMarkdownCap('# Bug Report\nbody\n', teardownBurst, logs, 1_000_000);
      assert(!roomyBurst.truncated && teardownBurst.every((line) => roomyBurst.markdown.includes(line))
        && !FOLD_SIGNATURE.test(roomyBurst.markdown),
      'Clipboard cap: a report that fits keeps every id verbatim — folding is a last-resort transform');

      const foldedEvents = [...teardownBurst, ...distinctEvents];
      const folded = enforceClipboardMarkdownCap('# Bug Report\nbody\n', foldedEvents, [], cap);
      assert(folded.markdown.length <= cap, `Clipboard cap: folded output must respect the cap (${folded.markdown.length} <= ${cap})`);
      assert((folded.markdown.match(new RegExp(FOLD_SIGNATURE, 'g')) || []).length === 1
        && folded.markdown.includes(`node removed ×${teardownBurst.length} (id prefix ${teardownStamp}-job-`),
      'Clipboard cap: one structural teardown burst folds into exactly one run line');
      assert(folded.markdown.includes(`first ${teardownStamp}-job-0`)
        && folded.markdown.includes(`last ${teardownStamp}-job-${teardownBurst.length - 1}`),
      'Clipboard cap: the fold line carries the full first/last ids that identify which tree was torn down');
      assert(distinctEvents.every((line) => folded.markdown.includes(line)),
        'Clipboard cap: folding repetitive churn buys room for every distinct event line');
      assert(folded.markdown.includes(`${teardownBurst.length} repeated event line(s) from ${foldedEvents.length} captured line(s) were folded into 1 run line(s) before capping`),
        'Clipboard cap: the banner states how many captured lines were folded into how many run lines');

      const foldedFilterBase = '# Bug Report\n' + buildFilterSummaryMarkdown({
        filterCode: 'FULL',
        filterStats: { eventsShown: foldedEvents.length, eventsTotal: foldedEvents.length, omittedSections: [] },
      }) + '\n';
      const foldedFull = enforceClipboardMarkdownCap(foldedFilterBase, foldedEvents, [], cap);
      assert(foldedFull.markdown.includes(`event log selected all ${foldedEvents.length} line(s) before clipboard capping`)
        && foldedFull.markdown.includes(`clipboard retained ${distinctEvents.length + 1} of ${distinctEvents.length + 1} rendered event line(s)`)
        && foldedFull.markdown.includes(`after folding ${teardownBurst.length} repeated line(s) from ${foldedEvents.length} captured line(s) into 1 run line(s)`)
        && !foldedFull.markdown.includes(`clipboard retained ${distinctEvents.length + 1} of ${foldedEvents.length} event line(s)`),
      'Clipboard cap: the rewritten FULL summary distinguishes raw captured events from fully retained post-fold lines');

      const foldedHard = enforceClipboardMarkdownCap(giantBase, foldedEvents, logs, cap);
      assert(foldedHard.hardTruncated && foldedHard.markdown.length <= cap,
        `Clipboard cap: a folded hard-cap report still respects the exact cap (${foldedHard.markdown.length} <= ${cap})`);
      assert(foldedHard.markdown.includes('were folded into 1 run line(s) before capping'),
        'Clipboard cap: the hard-cap banner also accounts for folded churn');

      // Direct folding contracts: short runs, unrelated ids, verb boundaries and
      // the non-structural allowlist all keep their lines verbatim.
      const shortRun = teardownBurst.slice(0, 7);
      const shortFold = collapseEventBursts(shortRun);
      assert(shortFold.collapsedRuns === 0 && shortFold.foldedLineCount === 0
        && JSON.stringify(shortFold.lines) === JSON.stringify(shortRun),
      'Burst folding leaves a small deletion verbatim: every id of a 7-node teardown survives');

      const unrelatedRemovals = Array.from({ length: 20 }, (_, i) =>
        `[12:02:${String(i).padStart(2, '0')}.000] node removed id=${String.fromCharCode(97 + i)}${i}-node`);
      const unrelatedFold = collapseEventBursts(unrelatedRemovals);
      assert(unrelatedFold.collapsedRuns === 0
        && JSON.stringify(unrelatedFold.lines) === JSON.stringify(unrelatedRemovals),
      'Burst folding is data-driven: ids without a shared prefix are never summarized as one run');

      const rebuildBurst = Array.from({ length: 10 }, (_, i) => `[12:03:00.${String(i).padStart(3, '0')}] node added id=${teardownStamp}-job-${i}`);
      const verbBoundary = collapseEventBursts([...teardownBurst.slice(0, 10), ...rebuildBurst]);
      assert(verbBoundary.collapsedRuns === 2 && verbBoundary.lines.length === 2
        && verbBoundary.lines[0].includes('node removed ×10 ') && verbBoundary.lines[1].includes('node added ×10 '),
      'Burst folding never merges across verbs: a teardown and the rebuild that follows stay separate runs');

      const noisyLines = [
        ...Array.from({ length: 30 }, (_, i) => `[12:04:${String(i % 60).padStart(2, '0')}.000] CONSOLE-ERROR render failed id=${teardownStamp}-job-${i}`),
        ...Array.from({ length: 30 }, (_, i) => `[12:05:${String(i % 60).padStart(2, '0')}.000] [LocalAI] import rejected id=${teardownStamp}-job-${i}`),
      ];
      const noisyFold = collapseEventBursts(noisyLines);
      assert(noisyFold.collapsedRuns === 0 && JSON.stringify(noisyFold.lines) === JSON.stringify(noisyLines),
        'Burst folding is verb-allowlisted: error and module lines are never folded, however repetitive');

      const firstFoldPass = collapseEventBursts([...teardownBurst, ...distinctEvents, ...rebuildBurst]);
      const secondFoldPass = collapseEventBursts(firstFoldPass.lines);
      assert(secondFoldPass.collapsedRuns === 0
        && JSON.stringify(secondFoldPass.lines) === JSON.stringify(firstFoldPass.lines),
      'Burst folding is idempotent: an emitted run line can never be folded again');

      const orderedFold = collapseEventBursts([
        '[12:06:00.000] viewport changed zoom=1.2',
        ...Array.from({ length: 10 }, (_, i) => `[12:06:01.${String(i).padStart(3, '0')}] node removed id=${teardownStamp}-job-${i}`),
        '[12:06:02.000] [JobSearch] combine finished',
      ]);
      assert(orderedFold.lines.length === 3
        && orderedFold.lines[0].startsWith('[12:06:00.000]')
        && orderedFold.lines[1].startsWith('[12:06:01.000–12:06:01.009] node removed ×10 ')
        && orderedFold.lines[2].startsWith('[12:06:02.000]'),
      'Burst folding preserves ordering: the run line carries its first timestamp between its neighbours');
      return { phase1Len: phase1.markdown.length, phase2Len: phase2.markdown.length, phase1Trimmed: phase1.trimmedEventCount, foldedRuns: firstFoldPass.collapsedRuns };
    },
  },
{
    name: 'Clipboard cap folds repeated log bursts and never leaves a fence open',
    run: () => {
      // A deep paginating walk emits one near-identical progress pair per page.
      // Before folding, 54 of a real report's 93 retained log lines were these,
      // crowding out whole diagnostic sections.
      const walk = [];
      for (let page = 1; page <= 15; page++) {
        const ts = `23:${String(page).padStart(2, '0')}`;
        walk.push(`[${ts}:08.719] INFO  [BrowserScraper] Glassdoor q1 descriptions: 30/30 expanded (sel: x)`);
        walk.push(`[${ts}:08.733] INFO  [BrowserScraper] Glassdoor page ${page}: 30 new jobs (${page * 30} total)`);
      }
      const warn = '[23:18:16.782] WARN  [BrowserScraper] glassdoor: denied the list-panel request with HTTP 502';
      const done = '[00:25:03.941] INFO  [BrowserScraper] Glassdoor done: 612 jobs (completed)';
      const folded = collapseLogRepeats([...walk, warn, done]);
      assert(folded.lines.length < walk.length,
        'Clipboard log fold: a repeated progress shape must shrink the block');
      assert(folded.lines.includes(warn),
        'Clipboard log fold: WARN lines always pass through verbatim — a swallowed error is the most valuable line here');
      assert(folded.lines.includes(done) && folded.lines.includes(walk[0]) && folded.lines.includes(walk.at(-1)),
        'Clipboard log fold: the first and last occurrences of a folded shape survive so the walk stays readable');
      assert(folded.lines.some(l => l.includes('repeat(s) elided') && l.includes('Glassdoor page #')),
        'Clipboard log fold: the summary names the shape it stands for');
      assert(collapseLogRepeats(folded.lines).foldedLineCount === 0,
        'Clipboard log fold: a second pass over already-folded lines is a no-op');

      // Distinct messages must never be merged just because they repeat nearby.
      const distinct = Array.from({ length: 12 }, (_, i) => `[00:00:0${i % 10}.000] INFO  [A] step ${'x'.repeat(i + 1)} ran`);
      assert(collapseLogRepeats(distinct).foldedLineCount === 0,
        'Clipboard log fold: lines whose non-numeric shape differs are never folded together');

      // Fenced blocks: the base carries ```json/```html samples. A cut inside
      // one used to swallow the omission marker and render the whole tail as code.
      const rows = (n, ch) => Array.from({ length: n }, (_, i) => `- row ${i} ${ch.repeat(40)}`).join('\n');
      const fenced = '# R\n## Kept\n' + rows(60, 'A') + '\n\n## Samples\n```html\n' + rows(200, 'B') + '\n```\n\n## Tail\nbody\n';
      const cut = enforceClipboardMarkdownCap(fenced, ['[00:00:00] E1', '[00:00:01] E2'], ['[00:00:00] [L] L1', '[00:00:01] [L] L2'], 6_000);
      const fenceCount = (cut.markdown.match(/^ {0,3}```/gm) || []).length;
      assert(cut.hardTruncated && cut.markdown.length <= 6_000,
        `Clipboard fence balance: output still respects the cap (${cut.markdown.length} <= 6000)`);
      assert(fenceCount % 2 === 0,
        'Clipboard fence balance: a cut inside a fenced block must be closed, or the omission note renders as code');
      assert(cut.markdown.includes('Report content after this point was omitted by the clipboard cap'),
        'Clipboard fence balance: the omission marker survives the cut it describes');
      return { foldedLineCount: folded.foldedLineCount, fenceCount };
    },
  },
{
    name: 'Clipboard hard cap grows its tail proportionally, not as a cliff',
    run: () => {
      // A base one char past the floor path used to forfeit (ceiling - floor)
      // chars of static diagnostics immediately — that cliff is what cost a real
      // report six whole sections plus a mid-section cut.
      const ts = (i) => `12:00:${String(Math.floor(i / 60)).padStart(2, '0')}.${String(i % 60).padStart(3, '0')}`;
      const cap = 50_000;
      const events = Array.from({ length: 40 }, (_, i) => `[${ts(i)}] EVENT ${i} ${'x'.repeat(40)}`);
      // `[X]` keeps this fixture out of collapseLogRepeats' own fold pattern —
      // this test is about the tail-growth curve, not log folding.
      const logs = Array.from({ length: 40 }, (_, i) => `[${ts(i)}] [X] LOG ${i} ${'y'.repeat(60)}`);
      const tailish = 'Z'.repeat(200);
      const sections = (n) => Array.from({ length: n }, (_, i) => `## S${i}\n${tailish}\n`).join('');
      const marginal = '# Bug Report\n' + sections(160);
      const out = enforceClipboardMarkdownCap(marginal, events, logs, cap);
      assert(out.markdown.length <= cap, 'Clipboard proportional tail: output respects the cap');
      // With a small overflow the static base must keep far more than half the cap.
      const staticKept = out.markdown.length - (cap - Math.floor(cap * 0.5));
      assert(staticKept > 0, 'Clipboard proportional tail: a marginal overflow keeps a majority static prefix');
      assert(out.markdown.includes('## S0') && out.markdown.includes('## S100'),
        'Clipboard proportional tail: a marginal overflow must not discard a third of the static sections');
      return { length: out.markdown.length };
    },
  },
{
    name: 'FULL and PERSIST reports include redacted session durability diagnostics',
    run: () => {
      const base = {
        description: 'Reopen regression fixture.', nodes: [], edges: [], drawings: [],
        frontEndState: {}, nodeInternals: [], nodeComponentStates: [], eventLogs: [],
      };
      const full = generateMarkdown({ ...base, filterCode: 'FULL' }).markdown;
      const persist = generateMarkdown({ ...base, filterCode: 'PERSIST' }).markdown;
      for (const report of [full, persist]) {
        assert(report.includes('## Session Persistence Diagnostics')
          && report.includes('Cookies DB')
          && report.includes('Completed auth-browser close lifecycle'),
        'session-persistence reports must include profile checkpoints and structured close outcomes');
        assert(!/cookie value/i.test(report) || report.includes('cookie values are never read or exported'),
          'session-persistence diagnostics must never expose cookie values');
      }
      return { full: true, persist: true };
    },
  },
{
    name: 'native challenge history preserves closure evidence without Cloudflare query tokens',
    run: () => {
      const evidence = buildNativeChallengeHistoryEvidence({
        nativeChallenge: {
          initialChallengeObserved: true,
          initialSignal: 'cf-verify-text',
          pollCount: 7,
          pollErrorCount: 1,
          lastClassification: 'cleared',
          lastTabUrl: 'https://secure.indeed.com/settings/account?__cf_chl_rt_tk=secret-token',
          lastTabTitle: 'Account settings',
          terminalSource: 'child-exit',
          exitCode: 0,
          postCloseVerify: {
            outcome: 'challenge-cleared', status: 200,
            reason: 'account page reached',
            finalUrl: 'https://secure.indeed.com/settings/account?private=token',
          },
        },
      });
      assert(evidence.includes('initial challenge=yes')
        && evidence.includes('polls=7')
        && evidence.includes('terminal=child-exit')
        && evidence.includes('post-close=challenge-cleared HTTP 200')
        && evidence.includes('https://secure.indeed.com/settings/account')
        && !evidence.includes('secret-token')
        && !evidence.includes('private=token'),
      'native challenge reports retain decisive lifecycle facts but strip URL query tokens');
      return { evidence: 'redacted' };
    },
  },
  {
    // BR-2 follow-up: the always-on handoff section promised poll evidence the
    // record could not carry. A handoff whose observer never had a tab to read
    // (Chrome's Apple-event permission denied, or no indeed.com tab ever in the
    // inventory) ended `closed` and printed `polls=40; last=unknown;
    // terminal=child-exit` — byte-identical to an observer that watched a real
    // challenge page forty times and never saw it clear. That distinction is the
    // entire reason the section exists, so both facts authWindows persists must
    // reach the render.
    name: 'native challenge evidence separates "never had a tab to watch" from "watched a wall that never cleared"',
    run: () => {
      const blind = buildNativeChallengeHistoryEvidence({
        nativeChallenge: {
          initialChallengeObserved: false, pollCount: 40, pollErrorCount: 40,
          sawFirstPartyTab: false,
          firstPollError: 'osascript: execution error: Not authorized to send Apple events to Google Chrome. (-1743) see https://support.example.test/mac?tok=leak-me',
          lastClassification: null, terminalSource: 'child-exit', exitCode: 0,
        },
      });
      const watched = buildNativeChallengeHistoryEvidence({
        nativeChallenge: {
          initialChallengeObserved: true, pollCount: 40, pollErrorCount: 0,
          sawFirstPartyTab: true, firstPollError: null,
          lastClassification: 'pending', terminalSource: 'child-exit', exitCode: 0,
        },
      });
      assert(blind.includes('first-party tab seen=no')
        && blind.includes('poll errors=40')
        && blind.includes('first poll error=osascript: execution error: Not authorized to send Apple events')
        && watched.includes('first-party tab seen=yes')
        && !watched.includes('first poll error=')
        && blind !== watched,
      `a blind observer and a watched-and-never-cleared observer must not render identically → blind="${blind}" watched="${watched}"`);
      assert(!blind.includes('leak-me') && !blind.includes('`') && !blind.includes('|'),
        'the first poll error is redacted and stripped of markup the way its neighbouring bits are');

      // 200 is the producer's cap on the stored field, and the renderer prints at
      // the same width — so a message that filled the record cannot pick up a
      // second, unmarked cut here. (Anything longer was already cut upstream.)
      const atCap = buildNativeChallengeHistoryEvidence({
        nativeChallenge: { pollCount: 3, pollErrorCount: 3, sawFirstPartyTab: false, firstPollError: 'E'.repeat(200) },
      });
      assert(atCap.includes(`first poll error=${'E'.repeat(200)}`),
        'a first poll error already at the record cap renders whole rather than being truncated twice');

      // Absent on records written before the fields existed. "Not recorded" is
      // not an observation of absence, so neither bit may be invented there.
      const legacy = buildNativeChallengeHistoryEvidence({
        nativeChallenge: { pollCount: 5, lastClassification: 'pending', terminalSource: 'child-exit' },
      });
      assert(!legacy.includes('first-party tab seen') && !legacy.includes('first poll error')
        && legacy.includes('polls=5'),
      `a record carrying neither field states neither, instead of rendering a 'no' it never observed → "${legacy}"`);

      // The section prose must name what a record actually retains rather than
      // promising evidence the record structurally may not carry.
      const sectionSrc = fs.readFileSync(path.resolve('electron/ipc/bugReport.js'), 'utf8');
      assert(!sectionSrc.includes('> \\`closed\\` always carries its poll / child-exit /')
        && sectionSrc.includes('What a record retains varies, and each bit below is'),
      'the handoff section blockquote describes the evidence each record retains instead of claiming it always carries poll evidence');

      const rendered = buildNativeChallengeSessionMarkdown([{
        platformId: 'indeed-native-challenge', mode: 'native-chrome', result: 'closed',
        finishedAt: new Date().toISOString(), openMs: 61_000,
        nativeChallenge: {
          pollCount: 40, pollErrorCount: 40, sawFirstPartyTab: false,
          firstPollError: 'osascript: execution error: Not authorized to send Apple events to Google Chrome. (-1743)',
          terminalSource: 'child-exit', exitCode: 0,
        },
      }]);
      assert(rendered.includes('first-party tab seen=no')
        && rendered.includes('Not authorized to send Apple events'),
      'the always-on handoff section renders the two bits, not just the evidence helper');
      return { blindBits: blind.split('; ').length };
    },
  },
  {
    // The incident fixture, reproduced exactly: the session ring held 15 of its
    // 16 slots — so authWindows.js had evicted nothing — and the three
    // `indeed-native-challenge` handoffs were the OLDEST records. The renderer's
    // own newest-12 slice then dropped all three behind 12 routine `captcha:`
    // rows, emptying the only place buildNativeChallengeHistoryEvidence renders.
    name: 'auth history selection renders every retained record, so native challenge evidence cannot be evicted by routine captcha windows',
    run: () => {
      const now = Date.now();
      const at = (secondsAgo) => new Date(now - secondsAgo * 1000).toISOString();
      const nativeRecord = (i) => ({
        platformId: 'indeed-native-challenge', mode: 'native-chrome', result: 'closed',
        finishedAt: at(900 - i), openMs: 41_000 + i, cookieStoreCommitted: true,
        cookieFlushMs: 900, cookieFlushPhase: 'post-close-observe',
        nativeChallenge: {
          initialChallengeObserved: true, pollCount: 12 + i, lastClassification: 'pending',
          terminalSource: 'child-exit', exitCode: 0,
          lastTabUrl: 'https://secure.indeed.com/auth?__cf_chl_rt_tk=ring-secret',
        },
      });
      const captchaRecord = (i) => ({
        platformId: `captcha:board${i}`, mode: 'puppeteer-visible', result: 'closed',
        finishedAt: at(100 - i), openMs: 5_000, cookieFlushMs: 1_200, cookieFlushPhase: 'pre-close-fixed',
      });
      const history = [
        ...[0, 1, 2].map(nativeRecord),
        ...Array.from({ length: 12 }, (_, i) => captchaRecord(i)),
      ];
      assert(history.length === 15
        && !history.slice(-12).some(h => h.platformId === 'indeed-native-challenge'),
      'fixture guard: this ring reproduces the incident — nothing was evicted upstream, yet a newest-12 slice keeps no native challenge record');

      const selection = selectAuthHistoryForReport(history);
      const finishedOrder = selection.rows.map(h => new Date(h.finishedAt).getTime());
      assert(selection.shown === 15 && selection.retained === 15 && selection.dropped === 0
        && selection.rows.filter(h => h.platformId === 'indeed-native-challenge').length === 3
        && finishedOrder.every((ms, i) => i === 0 || ms <= finishedOrder[i - 1]),
      `the whole retained ring is selected, strictly newest-first, with all three native records kept → shown=${selection.shown}, dropped=${selection.dropped}`);

      const lifecycle = buildAuthLifecycleTableMarkdown(history);
      const nativeRows = (lifecycle.match(/\| `indeed-native-challenge` \|/g) || []).length;
      assert(nativeRows === 3 && lifecycle.includes('| `captcha:board11` |'),
        `the close-lifecycle table renders every retained native challenge row → ${nativeRows} of 3`);
      return { retained: selection.retained, nativeRowsRendered: nativeRows };
    },
  },
  {
    name: 'auth history truncation marker states observed counts and appears only when rows were actually dropped',
    run: () => {
      const history = Array.from({ length: 15 }, (_, i) => ({
        platformId: `captcha:board${i}`, mode: 'puppeteer-visible', result: 'closed',
        finishedAt: new Date(Date.now() - (100 - i) * 1000).toISOString(),
      }));
      const complete = selectAuthHistoryForReport(history);
      assert(formatAuthHistoryTruncationNote(complete, 'completed auth-window record(s)') === '',
        'a list that shows everything it retains prints no truncation marker — a marker there would read as evidence of a loss that never happened');
      assert(!buildAuthLifecycleTableMarkdown(history).includes('Truncated:'),
        'the close-lifecycle table renders the whole retained ring, so it emits no truncation marker');

      const cut = selectAuthHistoryForReport(history, 4);
      const note = formatAuthHistoryTruncationNote(cut, 'completed auth-window record(s)');
      assert(cut.shown === 4 && cut.retained === 15 && cut.dropped === 11
        && note.includes('showing the 4 newest of 15 completed auth-window record(s)')
        && note.includes('11 older retained record(s) are not shown')
        && note.includes('at most 16 completed auth windows'),
      `a genuinely cut list marks the truncation with the counts it measured → ${note.trim()}`);

      // BR-5: the section prose used to open "Every completed login/captcha
      // window." while the renderer silently cut the list — a completeness claim
      // the report could not honour.
      const reportSrc = fs.readFileSync(path.resolve('electron/ipc/bugReport.js'), 'utf8');
      assert(!reportSrc.includes('> Every completed login/captcha window.')
        && reportSrc.includes('> The completed login/captcha windows this process still retains, newest first.'),
      'the attempt-list prose describes what is retained instead of claiming every completed window is shown');

      // The marker names the ring bound, so it must not drift from the ring.
      // AUTH_HISTORY_CAP is private to authWindows.js; pin the mirror at source.
      const authSrc = fs.readFileSync(path.resolve('electron/ipc/browser/authWindows.js'), 'utf8');
      const ringCap = /const AUTH_HISTORY_CAP = (\d+);/.exec(authSrc)?.[1];
      const mirroredCap = /const AUTH_HISTORY_RING_CAP = (\d+);/.exec(reportSrc)?.[1];
      assert(ringCap && mirroredCap && ringCap === mirroredCap,
        `the reported ring cap must mirror authWindows.js AUTH_HISTORY_CAP → ring=${ringCap}, reported=${mirroredCap}`);
      return { dropped: cut.dropped, ringCap };
    },
  },
  {
    // BR-2: buildNativeChallengeHistoryEvidence had exactly one render site,
    // inside a capped list inside a conditionally-gated block, so its output was
    // all-or-nothing. This section always renders — including when the ring holds
    // nothing — and its empty state may only describe the ring, never assert that
    // no handoff happened.
    name: 'native challenge handoff section always renders, with an empty state that claims only what the ring holds',
    run: () => {
      const empty = buildNativeChallengeSessionMarkdown([]);
      assert(empty.includes('### Native Chrome challenge handoffs')
        && empty.includes("No native challenge handoff record is retained in this process's auth-window ring")
        && empty.includes('it is not an observation that no native challenge handoff occurred'),
      'the empty state names what the ring holds and explicitly refuses the stronger claim that no handoff occurred');

      const populated = buildNativeChallengeSessionMarkdown([
        { platformId: 'captcha:indeed', mode: 'puppeteer-visible', result: 'closed', finishedAt: new Date().toISOString() },
        {
          platformId: 'indeed-native-challenge', mode: 'native-chrome', result: 'closed',
          finishedAt: new Date(Date.now() - 30_000).toISOString(), openMs: 47_500,
          cookieStoreCommitted: true, closeDisposition: null,
          nativeChallenge: {
            initialChallengeObserved: true, pollCount: 9, lastClassification: 'pending',
            terminalSource: 'child-exit', exitCode: 0,
            lastTabUrl: 'https://secure.indeed.com/auth?__cf_chl_rt_tk=must-not-leak',
          },
        },
      ]);
      assert(populated.includes('`indeed-native-challenge`')
        && !populated.includes('captcha:indeed')
        && populated.includes('(30s ago)')
        && populated.includes('result **closed**')
        && populated.includes('open 47.5s')
        && populated.includes('cookie store checkpointed yes')
        && populated.includes('polls=9')
        && populated.includes('https://secure.indeed.com/auth')
        && !populated.includes('must-not-leak'),
      'each retained handoff prints its finish age, observed result, open duration, checkpoint state and bounded evidence, with URL query tokens stripped');
      assert(populated.includes('none stamped on this record; the child process exit WAS observed (exit code 0, terminal source child-exit)'),
        'an absent close disposition is reported alongside the child-exit observation instead of as a bare dash');

      // End-to-end: the section is inside the session-persistence builder, not
      // the conditionally-gated auth-window block, so a FULL report always has it.
      const base = {
        description: 'Native challenge section fixture.', nodes: [], edges: [], drawings: [],
        frontEndState: {}, nodeInternals: [], nodeComponentStates: [], eventLogs: [],
      };
      for (const filterCode of ['FULL', 'PERSIST']) {
        const report = generateMarkdown({ ...base, filterCode }).markdown;
        assert(report.includes('### Native Chrome challenge handoffs')
          && report.includes("No native challenge handoff record is retained in this process's auth-window ring"),
        `${filterCode} reports always carry the native challenge handoff section, empty state included`);
      }
      return { emptyStateRendered: true };
    },
  },
  {
    // BR-6: the column used to be headed "Pre-close wait ms", but on the
    // child-exit path cookieFlushMs is measured AFTER Chrome is gone. Without the
    // producer's phase beside it, a post-close observation read as a wait the app
    // chose to take before closing.
    name: 'close-lifecycle table reports the cookie flush phase beside the wait, and never guesses one for an unstamped record',
    run: () => {
      const row = (phase) => ({
        platformId: phase ? `indeed-${phase}` : 'indeed-unstamped', mode: 'native-chrome',
        result: 'closed', finishedAt: new Date().toISOString(),
        cookieFlushMs: 1_800, cookieFlushPhase: phase,
      });
      const table = buildAuthLifecycleTableMarkdown([
        row('pre-close-fixed'), row('pre-close-checkpoint'), row('post-close-observe'), row(null),
        { platformId: 'indeed-no-wait', mode: 'native-chrome', result: 'closed', finishedAt: new Date().toISOString() },
      ]);
      assert(!table.includes('Pre-close wait ms')
        && table.includes('| Cookie flush wait ms (phase) |'),
      'the mislabelled pre-close column is replaced by a phase-neutral heading');
      for (const phase of ['pre-close-fixed', 'pre-close-checkpoint', 'post-close-observe']) {
        assert(table.includes(`| 1800 (phase ${phase}) |`),
          `the stamped phase '${phase}' renders beside the measured wait`);
      }
      assert(table.includes('| 1800 (phase not recorded) |'),
        'a record carrying a wait but no stamped phase says so rather than being attributed to a phase');
      assert(table.includes('| — (phase not recorded) |'),
        'a record with neither a wait nor a phase reports both as unrecorded');
      return { phasesRendered: 3 };
    },
  },
  {
    // The table's rows are FILTERED to `puppeteer-visible` / `native-chrome`, but
    // its empty state read "no completed auth window this process" — an assertion
    // of absence the report never observed, printed on the exact table a reader
    // consults to decide whether a window ever opened. A session whose only
    // visible windows were `captcha-resolve` windows retains those records and
    // still empties this table.
    name: 'close-lifecycle empty state describes the mode filter it applied, not an absence of auth windows',
    run: () => {
      const captchaOnly = [0, 1, 2].map(i => ({
        platformId: `captcha:board${i}`, mode: 'captcha-resolve', result: 'closed',
        finishedAt: new Date(Date.now() - (30 - i) * 1000).toISOString(),
      }));
      const filtered = buildAuthLifecycleTableMarkdown(captchaOnly);
      assert(!filtered.includes('no completed auth window this process'),
        'the table may not claim no auth window completed while the ring still retains completed records it filtered out');
      assert(filtered.includes('no retained record has mode `puppeteer-visible` or `native-chrome`')
        && filtered.includes('the 3 other retained record(s) it holds (mode: captcha-resolve)')
        && filtered.includes('Recent login and captcha attempts (this session)'),
      `the empty state counts what the filter excluded, names the modes it saw, and points at the section that lists them → ${filtered.split('\n').pop()}`);

      // The blockquote makes the same scope claim as the empty cell, so it has to
      // name the filter too.
      assert(filtered.includes('whose mode is')
        && filtered.includes('Other retained') && filtered.includes('`captcha-resolve`'),
      'the section prose states which modes become rows instead of claiming every retained auth window is listed');

      // A genuinely empty ring is a different observation and gets different words.
      const none = buildAuthLifecycleTableMarkdown([]);
      assert(none.includes("this process's auth-window ring retains no completed auth window at all")
        && !none.includes('other retained record(s) it holds'),
      'an empty ring says the ring is empty, without inventing excluded records');

      // And when even one row qualifies, no empty state renders at all.
      const mixed = buildAuthLifecycleTableMarkdown([
        ...captchaOnly,
        { platformId: 'indeed-native-challenge', mode: 'native-chrome', result: 'closed', finishedAt: new Date().toISOString() },
      ]);
      assert(mixed.includes('| `indeed-native-challenge` | native-chrome |')
        && !mixed.includes('no retained record has mode')
        && !mixed.includes('| `captcha:board0` |'),
      'a qualifying record renders as a row, the excluded modes stay excluded, and the empty state disappears');
      return { excludedCounted: 3 };
    },
  },
  {
    name: 'session report URLs strip query and fragment tokens in prose and trace fields',
    run: () => {
      const prose = redactReportUrlsInText('Anti-bot at https://secure.indeed.com/settings/account?__cf_chl_rt_tk=secret#step, retry later.');
      const traces = renderSessionTraceBlocks([{ id: 'indeed', name: 'Indeed' }], {
        indeed: { lastTrace: {
          target: 'https://secure.indeed.com/settings/account?target=secret',
          finalUrl: 'https://secure.indeed.com/settings/account?final=secret#hash',
          error: 'Redirected via https://signin.example.test/login?oauth=secret',
          checks: [{
            target: 'https://secure.indeed.com/settings/account?q=secret',
            finalUrl: 'https://secure.indeed.com/settings/account?__cf_chl_rt_tk=secret',
            error: 'failed at https://example.test/path?token=secret',
          }],
        } },
      });
      assert(prose.includes('https://secure.indeed.com/settings/account, retry later.')
        && traces.includes('https://secure.indeed.com/settings/account')
        && !prose.includes('__cf_chl_rt_tk')
        && !traces.includes('secret')
        && !traces.includes('oauth=')
        && !traces.includes('token='),
      'session/auth report formatting keeps URL identity but never exports query/hash tokens');
      return { redacted: true };
    },
  },
{
    // accounts.js writeStatusCache keeps a SEPARATE `lastNegative` slot that
    // only a connected:false write ever touches, so a definitive "not
    // connected" verdict survives a later connected:true write clobbering
    // `lastTrace` (e.g. a startup verify says not-connected, then a login
    // window auto-detects success 5 minutes later). Before this, the platform
    // that actually misbehaved printed nothing but the bare positive verdict —
    // the one platform a bug report couldn't diagnose.
    name: 'session trace labels a prior NOT-CONNECTED verdict as historical and superseded by the current connected confirmation',
    run: () => {
      const platforms = [{ id: 'glassdoor', name: 'Glassdoor' }];

      // Currently connected, but a prior DEFINITIVE not-connected verdict is on
      // record (the in-memory shape: reason + trace + ts). This is exactly the
      // diagnostic that was missing — must render both the current positive
      // trace AND the preserved negative.
      const clobberedTs = Date.now() - 5 * 60 * 1000;
      const reconnected = renderSessionTraceBlocks(platforms, {
        glassdoor: {
          connected: true,
          lastTrace: { target: 'https://www.glassdoor.com/member/home', status: 'auto-detected' },
          lastNegative: {
            reason: 'Reached https://www.glassdoor.com/member/home?token=secret (HTTP 200) without auth redirect or sign-in body.',
            trace: { finalUrl: 'https://www.glassdoor.com/member/home?token=secret', status: 200, bodyHead: 'Sign in to Glassdoor to continue' },
            ts: clobberedTs,
          },
        },
      });
      assert(reconnected.includes('HTTP status: `auto-detected`'),
        'the current positive trace still renders alongside the preserved negative');
      assert(reconnected.includes('ℹ️ historical NOT-CONNECTED verdict; current cached status is connected')
        && !reconnected.includes('⚠️ preserved prior NOT-CONNECTED verdict'),
      'a prior negative is retained as historical evidence without presenting it as a conflicting current warning');
      assert(reconnected.includes('without auth redirect or sign-in body')
        && !reconnected.includes('token=secret'),
      'the preserved negative reason renders but its URL query token is redacted, same as every other trace field');
      assert(reconnected.includes('bodyHead: `Sign in to Glassdoor to continue`')
        && reconnected.includes('HTTP 200'),
      'the preserved negative carries its own nested trace evidence (status/bodyHead), not just the bare reason string');
      assert(reconnected.includes(new Date(clobberedTs).toISOString()),
        'the preserved negative is dated with the same absolute/relative style the surrounding session rows use, so a stale verdict cannot read as this-session');

      // Currently NOT connected: the platform's own reason/trace already say
      // why, so repeating lastNegative here would just restate the same fact.
      const stillDown = renderSessionTraceBlocks(platforms, {
        glassdoor: {
          connected: false,
          lastTrace: { target: 'https://www.glassdoor.com/member/home', status: 200, error: 'no auth redirect' },
          lastNegative: { reason: 'no auth redirect', trace: { status: 200 }, ts: clobberedTs },
        },
      });
      assert(!stillDown.includes('historical NOT-CONNECTED verdict'),
        'a currently-disconnected platform does not repeat lastNegative — its own trace already states the reason');

      // Disk-restored shape (selectRestorableStatuses / persistStatusCache):
      // connected:true, NO lastTrace at all, and lastNegative has only
      // { reason, ts } — never a trace. Must render without crashing on the
      // missing trace, and without fabricating trace lines that were never there.
      const restored = renderSessionTraceBlocks(platforms, {
        glassdoor: {
          connected: true,
          restoredFromDisk: true,
          lastNegative: { reason: 'restored: prior session read not-connected', ts: clobberedTs },
        },
      });
      assert(restored.includes('ℹ️ historical NOT-CONNECTED verdict; current cached status is connected')
        && restored.includes('restored: prior session read not-connected'),
      'a disk-restored entry with no lastTrace at all still surfaces its preserved negative verdict');
      assert(!restored.includes('target:') && !restored.includes('HTTP status:'),
        'a disk-restored entry with no current trace does not fabricate positive-trace lines it never had');

      // No lastNegative at all → completely unaffected (most platforms, most of the time).
      const clean = renderSessionTraceBlocks(platforms, {
        glassdoor: { connected: true, lastTrace: { target: 'https://www.glassdoor.com/member/home', status: 200 } },
      });
      assert(!clean.includes('historical NOT-CONNECTED verdict'),
        'a platform with no recorded lastNegative renders exactly as before');
      return { ok: true };
    },
  },
{
    name: 'FULL report redacts query and fragment tokens from recent main-process logs',
    run: () => {
      const secret = 'main-log-secret-token';
      logger.info(`[Accounts] verifier redirected to https://secure.indeed.com/settings/account?__cf_chl_rt_tk=${secret}#challenge`);
      const report = generateMarkdown({
        description: 'Verify recent-log URL redaction.',
        filterCode: 'FULL',
        nodes: [], edges: [], drawings: [], frontEndState: {},
        nodeInternals: [], nodeComponentStates: [], eventLogs: [],
      }).markdown;
      const logs = report.split('## Recent Main-Process Logs')[1]?.split('\n## Event History')[0] || '';
      assert(logs.includes('https://secure.indeed.com/settings/account')
        && !logs.includes('__cf_chl_rt_tk')
        && !logs.includes(secret)
        && !logs.includes('#challenge'),
      'FULL keeps the diagnostic URL path in main-process logs but never exports query/hash tokens');
      return { redacted: true };
    },
  },
  {
    name: 'Event History redacts renderer URLs and career/search values at the report boundary',
    run: () => {
      const rawUrl = 'https://jobs.example.test/search?query=Principal%20Privacy%20Engineer&token=event-url-secret#details';
      const rawQuery = 'PRIVATE CAREER QUERY, SECOND VALUE';
      const rawRole = 'PRIVATE "TARGET" ROLE, SECOND VALUE';
      const rawPreference = 'PRIVATE PREFERENCE, SECOND VALUE';
      const rawDocumentId = 'PRIVATE-GOOGLE-JOBS-DOCUMENT-ID';
      const report = generateMarkdown({
        description: 'Event-history redaction fixture.', filterCode: 'FULL',
        nodes: [], edges: [], drawings: [], frontEndState: {},
        nodeInternals: [], nodeComponentStates: [],
        eventLogs: [
          `[2026-09-13T04:00:00.000-04:00] [JobSearch] Starting USAJobs background search for query: "${rawQuery}"`,
          `[2026-09-13T04:00:01.000-04:00] [JobSearch] Target role set — skipping query variation generation and searching exactly "${rawRole}"`,
          `[2026-09-13T04:00:02.000-04:00] [JobTree] show more in role "${rawRole}" id=group-1 (now 8/20)`,
          `[2026-09-13T04:00:03.000-04:00] [JobCard] external-link requested id=card-1 q=${rawQuery} htidocid=${rawDocumentId} target=google-jobs`,
          `[2026-09-13T04:00:04.000-04:00] [JobSearch] source=usajobs stage=collecting request=${rawUrl}`,
          `[2026-09-13T04:00:04.500-04:00] [JobSearch] preferences=${rawPreference} stage=scoring`,
          '[2026-09-13T04:00:05.000-04:00] [JobSearch] source=indeed stage=scoring scored=3',
          '[2026-09-13T04:00:06.000-04:00] [JobCard] external-link requested q=present htidocid=missing target=google-jobs',
        ],
      }).markdown;
      const history = report.slice(report.indexOf('## Event History'));
      for (const privateValue of [
        rawUrl,
        'query=Principal%20Privacy%20Engineer',
        'event-url-secret',
        rawQuery,
        rawRole,
        rawPreference,
        rawDocumentId,
        // Catch partial leaks from comma-delimited values and a quote inside
        // a quoted target role, not merely the original whole value.
        'SECOND VALUE',
        'TARGET" ROLE',
      ]) {
        assert(!history.includes(privateValue), `Event History must not export ${privateValue}`);
      }
      assert(history.includes('https://jobs.example.test/search')
        && history.includes('Starting USAJobs background search for query: "[redacted query]"')
        && history.includes('searching exactly "[redacted target role]"')
        && history.includes('show more in role "[redacted role]"')
        && history.includes('q=[redacted query] htidocid=[redacted document identifier] target=google-jobs')
        && history.includes('preferences=[redacted preferences] stage=scoring')
        && history.includes('source=indeed stage=scoring scored=3')
        && history.includes('q=present htidocid=missing target=google-jobs'),
      'Event History retains timestamps, event type, stage, safe URL identity, and non-sensitive diagnostic structure');
      return { redacted: true };
    },
  },
{
    name: 'Indeed native challenge and authenticated resume produce accurate verification/session evidence',
    run: () => {
      assert(indeedWarningRequiresManualVerification({ resumeState: { mode: 'native-challenge' } })
        && !indeedWarningRequiresManualVerification({ resumeState: { mode: 'retry-later' } }),
      'a deferred native challenge counts as manual verification for the run-order history');
      const fresh = authenticatedIndeedScrapeStatus({
        preflightStatus: 'authenticated', hasPPID: true,
        landedUrl: 'https://secure.indeed.com/settings/account?source=resume',
      }, null);
      assert(fresh?.lastReason.includes('freshly observed an authenticated session')
        && fresh?.lastTrace?.status === 'scrape-preflight'
        && authenticatedIndeedScrapeStatus({ preflightStatus: 'authenticated', hasPPID: true }, { code: 'needs-login' }) === null
        && authenticatedIndeedScrapeStatus({ preflightStatus: 'unknown', hasPPID: false }, null) === null,
      'only the scraper\'s affirmative authenticated observation can replace stale restored cache provenance');
      return { manual: true, freshSession: true };
    },
  },
{
    name: 'Job-hub Node Diagnostics distinguishes fetched listings from kept scoring input',
    run: () => {
      const report = generateMarkdown({
        description: 'Counter wording regression fixture.',
        nodes: [{
          id: 'job-hub-counter-fixture', type: 'jobhub',
          data: {
            hubState: 'done', gatheredCount: 31, scrapedCount: 3, resultCount: 3,
            scoredJobs: [{}, {}, {}], enabledSourceIds: ['indeed', 'linkedin'],
            lastCompletedRunAt: Date.UTC(2026, 8, 7, 14, 30, 0),
          },
        }],
        edges: [], drawings: [], frontEndState: {}, nodeComponentStates: [],
        nodeInternals: [{
          id: 'job-hub-counter-fixture', type: 'jobhub', position: { x: 0, y: 0 },
          measured: { width: 260, height: 140 },
        }],
      }).markdown;
      assert(report.includes('scraped: 31 → kept: 3')
        && report.includes('enabledSourceIds: indeed,linkedin')
        && report.includes('lastCompletedRunAt: 2026-09-07T14:30:00.000Z')
        && !report.includes('hubState: done, scraped: 3, results: 3'),
      'Node Diagnostics must keep post-filter counts, source selection, and a safe ISO completion date visible');
      const legacyDefaultReport = generateMarkdown({
        description: 'Legacy source-selection default fixture.',
        nodes: [{ id: 'legacy-job-hub', type: 'jobhub', data: { hubState: 'done', scoredJobs: [] } }],
        edges: [], drawings: [], frontEndState: {}, nodeComponentStates: [],
        nodeInternals: [{ id: 'legacy-job-hub', type: 'jobhub', position: { x: 0, y: 0 }, measured: { width: 260, height: 140 } }],
      }).markdown;
      assert(legacyDefaultReport.includes('enabledSourceIds: default (all known platforms)'),
        'Node Diagnostics must disclose the legacy missing allow-list as the all-platform default');
      return { scraped: 31, kept: 3, legacySelection: 'all' };
    },
  },
{
    name: 'Job-hub Node Diagnostics exposes career identity and drop-lock reason',
    run: () => {
      const nodes = [
        { id: 'emptyhub', type: 'jobhub', data: { hubState: 'empty' } },
        { id: 'lockhub1', type: 'jobhub', data: { hubState: 'empty', inputLocked: true } },
      ];
      const report = generateMarkdown({
        description: 'Copied Job Search drop diagnostics fixture.',
        nodes, edges: [], drawings: [], frontEndState: {}, nodeComponentStates: [], eventLogs: [],
        nodeInternals: nodes.map((node, index) => ({
          id: node.id, type: node.type, position: { x: index * 300, y: 0 },
          measured: { width: 330, height: 813 },
        })),
      }).markdown;
      assert(report.includes('| `emptyhub`')
        && report.includes('careerIdentity: none, dropLock: none')
        && report.includes('| `lockhub1`')
        && report.includes('careerIdentity: present, dropLock: started'),
      'FULL Node Diagnostics must show whether each copied Job Search can accept a career-file drop and why not');
      return { empty: 'unlocked', started: 'started' };
    },
  },
{
    name: 'Login verification timing distinguishes verified, retained, and native-skipped state',
    run: () => {
      const report = buildLoginVerificationTimingMarkdown({
        startedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
        totalMs: 900,
        concurrency: 4,
        platformCount: 7,
        durations: [
          { platformId: 'indeed', ms: 500, connected: true, outcome: 'retained-prior', inconclusive: true, reason: 'transient fetch failure at https://secure.indeed.com/settings/account?__cf_chl_rt_tk=secret' },
          { platformId: 'linkedin', ms: 400, connected: true, outcome: 'verified', reason: 'feed loaded' },
          { platformId: 'mercari', ms: 0, connected: false, outcome: 'skipped-native', reason: 'native read owns login state' },
          { platformId: 'swappa', ms: 0, connected: false, outcome: 'skipped-login-flow', reason: 'login flow owns verification' },
          { platformId: 'legacy-ok', ms: 20, connected: false },
          { platformId: 'legacy-skip', ms: 0, connected: false, skipped: true },
          { platformId: 'failed', ms: 10, connected: false, outcome: 'error', error: 'navigation failed' },
        ],
      });
      assert(report.includes('retained prior: connected (inconclusive verify) — transient fetch failure at https://secure.indeed.com/settings/account')
        && !report.includes('__cf_chl_rt_tk') && !report.includes('secret'),
        'verification timing must not render a retained cache state as freshly connected');
      assert(report.includes('verified connected'),
        'verification timing must mark a fresh verifier verdict');
      const clipped = formatLoginVerificationTimingResult({
        connected: true, outcome: 'retained-prior', inconclusive: true,
        reason: `Anti-bot wall at https://example.test/${'very-long-path/'.repeat(20)}`,
      });
      assert(clipped.endsWith('…') && clipped.length < 280,
        'bounded verification reasons mark truncation with an ellipsis instead of ending mid-token silently');
      assert(report.includes('skipped native read (prior: not connected) — native read owns login state'),
        'verification timing must distinguish an intentional native-read skip');
      assert(report.includes('Platforms considered: 7')
        && report.includes('Fresh verifier attempts: 4 — 2 fresh verdicts; 1 retained prior after inconclusive verify; 1 error')
        && report.includes('Skipped without a verifier navigation: 3 — 1 native-state read; 1 login-flow skip; 1 legacy generic skip'),
      'verification timing must count considered platforms separately from fresh verifier attempts, outcome types, native/login skips, and legacy records');
      return { outcomes: 7 };
    },
  },
{
    name: 'Bug report markdown retains a report larger than the former clipboard cap',
    run: () => {
      const events = Array.from({ length: 3_000 }, (_, i) => `EVT ${i} ${'evidence '.repeat(8)}`);
      const result = generateMarkdown({
        description: 'Uncapped clipboard regression fixture.', filterCode: 'FULL',
        filterStats: { eventsShown: events.length, eventsTotal: events.length, omittedSections: [] },
        nodes: [], edges: [], drawings: [], frontEndState: {},
        nodeInternals: [], nodeComponentStates: [], eventLogs: events,
      });
      assert(result.markdown.length > 50_000 && !result.truncated && !result.hardTruncated,
        'Report generation retains content larger than the former 50k clipboard ceiling');
      // The FULL guidance must describe the CURRENT delivery model: both actions
      // generate identical uncapped content, but Copy writes it to a file and
      // clipboards a pointer while Save to file prompts for a location. The old
      // wording ("export the same report") now reads as "the clipboard holds
      // what Save produces", which is exactly what stopped being true.
      assert(result.markdown.includes('EVT 0 ') && result.markdown.includes('EVT 2999 ')
        && result.markdown.includes('byte-identical uncapped report content')
        && result.markdown.includes('clipboards a short path pointer')
        && !result.markdown.includes('Copy and Save to file export the same report.'),
      'both the oldest and newest retained event lines remain present with accurate export guidance');
      assert(result.markdown.indexOf('EVT 2999 ') < result.markdown.indexOf('EVT 0 ')
        && result.markdown.includes('(timestamp assigned at report export) EVT 2999')
        && result.markdown.includes('Order within this section:** newest first; last row is the oldest retained renderer event')
        && result.markdown.includes('Legacy time-only rows retain their capture time but omit date and offset'),
      'event history is reversed only at export, labels assigned legacy timestamps, and explains its section-local ordering caveat');
      const chronological = ['[01:00:00.000] oldest', 'legacy row', '[01:00:02.000] newest'];
      const stamped = timestampedLogLines(chronological, { basis: 'utc', now: Date.UTC(2026, 0, 1) });
      assert(stamped[0] === chronological[0] && stamped[2] === chronological[2]
        && stamped[1].includes('(timestamp assigned at report export) legacy row')
        && JSON.stringify(newestFirstLogLines(stamped).map(line => line.endsWith('oldest') ? 'oldest' : line.endsWith('newest') ? 'newest' : 'legacy')) === JSON.stringify(['newest', 'legacy', 'oldest']),
      'timestamp assignment preserves captured rows and reversal is newest-first only at the export boundary');
      const mainLogs = buildMainProcessLogsMarkdown(['[01:00:00.000] oldest log', 'legacy main log', '[01:00:02.000] newest log']);
      assert(mainLogs.indexOf('newest log') < mainLogs.indexOf('legacy main log')
        && mainLogs.indexOf('legacy main log') < mainLogs.indexOf('oldest log')
        && mainLogs.includes('(timestamp assigned at report export) legacy main log')
        && mainLogs.includes('Order within this section:** newest first; last row is the oldest retained main-process entry')
        && mainLogs.includes('Timestamps:** full ISO UTC'),
      'main-process logs receive labelled legacy timestamps, newest-first export order, and a section-local ISO caveat');
      const nonUtcLocalDate = {
        getTimezoneOffset: () => 210,
        getFullYear: () => 2026, getMonth: () => 0, getDate: () => 1,
        getHours: () => 23, getMinutes: () => 59, getSeconds: () => 59, getMilliseconds: () => 7,
      };
      const fullLocalIso = '2026-01-01T23:59:59.007-03:30';
      assert(localIsoTimestampWithOffset(nonUtcLocalDate) === fullLocalIso
        && formatEventLogEntry('midnight-boundary event', nonUtcLocalDate) === `[${fullLocalIso}] midnight-boundary event`,
      'new EventLogger rows use a full local ISO timestamp with a non-UTC offset, preserving a midnight crossing date');
      const capturedTimestamps = [
        '[2026-01-01T23:59:59.007-03:30] local ISO',
        '[2026-01-02T03:29:59.007Z] UTC ISO',
        '[23:59:59] legacy seconds',
        '[23:59:59.007–00:00:01.008] legacy range',
      ];
      const recognized = timestampedLogLines(capturedTimestamps, { basis: 'utc', now: Date.UTC(2026, 0, 2) });
      const assigned = timestampedLogLines(['unstamped legacy row'], { basis: 'utc', now: Date.UTC(2026, 0, 2) });
      assert(JSON.stringify(recognized) === JSON.stringify(capturedTimestamps)
        && assigned[0] === '[2026-01-02T00:00:00.000Z] (timestamp assigned at report export) unstamped legacy row',
      'full ISO, second-only, and legacy range timestamps retain capture evidence without a second prefix; unstamped rows receive full ISO UTC');
      return { length: result.markdown.length };
    },
  },
{
    // Regression guard for the commit that quietly deleted the clipboard cap:
    // that rewrite left `generate-bug-report-markdown` (Copy to clipboard) and
    // `export-bug-report` (Save to file) producing byte-IDENTICAL output for an
    // oversized report, because neither applied a size cap any more. This test
    // asserts the two paths must DIVERGE once a report is oversized — that
    // divergence is exactly the assertion that would have caught the deletion.
    name: 'clipboard report IPC saves the full report and clipboards only a pointer to it',
    run: async () => {
      const events = Array.from({ length: 3_000 }, (_, i) => `[12:00:${String(i % 60).padStart(2, '0')}.000] IPC EVT ${i} ${'evidence '.repeat(8)}`);
      const payload = {
        description: 'IPC pointer-delivery fixture.', filterCode: 'FULL',
        filterStats: { eventsShown: events.length, eventsTotal: events.length, omittedSections: [] },
        nodes: [], edges: [], drawings: [], frontEndState: {},
        nodeInternals: [], nodeComponentStates: [], eventLogs: events,
      };
      // The direct, no-options call is the same code path "Save to file" uses
      // (export-bug-report never passes maxChars) — it must stay the complete,
      // uncapped artifact regardless of how large the event history is.
      const direct = generateMarkdown(payload);
      assert(direct.markdown.length > 50_000 && !direct.truncated && !direct.hardTruncated
        && direct.markdown.includes('IPC EVT 0 ') && direct.markdown.includes('IPC EVT 2999 '),
      'direct/uncapped generation (the Save-to-file path) retains the full oversized event history with no cap');

      __resetSavedBugReportPruneForTests();
      registerBugReportHandlers();
      const invoke = ipcMain.__getInvokeHandler('generate-bug-report-markdown');
      const sender = { id: 42_501, isDestroyed: () => false, once: () => {}, removeListener: () => {} };
      const viaIpc = await invoke({ sender }, payload);

      assert(viaIpc.success && viaIpc.delivery === 'file-pointer' && viaIpc.savedPath,
        `the clipboard action should save a report file and return a pointer, got ${JSON.stringify({ delivery: viaIpc.delivery, error: viaIpc.error })}`);
      assert(viaIpc.markdown === undefined,
        'the response must not carry a `markdown` field — a field of that name holding a path pointer would be a lie, and the renderer reads clipboardText');

      // The saved FILE is the complete artifact: it must match the uncapped
      // Save-to-file content exactly, including the oldest event the old capped
      // clipboard path used to shed.
      const savedBody = fs.readFileSync(viaIpc.savedPath, 'utf8');
      assert(savedBody.includes('IPC EVT 0 ') && savedBody.includes('IPC EVT 2999 ')
        && savedBody.length === direct.markdown.length,
      `the saved report file must be the full uncapped report (saved ${savedBody.length} vs direct ${direct.markdown.length})`);

      // The load-bearing assertion, restated for the pointer design: what
      // reaches the clipboard is a SHORT pointer that names the file — never
      // the report body. A regression that reverted to pasting the report
      // inline would fail on both the size and the body-content checks.
      assert(viaIpc.clipboardText.includes(viaIpc.savedPath)
        && viaIpc.clipboardText.length < 4_000
        && viaIpc.clipboardText.length < savedBody.length / 10,
      `the clipboard pointer must name the file and stay far smaller than it (pointer ${viaIpc.clipboardText.length} vs report ${savedBody.length})`);
      assert(!viaIpc.clipboardText.includes('IPC EVT 2999 ') && !viaIpc.clipboardText.includes('IPC EVT 0 '),
        'the clipboard pointer must not carry report body content');
      assert(viaIpc.clipboardText.includes('IPC pointer-delivery fixture.')
        && viaIpc.clipboardText.includes('retained across app restarts'),
      'the pointer should carry the issue description and state that restart does not invalidate it');

      fs.rmSync(viaIpc.savedPath, { force: true });
      return { directLength: direct.markdown.length, pointerLength: viaIpc.clipboardText.length };
    },
  },
{
    name: 'clipboard report falls back to a capped inline report when the file cannot be written',
    run: async () => {
      const events = Array.from({ length: 3_000 }, (_, i) => `[12:00:${String(i % 60).padStart(2, '0')}.000] FB EVT ${i} ${'evidence '.repeat(8)}`);
      const payload = {
        description: 'IPC write-failure fallback fixture.', filterCode: 'FULL',
        filterStats: { eventsShown: events.length, eventsTotal: events.length, omittedSections: [] },
        nodes: [], edges: [], drawings: [], frontEndState: {},
        nodeInternals: [], nodeComponentStates: [], eventLogs: events,
      };
      const direct = generateMarkdown(payload);

      // Occupy the reports directory path with a regular FILE so mkdir fails.
      // A user is never left with nothing to paste just because the disk write
      // failed — the cap machinery survives precisely to serve this path.
      __resetSavedBugReportPruneForTests();
      const dir = savedBugReportDir();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      fs.writeFileSync(dir, 'not a directory', 'utf8');
      try {
        registerBugReportHandlers();
        const invoke = ipcMain.__getInvokeHandler('generate-bug-report-markdown');
        const sender = { id: 42_502, isDestroyed: () => false, once: () => {}, removeListener: () => {} };
        const viaIpc = await invoke({ sender }, payload);
        assert(viaIpc.success && viaIpc.delivery === 'inline-fallback' && viaIpc.saveError,
          `an unwritable reports directory must fall back to inline delivery, got ${JSON.stringify({ delivery: viaIpc.delivery, error: viaIpc.error })}`);
        // These are the ORIGINAL capped-clipboard assertions, re-anchored to the
        // fallback branch they now describe.
        assert(viaIpc.clipboardText.length <= 50_000 && (viaIpc.truncated || viaIpc.hardTruncated)
          && viaIpc.clipboardText.includes('FB EVT 2999 ') && !viaIpc.clipboardText.includes('FB EVT 0 '),
        'the fallback keeps the newest events and sheds the oldest, within the cap');
        assert(viaIpc.clipboardText !== direct.markdown && viaIpc.clipboardText.length < direct.markdown.length,
          'capped fallback output and uncapped direct/save-to-file output must diverge for an oversized report');
        // `reduced` drives the wording the user sees. For THIS oversized payload
        // the fallback genuinely lost content, so it must say so.
        assert(viaIpc.reduced === true,
          'an oversized fallback must report that the copied report was reduced');

        // ...but a SMALL report that merely failed to save is delivered whole,
        // and must not be described as size-capped. `truncated`/`hardTruncated`
        // cannot answer this (routine node-row sampling also switches on with
        // maxChars without setting them), which is why `reduced` is measured.
        const smallPayload = {
          description: 'Small write-failure fixture.', filterCode: 'FULL',
          filterStats: { eventsShown: 2, eventsTotal: 2, omittedSections: [] },
          nodes: [], edges: [], drawings: [], frontEndState: {},
          nodeInternals: [], nodeComponentStates: [],
          eventLogs: ['[12:00:00.000] SMALL EVT 0', '[12:00:01.000] SMALL EVT 1'],
        };
        const smallViaIpc = await invoke({ sender }, smallPayload);
        assert(smallViaIpc.success && smallViaIpc.delivery === 'inline-fallback',
          'the small payload must also take the write-failure fallback');
        // Assert on CONTENT, not byte-equality against a second render: each
        // render stamps its own generation time and relative ages, so two
        // renders of the same payload legitimately differ by a character.
        assert(smallViaIpc.reduced === false,
          `a small fallback report is delivered whole and must not be reported as reduced, got reduced=${smallViaIpc.reduced}`);
        assert(smallViaIpc.clipboardText.includes('SMALL EVT 0') && smallViaIpc.clipboardText.includes('SMALL EVT 1')
          && !smallViaIpc.truncated && !smallViaIpc.hardTruncated
          && !smallViaIpc.clipboardText.includes('row(s) omitted to preserve the clipboard budget'),
        'a small fallback must carry every event with no truncation or row-sampling marker');
        return { fallbackLength: viaIpc.clipboardText.length, smallReduced: smallViaIpc.reduced };
      } finally {
        fs.rmSync(dir, { force: true });
      }
    },
  },
{
    name: 'LAST100 selection stays chronological until the report renders it newest first',
    run: () => {
      const raw = Array.from({ length: 150 }, (_, i) => `[12:01:${String(i % 60).padStart(2, '0')}.000] LAST100 EVT ${i}`);
      const selected = applyBugReportCode(raw, {}, 'LAST100').filteredLogs;
      assert(selected.length === 100 && selected[0] === raw[50] && selected.at(-1) === raw[149],
        'LAST100 selects the newest hundred entries while preserving their chronological order for filtering');
      const report = generateMarkdown({
        description: 'LAST100 export ordering fixture.', filterCode: 'LAST100',
        filterStats: { eventsShown: selected.length, eventsTotal: raw.length, omittedSections: [] },
        nodes: [], edges: [], drawings: [], frontEndState: {},
        nodeInternals: [], nodeComponentStates: [], eventLogs: selected,
      }).markdown;
      const history = report.slice(report.indexOf('## Event History'));
      assert(history.includes('LAST100 EVT 50') && history.includes('LAST100 EVT 149')
        && !history.includes('LAST100 EVT 49')
        && history.indexOf('LAST100 EVT 149') < history.indexOf('LAST100 EVT 50'),
      'the selected newest hundred are rendered newest-first, with the oldest retained row at the tail');
      return { selected: selected.length };
    },
  },
{
    name: 'LinkedIn Solve telemetry reflects the latest attempt and permits cooled same-IP retry',
    run: () => {
      const telemetry = getJobsTelemetry();
      const prior = {
        nodeId: telemetry.nodeId,
        boardNodeId: telemetry.boardNodeId,
        windowId: telemetry.windowId,
        bucketing: telemetry.bucketing,
        sourceEvents: telemetry.sourceEvents,
        sourceEventsT0: telemetry.sourceEventsT0,
        pipeline: telemetry.pipeline,
        resolves: telemetry.resolves,
      };
      try {
        recordJobsSourceScope('linkedin-resolve-telemetry-test', 901);
        telemetry.sourceEvents = {};
        telemetry.sourceEventsT0 = Date.now() - 1_000;
        telemetry.pipeline = { phase: 'completed', active: false, ts: Date.now() - 1_000, pendingSources: [] };

        const first = recordLinkedinResolveAttempt('linkedin', {
          needEnrich: 9, enrichSuccess: 0, walled: true, skippedSameIp: true, warmIp: '70.48.176.119', stillEmpty: 9,
        });
        const second = recordLinkedinResolveAttempt('linkedin', {
          needEnrich: 1, enrichSuccess: 1, walled: false, stillEmpty: 0,
        });
        const latest = telemetry.resolves.linkedin;
        assert(latest === second && second.ts >= first.ts && !('skippedSameIp' in latest) && !('warmIp' in latest),
          'LinkedIn Solve telemetry must be a fresh latest-attempt snapshot, without a prior skip/IP leaking into a successful pass');

        recordLinkedinResolveAttempt('linkedin', {
          needEnrich: 4, enrichSuccess: 2, walled: true, stillEmpty: 2, warmIp: '185.98.171.115',
        });
        const blockedSolveReport = buildJobsPipelineSnapshot(new Set(['linkedin-resolve-telemetry-test']), 901, null);
        assert(blockedSolveReport.includes('hit a guest wall')
          && blockedSolveReport.includes('key may be IP, guest context, or fingerprint/session')
          && blockedSolveReport.includes('Wait about 1 minute then Solve on this IP'),
        'LinkedIn Solve report must present wait-or-switch guidance without asserting an IP-only limit');

        recordJobSourceProgress({ sourceId: 'linkedin', status: 'error', warning: { code: 'linkedin-rate-limited', severity: 'throttle' } });
        telemetry.pipeline = { ...telemetry.pipeline, phase: 'completed', active: false };
        recordJobSourceProgress({ sourceId: 'linkedin', status: 'done', detail: 're-fetch complete' }, {
          updatePipeline: false,
          expectedNodeId: 'linkedin-resolve-telemetry-test',
        });
        assert(telemetry.sourceEvents.linkedin.at(-1).status === 'done'
          && telemetry.pipeline.phase === 'completed' && telemetry.pipeline.active === false,
        'A post-search Solve must update the source trail to done without resurrecting the completed gather stage');

        const justWalled = linkedInSameIpRetryDecision('185.98.171.115', 1_000_000, '185.98.171.115', 1_000_001);
        const cooled = linkedInSameIpRetryDecision('185.98.171.115', 1_000_000, '185.98.171.115', 1_060_000);
        const switched = linkedInSameIpRetryDecision('185.98.171.115', 1_000_000, '149.22.82.90', 1_000_001);
        assert(justWalled.skip && justWalled.retryAfterMs > 0 && !cooled.skip && cooled.retryAfterMs === 0 && !switched.skip,
          'Same-IP retry policy must suppress only the immediate retry, then allow a one-minute cooled retry or an IP change');

        const extractorSource = fs.readFileSync(path.resolve('electron/extractors/apiExtractors.js'), 'utf8');
        const jobsSource = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
        const snapshotSource = fs.readFileSync(path.resolve('electron/ipc/bugReport/jobsSnapshot.js'), 'utf8');
        assert(extractorSource.includes("preferAuthenticated = false")
          && extractorSource.includes('authenticatedPage = await browser.newPage()')
          && extractorSource.includes('applyGuestFallback')
          && extractorSource.includes('const attempted = attemptedIndexes.size'),
        'LinkedIn enrichment must prefer the verified profile page, fall back once to the guest SEO page when needed, and report unique attempted jobs rather than a rotation-sensitive index');
        assert(jobsSource.includes('sameIp.skip && !preferAuthenticated')
          && snapshotSource.includes('profile session → guest fallback'),
        'A previous guest wall must not suppress a verified-session Solve, and the report must disclose an authenticated-to-guest fallback');
        return { latestResolve: latest.enrichSuccess, cooledRetryAllowed: !cooled.skip };
      } finally {
        telemetry.nodeId = prior.nodeId;
        telemetry.boardNodeId = prior.boardNodeId;
        telemetry.windowId = prior.windowId;
        telemetry.bucketing = prior.bucketing;
        telemetry.sourceEvents = prior.sourceEvents;
        telemetry.sourceEventsT0 = prior.sourceEventsT0;
        telemetry.pipeline = prior.pipeline;
        telemetry.resolves = prior.resolves;
      }
    },
  },
{
    name: 'Application failure telemetry and APPLICATION filter remain diagnosable',
    run: () => {
      const prior = getApplicationTelemetry();
      try {
        recordApplicationTelemetry({
          attemptId: 'application-failure-report-test',
          nodeId: 'application-failure-card',
          jobTitle: 'Senior Example Engineer',
          company: 'Example Co',
          status: 'failed',
          stage: 'résumé generation',
          failedStage: 'résumé generation',
          error: 'Gemini quota exhausted after all compatible fallbacks.',
          companyResearch: { available: false, error: 'Research quota exhausted first.' },
          taskRoutes: [
            { task: 'company-research', provider: 'gemini', model: 'gemini-3.7-flash' },
            { task: 'application-resume', provider: 'gemini', model: 'gemini-3.7-flash' },
          ],
          stages: [
            { stage: 'model resolution', ts: Date.now() - 50 },
            { stage: 'company and role research', ts: Date.now() - 20 },
            { stage: 'résumé generation', ts: Date.now() - 1 },
            { stage: 'failed', ts: Date.now() },
          ],
        });
        const report = generateMarkdown({
          description: 'Generate failed.',
          nodes: [{ id: 'application-failure-card', type: 'jobcard', data: {} }],
          edges: [], drawings: [], frontEndState: {}, nodeInternals: [], nodeComponentStates: [],
        }).markdown;
        assert(report.includes('### Application Generation (last)')
          && report.includes('Outcome: **⚠️ failed** · current/final stage: résumé generation')
          && report.includes('Gemini quota exhausted after all compatible fallbacks.')
          && report.includes('Company/role research unavailable — generation used only the scraped job description')
          && report.includes('application-resume → gemini / `gemini-3.7-flash`'),
        'FULL report must retain the failed application attempt, its exact stage/error, research fallback, and task route');

        recordApplicationTelemetry({
          attemptId: 'application-research-degraded-report-test',
          nodeId: 'application-failure-card', jobTitle: 'Senior Example Engineer', company: 'Example Co',
          status: 'completed', stage: 'completed', companyResearch: {
            available: false, error: 'Gemini quota exhausted while searching.',
          },
          jobContext: {
            scrapedDescriptionChars: 0, scrapedDescriptionAvailable: false,
            researchAvailable: false, limitedToMetadata: true,
          },
          taskOutcomes: [
            {
              task: 'company-research', provider: 'gemini', model: null,
              status: 'degraded', error: 'Gemini quota exhausted while searching.',
            },
            {
              task: 'application-letter-needs', provider: 'gemini', model: 'gemini-3.5-flash',
              status: 'completed', fallback: { attempts: 2, reason: 'rate-limit' }, error: null,
            },
          ],
          coverLetter: {
            needsAvailable: true, needsCount: 2, topNeedArgued: true, mappingCount: 1,
            planRetried: false, planDegraded: false, revised: false, pageCount: 1,
            checks: [],
          },
          applicationExport: {
            status: 'saved', destination: '/tmp/Applied Jobs/Example Co/Remote/Senior Example Engineer',
            savedAt: Date.now(), revealSucceeded: true, bundleError: null, integrityVerified: true,
            sync: {
              registered: true, serverListening: true,
              endpoint: 'http://127.0.0.1:43192/application-sync', error: null,
            },
            manifest: [
              { name: 'Application.html', expected: true, exists: true, readable: true, bytes: 82000, sha256: '0123456789abcdef', matchesSource: true, htmlStructureValid: true, htmlPanelCount: 2, syncConfigValid: true },
              { name: 'Resume.pdf', expected: true, exists: true, readable: true, bytes: 105000, sha256: '123456789abcdef0', matchesSource: true, pdfHeaderValid: true, pdfParsed: true, pageCount: 1, firstPagePoints: '612x792' },
              { name: 'Cover Letter.pdf', expected: true, exists: true, readable: true, bytes: 109000, sha256: '23456789abcdef01', matchesSource: true, pdfHeaderValid: true, pdfParsed: true, pageCount: 1, firstPagePoints: '612x792' },
              { name: 'Original Job Listing.md', expected: true, exists: true, readable: true, bytes: 445, sha256: '3456789abcdef012', matchesSource: true, markdownNonEmpty: true },
            ],
          },
        });
        const degradedReport = generateMarkdown({
          description: 'Generate completed without research.',
          nodes: [{ id: 'application-failure-card', type: 'jobcard', data: {} }],
          edges: [], drawings: [], frontEndState: {}, nodeInternals: [], nodeComponentStates: [],
        }).markdown;
        assert(degradedReport.includes('Limited application context:')
          && degradedReport.includes('no scraped job description was captured')
          && degradedReport.includes('scraped description 0 char(s) (missing)')
          && degradedReport.includes('Gemini quota exhausted while searching.')
          && degradedReport.includes('application-letter-needs → gemini / `gemini-3.5-flash` [completed] (fallback after 2: rate-limit)')
          && degradedReport.includes('needs evidence source: job metadata only (title/company/location/salary; no scraped description or research)'),
        'Application report must state when generation had only metadata/career context, not claim an empty scraped description was used');
        assert(degradedReport.includes('### Application Export (last)')
          && degradedReport.includes('Outcome: **saved + integrity verified**')
          && degradedReport.includes('Resume.pdf: readable · 105000 bytes')
          && degradedReport.includes('source bytes exact · PDF header valid · PDF parse valid (1p, 612x792pt)')
          && degradedReport.includes('Local edit Sync: workspace registered · service listening')
          && degradedReport.includes('Opened destination folder: ✅')
          && degradedReport.includes('Submission state: not tracked'),
        'FULL report must include the bounded destination readback manifest and reveal result');

        const filtered = applyBugReportCode([
          '[LocalAI] queued job for application handoff',
          '[import-local-application] failed: invalid result.json',
          '[Canvas] node moved',
          '[Canvas] layout settled',
          '[Canvas] selection changed',
          '[generate-application] old remote failure',
        ], {}, 'APPLICATION');
        assert(filtered.filteredLogs.some(line => /LocalAI/.test(line))
          && filtered.filteredLogs.some(line => /import-local-application/.test(line))
          && !filtered.filteredLogs.some(line => /generate-application/.test(line))
          && filtered.sectionExclusions.has('nodeInternals'),
        'APPLICATION filter selects the local handoff/import lifecycle while omitting dead remote-generation patterns (and retains nearby causal context)');
        const handoff = applyBugReportCode([
          '[LocalAI] Résumé PDF render failed',
          '[Canvas] keyboard shortcut',
          '[Canvas] layout settled',
          '[Canvas] draw finished',
          '[Canvas] selection changed',
          '[get-local-application-status] failed: ENOENT',
          '[Canvas] keyboard shortcut',
          '[Canvas] layout settled',
          '[Canvas] draw finished',
          '[Canvas] node moved',
        ], {}, 'HANDOFF');
        assert(handoff.filteredLogs.some(line => /LocalAI/.test(line))
          && handoff.filteredLogs.some(line => /get-local-application-status/.test(line))
          && !handoff.filteredLogs.some(line => /node moved/.test(line))
          && handoff.sectionExclusions.has('nodeInternals'),
        'HANDOFF filter isolates the Local AI result/feedback/import trail while keeping the app-authored pipeline snapshot');
      } finally {
        recordApplicationTelemetry(prior);
      }
      return { status: 'failed', stage: 'résumé generation' };
    },
  },
{
    name: 'Application telemetry is scoped to the reporting canvas window',
    run: () => {
      const prior = getApplicationTelemetry();
      try {
        recordApplicationTelemetry({
          attemptId: 'application-foreign-window',
          nodeId: 'foreign-application-card',
          windowId: 902,
          jobTitle: 'Foreign Role',
          company: 'Foreign Company',
          status: 'completed',
        });
        const foreign = generateMarkdown({
          description: 'Check this canvas only.',
          nodes: [{ id: 'local-application-card', type: 'jobcard', data: {} }],
          edges: [], drawings: [], frontEndState: {}, nodeInternals: [], nodeComponentStates: [],
        }, 901).markdown;
        assert(!foreign.includes('Foreign Role') && !foreign.includes('Foreign Company'),
          'a FULL report must omit the last application attempt when it belongs to another window');

        recordApplicationTelemetry({
          attemptId: 'application-local-window',
          nodeId: 'local-application-card',
          windowId: 901,
          jobTitle: 'Local Role',
          company: 'Local Company',
          status: 'completed',
        });
        const local = generateMarkdown({
          description: 'Check this canvas only.',
          nodes: [{ id: 'local-application-card', type: 'jobcard', data: {} }],
          edges: [], drawings: [], frontEndState: {}, nodeInternals: [], nodeComponentStates: [],
        }, 901).markdown;
        assert(local.includes('### Application Generation (last)')
          && local.includes('Local Role @ Local Company')
          && !local.includes('Foreign Role'),
        'a same-window application attempt must remain in the FULL report');
      } finally {
        recordApplicationTelemetry(prior);
      }
      return { foreignWindowOmitted: true, localWindowRetained: true };
    },
  },
{
    name: 'Local AI application diagnostics retain the measured handoff trace',
    run: () => {
      const prior = getApplicationTelemetry();
      try {
        recordApplicationTelemetry({
          attemptId: 'local-ai-handoff-report-test', nodeId: 'local-ai-handoff-card', windowId: 901,
          source: 'local-ai', jobTitle: 'Backend Engineer', company: 'Acme', status: 'completed',
          localAi: {
            jobId: '123e4567-e89b-42d3-a456-426614174000',
            handoffHistory: [{
              at: '2026-08-18T05:16:00.000Z', type: 'fit-revision-requested', resultSha256: '0123456789abcdef', revisionRound: 2,
              resume: { pageCount: 2, targetPageCount: 1, layout: { utilization: 0.86 }, attempts: [{ attempt: 1, density: 'default', pageCount: 2 }, { attempt: 2, density: 'compact', pageCount: 2 }] },
              coverLetter: { pageCount: 1, targetPageCount: 1 },
              qualityReview: {
                resume: { decision: 'changed_materially', rationale: 'Removed redundant evidence and retained the job-specific backend proof.' },
                coverLetter: { decision: 'kept_diminishing_returns', rationale: 'No material argument improvement remained after comparison.' },
              },
              detail: 'résumé is 2 pages (target: 1).',
            }, {
              at: '2026-08-18T05:17:00.000Z', type: 'fit-revision-requested', resultSha256: 'fedcba9876543210', revisionRound: 3,
              resume: { pageCount: 1, targetPageCount: 1, layout: { utilization: 0.895641 }, attempts: [{ attempt: 1, density: 'default', pageCount: 1 }] },
              coverLetter: { pageCount: 1, targetPageCount: 1 },
              detail: 'résumé content spans 89.56% of the measured type area, below the 90% minimum.',
            }],
          },
        });
        const report = generateMarkdown({
          description: 'Check the Local AI handoff.',
          nodes: [{ id: 'local-ai-handoff-card', type: 'jobcard', data: {} }],
          edges: [], drawings: [], frontEndState: {}, nodeInternals: [], nodeComponentStates: [],
        }, 901).markdown;
        assert(report.includes('Local AI handoff trace (app-authored event/hash/page measurements; AI-authored quality review):')
          && report.includes('fit-revision-requested · revision 2 · result 0123456789abcdef')
          && report.includes('résumé type area 86%')
          && report.includes('résumé attempts #1=2p, #2[compact]=2p')
          && report.includes('résumé type area 89.56% (below 90% minimum)')
          && report.includes('AI-authored quality review: résumé changed_materially')
          && report.includes('cover letter kept_diminishing_returns'),
      'FULL reports retain the exact app-measured Local AI result/version/page sequence and AI-authored quality disposition needed to audit a claimed revision loop');
      } finally {
        recordApplicationTelemetry(prior);
      }
      return { handoffTrace: true };
    },
  },
{
    name: 'Local AI handoff diagnostics surface the persisted card validation failure',
    run: () => {
      const report = generateMarkdown({
        description: 'The revised Local AI result was not imported.',
        nodes: [{
          id: 'local-ai-invalid-card', type: 'jobcard', data: {
            title: 'Senior Backend Engineer', company: 'Acme',
            localApplication: {
              id: '123e4567-e89b-42d3-a456-426614174000', status: 'invalid',
              message: 'Local AI qualityReview.resume.rationale cannot use page fit as its only quality reason.',
            },
          },
        }],
        edges: [], drawings: [], frontEndState: {}, nodeInternals: [], nodeComponentStates: [],
      }).markdown;
      assert(report.includes('### Local AI Job State (live card snapshot)')
        && report.includes('status: **invalid**')
        && report.includes('qualityReview.resume.rationale cannot use page fit'),
      'FULL/HANDOFF diagnostics expose the persisted Local AI validation error instead of only the prior measured feedback');
      return { localAiInvalidState: true };
    },
  },
{
    name: 'Application Sync telemetry is integrity-rich and scoped to the saved canvas',
    run: () => {
      const prior = getApplicationSyncTelemetry();
      try {
        recordApplicationSyncTelemetry({
          attemptId: 'sync-report-test',
          workspaceDir: '/tmp/canvas-a/Applied Jobs/Example Co/Toronto/Engineer',
          document: 'cover', status: 'completed', phase: 'completed', finishedAt: Date.now(),
          manifest: [
            { name: 'Application.html', readable: true, bytes: 1200, sha256: 'abc123', matchesSource: true, htmlStructureValid: true, syncConfigValid: true },
            { name: 'Cover Letter.pdf', readable: true, bytes: 800, sha256: 'def456', matchesSource: true, pdfParsed: true, pageCount: 1, firstPagePoints: '612x792' },
          ],
        });
        const local = buildJobsPipelineSnapshot([], 901, '/tmp/canvas-a/canvas.json');
        assert(local.includes('### Application Sync (last)')
          && local.includes('completed + integrity verified')
          && local.includes('Document: cover letter')
          && local.includes('PDF parse valid (1p, 612x792pt)')
          && local.includes('source bytes exact'),
        'a FULL report must retain the local Sync outcome and exact-byte/structural readback evidence');

        const foreign = buildJobsPipelineSnapshot([], 901, '/tmp/canvas-b/canvas.json');
        assert(!foreign.includes('### Application Sync (last)') && !foreign.includes('sync-report-test'),
          'a Sync from another canvas Applied Jobs root must not appear in this report');
        return { localRetained: true, foreignOmitted: true };
      } finally {
        recordApplicationSyncTelemetry(prior);
      }
    },
  },
{
    name: 'Résumé retained roles always carry factual bullet evidence',
    run: () => {
      const summaryOnly = `<main class="page"><article class="role"><div class="role-header"><span class="title">Software Engineer</span><span class="company">FliteX</span></div><div class="role-meta"><p class="role-summary">Built shortest-path tooling and FAA data-sync automation.</p></div></article><article class="role"><span class="title">Data Engineer</span><span class="company">Horizon</span><ul class="highlights"><li>Built Python ETL pipelines.</li></ul></article></main>`;
      const missing = retainedResumeRolesWithoutBullets(summaryOnly);
      let rejected = false;
      try { assertRetainedResumeRoleBullets(summaryOnly); } catch { rejected = true; }
      assert(missing.length === 1 && missing[0].company === 'FliteX',
        'a summary-only retained role must be detected before it can ship');
      assert(rejected,
        'a summary-only role must be rejected so unpolished career notes can never be copied into a bullet');

      const renamedRoleMarkup = `<main class="page"><article class="experience-entry"><span class="title">Architect</span><span class="company">Contract Changed Inc.</span><ul class="highlights"><li>Evidence exists but the role contract changed.</li></ul></article></main>`;
      let structuralError = '';
      try { assertRetainedResumeRoleBullets(renamedRoleMarkup); } catch (error) { structuralError = String(error?.message || error); }
      assert(structuralError.includes('structural validation failed')
        && structuralError.includes('no role elements matched')
        && structuralError.includes('design-system role markup may have changed'),
      'a zero-match role parse must fail distinctly instead of passing the bullet safety net');

      const headerOnly = `<main class="page"><article class="role"><span class="title">Intern</span><span class="company">No Evidence Inc.</span></article></main>`;
      assert(retainedResumeRolesWithoutBullets(headerOnly).length === 1,
        'a header-only role must remain detectable for the hard validation gate');
      return { detected: missing.length, rejected: true, structuralGuarded: true };
    },
  },
{
    name: 'Résumé compact density reaches printed @page margins',
    run: () => {
      const css = fs.readFileSync(path.join(process.cwd(), 'Job Application Design System', 'resume.css'), 'utf8');
      assert(css.includes('@page letter-compact') && css.includes('margin: 0.6in 0;')
        && /:root\[data-density="compact"\]\s+\.page\s*\{\s*page:\s*letter-compact;/.test(css),
      'compact density must select a named Letter page with the advertised 0.6in print margins');
      assert(css.includes('@page a4-compact') && css.includes('page: a4-compact;'),
        'A4 + compact must select its own compact named page instead of falling back to full A4 margins');
      // .meta-row is `1fr auto`; a lone cell lands in column one and stops a
      // full --col-gap short of the content edge unless it spans both tracks.
      assert(/\.meta-row\s*>\s*:only-child\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/.test(css),
        'a single-cell meta row must span both columns so it aligns to the content edge');
      return { letterCompact: true, a4Compact: true, onlyChildSpan: true };
  },
},
{
    name: 'Résumé inline annotations preserve the owning bullet typography',
    run: () => {
      const css = fs.readFileSync(path.join(process.cwd(), 'Job Application Design System', 'resume.css'), 'utf8');
      const annotationRule = /\.scope, \.tradeoff, \.annotation-label\s*\{([\s\S]*?)\}/.exec(css)?.[1] || '';
      assert(['font-family', 'font-size', 'font-style', 'font-weight', 'line-height', 'letter-spacing', 'color']
        .every(property => new RegExp(`${property}\\s*:\\s*inherit`).test(annotationRule)),
      'scope and trade-off spans must remain typographically continuous with their bullet');
      assert(!/\.tradeoff\s*\{\s*font-style:\s*italic/.test(css),
        'a trade-off continuation must not switch a bullet to italic mid-sentence');
      return { annotationTypography: 'inherited' };
    },
  },
{
    name: 'Application prompts preserve evidence scope and reject pseudo-growth metrics',
    run: () => {
      const source = fs.readFileSync(path.join(process.cwd(), 'electron', 'ipc', 'jobApplication.js'), 'utf8');
      const routine = fs.readFileSync(path.join(process.cwd(), 'local_ai', 'LOCAL_AI_APPLICATION_ROUTINE.md'), 'utf8');
      assert(!source.includes('_retiredRemoteApplicationGeneration')
        && !source.includes("from './llm.js'")
        && routine.includes('Never add an unrecorded outcome')
        && routine.includes('Never state citizenship, work authorization, residency, visa, or any other legal work status anywhere in the letter'),
      'application truthfulness and letter-scope rules live exclusively in the Local AI routine; the retired API authoring path is absent');
      return { localOnly: true };

    },
  },
{
    name: 'Application workspace requires confirmation for an on-site city mismatch',
    run: () => {
      const doc = buildResumeDocument({
        resumeMainHtml: '<main class="page"><h1 class="name">Derrick</h1></main>',
        docId: 'location-check',
        jobContext: {
          title: 'Security Guard', company: 'Allied Universal',
          candidateLocation: 'Memphis, TN', location: 'Charlotte, NC, United States',
        },
      });
      assert(doc.includes('data-ic-location-check="work-location"')
        && doc.includes('Memphis, TN') && doc.includes('Charlotte, NC, United States')
        && doc.includes('I can work there'),
      'a cross-city on-site application must show a concrete work-location confirmation card');
      assert(doc.includes('var locationBlocked = !!locationCard && !locationConfirmed;')
        && doc.includes('var blocked = locationBlocked || (activeDocument === \'resume\' && reviewBlocked);'),
      'unresolved location confirmation must gate Sync for both résumé and cover-letter documents');
      const sameCity = buildResumeDocument({
        resumeMainHtml: '<main class="page">Same city</main>',
        jobContext: { candidateLocation: 'Charlotte, NC', location: 'Charlotte, NC, United States' },
      });
      assert(!sameCity.includes('data-ic-location-check="work-location"'),
        'format differences within the same city must not create a false relocation check');
      return { mismatchBlocked: true, sameCityClear: true };
    },
  },
{
    name: 'Application bundle replacement removes stale siblings and rolls back a partial promotion',
    run: async () => {
      const dir = await fs.promises.mkdtemp('/tmp/infinite-canvas-application-transaction-');
      const files = {
        html: path.join(dir, 'Application.html'),
        resume: path.join(dir, 'Resume.pdf'),
        cover: path.join(dir, 'Cover Letter.pdf'),
        listing: path.join(dir, 'Original Job Listing.md'),
      };
      try {
        await Promise.all([
          fs.promises.writeFile(files.html, 'old html'),
          fs.promises.writeFile(files.resume, '%PDF-old resume'),
          fs.promises.writeFile(files.cover, '%PDF-old cover'),
          fs.promises.writeFile(files.listing, 'old listing'),
        ]);
        await replaceApplicationBundleAtomically([
          { destination: files.html, data: 'new html' },
          { destination: files.resume, data: null },
          { destination: files.cover, data: '%PDF-new cover' },
          { destination: files.listing, data: null },
        ]);
        assert(await fs.promises.readFile(files.html, 'utf8') === 'new html'
          && await fs.promises.readFile(files.cover, 'utf8') === '%PDF-new cover',
        'a successful transaction promotes every produced artifact');
        assert(!fs.existsSync(files.resume) && !fs.existsSync(files.listing),
          'a new generation that lacks an optional artifact removes the stale prior sibling');

        await Promise.all([
          fs.promises.writeFile(files.html, 'baseline html'),
          fs.promises.writeFile(files.resume, '%PDF-baseline resume'),
          fs.promises.writeFile(files.cover, '%PDF-baseline cover'),
          fs.promises.writeFile(files.listing, 'baseline listing'),
        ]);
        const realOps = fs.promises;
        const failingOps = {
          lstat: (...args) => realOps.lstat(...args),
          writeFile: (...args) => realOps.writeFile(...args),
          unlink: (...args) => realOps.unlink(...args),
          rename: (source, destination) => {
            if (/\.Cover Letter\.pdf\..*\.tmp$/.test(source) && destination === files.cover) {
              return Promise.reject(new Error('simulated cover promotion failure'));
            }
            return realOps.rename(source, destination);
          },
        };
        let failed = false;
        try {
          await replaceApplicationBundleAtomically([
            { destination: files.html, data: 'v2 html' },
            { destination: files.resume, data: '%PDF-v2 resume' },
            { destination: files.cover, data: '%PDF-v2 cover' },
            { destination: files.listing, data: 'v2 listing' },
          ], { fileOps: failingOps });
        } catch (error) {
          failed = /simulated cover promotion failure/.test(error.message);
        }
        assert(failed, 'the injected mid-transaction promotion failure must reach the caller');
        assert(await fs.promises.readFile(files.html, 'utf8') === 'baseline html'
          && await fs.promises.readFile(files.resume, 'utf8') === '%PDF-baseline resume'
          && await fs.promises.readFile(files.cover, 'utf8') === '%PDF-baseline cover'
          && await fs.promises.readFile(files.listing, 'utf8') === 'baseline listing',
        'a partial promotion restores the complete previous bundle, never a mixed generation');
        let verificationFailed = false;
        try {
          await replaceApplicationBundleAtomically([
            { destination: files.html, data: 'unverified html' },
            { destination: files.resume, data: '%PDF-unverified resume' },
          ], { verify: async () => { throw new Error('simulated readback failure'); } });
        } catch (error) {
          verificationFailed = /simulated readback failure/.test(error.message);
        }
        assert(verificationFailed
          && await fs.promises.readFile(files.html, 'utf8') === 'baseline html'
          && await fs.promises.readFile(files.resume, 'utf8') === '%PDF-baseline resume',
        'a failed post-write verification also restores the prior visible artifacts');

        // Sync reads Application.html before it renders a PDF. An external
        // editor can save in the narrow interval before the transaction moves
        // the old HTML to its backup; the backup itself must be compared to
        // that snapshot before any new bytes are promoted, otherwise the
        // editor's newer revision would be deleted as a "successful" backup.
        await fs.promises.writeFile(files.html, 'snapshot before render');
        let injectedExternalSave = false;
        const staleSourceOps = {
          lstat: (...args) => realOps.lstat(...args),
          writeFile: (...args) => realOps.writeFile(...args),
          readFile: (...args) => realOps.readFile(...args),
          unlink: (...args) => realOps.unlink(...args),
          rename: async (source, destination) => {
            if (!injectedExternalSave && source === files.html && /\.bak$/.test(destination)) {
              injectedExternalSave = true;
              await realOps.writeFile(files.html, 'newer external editor revision');
            }
            return realOps.rename(source, destination);
          },
        };
        let staleSourceRejected = false;
        try {
          await replaceApplicationBundleAtomically([
            { destination: files.html, data: 'older rendered HTML', expectedCurrentData: 'snapshot before render' },
          ], { fileOps: staleSourceOps });
        } catch (error) {
          staleSourceRejected = /source changed before promotion/.test(error.message);
        }
        assert(injectedExternalSave && staleSourceRejected
          && await fs.promises.readFile(files.html, 'utf8') === 'newer external editor revision',
        'a save between Sync precheck and backup rename must be restored and must block the older promotion');
        // Subsequent duplicate-destination assertions intentionally use the
        // original baseline fixture.
        await fs.promises.writeFile(files.html, 'baseline html');

        let duplicateRejected = false;
        try {
          await replaceApplicationBundleAtomically([
            { destination: files.html, data: 'first duplicate' },
            { destination: files.html, data: 'second duplicate' },
          ]);
        } catch (error) {
          duplicateRejected = /duplicate destination/.test(error.message);
        }
        assert(duplicateRejected && await fs.promises.readFile(files.html, 'utf8') === 'baseline html',
          'duplicate destinations must be rejected before any staging or visible mutation');

        const directoryDestination = path.join(dir, 'must-remain-a-directory');
        await fs.promises.mkdir(directoryDestination);
        let directoryRejected = false;
        try {
          await replaceApplicationBundleAtomically([{ destination: directoryDestination, data: 'not a directory' }]);
        } catch (error) {
          directoryRejected = /regular file/.test(error.message);
        }
        assert(directoryRejected && (await fs.promises.lstat(directoryDestination)).isDirectory(),
          'a destination directory must never be hidden as a transaction backup or reported as successfully replaced');

        const linkTarget = path.join(dir, 'outside-link-target.txt');
        const linkDestination = path.join(dir, 'linked-destination.txt');
        await fs.promises.writeFile(linkTarget, 'outside bytes');
        await fs.promises.symlink(linkTarget, linkDestination);
        await replaceApplicationBundleAtomically([{ destination: linkDestination, data: 'safe replacement' }]);
        assert(await fs.promises.readFile(linkTarget, 'utf8') === 'outside bytes'
          && !(await fs.promises.lstat(linkDestination)).isSymbolicLink()
          && await fs.promises.readFile(linkDestination, 'utf8') === 'safe replacement',
        'an existing symlink destination is replaced as an object without reading or mutating its target');
        return {
          staleRemoved: 2,
          rollbackRestored: 4,
          readbackRollback: true,
          staleSourceRejected,
          duplicateRejected,
          directoryRejected,
          symlinkTargetUntouched: true,
        };
      } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
      }
  },
},
{
    name: 'Application export integrity parses PDFs and matches every promoted byte',
    run: async () => {
      const dir = await fs.promises.mkdtemp('/tmp/infinite-canvas-application-integrity-');
      const htmlPath = path.join(dir, 'Application.html');
      const pdfPath = path.join(dir, 'Resume.pdf');
      const listingPath = path.join(dir, 'Original Job Listing.md');
      const token = 'a'.repeat(64);
      const html = `<!doctype html><html><body><section data-ic-document-panel="resume"><main class="page">Resume</main></section><section data-ic-document-panel="cover"><main class="page">Cover</main></section><script id="ic-application-bundle-data" type="application/json">{"sync":{"endpoint":"http://127.0.0.1:43192/application-sync","token":"${token}"}}</script></body></html>`;
      const listing = '# Example Role\n\n**Company:** Example Co\n';
      const pdf = await PDFLib.PDFDocument.create();
      pdf.addPage([612, 792]);
      const pdfBytes = Buffer.from(await pdf.save());
      try {
        await Promise.all([
          fs.promises.writeFile(htmlPath, html),
          fs.promises.writeFile(pdfPath, pdfBytes),
          fs.promises.writeFile(listingPath, listing),
        ]);
        const manifest = await inspectApplicationExport([
          { path: htmlPath, expectedData: html, kind: 'html' },
          { path: pdfPath, expectedData: pdfBytes, kind: 'pdf' },
          { path: listingPath, expectedData: listing, kind: 'markdown' },
        ]);
        const pdfRow = manifest.find(row => row.name === 'Resume.pdf');
        assert(manifest.every(row => row.integrityVerified && row.matchesSource)
          && pdfRow?.pdfParsed && pdfRow.pageCount === 1 && pdfRow.firstPagePoints === '612x792',
        'readback must prove exact source bytes and parse a non-empty Letter PDF');

        await fs.promises.writeFile(pdfPath, '%PDF-not-a-real-document');
        let corruptRejected = false;
        try {
          await inspectApplicationExport([{ path: pdfPath, expectedData: Buffer.from('%PDF-not-a-real-document'), kind: 'pdf' }]);
        } catch (error) {
          corruptRejected = /readback failed/.test(error.message);
        }
        assert(corruptRejected, 'a matching %PDF- prefix must not make a structurally corrupt PDF pass readback');

        await fs.promises.writeFile(listingPath, 'different bytes');
        let mismatchRejected = false;
        try {
          await inspectApplicationExport([{ path: listingPath, expectedData: listing, kind: 'markdown' }]);
        } catch (error) {
          mismatchRejected = /readback failed/.test(error.message);
        }
        assert(mismatchRejected, 'destination bytes that differ from the staged source must fail readback');
        let missingSourceRejected = false;
        try {
          await inspectApplicationExport([{ path: listingPath, kind: 'markdown' }]);
        } catch (error) {
          missingSourceRejected = /readback failed/.test(error.message);
        }
        assert(missingSourceRejected, 'an integrity claim requires staged source bytes to compare against');
        return { artifactsVerified: manifest.length, corruptRejected, mismatchRejected, missingSourceRejected };
      } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
      }
    },
  },
{
    name: 'Application Sync persists only the selected panel revision',
    run: () => {
      const workspace = (resume, cover, shell, extra = '') => `<!doctype html><html><body data-shell="${shell}"><section data-ic-document-panel="resume"><main class="page">${resume}</main></section><section data-ic-document-panel="cover"><main class="page">${cover}</main></section>${extra}</body></html>`;
      const stored = workspace('saved resume', 'saved cover', 'stored');
      const incoming = workspace('edited resume<script>steal()</script><img src="https://evil.test/pixel">', 'edited cover', 'incoming', '<script id="attacker-shell">stealShell()</script>');
      const resumeMerged = mergeSelectedApplicationPanel(incoming, stored, 'resume');
      assert(resumeMerged.includes('edited resume') && resumeMerged.includes('saved cover')
        && !resumeMerged.includes('edited cover') && resumeMerged.includes('data-shell="stored"')
        && !resumeMerged.includes('attacker-shell') && !resumeMerged.includes('evil.test'),
      'résumé Sync must sanitize only the selected main and rebuild from the last trusted shell/cover revision');
      const coverMerged = mergeSelectedApplicationPanel(incoming, stored, 'cover');
      assert(coverMerged.includes('saved resume') && coverMerged.includes('edited cover')
        && !coverMerged.includes('edited resume') && coverMerged.includes('data-shell="stored"'),
      'cover Sync must retain only the sanitized incoming cover within the stored shell and résumé revision');
      let malformedRejected = false;
      try {
        mergeSelectedApplicationPanel('<html><body></body></html>', stored, 'resume');
      } catch (error) {
        malformedRejected = /exactly one resume panel/.test(error.message);
      }
      assert(malformedRejected, 'Sync must reject a workspace that cannot preserve its inactive panel');
      let missingSelectedRejected = false;
      try {
        mergeSelectedApplicationPanel('<html><body><section data-ic-document-panel="cover"><main class="page">Cover only</main></section></body></html>', stored, 'resume');
      } catch (error) {
        missingSelectedRejected = /exactly one resume panel/.test(error.message);
      }
      let duplicateRejected = false;
      try {
        mergeSelectedApplicationPanel(incoming.replace('</body>', '<section data-ic-document-panel="cover"><main class="page">Duplicate</main></section></body>'), stored, 'resume');
      } catch (error) {
        duplicateRejected = /exactly one cover panel \(found 2\)/.test(error.message);
      }
      assert(missingSelectedRejected && duplicateRejected,
        'Sync must reject a missing selected panel and duplicate selected/inactive panels before rendering');
      const token = 'f'.repeat(64);
      const storedWithCapability = workspace('saved resume', 'saved cover', 'stored', `<script id="ic-application-bundle-data" type="application/json">{"sync":{"endpoint":"http://127.0.0.1:43192/application-sync","token":"${token}"}}</script>`);
      const incomingWithCapability = workspace('edited resume', 'edited cover', 'attacker');
      const capabilityMerged = mergeSelectedApplicationPanel(incomingWithCapability, storedWithCapability, 'resume', { expectedToken: token });
      let wrongCapabilityRejected = false;
      try { mergeSelectedApplicationPanel(incomingWithCapability, storedWithCapability, 'resume', { expectedToken: 'e'.repeat(64) }); }
      catch (error) { wrongCapabilityRejected = /capability does not match/.test(error.message); }
      assert(capabilityMerged.includes(token) && capabilityMerged.includes('data-shell="stored"') && wrongCapabilityRejected,
        'Sync must retain and verify the saved capability instead of accepting browser-supplied shell data');
      const storedReviewShell = workspace('saved resume', 'saved cover', 'stored', '<article data-ic-insight="skill-1" data-ic-kind="verify"><button>Review</button></article><article data-ic-location-check="work-location"><button>Location</button></article>');
      const incomingReviewShell = workspace('edited resume', 'edited cover', 'incoming', '<article data-ic-insight="skill-1" data-ic-kind="verify" data-ic-decision="verified" onclick="steal()" data-attacker="yes"><button>Replaced attacker control</button></article><article data-ic-location-check="work-location" data-ic-location-decision="confirmed" onmouseover="steal()"><button>Replaced attacker location</button></article><article data-ic-insight="unknown-skill" data-ic-kind="verify" data-ic-decision="verified"></article>');
      const reviewMerged = mergeSelectedApplicationPanel(incomingReviewShell, storedReviewShell, 'cover');
      assert(reviewMerged.includes('data-ic-insight="skill-1" data-ic-kind="verify" data-ic-decision="verified"')
        && reviewMerged.includes('data-ic-location-check="work-location" data-ic-location-decision="confirmed"')
        && reviewMerged.includes('<button>Review</button>') && reviewMerged.includes('<button>Location</button>')
        && !reviewMerged.includes('onclick=') && !reviewMerged.includes('onmouseover=')
        && !reviewMerged.includes('data-attacker=') && !reviewMerged.includes('unknown-skill'),
      'Sync may copy only bounded review-state enum attributes onto matching trusted controls, never incoming shell markup/attrs');

      const storedReceipt = workspace(
        'Saved <span data-achievement-id="a1" data-derivation="trusted ledger calculation">74%</span>',
        'saved cover',
        'stored',
      );
      const forgedReceipt = workspace(
        'Edited <span data-achievement-id="a1" data-derivation="forged browser tooltip">74%</span>',
        'edited cover',
        'incoming',
      );
      const receiptMerged = mergeSelectedApplicationPanel(forgedReceipt, storedReceipt, 'resume');
      assert(receiptMerged.includes('data-achievement-id="a1" data-derivation="trusted ledger calculation"')
        && !receiptMerged.includes('forged browser tooltip'),
      'Sync must restore a matching receipt derivation only from the stored trusted page');
      const changedReceipt = mergeSelectedApplicationPanel(
        forgedReceipt.replace('>74%</span>', '>75%</span>'),
        storedReceipt,
        'resume',
      );
      assert(changedReceipt.includes('data-achievement-id="a1">75%</span>')
        && !changedReceipt.includes('data-derivation="trusted ledger calculation"'),
      'editing a receipt value must remove its prior trusted derivation instead of borrowing it by id');
      const ambiguousStoredReceipt = workspace(
        'Saved <span data-achievement-id="a1" data-derivation="first calculation">74%</span><span data-achievement-id="a1" data-derivation="conflicting calculation">74%</span><span data-achievement-id="a1" data-derivation="first calculation">74%</span>',
        'saved cover',
        'stored',
      );
      const ambiguousReceiptMerged = mergeSelectedApplicationPanel(
        workspace('Edited <span data-achievement-id="a1">74%</span>', 'edited cover', 'incoming'),
        ambiguousStoredReceipt,
        'resume',
      );
      assert(!ambiguousReceiptMerged.includes('data-derivation='),
        'a conflicting trusted receipt key must remain permanently ambiguous; a later duplicate cannot re-authorize it');
      return {
        resumeIsolated: true,
        coverIsolated: true,
        malformedRejected,
        missingSelectedRejected,
        duplicateRejected,
        wrongCapabilityRejected,
        reviewStatePreserved: true,
        receiptDerivationBound: true,
        ambiguousReceiptRejected: true,
      };
    },
  },
{
    name: 'Application report renders skill-opportunity detail, honest fit-loop labeling, and the Skills-block sample',
    run: () => {
      const prior = getApplicationTelemetry();
      try {
        // A completed generation whose verify-item sample was capped (25
        // analyzed, only 20 kept) — the report must show the kept items AND
        // say plainly how many were left out, per the clipboard-cap
        // truncation-marking convention used everywhere else in this section.
        const verifySample = Array.from({ length: 20 }, (_, i) => ({
          canonicalSkillName: `Skill ${i}`,
          resumeCategory: i === 0 ? 'Infrastructure' : 'Certifications',
        }));
        recordApplicationTelemetry({
          attemptId: 'application-skillops-report-test',
          nodeId: 'application-skillops-card',
          jobTitle: 'Platform Engineer',
          company: 'Example Co',
          status: 'completed',
          stage: 'completed',
          companyResearch: { available: true, error: null },
          coverLetter: {
            salutation: 'Dear Example Co Hiring Team,', recipient: '',
            paragraphs: ['A concise thesis.', 'A grounded mechanism.'], closing: 'Sincerely,',
            signatureTitle: 'Platform Engineer · candidate', contact: ['Toronto, ON'],
            needsAvailable: true, needsCount: 3, topNeedArgued: true, mappingCount: 1,
            droppedNeeds: [{ need: 'Own the data plane', reason: 'No résumé evidence supports it.' }],
            planRetried: true, planRetryReason: 'first mapping was not grounded', planDegraded: false,
            checks: [
              { id: 'evidence-grounding', passed: true, detail: 'one mapping grounded' },
              { id: 'company-specificity', passed: false, detail: 'no research-sourced specific appears in the letter' },
            ],
            revised: true, revisionError: null, pageCount: 1,
          },
          coverLetterPlan: {
            roleThesis: 'Operational judgment is the relevant through-line.',
            mappings: [{ needIndex: 0, evidence: 'Triaged incomplete reports under time pressure.' }],
            companyHook: { detail: '', source: '', whyItMattersToCandidate: '' },
            logistics: '', droppedNeeds: [{ needIndex: 2, reason: 'No résumé evidence supports it.' }],
          },
          achievements: { source: 'reused', kept: 8, suppressedWeakened: 1, stats: null, minedBy: null },
          variantAttrs: 'data-print="ink-only" data-mono',
          resumeHtmlSample: '<main class="page" data-print="ink-only" data-mono><section class="section"><h1>Jordan Rivera</h1></section>',
          resumeSkillsDlSample: {
            found: true,
            sample: '<dl class="skills">\n  <dt>Infrastructure</dt>\n  <dd>Kubernetes<span class="sep" data-ic-inferred-separator="join" hidden>·</span><span class="ic-inferred-skill" data-ic-inferred-skill="skill-1" hidden>Terraform</span></dd>\n</dl>',
            truncated: false,
          },
          resumeRoleBlockSample: {
            found: true,
            roleCount: 3,
            sample: '<article class="role"><div class="role-header meta-row"><p class="role-title-line"><span class="title">Security Officer</span></p><p class="role-dates">Oct 2024 – Present<span class="sep" aria-hidden="true">·</span>Memphis, TN</p></div><ul class="highlights"><li>One</li></ul></article>',
            truncated: false,
          },
          skillOpportunities: {
            itemCount: 25, verifyCount: 25, learnCount: 0, histogramRoleCount: 3,
            error: null, recordedAfterArtifacts: true,
            verifyItems: { sample: verifySample, total: 25, truncated: true },
          },
          render: {
            targetPageCount: 1, attempts: [{ attempt: 1, density: null, pageCount: 2, fontsLoaded: true }],
            initialPageCount: 2, finalPageCount: 2, compactApplied: true, revisionApplied: true,
            revisionDiagnostics: {
              input: { chars: 7000, hash: 'aaaaaaaaaaaa', bullets: 9, roleSummaries: 3, skillRows: 4 },
              editorOutput: { chars: 5600, hash: 'cccccccccccc', bullets: 8, roleSummaries: 0, skillRows: 4 },
              output: { chars: 5100, hash: 'bbbbbbbbbbbb', bullets: 6, roleSummaries: 0, skillRows: 4 },
            },
            pdfProduced: true, baselinePdfProduced: true,
            baselinePageCount: 1, baselinePdfError: null, baselineFontsLoaded: true,
            coverLetterPdfProduced: true, coverLetterPdfError: null, coverLetterFontsLoaded: true,
            resumeRequiresReview: true, locationReviewRequired: true,
            candidateLocation: 'Memphis, TN', jobLocation: 'Charlotte, NC, United States',
            error: null, fontsLoaded: true,
          },
        });
        const report = generateMarkdown({
          description: 'Generate completed with skill-opportunity detail.',
          nodes: [{ id: 'application-skillops-card', type: 'jobcard', data: {} }],
          edges: [], drawings: [], frontEndState: {}, nodeInternals: [], nodeComponentStates: [],
        }).markdown;

        assert(report.includes('Skill-opportunity analysis: 25 item(s) — 25 verify, 0 learn · histogram 3 role(s) · demand recorded after artifacts'),
          'Report must render the skill-opportunity counts and recordedAfterArtifacts flag');
        assert(report.includes('"Skill 0" → "Infrastructure"') && report.includes('"Skill 19" → "Certifications"'),
          'Report must render per-item canonical skill name → résumé category pairs');
        assert(report.includes('_5 additional verify item(s) omitted from this bounded sample._'),
          'Report must mark the verify-item sample as truncated with an exact count, not emit silently');
        assert(report.includes('Résumé variant: `data-print="ink-only" data-mono`'),
          'Report must render the captured variantAttrs as a structured field');
        // The head slice dies inside the first role header, so without this
        // block the Experience structure the fit loop edits is invisible.
        assert(report.includes('Résumé role block (first of 3 `<article class="role">`')
          && report.includes('<p class="role-dates">Oct 2024 – Present'),
          'Report must render a whole role block so the shipped Experience structure is visible');
        assert(report.includes('AI editor output: 5600 chars · bullets 8'),
          'Report must expose the AI editor output without a source-order structural clamp');
        assert(report.includes('1 refute-weakened item(s) withheld from application prompts'),
          'Report must say when a cached achievement remains auditable but is intentionally unavailable to résumé/letter generation');
        // The fit-loop measures the worst case (all candidate skills shown);
        // the shipped baseline is a separate, honestly-labeled number that
        // must never be conflated with it (this report's whole reason for
        // existing — see Defect 2).
        assert(report.includes('Résumé fit-loop (worst case, ALL candidate skills shown — NOT the shipped page count): target 1p · 2→2p · compact applied · 1 length-revision call')
          && !report.includes('Résumé render/fit:'),
          'Fit-loop line must be relabeled as the worst-case measurement, not implied to be the delivered document');
        assert(report.includes('Résumé shipped baseline: 1p · PDF produced'),
          'Report must record the shipped baseline page count separately, obtained free from the baseline PDF render');
        assert(report.includes('length revision: 7000→5100 chars · bullets 9→6 · role summaries 3→0 · skill rows 4→4 · hash aaaaaaaaaaaa→bbbbbbbbbbbb'),
          'Report must show whether the length editor actually changed structure, not only that it was called');
        assert(report.includes('Work-location confirmation required before Sync: candidate `Memphis, TN` → job `Charlotte, NC, United States`'),
          'Report must expose a candidate/job city mismatch and the required confirmation gate');
        assert(report.includes('<dl class="skills">') && report.includes('Terraform'),
          'Report must include the résumé\'s Skills <dl> block, where skill-opportunity injection actually lands');
        assert(report.includes('Cover-letter harness: needs available (3) · top need argued · 1 mapping(s) · plan retried once')
          && report.includes('company-specificity: no research-sourced specific appears in the letter'),
        'Report must surface the harness lifecycle and factual unmet-check observation');
        assert(report.includes('Cover-letter argument plan')
          && report.includes('Operational judgment is the relevant through-line.'),
        'Report must include the persisted typed argument plan that explains the generated prose');

        // A second generation whose résumé genuinely had no Skills section —
        // the report must say so explicitly rather than rendering nothing.
        recordApplicationTelemetry({
          attemptId: 'application-skillops-no-skills-report-test',
          nodeId: 'application-skillops-card', jobTitle: 'Platform Engineer', company: 'Example Co',
          status: 'completed', stage: 'completed',
          resumeHtmlSample: '<main class="page"><section class="section"><h1>Jordan Rivera</h1></section>',
          resumeSkillsDlSample: { found: false, sample: '', truncated: false },
          skillOpportunities: { itemCount: 0, verifyCount: 0, learnCount: 0, histogramRoleCount: 3, error: null },
        });
        const noSkillsReport = generateMarkdown({
          description: 'Generate completed with no Skills block.',
          nodes: [{ id: 'application-skillops-card', type: 'jobcard', data: {} }],
          edges: [], drawings: [], frontEndState: {}, nodeInternals: [], nodeComponentStates: [],
        }).markdown;
        assert(noSkillsReport.includes('⚠️ Résumé Skills block (`<dl class="skills">`) was not found in the final document.'),
          'Report must state explicitly when the Skills block is absent, not emit nothing (Defect 3\'s own diagnostics principle)');
      } finally {
        recordApplicationTelemetry(prior);
      }
      return { verifyItemsSampled: 20, verifyItemsTotal: 25 };
    },
  },
{
    name: 'Bug report preserves failed diagnostic sections and profile reservations',
    run: () => {
      const releaseReservation = reserveSharedProfile('captcha-resolve:bug-report-test');
      try {
        const malformedMedia = {
          tag: 'video',
          seekable: {
            length: 1,
            map: () => { throw new Error('malformed media\n`payload`'); },
          },
        };
        const report = generateMarkdown({
          description: 'The browser is busy.',
          nodes: [], edges: [], drawings: [], frontEndState: {},
          nodeInternals: [], nodeComponentStates: [], mediaState: [malformedMedia],
        }).markdown;
        assert(report.includes('## Media Player State')
          && report.includes('section failed to render: `malformed media \'payload\'`'),
        'Bug report must visibly preserve a bounded, sanitized marker when a section renderer fails');
        assert(report.includes('Shared profile reservation: `captcha-resolve:bug-report-test`')
          && report.includes('a headless scrape must wait until that visible browser closes'),
        'Bug report must show an active shared-profile reservation even before a browser launches');
      } finally {
        releaseReservation();
      }
      return { ok: true };
    },
  },
{
    name: 'LinkedIn shared-profile reservation is explicit and retryable',
    run: () => {
      const jobs = [{ url: 'https://www.linkedin.com/jobs/view/1', snippet: '' }];
      const reserved = linkedInBrowserUnavailableResult(
        jobs,
        new Error('Shared browser profile is reserved for captcha-resolve:captcha:www.glassdoor.com; headless stealth browser cannot start until that visible browser closes.'),
      );
      assert(reserved.browserUnavailable === true && reserved.profileReserved === true && reserved.retryable === true,
        'shared-profile collision must be explicit and retryable, never a clean LinkedIn pass');
      assert(reserved.successCount === 0 && reserved.jobs === jobs,
        'collision preserves un-enriched jobs and reports zero enrichment');
      const warning = linkedInBrowserUnavailableWarning(reserved);
      assert(warning.code === 'browser-profile-reserved' && warning.severity === 'throttle' && warning.shortLabel === 'Browser busy',
        'collision renders an actionable retryable source warning');
      assert(/close the other captcha\/login window/i.test(warning.suggestion),
        'retry guidance explains how to release the shared profile');

      const unavailable = linkedInBrowserUnavailableResult(jobs, new Error('Chrome failed to launch'));
      assert(unavailable.browserUnavailable === true && unavailable.profileReserved === false && unavailable.retryable === true,
        'non-reservation browser startup failures also cannot be laundered into clean completion');
      return { code: warning.code, profileReserved: reserved.profileReserved };
    },
  },
{
    name: 'job pipeline report: LinkedIn browser contention is retryable, not clean',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId,
        linkedinEnrich: telemetry.linkedinEnrich,
        linkedinCooldown: telemetry.linkedinCooldown,
      };
      Object.assign(telemetry, {
        nodeId: 'linkedin-browser-contention',
        linkedinEnrich: [{
          ts: Date.now(),
          startedAt: Date.now() - 1000,
          kind: 'search',
          browserUnavailable: true,
          stillEmpty: 3,
          enriched: 0,
        }],
        linkedinCooldown: { running: false, attempts: 2, foundMs: null, waitsMs: [60000], browserUnavailable: true },
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['linkedin-browser-contention']), null, null);
        assert(report.includes('browser/profile contention — retryable'),
          'profile reservation renders as a retryable browser contention outcome');
        assert(report.includes('not a clean finish or a guest-limit result'),
          'residual explains that contention did not prove LinkedIn recovered');
        assert(report.includes('Cooldown probe paused — browser/profile contention'),
          'a contention-paused cooldown probe is not reported as exhausted');
        assert(!report.includes('**clean finish (cold)**'),
          'contention-only trail must never be labelled clean');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
  },
},
{
    name: 'job pipeline report: LinkedIn scope and cooldown inferences require a stable IP/browser identity',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId,
        windowId: telemetry.windowId,
        linkedinEnrich: telemetry.linkedinEnrich,
        linkedinCooldown: telemetry.linkedinCooldown,
      };
      const now = Date.now();
      try {
        // This mirrors the misleading real-world pattern: every pass uses the
        // same browser generation, but each one receives a smaller pool and a
        // different VPN egress. The final clean result cannot be credited to a
        // 40s cooldown, and the falling yield cannot identify a session limit.
        Object.assign(telemetry, {
          nodeId: 'linkedin-identity-controls', windowId: null, linkedinCooldown: null,
          linkedinEnrich: [
            { ts: now - 60_000, startedAt: now - 65_000, kind: 'search', ip: '70.0.0.1', walled: true, attempted: 58, remainingBefore: 58, enriched: 16, stillEmpty: 42, browserGen: 2 },
            { ts: now - 40_000, startedAt: now - 45_000, kind: 'solve', ip: '185.0.0.1', walled: true, attempted: 42, remainingBefore: 42, enriched: 4, stillEmpty: 38, browserGen: 2 },
            { ts: now - 20_000, startedAt: now - 25_000, kind: 'solve', ip: '141.0.0.1', walled: true, attempted: 38, remainingBefore: 38, enriched: 5, stillEmpty: 33, browserGen: 2 },
            { ts: now - 1_000, startedAt: now - 6_000, kind: 'solve', ip: '149.0.0.1', walled: false, attempted: 1, remainingBefore: 1, enriched: 1, stillEmpty: 0, browserGen: 2 },
          ],
        });
        const changedIpReport = buildJobsPipelineSnapshot(new Set(['linkedin-identity-controls']), null, null);
        assert(changedIpReport.includes('cannot identify whether the ceiling is IP- or browser/session-scoped')
          && changedIpReport.includes('remaining input pool also shrank')
          && changedIpReport.includes('attempted 1'),
        'changed-IP, shrinking-pool trail must be explicitly inconclusive and expose per-pass workload');
        assert(!changedIpReport.includes('yield collapsed')
          && !changedIpReport.includes('That points to a **browser/session-scoped** limit')
          && !changedIpReport.includes('Cooldown ≈')
          && changedIpReport.includes('Cooldown cannot be estimated from this trail'),
        'changed IPs must not be turned into a browser-scope verdict or a cooldown estimate');

        telemetry.linkedinCooldown = {
          running: false, attempts: 2, foundMs: null, waitsMs: [60_000], identityChanged: true,
          expectedIdentity: { ip: '70.0.0.1', browserGen: 2 },
          observedIdentity: { ip: '149.0.0.1', browserGen: 2 },
        };
        const invalidProbeReport = buildJobsPipelineSnapshot(new Set(['linkedin-identity-controls']), null, null);
        assert(invalidProbeReport.includes('Cooldown probe invalid — IP/browser identity changed')
          && !invalidProbeReport.includes('Cooldown confirmed:'),
        'an automated probe with a changed egress/browser identity must be marked invalid, never confirmed');

        // A cooldown bound is allowed only when the prior wall and retry share
        // both observed egress IP and browser generation.
        Object.assign(telemetry, {
          linkedinCooldown: null,
          linkedinEnrich: [
            { ts: now - 30_000, startedAt: now - 35_000, kind: 'search', ip: '70.0.0.1', walled: true, attempted: 10, remainingBefore: 10, enriched: 2, stillEmpty: 8, browserGen: 3 },
            { ts: now - 1_000, startedAt: now - 6_000, kind: 'solve', ip: '70.0.0.1', walled: false, attempted: 8, remainingBefore: 8, enriched: 8, stillEmpty: 0, browserGen: 3 },
          ],
        });
        const stableIdentityReport = buildJobsPipelineSnapshot(new Set(['linkedin-identity-controls']), null, null);
        assert(stableIdentityReport.includes('Cooldown on IP 70.0.0.1, browser#3: ≤ 24s'),
          'a clean retry after a wall can bound cooldown only for its matching IP/browser identity');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { changedIpInconclusive: true, stableIdentityBounded: true };
    },
  },
{
    name: 'job pipeline report: saved LinkedIn short-description input overrides stale clean telemetry',
    run: () => {
      const dir = path.join(electronPkg.app.getPath('userData'), 'job-search');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'job-search-last-scrape.json'), JSON.stringify({ jobs: [{
        source: 'linkedin', title: 'Maintenance Technician II', company: 'Acme',
        url: 'https://linkedin.example/jobs/short', snippet: 'Short listing-card excerpt only. '.repeat(3),
        salary: '', posted: '2026-08-01',
      }] }), 'utf8');

      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search,
        linkedinEnrich: telemetry.linkedinEnrich, linkedinCooldown: telemetry.linkedinCooldown,
      };
      Object.assign(telemetry, {
        nodeId: 'linkedin-short-snapshot', windowId: null,
        search: { ts: Date.now(), queries: 1, raw: 1, deduped: 1, ageDropped: 0, historyDropped: 0, kept: 1 },
        linkedinEnrich: [{
          ts: Date.now(), startedAt: Date.now() - 1000, kind: 'search', browserGen: 1,
          walled: false, enriched: 1, stillEmpty: 0, noDesc: 0, noDescSoftBlock: 0, noDescGenuine: 0,
        }],
        linkedinCooldown: null,
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['linkedin-short-snapshot']), null, null);
        assert(report.includes('Completion telemetry disagrees with the legacy scoring snapshot')
          && report.includes('Maintenance Technician II')
          && report.includes('https://linkedin.example/jobs/short')
          && report.includes('Do not treat this as a clean full-description finish'),
        'saved scoring input is authoritative and the report includes bounded title/URL evidence for the short row');
        assert(!report.includes('Residual: 0 below enrichment threshold'),
          'stale process telemetry cannot bless a saved sub-threshold description as complete');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
    },
  },
  {
    name: 'Job scoring: structured evidence contract grounds every material requirement and evaluates hiring fit without false probability',
    run: () => {
      const careerData = 'Software Engineer\nBuilt and maintained React and Django services from May 2023 through June 2026.';
      const { snapshot: grounded } = buildJobAnalysisSnapshot({
        jobs: [{ title: 'Systems Engineer', company: 'Example', snippet: 'Required: production system design experience.' }],
        profile: { titles: ['Software Engineer'], experience_years: 3.1 },
        careerData,
        nodeId: 'scoring-grounding-fixture',
        targetRole: 'Systems Engineer',
        snapshotContext: {},
      });
      const { snapshot: legacy } = buildJobAnalysisSnapshot({
        jobs: [], profile: { titles: ['Software Engineer'] }, nodeId: 'legacy-profile-fixture', snapshotContext: {},
      });
      const { snapshot: bounded } = buildJobAnalysisSnapshot({
        jobs: [], profile: { titles: ['Software Engineer'] }, careerData: 'x'.repeat(80_001),
        nodeId: 'bounded-career-data-fixture', snapshotContext: {},
      });
      const scoreProperties = JOB_SCORING_SCHEMA.properties.scores.items.properties;
      const assessment = scoreProperties.requirementAssessments.items;
      const gap = scoreProperties.materialGaps.items;
      assert([
        'CANDIDATE CAREER EVIDENCE (primary evidence text', careerData,
        'requirementAssessments', 'materialGaps must include EVERY scored required or important professional requirement', 'total professional tenure separate',
        'valid workHistory roleIds',
        'comparative professional fit score', 'NOT a statistically calibrated prediction',
        'preferred qualification is not automatically',
        'NON-SCORING logistics', 'contribute ZERO penalty',
        'concise recount of the candidate\'s experience',
        'not documented in the supplied career data',
        'contradicted requires verbatim candidate evidence',
        'never infer contradiction from absence',
      ].every(fragment => grounded.cachedPrefix.includes(fragment))
        && !grounded.cachedPrefix.includes('primary citation source')
        && grounded.cachedPrefix.includes('"materialGaps": [{')
        && !grounded.cachedPrefix.includes('"experienceAssessment": {')
        && grounded.careerData === careerData,
      'scoring prompt treats concise career data as bounded evidence, requires evidence-qualified gap coverage, and persists it for saved-scrape re-scores');
      assert(legacy.cachedPrefix.includes('only candidate evidence available for this legacy request')
        && legacy.cachedPrefix.includes('When using candidate evidence, quote this profile exactly')
        && !legacy.cachedPrefix.includes('When citing candidate evidence'),
      'legacy direct score calls retain profile-only grounding without prompting the chat application to produce a citation');
      assert(bounded.cachedPrefix.includes('text beyond that boundary is unavailable for quoting')
        && !bounded.cachedPrefix.includes('unavailable for citation'),
      'bounded career evidence describes unavailable source text as quote material rather than inviting an attachment citation');
      assert(JOB_SCORING_SCHEMA.properties.scores.items.required.includes('requirementAssessments')
        && JOB_SCORING_SCHEMA.properties.scores.items.required.includes('materialGaps')
        && !JOB_SCORING_SCHEMA.properties.scores.items.required.includes('experienceAssessment')
        && JOB_SCORING_SCHEMA.properties.scores.items.required.includes('confidence')
        && assessment.required.join('|') === 'requirementText|priority|jobEvidence|status|candidateEvidence|explanation'
        && assessment.properties.status.enum.join('|') === 'direct|adjacent'
        && scoreProperties.requirementAssessments.minItems === 0
        && scoreProperties.requirementAssessments.maxItems === 4
        && assessment.properties.jobEvidence.maxLength === 220
        && gap.required.join('|') === 'requirementText|priority|jobEvidence|status|candidateEvidence|impact'
        && gap.properties.status.enum.join('|') === 'not_documented|contradicted|unclear'
        && scoreProperties.experienceAssessment.properties.categorySpecificExperience.items.required
          .join('|') === 'category|requiredMinimumYears|roleIds|years|candidateEvidence|jobEvidence|explanation'
        && RESUME_PARSE_SCHEMA.required.includes('workHistory')
        && RESUME_PARSE_SCHEMA.properties.workHistory.items.required.join('|') === 'id|title|employer|startDate|endDate',
      'schema keeps a bounded decisive-evidence inventory while requiring complete compact hard-gap coverage and optional tenure');
      return { requiredScoreFields: JOB_SCORING_SCHEMA.properties.scores.items.required.length };
    },
  },
  {
    name: 'Job scoring: an all-gap job is schema-valid and calibrated from its complete compact gap inventory',
    run: () => {
      const job = { title: 'Platform Engineer', snippet: 'Required: Kubernetes production operations.' };
      const allGap = {
        index: 0,
        matchScore: 94,
        reasoning: 'Kubernetes operations are not documented.',
        careerDirection: 'Platform Engineering',
        requirementAssessments: [],
        materialGaps: [{
          requirementText: 'Kubernetes production operations',
          priority: 'required',
          jobEvidence: 'Required: Kubernetes production operations.',
          status: 'not_documented',
          candidateEvidence: '',
          impact: 'Core operating requirement is not documented in the supplied career data.',
        }],
        confidence: 'medium',
      };
      assertResponseMatchesSchema({ scores: [allGap] }, JOB_SCORING_SCHEMA, { provider: 'test', task: 'job-scoring' });
      let unresolvedAssessmentRejected = false;
      try {
        assertResponseMatchesSchema({ scores: [{
          ...allGap,
          requirementAssessments: [{
            requirementText: 'Kubernetes production operations', priority: 'required',
            jobEvidence: 'Required: Kubernetes production operations.', status: 'not_documented',
            candidateEvidence: '', explanation: 'Not documented in the supplied career data.',
          }],
        }] }, JOB_SCORING_SCHEMA, { provider: 'test', task: 'job-scoring' });
      } catch {
        unresolvedAssessmentRejected = true;
      }
      assert(unresolvedAssessmentRejected, 'unresolved hard requirements are schema-invalid in the compact non-gap assessment sample');
      const calibrated = calibratedScoreForJob(allGap, job, { candidateText: 'Built React interfaces for internal tools.', candidateRoles: [] });
      assert(calibrated?.matchScore === 79
        && calibrated.fitAssessment.requirementRows.length === 1
        && calibrated.fitAssessment.materialGaps.length === 1,
      'a complete grounded hard-gap inventory remains a valid audited score without inventing a non-gap assessment row');
      return { score: calibrated.matchScore, gaps: calibrated.fitAssessment.materialGaps.length };
    },
  },
  {
    name: 'Job scoring: a fresh response without grounded requirements becomes a visible placeholder, never a high legacy fit score',
    run: () => {
      const job = { title: 'Frontend Engineer', snippet: 'Required: React experience.' };
      const options = { candidateText: 'Built React interfaces for internal tools.', candidateRoles: [] };
      const emptyAssessment = {
        index: 0, matchScore: 95, reasoning: 'Very strong match.', careerDirection: 'Frontend',
        requirementAssessments: [], materialGaps: [], confidence: 'high', experienceAssessment: {},
      };
      const validAssessment = {
        ...emptyAssessment,
        requirementAssessments: [{
          requirementText: 'React experience', priority: 'required', jobEvidence: 'Required: React experience.',
          status: 'direct', candidateEvidence: 'Built React interfaces for internal tools.', explanation: 'Explicit evidence.',
        }],
      };
      const rejected = calibratedScoreForJob(emptyAssessment, job, options);
      const prepared = prepareLiveScoringResults([emptyAssessment], [job], options);
      const accepted = calibratedScoreForJob(validAssessment, job, options);
      const blankCandidateEvidence = calibratedScoreForJob({
        ...validAssessment,
        requirementAssessments: validAssessment.requirementAssessments.map(row => ({ ...row, candidateEvidence: '  ' })),
      }, job, options);
      const blankJobEvidence = calibratedScoreForJob({
        ...validAssessment,
        requirementAssessments: validAssessment.requirementAssessments.map(row => ({ ...row, jobEvidence: '' })),
      }, job, options);
      const blankContradictionEvidence = calibratedScoreForJob({
        ...validAssessment,
        materialGaps: [{
          requirementText: 'React experience', priority: 'required',
          jobEvidence: 'Required: React experience.', status: 'contradicted',
          candidateEvidence: '', impact: 'The supplied evidence conflicts.',
        }],
      }, job, options);
      assert(rejected === null && prepared.scores[0] === null
        && prepared.placeholderCount === 1 && prepared.ungroundedScoreCount === 1 && prepared.allNull,
      'a fresh empty/legacy-shaped model response cannot retain its raw 95 and increments placeholder telemetry');
      assert(accepted?.matchScore === 95 && accepted.fitAssessment?.auditStatus === 'audited',
        'a fresh response with a grounded material requirement remains eligible for live scoring');
      assert(blankCandidateEvidence === null && blankJobEvidence === null && blankContradictionEvidence === null,
        'a file-card copy loss cannot silently turn required job, match, or contradiction evidence into an accepted blank string');
      return { placeholders: prepared.placeholderCount, ungrounded: prepared.ungroundedScoreCount, blankEvidenceRejected: true };
    },
  },
  {
    name: 'Job scoring: concise career data distinguishes not-documented evidence gaps from explicit contradictions',
    run: () => {
      const job = {
        title: 'Platform Engineer',
        snippet: 'Required: GraphQL production experience. Must be available for overnight on-call.',
      };
      const candidateText = 'Built React interfaces for internal tools. Cannot work overnight shifts.';
      const base = {
        index: 0, matchScore: 92, reasoning: 'Strong fit.', careerDirection: 'Platform Engineering',
        confidence: 'high', experienceAssessment: {},
      };
      const notDocumented = {
        ...base,
        requirementAssessments: [{
          requirementText: 'GraphQL production experience', priority: 'required',
          jobEvidence: 'Required: GraphQL production experience.', status: 'not_documented',
          candidateEvidence: '',
          explanation: 'GraphQL is not documented in the supplied career data.',
        }],
        materialGaps: [{
          requirementText: 'GraphQL production experience', priority: 'required',
          jobEvidence: 'Required: GraphQL production experience.', status: 'not_documented',
          candidateEvidence: '',
          impact: 'The supplied career data does not document this required experience.',
        }],
      };
      const contradicted = {
        ...base,
        requirementAssessments: [{
          requirementText: 'Overnight on-call availability', priority: 'required',
          jobEvidence: 'Must be available for overnight on-call.', status: 'contradicted',
          candidateEvidence: 'Cannot work overnight shifts.',
          explanation: 'The supplied candidate evidence explicitly conflicts with overnight availability.',
        }],
        materialGaps: [{
          requirementText: 'Overnight on-call availability', priority: 'required',
          jobEvidence: 'Must be available for overnight on-call.', status: 'contradicted',
          candidateEvidence: 'Cannot work overnight shifts.',
          impact: 'This explicit availability conflict affects hiring fit.',
        }],
      };
      const documentedFit = calibratedScoreForJob(notDocumented, job, { candidateText, candidateRoles: [] });
      const contradictedFit = calibratedScoreForJob(contradicted, job, { candidateText, candidateRoles: [] });
      assert(documentedFit?.fitAssessment?.auditStatus === 'audited'
        && documentedFit.requirementAssessments?.[0]?.effectiveStatus === 'not_documented'
        && documentedFit.requirementAssessments?.[0]?.materialGap === true
        && /not documented in (?:the )?supplied career data/i.test(documentedFit.reasoning || '')
        && !/candidate lacks/i.test(documentedFit.reasoning || ''),
      'absence from concise career data is an auditable not-documented evidence gap, never an asserted candidate deficit');
      assert(contradictedFit?.fitAssessment?.auditStatus === 'audited'
        && contradictedFit.requirementAssessments?.[0]?.effectiveStatus === 'contradicted'
        && contradictedFit.requirementAssessments?.[0]?.materialGap === true
        && contradictedFit.requirementAssessments?.[0]?.candidateEvidence?.[0] === 'Cannot work overnight shifts.',
      'contradicted requires retained verbatim candidate evidence that explicitly conflicts with the requirement');
      return {
        documentedStatus: documentedFit.requirementAssessments[0].effectiveStatus,
        contradictedStatus: contradictedFit.requirementAssessments[0].effectiveStatus,
      };
    },
  },
  {
    name: 'job pipeline recovery snapshot: deferred LinkedIn rows stay recoverable and distinct from scoring inputs',
    run: () => {
      const full = Array.from({ length: 6 }, (_, index) => ({
        source: 'linkedin', title: `Full ${index}`, company: 'Acme',
        url: `https://linkedin.example/jobs/full-${index}`, snippet: 'F'.repeat(JOB_DESCRIPTION_EVIDENCE_MIN_CHARS),
      }));
      const deferred = Array.from({ length: 48 }, (_, index) => ({
        source: 'linkedin', title: `Deferred ${index}`, company: 'Acme',
        url: `https://linkedin.example/jobs/deferred-${index}`, snippet: '',
      }));
      const { snapshot } = buildJobAnalysisSnapshot({
        jobs: full,
        descriptionRecoveryJobs: [...full, ...deferred],
        descriptionRecoveryState: { google: { consecutiveNoMatchPasses: 1 } },
        profile: { titles: ['Engineer'] },
        nodeId: 'linkedin-recovery-v2',
        targetRole: 'Engineer',
        snapshotContext: { sourceHubId: 'linkedin-recovery-v2', canvasFilePath: null },
      });
      assert(snapshot.version === 2
        && snapshot.jobs.length === 6
        && snapshot.descriptionRecoveryJobs.length === 54
        && snapshot.descriptionRecoveryState.google.consecutiveNoMatchPasses === 1
        && snapshotDescriptionRecoveryJobs(snapshot).length === 54
        && snapshotDescriptionRecoveryJobs({ jobs: full }).length === 6,
      'snapshot v2 keeps the scoring-safe rows separate from the source recovery universe');
      const recoveredSix = deferred.slice(0, 6).map(job => ({
        ...job,
        snippet: 'R'.repeat(JOB_DESCRIPTION_EVIDENCE_MIN_CHARS),
      }));
      const mergedRecovery = mergeDescriptionRecoverySourceJobs(
        snapshot.descriptionRecoveryJobs,
        'linkedin',
        recoveredSix,
      );
      assert(mergedRecovery.filter(job => job.snippet.length >= JOB_DESCRIPTION_EVIDENCE_MIN_CHARS).length === 12,
        'a partial Solve updates matching deferred rows without dropping the rest of the recovery pool');

      const dir = path.join(electronPkg.app.getPath('userData'), 'job-search');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'job-search-last-scrape.json'), JSON.stringify(snapshot), 'utf8');
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search,
        linkedinEnrich: telemetry.linkedinEnrich, linkedinCooldown: telemetry.linkedinCooldown,
      };
      Object.assign(telemetry, {
        nodeId: 'linkedin-recovery-v2', windowId: null,
        search: { ts: Date.now(), queries: 1, raw: 54, deduped: 54, ageDropped: 0, historyDropped: 0, kept: 6 },
        linkedinEnrich: [{
          ts: Date.now(), startedAt: Date.now() - 1000, kind: 'search', browserGen: 1,
          walled: true, attempted: 6, remainingBefore: 54, enriched: 6, stillEmpty: 48,
          noDesc: 0, noDescSoftBlock: 0, noDescGenuine: 0,
        }],
        linkedinCooldown: null,
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['linkedin-recovery-v2']), null, null);
        assert(report.includes('LinkedIn recovery pool: 54 candidate(s) retained separately from scoring; 48 still below')
          && report.includes('Residual: 48 still empty — NOT complete')
          && report.includes('attempted 6/54 remaining')
          && !report.includes('Completion telemetry disagrees'),
        'the report must preserve the unresolved source backlog without mislabeling the six scoring inputs as contradictory');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { scoring: 6, recovery: 54, deferred: 48 };
    },
  },
  {
    name: 'saved scrape snapshots preserve and sanitize source-found counters independently from score-ready jobs',
    run: async () => {
      const jobs = Array.from({ length: 59 }, (_, index) => ({
        source: 'linkedin', title: `Recovered role ${index}`, company: 'Acme',
        url: `https://linkedin.example/jobs/${index}`,
      }));
      const base = {
        jobs,
        profile: { titles: ['Systems Architect'] },
        nodeId: 'saved-scrape-counter-fixture',
        targetRole: 'Systems Architect',
      };
      const { snapshot: current } = buildJobAnalysisSnapshot({
        ...base,
        snapshotContext: { sourceGatheredCount: 60 },
      });
      const { snapshot: malformed } = buildJobAnalysisSnapshot({
        ...base,
        snapshotContext: { sourceGatheredCount: 6 },
      });
      const { snapshot: legacy } = buildJobAnalysisSnapshot({
        ...base,
        snapshotContext: {},
      });
      assert(current.jobs.length === 59
        && current.gatheredJobCount === 59
        && current.sourceGatheredCount === 60,
      'a saved scrape persists the score-ready jobs separately from the larger source-found total');
      assert(malformed.gatheredJobCount === 59
        && malformed.sourceGatheredCount === 59,
      'a malformed source-found count below the 59 saved jobs clamps to the score-ready floor');
      assert(legacy.gatheredJobCount === 59
        && legacy.sourceGatheredCount === 59,
      'a legacy snapshot with no source-found metadata falls back to its 59 saved score-ready jobs');
      const dir = fs.mkdtempSync(path.join('/tmp', 'ic-saved-scrape-counter-report-'));
      const canvas = path.join(dir, 'canvas.json');
      const analysisPaths = getJobAnalysisPaths(canvas, path.join(dir, 'unsaved-analysis'));
      try {
        fs.writeFileSync(analysisPaths.jsonPath, JSON.stringify({
          ...current,
          sourceHubId: 'saved-scrape-counter-fixture',
          canvasFilePath: canvas,
        }), 'utf8');
        const recovery = buildJobRecoverySnapshot(canvas, new Set(['saved-scrape-counter-fixture']));
        assert(recovery.includes('60 found → 59 score-ready job(s)'),
          'recovery diagnostics retain the saved source-found count alongside the 59 score-ready rows');
        const legacyFunnelSnapshot = {
          ...legacy,
          sourceGatheredCount: undefined,
          sourceHubId: 'saved-scrape-counter-fixture',
          canvasFilePath: canvas,
          searchFunnel: { relevanceKept: 60, raw: 60 },
        };
        fs.writeFileSync(analysisPaths.jsonPath, JSON.stringify(legacyFunnelSnapshot), 'utf8');
        const loadedLegacy = await __loadJobAnalysisSnapshotForTests(canvas);
        const restoredFound = loadedLegacy.snapshot.sourceGatheredCount
          ?? loadedLegacy.snapshot.searchFunnel?.relevanceKept
          ?? loadedLegacy.snapshot.searchFunnel?.raw
          ?? loadedLegacy.snapshot.gatheredJobCount
          ?? loadedLegacy.snapshot.jobs.length;
        const legacyRecovery = buildJobRecoverySnapshot(canvas, new Set(['saved-scrape-counter-fixture']));
        assert(loadedLegacy.snapshot.jobs.length === 59
          && !Object.hasOwn(loadedLegacy.snapshot, 'sourceGatheredCount')
          && restoredFound === 60
          && legacyRecovery.includes('60 found → 59 score-ready job(s)'),
        'a legacy 59-job snapshot exposes its 60-row durable funnel fallback for restore and recovery diagnostics without requiring new metadata');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return { scoreReady: current.gatheredJobCount, found: current.sourceGatheredCount };
    },
  },
{
    name: 'job pipeline report: repeated LinkedIn Solve merges accumulate session-gathered accounting',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = { ...telemetry };
      Object.assign(telemetry, {
        nodeId: 'linkedin-multi-solve-accounting',
        windowId: null,
        pipeline: null,
        search: {
          ts: Date.now(), queries: 1, raw: 58, deduped: 58,
          ageDropped: 0, historyDropped: 4, kept: 3,
          descriptionEvidenceDropped: { total: 51, empty: 51, short: 0, bySource: { linkedin: { empty: 51, short: 0 } } },
        },
        resolves: {},
        scoring: {
          ts: Date.now(), input: 54, selectedForScoring: 54, scored: 54,
          placeholders: 0, batches: 4, failedBatches: 0, unscored: 0,
          inputQuality: { empty: 0, short: 0, bySource: {}, samples: [] },
        },
        bucketing: null,
        linkedinEnrich: [],
        linkedinCooldown: null,
      });
      try {
        for (const [pendingBefore, pendingAfter] of [[3, 7], [7, 7], [7, 15], [15, 52], [52, 54]]) {
          recordLinkedinResolveAttempt('linkedin', {
            needEnrich: 54 - pendingBefore,
            enrichSuccess: Math.max(0, pendingAfter - pendingBefore),
            stillEmpty: 54 - pendingAfter,
            walled: pendingAfter < 54,
          });
          recordResolveMergeOutcome('linkedin', {
            replacedExisting: pendingBefore,
            fresh: pendingAfter,
            pendingBefore,
            pendingAfter,
          });
        }
        const report = buildJobsPipelineSnapshot(new Set(['linkedin-multi-solve-accounting']), null, null);
        assert(report.includes('history-dropped: 4 → evidence-deferred: 51 → **scoring-eligible: 3**'),
          'search funnel reconciles description-deferred rows inline');
        assert(report.includes('cumulative net from this source\'s Solve passes: +51')
          && !report.includes('carried over from a prior run'),
        'all Solve deltas survive latest-attempt replacement, so 3 + 51 reports 54 gathered this session');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { initial: 3, solveNet: 51, scored: 54 };
    },
  },
{
    name: 'job pipeline report: manually closed Glassdoor Solve retains final page identity',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId,
        windowId: telemetry.windowId,
        resolves: telemetry.resolves,
      };
      Object.assign(telemetry, {
        nodeId: 'glassdoor-resolve-diagnostics',
        windowId: null,
        resolves: {
          glassdoor: {
            ts: Date.now(),
            extracted: 0,
            ageDropped: 0,
            historyDropped: 0,
            kept: 0,
            diag: {
              closeReason: 'user-closed',
              extractOutcome: 'never-extracted',
              textLen: 0,
              finalHost: 'www.glassdoor.com',
              finalUrl: 'https://www.glassdoor.com/Job/jobs.htm?sc.keyword=Camera%20Operator',
              finalTitle: 'Jobs in United States | Glassdoor',
            },
          },
        },
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['glassdoor-resolve-diagnostics']), null, null);
        assert(report.includes('closed: user-closed') && report.includes('extractor: never-extracted'),
          'job pipeline report retains the manual-close/extractor outcome');
        assert(report.includes('final URL: `https://www.glassdoor.com/Job/jobs.htm`')
          && !report.includes('sc.keyword=Camera%20Operator'),
          'job pipeline report identifies the Solve destination without exporting query parameters');
        assert(report.includes('final title: "Jobs in United States | Glassdoor"'),
          'job pipeline report retains the final page title to distinguish a results page from login/challenge pages');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
    },
  },
{
    name: 'job pipeline report redacts long provider query URLs from bounded evidence samples',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = structuredClone(telemetry);
      const opaque = 'opaque-provider-token-should-not-be-exported';
      const longQuery = `${opaque}-${'x'.repeat(3_000)}`;
      try {
        for (const key of Object.keys(telemetry)) delete telemetry[key];
        Object.assign(telemetry, {
          nodeId: 'redacted-evidence-fixture',
          windowId: null,
          search: {
            ts: Date.now(), queries: 1, raw: 12, deduped: 12,
            ageDropped: 0, historyDropped: 0, kept: 0,
            descriptionEvidenceDropped: {
              total: 12, deferred: 0, empty: 12, short: 0,
              bySource: { google: { deferred: 0, empty: 12, short: 0 } },
              samples: Array.from({ length: 12 }, (_, index) => ({
                source: 'google', title: `Deferred ${index}`, length: 0,
                url: `https://www.google.com/search?htidocid=${index}&token=${longQuery}`,
              })),
            },
          },
          resolves: {}, resumeAttempts: {}, scoring: null, scoringHeartbeat: null,
          pipeline: null, bucketing: null, compensation: null, history: null,
          linkedinEnrich: [], linkedinCooldown: null, indeedSession: null,
        });
        const report = buildJobsPipelineSnapshot(new Set(['redacted-evidence-fixture']), null, null);
        assert(report.includes('https://www.google.com/search')
          && !report.includes('?htidocid=')
          && !report.includes(opaque)
          && report.length < 8_000,
        'bounded job evidence preserves source-path provenance without exposing long query strings');
      } finally {
        for (const key of Object.keys(telemetry)) delete telemetry[key];
        Object.assign(telemetry, saved);
      }
      return { samples: 12, queryTokens: 'redacted' };
    },
  },
{
    name: 'job pipeline report: resolved rows expose relevance and description recovery',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId,
        resolves: telemetry.resolves, search: telemetry.search,
      };
      Object.assign(telemetry, {
        nodeId: 'resolved-quality-diagnostics', windowId: null, search: null,
        resolves: {
          glassdoor: {
            ts: Date.now(), extracted: 6, relevanceDropped: 2,
            relevanceRejected: ['Loss Prevention Associate', 'Armed Driver/Messenger'],
            ageDropped: 0, historyDropped: 0, kept: 4,
            enrichment: {
              attempted: 4, targeted: 6, enriched: 3, completeTotal: 7,
              providerRowsLoaded: 20, empty: 1, unavailable: 1,
              recoveryRecommendation: 'skip', consecutiveNoMatchPasses: 2,
              unavailableSamples: [{ title: 'Expired Architect', url: 'https://jobs/unavailable-jd' }],
              emptySamples: [{ title: 'Security Officer', url: 'https://jobs/missing-jd' }],
            },
            diag: {
              closeReason: 'settled', extractOutcome: 'matched 6',
              postprocessOutcome: 'completed 6', textLen: 5000,
            },
          },
        },
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['resolved-quality-diagnostics']), null, null);
        assert(report.includes('score-safe returned 6')
          && report.includes('title-relevance-dropped 2')
          && report.includes('Loss Prevention Associate')
          && report.includes('Resolve detail enrichment: attempted 4 of 6 deferred target(s) → recovered this attempt 3 → still empty 1')
          && report.includes('provider rows loaded 20 · complete source total 7 · **not in current provider list 1**')
          && report.includes('**Skip recommended after 2 unchanged full-list checks**')
          && report.includes('unavailable now: "Expired Architect"')
          && report.includes('https://jobs/missing-jd')
          && report.includes('detail postprocess: completed 6'),
        'resolved-source diagnostics retain admission and detail-enrichment provenance');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
    },
  },
{
    name: 'job pipeline attribution: board bucketing preserves source hub and direct re-score clears the old board',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId,
        boardNodeId: telemetry.boardNodeId,
        windowId: telemetry.windowId,
        search: telemetry.search,
        resolves: telemetry.resolves,
        scoring: telemetry.scoring,
        bucketing: telemetry.bucketing,
        history: telemetry.history,
      };
      Object.assign(telemetry, {
        nodeId: null,
        boardNodeId: null,
        windowId: null,
        search: {
          ts: Date.now(), queries: 1, raw: 1, deduped: 1,
          ageDropped: 0, historyDropped: 0, kept: 1,
        },
        resolves: {},
        scoring: { ts: Date.now(), input: 1, selectedForScoring: 1, cappedForBudget: 0, scored: 1, placeholders: 0, unscored: 0, batches: 1, failedBatches: 0 },
        bucketing: { ts: Date.now(), input: 1, roleCount: 1, placed: 1, missing: 0, duplicated: 0, bandSummary: [], salaryRangeLabels: [], roleSummary: [], taxonomyAudit: [], error: null },
        history: null,
      });
      try {
        recordJobsSourceScope('source-jobhub-12345678', 42);
        recordJobsBoardScope('results-board-87654321', 42);

        assert(telemetry.nodeId === 'source-jobhub-12345678',
          'bucket scope must not overwrite the originating jobhub id');
        assert(telemetry.boardNodeId === 'results-board-87654321',
          'bucket scope records the Job Board separately');
        let report = buildJobsPipelineSnapshot(
          new Set(['source-jobhub-12345678', 'results-board-87654321']),
          42,
          null,
        );
        assert(report.includes('Source hub: `…12345678`'),
          'report attributes search/scoring to the originating Job Search hub');
        assert(report.includes('Job Board node: `…87654321`'),
          'report names the board that performed bucketing separately');
        assert(!report.includes('Source hub: `…87654321`'),
          'board node must never be rendered as the source hub');

        // A direct re-score is a new source-owned pipeline even when no fresh
        // search call precedes it. It must clear the old board attribution so a
        // previous Combine cannot be presented as part of the new score run.
        recordJobsSourceScope('direct-rescore-hub-abcdef12', 77);
        assert(telemetry.nodeId === 'direct-rescore-hub-abcdef12',
          'direct re-score replaces the source scope with its own jobhub');
        assert(telemetry.boardNodeId === null,
          'direct re-score clears stale board attribution');
        assert(telemetry.bucketing === null,
          'direct re-score clears the previous board-owned bucketing result');
        assert(telemetry.windowId === 77,
          'direct re-score scopes telemetry to its own sender window');
        report = buildJobsPipelineSnapshot(new Set(['direct-rescore-hub-abcdef12']), 77, null);
        assert(report.includes('Source hub: `…abcdef12`') && !report.includes('Job Board node:'),
          'direct re-score report shows only its source hub until a new board combines it');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
    },
  },
{
    name: 'job pipeline report: distinguishes raw role queries from Google-expanded keywords',
    run: () => {
      const issuedQueries = [];
      recordIssuedManualQuery(issuedQueries, { url: 'https://google.test/failed' }, false);
      recordIssuedManualQuery(issuedQueries, { url: 'https://google.test/sent' }, true);
      assert(issuedQueries.length === 1 && issuedQueries[0].url.endsWith('/sent'),
        'a failed location assignment never enters the sent-query telemetry');
      const executed = extractExecutedGoogleQueryStrings({
        google: {
          executedQueries: [{ url: 'https://www.google.com/search?q=Camera%20Operator%20Toronto%20jobs&udm=8' }],
        },
      });
      assert(executed.join('|') === 'Camera Operator Toronto jobs',
        'Google query telemetry derives only navigation-issued requests, not every planned task');
      const funnel = reconcileTitleRelevanceFunnel(21, 21, {
        google: { preCapRelevanceDropped: 1 },
        indeed: { preCapRelevanceDropped: 4 },
        linkedin: { preCapRelevanceDropped: 3 },
        glassdoor: { preCapRelevanceDropped: 5 },
        ziprecruiter: { preCapRelevanceDropped: 1 },
      });
      assert(funnel.raw === 35 && funnel.relevanceDropped === 14 && funnel.finalDropped === 0,
        'top-level funnel retains candidates rejected before browser caps (35 → 14 dropped → 21 admitted)');
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId,
        windowId: telemetry.windowId,
        search: telemetry.search,
        resolves: telemetry.resolves,
      };
      Object.assign(telemetry, {
        nodeId: 'google-query-diagnostics',
        windowId: null,
        resolves: {},
        search: {
          ts: Date.now(), queries: 2, raw: 3, relevanceDropped: 1, deduped: 2, ageDropped: 0, historyDropped: 0, kept: 2,
          bySource: { google: { count: 2, providerGathered: 3, relevanceDropped: 1 } },
          location: { rawInput: 'Toronto, ON', canonical: 'Toronto, ON', perSource: { google: 'keyword-only: canonical location appended to the query (no location param available)' } },
          queryStrings: ['Camera Operator', 'Film Editor Toronto'],
          googleQueryStrings: ['Camera Operator Toronto, ON jobs', 'Film Editor Toronto jobs'],
        },
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['google-query-diagnostics']), null, null);
        assert(report.includes('Raw role queries (shared across sources):') && report.includes('`Camera Operator`'),
          'report labels shared role queries as raw input, not exact per-source request strings');
      assert(report.includes('Google keyword queries sent (canonical location appended when absent):')
          && report.includes('`Camera Operator Toronto, ON jobs`')
          && report.includes('`Film Editor Toronto jobs`'),
        'report renders the actual Google keyword queries, including the deduplicated canonical-location expansion');
        assert(report.includes('Per source (provider returned → retained before target-role/history/evidence gates): google=3 → 2')
          && !report.includes('Per source (raw gathered)'),
        'per-source counts distinguish provider-returned candidates from the pre-target-role/history/evidence-gate rows');
        assert(report.includes('Found (raw): 3 → title-relevance-dropped 1 → after dedup: 2 → age-dropped: 0 → history-dropped: 0 → **new: 2**')
          && !report.includes('→ deduped 2 → age-dropped 0 → already-seen/history 0'),
        'funnel labels make survivor counts and dropped counts unambiguous');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
    },
  },
{
    name: 'job pipeline report: rejected title samples state their nearest gate evidence',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId,
        windowId: telemetry.windowId,
        search: telemetry.search,
        resolves: telemetry.resolves,
      };
      Object.assign(telemetry, {
        nodeId: 'relevance-rejection-diagnostics', windowId: null, resolves: {},
        search: {
          ts: Date.now(), queries: 2, raw: 2, relevanceDropped: 2, deduped: 0,
          ageDropped: 0, historyDropped: 0, kept: 0,
          queryStrings: ['Corporate Security Officer', 'Property Management Assistant'],
          bySource: {
            usajobs: {
              count: 0, providerGathered: 2, relevanceDropped: 2,
              relevanceRejected: [
                'Public Safety Officer',
                'TRANSPORTATION ASSISTANT (PERSONAL PROPERTY)',
              ],
            },
          },
        },
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['relevance-rejection-diagnostics']), null, null);
        assert(report.includes('"Public Safety Officer" [matched officer — 1/2 required]')
          && report.includes('"TRANSPORTATION ASSISTANT (PERSONAL PROPERTY)" [matched property+assistant, but not within one title phrase]'),
        'rejected-title samples show the closest query’s observed failed gate check');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
  },
},
{
    name: 'job pipeline report: RemoteOK whole-feed provenance explains an all-rejected feed',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId,
        windowId: telemetry.windowId,
        search: telemetry.search,
        resolves: telemetry.resolves,
      };
      Object.assign(telemetry, {
        nodeId: 'remoteok-feed-provenance-diagnostics', windowId: null, resolves: {},
        search: {
          ts: Date.now(), queries: 1, raw: 204, relevanceDropped: 204, deduped: 0,
          ageDropped: 0, historyDropped: 0, kept: 0,
          queryStrings: ['System Architect'],
          bySource: {
            remoteok: {
              count: 0, providerGathered: 204, relevanceDropped: 204,
              remoteFeedProvenance: [
                { scope: 'bare', received: 100, added: 100 },
                { scope: 'tag', tag: 'system', received: 4, added: 4 },
                { scope: 'tag', tag: 'architect', received: 100, added: 100 },
              ],
              relevanceRejected: ['Architect CAD & Construction Documentation'],
            },
          },
        },
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['remoteok-feed-provenance-diagnostics']), null, null);
        assert(report.includes('RemoteOK feed scopes: bare 100 received/100 new; tag:system 4 received/4 new; tag:architect 100 received/100 new')
          && report.includes('tag scopes are derived from the raw role queries above')
          && !report.includes('api?tag='),
        'RemoteOK source admission reports compact feed provenance without exposing additional query text');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { scopes: 3, providerRows: 204 };
    },
  },
{
    name: 'job pipeline report identifies re-run provenance and completed duration',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId,
        windowId: telemetry.windowId,
        pipeline: telemetry.pipeline,
        search: telemetry.search,
        careerParseCache: telemetry.careerParseCache,
      };
      Object.assign(telemetry, {
        nodeId: 'rerun-provenance-diagnostics',
        windowId: null,
        pipeline: {
          phase: 'completed', active: false,
          startedAt: Date.now() - 5000, ts: Date.now() - 4000,
          durationMs: 812,
          runOrigin: 'rerun-button',
          profileInputMode: 'fresh-files',
          pendingSources: [],
        },
        search: null,
        // A fingerprint-cache HIT means the supplied files were NOT actually
        // re-parsed this run — reusing the prior parse instead. The Trigger
        // line below must not contradict this by claiming a parse happened.
        careerParseCache: { outcome: 'hit', fileCount: 1, fingerprint: 'de11f2a6acec' },
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['rerun-provenance-diagnostics']), null, null);
        assert(report.includes('✅ complete · phase: **completed** · completed in 812ms')
          && report.includes('Trigger: **Re-run Search button** · career files supplied')
          && !report.includes('career files reparsed')
          && !report.includes('run age 5s'),
        'a completed run reports its actual duration and explicit button origin instead of an ever-growing run age');
        assert(report.includes('Career Parse Cache')
          && report.includes('hit — reused the prior parsed career data')
          && report.includes('fingerprint `de11f2a6acec`'),
        'the parse-cache outcome line is unchanged by this fix');
        // The actual bug: "career files reparsed" next to "hit — reused the
        // prior parsed career data" asserted two contradictory things about the
        // same run. "career files supplied" describes the INPUT (fresh files
        // were given to this run) and is true regardless of the cache outcome.
        assert(!report.includes('career files reparsed'),
        'a fingerprint-cache hit and the Trigger line no longer contradict each other — the Trigger line describes input, not an asserted parse action');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { origin: 'rerun-button', durationMs: 812 };
    },
  },
{
    name: 'job pipeline report: current-run snapshot correlation blocks stale field-quality evidence and shows empty current snapshots',
    run: () => {
      const dir = path.join(electronPkg.app.getPath('userData'), 'job-search');
      const filePath = path.join(dir, 'job-search-last-scrape.json');
      fs.mkdirSync(dir, { recursive: true });
      const priorFile = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId,
        windowId: telemetry.windowId,
        search: telemetry.search,
        resolves: telemetry.resolves,
      };
      Object.assign(telemetry, {
        nodeId: 'snapshot-correlation-diagnostics',
        windowId: null,
        resolves: {},
        search: {
          ts: Date.now(), runId: 'current-empty-run', queries: 1,
          raw: 100, relevanceDropped: 100, deduped: 0, ageDropped: 0, historyDropped: 0, kept: 0,
          queryStrings: ['Systems Architect'],
          bySource: {
            weworkremotely: {
              count: 0, gathered: 0, providerGathered: 100, relevanceDropped: 100,
              relevanceRejected: ['Customer Support Specialist'],
            },
          },
        },
      });
      try {
        fs.writeFileSync(filePath, JSON.stringify({
          runId: 'prior-71-job-run', sourceHubId: 'snapshot-correlation-diagnostics',
          jobs: [{
            source: 'old-source', title: 'Old Snapshot Job', company: 'Old Co',
            salary: '$90,000/year', posted: '2026-08-01', url: 'https://example.com/old',
            snippet: 'Stale description that must never be presented as this run. '.repeat(20),
          }],
        }), 'utf8');
        const staleReport = buildJobsPipelineSnapshot(new Set(['snapshot-correlation-diagnostics']), null, null);
        assert(staleReport.includes('Per source (provider returned → retained before target-role/history/evidence gates): weworkremotely=100 → 0')
          && !staleReport.includes('provider returned → retained before target-role/history/evidence gates): (none)'),
        'whole-feed provider rows remain visible even when title admission retains none');
        assert(staleReport.includes('Saved scrape snapshot does not match the current search run')
          && staleReport.includes('Snippet, salary, and field-quality checks were skipped')
          && !staleReport.includes('Old Snapshot Job')
          && !staleReport.includes('`old-source`: min'),
        'a prior-run snapshot cannot leak stale snippets, salary coverage, or quality findings into the current funnel');

        fs.writeFileSync(filePath, JSON.stringify({
          runId: 'current-empty-run', sourceHubId: 'snapshot-correlation-diagnostics', jobs: [],
        }), 'utf8');
        const emptyReport = buildJobsPipelineSnapshot(new Set(['snapshot-correlation-diagnostics']), null, null);
        assert(emptyReport.includes('Saved scrape snapshot (current run): 0 jobs')
          && !emptyReport.includes('Saved scrape snapshot does not match the current search run'),
        'a matching terminal-zero snapshot is explicitly identified as empty rather than treated as stale');
      } finally {
        Object.assign(telemetry, saved);
        if (priorFile == null) fs.rmSync(filePath, { force: true });
        else fs.writeFileSync(filePath, priorFile, 'utf8');
      }
      return { providerRows: 100, retained: 0 };
    },
  },
{
    name: 'job pipeline report: intentional source skips are not reported as failed searches',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId,
        windowId: telemetry.windowId,
        search: telemetry.search,
        resolves: telemetry.resolves,
      };
      Object.assign(telemetry, {
        nodeId: 'intentional-skip-diagnostics', windowId: null, resolves: {},
        search: {
          ts: Date.now(), queries: 1, raw: 0, relevanceDropped: 0, deduped: 0,
          ageDropped: 0, historyDropped: 0, kept: 0,
          bySource: {
            dice: { count: 0, warning: { code: 'country-source-skipped', severity: 'info', evidence: 'excluded for Canada' } },
            usajobs: { count: 0, warning: { code: 'config-missing', severity: 'info', evidence: 'API key missing' } },
            glassdoor: { count: 0, warning: { code: 'location-resolution-failed', severity: 'info', evidence: 'autocomplete unavailable' } },
          },
        },
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['intentional-skip-diagnostics']), null, null);
        assert(report.includes('intentionally not queried (scope/configuration):')
          && report.includes('dice (country-source-skipped)')
          && report.includes('usajobs (config-missing)'),
        'scope/configuration skips remain visible under a neutral label');
        const realMissLine = report.split('\n').find(line => line.includes('real miss to investigate')) || '';
        assert(realMissLine.includes('glassdoor (location-resolution-failed)')
          && !realMissLine.includes('country-source-skipped')
          && !realMissLine.includes('config-missing'),
        'only an unexpected runtime/safety skip is labeled a real miss');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
    },
},
{
    name: 'job pipeline report: a resolved post-search resume supersedes stale zero-result diagnostics',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search,
        pipeline: telemetry.pipeline, resolves: telemetry.resolves,
        resumeAttempts: telemetry.resumeAttempts, sourceEvents: telemetry.sourceEvents,
        scoring: telemetry.scoring,
      };
      const now = Date.now();
      Object.assign(telemetry, {
        nodeId: 'resolved-resume-reporting', windowId: null,
        pipeline: { ts: now - 1_000, durationMs: 7_100, active: false, phase: 'completed' },
        search: {
          ts: now - 10_000, queries: 1, raw: 0, relevanceDropped: 0, deduped: 0,
          ageDropped: 0, historyDropped: 0, kept: 0,
          bySource: { indeed: { count: 0, warning: { code: 'scrape-failed', severity: 'block' } }, },
        },
        resolves: {},
        resumeAttempts: { indeed: [{ t: now, mode: 'native-challenge', outcome: 'resolved', detail: 'extracted=28 · ageDropped=0 · historyDropped=9 · new=19' }] },
        sourceEvents: { indeed: [{ t: 0, status: 'error', code: 'scrape-failed' }] },
        scoring: { ts: now, input: 19, selectedForScoring: 19, cappedForBudget: 0, scored: 19, placeholders: 0, unscored: 0, batches: 1, failedBatches: 0 },
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['resolved-resume-reporting']), null, null);
        assert(report.includes('superseded by 1 post-completion recovery attempt')
          && report.includes('### Initial Search Pass')
          && report.includes('Initial-pass counters only')
          && report.includes('indeed=resume resolved → 19')
          && !report.includes('real miss to investigate: indeed')
          && !report.includes('`indeed`: error⚠scrape-failed@+0s')
          && !report.includes('carried over from a prior run'),
        'a resolved resume must override stale zero-result, progress, per-source fallback, and carry-over reporting');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
    },
  },
{
    name: 'native Indeed resume preserves raw collection, score-ready additions, and terminal receipt provenance',
    run: () => {
      // This is the observed production shape: 307 initial raw Indeed rows
      // yielded 8 score-ready jobs, then a challenge resume extracted another
      // 90 raw rows of which 8 survived. Collection and scoring must not blend
      // those two dimensions into the impossible 315 value (307 + 8).
      const initialRaw = 307;
      const resumedRaw = 90;
      const initialScoreReady = 8;
      const resumedScoreReady = 8;
      assert(initialRaw + resumedRaw === 397 && initialScoreReady + resumedScoreReady === 16,
        'fixture must encode the 307 + 90 raw / 8 + 8 score-ready production sequence');

      const backend = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
      const resumeStart = backend.indexOf("logger.info(`[Jobs][${nodeId}] Resuming Indeed:");
      const resumeEnd = backend.indexOf("// Renderer calls this after it merges captcha-resolve", resumeStart);
      const resume = backend.slice(resumeStart, resumeEnd);
      assert(resumeStart >= 0 && resumeEnd > resumeStart
        && resume.includes('const gathered = Math.max(0, Number(extracted.length) || 0)')
        && resume.includes('count: Math.max(0, Number(prior.count) || 0) + gathered')
        && resume.includes('providerGathered: Math.max(0, Number(prior.providerGathered ?? prior.gathered ?? prior.count) || 0) + gathered')
        && resume.includes('gatheredCount: gathered')
        && !resume.includes('count: Math.max(0, Number(prior.count) || 0) + retained'),
      'native resume advances both source-returned dimensions by all 90 extracted rows and exposes that raw delta to the renderer');

      const sourceCard = fs.readFileSync(path.resolve('src/nodes/JobSourceCardNode.jsx'), 'utf8');
      const resolvedStart = sourceCard.indexOf('if (result?.resolved)');
      const resolvedEnd = sourceCard.indexOf('} else if (prevForRestore)', resolvedStart);
      const resolved = sourceCard.slice(resolvedStart, resolvedEnd);
      assert(resolved.includes('const sourceGatheredCount = explicitGatheredCount != null && Number.isFinite(Number(explicitGatheredCount))')
        && resolved.includes(': sourceGatheredCount;')
        && resolved.includes('const preResolveCount = Number.isFinite(prevForRestore?.count)')
        && resolved.includes('return (baseCount ?? 0) + sourceGatheredCount;'),
      'source card preserves an 8-row score-ready merge while it advances the collected count by the explicit 90-row raw delta');

      const receipt = sanitizeLastRunReceipt({
        runId: 'indeed-resume-307-90',
        terminal: { status: 'completed', outcome: 'populated', scoreReadyCount: 16 },
        funnel: {
          raw: 307, relevanceDropped: 0, deduped: 307, ageDropped: 0,
          roleDropped: 298, historyDropped: 0, descriptionEvidenceDropped: 1, finalDedupDropped: 0, kept: 8,
        },
        sources: { indeed: { count: 397, providerGathered: 397, relevanceDropped: 0 } },
      });
      assert(receipt.terminal.scoreReadyCount === 16
        && receipt.funnel.kept === 8
        && receipt.funnel.finalDedupDropped === 0
        && receipt.sources.indeed.count === 397
        && receipt.sources.indeed.providerGathered === 397,
      'receipt stores the terminal 16-score-ready fact separately from its initial 8-row funnel and keeps source dimensions aligned');
      return { raw: initialRaw + resumedRaw, scoreReady: initialScoreReady + resumedScoreReady };
    },
  },
{
    name: 'job pipeline report: LinkedIn counts every post-search Solve attempt and suppresses the stale source trail after a clean finish',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search,
        pipeline: telemetry.pipeline, resolves: telemetry.resolves,
        resumeAttempts: telemetry.resumeAttempts, sourceEvents: telemetry.sourceEvents,
        linkedinEnrich: telemetry.linkedinEnrich,
      };
      const now = Date.now();
      Object.assign(telemetry, {
        nodeId: 'linkedin-multi-solve-reporting', windowId: null,
        pipeline: { ts: now - 10_000, durationMs: 53_500, active: false, phase: 'completed' },
        search: {
          ts: now - 20_000, queries: 1, raw: 52, relevanceDropped: 0, deduped: 52,
          ageDropped: 0, historyDropped: 0, kept: 11,
          bySource: { linkedin: { count: 11, warning: { code: 'linkedin-rate-limited', severity: 'throttle' } } },
        },
        resolves: {
          linkedin: {
            ts: now - 1_000, kind: 'linkedin-reenrich', needEnrich: 1,
            enrichSuccess: 1, walled: false, stillEmpty: 0,
          },
        },
        resumeAttempts: {},
        sourceEvents: {
          linkedin: [
            { t: 0, status: 'error', code: 'linkedin-rate-limited' },
            { t: 9_000, status: 'done' },
          ],
        },
        linkedinEnrich: [
          { ts: now - 9_000, kind: 'solve', enriched: 5, stillEmpty: 36, walled: true },
          { ts: now - 7_000, kind: 'solve', enriched: 7, stillEmpty: 29, walled: true },
          { ts: now - 5_000, kind: 'solve', enriched: 24, stillEmpty: 5, walled: true },
          { ts: now - 3_000, kind: 'solve', enriched: 4, stillEmpty: 1, walled: true },
          { ts: now - 1_000, kind: 'solve', enriched: 1, stillEmpty: 0, walled: false },
        ],
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['linkedin-multi-solve-reporting']), null, null);
        assert(report.includes('superseded by 5 post-completion recovery attempts')
          && report.includes('5 later recovery passes superseded this result')
          && !report.includes('`linkedin`: error⚠linkedin-rate-limited@+0s'),
        'the summary must agree with the retained LinkedIn Solve trail and a clean final pass must supersede stale source errors');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { attempts: 5 };
    },
},
{
    name: 'job pipeline report: a successful generic Solve supersedes stale zero-result diagnostics',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search,
        pipeline: telemetry.pipeline, resolves: telemetry.resolves,
        resumeAttempts: telemetry.resumeAttempts, sourceEvents: telemetry.sourceEvents,
      };
      const now = Date.now();
      Object.assign(telemetry, {
        nodeId: 'resolved-generic-reporting', windowId: null,
        pipeline: { ts: now - 1_000, durationMs: 7_100, active: false, phase: 'completed' },
        search: {
          ts: now - 10_000, queries: 1, raw: 0, relevanceDropped: 0, deduped: 0,
          ageDropped: 0, historyDropped: 0, kept: 0,
          bySource: { ziprecruiter: { count: 0, warning: { code: 'scrape-failed', severity: 'block' } } },
        },
        resolves: { ziprecruiter: { ts: now, resolved: true, kept: 4, warning: null } },
        resumeAttempts: {},
        sourceEvents: { ziprecruiter: [{ t: 0, status: 'error', code: 'scrape-failed' }, { t: 1_000, status: 'done' }] },
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['resolved-generic-reporting']), null, null);
        assert(report.includes('ziprecruiter=Solve resolved → 4')
          && !report.includes('real miss to investigate: ziprecruiter')
          && !report.includes('`ziprecruiter`: error⚠scrape-failed@+0s'),
        'a successful generic Solve must override the stale initial zero/error row and trail');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
    },
},
{
    name: 'job pipeline report: remote-feed relevance trace shows title evidence, not tags',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = { nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search, resolves: telemetry.resolves };
      Object.assign(telemetry, {
        nodeId: 'remote-relevance-diagnostics', windowId: null, resolves: {},
        search: {
          ts: Date.now(), queries: 1, raw: 1, deduped: 1, ageDropped: 0, historyDropped: 0, kept: 1,
          remoteRelevance: {
            remoteok: [{
              url: 'https://remoteok.com/l/customer-support', title: 'Customer Support Specialist', company: 'Acme',
              matched: [{
                query: 'Customer Service Coordinator', matchedTerms: ['customer', 'service'], requiredMatches: 2,
                matchedConcepts: [
                  { queryTerm: 'customer', matched: 'customer', kind: 'exact' },
                  { queryTerm: 'service', matched: 'support', kind: 'synonym' },
                ],
              }],
              tags: ['customer-service', 'support'],
            }],
          },
        },
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['remote-relevance-diagnostics']), null, null);
        assert(report.includes('All-source role relevance audit')
          && report.includes('`Customer Service Coordinator` → [customer, service→support]/2 required')
          && report.includes('tags: customer-service, support'),
        'report records exact and synonym title evidence separately from RemoteOK tags');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
    },
  },
  {
    name: 'job pipeline report: pinned target-role evidence does not masquerade as provider-only relevance',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = { nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search, resolves: telemetry.resolves };
      Object.assign(telemetry, {
        nodeId: 'pinned-target-role-audit', windowId: null, resolves: {},
        search: {
          ts: Date.now(), queries: 1, raw: 1, deduped: 1, ageDropped: 0, historyDropped: 0, kept: 1,
          relevanceAudit: {
            usajobs: {
              mode: 'post-hoc-title-audit',
              rows: [{
                url: 'https://www.usajobs.gov/job/123', title: 'IT SPECIALIST (SYSTEMS ARCHITECTURE)', company: 'Agency',
                matched: [], targetRoleTitleMatch: true, targetRoleTokens: ['system', 'architect'],
                providerAcceptedWithoutLocalTitleMatch: false,
              }],
            },
          },
        },
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['pinned-target-role-audit']), null, null);
        assert(report.includes('target-role title gate → [system + architect]')
          && report.includes('separate exact/synonym matching')
          && !report.includes('no local query-title match; accepted from provider ranking by design'),
        'a row retained by the pinned title gate reports that local evidence instead of falsely claiming provider-only admission');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
    },
  },
{
    name: 'jobs history: read-time suppression captures the matched identity and prior row',
    run: () => {
      const current = {
        source: 'weworkremotely', title: 'Customer Support Systems & Analytics Architect', company: 'Mercury',
        location: 'Anywhere in the World', url: 'https://weworkremotely.com/remote-jobs/mercury-customer-support-systems-analytics-architect',
      };
      const prior = {
        seen_date: '2026-08-16', source: 'weworkremotely', title: 'Customer Support Systems &amp; Analytics Architect', company: 'Mercury',
        location: 'Anywhere in the World', url: current.url,
      };
      const result = dedupAgainstHistory([current], [prior]);
      const sample = result.samples[0];
      assert(result.removed === 1 && result.kept.length === 0 && result.samples.length === 1,
        'a history-suppressed job exposes one bounded provenance sample');
      assert(sample.keyKind === 'url' && sample.key === 'u:https://weworkremotely.com/remote-jobs/mercury-customer-support-systems-analytics-architect'
        && sample.dropped.title === current.title && sample.dropped.company === current.company
        && sample.dropped.location === current.location && sample.dropped.url === current.url
        && sample.history.seen_date === prior.seen_date && sample.history.title === prior.title && sample.history.url === prior.url,
      'history provenance identifies the dropped listing, normalized key, and matching durable row');
      const telemetry = getJobsTelemetry();
      const saved = { nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search, resolves: telemetry.resolves };
      Object.assign(telemetry, {
        nodeId: 'history-read-time-diagnostics', windowId: null, resolves: {},
        search: {
          ts: Date.now(), queries: 1, raw: 1, deduped: 1, ageDropped: 0,
          historyDropped: result.removed, historyDropSamples: result.samples, kept: 0,
        },
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['history-read-time-diagnostics']), null, null);
        assert(report.includes('History suppression evidence (1/1 bounded sample)')
          && report.includes('matched URL key')
          && report.includes('Customer Support Systems & Analytics Architect')
          && report.includes('seen_date=2026-08-16')
          && report.includes('Customer Support Systems &amp; Analytics Architect'),
        'FULL/JOBS report renders both the dropped row and matched history evidence');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { keyKind: sample.keyKind, samples: result.samples.length };
    },
  },
{
    name: 'jobs history: reads wait for an already-admitted append before opening the sidecar',
    run: async () => {
      const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-jobs-history-read-barrier-'));
      const canvasPath = path.join(base, 'job-search.json');
      const historyPath = path.join(base, 'job-search.jobs-history.csv');
      const originalRename = fs.promises.rename;
      const originalReadFile = fs.promises.readFile;
      let releaseRename;
      let signalRenameEntered;
      let appendPromise = null;
      let readPromise = null;
      const renameGate = new Promise(resolve => { releaseRename = resolve; });
      const renameEntered = new Promise(resolve => { signalRenameEntered = resolve; });

      try {
        await appendJobsHistory(canvasPath, [{
          source: 'indeed', company: 'Baseline Co', title: 'Baseline role', location: 'Toronto',
          url: 'https://ca.indeed.com/rc/clk?jk=history-barrier-baseline',
        }]);

        fs.promises.rename = async (from, to) => {
          if (to === historyPath) {
            signalRenameEntered();
            await renameGate;
          }
          return originalRename(from, to);
        };
        appendPromise = appendJobsHistory(canvasPath, [{
          source: 'indeed', company: 'Pending Co', title: 'Pending role', location: 'Toronto',
          url: 'https://ca.indeed.com/rc/clk?jk=history-barrier-pending',
        }]);

        let gateTimer;
        const reachedPendingRename = await Promise.race([
          renameEntered.then(() => true),
          new Promise(resolve => { gateTimer = setTimeout(() => resolve(false), 1000); }),
        ]);
        clearTimeout(gateTimer);
        assert(reachedPendingRename, 'the controlled append must reach its pending atomic rename');

        let historyReadStarted = false;
        fs.promises.readFile = (...args) => {
          if (args[0] === historyPath) historyReadStarted = true;
          return originalReadFile(...args);
        };
        readPromise = loadJobsHistory(canvasPath);
        assert(!historyReadStarted,
          'a history read admitted behind an in-flight append must wait on the path tail before opening the old sidecar');

        releaseRename();
        const [appendResult, rows] = await Promise.all([appendPromise, readPromise]);
        appendPromise = null;
        readPromise = null;
        assert(historyReadStarted && appendResult.written === 1
          && rows.length === 2 && rows.some(row => row.title === 'Pending role'),
        `the released read must observe the pending append, got ${JSON.stringify({ historyReadStarted, appendResult, rows })}`);
        return { waited: true, rows: rows.length };
      } finally {
        releaseRename?.();
        await Promise.allSettled([appendPromise, readPromise].filter(Boolean));
        fs.promises.rename = originalRename;
        fs.promises.readFile = originalReadFile;
        await fs.promises.rm(base, { recursive: true, force: true });
      }
    },
  },
{
    name: 'Job search: all country-inapplicable selections fail before mutating prior results',
    run: () => {
      const backend = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
      const policyStart = backend.indexOf('const sourceCountryPolicies = summarizeJobSourceCountryPolicies');
      const runStart = backend.indexOf('const runStartedAt = initialRunStartedAt;', policyStart);
      const preflight = backend.slice(policyStart, runStart);
      assert(policyStart >= 0 && runStart > policyStart
        && preflight.includes('countryApplicableSourceIds.size === 0')
        && preflight.includes('noCountryApplicablePlatforms: true')
        && preflight.includes("status: 'skipped'")
        && preflight.includes('no prior results were changed'),
      'an all-inapplicable source selection must fail visibly before run staging/snapshot work');

      const renderer = fs.readFileSync(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8');
      const dispositionStart = renderer.indexOf('const handlePostSearchResult = useCallback');
      const dispositionEnd = renderer.indexOf('const runPipeline = useCallback', dispositionStart);
      const disposition = renderer.slice(dispositionStart, dispositionEnd);
      assert(!disposition.includes('existingResults.length > 0')
        && disposition.includes('saveJobAnalysisSnapshot?.({\n          jobs: []')
        && disposition.includes('scoredJobs: []')
        && disposition.includes("rerunOutcome: 'no-new-results'"),
      'a valid zero-new rerun must replace prior results and its analysis snapshot with the empty current run');
      return { preflight: true, transactionalEmpty: true };
    },
},
{
    name: 'Job search: zero-new run replaces previous results and shows only 0 new jobs',
    run: () => {
      const renderer = fs.readFileSync(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8');
      const doneState = fs.readFileSync(path.resolve('src/nodes/jobsearch/JobSearchDoneState.jsx'), 'utf8');
      const backend = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
      const sourceCard = fs.readFileSync(path.resolve('src/nodes/JobSourceCardNode.jsx'), 'utf8');
      const dispositionStart = renderer.indexOf('const handlePostSearchResult = useCallback');
      const dispositionEnd = renderer.indexOf('const runPipeline = useCallback', dispositionStart);
      const disposition = renderer.slice(dispositionStart, dispositionEnd);
      assert(disposition.includes('scoredJobs: []')
        && disposition.includes('finalSourceCounts: {}')
        && disposition.includes('resultCount: 0')
        && disposition.includes('totalScoredCount: 0')
        && disposition.includes('scrapedCount: 0'),
      'zero-new disposition clears every prior result summary');
      assert(!renderer.includes('data.rerunNotice ? (')
        && !renderer.includes("title: 'No new jobs'")
        && doneState.includes("jobsLabel(count, 'new job', 'new jobs')")
        && doneState.includes('Math.max')
        && doneState.includes('found')
        && doneState.includes('ready to score')
        && !doneState.includes('${gatheredCount} scraped → ${scrapedCount} kept'),
      'zero-new completion has no notice/toast, shows 0 new jobs, and labels reconciled collection/scoring counts instead of rendering an impossible scraped-to-kept funnel');
      assert(backend.includes('rawCount: relevanceFunnel.raw')
        && backend.includes('gatheredCount: allJobs.length')
        && backend.includes('source-card')
        && backend.includes('count: data.jobs.length')
        && sourceCard.includes('count  = liveProgress.count'),
      'provider-level raw diagnostics stay separate from the source-card-aligned gathered total');
      const freshStart = renderer.indexOf('const visibleGatheredCount = searchResult.gatheredCount');
      const freshEnd = renderer.indexOf('const startProcessing = useCallback', freshStart);
      const resumeStart = renderer.indexOf('const visibleGatheredCount = searchResult.gatheredCount', freshStart + 1);
      const resumeEnd = renderer.indexOf('} catch (error)', resumeStart);
      assert(freshStart >= 0 && freshEnd > freshStart
        && renderer.slice(freshStart, freshEnd).includes('gatheredCount: visibleGatheredCount')
        && resumeStart >= 0 && resumeEnd > resumeStart
        && renderer.slice(resumeStart, resumeEnd).includes('gatheredCount: visibleGatheredCount'),
      'fresh and crash-resume paths pass the source-card-aligned gathered count to every visible terminal state');
      const pausedStart = renderer.indexOf('const handlePostSearchResult = useCallback');
      const pausedEnd = renderer.indexOf('const runPipeline = useCallback', pausedStart);
      const pausedPath = renderer.slice(pausedStart, pausedEnd);
      const resumeScoringStart = renderer.indexOf('const resumeScoring = useCallback');
      const resumeScoringEnd = renderer.indexOf('const handleResumeRun = useCallback', resumeScoringStart);
      const resumeScoringPath = renderer.slice(resumeScoringStart, resumeScoringEnd);
      assert(pausedPath.includes('gatheredCountRef.current = gatheredCount ?? foundJobs.length')
        && pausedPath.includes('gatheredCount: gatheredCount ?? foundJobs.length')
        && resumeScoringPath.includes('pausedGatheredCount = gatheredCountRef.current')
        && resumeScoringPath.includes('gatheredCount: pausedGatheredCount'),
      'a sources-ready pause preserves the source-card-aligned total through same-tick Solve/Skip into resumed scoring');
      assert((pausedPath.match(/if \(saved && !saved\.saved\)/g) || []).length === 1
        && (resumeScoringPath.match(/if \(saved && !saved\.saved\)/g) || []).length === 1
        && !pausedPath.includes('if (saved && !saved.success)')
        && !resumeScoringPath.includes('if (saved && !saved.success)'),
      'both empty-run snapshot paths check the save-job-analysis-snapshot response contract (`saved`), so a successful write cannot emit a false failure');
      assert(resumeScoringPath.includes('saveJobAnalysisSnapshot?.({\n          jobs: []')
        && resumeScoringPath.includes('Failed to save paused empty-run analysis snapshot')
        && resumeScoringPath.includes("rerunOutcome: 'no-new-results'")
        && resumeScoringPath.includes('rerunNotice: null')
        && resumeScoringPath.includes('pendingJobsRef.current = null')
        && resumeScoringPath.includes("hubStateRef.current = 'done'"),
      'zero-pending resumed scoring replaces the current-run snapshot and reaches the same cleared 0-new-jobs terminal state as a direct empty search');
      const applyGatheredCountDelta = (count, {
        replaceSourceItems = false,
        replaceMatchingItems = false,
        resolvedCount = 0,
      }) => Math.max(0, count + ((replaceSourceItems || replaceMatchingItems) ? 0 : resolvedCount));
      const recoveredCounts = [24, 29, 33, 45, 49, 59];
      const gatheredAfterReplacements = recoveredCounts.reduce(
        (count, resolvedCount) => applyGatheredCountDelta(count, { replaceSourceItems: true, resolvedCount }),
        60,
      );
      const gatheredAfterIncrement = applyGatheredCountDelta(gatheredAfterReplacements, { resolvedCount: 3 });
      assert(gatheredAfterReplacements === 60 && gatheredAfterIncrement === 63,
        'counter contract: description-replacement batches [24,29,33,45,49,59] preserve the initial 60 found listings; only a genuinely incremental three-row recovery raises it to 63');
      const resolvedStart = renderer.indexOf('const onResolved = (e) =>');
      const resolvedEnd = renderer.indexOf('document.addEventListener(\'job-source-resolved\'', resolvedStart);
      const resolvedPath = renderer.slice(resolvedStart, resolvedEnd);
      const sourceCardResolveStart = sourceCard.indexOf('if (result?.resolved)');
      const sourceCardResolveEnd = sourceCard.indexOf('} else if (prevForRestore)', sourceCardResolveStart);
      const sourceCardResolvePath = sourceCard.slice(sourceCardResolveStart, sourceCardResolveEnd);
      assert(resolvedPath.includes('gatheredCountDelta')
        && !resolvedPath.includes('sourceCountDelta')
        && resolvedPath.indexOf('if ((e.detail?.jobRunId || null)') < resolvedPath.indexOf('const gatheredCountDelta')
        && resolvedPath.includes('gatheredCountRef.current = Math.max(0')
        && resolvedPath.includes('gatheredCount: gatheredCountRef.current')
        && sourceCardResolvePath.includes('const gatheredCountDelta = (replaceSourceItems || replaceMatchingItems)')
        && sourceCardResolvePath.includes('? 0')
        && sourceCardResolvePath.includes(': resolvedCount')
        && !sourceCardResolvePath.includes('sourceCountDelta'),
      'resolved source cards emit zero gathered delta for replacement/re-match work and the resolved count only for incremental recovery; the hub consumes that explicit delta rather than a transient card count');
      const backgroundStart = renderer.indexOf('const triggerUSAJobsBackgroundSearch = useCallback');
      const backgroundEnd = renderer.indexOf('const handleJobsSettingsChange = useCallback', backgroundStart);
      const backgroundPath = renderer.slice(backgroundStart, backgroundEnd);
      const preferenceEvaluationStart = renderer.indexOf('const evaluatePreferencesForRun = useCallback');
      const pipelineStart = renderer.indexOf('const runPipeline = useCallback');
      const pipelineEnd = renderer.indexOf('const startProcessing = useCallback', pipelineStart);
      const pipelinePath = renderer.slice(pipelineStart, pipelineEnd);
      const queueAcquireAt = pipelinePath.indexOf('lease = await moduleRunQueue.acquireModuleRun');
      const queuedOwnershipAt = pipelinePath.indexOf('if (standaloneBecameBoardManaged)', queueAcquireAt);
      const processingStartAt = pipelinePath.indexOf('processingToken = processingRunsRef.current.start();', queuedOwnershipAt);
      const processingBusyAt = pipelinePath.indexOf("return searchRunOutcome('busy'", processingStartAt);
      const gatheredResetAt = pipelinePath.indexOf('gatheredCountRef.current = 0', processingBusyAt);
      assert(!backgroundPath.includes('gatheredCountRef.current = 0')
        && queueAcquireAt >= 0 && queuedOwnershipAt > queueAcquireAt
        && processingStartAt > queuedOwnershipAt && processingBusyAt > processingStartAt
        && gatheredResetAt > processingBusyAt,
      'a post-run USAJobs append preserves the aggregate gathered counter, while a top-level pipeline resets it only after queue admission, the live Board-ownership refusal, and its processing-token gate');
      assert(preferenceEvaluationStart >= 0 && preferenceEvaluationStart < backgroundStart
        && backgroundPath.includes('evaluatePreferencesForRun'),
      'the background USAJobs callback may depend on Job Preferences evaluation only after that callback has initialized, avoiding a render-time temporal-dead-zone crash');
      const sourcesReadyStart = backgroundPath.indexOf("if (currentState === 'sources-ready')");
      const sourcesReadyEnd = backgroundPath.indexOf("} else if (currentState === 'done')", sourcesReadyStart);
      const sourcesReadyPath = backgroundPath.slice(sourcesReadyStart, sourcesReadyEnd);
      const initialFound = 60;
      const lateUSAJobsRows = [{ id: 'cross-source-duplicate' }, { id: 'another-duplicate' }, { id: 'fresh' }];
      const dedupedLateRows = []; // all three can collapse against the paused cross-source pool
      const foundAfterLateSource = initialFound + lateUSAJobsRows.length;
      assert(sourcesReadyStart >= 0 && sourcesReadyEnd > sourcesReadyStart
        && sourcesReadyPath.includes('const fresh = uniqueJobsAcrossSources(prevPending, freshJobs)')
        && sourcesReadyPath.includes('gatheredCountRef.current = Math.max(')
        && sourcesReadyPath.includes('(Number(gatheredCountRef.current) || 0) + freshJobs.length')
        && sourcesReadyPath.includes('gatheredCount: gatheredCountRef.current')
        && sourcesReadyPath.indexOf('gatheredCountRef.current = Math.max(') < sourcesReadyPath.indexOf('pendingJobsRef.current = mergedPending')
        && sourcesReadyPath.indexOf('gatheredCount: gatheredCountRef.current') < sourcesReadyPath.indexOf('await resumeScoringRef.current?.()')
        && dedupedLateRows.length === 0
        && foundAfterLateSource === 63,
      'a late USAJobs source contributes all three raw found rows (60→63) before cross-source dedup and auto-resume, even when it contributes no additional pending scoring row');
      return { replaced: true, notice: false, label: 'new jobs', rawDiagnostics: 90, visibleGathered: 3 };
    },
  },
{
    name: 'Job search locations: remote company scope and worker residence are labeled separately',
    run: () => {
      const fields = fs.readFileSync(path.resolve('src/components/JobSearchLocationFields.jsx'), 'utf8');
      assert(fields.includes('Company location for remote job: United States')
        && fields.includes('where you will live while working remotely')
        && fields.includes('Your city while working remotely')
        && !fields.includes('Remote role scope:'),
      'remote salary fields must identify the company country separately from the worker residence');
      return { clearLabels: true };
    },
  },
{
    name: 'job pipeline report: durable seen-history writes expose success and failure',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId,
        windowId: telemetry.windowId,
        search: telemetry.search,
        resolves: telemetry.resolves,
        scoring: telemetry.scoring,
        history: telemetry.history,
      };
      Object.assign(telemetry, {
        nodeId: 'history-diagnostics',
        windowId: null,
        search: null,
        resolves: {},
        scoring: null,
        history: {
          preScoring: {
            ts: Date.now(), input: 5, written: 0, pruned: 0, skipped: 'deferred until results are visible', error: null,
          },
          boardDisplay: {
            ts: Date.now(), input: 6, written: 5, pruned: 2, skipped: null, error: null,
            skips: {
              url: 1, titleCompany: 0, noKey: 0, inBatch: 1, bySource: { google: 1 },
              collisionSamples: [{
                key: 'u:https://google.com/search?htidocid=repeat', sameListing: true,
                first: { source: 'google', title: 'Assistant Property Manager', company: 'Acme', location: 'Florida', url: 'https://google.com/search?htidocid=repeat&query=one' },
                duplicate: { source: 'google', title: 'Assistant Property Manager', company: 'Acme', location: 'Florida', url: 'https://google.com/search?htidocid=repeat&query=two' },
              }],
            },
          },
        },
      });
      try {
        let report = buildJobsPipelineSnapshot(new Set(['history-diagnostics']), null, null);
        assert(report.includes('Seen-history persistence') && report.includes('Pre-results write') && report.includes('deferred until results are visible'),
          'report makes the deliberate pre-results history deferral explicit');
        assert(report.includes('likely the same listing surfaced twice') && report.includes('htidocid=repeat')
          && report.includes('kept:') && report.includes('skipped:'),
        'report exposes collision identity and correctly distinguishes a duplicate query result from a bad history key');
        assert(report.includes('Board-displayed write') && report.includes('5 new history row(s), 2 expired row(s) pruned'),
          'report renders the authoritative board-display history outcome');

        telemetry.history.boardDisplay = { ts: Date.now(), input: 1, written: 0, pruned: 0, skipped: null, error: 'EACCES' };
        report = buildJobsPipelineSnapshot(new Set(['history-diagnostics']), null, null);
        assert(report.includes('history write failed: `EACCES`'),
          'report makes a durable-history failure explicit rather than silently claiming dedup is healthy');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
    },
  },
{
    name: 'seen-history: gathered jobs are deferred until results are exposed',
    run: () => {
      const backend = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
      const evidenceFilterStart = backend.indexOf('const descriptionEvidence = filterJobsByDescriptionEvidence(kept)');
      const returnStart = backend.indexOf('return { jobs: kept', evidenceFilterStart);
      const finalDisposition = backend.slice(evidenceFilterStart, returnStart);
      assert(evidenceFilterStart >= 0
        && finalDisposition.includes("skipped: canvasFilePath ? 'deferred until results are visible'")
        && finalDisposition.includes('const finalDeduped = dedupByTitleCompany(kept')
        && finalDisposition.indexOf('const finalDeduped = dedupByTitleCompany(kept') > finalDisposition.indexOf('const descriptionEvidence = filterJobsByDescriptionEvidence(kept)')
        && !finalDisposition.includes('await appendJobsHistory('),
      'low-evidence and gathered-but-unshown jobs must not enter durable seen-history, while enrichment-ready rows receive a final dedup before staging');

      const searchRenderer = fs.readFileSync(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8');
      const finishStart = searchRenderer.indexOf('const finishScoringAndSpawn');
      const finishEnd = searchRenderer.indexOf('const runScoringAndSpawn', finishStart);
      assert(finishStart >= 0 && finishEnd > finishStart
        && !searchRenderer.slice(finishStart, finishEnd).includes('appendJobsHistory'),
      'scoring completion alone does not write seen-history');
      const resumeStart = searchRenderer.indexOf('const resumeScoring = useCallback');
      const resumeEnd = searchRenderer.indexOf('const handleDiscardResume', resumeStart);
      const resumePath = searchRenderer.slice(resumeStart, resumeEnd);
      assert(resumePath.includes('const requestedJobRunId = jobRunIdRef.current || requestedData.jobRunId || null')
        && resumePath.includes('activeJobRunId = continuationRunId;')
        && resumePath.includes("completeJobRun(activeJobRunId, 'completed', 'zero', canvasFilePath, 0, moduleFingerprint([]), cancelled)")
        && resumePath.includes('jobRunId: activeJobRunId'),
      'same-tick source resolution scopes both empty completion and resumed scoring to the live run ref');

      const boardRenderer = fs.readFileSync(path.resolve('src/nodes/JobBoardNode.jsx'), 'utf8');
      const combineStart = boardRenderer.indexOf('const handleCombine');
      const combineEnd = boardRenderer.indexOf('\n  return (', combineStart);
      const combinePath = boardRenderer.slice(combineStart, combineEnd);
      assert(combinePath.includes('addElementsGlobally')
        && combinePath.includes("historyStage: 'boardDisplay'")
        && combinePath.indexOf('addElementsGlobally') < combinePath.indexOf("historyStage: 'boardDisplay'"),
      'the Job Board writes seen-history only after it adds displayed cards');
      return { deferred: true };
    },
  },
  {
    name: 'job pipeline report: taxonomy audit exposes salary placement and repairs',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search,
        resolves: telemetry.resolves, scoring: telemetry.scoring, bucketing: telemetry.bucketing,
      };
      Object.assign(telemetry, {
        nodeId: 'taxonomy-audit-diagnostics', windowId: null, search: null, resolves: {}, scoring: null,
        bucketing: {
          ts: Date.now(), input: 1, roleCount: 1, placed: 1, missing: 0, duplicated: 0,
          bandSummary: [{ label: 'Limited hiring fit (0–79)', count: 1 }], salaryRangeLabels: ['$80k–$120k/yr'],
          roleSummary: [{ name: 'Creative', count: 1, sampleTitles: ['Weekly role'] }],
          taxonomyRepairs: ['canonicalized salary label "$120k process/yr"'],
          taxonomyAudit: [{ index: 0, title: 'Weekly role', source: 'dice', rawSalary: '$1.6K - $2.0K/wk', annualSalary: 83200, salaryRangeMetadata: { lowerAnnual: 83200, upperAnnual: 104000 }, fitBand: 'Limited hiring fit (0–79)', salaryRange: '$80k–$120k/yr', role: 'Creative' }],
          taxonomyAuditOmitted: 0, model: 'gemini-2.5-flash',
          strategy: 'bounded-plan-chunks', taxonomyStage: 'complete', taxonomyChunksCompleted: 6,
          taxonomyChunkCount: 6, taxonomyChunkSize: 24, taxonomyRepresentativeCount: 18,
          taxonomyVocabularySize: 11, provider: 'claude',
          fallback: { preferredModel: 'gemini-3.7-flash', attempts: 1, reason: 'server', counts: { server: 1 } },
          error: null,
        },
      });
      try {
        let report = buildJobsPipelineSnapshot(new Set(['taxonomy-audit-diagnostics']), null, null);
        assert(report.includes('Taxonomy validation repaired: canonicalized salary label "$120k process/yr"')
          && report.includes('"$1.6K - $2.0K/wk" → $83,200/yr → **$80k–$120k/yr**')
          && report.includes('salary range disclosed: $83,200–$104,000/yr. Kept the lower endpoint for deterministic placement.')
          && !report.includes('⚠️ salary range disclosed: $83,200–$104,000/yr')
          && report.includes('model: `gemini-2.5-flash` ↪ fell back (server: 1 earlier model(s) failed)')
          && report.includes('stage complete · 6/6 chunk(s) · max 24 jobs/request · 18 planning sample(s) · 11 role label(s) · provider `claude`')
          && !report.includes('stage complete · classification not started'),
        'job pipeline report makes successful bounded progress, salary placement, repair evidence, and taxonomy fallback cause visible');

        telemetry.bucketing = {
          ...telemetry.bucketing,
          input: 24,
          taxonomyChunkCount: 0,
          taxonomyChunksCompleted: 0,
          taxonomyPlannedAssignments: 24,
          taxonomyClassifiedAssignments: 0,
        };
        report = buildJobsPipelineSnapshot(new Set(['taxonomy-audit-diagnostics']), null, null);
        assert(report.includes('stage complete · classification not needed — planner assigned 24/24')
          && !report.includes('stage complete · classification not started'),
        'job pipeline report makes a complete planner-only taxonomy distinct from a taxonomy that has not reached classification');

        // A taxonomy provider may fail after scores are available.
        // Combine must abort transactionally: it may not create a renderer
        // fallback tree from the partial taxonomy input.
        telemetry.bucketing = {
          ts: Date.now(), input: 92, roleCount: 0, placed: 0, missing: 92, duplicated: 0,
          bandSummary: [], salaryRangeLabels: [], roleSummary: [], taxonomyAudit: [],
          taxonomyAuditOmitted: 0, model: 'gemini-3.7-flash', fallback: null,
          strategy: 'bounded-plan-chunks', taxonomyStage: 'classifying', taxonomyChunksCompleted: 2,
          taxonomyChunkCount: 4, taxonomyChunkSize: 24, taxonomyRepresentativeCount: 18,
          taxonomyVocabularySize: 7, provider: 'claude', blocked: false,
          capability: 'job-board-generation', errorCode: 'PROVIDER_UNAVAILABLE',
          roleShape: {
            type: 'object', expectedCount: 92, receivedCount: 90, rawEntryCount: 91,
            missingCount: 2, blankCount: 1, nonStringCount: 0, extraCount: 1,
            missingIndices: [17, 91], blankIndices: [44], nonStringIndices: [], extraKeys: ['roles'], omittedIssueIndices: 0,
          },
          modelRoleCoverage: { placed: 89, missing: 3, duplicated: 0, invalid: 0, malformedNames: 1 },
          failureSamples: [{ index: 17, title: 'Solutions Architect', source: 'google', suggestedDirection: 'Cloud Architecture' }],
          error: 'Gemini quota exhausted while organizing the Job Board.',
        };
        report = buildJobsPipelineSnapshot(new Set(['taxonomy-audit-diagnostics']), null, null);
        assert(report.includes('**Job Board combine aborted** on 92 scored job(s)')
          && report.includes('no new job results were added')
          && report.includes('existing board was left unchanged')
          && report.includes('Gemini quota exhausted while organizing the Job Board.')
          && report.includes('stage classifying · 2/4 chunk(s) · max 24 jobs/request')
          && report.includes('18 planning sample(s) · 7 role label(s) · provider `claude`')
          && report.includes('90/92 required entries received')
          && report.includes('missing [17, 91]')
          && report.includes('Usable role coverage: 89/92 placed')
          && report.includes('#17 [google] "Solutions Architect"')
          && !report.includes('deterministic likelihood'),
        'FULL/JOBS records a transactional abort plus bounded structural evidence, never a renderer fallback');

      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
    },
  },
{
    name: 'job pipeline report: scoring audit exposes cross-batch calibration drift',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search,
        resolves: telemetry.resolves, scoring: telemetry.scoring, bucketing: telemetry.bucketing,
      };
      Object.assign(telemetry, {
        nodeId: 'scoring-audit-diagnostics', windowId: null, search: null, resolves: {}, bucketing: null,
        scoring: {
          ts: Date.now(), input: 2, selectedForScoring: 2, cappedForBudget: 0, scored: 2,
          placeholders: 0, batches: 2, failedBatches: 0, providerCalls: 4,
          partialRecoveryCalls: 2, partialRecoveryRowAttempts: 3,
          unscored: 0, models: ['gemini-test'],
          fallbacks: [{
            servedModel: 'gemini-2.5-flash', preferredModel: 'gemini-3.7-flash',
            attempts: 1, reason: 'server', counts: { server: 1 },
          }],
          audit: {
            rows: [
              { batch: 1, title: 'Bank Equipment Technician', company: 'Cennox', location: 'Madison, AL', source: 'dice', url: 'https://jobs/1', score: 55, direction: 'Field Services', reason: 'Transferable background.', descriptionFingerprint: 'deadbeef' },
              { batch: 2, title: 'Bank Equipment Technician', company: 'Cennox', location: 'Phoenix, AZ', source: 'dice', url: 'https://jobs/2', score: 35, direction: 'Field Operations', reason: 'Large fit gaps.', descriptionFingerprint: 'deadbeef' },
            ],
            omitted: 0,
            anomalies: [{ delta: 20, first: { index: 0, batch: 1, score: 55 }, second: { index: 1, batch: 2, score: 35 }, title: 'Bank Equipment Technician', company: 'Cennox', descriptionFingerprint: 'deadbeef' }],
          },
        },
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['scoring-audit-diagnostics']), null, null);
        assert(report.includes('20-point cross-batch drift') && report.includes('Madison, AL')
          && report.includes('Phoenix, AZ') && report.includes('https://jobs/1')
          && report.includes('Transferable background.'),
        'FULL/JOBS scoring section contains enough bounded evidence to diagnose score drift');
        assert(report.includes('Scoring evidence (2/2 bounded row(s))')
          && report.includes('score 55') && report.includes('Field Services')
          && report.includes('input ') && report.includes('reason: "Transferable background."'),
        'FULL/JOBS/SCORE reports preserve ordinary per-job score/direction/reason/input evidence, not only anomaly pairs');
        assert(report.includes('Model fallback routes')
          && report.includes('preferred `gemini-3.7-flash`')
          && report.includes('served `gemini-2.5-flash`')
          && report.includes('server: 1 earlier model(s) failed'),
        'FULL/JOBS scoring section preserves fallback cause after the main-process log rolls over');
        assert(report.includes('4 provider call(s)')
          && report.includes('2 targeted partial-row recovery call(s) covering 3 row-attempt(s)'),
        'FULL/JOBS distinguishes top-level batches from targeted partial-response recovery calls');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
    },
  },
{
    name: 'job pipeline report: real model scores do not hide incomplete descriptions',
    run: () => {
      const inputs = [
        ...Array.from({ length: 6 }, (_, index) => ({
          source: 'glassdoor', title: `Security Officer ${index + 1}`,
          url: `https://jobs/glassdoor-empty-${index + 1}`, snippet: '',
        })),
        { source: 'indeed', title: 'Security Officer — Indeed', url: 'https://jobs/indeed-empty', snippet: '' },
        { source: 'linkedin', title: 'Security Guard', url: 'https://jobs/short', snippet: 'Short listing excerpt.' },
        { source: 'indeed', title: 'Full JD', url: 'https://jobs/full', snippet: 'Complete description. '.repeat(40) },
      ];
      const quality = summarizeScoringInputQuality(inputs);
      assert(quality.empty === 7 && quality.short === 1
        && quality.bySource.glassdoor.empty === 6
        && quality.bySource.indeed.empty === 1
        && quality.bySource.linkedin.short === 1,
      'scoring input quality classifies empty and short evidence per source');

      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search,
        resolves: telemetry.resolves, scoring: telemetry.scoring, bucketing: telemetry.bucketing,
      };
      Object.assign(telemetry, {
        nodeId: 'scoring-input-quality', windowId: null, search: null, resolves: {}, bucketing: null,
        scoring: {
          ts: Date.now(), input: inputs.length, selectedForScoring: inputs.length, cappedForBudget: 0, scored: inputs.length,
          placeholders: 0, batches: 1, failedBatches: 0, unscored: 0,
          models: ['gemini-test'], inputQuality: quality,
        },
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['scoring-input-quality']), null, null);
        assert(report.includes('scored but low-evidence')
          && report.includes('Low-evidence scoring inputs')
          && report.includes('7 empty description(s), 1 short')
          && report.includes('glassdoor=6 empty/0 short')
          && report.includes('indeed=1 empty/0 short')
          && report.includes('linkedin=0 empty/1 short')
          && report.includes('Security Officer 1')
          && report.includes('https://jobs/glassdoor-empty-1')
          && report.includes('https://jobs/indeed-empty')
          && report.includes('https://jobs/short'),
        'report separates successful model responses from full-description evidence with bounded per-source samples');
        assert(!report.includes('all received real model scores')
          && !report.includes('all genuinely analyzed')
          && !report.includes('all analyzed with full descriptions'),
        'incomplete descriptions can never receive the green full-evidence verdict');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
  },
},
{
    name: 'description-evidence filter: brief or empty listings never reach scoring/history',
    run: () => {
      const filtered = filterJobsByDescriptionEvidence([
        {
          source: 'ziprecruiter', title: 'Senior Manager, Architect',
          url: 'https://www.ziprecruiter.com/jobs/example-1',
          snippet: 'A concise but genuine description recovered from the detail page.',
          descriptionCapture: 'json-ld-job-description',
        },
        {
          source: 'ziprecruiter', title: 'Applications Architect',
          url: 'https://www.ziprecruiter.com/jobs/example-2',
          snippet: 'Another terse detail-page job description.',
          descriptionCapture: 'detail-page-description',
        },
        {
          source: 'ziprecruiter', title: 'No description yet',
          url: 'https://www.ziprecruiter.com/jobs/example-3',
          snippet: '',
        },
        {
          source: 'ziprecruiter', title: 'Complete listing',
          url: 'https://www.ziprecruiter.com/jobs/example-4',
          snippet: 'Complete employer-supplied job description. '.repeat(20),
        },
        {
          source: 'glassdoor', title: 'Long list excerpt after panel 429',
          url: 'https://www.glassdoor.ca/job-listing/example?jl=5',
          snippet: 'Long list-card text that must not masquerade as a verified panel description. '.repeat(12),
          descriptionDeferredReason: 'description-rate-limited',
        },
      ]);
      assert(filtered.jobs.length === 1
        && filtered.jobs[0]?.title === 'Complete listing'
        && filtered.dropped.length === 4
        && filtered.quality.deferred === 1
        && filtered.quality.empty === 1
        && filtered.quality.short === 2,
      'brief, empty, and explicitly unresolved listings are omitted before scoring/history even when a list excerpt exceeds 400 chars');
      return { ok: true };
    },
  },
{
    // End-to-end regression for the salary field-quality rewrite: renders the
    // real markdown through buildJobsPipelineSnapshot (backed by a real saved
    // snapshot file on disk, same as the app writes) rather than re-testing the
    // classifier in isolation, so the exact rendered lines are pinned down.
    //
    // (1) False alarm this closes: a bare thousands-scale numeric range like
    //     Dice's "38000 - 40000" used to fail looksLikeMoney (no $/k/comma) and
    //     got reported "salary garbage" even though the real annualizer parses
    //     it fine as $38,000/yr.
    // (2) Missed defect this closes: a source whose present salaries all "look
    //     like money" (pass looksLikeMoney) could still have some annualize to
    //     0 and get reported "all monetary ✅" while real pay data was silently
    //     dropped into the "Unspecified" bucket (the real USAJobs run: 10/10
    //     present, 4 of them "/ PH" rates the annualizer couldn't read).
    //
    // Fixture salaries are NOT the two exact strings another agent is making
    // parseable at the extractor level ('$22.31 - $22.31 / PH', '$20 - $24') —
    // different digits, same shape, and their unparseability is asserted
    // directly via parseSalaryToNumeric below so this test stays honest either
    // way even if that extractor-level fix broadens further.
    name: 'job pipeline report: salary field-quality reports the annualizer-measured unparseable count, not a lookalike-regex verdict',
    run: () => {
      const lostCadenceSamples = ['$19.75 - $19.75 / PH', '$24.10 - $24.10 / PH', '$31.40 - $31.40 / PH', '$27.85 - $27.85 / PH'];
      for (const s of lostCadenceSamples) {
        assert(parseSalaryToNumeric(s) === 0, `precondition: "${s}" must be unparseable for this regression fixture to be meaningful`);
        assert(looksLikeMoney(s), `precondition: "${s}" must still look monetary (lands in the cadence-lost bucket, not prose)`);
      }
      assert(parseSalaryToNumeric('38000 - 40000') > 0,
        'precondition: the Dice false-alarm value must still parse fine for the "must not be flagged" assertion below to be meaningful');

      const dir = path.join(electronPkg.app.getPath('userData'), 'job-search');
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, 'job-search-last-scrape.json');
      const longSnippet = 'Full job description text goes here. '.repeat(20);
      const parseableSalaries = ['$60,000 - $75,000', '$82,000 - $95,000', '$71,500 - $88,000', '$64,000 - $79,000', '$90,000 - $110,000', '$58,000 - $66,000'];
      const usajobsJobs = [...lostCadenceSamples, ...parseableSalaries].map((salary, i) => ({
        title: `Analyst ${i}`, company: 'Agency', location: 'Remote', source: 'usajobs-regression-test',
        salary, posted: '2026-08-01', url: `https://example.com/usajobs/${i}`,
        snippet: i === 0 ? `${longSnippet}\nPay: $19.75 - $19.75 per hour` : longSnippet,
      }));
      const diceJobs = [{
        title: 'Engineer', company: 'Acme', location: 'Remote', source: 'dice-regression-test',
        salary: '38000 - 40000', posted: '2026-08-01', url: 'https://example.com/dice/1', snippet: longSnippet,
      }];
      const indeedJobs = [{
        title: 'Locker Room Attendant', company: 'Acme', location: 'Austin, TX', source: 'indeed-regression-test',
        salary: '$18.75 - $19.70 a year', posted: '2026-08-01', url: 'https://example.com/indeed/1', snippet: longSnippet,
      }];
      fs.writeFileSync(filePath, JSON.stringify({ jobs: [...usajobsJobs, ...diceJobs, ...indeedJobs] }), 'utf8');

      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search, resolves: telemetry.resolves,
      };
      Object.assign(telemetry, {
        nodeId: 'salary-quality-regression-test', windowId: null, resolves: {},
        search: { ts: Date.now(), queries: 1, raw: 11, deduped: 11, ageDropped: 0, historyDropped: 0, kept: 11 },
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['salary-quality-regression-test']), null, null);

        // (2) A source that's 100% "looks like money" must never be summarized
        // "all monetary" / "all annualized ✅" when 4/10 of its values actually
        // annualize to 0 — this is the exact USAJobs regression from the bug
        // report. The coverage note is mutually exclusive (if/else), so pinning
        // down the exact "N unparseable ⚠" string for this source (not present
        // anywhere else — the string embeds the source name) already proves the
        // healthy strings were never chosen for it.
        assert(report.includes('`usajobs-regression-test`: 10/10 present (100%) — 4 unparseable ⚠'),
          'salary coverage line reports the annualizer-measured unparseable count instead of "all monetary ✅"');
        assert(report.includes('salary unparseable: 4/10 (40%)'),
          'field-quality warning reports the annualizer-measured unparseable count/pct, not a looksLikeMoney count');
        assert(report.includes('4 money-shaped but cadence missing — extractor could not recover a unit, so these remain Unspecified rather than guessing'),
          'field-quality warning reports the missing unit without claiming a recoverable source cadence');
        assert(lostCadenceSamples.some(s => report.includes(`"${s}"`)),
          'field-quality warning includes a real offending sample value, as the old garbage warning did');
        assert(report.includes('recovered-description pay context exists for 1 bounded sample(s), so cadence reconciliation is possible without guessing')
          && report.includes('raw "$19.75 - $19.75 / PH" ↔ JD "Pay: $19.75 - $19.75 per hour"'),
        'FULL/QUALITY distinguishes a source-wide missing cadence from a list field whose same-job description already carries the recoverable unit');
        assert(report.includes('1 implausibly tiny explicit annual amount')
          && report.includes('"$18.75 - $19.70 a year"'),
        'field-quality warning identifies corrupt tiny annual pay separately from a missing cadence');

        // (1) A bare numeric range the real annualizer parses fine must never be
        // flagged, and its source must be reported healthy.
        assert(!report.includes('"38000 - 40000"'),
          'a salary the real annualizer parses successfully must never appear as an offending sample');
        assert(report.includes('`dice-regression-test`: 1/1 present (100%) — all annualized ✅'),
          'a source whose only salary the annualizer parses fine must be reported healthy, not flagged as garbage (the old looksLikeMoney-based check misflagged this exact shape)');
      } finally {
        Object.assign(telemetry, saved);
        fs.rmSync(filePath, { force: true });
      }
      return { ok: true };
    },
  },
{
    name: 'job pipeline report: names card-owned collection limits and their widening action',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId,
        windowId: telemetry.windowId,
        search: telemetry.search,
        resolves: telemetry.resolves,
      };
      Object.assign(telemetry, {
        nodeId: 'collection-limit-diagnostics',
        windowId: null,
        resolves: {},
        search: {
          ts: Date.now(), queries: 2, raw: 28, deduped: 28, ageDropped: 0, historyDropped: 0, kept: 20,
          collectionLimits: { jobsPerPlatform: 10, pagesPerPlatform: 2 },
          bySource: {
            indeed: {
              count: 10, unique: 10, gathered: 18,
              capOverflow: 8,
              cap: { type: 'per-platform', limit: 10 },
            },
            glassdoor: {
              count: 0, unique: 0, gathered: 5, providerGathered: 5,
              relevanceDropped: 5, finalRelevanceDropped: 5,
              relevanceRejected: ['Junior Project Buyer'],
            },
            ziprecruiter: {
              count: 10, unique: 10, pagesWalked: 2, stopReason: 'per-source-cap',
              cap: { type: 'per-platform', limit: 10 },
            },
          },
        },
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['collection-limit-diagnostics']), null, null);
        assert(report.includes('Collection limits: 10 job(s)/platform; 2 browser page(s)/search'),
          'the report must retain the exact card-owned collection limits used by the run');
        telemetry.search.collectionLimits = { jobsPerPlatform: null, pagesPerPlatform: null };
        const unboundedReport = buildJobsPipelineSnapshot(new Set(['collection-limit-diagnostics']), null, null);
        assert(unboundedReport.includes(`Collection limits: unlimited jobs/platform; all browser pages/search (safety backstop ${JOB_COLLECTION_PAGE_CEILING})`),
          'the report identifies an all-pages run and its shared finite safety backstop');
        assert(unboundedReport.includes('dedup / age / history drops are by-design')
          && !unboundedReport.includes('title-relevance / dedup / age / history drops are by-design'),
        'a current provider-trust run does not imply title drops when none occurred');
        assert(report.includes('per-platform job limit (10)') && report.includes('increase or clear the Jobs per platform setting'),
          'API and browser truncation must point back to the editable card setting');
        assert(report.includes('stopped: per-source-cap'),
          'browser source-limit stops must remain visible rather than looking completed');
        assert(!report.includes('`glassdoor`: collected 0 of 5')
          && report.includes('0 retained after the title relevance gate: glassdoor (5 gathered, then title-filtered)')
          && !report.includes('genuinely empty / off-category): glassdoor'),
        'final title rejections must not be mislabeled as cap truncation or a genuinely empty source');
        assert(!report.includes('disable fast mode') && !report.includes('JOB_RESULT_CAP'),
          'collection-limit diagnostics must not send users toward removed code-only cap controls');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { api: 10, browser: 10 };
    },
  },
{
    name: 'Job identity helpers',
    run: () => {
      const a = { title: ' Senior Engineer ', company: 'Acme ', location: ' Denver ', url: ' HTTPS://EXAMPLE.COM/JOB ' };
      const b = { title: 'senior engineer', company: 'acme', location: 'denver', url: 'https://example.com/job' };
      const c = { title: 'Senior Engineer', company: 'Acme', location: 'Remote', url: 'https://example.com/job-2' };
      assert(jobTitleCompanyKey(a) === 'senior engineer|acme', 'Job identity helpers: title/company key should normalize case and whitespace');
      assert(jobTitleCompanyUrlKey(a) === jobTitleCompanyUrlKey(b), 'Job identity helpers: URL key should normalize case and whitespace');
      assert(jobTitleCompanyLocationKey(a) === jobTitleCompanyLocationKey(b), 'Job identity helpers: location key should normalize case and whitespace');
      assert(jobTitleCompanyLocationKey(a) !== jobTitleCompanyLocationKey(c), 'Job identity helpers: location key should keep distinct locations');

      const deduped = dedupeJobsByKey([a, b, c], jobTitleCompanyKey);
      assert(deduped.length === 1, `Job identity helpers: expected title/company dedupe to keep 1, got ${deduped.length}`);
      const fresh = uniqueJobsNotIn([a], [b, c], jobTitleCompanyUrlKey);
      assert(fresh.length === 1 && fresh[0] === c, 'Job identity helpers: uniqueJobsNotIn should preserve only unseen candidates');

      // sourceJobKey: native id wins, then url, then the location-aware fallback.
      // Both Indeed extractors share it so the within-source gather can't
      // over-collapse two distinct-location reqs that share a title + company.
      assert(sourceJobKey({ jobkey: 'JK1', url: 'u', title: 't', company: 'co' }) === 'JK1',
        'sourceJobKey: native jobkey wins over url/composed');
      assert(sourceJobKey({ url: 'https://x/job', title: 't', company: 'co' }) === 'https://x/job',
        'sourceJobKey: url wins when no native id');
      const googleFirstQuery = {
        source: 'google', title: 'Assistant Property Manager, Multifamily', company: 'Cushman & Wakefield', location: 'Florida, United States',
        url: 'https://www.google.com/search?ibp=htl;jobs&q=Leasing+Assistant+United+States+jobs&htidocid=u59K_-BxO-_w8CI0AAAAAA%3D%3D&shmd=first#htiq=Leasing+Assistant+United+States+jobs',
      };
      const googleSecondQuery = {
        ...googleFirstQuery,
        url: 'https://www.google.com/search?ibp=htl;jobs&q=Property+Management+Assistant+United+States+jobs&htidocid=u59K_-BxO-_w8CI0AAAAAA%3D%3D&shmd=second#htiq=Property+Management+Assistant+United+States+jobs',
      };
      const differentGoogleListing = {
        ...googleFirstQuery,
        url: 'https://www.google.com/search?ibp=htl;jobs&q=Leasing+Assistant+United+States+jobs&htidocid=DifferentGoogleListingAAAAAA%3D%3D',
      };
      assert(sourceJobKey(googleFirstQuery) === sourceJobKey(googleSecondQuery),
        'sourceJobKey: the same Google htidocid dedupes across distinct query URLs');
      assert(sourceJobKey(googleFirstQuery) !== sourceJobKey(differentGoogleListing),
        'sourceJobKey: distinct Google htidocid values remain separate');
      assert(dedupeJobsByKey([googleFirstQuery, googleSecondQuery, differentGoogleListing], sourceJobKey).length === 2,
        'sourceJobKey: duplicate Google cards from two queries collapse before scoring/history');
      const zipFirstPath = {
        source: 'ziprecruiter', title: 'Solutions Architect', company: 'Example Co', location: 'Novi, MI',
        url: 'https://www.ziprecruiter.com/c/Example-Co/Job/Solutions-Architect/-in-Novi,MI?jid=a2ff7a1591c73148',
      };
      const zipRenamedPath = {
        ...zipFirstPath, company: 'Example Co, Inc.',
        url: 'https://www.ziprecruiter.com/c/Example-Co-Inc/Job/Solutions-Architect-II/-in-Novi,MI?jid=a2ff7a1591c73148',
      };
      const zipCanonicalHostPath = {
        ...zipRenamedPath,
        url: 'https://ziprecruiter.com/c/Example-Co-Inc/Job/Solutions-Architect-II/-in-Novi,MI?jid=a2ff7a1591c73148',
      };
      const zipLookalikeHost = {
        ...zipFirstPath, company: 'Different Company', title: 'Different Role',
        url: 'https://not-ziprecruiter.example/jobs?jid=a2ff7a1591c73148',
      };
      assert(sourceJobKey(zipFirstPath) === sourceJobKey(zipRenamedPath),
        'sourceJobKey: a genuine ZipRecruiter jid survives changed display-slug paths');
      assert(sourceJobKey(zipFirstPath) === sourceJobKey(zipCanonicalHostPath),
        'sourceJobKey: a genuine ZipRecruiter jid survives the www/canonical host redirect');
      assert(sourceJobKey(zipFirstPath) !== sourceJobKey(zipLookalikeHost),
        'sourceJobKey: a jid on a non-ZipRecruiter host is not trusted as ZipRecruiter identity');
      const sf = { title: 'SWE', company: 'Google', location: 'San Francisco, CA' };
      const nyc = { title: 'SWE', company: 'Google', location: 'New York, NY' };
      assert(sourceJobKey(sf) !== sourceJobKey(nyc),
        'sourceJobKey: idless same-title/company reqs in different cities stay distinct (no over-collapse)');
      assert(dedupeJobsByKey([sf, nyc], sourceJobKey).length === 2,
        'sourceJobKey: nationwide distinct-location reqs both survive within-source dedup');
      return { deduped: deduped.length, fresh: fresh.length };
    },
  },
{
    name: 'dedupJobsAcrossSources: location-aware cross-source dedup',
    run: () => {
      // Same posting scraped from two boards: different URL/source, one board
      // omits location — must still collapse (this is the whole point of
      // cross-source dedup: two boards showing the same job under two URLs).
      const linkedin = { title: 'SWE', company: 'Google', source: 'LinkedIn', url: 'https://linkedin.com/a' };
      const indeed = { title: 'swe', company: 'google', source: 'Indeed', url: 'https://indeed.com/b', location: 'New York, NY' };
      const crossSource = dedupJobsAcrossSources([linkedin, indeed]);
      assert(crossSource.length === 1, `dedupJobsAcrossSources: same posting missing location on one side should collapse, got ${crossSource.length}`);

      // Nationwide search: same title+company, both sides HAVE a location, and
      // the locations genuinely differ — must stay distinct (the bug being
      // fixed: title+company alone silently dropped the second city's req).
      const nycReq = { title: 'Software Engineer', company: 'Google', location: 'New York, NY' };
      const sfReq = { title: 'Software Engineer', company: 'Google', location: 'San Francisco, CA' };
      const distinctCities = dedupJobsAcrossSources([nycReq, sfReq]);
      assert(distinctCities.length === 2, `dedupJobsAcrossSources: distinct-location same-title/company reqs must both survive, got ${distinctCities.length}`);

      // Same title+company+location (from two boards, identical location text) → collapses.
      const nycAgain = { title: 'software engineer', company: 'google', location: 'new york, ny' };
      const sameCity = dedupJobsAcrossSources([nycReq, nycAgain, sfReq]);
      assert(sameCity.length === 2, `dedupJobsAcrossSources: matching-location duplicate should collapse, distinct city should survive, got ${sameCity.length}`);

      // Regression: a group's FIRST entry landing with an unknown location
      // used to match (and swallow) EVERY later job via the "either side
      // unknown" leniency, regardless of the later jobs' own distinct real
      // locations — collapsing NYC and SF onto the one unresolved entry
      // instead of onto each other. The unresolved entry must only absorb
      // the FIRST location-bearing match, then behave like a normal
      // exact-match city for anything after that.
      const noLocationFirst = { title: 'Software Engineer', company: 'Google', source: 'USAJobs' };
      const orderDependent = dedupJobsAcrossSources([noLocationFirst, nycReq, sfReq]);
      assert(orderDependent.length === 2,
        `dedupJobsAcrossSources: an unknown-location entry seen FIRST must not swallow two distinct later cities, got ${orderDependent.length}`);

      // Same source + same title/company/location is NOT enough evidence to
      // collapse two concurrent requisitions. Native IDs are authoritative.
      const sameSourceA = { title: 'Front Desk Agent', company: 'Acme Hotels', location: 'Toronto, ON', source: 'indeed', jobkey: 'a', url: 'https://indeed.test/a' };
      const sameSourceB = { ...sameSourceA, jobkey: 'b', url: 'https://indeed.test/b' };
      assert(dedupJobsAcrossSources([sameSourceA, sameSourceB]).length === 2,
        'dedupJobsAcrossSources: same-source distinct listing IDs survive even with identical title/company/location');
      assert(dedupJobsAcrossSources([sameSourceA, { ...sameSourceA }]).length === 1,
        'dedupJobsAcrossSources: exact same-source listing ID still collapses query/page overlap');

      // A ZipRecruiter employer slug can differ between result pages despite
      // the same immutable jid. This must collapse BEFORE title/company
      // grouping, because the display-company difference otherwise prevents
      // the same-source identity comparison from ever running.
      const zipSourceA = {
        title: 'AI Solutions Architect & Agent Builder', company: 'Dave & Busters', location: 'Novi, MI', source: 'ziprecruiter',
        url: 'https://www.ziprecruiter.com/c/Dave-Busters/Job/AI-Solutions-Architect/-in-Novi,MI?jid=a2ff7a1591c73148',
      };
      const zipSourceB = {
        ...zipSourceA, company: 'Dave & Busters, Inc.',
        url: 'https://ziprecruiter.com/c/Dave-Busters-Inc/Job/AI-Solutions-Architect-and-Agent-Builder/-in-Novi,MI?jid=a2ff7a1591c73148',
      };
      const zipDrops = [];
      assert(dedupJobsAcrossSources([zipSourceA, zipSourceB], { onDuplicate: entry => zipDrops.push(entry) }).length === 1
        && zipDrops[0]?.reason === 'same-source-listing-id',
      'dedupJobsAcrossSources: same-source Zip jid collapses despite company-slug variation');

      // An extractor-provided native ID is already a source-owned identity.
      // A localized redirect (or a transient missing URL) must not turn the
      // same row into a second listing merely because display metadata changed.
      const indeedNativeA = {
        title: 'Platform Engineer', company: 'Example Co', location: 'Toronto, ON', source: 'indeed', jobkey: 'native-indeed-42',
        url: 'https://ca.indeed.com/viewjob?jk=native-indeed-42',
      };
      const indeedNativeB = {
        ...indeedNativeA, title: 'Senior Platform Engineer', company: 'Example Co, Inc.', url: '',
      };
      assert(dedupJobsAcrossSources([indeedNativeA, indeedNativeB]).length === 1,
        'dedupJobsAcrossSources: an explicit same-source native ID survives host changes or a missing URL');

      // If the first Zip card was already absorbed by a matching card from a
      // different board, its jid still has to remain globally reserved. A
      // later Zip spelling variant cannot be allowed to re-enter merely
      // because its changed company label forms a new title/company group.
      const boardCopyBeforeZip = {
        ...zipSourceA,
        source: 'google',
        url: 'https://www.google.com/search?htidocid=zip-alias-fixture',
      };
      const zipAliasDrops = [];
      assert(dedupJobsAcrossSources([boardCopyBeforeZip, zipSourceA, zipSourceB], {
        onDuplicate: entry => zipAliasDrops.push(entry),
      }).length === 1 && zipAliasDrops.length === 2,
      'dedupJobsAcrossSources: a Zip jid remains reserved after its first card loses to a cross-source copy');

      // Real cross-board shape: one source decorates the company/location while
      // both carry the same full JD. The substantial content fingerprint is a
      // safe secondary identity; city remains part of the guard so templated
      // multi-location requisitions do not collapse.
      const fullJdA = 'Requisition 2026-107. ' + 'Customer service communications responsibilities and requirements. '.repeat(12);
      const fullJdB = 'Requisition 2026-107! ' + 'Customer service communications responsibilities and requirements.'.repeat(12);
      const glassdoorCopy = {
        title: 'Customer Service Coordinator, Communications',
        company: 'Town of Saugeen Shores, Ontario', location: 'Port Elgin',
        source: 'glassdoor', snippet: fullJdA,
      };
      const indeedCopy = {
        title: 'Customer Service Coordinator, Communications',
        company: 'Town of Saugeen Shores', location: 'Port Elgin, ON',
        source: 'indeed', snippet: fullJdB,
      };
      const otherCityCopy = { ...indeedCopy, location: 'Southampton, ON', source: 'linkedin' };
      assert(dedupJobsAcrossSources([glassdoorCopy, indeedCopy]).length === 1,
        'cross-source copies with the same title/city/full JD collapse despite company and location decoration');
      assert(dedupJobsAcrossSources([glassdoorCopy, otherCityCopy]).length === 2,
        'same title/full JD in a different city remains a distinct requisition');

      // The first pass can only see short board excerpts. Once late enrichment
      // supplies matching full descriptions, the same conservative helper must
      // collapse the cross-board copy without touching different-city postings.
      const shortDice = { title: 'AI Solutions Architect & Agent Builder', company: 'Harman International', location: 'Novi, MI', source: 'dice', snippet: 'AI architect role.' };
      const shortZip = { ...shortDice, company: 'Harman International Industries', source: 'ziprecruiter', snippet: 'Architect opening.' };
      assert(dedupJobsAcrossSources([shortDice, shortZip]).length === 2,
        'short pre-enrichment excerpts do not create an unsafe cross-board collapse');
      const fullHarmanJd = 'Harman requisition 2026-204. ' + 'Design, build, and operate AI architecture for connected products. '.repeat(12);
      const enrichedDice = { ...shortDice, snippet: fullHarmanJd };
      const enrichedZip = { ...shortZip, snippet: fullHarmanJd };
      assert(dedupJobsAcrossSources([enrichedDice, enrichedZip]).length === 1,
        'enrichment-ready full descriptions collapse the confirmed cross-board copy');

      return { crossSource: crossSource.length, distinctCities: distinctCities.length, sameCity: sameCity.length, orderDependent: orderDependent.length };
    },
  },
{
    name: 'uniqueJobsAcrossSources: location-aware "new vs existing" merge (renderer resolve/append paths)',
    run: () => {
      const nycExisting = { title: 'Software Engineer', company: 'Google', location: 'New York, NY', source: 'Indeed' };
      const sfFresh = { title: 'Software Engineer', company: 'Google', location: 'San Francisco, CA', source: 'LinkedIn' };
      const dup = { title: 'software engineer', company: 'google', location: 'new york, ny', source: 'USAJobs' };

      // A genuinely distinct-city fresh job must be added, not swallowed.
      const added1 = uniqueJobsAcrossSources([nycExisting], [sfFresh]);
      assert(added1.length === 1 && added1[0] === sfFresh, 'uniqueJobsAcrossSources: distinct city is added');

      // A same-city duplicate must NOT be added again.
      const added2 = uniqueJobsAcrossSources([nycExisting], [dup]);
      assert(added2.length === 0, 'uniqueJobsAcrossSources: matching-location duplicate is not re-added');

      // The exact bug this replaces uniqueJobsNotIn(..., jobTitleCompanyKey)
      // for: with the old location-blind key, BOTH nycExisting and sfFresh
      // share the null-location existing entry's title+company, so NEITHER
      // would ever be added — a genuinely new posting in a second city could
      // never surface. The location-aware version lets the ambiguous
      // existing entry absorb (at most) the FIRST candidate it plausibly
      // matches, so the clearly-distinct second city still gets through.
      const noLocationExisting = { title: 'Software Engineer', company: 'Google', source: 'USAJobs' };
      const added3 = uniqueJobsAcrossSources([noLocationExisting], [nycExisting, sfFresh]);
      assert(added3.length === 1 && added3[0] === sfFresh,
        `uniqueJobsAcrossSources: an unknown-location existing entry absorbs one candidate but still lets a second, distinct city through, got ${added3.length}`);

      return { added1: added1.length, added2: added2.length, added3: added3.length };
    },
  },
{
    name: 'Source progress merge',
    run: () => {
      const first = mergeSourceProgress(null, {
        status: 'searching',
        count: 0,
        warning: { code: 'captcha', severity: 'block' },
        url: 'https://example.com/jobs',
        detail: 'page 1',
        jobRunId: 'run-1',
        completed: 0,
        total: 10,
      });
      const terminal = mergeSourceProgress(first, { status: 'done', count: 12 });
      assert(terminal.warning?.code === 'captcha', 'Source progress merge: warning should stay sticky when omitted');
      assert(terminal.url === 'https://example.com/jobs', 'Source progress merge: url should stay sticky when omitted');
      assert(terminal.detail === null, 'Source progress merge: detail should not stay sticky');
      assert(terminal.jobRunId === 'run-1', 'Source progress merge: job run token should stay sticky when terminal events omit it');
      const runGuard = createSourceProgressRunGuard();
      assert(runGuard.accepts('run-a') && !runGuard.accepts('run-b'),
        'Source progress run guard binds a generation to its first run token');
      runGuard.retireActive();
      assert(!runGuard.accepts('run-a') && runGuard.accepts('run-b') && !runGuard.accepts('run-a'),
        'Source progress run guard rejects late terminal events from a retired run after reset while accepting the next run');
      assert(terminal.completed === 0 && terminal.total === 10, 'Source progress merge: completed/total should stay sticky when omitted');
      const advanced = mergeSourceProgress(terminal, { status: 'searching', count: 12, completed: 4, total: 10 });
      assert(advanced.completed === 4 && advanced.total === 10, 'Source progress merge: completed/total should update when provided');
      const cleared = mergeSourceProgress(terminal, { status: 'done', count: 12, warning: null, url: null });
      assert(cleared.warning === null && cleared.url === null, 'Source progress merge: explicit null should clear sticky fields');

      // The absence of a status-regression guard is DELIBERATE, not an oversight:
      // jobs.js re-enters 'searching' for mid-run LinkedIn enrichment and for the
      // LinkedIn Solve re-fetch, and marketplace.js does the same for the
      // post-Solve comp rescrape — all on the same sourceId and the same card.
      const reEntered = mergeSourceProgress(
        { status: 'done', count: 12, detail: null, warning: null, url: null, completed: 1, total: 1 },
        { status: 'searching', count: 12, detail: 'enriching descriptions' },
      );
      assert(reEntered.status === 'searching',
        'a terminal source must be able to re-enter searching — a guard here would re-break the disappearing card');
      const jobsSrc = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
      assert(jobsSrc.includes("status: 'searching', count: linkedinKept.length, detail: 'enriching descriptions'"),
        'the producer that depends on the non-guard still exists, so the non-guard is not dead weight');
      assert(isTerminalSourceStatus('done') && isTerminalSourceStatus('error') && isTerminalSourceStatus('skipped')
        && !isTerminalSourceStatus('searching') && !isTerminalSourceStatus(undefined),
      'the shared terminal-status predicate covers exactly the settled outcomes');

      const sourceCard = fs.readFileSync(path.resolve('src/nodes/JobSourceCardNode.jsx'), 'utf8');
      // A mid-solve 'searching' beat overwrites `detail`, so latching the restore
      // on the optimistic 'Solving…' string stranded a failed Solve spinning with
      // no warning and no Solve button.
      assert(!sourceCard.includes("prev.detail !== 'Solving…'")
        && !sourceCard.includes("prev.detail === 'Solving…'")
        && sourceCard.includes('isTerminalSourceStatus(prev.status)'),
      'the pre-Solve restore yields only to a newer TERMINAL event, not to a transient detail string');
      const restoresNativeVerificationOutcome = sourceCard.includes('const rawRestoreWarning = result?.warning || prevForRestore?.warning || null')
        && sourceCard.includes("resumeState?.mode === 'native-challenge' && !rawRestoreWarning.shortLabel")
        && sourceCard.includes("? { shortLabel: 'Verification not confirmed' }")
        // The STATUS copy changes on a failed native verification; the ACTION
        && sourceCard.includes('if (rawRestoreWarning) {')
        && sourceCard.includes("status: 'error'")
        && sourceCard.includes('warning: restoreWarning');
      // The STATUS copy changes on a failed native verification; the ACTION button
      // must not. It keeps its 'Continue' fallback so it agrees with the
      // suggestion rendered directly above it ("…then click Continue again") and
      // with its own hover title — a second label for one action read as two
      // different instructions.
      //
      // Pin the PROPERTY, not one formatting of one phrase: the earlier pin
      // matched the literal "{ actionLabel: 'Retry verification' }", so
      // reintroducing the override as a standalone property, with different
      // spacing, or under any other label would have sailed past it. It also sat
      // in a seven-clause conjunction whose failure message named its siblings
      // instead of itself, so it gets its own assert.
      const overrideStart = sourceCard.indexOf('const restoreWarning = rawRestoreWarning ? {');
      const overrideEnd = sourceCard.indexOf('} : null;', overrideStart);
      assert(overrideStart !== -1 && overrideEnd > overrideStart,
        'fixture guard: the restore-warning override block must be locatable before asserting what it may not set');
      const restoreWarningOverride = sourceCard.slice(overrideStart, overrideEnd);
      assert(/shortLabel\s*:/.test(restoreWarningOverride),
        'the failed-native-verification override restyles the STATUS copy, so it must still set shortLabel');
      assert(!/actionLabel/.test(restoreWarningOverride),
        `the failed-native-verification override must set NO action label at all — the button keeps the 'Continue' fallback its own suggestion text and hover title name → ${restoreWarningOverride.replace(/\s+/g, ' ').slice(0, 220)}`);
      assert(sourceCard.includes("status: isJobSourceWarningGating(nextWarning) ? 'error' : 'done'")
        && sourceCard.includes('const resolveInFlightRef = useRef(false)')
        && sourceCard.includes('resolveInFlightRef.current = true')
        && sourceCard.includes('resolveInFlightRef.current = false')
        && restoresNativeVerificationOutcome,
      'a derived blocking warning remains an error, rapid Continue clicks are single-flight, and a failed native verification keeps its returned outcome visible');
      assert(sourceCard.includes('const jobRunId = effectiveJobSourceCardRunId(')
        && sourceCard.includes('const hubDataAtClick = getNode(data.hubId)?.data || {};')
        && !sourceCard.includes('progress?.jobRunId || requestedHubData.jobRunId || null'),
      'a source-card Solve keeps its sticky per-source token, with only the narrowly-proven legacy sources-ready gate allowed to recover a missing persisted token');
      const jobSearchRenderer = fs.readFileSync(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8');
      assert(sourceCard.includes('progressRunGuardRef.current.accepts(payload?.jobRunId)')
        && sourceCard.includes('progressRunGuardRef.current.retireActive()')
        && jobSearchRenderer.includes('jobRunId: jobRunIdRef.current || null'),
      'source cards and warning-sync seeds reject late progress from retired runs and keep the current token on a resolved card');
      const usaJobsStart = jobSearchRenderer.indexOf('const triggerUSAJobsBackgroundSearch = useCallback');
      const usaJobsEnd = jobSearchRenderer.indexOf('const handleJobsSettingsChange = useCallback', usaJobsStart);
      const usaJobsBackground = jobSearchRenderer.slice(usaJobsStart, usaJobsEnd);
      assert(usaJobsBackground.includes('searchJobsSingleSource({')
        && usaJobsBackground.includes('jobRunId: refreshGenerationRunId')
        && usaJobsBackground.includes('refreshData = getNode(currentId)?.data || null'),
      'USAJobs background progress is attached to its completed search generation and is not dropped by the JobSearch run guard');
      return { terminal, advanced, cleared };
    },
  },
{
    name: 'Job source warning policy: partial ZipRecruiter warning does not wait for Skip',
    run: () => {
      const zipPartial = { sourceId: 'ziprecruiter', code: 'description-detail-miss', severity: 'warn' };
      const zipBlocked = { sourceId: 'ziprecruiter', code: 'cloudflare-hard-block', severity: 'block' };
      const linkedinLimited = { sourceId: 'linkedin', code: 'linkedin-rate-limited', severity: 'throttle' };
      const ordinaryThrottle = { sourceId: 'indeed', code: 'temporary-throttle', severity: 'throttle' };

      assert(!isJobSourceWarningGating(zipPartial), 'a partial ZipRecruiter description warning must not delay scoring');
      assert(jobSourceWarningAction(zipPartial) === 'dismiss', 'a non-gating warning action is Dismiss, not Skip');
      assert(isJobSourceWarningGating(zipBlocked), 'a hard ZipRecruiter block must pause for Resolve/Skip');
      assert(jobSourceWarningAction(zipBlocked) === 'skip', 'a gating source action remains Skip');
      assert(isJobSourceWarningGating(linkedinLimited), 'LinkedIn guest rate-limit remains the explicit throttle exception');
      assert(!isJobSourceWarningGating(ordinaryThrottle), 'ordinary source throttles must not delay scoring');
      for (const code of [
        'description-recovery-not-ready',
        'description-recovery-snapshot-stale',
        'description-recovery-snapshot-unavailable',
      ]) {
        assert(!canAttemptJobSourceResolve({ sourceId: 'google', code, severity: 'block' }),
          `${code} is a checkpoint/ownership outcome, not an interactive retry action`);
      }
      const checkpointWriteFailure = descriptionRecoveryCheckpointWriteFailureWarning({
        sourceId: 'google', code: 'http-403', severity: 'block', url: 'https://www.google.com/search',
        action: 'solve', actionLabel: 'Solve', resumeState: { mode: 'retry' }, openSecondTab: true,
      });
      assert(checkpointWriteFailure.code === 'description-recovery-not-ready'
        && checkpointWriteFailure.action === 'none'
        && checkpointWriteFailure.url === null
        && checkpointWriteFailure.resumeState === null
        && !canAttemptJobSourceResolve(checkpointWriteFailure),
      'a failed recovery-checkpoint write leaves an informative, skippable block but cannot render another Solve loop');

      const sourceCard = fs.readFileSync(path.resolve('src/nodes/JobSourceCardNode.jsx'), 'utf8');
      const hub = fs.readFileSync(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8');
      assert(sourceCard.includes("document.addEventListener('job-source-warning-sync'")
        && sourceCard.includes('(!hasWarn || warningBlocksScoring)')
        && sourceCard.includes('replaceMatchingItems'),
      'a derived source warning keeps an actionable exact-retry control on its source card');
      const jobsBackend = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
      const scraper = fs.readFileSync(path.resolve('electron/ipc/browser/manualScraper.js'), 'utf8');
      assert(scraper.includes("phase: 'detail-external-page-text'")
        && scraper.includes('never clicks Apply, fills fields, logs in, or')
        && scraper.includes("document.body?.innerText || ''")
        && jobsBackend.includes('filterJobsByDescriptionEvidence')
        && jobsBackend.includes('not scored or marked seen'),
      'ZipRecruiter external listing URLs are read once for text without any application-form automation');
      assert(hub.includes("hubState === 'sources-ready' || hasGatingWarning")
        && hub.includes("new CustomEvent('job-source-warning-sync'"),
      'a review-gated source card cancels clean-card auto-dismiss and receives the derived warning');

      const finalWarnings = filterHandledJobSourceWarnings(
        [zipBlocked, ordinaryThrottle],
        new Set(['ziprecruiter']),
      );
      assert(finalWarnings.length === 1 && finalWarnings[0].sourceId === 'indeed',
        'a source skipped during an in-flight search must not be re-blocked by the backend final warning list');

      const latestPartial = { code: 'description-recovery', severity: 'block', shortLabel: 'Retry description recovery' };
      const reconciled = reconcileJobSourceWarnings(
        [zipBlocked, ordinaryThrottle],
        new Map([
          ['ziprecruiter', null],
          ['google', latestPartial],
        ]),
      );
      assert(reconciled.length === 2
        && reconciled.some(warning => warning.sourceId === 'indeed')
        && reconciled.some(warning => warning.sourceId === 'google' && warning.code === 'description-recovery'),
      'an in-search Skip removes its stale final warning while a successful partial Solve preserves its newest warning');
      const failedAttemptFinal = reconcileJobSourceWarnings([zipBlocked], new Map());
      assert(failedAttemptFinal.length === 1 && failedAttemptFinal[0] === zipBlocked,
        'a failed resolved:false attempt has no override and cannot suppress the backend final warning');
      assert(['queued', 'parsing', 'querying', 'interpreting-preferences', 'searching', 'scoring', 'evaluating-preferences']
        .every(isJobSourceResolveBusyHubState)
        && !isJobSourceResolveBusyHubState('sources-ready'),
      'Solve stays disabled through every gathering/checkpointing state and re-enables only once the source checkpoint is ready');
      assert(sourceCard.includes('function hasBlockingJobSearchCleanup(data)')
        && sourceCard.includes('data?.manualAiResume?.retirementPending === true')
        && sourceCard.includes("data.manualAiCleanupReceipts.some(receipt => receipt?.cancellationPending === true)")
        && sourceCard.includes('const hubCleanupBlocked = useStore(')
        && sourceCard.includes('const hubBoardRecoveryOwned = useStore(')
        && sourceCard.includes('const resolverActionDisabled = resolving || hubLocked || hubCleanupBlocked\n    || hubBoardRecoveryOwned || resolverBusy;')
        // Ownership and cleanup gating is factored into one predicate that BOTH
        // the full Skip and the mid-walk Stop must clear; only the `resolving`
        // term is relaxed for Stop, so a walk can be stopped without committing
        // the user to every remaining blocked query.
        && sourceCard.includes('const sourceOwnershipBlocked = hubLocked || hubCleanupBlocked || hubBoardRecoveryOwned;')
        && sourceCard.includes('const sourceActionDisabled = sourceOwnershipBlocked || resolving;')
        && sourceCard.includes('const canStopSolveWalk = !sourceOwnershipBlocked && resolving;')
        // Still the first guard in handleSolve; it now also reports back to a
        // "Solve all" driver instead of returning silently, which is what kept
        // the driver from hanging on a locked hub.
        && sourceCard.includes("if (hubLocked || hubCleanupBlocked || isJobWorkflowDeletionPending(data.hubId)) { finishSolveRequest('hub-locked'); return; }")
        && sourceCard.includes('|| hasBlockingJobSearchCleanup(hubData)')
        && sourceCard.includes('|| hasBlockingJobSearchCleanup(getNode(data.hubId)?.data)')
        && sourceCard.includes('|| isJobWorkflowDeletionPending(data.hubId)')
        && sourceCard.includes('disabled={sourceActionDisabled && !canStopSolveWalk}')
        && !sourceCard.includes('const sourceActionDisabled = hubLocked || hubBusy;'),
      'Solve and Skip must block for both primary and receipt-backed cancellation cleanup, including live rechecks after queue admission, while Skip remains available during an unrelated in-flight search');
      // One Solve press walks EVERY remaining blocked query for the source.
      // Each of these is a failure mode that a behavioural test cannot see:
      // a stale closure re-solving query 1 forever, a restore that rewinds to
      // the click, a mid-walk scoring start, or an unbounded loop.
      const walkStart = sourceCard.indexOf('for (;;) {');
      const walkEnd = sourceCard.indexOf('} // end blocked-query walk');
      assert(walkStart > 0 && walkEnd > walkStart,
        'the blocked-query walk loop must exist and be delimited');
      const walk = sourceCard.slice(walkStart, walkEnd);
      assert(walk.includes('url: pendingUrl,')
        && walk.includes('secondTabUrl: pendingWarning?.openSecondTab ? pendingUrl : null,')
        && !walk.includes('url: progress.url,'),
      'each pass must send the CURRENT query URL, not the render-time closure — otherwise the walk re-solves query 1 forever');
      assert(sourceCard.includes('let prevForRestore = progress ? { ...progress, jobRunId } : progress;')
        && walk.includes('prevForRestore = rearmed;'),
      'the restore baseline must be re-based each pass, or a late failure rewinds the card to the first query and discards the passes in between');
      assert(walk.includes('const stalled = guidance?.stalled === true || guidance?.recommendation === \'skip\';')
        && walk.includes('passIndex + 1 < SOLVE_WALK_MAX_PASSES')
        && walk.includes('!stopWalkRef.current')
        && walk.includes('resolverAlive()')
        && walk.includes('capturedRunIsCurrent()'),
      'the walk must stop on the backend\'s own no-progress guidance, a user Stop, a dead card, a superseded run, and a hard pass cap');
      assert(sourceCard.includes('const SOLVE_WALK_MAX_PASSES = 24;'),
        'the walk backstop must mirror the backend queue cap so it can never outlive its own queue');
      assert(walk.includes('warning: result.nextBlockedUrl\n              ? (isJobSourceWarningGating(result.warning) ? result.warning : nextBlockedWarning)'),
        'while queries remain the hub must receive a GATING warning, or it drops its pause and starts scoring mid-walk');
      assert(sourceCard.includes("code: 'description-query-blocked',\n          severity: 'block',"),
        'the synthetic next-blocked gate is severity block (holds the hub open mid-walk) and lives in the description- family so the hub\'s domain supersession can retire it');
      assert(canAttemptJobSourceResolve({ code: 'description-query-blocked', severity: 'block' }),
        'the synthetic next-blocked gate must stay solvable, or the card loses the Solve button that continues the walk');

      assert(sourceCard.includes("kind: 'job-source-resolve'")
        && sourceCard.includes('await acquireModuleRun({')
        && sourceCard.includes('(hubData.jobRunId || null) !== (jobRunId || null)')
        && sourceCard.includes('onCancel: () => {')
        && sourceCard.includes('Resolve queue cancelled before start')
        && sourceCard.includes('lease?.release()')
        && sourceCard.includes('Resolve did not start or complete'),
      'Solve/Continue uses the app-wide run queue, legacy-null-normalizes ownership after its lease, and distinguishes an intentional queue cancellation from an IPC failure');
      const queuedRunMatches = (hubRunId, cardRunId) => (hubRunId || null) === (cardRunId || null);
      assert(queuedRunMatches(undefined, null)
        && queuedRunMatches(null, undefined)
        && queuedRunMatches('same-run', 'same-run')
        && !queuedRunMatches('run-a', 'run-b')
        && !queuedRunMatches('run-a', null),
      'queued source Resolve treats absent legacy run tokens as one generation while fencing a real differing run token');
      const focusedQueueFailure = applyBugReportCode([
        '[JobSource][hub-a/google] Resolve did not start or complete: browser closed',
      ], {}, 'JOBRESOLVE');
      const focusedUnrelatedCardNoise = applyBugReportCode([
        '[JobSource][hub-a/google] persisted terminal card status=done',
      ], {}, 'JOBRESOLVE');
      assert(focusedQueueFailure.filteredLogs.length === 1
        && focusedUnrelatedCardNoise.filteredLogs.length === 0,
      'JOBRESOLVE includes the renderer queue/IPC failure signature without admitting unrelated JobSource card logs');
      const postSearchStart = hub.indexOf('const handlePostSearchResult = useCallback');
      const postSearchEnd = hub.indexOf('const runPipeline = useCallback', postSearchStart);
      const postSearch = hub.slice(postSearchStart, postSearchEnd);
      assert(postSearch.includes('saved?.success === true')
        && postSearch.includes('saved?.saved === true')
        && postSearch.includes('saved?.recoveryCheckpointSaved === true')
        && postSearch.includes('saved?.meta?.runId === jobRunId')
        && postSearch.includes('saveDescriptionRecoveryCheckpoint: true')
        && postSearch.includes("outcome: searchRunOutcome('cancelled', { runId: jobRunId })")
        && postSearch.includes('reconcileJobSourceWarnings(')
        && postSearch.includes('descriptionRecoveryCheckpointWriteFailureWarning(warning)')
        && postSearch.includes('return { shouldScore: true, warnings: latestWarnings };')
        && hub.includes('const finalWarnings = postSearchResult.warnings;')
        && hub.includes('scrapeWarnings: finalWarnings'),
      'post-search snapshot settlement rechecks cancellation and in-search Skip overrides, returns the reconciled warning list to scoring, and blocks only a strict source whose checkpoint receipt is unsafe');
      const completionStart = hub.indexOf('const completeJobRun = useCallback');
      const completionEnd = hub.indexOf('const [savedAnalysisMeta', completionStart);
      const completion = hub.slice(completionStart, completionEnd);
      assert(completion.includes('nodeId: id,')
        && (hub.match(/discardJobRun\?\.\(\{ canvasFilePath[^}]*nodeId: id/g) || []).length >= 2,
      'run completion and discard requests identify the owning hub so checkpoint cleanup cannot cross multi-hub boundaries');

      return { zipAction: jobSourceWarningAction(zipPartial), remaining: finalWarnings.map(w => w.sourceId) };
  },
},
{
    name: 'Job diagnostics: repeated ZipRecruiter detail misses retain a bounded aggregate warning',
    run: () => {
      const first = {
        code: 'description-detail-miss', severity: 'warn',
        evidence: 'ZipRecruiter could not recover a full description for "Chief Architect".',
        suggestion: 'Retry ZipRecruiter later.',
        affectedCount: 1, affectedTitles: ['Chief Architect'],
      };
      const second = {
        code: 'description-detail-miss', severity: 'warn',
        evidence: 'ZipRecruiter could not recover a full description for "Infrastructure Solutions Architect".',
        affectedCount: 1, affectedTitles: ['Infrastructure Solutions Architect'],
      };
      let aggregated = mergeDescriptionDetailMissWarning(first, second);
      for (const title of ['Chief Architect', 'Third affected role', 'Fourth affected role']) {
        aggregated = mergeDescriptionDetailMissWarning(aggregated, {
          code: 'description-detail-miss', severity: 'warn', affectedCount: 1, affectedTitles: [title],
        });
      }
      assert(aggregated.code === 'description-detail-miss' && aggregated.severity === 'warn'
        && aggregated.affectedCount === 5
        && JSON.stringify(aggregated.affectedTitles) === JSON.stringify([
          'Chief Architect', 'Infrastructure Solutions Architect', 'Third affected role',
        ]),
      'the first non-blocking warning remains authoritative while later misses add an exact count and three-title bounded sample');
      const blocked = { code: 'cloudflare-hard-block', severity: 'block', evidence: 'Blocked.' };
      assert(mergeDescriptionDetailMissWarning(blocked, second) === blocked,
        'a later detail miss never overwrites an existing blocking warning');

      const telemetry = getJobsTelemetry();
      const saved = { nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search, resolves: telemetry.resolves };
      Object.assign(telemetry, {
        nodeId: 'aggregate-detail-miss', windowId: null, resolves: {},
        search: {
          ts: Date.now(), queries: 1, raw: 531, deduped: 531, ageDropped: 0, historyDropped: 0, kept: 67,
          bySource: { ziprecruiter: { count: 531, warning: aggregated } },
        },
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['aggregate-detail-miss']), null, null);
        assert(report.includes('ziprecruiter (description-detail-miss/warn, 531 row(s) still returned)')
          && report.includes('5 listings affected')
          && report.includes('"Chief Architect"')
          && report.includes('"Infrastructure Solutions Architect"')
          && report.includes('"Third affected role"')
          && !report.includes('Fourth affected role'),
        'the FULL pipeline report shows the exact aggregate count and bounded title samples without changing the warning severity or source outcome');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { affected: aggregated.affectedCount, samples: aggregated.affectedTitles.length };
    },
  },
{
    name: 'Job card filters',
    run: () => {
      const job = { source: 'indeed', matchScore: 72 };
      assert(isJobCardVisible(job, { sourceFilter: 'indeed', scoreThreshold: 70 }), 'Job card filters: matching source and score should be visible');
      assert(!isJobCardVisible(job, { sourceFilter: 'linkedin' }), 'Job card filters: non-matching source should be hidden');
      assert(!isJobCardVisible(job, { scoreThreshold: 80 }), 'Job card filters: score below threshold should be hidden');
      assert(isJobCardVisible({}, {}), 'Job card filters: empty filter shows everything');
      assert(!isJobCardVisible({}, { scoreThreshold: 1 }), 'Job card filters: missing score counts as 0');
      return { ok: true };
    },
  },
{
    name: 'Job scoring UI uses hiring-fit semantics and preserves grounded evidence',
    run: () => {
      const card = fs.readFileSync(path.resolve('src/nodes/JobCardNode.jsx'), 'utf8');
      const search = fs.readFileSync(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8');
      const board = fs.readFileSync(path.resolve('src/nodes/jobboard/JobBoardDoneState.jsx'), 'utf8');
      const tree = fs.readFileSync(path.resolve('src/nodes/jobsearch/buildJobTree.js'), 'utf8');
      const snapshot = fs.readFileSync(path.resolve('electron/ipc/bugReport/jobsSnapshot.js'), 'utf8');
      const serialization = fs.readFileSync(path.resolve('src/utils/serializationUtils.js'), 'utf8');
      const jobsBackend = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');

      const scoreCalls = search.split('window.electronAPI.scoreJobs({').slice(1);
      const snapshotWrites = search.split('saveJobAnalysisSnapshot?.({').slice(1);
      assert(card.includes('Hiring fit')
        && card.includes('{score}/100')
        && card.includes('not a probability or guaranteed outcome')
        && !card.includes('{score}%'),
      'job cards show Hiring fit as an evidence score out of 100 without probability notation');
      assert(card.includes('function compactHiringFitAudit(assessment)')
        && card.includes('Why this score?')
        && card.includes('compactAuditSummary(hiringFitAudit)')
        && card.includes('showScoreAudit &&')
        && card.includes('Direct strengths ({hiringFitAudit.directStrengths.total})')
        && card.includes('Adjacent / transferable matches ({hiringFitAudit.adjacentMatches.total})')
        && card.includes('Not documented in career data ({hiringFitAudit.verifiedGaps.notDocumented.total})')
        && card.includes('Documented conflicts ({hiringFitAudit.verifiedGaps.contradicted.total})')
        && card.includes('Inconclusive evidence ({hiringFitAudit.verifiedGaps.unclear.total})')
        && card.includes('Unverified / rejected assessment items ({hiringFitAudit.unverifiedItems.total})')
        && card.includes('Assessment confidence: {hiringFitAudit.confidence}')
        && card.includes('Grounded coverage: {hiringFitAudit.coverage.groundedRequirementCount}')
        && card.includes('AI-assigned score: {hiringFitAudit.provenance.modelScore}/100')
        && card.includes('Validation: unchanged')
        && card.includes('assessment.confidence?.effective')
        && !card.includes('assessment.confidence?.reported')
        && !card.includes('rawModelReasoning'),
      'expanded cards disclose normalized direct and transferable matches, distinct verified gaps, safe limitations, confidence, coverage, and score provenance');
      assert(board.includes('Hiring fit ≥{scoreThreshold}/100')
        && board.includes('`≥${scoreThreshold}/100`')
        && board.includes('{scoreRangeMin}/100')
        && board.includes('Min hiring fit')
        && board.includes('aria-label="Minimum hiring fit"'),
      'board filters use the same out-of-100 hiring-fit semantics and expose an accessible minimum-fit label');
      assert(tree.includes('Excellent hiring fit (85–100)')
        && tree.includes('Partial hiring fit (40–69)')
        && tree.includes('Limited hiring fit (0–39)')
        && !tree.includes('Excellent fit (85–100%)'),
      'tree bands express hiring-fit ranges without percentage/probability notation');
      assert(scoreCalls.length === 3 && scoreCalls.every(call => call.includes('careerData:')),
        'every renderer score handoff, including saved-job re-analysis, includes raw career evidence alongside the compact profile');
      assert(snapshotWrites.length >= 3 && snapshotWrites.every(call => /\bcareerData\b/.test(call)),
        'saved-scrape snapshots retain raw career evidence for resumed scoring');
      const parseStart = search.indexOf('const parseResult = await window.electronAPI.parseCareerData');
      const queryStart = search.indexOf('// Step 2: Query construction', parseStart);
      const freshCareerWindow = search.slice(parseStart, queryStart);
      // ROLE LOCKING replaced the per-run interpretJobPreferences call in this
      // window with resolveSearchRoles (the one-time, lock-establishing
      // resolver) — see the ROLE LOCKING comment above Step 2 in
      // JobSearchNode.jsx. The underlying guarantee this assertion protects
      // (fresh parsed career data, not stale React state) still applies to
      // that call.
      const interpretationStart = search.indexOf('window.electronAPI.resolveSearchRoles', queryStart);
      const interpretationEnd = search.indexOf("if (cancelled()) return searchRunOutcome('cancelled'", interpretationStart);
      const interpretation = search.slice(interpretationStart, interpretationEnd);
      assert(freshCareerWindow.includes("activeCareerData = parseResult.careerData || ''")
        && interpretation.includes('careerData: activeCareerData'),
      'a fresh career-file parse must pass its newly extracted career data to Job Role resolution instead of waiting for React state to commit');
      assert(search.includes('const careerData = snapshot?.careerData || laneTurnData.careerData || \'\';')
        && search.includes('if (!snapshot || !profile || savedJobs.length === 0')
        && !search.includes('if (!snapshot || !profile || !careerData || savedJobs.length === 0)')
        && /careerData,\s+activeTargetRole/.test(search)
        && search.includes('jobs: jobsToEvaluate,'),
      'resuming a saved scrape restores raw career evidence when available while keeping legacy profile-only snapshots resumable');
      assert(search.includes('function isSavedAnalysisForCurrentHub')
        && search.includes('isSavedAnalysisForCurrentHub(res.snapshot, res.meta, id, canvasFilePath, data.jobAnalysisClearedAt, data.jobAnalysisClearedRunId)')
        && /isSavedAnalysisForCurrentHub\(\s*snapshot,\s*res\?\.meta,\s*id,\s*canvasFilePath,\s*laneTurnData\.jobAnalysisClearedAt,\s*laneTurnData\.jobAnalysisClearedRunId,?\s*\)/.test(search)
        && search.includes('isJobAnalysisSnapshotAfterClear(snapshot, meta, jobAnalysisClearedAt, jobAnalysisClearedRunId)')
        && !search.includes('if (!SKIP_AI_FOR_TESTING) return;'),
      'saved-scrape recovery is available for production manual-AI runs only when both the source hub and canvas match');
      assert(search.includes('jobRunId: snapshot.runId || null')
        && search.includes('let completeSnapshotRun = false;')
        && search.includes('completeSnapshotRun = runInfo?.found === true')
        && search.includes('completeRun: completeSnapshotRun'),
      'saved-scrape scoring completes only its matching staged search run and never clears a tokenless re-analysis snapshot');
      const normalScoreStart = search.indexOf('const runScoringAndSpawn = useCallback');
      const normalScoreEnd = search.indexOf('const handlePostSearchResult = useCallback', normalScoreStart);
      const normalScorePath = search.slice(normalScoreStart, normalScoreEnd);
      const linkedInRebuildStart = jobsBackend.indexOf('const persistRecoveryPool = async');
      const linkedInRebuildEnd = jobsBackend.indexOf('if (needEnrich.length > 0)', linkedInRebuildStart);
      const linkedInRebuild = jobsBackend.slice(linkedInRebuildStart, linkedInRebuildEnd);
      const googleRebuildStart = jobsBackend.indexOf('const persistSourceRecoveryJobs = async');
      const googleRebuildEnd = jobsBackend.indexOf('// The normal manual-scrape path', googleRebuildStart);
      const googleRebuild = jobsBackend.slice(googleRebuildStart, googleRebuildEnd);
      assert(normalScoreStart >= 0 && normalScoreEnd > normalScoreStart
        && normalScorePath.includes('sourceGatheredCount: gatheredCount'),
      'normal scoring writes the current found count into saved-scrape metadata alongside the score-ready jobs');
      const sourceFoundFallback = /snapshot\.sourceGatheredCount\s*\?\?\s*snapshot\.searchFunnel\?\.relevanceKept\s*\?\?\s*snapshot\.searchFunnel\?\.raw\s*\?\?\s*snapshot\.gatheredJobCount/;
      assert(sourceFoundFallback.test(search)
        && sourceFoundFallback.test(search.slice(search.indexOf('const handleResumeSavedScrape = useCallback'))),
      'batch and Saved Scrape restores prefer sourceGatheredCount, then legacy searchFunnel.relevanceKept/raw, then gatheredJobCount');
      assert(search.includes('const savedScoreReadyCount = Math.max(0, Number(savedAnalysisMeta?.gatheredJobCount) || 0)')
        && search.includes('const savedSourceGatheredCount = Number.isFinite(Number(savedAnalysisMeta?.sourceGatheredCount))')
        && search.includes('{savedSourceGatheredCount} found')
        && search.includes('${savedScoreReadyCount} score-ready'),
      'Saved Scrape labels the reconciled source-found and score-ready counters without reviving the old scraped-to-kept wording');
      assert(search.includes('const savedAnalysisMatchesCurrentRun = !!savedAnalysisMeta?.runId')
        && search.includes('&& savedAnalysisMeta.runId === data.jobRunId')
        && search.includes('const doneGatheredCount = savedAnalysisMatchesCurrentRun')
        && search.includes('gatheredCount={doneGatheredCount}'),
      'only a Saved Scrape from the exact current run token may contribute its durable found counter to the done card');
      assert(linkedInRebuildStart >= 0 && linkedInRebuildEnd > linkedInRebuildStart
        && /sourceGatheredCount:\s*snapshot\.sourceGatheredCount\s*\?\?\s*snapshot\.searchFunnel\?\.relevanceKept\s*\?\?\s*snapshot\.searchFunnel\?\.raw\s*\?\?\s*snapshot\.gatheredJobCount/.test(linkedInRebuild)
        && googleRebuildStart >= 0 && googleRebuildEnd > googleRebuildStart
        && /sourceGatheredCount:\s*sourceRecoverySnapshot\.sourceGatheredCount\s*\?\?\s*sourceRecoverySnapshot\.searchFunnel\?\.relevanceKept\s*\?\?\s*sourceRecoverySnapshot\.searchFunnel\?\.raw\s*\?\?\s*sourceRecoverySnapshot\.gatheredJobCount/.test(googleRebuild),
      'LinkedIn and Google description-recovery snapshot rebuilds preserve the original source-found count rather than replacing it with the current score-ready subset');
      assert(search.includes("|| !hasReusableCareerProfile")
        && search.includes("[hubState, canvasFilePath, hasReusableCareerProfile, id, data.jobAnalysisClearedAt, data.jobAnalysisClearedRunId]"),
      'saved-scrape recovery never reintroduces a profile deliberately cleared from this hub');
      assert(tree.includes('requirementAssessments: job.requirementAssessments')
        && tree.includes('fitAssessment: job.fitAssessment')
        && serialization.includes("'requirementAssessments'")
        && serialization.includes("'fitAssessment'"),
      'board cards and legacy migration retain the scorer’s grounded requirement and calibration audit');
      assert(snapshot.includes('Hiring-fit bands') && snapshot.includes('not a guaranteed hiring outcome'),
        'job diagnostics use hiring-fit terminology rather than an interview forecast');
      return { scoreCalls: scoreCalls.length, snapshotWrites: snapshotWrites.length };
    },
  },
{
    name: 'Job Search: re-analyze hiring fit reuses saved jobs without searching or losing them on failure',
    run: () => {
      const search = fs.readFileSync(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8');
      const doneState = fs.readFileSync(path.resolve('src/nodes/jobsearch/JobSearchDoneState.jsx'), 'utf8');
      const handlerStart = search.indexOf('const handleReanalyze = useCallback');
      const handlerEnd = search.indexOf('// Drop the hub\'s career identity', handlerStart);
      assert(handlerStart >= 0 && handlerEnd > handlerStart,
        'the search hub owns a dedicated saved-results re-analysis handler');
      const handler = search.slice(handlerStart, handlerEnd);

      // A score-only retry belongs on the completed hub. It must not be an
      // unlocked-looking control while a module is locked, and it must remain
      // distinct from Re-run Search (which intentionally starts a scrape).
      assert(doneState.includes('onReanalyze')
        && doneState.includes('Re-evaluate Saved Jobs')
        && /!locked\s*&&/.test(doneState),
      'done hubs expose Re-evaluate Saved Jobs only when the module is unlocked');
      assert(search.includes('onReanalyze={boardRecoveryOwnsActions || data.terminalFinalizationRecovery ? null : handleReanalyze}')
        && handler.includes('getNode(id)?.data?.terminalFinalizationRecovery'),
        'the completed standalone search hub wires its re-analysis action into the done state while connected Searches leave continuation to their Job Board');
      assert(search.includes("val.slice(0, 4000)")
        && (search.match(/maxLength=\{4000\}/g) || []).length >= 1
        && (doneState.match(/maxLength=\{4000\}/g) || []).length >= 1
        && doneState.includes('Job Preferences'),
      'Job Preferences preserve the backend-supported 4,000-character limit in both renderer states');

      // The saved cards are the scoring input. A re-analysis must never call a
      // search endpoint or the board-owned seen-history writer; otherwise the
      // original cards can be history-suppressed before their fit is refreshed.
      const requestedDataAt = handler.indexOf('const requestedData = safeClone(getNode(id)?.data || data);');
      const requestedFingerprintAt = handler.indexOf('const requestedFingerprint = reanalysisInputFingerprint(requestedData);', requestedDataAt);
      const displayedJobsAt = handler.indexOf('const existingScoredJobs = Array.isArray(requestedData.scoredJobs)', requestedFingerprintAt);
      const savedPoolAt = handler.indexOf('const savedPool = Array.isArray(requestedData.preferenceCandidatePool)', displayedJobsAt);
      const savedUnionAt = handler.indexOf('dedupJobsAcrossSources([...savedPool, ...existingScoredJobs])', savedPoolAt);
      const preparedJobsAt = handler.indexOf('const jobsToReanalyze = savedCandidatePool.map', savedUnionAt);
      const leaseAt = handler.indexOf('lease = await moduleRunQueue.acquireModuleRun', preparedJobsAt);
      const liveDataAt = handler.indexOf('runData = getNode(currentId)?.data || requestedData;', leaseAt);
      const liveFingerprintAt = handler.indexOf('if (reanalysisInputFingerprint(runData) !== requestedFingerprint)', liveDataAt);
      const processingAt = handler.indexOf('processingToken = processingRunsRef.current.start();', liveFingerprintAt);
      const preferenceAt = handler.indexOf('const preferenceResult = await evaluatePreferencesForRun({', processingAt);
      const scoreAt = handler.indexOf('const scoreResult = await window.electronAPI.scoreJobs({', preferenceAt);
      assert(requestedDataAt >= 0 && requestedFingerprintAt > requestedDataAt
        && displayedJobsAt > requestedFingerprintAt && savedPoolAt > displayedJobsAt
        && savedUnionAt > savedPoolAt && preparedJobsAt > savedUnionAt
        && leaseAt > preparedJobsAt && liveDataAt > leaseAt
        && liveFingerprintAt > liveDataAt && processingAt > liveFingerprintAt
        && preferenceAt > processingAt && scoreAt > preferenceAt
        && /evaluatePreferencesForRun\(\{[\s\S]*?jobs:\s*jobsToReanalyze/.test(handler)
        && /scoreJobs\(\{[\s\S]*?jobs:\s*preferenceResult\.jobs/.test(handler),
      're-analysis freezes and unions the displayed/preserved candidate pool, then revalidates its live fingerprint after queue admission before submitting clean copies through preferences and scoreJobs');
      const scoreCallAt = handler.indexOf('window.electronAPI.scoreJobs({');
      assert(scoreCallAt >= 0, 're-analysis reaches scoreJobs from inside the handler');
      const preparation = handler.slice(0, scoreCallAt);
      assert(['matchScore', 'reasoning', 'careerDirection', 'fitAssessment', 'requirementAssessments']
        .every(field => preparation.includes(field)),
      're-analysis strips prior hiring-fit-derived fields before submission so a replacement placeholder cannot retain stale assessment evidence');
      assert(!handler.includes('searchJobs(')
        && !handler.includes('appendJobsHistory')
        && !handler.includes('append-jobs-history')
        && !handler.includes('startProcessing')
        && !handler.includes('runPipeline'),
      're-analysis neither scrapes nor appends the existing listings to seen history');

      // Job Preferences may legitimately filter every saved candidate, but
      // only AFTER they have been evaluated. Any request error or cancellation
      // must restore the prior cards and settle the hub back to done instead of
      // trapping the user in a processing state.
      const firstPreferenceEvaluation = handler.indexOf('evaluatePreferencesForRun({');
      const emptyAfterPreferences = handler.indexOf('scoredJobs: [],', firstPreferenceEvaluation);
      assert(firstPreferenceEvaluation >= 0
        && (emptyAfterPreferences < 0 || emptyAfterPreferences > firstPreferenceEvaluation)
        && (/scoreResult\.scoredJobs/.test(handler) || handler.includes('runScoringAndSpawn({') || handler.includes('finishScoringAndSpawn({'))
        && /hubState:\s*'done'/.test(handler)
        && /catch\s*\(/.test(handler),
      'saved-job re-evaluation only clears jobs after preference evaluation and restores done state without losing old cards on failure/cancel');
      assert(/scrapedCount:\s*0,/.test(handler)
        && /scrapedCount:\s*preferenceResult\.jobs\.length,/.test(handler)
        && doneState.includes('const scoreReadyCount = validCount(scrapedCount)'),
      're-analysis preserves the original found total but recomputes the score-ready funnel from the current preference-accepted rows, including zero when all are filtered');

      // Board freshness is driven by the module fingerprint. A changed score
      // and a changed user-visible assessment must both make Re-combine
      // available after re-analysis; these are deliberately not a score sum.
      const before = [{
        title: 'AI Platform Architect', company: 'Aalo Atomics', url: 'https://example.test/job',
        matchScore: 67, reasoning: 'Old fit explanation',
      }];
      const after = [{
        ...before[0], matchScore: 79, reasoning: 'Professional-fit explanation without logistics',
      }];
      assert(moduleFingerprint(before) !== moduleFingerprint(after),
        'a saved-job re-analysis changes the connected board fingerprint when fit output changes');
      return { oldFingerprint: moduleFingerprint(before), newFingerprint: moduleFingerprint(after) };
    },
  },
{
    name: 'Job taxonomy indexed-role contract normalizes legacy arrays and diagnoses malformed objects without retaining labels',
    run: () => {
      const complete = { 0: 'Platform Architecture', 1: 'Data Engineering', 2: 'Platform Architecture' };
      const normalized = normalizeJobBoardRoleByIndex(complete, 3);
      assert(JSON.stringify(normalized) === JSON.stringify(['Platform Architecture', 'Data Engineering', 'Platform Architecture'])
        && validateJobBoardRoleTaxonomy(normalized, 3).valid,
      'a complete required-key object expands deterministically into the existing ordered role contract');
      const legacy = ['Engineering', 'Design'];
      assert(normalizeJobBoardRoleByIndex(legacy, 2) === legacy,
        'legacy exact arrays remain accepted without mutation');
      const productionSized = Array.from({ length: 124 }, (_, index) => `Role ${index % 7}`);
      assert(validateJobBoardRoleTaxonomy(productionSized, 124).valid
        && !validateJobBoardRoleTaxonomy(productionSized.slice(0, 123), 124).valid,
      'local atomic validation accepts all 124 assignments and rejects a one-row-short provider result');
      const shape = inspectJobBoardRoleByIndex({ 0: 'Engineering', 2: ' ', 3: 42, surprise: 'x' }, 4);
      assert(shape.type === 'object' && shape.receivedCount === 3
        && shape.missingCount === 1 && shape.missingIndices.join(',') === '1'
        && shape.blankCount === 1 && shape.blankIndices.join(',') === '2'
        && shape.nonStringCount === 1 && shape.nonStringIndices.join(',') === '3'
        && shape.extraCount === 1 && shape.extraKeys.join(',') === 'surprise',
      'shape diagnostics distinguish missing, blank, non-string, and extra entries by bounded index metadata');
      assert(!JSON.stringify(shape).includes('Engineering') && !JSON.stringify(shape).includes('surprise":"x'),
        'shape diagnostics retain no provider labels or values');
      return { normalized: normalized.length, defects: shape.missingCount + shape.blankCount + shape.nonStringCount + shape.extraCount };
    },
  },
{
    name: 'compSourceScope: normalizeCompWarnings preserves every exact blocked source',
    run: () => {
      assert(ALL_COMP_SOURCE_IDS.includes('swappa-sold') && ALL_COMP_SOURCE_IDS.includes('swappa'),
        'Swappa sold and active must have separate source cards/retry actions');
      const cards = ['ebay-sold', 'ebay-active', 'swappa-sold', 'swappa', 'reverb'];
      const out1 = normalizeCompWarnings([{ sourceId: 'swappa-sold', code: 'zero-extracted', severity: 'block' }], cards);
      assert(out1.length === 1 && out1[0].sourceId === 'swappa-sold', `swappa-sold stays exact (got ${out1[0]?.sourceId})`);
      assert(out1[0].code === 'zero-extracted' && out1[0].severity === 'block', 'warning fields preserved');
      // A real card warning is kept untouched (same ref).
      const w = { sourceId: 'ebay-sold', code: 'x' };
      const out2 = normalizeCompWarnings([w], cards);
      assert(out2.length === 1 && out2[0] === w, 'real card warning kept as-is (same ref)');
      // Sold and active variants are separate sources and both remain blocked.
      const out4 = normalizeCompWarnings([{ sourceId: 'swappa', code: 'a' }, { sourceId: 'swappa-sold', code: 'b' }], cards);
      assert(out4.length === 2, 'distinct sold/active source warnings must never collapse');
      // Unexpected sources remain blocked rather than silently pricing without them.
      const orphan = normalizeCompWarnings([{ sourceId: 'unexpected-source', code: 'x' }], cards);
      assert(orphan.length === 1 && orphan[0].sourceId === 'unexpected-source', 'unexpected source warning is preserved');
      // Multiple item-query warnings for one exact source share one source retry.
      assert(normalizeCompWarnings([{ sourceId: 'ebay-sold', code: 'a' }, { sourceId: 'ebay-sold', code: 'b' }], cards).length === 1,
        'duplicate warnings for one exact source collapse to one retry action');
      return { ok: true };
    },
  },
{
    name: 'nodePresence: resolveNodePresence prefers stamped filterStats over a dropped nodes section',
    run: () => {
      // No filter, nodes intact → scan nodes.
      const scanned = resolveNodePresence({ nodes: [{ type: 'sellhub' }, { type: 'text' }] });
      assert(scanned.hasSellNodes === true && scanned.hasJobNodes === false, 'scans nodes when no flags present');
      // The bug: a filter code (MARKET/JOBS) drops the nodes section; the stamped
      // flags must still drive the module-section gates.
      const stamped = resolveNodePresence({ filterStats: { hasSellNodes: true, hasJobNodes: false } });
      assert(stamped.hasSellNodes === true && stamped.hasJobNodes === false, 'uses stamped flags when nodes absent');
      const jobs = resolveNodePresence({ nodes: [{ type: 'jobhub' }, { type: 'jobboard' }] });
      assert(jobs.hasJobNodes === true && jobs.hasSellNodes === false, 'jobhub/jobboard count as job nodes');
      // ?? not || — a genuine false from a node-less canvas is respected.
      const empty = resolveNodePresence({ filterStats: { hasJobNodes: false, hasSellNodes: false }, nodes: [] });
      assert(empty.hasJobNodes === false && empty.hasSellNodes === false, 'genuine false flag respected');
      return { ok: true };
    },
  },
{
    name: 'dashboardStats: getStats uses combined bundle price and single-item recommended_price',
    run: () => {
      const nodes = [
        { type: 'jobcard', data: {} },
        { type: 'jobcard', data: {} },
        { type: 'sellhub', data: { hubState: 'priced', pricing: { recommended_price: 250 } } },
        { type: 'sellhub', data: { hubState: 'priced', pricing: { recommended_price: '99.5' } } },
        { type: 'sellhub', data: { hubState: 'priced', pricing: { recommended_price: null } } }, // no-comps → 0
        { type: 'sellhub', data: { hubState: 'draft', pricing: { recommended_price: 999 } } },    // not priced → excluded
        { type: 'sellhub', data: { hubState: 'priced', userPrice: 500 } },                        // legacy/wrong field → 0
        { type: 'sellhub', data: { hubState: 'priced', pricing: { recommended_price: 20 }, bundleTotal: 42, bundlePricing: { bundle_price: 40 } } },
      ];
      const { jobCardsCount, sellHubsCount, totalValue } = getStats(nodes);
      assert(jobCardsCount === 2, `getStats: jobCardsCount should be 2, got ${jobCardsCount}`);
      assert(sellHubsCount === 6, `getStats: sellHubsCount should be 6, got ${sellHubsCount}`);
      assert(totalValue === 389.5, `getStats: totalValue should include the $40 combined bundle price, got ${totalValue}`);
      return { totalValue };
    },
  },
{
    name: 'dashboardStats: getStatsSignature is stable across position-only changes, changes with priced fields',
    run: () => {
      const base = [
        { id: 'a', type: 'jobcard', position: { x: 0, y: 0 }, data: {} },
        { id: 'b', type: 'sellhub', position: { x: 0, y: 0 }, data: { hubState: 'priced', pricing: { recommended_price: 100 } } },
        { id: 'c', type: 'text', position: { x: 0, y: 0 }, data: {} },
      ];
      const moved = [
        { ...base[0], position: { x: 50, y: 30 } },  // dragged — position changed, nothing stats-relevant
        base[1],
        { ...base[2], position: { x: 10, y: 10 } },
      ];
      assert(getStatsSignature(base) === getStatsSignature(moved),
        'a pure position-only change (drag) must not change the signature');

      const rePriced = [base[0], { ...base[1], data: { hubState: 'priced', pricing: { recommended_price: 200 } } }, base[2]];
      assert(getStatsSignature(base) !== getStatsSignature(rePriced),
        'a changed recommended_price must change the signature');

      const stateChanged = [base[0], { ...base[1], data: { ...base[1].data, hubState: 'draft' } }, base[2]];
      assert(getStatsSignature(base) !== getStatsSignature(stateChanged),
        'a changed hubState must change the signature');

      const added = [...base, { id: 'd', type: 'jobcard', position: { x: 0, y: 0 }, data: {} }];
      assert(getStatsSignature(base) !== getStatsSignature(added),
        'adding a jobcard must change the signature');
      return { ok: true };
    },
  },
{
    name: 'Job search funnel: every raw candidate has a persisted disposition',
    run: () => {
      const reconciled = reconcileSearchFunnel({
        raw: 336,
        relevanceDropped: 0,
        deduped: 336,
        ageDropped: 0,
        historyDropped: 0,
        descriptionEvidenceDropped: { total: 79 },
        kept: 257,
      });
      assert(reconciled.reconciled && reconciled.expectedKept === 257 && reconciled.unexplainedDelta === 0,
        `336→257 is explained when 79 low-evidence rows are persisted in the funnel, got ${JSON.stringify(reconciled)}`);

      const missing = reconcileSearchFunnel({
        raw: 336,
        relevanceDropped: 0,
        deduped: 336,
        ageDropped: 0,
        historyDropped: 0,
        descriptionEvidenceDropped: { total: 0 },
        kept: 257,
      });
      assert(!missing.reconciled && missing.unexplainedDelta === -79,
        `an unexplained 79-row loss must fail reconciliation, got ${JSON.stringify(missing)}`);
      const finalDedup = reconcileSearchFunnel({
        raw: 10, relevanceDropped: 0, deduped: 10, ageDropped: 1,
        historyDropped: 2, descriptionEvidenceDropped: { total: 1 },
        finalDedupDropped: 1, kept: 5,
      });
      assert(finalDedup.reconciled && finalDedup.expectedKept === 5 && finalDedup.finalDedupDropped === 1,
        `a final enrichment-ready dedup must be an explicit reconciled funnel stage, got ${JSON.stringify(finalDedup)}`);
      return { kept: reconciled.kept, explainedDrops: reconciled.descriptionEvidenceDropped };
    },
  },
{
    name: 'Job search funnel: the AI role screen is an accounted stage, not an unexplained loss, and the report names the mechanism that actually produced its drops',
    run: () => {
      // A pinned role rejects every title missing one of its words. That drop
      // happens between the age and history stages, so the reconciler must
      // subtract it — otherwise every role-pinned run reports a false
      // funnel-integrity warning.
      const gated = reconcileSearchFunnel({
        raw: 400,
        relevanceDropped: 0,
        deduped: 400,
        ageDropped: 20,
        roleDropped: 300,
        historyDropped: 10,
        descriptionEvidenceDropped: { total: 0 },
        kept: 70,
      });
      assert(gated.reconciled && gated.expectedKept === 70 && gated.unexplainedDelta === 0,
        `a 300-row role-gate drop must be explained, got ${JSON.stringify(gated)}`);
      assert(gated.roleDropped === 300, 'roleDropped is surfaced for the report line');

      // The stage still exists, but the MECHANISM behind it changed: a
      // deterministic word-match gate became a semantic AI screen. A report
      // that still described the old mechanism would send a reader hunting for
      // a pinned exact-match string that no longer exists as an input, and
      // would explicitly tell them NOT to suspect the LLM call that is now the
      // only source of these drops.
      const snapSrc = fs.readFileSync(path.resolve('electron/ipc/bugReport/jobsSnapshot.js'), 'utf8');
      assert(!snapSrc.includes('the role gate is the pinned target role, not a relevance heuristic'),
        'the report must not still claim these drops come from a pinned target role -- that mechanism is deleted');
      assert(!snapSrc.includes('every title had to contain'),
        'the report must not still print a token rule -- a semantic screen has no token set');
      assert(snapSrc.includes('- AI role screen: dropped ') && snapSrc.includes('role-screen-dropped'),
        'the funnel stage and its detail line must name the AI role screen that actually produced the drops');
      assert(snapSrc.includes('it keeps anything it cannot tell'),
        'the report must state the screen fails OPEN, so a drop means the model positively judged the row a different kind of job');
      assert(snapSrc.includes('x?.reason'),
        "each sampled drop must carry the model's own stated reason -- with no rule text to print, the reason IS the evidence");

      // The same run WITHOUT the stage registered is exactly the false alarm
      // this guards against.
      const unregistered = reconcileSearchFunnel({
        raw: 400,
        relevanceDropped: 0,
        deduped: 400,
        ageDropped: 20,
        historyDropped: 10,
        descriptionEvidenceDropped: { total: 0 },
        kept: 70,
      });
      assert(!unregistered.reconciled && unregistered.unexplainedDelta === -300,
        `an unregistered role-gate drop must fail reconciliation, got ${JSON.stringify(unregistered)}`);

      // A role-less run is untouched: the field is absent and reconciliation is
      // identical to how it behaved before the gate existed.
      const roleless = reconcileSearchFunnel({
        raw: 100, relevanceDropped: 0, deduped: 100, ageDropped: 0,
        historyDropped: 0, descriptionEvidenceDropped: { total: 0 }, kept: 100,
      });
      assert(roleless.reconciled && roleless.roleDropped === 0,
        `a role-less run must reconcile with roleDropped 0, got ${JSON.stringify(roleless)}`);
      return { gatedDrop: gated.roleDropped, kept: gated.kept };
    },
  },
{
    name: 'Live scoring: partial rows retry only absent or calibration-invalid indices',
    run: () => {
      const partial = planPartialScoreRecovery([
        { index: 2, matchScore: 20 },
        { index: 0, matchScore: 80 },
        { index: 2, matchScore: 99 },
        { index: 7, matchScore: 5 },
      ], 4);
      assert(partial.usable && partial.missingIndices.join(',') === '1,3'
        && partial.alignedScores.map(score => score?.matchScore ?? null).join(',') === '80,,20,',
      'partial rows must retain original index order, ignore duplicate/out-of-range rows, and request only omitted indices');

      const complete = planPartialScoreRecovery([
        { index: 1, matchScore: 40 }, { index: 0, matchScore: 70 },
      ], 2);
      assert(complete.usable && complete.missingIndices.length === 0
        && complete.alignedScores.map(score => score.matchScore).join(',') === '70,40',
      'out-of-order complete rows must not schedule a missing-index recovery');

      const unusable = planPartialScoreRecovery([{ index: 9, matchScore: 1 }], 2);
      assert(!unusable.usable && unusable.alignedScores === null && unusable.missingIndices.length === 0,
        'a response with no requested index must remain eligible for the existing recursive split fallback');

      const job = { title: 'Frontend Engineer', snippet: 'Required: React experience.' };
      const invalid = {
        index: 0, matchScore: 95, reasoning: 'Strong fit.', careerDirection: 'Frontend',
        requirementAssessments: [], materialGaps: [], confidence: 'high', experienceAssessment: {},
      };
      const semantic = prepareLiveScoringResults([invalid], [job], {
        candidateText: 'Built React interfaces for internal tools.', candidateRoles: [],
      });
      assert(semantic.scores[0] === null && semantic.placeholderCount === 1,
        'an indexed but calibration-invalid row remains a final-null recovery candidate rather than a genuine score');
      return { missing: partial.missingIndices.length, semanticInvalid: semantic.placeholderCount };
    },
  },
{
    name: 'Manual job scoring: a partial long answer reaches a strict locally reindexed recovery handoff',
    run: () => {
      const candidateText = 'Built React interfaces for internal tools.';
      const jobs = Array.from({ length: 15 }, (_, index) => ({
        // Original search indexes are deliberately non-local. Every handoff
        // produced by slimBatch presents its own local 0..N-1 index space.
        index: 100 + index,
        title: `Frontend Engineer ${index}`,
        snippet: 'Required: React experience.',
      }));
      const scoreRow = (index) => ({
        index,
        matchScore: 80,
        reasoning: 'Grounded React fit.',
        careerDirection: 'Frontend Engineering',
        requirementAssessments: [{
          requirementText: 'React experience', priority: 'required',
          jobEvidence: 'Required: React experience.', status: 'direct',
          candidateEvidence: candidateText, explanation: 'Direct evidence.',
        }],
        materialGaps: [],
        confidence: 'high',
      });
      const omitted = new Set([2, 9, 12, 14]);
      const partialRows = Array.from({ length: 15 }, (_, index) => scoreRow(index))
        .filter(row => !omitted.has(row.index));
      const initial = validateJobScoringSubmission(
        { scores: partialRows },
        jobs,
        { candidateText, candidateRoles: [], requireComplete: false },
      );
      assert(initial.responsePlan.missingIndices.join(',') === '2,9,12,14'
        && initial.invalidIndices.length === 0,
      'the attached 11/15 response shape must be accepted for targeted recovery, not mislabeled as four ungrounded rows');

      const recoveryJobs = initial.responsePlan.missingIndices.map(index => jobs[index]);
      const recovered = validateJobScoringSubmission(
        { scores: recoveryJobs.map((_, localIndex) => scoreRow(localIndex)) },
        recoveryJobs,
        { candidateText, candidateRoles: [], requireComplete: true },
      );
      assert(recovered.responsePlan.missingIndices.length === 0
        && recovered.invalidIndices.length === 0
        && recovered.responsePlan.alignedScores.map(row => row.index).join(',') === '0,1,2,3',
      'the four-job recovery uses the prompt-local 0..3 indexes even though its source jobs came from slots 2, 9, 12, and 14');
      const merged = mergeRecoveredScoreRows(
        initial.responsePlan.alignedScores,
        initial.responsePlan.missingIndices,
        recovered.responsePlan.alignedScores,
      );
      assert(merged.length === 15
        && merged.every((row, index) => row?.index === index),
      'locally indexed recovery rows are translated back to their parent slots before scored cards are built');

      let strictFailure = null;
      try {
        validateJobScoringSubmission(
          { scores: recoveryJobs.slice(0, 3).map((_, localIndex) => scoreRow(localIndex)) },
          recoveryJobs,
          { candidateText, candidateRoles: [], requireComplete: true },
        );
      } catch (error) { strictFailure = error; }
      assert(strictFailure?.message.includes('missing score rows at index 3'),
        'an incomplete final recovery stays pending with an accurate missing-row error');

      // The merge mapping is POSITIONAL — recovered[i] restores indexes[i] —
      // and holds only because scoreBatch returns one row per input job. This is
      // the single place a "scored N/N" total could go wrong with every stage
      // still agreeing, so pin what a short array does: the covered slots stay
      // correctly aligned and the uncovered ones become placeholders (visible in
      // the report), never a silent off-by-one that scores a job as another job.
      const shortMerge = mergeRecoveredScoreRows(
        initial.responsePlan.alignedScores,
        initial.responsePlan.missingIndices,
        recovered.responsePlan.alignedScores.slice(0, 2),
      );
      const missing = initial.responsePlan.missingIndices;
      assert(shortMerge.length === 15
        && missing.slice(0, 2).every(index => shortMerge[index]?.index === index)
        && missing.slice(2).every(index => shortMerge[index] === null),
      'a short recovery array leaves placeholders at the uncovered slots and never shifts a score onto the wrong job');
      assert(shortMerge.every((row, index) => row === null || row.index === index),
        'every surviving row still names the slot it occupies');
      return { acceptedInitialRows: partialRows.length, recoveryRows: recoveryJobs.length };
    },
  },
{
    name: 'Scoring audit: retains batch evidence and flags identical cross-batch JD drift',
    run: () => {
      const jd = 'Perform scheduled cleanings, update signage, inspect electrical components, and maintain automated teller machines. '.repeat(6);
      const batches = [
        [{ title: 'Bank Equipment Technician', company: 'Cennox', location: 'Madison, AL', url: 'https://jobs/1', source: 'dice', snippet: jd }],
        [{ title: 'Bank Equipment Technician', company: 'Cennox', location: 'Phoenix, AZ', url: 'https://jobs/2', source: 'dice', snippet: jd }],
      ];
      const scored = [
        { ...batches[1][0], matchScore: 35, rawScore: 35, adjustedScore: 35, careerDirection: 'Field Operations', reasoning: 'Large fit gaps.' },
        {
          ...batches[0][0], matchScore: 55, rawScore: 86, adjustedScore: 55, careerDirection: 'Field Services',
          reasoning: 'Grounded material gap lowers the fit score.',
          fitAssessment: { adjustments: [{ code: 'critical-gap', from: 86, to: 55 }], rawModelReasoning: 'Unsupported upbeat model prose.' },
        },
      ];
      const audit = buildScoringAudit(scoringAuditRowsFromBatches(batches, scored));
      assert(audit.rows.length === 2 && audit.rows[0].batch === 1 && audit.rows[0].score === 55,
        'audit restores original batch attribution after scored jobs are sorted');
      assert(audit.anomalies.length === 1 && audit.anomalies[0].delta === 20,
        `identical cross-batch postings with a 20-point delta are flagged, got ${JSON.stringify(audit.anomalies)}`);
      assert(audit.rows.every(row => row.url && row.reason && row.descriptionFingerprint)
        && audit.rows[0].rawScore === 86 && audit.rows[0].adjustedScore === 55
        && audit.rows[0].adjustments[0]?.code === 'critical-gap'
        && !JSON.stringify(audit.rows).includes('Unsupported upbeat model prose.'),
        'bounded rows retain score calibration evidence without retaining ungrounded model prose');
      return { ok: true, anomalies: audit.anomalies.length };
  },
},
{
    name: 'Scoring audit: placeholder evidence survives bounds and reordered anomaly lookup',
    run: () => {
      const jd = 'Maintain automated teller machines, update signage, inspect electrical components, and complete preventative maintenance. '.repeat(6);
      const ordinary = Array.from({ length: 50 }, (_, index) => ({
        title: index < 2 ? 'Bank Equipment Technician' : `Ordinary role ${index}`,
        company: index < 2 ? 'Cennox' : `Company ${index}`,
        location: index === 0 ? 'Madison, AL' : index === 1 ? 'Phoenix, AZ' : 'Toronto, ON',
        source: 'dice',
        url: `https://jobs/ordinary-${index}`,
        snippet: index < 2 ? jd : `Ordinary job ${index} ${jd}`,
        matchScore: index === 0 ? 55 : index === 1 ? 35 : 40,
        careerDirection: index < 2 ? 'Field Services' : 'Other',
        reasoning: index < 2 ? 'Grounded score.' : 'Ordinary grounded score.',
      }));
      const placeholder = {
        title: 'Late placeholder role', company: 'Example', location: 'Toronto, ON', source: 'ziprecruiter',
        url: 'https://jobs/placeholder', snippet: jd, matchScore: 50, careerDirection: 'Other', reasoning: 'Unable to score',
      };
      const audit = buildScoringAudit([
        ...ordinary.map((job, index) => ({ batch: index === 1 ? 2 : 1, job })),
        { batch: 3, job: placeholder },
      ]);
      assert(audit.rows.length === 50 && audit.omitted === 1,
        `placeholder prioritization must retain the existing 50-row bound and omitted count, got ${audit.rows.length}/${audit.omitted}`);
      assert(audit.rows[0].placeholder === true && audit.rows[0].title === 'Late placeholder role'
        && audit.rows[0].url === 'https://jobs/placeholder',
      'a late canonical placeholder must displace ordinary evidence and lead the bounded audit');
      assert(audit.anomalies.length === 1 && audit.anomalies[0].first.index === 0 && audit.anomalies[0].second.index === 1,
        'cross-batch anomalies retain original source indices after placeholder prioritization');

      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search,
        resolves: telemetry.resolves, scoring: telemetry.scoring, bucketing: telemetry.bucketing,
      };
      Object.assign(telemetry, {
        nodeId: 'placeholder-audit-diagnostics', windowId: null, search: null, resolves: {}, bucketing: null,
        scoring: {
          ts: Date.now(), input: 51, selectedForScoring: 51, cappedForBudget: 0, scored: 51,
          placeholders: 1, batches: 3, failedBatches: 0, unscored: 0, models: ['claude-test'], audit,
        },
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['placeholder-audit-diagnostics']), null, null);
        assert(report.includes('Late placeholder role') && report.includes('⚠️ placeholder (not analyzed)')
          && report.includes('URL: https://jobs/placeholder') && report.includes('reason: "Unable to score"'),
        'the first ten report evidence rows visibly identify the otherwise-late placeholder');
        assert(report.includes('20-point cross-batch drift') && report.includes('https://jobs/ordinary-0')
          && report.includes('https://jobs/ordinary-1'),
        'anomaly rendering resolves rows by their original indices after placeholder prioritization');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { rows: audit.rows.length, omitted: audit.omitted, anomalies: audit.anomalies.length };
    },
  },
{
    name: 'Scoring batches: identical postings stay together for one-pass calibration',
    run: () => {
      const jd = 'Maintain automated teller machines, inspect electrical components, update signage, and perform preventative maintenance. '.repeat(5);
      const jobs = [
        { title: 'Unique A', company: 'Acme', snippet: 'short a' },
        { title: 'Bank Equipment Technician', company: 'Cennox', location: 'Madison, AL', snippet: jd, url: 'https://jobs/1' },
        { title: 'Unique B', company: 'Beta', snippet: 'short b' },
        { title: 'Unique C', company: 'Gamma', snippet: 'short c' },
        { title: 'Bank Equipment Technician', company: 'Cennox', location: 'Phoenix, AZ', snippet: jd, url: 'https://jobs/2' },
      ];
      const batches = chunkScoringBatches(jobs, 3);
      const firstBatch = batches.findIndex(batch => batch.some(job => job.url === 'https://jobs/1'));
      const secondBatch = batches.findIndex(batch => batch.some(job => job.url === 'https://jobs/2'));
      assert(firstBatch >= 0 && firstBatch === secondBatch,
        `same title/company/JD postings should share a scoring prompt, got batches ${firstBatch}/${secondBatch}`);
      assert(batches.every(batch => batch.length <= 3), 'similarity packing still honors the model-aware item cap');
      return { ok: true, batchCount: batches.length };
    },
  },
{
    name: 'Job source resolve merge',
    run: () => {
      const existing = [
        { title: 'Indeed A', company: 'Acme', url: 'https://jobs/a', source: 'indeed' },
        { title: 'LinkedIn A', company: 'Acme', url: 'https://jobs/li-a', source: 'linkedin', snippet: '' },
        { title: 'Other', company: 'Beta', url: 'https://jobs/b', source: 'remoteok' },
      ];
      const incremental = mergeResolvedSourceItems(existing, [
        { title: 'Indeed B', company: 'Acme', url: 'https://jobs/indeed-b', source: 'indeed' },
      ], 'indeed');
      assert(incremental.replacedExisting === 0, 'Job source resolve merge: incremental source should not drop existing same-source jobs');
      assert(incremental.mergedPending.filter(j => j.source === 'indeed').length === 2, 'Job source resolve merge: incremental source should append fresh jobs');

      const replacement = mergeResolvedSourceItems(existing, [
        { title: 'LinkedIn A', company: 'Acme', url: 'https://jobs/li-a', source: 'linkedin', snippet: 'full description' },
        { title: 'LinkedIn B', company: 'Acme', url: 'https://jobs/li-b', source: 'linkedin', snippet: 'full description' },
      ], 'linkedin', { replaceSourceItems: true });
      assert(replacement.replacedExisting === 1, 'Job source resolve merge: replacement source should drop stale same-source jobs');
      assert(replacement.mergedPending.filter(j => j.source === 'linkedin').length === 2, 'Job source resolve merge: replacement source should use returned full source set');

      const exactReplacement = mergeResolvedSourceItems(existing, [
        { title: 'Indeed A', company: 'Acme', url: 'https://jobs/a', source: 'indeed', snippet: 'recovered full description' },
      ], 'indeed', { replaceMatchingItems: true });
      assert(exactReplacement.mergedPending.length === existing.length
        && exactReplacement.replacedExisting === 1
        && exactReplacement.mergedPending.some(job => job.url === 'https://jobs/a' && job.snippet === 'recovered full description'),
      'Job source resolve merge: exact retry replaces the matching pending row without dropping unrelated jobs');

      const unavailableRemoval = mergeResolvedSourceItems(existing, [], 'indeed', {
        removedItemKeys: ['https://jobs/a'],
      });
      assert(unavailableRemoval.mergedPending.length === existing.length - 1
        && unavailableRemoval.mergedPending.every(job => job.url !== 'https://jobs/a')
        && unavailableRemoval.mergedPending.some(job => job.url === 'https://jobs/li-a'),
      'Job source resolve merge: an unavailable exact retry removes only that stale listing');

      // Cross-source collapse (same-run policy): a resolved LinkedIn copy of a
      // posting Indeed already returned must NOT enter pendingJobs twice — the
      // backend's dedupByTitleCompany would have collapsed it had LinkedIn not
      // blocked. (Was URL-keyed, so the two copies both reached the scorer.)
      const crossSource = mergeResolvedSourceItems(existing, [
        { title: 'Indeed A', company: 'Acme', url: 'https://jobs/li-dup', source: 'linkedin' },
        { title: 'LinkedIn New', company: 'Acme', url: 'https://jobs/li-new', source: 'linkedin' },
      ], 'linkedin');
      assert(crossSource.fresh.length === 1 && crossSource.fresh[0].title === 'LinkedIn New',
        'Job source resolve merge: cross-source duplicate (same title+company, different board URL) collapses');
      return { incremental: incremental.mergedPending.length, replacement: replacement.mergedPending.length };
    },
  },
{
    name: 'computeJobTreeView: pagination window slices MATCHING cards (filter backfill + ghost tolerance)',
    run: () => {
      // Role leaf with 15 cards: the first 10 from 'lever', the last 5 from
      // 'dice'. Regression: the window used to slice RAW childIds then filter,
      // so a dice source-filter on the expanded role revealed slice(0,10) → 0
      // cards while 5 matches sat beyond the window ("empty" expanded role).
      const cardIds = Array.from({ length: 15 }, (_, i) => `c${i}`);
      const tree = () => ([
        { id: 'hub', type: 'jobboard', position: { x: 0, y: 0 }, data: {} },
        { id: 'R', type: 'jobgroup', hidden: false, position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'role', label: 'Eng', childIds: cardIds, expanded: true, visibleCount: 10 } },
        ...cardIds.map((id, i) => ({
          id, type: 'jobcard', hidden: true, position: { x: 0, y: 0 },
          data: { hubId: 'hub', matchScore: 90 - i, source: i < 10 ? 'lever' : 'dice' },
        })),
      ]);
      const hiddenOf = (out, id) => !!out.find(n => n.id === id)?.hidden;

      const diced = computeJobTreeView(tree(), 'hub', { sourceFilter: 'dice' });
      const revealedDice = cardIds.filter(id => !hiddenOf(diced, id));
      assert(revealedDice.length === 5 && revealedDice.every(id => Number(id.slice(1)) >= 10),
        `source filter backfills matches beyond the raw window (got ${revealedDice.join(',')})`);
      // Every revealed card must also get a layout position (the layout walks
      // ALL children and skips hidden — it must not re-impose the raw window).
      const positioned = computeLayoutPositions(diced, 'hub', COL_X, { x: 0, y: 0 });
      assert(revealedDice.every(id => positioned[id]), 'revealed beyond-window cards are positioned');

      // No filter: the window still reveals exactly the first 10.
      const plain = computeJobTreeView(tree(), 'hub', {});
      const revealedPlain = cardIds.filter(id => !hiddenOf(plain, id));
      assert(revealedPlain.length === 10 && revealedPlain.every(id => Number(id.slice(1)) < 10),
        'no filter: window reveals exactly the first visibleCount cards');

      // Dismissed ghosts: drop 3 of the first 10 cards from the node set — the
      // window must backfill the next live cards instead of counting ghosts.
      const withGhosts = tree().filter(n => !['c0', 'c1', 'c2'].includes(n.id));
      const backfilled = computeJobTreeView(withGhosts, 'hub', {});
      const revealedLive = cardIds.filter(id => withGhosts.some(n => n.id === id) && !hiddenOf(backfilled, id));
      assert(revealedLive.length === 10, `ghost ids do not consume pagination slots (revealed ${revealedLive.length})`);
      return { ok: true };
    },
  },
{
    name: 'countMatchingDescendantCards: live badge/pagination math skips ghosts + filtered cards',
    run: () => {
      const nodes = new Map([
        ['R', { id: 'R', type: 'jobgroup', data: { childIds: ['a', 'b', 'gone'] } }],
        ['S', { id: 'S', type: 'jobgroup', data: { childIds: ['R', 'c'] } }],
        ['a', { id: 'a', type: 'jobcard', data: { matchScore: 90, source: 'lever' } }],
        ['b', { id: 'b', type: 'jobcard', data: { matchScore: 40, source: 'dice' } }],
        ['c', { id: 'c', type: 'jobcard', data: { matchScore: 70, source: 'dice' } }],
      ]);
      const get = (id) => nodes.get(id);
      assert(countMatchingDescendantCards(['a', 'b', 'gone'], get, {}) === 2, 'leaf: dismissed id does not count');
      assert(countMatchingDescendantCards(['a', 'b'], get, { scoreThreshold: 50 }) === 1, 'leaf: filtered card does not count');
      assert(countMatchingDescendantCards(['R', 'c'], get, {}) === 3, 'recursive: counts cards under nested groups');
      assert(countMatchingDescendantCards(['R', 'c'], get, { sourceFilter: 'dice' }) === 2, 'recursive + filter');
      // Cycle-safe: a malformed tree must not hang.
      nodes.set('X', { id: 'X', type: 'jobgroup', data: { childIds: ['X', 'a'] } });
      assert(countMatchingDescendantCards(['X'], get, {}) === 1, 'cycle-guarded');
      return { ok: true };
    },
  },
{
    name: 'computeJobTreeView: malformed reachable childIds cycle remains renderable',
    run: () => {
      // A hand-edited/legacy canvas can contain a loop beneath an otherwise
      // valid root. The count pass was guarded, but the visibility walk used to
      // recurse forever as soon as the cycle had a matching card.
      const nodes = [
        { id: 'hub', type: 'jobboard', position: { x: 0, y: 0 }, data: {} },
        { id: 'root', type: 'jobgroup', hidden: false, position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'likelihood', expanded: true, childIds: ['loop'] } },
        { id: 'loop', type: 'jobgroup', hidden: true, position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'salary', expanded: true, childIds: ['loop', 'card'] } },
        { id: 'card', type: 'jobcard', hidden: true, position: { x: 0, y: 0 }, data: { hubId: 'hub', matchScore: 90, source: 'indeed' } },
      ];
      const out = computeJobTreeView(nodes, 'hub', {});
      assert(out.find(n => n.id === 'root')?.hidden === false, 'cycle: reachable root remains visible');
      assert(out.find(n => n.id === 'loop')?.hidden === false, 'cycle: first loop group remains visible');
      assert(out.find(n => n.id === 'card')?.hidden === false, 'cycle: matching card remains visible');
      return { ok: true };
    },
  },
{
    name: 'Job tree: hiring-fit → salary → role hierarchy',
    run: () => {
      const mk = (title, score, salary, url) => ({
        title, company: 'Acme', location: 'Remote', salary, snippet: 'x',
        matchScore: score, reasoning: 'r', careerDirection: 'x',
        source: 'lever', url, posted: 'today',
      });
      // idx0/idx1 excellent+pay, idx2 long-shot+nopay.
      const displayedJobs = [
        { ...mk('Brand Lead', 92, '$150,000 a year', 'https://jobs/0'), originHubId: 'search-A' },
        mk('Growth Mgr', 88, '$70,000 a year', 'https://jobs/1'),
        mk('Brand Intern', 30, '', 'https://jobs/2'),
      ];
      const result = buildJobTreeNodes({
        displayedJobs,
        bucketTree: {
          likelihoodBands: [
            { label: 'Strong (70–100%)', minScore: 70, maxScore: 100 },
            { label: 'Long shot (0–69%)', minScore: 0, maxScore: 69 },
          ],
          salaryRanges: [
            { label: '$100k+', minSalary: 100000, maxSalary: 0 },
            { label: '$50-100k', minSalary: 50000, maxSalary: 100000 },
            { label: 'Unspecified', minSalary: 0, maxSalary: 0 },
          ],
          roles: [
            { name: 'Brand Marketing', jobIndices: [0, 2] },
            { name: 'Growth', jobIndices: [1] },
          ],
        },
        profile: { skills: ['x'] },
        originalPos: { x: 0, y: 0 }, hubId: 'hub-1', baseNodeId: 'job-h',
      });
      const byKind = (k) => result.newNodes.filter(n => n.data?.kind === k);
      const cards = result.newNodes.filter(n => n.type === 'jobcard');
      const bands = byKind('likelihood');
      const salary = byKind('salary');
      const roles = byKind('role');
      assert(cards.length === 3, `hierarchy: expected 3 cards, got ${cards.length}`);
      // Two fixed-rubric bands present (Excellent has 2 jobs, Limited has 1).
      assert(bands.length === 2, `hierarchy: expected 2 hiring-fit bands, got ${bands.length}`);
      const excellent = bands.find(b => b.data.label.startsWith('Excellent'));
      const limited = bands.find(b => b.data.label.startsWith('Limited hiring fit'));
      assert(excellent.data.count === 2 && limited.data.count === 1, `hierarchy: band counts wrong (${excellent.data.count}/${limited.data.count})`);
      // Bands are roots (children of hub, not of any group) and ordered best-first.
      assert(excellent.position.y < limited.position.y, 'hierarchy: Excellent band should sit above Limited');
      // Excellent band → two salary ranges ($100k+ for idx0, $50-100k for idx1).
      const excellentRanges = salary.filter(s => (excellent.data.childIds || []).includes(s.id));
      assert(excellentRanges.length === 2, `hierarchy: Excellent band should have 2 salary ranges, got ${excellentRanges.length}`);
      // Highest salary range ordered first WITHIN the band — checked via
      // childIds order, since nothing auto-expands at analysis end so the salary
      // nodes (hidden under the collapsed band) have no laid-out position.
      const hi = excellentRanges.find(s => s.data.label === '$100k+/yr');
      const lo = excellentRanges.find(s => s.data.label === '$50k–$100k/yr');
      assert(excellent.data.childIds[0] === hi.id && excellent.data.childIds[1] === lo.id, 'hierarchy: higher salary range should be ordered first within the band');
      // idx2 (no salary, weak) lands in the Limited hiring-fit band's Unspecified range.
      const lsRange = salary.find(s => (limited.data.childIds || []).includes(s.id));
      assert(lsRange.data.label === 'Unspecified', 'hierarchy: no-salary job should land in Unspecified');
      // Role leaves hold the cards.
      assert(roles.every(r => (r.data.childIds || []).every(cid => cards.some(c => c.id === cid))), 'hierarchy: role children should be cards');
      assert(result.scoreRangeMin === 30 && result.scoreRangeMax === 92, 'hierarchy: score range from displayed jobs');
      // Cards carry a string reference to their ORIGIN search module (for
      // "Generate Résumé" career-data lookup), never a profile deep copy.
      const brandLead = cards.find(c => c.data.title === 'Brand Lead');
      assert(brandLead.data.originHubId === 'search-A', 'hierarchy: card carries its origin module id');
      assert(cards.every(c => !('resumeProfile' in c.data)), 'hierarchy: no per-card resumeProfile copies');
      return { cards: cards.length, bands: bands.length, salary: salary.length, roles: roles.length };
  },
},
{
    name: 'Job tree: missing taxonomy is rejected before any cards can be created',
    run: () => {
      // A failed or absent taxonomy is not valid input for a combine. The
      // caller must abort before mutating the existing board rather than
      // synthesizing an unreviewed tree from score/salary/direction hints.
      let error = null;
      try {
        buildJobTreeNodes({
        displayedJobs: [
          { title: 'Senior Engineer', company: 'Acme', location: 'Remote', salary: '$160,000 a year', matchScore: 91, careerDirection: 'Platform Engineering', source: 'lever' },
          { title: 'Product Analyst', company: 'Acme', location: 'Toronto', salary: '$75,000 a year', matchScore: 72, careerDirection: 'Analytics', source: 'dice' },
          { title: 'Career Switcher', company: 'Acme', location: 'Remote', salary: '', matchScore: 31, careerDirection: '', source: 'indeed' },
        ],
        bucketTree: null,
        originalPos: { x: 100, y: 200 }, hubId: 'board', baseNodeId: 'fallback',
        });
      } catch (caught) {
        error = caught;
      }
      assert(error instanceof Error && /taxonomy/i.test(error.message),
        'missing taxonomy must throw a clear error before the renderer produces any cards');
      return { rejected: true };
    },
  },
{
    name: 'Job tree: parseable low salary does not land in Unspecified',
    run: () => {
      const displayedJobs = [
        {
          title: 'Coordinator', company: 'Acme', location: 'Remote',
          salary: '$45,000 a year', snippet: 'x', matchScore: 80,
          reasoning: 'r', careerDirection: 'Operations', source: 'lever',
          url: 'https://jobs/low', posted: 'today',
        },
        {
          title: 'Mystery Role', company: 'Acme', location: 'Remote',
          salary: '', snippet: 'x', matchScore: 78,
          reasoning: 'r', careerDirection: 'Operations', source: 'lever',
          url: 'https://jobs/none', posted: 'today',
        },
      ];
      const result = buildJobTreeNodes({
        displayedJobs,
        bucketTree: {
          likelihoodBands: [{ label: 'Strong (0-100%)', minScore: 0, maxScore: 100 }],
          // Malformed-but-plausible model output: it forgot a low-end catch-all.
          salaryRanges: [
            { label: '$80k+', minSalary: 80000, maxSalary: 0 },
            { label: 'Unspecified', minSalary: 0, maxSalary: 0 },
          ],
          roles: [{ name: 'Operations', jobIndices: [0, 1] }],
        },
        originalPos: { x: 0, y: 0 }, hubId: 'hub-1', baseNodeId: 'job-low',
      });
      const salaryGroups = result.newNodes.filter(n => n.data?.kind === 'salary');
      const lowRange = salaryGroups.find(n => n.data.label === 'Under $80k/yr');
      const unspecified = salaryGroups.find(n => n.data.label === 'Unspecified');
      assert(lowRange, 'salary fallback: expected synthetic low-end range');
      assert(unspecified, 'salary fallback: expected Unspecified range for missing salary');
      assert(lowRange.data.count === 1, `salary fallback: low salary should be in Below $80k (got ${lowRange.data.count})`);
      assert(unspecified.data.count === 1, `salary fallback: only missing salary should be Unspecified (got ${unspecified.data.count})`);
      return { salaryGroups: salaryGroups.map(g => g.data.label) };
    },
  },
{
    name: 'Job tree: ZipRecruiter Canadian hourly range keeps display text and salary placement',
    run: () => {
      const rawSalary = 'CA$40 - CA$85/hr';
      const result = buildJobTreeNodes({
        displayedJobs: [{
          title: 'Software Developer - Cloud Solutions', company: 'PulseLearning', location: 'Toronto, ON',
          salary: rawSalary, snippet: 'x', matchScore: 68, reasoning: 'r', careerDirection: 'Full-Stack Engineering',
          source: 'ziprecruiter', url: 'https://jobs/pulselearning', posted: '17 days ago',
        }],
        bucketTree: {
          likelihoodBands: [{ label: 'Good fit (70–84%)', minScore: 70, maxScore: 84 }],
          salaryRanges: [
            { label: '$120k+', minSalary: 120000, maxSalary: 0 },
            { label: '$80k–$120k', minSalary: 80000, maxSalary: 120000 },
            { label: 'Under $80k', minSalary: 1, maxSalary: 80000 },
            { label: 'Unspecified', minSalary: 0, maxSalary: 0 },
          ],
          roles: [{ name: 'Full-Stack Engineering', jobIndices: [0] }],
        },
        originalPos: { x: 0, y: 0 }, hubId: 'hub-pulselearning', baseNodeId: 'job-pulselearning',
      });
      const salaryGroup = result.newNodes.find(node => node.data?.kind === 'salary');
      const card = result.newNodes.find(node => node.type === 'jobcard');
      assert(salaryGroup?.data.label === '$80k–$120k/yr',
        `PulseLearning salary: CA$40/hr annualizes into $80k–$120k/yr (got "${salaryGroup?.data.label}")`);
      assert(card?.data.salary === rawSalary,
        `PulseLearning card: preserves the complete source range (got "${card?.data.salary}")`);
      return { salaryGroup: salaryGroup.data.label, display: card.data.salary };
    },
  },
{
    name: 'USAJobs salary: RateIntervalCode maps to a cadence the shared annualizer can read',
    run: () => {
      // Real captured values from a live run (bug report): "/ PH" (per hour)
      // matched no cadence token the shared parser recognizes, so every
      // hourly USAJobs listing silently annualized to 0/Unspecified even
      // though real pay was present.
      const phRates = ['22.31', '18.98', '18.23', '19.59'];
      for (const rate of phRates) {
        const formatted = formatUSAJobsSalary({ MinimumRange: rate, MaximumRange: rate, RateIntervalCode: 'PH' });
        assert(formatted === `$${rate} / hr`,
          `USAJobs salary: "$${rate} - $${rate} / PH" collapses to "$${rate} / hr" (got "${formatted}")`);
        assert(parseSalaryToNumeric(formatted) === Math.round(Number(rate) * 40 * 52),
          `USAJobs salary regression: "$${rate} - $${rate} / PH" now annualizes instead of staying 0/Unspecified`);
      }
      // The "/ PA" (per annum) listings only survived pre-fix by luck — the
      // number itself already cleared the credibility floor. Confirm they
      // still annualize correctly (to the lower endpoint) now that "/ yr" is
      // an explicit, recognized annual cadence rather than an unmatched code.
      // USAJobs ships bare integers; amounts are comma-grouped for display (as
      // formatDiceBaseSalary does) and must still annualize through the parser.
      const paRanges = [['106437', '138370'], ['52727', '68549'], ['63795', '82938'], ['109137', '141880']];
      const grouped = (n) => Number(n).toLocaleString('en-US');
      for (const [min, max] of paRanges) {
        const formatted = formatUSAJobsSalary({ MinimumRange: min, MaximumRange: max, RateIntervalCode: 'PA' });
        assert(formatted === `$${grouped(min)} - $${grouped(max)} / yr`,
          `USAJobs salary: "$${min} - $${max} / PA" maps to comma-grouped "/ yr" (got "${formatted}")`);
        assert(parseSalaryToNumeric(formatted) === Number(min),
          `USAJobs salary: "${formatted}" annualizes to the lower endpoint`);
      }
      assert(formatUSAJobsSalary({ MinimumRange: 'Negotiable', RateIntervalCode: 'PA' }) === '$Negotiable - $Negotiable / yr',
        'USAJobs salary: a non-numeric range value passes through rather than becoming $0');

      assert(formatUSAJobsSalary({ MinimumRange: '200', MaximumRange: '250', RateIntervalCode: 'PD' }) === '$200 - $250 / day',
        'USAJobs salary: PD (per day) maps to "/ day"');
      assert(parseSalaryToNumeric('$200 - $250 / day') === 200 * 5 * 52, 'USAJobs salary: daily cadence annualizes');

      assert(formatUSAJobsSalary({ MinimumRange: '800', MaximumRange: '900', RateIntervalCode: 'PW' }) === '$800 - $900 / wk',
        'USAJobs salary: PW (per week) maps to "/ wk"');
      assert(parseSalaryToNumeric('$800 - $900 / wk') === 800 * 52, 'USAJobs salary: weekly cadence annualizes');

      assert(formatUSAJobsSalary({ MinimumRange: '1500', MaximumRange: '1600', RateIntervalCode: 'PB' }) === '$1,500 - $1,600 bi-weekly',
        'USAJobs salary: PB (per bi-week) maps to the literal "bi-weekly" phrase');
      assert(parseSalaryToNumeric('$1,500 - $1,600 bi-weekly') === 1500 * 26, 'USAJobs salary: bi-weekly cadence annualizes');

      assert(formatUSAJobsSalary({ MinimumRange: '4000', MaximumRange: '4500', RateIntervalCode: 'PM' }) === '$4,000 - $4,500 / mo',
        'USAJobs salary: PM (per month) maps to "/ mo"');
      assert(parseSalaryToNumeric('$4,000 - $4,500 / mo') === 4000 * 12, 'USAJobs salary: monthly cadence annualizes');

      assert(formatUSAJobsSalary({ MinimumRange: '90000', MaximumRange: '95000', RateIntervalCode: 'FY' }) === '$90,000 - $95,000 / yr',
        'USAJobs salary: FY (fee basis, per year) maps to "/ yr"');
      assert(parseSalaryToNumeric('$90,000 - $95,000 / yr') === 90000, 'USAJobs salary: fee-basis annual range annualizes');

      // PS (per piece) and SY (per school year) have no defined multiplier in
      // the shared annualizer — keep the amount, never fabricate a cadence.
      assert(formatUSAJobsSalary({ MinimumRange: '50000', MaximumRange: '55000', RateIntervalCode: 'PS' }) === '$50,000 - $55,000 (PS)',
        'USAJobs salary: PS (piece rate) keeps the raw code instead of guessing a cadence');
      assert(parseSalaryToNumeric('$50,000 - $55,000 (PS)') === 50000, 'USAJobs salary: PS amount still annualizes on magnitude alone');
      assert(formatUSAJobsSalary({ MinimumRange: '5', MaximumRange: '5', RateIntervalCode: 'PS' }) === '$5 (PS)',
        'USAJobs salary: degenerate low-magnitude PS range collapses to a single amount');
      assert(parseSalaryToNumeric('$5 (PS)') === 0,
        'USAJobs salary: low-magnitude PS never gets a fabricated cadence — correctly stays Unspecified');

      assert(formatUSAJobsSalary({ MinimumRange: '45000', MaximumRange: '50000', RateIntervalCode: 'SY' }) === '$45,000 - $50,000 (SY)',
        'USAJobs salary: SY (school year) keeps the raw code instead of guessing a cadence');
      assert(parseSalaryToNumeric('$45,000 - $50,000 (SY)') === 45000, 'USAJobs salary: SY amount still annualizes on magnitude alone');

      // WC = "without compensation" — there is no pay at all, so no salary string.
      assert(formatUSAJobsSalary({ MinimumRange: '0', MaximumRange: '0', RateIntervalCode: 'WC' }) === '',
        'USAJobs salary: WC emits no salary string');
      assert(formatUSAJobsSalary({ RateIntervalCode: 'WC' }) === '',
        'USAJobs salary: WC with no range at all still emits nothing');

      // Unknown/future code — never invent a cadence; keep the raw code
      // visible so an undocumented code stays diagnosable.
      assert(formatUSAJobsSalary({ MinimumRange: '40000', MaximumRange: '45000', RateIntervalCode: 'XX' }) === '$40,000 - $45,000 (XX)',
        'USAJobs salary: unknown RateIntervalCode keeps the amount + raw code, no fabricated cadence');
      assert(parseSalaryToNumeric('$40,000 - $45,000 (XX)') === 40000, 'USAJobs salary: unknown-code amount still annualizes on magnitude alone');

      // Missing code entirely.
      assert(formatUSAJobsSalary({ MinimumRange: '40000', MaximumRange: '45000' }) === '$40,000 - $45,000',
        'USAJobs salary: absent RateIntervalCode emits the amount with no suffix and no parens');

      // Guards preserved from before the fix.
      assert(formatUSAJobsSalary(null) === '', 'USAJobs salary: no PositionRemuneration entry → empty string');
      assert(formatUSAJobsSalary({ RateIntervalCode: 'PH' }) === '',
        'USAJobs salary: entry present but MinimumRange/MaximumRange both absent → empty string');
      return { ok: true };
    },
  },
{
    name: 'Glassdoor salary reconciliation uses explicit same-job description cadence without guessing',
    run: () => {
      const observed = {
        source: 'glassdoor',
        salary: '$1 - $100K (Employer provided)',
        snippet: 'Benefits include health coverage.\nPay: $1.00-$100,000.00 per year\nThe role is based in Ontario.',
      };
      const repaired = reconcileGlassdoorSalaryFromDescription(observed);
      assert(repaired.salary === 'Up to $100,000/yr'
        && parseSalaryToNumeric(repaired.salary) === 100000,
      'Glassdoor sentinel lower bound is replaced by the description-grounded annual ceiling');

      const ordinary = reconcileGlassdoorSalaryFromDescription({
        source: 'glassdoor', salary: '$20 - $24 (Employer provided)',
        description: 'Pay range: $20 - $24 per hour.',
      });
      assert(ordinary.salary === '$20 - $24 per hour'
        && parseSalaryToNumeric(ordinary.salary) === 41600,
      'a normal explicitly cadenced description range retains both grounded endpoints and currency');

      const alreadyUsable = { ...observed, salary: '$42/hour' };
      const anotherSource = { ...observed, source: 'indeed' };
      const unlabeled = { ...observed, snippet: 'The company raised $100,000 per year for community grants.' };
      const cadenceMissing = { ...observed, snippet: 'Pay: $80,000 - $100,000.' };
      assert(reconcileGlassdoorSalaryFromDescription(alreadyUsable) === alreadyUsable,
        'an already-usable Glassdoor salary remains authoritative and is not replaced');
      assert(reconcileGlassdoorSalaryFromDescription(anotherSource) === anotherSource,
        'another source is outside the Glassdoor-only recovery boundary');
      assert(reconcileGlassdoorSalaryFromDescription(unlabeled) === unlabeled
        && reconcileGlassdoorSalaryFromDescription(cadenceMissing) === cadenceMissing,
      'unlabelled money and pay without an explicit cadence remain untouched');
      return { observed: repaired.salary, ordinary: ordinary.salary };
    },
  },
{
    name: 'Job taxonomy: salary cadence parser and canonical range repairs',
    run: () => {
      assert(parseSalaryToNumeric('$1.6K - $2.0K/wk') === 83200, 'salary parser: decimal weekly salary annualizes');
      assert(parseSalaryToNumeric('$2,000 bi-weekly') === 52000, 'salary parser: biweekly salary annualizes');
      assert(parseSalaryToNumeric('$5,000/month') === 60000, 'salary parser: monthly salary annualizes');
      assert(parseSalaryToNumeric('$300/day') === 78000, 'salary parser: daily salary annualizes');
      assert(parseSalaryToNumeric('$22/hour') === 45760, 'salary parser: hourly salary annualizes');
      for (const raw of ['$19', '$20', '$18.15', '$1.0K', '$2,500', '3 years experience', '401k matching']) {
        assert(parseSalaryToNumeric(raw) === 0, `salary parser: ${raw} without an annual/pay cadence is unspecified`);
      }
      for (const raw of ['19 - 21', '$21 - $22', '$24 - $24', 'USD49 - USD54']) {
        assert(parseSalaryToNumeric(raw) === 0,
          `salary parser: cadence-less low range ${raw} stays Unspecified instead of becoming dollars per year`);
      }
      const annualized = {
        '$19 Hourly': 39520,
        '$71K Annually': 71000,
        '$18.15 an hour': 37752,
        '$1.6K Weekly': 83200,
        '$1.0K Weekly': 52000,
        '$2,500 Monthly': 30000,
        '$71K': 71000,
        '$1.5M a year': 1500000,
        '$65K/yr': 65000,
        '$147,000-$175,000': 147000,
        '$80,000': 80000,
        '$172,333/year': 172333,
        '$8,000 a year': 8000,
        '$22/hour': 45760,
        '$5,000/month': 60000,
        '$2,000 bi-weekly': 52000,
        '$300/day': 78000,
      };
      for (const [raw, expected] of Object.entries(annualized)) {
        assert(parseSalaryToNumeric(raw) === expected, `salary parser: ${raw} → ${expected}`);
      }
      assert(parseSalaryToNumeric('$65K/hr') === 0,
        'salary parser: implausible abbreviated hourly rate stays Unspecified instead of overflowing annual salary ranges');
      const malformedRange = salaryRangeAnomaly('$23.50–$250.00 an hour');
      assert(parseSalaryToNumeric('$23.50–$250.00 an hour') === 48880,
        'salary parser: range placement remains lower-endpoint based');
      assert(malformedRange?.lowerAnnual === 48880 && malformedRange?.upperAnnual === 520000 && malformedRange?.ratio > 10,
        'salary anomaly: implausibly wide hourly range exposes both annualized endpoints without changing placement');
      assert(salaryRangeAnomaly('$15.68–$26.61 an hour') === null,
        'salary anomaly: ordinary compensation ranges stay quiet');
      const ordinaryRange = salaryRangeMetadata('$94,600–$176,000 a year');
      assert(ordinaryRange?.lowerAnnual === 94600 && ordinaryRange?.upperAnnual === 176000 && ordinaryRange?.ratio === 1.9,
        'salary range metadata preserves ordinary endpoint evidence without classifying it as an anomaly');
      // Regression: Google and Glassdoor both prefix USD amounts with a country
      // code ("US$50K–US$250K a year"). The endpoint pattern used to require a
      // bare `$` or digit right after the separator, so the letters in `US$250K`
      // failed the whole match and the anomaly check silently went dark for those
      // two sources at ANY ratio. Compare against the identical bare-$ string.
      const prefixedWide = salaryRangeAnomaly('US$50K–US$250K a year');
      const bareWide = salaryRangeAnomaly('$50K–$250K a year');
      assert(prefixedWide?.lowerAnnual === 50000 && prefixedWide?.upperAnnual === 250000,
        'salary anomaly: a US$-prefixed range annualizes both endpoints (was silently unmatched)');
      assert(bareWide?.ratio === prefixedWide?.ratio,
        'salary anomaly: country-code currency prefix does not change the reported ratio');
      assert(salaryRangeAnomaly('CA$20K–CA$150K a year')?.ratio === 7.5,
        'salary anomaly: the prefix fix is not hard-coded to US$');
      assert(salaryRangeAnomaly('US$17.00–US$18.50 an hour') === null,
        'salary anomaly: an ordinary US$-prefixed hourly band still stays quiet');
      assert(salaryRangeAnomaly('$20 to $30 an hour') === null,
        'salary anomaly: a "to" separator is not mistaken for a currency-code prefix');
      assert(salaryRangeAnomaly('USD 90,000.00 - 125,000.00 per year') === null,
        'salary anomaly: symbol-less currency-code ranges (Dice) stay quiet at a normal ratio');
      const wwrCadenceCases = {
        'Starting base compensation: $2,500 USD per month': ['$2,500 USD per month', 30000],
        'Compensation: $1,600 CAD/week.': ['$1,600 CAD/week', 83200],
        'Base pay is $1,000 per day.': ['$1,000 per day', 260000],
        'Salary: $80,000 USD annually.': ['$80,000 USD annually', 80000],
      };
      for (const [text, [rawSalary, annualSalary]] of Object.entries(wwrCadenceCases)) {
        const extracted = extractSalaryFromText(text);
        assert(extracted === rawSalary, `WWR salary extractor: preserves currency + cadence for ${text}`);
        assert(parseSalaryToNumeric(extracted) === annualSalary, `WWR salary extractor: ${extracted} → ${annualSalary}`);
      }
      // extractSalaryFromText shares its global unit regexp between calls. The
      // iterator must not leak lastIndex and skip an otherwise-identical later
      // listing in a full RSS feed.
      for (let i = 0; i < 3; i++) {
        assert(extractSalaryFromText('Remote role offers $95,000 per year.') === '$95,000 per year',
          `WWR salary extractor: shared regexp remains stateless across call ${i + 1}`);
      }
      assert(parseSalaryToNumeric('401k matching') === 0, 'salary parser: benefit prose is not salary');
      assert(parseSalaryToNumeric('3 years experience') === 0, 'salary parser: incidental numeric prose is not salary');
      assert(canonicalSalaryRangeLabel(120000, 0) === '$120k+/yr', 'salary labels derive from numeric open-ended bound');
      assert(canonicalSalaryRangeLabel(80000, 120000) === '$80k–$120k/yr', 'salary labels derive from numeric closed bounds');

      const ranges = normalizeRangesWithRepairs([
        { label: '$120k process/yr', minSalary: 120000, maxSalary: 0 },
        { label: 'bad prose', minSalary: 80000, maxSalary: 100000 },
        { label: 'Unspecified', minSalary: 0, maxSalary: 0 },
      ]);
      assert(ranges.real[0].label === '$120k+/yr' && ranges.real[1].label === '$80k–$120k/yr',
        'salary ranges: labels and maxima canonicalize from contiguous thresholds');
      assert(ranges.repairs.some(repair => repair.includes('canonicalized salary label "$120k process/yr"')),
        'salary ranges: malformed model labels are preserved in validation repairs');
      const lowCatchAllRepair = normalizeRangesWithRepairs([
        { label: '$120k+/yr', minSalary: 120000, maxSalary: 0 },
        { label: 'Under $120k/yr', minSalary: 1, maxSalary: 80000 },
        { label: 'Unspecified', minSalary: 0, maxSalary: 0 },
      ]);
      assert(lowCatchAllRepair.repairs.includes('normalized salary upper bound for the low-salary catch-all')
        && !lowCatchAllRepair.repairs.some(repair => /for \$1$/.test(repair)),
      'salary ranges: synthetic low-salary catch-all repair is not misreported as a literal $1 salary');
      const syntheticCatchAll = normalizeRangesWithRepairs([
        { label: '$120k+/yr', minSalary: 120000, maxSalary: 0 },
        { label: 'Unspecified', minSalary: 0, maxSalary: 0 },
      ]);
      assert(syntheticCatchAll.repairs.includes('added low-salary catch-all below $120k')
        && !syntheticCatchAll.repairs.includes('canonicalized salary label "(blank)"'),
      'salary ranges: app-authored catch-all is not misreported as a blank model label');
      const bands = normalizeBandsWithRepairs([{ label: 'Strong fit', minScore: 80, maxScore: 99 }]);
      assert(bands.bands.map(b => `${b.label}:${b.minScore}-${b.maxScore}`).join('|')
        === 'Excellent hiring fit (85–100):85-100|Good hiring fit (70–84):70-84|Partial hiring fit (40–69):40-69|Limited hiring fit (0–39):0-39',
      'hiring-fit bands: model-authored thresholds/labels are replaced by the fixed scoring rubric');
      assert(bands.repairs.includes('replaced hiring-fit bands with fixed scoring rubric'),
        'hiring-fit bands: replacing legacy/model thresholds is visible in repair telemetry');
      const taxonomy = sanitizeJobTaxonomy({
        likelihoodBands: [{ label: 'Strong', minScore: 80, maxScore: 100 }],
        salaryRanges: [
          { label: '$120k process/yr', minSalary: 120000, maxSalary: 0 },
          { label: 'bad $80–$100k prose', minSalary: 80000, maxSalary: 100000 },
        ],
        roles: [{ name: 'Creative', jobIndices: [0, 0, 99] }],
      }, 2, ['$123K - $130K/yr', '$1.6K - $2.0K/wk']);
      assert(taxonomy.salaryRanges.some(r => r.label === '$80k–$120k/yr'),
        'taxonomy sanitization: adds a low-end range for parseable weekly salary');
      assert(taxonomy.likelihoodBands.map(b => b.minScore).join(',') === '85,70,40,0',
        'taxonomy sanitization: hiring-fit thresholds stay aligned with the scoring rubric');
      assert(taxonomy.roles[0].jobIndices.join(',') === '0', 'taxonomy sanitization: drops duplicate/out-of-range role indexes');
      assert(taxonomy.roles.find(role => role.name === 'Other')?.jobIndices.join(',') === '1',
        'taxonomy sanitization: legacy callers without job metadata recover unassigned jobs into Other');

      // A real Claude tool call under the legacy grouped-index contract returned
      // this shape: a blank role containing only part of the input. Keep the
      // sanitizer backstop even though the new positional contract structurally
      // requires full coverage: useful scorer directions must recover malformed
      // saved/provider output, while valid AI assignments stay authoritative.
      const roleRecovery = sanitizeJobTaxonomy({
        salaryRanges: [],
        roles: [
          { name: '', jobIndices: [0, 1, 3] },
          { name: 'Platform Architecture', jobIndices: [2, 2, 99] },
        ],
      }, 5, [], [
        { careerDirection: ' Software Engineering ' },
        { careerDirection: 'Data Engineering' },
        { careerDirection: 'Solutions Architecture' },
        { careerDirection: 'Software Engineering' },
        { careerDirection: 'Other' },
      ]);
      const recoveredByName = new Map(roleRecovery.roles.map(role => [role.name, role.jobIndices]));
      assert(recoveredByName.get('Platform Architecture')?.join(',') === '2',
        'taxonomy role recovery: valid AI assignment remains authoritative');
      assert(recoveredByName.get('Software Engineering')?.join(',') === '0,3'
        && recoveredByName.get('Data Engineering')?.join(',') === '1',
      'taxonomy role recovery: blank/missing assignments use normalized career directions');
      assert(recoveredByName.get('Other')?.join(',') === '4',
        'taxonomy role recovery: only a genuinely unhinted/generic direction uses Other');
      const recoveredIndexes = roleRecovery.roles.flatMap(role => role.jobIndices).sort((a, b) => a - b);
      assert(recoveredIndexes.join(',') === '0,1,2,3,4',
        'taxonomy role recovery: every job index is assigned exactly once');
      assert(roleRecovery.repairs.includes('recovered 3 job(s) into career-direction role(s)')
        && roleRecovery.repairs.includes('recovered 1 unhinted job(s) into Other'),
      'taxonomy role recovery: diagnostics distinguish direction recovery from unhinted Other');

      const result = buildJobTreeNodes({
        displayedJobs: [{ title: 'Weekly', company: 'Acme', location: 'Remote', salary: '$1.6K - $2.0K/wk', snippet: '', matchScore: 50, source: 'dice', url: 'https://jobs/weekly' }],
        // The salary normalization fixture above was built for two inputs;
        // give this one-card render a complete matching provider partition.
        bucketTree: { ...taxonomy, roles: [{ name: 'Creative', jobIndices: [0] }] },
        originalPos: { x: 0, y: 0 }, hubId: 'hub-salary', baseNodeId: 'job-salary',
      });
      assert(result.newNodes.some(n => n.data?.kind === 'salary' && n.data.label === '$80k–$120k/yr' && n.data.count === 1),
        'tree placement: decimal weekly salary lands in its annualized range');

      const boundaryScores = [100, 85, 84, 70, 69, 40, 39, 0];
      const boundaryTree = buildJobTreeNodes({
        displayedJobs: boundaryScores.map((matchScore, index) => ({
          title: `Boundary ${matchScore}`, company: 'Acme', location: 'Remote',
          salary: '', snippet: '', matchScore, source: 'indeed', url: `https://jobs/boundary-${index}`,
        })),
        bucketTree: {
          // Deliberately contradictory legacy/model taxonomy: renderer must
          // ignore it and use the scorer's fixed boundaries.
          likelihoodBands: [{ label: 'Everything is good (0–100%)', minScore: 0, maxScore: 100 }],
          salaryRanges: [{ label: 'Unspecified', minSalary: 0, maxSalary: 0 }],
          roles: [{ name: 'Boundary roles', jobIndices: boundaryScores.map((_, index) => index) }],
        },
        originalPos: { x: 0, y: 0 }, hubId: 'hub-boundaries', baseNodeId: 'job-boundaries',
      });
      const boundaryBands = boundaryTree.newNodes
        .filter(n => n.data?.kind === 'likelihood')
        .map(n => [n.data.label, n.data.count]);
      assert(JSON.stringify(boundaryBands) === JSON.stringify([
        ['Excellent hiring fit (85–100)', 2],
        ['Good hiring fit (70–84)', 2],
        ['Partial hiring fit (40–69)', 2],
        ['Limited hiring fit (0–39)', 2],
      ]), `tree placement: rubric boundary scores map to fixed bands, got ${JSON.stringify(boundaryBands)}`);
      return { repairs: taxonomy.repairs.length };
    },
  },
{
    name: 'Job search extractors: retain salary cadence and reject known RemoteOK ads',
    run: () => {
      assert(formatJsonLdSalary({ value: { value: 19, unitText: 'HOUR' } }) === '$19/hr',
        'JSON-LD salary: hourly values retain their cadence');
      assert(formatJsonLdSalary({ value: { value: 19 } }) === '',
        'JSON-LD salary: unitless small values defer to the visible salary chip');
      assert(formatJsonLdSalary({ value: { minValue: 80000, maxValue: 120000 } }) === '$80,000 - $120,000',
        'JSON-LD salary: unitless annual-scale ranges remain useful');
      assert(reconcileZipRecruiterDomSalary('$65K/hr', 'Base Salary: Starting at $65,000 annually') === '$65,000 annually',
        'ZipRecruiter: malformed abbreviated hourly chip is replaced by explicit annual pay from the JD');
      assert(reconcileZipRecruiterDomSalary('$65K/hr', 'Responsibilities and qualifications only.') === '',
        'ZipRecruiter: malformed abbreviated hourly chip is blanked when the JD cannot correct it');
      assert(reconcileZipRecruiterDomSalary('$29/hr', 'Base Salary: Starting at $65,000 annually') === '$29/hr',
        'ZipRecruiter: plausible hourly chips remain authoritative over a separate annual JD figure');
      const pulseLearningPay = extractZipRecruiterDomSalaryText('CA$40 - CA$85/hr');
      assert(pulseLearningPay === 'CA$40 - CA$85/hr',
        `ZipRecruiter: currency-prefixed range keeps both endpoints and cadence (got "${pulseLearningPay}")`);
      assert(reconcileZipRecruiterDomSalary(pulseLearningPay, '') === 'CA$40 - CA$85/hr'
        && parseSalaryToNumeric(pulseLearningPay) === 83200,
      'ZipRecruiter: the exact PulseLearning chip survives source reconciliation and annualizes from CA$40/hr');
      const prefixedCadenceRanges = new Map([
        ['CA$100 - CA$120/hr', 208000],
        ['CA$2.0K - CA$2.5K/wk', 104000],
        ['US$17.60 - US$22.00 Per hour', 36608],
      ]);
      for (const [raw, annual] of prefixedCadenceRanges) {
        const extracted = extractZipRecruiterDomSalaryText(raw);
        assert(extracted === raw && parseSalaryToNumeric(extracted) === annual,
          `ZipRecruiter: preserves and annualizes prefixed cadence range "${raw}"`);
      }
      assert(reconcileZipRecruiterDomSalary('', 'Salary range CA$40 - CA$85 Compensation Type: Hourly') === '$40 - $85/hr',
        'ZipRecruiter: the description fallback also accepts currency prefixes on both range endpoints');
      const tranePay = 'Annual Base Salary Range or Hourly Base Pay Range: $111308,33 - $155435,00 Compensation Type: Salary';
      const recoveredTranePay = reconcileZipRecruiterDomSalary('$22', tranePay);
      assert(recoveredTranePay === '$111,308.33 - $155,435/yr',
        `ZipRecruiter: decimal-comma JD salary repairs a cadence-less chip (got "${recoveredTranePay}")`);
      assert(parseSalaryToNumeric(recoveredTranePay) === 111308,
        'ZipRecruiter: recovered locale salary annualizes instead of landing in Unspecified');
      assert(parseSalaryToNumeric('$19 Hourly') === 39520,
        'salary parser: capitalized word-form hourly cadence annualizes');
      assert(parseSalaryToNumeric('$19') === 0,
        'salary parser: unitless low dollar values are not invented as annual salary');
      assert(parseSalaryToNumeric('$8,000 a year') === 8000,
        'salary parser: explicit annual cadence permits legitimate low annual pay');
      assert(parseSalaryToNumeric('$18.75 - $19.70 a year') === 0,
        'salary parser: implausibly tiny explicit annual ranges stay Unspecified instead of becoming $19/year');
      assert(isRemoteOkSponsoredPlacement({ company: ' AI Supermarket ' }),
        'RemoteOK: exact sponsored pseudo-employer is excluded');
      assert(!isRemoteOkSponsoredPlacement({ company: 'A Supermarket' }),
        'RemoteOK: similarly named real employers remain eligible');
      const apiRows = [
        { company: 'AI Supermarket', position: 'Promoted Product' },
        { company: 'Acme', position: 'Customer Support Specialist' },
      ];
      const eligible = apiRows.filter(row => !isRemoteOkSponsoredPlacement(row));
      assert(eligible.length === 1 && eligible[0].company === 'Acme',
        'RemoteOK: sponsored rows are excluded by the predicate before any relevance matching; ordinary rows survive');
      return { jsonLd: 'cadence-preserved', remoteok: 'sponsored-filtered' };
    },
  },
{
    name: 'manualScraper telemetry: known ad/tracker CSP and network noise cannot evict genuine failures',
    run: () => {
      const ignoredUrls = [
        'https://znboux7hrdwpqwmoe-ziprecruiter.siteintercept.qualtrics.com/SIE/?Q_ZID=abc',
        'https://d.impactradius-event.com/A1957846/example.js',
        'https://googleads.g.doubleclick.net/pagead/viewthroughconversion/995393872/',
        'https://ad.doubleclick.net/ccm/s/collect?fmt=8',
        'https://www.google.com/rmkt/collect/995393872/?fmt=8',
        'https://www.google.com/ccm/collect?rcb=14&frm=0',
        'https://csp.withgoogle.com/csp/IdentityRotateCookiesHttp',
        'https://ca.indeed.com/rc/gd/png?a=glassdoor-company-spotlight-pixel',
        'https://itad.indeed.com/ita/v1/publisher?flowPage=glassdoor&flowType=company-spotlight',
      ];
      for (const url of ignoredUrls) {
        assert(isIgnorableManualBrowserTelemetry({ url }), `known telemetry noise should be ignored: ${url}`);
      }

      // Console CSP failures are reported at the first-party bundle that made
      // the request; the actual blocked tracker URL appears in the message.
      assert(isIgnorableManualBrowserTelemetry({
        url: 'https://www.ziprecruiter.com/_next/static/chunks/app.js',
        text: "Loading the script 'https://d.impactradius-event.com/tracker.js' violates the following Content Security Policy directive",
      }), 'known tracker URL embedded in a first-party CSP message is ignored');
      assert(isIgnorableManualBrowserTelemetry({
        url: 'https://www.google.com/search?q=jobs',
        text: 'Fetch API cannot load https://csp.withgoogle.com/csp/IdentityRotateCookiesHttp. Refused to connect.',
      }), 'Google cookie-rotation ORB/CSP noise embedded in console text is ignored');
      assert(isIgnorableManualBrowserTelemetry({
        url: 'https://www.glassdoor.ca/Job/jobs.htm',
        text: "Access to fetch at 'https://itad.indeed.com/ita/v1/publisher?flowPage=glassdoor&flowType=company-spotlight' from origin 'https://www.glassdoor.ca' has been blocked by CORS policy",
      }), 'Glassdoor’s embedded Indeed company-spotlight CORS message is ignored');

      // The classifier is intentionally not a blanket third-party/CSP filter.
      // Unknown dependencies and first-party job-page failures are precisely
      // the evidence these bounded buffers exist to retain.
      assert(!isIgnorableManualBrowserTelemetry({
        url: 'https://www.ziprecruiter.com/jobs-search',
        text: 'Failed to load resource: net::ERR_CONNECTION_RESET',
      }), 'first-party request failures remain visible');
      assert(!isIgnorableManualBrowserTelemetry({
        url: 'https://cdn.unfamiliar-vendor.example/widget.js',
        text: 'Failed to load resource: the server responded with a status of 503',
      }), 'unknown third-party failures remain visible');
      assert(!isIgnorableManualBrowserTelemetry({ url: 'https://doubleclick.net.attacker.example/api' }),
        'lookalike hostnames do not inherit a known tracker exclusion');
      assert(!isIgnorableManualBrowserTelemetry({ url: 'https://www.google.com/search?q=rmkt+jobs' }),
        'ordinary first-party Google requests are retained; only the exact /rmkt/ endpoint is noise');
      assert(!isIgnorableManualBrowserTelemetry({ url: 'https://ca.indeed.com/viewjob?jk=real-job' }),
        'ordinary Indeed job requests remain visible; only exact Glassdoor spotlight endpoints are noise');
      assert(!isIgnorableManualBrowserTelemetry({
        url: 'https://www.ziprecruiter.com/app.js',
        text: "Connecting to 'https://api.ziprecruiter.com/jobs' violates CSP; connect-src also allows https://googleads.g.doubleclick.net",
      }), 'a genuine first target is retained even when later CSP directive text names an ignored domain');
      assert(!isIgnorableManualBrowserTelemetry({ text: 'This document requires TrustedHTML assignment. The action has been blocked.' }),
        'unknown console failures without a target URL remain visible');
      return { ignored: ignoredUrls.length, genuinePreserved: 6 };
    },
  },
{
    name: 'scraper overlay: Trusted Types-safe construction remains inert on challenge documents',
    run: () => {
      const script = buildOverlayScript({ withPause: true });
      assert(!script.includes('innerHTML'),
        'overlay script never assigns or probes an HTML sink, so it cannot emit TrustedHTML errors');
      assert(script.includes("_icTitle.startsWith('just a moment')")
        && script.includes('#cf-challenge-running')
        && script.includes('challenges.cloudflare.com'),
      'overlay script exits before style/DOM work on known Cloudflare challenge documents');
      assert(script.includes("make('button', 'ic-pause'") && script.includes('appendChild'),
        'overlay still builds the pause control through DOM nodes');
      return { trustedTypesSafe: true };
    },
  },
{
    name: 'manualScraper telemetry: per-job anomalies join the trail without hijacking the current phase',
    run: () => {
      // `active` is a MERGE that never deletes fields, so a desc-miss/date-miss
      // recorded as a normal phase would pin its `key` onto every later render —
      // the bug report would then attribute one job's miss to whatever phase the
      // scraper happened to be in at report time. Anomalies must reach the event
      // trail (that visibility is the whole point) but leave `active` alone.
      recordManualScraperTelemetry({ phase: 'page-extract', srcName: 'ZipRecruiter', pageNum: 1 });
      recordManualScraperTelemetry(
        { phase: 'desc-miss', srcName: 'ZipRecruiter', key: 'Patient Representative II | ld=0 nd=0' },
        { updateActive: false },
      );
      const afterMiss = getManualScraperTelemetry();
      assert(afterMiss.active.phase === 'page-extract',
        `anomaly must not become the current phase, got ${afterMiss.active.phase}`);
      assert(afterMiss.active.key === undefined,
        `anomaly key must never leak into active, got ${JSON.stringify(afterMiss.active.key)}`);
      assert(afterMiss.events.some(e => e.phase === 'desc-miss' && /Patient Representative II/.test(e.key || '')),
        'the desc-miss must still be recorded in the event trail');
      assert(afterMiss.fieldAnomalies?.some(e => e.phase === 'desc-miss' && /Patient Representative II/.test(e.key || '')),
        'the desc-miss is also retained in the dedicated field-quality trail');

      // A real phase transition still advances `active` — the opt-out is per-call,
      // not a behaviour change for the ordinary path.
      recordManualScraperTelemetry({
        phase: 'detail-expand', srcName: 'Glassdoor', key: 'Old Glassdoor listing',
        itemIndex: 5, itemTotal: 5, descriptionSource: 'jsonLd', reason: 'old detail',
      });
      recordManualScraperTelemetry({
        phase: 'source-start', srcName: 'Google for Jobs', sourceId: 'google', queryTotal: 12,
      });
      const afterSourceChange = getManualScraperTelemetry();
      assert(afterSourceChange.active.srcName === 'Google for Jobs'
        && afterSourceChange.active.key === undefined
        && afterSourceChange.active.itemIndex === undefined
        && afterSourceChange.active.descriptionSource === undefined
        && afterSourceChange.active.reason === undefined,
      `source transition must clear prior listing context, got ${JSON.stringify(afterSourceChange.active)}`);

      recordManualScraperTelemetry({ phase: 'source-finished', srcName: 'ZipRecruiter' });
      const afterPhase = getManualScraperTelemetry();
      assert(afterPhase.active.phase === 'source-finished',
        `ordinary phases still advance active, got ${afterPhase.active.phase}`);
      assert(afterPhase.active.key === undefined,
        'a stale anomaly key must not resurface on a later phase');
      return { ok: true, activePhase: afterPhase.active.phase };
    },
  },
{
    name: 'manualScraper telemetry: a new job-search run clears prior browser phases and diagnostics',
    run: () => {
      // Simulate a completed Google browser scrape, then the boundary crossed by
      // a LinkedIn-only/API-only follow-up. That second run never calls the
      // manual browser loop, so this explicit reset is what prevents the old
      // source-finished event from being rendered as current work.
      recordManualScraperTelemetry({
        phase: 'source-finished', sourceId: 'google', srcName: 'Google for Jobs', count: 117,
      });
      recordManualScraperTelemetry(
        { phase: 'desc-miss', sourceId: 'google', srcName: 'Google for Jobs', key: 'Old Google job' },
        { updateActive: false },
      );
      assert(getManualScraperTelemetry().active?.sourceId === 'google',
        'fixture must begin with prior browser activity');

      resetManualScraperTelemetry();
      const fresh = getManualScraperTelemetry();
      assert(fresh.active === null, 'a new run has no inherited active browser phase');
      assert(fresh.events.length === 0, 'a new run has no inherited browser phase trail');
      assert(fresh.fieldAnomalies.length === 0, 'a new run has no inherited field-quality anomaly');
      assert(fresh.consoleLogs.length === 0 && fresh.networkErrors.length === 0,
        'a new run has no inherited browser console/network diagnostics');
      return { ok: true };
  },
},
{
    name: 'manualScraper telemetry: a queued job run cannot reset the shared browser owner',
    run: async () => {
      let releaseFirst;
      let firstOwnsLock;
      const firstEntered = new Promise((resolve) => { firstOwnsLock = resolve; });
      const firstCanFinish = new Promise((resolve) => { releaseFirst = resolve; });

      const firstRun = withFreshManualScraperTelemetry(async () => {
        recordManualScraperTelemetry({
          phase: 'page-extract', sourceId: 'google', srcName: 'Google for Jobs', count: 41,
        });
        firstOwnsLock();
        await firstCanFinish;
      });
      await firstEntered;

      // This represents another hub that has started but is waiting on the
      // shared Chrome profile. Its fresh-generation reset must stay queued too.
      const secondRun = withFreshManualScraperTelemetry(() => undefined);
      await Promise.resolve();
      const whileQueued = getManualScraperTelemetry();
      assert(whileQueued.active?.sourceId === 'google'
        && whileQueued.active?.phase === 'page-extract'
        && whileQueued.events.length === 1,
      `queued run erased the lock owner's diagnostics: ${JSON.stringify(whileQueued)}`);

      releaseFirst();
      await firstRun;
      await secondRun;
      const afterSecondOwns = getManualScraperTelemetry();
      assert(afterSecondOwns.active === null && afterSecondOwns.events.length === 0,
        'the next run must reset diagnostics once it actually owns the profile lock');
      return { ownerSource: whileQueued.active.sourceId };
  },
},
{
    name: 'LinkedIn enrichment: separate job runs cannot use the shared browser concurrently',
    run: async () => {
      let releaseFirst;
      let firstEntered;
      const entered = new Promise((resolve) => { firstEntered = resolve; });
      const mayFinish = new Promise((resolve) => { releaseFirst = resolve; });
      let active = 0;
      let peak = 0;

      const first = __withLockedLinkedInEnrichmentForTests(async () => {
        active += 1;
        peak = Math.max(peak, active);
        firstEntered();
        await mayFinish;
        active -= 1;
      });
      await entered;

      const second = __withLockedLinkedInEnrichmentForTests(async () => {
        active += 1;
        peak = Math.max(peak, active);
        active -= 1;
      });
      await Promise.resolve();
      assert(peak === 1, 'a second LinkedIn browser pass must wait for the first shared-profile owner');

      releaseFirst();
      await Promise.all([first, second]);
      assert(peak === 1 && active === 0, 'LinkedIn browser passes must settle sequentially without leaking a lock owner');
      return { peak };
    },
  },
{
    name: 'job pipeline report: field-quality scraper anomalies survive later source phases',
    run: () => {
      // Fill the capped telemetry ring exactly as a multi-source run does: two
      // ZipRecruiter description misses followed by enough Google phases to
      // displace them from the ordinary trailing-eight progress display.
      recordManualScraperTelemetry(
        { phase: 'desc-miss', srcName: 'ZipRecruiter', key: 'First missing JD | ld=0 nd=0' },
        { updateActive: false },
      );
      recordManualScraperTelemetry(
        { phase: 'desc-miss', srcName: 'ZipRecruiter', key: 'Second missing JD | ld=0 nd=0' },
        { updateActive: false },
      );
      for (let i = 0; i < 40; i++) {
        recordManualScraperTelemetry({ phase: 'page-extract', srcName: 'Google for Jobs', pageNum: i + 1 });
      }
      const scrapeTelemetry = getManualScraperTelemetry();
      assert(!scrapeTelemetry.events.some(e => /First missing JD/.test(e.key || ''))
        && scrapeTelemetry.fieldAnomalies?.some(e => /First missing JD/.test(e.key || '')),
      'dedicated anomaly retention survives after ordinary phases evict the shared 30-event trail');
      const telemetry = getJobsTelemetry();
      const report = buildJobsPipelineSnapshot(
        telemetry?.nodeId ? new Set([telemetry.nodeId]) : new Set(),
        telemetry?.windowId ?? null,
        null,
      );
      assert(report.includes('Detail-recovery diagnostics (retained independently of recent phases)')
        && report.includes('First missing JD') && report.includes('Second missing JD'),
      'FULL pipeline diagnostics retain early per-job description misses after later sources advance the phase trail');
      return { ok: true };
  },
},
{
    name: 'job pipeline report: bounded browser card-walk evidence identifies misses, click identities, and cancellation',
    run: () => {
      recordManualScraperTelemetry({
        phase: 'card-walk',
        sourceId: 'google',
        srcName: 'Google for Jobs',
        queryIndex: 1,
        queryTotal: 1,
        pageNum: 1,
        strategy: 'list-card-panel',
        panelSelector: 'span.OOyDTc, span.ejCXj',
        itemTotal: 25,
        attempted: 17,
        expanded: 15,
        missing: 1,
        panelTimeouts: 1,
        selectionMismatches: 1,
        blockingModalsDismissed: 2,
        blockingModalFailures: 1,
        googleApplyLinksCaptured: 15,
        googleApplyLinksMissing: 2,
        googleApplyLinkMissSamples: [{
          itemIndex: 9,
          title: 'Junior Solutions Architect',
          preferredSource: 'Peraton Careers',
          candidateLabels: [],
        }],
        modalSamples: [
          {
            itemIndex: 3,
            stage: 'before-card',
            signature: 'glassdoor-job-alert',
            control: 'aria-label-close',
            outcome: 'dismissed',
          },
          {
            itemIndex: 4,
            stage: 'after-card',
            signature: 'glassdoor-job-alert',
            control: 'none',
            outcome: 'missing-control',
          },
        ],
        titleBypassed: 96,
        aborted: true,
        interruptedAt: 18,
        abortReason: 'user-cancelled',
        failureSamples: [
          { itemIndex: 7, key: 'Systems Architect at Example', reason: 'card-not-found' },
          { itemIndex: 16, key: 'Principal Systems Architect at Example', reason: 'panel-timeout' },
        ],
        transitionSamples: [
          {
            itemIndex: 1,
            expectedKey: 'google-card-1',
            expectedTitle: 'First Systems Architect',
            hitKey: 'google-card-1',
            hitTitle: 'First Systems Architect',
            physicalIndex: 1,
            physicalTotal: 108,
            selectedTitle: 'First Systems Architect',
            selectionVerified: true,
            lookup: 'primary',
          },
          {
            itemIndex: 2,
            expectedKey: 'google-card-2',
            expectedTitle: 'Second Systems Architect',
            // Exercise the resolved aliases used by the live DOM probe.
            resolvedKey: 'google-card-3',
            resolvedTitle: 'Third Systems Architect',
            physicalIndex: 5,
            physicalTotal: 108,
            skippedSincePrevious: 3,
            selectedTitle: 'Fourth Systems Architect',
            selectionMismatch: true,
            lookup: 'data-share-url',
            mismatch: true,
          },
        ],
      }, { updateActive: false });
      const telemetry = getJobsTelemetry();
      const report = buildJobsPipelineSnapshot(
        telemetry?.nodeId ? new Set([telemetry.nodeId]) : new Set(),
        telemetry?.windowId ?? null,
        null,
      );
      assert(report.includes('Browser card traversal (bounded batch summaries)')
        && report.includes('Google for Jobs · strategy=list-card-panel · panel="span.OOyDTc, span.ejCXj" · q1/1 · p1 · attempted 17/25 · expanded 15/25 · missing-target 1 · panel-timeout 1 · selection-mismatches 1 · blocking-popup-dismissed 2 · blocking-popup-dismiss-failed 1 · direct-apply 15/17 captured · title-bypassed 96 (intentional, page-local) · aborted before #18 (user-cancelled)')
        && report.includes('#7 key=Systems Architect at Example reason=card-not-found')
        && report.includes('#16 key=Principal Systems Architect at Example reason=panel-timeout')
        && report.includes('Blocking popup handling:')
        && report.includes('#3 · stage=before-card · signature=glassdoor-job-alert · control=aria-label-close · outcome=dismissed')
        && report.includes('⚠️ #4 · stage=after-card · signature=glassdoor-job-alert · control=none · outcome=missing-control')
        && report.includes('#9 direct Apply-on URL missing · "Junior Solutions Architect" · preferred=Peraton Careers · visible candidates=none after bounded wait')
        && report.includes('Click transition samples (expected → hit):')
        && report.includes('#1 · physical #1/108 expected key=google-card-1 title=First Systems Architect → hit key=google-card-1 title=First Systems Architect via primary → selected title=First Systems Architect [selection verified]')
        && report.includes('⚠️ #2 · physical #5/108 · 3 physical cards skipped since previous expected key=google-card-2 title=Second Systems Architect → hit key=google-card-3 title=Third Systems Architect via data-share-url [MISMATCH] → selected title=Fourth Systems Architect [SELECTION MISMATCH]'),
      'FULL/CARDWALK diagnostics must preserve physical positions, popup dismissal outcomes, post-click selection identity, failed positions, and cancellation context, not only a misleading expanded aggregate');
      return { total: 25, attempted: 17, expanded: 15, titleBypassed: 96, selectionMismatches: 1, blockingModalsDismissed: 2, blockingModalFailures: 1, failures: 2, transitions: 2 };
    },
  },
{
    name: 'FULL card-walk diagnostics name Glassdoor opportunity-modal recovery separately from selector misses',
    run: () => {
      const telemetry = getJobsTelemetry();
      const scrapeTelemetry = getManualScraperTelemetry();
      const saved = {
        nodeId: telemetry.nodeId,
        windowId: telemetry.windowId,
        search: telemetry.search,
        active: scrapeTelemetry.active,
        events: scrapeTelemetry.events,
        fieldAnomalies: scrapeTelemetry.fieldAnomalies,
      };
      Object.assign(telemetry, {
        nodeId: 'glassdoor-opportunity-modal-diagnostics',
        windowId: null,
        search: { ts: Date.now(), queries: 1, raw: 30, deduped: 30, ageDropped: 0, historyDropped: 0, kept: 30 },
      });
      scrapeTelemetry.active = null;
      scrapeTelemetry.events = [];
      scrapeTelemetry.fieldAnomalies = [];
      recordManualScraperTelemetry({
        phase: 'card-walk',
        sourceId: 'glassdoor',
        srcName: 'Glassdoor',
        queryIndex: 1,
        queryTotal: 1,
        pageNum: 1,
        strategy: 'list-card-panel',
        panelSelector: '[data-brandviews*="joblisting-description"]',
        itemTotal: 30,
        attempted: 5,
        expanded: 2,
        missing: 3,
        panelRateLimits: 1,
        panelRequestsIssued: 9,
        proactivePanelCooldowns: 1,
        panelJsonResponses: 8,
        panelJsonPayloads: 7,
        panelJsonDescriptionFallbacks: 1,
        panelJsonFieldRecoveries: { salary: 2, posted: 1, company: 0 },
        // Match the live producer: card-walk snapshots configuration before
        // any checkpoint is due, rather than hand-constructing a due policy.
        panelPacing: descriptionPanelPacing('glassdoor', 0),
        blockingModalsDismissed: 1,
        blockingModalFailures: 1,
        failureSamples: [
          { itemIndex: 3, key: 'Jr/Int/Snr Naval Architect Technologist', reason: 'blocking-popup-dismiss-failed' },
        ],
      }, { updateActive: false });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['glassdoor-opportunity-modal-diagnostics']), null, null);
        const walkLine = report.split('\n').find(line => line.includes('Glassdoor · strategy=list-card-panel')) || '';
        assert(walkLine.includes('blocking-popup-dismissed 1')
          && walkLine.includes('blocking-popup-dismiss-failed 1')
          && walkLine.includes('missing-target 3')
          && walkLine.includes('panel-http-429 1 (source throttle; walk stopped)')
          && walkLine.includes('panel-pace 4.5s + 12s/8')
          && walkLine.includes('proactive-panel-cooldowns 1')
          && walkLine.includes('panel-requests 9')
          && walkLine.includes('same-request-json 7/8 usable')
          && walkLine.includes('json-description-fallback 1')
          && walkLine.includes('json-field-recovery salary=2,posted=1'),
        'FULL/CARDWALK distinguishes Glassdoor source throttling, same-request JSON recovery, and popup outcomes from stale card selectors');
        assert(report.includes('#3 key=Jr/Int/Snr Naval Architect Technologist reason=blocking-popup-dismiss-failed'),
          'the bounded failure samples retain the exact popup-close failure position and job identity');
      } finally {
        Object.assign(telemetry, {
          nodeId: saved.nodeId,
          windowId: saved.windowId,
          search: saved.search,
        });
        scrapeTelemetry.active = saved.active;
        scrapeTelemetry.events = saved.events;
        scrapeTelemetry.fieldAnomalies = saved.fieldAnomalies;
      }
      return { dismissed: 1, closeFailures: 1, rateLimits: 1, pacedRequests: 9, attempted: 5 };
    },
  },
{
    name: 'Live job-search pipeline telemetry names pending sources before search completion',
    run: () => {
      const telemetry = getJobsTelemetry();
      const priorPipeline = telemetry.pipeline;
      const priorSourceEvents = telemetry.sourceEvents;
      try {
        telemetry.pipeline = {
          phase: 'gathering-sources',
          startedAt: Date.now() - 241_000,
          ts: Date.now() - 2_000,
          active: true,
          pendingSources: ['dice'],
          lastSource: 'ziprecruiter',
        };
        telemetry.sourceEvents = {
          dice: [{ t: 0, status: 'searching', code: null }],
          ziprecruiter: [
            { t: 0, status: 'searching', code: null },
            { t: 60_000, status: 'done', code: 'description-detail-miss' },
          ],
        };
        const report = buildJobsPipelineSnapshot(
          telemetry?.nodeId ? new Set([telemetry.nodeId]) : new Set(),
          telemetry?.windowId ?? null,
          null,
        );
        assert(report.includes('Live Search Stage') && report.includes('gathering-sources')
          && report.includes('Pending source(s): `dice`') && report.includes('last progress from `ziprecruiter`'),
        'FULL/JOBS telemetry identifies the live gather stage and the exact source still pending');
        assert(report.includes('`dice`: searching@+0s'),
          'an active searching-only source is retained in the progress trail instead of being filtered as uninteresting');
        return { ok: true };
      } finally {
        telemetry.pipeline = priorPipeline;
        telemetry.sourceEvents = priorSourceEvents;
      }
    },
  },
{
    name: 'formatSourceEvent renders a folded heartbeat span, repeat count, and detail',
    run: () => {
      // Shape emitProgress produces for a paced source: repeated same-status
      // heartbeats folded into the previous trail entry, keeping the ORIGINAL
      // start `t` but gaining `lastT`/`repeats`/`detail` from the newest one.
      const folded = formatSourceEvent({ t: 0, lastT: 188_000, repeats: 15, status: 'searching', detail: 'q3/12 · p2' });
      assert(folded === 'searching@+0s→+188s ×15 (q3/12 · p2)',
        'a folded entry must render its original start, the newest offset as a span, the repeat count, and the newest detail');
      return { folded };
    },
  },
{
    name: 'formatSourceEvent renders an unfolded single entry with no span/repeat/detail suffix',
    run: () => {
      const single = formatSourceEvent({ t: 0, status: 'searching' });
      assert(single === 'searching@+0s',
        'an entry that never folded (no lastT/repeats/detail) must render exactly as status@+Ns with no trailing suffix');
      return { single };
    },
  },
{
    name: 'formatSourceEvent still renders a warning code as ⚠<code>',
    run: () => {
      const warned = formatSourceEvent({ t: 5_000, status: 'error', code: 'description-detail-miss' });
      assert(warned === 'error⚠description-detail-miss@+5s',
        'a carried warning code must render immediately after the status as ⚠<code>, unaffected by the folding change');
      // A folded entry can ALSO carry a warning code (a source that flips to
      // the same warning repeatedly) — the code sits before the span/repeat.
      const foldedWithCode = formatSourceEvent({ t: 5_000, lastT: 65_000, repeats: 4, status: 'error', code: 'description-detail-miss' });
      assert(foldedWithCode === 'error⚠description-detail-miss@+5s→+65s ×4',
        'a folded entry with a warning code must render the code before the span/repeat suffix');
      return { warned, foldedWithCode };
    },
  },
{
    name: 'job pipeline report: Live Search Stage renders a folded pending-source heartbeat',
    run: () => {
      // The real-world case this exists for: a linkedin source mid-walk sends
      // dozens of identical "searching" heartbeats over minutes. Without the
      // fold, only the FIRST @+0s survives the array cap and the report reads
      // as though the source stopped emitting seconds into the run.
      const telemetry = getJobsTelemetry();
      const priorPipeline = telemetry.pipeline;
      const priorSourceEvents = telemetry.sourceEvents;
      try {
        telemetry.pipeline = {
          phase: 'gathering-sources',
          startedAt: Date.now() - 241_000,
          ts: Date.now() - 2_000,
          active: true,
          pendingSources: ['linkedin'],
          lastSource: 'linkedin',
        };
        telemetry.sourceEvents = {
          linkedin: [{ t: 0, lastT: 188_000, repeats: 15, status: 'searching', detail: 'q3/12 · p2' }],
        };
        const report = buildJobsPipelineSnapshot(
          telemetry?.nodeId ? new Set([telemetry.nodeId]) : new Set(),
          telemetry?.windowId ?? null,
          null,
        );
        assert(report.includes('Live Search Stage') && report.includes('Pending source(s): `linkedin`'),
          'FULL/JOBS telemetry still identifies the live gather stage and the pending source');
        assert(report.includes('`linkedin`: searching@+0s→+188s ×15 (q3/12 · p2)'),
          'the Active source progress line must render the folded span, repeat count, and detail — not just the first heartbeat');
      } finally {
        telemetry.pipeline = priorPipeline;
        telemetry.sourceEvents = priorSourceEvents;
      }
      return { ok: true };
    },
  },
{
    name: 'job pipeline report: terminal phases and Glassdoor cache ages are truthful',
    run: () => {
      assert(formatPipelineState({ active: false, phase: 'completed' }) === '✅ complete'
        && formatPipelineState({ active: false, phase: 'aborted' }) === '⏹️ cancelled'
        && formatPipelineState({ active: false, phase: 'source-gather-failed' }) === '❌ failed',
      'an inactive aborted/failed pipeline must not be mislabeled as a successful completion');
      const provenance = formatGlassdoorCacheProvenance({
        country: 'CA', verifiedAt: Date.now() - 65_000,
      });
      assert(/country CA · verified 1m ago/.test(provenance)
        && !provenance.includes('ago ago')
        && !/\d{4,}h/.test(provenance),
      'Glassdoor cache provenance passes an epoch to formatAge and appends no duplicate age suffix');
      return { provenance };
    },
  },
{
    name: 'job pipeline report: challenge phases retain classifier evidence after source teardown',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = { nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search };
      Object.assign(telemetry, {
        nodeId: 'challenge-signal-diagnostics',
        windowId: null,
        search: { ts: Date.now(), queries: 1, raw: 0, deduped: 0, ageDropped: 0, historyDropped: 0, kept: 0 },
      });
      resetManualScraperTelemetry();
      recordManualScraperTelemetry({
        phase: 'challenge-hard-block',
        sourceId: 'glassdoor',
        srcName: 'Glassdoor',
        reason: 'hard-block',
        title: 'Just a moment...',
        bodyHead: 'Humans only. Glassdoor uses advanced security systems.',
        pageState: { interactive: false, cfFrame: false, turnstileWidget: false, recaptchaFrames: 0 },
      });
      // A terminal source event replaces `active`; the retained event trail must
      // still carry the decisive classifier inputs in FULL/JOBS.
      recordManualScraperTelemetry({ phase: 'source-finished', sourceId: 'glassdoor', srcName: 'Glassdoor', count: 0 });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['challenge-signal-diagnostics']), null, null);
        const phaseLine = report.split('\n').find(line => line.includes('challenge-hard-block')) || '';
        assert(phaseLine.includes('reason=hard-block')
          && phaseLine.includes('title="Just a moment..."')
          && phaseLine.includes('turnstileWidget')
          && phaseLine.includes('Humans only'),
        'retained challenge phase shows reason, title, structured signals, and bounded body evidence');
      } finally {
        resetManualScraperTelemetry();
        Object.assign(telemetry, saved);
      }
      return { ok: true };
    },
  },
{
    name: 'job pipeline report: detail challenge telemetry keeps the wait-vs-stop evidence',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = { nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search };
      Object.assign(telemetry, {
        nodeId: 'detail-challenge-policy-diagnostics',
        windowId: null,
        search: { ts: Date.now(), queries: 1, raw: 1, deduped: 1, ageDropped: 0, historyDropped: 0, kept: 1 },
      });
      resetManualScraperTelemetry();
      recordManualScraperTelemetry({
        phase: 'detail-challenge',
        sourceId: 'glassdoor',
        srcName: 'Glassdoor',
        key: 'Principal Architect',
        reason: 'hard-block',
        title: 'Just a moment...',
        repeatCount: 2,
        hardBlock: true,
        finalUrl: 'https://www.glassdoor.ca/job-listing/principal-architect.htm',
        bodyHead: 'Humans only. Glassdoor uses advanced security systems to keep its site safe.',
        pageState: {
          interactive: false,
          terminalHardBlockText: true,
          cfFrame: false,
          turnstileWidget: false,
          recaptchaFrames: 0,
        },
      }, { updateActive: false });
      // A later ordinary source phase must not evict the decisive detail diagnostic.
      recordManualScraperTelemetry({ phase: 'source-finished', sourceId: 'glassdoor', srcName: 'Glassdoor', count: 1 });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['detail-challenge-policy-diagnostics']), null, null);
        const detailLine = report.split('\n').find(line => line.includes('detail-challenge')
          && line.includes('Principal Architect') && line.includes('reason=hard-block')) || '';
        assert(detailLine.includes('reason=hard-block')
          && detailLine.includes('repeat=2')
          && detailLine.includes('title="Just a moment..."')
          && detailLine.includes('terminalHardBlockText')
          && detailLine.includes('Humans only'),
        'FULL/JOBS keeps the detail challenge reason, retry count, title, DOM state, and bounded page text after teardown');
      } finally {
        resetManualScraperTelemetry();
        Object.assign(telemetry, saved);
      }
      return { ok: true };
    },
  },
{
    name: 'job pipeline report: Glassdoor Location Cache section is absent with no location skips and an empty cache',
    run: () => {
      // Scrape telemetry is a process-global singleton, so this negative case
      // clears the event ring for the duration of the assertion instead of
      // relying on running before whichever test records a
      // location-resolution-failed event. Order-dependent negatives rot silently
      // the moment a test is inserted above them.
      const telemetry = getJobsTelemetry();
      const scrapeTelemetry = getManualScraperTelemetry();
      const saved = { nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search };
      const savedEvents = scrapeTelemetry.events;
      Object.assign(telemetry, {
        nodeId: 'glassdoor-cache-absent-diagnostics',
        windowId: null,
        search: { ts: Date.now(), queries: 1, raw: 1, deduped: 1, ageDropped: 0, historyDropped: 0, kept: 1 },
      });
      scrapeTelemetry.events = [];
      try {
        const report = buildJobsPipelineSnapshot(new Set(['glassdoor-cache-absent-diagnostics']), null, null);
        assert(!report.includes('### Glassdoor Location Cache'),
          'the Glassdoor Location Cache section must not render when this run had no location skip and the persisted cache is empty');
      } finally {
        Object.assign(telemetry, saved);
        scrapeTelemetry.events = savedEvents;
      }
      return { ok: true };
    },
  },
{
    name: 'job pipeline report: Glassdoor Location Cache section names a skipped location, its failureKind, and cache absence',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = { nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search };
      Object.assign(telemetry, {
        nodeId: 'glassdoor-cache-diagnostics',
        windowId: null,
        search: { ts: Date.now(), queries: 1, raw: 1, deduped: 1, ageDropped: 0, historyDropped: 0, kept: 1 },
      });
      recordManualScraperTelemetry({
        phase: 'location-resolution-failed',
        sourceId: 'glassdoor',
        srcName: 'Glassdoor',
        queryIndex: 1,
        queryTotal: 3,
        location: 'Erie, PA',
        reason: 'autocomplete returned no verified exact match',
        failureKind: 'no-match',
        attempts: 2,
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['glassdoor-cache-diagnostics']), null, null);
        assert(report.includes('### Glassdoor Location Cache'),
          'a location-resolution-failed scrape event must render the Glassdoor Location Cache section');
        assert(report.includes('Skipped `Glassdoor` for "Erie, PA" (no-match): no cached entry was present'),
          'the section must name the skipped location, its failureKind, and state that no cached entry existed for it');
        const phaseLine = (report.split('\n').find(line => line.includes('location-resolution-failed') && line.includes('Erie, PA')) || '');
        assert(phaseLine.includes('kind=no-match') && phaseLine.includes('reason=autocomplete returned no verified exact match'),
          'the Recent browser-scrape phases line for a location skip must surface kind= and reason=, not just the bare phase name');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
    },
  },
{
    name: 'ZipRecruiter Trakstar detail navigation leaves application mode before extraction',
    run: () => {
      const applyUrl = 'https://xideral.hire.trakstar.com/jobs/fk0zdvb/?apply=true&utm_source=ziprecruiter';
      const normalized = normalizeDetailNavigationUrl(applyUrl);
      const parsed = new URL(normalized);
      assert(!parsed.searchParams.has('apply') && parsed.searchParams.get('utm_source') === 'ziprecruiter',
        'Trakstar application mode is removed while unrelated source attribution remains intact');
      assert(normalizeDetailNavigationUrl('https://boards.greenhouse.io/acme/jobs/123?apply=true')
        === 'https://boards.greenhouse.io/acme/jobs/123?apply=true',
      'application-mode normalization is host-specific and cannot alter another ATS');
      assert(normalizeDetailNavigationUrl('/jobs/fk0zdvb/?apply=true') === '/jobs/fk0zdvb/?apply=true',
        'relative or malformed source URLs remain unchanged for the normal navigation error path');
      return { normalized };
    },
  },
{
    name: 'Advance-control label families stay separated so a finished pager is not misread as truncated',
    run: () => {
      const pager    = new RegExp(ADVANCE_CONTROL_LABEL_PATTERNS.pager);
      const loadMore = new RegExp(ADVANCE_CONTROL_LABEL_PATTERNS.loadMore);
      const norm = t => t.replace(/\s+/g, ' ').trim().toLowerCase();

      // Why this test exists: Glassdoor's Next.js rewrite replaced its pager
      // with an in-page "Show more jobs" append. The unhandled-control detector
      // only recognized "next page", so a stale load-more selector ended the
      // walk at page 1 and reported a clean `completed` — a silently truncated
      // search that looked identical to an exhausted board.
      assert(loadMore.test(norm('Show more jobs')) && loadMore.test(norm('Load more jobs'))
        && loadMore.test(norm('Show 30 more jobs')),
      'a load-more source recognizes the in-place append control that replaced its pager');

      // The families must NOT be merged into one pattern. A pager source that
      // has genuinely reached its last page still shows end-of-results
      // furniture; matching it would turn every completed pager walk into a
      // false blocking `pagination-unhandled` warning.
      assert(!pager.test(norm('Show more jobs')) && !pager.test(norm('More jobs like this')),
        'the pager family ignores load-more and end-of-results copy so a finished walk stays `completed`');
      assert(!loadMore.test(norm('More jobs like this')) && !loadMore.test(norm('Load more reviews'))
        && !loadMore.test(norm('Next steps')),
      'the load-more family ignores adjacent page furniture that is not an advance control');

      assert(pager.test(norm('Next Page')) && pager.test(norm('Go to next page')),
        'the pager family still matches the conventional next-page control it always did');
      return { pager: ADVANCE_CONTROL_LABEL_PATTERNS.pager, loadMore: ADVANCE_CONTROL_LABEL_PATTERNS.loadMore };
    },
  },
{
    name: 'Glassdoor detail enrichment keeps the successful country host and recognizes the Humans only hard block',
    run: () => {
      const detail = 'https://fr.glassdoor.ca/job-listing/staff-engineer-acme-JV_IC2281069.htm?jl=101';
      const canadaList = 'https://www.glassdoor.ca/Job/canada-engineer-jobs.htm?locId=3&locT=N';
      const pinned = pinGlassdoorDetailUrlToListHost(detail, canadaList);
      assert(new URL(pinned).hostname === 'www.glassdoor.ca'
        && new URL(pinned).pathname === '/job-listing/staff-engineer-acme-JV_IC2281069.htm'
        && new URL(pinned).searchParams.get('jl') === '101',
      'a regional Canada listing is pinned to the already-successful .ca session without changing its path or query');
      assert(new URL(pinGlassdoorDetailUrlToListHost(
        'https://www.glassdoor.ca/job-listing/example.htm?jl=2',
        'https://www.glassdoor.com/Job/jobs.htm',
      )).hostname === 'www.glassdoor.com',
      'a .com search keeps detail enrichment on .com rather than applying a fixed country host');
      assert(pinGlassdoorDetailUrlToListHost('https://boards.greenhouse.io/acme/jobs/1', canadaList)
        === 'https://boards.greenhouse.io/acme/jobs/1',
      'an unrelated employer/ATS URL is never rewritten as Glassdoor');

      const humansOnly = 'Humans only Glassdoor has been built on the contributions of real employees and job seekers. If you have been mistakenly blocked from accessing our site, review the Help Center. Ray ID: a307f0152a7d860b';
      assert(hasManualVerificationText(humansOnly) && hasManualHardBlockText(humansOnly),
        'Glassdoor\'s current non-interactive Humans only copy is classified as a terminal hard block');
      assert(!hasManualVerificationText('Staff Software Engineer at Nubank. Build reliable credit card services.'),
        'an ordinary job description does not false-positive as a verification wall');
      assert(isDetachedDetailFrameError("Attempted to use detached Frame 'F35FF1A2'")
        && isDetachedDetailFrameError('Navigating frame was detached')
        && !isDetachedDetailFrameError('Navigation timeout of 12000 ms exceeded'),
      'a dead Puppeteer detail frame is terminal for the batch while an ordinary bounded timeout remains per-listing');
      return { host: new URL(pinned).hostname, hardBlockRecognized: true };
    },
  },
{
    name: 'verification wording inside a full content page never parks or blocks a scrape',
    run: () => {
      // Reproduces the ZipRecruiter run that sat on `challenge-detected` for
      // 49 minutes: page 4 of a normal results list, no widget of any kind, and
      // a posting whose own copy mentioned a security check.
      const listPage = classifyManualChallengeSignals({
        isChallenge: true,
        reason: 'verification-text',
        hasVerificationText: true,
        hasNormalContent: true,
        bodyTextLength: 18_400,
        title: '267 Software Architect Jobs (NOW HIRING) in Canada - ZipRecruiter',
      });
      assert(!listPage.isChallenge && !listPage.isHardBlock && listPage.reason === 'none'
        && listPage.suppressedReason === 'verification-text-in-page-content',
      'a results page carrying verification wording is scraped, not parked on an indefinite human-solve wait');

      // The same root cause on the detail path, where `hasNormalContent` uses
      // Indeed-shaped selectors and is therefore false on every other board —
      // which turned the identical false positive into a hard block that cost
      // the page its remaining descriptions.
      const detailPage = classifyManualChallengeSignals({
        isChallenge: true,
        reason: 'verification-text',
        hasVerificationText: true,
        hasNormalContent: false,
        bodyTextLength: 6_100,
        title: 'Software Developer, job in Gatineau, Quebec, Canada at ZipRecruiter',
      });
      assert(!detailPage.isChallenge && !detailPage.isHardBlock,
        'a full-length detail page is never hard-blocked on page text alone, even with no source-shaped content selector');

      // Real interstitials replace the document, so they stay on the solve path.
      const interstitial = classifyManualChallengeSignals({
        isChallenge: true,
        reason: 'verification-text',
        hasVerificationText: true,
        hasNormalContent: false,
        bodyTextLength: 180,
      });
      assert(interstitial.isChallenge && interstitial.isHardBlock && !interstitial.suppressedReason,
        'an interstitial-sized document keeps its terminal verdict');

      const boundary = classifyManualChallengeSignals({
        isChallenge: true, reason: 'verification-text', bodyTextLength: CHALLENGE_INTERSTITIAL_MAX_CHARS,
      });
      assert(boundary.isChallenge,
        'the interstitial ceiling is inclusive, so a page exactly at the bound is still treated as a challenge');

      // A widget is corroboration on its own — never suppress something the
      // user can actually solve, however long the page is.
      const widgetOnLongPage = classifyManualChallengeSignals({
        isChallenge: true,
        reason: 'verification-text',
        hasCloudflareTurnstileWidget: true,
        bodyTextLength: 22_000,
      });
      assert(widgetOnLongPage.isChallenge && widgetOnLongPage.interactive && !widgetOnLongPage.suppressedReason,
        'a live Turnstile widget keeps the solve wait no matter how much content surrounds it');

      // Cloudflare's post-solve hand-off must keep reading as challenge state,
      // or the stable-clean timer starts before the redirect lands.
      const postSolve = classifyManualChallengeSignals({
        isChallenge: true,
        reason: 'verification-text',
        verificationCompleted: true,
        bodyTextLength: 9_000,
      });
      assert(postSolve.isChallenge && !postSolve.suppressedReason,
        'the "verification successful, waiting to redirect" transient is never read as a clean page');

      // Reasons that do not rest on free prose are untouched by this gate.
      const shell = classifyManualChallengeSignals({
        isChallenge: true, reason: 'challenge-shell', hasChallengeShell: true, bodyTextLength: 30_000,
      });
      const googleSorry = classifyManualChallengeSignals({
        isChallenge: true, reason: 'google-sorry-recaptcha', hasNormalContent: false, bodyTextLength: 40_000,
      });
      assert(shell.isChallenge && googleSorry.isChallenge && googleSorry.isHardBlock,
        'structural and URL-derived verdicts are unaffected by document size');

      // An unmeasured document keeps the prior behaviour instead of silently
      // widening what counts as a challenge.
      const unmeasured = classifyManualChallengeSignals({
        isChallenge: true, reason: 'verification-text', hasNormalContent: false,
      });
      assert(unmeasured.isChallenge && unmeasured.isHardBlock && unmeasured.bodyTextLength === null,
        'a probe that could not measure the document falls back to the pre-existing verdict');
      return { suppressed: listPage.suppressedReason, interstitialHardBlock: interstitial.isHardBlock };
    },
  },
{
    name: 'a challenge report states the page size and matched phrase behind a verification-text verdict',
    run: () => {
      const falsePositive = formatChallengeTextEvidence({
        bodyTextLength: 18_400,
        interstitialMaxChars: 2_000,
        matchedVerificationMarkers: ['security check'],
      });
      assert(falsePositive.includes('18400 chars') && falsePositive.includes('past the 2000-char interstitial ceiling')
        && falsePositive.includes('security check'),
      'the report names the phrase that fired and shows the page was full content — the two facts a verification-text verdict cannot be checked without');

      const genuine = formatChallengeTextEvidence({
        bodyTextLength: 210,
        interstitialMaxChars: 2_000,
        matchedVerificationMarkers: ['verify you are human'],
      });
      assert(genuine.includes('interstitial-sized') && genuine.includes('verify you are human'),
        'a real interstitial is reported as interstitial-sized rather than merely asserted to be a challenge');

      assert(formatChallengeTextEvidence(null) === '' && formatChallengeTextEvidence({}) === '',
        'a phase that carries no text evidence adds no line, so unrelated phases are not padded with empty claims');
      const unmeasured = formatChallengeTextEvidence({ matchedVerificationMarkers: ['humans only'] });
      assert(!unmeasured.includes('chars') && unmeasured.includes('humans only'),
        'an unmeasured document reports the matched phrase without asserting a size it never observed');
      return { falsePositive };
    },
  },
{
    name: 'challenge heartbeat backs off so a long wait cannot evict the main-process log ring',
    run: () => {
      assert(challengeHeartbeatIntervalMs(0) === 30_000,
        'the first beat still lands 30s in, so a short wait reads exactly as before');
      assert(challengeHeartbeatIntervalMs(1) === 60_000 && challengeHeartbeatIntervalMs(2) === 120_000,
        'each subsequent beat doubles its interval');
      assert(challengeHeartbeatIntervalMs(20) === 600_000 && Number.isFinite(challengeHeartbeatIntervalMs(1e9)),
        'the cadence saturates at ten minutes and never overflows on an unbounded wait');

      // The observed failure: 49 minutes of waiting emitted ~99 lines into a
      // 200-line ring, evicting every main-process line from before the run.
      const RING = 200;
      let elapsed = 0;
      let beats = 0;
      while (elapsed < 49 * 60_000) {
        elapsed += challengeHeartbeatIntervalMs(beats);
        beats++;
      }
      assert(beats < RING / 10,
        `a 49-minute wait must cost the 200-line ring a small fraction of its capacity, emitted ${beats}`);
      return { beatsIn49Minutes: beats };
    },
  },
{
    name: 'Glassdoor Humans only page remains solvable when interactive challenge machinery is present',
    run: () => {
      const turnstile = classifyManualChallengeSignals({
        isChallenge: true,
        reason: 'just-a-moment-title',
        hasTerminalHardBlockText: true,
        hasCloudflareTurnstileWidget: true,
        hasNormalContent: false,
      });
      assert(turnstile.isChallenge && turnstile.interactive && !turnstile.isHardBlock
        && turnstile.reason === 'just-a-moment-title',
      'terminal Glassdoor copy cannot override a live Turnstile widget');

      const frame = classifyManualChallengeSignals({
        isChallenge: true,
        reason: 'verification-text',
        hasTerminalHardBlockText: true,
        hasCloudflareChallengeFrame: true,
        hasNormalContent: false,
      });
      assert(frame.isChallenge && frame.interactive && !frame.isHardBlock,
        'a Cloudflare challenge iframe keeps the browser in the human-solve wait');

      const textOnly = classifyManualChallengeSignals({
        isChallenge: true,
        reason: 'verification-text',
        hasTerminalHardBlockText: true,
        hasNormalContent: false,
      });
      assert(textOnly.isChallenge && !textOnly.interactive && textOnly.isHardBlock
        && textOnly.reason === 'hard-block',
      'the same terminal copy with no interactive machinery remains a fast terminal block');

      const googleWithoutCaptcha = classifyManualChallengeSignals({
        isChallenge: true,
        reason: 'google-sorry-recaptcha',
        hasNormalContent: false,
      });
      assert(googleWithoutCaptcha.isHardBlock,
        'Google unusual-traffic pages without a rendered captcha remain terminal');

      const normal = classifyManualChallengeSignals({
        isChallenge: false,
        reason: 'none',
        hasNormalContent: true,
      });
      assert(!normal.isChallenge && !normal.isHardBlock && !normal.interactive,
        'ordinary content remains challenge-free');
      return { turnstileHardBlock: turnstile.isHardBlock, textOnlyHardBlock: textOnly.isHardBlock };
    },
  },
{
    name: 'challenge transition keeps a post-Turnstile terminal-looking page open through its stable grace',
    run: () => {
      const interactive = classifyManualChallengeSignals({
        isChallenge: true,
        reason: 'just-a-moment-title',
        hasTerminalHardBlockText: true,
        hasCloudflareTurnstileWidget: true,
        hasNormalContent: false,
      });
      const terminal = classifyManualChallengeSignals({
        isChallenge: true,
        reason: 'verification-text',
        hasTerminalHardBlockText: true,
        hasNormalContent: false,
      });
      const presented = resolveManualChallengeTransition({
        signals: interactive, sawInteractiveChallenge: false, terminalSince: null, now: 1_000, graceMs: 10_000,
      });
      assert(presented.disposition === 'interactive' && presented.sawInteractiveChallenge,
        'a live Turnstile begins the human-solve wait and establishes transition history');

      const justLostWidget = resolveManualChallengeTransition({
        signals: terminal, sawInteractiveChallenge: presented.sawInteractiveChallenge,
        terminalSince: presented.terminalSince, now: 2_000, graceMs: 10_000,
      });
      const almostStable = resolveManualChallengeTransition({
        signals: terminal, sawInteractiveChallenge: justLostWidget.sawInteractiveChallenge,
        terminalSince: justLostWidget.terminalSince, now: 11_999, graceMs: 10_000,
      });
      const stableTerminal = resolveManualChallengeTransition({
        signals: terminal, sawInteractiveChallenge: almostStable.sawInteractiveChallenge,
        terminalSince: almostStable.terminalSince, now: 12_000, graceMs: 10_000,
      });
      assert(justLostWidget.disposition === 'terminal-settling'
        && justLostWidget.terminalSince === 2_000
        && almostStable.disposition === 'terminal-settling'
        && almostStable.terminalElapsedMs === 9_999
        && stableTerminal.disposition === 'hard-block'
        && stableTerminal.terminalElapsedMs === 10_000,
      'a no-widget terminal-looking page after a solve cannot close immediately; it stops only after a full stable grace');

      const returnedWidget = resolveManualChallengeTransition({
        signals: interactive, sawInteractiveChallenge: justLostWidget.sawInteractiveChallenge,
        terminalSince: justLostWidget.terminalSince, now: 3_000, graceMs: 10_000,
      });
      const initialTerminal = resolveManualChallengeTransition({
        signals: terminal, sawInteractiveChallenge: false, terminalSince: null, now: 2_000, graceMs: 10_000,
      });
      assert(returnedWidget.disposition === 'interactive-returned' && returnedWidget.terminalSince === null
        && initialTerminal.disposition === 'hard-block',
      'a re-rendered widget returns to the foreground human wait, while a never-interactive terminal page still stops promptly');
      return { graceMs: stableTerminal.terminalElapsedMs, postSolve: justLostWidget.disposition };
    },
  },
{
    name: 'detail challenge policy foregrounds solvable or transitioning pages and stops only terminal blocks',
    run: () => {
      const interactive = classifyManualChallengeSignals({
        isChallenge: true,
        reason: 'cloudflare-challenge-frame',
        hasCloudflareChallengeFrame: true,
        hasNormalContent: false,
      });
      const terminal = classifyManualChallengeSignals({
        isChallenge: true,
        reason: 'verification-text',
        hasTerminalHardBlockText: true,
        hasNormalContent: false,
      });
      const liveWidget = resolveManualDetailChallengeDisposition({
        signals: interactive, now: 1_000, graceMs: 10_000,
      });
      const transitioning = resolveManualDetailChallengeDisposition({
        signals: terminal, sawInteractiveChallenge: liveWidget.sawInteractiveChallenge,
        terminalSince: liveWidget.terminalSince, now: 2_000, graceMs: 10_000,
      });
      const stableTerminal = resolveManualDetailChallengeDisposition({
        signals: terminal, sawInteractiveChallenge: transitioning.sawInteractiveChallenge,
        terminalSince: transitioning.terminalSince, now: 12_000, graceMs: 10_000,
      });
      const initialTerminal = resolveManualDetailChallengeDisposition({
        signals: terminal, now: 1_000, graceMs: 10_000,
      });
      const noChallenge = resolveManualDetailChallengeDisposition({
        signals: { isChallenge: false, isHardBlock: false }, now: 1_000, graceMs: 10_000,
      });
      assert(liveWidget.disposition === 'foreground-wait'
        && transitioning.disposition === 'foreground-wait'
        && transitioning.terminalElapsedMs === 0
        && stableTerminal.disposition === 'terminal-stop'
        && initialTerminal.disposition === 'terminal-stop'
        && noChallenge.disposition === 'none',
      'detail-tab challenges foreground an interactive page and its terminal transition for the human, but stop only an initial or grace-stable no-widget terminal page');
      return { interactive: liveWidget.disposition, settled: stableTerminal.disposition };
    },
  },
{
    name: 'Glassdoor terminal detail hard blocks do not offer a fake Solve loop',
    run: () => {
      const rootWarning = {
        code: 'description-detail-hard-block', severity: 'block', action: 'none',
        evidence: 'Glassdoor returned the Humans only page.',
        suggestion: 'Do not keep retrying Glassdoor.',
      };
      const warning = buildResolvedDescriptionWarning(
        'glassdoor',
        rootWarning,
        [],
        [{ title: 'Solutions Architect' }, { title: 'Platform Architect' }],
      );
      assert(warning.code === 'description-detail-hard-block'
        && warning.action === 'none'
        && warning.shortLabel === 'Wait, then rerun'
        && warning.evidence.includes('0 description-complete listing(s)')
        && warning.evidence.includes('2 still lack a full description')
        && warning.suggestion.includes('There is no interactive challenge to solve')
        && !canAttemptJobSourceResolve(warning),
      'a resolved list page must retain the terminal detail-block cause and suppress another immediate Solve');
      assert(!canAttemptJobSourceResolve({ code: 'cloudflare-hard-block', severity: 'block' })
        && canAttemptJobSourceResolve({ code: 'http-403', severity: 'block' }),
      'older persisted terminal hard-block warnings are also non-resolvable, while a real 403 challenge stays solvable');
      return { code: warning.code, canResolve: canAttemptJobSourceResolve(warning) };
    },
  },
{
    name: 'ZipRecruiter detail error shell is retried in place, bounded, and never mistaken for an unavailable listing',
    run: () => {
      const shellCopy = 'We encountered an error while loading this job.\n\nReload the Job';
      assert(isZipRecruiterDetailErrorShell({
        url: 'https://www.ziprecruiter.com/c/Acme/Job/Full-Stack-Engineer/-in-Toronto?jid=abc',
        visibleText: shellCopy,
      })
        && isZipRecruiterDetailErrorShell({
          url: 'https://ziprecruiter.com/jobs/abc',
          visibleText: shellCopy,
        })
        && !isZipRecruiterDetailErrorShell({
          url: 'https://www.indeed.com/viewjob?jk=abc',
          visibleText: shellCopy,
        })
        && !isZipRecruiterDetailErrorShell({
          url: 'https://www.ziprecruiter.com/jobs/abc',
          visibleText: 'Senior Engineer — you will debug errors while loading data pipelines.',
        })
        && !isZipRecruiterDetailErrorShell({
          url: 'not a URL',
          visibleText: shellCopy,
        }),
      'only a ZipRecruiter host serving its exact error-shell copy enters the re-navigation path');

      assert(zipRecruiterDetailErrorShellBackoffMs(1) === 1_500
        && zipRecruiterDetailErrorShellBackoffMs(2) === 3_000
        && zipRecruiterDetailErrorShellBackoffMs(99) === 6_000
        && zipRecruiterDetailErrorShellBackoffMs(0) === 1_500,
      'error-shell retries have a bounded exponential backoff and never spin immediately');

      // Two properties a rebase can silently destroy, both invisible to a
      // behavioural test: an inert fix (branch ordered after the drop) and an
      // infinite loop (budget counter reset by `i--; continue;`).
      const scraperSource = fs.readFileSync(path.resolve('electron/ipc/browser/manualScraper.js'), 'utf8');
      assert(scraperSource.includes('let errorShellRetryIndex = -1;')
        && scraperSource.indexOf('let errorShellRetryIndex = -1;') < scraperSource.indexOf('for (let i = 0; i < enhanced.length; i++)'),
      'the error-shell retry budget is declared outside the detail loop so `i--; continue;` cannot reset it');
      assert(scraperSource.indexOf('isZipRecruiterDetailErrorShell({') < scraperSource.indexOf('if (isUnavailableDetailPage(pageInfo))'),
      'the transient error shell is classified BEFORE the conclusively-unavailable drop, so a copy change can never discard a live listing');
      return { retries: 2 };
    },
  },
{
    name: 'ZipRecruiter Appcast restriction recovery is narrow, bounded, and offers an IP-change retry',
    run: () => {
      const restrictedCopy = 'Access is temporarily restricted\n\nWe detected unusual activity from your device or network.';
      assert(isAppcastTemporaryRestriction({
        url: 'https://click.appcast.io/track/abc?source=ziprecruiter',
        visibleText: restrictedCopy,
      })
        && !isAppcastTemporaryRestriction({
          url: 'https://www.appcast.io/track/abc',
          visibleText: restrictedCopy,
        })
        && !isAppcastTemporaryRestriction({
          url: 'https://click.appcast.io/track/abc',
          visibleText: 'Access is temporarily restricted',
        })
        && !isAppcastTemporaryRestriction({
          url: 'not a URL',
          visibleText: restrictedCopy,
        }),
      'only Appcast click redirects carrying both visible restriction markers enter the ZipRecruiter recovery path');
      assert(zipRecruiterAppcastRestrictionBackoffMs(1) === 6_000
        && zipRecruiterAppcastRestrictionBackoffMs(2) === 12_000
        && zipRecruiterAppcastRestrictionBackoffMs(99) === 15_000
        && zipRecruiterAppcastRestrictionBackoffMs(0) === 6_000,
      'Appcast retries have a bounded exponential backoff and never spin immediately');

      const warning = buildResolvedDescriptionWarning(
        'ziprecruiter',
        {
          code: 'description-appcast-temporary-restriction',
          severity: 'block',
          shortLabel: 'Switch IP, then retry',
          actionLabel: 'Retry after IP change',
          evidence: 'Appcast restriction remained after the one automatic recovery.',
          suggestion: 'Switch ProtonVPN, then retry.',
        },
        [{ title: 'Recovered Architect' }],
        [{ title: 'Blocked Architect' }],
      );
      assert(warning.code === 'description-appcast-temporary-restriction'
        && warning.severity === 'block'
        && warning.actionLabel === 'Retry after IP change'
        && warning.shortLabel === 'Switch IP, then retry'
        && warning.evidence.includes('1 description-complete listing(s)')
        && warning.evidence.includes('1 still lack a full description')
        && warning.suggestion.includes('Switch ProtonVPN')
        && canAttemptJobSourceResolve(warning)
        && isJobSourceWarningGating(warning),
      'an exhausted Appcast detail recovery pauses the source but preserves the existing user-driven retry path after an IP change');
      return { backoffMs: zipRecruiterAppcastRestrictionBackoffMs(2), retryAction: warning.actionLabel };
    },
  },
{
    name: 'ZipRecruiter detail enrichment reads external application pages without form automation and bounds 429 retry waits',
    run: () => {
      assert(shouldNavigateForDescription('ziprecruiter', 'https://www.ziprecruiter.com/jobs/acme/platform-architect?lvk=abc'),
        'a ZipRecruiter /jobs detail page remains eligible for read-only enrichment');
      assert(shouldNavigateForDescription('ziprecruiter', 'https://www.ziprecruiter.com/c/Actalent/Job/Principal-Systems-Engineer/-in-Kanata,ON?jid=abc'),
        'a legacy ZipRecruiter /c/<company>/Job/<title> detail page remains eligible for read-only enrichment');
      assert(shouldNavigateForDescription('ziprecruiter', 'https://lbg.wd3.myworkdayjobs.com/lbg_Careers/job/Architect_123/apply?utm_source=ziprecruiter'),
        'an employer Workday page is eligible for one read-only text extraction without clicking its form');
      assert(shouldNavigateForDescription('ziprecruiter', 'https://xideral.hire.trakstar.com/jobs/fk0ziuq/?apply=true&utm_source=ziprecruiter'),
        'an external Trakstar page is eligible for one read-only text extraction without clicking its form');
      assert(!shouldNavigateForDescription('ziprecruiter', 'file:///Users/example/job.html'),
        'only ordinary HTTP(S) detail URLs are eligible for external-page enrichment');
      const glassdoorPolicy = descriptionNavigationDecision(
        'glassdoor',
        'https://fr.glassdoor.ca/job-listing/platform-architect.htm?jl=101',
      );
      assert(!shouldNavigateForDescription('glassdoor', 'https://www.glassdoor.ca/job-listing/platform-architect.htm?jl=101')
        && !shouldNavigateForDescription('glassdoor', 'https://example.com/apply')
        && glassdoorPolicy.reason === 'glassdoor-list-card-panel-only',
      'Glassdoor description enrichment is structurally list-card-only: no detail or external URL may reach goto(), even if a future config accidentally enables detail navigation');
      assert(isZipRecruiterClosedDetailRedirect('https://www.ziprecruiter.com/jobseeker/home?closed_job_redirect=1')
        && !isZipRecruiterClosedDetailRedirect('https://www.ziprecruiter.com/jobseeker/home')
        && !isZipRecruiterClosedDetailRedirect('https://www.ziprecruiter.com/c/Acme/Job/Software-Engineer/-in-Toronto,ON?jid=abc')
        && !isZipRecruiterClosedDetailRedirect('https://jobs.example.com/jobseeker/home?closed_job_redirect=1'),
      'only ZipRecruiter\'s explicit closed-job redirect is retired; ordinary home, job, and external URLs remain eligible');
      assert(isUnavailableDetailPage({ isNotFound: true })
        && isUnavailableDetailPage({ workdayPostingAvailable: false })
        && isUnavailableDetailPage({ zipRecruiterClosedJobRedirect: true })
        && !isUnavailableDetailPage({ workdayPostingAvailable: true })
        && !isUnavailableDetailPage({ zipRecruiterClosedJobRedirect: false })
        && !isUnavailableDetailPage({}),
      'an HTTP-200 Workday bootstrap marked postingAvailable=false or ZipRecruiter closed-job redirect is treated as a closed listing, while an ordinary available/unknown page remains eligible for recovery');
      assert(zipRecruiterRetryAfterMs('120') === 60_000
        && zipRecruiterRetryAfterMs('', 0) === 45_000
        && zipRecruiterRetryAfterMs('invalid', 0) === 45_000
        && zipRecruiterRetryAfterMs('0') === 1_000,
      'Retry-After handling respects server waits where practical, has a safe fallback, and never spins immediately');
      return { externalApplySkipped: true, retryWaitCappedMs: zipRecruiterRetryAfterMs('120') };
    },
  },
{
    name: 'ZipRecruiter detail merge: a description miss still retains the detail-page posted date',
    run: () => {
      // ZR's live trigger is still telemetry-led, but the mechanism is known:
      // description failure and date recovery are independent. Do not require a
      // description/salary before writing the recovered date back to the card.
      const listCard = {
        title: 'Patient Representative II',
        company: 'Acme Health',
        location: 'Toronto, ON',
        url: 'https://www.ziprecruiter.com/jobs/example',
        salary: '$29/hr',
        snippet: 'Search-result summary survives a detail description miss.',
        posted: '',
      };
      const merged = mergeExpandedJobDetail(listCard, {
        text: '',
        jsonLdDate: '2026-08-10',
        jsonLdSalary: '',
        salaryChanged: false,
      });
      assert(merged.posted === '2026-08-10',
        'a recovered date must be written even when description and salary both miss');
      assert(merged.snippet === listCard.snippet && merged.title === listCard.title && merged.salary === listCard.salary,
        'a partial detail update preserves list-card snippet and all unrelated fields');

      const emptyListDescription = mergeExpandedJobDetail(
        { ...listCard, snippet: '', posted: '' },
        { text: '', jsonLdDate: '2026-08-10', jsonLdSalary: '', salaryChanged: false },
      );
      assert(Object.hasOwn(emptyListDescription, 'snippet') && emptyListDescription.snippet === '',
        'a bounded detail-description miss retains a listing with an explicitly empty description');
      assert(emptyListDescription.url === listCard.url && emptyListDescription.title === listCard.title,
        'an empty detail description cannot discard or mutate the ZipRecruiter list row');
      assert(emptyListDescription.posted === '2026-08-10',
        'an empty description still permits independent detail fields such as datePosted');

      const existingDate = mergeExpandedJobDetail({ ...listCard, posted: '3 days ago' }, {
        text: '', jsonLdDate: '2026-08-10', jsonLdSalary: '', salaryChanged: false,
      });
      assert(existingDate.posted === '3 days ago',
        'detail ISO dates do not clobber an existing list-card relative date');
      const repairedSalary = mergeExpandedJobDetail({ ...listCard, salary: 'US$19 - US$20 (Employer provided)' }, {
        jsonLdSalary: '$19/hr', salaryChanged: false,
      });
      assert(repairedSalary.salary === '$19/hr',
        'authoritative structured detail pay repairs a present but unparseable list salary');
      const healthySalary = mergeExpandedJobDetail({ ...listCard, salary: '$29/hr' }, {
        jsonLdSalary: '$19/hr', salaryChanged: false,
      });
      assert(healthySalary.salary === '$29/hr',
        'structured detail pay does not clobber an already-parseable list salary');
      const filledCompany = mergeExpandedJobDetail({ ...listCard, company: '   ' }, {
        jsonLdCompany: '  Detail-page employer  ',
      });
      assert(filledCompany.company === 'Detail-page employer',
        'structured detail company fills a blank list-card company and is normalized');
      const preservedCompany = mergeExpandedJobDetail(listCard, {
        jsonLdCompany: 'Different detail-page employer',
      });
      assert(preservedCompany.company === 'Acme Health',
        'structured detail company does not clobber a usable list-card company');
      const blankDetailCompany = mergeExpandedJobDetail({ ...listCard, company: '   ' }, {
        jsonLdCompany: '   ',
      });
      assert(blankDetailCompany.company === '   ',
        'blank structured company data does not replace an equally blank list-card field');
      return { posted: merged.posted, preserved: true };
    },
  },
{
    name: 'Job tree: fully collapsed at analysis end (no auto-expand)',
    run: () => {
      const mk = (title, score, url) => ({
        title, company: 'Acme', location: 'Remote', salary: '$120k', snippet: 'x',
        matchScore: score, reasoning: 'r', careerDirection: 'x',
        source: 'lever', url, posted: 'today',
      });
      const displayedJobs = [mk('Weak', 40, 'https://jobs/lo'), mk('Strong', 95, 'https://jobs/hi')];
      const result = buildJobTreeNodes({
        displayedJobs,
        bucketTree: {
          likelihoodBands: [
            { label: 'Strong (70–100%)', minScore: 70, maxScore: 100 },
            { label: 'Possible (0–69%)', minScore: 0, maxScore: 69 },
          ],
          salaryRanges: [{ label: '$100k+', minSalary: 100000, maxSalary: 0 }, { label: 'Unspecified', minSalary: 0, maxSalary: 0 }],
          roles: [{ name: 'Role A', jobIndices: [0, 1] }],
        },
        profile: { skills: ['x'] },
        originalPos: { x: 0, y: 0 }, hubId: 'hub-1', baseNodeId: 'job-c',
      });
      const bands = result.newNodes.filter(n => n.data?.kind === 'likelihood');
      const nonBandGroups = result.newNodes.filter(n => n.type === 'jobgroup' && n.data?.kind !== 'likelihood');
      const cards = result.newNodes.filter(n => n.type === 'jobcard');
      const excellent = bands.find(b => b.data.label.startsWith('Excellent'));
      const partial = bands.find(b => b.data.label.startsWith('Partial hiring fit'));
      // Nothing is expanded — the whole tree is closed when analysis ends.
      assert(result.newNodes.every(n => !n.data?.expanded), 'collapsed: no node should be expanded');
      // Band roots are visible (collapsed pills); everything below is hidden.
      assert(bands.every(b => b.hidden === false), 'collapsed: band roots should be visible');
      assert(nonBandGroups.every(g => g.hidden === true), 'collapsed: salary/role groups should be hidden');
      assert(cards.every(c => c.hidden === true), 'collapsed: all cards should be hidden');
      // Bands still ordered best-first and stacked (layout pass runs regardless).
      assert(excellent.position.y < partial.position.y, 'collapsed: Excellent hiring-fit band should still sit above Partial');
      return { ok: true };
    },
  },
{
    name: 'Job Board: unionScoredJobs dedups by identity, keeps higher score',
    run: () => {
      const a = [
        { title: 'Eng', company: 'Acme', url: 'https://j/1', matchScore: 60, originHubId: 'A' },
        { title: 'PM', company: 'Beta', url: 'https://j/2', matchScore: 80, originHubId: 'A' },
      ];
      const b = [
        { title: 'Eng', company: 'Acme', url: 'https://j/1', matchScore: 90, originHubId: 'B' }, // dup of a[0], higher
        { title: 'Designer', company: 'Gamma', url: '', matchScore: 50, originHubId: 'B' },
        { title: 'designer', company: 'gamma', url: '', matchScore: 70, originHubId: 'B' }, // dup by title|company (no url)
      ];
      const out = unionScoredJobs([a, b]);
      assert(out.length === 3, `union: expected 3 unique, got ${out.length}`);
      const eng = out.find(j => j.url === 'https://j/1');
      assert(eng.matchScore === 90, `union: higher score should win (got ${eng.matchScore})`);
      assert(eng.originHubId === 'B', 'union: winning copy carries its own origin module id');
      // First-seen order preserved: Eng (a[0]), PM, Designer.
      assert(out[0].url === 'https://j/1' && out[1].url === 'https://j/2', 'union: first-seen order preserved');
      const designer = out.find(j => j.company.toLowerCase() === 'gamma');
      assert(designer.matchScore === 70, 'union: title|company dedup keeps higher score when url missing');
      return { unique: out.length };
    },
  },
{
    name: 'Job Board: unionScoredJobs reports merge stats via out-param',
    run: () => {
      const a = [
        { title: 'Eng', company: 'Acme', url: 'https://j/1', matchScore: 60 },
        { title: 'PM', company: 'Beta', url: 'https://j/2', matchScore: 80 },
      ];
      const b = [
        { title: 'Eng', company: 'Acme', url: 'https://j/1', matchScore: 90 }, // dup, higher → upgrade
        { title: 'PM', company: 'Beta', url: 'https://j/2', matchScore: 50 },  // dup, lower → no upgrade
        { title: 'New', company: 'Gamma', url: 'https://j/3', matchScore: 70 },
      ];
      const stats = {};
      const out = unionScoredJobs([a, b], stats);
      assert(out.length === 3, `stats: expected 3 unique, got ${out.length}`);
      assert(stats.totalIncoming === 5, `stats: totalIncoming should be 5 (got ${stats.totalIncoming})`);
      assert(stats.unique === 3, `stats: unique should be 3 (got ${stats.unique})`);
      assert(stats.duplicatesRemoved === 2, `stats: duplicatesRemoved should be 2 (got ${stats.duplicatesRemoved})`);
      assert(stats.collisions === 2, `stats: collisions should be 2 (got ${stats.collisions})`);
      assert(stats.collisionUpgrades === 1, `stats: only the higher-score collision upgrades (got ${stats.collisionUpgrades})`);
      // Stats path must not alter the returned union vs. the no-stats call.
      assert(unionScoredJobs([a, b]).length === out.length, 'stats: out-param does not change the result');
      return stats;
  },
},
{
    name: 'Job Board: preference-filtered legacy rows never reach display input',
    run: () => {
      const stats = {};
      const out = unionScoredJobs([[
        { title: 'Accepted', company: 'Acme', url: 'https://jobs/acme/accepted', matchScore: 80 },
        { title: 'Rejected', company: 'Acme', url: 'https://jobs/acme/rejected', matchScore: 99, preferenceAssessment: { status: 'filtered' } },
      ]], stats);
      assert(out.length === 1 && out[0].title === 'Accepted'
        && stats.totalIncoming === 1 && stats.preferenceFilteredSkipped === 1,
      'a filtered row is excluded before merge accounting and card construction');
      return stats;
    },
  },
{
    name: 'Job Board: equal-score duplicates only prefer compensation research in the identical market context',
    run: () => {
      const base = {
        title: 'Engineer', company: 'Acme', url: 'https://jobs/acme/1', salary: '$80k–$100k', matchScore: 85,
        compensationAssessment: {
          schemaVersion: 1, status: 'not_evaluated',
          offered: { min: 80_000, max: 100_000, currency: 'USD', period: 'annual' },
          comparisonLocation: 'Austin, Texas, United States',
        },
      };
      const researchedSameMarket = {
        ...base,
        originHubId: 'researched',
        compensationAssessment: {
          ...base.compensationAssessment,
          status: 'competitive',
          competitiveRange: { min: 95_000, max: 130_000, currency: 'USD', period: 'annual' },
          justification: 'The maximum reaches the market floor.',
        },
      };
      const stats = {};
      const sameMarket = unionScoredJobs([[{ ...base, originHubId: 'first' }], [researchedSameMarket]], stats);
      assert(sameMarket[0].originHubId === 'researched' && sameMarket[0].compensationAssessment.status === 'competitive'
        && stats.collisionAssessmentUpgrades === 1,
      'equal-score duplicates may retain a richer assessment only for the same offer and comparison market');

      const differentMarket = {
        ...researchedSameMarket,
        originHubId: 'different-market',
        compensationAssessment: { ...researchedSameMarket.compensationAssessment, comparisonLocation: 'Toronto, Ontario, Canada' },
      };
      const isolated = unionScoredJobs([[{ ...base, originHubId: 'first' }], [differentMarket]]);
      assert(isolated[0].originHubId === 'first' && isolated[0].compensationAssessment.status === 'not_evaluated',
        'a different remote residence/market must not be copied across duplicate jobs');
      return { assessmentUpgrades: stats.collisionAssessmentUpgrades };
    },
  },
{
    name: 'Job Board: unionScoredJobs tolerates empty / non-array inputs',
    run: () => {
      assert(unionScoredJobs([]).length === 0, 'union: empty → empty');
      assert(unionScoredJobs(null).length === 0, 'union: null → empty');
      const out = unionScoredJobs([null, undefined, [{ title: 'x', company: 'y', url: 'u', matchScore: 1 }]]);
      assert(out.length === 1, 'union: skips non-array entries');
      return { ok: true };
    },
  },
{
    name: 'Job Board: moduleFingerprint catches re-runs the old count+sum format missed',
    run: () => {
      const a = [{ matchScore: 90, title: 'Eng' }, { matchScore: 80, title: 'PM' }];
      assert(moduleFingerprint(a) === moduleFingerprint([{ matchScore: 90, title: 'Eng' }, { matchScore: 80, title: 'PM' }]),
        'fingerprint: identical data → same fp');
      assert(moduleFingerprint(a) !== moduleFingerprint([{ matchScore: 90, title: 'Eng' }]),
        'fingerprint: fewer jobs → different fp');
      assert(moduleFingerprint(a) !== moduleFingerprint([{ matchScore: 90, title: 'Eng' }, { matchScore: 81, title: 'PM' }]),
        'fingerprint: re-scored (same count, different score) → different fp');
      // Regression: the old count+score-sum fingerprint was blind to BOTH of
      // these, silently leaving the board un-stale after a real re-run.
      assert(moduleFingerprint([{ matchScore: 80, title: 'Eng' }, { matchScore: 90, title: 'PM' }])
          !== moduleFingerprint([{ matchScore: 85, title: 'Eng' }, { matchScore: 85, title: 'PM' }]),
        'fingerprint: equal-sum rescore ([80,90] vs [85,85]) → different fp');
      assert(moduleFingerprint(a) !== moduleFingerprint([{ matchScore: 90, title: 'Lead' }, { matchScore: 80, title: 'PM' }]),
        'fingerprint: same scores, different jobs → different fp');
      assert(moduleFingerprint([{ matchScore: 90, title: 'Manager A', url: 'https://jobs/old', source: 'indeed' }])
          !== moduleFingerprint([{ matchScore: 90, title: 'Manager B', url: 'https://jobs/new', source: 'linkedin' }]),
        'fingerprint: same score/title initial/title length but different job identity → different fp');
      assert(moduleFingerprint([{ matchScore: 90, title: 'Manager A', url: 'https://jobs/old', reasoning: 'old reason' }])
          !== moduleFingerprint([{ matchScore: 90, title: 'Manager A', url: 'https://jobs/old', reasoning: 'new reason' }]),
        'fingerprint: card-visible reasoning changes invalidate a board');
      const assessed = [{ matchScore: 90, title: 'Manager A', url: 'https://jobs/old', compensationAssessment: {
        schemaVersion: 1, status: 'below_market', reasonCode: 'offered_max_below_competitive_floor',
        offered: { min: 80_000, max: 90_000, currency: 'USD', period: 'annual' },
        competitiveRange: { min: 100_000, max: 120_000, currency: 'USD', period: 'annual' },
        comparisonLocation: 'Austin, Texas, United States', justification: 'Below market.',
        sourceLinks: [{ title: 'Survey', url: 'https://example.test', min: 100_000, max: 120_000, currency: 'USD' }],
      } }];
      const reassessed = [{ ...assessed[0], compensationAssessment: {
        ...assessed[0].compensationAssessment, status: 'competitive', justification: 'At market.',
      } }];
      assert(moduleFingerprint(assessed) !== moduleFingerprint(reassessed),
        'fingerprint: compensation verdict/explanation changes invalidate a board');
      assert(moduleFingerprint(null).startsWith('7:0:'), 'fingerprint: nullish → v7 empty fingerprint');
      const semanticBase = [{
        matchScore: 90,
        title: 'Platform Engineer',
        company: 'Acme',
        googleCardUrl: 'https://google.test/card-a',
        compensation: '$140k-$160k',
        currency: 'USD',
        description: 'Full time, 40 hours per week.',
        compensationContext: { workMode: 'remote', remoteCountry: 'Canada' },
        experienceAssessment: { categorySpecificExperience: [{ requiredMinimumYears: 2 }] },
      }];
      for (const [label, changed] of [
        ['fallback listing URL', { googleCardUrl: 'https://google.test/card-b' }],
        ['fallback compensation', { compensation: '$170k-$190k' }],
        ['listing currency', { currency: 'CAD' }],
        ['schedule description', { description: 'Part time, 20 hours per week.' }],
        ['remote market context', { compensationContext: { workMode: 'remote', remoteCountry: 'United States' } }],
        ['experience cohort', { experienceAssessment: { categorySpecificExperience: [{ requiredMinimumYears: 12 }] } }],
      ]) {
        assert(moduleFingerprint(semanticBase) !== moduleFingerprint([{ ...semanticBase[0], ...changed }]),
          `fingerprint: ${label} changes invalidate a paused Combine`);
      }
      // Legacy detection: pre-versioned signatures adopt-as-baseline, not stale.
      assert(isLegacyCombineSignature('hub-1=5.10|hub-2=3.7'), 'legacy count.sum signature detected');
      assert(isLegacyCombineSignature('hub-1=2:1:123'), 'v2 fingerprints adopt as a safe current baseline');
      assert(!isLegacyCombineSignature('hub-1=3:1:123'), 'v3 boards must be rechecked so compensation-aware v4 fingerprints can mark them stale');
      assert(!isLegacyCombineSignature('hub-1=4:1:123'), 'v4 boards must be rechecked so fit-audit-aware v5 fingerprints can mark them stale');
      assert(!isLegacyCombineSignature('hub-1=5:1:123'), 'v5 boards must be rechecked so Job Preferences-aware v6 fingerprints can mark them stale');
      assert(!isLegacyCombineSignature(combineSignature([{ id: 'A', fingerprint: moduleFingerprint(a) }])),
        'current-format signature is not legacy');
      assert(!isLegacyCombineSignature('') && !isLegacyCombineSignature(null),
        'empty/null signature is not legacy (handled by the null-adopt path)');
      return { ok: true };
    },
  },
{
    name: 'Job Board: deriveBoardCardStats reconciles dismissed cards and clamps filters',
    run: () => {
      const nodes = [
        { id: 'board', type: 'jobboard', data: {} },
        { id: 'a', type: 'jobcard', data: { hubId: 'board', source: 'indeed', matchScore: 82 } },
        { id: 'b', type: 'jobcard', data: { hubId: 'board', source: 'linkedin', matchScore: 90 } },
        { id: 'other', type: 'jobcard', data: { hubId: 'other-board', source: 'indeed', matchScore: 100 } },
      ];
      const afterDismiss = deriveBoardCardStats(nodes.filter(n => n.id !== 'b'), 'board', {
        scoreThreshold: 90,
        sourceFilter: 'linkedin',
      });
      assert(afterDismiss.resultCount === 1, 'board stats: only live board-owned cards count');
      assert(JSON.stringify(afterDismiss.finalSourceCounts) === JSON.stringify({ indeed: 1 }), 'board stats: source counts remove dismissed card');
      assert(afterDismiss.scoreRangeMin === 82 && afterDismiss.scoreRangeMax === 82, 'board stats: score range follows live cards');
      assert(afterDismiss.scoreThreshold === 82, 'board stats: out-of-range active threshold clamps to remaining score');
      assert(afterDismiss.sourceFilter === null, 'board stats: dismissed active source filter clears');
      const empty = deriveBoardCardStats([], 'board', { scoreThreshold: 80, sourceFilter: 'indeed' });
      assert(empty.resultCount === 0 && empty.scoreRangeMin === 0 && empty.scoreRangeMax === 100 && empty.scoreThreshold === 0,
        'board stats: empty board returns stable default score bounds');
      return { ok: true };
    },
  },
{
    name: 'Job Board: combineSignature is order-independent over modules',
    run: () => {
      const m1 = { id: 'A', fingerprint: '5.10' };
      const m2 = { id: 'B', fingerprint: '3.7' };
      assert(combineSignature([m1, m2]) === combineSignature([m2, m1]),
        'signature: connection order does not matter');
      assert(combineSignature([m1]) !== combineSignature([m1, m2]),
        'signature: dropping a module changes it');
      assert(combineSignature([m1, m2]) !== combineSignature([m1, { id: 'B', fingerprint: '4.8' }]),
        'signature: a module whose data changed changes it');
      assert(combineSignature([]) === '', 'signature: empty → ""');
      return { ok: true };
    },
  },
{
    name: 'Job Board: staleReason diffs last-combine signature vs. live modules',
    run: () => {
      const prev = combineSignature([{ id: 'A', fingerprint: '5.10' }, { id: 'B', fingerprint: '3.7' }]);
      // B disconnected:
      assert(staleReason(prev, [{ id: 'A', fingerprint: '5.10' }]) === '1 disconnected',
        'reason: a removed connection');
      // B is still wired but is searching, so it temporarily leaves the
      // terminal signature. That is a refresh, never a disconnection.
      assert(staleReason(
        prev,
        [{ id: 'A', fingerprint: '5.10' }],
        [{ id: 'A', hubState: 'done' }, { id: 'B', hubState: 'searching' }],
      ) === '1 updating',
      'reason: a connected non-terminal module is updating, not disconnected');
      // B re-ran (data changed):
      assert(staleReason(prev, [{ id: 'A', fingerprint: '5.10' }, { id: 'B', fingerprint: '4.9' }]) === '1 updated',
        'reason: a connection whose data changed');
      // C newly added:
      assert(staleReason(prev, [{ id: 'A', fingerprint: '5.10' }, { id: 'B', fingerprint: '3.7' }, { id: 'C', fingerprint: '2.2' }]) === '1 added',
        'reason: a new connection');
      // Identical → no drift (caller wouldn't show it, but the function stays honest):
      assert(staleReason(prev, [{ id: 'A', fingerprint: '5.10' }, { id: 'B', fingerprint: '3.7' }]) === 'connections changed',
        'reason: no diff → generic fallback');
      // Combined change:
      assert(staleReason(prev, [{ id: 'B', fingerprint: '9.9' }, { id: 'C', fingerprint: '1.1' }]) === '1 disconnected · 1 added · 1 updated',
        'reason: disconnected + added + updated together');
      return { ok: true };
  },
},
{
    name: 'Job Board: terminal zero-result source remains an updated input and can replace stale results',
    run: () => {
      const previousJobs = [{ title: 'Architect', company: 'Acme', url: 'https://jobs/acme', matchScore: 90 }];
      const previous = combineSignature([{ id: 'search-a', fingerprint: moduleFingerprint(previousJobs) }]);
      const completedZero = [{ id: 'search-a', fingerprint: moduleFingerprint([]) }];
      assert(combineSignature(completedZero) !== '',
        'zero-result terminal module stays in the board signature instead of vanishing as a disconnect');
      assert(staleReason(previous, completedZero) === '1 updated',
        'zero-result terminal module is reported as updated, not disconnected');
      const canSupplyTerminalBoardInput = (module) => (
        module.hubState === 'done' && (module.count > 0 || (
          !module.aiSkipped && !module.collectionOnly && !module.testMode
          && (module.resultDisposition === 'empty-complete' || module.resultDisposition === 'preference-filtered')
        ))
      );
      assert(!canSupplyTerminalBoardInput({ hubState: 'done', count: 0 })
        && !canSupplyTerminalBoardInput({ hubState: 'done', count: 0, resultDisposition: 'scored' })
        && !canSupplyTerminalBoardInput({ hubState: 'done', count: 0, resultDisposition: 'empty-complete', collectionOnly: true })
        && canSupplyTerminalBoardInput({ hubState: 'done', count: 0, resultDisposition: 'empty-complete' })
        && canSupplyTerminalBoardInput({ hubState: 'done', count: 0, resultDisposition: 'preference-filtered' })
        && !canSupplyTerminalBoardInput({ hubState: 'done', count: 0, resultDisposition: 'preference-filtered', collectionOnly: true })
        && canSupplyTerminalBoardInput({ hubState: 'done', count: 1 }),
      'only explicit terminal zero dispositions can replace stale results; legacy/recovery or collection-only zeroes cannot, while positive scored jobs remain mergeable');

      // The component-level transition clears the prior cascade only after the
      // user explicitly accepts its empty terminal input. Lock that wiring in
      // place without adding a heavyweight ReactFlow DOM harness.
      const boardSource = fs.readFileSync(path.resolve('src/nodes/JobBoardNode.jsx'), 'utf8');
      const doneStateSource = fs.readFileSync(path.resolve('src/nodes/jobboard/JobBoardDoneState.jsx'), 'utf8');
      const bugReportSource = fs.readFileSync(path.resolve('electron/ipc/bugReport.js'), 'utf8');
      const issueReporterSource = fs.readFileSync(path.resolve('src/hooks/useIssueReporter.js'), 'utf8');
      const jobsSnapshotSource = fs.readFileSync(path.resolve('electron/ipc/bugReport/jobsSnapshot.js'), 'utf8');
      const jobSearchSource = fs.readFileSync(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8');
      const jobsBackendSource = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
      assert(boardSource.includes('const completedModules = useMemo')
        && boardSource.includes('() => boardInputSignature(completedModules, connectedModules)')
        && boardSource.includes('const allConnectedModulesDone =')
        && boardSource.includes('staleReason(data.combineSignature, completedModules, connectedModules)')
        && boardSource.includes('if (nextStale) hideBoardChildren()')
        && boardSource.includes('function isExplicitlyUnscoredModule(data)')
        && boardSource.includes('data?.aiSkipped || data?.collectionOnly || data?.testMode')
        && boardSource.includes("m.resultDisposition === 'empty-complete' || m.resultDisposition === 'preference-filtered'")
        && boardSource.includes('m.hasPositiveResults || m.isAuthoritativeEmpty')
        && boardSource.includes("n.data?.resultDisposition || ''")
        && boardSource.includes('emptyReplacementPrompt')
        && boardSource.includes('<ConfirmDialog')
        && boardSource.includes('empty replacement confirmation requested')
        && boardSource.includes('empty replacement cancelled')
        && boardSource.includes('confirmed empty replacement')
        && boardSource.includes('const liveBlockReason = emptyReplacementIneligibilityReason({')
        && boardSource.includes('if (liveBlockReason)')
        && boardSource.includes("new CustomEvent('canvas-take-snapshot')")
        && boardSource.includes('const cancelled = epoch.start()')
        && boardSource.includes('if (cancelled() || !getNode(id))')
        // Cause-labelled: `cancelNodeTask(id, 'board-cleared' | 'board-unmounted')`,
        // so an aborted run's bug report names why it stopped.
        && boardSource.includes('cancelNodeTask?.(id,')
        && boardSource.includes('combine cancelled before spawn'),
      'board tracks scored terminal zero-result modules, excludes explicitly unscored completions, and confirms an undoable empty replacement before deleting stale children');
      const clearStart = boardSource.indexOf('const handleClear = useCallback');
      const clearEnd = boardSource.indexOf('const completeManualAiRun = useCallback', clearStart);
      const handleClearSource = boardSource.slice(clearStart, clearEnd);
      const emptyReplacementStart = boardSource.indexOf('const confirmEmptyReplacement = useCallback');
      const emptyReplacementEnd = boardSource.indexOf('const cleanupBoard = useCallback', emptyReplacementStart);
      const successfulCombineStart = boardSource.indexOf('updateGlobal(id, {', boardSource.indexOf('const handleCombine = useCallback'));
      const successfulCombineEnd = boardSource.indexOf('// A scored job becomes', successfulCombineStart);
      assert(clearStart >= 0 && clearEnd > clearStart
        && handleClearSource.includes('const currentData = getNode(id)?.data || data')
        && handleClearSource.includes('priorCombineSignature')
        && handleClearSource.includes('priorResultCount')
        && handleClearSource.includes('normalizeBoardResultCount(currentData.resultCount)')
        && handleClearSource.includes('priorSourceRuns')
        && boardSource.includes("boundedCombinedSourceRuns(currentData.combineSourceRuns)")
        && handleClearSource.includes('combineSourceRuns: null')
        && handleClearSource.includes('clearProvenance')
        && handleClearSource.indexOf("new CustomEvent('canvas-take-snapshot')") < handleClearSource.indexOf('const clearProvenance =')
        && boardSource.slice(emptyReplacementStart, emptyReplacementEnd).includes('combineSourceRuns: boundedCombinedSourceRuns(liveInputs.completed)')
        && boardSource.slice(emptyReplacementStart, emptyReplacementEnd).includes('clearProvenance: null')
        && boardSource.slice(successfulCombineStart, successfulCombineEnd).includes('combineSourceRuns: sourceRunsAtCombine')
        && boardSource.slice(successfulCombineStart, successfulCombineEnd).includes('clearProvenance: null'),
      'manual Clear stores bounded exact source-run provenance only after its undo snapshot, while confirmed empty replacement and a successful Combine refresh it and retire the clear receipt');
      const persistedRun = { sourceHubId: 'jobhub-1', runId: 'run-1' };
      assert(JSON.stringify(boundedCombinedSourceRuns([persistedRun])) === JSON.stringify([persistedRun])
        && JSON.stringify(boundedCombinedSourceRuns([{ id: 'jobhub-1', runId: 'run-1' }])) === JSON.stringify([persistedRun])
        && boundedCombinedSourceRuns([{ sourceHubId: true, runId: 'run-1' }]).length === 0
        && boundedCombinedSourceRuns([{ sourceHubId: '', id: 'jobhub-1', runId: 'run-1' }]).length === 0
        && boundedCombinedSourceRuns([{ sourceHubId: 'jobhub-1', id: 'other-hub', runId: 'run-1' }]).length === 0,
      'manual Clear retains the exact persisted sourceHubId/runId pair while combines accept only strict live module identifiers');
      assert(normalizeBoardResultCount(0) === 0
        && normalizeBoardResultCount(16) === 16
        && [false, true, '', '0', '16', null, undefined, -1, 1.5, Infinity, Number.MAX_VALUE]
          .every(value => normalizeBoardResultCount(value) === null),
      'manual Clear preserves only exact safe nonnegative integer result counts; false and empty strings cannot become provenance-like zeroes');
      assert(issueReporterSource.includes("typeof entry?.sourceHubId === 'string'")
        && issueReporterSource.includes("typeof entry?.runId === 'string'")
        && issueReporterSource.includes('Number.isSafeInteger(rawClear.clearedAt)')
        && issueReporterSource.includes('new Date(rawClear.clearedAt).getTime()')
        && bugReportSource.includes("typeof entry?.sourceHubId === 'string'")
        && bugReportSource.includes("typeof entry?.runId === 'string'")
        && bugReportSource.includes('Number.isSafeInteger(rawClear.clearedAt)')
        && bugReportSource.includes('new Date(rawClear.clearedAt).getTime()')
        && jobsSnapshotSource.includes("typeof entry?.sourceHubId === 'string'")
        && jobsSnapshotSource.includes("typeof value === 'string' ? value.trim() : ''")
        && jobsSnapshotSource.includes('Number.isSafeInteger(rawClearedAt)')
        && jobsSnapshotSource.includes('new Date(rawClearedAt).getTime()'),
      'exact-run clear provenance rejects coerced ID/token types and zero/out-of-Date-range timestamps at the renderer, direct report fallback, and final report boundaries');
      assert(doneStateSource.includes('canReplaceWithEmpty') && doneStateSource.includes('Clear stale results') && doneStateSource.includes('Inputs changed'),
        'stale zero-result boards expose a truthful action rather than a dead Re-combine button');
      assert(jobSearchSource.includes("resultDisposition = 'scored'")
        && (jobSearchSource.match(/resultDisposition: 'empty-complete'/g) || []).length >= 2
        && jobSearchSource.includes("resultDisposition: 'collection-only'")
        && jobSearchSource.includes("resultDisposition: 'preference-filtered'")
        && jobSearchSource.includes("resultDisposition: 'incomplete'")
        && jobSearchSource.includes('resultDisposition: null'),
      'Job Search explicitly stamps scored, authoritative-empty, preference-filtered, collection-only, and incomplete outcomes and clears provenance for a new/reset run');
      assert(boardSource.includes('result card${emptyReplacementPrompt.resultCardCount === 1')
        && boardSource.includes('group${emptyReplacementPrompt.resultGroupCount === 1')
        && boardSource.includes('Undo restores them.')
        && boardSource.includes('Keep stale results'),
      'the empty replacement confirmation names its owned card/group impact, defaults to keeping stale children, and advertises Undo recovery');
      assert(bugReportSource.includes('staleReason:') && bugReportSource.includes('combineSignature:'),
        'FULL node diagnostics preserve board stale reason and signature evidence');
      const terminalZeroStart = jobSearchSource.indexOf('if (foundJobs.length === 0)');
      const terminalZeroEnd = jobSearchSource.indexOf('return { shouldScore: true, warnings };', terminalZeroStart);
      assert(terminalZeroStart >= 0 && terminalZeroEnd > terminalZeroStart
        && /jobCount:\s*0/.test(jobSearchSource.slice(terminalZeroStart, terminalZeroEnd))
        && jobSearchSource.slice(terminalZeroStart, terminalZeroEnd).includes('gatheredCount: gatheredCount ?? 0')
        && jobsBackendSource.includes('rawCount: relevanceFunnel.raw'),
      'terminal empty job searches clear stale jobCount while preserving the provider-level gathered funnel');
      assert(jobSearchSource.includes("runOrigin: 'rerun-button'")
        && jobSearchSource.includes('Re-run button clicked; career input=')
        && jobsBackendSource.includes('runOrigin: normalizedRunOrigin')
        && jobsBackendSource.includes('profileInputMode: normalizedProfileInputMode'),
      'Re-run Search carries explicit button and career-input provenance into main-process diagnostics');
      return { reason: staleReason(previous, completedZero), zeroSignature: combineSignature(completedZero) };
    },
  },
{
    name: 'computeJobTreeView: filter removes non-matching cards + empty branches (not dim)',
    run: () => {
      // Two bands: A (Excellent, scores 90/88) and B (Long shot, score 20).
      const tree = () => ([
        { id: 'hub', type: 'jobboard', position: { x: 0, y: 0 }, data: {} },
        { id: 'A',   type: 'jobgroup', hidden: false, position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'likelihood', label: 'Excellent', childIds: ['A-S'], expanded: false } },
        { id: 'A-S', type: 'jobgroup', hidden: true,  position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'salary', label: '$100k+', childIds: ['A-R'], expanded: false } },
        { id: 'A-R', type: 'jobgroup', hidden: true,  position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'role', label: 'Eng', childIds: ['a1', 'a2'], expanded: false, visibleCount: 10 } },
        { id: 'a1',  type: 'jobcard',  hidden: true,  position: { x: 0, y: 0 }, data: { hubId: 'hub', matchScore: 90, source: 'lever' } },
        { id: 'a2',  type: 'jobcard',  hidden: true,  position: { x: 0, y: 0 }, data: { hubId: 'hub', matchScore: 88, source: 'dice' } },
        { id: 'B',   type: 'jobgroup', hidden: false, position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'likelihood', label: 'Long shot', childIds: ['B-S'], expanded: false } },
        { id: 'B-S', type: 'jobgroup', hidden: true,  position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'salary', label: 'Under', childIds: ['B-R'], expanded: false } },
        { id: 'B-R', type: 'jobgroup', hidden: true,  position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'role', label: 'Eng', childIds: ['b1'], expanded: false, visibleCount: 10 } },
        { id: 'b1',  type: 'jobcard',  hidden: true,  position: { x: 0, y: 0 }, data: { hubId: 'hub', matchScore: 20, source: 'indeed' } },
      ]);
      const hiddenOf = (out, id) => !!out.find(n => n.id === id)?.hidden;

      // No filter on the spawned/collapsed tree → no change (same ref).
      const base = tree();
      assert(computeJobTreeView(base, 'hub', {}) === base, 'no-filter on collapsed tree is a same-ref no-op');

      // Filter ≥85 (collapsed): empty band B removed; matching band A stays visible.
      const f85 = computeJobTreeView(tree(), 'hub', { scoreThreshold: 85 });
      assert(hiddenOf(f85, 'A') === false, 'filter: band with matches stays visible');
      assert(hiddenOf(f85, 'B') === true, 'filter: empty band REMOVED (hidden), not dimmed');

      // Expand A fully under ≥89 → only a1 (90) shows; a2 (88) removed; branch stays.
      const expanded = tree().map(n =>
        ['A', 'A-S', 'A-R'].includes(n.id) ? { ...n, data: { ...n.data, expanded: true } } : n);
      const f89 = computeJobTreeView(expanded, 'hub', { scoreThreshold: 89 });
      assert(hiddenOf(f89, 'a1') === false, 'filter+expand: matching card visible');
      assert(hiddenOf(f89, 'a2') === true, 'filter+expand: non-matching card REMOVED');
      assert(hiddenOf(f89, 'A-R') === false && hiddenOf(f89, 'B') === true, 'filter+expand: branch with a match kept, empty band gone');

      // Filter above every score → whole tree removed.
      const f99 = computeJobTreeView(tree(), 'hub', { scoreThreshold: 99 });
      assert(['A', 'A-S', 'A-R', 'a1', 'a2', 'B', 'b1'].every(id => hiddenOf(f99, id)), 'filter above max removes everything');

      // Source filter: only dice → a2 stays, a1 (lever) + b1 (indeed) removed.
      const expandedSrc = computeJobTreeView(expanded, 'hub', { sourceFilter: 'dice' });
      assert(hiddenOf(expandedSrc, 'a2') === false && hiddenOf(expandedSrc, 'a1') === true, 'source filter keeps only matching source');
      return { ok: true };
    },
  },
{
    name: 'computeJobTreeView: legacy flat board (no jobgroups) — cards survive filter/restore',
    run: () => {
      // Old saved boards can contain jobcards wired straight to the hub, with no
      // groups. Regression: previously computeJobTreeView only seeded `visible` by walking
      // jobgroups, so a flat board had an empty visible set and ALL cards were hidden
      // on any filter/restore (blank board with a non-zero header count).
      const tree = () => ([
        { id: 'hub', type: 'jobboard', position: { x: 0, y: 0 }, data: {} },
        { id: 'c1', type: 'jobcard', hidden: false, position: { x: 0, y: 0 }, data: { hubId: 'hub', matchScore: 90, source: 'lever' } },
        { id: 'c2', type: 'jobcard', hidden: false, position: { x: 0, y: 0 }, data: { hubId: 'hub', matchScore: 60, source: 'dice' } },
      ]);
      const hiddenOf = (out, id) => !!out.find(n => n.id === id)?.hidden;
      const f0 = computeJobTreeView(tree(), 'hub', {});
      assert(hiddenOf(f0, 'c1') === false && hiddenOf(f0, 'c2') === false, 'flat: no-filter keeps all cards visible');
      const fLow = computeJobTreeView(tree(), 'hub', { scoreThreshold: 50 });
      assert(hiddenOf(fLow, 'c1') === false && hiddenOf(fLow, 'c2') === false, 'flat: threshold below all keeps both');
      const fMid = computeJobTreeView(tree(), 'hub', { scoreThreshold: 80 });
      assert(hiddenOf(fMid, 'c1') === false && hiddenOf(fMid, 'c2') === true, 'flat: threshold removes only sub-threshold card');
      const fHigh = computeJobTreeView(tree(), 'hub', { scoreThreshold: 95 });
      assert(hiddenOf(fHigh, 'c1') === true && hiddenOf(fHigh, 'c2') === true, 'flat: threshold above all hides both');
      const fSrc = computeJobTreeView(tree(), 'hub', { sourceFilter: 'dice' });
      assert(hiddenOf(fSrc, 'c2') === false && hiddenOf(fSrc, 'c1') === true, 'flat: source filter keeps only matching source');
      return { ok: true };
    },
  },
{
    name: 'Job tree first card measurement reflows only when it exceeds its reserved row',
    run: () => {
      // A first measurement is normally skipped to avoid one complete tree
      // layout per initially mounted card. It cannot be skipped when the card
      // is taller than the 280px slot used while it was still unmeasured: that
      // is the opening-an-upper-list-over-an-open-lower-list regression.
      assert(!shouldReflowMeasuredJobCard({ visible: false, previousMeasuredHeight: null, measuredHeight: 884 })
        && !shouldReflowMeasuredJobCard({ visible: true, previousMeasuredHeight: null, measuredHeight: null })
        && !shouldReflowMeasuredJobCard({ visible: true, previousMeasuredHeight: null, measuredHeight: 280 })
        && !shouldReflowMeasuredJobCard({ visible: true, previousMeasuredHeight: 884, measuredHeight: 884 }),
      'hidden, invalid, reserved-height, and unchanged measurements do not reflow');
      assert(shouldReflowMeasuredJobCard({ visible: true, previousMeasuredHeight: null, measuredHeight: 884 })
        && shouldReflowMeasuredJobCard({ visible: true, previousMeasuredHeight: 884, measuredHeight: 280 }),
      'a first tall measurement and every later visible change reflow');

      const oneCardTree = (height) => [
        { id: 'hub', type: 'jobboard', position: { x: 0, y: 0 }, data: {} },
        { id: 'upper', type: 'jobgroup', hidden: false, position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'likelihood', childIds: ['role'], expanded: true } },
        { id: 'role', type: 'jobgroup', hidden: false, position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'role', childIds: ['top-1'], expanded: true, visibleCount: 10 } },
        { id: 'top-1', type: 'jobcard', hidden: false, position: { x: 0, y: 0 }, ...(Number.isFinite(height) ? { measured: { width: 280, height } } : {}), data: { hubId: 'hub', matchScore: 90, source: 'lever' } },
        { id: 'lower', type: 'jobgroup', hidden: false, position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'likelihood', childIds: ['lower-card'], expanded: false } },
        { id: 'lower-card', type: 'jobcard', hidden: true, position: { x: 0, y: 0 }, data: { hubId: 'hub', matchScore: 80, source: 'lever' } },
      ];
      const twoCardTree = (heights = []) => [
        { id: 'hub', type: 'jobboard', position: { x: 0, y: 0 }, data: {} },
        { id: 'upper', type: 'jobgroup', hidden: false, position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'likelihood', childIds: ['role'], expanded: true } },
        { id: 'role', type: 'jobgroup', hidden: false, position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'role', childIds: ['top-1', 'top-2'], expanded: true, visibleCount: 10 } },
        { id: 'top-1', type: 'jobcard', hidden: false, position: { x: 0, y: 0 }, ...(Number.isFinite(heights[0]) ? { measured: { width: 280, height: heights[0] } } : {}), data: { hubId: 'hub', matchScore: 90, source: 'lever' } },
        { id: 'top-2', type: 'jobcard', hidden: false, position: { x: 0, y: 0 }, ...(Number.isFinite(heights[1]) ? { measured: { width: 280, height: heights[1] } } : {}), data: { hubId: 'hub', matchScore: 89, source: 'lever' } },
        { id: 'lower', type: 'jobgroup', hidden: false, position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'likelihood', childIds: ['lower-card'], expanded: false } },
        { id: 'lower-card', type: 'jobcard', hidden: true, position: { x: 0, y: 0 }, data: { hubId: 'hub', matchScore: 80, source: 'lever' } },
      ];
      const initial = computeJobTreeView(oneCardTree(), 'hub', {}, COL_X, true);
      const initialLowerY = initial.find(n => n.id === 'lower')?.position?.y;
      const firstTall = computeJobTreeView(oneCardTree(884), 'hub', {}, COL_X, true);
      const firstTallLowerY = firstTall.find(n => n.id === 'lower')?.position?.y;
      const bothTall = computeJobTreeView(twoCardTree([884, 400]), 'hub', {}, COL_X, true);
      const bothTallLowerY = bothTall.find(n => n.id === 'lower')?.position?.y;
      assert(initialLowerY === 280
        && firstTallLowerY === 924
        && bothTallLowerY === 1_364,
      `opening geometry reserves 280px/card, then uses measured height + 40px gap (got ${initialLowerY} → ${firstTallLowerY} → ${bothTallLowerY})`);
      return { initialLowerY, firstTallLowerY, bothTallLowerY };
    },
  },
{
    name: 'computeJobTreeView: forced measured-card reflow tightens a collapse/re-expand stale height without initial churn',
    run: () => {
      // A card's reasoning disclosure is local component state. Collapsing its
      // role unmounts it; when re-expanded, it resets closed even though React
      // Flow can still hold the old expanded 308px measurement until its next
      // ResizeObserver pass reports 210px. The old fast path skipped layout when
      // visibility was unchanged, leaving the next root positioned for 308px.
      const tree = (height) => [
        { id: 'hub', type: 'jobboard', position: { x: 0, y: 0 }, data: {} },
        { id: 'A', type: 'jobgroup', hidden: false, position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'likelihood', childIds: ['R'], expanded: true } },
        { id: 'R', type: 'jobgroup', hidden: false, position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'role', childIds: ['card'], expanded: true, visibleCount: 10 } },
        { id: 'card', type: 'jobcard', hidden: false, position: { x: 0, y: 0 }, measured: { width: 280, height }, data: { hubId: 'hub', matchScore: 90, source: 'lever' } },
        { id: 'B', type: 'jobgroup', hidden: false, position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'likelihood', childIds: ['bcard'], expanded: false } },
        { id: 'bcard', type: 'jobcard', hidden: true, position: { x: 0, y: 0 }, data: { hubId: 'hub', matchScore: 80, source: 'lever' } },
      ];
      const stale = computeJobTreeView(tree(308), 'hub', {}, COL_X, true);
      const staleB = stale.find(n => n.id === 'B')?.position?.y;
      const tightened = computeJobTreeView(
        stale.map(n => n.id === 'card' ? { ...n, measured: { ...n.measured, height: 210 } } : n),
        'hub', {}, COL_X, true,
      );
      const tightB = tightened.find(n => n.id === 'B')?.position?.y;
      assert(staleB === 348 && tightB === 280,
        `measured reflow: downstream root must tighten from 348 to 280 after 308→210 (got ${staleB}→${tightB})`);
      // The ordinary path preserves its no-op fast path for a freshly measured
      // cascade, so initial N-card measurements don't enqueue reflows.
      const initial = tree(210);
      assert(computeJobTreeView(initial, 'hub', {}) === initial,
        'measured reflow: ordinary initial tree remains a same-ref no-op');
      return { staleB, tightB };
    },
  },
{
    name: 'Job tree layout positions',
    run: () => {
      // Windowing is owned by `hidden` (computeJobTreeView): the layout walks
      // every child and skips hidden ones — job-2 is the beyond-window card.
      const nodes = [
        { id: 'hub', type: 'jobhub', position: { x: 10, y: 20 }, data: {} },
        { id: 'L', type: 'jobgroup', position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'likelihood', childIds: ['S'], expanded: true } },
        { id: 'S', type: 'jobgroup', position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'salary', childIds: ['R'], expanded: true } },
        { id: 'R', type: 'jobgroup', position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'role', childIds: ['job-1', 'job-2'], expanded: true, visibleCount: 1 } },
        { id: 'job-1', type: 'jobcard', position: { x: 0, y: 0 }, data: { hubId: 'hub' } },
        { id: 'job-2', type: 'jobcard', hidden: true, position: { x: 0, y: 0 }, data: { hubId: 'hub' } },
      ];
      const positions = computeLayoutPositions(nodes, 'hub', COL_X, { x: 10, y: 20 });
      assert(positions.L?.x === 10 + COL_X.likelihood && positions.L?.y === 20, 'layout: likelihood position mismatch');
      assert(positions.S?.x === 10 + COL_X.salary && positions.S?.y === 20, 'layout: salary position mismatch');
      assert(positions.R?.x === 10 + COL_X.role && positions.R?.y === 20, 'layout: role position mismatch');
      assert(positions['job-1']?.x === 10 + COL_X.job && positions['job-1']?.y === 20, 'layout: visible job position mismatch');
      assert(!positions['job-2'], 'layout: hidden card takes no space and gets no position');
      return positions;
    },
  },
{
    name: 'Application: résumé document scaffold',
    run: () => {
      // buildResumeDocument now INLINES the design-system CSS into one <style>
      // block (design doc §5.2) instead of emitting <link> tags pointing at
      // files copied next to the HTML — that whole temp-dir-of-siblings setup
      // is exactly what HTML-first retires, so the doc must be openable with
      // zero sibling assets.
      const doc = buildResumeDocument({ resumeMainHtml: '<main class="page" data-print="ink-only" data-mono data-page="a4" data-density="compact"><h1 class="name">Jane</h1></main>' });
      assert(/^<!doctype html>/i.test(doc.trim()), 'resume doc: missing doctype');
      assert(!doc.includes('<link rel="stylesheet"'), 'resume doc: design CSS must stay inline in the single-file workspace');
      assert((doc.match(/<style>/g) || []).length === 1, 'resume doc: exactly one inlined <style> block');
      // Content proof the two design-system files were actually inlined, not
      // just an empty <style> tag — .resume-header/.name come from resume.css,
      // --ff-display from colors_and_type.css.
      assert(doc.includes('.resume-header') && doc.includes('.name'), 'resume doc: resume.css was not inlined');
      assert(doc.includes('--ff-display'), 'resume doc: colors_and_type.css was not inlined');
      assert(doc.includes('data-print="ink-only"') && doc.includes('Jane'), 'resume doc: lost the <main> block');
      assert(doc.includes('<div class="ic-page-stage"><main class="page"')
        && doc.includes('<div class="ic-page-guides" aria-hidden="true" data-ic-page-guides></div>'),
      'resume doc: each document surface is wrapped in screen-only page-guide chrome');
      assert(doc.includes('window.icPageGuidesRecompute = scheduleRecompute')
        && doc.includes('.ic-page-guides { display: none !important; }'),
      'resume doc: page guides recompute on screen and are excluded from print');
      // The screen guide models Sync's isolated ATS-safe PDF render, not the
      // editable page's web-font metrics. Keep the exact shared token values
      // in the emitted clone so a one-page Sync PDF cannot show a false Page 2
      // seam in the workspace preview.
      assert(doc.includes('var PAGE_GUIDE_FONT_TOKENS = {"--ff-display":"Georgia, \\"Times New Roman\\", serif","--ff-body":"Arial, \\"Helvetica Neue\\", sans-serif","--ff-mono":"Menlo, Consolas, \\"Courier New\\", monospace"};')
        && doc.includes('clone.style.setProperty(property, PAGE_GUIDE_FONT_TOKENS[property]);')
        && doc.includes("clone.style.setProperty('font-family', 'var(--ff-body)');"),
      'resume doc: page-guide clone must use the shared ATS-safe PDF font tokens and body inheritance');
      const renderedMain = doc.split('</style>').pop().match(/<main\b[^>]*>/i)?.[0] || '';
      assert(!/\sdata-(?:print|mono|page|density)\b/i.test(renderedMain), 'resume doc: root variants must not be shadowed by model-level main attributes');
      // A model that mistakenly returns a full fenced document is normalized to
      // one résumé <main> plus the application workspace's cover-letter panel.
      // Counted only AFTER the inlined
      // <style> block — colors_and_type.css's own comments literally contain
      // the text "<main class=\"page\" …>" as documentation of where a variant
      // attribute may be placed, which would otherwise inflate this count now
      // that the CSS lives in the same document (see the cover-letter test's
      // `body` split for the same hazard).
      const fenced = buildResumeDocument({ resumeMainHtml: '```html\n<html><body><main class="page">X</main></body></html>\n```' });
      const fencedBody = fenced.split('</style>').pop();
      const mainCount = (fencedBody.match(/<main/gi) || []).length;
      assert(mainCount === 2 && fencedBody.includes('>X</main>'), 'resume doc: should extract one résumé main from a fenced full doc and add one cover panel');
      return { ok: true };
    },
  },
{
    name: 'Application: variants are read from the document root and selected by the host',
    run: () => {
      assert(extractVariantAttrs('<html data-print="ink-only" data-mono data-page="a4"><body><main class="page"></main></body></html>') === 'data-print="ink-only" data-mono data-page="a4"', 'root variants are preserved');
      assert(extractVariantAttrs('<main class="page" data-print="ink-only" data-mono data-page="a4"></main>') === 'data-print="dual-pdf"', 'main-level variants are ignored');
      assert(applicationVariantAttrsForJob({ company: 'Google', location: 'Mountain View, CA' }) === 'data-print="ink-only"', 'big-co host classification selects ink-only');
      assert(applicationVariantAttrsForJob({ company: 'Accenture', location: 'Toronto, Canada' }) === 'data-print="ink-only" data-mono data-page="a4"', 'conservative non-US host classification composes ink-only, mono, and A4');
      assert(applicationVariantAttrsForJob({ company: 'Linear', location: 'Remote (US)' }) === 'data-print="dual-pdf"', 'design-conscious recipients retain the dual-pdf default');
      // isDualMode gates the OCG cream post-process.
      assert(isDualMode('data-print="dual-pdf"') === true, 'isDualMode: dual-pdf → true');
      assert(isDualMode('data-print="ink-only" data-mono') === false, 'isDualMode: ink-only → false');
      return { ok: true };
    },
  },
{
    // A BUILT document carries its variant on <html> and has it stripped off
    // <main> (stripMainVariantAttrs), so nothing usable is left on the tag the
    // model originally wrote it to. Worse, the design-system CSS this builder
    // inlines documents its own variants with literal `<main class="page"
    // data-print="…">` examples inside CSS COMMENTS — so a scan for the first
    // `<main …>` in a built document lands on a decoy from a stylesheet
    // comment, not on the résumé at all. applicationSync.js re-reads exactly
    // such a document to decide whether to apply the OCG cream layer; reading
    // anything but the root resolved every saved application to the dual-pdf
    // default and stacked cream behind an ink-only page's own opaque white
    // fill, shipping a résumé that matched neither variant.
    name: 'Application: variant attrs are read from a built document’s <html> root, not a <main> decoy',
    run: () => {
      const builtDoc = (attrs) => buildResumeDocument({
        resumeMainHtml: '<main class="page" data-print="ink-only"><h1 class="name">Jane</h1></main>',
        variantAttrs: attrs || 'data-print="dual-pdf"',
        docId: 'variant-roundtrip',
      });
      const resumePanelMain = (doc) => /<section[^>]*data-ic-document-panel="resume"[^>]*>\s*(?:<div class="ic-page-stage">\s*)?(<main\b[^>]*>)/i.exec(doc)?.[1] || '';

      for (const [attrs, expected] of [
        ['data-print="ink-only"', 'data-print="ink-only"'],
        ['data-print="ink-only" data-mono data-page="a4"', 'data-print="ink-only" data-mono data-page="a4"'],
        ['data-print="dual-pdf" data-density="compact"', 'data-print="dual-pdf" data-density="compact"'],
        ['', 'data-print="dual-pdf"'],
      ]) {
        const doc = builtDoc(attrs);
        assert(doc.includes(`<html lang="en" ${expected}>`), `built document must hoist "${expected}" onto <html>`);
        const panelMain = resumePanelMain(doc);
        assert(panelMain && !/\sdata-(?:print|mono|page|density)/i.test(panelMain), `built document must strip variant attrs off the résumé <main> (got ${panelMain})`);
        // The round trip: what the builder wrote is what a re-read resolves.
        assert(extractVariantAttrs(doc) === expected, `re-reading a built document must yield "${expected}", not the dual-pdf default`);
      }
      // The OCG gate — the actual consumer, and the thing that was inverted.
      assert(isDualMode(extractVariantAttrs(builtDoc('data-print="ink-only"'))) === false, 'a saved ink-only application must NOT be re-read as dual (no OCG cream layer)');
      assert(isDualMode(extractVariantAttrs(builtDoc('data-print="dual-pdf"'))) === true, 'a saved dual-pdf application must still be re-read as dual');

      // The cover letter is a separate built document on the same rule.
      const coverDoc = buildCoverLetterDocument({ letter: { salutation: 'Dear team,', paragraphs: ['Hi.'] }, variantAttrs: 'data-print="ink-only" data-mono', docId: 'variant-cover' });
      assert(extractVariantAttrs(coverDoc) === 'data-print="ink-only" data-mono', 'cover letter: re-reading a built document must yield its own variant');

      assert(extractVariantAttrs('<html lang="en"><body><main class="page" data-print="ink-only"></main></body></html>') === 'data-print="dual-pdf"', 'a variant-less root ignores a main-level variant');
      return { ok: true };
    },
  },
{
    name: 'Application: only root density is read and the host can force it after measurement',
    run: () => {
      assert(extractVariantAttrs('<html data-print="ink-only"><body><main class="page"></main></body></html>') === 'data-print="ink-only"', 'root without density stays at default density');
      assert(extractVariantAttrs('<html data-density="compact"><body><main class="page"></main></body></html>') === 'data-print="dual-pdf" data-density="compact"', 'root compact is preserved');
      assert(extractVariantAttrs('<main class="page" data-density="compact">') === 'data-print="dual-pdf"', 'model-level compact is ignored');
      // The fit loop forcing it ON, regardless of what the markup says.
      assert(extractVariantAttrs('<main class="page">', { density: 'compact' }) === 'data-print="dual-pdf" data-density="compact"', 'caller-forced density: compact wins over absent markup');
      assert(extractVariantAttrs('<html data-print="ink-only" data-mono data-page="a4">', { density: 'compact' }) === 'data-print="ink-only" data-mono data-page="a4" data-density="compact"', 'forced density composes with root print, mono, and A4');
      return { ok: true };
    },
  },
{
    name: 'Application: target page count defaults to one page regardless of job-title seniority',
    run: () => {
      const titles = [
        'Senior Software Engineer', 'Staff Software Engineer', 'Software Engineer, Staff+',
        'Senior Staff Engineer', 'Sr. Staff Engineer', 'Principal Engineer',
        'Director of Engineering', 'VP of Engineering', 'Head of Platform',
        'Chief Technology Officer', 'Chief of Staff', 'Chief-of-Staff', '', null,
      ];
      assert(titles.every(title => targetPageCountForJob(title) === 1),
        'every title defaults to one page; longer targets require an explicit override');
      return { checkedTitles: titles.length };
    },
  },
{
    name: 'Application: résumé fit measurement — underfill/overflow utilities behind the (now Local-AI-owned) fit loop',
    run: () => {
      // decideFitStep (the old pure render → page-count → fit decision function)
      // and its buildResumeUnderfillRevisionPrompt/buildResumeLengthRevisionPrompt/
      // buildResumeRoleEvidenceRevisionPrompt companions were removed as dead code
      // — the fit loop now lives entirely in the Local AI handoff routine. The
      // underfill/overflow MEASUREMENT utilities those functions consumed are
      // still live and still worth a direct unit test.
      const underfilledLayout = { contentHeightPx: 620, typeAreaHeightPx: 720 };
      assert(resumeIsMateriallyUnderfilled({ pageCount: 1, targetPageCount: 1, layout: underfilledLayout })
        && Math.round(resumeTypeAreaUtilization(underfilledLayout) * 100) === 86,
      'a materially underfilled one-page résumé is detected below the utilization minimum');
      const justUnderfilledLayout = { contentHeightPx: 895.641, typeAreaHeightPx: 1000 };
      assert(resumeIsMateriallyUnderfilled({ pageCount: 1, targetPageCount: 1, layout: justUnderfilledLayout })
        && formatUnderfilledTypeAreaUtilization(0.57) === '57%'
        && formatUnderfilledTypeAreaUtilization(resumeTypeAreaUtilization(justUnderfilledLayout)) === '89.56%'
        && formatUnderfilledTypeAreaUtilization(0.899999) === '89.99%',
      'a raw utilization below the 90% minimum is displayed below that threshold rather than rounded up to equality');
      assert(!resumeIsMateriallyUnderfilled({ pageCount: 1, targetPageCount: 2, layout: underfilledLayout }),
        'the utilization check never flags a multi-page target as underfilled');

      // Overflow magnitude must survive measurement. A clamp at 1 made every
      // overflowing résumé report exactly 100%, erasing the only size signal
      // the fit feedback and handoff trace carry. The underfill verdict is
      // defined strictly below 0.90, so an unbounded ratio cannot move it.
      const overflowingLayout = { contentHeightPx: 1240, typeAreaHeightPx: 917.76 };
      assert(resumeTypeAreaUtilization(overflowingLayout) > 1
        && Math.round(resumeTypeAreaUtilization(overflowingLayout) * 100) === 135
        && !resumeIsMateriallyUnderfilled({ pageCount: 2, targetPageCount: 1, layout: overflowingLayout })
        && !resumeIsMateriallyUnderfilled({ pageCount: 1, targetPageCount: 1, layout: overflowingLayout }),
      'type-area utilization reports overflow magnitude unclamped, and a value above 1 never reads as underfilled');

      // A screen-preview page grows when its text overflows; the measurable
      // type area must remain the fixed minimum paper height minus padding.
      const fixedTypeArea = fixedPageTypeAreaHeight(1056, 69.12, 69.12);
      assert(Math.abs(fixedTypeArea - 917.76) < 0.001
        && fixedPageTypeAreaHeight(1056, 69.12, 69.12) === fixedTypeArea,
      'type-area height remains fixed when an overflowing screen page expands');

      // The render window evaluates this exact string. It is assembled without
      // a template literal because an inline backtick previously made `.page`
      // a template-tag function call before either document could be measured.
      const pageMeasurement = pageTextMeasurementExpression();
      const emptyMeasurement = new Function('document', 'getComputedStyle', 'NodeFilter', `return ${pageMeasurement};`)(
        {
          querySelector: () => ({}),
          createTreeWalker: () => ({ nextNode: () => null }),
        },
        () => ({ minHeight: '1056px', paddingTop: '69.12px', paddingBottom: '69.12px' }),
        { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
      );
      assert(emptyMeasurement === null
        && !pageMeasurement.includes('`'),
      'the injected page-text probe is free of the template-literal delimiter that broke layout measurement');

      const convergence = createApplicationConvergenceTracker('draft-a');
      assert(convergence.assess('draft-b').accept && convergence.assess('draft-c').accept,
        'the shared convergence tracker accepts every novel candidate without a fixed limit');
      const unchanged = convergence.assess('draft-c');
      assert(!unchanged.accept && unchanged.diminishingReturns && /unchanged/.test(unchanged.reason),
        'returning the current document is the shared explicit diminishing-returns signal');
      const cycling = createApplicationConvergenceTracker('draft-a');
      assert(cycling.assess('draft-b').accept && !cycling.assess('draft-a').accept,
        'returning a previously measured version stops a non-improving cycle');

      return { ok: true };
    },
  },
{
    name: 'Application: cover letter builder (design-system native surface)',
    run: () => {
      // buildCoverLetterDocument takes { letter, variantAttrs, docId } — see
      // the résumé scaffold test above for why fields now nest under `letter`
      // and CSS is inlined rather than linked (design doc §5.2).
      const html = buildCoverLetterDocument({
        letter: {
          name: 'Jane Doe',
          tagline: 'Product Marketer',
          contact: ['Austin, TX', 'jane@x.com'],
          date: 'May 2026',
          recipient: 'Hiring Team\nAcme\nProduct Marketing',
          salutation: 'Dear Acme Team,',
          paragraphs: ['I love <Acme> & your work.', 'Second para.', '   '],
          closing: 'Sincerely,',
          signatureTitle: 'Senior Product Marketer · candidate',
        },
        variantAttrs: 'data-print="ink-only"',
      });
      // Uses the design system's NATIVE cover-letter surface, inlined — all
      // three stylesheets' content present in one <style> block, not a <link>
      // pointing at sibling files (HTML-first single-file workspace, §5.2).
      assert(!html.includes('<link rel="stylesheet"'), 'cover: must not link external stylesheets');
      assert((html.match(/<style>/g) || []).length === 1, 'cover: exactly one inlined <style> block');
      assert(html.includes('.letter-body') && html.includes('.resume-header') && html.includes('--ff-display'),
        'cover: colors_and_type.css + resume.css + cover-letter.css must all be inlined');
      // Inspect the document surface itself. Both the inlined CSS and the
      // runtime sanitizer intentionally name component classes, so whole-file
      // substring checks can no longer prove that an element was rendered.
      const body = html.split('</style>').pop();
      const dom = new JSDOM(html);
      const main = dom.window.document.querySelector('main.page');
      assert(main, 'cover: document main missing');
      // Native structure classes (cover-letter.html / cover-letter.css).
      for (const cls of ['resume-header letter-letterhead', 'letterhead-rule', 'letter-meta', 'letter-date', 'letter-body', 'salutation', 'letter-close', 'valediction', 'signature']) {
        assert(main.querySelector(`.${cls.replace(/\s+/g, '.')}`), `cover: missing native class "${cls}"`);
      }
      assert(main.textContent.includes('Jane Doe') && main.textContent.includes('Product Marketer'), 'cover: letterhead missing');
      assert(main.querySelector('time[datetime="2026-05"]')?.textContent === 'May 2026', 'cover: month-year date needs a machine-readable YYYY-MM datetime');
      assert(dom.window.document.documentElement.getAttribute('data-print') === 'ink-only', 'cover: variant not mirrored onto <html>');
      assert(!main.querySelector('.letter-recipient,.recipient-name,.recipient-line'), 'cover: recipient address block must not render');
      // signatureTitle renders under the signature.
      assert(main.querySelector('.signature-title')?.textContent === 'Senior Product Marketer · candidate', 'cover: signature-title missing');
      // User text is HTML-escaped (no markup injection from model output).
      assert(body.includes('I love &lt;Acme&gt; &amp; your work.'), 'cover: body not HTML-escaped');
      // Blank/whitespace paragraphs dropped; body uses bare <p> (every other
      // paragraph is classed, so this count isolates the body).
      const bodyParas = [...main.querySelectorAll('.letter-body > p')].filter(paragraph => !paragraph.className).length;
      assert(bodyParas === 2, `cover: expected 2 body paragraphs, got ${bodyParas}`);
      assert(main.querySelector('.contact')?.textContent.includes('jane@x.com') && main.querySelector('.contact .sep'), 'cover: contact line missing separators');
      // The cover-letter letterhead must reuse the résumé's semantic subtitle
      // structure, not flatten it into ordinary whitespace around the dot.
      const structuredHeader = buildCoverLetterDocument({
        letter: {
          name: 'Jane Doe',
          tagline: 'Product Marketer · B.S. Marketing, Example University',
          subtitleRole: 'Product Marketer',
          credential: 'B.S. Marketing, Example University',
        },
      });
      const structuredHeaderDom = new JSDOM(structuredHeader);
      const structuredSubtitle = [...structuredHeaderDom.window.document.querySelectorAll('.tagline > *')]
        .map(node => `${node.className}:${node.textContent}:${node.getAttribute('aria-hidden') || ''}`);
      assert(JSON.stringify(structuredSubtitle) === JSON.stringify([
        'subtitle-role:Product Marketer:',
        'sep:·:true',
        'credential:B.S. Marketing, Example University:',
      ]), 'cover: structured role and credential must preserve the résumé subtitle node sequence');
      structuredHeaderDom.window.close();
      const noCredentialHeader = buildCoverLetterDocument({
        letter: { name: 'Jane Doe', tagline: 'Product Marketer', subtitleRole: 'Product Marketer' },
      });
      const noCredentialHeaderDom = new JSDOM(noCredentialHeader);
      const noCredentialSubtitle = [...noCredentialHeaderDom.window.document.querySelectorAll('.tagline > *')]
        .map(node => `${node.className}:${node.textContent}:${node.getAttribute('aria-hidden') || ''}`);
      assert(JSON.stringify(noCredentialSubtitle) === JSON.stringify(['subtitle-role:Product Marketer:']),
        'cover: a role-only résumé header must not introduce a separator or credential');
      noCredentialHeaderDom.window.close();
      const partialHeader = buildCoverLetterDocument({
        letter: {
          name: 'Jane Doe', tagline: 'Product Marketer · B.S. Marketing, Example University',
          subtitleRole: 'Product Marketer',
        },
      });
      const partialHeaderDom = new JSDOM(partialHeader);
      const partialTagline = partialHeaderDom.window.document.querySelector('.tagline');
      assert(partialTagline?.textContent === 'Product Marketer · B.S. Marketing, Example University'
        && partialTagline.children.length === 0,
      'cover: partial structured header data falls back to the complete flattened tagline instead of dropping unclassed credential text');
      partialHeaderDom.window.close();
      // Sensible fallbacks when optional fields are omitted: salutation/closing
      // default; the recipient block is always absent; no signatureTitle → no signature-title.
      const bareFull = buildCoverLetterDocument({ letter: { name: 'X' } });
      const bareDom = new JSDOM(bareFull);
      const bareMain = bareDom.window.document.querySelector('main.page');
      assert(bareMain?.querySelector('.salutation')?.textContent === 'Dear Hiring Team,'
        && bareMain.querySelector('.valediction')?.textContent === 'Sincerely,', 'cover: missing salutation/closing fallback');
      assert(!bareMain.querySelector('.letter-recipient,.signature-title'), 'cover: recipient and optional signature-title blocks must be omitted');
      assert(bareMain.querySelector('p.signature'), 'cover: signature (name) always present');
      bareDom.window.close();
      dom.window.close();

      // Cover letters remain top-aligned at every length. Neither a standalone
      // document nor the combined workspace may retain the retired centring
      // variant or its host marker.
      const shortStandalone = buildCoverLetterDocument({
        letter: { name: 'X', paragraphs: ['Short note.'] },
        variantAttrs: 'data-print="dual-pdf"',
      });
      assert(!shortStandalone.includes('data-letter'), 'cover: short standalone letters must remain top-aligned');
      const shortWorkspace = buildResumeDocument({
        resumeMainHtml: '<main class="page"><h1 class="name">Résumé</h1></main>',
        variantAttrs: 'data-print="dual-pdf"',
        coverLetter: { name: 'X', paragraphs: ['Short note.'] },
      });
      assert(!shortWorkspace.includes('data-letter'), 'workspace: retired letter centring variant must be absent');
      assert(!shortWorkspace.includes('data-ic-letter-centered'), 'workspace: retired cover marker must be absent');
      return { ok: true };
    },
  },
{
    name: 'job pipeline report: XJOBAUDIT collapses per-job/per-location audit prose without touching funnel numbers, warnings, or per-source outcomes',
    run: () => {
      const telemetry = getJobsTelemetry();
      const scrapeTelemetry = getManualScraperTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search,
        resolves: telemetry.resolves, scoring: telemetry.scoring, bucketing: telemetry.bucketing,
      };
      const savedEvents = scrapeTelemetry.events;
      const store = tryGetStore();
      const savedCache = { ...getGlassdoorLocIdCache() };
      const priorCacheKeyCount = Object.keys(savedCache).length;

      Object.assign(telemetry, {
        nodeId: 'xjobaudit-diagnostics', windowId: null, resolves: {},
        search: {
          ts: Date.now(), queries: 1, raw: 1, deduped: 1, ageDropped: 0, historyDropped: 0, kept: 1,
          remoteRelevance: {
            remoteok: [{
              url: 'https://remoteok.com/l/xjobaudit-role', title: 'XJOBAUDIT Marker Role', company: 'Acme',
              matched: [{ query: 'XJOBAUDIT Marker Role', matchedTerms: ['xjobaudit'], requiredMatches: 1 }],
              tags: ['xjobaudit-tag'],
            }],
          },
        },
        scoring: {
          ts: Date.now(), input: 1, selectedForScoring: 1, cappedForBudget: 0, scored: 1,
          placeholders: 0, batches: 1, failedBatches: 0, providerCalls: 1,
          unscored: 0, models: ['gemini-test'],
          audit: {
            rows: [
              { batch: 1, title: 'XJOBAUDIT Scoring Row', company: 'Acme', location: 'Remote', source: 'remoteok', url: 'https://jobs/xjobaudit-scoring', score: 70, direction: 'Support', reason: 'XJOBAUDIT reason text.', descriptionFingerprint: 'xjobaudit' },
            ],
            omitted: 0,
            anomalies: [],
          },
        },
        bucketing: {
          ts: Date.now(), input: 1, roleCount: 1, placed: 1, missing: 0, duplicated: 0,
          bandSummary: [{ label: 'Limited hiring fit (0–79)', count: 1 }], salaryRangeLabels: ['$80k–$120k/yr'],
          // Deliberately a DIFFERENT title than the relevance/scoring/taxonomy
          // rows below: the Roles (third level) summary's bounded sample title
          // is a per-source OUTCOME, not per-job audit prose, so XJOBAUDIT must
          // NOT remove it — using the same string here would make that survival
          // indistinguishable from the marker-role leaking out of the (correctly
          // omitted) relevance audit.
          roleSummary: [{ name: 'Support', count: 1, sampleTitles: ['XJOBAUDIT Role-Summary Sample'] }],
          taxonomyRepairs: ['XJOBAUDIT repair note'],
          taxonomyAudit: [{ index: 0, title: 'XJOBAUDIT Taxonomy Row', source: 'remoteok', rawSalary: '$80k/yr', annualSalary: 80000, salaryRange: '$80k–$120k/yr', fitBand: 'Limited hiring fit (0–79)', role: 'Support' }],
          taxonomyAuditOmitted: 0, model: 'gemini-test',
        },
      });
      scrapeTelemetry.events = [];
      recordManualScraperTelemetry({
        phase: 'location-resolution-failed',
        sourceId: 'glassdoor',
        srcName: 'Glassdoor',
        queryIndex: 1,
        queryTotal: 1,
        location: 'XJOBAUDIT City',
        reason: 'test seed for XJOBAUDIT coverage',
        failureKind: 'no-match',
        attempts: 1,
      });
      saveGlassdoorLocId('xjobaudit city cache key', { locId: '999', locT: 'C', country: 'US' });
      const expectedCacheCount = priorCacheKeyCount + 1;

      try {
        const full = buildJobsPipelineSnapshot(new Set(['xjobaudit-diagnostics']), null, null);
        assert(full.includes('All-source role relevance audit (surviving jobs')
          && full.includes('XJOBAUDIT Marker Role')
          && full.includes('Scoring evidence (1/1 bounded row(s))')
          && full.includes('XJOBAUDIT Scoring Row')
          && full.includes('Taxonomy placement audit (raw salary')
          && full.includes('XJOBAUDIT Taxonomy Row')
          && full.includes('### Glassdoor Location Cache')
          && full.includes('xjobaudit city cache key'),
        'without XJOBAUDIT, all four per-job/per-location audit blocks render their full per-item detail');

        const collapsed = buildJobsPipelineSnapshot(new Set(['xjobaudit-diagnostics']), null, null, [], true);
        assert(!collapsed.includes('XJOBAUDIT Marker Role')
          && !collapsed.includes('XJOBAUDIT Scoring Row')
          && !collapsed.includes('XJOBAUDIT Taxonomy Row')
          && !collapsed.includes('xjobaudit city cache key'),
        'XJOBAUDIT removes every per-job/per-location audit detail line from all four blocks');
        assert((collapsed.match(/omitted by filter code — XJOBAUDIT/g) || []).length === 4,
          'XJOBAUDIT replaces each of the four bulky blocks with exactly one marker line (relevance, scoring, taxonomy, Glassdoor cache)');
        assert(collapsed.includes('All-source role relevance audit (1 row(s) across 1 source(s)) omitted')
          && collapsed.includes('Scoring evidence (1 bounded row(s)) omitted')
          && collapsed.includes('Taxonomy placement audit (1 job row(s)) omitted')
          && collapsed.includes(`${expectedCacheCount} cached location(s) omitted`),
        'XJOBAUDIT markers state an honest count of what was omitted, keeping the section-omission accounting truthful');
        assert(collapsed.includes('Found (raw): 1')
          && collapsed.includes('Input: 1 → scored: 1')
          && collapsed.includes('Batches: 1 (0 failed)')
          && collapsed.includes('Hiring-fit bands')
          && collapsed.includes('Limited hiring fit (0–79)')
          && collapsed.includes('Taxonomy validation repaired: XJOBAUDIT repair note')
          && collapsed.includes('Skipped `Glassdoor` for "XJOBAUDIT City" (no-match)')
          && collapsed.includes('XJOBAUDIT Role-Summary Sample'),
        'XJOBAUDIT keeps the funnel numbers, per-source outcomes (incl. the Roles third-level bounded sample), and warnings untouched — only the per-job/per-location audit prose is removed');
      } finally {
        Object.assign(telemetry, saved);
        scrapeTelemetry.events = savedEvents;
        if (store) store.set('jobs.glassdoorLocIds', savedCache);
      }
      return { ok: true };
    },
  },
  {
    // A Glassdoor panel 429 on page 11 disabled description enrichment for the
    // rest of the source: 19 more pages were walked, 275 of 336 in-window rows
    // came back with no description and were dropped by the evidence gate — and
    // the report still said `completed` with no flag anywhere. A detail block
    // never reaches stopReason (the WALK finished; only enrichment stopped), and
    // every warning render was gated on `count === 0`, so a source that returned
    // 897 rows carried its warning silently.
    name: 'Job diagnostics: a detail-enrichment block is reported even when the walk completed',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId,
        search: telemetry.search, resolves: telemetry.resolves,
      };
      Object.assign(telemetry, {
        nodeId: 'detail-block-diagnostics', windowId: null, resolves: {},
        search: {
          ts: Date.now(), queries: 1, raw: 897, deduped: 897, ageDropped: 556, historyDropped: 5, kept: 61,
          bySource: {
            glassdoor: {
              count: 897, pagesWalked: 30, stopReason: 'completed',
              warning: {
                code: 'description-rate-limited', severity: 'block',
                evidence: 'Glassdoor returned HTTP 429 while loading the right-side panel.',
              },
              detailBlock: {
                code: 'description-rate-limited', active: true, firstPage: 11,
                arms: 1, reprobes: 1, recovered: 0, skippedCards: 570,
              },
            },
          },
        },
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['detail-block-diagnostics']), null, null);
        assert(report.includes('walked 30 pages → stopped: completed')
          && report.includes('detail enrichment blocked by description-rate-limited from page 11')
          && report.includes('570 card(s) got no panel request')
          && report.includes('held back from scoring'),
        'a completed walk whose description enrichment was blocked says so on the same line, instead of reading as a clean run');
        assert(report.includes('1 cooldown re-probe(s), 0 recovered'),
          'the report states whether the cooldown re-probe recovered enrichment, so a stuck throttle is distinguishable from a transient one');
        assert(report.includes('returned results BUT flagged (partial success')
          && report.includes('glassdoor (description-rate-limited/block, 897 row(s) still returned)'),
        'a warning on a source that RETURNED rows is rendered — the zero-results gates used to hide exactly this case');
        return { ok: true };
      } finally {
        Object.assign(telemetry, saved);
      }
    },
  },

  // ── Silent browser-walk regression (bug report: "processing stuck") ─────────
  // A Glassdoor run sat at the `page-extract` phase for 28s with no telemetry,
  // no log line and no UI change, because the per-card description walk emits a
  // phase ONLY on failure. Healthy work and a wedged renderer were the same
  // observation. These pin the signals that now separate them.
  {
    name: 'activity beat records liveness and inherits the current source',
    run: () => {
      resetManualScraperTelemetry();
      recordManualScraperTelemetry({ phase: 'source-start', sourceId: 'glassdoor', srcName: 'Glassdoor' });
      setActivitySink(null);
      const beat = recordActivityBeat({ srcName: 'Glassdoor', count: 7, status: 'Opening result card 7/30', queryIndex: 1, queryTotal: 1 });
      assert(beat.sourceId === 'glassdoor', 'beat inherits sourceId from the last phase that named a source');
      assert(beat.count === 7, 'beat carries the running job count');
      const t = getManualScraperTelemetry();
      assert(t.beat && t.beat.status === 'Opening result card 7/30', 'telemetry exposes the beat');
      assert(Date.now() - t.beat.ts < 5_000, 'beat timestamp is fresh');
    },
  },
  {
    name: 'every distinct scrape step reaches the renderer; a same-status flood is throttled',
    run: () => {
      resetManualScraperTelemetry();
      recordManualScraperTelemetry({ phase: 'source-start', sourceId: 'glassdoor', srcName: 'Glassdoor' });
      const seen = [];
      setActivitySink(b => seen.push(b.status));
      try {
        for (let i = 1; i <= 5; i++) recordActivityBeat({ srcName: 'Glassdoor', count: i, status: `Opening result card ${i}/30` });
        assert(seen.length === 5, `each card step must reach the UI (got ${seen.length})`);
        const before = seen.length;
        for (let i = 0; i < 200; i++) recordActivityBeat({ srcName: 'Glassdoor', count: 30, status: 'Loading jobs… 30' });
        assert(seen.length - before === 1, `a repeated status must be throttled to one emit (got ${seen.length - before})`);
      } finally { setActivitySink(null); }
    },
  },
  {
    name: 'a stable activity key throttles dynamic overlay copy without hiding later beats',
    run: () => {
      resetManualScraperTelemetry();
      const originalNow = Date.now;
      let now = 1_000_000;
      const seen = [];
      Date.now = () => now;
      setActivitySink(b => seen.push(b));
      try {
        recordActivityBeat({ status: 'Loading jobs… 10', count: 10, activityKey: 'google-preload' });
        now += 20;
        recordActivityBeat({ status: 'Loading the full Google list — not selecting cards yet… 10', count: 10, activityKey: 'google-preload' });
        now += 20;
        recordActivityBeat({ status: 'Loading jobs… 20', count: 20, activityKey: 'google-preload' });
        assert(seen.length === 1, `dynamic copy sharing one activity key must coalesce inside 1s (got ${seen.length})`);
        assert(getManualScraperTelemetry().beat.status === 'Loading jobs… 20', 'local telemetry keeps the freshest overlay copy even when renderer IPC is coalesced');
        now += 1_000;
        recordActivityBeat({ status: 'Loading jobs… 30', count: 30, activityKey: 'google-preload' });
        assert(seen.length === 2 && seen[1].count === 30, 'the same activity key emits again after the one-second interval');
        now += 20;
        recordActivityBeat({ status: 'Extracting jobs…', activityKey: 'extracting' });
        assert(seen.length === 3, 'a new semantic activity key bypasses the ordinary cadence limiter');
      } finally {
        Date.now = originalNow;
        setActivitySink(null);
      }
    },
  },
  {
    name: 'an empty manual scrape clears its activity sink before returning',
    run: async () => {
      resetManualScraperTelemetry();
      const seen = [];
      await scrapeManualSources([], null, null, null, { onActivity: beat => seen.push(beat) });
      recordActivityBeat({ status: 'after empty scrape' });
      assert(seen.length === 0, 'an empty scrape must not leave its activity callback attached to a later beat');
      setActivitySink(null);
    },
  },
  {
    name: 'a terminal browser scrape labels its retained beat as historical, not stalled',
    run: async () => {
      resetManualScraperTelemetry();
      recordManualScraperTelemetry({ phase: 'source-start', sourceId: 'glassdoor', srcName: 'Glassdoor' });
      recordActivityBeat({ srcName: 'Glassdoor', status: 'Opening result card 1/30' });
      await scrapeManualSources([], null, null, null, { resetDiagnostics: false });
      const report = buildJobsPipelineSnapshot(new Set(['terminal-beat-diagnostics']), null, null);
      assert(report.includes('Historical final beat only'), 'a finished/idle scrape must describe its retained beat as historical');
      assert(!report.includes('a stale beat means it is genuinely stalled'), 'terminal beat age must never be presented as evidence of a hang');
    },
  },
  {
    name: 'clearing the activity sink stops renderer emits but keeps local beats',
    run: () => {
      resetManualScraperTelemetry();
      const seen = [];
      setActivitySink(b => seen.push(b));
      recordActivityBeat({ status: 'first' });
      setActivitySink(null);
      recordActivityBeat({ status: 'after-clear' });
      assert(seen.length === 1, 'a cleared sink must not receive further beats (stale-node safety)');
      assert(getManualScraperTelemetry().beat.status === 'after-clear', 'beats are still recorded locally for the bug report');
    },
  },
  {
    name: 'a sink that throws cannot break the scrape',
    run: () => {
      resetManualScraperTelemetry();
      setActivitySink(() => { throw new Error('renderer gone'); });
      try {
        recordActivityBeat({ status: 'still fine' });
        assert(getManualScraperTelemetry().beat.status === 'still fine', 'beat recorded despite a throwing sink');
      } finally { setActivitySink(null); }
    },
  },
  {
    name: 'run-origin phases survive eviction from the 30-slot recency ring',
    run: () => {
      resetManualScraperTelemetry();
      recordManualScraperTelemetry({ phase: 'source-start', sourceId: 'glassdoor', srcName: 'Glassdoor' });
      recordManualScraperTelemetry({ phase: 'query-start', sourceId: 'glassdoor', url: 'https://www.glassdoor.com/Job/jobs.htm' });
      recordManualScraperTelemetry({ phase: 'location-host-redirected', sourceId: 'glassdoor', intendedHost: 'www.glassdoor.com', landedHost: 'www.glassdoor.ca' });
      // Flood well past the ring size with ordinary per-job chatter.
      for (let i = 0; i < 60; i++) recordManualScraperTelemetry({ phase: 'desc-miss', sourceId: 'glassdoor', key: `job-${i}` });
      const t = getManualScraperTelemetry();
      assert(t.events.length === 30, 'recency ring stays bounded');
      assert(!t.events.some(e => e.phase === 'source-start'), 'precondition: origin rows DO age out of the recency ring');
      const originPhases = t.origins.map(e => e.phase);
      for (const phase of ['source-start', 'query-start', 'location-host-redirected']) {
        assert(originPhases.includes(phase), `${phase} must survive in the retained origin set`);
      }
      const redirect = t.origins.find(e => e.phase === 'location-host-redirected');
      assert(redirect.landedHost === 'www.glassdoor.ca', 'the geo-redirect evidence survives with its hosts intact');
    },
  },
  {
    name: 'paused state is exposed so a deliberate pause is not reported as a hang',
    run: () => {
      resetManualScraperTelemetry();
      const t = getManualScraperTelemetry();
      assert('paused' in t, 'paused must be exposed by the accessor (it was tracked but dropped)');
      assert(t.paused === false, 'a fresh run is not paused');
    },
  },
  {
    name: 'Glassdoor extractor absolutizes relative links against the landed host',
    run: () => {
      const doc = { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, title: '', body: { innerText: 'no jobs found' } };
      const run = (origin, hostname) => new Function('document', 'location', `return (${GLASSDOOR_EXTRACTOR.trim()})`)(doc, { origin, hostname });
      // Guard the zero-result contract on both hosts (the branch that reads gdOrigin
      // is only reachable with cards, but a broken reference would throw here).
      assert(Array.isArray(run('https://www.glassdoor.ca', 'www.glassdoor.ca')), 'extractor runs on the .ca host');
      assert(Array.isArray(run('https://www.glassdoor.com', 'www.glassdoor.com')), 'extractor runs on the .com host');
      assert(!/'https:\/\/www\.glassdoor\.com' \+ href/.test(GLASSDOOR_EXTRACTOR), 'card hrefs must not be hardcoded to .com');
      assert(GLASSDOOR_EXTRACTOR.includes('gdOrigin'), 'extractor resolves an origin from the landed host');
    },
  },

  {
    name: 'STALL filter code scopes a "processing stuck" report without dropping its evidence',
    run: () => {
      const noise = [];
      for (let i = 0; i < 40; i++) noise.push(`viewport changed source=interaction zoom=0.43 #${i}`);
      const hit = '[BrowserScraper] still awaiting extractor evaluate (Glassdoor q1/1 p1) after 30s';
      const logs = [...noise, hit];
      for (let i = 0; i < 40; i++) logs.push(`node resized id=abc w=330 h=121 #${i}`);
      const r = applyBugReportCode(logs, {}, 'STALL');
      assert(r.matchedCodes.includes('STALL') && r.unknownCodes.length === 0, 'STALL is a known code');
      assert(r.filteredLogs.includes(hit), 'the in-flight-await line must survive');
      // Regression: an unanchored /hang/ matches "c-hang-ed", which kept every
      // "viewport changed" line and made the code a no-op.
      assert(r.filteredLogs.length < 12, `STALL must actually scope the log (kept ${r.filteredLogs.length} of ${logs.length})`);
      assert(!/^viewport changed source=interaction zoom=0\.43 #0$/.test(r.filteredLogs[0] || ''), 'unrelated viewport noise is dropped, not merely reordered');
    },
  },
  {
    name: 'STALL keeps the job-pipeline lines a stuck-run report is diagnosed from',
    run: () => {
      const real = [
        '[JobSearch][79eb] User clicked Try Again on error banner',
        '[JobSearch][79eb] Pipeline failed — error banner raised (hubState → empty): boom',
        '[Jobs][79eb] Searching with 1 queries across 1 selected source(s)',
        '[BrowserScraper] Glassdoor: requested www.glassdoor.com but the session landed on www.glassdoor.ca',
        '[IPC] Registered task for sender 1 node 79eb',
      ];
      const kept = applyBugReportCode(real, {}, 'STALL').filteredLogs;
      for (const line of real) assert(kept.includes(line), `STALL must keep: ${line.slice(0, 50)}`);
    },
  },
  {
    name: 'FULL still includes everything STALL would have scoped',
    run: () => {
      const logs = ['a viewport changed', '[BrowserScraper] still awaiting extractor evaluate', 'node resized'];
      const full = applyBugReportCode(logs, {}, 'FULL');
      assert(full.filteredLogs.length === logs.length, 'FULL never reduces the event log');
      assert(full.sectionExclusions.size === 0, 'FULL excludes no sections');
    },
  },
  {
    name: 'manual activity is bounded and cannot overwrite a terminal source result',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId,
        sourceEvents: telemetry.sourceEvents,
        sourceEventsT0: telemetry.sourceEventsT0,
        pipeline: telemetry.pipeline,
      };
      try {
        telemetry.nodeId = 'activity-ordering-test';
        telemetry.sourceEvents = {};
        telemetry.sourceEventsT0 = Date.now();
        telemetry.pipeline = { phase: 'gathering-sources', active: true, pendingSources: [] };
        for (let index = 0; index < 200; index++) {
          recordJobSourceProgress({
            sourceId: 'google', status: 'searching', detail: `Loading jobs… ${index}`,
          });
        }
        const events = telemetry.sourceEvents.google;
        assert(events.length === 1 && events[0].repeats === 200,
          'repeated activity progress folds into one bounded main-process trail row');

        const jobsSource = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
        const scraperSource = fs.readFileSync(path.resolve('electron/ipc/browser/manualScraper.js'), 'utf8');
        assert(scraperSource.includes("activityKey: 'google-preload'"),
          'Google scroll-loop overlay paints use one stable activity key and are renderer-throttled');
        assert(jobsSource.includes('const terminalManualSourceIds = new Set();')
          && jobsSource.includes('terminalManualSourceIds.add(sourceId);')
          && jobsSource.includes('if (terminalManualSourceIds.has(activitySourceId)) return;'),
        'the IPC boundary drops a late activity beat after that source emitted its terminal result');
      } finally {
        telemetry.nodeId = saved.nodeId;
        telemetry.sourceEvents = saved.sourceEvents;
        telemetry.sourceEventsT0 = saved.sourceEventsT0;
        telemetry.pipeline = saved.pipeline;
      }
    },
  },
  {
    name: 'job diagnostics retain bounded per-source scheduling and throttle history across fresh retries',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId,
        windowId: telemetry.windowId,
        sourceEvents: telemetry.sourceEvents,
        sourceEventsT0: telemetry.sourceEventsT0,
        sourceRunHistory: telemetry.sourceRunHistory,
        pipeline: telemetry.pipeline,
      };
      const nodeId = 'source-schedule-history';
      try {
        Object.assign(telemetry, {
          nodeId,
          windowId: null,
          sourceEvents: {},
          sourceEventsT0: Date.now(),
          sourceRunHistory: {},
          pipeline: { phase: 'gathering-sources', active: true, runId: 'run-1' },
        });
        for (let run = 1; run <= 4; run += 1) {
          telemetry.sourceEvents = {};
          telemetry.sourceEventsT0 = Date.now();
          telemetry.pipeline = { phase: 'gathering-sources', active: true, runId: `run-${run}` };
          recordJobSourceProgress({ sourceId: 'google', jobRunId: `run-${run}`, status: 'searching' });
          recordJobSourceProgress({
            sourceId: 'google',
            jobRunId: `run-${run}`,
            status: run === 4 ? 'done' : 'error',
            ...(run === 3 ? { warning: { code: 'http-429', severity: 'throttle' }, detail: 'private retry timing must not be retained' } : {}),
          });
        }
        telemetry.pipeline = { phase: 'completed', active: false, runId: 'run-4', ts: Date.now() };
        const records = telemetry.sourceRunHistory.google;
        const report = buildJobsPipelineSnapshot(new Set([nodeId]), null, null);
        assert(records.length === 3
          && records.map(record => record.runId).join(',') === 'run-2,run-3,run-4'
          && records[1].warning?.code === 'http-429'
          && records[2].terminalStatus === 'done',
        'each source keeps only its three latest run receipts while retaining a terminal warning that preceded a clean retry');
        const jobsSource = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
        assert(jobsSource.includes('recordJobSourceDispatch(sourceId);')
          && jobsSource.includes('recordJobSourceDispatch(sid, activeRunId);')
          && jobsSource.includes('recordJobSourceDispatch(sourceId, jobRunId);')
          && jobsSource.includes('dispatchedAt')
          && jobsSource.includes('terminalAt'),
        'timing receipts distinguish a UI searching announcement from actual HTTP/browser dispatch and terminal completion');
        assert(report.includes('### Source Scheduling & Throttle History')
          && report.includes('hub `…-history` / `google`:')
          && report.includes('run `run-3`: searching → error · ⚠️ http-429/throttle')
          && report.includes('run `run-4`: searching → done')
          && !report.includes('private retry timing must not be retained'),
        'the JOBS/FULL/STALL pipeline snapshot renders both the retained warning and later clean terminal state without retaining arbitrary progress detail');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { retainedRuns: 3, source: 'google' };
    },
  },
  {
    name: 'source scheduling receipts reject stale dispatch and preserve first-attempt duration through a same-run Solve',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId,
        sourceEvents: telemetry.sourceEvents,
        sourceEventsT0: telemetry.sourceEventsT0,
        sourceRunHistory: telemetry.sourceRunHistory,
        pipeline: telemetry.pipeline,
      };
      try {
        Object.assign(telemetry, {
          nodeId: 'timing-guard-hub',
          sourceEvents: {},
          sourceEventsT0: Date.now(),
          sourceRunHistory: {},
          pipeline: { phase: 'gathering-sources', active: true, runId: 'replacement-run' },
        });
        recordJobSourceProgress({ sourceId: 'google', jobRunId: 'replacement-run', status: 'searching' });
        assert(!__recordJobSourceDispatchForTests('google', 'superseded-run')
          && !telemetry.sourceRunHistory.google.some(record => record.runId === 'superseded-run'),
        'a late explicit browser dispatch cannot create or evict history in a replacement pipeline run');
        assert(__recordJobSourceDispatchForTests('google', 'replacement-run'),
          'the current pipeline run records its real source dispatch');
        recordJobSourceProgress({
          sourceId: 'google', jobRunId: 'replacement-run', status: 'error',
          warning: { code: 'http-429', severity: 'throttle' },
        });
        const firstAttempt = { ...telemetry.sourceRunHistory.google[0] };
        // This models a later source-card Solve completion under the same job
        // run ID. It must not extend the original request's duration across
        // user dwell time without a separately recorded recovery dispatch.
        recordJobSourceProgress({ sourceId: 'google', jobRunId: 'replacement-run', status: 'done' });
        const receipt = telemetry.sourceRunHistory.google[0];
        assert(receipt.dispatchedAt === firstAttempt.dispatchedAt
          && receipt.terminalAt === firstAttempt.terminalAt
          && receipt.terminalStatus === 'error'
          && receipt.warning?.code === 'http-429',
        'a same-run Solve leaves the initial dispatched-to-terminal receipt intact instead of presenting user dwell time as source runtime');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { staleDispatch: 'rejected', terminalReceipt: 'preserved' };
    },
  },
  {
    name: 'generic Solve diagnostics keep a bounded, owner-guarded and redacted pass trail per source run',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId,
        windowId: telemetry.windowId,
        sourceEvents: telemetry.sourceEvents,
        sourceEventsT0: telemetry.sourceEventsT0,
        sourceRunHistory: telemetry.sourceRunHistory,
        pipeline: telemetry.pipeline,
      };
      const secret = 'never-export-job-text-or-url-4bf2';
      try {
        Object.assign(telemetry, {
          nodeId: 'solve-trail-owner',
          windowId: null,
          sourceEvents: {},
          sourceEventsT0: Date.now(),
          sourceRunHistory: {},
          pipeline: { phase: 'gathering-sources', active: true, runId: 'solve-trail-run' },
        });
        recordJobSourceProgress({
          sourceId: 'google', jobRunId: 'solve-trail-run', status: 'searching',
        });
        for (let pass = 1; pass <= 15; pass += 1) {
          const normalized = __recordJobSourceResolvePassForTests('google', {
            at: pass,
            outcome: 'blocked',
            warning: { code: 'description-listing-unavailable', severity: 'block' },
            providerRowsLoaded: 9,
            targeted: 2,
            attempted: 2,
            recovered: 0,
            completeTotal: 3,
            empty: 2,
            unavailable: 2,
            consecutiveNoMatchPasses: pass,
            consecutiveNoProgressPasses: pass,
            recommendation: pass >= 2 ? 'skip' : 'retry',
            checkpoint: 'saved',
            url: `https://example.invalid/${secret}`,
            title: secret,
            detail: secret,
            unavailableSamples: [secret],
          }, { nodeId: 'solve-trail-owner', jobRunId: 'solve-trail-run' });
          assert(normalized?.outcome === 'blocked'
            && normalized?.consecutiveNoMatchPasses === pass,
          'a current generic Solve pass is normalized before being added to its source receipt');
        }
        const receipt = telemetry.sourceRunHistory.google[0];
        assert(receipt.resolvePassCount === 15
          && receipt.resolvePasses.length === 12
          && receipt.resolvePasses[0].at === 4
          && receipt.resolvePasses.at(-1).recommendation === 'skip'
          && receipt.resolvePasses.every(pass => pass.warning?.code === 'description-listing-unavailable'
            && pass.checkpoint === 'saved')
          && !JSON.stringify(receipt.resolvePasses).includes(secret),
        'the receipt retains a total plus only the latest twelve safe Solve observations, with no job text, samples, or URLs');
        const stale = __recordJobSourceResolvePassForTests('google', {
          at: 16, outcome: 'completed', providerRowsLoaded: 1, recommendation: 'retry', checkpoint: 'saved',
        }, { nodeId: 'superseded-solve-owner', jobRunId: 'solve-trail-run' });
        assert(stale === null && receipt.resolvePassCount === 15,
          'a late Resolve from a superseded hub cannot create or mutate the current source-run pass trail');
        const persistenceFailure = __recordJobSourceResolvePassForTests('glassdoor', {
          outcome: 'failed',
          warning: { code: 'description-recovery-persist-failed', severity: 'block' },
          checkpoint: 'failed',
        }, { nodeId: 'solve-trail-owner', jobRunId: 'solve-trail-run' });
        assert(persistenceFailure?.outcome === 'failed'
          && persistenceFailure?.checkpoint === 'failed'
          && persistenceFailure?.warning?.code === 'description-recovery-persist-failed'
          && fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8').includes("recordGenericResolvePass('failed', warning, 'failed');"),
        'checkpoint persistence failure is a retained fixed-state Solve outcome, including after queue-consumption persistence fails');
        const visibleWindowFailure = __recordJobSourceResolvePassForTests('ziprecruiter', {
          outcome: 'failed',
          warning: { code: 'description-detail-error', severity: 'block' },
          checkpoint: 'unchanged',
          error: secret,
          url: `https://example.invalid/${secret}`,
        }, { nodeId: 'solve-trail-owner', jobRunId: 'solve-trail-run' });
        const jobsSource = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
        assert(visibleWindowFailure?.outcome === 'failed'
          && visibleWindowFailure?.warning?.code === 'description-detail-error'
          && visibleWindowFailure?.checkpoint === 'unchanged'
          && !JSON.stringify(visibleWindowFailure).includes(secret)
          && jobsSource.includes('let result;\n    try {\n      result = await withSharedProfileLock(() => openCaptchaResolveWindow(')
          && jobsSource.includes("warning: { code: 'description-detail-error', severity: 'block' }")
          && jobsSource.includes('if (!signal?.aborted) {\n        recordJobSourceResolvePass(sourceId,'),
        'a thrown visible Solve window retains only a fixed failed-state code before its original IPC error is rethrown');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { retainedPasses: 12, totalPasses: 15, staleWrites: 0 };
    },
  },
  {
    name: 'multi-hub source scheduling history remains window-local without weakening single-owner funnel attribution',
    run: () => {
      __resetJobsTelemetryForTests();
      try {
        const senderA = { id: 711 };
        const senderB = { id: 712 };
        const inContext = (sender, nodeId, callback) => __runWithIpcRequestContextForTests(
          { sender, nodeId, channel: nodeId ? 'search-jobs' : 'bug-report' },
          callback,
        );
        const setHistory = (sender, nodeId, sourceId, runId, warning = null, resolvePasses = []) => inContext(sender, nodeId, () => {
          const telemetry = getJobsTelemetry();
          Object.assign(telemetry, {
            nodeId,
            windowId: sender.id,
            pipeline: { runId, phase: 'completed', active: false, ts: Date.now() },
            sourceRunHistory: {
              ...(telemetry.sourceRunHistory || {}),
              [sourceId]: [{
                runId,
                announcedAt: 1_000,
                dispatchedAt: 2_000,
                terminalAt: 5_000,
                announcedStatus: 'searching',
                terminalStatus: warning ? 'error' : 'done',
                warning,
                resolvePassCount: resolvePasses.length,
                resolvePasses,
              }],
            },
          });
        });
        setHistory(senderA, 'hub-a1', 'google', 'a1-run', { code: 'http-429', severity: 'throttle' }, [{
          at: 3_500,
          outcome: 'blocked',
          warning: { code: 'description-listing-unavailable', severity: 'block' },
          providerRowsLoaded: 8,
          targeted: 0,
          attempted: 0,
          recovered: 0,
          completeTotal: 3,
          empty: 2,
          unavailable: 2,
          consecutiveNoMatchPasses: 2,
          consecutiveNoProgressPasses: 0,
          recommendation: 'skip',
          checkpoint: 'saved',
          url: 'https://example.invalid/must-not-render',
        }, {
          at: 3_750,
          outcome: 'blocked',
          warning: { code: 'description-detail-hard-block', severity: 'block' },
          attempted: 2,
          recovered: 0,
          empty: 2,
          recommendation: 'retry',
          checkpoint: 'unchanged',
        }]);
        setHistory(senderA, 'hub-a2', 'glassdoor', 'a2-run', { code: 'description-panel-http-error', severity: 'warn' });
        setHistory(senderB, 'hub-b1', 'dice', 'b1-run');

        const reportA = inContext(senderA, null, () => buildJobsPipelineSnapshot(
          new Set(['hub-a1', 'hub-a2']), senderA.id, null,
        ));
        const wrongWindow = inContext(senderA, null, () => buildJobsPipelineSnapshot(
          new Set(['hub-a1', 'hub-a2']), senderB.id, null,
        ));
        assert(reportA.includes('hub `hub-a1` / `google`: run `a1-run`')
          && reportA.includes('hub `hub-a2` / `glassdoor`: run `a2-run`')
          && reportA.includes('http-429/throttle')
          && reportA.includes('description-panel-http-error/warn')
          && reportA.includes('Solve passes (run `a1-run`)')
          && reportA.includes('Skip recommended')
          && reportA.includes('checkpoint saved')
          && reportA.includes('warning: description-detail-hard-block/block')
          && !reportA.includes('https://example.invalid/must-not-render')
          && !reportA.includes('hub `hub-b1`')
          && !wrongWindow.includes('Source Scheduling & Throttle History'),
        'a multi-hub FULL/JOBS/STALL snapshot merges only current-window hub-local history, including non-blocking terminal warnings, while a mismatched report window receives none');
        return { currentWindowHubs: 2, foreignWindowHubs: 0 };
      } finally {
        // This test creates multiple sender-local records; leave no ambient
        // latest telemetry behind for later, order-independent fixtures.
        __resetJobsTelemetryForTests();
      }
    },
  },
  {
    name: 'assembled FULL and focused job reports retain only current multi-hub source receipts without payload leakage',
    run: () => {
      __resetJobsTelemetryForTests();
      try {
        const senderA = { id: 721 };
        const senderB = { id: 722 };
        const hubA1 = 'assembled-hub-a1';
        const hubA2 = 'assembled-hub-a2';
        const hubB = 'assembled-hub-b';
        const secret = 'do-not-export-query-or-location-9f3a';
        const inContext = (sender, nodeId, callback) => __runWithIpcRequestContextForTests(
          { sender, nodeId, channel: nodeId ? 'search-jobs' : 'generate-bug-report-markdown' },
          callback,
        );
        const seed = (sender, nodeId, sourceId, runId, extra = {}) => inContext(sender, nodeId, () => {
          const telemetry = getJobsTelemetry();
          Object.assign(telemetry, {
            nodeId,
            windowId: sender.id,
            pipeline: { runId, phase: 'completed', active: false, ts: Date.now() },
            sourceRunHistory: {
              ...(telemetry.sourceRunHistory || {}),
              [sourceId]: [{
                runId, announcedAt: 1_000, dispatchedAt: 2_000, terminalAt: 3_000,
                announcedStatus: 'searching', terminalStatus: 'error',
                warning: { code: 'http-429', severity: 'throttle' },
                ...extra,
              }],
            },
          });
        });
        seed(senderA, hubA1, 'google', 'assembled-a1', {
          detail: secret, query: secret, location: secret,
          resolvePassCount: 2,
          resolvePasses: [{
            at: 2_500,
            outcome: 'blocked',
            warning: { code: 'description-listing-unavailable', severity: 'block' },
            providerRowsLoaded: 4,
            targeted: 0,
            attempted: 0,
            recovered: 0,
            completeTotal: 1,
            empty: 1,
            unavailable: 1,
            consecutiveNoMatchPasses: 2,
            consecutiveNoProgressPasses: 0,
            recommendation: 'skip',
            checkpoint: 'saved',
            title: secret,
            url: `https://example.invalid/${secret}`,
            unavailableSamples: [secret],
          }],
        });
        seed(senderA, hubA2, 'glassdoor', 'assembled-a2');
        // Corrupt/unexpected keys must never become report-visible receipts.
        seed(senderA, hubA2, 'untrusted-source-key', 'must-not-render', { detail: secret });
        seed(senderB, hubB, 'dice', 'assembled-b');

        const payloadFor = (filterCode, hubIds) => ({
          description: 'source scheduling receipt diagnostics',
          filterCode,
          filterStats: {
            hasJobNodes: true,
            hasSellNodes: false,
            currentNodeIds: hubIds,
            currentJobHubIds: hubIds,
            omittedSections: [],
          },
          nodes: hubIds.map(id => ({ id, type: 'jobhub', data: {} })),
          edges: [], drawings: [], frontEndState: {}, nodeInternals: [], nodeComponentStates: [], eventLogs: [],
        });
        const full = inContext(senderA, null, () => generateMarkdown(
          payloadFor('FULL', [hubA1, hubA2]), senderA.id,
        ).markdown);
        const jobs = inContext(senderA, null, () => generateMarkdown(
          payloadFor('JOBS', [hubA1, hubA2]), senderA.id,
        ).markdown);
        const stall = inContext(senderA, null, () => generateMarkdown(
          payloadFor('STALL', [hubA1, hubA2]), senderA.id,
        ).markdown);
        const resolve = inContext(senderA, null, () => generateMarkdown(
          payloadFor('JOBRESOLVE', [hubA1, hubA2]), senderA.id,
        ).markdown);
        const nonCurrent = inContext(senderA, null, () => generateMarkdown(
          payloadFor('FULL', [hubA1]), senderA.id,
        ).markdown);
        const wrongWindow = inContext(senderA, null, () => generateMarkdown(
          payloadFor('FULL', [hubA1, hubA2]), senderB.id,
        ).markdown);
        const everyExpectedReport = [full, jobs, stall, resolve].every(report => report.includes('### Source Scheduling & Throttle History')
          && report.includes('hub `…d-hub-a1` / `google`')
          && report.includes('hub `…d-hub-a2` / `glassdoor`'));
        assert(everyExpectedReport
          && full.includes('Solve passes (run `…mbled-a1`)')
          && resolve.includes('Solve passes (run `…mbled-a1`)')
          && resolve.includes('Skip recommended')
          && resolve.includes('checkpoint saved')
          && !full.includes('assembled-hub-b')
          && !full.includes('untrusted-source-key')
          && !full.includes(secret)
          && !resolve.includes(secret)
          && !nonCurrent.includes('assembled-hub-a2')
          && !wrongWindow.includes('Source Scheduling & Throttle History'),
        'real FULL/JOBS/STALL/JOBRESOLVE assembly retains each current sender-local Job Search hub, exposes the compact Solve retry trail in FULL and JOBRESOLVE, and renders no arbitrary query/location/detail fields');
      } finally {
        __resetJobsTelemetryForTests();
      }
      return { assembledFilters: 4, leakedFields: 0 };
    },
  },
{
    // A bare .slice() cut this evidence mid-word ("…the scraper stopped befor"),
    // which reads as a corrupted report rather than a truncated one, and the
    // `suggestion` field — the only sentence stating what the run DID with the
    // affected rows — was never rendered by any report path.
    name: 'job pipeline report: a flagged productive source marks its truncated evidence and states its suggestion',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId,
        search: telemetry.search, resolves: telemetry.resolves,
      };
      const longEvidence = `Glassdoor returned HTTP 502 from its right-side panel endpoint for "${'Framing Layout Lead '.repeat(9)}". This is a source response failure, not a panel-selector timeout; the scraper stopped before issuing another request.`;
      Object.assign(telemetry, {
        nodeId: 'warn-detail-diagnostics', windowId: null, resolves: {},
        search: {
          ts: Date.now(), queries: 1, raw: 782, deduped: 782, ageDropped: 463, historyDropped: 1, kept: 4,
          bySource: {
            glassdoor: {
              count: 782, pagesWalked: 30, stopReason: 'completed',
              warning: {
                code: 'description-panel-http-error', severity: 'warn',
                evidence: longEvidence,
                suggestion: 'Retry Glassdoor later. List results were retained; this and later unresolved rows remain eligible for a future run.',
              },
            },
          },
        },
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['warn-detail-diagnostics']), null, null);
        assert(report.includes('returned results BUT flagged'),
          'a source that returned rows AND carried a warning is still surfaced');
        assert(report.includes(`${longEvidence.slice(0, 219)}…`),
          'over-length evidence is cut WITH a marker, so a mid-word ending reads as truncation and not corruption');
        assert(report.includes('Suggested: Retry Glassdoor later.'),
          'the warning suggestion reaches the report — it is the only line saying what happened to the affected rows');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
    },
  },
{
    // The run that exposed this logged "country scope not enforced" at 04:00:03,
    // then walked 30 pages. The once-per-source origin row was evicted from the
    // 30-slot recency ring, so the caveat section never rendered and the location
    // section went on asserting a verified filter with nothing to contradict it.
    name: 'job pipeline report: a nation-tier location caveat survives the event ring and rides the line that claims a verified filter',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId,
        search: telemetry.search, resolves: telemetry.resolves,
      };
      const scrapeTelemetry = getManualScraperTelemetry();
      const savedEvents = scrapeTelemetry.events;
      Object.assign(telemetry, {
        nodeId: 'nation-tier-diagnostics', windowId: null, resolves: {},
        search: {
          ts: Date.now(), queries: 1, raw: 4, deduped: 4, ageDropped: 0, historyDropped: 0, kept: 4,
          location: {
            canonical: 'United States',
            perSource: { glassdoor: 'Verified location filter — param: locId=; skipped unless exact resolution succeeds' },
          },
          bySource: { glassdoor: { count: 4, pagesWalked: 30, stopReason: 'completed' } },
        },
      });
      try {
        resetManualScraperTelemetry();
        recordManualScraperTelemetry({
          phase: 'location-nation-tier-unenforced', sourceId: 'glassdoor', srcName: 'Glassdoor',
          location: 'United States', locId: '1', locT: 'N',
        });
        for (let i = 0; i < 40; i += 1) {
          recordManualScraperTelemetry({ phase: 'card-walk', sourceId: 'glassdoor', srcName: 'Glassdoor', pageNum: i });
        }
        assert(!(getManualScraperTelemetry().events || []).some(e => e.phase === 'location-nation-tier-unenforced'),
          'precondition: a long walk really does evict the once-per-source origin row from the recency ring');

        const report = buildJobsPipelineSnapshot(new Set(['nation-tier-diagnostics']), null, null);
        assert(report.includes('Country scope not enforced'),
          'the caveat section reads the retained origins ring, not the ring that evicts');
        const locLine = (report.split('\n').find(l => l.includes('Verified location filter')) || '');
        assert(locLine.includes('nation-tier locId'),
          'the runtime caveat rides the same line as the static claim it contradicts, not a distant section');
      } finally {
        Object.assign(telemetry, saved);
        resetManualScraperTelemetry();
        scrapeTelemetry.events = savedEvents;
      }
      return { ok: true };
    },
  },
{
    // Eight retained batches x ~6 confirming lines restate what
    // `selection-mismatches 0` already says, so only the useful summary remains.
    name: 'job pipeline report: an all-matching click-transition batch collapses, a mismatching batch stays itemised',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId,
        search: telemetry.search, resolves: telemetry.resolves,
      };
      const scrapeTelemetry = getManualScraperTelemetry();
      const savedEvents = scrapeTelemetry.events;
      const clean = Array.from({ length: 6 }, (_, i) => ({
        itemIndex: i + 1, physicalIndex: 691 + i, physicalTotal: 720,
        expectedKey: `k${i}`, hitKey: `k${i}`,
        expectedTitle: `Role ${i}`, hitTitle: `Role ${i}`, lookup: 'primary',
      }));
      const dirty = clean.map((row, i) => (i === 2 ? { ...row, hitKey: 'WRONG' } : row));
      Object.assign(telemetry, {
        nodeId: 'transition-collapse-diagnostics', windowId: null, resolves: {},
        search: {
          ts: Date.now(), queries: 1, raw: 1, deduped: 1, ageDropped: 0, historyDropped: 0, kept: 1,
          bySource: { glassdoor: { count: 1, pagesWalked: 24, stopReason: 'completed' } },
        },
      });
      try {
        resetManualScraperTelemetry();
        recordManualScraperTelemetry({
          phase: 'card-walk', sourceId: 'glassdoor', srcName: 'Glassdoor',
          pageNum: 24, attempted: 6, expanded: 6, transitionSamples: clean,
        });
        const collapsed = buildJobsPipelineSnapshot(new Set(['transition-collapse-diagnostics']), null, null);
        assert(collapsed.includes('all 6 sampled click(s) hit the expected card'),
          'an all-confirming sample set collapses to one line');
        assert(collapsed.includes('physical #691→#696'),
          'the collapsed line still carries the first→last span the samples existed to prove');
        assert(!collapsed.includes('Click transition samples (expected → hit):'),
          'the itemised expected→hit block is not also emitted when nothing mismatched');

        resetManualScraperTelemetry();
        recordManualScraperTelemetry({
          phase: 'card-walk', sourceId: 'glassdoor', srcName: 'Glassdoor',
          pageNum: 24, attempted: 6, expanded: 6, transitionSamples: dirty,
        });
        const itemised = buildJobsPipelineSnapshot(new Set(['transition-collapse-diagnostics']), null, null);
        assert(itemised.includes('Click transition samples (expected → hit):') && itemised.includes('[MISMATCH]'),
          'a batch containing a wrong-card hit is never collapsed — that is the case the samples are for');
      } finally {
        Object.assign(telemetry, saved);
        resetManualScraperTelemetry();
        scrapeTelemetry.events = savedEvents;
      }
      return { ok: true };
    },
  },
{
    // A 30-page run lost 21 rows on page 29 and recovered on page 30. Because
    // `skippedCards` only counts pages entered under an ALREADY-armed block, and
    // recovery clears firstPage/reprobes, the line read "detail enrichment was
    // blocked by a source throttle; enrichment resumed" — i.e. no loss at all.
    name: 'job pipeline report: a recovered detail block still states the rows it cost and the in-scraper duplicate drop',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId,
        search: telemetry.search, resolves: telemetry.resolves,
      };
      Object.assign(telemetry, {
        nodeId: 'block-cost-diagnostics', windowId: null, resolves: {},
        search: {
          ts: Date.now(), queries: 1, raw: 782, deduped: 782, ageDropped: 463, historyDropped: 1, kept: 4,
          bySource: {
            glassdoor: {
              count: 782, pagesWalked: 30, stopReason: 'completed',
              providerDuplicatesDropped: 118,
              detailBlock: {
                code: null, active: false, firstPage: null, everBlockedPage: 29,
                arms: 1, reprobes: 0, reprobesTotal: 1, recovered: 1,
                skippedCards: 0, unenrichedRows: 21,
              },
            },
          },
        },
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['block-cost-diagnostics']), null, null);
        assert(report.includes('21 row(s) ended the walk with no description'),
          'a recovered block reports what it cost instead of reading as a clean run');
        assert(report.includes('from page 29'),
          'the blocked page survives the recovery that clears firstPage');
        assert(report.includes('1 cooldown re-probe(s), 1 recovered'),
          'the re-probe episode survives the recovery that resets the per-episode counter');
        assert(report.includes('118 duplicate card(s) dropped in-scraper'),
          'the funnel raw count is post-scraper-dedup, so the layer it hides is stated where it happened');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
    },
  },
{
    // A clean finish DELETES both sidecars (there is no 'done' stage), so
    // "absent" is the success state — but printed bare it is indistinguishable
    // from "staging silently never ran", which sends the next investigation at
    // crash-recovery when nothing is wrong.
    name: 'job recovery diagnostics: an absent sidecar after a clean finish is distinguished from staging never running',
    run: () => {
      const telemetry = getJobsTelemetry();
      const savedPipeline = telemetry.pipeline;
      const savedNodeId = telemetry.nodeId;
      const dir = fs.mkdtempSync(path.join('/tmp', 'ic-staging-absent-'));
      const canvas = path.join(dir, 'canvas.json');
      try {
        telemetry.nodeId = 'clean-finish-hub';
        telemetry.pipeline = { phase: 'completed' };
        const clean = buildJobRecoverySnapshot(canvas, new Set(['clean-finish-hub']));
        assert(clean.includes('Run manifest: absent') && clean.includes('a clean finish deletes both sidecars'),
          'after a completed run, absence is stated as the expected success state');
        assert(clean.includes('Staging ledger: absent — expected after a clean finish'),
          'the staging ledger gets the same attribution rather than a bare "absent"');

        telemetry.pipeline = { phase: 'searching' };
        const midRun = buildJobRecoverySnapshot(canvas, new Set(['clean-finish-hub']));
        assert(midRun.includes('not `completed`'),
          'when the last phase is not a clean finish, the same absence is flagged instead of reassuring');
      } finally {
        telemetry.pipeline = savedPipeline;
        telemetry.nodeId = savedNodeId;
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return { ok: true };
    },
  },
{
    // The report tests above feed fabricated telemetry, so they would still pass
    // if the scraper never populated these fields. Pin the producer and the
    // merge that carry them, end to end.
    name: 'browser scrape: the un-enriched row count and in-scraper duplicate drop are actually produced and merged, not just rendered',
    run: () => {
      const scraperSource = fs.readFileSync(path.resolve('electron/ipc/browser/manualScraper.js'), 'utf8');
      const jobsSource = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');

      assert(scraperSource.includes("sourceDetailUnenriched += enhanced.filter(j => j?.descriptionDeferredReason).length;"),
        'the scraper counts deferred rows from the rows themselves, so the page that TRIGGERS a block is counted too');
      assert(scraperSource.includes('unenrichedRows: sourceDetailUnenriched,')
        && scraperSource.includes('everBlockedPage: sourceDetailFirstBlockPg,')
        && scraperSource.includes('reprobesTotal: sourceDetailReprobeTotal,'),
      'the recovery-surviving block fields reach the per-source result');
      assert(scraperSource.includes('providerDuplicatesDropped: Math.max(0, sourcePhysicalCards - providerSeen.size),'),
        'the shed-card count reaches the per-source result (its load-more semantics are pinned by its own test)');
      assert(scraperSource.includes('if (enhanced[i] != null) unavailableDetailDropped += 1;')
        && scraperSource.includes('unavailableDetailDropped: sourceUnavailableDetailDropped,'),
      'a confirmed unavailable detail page is counted exactly when it is removed, separately from candidate identities');

      assert(jobsSource.includes('unenrichedRows: (prior.unenrichedRows || 0) + (result.detailBlock.unenrichedRows || 0),')
        && jobsSource.includes('reprobesTotal: (prior.reprobesTotal || 0) + (result.detailBlock.reprobesTotal || 0),')
        && jobsSource.includes('everBlockedPage: prior.everBlockedPage ?? result.detailBlock.everBlockedPage,'),
      'merging a source\'s query variants keeps the block cost instead of dropping it');
      assert(jobsSource.includes('if (data.providerDuplicatesDropped) bySource[sid].providerDuplicatesDropped = data.providerDuplicatesDropped;'),
        'the duplicate-drop count reaches the telemetry the bug report reads');
      assert(jobsSource.includes('sourceResults[sourceId].unavailableDetailDropped =')
        && jobsSource.includes('if (data.unavailableDetailDropped) bySource[sid].unavailableDetailDropped = data.unavailableDetailDropped;')
        && jobsSource.includes('unavailableDetailDropped: source?.unavailableDetailDropped,'),
      'the unavailable-detail aggregate survives source merge, live telemetry, and terminal-receipt construction');
      assert(scraperSource.includes('locationScopeUnenforced: nationTierCaveatRecorded,')
        && jobsSource.includes('if (result.locationScopeUnenforced === true)')
        && jobsSource.includes('if (data.locationScopeUnenforced === true) bySource[sid].locationScopeUnenforced = true;')
        && jobsSource.includes('locationScopeUnenforced: source?.locationScopeUnenforced === true,'),
      'the nation-tier scope caveat reaches both live telemetry and the durable receipt without occupying the source-warning slot');
      return { ok: true };
    },
  },
{
    // A load-more board re-serves its WHOLE accumulated list every iteration, so
    // counting a duplicate per re-encounter measures re-scanning, not shed cards:
    // over the observed 30-page walk that would have printed ~13,000 instead of 118.
    name: 'browser scrape: the in-scraper duplicate count measures shed cards, not the load-more list being re-scanned',
    run: () => {
      const src = fs.readFileSync(path.resolve('electron/ipc/browser/manualScraper.js'), 'utf8');
      assert(!src.includes('sourceDuplicateCards'),
        'the per-re-encounter counter is gone — on a cumulative list it counted re-scans');
      assert(src.includes('sourcePhysicalCards += loadMoreSelector')
        && src.includes('? Math.max(0, extracted.length - loadMorePrevCount)')
        && src.includes(': extracted.length;'),
      'physical cards are counted as the per-iteration delta on a load-more source and per page otherwise');
      assert(src.includes('providerDuplicatesDropped: Math.max(0, sourcePhysicalCards - providerSeen.size),'),
        'the reported drop is scanned-cards minus distinct provider keys');
      assert(src.includes('if (!seen.has(key)) { seen.add(key); newJobs.push(job); }'),
        'the cross-source dedup set still gates the push — counting must not change what is collected');

      // The observed run's shape: a cumulative list growing 30 per page to 900,
      // yielding 782 distinct provider keys.
      let physical = 0;
      let prev = 0;
      for (let page = 1; page <= 30; page += 1) {
        const cumulative = page * 30;
        physical += Math.max(0, cumulative - prev);
        prev = cumulative;
      }
      assert(physical === 900, `delta accumulation over a cumulative list yields the physical card total, got ${physical}`);
      assert(Math.max(0, physical - 782) === 118,
        'the observed 30-page Glassdoor walk reports 118 shed cards, not the ~13,000 a per-re-encounter counter would give');
      return { ok: true };
    },
  },
{
    // `completed` is the fall-through of resolveManualSourceStopReason, not an
    // observation. A board that stops rendering its show-more control at its own
    // result ceiling ends exactly the same way as a genuinely exhausted source.
    name: 'job pipeline report: a browser walk that stopped on "completed" is not presented as proof the source was exhausted',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId,
        search: telemetry.search, resolves: telemetry.resolves,
      };
      Object.assign(telemetry, {
        nodeId: 'completed-claim-diagnostics', windowId: null, resolves: {},
        search: {
          ts: Date.now(), queries: 1, raw: 782, deduped: 782, ageDropped: 463, historyDropped: 1, kept: 4,
          bySource: { ziprecruiter: {
            count: 782, pagesWalked: 42, stopReason: 'completed', claimedTotal: 900,
            directContinuation: { fromPage: 21, pages: 22, lastPage: 42, stop: 'completed' },
          } },
        },
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['completed-claim-diagnostics']), null, null);
        assert(report.includes('walked 42 pages → stopped: completed'),
          'the stop reason is still reported verbatim');
        assert(report.includes('NOT positive evidence the source was exhausted'),
          'the report refuses to let "completed" read as full coverage');
        assert(report.includes('result ceiling'),
          'the reader is pointed at the board-cap reading that produces the identical stop reason');
        assert(report.includes('Direct unlinked-page continuation: page 21→42')
          && report.includes('22 page(s) reached'),
        'the report proves that hidden numbered pages were reached after the visible pager ended');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
    },
  },
{
    // The flag chain annotated 6 of 12 stopReasons. The unannotated ones included
    // both the strongest "we got everything" evidence (end-of-results, empty-page)
    // and the strongest "we did not" (user-done, detail-enrichment-failed) — the
    // exact question a reader brings to this line.
    name: 'job pipeline report: every stop reason that carries completeness meaning is annotated, in the right direction',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId,
        search: telemetry.search, resolves: telemetry.resolves,
      };
      const render = (stopReason) => {
        Object.assign(telemetry, {
          nodeId: 'stopreason-diagnostics', windowId: null, resolves: {},
          search: {
            ts: Date.now(), queries: 1, raw: 10, deduped: 10, ageDropped: 0, historyDropped: 0, kept: 10,
            bySource: { glassdoor: { count: 10, pagesWalked: 5, stopReason } },
          },
        });
        const report = buildJobsPipelineSnapshot(new Set(['stopreason-diagnostics']), null, null);
        return (report.split('\n').find(l => l.includes(`stopped: ${stopReason}`)) || '');
      };
      try {
        // PROVES-INCOMPLETE — must say later results are missing.
        for (const [reason, needle] of [
          ['blocked', 'anti-bot wall ended the walk mid-source'],
          ['user-done', 'NOT a user action'],
          ['detail-enrichment-failed', 'stopped this source mid-walk'],
          ['aborted', 'cancelled while this source was still walking'],
          ['challenge-recovery-loop', 'bounced the walk back to page 1 twice'],
          ['no-new-jobs', 'is NOT established'],
          ['data-stop', 'coverage here is unknown'],
        ]) {
          const line = render(reason);
          assert(line.includes(needle), `${reason} states what it cost: expected "${needle}" in: ${line}`);
          assert(line.includes('⚠️'), `${reason} is flagged as a warning, not an aside`);
        }
        // PROVES-EXHAUSTED / DELIBERATE — informational, and must NOT be alarming.
        for (const [reason, needle] of [
          ['empty-page', 'end of this board'],
          ['end-of-results', 'stale selectors are ruled out'],
          ['age-window', 'NOT an exhausted board'],
        ]) {
          const line = render(reason);
          assert(line.includes(needle), `${reason} explains itself: expected "${needle}" in: ${line}`);
          assert(line.includes('ℹ️') && !line.includes('⚠️ ('),
            `${reason} is informational, not a warning`);
        }
        // age-window must not claim deeper pages exist — nothing establishes that.
        assert(!render('age-window').includes('Deeper pages exist'),
          'age-window asserts only what the two-page evidence supports');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
    },
  },
{
    // Two truncation idioms coexist in the report code. A bare .slice() cut a
    // sentence mid-word ("…the scraper stopped befor"), which reads as a
    // corrupted report rather than a clipped one.
    name: 'bug report: prose truncation is marked, identifiers are not, and table cells clip before escaping',
    run: () => {
      assert(clipReportText('short', 40) === 'short',
        'a value under the cap is returned untouched — no cosmetic marker');
      const long = 'x'.repeat(100);
      const clipped = clipReportText(long, 40);
      assert(clipped.length === 40 && clipped.endsWith('…'),
        'an over-length value is cut to the cap WITH a marker, so the cut is legible as truncation');
      assert(clipReportText(null, 10) === '' && clipReportText(undefined, 10) === '',
        'a missing value yields empty text rather than the string "null"');

      // A cut landing between `\` and `|` leaves a dangling backslash that
      // escapes the cell's closing pipe and breaks the markdown table, so the
      // clip must happen BEFORE the pipe escape at every table-cell site.
      const rollup = fs.readFileSync(path.resolve('electron/ipc/bugReport/marketplaceModuleRollup.js'), 'utf8');
      const sellHub = fs.readFileSync(path.resolve('electron/ipc/bugReport/sellHubPriceDropRollup.js'), 'utf8');
      const report = fs.readFileSync(path.resolve('electron/ipc/bugReport.js'), 'utf8');
      assert(rollup.includes("clipReportText((r.summary || r.message || '').replace(/\\s+/g, ' ').trim(), 80).replace(/\\|/g, '\\\\|')"),
        'the marketplace summary cell clips before escaping its pipes');
      assert(sellHub.includes('escapeCell(clipReportText(productLabel(d), 70))'),
        'the sell-hub item cell clips before escapeCell runs');
      assert(report.includes("truncateDiagnosticText(redactReportUrlsInText(duration.error), 80).replace(/\\|/g, '\\\\|')")
        && report.includes("truncateDiagnosticText(String(d.title || '—'), 80).replace(/\\|/g, '\\\\|')"),
      'both bugReport.js table cells clip before escaping their pipes');

      // Identifiers must NOT gain a marker — a URL, hash, selector or JSON blob
      // with '…' appended is no longer a value anyone can match or copy.
      const snap = fs.readFileSync(path.resolve('electron/ipc/bugReport/jobsSnapshot.js'), 'utf8');
      assert(snap.includes('JSON.stringify(e.pageState).slice(0, 240)')
        && snap.includes('JSON.stringify(String(e.panelSelector).slice(0, 180))'),
      'JSON blobs and selectors keep their bare slice — a marker would corrupt the value');
      return { ok: true };
    },
  },
{
    name: 'Job-run receipt and report carry API source corpus coverage',
    run: () => {
      // The extractors measure the provider's own corpus size precisely so that
      // "44 of 973" cannot read as "44 of 44". Every hop used to drop it.
      const sanitized = sanitizeLastRunReceipt({
        runId: 'hub-1', nodeId: 'hub',
        terminal: { status: 'completed', outcome: 'populated', scoreReadyCount: 5 },
        sources: { usajobs: { count: 44, providerGathered: 44, providerTotal: 973, truncated: true, relevanceDropped: 0 } },
      });
      assert(sanitized.sources.usajobs.providerTotal === 973 && sanitized.sources.usajobs.truncated === true,
        'Receipt sanitizer retains the provider corpus size and the truncation flag');
      const clean = sanitizeLastRunReceipt({
        runId: 'hub-1', nodeId: 'hub',
        terminal: { status: 'completed', outcome: 'populated' },
        sources: { usajobs: { count: 44, providerGathered: 44, relevanceDropped: 0 } },
      });
      assert(!('providerTotal' in clean.sources.usajobs) && !('truncated' in clean.sources.usajobs),
        'Receipt sanitizer omits coverage fields a source never reported rather than inventing a zero');

      // queryFanOut is the hop that dropped them first; the wrapper below reads
      // them straight off its return value.
      const jobsSrc = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
      assert(jobsSrc.includes('return { items, warning, gathered, providerGathered, providerTotal, truncated,'),
        'queryFanOut returns the corpus-coverage facts its caller reads');
      assert(jobsSrc.includes('if (data.providerTotal != null) bySource[sid].providerTotal = data.providerTotal;'),
        'per-source telemetry carries providerTotal for API sources, the twin of claimedTotal for browser sources');
      assert(jobsSrc.includes('const capDropped = rawJobs.length - jobs.length;'),
        'the per-platform cap is measured where it is applied, not derived from a figure that also includes cross-query dedup');
      return { ok: true };
    },
  },
{
    name: 'Completion assessment reconciles gather coverage, preferences and the history write',
    run: () => {
      const snap = fs.readFileSync(path.resolve('electron/ipc/bugReport/jobsSnapshot.js'), 'utf8');
      // Every other check in this reconciliation is downstream of search.kept, so
      // a source that returned a tenth of its corpus used to reconcile perfectly.
      assert(snap.includes('const shortSources = applicableCoverageSources.filter'),
        'the assessment reconciles per-source gather coverage, not only the stages after collection');
      assert(snap.includes('Gather completeness is unproven for'),
        'a green verdict states when gather completeness was NOT proven instead of implying it');
      // Job Preferences legitimately remove rows between admission and scoring.
      assert(snap.includes('const expectedAfterPreferences = expected == null'),
        'preference-filtered rows are subtracted before comparing against the scorer input');
      assert(snap.includes('= ${expectedAfterPreferences} ≠ scoring input ${scoreInput}'),
        'the subtraction is stated in the gap text rather than applied silently');
      // Two DIFFERENT stages remove rows in the gap between admission and the
      // scorer: strict Job Preferences, and the backstop AI role screen that
      // catches rows appended after the run's bulk screen (USAJobs background
      // refresh, Solve/Resume). Both must be subtracted or the reconciler
      // reports a shortfall that is in fact fully explained -- and each must be
      // named separately, because a report that blamed role-screen drops on
      // "Job Preferences" would assert a cause that never happened.
      assert(snap.includes('preference-filtered') && snap.includes('role-screened'),
        'each subtracted stage is named as its own term in the gap text');
      assert(snap.includes('- (preferenceFiltered || 0) - (roleScreenBackstopDropped || 0)'),
        'the backstop role screen is subtracted alongside preference-filtered rows, not omitted');
      // The board-displayed seen-history write is the run's last stage.
      assert(snap.includes('const historyWriteFailed = !!historyWrite?.error;')
        && snap.includes('- Seen-history write:'),
      'the board-displayed seen-history write is both reconciled and rendered');
      // The phase stamped at the end of the GATHER must not be labelled as the run.
      assert(snap.includes('- Live search stage:') && !snap.includes('- Live pipeline:'),
        'the gather-stage phase is named for what it measures, since scoring and taxonomy run after it');
      return { ok: true };
    },
  },
{
    name: 'Frozen run inputs survive a completed save; interrupted runs still shed them',
    run: () => {
      const interrupted = getJobSearchTransientKeysForSave('scoring');
      const done = getJobSearchTransientKeysForSave('done');
      assert(interrupted.includes('activeJobPreferences') && interrupted.includes('jobPreferencePlan')
        && interrupted.includes('jobPreferencesInterpretation'),
      'an interrupted run sheds BOTH halves of its frozen Job Preferences, never just the text');
      assert(!done.includes('activeJobPreferences') && !done.includes('jobPreferencePlan')
        && !done.includes('jobPreferencesInterpretation'),
      'a completed run keeps the frozen pair its late-source append and re-analysis paths read together');
      assert(done.includes('pendingJobs') && done.includes('scrapeWarnings') && done.includes('errorMessage'),
        'a completed run still sheds ordinary in-session buffers');

      // The client age backstop must never be narrower than the day-granular
      // server bound it backs up: boards publish date-only postings at midnight.
      const now = new Date(2026, 8, 3, 21, 42);
      const dayStamp = (offset) => {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T00:00:00.0000`;
      };
      assert(filterJobsByAge([{ posted: dayStamp(21) }], 21, now).length === 1,
        'a date-only posting on the boundary day is kept, matching the server DatePosted window');
      assert(filterJobsByAge([{ posted: dayStamp(22) }], 21, now).length === 0,
        'a date-only posting past the window is still dropped');
      assert(filterJobsByAge([{ posted: new Date(now.getTime() - 22 * 86400000).toISOString() }], 21, now).length === 0,
        'a posting carrying a real time of day keeps the exact comparison');

      // The report must never echo a transient value that can hold documents.
      const report = fs.readFileSync(path.resolve('electron/ipc/bugReport.js'), 'utf8');
      assert(report.includes('const ECHOABLE_TRANSIENT_STRING_KEYS = new Set(')
        && report.includes('value withheld'),
      'the leaked-state diagnostic proves presence without exporting career-document text');
      return { ok: true };
    },
  },
  {
    name: 'job completion assessment does not call a ZipRecruiter claimed-total shortfall exhausted',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search,
        resolves: telemetry.resolves, scoring: telemetry.scoring, bucketing: telemetry.bucketing,
        pipeline: telemetry.pipeline, history: telemetry.history,
      };
      const dir = fs.mkdtempSync(path.join('/tmp', 'ic-completion-empty-page-'));
      const canvas = path.join(dir, 'canvas.json');
      const nodeId = 'completion-hub-zr';
      const runId = 'completion-run-zr-42';
      const analysisPaths = getJobAnalysisPaths(canvas, path.join(dir, 'analysis'));
      try {
        fs.writeFileSync(analysisPaths.jsonPath, JSON.stringify({
          runId, sourceHubId: nodeId, canvasFilePath: canvas, createdAt: Date.now(),
          jobs: Array.from({ length: 154 }, () => ({})),
        }), 'utf8');
        fs.writeFileSync(path.join(dir, 'canvas.jobs-last-run.json'), JSON.stringify({
          runId, nodeId, startedAt: Date.now() - 10_000, completedAt: Date.now(),
          terminal: { status: 'completed', outcome: 'populated', scoreReadyCount: 154 }, stagingStarted: true,
          cleanup: { attempted: true, cleared: true },
          funnel: { raw: 442, deduped: 442, kept: 154, relevanceDropped: 0, ageDropped: 4, roleDropped: 281, historyDropped: 2, descriptionEvidenceDropped: 1 },
          sources: {
            ziprecruiter: {
              count: 442, providerGathered: 445, providerTotal: 499,
              relevanceDropped: 0, truncated: true, stopReason: 'provider-total-shortfall',
            },
          },
        }), 'utf8');
        Object.assign(telemetry, {
          nodeId, windowId: null,
          pipeline: { phase: 'completed', active: false, startedAt: Date.now() - 10_000, ts: Date.now(), runId },
          search: {
            ts: Date.now() - 9_000, queries: 1, raw: 442, deduped: 442, ageDropped: 4,
            roleDropped: 281, historyDropped: 2, relevanceDropped: 0, kept: 154, runId,
            bySource: {
              ziprecruiter: {
                count: 442, unique: 442, providerGathered: 445, claimedTotal: 499,
                unavailableDetailDropped: 3, pagesWalked: 24, truncated: true, stopReason: 'provider-total-shortfall',
              },
            },
          },
          resolves: {},
          scoring: { ts: Date.now() - 7_000, input: 154, selectedForScoring: 154, scored: 154, placeholders: 0, unscored: 0, batches: 11, failedBatches: 0 },
          bucketing: { ts: Date.now() - 6_000, input: 154, roleCount: 10, missing: 0, duplicated: 0, bandSummary: [], salaryRangeLabels: [], roleSummary: [], taxonomyAudit: [] },
          history: { boardDisplay: { input: 154, written: 153 } },
        });

        const assessment = buildJobCompletionAssessment(canvas, new Set([nodeId]), [{
          id: 'board-node-1', hubState: 'done', resultCount: 154, mergeUnique: 154,
          renderedCardCount: 154, combineSignature: `${nodeId}=test-fingerprint`,
          connectedSourceHubIds: [nodeId], stale: false,
        }]);

        assert(assessment.includes('⚠️ **INDETERMINATE**'), `expected incomplete coverage, got:\n${assessment}`);
        assert(assessment.includes('walk truncated before the result set ended')
          && assessment.includes('445 of 499 candidate identities')
          && assessment.includes('3 confirmed-unavailable detail listings dropped'),
        'claimed-total shortfall preserves partial rows/unavailable detail accounting without calling the empty page exhaustive');
        assert(!assessment.includes('no scroll-backed Google source'),
          'unqueried Google source note is omitted when other sources are present');

        // After restart, a matching receipt/snapshot can still prove that the
        // retained output was processed, but the durable ZipRecruiter source
        // fact proves collection itself stopped short. The scoped green output
        // verdict must state that concrete shortfall in its own headline rather
        // than softening it to generic missing live coverage.
        Object.assign(telemetry, {
          pipeline: null, search: null, scoring: null, bucketing: null,
          history: null, resolves: {},
        });
        const restartOnly = buildJobCompletionAssessment(canvas, new Set([nodeId]));
        assert(restartOnly.includes('✅ **DURABLE OUTPUT COMPLETE**')
          && restartOnly.includes('Known collection shortfall: `ziprecruiter` traversed 445 of 499 advertised candidate identities.')
          && restartOnly.includes('The saved output is complete only for the collected rows.'),
        `restart-only durable output must not conceal an observed collection shortfall, got:\n${restartOnly}`);
      } finally {
        Object.assign(telemetry, saved);
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return { ok: true };
    },
  },
  {
    name: 'job completion assessment infers an old ZipRecruiter empty-page total shortfall',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search,
        resolves: telemetry.resolves, scoring: telemetry.scoring, bucketing: telemetry.bucketing,
        pipeline: telemetry.pipeline, history: telemetry.history,
      };
      const dir = fs.mkdtempSync(path.join('/tmp', 'ic-completion-legacy-zr-'));
      const canvas = path.join(dir, 'canvas.json');
      const nodeId = 'completion-hub-legacy-zr';
      const runId = 'completion-run-legacy-zr-42';
      const analysisPaths = getJobAnalysisPaths(canvas, path.join(dir, 'analysis'));
      try {
        fs.writeFileSync(analysisPaths.jsonPath, JSON.stringify({
          runId, sourceHubId: nodeId, canvasFilePath: canvas, createdAt: Date.now(), jobs: [{}],
        }), 'utf8');
        // This is the durable shape written before `truncated` existed: its
        // empty page was falsely reported as exhaustive despite 22 advertised
        // candidate identities never being traversed.
        fs.writeFileSync(path.join(dir, 'canvas.jobs-last-run.json'), JSON.stringify({
          runId, nodeId, startedAt: Date.now() - 10_000, completedAt: Date.now(),
          terminal: { status: 'completed', outcome: 'populated', scoreReadyCount: 1 }, stagingStarted: true,
          cleanup: { attempted: true, cleared: true },
          funnel: { raw: 419, deduped: 419, kept: 1, relevanceDropped: 0, ageDropped: 0, roleDropped: 418, historyDropped: 0, descriptionEvidenceDropped: 0 },
          sources: {
            ziprecruiter: {
              count: 419, providerGathered: 422, providerTotal: 444,
              unavailableDetailDropped: 3, relevanceDropped: 0, stopReason: 'empty-page',
            },
          },
        }), 'utf8');
        Object.assign(telemetry, {
          nodeId, windowId: null,
          pipeline: { phase: 'completed', active: false, startedAt: Date.now() - 10_000, ts: Date.now(), runId },
          search: {
            ts: Date.now() - 9_000, queries: 1, raw: 419, deduped: 419, ageDropped: 0,
            roleDropped: 418, historyDropped: 0, relevanceDropped: 0, kept: 1, runId,
            bySource: {
              ziprecruiter: {
                count: 419, unique: 419, providerGathered: 422, claimedTotal: 444,
                unavailableDetailDropped: 3, pagesWalked: 23, stopReason: 'empty-page',
              },
            },
          },
          resolves: {},
          scoring: { ts: Date.now() - 7_000, input: 1, selectedForScoring: 1, scored: 1, placeholders: 0, unscored: 0, batches: 1, failedBatches: 0 },
          bucketing: { ts: Date.now() - 6_000, input: 1, roleCount: 1, missing: 0, duplicated: 0, bandSummary: [], salaryRangeLabels: [], roleSummary: [], taxonomyAudit: [] },
          history: { boardDisplay: { input: 1, written: 1 } },
        });

        const assessment = buildJobCompletionAssessment(canvas, new Set([nodeId]), [{
          id: 'board-node-legacy-zr', hubState: 'done', resultCount: 1, mergeUnique: 1,
          renderedCardCount: 1, combineSignature: `${nodeId}=test-fingerprint`,
          connectedSourceHubIds: [nodeId], stale: false,
        }]);
        const recovery = buildJobRecoverySnapshot(canvas, new Set([nodeId]));

        assert(assessment.includes('⚠️ **INDETERMINATE**')
          && assessment.includes('walk truncated before the result set ended')
          && assessment.includes('422 of 444 candidate identities')
          && assessment.includes('3 confirmed-unavailable detail listings dropped'),
        `old receipt must remain incomplete, got:\n${assessment}`);
        assert(recovery.includes('walk hit an empty page before the provider’s verified advertised total; coverage is incomplete')
          && !recovery.includes('traversed all 422 reachable candidate identities'),
        `old receipt must not be labelled lossless, got:\n${recovery}`);
      } finally {
        Object.assign(telemetry, saved);
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return { ok: true };
    },
  },
  {
    name: 'an aborted search reports its inputs and the real cancel cause',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search,
        searchIntent: telemetry.searchIntent, resolves: telemetry.resolves, scoring: telemetry.scoring,
        bucketing: telemetry.bucketing, pipeline: telemetry.pipeline, history: telemetry.history,
      };
      const nodeId = 'aborted-search-hub';
      try {
        // `search` is stamped only when the FUNNEL finishes, so an aborted
        // gather reported "no search recorded this session" for a run whose own
        // log proves it launched with 1 query across 9 sources. `searchIntent`
        // is stamped at launch and survives the abort.
        Object.assign(telemetry, {
          nodeId, search: null, resolves: {}, scoring: null, bucketing: null, history: null,
          pipeline: {
            runId: `${nodeId}-1`, phase: 'aborted', active: false,
            // Every node-scoped abort shares one sentinel message ("Node
            // deleted"), so a user's Reset used to be reported as a deletion of
            // a node that is still on the canvas. jobs.js now resolves the
            // renderer-supplied cause to this label instead.
            error: 'Cancelled by user — clicked Reset on this hub',
          },
          searchIntent: {
            ts: Date.now(), runId: `${nodeId}-1`, nodeId, runOrigin: 'initial',
            profileInputMode: 'fresh-files', queries: 1, queryStrings: ['System Architect'],
            selectedSourceIds: ['google', 'linkedin', 'ziprecruiter'],
            maxAgeDays: 14, collectionLimits: {}, location: 'United States',
          },
        });
        const pipeline = buildJobsPipelineSnapshot(new Set([nodeId]), null, null);
        assert(!pipeline.includes('no search recorded this session'),
          `an aborted search must not report as no search at all, got:\n${pipeline.slice(0, 900)}`);
        assert(pipeline.includes('This search launched but never reached the funnel stage')
          && pipeline.includes('so no raw/deduped/kept counts exist'),
          'the aborted search states what it is missing rather than implying nothing ran');
        assert(pipeline.includes('1 query: `System Architect`')
          && pipeline.includes('3 selected source(s): `google`, `linkedin`, `ziprecruiter`')
          && pipeline.includes('Max posting age 14d · location `United States`'),
          `the launch inputs survive the abort, got:\n${pipeline.slice(0, 1200)}`);
        assert(pipeline.includes('Last stage error: `Cancelled by user — clicked Reset on this hub`')
          && !pipeline.includes('Last stage error: `Node deleted`'),
          'a user Reset is never reported as a deleted node');

        // With no intent retained (e.g. scoring resumed from a captcha-resolve)
        // the original honest line is still the right answer. Keep a pipeline
        // stamp so the section still renders at all — an empty telemetry store
        // omits the whole section by design.
        Object.assign(telemetry, {
          searchIntent: null,
          pipeline: { runId: `${nodeId}-2`, phase: 'completed', active: false },
        });
        assert(buildJobsPipelineSnapshot(new Set([nodeId]), null, null).includes('no search recorded this session'),
          'a session that recorded no search and retained no launch intent still says so');
      } finally {
        Object.assign(telemetry, saved);
      }

      // Source pins: the cause must be produced by the renderer and resolved to
      // a label by the backend, or the report falls back to the shared sentinel.
      const preload = fs.readFileSync(path.resolve('electron/preload.js'), 'utf8');
      const network = fs.readFileSync(path.resolve('electron/ipc/network.js'), 'utf8');
      const ipcUtilsSource = fs.readFileSync(path.resolve('electron/ipc/ipcUtils.js'), 'utf8');
      const jobsSource = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
      const jobSearchSource = fs.readFileSync(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8');
      assert(preload.includes("cancelNodeTask: (nodeId, cause = null) => ipcRenderer.send('cancel-node-task', nodeId, cause)")
        && network.includes('abortNodeTasks(nodeId, event.sender, nodeCancellationError(cause))'),
        'the renderer-supplied cancel cause reaches abortNodeTasks');
      assert(ipcUtilsSource.includes("Object.assign(new Error(message), { name: 'AbortError' })")
        && ipcUtilsSource.includes("return cancellationError('Node deleted', cause);"),
        'the cancel sentinel keeps its load-bearing message while identifying itself as an abort');
      assert(jobsSource.includes('CANCEL_CAUSE_LABELS[reason?.cancelCause]')
        && jobsSource.includes("'user-reset': 'Cancelled by user — clicked Reset on this hub'"),
        'the pipeline stage error prefers the stated cause over the shared sentinel');
      assert(/\? 'reanalysis-cancelled'\s*:\s*'user-reset';/.test(jobSearchSource)
        && jobSearchSource.includes('cancelNodeTask?.(id, cancellationReason)')
        && jobSearchSource.includes("cancelNodeTask?.(id, 'career-files-cleared')"),
        'Job Search names why both acknowledged and fire-and-forget cancellations happened');
      // Every cancel site must name a cause, or that hub's aborted run falls
      // back to the shared sentinel and reports a Reset as a deleted node.
      const sellHubSource = fs.readFileSync(path.resolve('src/nodes/SellHubNode.jsx'), 'utf8');
      const canvasInteractions = fs.readFileSync(path.resolve('src/utils/canvasInteractions.js'), 'utf8');
      const boardSourceForCancel = fs.readFileSync(path.resolve('src/nodes/JobBoardNode.jsx'), 'utf8');
      for (const [label, source] of [
        ['SellHub', sellHubSource], ['Job Board', boardSourceForCancel],
        ['recursive deletion', canvasInteractions], ['Job Search', jobSearchSource],
      ]) {
        assert(!/cancelNodeTask\?\.\((?:id|n\.id)\)/.test(source),
          `${label} must pass a cancel cause, not the bare sentinel`);
      }
      assert(canvasInteractions.includes("cancelNodeTask?.(n.id, 'node-deleted')"),
        'the recursive deletion helper is the one caller whose cancel really is a deletion');
      // Same class as the safeApiFetch defect: classify a cancellation from the
      // signal, never from the error prose — the sentinel says "Node deleted".
      const nonApiAiSource = fs.readFileSync(path.resolve('electron/ipc/nonApiAi.js'), 'utf8');
      assert(nonApiAiSource.includes('if (signal?.aborted) throw signal.reason || new Error')
        && nonApiAiSource.includes("record.abortListener = () => abortPending(record, signal?.reason || new Error('Operation cancelled'));"),
        'a cancelled manual-handoff AI request is classified from the abort signal itself, not from parsed error prose');
      assert(jobsSource.includes('jobsTelemetry.searchIntent = {')
        && jobsSource.includes('jobsTelemetry.searchIntent = null;'),
        'the search intent is stamped at launch and cleared for a fresh run');
      return { ok: true };
    },
  },
  {
    name: 'a later run on another hub does not turn a completed run INDETERMINATE',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search,
        searchIntent: telemetry.searchIntent, resolves: telemetry.resolves, scoring: telemetry.scoring,
        bucketing: telemetry.bucketing, pipeline: telemetry.pipeline, history: telemetry.history,
      };
      const dir = fs.mkdtempSync(path.join('/tmp', 'ic-foreign-live-run-'));
      const canvas = path.join(dir, 'canvas.json');
      // Hub A finished; hub B started a second search and the user stopped it.
      // `jobsTelemetry` is a process-global re-stamped by whichever hub starts
      // LAST, so hub B's aborted pipeline used to be compared against hub A's
      // durable receipt and reported as "run tokens disagree" — and hub B's
      // never-combined board was named as hub A's missing consumer.
      const hubA = 'completed-hub-a';
      const hubB = 'stopped-hub-b';
      const runA = `${hubA}-1788724953082`;
      const runB = `${hubB}-1788738847578`;
      const analysisPaths = getJobAnalysisPaths(canvas, path.join(dir, 'analysis'));
      try {
        fs.writeFileSync(analysisPaths.jsonPath, JSON.stringify({
          runId: runA, sourceHubId: hubA, canvasFilePath: canvas, createdAt: Date.now(),
          jobs: [{}, {}, {}],
        }), 'utf8');
        fs.writeFileSync(path.join(dir, 'canvas.jobs-last-run.json'), JSON.stringify({
          runId: runA, nodeId: hubA,
          terminal: { status: 'completed', outcome: 'populated', scoreReadyCount: 3 },
          scoring: { selected: 3, scored: 3, placeholders: 0, unscored: 0, failedBatches: 0 },
          cleanup: { attempted: true, cleared: true },
          sources: {
            // gathered ABOVE the advertised total: a provider revises its own
            // estimate while paginating, so "traversed 158 of 157" was a
            // nonsense ratio printed under a ✅.
            ziprecruiter: { count: 4, providerGathered: 6, providerTotal: 5, stopReason: 'empty-page' },
            glassdoor: { count: 9, providerGathered: 9, stopReason: 'completed' },
          },
        }), 'utf8');
        Object.assign(telemetry, {
          nodeId: hubB, search: null, searchIntent: null, resolves: {}, scoring: null,
          bucketing: null, history: null,
          pipeline: { runId: runB, phase: 'aborted', active: false, error: 'Cancelled by user — clicked Reset on this hub' },
        });

        const boards = [
          { id: 'board-of-a', hubState: 'empty', resultCount: 0, renderedCardCount: 0, stale: false, connectedSourceHubIds: [hubA] },
          { id: 'board-of-b', hubState: 'empty', resultCount: null, renderedCardCount: 0, stale: false, connectedSourceHubIds: [hubB] },
        ];
        const assessment = buildJobCompletionAssessment(canvas, new Set([hubA, hubB]), boards, boards.length);

        assert(assessment.includes('✅ **DURABLE OUTPUT COMPLETE**') && !assessment.includes('INDETERMINATE'),
          `a completed run stays completed when another hub's run is stopped, got:\n${assessment}`);
        assert(!assessment.includes('run tokens disagree')
          && assessment.includes('- Run correlation: ✅ receipt + snapshot agree'),
          'another hub’s run token is not a second opinion about this run');
        assert(assessment.includes('Separate later run in this process: hub `')
          && assessment.includes('reached phase `aborted`')
          && assessment.includes('Cancelled by user — clicked Reset on this hub'),
          'the stopped run is reported as its own fact, with the real cancel cause rather than the shared sentinel');
        assert(assessment.includes('Live search stage: not retained for this run'),
          'another hub’s phase is never presented as this run’s gather stage');
        // The board that actually consumed hub A must be the one assessed.
        assert(/`board-of…[a-f0-9]+` is `empty`/.test(assessment)
          && !assessment.includes('board-of-a') && !assessment.includes('board-of-b'),
          `the connected board of the assessed hub is named through its redacted label, not the other hub’s board, got:\n${assessment}`);
        assert(assessment.includes('Combine can still render them without re-scraping'),
          'an unconsumed board states that the score-ready rows are recoverable');
        assert(assessment.includes('✅ `ziprecruiter` traversed all 6 candidate identities (provider advertised ~5)')
          && !assessment.includes('traversed 6 of 5'),
          `an over-count reads as a traversal fact plus an estimate, got:\n${assessment}`);
        assert(assessment.includes('`glassdoor` reported no candidate corpus size — coverage unproven (9 traversed; walk ended at `completed`)'),
          'an unproven source still states the traversal and stop reason it did observe');

        // Same-node token drift is a real bug signal and must still fire.
        Object.assign(telemetry, { nodeId: hubA, pipeline: { runId: 'drifted-token', phase: 'completed', active: false } });
        const sameNode = buildJobCompletionAssessment(canvas, new Set([hubA]), [], 0);
        assert(sameNode.includes('⚠️ **INDETERMINATE**') && sameNode.includes('run tokens disagree'),
          'a token mismatch on the SAME hub is still reported as a disagreement');
      } finally {
        Object.assign(telemetry, saved);
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return { ok: true };
    },
  },
  {
    name: 'completion assessment distinguishes revealed, country-inapplicable, and user-accepted source limits',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search,
        resolves: telemetry.resolves, scoring: telemetry.scoring, bucketing: telemetry.bucketing,
        pipeline: telemetry.pipeline, history: telemetry.history,
      };
      const dir = fs.mkdtempSync(path.join('/tmp', 'ic-completion-source-limits-'));
      const canvas = path.join(dir, 'canvas.json');
      const nodeId = 'completion-source-limits-hub';
      const runId = 'completion-source-limits-run';
      const analysisPaths = getJobAnalysisPaths(canvas, path.join(dir, 'analysis'));
      try {
        fs.writeFileSync(analysisPaths.jsonPath, JSON.stringify({
          runId, sourceHubId: nodeId, canvasFilePath: canvas, jobs: [{}, {}],
        }), 'utf8');
        fs.writeFileSync(path.join(dir, 'canvas.jobs-last-run.json'), JSON.stringify({
          runId, nodeId,
          terminal: { status: 'completed', outcome: 'populated', scoreReadyCount: 2 },
          cleanup: { attempted: true, cleared: true },
          sources: {
            google: {
              count: 2, providerGathered: 2, stopReason: 'completed',
              revealOutcomes: [
                { queryIndex: 1, queryTotal: 2, exit: 'end-of-list', count: 1, iterations: 1 },
                { queryIndex: 2, queryTotal: 2, exit: 'end-of-list', count: 1, iterations: 1 },
              ],
            },
            dice: { count: 0, providerGathered: 0, warning: { code: 'country-source-skipped', severity: 'info' } },
            ziprecruiter: { count: 0, providerGathered: 0, stopReason: 'empty-page', warning: { code: 'description-detail-hard-block', severity: 'block' } },
            glassdoor: { count: 2, providerGathered: 2, stopReason: 'empty-page', locationScopeUnenforced: true },
          },
        }), 'utf8');
        Object.assign(telemetry, {
          nodeId, windowId: null,
          pipeline: { phase: 'completed', active: false, runId },
          search: {
            runId, kept: 2,
            bySource: {
              google: {
                count: 2, providerGathered: 2, stopReason: 'completed',
                revealOutcomes: [
                  { queryIndex: 1, queryTotal: 2, exit: 'end-of-list', count: 1, iterations: 1 },
                  { queryIndex: 2, queryTotal: 2, exit: 'end-of-list', count: 1, iterations: 1 },
                ],
              },
              dice: { count: 0, providerGathered: 0, warning: { code: 'country-source-skipped', severity: 'info' } },
              ziprecruiter: { count: 0, providerGathered: 0, stopReason: 'empty-page', warning: { code: 'description-detail-hard-block', severity: 'block' } },
              glassdoor: { count: 2, providerGathered: 2, stopReason: 'empty-page', locationScopeUnenforced: true },
            },
          },
          resolves: {},
          scoring: { selectedForScoring: 2, scored: 2, placeholders: 0, unscored: 0, failedBatches: 0 },
          bucketing: { input: 2, missing: 0, duplicated: 0 },
          history: null,
        });
        const assessment = buildJobCompletionAssessment(canvas, new Set([nodeId]));
        assert(assessment.includes('✅ **COMPLETED WITH COLLECTION QUALIFICATIONS**')
          && assessment.includes('`ziprecruiter` (description-detail-hard-block)')
          && assessment.includes('`glassdoor` country scope is region-unverified; retained rows were not discarded')
          && assessment.includes('`google` traversed all 2 reachable candidate identities (all scroll queries reached end-of-list)')
          && assessment.includes('`dice` intentionally skipped — not applicable to the selected country scope')
          && !assessment.includes('Gather completeness is unproven for 3 source(s)')
          && !assessment.includes('`google` reported no candidate corpus size — coverage unproven')
          && !assessment.includes('`dice` reported no candidate corpus size — coverage unproven')
          && assessment.includes('terminal receipt is durable proof of the scoring output, while taxonomy and Job Board consumption are reconciled separately below'),
        'end-of-list reveal is reachability proof, country-excluded sources are not coverage misses, and accepted hard blocks or nation-tier scope caveats qualify rather than erase a completed result');

        // A clean post-search recovery supersedes the initial block warning. It
        // must not leave an accepted-limitation badge in the completion headline
        // merely because the durable receipt preserves the original warning.
        telemetry.resolves = {
          ziprecruiter: { ts: Date.now() + 1, resolved: true, kept: 0 },
        };
        const resolved = buildJobCompletionAssessment(canvas, new Set([nodeId]));
        assert(resolved.includes('✅ **COMPLETED WITH COLLECTION QUALIFICATIONS**')
          && !resolved.includes('Completed with accepted source limitation')
          && resolved.includes('`glassdoor` country scope is region-unverified'),
        'a later clean source recovery clears the accepted-block qualifier while preserving the independent region-scope qualification');
      } finally {
        Object.assign(telemetry, saved);
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return { sources: 3 };
    },
  },
  {
    name: 'completion assessment qualifies an otherwise green run with no retained per-source coverage',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search,
        resolves: telemetry.resolves, scoring: telemetry.scoring, bucketing: telemetry.bucketing,
        pipeline: telemetry.pipeline, history: telemetry.history,
      };
      const dir = fs.mkdtempSync(path.join('/tmp', 'ic-completion-no-coverage-'));
      const canvas = path.join(dir, 'canvas.json');
      const nodeId = 'completion-no-coverage-hub';
      const runId = 'completion-no-coverage-run';
      const analysisPaths = getJobAnalysisPaths(canvas, path.join(dir, 'analysis'));
      try {
        fs.writeFileSync(analysisPaths.jsonPath, JSON.stringify({
          runId, sourceHubId: nodeId, canvasFilePath: canvas, jobs: [{}],
        }), 'utf8');
        fs.writeFileSync(path.join(dir, 'canvas.jobs-last-run.json'), JSON.stringify({
          runId, nodeId,
          terminal: { status: 'completed', outcome: 'populated', scoreReadyCount: 1 },
          cleanup: { attempted: true, cleared: true }, sources: {},
        }), 'utf8');
        Object.assign(telemetry, {
          nodeId, windowId: null,
          pipeline: { phase: 'completed', active: false, runId },
          search: { runId, kept: 1, bySource: {} }, resolves: {},
          scoring: { selectedForScoring: 1, scored: 1, placeholders: 0, unscored: 0, failedBatches: 0 },
          bucketing: { input: 1, missing: 0, duplicated: 0 }, history: null,
        });
        const assessment = buildJobCompletionAssessment(canvas, new Set([nodeId]));
        assert(assessment.includes('✅ **COMPLETED WITH COLLECTION QUALIFICATIONS**')
          && assessment.includes('No per-source gather coverage was retained, so this verdict covers the stages after collection.')
          && !assessment.includes('✅ **VERIFIED COMPLETE**'),
        `an otherwise green run without coverage must be qualified, got:\n${assessment}`);
      } finally {
        Object.assign(telemetry, saved);
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return { qualified: true };
    },
  },
  {
    name: 'completion assessment qualifies an otherwise green run with a country-inapplicable enabled source',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search,
        resolves: telemetry.resolves, scoring: telemetry.scoring, bucketing: telemetry.bucketing,
        pipeline: telemetry.pipeline, history: telemetry.history,
      };
      const dir = fs.mkdtempSync(path.join('/tmp', 'ic-completion-country-skipped-'));
      const canvas = path.join(dir, 'canvas.json');
      const nodeId = 'completion-country-skipped-hub';
      const runId = 'completion-country-skipped-run';
      const analysisPaths = getJobAnalysisPaths(canvas, path.join(dir, 'analysis'));
      const sources = {
        ziprecruiter: { count: 1, providerGathered: 1, stopReason: 'empty-page' },
        dice: { count: 0, providerGathered: 0, warning: { code: 'country-source-skipped', severity: 'info' } },
      };
      try {
        fs.writeFileSync(analysisPaths.jsonPath, JSON.stringify({
          runId, sourceHubId: nodeId, canvasFilePath: canvas, jobs: [{}],
        }), 'utf8');
        fs.writeFileSync(path.join(dir, 'canvas.jobs-last-run.json'), JSON.stringify({
          runId, nodeId,
          terminal: { status: 'completed', outcome: 'populated', scoreReadyCount: 1 },
          cleanup: { attempted: true, cleared: true }, sources,
        }), 'utf8');
        Object.assign(telemetry, {
          nodeId, windowId: null,
          pipeline: { phase: 'completed', active: false, runId },
          search: { runId, kept: 1, bySource: sources }, resolves: {},
          scoring: { selectedForScoring: 1, scored: 1, placeholders: 0, unscored: 0, failedBatches: 0 },
          bucketing: { input: 1, missing: 0, duplicated: 0 }, history: null,
        });
        const assessment = buildJobCompletionAssessment(canvas, new Set([nodeId]));
        assert(assessment.includes('✅ **COMPLETED WITH COLLECTION QUALIFICATIONS**')
          && assessment.includes('`dice` was intentionally skipped as not applicable to the selected country scope')
          && assessment.includes('Every applicable source traversed its full reachable candidate set.')
          && !assessment.includes('✅ **VERIFIED COMPLETE**'),
        `a country-skipped enabled source must qualify an otherwise green run, got:\n${assessment}`);
      } finally {
        Object.assign(telemetry, saved);
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return { qualified: true };
    },
  },
  {
    name: 'completion assessment accepts only clean configured collection caps as bounded coverage',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search,
        pipeline: telemetry.pipeline, resolves: telemetry.resolves, scoring: telemetry.scoring,
        bucketing: telemetry.bucketing, history: telemetry.history,
      };
      const dir = fs.mkdtempSync(path.join('/tmp', 'ic-configured-cap-completion-'));
      const canvas = path.join(dir, 'canvas.json');
      const nodeId = 'configured-cap-hub';
      const runId = 'configured-cap-run';
      const analysisPaths = getJobAnalysisPaths(canvas, path.join(dir, 'analysis'));
      try {
        fs.writeFileSync(analysisPaths.jsonPath, JSON.stringify({
          runId, sourceHubId: nodeId, canvasFilePath: canvas, jobs: [{}, {}, {}],
        }), 'utf8');
        fs.writeFileSync(path.join(dir, 'canvas.jobs-last-run.json'), JSON.stringify({
          runId, nodeId, terminal: { status: 'completed', outcome: 'populated', scoreReadyCount: 3 },
          cleanup: { attempted: true, cleared: true }, sources: {},
        }), 'utf8');
        const cappedSource = {
          count: 3, providerGathered: 3, providerTotal: 99,
          stopReason: 'jobs-per-platform/provider-total', cap: { type: 'jobs-per-platform', limit: 3 },
        };
        Object.assign(telemetry, {
          nodeId, windowId: null,
          pipeline: { phase: 'completed', active: false, runId },
          search: { runId, kept: 3, bySource: { dice: cappedSource } },
          resolves: {},
          scoring: { selectedForScoring: 3, scored: 3, placeholders: 0, unscored: 0, failedBatches: 0 },
          bucketing: { input: 3, missing: 0, duplicated: 0 }, history: null,
        });
        const bounded = buildJobCompletionAssessment(canvas, new Set([nodeId]));
        assert(bounded.includes('✅ **COMPLETED WITH COLLECTION QUALIFICATIONS**')
          && bounded.includes('stopped at an explicit configured collection cap (`dice` jobs-per-platform=3)')
          && bounded.includes('collection intentionally bounded'),
        'a structured configured cap with its matching sole stop reason verifies collected output while qualifying full-corpus coverage');

        // API fan-out can hit a per-query cap before the final aggregate source
        // slice. Both stop tokens are expected evidence, not an API failure.
        telemetry.search.bySource.dice = {
          count: 3, providerGathered: 12, providerTotal: 99,
          stopReason: 'jobs-per-platform', cap: { type: 'jobs-per-platform', limit: 3 },
        };
        const outerBounded = buildJobCompletionAssessment(canvas, new Set([nodeId]));
        assert(outerBounded.includes('✅ **COMPLETED WITH COLLECTION QUALIFICATIONS**')
          && outerBounded.includes('stopped at an explicit configured collection cap (`dice` jobs-per-platform=3)')
          && outerBounded.includes('collection intentionally bounded'),
        'a final API aggregate slice must keep the same Jobs-per-platform cap and stop token even when each query itself stayed below that limit');

        telemetry.search.bySource.dice = {
          count: 3, providerGathered: 12, providerTotal: 99,
          stopReason: 'jobs-per-platform/pages-per-platform',
          cap: { type: 'jobs-per-platform', limit: 3 },
          caps: [{ type: 'jobs-per-platform', limit: 3 }, { type: 'pages-per-platform', limit: 2 }],
        };
        const mixedExplicitCaps = buildJobCompletionAssessment(canvas, new Set([nodeId]));
        assert(mixedExplicitCaps.includes('✅ **COMPLETED WITH COLLECTION QUALIFICATIONS**')
          && mixedExplicitCaps.includes('`dice` jobs-per-platform=3 + pages-per-platform=2')
          && mixedExplicitCaps.includes('configured jobs-per-platform cap 3 + pages-per-platform cap 2'),
        'distinct finite Dice Jobs and Pages caps across fan-out queries remain independently visible and qualify collected output');

        telemetry.search.bySource.dice = {
          count: 3, providerGathered: 12, providerTotal: 99, truncated: true,
          stopReason: 'jobs-per-platform/page-ceiling',
          cap: { type: 'jobs-per-platform', limit: 3 },
          caps: [{ type: 'jobs-per-platform', limit: 3 }],
        };
        const mixedSafetyCeiling = buildJobCompletionAssessment(canvas, new Set([nodeId]));
        assert(mixedSafetyCeiling.includes('⚠️ **INDETERMINATE**')
          && mixedSafetyCeiling.includes('`dice` traversed 12 of 99 candidate identities the provider advertised'),
        'a default safety page ceiling alongside a Jobs cap is not reclassified as configured-cap completion');

        telemetry.search.bySource.dice = { ...cappedSource, stopReason: 'jobs-per-platform/page-error' };
        const mixed = buildJobCompletionAssessment(canvas, new Set([nodeId]));
        assert(mixed.includes('⚠️ **INDETERMINATE**')
          && mixed.includes('`dice` traversed 3 of 99 candidate identities the provider advertised'),
        'a configured cap mixed with an API page error remains an observed incomplete walk');

        telemetry.search.bySource.dice = {
          count: 3, providerGathered: 3, stopReason: 'provider-total/short-page',
        };
        const cleanUnknownTotal = buildJobCompletionAssessment(canvas, new Set([nodeId]));
        assert(cleanUnknownTotal.includes('✅ **VERIFIED COMPLETE**')
          && cleanUnknownTotal.includes('Every source traversed its full reachable candidate set.')
          && cleanUnknownTotal.includes('`dice` traversed all 3 reachable candidate identities (ended at provider-total/short-page)')
          && !cleanUnknownTotal.includes('coverage unproven'),
        'a total-less API fan-out with only clean provider endings proves reachable exhaustion without inventing a provider corpus size');
      } finally {
        Object.assign(telemetry, saved);
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return { bounded: 3 };
    },
  },
  {
    name: 'job diagnostics label summed API pagination and configured Dice caps accurately',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search,
        pipeline: telemetry.pipeline, resolves: telemetry.resolves, scoring: telemetry.scoring,
        bucketing: telemetry.bucketing, compensation: telemetry.compensation, history: telemetry.history,
      };
      try {
        Object.assign(telemetry, {
          nodeId: 'dice-api-pages', windowId: null, pipeline: null, resolves: {}, scoring: null,
          bucketing: null, compensation: null, history: null,
          search: {
            ts: Date.now(), queries: 2, raw: 100, deduped: 100, kept: 100,
            ageDropped: 0, roleDropped: 0, historyDropped: 0, relevanceDropped: 0,
            bySource: {
              dice: {
                count: 100, unique: 100, providerGathered: 100, gathered: 100,
                pagesWalked: 6, stopReason: 'jobs-per-platform',
                cap: { type: 'jobs-per-platform', limit: 50 }, capOverflow: 0,
              },
            },
          },
        });
        const report = buildJobsPipelineSnapshot(new Set(['dice-api-pages']), null, null);
        assert(report.includes('`dice`: successfully fetched 6 pages across API fan-out queries → stopped: jobs-per-platform')
          && report.includes('stopped by the configured Jobs per platform limit (50); this is a user cap, not provider exhaustion'),
        'API pagination reports summed fan-out request pages and explains the configured cap without calling it an exhausted provider');

        telemetry.search.bySource.dice = {
          ...telemetry.search.bySource.dice,
          stopReason: 'pages-per-platform',
          cap: { type: 'pages-per-platform', limit: 2 },
          caps: [{ type: 'pages-per-platform', limit: 2 }],
        };
        const pageCapReport = buildJobsPipelineSnapshot(new Set(['dice-api-pages']), null, null);
        assert(pageCapReport.includes('`dice`: successfully fetched 6 pages across API fan-out queries → stopped: pages-per-platform')
          && pageCapReport.includes('stopped by the configured Pages per platform limit (2); this is a user cap, not provider exhaustion'),
        'an explicit API Pages cap is also counted as successfully fetched fan-out pages, not a browser walk');
        telemetry.search.bySource.dice.stopReason = 'provider-total/page-error';
        const mixedStopReport = buildJobsPipelineSnapshot(new Set(['dice-api-pages']), null, null);
        assert(mixedStopReport.includes('an API page request failed; later pages for that query were not collected')
          && !mixedStopReport.includes('API pagination reached the provider-reported total; page count is summed across fan-out queries'),
        'an API page error outranks a normal sibling provider-total stop in the rendered pagination verdict');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { apiPages: 6 };
    },
  },
  {
    name: 'job recovery labels the LinkedIn collection ceiling as app-internal',
    run: () => {
      const dir = fs.mkdtempSync(path.join('/tmp', 'ic-linkedin-internal-cap-'));
      const canvas = path.join(dir, 'canvas.json');
      const nodeId = 'linkedin-internal-cap';
      try {
        fs.writeFileSync(lastRunReceiptPathForCanvas(canvas, nodeId), JSON.stringify({
          runId: 'linkedin-cap-run', nodeId,
          terminal: { status: 'completed', outcome: 'populated', scoreReadyCount: 150 },
          cleanup: { attempted: true, cleared: true },
          sources: {
            linkedin: {
              count: 150, providerGathered: 150, relevanceDropped: 0, stopReason: 'result-ceiling',
              cap: { type: 'source-internal', limit: 150 },
            },
          },
        }), 'utf8');
        const report = buildJobRecoverySnapshot(canvas, new Set([nodeId]));
        assert(report.includes("app's internal LinkedIn per-query collection ceiling/enrichment budget 150")
          && !report.includes("source's own result ceiling"),
        'the LinkedIn 150 cap is identified as the app’s collection/enrichment budget, never a provider result ceiling');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return { limit: 150 };
    },
  },
  {
    name: 'competitive salary diagnostics reconcile role-band work separately from market cohorts',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search,
        pipeline: telemetry.pipeline, resolves: telemetry.resolves, scoring: telemetry.scoring,
        bucketing: telemetry.bucketing, compensation: telemetry.compensation, history: telemetry.history,
      };
      try {
        Object.assign(telemetry, {
          nodeId: 'role-band-salary-funnel', windowId: null, search: null, pipeline: null,
          resolves: {}, scoring: null, history: null,
          bucketing: {
            ts: Date.now(), input: 2, roleCount: 1, missing: 0, duplicated: 0,
            bandSummary: [], salaryRangeLabels: [], roleSummary: [],
            taxonomyAudit: [
              { index: 0, title: 'Duplicate range A', source: 'dice', rawSalary: '$195k–$230k/yr', annualSalary: 195000, salaryRangeMetadata: { lowerAnnual: 195000, upperAnnual: 230000 } },
              { index: 1, title: 'Duplicate range B', source: 'dice', rawSalary: '$195k–$230k/yr', annualSalary: 195000, salaryRangeMetadata: { lowerAnnual: 195000, upperAnnual: 230000 } },
            ],
          },
          compensation: {
            ts: Date.now(), scoredInput: 12, skippedBelowFit: 4, eligible: 8, minFitScore: 80,
            skippedNoLocation: 1, skippedNoCurrency: 1, preResearchCandidates: 4,
            skippedNoExperience: 2, skippedNoExperienceBand: 1,
            roleBandLookups: 4, roleBandResearches: 2, roleBandCacheHits: 2, roleBandFailures: 1,
            roleBandFailureJobs: 0, roleBandInterruptedJobs: 0, marketCandidates: 3,
            missingOffer: 3, recommendedNoOffer: 1, cohorts: 2, researched: 1,
            failedCohorts: 1, assessed: 3, cacheHits: 1, failures: [],
          },
        });
        const report = buildJobsPipelineSnapshot(new Set(['role-band-salary-funnel']), null, null);
        assert(report.includes('Fit-qualified partition: 8 job(s) = 1 no location + 1 no market currency + 2 no usable experience + 4 role-band candidate(s).')
          && report.includes('Role-band gate (before market cohorts): 4 candidate(s) = 1 not placeable in a role band + 0 interrupted during role-band preparation + 0 affected by failed role-band lookup(s) + 3 passed to market cohorts.')
          && report.includes('Role-band lookup work (separate from market cohorts): 4 role-family lookup(s) = 2 researched + 2 cache hit(s) · 1 of researched lookup(s) failed.')
          && report.includes('Market cohorts (after role-band work): 3 job(s) → 2 cohort(s) → researched 1, failed 1.')
          && report.includes('Jobs assessed: 3 · cache hit(s): 1')
          && report.split('salary range disclosed: $195,000–$230,000/yr. Kept the lower endpoint for deterministic placement.').length === 2,
        'salary diagnostics reconcile the new role-band counters without conflating lookup work with market cohorts or repeating identical audit-detail lines');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { roleBandLookups: 4, marketCohorts: 2 };
    },
  },
  {
    name: 'summarizeScoringInputQuality matches filterJobsByDescriptionEvidence normalization',
    run: () => {
      // 350 chars of text + 60 chars of whitespace = 410 raw chars, but collapses to 351 chars (< 400).
      const whitespaceJob = {
        source: 'ziprecruiter',
        title: 'Architect',
        snippet: 'word '.repeat(70) + '\n\n   \n\n' + 'tail '.repeat(10),
      };
      const evidence = filterJobsByDescriptionEvidence([whitespaceJob]);
      assert(evidence.dropped.length === 1, 'whitespace-inflated snippet is dropped by filterJobsByDescriptionEvidence');
      assert(evidence.quality.short === 1, `quality summary must record short=1, got ${JSON.stringify(evidence.quality)}`);
      assert(evidence.quality.empty === 0 && evidence.quality.deferred === 0, 'non-empty dropped job is not empty or deferred');

      // Job with description instead of snippet
      const descJob = {
        source: 'ziprecruiter',
        title: 'Short Desc Architect',
        description: 'Only 50 chars in description field for this test.',
      };
      const descEvidence = filterJobsByDescriptionEvidence([descJob]);
      assert(descEvidence.dropped.length === 1, 'short description is dropped');
      assert(descEvidence.quality.short === 1, `quality summary records short=1 for description field, got ${JSON.stringify(descEvidence.quality)}`);
      return { ok: true };
    },
  },
{
    name: 'Report trails fold identical repeats so a stuck loop cannot evict distinct evidence',
    run: () => {
      // A wedged recovery pass re-emitted the SAME Google reveal outcome nine
      // times. Because the trail is bounded by COUNT, the bounded window filled
      // with copies and the report printed six identical lines above "3 earlier
      // reveal outcome(s) omitted" — the three distinct source outcomes that
      // actually mattered had been evicted by the repetition.
      const signature = e => `${e.sourceId}|${e.count}|${e.iterations}|${e.exit}`;
      const distinct = [
        { sourceId: 'ziprecruiter', count: 268, iterations: 15, exit: 'end-of-list' },
        { sourceId: 'indeed', count: 35, iterations: 2, exit: 'plateau' },
        { sourceId: 'glassdoor', count: 722, iterations: 25, exit: 'end-of-list' },
      ];
      const stuck = Array.from({ length: 9 }, () => ({ sourceId: 'google', count: 71, iterations: 3, exit: 'end-of-list' }));
      const folded = collapseConsecutiveIdentical([...distinct, ...stuck], signature);
      assert(folded.length === 4 && folded[3].occurrences === 9,
        `nine identical outcomes must fold into one entry carrying its count, got ${JSON.stringify(folded.map(f => f.occurrences))}`);
      const window = folded.slice(-6).map(f => f.entry.sourceId);
      assert(['ziprecruiter', 'indeed', 'glassdoor', 'google'].every(id => window.includes(id)),
        `every distinct source must survive the bounded window, got ${window.join(',')}`);
      // Folding must be consecutive-only: an interleaved different entry proves
      // the collapse never reorders or merges across a genuine change.
      const interleaved = collapseConsecutiveIdentical([stuck[0], distinct[0], stuck[0]], signature);
      assert(interleaved.length === 3 && interleaved.every(f => f.occurrences === 1),
        'a differing entry between two identical ones must break the run rather than merge them');
      // The newest member of a run is the one rendered, so its timing is current.
      const timed = collapseConsecutiveIdentical(
        [{ sourceId: 'google', count: 71, ts: 1 }, { sourceId: 'google', count: 71, ts: 2 }],
        e => `${e.sourceId}|${e.count}`,
      );
      assert(timed.length === 1 && timed[0].entry.ts === 2,
        'a folded run must render its most recent occurrence, not its first');
      return { folded: folded.length, repeats: folded[3].occurrences };
    },
  },
{
    name: 'Post-completion recovery count reports passes, not the number of sources',
    run: () => {
      // `resolves[sourceId]` is last-write-wins, so counting rows counted a
      // SOURCE per recovery. A real run re-walked Google ~13 times and reported
      // "superseded by 2 post-completion recovery attempts".
      const completedAt = 1_000;
      const pipeline = { active: false, ts: completedAt };
      const stamps = n => Array.from({ length: n }, (_, i) => completedAt + 10 + i);
      const perPass = postPipelineRecoveryAttemptCount({
        resumeAttempts: {}, linkedinEnrich: [],
        resolves: {
          google: { ts: completedAt + 500, passTimestamps: stamps(13) },
          glassdoor: { ts: completedAt + 200, passTimestamps: stamps(1) },
        },
      }, pipeline);
      assert(perPass.count === 14 && perPass.atLeast === false,
        `each recorded pass must be counted, got ${JSON.stringify(perPass)}`);
      // Passes that ran BEFORE completion are not post-completion recoveries.
      const mixed = postPipelineRecoveryAttemptCount({
        resumeAttempts: {}, linkedinEnrich: [],
        resolves: { google: { ts: completedAt + 5, passTimestamps: [completedAt - 50, completedAt - 10, completedAt + 5] } },
      }, pipeline);
      assert(mixed.count === 1, `only passes after completion count, got ${JSON.stringify(mixed)}`);
      // Telemetry captured before the trail existed must still count as one.
      const legacy = postPipelineRecoveryAttemptCount({
        resumeAttempts: {}, linkedinEnrich: [], resolves: { google: { ts: completedAt + 5 } },
      }, pipeline);
      assert(legacy.count === 1, `a legacy row without a trail still counts once, got ${JSON.stringify(legacy)}`);
      // A saturated trail is a FLOOR, not a fact — the report must say so.
      const saturated = postPipelineRecoveryAttemptCount({
        resumeAttempts: {}, linkedinEnrich: [],
        resolves: { google: { ts: completedAt + 5, passTimestamps: stamps(50) } },
      }, pipeline);
      assert(saturated.count === 50 && saturated.atLeast === true,
        `a full trail whose every stamp is post-completion must be flagged as a floor, got ${JSON.stringify(saturated)}`);
      return { perPass: perPass.count, saturated: saturated.atLeast };
    },
  },
{
    name: 'Saved bug reports survive restarts, then age/count prune without blanket-deleting the directory',
    run: async () => {
      __resetSavedBugReportPruneForTests();
      const dir = savedBugReportDir();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });

      // Startup pruning must retain a recent report pointer across a restart,
      // while removing expired app-owned reports. It must be surgical: a file
      // a user or another tool dropped in there is not ours to delete.
      fs.writeFileSync(path.join(dir, 'bug-report-2020-01-01T00-00-00-000Z.md'), 'stale', 'utf8');
      fs.writeFileSync(path.join(dir, 'bug-report-2020-01-02T00-00-00-000Z.md'), 'stale', 'utf8');
      const freshPath = path.join(dir, 'bug-report-2026-09-07T21-07-14-174Z.md');
      fs.writeFileSync(freshPath, 'fresh pointer target', 'utf8');
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep me', 'utf8');
      const expiredAt = new Date(Date.now() - SAVED_REPORT_MAX_AGE_MS - 1_000);
      fs.utimesSync(path.join(dir, 'bug-report-2020-01-01T00-00-00-000Z.md'), expiredAt, expiredAt);
      fs.utimesSync(path.join(dir, 'bug-report-2020-01-02T00-00-00-000Z.md'), expiredAt, expiredAt);
      const pruned = await pruneSavedBugReports();
      assert(pruned.removed === 2 && !pruned.error,
        `startup pruning should remove exactly the expired reports, got ${JSON.stringify(pruned)}`);
      // Pruning intentionally resolves operational failures as `{ error }` so
      // startup can remain fire-and-forget. main.js must log that resolved
      // branch rather than relying only on Promise.catch, which never sees it.
      const mainSource = fs.readFileSync(path.join(process.cwd(), 'electron/main.js'), 'utf8');
      assert(mainSource.includes('if (r.error) logger.warn(`[BugReport] could not prune saved reports: ${r.error}`);')
        && mainSource.includes('else if (r.removed > 0) logger.info(`[BugReport] pruned ${r.removed} expired/excess saved report(s)`);'),
      'startup report retention must log resolved prune errors while retaining successful-removal telemetry');
      assert(fs.existsSync(path.join(dir, 'notes.txt')),
        'pruning must never remove a file it did not write');
      assert(fs.existsSync(freshPath),
        'a recent report pointer must survive startup pruning and remain readable after restart');

      // The cutoff is strictly older than seven days: a report exactly at the
      // boundary remains until a later cleanup observes it as older. Freeze the
      // clock so a few milliseconds spent in this test cannot blur that contract.
      const boundaryPath = path.join(dir, 'bug-report-seven-day-boundary.md');
      const requestedBoundaryNow = Date.now();
      fs.writeFileSync(boundaryPath, 'seven-day boundary', 'utf8');
      fs.utimesSync(
        boundaryPath,
        new Date(requestedBoundaryNow - SAVED_REPORT_MAX_AGE_MS),
        new Date(requestedBoundaryNow - SAVED_REPORT_MAX_AGE_MS),
      );
      // Docker/overlay filesystems may quantize the requested timestamp. Base
      // the frozen clock on the value that was actually persisted so this is
      // an exact-boundary test on every supported filesystem.
      const boundaryNow = fs.statSync(boundaryPath).mtimeMs + SAVED_REPORT_MAX_AGE_MS;
      const realDateNow = Date.now;
      try {
        Date.now = () => boundaryNow;
        const boundaryPrune = await pruneSavedBugReports();
        assert(!boundaryPrune.error && fs.existsSync(boundaryPath),
          'a report exactly seven days old must not be pruned by the strictly-older retention cutoff');
      } finally {
        Date.now = realDateNow;
      }
      fs.rmSync(boundaryPath, { force: true });

      // A missing directory is the normal first-run state, not an error.
      __resetSavedBugReportPruneForTests();
      fs.rmSync(dir, { recursive: true, force: true });
      const onMissing = await pruneSavedBugReports();
      assert(onMissing.removed === 0 && !onMissing.error,
        `pruning an absent directory must succeed quietly, got ${JSON.stringify(onMissing)}`);

      // Within one long session a user can generate many reports; on a writable
      // disk, count retention bounds that without waiting for the next app start.
      __resetSavedBugReportPruneForTests();
      const written = [];
      for (let i = 0; i < SAVED_REPORT_RETENTION + 5; i++) {
        written.push(await writeSavedBugReport(`# Report ${i}\nbody ${i}\n`, {}));
      }
      const remaining = fs.readdirSync(dir).filter(f => /^bug-report-.*\.md$/.test(f));
      assert(remaining.length === SAVED_REPORT_RETENTION,
        `retention should bound in-session growth to ${SAVED_REPORT_RETENTION}, got ${remaining.length}`);
      assert(fs.existsSync(written.at(-1).filePath),
        'the most recent report must never be the one pruned');
      // Distinct filenames, so two reports in the same session cannot clobber
      // each other and a pointer can never name a file holding another report.
      assert(new Set(written.map(w => w.filePath)).size === written.length,
        'every saved report must claim its own filename');

      const body = '# Bug Report\nline two\nline three\n';
      const saved = await writeSavedBugReport(body, {});
      assert(fs.readFileSync(saved.filePath, 'utf8') === body
        && saved.bytes === Buffer.byteLength(body) && saved.chars === body.length,
      'the saved file must contain exactly the report it was given, with accurate byte and character counts');
      // Multi-byte content is where the two counts diverge — the pointer reports
      // characters, so the write must expose both rather than conflating them.
      const accented = await writeSavedBugReport('# Rapport — Montréal\n', {});
      assert(accented.bytes > accented.chars,
        `byte and character counts must be tracked separately for multi-byte content, got ${JSON.stringify(accented)}`);

      fs.rmSync(dir, { recursive: true, force: true });
      __resetSavedBugReportPruneForTests();
      return { retention: SAVED_REPORT_RETENTION, remaining: remaining.length };
    },
  },
{
    name: 'Clipboard pointer names the file and stays short instead of carrying the report',
    run: () => {
      // The pointer exists so an AI reads the report from disk in segments. It
      // must therefore say WHERE, HOW BIG, and its bounded retention policy —
      // and must stay small enough that pasting it costs nothing.
      const pointer = buildClipboardPointer({
        filePath: '/Users/jack/Library/Application Support/infinite-canvas/bug-reports/bug-report-2026-09-06T17-34-08-094Z.md',
        chars: 412_883,
        bytes: 431_002,
        lines: 5_120,
        eventLines: 662,
        filterCode: 'FULL',
        generatedAt: '2026-09-06T17:34:08.094Z',
        description: 'Check that everything completed smoothly as expected.',
      });
      assert(pointer.includes('/bug-report-2026-09-06T17-34-08-094Z.md')
        && pointer.includes('412,883') && pointer.includes('5,120') && pointer.includes('662')
        && pointer.includes('FULL') && pointer.includes('2026-09-06T17:34:08.094Z'),
      `the pointer must carry path, size, line counts, filter code and timestamp, got:\n${pointer}`);
      // Size must be the CHARACTER count, not the byte count — the byte figure
      // overstates what a reader is about to consume on any multi-byte content.
      assert(pointer.includes('412,883 chars') && !pointer.includes('431,002'),
        `the pointer must report characters, not bytes on disk, got:\n${pointer}`);
      assert(pointer.includes('retained across app restarts')
        && pointer.includes('on app start or a later report write')
        && pointer.includes('best-effort cleanup normally prunes')
        && pointer.includes('older than 7 days')
        && pointer.includes(`${SAVED_REPORT_RETENTION} newest`),
      'the pointer must truthfully state restart-safe, trigger-based, best-effort age/count retention semantics');
      assert(pointer.includes('segments'),
        'the pointer should tell its reader to read the file in segments rather than inline');
      assert(pointer.includes('Check that everything completed smoothly as expected.'),
        'the pointer should carry the issue description so intent travels with the paste');
      assert(pointer.length < 1_500, `the pointer must stay short, got ${pointer.length} chars`);

      // A path with spaces sits on its own backticked line so it survives both
      // markdown rendering and a copy/paste into a shell.
      assert(/\n`\/Users\/jack\/Library\/Application Support\/[^`\n]+`\n/.test(pointer),
        `the path must occupy its own backticked line, got:\n${pointer}`);

      // Optional pieces degrade instead of printing empty scaffolding.
      const minimal = buildClipboardPointer({
        filePath: '/tmp/bug-reports/bug-report-x.md', chars: 10, bytes: 10, lines: 1,
        eventLines: null, filterCode: '', generatedAt: '2026-09-06T00:00:00.000Z', description: '',
      });
      assert(!minimal.includes('## Issue Description') && !minimal.includes('event log'),
        `absent description and event count must be omitted, not rendered blank, got:\n${minimal}`);
      // An unset filter code means an unfiltered report. Rendering a blank
      // "Filter code:" line would misreport it as unknown scope.
      assert(minimal.includes('Filter code: FULL'),
        `an empty filter code must render as FULL, got:\n${minimal}`);

      const longDescription = buildClipboardPointer({
        filePath: '/tmp/bug-reports/bug-report-y.md', chars: 10, bytes: 10, lines: 1, eventLines: 2,
        filterCode: 'FULL', generatedAt: '2026-09-06T00:00:00.000Z', description: 'x'.repeat(2_000),
      });
      assert(longDescription.length < 1_500,
        `a runaway description must not turn the pointer back into a giant paste, got ${longDescription.length} chars`);
      return { pointerLength: pointer.length };
    },
  },
  {
    name: 'Job Board FULL diagnostics retain bounded mounted selector eligibility and layout facts',
    run: () => {
      const boardId = 'selector-runtime-board';
      const report = buildJobBoardDiagnostics([
        { id: boardId, type: 'jobboard', data: { hubState: 'empty' } },
      ], [], [{
        id: boardId,
        jobBoardSelector: {
          rowCount: 3,
          selectedCount: 3,
          actionEligible: false,
          actionLabel: 'Search & combine',
          eligibilityReasons: ['selected-source-unready', 'not-an-allowed-reason'],
          selectorBounds: { clientWidth: 260, clientHeight: 583, scrollWidth: 260, scrollHeight: 583 },
          sourceListBounds: { clientWidth: 236, clientHeight: 176, scrollWidth: 236, scrollHeight: 418 },
        },
      }]);
      assert(report.includes('Selector runtime: rows=3 · selected=3 · action=disabled (Search & combine)')
        && report.includes('reasons=selected-source-unready')
        && report.includes('selector=260×583 scroll=260×583')
        && report.includes('source-list=236×176 scroll=236×418 (y-scroll)')
        && !report.includes('not-an-allowed-reason'),
      `FULL Board diagnostics must render the actual selector gate and bounded overflow facts, got:\n${report}`);

      const privateText = 'private-selector-action-or-reason';
      const sanitized = buildJobBoardDiagnostics([
        { id: boardId, type: 'jobboard', data: {} },
      ], [], [{
        id: boardId,
        jobBoardSelector: {
          rowCount: -1,
          selectedCount: 1e9,
          actionEligible: 'yes',
          actionLabel: privateText,
          eligibilityReasons: [privateText],
          selectorBounds: { clientWidth: Infinity },
        },
      }]);
      assert(sanitized.includes('Selector runtime: rows=not retained · selected=not retained · action=not retained')
        && !sanitized.includes(privateText),
      'malformed component state must be fail-closed and never leak arbitrary selector text');
      return { selectorRows: 3, verticalOverflow: true };
    },
  },
  {
    name: 'Job Board FULL diagnostics retain redacted connected-source admission gates',
    run: () => {
      const boardId = 'diagnostic-board-private-id';
      const freshId = 'diagnostic-fresh-private-id';
      const reclaimedId = 'diagnostic-reclaimed-private-id';
      const blockedId = 'diagnostic-blocked-private-id';
      const freshCapability = `career-import:${freshId}:fresh-capability-private`;
      const legacyCapability = `career-import:${reclaimedId}:legacy-capability-private`;
      const blockedCapability = `career-import:${blockedId}:blocked-capability-private`;
      const privatePath = '/Users/private/career-resume.pdf';
      const report = buildJobBoardDiagnostics([
        {
          id: boardId,
          type: 'jobboard',
          data: {
            hubState: 'empty',
            selectedSearchModuleIds: [reclaimedId, blockedId],
            boardScanResume: {
              version: 1,
              boardRunId: 'board-run-private',
              phase: 'searches',
              selectedSearchModuleIds: [reclaimedId, blockedId],
              activeSourceId: reclaimedId,
            },
          },
        },
        {
          id: freshId,
          type: 'jobhub',
          data: {
            hubState: 'empty', careerFilePaths: [privatePath],
            careerImportGeneration: freshCapability,
            careerImportFreshCapability: freshCapability,
            careerImportConsumption: null,
          },
        },
        {
          id: reclaimedId,
          type: 'jobhub',
          data: {
            hubState: 'empty', careerFilePaths: [privatePath],
            careerImportGeneration: legacyCapability,
            careerImportFreshCapability: null,
            careerImportConsumption: {
              generation: legacyCapability,
              capability: legacyCapability,
              origin: 'job-board', boardRunId: 'legacy-board-run-private',
            },
          },
        },
        {
          id: blockedId,
          type: 'jobhub',
          data: {
            hubState: 'empty', careerFilePaths: [privatePath],
            careerImportGeneration: blockedCapability,
            careerImportFreshCapability: null,
            careerImportConsumption: {
              generation: blockedCapability,
              capability: blockedCapability,
              origin: 'job-board', boardRunId: 'fixed-board-run-private', admissionVersion: 2,
            },
          },
        },
      ], [
        { source: boardId, target: freshId },
        { source: reclaimedId, target: boardId },
        { source: boardId, target: blockedId },
      ]);
      assert(report.includes('Connected source admission:')
        && report.includes('selected=no') && report.includes('selected=yes')
        && report.includes('hub-state=empty')
        && report.includes('admission=fresh-imported-input')
        && report.includes('admission=fresh-import-requires-clear')
        && report.includes('selector-ready=no · selector-status=Clear + import required · selector-reason=admission:fresh-import-requires-clear')
        && report.includes('fresh-capability=present') && report.includes('fresh-capability=absent')
        && report.includes('consumption-origin=job-board')
        && report.includes('admission-version=absent') && report.includes('admission-version=2')
        && report.includes('scan-active') && report.includes('scan-selected'),
      `FULL Board diagnostics must retain redacted persisted admission gates and recovery claims, got:\n${report}`);
      assert(!report.includes(boardId) && !report.includes(freshId)
        && !report.includes(reclaimedId) && !report.includes(blockedId)
        && !report.includes(freshCapability) && !report.includes(legacyCapability)
        && !report.includes(blockedCapability) && !report.includes(privatePath),
      'connected-source diagnostics must never export opaque IDs, capabilities, or file paths');
      return { sourceFacts: 3, legacyPreflightClaim: true };
    },
  },
  {
    name: 'Job Board diagnostics mirror default selection, redacted terminal counts, and scoped recovery ownership',
    run: () => {
      const defaultBoard = 'default-selection-board-private';
      const terminalSource = 'terminal-count-source-private';
      const defaultReport = buildJobBoardDiagnostics([
        { id: defaultBoard, type: 'jobboard', data: { hubState: 'empty' } },
        {
          id: terminalSource, type: 'jobhub', data: {
            hubState: 'done', jobRunId: 'terminal-run-private', resultDisposition: 'populated',
            // This is the renderer-redacted shape; no scored-job content crosses
            // the report boundary, but the positive terminal is still reusable.
            scoredJobsCount: 2,
          },
        },
      ], [{ source: defaultBoard, target: terminalSource }]);
      assert(defaultReport.includes('selected=yes')
        && defaultReport.includes('admission=reuse-terminal')
        && defaultReport.includes('selector-ready=yes'),
      `a missing selection allow-list defaults to every connected source and preserves a redacted positive terminal, got:\n${defaultReport}`);

      const malformedSelectionReports = [{ stale: 'selection-object-private' }, 'selection-string-private']
        .map((selectedSearchModuleIds, index) => buildJobBoardDiagnostics([
          {
            id: `malformed-selection-board-${index}`, type: 'jobboard',
            data: { selectedSearchModuleIds },
          },
          { id: `malformed-selection-source-${index}`, type: 'jobhub', data: { hubState: 'empty' } },
        ], [{ source: `malformed-selection-board-${index}`, target: `malformed-selection-source-${index}` }]));
      assert(malformedSelectionReports.every(report => report.includes('selected=yes'))
        && malformedSelectionReports.every(report => !report.includes('selection-object-private') && !report.includes('selection-string-private')),
      'malformed non-array Board selections match the live default-all selector and never leak their payload');

      const sharedSource = 'sibling-shared-source-private';
      const firstBoard = 'sibling-first-board-private';
      const secondBoard = 'sibling-second-board-private';
      const scopedReport = buildJobBoardDiagnostics([
        {
          id: 'first-sibling-group', type: 'group', data: { canvasData: {
            nodes: [
              { id: firstBoard, type: 'jobboard', data: { boardScanResume: {
                version: 1, boardRunId: 'first-board-run-private', phase: 'searches',
                selectedSearchModuleIds: [sharedSource], activeSourceId: sharedSource,
              } } },
              { id: sharedSource, type: 'jobhub', data: { hubState: 'empty' } },
            ],
            edges: [{ source: firstBoard, target: sharedSource }],
          } },
        },
        {
          id: 'second-sibling-group', type: 'group', data: { canvasData: {
            nodes: [
              { id: secondBoard, type: 'jobboard', data: {} },
              { id: sharedSource, type: 'jobhub', data: { hubState: 'empty' } },
            ],
            edges: [{ source: secondBoard, target: sharedSource }],
          } },
        },
      ], []);
      const scopedRows = scopedReport.split('\n- Board ').slice(1);
      const firstScope = scopedRows.find(row => row.includes('scope=nested canvas 1 (depth 1)')) || '';
      const secondScope = scopedRows.find(row => row.includes('scope=nested canvas 2 (depth 1)')) || '';
      assert(firstScope.includes('scan-selected') && firstScope.includes('scan-active')
        && secondScope.includes('recovery-claim=none'),
      `sibling canvases that reuse a source id must not borrow another Board's recovery claim, got:\n${scopedReport}`);

      const secret = 'malformed-recovery-secret-must-not-export';
      const malformedReport = buildJobBoardDiagnostics([
        {
          id: 'malformed-board-private', type: 'jobboard', data: {
            boardScanResume: {
              version: 2, boardRunId: 'invalid-plan-run-private', phase: 'combine',
              combineSourceRuns: [{ sourceId: 'malformed-source-private', runId: secret }],
              completedSourceRuns: { 'malformed-source-private': { runId: secret } },
            },
            manualAiResume: {
              runId: 'retiring-manual-private', retirementPending: true,
              combineSourceRuns: [{ sourceId: 'malformed-source-private', runId: secret }],
            },
          },
        },
        { id: 'malformed-source-private', type: 'jobhub', data: { hubState: 'empty' } },
      ], [{ source: 'malformed-board-private', target: 'malformed-source-private' }]);
      assert(malformedReport.includes('recovery-claim=none') && !malformedReport.includes(secret),
        'invalid-version and retirement-only recovery receipts fail closed without exporting malformed receipt values');
      return { defaultAll: true, redactedTerminal: true, scopedClaims: true };
    },
  },
  {
    name: 'JOBBOARD filter keeps admission timeline and enhanced diagnostics without dropping graph state',
    run: () => {
      const logs = [
        '[Canvas] unrelated setup 1', '[Canvas] unrelated setup 2', '[Canvas] unrelated setup 3', '[Canvas] unrelated setup 4',
        '[JobSearch] login preflight requires Glassdoor', '[JobBoard] selected source admission blocked',
        '[Accounts] Glassdoor logged in and verified', '[Canvas] unrelated teardown 1', '[Canvas] unrelated teardown 2',
        '[Canvas] unrelated teardown 3', '[Canvas] unrelated teardown 4',
      ];
      const filtered = applyBugReportCode(logs, {}, 'JOBBOARD');
      assert(filtered.matchedCodes.includes('JOBBOARD')
        && filtered.filteredLogs.some(line => line.includes('login preflight'))
        && filtered.filteredLogs.some(line => line.includes('selected source admission'))
        && filtered.filteredLogs.some(line => line.includes('logged in and verified'))
        && !filtered.filteredLogs.some(line => line.includes('unrelated setup 1'))
        && filtered.sectionExclusions.has('drawings')
        && !filtered.sectionExclusions.has('nodes')
        && !filtered.sectionExclusions.has('edges')
        && !filtered.sectionExclusions.has('nodeComponentStates'),
      'JOBBOARD must be recognized, preserve the login-preflight/selector timeline, and retain graph plus mounted selector state');

      const boardId = 'jobboard-filter-board-private';
      const sourceId = 'jobboard-filter-source-private';
      const payload = {
        description: 'Logged in, but the Job Board action remains disabled.',
        filterStats: { hasJobNodes: true, hasSellNodes: false, currentNodeIds: [boardId, sourceId], currentJobHubIds: [sourceId], omittedSections: ['drawings', 'nodeInternals', 'imageState', 'mediaState', 'jobAuditDetail'] },
        nodes: [
          { id: boardId, type: 'jobboard', data: { hubState: 'empty' } },
          { id: sourceId, type: 'jobhub', data: { hubState: 'empty' } },
        ],
        edges: [{ source: boardId, target: sourceId }], drawings: [], frontEndState: {}, nodeInternals: [],
        nodeComponentStates: [{ id: boardId, jobBoardSelector: {
          rowCount: 1, selectedCount: 1, actionEligible: false,
          actionLabel: 'Search & combine', eligibilityReasons: ['selected-source-unready'],
        } }], eventLogs: filtered.filteredLogs,
      };
      const focused = generateMarkdown({ ...payload, filterCode: 'JOBBOARD' }).markdown;
      const full = generateMarkdown({ ...payload, filterCode: 'FULL' }).markdown;
      assert(focused.includes('## Job Board Transaction & Display Diagnostics')
        && focused.includes('Connected source admission:')
        && focused.includes('selected=yes')
        && focused.includes('selected-source-unready')
        && full.includes('## Job Board Transaction & Display Diagnostics')
        && full.includes('Connected source admission:'),
      'JOBBOARD and FULL both render the enhanced Board section from retained nodes, edges, and selector state');
      return { focusedTimeline: filtered.filteredLogs.length, fullBoardDiagnostics: true };
    },
  },
];
