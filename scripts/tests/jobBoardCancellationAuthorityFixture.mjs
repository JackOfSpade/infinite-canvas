import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { assert } from './testHelpers.js';

const source = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
const begin = source.indexOf('const cancelBoardRun = useCallback(') + 'const cancelBoardRun = useCallback('.length;
const end = source.indexOf('\n  }, [cancelCleanSourceCardDismiss, canvasFilePath, epoch,', begin);
const rollbackBegin = source.indexOf('function boardRunRollbackPatch(');
const rollbackEnd = source.indexOf('\n/**', rollbackBegin);

export function boardCancellationAuthorityFixture({ previousAuthority = null, cleanupFailure = false, pendingClaim = false,
  canvasFilePath = '/synthetic/canvas', operationAuthority = null, electronAPI = {},
} = {}) {
  const authority = operationAuthority || {
    operationId: 'current-operation', revision: 23,
    semanticBase: { kind: 'job-board-scan', careerSnapshotId: 'a'.repeat(64), runId: null },
  };
  const previousData = {
    hubState: 'done', jobRunId: 'completed-run', scoredJobs: [{ id: 'kept' }],
    analysisOperation: previousAuthority ? { authority: previousAuthority } : null,
  };
  const nodes = new Map([
    ['search', { id: 'search', type: 'jobhub', data: {
      ...previousData, hubState: 'searching', jobRunId: null,
      analysisOperation: pendingClaim ? previousData.analysisOperation : { authority },
    } }],
    ['board', { id: 'board', type: 'jobboard', data: { boardScanResume: {
      version: 1, boardRunId: 'board-run', phase: 'searches',
      activeSourceIds: ['search'], selectedSearchModuleIds: ['search'],
      activeSourceRollbacks: { search: { version: 1, sourceId: 'search', previousData, sourceGraph: {} } },
    } } }],
  ]);
  const controlRef = { current: {
    orchestratorNodeId: 'board', boardRunId: 'board-run', previousData,
    previousSourceGraph: {}, priorRunId: 'completed-run', cancelled: false,
  } };
  let resolveClaim;
  const claimTail = pendingClaim ? new Promise(resolve => { resolveClaim = resolve; }) : Promise.resolve();
  const state = { failuresLeft: cleanupFailure ? 1 : 0, discards: [], activeManifest: true, revoked: false, aborts: 0 };
  const updateGlobal = (id, patch) => {
    const node = nodes.get(id);
    const result = typeof patch === 'function' ? patch(node) : patch;
    if (result) node.data = { ...node.data, ...result };
  };
  const context = {
    id: 'search', canvasFilePath, boardRunControlRef: controlRef,
    getNode: id => nodes.get(id), getNodes: () => [...nodes.values()], getEdges: () => [], updateGlobal,
    analysisOperationClaimTailRef: { current: claimTail }, analysisOperationLedgerRef: { current: { revoke() {} } },
    waitForRendererCommitFrame: async () => {}, waitForBoardRollbackCommit: async () => true,
    safeClone: structuredClone, isCardOfficialPostingRunId: () => false,
    rememberBoundedRunId: (set, value) => set.add(value),
    cancelledBoardManualAiRunIdsRef: { current: new Set() }, activeManualAiRunIdRef: { current: null },
    boardCancellationCleanupError: (error, fallback) => error || new Error(fallback),
    moduleRunQueue: { acquireModuleRun: async () => ({ release() {} }), cancelQueuedRunsForNode() {} },
    epoch: { bump() {} }, processingRunsRef: { current: { cancel() {} } },
    pendingJobsRef: {}, gatheredCountRef: {}, scrapeWarningsRef: {}, hubStateRef: {}, jobRunIdRef: { current: null },
    sourceWarningOverridesDuringSearchRef: { current: new Map() }, isMountedRef: { current: true },
    cancelCleanSourceCardDismiss() {}, resetSourceProgress() {}, restoreBoardSourceGraph: () => ({}),
    settleManualAiRetirement: async () => {}, EventLogger: { log() {}, error() {} },
    freshJobCareerImportCapability: () => null,
    window: { electronAPI: {
      cancelNodeTaskAndWait: async () => { state.aborts++; return { settled: true }; },
      peekJobRun: async () => state.activeManifest
        ? { found: true, nodeId: 'search', runId: 'scrape-run', operationAuthority: authority }
        : { found: false },
      discardBoardJobRun: async args => {
        state.discards.push(args);
        assert(args.runId === 'scrape-run', 'cleanup must retain the interrupted run, not the prior completed run');
        assert(args.operationAuthority?.operationId === authority.operationId
          && args.operationAuthority?.revision === authority.revision,
        'host cleanup must receive the current operation receipt after result rollback');
        const durable = nodes.get('board').data.boardScanResume.cancellationCleanupsBySource.search;
        assert(durable.operationAuthority?.operationId === authority.operationId,
          'the exact receipt must survive a renderer restart before disk cleanup');
        if (state.failuresLeft-- > 0) return { ok: false };
        state.activeManifest = false;
        state.revoked = true;
        return { ok: true };
      },
      ...electronAPI,
    } },
  };
  context.boardRunRollbackPatch = runInNewContext(`(${source.slice(rollbackBegin, rollbackEnd)})`, context);
  const cancel = runInNewContext(`(${source.slice(begin, end)}\n})`, context);
  return {
    authority, nodes, state, controlRef,
    cancel: () => cancel({ orchestratorNodeId: 'board', boardRunId: 'board-run' }),
    finishClaim() { nodes.get('search').data.analysisOperation = { authority }; resolveClaim(); },
  };
}

const fixture = boardCancellationAuthorityFixture;

export default [
  {
    name: 'Board cancellation retains the current authority while restoring old or empty authority metadata',
    async run() {
      for (const previousAuthority of [null, { operationId: 'old-operation', revision: 21 }]) {
        const f = fixture({ previousAuthority });
        assert((await f.cancel()).status === 'cancelled');
        assert(f.state.revoked && !f.state.activeManifest && f.state.discards.length === 1);
        const restored = f.nodes.get('search').data;
        assert(restored.jobRunId === 'completed-run' && restored.scoredJobs[0].id === 'kept');
        assert(restored.analysisOperation.authority === f.authority && restored.analysisOperation.tombstoned,
          'result rollback must not rewind the durable authority revision');
      }
    },
  },
  {
    name: 'Board cancellation waits for in-flight authority publication and shares concurrent cleanup',
    async run() {
      const f = fixture({ pendingClaim: true });
      const first = f.cancel();
      const second = f.cancel();
      assert(f.controlRef.current.cancelled && f.state.aborts === 0);
      f.finishClaim();
      const outcomes = await Promise.all([first, second]);
      assert(outcomes.every(outcome => outcome.status === 'cancelled'));
      assert(f.state.discards.length === 1, 'concurrent cancel surfaces must share one cleanup');
    },
  },
  {
    name: 'Board cancellation retries its persisted receipt after rollback and renderer remount',
    async run() {
      const f = fixture({ cleanupFailure: true });
      await f.cancel().then(() => { throw new Error('expected cleanup failure'); }, () => {});
      assert(f.state.activeManifest);
      f.controlRef.current = null;
      f.nodes.get('search').data.analysisOperation = null;
      assert((await f.cancel()).status === 'cancelled');
      assert(f.state.revoked && !f.state.activeManifest && f.state.discards.length === 2);
    },
  },
  {
    name: 'legacy failed Board cancellation recovers only the exact staged run authority',
    async run() {
      const f = fixture();
      f.controlRef.current = null;
      f.nodes.get('search').data.analysisOperation = null;
      const plan = f.nodes.get('board').data.boardScanResume;
      plan.cancellationCleanupsBySource = { search: {
        sourceId: 'search', runId: 'scrape-run', priorRunId: 'completed-run', runCleanupAuthorized: true,
      } };
      assert((await f.cancel()).status === 'cancelled');
      assert(f.state.revoked && !f.state.activeManifest);
    },
  },
  {
    name: 'legacy Board cancellation refuses a replacement staged run before adopting its authority',
    async run() {
      const f = fixture();
      f.controlRef.current = null;
      f.nodes.get('search').data.analysisOperation = null;
      f.nodes.get('board').data.boardScanResume.cancellationCleanupsBySource = { search: {
        sourceId: 'search', runId: 'different-run', priorRunId: 'completed-run', runCleanupAuthorized: true,
      } };
      let error;
      try { await f.cancel(); } catch (caught) { error = caught; }
      assert(/token changed/.test(error?.message || ''), 'replacement ledger must remain outside cancellation authority');
      assert(f.state.discards.length === 0 && f.state.activeManifest && !f.state.revoked);
    },
  },
  {
    name: 'durable Board rollback does not tombstone a prior run it was not authorized to discard',
    async run() {
      const prior = { operationId: 'prior-completed-operation', revision: 21 };
      const f = fixture({ previousAuthority: prior });
      f.controlRef.current = null;
      const plan = f.nodes.get('board').data.boardScanResume;
      plan.activeSourceRollbacks.search.previousData.jobRunId = 'scrape-run';
      plan.cancellationCleanupsBySource = { search: {
        sourceId: 'search', runId: 'scrape-run', priorRunId: 'scrape-run', runCleanupAuthorized: false,
      } };
      assert((await f.cancel()).status === 'cancelled');
      assert(f.state.discards.length === 0 && f.state.activeManifest && !f.state.revoked);
      const restored = f.nodes.get('search').data;
      assert(restored.analysisOperation.authority.operationId === prior.operationId
        && !restored.analysisOperation.tombstoned, 'no cleanup means no claim that the host writer was revoked');
    },
  },
];
