import assert from 'node:assert';

import {
  JOB_BOARD_CAREER_OVERRIDE_VERSION,
  JOB_BOARD_CAREER_OVERRIDE_RUN_PREFIX,
  isJobBoardCareerOverrideRunId,
  createJobBoardCareerOverrideRunId,
  normalizeJobBoardCareerOverride,
  approvedJobBoardCareerOverrideSnapshotId,
  beginJobBoardCareerOverride,
  resumeJobBoardCareerOverride,
  approveJobBoardCareerOverride,
  failJobBoardCareerOverride,
  discardJobBoardCareerOverridePending,
  clearJobBoardCareerOverride,
  markJobBoardCareerOverrideRunsRetired,
  queueJobBoardCareerOverrideRetire,
  jobBoardCareerOverrideRunIds,
  hasActiveJobBoardCareerOverrideRun,
  resolveApplicationCareerSnapshotId,
  resolveSalaryCareerSnapshotId,
  jobBoardCareerOverrideView,
  isBoardCombineManualAiRunId,
  careerOverrideBoardMarkerCleanup,
} from '../../src/utils/jobBoardCareerOverride.js';
import { collectDeletedManualAiRetirements } from '../../src/utils/canvasInteractions.js';
import { hasActiveExternalRunState } from '../../src/utils/undoNonRestorableState.js';
import { cloneNode } from '../../src/utils/nodeFactory.js';

const SNAP_A = 'a'.repeat(64);
const SNAP_B = 'b'.repeat(64);
const SNAP_C = 'c'.repeat(64);
const RUN_1 = 'job-board-career:board-1:run1';
const RUN_2 = 'job-board-career:board-1:run2';
const RUN_3 = 'job-board-career:board-1:run3';

function approved(overrides = {}) {
  return {
    careerSnapshotId: SNAP_A,
    generation: RUN_1,
    fileNames: ['cv.pdf'],
    approvedAt: 1000,
    profileFingerprint: 'fp-1',
    ...overrides,
  };
}

function pending(overrides = {}) {
  return {
    version: 1,
    generation: RUN_2,
    attemptId: 'attempt-2',
    status: 'compiling',
    manualAiRunId: RUN_2,
    startedAt: 2000,
    filePaths: ['/tmp/new.pdf'],
    fileNames: ['new.pdf'],
    ...overrides,
  };
}

function board(record) {
  return { jobBoardCareerOverride: record };
}

const COMBINE_RUN = 'job-board:board-1:combine-1';
const COMBINE_RUN_2 = 'job-board:board-1:combine-2';

export default [
  {
    name: 'salary source: Board wins; an empty Board uses the most recent connected Search import',
    run: () => {
      const search = (id, careerSnapshotId, approvedAt) => ({ id, data: { careerSnapshotId,
        careerImportCompilation: { status: 'approved', careerSnapshotId, approvedAt } } });
      const modules = [search('older', SNAP_B, 1000), search('newer', SNAP_C, 3000)];
      assert.deepStrictEqual(resolveSalaryCareerSnapshotId({ boardData: board({ version: 1, approved: approved(), pending: null, retirePending: [] }), searchModules: modules }),
        { careerSnapshotId: SNAP_A, source: 'board', blocked: false });
      for (const searchModules of [modules, [...modules].reverse()]) {
        assert.deepStrictEqual(resolveSalaryCareerSnapshotId({ boardData: {}, searchModules }),
          { careerSnapshotId: SNAP_C, source: 'search', blocked: false });
      }
      assert.deepStrictEqual(resolveSalaryCareerSnapshotId({ boardData: {}, searchModules: [] }),
        { careerSnapshotId: null, source: null, blocked: false });
      assert.deepStrictEqual(resolveSalaryCareerSnapshotId({ boardData: board({ version: 1, approved: null, pending: pending(), retirePending: [] }), searchModules: modules }),
        { careerSnapshotId: null, source: 'board', blocked: true });
      const tied = [search('z', SNAP_B, 3000), search('a', SNAP_C, 3000)];
      assert.deepStrictEqual(resolveSalaryCareerSnapshotId({ searchModules: tied }), resolveSalaryCareerSnapshotId({ searchModules: [...tied].reverse() }),
        'identical import times must resolve deterministically');
    },
  },
  {
    name: 'career override: isBoardCombineManualAiRunId separates Board runs from career runs',
    run: () => {
      assert.strictEqual(isBoardCombineManualAiRunId(COMBINE_RUN), true);
      assert.strictEqual(isBoardCombineManualAiRunId('search-run-7'), true);
      assert.strictEqual(isBoardCombineManualAiRunId(RUN_1), false);
      assert.strictEqual(isBoardCombineManualAiRunId(''), false);
      assert.strictEqual(isBoardCombineManualAiRunId(null), false);
      assert.strictEqual(isBoardCombineManualAiRunId(undefined), false);
      assert.strictEqual(isBoardCombineManualAiRunId(42), false);
      assert.strictEqual(isBoardCombineManualAiRunId({ runId: COMBINE_RUN }), false);
    },
  },
  {
    name: 'career override: Board marker cleanup clears a saved career manualAiResume only',
    run: () => {
      const record = { version: 1, approved: approved(), pending: pending(), retirePending: [RUN_3] };
      const saved = {
        label: 'Board',
        jobBoardCareerOverride: record,
        boardScanResume: null,
        manualAiResume: { runId: RUN_2, task: 'career', startedAt: 10, updatedAt: 20 },
      };
      const patch = careerOverrideBoardMarkerCleanup(saved);
      assert.deepStrictEqual(patch, { manualAiResume: null });
      const applied = { ...saved, ...patch };
      assert.strictEqual(applied.manualAiResume, null);
      assert.deepStrictEqual(applied.jobBoardCareerOverride, record);
      assert.strictEqual(careerOverrideBoardMarkerCleanup(applied), null, 'idempotent');

      const combine = {
        manualAiResume: { runId: COMBINE_RUN, task: 'combine' },
        boardScanResume: { boardRunId: 'br-1', combineManualAiRunId: RUN_1 },
        jobBoardCareerOverride: record,
      };
      assert.strictEqual(careerOverrideBoardMarkerCleanup(combine), null);
      assert.strictEqual(careerOverrideBoardMarkerCleanup({}), null);
      assert.strictEqual(careerOverrideBoardMarkerCleanup(null), null);
      assert.strictEqual(careerOverrideBoardMarkerCleanup({ manualAiResume: { task: 'x' } }), null);
    },
  },
  {
    name: 'career override: Board marker cleanup filters only career ids from receipts and cancellation',
    run: () => {
      const combineReceipt = { runId: COMBINE_RUN, nodeId: 'board-1', reason: 'superseded' };
      const careerReceipt = { runId: RUN_1, nodeId: 'board-1', reason: 'superseded' };
      const combineReceipt2 = { runId: COMBINE_RUN_2, nodeId: 'board-1' };
      const cancellation = {
        operationId: 'op-1',
        boardRunId: 'br-1',
        reason: 'board-run-cancelled',
        manualAiRunIds: [COMBINE_RUN, RUN_2, COMBINE_RUN_2, RUN_3],
      };
      const saved = {
        manualAiResume: { runId: COMBINE_RUN, task: 'combine' },
        manualAiCleanupReceipts: [combineReceipt, careerReceipt, combineReceipt2],
        boardCancellation: cancellation,
      };
      const patch = careerOverrideBoardMarkerCleanup(saved);
      assert.deepStrictEqual(patch, {
        manualAiCleanupReceipts: [combineReceipt, combineReceipt2],
        boardCancellation: {
          operationId: 'op-1',
          boardRunId: 'br-1',
          reason: 'board-run-cancelled',
          manualAiRunIds: [COMBINE_RUN, COMBINE_RUN_2],
        },
      });
      assert.deepStrictEqual(saved.boardCancellation.manualAiRunIds, [COMBINE_RUN, RUN_2, COMBINE_RUN_2, RUN_3], 'input not mutated');
      assert.strictEqual(careerOverrideBoardMarkerCleanup({ ...saved, ...patch }), null, 'idempotent');

      const onlyReceipts = careerOverrideBoardMarkerCleanup({
        manualAiCleanupReceipts: [careerReceipt],
        boardCancellation: { operationId: 'op-2', manualAiRunIds: [COMBINE_RUN] },
      });
      assert.deepStrictEqual(onlyReceipts, { manualAiCleanupReceipts: [] });

      const allClean = {
        manualAiResume: { runId: COMBINE_RUN },
        manualAiCleanupReceipts: [combineReceipt],
        boardCancellation: { operationId: 'op-3', manualAiRunIds: [COMBINE_RUN_2] },
      };
      assert.strictEqual(careerOverrideBoardMarkerCleanup(allClean), null);
    },
  },
  {
    name: 'career override: constants and run id grammar',
    run: () => {
      assert.strictEqual(JOB_BOARD_CAREER_OVERRIDE_VERSION, 1);
      assert.strictEqual(JOB_BOARD_CAREER_OVERRIDE_RUN_PREFIX, 'job-board-career:');
      assert.strictEqual(isJobBoardCareerOverrideRunId(RUN_1), true);
      assert.strictEqual(isJobBoardCareerOverrideRunId('job-board:board-1:1'), false);
      assert.strictEqual(isJobBoardCareerOverrideRunId('job-board-career:bad id'), false);
      assert.strictEqual(isJobBoardCareerOverrideRunId(42), false);
      const id = createJobBoardCareerOverrideRunId('node-7');
      assert.strictEqual(id.startsWith('job-board-career:node-7:'), true);
      const entropy = id.slice('job-board-career:node-7:'.length);
      assert.ok(entropy.length > 0);
      assert.strictEqual(entropy.includes(':'), false);
      assert.strictEqual(isJobBoardCareerOverrideRunId(id), true);
    },
  },
  {
    name: 'career override: normalize round-trips and fails closed',
    run: () => {
      const valid = { version: 1, approved: approved(), pending: pending(), retirePending: [RUN_3] };
      assert.deepStrictEqual(normalizeJobBoardCareerOverride(valid), valid);
      assert.strictEqual(normalizeJobBoardCareerOverride({ ...valid, version: 2 }), null);
      assert.strictEqual(normalizeJobBoardCareerOverride([valid]), null);
      assert.strictEqual(normalizeJobBoardCareerOverride(Object.create(valid)), null);
      assert.strictEqual(normalizeJobBoardCareerOverride(
        JSON.parse('{"version":1,"__proto__":{"x":1},"approved":null}'),
      ), null);

      const badSnap = normalizeJobBoardCareerOverride({ ...valid, approved: approved({ careerSnapshotId: 'xyz' }) });
      assert.strictEqual(badSnap.approved, null);
      assert.deepStrictEqual(badSnap.pending, pending());

      const wrongPrefix = normalizeJobBoardCareerOverride({
        ...valid,
        pending: pending({ manualAiRunId: 'job-board:x:1' }),
      });
      assert.strictEqual(wrongPrefix.pending, null);
      assert.deepStrictEqual(wrongPrefix.approved, approved());

      assert.strictEqual(normalizeJobBoardCareerOverride({
        version: 1,
        approved: approved({ careerSnapshotId: 'nope' }),
        pending: pending({ status: 'approved' }),
        retirePending: ['job-board:x:1', 7],
      }), null);

      const retire = normalizeJobBoardCareerOverride({
        version: 1, approved: null, pending: null,
        retirePending: [RUN_1, RUN_1, 'job-board:x:1', RUN_2],
      });
      assert.deepStrictEqual(retire.retirePending, [RUN_1, RUN_2]);
      assert.strictEqual(approvedJobBoardCareerOverrideSnapshotId(board(valid)), SNAP_A);
      assert.strictEqual(approvedJobBoardCareerOverrideSnapshotId(board(retire)), null);
    },
  },
  {
    name: 'career override: begin creates, refuses and replaces a failed pending',
    run: () => {
      const start = board({ version: 1, approved: approved(), pending: null, retirePending: [] });
      const next = beginJobBoardCareerOverride(start, {
        nodeId: 'board-9', filePaths: ['/a.pdf', '/b.txt'], fileNames: ['a.pdf', 'b.txt'], now: 5000,
      });
      assert.strictEqual(next.pending.status, 'compiling');
      assert.strictEqual(next.pending.manualAiRunId.startsWith('job-board-career:board-9:'), true);
      assert.strictEqual(next.pending.generation, next.pending.manualAiRunId);
      assert.deepStrictEqual(next.pending.filePaths, ['/a.pdf', '/b.txt']);
      assert.deepStrictEqual(next.pending.fileNames, ['a.pdf', 'b.txt']);
      assert.strictEqual(next.pending.startedAt, 5000);
      assert.deepStrictEqual(next.approved, approved());

      assert.strictEqual(beginJobBoardCareerOverride(board(next), {
        nodeId: 'board-9', filePaths: ['/c.pdf'], fileNames: ['c.pdf'],
      }), null);
      assert.strictEqual(beginJobBoardCareerOverride(start, {
        nodeId: 'board-9', filePaths: ['/c.pdf'], fileNames: [],
      }), null);
      assert.strictEqual(beginJobBoardCareerOverride(start, {
        nodeId: '', filePaths: ['/c.pdf'], fileNames: ['c.pdf'],
      }), null);

      const failed = board({ version: 1, approved: approved(), pending: pending({ status: 'failed', error: 'x' }), retirePending: [RUN_3] });
      const replaced = beginJobBoardCareerOverride(failed, {
        nodeId: 'board-1', filePaths: ['/d.pdf'], fileNames: ['d.pdf'],
      });
      assert.deepStrictEqual(replaced.retirePending, [RUN_3, RUN_2]);
      assert.notStrictEqual(replaced.pending.manualAiRunId, RUN_2);
      assert.strictEqual(replaced.pending.status, 'compiling');
    },
  },
  {
    name: 'career override: approve requires the exact live run and a valid snapshot',
    run: () => {
      const data = board({ version: 1, approved: approved(), pending: pending(), retirePending: [] });
      assert.strictEqual(approveJobBoardCareerOverride(data, { careerSnapshotId: SNAP_B, manualAiRunId: RUN_3 }), null);
      assert.strictEqual(approveJobBoardCareerOverride(data, { careerSnapshotId: 'bad', manualAiRunId: RUN_2 }), null);
      const next = approveJobBoardCareerOverride(data, {
        careerSnapshotId: SNAP_B, manualAiRunId: RUN_2, profileFingerprint: 'fp-2', now: 9000,
      });
      assert.deepStrictEqual(next, {
        version: 1,
        approved: { careerSnapshotId: SNAP_B, generation: RUN_2, fileNames: ['new.pdf'], approvedAt: 9000, profileFingerprint: 'fp-2' },
        pending: null,
        retirePending: [],
      });
    },
  },
  {
    name: 'career override: fail then resume keeps the run id and paths',
    run: () => {
      const data = board({ version: 1, approved: null, pending: pending(), retirePending: [] });
      assert.strictEqual(failJobBoardCareerOverride(data, { manualAiRunId: RUN_1, error: 'boom' }), null);
      const failed = failJobBoardCareerOverride(data, { manualAiRunId: RUN_2, error: 'boom' });
      assert.strictEqual(failed.pending.status, 'failed');
      assert.strictEqual(failed.pending.error, 'boom');
      const resumed = resumeJobBoardCareerOverride(board(failed));
      assert.strictEqual(resumed.manualAiRunId, RUN_2);
      assert.deepStrictEqual(resumed.filePaths, ['/tmp/new.pdf']);
      assert.deepStrictEqual(resumed.fileNames, ['new.pdf']);
      assert.strictEqual(resumed.record.pending.status, 'compiling');
      assert.strictEqual(Object.hasOwn(resumed.record.pending, 'error'), false);
      assert.strictEqual(Object.hasOwn(resumed.record.pending, 'failedAt'), false);
      assert.strictEqual(resumed.record.pending.startedAt, 2000);
      assert.strictEqual(resumeJobBoardCareerOverride(board({ version: 1, approved: approved(), pending: null })), null);
    },
  },
  {
    name: 'career override: clear, discard and markRetired',
    run: () => {
      const compiling = { version: 1, approved: approved(), pending: pending(), retirePending: [RUN_3] };
      assert.deepStrictEqual(clearJobBoardCareerOverride(board(compiling)), compiling);

      const failed = { ...compiling, pending: pending({ status: 'failed', error: 'e', failedAt: 3 }) };
      assert.deepStrictEqual(clearJobBoardCareerOverride(board(failed)), {
        version: 1, approved: null, pending: null, retirePending: [RUN_3, RUN_2],
      });
      assert.strictEqual(clearJobBoardCareerOverride(board({ version: 1, approved: approved(), pending: null })), null);

      const discarded = discardJobBoardCareerOverridePending(board(compiling));
      assert.strictEqual(discarded.pending, null);
      assert.deepStrictEqual(discarded.approved, approved());
      assert.deepStrictEqual(discarded.retirePending, [RUN_3, RUN_2]);

      const retired = markJobBoardCareerOverrideRunsRetired(board(discarded), [RUN_3]);
      assert.deepStrictEqual(retired.retirePending, [RUN_2]);
      assert.strictEqual(markJobBoardCareerOverrideRunsRetired(
        board({ version: 1, approved: null, pending: null, retirePending: [RUN_3] }), [RUN_3],
      ), null);

      const queued = queueJobBoardCareerOverrideRetire(board(compiling), RUN_1);
      assert.deepStrictEqual(queued.retirePending, [RUN_3, RUN_1], 'queue appends an override run id once');
      assert.deepStrictEqual(queueJobBoardCareerOverrideRetire(board(queued), RUN_1).retirePending, [RUN_3, RUN_1], 'queue dedups');
      assert.deepStrictEqual(
        queueJobBoardCareerOverrideRetire(board(compiling), 'job-board:board-1:x'),
        compiling,
        'a combine run id is never queued for override retirement',
      );

      assert.deepStrictEqual(jobBoardCareerOverrideRunIds(board(compiling)), [RUN_2, RUN_3]);
      assert.strictEqual(hasActiveJobBoardCareerOverrideRun(board(compiling)), true);
      assert.strictEqual(hasActiveJobBoardCareerOverrideRun(board({ version: 1, approved: approved(), pending: null })), false);
    },
  },
  {
    name: 'career override: resolveApplicationCareerSnapshotId precedence',
    run: () => {
      const overrideBoard = board({ version: 1, approved: approved(), pending: null });
      assert.deepStrictEqual(
        resolveApplicationCareerSnapshotId({ cardData: { careerSnapshotId: SNAP_C }, boardData: overrideBoard }),
        { careerSnapshotId: SNAP_A, source: 'board', blocked: false },
      );
      assert.deepStrictEqual(
        resolveApplicationCareerSnapshotId({ cardData: { careerSnapshotId: SNAP_C }, boardData: {} }),
        { careerSnapshotId: null, source: null, blocked: false },
      );
      assert.deepStrictEqual(
        resolveApplicationCareerSnapshotId({ cardData: { careerSnapshotId: `  ${SNAP_C}\n` }, boardData: null }),
        { careerSnapshotId: SNAP_C, source: 'card' },
      );
      assert.deepStrictEqual(
        resolveApplicationCareerSnapshotId({ cardData: { careerSnapshotId: 'short' }, boardData: {} }),
        { careerSnapshotId: null, source: null, blocked: false },
      );
      const searches = [{ id: 'old', data: { careerSnapshotId: SNAP_B, careerImportCompilation: { status: 'approved', careerSnapshotId: SNAP_B, approvedAt: 1 } } },
        { id: 'latest', data: { careerSnapshotId: SNAP_A, careerImportCompilation: { status: 'approved', careerSnapshotId: SNAP_A, approvedAt: 2 } } }];
      for (const boardData of [{}, overrideBoard, board({ version: 1, approved: null, pending: pending(), retirePending: [] })]) {
        assert.deepStrictEqual(resolveApplicationCareerSnapshotId({ cardData: { careerSnapshotId: SNAP_C }, boardData, searchModules: searches }),
          resolveSalaryCareerSnapshotId({ boardData, searchModules: searches }),
          'application and salary selection must agree, including an unfinished Board import');
      }
    },
  },
  {
    name: 'career override: view model states and capabilities',
    run: () => {
      const empty = jobBoardCareerOverrideView({});
      assert.strictEqual(empty.state, 'empty');
      assert.strictEqual(empty.canImport, true);
      assert.strictEqual(empty.canClear, false);
      assert.strictEqual(empty.retirePendingCount, 0);

      const compilingData = board({ version: 1, approved: approved(), pending: pending(), retirePending: [RUN_3] });
      const compiling = jobBoardCareerOverrideView(compilingData, { localRunId: RUN_2 });
      assert.strictEqual(compiling.state, 'compiling');
      assert.strictEqual(compiling.canImport, false);
      assert.strictEqual(compiling.canClear, false);
      assert.strictEqual(compiling.canResume, false);
      assert.strictEqual(compiling.retirePendingCount, 1);
      assert.deepStrictEqual(compiling.pending, { fileNames: ['new.pdf'], manualAiRunId: RUN_2, error: null });

      const interrupted = jobBoardCareerOverrideView(compilingData, { localRunId: RUN_1 });
      assert.strictEqual(interrupted.state, 'interrupted');
      assert.strictEqual(interrupted.canResume, true);
      assert.strictEqual(interrupted.canDiscard, true);
      assert.strictEqual(interrupted.canImport, true);

      const failed = jobBoardCareerOverrideView(board({
        version: 1, approved: null, pending: pending({ status: 'failed', error: 'bad file' }),
      }));
      assert.strictEqual(failed.state, 'failed');
      assert.strictEqual(failed.pending.error, 'bad file');
      assert.strictEqual(failed.canResume, true);

      const approvedView = jobBoardCareerOverrideView(board({ version: 1, approved: approved(), pending: null }));
      assert.strictEqual(approvedView.state, 'approved');
      assert.deepStrictEqual(approvedView.approved, { fileNames: ['cv.pdf'], approvedAt: 1000, careerSnapshotId: SNAP_A });
      assert.strictEqual(approvedView.canClear, true);
      assert.strictEqual(approvedView.canResume, false);

      const locked = jobBoardCareerOverrideView(board({ version: 1, approved: approved(), pending: null }), { locked: true });
      assert.strictEqual(locked.canImport, false);
      assert.strictEqual(locked.canClear, false);
    },
  },
  {
    name: 'career override: deletion, undo and clone lifecycle',
    run: () => {
      const record = { version: 1, approved: approved(), pending: pending(), retirePending: [RUN_3] };
      const retirements = collectDeletedManualAiRetirements([
        { id: 'board-1', type: 'jobboard', data: { jobBoardCareerOverride: record } },
      ]);
      assert.deepStrictEqual(
        retirements.map(entry => entry.runId).sort(),
        [RUN_2, RUN_3].sort(),
      );
      assert.ok(retirements.every(entry => entry.nodeId === 'board-1'));
      assert.deepStrictEqual(collectDeletedManualAiRetirements([
        { id: 'hub-1', type: 'jobhub', data: { jobBoardCareerOverride: record } },
      ]), []);

      assert.strictEqual(hasActiveExternalRunState([
        { id: 'board-1', type: 'jobboard', data: { jobBoardCareerOverride: record } },
      ]), true);
      assert.strictEqual(hasActiveExternalRunState([
        { id: 'board-1', type: 'jobboard', data: { jobBoardCareerOverride: { version: 1, approved: approved(), pending: null } } },
      ]), false);

      const clone = cloneNode({
        id: 'board-1', type: 'jobboard', position: { x: 0, y: 0 },
        data: { label: 'Board', jobBoardCareerOverride: record },
      });
      assert.notStrictEqual(clone.id, 'board-1');
      assert.strictEqual(Object.hasOwn(clone.data, 'jobBoardCareerOverride'), false);
      assert.strictEqual(clone.data.label, 'Board');
    },
  },
];
