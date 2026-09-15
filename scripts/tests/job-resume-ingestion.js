import { __analysisPathsForCurrentRequestForTests, __createDescriptionRecoveryCheckpointForTests, __discardJobAnalysisSnapshotForTests, __discardOwnedJobRunForTests, __formatJobAnalysisPromptForTests, __getJobAnalysisRetirementStateForTests, __loadDescriptionRecoveryCheckpointForTests, __loadJobAnalysisSnapshotForTests, __removeDescriptionRecoveryCheckpointForTests, __runWithIpcRequestContextForTests, __saveDescriptionRecoverySnapshotIfCurrentForTests, __saveJobAnalysisSnapshotForTests, assessDescriptionRecoverySnapshotOwnership, assert, canRecoverGatheredRunDirectly, collectDeletedJobAnalysisDiscards, collectDeletedJobRunDiscards, createDescriptionRecoveryMutex, filterJobsByDescriptionEvidence, fs, getJobAnalysisPaths, isLiveDescriptionRecoveryRun, isSafeJobAnalysisCleanupNoop, listDescriptionRecoveryCheckpointsSync, path, readRunState, setStage, startRun } from '../test-dependencies.js';
import { normalizeJobsMarkup, repairJobsMojibake } from '../../src/utils/textEncoding.js';
import { careerFilesCleanupNeedsWarning, isJobAnalysisSnapshotAfterClear, nextJobAnalysisClearWatermark, normalizeJobAnalysisClearRunId, normalizeJobAnalysisClearWatermark } from '../../src/utils/jobAnalysisRecovery.js';
import { getJobDescriptionRecoveryCheckpointPath } from '../../electron/ipc/jobAnalysisPaths.js';
import { __extractCareerFileSectionsForTests, __recordJobSourceResumeAttemptForTests, getJobsResumeAttributionForReport, getJobsTelemetryHubCountForReport } from '../../electron/ipc/jobs.js';
import { receiptTime } from '../../electron/ipc/bugReport/jobsSnapshot.js';
import { discardDeletedJobAnalysisSnapshots, discardDeletedJobRuns } from '../../src/utils/canvasInteractions.js';
import { __canPerformJobSourceActionForTests, __canWriteJobResolveTelemetryForTests, __consumeRecoveryBlockedUrlForTests, __getJobsTelemetryForReportForTests, __recordResumeAttemptForTests, __resetJobsTelemetryForTests, __restoreJobsTelemetryIfCurrentRunForTests, getJobsTelemetry, nativeChallengeTerminalDisposition, orderedBlockedManualSourceUrls, recordLinkedinResolveAttempt, recordResolveMergeOutcome } from '../test-dependencies.js';

export default [
  {
    name: 'career-file extraction fans out independent manual handoffs, joins in drop order, and aborts siblings atomically',
    run: async () => {
      const calls = [];
      const resolvers = new Map();
      const completed = __extractCareerFileSectionsForTests(
        ['/tmp/first.pdf', '/tmp/native.md', '/tmp/third.docx'],
        {
          readPlainText: async (filePath) => filePath.endsWith('.md') ? 'NATIVE NOTES' : null,
          callDocument: (filePath, _prompt, options) => new Promise((resolve) => {
            calls.push({ filePath, options });
            resolvers.set(filePath, resolve);
          }),
        },
      );
      await new Promise(resolve => setImmediate(resolve));
      assert(calls.map(call => call.filePath).join(',') === '/tmp/first.pdf,/tmp/third.docx'
        && calls.every(call => call.options.task === 'career-file-extract' && call.options.signal instanceof AbortSignal),
      'all non-plain-text files issue their independent manual extraction handoffs before any response is awaited, while native text skips the handoff');

      // Resolve out of order: the profile corpus must remain in the drop order,
      // because both its filename headers and order participate in its cache key.
      resolvers.get('/tmp/third.docx')({ text: 'THIRD TEXT' });
      resolvers.get('/tmp/first.pdf')({ text: 'FIRST TEXT' });
      const extracted = await completed;
      assert(extracted.directTextFiles === 1 && extracted.transcribedFiles === 2
        && extracted.sections.join('\n---\n') === [
          '===== FILE: first.pdf =====\nFIRST TEXT',
          '===== FILE: native.md =====\nNATIVE NOTES',
          '===== FILE: third.docx =====\nTHIRD TEXT',
        ].join('\n---\n'),
      'parallel handoff settlements are rejoined into the exact original file order with accurate direct/transcribed telemetry');

      let siblingAbortObserved = false;
      let siblingStarted = false;
      let failure = null;
      try {
        await __extractCareerFileSectionsForTests(
          ['/tmp/empty.pdf', '/tmp/pending.docx'],
          {
            readPlainText: async () => null,
            callDocument: async (filePath, _prompt, { signal }) => {
              if (filePath.endsWith('empty.pdf')) return { text: '' };
              siblingStarted = true;
              return new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => {
                  siblingAbortObserved = true;
                  reject(signal.reason);
                }, { once: true });
              });
            },
          },
        );
      } catch (error) {
        failure = error;
      }
      assert(siblingStarted && siblingAbortObserved
        && failure?.message.includes('No text could be read from empty.pdf'),
      'an invalid file response aborts and settles every still-pending sibling handoff before the drop fails');

      const parent = new AbortController();
      let parentAbortCount = 0;
      const cancelled = __extractCareerFileSectionsForTests(
        ['/tmp/one.pdf', '/tmp/two.docx'],
        {
          signal: parent.signal,
          readPlainText: async () => null,
          callDocument: async (_filePath, _prompt, { signal }) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              parentAbortCount += 1;
              reject(signal.reason);
            }, { once: true });
          }),
        },
      );
      await new Promise(resolve => setImmediate(resolve));
      parent.abort(new Error('drop cancelled'));
      let cancellation = null;
      try { await cancelled; } catch (error) { cancellation = error; }
      assert(parentAbortCount === 2 && cancellation?.message === 'drop cancelled',
        'cancelling the parent parse task propagates to every issued extraction handoff and waits for their cleanup');
      return { parallelHandoffs: calls.length, orderedSections: extracted.sections.length, siblingAbortObserved, parentAbortCount };
    },
  },
  {
    name: 'cleared job hubs reject stale analysis snapshots and honestly classify sidecar cleanup',
    run: () => {
      const clearedAt = Date.parse('2026-09-07T12:00:00.000Z');
      assert(isJobAnalysisSnapshotAfterClear({}, { createdAt: '2026-09-07T12:00:00.001Z' }, clearedAt),
        'a snapshot written after the persisted clear watermark remains recoverable for a new run');
      for (const meta of [null, {}, { createdAt: 'not-a-date' }, { createdAt: Number.MAX_SAFE_INTEGER }, { createdAt: clearedAt }, { createdAt: clearedAt - 1 }]) {
        assert(!isJobAnalysisSnapshotAfterClear({}, meta, clearedAt),
          'after a clear, missing, invalid, out-of-Date-range, equal-time, and older snapshot timestamps must not re-offer stale recovery');
      }
      assert(isJobAnalysisSnapshotAfterClear({}, {}, null),
        'legacy hubs without a clear watermark retain their existing recovery behavior');
      const clearedRunId = 'run-cleared-at-boundary';
      assert(isJobAnalysisSnapshotAfterClear({ runId: 'run-new-at-boundary' }, { createdAt: clearedAt }, clearedAt, clearedRunId)
        && !isJobAnalysisSnapshotAfterClear({ runId: clearedRunId }, { createdAt: clearedAt }, clearedAt, clearedRunId)
        && !isJobAnalysisSnapshotAfterClear({ runId: clearedRunId }, { createdAt: clearedAt + 1 }, clearedAt, clearedRunId)
        && !isJobAnalysisSnapshotAfterClear({ runId: 'run-new-at-boundary' }, { createdAt: clearedAt }, clearedAt)
        && !isJobAnalysisSnapshotAfterClear({ runId: 'invalid run id' }, { createdAt: clearedAt }, clearedAt, clearedRunId),
      'the persisted cleared run token admits only a separately identified equal-millisecond run and still rejects the cleared run, delayed stale writes, legacy ties, and malformed tie provenance');
      assert(normalizeJobAnalysisClearRunId(' run-a:1 ') === 'run-a:1'
        && [null, false, 1, '', '  ', 'invalid run id', 'x'.repeat(201)].every(value => normalizeJobAnalysisClearRunId(value) == null),
      'clear run provenance is strict and cannot be coerced into a tie-breaker');
      assert(nextJobAnalysisClearWatermark(clearedAt, clearedAt) === clearedAt + 1
        && nextJobAnalysisClearWatermark(8_640_000_000_000_000, clearedAt) === 8_640_000_000_000_000,
      'a repeated clear advances its valid normal timestamp but never overflows the maximum JavaScript Date into a watermark that recovery would discard');
      assert(collectDeletedJobAnalysisDiscards([{
        id: 'hub-a', type: 'jobhub', data: { jobRunId: true },
      }], '/tmp/canvas.json', clearedAt)[0]?.runId === null,
      'canvas deletion clears an invalid persisted run token to the safe null boundary instead of rejecting its owned recovery cleanup');
      assert(normalizeJobAnalysisClearWatermark('1760000000000') === 1760000000000
        && [false, '', '  ', '1760000000000.5', 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER + 1].every(value => normalizeJobAnalysisClearWatermark(value) == null),
      'persisted clear watermarks accept only positive safe Date.now integers in the JavaScript Date range (or a legacy decimal string), never coercible or permanently-future values');
      assert(receiptTime('1760000000000') === '2025-10-09T08:53:20.000Z'
        && receiptTime(Number.MAX_SAFE_INTEGER) === 'not recorded',
      'receipt diagnostics format valid legacy numeric timestamps and reject an out-of-JavaScript-Date-range value without throwing');

      assert(!careerFilesCleanupNeedsWarning([
        { kind: 'analysis', status: 'fulfilled', value: { success: true, ok: true, cleared: false } },
        { kind: 'analysis', status: 'fulfilled', value: {
          success: true, ok: false, reason: 'ownership-mismatch',
          artifacts: { current: { state: 'ownership-mismatch' }, lastSuccess: { state: 'cleared' }, prompt: { state: 'foreign-paired' } },
        } },
      ]), 'already-absent and wholly foreign analysis bundles are safe clear no-ops');
      assert(careerFilesCleanupNeedsWarning([
        { kind: 'analysis', status: 'fulfilled', value: { success: true, ok: false, reason: 'cleanup-failed' } },
      ]) && careerFilesCleanupNeedsWarning([
        { kind: 'run', status: 'rejected', reason: new Error('disk unavailable') },
      ]) && careerFilesCleanupNeedsWarning([
        { kind: 'batch', status: 'fulfilled', value: { success: false, error: 'Window closed' } },
      ]) && careerFilesCleanupNeedsWarning([
        { kind: 'analysis', status: 'fulfilled', value: { success: true, ok: false, reason: 'cleanup-failed', artifacts: { current: { state: 'ownership-invalid' } } } },
      ]) && careerFilesCleanupNeedsWarning([
        { kind: 'analysis', status: 'fulfilled', value: { success: true, ok: false, reason: 'ownership-mismatch', artifacts: {} } },
      ]), 'failed IPC responses, cleanup failures, and rejected sidecar cleanup all require an honest warning');
      assert(isSafeJobAnalysisCleanupNoop({
        ok: false, reason: 'ownership-mismatch', artifacts: {
          current: { state: 'ownership-mismatch' }, lastSuccess: { state: 'cleared' },
          prompt: { state: 'foreign-paired' }, legacyCurrent: { state: 'missing' }, legacyLastSuccess: { state: 'post-clear-paired' },
        },
      }) && !isSafeJobAnalysisCleanupNoop({
        ok: false, reason: 'ownership-mismatch', artifacts: { current: { state: 'unpaired' } },
      }) && !isSafeJobAnalysisCleanupNoop({
        ok: false, reason: 'ownership-mismatch', artifacts: { current: { state: 'created-at-invalid' } },
      }) && !isSafeJobAnalysisCleanupNoop({
        ok: false, reason: 'cleanup-failed', artifacts: { current: { state: 'cleared' } },
      }), 'mixed cleanup is quiet only when every retained artifact is proven foreign, missing, or post-clear and every target artifact was actually cleared; an unpaired prompt still warns');
      return { watermarkGate: true, cleanupWarning: true };
    },
  },
  {
    name: 'gathered job-run recovery bypasses scrape prerequisites only for a complete matching manifest',
    run: async () => {
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
      const stagingStart = source.indexOf('const runStartedAt = initialRunStartedAt;');
      const stagingEnd = source.indexOf('const stageOnPage =', stagingStart);
      const staging = source.slice(stagingStart, stagingEnd);
      assert(staging.includes('if (resumeScope) {')
        && staging.includes('if (!resumeGatheredOnly) {\n        const stageAdvanced = await setJobRunStage')
        && staging.includes('if (hasExactResumeToken && stageAdvanced !== true)')
        && staging.includes('} else {\n      const startedRun = await startJobRun'),
      'gathered-only recovery remains inside the resume branch, preserving its original manifest token and staged rows instead of starting/truncating a fresh run');
      // A run that dies DURING the gather never reaches the finalization loop
      // below, so a source's terminal status has to be durable the moment that
      // source finishes. Browser sources run one at a time and one of them can
      // hold the phase indefinitely (an unbounded human-solve wait), which is
      // exactly when a crash leaves finished sources looking unstarted.
      assert(source.includes('const markGatheredSourceTerminal = async (sourceId, results)')
        && source.includes('await markGatheredSourceTerminal(sid, r);')
        && source.includes("await markGatheredSourceTerminal('indeed', indeedResult ? [indeedResult] : []);")
        && source.includes('await markGatheredSourceTerminal(sourceId, [{ jobs, warning }]);'),
      'every source records its terminal manifest status as it finishes, so resume after a mid-gather crash reuses staged rows instead of re-scraping them');
      assert(source.includes("if (!blocked && produced === 0) return; // nothing proven yet — leave it pending"),
        'the in-gather mark is conservative: only a source that demonstrably produced rows or blocked is written, so a wrong guess costs a re-scrape and never staged results');
      assert(source.includes("['block', 'throttle'].includes(r?.warning?.severity)")
        && source.includes('const retryablePartialProviderFailure = sourceId === \'remoteok\'')
        && source.includes('entry?.fanoutStopped === true')
        && source.includes("status === 'error' || retryablePartialProviderFailure ? 'blocked' : 'done'"),
      'a throttled RemoteOK optional tag fanout preserves its base rows but remains retryable in the gathered manifest instead of being misclassified as a clean completion');
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
        && renderer.includes('(info?.nodeId === id || !info?.nodeId)')
        && renderer.includes('const legacyUnknownOwner = !resumeOffer?.nodeId;')
        && renderer.includes('discardUnknownOwnerJobRun'),
      'only the owning hub resumes or discards a modern recovery offer; a node-less legacy manifest gets an explicit Start fresh-only recovery path while current platform toggles never block a valid resume');
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
    name: 'job analysis paths isolate each hub and retain both earlier path generations',
    run: () => {
      const root = path.join('/tmp', `ic-owner-analysis-paths-${process.pid}-${Date.now()}`);
      const canvas = path.join(root, 'shared-canvas.json');
      const fallback = path.join(root, 'unsaved');
      const priorCanvasPaths = getJobAnalysisPaths(canvas, fallback);
      const hubAPaths = getJobAnalysisPaths(canvas, fallback, 'job-hub-a');
      const hubBPaths = getJobAnalysisPaths(canvas, fallback, 'job-hub-b');
      const unsavedAPaths = getJobAnalysisPaths(null, fallback, 'job-hub-a');
      const unsavedBPaths = getJobAnalysisPaths(null, fallback, 'job-hub-b');
      const unsavedScopeA = 'renderer_session_scope_A_1234';
      const unsavedScopeB = 'renderer_session_scope_B_5678';
      const clonedUnsavedA = getJobAnalysisPaths(null, fallback, 'cloned-hub', unsavedScopeA);
      const clonedUnsavedB = getJobAnalysisPaths(null, fallback, 'cloned-hub', unsavedScopeB);
      assert(hubAPaths.jsonPath !== hubBPaths.jsonPath
        && hubAPaths.lastSuccessJsonPath !== hubBPaths.lastSuccessJsonPath
        && hubAPaths.promptPath !== hubBPaths.promptPath
        && !path.basename(hubAPaths.jsonPath).includes('job-hub-a'),
      'two Job Search hubs on one canvas receive separate non-sensitive current, last-success, and prompt artifact paths');
      assert(hubAPaths.legacyCanvasJsonPath === priorCanvasPaths.jsonPath
        && hubAPaths.legacyCanvasLastSuccessJsonPath === priorCanvasPaths.lastSuccessJsonPath
        && hubAPaths.legacyCanvasPromptPath === priorCanvasPaths.promptPath
        && hubAPaths.legacyJsonPath === path.join(root, 'job-search-last-scrape.json')
        && hubAPaths.legacyLastSuccessJsonPath === path.join(root, 'job-search-last-successful-scrape.json')
        && hubAPaths.legacyPromptPath === path.join(root, 'job-search-scoring-AI-prompt.txt'),
      'owner-scoped callers can discover both prior canvas-scoped hashes and pre-namespace directory files as separate legacy generations');
      assert(priorCanvasPaths.ownerNamespace === null
        && priorCanvasPaths.legacyCanvasJsonPath === null
        && priorCanvasPaths.jsonPath === getJobAnalysisPaths(canvas, fallback, '  ').jsonPath,
      'the two-argument API and an invalid owner keep their exact historical primary canvas path during the migration');
      assert(unsavedAPaths.jsonPath !== unsavedBPaths.jsonPath
        && unsavedAPaths.legacyCanvasJsonPath === path.join(fallback, 'job-search-last-scrape.json')
        && unsavedAPaths.legacyJsonPath === null,
      'unsaved canvases also isolate hubs while exposing their former shared fallback bundle exactly once');
      assert(clonedUnsavedA.jsonPath !== clonedUnsavedB.jsonPath
        && clonedUnsavedA.promptPath !== clonedUnsavedB.promptPath
        && getJobDescriptionRecoveryCheckpointPath(null, 'same-run', fallback, unsavedScopeA)
          !== getJobDescriptionRecoveryCheckpointPath(null, 'same-run', fallback, unsavedScopeB)
        && getJobAnalysisPaths(null, fallback, 'cloned-hub').jsonPath
          === getJobAnalysisPaths(null, fallback, 'cloned-hub').jsonPath,
      'renderer-session scopes isolate duplicate unsaved hub IDs and exact run checkpoints, while omitted scopes preserve internal legacy compatibility');
      return { ownerNamespace: hubAPaths.ownerNamespace, legacyCanvas: path.basename(hubAPaths.legacyCanvasJsonPath) };
    },
  },
  {
    name: 'owner-scoped snapshot recovery reads only its hub then migrates safely through both legacy bundles',
    run: async () => {
      const root = path.join('/tmp', `ic-owner-snapshot-recovery-${process.pid}-${Date.now()}`);
      const canvas = path.join(root, 'canvas.json');
      const fallback = path.join(root, 'unsaved');
      const hubAPaths = getJobAnalysisPaths(canvas, fallback, 'hub-a');
      const hubBPaths = getJobAnalysisPaths(canvas, fallback, 'hub-b');
      const snapshot = (nodeId, runId, title) => ({
        canvasFilePath: canvas,
        sourceHubId: nodeId,
        nodeId,
        runId,
        createdAt: '2026-09-08T19:25:57.108Z',
        gatheredJobCount: 1,
        cachedPrefix: `evidence ${title}`,
        previewBatches: [],
        jobs: [{ title }],
      });
      const hubA = snapshot('hub-a', 'run-a', 'Hub A');
      const hubB = snapshot('hub-b', 'run-b', 'Hub B');
      try {
        await fs.promises.mkdir(root, { recursive: true });
        await __saveJobAnalysisSnapshotForTests(hubA);
        await __saveJobAnalysisSnapshotForTests(hubB);
        let loaded = await __loadJobAnalysisSnapshotForTests(canvas, 'hub-a', 'run-a');
        assert(loaded.origin === 'current' && loaded.snapshot.jobs[0].title === 'Hub A'
          && loaded.paths.jsonPath === hubAPaths.jsonPath
          && (await fs.promises.readFile(hubBPaths.jsonPath, 'utf8')).includes('Hub B'),
        'the owner-aware writer and reader keep simultaneous hubs on one canvas in separate current bundles');

        await fs.promises.rm(hubAPaths.jsonPath);
        await fs.promises.rm(hubAPaths.lastSuccessJsonPath);
        await fs.promises.writeFile(hubAPaths.legacyCanvasJsonPath, JSON.stringify(hubA));
        loaded = await __loadJobAnalysisSnapshotForTests(canvas, 'hub-a', 'run-a');
        assert(loaded.origin === 'legacy-canvas-current' && loaded.paths.jsonPath === hubAPaths.legacyCanvasJsonPath,
          'a missing owner bundle falls back first to the earlier canvas-hashed bundle after exact hub and canvas validation');

        await fs.promises.rm(hubAPaths.legacyCanvasJsonPath);
        await fs.promises.writeFile(hubAPaths.legacyJsonPath, JSON.stringify(hubA));
        loaded = await __loadJobAnalysisSnapshotForTests(canvas, 'hub-a', 'run-a');
        assert(loaded.origin === 'legacy-current' && loaded.paths.jsonPath === hubAPaths.legacyJsonPath,
          'the pre-namespace directory bundle remains available only after the canvas-hash migration fallback is exhausted');

        await fs.promises.writeFile(hubAPaths.legacyJsonPath, JSON.stringify(hubB));
        let rejected = false;
        try { await __loadJobAnalysisSnapshotForTests(canvas, 'hub-a', 'run-a'); } catch (error) { rejected = error?.code === 'ENOENT'; }
        assert(rejected,
          'a foreign owner or run token in either legacy generation is never returned to this hub');
        return { ownerPath: path.basename(hubAPaths.jsonPath), legacyOrigin: loaded.origin };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'unsaved analysis paths retain the initiating WebContents scope through async IPC context',
    run: async () => {
      const senderA = { id: 1001 };
      const senderB = { id: 1002 };
      const inSender = (sender, callback) => __runWithIpcRequestContextForTests(
        { sender, nodeId: 'cloned-hub', channel: 'save-job-analysis-snapshot' }, callback,
      );
      const [a, b] = await Promise.all([
        inSender(senderA, async () => { await Promise.resolve(); return __analysisPathsForCurrentRequestForTests(null, 'cloned-hub'); }),
        inSender(senderB, async () => { await Promise.resolve(); return __analysisPathsForCurrentRequestForTests(null, 'cloned-hub'); }),
      ]);
      assert(a.jsonPath !== b.jsonPath && a.promptPath !== b.promptPath
        && a.jsonPath.includes('job-search-unsaved-') && b.jsonPath.includes('job-search-unsaved-'),
      'two renderer senders with a cloned unsaved hub ID retain distinct owner artifact paths after an async boundary');
      assert(a.legacyCanvasJsonPath === null && b.legacyCanvasJsonPath === null
        && a.legacyCanvasPromptPath === null && b.legacyCanvasPromptPath === null,
      'a sender-scoped unsaved bundle cannot fall back to the historical shared recovery/prompt files');
      return { distinct: true };
    },
  },
  {
    name: 'career clear discards only the exact hub-owned analysis bundle and retires its run',
    run: async () => {
      const root = path.join('/tmp', `ic-analysis-clear-${process.pid}-${Date.now()}`);
      const canvas = path.join(root, 'canvas.json');
      const paths = getJobAnalysisPaths(canvas, path.join(root, 'unsaved'), 'hub-a');
      const exists = async (filePath) => {
        try { await fs.promises.access(filePath); return true; } catch { return false; }
      };
      const snapshot = (nodeId, runId, marker, canvasFilePath = canvas) => ({
        version: 2,
        canvasFilePath,
        sourceHubId: nodeId,
        nodeId,
        runId,
        createdAt: '2026-09-07T12:00:00.000Z',
        gatheredJobCount: 1,
        selectedJobCount: 1,
        cachedPrefix: `career evidence ${marker}`,
        previewBatches: [],
        jobs: [{ title: marker }],
      });
      try {
        await fs.promises.mkdir(root, { recursive: true });
        const beforeFirstCanvas = path.join(root, 'before-first.json');
        const beforeFirstPaths = getJobAnalysisPaths(beforeFirstCanvas, path.join(root, 'unused'), 'hub-a');
        const beforeFirstClear = await __discardJobAnalysisSnapshotForTests(beforeFirstCanvas, 'hub-a', {
          runId: 'run-before-first-snapshot',
        });
        const invalidRun = await __discardJobAnalysisSnapshotForTests(beforeFirstCanvas, 'hub-a', {
          runId: 'invalid run id',
        });
        const invalidNode = await __discardJobAnalysisSnapshotForTests(beforeFirstCanvas, 'invalid node id', {
          runId: 'run-valid-but-node-is-not',
        });
        const retirementBeforeInvalidBoundary = __getJobAnalysisRetirementStateForTests().ownerBoundaries;
        for (const invalidBoundary of [false, '', '1234', 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
          const invalidClearBoundary = await __discardJobAnalysisSnapshotForTests(beforeFirstCanvas, 'hub-a', {
            runId: 'must-not-retire-invalid-boundary', clearedAt: invalidBoundary,
          });
          assert(!invalidClearBoundary.ok && invalidClearBoundary.reason === 'invalid-clear-boundary',
            'the discard timestamp is a strict positive safe-integer Date.now boundary, never a coercible input');
        }
        const lateBeforeFirst = await __saveJobAnalysisSnapshotForTests(
          snapshot('hub-a', 'run-before-first-snapshot', 'late-before-first', beforeFirstCanvas),
        );
        const nextBeforeFirst = await __saveJobAnalysisSnapshotForTests(
          snapshot('hub-a', 'run-after-first-snapshot', 'next-before-first', beforeFirstCanvas),
        );
        assert(beforeFirstClear.ok && !beforeFirstClear.cleared && beforeFirstClear.retiredRun
          && !invalidRun.ok && invalidRun.reason === 'invalid-run-id'
          && !invalidNode.ok && invalidNode.reason === 'invalid-node-id'
          && __getJobAnalysisRetirementStateForTests().ownerBoundaries === retirementBeforeInvalidBoundary
          && lateBeforeFirst.retired === true && nextBeforeFirst.retired !== true
          && JSON.parse(await fs.promises.readFile(beforeFirstPaths.jsonPath, 'utf8')).runId === 'run-after-first-snapshot',
        'a clear captured before the first snapshot tombstones its exact valid run without blocking a future run on the same hub');

        const invalidCreatedAtCanvas = path.join(root, 'invalid-created-at.json');
        const invalidCreatedAtPaths = getJobAnalysisPaths(invalidCreatedAtCanvas, path.join(root, 'unused-invalid-created-at'), 'hub-a');
        const invalidCreatedAtSnapshot = {
          ...snapshot('hub-a', 'run-invalid-created-at', 'invalid-created-at', invalidCreatedAtCanvas),
          createdAt: Number.MAX_SAFE_INTEGER,
        };
        await fs.promises.writeFile(invalidCreatedAtPaths.jsonPath, JSON.stringify(invalidCreatedAtSnapshot));
        await fs.promises.writeFile(invalidCreatedAtPaths.promptPath, __formatJobAnalysisPromptForTests(invalidCreatedAtSnapshot));
        const invalidCreatedAtClear = await __discardJobAnalysisSnapshotForTests(invalidCreatedAtCanvas, 'hub-a', {
          runId: invalidCreatedAtSnapshot.runId,
          clearedAt: Date.now(),
        });
        assert(invalidCreatedAtClear.ok
          && invalidCreatedAtClear.artifacts.current.cleared
          && invalidCreatedAtClear.artifacts.prompt.cleared
          && !(await exists(invalidCreatedAtPaths.jsonPath)),
        'the exact requested run is cleared even when its embedded timestamp is invalid and cannot classify its age');

        const differentInvalidCreatedAtCanvas = path.join(root, 'different-invalid-created-at.json');
        const differentInvalidCreatedAtPaths = getJobAnalysisPaths(differentInvalidCreatedAtCanvas, path.join(root, 'unused-different-invalid-created-at'), 'hub-a');
        const differentInvalidCreatedAtSnapshot = {
          ...snapshot('hub-a', 'run-new-invalid-created-at', 'different-invalid-created-at', differentInvalidCreatedAtCanvas),
          createdAt: Number.MAX_SAFE_INTEGER,
        };
        await fs.promises.writeFile(differentInvalidCreatedAtPaths.jsonPath, JSON.stringify(differentInvalidCreatedAtSnapshot));
        const differentInvalidCreatedAtClear = await __discardJobAnalysisSnapshotForTests(differentInvalidCreatedAtCanvas, 'hub-a', {
          runId: 'run-cleared-before-invalid-created-at',
          clearedAt: Date.now(),
        });
        assert(!differentInvalidCreatedAtClear.ok && differentInvalidCreatedAtClear.reason === 'cleanup-failed'
          && differentInvalidCreatedAtClear.artifacts.current.state === 'created-at-invalid'
          && await exists(differentInvalidCreatedAtPaths.jsonPath),
        'an invalid timestamp still blocks cleanup for a different run because its newness cannot be proven safely');

        const clearedRun = snapshot('hub-a', 'run-a', 'A');
        await __saveJobAnalysisSnapshotForTests(clearedRun);
        const trashed = [];
        const clear = await __discardJobAnalysisSnapshotForTests(canvas, 'hub-a', {
          trashItem: async (filePath) => {
            await fs.promises.rename(filePath, `${filePath}.trashed`);
            trashed.push(filePath);
          },
        });
        assert(clear.ok && clear.cleared
          && clear.artifacts.current.method === 'trash'
          && clear.artifacts.lastSuccess.method === 'trash'
          && clear.artifacts.prompt.method === 'trash'
          && trashed.length === 3
          && !(await exists(paths.jsonPath))
          && !(await exists(paths.lastSuccessJsonPath))
          && !(await exists(paths.promptPath)),
        'clearing a hub removes its owned current/last-success/prompt bundle through the injectable recoverable-trash seam');

        const lateSameRun = await __saveJobAnalysisSnapshotForTests(clearedRun);
        const nextRun = snapshot('hub-a', 'run-b', 'B');
        const freshRun = await __saveJobAnalysisSnapshotForTests(nextRun);
        assert(lateSameRun.retired === true && freshRun.retired !== true
          && JSON.parse(await fs.promises.readFile(paths.jsonPath, 'utf8')).runId === 'run-b',
        'the cleared run is tombstoned against a late write while a new run on the same hub remains writable');

        const boundaryCanvas = path.join(root, 'clear-boundary.json');
        const boundaryPaths = getJobAnalysisPaths(boundaryCanvas, path.join(root, 'unused-boundary'), 'hub-a');
        const boundaryAt = 2_000;
        const staleBoundary = { ...snapshot('hub-a', 'run-a-boundary', 'old-boundary', boundaryCanvas), createdAt: new Date(1_999).toISOString() };
        const postBoundary = { ...snapshot('hub-a', 'run-b-boundary', 'new-boundary', boundaryCanvas), createdAt: new Date(2_001).toISOString() };
        await fs.promises.writeFile(boundaryPaths.jsonPath, JSON.stringify(postBoundary));
        await fs.promises.writeFile(boundaryPaths.lastSuccessJsonPath, JSON.stringify(staleBoundary));
        await fs.promises.writeFile(boundaryPaths.promptPath, __formatJobAnalysisPromptForTests(postBoundary));
        const boundaryClear = await __discardJobAnalysisSnapshotForTests(boundaryCanvas, 'hub-a', {
          runId: staleBoundary.runId,
          clearedAt: boundaryAt,
        });
        const equalOtherRun = await __saveJobAnalysisSnapshotForTests({
          ...postBoundary, runId: 'run-b-equal-boundary', createdAt: new Date(boundaryAt).toISOString(),
        });
        const equalClearedRun = await __saveJobAnalysisSnapshotForTests({
          ...staleBoundary, createdAt: new Date(boundaryAt).toISOString(),
        });
        const lateBoundaryRun = await __saveJobAnalysisSnapshotForTests({
          ...staleBoundary, createdAt: new Date(boundaryAt + 500).toISOString(),
        });
        const equalMalformedRun = await __saveJobAnalysisSnapshotForTests({
          ...postBoundary, runId: 'malformed run id', createdAt: new Date(boundaryAt).toISOString(),
        });
        assert(boundaryClear.ok && boundaryClear.artifacts.current.state === 'post-clear'
          && boundaryClear.artifacts.lastSuccess.cleared && boundaryClear.artifacts.prompt.state === 'post-clear-paired'
          && await exists(boundaryPaths.jsonPath)
          && equalOtherRun.retired !== true && equalClearedRun.retired === true && lateBoundaryRun.retired === true
          && equalMalformedRun.retired === true,
        'a stale clear removes every owned pre-boundary artifact while preserving a newer or exactly-tied separately identified run; its exact run tombstone and conservative malformed-tie rule still defeat late writes');

        const repeatedClearCanvas = path.join(root, 'repeated-clear-boundary.json');
        const repeatedBoundary = 3_000;
        const firstRepeatedClear = await __discardJobAnalysisSnapshotForTests(repeatedClearCanvas, 'hub-a', {
          runId: 'run-first-same-ms', clearedAt: repeatedBoundary,
        });
        const secondRepeatedClear = await __discardJobAnalysisSnapshotForTests(repeatedClearCanvas, 'hub-a', {
          runId: 'run-second-same-ms', clearedAt: repeatedBoundary,
        });
        const lateFirstSameMs = await __saveJobAnalysisSnapshotForTests({
          ...snapshot('hub-a', 'run-first-same-ms', 'late-first-same-ms', repeatedClearCanvas),
          createdAt: new Date(repeatedBoundary).toISOString(),
        });
        const lateSecondSameMs = await __saveJobAnalysisSnapshotForTests({
          ...snapshot('hub-a', 'run-second-same-ms', 'late-second-same-ms', repeatedClearCanvas),
          createdAt: new Date(repeatedBoundary).toISOString(),
        });
        const newAfterRepeatedClear = await __saveJobAnalysisSnapshotForTests({
          ...snapshot('hub-a', 'run-after-repeated-clear', 'after-repeated-clear', repeatedClearCanvas),
          createdAt: new Date(repeatedBoundary + 2).toISOString(),
        });
        assert(firstRepeatedClear.ok && secondRepeatedClear.ok
          && lateFirstSameMs.retired === true && lateSecondSameMs.retired === true
          && newAfterRepeatedClear.retired !== true,
        'sequential clears with an equal or non-monotonic IPC timestamp advance the retired boundary, tombstone both cleared runs, and still admit a later run');

        const presentSecondRunCanvas = path.join(root, 'present-second-run-boundary.json');
        const presentSecondRunPaths = getJobAnalysisPaths(presentSecondRunCanvas, path.join(root, 'unused-present-second-run'), 'hub-a');
        const presentBoundary = 4_000;
        await __discardJobAnalysisSnapshotForTests(presentSecondRunCanvas, 'hub-a', {
          runId: 'run-first-present-boundary', clearedAt: presentBoundary,
        });
        const presentSecondRun = {
          ...snapshot('hub-a', 'run-second-present-boundary', 'second-present-boundary', presentSecondRunCanvas),
          // Greater than both the stale caller's raw boundary and the effective
          // monotonic boundary. Its exact run token must still make this clear
          // authoritative for the requested run.
          createdAt: new Date(presentBoundary + 2).toISOString(),
        };
        await fs.promises.writeFile(presentSecondRunPaths.jsonPath, JSON.stringify(presentSecondRun));
        await fs.promises.writeFile(presentSecondRunPaths.promptPath, __formatJobAnalysisPromptForTests(presentSecondRun));
        const presentSecondRunClear = await __discardJobAnalysisSnapshotForTests(presentSecondRunCanvas, 'hub-a', {
          runId: presentSecondRun.runId, clearedAt: presentBoundary,
        });
        assert(presentSecondRunClear.ok && presentSecondRunClear.artifacts.current.cleared
          && presentSecondRunClear.artifacts.prompt.cleared
          && !(await exists(presentSecondRunPaths.jsonPath)),
        'an exact requested run cannot survive its clear merely because its artifact timestamp is newer than both the raw and effective clear boundaries');

        const currentLastOnlyCanvas = path.join(root, 'last-success-only.json');
        const currentLastOnlyPaths = getJobAnalysisPaths(currentLastOnlyCanvas, path.join(root, 'unused-last-only'), 'hub-a');
        const currentLastOnly = snapshot('hub-a', 'run-last-success-only', 'last-success-only', currentLastOnlyCanvas);
        await fs.promises.writeFile(currentLastOnlyPaths.lastSuccessJsonPath, JSON.stringify(currentLastOnly));
        await fs.promises.writeFile(currentLastOnlyPaths.promptPath, __formatJobAnalysisPromptForTests(currentLastOnly));
        const currentLastOnlyClear = await __discardJobAnalysisSnapshotForTests(currentLastOnlyCanvas, 'hub-a');
        const legacyLastOnlyCanvas = path.join(root, 'legacy-last-success-only.json');
        const legacyLastOnlyPaths = getJobAnalysisPaths(legacyLastOnlyCanvas, path.join(root, 'unused-legacy-last-only'), 'hub-a');
        const legacyLastOnly = snapshot('hub-a', 'run-legacy-last-success-only', 'legacy-last-success-only', legacyLastOnlyCanvas);
        await fs.promises.writeFile(legacyLastOnlyPaths.legacyLastSuccessJsonPath, JSON.stringify(legacyLastOnly));
        await fs.promises.writeFile(legacyLastOnlyPaths.legacyPromptPath, __formatJobAnalysisPromptForTests(legacyLastOnly));
        const legacyLastOnlyClear = await __discardJobAnalysisSnapshotForTests(legacyLastOnlyCanvas, 'hub-a');
        assert(currentLastOnlyClear.artifacts.lastSuccess.cleared && currentLastOnlyClear.artifacts.prompt.cleared
          && legacyLastOnlyClear.artifacts.legacyLastSuccess.cleared && legacyLastOnlyClear.artifacts.legacyPrompt.cleared,
        'a verified current or legacy prompt is removable when it pairs with an owned last-success record even if the current record is absent');

        const accessFailureCanvas = path.join(root, 'remove-access-failure.json');
        const accessFailure = snapshot('hub-a', 'run-access-failure', 'access-failure', accessFailureCanvas);
        await __saveJobAnalysisSnapshotForTests(accessFailure);
        const eacces = new Error('permission denied while confirming removal');
        eacces.code = 'EACCES';
        const accessFailureClear = await __discardJobAnalysisSnapshotForTests(accessFailureCanvas, 'hub-a', {
          trashItem: async (filePath) => fs.promises.rename(filePath, `${filePath}.moved`),
          verifyRemoval: async () => { throw eacces; },
        });
        assert(!accessFailureClear.ok && accessFailureClear.reason === 'cleanup-failed'
          && accessFailureClear.artifacts.current.state === 'error'
          && accessFailureClear.artifacts.current.cleared === false,
        'a non-ENOENT access failure after deletion is reported as uncertain cleanup, never falsely claimed as removed');

        const alreadyMissingCanvas = path.join(root, 'already-missing.json');
        const alreadyMissing = snapshot('hub-a', 'run-already-missing', 'already-missing', alreadyMissingCanvas);
        await __saveJobAnalysisSnapshotForTests(alreadyMissing);
        const alreadyMissingClear = await __discardJobAnalysisSnapshotForTests(alreadyMissingCanvas, 'hub-a', {
          // Model a second cleanup process deleting each artifact between our
          // ownership read and the OS-trash request, then surfacing ENOENT.
          trashItem: async (filePath) => {
            await fs.promises.unlink(filePath);
            const error = new Error('artifact already removed');
            error.code = 'ENOENT';
            throw error;
          },
        });
        assert(alreadyMissingClear.ok && !alreadyMissingClear.cleared
          && alreadyMissingClear.artifacts.current.state === 'missing'
          && alreadyMissingClear.artifacts.lastSuccess.state === 'missing'
          && alreadyMissingClear.artifacts.prompt.state === 'missing',
        'an ENOENT after an ownership read is a verified already-removed no-op, while non-ENOENT verification failures remain warnings');

        const invalidFallbackDir = path.join(root, 'invalid-unsaved-fallback');
        const invalidFallbackPaths = getJobAnalysisPaths(null, invalidFallbackDir, 'hub-a');
        const invalidFallback = snapshot('hub-a', 'run-invalid-fallback', 'invalid-fallback', null);
        await fs.promises.mkdir(invalidFallbackDir, { recursive: true });
        await fs.promises.writeFile(invalidFallbackPaths.jsonPath, JSON.stringify(invalidFallback));
        const retirementBeforeInvalidCanvas = __getJobAnalysisRetirementStateForTests().ownerBoundaries;
        for (const invalidCanvasFilePath of [undefined, '', '   ', 42]) {
          const invalidCanvas = await __discardJobAnalysisSnapshotForTests(invalidCanvasFilePath, 'hub-a', {
            runId: 'must-not-retire', fallbackDir: invalidFallbackDir,
          });
          assert(!invalidCanvas.ok && invalidCanvas.reason === 'invalid-canvas-path',
            'only explicit null may select the private unsaved-canvas fallback');
        }
        assert(await exists(invalidFallbackPaths.jsonPath)
          && __getJobAnalysisRetirementStateForTests().ownerBoundaries === retirementBeforeInvalidCanvas,
        'invalid canvas values leave both the private fallback artifact and retirement state untouched');

        const retirementCanvas = path.join(root, 'bounded-retirement.json');
        const retirementStateBefore = __getJobAnalysisRetirementStateForTests().ownerBoundaries;
        for (let index = 0; index < 48; index += 1) {
          await __discardJobAnalysisSnapshotForTests(retirementCanvas, 'hub-retirement', {
            runId: `run-retirement-${index}`,
            clearedAt: 10_000 + index,
          });
        }
        const staleRetirementWrite = await __saveJobAnalysisSnapshotForTests({
          ...snapshot('hub-retirement', 'run-retirement-0', 'late-retirement', retirementCanvas),
          createdAt: new Date(9_999).toISOString(),
        });
        const nextRetirementWrite = await __saveJobAnalysisSnapshotForTests({
          ...snapshot('hub-retirement', 'run-retirement-next', 'next-retirement', retirementCanvas),
          createdAt: new Date(10_100).toISOString(),
        });
        assert(__getJobAnalysisRetirementStateForTests().ownerBoundaries === retirementStateBefore + 1
          && staleRetirementWrite.retired === true && nextRetirementWrite.retired !== true,
        'retirement storage stays bounded to one advancing boundary per canvas/hub while old delayed snapshots remain fenced and a future run writes');

        const foreign = snapshot('hub-b', 'run-foreign', 'foreign');
        const foreignPaths = getJobAnalysisPaths(canvas, path.join(root, 'unsaved'), 'hub-b');
        await fs.promises.rm(paths.jsonPath, { force: true });
        await fs.promises.rm(paths.lastSuccessJsonPath, { force: true });
        await fs.promises.rm(paths.promptPath, { force: true });
        await __saveJobAnalysisSnapshotForTests(foreign);
        const foreignClear = await __discardJobAnalysisSnapshotForTests(canvas, 'hub-a');
        assert(foreignClear.ok && foreignClear.reason == null
          && foreignClear.artifacts.current.state === 'missing'
          && foreignClear.artifacts.lastSuccess.state === 'missing'
          && await exists(foreignPaths.jsonPath) && await exists(foreignPaths.lastSuccessJsonPath) && await exists(foreignPaths.promptPath),
        'clearing hub A cannot even discover, much less remove, hub B’s separate same-canvas bundle');

        const mixedTarget = snapshot('hub-a', 'run-mixed-target', 'mixed-target');
        // A corrupt/misrouted artifact can still be placed at hub A's path;
        // cleanup must retain that foreign record while removing the owned
        // last-success companion.
        await fs.promises.writeFile(paths.jsonPath, JSON.stringify(foreign));
        await fs.promises.writeFile(paths.lastSuccessJsonPath, JSON.stringify(mixedTarget));
        await fs.promises.writeFile(paths.promptPath, __formatJobAnalysisPromptForTests(mixedTarget));
        const mixedClear = await __discardJobAnalysisSnapshotForTests(canvas, 'hub-a');
        assert(mixedClear.ok && mixedClear.artifacts.current.state === 'ownership-mismatch'
          && mixedClear.artifacts.lastSuccess.cleared && mixedClear.artifacts.prompt.cleared
          && await exists(paths.jsonPath) && !(await exists(paths.lastSuccessJsonPath)),
        'a mixed bundle clears target-owned old recovery while consistently preserving a foreign current artifact without a false warning');

        const sharedPromptOwned = snapshot('hub-a', 'run-shared-prompt-owned', 'shared-prompt');
        const sharedPromptForeign = {
          ...sharedPromptOwned,
          sourceHubId: 'hub-b',
          nodeId: 'hub-b',
          runId: 'run-shared-prompt-foreign',
        };
        const sharedPrompt = __formatJobAnalysisPromptForTests(sharedPromptOwned);
        assert(sharedPrompt === __formatJobAnalysisPromptForTests(sharedPromptForeign),
          'analysis prompts can be byte-identical across snapshots whose owner and run provenance differ');
        await fs.promises.writeFile(paths.jsonPath, JSON.stringify(sharedPromptForeign));
        await fs.promises.writeFile(paths.lastSuccessJsonPath, JSON.stringify(sharedPromptOwned));
        await fs.promises.writeFile(paths.promptPath, sharedPrompt);
        const sharedPromptClear = await __discardJobAnalysisSnapshotForTests(canvas, 'hub-a');
        assert(sharedPromptClear.ok
          && sharedPromptClear.artifacts.current.state === 'ownership-mismatch'
          && sharedPromptClear.artifacts.lastSuccess.cleared
          && sharedPromptClear.artifacts.prompt.state === 'foreign-paired'
          && await exists(paths.jsonPath)
          && !(await exists(paths.lastSuccessJsonPath))
          && await fs.promises.readFile(paths.promptPath, 'utf8') === sharedPrompt,
        'an identical shared prompt remains with its preserved foreign/current snapshot when the stale owned sibling is cleared');

        await fs.promises.writeFile(paths.jsonPath, '{not json', 'utf8');
        await fs.promises.writeFile(paths.lastSuccessJsonPath, JSON.stringify(sharedPromptOwned));
        await fs.promises.writeFile(paths.promptPath, sharedPrompt);
        const ambiguousSharedPromptClear = await __discardJobAnalysisSnapshotForTests(canvas, 'hub-a');
        assert(!ambiguousSharedPromptClear.ok
          && ambiguousSharedPromptClear.reason === 'cleanup-failed'
          && ambiguousSharedPromptClear.artifacts.current.state === 'invalid'
          && ambiguousSharedPromptClear.artifacts.lastSuccess.cleared
          && ambiguousSharedPromptClear.artifacts.prompt.state === 'ownership-ambiguous'
          && await exists(paths.jsonPath)
          && !(await exists(paths.lastSuccessJsonPath))
          && await fs.promises.readFile(paths.promptPath, 'utf8') === sharedPrompt,
        'a malformed current companion vetoes deletion of an ownerless shared prompt even when an owned stale sibling has byte-identical prompt content');

        const inconsistentOwner = { ...snapshot('hub-a', 'run-inconsistent-owner', 'inconsistent-owner'), nodeId: 'hub-b' };
        await fs.promises.writeFile(paths.jsonPath, JSON.stringify(inconsistentOwner));
        await fs.promises.writeFile(paths.promptPath, __formatJobAnalysisPromptForTests(inconsistentOwner));
        const inconsistentClear = await __discardJobAnalysisSnapshotForTests(canvas, 'hub-a');
        assert(!inconsistentClear.ok && inconsistentClear.reason === 'cleanup-failed'
          && inconsistentClear.artifacts.current.state === 'ownership-invalid'
          && inconsistentClear.artifacts.prompt.state === 'ownership-ambiguous'
          && await exists(paths.promptPath)
          && careerFilesCleanupNeedsWarning([{ kind: 'analysis', status: 'fulfilled', value: { success: true, ...inconsistentClear } }]),
        'contradictory owner fields are not treated as an ordinary foreign no-op and surface a cleanup warning');

        await fs.promises.rm(paths.jsonPath, { force: true });
        await fs.promises.rm(paths.lastSuccessJsonPath, { force: true });
        await fs.promises.rm(paths.promptPath, { force: true });
        const unpaired = snapshot('hub-a', 'run-unpaired', 'unpaired');
        await fs.promises.writeFile(paths.jsonPath, JSON.stringify(unpaired));
        await fs.promises.writeFile(paths.lastSuccessJsonPath, JSON.stringify(unpaired));
        await fs.promises.writeFile(paths.promptPath, 'unpaired prompt from another run');
        const unpairedClear = await __discardJobAnalysisSnapshotForTests(canvas, 'hub-a');
        assert(!unpairedClear.ok && unpairedClear.reason === 'cleanup-failed' && unpairedClear.artifacts.current.cleared
          && unpairedClear.artifacts.lastSuccess.cleared
          && unpairedClear.artifacts.prompt.state === 'unpaired'
          && await exists(paths.promptPath),
        'an owned current snapshot does not authorize deletion of an unpaired prompt and reports the ambiguous retained career material honestly');
        await fs.promises.rm(paths.promptPath);

        // JSON artifacts can be removed by a prior incomplete cleanup while a
        // prompt survives. No JSON owner remains to authorize deletion, so the
        // prompt must be reported as an unsafe orphan rather than hidden by the
        // default "missing" artifact state.
        await fs.promises.writeFile(paths.promptPath, 'orphan prompt with cleared career material');
        const orphanPromptClear = await __discardJobAnalysisSnapshotForTests(canvas, 'hub-a');
        assert(!orphanPromptClear.ok && orphanPromptClear.reason === 'cleanup-failed'
          && orphanPromptClear.artifacts.current.state === 'missing'
          && orphanPromptClear.artifacts.lastSuccess.state === 'missing'
          && orphanPromptClear.artifacts.prompt.state === 'unpaired'
          && await exists(paths.promptPath),
        'a present prompt with no JSON companion is an unsafe orphan, not a successful missing-artifact no-op');
        await fs.promises.rm(paths.promptPath);

        const legacy = snapshot('hub-a', 'legacy-run', 'legacy');
        await fs.promises.writeFile(paths.legacyJsonPath, JSON.stringify(legacy));
        await fs.promises.writeFile(paths.legacyLastSuccessJsonPath, JSON.stringify(legacy));
        await fs.promises.writeFile(paths.legacyPromptPath, __formatJobAnalysisPromptForTests(legacy));
        const legacyClear = await __discardJobAnalysisSnapshotForTests(canvas, 'hub-a');
        assert(legacyClear.ok && legacyClear.artifacts.legacyCurrent.cleared
          && legacyClear.artifacts.legacyLastSuccess.cleared
          && legacyClear.artifacts.legacyPrompt.cleared
          && !(await exists(paths.legacyJsonPath))
          && !(await exists(paths.legacyLastSuccessJsonPath))
          && !(await exists(paths.legacyPromptPath)),
        'legacy artifacts are cleared only after their embedded canvas and hub ownership both match, including a verified paired prompt');

        const unsavedDir = path.join(root, 'unsaved-analysis');
        const unsavedPaths = getJobAnalysisPaths(null, unsavedDir, 'hub-a');
        const unsaved = snapshot('hub-a', 'unsaved-run', 'unsaved', null);
        await fs.promises.mkdir(unsavedDir, { recursive: true });
        await fs.promises.writeFile(unsavedPaths.jsonPath, JSON.stringify(unsaved));
        await fs.promises.writeFile(unsavedPaths.lastSuccessJsonPath, JSON.stringify(unsaved));
        await fs.promises.writeFile(unsavedPaths.promptPath, __formatJobAnalysisPromptForTests(unsaved));
        const unsavedClear = await __discardJobAnalysisSnapshotForTests(null, 'hub-a', { fallbackDir: unsavedDir });
        assert(unsavedClear.ok && unsavedClear.artifacts.current.cleared
          && unsavedClear.artifacts.lastSuccess.cleared && unsavedClear.artifacts.prompt.cleared
          && !(await exists(unsavedPaths.jsonPath)) && !(await exists(unsavedPaths.lastSuccessJsonPath)),
        'an untitled canvas clears its exact hub-owned private fallback bundle instead of leaving old career data resumable');

        const unsavedForeign = snapshot('hub-b', 'unsaved-foreign', 'unsaved-foreign', null);
        await fs.promises.writeFile(unsavedPaths.jsonPath, JSON.stringify(unsavedForeign));
        await fs.promises.writeFile(unsavedPaths.lastSuccessJsonPath, JSON.stringify(unsavedForeign));
        await fs.promises.writeFile(unsavedPaths.promptPath, __formatJobAnalysisPromptForTests(unsavedForeign));
        const unsavedForeignClear = await __discardJobAnalysisSnapshotForTests(null, 'hub-a', { fallbackDir: unsavedDir });
        assert(unsavedForeignClear.ok && unsavedForeignClear.reason == null
          && unsavedForeignClear.artifacts.current.state === 'ownership-mismatch'
          && unsavedForeignClear.artifacts.lastSuccess.state === 'ownership-mismatch'
          && unsavedForeignClear.artifacts.prompt.state === 'foreign-paired'
          && await exists(unsavedPaths.jsonPath) && await exists(unsavedPaths.lastSuccessJsonPath) && await exists(unsavedPaths.promptPath),
        'an untitled canvas preserves a verified-foreign fallback bundle as an expected no-op');
        return { trashed: trashed.length, retiredRun: clearedRun.runId, newRun: nextRun.runId };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'job analysis snapshot writers atomically prepend fresh bounded report metadata for current, last-success, and recovery rewrites',
    run: async () => {
      const root = path.join('/tmp', `ic-snapshot-report-metadata-${process.pid}-${Date.now()}`);
      const canvas = path.join(root, 'canvas.json');
      const hubId = 'snapshot-report-metadata-hub';
      const paths = getJobAnalysisPaths(canvas, path.join(root, 'unsaved'), hubId);
      const initial = {
        canvasFilePath: canvas,
        sourceHubId: hubId,
        nodeId: hubId,
        runId: 'snapshot-report-metadata-run',
        createdAt: '2026-09-13T08:00:00.000Z',
        gatheredJobCount: 1,
        jobs: [{ title: 'First saved job' }],
        descriptionRecoveryJobs: [],
        marker: 'initial-runtime-payload',
        reportMetadata: { schemaVersion: 999, sourceHubId: 'spoofed-owner', injected: 'must not survive' },
      };
      const read = async (filePath) => JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
      const assertMetadata = (stored, expected) => {
        assert(Object.keys(stored)[0] === 'reportMetadata'
          && stored.reportMetadata?.schemaVersion === 1
          && stored.reportMetadata?.sourceHubId === hubId
          && stored.reportMetadata?.nodeId === hubId
          && stored.reportMetadata?.canvasFilePath === canvas
          && stored.reportMetadata?.runId === initial.runId
          && stored.reportMetadata?.createdAt === expected.createdAt
          && stored.reportMetadata?.gatheredJobCount === expected.gatheredJobCount
          && stored.reportMetadata?.candidatePoolJobCount === expected.jobs.length
          && stored.reportMetadata?.descriptionRecoveryJobCount === expected.descriptionRecoveryJobs.length
          && !Object.hasOwn(stored.reportMetadata, 'injected'),
        'the writer prepends a fresh, bounded envelope derived from the actual snapshot instead of persisting supplied diagnostic metadata');
      };
      try {
        await fs.promises.mkdir(root, { recursive: true });
        await __saveJobAnalysisSnapshotForTests(initial);
        const current = await read(paths.jsonPath);
        const lastSuccess = await read(paths.lastSuccessJsonPath);
        assertMetadata(current, initial);
        assertMetadata(lastSuccess, initial);
        assert(current.marker === initial.marker && lastSuccess.marker === initial.marker
          && current.jobs[0].title === initial.jobs[0].title
          && current.reportMetadata.candidatePoolJobCount === lastSuccess.reportMetadata.candidatePoolJobCount,
        'current and populated last-success snapshots retain identical runtime payload semantics and metadata counts');
        const resumed = await __loadJobAnalysisSnapshotForTests(canvas, hubId, initial.runId);
        assert(resumed.origin === 'current'
          && resumed.snapshot.marker === initial.marker
          && resumed.snapshot.reportMetadata?.sourceHubId === hubId
          && !Object.hasOwn(resumed.snapshot.reportMetadata || {}, 'injected'),
        'the extra diagnostic envelope is inert to the normal exact-owner resume reader and cannot revive supplied metadata');

        // JSON enumerates array-index property names ahead of normal string
        // names. The report reader relies on a physically first envelope, so
        // an unexpected future top-level numeric field must not displace it.
        const numericTopLevel = { ...initial, 0: 'future top-level field' };
        await __saveJobAnalysisSnapshotForTests(numericTopLevel);
        const numericSerialized = await fs.promises.readFile(paths.jsonPath, 'utf8');
        assert(/^\{\n\x20{2}"reportMetadata":/.test(numericSerialized)
          && JSON.parse(numericSerialized)['0'] === 'future top-level field',
        'the writer keeps reportMetadata physically first even when a future snapshot has an array-index-like top-level key');

        const inconsistentCounts = {
          ...initial,
          gatheredJobCount: 2,
          jobs: [{ title: 'Only retained candidate' }],
        };
        await __saveJobAnalysisSnapshotForTests(inconsistentCounts);
        const inconsistentStored = await read(paths.jsonPath);
        assert(!Object.hasOwn(inconsistentStored, 'reportMetadata')
          && inconsistentStored.gatheredJobCount === 2
          && inconsistentStored.jobs.length === 1,
        'an impossible score-ready/candidate-pool count pair preserves the resume payload but omits diagnostic metadata the reader would reject');

        // The bounded report reader deliberately treats the Unix epoch as an
        // unrecorded timestamp. Preserve this legacy/test payload without
        // emitting an envelope that its reader will necessarily reject.
        const epochSnapshot = {
          ...initial,
          createdAt: '1970-01-01T00:00:00.000Z',
          marker: 'epoch-runtime-payload',
        };
        await __saveJobAnalysisSnapshotForTests(epochSnapshot);
        const epochCurrent = await read(paths.jsonPath);
        const epochLastSuccess = await read(paths.lastSuccessJsonPath);
        assert(!Object.hasOwn(epochCurrent, 'reportMetadata')
          && !Object.hasOwn(epochLastSuccess, 'reportMetadata')
          && epochCurrent.createdAt === epochSnapshot.createdAt
          && epochLastSuccess.marker === epochSnapshot.marker,
        'an epoch-zero timestamp preserves current and last-success payloads without a diagnostic envelope the bounded reader rejects as unrecorded');

        const rewritten = {
          ...initial,
          createdAt: '2026-09-13T08:01:00.000Z',
          gatheredJobCount: 2,
          jobs: [{ title: 'First saved job' }, { title: 'Recovered second job' }],
          descriptionRecoveryJobs: [{ title: 'Deferred recovery job' }],
          marker: 'recovery-rewrite-runtime-payload',
          reportMetadata: { schemaVersion: 0, sourceHubId: 'stale-spoof' },
        };
        await __createDescriptionRecoveryCheckpointForTests(rewritten);
        const recoveryResult = await __saveDescriptionRecoverySnapshotIfCurrentForTests(
          rewritten, { nodeId: hubId, jobRunId: initial.runId },
        );
        const rewrittenCurrent = await read(paths.jsonPath);
        const rewrittenLastSuccess = await read(paths.lastSuccessJsonPath);
        assert(recoveryResult.saved === true && recoveryResult.globalSaved === true
          && rewrittenCurrent.marker === rewritten.marker
          && rewrittenLastSuccess.marker === rewritten.marker,
        'the update-only description-recovery writer replaces both populated snapshot generations after its ownership checkpoint succeeds');
        assertMetadata(rewrittenCurrent, rewritten);
        assertMetadata(rewrittenLastSuccess, rewritten);
        return { currentAndLastSuccess: true, recoveryRewrite: true };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'description recovery serializes same-run source writes and cannot overwrite a reset run',
    run: async () => {
      const mutex = createDescriptionRecoveryMutex();
      const order = [];
      let releaseFirst;
      let firstStarted;
      const firstReady = new Promise(resolve => { firstStarted = resolve; });
      const first = mutex.run('canvas\u0000hub\u0000run-a', null, async () => {
        order.push('google-start');
        firstStarted();
        await new Promise(resolve => { releaseFirst = resolve; });
        order.push('google-end');
      });
      await firstReady;
      let linkedInStarted = false;
      const second = mutex.run('canvas\u0000hub\u0000run-a', null, async () => {
        linkedInStarted = true;
        order.push('linkedin-start');
      });
      await Promise.resolve();
      assert(!linkedInStarted,
        'Google and LinkedIn Solve transactions for the same canvas/hub/run never overlap their snapshot read-modify-write windows');
      releaseFirst();
      await Promise.all([first, second]);
      assert(order.join(',') === 'google-start,google-end,linkedin-start' && mutex.size() === 0,
        'queued recovery work runs in order and releases its scoped mutex key after completion');

      const root = path.join('/tmp', `ic-recovery-cas-${process.pid}-${Date.now()}`);
      const canvas = path.join(root, 'canvas.json');
      const paths = getJobAnalysisPaths(canvas, path.join(root, 'unsaved'), 'hub');
      const runA = { canvasFilePath: canvas, sourceHubId: 'hub', nodeId: 'hub', runId: 'run-a', jobs: [], gatheredJobCount: 0, marker: 'A' };
      const runB = { ...runA, runId: 'run-b', marker: 'B' };
      try {
        await fs.promises.mkdir(root, { recursive: true });
        await fs.promises.writeFile(paths.jsonPath, JSON.stringify(runA));
        await __createDescriptionRecoveryCheckpointForTests(runA);
        // Simulate Reset/new run B winning while A's long browser Solve is still
        // outstanding. A's final compare-and-swap must leave B untouched.
        await fs.promises.writeFile(paths.jsonPath, JSON.stringify(runB));
        const result = await __saveDescriptionRecoverySnapshotIfCurrentForTests(
          { ...runA, marker: 'A-late' }, { nodeId: 'hub', jobRunId: 'run-a' },
        );
        const after = JSON.parse(await fs.promises.readFile(paths.jsonPath, 'utf8'));
        assert(result.saved === true && result.globalSaved === false && result.reason === 'superseded' && after.marker === 'B' && after.runId === 'run-b',
          'a late Solve persistence compare-and-swap cannot overwrite a newer reset/re-run snapshot');
        await __createDescriptionRecoveryCheckpointForTests(runB);
        const restoredA = await __loadDescriptionRecoveryCheckpointForTests(canvas, 'hub', 'run-a');
        const checkpointListing = listDescriptionRecoveryCheckpointsSync(canvas);
        assert(restoredA.snapshot.marker === 'A-late'
          && checkpointListing.checkpoints.length === 2
          && checkpointListing.checkpoints.some(checkpoint => checkpoint.runId === 'run-a')
          && checkpointListing.checkpoints.some(checkpoint => checkpoint.runId === 'run-b'),
        'run-keyed recovery checkpoints coexist, so hub A can continue Solve after hub B updates the canvas-global analysis snapshot');
        const wrongHubCleanup = await __removeDescriptionRecoveryCheckpointForTests(canvas, 'hub-other', 'run-a');
        const missingHubCleanup = await __removeDescriptionRecoveryCheckpointForTests(canvas, null, 'run-a');
        const afterMisroutedCleanup = await __loadDescriptionRecoveryCheckpointForTests(canvas, 'hub', 'run-a');
        assert(!wrongHubCleanup.removed && wrongHubCleanup.reason === 'ownership-mismatch'
          && !missingHubCleanup.removed && missingHubCleanup.reason === 'missing-ownership'
          && afterMisroutedCleanup.snapshot.marker === 'A-late',
        'a misrouted or unscoped terminal event cannot delete a checkpoint owned by a different hub, even when it carries the same run token');
        const lateUpdate = __saveDescriptionRecoverySnapshotIfCurrentForTests(
          { ...runA, marker: 'A-after-cleanup-request' }, { nodeId: 'hub', jobRunId: 'run-a' },
        );
        const cleanup = __removeDescriptionRecoveryCheckpointForTests(canvas, 'hub', 'run-a');
        await Promise.all([lateUpdate, cleanup]);
        let removedCheckpointRejected = false;
        try { await __loadDescriptionRecoveryCheckpointForTests(canvas, 'hub', 'run-a'); } catch { removedCheckpointRejected = true; }
        const afterReset = await __saveDescriptionRecoverySnapshotIfCurrentForTests(
          { ...runA, marker: 'A-after-reset' }, { nodeId: 'hub', jobRunId: 'run-a' },
        );
        const runC = { ...runA, runId: 'run-c', marker: 'C' };
        const malformedPath = getJobDescriptionRecoveryCheckpointPath(canvas, runC.runId, path.join(root, 'unsaved'));
        await fs.promises.writeFile(malformedPath, '{not json', 'utf8');
        const malformed = await __saveDescriptionRecoverySnapshotIfCurrentForTests(
          { ...runC, marker: 'C-malformed-checkpoint' }, { nodeId: 'hub', jobRunId: runC.runId },
        );
        const runD = { ...runA, runId: 'run-d', marker: 'D' };
        const wrongOwnerPath = getJobDescriptionRecoveryCheckpointPath(canvas, runD.runId, path.join(root, 'unsaved'));
        await fs.promises.writeFile(wrongOwnerPath, JSON.stringify({ ...runD, sourceHubId: 'other-hub', nodeId: 'other-hub' }), 'utf8');
        const wrongOwner = await __saveDescriptionRecoverySnapshotIfCurrentForTests(
          { ...runD, marker: 'D-wrong-owner-checkpoint' }, { nodeId: 'hub', jobRunId: runD.runId },
        );
        assert(removedCheckpointRejected
          && afterReset.saved === false && ['checkpoint-retired', 'checkpoint-unavailable'].includes(afterReset.reason)
          && malformed.saved === false && malformed.reason === 'checkpoint-invalid'
          && wrongOwner.saved === false && wrongOwner.reason === 'ownership-mismatch',
        `cleanup serialized after an in-flight recovery update removes that exact run checkpoint, and every update-only missing/invalid/foreign result is surfaced rather than silently reported as persisted: ${JSON.stringify({ removedCheckpointRejected, afterReset, malformed, wrongOwner })}`);
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
      return { serialized: true, resetSafe: true };
    },
  },
  {
    name: 'deleting a Job Search hub retires its exact paused or not-yet-created recovery checkpoint',
    run: async () => {
      const root = path.join('/tmp', `ic-job-delete-recovery-${process.pid}-${Date.now()}`);
      const pausedCanvas = path.join(root, 'paused.json');
      const writingCanvas = path.join(root, 'writing.json');
      const snapshot = (canvasFilePath, nodeId, runId) => ({
        canvasFilePath, sourceHubId: nodeId, nodeId, runId,
        jobs: [{ title: 'private test row' }],
        descriptionRecoveryJobs: [{ title: 'private test row', source: 'google' }],
        gatheredJobCount: 1,
      });
      try {
        await fs.promises.mkdir(root, { recursive: true });

        await startRun(pausedCanvas, {
          runId: 'paused-run', startedAt: 1, nodeId: 'paused-hub',
          queries: ['architect'], sourceIds: ['google'],
        });
        await __createDescriptionRecoveryCheckpointForTests(snapshot(pausedCanvas, 'paused-hub', 'paused-run'));
        const pausedDiscards = collectDeletedJobRunDiscards([{
          id: 'paused-hub', type: 'jobhub', data: { hubState: 'sources-ready', jobRunId: 'paused-run' },
        }], pausedCanvas);
        assert(pausedDiscards.length === 1
          && pausedDiscards[0].nodeId === 'paused-hub'
          && pausedDiscards[0].runId === 'paused-run',
        'the centralized canvas-deletion path captures the exact paused hub/run instead of relying on component unmount');
        const analysisDiscards = collectDeletedJobAnalysisDiscards([
          { id: 'removed-hub', type: 'jobhub', data: { hubState: 'done', jobRunId: 'completed-run' } },
          {
            id: 'removed-container', type: 'group', data: {
              canvasData: { nodes: [{ id: 'nested-hub', type: 'jobhub', data: { locked: true, hubState: 'done', jobRunId: 'nested-run' } }] },
            },
          },
          { id: 'completed-no-run', type: 'jobhub', data: { hubState: 'done' } },
        ], pausedCanvas, 12345);
        assert(analysisDiscards.length === 3
          && analysisDiscards[0].nodeId === 'removed-hub'
          && analysisDiscards[0].runId === 'completed-run'
          && analysisDiscards[0].clearedAt === 12345
          && analysisDiscards[1].nodeId === 'nested-hub'
          && analysisDiscards[1].runId === 'nested-run'
          && analysisDiscards[2].nodeId === 'completed-no-run'
          && analysisDiscards[2].runId == null,
        'committed canvas deletion captures every actually removed Job Search hub, including a locked descendant of an unlocked deleted container and a completed hub with no live run');
        const topLevelLocked = { id: 'locked-hub', type: 'jobhub', data: { locked: true, hubState: 'done', jobRunId: 'locked-run' } };
        const removedRoots = [topLevelLocked, { id: 'unlocked-hub', type: 'jobhub', data: { hubState: 'done', jobRunId: 'unlocked-run' } }]
          .filter(node => !node.data?.locked);
        const clearCanvasDiscards = collectDeletedJobAnalysisDiscards(removedRoots, pausedCanvas, 12346);
        assert(clearCanvasDiscards.length === 1 && clearCanvasDiscards[0].nodeId === 'unlocked-hub'
          && !clearCanvasDiscards.some(discard => discard.nodeId === 'locked-hub'),
        'Clear Canvas excludes its top-level locked root before handing the actually removed roots to shared analysis cleanup');
        const deletionHook = fs.readFileSync(path.resolve('src/hooks/useCanvasOSDeletion.js'), 'utf8');
        const deletionLifecycle = fs.readFileSync(path.resolve('src/utils/nodeDeletionLifecycle.js'), 'utf8');
        const canvas = fs.readFileSync(path.resolve('src/Canvas.jsx'), 'utf8');
        const canvasActions = fs.readFileSync(path.resolve('src/hooks/useCanvasActions.js'), 'utf8');
        const promptStart = deletionHook.indexOf('if (osPaths.length > 0 && window.electronAPI)');
        const abortResolve = deletionHook.indexOf("onAbort: () => resolve('abort')", promptStart);
        const abortReturn = deletionHook.indexOf("if (diskChoice === 'abort') return rejectDeletion();", abortResolve);
        const deletionTextSettle = deletionHook.indexOf('textDocumentSessions.flushAndSettlePaths(orphanTextPaths)', abortReturn);
        const boardCancellation = deletionHook.indexOf('await Promise.all(boardCancellations);', deletionTextSettle);
        const manualRetirement = deletionHook.indexOf('await retireDeletedManualAiRuns(cleanupDeletedNodes);', boardCancellation);
        const activeBoardReferences = deletionLifecycle.indexOf('function getActiveJobBoardSearchReferenceIds(board)');
        const cleanupOnlyReferenceExclusion = deletionLifecycle.indexOf('manual?.retirementPending === true', activeBoardReferences);
        const edgeConnectedBoardGuard = deletionLifecycle.indexOf('(edge?.source === node.id && deletedSearchIds.has(edge?.target))', activeBoardReferences);
        const affectedBoardElection = deletionHook.indexOf('collectJobBoardsAffectedByDeletion(', deletionTextSettle);
        const nullRunCancellation = deletionHook.indexOf('boardRunId: null,', affectedBoardElection);
        const safeIdleNone = deletionHook.indexOf("if (result?.status === 'none')", nullRunCancellation);
        const staleBoardRejected = deletionHook.indexOf("result?.status === 'stale'", safeIdleNone);
        const unavailableIdleBoard = deletionHook.indexOf('!boardWillBeDeleted && jobBoardHasCancellableRecovery(board)', staleBoardRejected);
        const staleChildRejected = deletionHook.indexOf("result?.status === 'stale'", unavailableIdleBoard);
        const deletionCommit = deletionHook.indexOf('const commitLevelNodes = getNodes?.() ?? cleanupSnapshotNodes;', manualRetirement);
        const queuedDeletionCommit = deletionHook.indexOf('const pendingCommits = committedTransactionsRef.current.get(transactionKey) || [];', deletionCommit);
        const postCommit = deletionHook.indexOf('const onNodesDelete = useCallback((committedNodes) => {', deletionCommit);
        const consumeQueuedDeletionCommit = deletionHook.indexOf('const transaction = pendingCommits?.shift();', postCommit);
        const postCommitRunDiscard = deletionHook.indexOf('discardDeletedJobRuns(deletedNodes, canvasFilePath', postCommit);
        const clearStart = canvasActions.indexOf('const doClear = useCallback(async () =>');
        const clearLifecycleMark = canvasActions.indexOf('markJobWorkflowDeletionPending(removedNodes)', clearStart);
        const clearBoardElection = canvasActions.indexOf('collectJobBoardsAffectedByDeletion(', clearLifecycleMark);
        const clearBoardCancellation = canvasActions.indexOf('jobSearchCoordinator.cancelBoardModule(board.id', clearBoardElection);
        const clearNullRunCancellation = canvasActions.indexOf('boardRunId: null,', clearBoardCancellation);
        const clearManualRetirement = canvasActions.indexOf('await retireDeletedManualAiRuns(removedNodes);', clearStart);
        const clearFence = canvasActions.indexOf('const clearGraphStayedStable = isClearCanvasDeletionFenceIntact(', clearManualRetirement);
        const clearLivePartition = canvasActions.indexOf('commitRetainedNodes = getClearCanvasRetainedNodes(liveNodesBeforeCommit);', clearFence);
        const clearConcurrentPartition = canvasActions.indexOf('removedIds.has(node.id) || removedWorkflowIds.has(node.data?.hubId)', clearLivePartition);
        const clearAbortLifecycleSettlement = canvasActions.indexOf('settlePendingLifecycle();', clearManualRetirement);
        const clearRawCancellation = canvasActions.indexOf('cancelNodeTasksRecursively(commitRemovedNodes || removedNodes);', clearManualRetirement);
        const clearSnapshot = canvasActions.indexOf('takeSnapshot();', clearRawCancellation);
        const clearVisualCommit = canvasActions.indexOf('setNodes(commitRetainedNodes);', clearSnapshot);
        const clearPreflight = canvasActions.indexOf('const preflightClear = useCallback(async () =>', clearVisualCommit);
        const clearPreflightPartition = canvasActions.indexOf('getClearCanvasRetainedNodes(allNodes).map(node => node.id)', clearPreflight);
        const clearTextSettle = canvasActions.indexOf('textDocumentSessions.flushAndSettlePaths(orphanTextPaths)', clearPreflight);
        const clearInvoke = canvasActions.indexOf('await doClear();', clearTextSettle);
        assert(canvas.includes('const { onBeforeDelete, onNodesDelete } = useCanvasOSDeletion({')
          && canvas.includes('canvasFilePath: currentFile,\n    addToast,')
          && canvas.includes('enumerateAllNodes: navigation.enumerateAllNodes,')
          && canvas.includes('getNodes,\n    getEdges,\n    setNodes,')
          && canvas.includes('onBeforeDelete={onBeforeDelete}')
          && promptStart >= 0 && abortResolve > promptStart && abortReturn > abortResolve
          && deletionTextSettle > abortReturn
          && boardCancellation > deletionTextSettle
          && manualRetirement > boardCancellation
          && activeBoardReferences >= 0
          && cleanupOnlyReferenceExclusion > activeBoardReferences
          && edgeConnectedBoardGuard > activeBoardReferences
          && affectedBoardElection > deletionTextSettle
          && nullRunCancellation > affectedBoardElection
          && safeIdleNone > nullRunCancellation
          && deletionHook.includes('if (!latestBoard || !jobBoardHasCancellableRecovery(latestBoard)) return;')
          && staleBoardRejected > safeIdleNone
          && unavailableIdleBoard > staleBoardRejected
          && staleChildRejected > unavailableIdleBoard
          && deletionHook.includes('The affected Job Board changed while deletion was pending. Try deleting again.')
          && deletionHook.includes('active Search changed while deletion was pending. Try deleting again.')
          && deletionCommit > manualRetirement
          && queuedDeletionCommit > deletionCommit
          && deletionHook.includes('return rejectDeletion(\n        error?.manualAiRetirementReceipts,\n        cleanupSnapshotNodes,\n        cleanupWorkflowIds,')
          && postCommit > deletionCommit
          && consumeQueuedDeletionCommit > postCommit
          && postCommitRunDiscard > postCommit
          && deletionHook.includes('discardDeletedJobAnalysisSnapshots(deletedNodes, canvasFilePath')
          && deletionHook.includes('Hub deleted with a warning')
          && clearStart >= 0
          && clearLifecycleMark > clearStart
          && clearBoardElection > clearLifecycleMark
          && clearBoardCancellation > clearBoardElection
          && clearNullRunCancellation > clearBoardCancellation
          && clearManualRetirement > clearStart
          && clearManualRetirement > clearNullRunCancellation
          && clearFence > clearManualRetirement
          && clearLivePartition > clearFence
          && clearConcurrentPartition > clearLivePartition
          && clearAbortLifecycleSettlement > clearManualRetirement
          && clearRawCancellation > clearManualRetirement
          && clearSnapshot > clearRawCancellation
          && clearVisualCommit > clearSnapshot
          && canvasActions.includes('error.manualAiRetirementReceipts')
          && canvasActions.includes('restoreJobWorkflowSnapshots(')
          && canvasActions.includes('setTimeout(settlePendingLifecycle, 0);')
          && canvasActions.includes('const retainedNodes = getClearCanvasRetainedNodes(allNodes);')
          && canvasActions.includes('Clear Canvas preserved nodes added or rewired during acknowledged cleanup.')
          && canvasActions.includes('(e) => commitRetainedIds.has(e.source) && commitRetainedIds.has(e.target)')
          && canvasActions.includes('discardDeletedJobRuns(')
          && canvasActions.includes('discardDeletedJobAnalysisSnapshots(')
          && canvasActions.includes('Canvas cleared with a warning')
          && clearPreflight > clearVisualCommit
          && clearPreflightPartition > clearPreflight
          && clearTextSettle > clearPreflightPartition
          && clearTextSettle > clearPreflight
          && clearInvoke > clearTextSettle,
        'interactive deletion and Clear Canvas settle text first, acknowledge Board/Search cancellation and durable manual-AI retirement before visual removal, revalidate stale Board ownership without treating cleanup-only receipts as input reservations, restore exact retry receipts on failure, and discard run sidecars only after commit');
        const priorWindow = globalThis.window;
        const cleanupFailures = [];
        try {
          globalThis.window = {
            electronAPI: {
              discardJobRun: async () => undefined,
              discardJobAnalysisSnapshot: async () => ({ success: true, ok: false, reason: 'unknown' }),
            },
          };
          const deletedHub = [{ id: 'failed-cleanup-hub', type: 'jobhub', data: { jobRunId: 'failed-cleanup-run' } }];
          discardDeletedJobRuns(deletedHub, pausedCanvas, (...args) => cleanupFailures.push(['run', ...args]));
          discardDeletedJobAnalysisSnapshots(deletedHub, pausedCanvas, (...args) => cleanupFailures.push(['analysis', ...args]), 12347);
          await new Promise(resolve => setImmediate(resolve));
          assert(cleanupFailures.some(([kind, error]) => kind === 'run' && /cleanup failed/i.test(error.message))
            && cleanupFailures.some(([kind, error]) => kind === 'analysis' && /cleanup failed/i.test(error.message)),
          'committed deletion treats missing or malformed fulfilled cleanup IPC replies as failures instead of silently claiming recovery was retired');
        } finally {
          globalThis.window = priorWindow;
        }
        const foreignCleanup = await __discardOwnedJobRunForTests(pausedCanvas, 'different-hub', 'paused-run');
        const afterForeignCleanup = await readRunState(pausedCanvas, Date.now());
        const checkpointAfterForeignCleanup = await __loadDescriptionRecoveryCheckpointForTests(
          pausedCanvas, 'paused-hub', 'paused-run',
        );
        assert(foreignCleanup.cleared === false
          && foreignCleanup.checkpointCleanup.reason === 'ownership-mismatch'
          && afterForeignCleanup?.manifest?.runId === 'paused-run'
          && checkpointAfterForeignCleanup?.snapshot?.nodeId === 'paused-hub',
        'deletion cleanup requires the exact hub+run owner and cannot erase another hub with the same supplied token');
        const pausedCleanup = await __discardOwnedJobRunForTests(
          pausedDiscards[0].canvasFilePath, pausedDiscards[0].nodeId, pausedDiscards[0].runId,
        );
        let pausedCheckpointExists = true;
        try { await __loadDescriptionRecoveryCheckpointForTests(pausedCanvas, 'paused-hub', 'paused-run'); }
        catch { pausedCheckpointExists = false; }
        const nextPausedRun = await startRun(pausedCanvas, {
          runId: 'next-paused-run', startedAt: 2, nodeId: 'next-hub',
          queries: ['architect'], sourceIds: ['google'],
        });
        assert(pausedCleanup.cleared === true && pausedCleanup.checkpointCleanup.removed === true
          && !pausedCheckpointExists && nextPausedRun?.runId === 'next-paused-run',
        'deleting a sources-ready hub clears its manifest and full-data checkpoint so another hub can start');

        await startRun(writingCanvas, {
          runId: 'writing-run', startedAt: 3, nodeId: 'writing-hub',
          queries: ['architect'], sourceIds: ['google'],
        });
        // The renderer stamps jobRunId before awaiting the pre-score write. Model
        // deletion arriving while the ordinary global snapshot is still writing:
        // cleanup sees no checkpoint yet, then that delayed create reaches disk.
        const writingDiscards = collectDeletedJobRunDiscards([{
          id: 'writing-hub', type: 'jobhub', data: { hubState: 'searching', jobRunId: 'writing-run' },
        }], writingCanvas);
        const writingCleanup = await __discardOwnedJobRunForTests(
          writingDiscards[0].canvasFilePath, writingDiscards[0].nodeId, writingDiscards[0].runId,
        );
        const lateCreate = await __createDescriptionRecoveryCheckpointForTests(
          snapshot(writingCanvas, 'writing-hub', 'writing-run'),
        );
        const nextWritingRun = await startRun(writingCanvas, {
          runId: 'next-writing-run', startedAt: 4, nodeId: 'next-hub',
          queries: ['architect'], sourceIds: ['google'],
        });
        assert(writingCleanup.cleared === true
          && writingCleanup.checkpointCleanup.removed === false
          && lateCreate.saved === false && lateCreate.reason === 'checkpoint-retired'
          && nextWritingRun?.runId === 'next-writing-run',
        'deletion-before-checkpoint creates a tombstone, so the delayed pre-score create cannot resurrect the deleted run and another hub can start');

        const unsavedNodeId = `unsaved-hub-${process.pid}-${Date.now()}`;
        const unsavedRunId = `unsaved-run-${process.pid}-${Date.now()}`;
        await __createDescriptionRecoveryCheckpointForTests(snapshot(null, unsavedNodeId, unsavedRunId));
        const unsavedDiscards = collectDeletedJobRunDiscards([{
          id: unsavedNodeId, type: 'jobhub', data: { hubState: 'sources-ready', jobRunId: unsavedRunId },
        }], null);
        const unsavedCleanup = await __discardOwnedJobRunForTests(
          unsavedDiscards[0]?.canvasFilePath, unsavedDiscards[0]?.nodeId, unsavedDiscards[0]?.runId,
        );
        let unsavedCheckpointExists = true;
        try { await __loadDescriptionRecoveryCheckpointForTests(null, unsavedNodeId, unsavedRunId); }
        catch { unsavedCheckpointExists = false; }
        assert(unsavedDiscards.length === 1
          && unsavedDiscards[0].canvasFilePath === null
          && unsavedCleanup.cleared === false
          && unsavedCleanup.checkpointCleanup.removed === true
          && !unsavedCheckpointExists,
        'deleting an unsaved hub removes its private app-data checkpoint even though it has no manifest');

        const jobsSource = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
        const genericResolveStart = jobsSource.indexOf('const runGenericResolve = async () => {');
        const genericResolveEnd = jobsSource.indexOf("handleSafe('resume-job-source'", genericResolveStart);
        const genericResolve = jobsSource.slice(genericResolveStart, genericResolveEnd);
        assert(genericResolve.includes('loadDescriptionRecoveryCheckpoint(canvasFilePath, nodeId, jobRunId)')
          && !genericResolve.includes('description recovery needs the current saved search snapshot'),
        'an unsaved hub can use its exact private app-data checkpoint for Source Solve instead of being rejected solely for lacking a canvas path');
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
      return { pausedDeleted: true, inFlightCreateRetired: true };
    },
  },
  {
    name: 'durable source actions remain valid after restart or another canvas takes telemetry ownership',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join('/tmp', 'ic-durable-source-action-'));
      const canvasA = path.join(root, 'a.json');
      const telemetry = getJobsTelemetry();
      const saved = { nodeId: telemetry.nodeId, pipeline: telemetry.pipeline };
      try {
        await startRun(canvasA, { runId: 'run-a', startedAt: Date.now(), nodeId: 'hub-a', sourceIds: ['indeed'] });
        assert(!(await __canPerformJobSourceActionForTests(canvasA, 'hub-a', 'run-a')),
          'a still-searching manifest cannot authorize an early/stale source-card action');
        await setStage(canvasA, 'gathered');
        Object.assign(telemetry, { nodeId: 'hub-b', pipeline: { runId: 'run-b', active: true } });
        assert(await __canPerformJobSourceActionForTests(canvasA, 'hub-a', 'run-a')
          && !__canWriteJobResolveTelemetryForTests('hub-a', 'run-a')
          && await __canPerformJobSourceActionForTests(null, 'unsaved-a', 'unsaved-run-a')
          && !(await __canPerformJobSourceActionForTests(canvasA, 'hub-a', 'wrong-run')),
        'a gathered exact hub/run—and an unsaved tokened card—authorizes its recovery action after another canvas owns live telemetry, while searching/stale tokens remain blocked and cannot write into that telemetry');
      } finally {
        Object.assign(telemetry, saved);
        await fs.promises.rm(root, { recursive: true, force: true });
      }
      return { durableAuthorized: true };
    },
  },
  {
    name: 'checkpoint-owned blocked source URLs continue in order without leaking into diagnostics',
    run: async () => {
      const initial = {
        glassdoor: {
          blockedUrls: [
            'https://www.glassdoor.com/Job/jobs.htm?kw=architect',
            'https://www.glassdoor.com/Job/jobs.htm?kw=platform',
            'https://www.glassdoor.com/Job/jobs.htm?kw=ai',
            'https://www.glassdoor.com/Job/jobs.htm?kw=platform',
          ],
          consecutiveNoMatchPasses: 1,
        },
      };
      const afterQ1 = __consumeRecoveryBlockedUrlForTests(initial, 'glassdoor', initial.glassdoor.blockedUrls[0]);
      const root = await fs.promises.mkdtemp(path.join('/tmp', 'ic-blocked-url-queue-'));
      const canvas = path.join(root, 'queue.json');
      const runId = 'queue-run';
      const nodeId = 'queue-hub';
      try {
        const checkpoint = {
          sourceHubId: nodeId, nodeId, runId, canvasFilePath: canvas,
          jobs: [], descriptionRecoveryJobs: [], descriptionRecoveryState: initial,
        };
        await __createDescriptionRecoveryCheckpointForTests(checkpoint);
        await __saveDescriptionRecoverySnapshotIfCurrentForTests({
          ...checkpoint, descriptionRecoveryState: afterQ1.state,
        }, { nodeId, jobRunId: runId });
        // Simulated restart: reload only the sidecar; process telemetry is not
        // consulted before q2/q3 are consumed.
        const restarted = await __loadDescriptionRecoveryCheckpointForTests(canvas, nodeId, runId);
        const afterQ2 = __consumeRecoveryBlockedUrlForTests(
          restarted.snapshot.descriptionRecoveryState, 'glassdoor', afterQ1.remaining[0],
        );
        const afterQ3 = __consumeRecoveryBlockedUrlForTests(afterQ2.state, 'glassdoor', afterQ2.remaining[0]);
        assert(afterQ1.remaining.length === 2
          && afterQ1.remaining[0].includes('platform')
          && afterQ2.remaining.length === 1 && afterQ2.remaining[0].includes('kw=ai')
          && afterQ3.remaining.length === 0
          && afterQ2.state.glassdoor.consecutiveNoMatchPasses === 1,
        'three configured blocked queries are persisted and consumed q1→q2→q3 from the exact checkpoint, preserving unrelated recovery guidance');
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
      const source = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
      const snapshotReport = fs.readFileSync(path.resolve('electron/ipc/bugReport/jobsSnapshot.js'), 'utf8');
      assert(source.includes('const blockedUrls = orderedBlockedManualSourceUrls(')
        && source.includes('loadDescriptionRecoveryCheckpoint(canvasFilePath, nodeId, jobRunId)')
        && source.includes('return withDescriptionRecoveryLock({ canvasFilePath, nodeId, jobRunId, signal }, runGenericResolve);')
        && source.includes('checkpointRemainingUrls = consumedQueue.remaining')
        && source.includes('descriptionRecoveryJobs, descriptionRecoveryState, profile, careerData')
        && source.includes('buildJobAnalysisSnapshot({ jobs, descriptionRecoveryJobs, descriptionRecoveryState, profile')
        && !snapshotReport.includes('blockedUrls'),
      'configured URL queues are checkpoint-owned for every generic resolver and are not emitted in JOBRESOLVE report metadata');
      const q2 = 'https://www.glassdoor.com/Job/jobs.htm?kw=platform&locId=123&locT=C';
      const ordered = orderedBlockedManualSourceUrls([
        { id: 'glassdoor-1', sourceId: 'glassdoor', query: 'architect', url: 'https://www.glassdoor.com/Job/jobs.htm?kw=architect' },
        { id: 'glassdoor-2', sourceId: 'glassdoor', query: 'platform', url: 'https://www.glassdoor.com/Job/jobs.htm?kw=platform' },
        { id: 'glassdoor-3', sourceId: 'glassdoor', query: 'ai', url: 'https://www.glassdoor.com/Job/jobs.htm?kw=ai' },
      ], 'glassdoor', [
        { query: 'architect', url: 'https://www.glassdoor.com/Job/jobs.htm?kw=architect&locId=123&locT=C' },
        { query: 'platform', url: q2 },
      ]);
      assert(ordered.length === 2 && ordered[0] === q2
        && ordered[1].includes('kw=ai') && ordered[1].includes('locId=123') && ordered[1].includes('locT=C'),
      'a q2 Glassdoor wall re-arms the card at q2 and queues only q3 with its resolved location scope retained');
      const detailBlocked = orderedBlockedManualSourceUrls([
        { sourceId: 'google', query: 'q1', url: 'https://www.google.com/search?q=q1' },
        { sourceId: 'google', query: 'q2', url: 'https://www.google.com/search?q=q2' },
        { sourceId: 'google', query: 'q3', url: 'https://www.google.com/search?q=q3' },
      ], 'google', [
        { query: 'q1', url: 'https://www.google.com/search?q=q1' },
        { query: 'q2', url: 'https://www.google.com/search?q=q2' },
        { query: 'q3', url: 'https://www.google.com/search?q=q3' },
      ], 'q1');
      assert(detailBlocked.length === 3 && detailBlocked[0].includes('q=q1')
        && detailBlocked[1].includes('q=q2') && detailBlocked[2].includes('q=q3'),
      'a q1 detail-enrichment block retains q1→q2→q3 even if the scraper later re-probes through q3');
      const indexedBlankQueryBlock = orderedBlockedManualSourceUrls([
        { sourceId: 'google', query: '', url: 'https://www.google.com/search?q=first' },
        { sourceId: 'google', query: '', url: 'https://www.google.com/search?q=second' },
        { sourceId: 'google', query: '', url: 'https://www.google.com/search?q=third' },
      ], 'google', [
        { query: '', url: 'https://www.google.com/search?q=first' },
        { query: '', url: 'https://www.google.com/search?q=second' },
        { query: '', url: 'https://www.google.com/search?q=third' },
      ], null, 0);
      assert(indexedBlankQueryBlock.length === 3
        && indexedBlankQueryBlock[0].includes('q=first')
        && indexedBlankQueryBlock[1].includes('q=second')
        && indexedBlankQueryBlock[2].includes('q=third'),
      'the explicit first-block index selects the matching executed URL even when query text is blank or duplicated');
      return { q2: afterQ1.remaining[0] };
    },
  },
  {
    name: 'late generic Solve, Indeed Continue, and merge telemetry cannot decorate a newer tokened run',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId,
        pipeline: telemetry.pipeline,
        resolves: telemetry.resolves,
        resumeAttempts: telemetry.resumeAttempts,
      };
      try {
        Object.assign(telemetry, {
          nodeId: 'hub-b',
          pipeline: { runId: 'run-b', phase: 'sources-ready', active: false },
          resolves: { glassdoor: { kind: 'current-b', cumulativeMergeNet: 7 } },
          resumeAttempts: {},
        });
        const staleMerge = recordResolveMergeOutcome(
          'glassdoor',
          { replacedExisting: 1, fresh: 9, pendingBefore: 3, pendingAfter: 11 },
          { nodeId: 'hub-a', jobRunId: 'run-a' },
        );
        const staleLinkedIn = recordLinkedinResolveAttempt(
          'linkedin',
          { kind: 'stale-a' },
          { nodeId: 'hub-a', jobRunId: 'run-a' },
        );
        __recordResumeAttemptForTests('indeed', 'retry-later', 'resolved', 'current B', { nodeId: 'hub-b', jobRunId: 'run-b' });
        __recordResumeAttemptForTests('indeed', 'retry-later', 'resolved', 'late A', { nodeId: 'hub-a', jobRunId: 'run-a' });
        // A rejected B must not roll back diagnostics once a newer C has
        // claimed them while B's manifest check was in flight.
        Object.assign(telemetry, { nodeId: 'hub-c', pipeline: { runId: 'run-c', active: true } });
        const staleRestore = __restoreJobsTelemetryIfCurrentRunForTests(
          'hub-b', 'run-b', { nodeId: 'hub-a', pipeline: { runId: 'run-a', active: true } },
        );
        Object.assign(telemetry, { nodeId: 'hub-b', pipeline: { runId: 'run-b', active: true } });
        const ownedRestore = __restoreJobsTelemetryIfCurrentRunForTests(
          'hub-b', 'run-b', { nodeId: 'hub-a', pipeline: { runId: 'run-a', active: true } },
        );
        assert(__canWriteJobResolveTelemetryForTests('hub-a', 'run-a')
          && !__canWriteJobResolveTelemetryForTests('hub-b', 'run-b')
          && staleRestore === false && ownedRestore === true
          && telemetry.nodeId === 'hub-a' && telemetry.pipeline?.runId === 'run-a'
          && staleMerge === null && staleLinkedIn === null
          && telemetry.resolves.glassdoor.kind === 'current-b'
          && !telemetry.resolves.linkedin
          && telemetry.resumeAttempts.indeed?.length === 1
          && telemetry.resumeAttempts.indeed[0].detail === 'current B',
        'a late A token (or an ambiguous legacy action) cannot mutate B’s resolve telemetry or Indeed attempt trail, and a failed B cannot clobber a newer telemetry owner');

        const jobsSource = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
        const genericStart = jobsSource.indexOf("handleSafe('resolve-job-source'");
        const resumeStart = jobsSource.indexOf("handleSafe('resume-job-source'");
        const mergeStart = jobsSource.indexOf("ipcMain.handle('record-resolve-merge'");
        const generic = jobsSource.slice(genericStart, resumeStart);
        const resume = jobsSource.slice(resumeStart, mergeStart);
        const renderer = fs.readFileSync(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8');
        assert(generic.indexOf('if (!(await canPerformJobSourceAction(canvasFilePath, nodeId, jobRunId)))') >= 0
          && generic.indexOf('if (!(await canPerformJobSourceAction(canvasFilePath, nodeId, jobRunId)))') < generic.indexOf('const runGenericResolve')
          && resume.indexOf('if (!(await canPerformJobSourceAction(canvasFilePath, nodeId, jobRunId)))') >= 0
          && resume.indexOf('if (!(await canPerformJobSourceAction(canvasFilePath, nodeId, jobRunId)))') < resume.indexOf('const normalizedCollectionLimits')
          && !generic.includes('const telemetryWritable') && !resume.includes('const telemetryWritable')
          && generic.includes('const canWriteTelemetry = () => canWriteJobResolveTelemetry(nodeId, jobRunId);')
          && resume.includes('const canWriteTelemetry = () => canWriteJobResolveTelemetry(nodeId, jobRunId);')
          // Widened with an `observed` argument that carries ONLY enumerated
          // values for the durable receipt; `detail` stays the free-form field
          // the live trail slices. Both recorders bind this handler's own tuple.
          && resume.includes('const recordResumeAttempt = (attemptSourceId, mode, outcome, detail, observed = null) =>')
          && resume.includes('recordResumeAttemptTelemetry(attemptSourceId, mode, outcome, detail, { nodeId, jobRunId });')
          && resume.includes('recordJobSourceResumeAttempt(attemptSourceId, {')
          && jobsSource.slice(mergeStart, mergeStart + 700).includes('{ nodeId, jobRunId }')
          && renderer.includes('nodeId: id,') && renderer.includes('jobRunId: e.detail?.jobRunId || jobRunIdRef.current || null'),
        'generic Solve and Indeed Continue use durable run ownership before browser work, while merge acknowledgements keep the in-memory telemetry ownership tuple');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { staleRunRejected: true };
    },
  },
  {
    name: 'description-recovery Solve accepts only the active run’s current owned snapshot',
    run: () => {
      const active = {
        sourceHubId: 'hub-current',
        nodeId: 'hub-current',
        runId: 'hub-current-42',
      };
      assert(assessDescriptionRecoverySnapshotOwnership({
        snapshot: active, origin: 'current', nodeId: 'hub-current', jobRunId: 'hub-current-42',
      }).ok,
      'a current snapshot with exact hub, node, and run ownership is usable for description recovery');
      for (const args of [
        { snapshot: active, origin: 'current', nodeId: 'hub-current', jobRunId: null },
        { snapshot: active, origin: 'last-success', nodeId: 'hub-current', jobRunId: 'hub-current-42' },
        { snapshot: { ...active, sourceHubId: '' }, origin: 'current', nodeId: 'hub-current', jobRunId: 'hub-current-42' },
        { snapshot: { ...active, nodeId: 'hub-other' }, origin: 'current', nodeId: 'hub-current', jobRunId: 'hub-current-42' },
        { snapshot: { ...active, runId: 'hub-current-41' }, origin: 'current', nodeId: 'hub-current', jobRunId: 'hub-current-42' },
      ]) {
        assert(!assessDescriptionRecoverySnapshotOwnership(args).ok,
          'missing run tokens, last-success fallbacks, incomplete ownership, foreign hubs, and same-hub older runs are never merged into a Solve');
      }
      const activeManifest = { stage: 'searching', runId: 'hub-current-42', inputs: { nodeId: 'hub-current' } };
      assert(isLiveDescriptionRecoveryRun(activeManifest, 'hub-current', 'hub-current-42')
        && isLiveDescriptionRecoveryRun({ ...activeManifest, stage: 'gathered' }, 'hub-current', 'hub-current-42')
        && !isLiveDescriptionRecoveryRun({ ...activeManifest, stage: 'completed' }, 'hub-current', 'hub-current-42')
        && !isLiveDescriptionRecoveryRun({ ...activeManifest, runId: 'hub-current-41' }, 'hub-current', 'hub-current-42'),
      'a mismatched saved snapshot is reported as a not-ready checkpoint while the exact requested hub/run remains unfinished, including the gathered-to-snapshot handoff');

      const source = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
      const genericStart = source.indexOf("handleSafe('resolve-job-source'");
      const resumeStart = source.indexOf("handleSafe('resume-job-source'");
      const generic = source.slice(genericStart, resumeStart);
      assert(generic.includes("const requiresStrictDescriptionRecoverySnapshot = sourceId === 'google' || sourceId === 'linkedin';")
        && generic.includes("descriptionRecoveryNotReadyWarning(resolveSourceLabel(sourceId), 'missing-run-id')")
        && generic.includes('loadDescriptionRecoveryCheckpoint(canvasFilePath, nodeId, jobRunId)')
        && generic.includes('assessDescriptionRecoveryCheckpoint({ snapshot, origin, nodeId, jobRunId, canvasFilePath })')
        && generic.includes("reason === 'current-snapshot-unavailable'"),
      'Google and LinkedIn return a checkpoint-not-ready warning when their current run is not safely attributable, while last-success snapshots are never treated as the card’s hub');
      return { strictOwnership: true };
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
        && generic.includes('removedItemKeys: retiredListingKeys(descriptionEvidence.dropped)')
        && generic.includes('reconcileResolvedDescriptionRecovery(')
        && generic.includes('preloadResolvedJobList(page, sourceId, inlineExtractorJS, signal)')
        && generic.includes('partitionResolvedDescriptionRecoveryCandidates(')
        && generic.includes('nextDescriptionRecoveryGuidance(')
        && generic.includes('[sourceId]: { ...(sourceRecoverySnapshot?.descriptionRecoveryState?.[sourceId] || {}), ...guidanceOutcome.state }')
        && generic.includes('consecutiveNoMatchPasses: guidanceOutcome.guidance.consecutiveNoMatchPasses')
        && generic.includes('buildPhysicalCardWalkPlan(providerRows, candidates)')
        && generic.includes("replaceSourceItems: sourceId === 'google' && !!sourceRecoverySnapshot")
        && !generic.includes('providerGathered: Math.max(0, Number(prior.providerGathered ?? prior.gathered ?? prior.count) || 0) + extractedRaw.length')
        && generic.includes('resolveFunnel: {')
        && generic.includes('recordJobSourceProgress(resolveProgress, { updatePipeline: false, expectedNodeId: nodeId })'),
      'generic non-LinkedIn Solve preserves its actionable warning, removes rejected rows, and records a terminal post-search progress event');
      assert(resume.includes('historyDropSamples = deduped.samples || [];')
        && resume.includes('jobRunId = null')
        && resume.includes('repairJobsMojibake(items);')
        && resume.includes('normalizeJobsMarkup(items);')
        && resume.includes('const descriptionEvidence = filterJobsByDescriptionEvidence(items);')
        && resume.includes('tagJobLanguages(items);')
        && resume.includes('jobsTelemetry.resolves[sourceId] = {')
        && resume.includes('resumeFunnel: {')
        && resume.includes('providerGathered: Math.max(0, Number(prior.providerGathered ?? prior.gathered ?? prior.count) || 0) + gathered')
        && resume.includes('count: Math.max(0, Number(prior.count) || 0) + gathered')
        && resume.includes('recordJobSourceProgress(resumeProgress, { updatePipeline: false, expectedNodeId: nodeId })')
        && resume.includes('const retryProgress = {\n        nodeId,\n        sourceId,\n        jobRunId,')
        && resume.includes('const resumeProgress = {\n      nodeId,\n      sourceId,\n      jobRunId,')
        && resume.includes('removedItemKeys: retiredListingKeys(descriptionEvidence.dropped)'),
      'native Indeed resume records the complete funnel, history samples, evidence drops, and run-correlated terminal source events without reactivating the gather pipeline');
      const postSearchStart = jobSearchNode.indexOf('const handlePostSearchResult');
      const postSearchEnd = jobSearchNode.indexOf('if (foundJobs.length === 0)', postSearchStart);
      const postSearch = jobSearchNode.slice(postSearchStart, postSearchEnd);
      assert(postSearch.includes('const needsDescriptionRecoverySnapshot')
        && postSearch.includes('blockingWarnings.filter(isDescriptionRecoverySourceWarning)')
        && postSearch.includes("sourceId === 'google' || sourceId === 'linkedin'")
        && postSearch.includes('descriptionRecoveryJobs,')
        && postSearch.includes('runId: jobRunId')
        && sourceCard.includes('jobRunId,\n          secondTabUrl')
        && generic.includes('jobRunId = null')
        && generic.includes('assessDescriptionRecoveryCheckpoint({ snapshot, origin, nodeId, jobRunId, canvasFilePath })')
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
        && jobsSource.includes('if (blocked) {')
        && jobsSource.includes("outcome: 'rejected'")
        && jobsSource.includes('return blocked;'),
      'only Google is hard-blocked by a missing/stale/row-less snapshot — every other source falls through to the ordinary resolve path rather than wedging on Solve, while rejected passes are recorded for diagnostics');
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
  {
    // The incident: a user clicked Continue three times, completed the real
    // Chrome verification each time, and closed the window. The AppleScript tab
    // poll never made an affirmative clean-tab observation, so the window
    // settled result:'closed' and the handler hard-blocked on
    // `result !== 'cleared'` — telling the user "no automated retry was
    // attempted" while their clearance sat unused in the shared profile.
    // 'closed'/'timeout'/unrecognised are the ABSENCE of a positive
    // observation, not a negative one, and the resume scrape is the only
    // authority that can settle it.
    name: 'an inconclusive native-challenge terminal probes with the resume scrape while an observed negative still hard-blocks',
    run: () => {
      // The classifier the handler itself calls, exercised over the whole
      // terminal enum. A source-shape pin could not tell a real revert apart
      // from a reformat; this asserts the shipped decision.
      const expected = [
        ['hard-block', 'blocked'],
        ['aborted', 'blocked'],
        ['app-window-destroyed', 'blocked'],
        ['cleared', 'cleared'],
        ['closed', 'unverified'],
        ['timeout', 'unverified'],
        ['', 'unverified'],
        [undefined, 'unverified'],
        ['wat', 'unverified'],
      ];
      const wrong = expected.filter(([outcome, want]) => nativeChallengeTerminalDisposition(outcome) !== want);
      assert(wrong.length === 0,
        `only a read block page, an already-fired abort, and a destroyed renderer are direct negative observations of a native verification; every other terminal — including a missing or unrecognised one — is the ABSENCE of a positive observation and must probe (misclassified: ${wrong.map(([outcome]) => JSON.stringify(outcome)).join(', ') || 'none'})`);

      const jobsSource = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
      const resumeStart = jobsSource.indexOf("handleSafe('resume-job-source'");
      const mergeStart = jobsSource.indexOf("ipcMain.handle('record-resolve-merge'", resumeStart);
      const resume = jobsSource.slice(resumeStart, mergeStart);

      // The table above only binds the handler while the handler actually
      // consumes it, so prove the branch routes through the classifier rather
      // than re-deriving the split inline.
      const dispositionStart = resume.indexOf('nativeChallengeTerminalDisposition(nativeOutcome)');
      const negativeStart = resume.indexOf("=== 'blocked'", dispositionStart);
      const inconclusiveStart = resume.indexOf("!== 'cleared'", negativeStart);
      const retryLaterStart = resume.indexOf("if (effectiveResumeState.mode === 'retry-later') {", inconclusiveStart);
      assert(dispositionStart > 0 && negativeStart > dispositionStart && inconclusiveStart > negativeStart && retryLaterStart > inconclusiveStart,
        'the native-challenge branch classifies its terminal with the exported classifier, then splits the observed negatives from the inconclusive terminals before falling through');
      const negativeBranch = resume.slice(negativeStart, inconclusiveStart);
      const inconclusiveBranch = resume.slice(inconclusiveStart, retryLaterStart);
      assert(negativeBranch.includes("recordResumeAttempt(sourceId, attemptMode, 'blocked'")
        && negativeBranch.includes('return {')
        && negativeBranch.includes("code: 'scrape-failed', severity: 'block'"),
      'an observed negative still returns a blocking warning instead of spending a scrape on a wall the observer actually read');
      // Comment prose in this branch legitimately says the scrape "returns its
      // own warning", so look for an actual statement, not the word.
      const inconclusiveReturns = inconclusiveBranch.split('\n')
        .filter(line => !line.trim().startsWith('//') && /(?:^|[^\w.])return\b/.test(line));
      assert(inconclusiveReturns.length === 0
        && inconclusiveBranch.includes("recordResumeAttempt(sourceId, attemptMode, 'unverified'")
        && inconclusiveBranch.includes("recordResumeAttempt(sourceId, attemptMode, 'cleared'")
        && inconclusiveBranch.includes('mode: null'),
      'closed/timeout/unrecognised records an explicit unverified attempt and clears the handoff mode instead of returning, so the resume scrape — the only authority that can settle whether the user\u2019s verification landed — actually runs');

      // The evidence sentence must report what the observer saw. "No automated
      // retry was attempted" is now false on every inconclusive path and would
      // also be an assertion about a decision rather than an observation.
      const liveClaims = jobsSource.split('\n')
        .filter(line => line.includes('no automated retry was attempted') && !line.trim().startsWith('//'));
      assert(liveClaims.length === 0
        && resume.includes('Native Indeed verification ended ${nativeOutcome}.${pollSummary ? ` Observer: ${pollSummary}.` : \'\'}'),
      'the user-facing evidence carries the window observer\u2019s own poll summary and no longer claims a retry was withheld');
      return { hardBlocking: expected.filter(([, want]) => want === 'blocked').map(([outcome]) => outcome) };
    },
  },
  {
    // Two ways the same handoff lied about state it no longer owned. A native
    // window can sit open for the full five-minute ceiling: long enough for the
    // user to give up, close it, and start a fresh search on the same hub, which
    // retires this run. And the recent-login dedupe stamp outlived the cookies
    // it stood for, so a "Log in" click after Settings -> Reset Indeed session
    // opened no window while recording 'logged-in'.
    name: 'a resume that waited on a native window re-checks run ownership, and every deliberate Indeed session invalidation drops the login dedupe stamp',
    run: () => {
      const jobsSource = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
      const resumeStart = jobsSource.indexOf("handleSafe('resume-job-source'");
      const mergeStart = jobsSource.indexOf("ipcMain.handle('record-resolve-merge'", resumeStart);
      const resume = jobsSource.slice(resumeStart, mergeStart);
      const settledWrites = resume.split('\n').filter(line => /^\s*nativeWindowSettled = true;\s*$/.test(line));
      const recheck = resume.indexOf('if (nativeWindowSettled && !(await canPerformJobSourceAction(canvasFilePath, nodeId, jobRunId)))');
      const destructure = resume.indexOf('const { remainingQueries, startPage = 0 } = effectiveResumeState;');
      assert(settledWrites.length === 2
        && recheck > 0 && destructure > recheck
        && resume.slice(recheck, destructure).includes('staleRun: true'),
      'both the native-login and native-challenge branches mark the window settled, and the handler re-reads the durable manifest before the scrape — a run retired while the window was open must not queue a complete Indeed pass ahead of the fresh search that replaced it');

      const invalidate = jobsSource.slice(
        jobsSource.indexOf('async function invalidateIndeedSessionIfNeedsLogin'),
        jobsSource.indexOf('async function syncIndeedSessionStatusFromScrape'),
      );
      const resetHandler = jobsSource.slice(
        jobsSource.indexOf("handleSafe('reset-platform-session'"),
        jobsSource.indexOf("handleSafe('clear-browser-session'"),
      );
      const clearHandler = jobsSource.slice(jobsSource.indexOf("handleSafe('clear-browser-session'"));
      assert(invalidate.includes('forgetIndeedLoginConfirmation(')
        && resetHandler.includes('forgetIndeedLoginConfirmation(')
        && clearHandler.includes('forgetIndeedLoginConfirmation('),
      'the needs-login invalidation, the targeted Indeed reset, and the all-profile clear each drop the recent-login stamp, so the next "Log in" click opens a real window instead of deduping against cookies that were just wiped');
      return { settledWrites: settledWrites.length };
    },
  },
  {
    // jobsTelemetry.resumeAttempts answers "what did each Continue click do",
    // but it is wiped by this hub's next search and the whole live-telemetry
    // surface is dropped from a report whose canvas has more than one Job
    // Search hub. So the three clicks at the heart of this incident had no
    // durable record anywhere. The per-source/run receipt already used for
    // Solve passes is the one place that survives both.
    name: 'a resume attempt lands in the durable per-source/run receipt with enum-only, bounded fields',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId,
        windowId: telemetry.windowId,
        sourceRunHistory: telemetry.sourceRunHistory,
        pipeline: telemetry.pipeline,
      };
      const secret = 'never-export-resume-prose-or-urls-9d31';
      const owner = { nodeId: 'resume-receipt-owner', jobRunId: 'resume-receipt-run' };
      try {
        Object.assign(telemetry, {
          nodeId: owner.nodeId,
          windowId: null,
          sourceRunHistory: {},
          pipeline: { phase: 'completed', active: false, runId: owner.jobRunId },
        });
        for (let click = 1; click <= 14; click += 1) {
          const normalized = __recordJobSourceResumeAttemptForTests('indeed', {
            at: click,
            mode: 'native-challenge',
            outcome: 'unverified',
            nativeResult: 'closed',
            // Everything below is the free-form material the live trail may
            // carry and the receipt must refuse: a poll summary can embed a
            // 200-character osascript error, and a challenge URL is a URL.
            detail: secret,
            challengeUrl: `https://indeed.invalid/${secret}`,
            pollEvidenceSummary: secret,
          }, owner);
          assert(normalized?.mode === 'native-challenge'
            && normalized?.outcome === 'unverified'
            && normalized?.nativeResult === 'closed'
            && Object.keys(normalized).sort().join(',') === 'at,mode,nativeResult,outcome',
          'a resume attempt is normalized to its timestamp and three enumerated fields before it reaches the receipt');
        }
        const receipt = telemetry.sourceRunHistory.indeed[0];
        assert(receipt.resumeAttemptCount === 14
          && receipt.resumeAttempts.length === 12
          && receipt.resumeAttempts[0].at === 3
          && receipt.resumeAttempts.at(-1).at === 14
          && !JSON.stringify(receipt.resumeAttempts).includes(secret),
        'the receipt retains the total click count plus only the newest twelve attempts, with no prose, URL, or job text');

        const unrecognised = __recordJobSourceResumeAttemptForTests('indeed', {
          at: 15, mode: 'a-card-mode-this-build-predates', outcome: 'surprise', nativeResult: 'who-knows',
        }, owner);
        assert(unrecognised?.mode === 'unrecognized'
          && unrecognised?.outcome === 'unrecognized'
          && unrecognised?.nativeResult === 'unknown'
          && receipt.resumeAttemptCount === 15,
        'an unknown mode/outcome/terminal is marked as unrecognised rather than folded into a real value the user never produced');

        const stale = __recordJobSourceResumeAttemptForTests('indeed', {
          at: 16, mode: 'native-challenge', outcome: 'blocked',
        }, { nodeId: 'superseded-resume-owner', jobRunId: owner.jobRunId });
        const unknownSource = __recordJobSourceResumeAttemptForTests('not-a-source', {
          at: 17, mode: 'native-challenge', outcome: 'blocked',
        }, owner);
        assert(stale === null && unknownSource === null
          && receipt.resumeAttemptCount === 15
          && !telemetry.sourceRunHistory['not-a-source'],
        'a superseded hub cannot append to the current receipt, and an unknown provider id cannot open a new one');

        const jobsSource = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
        assert(jobsSource.includes('const recordResumeAttempt = (attemptSourceId, mode, outcome, detail, observed = null) => {')
          && jobsSource.includes('recordJobSourceResumeAttempt(attemptSourceId, {\n        mode,\n        outcome,\n        nativeResult: observed?.nativeResult,\n      }, { nodeId, jobRunId });')
          && jobsSource.includes("recordResumeAttempt(sourceId, attemptMode, 'error', error?.message || String(error), { nativeResult: 'launch-error' });"),
        'the receipt is written inside the handler-local recorder, so every present and future resume call site is covered by construction');
        return { clicks: 15, retained: 12 };
      } finally {
        Object.assign(telemetry, saved);
      }
    },
  },
  {
    // A canvas with three Job Search hubs made getJobsTelemetryForReport fail
    // closed (correctly — no hub owns the combined funnel), and every reader of
    // that null then printed "no search recorded this session" for a process
    // that had just run three searches, and dropped the Resume attempts block
    // entirely. Absence was asserted, never observed.
    name: 'a multi-hub report can count telemetry owners and attribute resume evidence per hub without merging the funnel',
    run: () => {
      __resetJobsTelemetryForTests();
      try {
        const senderA = { id: 821 };
        const senderB = { id: 822 };
        const inContext = (sender, nodeId, callback) => __runWithIpcRequestContextForTests(
          { sender, nodeId, channel: nodeId ? 'search-jobs' : 'bug-report' },
          callback,
        );
        const seed = (sender, nodeId, fields) => inContext(sender, nodeId, () => {
          Object.assign(getJobsTelemetry(), { nodeId, windowId: sender.id, ...fields });
        });
        const attempt = (t, outcome) => ({ t, mode: 'native-challenge', outcome, detail: `pass ${t}` });
        seed(senderA, 'hub-a2', {
          indeedSession: { ts: 5, preflightStatus: 'challenge', hasPPID: true },
          // Fifteen clicks written straight into the live map: the report
          // boundary must re-apply the producer's newest-12 bound rather than
          // trusting whatever the in-memory list happens to hold.
          resumeAttempts: {
            indeed: Array.from({ length: 15 }, (_, index) => attempt(index + 1, 'blocked')),
            'not-a-source': [attempt(1, 'blocked')],
          },
        });
        seed(senderA, 'hub-a1', {
          indeedSession: null,
          resumeAttempts: { glassdoor: [attempt(3, 'resolved')] },
        });
        // Present, owns telemetry, but has neither observation to report.
        seed(senderA, 'hub-a3', { indeedSession: null, resumeAttempts: {} });
        seed(senderB, 'hub-b1', {
          indeedSession: { ts: 9, preflightStatus: 'authenticated' },
          resumeAttempts: { indeed: [attempt(4, 'resolved')] },
        });

        const hubIds = new Set(['hub-a1', 'hub-a2', 'hub-a3']);
        const funnel = inContext(senderA, null, () => __getJobsTelemetryForReportForTests(hubIds, senderA.id));
        const hubCount = inContext(senderA, null, () => getJobsTelemetryHubCountForReport(hubIds, senderA.id));
        const attribution = inContext(senderA, null, () => getJobsResumeAttributionForReport(hubIds, senderA.id));
        assert(funnel === null && hubCount === 3,
          'the funnel still fails closed on a multi-hub canvas, and the count is the observation a renderer can state instead of asserting nothing was recorded');
        assert(attribution.length === 2
          && attribution.map(row => row.nodeId).join(',') === 'hub-a1,hub-a2'
          && attribution[0].resumeAttempts.length === 1
          && attribution[0].resumeAttempts[0].sourceId === 'glassdoor'
          && attribution[0].indeedSession === null
          && attribution[1].indeedSession?.preflightStatus === 'challenge'
          && attribution[1].resumeAttempts.map(row => row.sourceId).join(',') === 'indeed'
          && attribution[1].resumeAttempts[0].attempts.length === 12
          && attribution[1].resumeAttempts[0].attempts[0].t === 4,
        'each hub\u2019s own nodeId-scoped session and resume clicks are reported under that hub, unknown source keys are refused, the producer cap is re-applied, and a hub with neither observation is omitted rather than reported as empty');

        const foreignWindow = inContext(senderA, null, () => ([
          getJobsTelemetryHubCountForReport(hubIds, senderB.id),
          getJobsResumeAttributionForReport(hubIds, senderB.id).length,
        ]));
        const foreignHub = inContext(senderA, null, () => getJobsResumeAttributionForReport(new Set(['hub-b1']), senderA.id));
        assert(foreignWindow.join(',') === '0,0' && foreignHub.length === 0,
          'both accessors keep the sibling\u2019s window and current-hub fences: another window\u2019s report, or a hub id this canvas does not hold, yields nothing rather than borrowed state');
        return { hubsHoldingTelemetry: 3, attributableHubs: 2 };
      } finally {
        __resetJobsTelemetryForTests();
      }
    },
  },
];
