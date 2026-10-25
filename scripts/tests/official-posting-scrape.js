import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import {
  extractGlassdoorPanelResponseDetail, getManualScraperTelemetry, mergeExpandedJobDetail,
  mergeGlassdoorPanelDetail, normalizeGoogleApplyOptions, recordManualScraperTelemetry,
  resetManualScraperTelemetry, selectGoogleApplyUrl,
} from '../../electron/ipc/browser/manualScraper.js';
import { GLASSDOOR_EXTRACTOR, GOOGLE_JOBS_EXTRACTOR } from '../../electron/extractors/jobs.js';
import { fetchDiceListings } from '../../electron/extractors/apiExtractors.js';
import { buildJobsPipelineSnapshot } from '../../electron/ipc/bugReport/jobsSnapshot.js';
import { getJobsTelemetry } from '../../electron/ipc/jobs.js';

export default [
  {
    name: 'Official posting scrape: Google options retain all safe leads while preferred destination selection stays unchanged',
    run() {
      const candidates = [
        { label: 'Apply on Google', href: 'https://www.google.com/search?udm=8' },
        { label: 'Apply on Mirror Board', href: 'https://www.indeed.com/viewjob?jk=synthetic&utm_source=google&utm_medium=organic&utm_campaign=jobs' },
        { label: 'Apply on Employer Careers', href: 'https://careers.northwind.example/job/one?utm_source=google' },
        { label: 'Apply on Duplicate', href: 'https://careers.northwind.example/job/one' },
        { label: 'Apply on Insecure', href: 'http://northwind.example/job/one' },
        { label: 'Apply on Credentialed', href: 'https://user:pass@northwind.example/job/one' },
        { label: 'Apply on Invalid', href: 'javascript:alert(1)' },
        { label: 'Share this job', href: 'https://northwind.example/share' },
      ];
      const options = normalizeGoogleApplyOptions(candidates);
      assert.deepEqual(options, [
        { label: 'Apply on Mirror Board', href: 'https://www.indeed.com/viewjob?jk=synthetic' },
        { label: 'Apply on Employer Careers', href: 'https://careers.northwind.example/job/one' },
      ]);
      assert.equal(selectGoogleApplyUrl(candidates, 'Mirror Board'), options[0].href);
      assert.equal(selectGoogleApplyUrl(candidates, 'Employer Careers'), options[1].href);
      assert.equal(selectGoogleApplyUrl([{ label: 'Apply on Insecure', href: 'http://northwind.example/job/one' }]), 'http://northwind.example/job/one', 'legacy destination selection retains its existing URL policy');
      const many = Array.from({ length: 12 }, (_, index) => ({ label: `Apply on ${'x'.repeat(150)} ${index}`, href: `https://northwind.example/jobs/${index}` }));
      assert.equal(normalizeGoogleApplyOptions(many).length, 8);
      assert.ok(normalizeGoogleApplyOptions(many).every(option => option.label.length <= 120));
    },
  },
  {
    name: 'Official posting scrape: detail salary provenance follows the selected structured, estimated or unproven value',
    run() {
      const blank = { source: 'ziprecruiter', salary: '' };
      assert.equal(mergeExpandedJobDetail(blank, { jsonLdSalary: '$50/hr', jsonLdSalaryProvenance: 'posted' }).salaryProvenance, 'posted');
      assert.equal(mergeExpandedJobDetail(blank, { jsonLdSalary: '$50/hr', jsonLdSalaryProvenance: 'estimated' }).salaryProvenance, 'estimated');
      assert.equal(mergeExpandedJobDetail(blank, { jsonLdSalary: '$50/hr' }).salaryProvenance, 'unknown');
      const stated = { source: 'ziprecruiter', salary: '$50/hr', salaryProvenance: 'posted' };
      assert.equal(mergeExpandedJobDetail(stated, { jsonLdSalary: '$40/hr', jsonLdSalaryProvenance: 'estimated' }).salaryProvenance, 'posted');
      assert.equal(mergeExpandedJobDetail(stated, { salaryChanged: true, reconciledSalary: '$104,000/yr' }).salaryProvenance, 'unknown');
      assert.equal(mergeExpandedJobDetail({ source: 'google', salary: '$50/hr', salaryProvenance: 'posted' }, {}).salaryProvenance, 'unknown');
      assert.equal(mergeExpandedJobDetail({ source: 'google', salary: '' }, { jsonLdSalary: '$50/hr', jsonLdSalaryProvenance: 'posted' }).salaryProvenance, 'unknown');
      const estimated = extractGlassdoorPanelResponseDetail({ jobListing: { salaryEstimate: '$120,000/yr' } });
      assert.equal(estimated.salaryProvenance, 'estimated');
      assert.equal(mergeGlassdoorPanelDetail({ salary: '' }, { responseDetail: estimated }).job.salaryProvenance, 'estimated');
      const structured = extractGlassdoorPanelResponseDetail({ jobListing: { baseSalary: { currency: 'CAD', value: { minValue: 120000, maxValue: 150000, unitText: 'YEAR' } } } });
      assert.equal(structured.salaryProvenance, 'posted');
      const ambiguous = extractGlassdoorPanelResponseDetail({ jobListing: { salaryInfo: { min: 120000, max: 150000, payPeriod: 'ANNUAL', currencyCode: 'CAD' } } });
      assert.equal(ambiguous.salaryProvenance, 'unknown');
      assert.equal(extractGlassdoorPanelResponseDetail({ unrelated: true }), null);
    },
  },
  {
    name: 'Official posting scrape: Glassdoor list estimates remain estimates and ambiguous pay-range fields remain unknown',
    run() {
      const data = { props: { pageProps: { apolloCache: {
        'JobListing:1': { jobTitleText: 'Engineer', employerName: 'Northwind Labs', salaryEstimate: '$100,000/yr' },
        'JobListing:2': { jobTitleText: 'Analyst', employerName: 'Cedar Works', salarySource: { payRange: '$110,000/yr' }, salaryEstimate: '$90,000/yr' },
      } } } };
      const dom = new JSDOM(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`, { url: 'https://www.glassdoor.com/jobs' });
      try {
        const jobs = vm.runInNewContext(GLASSDOOR_EXTRACTOR, { document: dom.window.document, window: dom.window, location: dom.window.location });
        assert.equal(jobs[0].salaryProvenance, 'estimated');
        assert.equal(jobs[1].salaryProvenance, 'unknown');
        assert.equal(jobs[1].salary, '$110,000/yr');
      } finally { dom.window.close(); }
      assert.match(GOOGLE_JOBS_EXTRACTOR, /salaryProvenance: 'unknown'/u);
    },
  },
  {
    name: 'Official posting scrape: Dice board salary fields anchor only actual structured pay and retain estimate text unchanged',
    async run() {
      const result = await fetchDiceListings('Engineer', '', null, null, { jobsPerPlatform: 3, maxPages: 1 }, {
        interPageDelayMs: 0,
        requestPage: async () => ({ ok: true, status: 200, json: { data: [
          { id: 'posted', title: 'Engineer', companyName: 'Northwind Labs', salary: '$120,000 - $150,000', detailsPageUrl: 'https://dice.example/posted' },
          { id: 'estimate', title: 'Engineer', companyName: 'Northwind Labs', salary: 'Estimated $120,000 - $150,000', detailsPageUrl: 'https://dice.example/estimate' },
          { id: 'prediction', title: 'Engineer', companyName: 'Northwind Labs', salary: 'Projected $120,000 - $150,000', detailsPageUrl: 'https://dice.example/prediction' },
        ], meta: { totalCount: 3 } } }),
      });
      assert.equal(result.items[0].salaryProvenance, 'posted');
      assert.equal(result.items[1].salaryProvenance, 'unknown');
      assert.equal(result.items[2].salaryProvenance, 'unknown');
      assert.equal(result.items[1].salary, 'Estimated $120,000 - $150,000');
    },
  },
  {
    name: 'Official posting scrape: nonaggregator Google option row counts survive telemetry and reset with its run',
    run() {
      const telemetry = getJobsTelemetry(); const scrape = getManualScraperTelemetry();
      const saved = { nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search,
        scrape: { ...scrape } };
      Object.assign(telemetry, { nodeId: 'official-posting-scrape-test', windowId: null,
        search: { ts: Date.now(), queries: 1, raw: 3, kept: 3, deduped: 3, ageDropped: 0, historyDropped: 0 } });
      scrape.active = null; scrape.events = []; scrape.fieldAnomalies = [];
      try {
        recordManualScraperTelemetry({ phase: 'card-walk', sourceId: 'google', srcName: 'Google for Jobs', strategy: 'list-card-panel',
          itemTotal: 3, attempted: 3, expanded: 3, googleApplyLinksCaptured: 3, googleApplyLinksMissing: 0,
          googleApplyOptionsNonAggregator: 2 }, { updateActive: false });
        const report = buildJobsPipelineSnapshot(new Set(['official-posting-scrape-test']), null, null);
        assert.match(report, /non-aggregator-apply-options 2 row\(s\)/u);
        resetManualScraperTelemetry();
        assert.equal(getManualScraperTelemetry().events.length, 0);
        const source = fs.readFileSync(new URL('../../electron/ipc/browser/manualScraper.js', import.meta.url), 'utf8');
        assert.match(source, /let googleApplyOptionsNonAggregator = 0/u);
        assert.match(source, /applyOptions\.some\([^\n]+googleApplyOptionsNonAggregator\+\+/u);
        assert.match(source, /enhanced\[i\] = \{[^\n]+applyOptions, salaryProvenance: 'unknown'/u);
      } finally {
        Object.assign(telemetry, { nodeId: saved.nodeId, windowId: saved.windowId, search: saved.search });
        Object.assign(scrape, saved.scrape);
      }
    },
  },
];
