import { __getJobsTelemetryForReportForTests, __queryFanOutForTests, __resetJobsTelemetryForTests, __runWithIpcRequestContextForTests, assert, appendJobsHistory, blankJobPreferencePlan, buildJobAnalysisSnapshot, buildJobRunCompletionReceipt, careerInputFingerprint, careerProfileFingerprint, clearRun, clearRunWithResult, completeRunWithReceipt, createModuleRunQueue, evaluateJobPreferences, fs, getJobsTelemetry, ipcMain, jobRunPathScopeForCanvas, lastRunReceiptPathForCanvas, normalizeJobRunProfileFingerprint, os, path, readLastRunReceipt, readRunState, readStagedJobs, recordLinkedinResolveAttempt, recordResolveMergeOutcome, recordSourcePage, sanitizeJobPreferencePlan, sanitizeJobPreferences, sanitizeLastRunReceipt, startRun, validateExactResumeRun, validateJobPreferenceListingSubmission, validateJobPreferencePlanSubmission, validateJobPreferenceResearchSubmission, writeLastRunReceipt } from '../test-dependencies.js';
// The bug-report builders under test. test-dependencies.js already re-exports
// all three; they are imported on their own line so the shared bundle import
// above stays untouched while other sessions edit it.
import { buildJobCompletionAssessment, buildJobRecoverySnapshot, buildJobsPipelineSnapshot } from '../test-dependencies.js';
import { registerJobsHandlers } from '../../electron/ipc/jobs.js';

export default [
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
        && sourceCard.includes('if (!resolverAlive()) return;'),
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
        targetRoleConflict: false, targetRoleConflictReason: '',
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

      const groundedResearch = 'Grounded source URLs (provider metadata):\n- https://example.test/benefits — Benefits\n\nExample Co provides free lunch to employees.';
      const validResearch = {
        assessments: [{ preferenceId: 'lunch', outcome: 'confirmed', evidence: 'Benefits page confirms the meal.', evidenceQuote: 'provides free lunch to employees', sourceUrls: ['https://example.test/benefits'], sourceDate: '' }],
      };
      let foreignResearchRejected = false;
      let unsupportedResearchRejected = false;
      try {
        validateJobPreferenceResearchSubmission({ ...validResearch, assessments: [{ ...validResearch.assessments[0], preferenceId: 'other-preference' }] }, { preferenceId: 'lunch', groundedResearch });
      } catch (error) { foreignResearchRejected = error?.code === 'JOB_PREFERENCE_RESEARCH_RESPONSE_INVALID'; }
      try {
        validateJobPreferenceResearchSubmission({ ...validResearch, assessments: [{ ...validResearch.assessments[0], evidenceQuote: 'Invented benefit' }] }, { preferenceId: 'lunch', groundedResearch });
      } catch (error) { unsupportedResearchRejected = error?.code === 'JOB_PREFERENCE_RESEARCH_RESPONSE_INVALID'; }
      assert(foreignResearchRejected && unsupportedResearchRejected
        && validateJobPreferenceResearchSubmission(validResearch, { preferenceId: 'lunch', groundedResearch }) === validResearch,
      'grounded company research must return the requested preference with a quote and URL present in the prior research, rather than silently degrading a foreign or unsupported reply');

      let apiValidationSurfaced = false;
      try {
        await evaluateJobPreferences({
          jobs: [{ title: 'Program Manager', company: 'Response Validation Co' }],
          jobPreferences: 'Free lunch is required.',
          preferencePlan: {
            version: 1, summary: '', direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false },
            softPreferences: [], strictRequirements: [{ id: 'lunch', criterion: 'Free lunch', category: 'perk' }], warnings: [], targetRoleConflict: false, targetRoleConflictReason: '',
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
        warnings: [], targetRoleConflict: false, targetRoleConflictReason: '',
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

      const conflictPlan = { ...interpretedPlan, targetRoleConflict: true, targetRoleConflictReason: 'The target role is explicitly avoided.' };
      let repairedConflict = null;
      try {
        await evaluateJobPreferences({
          jobs: [{ title: 'Web Developer' }], jobPreferences: raw, targetRole: 'Web Developer',
          preferencePlan: { ...interpretedPlan, direction: 'not an object' },
          callRaw: () => { throw new Error('must stop before research'); },
          callText: async (_prompt, options) => options.task === 'job-preference-interpretation'
            ? conflictPlan
            : (() => { throw new Error('must stop before listing evaluation'); })(),
        });
      } catch (error) { repairedConflict = error; }
      assert(repairedConflict?.code === 'JOB_PREFERENCE_TARGET_ROLE_CONFLICT',
        'a target-role conflict found while repairing a plan must stop direct evaluation before listing work');

      const softItems = Array.from({ length: 12 }, (_, index) => ({ id: `soft-${index}`, criterion: `Role signal ${index}`, category: 'role' }));
      const softOrder = await evaluateJobPreferences({
        jobs: [{ title: 'Role A' }, { title: 'Role B' }], jobPreferences: 'soft ranking',
        preferencePlan: { version: 1, summary: '', direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false }, softPreferences: softItems, strictRequirements: [], warnings: [], targetRoleConflict: false, targetRoleConflictReason: '' },
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
          preferencePlan: { version: 1, summary: '', direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false }, softPreferences: [], strictRequirements: [{ id: 'lunch', criterion: 'Lunch provided', category: 'perk' }], warnings: [], targetRoleConflict: false, targetRoleConflictReason: '' },
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
          preferencePlan: { version: 1, summary: '', direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false }, softPreferences: [], strictRequirements: [{ id: 'lunch', criterion: 'Lunch provided', category: 'perk' }], warnings: [], targetRoleConflict: false, targetRoleConflictReason: '' },
          signal: lateController.signal,
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
        softPreferences: [], strictRequirements: [{ id: 'lunch', criterion: 'Free lunch', category: 'perk' }], warnings: [], targetRoleConflict: false, targetRoleConflictReason: '',
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
        if (options.signal === firstController.signal) {
          markFirstResearchStarted();
          return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
        }
        return Promise.resolve('Grounded source URLs (provider metadata):\n- https://example.test/benefits — Benefits\n\nFree lunch is provided.');
      };
      const first = evaluateJobPreferences({ jobs: [{ title: 'Program Manager', company: 'Example' }], jobPreferences: 'Lunch must be provided.', preferencePlan: companyPlan, signal: firstController.signal, callText: sharedText, callRaw: sharedRaw });
      const firstSettled = first.then(() => null, error => error);
      await firstResearchStarted;
      const second = evaluateJobPreferences({ jobs: [{ title: 'Program Manager', company: 'Example' }], jobPreferences: 'Lunch must be provided.', preferencePlan: companyPlan, signal: secondController.signal, callText: sharedText, callRaw: sharedRaw });
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
          targetRoleConflict: false,
          targetRoleConflictReason: '',
        },
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
          warnings: [], targetRoleConflict: false, targetRoleConflictReason: '',
        },
        callRaw: async () => 'Grounded source URLs (provider metadata):\n- https://example.test/benefits — Benefits\n\nThe office is downtown.',
        callText: async (_prompt, options) => options.task === 'job-preference-evaluation'
          ? { assessments: [{ index: 0, matches: [{ preferenceId: 'lunch', outcome: 'unverified', evidence: 'Not in listing.' }] }] }
          : { assessments: [{ preferenceId: 'lunch', outcome: 'confirmed', evidence: 'Model claim', evidenceQuote: 'Free lunch is provided.', sourceUrls: ['https://example.test/benefits'], sourceDate: '' }] },
      });
      const unsupportedResearchMatch = unsupportedResearch.filteredJobs[0]?.preferenceAssessment?.matches?.[0];
      assert(unsupportedResearchMatch?.outcome === 'unverified' && unsupportedResearchMatch.sourceUrls.length === 0,
        `a web verdict needs both a source URL and a verbatim grounded quote, got ${JSON.stringify(unsupportedResearchMatch)}`);
      return { blankBypassed: true, strictResearchAttempted: groundedCalls, ungroundedResearchRejected: true };
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
          && inputs.jobPreferencePlan?.targetRoleConflict === true
          && inputs.jobPreferencePlan?.targetRoleConflictReason === 'The exact target role conflicts with your request to avoid web development.'
          && !('arbitraryModelPayload' in inputs.jobPreferencePlan)
          && !('privateModelTrace' in inputs.jobPreferencePlan.direction)
          && !('raw' in inputs.jobPreferencePlan.softPreferences[0]),
        `recovery must preserve the usable plan but strip unrelated model payload, got ${JSON.stringify(inputs.jobPreferencePlan)}`);
        assert(sanitizeJobPreferencePlan({ summary: 7, direction: 'invalid' }) === null,
          'an invalid preference plan must become null so recovery safely re-interprets it');
        const conflictOnly = sanitizeJobPreferencePlan({
          targetRoleConflict: true,
          targetRoleConflictReason: 'Avoid this exact role.',
        });
        assert(conflictOnly?.targetRoleConflict === true && conflictOnly.targetRoleConflictReason === 'Avoid this exact role.',
          'a conflict-only persisted plan must not be erased as an otherwise-empty plan');
        assert(sanitizeJobPreferences(`  ${'a'.repeat(5000)}  `).length === 4000,
          'manifest persistence must cap bypassed Job Preferences input at the backend-safe length');
        return { strictRequirements: inputs.jobPreferencePlan.strictRequirements.length, recovered: true };
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
        softPreferences: [], strictRequirements: [], warnings: [], targetRoleConflict: false, targetRoleConflictReason: '',
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
    name: 'job preferences: an exact-role conflict stops before search and all-filtered completion is described as preferences',
    run: async () => {
      const [search, done] = await Promise.all([
        fs.promises.readFile(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8'),
        fs.promises.readFile(path.resolve('src/nodes/jobsearch/JobSearchDoneState.jsx'), 'utf8'),
      ]);
      const pipelineStart = search.indexOf('// Step 2: Query construction');
      const pipelineEnd = search.indexOf('// Step 3: Search', pipelineStart);
      const pipeline = search.slice(pipelineStart, pipelineEnd);
      const conflictAt = pipeline.indexOf('jobPreferencesInterpretation?.targetRoleConflict');
      const queriesAt = pipeline.indexOf('window.electronAPI.generateJobQueries');
      assert(conflictAt >= 0 && (queriesAt < 0 || conflictAt < queriesAt)
        && pipeline.includes('Your Target role conflicts with your Job Preferences'),
      'a clear Target role / Job Preferences contradiction must stop the pipeline before queries or a scrape begin');
      assert(done.includes("resultDisposition === 'preference-filtered'")
        && done.includes("${jobsLabel(count, 'job')} matched your preferences")
        && done.includes('filtered by your preferences'),
      'an all-filtered terminal state must explain that Job Preferences filtered the results, not imply a zero-result scrape');
      const resumeStart = search.indexOf('const handleResumeRun = useCallback');
      const resumeEnd = search.indexOf('const handleDiscardResume', resumeStart);
      const resume = search.slice(resumeStart, resumeEnd);
      assert(resume.includes("typeof offer.jobPreferences === 'string' ? offer.jobPreferences : ''")
        && resume.includes('offer.jobPreferencePlan ?? offer.preferencePlan ?? null')
        && !resume.includes('data.activeJobPreferences ?? data.jobPreferences')
        && resume.includes('Failed to restore Job Preferences for this resumed search')
        && resume.includes('This resumed search’s Target role conflicts with its Job Preferences'),
      'crash resume must use the manifest’s frozen preferences and safely re-interpret durable raw text only when its saved plan is unavailable');
      return { conflictBlocked: true, allFilteredCopy: true, resumePreferencesFrozen: true };
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
      assert(search.includes('Target role <span className="text-white/25">(optional)</span>')
        && search.includes('Leave blank to generate best-fit search variations.')
        && search.includes('aria-describedby={targetRoleHelpId}')
        && search.includes('aria-describedby={jobPreferencesHelpId}')
        && search.includes('const cleanupRetirementPending = hasPendingManualAiRetirement(data);')
        && search.includes('const controlsLocked = !!data.locked || !!data.queuedModuleRun || cleanupRetirementPending;')
        && search.includes('const errorControlsLocked = !!data.locked || !!data.queuedModuleRun;')
        && search.includes('disabled={controlsLocked}')
        && search.includes('disabled={controlsLocked}\n                    className="w-10')
        && search.includes('disabled={controlsLocked}\n                />')
        && search.includes('locked={errorControlsLocked}'),
      'empty Job Preferences controls must name Target role, explain a blank role, describe their help, and disable every editable setting while locked, queued, or finishing cancellation cleanup without hiding the cleanup retry action');
      assert(locations.includes('disabled = false')
        && locations.includes('disabled={disabled}'),
      'structured location inputs must honor the parent locked state rather than remaining editable');
      assert(done.includes('const jobsLabel =')
        && done.includes("jobsLabel(count, 'job')")
        && done.includes("jobsLabel(count, 'new job', 'new jobs')")
        && done.includes('ready to score')
        && done.includes('aria-describedby={targetRoleHelpId}'),
      'completed result labels must pluralize every job count and retain labeled Target role guidance before a re-run');
      assert(processing.includes('aria-label="Copy the Chrome launch command"')
        && processing.includes('role="status" aria-live="polite"')
        && processing.includes('aria-label="Cancel and reset job search"')
        && !processing.includes('onClick={handleCopy}\n          title="Click to copy"'),
      'processing controls must be keyboard-operable and communicate changing work to assistive technology');
      assert(errorBanner.includes('role="alert"') && errorBanner.includes('aria-label="Dismiss error"')
        && !/AI Preferences|AI preferences|Job Brief|job brief/.test(`${search}\n${done}`),
      'errors must announce themselves and the visible feature name must remain Job Preferences');
      return { labels: true, locked: true, counts: true, status: true };
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
          && replacement?.runId === 'hub-a-rerun' && afterRerun?.stagedJobs?.length === 0
          && bAfterAReplaced?.manifest?.runId === 'hub-b-run' && bAfterAReplaced.stagedJobs?.[0]?.job?.title === 'B',
        'each hub must have isolated jobs + manifest files, while an old token cannot write into a same-hub rerun');
        return { simultaneous: 3, sameHubRerunFenced: true };
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
        'a tokened hub cannot overwrite a parseable legacy manifest whose owner is unknown; its staged rows remain available for an explicit legacy Start fresh action');
        const deliberateLegacyClear = await clearRun(canvasPath, {
          expectedRunId: 'legacy-run', expectedOwnerUnknown: true,
        });
        const next = await startRun(canvasPath, { runId: 'new-hub-run', startedAt: 5, nodeId: 'new-hub', sourceIds: ['google'] });
        assert(deliberateLegacyClear === true && next?.runId === 'new-hub-run',
          'the explicit owner-unknown discard is token-bound and clears only a manifest that still has no hub owner, restoring a safe Start fresh path');
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
      assert(snapshot.includes('### Per-hub records (no single hub owns the funnel above)')
        && snapshot.includes('- Hub `hub-blk`')
        && snapshot.includes('- Hub `hub-ok`')
        && snapshot.includes('    - `indeed` (3 attempts):')
        && (snapshot.match(/`native-challenge`\u2192closed/g) || []).length === 3,
      `the per-hub block must render each hub's own Continue trail under its hub id, got ${snapshot.slice(0, 5000)}`);
      // Naming only whichever hub wrote telemetry last is what sent the original
      // investigation at the healthy run's preflight. Both must be attributable.
      assert(snapshot.includes('/blocked/profile') && snapshot.includes('/healthy/profile')
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
        assert(rendered.snapshot.includes('Solve passes (run `run-x`): 3 recorded · 2 rendered · ⚠️ 1 carried an outcome this report does not recognise and is not rendered.')
          && !rendered.snapshot.includes('all retained')
          && !rendered.snapshot.includes('deferred-to-next-run'),
        `an allowlist-shortened Solve trail must state both counts and mark the drop, got ${rendered.snapshot.slice(0, 4000)}`);
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
        && fanOut.includes("['jobs-per-platform', 'pages-per-platform'].includes(value?.type)")
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
        && bySource.includes("['per-platform', 'jobs-per-platform', 'pages-per-platform', 'source-internal'].includes(data.cap.type)")
        && bySource.includes('Number(data.cap.limit) > 0')
        && bySource.includes("data.stopReasons.add('jobs-per-platform')")
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
        ['lost legacy batch', "? await completeJobRun(terminalRunId, 'failed', 'incomplete', canvasFilePath, 0, moduleFingerprint([]), cancelled)", 'updateGlobal(id, live ==='],
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
];
