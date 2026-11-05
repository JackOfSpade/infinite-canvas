import assert from 'node:assert/strict';
import { __runWithIpcRequestContextForTests } from '../../electron/ipc/ipcUtils.js';
import { recheckPendingListings } from '../../electron/ipc/listingLivenessRecheck.js';
import { withListingClosed, withListingLiveness } from '../../electron/ipc/officialPostingBoardClosed.js';
import { readListingEvidence } from '../../electron/ipc/listingLivenessStore.js';
import { listScrapeAlarms, createScrapeAlarmStore } from '../../electron/ipc/scrapeAlarms.js';
import {
  LIVENESS_HEALTH_WINDOW, assessListingLivenessHealth, classifyListingVisit, holdNotFoundBursts, recordListingLivenessBatch,
  resetListingLivenessHealthForTests, tallyListingVisits,
} from '../../electron/ipc/listingLivenessHealth.js';

// Measured 2026-11-05 from the saved canvas job cards (305 with listingLiveness): linkedin 178, dice 57, ziprecruiter 70;
// closed: 4 dice structural within about 11 seconds, 1 ziprecruiter ai. Per-visit rates are not saved, so limits are provisional.
const MEASURED_DICE_ROWS = 57;
const MEASURED_DICE_CLOSED = 4;

const notFound = board => ({ board, ruleKey: board, httpStatus: 404, finalUrl: `https://www.${board}.com/job/1`, requestedUrl: `https://www.${board}.com/job/1`, title: '', chromeText: '' });
const thin = board => ({ board, ruleKey: board, httpStatus: 200, finalUrl: `https://www.${board}.com/job/1`, title: 'Jobs', chromeText: 'Loading' });
const page = board => ({ board, ruleKey: board, httpStatus: 200, finalUrl: `https://www.${board}.com/job/1`, title: 'Platform Engineer at Northwind',
  chromeText: 'Platform Engineer Northwind Labs Remote Apply now Save job Share job report this listing about the company and the role '.repeat(2) });
const alarmKeys = () => listScrapeAlarms().map(alarm => alarm.key).sort();
const fresh = () => { resetListingLivenessHealthForTests(); };

const row = (board, id) => ({ source: board, jobkey: `h-${board}-${id}`, url: `https://www.${board === 'dice' ? 'dice.com/job-detail' : 'linkedin.com/jobs/view'}/${id}`,
  title: 'Platform Engineer', company: 'Northwind Labs',
  listingLiveness: { verdict: 'pending', basis: 'neither', board, at: '2026-11-05T12:00:00.000Z' } });
const noSession = () => ({ classifyPrimary: async rows => rows });
const runRecheck = (board, evidenceFor, count, firstId = 1) => __runWithIpcRequestContextForTests({ livenessEvidence: new Map() }, () =>
  recheckPendingListings(Array.from({ length: count }, (_unused, index) => row(board, index + firstId)),
    { createProbe: () => ({ probe: async () => evidenceFor() }), createSession: noSession }));

export default [
  { name: 'visit classification: 404, thin, walls and healthy pages are told apart', run() {
    assert.equal(classifyListingVisit(notFound('dice')), 'closed-not-found');
    assert.equal(classifyListingVisit({ ...notFound('dice'), httpStatus: 410 }), 'closed-not-found');
    assert.equal(classifyListingVisit(thin('linkedin')), 'unreadable');
    assert.equal(classifyListingVisit({ unknown: 'empty-body' }), 'unreadable');
    assert.equal(classifyListingVisit({ unknown: 'browser-failure' }), 'unreadable');
    for (const reason of ['login-wall', 'rate-limit', 'challenge', 'http-wall', 'appcast', 'lock-timeout']) assert.equal(classifyListingVisit({ unknown: reason }), 'wall', reason);
    assert.equal(classifyListingVisit({ ...page('dice'), httpStatus: 403 }), 'wall', 'a blocking status on real evidence is a wall');
    assert.equal(classifyListingVisit({ unknown: 'other-host-not-found' }), null);
    assert.equal(classifyListingVisit(page('linkedin')), 'healthy');
    assert.equal(classifyListingVisit(null), null);
    assert.equal(classifyListingVisit('x'), null);
  } },
  { name: 'assess: fires on a batch where most visits return 404', run() {
    const counts = tallyListingVisits([...Array(14).fill('closed-not-found'), ...Array(6).fill('healthy')]);
    const reports = assessListingLivenessHealth('dice', counts);
    const burst = reports.find(report => report.key === 'liveness:dice:closed-burst');
    assert.deepEqual(burst.failure, { what: burst.failure.what, attempts: 20, bad: 14 });
    assert.equal(burst.surface, 'listing checks');
    assert.equal(burst.site, 'dice');
    assert.equal(reports.find(report => report.key === 'liveness:dice:unreadable').failure, null);
    assert.ok(!/https?:|dice\.com/u.test(burst.failure.what), 'fixed text: no URL or page text');
  } },
  { name: 'assess: fires when most pages are thin or empty', run() {
    const counts = tallyListingVisits([...Array(9).fill('unreadable'), ...Array(3).fill('healthy')]);
    const reports = assessListingLivenessHealth('linkedin', counts);
    assert.equal(reports.find(report => report.key === 'liveness:linkedin:unreadable').failure.bad, 9);
    assert.equal(reports.find(report => report.key === 'liveness:linkedin:closed-burst').failure, null);
  } },
  { name: 'assess: quiet on the measured real distribution and on the 4-of-57 Dice burst', run() {
    const measured = { dice: [MEASURED_DICE_CLOSED, MEASURED_DICE_ROWS - MEASURED_DICE_CLOSED], linkedin: [0, 178], ziprecruiter: [0, 70] };
    for (const [board, [closed, healthy]] of Object.entries(measured)) {
      for (const report of assessListingLivenessHealth(board, { closedNotFound: closed, unreadable: 0, healthy })) assert.equal(report.failure, null, `${board} ${report.key}`);
    }
    // A pass can visit at most 40 rows, so the burst is also judged inside a 20-read window.
    for (const report of assessListingLivenessHealth('dice', tallyListingVisits([...Array(4).fill('closed-not-found'), ...Array(16).fill('healthy')]))) assert.equal(report.failure, null);
    // Small samples and isolated bad rows never fire.
    assert.deepEqual(assessListingLivenessHealth('dice', tallyListingVisits(Array(9).fill('closed-not-found'))), []);
    for (const report of assessListingLivenessHealth('dice', tallyListingVisits([...Array(4).fill('closed-not-found'), ...Array(1).fill('healthy')]))) assert.equal(report.failure, null);
    const fourOfSix = assessListingLivenessHealth('dice', tallyListingVisits([...Array(4).fill('closed-not-found'), ...Array(6).fill('healthy')]));
    for (const report of fourOfSix) assert.equal(report.failure, null, 'bad below minBad');
    assert.equal(assessListingLivenessHealth('', tallyListingVisits(Array(20).fill('healthy'))).length, 0);
  } },
  { name: 'assess: walls neither fire nor count as healthy reads', run() {
    assert.deepEqual(assessListingLivenessHealth('linkedin', tallyListingVisits(Array(30).fill('wall'))), []);
    // 5 of 6 real reads are 404 but only 6 reads exist: walls do not pad the sample into a firing one.
    assert.deepEqual(assessListingLivenessHealth('linkedin', tallyListingVisits([...Array(5).fill('closed-not-found'), 'healthy', ...Array(40).fill('wall')])), []);
    // And they do not dilute a real burst into a clean run either.
    const counts = tallyListingVisits([...Array(12).fill('closed-not-found'), ...Array(2).fill('healthy'), ...Array(50).fill('wall')]);
    assert.equal(assessListingLivenessHealth('linkedin', counts).find(report => report.key.endsWith('closed-burst')).failure.bad, 12);
    assert.equal(counts.walls, 50);
  } },
  { name: 'recheck wiring: a 404 burst alarms, walls stay quiet, a healthy batch clears, and the verdict path is unchanged', async run() {
    fresh();
    const result = await runRecheck('dice', () => notFound('dice'), 14);
    assert.equal(result.visited, 14);
    assert.ok(alarmKeys().includes('liveness:dice:closed-burst'), 'the burst is on record');
    const alarm = listScrapeAlarms().find(item => item.key === 'liveness:dice:closed-burst');
    assert.equal(alarm.site, 'dice');
    assert.equal(alarm.surface, 'listing checks');
    assert.equal(alarm.bad, 14);
    await runRecheck('dice', () => page('dice'), 25);
    assert.ok(!alarmKeys().includes('liveness:dice:closed-burst'), 'a healthy batch clears it');

    fresh();
    await runRecheck('linkedin', () => ({ unknown: 'login-wall' }), 40);
    await runRecheck('linkedin', () => ({ unknown: 'rate-limit' }), 40);
    assert.ok(!alarmKeys().some(key => key.startsWith('liveness:linkedin')), 'walls do not alarm');
  } },
  { name: 'recheck wiring: empty bodies alarm across passes even though one pass stops after three unknown pages', async run() {
    fresh();
    for (let pass = 0; pass < 4; pass += 1) {
      const result = await runRecheck('linkedin', () => ({ unknown: 'empty-body' }), 40);
      assert.equal(result.visited, 3, 'the existing three-in-a-row stop is unchanged');
    }
    assert.ok(!alarmKeys().includes('liveness:linkedin:unreadable'), 'three dead links seen again and again are three dead links');
    await runRecheck('linkedin', () => ({ unknown: 'empty-body' }), 40, 100);
    assert.ok(alarmKeys().includes('liveness:linkedin:unreadable'), 'different listings across passes do fire');
    await runRecheck('linkedin', () => page('linkedin'), 30);
    assert.ok(!alarmKeys().includes('liveness:linkedin:unreadable'));
  } },
  { name: 'recheck wiring: thin pages alarm, and an alarm failure never reaches the scrape', async run() {
    fresh();
    await runRecheck('linkedin', () => thin('linkedin'), 12);
    assert.ok(alarmKeys().includes('liveness:linkedin:unreadable'));
    assert.doesNotThrow(() => recordListingLivenessBatch(null));
    assert.doesNotThrow(() => recordListingLivenessBatch([{ board: 5, outcome: 'wall' }, null, { board: 'x' }]));
    assert.equal(LIVENESS_HEALTH_WINDOW, 20);
    assert.equal(typeof createScrapeAlarmStore, 'function');
    fresh();
  } },
  { name: 'a 404 burst on one board keeps those listings pending, and normal closes stay closed', run() {
    const at = new Date('2026-11-05T12:00:00Z');
    const listing = (board, id) => ({ source: board, jobkey: `${board}-${id}`, url: `https://${board}.test/${id}`, title: 'Engineer', company: 'Northwind' });
    const notFound = (board, id) => withListingClosed(listing(board, id), { board, reason: 'http-not-found', basis: 'structural', now: at });
    const open = (board, id) => withListingLiveness(listing(board, id), { board, verdict: 'pending', basis: 'neither', now: at });
    const redirect = id => withListingClosed(listing('dice', id), { board: 'dice', reason: 'ziprecruiter-closed-job-redirect', basis: 'structural', now: at });
    const rows = [...Array.from({ length: 8 }, (_, i) => notFound('dice', i)), ...Array.from({ length: 4 }, (_, i) => open('dice', 100 + i)),
      redirect(200), notFound('linkedin', 1), ...Array.from({ length: 19 }, (_, i) => open('linkedin', 300 + i))];
    const sent = []; const forgotten = [];
    const result = holdNotFoundBursts(rows, { now: at, report: item => sent.push(item), forget: row => forgotten.push(row.jobkey) });
    assert.deepEqual(result.held, { dice: 8 }, 'only the 404 closes on the burst board');
    assert.equal(result.rows.length, rows.length, 'nothing is dropped');
    assert.ok(result.rows.slice(0, 8).every(row => row.listingLiveness.verdict === 'pending' && !row.boardClosed));
    assert.equal(result.rows[12].boardClosed.reason, 'ziprecruiter-closed-job-redirect', 'a close for another reason stands');
    assert.equal(result.rows[13].boardClosed.reason, 'http-not-found', 'one 404 on a healthy board stands');
    assert.equal(forgotten.length, 8, 'nothing judges a held row from its 404 page later');
    assert.deepEqual(sent.map(item => [item.key, item.failure.bad, item.failure.attempts]), [['liveness:dice:closed-burst', 8, 13]]);
    // Measured on the saved canvas: 4 Dice 404 closes among 57 checked Dice rows. That stays closed.
    const measured = [...Array.from({ length: MEASURED_DICE_CLOSED }, (_, i) => notFound('dice', i)), ...Array.from({ length: MEASURED_DICE_ROWS - MEASURED_DICE_CLOSED }, (_, i) => open('dice', 100 + i))];
    assert.deepEqual(holdNotFoundBursts(measured, { report: () => { throw new Error('no alarm'); } }).held, {});
    assert.deepEqual(holdNotFoundBursts(Array.from({ length: 6 }, (_, i) => notFound('dice', i)), { report: () => { throw new Error('no alarm'); } }).held, {}, 'too few to call it a burst');
    assert.deepEqual(holdNotFoundBursts(null).rows, []);
  } },
  { name: 'recheck: a pass where most pages 404 sends none of them to be judged closed', async run() {
    fresh();
    const judged = [];
    const session = () => ({ classifyPrimary: async rows => { judged.push(...rows); return rows; } });
    await __runWithIpcRequestContextForTests({ livenessEvidence: new Map() }, async () => {
      const rows = Array.from({ length: 12 }, (_unused, index) => row('dice', index + 1));
      let visit = 0;
      const result = await recheckPendingListings(rows, { createSession: session,
        createProbe: () => ({ probe: async () => (visit++ < 9 ? notFound('dice') : page('dice')) }) });
      assert.equal(result.visited, 12);
      assert.equal(judged.length, 3, 'only the three pages that read normally go on to be judged');
      assert.ok(rows.slice(0, 9).every(item => readListingEvidence(item) === null), 'the 404 pages are forgotten');
      assert.ok(result.rows.slice(0, 9).every(item => item.listingLiveness.verdict === 'pending'));
    });
    fresh(); judged.length = 0;
    await __runWithIpcRequestContextForTests({ livenessEvidence: new Map() }, async () => {
      let visit = 0;
      await recheckPendingListings(Array.from({ length: 12 }, (_unused, index) => row('dice', index + 1)), { createSession: session,
        createProbe: () => ({ probe: async () => (visit++ < 2 ? notFound('dice') : page('dice')) }) });
      assert.equal(judged.length, 12, 'two 404s in twelve are just closed jobs, judged as before');
    });
  } },
];
