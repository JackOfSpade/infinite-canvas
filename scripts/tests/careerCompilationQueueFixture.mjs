import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createModuleRunQueue } from '../../src/utils/moduleRunQueue.js';
import { createRunOwnershipGuard } from '../../src/utils/runOwnership.js';
import * as receipts from '../../src/utils/jobCareerCompilationReceipt.js';
import { buildSavedJobsRescoreMarker } from '../../src/utils/jobSearchSplitClear.js';

const source = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
function callback(name, env) {
  const start = source.indexOf(`const ${name} = useCallback(`) + `const ${name} = useCallback(`.length;
  const end = source.indexOf('\n  }, [', start) + '\n  }'.length;
  // Execute the production callback, with React/IPC dependencies supplied by
  // this harness. No duplicate queue or compilation implementation in tests.
  return Function(...Object.keys(env), `return (${source.slice(start, end)});`)(...Object.values(env));
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function harness(queue = createModuleRunQueue()) {
  const nodes = new Map();
  const parses = [];
  const searches = [];
  function hub(id, { savedJobs = false, approvalCommitFrames = 0, completionCleanupSucceeds = true } = {}) {
    const node = { id, type: 'jobhub', data: savedJobs
      ? { hubState: 'done', scoredJobs: [{ id: 'saved-listing' }] }
      : { hubState: 'empty' } };
    nodes.set(id, node);
    let revision = 0;
    let pendingApproval = null; let frames = 0; const retirements = [];
    const env = {
      ...receipts, buildSavedJobsRescoreMarker,
      isJobBoardUserCancellation: error => error?.message === 'Manual AI job cancelled',
      id, moduleRunQueue: queue,
      localQueueAdmissionRef: { current: null },
      processingRunsRef: { current: createRunOwnershipGuard() },
      activeManualAiRunIdRef: { current: null },
      isMountedRef: { current: true },
      epoch: { start: () => { const captured = revision; return () => captured !== revision; }, bump: () => { revision++; } },
      getNode: key => nodes.get(key),
      updateGlobal: (key, patch) => {
        const current = nodes.get(key);
        const value = typeof patch === 'function' ? patch(current) : patch;
        if (value?.careerImportCompilation?.status === 'approved' && approvalCommitFrames > 0) {
          pendingApproval = value; frames = approvalCommitFrames;
        } else if (current) Object.assign(current.data, value);
      },
      waitForRendererCommitFrame: async () => { if (pendingApproval && --frames <= 0) { Object.assign(node.data, pendingApproval); pendingApproval = null; } },
      isJobWorkflowDeletionPending: () => false,
      searchRunOutcome: (status, rest = {}) => ({ status, ...rest }),
      EventLogger: { log() {}, error() {} },
      createManualAiRunId: () => `run-${id}`,
      createJobCareerImportCapability: () => `generation-${id}`,
      buildResumeSummary: () => 'summary',
      completeManualAiRun: async runId => { retirements.push(runId); if (!completionCleanupSucceeds) return false; node.data.manualAiResume = null; return true; },
      window: { electronAPI: { parseCareerData: async args => {
        const gate = deferred();
        parses.push({ id, args, ...gate });
        return gate.promise;
      } } },
    };
    const compile = callback('compileCareerFiles', env);
    const followup = async (_profile, options) => {
      assert.equal(options.queueManagedExternally, true);
      assert.equal(options.parentCancelled(), false);
      assert.equal(queue.getSnapshot().lanes['job-search'].active.nodeId, id);
      const gate = deferred();
      searches.push({ id, options, ...gate });
      return gate.promise;
    };
    const continueRescore = callback('continueSavedJobsRescore', {
      ...env, countSavedJobs: data => data?.scoredJobs?.length || 0,
      getNodes: () => [...nodes.values()], getEdges: () => [],
      isJobSearchConnectedToBoard: () => false,
      findJobSearchBoardActiveRecoveryOwner: () => null,
      addToast() {}, handleReanalyzeRef: { current: options => followup(null, options) },
    });
    const accept = callback('acceptCareerFiles', {
      ...env,
      initialDropAcceptedRef: { current: false }, dropLockReason: null,
      lastDroppedPathsRef: { current: null }, addToast() {},
      isAppBundlePathOrName: () => false, isCareerTextFileName: () => true,
      isCareerClearedWithSavedJobs: () => savedJobs,
      compileCareerFilesRef: { current: compile },
      continueSavedJobsRescore: continueRescore,
      platformsVerifyingRef: { current: false }, deferDirectSearchToBoard: () => false,
      startProcessingWithProfile: followup,
    });
    const cancelQueued = callback('cancelQueuedSearch', { ...env, countSavedJobs: data => data?.scoredJobs?.length || 0 });
    return { node, compile, accept, cancelQueued, retirements, cancel: () => { revision++; queue.cancelQueuedRunsOwnedByNode(id); } };
  }
  function approve(index) {
    parses[index].resolve({ success: true, profile: { skills: [] }, careerSnapshotId: 'a'.repeat(64) });
  }
  return { hub, parses, searches, approve, queue };
}

export default [
  { name: 'A completion-cleanup failure cannot downgrade an approved career snapshot', async run() {
    const h = harness(); const hub = h.hub('cleanup', { savedJobs: true, completionCleanupSucceeds: false });
    const pending = hub.compile(['/fixture/input.md'], { retainSavedJobs: true });
    await tick(); h.approve(0);
    assert.equal((await pending).status, 'not-ready');
    assert.equal(hub.node.data.careerImportCompilation.status, 'approved');
    assert.equal(hub.node.data.careerSnapshotId, 'a'.repeat(64));
    assert.equal(hub.node.data.scoredJobs.length, 1);
  } },

  { name: 'Approved career snapshot waits for its delayed React commit before retiring the final handoff', async run() {
    const h = harness(); const hub = h.hub('deferred', { savedJobs: true, approvalCommitFrames: 3 });
    const pending = hub.compile(['/fixture/input.md'], { retainSavedJobs: true });
    await tick(); h.approve(0);
    assert.equal((await pending).status, 'compiled');
    assert.deepEqual(hub.retirements, ['run-deferred']);
    assert.equal(hub.node.data.careerImportCompilation.status, 'approved');
    assert.equal(hub.node.data.savedJobsRescore.careerSnapshotId, 'a'.repeat(64));
    assert.equal(hub.node.data.scoredJobs.length, 1);
  } },
  { name: 'Continue on an already approved career run only retires the exact stale marker', async run() {
    const receipt = receipts.beginCareerImportCompilation({ generation: 'generation', manualAiRunId: 'finished-run', attemptId: 'attempt' });
    const approved = receipts.approveCareerImportCompilation(receipt, { generation: 'generation', attemptId: 'attempt', careerSnapshotId: 'a'.repeat(64) });
    const data = { hubState: 'done', careerImportGeneration: 'generation', careerImportCompilation: approved,
      careerSnapshotId: 'a'.repeat(64), scoredJobs: [{ id: 'saved' }], manualAiResume: { runId: 'finished-run', task: 'career-profile-clean' } };
    const retired = []; let continuations = 0;
    const run = callback('resumeManualAiRecovery', { ...receipts, data, id: 'hub', getNode: () => ({ data }),
      isSavedJobReanalysisManualAiResume: () => false, isSavedScrapeManualAiResume: () => false,
      isCareerCompilationTask: () => true, completeManualAiRun: async runId => { retired.push(runId); data.manualAiResume = null; return true; },
      updateGlobal: (_id, patch) => Object.assign(data, typeof patch === 'function' ? patch({ data }) : patch),
      EventLogger: { log() {} }, searchRunOutcome: (status, rest) => ({ status, ...rest }),
      hubRetainsSavedJobs: () => true, continueSavedJobsRescore: result => { continuations++; return result; },
    });
    assert.equal((await run(data.manualAiResume)).status, 'compiled');
    assert.deepEqual(retired, ['finished-run']); assert.equal(continuations, 1);
    assert.equal(data.careerImportCompilation.status, 'approved'); assert.equal(data.scoredJobs.length, 1);
  } },

  { name: 'Compiler restart retires only the old answer journal and starts a fresh forced compilation', async run() {
    const data = { hubState: 'done', filePath: '/fixture/input.md', scoredJobs: [{ id: 'saved' }],
      careerImportGeneration: 'generation', careerImportCompilation: { version: 1, generation: 'generation', attemptId: 'old-attempt', manualAiRunId: 'old-run', status: 'failed', error: 'Manual AI job cancelled' },
      manualAiResume: { runId: 'old-run', task: 'career-profile-compile', pausedByUser: true } };
    const node = { data }; const events = [];
    const env = { ...receipts, id: 'hub', getNode: () => node,
      restartCareerCompilationBusyRef: { current: false }, setRestartCareerCompilationBusy() {},
      processingRunsRef: { current: { active: false } }, isJobWorkflowDeletionPending: () => false,
      hasPendingManualAiRetirement: () => false, findJobSearchBoardRecoveryOwner: () => null,
      getNodes: () => [], getEdges: () => [], epoch: { bump() {} },
      settleManualAiRetirement: async args => { events.push(['retire', args.runId]); data.manualAiResume = null; },
      updateGlobal: (_id, update) => Object.assign(data, update(node)), waitForRendererCommitFrame: async () => {},
      autoResumedManualAiRunRef: { current: 'old-run' }, manualAiAutoResumeAttemptRef: { current: null }, manualAiStaleRecoveryActionRunIdRef: { current: null },
      setManualAiStaleRecoveryActionRunId() {}, setManualAiExplicitResumeRequest() {},
      EventLogger: { log() {} }, hubRetainsSavedJobs: () => true, continueSavedJobsRescore() {},
      compileCareerFilesRef: { current: async (paths, options) => events.push(['compile', paths, options]) },
      addToast() {}, isMountedRef: { current: true },
    };
    await callback('handleRestartCareerCompilation', env)();
    assert.equal(events[0][0], 'retire'); assert.equal(events[1][0], 'compile');
    assert.equal(events[1][2].manualAiRunId, undefined, 'fresh compiler must allocate a new run');
    assert.equal(events[1][2].forceRecompile, true); assert.equal(events[1][2].retainSavedJobs, true);
    assert.equal(data.scoredJobs.length, 1); assert.equal(data.filePath, '/fixture/input.md');
    assert.equal(data.careerImportCompilation, null); assert.equal(data.manualAiResume, null);
    data.careerImportCompilation = { version: 1, generation: 'generation', manualAiRunId: 'retry-run', status: 'failed' };
    data.manualAiResume = { runId: 'retry-run' };
    const preserved = JSON.stringify(data); const eventCount = events.length;
    env.settleManualAiRetirement = async () => { throw new Error('cancellation acknowledgement failed'); };
    await callback('handleRestartCareerCompilation', env)();
    assert.equal(JSON.stringify(data), preserved, 'failed cleanup keeps the exact saved checkpoint');
    assert.equal(events.length, eventCount, 'a cleanup failure cannot start fresh work');
    data.careerImportCompilation = { version: 1, generation: 'replacement', manualAiRunId: 'new-run', status: 'compiling' };
    assert.equal(receipts.restartCareerImportCompilationPatch(data, { generation: 'generation', runId: 'old-run' }), null, 'stale restart cannot touch replacement input');
  } },
  { name: 'Explicit Continue releases the cancellation latch for only the selected saved run', async run() {
    const cancelled = new Set(['saved-run', 'other-run']); let request;
    callback('handleContinueManualAiRecovery', {
      getNode: () => ({ data: { manualAiResume: { runId: 'saved-run' } } }), id: 'hub', canvasFilePath: '/fixture/canvas.json',
      isJobWorkflowDeletionPending: () => false, hasPendingManualAiRetirement: () => false,
      findJobSearchBoardRecoveryOwner: () => null, getNodes: () => [], getEdges: () => [],
      manualAiStaleRecoveryActionRunIdRef: { current: null }, autoResumedManualAiRunRef: { current: null },
      manualAiAutoResumeAttemptRef: { current: null }, cancelledBoardManualAiRunIdsRef: { current: cancelled },
      setManualAiStaleRecoveryActionRunId() {}, setManualAiExplicitResumeRequest: value => { request = value; }, EventLogger: { log() {} },
    })();
    assert.equal(cancelled.has('saved-run'), false); assert.equal(cancelled.has('other-run'), true);
    assert.equal(request.runId, 'saved-run');
  } },
  { name: 'Cancellation result does not become a durable compiler failure', async run() {
    const h = harness(); const hub = h.hub('cancel');
    const pending = hub.compile(['/fixture/input.md']); await tick();
    h.parses[0].resolve({ success: false, error: 'Manual AI job cancelled' });
    assert.equal((await pending).status, 'cancelled');
    assert.notEqual(hub.node.data.careerImportCompilation.status, 'failed');
    const receipt = hub.node.data.careerImportCompilation;
    const paused = receipts.pausedCareerImportCompilation({ ...hub.node.data,
      careerImportCompilation: { ...receipt, status: 'failed', error: 'Manual AI job cancelled' },
      manualAiResume: { runId: receipt.manualAiRunId, pausedByUser: true } });
    assert.equal(paused.status, 'paused'); assert.equal(paused.error, undefined);
  } },

  {
    name: 'Compiler-owned provider continuation does not require a Job Board identity or acquire a second lease',
    async run() {
      const start = source.indexOf('      if (!queueManagedByBoard && !queueManagedExternally) {');
      const end = source.indexOf('\n\n      if (standaloneBecameBoardRecoveryManaged)', start);
      assert(start >= 0 && end > start);
      const admit = Function('queueManagedByBoard', 'queueManagedExternally', 'orchestratorNodeId', 'moduleRunQueue',
        `return (async () => { let lease; const currentId = 'fixture'; const updateGlobal = () => {}; const EventLogger = { log() {} }; ${source.slice(start, end)} })();`);
      let acquired = false;
      const queue = { acquireModuleRun: () => { acquired = true; throw new Error('Nested acquisition'); } };
      await admit(false, true, null, queue);
      assert.equal(acquired, false);
      await assert.rejects(admit(true, false, null, queue), /requires an orchestrator/);
      await admit(true, false, 'board', queue);
    },
  },
  {
    name: 'Queued Cancel preserves input and saved jobs and ignores clicks after work starts',
    async run() {
      const h = harness(); const first = h.hub('first'); const second = h.hub('second', { savedJobs: true });
      first.accept(['/fixture/first.md']); second.accept(['/fixture/second.md']); await tick();
      const before = structuredClone(second.node.data);
      second.cancelQueued(); await tick();
      assert.deepEqual(second.node.data.scoredJobs, before.scoredJobs);
      assert.deepEqual(second.node.data.careerFilePaths, before.careerFilePaths);
      assert.equal(second.node.data.careerImportGeneration, before.careerImportGeneration);
      assert.equal(second.node.data.queuedModuleRun, null);
      assert.equal(second.node.data.errorMessage, before.errorMessage);
      const pendingStart = source.indexOf('const careerReplacementPending = ') + 'const careerReplacementPending = '.length;
      const pendingEnd = source.indexOf(';', pendingStart);
      const pending = Function('hubState', 'listedSavedJobCount', 'isCareerClearedWithSavedJobs', 'data', 'replacementCompile', 'careerCompilationUnstarted', `return ${source.slice(pendingStart, pendingEnd)}`);
      assert.equal(pending('done', 1, () => false, second.node.data, null, true), true,
        'a cancelled replacement with retained files must still show its Compile Career Files action beside saved jobs');

      assert.equal(h.parses.length, 1);
      // A stale marker/click must not bump the active run's cancellation epoch.
      first.node.data.queuedModuleRun = { label: 'Compiling career files', position: 1 };
      first.cancelQueued();
      h.approve(0); await tick();
      assert.equal(h.searches.length, 1, 'active compilation must still continue to providers');
      h.searches[0].resolve({ status: 'completed' }); await tick();
      assert.equal(h.queue.getSnapshot().activeRuns.length, 0);
    },
  },
  {
    name: 'Queued Cancel respects live locks and does not cancel parent dependency aliases',
    async run() {
      const h = harness(); const second = h.hub('second');
      const blocker = await h.queue.acquireModuleRun({ nodeId: 'active', lane: 'job-search' });
      const pending = second.compile(['/fixture/input.md']); await tick();
      second.node.data.locked = true; second.cancelQueued();
      assert.equal(h.queue.getSnapshot().queued.length, 1);
      second.node.data.locked = false;
      const board = h.queue.acquireModuleRun({ nodeId: 'board', lane: 'job-search', cancellationNodeIds: ['second'] });
      second.cancelQueued(); assert.equal((await pending).status, 'cancelled');
      assert.equal(h.queue.getSnapshot().queued[0].nodeId, 'board');
      blocker.release(); (await board).release();
    },
  },
  {
    name: 'Sequential drops queue whole Job Search modules through compilation and provider completion',
    async run() {
      const h = harness(); const first = h.hub('first'); const second = h.hub('second');
      assert(first.accept(['/fixture/first.md']));
      assert(second.accept(['/fixture/second.md']));
      await tick();
      assert.deepEqual(h.parses.map(p => p.id), ['first']);
      assert.equal(second.node.data.queuedModuleRun.position, 1);
      assert.equal(second.node.data.careerImportCompilation, undefined);
      h.approve(0); await tick();
      assert.deepEqual(h.searches.map(s => s.id), ['first']);
      assert.equal(h.parses.length, 1, 'second must wait through the first provider phase');
      h.searches[0].resolve({ status: 'completed' }); await tick();
      assert.deepEqual(h.parses.map(p => p.id), ['first', 'second']);
      assert.equal(second.node.data.queuedModuleRun, null);
      h.approve(1); await tick(); h.searches[1].resolve({ status: 'completed' }); await tick();
      assert.equal(h.queue.getSnapshot().activeRuns.length, 0);
      assert.equal(first.node.data.careerImportCompilation.status, 'approved');
      assert.equal(second.node.data.careerImportCompilation.status, 'approved');
      // Both real downstream runners skip only nested acquisition, preserving
      // all normal standalone/Board-authority and cancellation checks.
      assert(source.includes('if (!queueManagedByBoard && !queueManagedExternally) {'));
      assert(source.includes('if (!boardManaged && !queueManagedExternally) lease = await moduleRunQueue.acquireModuleRun({'));
    },
  },
  {
    name: 'Replacement career drops retain their FIFO turn through saved-job re-scoring',
    async run() {
      const h = harness();
      const first = h.hub('first', { savedJobs: true }); const second = h.hub('second');
      const saved = structuredClone(first.node.data.scoredJobs);
      first.accept(['/fixture/replacement.md']); second.accept(['/fixture/second.md']);
      await tick(); h.approve(0); await tick();
      assert.equal(h.parses.length, 1);
      assert.equal(h.searches[0].options.savedJobsRescore, true);
      assert.deepEqual(first.node.data.scoredJobs, saved);
      assert.equal(first.node.data.hubState, 'done');
      h.searches[0].resolve({ status: 'completed' }); await tick();
      assert.deepEqual(h.parses.map(p => p.id), ['first', 'second']);
      h.approve(1); await tick(); h.searches[1].resolve({ status: 'completed' }); await tick();
      assert.equal(h.queue.getSnapshot().activeRuns.length, 0);
    },
  },
  {
    name: 'Cancelling a queued career drop does not cancel the active module or issue another parse',
    async run() {
      const h = harness(); const first = h.hub('first'); const second = h.hub('second');
      first.node.data.careerImportGeneration = 'g1'; second.node.data.careerImportGeneration = 'g2';
      const one = first.compile(['/fixture/first.md'], 'g1');
      const two = second.compile(['/fixture/second.md'], 'g2');
      await tick(); second.cancel();
      assert.equal((await two).status, 'cancelled');
      assert.equal(second.node.data.queuedModuleRun, null);
      assert.equal(h.queue.getSnapshot().active.nodeId, 'first');
      h.approve(0); assert.equal((await one).status, 'compiled');
      assert.equal(h.parses.length, 1);
    },
  },
  {
    name: 'A failed career compilation releases the FIFO to the next module without failing its receipt',
    async run() {
      const h = harness(); const first = h.hub('first'); const second = h.hub('second');
      const one = first.compile(['/fixture/first.md']); const two = second.compile(['/fixture/second.md']);
      await tick(); h.parses[0].resolve({ success: false, error: 'Fixture compilation failure' });
      assert.equal((await one).status, 'failed'); await tick();
      assert.deepEqual(h.parses.map(p => p.id), ['first', 'second']);
      h.approve(1); assert.equal((await two).status, 'compiled');
      assert.equal(first.node.data.careerImportCompilation.status, 'failed');
      assert.equal(second.node.data.careerImportCompilation.status, 'approved');
    },
  },
  {
    name: 'Queued compilation rechecks changed input and locks before sending career files to IPC',
    async run() {
      for (const locked of [false, true]) {
        const h = harness();
        const blocker = await h.queue.acquireModuleRun({ nodeId: 'existing-search', lane: 'job-search' });
        const second = h.hub('second'); second.node.data.careerImportGeneration = 'old';
        const result = second.compile(['/fixture/input.md'], 'old');
        await tick(); assert.equal(h.parses.length, 0);
        if (locked) second.node.data.locked = true;
        else second.node.data.careerImportGeneration = 'replacement';
        blocker.release();
        assert.equal((await result).status, locked ? 'not-ready' : 'superseded');
        assert.equal(h.parses.length, 0);
        assert.equal(second.node.data.queuedModuleRun, null);
        assert.equal(h.queue.getSnapshot().activeRuns.length, 0);
      }
    },
  },
  {
    name: 'Board-owned career compilation reuses its parent turn without acquiring or releasing the Board lease',
    async run() {
      const h = harness();
      const board = await h.queue.acquireModuleRun({ nodeId: 'board', lane: 'job-search' });
      const child = h.hub('child');
      const result = child.compile(['/fixture/input.md'], {
        queueManagedExternally: true, parentCancelled: () => false,
      });
      await tick();
      assert.equal(h.parses.length, 1, 'Board child must not deadlock behind its parent');
      assert.equal(h.queue.getSnapshot().queued.length, 0);
      h.approve(0); assert.equal((await result).status, 'compiled');
      assert.equal(h.queue.getSnapshot().active.nodeId, 'board');
      board.release();
    },
  },
  {
    name: 'A pending compilation prevents duplicate starts on its own module',
    async run() {
      const h = harness(); const first = h.hub('first');
      const one = first.compile(['/fixture/input.md']);
      assert.equal((await first.compile(['/fixture/other.md'])).status, 'busy');
      await tick(); assert.equal(h.parses.length, 1);
      h.approve(0); assert.equal((await one).status, 'compiled');
    },
  },
];
