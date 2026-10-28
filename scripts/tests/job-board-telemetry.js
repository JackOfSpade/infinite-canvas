import assert from 'node:assert/strict';
import electronPkg from 'electron';
import { __runWithIpcRequestContextForTests as withRequest } from '../../electron/ipc/ipcUtils.js';
import {
  __registerJobsHandlersForTests, __resetJobsTelemetryForTests, getJobsBoardTelemetryForReport,
  getJobsTelemetry, getJobsTelemetryForReport, recordJobsSourceScope,
} from '../../electron/ipc/jobs.js';

const sender = id => ({ id, getURL: () => 'file:///synthetic-canvas.html',
  isDestroyed: () => false, once() {}, on() {}, removeListener() {}, send() {} });
const inRequest = (owner, nodeId, channel, callback) => withRequest({ sender: owner, nodeId, channel }, callback);
const report = (owner, ids, windowId = owner.id, canvasFilePath = undefined) => inRequest(owner, null, 'bug-report',
  () => getJobsBoardTelemetryForReport(new Set(ids), windowId, canvasFilePath));
const source = (owner, nodeId) => inRequest(owner, nodeId, 'search-jobs', () => {
  recordJobsSourceScope(nodeId, owner.id);
  const telemetry = getJobsTelemetry();
  telemetry.search = { ts: 1, raw: 9, runId: 'synthetic-source-run' };
  return telemetry;
});
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const jobs = (count, title = 'Synthetic role') => Array.from({ length: count }, (_, index) => ({
  title: `${title} ${index}`, company: 'Example Company', source: 'example', location: 'Toronto',
  salary: '', matchScore: 0, careerDirection: 'Engineering',
}));
const taxonomy = rows => ({ roleByIndex: rows.map(() => 'Engineering'), likelihoodBands: [], salaryRanges: [] });
const invoke = (channel, owner, args) => electronPkg.ipcMain.__getInvokeHandler(channel)({ sender: owner }, args);

export default [
  {
    name: 'Board telemetry handlers keep concurrent Boards and source Search records independent in one window',
    async run() {
      __resetJobsTelemetryForTests();
      const owner = sender(8101);
      const sourceTelemetry = source(owner, 'source-a');
      const plans = new Map([['A 0', { started: deferred(), finish: deferred() }], ['B 0', { started: deferred(), finish: deferred() }]]);
      __registerJobsHandlersForTests({ runBoardTaxonomy: async (rows, { onProgress }) => {
        const plan = plans.get(rows[0].title);
        onProgress({ stage: 'planning', total: rows.length, processed: 0, completedBatches: 0, batchCount: 0 });
        plan.started.resolve();
        await plan.finish.promise;
        onProgress({ stage: 'planned', total: rows.length, processed: rows.length, completedBatches: 0,
          batchCount: 0, plannedAssignments: rows.length, vocabularySize: 1 });
        return taxonomy(rows);
      } });
      const first = invoke('bucket-jobs', owner, { nodeId: 'board-a', jobs: jobs(1, 'A') });
      await plans.get('A 0').started.promise;
      const second = invoke('bucket-jobs', owner, { nodeId: 'board-b', jobs: jobs(2, 'B') });
      await plans.get('B 0').started.promise;
      assert.deepEqual(report(owner, ['board-a', 'board-b']).map(row => [row.boardNodeId, row.bucketing.input, row.bucketing.taxonomyStage]),
        [['board-a', 1, 'planning'], ['board-b', 2, 'planning']]);
      plans.get('B 0').finish.resolve();
      assert.equal((await second).success, true);
      plans.get('A 0').finish.resolve();
      assert.equal((await first).success, true);
      assert.deepEqual(report(owner, ['board-a', 'board-b']).map(row => [row.bucketing.input, row.bucketing.placed, row.bucketing.taxonomyStage]),
        [[1, 1, 'complete'], [2, 2, 'complete']]);
      assert.equal(sourceTelemetry.search.raw, 9);
      assert.equal(sourceTelemetry.bucketing, null);
      assert.equal(sourceTelemetry.compensation, null);
      assert.equal(sourceTelemetry.history, null);
      assert.equal(inRequest(owner, null, 'bug-report', () => getJobsTelemetryForReport(['source-a'], owner.id)), sourceTelemetry);
    },
  },
  {
    name: 'A restarted Board keeps its latest bucket attempt when an older taxonomy request finishes late',
    async run() {
      __resetJobsTelemetryForTests();
      const owner = sender(8102);
      const started = deferred();
      const finish = deferred();
      __registerJobsHandlersForTests({ runBoardTaxonomy: async rows => {
        if (rows.length === 1) { started.resolve(); await finish.promise; }
        return taxonomy(rows);
      } });
      const old = invoke('bucket-jobs', owner, { nodeId: 'board-a', jobs: jobs(1) });
      await started.promise;
      assert.equal((await invoke('bucket-jobs', owner, { nodeId: 'board-a', jobs: jobs(2) })).success, true);
      finish.resolve();
      assert.equal((await old).success, true);
      assert.equal(report(owner, ['board-a'])[0].bucketing.input, 2);
      assert.equal(report(owner, ['board-a'])[0].bucketing.placed, 2);
    },
  },
  {
    name: 'Board compensation pins its current attempt before career reads and cannot overwrite a restarted Board',
    async run() {
      __resetJobsTelemetryForTests();
      const owner = sender(8103);
      const started = deferred();
      const finish = deferred();
      __registerJobsHandlersForTests({ runBoardTaxonomy: async rows => taxonomy(rows),
        resolveCompensationCareerInputs: async () => { started.resolve(); await finish.promise; return new Map(); } });
      assert.equal((await invoke('bucket-jobs', owner, { nodeId: 'board-a', jobs: jobs(1) })).success, true);
      const old = invoke('research-job-compensation', owner, { nodeId: 'board-a', jobs: jobs(1), salaryCareerSnapshotId: null });
      await started.promise;
      assert.equal(report(owner, ['board-a'])[0].compensation.scoredInput, 1);
      assert.equal((await invoke('bucket-jobs', owner, { nodeId: 'board-a', jobs: jobs(2) })).success, true);
      finish.resolve();
      assert.equal((await old).success, true);
      assert.equal(report(owner, ['board-a'])[0].bucketing.input, 2);
      assert.equal(report(owner, ['board-a'])[0].compensation, null);
    },
  },
  {
    name: 'Board compensation and history handlers remain reportable without a fresh source Search',
    async run() {
      __resetJobsTelemetryForTests();
      const owner = sender(8104);
      __registerJobsHandlersForTests();
      assert.equal((await invoke('research-job-compensation', owner, { nodeId: 'board-a', jobs: jobs(1), salaryCareerSnapshotId: null })).success, true);
      const history = await invoke('append-jobs-history', owner, { nodeId: 'board-a', jobs: jobs(1), historyStage: 'boardDisplay' });
      assert.equal(history.success, false, 'a missing display capability still refuses the history mutation');
      const [record] = report(owner, ['board-a']);
      assert.equal(record.compensation.scoredInput, 1);
      assert.equal(record.compensation.eligible, 0);
      assert.equal(record.compensation.skippedBelowFit, 1);
      assert.equal(record.history.boardDisplay.input, 1);
      assert.equal(record.history.boardDisplay.error, true);
      assert.equal(record.bucketing, null);
      assert.equal(inRequest(owner, null, 'bug-report', () => getJobsTelemetryForReport(['source-a'], owner.id)), null);
    },
  },
  {
    name: 'Board report selection rejects foreign windows source IDs siblings and unselected compensation cards',
    run() {
      __resetJobsTelemetryForTests();
      const owner = sender(8105);
      const foreign = sender(8106);
      source(owner, 'source-a');
      inRequest(owner, 'board-a', 'bucket-jobs', () => { getJobsTelemetry().bucketing = { input: 2 }; });
      inRequest(owner, 'card-a', 'research-job-compensation', () => { getJobsTelemetry().compensation = { scoredInput: 1 }; });
      inRequest(foreign, 'board-a', 'bucket-jobs', () => { getJobsTelemetry().bucketing = { input: 7 }; });
      assert.equal(report(owner, ['board-a'])[0].bucketing.input, 2);
      assert.equal(report(foreign, ['board-a'])[0].bucketing.input, 7);
      assert.deepEqual(report(owner, ['board-a'], foreign.id), []);
      assert.deepEqual(report(sender(owner.id), ['board-a']), [], 'same numeric window id cannot borrow another sender object');
      assert.deepEqual(report(owner, ['source-a', 'board-b']), []);
      assert.deepEqual(getJobsBoardTelemetryForReport(['board-a'], owner.id), [], 'contextless callers cannot borrow ambient Board telemetry');
      assert.equal(report(owner, ['board-a']).some(row => row.boardNodeId === 'card-a'), false);
      inRequest(owner, 'card-a', 'research-job-compensation', () => { getJobsTelemetry().boardNodeId = 'board-b'; });
      assert.deepEqual(report(owner, ['board-b']), [], 'mutable stage data cannot change the private Board ownership key');
    },
  },
  {
    name: 'Board records keep captured canvas ownership across navigation with cloned Board IDs',
    async run() {
      __resetJobsTelemetryForTests();
      const owner = sender(8110);
      owner.__canvasPath = '/synthetic/first/canvas.json';
      const ready = deferred();
      const finish = deferred();
      const old = inRequest(owner, 'board-a', 'bucket-jobs', async () => {
        getJobsTelemetry().bucketing = { input: 1 };
        ready.resolve();
        await finish.promise;
        getJobsTelemetry().bucketing = { input: 2 };
      });
      await ready.promise;
      owner.__canvasPath = '/synthetic/second/canvas.json';
      inRequest(owner, 'board-a', 'research-job-compensation', () => { getJobsTelemetry().compensation = { scoredInput: 3 }; });
      finish.resolve();
      await old;
      const [first] = report(owner, ['board-a'], owner.id, '/synthetic/first/./canvas.json');
      const [second] = report(owner, ['board-a'], owner.id, '/synthetic/second/canvas.json');
      assert.equal(first.bucketing.input, 2);
      assert.equal(first.compensation, null);
      assert.equal(second.bucketing, null);
      assert.equal(second.compensation.scoredInput, 3);
      assert.deepEqual(report(owner, ['board-a'], owner.id, '/synthetic/third/canvas.json'), []);
      assert.deepEqual(report(owner, ['board-a'], owner.id, null), [], 'unsaved reports cannot borrow saved-canvas attempts');
      for (const invalid of ['', 'relative/canvas.json', {}, 42]) assert.deepEqual(report(owner, ['board-a'], owner.id, invalid), []);
      owner.__canvasPath = null;
      inRequest(owner, 'board-a', 'bucket-jobs', () => { getJobsTelemetry().bucketing = { input: 4 }; });
      assert.equal(report(owner, ['board-a'], owner.id, null)[0].bucketing.input, 4);
      assert.equal(report(owner, ['board-a'], owner.id, '/synthetic/second/canvas.json')[0].compensation.scoredInput, 3);
      assert.equal(JSON.stringify(first).includes('/synthetic'), false);
    },
  },
  {
    name: 'Board registry is bounded and reset leaves in-flight predecessor records orphaned',
    async run() {
      __resetJobsTelemetryForTests();
      const owner = sender(8107);
      const ids = Array.from({ length: 40 }, (_, index) => `board-${index}`);
      for (const nodeId of ids) inRequest(owner, nodeId, 'bucket-jobs', () => { getJobsTelemetry().bucketing = { input: 1 }; });
      const retained = report(owner, ids);
      assert.equal(retained.length, 32);
      assert.deepEqual(report(owner, ids.slice(0, 8)), []);
      const finish = deferred();
      const ready = deferred();
      const old = inRequest(owner, 'board-pending', 'bucket-jobs', async () => {
        getJobsTelemetry().bucketing = { input: 3 };
        ready.resolve();
        await finish.promise;
        getJobsTelemetry().bucketing = { input: 4 };
      });
      await ready.promise;
      __resetJobsTelemetryForTests();
      finish.resolve();
      await old;
      assert.deepEqual(report(owner, [...ids, 'board-pending']), []);
    },
  },
  {
    name: 'Board report projection exports fresh numeric and enum fields without private model or listing data',
    run() {
      __resetJobsTelemetryForTests();
      const owner = sender(8108);
      const secret = 'PRIVATE_LISTING_COHORT_PATH_ERROR';
      inRequest(owner, 'board-a', 'bucket-jobs', () => {
        const telemetry = getJobsTelemetry();
        assert.equal(telemetry.nodeId, null);
        telemetry.bucketing = { ts: 1, input: 3, placed: 3, roleCount: 1, taxonomyStage: 'complete',
          errorCode: secret, error: secret, model: secret, roleSummary: [{ name: secret }], taxonomyAudit: [{ title: secret }],
          missing: -1, duplicated: '2', taxonomyChunkCount: Infinity };
        telemetry.compensation = { ts: 2, scoredInput: 3, eligible: 2, assessed: 2, researched: 1,
          failedCohorts: 0, failures: [{ cohort: secret, reason: secret }], roleBandFailureDetails: [secret],
          locationLookup: { jobs: 2, resolved: 2, error: secret, rejectionReasons: { [secret]: 9 } } };
        telemetry.history = { boardDisplay: { ts: 3, input: 3, staged: 3, written: 0, pruned: 0,
          skipped: secret, error: secret, skips: { url: 1, collisionSamples: [secret], bySource: { [secret]: 1 } } } };
      });
      const [record] = report(owner, ['board-a']);
      assert.equal(JSON.stringify(record).includes(secret), false);
      assert.equal(record.bucketing.errorCode, 'OTHER');
      assert.equal(record.bucketing.error, true);
      assert.equal(record.bucketing.missing, undefined);
      assert.equal(record.bucketing.duplicated, undefined);
      assert.equal(record.bucketing.taxonomyChunkCount, undefined);
      assert.equal(record.compensation.locationLookup.error, true);
      assert.equal(record.history.boardDisplay.skipped, null);
      assert.deepEqual(record.history.boardDisplay.skips, { url: 1 });
      record.bucketing.input = 99;
      record.history.boardDisplay.skips.url = 99;
      assert.equal(report(owner, ['board-a'])[0].bucketing.input, 3);
      assert.equal(report(owner, ['board-a'])[0].history.boardDisplay.skips.url, 1);
    },
  },
  {
    name: 'Legacy Board requests without a node keep their sender-local source behavior',
    run() {
      __resetJobsTelemetryForTests();
      const owner = sender(8109);
      const telemetry = source(owner, 'source-a');
      assert.equal(inRequest(owner, null, 'bucket-jobs', () => getJobsTelemetry()), telemetry);
      assert.deepEqual(report(owner, ['source-a']), []);
    },
  },
];
