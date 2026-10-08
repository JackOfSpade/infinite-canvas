import fs from 'node:fs';
import assert from 'node:assert';

import {
  combineSourceRunEntry,
  describeReceiptMismatch,
  jobSearchOutcomeReceiptMatches,
} from '../../src/utils/jobBoardSourceAdmission.js';
import { terminalJobSearchOutcome } from '../../src/utils/jobBoardPausedSourceContinuation.js';

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
