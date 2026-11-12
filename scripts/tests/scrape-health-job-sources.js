import assert from 'node:assert/strict';
import {
  fetchDiceListings,
  fetchLinkedInJobs,
  fetchRemoteOKJobs,
  fetchUSAJobs,
  fetchWeWorkRemotelyJobs,
  makeTrickleCounter,
} from '../../electron/extractors/apiExtractors.js';
import { extractIndeedJobsFromHtml } from '../../electron/extractors/apiExtractors.js';
import { assessSourceHealth } from '../../electron/ipc/jobSourceHealth.js';
import { __fetchHttpSourcesForTests, __queryFanOutForTests } from '../../electron/ipc/jobs.js';
import {
  INDEED_FULL_PAGE_MIN_CHARS,
  LINKEDIN_SHAPE_MIN_BODY_CHARS,
  diceDataArrayMissing,
  diceKeyHarvestReport,
  indeedPageUnreadable,
  linkedInGuestPageUnreadable,
  mostFirstPagesUnreadable,
  usaJobsEnvelopeMissing,
  wwrFeedShapeMissing,
} from '../../electron/ipc/jobSourcePageShape.js';
import { listScrapeAlarms } from '../../electron/ipc/scrapeAlarms.js';
import { refreshDiceApiKey } from '../../electron/ipc/stealthBrowser.js';

/*
 * Measured 2026-11-05 from the saved page-size calibration quoted in the 2026-11-04 bug report
 * (bug-reports/bug-report-2026-11-04T04-16-51-631Z.md, entries written 164 days earlier, so old): Indeed result
 * pages averaged 1,627KB, 1,670KB and 1,697KB. The existing soft-block rule covers pages under 150KB, and the
 * full-size check starts at that same line.
 */
const INDEED_MEASURED_PAGE_KB = [1627, 1670, 1697];

const RSS_ITEM = (n) => `<item><title><![CDATA[Acme ${n}: Senior Engineer]]></title><link>https://weworkremotely.com/remote-jobs/acme-${n}</link>`
  + `<description><![CDATA[<p>Build things.</p>]]></description><pubDate>Mon, 02 Nov 2026 12:00:00 +0000</pubDate><region><![CDATA[Anywhere in the World]]></region></item>`;
const RSS = (items = '') => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>We Work Remotely</title>${items}</channel></rss>`;
const NOT_RSS = '<html><head><title>Welcome</title></head><body><div id="app"></div><script src="/bundle.js"></script></body></html>';

const respond = (body, { status = 200, json = false } = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), {
  status,
  headers: { 'content-type': json || typeof body !== 'string' ? 'application/json' : 'text/html' },
});

async function withFetch(handler, work) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(String(url), init);
  try { return await work(); } finally { globalThis.fetch = original; }
}

const cards = (count, offset = 0) => Array.from({ length: count }, (_, i) => `<li><div class="base-card"><a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/${1000 + offset + i}?trackingId=x"></a>`
  + `<h3 class="base-search-card__title">Engineer ${offset + i}</h3><h4 class="base-search-card__subtitle"><a>Acme ${i}</a></h4>`
  + `<span class="job-search-card__location">Toronto, ON</span><time datetime="2026-11-02">2 days ago</time></div></li>`).join('\n');
// A LinkedIn page whose structure changed: well over the size of a real answer, but none of the card markup we read.
const LINKEDIN_RESTRUCTURED = `<ul>${Array.from({ length: 25 }, (_, i) => `<li><div class="job-tile"><span class="t">Engineer ${i}</span></div></li>`).join('')}</ul>`.replace(/<li>/gu, '<li data-x="').replace(/<div class="job-tile"><span class="t">/gu, '"><div class="job-tile"><span class="t">');

const noPause = { interPageDelayMs: 0 };
const dicePage = json => ({ requestPage: async () => ({ ok: true, status: 200, json, warning: null }), ...noPause });
const diceRows = n => Array.from({ length: n }, (_, i) => ({ id: `d${i}`, title: `Engineer ${i}`, companyName: 'Acme', jobLocation: { displayName: 'Remote' }, summary: 'Build things.', detailsPageUrl: `https://www.dice.com/job-detail/d${i}` }));

export default [
  {
    name: 'Page shape: each reader names a response without its structure and never an honest empty one',
    run() {
      assert.equal(wwrFeedShapeMissing(NOT_RSS), true);
      assert.equal(wwrFeedShapeMissing(''), true);
      assert.equal(wwrFeedShapeMissing(RSS()), false, 'an rss with no item is an empty feed');
      assert.equal(wwrFeedShapeMissing(RSS(RSS_ITEM(1))), false);
      assert.equal(usaJobsEnvelopeMissing({ message: 'moved' }), true);
      assert.equal(usaJobsEnvelopeMissing(null), true);
      assert.equal(usaJobsEnvelopeMissing({ SearchResult: { SearchResultCountAll: 0, SearchResultItems: [] } }), false);
      assert.equal(diceDataArrayMissing({ message: 'x' }), true);
      assert.equal(diceDataArrayMissing({ data: [], meta: {} }), false);
      const big = 'x'.repeat(LINKEDIN_SHAPE_MIN_BODY_CHARS + 10);
      assert.equal(linkedInGuestPageUnreadable({ start: 0, html: big, cardsOnPage: 0 }), true);
      assert.equal(linkedInGuestPageUnreadable({ start: 25, html: big, cardsOnPage: 0 }), false, 'the end of a walk');
      assert.equal(linkedInGuestPageUnreadable({ start: 0, html: '  \n ', cardsOnPage: 0 }), false, 'empty body');
      assert.equal(linkedInGuestPageUnreadable({ start: 0, html: '<li></li>', cardsOnPage: 0 }), false, 'short reply');
      assert.equal(linkedInGuestPageUnreadable({ start: 0, html: `${big}<div class="jobs-search-no-results">`, cardsOnPage: 0 }), false, 'known empty page');
      assert.equal(linkedInGuestPageUnreadable({ start: 0, html: big, cardsOnPage: 3 }), false);
    },
  },
  {
    name: 'Page shape: a run alarms only when most first pages are unreadable, so one odd page among several stays quiet',
    run() {
      assert.equal(mostFirstPagesUnreadable({ firstPages: 1, unreadable: 1 }), true);
      assert.equal(mostFirstPagesUnreadable({ firstPages: 6, unreadable: 4 }), true);
      assert.equal(mostFirstPagesUnreadable({ firstPages: 6, unreadable: 3 }), false);
      assert.equal(mostFirstPagesUnreadable({ firstPages: 6, unreadable: 1 }), false);
      assert.equal(mostFirstPagesUnreadable({ firstPages: 0, unreadable: 0 }), false);
    },
  },
  {
    name: 'We Work Remotely: a 200 that is not an RSS document alarms through the real fetch and the HTTP wrapper; an empty feed does not',
    async run() {
      const broken = await withFetch(() => respond(NOT_RSS), () => fetchWeWorkRemotelyJobs(['software engineer']));
      assert.equal(broken.warning, null, 'the page carries no wall of its own, so this is the only signal');
      assert.equal(broken.pageShapeFailures, 1);
      const empty = await withFetch(() => respond(RSS()), () => fetchWeWorkRemotelyJobs(['software engineer']));
      assert.equal(empty.pageShapeFailures, undefined, 'an rss with no items is honest');
      const healthy = await withFetch(() => respond(RSS(RSS_ITEM(1) + RSS_ITEM(2))), () => fetchWeWorkRemotelyJobs(['senior engineer']));
      assert.equal(healthy.pageShapeFailures, undefined);

      const viaWrapper = async body => (await withFetch(() => respond(body), () => __fetchHttpSourcesForTests(
        ['software engineer'], null, null, 'node-1', 21, '', new Set(['weworkremotely']), () => {},
      )))[0];
      const wrapped = await viaWrapper(NOT_RSS);
      assert.equal(wrapped.sourceId, 'weworkremotely');
      assert.equal(wrapped.pageShapeFailures, 1, 'the HTTP wrapper must not drop the field');
      assert.deepEqual(assessSourceHealth([], { pageShapeFailures: { weworkremotely: wrapped.pageShapeFailures } }).map(item => [item.source, item.field]), [['weworkremotely', 'page-shape']]);
      assert.equal((await viaWrapper(RSS())).pageShapeFailures, undefined);
    },
  },
  {
    name: 'RemoteOK: a non-array 200 already reaches the Search as a malformed-response warning, so it gets no second alarm',
    async run() {
      const result = await withFetch(() => respond({ error: 'moved' }), () => fetchRemoteOKJobs(['software engineer']));
      assert.equal(result.warning?.code, 'remoteok-malformed-response');
      assert.equal(result.warning?.severity, 'throttle');
      assert.equal(result.pageShapeFailures, undefined);
      const wrapped = (await withFetch(() => respond({ error: 'moved' }), () => __fetchHttpSourcesForTests(
        ['software engineer'], null, null, 'node-1', 21, '', new Set(['remoteok']), () => {},
      )))[0];
      assert.equal(wrapped.warning?.code, 'remoteok-malformed-response', 'the warning survives the wrapper to the Search');
    },
  },
  {
    name: 'USAJobs: a 200 without the SearchResult envelope alarms and sums across queries; an honest zero does not',
    async run() {
      const search = (body, queries = ['it specialist']) => withFetch(() => respond(body, { json: true }), () => __queryFanOutForTests(
        queries, (q, signal) => fetchUSAJobs(q, 'key', 'me@example.com', signal, 30, ''), null, {},
      ));
      const broken = await search({ message: 'The endpoint has moved' }, ['it specialist', 'analyst']);
      assert.equal(broken.pageShapeFailures, 2, 'one per query, kept through the fan-out');
      const honestZero = await search({ SearchResult: { SearchResultCount: 0, SearchResultCountAll: 0, SearchResultItems: [] } });
      assert.equal(honestZero.pageShapeFailures, undefined);
      assert.equal(honestZero.providerTotal, 0);
      const row = { MatchedObjectId: '1', MatchedObjectDescriptor: { PositionTitle: 'IT Specialist', PositionURI: 'https://www.usajobs.gov/job/1', OrganizationName: 'Agency', PositionLocation: [{ LocationName: 'Denver, CO' }], PositionRemuneration: [], PublicationStartDate: '2026-11-01', UserArea: { Details: { JobSummary: 'Work.' } } } };
      const healthy = await search({ SearchResult: { SearchResultCount: 1, SearchResultCountAll: 1, SearchResultItems: [row] } });
      assert.equal(healthy.pageShapeFailures, undefined);
      assert.equal(healthy.items.length, 1);
    },
  },
  {
    name: 'Dice: a 200 with no data array alarms through the real fetch and the fan-out; an empty data array does not',
    async run() {
      const broken = await fetchDiceListings('engineer', '', null, null, null, dicePage({ error: 'gone', status: 'moved' }));
      assert.equal(broken.pageShapeFailures, 1);
      assert.deepEqual(broken.items, [], 'nothing about the rows changes');
      const fanned = await __queryFanOutForTests(['a', 'b'], (q, signal) => fetchDiceListings(q, '', signal, null, null, dicePage({ error: 'gone' })), null, {});
      assert.equal(fanned.pageShapeFailures, 2);
      const empty = await fetchDiceListings('engineer', '', null, null, null, dicePage({ data: [], meta: { totalHits: 0 } }));
      assert.equal(empty.pageShapeFailures, undefined);
      const healthy = await fetchDiceListings('engineer', '', null, null, null, dicePage({ data: diceRows(3), meta: { totalHits: 3 } }));
      assert.equal(healthy.pageShapeFailures, undefined);
      assert.equal(healthy.items.length, 3);
    },
  },
  {
    name: 'LinkedIn: a page-one body of real size with no readable card alarms; an empty end-of-results body, a short reply and a normal page do not',
    async run() {
      const run = async body => withFetch(() => respond(body), () => fetchLinkedInJobs(['software engineer'], null, 7, 'Toronto', null));
      const broken = await run(LINKEDIN_RESTRUCTURED);
      assert.ok(LINKEDIN_RESTRUCTURED.length >= LINKEDIN_SHAPE_MIN_BODY_CHARS);
      assert.equal(broken.warning, null);
      assert.equal(broken.pageShapeFailures, 1);
      assert.equal((await run('')).pageShapeFailures, undefined, 'an empty body is the honest end of results');
      assert.equal((await run('<li></li>\n')).pageShapeFailures, undefined, 'a short reply is the known empty shape');
      const controller = new AbortController();
      const healthy = await withFetch(() => respond(cards(25)), () => fetchLinkedInJobs(['software engineer'], controller.signal, 7, 'Toronto', ({ detail }) => { if (/p1$/u.test(detail)) controller.abort(); }));
      assert.equal(healthy.items.length, 25);
      assert.equal(healthy.pageShapeFailures, undefined);
    },
  },
  {
    name: 'Indeed: a full-size first page with no job read alarms; a no-results page, a later page and a soft-block-sized page do not',
    run() {
      const page = (kb, body = '') => `<html><body>${body}${'<!-- padding -->'.repeat(Math.ceil(kb * 1024 / 16))}</body></html>`;
      const unreadable = html => indeedPageUnreadable({ pageIndex: 0, htmlLength: html.length, parsedCount: extractIndeedJobsFromHtml(html, null).length, html });
      for (const kb of INDEED_MEASURED_PAGE_KB) {
        assert.equal(unreadable(page(kb, '<div class="redesigned-results"><span>nothing we know</span></div>')), true, `${kb}KB`);
        assert.equal(unreadable(page(kb, '<div class="jobsearch-NoResult"><h1>The search did not match any jobs.</h1></div>')), false, `${kb}KB no-results page`);
        assert.equal(indeedPageUnreadable({ pageIndex: 1, htmlLength: kb * 1024, parsedCount: 0, html: '' }), false, 'a page past the last result is the honest end');
      }
      assert.equal(unreadable(page((INDEED_FULL_PAGE_MIN_CHARS / 1024) - 20)), false, 'under 150KB is the existing soft-block rule, not this one');
      const withJobs = page(1600, '<div class="job_seen_beacon"><h2 class="jobTitle"><a data-jk="abc123def4567890" href="/viewjob?jk=abc123def4567890"><span title="Engineer">Engineer</span></a></h2><span data-testid="company-name">Acme</span><div data-testid="text-location">Toronto</div></div>');
      assert.equal(extractIndeedJobsFromHtml(withJobs, null).length > 0, true, 'the fixture is a page the real parser reads');
      assert.equal(unreadable(withJobs), false);
    },
  },
  {
    name: 'Dice key harvest: a miss after scripts were read alarms through the real refresh, a found key clears it, and an unloaded page stays silent',
    async run() {
      const KEY = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
      const shell = scripts => `<html><body>${scripts.map(src => `<script src="${src}"></script>`).join('')}</body></html>`;
      const bundleUrl = 'https://www.dice.com/_next/static/chunks/main-abc.js';
      const serve = ({ page = () => respond(shell([bundleUrl])), bundle }) => url => (url.endsWith('.js') ? bundle() : page());
      const noBrowser = { browserFallback: async () => null };
      const alarm = () => listScrapeAlarms().find(item => item.key === 'job-source:dice:key-harvest');

      // Page loaded 200 with scripts, none holding the key, and the browser step found nothing too.
      assert.equal(await withFetch(serve({ bundle: () => respond('console.log("no key here")') }), () => refreshDiceApiKey(null, noBrowser)), null);
      assert.ok(alarm(), 'the alarm is on record');
      assert.equal(alarm().site, 'Dice');
      assert.equal(alarm().surface, 'job site reads');
      assert.equal(alarm().attempts, 1);

      // The page does not load: a network or block problem, so the alarm stays as it was and nothing new is sent.
      const before = alarm().at;
      await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(await withFetch(serve({ page: () => respond('blocked', { status: 403 }), bundle: () => respond('') }), () => refreshDiceApiKey(null, noBrowser)), null);
      assert.equal(alarm()?.at, before, 'an unloaded page neither raises nor clears');

      // The key is found in a bundle: the harvest works again and the alarm clears.
      const found = await withFetch(serve({ bundle: () => respond(`var cfg={"x-api-key":"${KEY}"};`) }), () => refreshDiceApiKey(null, noBrowser));
      assert.equal(found, KEY);
      assert.equal(alarm(), undefined);

      // A first-ever healthy harvest and a page that loaded with no scripts at all never alarm.
      assert.equal(await withFetch(serve({ page: () => respond(shell([])) }), () => refreshDiceApiKey(null, noBrowser)), null);
      assert.equal(alarm(), undefined, 'no script was read, so no regex miss was observed');

      // The browser step finding the key is a working harvest even when the bundles missed it.
      const viaBrowser = await withFetch(serve({ bundle: () => respond('nothing') }), () => refreshDiceApiKey(null, { browserFallback: async () => KEY }));
      assert.equal(viaBrowser, KEY);
      assert.equal(alarm(), undefined);

      assert.deepEqual(diceKeyHarvestReport({ keyFound: true, scriptsRead: 0 }), { failure: null });
      assert.equal(diceKeyHarvestReport({ keyFound: false, scriptsRead: 0 }), null);
      assert.deepEqual(diceKeyHarvestReport({ keyFound: false, scriptsRead: 4 }).failure.bad, 4);
    },
  },
  {
    name: 'A finished source keeps its unreadable-page count in the run manifest, so a resumed search still raises it',
    async run() {
      const { markSourceStatus, readRunState, startRun } = await import('../test-dependencies.js');
      const fsm = await import('node:fs'); const osm = await import('node:os'); const pathm = await import('node:path');
      const root = await fsm.promises.mkdtemp(pathm.join(osm.tmpdir(), 'ic-page-shape-manifest-'));
      const canvasPath = pathm.join(root, 'workspace.json');
      const runId = 'page-shape-run'; const nodeId = 'page-shape-hub';
      try {
        await startRun(canvasPath, { runId, startedAt: 1_700_000_000_000, nodeId, profileFingerprint: 'a'.repeat(64), sourceIds: ['weworkremotely', 'dice'] });
        await markSourceStatus(canvasPath, 'weworkremotely', 'done', 1_700_000_000_100, { expectedRunId: runId, nodeId, pageShapeFailures: 2 });
        await markSourceStatus(canvasPath, 'dice', 'done', 1_700_000_000_200, { expectedRunId: runId, nodeId, pageShapeFailures: 0 });
        const sources = (await readRunState(canvasPath, 1_700_000_000_300, nodeId))?.manifest?.sources || {};
        assert.equal(sources.weworkremotely.pageShapeFailures, 2);
        assert.equal(Object.hasOwn(sources.dice, 'pageShapeFailures'), false, 'a clean source saves nothing');
      } finally { await fsm.promises.rm(root, { recursive: true, force: true }); }
      const jobs = fsm.readFileSync(new URL('../../electron/ipc/jobs.js', import.meta.url), 'utf8');
      assert(jobs.includes("source?.status === 'done' && Number.isSafeInteger(source.pageShapeFailures)")
        && jobs.includes('result.pageShapeFailures = (result.pageShapeFailures || 0) + pages;'), 'resume restores the saved count for finished sources');
      assert(jobs.includes('pageShapeFailures: data?.pageShapeFailures || 0,') && jobs.includes('pageShapeFailures: rows.reduce('), 'both source status writes save the count');
    },
  },
  {
    name: 'A finished source keeps its window-dropped dated count in the run manifest, so a resumed google search does not look mostly undated',
    async run() {
      const { markSourceStatus, readRunState, startRun } = await import('../test-dependencies.js');
      const fsm = await import('node:fs'); const osm = await import('node:os'); const pathm = await import('node:path');
      const root = await fsm.promises.mkdtemp(pathm.join(osm.tmpdir(), 'ic-window-dropped-manifest-'));
      const canvasPath = pathm.join(root, 'workspace.json');
      const runId = 'window-dropped-run'; const nodeId = 'window-dropped-hub';
      let sources = {};
      try {
        await startRun(canvasPath, { runId, startedAt: 1_700_000_000_000, nodeId, profileFingerprint: 'b'.repeat(64), sourceIds: ['google', 'indeed', 'linkedin'] });
        await markSourceStatus(canvasPath, 'google', 'done', 1_700_000_000_100, { expectedRunId: runId, nodeId, windowDropped: 40 });
        await markSourceStatus(canvasPath, 'indeed', 'done', 1_700_000_000_150, { expectedRunId: runId, nodeId, windowDropped: 12 });
        await markSourceStatus(canvasPath, 'indeed', 'done', 1_700_000_000_200, { expectedRunId: runId, nodeId, windowDropped: 0 });
        await markSourceStatus(canvasPath, 'linkedin', 'done', 1_700_000_000_300, { expectedRunId: runId, nodeId, windowDropped: 500_000 });
        sources = (await readRunState(canvasPath, 1_700_000_000_400, nodeId))?.manifest?.sources || {};
        assert.equal(sources.google.windowDropped, 40);
        assert.equal(Object.hasOwn(sources.indeed, 'windowDropped'), false, 'a zero clears the count a live walk already saved');
        assert.equal(sources.linkedin.windowDropped, 100_000, 'the durable boundary caps the count');
      } finally { await fsm.promises.rm(root, { recursive: true, force: true }); }

      // The exact resume filter jobs.js applies to a 'done' source's manifest row.
      const restoredWindowDropped = Object.fromEntries(Object.entries(sources)
        .filter(([sid, source]) => ['google', 'indeed', 'linkedin'].includes(sid) && source?.status === 'done' && Number.isSafeInteger(source.windowDropped) && source.windowDropped > 0)
        .map(([sid, source]) => [sid, source.windowDropped]));
      assert.deepEqual(restoredWindowDropped, { google: 40, linkedin: 100_000 });

      // The reported run: 127 google rows, 104 of them undated.
      const googleRows = Array.from({ length: 127 }, (_, i) => ({
        source: 'google',
        url: `https://www.google.com/search?q=engineer&htidocid=${i}`,
        company: `Acme ${i}`,
        location: 'Toronto, ON',
        snippet: `Listing ${i}. ${'Build reliable systems across the whole stack. '.repeat(12)}`,
        ...(i < 23 ? { posted: '2026-11-02' } : {}),
        ...(i === 0 ? { salary: '$120,000 a year' } : {}),
      }));
      const lost = assessSourceHealth(googleRows, { datedOutsideWindowBySource: { google: 0 } })
        .map(({ source, field, rows, missing, limit }) => ({ source, field, rows, missing, limit }));
      assert.deepEqual(lost, [{ source: 'google', field: 'posted', rows: 127, missing: 104, limit: 0.8 }],
        'without the saved count the resumed survivors measure 82% undated, which is the false alarm');
      const restored = assessSourceHealth(googleRows, { datedOutsideWindowBySource: restoredWindowDropped });
      assert.deepEqual(restored, [], 'the restored window drops widen the posted denominator, so no alarm is raised');

      const jobs = fsm.readFileSync(new URL('../../electron/ipc/jobs.js', import.meta.url), 'utf8');
      assert(jobs.includes("source?.status === 'done' && Number.isSafeInteger(source.windowDropped) && source.windowDropped > 0")
        && jobs.includes('result.windowDropped = (result.windowDropped || 0) + dropped;'), 'resume restores the saved window drops for finished sources');
      assert(jobs.includes('windowDropped: data?.windowDropped || 0,'), 'the live source status write saves the window drops');
    },
  },
  {
    name: 'Pager trickle counter trips on the third quiet page, and a productive or tiny page restarts the streak',
    run() {
      // A page qualifies at >=5 rows carrying <=1 row new to its query. Two in a
      // row is ordinary cross-page overlap; three means the pager is re-serving
      // its offset and the walk is no longer making progress.
      const tripped = makeTrickleCounter();
      assert.equal(tripped.record(25, 1), null, 'recorded page 1: the walk is still advancing');
      assert.equal(tripped.record(30, 1), null, 'recorded page 2: two quiet pages is overlap, not a stall');
      const guard = tripped.record(25, 0);
      assert.equal(guard.kind, 'pager-trickle');
      assert.equal(guard.page, 3, 'page counts every page recorded, not just the quiet ones');
      assert.equal(guard.pages, 3, 'three consecutive quiet pages');
      assert.equal(guard.newRows, 2, 'the rows those three pages actually added, summed');
      assert.ok(guard.detail.length > 0 && guard.detail.length <= 240, 'a short counts-only sentence');
      assert.equal(/Engineer|https?:|Acme/u.test(guard.detail), false, 'no titles, companies or URLs');

      const productive = makeTrickleCounter();
      assert.equal(productive.record(25, 0), null);
      assert.equal(productive.record(25, 1), null);
      assert.equal(productive.record(25, 2), null, '2 new rows on one page is the pager still moving');
      assert.equal(productive.record(25, 0), null);
      assert.equal(productive.record(25, 1), null);
      const afterProductivePage = productive.record(25, 1);
      assert.equal(afterProductivePage.page, 6, 'the streak restarted at the page with 2 new rows');
      assert.equal(afterProductivePage.pages, 3);
      assert.equal(afterProductivePage.newRows, 2, 'only the rows inside the current streak');

      const tinyPages = makeTrickleCounter();
      assert.equal(tinyPages.record(25, 0), null);
      assert.equal(tinyPages.record(4, 0), null, 'a page under 5 rows proves nothing about the pager');
      assert.equal(tinyPages.record(25, 0), null);
      assert.equal(tinyPages.record(25, 1), null);
      const afterTinyPage = tinyPages.record(25, 1);
      assert.equal(afterTinyPage.page, 5);
      assert.equal(afterTinyPage.pages, 3);
      assert.equal(afterTinyPage.newRows, 2);

      // The thresholds are parameters, not constants: one quiet page is enough here.
      const impatient = makeTrickleCounter({ pages: 1, maxNew: 0, minRows: 10 });
      assert.equal(impatient.record(9, 0), null, '9 rows is under this counter\'s floor');
      assert.equal(impatient.record(10, 0).kind, 'pager-trickle');
    },
  },
  {
    name: 'Dice: an unlimited walk adding ~1 row per page stops with a pager-trickle guard; an explicit allowance stays quiet',
    async run() {
      const pool = diceRows(1004);
      const pageAt = start => ({ data: pool.slice(start, start + 1000), meta: { totalHits: 5000 } });
      const pages = [pageAt(0), pageAt(1), pageAt(2), pageAt(3)];
      let call = 0;
      const options = {
        interPageDelayMs: 0,
        requestPage: async () => ({ ok: true, status: 200, json: pages[Math.min(call++, pages.length - 1)], warning: null }),
      };
      const result = await fetchDiceListings('engineer', '', null, null, null, options);
      assert.equal(result.walkGuards.length, 1, 'one guard for the one walk');
      const guard = result.walkGuards[0];
      assert.equal(guard.kind, 'pager-trickle');
      assert.equal(guard.source, 'dice');
      assert.equal(guard.query, null, 'a fan-out query index is not this source\'s to name');
      assert.equal(guard.page, 4, 'page 1 added 1,000 rows, so the streak began at page 2');
      assert.equal(guard.pages, 3);
      assert.equal(guard.newRows, 3);
      assert.ok(guard.detail.length <= 240);
      assert.ok(result.stopReasons.some(item => item.stopReason === 'pager-trickle'), 'the old envelope still names the stop');
      assert.equal(result.truncated, true);

      const limited = await fetchDiceListings('engineer', '', null, null, { jobsPerPlatform: 2 }, dicePage({ data: diceRows(5), meta: { totalHits: 100 } }));
      assert.deepEqual(limited.walkGuards, [], 'an explicit allowance is the user\'s own boundary, not a guard');
      assert.equal(limited.stopReasons[0].stopReason, 'jobs-per-platform');
    },
  },
  {
    name: 'USAJobs: an unlimited walk served ~1 new row per page stops on a pager-trickle guard instead of ending quietly',
    async run() {
      const row = id => ({ MatchedObjectId: String(id), MatchedObjectDescriptor: { PositionTitle: `IT Specialist ${id}`, PositionURI: `https://www.usajobs.gov/job/${id}`, OrganizationName: 'Agency', PositionLocation: [{ LocationName: 'Denver, CO' }], PositionRemuneration: [], PublicationStartDate: '2026-11-01', UserArea: { Details: { JobSummary: 'Work.' } } } });
      const ids = from => Array.from({ length: 500 }, (_, i) => from + i);
      const pageOf = keys => ({ SearchResult: { SearchResultCountAll: 5000, SearchResultItems: keys.map(row) } });
      const pages = [
        pageOf(ids(0)),
        pageOf([...ids(1).slice(0, 499), 500]),
        pageOf([...ids(2).slice(0, 499), 501]),
        pageOf([...ids(3).slice(0, 499), 502]),
      ];
      const serve = url => {
        const page = Number(new URL(url).searchParams.get('Page')) || 1;
        return respond(pages[Math.min(page - 1, pages.length - 1)], { json: true });
      };
      const result = await withFetch(serve, () => fetchUSAJobs('it specialist', 'key', 'me@example.com', null, 30, ''));
      assert.equal(result.stopReason, 'pager-trickle');
      assert.equal(result.walkGuards.length, 1);
      const guard = result.walkGuards[0];
      assert.equal(guard.kind, 'pager-trickle');
      assert.equal(guard.source, 'usajobs');
      assert.equal(guard.query, null);
      assert.equal(guard.page, 4);
      assert.equal(guard.pages, 3);
      assert.equal(guard.newRows, 3);
      assert.equal(result.items.length, 2000, 'the retained rows are unchanged');
    },
  },
];
