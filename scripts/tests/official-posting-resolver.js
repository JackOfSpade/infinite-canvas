import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { freeOfficialPostingLeads, officialPostingChunks, officialPostingRequestId, resolveOfficialPosting } from '../../electron/ipc/officialPostingResolver.js';
import { createOfficialPostingStore, officialPostingView } from '../../electron/ipc/officialPostingStore.js';

const description = 'Requirements include experience building reliable services and maintaining reporting workflows. Engineers design clear interfaces for dispatch teams and validate operational changes with careful review. The role includes improving data quality across scheduled pipelines and documenting decisions for partner teams. You will work with colleagues to investigate delivery failures and make service behavior understandable. Responsibilities include writing tests for new features and improving the tools used by support teams every day.';
const row = (extra = {}) => ({ title: 'Software Engineer at Northwind Labs', company: 'Acme Talent Partners', location: 'Lakeview, Ontario, Canada',
  snippet: `Our client is hiring. ${description}`, url: 'https://www.linkedin.com/jobs/view/synthetic-1', salaryProvenance: 'unknown', ...extra });
const jsonld = (extra = {}) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Software Engineer',
  hiringOrganization: { name: 'Northwind Labs', sameAs: 'https://northwind.test/' }, description,
  jobLocation: { address: { addressLocality: 'Lakeview', addressRegion: 'Ontario', addressCountry: 'Canada' } }, identifier: 'req-one', ...extra })}</script>`;
function network(pages, requests = []) {
  return async url => {
    requests.push(url);
    const page = pages[url];
    if (!page) { const error = new Error('Unavailable'); error.code = 'closed'; throw error; }
    return { url, contentType: 'text/html', statusCode: 200, ...(typeof page === 'string' ? { body: page } : page) };
  };
}
const boardUrl = 'https://api.ashbyhq.com/posting-api/job-board/northwind?includeCompensation=true';
const boardJob = (extra = {}) => ({ id: 'req-one', title: 'Software Engineer', location: 'Lakeview, Ontario, Canada',
  jobUrl: 'https://jobs.ashbyhq.com/northwind/req-one', applyUrl: 'https://jobs.ashbyhq.com/northwind/req-one/application',
  descriptionPlain: description, isListed: true, ...extra });
function careersPages(jobs = [boardJob()]) {
  return { 'https://northwind.test/': '<title>Northwind Labs</title><a href="/careers">Careers</a>',
    'https://northwind.test/careers': '<a href="https://jobs.ashbyhq.com/northwind">Open roles</a>',
    'https://jobs.ashbyhq.com/northwind': '<main>Available roles</main>',
    [boardUrl]: { body: JSON.stringify({ jobs }), contentType: 'application/json' } };
}

function teamtailorPages({ rssId = 'req-one', pageId = 'req-one' } = {}) {
  const url = 'https://careers.northwind.test/jobs/one';
  const feed = `<rss xmlns:tt="https://teamtailor.com/locations"><channel><item><title>Software Engineer</title><link>${url}</link><guid>${rssId}</guid><description><![CDATA[${description}]]></description><tt:locations><tt:location><tt:city>Lakeview</tt:city><tt:country>Canada</tt:country></tt:location></tt:locations></item></channel></rss>`;
  return { 'https://careers.northwind.test/': '<meta property="og:site_name" content="Northwind Labs"><footer>Powered by Teamtailor</footer>',
    'https://careers.northwind.test/jobs.rss': { body: feed, contentType: 'application/rss+xml' },
    [url]: `${jsonld({ url, identifier: pageId, description: 'A brief role summary.', baseSalary: {
      currency: 'CAD', value: { minValue: 117000, maxValue: 139000, unitText: 'YEAR' },
    } })}<footer>Powered by Teamtailor</footer>` };
}

export default [
  {
    name: 'Official posting resolver proves an explicitly named careers page by actual ATS links while root marketing stays unproven',
    async run() {
      const pages = careersPages();
      pages['https://northwind.test/'] = '<title>Northwind Labs | Build the future</title><a href="/careers">Careers</a>';
      pages['https://northwind.test/careers'] = '<title>Careers at Northwind Labs | Build the future</title><a href="https://jobs.ashbyhq.com/northwind">Open roles</a>';
      const result = await resolveOfficialPosting(row(), { fetch: network(pages), candidateUrls: ['https://northwind.test/'] });
      assert.equal(result.officialPosting.level, 'L2'); assert.equal(result.officialPosting.employer, 'Northwind Labs');
      assert.equal(result.officialPosting.officialApplyUrl, boardJob().applyUrl);
      assert.ok(result.officialPosting.trail.includes('domain-proof'));
      const sameHostUrl = 'https://northwind.test/jobs/one';
      const direct = { ...pages, [sameHostUrl]: jsonld({ hiringOrganization: { name: 'Northwind Labs' } }) };
      direct['https://northwind.test/careers'] = `<title>Careers at Northwind Labs | Build the future</title><a href="${sameHostUrl}">Open role</a>`;
      const own = await resolveOfficialPosting(row(), { fetch: network(direct), candidateUrls: [sameHostUrl, 'https://northwind.test/careers'] });
      assert.equal(own.officialPosting.level, 'L1', 'a fetched matching job also receives proof from the exact same-host careers link');
    },
  },
  {
    name: 'Official posting resolver refuses marketing titles, wrong careers identity, absent links and sibling-tenant proof transfer',
    async run() {
      const base = careersPages();
      base['https://northwind.test/'] = '<title>Northwind Labs | Build the future</title><a href="/careers">Careers</a>';
      const validTitle = '<title>Careers at Northwind Labs | Build the future</title>';
      for (const careers of [
        '<title>Northwind Labs | Careers and marketing</title><a href="https://jobs.ashbyhq.com/northwind">Open roles</a>',
        '<title>Careers at Northwind Labs Consulting | Build the future</title><a href="https://jobs.ashbyhq.com/northwind">Open roles</a>',
        `${validTitle}<p>https://jobs.ashbyhq.com/northwind</p>`,
        `${validTitle}<a href="/careers">Careers</a>`,
      ]) {
        const result = await resolveOfficialPosting(row(), { fetch: network({ ...base, 'https://northwind.test/careers': careers }),
          candidateUrls: ['https://northwind.test/', 'https://jobs.ashbyhq.com/northwind'] });
        assert.equal(result.officialPosting.level, 'L6', careers);
      }
      const sibling = { ...base, 'https://northwind.test/careers': `${validTitle}<a href="https://jobs.ashbyhq.com/northwind">Open roles</a>`,
        [boardUrl]: { body: JSON.stringify({ jobs: [boardJob({ jobUrl: 'https://jobs.ashbyhq.com/other/req-one' })] }), contentType: 'application/json' } };
      assert.equal((await resolveOfficialPosting(row(), { fetch: network(sibling), candidateUrls: ['https://northwind.test/careers'] })).officialPosting.level, 'L6');
      const wrongPath = { ...base, 'https://northwind.test/marketing': `${validTitle}<a href="https://jobs.ashbyhq.com/northwind">Open roles</a>` };
      delete wrongPath['https://northwind.test/careers'];
      assert.equal((await resolveOfficialPosting(row(), { fetch: network(wrongPath), candidateUrls: ['https://northwind.test/marketing'] })).officialPosting.level, 'L6');
    },
  },
  {
    name: 'Official posting resolver follows employer careers to an ATS and preserves every scraped identity field',
    async run() {
      const job = row(); const before = JSON.stringify(job); const requests = [];
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'official-resolver-'));
      try {
        const store = createOfficialPostingStore(path.join(root, 'official-postings'));
        const result = await resolveOfficialPosting(job, { fetch: network(careersPages(), requests),
          candidateUrls: ['https://northwind.test/'], store });
        assert.equal(result.officialPosting.level, 'L2'); assert.equal(result.officialPosting.employer, 'Northwind Labs');
        assert.equal(result.postedBy, 'Acme Talent Partners'); assert.equal(result.description, description);
        assert.equal(result.officialPosting.officialApplyUrl, 'https://jobs.ashbyhq.com/northwind/req-one/application');
        assert.equal(JSON.stringify(job), before); assert.equal('applyUrl' in result, false);
        const view = await officialPostingView({ ...job, officialPosting: result.officialPosting }, { store });
        assert.equal(view.description, description); assert.equal(view.title, 'Software Engineer');
        const again = await resolveOfficialPosting(job, { store, fetch: () => { throw new Error('cache must avoid fetch'); }, research: () => { throw new Error('cache must avoid AI'); } });
        assert.ok(again.officialPosting.trail.includes('cache-hit'));
        assert.equal(requests.includes(boardUrl), true);
      } finally { await fs.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'Official posting resolver never reuses a generic URL cache hit for a different title, scraped employer or city',
    async run() {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'official-cache-collision-'));
      try {
        const store = createOfficialPostingStore(path.join(root, 'official-postings'));
        const original = row({ title: 'Software Engineer', company: 'Northwind Labs', snippet: description, url: 'https://board.test/careers' });
        const first = await resolveOfficialPosting(original, { store, fetch: network(careersPages()), candidateUrls: ['https://northwind.test/'] });
        assert.equal(first.officialPosting.level, 'L2');
        for (const change of [{ title: 'Staff Engineer' }, { company: 'Other Labs' }, { location: 'Riverton, Alberta, Canada' }]) {
          let calls = 0;
          const job = { ...original, ...change };
          const result = await resolveOfficialPosting(job, { store, fetch: async () => { calls += 1; throw new Error('No verified new posting'); } });
          assert.equal(result.officialPosting.level, 'L5'); assert.equal(result.officialPosting.employer, job.company);
          assert.ok(calls > 0, 'a URL collision requires fresh verification');
        }
        assert.equal((await store.find(original)).officialPosting.level, 'L2', 'colliding saves leave the original role identity intact');
      } finally { await fs.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'Official posting resolver recomputes cached miss employer spelling and never extends its fixed twenty-four-hour retry time',
    async run() {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'official-cache-miss-')); let clock = 0;
      try {
        const store = createOfficialPostingStore(path.join(root, 'official-postings'), { now: () => clock });
        const job = row({ title: 'Software Engineer', company: 'Northwind Labs', snippet: description, url: 'https://board.test/careers' });
        await store.save(job, { officialPosting: { level: 'L5', outcome: 'not-found', employer: job.company } });
        clock = 23 * 60 * 60 * 1000;
        const current = { ...job, company: 'Northwind Labs Inc.' };
        const cached = await resolveOfficialPosting(current, { store, fetch: () => { throw new Error('A recent miss does not fetch'); } });
        assert.equal(cached.officialPosting.employer, current.company); assert.ok(cached.officialPosting.trail.includes('recent-miss'));
        assert.equal((await store.find(job)).savedAt, 0);
        clock = 25 * 60 * 60 * 1000; let researches = 0;
        await resolveOfficialPosting(current, { store, fetch: network({}), research: async () => { researches += 1; return []; } });
        assert.equal(researches, 1);
      } finally { await fs.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'Official posting resolver distinguishes employer-domain L1, structured ATS L3 and verified stub L4',
    async run() {
      const l1 = await resolveOfficialPosting(row({ company: 'Northwind Labs', title: 'Software Engineer', url: 'https://northwind.test/jobs/one' }), {
        fetch: network({ 'https://northwind.test/': '<title>Northwind Labs</title>', 'https://northwind.test/jobs/one': jsonld() }),
      });
      assert.equal(l1.officialPosting.level, 'L1');
      const portalUrl = 'https://www.usajobs.gov/job/123';
      const portal = await resolveOfficialPosting(row({ company: 'Northwind Labs', title: 'Software Engineer', url: portalUrl }), {
        fetch: network({ [portalUrl]: jsonld() }),
      });
      assert.equal(portal.officialPosting.level, 'L1');
      assert.equal(portal.officialPosting.employer, 'Northwind Labs');
      const url = 'https://jobs.lever.co/northwind/one';
      const l3 = await resolveOfficialPosting(row({ applyOptions: [{ label: 'Employer', href: url }] }), { fetch: network({ [url]: jsonld() }) });
      assert.equal(l3.officialPosting.level, 'L3'); assert.equal(l3.officialPosting.employer, 'Northwind Labs');
      const l4 = await resolveOfficialPosting(row({ identifier: 'req-one', applyOptions: [{ label: 'Employer', href: url }] }), {
        fetch: network({ [url]: jsonld({ description: 'A brief role summary.' }) }),
      });
      assert.equal(l4.officialPosting.level, 'L4'); assert.equal(l4.description, undefined);
      assert.equal(l4.officialPosting.officialApplyUrl, url);
    },
  },
  {
    name: 'Official posting resolver refuses sibling roles, city twins, duplicate matches and a foreign tenant hidden in a board response',
    async run() {
      for (const jobs of [
        [boardJob({ title: 'Forward Deployment Engineer' })],
        [boardJob({ location: 'Riverton, Alberta, Canada' })],
        [boardJob({ jobUrl: 'https://jobs.ashbyhq.com/other/req-one' })],
      ]) {
        const result = await resolveOfficialPosting(row(), { fetch: network(careersPages(jobs)), candidateUrls: ['https://northwind.test/'] });
        assert.equal(result.officialPosting.level, 'L6'); assert.equal(result.officialPosting.employer, '');
        assert.equal(result.officialPosting.officialApplyUrl, undefined);
      }
      const ambiguous = await resolveOfficialPosting(row(), { fetch: network(careersPages([boardJob(), boardJob({ id: 'req-two', jobUrl: 'https://jobs.ashbyhq.com/northwind/req-two' })])), candidateUrls: ['https://northwind.test/'] });
      assert.equal(ambiguous.officialPosting.outcome, 'ambiguous'); assert.equal(ambiguous.officialPosting.alternatives.length, 2);
      assert.equal(ambiguous.officialPosting.officialApplyUrl, undefined);
    },
  },
  {
    name: 'Official posting resolver never borrows root identity across redirects or treats a stale RSS item as a live posting',
    async run() {
      const redirected = careersPages();
      redirected['https://northwind.test/'] = { url: 'https://elsewhere.test/', body: '<title>Northwind Labs</title><a href="https://jobs.ashbyhq.com/northwind">Careers</a>' };
      const rejected = await resolveOfficialPosting(row(), { fetch: network(redirected), candidateUrls: ['https://northwind.test/'] });
      assert.equal(rejected.officialPosting.level, 'L6');
      const rss = `<rss><channel><item><title>Software Engineer</title><link>https://careers.northwind.test/jobs/one</link><guid>req-one</guid><description><![CDATA[${description}]]></description></item></channel></rss>`;
      const pages = { 'https://northwind.test/': '<title>Northwind Labs</title><a href="https://careers.northwind.test/">Careers</a>',
        'https://careers.northwind.test/': '<meta property="og:site_name" content="Northwind Labs"><footer>Powered by Teamtailor</footer>',
        'https://careers.northwind.test/jobs.rss': { body: rss, contentType: 'application/rss+xml' } };
      const stale = await resolveOfficialPosting(row(), { fetch: network(pages), candidateUrls: ['https://careers.northwind.test/'] });
      assert.equal(stale.officialPosting.level, 'L6'); assert.equal(stale.description, undefined);
    },
  },
  {
    name: 'Official posting resolver combines a live Teamtailor RSS description with the same posting page structured pay',
    async run() {
      const requests = [];
      const result = await resolveOfficialPosting(row(), {
        fetch: network(teamtailorPages(), requests), candidateUrls: ['https://careers.northwind.test/'],
      });
      assert.equal(result.officialPosting.level, 'L2');
      assert.equal(result.officialPosting.employer, 'Northwind Labs');
      assert.equal(result.postedBy, 'Acme Talent Partners');
      assert.equal(result.description, description, 'the fetched RSS supplies the complete description after the page verifies the same posting');
      assert.deepEqual(result.officialPosting.salary, { text: 'CAD 117000 - 139000/yr', provenance: 'posted' });
      assert.equal(result.officialPosting.sourceUrl, 'https://careers.northwind.test/jobs/one');
      assert.equal(result.officialPosting.officialApplyUrl, 'https://careers.northwind.test/jobs/one');
      assert.ok(requests.includes('https://careers.northwind.test/jobs.rss'));
      assert.ok(requests.includes('https://careers.northwind.test/jobs/one'));
    },
  },
  {
    name: 'Official posting resolver recognizes a custom Teamtailor board from genuine careersite assets without a footer',
    async run() {
      const pages = teamtailorPages();
      for (const [url, body] of Object.entries(pages)) {
        if (typeof body === 'string') pages[url] = body.replaceAll('<footer>Powered by Teamtailor</footer>',
          '<script src="https://assets-aws.teamtailor-cdn.com/assets/careersite.js"></script>');
      }
      const result = await resolveOfficialPosting(row(), { fetch: network(pages), candidateUrls: ['https://careers.northwind.test/'] });
      assert.equal(result.officialPosting.level, 'L2'); assert.equal(result.officialPosting.employer, 'Northwind Labs');
      assert.equal(result.officialPosting.ats, 'teamtailor'); assert.equal(result.description, description);
    },
  },
  {
    name: 'Official posting resolver never borrows stale RSS text across an explicit posting identifier conflict',
    async run() {
      const result = await resolveOfficialPosting(row({ identifier: 'req-two' }), {
        fetch: network(teamtailorPages({ rssId: 'req-one', pageId: 'req-two' })), candidateUrls: ['https://careers.northwind.test/'],
      });
      assert.equal(result.officialPosting.level, 'L4', 'a verified current page with only brief text stays link-only when the RSS belongs to a different requisition');
      assert.equal(result.description, undefined);
      assert.equal(result.officialPosting.officialApplyUrl, 'https://careers.northwind.test/jobs/one');
    },
  },
  {
    name: 'Official posting resolver cannot promote a URL-bound stub with a related or ambiguous JSON-LD posting body',
    async run() {
      const url = 'https://northwind.test/jobs/one';
      const job = row({ company: 'Northwind Labs', title: 'Software Engineer', identifier: 'req-one', url });
      const stub = { '@type': 'JobPosting', title: 'Software Engineer', hiringOrganization: { name: 'Northwind Labs' },
        identifier: 'req-one', description: 'A brief role summary.', url,
        jobLocation: { address: { addressLocality: 'Lakeview', addressRegion: 'Ontario', addressCountry: 'Canada' } } };
      const related = { ...stub, identifier: 'req-two', url: 'https://northwind.test/jobs/two', description };
      const body = nodes => `<script type="application/ld+json">${JSON.stringify(nodes)}</script>`;
      const resolve = nodes => resolveOfficialPosting(job, { fetch: network({
        'https://northwind.test/': '<title>Northwind Labs</title>', [url]: body(nodes),
      }) });
      const bound = await resolve([stub, related]);
      assert.equal(bound.officialPosting.level, 'L4');
      assert.equal(bound.description, undefined, 'a longer related-job body never turns the bound stub into readable official text');
      for (const nodes of [
        [{ ...stub, url: undefined }, { ...related, url: undefined }],
        [stub, { ...stub, description }],
      ]) {
        const ambiguous = await resolve(nodes);
        assert.equal(ambiguous.officialPosting.level, 'L6', 'the unresolved client-posted row falls back without claiming a verified employer');
        assert.equal(ambiguous.officialPosting.officialApplyUrl, undefined);
        assert.equal(ambiguous.description, undefined);
      }
    },
  },
  {
    name: 'Official posting resolver refuses same-URL cross-page employer conflicts instead of borrowing a different employer salary',
    async run() {
      const sourceUrl = 'https://jobs.ashbyhq.com/northwind/req-one';
      const pages = careersPages();
      pages[sourceUrl] = jsonld({ url: sourceUrl, hiringOrganization: { name: 'Other Labs', sameAs: 'https://other.test/' },
        description: 'A brief role summary.', baseSalary: { currency: 'CAD', value: { minValue: 222000, maxValue: 333000, unitText: 'YEAR' } } });
      const result = await resolveOfficialPosting(row({ title: 'Software Engineer' }), {
        fetch: network(pages), candidateUrls: [{ employer: 'Northwind Labs', url: 'https://northwind.test/' }, { employer: 'Other Labs', url: sourceUrl }],
      });
      assert.equal(result.officialPosting.level, 'L6');
      assert.equal(result.officialPosting.employer, '');
      assert.equal(result.officialPosting.officialApplyUrl, undefined);
      assert.equal(result.officialPosting.salary, undefined);
      assert.equal(result.description, undefined);
      assert.ok(result.officialPosting.trail.includes('ambiguous'));
    },
  },
  {
    name: 'Official posting resolver keeps an apply link on the verified posting instead of a foreign tenant or a sibling posting',
    async run() {
      const sourceUrl = 'https://jobs.ashbyhq.com/northwind/req-one';
      for (const applyUrl of ['https://jobs.ashbyhq.com/other/req-one/application', 'https://jobs.ashbyhq.com/northwind/req-two/application']) {
        const result = await resolveOfficialPosting(row(), {
          fetch: network(careersPages([boardJob({ applyUrl })])), candidateUrls: ['https://northwind.test/'],
        });
        assert.equal(result.officialPosting.level, 'L2');
        assert.equal(result.officialPosting.sourceUrl, sourceUrl);
        assert.equal(result.officialPosting.officialApplyUrl, sourceUrl);
      }
    },
  },
  {
    name: 'Official posting resolver host-verifies discovery hypotheses and degrades bridge or storage failures without failing the caller',
    async run() {
      const job = row({ title: 'Software Engineer' });
      const found = await resolveOfficialPosting(job, { fetch: network(careersPages()), research: async () => [{ employer: 'Northwind Labs', careersPageUrl: 'https://northwind.test/' }] });
      assert.equal(found.officialPosting.level, 'L2');
      const missing = await resolveOfficialPosting(job, { fetch: network({}), research: async () => { const error = new Error('timeout'); error.code = 'bridge-timeout'; throw error; } });
      assert.equal(missing.officialPosting.level, 'L6'); assert.ok(missing.officialPosting.trail.includes('bridge-timeout'));
      const failed = await resolveOfficialPosting(row(), { fetch: network(careersPages()), candidateUrls: ['https://northwind.test/'], store: { find: async () => null, save: async () => { throw new Error('disk'); } } });
      assert.equal(failed.officialPosting.level, 'L6'); assert.equal(failed.officialPosting.outcome, 'failed');
    },
  },
  {
    name: 'Official posting free leads and sorted twelve-row chunks are deterministic before cache state is consulted',
    run() {
      const jobs = Array.from({ length: 25 }, (_, i) => row({ url: `https://board.test/${i}`, title: `Engineer ${i}` }));
      const chunks = officialPostingChunks(jobs); const reversed = officialPostingChunks([...jobs].reverse());
      assert.deepEqual(chunks, reversed); assert.deepEqual(chunks.map(chunk => chunk.length), [12, 12, 1]);
      assert.equal(officialPostingRequestId(jobs[0]), officialPostingRequestId({ ...jobs[0], officialPosting: { level: 'L2' } }));
      assert.deepEqual(freeOfficialPostingLeads(row({ applyOptions: [{ href: 'https://jobs.ashbyhq.com/northwind/one?utm_source=test', label: 'Apply' }],
        snippet: 'See https://northwind.test/careers. Also https://www.linkedin.com/jobs/one.' })), ['https://jobs.ashbyhq.com/northwind/one', 'https://northwind.test/careers']);
    },
  },
];
