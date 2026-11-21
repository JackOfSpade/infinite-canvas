import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import {
  DESC_CONFIGS,
  descriptionExpansionStrategy,
  descriptionNavigationDecision,
} from '../../electron/ipc/browser/manualScraper/walkRules.js';
import {
  GLASSDOOR_JOB_PAGE_GAP_MS,
  GLASSDOOR_JOB_PAGE_RATE_LIMITED_GAP_MS,
  GLASSDOOR_JOB_PAGE_SETTLE_MS,
  expandGlassdoorDescriptions,
  glassdoorJobPageSalary,
  glassdoorPanelBlockIsSourceWide,
  takeGlassdoorPanelBlockForSource,
  glassdoorJobPageEligible,
  glassdoorJobPageGapMs,
  glassdoorJobPageState,
  glassdoorJobPageVerdict,
  noteGlassdoorJobPageRateLimit,
} from '../../electron/ipc/browser/manualScraper/glassdoorJobPage.js';
import { expandDescriptionsByNavigation } from '../../electron/ipc/browser/manualScraper/expandByNavigation.js';
import { setScrapeMeasurementOverrides } from '../../electron/ipc/browser/scrapeMeasurement.js';
import { formatScrapePaceLine, resetManualScraperTelemetry, getManualScraperTelemetry } from '../../electron/ipc/browser/manualScraper.js';
import { describeCardWalkDescriptionRoute } from '../../electron/ipc/bugReport/jobsSnapshot.js';
import { explicitSalaryCurrency, inferSalaryCurrency } from '../../src/utils/salaryCurrency.js';
import { parseSalaryToNumeric } from '../../src/nodes/jobsearch/buildJobTree.js';
import fs from 'node:fs';
import { GLASSDOOR_EXTRACTOR } from '../../electron/extractors/jobs.js';
import { glassdoorJobPageTarget, withoutGlassdoorJobPageUrl } from '../../electron/ipc/browser/manualScraper/glassdoorJobPage.js';
import { glassdoorCountryDomain } from '../../electron/ipc/browser/manualScraper/walkRules.js';
import { sourceJobKey } from '../../src/utils/jobIdentity.js';

const LIST_URL = 'https://www.glassdoor.ca/Job/canada-architect-jobs.htm';
const cfg = DESC_CONFIGS.glassdoor;
const overlayBase = { srcName: 'Glassdoor', srcLabel: 'Glassdoor', qLabel: 'q', qText: '' };
const LONG = 'Design and operate the platform with the team. '.repeat(12);

const row = (jl, extra = {}) => ({
  source: 'glassdoor', title: `Architect ${jl}`, company: '', location: 'Toronto, ON', salary: '', posted: '',
  url: `https://www.glassdoor.ca/job-listing/architect.htm?jl=${jl}`, snippet: '', ...extra,
});

const jobPosting = (fields) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', ...fields })}</script>`;

/**
 * A list page plus one background detail tab per batch. `pages[jl]` is what
 * that row's job page serves: { status, title, head, body }.
 */
function fakeBrowser(pages) {
  const virtualConsole = new VirtualConsole();
  const observed = { navigations: [], gotoOptions: [], bringToFront: 0, detailClosed: 0, listNavigations: 0, delays: [], settles: 0 };
  let detail = null; // { served, settled, load(content) } for the open detail tab
  const evalIn = (dom, fn, args) => (typeof fn === 'string'
    ? undefined
    : dom.window.eval(`(${fn.toString()})(${args.map(value => JSON.stringify(value)).join(',')})`));
  const listDom = new JSDOM('<html><head><title>Jobs</title></head><body><main><h1>Jobs</h1></main></body></html>',
    { url: LIST_URL, runScripts: 'outside-only', virtualConsole });
  const listPage = {
    url: () => LIST_URL,
    browser: () => ({}),
    viewport: () => null,
    evaluate: async (fn, ...args) => evalIn(listDom, fn, args),
    bringToFront: async () => { observed.bringToFront += 1; },
    goto: async () => { observed.listNavigations += 1; },
  };
  const createBackgroundPage = async () => {
    let currentUrl = 'about:blank';
    let dom = new JSDOM('<html><body></body></html>', { runScripts: 'outside-only', virtualConsole });
    const load = (url, content) => {
      dom.window.close();
      dom = new JSDOM(`<html><head><title>${content.title || ''}</title>${content.head || ''}</head><body>${content.body || ''}</body></html>`,
        { url, runScripts: 'outside-only', virtualConsole });
      Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
    };
    return {
      url: () => currentUrl,
      setViewport: async () => {},
      evaluateOnNewDocument: async () => {},
      bringToFront: async () => { observed.bringToFront += 1; },
      close: async () => { observed.detailClosed += 1; dom.window.close(); },
      waitForFunction: async () => { throw new Error('synthetic carrier timeout'); },
      goto: async (url, options) => {
        const jl = new URL(url).searchParams.get('jl');
        observed.navigations.push(url);
        observed.gotoOptions.push(options);
        // An array serves its entries in order (the last one repeats).
        const entry = pages[jl];
        const served = (Array.isArray(entry) ? (entry.length > 1 ? entry.shift() : entry[0]) : entry)
          || { status: 200, title: 'Emploi', head: '', body: '<main><h1>Emploi</h1></main>' };
        currentUrl = url;
        load(url, served);
        // afterSettle: what the page becomes once the settle window passed
        // (a late-injected widget). unreadable: 'first' | 'always'.
        detail = { served, settled: false, settle: () => { if (served.afterSettle) load(url, served.afterSettle); } };
        return { status: () => served.status, headers: () => ({}) };
      },
      evaluate: async (fn, ...args) => {
        const unreadable = detail?.served?.unreadable;
        if (typeof fn !== 'string' && (unreadable === 'always' || (unreadable === 'first' && !detail.settled))) {
          throw new Error('Execution context was destroyed');
        }
        return evalIn(dom, fn, args);
      },
    };
  };
  const runtime = {
    createBackgroundPage,
    delay: async (ms) => {
      if (ms === GLASSDOOR_JOB_PAGE_SETTLE_MS) {
        observed.settles += 1;
        if (detail) { detail.settled = true; detail.settle(); }
        return true;
      }
      observed.delays.push(ms);
      return true;
    },
  };
  return { listPage, runtime, observed, close: () => listDom.window.close() };
}

const okPage = (fields = {}) => ({
  status: 200,
  title: 'Architecte – Emploi | Glassdoor',
  head: jobPosting({ title: 'Architecte (FR chrome)', description: `<p>${LONG}</p>`, ...fields }),
  body: '<main><h1>Architecte</h1><p>Postuler</p></main>',
});
const rateLimitPage = { status: 429, title: 'Security | Glassdoor', head: '', body: '<p>Please wait.</p>' };

async function walk(fake, jobs, detailPacing) {
  return expandDescriptionsByNavigation(fake.listPage, jobs, 'glassdoor', overlayBase, jobs.length, null,
    { detailPacing }, fake.runtime, cfg);
}

export default [
  {
    name: 'Glassdoor job-page routing allows only same-host https /job-listing/ URLs',
    run() {
      const context = { listUrl: LIST_URL };
      const allowed = descriptionNavigationDecision('glassdoor', 'https://www.glassdoor.ca/job-listing/a.htm?jl=1', context);
      assert.equal(allowed.allowed, true);
      assert.equal(allowed.reason, 'glassdoor-same-host-job-listing');
      const refused = {
        'http://www.glassdoor.ca/job-listing/a.htm?jl=1': 'glassdoor-detail-not-https',
        'https://www.glassdoor.com/job-listing/a.htm?jl=1': 'glassdoor-detail-other-host',
        'https://www.glassdoor.ca/Job/canada-jobs.htm': 'glassdoor-detail-not-job-listing',
        'https://www.glassdoor.ca/partner/jobListing.htm?jl=1': 'glassdoor-detail-not-job-listing',
        'https://boards.greenhouse.io/acme/jobs/1': 'glassdoor-detail-other-host',
        'not a url': 'malformed-detail-url',
      };
      for (const [url, reason] of Object.entries(refused)) {
        const decision = descriptionNavigationDecision('glassdoor', url, context);
        assert.equal(decision.allowed, false, url);
        assert.equal(decision.reason, reason, url);
      }
      assert.equal(descriptionNavigationDecision('glassdoor', 'https://www.glassdoor.ca/job-listing/a.htm?jl=1').reason,
        'glassdoor-list-host-unknown', 'without the list page host nothing is allowed');
      assert.equal(descriptionNavigationDecision('glassdoor', 'https://evil.example/job-listing/a.htm',
        { listUrl: 'https://evil.example/Job/x.htm' }).allowed, false, 'a non-Glassdoor list host never qualifies');
      // Eligibility pins a sibling Glassdoor host to the list host first.
      assert.equal(glassdoorJobPageEligible({ url: 'https://www.glassdoor.com/job-listing/a.htm?jl=1' }, LIST_URL), true);
      assert.equal(glassdoorJobPageEligible({ url: 'https://www.glassdoor.ca/Job/x.htm' }, LIST_URL), false);
      assert.equal(glassdoorJobPageEligible({ url: 'https://boards.greenhouse.io/acme/jobs/1' }, LIST_URL), false);
      assert.equal(descriptionExpansionStrategy('glassdoor'), 'job-page-then-list-card-panel');
      assert.equal(cfg.jsonLdType, 'JobPosting');
      assert.equal(cfg.jsonLdField, 'description');
      assert.equal(cfg.pinToListHost, true);
      assert.equal(cfg.expandViaNavigation, undefined, 'Glassdoor never becomes a plain detail-navigation source');
      assert.equal(cfg.panelWindowMax, 10, 'the panel fallback keeps its window');
    },
  },
  {
    name: 'Glassdoor job-page verdict: 429 / Security page is a rate limit, any check is a challenge',
    run() {
      assert.equal(glassdoorJobPageVerdict({ httpStatus: 200, signals: { title: 'Architecte | Glassdoor' } }), 'ok');
      assert.equal(glassdoorJobPageVerdict({ httpStatus: 429, signals: {} }), 'rate-limited');
      assert.equal(glassdoorJobPageVerdict({ httpStatus: 200, signals: { title: 'Security | Glassdoor' } }), 'rate-limited');
      // The 429 page's own copy can read as verification text; it is still a rate limit.
      assert.equal(glassdoorJobPageVerdict({ httpStatus: 429, signals: { title: 'Security | Glassdoor', isChallenge: true, isHardBlock: true, reason: 'hard-block' } }), 'rate-limited');
      assert.equal(glassdoorJobPageVerdict({ httpStatus: 429, signals: { hasCloudflareTurnstileWidget: true, interactive: true } }), 'challenge');
      assert.equal(glassdoorJobPageVerdict({ httpStatus: 429, signals: { hasTerminalHardBlockText: true } }), 'challenge');
      assert.equal(glassdoorJobPageVerdict({ httpStatus: 200, signals: { isChallenge: true, reason: 'just-a-moment-title' } }), 'challenge');
      assert.equal(glassdoorJobPageVerdict({ httpStatus: 403, signals: { isHardBlock: true } }), 'challenge');
      assert.equal(glassdoorJobPageVerdict({ httpStatus: 403, signals: {} }), 'ok', 'a 403 with content is a miss, not a stop');
    },
  },
  {
    name: 'Glassdoor job page maps JSON-LD to the panel path\'s row fields for both baseSalary shapes',
    async run() {
      resetManualScraperTelemetry();
      const fake = fakeBrowser({
        1: okPage({
          datePosted: '2026-11-18',
          baseSalary: { '@type': 'MonetaryAmount', currency: 'CAD', value: { '@type': 'QuantitativeValue', minValue: 90000, maxValue: 120000, unitText: 'YEAR' } },
          hiringOrganization: { '@type': 'Organization', name: 'Northwind Labs' },
          jobLocation: { '@type': 'Place', address: { addressLocality: 'Toronto', addressRegion: 'ON', addressCountry: 'CA' } },
        }),
        2: okPage({ baseSalary: { currency: 'CAD', value: { value: 45, unitText: 'HOUR' } }, hiringOrganization: 'Beta Inc' }),
        3: { status: 403, title: 'Glassdoor', head: '', body: '<main><h1>Glassdoor</h1><p>Some content</p></main>' },
      });
      try {
        const pacing = {};
        const result = await walk(fake, [row(1), row(2), row(3, { company: 'Kept Co', salary: '$100,000 - $110,000/yr' })], pacing);
        assert.deepEqual(result.rowOutcomes, ['expanded', 'expanded', 'pending']);
        const [a, b, c] = result.rows;
        assert.equal(a.title, 'Architect 1', 'the title always stays the list card\'s');
        assert.equal(a.snippet, LONG.trim(), 'HTML is stripped like other JSON-LD descriptions');
        assert.equal(a.descriptionCapture, 'glassdoor-job-page-json-ld');
        assert.equal(a.posted, '2026-11-18');
        assert.equal(a.salary, '$90,000 - $120,000/yr');
        assert.equal(a.salaryProvenance, 'posted', 'baseSalary is employer-posted pay, as on the panel path');
        assert.equal(a.company, 'Northwind Labs');
        assert.equal(a.location, 'Toronto, ON', 'the list location is kept');
        assert.equal(b.salary, '$45/hr');
        assert.equal(b.salaryProvenance, 'posted');
        assert.equal(b.company, 'Beta Inc');
        assert.equal(b.posted, '', 'no DOM date guess is taken from Glassdoor page chrome');
        assert.deepEqual(c, row(3, { company: 'Kept Co', salary: '$100,000 - $110,000/yr' }), 'a miss leaves the row untouched for the panel');
        assert.equal(result.expandedCount, 2);
        assert.equal(fake.observed.listNavigations, 0, 'the list page is never navigated');
        assert.equal(fake.observed.detailClosed, 1, 'the detail tab is closed');
        const misses = [...(getManualScraperTelemetry().fieldAnomalies || []), ...(getManualScraperTelemetry().events || [])].filter(e => e?.phase === 'desc-miss');
        assert.equal(misses.length, 0, 'a job-page miss is not reported as a description miss');
      } finally { fake.close(); }
    },
  },
  {
    name: 'Glassdoor job pages wait 4 s between navigation starts and no gap when measurement pacing is off',
    async run() {
      assert.equal(GLASSDOOR_JOB_PAGE_GAP_MS, 4000);
      assert.equal(glassdoorJobPageGapMs(0), 4000);
      assert.equal(glassdoorJobPageGapMs(GLASSDOOR_JOB_PAGE_RATE_LIMITED_GAP_MS), 8000);
      const fake = fakeBrowser({ 1: okPage(), 2: okPage(), 3: okPage() });
      try {
        await walk(fake, [row(1), row(2), row(3)], {});
        assert.equal(fake.observed.delays.length, 2, 'the first navigation has no prior start to wait after');
        assert(fake.observed.delays.every(ms => ms > 3500 && ms <= 4000), `waits ${fake.observed.delays}`);
      } finally { fake.close(); }
      setScrapeMeasurementOverrides({ pacing: { glassdoor: 'off' } });
      try {
        assert.equal(glassdoorJobPageGapMs(8000), 0);
        const off = fakeBrowser({ 1: okPage(), 2: okPage() });
        try {
          const result = await walk(off, [row(1), row(2)], {});
          assert.equal(result.expandedCount, 2);
          assert.equal(off.observed.delays.length, 0, 'measurementPacingOff(glassdoor) removes the gap');
        } finally { off.close(); }
      } finally {
        setScrapeMeasurementOverrides(null);
      }
    },
  },
  {
    name: 'Glassdoor 429 ladder: first ends the batch and persists an 8 s gap, second turns job pages off',
    async run() {
      const pacing = {};
      const first = fakeBrowser({ 1: okPage(), 2: rateLimitPage, 3: okPage() });
      try {
        const result = await walk(first, [row(1), row(2), row(3)], pacing);
        assert.deepEqual(result.rowOutcomes, ['expanded', 'pending', 'pending']);
        assert.equal(result.jobPageRoute.stopReason, '429-first');
        assert.equal(first.observed.navigations.length, 2, 'the 429 page is not retried and row 3 is not opened');
        assert.equal(pacing.rateLimitedGapMs, 8000, 'the raised gap is persisted for later batches');
        assert.equal(pacing.glassdoorJobPage.rateLimits, 1);
        assert.equal(pacing.glassdoorJobPage.off, false);
      } finally { first.close(); }
      const second = fakeBrowser({ 4: okPage(), 5: rateLimitPage, 6: okPage() });
      try {
        const result = await walk(second, [row(4), row(5), row(6)], pacing);
        assert(second.observed.delays.every(ms => ms > 7000 && ms <= 8000), `later batch waits ${second.observed.delays}`);
        assert.equal(result.jobPageRoute.stopReason, '429-second');
        assert.equal(pacing.glassdoorJobPage.off, true);
        assert.equal(pacing.glassdoorJobPage.stopReason, '429-second');
      } finally { second.close(); }
      // With the route off the dispatcher sends everything to the panel.
      let navCalls = 0;
      let panelRows = null;
      const result = await expandGlassdoorDescriptions({ url: () => LIST_URL }, [row(7), row(8)], 'glassdoor', overlayBase, 2, null,
        { detailPacing: pacing }, null, cfg, {
          byNavigation: async () => { navCalls += 1; return null; },
          byPanel: async (_page, jobs) => { panelRows = jobs; return { jobs, expandedCount: 0 }; },
        });
      assert.equal(navCalls, 0);
      assert.equal(panelRows.length, 2);
      assert.equal(result.descriptionRoute.routeOffAtStart, true);
      // The ladder helper itself.
      const state = glassdoorJobPageState({});
      assert.deepEqual(noteGlassdoorJobPageRateLimit(state), { stopReason: '429-first', gapMs: 8000 });
      assert.deepEqual(noteGlassdoorJobPageRateLimit(state), { stopReason: '429-second', gapMs: 8000 });
      assert.equal(state.off, true);
    },
  },
  {
    name: 'Glassdoor job-page challenge stops the route at once: no wait, no foreground, tab closed',
    async run() {
      for (const challenge of [
        { status: 200, title: 'Just a moment...', head: '', body: '<div class="cf-turnstile"></div>' },
        { status: 403, title: 'Glassdoor', head: '', body: '<h1>Humans only</h1><p>If you have been mistakenly blocked from accessing our site</p>' },
        { status: 429, title: 'Security | Glassdoor', head: '', body: '<div id="cf-chl-widget-x"></div>' },
      ]) {
        const pacing = {};
        resetManualScraperTelemetry();
        const fake = fakeBrowser({ 1: okPage(), 2: challenge, 3: okPage() });
        try {
          const startedAt = Date.now();
          const result = await walk(fake, [row(1), row(2), row(3)], pacing);
          assert(Date.now() - startedAt < 2000, 'no settle or solve wait on a Glassdoor job-page challenge');
          assert.deepEqual(result.rowOutcomes, ['expanded', 'pending', 'pending']);
          assert.equal(result.jobPageRoute.stopReason, 'challenge');
          assert.equal(fake.observed.navigations.length, 2);
          assert.equal(fake.observed.bringToFront, 0, 'a Glassdoor job-page challenge is never foregrounded');
          assert.equal(fake.observed.detailClosed, 1, 'the challenged detail tab is closed');
          assert.equal(pacing.glassdoorJobPage.off, true, 'job pages are off for the rest of the source run');
          assert.equal(result.descWarning?.severity === 'block', false);
          const stops = (getManualScraperTelemetry().events || []).filter(e => e?.phase === 'detail-job-page-route-stop');
          assert.equal(stops.at(-1)?.reason, 'challenge');
          assert.equal(stops.at(-1)?.routeOff, true);
          const codes = stops.at(-1)?.signals;
          assert.equal(stops.at(-1)?.verdict, 'challenge');
          assert(codes && typeof codes === 'object', 'the stop records which signals fired');
          assert.equal(codes.status, challenge.status);
          assert(Object.values(codes).every(v => v === null || typeof v === 'boolean' || typeof v === 'number' || /^[a-z0-9-]+$/u.test(v)),
            'fixed codes only — no page text');
          assert(!JSON.stringify(codes).includes('Humans only') && !JSON.stringify(codes).includes('Just a moment'));
        } finally { fake.close(); }
      }
    },
  },
  {
    name: 'Glassdoor dispatcher merges job-page and panel rows in order without double counting',
    async run() {
      const jobs = [
        row(1),
        row(2, { url: 'https://boards.greenhouse.io/acme/jobs/2' }),
        row(3),
        row(4),
        row(5),
      ];
      const navInputs = [];
      const panelInputs = [];
      let panelPlan = null;
      const recorded = [];
      const paced = [];
      const pacing = {};
      const result = await expandGlassdoorDescriptions({ url: () => LIST_URL }, jobs, 'glassdoor', overlayBase, 15, null,
        { physicalTotal: 40, physicalIndexes: [11, 12, 13, 14, 15], detailPacing: pacing }, null, cfg, {
          byNavigation: async (_page, navJobs, _s, _o, _t, _sig, plan) => {
            navInputs.push(...navJobs);
            assert.deepEqual(plan.physicalIndexes, [11, 13, 14, 15]);
            assert.equal(plan.detailPacing, pacing, 'both walks share the source pacing object');
            return {
              rows: [{ ...navJobs[0], snippet: 'job page text' }, navJobs[1], null, { ...navJobs[3], boardClosed: { board: 'glassdoor' } }],
              rowOutcomes: ['expanded', 'pending', 'closed', 'closed'],
              jobPageRoute: { stopReason: '429-first', opened: 4 },
              expandedCount: 1, unavailableDetailDropped: 1, boardClosedDetailKept: 1,
              descWarning: { code: 'description-detail-navigation', severity: 'warn' },
            };
          },
          byPanel: async (_page, panelJobs, _s, _o, _t, _sig, plan) => {
            panelInputs.push(...panelJobs);
            panelPlan = plan;
            return {
              jobs: [{ ...panelJobs[0], snippet: 'panel text' }, { ...panelJobs[1], descriptionDeferredReason: 'description-rate-limited' }],
              expandedCount: 1, attemptedCount: 2, descWarning: { code: 'description-rate-limited', severity: 'block' },
              unavailableDetailDropped: 0, boardClosedDetailKept: 0,
            };
          },
          record: route => recorded.push(route),
          notePace: summary => paced.push(summary),
        });
      assert.deepEqual(navInputs.map(j => j.title), ['Architect 1', 'Architect 3', 'Architect 4', 'Architect 5']);
      assert.deepEqual(panelInputs.map(j => j.title), ['Architect 2', 'Architect 3'], 'closed rows are never re-tried via panel');
      assert.deepEqual(panelPlan.physicalIndexes, [12, 13], 'the panel keeps each row\'s list position');
      assert.deepEqual(result.jobs.map(j => j.title), ['Architect 1', 'Architect 2', 'Architect 3', 'Architect 5']);
      assert.equal(result.jobs[0].snippet, 'job page text');
      assert.equal(result.jobs[1].snippet, 'panel text');
      assert.equal(result.jobs[2].descriptionDeferredReason, 'description-rate-limited');
      assert.equal(result.jobs[3].boardClosed.board, 'glassdoor');
      assert.equal(result.expandedCount, 2);
      assert.equal(result.attemptedCount, 6);
      assert.equal(result.unavailableDetailDropped, 1);
      assert.equal(result.boardClosedDetailKept, 1);
      assert.equal(result.descWarning.code, 'description-rate-limited', 'only the panel warning describes still-missing rows');
      assert.deepEqual(recorded[0], {
        jobPageEligible: 4, jobPageOpened: 4, silentMisses: 0, fromJobPage: 1, jobPageClosed: 2,
        panelFallback: 2, fromPanel: 1, stopReason: '429-first', routeOffAtStart: false, sourceStopReason: 'none',
        panelBlock: 'armed',
      });
      assert.equal(pacing.glassdoorJobPage.panelBlock.code, 'description-rate-limited',
        'the panel block is kept panel-only while job pages are on');
      assert.equal(glassdoorPanelBlockIsSourceWide(pacing), false);
      assert.deepEqual(paced[0], { fromJobPage: 1, fromPanel: 1, stopReason: 'none' });
    },
  },
  {
    name: 'Glassdoor route diagnostics print fixed codes and counts only',
    run() {
      const parts = describeCardWalkDescriptionRoute({
        jobPageEligible: 30, jobPageOpened: 14, fromJobPage: 12, jobPageClosed: 1,
        panelFallback: 17, fromPanel: 9, stopReason: '429-first', sourceStopReason: '<script>', routeOffAtStart: false,
      });
      assert.deepEqual(parts, [
        'job-page 12/30 described (14 opened, 1 closed)',
        'panel-fallback 9/17 described',
        'job-page-stop 429-first',
        'source job-page-stop unknown',
      ]);
      assert.deepEqual(describeCardWalkDescriptionRoute(null), []);
      const line = formatScrapePaceLine({ srcName: 'Glassdoor', descriptionRoute: { fromJobPage: 40, fromPanel: 5, stopReason: 'challenge' } });
      assert.match(line, /descriptions: 40 from job pages, 5 from panel fallback · job-page route stop challenge/u);
      const odd = formatScrapePaceLine({ srcName: 'Glassdoor', descriptionRoute: { fromJobPage: 1, fromPanel: 0, stopReason: 'https://x' } });
      assert.match(odd, /job-page route stop none/u);
      assert.doesNotMatch(formatScrapePaceLine({ srcName: 'ZipRecruiter' }), /descriptions:/u);
    },
  },
  {
    name: 'Glassdoor late widget: a 429/Security page re-probed after the settle becomes a challenge',
    async run() {
      resetManualScraperTelemetry();
      const pacing = {};
      const late = { ...rateLimitPage, afterSettle: { title: 'Security | Glassdoor', head: '', body: '<div class="cf-turnstile"></div>' } };
      const fake = fakeBrowser({ 1: okPage(), 2: late, 3: okPage() });
      try {
        const result = await walk(fake, [row(1), row(2), row(3)], pacing);
        assert.equal(fake.observed.settles, 1, 'exactly one bounded re-probe');
        assert.equal(result.jobPageRoute.stopReason, 'challenge');
        assert.equal(pacing.glassdoorJobPage.off, true);
        assert.equal(pacing.glassdoorJobPage.rateLimits, 0, 'a late widget is not counted as a 429');
        assert.equal(fake.observed.bringToFront, 0);
      } finally { fake.close(); }
      // A page with no JSON-LD description is re-probed too.
      const noLd = { status: 200, title: 'Glassdoor', head: '', body: '<main><h1>x</h1></main>',
        afterSettle: { title: 'Just a moment...', head: '', body: '<div id="cf-chl-widget-a"></div>' } };
      const second = fakeBrowser({ 1: noLd, 2: okPage() });
      try {
        const result = await walk(second, [row(1), row(2)], {});
        assert.equal(result.jobPageRoute.stopReason, 'challenge');
        assert.equal(second.observed.navigations.length, 1);
      } finally { second.close(); }
      // A healthy page is never re-probed.
      const healthy = fakeBrowser({ 1: okPage(), 2: okPage() });
      try {
        await walk(healthy, [row(1), row(2)], {});
        assert.equal(healthy.observed.settles, 0);
      } finally { healthy.close(); }
    },
  },
  {
    name: 'Glassdoor unreadable probe: re-probed once; unreadable twice ends this batch only',
    async run() {
      const pacing = {};
      const once = fakeBrowser({ 1: { ...okPage(), unreadable: 'first' }, 2: okPage() });
      try {
        const result = await walk(once, [row(1), row(2)], pacing);
        assert.deepEqual(result.rowOutcomes, ['expanded', 'expanded'], 'readable on the re-probe → continue');
        assert.equal(once.observed.settles, 1);
      } finally { once.close(); }
      const twice = fakeBrowser({ 1: okPage(), 2: { ...okPage(), unreadable: 'always' }, 3: okPage() });
      try {
        const result = await walk(twice, [row(1), row(2), row(3)], pacing);
        assert.deepEqual(result.rowOutcomes, ['expanded', 'pending', 'pending']);
        assert.equal(result.jobPageRoute.stopReason, 'unreadable');
        assert.equal(twice.observed.navigations.length, 2);
        assert.equal(pacing.glassdoorJobPage.off, false, 'an unreadable page does not turn the route off');
        assert.equal(pacing.glassdoorJobPage.rateLimits, 0, 'and is not a 429 on the ladder');
        assert.equal(Boolean(pacing.rateLimitedGapMs), false, 'nor raises the gap');
      } finally { twice.close(); }
      assert.equal(glassdoorJobPageVerdict({ signals: { reason: 'evaluate-failed', isChallenge: false } }), 'unreadable');
    },
  },
  {
    name: 'Glassdoor verdict: "humans only" text and reCAPTCHA frames count only on a page without the posting',
    async run() {
      const posting = { hasJobPostingDescription: true };
      assert.equal(glassdoorJobPageVerdict({ httpStatus: 200, signals: { hasTerminalHardBlockText: true }, ...posting }), 'ok');
      assert.equal(glassdoorJobPageVerdict({ httpStatus: 200, signals: { visibleRecaptchaFrames: 1, interactive: true, isChallenge: true, reason: 'visible-recaptcha-without-content' }, ...posting }), 'ok');
      assert.equal(glassdoorJobPageVerdict({ httpStatus: 200, signals: { hasTerminalHardBlockText: true, hasNormalContent: true } }), 'ok');
      assert.equal(glassdoorJobPageVerdict({ httpStatus: 200, signals: { hasTerminalHardBlockText: true }, hasJobPostingDescription: false }), 'challenge');
      assert.equal(glassdoorJobPageVerdict({ httpStatus: 200, signals: { visibleHCaptchaFrames: 1 }, hasJobPostingDescription: false }), 'challenge');
      // The strict signals stay strict even with the posting present.
      for (const strict of [{ hasCloudflareTurnstileWidget: true }, { hasCloudflareChallengeFrame: true }, { hasChallengeShell: true }]) {
        assert.equal(glassdoorJobPageVerdict({ httpStatus: 200, signals: strict, ...posting }), 'challenge', JSON.stringify(strict));
      }
      assert.equal(glassdoorJobPageVerdict({ httpStatus: 200, signals: { title: 'Security | Glassdoor' }, ...posting }), 'rate-limited');
      // Live 2026-11-20 regression shape: a posting page with JSON-LD whose classifier
      // verdict rests on hard-block / verification text or captcha frames is read, not stopped.
      for (const signals of [
        { isChallenge: true, isHardBlock: true, reason: 'hard-block', hasTerminalHardBlockText: true, hasVerificationText: true },
        { isChallenge: true, reason: 'verification-text', hasVerificationText: true },
        { isChallenge: true, interactive: true, reason: 'visible-recaptcha-without-content', visibleRecaptchaFrames: 2 },
      ]) assert.equal(glassdoorJobPageVerdict({ httpStatus: 200, signals, ...posting }), 'ok', JSON.stringify(signals));
      // End to end: a posting that says "humans only" is read normally.
      const fake = fakeBrowser({ 1: { ...okPage(), body: '<main><h1>Architecte</h1><p>Humans only, no bots, will review this role.</p><iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe></main>' } });
      try {
        const result = await walk(fake, [row(1)], {});
        assert.deepEqual(result.rowOutcomes, ['expanded']);
      } finally { fake.close(); }
    },
  },
  {
    name: 'Glassdoor job pages send the list page as Referer; other sources do not',
    async run() {
      const fake = fakeBrowser({ 1: okPage() });
      try {
        await walk(fake, [row(1)], {});
        assert.equal(fake.observed.gotoOptions[0].referer, LIST_URL);
      } finally { fake.close(); }
      const source = fs.readFileSync(new URL('../../electron/ipc/browser/manualScraper/expandByNavigation.js', import.meta.url), 'utf8');
      assert.match(source, /\.\.\.\(glassdoorJobPage \? \{ referer: listUrl \} : \{\}\)/u, 'the referer is added for Glassdoor only');
    },
  },
  {
    name: 'Glassdoor job-page salary keeps the currency the way Glassdoor list chips do',
    run() {
      const usd = { currency: 'USD', value: { minValue: 90000, maxValue: 120000, unitText: 'YEAR' } };
      const cad = { currency: 'CAD', value: { minValue: 90000, maxValue: 120000, unitText: 'YEAR' } };
      const caList = 'https://www.glassdoor.ca/Job/x.htm';
      const usList = 'https://www.glassdoor.com/Job/x.htm';
      assert.equal(glassdoorJobPageSalary(cad, caList), '$90,000 - $120,000/yr', 'home currency stays a bare $');
      assert.equal(glassdoorJobPageSalary(usd, usList), '$90,000 - $120,000/yr');
      const usdOnCa = glassdoorJobPageSalary(usd, caList);
      const cadOnUs = glassdoorJobPageSalary(cad, usList);
      assert.equal(usdOnCa, 'US$90,000 - US$120,000/yr');
      assert.equal(cadOnUs, 'CA$90,000 - CA$120,000/yr');
      // Through the real parsers: currency is explicit and the amount still parses.
      assert.equal(explicitSalaryCurrency(usdOnCa), 'USD');
      assert.equal(inferSalaryCurrency(usdOnCa, 'Toronto, ON').currency ?? inferSalaryCurrency(usdOnCa, 'Toronto, ON'), 'USD');
      assert.equal(explicitSalaryCurrency(cadOnUs), 'CAD');
      assert.equal(parseSalaryToNumeric(usdOnCa), parseSalaryToNumeric('$90,000 - $120,000/yr'));
      assert(parseSalaryToNumeric(cadOnUs) > 0);
      assert.equal(glassdoorJobPageSalary({ currency: 'USD', value: { value: 45, unitText: 'HOUR' } }, caList), 'US$45/hr');
      assert.equal(glassdoorJobPageSalary({ currency: 'EUR', value: { value: 50000, unitText: 'YEAR' } }, caList), 'EUR 50,000/yr');
      assert.equal(glassdoorJobPageSalary({ currency: 'USD', value: { minValue: 90000, unitText: 'YEAR' } }, caList), '', 'min-only stays unmapped');
    },
  },
  {
    name: 'Glassdoor job-page navigation errors and URL skips go to the panel without a desc-miss anomaly',
    async run() {
      resetManualScraperTelemetry();
      const fake = fakeBrowser({ 1: okPage() });
      // Row 2's navigation throws; row 3's URL is refused by the same-host rule.
      const createBackgroundPage = fake.runtime.createBackgroundPage;
      fake.runtime.createBackgroundPage = async (...args) => {
        const tab = await createBackgroundPage(...args);
        const goto = tab.goto;
        tab.goto = async (url, options) => {
          if (url.includes('jl=2')) throw new Error('Navigation timeout of 12000 ms exceeded');
          return goto(url, options);
        };
        return tab;
      };
      try {
        const result = await walk(fake, [row(1), row(2), row(3, { url: 'https://www.glassdoor.com/Job/other.htm?jl=3' })], {});
        assert.deepEqual(result.rowOutcomes, ['expanded', 'pending', 'pending']);
        assert.equal(result.jobPageRoute.silentMisses, 2);
        const telemetry = getManualScraperTelemetry();
        const misses = [...(telemetry.fieldAnomalies || []), ...(telemetry.events || [])].filter(e => e?.phase === 'desc-miss');
        assert.equal(misses.length, 0);
      } finally { fake.close(); }
    },
  },
  {
    name: 'Glassdoor panel block stops only the panel part while job pages are on, then hands over',
    async run() {
      let clock = 1_000_000;
      const pacing = {};
      const state = glassdoorJobPageState(pacing);
      state.panelBlock = { code: 'description-rate-limited', at: clock, reprobes: 0 };
      let panelCalls = [];
      const nav = async (_p, jobs) => ({
        rows: jobs.map((j, k) => (k === 0 ? { ...j, snippet: 'job page' } : j)),
        rowOutcomes: jobs.map((_, k) => (k === 0 ? 'expanded' : 'pending')),
        jobPageRoute: { stopReason: 'none', opened: jobs.length }, expandedCount: 1,
      });
      const panelOk = async (_p, jobs) => { panelCalls.push(jobs.length); return { jobs: jobs.map(j => ({ ...j, snippet: 'panel' })), expandedCount: jobs.length, attemptedCount: jobs.length }; };
      const deps = { byNavigation: nav, byPanel: panelOk, now: () => clock };
      const run = () => expandGlassdoorDescriptions({ url: () => LIST_URL }, [row(1), row(2), row(3), row(4)], 'glassdoor', overlayBase, 4, null, { detailPacing: pacing }, null, cfg, deps);
      // Inside the cooldown: job pages still run, panel rows are deferred.
      let result = await run();
      assert.equal(result.jobs[0].snippet, 'job page', 'job pages keep running under a panel-only block');
      assert.deepEqual(result.jobs.slice(1).map(j => j.descriptionDeferredReason), Array(3).fill('description-rate-limited'));
      assert.deepEqual(panelCalls, []);
      assert.equal(result.descriptionRoute.panelBlock, 'deferred');
      assert.equal(result.descWarning, null);
      // Cooldown elapsed, probe fails: rest deferred, reprobe counted, clock re-armed.
      clock += 120_000;
      deps.byPanel = async (_p, jobs) => { panelCalls.push(jobs.length); return { jobs, expandedCount: 0, attemptedCount: jobs.length, descWarning: { code: 'description-rate-limited', severity: 'block' } }; };
      result = await run();
      assert.deepEqual(panelCalls, [2], 'the probe touches DETAIL_BLOCK_PROBE_CARDS rows only');
      assert.equal(result.jobs[3].descriptionDeferredReason, 'description-rate-limited');
      assert.equal(state.panelBlock.reprobes, 1);
      assert.equal(state.panelBlock.at, clock);
      // Next cooldown (300 s) elapsed, probe recovers: the rest is read too.
      clock += 300_000;
      panelCalls = [];
      deps.byPanel = panelOk;
      result = await run();
      assert.deepEqual(panelCalls, [2, 1]);
      assert.equal(state.panelBlock, null);
      assert.equal(result.descriptionRoute.panelBlock, 'recovered');
      assert(result.jobs.slice(1).every(j => j.snippet === 'panel'));
      // Both routes blocked → handed over to the source-wide block once.
      state.panelBlock = { code: 'description-panel-http-error', at: 42, reprobes: 0 };
      assert.equal(takeGlassdoorPanelBlockForSource(pacing), null, 'not while job pages are on');
      state.off = true;
      assert.equal(glassdoorPanelBlockIsSourceWide(pacing), true);
      assert.deepEqual(takeGlassdoorPanelBlockForSource(pacing), { code: 'description-panel-http-error', at: 42 });
      assert.equal(state.panelBlock, null);
      assert.equal(takeGlassdoorPanelBlockForSource(pacing), null);
      // The source loop only arms the source-wide block when both are blocked.
      const loop = fs.readFileSync(new URL('../../electron/ipc/browser/manualScraper.js', import.meta.url), 'utf8');
      assert.match(loop, /const glassdoorPanelOnlyBlock = Boolean\(detailResult\?\.descriptionRoute\)[\s\S]{0,200}!glassdoorPanelBlockIsSourceWide\(sourceDetailPacing\)/u);
      assert.match(loop, /if \(glassdoorPanelOnlyBlock\) \{[\s\S]{0,700}\} else if \(DETAIL_BLOCK_WARNING_CODES\.includes\(descWarning\?\.code\)\)/u);
      assert.match(loop, /const handover = takeGlassdoorPanelBlockForSource\(sourceDetailPacing\);/u);
    },
  },
  {
    name: 'Glassdoor extractor keeps the saved url on www. and the job-page address exactly as linked',
    run() {
      const run = (html) => {
        const dom = new JSDOM(html, { url: 'https://www.glassdoor.ca/Job/canada-architect-jobs.htm', runScripts: 'outside-only' });
        Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.textContent || ''; } });
        try { return dom.window.eval(GLASSDOOR_EXTRACTOR); } finally { dom.window.close(); }
      };
      const domJobs = run(`<html><body><ul>
        <li data-test="jobListing" data-jobid="101"><a data-test="job-title" href="https://fr.glassdoor.ca/job-listing/platform-architect.htm?jl=101">Platform Architect</a><span data-test="employer-name">Acme</span></li>
        <li data-test="jobListing" data-jobid="102"><a data-test="job-title" href="/partner/jobListing.htm?jl=102">Cloud Architect</a></li>
        <li data-test="jobListing" data-jobid="103"><a data-test="job-title" href="http://fr.glassdoor.ca/job-listing/x.htm?jl=103">Plain http</a></li>
      </ul></body></html>`);
      assert.equal(domJobs[0].url, 'https://www.glassdoor.ca/job-listing/platform-architect.htm?jl=101', 'the saved link stays www.');
      assert.equal(domJobs[0].glassdoorJobPageUrl, 'https://fr.glassdoor.ca/job-listing/platform-architect.htm?jl=101', 'the job page as Glassdoor linked it');
      assert.equal('glassdoorJobPageUrl' in domJobs[1], false, 'a non-/job-listing/ link keeps no job-page address');
      assert.equal('glassdoorJobPageUrl' in domJobs[2], false, 'plain http keeps no job-page address');
      const apollo = { 'JobListingSearchResult:1': { __typename: 'JobListing', jobTitleText: 'Data Architect',
        seoJobLink: 'https://fr.glassdoor.ca/job-listing/data-architect.htm?jl=201', employer: { name: 'Beta' } } };
      const apolloJobs = run(`<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { apolloCache: apollo } } })}</script></body></html>`);
      assert.equal(apolloJobs[0].url, 'https://www.glassdoor.ca/job-listing/data-architect.htm?jl=201');
      assert.equal(apolloJobs[0].glassdoorJobPageUrl, 'https://fr.glassdoor.ca/job-listing/data-architect.htm?jl=201');
      // Identity, dedup and history keys stay on the saved url.
      assert.equal(sourceJobKey(domJobs[0]), sourceJobKey(withoutGlassdoorJobPageUrl(domJobs[0])));
      assert.deepEqual(Object.keys(withoutGlassdoorJobPageUrl(domJobs[0])).includes('glassdoorJobPageUrl'), false);
      assert.equal(withoutGlassdoorJobPageUrl(domJobs[1]), domJobs[1], 'a row without the field is returned as is');
    },
  },
  {
    name: 'Glassdoor job pages may be on a same-country language host, never another country',
    run() {
      const context = { listUrl: LIST_URL };
      for (const url of ['https://fr.glassdoor.ca/job-listing/a.htm?jl=1', 'https://www.glassdoor.ca/job-listing/a.htm?jl=1', 'https://glassdoor.ca/job-listing/a.htm?jl=1']) {
        assert.equal(descriptionNavigationDecision('glassdoor', url, context).allowed, true, url);
      }
      for (const url of ['https://fr.glassdoor.com/job-listing/a.htm?jl=1', 'https://www.glassdoor.com/job-listing/a.htm?jl=1',
        'https://www.glassdoor.co.uk/job-listing/a.htm?jl=1', 'https://api.cdn.glassdoor.ca/job-listing/a.htm?jl=1',
        'https://fr.glassdoor.ca.evil.com/job-listing/a.htm?jl=1']) {
        assert.equal(descriptionNavigationDecision('glassdoor', url, context).allowed, false, url);
      }
      assert.equal(glassdoorCountryDomain('fr.glassdoor.ca'), 'glassdoor.ca');
      assert.equal(glassdoorCountryDomain('www.glassdoor.com.au'), 'glassdoor.com.au');
      assert.equal(glassdoorCountryDomain('evil.com'), null);
      // Target: as-linked unpinned when present, else the pinned saved url.
      assert.equal(glassdoorJobPageTarget({ url: 'https://www.glassdoor.ca/job-listing/a.htm?jl=1', glassdoorJobPageUrl: 'https://fr.glassdoor.ca/job-listing/a.htm?jl=1' }, LIST_URL),
        'https://fr.glassdoor.ca/job-listing/a.htm?jl=1');
      assert.equal(glassdoorJobPageTarget({ url: 'https://www.glassdoor.com/job-listing/a.htm?jl=1' }, LIST_URL),
        'https://www.glassdoor.ca/job-listing/a.htm?jl=1');
      assert.equal(glassdoorJobPageEligible({ url: 'https://www.glassdoor.ca/job-listing/a.htm?jl=1', glassdoorJobPageUrl: 'https://www.glassdoor.com/job-listing/a.htm?jl=1' }, LIST_URL), false,
        'an as-linked address on another country is refused (and never pinned)');
    },
  },
  {
    name: 'Glassdoor route opens the as-linked fr. job page with the list page as Referer; rows without it still work',
    async run() {
      const fake = fakeBrowser({ 1: okPage(), 2: okPage() });
      try {
        const asLinked = row(1, { glassdoorJobPageUrl: 'https://fr.glassdoor.ca/job-listing/architect.htm?jl=1' });
        const legacy = row(2, { url: 'https://www.glassdoor.com/job-listing/architect.htm?jl=2' });
        const result = await walk(fake, [asLinked, legacy], {});
        assert.deepEqual(fake.observed.navigations, [
          'https://fr.glassdoor.ca/job-listing/architect.htm?jl=1',
          'https://www.glassdoor.ca/job-listing/architect.htm?jl=2',
        ]);
        assert(fake.observed.gotoOptions.every(o => o.referer === LIST_URL));
        assert.deepEqual(result.rowOutcomes, ['expanded', 'expanded']);
        assert.equal(result.rows[0].url, 'https://www.glassdoor.ca/job-listing/architect.htm?jl=1', 'the saved url is unchanged');
      } finally { fake.close(); }
      // Rows leave the dispatcher without the scrape-only field.
      const out = await expandGlassdoorDescriptions({ url: () => LIST_URL },
        [row(3, { glassdoorJobPageUrl: 'https://fr.glassdoor.ca/job-listing/a.htm?jl=3' })], 'glassdoor', overlayBase, 1, null, { detailPacing: {} }, null, cfg, {
          byNavigation: async (_p, jobs) => ({ rows: jobs, rowOutcomes: ['pending'], jobPageRoute: { stopReason: 'none', opened: 1 } }),
          byPanel: async (_p, jobs) => ({ jobs, expandedCount: 0 }),
        });
      assert.equal('glassdoorJobPageUrl' in out.jobs[0], false);
    },
  },
  {
    name: 'Glassdoor warm-up: the walk\'s first job page answering 403 is retried once and the route stays on',
    async run() {
      // Live 2026-11-20/21: a fresh browser session's first job page answers
      // 403 (empty or a Security page), and the next pages load normally.
      for (const warmup of [
        { status: 403, title: '', head: '', body: '' },
        { status: 403, title: 'Security | Glassdoor', head: '', body: '<h1>Humans only</h1><p>If you have been mistakenly blocked from accessing our site</p>' },
      ]) {
        const pacing = {};
        const fake = fakeBrowser({ 1: [warmup, okPage()], 2: okPage(), 3: okPage() });
        try {
          resetManualScraperTelemetry();
          const result = await walk(fake, [row(1), row(2), row(3)], pacing);
          assert.equal(result.jobPageRoute.stopReason, 'none', `warm-up ${warmup.title || 'empty'} must not stop the route`);
          assert.equal(pacing.glassdoorJobPage?.off ?? false, false);
          assert.equal(fake.observed.navigations.filter(u => u.includes('jl=1')).length, 2, 'the first row is opened twice: warm-up, then the real read');
          assert.deepEqual(result.rowOutcomes, ['expanded', 'expanded', 'expanded']);
          const warmups = (getManualScraperTelemetry().events || []).filter(e => e?.phase === 'detail-job-page-warmup');
          assert.equal(warmups.length, 1);
        } finally { fake.close(); }
      }
    },
  },
  {
    name: 'Glassdoor warm-up never covers a real Cloudflare check or a later page',
    async run() {
      // A Turnstile on the first page stops the route at once.
      const pacing = {};
      const fake = fakeBrowser({ 1: { status: 403, title: 'Just a moment...', head: '', body: '<div class="cf-turnstile"></div>' }, 2: okPage() });
      try {
        const result = await walk(fake, [row(1), row(2)], pacing);
        assert.equal(result.jobPageRoute.stopReason, 'challenge');
        assert.equal(fake.observed.navigations.length, 1, 'a real check is not retried');
      } finally { fake.close(); }
      // A 403 block on a LATER page is a stop, not a warm-up.
      const later = {};
      const fake2 = fakeBrowser({ 1: okPage(), 2: { status: 403, title: 'Security | Glassdoor', head: '', body: '<h1>Humans only</h1>' }, 3: okPage() });
      try {
        const result = await walk(fake2, [row(1), row(2), row(3)], later);
        assert.notEqual(result.jobPageRoute.stopReason, 'none');
        assert.equal(fake2.observed.navigations.length, 2);
      } finally { fake2.close(); }
    },
  },
];
