import { __createDescriptionRecoveryCheckpointForTests, __discardOwnedJobRunForTests, __formatJobAnalysisPromptForTests, __loadDescriptionRecoveryCheckpointForTests, __loadJobAnalysisSnapshotForTests, __removeDescriptionRecoveryCheckpointForTests, __saveDescriptionRecoverySnapshotIfCurrentForTests, assessDescriptionRecoverySnapshotOwnership, assert, canRecoverGatheredRunDirectly, collectDeletedJobRunDiscards, createDescriptionRecoveryMutex, filterJobsByDescriptionEvidence, fs, getJobAnalysisPaths, isLiveDescriptionRecoveryRun, listDescriptionRecoveryCheckpointsSync, path, readRunState, setStage, startRun } from '../test-dependencies.js';
import { normalizeJobsMarkup, repairJobsMojibake } from '../../src/utils/textEncoding.js';
import { getJobDescriptionRecoveryCheckpointPath } from '../../electron/ipc/jobAnalysisPaths.js';
import { __canPerformJobSourceActionForTests, __canWriteJobResolveTelemetryForTests, __consumeRecoveryBlockedUrlForTests, __recordResumeAttemptForTests, __restoreJobsTelemetryIfCurrentRunForTests, getJobsTelemetry, orderedBlockedManualSourceUrls, recordLinkedinResolveAttempt, recordResolveMergeOutcome } from '../test-dependencies.js';

export default [
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
        && staging.includes('if (!resumeGatheredOnly) {\n        await setJobRunStage')
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
        && source.includes('await markGatheredSourceTerminal(sourceId, [{ jobs }]);'),
      'every source records its terminal manifest status as it finishes, so resume after a mid-gather crash reuses staged rows instead of re-scraping them');
      assert(source.includes("if (!blocked && produced === 0) return; // nothing proven yet — leave it pending"),
        'the in-gather mark is conservative: only a source that demonstrably produced rows or blocked is written, so a wrong guess costs a re-scrape and never staged results');
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
      const paths = getJobAnalysisPaths(canvas, path.join(root, 'unsaved'));
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
        const deletionHook = fs.readFileSync(path.resolve('src/hooks/useCanvasOSDeletion.js'), 'utf8');
        const canvas = fs.readFileSync(path.resolve('src/Canvas.jsx'), 'utf8');
        const canvasActions = fs.readFileSync(path.resolve('src/hooks/useCanvasActions.js'), 'utf8');
        const finalizeStart = deletionHook.indexOf('const finalizeNodeDeletion = () => {');
        const promptStart = deletionHook.indexOf('if (osPaths.length > 0 && window.electronAPI)', finalizeStart);
        const promptEnd = deletionHook.indexOf('}, [requestConfirm, undo, canvasFilePath]);', promptStart);
        const deletionPrompt = deletionHook.slice(promptStart, promptEnd);
        assert(deletionHook.includes('discardDeletedJobRuns(deletedNodes, canvasFilePath')
          && canvas.includes('useCanvasOSDeletion({ requestConfirm, undo, canvasFilePath: currentFile })')
          && canvas.includes('canvasFilePath: currentFile,')
          && canvasActions.includes("allNodes.filter(node => !lockedIds.has(node.id))")
          && canvasActions.includes('discardDeletedJobRuns(')
          && finalizeStart >= 0 && promptStart > finalizeStart
          && deletionPrompt.includes('onConfirm: async () => {\n          finalizeNodeDeletion();')
          && deletionPrompt.includes('onCancel: finalizeNodeDeletion')
          && deletionPrompt.includes('onAbort: undo ? () => undo() : undefined')
          && deletionPrompt.includes('} else {\n      finalizeNodeDeletion();'),
        'interactive deletion and programmatic Clear Canvas both dispatch exact cleanup with the captured canvas path, while an OS-dialog Abort restores the hub without first discarding its run');
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

        const staleBatch = collectDeletedJobRunDiscards([{
          id: 'mixed-hub', type: 'jobhub', data: {
            hubState: 'sources-ready', jobRunId: 'current-run', pendingBatch: { jobRunId: 'stale-batch-run' },
          },
        }], pausedCanvas);
        const activeBatch = collectDeletedJobRunDiscards([{
          id: 'batch-hub', type: 'jobhub', data: {
            hubState: 'scoring-batch', jobRunId: 'older-search-run', pendingBatch: { jobRunId: 'active-batch-run' },
          },
        }], pausedCanvas);
        assert(staleBatch[0]?.runId === 'current-run' && activeBatch[0]?.runId === 'active-batch-run',
          'deletion chooses the current search token outside scoring-batch and the pending-batch token only while that lifecycle owns the hub');
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
          && resume.includes('const recordResumeAttempt = (attemptSourceId, mode, outcome, detail) =>')
          && resume.includes('recordResumeAttemptTelemetry(attemptSourceId, mode, outcome, detail, { nodeId, jobRunId });')
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
        && generic.includes('removedItemKeys: descriptionEvidence.dropped.map(sourceJobKey).filter(Boolean)')
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
        && resume.includes('removedItemKeys: descriptionEvidence.dropped.map(sourceJobKey).filter(Boolean)'),
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
