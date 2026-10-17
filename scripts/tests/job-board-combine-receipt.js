import { deleteChildrenByHubId } from '../../src/nodes/_shared/hubChildCleanup.js';
import { beginJobCardDisplayRemoval, isJobCardDisplayRemoval } from '../../src/utils/jobCardRemovalIntent.js';
import fs from 'node:fs';
import assert from 'node:assert';

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

export default [
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
