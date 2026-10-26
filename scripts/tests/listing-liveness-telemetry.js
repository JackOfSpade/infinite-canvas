import assert from 'node:assert/strict';
import { listingLivenessTelemetryBlock, mergeListingLivenessTelemetry, LISTING_LIVENESS_COUNT_FIELDS } from '../../electron/ipc/listingLivenessTelemetry.js';
import { mergeOfficialPostingTelemetry } from '../../electron/ipc/officialPostingService.js';
import { sanitizeLastRunReceipt } from '../../electron/ipc/jobRunStaging.js';

const stamp = (board, verdict, basis) => ({ verdict, basis, board, at: '2026-10-26T00:00:00.000Z' });

export default [
  {
    name: 'listing liveness telemetry counts visited states and new dispositions by board without retaining row text',
    run() {
      const closed = { source: 'linkedin', title: 'Synthetic Platform Engineer', url: 'https://www.linkedin.com/jobs/view/123456',
        listingLiveness: stamp('linkedin', 'closed', 'structural') };
      const pending = { source: 'indeed', title: 'Synthetic Site Reliability Engineer', url: 'https://www.indeed.com/viewjob?jk=synthetic123',
        listingLiveness: stamp('indeed', 'pending', 'closed-marker') };
      const block = listingLivenessTelemetryBlock({ input: [closed, pending], settled: {
        dispositions: new Map([[closed, 'kept-ambiguous']]),
        dropped: [{ row: pending, disposition: 'deferred-unchecked' }],
      } });
      assert.deepEqual(Object.keys(block).sort(), ['indeed', 'linkedin']);
      assert.equal(block.linkedin.observed, 1);
      assert.equal(block.linkedin.structuralClosed, 1);
      assert.equal(block.linkedin.keptAmbiguous, 1);
      assert.equal(block.indeed.observed, 1);
      assert.equal(block.indeed.deferredUnchecked, 1);
      assert.deepEqual(Object.keys(block.linkedin), [...LISTING_LIVENESS_COUNT_FIELDS]);
      const serialized = JSON.stringify(block);
      assert.equal(serialized.includes(closed.title), false);
      assert.equal(serialized.includes(closed.url), false);
    },
  },
  {
    name: 'listing liveness telemetry merge and durable receipt accept bounded board counts only',
    run() {
      const first = { linkedin: { observed: 2, aiChecked: 1, aiOpen: 1, title: 'Synthetic Platform Engineer' } };
      const second = { linkedin: { observed: 3, aiChecked: 1, aiClosed: 1 }, 'bad.board': { observed: 999 } };
      const merged = mergeListingLivenessTelemetry(first, second);
      assert.equal(merged.linkedin.observed, 5);
      assert.equal(merged.linkedin.aiChecked, 2);
      assert.equal(merged.linkedin.aiClosed, 1);
      assert.equal(Object.hasOwn(merged, 'bad.board'), false);
      assert.equal(Object.hasOwn(merged.linkedin, 'title'), false);
      const official = mergeOfficialPostingTelemetry({ listingLiveness: first }, { listingLiveness: second });
      assert.deepEqual(official.listingLiveness, merged);
      const receipt = sanitizeLastRunReceipt({ runId: 'synthetic-run', completedAt: Date.now(), listingLiveness: {
        ...merged, linkedin: { ...merged.linkedin, requestedUrl: 'https://example.test/job' },
      } });
      assert.deepEqual(receipt.listingLiveness, merged);
      assert.equal(JSON.stringify(receipt).includes('https://example.test/job'), false);
    },
  },
];
