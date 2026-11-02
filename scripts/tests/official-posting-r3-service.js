import assert from 'node:assert/strict';
import { officialPostingAliases } from '../../electron/ipc/officialPostingStore.js';
import { boundedOfficialPostingTrail, normalizeOfficialPosting, OFFICIAL_POSTING_TRAIL, officialPostingComparativeTrail } from '../../electron/ipc/officialPostingFields.js';
import { shouldPersistOfficialPostingResult } from '../../electron/ipc/officialPostingResolver.js';
import { mergeOfficialPostingTelemetry, partitionOfficialPostingRows as partitionRows } from '../../electron/ipc/officialPostingService.js';
import { OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL } from '../../electron/ipc/officialPostingNegativePolicy.js';
// These legacy fixtures pin the earlier deterministic/comparative contract.
const partitionOfficialPostingRows = (jobs, options) => partitionRows(jobs, { semanticMatching: false, ...options });

const description = 'Requirements include building reliable dispatch services, reviewing route reports, and documenting operational changes with the engineering team.';
const job = (id, extra = {}) => ({ title: `Dispatch Engineer ${id}`, company: 'Northwind Labs', location: 'Lakeview, Ontario, Canada',
  snippet: description, url: `https://mirror.example/jobs/${id}`, sourceJobKey: `source-${id}`, ...extra });
const posting = (extra = {}) => ({ level: 'L4', outcome: 'link-only', employer: 'Northwind Labs', title: 'Dispatch Engineer',
  sourceUrl: 'https://northwind.test/jobs/dispatch', officialApplyUrl: 'https://northwind.test/jobs/dispatch', trail: [], ...extra });
const record = (row, value, savedAt = Date.now()) => ({ version: 1, aliases: officialPostingAliases(row), savedAt, officialPosting: normalizeOfficialPosting(value) });
function memoryStore(initial = []) {
  const records = new Map(initial); const saves = [];
  return { saves, records, find: async row => records.get(row.sourceJobKey) || null,
    save: async (row, payload) => { saves.push({ row, payload }); const value = record(row, payload.officialPosting); records.set(row.sourceJobKey, value); return value; } };
}

export default [
  {
    name: 'deferred expiry partition retries historical closed-trail misses with no candidate confirmation receipt',
    async run() {
      const target = job('synthetic-legacy-expiry', { officialPosting: { level: 'L5', outcome: 'not-found',
        employer: 'Northwind Labs', trail: ['bridge-research', 'closed'] } });
      const old = record(target, { level: 'L5', outcome: 'not-found', employer: target.company,
        trail: ['bridge-research', 'closed'] });
      const partition = await partitionOfficialPostingRows([target], { store: memoryStore([[target.sourceJobKey, old]]) });
      assert.deepEqual(partition.unresolvedIndices, [0]);
      assert.equal(partition.settledTelemetry.total, 0);
    },
  },
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
  {
    name: 'R3 service partitions only normalized identity-bound settled rows and overlays host metadata without changing scraped fields',
    async run() {
      const now = Date.parse('2026-02-01T12:00:00Z');
      const rows = Array.from({ length: 8 }, (_, index) => job(index, { officialPosting: posting() }));
      rows[0].officialPosting = posting({ employer: 'Forged Example', sourceUrl: 'https://forged.test/job' });
      delete rows[1].officialPosting;
      rows[7].officialPosting = { ...posting(), extra: 'invalid' };
      const valid = record(rows[0], posting({ level: 'L1', outcome: 'found' }), now);
      const wrong = record(job(200, { title: 'Finance Analyst' }), posting(), now);
      const clean = record(rows[3], posting({ level: 'L5', outcome: 'not-found', trail: ['bridge-research', OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL] }), now - 1_000);
      const transient = record(rows[4], posting({ level: 'L5', outcome: 'not-found', trail: ['bridge-aborted'] }), now - 1_000);
      const unproven = record(rows[5], posting({ level: 'L5', outcome: 'not-found' }), now - 1_000);
      const expired = record(rows[6], posting({ level: 'L5', outcome: 'not-found', trail: ['bridge-research'] }), now - 24 * 60 * 60 * 1_000);
      const store = memoryStore([[rows[0].sourceJobKey, valid], [rows[1].sourceJobKey, record(rows[1], posting(), now)],
        [rows[2].sourceJobKey, wrong], [rows[3].sourceJobKey, clean], [rows[4].sourceJobKey, transient], [rows[5].sourceJobKey, unproven], [rows[6].sourceJobKey, expired]]);
      const before = JSON.stringify(rows);
      const result = await partitionOfficialPostingRows(rows, { store, now });
      assert.equal(JSON.stringify(rows), before);
      assert.deepEqual(result.unresolvedIndices, [1, 2, 4, 5, 6, 7]);
      assert.deepEqual(result.jobs[0].officialPosting, valid.officialPosting, 'inline proof is replaced by host-owned proof');
      assert.equal(result.jobs[0].company, rows[0].company); assert.equal(result.jobs[0].snippet, rows[0].snippet);
      assert.equal(result.settledTelemetry.total, 2); assert.equal(result.settledTelemetry.levels.L1, 1); assert.equal(result.settledTelemetry.levels.L5, 1);
      assert.equal(store.saves.length, 0);
      const cancelled = await partitionOfficialPostingRows(rows, { store, now, signal: AbortSignal.abort() });
      assert.equal(cancelled.unresolvedIndices.length, rows.length); assert.equal(cancelled.settledTelemetry.total, 0);
    },
  },
];
