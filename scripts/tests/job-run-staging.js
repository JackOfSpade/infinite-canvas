import { __getJobsTelemetryForReportForTests, __queryFanOutForTests, __resetJobsTelemetryForTests, __runWithIpcRequestContextForTests, assert, appendJobsHistory, blankJobPreferencePlan, buildExactTargetRoleQueryBundle, buildJobAnalysisSnapshot, buildJobRunCompletionReceipt, careerInputFingerprint, careerProfileFingerprint, clearRun, clearRunWithResult, completeRunWithReceipt, createModuleRunQueue, evaluateJobPreferences, fs, getJobsTelemetry, ipcMain, jobRunPathScopeForCanvas, lastRunReceiptPathForCanvas, normalizeJobPreferencePlan, normalizeJobRunProfileFingerprint, os, path, readLastRunReceipt, readRunState, readStagedJobs, recordLinkedinResolveAttempt, recordResolveMergeOutcome, recordSourcePage, sanitizeJobPreferencePlan, sanitizeJobPreferences, sanitizeLastRunReceipt, startRun, validateExactResumeRun, validateJobPreferenceListingSubmission, validateJobPreferencePlanSubmission, validateJobPreferenceResearchSubmission, writeLastRunReceipt } from '../test-dependencies.js';
// The bug-report builders under test. test-dependencies.js already re-exports
// all three; they are imported on their own line so the shared bundle import
// above stays untouched while other sessions edit it.
import { buildJobCompletionAssessment, buildJobRecoverySnapshot, buildJobsPipelineSnapshot } from '../test-dependencies.js';
// CURRENT_SCHEMA_VERSION: its own line for the same reason as the bug-report
// import above — this is only for the v8-migration registration guard below.
import { CURRENT_SCHEMA_VERSION } from '../test-dependencies.js';
// ROLE LOCKING (two-pass role resolution + task registration): own line for
// the same reason as the imports above — these are new to this file and the
// shared bundle import at the top stays untouched.
import { getKnownTaskIds, resolveSearchRoles, taskMaxTokensFor } from '../test-dependencies.js';
import { screenJobRolesByTitle } from '../test-dependencies.js';
import { interpretJobPreferences } from '../test-dependencies.js';
import { JOB_SEARCH_MAX_PROVIDER_LOOKBACK_DAYS } from '../test-dependencies.js';
import { validateResponseSchema } from '../test-dependencies.js';
import { canAutomaticallyResolveJobSourceWarning, jobSourceWarningAction, jobSourceAuthPreflightScope } from '../test-dependencies.js';
import { authoritativeFreshJobSearchWindow, effectiveJobSearchWindow, filterAndDedupJobsByPostedSince, freshJobSearchWindow, legacyJobSearchWindow, manualAiPreSearchRecoveryWindow, mergeJobSourceCollectionCap, mergeRoleScreenedJobs, registerJobsHandlers, shouldDiscardJobRunAfterAbort } from '../../electron/ipc/jobs.js';
import { collectionCompletedAtForManifest, markSourceStatus, sanitizeJobSearchWindow, setStage } from '../../electron/ipc/jobRunStaging.js';
import { JOB_PREFERENCE_CRITERION_MAX_LENGTH, JOB_PREFERENCE_PLAN_SCHEMA, JOB_PREFERENCE_RESEARCH_BATCH_ASSESSMENT_SCHEMA, JOB_PREFERENCE_TITLE_MAX_LENGTH, JOB_ROLE_AUDIT_SCHEMA } from '../../electron/ipc/aiSchemas.js';
import { parseJobPreferenceResearchSections } from '../../electron/ipc/jobPreferences.js';

export default [
  {
    name: 'manual-AI pre-search recovery: preserves its original window and rejects an altered checkpoint',
    run: async () => {
      const startedAt = new Date(2026, 8, 1, 15, 30, 0, 0);
      const frozen = freshJobSearchWindow(null, startedAt, 21);
      const laterDispatch = new Date(2026, 8, 8, 0, 0, 0, 0);
      const recovery = {
        version: 1,
        manualAiRunId: 'manual-ai-pre-search-run',
        nodeId: 'manual-ai-pre-search-hub',
        startedAt: startedAt.getTime(),
        searchWindow: frozen,
      };

      // The request may carry a stale relative provider horizon, but it must
      // retain the same immutable date boundary. Dispatching a week later
      // must broaden the provider request rather than moving the client-side
      // cutoff forward from the original run.
      const resumed = manualAiPreSearchRecoveryWindow(recovery, {
        ...frozen,
        providerLookbackDays: 1,
      }, laterDispatch);
      assert(resumed?.startTimestamp === frozen.startTimestamp
        && resumed?.anchorTimestamp === frozen.anchorTimestamp
        && resumed?.completionTimestamp === frozen.completionTimestamp
        && resumed?.providerLookbackDays === 29
        && resumed.providerLookbackDays > frozen.providerLookbackDays,
      `a manual-AI pre-search resume must preserve its original cutoff and widen only its provider horizon, got ${JSON.stringify(resumed)}`);

      const alteredRequestedWindow = {
        ...frozen,
        startTimestamp: frozen.startTimestamp + 86_400_000,
        anchorTimestamp: frozen.anchorTimestamp + 86_400_000,
      };
      const invalidDescriptor = { ...recovery, nodeId: '' };
      assert(manualAiPreSearchRecoveryWindow(recovery, alteredRequestedWindow, laterDispatch) === null
        && manualAiPreSearchRecoveryWindow(invalidDescriptor, frozen, laterDispatch) === null
        && manualAiPreSearchRecoveryWindow({ ...recovery, version: 2 }, frozen, laterDispatch) === null,
      'manual-AI pre-search recovery must reject a mismatched window or invalid descriptor instead of silently creating a fresh scan');
    },
  },
  {
    name: 'crash resume: auth preflight clears only transient unfinished source cards and preserves Retry token',
    run: () => {
      const search = fs.readFileSync(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8');
      const card = fs.readFileSync(path.resolve('src/nodes/JobSourceCardNode.jsx'), 'utf8');
      const resumeStart = search.indexOf('const handleResumeRun = useCallback');
      const resumeEnd = search.indexOf('resumeInterruptedRunRef.current = handleResumeRun;', resumeStart);
      const resume = search.slice(resumeStart, resumeEnd);
      const catchStart = resume.indexOf('} catch (error) {');
      const catchBlock = resume.slice(catchStart);

      assert(resumeStart >= 0 && resumeEnd > resumeStart
        && resume.includes('let resumedUnfinishedSourceIds = [];')
        && resume.includes("source.status !== 'done' && source.status !== 'skipped'")
        && resume.includes('resumedSourceSummary.flatMap(source => (')
        && resume.includes("source.status === 'done' || source.status === 'skipped'")
        && resume.includes('if (!resumingFinishedSavedListings && resumedUnfinishedSourceIds.length > 0)')
        && !resume.includes("? source.status\n            : 'searching'"),
      'crash resume restores only durable terminal card progress, clears stale unfinished-card warnings before re-dispatch, and never persists synthetic searching state');
      assert(catchBlock.includes('if (error?.isLoginGate && resumedUnfinishedSourceIds.length > 0)')
        && catchBlock.includes("new CustomEvent('job-source-progress-reset'")
        && catchBlock.includes('sourceIds: resumedUnfinishedSourceIds')
        && catchBlock.includes('clearPersistedProgress: true')
        && catchBlock.includes('preserveRunGeneration: true')
        && !catchBlock.includes('discardJobRun')
        && !catchBlock.includes('clearJobRun'),
      'a rejected auth preflight clears only the active resume-card display while retaining the manifest/checkpoint required by Retry');
      assert(card.includes('const sourceIds = event.detail?.sourceIds;')
        && card.includes('!sourceIds.includes(data.sourceId)')
        && card.includes('event.detail?.preserveRunGeneration !== true')
        && card.includes('event.detail?.clearPersistedProgress === true')
        && card.includes('updateNodeData(id, { persistedProgress: null });'),
      'source-card reset is source-scoped, clears stale persisted display state, and does not retire the exact resume generation');
      return { authFailureCardsIdle: true, manifestRetainedForRetry: true };
    },
  },
  {
    name: 'crash resume: one logged-out provider blocks only itself while staged and eligible sources continue',
    run: () => {
      const jobs = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
      const search = fs.readFileSync(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8');
      const card = fs.readFileSync(path.resolve('src/nodes/JobSourceCardNode.jsx'), 'utf8');
      const paused = fs.readFileSync(path.resolve('src/nodes/jobsearch/JobSearchSourcesReadyState.jsx'), 'utf8');
      const preflightStart = jobs.indexOf('const browserJobPlatforms = activeSourceIds');
      const preflightEnd = jobs.indexOf('// Notify frontend that sources are starting.', preflightStart);
      const preflight = jobs.slice(preflightStart, preflightEnd);
      const sourceResultsStart = jobs.indexOf('const sourceResults = {};', preflightEnd);
      const sourceResultsEnd = jobs.indexOf('for (const policy of sourceCountryPolicies)', sourceResultsStart);
      const sourceResults = jobs.slice(sourceResultsStart, sourceResultsEnd);

      assert(preflightStart >= 0 && preflightEnd > preflightStart
        && preflight.includes('!skipProviderCollection && resumeScope !== null ? notLoggedIn : []')
        && preflight.includes('notLoggedIn.length > 0 && loginBlockedSourceIds.size === 0')
        && preflight.includes('const candidateTasks = buildJobTasks(')
        && preflight.includes('const runnableSourceScope = new Set(')
        && preflight.includes('const tasks = candidateTasks.filter(task => runnableSourceScope.has(task.sourceId));')
        && preflight.includes('const authPreflightSourceIds = jobSourceAuthPreflightScope(browserJobPlatforms, resumeScope);')
        && preflight.includes('for (const t of candidateTasks)')
        && preflight.includes('sourceFirstUrl[t.sourceId] = t.url'),
      'a crash-resume must exclude only logged-out provider tasks while retaining a safe provider URL for that source card; fresh runs retain the hard login gate');
      const browserSources = ['indeed', 'glassdoor', 'ziprecruiter'];
      const unfinishedResumeScope = new Set(['indeed']);
      assert(JSON.stringify(jobSourceAuthPreflightScope(browserSources, null)) === JSON.stringify(browserSources)
        && JSON.stringify(jobSourceAuthPreflightScope(browserSources, unfinishedResumeScope)) === JSON.stringify(['indeed']),
      'fresh runs preflight every selected browser source, while a resume ignores a done-but-now-logged-out Glassdoor and preflights only unfinished Indeed');
      assert(sourceResults.includes('for (const sourceId of loginBlockedSourceIds)')
        && sourceResults.includes("code: 'login-required'")
        && sourceResults.includes("severity: 'block'")
        && sourceResults.includes("action: 'login-platform'")
        && sourceResults.includes('markSourceStatus') === false,
      'each skipped resume provider must surface a privacy-safe, provider-specific gating warning; its normal terminal loop owns the durable blocked manifest status');
      const loginWarning = { code: 'login-required', severity: 'block', action: 'login-platform' };
      assert(jobSourceWarningAction(loginWarning) === 'login-platform'
        && !canAutomaticallyResolveJobSourceWarning(loginWarning)
        && card.includes("if (warningAction === 'login-platform')")
        && card.includes('window.electronAPI.openLoginWindow({ platformId })')
        && search.includes('canAutomaticallyResolveJobSourceWarning(w)'),
      'a login-required card uses the verified shared-profile login flow and is excluded from Solve all because login does not resume a provider by itself');
      assert(search.includes('onRetryRemaining={resumeRunActionable && !activeBoardRecoveryOwnerKey')
        && search.includes('|| searchResult?.hasUnfinishedSources === true')
        && paused.includes('Retry remaining sources')
        && paused.includes('Completed and staged work stays intact.')
        && jobs.includes("phase: pausedSourceIds.length > 0 ? 'sources-blocked' : 'completed'")
        && jobs.includes('pendingSources: pausedSourceIds')
        && jobs.includes('hasUnfinishedSources: finalGatingSourceIds.size > 0'),
      'the paused hub must offer an exact retry after sign-in, preserve the partial coverage anchor for every remaining gate (not only login), and report blocked sources instead of a false completed gather');
      return { partialRecovery: true, loginWarningDurable: true, retryRemainingSources: true };
    },
  },
  {
    name: 'job pause retains the exact staging checkpoint while destructive cancellation clears it',
    run: () => {
      const userStopped = Object.assign(new Error('Node deleted'), { cancelCause: 'user-stopped' });
      const sourceCardRemoved = Object.assign(new Error('Node deleted'), { cancelCause: 'job-source-card-removed' });
      const userReset = Object.assign(new Error('Node deleted'), { cancelCause: 'user-reset' });
      const nodeDeleted = Object.assign(new Error('Node deleted'), { cancelCause: 'node-deleted' });
      const unrelatedFailure = new Error('network unavailable');
      assert(shouldDiscardJobRunAfterAbort(userStopped) === false
        && shouldDiscardJobRunAfterAbort(sourceCardRemoved) === false
        && shouldDiscardJobRunAfterAbort(userReset) === true
        && shouldDiscardJobRunAfterAbort(nodeDeleted) === true
        && shouldDiscardJobRunAfterAbort(unrelatedFailure) === false,
      'Stop or removal of an active source card keeps its exact staged run; Reset/delete retain their token-scoped cleanup policy');

      const jobs = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
      const abortStart = jobs.indexOf('const throwIfSearchAborted = async () => {');
      const abortEnd = jobs.indexOf('// ── Browser sources', abortStart);
      const abortPolicy = jobs.slice(abortStart, abortEnd);
      const search = fs.readFileSync(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8');
      const resetStart = search.indexOf('const resetHandler = useCallback');
      const stopStart = search.indexOf('const stopHandler = useCallback', resetStart);
      const reset = search.slice(resetStart, stopStart);
      const preserveStart = reset.indexOf('if (preserveRecovery) {', reset.indexOf('const resetData ='));
      const preserveEnd = reset.indexOf('// The renderer generation was already fenced', preserveStart);
      const savedStop = reset.slice(preserveStart, preserveEnd);
      const stop = search.slice(stopStart, search.indexOf('// Non-API scoring is controlled', stopStart));
      assert(abortStart >= 0 && abortEnd > abortStart
        && abortPolicy.includes('shouldDiscardJobRunAfterAbort(reason)')
        && abortPolicy.includes("CANCEL_CAUSE_LABELS[reason?.cancelCause]")
        && jobs.includes("'job-source-card-removed'")
        && jobs.includes('CHECKPOINT_PRESERVING_ABORT_CAUSES.has(reason?.cancelCause)')
        && preserveStart >= 0 && preserveEnd > preserveStart
        && savedStop.includes('cancelNodeTaskAndWait(')
        && savedStop.includes('setResumeOffer(stoppedOffer)')
        && !savedStop.includes('discardJobRun')
        && stop.includes('resetHandler(e, { preserveRecovery: true })'),
      'the visible Stop waits for the backend acknowledgement, retains the verified offer, and routes its checkpoint-preserving abort through the non-discarding backend policy');
      return { stoppedCheckpointRetained: true, destructiveCancelsDiscard: true };
    },
  },
  {
    name: 'job search date window: backend derives fresh boundaries and staging preserves the exact resume window',
    run: async () => {
      const now = new Date(2026, 9, 10, 15, 30, 0, 0);
      const completedAt = new Date(2026, 9, 1, 12, 45, 0, 0).getTime();
      const fresh = freshJobSearchWindow(completedAt, now);
      const expectedStart = new Date(2026, 9, 1, 0, 0, 0, 0).getTime();
      assert(fresh.startTimestamp === expectedStart
        && fresh.completionTimestamp === completedAt
        && fresh.providerLookbackDays === 10
        && fresh.capped === false,
      `a fresh backend run must include the last completion's whole local date, got ${JSON.stringify(fresh)}`);

      const stale = freshJobSearchWindow(new Date(2025, 7, 1, 12).getTime(), now, 1);
      assert(stale.startTimestamp === new Date(2025, 9, 10, 0, 0, 0, 0).getTime()
        && stale.providerLookbackDays === 366
        && stale.capped === true
        && stale.capReason === 'older-than-max-lookback',
      `a fresh backend run must use the independent 365-day history safety cap, got ${JSON.stringify(stale)}`);
      const configuredFirst = freshJobSearchWindow(null, now, 45);
      assert(configuredFirst.startTimestamp === new Date(2026, 7, 26, 0, 0, 0, 0).getTime()
        && configuredFirst.providerLookbackDays === 46,
      `the backend must authoritatively apply the persisted first-search range, got ${JSON.stringify(configuredFirst)}`);

      const beforeMidnight = new Date(2026, 9, 10, 23, 59, 0, 0);
      const afterMidnight = new Date(2026, 9, 11, 0, 1, 0, 0);
      const rendererFrozen = freshJobSearchWindow(null, beforeMidnight, 45);
      const midnightAccepted = authoritativeFreshJobSearchWindow(
        null,
        45,
        { ...rendererFrozen, providerLookbackDays: JOB_SEARCH_MAX_PROVIDER_LOOKBACK_DAYS },
        afterMidnight,
      );
      const forged = {
        ...rendererFrozen,
        startTimestamp: rendererFrozen.startTimestamp - 86_400_000,
        anchorTimestamp: rendererFrozen.startTimestamp - 86_400_000,
      };
      const forgedRejected = authoritativeFreshJobSearchWindow(null, 45, forged, afterMidnight);
      const backendCurrent = freshJobSearchWindow(null, afterMidnight, 45);
      assert(midnightAccepted.startTimestamp === rendererFrozen.startTimestamp
        && midnightAccepted.providerLookbackDays === 47
        && forgedRejected.startTimestamp === backendCurrent.startTimestamp,
      'the backend preserves a valid renderer-frozen prior-day boundary across midnight, recomputes its provider horizon, and rejects any other widening');

      const legacy = legacyJobSearchWindow(7, now.getTime(), now);
      assert(legacy.startTimestamp === new Date(2026, 9, 3, 0, 0, 0, 0).getTime()
        && legacy.providerLookbackDays === 8
        && legacy.capReason === 'legacy-max-age-days',
      `an old maxAgeDays manifest must upgrade to a usable inclusive date window, got ${JSON.stringify(legacy)}`);
      assert(JSON.stringify(effectiveJobSearchWindow(fresh, 1, now.getTime(), now)) === JSON.stringify(fresh),
        'a persisted exact searchWindow must win over a legacy maxAgeDays fallback on resume');
      assert(effectiveJobSearchWindow({
        ...fresh,
        providerLookbackDays: JOB_SEARCH_MAX_PROVIDER_LOOKBACK_DAYS,
      }, 1, now.getTime(), now).providerLookbackDays === fresh.providerLookbackDays,
      'an action must recompute provider lookback from its exact boundary instead of trusting an inflated relative horizon');
      // Resume at an exact local-midnight multiple too: ceil(elapsed / day)
      // would be one day too narrow at this boundary.
      const delayedResumeAt = new Date(2026, 9, 11, 0, 0, 0, 0);
      const delayed = effectiveJobSearchWindow(fresh, 1, now.getTime(), delayedResumeAt);
      assert(delayed.startTimestamp === fresh.startTimestamp
        && delayed.completionTimestamp === fresh.completionTimestamp
        && delayed.providerLookbackDays === 11,
      `a delayed resume must preserve its exact boundary while widening the provider request, got ${JSON.stringify(delayed)}`);
      const delayedLegacy = effectiveJobSearchWindow(null, 7, now.getTime(), delayedResumeAt);
      assert(delayedLegacy.startTimestamp === legacy.startTimestamp
        && delayedLegacy.completionTimestamp === legacy.completionTimestamp
        && delayedLegacy.providerLookbackDays === 9,
      `a delayed legacy-manifest resume must also preserve its upgraded boundary while widening the provider request, got ${JSON.stringify(delayedLegacy)}`);
      assert(sanitizeJobSearchWindow({
        ...fresh,
        providerLookbackDays: JOB_SEARCH_MAX_PROVIDER_LOOKBACK_DAYS,
      })?.providerLookbackDays === JOB_SEARCH_MAX_PROVIDER_LOOKBACK_DAYS
        && sanitizeJobSearchWindow({
          ...fresh,
          providerLookbackDays: JOB_SEARCH_MAX_PROVIDER_LOOKBACK_DAYS + 1,
        }) === null,
      'the durable manifest accepts the bounded one-year DST overlap but rejects anything broader');

      const duplicateWindow = filterAndDedupJobsByPostedSince([
        { id: 'old-first', source: 'indeed', title: 'Platform Engineer', company: 'Example Co', location: 'Toronto', posted: new Date(expectedStart - 1).toISOString() },
        { id: 'new-valid', source: 'google', title: 'Platform Engineer', company: 'Example Co', location: 'Toronto', posted: new Date(expectedStart + 60_000).toISOString() },
        { id: 'new-duplicate', source: 'linkedin', title: 'Platform Engineer', company: 'Example Co', location: 'Toronto', posted: new Date(expectedStart + 120_000).toISOString() },
      ], expectedStart, { now });
      assert(duplicateWindow.ageDropped === 1
        && duplicateWindow.windowEligible.map(job => job.id).join(',') === 'new-valid,new-duplicate'
        && duplicateWindow.deduped.map(job => job.id).join(',') === 'new-valid',
      `the exact window must remove an old first-seen mirror before dedup so its newer copy survives, got ${JSON.stringify(duplicateWindow)}`);

      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-job-search-window-roundtrip-'));
      const canvasPath = path.join(root, 'workspace.json');
      try {
        await startRun(canvasPath, {
          runId: 'date-window-run',
          startedAt: now.getTime(),
          queries: ['platform engineer'],
          canonicalLocation: '',
          nodeId: 'date-window-hub',
          sourceIds: ['indeed'],
          searchWindow: fresh,
          // Kept only so an older binary could still recover this manifest.
          maxAgeDays: fresh.providerLookbackDays,
        });
        const state = await readRunState(canvasPath, now.getTime() + 1, { nodeId: 'date-window-hub' });
        assert(JSON.stringify(state?.manifest?.inputs?.searchWindow) === JSON.stringify(fresh),
          `the crash-resume manifest must round-trip the exact window, got ${JSON.stringify(state?.manifest?.inputs?.searchWindow)}`);
        const firstGatheredAt = now.getTime() + 2;
        const resumedAt = now.getTime() + 60_000;
        await setStage(canvasPath, 'gathered', firstGatheredAt, {
          expectedRunId: 'date-window-run',
          nodeId: 'date-window-hub',
          collectionCompletedAt: firstGatheredAt,
        });
        await setStage(canvasPath, 'gathered', resumedAt, {
          expectedRunId: 'date-window-run',
          nodeId: 'date-window-hub',
          collectionCompletedAt: resumedAt,
        });
        const resumedState = await readRunState(canvasPath, resumedAt + 1, { nodeId: 'date-window-hub' });
        assert(resumedState?.manifest?.collectionCompletedAt === firstGatheredAt
          && resumedState?.manifest?.lastUpdated === resumedAt
          && collectionCompletedAtForManifest(resumedState.manifest) === firstGatheredAt,
        `a gathered resume must refresh liveness without moving the first collection boundary, got ${JSON.stringify(resumedState?.manifest)}`);

        // Simulate a gathered manifest written before collectionCompletedAt
        // existed. Its prior lastUpdated is the conservative one-time upgrade,
        // never the later resume timestamp.
        const scope = jobRunPathScopeForCanvas(canvasPath, 'date-window-hub');
        const manifestPath = path.join(scope.dir, `${scope.base}.jobs-run.${scope.canvasHash}.${scope.ownerHash}.json`);
        const legacyManifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
        delete legacyManifest.collectionCompletedAt;
        legacyManifest.lastUpdated = firstGatheredAt;
        await fs.promises.writeFile(manifestPath, JSON.stringify(legacyManifest), 'utf8');
        await setStage(canvasPath, 'gathered', resumedAt, {
          expectedRunId: 'date-window-run',
          nodeId: 'date-window-hub',
        });
        const upgradedLegacyState = await readRunState(canvasPath, resumedAt + 1, { nodeId: 'date-window-hub' });
        assert(upgradedLegacyState?.manifest?.collectionCompletedAt === firstGatheredAt
          && upgradedLegacyState?.manifest?.lastUpdated === resumedAt,
        `a legacy gathered manifest must upgrade from its old lastUpdated before resume refreshes it, got ${JSON.stringify(upgradedLegacyState?.manifest)}`);
        return { freshBoundary: true, cappedBoundary: true, legacyCompatible: true, delayedResumeBroadens: true, windowBeforeDedup: true, resumeRoundTrip: true, gatheredAnchorImmutable: true };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'job search gathered-only resume returns the original collection boundary while refreshing manifest liveness',
    run: async () => {
      registerJobsHandlers();
      const searchJobs = ipcMain.__getInvokeHandler('search-jobs');
      const fingerprint = 'c'.repeat(64);
      const cases = [
        { label: 'modern', removeDedicatedBoundary: false },
        { label: 'legacy', removeDedicatedBoundary: true },
      ];
      const outcomes = [];

      for (let index = 0; index < cases.length; index += 1) {
        const testCase = cases[index];
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `ic-gathered-resume-${testCase.label}-`));
        const canvasPath = path.join(root, 'workspace.json');
        const nodeId = `gathered-resume-${testCase.label}`;
        const runId = `gathered-run-${testCase.label}`;
        const startedAt = Date.now() - 120_000;
        const firstGatheredAt = startedAt + 30_000;
        const searchWindow = freshJobSearchWindow(null, new Date(startedAt));
        try {
          await startRun(canvasPath, {
            runId,
            startedAt,
            queries: ['platform engineer'],
            profileFingerprint: fingerprint,
            canonicalLocation: '',
            nodeId,
            sourceIds: ['indeed'],
            searchWindow,
            maxAgeDays: searchWindow.providerLookbackDays,
          });
          await recordSourcePage(canvasPath, {
            nodeId,
            expectedRunId: runId,
            sourceId: 'indeed',
            query: 'platform engineer',
            page: 1,
            now: firstGatheredAt - 1,
            jobs: [{
              title: 'Platform Engineer',
              company: `Resume Boundary ${testCase.label}`,
              location: 'Remote',
              url: `https://example.com/jobs/${testCase.label}`,
              posted: 'recently listed',
              description: `Platform engineering role ${'x'.repeat(500)}`,
            }],
          });
          await markSourceStatus(canvasPath, 'indeed', 'done', firstGatheredAt - 1, {
            expectedRunId: runId,
            nodeId,
          });
          await setStage(canvasPath, 'gathered', firstGatheredAt, {
            expectedRunId: runId,
            nodeId,
            collectionCompletedAt: firstGatheredAt,
          });

          if (testCase.removeDedicatedBoundary) {
            const scope = jobRunPathScopeForCanvas(canvasPath, nodeId);
            const manifestPath = path.join(scope.dir, `${scope.base}.jobs-run.${scope.canvasHash}.${scope.ownerHash}.json`);
            const legacyManifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
            delete legacyManifest.collectionCompletedAt;
            legacyManifest.lastUpdated = firstGatheredAt;
            await fs.promises.writeFile(manifestPath, JSON.stringify(legacyManifest), 'utf8');
          }

          const sender = {
            id: 67_000 + index,
            isDestroyed: () => false,
            once: () => {},
            on: () => {},
            removeListener: () => {},
            send: () => {},
          };
          const result = await searchJobs({ sender }, {
            nodeId,
            canvasFilePath: canvasPath,
            queries: ['platform engineer'],
            canonicalLocation: '',
            resume: true,
            resumeRunId: runId,
            profileFingerprint: fingerprint,
          });
          const after = await readRunState(canvasPath, Date.now(), { nodeId });
          assert(result?.success === true
            && result.collectionStartedAt === startedAt
            && result.collectionCompletedAt === firstGatheredAt
            && after?.manifest?.collectionCompletedAt === firstGatheredAt
            && after?.manifest?.lastUpdated > firstGatheredAt,
          `${testCase.label} gathered-only recovery must retain its original start/collection boundaries while refreshing lastUpdated, got ${JSON.stringify({ result, manifest: after?.manifest })}`);
          outcomes.push(testCase.label);
        } finally {
          await fs.promises.rm(root, { recursive: true, force: true });
        }
      }
      return { preserved: outcomes };
    },
  },
  {
    name: 'job run queue: separate hubs serialize on the shared job-search lane and queued cancellation is isolated',
    run: async () => {
      const queue = createModuleRunQueue();
      const order = [];
      const first = await queue.acquireModuleRun({
        nodeId: 'hub-a',
        lane: 'job-search',
        onStart: () => order.push('a-start'),
      });
      const queued = queue.acquireModuleRun({
        nodeId: 'hub-b',
        lane: 'job-search',
        onQueued: ({ position }) => order.push(`b-queued-${position}`),
        onStart: () => order.push('b-start'),
      });
      const unrelated = await queue.acquireModuleRun({
        nodeId: 'marketplace-a',
        lane: 'marketplace',
        onStart: () => order.push('marketplace-start'),
      });

      const waiting = queue.getSnapshot().lanes['job-search'];
      assert(waiting?.active?.nodeId === 'hub-a' && waiting.queued?.[0]?.nodeId === 'hub-b'
        && !order.includes('b-start') && order.includes('marketplace-start'),
      `a second hub must wait behind the active shared job-search workflow while unrelated lanes proceed, got ${JSON.stringify({ waiting, order })}`);

      first.release();
      const second = await queued;
      assert(order.indexOf('a-start') < order.indexOf('b-queued-1')
        && order.indexOf('b-queued-1') < order.indexOf('b-start'),
      `the shared job-search lane must remain FIFO across hubs, got ${JSON.stringify(order)}`);
      second.release();
      unrelated.release();

      const active = await queue.acquireModuleRun({ nodeId: 'hub-a', lane: 'job-search' });
      const cancelled = queue.acquireModuleRun({ nodeId: 'hub-b', lane: 'job-search' })
        .then(() => null, error => error?.message || String(error));
      const cancelledCount = queue.cancelQueuedRunsForNode('hub-b', 'Hub reset');
      const cancelledReason = await cancelled;
      active.release();
      assert(cancelledCount === 1 && cancelledReason === 'Hub reset'
        && queue.getSnapshot().lanes['job-search'] == null,
      `cancelling a queued hub must remove only its shared-lane entry, got ${JSON.stringify({ cancelledCount, cancelledReason, snapshot: queue.getSnapshot() })}`);

      // acquireModuleRun reserves its lane synchronously but intentionally
      // runs onStart in a microtask. A deletion in that admission gap must
      // cancel it just like a queued entry; otherwise an unmounted Search can
      // still start a browser/IPC worker after its owner disappeared.
      const preStartEvents = [];
      const preStart = queue.acquireModuleRun({
        nodeId: 'pre-start-hub',
        cancellationNodeIds: ['pre-start-source-card'],
        lane: 'job-search',
        onStart: () => preStartEvents.push('started'),
        onCancel: () => preStartEvents.push('cancelled'),
      }).then(() => null, error => error?.message || String(error));
      const preStartCancelled = queue.cancelQueuedRunsForNode(
        'pre-start-source-card',
        'Source removed during queue admission',
      );
      const preStartReason = await preStart;
      await Promise.resolve();
      assert(preStartCancelled === 1
        && preStartReason === 'Source removed during queue admission'
        && JSON.stringify(preStartEvents) === JSON.stringify(['cancelled'])
        && queue.getSnapshot().lanes['job-search'] == null,
      `a cancellation alias must stop an admitted-but-not-started run, got ${JSON.stringify({ preStartCancelled, preStartReason, preStartEvents, snapshot: queue.getSnapshot() })}`);

      // A source resolver is executed by its hub in the main process, but the
      // source-card UI may disappear independently while it waits in the lane.
      // Its card id must therefore cancel the queued entry without breaking
      // the hub-id cancellation used by Reset.
      const sourceActive = await queue.acquireModuleRun({ nodeId: 'resolver-hub', lane: 'job-search' });
      const sourceQueued = queue.acquireModuleRun({
        nodeId: 'resolver-hub',
        cancellationNodeIds: ['source-card-a'],
        lane: 'job-search',
      }).then(() => null, error => error?.message || String(error));
      const sourceCancelled = queue.cancelQueuedRunsForNode('source-card-a', 'Job source card removed');
      const sourceCancelReason = await sourceQueued;
      assert(sourceCancelled === 1 && sourceCancelReason === 'Job source card removed'
        && queue.getSnapshot().lanes['job-search']?.active?.nodeId === 'resolver-hub',
      `removing a queued source card must not disturb its same-hub active sibling, got ${JSON.stringify({ sourceCancelled, sourceCancelReason, snapshot: queue.getSnapshot() })}`);
      sourceActive.release();

      // Reset is narrower than deletion: a Board may be queued under its own
      // id while listing this Search as a cancellation alias. Cancelling work
      // actually owned by the Search must leave that parent transaction in the
      // lane.
      const aliasActive = await queue.acquireModuleRun({ nodeId: 'other-owner', lane: 'job-search' });
      const boardQueued = queue.acquireModuleRun({
        nodeId: 'board-owner',
        cancellationNodeIds: ['hub-reset'],
        lane: 'job-search',
      });
      const searchQueued = queue.acquireModuleRun({
        nodeId: 'hub-reset',
        lane: 'job-search',
      }).then(() => null, error => error?.message || String(error));
      const ownedCancelled = queue.cancelQueuedRunsOwnedByNode('hub-reset', 'Search reset');
      const ownedCancelReason = await searchQueued;
      assert(ownedCancelled === 1 && ownedCancelReason === 'Search reset'
        && queue.getSnapshot().lanes['job-search']?.queued?.length === 1
        && queue.getSnapshot().lanes['job-search'].queued[0].nodeId === 'board-owner',
      `child Reset must preserve a parent queued through its cancellation alias, got ${JSON.stringify({ ownedCancelled, ownedCancelReason, snapshot: queue.getSnapshot() })}`);
      aliasActive.release();
      const boardLease = await boardQueued;
      boardLease.release();

      const sourceCard = fs.readFileSync(path.resolve('src/nodes/JobSourceCardNode.jsx'), 'utf8');
      const cleanupStart = sourceCard.indexOf('useUnmountEffect(() => {');
      const cleanupEnd = sourceCard.indexOf('\n\n  useEffect(() => {', cleanupStart);
      const resolverCleanup = sourceCard.slice(cleanupStart, cleanupEnd);
      const ownedBoardCancelAt = resolverCleanup.indexOf('if (pausedBoardOwner) {');
      const standaloneCleanupAt = resolverCleanup.indexOf('if (!resolveInFlightRef.current) return;');
      const ownedBoardCleanup = resolverCleanup.slice(ownedBoardCancelAt, standaloneCleanupAt);
      const standaloneCleanup = resolverCleanup.slice(standaloneCleanupAt);
      const provider = fs.readFileSync(path.resolve('src/contexts/ModuleRunQueueContext.jsx'), 'utf8');
      assert(sourceCard.includes('const resolveLifecycleRef = useRef(0);')
        && sourceCard.includes('const resolveStartedRef = useRef(false);')
        && sourceCard.includes('const { acquireModuleRun, cancelQueuedRunsForNode } = useModuleRunQueue();')
        && sourceCard.includes('const jobSearchCoordinator = useJobSearchCoordinator();')
        && sourceCard.includes("import { useUnmountEffect } from '../hooks/useUnmountEffect';")
        && sourceCard.includes('`useUnmountEffect` filters React StrictMode')
        && sourceCard.includes("cancellationNodeIds: [id]")
        && sourceCard.includes("cancelQueuedRunsForNode(id, 'Job source card removed')")
        && ownedBoardCancelAt >= 0
        && standaloneCleanupAt > ownedBoardCancelAt
        && resolverCleanup.includes('const cardOwnsCurrentGate = Array.isArray(hubData.scrapeWarnings)')
        && resolverCleanup.includes('warning?.sourceId === data.sourceId && isJobSourceWarningGating(warning)')
        && resolverCleanup.includes('findJobSearchBoardCancellablePausedSourceOwner(')
        && ownedBoardCleanup.includes('jobSearchCoordinator.cancelBoardModule(pausedBoardOwner.orchestratorNodeId, {')
        && ownedBoardCleanup.includes('boardRunId: pausedBoardOwner.boardRunId')
        && ownedBoardCleanup.includes("reason: 'job-source-card-removed'")
        && ownedBoardCleanup.includes('suppressToast: true')
        && ownedBoardCleanup.includes('.catch((error) => {')
        && ownedBoardCleanup.includes('return;')
        && !ownedBoardCleanup.includes("cancelNodeTask?.(data.hubId, 'job-source-card-removed')")
        && standaloneCleanup.includes('if (resolveStartedRef.current) {')
        && standaloneCleanup.includes("cancelNodeTask?.(data.hubId, 'job-source-card-removed')")
        && resolverCleanup.endsWith('\n  });')
        && !resolverCleanup.includes('moduleRunQueue')
        && provider.includes('cancelQueuedRunsOwnedByNode: queue.cancelQueuedRunsOwnedByNode')
        && provider.includes('}), [queue, snapshot]);')
        // Post-lease liveness fence. It now also stamps the outcome the finally
        // reports, so a "Solve all" driver awaiting this card cannot hang on a
        // card that unmounted while its lease was queued.
        && sourceCard.includes("if (!resolverAlive()) { solveOutcome = 'fenced'; return; }"),
      'a removed gating source card must cancel its exact paused Board generation without a raw hub abort, while standalone resolvers retain their queued/active cancellation boundary despite provider snapshot rerenders');
      return { sharedLane: true, queuedCancellation: true, ownedResetPreservesParentAlias: true, sameHubActiveSiblingProtected: true, sourceCardLifecycleCancellation: true, exactBoardSourceCardCancellation: true, snapshotRerenderSafe: true };
    },
  },
  {
    name: 'job preferences: every career direction is evaluable and listing provenance is code-owned',
    run: async () => {
      const directionOnly = {
        version: 1,
        summary: '',
        direction: { summary: '', roleDirections: [], avoidDirections: ['Pivot away from web development'], explorationEnabled: true },
        softPreferences: [], strictRequirements: [], warnings: [],
        titles: [],
      };
      let rejected = false;
      try { validateJobPreferencePlanSubmission(directionOnly); } catch { rejected = true; }
      assert(rejected, 'a direction-only plan must be rejected because post-history evaluation would otherwise skip it');

      const valid = {
        ...directionOnly,
        softPreferences: [{ id: 'pivot', criterion: 'Pivot away from web development', category: 'role' }],
      };
      assert(validateJobPreferencePlanSubmission(valid).softPreferences.length === 1,
        'a derived direction matching its soft role preference must be accepted');
      const evaluated = await evaluateJobPreferences({
        jobs: [
          { title: 'Frontend Developer', url: 'https://jobs.example.test/frontend' },
          { title: 'Web Developer', url: 'javascript:alert(1)' },
        ],
        jobPreferences: 'I want to pivot away from web development.',
        preferencePlan: valid,
        callRaw: () => { throw new Error('a soft role preference must not need web research'); },
        callText: async (_prompt, options) => {
          assert(options.task === 'job-preference-evaluation', `unexpected task ${options.task}`);
          return { assessments: [
            { index: 0, matches: [{ preferenceId: 'pivot', outcome: 'conflicts', evidence: 'Web role', evidenceQuote: 'Frontend Developer', sourceUrls: ['https://hallucinated.example.test'], sourceDate: '2099-01-01' }] },
            { index: 1, matches: [{ preferenceId: 'pivot', outcome: 'confirmed', evidence: 'Adjacent role', evidenceQuote: 'Web Developer', sourceUrls: ['https://hallucinated.example.test'], sourceDate: '2099-01-01' }] },
          ] };
        },
      });
      const safe = evaluated.candidatePool.find(job => job.title === 'Frontend Developer')?.preferenceAssessment?.matches?.[0];
      const unsafe = evaluated.candidatePool.find(job => job.title === 'Web Developer')?.preferenceAssessment?.matches?.[0];
      assert(safe?.strict === false && safe?.outcome === 'conflicts'
        && JSON.stringify(safe.sourceUrls) === JSON.stringify(['https://jobs.example.test/frontend'])
        && safe.sourceDate === '' && safe.verifiedAt === '',
      `listing evidence must retain only the validated listing URL, got ${JSON.stringify(safe)}`);
      assert(unsafe?.outcome === 'confirmed' && unsafe.sourceUrls.length === 0 && unsafe.sourceDate === '',
        `unsafe listing URLs and model-supplied provenance must be discarded, got ${JSON.stringify(unsafe)}`);

      const unsupportedListingClaim = await evaluateJobPreferences({
        jobs: [{ title: 'Backend Engineer', company: 'Example', snippet: 'Build APIs.' }],
        jobPreferences: 'Prefer no web development.',
        preferencePlan: valid,
        callRaw: () => { throw new Error('a soft role preference must not need web research'); },
        callText: async () => ({ assessments: [{ index: 0, matches: [{ preferenceId: 'pivot', outcome: 'conflicts', evidence: 'Model memory', evidenceQuote: 'Free catered lunch' }] }] }),
      });
      const unsupportedMatch = unsupportedListingClaim.jobs[0].preferenceAssessment.matches[0];
      assert(unsupportedMatch.outcome === 'unverified' && unsupportedMatch.sourceUrls.length === 0,
        `a confirmed/conflicting listing claim without a matching verbatim span must downgrade to unverified, got ${JSON.stringify(unsupportedMatch)}`);
      let incompleteRejected = false;
      try { validateJobPreferenceListingSubmission({ assessments: [{ index: 0, matches: [] }] }, [{ title: 'X' }], valid); } catch { incompleteRejected = true; }
      assert(incompleteRejected, 'a partial/malformed listing assessment must be rejected instead of silently filtering strict jobs');

      // A response that omits whole ROWS is recoverable with one targeted
      // follow-up; a response with a SHORT `matches` array is not, because a
      // missing preference silently defaults to `unverified` → `filtered`.
      let shortMatchesRejected = false;
      try {
        validateJobPreferenceListingSubmission(
          { assessments: [{ index: 0, matches: [] }] },
          [{ title: 'X' }], valid, { requireComplete: false },
        );
      } catch { shortMatchesRejected = true; }
      assert(shortMatchesRejected,
        'relaxing the row-count axis must NOT relax the per-row match-count axis — that is the axis that silently deletes jobs');
      assert(validateJobPreferenceListingSubmission({ assessments: [] }, [{ title: 'X' }], valid, { requireComplete: false }),
        'an omitted row is accepted by the relaxed validator so it can be re-requested on its own');

      // The adaptive sizer, driven end to end through the injected seam.
      // One round issues up to MANUAL_HANDOFF_CONCURRENCY (10) batches, so the
      // pool has to exceed 10 x the initial size before a second round exists.
      // Round 1 uses the conservative static size; later rounds re-size from
      // what the previous responses actually cost — here, a model that turned
      // sharply more verbose, which must shrink the next round.
      const sizedRounds = [];
      let observed = null;
      const remembered = new Map();
      const manyJobs = Array.from({ length: 150 }, (_, i) => ({
        title: `Engineer ${i}`, url: `https://jobs.example.test/${i}`, snippet: 'Engineer role.',
      }));
      const adaptive = await evaluateJobPreferences({
        jobs: manyJobs,
        jobPreferences: 'I want to pivot away from web development.',
        preferencePlan: valid,
        callRaw: () => { throw new Error('a soft role preference must not need web research'); },
        calibration: {
          observedTokensPerMatch: () => observed,
          recallRoundSize: (round) => remembered.get(round) ?? null,
          rememberRoundSize: (round, size, passKey, rate) => { remembered.set(round, { size, rate }); sizedRounds.push(size); },
        },
        callText: async (prompt) => {
          // Count the listings this prompt actually carried.
          const carried = (prompt.match(/https:\/\/jobs\.example\.test\//g) || []).length;
          // After the first response, report a verbose model: cost per match
          // jumps, so the next round must ask for fewer listings.
          observed = 2000;
          return { assessments: Array.from({ length: carried }, (_, index) => ({
            index,
            matches: [{ preferenceId: 'pivot', outcome: 'unverified', evidence: 'No signal.', evidenceQuote: '' }],
          })) };
        },
      });
      assert(adaptive.candidatePool.length === 150,
        `every listing must still be evaluated across adaptive rounds, got ${adaptive.candidatePool.length}`);
      assert(sizedRounds.length >= 2,
        `the run must re-size at least once rather than fixing a size up front, got ${sizedRounds.length} round(s)`);
      assert(sizedRounds[1] < sizedRounds[0],
        `a model that became more verbose must shrink the next round (${sizedRounds[0]} -> ${sizedRounds[1]})`);
      // Replay determinism: a recorded size wins over recomputation, because by
      // replay time the calibration has evidence the first pass did not.
      const replayRounds = [];
      observed = 20;
      await evaluateJobPreferences({
        jobs: manyJobs,
        jobPreferences: 'I want to pivot away from web development.',
        preferencePlan: valid,
        callRaw: () => { throw new Error('no research expected'); },
        calibration: {
          observedTokensPerMatch: () => observed,
          recallRoundSize: (round) => remembered.get(round) ?? null,
          rememberRoundSize: (round, size) => { replayRounds.push(size); },
          // (replay must not re-derive anything)
        },
        callText: async (prompt) => {
          const carried = (prompt.match(/https:\/\/jobs\.example\.test\//g) || []).length;
          return { assessments: Array.from({ length: carried }, (_, index) => ({
            index,
            matches: [{ preferenceId: 'pivot', outcome: 'unverified', evidence: 'No signal.', evidenceQuote: '' }],
          })) };
        },
      });
      assert(replayRounds.length === 0,
        'a replay must reuse every recorded round size and re-derive none, or its prompts stop matching the durable steps');

      // An actual persisted adaptive layout has no batchTotal. Its v1 alias
      // must retain that exact null metadata and the current concurrent batch
      // position; a fixed historic alias would point at the wrong durable key.
      const recalledAliases = [];
      let recalledCalls = 0;
      await evaluateJobPreferences({
        jobs: manyJobs.slice(0, 8),
        jobPreferences: 'I want to pivot away from web development.',
        preferencePlan: valid,
        callRaw: () => { throw new Error('no research expected'); },
        calibration: {
          recallRoundSize: round => round === 0 ? { size: 8, rate: 1800 } : null,
          observedTokensPerMatch: () => 20,
          rememberRoundSize: () => { throw new Error('recalled layout must not be re-recorded'); },
        },
        callText: async (prompt, options) => {
          recalledAliases.push(options.legacyReplay);
          const carried = (prompt.match(/https:\/\/jobs\.example\.test\//g) || []).length;
          recalledCalls += 1;
          return { assessments: Array.from({ length: recalledCalls === 1 ? carried - 1 : carried }, (_, index) => ({
            index,
            matches: [{ preferenceId: 'pivot', outcome: 'unverified', evidence: 'No signal.', evidenceQuote: '' }],
          })) };
        },
      });
      assert(recalledAliases.length === 2
        && recalledAliases[0]?.batch === 1 && recalledAliases[0]?.batchTotal === null && recalledAliases[0]?.itemCount === 8
        && recalledAliases[1]?.batch === 1 && recalledAliases[1]?.batchTotal === null && recalledAliases[1]?.itemCount === 1,
      `a recalled adaptive root and its partial follow-up must share null-total root metadata, got ${JSON.stringify(recalledAliases)}`);

      // A fresh adaptive size that merely happens to be eight must not inherit
      // a v1 alias unless it is exactly aligned with the old fixed partition.
      const freshAdaptiveAliases = [];
      await evaluateJobPreferences({
        jobs: manyJobs.slice(0, 16),
        jobPreferences: 'I want to pivot away from web development.',
        preferencePlan: valid,
        callRaw: () => { throw new Error('no research expected'); },
        calibration: { recallRoundSize: () => null, observedTokensPerMatch: () => 1800, rememberRoundSize: () => {} },
        callText: async (prompt, options) => {
          freshAdaptiveAliases.push(options.legacyReplay);
          const carried = (prompt.match(/https:\/\/jobs\.example\.test\//g) || []).length;
          return { assessments: Array.from({ length: carried }, (_, index) => ({
            index,
            matches: [{ preferenceId: 'pivot', outcome: 'unverified', evidence: 'No signal.', evidenceQuote: '' }],
          })) };
        },
      });
      assert(freshAdaptiveAliases.length === 2 && freshAdaptiveAliases.every(alias => alias === null),
        `a non-recalled adaptive mismatch must not offer a fixed v1 alias, got ${JSON.stringify(freshAdaptiveAliases)}`);

      const followUpPrompts = [];
      const partial = await evaluateJobPreferences({
        jobs: [
          { title: 'Frontend Developer', url: 'https://jobs.example.test/frontend', snippet: 'Frontend Developer role.' },
          { title: 'Data Engineer', url: 'https://jobs.example.test/data', snippet: 'Data Engineer role.' },
        ],
        jobPreferences: 'I want to pivot away from web development.',
        preferencePlan: valid,
        callRaw: () => { throw new Error('a soft role preference must not need web research'); },
        callText: async (prompt) => {
          followUpPrompts.push(prompt);
          // First handoff drops index 1 entirely.
          if (followUpPrompts.length === 1) {
            return { assessments: [
              { index: 0, matches: [{ preferenceId: 'pivot', outcome: 'conflicts', evidence: 'Web role', evidenceQuote: 'Frontend Developer' }] },
            ] };
          }
          return { assessments: [
            { index: 0, matches: [{ preferenceId: 'pivot', outcome: 'confirmed', evidence: 'Not a web role', evidenceQuote: 'Data Engineer' }] },
          ] };
        },
      });
      assert(followUpPrompts.length === 2, `an omitted row must cost exactly one targeted follow-up handoff, got ${followUpPrompts.length}`);
      assert(followUpPrompts[1].includes('Data Engineer') && !followUpPrompts[1].includes('Frontend Developer'),
        'the follow-up handoff must carry only the listings the first response skipped');
      assert(partial.candidatePool.length === 2,
        `no job may be lost to a partially-returned batch, got ${partial.candidatePool.length}`);
      const recovered = partial.candidatePool.find(job => job.title === 'Data Engineer')?.preferenceAssessment?.matches?.[0];
      assert(recovered?.outcome === 'confirmed',
        `the re-requested listing must carry its real evaluated outcome, not the default unverified, got ${JSON.stringify(recovered)}`);

      const groundedResearch = 'Grounded source URLs (provider metadata):\n- https://example.test/benefits — Benefits\n\nExample Co provides free lunch to employees.';
      const validResearch = {
        assessments: [{ preferenceId: 'lunch', outcome: 'confirmed', evidence: 'Benefits page confirms the meal.', evidenceQuote: 'provides free lunch to employees', sourceUrls: ['https://example.test/benefits'], sourceDate: '' }],
      };
      const researchValidationFailure = value => {
        try {
          validateJobPreferenceResearchSubmission(value, { preferenceId: 'lunch', groundedResearch });
          return null;
        } catch (error) {
          return { code: error?.code, diagnostic: error?.validationDiagnostic };
        }
      };
      const coverageResearchFailure = researchValidationFailure({ assessments: [] });
      const foreignResearchFailure = researchValidationFailure({ ...validResearch, assessments: [{ ...validResearch.assessments[0], preferenceId: 'other-preference' }] });
      const unsupportedQuoteFailure = researchValidationFailure({ ...validResearch, assessments: [{ ...validResearch.assessments[0], evidenceQuote: 'Invented benefit' }] });
      const unsupportedUrlFailure = researchValidationFailure({ ...validResearch, assessments: [{ ...validResearch.assessments[0], sourceUrls: ['https://other.test/benefits'] }] });
      const unsupportedDateResearch = { ...validResearch, assessments: [{ ...validResearch.assessments[0], sourceDate: '2099-01-01' }] };
      assert(coverageResearchFailure?.code === 'JOB_PREFERENCE_RESEARCH_RESPONSE_INVALID'
        && coverageResearchFailure.diagnostic?.reason === 'ASSESSMENT_COVERAGE_INVALID'
        && coverageResearchFailure.diagnostic.expectedCount === 1
        && coverageResearchFailure.diagnostic.receivedCount === 0
        && foreignResearchFailure?.diagnostic?.reason === 'ASSESSMENT_IDENTITY_INVALID'
        && unsupportedQuoteFailure?.diagnostic?.reason === 'ASSESSMENT_QUOTE_NOT_GROUNDED'
        && unsupportedUrlFailure?.diagnostic?.reason === 'ASSESSMENT_URL_NOT_GROUNDED'
        && validateJobPreferenceResearchSubmission(unsupportedDateResearch, { preferenceId: 'lunch', groundedResearch }) === unsupportedDateResearch
        && validateJobPreferenceResearchSubmission(validResearch, { preferenceId: 'lunch', groundedResearch }) === validResearch,
      'grounded company research must reject mismatched identity, quote, and URL while leaving optional source-date cleanup to normalization');

      let apiValidationSurfaced = false;
      try {
        await evaluateJobPreferences({
          jobs: [{ title: 'Program Manager', company: 'Response Validation Co' }],
          jobPreferences: 'Free lunch is required.',
          preferencePlan: {
            version: 1, summary: '', direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false },
            softPreferences: [], strictRequirements: [{ id: 'lunch', criterion: 'Free lunch', category: 'perk' }], warnings: [], titles: [],
          },
          callRaw: async () => groundedResearch,
          callText: async (_prompt, options) => {
            if (options.task === 'job-preference-evaluation') {
              return { assessments: [{ index: 0, matches: [{ preferenceId: 'lunch', outcome: 'unverified', evidence: 'Not listed.' }] }] };
            }
            options.responseValidator({
              assessments: [{ preferenceId: 'wrong-id', outcome: 'confirmed', evidence: 'Wrong response', evidenceQuote: 'provides free lunch to employees', sourceUrls: ['https://example.test/benefits'], sourceDate: '' }],
            });
            return validResearch;
          },
        });
      } catch (error) { apiValidationSurfaced = error?.code === 'JOB_PREFERENCE_RESEARCH_RESPONSE_INVALID'; }
      assert(apiValidationSurfaced,
        'an invalid API research extraction must surface its structured-response error instead of silently becoming an unverified strict filter');

      const strict = await evaluateJobPreferences({
        jobs: [{ title: 'Web Developer', url: 'https://jobs.example.test/web' }],
        jobPreferences: 'No web development.',
        preferencePlan: {
          ...directionOnly,
          version: 1,
          direction: { ...directionOnly.direction, avoidDirections: ['No web development'] },
          strictRequirements: [{ id: 'no-web', criterion: 'No web development', category: 'role' }],
        },
        callRaw: () => { throw new Error('role evidence is listing-only'); },
        callText: async () => ({ assessments: [{ index: 0, matches: [{ preferenceId: 'no-web', outcome: 'not_applicable', evidence: 'model escape hatch' }] }] }),
      });
      const strictMatch = strict.filteredJobs[0]?.preferenceAssessment.matches.find(match => match.preferenceId === 'no-web');
      assert(strict.filteredJobs.length === 1 && strictMatch?.outcome === 'unverified',
        'a strict non-confirmed outcome must normalize to unverified and fail closed');

      const sameTitleDifferentCities = await evaluateJobPreferences({
        jobs: [
          { title: 'Software Engineer', company: 'Example', location: 'New York, NY', url: 'https://jobs.example.test/ny' },
          { title: 'Software Engineer', company: 'Example', location: 'San Francisco, CA', url: 'https://jobs.example.test/sf' },
        ],
        jobPreferences: 'Prefer engineering roles.',
        preferencePlan: { ...valid, strictRequirements: [] },
        callRaw: () => { throw new Error('soft preferences must not research'); },
        callText: async () => ({ assessments: [
          { index: 0, matches: [{ preferenceId: 'pivot', outcome: 'confirmed', evidence: 'Software Engineer', evidenceQuote: 'Software Engineer' }] },
          { index: 1, matches: [{ preferenceId: 'pivot', outcome: 'confirmed', evidence: 'Software Engineer', evidenceQuote: 'Software Engineer' }] },
        ] }),
      });
      const auditLocations = sameTitleDifferentCities.preferenceEvaluation.audits.map(audit => audit.listingIdentity?.location);
      assert(JSON.stringify(auditLocations) === JSON.stringify(['New York, NY', 'San Francisco, CA']),
        `each audit must retain its listing identity so distinct same-title/company requisitions survive append merging, got ${JSON.stringify(sameTitleDifferentCities.preferenceEvaluation.audits)}`);
      return { directionRejected: rejected, listingUrl: safe.sourceUrls[0], strictFailClosed: true, hallucinatedListingClaimDowngraded: true, groundedResearchValidated: true, apiValidationSurfaced, auditLocations };
    },
  },
  {
    name: 'job preferences: long exact direction mirrors use the criterion bound and survive recovery without truncation',
    run: () => {
      // Regression for bug-report-2026-09-25T05-58-54-543Z: these are the
      // two exact direction strings that repeatedly failed the manual handoff.
      // Their matching preference criteria were valid at <=360 characters,
      // while direction had an undocumented 180-character cap.
      const longRole = "Target mid-level full-stack product engineering roles, strongest on the frontend, building customer-facing features for products that are the company's core offering and appropriate for about 3.5 years of experience.";
      const longAvoid = 'Exclude internal systems that support the business, including internal IT, internal tools, IT support, teams named Internal Tools, Business Systems, Enterprise Applications, Corporate Engineering, IT, or Back Office, and roles focused on internal stakeholders, supporting operations, vendor platform administration, or maintaining legacy systems.';
      assert(longRole.length === 216 && longAvoid.length === 346,
        `the regression strings must retain the reported lengths, got ${longRole.length}/${longAvoid.length}`);

      const reportedShape = {
        ...blankJobPreferencePlan(),
        direction: {
          summary: 'Customer-facing product engineering.',
          roleDirections: [longRole],
          avoidDirections: [longAvoid],
          explorationEnabled: false,
        },
        softPreferences: [{ id: 'soft-1', criterion: longRole, category: 'role' }],
        strictRequirements: [{ id: 'strict-1', criterion: longAvoid, category: 'role' }],
      };
      const validated = validateJobPreferencePlanSubmission(reportedShape);
      const recovered = sanitizeJobPreferencePlan(validated);
      const revalidated = validateJobPreferencePlanSubmission(recovered);
      assert(revalidated.direction.roleDirections[0] === longRole
        && revalidated.direction.avoidDirections[0] === longAvoid,
      'accepted long directions must remain exact after normalization and crash-recovery sanitization');

      const roleItemSchema = JOB_PREFERENCE_PLAN_SCHEMA.properties.direction.properties.roleDirections.items;
      const avoidItemSchema = JOB_PREFERENCE_PLAN_SCHEMA.properties.direction.properties.avoidDirections.items;
      const criterionSchema = JOB_PREFERENCE_PLAN_SCHEMA.properties.softPreferences.items.properties.criterion;
      assert(roleItemSchema.maxLength === JOB_PREFERENCE_CRITERION_MAX_LENGTH
        && avoidItemSchema.maxLength === JOB_PREFERENCE_CRITERION_MAX_LENGTH
        && criterionSchema.maxLength === JOB_PREFERENCE_CRITERION_MAX_LENGTH,
      'the handoff schema must advertise one shared direction/criterion length contract');

      const tooLong = 'x'.repeat(JOB_PREFERENCE_CRITERION_MAX_LENGTH + 1);
      const overlong = {
        ...reportedShape,
        direction: { ...reportedShape.direction, roleDirections: [tooLong] },
        softPreferences: [{ id: 'soft-1', criterion: tooLong, category: 'role' }],
      };
      const schemaErrorPaths = validateResponseSchema(overlong, JOB_PREFERENCE_PLAN_SCHEMA).map(error => error.path);
      let domainRejected = false;
      try { validateJobPreferencePlanSubmission(overlong); } catch { domainRejected = true; }
      assert(domainRejected
        && schemaErrorPaths.includes('$.direction.roleDirections[0]')
        && schemaErrorPaths.includes('$.softPreferences[0].criterion'),
      `overlong exact mirrors must be rejected by the visible schema and domain backstop, got ${JSON.stringify(schemaErrorPaths)}`);

      // The incident exposed a general contract hazard: any length enforced
      // only after schema validation produces the same opaque correction
      // loop. Pin every other text bound in these two preference handoffs to
      // the domain validator's existing limits as well.
      const visiblePlanBoundErrors = validateResponseSchema({
        ...reportedShape,
        summary: 's'.repeat(501),
        direction: { ...reportedShape.direction, summary: 'd'.repeat(401) },
        softPreferences: [{ id: 'i'.repeat(61), criterion: longRole, category: 'role' }],
        warnings: ['w'.repeat(301)],
        titles: ['t'.repeat(JOB_PREFERENCE_TITLE_MAX_LENGTH + 1)],
      }, JOB_PREFERENCE_PLAN_SCHEMA).map(error => error.path);
      const visibleAuditBoundErrors = validateResponseSchema({
        titles: [],
        added: ['a'.repeat(JOB_PREFERENCE_TITLE_MAX_LENGTH + 1)],
        addedReason: 'a'.repeat(501),
        removed: [],
        removedReason: '',
        rationale: 'r'.repeat(801),
      }, JOB_ROLE_AUDIT_SCHEMA).map(error => error.path);
      assert([
        '$.summary', '$.direction.summary', '$.softPreferences[0].id', '$.warnings[0]', '$.titles[0]',
      ].every(path => visiblePlanBoundErrors.includes(path))
        && ['$.titles', '$.added[0]', '$.addedReason', '$.rationale']
          .every(path => visibleAuditBoundErrors.includes(path)),
      `all runtime text bounds must be visible in their handoff schemas, got ${JSON.stringify({ visiblePlanBoundErrors, visibleAuditBoundErrors })}`);

      return { acceptedLengths: [longRole.length, longAvoid.length], schemaLimit: JOB_PREFERENCE_CRITERION_MAX_LENGTH };
    },
  },
  {
    name: 'job preferences: renderer append paths merge listing-aware audits and only new candidate counts',
    run: async () => {
      const [renderer, preferences] = await Promise.all([
        fs.promises.readFile(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8'),
        fs.promises.readFile(path.resolve('electron/ipc/jobPreferences.js'), 'utf8'),
      ]);
      assert(renderer.includes('const uniqueIdentifiedAudits = dedupJobsAcrossSources')
        && renderer.includes('audit.listingIdentity')
        && renderer.includes('const jobsToEvaluate = resultMode === \'append\'')
        && renderer.includes('uniqueJobsAcrossSources(existingPreferencePool, savedJobs)')
        && renderer.includes('gatheredDelta: resultMode === \'append\' ? jobsToEvaluate.length : null'),
      'saved/late append recovery must assess only candidates not already represented and merge audits with the candidate pool identity policy');
      assert(renderer.includes('preferenceMatchedDelta: scoreResult.preferenceMatchedCount ?? preferenceMatchedCount')
        && renderer.includes('preferenceCandidatePool: scoreResult.preferenceCandidatePool ?? preferenceCandidatePool')
        && renderer.includes('baseData: appendBaseData,')
        && renderer.includes('canCommit: appendCanCommit,')
        && renderer.includes('const appendCommitted = await appendJobsToDoneCanvas({')
        && renderer.includes("if (!appendCommitted) {")
        && renderer.includes('let functionalCommitAccepted = false;')
        && renderer.includes('functionalCommitAccepted = true;')
        && renderer.includes('await waitForRendererCommitFrame();')
        && renderer.includes('if (!functionalCommitAccepted || !committed) return false;')
        && renderer.includes("const recoveryBaseData = getNode(currentId)?.data || null;")
        && renderer.includes("appendBaseData: resultMode === 'append' ? recoveryBaseData : null")
        && renderer.includes('const appendBaseFingerprint = moduleFingerprint(recoveryBaseData.scoredJobs);')
        && renderer.includes('scoredJobs: [],')
        && renderer.includes('baseData: recoveryBaseData,')
        && renderer.includes("emptyResultDisposition: 'preference-filtered',")
        && renderer.includes("? (getNode(currentId)?.data?.resultDisposition || null)")
        && renderer.includes('canCommit: appendCanCommit,')
        && renderer.includes('gatheredCount: (Number(refreshData.gatheredCount) || 0) + freshJobs.length')
        && renderer.includes('Failed to save preference-filtered USAJobs snapshot')
        && renderer.includes("'preference-filtered'"),
      'append scoring must merge into and generation-fence an explicit live base (never report a dropped no-base append), while all-filtered late sources retain preference recovery state, disposition, and funnel volume');
      assert(renderer.includes('const activeTargetRole = String(laneTurnData.targetRole || \'\').trim()')
        && renderer.includes('targetRole: (refreshData.activeTargetRole ?? refreshData.targetRole ?? \'\').trim()')
        && renderer.includes('continuationData.pendingTargetRole')
        && renderer.includes('?? continuationData.activeTargetRole')
        && renderer.includes('?? continuationData.targetRole')
        && preferences.includes('listingIdentity: listingIdentityForAudit(job)'),
      'a run freezes Target role with its preferences across late and paused paths, and each emitted audit carries a bounded listing identity');
      return { appendCandidateGate: true, listingAwareAudits: true, frozenTargetRole: true };
    },
  },
  {
    name: 'job preferences: raw notes without a plan re-interpret, and cancellation never becomes an unverified filter',
    run: async () => {
      const raw = 'No web development roles.';
      const interpretedPlan = {
        version: 1, summary: '',
        direction: { summary: '', roleDirections: [], avoidDirections: ['No web development roles'], explorationEnabled: false },
        softPreferences: [], strictRequirements: [{ id: 'no-web', criterion: 'No web development roles', category: 'role' }],
        warnings: [], titles: [],
      };
      const tasks = [];
      const direct = await evaluateJobPreferences({
        jobs: [{ title: 'Web Developer', snippet: 'Web Developer role' }], jobPreferences: raw,
        // Recovery can preserve a bounded but stale/malformed plan. The raw
        // user instruction is authoritative and must be interpreted again.
        preferencePlan: { ...interpretedPlan, softPreferences: [], strictRequirements: [] },
        callRaw: () => { throw new Error('role requirement uses listing evidence'); },
        callText: async (_prompt, options) => {
          tasks.push(options.task);
          if (options.task === 'job-preference-interpretation') return interpretedPlan;
          return { assessments: [{ index: 0, matches: [{ preferenceId: 'no-web', outcome: 'conflicts', evidence: 'Role title', evidenceQuote: 'Web Developer' }] }] };
        },
      });
      assert(JSON.stringify(tasks) === JSON.stringify(['job-preference-interpretation', 'job-preference-evaluation']) && direct.filteredJobs.length === 1,
        `missing plans must be re-interpreted before evaluation, got ${JSON.stringify({ tasks, direct: direct.counts })}`);

      // A shape that normalization could turn into an empty plan is not a
      // valid recovered/model submission. With raw user text still available
      // it must be repaired through interpretation, never silently accepted.
      let malformedRejected = false;
      try {
        validateJobPreferencePlanSubmission({ ...interpretedPlan, direction: 'not an object', softPreferences: 'not an array', strictRequirements: [] });
      } catch { malformedRejected = true; }
      const repairTasks = [];
      const repaired = await evaluateJobPreferences({
        jobs: [{ title: 'Web Developer' }], jobPreferences: raw,
        preferencePlan: { ...interpretedPlan, direction: 'not an object', softPreferences: 'not an array', strictRequirements: [] },
        callRaw: () => { throw new Error('role requirement uses listing evidence'); },
        callText: async (_prompt, options) => {
          repairTasks.push(options.task);
          if (options.task === 'job-preference-interpretation') return interpretedPlan;
          return { assessments: [{ index: 0, matches: [{ preferenceId: 'no-web', outcome: 'conflicts', evidence: 'Role title', evidenceQuote: 'Web Developer' }] }] };
        },
      });
      assert(malformedRejected && JSON.stringify(repairTasks) === JSON.stringify(['job-preference-interpretation', 'job-preference-evaluation'])
        && repaired.filteredJobs.length === 1,
      'malformed direction/arrays must re-interpret raw Job Preferences instead of normalizing into a permissive empty plan');
      let duplicateIdRejected = false;
      try {
        validateJobPreferencePlanSubmission({
          ...interpretedPlan,
          softPreferences: [{ id: 'no-web', criterion: 'Prefer product roles', category: 'role' }],
        });
      } catch { duplicateIdRejected = true; }
      assert(duplicateIdRejected, 'preference ids must be unique across soft and strict items before evaluation maps model rows by id');

      // Phase B deleted targetRoleConflict outright: with the standalone
      // Target role box gone there is nothing left for a plan to contradict,
      // so evaluateJobPreferences no longer throws JOB_PREFERENCE_TARGET_ROLE_CONFLICT
      // even when a repaired plan carries the (now-inert) field. Prove the
      // repair path completes normally instead of throwing.
      const inertConflictPlan = { ...interpretedPlan, targetRoleConflict: true, targetRoleConflictReason: 'stale field from an old model response' };
      const repairedNoLongerConflicts = await evaluateJobPreferences({
        jobs: [{ title: 'Web Developer' }], jobPreferences: raw, targetRole: 'Web Developer',
        preferencePlan: { ...interpretedPlan, direction: 'not an object' },
        callRaw: () => { throw new Error('role requirement uses listing evidence'); },
        callText: async (_prompt, options) => options.task === 'job-preference-interpretation'
          ? inertConflictPlan
          : { assessments: [{ index: 0, matches: [{ preferenceId: 'no-web', outcome: 'conflicts', evidence: 'Role title', evidenceQuote: 'Web Developer' }] }] },
      });
      assert(repairedNoLongerConflicts.filteredJobs.length === 1,
        'a repaired plan carrying a stale targetRoleConflict field must evaluate normally, not throw a retired conflict error');

      const softItems = Array.from({ length: 12 }, (_, index) => ({ id: `soft-${index}`, criterion: `Role signal ${index}`, category: 'role' }));
      const softOrder = await evaluateJobPreferences({
        jobs: [{ title: 'Role A' }, { title: 'Role B' }], jobPreferences: 'soft ranking',
        preferencePlan: { version: 1, summary: '', direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false }, softPreferences: softItems, strictRequirements: [], warnings: [], titles: [] },
        callRaw: () => { throw new Error('soft ranking must not research'); },
        callText: async () => ({ assessments: [
          { index: 0, matches: softItems.map((item, index) => ({ preferenceId: item.id, outcome: index === 0 ? 'confirmed' : 'conflicts', evidence: 'Role A', evidenceQuote: 'Role A' })) },
          { index: 1, matches: softItems.map(item => ({ preferenceId: item.id, outcome: 'unverified', evidence: 'No evidence' })) },
        ] }),
      });
      assert(softOrder.jobs[0].title === 'Role A' && softOrder.jobs[0].preferenceAssessment.preferenceScore > softOrder.jobs[1].preferenceAssessment.preferenceScore,
        'one additional soft confirmation must outrank any number of soft conflicts, matching the documented lexicographic ordering');

      const controller = new AbortController(); controller.abort(new Error('cancelled by test'));
      let cancelled = false;
      try {
        await evaluateJobPreferences({
          jobs: [{ title: 'Program Manager', company: 'Example', snippet: 'Programs' }], jobPreferences: 'Lunch must be provided.',
          preferencePlan: { version: 1, summary: '', direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false }, softPreferences: [], strictRequirements: [{ id: 'lunch', criterion: 'Lunch provided', category: 'perk' }], warnings: [], titles: [] },
          signal: controller.signal,
          callText: async (_prompt, options) => options.task === 'job-preference-evaluation'
            ? { assessments: [{ index: 0, matches: [{ preferenceId: 'lunch', outcome: 'unverified', evidence: 'Missing' }] }] }
            : { assessments: [] },
          callRaw: async () => { throw new Error('should not be reached after cancellation'); },
        });
      } catch (error) { cancelled = error.message === 'cancelled by test'; }
      assert(cancelled, 'cancellation must propagate rather than become a strict unverified filtering verdict');

      // Some transports resolve despite receiving an abort. Check again after
      // each awaited boundary so that late cancellation cannot cache or return
      // a preference verdict.
      const lateController = new AbortController();
      let lateCancelled = false;
      try {
        await evaluateJobPreferences({
          jobs: [{ title: 'Program Manager', company: 'Late Abort Co' }], jobPreferences: 'Lunch must be provided.',
          preferencePlan: { version: 1, summary: '', direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false }, softPreferences: [], strictRequirements: [{ id: 'lunch', criterion: 'Lunch provided', category: 'perk' }], warnings: [], titles: [] },
          signal: lateController.signal,
          useLegacyIndividualResearch: true,
          callText: async (_prompt, options) => options.task === 'job-preference-evaluation'
            ? { assessments: [{ index: 0, matches: [{ preferenceId: 'lunch', outcome: 'unverified', evidence: 'Missing' }] }] }
            : { assessments: [] },
          callRaw: async () => {
            lateController.abort(new Error('late cancellation'));
            return 'Grounded source URLs (provider metadata):\n- https://example.test/benefits — Benefits\n\nFree lunch is provided.';
          },
        });
      } catch (error) { lateCancelled = error.message === 'late cancellation'; }
      assert(lateCancelled, 'a transport that resolves after abort must not turn cancellation into an assessment or cache entry');

      const firstController = new AbortController();
      const secondController = new AbortController();
      const companyPlan = {
        version: 1, summary: '', direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false },
        softPreferences: [], strictRequirements: [{ id: 'lunch', criterion: 'Free lunch', category: 'perk' }], warnings: [], titles: [],
      };
      let rawCalls = 0;
      let markFirstResearchStarted;
      const firstResearchStarted = new Promise(resolve => { markFirstResearchStarted = resolve; });
      const sharedText = async (_prompt, options) => {
        if (options.task === 'job-preference-evaluation') return { assessments: [{ index: 0, matches: [{ preferenceId: 'lunch', outcome: 'unverified', evidence: 'Not listed' }] }] };
        return { assessments: [{ preferenceId: 'lunch', outcome: 'confirmed', evidence: 'Benefits page', evidenceQuote: 'Free lunch is provided.', sourceUrls: ['https://example.test/benefits'], sourceDate: '2099-01-01' }] };
      };
      const sharedRaw = (_prompt, options) => {
        rawCalls += 1;
        // The evaluator composes each caller's signal with a wave-local abort
        // signal, so object identity is intentionally different here. The
        // first invocation still belongs to the first run and must remain
        // independently cancellable from the second identical lookup.
        if (rawCalls === 1) {
          markFirstResearchStarted();
          return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
        }
        return Promise.resolve('Grounded source URLs (provider metadata):\n- https://example.test/benefits — Benefits\n\nFree lunch is provided.');
      };
      const first = evaluateJobPreferences({ jobs: [{ title: 'Program Manager', company: 'Example' }], jobPreferences: 'Lunch must be provided.', preferencePlan: companyPlan, signal: firstController.signal, callText: sharedText, callRaw: sharedRaw, useLegacyIndividualResearch: true });
      const firstSettled = first.then(() => null, error => error);
      await firstResearchStarted;
      const second = evaluateJobPreferences({ jobs: [{ title: 'Program Manager', company: 'Example' }], jobPreferences: 'Lunch must be provided.', preferencePlan: companyPlan, signal: secondController.signal, callText: sharedText, callRaw: sharedRaw, useLegacyIndividualResearch: true });
      firstController.abort(new Error('first run cancelled'));
      const [firstError, secondResult] = await Promise.all([firstSettled, second]);
      const researchMatch = secondResult.acceptedJobs[0]?.preferenceAssessment?.matches?.[0];
      assert(firstError?.message === 'first run cancelled' && secondResult.acceptedJobs.length === 1 && rawCalls === 2
        && researchMatch?.sourceDate === '',
        'a cancelled caller must not poison a concurrent identical preference lookup with a different AbortSignal');
      return { reinterpreted: true, malformedPlanRepaired: true, cancellationPropagated: true, lateCancellationPropagated: true, independentConcurrentResearch: true };
    },
  },
  {
    name: 'job preferences: blank notes bypass AI while strict unresolved company requirements are independently checked and fail closed',
    run: async () => {
      const jobs = [{ title: 'Program Manager', company: 'Example Co', description: 'Own strategic programs.' }];
      const neverCall = () => { throw new Error('blank preferences must not call AI'); };
      const blank = await evaluateJobPreferences({
        jobs,
        jobPreferences: '',
        preferencePlan: blankJobPreferencePlan(),
        callText: neverCall,
        callRaw: neverCall,
      });
      assert(blank.aiSkipped && blank.acceptedJobs.length === 1 && blank.filteredJobs.length === 0,
        `blank Job Preferences must preserve all jobs without AI work, got ${JSON.stringify(blank.counts)}`);

      let listingCalls = 0;
      let groundedCalls = 0;
      const strict = await evaluateJobPreferences({
        jobs,
        jobPreferences: 'The company must provide free lunch.',
        preferencePlan: {
          version: 1,
          summary: 'Free lunch is mandatory.',
          direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false },
          softPreferences: [],
          strictRequirements: [{ id: 'lunch', criterion: 'Free lunch is a listed company perk', category: 'perk' }],
          warnings: [],
          titles: [],
        },
        useLegacyIndividualResearch: true,
        callText: async (_prompt, options) => {
          if (options.task === 'job-preference-evaluation') {
            listingCalls += 1;
            return { assessments: [{ index: 0, matches: [{ preferenceId: 'lunch', outcome: 'unverified', evidence: 'Listing does not mention meals.' }] }] };
          }
          throw new Error(`unexpected text task ${options.task}`);
        },
        callRaw: async () => {
          groundedCalls += 1;
          throw new Error('web research unavailable');
        },
      });
      const match = strict.filteredJobs[0]?.preferenceAssessment?.matches?.[0];
      assert(listingCalls === 1 && groundedCalls === 1
        && strict.acceptedJobs.length === 0 && strict.filteredJobs.length === 1
        && match?.outcome === 'unverified' && match?.source === 'none',
      `strict unresolved company perks must attempt web research then filter fail-closed, got ${JSON.stringify({ listingCalls, groundedCalls, strict, match })}`);
      const unsupportedResearch = await evaluateJobPreferences({
        jobs,
        jobPreferences: 'The company must provide free lunch.',
        preferencePlan: {
          version: 1, summary: '',
          direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false },
          softPreferences: [], strictRequirements: [{ id: 'lunch', criterion: 'Free lunch is a listed company perk', category: 'perk' }],
          warnings: [], titles: [],
        },
        useLegacyIndividualResearch: true,
        callRaw: async () => 'Grounded source URLs (provider metadata):\n- https://example.test/benefits — Benefits\n\nThe office is downtown.',
        callText: async (_prompt, options) => options.task === 'job-preference-evaluation'
          ? { assessments: [{ index: 0, matches: [{ preferenceId: 'lunch', outcome: 'unverified', evidence: 'Not in listing.' }] }] }
          : { assessments: [{ preferenceId: 'lunch', outcome: 'confirmed', evidence: 'Model claim', evidenceQuote: 'Free lunch is provided.', sourceUrls: ['https://example.test/benefits'], sourceDate: '' }] },
      });
      const unsupportedResearchMatch = unsupportedResearch.filteredJobs[0]?.preferenceAssessment?.matches?.[0];
      assert(unsupportedResearchMatch?.outcome === 'unverified' && unsupportedResearchMatch.sourceUrls.length === 0,
        `a web verdict needs both a source URL and a verbatim grounded quote, got ${JSON.stringify(unsupportedResearchMatch)}`);

      // Fresh raw research packs up to twelve companies; its compact dependent
      // assessment can safely combine the completed sections into 27 rows.
      // An opaque research id keeps each employer's proof isolated.
      const batchJobs = Array.from({ length: 13 }, (_, index) => ({ title: 'Program Manager', company: `Batch Company ${index}` }));
      const batchRawCalls = [];
      const batchAssessmentCalls = [];
      const batched = await evaluateJobPreferences({
        jobs: batchJobs,
        jobPreferences: 'Free lunch is required.',
        preferencePlan: {
          version: 1, summary: '', direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false },
          softPreferences: [], strictRequirements: [{ id: 'lunch', criterion: 'Free lunch', category: 'perk' }], warnings: [], titles: [],
        },
        callRaw: async (prompt, options) => {
          const ids = [...new Set(prompt.match(/research-[a-f0-9]{20}/g) || [])];
          batchRawCalls.push({ prompt, ids, options });
          return ids.map(id => `BEGIN RESEARCH ${id}\nEvidence ${id}: Free lunch is provided. https://example.test/${id}\nEND RESEARCH ${id}`).join('\n');
        },
        callText: async (prompt, options) => {
          if (options.task === 'job-preference-evaluation') {
            return { assessments: batchJobs.map((_, index) => ({ index, matches: [{ preferenceId: 'lunch', outcome: 'unverified', evidence: 'Not listed.' }] })) };
          }
          const ids = [...new Set(prompt.match(/research-[a-f0-9]{20}/g) || [])];
          batchAssessmentCalls.push({ ids, options, prompt });
          return { assessments: ids.map((id, index) => ({
            researchId: id, preferenceId: 'lunch', outcome: 'confirmed', evidence: 'Benefits evidence.',
            evidenceQuote: `Evidence ${id}: Free lunch is provided.`, sourceUrls: [`https://example.test/${id}`], sourceDate: index === 0 ? '2099-01-01' : '',
          })) };
        },
      });
      const batchedInvalidDateMatch = batched.acceptedJobs[0]?.preferenceAssessment?.matches?.[0];
      const singletonUngroundedDate = await evaluateJobPreferences({
        jobs: [{ title: 'Program Manager', company: 'Singleton Ungrounded Date Co' }],
        jobPreferences: 'Free lunch is required.',
        preferencePlan: {
          version: 1, summary: '', direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false },
          softPreferences: [], strictRequirements: [{ id: 'lunch', criterion: 'Free lunch', category: 'perk' }], warnings: [], titles: [],
        },
        useLegacyIndividualResearch: true,
        callRaw: async () => 'Singleton proof: Free lunch is provided. https://example.test/singleton-date',
        callText: async (_prompt, options) => options.task === 'job-preference-evaluation'
          ? { assessments: [{ index: 0, matches: [{ preferenceId: 'lunch', outcome: 'unverified', evidence: 'Not listed.' }] }] }
          : { assessments: [{ preferenceId: 'lunch', outcome: 'confirmed', evidence: 'Benefits page.', evidenceQuote: 'Singleton proof: Free lunch is provided.', sourceUrls: ['https://example.test/singleton-date'], sourceDate: '2099-01-01' }] },
      });
      const singletonUngroundedDateMatch = singletonUngroundedDate.acceptedJobs[0]?.preferenceAssessment?.matches?.[0];

      const sourceDateCases = [
        { sourceDate: '2026', researchDate: 'Last updated: 2026-01-15', expected: '' },
        { sourceDate: '2026-01', researchDate: 'Last updated: 2026-01-15', expected: '' },
        { sourceDate: '2026-01-15', researchDate: 'Last updated: 2026-01-15', expected: '2026-01-15' },
        { sourceDate: 'March 2,', researchDate: 'Published: March 2, 2026', expected: '' },
        { sourceDate: 'March 2, 2026', researchDate: 'Published: March 2, 2026', expected: 'March 2, 2026' },
        { sourceDate: 'Published free lunch benefit.', researchDate: '', expected: '' },
        { sourceDate: '2026-01-15', researchDate: '', expected: '', url: 'https://example.test/releases/2026-01-15?published=2026-01-15' },
      ];
      const exactDateMatches = await Promise.all(sourceDateCases.map(async ({ sourceDate, researchDate, expected, url: caseUrl }, index) => {
        const url = caseUrl || `https://example.test/truncated-date-${index}`;
        const quote = 'Published free lunch benefit.';
        const evaluated = await evaluateJobPreferences({
          jobs: [{ title: 'Program Manager', company: `Truncated Date ${index} Co` }],
          jobPreferences: 'Free lunch is required.',
          preferencePlan: {
            version: 1, summary: '', direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false },
            softPreferences: [], strictRequirements: [{ id: 'lunch', criterion: 'Free lunch', category: 'perk' }], warnings: [], titles: [],
          },
          callRaw: async prompt => {
            const ids = [...new Set(prompt.match(/research-[a-f0-9]{20}/g) || [])];
            return ids.map(id => `BEGIN RESEARCH ${id}\n${quote} ${researchDate} ${url}\nEND RESEARCH ${id}`).join('\n');
          },
          callText: async (prompt, options) => {
            if (options.task === 'job-preference-evaluation') {
              return { assessments: [{ index: 0, matches: [{ preferenceId: 'lunch', outcome: 'unverified', evidence: 'Not listed.' }] }] };
            }
            const ids = [...new Set(prompt.match(/research-[a-f0-9]{20}/g) || [])];
            return { assessments: ids.map(researchId => ({ researchId, preferenceId: 'lunch', outcome: 'confirmed', evidence: 'Benefits page.', evidenceQuote: quote, sourceUrls: [url], sourceDate })) };
          },
        });
        return { sourceDate, expected, match: evaluated.acceptedJobs[0]?.preferenceAssessment?.matches?.[0] };
      }));

      const tailDate = 'Last updated: 2026-09-18';
      const tailQuote = 'Tail proof: Free lunch is provided.';
      const tailUrl = 'https://example.test/tail-provenance';
      const tailProvenance = await evaluateJobPreferences({
        jobs: [{ title: 'Program Manager', company: 'Tail Provenance Co' }],
        jobPreferences: 'Free lunch is required.',
        preferencePlan: {
          version: 1, summary: '', direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false },
          softPreferences: [], strictRequirements: [{ id: 'lunch', criterion: 'Free lunch', category: 'perk' }], warnings: [], titles: [],
        },
        callRaw: async prompt => {
          const ids = [...new Set(prompt.match(/research-[a-f0-9]{20}/g) || [])];
          return ids.map(id => `BEGIN RESEARCH ${id}\n${'x'.repeat(20_001)}\n${tailQuote} ${tailDate} ${tailUrl}\nEND RESEARCH ${id}`).join('\n');
        },
        callText: async (prompt, options) => {
          if (options.task === 'job-preference-evaluation') {
            return { assessments: [{ index: 0, matches: [{ preferenceId: 'lunch', outcome: 'unverified', evidence: 'Not listed.' }] }] };
          }
          const ids = [...new Set(prompt.match(/research-[a-f0-9]{20}/g) || [])];
          return { assessments: ids.map(researchId => ({ researchId, preferenceId: 'lunch', outcome: 'confirmed', evidence: 'Benefits page.', evidenceQuote: tailQuote, sourceUrls: [tailUrl], sourceDate: tailDate })) };
        },
      });
      const tailProvenanceMatch = tailProvenance.acceptedJobs[0]?.preferenceAssessment?.matches?.[0];

      let unverifiedProvenanceRawCalls = 0;
      const evaluateUnverifiedProvenance = () => evaluateJobPreferences({
        jobs: [{ title: 'Program Manager', company: 'Singleton Unverified Provenance Co' }],
        jobPreferences: 'Free lunch is required.',
        preferencePlan: {
          version: 1, summary: '', direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false },
          softPreferences: [], strictRequirements: [{ id: 'lunch', criterion: 'Free lunch', category: 'perk' }], warnings: [], titles: [],
        },
        useLegacyIndividualResearch: true,
        callRaw: async () => {
          unverifiedProvenanceRawCalls += 1;
          return 'Unverified proof: Free lunch is provided. Last updated: 2026-09-18 https://example.test/unverified-provenance';
        },
        callText: async (_prompt, options) => options.task === 'job-preference-evaluation'
          ? { assessments: [{ index: 0, matches: [{ preferenceId: 'lunch', outcome: 'unverified', evidence: 'Not listed.' }] }] }
          : { assessments: [{ preferenceId: 'lunch', outcome: 'unverified', evidence: 'Benefits page was inconclusive.', evidenceQuote: 'Unverified proof: Free lunch is provided.', sourceUrls: ['https://example.test/unverified-provenance'], sourceDate: 'Last updated: 2026-09-18' }] },
      });
      const unverifiedProvenanceFirst = await evaluateUnverifiedProvenance();
      const unverifiedProvenanceSecond = await evaluateUnverifiedProvenance();
      const unverifiedProvenanceMatch = unverifiedProvenanceFirst.filteredJobs[0]?.preferenceAssessment?.matches?.[0];
      const firstBatchIds = batchRawCalls[0]?.ids || [];
      const assessmentIds = batchAssessmentCalls[0]?.ids || [];
      const rawProgressHints = batchRawCalls.map(call => call.options.hints);
      const assessmentProgressHints = batchAssessmentCalls.map(call => call.options.hints);
      const validRawSections = firstBatchIds.map(id => `BEGIN RESEARCH ${id}\nEvidence ${id}: Free lunch is provided. https://example.test/${id}\nEND RESEARCH ${id}`).join('\n');
      const invalidRawSections = [
        `BEGIN RESEARCH ${firstBatchIds[0]}\nOnly one section.\nEND RESEARCH ${firstBatchIds[0]}`,
        `${validRawSections}\nBEGIN RESEARCH ${firstBatchIds[0]}\nDuplicate.\nEND RESEARCH ${firstBatchIds[0]}`,
        validRawSections.replace(firstBatchIds[0], 'research-00000000000000000000'),
      ];
      const rejectedRawContracts = invalidRawSections.filter(raw => {
        try { batchRawCalls[0]?.options?.responseValidator(raw); return false; }
        catch (error) { return error?.code === 'JOB_PREFERENCE_RESEARCH_RESPONSE_INVALID'; }
      }).length;
      const parserIds = ['research-11111111111111111111', 'research-22222222222222222222'];
      const parserSections = parserIds.map((id, index) => `BEGIN RESEARCH ${id}\nEvidence ${index + 1}. https://example.test/${index + 1}\nEND RESEARCH ${id}`).join('\n');
      const benignWrapped = parseJobPreferenceResearchSections(`A short display preamble.\n\`\`\`text\n${parserSections}\n\`\`\`\nA short display postamble.`, parserIds);
      const benignBare = parseJobPreferenceResearchSections(`A short display preamble.\n${parserSections}\nA short display postamble.`, parserIds);
      const parserFailure = raw => {
        try {
          parseJobPreferenceResearchSections(raw, parserIds);
          return null;
        } catch (error) {
          return { code: error?.code, diagnostic: error?.validationDiagnostic };
        }
      };
      const missingDiagnostic = parserFailure(parserSections.split('\n').slice(0, 3).join('\n'));
      const unknownDiagnostic = parserFailure(`${parserSections}\nBEGIN RESEARCH research-33333333333333333333\nForeign evidence.\nEND RESEARCH research-33333333333333333333`);
      const duplicateDiagnostic = parserFailure(`${parserSections}\nBEGIN RESEARCH ${parserIds[0]}\nRepeated evidence.\nEND RESEARCH ${parserIds[0]}`);
      const malformedDiagnostic = parserFailure(`BEGIN RESEARCH ${parserIds[0]}\nEvidence one.\nEND RESEARCH ${parserIds[1]}\nBEGIN RESEARCH ${parserIds[1]}\nEvidence two.\nEND RESEARCH ${parserIds[1]}`);
      const emptyDiagnostic = parserFailure(`BEGIN RESEARCH ${parserIds[0]}\n\nEND RESEARCH ${parserIds[0]}\nBEGIN RESEARCH ${parserIds[1]}\nEvidence two.\nEND RESEARCH ${parserIds[1]}`);
      const decoratedMarkerDiagnostic = parserFailure(`BEGIN RESEARCH ${parserIds[0]}\nEvidence one.\n**BEGIN RESEARCH ${parserIds[1]}**\nEND RESEARCH ${parserIds[0]}\nBEGIN RESEARCH ${parserIds[1]}\nEvidence two.\nEND RESEARCH ${parserIds[1]}`);
      const reversedOrderDiagnostic = parserFailure(parserSections.split('\n').slice(3).concat(parserSections.split('\n').slice(0, 3)).join('\n'));
      assert(benignWrapped.size === 2 && benignBare.size === 2
        && benignWrapped.get(parserIds[0]) === 'Evidence 1. https://example.test/1'
        && benignBare.get(parserIds[1]) === 'Evidence 2. https://example.test/2'
        && missingDiagnostic?.code === 'JOB_PREFERENCE_RESEARCH_RESPONSE_INVALID'
        && missingDiagnostic?.diagnostic?.reason === 'MISSING_SECTION'
        && missingDiagnostic.diagnostic.expectedCount === 2 && missingDiagnostic.diagnostic.missingCount === 1
        && unknownDiagnostic?.diagnostic?.reason === 'UNKNOWN_SECTION' && unknownDiagnostic.diagnostic.unknownCount === 1
        && duplicateDiagnostic?.diagnostic?.reason === 'DUPLICATE_SECTION' && duplicateDiagnostic.diagnostic.duplicateCount === 1
        && malformedDiagnostic?.diagnostic?.reason === 'MALFORMED_MARKER' && malformedDiagnostic.diagnostic.markerCount > 0
        && decoratedMarkerDiagnostic?.diagnostic?.reason === 'MALFORMED_MARKER' && decoratedMarkerDiagnostic.diagnostic.markerCount > 0
        && emptyDiagnostic?.diagnostic?.reason === 'EMPTY_SECTION' && emptyDiagnostic.diagnostic.emptyCount === 1
        && reversedOrderDiagnostic?.code === 'JOB_PREFERENCE_RESEARCH_RESPONSE_INVALID'
        && reversedOrderDiagnostic?.diagnostic?.reason === 'UNEXPECTED_SECTION_ORDER'
        && reversedOrderDiagnostic.diagnostic.expectedCount === 2 && reversedOrderDiagnostic.diagnostic.sectionCount === 2
        && [missingDiagnostic, unknownDiagnostic, duplicateDiagnostic, malformedDiagnostic, decoratedMarkerDiagnostic, emptyDiagnostic, reversedOrderDiagnostic]
          .every(result => result && Object.values(result.diagnostic).every(value => typeof value === 'string' || typeof value === 'number')),
      `raw research parser must allow harmless wrappers while exposing sterile exact-section diagnostics, got ${JSON.stringify({ missingDiagnostic, unknownDiagnostic, duplicateDiagnostic, malformedDiagnostic, decoratedMarkerDiagnostic, emptyDiagnostic, reversedOrderDiagnostic })}`);
      const validAssessmentRows = assessmentIds.map(id => ({
        researchId: id,
        preferenceId: 'lunch',
        outcome: 'confirmed',
        evidence: 'Benefits evidence.',
        evidenceQuote: `Evidence ${id}: Free lunch is provided.`,
        sourceUrls: [`https://example.test/${id}`],
        sourceDate: '',
      }));
      const invalidAssessmentRows = [
        validAssessmentRows.slice(1),
        validAssessmentRows.map((row, index) => index === 0 ? { ...row, researchId: 'research-00000000000000000000' } : row),
        validAssessmentRows.map((row, index) => index === 1 ? { ...row, researchId: firstBatchIds[0] } : row),
        validAssessmentRows.map((row, index) => index === 0 ? { ...row, evidenceQuote: validAssessmentRows[1].evidenceQuote } : row),
        validAssessmentRows.map((row, index) => index === 0 ? { ...row, sourceUrls: validAssessmentRows[1].sourceUrls } : row),
      ];
      const ungroundedDateBatch = { assessments: validAssessmentRows.map((row, index) => index === 0 ? { ...row, sourceDate: '2099-01-01' } : row) };
      const assessmentFailures = invalidAssessmentRows.map(assessments => {
        try {
          batchAssessmentCalls[0]?.options?.responseValidator({ assessments });
          return null;
        } catch (error) {
          return { code: error?.code, diagnostic: error?.validationDiagnostic };
        }
      });
      const rejectedAssessmentContracts = assessmentFailures.filter(failure => failure?.code === 'JOB_PREFERENCE_RESEARCH_RESPONSE_INVALID').length;
      const [coverageFailure, foreignIdentityFailure, duplicateIdentityFailure, quoteFailure, urlFailure] = assessmentFailures;
      let repeatedResearchCalls = 0;
      const cachedRepeat = await evaluateJobPreferences({
        jobs: batchJobs,
        jobPreferences: 'Free lunch is required.',
        preferencePlan: {
          version: 1, summary: '', direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false },
          softPreferences: [], strictRequirements: [{ id: 'lunch', criterion: 'Free lunch', category: 'perk' }], warnings: [], titles: [],
        },
        callRaw: async () => {
          repeatedResearchCalls += 1;
          throw new Error('a wholly cached research batch should not be reissued');
        },
        callText: async (_prompt, options) => {
          if (options.task === 'job-preference-evaluation') {
            return { assessments: batchJobs.map((_, index) => ({ index, matches: [{ preferenceId: 'lunch', outcome: 'unverified', evidence: 'Not listed.' }] })) };
          }
          repeatedResearchCalls += 1;
          throw new Error('a wholly cached assessment batch should not be reissued');
        },
      });
      assert(batchRawCalls.length === 2 && JSON.stringify(batchRawCalls.map(call => call.ids.length)) === JSON.stringify([12, 1])
        && batchAssessmentCalls.length === 1 && JSON.stringify(batchAssessmentCalls.map(call => call.ids.length)) === JSON.stringify([13])
        && batchRawCalls.every(call => call.options.task === 'job-preference-research-batch' && call.options.retryOnTruncation === false)
        && batchAssessmentCalls.every(call => call.options.task === 'job-preference-research-batch-assessment')
        && batchAssessmentCalls.every(call => call.prompt.includes('short verbatim evidenceQuote')
          && !call.prompt.includes('ASSESSMENT PROVENANCE CHECK')
          && call.options.displayOnlyPromptSuffix.includes('one short literal contiguous passage')
          && call.options.displayOnlyPromptSuffix.includes('literal direct http(s) URL')
          && call.options.displayOnlyPromptSuffix.includes('empty sourceUrls'))
        && batchRawCalls.every(call => call.options.hints.itemsTotal === 13)
        // Planned batch position is not completed work: every handoff starts
        // from the actual zero baseline and the transport advances this
        // shared scope only once a response is durably accepted.
        && JSON.stringify(rawProgressHints.map(hints => hints.itemsDone)) === JSON.stringify([0, 0])
        && rawProgressHints.every(hints => hints.itemsTotal === 13 && hints.progressUnits > 0)
        && typeof rawProgressHints[0]?.progressScopeId === 'string'
        && rawProgressHints.every(hints => hints.progressScopeId === rawProgressHints[0].progressScopeId)
        && JSON.stringify(rawProgressHints.map(hints => hints.progressUnitId)) === JSON.stringify(['company-research-raw-1', 'company-research-raw-2'])
        && JSON.stringify(rawProgressHints.map(hints => hints.progressUnits)) === JSON.stringify([12, 1])
        && assessmentProgressHints.length === 1
        && assessmentProgressHints[0].itemsDone === 0 && assessmentProgressHints[0].itemsTotal === 13
        && assessmentProgressHints[0].progressUnitId === 'company-research-assessment-1'
        && assessmentProgressHints[0].progressUnits === 13
        && typeof assessmentProgressHints[0].progressScopeId === 'string'
        && assessmentProgressHints[0].progressScopeId !== rawProgressHints[0].progressScopeId
        && rejectedRawContracts === invalidRawSections.length
        && batchRawCalls.every(call => call.prompt.includes('BEGIN RESEARCH <researchId>') && !call.prompt.includes('COPY-READY RESEARCH OUTPUT SKELETON'))
        && batchRawCalls.every(call => call.options.displayOnlyPromptSuffix
          && call.ids.every(id => call.options.displayOnlyPromptSuffix.includes(`BEGIN RESEARCH ${id}`)
            && call.options.displayOnlyPromptSuffix.includes(`END RESEARCH ${id}`)))
        && rejectedAssessmentContracts === invalidAssessmentRows.length
        && coverageFailure?.diagnostic?.stage === 'research-assessment'
        && coverageFailure.diagnostic.reason === 'ASSESSMENT_COVERAGE_INVALID'
        && coverageFailure.diagnostic.expectedCount === assessmentIds.length
        && coverageFailure.diagnostic.receivedCount === assessmentIds.length - 1
        && foreignIdentityFailure?.diagnostic?.reason === 'ASSESSMENT_IDENTITY_INVALID'
        && duplicateIdentityFailure?.diagnostic?.reason === 'ASSESSMENT_IDENTITY_INVALID'
        && quoteFailure?.diagnostic?.reason === 'ASSESSMENT_QUOTE_NOT_GROUNDED'
        && urlFailure?.diagnostic?.reason === 'ASSESSMENT_URL_NOT_GROUNDED'
        && assessmentFailures.every(failure => failure
          && Object.values(failure.diagnostic || {}).every(value => typeof value === 'string' || typeof value === 'number'))
        && batchAssessmentCalls[0]?.options?.responseValidator(ungroundedDateBatch) === ungroundedDateBatch
        && repeatedResearchCalls === 0 && cachedRepeat.acceptedJobs.length === 13
        && batched.acceptedJobs.length === 13 && batched.acceptedJobs.every(job => job.preferenceAssessment.matches[0].sourceUrls.length === 1)
        && batchedInvalidDateMatch?.outcome === 'confirmed'
        && batchedInvalidDateMatch.evidenceQuote === `Evidence ${firstBatchIds[0]}: Free lunch is provided.`
        && JSON.stringify(batchedInvalidDateMatch.sourceUrls) === JSON.stringify([`https://example.test/${firstBatchIds[0]}`])
        && batchedInvalidDateMatch.sourceDate === ''
        && singletonUngroundedDateMatch?.outcome === 'confirmed'
        && singletonUngroundedDateMatch.sourceDate === ''
        && JSON.stringify(singletonUngroundedDateMatch.sourceUrls) === JSON.stringify(['https://example.test/singleton-date'])
        && exactDateMatches.every(({ expected, match }) => match?.outcome === 'confirmed'
          && match.evidenceQuote === 'Published free lunch benefit.'
          && match.sourceUrls.length === 1
          && match.sourceDate === expected)
        && tailProvenanceMatch?.outcome === 'confirmed'
        && tailProvenanceMatch.evidenceQuote === tailQuote
        && JSON.stringify(tailProvenanceMatch.sourceUrls) === JSON.stringify([tailUrl])
        && tailProvenanceMatch.sourceDate === tailDate
        && unverifiedProvenanceMatch?.outcome === 'unverified'
        && unverifiedProvenanceMatch.evidence === 'Benefits page was inconclusive.'
        && unverifiedProvenanceMatch.evidenceQuote === ''
        && unverifiedProvenanceMatch.sourceDate === ''
        && unverifiedProvenanceMatch.source === 'web'
        && unverifiedProvenanceMatch.sourceUrls.length === 0
        && unverifiedProvenanceSecond.filteredJobs.length === 1
        && unverifiedProvenanceRawCalls === 2,
      `fresh company research must issue deterministic 12-item batches with isolated evidence, got ${JSON.stringify({ batchRawCalls, batchAssessmentCalls, counts: batched.counts })}`);
      return { blankBypassed: true, strictResearchAttempted: groundedCalls, unsupportedQuoteFailsClosed: true, batchedResearch: batchRawCalls.map(call => call.ids.length) };
    },
  },
  {
    name: 'job preferences: a partial company-research cache hit preserves the stable twelve-employer batch',
    run: async () => {
      const plan = {
        version: 1, summary: '',
        direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false },
        softPreferences: [], strictRequirements: [{ id: 'benefit', criterion: 'Published learning stipend', category: 'perk' }],
        warnings: [], titles: [],
      };
      const jobs = Array.from({ length: 13 }, (_, index) => ({ title: 'Engineer', company: `Partial Cache Company ${index}` }));
      let listingCount = 1;
      const rawBatches = [];
      const assessmentBatches = [];
      const callRaw = async (prompt) => {
        const ids = [...new Set(prompt.match(/research-[a-f0-9]{20}/g) || [])];
        rawBatches.push(ids);
        return ids.map(id => `BEGIN RESEARCH ${id}\nPublished learning stipend. https://example.test/${id}\nEND RESEARCH ${id}`).join('\n');
      };
      const callText = async (prompt, options) => {
        if (options.task === 'job-preference-evaluation') {
          return { assessments: Array.from({ length: listingCount }, (_, index) => ({
            index, matches: [{ preferenceId: 'benefit', outcome: 'unverified', evidence: 'Not listed.' }],
          })) };
        }
        const ids = [...new Set(prompt.match(/research-[a-f0-9]{20}/g) || [])];
        assessmentBatches.push(ids);
        return { assessments: ids.map(id => ({
          researchId: id, preferenceId: 'benefit', outcome: 'confirmed', evidence: 'Benefits page.',
          evidenceQuote: 'Published learning stipend.', sourceUrls: [`https://example.test/${id}`], sourceDate: '',
        })) };
      };
      await evaluateJobPreferences({
        jobs: jobs.slice(0, 1), jobPreferences: 'Published learning stipend', preferencePlan: plan, callRaw, callText,
      });
      const primedId = rawBatches[0]?.[0];
      rawBatches.length = 0;
      assessmentBatches.length = 0;
      listingCount = jobs.length;
      const result = await evaluateJobPreferences({
        jobs, jobPreferences: 'Published learning stipend', preferencePlan: plan, callRaw, callText,
      });
      assert(JSON.stringify(rawBatches.map(ids => ids.length)) === JSON.stringify([12, 1])
        && JSON.stringify(assessmentBatches.map(ids => ids.length)) === JSON.stringify([13])
        && rawBatches[0].includes(primedId)
        && JOB_PREFERENCE_RESEARCH_BATCH_ASSESSMENT_SCHEMA.properties.assessments.maxItems === 27
        && result.acceptedJobs.length === 13,
      'a lone cache hit must reissue its complete stable 12-item partition instead of shifting the other employers or response identities');
      return { batchSizes: rawBatches.map(ids => ids.length), retainedPrimedIdentity: true };
    },
  },
  {
    name: 'job preferences: restored role screens fill a stable ten-prompt wave with fresh screens',
    run: async () => {
      const jobs = Array.from({ length: 3_000 }, (_, index) => ({
        title: `Wave Target ${index}`,
        company: `Wave Company ${index}`,
      }));
      const calls = [];
      const releases = new Map();
      let probeCount = 0;
      let notifyFirstWave;
      const firstWave = new Promise(resolve => { notifyFirstWave = resolve; });
      const run = screenJobRolesByTitle({
        jobs,
        titles: ['Wave Target'],
        // The first original v1 chunk has a durable prompt; every remaining
        // row is fresh v2 work. Their row sets are disjoint, so the exact
        // replay must share the same fixed ten-prompt work set.
        legacyRoleScreenStepProbe: async ({ hints }) => {
          probeCount += 1;
          return hints.itemCount === 200 && probeCount === 1;
        },
        callText: async (_prompt, options) => new Promise(resolve => {
          const call = { task: options.task, resolve, released: false };
          calls.push(call);
          releases.set(call, () => {
            if (call.released) return;
            call.released = true;
            resolve({ verdicts: [] });
          });
          if (calls.length === 10) notifyFirstWave();
        }),
      });
      await firstWave;
      assert(calls.length === 10
        && calls.filter(call => call.task === 'job-role-screen').length === 1
        && calls.filter(call => call.task === 'job-role-screen-batch').length === 9,
      `one restored role screen plus nine fresh screens must fill the first fixed wave, got ${JSON.stringify(calls.map(call => call.task))}`);
      releases.get(calls[0])();
      await new Promise(resolve => setImmediate(resolve));
      assert(calls.length === 10,
        `a solved restored role screen must not be replaced before the first work set settles, got ${calls.length}`);
      calls.slice(1).forEach(call => releases.get(call)());
      for (let attempt = 0; attempt < 100 && calls.length < 11; attempt += 1) await new Promise(resolve => setImmediate(resolve));
      assert(calls.length === 11 && calls[10].task === 'job-role-screen-batch',
        `the next fresh role screen must wait for the whole mixed wave, got ${JSON.stringify(calls.map(call => call.task))}`);
      releases.get(calls[10])();
      const result = await run;
      assert(result.acceptedJobs.length === jobs.length && result.droppedJobs.length === 0,
        'mixed restored/fresh role screens preserve every fail-open listing result');
      return { firstWave: 10, total: calls.length };
    },
  },
  {
    name: 'job preferences: company assessment combines completed raw partitions up to its 27-row ceiling',
    run: async () => {
      const jobs = Array.from({ length: 28 }, (_, index) => ({ title: 'Engineer', company: `Assessment Pack Company ${index}` }));
      const plan = {
        version: 1, summary: '',
        direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false },
        softPreferences: [], strictRequirements: [{ id: 'benefit', criterion: 'Published training budget', category: 'perk' }],
        warnings: [], titles: [],
      };
      const rawBatches = [];
      const rawProgressHints = [];
      const assessmentBatches = [];
      const assessmentProgressHints = [];
      await evaluateJobPreferences({
        jobs,
        jobPreferences: 'Published training budget',
        preferencePlan: plan,
        callRaw: async (prompt, options) => {
          const ids = [...new Set(prompt.match(/research-[a-f0-9]{20}/g) || [])];
          rawBatches.push(ids);
          rawProgressHints.push(options.hints);
          return ids.map(id => `BEGIN RESEARCH ${id}\nPublished training budget. https://example.test/${id}\nEND RESEARCH ${id}`).join('\n');
        },
        callText: async (prompt, options) => {
          if (options.task === 'job-preference-evaluation') {
            return { assessments: Array.from({ length: options.hints.itemCount }, (_, index) => ({
              index, matches: [{ preferenceId: 'benefit', outcome: 'unverified', evidence: 'Not listed.' }],
            })) };
          }
          const ids = [...new Set(prompt.match(/research-[a-f0-9]{20}/g) || [])];
          assessmentBatches.push(ids);
          assessmentProgressHints.push(options.hints);
          return { assessments: ids.map(id => ({
            researchId: id, preferenceId: 'benefit', outcome: 'confirmed', evidence: 'Benefits page.',
            evidenceQuote: 'Published training budget.', sourceUrls: [`https://example.test/${id}`], sourceDate: '',
          })) };
        },
      });
      const rawIds = rawBatches.flat();
      const assessmentIds = assessmentBatches.flat();
      assert(JSON.stringify(rawBatches.map(ids => ids.length)) === JSON.stringify([12, 12, 4])
        && JSON.stringify(assessmentBatches.map(ids => ids.length)) === JSON.stringify([27, 1])
        && JSON.stringify(rawProgressHints.map(hints => hints.itemsDone)) === JSON.stringify([0, 0, 0])
        && rawProgressHints.every(hints => hints.itemsTotal === 28 && hints.progressScopeId === rawProgressHints[0].progressScopeId)
        && JSON.stringify(rawProgressHints.map(hints => hints.progressUnitId)) === JSON.stringify(['company-research-raw-1', 'company-research-raw-2', 'company-research-raw-3'])
        && JSON.stringify(rawProgressHints.map(hints => hints.progressUnits)) === JSON.stringify([12, 12, 4])
        && JSON.stringify(assessmentProgressHints.map(hints => hints.itemsDone)) === JSON.stringify([0, 0])
        && assessmentProgressHints.every(hints => hints.itemsTotal === 28 && hints.progressScopeId === assessmentProgressHints[0].progressScopeId)
        && JSON.stringify(assessmentProgressHints.map(hints => hints.progressUnitId)) === JSON.stringify(['company-research-assessment-1', 'company-research-assessment-2'])
        && JSON.stringify(assessmentProgressHints.map(hints => hints.progressUnits)) === JSON.stringify([27, 1])
        && assessmentProgressHints[0].progressScopeId !== rawProgressHints[0].progressScopeId
        && JSON.stringify(assessmentIds) === JSON.stringify(rawIds),
      `raw partitions must stay at twelve while the dependent verdicts pack in stable order through 27, got ${JSON.stringify({ rawBatches, assessmentBatches })}`);
      return { raw: rawBatches.map(ids => ids.length), assessment: assessmentBatches.map(ids => ids.length) };
    },
  },
  {
    name: 'job preferences: company research keeps ten independent handoffs available',
    run: async () => {
      const jobs = Array.from({ length: 121 }, (_, index) => ({
        title: 'Engineer',
        company: `Ten Wide Research Company ${index}`,
      }));
      const plan = {
        version: 1, summary: '',
        direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false },
        softPreferences: [],
        strictRequirements: [{ id: 'parallel-benefit', criterion: 'Required parallelism benefit', category: 'perk' }],
        warnings: [], titles: [],
      };
      const rawCalls = [];
      let activeRawCalls = 0;
      let peakRawCalls = 0;
      const releaseRawCall = (call) => {
        if (!call || call.released) return;
        call.released = true;
        activeRawCalls -= 1;
        call.resolve(call.ids.map(id => (
          `BEGIN RESEARCH ${id}\nEvidence ${id}: Required parallelism benefit. https://example.test/${id}\nEND RESEARCH ${id}`
        )).join('\n'));
      };
      const run = evaluateJobPreferences({
        jobs,
        jobPreferences: 'Required parallelism benefit',
        preferencePlan: plan,
        callRaw: async prompt => new Promise((resolve) => {
          const ids = [...new Set(prompt.match(/research-[a-f0-9]{20}/g) || [])];
          activeRawCalls += 1;
          peakRawCalls = Math.max(peakRawCalls, activeRawCalls);
          rawCalls.push({ ids, resolve, released: false });
        }),
        callText: async (prompt, options) => {
          if (options.task === 'job-preference-evaluation') {
            return { assessments: Array.from({ length: options.hints.itemCount }, (_, index) => ({
              index, matches: [{ preferenceId: 'parallel-benefit', outcome: 'unverified', evidence: 'Not listed.' }],
            })) };
          }
          const ids = [...new Set(prompt.match(/research-[a-f0-9]{20}/g) || [])];
          return { assessments: ids.map(id => ({
            researchId: id,
            preferenceId: 'parallel-benefit',
            outcome: 'confirmed',
            evidence: 'Benefits page.',
            evidenceQuote: `Evidence ${id}: Required parallelism benefit.`,
            sourceUrls: [`https://example.test/${id}`],
            sourceDate: '',
          })) };
        },
      });

      for (let attempt = 0; attempt < 100 && rawCalls.length < 10; attempt += 1) {
        await new Promise(resolve => setImmediate(resolve));
      }
      assert(rawCalls.length === 10 && activeRawCalls === 10 && peakRawCalls === 10,
        `the first research wave must fill all ten manual handoff slots, got ${JSON.stringify({ issued: rawCalls.length, activeRawCalls, peakRawCalls })}`);

      releaseRawCall(rawCalls[0]);
      for (let attempt = 0; attempt < 100 && rawCalls.length < 11; attempt += 1) {
        await new Promise(resolve => setImmediate(resolve));
      }
      assert(rawCalls.length === 10 && activeRawCalls === 9 && peakRawCalls === 10,
        `a completed prompt must not churn a replacement into the current fixed wave, got ${JSON.stringify({ issued: rawCalls.length, activeRawCalls, peakRawCalls })}`);

      rawCalls.forEach(releaseRawCall);
      for (let attempt = 0; attempt < 100 && rawCalls.length < 11; attempt += 1) {
        await new Promise(resolve => setImmediate(resolve));
      }
      assert(rawCalls.length === 11 && activeRawCalls === 1 && peakRawCalls === 10,
        `the next prompt must begin only after the whole ten-request wave settles, got ${JSON.stringify({ issued: rawCalls.length, activeRawCalls, peakRawCalls })}`);
      releaseRawCall(rawCalls[10]);
      const result = await run;
      assert(result.acceptedJobs.length === jobs.length
        && JSON.stringify(rawCalls.map(call => call.ids.length)) === JSON.stringify([...Array(10).fill(12), 1]),
      `all eleven deterministic research batches must finish in fixed ten-wide waves, got ${JSON.stringify(rawCalls.map(call => call.ids.length))}`);
      return { initialPending: 10, peakPending: peakRawCalls, totalBatches: rawCalls.length };
    },
  },
  {
    name: 'job preferences: restored legacy research fills the first fixed ten-request wave with fresh batches',
    run: async () => {
      const legacyCompanies = ['Restored Legacy Four', 'Restored Legacy Five', 'Restored Legacy Six'];
      const jobs = [
        ...legacyCompanies.map(company => ({ title: 'Engineer', company })),
        ...Array.from({ length: 96 }, (_, index) => ({ title: 'Engineer', company: `Fresh Restart Company ${index}` })),
      ];
      const plan = {
        version: 1, summary: '',
        direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false },
        softPreferences: [], strictRequirements: [{ id: 'restart-benefit', criterion: 'Published restart benefit', category: 'perk' }],
        warnings: [], titles: [],
      };
      const probePrompts = new Map();
      const rawCalls = [];
      const legacyUrl = company => `https://example.test/${company.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      const release = (call) => {
        if (!call || call.released) return;
        call.released = true;
        if (call.options.task === 'job-preference-research') {
          call.resolve(`Legacy evidence: Published restart benefit. ${legacyUrl(call.company)}`);
          return;
        }
        call.resolve(call.ids.map(id => (
          `BEGIN RESEARCH ${id}\nFresh evidence ${id}: Published restart benefit. https://example.test/${id}\nEND RESEARCH ${id}`
        )).join('\n'));
      };
      const run = evaluateJobPreferences({
        jobs,
        jobPreferences: 'Published restart benefit',
        preferencePlan: plan,
        legacyResearchStepProbe: async input => {
          probePrompts.set(input.request.company, input.prompt);
          return legacyCompanies.includes(input.request.company);
        },
        // These simulate the three raw handoffs that were pending at restart;
        // no v1 assessment exists yet, so accepted raw evidence later joins
        // the compact current assessment contract.
        legacyResearchAssessmentStepProbe: async () => false,
        callRaw: async (prompt, options) => new Promise(resolve => {
          const company = legacyCompanies.find(name => prompt.includes(name)) || null;
          const ids = [...new Set(prompt.match(/research-[a-f0-9]{20}/g) || [])];
          rawCalls.push({ prompt, options, company, ids, resolve, released: false });
        }),
        callText: async (prompt, options) => {
          if (options.task === 'job-preference-evaluation') {
            return { assessments: Array.from({ length: options.hints.itemCount }, (_, index) => ({
              index, matches: [{ preferenceId: 'restart-benefit', outcome: 'unverified', evidence: 'Not listed.' }],
            })) };
          }
          const ids = [...new Set(prompt.match(/research-[a-f0-9]{20}/g) || [])];
          return { assessments: ids.map(id => {
            const legacyCompany = legacyCompanies.find(name => prompt.includes(
              `BEGIN RESEARCH ${id}\nLegacy evidence: Published restart benefit. ${legacyUrl(name)}\nEND RESEARCH ${id}`,
            ));
            return {
              researchId: id, preferenceId: 'restart-benefit', outcome: 'confirmed', evidence: 'Benefits page.',
              evidenceQuote: legacyCompany
                ? 'Legacy evidence: Published restart benefit.'
                : `Fresh evidence ${id}: Published restart benefit.`,
              sourceUrls: [legacyCompany ? legacyUrl(legacyCompany) : `https://example.test/${id}`],
              sourceDate: '',
            };
          }) };
        },
      });
      for (let attempt = 0; attempt < 100 && rawCalls.length < 10; attempt += 1) await new Promise(resolve => setImmediate(resolve));
      const firstWave = rawCalls.slice(0, 10);
      const stableLegacyContract = prompt => String(prompt || '').replace(/untrusted-[a-z-]+-[a-f0-9]{8}/g, 'untrusted-legacy-nonce');
      assert(firstWave.length === 10
        && firstWave.filter(call => call.options.task === 'job-preference-research').length === 3
        && firstWave.filter(call => call.options.task === 'job-preference-research-batch').length === 7
        && legacyCompanies.every(company => stableLegacyContract(firstWave.find(call => call.company === company)?.prompt) === stableLegacyContract(probePrompts.get(company))),
      `three exact restored legacy prompts must retain their original contracts while seven fresh batches fill the first wave, got ${JSON.stringify(firstWave.map(call => ({ task: call.options.task, company: call.company, ids: call.ids.length })))} `);
      release(firstWave[0]);
      for (let attempt = 0; attempt < 50; attempt += 1) await new Promise(resolve => setImmediate(resolve));
      assert(rawCalls.length === 10,
        `accepting one restored legacy handoff must not replace it before the first fixed wave settles, got ${rawCalls.length}`);
      firstWave.slice(1).forEach(release);
      for (let attempt = 0; attempt < 100 && rawCalls.length < 11; attempt += 1) await new Promise(resolve => setImmediate(resolve));
      assert(rawCalls.length === 11 && rawCalls[10].options.task === 'job-preference-research-batch',
        `the eighth fresh batch must wait for the three legacy plus seven fresh first wave, got ${JSON.stringify(rawCalls.map(call => call.options.task))}`);
      release(rawCalls[10]);
      const result = await run;
      assert(result.acceptedJobs.length === jobs.length,
        `restored and fresh research must retain all jobs after the mixed fixed waves, got ${result.acceptedJobs.length}`);
      return { restored: 3, firstWaveFresh: 7, nextWave: 1 };
    },
  },
  {
    name: 'job preferences: accepted restart prefix does not consume the pending ten-request wave',
    run: async () => {
      const acceptedLegacyCompanies = Array.from({ length: 6 }, (_, index) => `Accepted Legacy ${index + 1}`);
      const jobs = [
        ...acceptedLegacyCompanies.map(company => ({ title: 'Engineer', company })),
        ...Array.from({ length: 156 }, (_, index) => ({ title: 'Engineer', company: `Accepted Prefix Fresh ${index + 1}` })),
      ];
      const plan = {
        version: 1, summary: '',
        direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false },
        softPreferences: [], strictRequirements: [{ id: 'accepted-prefix', criterion: 'Published accepted-prefix benefit', category: 'perk' }],
        warnings: [], titles: [],
      };
      const statusPrompts = new Map();
      const pendingRawCalls = [];
      const release = call => {
        if (call.released) return;
        call.released = true;
        call.resolve(call.ids.map(id => `BEGIN RESEARCH ${id}\nPending evidence ${id}. https://example.test/${id}\nEND RESEARCH ${id}`).join('\n'));
      };
      const run = evaluateJobPreferences({
        jobs,
        jobPreferences: 'Published accepted-prefix benefit',
        preferencePlan: plan,
        legacyResearchStepProbe: async input => acceptedLegacyCompanies.includes(input.request.company),
        legacyResearchAssessmentStepProbe: async () => false,
        researchStepStatusProbe: async ({ prompt, task, hints }) => {
          const key = `${task}:${hints?.batch || 0}`;
          statusPrompts.set(key, prompt);
          if (task === 'job-preference-research') return 'accepted';
          return hints?.batch <= 3 ? 'accepted' : (hints?.batch <= 6 ? 'pending' : null);
        },
        callRaw: async (prompt, options) => {
          if (options.task === 'job-preference-research') {
            const company = acceptedLegacyCompanies.find(name => prompt.includes(name));
            return `Accepted legacy evidence. https://example.test/${company.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
          }
          const ids = [...new Set(prompt.match(/research-[a-f0-9]{20}/g) || [])];
          if (options.hints.batch <= 3) {
            return ids.map(id => `BEGIN RESEARCH ${id}\nAccepted evidence ${id}. https://example.test/${id}\nEND RESEARCH ${id}`).join('\n');
          }
          return new Promise(resolve => pendingRawCalls.push({ prompt, options, ids, resolve, released: false }));
        },
        callText: async (prompt, options) => {
          if (options.task === 'job-preference-evaluation') return { assessments: Array.from({ length: options.hints.itemCount }, (_, index) => ({
            index, matches: [{ preferenceId: 'accepted-prefix', outcome: 'unverified', evidence: 'Not listed.' }],
          })) };
          const ids = [...new Set(prompt.match(/research-[a-f0-9]{20}/g) || [])];
          return { assessments: ids.map(id => ({ researchId: id, preferenceId: 'accepted-prefix', outcome: 'unverified', evidence: 'Not verified.' })) };
        },
      });
      for (let attempt = 0; attempt < 100 && pendingRawCalls.length < 10; attempt += 1) await new Promise(resolve => setImmediate(resolve));
      const visibleBatches = pendingRawCalls.map(call => call.options.hints.batch);
      const stableContract = prompt => String(prompt || '').replace(/untrusted-[a-z-]+-[a-f0-9]{8}/g, 'untrusted-nonce');
      assert(JSON.stringify(visibleBatches) === JSON.stringify([4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
        && [4, 5, 6].every(batch => stableContract(pendingRawCalls.find(call => call.options.hints.batch === batch)?.prompt)
          === stableContract(statusPrompts.get(`job-preference-research-batch:${batch}`))),
      `six accepted legacy steps and accepted v2 batches 1–3 must leave exact pending 4–6 plus fresh 7–13 as the visible wave, got ${JSON.stringify(visibleBatches)}`);
      pendingRawCalls.forEach(release);
      const result = await run;
      assert(result.candidatePool.length === jobs.length,
        `accepted-prefix replay plus the visible wave must preserve every assessed row, got ${result.candidatePool.length}`);
      return { acceptedLegacy: 6, acceptedPacked: 3, visible: visibleBatches };
    },
  },
  {
    name: 'job preferences: exact legacy research resume does not downgrade fresh sibling employers to singleton prompts',
    run: async () => {
      const jobs = [
        { title: 'Engineer', company: 'Legacy Company' },
        ...Array.from({ length: 13 }, (_, index) => ({ title: 'Engineer', company: `Fresh Hybrid Company ${index}` })),
      ];
      const plan = {
        version: 1, summary: '',
        direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false },
        softPreferences: [], strictRequirements: [{ id: 'benefit', criterion: 'Published training budget', category: 'perk' }],
        warnings: [], titles: [],
      };
      const rawCalls = [];
      const assessmentCalls = [];
      const probeCalls = [];
      const result = await evaluateJobPreferences({
        jobs,
        jobPreferences: 'Published training budget',
        preferencePlan: plan,
        // This true is the outcome of the read-only exact durable-key probe:
        // the legacy raw was accepted and its dependent legacy assessment is
        // pending. No task/metadata-wide switch is available to this seam.
        legacyResearchStepProbe: async input => {
          probeCalls.push(input);
          return input.request.company === 'Legacy Company';
        },
        legacyResearchAssessmentStepProbe: async input => (
          input.request.company === 'Legacy Company'
        ),
        callRaw: async (prompt, options) => {
          rawCalls.push({ prompt, options });
          if (options.task === 'job-preference-research') {
            return 'Legacy proof: Published training budget. https://example.test/legacy';
          }
          const ids = [...new Set(prompt.match(/research-[a-f0-9]{20}/g) || [])];
          return ids.map(id => `BEGIN RESEARCH ${id}\nFresh proof ${id}: Published training budget. https://example.test/${id}\nEND RESEARCH ${id}`).join('\n');
        },
        callText: async (prompt, options) => {
          if (options.task === 'job-preference-evaluation') {
            return { assessments: Array.from({ length: options.hints.itemCount }, (_, index) => ({
              index, matches: [{ preferenceId: 'benefit', outcome: 'unverified', evidence: 'Not listed.' }],
            })) };
          }
          assessmentCalls.push({ prompt, options });
          if (options.task === 'job-preference-research-assessment') {
            return { assessments: [{
              preferenceId: 'benefit', outcome: 'confirmed', evidence: 'Legacy benefits page.',
              evidenceQuote: 'Legacy proof: Published training budget.', sourceUrls: ['https://example.test/legacy'], sourceDate: '',
            }] };
          }
          const ids = [...new Set(prompt.match(/research-[a-f0-9]{20}/g) || [])];
          return { assessments: ids.map(id => ({
            researchId: id, preferenceId: 'benefit', outcome: 'confirmed', evidence: 'Fresh benefits page.',
            evidenceQuote: `Fresh proof ${id}: Published training budget.`, sourceUrls: [`https://example.test/${id}`], sourceDate: '',
          })) };
        },
      });
      const batchedRawSizes = rawCalls
        .filter(call => call.options.task === 'job-preference-research-batch')
        .map(call => [...new Set(call.prompt.match(/research-[a-f0-9]{20}/g) || [])].length);
      const batchedAssessmentSizes = assessmentCalls
        .filter(call => call.options.task === 'job-preference-research-batch-assessment')
        .map(call => [...new Set(call.prompt.match(/research-[a-f0-9]{20}/g) || [])].length);
      assert(probeCalls.length === jobs.length
        && rawCalls.filter(call => call.options.task === 'job-preference-research').length === 1
        && assessmentCalls.filter(call => call.options.task === 'job-preference-research-assessment').length === 1
        && JSON.stringify(batchedRawSizes) === JSON.stringify([12, 1])
        && JSON.stringify(batchedAssessmentSizes) === JSON.stringify([13])
        && result.acceptedJobs.length === jobs.length,
      `an accepted legacy raw plus pending legacy assessment must resume exactly while thirteen untouched siblings still pack, got ${JSON.stringify({ batchedRawSizes, batchedAssessmentSizes, rawTasks: rawCalls.map(call => call.options.task), assessmentTasks: assessmentCalls.map(call => call.options.task) })}`);
      return { legacyRaw: 'accepted', legacyAssessment: 'pending', freshRaw: batchedRawSizes, freshAssessment: batchedAssessmentSizes };
    },
  },
  {
    name: 'job preferences: legacy raw without an exact legacy assessment joins the packed assessment phase',
    run: async () => {
      const jobs = [
        { title: 'Engineer', company: 'Raw Only Legacy Company' },
        ...Array.from({ length: 13 }, (_, index) => ({ title: 'Engineer', company: `Raw Only Fresh Company ${index}` })),
      ];
      const plan = {
        version: 1, summary: '',
        direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false },
        softPreferences: [], strictRequirements: [{ id: 'benefit', criterion: 'Published training budget', category: 'perk' }],
        warnings: [], titles: [],
      };
      const rawTasks = [];
      const assessmentTasks = [];
      await evaluateJobPreferences({
        jobs, jobPreferences: 'Published training budget', preferencePlan: plan,
        legacyResearchStepProbe: async input => input.request.company === 'Raw Only Legacy Company',
        // The exact structured v1 assessment key does not exist. Returning
        // false proves an accepted raw response cannot create a new singleton
        // assessment after the migration.
        legacyResearchAssessmentStepProbe: async () => false,
        callRaw: async (prompt, options) => {
          rawTasks.push(options.task);
          if (options.task === 'job-preference-research') return 'Raw-only proof: Published training budget. https://example.test/raw-only';
          const ids = [...new Set(prompt.match(/research-[a-f0-9]{20}/g) || [])];
          return ids.map(id => `BEGIN RESEARCH ${id}\nFresh proof ${id}: Published training budget. https://example.test/${id}\nEND RESEARCH ${id}`).join('\n');
        },
        callText: async (prompt, options) => {
          if (options.task === 'job-preference-evaluation') return { assessments: Array.from({ length: options.hints.itemCount }, (_, index) => ({
            index, matches: [{ preferenceId: 'benefit', outcome: 'unverified', evidence: 'Not listed.' }],
          })) };
          assessmentTasks.push(options.task);
          const ids = [...new Set(prompt.match(/research-[a-f0-9]{20}/g) || [])];
          const rawOnlyId = prompt.match(/BEGIN RESEARCH (research-[a-f0-9]{20})\nRaw-only proof:/)?.[1] || null;
          return { assessments: ids.map(id => ({
            researchId: id, preferenceId: 'benefit', outcome: 'confirmed', evidence: 'Benefits page.',
            evidenceQuote: id === rawOnlyId ? 'Raw-only proof: Published training budget.' : `Fresh proof ${id}: Published training budget.`,
            sourceUrls: [id === rawOnlyId ? 'https://example.test/raw-only' : `https://example.test/${id}`], sourceDate: '',
          })) };
        },
      });
      assert(rawTasks.filter(task => task === 'job-preference-research').length === 1
        && rawTasks.filter(task => task === 'job-preference-research-batch').length === 2
        && assessmentTasks.filter(task => task === 'job-preference-research-assessment').length === 0
        && assessmentTasks.filter(task => task === 'job-preference-research-batch-assessment').length === 1,
      `a raw-only v1 item must not create a fresh singleton v1 assessment, got ${JSON.stringify({ rawTasks, assessmentTasks })}`);
      return { rawTasks, assessmentTasks };
    },
  },
  {
    name: 'job run staging: Job Preferences survive recovery while model plans are bounded to the durable contract',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-job-preferences-manifest-'));
      const canvasPath = path.join(root, 'workspace.json');
      const preferencePlan = {
        version: 99,
        summary: 'Explore a credible move away from web development.',
        direction: {
          summary: 'Career pivot with broad role exploration.',
          roleDirections: ['Customer success', 'Implementation'],
          avoidDirections: ['Web development'],
          explorationEnabled: true,
          privateModelTrace: 'do not persist',
        },
        softPreferences: [{ id: 'p1', criterion: 'Prefer established companies', category: 'company-size', raw: { unsafe: true } }],
        strictRequirements: [{ id: 'r1', criterion: 'Free lunch must be a listed perk', category: 'benefits', explanation: 'do not persist' }],
        warnings: ['Company-level evidence may need web research.'],
        // targetRoleConflict/targetRoleConflictReason: a Phase-A-era manifest
        // (or a stale in-flight model response) can still carry these retired
        // fields. sanitizeJobPreferencePlan must drop them silently, exactly
        // like it already drops any other unrecognized model payload below —
        // there is no longer a concept for them to represent.
        targetRoleConflict: true,
        targetRoleConflictReason: 'The exact target role conflicts with your request to avoid web development.',
        arbitraryModelPayload: { prompt: 'do not persist' },
      };
      try {
        const run = await startRun(canvasPath, {
          runId: 'preferences-run', startedAt: 100, nodeId: 'hub-1', sourceIds: ['indeed'],
          jobPreferences: '  Help me pivot away from web development. Free lunch is a must.  ',
          jobPreferencePlan: preferencePlan,
        });
        const state = await readRunState(canvasPath, 101);
        const inputs = state?.manifest?.inputs || {};
        assert(run?.runId === 'preferences-run' && inputs.jobPreferences === 'Help me pivot away from web development. Free lunch is a must.',
          `recovery must retain the exact trimmed user preference text, got ${JSON.stringify(inputs)}`);
        assert(inputs.jobPreferencePlan?.version === 1
          && inputs.jobPreferencePlan?.direction?.explorationEnabled === true
          && inputs.jobPreferencePlan?.strictRequirements?.[0]?.criterion === 'Free lunch must be a listed perk'
          && !('targetRoleConflict' in inputs.jobPreferencePlan)
          && !('targetRoleConflictReason' in inputs.jobPreferencePlan)
          && !('arbitraryModelPayload' in inputs.jobPreferencePlan)
          && !('privateModelTrace' in inputs.jobPreferencePlan.direction)
          && !('raw' in inputs.jobPreferencePlan.softPreferences[0]),
        `recovery must preserve the usable plan but strip unrelated/retired model payload (including the retired targetRoleConflict fields), got ${JSON.stringify(inputs.jobPreferencePlan)}`);
        assert(sanitizeJobPreferencePlan({ summary: 7, direction: 'invalid' }) === null,
          'an invalid preference plan must become null so recovery safely re-interprets it');
        // A plan that carries ONLY the retired conflict fields (nothing else
        // meaningful) must now sanitize to null, not survive as "meaningful" —
        // targetRoleConflict was deleted from the `meaningful` predicate
        // alongside the field itself, since Phase B leaves nothing for it to
        // flag a conflict against.
        const conflictOnlyPlan = sanitizeJobPreferencePlan({
          targetRoleConflict: true,
          targetRoleConflictReason: 'Avoid this exact role.',
        });
        assert(conflictOnlyPlan === null,
          'a plan carrying only the retired targetRoleConflict fields must sanitize to null, not be kept as meaningful');
        assert(sanitizeJobPreferences(`  ${'a'.repeat(5000)}  `).length === 4000,
          'manifest persistence must cap bypassed Job Preferences input at the backend-safe length');
        return { strictRequirements: inputs.jobPreferencePlan.strictRequirements.length, recovered: true };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'sanitizeJobPreferencePlan: the resume manifest round-trip preserves titles and never carries the deleted titleSource field',
    run: async () => {
      // FIX 9's own guarantee (see jobRunStaging.js's inline comment on
      // `titles` above): the AI-determined role list must survive a manifest
      // round-trip so a resumed run reproduces generate-job-queries' ladder
      // rung 2 exactly, instead of silently falling through to rung 3's
      // exploratory query generation. SINGLE MODE additionally deleted
      // `titleSource` outright — there is no more "which mode produced these
      // titles" distinction to persist, so a sanitized plan must never carry
      // that key at all, even when a stale in-flight model response (or an
      // old Phase-A-era manifest) still supplies one.
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-job-preferences-titles-roundtrip-'));
      const canvasPath = path.join(root, 'workspace.json');
      try {
        const titlesPlan = {
          version: 1,
          summary: 'Search Product Manager roles.',
          direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false },
          softPreferences: [], strictRequirements: [], warnings: [],
          titles: ['Product Manager', 'Senior Product Manager'],
          // A stale/legacy payload a pre-Phase-B manifest or in-flight model
          // response might still carry — must be silently dropped, exactly
          // like any other unrecognized field this function already strips.
          titleSource: 'brief',
        };
        await startRun(canvasPath, {
          runId: 'titles-roundtrip-run', startedAt: 100, nodeId: 'hub-1', sourceIds: ['indeed'],
          jobPreferences: 'I only want Product Manager roles.',
          jobPreferencePlan: titlesPlan,
        });
        const state = await readRunState(canvasPath, 101);
        const roundTrippedPlan = state?.manifest?.inputs?.jobPreferencePlan;
        assert(JSON.stringify(roundTrippedPlan?.titles) === JSON.stringify(['Product Manager', 'Senior Product Manager']),
          `titles must survive the manifest round-trip verbatim, got ${JSON.stringify(roundTrippedPlan?.titles)}`);
        assert(!('titleSource' in (roundTrippedPlan || {})),
          `a sanitized/round-tripped plan must never carry the deleted titleSource field, got ${JSON.stringify(roundTrippedPlan)}`);

        // Direct unit coverage of sanitizeJobPreferencePlan itself, independent
        // of the manifest plumbing above: a titles-only plan (no
        // summary/direction/preference text at all) must still be treated as
        // meaningful — see FIX 9's `meaningful` comment — and must still drop
        // titleSource.
        const titlesOnly = sanitizeJobPreferencePlan({
          version: 1, summary: '', direction: {}, softPreferences: [], strictRequirements: [], warnings: [],
          titles: ['Data Scientist'], titleSource: 'generated',
        });
        assert(titlesOnly !== null && JSON.stringify(titlesOnly.titles) === JSON.stringify(['Data Scientist']) && !('titleSource' in titlesOnly),
          `a titles-only plan must sanitize as meaningful, keep its titles, and drop titleSource, got ${JSON.stringify(titlesOnly)}`);

        return { titlesRoundTripped: true, titleSourceDropped: true };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'saved-scrape snapshots never normalize a malformed preference plan into a valid empty plan',
    run: () => {
      const rawPreferences = 'I must avoid web development roles.';
      const malformed = {
        version: 1,
        summary: 'Looks meaningful but does not meet the durable contract.',
        direction: { summary: '', roleDirections: ['Avoid web development'], avoidDirections: [], explorationEnabled: false },
        softPreferences: [], strictRequirements: [], warnings: [], titles: [],
      };
      const valid = {
        ...malformed,
        softPreferences: [{ id: 'avoid-web', criterion: 'Avoid web development', category: 'role' }],
      };
      const malformedSnapshot = buildJobAnalysisSnapshot({
        jobs: [], profile: {}, careerData: '', jobPreferences: rawPreferences, jobPreferencePlan: malformed,
      }).snapshot;
      const validSnapshot = buildJobAnalysisSnapshot({
        jobs: [], profile: {}, careerData: '', jobPreferences: rawPreferences, jobPreferencePlan: valid,
      }).snapshot;
      assert(malformedSnapshot.jobPreferences === rawPreferences && malformedSnapshot.jobPreferencePlan === null
        && validSnapshot.jobPreferencePlan?.softPreferences?.[0]?.id === 'avoid-web',
      'saved-scrape recovery must re-interpret raw preferences when its old plan is malformed, but retain a valid plan without data loss');
      return { malformedPlanDiscarded: true, validPlanRetained: true };
    },
  },
  {
    name: 'job preferences: preload and backend expose the interpreter and evaluator contract',
    run: async () => {
      const [preload, jobs] = await Promise.all([
        fs.promises.readFile(path.resolve('electron/preload.js'), 'utf8'),
        fs.promises.readFile(path.resolve('electron/ipc/jobs.js'), 'utf8'),
      ]);
      for (const [rendererMethod, channel] of [
        ['interpretJobPreferences', 'interpret-job-preferences'],
        ['evaluateJobPreferences', 'evaluate-job-preferences'],
      ]) {
        assert(preload.includes(`${rendererMethod}: (args) => ipcRenderer.invoke('${channel}', args)`),
          `preload must expose ${rendererMethod} on its matching IPC channel`);
        assert(jobs.includes(`handleSafe('${channel}'`),
          `jobs backend must register ${channel}`);
      }
      const queryHandlerStart = jobs.indexOf("handleSafe('generate-job-queries'");
      const queryHandlerEnd = jobs.indexOf("handleSafe('get-last-job-analysis-snapshot'", queryHandlerStart);
      const queryHandler = jobs.slice(queryHandlerStart, queryHandlerEnd);
      const renderer = await fs.promises.readFile(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8');
      assert(queryHandler.includes('{ profile, careerData, targetRole')
        && queryHandler.includes('jobPreferences, profile, careerData, targetRole: role')
        && renderer.includes('careerData: activeCareerData,'),
      'the raw-preferences query IPC fallback receives the same career context as the normal interpreter, while passing only the resulting role direction to query generation');
      return { interpreter: true, evaluator: true, queryFallbackCareerContext: true };
    },
  },
  {
    name: 'job preferences: a Search-Brief-resolved title list drives query construction ahead of the generation fallback, and all-filtered completion is described as preferences',
    run: async () => {
      const [search, done] = await Promise.all([
        fs.promises.readFile(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8'),
        fs.promises.readFile(path.resolve('src/nodes/jobsearch/JobSearchDoneState.jsx'), 'utf8'),
      ]);
      const pipelineStart = search.indexOf('// Step 2: Query construction');
      const pipelineEnd = search.indexOf('// Step 3: Search', pipelineStart);
      const pipeline = search.slice(pipelineStart, pipelineEnd);
      // Phase B deleted targetRoleConflict outright: with the standalone
      // Target role box gone, two boxes can no longer contradict each other,
      // so the old "stop the pipeline before queries" guard has nothing left
      // to guard. Assert the retired concept and its user-facing copy stay
      // gone, rather than re-testing a throw that no longer exists.
      assert(!pipeline.includes('targetRoleConflict') && !search.includes('Your Target role conflicts with your Job Preferences'),
        'the retired target-role-conflict guard and its copy must not reappear in query construction');
      // Its replacement guarantee: a brief-resolved title-query bundle is
      // built locally (buildPinnedTitleQueryBundle) and that branch is tried
      // BEFORE falling through to the exploratory generateJobQueries call, so
      // a brief that already named titles never pays for a second model call.
      // SINGLE MODE collapsed the old query/gate split (deriveQueryTitles +
      // deriveGatePinnedTitles) into one deriveSearchTitles — there is no more
      // deterministic post-search gate for a "generated" plan's titles to be
      // exempted from, so the same activeSearchTitles list feeds both query
      // construction here and (via `pinnedTitles` in node data) display.
      const pinnedBranchAt = pipeline.indexOf('activeSearchTitles.length > 0');
      const generateAt = pipeline.indexOf('window.electronAPI.generateJobQueries');
      assert(pinnedBranchAt >= 0 && generateAt >= 0 && pinnedBranchAt < generateAt
        && pipeline.includes('buildPinnedTitleQueryBundle(activeSearchTitles)'),
      'a Search-Brief-resolved title list must be tried before the exploratory query-generation fallback');
      assert(done.includes("resultDisposition === 'preference-filtered'")
        && done.includes("${jobsLabel(count, 'job')} matched your preferences")
        && done.includes('Match details')
        && done.includes("jobsLabel(filteredPreferenceCount, 'job')} filtered"),
      'an all-filtered terminal state must explain that Job Preferences filtered the results, not imply a zero-result scrape');
      const resumeStart = search.indexOf('const handleResumeRun = useCallback');
      const resumeEnd = search.indexOf('resumeInterruptedRunRef.current = handleResumeRun;', resumeStart);
      const resume = search.slice(resumeStart, resumeEnd);
      assert(resume.includes("typeof offer.jobPreferences === 'string' ? offer.jobPreferences : ''")
        && resume.includes('offer.jobPreferencePlan ?? offer.preferencePlan ?? null')
        && !resume.includes('data.activeJobPreferences ?? data.jobPreferences')
        && resume.includes('Failed to restore Job Preferences for this resumed search')
        // The deterministic post-search title gate (and deriveGatePinnedTitles,
        // its gate-only title deriver) is deleted outright — resume no longer
        // needs to recompute a pinned-title gate list at all, so this crash-
        // resume path must NOT reference it.
        && !resume.includes('deriveGatePinnedTitles')
        && !resume.includes('targetRoleConflict'),
      'crash resume must use the manifest’s frozen preferences, safely re-interpret durable raw text only when its saved plan is unavailable, and never reintroduce the retired conflict guard or gate-title deriver');
      return { conflictGuardRemoved: true, pinnedTitlesPrecedeGeneration: true, allFilteredCopy: true, resumePreferencesFrozen: true };
    },
  },
  {
    name: 'resolveSearchRoles (ROLE LOCKING two-pass): the coverage/compliance audit ALWAYS runs for a non-empty brief, and is SKIPPED only for a genuinely empty one',
    run: async () => {
      // Pass-1 raw wire shape a manual-AI response must satisfy — see
      // hasValidRawPlanShape / JOB_PREFERENCE_PLAN_SCHEMA. Kept minimal (empty
      // direction/preferences) since only `titles` matters here. SINGLE MODE
      // deleted titleSource entirely — there is no longer a "the user already
      // wrote these verbatim, skip the audit" branch to distinguish; the
      // audit's cost/skip now turns on the brief text alone (empty or not),
      // never on where the draft's titles came from.
      const rawPlan = (titles) => ({
        version: 1, summary: 'Draft interpretation.',
        direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false },
        softPreferences: [], strictRequirements: [], warnings: [], titles,
      });
      const rawAudit = (titles) => ({
        titles, added: [], addedReason: '', removed: [], removedReason: '',
        rationale: 'Draft already fully satisfies coverage and compliance.',
      });

      // Case A: the brief names NO titles at all, so pass 1 invents them from
      // career data. This is exactly the case a coverage/compliance audit
      // always existed for — it MUST spend the audit handoff.
      const inventedCalls = [];
      const inventedResult = await resolveSearchRoles({
        jobPreferences: 'Help me find something in engineering leadership.',
        profile: {}, careerData: '',
        callText: async (_prompt, options) => {
          inventedCalls.push(options.task);
          if (options.task === 'job-preference-interpretation') return rawPlan(['Engineering Manager']);
          if (options.task === 'job-role-audit') return rawAudit(['Engineering Manager']);
          throw new Error(`unexpected task ${options.task}`);
        },
      });
      assert(JSON.stringify(inventedCalls) === JSON.stringify(['job-preference-interpretation', 'job-role-audit']),
        `a draft with no user-named titles must spend exactly one interpretation call and one audit call, in that order, got ${JSON.stringify(inventedCalls)}`);
      assert(inventedResult.plan.titles.length === 1 && inventedResult.plan.titles[0] === 'Engineering Manager'
        && inventedResult.roleAudit !== null,
        'a fully-invented draft locks the audited titles and returns the raw audit as diagnostic evidence');

      // Case B (THE INVERSION): the brief itself NAMES a title verbatim
      // ("Product Manager roles"). The old two-mode design skipped pass 2
      // here entirely (titleSource='brief' short-circuit). SINGLE MODE runs
      // it regardless — the model's OWN additions around a user-named title
      // can still miss a role family or violate a stated exclusion, so
      // coverage/compliance are worth auditing even when the draft also
      // carried the user's own words forward verbatim.
      const namedCalls = [];
      const namedBriefText = 'I only want Product Manager roles.';
      const namedResult = await resolveSearchRoles({
        jobPreferences: namedBriefText,
        profile: {}, careerData: '',
        callText: async (_prompt, options) => {
          namedCalls.push(options.task);
          if (options.task === 'job-preference-interpretation') return rawPlan(['Product Manager']);
          if (options.task === 'job-role-audit') return rawAudit(['Product Manager']);
          throw new Error(`unexpected task ${options.task}`);
        },
      });
      assert(JSON.stringify(namedCalls) === JSON.stringify(['job-preference-interpretation', 'job-role-audit']),
        `a draft carrying a user-named title must STILL spend the audit handoff — SINGLE MODE has no titleSource='brief' skip anymore — got ${JSON.stringify(namedCalls)}`);
      assert(namedResult.plan.titles.length === 1 && namedResult.plan.titles[0] === 'Product Manager'
        && namedResult.roleAudit !== null,
        "a user-named-title draft's plan is still the audited final list, with roleAudit populated (never null) for any non-empty brief");

      // Case C: a genuinely EMPTY brief is the ONLY path that skips pass 2 —
      // interpretJobPreferences' own aiSkipped short-circuit means there is no
      // brief text to audit a draft against, so resolveSearchRoles must spend
      // ZERO calls total, not merely skip the second one.
      const emptyCalls = [];
      const emptyResult = await resolveSearchRoles({
        jobPreferences: '   ',
        profile: {}, careerData: '',
        callText: async (_prompt, options) => {
          emptyCalls.push(options.task);
          throw new Error(`resolveSearchRoles must not call the AI at all for a genuinely empty brief, got task '${options.task}'`);
        },
      });
      assert(emptyCalls.length === 0, `a genuinely empty brief must spend zero AI calls, got ${JSON.stringify(emptyCalls)}`);
      assert(emptyResult.plan.titles.length === 0 && emptyResult.roleAudit === null,
        'a genuinely empty brief resolves to zero titles with roleAudit null, since pass 2 never ran');

      return { inventedCallCount: inventedCalls.length, namedCallCount: namedCalls.length, emptyCallCount: emptyCalls.length };
    },
  },
  {
    name: 'resolveSearchRoles: pass-2 COMPLIANCE removal drops an excluded draft title from the locked plan, and COVERAGE addition survives into it too',
    run: async () => {
      const rawPlan = (titles) => ({
        version: 1, summary: '', direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false },
        softPreferences: [], strictRequirements: [], warnings: [], titles,
      });
      const result = await resolveSearchRoles({
        jobPreferences: 'Find me engineering leadership roles, but nothing at the staff, principal, or manager level.',
        profile: {}, careerData: '',
        callText: async (_prompt, options) => {
          if (options.task === 'job-preference-interpretation') {
            // Pass 1's own draft violates the brief's own exclusion — exactly
            // the failure mode pass 2's COMPLIANCE check exists to catch.
            return rawPlan(['Staff Engineer', 'Software Engineer']);
          }
          if (options.task === 'job-role-audit') {
            return {
              titles: ['Software Engineer', 'Senior Software Engineer'],
              added: ['Senior Software Engineer'],
              addedReason: 'The brief implies senior individual-contributor roles beyond the entry-level draft.',
              removed: ['Staff Engineer'],
              removedReason: 'The brief explicitly excludes the staff level.',
              rationale: 'Added a missing seniority tier and removed an excluded level.',
            };
          }
          throw new Error(`unexpected task ${options.task}`);
        },
      });
      assert(!result.plan.titles.includes('Staff Engineer'),
        `a draft title violating an explicit brief exclusion must not survive into the locked plan, got ${JSON.stringify(result.plan.titles)}`);
      assert(result.plan.titles.includes('Senior Software Engineer'),
        'a coverage addition must also survive into the locked plan');
      assert(result.roleAudit.removed.includes('Staff Engineer') && result.roleAudit.removedReason.includes('staff')
        && result.roleAudit.added.includes('Senior Software Engineer'),
        'the raw audit evidence (added/removed + reasons) must be preserved verbatim as persisted diagnostic evidence');
      return { removed: result.roleAudit.removed, added: result.roleAudit.added, finalTitles: result.plan.titles };
    },
  },
  {
    name: 'llm task registration: job-role-audit (pass-2 role audit) is a KNOWN_TASKS member with its own positive TASK_MAX_TOKENS ceiling',
    run: () => {
      // An unregistered task silently falls back to the 'default' cap — see
      // resolveTask's warning in llm.js. The one-time, most-important-work-in-
      // the-module role audit must never silently truncate on that fallback.
      assert(getKnownTaskIds().has('job-role-audit'), "'job-role-audit' must be registered in llm.js KNOWN_TASKS");
      const cap = taskMaxTokensFor('job-role-audit');
      assert(Number.isFinite(cap) && cap > 0, `taskMaxTokensFor('job-role-audit') must resolve a positive finite ceiling, got ${cap}`);
      return { registered: true, cap };
    },
  },
  {
    name: 'llm task registration: legacy and packed title-only role screens have item-scaled ceilings',
    run: () => {
      // Before this fix, 'job-role-screen' was missing from both KNOWN_TASKS
      // and TASK_MAX_TOKENS in llm.js, so resolveTask() silently fell through
      // to 'default' (a flat 2048 max_tokens) -- see resolveTask's own
      // warning. The legacy screen batches 200 rows, while the versioned screen
      // fills the shared usable ceiling with 298 rows
      // into ONE handoff (screenJobRolesByTitle, jobPreferences.js), and this
      // transport has no cap-raise retry: a flat 2048 cap truncates the paste
      // on any batch beyond a handful of rows, turning the whole screen into
      // a failed handoff the user has to notice and redo by hand.
      assert(getKnownTaskIds().has('job-role-screen') && getKnownTaskIds().has('job-role-screen-batch'),
        'both legacy and packed role-screen task ids must be registered');
      const bigBatchCap = taskMaxTokensFor('job-role-screen', { itemCount: 200 });
      const smallBatchCap = taskMaxTokensFor('job-role-screen', { itemCount: 10 });
      assert(Number.isFinite(bigBatchCap) && bigBatchCap > 2048 * 2,
        `taskMaxTokensFor('job-role-screen', {itemCount:200}) must sit far above the flat 'default' cap this task used to silently fall back to, got ${bigBatchCap}`);
      assert(bigBatchCap > smallBatchCap,
        `the ceiling must SCALE with itemCount, not stay flat -- a 200-row batch must resolve a materially larger budget than a 10-row batch, got 200-row=${bigBatchCap} vs 10-row=${smallBatchCap}`);
      const packedCap = taskMaxTokensFor('job-role-screen-batch', { itemCount: 298 });
      assert(packedCap === 15328 && packedCap <= 15360,
        `the 298-row packed screen must nearly fill but never exceed 15,360 tokens, got ${packedCap}`);
      return { registered: true, bigBatchCap, smallBatchCap, packedCap };
    },
  },
  {
    name: 'ROLE LOCKING: a re-scan with data.resolvedRoles already populated reuses the lock and never calls resolveSearchRoles; the search title list is derived from the (locked) plan',
    run: async () => {
      const search = await fs.promises.readFile(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8');
      const lockStart = search.indexOf('let jobPreferencesInterpretation = laneTurnData.searchBriefPlan ?? null;');
      const lockEnd = search.indexOf('const activePreferredLocation = locationToLegacyText', lockStart);
      assert(lockStart >= 0 && lockEnd > lockStart, 'the ROLE LOCKING resolution block must exist between the freeze and location resolution');
      const lockBlock = search.slice(lockStart, lockEnd);
      // REUSE: laneTurnData.resolvedRoles is no longer the lock-existence
      // check on its own (FIX2 — see hasResolvedRoleLock's WHY comment: a
      // legitimate zero-title resolution must still count as locked, which
      // `resolvedRoles.length > 0` cannot express). hasLockedRoles is now
      // keyed on hasResolvedRoleLock(laneTurnData) (resolvedRolesMeta
      // presence) — a populated lock still means the `if` below never
      // executes, so this run still spends zero interpretation calls.
      const hasLockedAt = lockBlock.indexOf('const hasLockedRoles = hasResolvedRoleLock(laneTurnData);');
      const guardAt = lockBlock.indexOf('if (!hasLockedRoles && activeJobPreferences && window.electronAPI?.resolveSearchRoles) {');
      const callAt = lockBlock.indexOf('window.electronAPI.resolveSearchRoles({');
      assert(hasLockedAt >= 0 && guardAt > hasLockedAt && callAt > guardAt,
        'resolveSearchRoles must be called only inside a block explicitly guarded on an empty/absent lock (hasResolvedRoleLock)');
      // The lock and its titles are written together, atomically, from the
      // SAME resolved plan — so reusing searchBriefPlan.titles on a later run
      // is guaranteed to equal what was persisted into resolvedRoles when the
      // lock was first established (the two fields can never diverge).
      assert(lockBlock.includes('resolvedRoles: lockedTitles,') && lockBlock.includes('searchBriefPlan: jobPreferencesInterpretation,'),
        'the freshly-established lock must persist resolvedRoles and searchBriefPlan from the same resolved plan in one atomic patch');
      // PER-RUN title list: SINGLE MODE collapsed the old query/gate split
      // (deriveQueryTitles + deriveGatePinnedTitles, the latter titleSource-
      // aware) into one deriveSearchTitles, since there is no more
      // deterministic post-search gate for a query list to diverge from. It
      // is derived from jobPreferencesInterpretation — which, on a reused
      // lock, IS laneTurnData.searchBriefPlan (see the `let` above) — never
      // from a fresh interpretation.
      assert(lockBlock.includes('const activeSearchTitles = deriveSearchTitles(activeTargetRole, jobPreferencesInterpretation);'),
        'activeSearchTitles must be derived from jobPreferencesInterpretation, which is the locked searchBriefPlan on a reused-lock run');
      const deriveStart = search.indexOf('function deriveSearchTitles(targetRole, preferencePlan) {');
      const deriveEnd = search.indexOf('\n}', deriveStart);
      const deriveBody = search.slice(deriveStart, deriveEnd);
      assert(deriveBody.includes('Array.isArray(preferencePlan?.titles)') && deriveBody.includes('preferencePlan.titles.filter'),
        'deriveSearchTitles must read its titles from preferencePlan.titles — i.e. the locked plan — not any other source');
      // A legacy targetRole (unmigrated canvas only) still wins outright,
      // reproducing the old single-role search exactly — there is no more
      // titleSource-aware branch gating this on the plan's origin.
      assert(deriveBody.includes("if (role) return [role];"),
        'deriveSearchTitles must let a legacy targetRole win outright over the locked plan’s titles');
      // The deleted deterministic gate functions must not have resurfaced —
      // this is the core of what this round of fixes replaced with the AI
      // role screen (screenJobRolesByTitle, main process).
      assert(!search.includes('function deriveQueryTitles(') && !search.includes('function deriveGatePinnedTitles('),
        'deriveQueryTitles/deriveGatePinnedTitles must stay deleted — deriveSearchTitles is their single replacement');
      return { guarded: true, searchTitlesFromLockedPlan: true };
    },
  },
  {
    name: 'ROLE LOCKING: clearing career data (Clear career files, or a career-data-wiping Reset) clears searchBriefPlan/resolvedRoles/resolvedRolesMeta; a profile-retaining Reset leaves the lock untouched',
    run: async () => {
      const search = await fs.promises.readFile(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8');
      // Clear career files: the canonical unlock. Must ship the lock-clearing
      // fields in the SAME updateGlobal patch as the rest of the career wipe.
      const clearStart = search.indexOf('const handleClearCareerFiles = useCallback((e) => {');
      const clearEnd = search.indexOf('\n  }, [', clearStart);
      assert(clearStart >= 0 && clearEnd > clearStart, 'handleClearCareerFiles must exist');
      const clearBody = search.slice(clearStart, clearEnd);
      assert(clearBody.includes('searchBriefPlan: null, resolvedRoles: null, resolvedRolesMeta: null,'),
        'Clear career files must null out the full lock triple (searchBriefPlan/resolvedRoles/resolvedRolesMeta)');
      // Reset: only a career-data-wiping reset unlocks. A reset that retains a
      // reusable profile (a mere mid-run Cancel) must leave the lock alone —
      // roleLockClearPatch resolves to {} in that branch, never the null triple.
      const resetStart = search.indexOf('const resetHasReusableCareerProfile = !!(');
      const resetEnd = search.indexOf('updateGlobal(id, {', resetStart);
      assert(resetStart >= 0 && resetEnd > resetStart, 'the reset handler’s career-retention branch must exist');
      const resetBody = search.slice(resetStart, resetEnd);
      assert(resetBody.includes('const roleLockClearPatch = resetHasReusableCareerProfile')
        && resetBody.includes('? {}')
        && resetBody.includes(': { searchBriefPlan: null, resolvedRoles: null, resolvedRolesMeta: null };'),
        'a career-data-wiping Reset must clear the same lock triple as Clear career files; a profile-retaining Reset must leave it as an empty patch');
      assert(search.includes('...retainedCareerData,\n      ...resetSearchHistoryPatch,\n      ...roleLockClearPatch,'),
        'roleLockClearPatch must actually be spread into the reset’s updateGlobal patch, not merely computed and discarded');
      return { clearCareerUnlocks: true, profileRetainingResetPreservesLock: true };
    },
  },
  {
    name: 'SETTINGS LOCKING FREEZE: every user-configurable setting (brief, location, remote residences, depth, platforms) is read-only/disabled once resolvedRoles is populated, in both JobSearchNode.jsx (empty state) and JobSearchDoneState.jsx (done state)',
    run: async () => {
      const [search, done] = await Promise.all([
        fs.promises.readFile(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8'),
        fs.promises.readFile(path.resolve('src/nodes/jobsearch/JobSearchDoneState.jsx'), 'utf8'),
      ]);
      // Empty state: settingsFrozen is derived from data (not a prop) via
      // hasResolvedRoleLock — FIX2: keyed on resolvedRolesMeta rather than
      // `resolvedRoles.length > 0`, since a legitimate zero-title resolution
      // must still freeze settings (see hasResolvedRoleLock's WHY comment) —
      // and freezes every setting permanently, alongside — but distinct
      // from — the transient controlsLocked busy-state.
      assert(search.includes("const resolvedRoles = Array.isArray(data.resolvedRoles) ? data.resolvedRoles : [];")
        && search.includes('const settingsFrozen = hasResolvedRoleLock(data);')
        && search.includes('disabled={controlsLocked || settingsFrozen}'),
      'JobSearchNode.jsx must derive settingsFrozen from hasResolvedRoleLock(data) and disable the Search Brief textarea once it is populated');
      // Every other empty-state setting must also freeze, not just the brief:
      // location/remote-residence fields, jobs/pages depth, and platform
      // selection all take the same disabled prop.
      assert(search.includes('disabled={controlsLocked || settingsFrozen}\n                />')
        && search.includes('setCollectionLimits={setCollectionLimits}\n                    disabled={settingsFrozen}')
        && search.includes('searchLocation={searchLocation}\n                    disabled={settingsFrozen}'),
      'JobSearchNode.jsx must disable location, collection-limits, and platform-selection controls once settingsFrozen, not only the Search Brief');
      // Done state: resolvedRoles AND resolvedRolesMeta arrive as PROPS (this
      // component does not read node data directly) and gate every setting in
      // this render too. FIX2 (mirrored from JobSearchNode.jsx's own
      // hasResolvedRoleLock): settingsFrozen is keyed on resolvedRolesMeta
      // presence, not `resolvedRoles.length > 0` — a legitimate zero-title
      // resolution must still freeze settings here too.
      assert(done.includes('resolvedRoles = [],')
        && done.includes('resolvedRolesMeta = null,')
        && done.includes('const settingsFrozen = !!(resolvedRolesMeta && typeof resolvedRolesMeta === \'object\');')
        && done.includes('disabled={settingsFrozen}'),
      'JobSearchDoneState.jsx must accept resolvedRoles/resolvedRolesMeta as props and disable its own settings once resolvedRolesMeta is populated');
      // The done state is the one most likely to tempt a pre-re-run tweak, so
      // every non-brief setting must carry the same freeze there too.
      assert(done.includes('remoteResidences={remoteResidences}\n            setRemoteResidence={setRemoteResidence}\n            compact\n            disabled={settingsFrozen}')
        && done.includes('setCollectionLimits={setCollectionLimits}\n            disabled={settingsFrozen}')
        && done.includes('searchLocation={searchLocation}\n            disabled={settingsFrozen}'),
      'JobSearchDoneState.jsx must disable location, collection-limits, and platform-selection controls once settingsFrozen, not only the Search Brief');
      // The empty-state component must actually be the one supplying both
      // props — otherwise the done-state freeze could silently read undefined
      // forever regardless of what got locked. resolvedRolesMeta is the real
      // sentinel, so its wiring matters at least as much as resolvedRoles'.
      assert(search.includes('resolvedRoles={resolvedRoles}')
        && search.includes('resolvedRolesMeta={data.resolvedRolesMeta || null}'),
      'JobSearchNode.jsx must pass its own resolvedRoles and data.resolvedRolesMeta through to JobSearchDoneState');
      return { emptyStateFrozen: true, doneStateFrozen: true, propWired: true };
    },
  },
  {
    name: 'Job Preferences UI: labels, locked controls, live status, and singular counts stay clear',
    run: async () => {
      const [search, done, processing, locations, errorBanner] = await Promise.all([
        fs.promises.readFile(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8'),
        fs.promises.readFile(path.resolve('src/nodes/jobsearch/JobSearchDoneState.jsx'), 'utf8'),
        fs.promises.readFile(path.resolve('src/nodes/jobsearch/JobSearchProcessingState.jsx'), 'utf8'),
        fs.promises.readFile(path.resolve('src/components/JobSearchLocationFields.jsx'), 'utf8'),
        fs.promises.readFile(path.resolve('src/components/HubErrorBanner.jsx'), 'utf8'),
      ]);
      assert(search.includes('Search Brief <span className="text-white/25">(optional)</span>')
        && search.includes('AI turns this brief into roles and fit criteria.')
        && search.includes('aria-describedby={jobPreferencesHelpId}')
        && search.includes('maxLength={4000}')
        && search.includes('const cleanupRetirementPending = hasPendingManualAiRetirement(data);')
        && search.includes('const baseControlsLocked = !!data.locked || !!data.queuedModuleRun || cleanupRetirementPending;')
        && search.includes('const controlsLocked = baseControlsLocked || staleManualAiRecoveryAdmissionLocked;')
        && search.includes('const errorControlsLocked = !!data.locked || !!data.queuedModuleRun || staleManualAiRecoveryAdmissionLocked;')
        && search.includes('disabled={controlsLocked}')
        // Location controls carry the PERMANENT settingsFrozen freeze in
        // addition to the transient controlsLocked busy-state (see
        // the SETTINGS LOCKING FREEZE test above for the full inventory).
        && search.includes('disabled={controlsLocked || settingsFrozen}\n                />')
        && search.includes('locked={errorControlsLocked}'),
      'the merged empty-state Search Brief control must be named, explain what AI derives from it, describe its help, and disable every editable setting while locked, queued, finishing cancellation cleanup, or awaiting a stale manual-AI recovery decision without hiding the cleanup retry action');
      assert(locations.includes('disabled = false')
        && locations.includes('disabled={disabled}'),
      'structured location inputs must honor the parent locked state rather than remaining editable');
      assert(done.includes('const jobsLabel =')
        && done.includes("jobsLabel(count, 'job')")
        && done.includes("jobsLabel(count, 'new job', 'new jobs')")
        && done.includes('ready to score')
        && done.includes('aria-describedby={preferencesHelpId}')
        && done.includes('maxLength={4000}')
        && done.includes('const [setupOpen, setSetupOpen] = useState(() => !settingsFrozen);')
        && done.includes("Search setup{settingsFrozen ? ' · locked' : ''}")
        && done.includes('open={setupOpen}')
        && done.includes('Describe roles, priorities, and deal-breakers.'),
      'completed result labels must pluralize every job count and retain a labeled, 4,000-character Search Brief inside an initially closed locked setup disclosure with concise locked/unlocked guidance');

      // A zero-title role resolution is still a real frozen plan. Both draft
      // and completed views must therefore use an explicit fallback rather
      // than printing the dangling label `Locked roles:` with no value.
      assert(search.includes("resolvedRoles.length > 0\n                        ? `Locked roles: ${resolvedRoles.join(', ')}`\n                        : 'No specific roles were saved, so searches are not narrowed to a role list.'")
        && done.includes("resolvedRoles.length > 0\n                  ? `Locked roles: ${resolvedRoles.join(', ')}`\n                  : 'No specific roles were saved, so searches are not narrowed to a role list.'")
        && !search.includes('Locked roles: {resolvedRoles.join')
        && !done.includes('Locked roles: {resolvedRoles.join'),
      'a locked zero-role plan must show its explicit fallback in draft and completed Search setup, never a dangling Locked roles label');

      const normalProcessingStart = processing.indexOf('<div className="group flex flex-col items-center justify-center');
      const normalProcessing = processing.slice(normalProcessingStart);
      const normalAtomicLiveRegions = normalProcessing.match(/role="status" aria-live="polite" aria-atomic="true"/g) || [];
      const primaryLiveStart = normalProcessing.indexOf('<p className="text-white/60 text-xs font-medium" role="status" aria-live="polite" aria-atomic="true">');
      const primaryLiveEnd = normalProcessing.indexOf('</p>', primaryLiveStart);
      assert(processing.includes('aria-label="Copy the Chrome launch command"')
        // Chrome setup and ordinary processing are mutually exclusive render
        // branches. In ordinary processing, only the compact phase/source
        // label is live; high-frequency detail/count/scoring/resume copy is
        // visibly present but deliberately outside that atomic announcement.
        && normalAtomicLiveRegions.length === 1
        && primaryLiveStart >= 0 && primaryLiveEnd > primaryLiveStart
        && normalProcessing.slice(primaryLiveStart, primaryLiveEnd).includes('{primaryStatus}')
        && normalProcessing.slice(primaryLiveEnd).includes('{hubState === \'searching\' && activeSourceDetail && (')
        && normalProcessing.slice(primaryLiveEnd).includes('{collectedStatus && <p')
        && normalProcessing.slice(primaryLiveEnd).includes('{scoringStatus && <p')
        && normalProcessing.slice(primaryLiveEnd).includes('{resumeSummary && (')
        && !normalProcessing.slice(primaryLiveEnd).includes('role="status"')
        && processing.includes('aria-label="Stop job search and keep saved progress for Resume when available"')
        && processing.includes('onStop,')
        && processing.includes('onClick={onStop}')
        && !processing.includes('Cancel and reset job search')
        && !processing.includes('onClick={handleCopy}\n          title="Click to copy"'),
      'processing controls must be keyboard-operable and communicate the compact phase/source through one atomic live region without making detail, counts, scoring, or résumé text live');
      // NAMING LOCK (inverted for Phase B): the merged box's visible name is
      // now Search Brief, not Job Preferences — assert the actual label
      // markup in BOTH input components reads "Search Brief" and that
      // neither the old "Target role" label nor the old "Job Preferences"
      // label survives. Scoped to the literal label markup (not a blanket
      // scan of the whole file) because "Job Preferences" legitimately
      // remains elsewhere as the feature/concept name — in hub-state status
      // copy, EventLogger lines, and error messages — none of which this
      // task renamed; only the box's own label changed.
      const searchBriefLabel = '<span>Search Brief <span className="text-white/25">(optional)</span></span>';
      const targetRoleLabel = '<span>Target role <span className="text-white/25">(optional)</span></span>';
      const jobPreferencesLabel = '<span>Job Preferences <span className="text-white/25">(optional)</span></span>';
      assert(errorBanner.includes('role="alert"') && errorBanner.includes('aria-label="Dismiss error"')
        && search.includes(searchBriefLabel) && done.includes(searchBriefLabel)
        && !search.includes(targetRoleLabel) && !done.includes(targetRoleLabel)
        && !search.includes(jobPreferencesLabel) && !done.includes(jobPreferencesLabel),
      'errors must announce themselves, and the merged input box must be visibly named Search Brief in both input components, with neither the old Target role label nor the old Job Preferences label surviving');
      return { labels: true, locked: true, counts: true, status: true };
    },
  },
  {
    // Per-control, not blanket: the SETTINGS LOCKING FREEZE test above already
    // asserts every control with combined `&&` expressions, but a combined
    // assertion still passes if the STRING for one control silently drops
    // out as long as the others remain — the boolean result of `a && b && c`
    // only tells you SOMETHING failed, not which `disabled` prop went
    // missing. This test asserts each of the 6 inventoried settings with its
    // OWN assert() call (one control missing its freeze fails exactly one
    // assertion, identifying itself by message) across both render states.
    // Settings 2/3 (location + remote residences) and 4/5 (jobs/platform +
    // pages/search) share ONE component instance each — that component
    // takes a single `disabled` prop, so one assertion legitimately covers
    // two inventory settings; this is the component's own shape, not a test
    // shortcut, and the comment on each assertion says so explicitly.
    name: 'SETTINGS FREEZE per-control: each of the 6 inventoried settings is individually asserted disabled under settingsFrozen, in both JobSearchNode.jsx and JobSearchDoneState.jsx',
    run: async () => {
      const [search, done] = await Promise.all([
        fs.promises.readFile(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8'),
        fs.promises.readFile(path.resolve('src/nodes/jobsearch/JobSearchDoneState.jsx'), 'utf8'),
      ]);

      // JobSearchNode.jsx (empty/draft render) — settingsFrozen combines with
      // the transient controlsLocked on every control this component itself
      // renders (JobCollectionLimitsControl/JobPlatformSelectionControl are
      // hidden outright, not merely disabled, while controlsLocked — see the
      // `!controlsLocked &&` guards below — so their own disabled prop only
      // ever needs settingsFrozen).
      assert(search.includes('placeholder="E.g. Senior Product Manager roles — or: help me pivot away from web development; large established companies only."\n                    aria-describedby={jobPreferencesHelpId}'
        + '\n                    // settingsFrozen is PERMANENT (roles locked on the first run,\n                    // taking every setting below with them) — distinct from\n                    // controlsLocked\'s transient "busy right now". Reusing the\n                    // same disabled styling here is deliberate: it reads as\n                    // intentionally locked, not merely temporarily busy.\n                    disabled={controlsLocked || settingsFrozen}'),
      '[setting 1/6 — Search Brief] JobSearchNode.jsx textarea must disable on controlsLocked || settingsFrozen');
      assert(search.includes('remoteResidences={remoteResidences}\n                  setRemoteResidence={setRemoteResidence}\n                  disabled={controlsLocked || settingsFrozen}'),
      '[settings 2+3/6 — Search location + Remote salary residences, one <JobSearchLocationFields> instance] JobSearchNode.jsx must disable it on controlsLocked || settingsFrozen');
      assert(search.includes('setCollectionLimits={setCollectionLimits}\n                    disabled={settingsFrozen}'),
      '[settings 4+5/6 — Jobs/platform + Browser pages/search, one <JobCollectionLimitsControl> instance] JobSearchNode.jsx must disable it on settingsFrozen');
      assert(search.includes('searchLocation={searchLocation}\n                    disabled={settingsFrozen}\n                  />\n                )}'),
      '[setting 6/6 — Job platforms] JobSearchNode.jsx <JobPlatformSelectionControl> must disable on settingsFrozen');

      // JobSearchDoneState.jsx (the re-run screen) — locked/busy is handled
      // by hiding this whole settings block (`{!locked && (...)}`); within
      // it, settingsFrozen alone gates every control, since a queued/busy
      // hub never reaches this render at all.
      assert(done.includes('// a locked brief reads as intentional rather than a stray bug.\n              disabled={settingsFrozen}'),
      '[setting 1/6 — Search Brief] JobSearchDoneState.jsx textarea must disable on settingsFrozen');
      assert(done.includes('remoteResidences={remoteResidences}\n            setRemoteResidence={setRemoteResidence}\n            compact\n            disabled={settingsFrozen}'),
      '[settings 2+3/6 — Search location + Remote salary residences, one <JobSearchLocationFields> instance] JobSearchDoneState.jsx must disable it on settingsFrozen');
      assert(done.includes('setCollectionLimits={setCollectionLimits}\n            disabled={settingsFrozen}'),
      '[settings 4+5/6 — Jobs/platform + Browser pages/search, one <JobCollectionLimitsControl> instance] JobSearchDoneState.jsx must disable it on settingsFrozen');
      const donePlatformControlStart = done.indexOf('<JobPlatformSelectionControl');
      const donePlatformControlEnd = done.indexOf('/>', donePlatformControlStart);
      assert(donePlatformControlStart >= 0
        && donePlatformControlEnd > donePlatformControlStart
        && done.slice(donePlatformControlStart, donePlatformControlEnd).includes('disabled={settingsFrozen}'),
      '[setting 6/6 — Job platforms] JobSearchDoneState.jsx <JobPlatformSelectionControl> must disable on settingsFrozen');

      return { perControlAsserted: 8 };
    },
  },
  {
    // The freeze must be PERMANENT (survives a queued run finishing, a hub
    // unlocking, cleanup completing) until a full reset — so settingsFrozen
    // must never be folded into controlsLocked/errorControlsLocked, whose
    // whole purpose is to clear on their own. Asserting the exact
    // right-hand-side EXPRESSION text (not just that both names appear
    // somewhere in the file) catches a future refactor like
    // `const settingsFrozen = hasResolvedRoleLock(data) || controlsLocked;`
    // or `const controlsLocked = ... || settingsFrozen;`, either of which
    // would silently let a transient unlock reopen permanently-frozen
    // settings, or permanently lock the transient controls.
    name: 'SETTINGS FREEZE remains separate from transient locks: settingsFrozen derives only from hasResolvedRoleLock(data), while controls add only durable recovery admission',
    run: async () => {
      const [search, done] = await Promise.all([
        fs.promises.readFile(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8'),
        fs.promises.readFile(path.resolve('src/nodes/jobsearch/JobSearchDoneState.jsx'), 'utf8'),
      ]);
      // JobSearchNode.jsx: the three lock/freeze definitions, verbatim. None
      // of the three right-hand sides mentions either of the other two names.
      assert(search.includes('const baseControlsLocked = !!data.locked || !!data.queuedModuleRun || cleanupRetirementPending;')
        && search.includes('const controlsLocked = baseControlsLocked || staleManualAiRecoveryAdmissionLocked;'),
      'controlsLocked must compose only the ordinary transient lock with the deliberate stale-manual-recovery admission lock — never settingsFrozen or resolvedRoles');
      assert(search.includes('const errorControlsLocked = !!data.locked || !!data.queuedModuleRun || staleManualAiRecoveryAdmissionLocked;'),
      'errorControlsLocked must add only the deliberate stale-manual-recovery admission lock — never settingsFrozen, resolvedRoles, or cleanupRetirementPending');
      // FIX2: settingsFrozen is keyed on hasResolvedRoleLock(data) — i.e.
      // resolvedRolesMeta presence — not `resolvedRoles.length > 0` (which
      // cannot distinguish "never locked" from "locked with zero titles").
      assert(search.includes('const settingsFrozen = hasResolvedRoleLock(data);'),
      'settingsFrozen must derive only from hasResolvedRoleLock(data) — not controlsLocked, errorControlsLocked, data.locked, or data.queuedModuleRun');
      // JobSearchDoneState.jsx receives `locked` as an independent prop
      // (the caller's controlsLocked, renamed at the boundary) and computes
      // settingsFrozen from its OWN resolvedRolesMeta prop, never from
      // `locked` — mirroring JobSearchNode.jsx's own hasResolvedRoleLock
      // sentinel rather than `resolvedRoles.length > 0`.
      assert(done.includes('const settingsFrozen = !!(resolvedRolesMeta && typeof resolvedRolesMeta === \'object\');'),
      'JobSearchDoneState.jsx settingsFrozen must derive only from its resolvedRolesMeta prop — not the locked prop or resolvedRoles.length');
      return { separateExpressions: true };
    },
  },
  {
    // The three actions that stay reachable through a permanently-frozen hub
    // (re-run with the same locked settings, re-evaluate saved jobs against
    // the same locked brief, or clear career data) must never themselves be
    // disabled by
    // settingsFrozen — only the SETTINGS should freeze, not the ability to
    // act on them or escape the freeze. Each assertion below is scoped to that
    // one button's own JSX so
    // a stray `disabled={settingsFrozen}` landing on the wrong button is
    // still caught even though the surrounding file also legitimately
    // contains that exact substring elsewhere (on the settings it SHOULD
    // gate).
    name: 'SETTINGS FREEZE ACTIONS STAY LIVE: Re-run / Re-evaluate / Clear career data are never disabled by settingsFrozen, in either render state',
    run: async () => {
      const [search, done] = await Promise.all([
        fs.promises.readFile(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8'),
        fs.promises.readFile(path.resolve('src/nodes/jobsearch/JobSearchDoneState.jsx'), 'utf8'),
      ]);
      // Extracts exactly one <button>...</button> element by finding a
      // unique anchor string inside it (verified unique in the source file)
      // and taking everything from there to the next `</button>` close tag —
      // robust to incidental reformatting, unlike a fixed character offset.
      const button = (source, anchor) => {
        const anchorIdx = source.indexOf(anchor);
        assert(anchorIdx !== -1, `anchor not found in source: ${anchor}`);
        const openIdx = source.lastIndexOf('<button', anchorIdx);
        const closeIdx = source.indexOf('</button>', anchorIdx);
        assert(openIdx !== -1 && closeIdx !== -1, `could not bound a <button>...</button> element around anchor: ${anchor}`);
        return source.slice(openIdx, closeIdx + '</button>'.length);
      };

      // JobSearchDoneState.jsx (the re-run screen — the one that matters
      // most, since this is where a user would actually try to re-run).
      const doneReanalyzeButton = button(done, 'onClick={onReanalyze}');
      assert(!doneReanalyzeButton.includes('disabled'),
      'JobSearchDoneState.jsx Re-evaluate Saved Jobs button must carry no disabled prop at all (settingsFrozen or otherwise)');
      const doneRerunButton = button(done, 'onClick={onRerun}');
      assert(doneRerunButton.includes('disabled={platformsVerifying}') && !doneRerunButton.includes('settingsFrozen'),
      'JobSearchDoneState.jsx Re-run Search button must disable only on platformsVerifying, never on settingsFrozen');
      const doneClearButton = button(done, 'onClick={onClearCareerFiles}');
      assert(!doneClearButton.includes('disabled'),
      'JobSearchDoneState.jsx Clear career data button must carry no disabled prop at all (settingsFrozen or otherwise)');

      // JobSearchNode.jsx (career files retained, pre-first-run empty state)
      // — these two actions are gated on VISIBILITY (`!controlsLocked &&`
      // wrapping the whole <button>), never on a `disabled` prop, so the
      // relevant assertion is on the enclosing conditional, not the button
      // element itself; the button() helper above still proves no `disabled`
      // prop of any kind was added to the element.
      const searchRerunButton = button(search, 'handleRerun(); }}');
      assert(!searchRerunButton.includes('disabled'),
      'JobSearchNode.jsx Re-run Search button must carry no disabled prop at all (settingsFrozen or otherwise) — it is gated purely by conditional rendering');
      assert(search.includes('{hasRunnableCareerInput && !controlsLocked && !boardRecoveryOwnsActions && !resumeOffer?.incomplete && (\n                    <button'),
      'JobSearchNode.jsx Re-run Search button must be gated on !controlsLocked and the absence of an incomplete checkpoint (not settingsFrozen) via conditional rendering, not a disabled prop');
      const searchClearButton = button(search, 'handleClearCareerFiles(e)');
      assert(!searchClearButton.includes('disabled'),
      'JobSearchNode.jsx Clear career data button must carry no disabled prop at all (settingsFrozen or otherwise) — it is gated purely by conditional rendering');
      assert(search.includes('{!controlsLocked && !activeBoardRecoveryOwnerKey && (\n                    <button'),
      'JobSearchNode.jsx Clear career data button must be gated on !controlsLocked (not settingsFrozen) via conditional rendering, not a disabled prop');

      return { actionsStayLive: true };
    },
  },
  {
    name: 'job run staging: pre-Job-Preferences manifests resume with neutral preference defaults',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-job-preferences-legacy-'));
      const canvasPath = path.join(root, 'workspace.json');
      const manifestPath = path.join(root, 'workspace.jobs-run.json');
      try {
        await fs.promises.writeFile(manifestPath, JSON.stringify({
          version: 1,
          runId: 'legacy-run',
          startedAt: 1,
          lastUpdated: 2,
          stage: 'searching',
          inputs: { nodeId: 'hub-1', queries: ['product manager'], canonicalLocation: 'Toronto' },
          sources: { indeed: { status: 'pending', queries: {} } },
        }), { encoding: 'utf8', mode: 0o600 });
        const state = await readRunState(canvasPath, 3);
        assert(state?.manifest?.inputs?.jobPreferences === '' && state.manifest.inputs.jobPreferencePlan === null,
          `old manifests must receive neutral preference defaults, got ${JSON.stringify(state?.manifest?.inputs)}`);
        return { legacyVersion: state.manifest.version, defaultsApplied: true };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'job run staging: hubs on one canvas retain independent, fenced recovery ledgers',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-job-staging-hub-conflict-'));
      const canvasPath = path.join(root, 'workspace.json');
      try {
        const first = await startRun(canvasPath, { runId: 'hub-a-run', startedAt: 1, nodeId: 'hub-a', sourceIds: ['indeed'] });
        const [b, c] = await Promise.all([
          startRun(canvasPath, { runId: 'hub-b-run', startedAt: 2, nodeId: 'hub-b', sourceIds: ['dice'] }),
          startRun(canvasPath, { runId: 'hub-c-run', startedAt: 3, nodeId: 'hub-c', sourceIds: ['remoteok'] }),
        ]);
        await Promise.all([
          recordSourcePage(canvasPath, { nodeId: 'hub-a', expectedRunId: 'hub-a-run', sourceId: 'indeed', jobs: [{ title: 'A' }], now: 4 }),
          recordSourcePage(canvasPath, { nodeId: 'hub-b', expectedRunId: 'hub-b-run', sourceId: 'dice', jobs: [{ title: 'B' }], now: 4 }),
          recordSourcePage(canvasPath, { nodeId: 'hub-c', expectedRunId: 'hub-c-run', sourceId: 'remoteok', jobs: [{ title: 'C' }], now: 4 }),
        ]);
        const [aState, bState, cState] = await Promise.all([
          readRunState(canvasPath, 5, { nodeId: 'hub-a' }),
          readRunState(canvasPath, 5, { nodeId: 'hub-b' }),
          readRunState(canvasPath, 5, { nodeId: 'hub-c' }),
        ]);
        const staleWrite = await recordSourcePage(canvasPath, {
          nodeId: 'hub-a', expectedRunId: 'obsolete-a-run', sourceId: 'indeed', jobs: [{ title: 'stale' }], now: 6,
        });
        const replacement = await startRun(canvasPath, { runId: 'hub-a-rerun', startedAt: 7, nodeId: 'hub-a', sourceIds: ['indeed'] });
        const afterRerun = await readRunState(canvasPath, 8, { nodeId: 'hub-a' });
        const bAfterAReplaced = await readRunState(canvasPath, 8, { nodeId: 'hub-b' });
        assert(first?.runId === 'hub-a-run' && b?.runId === 'hub-b-run' && c?.runId === 'hub-c-run'
          && aState?.stagedJobs?.[0]?.job?.title === 'A'
          && bState?.stagedJobs?.[0]?.job?.title === 'B'
          && cState?.stagedJobs?.[0]?.job?.title === 'C'
          && staleWrite === false
          && replacement?.conflict === true
          && replacement?.ownerNodeId === 'hub-a'
          && replacement?.ownerRunId === 'hub-a-run'
          && afterRerun?.manifest?.runId === 'hub-a-run'
          && afterRerun?.stagedJobs?.[0]?.job?.title === 'A'
          && bAfterAReplaced?.manifest?.runId === 'hub-b-run' && bAfterAReplaced.stagedJobs?.[0]?.job?.title === 'B',
        'each hub must have isolated jobs + manifest files, while a same-hub fresh start cannot overwrite its staged recovery ledger');

        const deliberatelyCleared = await clearRun(canvasPath, {
          expectedRunId: 'hub-a-run',
          expectedNodeId: 'hub-a',
        });
        const afterExplicitClear = await startRun(canvasPath, {
          runId: 'hub-a-rerun', startedAt: 9, nodeId: 'hub-a', sourceIds: ['indeed'],
        });
        const afterExplicitRerun = await readRunState(canvasPath, 10, { nodeId: 'hub-a' });
        assert(deliberatelyCleared === true
          && afterExplicitClear?.runId === 'hub-a-rerun'
          && afterExplicitRerun?.stagedJobs?.length === 0,
        'only an explicit token- and owner-bound discard may clear a same-hub checkpoint before a fresh start');
        return { simultaneous: 3, sameHubRerunFenced: true, explicitDiscardRequired: true };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'job run staging: an unknown-owner legacy manifest is preserved until deliberately discarded',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-job-staging-unknown-owner-'));
      const canvasPath = path.join(root, 'workspace.json');
      try {
        await fs.promises.writeFile(path.join(root, 'workspace.jobs-run.json'), JSON.stringify({
          version: 1, runId: 'legacy-run', startedAt: 1, lastUpdated: 2,
          stage: 'searching', inputs: {}, sources: { indeed: { status: 'pending', queries: {} } },
        }), 'utf8');
        await fs.promises.writeFile(path.join(root, 'workspace.jobs-staging.jsonl'), `${JSON.stringify({ sourceId: 'indeed', job: { title: 'Recover me' } })}\n`, 'utf8');
        const attempted = await startRun(canvasPath, { runId: 'new-hub-run', startedAt: 3, nodeId: 'new-hub', sourceIds: ['google'] });
        const state = await readRunState(canvasPath, 4);
        const rows = await readStagedJobs(canvasPath);
        assert(attempted?.conflict === true && attempted.ownerUnknown === true && attempted.ownerNodeId === null
          && state?.manifest?.runId === 'legacy-run' && rows.length === 1,
        'a tokened hub cannot overwrite a parseable legacy manifest whose owner is unknown; its staged rows remain available for the explicit Clear career data action');
        const deliberateLegacyClear = await clearRun(canvasPath, {
          expectedRunId: 'legacy-run', expectedOwnerUnknown: true,
        });
        const next = await startRun(canvasPath, { runId: 'new-hub-run', startedAt: 5, nodeId: 'new-hub', sourceIds: ['google'] });
        assert(deliberateLegacyClear === true && next?.runId === 'new-hub-run',
          'the explicit owner-unknown discard is token-bound and clears only a manifest that still has no hub owner, restoring the explicit Clear career data path');
        return { runId: state.manifest.runId, rows: rows.length, legacyCleared: deliberateLegacyClear };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'job run staging: an owned legacy recovery never reads a modern sibling hub staging file',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-job-staging-legacy-owned-'));
      const canvasPath = path.join(root, 'workspace.json');
      try {
        await fs.promises.writeFile(path.join(root, 'workspace.jobs-run.json'), JSON.stringify({
          version: 1, runId: 'legacy-a', startedAt: 1, lastUpdated: 2,
          stage: 'searching', inputs: { nodeId: 'hub-a' }, sources: { indeed: { status: 'pending', queries: {} } },
        }), 'utf8');
        await fs.promises.writeFile(path.join(root, 'workspace.jobs-staging.jsonl'), `${JSON.stringify({ sourceId: 'indeed', job: { title: 'Legacy A' } })}\n`, 'utf8');
        await startRun(canvasPath, { runId: 'modern-b', startedAt: 3, nodeId: 'hub-b', sourceIds: ['dice'] });
        await recordSourcePage(canvasPath, {
          nodeId: 'hub-b', expectedRunId: 'modern-b', sourceId: 'dice', jobs: [{ title: 'Modern B' }], now: 4,
        });
        const recovered = await readRunState(canvasPath, 5, { nodeId: 'hub-a' });
        assert(recovered?.manifest?.runId === 'legacy-a'
          && recovered.stagedJobs?.length === 1
          && recovered.stagedJobs[0]?.job?.title === 'Legacy A',
        `an owned legacy hub must read its own selected sidecar, not a sibling's modern ledger, got ${JSON.stringify(recovered)}`);
        return { runId: recovered.manifest.runId, stagedTitle: recovered.stagedJobs[0].job.title };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'job run staging: a failed fresh start preserves the prior recoverable JSONL',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-job-staging-rollback-'));
      const canvasPath = path.join(root, 'workspace.json');
      const stagingPath = path.join(root, 'workspace.jobs-staging.jsonl');
      const manifestPath = path.join(root, 'workspace.jobs-run.json');
      const priorRow = { sourceId: 'indeed', query: 'platform engineer', page: 1, job: { title: 'Recover me' } };
      try {
        await fs.promises.writeFile(stagingPath, `${JSON.stringify(priorRow)}\n`, { encoding: 'utf8', mode: 0o600 });
        // A directory at the manifest path makes its final atomic rename fail
        // after startRun has prepared its fresh staging file.
        await fs.promises.mkdir(manifestPath);
        const result = await startRun(canvasPath, { runId: 'replacement', startedAt: 1, sourceIds: ['indeed'] });
        const recovered = await readStagedJobs(canvasPath);
        assert(result === null, `a failed manifest replacement must fail the start, got ${JSON.stringify(result)}`);
        assert(recovered.length === 1 && recovered[0].job?.title === 'Recover me',
          `a failed fresh start must restore prior staged jobs, got ${JSON.stringify(recovered)}`);
        return { restoredRows: recovered.length };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'job run staging rejects non-parser profile fingerprints at the durable manifest boundary',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-profile-fingerprint-schema-'));
      const canvasPath = path.join(root, 'workspace.json');
      try {
        await startRun(canvasPath, {
          runId: 'fingerprint-schema-run',
          startedAt: 1,
          nodeId: 'fingerprint-schema-hub',
          sourceIds: ['indeed'],
          profileFingerprint: 'not-a-parser-fingerprint',
        });
        const state = await readRunState(canvasPath, 2, { nodeId: 'fingerprint-schema-hub' });
        const valid = 'a'.repeat(64);
        assert(state?.manifest?.inputs?.profileFingerprint === null
          && normalizeJobRunProfileFingerprint(valid) === valid
          && normalizeJobRunProfileFingerprint(valid.toUpperCase()) === null
          && normalizeJobRunProfileFingerprint('x'.repeat(4096)) === null,
        `the manifest must retain only lowercase SHA-256 profile fingerprints, got ${JSON.stringify(state?.manifest?.inputs?.profileFingerprint)}`);
        return { durableBoundaryStrict: true };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'career input fingerprints bind the ordered basename and content sequence',
    run() {
      const original = careerInputFingerprint([
        { name: 'resume.pdf', contentHash: 'a'.repeat(64) },
        { name: 'portfolio.pdf', contentHash: 'b'.repeat(64) },
      ]);
      const reordered = careerInputFingerprint([
        { name: 'portfolio.pdf', contentHash: 'b'.repeat(64) },
        { name: 'resume.pdf', contentHash: 'a'.repeat(64) },
      ]);
      const renamed = careerInputFingerprint([
        { name: 'resume-renamed.pdf', contentHash: 'a'.repeat(64) },
        { name: 'portfolio.pdf', contentHash: 'b'.repeat(64) },
      ]);
      const profileV1 = careerProfileFingerprint({ name: 'Ada', skills: ['JavaScript'] }, '===== FILE: resume.pdf =====\nAda');
      const profileV2 = careerProfileFingerprint({ name: 'Ada', skills: ['TypeScript'] }, '===== FILE: resume.pdf =====\nAda');
      const corpusV2 = careerProfileFingerprint({ name: 'Ada', skills: ['JavaScript'] }, '===== FILE: resume.pdf =====\nAda Lovelace');
      const savedSnapshot = buildJobAnalysisSnapshot({
        jobs: [],
        profile: { name: 'Ada', skills: ['JavaScript'] },
        careerData: '===== FILE: resume.pdf =====\nAda',
      }).snapshot;
      assert(/^[a-f0-9]{64}$/.test(original)
        && original !== reordered
        && original !== renamed
        && /^[a-f0-9]{64}$/.test(profileV1)
        && profileV1 !== profileV2
        && profileV1 !== corpusV2
        && savedSnapshot.profileFingerprint === careerProfileFingerprint(savedSnapshot.profile, savedSnapshot.careerData),
      'career recovery identity must change when parser input, parsed profile, or corpus changes, including saved-scrape snapshots');
      return { canonicalHash: true, reorderedRejected: true, renamedRejected: true, outputPairBound: true, snapshotBound: true };
    },
  },
  {
    name: 'job run staging: exact-token recovery fails closed when its manifest is gone or terminal',
    run: async () => {
      const missing = validateExactResumeRun(null, 'run-observed-by-renderer');
      const terminal = validateExactResumeRun({
        incomplete: false,
        manifest: { runId: 'run-observed-by-renderer' },
      }, 'run-observed-by-renderer');
      const malformed = validateExactResumeRun({
        incomplete: true,
        manifest: {},
      }, 'run-observed-by-renderer');
      const mismatch = validateExactResumeRun({
        incomplete: true,
        manifest: { runId: 'replacement-run' },
      }, 'run-observed-by-renderer');
      const exact = validateExactResumeRun({
        incomplete: true,
        manifest: { runId: 'run-observed-by-renderer', inputs: { profileFingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } },
      }, 'run-observed-by-renderer', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      const missingProfile = validateExactResumeRun({
        incomplete: true,
        manifest: { runId: 'run-observed-by-renderer', inputs: {} },
      }, 'run-observed-by-renderer', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      const mismatchedProfile = validateExactResumeRun({
        incomplete: true,
        manifest: { runId: 'run-observed-by-renderer', inputs: { profileFingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } },
      }, 'run-observed-by-renderer', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
      const legacy = validateExactResumeRun(null, null);
      assert(missing?.resumeRunMissing === true
        && terminal?.resumeRunMissing === true
        && malformed?.resumeRunMissing === true
        && mismatch?.resumeRunMismatch === true
        && exact === null
        && missingProfile?.resumeProfileMissing === true
        && mismatchedProfile?.resumeProfileMismatch === true
        && legacy === null,
      `an exact recovery token must also bind the persisted profile fingerprint, while tokenless legacy resume retains its compatibility path: ${JSON.stringify({ missing, terminal, malformed, mismatch, exact, missingProfile, mismatchedProfile, legacy })}`);

      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-exact-resume-missing-'));
      const canvasPath = path.join(root, 'workspace.json');
      try {
        registerJobsHandlers();
        const searchJobs = ipcMain.__getInvokeHandler('search-jobs');
        const sender = {
          id: 66_001,
          isDestroyed: () => false,
          once: () => {},
          on: () => {},
          removeListener: () => {},
          send: () => {},
        };
        const result = await searchJobs({ sender }, {
          nodeId: 'exact-resume-hub',
          canvasFilePath: canvasPath,
          queries: ['platform engineer'],
          resume: true,
          resumeRunId: 'run-observed-by-renderer',
          profileFingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        });
        const after = await readRunState(canvasPath, Date.now(), { nodeId: 'exact-resume-hub' });
        assert(result.success === false && result.resumeRunMissing === true && after == null,
          `a missing exact token must not invoke the fresh start path or create a replacement manifest, got ${JSON.stringify({ result, after })}`);
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }

      const mismatchRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-exact-resume-profile-'));
      const mismatchCanvasPath = path.join(mismatchRoot, 'workspace.json');
      try {
        await startRun(mismatchCanvasPath, {
          runId: 'profile-bound-run',
          startedAt: Date.now(),
          nodeId: 'exact-resume-hub',
          queries: ['platform engineer'],
          profileFingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          canonicalLocation: '',
          sourceIds: ['indeed'],
        });
        const searchJobs = ipcMain.__getInvokeHandler('search-jobs');
        const sender = {
          id: 66_003,
          isDestroyed: () => false,
          once: () => {},
          on: () => {},
          removeListener: () => {},
          send: () => {},
        };
        const result = await searchJobs({ sender }, {
          nodeId: 'exact-resume-hub',
          canvasFilePath: mismatchCanvasPath,
          queries: ['platform engineer'],
          resume: true,
          resumeRunId: 'profile-bound-run',
          profileFingerprint: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        });
        const after = await readRunState(mismatchCanvasPath, Date.now(), { nodeId: 'exact-resume-hub' });
        assert(result.success === false && result.resumeProfileMismatch === true
          && after?.manifest?.runId === 'profile-bound-run',
        `a profile-mismatched exact token must fail before dispatch and preserve its staged manifest, got ${JSON.stringify({ result, after })}`);
      } finally {
        await fs.promises.rm(mismatchRoot, { recursive: true, force: true });
      }

      const jobsSource = await fs.promises.readFile(path.resolve('electron/ipc/jobs.js'), 'utf8');
      const handlerStart = jobsSource.indexOf("handleSafe('search-jobs'");
      const priorReadAt = jobsSource.indexOf("readRunState(canvasFilePath, Date.now(), { nodeId })", handlerStart);
      const exactGuardAt = jobsSource.indexOf('const exactResumeFailure = validateExactResumeRun(prior, resumeRunId, normalizedProfileFingerprint);', priorReadAt);
      const exactReturnAt = jobsSource.indexOf('return { success: false, ...exactResumeFailure };', exactGuardAt);
      const freshSourceDerivationAt = jobsSource.indexOf('activeSourceIds = resumeSourceIds || getRunnableJobSourceIds(', exactReturnAt);
      const freshStartAt = jobsSource.indexOf('await startJobRun(canvasFilePath, {', handlerStart);
      const providerDispatchAt = jobsSource.indexOf('fetchHttpSources(', handlerStart);
      assert(handlerStart >= 0
        && priorReadAt > handlerStart
        && exactGuardAt > priorReadAt
        && exactReturnAt > exactGuardAt
        && freshSourceDerivationAt > exactReturnAt
        && freshStartAt > exactReturnAt
        && providerDispatchAt > exactReturnAt,
      'search-jobs must return an explicit-token recovery failure before it derives fresh source breadth, allocates a fresh manifest, or dispatches any provider work');
      return { missingFailsClosed: true, replacementFailsClosed: true, profileMismatchFailsClosed: true, noFreshManifest: true, legacyFallbackRetained: true };
    },
  },
  {
    name: 'job run staging: exact-token recovery stops at a replaced searching-stage checkpoint before provider dispatch',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-exact-resume-stage-race-'));
      const canvasPath = path.join(root, 'workspace.json');
      const nodeId = 'exact-stage-race-hub';
      const runId = 'observed-exact-run';
      const replacementRunId = 'replacement-after-peek';
      const sender = {
        id: 66_002,
        isDestroyed: () => false,
        once: () => {},
        on: () => {},
        removeListener: () => {},
        send: () => {},
      };
      const originalReadFile = fs.promises.readFile;
      let manifestPath = null;
      let manifestReads = 0;
      let replacedAtStageBoundary = false;
      try {
        await startRun(canvasPath, {
          runId,
          startedAt: 1,
          queries: ['platform engineer'],
          profileFingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          canonicalLocation: '',
          nodeId,
          sourceIds: ['remoteok'],
        });
        manifestPath = path.join(root, (await fs.promises.readdir(root)).find(name => (
          /^workspace\.jobs-run\..+\.json$/.test(name)
        )));
        assert(manifestPath && await fs.promises.stat(manifestPath).then(stat => stat.isFile()),
          'test setup must locate the owned recovery manifest');

        // `readRunState` consumes read #1. `setStage` first locates the owned
        // sidecar (read #2), then reads it again under its manifest mutex. Swap
        // the file between those two reads to model another run winning after
        // the renderer/IPC peek but before the stage compare-and-set.
        fs.promises.readFile = async (...args) => {
          const value = await originalReadFile(...args);
          if (String(args[0]) === manifestPath) {
            manifestReads += 1;
            if (manifestReads === 2) {
              const replacement = JSON.parse(String(value));
              replacement.runId = replacementRunId;
              await fs.promises.writeFile(manifestPath, JSON.stringify(replacement), 'utf8');
              replacedAtStageBoundary = true;
            }
          }
          return value;
        };

        __resetJobsTelemetryForTests();
        registerJobsHandlers();
        const searchJobs = ipcMain.__getInvokeHandler('search-jobs');
        const result = await searchJobs({ sender }, {
          nodeId,
          canvasFilePath: canvasPath,
          queries: ['platform engineer'],
          resume: true,
          resumeRunId: runId,
          profileFingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        });
        const after = await readRunState(canvasPath, Date.now(), { nodeId });
        const remoteDispatches = getJobsTelemetry()?.sourceRunHistory?.remoteok || [];
        assert(replacedAtStageBoundary
          && result.success === false
          && result.resumeRunMismatch === true
          && after?.manifest?.runId === replacementRunId
          && remoteDispatches.every(entry => entry.dispatchedAt == null),
        `a replacement at the searching-stage CAS must return exact-token mismatch before provider dispatch or fresh replacement, got ${JSON.stringify({ replacedAtStageBoundary, result, after: after?.manifest?.runId, remoteDispatches })}`);
        return { stageFence: true, providerDispatches: 0, replacementPreserved: true };
      } finally {
        fs.promises.readFile = originalReadFile;
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'job run staging: saved-canvas start failure fails closed before source collection',
    run: async () => {
      const jobsSource = await fs.promises.readFile(path.resolve('electron/ipc/jobs.js'), 'utf8');
      assert(
        jobsSource.includes('if (canvasFilePath && !startedRun)')
          && jobsSource.includes('No job sources were queried and existing results were left unchanged.')
          && jobsSource.includes('restoreJobsTelemetryIfCurrentRun(nodeId, activeRunId, priorJobsTelemetry);'),
        'search-jobs must reject a failed saved-canvas staging start before source collection can proceed',
      );
      return { failClosed: true };
    },
  },
  {
    name: 'job run staging: durable terminal receipt survives cleanup and redacts payloads',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-job-run-receipt-'));
      const canvasPath = path.join(root, 'workspace.json');
      try {
        const run = await startRun(canvasPath, { runId: 'receipt-run', startedAt: 100, nodeId: 'hub-1', sourceIds: ['remoteok'] });
        assert(run?.runId === 'receipt-run', 'receipt fixture must start a staged run');
        const completed = await completeRunWithReceipt(canvasPath, {
          runId: 'receipt-run', nodeId: 'hub-1', startedAt: 100, completedAt: 200,
          terminal: { status: 'completed', outcome: 'zero' },
          // Sponsored ads are excluded before title admission. The role funnel
          // therefore starts from the 39 real feed rows; its separate 3-ad
          // count must never be laundered into relevanceDropped.
          funnel: { raw: 39, relevanceDropped: 39, deduped: 0, ageDropped: 0, roleDropped: 0, historyDropped: 0, descriptionEvidenceDropped: 0, kept: 0 },
          sources: {
            remoteok: {
              count: 0, providerGathered: 39, relevanceDropped: 39, sponsoredDropped: 3,
              pagesWalked: 7,
              cap: { type: 'jobs-per-platform', limit: 39, url: 'https://MUST NOT PERSIST.example' },
              stopReason: 'feed-exhausted',
              warning: { code: 'safe-code', severity: 'info', evidence: 'MUST NOT PERSIST' },
              revealOutcomes: [
                { queryIndex: 1, queryTotal: 1, exit: 'end-of-list', count: 39, iterations: 7, url: 'https://MUST NOT PERSIST.example' },
                { queryIndex: 2, queryTotal: 1, exit: 'MUST NOT PERSIST', count: 900, iterations: 900 },
              ],
              jobs: [{ title: 'MUST NOT PERSIST', url: 'https://private.example' }],
            },
          },
          jobs: [{ title: 'MUST NOT PERSIST' }], queries: ['MUST NOT PERSIST'], profile: { email: 'MUST NOT PERSIST' },
          stagingStarted: true,
        });
        const receipt = await readLastRunReceipt(canvasPath, { nodeId: 'hub-1' });
        const serialized = await fs.promises.readFile(lastRunReceiptPathForCanvas(canvasPath, { nodeId: 'hub-1' }), 'utf8');
        const remaining = await fs.promises.readdir(root);
        assert(completed.ok && completed.cleared && receipt?.cleanup?.attempted && receipt?.cleanup?.cleared,
          `completion must truthfully record cleanup, got ${JSON.stringify(completed)}`);
        assert(receipt?.terminal?.outcome === 'zero' && receipt?.funnel?.raw === 39
          && receipt?.sources?.remoteok?.relevanceDropped === 39
          && receipt?.sources?.remoteok?.sponsoredDropped === 3
          && receipt?.sources?.remoteok?.cap?.type === 'jobs-per-platform'
          && receipt.sources.remoteok.cap.limit === 39
          && receipt.sources.remoteok.pagesWalked === 7
          && receipt?.sources?.remoteok?.revealOutcomes?.length === 1
          && receipt.sources.remoteok.revealOutcomes[0].exit === 'end-of-list'
          && receipt.sources.remoteok.revealOutcomes[0].count === 39,
          `receipt must retain safe RemoteOK aggregate facts, got ${JSON.stringify(receipt)}`);
        assert(!serialized.includes('MUST NOT PERSIST') && !('jobs' in receipt) && !('queries' in receipt) && !('profile' in receipt),
          `receipt must redact payload fields, got ${serialized}`);
        const scope = jobRunPathScopeForCanvas(canvasPath, 'hub-1');
        assert(!remaining.includes(`workspace.jobs-run.${scope.canvasHash}.${scope.ownerHash}.json`)
          && !remaining.includes(`workspace.jobs-staging.${scope.canvasHash}.${scope.ownerHash}.jsonl`),
          `terminal cleanup must remove run sidecars, got ${remaining.join(', ')}`);
        return { outcome: receipt.terminal.outcome, cleared: receipt.cleanup.cleared };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'job run staging: full canvas and fixed owner hashes prevent filename collisions',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-job-run-path-scope-'));
      const bareCanvas = path.join(root, 'project');
      const jsonCanvas = path.join(root, 'project.json');
      const longOwner = `hub-${'x'.repeat(1_000)}`;
      try {
        await fs.promises.writeFile(bareCanvas, '{}');
        await fs.promises.writeFile(jsonCanvas, '{}');
        const bare = jobRunPathScopeForCanvas(bareCanvas, longOwner);
        const json = jobRunPathScopeForCanvas(jsonCanvas, longOwner);
        assert(bare.canvasHash !== json.canvasHash
          && bare.ownerHash.length === 24
          && !bare.ownerHash.includes(longOwner)
          && `project.jobs-run.${bare.canvasHash}.${bare.ownerHash}.json`.length < 255,
        'modern run sidecars use fixed full-canvas and owner hashes, so basename siblings and pathological IDs cannot collide or exceed NAME_MAX');

        await fs.promises.writeFile(path.join(root, 'project.jobs-run.legacy-owner.json'), JSON.stringify({
          runId: 'legacy', inputs: { nodeId: 'legacy-owner' }, sources: {}, stage: 'searching', lastUpdated: 1,
        }));
        const state = await readRunState(jsonCanvas, 2, { nodeId: 'legacy-owner' });
        assert(state == null,
          'a basename-only legacy sidecar fails closed when project and project.json coexist');
        return { canvasHashLength: bare.canvasHash.length, ownerHashLength: bare.ownerHash.length };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'job run staging: terminal cleanup treats only ENOENT as confirmed absence',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-job-run-cleanup-access-'));
      const canvasPath = path.join(root, 'workspace.json');
      const scope = jobRunPathScopeForCanvas(canvasPath, 'hub-1');
      const stagingPath = path.join(root, `workspace.jobs-staging.${scope.canvasHash}.${scope.ownerHash}.jsonl`);
      const manifestPath = path.join(root, `workspace.jobs-run.${scope.canvasHash}.${scope.ownerHash}.json`);
      const originalAccess = fs.promises.access;
      try {
        await startRun(canvasPath, {
          runId: 'cleanup-access-fault', startedAt: 100, nodeId: 'hub-1', sourceIds: ['remoteok'],
        });
        let completed;
        try {
          fs.promises.access = async (filePath, ...args) => {
            if (path.resolve(filePath) === path.resolve(stagingPath)) {
              throw Object.assign(new Error('injected pre-cleanup access denial'), { code: 'EACCES' });
            }
            return originalAccess(filePath, ...args);
          };
          completed = await completeRunWithReceipt(canvasPath, {
            runId: 'cleanup-access-fault', nodeId: 'hub-1', startedAt: 100, completedAt: 200,
            terminal: { status: 'completed', outcome: 'zero' },
          });
        } finally {
          fs.promises.access = originalAccess;
        }

        const receipt = await readLastRunReceipt(canvasPath, { nodeId: 'hub-1' });
        const remaining = await fs.promises.readdir(root);
        assert(completed?.ok && completed.cleared === false
          && receipt?.cleanup?.attempted === true && receipt.cleanup.cleared === false,
        `access errors must leave terminal cleanup explicitly unconfirmed, got ${JSON.stringify({ completed, receipt })}`);
        assert(remaining.includes(path.basename(stagingPath))
          && remaining.includes(path.basename(manifestPath)),
        `an unverified staging delete must retain the ownership manifest for an exact retry, got ${JSON.stringify({ remaining })}`);
        return { cleared: receipt.cleanup.cleared, stagingPreserved: true, manifestPreserved: true };
      } finally {
        fs.promises.access = originalAccess;
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'job run staging: a trash no-op cannot erase cleanup authority or report success',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-job-run-trash-noop-'));
      const canvasPath = path.join(root, 'workspace.json');
      const scope = jobRunPathScopeForCanvas(canvasPath, 'hub-1');
      const stagingPath = path.join(root, `workspace.jobs-staging.${scope.canvasHash}.${scope.ownerHash}.jsonl`);
      const manifestPath = path.join(root, `workspace.jobs-run.${scope.canvasHash}.${scope.ownerHash}.json`);
      try {
        await startRun(canvasPath, {
          runId: 'trash-noop-run', startedAt: 100, nodeId: 'hub-1', sourceIds: ['remoteok'],
        });
        const result = await clearRunWithResult(canvasPath, {
          expectedRunId: 'trash-noop-run',
          expectedNodeId: 'hub-1',
          trashItem: async () => {},
        });
        const remaining = await fs.promises.readdir(root);
        assert(result.ok === false && result.cleared === false && result.reason === 'cleanup-failed'
          && remaining.includes(path.basename(stagingPath))
          && remaining.includes(path.basename(manifestPath)),
        `a successful-returning trash no-op must fail verification and preserve the manifest, got ${JSON.stringify({ result, remaining })}`);
        return { verifiedNoopRejected: true, manifestPreserved: true };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'job run staging: exact terminal retry resumes partial cleanup without changing its receipt',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-job-run-terminal-retry-'));
      const canvasPath = path.join(root, 'workspace.json');
      const scope = jobRunPathScopeForCanvas(canvasPath, 'hub-1');
      const stagingPath = path.join(root, `workspace.jobs-staging.${scope.canvasHash}.${scope.ownerHash}.jsonl`);
      const manifestPath = path.join(root, `workspace.jobs-run.${scope.canvasHash}.${scope.ownerHash}.json`);
      try {
        await startRun(canvasPath, {
          runId: 'terminal-retry-run', startedAt: 100, nodeId: 'hub-1', sourceIds: ['remoteok'],
        });
        const initialReceipt = {
          runId: 'terminal-retry-run', nodeId: 'hub-1', startedAt: 100, completedAt: 200,
          terminal: { status: 'completed', outcome: 'populated', scoreReadyCount: 7 },
          funnel: { raw: 9, kept: 7 },
        };
        const partial = await completeRunWithReceipt(canvasPath, initialReceipt, {
          expectedNodeId: 'hub-1',
          trashItem: async (filePath) => {
            if (path.resolve(filePath) === path.resolve(stagingPath)) await fs.promises.unlink(filePath);
            // Simulate a Trash implementation that returns without moving the
            // manifest. Verification must keep it as retry authority.
          },
        });
        let remaining = await fs.promises.readdir(root);
        assert(partial.ok === true && partial.cleared === false
          && !remaining.includes(path.basename(stagingPath))
          && remaining.includes(path.basename(manifestPath)),
        `partial cleanup must retain a manifest-only exact retry point, got ${JSON.stringify({ partial, remaining })}`);

        const retried = await completeRunWithReceipt(canvasPath, {
          ...initialReceipt,
          completedAt: 999,
          terminal: { status: 'failed', outcome: 'incomplete', scoreReadyCount: 0 },
          funnel: { raw: 999, kept: 0 },
        }, { expectedNodeId: 'hub-1' });
        const receipt = await readLastRunReceipt(canvasPath, { nodeId: 'hub-1' });
        remaining = await fs.promises.readdir(root);
        assert(retried.ok === true && retried.cleared === true
          && !remaining.includes(path.basename(manifestPath))
          && receipt.completedAt === 200
          && receipt.terminal?.status === 'completed'
          && receipt.terminal?.outcome === 'populated'
          && receipt.terminal?.scoreReadyCount === 7
          && receipt.funnel?.raw === 9
          && receipt.cleanup?.attempted === true && receipt.cleanup.cleared === true,
        `an exact retry must finish cleanup idempotently without rewriting terminal provenance, got ${JSON.stringify({ retried, receipt, remaining })}`);

        // The exact receipt remains sufficient authority if both run sidecars
        // disappeared before its cleanup flag could be updated.
        await writeLastRunReceipt(canvasPath, {
          ...receipt,
          cleanup: { attempted: false, cleared: null },
        }, { expectedRunId: 'terminal-retry-run', nodeId: 'hub-1' });
        const receiptOnlyRetry = await completeRunWithReceipt(canvasPath, initialReceipt, { expectedNodeId: 'hub-1' });
        const finalReceipt = await readLastRunReceipt(canvasPath, { nodeId: 'hub-1' });
        assert(receiptOnlyRetry.ok === true && receiptOnlyRetry.cleared === true
          && finalReceipt.completedAt === 200
          && finalReceipt.terminal?.outcome === 'populated'
          && finalReceipt.cleanup?.cleared === true,
        `an exact receipt-only retry must be idempotent, got ${JSON.stringify({ receiptOnlyRetry, finalReceipt })}`);
        return { partialRecovered: true, receiptOnlyRecovered: true, completedAt: finalReceipt.completedAt };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'job run staging: terminal receipt completion is token-scoped',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-job-run-receipt-token-'));
      const canvasPath = path.join(root, 'workspace.json');
      try {
        await startRun(canvasPath, { runId: 'new-run', startedAt: 100, nodeId: 'new-hub', sourceIds: ['remoteok'] });
        const stale = await completeRunWithReceipt(canvasPath, {
          runId: 'old-run', nodeId: 'old-hub', terminal: { status: 'completed', outcome: 'zero' },
        });
        const state = await readStagedJobs(canvasPath, { nodeId: 'new-hub' });
        const entries = await fs.promises.readdir(root);
        assert(stale.tokenMismatch && !stale.ok && !entries.includes('workspace.jobs-last-run.json'),
          `a stale completion must not write a receipt, got ${JSON.stringify(stale)} / ${entries.join(', ')}`);
        const scope = jobRunPathScopeForCanvas(canvasPath, 'new-hub');
        assert(entries.includes(`workspace.jobs-run.${scope.canvasHash}.${scope.ownerHash}.json`) && Array.isArray(state),
          'a stale completion must preserve the newer run sidecars');
        const direct = await writeLastRunReceipt(canvasPath, { runId: 'receipt-a', terminal: { status: 'completed', outcome: 'zero' } });
        const rejected = await writeLastRunReceipt(canvasPath, { runId: 'receipt-b', terminal: { status: 'completed', outcome: 'zero' } }, { expectedRunId: 'different-token' });
        assert(direct.written && rejected.tokenMismatch && rejected.receipt?.runId === 'receipt-a',
          `direct receipt updates must also reject a wrong expected token, got ${JSON.stringify({ direct, rejected })}`);
        return { staleRejected: true, directTokenGuarded: true };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'job run staging: simultaneous hub completions retain separate receipts',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-job-run-scoped-receipts-'));
      const canvasPath = path.join(root, 'workspace.json');
      try {
        await Promise.all([
          startRun(canvasPath, { runId: 'a-run', startedAt: 1, nodeId: 'hub-a', sourceIds: ['indeed'] }),
          startRun(canvasPath, { runId: 'b-run', startedAt: 2, nodeId: 'hub-b', sourceIds: ['dice'] }),
        ]);
        const [a, b] = await Promise.all([
          completeRunWithReceipt(canvasPath, { runId: 'a-run', nodeId: 'hub-a', terminal: { status: 'completed', outcome: 'zero' } }, { expectedNodeId: 'hub-a' }),
          completeRunWithReceipt(canvasPath, { runId: 'b-run', nodeId: 'hub-b', terminal: { status: 'completed', outcome: 'zero' } }, { expectedNodeId: 'hub-b' }),
        ]);
        const [aReceipt, bReceipt] = await Promise.all([
          readLastRunReceipt(canvasPath, { nodeId: 'hub-a' }),
          readLastRunReceipt(canvasPath, { nodeId: 'hub-b' }),
        ]);
        assert(a?.ok && b?.ok && aReceipt?.runId === 'a-run' && bReceipt?.runId === 'b-run'
          && aReceipt?.nodeId === 'hub-a' && bReceipt?.nodeId === 'hub-b',
        'terminal receipts must be hub-scoped so two completed searches cannot clobber each other');
        return { independentReceipts: true };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'job run staging: a missing hub receipt never resolves to another hub',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-job-run-receipt-owner-'));
      const canvasPath = path.join(root, 'workspace.json');
      try {
        await writeLastRunReceipt(canvasPath, {
          runId: 'hub-b-finished', nodeId: 'hub-b', terminal: { status: 'completed', outcome: 'zero' },
        });
        const wrongHub = await readLastRunReceipt(canvasPath, { nodeId: 'hub-a' });
        assert(wrongHub === null,
          `a scoped receipt read must not fall through to another hub, got ${JSON.stringify(wrongHub)}`);
        return { crossHubReceiptBlocked: true };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'job run staging: renderer terminal provenance distinguishes incomplete failure from a clean zero',
    run: () => {
      const built = buildJobRunCompletionReceipt('failed-batch-run', 200, {
        status: 'failed',
        outcome: 'incomplete',
      });
      const sanitized = sanitizeLastRunReceipt({
        ...built,
        terminal: { status: 'completed', outcome: 'collection-only' },
      });
      assert(built.terminal.status === 'failed' && built.terminal.outcome === 'incomplete',
        `renderer terminal provenance must override the search-only default, got ${JSON.stringify(built.terminal)}`);
      assert(!Object.hasOwn(built.terminal, 'scoreReadyCount'),
        'an unknown terminal result count must stay absent rather than being coerced from null to zero');
      assert(sanitized.terminal.status === 'completed' && sanitized.terminal.outcome === 'collection-only',
        `collection-only completion must remain distinct from a genuine zero, got ${JSON.stringify(sanitized.terminal)}`);
      const nonStringIdentity = sanitizeLastRunReceipt({ runId: 42, nodeId: true });
      assert(nonStringIdentity.runId === '' && nonStringIdentity.nodeId === '',
        'receipt identity fields reject non-string values instead of coercing them into provenance-like tokens');
      const nonNumericCompletionTime = sanitizeLastRunReceipt({
        runId: 'strict-receipt', nodeId: 'strict-hub', completedAt: '1760000000000', updatedAt: false,
      });
      assert(nonNumericCompletionTime.completedAt == null && nonNumericCompletionTime.updatedAt == null,
        'receipt timestamps reject numeric strings and booleans instead of manufacturing terminal ordering evidence');
      const preferenceFiltered = sanitizeLastRunReceipt({
        runId: 'preferences-filtered',
        terminal: { status: 'completed', outcome: 'preference-filtered' },
      });
      assert(preferenceFiltered.terminal.outcome === 'preference-filtered',
        'completion receipts must preserve the Job Preferences all-filtered outcome');
      return { failed: built.terminal.outcome, intentionalSkip: sanitized.terminal.outcome, preferenceFiltered: preferenceFiltered.terminal.outcome };
    },
  },
  {
    name: 'job telemetry: interleaved hubs retain independent search, scoring, and completion receipts',
    run: async () => {
      __resetJobsTelemetryForTests();
      const sender = { label: 'shared-test-window' };
      const inHub = (nodeId, channel, callback) => __runWithIpcRequestContextForTests(
        { sender, nodeId, channel }, callback,
      );
      let releaseHubA;
      const hubAPaused = new Promise(resolve => { releaseHubA = resolve; });
      let hubAStarted;
      const hubAReady = new Promise(resolve => { hubAStarted = resolve; });
      let receiptA;

      const hubA = inHub('hub-a', 'search-jobs', async () => {
        const telemetry = getJobsTelemetry();
        telemetry.nodeId = 'hub-a';
        telemetry.search = {
          runId: 'run-a', ts: 10, raw: 3, deduped: 3, kept: 3,
          bySource: { indeed: { count: 3, providerGathered: 3 } },
        };
        telemetry.pipeline = { runId: 'run-a', startedAt: 10 };
        hubAStarted();
        await hubAPaused;
        await inHub('hub-a', 'score-jobs', async () => {
          const scored = getJobsTelemetry();
          assert(scored.search?.runId === 'run-a' && scored.search?.bySource?.indeed?.count === 3,
            `a hub's score stage must rejoin its own search funnel, got ${JSON.stringify(scored.search)}`);
          scored.scoring = {
            runId: 'run-a', input: 3, selectedForScoring: 3, scored: 3,
            placeholders: 0, unscored: 0, failedBatches: 0, cappedForBudget: 0, providerCalls: 1,
          };
        });
        receiptA = await inHub('hub-a', 'complete-job-run', () => buildJobRunCompletionReceipt('run-a', 30, {
          status: 'completed', outcome: 'populated', scoreReadyCount: 3,
        }));
      });

      await hubAReady;
      const receiptB = await inHub('hub-b', 'search-jobs', async () => {
        const telemetry = getJobsTelemetry();
        telemetry.nodeId = 'hub-b';
        telemetry.search = {
          runId: 'run-b', ts: 20, raw: 7, deduped: 7, kept: 7,
          bySource: { dice: { count: 7, providerGathered: 7 } },
        };
        telemetry.pipeline = { runId: 'run-b', startedAt: 20 };
        await inHub('hub-b', 'score-jobs', () => {
          const scored = getJobsTelemetry();
          assert(scored.search?.runId === 'run-b' && scored.search?.bySource?.indeed == null,
            `a second hub must not inherit the first hub's funnel, got ${JSON.stringify(scored.search)}`);
          scored.scoring = {
            runId: 'run-b', input: 7, selectedForScoring: 7, scored: 6,
            placeholders: 1, unscored: 0, failedBatches: 0, cappedForBudget: 0, providerCalls: 2,
          };
        });
        return inHub('hub-b', 'complete-job-run', () => buildJobRunCompletionReceipt('run-b', 25, {
          status: 'completed', outcome: 'populated', scoreReadyCount: 6,
        }));
      });
      releaseHubA();
      await hubA;

      assert(receiptA?.nodeId === 'hub-a' && receiptA?.scoring?.input === 3
        && receiptA?.sources?.indeed?.count === 3 && receiptA?.sources?.dice == null
        && receiptB?.nodeId === 'hub-b' && receiptB?.scoring?.input === 7
        && receiptB?.sources?.dice?.count === 7 && receiptB?.sources?.indeed == null,
      `interleaved hub receipts must keep their own funnel and scoring aggregates, got ${JSON.stringify({ receiptA, receiptB })}`);
      return { hubA: receiptA.scoring.input, hubB: receiptB.scoring.input };
    },
  },
  {
    name: 'job telemetry: sender-local board and report selection never borrow another window',
    run: () => {
      __resetJobsTelemetryForTests();
      const senderA = { id: 101 };
      const senderB = { id: 202 };
      const run = (sender, nodeId, channel, callback) => __runWithIpcRequestContextForTests(
        { sender, nodeId, channel }, callback,
      );
      run(senderA, 'hub-a', 'search-jobs', () => {
        const telemetry = getJobsTelemetry();
        telemetry.nodeId = 'hub-a'; telemetry.windowId = senderA.id; telemetry.search = { runId: 'a' };
      });
      run(senderB, 'hub-b', 'search-jobs', () => {
        const telemetry = getJobsTelemetry();
        telemetry.nodeId = 'hub-b'; telemetry.windowId = senderB.id; telemetry.search = { runId: 'b' };
      });
      const boardA = run(senderA, null, 'bucket-jobs', () => getJobsTelemetry());
      const reportA = run(senderA, null, 'bug-report', () => __getJobsTelemetryForReportForTests(new Set(['hub-a', 'hub-a-2']), senderA.id));
      assert(boardA.search?.runId === 'a' && reportA?.search?.runId === 'a',
        `sender-local legacy board/report selection must remain in window A, got ${JSON.stringify({ boardA, reportA })}`);
      return { boardRun: boardA.search.runId, reportRun: reportA.search.runId };
    },
  },
  {
    name: 'job telemetry: a report with two matching hubs fails closed instead of selecting the latest',
    run: () => {
      __resetJobsTelemetryForTests();
      const sender = { id: 303 };
      const run = (nodeId, callback) => __runWithIpcRequestContextForTests(
        { sender, nodeId, channel: 'search-jobs' }, callback,
      );
      run('hub-a', () => {
        const telemetry = getJobsTelemetry();
        telemetry.nodeId = 'hub-a';
        telemetry.search = { runId: 'run-a' };
      });
      run('hub-b', () => {
        const telemetry = getJobsTelemetry();
        telemetry.nodeId = 'hub-b';
        telemetry.search = { runId: 'run-b' };
      });
      const reportForBoth = __runWithIpcRequestContextForTests(
        { sender, nodeId: null, channel: 'bug-report' },
        () => __getJobsTelemetryForReportForTests(new Set(['hub-a', 'hub-b']), sender.id),
      );
      const reportForOne = __runWithIpcRequestContextForTests(
        { sender, nodeId: null, channel: 'bug-report' },
        () => __getJobsTelemetryForReportForTests(new Set(['hub-b']), sender.id),
      );
      assert(reportForBoth === null && reportForOne?.search?.runId === 'run-b',
        `a multi-hub report must be indeterminate while a narrowed owner remains readable, got ${JSON.stringify({ reportForBoth, reportForOne })}`);
      return { multiHub: 'indeterminate', singleHub: reportForOne.search.runId };
    },
  },
  {
    // The fail-closed rule above is correct, but every reader of its null used
    // to render an ABSENCE. On a canvas with two Job Search hubs that printed
    // "(no search recorded this session)", "(no scoring recorded this session)"
    // and "(no taxonomy recorded this session)" over a process that had just
    // run three searches, three scorings and a taxonomy pass — while the three
    // Continue clicks the report existed to explain rendered nowhere at all.
    name: 'job telemetry report: two owning hubs state the ambiguity and keep their per-hub records',
    run: () => {
      __resetJobsTelemetryForTests();
      const sender = { id: 606 };
      const now = Date.now();
      const inHub = (nodeId, callback) => __runWithIpcRequestContextForTests(
        { sender, nodeId, channel: 'search-jobs' }, callback,
      );
      inHub('hub-ok', () => {
        const telemetry = getJobsTelemetry();
        telemetry.nodeId = 'hub-ok';
        telemetry.windowId = sender.id;
        telemetry.search = { runId: 'run-healthy', kept: 4 };
        telemetry.indeedSession = {
          ts: now - 140_000, landedUrl: 'https://www.indeed.com/jobs?q=engineer',
          preflightStatus: 'authenticated', hasPPID: true, cookieNames: ['PPID'],
          executablePath: '/healthy/Chrome', userDataDir: '/healthy/profile',
        };
      });
      inHub('hub-blk', () => {
        const telemetry = getJobsTelemetry();
        telemetry.nodeId = 'hub-blk';
        telemetry.windowId = sender.id;
        telemetry.search = { runId: 'run-blocked', kept: 0 };
        telemetry.indeedSession = {
          ts: now - 5_000, landedUrl: 'https://www.indeed.com/challenge',
          preflightStatus: 'challenge', hasPPID: false, cookieNames: [],
          executablePath: '/blocked/Chrome', userDataDir: '/blocked/profile',
        };
        telemetry.resumeAttempts = {
          indeed: [
            { t: now - 9_000, mode: 'native-challenge', outcome: 'closed', detail: 'native window closed' },
            { t: now - 6_000, mode: 'native-challenge', outcome: 'closed', detail: 'native window closed' },
            { t: now - 3_000, mode: 'native-challenge', outcome: 'closed', detail: 'native window closed' },
          ],
        };
      });
      const snapshot = __runWithIpcRequestContextForTests(
        { sender, nodeId: null, channel: 'bug-report' },
        () => buildJobsPipelineSnapshot(
          new Set(['hub-ok', 'hub-blk']), sender.id, null, [], false,
          new Set(['hub-ok', 'hub-blk']),
        ),
      );
      const ambiguity = '2 current Job Search hubs each hold their own live telemetry in this process, so no single hub owns this section';
      assert(snapshot.includes(`### Search\n- (funnel not attributed: ${ambiguity}`)
        && snapshot.includes(`### Scoring\n- (not attributed: ${ambiguity}`)
        && snapshot.includes(`role)\n- (not attributed: ${ambiguity}`),
      `each conflated section must state the observed hub count instead of an absence, got ${snapshot.slice(0, 2500)}`);
      assert(!snapshot.includes('no search recorded this session')
        && !snapshot.includes('no scoring recorded this session')
        && !snapshot.includes('no taxonomy recorded this session'),
      'an ambiguous report must never assert that nothing was recorded');
      // The block at the centre of the incident: three Continue clicks on the
      // BLOCKED hub, printed under that hub rather than merged into a funnel.
      const hubDigests = [...snapshot.matchAll(/^- Hub `(#[0-9a-f]{10})`$/gm)].map((match) => match[1]);
      assert(snapshot.includes('### Per-hub records (no single hub owns the funnel above)')
        && hubDigests.length === 2
        && new Set(hubDigests).size === 2
        && !snapshot.includes('hub-blk')
        && !snapshot.includes('hub-ok')
        && snapshot.includes('    - `indeed` (3 attempts):')
        && (snapshot.match(/`native-challenge`\u2192closed/g) || []).length === 3,
      `the per-hub block must render each hub's own Continue trail under distinct one-way hub digests, got ${snapshot.slice(0, 5000)}`);
      // Naming only whichever hub wrote telemetry last is what sent the original
      // investigation at the healthy run's preflight. Both must be attributable.
      assert(!snapshot.includes('/blocked/profile') && !snapshot.includes('/healthy/profile')
        && (snapshot.match(/<local-path>/g) || []).length >= 2
        && snapshot.includes('    - Preflight status: challenge')
        && snapshot.includes('    - Preflight status: authenticated'),
      `both hubs' preflights must be shown with their owner, got ${snapshot.slice(0, 5000)}`);
      return { ambiguousHubs: 2, perHubRecords: 2 };
    },
  },
  {
    // The other half of the same rule: when nothing was genuinely recorded the
    // honest absence statement must survive untouched, so "ambiguous" never
    // becomes a blanket replacement that hides a real empty process.
    name: 'job telemetry report: a single owner keeps the honest absence wording',
    run: () => {
      __resetJobsTelemetryForTests();
      const sender = { id: 707 };
      __runWithIpcRequestContextForTests({ sender, nodeId: 'hub-live', channel: 'search-jobs' }, () => {
        const telemetry = getJobsTelemetry();
        telemetry.nodeId = 'hub-live';
        telemetry.windowId = sender.id;
        telemetry.indeedSession = {
          ts: Date.now(), landedUrl: 'https://www.indeed.com/jobs',
          preflightStatus: 'authenticated', hasPPID: true, cookieNames: ['PPID'],
        };
      });
      const soleOwner = __runWithIpcRequestContextForTests(
        { sender, nodeId: null, channel: 'bug-report' },
        () => buildJobsPipelineSnapshot(new Set(['hub-live']), sender.id, null, [], false, new Set(['hub-live'])),
      );
      assert(soleOwner.includes('### Search\n- (no search recorded this session')
        && soleOwner.includes('### Scoring\n- (no scoring recorded this session)')
        && soleOwner.includes('- (no taxonomy recorded this session)')
        && !soleOwner.includes('not attributed:')
        && !soleOwner.includes('### Per-hub records'),
      `one owner that recorded no funnel is a real absence, got ${soleOwner.slice(0, 2500)}`);
      // Zero owners keeps the pre-existing whole-section suppression: an empty
      // string asserts nothing, which is the correct answer for a hub set that
      // holds no telemetry at all.
      const noOwner = __runWithIpcRequestContextForTests(
        { sender, nodeId: null, channel: 'bug-report' },
        () => buildJobsPipelineSnapshot(new Set(['hub-absent']), sender.id, null, [], false, new Set(['hub-absent'])),
      );
      assert(!noOwner.includes('### Per-hub records') && !noOwner.includes('not attributed:'),
        `a hub set with no telemetry must not claim ambiguity, got ${noOwner.slice(0, 800)}`);
      return { soleOwner: 'absence', noOwner: noOwner.length };
    },
  },
  {
    // "previous-process receipt" was an inference, not an observation: all the
    // report ever saw was that no live pipeline phase could be attributed. Two
    // live hubs made it plainly false — runs that had finished seconds earlier
    // in THIS process were labelled as belonging to a previous one.
    name: 'job recovery/completion report: an unattributable live run is reported as observed, not as a previous process',
    run: async () => {
      __resetJobsTelemetryForTests();
      const sender = { id: 808 };
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-jobs-multihub-report-'));
      const canvasPath = path.join(root, 'workspace.json');
      try {
        await fs.promises.writeFile(canvasPath, JSON.stringify({ nodes: [] }), 'utf8');
        await writeLastRunReceipt(canvasPath, {
          runId: 'run-receipt', nodeId: 'hub-a',
          startedAt: 1_700_000_000_000, completedAt: 1_700_000_060_000,
          terminal: { status: 'completed', outcome: 'populated', scoreReadyCount: 4 },
          cleanup: { attempted: true, cleared: true },
        });
        for (const nodeId of ['hub-a', 'hub-b']) {
          __runWithIpcRequestContextForTests({ sender, nodeId, channel: 'search-jobs' }, () => {
            const telemetry = getJobsTelemetry();
            telemetry.nodeId = nodeId;
            telemetry.windowId = sender.id;
            telemetry.search = { runId: `run-${nodeId}` };
          });
        }
        const report = (hubs) => __runWithIpcRequestContextForTests(
          { sender, nodeId: null, channel: 'bug-report' },
          () => ({
            recovery: buildJobRecoverySnapshot(canvasPath, new Set(hubs), new Set(hubs), sender.id),
            assessment: buildJobCompletionAssessment(canvasPath, new Set(hubs), [], null, new Set(hubs), sender.id),
          }),
        );
        const ambiguity = '2 current Job Search hubs each hold their own live telemetry in this process, so no single hub owns this section';
        const both = report(['hub-a', 'hub-b']);
        assert(!both.recovery.includes('previous-process receipt') && !both.assessment.includes('previous-process receipt'),
          `the report may not assert a previous process it never observed, got ${both.recovery.slice(0, 1500)}`);
        assert(both.recovery.includes(`receipt not correlated to a live run \u2014 ${ambiguity}`)
          && both.recovery.includes(`no pipeline phase is attributable here: ${ambiguity}`),
        `recovery must name the observed hub count for both the receipt and the sidecars, got ${both.recovery.slice(0, 2500)}`);
        assert(both.assessment.includes(`- Search + recovery: not attributable \u2014 ${ambiguity}`)
          && both.assessment.includes(`- Scoring: not attributable \u2014 ${ambiguity}.`)
          && both.assessment.includes(`- Taxonomy: not attributable \u2014 ${ambiguity}.`)
          && both.assessment.includes(`- Seen-history write: not attributable \u2014 ${ambiguity}.`)
          && both.assessment.includes(`- Live search stage: not attributable \u2014 ${ambiguity}`)
          && !both.assessment.includes('not retained in this process'),
        `every completion line must distinguish ambiguity from absence, got ${both.assessment.slice(0, 3000)}`);
        // Narrowing to the single hub that owns telemetry removes the ambiguity
        // and must restore the plain absence wording verbatim.
        const sole = report(['hub-a']);
        assert(sole.recovery.includes('receipt not correlated to a live run \u2014 no live pipeline telemetry was attributable in this process')
          && sole.recovery.includes('no pipeline phase recorded in this process')
          && sole.assessment.includes('- Scoring: not retained in this process.')
          && sole.assessment.includes('- Taxonomy: not retained in this process.')
          && !sole.assessment.includes('not attributable'),
        `a single owner must keep the honest absence wording, got ${sole.assessment.slice(0, 3000)}`);
        return { ambiguous: 2, sole: 1 };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    // `detail` is free-form producer prose and a native-login failure reason
    // carries the landing URL verbatim, so the trail was exporting auth and
    // continuation query tokens under a heading whose contract is that query
    // strings are never reported. The same line's 120-character render cap then
    // amputated the TAIL of the 'unverified' detail — "no indeed.com tab was
    // ever visible to the observer" — which is the clause that separates "we
    // watched and it never cleared" from "we never saw the window at all".
    name: 'job resume trail: free-form detail is URL-redacted and kept to the producer\'s own 200-character bound',
    run: () => {
      __resetJobsTelemetryForTests();
      const sender = { id: 909 };
      const now = Date.now();
      // Both strings are the shapes electron/ipc/jobs.js actually writes.
      const loginDetail = 'login window could not run: landed on https://secure.indeed.com/auth?token=secret&continue=https%3A%2F%2Fwww.indeed.com%2Fjobs';
      const unverifiedDetail = 'native challenge ended timeout; no clearance observed either way; probing with the resume scrape; 12 tab poll(s); no indeed.com tab was ever visible to the observer';
      __runWithIpcRequestContextForTests({ sender, nodeId: 'hub-trail', channel: 'search-jobs' }, () => {
        const telemetry = getJobsTelemetry();
        telemetry.nodeId = 'hub-trail';
        telemetry.windowId = sender.id;
        telemetry.resumeAttempts = {
          indeed: [
            { t: now - 8_000, mode: 'native-login', outcome: 'login-failed', detail: loginDetail },
            { t: now - 2_000, mode: 'native-challenge', outcome: 'unverified', detail: unverifiedDetail },
          ],
          // recordResumeAttemptTelemetry keeps only the newest 12 per source, so
          // a full list is a FLOOR on the number of clicks the user made, never
          // a total — the count must say so rather than read as "12 attempts".
          dice: Array.from({ length: 12 }, (_, index) => ({
            t: now - (12 - index) * 1_000, mode: 'retry-descriptions',
            outcome: 'blocked', detail: 'no descriptions to retry',
          })),
        };
      });
      const snapshot = __runWithIpcRequestContextForTests(
        { sender, nodeId: null, channel: 'bug-report' },
        () => buildJobsPipelineSnapshot(new Set(['hub-trail']), sender.id, null, [], false, new Set(['hub-trail'])),
      );
      assert(snapshot.includes('https://secure.indeed.com/auth')
        && !snapshot.includes('token=')
        && !snapshot.includes('continue=')
        && !snapshot.includes('secret'),
      `the resume trail must keep the landed host/path and export no query data, got ${snapshot.slice(0, 4000)}`);
      assert(snapshot.includes(unverifiedDetail)
        && snapshot.includes('12 tab poll(s); no indeed.com tab was ever visible to the observer')
        && !snapshot.includes('probing with the resume scrape; 12 tab poll(s); no in…'),
      `the observer evidence at the end of an 'unverified' detail must survive rendering, got ${snapshot.slice(0, 4000)}`);
      assert(snapshot.includes('- `dice` (12 retained at the producer\'s newest-12 cap — any earlier click is not retained)')
        && !snapshot.includes('`dice` (12 attempts)'),
      `a saturated per-source trail must be marked rather than counted as a total, got ${snapshot.slice(0, 4000)}`);
      return { redactedUrls: 1, detailChars: unverifiedDetail.length, saturatedSources: 1 };
    },
  },
  {
    // Two defects that both over-claim: the multi-hub Search line pointed at a
    // "Per-hub records" heading that renders only when some hub holds an
    // attributable record (two hubs that searched with no Indeed session and no
    // Continue click hold none), and the Solve-pass line said "all retained"
    // over a list an outcome allowlist had just shortened.
    name: 'job telemetry report: the per-hub pointer and the Solve-pass trail claim only what was rendered',
    run: async () => {
      __resetJobsTelemetryForTests();
      const sender = { id: 910 };
      const now = Date.now();
      const seed = (nodeId, runId, resolvePasses) => __runWithIpcRequestContextForTests(
        { sender, nodeId, channel: 'search-jobs' },
        () => {
          const telemetry = getJobsTelemetry();
          telemetry.nodeId = nodeId;
          telemetry.windowId = sender.id;
          telemetry.search = { runId };
          telemetry.sourceRunHistory = {
            google: [{
              runId, announcedAt: 1_000, dispatchedAt: 2_000, terminalAt: 5_000,
              announcedStatus: 'searching', terminalStatus: 'done',
              resolvePassCount: resolvePasses.length, resolvePasses,
            }],
          };
        },
      );
      seed('hub-x', 'run-x', [
        { at: now - 4_000, outcome: 'completed', attempted: 2, recovered: 2, checkpoint: 'saved' },
        // An outcome this renderer's allowlist does not contain — a future or
        // malformed producer row. It is dropped, so the summary above it may not
        // describe the list as complete.
        { at: now - 3_000, outcome: 'deferred-to-next-run', attempted: 1 },
        { at: now - 2_000, outcome: 'blocked', attempted: 1, recommendation: 'retry' },
      ]);
      seed('hub-y', 'run-y', []);
      const hubs = () => new Set(['hub-x', 'hub-y']);
      // The completion assessment renders nothing at all without a durable
      // receipt or saved snapshot to reconcile, so give it the receipt its
      // "Search + recovery" line is written for.
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-jobs-pointer-report-'));
      const canvasPath = path.join(root, 'workspace.json');
      try {
        await fs.promises.writeFile(canvasPath, JSON.stringify({ nodes: [] }), 'utf8');
        await writeLastRunReceipt(canvasPath, {
          runId: 'run-receipt', nodeId: 'hub-x',
          startedAt: 1_700_000_000_000, completedAt: 1_700_000_060_000,
          terminal: { status: 'completed', outcome: 'populated', scoreReadyCount: 4 },
          cleanup: { attempted: true, cleared: true },
        });
        const rendered = __runWithIpcRequestContextForTests(
          { sender, nodeId: null, channel: 'bug-report' },
          () => ({
            snapshot: buildJobsPipelineSnapshot(hubs(), sender.id, null, [], false, hubs()),
            assessment: buildJobCompletionAssessment(canvasPath, hubs(), [], null, hubs(), sender.id),
          }),
        );
        assert(rendered.snapshot.includes('No hub held an independently attributable record either, so no "Per-hub records" section follows')
          && !rendered.snapshot.includes('### Per-hub records')
          && !rendered.snapshot.includes('are under "Per-hub records" below'),
        `the Search line may not point at a heading this report never wrote, got ${rendered.snapshot.slice(0, 4000)}`);
        assert(rendered.assessment.includes('- Search + recovery: not attributable — 2 current Job Search hubs each hold their own live telemetry in this process, so no single hub owns this section; no hub held an independently attributable record either, so no per-hub records are listed.')
          && !rendered.assessment.includes('listed in Job Search Pipeline'),
        `the completion assessment must apply the same conditional, got ${rendered.assessment.slice(0, 3000)}`);
        assert(/Solve passes \(run `#[0-9a-f]{10}`\): 3 recorded · 2 rendered · ⚠️ 1 carried an outcome this report does not recognise and is not rendered\./.test(rendered.snapshot)
          && !rendered.snapshot.includes('run-x')
          && !rendered.snapshot.includes('run-y')
          && !rendered.snapshot.includes('all retained')
          && !rendered.snapshot.includes('deferred-to-next-run'),
        `an allowlist-shortened Solve trail must state both counts and mark the drop without exporting a raw run identifier, got ${rendered.snapshot.slice(0, 4000)}`);
        return { danglingPointers: 0, unrecognisedPasses: 1 };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'job telemetry: a legacy board request stays pinned while another hub becomes latest',
    run: async () => {
      __resetJobsTelemetryForTests();
      const sender = { label: 'shared-test-window' };
      const inHub = (nodeId, channel, callback) => __runWithIpcRequestContextForTests(
        { sender, nodeId, channel }, callback,
      );
      const hubATelemetry = await inHub('hub-a', 'search-jobs', () => {
        const telemetry = getJobsTelemetry();
        telemetry.nodeId = 'hub-a';
        telemetry.search = { runId: 'run-a', bySource: {} };
        return telemetry;
      });
      let releaseBoard;
      const boardPaused = new Promise(resolve => { releaseBoard = resolve; });
      let boardStarted;
      const boardReady = new Promise(resolve => { boardStarted = resolve; });
      const board = inHub('board-a', 'bucket-jobs', async () => {
        const telemetry = getJobsTelemetry();
        telemetry.bucketing = { phase: 'started' };
        boardStarted();
        await boardPaused;
        getJobsTelemetry().bucketing = { phase: 'finished' };
        return telemetry;
      });
      await boardReady;
      const hubBTelemetry = await inHub('hub-b', 'search-jobs', () => {
        const telemetry = getJobsTelemetry();
        telemetry.nodeId = 'hub-b';
        telemetry.search = { runId: 'run-b', bySource: {} };
        return telemetry;
      });
      releaseBoard();
      const boardTelemetry = await board;

      assert(boardTelemetry === hubATelemetry
        && hubATelemetry.bucketing?.phase === 'finished'
        && hubBTelemetry.bucketing == null,
      `a bucket request must retain its first ambient telemetry target across awaits, got ${JSON.stringify({ hubA: hubATelemetry.bucketing, hubB: hubBTelemetry.bucketing })}`);
      return { boardTarget: hubATelemetry.nodeId, isolatedFrom: hubBTelemetry.nodeId };
    },
  },
  {
    name: 'job run staging: durable scoring receipt is run-scoped and redacted',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, search: telemetry.search, pipeline: telemetry.pipeline,
        scoring: telemetry.scoring, resolves: telemetry.resolves,
      };
      try {
        telemetry.nodeId = 'receipt-hub';
        telemetry.search = {
          runId: 'receipt-run', ts: 100, raw: 4, relevanceDropped: 0, deduped: 4,
          ageDropped: 0, roleDropped: 0, historyDropped: 0, kept: 4,
          bySource: {
            dice: {
              count: 188,
              providerGathered: 190,
              unavailableDetailDropped: 2,
              pagesWalked: 4,
            },
            glassdoor: {
              count: 7,
              providerGathered: 7,
              locationScopeUnenforced: true,
            },
            linkedin: {
              count: 60,
              providerGathered: 60,
              cap: { type: 'source-internal', limit: 150 },
              stopReason: 'result-ceiling',
            },
          },
        };
        telemetry.pipeline = { runId: 'receipt-run', startedAt: 100 };
        const ownership = { nodeId: 'receipt-hub', jobRunId: 'receipt-run' };
        const stampedResolve = recordLinkedinResolveAttempt('linkedin', {}, ownership);
        const stampedMerge = recordResolveMergeOutcome('linkedin', {
          replacedExisting: 0, fresh: 20, pendingBefore: 0, pendingAfter: 20,
        }, ownership);
        assert(stampedResolve?.runId === 'receipt-run'
          && stampedMerge?.runId === 'receipt-run'
          && stampedMerge.cumulativeMergeNet === 20,
        `renderer merge outcomes must retain current-run provenance, got ${JSON.stringify(stampedMerge)}`);
        telemetry.scoring = {
          runId: 'other-run', input: 91, selectedForScoring: 90, scored: 89,
          placeholders: 88, unscored: 1, failedBatches: 7, cappedForBudget: 1,
          providerCalls: 99, failureReason: 'MUST NOT PERSIST', jobs: [{ title: 'MUST NOT PERSIST' }],
        };
        telemetry.resolves = {
          stale: {
            runId: 'other-run', hasMergeTelemetry: true, cumulativeMergeNet: 999,
            jobs: [{ title: 'MUST NOT PERSIST' }],
          },
        };
        const mismatch = sanitizeLastRunReceipt(buildJobRunCompletionReceipt('receipt-run', 200));
        assert(!Object.hasOwn(mismatch, 'scoring') && !Object.hasOwn(mismatch, 'recovery'),
          `completion must not borrow scoring or recovery from another run, got ${JSON.stringify(mismatch)}`);

        const hostile = sanitizeLastRunReceipt({
          runId: 'receipt-run',
          scoring: {
            input: 4, selected: 3, scored: 3, placeholders: 1, unscored: 0, failedBatches: 1,
            cappedForBudget: 1, providerCalls: 2, prompt: 'MUST NOT PERSIST',
            failureReason: 'MUST NOT PERSIST', jobs: [{ title: 'MUST NOT PERSIST' }], url: 'https://MUST-NOT-PERSIST.example',
          },
          recovery: {
            mergeNet: -7, sourceId: 'MUST NOT PERSIST', jobs: [{ title: 'MUST NOT PERSIST' }],
          },
        });
        assert(JSON.stringify(hostile).includes('MUST NOT PERSIST') === false
          && hostile.recovery?.mergeNet === -7
          && Object.keys(hostile.scoring).every(key => ['input', 'selected', 'scored', 'placeholders', 'unscored', 'failedBatches', 'cappedForBudget', 'providerCalls'].includes(key)),
        `receipt sanitizers must whitelist signed recovery/scoring aggregates only, got ${JSON.stringify(hostile)}`);
        const absentCoverage = sanitizeLastRunReceipt({
          runId: 'receipt-run',
          scoring: {},
          sources: {
            dice: { providerTotal: null, cap: { type: 'jobs-per-platform', limit: null } },
            'dice-zero-cap': { cap: { type: 'pages-per-platform', limit: 0 } },
            'dice-fraction-cap': { cap: { type: 'pages-per-platform', limit: 0.5 } },
            'dice-boolean-cap': { cap: { type: 'pages-per-platform', limit: true } },
          },
        });
        assert(!Object.hasOwn(absentCoverage, 'scoring')
          && !Object.hasOwn(absentCoverage.sources.dice, 'providerTotal')
          && !Object.hasOwn(absentCoverage.sources.dice, 'cap')
          && !Object.hasOwn(absentCoverage.sources['dice-zero-cap'], 'cap')
          && !Object.hasOwn(absentCoverage.sources['dice-fraction-cap'], 'cap')
          && !Object.hasOwn(absentCoverage.sources['dice-boolean-cap'], 'cap'),
        `null coverage/scoring values must stay absent, got ${JSON.stringify(absentCoverage)}`);
        const pageCap = sanitizeLastRunReceipt({
          runId: 'receipt-run',
          sources: { dice: { cap: { type: 'pages-per-platform', limit: 2, detail: 'MUST NOT PERSIST' } } },
        });
        assert(pageCap.sources.dice.cap?.type === 'pages-per-platform' && pageCap.sources.dice.cap.limit === 2
          && !JSON.stringify(pageCap).includes('MUST NOT PERSIST'),
        `safe page caps must survive receipt sanitization without details, got ${JSON.stringify(pageCap)}`);
        const autoPageCap = sanitizeLastRunReceipt({
          runId: 'receipt-run',
          sources: { ziprecruiter: { cap: { type: 'auto-pages-per-platform', limit: 40, detail: 'MUST NOT PERSIST' } } },
        });
        assert(autoPageCap.sources.ziprecruiter.cap?.type === 'auto-pages-per-platform'
          && autoPageCap.sources.ziprecruiter.cap.limit === 40
          && !JSON.stringify(autoPageCap).includes('MUST NOT PERSIST'),
        `Auto browser-page caps must survive durable receipt sanitization without details, got ${JSON.stringify(autoPageCap)}`);
        const manualAggregate = { jobs: [], stopReasons: new Set(['page-cap']), truncated: true };
        assert(mergeJobSourceCollectionCap(manualAggregate, { type: 'auto-pages-per-platform', limit: 40 })
          && manualAggregate.cap?.limit === 40
          && manualAggregate.caps?.[0]?.type === 'auto-pages-per-platform',
        `manual browser aggregation must retain its Auto cap before receipt serialization, got ${JSON.stringify(manualAggregate)}`);
        const manualReceipt = sanitizeLastRunReceipt({
          runId: 'receipt-run',
          sources: { ziprecruiter: manualAggregate },
        });
        assert(manualReceipt.sources.ziprecruiter.truncated === true
          && manualReceipt.sources.ziprecruiter.cap?.type === 'auto-pages-per-platform'
          && manualReceipt.sources.ziprecruiter.caps?.some(cap => cap.type === 'auto-pages-per-platform' && cap.limit === 40),
        `manual Auto cap provenance must survive aggregation into a durable receipt, got ${JSON.stringify(manualReceipt.sources.ziprecruiter)}`);
        const linkedInCap = sanitizeLastRunReceipt({
          runId: 'receipt-run',
          sources: { linkedin: { cap: { type: 'source-internal', limit: 150 }, stopReason: 'result-ceiling' } },
        });
        assert(linkedInCap.sources.linkedin.cap?.type === 'source-internal'
          && linkedInCap.sources.linkedin.cap.limit === 150
          && linkedInCap.sources.linkedin.stopReason === 'result-ceiling',
        `LinkedIn's own ceiling must survive the durable receipt distinctly from a user cap, got ${JSON.stringify(linkedInCap.sources.linkedin)}`);
        const mixedStops = sanitizeLastRunReceipt({
          runId: 'receipt-run',
          sources: {
            dice: {
              stopReason: 'provider-total/short-page/empty-page/end-of-results/jobs-per-platform/pages-per-platform/page-ceiling/another-safe-stop/overflow-stop',
              caps: [{ type: 'jobs-per-platform', limit: 3 }, { type: 'pages-per-platform', limit: 2 }],
            },
          },
        });
        assert(mixedStops.sources.dice.stopReason === 'provider-total/short-page/empty-page/end-of-results/jobs-per-platform/pages-per-platform/page-ceiling/another-safe-stop'
          && mixedStops.sources.dice.caps?.length === 2,
        `long fan-out stop evidence must retain complete bounded tokens and both safe caps, got ${JSON.stringify(mixedStops.sources.dice)}`);

        telemetry.scoring = {
          ...telemetry.scoring,
          runId: 'receipt-run', input: 4, selectedForScoring: 3, scored: 3,
          placeholders: 1, unscored: 0, failedBatches: 1, cappedForBudget: 1, providerCalls: 2,
        };
        telemetry.resolves = {
          linkedin: { runId: 'receipt-run', hasMergeTelemetry: true, cumulativeMergeNet: 20 },
          stale: { runId: 'other-run', hasMergeTelemetry: true, cumulativeMergeNet: 999 },
        };
        const matched = sanitizeLastRunReceipt(buildJobRunCompletionReceipt('receipt-run', 200));
        const serialized = JSON.stringify(matched);
        assert(matched.version === 3 && matched.scoring?.input === 4 && matched.scoring.selected === 3
          && matched.scoring.scored === 3 && matched.scoring.placeholders === 1
          && matched.scoring.unscored === 0 && matched.scoring.failedBatches === 1
          && matched.scoring.cappedForBudget === 1 && matched.scoring.providerCalls === 2
          && matched.recovery?.mergeNet === 20
          && matched.sources?.dice?.pagesWalked === 4
          && matched.sources?.dice?.providerGathered === 190
          && matched.sources?.dice?.unavailableDetailDropped === 2
          && matched.sources?.glassdoor?.locationScopeUnenforced === true
          && matched.sources?.linkedin?.cap?.type === 'source-internal'
          && matched.sources?.linkedin?.cap?.limit === 150,
          `matching run-scoped scoring/recovery aggregates must survive sanitization, got ${serialized}`);
        assert(!serialized.includes('MUST NOT PERSIST') && !('failureReason' in matched.scoring) && !('jobs' in matched.scoring),
          `receipt scoring must remain aggregate-only, got ${serialized}`);
        return { mismatchRejected: true, selected: matched.scoring.selected };
      } finally {
        Object.assign(telemetry, saved);
      }
    },
  },
  {
    name: 'job run staging: API fan-out preserves pagination and finite-cap diagnostics',
    run: () => {
      const source = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
      const fanOutStart = source.indexOf('async function queryFanOut(');
      const fanOutEnd = source.indexOf('\nasync function fetchHttpSources(', fanOutStart);
      const fanOut = source.slice(fanOutStart, fanOutEnd);
      const httpStart = fanOutEnd;
      const httpEnd = source.indexOf('\n/**\n * Resolve only the board location.', httpStart);
      const http = source.slice(httpStart, httpEnd);
      const apiMergeStart = source.indexOf('for (const res of apiResults)');
      const apiMergeEnd = source.indexOf('// Each API fetcher now returns', apiMergeStart);
      const apiMerge = source.slice(apiMergeStart, apiMergeEnd);
      const bySourceStart = source.indexOf('const bySource = {};');
      const bySourceEnd = source.indexOf('// Per-source date-bound truth.', bySourceStart);
      const bySource = source.slice(bySourceStart, bySourceEnd);
      assert(fanOutStart >= 0 && fanOutEnd > fanOutStart
        && fanOut.includes('const pagesFetched = results.reduce(')
        && fanOut.includes('r?.providerTotal != null')
        && fanOut.includes('Number(r.providerTotal) >= 0')
        && fanOut.includes("'auto-jobs-per-platform'")
        && fanOut.includes('Number(value.limit) > 0')
        && fanOut.includes(".map(reason => (typeof reason === 'string' ? reason : reason?.stopReason))")
        && fanOut.includes("warning: { code: 'query-error', severity: 'warn' }")
        && fanOut.includes("stopReason: 'query-error'")
        && fanOut.includes('await abortableDelay(waitMs, signal);')
        && !fanOut.includes('await new Promise(res => setTimeout(res, waitMs))')
        && fanOut.includes('const caps = [...new Map(')
        && fanOut.includes('stopReasons, pagesFetched, cap, caps }'),
      'query fan-out must aggregate Dice page counts, retain every finite extractor cap, and make paced dispatch waits abortable');
      const completeProviderTotals = [401, null].every(value => (
        value != null && value !== '' && Number.isFinite(Number(value))
      ));
      assert(!completeProviderTotals,
        'one coverage-unproven query must prevent a fan-out provider total from being fabricated as zero');
      assert(httpEnd > httpStart
        && http.includes('const pagesFetched = Array.isArray(result) ? 0')
        && http.includes('sourceCap, sourceCaps, pagesFetched, relevanceDropped'),
      'HTTP wrapper must return fan-out page counts to the source-results merge');
      assert(apiMergeStart >= 0 && apiMergeEnd > apiMergeStart
        && apiMerge.includes('if (res.pagesFetched != null)')
        && apiMerge.includes('sourceResults[res.sourceId].pagesWalked = Math.max(')
        && apiMerge.includes('if (res.sourceCap && !sourceResults[res.sourceId].cap)')
        && apiMerge.includes('if (Array.isArray(res.sourceCaps) && res.sourceCaps.length > 0)'),
      'HTTP result merging must publish page/cap diagnostics into the per-source funnel');
      assert(bySourceStart >= 0 && bySourceEnd > bySourceStart
        // 'source-internal' joins the list so a board's OWN result ceiling
        // (LinkedIn's 150) survives serialization and can be reported with its
        // number instead of a bare `result-ceiling` stop reason. It is still
        // refused as user-configured-cap proof by configuredSourceCap.
        && bySource.includes("'auto-jobs-per-platform'")
        && bySource.includes('Number(data.cap.limit) > 0')
        && bySource.includes("data.stopReasons.add(autoJobs ? 'auto-jobs-per-platform' : 'jobs-per-platform')")
        && bySource.includes('if (Array.isArray(data.caps))')
        && bySource.includes('bySource[sid].cap = { type: data.cap.type, limit: Math.floor(Number(data.cap.limit)) };'),
      'by-source serialization must retain finite API caps and matching outer-cap stop evidence');
      assert(source.includes('const diceEffectivePageSize = normalizedCollectionLimits.jobsPerPlatform == null')
        && source.includes("' (limited by Jobs per platform)'")
        && source.includes('server-side; ${dicePageSizeFact}'),
      'Dice date-bound diagnostics must describe the cap-sized API request rather than always claiming the 400/1000 default');
      return { fanOutPages: true, sourceCap: true };
    },
  },
  {
    name: 'job run staging: fan-out pacing aborts before a second dispatch',
    run: async () => {
      const controller = new AbortController();
      let signalWaitRegistered;
      const pacingWaitRegistered = new Promise((resolve) => { signalWaitRegistered = resolve; });
      let observedPacingWait = false;
      // The wrapper makes the test wait for abortableDelay to subscribe before
      // aborting. That is a deterministic handoff, not a wall-clock guess at
      // whether the second query reached its long pacing timer.
      const signal = {
        get aborted() { return controller.signal.aborted; },
        addEventListener(type, listener, options) {
          if (type === 'abort' && !observedPacingWait) {
            observedPacingWait = true;
            signalWaitRegistered();
          }
          return controller.signal.addEventListener(type, listener, options);
        },
        removeEventListener(...args) {
          return controller.signal.removeEventListener(...args);
        },
      };
      const fetchCalls = [];
      const fanOut = __queryFanOutForTests(
        ['first query', 'second query'],
        async (query) => {
          fetchCalls.push(query);
          return { items: [] };
        },
        signal,
        { concurrency: 1, minIntervalMs: 750, label: 'fan-out abort test' },
      );
      let handshakeTimeout = null;
      let outcomeTimeout = null;
      let cleanupTimeout = null;
      try {
        const handshake = await Promise.race([
          pacingWaitRegistered.then(() => ({ status: 'registered' })),
          new Promise((resolve) => {
            handshakeTimeout = setTimeout(() => resolve({ status: 'timed-out' }), 500);
          }),
        ]);
        if (handshakeTimeout) clearTimeout(handshakeTimeout);
        assert(handshake.status === 'registered',
          'the second fan-out dispatch must reach an abort-aware pacing wait promptly');
        controller.abort();

        const outcome = await Promise.race([
          fanOut.then(
            (value) => ({ status: 'resolved', value }),
            (error) => ({ status: 'rejected', error }),
          ),
          new Promise((resolve) => {
            outcomeTimeout = setTimeout(() => resolve({ status: 'timed-out' }), 300);
          }),
        ]);
        if (outcomeTimeout) clearTimeout(outcomeTimeout);

        assert(
          outcome.status === 'rejected'
            && outcome.error?.message === 'aborted'
            && JSON.stringify(fetchCalls) === JSON.stringify(['first query'])
            && !outcome.value?.warning,
          `aborting during the second query's paced wait must settle promptly without dispatching it or converting cancellation into a query-error envelope, got ${JSON.stringify({ outcome: { status: outcome.status, error: outcome.error?.message, value: outcome.value }, fetchCalls })}`,
        );
        return { promptAbort: true, secondDispatchPrevented: true, noQueryErrorEnvelope: true };
      } finally {
        if (handshakeTimeout) clearTimeout(handshakeTimeout);
        if (outcomeTimeout) clearTimeout(outcomeTimeout);
        controller.abort();
        // If a future regression removes abortable pacing, do not leave its
        // raw timer behind. The shorter interval bounds this cleanup path too.
        await Promise.race([
          fanOut.catch(() => undefined),
          new Promise((resolve) => {
            cleanupTimeout = setTimeout(resolve, 1_000);
          }),
        ]);
        if (cleanupTimeout) clearTimeout(cleanupTimeout);
      }
    },
  },
  {
    name: 'job run staging: interrupted role-band work is not a market-cohort failure',
    run: () => {
      const source = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
      const partitionStart = source.indexOf('for (const roleCandidates of candidatesByRole.values())');
      const lookupStart = source.indexOf('let roleBands;', partitionStart);
      const preLookup = source.slice(partitionStart, lookupStart);
      assert(partitionStart >= 0 && lookupStart > partitionStart
        && preLookup.includes('roleBandInterruptedJobs += roleCandidates.length;')
        && !preLookup.includes('failedCohorts++'),
      'an abort before role-band grouping must count interrupted rows without inventing a failed market cohort');
      assert(source.includes('roleBandInterruptedJobs,'),
        'compensation telemetry must expose interrupted role-band rows to diagnostics');
      return { roleBandInterrupted: true };
    },
  },
  {
    name: 'search-jobs: the bulk AI role screen merges unstamped rows positionally without cross-source id collisions',
    run: () => {
      // On a RESUME, `deduped` is seeded from the crashed run's staged
      // rows, which already carry a `roleScreen` stamp from the interrupted
      // attempt. Before this fix, the handler re-sent the WHOLE deduped
      // pool to screenJobRolesByTitle on every resume, spending an extra
      // handoff, and -- because this is a non-deterministic semantic call --
      // could flip an already-accepted row into a drop for a reason the
      // report never surfaces. The fix filters to `roleUnscreened` (rows
      // lacking a stamp) before the call, and rebuilds the kept pool from the
      // FULL `deduped` list afterward so previously-screened rows pass
      // through untouched instead of being replaced by (or re-judged into)
      // the fresh screen's output.
      const source = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
      const stageStart = source.indexOf('const roleScreenTitles = Array.isArray(activeJobPreferencePlan?.titles)');
      const stageEnd = source.indexOf('// Drop anything we\'ve already shown the user on a previous run.', stageStart);
      const stage = source.slice(stageStart, stageEnd);
      assert(stageStart >= 0 && stageEnd > stageStart, 'could not locate the search-jobs bulk role-screen stage -- has it been renamed or restructured?');

      const unscreenedAt = stage.indexOf('const roleUnscreened = deduped.filter(job => !job?.roleScreen);');
      const guardAt = stage.indexOf('if (roleScreenTitles.length > 0 && roleUnscreened.length > 0) {', unscreenedAt);
      const callAt = stage.indexOf('const roleScreen = await screenJobRolesByTitle({', guardAt);
      const jobsArgAt = stage.indexOf('jobs: roleUnscreened,', callAt);
      const rebuildAt = stage.indexOf('roleScreened = mergeRoleScreenedJobs(', jobsArgAt);
      assert(unscreenedAt >= 0 && guardAt > unscreenedAt && callAt > guardAt && jobsArgAt > callAt && rebuildAt > jobsArgAt,
        'the screen must be gated on rows lacking a roleScreen stamp (roleUnscreened), and that filtered set -- not the full deduped pool -- must be what is sent to screenJobRolesByTitle');
      // The old bug sent the full pool directly; assert that shape is gone
      // from the call args (this must fail against the pre-fix source, where
      // there was no roleUnscreened variable and the full pool was
      // passed straight through).
      assert(!stage.includes('jobs: deduped,'),
        'the full (unfiltered) deduped pool must never be passed directly as the screen\'s `jobs` argument');

      const rebuildBlockEnd = stage.indexOf('roleDropped = Number(roleScreen?.counts?.dropped)', rebuildAt);
      const rebuild = stage.slice(rebuildAt, rebuildBlockEnd);
      assert(rebuild.includes('mergeRoleScreenedJobs(deduped, roleScreen)')
        && !rebuild.includes('sourceJobKey('),
      'the rebuild must consume the screen\'s positional verdicts instead of joining through non-global provider ids');

      const alreadyScreened = {
        source: 'saved', jobkey: 'duplicate-native-id', title: 'Saved engineer',
        roleScreen: { outcome: 'match', reason: '' },
      };
      const dropped = { source: 'alpha', jobkey: 'duplicate-native-id', title: 'Nurse' };
      const accepted = { source: 'beta', jobkey: 'duplicate-native-id', title: 'Engineer' };
      const merged = mergeRoleScreenedJobs(
        [alreadyScreened, dropped, accepted],
        { verdictsByIndex: {
          0: { outcome: 'mismatch', reason: 'registered nurse role' },
          1: { outcome: 'match', reason: '' },
        } },
      );
      assert(merged.length === 2
        && merged[0] === alreadyScreened
        && merged[1].source === 'beta'
        && merged[1].roleScreen?.outcome === 'match',
      `same native ids across sources must not cross-apply a drop or stamp, got ${JSON.stringify(merged)}`);

      return { unscreenedFilterGates: true, positionalMerge: true, duplicateNativeIdsSafe: true };
    },
  },
  {
    name: 'seen history never records a preference-filtered listing',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-preference-history-'));
      const canvasPath = path.join(root, 'workspace.json');
      try {
        const result = await appendJobsHistory(canvasPath, [
          { source: 'example', company: 'Acme', title: 'Accepted', location: 'Remote', url: 'https://example.test/accepted' },
          { source: 'example', company: 'Acme', title: 'Filtered', location: 'Remote', url: 'https://example.test/filtered', preferenceAssessment: { status: 'filtered' } },
        ]);
        const history = await fs.promises.readFile(`${canvasPath.replace(/\.json$/i, '')}.jobs-history.csv`, 'utf8');
        assert(result.written === 1 && result.preferenceFilteredSkipped === 1
          && history.includes('Accepted') && !history.includes('Filtered'),
        'strict-preference rejections are never converted into durable seen-history rows');
        return { written: result.written, filtered: result.preferenceFilteredSkipped };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'job run staging: every renderer terminal path awaits durable finalization before publishing done',
    run: async () => {
      const source = await fs.promises.readFile(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8');
      const awaited = source.match(/await completeJobRun\(/g) || [];
      assert(awaited.length >= 6,
        `expected every known terminal job-run path to await finalization, found only ${awaited.length}`);
      assert(!source.includes('void completeJobRun('),
        'terminal job-run finalization must not be fire-and-forget after a hub has published done');

      const contracts = [
        ['scored settlement', 'const completion = completeRun && jobRunId', 'updateGlobal(id, {'],
        ['post-search zero', "? await completeJobRun(jobRunId, 'completed', 'zero', cfp, 0, moduleFingerprint([]), cancelled)", 'updateGlobal(currentId, {'],
        ['preference-filtered zero', "? await completeJobRun(searchResult.runId, 'completed', 'preference-filtered', canvasFilePath, 0, moduleFingerprint([]), cancelled)", 'updateGlobal(currentId, {'],
        ['collection-only', "? await completeJobRun(searchResult.runId, 'completed', 'collection-only', canvasFilePath, 0, moduleFingerprint([]), cancelled)", 'updateGlobal(currentId, {'],
        ['paused zero', "? await completeJobRun(activeJobRunId, 'completed', 'zero', canvasFilePath, 0, moduleFingerprint([]), cancelled)", 'updateGlobal(id, {'],
      ];
      for (const [label, awaitMarker, doneMarker] of contracts) {
        const begin = source.indexOf(awaitMarker);
        const done = begin >= 0 ? source.indexOf(doneMarker, begin) : -1;
        assert(begin >= 0 && done > begin,
          `${label} must await the receipt/cleanup transaction before it publishes its terminal hub state`);
        const section = source.slice(begin, done);
        assert(section.includes('if (cancelled())'),
          `${label} must discard a stale terminal update when Reset/unmount lands during finalization`);
      }
      assert(source.includes('function terminalFinalizationError(')
        && source.includes('Recovery data was kept; see Job Recovery Diagnostics'),
      'a failed durable finalization must be explicitly surfaced while its sidecars remain recoverable');
      return { awaitedTerminalPaths: awaited.length };
    },
  },
  {
    name: 'job run staging: renderer advances the completion anchor only after the matching successful terminal receipt',
    run: async () => {
      const source = await fs.promises.readFile(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8');
      const backend = await fs.promises.readFile(path.resolve('electron/ipc/jobs.js'), 'utf8');

      const completionStart = source.indexOf('const completeJobRun = useCallback');
      const stagingStart = source.indexOf('const recordCollectionCompletion = useCallback', completionStart);
      const stagingEnd = source.indexOf('const retryTerminalFinalization = useCallback', stagingStart);
      assert(completionStart >= 0 && stagingStart > completionStart && stagingEnd > stagingStart,
        'the renderer must keep terminal finalization and collection-completion staging as explicit neighboring transactions');
      const completion = source.slice(completionStart, stagingStart);
      const staging = source.slice(stagingStart, stagingEnd);

      // A successful provider response records only a run-scoped pending
      // candidate. It must not bless that timestamp as the durable anchor
      // while scoring and the backend completion receipt can still fail.
      assert(staging.includes('pendingCollectionCompletion: {')
        && staging.includes('runId: searchResult?.runId || null,')
        && staging.includes('collectionStartedAt,')
        && staging.includes('collectionCompletedAt,')
        && !staging.includes('lastCompletedRunAt'),
      'collection settlement must stage the exact run/timestamp without advancing lastCompletedRunAt');
      const freshPipelineStart = source.indexOf('const runPipeline = useCallback');
      const searchResultAt = source.indexOf('const searchResult = await window.electronAPI.searchJobs({', freshPipelineStart);
      const stageCallAt = source.indexOf('recordCollectionCompletion(searchResult, cancelled);', searchResultAt);
      const lastFailureGuardAt = source.lastIndexOf('if (!searchResult.success) {', stageCallAt);
      const failureThrowAt = source.indexOf("throw new Error(searchResult.error || 'Job search failed');", lastFailureGuardAt);
      assert(freshPipelineStart >= 0 && searchResultAt > freshPipelineStart
        && lastFailureGuardAt > searchResultAt && failureThrowAt > lastFailureGuardAt
        && stageCallAt > failureThrowAt,
      'only a successful search response may stage pendingCollectionCompletion');
      const freshSearchPayload = source.slice(searchResultAt, stageCallAt);
      const searchHandlerStart = backend.indexOf("handleSafe('search-jobs'");
      assert(freshSearchPayload.includes('initialLookbackDays: initialJobSearchLookbackDays(laneTurnData)')
        && freshSearchPayload.includes('searchWindow: runSearchWindow')
        && searchHandlerStart >= 0
        && backend.slice(searchHandlerStart, searchHandlerStart + 7_000).includes('initialLookbackDays = null')
        && backend.slice(searchHandlerStart, searchHandlerStart + 7_000).includes('searchWindow: requestedSearchWindow = null')
        && backend.slice(searchHandlerStart, searchHandlerStart + 7_000).includes('authoritativeFreshJobSearchWindow(')
        && backend.includes("const appliedInitialLookbackDays = !resume"),
      'the renderer must send its persisted first-scan range and frozen window, and the fresh IPC handler must validate and apply both');

      // A missing/failed receipt returns before reading the pending candidate.
      // Even a good receipt can commit only a completed terminal status for
      // the same backend run token and a valid completion timestamp.
      const failedGuardAt = completion.indexOf('if (failed) {');
      const pendingReadAt = completion.indexOf('const pendingCompletion = node?.data?.pendingCollectionCompletion;');
      const failedBranch = completion.slice(failedGuardAt, pendingReadAt);
      const completedGuardAt = completion.indexOf("terminalStatus === 'completed'", pendingReadAt);
      const matchingRunGuardAt = completion.indexOf('pendingCompletion?.runId === runId', completedGuardAt);
      const validTimestampGuardAt = completion.indexOf('normalizeCompletionTimestamp(pendingCompletion.collectionCompletedAt) != null', matchingRunGuardAt);
      const guardedCommitAt = completion.indexOf('if (commitsSuccessfulCollection) {', validTimestampGuardAt);
      const anchorWriteAt = completion.indexOf('patch.lastCompletedRunAt = normalizeCompletionTimestamp(pendingCompletion.collectionCompletedAt);', guardedCommitAt);
      const coverageWriteAt = completion.indexOf('patch.lastSearchCoverageStartedAt = normalizeCompletionTimestamp(', anchorWriteAt);
      const pendingClearAt = completion.indexOf('patch.pendingCollectionCompletion = null;', coverageWriteAt);
      assert(failedGuardAt >= 0 && pendingReadAt > failedGuardAt
        && failedBranch.includes('return')
        && completedGuardAt > pendingReadAt
        && matchingRunGuardAt > completedGuardAt
        && validTimestampGuardAt > matchingRunGuardAt
        && guardedCommitAt > validTimestampGuardAt
        && anchorWriteAt > guardedCommitAt
        && coverageWriteAt > anchorWriteAt
        && pendingClearAt > coverageWriteAt
        && !completion.includes('nextSearchWindowMode'),
      'failed, non-completed, mismatched, or malformed completion candidates must not advance either durable anchor; successful completion preserves the automatic historical baseline');
      assert((completion.match(/patch\.lastCompletedRunAt\s*=/g) || []).length === 1
        && (completion.match(/patch\.lastSearchCoverageStartedAt\s*=/g) || []).length === 1
        && (completion.match(/patch\.pendingCollectionCompletion\s*=\s*null/g) || []).length === 1,
      'the matching completed-run guard must be the sole completion and coverage-anchor commit site');

      const receiptCheckAt = completion.indexOf("if (completionCanvasFilePath && (result?.ok !== true || result?.cleared !== true)) {");
      const failedReceiptAt = completion.indexOf('recordFinalizationState(true);', receiptCheckAt);
      const successfulReceiptAt = completion.indexOf('recordFinalizationState(false);', failedReceiptAt);
      assert(receiptCheckAt >= 0 && failedReceiptAt > receiptCheckAt && successfulReceiptAt > failedReceiptAt
        && completion.slice(failedReceiptAt, successfulReceiptAt).includes('} else {')
        && (completion.match(/recordFinalizationState\(false\)/g) || []).length === 1,
      'a saved canvas may enter the completion-anchor commit branch only after an ok receipt with confirmed sidecar cleanup');

      // Both ways of abandoning an old generation must drop its staged
      // candidate while leaving lastCompletedRunAt untouched: admission of a
      // new run and the user-facing Reset action.
      const freshSetupStart = source.indexOf('// Destructive fresh-run setup belongs after queue admission.', freshPipelineStart);
      const freshSetupEnd = source.indexOf('// Step 3: Search', freshSetupStart);
      const freshSetup = source.slice(freshSetupStart, freshSetupEnd);
      const resetStart = source.indexOf('const resetHandler = useCallback');
      const resetEnd = source.indexOf('const handleRerun = useCallback', resetStart);
      const reset = source.slice(resetStart, resetEnd);
      const clearCareerStart = source.indexOf('const handleClearCareerFiles = useCallback');
      const clearCareerEnd = source.indexOf('const isProcessing = PROCESSING_STATES.includes(hubState);', clearCareerStart);
      const clearCareer = source.slice(clearCareerStart, clearCareerEnd);
      assert(freshSetupStart >= 0 && freshSetupEnd > freshSetupStart
        && freshSetup.includes('pendingCollectionCompletion: null,'),
      'a newly admitted fresh scan must discard a failed predecessor\'s staged completion candidate');
      assert(resetStart >= 0 && resetEnd > resetStart
        && reset.includes('pendingCollectionCompletion: null,'),
      'Reset must clear pendingCollectionCompletion when it discards results');
      assert(clearCareerStart >= 0 && clearCareerEnd > clearCareerStart
        && clearCareer.includes('pendingCollectionCompletion: null,')
        && clearCareer.includes('searchWindow: null,')
        && !clearCareer.includes('nextSearchWindowMode')
        && !clearCareer.includes('lastCompletedRunAt: null,')
        && !clearCareer.includes('lastSearchCoverageStartedAt: null,'),
      'Clear career data must discard the staged candidate and run-window metadata while preserving durable history for the automatic next scan');

      return {
        stagesAfterSuccess: true,
        receiptGated: true,
        runMatched: true,
        resetClearsPending: true,
        careerClearClearsPending: true,
      };
    },
  },
  {
    name: 'jobs history: persisted sidecar is private and failed atomic replacement leaves no temporary files',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-jobs-history-private-'));
      const canvasPath = path.join(root, 'workspace.json');
      try {
        const result = await appendJobsHistory(canvasPath, [{
          source: 'indeed', company: 'Acme', title: 'Platform Engineer', location: 'Toronto, ON',
          url: 'https://ca.indeed.com/rc/clk?jk=private-history',
        }]);
        const historyPath = path.join(root, 'workspace.jobs-history.csv');
        const mode = (await fs.promises.stat(historyPath)).mode & 0o777;
        const entries = await fs.promises.readdir(root);
        assert(result.written === 1, `history write should persist the listing, got ${JSON.stringify(result)}`);
        assert((mode & 0o077) === 0, `history sidecar must not be group/world-readable, mode=${mode.toString(8)}`);
        assert(!entries.some(name => name.includes('.jobs-history.csv.') && name.endsWith('.tmp')),
          `history write must clean temporary sidecars, got ${entries.join(', ')}`);
        await fs.promises.rm(historyPath);
        // Make the final rename fail only after atomicWriteHistory has created
        // its private exclusive temporary file. appendJobsHistory is best
        // effort, so callers receive a diagnostic result rather than an error.
        await fs.promises.mkdir(historyPath);
        const failed = await appendJobsHistory(canvasPath, [{
          source: 'indeed', company: 'Acme', title: 'Second listing', location: 'Toronto, ON',
          url: 'https://ca.indeed.com/rc/clk?jk=failed-history',
        }]);
        const afterFailure = await fs.promises.readdir(root);
        assert(typeof failed.error === 'string' && failed.written === 0,
          `a failed destination rename must be reported without throwing, got ${JSON.stringify(failed)}`);
        assert(!afterFailure.some(name => name.includes('.jobs-history.csv.') && name.endsWith('.tmp')),
          `failed history promotion must clean its exclusive temp, got ${afterFailure.join(', ')}`);
        return { mode: mode.toString(8), failedRenameCleaned: true };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Phase A titles: normalizeJobPreferencePlan keeps up to 20 titles',
    run: async () => {
      // cleanArray's own default maxItems is 8 (see jobPreferences.js). Prove
      // the titles field was given an EXPLICIT 20 rather than inheriting that
      // default — the trap the task description calls out by name. 15 titles
      // in, all 15 must survive; a default-capped normalizer would silently
      // truncate to 8.
      const fifteenTitles = Array.from({ length: 15 }, (_, i) => `Role Variant ${i}`);
      const normalized = normalizeJobPreferencePlan({
        version: 1, summary: '', direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false },
        softPreferences: [], strictRequirements: [], warnings: [],
        titles: fifteenTitles,
      });
      assert(normalized.titles.length === 15, `all 15 titles must survive normalization (cleanArray default cap of 8 must be overridden), got ${normalized.titles.length}`);
      assert(normalized.titles[14] === 'Role Variant 14', 'title order and content are preserved through normalization');

      // Feeding the schema's own cap (20) plus one extra past it proves the
      // explicit 20 is honored as a ceiling too, not just raised arbitrarily.
      const twentyTwoTitles = Array.from({ length: 22 }, (_, i) => `Extra Role ${i}`);
      const cappedAt20 = normalizeJobPreferencePlan({ ...blankJobPreferencePlan(), titles: twentyTwoTitles });
      assert(cappedAt20.titles.length === 20, `titles must still cap at 20 (the schema's malformed-response tripwire), got ${cappedAt20.titles.length}`);

      // SINGLE MODE deleted titleSource entirely — the two-mode 'brief'-
      // verbatim-gate/'generated'-gate-off split, and with it the
      // deterministic brief-traceability check that used to run inside
      // validateJobPreferencePlanSubmission, are both gone. A blank plan must
      // carry no trace of the retired field at all, not merely a default
      // value for it.
      assert(blankJobPreferencePlan().titles.length === 0 && !Object.hasOwn(blankJobPreferencePlan(), 'titleSource'),
        'a blank plan carries an empty title list and no titleSource field whatsoever');

      return { keptAt15: normalized.titles.length, cappedAt20: cappedAt20.titles.length };
    },
  },
  {
    name: 'settingConflicts: normalizes valid entries, caps at 6, and a malformed entry is DROPPED rather than throwing',
    run: async () => {
      // A settingConflicts entry needs all three fields (wrote/setting/
      // resolution) and `setting` must be one of the five behavior keys the UI
      // can map straight to a control or automatic policy. A plan missing the
      // key entirely (an older manifest, predating this field) must still
      // normalize cleanly to an empty array — see blankJobPreferencePlan.
      const blank = blankJobPreferencePlan();
      assert(Array.isArray(blank.settingConflicts) && blank.settingConflicts.length === 0,
        `blankJobPreferencePlan must carry an empty settingConflicts array, got ${JSON.stringify(blank.settingConflicts)}`);

      const validEntry = { wrote: 'LOCATION: Toronto only', setting: 'searchLocation', resolution: 'Set Search location to Toronto instead of writing it in the brief.' };
      const normalizedValid = normalizeJobPreferencePlan({ ...blank, settingConflicts: [validEntry] });
      assert(normalizedValid.settingConflicts.length === 1
        && normalizedValid.settingConflicts[0].wrote === validEntry.wrote
        && normalizedValid.settingConflicts[0].setting === 'searchLocation'
        && normalizedValid.settingConflicts[0].resolution === validEntry.resolution,
      `a well-formed entry must normalize through unchanged, got ${JSON.stringify(normalizedValid.settingConflicts)}`);

      // Cap at 6: normalizeSettingConflicts slices the raw input to the first
      // 6 entries before validating, so 8 distinct valid entries must yield
      // exactly the first 6, in order — never 7 or 8, and never silently
      // reordered.
      const eightEntries = Array.from({ length: 8 }, (_, i) => ({
        wrote: `brief text ${i}`, setting: 'searchLocation', resolution: `resolution ${i}`,
      }));
      const cappedAt6 = normalizeJobPreferencePlan({ ...blank, settingConflicts: eightEntries });
      assert(cappedAt6.settingConflicts.length === 6
        && cappedAt6.settingConflicts[0].wrote === 'brief text 0'
        && cappedAt6.settingConflicts[5].wrote === 'brief text 5',
      `settingConflicts must cap at 6 and keep the first 6 in order, got ${JSON.stringify(cappedAt6.settingConflicts.map(c => c.wrote))}`);

      // A malformed entry (unrecognized `setting` enum value, or a missing
      // required field) must be DROPPED, not thrown: settingConflicts is
      // pure advisory and an advisory must never block a search. Assert this
      // explicitly by mixing one bad entry into an otherwise-valid batch and
      // confirming (a) no exception is thrown and (b) only the good entries
      // survive.
      const mixedBatch = [
        { wrote: 'good one', setting: 'searchWindow', resolution: 'Use Look back before the first scan; later windows are automatic.' },
        { wrote: 'only jobs from this week', setting: 'maxAgeDays', resolution: 'This retired setting must be dropped.' },
        { wrote: '', setting: 'searchLocation', resolution: 'Missing wrote text, should be dropped.' },
        { wrote: 'missing resolution', setting: 'enabledSourceIds', resolution: '' },
        { setting: 'collectionLimits', resolution: 'Entirely missing wrote key, should be dropped.' },
        { wrote: 'good two', setting: 'remoteResidences', resolution: 'Use Remote salary residences instead.' },
      ];
      let mixedThrew = false;
      let mixedResult = null;
      try {
        mixedResult = normalizeJobPreferencePlan({ ...blank, settingConflicts: mixedBatch });
      } catch { mixedThrew = true; }
      assert(!mixedThrew, 'a malformed settingConflicts entry must never throw out of normalization — an advisory must never block a search');
      assert(mixedResult.settingConflicts.length === 2
        && mixedResult.settingConflicts.every(c => c.wrote === 'good one' || c.wrote === 'good two'),
      `only the well-formed entries must survive, the malformed ones silently dropped, got ${JSON.stringify(mixedResult.settingConflicts)}`);

      let capturedPrompt = '';
      const recencyOnly = await interpretJobPreferences({
        jobPreferences: 'Only include jobs posted this week.',
        profile: {},
        careerData: '',
        callText: async (prompt) => {
          capturedPrompt = prompt;
          return {
            ...blank,
            settingConflicts: [{
              wrote: 'posted this week',
              setting: 'searchWindow',
              resolution: 'Use Look back before the first scan; later windows are automatic.',
            }],
          };
        },
      });
      assert(capturedPrompt.includes('Recency/date-window prose MUST go ONLY to settingConflicts with setting="searchWindow"')
        && capturedPrompt.includes('NEVER also put it in direction, softPreferences, or strictRequirements')
        && recencyOnly.preferencePlan.settingConflicts[0]?.setting === 'searchWindow'
        && recencyOnly.preferencePlan.softPreferences.length === 0
        && recencyOnly.preferencePlan.strictRequirements.length === 0,
      'posting-date prose must be routed only to the dedicated searchWindow advisory, never into evidence-based preference filtering');

      // Entirely absent settingConflicts key (a plan built before this field
      // existed) must normalize to [] rather than reject the whole plan.
      const legacyPlan = { ...blank };
      delete legacyPlan.settingConflicts;
      const legacyNormalized = normalizeJobPreferencePlan(legacyPlan);
      assert(Array.isArray(legacyNormalized.settingConflicts) && legacyNormalized.settingConflicts.length === 0,
        'a plan predating settingConflicts must normalize the missing key to an empty array');

      return { validKept: 1, cappedAt6: cappedAt6.settingConflicts.length, malformedDropped: mixedBatch.length - mixedResult.settingConflicts.length, recencyAdvisoryOnly: true };
    },
  },
  {
    name: 'settingConflicts: a plan with a valid settingConflicts array passes validateJobPreferencePlanSubmission, but a non-array value at the top level fails closed',
    run: () => {
      // hasValidRawPlanShape is deliberately asymmetric for this field (see
      // its own comment in jobPreferences.js): an individual malformed ENTRY
      // is silently dropped by normalization (proved above), but the
      // top-level `settingConflicts` VALUE itself, when present, must still
      // be an array — a non-array here signals a genuinely malformed wire
      // payload (not just one bad advisory item) and must reject the whole
      // plan, the same as a malformed `titles` or `warnings` value would.
      const base = {
        version: 1, summary: '', direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false },
        softPreferences: [], strictRequirements: [], warnings: [],
        titles: [],
      };
      const validPlan = {
        ...base,
        settingConflicts: [{ wrote: 'REMOTE: must pay Bay Area rate', setting: 'remoteResidences', resolution: 'Set Remote salary residences instead of writing it in the brief.' }],
      };
      const validated = validateJobPreferencePlanSubmission(validPlan);
      assert(validated.settingConflicts.length === 1 && validated.settingConflicts[0].setting === 'remoteResidences',
        `a plan with a valid settingConflicts array must pass validation and survive intact, got ${JSON.stringify(validated.settingConflicts)}`);

      let nonArrayRejected = false;
      try {
        validateJobPreferencePlanSubmission({ ...base, settingConflicts: 'not an array' });
      } catch { nonArrayRejected = true; }
      assert(nonArrayRejected, 'a settingConflicts value that is present but not an array must fail hasValidRawPlanShape and reject the whole plan, not silently coerce to []');

      // A plan simply missing the key altogether (not malformed, just absent
      // — the older-manifest case) must still validate successfully.
      const missingKeyPlan = { ...base };
      const missingKeyValidated = validateJobPreferencePlanSubmission(missingKeyPlan);
      assert(Array.isArray(missingKeyValidated.settingConflicts) && missingKeyValidated.settingConflicts.length === 0,
        'a plan missing settingConflicts altogether must still validate, normalizing to an empty array');

      return { validPassed: true, nonArrayRejected, missingKeyPassed: true };
    },
  },
  {
    name: 'generate-job-queries ladder: a brief-resolved title list searches those titles directly, with no exploratory model call',
    run: async () => {
      registerJobsHandlers();
      const generateJobQueries = ipcMain.__getInvokeHandler('generate-job-queries');
      const sender = {
        id: 66_010,
        isDestroyed: () => false,
        once: () => {},
        on: () => {},
        removeListener: () => {},
        send: () => {},
      };
      // 'Toronto, ON' resolves its country code deterministically inside
      // resolveJobSearchLocation without a model call (a recognized Canadian
      // subdivision), so this test never depends on the manual-AI handoff.
      // generate-job-queries takes no injectable callText/callRaw of its own
      // (it calls the real nonApiAi module directly) — every plan below is
      // therefore built to be independently VALID so the handler's own
      // isValidJobPreferencePlanSubmission check never falls through to a
      // real interpretation/exploration call, rather than relying on a mock
      // that would throw if reached.

      // RUNG 2: no legacy targetRole, but the Job Preferences plan already
      // resolved `titles`. A duplicate-by-case entry proves the ladder's own
      // flattenJobSearchQueries dedup pass actually ran, not just a raw
      // pass-through. (No blank entry here: hasValidRawPlanShape requires
      // every submitted title to be a non-empty bounded string, so a validly-
      // shaped plan reaching this rung can never contain one — blank-stripping
      // is jobPreferences.js's normalizeJobPreferencePlan/cleanArray job, at
      // the interpretation boundary, not this handler's.)
      const titlesPlan = {
        version: 1, summary: '', direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false },
        softPreferences: [], strictRequirements: [], warnings: [],
        titles: ['Software Engineer', '  software engineer  ', 'Data Scientist'],
      };
      const rung2 = await generateJobQueries({ sender }, {
        profile: {}, careerData: '', targetRole: '', preferredLocation: 'Toronto, ON',
        jobPreferences: '', preferencePlan: titlesPlan,
      }, undefined);
      assert(rung2.success === true, `rung 2 must succeed, got ${JSON.stringify(rung2)}`);
      assert(rung2.queryModel === null, 'a brief-resolved title list must not spend a model call generating query variations');
      assert(JSON.stringify(rung2.queries.targetRoleQueries) === JSON.stringify(['Software Engineer', 'Data Scientist']),
        `titles must be searched verbatim (case-insensitive deduped, blanks dropped), got ${JSON.stringify(rung2.queries)}`);
      assert(rung2.queries.titleQueries.length === 0 && rung2.queries.suggestedRoleQueries.length === 0 && rung2.queries.skillsOnlyQueries.length === 0,
        'a titles-driven bundle carries no exploratory query groups');
      // A recognized-subdivision location (e.g. "Toronto, ON") resolves its
      // countryCode deterministically inside resolveJobSearchLocation without
      // a model call, returning only canonicalLocation (no canonicalCountry —
      // that field is populated only by the model-resolved branch). Asserting
      // canonicalLocation here still proves location resolution ran for a
      // titles-driven bundle exactly like it does for the target-role bundle.
      assert(rung2.canonicalLocation === 'Toronto, Ontario, Canada' && rung2.canonicalCountry === '',
        `location resolution still runs for a titles-driven bundle, got ${JSON.stringify({ canonicalLocation: rung2.canonicalLocation, canonicalCountry: rung2.canonicalCountry })}`);

      // RUNG 1 still wins over rung 2 when BOTH a legacy targetRole and a
      // titles-bearing plan are present — this is exactly the back-compat
      // guarantee: an old renderer/manifest that only ever sent `targetRole`
      // must keep taking the original single-exact-query path, unchanged,
      // even now that a titles-producing plan sits right next to it.
      const rung1 = await generateJobQueries({ sender }, {
        profile: {}, careerData: '', targetRole: 'Product Manager', preferredLocation: 'Toronto, ON',
        jobPreferences: '', preferencePlan: titlesPlan,
      }, undefined);
      assert(rung1.success === true, `rung 1 must succeed, got ${JSON.stringify(rung1)}`);
      assert(rung1.queryModel === null, 'the legacy exact-target-role path must not spend a model call either');
      assert(JSON.stringify(rung1.queries) === JSON.stringify(buildExactTargetRoleQueryBundle('Product Manager')),
        `a set targetRole must still win the ladder and reproduce the exact legacy single-query bundle, got ${JSON.stringify(rung1.queries)}`);

      // Back-compat: a bare legacy targetRole with NO preference plan at all
      // (the shape every pre-Phase-A caller sent) must still work exactly as
      // before — same bundle, no AI call.
      const legacyOnly = await generateJobQueries({ sender }, {
        profile: {}, careerData: '', targetRole: 'Backend Engineer', preferredLocation: 'Toronto, ON',
      }, undefined);
      assert(legacyOnly.success === true && legacyOnly.queryModel === null
        && JSON.stringify(legacyOnly.queries) === JSON.stringify(buildExactTargetRoleQueryBundle('Backend Engineer')),
      `a legacy caller supplying only targetRole (no preferencePlan/jobPreferences at all) must gate identically to pre-Phase-A behaviour, got ${JSON.stringify(legacyOnly)}`);

      return { rung2NoModelCall: true, rung1PrecedesRung2: true, legacyBackCompat: true };
    },
  },
  {
    name: 'REGRESSION: generate-job-queries and buildJobAnalysisSnapshot both trust a validly-shaped plan via the one-argument isValidJobPreferencePlanSubmission, rather than nulling or re-interpreting it',
    run: async () => {
      // SINGLE MODE deleted the old titleSource='brief' verbatim-traceability
      // check outright, and with it the second `briefText` argument
      // isValidJobPreferencePlanSubmission/validateJobPreferencePlanSubmission
      // used to take (see jobPreferences.js) — validation is plan-shape-only
      // now. The original bug this test pinned (three electron/ipc/jobs.js
      // call sites omitting that second argument, which made every
      // brief-sourced plan look invalid and triggered an unwanted
      // re-interpretation or a nulled-out persisted plan) cannot recur now
      // that the argument itself no longer exists. What remains worth
      // guarding: both call sites below must still TRUST a validly-shaped
      // plan outright — never silently re-interpret or null it out.
      registerJobsHandlers();
      const generateJobQueries = ipcMain.__getInvokeHandler('generate-job-queries');
      const sender = {
        id: 66_030,
        isDestroyed: () => false,
        once: () => {},
        on: () => {},
        removeListener: () => {},
        send: () => {},
      };
      const briefText = 'I am looking for a Software Engineer role at a large company.';
      const validPlan = {
        version: 1, summary: '', direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false },
        softPreferences: [], strictRequirements: [], warnings: [],
        titles: ['Software Engineer'],
      };
      // generate-job-queries has no injectable callText/callRaw of its own
      // (see the Phase A ladder test above) — if the handler wrongly treated
      // this plan as invalid and fell through to a real re-interpretation or
      // exploratory call, it would reach the real (unmocked) manual-AI
      // transport, which this test never provides an answer for. A hang/
      // rejection there is itself part of the regression signal, on top of
      // the explicit assertions below.
      const result = await generateJobQueries({ sender }, {
        profile: {}, careerData: '', targetRole: '', preferredLocation: 'Toronto, ON',
        jobPreferences: briefText, preferencePlan: validPlan,
      }, undefined);
      assert(result.success === true, `a validly-shaped plan must resolve without error, got ${JSON.stringify(result)}`);
      assert(result.queryModel === null, 'a validated title list must not spend a model call re-interpreting the brief');
      assert(JSON.stringify(result.queries.targetRoleQueries) === JSON.stringify(['Software Engineer']),
        `the plan's own titles must be searched verbatim, got ${JSON.stringify(result.queries)}`);

      // buildJobAnalysisSnapshot's own independent isValidJobPreferencePlanSubmission
      // check (a separate call site) must likewise trust — and durably
      // persist — a valid plan rather than nulling it out as "interpret again".
      const { snapshot } = buildJobAnalysisSnapshot({
        jobs: [], profile: {}, careerData: '', jobPreferences: briefText, jobPreferencePlan: validPlan,
      });
      assert(snapshot.jobPreferencePlan !== null
        && JSON.stringify(snapshot.jobPreferencePlan.titles) === JSON.stringify(['Software Engineer']),
      `buildJobAnalysisSnapshot must persist a valid plan rather than nulling it, got ${JSON.stringify(snapshot.jobPreferencePlan)}`);

      return { queryHandlerTrustsValidPlan: true, snapshotPersistsValidPlan: true };
    },
  },
  {
    name: 'REGRESSION: the v8 targetRole→search-brief migration remains registered, and v9 (jobhub-titlesource→single-mode) is now the current schema version',
    run: async () => {
      // Cheap guard against a future migration silently renumbering over v8
      // or v9 (e.g. inserting a new step without bumping its own version, or
      // reusing an existing one) rather than appending after them. MIGRATIONS
      // itself is a module-private array (not exported), so this checks the
      // two things that ARE exported/visible: the derived
      // CURRENT_SCHEMA_VERSION, and — scoped to the MIGRATIONS array literal
      // specifically, not a loose whole-file scan — that both the v8 entry
      // (migrateMergedTargetRoleIntoBrief, untouched by the titleSource
      // deletion) and the v9 entry (migrateJobHubTitleSourceSingleMode, the
      // migration THIS round of changes added) are actually present there,
      // not merely defined-but-unregistered.
      assert(CURRENT_SCHEMA_VERSION === 9,
        `CURRENT_SCHEMA_VERSION must be 9 after the jobhub-titlesource→single-mode migration lands, got ${CURRENT_SCHEMA_VERSION}`);
      const source = await fs.promises.readFile(path.resolve('src/utils/serializationUtils.js'), 'utf8');
      const migrationsStart = source.indexOf('const MIGRATIONS = [');
      const migrationsEnd = source.indexOf('\n];', migrationsStart);
      assert(migrationsStart >= 0 && migrationsEnd > migrationsStart, 'the MIGRATIONS array literal must exist with its documented declaration');
      const migrationsBlock = source.slice(migrationsStart, migrationsEnd);
      assert(migrationsBlock.includes('{ version: 8,') && migrationsBlock.includes('migrate: migrateMergedTargetRoleIntoBrief'),
        'the v8 step must remain registered in MIGRATIONS, wired to migrateMergedTargetRoleIntoBrief, not merely exist as an unregistered function');
      assert(migrationsBlock.includes('{ version: 9,') && migrationsBlock.includes('migrate: migrateJobHubTitleSourceSingleMode'),
        'the v9 step must be registered in MIGRATIONS, wired to migrateJobHubTitleSourceSingleMode, not merely exist as an unregistered function');
      // v9 must be the LAST entry — CURRENT_SCHEMA_VERSION is derived
      // from MIGRATIONS[last].version, so a v9 entry registered anywhere
      // other than last would silently desync the two.
      const lastEntryAt = migrationsBlock.lastIndexOf('{ version:');
      assert(migrationsBlock.slice(lastEntryAt, lastEntryAt + '{ version: 9,'.length) === '{ version: 9,',
        'the v9 step must be the LAST entry in MIGRATIONS so CURRENT_SCHEMA_VERSION stays derived correctly');
      return { schemaVersion: CURRENT_SCHEMA_VERSION, v8Registered: true, v9Registered: true };
    },
  },
];
