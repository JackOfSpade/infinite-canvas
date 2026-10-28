import fs from 'node:fs';
import assert from 'node:assert';

import {
  SAVED_HANDOFF_READY_MESSAGE,
  combineCommitMismatchReason,
  isLiveCombineOwnedMarker,
  pauseBoardCombine,
} from '../../src/nodes/jobboard/boardRecoveryNotice.js';
import { isBoardCombineManualAiRunId } from '../../src/utils/jobBoardCareerOverride.js';

function readNodeSource() {
  return fs.readFileSync(
    new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url),
    'utf8',
  );
}

export default [
  {
    name: 'Board retirement boundaries ignore saved foreign tokens and filter cancellation discoveries',
    async run() {
      const source = readNodeSource();
      const callback = (name, scope) => {
        const start = source.indexOf(`  const ${name} = useCallback(`);
        const bodyStart = source.indexOf('useCallback(', start) + 'useCallback('.length;
        const end = source.indexOf('\n  }, [', bodyStart);
        assert(start > 0 && bodyStart > start && end > bodyStart);
        return new Function(...Object.keys(scope), `return (${source.slice(bodyStart, end)}\n});`)(...Object.values(scope));
      };
      const runId = 'official-posting:board-job-9:research';
      const boundaryScope = { isBoardCombineManualAiRunId };
      assert.equal(await callback('retireActiveCombineManualAiRun', boundaryScope)(runId), true);
      assert.equal(await callback('retireBoardCleanupReceipt', boundaryScope)({ runId, cancellationPending: true }), true);
      assert.deepStrictEqual(await callback('handleCancelRun', boundaryScope)({ expectedBoardRunId: runId }),
        { status: 'stale', cancelled: false }, 'a saved foreign cancellation cannot abort hub tasks before migration');

      const discovered = [];
      const retired = [];
      const retire = callback('retireBoardCleanupReceipt', {
        isBoardCombineManualAiRunId, id: 'board',
        window: { electronAPI: { cancelNodeTaskAndWait: async () => ({ settled: true,
          manualAiRunIds: ['legacy-combine', runId, 'job-board-career:board:career'] }) } },
        persistAcknowledgedBoardManualAiRunIds: async ids => { discovered.push(...ids); },
        retireActiveCombineManualAiRun: async id => { retired.push(id); },
      });
      await retire({ runId: 'legacy-combine', cancellationPending: true });
      assert.deepStrictEqual(discovered, ['legacy-combine']);
      assert.deepStrictEqual(retired, ['legacy-combine'], 'discovered card/career runs remain with their actual owners');
    },
  },
  {
    name: 'Card official-posting notifications cannot create or cancel a Board recovery run',
    run: () => {
      const source = readNodeSource();
      const callbacks = [
        ['const onPending = (event) => {', "    document.addEventListener('non-api-ai-node-pending', onPending);", 'onPending'],
        ['const onManualAiNodeCancelled = (event) => {', "    document.addEventListener('non-api-ai-node-cancelled', onManualAiNodeCancelled);", 'onManualAiNodeCancelled'],
      ];
      for (const [startToken, endToken, callback] of callbacks) {
        const start = source.indexOf(startToken);
        const end = source.indexOf(endToken, start);
        assert(start > 0 && end > start);
        // Any access to Board data or backend retirement after a foreign event
        // is a failure: another card owns that exact research request.
        const forbidden = () => { throw new Error(`${callback} adopted card research`); };
        const handler = new Function('isBoardCombineManualAiRunId', 'getNode', 'id',
          'handleCancelRun', 'retireActiveCombineManualAiRun',
          `${source.slice(start, end)}; return ${callback};`)(
          isBoardCombineManualAiRunId, forbidden, 'board-1', forbidden, forbidden,
        );
        handler({ detail: { nodeId: 'board-1', runId: 'official-posting:board-1-job-9:research', task: 'official-posting' } });
      }

      const helpersStart = source.indexOf('function hasCancellationPendingManualAiCleanup(');
      const helpersEnd = source.indexOf('function waitForBoardRendererCommitFrame()', helpersStart);
      const flagsStart = source.indexOf('  const durableRecoveryActive =');
      const flagsEnd = source.indexOf('  // --- Board career override', flagsStart);
      assert(helpersStart > 0 && helpersEnd > helpersStart && flagsStart > 0 && flagsEnd > flagsStart);
      const flags = new Function('data', 'normalizeManualAiCleanupReceipts', 'isBoardCombineManualAiRunId',
        `${source.slice(helpersStart, helpersEnd)}\n${source.slice(flagsStart, flagsEnd)}\nreturn { durableRecoveryActive, cleanupOnlyRecovery, cancellationCleanupActive };`);
      for (const runId of ['official-posting:board-1-job-9:research', 'job-board-career:board-1:import']) {
        assert.deepStrictEqual(flags({
          manualAiResume: { runId, retirementPending: true },
          manualAiCleanupReceipts: [{ runId, cancellationPending: true }],
        }, value => value || [], isBoardCombineManualAiRunId), {
          durableRecoveryActive: false, cleanupOnlyRecovery: false, cancellationCleanupActive: false,
        }, 'foreign saved state cannot disable the Board while self-healing runs');
      }
      assert.strictEqual(flags({ manualAiResume: { runId: 'job-board:board-1:combine' } },
        value => value || [], isBoardCombineManualAiRunId).durableRecoveryActive, true,
      'the same predicate retains real Board continuation');
    },
  },
  {
    name: 'Saved Board search pause restores Continue after remount and retains it until the parent receipt retires',
    run: async () => {
      const source = readNodeSource();
      const start = source.indexOf('    const plan = data.boardScanResume;', source.indexOf('// A Board-owned child can survive'));
      const end = source.indexOf('    if (boardRecoveryTouchesPendingDeletion', start);
      assert(start > 0 && end > start);
      const restore = new Function('data', 'setRecoveryError', 'SAVED_HANDOFF_READY_MESSAGE',
        'scanRunRef', 'combineRunRef', 'autoResumedBoardScanRef', 'searchRecoveryErrorRef', 'foreignRecoveryWaitSigRef',
        source.slice(start, end) + '\nthrow new Error("recovery continued");');
      const clearStart = source.indexOf('    if (recoveryError !== SAVED_HANDOFF_READY_MESSAGE) return;');
      const clearEnd = source.indexOf('\n  }, [', clearStart);
      const clear = new Function('data', 'recoveryError', 'setRecoveryError', 'SAVED_HANDOFF_READY_MESSAGE',
        'isBoardCombineManualAiRunId', 'combineRunRef', source.slice(clearStart, clearEnd));
      const plan = { version: 1, phase: 'searches', boardRunId: 'saved-board',
        activeSourceId: 'paused-search', completedSourceRuns: { other: { runId: 'completed' } } };
      for (const patch of [
        { boardScanResume: { ...plan, autoResumeEligible: false } },
        { boardScanResume: { ...plan, pausedByUser: true } },
        { boardScanResume: plan, manualAiResume: { runId: 'saved-combine', pausedByUser: true } },
        { boardScanResume: plan, manualAiResume: { runId: 'saved-combine', autoResumeEligible: false } },
      ]) {
        let notice = null;
        const ref = () => ({ current: null });
        restore(patch, value => { notice = value; }, SAVED_HANDOFF_READY_MESSAGE,
          ref(), ref(), ref(), ref(), ref());
        assert.strictEqual(notice, SAVED_HANDOFF_READY_MESSAGE, 'paused restore must expose the explicit Continue action');
        clear(patch, notice, value => { notice = value; }, SAVED_HANDOFF_READY_MESSAGE, () => false, ref());
        assert.strictEqual(notice, SAVED_HANDOFF_READY_MESSAGE, 'a parent-only saved search still owns the notice');
        clear({}, notice, value => { notice = value; }, SAVED_HANDOFF_READY_MESSAGE, () => false, ref());
        assert.strictEqual(notice, null, 'retiring the final receipt removes the notice');
      }

      const retryStart = source.indexOf('    const liveData = getNode(id)?.data || {};', source.indexOf('const handleRetryRecovery'));
      const retryEnd = source.indexOf('    setRecoveryError(null);', retryStart);
      const retry = new Function('getNode', 'id', 'updateGlobal', source.slice(retryStart, retryEnd));
      let live = { boardScanResume: { ...plan, autoResumeEligible: false, pausedByUser: true },
        manualAiResume: { runId: 'saved-combine', pausedByUser: true, autoResumeEligible: false } };
      retry(() => ({ data: live }), 'board', (_id, patch) => { live = { ...live, ...patch }; });
      assert.strictEqual(live.boardScanResume.autoResumeEligible, true);
      assert.strictEqual(live.boardScanResume.pausedByUser, false);
      assert.strictEqual(live.manualAiResume.autoResumeEligible, true);
      assert.strictEqual(live.manualAiResume.pausedByUser, false);
      assert.deepStrictEqual(live.boardScanResume.completedSourceRuns, plan.completedSourceRuns);
      assert.strictEqual(live.boardScanResume.activeSourceId, plan.activeSourceId);
    },
  },

  {
    name: 'Board completion reruns stale recovery notice cleanup after the live owner releases',
    run: async () => {
      const source = readNodeSource();
      const start = source.indexOf('    if (recoveryError !== SAVED_HANDOFF_READY_MESSAGE) return;');
      const end = source.indexOf('\n  }, [', start);
      const effect = new Function('data', 'recoveryError', 'setRecoveryError', 'SAVED_HANDOFF_READY_MESSAGE',
        'isBoardCombineManualAiRunId', 'combineRunRef', source.slice(start, end));
      const owner = { current: { runId: 'finishing-combine' } };
      let notice = SAVED_HANDOFF_READY_MESSAGE;
      const run = () => effect({}, notice, value => { notice = value; }, SAVED_HANDOFF_READY_MESSAGE, () => false, owner);
      run(); // Result commit retired the marker, but finally still owns the run.
      assert.strictEqual(notice, SAVED_HANDOFF_READY_MESSAGE);
      owner.current = null;
      const dependencies = source.slice(end, source.indexOf(']);', end));
      assert(/\bcombining\b/.test(dependencies) && /\bscanning\b/.test(dependencies),
        'settling either executor must schedule cleanup even when marker ids were already cleared');
      run(); // setCombining(false)/setScanning(false) schedules the effect again.
      assert.strictEqual(notice, null, 'the completed Board no longer blocks the selector');
      notice = 'A real recovery failure';
      run();
      assert.strictEqual(notice, 'A real recovery failure', 'completion does not erase an unrelated error');
    },
  },

  {
    name: 'Board Pause & save preserves its exact checkpoint before stopping and requires host acknowledgement',
    run: async () => {
      let marker = { runId: 'board-run', combineInputSignature: 'inputs', combineSourceRuns: [{ runId: 'source' }] };
      const steps = [];
      const ports = {
        runId: 'board-run', getMarker: () => marker,
        saveMarker: value => { marker = value; steps.push('save'); },
        waitForCommit: async () => { steps.push('commit'); },
        fence: () => { steps.push('fence'); },
        pauseBackend: async () => { steps.push('stop'); return { settled: true }; },
        settle: () => { steps.push('settle'); },
      };
      assert.deepStrictEqual(await pauseBoardCombine(ports), { success: true });
      assert.deepStrictEqual(steps, ['save', 'commit', 'fence', 'stop', 'settle']);
      assert(marker.pausedByUser && marker.autoResumeEligible === false && marker.combineInputSignature === 'inputs');
      assert.deepStrictEqual(marker.combineSourceRuns, [{ runId: 'source' }]);
      steps.length = 0;
      await assert.rejects(pauseBoardCombine({ ...ports, runId: 'stale' }), /changed/);
      assert.deepStrictEqual(steps, [], 'a stale request cannot touch another run');
      await assert.rejects(pauseBoardCombine({ ...ports, pauseBackend: async () => ({ settled: false }) }), /did not confirm/);
      assert(!steps.includes('settle') && marker.pausedByUser, 'an unacknowledged stop keeps recovery and cannot report success');
      steps.length = 0;
      await assert.rejects(pauseBoardCombine({ ...ports, saveMarker: () => { marker = { runId: 'newer' }; } }), /not saved/);
      assert.deepStrictEqual(steps, ['commit'], 'a changed owner cannot abort backend work');
    },
  },

  {
    name: 'board recovery notice constant text is exact and mismatch reason reports the first failing invariant',
    run: async () => {
      assert(
        SAVED_HANDOFF_READY_MESSAGE === 'Saved AI handoff ready. Choose Continue saved AI handoff to resume this exact Board run.',
        'SAVED_HANDOFF_READY_MESSAGE must keep its exact user-facing text',
      );

      // All 8 boolean combinations, including priority order. `combineCommitMismatchReason`
      // fails on any non-true value and returns the first failing check, so feed the raw
      // booleans from the node's three up-front comparisons.
      assert(combineCommitMismatchReason({ signatureMatches: true, selectedRunsMatch: true, exactSourceRunsMatch: true }) === null, 'all true -> null');
      assert(combineCommitMismatchReason({ signatureMatches: false, selectedRunsMatch: true, exactSourceRunsMatch: true }) === 'input-signature', 'signature wins priority');
      assert(combineCommitMismatchReason({ signatureMatches: true, selectedRunsMatch: false, exactSourceRunsMatch: true }) === 'selected-runs', 'selected-runs second');
      assert(combineCommitMismatchReason({ signatureMatches: true, selectedRunsMatch: true, exactSourceRunsMatch: false }) === 'exact-source-runs', 'exact-source-runs third');
      assert(combineCommitMismatchReason({ signatureMatches: false, selectedRunsMatch: false, exactSourceRunsMatch: true }) === 'input-signature', 'signature beats selected-runs');
      assert(combineCommitMismatchReason({ signatureMatches: false, selectedRunsMatch: true, exactSourceRunsMatch: false }) === 'input-signature', 'signature beats exact-source-runs');
      assert(combineCommitMismatchReason({ signatureMatches: true, selectedRunsMatch: false, exactSourceRunsMatch: false }) === 'selected-runs', 'selected-runs beats exact-source-runs');
      assert(combineCommitMismatchReason({ signatureMatches: false, selectedRunsMatch: false, exactSourceRunsMatch: false }) === 'input-signature', 'all false -> first');
    },
  },
  {
    name: 'board recovery notice mismatch reason and marker ownership handle non-boolean and non-string inputs',
    run: async () => {
      // Non-true values (including truthy-but-not-true) count as failing.
      assert(combineCommitMismatchReason({ signatureMatches: 1, selectedRunsMatch: true, exactSourceRunsMatch: true }) === 'input-signature', 'truthy non-true signature fails');
      assert(combineCommitMismatchReason({ signatureMatches: 'yes', selectedRunsMatch: true, exactSourceRunsMatch: true }) === 'input-signature', 'string signature fails');
      assert(combineCommitMismatchReason({ signatureMatches: undefined, selectedRunsMatch: true, exactSourceRunsMatch: true }) === 'input-signature', 'undefined signature fails');
      assert(combineCommitMismatchReason({ signatureMatches: null, selectedRunsMatch: true, exactSourceRunsMatch: true }) === 'input-signature', 'null signature fails');
      assert(combineCommitMismatchReason({ signatureMatches: true, selectedRunsMatch: 1, exactSourceRunsMatch: true }) === 'selected-runs', 'truthy non-true selected fails');

      // isLiveCombineOwnedMarker requires non-empty string equality.
      assert(isLiveCombineOwnedMarker('run-a', 'run-a') === true, 'equal strings -> owned');
      assert(isLiveCombineOwnedMarker('run-a', 'run-b') === false, 'different strings -> not owned');
      assert(isLiveCombineOwnedMarker('', 'run-a') === false, 'empty resume id -> not owned');
      assert(isLiveCombineOwnedMarker('run-a', '') === false, 'empty active id -> not owned');
      assert(isLiveCombineOwnedMarker('run-a', null) === false, 'null active id -> not owned');
      assert(isLiveCombineOwnedMarker('run-a', undefined) === false, 'undefined active id -> not owned');
      assert(isLiveCombineOwnedMarker(123, 123) === false, 'numbers -> not owned');
      assert(isLiveCombineOwnedMarker('run-a', 123) === false, 'mixed string/number -> not owned');
    },
  },
  {
    name: 'JobBoardNode imports the notice helpers and guards the restored-marker notice from a live combine',
    run: async () => {
      const source = readNodeSource();

      // (a) The node imports both helpers from the new module.
      assert(source.includes("import { SAVED_HANDOFF_READY_MESSAGE, isLiveCombineOwnedMarker, combineCommitMismatchReason } from './jobboard/boardRecoveryNotice';"), 'node must import notice helpers');
      assert(source.includes("import { "), 'import statements present');

      // (b) Inside the marker effect, the live-owner guard must run before setRecoveryError(message).
      const effectStart = source.indexOf('const resume = data.manualAiResume;');
      assert(effectStart !== -1, 'marker effect present');
      const guardAt = source.indexOf('isLiveCombineOwnedMarker(resume.runId, activeCombineManualAiRunRef.current?.runId)', effectStart);
      const setAt = source.indexOf('setRecoveryError(message)', effectStart);
      assert(guardAt !== -1, 'live owner guard present in effect');
      assert(setAt !== -1, 'setRecoveryError(message) present in effect');
      assert(guardAt < setAt, 'guard must return early before setRecoveryError(message)');

      // (c) A clearing effect exists referencing the constant and clearing the notice.
      const clearEffect = source.indexOf('if (recoveryError !== SAVED_HANDOFF_READY_MESSAGE) return;');
      assert(clearEffect !== -1, 'clearing effect must reference SAVED_HANDOFF_READY_MESSAGE');
      const clearCall = source.indexOf('setRecoveryError(null)', clearEffect);
      assert(clearCall !== -1 && clearCall < source.indexOf('const handleRetryRecovery'), 'clearing effect must call setRecoveryError(null)');

      // (d) The supersede log now names which invariant failed.
      assert(source.includes('[JobBoard] combine superseded before commit id=${id} signature=${sigAtCombine} reason=${mismatchReason}'), 'supersede log must append reason=');
    },
  },
];
