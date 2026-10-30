import assert from 'node:assert/strict';
import { resolveOfficialPosting } from '../../electron/ipc/officialPostingResolver.js';
import { officialPostingLookupStatus } from '../../electron/ipc/officialPostingFields.js';
import { extractOfficialPostingVendorCandidates, officialPostingVendorAdapterUrl, officialPostingVendorRoute } from '../../electron/ipc/officialPostingVendorAdapters.js';
import { retainedRecheckTrail } from '../../electron/ipc/officialPostingRefresh.js';

const description = 'Requirements include experience building reliable services and maintaining reporting workflows. Engineers design clear interfaces for dispatch teams and validate operational changes with careful review. The role includes improving data quality across scheduled pipelines and documenting decisions for partner teams. You will work with colleagues to investigate delivery failures and make service behavior understandable. Responsibilities include writing tests for new features and improving the tools used by support teams every day.';
const row = (extra = {}) => ({ title: 'Software Engineer', company: 'Northwind Labs', location: 'Lakeview, Ontario, Canada', snippet: description,
  url: 'https://www.linkedin.com/jobs/view/synthetic-2', salaryProvenance: 'unknown', ...extra });
const jsonld = (extra = {}) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Software Engineer',
  hiringOrganization: { name: 'Northwind Labs' }, description,
  jobLocation: { address: { addressLocality: 'Lakeview', addressRegion: 'Ontario', addressCountry: 'Canada' } }, identifier: 'req-one', ...extra })}</script>`;
/** A page entry may carry `url` to model an HTTP redirect: the response's final URL differs from the requested one. */
function network(pages, requests = []) {
  return async url => {
    requests.push(url);
    const page = pages[url];
    if (!page) { const error = new Error('Unavailable'); error.code = 'closed'; throw error; }
    return { url, contentType: 'text/html', statusCode: 200, ...(typeof page === 'string' ? { body: page } : page) };
  };
}
const admissionOnly = offered => async (_job, options) => {
  offered.push(options);
  return { choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['Source admission only.'] };
};
const ashbyBoard = 'https://api.ashbyhq.com/posting-api/job-board/northwind?includeCompensation=true';
const ashbyPosting = 'https://jobs.ashbyhq.com/northwind/req-one';
const ashbyJobs = JSON.stringify({ jobs: [{ id: 'req-one', title: 'Software Engineer', location: 'Lakeview, Ontario, Canada',
  jobUrl: ashbyPosting, applyUrl: `${ashbyPosting}/application`, descriptionPlain: description, isListed: true }] });

export default [
  {
    name: 'A proved employer host\'s bare careers path redirecting to another careers domain attests that domain; other redirects do not',
    async run() {
      for (const mode of ['valid', 'query', 'unproven-root', 'aggregator', 'shared-platform']) {
        // A shared platform's apex carries no employer brand, so one employer's redirect there must not make the platform theirs.
        const site = mode === 'shared-platform' ? 'https://www.pagesite.test/' : 'https://northwindjobs.test/';
        const posting = `${site}jobs/123/software-engineer/`;
        const requested = mode === 'query' ? 'https://northwind.test/careers?next=https%3A%2F%2Fnorthwindjobs.test%2F' : 'https://northwind.test/careers';
        const target = mode === 'aggregator' ? 'https://www.linkedin.com/company/northwind/jobs/' : site;
        const pages = {
          'https://northwind.test/': mode === 'unproven-root' ? '<title>Unrelated Holdings</title>' : '<title>Northwind Labs</title>',
          [requested]: { url: target, body: `<title>Northwind Labs Careers</title><a href="${posting}">Software Engineer</a>` },
          [site]: '<title>Northwind Labs Careers</title>',
          [posting]: jsonld({ url: posting }),
        };
        const offered = [];
        const result = await resolveOfficialPosting(row(), { semanticMatching: true, researchRan: true, persistResults: false, store: null,
          candidateUrls: [{ postingUrl: posting, careersPageUrl: requested, employerDomain: 'https://northwind.test' }],
          fetch: network(pages), match: admissionOnly(offered) });
        if (mode === 'valid') {
          assert.equal(offered.length, 2, mode);
          assert.ok(offered.every(options => options.some(option => option.sourceUrl === posting && option.candidate.employerDomainProven)), mode);
        } else {
          assert.equal(offered.length, 0, mode);
          assert.ok(result.officialPosting.trail.includes('source-unproven'), mode);
        }
      }
    },
  },
  {
    name: 'A brand-domain root that names no careers page has its conventional careers path read; where it leads must prove itself',
    async run() {
      for (const mode of ['valid', 'other-brand', 'target-unproven']) {
        const legacy = mode === 'other-brand' ? 'https://acme.tv/' : 'https://northwind.tv/';
        const pages = {
          // The legacy root's title is not the employer's exact name, so it proves nothing by itself.
          [legacy]: '<title>Northwind TV</title><div id="app"></div>',
          [`${legacy}careers`]: { url: 'https://northwind.test/careers', body: `<a href="https://jobs.ashbyhq.com/northwind">Open roles</a>` },
          'https://northwind.test/': mode === 'target-unproven' ? '<title>Unrelated Holdings</title>' : '<title>Northwind Labs</title>',
          'https://northwind.test/careers': '<a href="https://jobs.ashbyhq.com/northwind">Open roles</a>',
          [ashbyPosting]: jsonld({ url: ashbyPosting }),
          [ashbyBoard]: { body: ashbyJobs, contentType: 'application/json' },
        };
        const requests = []; const offered = [];
        await resolveOfficialPosting(row(), { semanticMatching: true, researchRan: true, persistResults: false, store: null,
          candidateUrls: [{ postingUrl: ashbyPosting, employerDomain: legacy }], fetch: network(pages, requests), match: admissionOnly(offered) });
        assert.equal(requests.includes(`${legacy}careers`), mode !== 'other-brand', `${mode}: the conventional path is read only on a brand root`);
        if (mode === 'valid') {
          assert.equal(offered.length, 2, mode);
          assert.ok(offered.every(options => options.some(option => option.sourceUrl === ashbyPosting && option.candidate.tenantProven)), mode);
        } else assert.equal(offered.length, 0, mode);
      }
    },
  },
  {
    name: 'A missing conventional careers page is navigation only and leaves no failure or closed evidence',
    async run() {
      const requests = [];
      const result = await resolveOfficialPosting(row(), { semanticMatching: true, researchRan: true, persistResults: false, store: null,
        candidateUrls: ['https://northwind.test/'], fetch: network({ 'https://northwind.test/': '<title>Northwind Labs</title>' }, requests),
        match: admissionOnly([]) });
      assert.ok(requests.includes('https://northwind.test/careers'));
      assert.ok(!result.officialPosting.trail.includes('closed'));
      assert.ok(!(result.officialPosting.fetchFailures || []).some(failure => failure.url === 'https://northwind.test/careers'));
      // A page that exists but failed to load is still unread coverage, guessed path or not.
      const transient = await resolveOfficialPosting(row(), { semanticMatching: true, researchRan: true, persistResults: false, store: null,
        candidateUrls: ['https://northwind.test/'], match: admissionOnly([]), fetch: async url => {
          if (url === 'https://northwind.test/') return { url, contentType: 'text/html', statusCode: 200, body: '<title>Northwind Labs</title>' };
          const error = new Error('Unavailable'); error.code = 'fetch-failed'; error.reason = 'server-error'; error.statusCode = 503; throw error;
        } });
      assert.ok(transient.officialPosting.trail.includes('fetch-failed'));
      assert.ok((transient.officialPosting.fetchFailures || []).some(failure => failure.url === 'https://northwind.test/careers'));
    },
  },
  {
    name: 'Gem board roots read the public board listing, and only posts naming their own page on that board are kept',
    run() {
      const listing = 'https://api.gem.com/job_board/v0/northwind/job_posts/';
      assert.deepEqual(officialPostingVendorRoute(listing), { ats: 'gem', tenant: 'northwind' });
      assert.equal(officialPostingVendorRoute(`${listing}?board=other`), null);
      assert.equal(officialPostingVendorAdapterUrl({ ats: 'gem', tenant: 'northwind' }, 'https://jobs.gem.com/northwind'), listing);
      const id = '8607b6ab-5488-41f4-a82b-58636df788f6'; const other = '11111111-2222-3333-4444-555555555555';
      const body = JSON.stringify([
        { id, absolute_url: `https://jobs.gem.com/northwind/${id}`, title: 'Software Engineer', content_plain: description,
          requisition_id: '2359', location: { name: 'Lakeview, Canada' }, location_type: 'hybrid', offices: [{ location: { name: 'Lakeview, Canada' } }] },
        { id: other, absolute_url: `https://jobs.gem.com/someone-else/${other}`, title: 'Software Engineer', content_plain: description },
        { id: other, absolute_url: `https://jobs.gem.com/northwind/${id}`, title: 'Software Engineer', content_plain: description },
      ]);
      const found = extractOfficialPostingVendorCandidates({ body, sourceUrl: listing, employer: 'Northwind Labs' });
      assert.equal(found.length, 1);
      assert.equal(found[0].sourceUrl, `https://jobs.gem.com/northwind/${id}`);
      assert.equal(found[0].identifier, '2359');
      assert.equal(found[0].location.display, 'Lakeview, Canada');
      assert.equal(found[0].employer, 'Northwind Labs');
    },
  },
  {
    name: 'A careers page and its index.html redirect twin use one render slot',
    async run() {
      const rendered = [];
      const pages = {
        'https://northwind.test/': '<title>Northwind Labs</title><a href="/careers/">Careers</a><a href="/about/careers">About careers</a>',
        'https://northwind.test/careers/': '<div id="app"></div>',
        'https://northwind.test/about/careers': { url: 'https://northwind.test/careers/index.html', body: '<div id="app"></div>' },
        'https://northwind.test/careers/team.html': '<div id="app"></div>',
      };
      await resolveOfficialPosting(row(), { semanticMatching: true, researchRan: true, persistResults: false, store: null,
        candidateUrls: ['https://northwind.test/'], fetch: network(pages), match: admissionOnly([]),
        render: async url => { rendered.push(url); return { url, statusCode: 200, contentType: 'text/html', rendered: true,
          body: '<a href="/careers/team.html">Team</a>' }; } });
      assert.equal(rendered.filter(url => /\/careers\/(?:index\.html)?$/u.test(url)).length, 1, rendered.join(','));
    },
  },
  {
    name: 'The employer page carrying the lead posting\'s requisition id is read before general careers pages',
    async run() {
      const posting = 'https://job-boards.greenhouse.io/northwind/jobs/8783813';
      const mirror = 'https://northwind.test/careers/single-job.html?job_id=8783813';
      const general = Array.from({ length: 10 }, (_, at) => `https://northwind.test/careers/page-${at}.html`);
      const careers = 'https://northwind.test/careers/';
      const pages = {
        'https://northwind.test/': '<title>Northwind Labs</title><a href="/careers/">Careers</a>',
        [careers]: `${general.map(url => `<a href="${url}">More</a>`).join('')}<a href="${mirror}">Software Engineer</a>`,
        ...Object.fromEntries([...general, mirror].map(url => [url, '<div id="app"></div>'])),
      };
      const requests = [];
      await resolveOfficialPosting(row(), { semanticMatching: true, researchRan: true, persistResults: false, store: null,
        candidateUrls: [{ postingUrl: posting, careersPageUrl: careers }], fetch: network(pages, requests), match: admissionOnly([]) });
      const at = requests.indexOf(mirror);
      assert.ok(at >= 0, 'the mirror page is read');
      assert.ok(general.every(url => !requests.includes(url) || requests.indexOf(url) > at), requests.join('\n'));
    },
  },
  {
    name: 'A sample job page from a proved script-built listing reveals the employer board, which is then read whole',
    async run() {
      const careers = 'https://northwind.test/careers/';
      const jobs = Array.from({ length: 20 }, (_, at) => `https://northwind.test/careers/single-job.html?job_id=${500000 + at}`);
      const general = Array.from({ length: 8 }, (_, at) => `https://northwind.test/careers/about-${at}.html`);
      const listing = 'https://boards-api.greenhouse.io/v1/boards/northwind/jobs?content=true';
      const posting = 'https://job-boards.greenhouse.io/northwind/jobs/777777';
      const pages = {
        'https://northwind.test/': '<title>Northwind Labs</title><a href="/careers/">Careers</a>',
        [careers]: [...general, ...jobs].map(url => `<a href="${url}">Open</a>`).join(''),
        ...Object.fromEntries([...general, ...jobs].map(url => [url, '<div id="app"></div>'])),
        [listing]: { contentType: 'application/json', body: JSON.stringify({ jobs: [{ id: 777777, title: 'Software Engineer',
          absolute_url: posting, location: { name: 'Lakeview, Ontario, Canada' }, content: description, company_name: 'Northwind Labs' }] }) },
      };
      const requests = []; const offered = [];
      await resolveOfficialPosting(row(), { semanticMatching: true, researchRan: true, persistResults: false, store: null,
        candidateUrls: [{ careersPageUrl: careers, employerDomain: 'https://northwind.test' }], fetch: network(pages, requests),
        render: async url => ({ url, statusCode: 200, contentType: 'text/html', rendered: true,
          body: url === careers ? pages[careers] : `<a href="https://job-boards.greenhouse.io/northwind/jobs/${new URL(url).searchParams.get('job_id') || 1}">Apply</a>` }),
        match: admissionOnly(offered) });
      assert.ok(requests.includes(jobs[0]), 'one job page from the listing is read');
      assert.ok(requests.includes(listing), 'the board the job page names is read whole');
      assert.ok(requests.indexOf(listing) < Math.min(...general.map(url => requests.indexOf(url)).filter(at => at >= 0)), requests.join('\n'));
      assert.equal(offered.length, 2);
      assert.ok(offered[0].some(option => option.sourceUrl === posting && option.candidate.tenantProven));
    },
  },
  {
    name: 'A failed recheck keeps the verified record\'s proof codes but reports the latest run\'s own reason',
    run() {
      const prior = { level: 'L2', outcome: 'found', employer: 'Northwind Labs', sourceUrl: 'https://job-boards.greenhouse.io/northwind/jobs/1',
        officialApplyUrl: 'https://job-boards.greenhouse.io/northwind/jobs/1',
        trail: ['domain-proof', 'crawl-partial', 'crawl-budget', 'comparative-match', 'semantic-match-v1', 'reverify-failed', 'semantic-uncertain'] };
      for (const [codes, label] of [[['comparative-a-p1', 'comparative-b-p1', 'official-liveness-unconfirmed'], 'Official posting match uncertain'],
        [['comparative-a-p3', 'comparative-b-p1', 'semantic-uncertain'], 'Official posting match uncertain'],
        [['crawl-budget', 'source-unproven'], 'Employer source verification incomplete']]) {
        const trail = retainedRecheckTrail(prior, { level: 'L5', outcome: 'ambiguous', trail: codes });
        assert.equal(trail.at(-1), 'reverify-failed');
        for (const kept of ['domain-proof', 'comparative-match', 'semantic-match-v1', ...codes]) assert.ok(trail.includes(kept), kept);
        assert.equal(trail.filter(code => code === 'reverify-failed').length, 1);
        if (!codes.includes('crawl-budget')) assert.ok(!trail.includes('crawl-partial') && !trail.includes('crawl-budget'));
        const status = officialPostingLookupStatus({ ...prior, trail });
        assert.equal(status.label, 'Previously verified official posting');
        assert.ok(status.detail.startsWith(`Latest recheck: ${label}.`), status.detail);
      }
    },
  },
];
