import { deleteChildrenByHubId } from '../../src/nodes/_shared/hubChildCleanup.js';
import { beginJobCardDisplayRemoval, isJobCardDisplayRemoval } from '../../src/utils/jobCardRemovalIntent.js';
import fs from 'node:fs';
import assert from 'node:assert';
import { runInNewContext } from 'node:vm';
import { buildJobTreeNodes } from '../../src/nodes/jobsearch/buildJobTree.js';
import { replaceBoardDisplayChildren } from '../../src/nodes/jobboard/replaceBoardDisplayChildren.js';
import { combineCommitMismatchReason } from '../../src/nodes/jobboard/boardRecoveryNotice.js';
import { attachProtectedCards, isProtectedJobCard } from '../../src/utils/jobLocationConsolidation.js';
import { getConnectedJobSearchIds, normalizeJobBoardRecoveryTimestamp } from '../../src/utils/jobBoardSearchSelection.js';
import { resolveSalaryCareerSnapshotId } from '../../src/utils/jobBoardCareerOverride.js';

import {
  boardHistoryAuthorityAvailable,
  combineSourceRunEntry,
  describeReceiptMismatch,
  jobSearchOutcomeReceiptMatches,
} from '../../src/utils/jobBoardSourceAdmission.js';
import { terminalJobSearchOutcome } from '../../src/utils/jobBoardPausedSourceContinuation.js';
import { filterDismissedBoardJobs, jobAndVariantKeys, recoverBoardDismissedKeys } from '../../src/utils/jobListingIdentity.js';
import { planJobCardDeletionCleanup } from '../../src/utils/jobCardDeletionCleanup.js';
import { discardDeletedJobAnalysisSnapshots } from '../../src/utils/canvasInteractions.js';

function readNodeSource() {
  return fs.readFileSync(
    new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url),
    'utf8',
  );
}

function scoredJob(title, matchScore) {
  return {
    title,
    company: 'Example',
    url: `https://jobs.example.test/${encodeURIComponent(title.replace(/\s+/g, '-').toLowerCase())}`,
    matchScore,
  };
}

function buildLiveModule(source, id) {
  const outcome = terminalJobSearchOutcome(source);
  return { id, ...outcome };
}

const modernSource = () => ({
  type: 'jobhub',
  data: {
    hubState: 'done',
    jobRunId: 'run-1',
    resultDisposition: 'scored',
    scoredJobs: [scoredJob('Modern One', 88), scoredJob('Modern Two', 82)],
  },
});

const legacyPositiveSource = () => ({
  type: 'jobhub',
  data: {
    hubState: 'done',
    resultDisposition: 'scored',
    scoredJobs: [scoredJob('Legacy Positive', 71)],
  },
});

const bareLegacySource = () => ({
  type: 'jobhub',
  data: {
    hubState: 'done',
    scoredJobs: [scoredJob('Bare Legacy', 66)],
  },
});

// Execute the real post-provider Combine transaction with a delayed history IPC
// and delayed React Flow deletion. The extraction keeps the regression on the
// component's actual await/commit ordering, without live providers or React UI.
async function startCombineCommitFixture({ unmatchedProtected = false } = {}) {
  const source = readNodeSource();
  const start = source.indexOf('      // Prepare, but do not consume, the durable seen-history capability');
  const end = source.indexOf('\n    } catch (err) {', start);
  assert(start >= 0 && end > start, 'the production Combine commit tail must be available');
  let releaseHistory;
  let enteredHistory;
  const historyStarted = new Promise(resolve => { enteredHistory = resolve; });
  const historyGate = new Promise(resolve => { releaseHistory = resolve; });
  let releaseDeletion;
  const deletionGate = new Promise(resolve => { releaseDeletion = resolve; });
  const calls = { clear: [], appended: [], history: [], completed: [], toasts: [] };
  const job = { ...scoredJob('Synthetic protected job', 80), source: 'example', reuseCardId: 'protected-card' };
  const secondJob = { ...scoredJob('Synthetic current job', 70), source: 'example' };
  const protectedCard = { id: 'protected-card', type: 'jobcard', position: { x: 200, y: 300 }, data: {
    hubId: 'board', ...job, localApplication: { status: 'running', authorityId: 'application-1' }, additionalNotes: 'initial notes',
  } };
  const oldCard = { id: 'old-card', type: 'jobcard', data: { hubId: 'board', ...secondJob } };
  const board = { id: 'board', type: 'jobboard', position: { x: 0, y: 0 }, data: { hubState: 'done', resultCount: 2 } };
  let nodes = [board, protectedCard, oldCard, { id: 'old-group', type: 'jobgroup', data: { hubId: 'board' } }];
  let edges = [{ id: 'old-edge', source: 'old-group', target: protectedCard.id }];
  const module = {
    id: 'search', runId: 'run-1', resultDisposition: 'scored', legacyPositiveResult: false,
    fingerprint: 'source-fingerprint', careerSnapshotId: 'snapshot-1', operationAuthority: { operationId: 'operation-1' },
  };
  const liveInputs = { all: [module], completed: [module] };
  const inputSignature = completed => completed.map(item => `${item.id}:${item.fingerprint}`).join('|');
  const pendingDeletionIds = new Set();
  const exactSourceRunsAtCombine = [combineSourceRunEntry(module)];
  const updateGlobal = (nodeId, update) => {
    nodes = nodes.map(node => {
      if (node.id !== nodeId) return node;
      const patch = typeof update === 'function' ? update(node) : update;
      return patch ? { ...node, data: { ...node.data, ...patch } } : node;
    });
  };
  const attached = attachProtectedCards(unmatchedProtected ? [secondJob] : [job, secondJob], [protectedCard]);
  const union = attached.jobs.concat(attached.unmatchedProtected);
  const env = {
    id: 'board', canvasFilePath: '/tmp/synthetic-board.json', union, completedAtCombine: [{ ...module }],
    protectedBoardCards: [protectedCard], sigAtCombine: inputSignature([module]), expectedSourceRuns: null,
    exactSourceRunsAtCombine, sourceRunsAtCombine: exactSourceRunsAtCombine, dismissedJobKeysAtCombine: [],
    manualAiRunId: 'board-manual-run', combineToken: Symbol('combine'), combineStartedAt: 1,
    bucketTree: { roles: [{ name: 'Synthetic role', jobIndices: [0, 1] }] }, mergeStats: {}, perModule: [], locationStats: {},
    getNode: nodeId => nodes.find(node => node.id === nodeId), getNodes: () => nodes, getEdges: () => edges,
    setNodes: update => { nodes = typeof update === 'function' ? update(nodes) : update; }, updateGlobal,
    cancelled: () => false, liveCombineInputs: () => liveInputs, boardInputSignature: inputSignature,
    getConnectedJobSearchIds, resolveSalaryCareerSnapshotId, salaryCareerAtCombine: { careerSnapshotId: null },
    isJobWorkflowDeletionPending: nodeId => pendingDeletionIds.has(nodeId),
    selectedRunsMatchExpected: () => true,
    combineInputsMatchExpected: (modules, expected) => modules.length === expected.length
      && expected.every(entry => jobSearchOutcomeReceiptMatches(modules.find(item => item.id === entry.sourceId), entry)),
    combineCommitMismatchReason, describeReceiptMismatch, boardHistoryAuthorityAvailable, isProtectedJobCard,
    normalizeJobBoardRecoveryTimestamp, buildJobTreeNodes, replaceBoardDisplayChildren,
    keepCompletedSnapshotDuringActiveSearch: () => true, hideBoardChildren() {},
    autoResumedManualAiRunRef: { current: 'board-manual-run' }, committedCombineRef: { current: null },
    committedCombineManualAiRunIdsRef: { current: new Set() }, rememberBoundedRunId: (set, runId) => set.add(runId),
    setFinalizingCommittedCombine() {}, recordCombineStage() {}, fitView() {},
    completeManualAiRun: async (runId, options) => { calls.completed.push({ runId, options }); },
    addToast: toast => calls.toasts.push(toast), EventLogger: { log() {}, error() {} },
    document: { dispatchEvent() {} }, CustomEvent: class {}, requestAnimationFrame: callback => callback(),
    addElementsGlobally: (_id, addedNodes, addedEdges) => {
      calls.appended.push(addedNodes.map(node => node.id)); nodes = nodes.concat(addedNodes); edges = edges.concat(addedEdges);
    },
    clearBoardChildren: options => deleteChildrenByHubId({
      getNodes: () => nodes, getEdges: () => edges, hubId: 'board', childTypes: ['jobcard', 'jobgroup'], displayReplacement: true,
      ...options,
      deleteElements: async request => {
        calls.clear.push(request);
        // React Flow captures matching ids before its onBeforeDelete await,
        // then applies remove changes by id after that callback resolves.
        const removedNodeIds = new Set(request.nodes.map(node => node.id));
        const removedEdgeIds = new Set(request.edges.map(edge => edge.id));
        await deletionGate;
        nodes = nodes.filter(node => !removedNodeIds.has(node.id));
        edges = edges.filter(edge => !removedEdgeIds.has(edge.id));
        return { deletedNodes: [...removedNodeIds].map(id => ({ id })), deletedEdges: [] };
      },
    }),
    window: { electronAPI: {
      prepareBoardJobsHistory: async () => { enteredHistory(); return historyGate; },
      appendJobsHistory: async args => { calls.history.push(args); return { success: true }; },
    } },
  };
  const execution = runInNewContext(`(async () => { ${source.slice(start, end)} })()`, env);
  await historyStarted;
  return {
    env, execution, calls, liveInputs, pendingDeletionIds, updateGlobal, getNodes: () => nodes, getEdges: () => edges,
    releaseHistory: () => releaseHistory({ success: true, historyToken: 'synthetic-history-token' }),
    releaseDeletion,
  };
}

export default [
  {
    name: 'Board final display fence rechecks source identity, connections, locks, deletion and cancellation after history IPC',
    async run() {
      const cases = [
        ['changed score fingerprint', fixture => { fixture.liveInputs.completed[0].fingerprint = 'changed'; }, 'superseded'],
        ['changed source run', fixture => { fixture.liveInputs.completed[0].runId = 'run-2'; }, 'superseded'],
        ['changed Board salary career data', fixture => fixture.updateGlobal('board', {
          jobBoardCareerOverride: { version: 1, approved: { careerSnapshotId: 'a'.repeat(64),
            generation: 'job-board-career:board:1', fileNames: ['career.md'], approvedAt: 1, profileFingerprint: null }, pending: null, retirePending: [] },
        }), 'superseded'],
        ['disconnected source', fixture => { fixture.liveInputs.completed = []; fixture.liveInputs.all = []; }, 'superseded'],
        ['locked Board', fixture => fixture.updateGlobal('board', { locked: true }), 'not-ready'],
        ['deletion pending', fixture => fixture.pendingDeletionIds.add('search'), 'cancelled'],
        ['cancelled operation', fixture => { fixture.env.cancelled = () => true; }, 'cancelled'],
        ['newly queued application', fixture => fixture.updateGlobal('old-card', { localApplication: { status: 'queued' } }), 'superseded'],
        ['dismissed protected card', fixture => fixture.env.setNodes(nodes => nodes.filter(node => node.id !== 'protected-card')), 'superseded'],
      ];
      for (const [label, mutate, expected] of cases) {
        const fixture = await startCombineCommitFixture();
        assert.equal(fixture.calls.clear.length, 0, 'history preflight must finish before any visible mutation');
        mutate(fixture);
        fixture.releaseHistory();
        const outcome = await fixture.execution;
        assert.equal(outcome.status, expected, label);
        assert.equal(fixture.calls.clear.length, 0, `${label} must leave the previous cascade intact`);
        assert.equal(fixture.calls.appended.length, 0, `${label} cannot append obsolete cards`);
        assert.equal(fixture.calls.history.length, 0, `${label} cannot record undisplayed results as seen`);
        fixture.releaseDeletion();
      }
    },
  },
  {
    name: 'Board delayed display deletion retains matched and unmatched application ids with their latest state',
    async run() {
      for (const unmatchedProtected of [false, true]) {
        const fixture = await startCombineCommitFixture({ unmatchedProtected });
        const latestApplication = { status: 'saved', authorityId: 'application-1', folderPath: '/tmp/synthetic-bundle' };
        fixture.updateGlobal('protected-card', { localApplication: latestApplication, additionalNotes: 'new notes saved during preflight' });
        fixture.releaseHistory();
        assert.equal((await fixture.execution).status, 'completed');
        assert.equal(fixture.calls.clear.length, 1);
        const deletion = fixture.calls.clear[0];
        assert(!deletion.nodes.some(node => node.id === 'protected-card'), 'the retained card must never enter the deletion lifecycle');
        assert(deletion.nodes.some(node => node.id === 'old-card') && deletion.nodes.some(node => node.id === 'old-group'),
          'old cards and groups still use the normal deletion lifecycle');
        assert(deletion.edges.some(edge => edge.id === 'old-edge'), 'old hierarchy edges attached to retained cards must still retire');
        assert(!fixture.calls.appended.flat().includes('protected-card'), 'the retained id cannot be appended a second time');
        assert.strictEqual(fixture.getNodes().find(node => node.id === 'protected-card').data.localApplication, latestApplication,
          'a bundle saved during preflight must stay linked before old deletion settles');
        const queuedApplication = { ...latestApplication, status: 'saved', updatedAt: 2 };
        fixture.updateGlobal('protected-card', { localApplication: queuedApplication });
        fixture.releaseDeletion();
        await new Promise(resolve => setImmediate(resolve));
        const retained = fixture.getNodes().filter(node => node.id === 'protected-card');
        assert.equal(retained.length, 1, 'late React Flow removal must leave exactly one retained card');
        assert.strictEqual(retained[0].data.localApplication, queuedApplication, 'a bundle saved during preflight must stay linked');
        assert.equal(retained[0].data.additionalNotes, 'new notes saved during preflight');
        assert(!fixture.getNodes().some(node => node.id === 'old-card' || node.id === 'old-group'));
        assert(!fixture.getEdges().some(edge => edge.id === 'old-edge'));
        assert(fixture.getEdges().some(edge => edge.target === 'protected-card'), 'the new hierarchy must reference the retained card');
        assert.equal(fixture.calls.history.length, 1, 'only the successfully displayed replacement records seen history');
      }
    },
  },
  {
    name: 'history source deletion: only deleting a Job Search finalizes its provisional display receipts',
    async run() {
      const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
      const calls = [];
      Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: {
        finalizeDisplayedJobHistory: async args => { calls.push(args); return { success: true }; },
        discardJobAnalysisSnapshot: async () => ({ success: true, ok: true }),
      } } });
      try {
        discardDeletedJobAnalysisSnapshots([{ id: 'board', type: 'jobboard' }, { id: 'tree', type: 'jobgroup' }, { id: 'card', type: 'jobcard' }], '/tmp/synthetic-canvas.json');
        assert.equal(calls.length, 0, 'board/tree/card deletion cannot finalize history');
        discardDeletedJobAnalysisSnapshots([{ id: 'search', type: 'jobhub', data: {} }], '/tmp/synthetic-canvas.json');
        assert.deepEqual(calls, [{ canvasFilePath: '/tmp/synthetic-canvas.json', nodeId: 'search' }], 'source deletion finalizes exactly its own owner');
        await Promise.resolve();
      } finally {
        if (previous) Object.defineProperty(globalThis, 'window', previous);
        else delete globalThis.window;
      }
    },
  },
  {
    name: 'Board recombine display replacement never records its old cards as dismissed',
    run: async () => {
      const board = { id: 'board', type: 'jobboard', data: { dismissedJobKeys: ['u:https://example.test/previously-dismissed'] } };
      const card = { id: 'replace-card', type: 'jobcard', data: { hubId: 'board', ...scoredJob('Retained posting', 77) } };
      const ordinary = { id: 'user-card', type: 'jobcard', data: { hubId: 'board', ...scoredJob('User dismissed posting', 60) } };
      let replacementUpdates;
      await deleteChildrenByHubId({
        getNodes: () => [board, card], getEdges: () => [], hubId: 'board', childTypes: ['jobcard'], displayReplacement: true,
        deleteElements: async () => {
          await Promise.resolve();
          assert(isJobCardDisplayRemoval(card.id), 'intent must survive React Flow asynchronous callbacks');
          const deletedNodes = [card, ordinary].filter(node => !isJobCardDisplayRemoval(node.id));
          replacementUpdates = planJobCardDeletionCleanup(deletedNodes, [board], () => board).boardUpdates;
        },
      });
      assert(!isJobCardDisplayRemoval(card.id), 'successful deletion must release its exact intent');
      const keys = replacementUpdates[0].stats.dismissedJobKeys;
      assert(jobAndVariantKeys(card.data).every(key => !keys.includes(key)), 'replacing a scored card must not poison later combines');
      assert(keys.length === 0, 'view deletion must not create a persistent suppression list');
      assert(filterDismissedBoardJobs([card.data], keys).length === 1, 'a second Combine must retain the same listing');
      const realDismissal = planJobCardDeletionCleanup([card], [board], () => board).boardUpdates[0].stats.dismissedJobKeys;
      assert(realDismissal.length === 0, 'a later real user deletion also leaves the source listing available');
      const hook = fs.readFileSync(new URL('../../src/hooks/useCanvasOSDeletion.js', import.meta.url), 'utf8');
      assert(hook.includes('requestedDeletedNodes.filter(node => !isJobCardDisplayRemoval(node?.id))'), 'the actual deletion lifecycle must classify programmatic replacements before cancellation and dismissal bookkeeping');
      assert(readNodeSource().includes('displayReplacement: true,'), 'Board cleanup must explicitly identify a display replacement; ordinary hub deletion stays destructive');
    },
  },
  {
    name: 'Board display removal intents release on failed or refused deletion and preserve overlapping owners',
    run: async () => {
      const card = { id: 'overlap-card', type: 'jobcard', data: { hubId: 'board' } };
      const first = beginJobCardDisplayRemoval([card]); const second = beginJobCardDisplayRemoval([card]);
      first(); assert(isJobCardDisplayRemoval(card.id), 'one owner must not release another pending replacement');
      second(); assert(!isJobCardDisplayRemoval(card.id));
      await deleteChildrenByHubId({ getNodes: () => [card], getEdges: () => [], hubId: 'board', childTypes: ['jobcard'], deleteElements: async () => {
        assert(!isJobCardDisplayRemoval(card.id), 'ordinary hub cleanup must retain its original deletion and cancellation semantics');
      } });
      for (const deletion of [() => { throw new Error('refused'); }, async () => { throw new Error('rejected'); }, async () => ({ deletedNodes: [] })]) {
        try { await deleteChildrenByHubId({ getNodes: () => [card], getEdges: () => [], hubId: 'board', childTypes: ['jobcard'], displayReplacement: true, deleteElements: deletion }); } catch { /* expected refusal */ }
        assert(!isJobCardDisplayRemoval(card.id), 'failed or empty deletion must not suppress a later user dismissal');
      }
    },
  },
  {
    name: 'view deletion preserves all posting variants for a saved-results recombine',
    run: () => {
      const first = { title: 'First', company: 'Example', url: 'https://example.test/first' };
      const second = { title: 'Second', company: 'Example', url: 'https://example.test/second',
        postingVariants: [{ url: 'https://example.test/second' }, { url: 'https://example.test/second-sf' }] };
      const board = { id: 'board', type: 'jobboard', data: { dismissedJobKeys: [] } };
      const card = { id: 'card', type: 'jobcard', data: { hubId: 'board', ...second } };
      const { boardUpdates } = planJobCardDeletionCleanup([card], [board], () => board);
      const keys = boardUpdates[0].stats.dismissedJobKeys;
      assert(keys.length === 0, 'deleting the card does not suppress either represented posting');
      assert(JSON.stringify(filterDismissedBoardJobs([first, second], keys)) === JSON.stringify([first, second]),
        'a later Combine recreates the deleted card');
      const boardSource = readNodeSource();
      assert(!boardSource.includes('union = filterDismissedBoardJobs(') && boardSource.includes('const dismissedJobKeysAtCombine = [];'),
        'Combine also ignores legacy persisted dismissal lists and does not infer suppression from missing cards');
      assert(recoverBoardDismissedKeys([first, second], [{ data: first }], false).length === 0,
        'old missing cards cannot be inferred when source inputs changed');
      assert(recoverBoardDismissedKeys([first, second], [{ data: first }], true).length === 2,
        'exact old source inputs recover a pre-ledger dismissal');
    },
  },
  {
    name: 'legacy Board sources can display without a protected seen-history write',
    run: () => {
      const protectedSource = {
        runId: 'run-1',
        careerSnapshotId: 'snapshot-1',
        operationAuthority: { operationId: 'operation-1' },
      };
      assert(boardHistoryAuthorityAvailable([protectedSource]) === true,
        'complete modern source receipts must use host-validated history admission');
      assert(boardHistoryAuthorityAvailable([protectedSource, { ...protectedSource, operationAuthority: null }]) === false,
        'one legacy source must make the mixed Board skip protected seen-history recording');
      assert(boardHistoryAuthorityAvailable([protectedSource, { ...protectedSource, runId: null }]) === false,
        'run-less saved results must not claim exact history authority');
      assert(boardHistoryAuthorityAvailable([protectedSource, { ...protectedSource, operationAuthority: 'invalid' }]) === true,
        'a present but malformed receipt must reach host validation instead of taking the legacy fallback');
    },
  },
  {
    name: 'combine source run entry round-trips modern, displaced legacy, and bare legacy receipts',
    run: async () => {
      // (a) Modern source with run id + scored disposition.
      const modern = buildLiveModule(modernSource(), 'modern-source');
      const modernEntry = combineSourceRunEntry(modern);
      assert(modernEntry.legacyPositiveResult === false, 'modern entry must not be branded legacy');
      assert(modernEntry.runId === 'run-1', 'modern entry keeps run id');
      assert(modernEntry.resultDisposition === 'scored', 'modern entry keeps disposition');
      assert(jobSearchOutcomeReceiptMatches(modern, modernEntry) === true, 'modern live receipt matches recorded entry');
      assert(describeReceiptMismatch(modern, modernEntry) === null, 'modern mismatch description is null');

      // (b) Run-less 'scored' source normalizes to a legacy-positive receipt.
      const legacy = buildLiveModule(legacyPositiveSource(), 'legacy-source');
      const legacyEntry = combineSourceRunEntry(legacy);
      assert(legacyEntry.legacyPositiveResult === true, 'run-less scored source is branded legacy-positive');
      assert(legacyEntry.runId === null, 'legacy entry has null run id');
      assert(legacyEntry.resultDisposition === 'legacy-scored', 'legacy entry carries legacy-scored disposition');
      assert(jobSearchOutcomeReceiptMatches(legacy, legacyEntry) === true, 'legacy live receipt matches recorded entry');
      assert(describeReceiptMismatch(legacy, legacyEntry) === null, 'legacy mismatch description is null');

      // (c) Source with neither run id nor disposition and scored jobs.
      const bare = buildLiveModule(bareLegacySource(), 'bare-legacy-source');
      const bareEntry = combineSourceRunEntry(bare);
      assert(jobSearchOutcomeReceiptMatches(bare, bareEntry) === true, 'bare legacy live receipt matches recorded entry');
      assert(describeReceiptMismatch(bare, bareEntry) === null, 'bare legacy mismatch description is null');
    },
  },
  {
    name: 'an older persisted entry omitting legacyPositiveResult still matches, but an explicit false fails closed',
    run: async () => {
      const legacy = buildLiveModule(legacyPositiveSource(), 'legacy-source');
      const entry = combineSourceRunEntry(legacy);

      // Older builds did not record the brand flag; the saved entry omitted it.
      const olderEntry = {
        sourceId: entry.sourceId,
        runId: entry.runId,
        resultDisposition: entry.resultDisposition,
        fingerprint: entry.fingerprint,
      };
      assert(jobSearchOutcomeReceiptMatches(legacy, olderEntry) === true, 'omitted legacy flag still matches');
      assert(describeReceiptMismatch(legacy, olderEntry) === null, 'omitted legacy flag has no described mismatch');

      // An explicit false must not be silently upgraded to a legacy-positive receipt.
      const explicitFalse = { ...olderEntry, legacyPositiveResult: false };
      assert(jobSearchOutcomeReceiptMatches(legacy, explicitFalse) === false, 'explicit legacyPositiveResult:false must fail');
      assert(typeof describeReceiptMismatch(legacy, explicitFalse) === 'string', 'explicit false yields a described mismatch');
      assert(describeReceiptMismatch(legacy, explicitFalse) !== null, 'explicit false mismatch is non-null');
    },
  },
  {
    name: 'receipt mismatch reason codes name the failing shape without helper leakage',
    run: async () => {
      const modern = buildLiveModule(modernSource(), 'modern-source');
      const modernEntry = combineSourceRunEntry(modern);

      // changed scoredJobs -> fingerprint-changed
      const changedRows = buildLiveModule({
        ...modernSource(),
        data: { ...modernSource().data, scoredJobs: [scoredJob('Modern One', 50), scoredJob('Modern Two', 82)] },
      }, 'changed-rows');
      assert(describeReceiptMismatch(changedRows, modernEntry) === 'fingerprint-changed', 'changed rows -> fingerprint-changed');

      // modern run-1 vs run-2 -> run-id-changed
      const otherRun = buildLiveModule({
        ...modernSource(),
        data: { ...modernSource().data, jobRunId: 'run-2' },
      }, 'other-run');
      assert(describeReceiptMismatch(otherRun, modernEntry) === 'run-id-changed', 'different run ids -> run-id-changed');

      // modern entry vs a run-less live with the same rows -> run-id-presence-changed.
      // The run-less live must share the modern fingerprint so the presence mismatch is reached.
      const runlessSameRows = buildLiveModule({
        ...modernSource(),
        data: { ...modernSource().data, jobRunId: null, resultDisposition: null },
      }, 'run-less-same-rows');
      assert(describeReceiptMismatch(runlessSameRows, modernEntry) === 'run-id-presence-changed', 'run-less live vs modern entry -> run-id-presence-changed');

      // same runId different disposition -> disposition-changed
      const changedDisposition = buildLiveModule({
        ...modernSource(),
        data: { ...modernSource().data, resultDisposition: 'empty-complete' },
      }, 'changed-disposition');
      assert(describeReceiptMismatch(changedDisposition, modernEntry) === 'disposition-changed', 'same run id, different disposition -> disposition-changed');

      // null actual -> live-receipt-missing
      assert(describeReceiptMismatch(null, modernEntry) === 'live-receipt-missing', 'null actual -> live-receipt-missing');

      // null expected -> recorded-receipt-missing
      assert(describeReceiptMismatch(modern, null) === 'recorded-receipt-missing', 'null expected -> recorded-receipt-missing');

      // modern entry with null disposition against modern live -> non-null
      const partialEntry = { ...modernEntry, resultDisposition: null };
      const partialMismatch = describeReceiptMismatch(modern, partialEntry);
      assert(typeof partialMismatch === 'string' && partialMismatch !== null, 'partial modern entry yields a described mismatch');
    },
  },
  {
    name: 'JobBoardNode wires the shared receipt builder and mismatch reporter without an inline flag-less literal',
    run: async () => {
      const source = readNodeSource();

      assert(source.includes('completedAtCombine.map(combineSourceRunEntry)'), 'completedAtCombine must map through combineSourceRunEntry');
      assert(source.includes('combineInputs.map(combineSourceRunEntry)'), 'combineInputs must map through combineSourceRunEntry');
      assert(!source.includes(`resultDisposition: module.resultDisposition || null,
        fingerprint: module.fingerprint,`), 'inline entry literal without legacyPositiveResult must be absent');
      assert(source.includes('receipts=${receiptDetail}'), 'node must log receipts=${receiptDetail}');
      assert(source.includes('describeReceiptMismatch('), 'node must call describeReceiptMismatch');
    },
  },
];
