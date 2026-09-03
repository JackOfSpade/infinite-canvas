import { __formatJobAnalysisPromptForTests, __loadJobAnalysisSnapshotForTests, assert, canRecoverGatheredRunDirectly, filterJobsByDescriptionEvidence, fs, getJobAnalysisPaths, path } from '../test-dependencies.js';
import { normalizeJobsMarkup, repairJobsMojibake } from '../../src/utils/textEncoding.js';

export default [
  {
    name: 'gathered job-run recovery bypasses scrape prerequisites only for a complete matching manifest',
    run: () => {
      const gathered = {
        stage: 'gathered',
        inputs: { queries: ['data engineer'] },
        sources: { dice: { status: 'done' }, linkedin: { status: 'done' } },
      };
      assert(canRecoverGatheredRunDirectly(gathered, ['data engineer']),
        'a gathered run with every source done and matching queries can score staged jobs without another scrape');
      assert(!canRecoverGatheredRunDirectly({ ...gathered, sources: { ...gathered.sources, linkedin: { status: 'blocked' } } }, ['data engineer'])
        && !canRecoverGatheredRunDirectly({ ...gathered, stage: 'searching' }, ['data engineer'])
        && !canRecoverGatheredRunDirectly(gathered, ['other role']),
      'blocked, incomplete, or mismatched-query manifests retain the ordinary scrape-resume path');

      const source = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
      assert(source.includes('const cache = resumeGatheredOnly ? {} : await preflight')
        && source.includes('resumeGatheredOnly\n        ? [{ manualResults: [], indeedResult: null }, []]')
        && source.includes('if (!resumeGatheredOnly && diceKept.length > 0)')
        && source.includes('if (!resumeGatheredOnly && linkedinKept.length > 0)'),
      'direct gathered recovery skips session preflight, browser/HTTP tasks, and post-gather network enrichment while the later evidence gate remains intact');
      const stagingStart = source.indexOf('const runStartedAt = Date.now();');
      const stagingEnd = source.indexOf('const stageOnPage =', stagingStart);
      const staging = source.slice(stagingStart, stagingEnd);
      assert(staging.includes('if (resumeScope) {')
        && staging.includes('if (!resumeGatheredOnly) {\n        await setJobRunStage')
        && staging.includes('} else {\n      activeRunId = `${nodeId || \'job\'}-${runStartedAt}`;\n      const startedRun = await startJobRun'),
      'gathered-only recovery remains inside the resume branch, preserving its original manifest token and staged rows instead of starting/truncating a fresh run');
      const finalizationStart = source.indexOf("jobsTelemetry.pipeline = { ...(jobsTelemetry.pipeline || {}), phase: 'finalizing-search'");
      const gatheredStage = source.indexOf("await setJobRunStage(canvasFilePath, 'gathered'", finalizationStart);
      const finalization = source.slice(finalizationStart, gatheredStage);
      assert(finalization.includes('const finalScoreSafeBySource = new Map()')
        && finalization.includes('if (!resumeGatheredOnly)')
        && finalization.includes('await recordSourcePage(canvasFilePath, {')
        && finalization.includes('const finalGatingSourceIds = new Set(')
        && finalization.includes("warning?.code === 'linkedin-rate-limited'")
        && finalization.includes("markSourceStatus(canvasFilePath, sourceId, 'blocked'"),
      'before gathered is stamped, the ledger receives final score-safe last-wins copies and any late score-gating warning changes that source to blocked');
      assert(source.includes('resumeSourceIds = Object.keys(priorSources).filter(sourceId => ACTIVE_SOURCE_ID_SET.has(sourceId))')
        && source.includes("if (JSON.stringify(priorInputs.queries || []) !== JSON.stringify(queries))")
        && source.includes('activeSourceIds = resumeSourceIds || getRunnableJobSourceIds')
        && source.includes('nodeId: state.manifest.inputs?.nodeId || null'),
      'resume validates the original query set and restores source breadth from the manifest while peek exposes its owning hub');
      const renderer = fs.readFileSync(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8');
      const resumeHandlerStart = renderer.indexOf('const handleResumeRun = useCallback');
      const resumeHandlerEnd = renderer.indexOf('if (!canResumeOffer)', resumeHandlerStart);
      const resumeHandler = renderer.slice(resumeHandlerStart, resumeHandlerEnd);
      assert(!resumeHandler.includes('Select at least one job platform before resuming')
        && renderer.includes('resumeOffer?.nodeId === id')
        && renderer.includes('info?.found && info?.resumable && info?.nodeId === id ? info : null')
        && renderer.includes('if (resumeOffer?.nodeId !== id) return;'),
      'only the owning hub exposes or can discard a recovery offer, while current platform toggles never block it');
      return { direct: true };
    },
  },
  {
    name: 'job analysis snapshots are per-canvas and accept only owned legacy fallbacks',
    run: async () => {
      const root = path.join('/tmp', `ic-snapshot-fallback-${process.pid}-${Date.now()}`);
      const canvas = path.join(root, 'canvas-a.json');
      const siblingCanvas = path.join(root, 'canvas-b.json');
      const paths = getJobAnalysisPaths(canvas, path.join(root, 'unsaved'));
      const siblingPaths = getJobAnalysisPaths(siblingCanvas, path.join(root, 'unsaved'));
      try {
        await fs.promises.mkdir(root, { recursive: true });
        assert(paths.jsonPath !== siblingPaths.jsonPath
          && paths.lastSuccessJsonPath !== siblingPaths.lastSuccessJsonPath
          && !path.basename(paths.jsonPath).includes('canvas-a'),
        'same-folder canvases use distinct non-sensitive hashed analysis filenames');
        await fs.promises.writeFile(paths.lastSuccessJsonPath, JSON.stringify({ canvasFilePath: canvas, jobs: [{ title: 'Recovered A' }] }));
        await fs.promises.writeFile(siblingPaths.lastSuccessJsonPath, JSON.stringify({ canvasFilePath: siblingCanvas, jobs: [{ title: 'Recovered B' }] }));
        let loaded = await __loadJobAnalysisSnapshotForTests(canvas);
        const siblingLoaded = await __loadJobAnalysisSnapshotForTests(siblingCanvas);
        assert(loaded.origin === 'last-success' && loaded.snapshot.jobs[0].title === 'Recovered A'
          && loaded.paths.jsonPath === paths.lastSuccessJsonPath
          && loaded.paths.promptPath === null
          && siblingLoaded.origin === 'last-success' && siblingLoaded.snapshot.jobs[0].title === 'Recovered B'
          && siblingLoaded.paths.jsonPath === siblingPaths.lastSuccessJsonPath,
        'a missing current snapshot recovers only that canvas’s populated last-success copy and returns its real JSON path without a mismatched prompt');
        await fs.promises.writeFile(paths.jsonPath, '{not json');
        loaded = await __loadJobAnalysisSnapshotForTests(canvas);
        assert(loaded.origin === 'last-success', 'a corrupt current snapshot recovers the populated last-success copy');
        const currentSnapshot = {
          canvasFilePath: canvas,
          createdAt: '2026-08-27T12:34:56.000Z',
          gatheredJobCount: 0,
          cachedPrefix: 'Candidate evidence for the current saved snapshot.',
          previewBatches: [],
          jobs: [],
        };
        await fs.promises.writeFile(paths.jsonPath, JSON.stringify(currentSnapshot));
        loaded = await __loadJobAnalysisSnapshotForTests(canvas);
        assert(loaded.origin === 'current' && loaded.snapshot.jobs.length === 0 && loaded.paths.promptPath === null,
          'a valid empty current snapshot remains authoritative over older populated data and does not expose a missing prompt');
        await fs.promises.writeFile(paths.promptPath, 'Complete AI scoring prompt — stale sibling/run content');
        loaded = await __loadJobAnalysisSnapshotForTests(canvas);
        assert(loaded.origin === 'current' && loaded.paths.promptPath === null,
          'a stale prompt beside a current snapshot is never exposed as a verified prompt');
        await fs.promises.writeFile(paths.promptPath, __formatJobAnalysisPromptForTests(currentSnapshot));
        loaded = await __loadJobAnalysisSnapshotForTests(canvas);
        assert(loaded.origin === 'current' && loaded.paths.promptPath === paths.promptPath,
          'only a current prompt whose full content matches the recovered snapshot is exposed');
        await fs.promises.rm(paths.jsonPath);
        await fs.promises.rm(paths.lastSuccessJsonPath);
        await fs.promises.writeFile(paths.legacyJsonPath, JSON.stringify({ canvasFilePath: canvas, jobs: [{ title: 'Legacy owned' }] }));
        loaded = await __loadJobAnalysisSnapshotForTests(canvas);
        assert(loaded.origin === 'legacy-current' && loaded.snapshot.jobs[0].title === 'Legacy owned'
          && loaded.paths.jsonPath === paths.legacyJsonPath
          && loaded.paths.promptPath === null,
        'an old directory-scoped snapshot remains recoverable only after it proves this canvas owns it, with no unverified legacy prompt path');
        await fs.promises.writeFile(paths.legacyJsonPath, JSON.stringify({ canvasFilePath: siblingCanvas, jobs: [{ title: 'Must not cross' }] }));
        let rejected = false;
        try { await __loadJobAnalysisSnapshotForTests(canvas); } catch (error) { rejected = error?.code === 'ENOENT'; }
        assert(rejected, 'a mismatched legacy snapshot is rejected instead of crossing canvases in the same directory');
        return { origin: loaded.origin, namespace: path.basename(paths.jsonPath).slice(0, 19) };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'job-source resume and generic Solve use the normal evidence-safe ingestion contract',
    run: () => {
      const recovered = [{
        source: 'indeed',
        title: 'Solutions Architect',
        company: 'Acme',
        url: 'https://example.test/jobs/1',
        snippet: `<p>Weâ€™re building reliable systems. ${'Detailed architecture and delivery evidence. '.repeat(14)}</p>`,
      }, {
        source: 'indeed',
        title: 'List-card placeholder',
        company: 'Acme',
        url: 'https://example.test/jobs/2',
        snippet: '',
      }];
      repairJobsMojibake(recovered);
      normalizeJobsMarkup(recovered);
      const evidence = filterJobsByDescriptionEvidence(recovered);
      assert(evidence.jobs.length === 1 && evidence.dropped.length === 1,
        'the shared cleanup/evidence contract keeps a full recovered JD and defers a blank list card');
      assert(!/<\/?p>/i.test(evidence.jobs[0].snippet),
        'recovered provider text is markup-normalized before scoring evidence is tested');

      const source = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
      const genericStart = source.indexOf("handleSafe('resolve-job-source'");
      const resumeStart = source.indexOf("handleSafe('resume-job-source'");
      const mergeStart = source.indexOf("ipcMain.handle('record-resolve-merge'", resumeStart);
      const jobSearchNode = fs.readFileSync(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8');
      const sourceCard = fs.readFileSync(path.resolve('src/nodes/JobSourceCardNode.jsx'), 'utf8');
      const generic = source.slice(genericStart, resumeStart);
      const resume = source.slice(resumeStart, mergeStart);
      assert(source.includes('salaryRangeMetadata: salaryRangeMetadata(job.salary)')
        && source.includes('salaryAnomaly,'),
      'taxonomy audit retains both universal salary-range provenance and the existing anomaly signal');
      assert(generic.includes('const descriptionEvidence = filterJobsByDescriptionEvidence(items);')
        && generic.includes('buildResolvedDescriptionWarning(')
        && generic.includes('removedItemKeys: descriptionEvidence.dropped.map(sourceJobKey).filter(Boolean)')
        && generic.includes('reconcileResolvedDescriptionRecovery(')
        && generic.includes('preloadResolvedJobList(page, sourceId, inlineExtractorJS, signal)')
        && generic.includes('partitionResolvedDescriptionRecoveryCandidates(')
        && generic.includes('nextDescriptionRecoveryGuidance(')
        && generic.includes('[sourceId]: guidanceOutcome.state')
        && generic.includes('consecutiveNoMatchPasses: guidanceOutcome.guidance.consecutiveNoMatchPasses')
        && generic.includes('buildPhysicalCardWalkPlan(providerRows, candidates)')
        && generic.includes("replaceSourceItems: sourceId === 'google' && !!sourceRecoverySnapshot")
        && !generic.includes('providerGathered: Math.max(0, Number(prior.providerGathered ?? prior.gathered ?? prior.count) || 0) + extractedRaw.length')
        && generic.includes('resolveFunnel: {')
        && generic.includes('recordJobSourceProgress(resolveProgress, { updatePipeline: false, expectedNodeId: nodeId })'),
      'generic non-LinkedIn Solve preserves its actionable warning, removes rejected rows, and records a terminal post-search progress event');
      assert(resume.includes('historyDropSamples = deduped.samples || [];')
        && resume.includes('repairJobsMojibake(items);')
        && resume.includes('normalizeJobsMarkup(items);')
        && resume.includes('const descriptionEvidence = filterJobsByDescriptionEvidence(items);')
        && resume.includes('tagJobLanguages(items);')
        && resume.includes('jobsTelemetry.resolves[sourceId] = {')
        && resume.includes('resumeFunnel: {')
        && resume.includes('providerGathered: Math.max(0, Number(prior.providerGathered ?? prior.gathered ?? prior.count) || 0) + gathered')
        && resume.includes('count: Math.max(0, Number(prior.count) || 0) + gathered')
        && resume.includes('recordJobSourceProgress(resumeProgress, { updatePipeline: false, expectedNodeId: nodeId })')
        && resume.includes('removedItemKeys: descriptionEvidence.dropped.map(sourceJobKey).filter(Boolean)'),
      'native Indeed resume records the complete funnel, history samples, evidence drops, and a terminal source event without reactivating the gather pipeline');
      const postSearchStart = jobSearchNode.indexOf('const handlePostSearchResult');
      const postSearchEnd = jobSearchNode.indexOf('if (foundJobs.length === 0)', postSearchStart);
      const postSearch = jobSearchNode.slice(postSearchStart, postSearchEnd);
      assert(postSearch.includes('const needsDescriptionRecoverySnapshot')
        && postSearch.includes("['google', 'linkedin', 'glassdoor', 'ziprecruiter'].includes(w?.sourceId)")
        && postSearch.includes('descriptionRecoveryJobs,')
        && postSearch.includes('runId: jobRunId')
        && sourceCard.includes('jobRunId,\n          secondTabUrl')
        && generic.includes('jobRunId = null')
        && generic.includes('snapshot.runId === jobRunId')
        && generic.includes('description-recovery-snapshot-stale'),
      'a Google/LinkedIn pre-score gate persists the current run recovery pool, and Resolve rejects a same-hub snapshot from another run instead of merging stale rows');
      return { kept: evidence.jobs.length, deferred: evidence.dropped.length };
    },
  },
  {
    // A Glassdoor panel-429 strands description rows exactly the way a Google
    // block does, so Solve must be able to target the stranded identities
    // instead of re-deriving candidates from the reopened page (which re-applies
    // age + history and can discard the very rows Solve was clicked to fix).
    // But the snapshot is only REQUIRED by Google: a missing/stale/row-less
    // snapshot must never wedge another source's Solve.
    name: 'description recovery targets stranded rows for every enrichment source, and only Google is blocked without a snapshot',
    run: () => {
      const jobsSource = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
      assert(jobsSource.includes("if (resolveConfig?.requiresDescriptionEnrichment) {")
        && !jobsSource.includes("if (sourceId === 'google' && canvasFilePath) {"),
      'the recovery snapshot is loaded for every source whose Solve enriches descriptions, not Google alone');
      assert(jobsSource.includes("const recoveryBlocksResolve = sourceId === 'google';")
        && jobsSource.includes('return recoveryBlocksResolve\n')
        && jobsSource.includes('if (blocked) return blocked;'),
      'only Google is hard-blocked by a missing/stale/row-less snapshot — every other source falls through to the ordinary resolve path rather than wedging on Solve');
      assert(jobsSource.includes('if (sourceRecoveryJobs.length > 0) {\n            // The recovery snapshot is already the current run')
        && !jobsSource.includes("if (sourceId === 'google' && sourceRecoveryJobs.length > 0) {"),
      'candidate selection targets the snapshot identities for any source that has them, instead of re-running age + history over the reopened page');
      assert(jobsSource.includes("replaceSourceItems: sourceId === 'google' && !!sourceRecoverySnapshot,"),
        'replaceSourceItems stays Google-only: other sources recover a visible subset and must merge, or unreached rows would look like they vanished');
      assert(!/unresolved Google listing\(s\)/.test(jobsSource)
        && jobsSource.includes('export function resolveSourceLabel(sourceId)'),
      'recovery messages name the actual source now that non-Google sources reach them');
      return { blockedSources: ['google'] };
    },
  },
];
