import assert from 'node:assert/strict';
import { boundedOfficialPostingTrail, OFFICIAL_POSTING_TRAIL, officialPostingComparativeTrail } from '../../electron/ipc/officialPostingFields.js';
import { shouldPersistOfficialPostingResult } from '../../electron/ipc/officialPostingResolver.js';
import { mergeOfficialPostingTelemetry } from '../../electron/ipc/officialPostingService.js';
import { OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL } from '../../electron/ipc/officialPostingNegativePolicy.js';
// These legacy fixtures pin the earlier deterministic/comparative contract.

const posting = (extra = {}) => ({ level: 'L4', outcome: 'link-only', employer: 'Northwind Labs', title: 'Dispatch Engineer',
  sourceUrl: 'https://northwind.test/jobs/dispatch', officialApplyUrl: 'https://northwind.test/jobs/dispatch', trail: [], ...extra });
export default [
  {
    name: 'comparative trail compaction never turns a saturated partial crawl into a durable match',
    run() {
      const decorations = OFFICIAL_POSTING_TRAIL.filter(code => !code.startsWith('comparative-')
        && !['identifier-anchor', 'crawl-partial', 'fetch-timeout', 'crawl-budget'].includes(code));
      const flags = officialPostingComparativeTrail({ validA: true, validB: true, choiceA: 'P3', choiceB: 'P3' });
      const trail = boundedOfficialPostingTrail([...decorations, 'comparative-match', ...flags, 'crawl-partial']);
      assert.equal(trail.length, 32); assert.ok(trail.includes('crawl-partial'));
      for (const flag of flags) assert.ok(trail.includes(flag));
      assert.equal(shouldPersistOfficialPostingResult(posting({ level: 'L1', outcome: 'found', trail })), false);
      assert.deepEqual(boundedOfficialPostingTrail(['careers-page', 'comparative-match']), ['careers-page', 'comparative-match']);
    },
  },
  {
    name: 'comparative telemetry merges counts and closed option bins without retaining evidence or arbitrary labels',
    run() {
      const block = { comparisons: 2, comparisonOptions: { 1: 1, 8: 1, PRIVATE_OPTION: 9 },
        comparativeAgreements: 1, comparativeDisagreements: 1, comparativeInvalidRuns: 2,
        comparativeNone: 1, comparativeUnavailable: 1, comparativeMatches: 1,
        rejections: { 'comparative-invalid': 1, 'comparative-match': 1, 'semantic-uncertain': 1, 'semantic-overflow': 1, PRIVATE_REASON: 1 },
        evidence: 'PRIVATE_EVIDENCE', conversation: 'PRIVATE_CONVERSATION' };
      const merged = mergeOfficialPostingTelemetry(block, block);
      assert.equal(merged.comparisons, 4); assert.equal(merged.comparativeAgreements, 2);
      assert.equal(merged.comparativeDisagreements, 2); assert.equal(merged.comparativeInvalidRuns, 4);
      assert.equal(merged.comparativeNone, 2); assert.equal(merged.comparativeUnavailable, 2);
      assert.equal(merged.comparativeMatches, 2);
      assert.deepEqual(merged.comparisonOptions, { 1: 2, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 2 });
      assert.equal(merged.rejections['comparative-invalid'], 2);
      assert.equal(merged.rejections['semantic-uncertain'], 2);
      assert.equal(merged.rejections['semantic-overflow'], 2);
      assert.equal(merged.rejections['comparative-match'], undefined);
      assert.equal(JSON.stringify(merged).includes('PRIVATE_'), false);
    },
  },
];
