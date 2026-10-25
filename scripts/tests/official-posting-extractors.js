import assert from 'node:assert/strict';
import { extractJobPostingBaseSalary, extractJobPostingDescription, walkJsonLdJobPostings } from '../../electron/extractors/apiExtractors.js';
import { locationsCompatible } from '../../electron/ipc/officialPostingMatch.js';
import {
  extractAshbyPostings, extractGreenhousePostings, extractJsonLdPostings, extractLeverPostings,
  extractOfficialPostingCandidates, extractTeamtailorRss, officialDescriptionText, scanOfficialCareersPage,
} from '../../electron/ipc/officialPostingExtractors.js';

const sourceUrl = 'https://careers.northwind.example/jobs/alpha-7';
const json = value => JSON.stringify(value);
const page = value => `<html><script type="application/ld+json">${json(value)}</script></html>`;
const node = extra => ({
  '@type': 'JobPosting', title: 'Dispatch Systems Engineer',
  hiringOrganization: { '@type': 'Organization', name: 'Northwind Labs', sameAs: 'https://northwind.example' },
  description: '<p>Build dependable dispatch services.</p><p>Coordinate <strong>release reviews</strong> &amp; support rosters.</p>',
  jobLocation: { '@type': 'Place', address: { addressLocality: 'Lakeview', addressRegion: 'Ontario', addressCountry: 'Canada' } },
  baseSalary: { '@type': 'MonetaryAmount', currency: 'CAD', value: { minValue: 117000, maxValue: 139000, unitText: 'YEAR' } },
  identifier: { '@type': 'PropertyValue', name: 'requisition', value: 'alpha-7' }, validThrough: '2050-12-31', ...extra,
});

export default [
  {
    name: 'Official JSON-LD walk returns every nested normalized posting and preserves raw callback short-circuit behavior',
    run() {
      const first = node(); const second = node({ title: 'Roster Engineer', '@type': ['Thing', 'JobPosting'] });
      const third = node({ title: 'Release Engineer', '@type': 'https://schema.org/JobPosting' });
      const html = `<script type="application/ld+json">bad json</script><script data-safe="yes" TYPE = 'application/ld+json'>${json({ '@graph': [first, { mainEntity: [second, third] }] })}</script>`;
      const all = walkJsonLdJobPostings(html);
      assert.deepEqual(all.map(item => item.title), [first.title, second.title, third.title]);
      assert.deepEqual(all[0].hiringOrganization, { name: first.hiringOrganization.name, sameAs: first.hiringOrganization.sameAs });
      for (const key of ['jobLocation', 'baseSalary', 'identifier', 'validThrough', 'description']) assert.deepEqual(all[0][key], first[key]);
      let seen = 0;
      assert.equal(walkJsonLdJobPostings(html, raw => { seen += 1; assert.equal(raw['@type'], first['@type']); return false; }), false);
      assert.equal(seen, 1);
      assert.equal(extractJobPostingDescription(html), first.description);
      assert.deepEqual(extractJobPostingBaseSalary(html), first.baseSalary);
      assert.equal(walkJsonLdJobPostings('<p>No structured posting.</p>', () => undefined), undefined);
      assert.deepEqual(walkJsonLdJobPostings('<script type="application/ld+json">{</script>'), []);
    },
  },
  {
    name: 'Official JSON-LD candidates retain structured identity, location, salary, expiry and host-fetched source',
    run() {
      const [found] = extractJsonLdPostings(page(node({ url: `${sourceUrl}#details` })), { sourceUrl, now: Date.UTC(2030, 0, 1) });
      assert.equal(found.employer, 'Northwind Labs');
      assert.equal(found.sameAs, 'https://northwind.example');
      assert.equal(found.identifier, 'alpha-7');
      assert.equal(found.location.display, 'Lakeview, Ontario, Canada');
      assert.equal(found.location.workMode, '');
      assert.equal(found.salary.provenance, 'posted');
      assert.equal(found.salary.text, 'CAD 117000 - 139000/yr');
      assert.equal(found.sourceUrl, sourceUrl);
      assert.equal(found.officialApplyUrl, sourceUrl, 'a schema URL never changes which page the host actually fetched');
      assert.ok(found.description.includes('release reviews & support rosters'));
      assert.equal(found.live, true);
      const [closed] = extractJsonLdPostings(page(node({ validThrough: '2000-01-01' })), { sourceUrl });
      assert.equal(closed.live, false);
      const [remote] = extractJsonLdPostings(page(node({ jobLocation: null, jobLocationType: 'TELECOMMUTE', applicantLocationRequirements: [{ name: 'Canada' }] })), { sourceUrl });
      assert.equal(remote.location.remote, true);
      assert.equal(remote.location.remoteCountry, 'Canada');
    },
  },
  {
    name: 'Official typed country fields normalize country-equivalent regions without erasing provinces or conflicts',
    run() {
      const extractLocation = (addressRegion, addressCountry) => extractJsonLdPostings(page(node({
        jobLocation: { '@type': 'Place', address: { addressLocality: 'Lakeview', addressRegion, addressCountry } },
      })), { sourceUrl })[0].location;
      for (const [region, country, expected] of [
        ['Canada', 'CA', 'Lakeview, Canada'],
        ['canada', { name: 'Canada' }, 'Lakeview, Canada'],
        ['United States', 'US', 'Lakeview, United States'],
        ['USA', { name: 'United States' }, 'Lakeview, United States'],
        ['Ontario', 'CA', 'Lakeview, Ontario, Canada'],
        ['CA', 'US', 'Lakeview, CA, United States'],
        ['Ontario', 'US', 'Lakeview, Ontario, United States'],
        ['California', 'CA', 'Lakeview, California, Canada'],
      ]) assert.equal(extractLocation(region, country).display, expected);
      const canadian = extractLocation('Canada', 'CA');
      const american = extractLocation('United States', 'US');
      assert.equal(locationsCompatible({ location: 'Lakeview, Canada' }, { location: canadian }), true);
      assert.equal(locationsCompatible({ location: 'Lakeview, United States' }, { location: american }), true);
      assert.equal(locationsCompatible({ location: 'Riverton, Canada' }, { location: canadian }), false);
      assert.equal(locationsCompatible({ location: 'Lakeview, United States' }, { location: canadian }), false);
      assert.equal(locationsCompatible({ location: 'Lakeview, Canada' }, { location: american }), false);
      assert.equal(locationsCompatible({ location: 'Lakeview, United States' }, { location: extractLocation('Ontario', 'US') }), false);
      assert.equal(locationsCompatible({ location: 'Lakeview, Canada' }, { location: extractLocation('California', 'CA') }), false);
    },
  },
  {
    name: 'Related JSON-LD jobs never overwrite or lend description text to the fetched posting',
    run() {
      const main = node({ url: `${sourceUrl}?utm_source=board`, description: '<p>Maintain dispatch services.</p>' });
      const related = node({ url: 'https://careers.northwind.example/jobs/beta-8', identifier: 'beta-8', title: 'Release Systems Engineer', description: '<p>A different and much longer description for an unrelated posting with different responsibilities.</p>' });
      const [found] = extractJsonLdPostings(page([main, related]), { sourceUrl });
      assert.equal(found.identifier, 'alpha-7');
      assert.equal(found.title, main.title);
      assert.equal(found.description, 'Maintain dispatch services.');
      assert.deepEqual(extractJsonLdPostings(page([node(), node({ title: 'Other Engineer' })]), { sourceUrl }), [],
        'multiple unbound nodes stand down rather than selecting by order');
      assert.deepEqual(extractJsonLdPostings(page(related), { sourceUrl }), [],
        'one explicit foreign posting URL does not describe this fetched page');
      assert.deepEqual(extractJsonLdPostings(page([main, { ...main, description: '<p>Conflicting body.</p>' }]), { sourceUrl }), [],
        'conflicting nodes claiming the same URL are ambiguous');
      assert.equal(extractJsonLdPostings(page([main, main]), { sourceUrl }).length, 1,
        'identical repeated structured nodes denote one posting');
    },
  },
  {
    name: 'Ashby structured board fields preserve locations, compensation provenance, liveness and employer uncertainty',
    run() {
      const body = json({ jobs: [{ id: 'dispatch-1', title: 'Dispatch Systems Engineer', location: 'Lakeview, Canada',
        secondaryLocations: [{ location: 'Harbor, Canada' }], workplaceType: 'Hybrid', isListed: true,
        jobUrl: 'https://jobs.ashbyhq.com/northwind/dispatch-1', applyUrl: 'https://jobs.ashbyhq.com/northwind/dispatch-1/application',
        descriptionPlain: 'Maintain dependable dispatch services and release reviews.', descriptionHtml: '<p>A different HTML representation.</p>',
        shouldDisplayCompensationOnJobPostings: true, compensation: { scrapeableCompensationSalarySummary: 'CAD 117000 - 139000 annually' },
      }, { id: 'dispatch-2', title: 'Release Systems Engineer', jobUrl: 'https://jobs.ashbyhq.com/northwind/dispatch-2',
        descriptionPlain: 'Maintain the release service.', isListed: false, shouldDisplayCompensationOnJobPostings: false,
        compensation: { scrapeableCompensationSalarySummary: 'CAD 123000 annually' } }] });
      const rows = extractAshbyPostings(body);
      assert.equal(rows.length, 2);
      assert.equal(rows[0].employer, '', 'an ATS tenant is never expanded into an employer name');
      assert.equal(rows[0].tenant, 'northwind');
      assert.equal(rows[0].description, 'Maintain dependable dispatch services and release reviews.');
      assert.equal(rows[0].location.display, 'Lakeview, Canada | Harbor, Canada');
      assert.equal(rows[0].location.workMode, 'hybrid');
      assert.equal(rows[0].salary.provenance, 'posted');
      assert.equal(rows[1].live, false);
      assert.deepEqual(rows[1].salary, { text: '', provenance: 'unknown' });
      assert.equal(extractAshbyPostings(body, { employer: 'Northwind Labs' })[0].employer, 'Northwind Labs');
      assert.deepEqual(extractAshbyPostings('{bad'), []);
    },
  },
  {
    name: 'Greenhouse structured content decodes markup and only structured pay ranges are posted salary',
    run() {
      const job = { id: 17, requisition_id: 'dispatch-17', title: 'Dispatch Systems Engineer', company_name: 'Northwind Labs',
        absolute_url: 'https://boards.greenhouse.io/northwind/jobs/17', location: { name: 'Lakeview, Canada' },
        content: '&lt;p&gt;Maintain dispatch &amp;amp; release services.&lt;/p&gt;',
        pay_input_ranges: [{ min_cents: 11700000, max_cents: 13900000, currency_type: 'CAD', interval: 'YEAR' }] };
      const [found] = extractGreenhousePostings(json({ jobs: [job] }));
      assert.equal(found.description, 'Maintain dispatch & release services.');
      assert.equal(found.identifier, 'dispatch-17');
      assert.deepEqual(found.salary, { text: 'CAD 117000 - 139000/yr', provenance: 'posted' });
      const [noRange] = extractGreenhousePostings(json({ ...job, pay_input_ranges: [], content: '<p>Pay could be $100000.</p>' }));
      assert.equal(noRange.salary.provenance, 'unknown', 'description prose never becomes a structured salary anchor');
      assert.deepEqual(extractGreenhousePostings(json({ jobs: [{ title: 'Missing source URL' }] })), []);
    },
  },
  {
    name: 'Lever posting lists assemble every documented description section and structured salary range',
    run() {
      const body = json([{ id: 'release-9', text: 'Release Systems Engineer', categories: { location: 'Lakeview, Canada', allLocations: ['Harbor, Canada'] }, workplaceType: 'remote',
        hostedUrl: 'https://jobs.lever.co/northwind/release-9', applyUrl: 'https://jobs.lever.co/northwind/release-9/apply',
        openingPlain: 'A dispatch role.', descriptionBodyPlain: 'Maintain release services.',
        lists: [{ text: 'Responsibilities', content: '<ul><li>Review releases.</li><li>Support dispatch.</li></ul>' }],
        additionalPlain: 'Coordinate the on-call roster.', salaryRange: { min: 117000, max: 139000, currency: 'CAD', interval: 'YEAR' } }]);
      const [found] = extractLeverPostings(body, { employer: 'Northwind Labs' });
      for (const text of ['A dispatch role.', 'Maintain release services.', 'Responsibilities', 'Review releases.', 'Support dispatch.', 'Coordinate the on-call roster.']) assert.ok(found.description.includes(text));
      assert.equal(found.salary.provenance, 'posted');
      assert.equal(found.tenant, 'northwind');
      assert.equal(found.location.remote, true);
      assert.equal(found.officialApplyUrl, 'https://jobs.lever.co/northwind/release-9/apply');
      assert.deepEqual(extractLeverPostings(json({ unexpected: [] })), []);
    },
  },
  {
    name: 'Teamtailor RSS preserves full description and explicit locations while page JSON-LD supplies structured salary',
    run() {
      const feed = `<rss xmlns:tt="https://teamtailor.com/locations"><channel><item><title>Dispatch Systems Engineer</title><link>${sourceUrl}</link><guid>dispatch-7</guid><remoteStatus>hybrid</remoteStatus><description><![CDATA[<p>Maintain dispatch services and release reviews.</p><p>Pay range discussed during interviews.</p>]]></description><tt:locations><tt:location><tt:name>Lakeview</tt:name><tt:city>Lakeview</tt:city><tt:country>Canada</tt:country></tt:location><tt:location><tt:city>Harbor</tt:city><tt:country>Canada</tt:country></tt:location></tt:locations></item></channel></rss>`;
      const [rss] = extractTeamtailorRss(feed, { sourceUrl: 'https://careers.northwind.example/jobs.rss', employer: 'Northwind Labs' });
      assert.ok(rss.description.includes('Pay range discussed during interviews.'));
      assert.equal(rss.location.display, 'Lakeview, Canada | Harbor, Canada');
      assert.equal(rss.location.workMode, 'hybrid');
      assert.equal(rss.salary.provenance, 'unknown');
      const [detail] = extractOfficialPostingCandidates({ body: page(node()), sourceUrl, contentType: 'text/html', ats: 'teamtailor' });
      assert.equal(detail.salary.provenance, 'posted');
      assert.deepEqual(extractTeamtailorRss('<rss><broken>'), []);
      assert.deepEqual(extractTeamtailorRss('<!DOCTYPE rss [<!ENTITY external SYSTEM "https://unrelated.example/data">]><rss/>'), []);
    },
  },
  {
    name: 'Careers scans retain only actual anchor, script and iframe HTTPS links and identify Teamtailor custom domains',
    run() {
      const html = `<title>Northwind Labs</title><meta property="og:site_name" content="Northwind Labs"><base href="https://unrelated.example/"><a href="https://jobs.ashbyhq.com/northwind">Jobs</a><a href="/jobs/alpha-7#details">Role</a><a href="/jobs/alpha-7">Duplicate</a><script src="https://cdn1.teamtailor-cdn.com/assets/site.js"></script><iframe src="https://boards.greenhouse.io/northwind"></iframe><a href="javascript:alert(1)">Unsafe</a><a href="http://unrelated.example/job">HTTP</a><script>globalThis.officialExtractorExecuted = true;</script>`;
      const scan = scanOfficialCareersPage(html, 'https://careers.northwind.example/');
      assert.equal(scan.siteName, 'Northwind Labs');
      assert.equal(scan.title, 'Northwind Labs');
      assert.equal(scan.teamtailor, true);
      assert.deepEqual(scan.links.map(link => link.url), ['https://jobs.ashbyhq.com/northwind', sourceUrl, 'https://cdn1.teamtailor-cdn.com/assets/site.js', 'https://boards.greenhouse.io/northwind']);
      assert.deepEqual(scan.links.map(link => link.tag), ['a', 'a', 'script', 'iframe']);
      assert.equal(globalThis.officialExtractorExecuted, undefined);
    },
  },
  {
    name: 'Careers scans ignore CSS parsing and preserve inert HTML link, metadata and template semantics',
    run() {
      const html = `<!doctype html><html><head><title>Northwind &amp; Co</title><title>Later title</title>
        <meta property="og:site_name" content="Northwind &amp; Co"><meta property="og:site_name" content="Later name">
        <base href="https://unrelated.example/"><style>@import url(https://unrelated.example/remote.css);</style></head><body>
        <button style="background:transparent;cursor:pointer;background-color:blue">Careers</button>
        <a data-label="quoted > marker" style="background:transparent;cursor:pointer;background-color:blue" href="/jobs/alpha-7?team=dispatch&amp;mode=onsite#details">Role</a>
        <template><a href="https://unrelated.example/template">Inert link</a><meta property="og:site_name" content="Inert name"></template>
        <noscript><a href="/jobs/backup">Script-disabled link</a></noscript>
        <script src="/assets/careers.js">globalThis.officialExtractorExecuted = true; const fake = '<a href="https://unrelated.example/script">';</script>
        <iframe src="https://boards.greenhouse.io/northwind"></iframe>
        <svg xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="https://unrelated.example/namespaced">Namespaced link</a></svg>
        <a href="javascript:alert(1)">Unsafe</a><a href="https://user:pass@unrelated.example/job">Credentials</a>
        <a href="/jobs/alpha-7?team=dispatch&amp;mode=onsite">Duplicate</a></body></html>`;
      const scan = scanOfficialCareersPage(html, 'https://careers.northwind.example/');
      assert.equal(scan.siteName, 'Northwind & Co');
      assert.equal(scan.title, 'Northwind & Co');
      assert.equal(scan.teamtailor, false);
      assert.deepEqual(scan.links, [
        { url: `${sourceUrl}?team=dispatch&mode=onsite`, tag: 'a', attribute: 'href' },
        { url: 'https://careers.northwind.example/jobs/backup', tag: 'a', attribute: 'href' },
        { url: 'https://careers.northwind.example/assets/careers.js', tag: 'script', attribute: 'src' },
        { url: 'https://boards.greenhouse.io/northwind', tag: 'iframe', attribute: 'src' },
      ]);
      assert.equal(globalThis.officialExtractorExecuted, undefined);
      assert.deepEqual(scanOfficialCareersPage('<title></title><title>Later title</title><meta property="og:site_name"><meta property="og:site_name" content="Later name">', sourceUrl),
        { links: [], siteName: '', title: '', teamtailor: false }, 'first matching empty metadata remains authoritative');
      assert.throws(() => scanOfficialCareersPage('x'.repeat(3 * 1024 * 1024 + 1), sourceUrl), /bounded raw text/);
      assert.throws(() => scanOfficialCareersPage('unsafe\0markup', sourceUrl), /bounded raw text/);
    },
  },
  {
    name: 'Official dispatch handles Ashby HTML separately and Workday or iCIMS only through static JSON-LD',
    run() {
      for (const [ats, url] of [['ashby', 'https://jobs.ashbyhq.com/northwind/alpha-7'], ['workday', 'https://northwind.wd3.myworkdayjobs.com/Careers/job/alpha-7'], ['icims', 'https://northwind.icims.com/jobs/17/job']]) {
        const found = extractOfficialPostingCandidates({ body: page(node()), sourceUrl: url, contentType: 'text/html', ats });
        assert.equal(found.length, 1, ats);
        assert.equal(found[0].ats, ats);
        assert.deepEqual(extractOfficialPostingCandidates({ body: '<h1>Dispatch Engineer</h1><script>window.jobs={title:"Dispatch Engineer"}</script>', sourceUrl: url, contentType: 'text/html', ats }), [], ats);
      }
    },
  },
  {
    name: 'Structured unreadable postings retain link-verification metadata without inventing description text',
    run() {
      const [stub] = extractJsonLdPostings(page(node({ description: undefined })), { sourceUrl });
      assert.equal(stub.description, '');
      assert.equal(stub.title, 'Dispatch Systems Engineer');
      assert.equal(stub.employer, 'Northwind Labs');
      assert.equal(stub.identifier, 'alpha-7');
      const [apiStub] = extractAshbyPostings(json({ jobs: [{ id: 'alpha-7', title: 'Dispatch Engineer', jobUrl: 'https://jobs.ashbyhq.com/northwind/alpha-7' }] }));
      assert.equal(apiStub.description, '');
      assert.equal(apiStub.sourceUrl, 'https://jobs.ashbyhq.com/northwind/alpha-7');
    },
  },
  {
    name: 'Official parsers reject malformed, oversized, unsafe and deeply nested source data without clipping',
    run() {
      assert.equal(officialDescriptionText('<p>Dispatch &amp; releases.</p><script>steal()</script><style>secret</style>'), 'Dispatch & releases.');
      assert.throws(() => officialDescriptionText('x'.repeat(3 * 1024 * 1024 + 1)), /bounded raw text/);
      assert.throws(() => officialDescriptionText('<div>'.repeat(60) + 'Dispatch' + '</div>'.repeat(60)), /deeply nested/);
      assert.deepEqual(extractJsonLdPostings(page(node()), { sourceUrl: 'http://careers.northwind.example/job' }), []);
      assert.deepEqual(extractJsonLdPostings(page(node({ title: '' })), { sourceUrl }), []);
      const [badRange] = extractJsonLdPostings(page(node({ baseSalary: { currency: 'CAD', value: { minValue: 139000, maxValue: 117000, unitText: 'YEAR' } } })), { sourceUrl });
      assert.equal(badRange.salary.provenance, 'unknown');
      const [coercibleRange] = extractJsonLdPostings(page(node({ baseSalary: { currency: 'CAD', value: { minValue: false, maxValue: [], unitText: 'YEAR' } } })), { sourceUrl });
      assert.equal(coercibleRange.salary.provenance, 'unknown', 'arrays and booleans cannot become zero-valued salary facts');
      assert.throws(() => extractAshbyPostings(json({ jobs: [{ title: 'Dispatch Engineer', jobUrl: sourceUrl, descriptionPlain: 'Dispatch\0service' }] })), /bounded raw text/);
      assert.throws(() => extractJsonLdPostings('\0', { sourceUrl }), /bounded raw text/);
    },
  },
];
