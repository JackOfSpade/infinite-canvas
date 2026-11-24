import fs from 'node:fs';
import assert from 'node:assert';

import {
  SAVED_HANDOFF_READY_MESSAGE,
  SAVED_SEARCH_PAUSE_MESSAGE,
  combineCommitMismatchReason,
  isSavedPauseNotice,
  savedPauseMessageForPlan,
  isLiveCombineOwnedMarker,
  pauseBoardCombine,
} from '../../src/nodes/jobboard/boardRecoveryNotice.js';
import {
  boardPauseBackendAnswer,
  boardPauseRefusalMessage,
  boardPauseRestorePatch,
  classifyBoardPauseOutcome,
} from '../../src/nodes/jobboard/boardPauseRefusal.js';
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
        `${source.slice(helpersStart, helpersEnd)}\n${source.slice(flagsStart, flagsEnd)}\nreturn { durableRecoveryActive, cancellationCleanupActive };`);
      for (const runId of ['official-posting:board-1-job-9:research', 'job-board-career:board-1:import']) {
        assert.deepStrictEqual(flags({
          manualAiResume: { runId, retirementPending: true },
          manualAiCleanupReceipts: [{ runId, cancellationPending: true }],
        }, value => value || [], isBoardCombineManualAiRunId), {
          durableRecoveryActive: false, cancellationCleanupActive: false,
        }, 'foreign saved state cannot disable the Board while self-healing runs');
      }
      assert.strictEqual(flags({ manualAiResume: { runId: 'job-board:board-1:combine' } },
        value => value || [], isBoardCombineManualAiRunId).durableRecoveryActive, true,
      'the same predicate retains real Board continuation');
    },
  },

  {
    name: 'Board completion reruns stale recovery notice cleanup after the live owner releases',
    run: async () => {
      const source = readNodeSource();
      const start = source.indexOf('    if (!isSavedPauseNotice(recoveryError)) return;');
      const end = source.indexOf('\n  }, [', start);
      const effect = new Function('data', 'recoveryError', 'setRecoveryError', 'isSavedPauseNotice',
        'isBoardCombineManualAiRunId', 'combineRunRef', source.slice(start, end));
      const owner = { current: { runId: 'finishing-combine' } };
      let notice = SAVED_HANDOFF_READY_MESSAGE;
      const run = () => effect({}, notice, value => { notice = value; }, isSavedPauseNotice, () => false, owner);
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
      // The app process returned before aborting anything: nothing stopped, so
      // the marker is kept (recovery survives) but its paused mark is taken back.
      const beforeRefusal = { ...marker, pausedByUser: undefined, autoResumeEligible: true };
      marker = beforeRefusal;
      await assert.rejects(pauseBoardCombine({ ...ports, pauseBackend: async () => ({ ok: false, settled: false, reason: 'ownership-mismatch' }) }),
        error => /refused the Job Board's pause \(ownership-mismatch\)/.test(error.message) && /still running/.test(error.message)
          && /not marked paused/.test(error.message) && error.pauseMarkRestored === true);
      assert(!steps.includes('settle'), 'an unacknowledged stop cannot report success');
      assert.strictEqual(marker.runId, 'board-run', 'a refused pause keeps the recovery marker');
      assert.strictEqual(marker.combineInputSignature, 'inputs');
      assert(!('pausedByUser' in marker) && marker.autoResumeEligible === true, 'a refused pause restores the flags it found');
      // The abort was requested but not confirmed: still not marked paused.
      await assert.rejects(pauseBoardCombine({ ...ports, pauseBackend: async () => ({ ok: false, settled: false, pausedContinuations: 0 }) }),
        /did not confirm that its saved work stopped/);
      assert(!marker.pausedByUser);
      // A thrown backend call is handled the same way.
      await assert.rejects(pauseBoardCombine({ ...ports, pauseBackend: async () => { throw new Error('ipc closed'); } }),
        /pause request failed \(ipc closed\)/);
      assert(!marker.pausedByUser);
      // A newer owner of the marker is never rewritten by a refused pause.
      let newer = null;
      await assert.rejects(pauseBoardCombine({ ...ports,
        pauseBackend: async () => { newer = { runId: 'newer-run', pausedByUser: true, autoResumeEligible: false }; marker = newer; return { settled: false }; } }),
        error => error.pauseMarkRestored === false && /Retry Pause & save/.test(error.message));
      assert.strictEqual(marker, newer, 'another run\'s paused mark is left alone');
      marker = { runId: 'board-run', combineInputSignature: 'inputs', combineSourceRuns: [{ runId: 'source' }], pausedByUser: true, autoResumeEligible: false };
      steps.length = 0;
      await assert.rejects(pauseBoardCombine({ ...ports, saveMarker: () => { marker = { runId: 'newer' }; } }), /not saved/);
      assert.deepStrictEqual(steps, ['commit'], 'a changed owner cannot abort backend work');
    },
  },

  {
    name: 'Board pause refusal: the answers decide whether paused marks stay, and the message says only what is true',
    run: async () => {
      const ok = value => ({ status: 'fulfilled', value });
      const paused = ok({ success: true });
      const idle = ok({ success: true, idle: true });
      const failed = ok({ success: false, error: 'changed runs' });
      const rejected = { status: 'rejected', reason: new Error('x') };
      const refusal = { ok: false, paused: false, settled: false, tokenMismatch: true, reason: 'ownership-mismatch' };
      const notSettled = { ok: false, settled: false, paused: false, absent: true, pausedContinuations: 0 };

      assert.deepStrictEqual(boardPauseBackendAnswer({ ok: true, settled: true }), { kind: 'confirmed', reason: null });
      assert.deepStrictEqual(boardPauseBackendAnswer(refusal), { kind: 'refused', reason: 'ownership-mismatch' });
      assert.deepStrictEqual(boardPauseBackendAnswer({ ok: false, paused: false, settled: false, operationAuthorityMismatch: true }),
        { kind: 'refused', reason: 'operation-authority-mismatch' });
      assert.deepStrictEqual(boardPauseBackendAnswer({ ok: false, settled: false, reason: 'continuation-pause-failed' }),
        { kind: 'refused', reason: 'continuation-pause-failed' });
      assert.strictEqual(boardPauseBackendAnswer(notSettled).kind, 'not-settled');
      assert.strictEqual(boardPauseBackendAnswer({ ok: false, settled: false, reason: 'quit-pause-not-settled' }).kind, 'not-settled');
      assert.strictEqual(boardPauseBackendAnswer(undefined).kind, 'failed');
      // A quit pause drains the card's tasks before it can refuse, so the
      // refusal is not proof that work is still running.
      assert.strictEqual(boardPauseBackendAnswer(refusal, null, { drainedBeforeAnswer: true }).kind, 'not-settled');
      assert.strictEqual(boardPauseBackendAnswer({ ok: false, settled: false, reason: 'missing-node' }, null, { drainedBeforeAnswer: true }).kind, 'refused');
      // Marks that were already paused before the attempt are not "taken back".
      assert.strictEqual(boardPauseRestorePatch(
        { boardScanResume: { boardRunId: 'r1', pausedByUser: true, autoResumeEligible: false } },
        { plan: { boardRunId: 'r1', prior: { pausedByUser: true, autoResumeEligible: false } }, marker: null }), null);
      assert.deepStrictEqual(boardPauseBackendAnswer(null, new Error('ipc closed')), { kind: 'failed', reason: 'ipc closed' });

      const confirmed = classifyBoardPauseOutcome({ acknowledgement: { ok: true, settled: true }, children: [paused, idle], phase: 'searches' });
      assert(confirmed.confirmed && !confirmed.restoreMarks);
      assert.deepStrictEqual(confirmed.searches, { total: 2, paused: 1, idle: 1, failed: 0 });

      // Refused with nothing else paused: the mark comes back and the text says the work runs on.
      const combineRefused = classifyBoardPauseOutcome({ acknowledgement: refusal, children: [], phase: 'combine', hasCombineMarker: true });
      assert(!combineRefused.confirmed && combineRefused.restoreMarks);
      const combineText = boardPauseRefusalMessage(combineRefused, { marksRestored: true });
      assert(/was not confirmed/.test(combineText) && /refused the Job Board's pause \(ownership-mismatch\)/.test(combineText)
        && /still running/.test(combineText) && /not marked paused/.test(combineText));
      assert(!/Search/.test(combineText.replace('Job Board', '')), 'no Search claim when no Search was asked to pause');

      // Every active Search really paused while the app refused: the Searches are
      // paused, so the mark stays and the text must not claim nothing paused.
      const searchesPaused = classifyBoardPauseOutcome({ acknowledgement: refusal, children: [paused, paused, idle], phase: 'searches' });
      assert(!searchesPaused.confirmed && !searchesPaused.restoreMarks);
      const pausedText = boardPauseRefusalMessage(searchesPaused);
      assert(/All 2 active Searches paused and saved\./.test(pausedText) && /stays marked paused/.test(pausedText)
        && /stopped none of the Board's own work/.test(pausedText));
      // The same answers with a Board Combine handoff, or outside the searches
      // phase, leave Board work unproven: restore.
      assert(classifyBoardPauseOutcome({ acknowledgement: refusal, children: [paused], phase: 'searches', hasCombineMarker: true }).restoreMarks);
      assert(classifyBoardPauseOutcome({ acknowledgement: refusal, children: [paused], phase: 'combine' }).restoreMarks);
      // Only idle children: nothing was paused, so nothing justifies the mark.
      assert(classifyBoardPauseOutcome({ acknowledgement: refusal, children: [idle], phase: 'searches' }).restoreMarks);

      // The app confirmed but a Search did not pause: that Search may still run.
      const childFailed = classifyBoardPauseOutcome({ acknowledgement: { ok: true, settled: true }, children: [paused, failed, rejected], phase: 'searches' });
      assert(!childFailed.confirmed && childFailed.restoreMarks && childFailed.backend === 'confirmed');
      const childText = boardPauseRefusalMessage(childFailed, { marksRestored: true });
      assert(/1 of 3 active Searches paused and saved; 2 did not confirm and may still be running\./.test(childText)
        && /The Job Board's own work stopped\./.test(childText));
      assert(/The active Search did not confirm its pause and may still be running\./.test(boardPauseRefusalMessage(
        classifyBoardPauseOutcome({ acknowledgement: notSettled, children: [failed], phase: 'searches' }), { marksRestored: true })));
      // Restoring was due but the saved run had changed: say the mark was left.
      assert(/paused mark was left as it is/.test(boardPauseRefusalMessage(combineRefused, { marksRestored: false })));

      // Restore patch: only this attempt's own marks, same run, still paused.
      const applied = {
        plan: { boardRunId: 'board-1', prior: { pausedByUser: undefined, autoResumeEligible: true } },
        marker: { runId: 'manual-1', existed: true, priorValue: { runId: 'manual-1' }, prior: { pausedByUser: undefined, autoResumeEligible: undefined } },
      };
      const data = {
        boardScanResume: { boardRunId: 'board-1', phase: 'searches', pausedByUser: true, autoResumeEligible: false, updatedAt: 1 },
        manualAiResume: { runId: 'manual-1', combineInputSignature: 'sig', pausedByUser: true, autoResumeEligible: false, updatedAt: 1 },
      };
      const patch = boardPauseRestorePatch(data, applied, 50);
      assert.deepStrictEqual(patch.boardScanResume, { boardRunId: 'board-1', phase: 'searches', autoResumeEligible: true, updatedAt: 50 });
      assert.deepStrictEqual(patch.manualAiResume, { runId: 'manual-1', combineInputSignature: 'sig', updatedAt: 50 });
      // A marker the attempt created goes back to what was there before.
      const created = boardPauseRestorePatch({ manualAiResume: data.manualAiResume },
        { plan: null, marker: { runId: 'manual-1', existed: false, priorValue: null, prior: {} } });
      assert.deepStrictEqual(created, { manualAiResume: null });
      // A different run, or flags someone already changed, are never touched.
      assert.strictEqual(boardPauseRestorePatch({ boardScanResume: { ...data.boardScanResume, boardRunId: 'board-2' },
        manualAiResume: { ...data.manualAiResume, runId: 'manual-2' } }, applied), null);
      assert.strictEqual(boardPauseRestorePatch({ boardScanResume: { ...data.boardScanResume, pausedByUser: false, autoResumeEligible: true } },
        applied), null);
      assert.strictEqual(boardPauseRestorePatch({}, applied), null);
      assert.strictEqual(boardPauseRestorePatch(data, null), null);
    },
  },

  {
    name: 'Board pause refusal: the production Board pauser takes back its own paused marks and reports what paused',
    run: async () => {
      const source = readNodeSource();
      const start = source.indexOf('const pauseBoardForQuit = useCallback(') + 'const pauseBoardForQuit = useCallback('.length;
      const end = source.indexOf('}, [canvasFilePath, data, epoch, getNode, id, moduleRunQueue, updateGlobal]', start) + 1;
      assert(start > 100 && end > start);
      const ref = current => ({ current });
      const build = ({ live, backend, sources = [] }) => {
        const state = { live, errors: [], bumps: 0, logs: [] };
        const noop = () => {};
        state.pause = new Function('scope', `with (scope) { return (${source.slice(start, end)}); }`)({
          id: 'board', data: {}, canvasFilePath: '/c.canvas', getNode: () => ({ data: state.live }), jobWorkflowNeedsQuitPause: () => true,
          scanRunRef: ref(Symbol('scan')), scanPreflightRef: ref(null), boardPauseAttemptRef: ref(0), pauseRefusalMessageRef: ref(null), combineRunRef: ref(null),
          combineRecoveryTokenClaimRef: ref(null), activeCombineManualAiRunRef: ref(null),
          activeSearchModuleIdRef: ref(null), activeSearchModuleIdsRef: ref(new Set(sources)),
          combineInputSignaturesRef: ref(new Map()), combineSourceRunsRef: ref(new Map()), compensationRequestIdRef: ref(null),
          updateGlobal: (_id, updater) => {
            const patch = typeof updater === 'function' ? updater({ type: 'jobboard', data: state.live }) : updater;
            if (patch) state.live = { ...state.live, ...patch };
          },
          epoch: { bump: () => { state.bumps += 1; } }, moduleRunQueue: { cancelQueuedRunsOwnedByNode: noop },
          window: { electronAPI: { pauseJobRunAndCancel: backend } },
          setScanning: noop, setScanProgress: noop, setCombining: noop, setCompensationProgress: noop, setCombineResearchProgress: noop,
          setRecoveryError: message => { state.errors.push(message); },
          savedPauseMessageForPlan: () => 'Paused', savedWorkflowQuitPausePatch: () => null, settlePreFenceCanvasBatches: async () => {},
          classifyBoardPauseOutcome, boardPauseRestorePatch, boardPauseRefusalMessage,
          EventLogger: { log: line => { state.logs.push(line); } },
        });
        return state;
      };
      const plan = () => ({ version: 1, boardRunId: 'board-1', phase: 'searches', autoResumeEligible: true });
      const refusal = async () => ({ ok: false, paused: false, settled: false, tokenMismatch: true, reason: 'ownership-mismatch' });

      // The app refuses and the one active Search does not pause either.
      let state = build({ live: { boardScanResume: plan() }, backend: refusal, sources: ['search-1'] });
      await assert.rejects(state.pause({ pauseSearchModule: async () => ({ success: false }) }),
        /did not confirm its pause and may still be running.*asked the Job Board's own work to stop but did not confirm a saved pause \(ownership-mismatch\).*not marked paused/);
      assert.strictEqual(state.live.boardScanResume.autoResumeEligible, true, 'auto-resume is switched back on');
      assert(!('pausedByUser' in state.live.boardScanResume), 'the Board is no longer marked paused by the user');
      assert.strictEqual(state.live.boardScanResume.boardRunId, 'board-1', 'the saved run itself is kept');
      assert.strictEqual(state.errors.length, 1, 'the Board shows the refusal');
      assert(state.logs.some(line => /pause not confirmed .*backend=not-settled reason=ownership-mismatch .*searches-failed=1 marks=restored/.test(line)));
      assert.strictEqual(state.bumps, 1, 'the fence is still raised before the app is asked; it is not undone');

      // The app refuses but the active Search paused and saved: the mark stays.
      state = build({ live: { boardScanResume: plan() }, backend: refusal, sources: ['search-1'] });
      await assert.rejects(state.pause({ pauseSearchModule: async () => ({ success: true }) }),
        /The active Search paused and saved\..*stays marked paused/);
      assert(state.live.boardScanResume.pausedByUser === true && state.live.boardScanResume.autoResumeEligible === false);

      // A thrown backend call no longer skips the child answers or leaves the mark.
      state = build({ live: { boardScanResume: plan() }, backend: async () => { throw new Error('ipc closed'); } });
      await assert.rejects(state.pause({}), /pause request to the app failed \(ipc closed\).*not marked paused/);
      assert.strictEqual(state.live.boardScanResume.autoResumeEligible, true);

      // A newer run that replaced the plan while the app answered is left alone.
      state = build({ live: { boardScanResume: plan() }, backend: async () => {
        state.live = { boardScanResume: { version: 1, boardRunId: 'board-2', pausedByUser: true, autoResumeEligible: false } };
        return refusal();
      } });
      await assert.rejects(state.pause({}), /paused mark was left as it is/);
      assert.deepStrictEqual(state.live.boardScanResume, { version: 1, boardRunId: 'board-2', pausedByUser: true, autoResumeEligible: false });

      // No pauser for an active Search: refused before any mark is written.
      state = build({ live: { boardScanResume: plan() }, backend: refusal, sources: ['search-1'] });
      await assert.rejects(state.pause({}), /cannot save its active Search owners/);
      assert.deepStrictEqual(state.live.boardScanResume, plan());
      assert.strictEqual(state.bumps, 0);

      // The confirmed path is unchanged.
      state = build({ live: { boardScanResume: plan() }, backend: async () => ({ ok: true, settled: true }) });
      state.live.boardScanResume.autoResumeEligible = true;
      const result = await state.pause({}).catch(error => error);
      assert(state.live.boardScanResume.pausedByUser === true && state.errors[0] === 'Paused',
        `a confirmed pause keeps its marks (${result?.message || 'ok'})`);
    },
  },

  {
    name: 'board recovery notice constant text is exact and mismatch reason reports the first failing invariant',
    run: async () => {
      assert(
        SAVED_HANDOFF_READY_MESSAGE === 'Saved AI handoff ready. Choose Continue saved AI handoff to resume this exact Board run.',
        'SAVED_HANDOFF_READY_MESSAGE must keep its exact user-facing text',
      );
      assert.strictEqual(SAVED_SEARCH_PAUSE_MESSAGE,
        'Search paused and saved. Choose Continue search to resume this exact Board run.');
      assert.strictEqual(savedPauseMessageForPlan({ phase: 'searches' }, null), SAVED_SEARCH_PAUSE_MESSAGE);
      assert.strictEqual(savedPauseMessageForPlan({}, null), SAVED_SEARCH_PAUSE_MESSAGE, 'a plan without a phase is a searches plan');
      assert.strictEqual(savedPauseMessageForPlan({ phase: 'searches' }, { runId: 'combine' }), SAVED_HANDOFF_READY_MESSAGE);
      assert.strictEqual(savedPauseMessageForPlan(null, { runId: 'combine' }), SAVED_HANDOFF_READY_MESSAGE);

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
      const clearEffect = source.indexOf('if (!isSavedPauseNotice(recoveryError)) return;');
      assert(clearEffect !== -1, 'clearing effect must recognise both saved-pause notices');
      assert(isSavedPauseNotice(SAVED_HANDOFF_READY_MESSAGE) && isSavedPauseNotice(SAVED_SEARCH_PAUSE_MESSAGE)
        && !isSavedPauseNotice('A real recovery failure'));
      const clearCall = source.indexOf('setRecoveryError(null)', clearEffect);
      assert(clearCall !== -1 && clearCall - clearEffect < 1500, 'clearing effect must call setRecoveryError(null)');

      // (d) The supersede log now names which invariant failed.
      assert(source.includes('[JobBoard] combine superseded before commit id=${id} signature=${sigAtCombine} reason=${mismatchReason}'), 'supersede log must append reason=');
    },
  },
  {
    name: 'Board Combine treats a dock cancellation as its own cancellation and never offers the cancelled run as a saved handoff',
    run: async () => {
      const source = readNodeSource();

      // (1) The saved-handoff notice effect must return before it sets the
      // notice whenever the Board already carries a cancellation receipt or a
      // cancellation is still in flight.
      const effectStart = source.indexOf('    const resume = data.manualAiResume;');
      const effectEnd = source.indexOf('\n  }, [', effectStart);
      assert(effectStart > 0 && effectEnd > effectStart, 'the manual-AI marker effect must be locatable');
      const noticeEffect = new Function(
        'data', 'getNode', 'id', 'updateGlobal', 'canvasFilePath', 'isBoardCombineManualAiRunId',
        'boardRecoveryTouchesPendingDeletion', 'autoResumedManualAiRunRef', 'retiredCombineManualAiRunIdsRef',
        'isLiveCombineOwnedMarker', 'activeCombineManualAiRunRef', 'cancellationInFlightRef', 'recoveryError',
        'setRecoveryError', 'SAVED_HANDOFF_READY_MESSAGE', 'combineRunRef', 'EventLogger',
        source.slice(effectStart, effectEnd),
      );
      const runNoticeEffect = ({ boardCancellation, cancellationInFlight } = {}) => {
        const notices = [];
        const ref = value => ({ current: value });
        noticeEffect(
          { boardCancellation, manualAiResume: { runId: 'job-board:board-1:combine', retirementPending: false } },
          () => ({ data: {} }), 'board-1', () => {}, '/canvas.json', isBoardCombineManualAiRunId,
          () => false, ref(null), ref(new Set()), isLiveCombineOwnedMarker, ref(null),
          ref(cancellationInFlight), null, value => notices.push(value), SAVED_HANDOFF_READY_MESSAGE, ref(null),
          { log: () => {} },
        );
        return notices;
      };
      assert.deepStrictEqual(runNoticeEffect(), [SAVED_HANDOFF_READY_MESSAGE],
        'an interrupted handoff with no cancellation still offers Continue');
      assert.deepStrictEqual(runNoticeEffect({ boardCancellation: { operationId: 'op-1' } }), [],
        'a cancelled run must never be advertised as a saved, resumable handoff');
      assert.deepStrictEqual(runNoticeEffect({ cancellationInFlight: Symbol('job-board-cancel') }), [],
        'a cancellation that is still in flight must not advertise the run either');
      const guardAt = source.indexOf('if (data.boardCancellation || cancellationInFlightRef.current) return;', effectStart);
      const noticeAt = source.indexOf('setRecoveryError(message)', effectStart);
      assert(guardAt > 0 && noticeAt > guardAt, 'the cancellation guard must run before the notice is set');

      // (2) A dock "Cancel task" aborts a stage before its DOM event lands, so
      // every user-cancellation exit must start the Board's own exact
      // cancellation through one shared helper.
      const combineStart = source.indexOf('const handleCombine = useCallback(');
      const depsStart = source.indexOf('\n  }, [', combineStart);
      assert(combineStart > 0 && depsStart > combineStart, 'handleCombine must be locatable');
      const combineBody = source.slice(combineStart, depsStart);
      const pausedForQuitCheck = combineBody.indexOf("if (err?.pausedForQuit === true) return { status: 'paused', reason: 'awaiting-explicit-ai-continue' };");
      assert(pausedForQuitCheck > 0, 'a quit-paused refresh must be reported as paused, not cancelled');
      assert(pausedForQuitCheck < combineBody.indexOf("return cancelledOutsideBoard('pipeline');"),
        'the quit pause must be classified before the pipeline cancellation exit');
      const exits = [
        "if (isJobBoardUserCancellation(res)) return cancelledOutsideBoard('taxonomy');",
        "if (isJobBoardUserCancellation(err)) return cancelledOutsideBoard('taxonomy');",
        "if (isJobBoardUserCancellation(confirmation)) return cancelledOutsideBoard('location-consolidation');",
        "if (boardResearch.cancelled) return cancelledOutsideBoard('official-postings');",
        "if (isJobBoardUserCancellation(compensationResult)) return cancelledOutsideBoard('compensation');",
        "if (isJobBoardUserCancellation(err)) return cancelledOutsideBoard('compensation');",
        "if (isJobBoardUserCancellation(err)) return cancelledOutsideBoard('pipeline');",
      ];
      for (const exit of exits) {
        assert(combineBody.includes(exit), `every user cancellation must start the Board cancellation: ${exit}`);
      }
      assert((combineBody.match(/return cancelledOutsideBoard\(/gu) || []).length === exits.length,
        'no user-cancellation exit may bypass the shared helper');
      const depsEnd = source.indexOf(']);', depsStart);
      assert(depsEnd > depsStart, 'handleCombine dependencies must be locatable');
      assert(/\bhandleCancelRun\b/.test(source.slice(depsStart, depsEnd)),
        'handleCombine must depend on handleCancelRun');

      // The helper must start a cancellation only when this Board did not start
      // it, and it must keep the stage in the log line.
      const helperStart = source.indexOf('    const cancelledOutsideBoard = (stage) => {', combineStart);
      const helperEnd = source.indexOf('\n    };', helperStart);
      assert(helperStart > combineStart && helperEnd > helperStart, 'the shared cancellation helper must be locatable');
      const helperArrow = source.slice(helperStart, helperEnd + '\n    };'.length)
        .replace(/^\s*const cancelledOutsideBoard = /u, '').replace(/;\s*$/u, '');
      const buildHelper = new Function('cancelled', 'handleCancelRun', 'EventLogger', 'id', `return (${helperArrow});`);
      const runHelper = alreadyCancelled => {
        const started = []; const lines = [];
        const helper = buildHelper(() => alreadyCancelled, () => { started.push('cancel'); },
          { log: line => lines.push(line) }, 'board-1');
        return { result: helper('pipeline'), started, lines };
      };
      const externalCancel = runHelper(false);
      assert.deepStrictEqual(externalCancel.result, { status: 'cancelled' },
        'a cancellation from the dock must still report cancelled');
      assert.equal(externalCancel.started.length, 1,
        'a cancellation the Board did not start must start the Board cancellation now');
      assert(externalCancel.lines.length === 1 && externalCancel.lines[0].includes('stage=pipeline'),
        'the helper must keep the stage in its log line');
      const internalCancel = runHelper(true);
      assert.deepStrictEqual(internalCancel.result, { status: 'cancelled' });
      assert.equal(internalCancel.started.length, 0,
        'a cancellation this Board already started must not be restarted');

      // (3) Keeping the retired operation id remembered stops the stale-render
      // retry from replaying a cancellation that already finished.
      const sliceCallback = name => {
        const start = source.indexOf(`  const ${name} = useCallback(`);
        const end = source.indexOf('\n  }, [', start);
        assert(start > 0 && end > start, `${name} must be locatable`);
        return source.slice(start, end);
      };
      for (const name of ['handleCancelRun', 'handleClear']) {
        assert(!sliceCallback(name).includes('autoRetriedBoardCancellationRef.current = null'),
          `${name} must keep the retired operation id remembered after a successful cancellation`);
      }
      const cancelRunBody = sliceCallback('handleCancelRun');
      assert(cancelRunBody.includes('autoRetriedBoardCancellationRef.current = cancellationIntent.operationId;'),
        'the success path must still remember which operation it retired');
      assert(cancelRunBody.includes("setRecoveryError('The active Job Search could not be cancelled safely. Retry this cancellation.');"),
        'the cancellation failure path must stay unchanged');
    },
  },
];
