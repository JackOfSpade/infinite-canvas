import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import {
  EBAY_ACTIVE_EXTRACTOR, EBAY_SOLD_EXTRACTOR, MERCARI_SOLD_EXTRACTOR, POSHMARK_SOLD_EXTRACTOR, SWAPPA_EXTRACTOR, SWAPPA_SOLD_EXTRACTOR,
} from '../../electron/extractors/marketplace.js';
import { extractAlgoliaHits, fetchAptDecoComps, fetchPriceChartingComps, fetchReverbListings, parsePriceChartingHtml } from '../../electron/extractors/apiExtractors.js';
import { createScrapeAlarmStore } from '../../electron/ipc/scrapeAlarms.js';
import { prepareHubPages } from '../../electron/ipc/listingStatusCheck.js';
import { nativeReadToFetchResult } from '../../electron/ipc/browser/nativeChromeReader.js';
import {
  accumulateMarketplaceObservations, aptDecoShapeMissing, assessHubScan, assessMarketplaceScrape, priceChartingShapeMissing,
  reportMarketplaceScrapeHealth, reverbShapeMissing,
} from '../../electron/ipc/marketplaceScrapeHealth.js';

const fixture = name => fs.readFileSync(path.resolve('scripts/fixtures', name), 'utf8');
const nth = keep => { let seen = 0; return match => (seen++ < keep ? match : 'x-gone'); };

function yieldOf(html, extractor, url) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  try {
    const raw = dom.window.eval(extractor);
    return { items: raw.items.length, ...raw.yieldStats };
  } finally { dom.window.close(); }
}
const EBAY_URL = 'https://www.ebay.com/sch/i.html?_nkw=x&LH_Sold=1';
const MERCARI_URL = 'https://www.mercari.com/search/?keyword=x';
const POSHMARK_URL = 'https://poshmark.com/search?query=x';
const entry = (entries, key) => entries.find(item => item.key === key);
const fieldsOf = (id, stats, extra = {}) => assessMarketplaceScrape({ yieldBySource: { [id]: stats }, ...extra });

/** Runs a Swappa extractor in a page whose in-page fetch is `respond`, returning what the page hands back. */
async function swappaResult(extractor, respond, { withModelLink = true } = {}) {
  const link = withModelLink ? '<a href="/listings/apple-iphone-x" title="Apple iPhone X">Apple iPhone X</a>' : '';
  const dom = new JSDOM(`<html><body><div id="main_search_product_results">${link}</div></body></html>`,
    { url: 'https://swappa.com/search?q=apple+iphone+x', runScripts: 'outside-only' });
  dom.window.fetch = respond;
  try { return await dom.window.eval(extractor); } finally { dom.window.close(); }
}
const reply = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });
const SALES_ROW = '<tr><td>Jan 2026</td><td>Good</td><td>Unlocked</td><td>64GB</td><td><a href="/listing/view/ABC1" title="View Sold Listing">$250</a></td></tr>';
const PAD = `<!-- ${'x'.repeat(260)} -->`;
const SALES_PAGE = `<table>${SALES_ROW}${SALES_ROW.replace('ABC1', 'ABC2')}</table>${PAD}`;
const EMPTY_SALES_PAGE = `<table><thead><tr><th>Date</th><th>Price</th></tr></thead><tbody></tbody></table>${PAD}`;
const OFFER = '<div itemprop="offers" itemscope><meta itemprop="price" content="199"><span itemprop="description">Apple iPhone X 64GB</span><a href="/listing/view/Z1">x</a></div>';

async function withFetch(respond, work) {
  const real = globalThis.fetch;
  globalThis.fetch = respond;
  try { return await work(); } finally { globalThis.fetch = real; }
}
const httpReply = (body, { status = 200, url = '', json = false } = {}) => async () => {
  const response = new Response(json ? JSON.stringify(body) : body, { status, headers: { 'content-type': json ? 'application/json' : 'text/html' } });
  if (url) Object.defineProperty(response, 'url', { value: url });
  return response;
};

const ALGOLIA_PAGE = hits => `<html><body><script>self.__next_f.push(["{\\"x\\":1,\\"hits\\":${hits},\\"nbHits\\":1}"])</script></body></html>`.replace(/\\"/g, '"');
const HIT = '{"title":"Oak sofa","price":450,"page_url":"oak-sofa","is_available":true}';

function prepared(entries, platformId = 'poshmark') {
  return prepareHubPages({
    platformId,
    urlSpecs: entries.map((result, index) => ({ url: `https://example.com/hub/${index}`, urlLabel: 'hub', fetcher: async () => result })),
  });
}
const goodPage = { ok: true, status: 200, finalUrl: 'https://example.com/hub', html: `<html><body><main>${'Order shipped to buyer. '.repeat(40)}</main></body></html>` };
const emptyPage = { ok: true, status: 200, finalUrl: 'https://example.com/hub', html: '' };
const serverError = { ok: true, status: 500, finalUrl: 'https://example.com/hub', html: `<html><body>${'Internal error. '.repeat(30)}</body></html>` };

export default [
  {
    name: 'Marketplace: AptDeco answering its firewall challenge (HTTP 202, seen live) is a block on the source, not an honest zero',
    async run() {
      const original = globalThis.fetch;
      globalThis.fetch = async () => ({ ok: true, status: 202, url: 'https://www.aptdeco.com/catalog', text: async () => '<html>challenge</html>' });
      try {
        const result = await fetchAptDecoComps('mid century sofa');
        assert.deepEqual(result.items, []);
        assert.equal(result.warning?.severity, 'block');
        assert.deepEqual(assessMarketplaceScrape({ sourceWarnings: { 'aptdeco-active': result.warning }, shapeBySource: { 'aptdeco-active': result.shapeMissing ?? null } }), []);
      } finally { globalThis.fetch = original; }
    },
  },
  {
    // Measured 2026-11-05 by running the real extractors on the April fixtures in scripts/fixtures (no real saved rows exist).
    name: 'Marketplace fields: healthy fixtures read clean, with the measured yields',
    run() {
      const ebaySold = yieldOf(fixture('ebay-body.html'), EBAY_SOLD_EXTRACTOR, EBAY_URL);
      const ebayActive = yieldOf(fixture('ebay-body.html'), EBAY_ACTIVE_EXTRACTOR, EBAY_URL);
      const mercari = yieldOf(fixture('mercari-body.html'), MERCARI_SOLD_EXTRACTOR, MERCARI_URL);
      const poshmark = yieldOf(fixture('poshmark-body.html'), POSHMARK_SOLD_EXTRACTOR, POSHMARK_URL);
      assert.deepEqual([ebaySold.seen, ebaySold.noFields, ebayActive.seen, ebayActive.noFields], [14, 0, 14, 0]);
      assert.deepEqual([mercari.seen, mercari.noFields], [36, 0]);
      // Poshmark's card selector also matches nested non-tile elements, so even a healthy page reads mostly "no fields".
      assert.deepEqual([poshmark.seen, poshmark.noFields, poshmark.noTitle, poshmark.noPrice, poshmark.noLink], [144, 77, 48, 0, 29]);
      for (const [id, stats] of [['ebay-sold', ebaySold], ['ebay-active', ebayActive], ['mercari', mercari], ['poshmark', poshmark]]) {
        const found = entry(fieldsOf(id, stats), `marketplace:${id}:fields`);
        assert.equal(found.failure, null, `${id} healthy page must clear, not fire`);
        assert.equal(found.surface, 'price checks');
      }
      // The suggested 0.5 share would have fired on the healthy Poshmark page (77 / 144), which is why it is judged on prices only.
      assert.ok(77 / 144 > 0.5);
    },
  },
  {
    name: 'Marketplace fields: selector-stripped copies of the real pages fire',
    run() {
      const ebay = yieldOf(fixture('ebay-body.html').replace(/su-item-card__price/g, nth(4)), EBAY_SOLD_EXTRACTOR, EBAY_URL);
      let kept = 0;
      const mercari = yieldOf(fixture('mercari-body.html').replace(/<img([^>]*?) alt=/g, (match, rest) => (kept++ < 10 ? match : `<img${rest} data-alt=`)), MERCARI_SOLD_EXTRACTOR, MERCARI_URL);
      const poshmark = yieldOf(fixture('poshmark-body.html').replace(/tile-grid-redesign__price-current/g, nth(6)), POSHMARK_SOLD_EXTRACTOR, POSHMARK_URL);
      assert.deepEqual([ebay.seen, ebay.noFields], [14, 9]);
      assert.deepEqual([mercari.seen, mercari.noFields], [36, 28]);
      assert.deepEqual([poshmark.seen, poshmark.noPrice], [144, 42]);
      for (const [id, stats] of [['ebay-sold', ebay], ['mercari', mercari], ['poshmark', poshmark]]) {
        const found = entry(fieldsOf(id, stats), `marketplace:${id}:fields`);
        assert.ok(found.failure && found.failure.bad > 0 && found.failure.attempts === stats.seen, `${id} partial drift must fire`);
        assert.doesNotMatch(found.failure.what, /https?:|\d{3,}/, 'fixed text, no page text or url');
      }
    },
  },
  {
    name: 'Marketplace fields: isolated bad rows and small samples stay quiet',
    run() {
      assert.equal(entry(fieldsOf('mercari', { seen: 36, noFields: 3 }), 'marketplace:mercari:fields').failure, null);
      assert.equal(entry(fieldsOf('ebay-sold', { seen: 14, noFields: 4 }), 'marketplace:ebay-sold:fields').failure, null, 'four bad is under minBad');
      assert.equal(entry(fieldsOf('ebay-sold', { seen: 14, noFields: 8 }), 'marketplace:ebay-sold:fields').failure.bad, 8);
      assert.equal(entry(fieldsOf('ebay-sold', { seen: 14, noFields: 7 }), 'marketplace:ebay-sold:fields').failure, null, 'exactly half is not over the share');
      assert.equal(entry(fieldsOf('mercari', { seen: 6, noFields: 6 }), 'marketplace:mercari:fields'), undefined, 'a six-card sample says nothing, leaving any alarm in place');
    },
  },
  {
    name: 'Marketplace fields: a multi-item run is judged on everything it read',
    run() {
      const half = { yieldBySource: { mercari: { seen: 5, noFields: 4 } }, bySource: { mercari: 1 } };
      assert.equal(entry(assessMarketplaceScrape(half), 'marketplace:mercari:fields'), undefined, 'one item alone is too small');
      const acc = accumulateMarketplaceObservations(accumulateMarketplaceObservations(null, half), half);
      assert.deepEqual(acc.yieldBySource.mercari, { seen: 10, noFields: 8, noTitle: 0, noPrice: 0, noLink: 0 });
      assert.ok(entry(assessMarketplaceScrape(acc), 'marketplace:mercari:fields').failure);
    },
  },
  {
    name: 'Marketplace shape: Reverb 200 without a listings array fires on one query, an empty list is an honest zero',
    async run() {
      assert.equal(reverbShapeMissing({ listings: [] }), null);
      for (const json of [null, {}, { message: 'oops' }, { listings: 'x' }]) assert.equal(reverbShapeMissing(json), 'no-listings-array');
      const broken = await withFetch(httpReply({ _links: {} }, { json: true }), () => fetchReverbListings('fender strat'));
      assert.equal(broken.shapeMissing, 'no-listings-array');
      const honest = await withFetch(httpReply({ listings: [], total: 0 }, { json: true }), () => fetchReverbListings('fender strat'));
      assert.equal(honest.shapeMissing, null);
      const failed = await withFetch(httpReply({ error: 'x' }, { status: 500, json: true }), () => fetchReverbListings('fender strat'));
      assert.equal(failed.shapeMissing, undefined, 'a failed request is not judged');
      const fires = assessMarketplaceScrape({ shapeBySource: { reverb: broken.shapeMissing }, bySource: { reverb: 0 } });
      assert.deepEqual(entry(fires, 'marketplace:reverb:shape').failure, { what: 'Reverb answered 200 but its response had no listings array', attempts: 1, bad: 1 });
      assert.equal(entry(assessMarketplaceScrape({ shapeBySource: { reverb: honest.shapeMissing }, bySource: { reverb: 0 } }), 'marketplace:reverb:shape').failure, null);
    },
  },
  {
    name: 'Marketplace shape: PriceCharting no results table fires, a table or product page with no rows stays quiet',
    async run() {
      const row = '<tr><td class="title"><a href="/game/nes/mario">Super Mario Bros</a></td><td class="price"><span class="js-price">$12.00</span></td></tr>';
      const table = rows => `<html><body><table id="games_table"><tbody>${rows}</tbody></table></body></html>`;
      const blocked = '<html><body><h1>Just a moment</h1><p>Checking your browser</p></body></html>';
      assert.equal(priceChartingShapeMissing({ html: table(''), finalUrl: 'https://www.pricecharting.com/search-products', parsedCount: parsePriceChartingHtml(table('')).length }), null);
      assert.equal(priceChartingShapeMissing({ html: '<html><body><h1 id="product_name">Mario</h1></body></html>', finalUrl: 'https://www.pricecharting.com/game/nes/mario', parsedCount: 0 }), null);
      assert.equal(priceChartingShapeMissing({ html: blocked, finalUrl: 'https://www.pricecharting.com/search-products', parsedCount: 0 }), 'no-results-table');
      const broken = await withFetch(httpReply(blocked), () => fetchPriceChartingComps('super mario bros'));
      assert.equal(broken.shapeMissing, 'no-results-table');
      const healthy = await withFetch(httpReply(table(row)), () => fetchPriceChartingComps('super mario bros'));
      assert.equal(healthy.items.length, 1);
      assert.equal(healthy.shapeMissing, null);
      const honest = await withFetch(httpReply(table('')), () => fetchPriceChartingComps('super mario bros'));
      assert.deepEqual([honest.items.length, honest.shapeMissing], [0, null]);
      const skipped = await fetchPriceChartingComps('vacuum', null, { category: 'appliances' });
      assert.equal(skipped.shapeMissing, undefined, 'a skipped source is not judged');
      assert.ok(entry(assessMarketplaceScrape({ shapeBySource: { pricecharting: 'no-results-table' } }), 'marketplace:pricecharting:shape').failure);
    },
  },
  {
    name: 'Marketplace shape: AptDeco page with no hits array fires, an empty or full hits array stays quiet',
    async run() {
      const full = ALGOLIA_PAGE(`[${HIT}]`);
      const empty = ALGOLIA_PAGE('[]');
      const restructured = '<html><body><div id="__next">Catalog</div></body></html>';
      const truncated = '<html><script>{"hits":[{"title":"Oak sofa","pri</script></html>';
      assert.equal(extractAlgoliaHits(full).length, 1);
      assert.equal(aptDecoShapeMissing(full, 1), null);
      assert.equal(aptDecoShapeMissing(empty, 0), null);
      assert.equal(aptDecoShapeMissing(restructured, 0), 'no-hits-array');
      assert.equal(aptDecoShapeMissing(truncated, 0), 'no-hits-array');
      const broken = await withFetch(httpReply(restructured), () => fetchAptDecoComps('oak sofa'));
      assert.equal(broken.shapeMissing, 'no-hits-array');
      assert.equal((await withFetch(httpReply(full), () => fetchAptDecoComps('oak sofa'))).shapeMissing, null);
      const honest = await withFetch(httpReply(empty), () => fetchAptDecoComps('oak sofa'));
      assert.deepEqual([honest.items.length, honest.shapeMissing], [0, null]);
      assert.equal((await fetchAptDecoComps('phone', null, { category: 'electronics' })).shapeMissing, undefined);
      assert.ok(entry(assessMarketplaceScrape({ shapeBySource: { 'aptdeco-active': 'no-hits-array' } }), 'marketplace:aptdeco-active:shape').failure);
    },
  },
  {
    name: 'Marketplace shape: Swappa in-page fetch failure fires, a real page with no sales or no model match is an honest zero',
    async run() {
      for (const extractor of [SWAPPA_SOLD_EXTRACTOR, SWAPPA_EXTRACTOR]) {
        const status500 = await swappaResult(extractor, reply(500, 'err'));
        const thrown = await swappaResult(extractor, async () => { throw new Error('network down'); });
        for (const [result, flag] of [[status500, 'fetch-failed'], [thrown, 'fetch-failed']]) {
          assert.equal(result.items.length, 0);
          assert.equal(result.yieldStats.shapeFlag, flag);
          assert.equal(result.yieldStats.seen, 0, 'zero cards seen keeps readiness and anti-bot handling as before');
        }
        const noMatch = await swappaResult(extractor, reply(200, SALES_PAGE), { withModelLink: false });
        assert.ok(Array.isArray(noMatch) && noMatch.length === 0, 'no model to look up is an honest zero');
      }
      const honestEmpty = await swappaResult(SWAPPA_SOLD_EXTRACTOR, reply(200, EMPTY_SALES_PAGE));
      assert.ok(Array.isArray(honestEmpty) && honestEmpty.length === 0);
      const healthySold = await swappaResult(SWAPPA_SOLD_EXTRACTOR, reply(200, SALES_PAGE));
      const healthyActive = await swappaResult(SWAPPA_EXTRACTOR, reply(200, `<html><body>${OFFER}${PAD}</body></html>`));
      assert.equal(healthySold.length, 2);
      assert.equal(healthyActive.length, 1);
      const broken = await swappaResult(SWAPPA_SOLD_EXTRACTOR, reply(503, 'busy'));
      const fires = assessMarketplaceScrape(accumulateMarketplaceObservations(null, { yieldBySource: { 'swappa-sold': broken.yieldStats }, bySource: { 'swappa-sold': 0 } }));
      assert.equal(entry(fires, 'marketplace:swappa-sold:shape').failure.bad, 1);
      const quiet = assessMarketplaceScrape({ bySource: { 'swappa-sold': 0 } });
      assert.equal(entry(quiet, 'marketplace:swappa-sold:shape'), undefined, 'an honest zero says nothing');
      const clears = assessMarketplaceScrape({ bySource: { 'swappa-sold': healthySold.length } });
      assert.equal(entry(clears, 'marketplace:swappa-sold:shape').failure, null);
    },
  },
  {
    name: 'Marketplace warnings: known blocks keep their own message with no alarm, stale selectors also raise one',
    run() {
      const flagged = { yieldBySource: { mercari: { seen: 36, noFields: 30 } }, shapeBySource: { reverb: 'no-listings-array' }, bySource: {} };
      for (const code of ['login-required', 'preflight-blocked', 'cloudflare-challenge', 'rate-limited', 'task-failed', 'scrape-timeout']) {
        const severity = code === 'rate-limited' ? 'throttle' : 'block';
        const out = assessMarketplaceScrape({ ...flagged, sourceWarnings: { mercari: { code, severity }, reverb: { code, severity } } });
        assert.deepEqual(out, [], `${code} must not raise or clear anything`);
      }
      const zero = { code: 'stale-selectors', severity: 'warn', evidence: 'SITE_CHANGED: poshmark ... cards=0', sourceId: 'poshmark' };
      const streaks = new Map();
      const item = (warnings, stats = {}) => accumulateMarketplaceObservations(null, { scrapeWarnings: warnings, ...stats }, streaks);
      assert.deepEqual(assessMarketplaceScrape({ sourceWarnings: { poshmark: zero }, ...item([zero]) }), [], 'one rare item with no listings says nothing');
      assert.deepEqual(assessMarketplaceScrape({ sourceWarnings: { poshmark: zero }, ...item([zero]) }), []);
      const stale = assessMarketplaceScrape({ sourceWarnings: { poshmark: zero }, ...item([zero]) });
      assert.equal(stale.length, 1, 'three items in a row with no cards');
      assert.equal(stale[0].key, 'marketplace:poshmark:shape');
      assert.ok(stale[0].failure && stale[0].failure.attempts === 3 && !/SITE_CHANGED|cards=/.test(stale[0].failure.what), 'the evidence text is not copied into the alarm');
      const cleared = assessMarketplaceScrape(item([], { bySource: { poshmark: 12 } }));
      assert.equal(entry(cleared, 'marketplace:poshmark:shape').failure, null, 'cards again clear it');
      for (let run = 0; run < 5; run += 1) item([{ ...zero, platformLoggedOut: true }]);
      assert.equal(streaks.size, 0, 'a logged-out platform is told to log in, not reported as broken');
      // The anti-bot detector's thin-count guess is not a known block: an explicit flag still fires, no flag stays quiet.
      const guess = { code: 'zero-extracted', severity: 'throttle' };
      assert.ok(entry(assessMarketplaceScrape({ sourceWarnings: { swappa: guess }, shapeBySource: { swappa: 'fetch-failed' } }), 'marketplace:swappa:shape').failure);
      assert.deepEqual(assessMarketplaceScrape({ sourceWarnings: { swappa: guess }, bySource: { swappa: 0 } }), []);
    },
  },
  {
    name: 'Marketplace shape: a flag from any item of a multi-item run sticks, and a later clean item does not clear it',
    run() {
      const bad = { shapeBySource: { reverb: 'no-listings-array' }, bySource: { reverb: 0 } };
      const good = { shapeBySource: { reverb: null }, bySource: { reverb: 4 } };
      const acc = accumulateMarketplaceObservations(accumulateMarketplaceObservations(null, bad), good);
      assert.ok(entry(assessMarketplaceScrape(acc), 'marketplace:reverb:shape').failure);
      const reversed = accumulateMarketplaceObservations(accumulateMarketplaceObservations(null, good), bad);
      assert.ok(entry(assessMarketplaceScrape(reversed), 'marketplace:reverb:shape').failure);
    },
  },
  {
    name: 'Marketplace alarms: assessment drives the real store, raising then clearing, and reporting never throws',
    async run() {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-marketplace-health-'));
      try {
        const store = createScrapeAlarmStore(path.join(directory, 'alarms.json'));
        const feed = observations => { for (const item of assessMarketplaceScrape(observations)) if (item.failure !== undefined) store.report(item); };
        feed({ shapeBySource: { 'aptdeco-active': 'no-hits-array' } });
        assert.deepEqual(store.list().map(alarm => [alarm.key, alarm.surface, alarm.site]), [['marketplace:aptdeco-active:shape', 'price checks', 'AptDeco']]);
        feed({ bySource: { reverb: 0 } });
        assert.equal(store.list().length, 1, 'an unrelated quiet source leaves the alarm alone');
        feed({ shapeBySource: { 'aptdeco-active': null } });
        assert.equal(store.list().length, 0, 'the structure came back, so the alarm clears');
        await store.flush();
      } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
      assert.doesNotThrow(() => reportMarketplaceScrapeHealth(null));
      assert.doesNotThrow(() => reportMarketplaceScrapeHealth([null, { key: 'marketplace:none:shape', failure: undefined }]));
    },
  },
  {
    name: 'Hub scan: most pages empty or erroring with no known cause fires, through the real prepareHubPages',
    async run() {
      const empties = await prepared(Array.from({ length: 6 }, () => emptyPage));
      const fired = assessHubScan(empties);
      assert.equal(fired.key, 'hub-scan:poshmark');
      assert.equal(fired.surface, 'listing status scans');
      assert.deepEqual([fired.failure.attempts, fired.failure.bad], [6, 6]);
      const errors = assessHubScan(await prepared([...Array.from({ length: 4 }, () => serverError), goodPage, goodPage]));
      assert.deepEqual([errors.failure.attempts, errors.failure.bad], [6, 4]);
      const native = assessHubScan(await prepared(Array.from({ length: 5 }, () => nativeReadToFetchResult({ requestedUrl: 'https://www.ebay.com/hub', html: '' })), 'ebay'));
      assert.deepEqual([native.key, native.failure.bad], ['hub-scan:ebay', 5]);
    },
  },
  {
    name: 'Hub scan: healthy reads, a few bad pages, small scans and known blocks stay quiet',
    async run() {
      assert.equal(assessHubScan(await prepared(Array.from({ length: 6 }, () => goodPage))).failure, null);
      assert.equal(assessHubScan(await prepared([emptyPage, emptyPage, ...Array.from({ length: 4 }, () => goodPage)])).failure, null, 'two bad pages under minBad');
      assert.equal(assessHubScan(await prepared([emptyPage, emptyPage, emptyPage, emptyPage])).failure, undefined, 'four reads is too few to judge');
      const loggedOut = nativeReadToFetchResult({ requestedUrl: 'https://www.ebay.com/hub', finalUrl: 'https://www.ebay.com/hub', html: `<form action="/signin"><input type="password"></form>${'x'.repeat(400)}` });
      const challenged = nativeReadToFetchResult({ requestedUrl: 'https://www.ebay.com/hub', finalUrl: 'https://www.ebay.com/splashui/challenge', html: 'x' });
      assert.ok(!loggedOut.readFailure && !challenged.readFailure, 'a known cause is not tagged as an unexplained read failure');
      const blocked = assessHubScan(await prepared([challenged, challenged, challenged, challenged, challenged, challenged], 'ebay'));
      assert.equal(blocked.failure, undefined, 'known blocks leave the sample empty and say nothing');
      const mixed = assessHubScan(await prepared([challenged, challenged, challenged, emptyPage, emptyPage, emptyPage, goodPage, goodPage], 'ebay'));
      assert.deepEqual([mixed.failure.attempts, mixed.failure.bad], [5, 3], 'blocked pages neither fire nor dilute');
      assert.equal(assessHubScan({ platformId: '' }), null);
    },
  },
];
