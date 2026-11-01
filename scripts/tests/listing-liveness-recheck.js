import assert from 'node:assert/strict';
import { __runWithIpcRequestContextForTests } from '../../electron/ipc/ipcUtils.js';
import { LISTING_RECHECK_MAX_ROWS, recheckPendingListings } from '../../electron/ipc/listingLivenessRecheck.js';
import { readListingEvidence } from '../../electron/ipc/listingLivenessStore.js';

const row = (id, extra = {}) => ({
  source: 'linkedin', jobkey: `recheck-${id}`, url: `https://www.linkedin.com/jobs/view/${id}`,
  title: 'Platform Engineer', company: 'Northwind Labs',
  listingLiveness: { verdict: 'pending', basis: 'neither', board: 'linkedin', at: '2026-10-26T12:00:00.000Z' }, ...extra,
});
const openSession = () => ({ classifyPrimary: async rows => rows.map(item => ({ ...item,
  listingLiveness: { ...item.listingLiveness, verdict: 'open', basis: 'ai' } })) });
const inContext = run => __runWithIpcRequestContextForTests({ livenessEvidence: new Map() }, run);

export default [
  { name: 'listing recheck visits pending rows, records fresh evidence and merges only the liveness pair', run: () => inContext(async () => {
    const pending = row(1); const settled = row(2, { listingLiveness: { verdict: 'open', basis: 'ai', board: 'linkedin', at: '2026-10-26T12:00:00.000Z' } });
    const offSite = row(3, { url: 'https://example.com/jobs/3' });
    const official = row(4, { officialPosting: { level: 'L2', outcome: 'found', employer: 'Northwind Labs', title: 'Platform Engineer',
      location: { display: 'Remote' }, salary: { text: '', provenance: 'unknown' },
      sourceUrl: 'https://careers.northwind.example.test/jobs/platform',
      officialApplyUrl: 'https://careers.northwind.example.test/jobs/platform', ats: 'ashby', tenant: 'northwind',
      fetchedAt: '2026-10-26T12:00:00.000Z', contentHash: 'a'.repeat(64), trail: ['careers-page'] } });
    const visited = [];
    const createProbe = () => ({ probe: async url => { visited.push(url); return { board: 'linkedin', chromeText: 'fresh' }; } });
    const result = await recheckPendingListings([pending, settled, offSite, official], { createProbe, createSession: openSession });
    assert.deepEqual(visited, [pending.url], 'settled, unprobeable and officially resolved rows are not visited');
    assert.ok(readListingEvidence(pending), 'the classifier reads fresh evidence from the request-local map');
    assert.equal(result.rows[0].listingLiveness.verdict, 'open');
    assert.equal(result.rows[0].title, pending.title);
    assert.equal(result.rows[1], settled);
    assert.deepEqual([result.visited, result.rechecked, result.stillPending], [1, 1, 1], 'the unprobeable row is still counted as pending');
    assert.equal(pending.listingLiveness.verdict, 'pending', 'the input row is not mutated');
  }) },
  { name: 'listing recheck stops at a wall and leaves every unresolved row pending', run: () => inContext(async () => {
    const rows = Array.from({ length: 6 }, (_unused, index) => row(index + 1));
    let visits = 0; let sessions = 0;
    const result = await recheckPendingListings(rows, {
      createProbe: () => ({ probe: async () => { visits += 1; return { unknown: 'login-wall' }; } }),
      createSession: () => { sessions += 1; return openSession(); } });
    assert.equal(visits, 3);
    assert.equal(sessions, 0, 'no handoff is issued without fresh evidence');
    assert.equal(result.stillPending, 6);
    assert.ok(result.rows.every((item, index) => item === rows[index]));
  }) },
  { name: 'listing recheck bounds one pass and counts what it did not reach', run: () => inContext(async () => {
    const rows = Array.from({ length: LISTING_RECHECK_MAX_ROWS + 5 }, (_unused, index) => row(index + 1));
    let visits = 0;
    const result = await recheckPendingListings(rows, {
      createProbe: () => ({ probe: async () => { visits += 1; return { board: 'linkedin' }; } }), createSession: openSession });
    assert.equal(visits, LISTING_RECHECK_MAX_ROWS);
    assert.equal(result.stillPending, 5);
  }) },
  { name: 'listing recheck honours cancellation between visits', run: () => inContext(async () => {
    const controller = new AbortController(); const reason = new Error('synthetic stop');
    await assert.rejects(recheckPendingListings([row(1), row(2)], { signal: controller.signal, createSession: openSession,
      createProbe: () => ({ probe: async () => { controller.abort(reason); return { board: 'linkedin' }; } }) }), error => error === reason);
  }) },
];
