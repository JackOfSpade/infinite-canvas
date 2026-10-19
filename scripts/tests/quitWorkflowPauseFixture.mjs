import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createModuleRunQueue } from '../../src/utils/moduleRunQueue.js';
import { createJobSearchCoordinatorRegistry } from '../../src/utils/jobSearchCoordinatorRegistry.js';
import { createQuitWorkflowPauseCoordinator, jobWorkflowNeedsQuitPause, savedWorkflowQuitPausePatch } from '../../src/utils/quitWorkflowPause.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
const absent = () => Object.assign(new Error('No mounted owner'), { code: 'JOB_SEARCH_MODULE_UNAVAILABLE' });

export default [
  {
    name: 'quit workflow pause: default queue timers retain their browser global receiver',
    async run() {
      const source = fs.readFileSync(new URL('../../src/utils/moduleRunQueue.js', import.meta.url), 'utf8')
        .replace('export function createModuleRunQueue', 'function createModuleRunQueue');
      const queue = runInNewContext(`(() => {
        globalThis.setTimeout = function() { if (this !== globalThis) throw new TypeError('Illegal invocation'); return 1; };
        globalThis.clearTimeout = function() { if (this !== globalThis) throw new TypeError('Illegal invocation'); };
        ${source}; return createModuleRunQueue();
      })()`);
      assert.equal((await queue.waitForActiveRunsToSettle({ lanes: ['application'] })).settled, true,
        'the real queue barrier must invoke browser timer methods with the global receiver');
    },
  },
  {
    name: 'quit workflow pause: application creation renderer publication must settle before the pause acknowledgement',
    async run() {
      const queue = createModuleRunQueue();
      const application = await queue.acquireModuleRun({ nodeId: 'card', lane: 'application' });
      const manualAi = await queue.acquireModuleRun({ nodeId: 'other', lane: 'job-search' });
      const coordinator = createQuitWorkflowPauseCoordinator({ enumerateNodes: () => [], updateNode() {}, currentFile: () => null,
        queue, registry: {}, api: {}, waitForCommit: async () => {} });
      let acknowledged = false;
      const pending = coordinator.pause().then(result => { acknowledged = true; return result; });
      await turn();
      assert.equal(acknowledged, false, 'completed host creation cannot acknowledge until the card pointer has committed and released its lease');
      application.release();
      const result = await pending;
      assert.equal(result.success, true);
      assert.equal(result.requiresCanvasSave, true);
      assert.equal(queue.getSnapshot().activeRuns[0].lane, 'job-search', 'long manual AI is outside the initial application publication barrier');
      manualAi.release();
      coordinator.release();
      const timers = [];
      const timedQueue = createModuleRunQueue({ timers: { setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {} } });
      const lease = await timedQueue.acquireModuleRun({ lane: 'application' });
      const timeout = assert.rejects(timedQueue.waitForActiveRunsToSettle({ lanes: ['application'], timeoutMs: 1 }), /did not finish saving/);
      timers[0]();
      await timeout;
      lease.release();
      assert.equal((await timedQueue.waitForActiveRunsToSettle({ lanes: ['application'] })).settled, true,
        'timeout removes its observer and a later safe retry can settle');
    },
  },
  {
    name: 'quit workflow pause: queue holds cover the pre-start microtask and never drain another entry during pause',
    async run() {
      const queue = createModuleRunQueue();
      let started = 0;
      const first = queue.acquireModuleRun({ nodeId: 'first', lane: 'job-search', onStart: () => { started++; } });
      const releaseA = queue.suspendAdmissions();
      const releaseB = queue.suspendAdmissions();
      const second = queue.acquireModuleRun({ nodeId: 'second', lane: 'job-search', onStart: () => { started++; } });
      await turn();
      assert.equal(started, 0, 'even an entry already assigned active must wait before its onStart');
      assert.equal(queue.getSnapshot().queued.length, 2);
      releaseA(); await turn();
      assert.equal(started, 0, 'an overlapping hold keeps admissions frozen');
      releaseB();
      const firstLease = await first;
      assert.equal(started, 1);
      const hold = queue.suspendAdmissions();
      firstLease.release(); await turn();
      assert.equal(started, 1, 'a releasing active owner cannot start queued work during quit');
      hold();
      (await second).release();
      assert.equal(started, 2);
    },
  },
  {
    name: 'quit workflow pause: registry pausers are synchronous ownership hooks distinct from destructive cancellation',
    async run() {
      const registry = createJobSearchCoordinatorRegistry();
      const calls = [];
      const unregister = registry.registerSearchModule('search', async () => {}, () => { calls.push('cancel'); }, () => {
        calls.push('pause'); return { success: true };
      });
      const pending = registry.pauseSearchModule('search');
      assert.deepEqual(calls, ['pause'], 'the child saved-pause control is installed before its parent can fence');
      assert.equal((await pending).success, true);
      unregister();
      await assert.rejects(registry.pauseSearchModule('search'), error => error.code === 'JOB_SEARCH_MODULE_UNAVAILABLE');
      assert.deepEqual(calls, ['pause'], 'closing owners use saved-state fallback and never invoke cancellation');
    },
  },
  {
    name: 'quit workflow pause: Boards pause each child once and hidden recovery retains full raw context',
    async run() {
      const queue = createModuleRunQueue();
      const registry = createJobSearchCoordinatorRegistry();
      const acceptedMarker = { runId: 'accepted-handoff', task: 'job-scoring', acceptedStep: 'kept' };
      const pending = [{ id: 'saved-row' }];
      const nodes = [
        { id: 'board', type: 'jobboard', data: { boardScanResume: { boardRunId: 'board-run', activeSourceIds: ['child'] } } },
        { id: 'child', type: 'jobhub', data: { hubState: 'scoring', manualAiResume: acceptedMarker } },
        { id: 'hidden', type: 'jobhub', data: { hubState: 'sources-ready', manualAiResume: acceptedMarker,
          pendingJobs: pending, pendingCareerData: 'synthetic saved career input', pendingTargetRole: '',
          pendingJobPreferencePlan: { version: 1 }, scoredJobs: [{ id: 'old-score' }] } },
      ];
      const calls = [];
      const update = (id, patch) => {
        const node = nodes.find(item => item.id === id);
        Object.assign(node.data, typeof patch === 'function' ? patch(node) : patch);
      };
      registry.registerSearchModule('child', async () => {}, () => { throw new Error('destructive cancellation'); }, () => {
        calls.push('child'); update('child', savedWorkflowQuitPausePatch(nodes[1])); return { success: true };
      });
      registry.registerBoardModule('board', () => { throw new Error('destructive cancellation'); }, async options => {
        const child = options.pauseSearchModule('child');
        calls.push('board-fence');
        update('board', savedWorkflowQuitPausePatch(nodes[0]));
        await child;
        return { success: true };
      });
      const coordinator = createQuitWorkflowPauseCoordinator({ enumerateNodes: () => nodes, updateNode: update,
        currentFile: () => '/synthetic/canvas.json', queue, registry, waitForCommit: async () => {},
        api: { peekJobRun: async () => ({ found: false }), pauseJobRunAndCancel: async args => {
          calls.push(args.nodeId); assert.equal(args.cause, 'app-quit'); return { ok: true, settled: true };
        } } });
      const result = await coordinator.pause({ requestId: 1 });
      assert.equal(result.success, true);
      assert.equal(result.requiresCanvasSave, true);
      assert.deepEqual(calls, ['child', 'board-fence', 'hidden']);
      assert.equal(nodes[0].data.boardScanResume.autoResumeEligible, false);
      assert.equal(nodes[2].data.manualAiResume.acceptedStep, 'kept');
      assert.equal(nodes[2].data.manualAiResume.pausedByUser, true);
      assert.equal(nodes[2].data.pendingJobs, pending);
      assert.equal(nodes[2].data.pendingCareerData, 'synthetic saved career input');
      assert.equal(nodes[2].data.pendingTargetRole, '');
      assert.equal(queue.getSnapshot().admissionsSuspended, true);
      coordinator.release();
      assert.equal(queue.getSnapshot().admissionsSuspended, false);
      assert.equal(nodes[2].data.manualAiResume.pausedByUser, true, 'cancelled quit leaves accepted work paused');
    },
  },
  {
    name: 'quit workflow pause: sanitized hidden nodes discover exact durable work and fail closed on a refused backend pause',
    async run() {
      for (const settled of [true, false]) {
        const node = { id: 'hidden', type: 'jobhub', data: { hubState: 'empty', jobRunId: 'run',
          analysisOperation: { authority: { operationId: 'authority' } } } };
        const queue = createModuleRunQueue();
        const calls = [];
        const coordinator = createQuitWorkflowPauseCoordinator({ enumerateNodes: () => [node],
          updateNode: (_id, updater) => Object.assign(node.data, updater(node)), currentFile: () => '/synthetic/canvas.json',
          queue, registry: { pauseSearchModule: () => Promise.reject(absent()) }, waitForCommit: async () => {},
          api: { peekJobRun: async () => ({ found: true, nodeId: 'hidden', runId: 'run' }),
            pauseJobRunAndCancel: async args => {
              calls.push(args); return { ok: settled, paused: settled, settled, manualAiRunIds: ['manual'] };
            } } });
        const result = await coordinator.pause();
        assert.equal(result.success, settled);
        assert.equal(calls[0].runId, 'run');
        assert.equal(calls[0].operationAuthority.operationId, 'authority');
        if (settled) assert.equal(node.data.manualAiResume.runId, 'manual');
        else assert.equal(node.data.manualAiResume, undefined, 'a failed host receipt cannot manufacture saved progress');
        assert.equal(queue.getSnapshot().admissionsSuspended, true, 'only the quit release may re-enable admissions');
        coordinator.release();
      }
    },
  },
  {
    name: 'quit workflow pause: releasing a pending request prevents later discovery from pausing or resuspending work',
    async run() {
      let finish;
      const gate = new Promise(resolve => { finish = resolve; });
      let pauses = 0;
      const queue = createModuleRunQueue();
      const coordinator = createQuitWorkflowPauseCoordinator({ enumerateNodes: () => [{ id: 'saved', type: 'jobhub', data: { hubState: 'empty' } }],
        currentFile: () => '/synthetic/canvas.json', queue, updateNode() {}, waitForCommit: async () => {},
        registry: { pauseSearchModule: () => { pauses++; return { success: true, idle: true }; } }, api: { peekJobRun: () => gate } });
      const pending = coordinator.pause();
      coordinator.release();
      finish({ found: true, nodeId: 'saved', runId: 'run' });
      assert.equal((await pending).success, false);
      assert.equal(pauses, 1, 'the initial idle owner inspection is safe; no later pauser may run');
      assert.equal(queue.getSnapshot().admissionsSuspended, false);
    },
  },
  {
    name: 'quit workflow pause: mounted owners cover pre-marker work while idle canvases do not need a save',
    async run() {
      for (const busy of [false, true]) {
        const nodes = [{ id: 'board', type: 'jobboard', data: {} }, { id: 'search', type: 'jobhub', data: { hubState: 'empty' } }];
        const calls = [];
        const coordinator = createQuitWorkflowPauseCoordinator({ enumerateNodes: () => nodes, updateNode() {},
          currentFile: () => null, queue: createModuleRunQueue(), waitForCommit: async () => {}, api: {},
          registry: { pauseBoardModule: () => { calls.push('board'); return { success: true, idle: !busy }; },
            pauseSearchModule: () => { calls.push('search'); return { success: true, idle: !busy }; } } });
        const result = await coordinator.pause();
        assert.deepEqual(calls, ['board', 'search'], 'mounted refs must be inspected even before durable flags exist');
        assert.equal(result.requiresCanvasSave, busy);
      }
      const search = fs.readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const resetStart = search.indexOf('const resetHandler = useCallback(') + 'const resetHandler = useCallback('.length;
      const resetEnd = search.indexOf('}, [addToast, cancelActiveBoardChild', resetStart) + 1;
      const ref = current => ({ current });
      const reset = runInNewContext(`(${search.slice(resetStart, resetEnd)})`, {
        id: 'search', getNode: () => ({ data: { hubState: 'empty' } }), jobWorkflowNeedsQuitPause,
        processingRunsRef: ref({ active: false }), localQueueAdmissionRef: ref(null),
        scoringContinuationAdmissionRef: ref(null), usaJobsRefreshAdmissionRef: ref(null),
        activeManualAiRunIdRef: ref(null), boardRunControlRef: ref(null), standaloneCancellationRef: ref(null),
      });
      assert.equal((await reset(null, { lifecycleQuit: true })).idle, true, 'the production idle Search pauser returns before any mutation or backend call');
      const board = fs.readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      const boardStart = board.indexOf('const pauseBoardForQuit = useCallback(') + 'const pauseBoardForQuit = useCallback('.length;
      const boardEnd = board.indexOf('}, [canvasFilePath, data, epoch, getNode, id, moduleRunQueue, updateGlobal]', boardStart) + 1;
      for (const busy of [false, true]) {
        let live = {};
        let backendPauses = 0;
        const noop = () => {};
        const pauseBoard = runInNewContext(`(${board.slice(boardStart, boardEnd)})`, {
          id: 'board', data: {}, canvasFilePath: null, getNode: () => ({ data: live }), jobWorkflowNeedsQuitPause,
          scanRunRef: ref(null), scanPreflightRef: ref(null), combineRunRef: ref(busy ? Symbol('combine') : null),
          combineRecoveryTokenClaimRef: ref(null), activeCombineManualAiRunRef: ref(busy ? { runId: 'accepted-run', startedAt: 1 } : null),
          activeSearchModuleIdRef: ref(null), activeSearchModuleIdsRef: ref(new Set()),
          combineInputSignaturesRef: ref(new Map()), combineSourceRunsRef: ref(new Map()), compensationRequestIdRef: ref(null),
          updateGlobal: (_id, updater) => { Object.assign(live, updater({ type: 'jobboard', data: live })); },
          epoch: { bump: noop }, moduleRunQueue: { cancelQueuedRunsOwnedByNode: noop },
          window: { electronAPI: { pauseJobRunAndCancel: async () => { backendPauses++; return { ok: true, settled: true }; } } },
          setScanning: noop, setScanProgress: noop, setCombining: noop, setCompensationProgress: noop, setRecoveryError: noop,
          SAVED_HANDOFF_READY_MESSAGE: 'Paused', savedWorkflowQuitPausePatch, settlePreFenceCanvasBatches: async () => {},
        });
        const result = await pauseBoard();
        assert.equal(!!result.idle, !busy);
        assert.equal(backendPauses, busy ? 1 : 0);
        if (busy) assert.equal(live.manualAiResume.runId, 'accepted-run', 'the production Board pauser retains the pre-event exact Combine run');
      }
    },
  },
  {
    name: 'quit workflow pause: stale hidden pause acknowledgements cannot patch a released or successor workflow',
    async run() {
      for (const release of [true, false]) {
        const node = { id: 'hidden', type: 'jobhub', data: { hubState: 'scoring', jobRunId: 'old-run', manualAiResume: { runId: 'old-manual' } } };
        let finish;
        const gate = new Promise(resolve => { finish = resolve; });
        let started;
        const startedPromise = new Promise(resolve => { started = resolve; });
        let patches = 0;
        const coordinator = createQuitWorkflowPauseCoordinator({ enumerateNodes: () => [node], currentFile: () => null,
          queue: createModuleRunQueue(), registry: { pauseSearchModule: () => Promise.reject(absent()) }, waitForCommit: async () => {},
          updateNode: (_id, updater) => { const patch = updater(node); if (patch) { patches++; Object.assign(node.data, patch); } },
          api: { pauseJobRunAndCancel: () => { started(); return gate; } } });
        const result = coordinator.pause();
        await startedPromise;
        if (release) coordinator.release();
        node.data = { hubState: 'scoring', jobRunId: 'new-run', manualAiResume: { runId: 'new-manual' } };
        finish({ ok: true, settled: true, paused: true });
        assert.equal((await result).success, false);
        assert.equal(patches, 0);
        assert.equal(node.data.manualAiResume.pausedByUser, undefined);
      }
    },
  },
];
