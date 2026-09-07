import { assert, appendJobsHistory, blankJobPreferencePlan, buildJobAnalysisSnapshot, buildJobRunCompletionReceipt, clearRun, completeRunWithReceipt, evaluateJobPreferences, fs, getJobsTelemetry, lastRunReceiptPathForCanvas, os, path, readLastRunReceipt, readRunState, readStagedJobs, sanitizeJobPreferencePlan, sanitizeJobPreferences, sanitizeLastRunReceipt, startRun, validateJobPreferenceListingSubmission, validateJobPreferencePlanSubmission, validateJobPreferenceResearchSubmission, writeLastRunReceipt } from '../test-dependencies.js';

export default [
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
        && renderer.includes('gatheredCount: (Number(data.gatheredCount) || 0) + freshJobs.length')
        && renderer.includes('Failed to save preference-filtered USAJobs snapshot')
        && renderer.includes("'preference-filtered'"),
      'append scoring and all-filtered late sources must retain preference recovery state, an accurate disposition, and source funnel volume');
      assert(renderer.includes('const activeTargetRole = String(liveData.targetRole || \'\').trim()')
        && renderer.includes('targetRole: (data.activeTargetRole ?? data.targetRole ?? \'\').trim()')
        && renderer.includes('data.pendingTargetRole ?? data.activeTargetRole ?? data.targetRole ?? \'\'')
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
        && search.includes('disabled={!!data.locked}')
        && search.includes('disabled={!!data.locked}\n                    className="w-10')
        && search.includes('disabled={!!data.locked}\n                />'),
      'empty Job Preferences controls must name Target role, explain a blank role, describe their help, and disable every editable setting when locked');
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
    name: 'job run staging: another hub cannot atomically replace an unfinished canvas run',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-job-staging-hub-conflict-'));
      const canvasPath = path.join(root, 'workspace.json');
      try {
        const first = await startRun(canvasPath, { runId: 'hub-a-run', startedAt: 1, nodeId: 'hub-a', sourceIds: ['indeed'] });
        const [b, c] = await Promise.all([
          startRun(canvasPath, { runId: 'hub-b-run', startedAt: 2, nodeId: 'hub-b', sourceIds: ['dice'] }),
          startRun(canvasPath, { runId: 'hub-c-run', startedAt: 3, nodeId: 'hub-c', sourceIds: ['remoteok'] }),
        ]);
        const state = await readRunState(canvasPath, 4);
        assert(first?.runId === 'hub-a-run'
          && b?.conflict === true && b.ownerNodeId === 'hub-a'
          && c?.conflict === true && c.ownerNodeId === 'hub-a'
          && state?.manifest?.runId === 'hub-a-run' && state.manifest.inputs?.nodeId === 'hub-a',
        'concurrent fresh starts from other hubs return a named conflict and leave the original manifest/staging owner untouched');
        return { owner: state.manifest.inputs.nodeId };
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
        const receipt = await readLastRunReceipt(canvasPath);
        const serialized = await fs.promises.readFile(lastRunReceiptPathForCanvas(canvasPath), 'utf8');
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
        assert(!remaining.includes('workspace.jobs-run.json') && !remaining.includes('workspace.jobs-staging.jsonl'),
          `terminal cleanup must remove run sidecars, got ${remaining.join(', ')}`);
        return { outcome: receipt.terminal.outcome, cleared: receipt.cleanup.cleared };
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
        const state = await readStagedJobs(canvasPath);
        const entries = await fs.promises.readdir(root);
        assert(stale.tokenMismatch && !stale.ok && !entries.includes('workspace.jobs-last-run.json'),
          `a stale completion must not write a receipt, got ${JSON.stringify(stale)} / ${entries.join(', ')}`);
        assert(entries.includes('workspace.jobs-run.json') && Array.isArray(state),
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
    name: 'job run staging: durable scoring receipt is run-scoped and redacted',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = { nodeId: telemetry.nodeId, search: telemetry.search, pipeline: telemetry.pipeline, scoring: telemetry.scoring };
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
          },
        };
        telemetry.pipeline = { runId: 'receipt-run', startedAt: 100 };
        telemetry.scoring = {
          runId: 'other-run', input: 91, selectedForScoring: 90, scored: 89,
          placeholders: 88, unscored: 1, failedBatches: 7, cappedForBudget: 1,
          providerCalls: 99, failureReason: 'MUST NOT PERSIST', jobs: [{ title: 'MUST NOT PERSIST' }],
        };
        const mismatch = sanitizeLastRunReceipt(buildJobRunCompletionReceipt('receipt-run', 200));
        assert(!Object.hasOwn(mismatch, 'scoring'),
          `completion must not borrow scoring from another run, got ${JSON.stringify(mismatch.scoring)}`);

        const hostile = sanitizeLastRunReceipt({
          runId: 'receipt-run',
          scoring: {
            input: 4, selected: 3, scored: 3, placeholders: 1, unscored: 0, failedBatches: 1,
            cappedForBudget: 1, providerCalls: 2, prompt: 'MUST NOT PERSIST',
            failureReason: 'MUST NOT PERSIST', jobs: [{ title: 'MUST NOT PERSIST' }], url: 'https://MUST-NOT-PERSIST.example',
          },
        });
        assert(JSON.stringify(hostile).includes('MUST NOT PERSIST') === false
          && Object.keys(hostile.scoring).every(key => ['input', 'selected', 'scored', 'placeholders', 'unscored', 'failedBatches', 'cappedForBudget', 'providerCalls'].includes(key)),
        `scoring sanitizer must whitelist aggregates only, got ${JSON.stringify(hostile.scoring)}`);
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
        const matched = sanitizeLastRunReceipt(buildJobRunCompletionReceipt('receipt-run', 200));
        const serialized = JSON.stringify(matched);
        assert(matched.version >= 2 && matched.scoring?.input === 4 && matched.scoring.selected === 3
          && matched.scoring.scored === 3 && matched.scoring.placeholders === 1
          && matched.scoring.unscored === 0 && matched.scoring.failedBatches === 1
          && matched.scoring.cappedForBudget === 1 && matched.scoring.providerCalls === 2
          && matched.sources?.dice?.pagesWalked === 4
          && matched.sources?.dice?.providerGathered === 190
          && matched.sources?.dice?.unavailableDetailDropped === 2
          && matched.sources?.glassdoor?.locationScopeUnenforced === true,
          `matching scoring aggregates must survive sanitization, got ${serialized}`);
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
        && fanOut.includes('const caps = [...new Map(')
        && fanOut.includes('stopReasons, pagesFetched, cap, caps }'),
      'query fan-out must aggregate Dice page counts and retain every finite extractor cap');
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
        ['lost legacy batch', "? await completeJobRun(terminalRunId, 'failed', 'incomplete')", 'updateGlobal(id, live ==='],
        ['post-search zero', "? await completeJobRun(jobRunId, 'completed', 'zero', cfp)", 'updateGlobal(currentId, {'],
        ['preference-filtered zero', "? await completeJobRun(searchResult.runId, 'completed', 'preference-filtered', canvasFilePath, 0)", 'updateGlobal(currentId, {'],
        ['collection-only', "? await completeJobRun(searchResult.runId, 'completed', 'collection-only')", 'updateGlobal(currentId, {'],
        ['paused zero', "? await completeJobRun(activeJobRunId, 'completed', 'zero')", 'updateGlobal(id, {'],
      ];
      for (const [label, awaitMarker, doneMarker] of contracts) {
        const begin = source.indexOf(awaitMarker);
        const done = begin >= 0 ? source.indexOf(doneMarker, begin) : -1;
        assert(begin >= 0 && done > begin,
          `${label} must await the receipt/cleanup transaction before it publishes its terminal hub state`);
        const section = source.slice(begin, done);
        assert(section.includes('if (cancelled()) return'),
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
