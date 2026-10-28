import assert from 'node:assert/strict';
import { __runWithIpcRequestContextForTests } from '../../electron/ipc/ipcUtils.js';
import { __resetJobsTelemetryForTests, getJobsTelemetry, recordJobsBoardScope } from '../../electron/ipc/jobs.js';
import { buildJobsPipelineSnapshot } from '../../electron/ipc/bugReport/jobsSnapshot.js';
import { generateMarkdown } from '../../electron/ipc/bugReport.js';
import { applyBugReportCode } from '../../src/utils/bugReportCodes.js';

const sender = { id: 71719, getURL: () => 'file:///synthetic/index.html' };
const boardId = 'synthetic-current-board';
const cardId = 'synthetic-compensation-card';
const ids = new Set([boardId, cardId]);
const run = (nodeId, channel, work) => __runWithIpcRequestContextForTests({ sender, nodeId, channel }, work);
const report = work => run(null, 'bug-report', work);
function recordBoard(nodeId = boardId) {
  run(nodeId, 'bucket-jobs', () => {
    recordJobsBoardScope(nodeId, sender.id);
    getJobsTelemetry().bucketing = { ts: Date.now(), input: 73, placed: 73, missing: 0, duplicated: 0,
      roleCount: 8, taxonomyStage: 'complete', error: null, failureSamples: [{ title: 'private posting prose' }] };
  });
  run(nodeId, 'research-job-compensation', () => {
    getJobsTelemetry().compensation = { ts: Date.now(), scoredInput: 73, eligible: 15, assessed: 14,
      researched: 14, failedCohorts: 0, failures: [{ reason: 'private source URL' }] };
  });
  run(nodeId, 'append-jobs-history', () => {
    getJobsTelemetry().history = { boardDisplay: { ts: Date.now(), input: 118, staged: 118, written: 0 } };
  });
}
function pipeline(boardIds = new Set([boardId])) {
  return report(() => buildJobsPipelineSnapshot(ids, sender.id, null, [], false, new Set(), boardIds));
}

export default [
  {
    name: 'Board-only process pipeline retains taxonomy compensation and history independently of absent source searches',
    run() {
      __resetJobsTelemetryForTests();
      try {
        recordBoard();
        const output = pipeline();
        assert.match(output, /### Job Board work \(current process\)/);
        assert.match(output, /Taxonomy.*input 73 · placed 73 · missing 0 · duplicated 0/);
        assert.match(output, /Compensation.*input 73 · eligible 15 · assessed 14 · researched cohorts 14 · failed cohorts 0/);
        assert.match(output, /Seen-history.*recorded · input 118 · provisional rows 118 · committed rows 0/);
        assert(!output.includes('no taxonomy recorded this session'));
        assert(!output.includes('private posting prose') && !output.includes('private source URL'));
        assert(!output.includes(boardId), 'report correlations must not reveal reusable owner ids');
        assert.match(output, /not proof of a workspace disk save or an exact display-generation match/);
      } finally { __resetJobsTelemetryForTests(); }
    },
  },
  {
    name: 'Board pipeline never promotes card compensation telemetry or a foreign window into Board work',
    run() {
      __resetJobsTelemetryForTests();
      try {
        recordBoard(cardId);
        assert.equal(pipeline(), '');
        recordBoard();
        const foreign = __runWithIpcRequestContextForTests({ sender: { id: 81819, getURL: sender.getURL }, channel: 'bug-report' },
          () => buildJobsPipelineSnapshot(ids, 81819, null, [], false, new Set(), new Set([boardId])));
        assert.equal(foreign, '');
      } finally { __resetJobsTelemetryForTests(); }
    },
  },
  {
    name: 'Board pipeline qualifies duplicate nested owner IDs and bounded inventories without borrowing live counters',
    run() {
      __resetJobsTelemetryForTests();
      try {
        recordBoard();
        const board = () => ({ id: boardId, type: 'jobboard', data: { hubState: 'done', resultCount: 73 } });
        const base = { description: '', edges: [], drawings: [], frontEndState: {}, eventLogs: [] };
        const nested = report(() => generateMarkdown({ ...base, nodes: [board(),
          { id: 'nested', type: 'group', data: { canvasData: { nodes: [board()], edges: [] } } }],
        }).markdown);
        assert.match(nested, /Live counters omitted for 1 ambiguous Board owner ID/);
        assert(!nested.includes('Taxonomy: input 73') && !/Taxonomy.*input 73 · placed 73/.test(nested));
        const bounded = report(() => generateMarkdown({ ...base, nodes: [], filterCode: 'JOBS', filterStats: {
          currentNodeIds: [boardId], currentJobHubIds: [], hasJobNodes: true,
          jobBoardStates: [{ id: boardId, hubState: 'done', resultCount: 73 }], jobBoardStateCount: 2,
        } }).markdown);
        assert.match(bounded, /Board ownership inventory was bounded/);
        assert(!/Taxonomy.*input 73 · placed 73/.test(bounded));
      } finally { __resetJobsTelemetryForTests(); }
    },
  },
  {
    name: 'FULL and focused job reports keep Board stage evidence through their filtered typed-node boundary',
    run() {
      __resetJobsTelemetryForTests();
      try {
        recordBoard();
        const payload = { description: '', nodes: [{ id: boardId, type: 'jobboard', position: { x: 0, y: 0 },
          data: { hubState: 'done', resultCount: 73 } }], edges: [], drawings: [], frontEndState: {}, eventLogs: [],
          };
        for (const code of ['FULL', 'JOBS', 'JOBBOARD', 'TAXONOMY']) {
          const filter = applyBugReportCode([], payload, code);
          const filtered = { ...payload, filterCode: code, filterStats: {
            currentNodeIds: [boardId], currentJobHubIds: [], hasJobNodes: true,
            omittedSections: [...filter.sectionExclusions], eventsShown: 0, eventsTotal: 0,
            jobBoardStates: [{ id: boardId, hubState: 'done', resultCount: 73, connectedSourceHubIds: [] }],
          } };
          for (const section of filter.sectionExclusions) delete filtered[section];
          const output = report(() => generateMarkdown(filtered).markdown);
          assert(output.includes('### Job Board work (current process)'), code);
          assert.match(output, /Taxonomy.*input 73 · placed 73/);
          assert(!output.includes('private posting prose') && !output.includes('private source URL'));
        }
      } finally { __resetJobsTelemetryForTests(); }
    },
  },
];
