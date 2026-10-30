import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOfficialPostingRowBudget, freeOfficialPostingLeads, officialPostingAdapterUrl, officialPostingChunks, officialPostingRequestId, resolveOfficialPosting, shouldPersistOfficialPostingResult } from '../../electron/ipc/officialPostingResolver.js';
import { createOfficialPostingStore, officialPostingView } from '../../electron/ipc/officialPostingStore.js';
import { officialPostingLookupStatus } from '../../electron/ipc/officialPostingFields.js';
import { OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL } from '../../electron/ipc/officialPostingNegativePolicy.js';

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
    name: 'Phenom anchor ownership requires the branded employer and exact linked tenant',
    async run() {
      const root = 'https://northwind.test/'; const board = 'https://job-boards.greenhouse.io/northwind';
      const target = `${board}/jobs/123456`; const api = 'https://boards-api.greenhouse.io/v1/boards/northwind/jobs/123456?questions=false';
      for (const mode of ['valid', 'wrong-tenant', 'unbranded', 'non-anchor', 'no-action', 'unsafe']) {
        const destination = mode === 'wrong-tenant' ? 'https://job-boards.greenhouse.io/other' : mode === 'unsafe' ? 'https://user:pass@job-boards.greenhouse.io/northwind' : board;
        const tag = mode === 'non-anchor' ? 'div' : 'a';
        const link = `<${tag} ${mode === 'no-action' ? '' : 'ph-href="search-results" ph-tevent="static_content_click"'} data-ph-href="${destination}">Jobs</${tag}>`;
        const pages = { [root]: `<title>${mode === 'unbranded' ? 'Unrelated Labs' : 'Northwind Labs'}</title>${link}`,
          [target]: '<main>Official role</main>', [api]: { contentType: 'application/json',
            body: JSON.stringify({ id: 123456, title: 'Software Engineer', company_name: 'Northwind Labs', absolute_url: target,
              location: { name: 'Lakeview, Ontario, Canada' }, content: description }) } };
        let comparisons = 0;
        const result = await resolveOfficialPosting(row({ company: 'Northwind Labs', title: 'Software Engineer', snippet: description }), {
          semanticMatching: true, researchRan: true, persistResults: false, store: null, render: null,
          candidateUrls: [{ postingUrl: target, employer: 'Northwind Labs', employerDomain: root }], fetch: network(pages),
          match: async (_job, options) => { comparisons++; assert.ok(options.some(option => option.sourceUrl === target));
            return { choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['Synthetic source admission only.'] }; },
        });
        assert.equal(comparisons, mode === 'valid' ? 2 : 0, mode);
        assert.equal(shouldPersistOfficialPostingResult(result, { researchRan: true }), false, mode);
      }
    },
  },
  {
    name: 'Proven employer careers navigation gets a bounded read before unrelated hosted-board details',
    async run() {
      const root = 'https://northwind.test/'; const careers = `${root}jobs`; const allJobs = `${careers}/all-jobs`;
      const board = 'https://job-boards.greenhouse.io/northwind'; const target = `${board}/jobs/123456`;
      const api = 'https://boards-api.greenhouse.io/v1/boards/northwind/jobs/123456?questions=false';
      for (const mode of ['linked', 'linked-none', 'wrong-tenant', 'no-tenant-link']) {
        const requests = []; let comparisons = 0;
        const pages = { [root]: '<title>Northwind Labs</title><a href="/jobs">Jobs</a>',
          [careers]: '<a href="/jobs/all-jobs">All jobs</a>',
          [allJobs]: mode === 'no-tenant-link' ? '<main>Our team</main>' : `<a href="${mode === 'wrong-tenant' ? 'https://job-boards.greenhouse.io/other' : board}">Open roles</a>`,
          [board]: Array.from({ length: 8 }, (_, i) => `<a href="${board}/jobs/${200000 + i}">Role</a>`).join(''),
          [target]: '<main>Official role</main>',
          [api]: { contentType: 'application/json', body: JSON.stringify({ id: 123456, title: 'Software Engineer', company_name: 'Northwind Labs',
            absolute_url: target, location: { name: 'Lakeview, Ontario, Canada' }, content: description }) } };
        for (let i = 0; i < 8; i++) pages[`${board}/jobs/${200000 + i}`] = '<main>Another role</main>';
        const result = await resolveOfficialPosting(row({ company: 'Northwind Labs', title: 'Software Engineer', snippet: description }), {
          semanticMatching: true, researchRan: true, persistResults: false, store: null, render: null,
          candidateUrls: [target, board, root], fetch: network(pages, requests),
          match: async (_job, options) => { comparisons++; assert.ok(options.some(option => option.sourceUrl === target));
            return mode === 'linked-none' ? { choice: 'none', evidence: [], distinguishing: [], conflicts: [] }
              : { choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['Source admission only.'] }; },
        });
        assert.ok(requests.includes(allJobs), `${mode}: follow actual employer careers navigation within the 16-page budget`);
        assert.ok(requests.length <= 16, `${mode}: preserve the document budget`);
        assert.equal(comparisons, mode.startsWith('linked') ? 2 : 0, `${mode}: tenant ownership requires the exact observed link`);
        assert.equal(shouldPersistOfficialPostingResult(result, { researchRan: true }), false, `${mode}: partial coverage cannot make uncertainty durable`);
        if (mode === 'linked-none') assert.ok(result.officialPosting.trail.some(code => ['crawl-partial', 'crawl-budget'].includes(code)),
          `a comparison miss on a limited crawl remains partial: ${result.officialPosting.trail.join(',')}`);
      }
    },
  },
  {
    name: 'An ATS vendor own-board round trip still requires its branded corporate root and actual exact-tenant careers link',
    async run() {
      const root = 'https://www.ashbyhq.com/'; const careers = `${root}careers`;
      const ownTenant = 'synthetic-own-team'; const otherTenant = 'synthetic-customer-team';
      for (const mode of ['valid', 'unlinked-careers', 'no-careers-link', 'no-tenant-link', 'wrong-tenant', 'wrong-brand', 'customer', 'sibling']) {
        const source = `https://jobs.ashbyhq.com/${ownTenant}/synthetic-role`;
        const employer = mode === 'customer' ? 'Unrelated Customer Labs' : 'Ashby';
        const sameAs = mode === 'sibling' ? 'https://customer.ashbyhq.com/' : root;
        const pages = {
          [root]: `<meta property="og:site_name" content="${mode === 'wrong-brand' ? 'Unrelated Labs' : 'Ashby'}">`
            + (['no-careers-link', 'unlinked-careers'].includes(mode) ? '' : '<a href="/careers">Careers</a>'),
          // A root without a careers link still has its conventional /careers path; with no page there, nothing links the tenant.
          ...(mode === 'no-careers-link' ? {} : { [careers]: '<main>Our open roles load here.</main>' }),
          [source]: (['no-tenant-link', 'customer'].includes(mode) ? `<a href="${source}">Hosted tenant self-link</a>` : '')
            + jsonld({ url: source, hiringOrganization: { name: employer, sameAs }, identifier: 'synthetic-role' }),
          [`https://api.ashbyhq.com/posting-api/job-board/${ownTenant}?includeCompensation=true`]: { body: '{"jobs":[]}', contentType: 'application/json' },
        };
        const requests = []; const rendered = []; const offered = [];
        const result = await resolveOfficialPosting(row({ company: employer, title: 'Software Engineer', snippet: description }), {
          semanticMatching: true, researchRan: true, persistResults: false, store: null,
          fetch: network(pages, requests), candidateUrls: [source],
          render: async url => {
            rendered.push(url);
            return { url, statusCode: 200, contentType: 'text/html', body: mode === 'no-tenant-link' ? '<main>No links</main>'
              : `<iframe src="https://jobs.ashbyhq.com/${mode === 'wrong-tenant' ? otherTenant : ownTenant}?embed=js"></iframe>` };
          },
          match: async (_job, options) => {
            offered.push(options);
            return { choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['Read-only admission control; identity remains unsettled.'] };
          },
        });
        if (['valid', 'unlinked-careers'].includes(mode)) {
          assert.equal(requests.includes(careers), true, mode === 'valid' ? 'the posting-derived corporate root must follow its actual careers link'
            : 'a proved root that names no careers page still has its conventional careers path read');
          assert.equal(rendered.includes(careers), true);
          assert.equal(offered.length, 2);
          assert.equal(offered.every(options => options.some(option => option.sourceUrl === source && option.candidate.tenantProven)), true);
        } else {
          assert.equal(offered.length, 0, mode);
          assert.ok(result.officialPosting.trail.includes('source-unproven'), mode);
        }
        assert.equal(shouldPersistOfficialPostingResult(result, { researchRan: true }), false, mode);
      }
    },
  },
  {
    name: 'Own-root copyright and URL-bound Organization branding supplement metadata without overriding client or platform vetoes',
    async run() {
      const posting = 'https://job-boards.greenhouse.io/northwind/jobs/123456';
      const api = 'https://boards-api.greenhouse.io/v1/boards/northwind/jobs/123456?questions=false';
      for (const kind of ['copyright', 'organization']) for (const mode of ['valid', 'off-root', 'wrong-name', 'conflicting-site', 'conflicting-organization', 'body-only', 'agency', 'sibling', 'hosted']) {
        const root = mode === 'sibling' ? 'https://client.northwind.test/' : mode === 'hosted' ? 'https://northwind.bamboohr.com/' : 'https://northwind.test/';
        const employer = 'Northwind Labs';
        const org = { '@type': 'Organization', name: mode === 'wrong-name' ? 'Unrelated Labs' : employer,
          url: mode === 'off-root' ? 'https://customer.test/' : root, '@id': `${root}#organization` };
        const site = mode === 'agency' ? 'Acme Talent Partners' : mode === 'conflicting-site' ? 'Unrelated Platform'
          : kind === 'organization' ? 'Northwind' : '';
        const copyright = `© 2026 ${mode === 'wrong-name' ? 'Unrelated Labs' : employer} All Rights Reserved`;
        const structured = kind === 'organization' ? `<script type="application/ld+json">${JSON.stringify({ '@type': 'WebPage', publisher: org,
          ...(mode === 'conflicting-organization' ? { about: { ...org, name: 'Unrelated Labs' } } : {}) })}</script>`
          : mode === 'conflicting-organization' ? `<script type="application/ld+json">${JSON.stringify({ ...org, name: 'Unrelated Labs' })}</script>` : '';
        const pages = { [root]: `<title>${mode === 'agency' ? 'Acme Talent Partners | Search' : 'Workflow systems for dispatch teams'}</title>
            ${site ? `<meta property="og:site_name" content="${site}">` : ''}${structured}<a href="/careers">Careers</a>
            ${kind === 'copyright' ? mode === 'body-only' ? `<main>${copyright}</main>` : `<footer>${copyright}</footer>` : ''}`,
          [`${root}careers`]: `<a href="https://job-boards.greenhouse.io/northwind">Open roles</a>`,
          [posting]: '<main>Official role</main>',
          [api]: { contentType: 'application/json', body: JSON.stringify({ id: 123456, title: 'Software Engineer', company_name: employer,
            absolute_url: posting, location: { name: 'Lakeview, Ontario, Canada' }, content: description }) } };
        let calls = 0;
        await resolveOfficialPosting(row(mode === 'agency' ? {} : { company: employer, title: 'Software Engineer', snippet: description }), {
          semanticMatching: true, candidateUrls: [posting, root], fetch: network(pages), render: null,
          match: async (_job, options) => { calls++; assert.ok(options.some(option => option.sourceUrl === posting));
            return { choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['Source admission only.'] }; },
        });
        const valid = mode === 'valid' || kind === 'copyright' && mode === 'off-root' || kind === 'organization' && mode === 'body-only';
        assert.equal(calls, valid ? 2 : 0, `${kind} ${mode}`);
      }
    },
  },
  {
    name: 'Domain-style employer names require literal own-root names and actual tenant navigation in both read orders',
    async run() {
      const root = 'https://northwind.test/'; const careers = `${root}careers`;
      const posting = 'https://job-boards.greenhouse.io/northwind/jobs/123456';
      const api = 'https://boards-api.greenhouse.io/v1/boards/northwind/jobs/123456?questions=false';
      for (const name of ['northwind.test', 'NORTHWIND.TEST', 'northwind test', 'northwind-test', 'https://northwind.test', 'northwind.test/path', 'northwind.test.example', 'northwind.test Inc']) {
        for (const linked of [false, true]) for (const leads of [[posting, root, careers], [root, careers, posting]]) {
          const literal = ['northwind.test', 'NORTHWIND.TEST'].includes(name);
          const pages = { [root]: '<title>Northwind: Workflow platform</title><meta property="og:site_name" content="Northwind"><a href="/careers">Careers</a><footer>Northwind northwind.test</footer>',
            [careers]: linked ? '<a href="https://job-boards.greenhouse.io/northwind">Open roles</a>' : '<main>Company culture</main>',
            [posting]: jsonld({ url: posting, hiringOrganization: { name, sameAs: root } }),
            [api]: { contentType: 'application/json', body: JSON.stringify({ id: 123456, title: 'Software Engineer', company_name: name,
              absolute_url: posting, location: { name: 'Lakeview, Ontario, Canada' }, content: description }) } };
          let calls = 0;
          const result = await resolveOfficialPosting(row({ company: literal ? name : 'Northwind', title: 'Software Engineer', snippet: description }), {
            semanticMatching: true, candidateUrls: [...leads, { employer: 'Northwind', employerDomain: root }], fetch: network(pages), render: null,
            match: async (_job, options) => { calls++; assert.ok(options.every(option => option.employer === name));
              return { choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['Source admission only.'] }; },
          });
          assert.equal(calls, literal && linked ? 2 : 0, `${name} ${linked} ${leads}`);
          assert.equal(shouldPersistOfficialPostingResult(result, { researchRan: true }), false);
        }
      }
      for (const [host, brand] of [['https://other.test/', 'Northwind'], ['https://client.northwind.test/', 'Northwind'],
        ['https://northwind.bamboohr.com/', 'Northwind'], [root, 'Acme Talent Partners']]) {
        let calls = 0;
        await resolveOfficialPosting(row({ company: brand === 'Acme Talent Partners' ? brand : 'Northwind', title: 'Software Engineer', snippet: description }), {
          semanticMatching: true, candidateUrls: [posting, host], render: null,
          fetch: network({ [host]: `<title>${brand}</title><meta property="og:site_name" content="${brand}"><a href="${posting}">Careers</a>`,
            [posting]: jsonld({ url: posting, hiringOrganization: { name: 'northwind.test', sameAs: host } }) }),
          match: async () => { calls++; return { choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['Source admission only.'] }; },
        });
        assert.equal(calls, 0, host);
      }
    },
  },
  {
    name: 'An unproved native detail with preliminary JSON-LD is reparsed after actual host ownership arrives',
    async run() {
      const root = 'https://northwind.test/'; const portal = 'https://careers.northwind.test/';
      const posting = `${portal}job/4455/synthetic-platform-builder/`;
      const apply = 'https://sjobs.brassring.com/TGnewUI/Search/home/HomeWithPreLoad?PageType=JobDetails&partnerid=123&siteid=456&jobid=789';
      const native = { id: 4455, company_name: 'Northwind Labs', title: 'Software Engineer', ref: 'NW-55', clientid: 'NW-55',
        entity_status: 'Open', url: posting, seo_url: apply, hidden: 'false', is_posted: 'true', publish_to_cws: 'true', location_type: 'Onsite',
        description: `<div data-field="description"><p>${description}</p></div>`,
        responsibilities: `<div data-field="responsibilities"><p>${description}</p></div>`,
        qualifications: `<div data-field="qualifications"><p>${description} Complete explicit qualification tail.</p></div>` };
      const body = `<link rel="canonical" href="${posting}">${jsonld({ url: posting, identifier: { value: 'NW-55' },
        hiringOrganization: { name: 'Northwind Labs' }, description })}<script>var current_job = ${JSON.stringify(native)};</script>
        <main><h1>Software Engineer</h1><ul><li>Job ID: NW-55</li><li>Location: Lakeview, Ontario, Canada</li><li>Work Setup: Onsite</li></ul>
        <section class="job-desc">${native.responsibilities}${native.qualifications}${native.description}</section>
        <a class="apply-btn" aria-label="Apply for job on Brassring" href="${apply}">Legacy experience</a></main>`;
      for (const linked of [false, true]) for (const leads of [[posting, root], [root, posting]]) {
        let calls = 0;
        await resolveOfficialPosting(row({ company: 'Northwind Labs', title: 'Software Engineer', snippet: description }), {
          semanticMatching: true, candidateUrls: leads, render: null, fetch: network({ [posting]: body,
            [root]: `<title>Northwind Labs</title>${linked ? `<a href="${portal}jobs">Careers</a>` : ''}`,
            [portal]: '<title>Hiring portal</title>', [`${portal}jobs`]: '<main>Open roles</main>' }),
          match: async (_job, options) => { calls++; assert.ok(options.some(option => option.sourceUrl === posting
            && option.description.includes('Complete explicit qualification tail.')));
            return { choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['Source admission only.'] }; },
        });
        assert.equal(calls, linked ? 2 : 0, `${linked} ${leads}`);
      }
    },
  },
  {
    name: 'Known Greenhouse IDs prioritize actual late own-board detail links within crawl limits without becoming ownership proof',
    async run() {
      const root = 'https://northwind.test/'; const board = `${root}careers/index.html`;
      const posting = 'https://job-boards.greenhouse.io/northwind/jobs/123456';
      const api = 'https://boards-api.greenhouse.io/v1/boards/northwind/jobs/123456?questions=false';
      for (const mode of ['actual-link', 'id-without-proof', 'wrong-id']) for (const order of ['adapter-first', 'html-first']) {
        const id = mode === 'wrong-id' ? '999999' : '123456';
        const target = `${root}careers/single-job.html?job_id=${id}`;
        const irrelevant = Array.from({ length: 72 }, (_, at) => `${root}careers/single-job.html?job_id=${200000 + at}`);
        const links = [...irrelevant.slice(0, 64), target, ...irrelevant.slice(64)];
        const boardHtml = links.map(url => `<a href="${url}">Open role</a>`).join('');
        const pages = { [root]: '<title>Northwind Labs</title><a href="/careers/index.html">Careers</a>',
          [board]: boardHtml, [posting]: '<main>Official role description loads here</main>',
          [api]: { contentType: 'application/json', body: JSON.stringify({ id: 123456, title: 'Software Engineer',
            company_name: 'Northwind Labs', absolute_url: posting, location: { name: 'Lakeview, Ontario, Canada' }, content: description }) },
          ...Object.fromEntries(links.map(url => [url, '<main>Single role loads using JavaScript</main>'])) };
        const requests = []; const rendered = []; let comparisons = 0;
        const result = await resolveOfficialPosting(row({ company: 'Northwind Labs', title: 'Software Engineer' }), {
          semanticMatching: true, researchRan: true,
          candidateUrls: order === 'adapter-first' ? [posting, api, root] : [posting, root, board], fetch: network(pages, requests),
          render: async url => {
            rendered.push(url);
            return { url, contentType: 'text/html', rendered: true, body: url === board ? boardHtml
              : url === target && mode === 'actual-link' ? `<main><a href="${posting}">Apply</a></main>`
                : '<main>No outbound application link</main>' };
          },
          match: async (_job, options) => { comparisons++; assert.ok(options.some(option => option.sourceUrl === posting));
            return { choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['Source admission only.'] }; },
        });
        assert.equal(comparisons, mode === 'actual-link' ? 2 : 0, `${mode} ${order}`);
        assert.ok(rendered.length <= 2, 'the production render cap is preserved');
        if (mode !== 'wrong-id') {
          assert.ok(requests.includes(target), 'the actual matching link is read despite 64 earlier links');
          assert.deepEqual(rendered, [board, target], 'the bounded detail render slot reaches the known posting');
        } else assert.ok(!requests.includes(target), 'an unrelated numeric ID is not treated as the known posting');
        if (mode !== 'actual-link') {
          assert.ok(result.officialPosting.trail.includes('source-unproven'));
          assert.equal(shouldPersistOfficialPostingResult(result, { researchRan: true }), false);
        }
      }
    },
  },
  {
    name: 'Failed, invalid and completed empty careers rendering all remain retryable without an eligible comparison inventory',
    async run() {
      const root = 'https://northwind.test/'; const careers = `${root}careers`;
      for (const mode of ['throws', 'cross-host', 'invalid', 'empty']) {
        const result = await resolveOfficialPosting(row({ company: 'Northwind Labs', title: 'Software Engineer' }), {
          semanticMatching: true, researchRan: true, candidateUrls: [root],
          fetch: network({ [root]: '<title>Northwind Labs</title><a href="/careers">Careers</a>',
            [careers]: '<main>Current openings load using JavaScript</main>' }),
          render: async url => {
            if (mode === 'throws') throw Object.assign(new Error('Render timed out'), { code: 'fetch-timeout' });
            return { url: mode === 'cross-host' ? 'https://unrelated.test/careers' : url,
              contentType: 'text/html', rendered: true, body: mode === 'invalid' ? null : '<main>No current openings</main>' };
          },
        });
        assert.equal(result.officialPosting.trail.includes('crawl-partial'), mode !== 'empty', mode);
        assert.equal(shouldPersistOfficialPostingResult(result, { researchRan: true }), false, mode);
        assert.equal(officialPostingLookupStatus(result.officialPosting).retryable, true, mode);
        assert.ok(result.officialPosting.trail.includes('research-miss'), mode);
        assert.ok(!result.officialPosting.trail.includes(OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL), mode);
      }
    },
  },

  {
    name: 'A conventional careers host root renders only after an actual branded employer link proves its host',
    async run() {
      const root = 'https://northwind.test/'; const careers = 'https://careers.northwind.test/';
      const posting = 'https://jobs.ashbyhq.com/northwind/req-one';
      for (const proved of [false, true]) {
        let renders = 0; let comparisons = 0;
        const pages = { [root]: `<title>${proved ? 'Northwind Labs' : 'Synthetic platform'}</title><a href="${careers}">Careers</a>`,
          [careers]: '<main>Open roles load here</main>', [posting]: '<main>Role detail</main>',
          [boardUrl]: { contentType: 'application/json', body: JSON.stringify({ jobs: [boardJob({ companyName: 'Northwind Labs' })] }) } };
        await resolveOfficialPosting(row({ company: 'Northwind Labs', title: 'Software Engineer' }), {
          semanticMatching: true, candidateUrls: [root, posting, careers], fetch: network(pages),
          render: async url => { renders++; assert.equal(url, careers); return { url, contentType: 'text/html', rendered: true,
            body: '<iframe src="https://jobs.ashbyhq.com/northwind"></iframe>' }; },
          match: async () => { comparisons++; return { choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['Source admission only.'] }; },
        });
        assert.equal(renders, proved ? 1 : 0); assert.equal(comparisons, proved ? 2 : 0);
      }
    },
  },

  {
    name: 'Regional employer receipt requires proven first-party full legal branding plus exact account and typed publisher in either order',
    async run() {
      const root = 'https://northwind.test/'; const careers = `${root}us/eng/careers`;
      const posting = 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/12';
      const uid = '20000000-0000-4000-8000-000000000001'; const other = uid.replace('0001', '0002');
      const account = id => `https://recruiting.paylocity.com/Recruiting/Jobs/All/${id}`;
      const legal = 'Northwind Labs North America Inc.';
      for (const mode of ['valid-rendered', 'valid-cms', 'missing-entity', 'wrong-account', 'wrong-publisher', 'unproved', 'unproved-cms']) {
        for (const leads of [[posting, root, careers], [root, careers, posting]]) {
          const careersBody = `<h1>Careers at Northwind Labs</h1><img alt="Office of ${mode === 'missing-entity' ? 'Northwind Labs' : legal}"><a href="${account(mode === 'wrong-account' ? other : uid)}">Open roles</a>`;
          const cmsRecords = Object.fromEntries([
            ['CAREERS_SECTION-1_LINK-1_URL', account(uid)], ['CAREERS_SECTION-1_LINK-1_TEXT', 'View Job Openings'],
            ['CAREERS_SECTION-2_SLIDE-1_IMAGE-ALT-TEXT', `Office of ${legal}`],
          ].map(([key, value]) => [key, { key, value }]));
          const cms = `<script id="ng-state" type="application/json">${JSON.stringify({ region: 'us', language: 'eng', 12345: { b: { 'eng-US': cmsRecords } } })}</script>`;
          const pages = { [root]: `<title>${mode.startsWith('unproved') ? 'Synthetic workflow platform' : 'Northwind Labs'}</title><a href="${careers}">Careers</a>`,
            [careers]: mode.endsWith('-cms') ? cms : mode === 'valid-rendered' ? '<main>Regional jobs load here</main>' : careersBody,
            [posting]: `<h2 id="LayoutLogoName">${mode === 'wrong-publisher' ? 'Other Labs Companies' : 'Northwind Labs Companies'}</h2><a href="${account(uid)}">All roles</a>${jsonld({
              url: posting, hiringOrganization: { name: legal, sameAs: root }, description })}` };
          let comparisons = 0;
          const result = await resolveOfficialPosting(row({ company: 'Northwind Labs Companies', title: 'Software Engineer' }), {
            semanticMatching: true, candidateUrls: leads, fetch: network(pages),
            render: async url => ({ url, contentType: 'text/html', rendered: true, body: careersBody }),
            match: async (_job, options) => { comparisons++; assert.ok(options.every(option => option.employer === legal));
              return { choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['Source admission only.'] }; },
          });
          assert.equal(comparisons, mode.startsWith('valid-') ? 2 : 0, `${mode} ${leads}`);
          if (!mode.startsWith('valid-')) assert.equal(shouldPersistOfficialPostingResult(result, { researchRan: true }), false);
        }
      }
    },
  },

  {
    name: 'Display qualifiers require actual employer tenant links while retaining raw candidate names in either read order',
    async run() {
      const root = 'https://northwind.test/'; const posting = 'https://jobs.ashbyhq.com/northwind/req-one';
      for (const label of ['Northwind Labs (A Northstar Technology Lab)', 'Northwind Labs (A Recruiting Company)', 'Other Labs (A Northstar Company)']) {
        for (const linked of [false, true]) for (const leads of [[posting, root], [root, posting]]) {
          const pages = careersPages([boardJob({ companyName: label })]);
          pages[root] = `<title>Northwind Labs</title>${linked ? '<a href="/careers">Careers</a>' : ''}`;
          pages[`${root}careers`] = linked ? '<a href="https://jobs.ashbyhq.com/northwind">Open roles</a>' : '<main>Culture</main>';
          pages[posting] = jsonld({ url: posting, hiringOrganization: { name: label, sameAs: root } });
          let comparisons = 0;
          await resolveOfficialPosting(row({ company: 'Northwind Labs', title: 'Software Engineer' }), {
            semanticMatching: true, candidateUrls: leads, fetch: network(pages),
            match: async (_job, options) => { comparisons++; assert.ok(options.every(option => option.employer === label));
              return { choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['Source admission only.'] }; },
          });
          assert.equal(comparisons, linked && label === 'Northwind Labs (A Northstar Technology Lab)' ? 2 : 0, `${label} ${linked} ${leads}`);
        }
      }
    },
  },
  {
    name: 'Cross-domain root redirects discover a fresh root and require its exact actual legacy careers redirect link',
    async run() {
      const old = 'https://legacy.test/'; const root = 'https://northwind.test/'; const careers = 'https://careers.legacy.test/';
      const board = 'https://jobs.ashbyhq.com/northwind'; const posting = `${board}/req-one`;
      for (const linked of [false, true]) for (const leads of [[posting, old, careers], [old, careers, posting]]) {
        const requests = []; let comparisons = 0;
        const pages = { [old]: { requestedUrl: old, url: root, body: '<title>Northwind Labs</title>' },
          [root]: `<title>Northwind Labs</title>${linked ? `<a href="${careers}">Careers</a>` : ''}`,
          [careers]: { requestedUrl: careers, url: board, body: '<main>Open roles</main>' },
          [posting]: jsonld({ url: posting, hiringOrganization: { name: 'Northwind Labs', sameAs: old } }),
          [boardUrl]: { contentType: 'application/json', body: JSON.stringify({ jobs: [boardJob({ companyName: 'Northwind Labs' })] }) } };
        await resolveOfficialPosting(row({ company: 'Northwind Labs', title: 'Software Engineer' }), {
          semanticMatching: true, candidateUrls: leads, fetch: network(pages, requests),
          match: async () => { comparisons++; return { choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['Source admission only.'] }; },
        });
        assert.ok(requests.includes(root), 'the final root is independently fetched and branded');
        assert.equal(comparisons, linked ? 2 : 0, `${linked}: ${leads}`);
      }
    },
  },
  {
    name: 'Typed embedded careers job links pass ordinary tenant ownership checks without granting unproved hosts authority',
    async run() {
      const posting = 'https://jobs.ashbyhq.com/northwind/req-one';
      for (const proved of [false, true]) {
        const pages = careersPages([boardJob({ companyName: 'Northwind Labs' })]);
        pages['https://northwind.test/'] = `<title>${proved ? 'Workflow platform | Northwind Labs' : 'Synthetic platform'}</title><a href="/careers">Careers</a>`;
        pages['https://northwind.test/careers'] = `<script type="application/json">${JSON.stringify({ jobs: [{ title: 'Software Engineer',
          jobUrl: posting, applyUrl: `${posting}/application` }] })}</script>`;
        pages[posting] = '<main>Role</main>';
        let comparisons = 0;
        await resolveOfficialPosting(row({ company: 'Northwind Labs', title: 'Software Engineer' }), {
          semanticMatching: true, candidateUrls: [posting, 'https://northwind.test/'], fetch: network(pages),
          match: async () => { comparisons++; return { choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['Source admission only.'] }; },
        });
        assert.equal(comparisons, proved ? 2 : 0);
      }
    },
  },

  {
    name: 'Fetched ATS employer hints retain corporate legal aliases, actual tenant links and agency ownership safeguards',
    async run() {
      const root = 'https://www.greenhouse.com/'; const careers = `${root}careers/opportunities`;
      const board = 'https://job-boards.greenhouse.io/synthetic-corporate-team'; const posting = `${board}/jobs/123456`;
      const api = 'https://boards-api.greenhouse.io/v1/boards/synthetic-corporate-team/jobs/123456?questions=false';
      for (const mode of ['linked', 'no-own-link', 'bad-legal-alias', 'wrong-tenant', 'platform-customer', 'missing-name', 'oversized-name', 'control-name', 'agency-client']) {
        for (const leads of [[root, careers, posting], [posting, root, careers]]) {
          const client = mode === 'platform-customer' || mode === 'agency-client';
          const employer = client ? 'Harbor Software Group' : mode === 'missing-name' ? '' : mode === 'oversized-name' ? 'N'.repeat(121)
            : mode === 'control-name' ? 'Greenhouse\u0085' : 'Greenhouse';
          const pages = { [root]: `<title>${mode === 'agency-client' ? 'Acme Talent Partners | Executive Search' : 'Greenhouse | Synthetic hiring platform'}</title>
              <meta property="og:site_name" content="${mode === 'agency-client' ? 'Acme Talent Partners' : 'Greenhouse'}"><a href="/careers/opportunities">Careers</a>
              <footer>${mode === 'bad-legal-alias' ? '© 2026 Other Software, Inc. Recruiting by Greenhouse Software.'
                : '© 2026 Greenhouse Software, Inc. All rights reserved.'}</footer>`,
            [careers]: mode === 'no-own-link' ? '<main>Company culture</main>'
              : `<iframe src="${mode === 'wrong-tenant' ? board.replace('synthetic-corporate-team', 'other-team') : board}"></iframe>`,
            [posting]: '<main>The official role loads here.</main>',
            [api]: { contentType: 'application/json', body: JSON.stringify({ id: 123456, title: 'Software Engineer', company_name: employer,
              absolute_url: posting, location: { name: 'Lakeview, Ontario, Canada' }, content: description }) } };
          let comparisons = 0;
          const original = row(mode === 'agency-client' ? {} : { company: 'Greenhouse Software', title: 'Software Engineer', snippet: description });
          const result = await resolveOfficialPosting(original, { semanticMatching: true, researchRan: true, fetch: network(pages),
            candidateUrls: [...leads, { employer: original.company, employerDomain: root, postingUrl: posting }],
            match: async (input, options) => { comparisons++; assert.equal(input.company, original.company);
              assert.ok(options.every(option => option.employer === 'Greenhouse' && option.sourceUrl === posting));
              return { choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['Source admission only.'] }; },
          });
          assert.equal(comparisons, mode === 'linked' ? 2 : 0, `${mode}: ${leads.join(',')} ${result.officialPosting.trail}`);
          assert.equal(shouldPersistOfficialPostingResult(result, { researchRan: true }), false);
        }
      }
    },
  },
  {
    name: 'Fetched employer discovery names are bounded to sixteen per row and never inferred from unrecognized hosts',
    async run() {
      const root = 'https://northwind.test/'; const board = 'https://job-boards.greenhouse.io/synthetic-owner';
      const api = 'https://boards-api.greenhouse.io/v1/boards/synthetic-owner/jobs?content=true';
      for (const count of [15, 16]) {
        const jobs = Array.from({ length: count + 1 }, (_, index) => ({ id: 123456 + index, title: 'Software Engineer',
          company_name: index < count ? `Unrelated Company ${index}` : 'Northwind Corporation', absolute_url: `${board}/jobs/${123456 + index}`,
          location: { name: 'Lakeview, Ontario, Canada' }, content: description }));
        let comparisons = 0;
        await resolveOfficialPosting(row({ company: 'Harbor Software Group', title: 'Software Engineer', snippet: description }), {
          semanticMatching: true, researchRan: true, candidateUrls: [root, board], fetch: network({
            [root]: `<title>Northwind Corporation</title><a href="${board}">Careers</a>`, [board]: '<main>Open roles</main>',
            [api]: { contentType: 'application/json', body: JSON.stringify({ jobs }) },
          }), match: async (_job, options) => { comparisons++; assert.equal(options.length, 1);
            assert.equal(options[0].employer, 'Northwind Corporation');
            return { choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['Source admission only.'] }; },
        });
        assert.equal(comparisons, count === 15 ? 2 : 0, `new names=${count + 1}`);
      }
      const job = row({ company: 'Harbor Software Group', title: 'Software Engineer', snippet: description });
      for (const ownerLearned of [false, true]) {
        const first = createOfficialPostingRowBudget(); let second;
        try {
          const jobs = Array.from({ length: 16 }, (_, index) => ({ id: 123456 + index, title: 'Software Engineer',
            company_name: ownerLearned && index === 15 ? 'Northwind Corporation' : `Unrelated Company ${index}`, absolute_url: `${board}/jobs/${123456 + index}`,
            location: { name: 'Lakeview, Ontario, Canada' }, content: description }));
          const posting = `${board}/jobs/234567`;
          const fetch = network({ [root]: `<title>Northwind Corporation</title><a href="${board}">Careers</a>`,
            [board]: '<main>Open roles</main>', [posting]: '<main>The official role loads here.</main>',
            [api]: { contentType: 'application/json', body: JSON.stringify({ jobs }) },
            'https://boards-api.greenhouse.io/v1/boards/synthetic-owner/jobs/234567?questions=false': {
              contentType: 'application/json', body: JSON.stringify({ ...jobs[0], id: 234567,
                company_name: 'Northwind Corporation', absolute_url: posting }) },
          });
          await resolveOfficialPosting(job, { semanticMatching: true, candidateUrls: [root, board], fetch, rowBudget: first });
          second = createOfficialPostingRowBudget({ previous: first }); let comparisons = 0;
          await resolveOfficialPosting(job, { semanticMatching: true, candidateUrls: [root, posting], fetch, rowBudget: second,
            match: async () => { comparisons++; return { choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['Source admission only.'] }; } });
          assert.equal(comparisons, ownerLearned ? 2 : 0, ownerLearned
            ? 'a fresh researched pass restores its already-fetched employer hypotheses'
            : 'a researched discovery pass cannot reset the sixteen-name row limit');
        } finally { first.dispose(); second?.dispose(); }
      }
      let comparisons = 0;
      const posting = 'https://unrecognized.test/jobs/synthetic-role';
      await resolveOfficialPosting(row({ company: 'Harbor Software Group', title: 'Software Engineer', snippet: description }), {
        semanticMatching: true, candidateUrls: [root, posting], fetch: network({
          [root]: `<title>Northwind Corporation</title><a href="${posting}">Careers</a>`,
          'https://unrecognized.test/': '<title>Jobs platform</title>',
          [posting]: jsonld({ url: posting, hiringOrganization: { name: 'Northwind Corporation' } }),
        }), match: async () => { comparisons++; return { choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['Source admission only.'] }; },
      });
      assert.equal(comparisons, 0);
    },
  },
  {
    name: 'Fetched Workable owner names remain hypotheses until an independently branded root links the exact matching account',
    async run() {
      const root = 'https://northwind.test/'; const careers = `${root}careers`;
      const publicBoard = 'https://jobs.workable.com/company/Public123/jobs-at-synthetic';
      const posting = 'https://apply.workable.com/synthetic/j/ABC123/';
      const api = 'https://apply.workable.com/api/v2/accounts/synthetic/jobs/ABC123';
      const uid = '12345678-1234-4123-8123-123456789001';
      const owner = 'Northwind Corporation'; const subsidiary = 'Harbor Software Group';
      for (const mode of ['linked', 'root-link', 'rendered', 'no-own-link', 'wrong-account', 'conflicting-name', 'missing-metadata', 'oversized-name', 'control-name', 'supplier', 'recruiter']) {
        for (const leads of [[root, careers, publicBoard, posting], [publicBoard, posting, root, careers]]) {
          const receiptName = mode === 'conflicting-name' ? 'Unrelated Corporation' : mode === 'oversized-name' ? 'N'.repeat(121)
            : mode === 'control-name' ? `${owner}\u0000` : owner;
          const state = { 'api/v1/companies/Public123': { status: 200, data: {
            id: uid, workableUid: uid, title: receiptName, url: publicBoard,
          } } };
          const ownLink = `<a href="${mode === 'no-own-link' ? publicBoard.replace('Public123', 'Other456') : publicBoard}">Open roles</a>`;
          const pages = { [root]: `<title>${mode === 'supplier' ? 'Unrelated software supplier' : mode === 'recruiter'
            ? 'Acme Talent Partners | Executive Search' : mode === 'missing-metadata' ? 'Workflow platform' : owner}</title>${mode === 'root-link' ? ownLink : '<a href="/careers">Careers</a>'}`,
            [careers]: mode === 'rendered' ? '<main>Open roles load using JavaScript</main>' : ownLink,
            [publicBoard]: `<script>window.jobBoard = { initialState: ${JSON.stringify(state)} };</script>`,
            [api]: { contentType: 'application/json', body: JSON.stringify({ shortcode: 'ABC123', title: 'Software Engineer',
              state: 'published', accountUid: mode === 'wrong-account' ? uid.replace('9001', '9002') : uid,
              locations: [{ city: 'Lakeview', country: 'Canada' }], description }) } };
          let comparisons = 0;
          const result = await resolveOfficialPosting(row({ company: subsidiary, title: 'Software Engineer', snippet: description }), {
            semanticMatching: true, researchRan: true,
            candidateUrls: [...leads.filter(url => mode !== 'root-link' || url !== careers), { employer: subsidiary, employerDomain: root,
              ...(mode !== 'root-link' ? { careersPageUrl: careers } : {}), postingUrl: posting }],
            fetch: network(pages), render: async url => ({ url, contentType: 'text/html', body: ownLink, rendered: true }),
            match: async (_job, options) => { comparisons++; assert.equal(_job.company, subsidiary, 'the row identity is retained');
              assert.ok(options.every(option => option.employer === owner && option.sourceUrl === posting));
              return { choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['Source admission only.'] }; },
          });
          assert.equal(comparisons, ['linked', 'root-link', 'rendered'].includes(mode) ? 2 : 0, `${mode}: ${leads.join(',')} ${result.officialPosting.trail}`);
          assert.equal(shouldPersistOfficialPostingResult(result, { researchRan: true }), false);
        }
      }
    },
  },
  {
    name: 'Workable public account equality requires an actual proved employer link in either discovery order',
    async run() {
      const root = 'https://northwind.test/'; const publicBoard = 'https://jobs.workable.com/company/Public123/jobs-at-synthetic';
      const posting = 'https://apply.workable.com/synthetic/j/ABC123/';
      const api = 'https://apply.workable.com/api/v2/accounts/synthetic/jobs/ABC123';
      const uid = '12345678-1234-4123-8123-123456789001';
      for (const mode of ['linked', 'unproved', 'unlinked-company', 'different-account', 'other-state-key', 'unrelated-global']) {
        for (const leads of [[posting, api, publicBoard, root], [root, publicBoard, posting]]) {
          const state = { [mode === 'other-state-key' ? 'api/v1/companies/Other456' : 'api/v1/companies/Public123']:
            { status: 200, data: { id: uid, workableUid: uid, title: 'A public company label is not proof', url: publicBoard } } };
          const global = mode === 'unrelated-global' ? 'unrelatedBoard' : 'jobBoard';
          const pages = { [root]: `<title>${mode === 'unproved' ? 'Synthetic workflow platform' : 'Northwind Labs'}</title><a href="${mode === 'unlinked-company'
            ? publicBoard.replace('Public123', 'Other456') : publicBoard}">Careers</a>`,
            [publicBoard]: `<script>window.${global} = { initialState: ${JSON.stringify(state)} };</script>`,
            [api]: { contentType: 'application/json', body: JSON.stringify({ shortcode: 'ABC123', title: 'Software Engineer',
              state: 'published', accountUid: mode === 'different-account' ? uid.replace('9001', '9002') : uid,
              locations: [{ city: 'Lakeview', country: 'Canada' }], description }) } };
          let comparisons = 0;
          const result = await resolveOfficialPosting(row({ company: 'Northwind Labs', title: 'Software Engineer' }), {
            semanticMatching: true, candidateUrls: leads, fetch: network(pages),
            match: async () => { comparisons++; return { choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['Source admission only.'] }; },
          });
          assert.equal(comparisons, mode === 'linked' ? 2 : 0, `${mode}: ${leads.join(',')}`);
          if (mode !== 'linked') {
            assert.ok(result.officialPosting.trail.includes('source-unproven'));
            assert.equal(shouldPersistOfficialPostingResult(result, { researchRan: true }), false);
          }
        }
      }
    },
  },

  {
    name: 'Fetched first-party details are reparsed when a later real root link proves their host',
    async run() {
      const root = 'https://northwind.test/'; const portal = 'https://jobs.northwind.test/';
      const posting = `${portal}jobs/synthetic-role`;
      const detail = `<main><h1>Software Engineer</h1><p>${description}</p><a href="/jobs/synthetic-role/apply">Apply</a></main>`;
      for (const linked of [false, true]) for (const leads of [[posting, root], [root, posting]]) {
        let comparisons = 0;
        const result = await resolveOfficialPosting(row({ company: 'Northwind Labs', title: 'Software Engineer' }), {
          semanticMatching: true, candidateUrls: leads,
          fetch: network({ [root]: `<title>Northwind Labs</title>${linked ? `<a href="${portal}jobs">Careers</a>` : ''}`,
            [portal]: '<title>Open roles</title>', [`${portal}jobs`]: '<main>Current openings</main>', [posting]: detail }),
          match: async () => { comparisons++; return { choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['Source admission only.'] }; },
        });
        assert.equal(comparisons, linked ? 2 : 0, `${linked} ${leads.join(',')}`);
        if (!linked) assert.ok(result.officialPosting.trail.includes('source-unproven'));
      }
    },
  },

  {
    name: 'Only empty proven own job details render and retain self-hosted source provenance',
    async run() {
      const root = 'https://northwind.test/'; const posting = `${root}jobs/synthetic-role`;
      const full = `<main><h1>Software Engineer</h1><p>${description}</p><a href="/jobs/synthetic-role/apply">Apply</a></main>`;
      for (const staticFull of [false, true]) {
        let renders = 0; let comparisons = 0;
        const result = await resolveOfficialPosting(row({ company: 'Northwind Labs', title: 'Software Engineer', url: posting }), {
          semanticMatching: true, candidateUrls: [root, posting],
          fetch: network({ [root]: '<title>Northwind Labs</title>', [posting]: staticFull ? full
            : '<nav><a href="https://jobs.ashbyhq.com/northwind">Other roles</a></nav><main>Role loads here</main>' }),
          render: async url => { renders++; assert.equal(url, posting); return { url, body: full, contentType: 'text/html', rendered: true }; },
          match: async (_job, options) => { comparisons++; assert.ok(options.every(option => option.provenance === 'employer'));
            return { choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['Source admission only.'] }; },
        });
        assert.equal(renders, staticFull ? 0 : 1); assert.equal(comparisons, 2);
        assert.ok(result.officialPosting.trail.includes('semantic-uncertain'));
      }
    },
  },

  {
    name: 'Greenhouse direct adapters fetch only the observed exact posting before optional board discovery',
    async run() {
      const route = { ats: 'greenhouse', tenant: 'northwind' };
      const posting = 'https://job-boards.greenhouse.io/northwind/jobs/123?gh_src=observed';
      const detail = 'https://boards-api.greenhouse.io/v1/boards/northwind/jobs/123?questions=false';
      assert.equal(officialPostingAdapterUrl(route, posting), detail);
      assert.equal(officialPostingAdapterUrl(route, 'https://api.greenhouse.io/v1/boards/northwind/jobs/123'), detail);
      assert.equal(officialPostingAdapterUrl(route, 'https://job-boards.greenhouse.io/other/jobs/123'), 'https://boards-api.greenhouse.io/v1/boards/northwind/jobs?content=true');
      assert.equal(officialPostingAdapterUrl(route, 'https://job-boards.greenhouse.io/northwind'), 'https://boards-api.greenhouse.io/v1/boards/northwind/jobs?content=true');
      const requests = []; let comparisons = 0;
      await resolveOfficialPosting(row({ company: 'Northwind Labs', title: 'Software Engineer' }), {
        semanticMatching: true, candidateUrls: [posting, 'https://northwind.test/'],
        fetch: network({ 'https://northwind.test/': `<title>Northwind Labs</title><a href="${posting}">Open role</a>`,
          [detail]: { contentType: 'application/json', body: JSON.stringify({ id: 123, title: 'Software Engineer',
            company_name: 'Northwind Labs', absolute_url: posting, location: { name: 'Lakeview, Ontario, Canada' }, content: description }) } }, requests),
        match: async () => { comparisons++; return { choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['Source admission only.'] }; },
      });
      assert.ok(requests.includes(detail));
      assert.ok(!requests.includes('https://boards-api.greenhouse.io/v1/boards/northwind/jobs?content=true'));
      assert.equal(comparisons, 2);
    },
  },

  {
    name: 'Host-fetched explicit legal brand aliases admit metadata or linked own policy evidence and reject unlinked unrelated declarations',
    async run() {
      const root = 'https://northwind.test/'; const legal = 'Northwind Insights Inc.';
      const posting = 'https://jobs.ashbyhq.com/northwind/req-one'; const requests = [];
      for (const mode of ['metadata', 'policy', 'trademark', 'unlinked', 'wrong-host', 'cooccurrence', 'unrelated', 'third-policy']) {
        requests.length = 0;
        const declarations = mode === 'metadata'
          ? `<script type="application/ld+json">${JSON.stringify({ '@type': 'Organization', name: 'Northwind', legalName: legal, url: '/' })}</script>`
          : mode === 'trademark' ? `<footer>Northwind and the Dispatch logo are trademarks of ${legal}</footer>` : '';
        const policyLink = mode === 'unlinked' || mode === 'metadata' || mode === 'trademark' ? ''
          : mode === 'wrong-host' ? '<a href="https://policy.test/privacy-policy">Privacy</a>'
          : mode === 'third-policy' ? '<a href="/privacy-policy">Privacy</a><a href="/terms-of-use">Terms</a><a href="/legal">Legal</a>'
          : '<a href="/privacy-policy">Privacy</a>';
        const statement = mode === 'cooccurrence' ? `${legal} provides Northwind services.`
          : mode === 'unrelated' ? 'Other Insights Inc. (“Northwind”) respects privacy.' : 'Northwind Insights, Inc. (“Northwind”) respects privacy.';
        const pages = { [root]: `<meta property="og:site_name" content="Northwind"><a href="/careers">Careers</a>${declarations}${policyLink}`,
          [`${root}careers`]: '<a href="https://jobs.ashbyhq.com/northwind">Open roles</a>',
          [`${root}privacy-policy`]: mode === 'third-policy' ? '<main>No declaration</main>' : statement,
          [`${root}terms-of-use`]: '<main>No declaration</main>', [`${root}legal`]: statement,
          'https://policy.test/privacy-policy': statement,
          [posting]: jsonld({ url: posting, hiringOrganization: { name: legal, sameAs: root } }),
          [boardUrl]: { contentType: 'application/json', body: JSON.stringify({ jobs: [boardJob({ companyName: legal })] }) } };
        let comparisons = 0;
        await resolveOfficialPosting(row({ company: 'Northwind', title: 'Software Engineer' }), {
          semanticMatching: true, fetch: network(pages, requests), candidateUrls: [posting, root],
          match: async () => { comparisons++; return { choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['Source admission only.'] }; },
        });
        assert.equal(comparisons, ['metadata', 'policy', 'trademark'].includes(mode) ? 2 : 0, mode);
        assert.ok(!requests.includes('https://policy.test/privacy-policy'), 'unowned policy pages cannot supply aliases');
        if (mode === 'unlinked') assert.ok(!requests.includes(`${root}privacy-policy`));
        if (mode === 'third-policy') assert.ok(!requests.includes(`${root}legal`), 'legal-page reads share a two-page row limit');
      }
    },
  },
  {
    name: 'Rendered owned careers JSON requests attest only exact known ATS API routes',
    async run() {
      const root = 'https://northwind.test/'; const careers = `${root}careers`;
      const api = 'https://api.greenhouse.io/v1/boards/northwind/jobs?content=true';
      const posting = 'https://job-boards.greenhouse.io/northwind/jobs/123';
      const pages = { [root]: '<title>Workflow platform | Northwind Labs</title><a href="/careers">Careers</a>',
        [careers]: '<main>Roles load here</main>', [posting]: '<main>Role detail</main>',
        [api]: { contentType: 'application/json', body: JSON.stringify({ jobs: [{ id: 123, title: 'Software Engineer',
          company_name: 'Northwind Labs', absolute_url: posting, location: { name: 'Lakeview, Ontario, Canada' }, content: description }] }) } };
      let comparisons = 0;
      await resolveOfficialPosting(row({ company: 'Northwind Labs', title: 'Software Engineer' }), {
        semanticMatching: true, fetch: network(pages), candidateUrls: [root, posting],
        render: async url => ({ url, contentType: 'text/html', body: '<main>Open roles</main>', rendered: true,
          resourceLinks: [api, 'https://unrelated.test/v1/boards/northwind/jobs', 'http://api.greenhouse.io/v1/boards/northwind/jobs'] }),
        match: async () => { comparisons++; return { choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['Source admission only.'] }; },
      });
      assert.equal(comparisons, 2);
    },
  },

  {
    name: 'Employer hiring join-us work-with-us and opportunities pages supply the same fetched tenant authority as careers',
    async run() {
      for (const path of ['hiring', 'join-us', 'work-with-us', 'opportunities']) {
        const root = 'https://northwind.test/'; const pages = careersPages([boardJob({ companyName: 'Northwind Labs' })]);
        pages[root] = `<title>Northwind Labs</title><a href="/${path}">Open roles</a>`;
        pages[`${root}${path}`] = '<a href="https://jobs.ashbyhq.com/northwind">Open roles</a>';
        let comparisons = 0;
        await resolveOfficialPosting(row({ company: 'Northwind Labs', title: 'Software Engineer' }), {
          semanticMatching: true, candidateUrls: [root], fetch: network(pages),
          match: async () => { comparisons++; return { choice: 'uncertain', evidence: [], distinguishing: [],
            conflicts: ['This fixture checks supported careers navigation only.'] }; },
        });
        assert.equal(comparisons, 2, path);
      }
    },
  },
  {
    name: 'Exact owned careers redirects preserve employer tenant proof in either discovery order and exclude unlinked siblings',
    async run() {
      const root = 'https://northwind.test/'; const career = `${root}careers/open-roles`;
      const posting = 'https://jobs.ashbyhq.com/northwind/req-one';
      for (const requested of [career, `${root}careers/unlinked`, 'https://sibling.northwind.test/careers']) {
        for (const leads of [[requested, root], [root, requested]]) {
          const pages = { [root]: `<title>Northwind Labs</title><a href="${career}">Careers</a>`,
            [career]: '<main>Corporate careers</main>',
            [requested]: { url: posting, requestedUrl: requested, body: '<main>Synthetic ATS posting</main>' },
            [boardUrl]: { contentType: 'application/json', body: JSON.stringify({ jobs: [boardJob()] }) } };
          let comparisons = 0;
          const result = await resolveOfficialPosting(row({ company: 'Northwind Labs', title: 'Software Engineer' }), {
            semanticMatching: true, candidateUrls: leads, fetch: network(pages),
            match: async () => { comparisons++; return { choice: 'uncertain', evidence: [], distinguishing: [],
              conflicts: ['This fixture checks host redirect provenance only.'] }; },
          });
          assert.equal(comparisons, requested === career ? 2 : 0, `${requested}: ${leads.join(', ')}`);
          if (requested !== career) {
            assert.ok(result.officialPosting.trail.includes('source-unproven'));
            assert.equal(shouldPersistOfficialPostingResult(result, { researchRan: true }), false);
          }
        }
      }
    },
  },
  {
    name: 'Public vendor detail adapters recover blocked HTML while retaining employer careers-link proof',
    async run() {
      const root = 'https://northwind.test/'; const posting = 'https://apply.workable.com/northwind/j/SYNTHETIC1/';
      const api = 'https://apply.workable.com/api/v2/accounts/northwind/jobs/SYNTHETIC1';
      for (const linked of [false, true]) {
        const pages = { [root]: '<title>Northwind Labs</title><a href="/careers">Careers</a>',
          [`${root}careers`]: linked ? `<a href="${posting}">Synthetic open role</a>` : '<main>Company culture</main>',
          [api]: { contentType: 'application/json', body: JSON.stringify({ shortcode: 'SYNTHETIC1', title: 'Synthetic Platform Engineer',
            description: `<p>${description}</p>`, requirements: '<p>Experience building reliable services.</p>', benefits: '',
            location: { city: 'Lakeview', region: 'Ontario', country: 'Canada' }, state: 'published', isInternal: false }) } };
        const requests = []; const read = network(pages, requests); let comparisons = 0;
        const result = await resolveOfficialPosting(row({ company: 'Northwind Labs', title: 'Synthetic Platform Engineer' }), {
          semanticMatching: true, candidateUrls: [posting, root],
          fetch: async (url, options) => {
            if (url === posting) throw Object.assign(new Error('Synthetic vendor HTML block'), { code: 'fetch-failed', statusCode: 403 });
            return read(url, options);
          },
          match: async () => { comparisons++; return { choice: 'uncertain', evidence: [], distinguishing: [],
            conflicts: ['This fixture exercises vendor source admission only.'] }; },
        });
        assert.ok(requests.includes(api)); assert.equal(comparisons, linked ? 2 : 0);
        if (!linked) {
          assert.ok(result.officialPosting.trail.includes('source-unproven'), 'parked employerless candidates are still unproved sources');
          assert.equal(shouldPersistOfficialPostingResult(result, { researchRan: true }), false);
        }
      }
    },
  },
  {
    name: 'Branded careers rendering admits actual fetched iframe tenant links without granting proof to a cross-domain render',
    async run() {
      const root = 'https://northwind.test/'; const careers = `${root}careers`;
      const posting = 'https://jobs.ashbyhq.com/northwind/req-one';
      for (const trustedRender of [false, true]) {
        const pages = careersPages([boardJob({ companyName: 'Northwind Labs' })]);
        pages[careers] = '<main id="synthetic-embed">Open roles load here</main>';
        pages[posting] = '<main>Synthetic role page</main>';
        let renders = 0; let comparisons = 0;
        const fetch = network(pages);
        await resolveOfficialPosting(row({ company: 'Northwind Labs', title: 'Software Engineer' }), {
          semanticMatching: true, fetch, candidateUrls: [root, posting],
          render: async (url, options) => {
            renders++; assert.equal(url, careers); assert.equal(options.fetch, fetch);
            assert.ok(options.initialPage.body.includes('synthetic-embed'));
            return { url: trustedRender ? careers : 'https://unrelated.test/careers', contentType: 'text/html',
              body: '<iframe src="https://jobs.ashbyhq.com/northwind?embed=js"></iframe>', rendered: true };
          },
          match: async () => { comparisons++; return { choice: 'uncertain', evidence: [], distinguishing: [],
            conflicts: ['Source proof is exercised without choosing a job.'] }; },
        });
        assert.equal(renders, 1); assert.equal(comparisons, trustedRender ? 2 : 0);
      }
    },
  },
  {
    name: 'Careers rendering is bounded to two proven pages and never launches on an unproved employer website',
    async run() {
      for (const proved of [false, true]) {
        const root = 'https://northwind.test/';
        const pages = { [root]: `<title>${proved ? 'Northwind Labs' : 'Unrelated Group'}</title>`
          + [1, 2, 3].map(id => `<a href="/careers/${id}">Open roles</a>`).join('') };
        for (const id of [1, 2, 3]) pages[`${root}careers/${id}`] = '<main>Synthetic dynamic careers page</main>';
        let renders = 0;
        await resolveOfficialPosting(row({ company: 'Northwind Labs', title: 'Software Engineer' }), {
          semanticMatching: true, candidateUrls: [root], fetch: network(pages),
          render: async url => { renders++; return { url, body: '<main>No tenant link</main>', contentType: 'text/html', rendered: true }; },
        });
        assert.equal(renders, proved ? 2 : 0);
      }
    },
  },
  {
    name: 'Corporate legal poster and product-brand hiring board reach comparison only with fetched copyright and tenant linkage',
    async run() {
      const root = 'https://www.greenhouse.com/'; const careers = `${root}careers/opportunities`;
      const posting = 'https://job-boards.greenhouse.io/synthetic-corporate-team/jobs/synthetic-role';
      const api = 'https://boards-api.greenhouse.io/v1/boards/synthetic-corporate-team/jobs?content=true';
      for (const linked of [false, true]) {
        const pages = { [root]: '<title>Greenhouse | Synthetic hiring platform</title><a href="/careers/opportunities">Careers</a><footer>© 2026 Greenhouse Software, Inc. All rights reserved.</footer>',
          [careers]: linked ? '<script src="https://boards.greenhouse.io/embed/job_board/js?for=synthetic-corporate-team"></script>' : '<main>Synthetic company culture</main>',
          [posting]: '<main>Synthetic Platform Engineer</main>',
          [api]: { contentType: 'application/json', body: JSON.stringify({ jobs: [{ id: 'synthetic-role',
            title: 'Synthetic Platform Engineer', company_name: 'Greenhouse', absolute_url: posting,
            location: { name: 'Lakeview, Ontario, Canada' }, content: `<p>${description}</p>` }] }) } };
        let comparisons = 0;
        await resolveOfficialPosting(row({ company: 'Greenhouse Software', title: 'Synthetic Platform Engineer', snippet: description }), {
          semanticMatching: true, candidateUrls: [{ postingUrl: posting, careersPageUrl: careers, employerDomain: root,
            employer: 'Greenhouse' }], fetch: network(pages),
          match: async () => { comparisons++; return { choice: 'uncertain', evidence: [], distinguishing: [],
            conflicts: ['This fixture checks source admission only.'] }; },
        });
        assert.equal(comparisons, linked ? 2 : 0, `linked=${linked}`);
      }
    },
  },
  {
    name: 'ATS vendor corporate careers sites prove their own linked tenant in either lead order before semantic comparison',
    async run() {
      for (const provider of ['ashby', 'greenhouse']) {
        const employer = provider === 'ashby' ? 'Ashby' : 'Greenhouse';
        const root = provider === 'ashby' ? 'https://www.ashbyhq.com/' : 'https://www.greenhouse.com/';
        const board = provider === 'ashby' ? 'https://jobs.ashbyhq.com/synthetic-vendor-team'
          : 'https://job-boards.greenhouse.io/synthetic-vendor-team';
        const posting = `${board}/${provider === 'ashby' ? '' : 'jobs/'}synthetic-role`;
        const api = provider === 'ashby' ? 'https://api.ashbyhq.com/posting-api/job-board/synthetic-vendor-team?includeCompensation=true'
          : 'https://boards-api.greenhouse.io/v1/boards/synthetic-vendor-team/jobs?content=true';
        for (const leads of [[posting, root], [root, posting]]) {
          const pages = { [root]: `<title>${employer} | Synthetic hiring platform</title><a href="/careers">Careers</a>`,
            [`${root}careers`]: provider === 'ashby' ? `<a href="${board}">Open roles</a>`
              : '<script src="https://boards.greenhouse.io/embed/job_board/js?for=synthetic-vendor-team"></script>',
            [board]: '<main>Synthetic open roles</main>',
            [posting]: provider === 'ashby' ? jsonld({ url: posting, title: 'Synthetic Platform Engineer',
              hiringOrganization: { name: employer, sameAs: root } }) : '<main>Synthetic Platform Engineer</main>',
            [api]: { contentType: 'application/json', body: JSON.stringify({ jobs: provider === 'ashby'
              ? [boardJob({ title: 'Synthetic Platform Engineer', jobUrl: posting, companyName: employer })]
              : [{ id: 'synthetic-role', title: 'Synthetic Platform Engineer', company_name: employer,
                absolute_url: posting, location: { name: 'Lakeview, Ontario, Canada' }, content: `<p>${description}</p>` }] }) } };
          let comparisons = 0;
          const result = await resolveOfficialPosting(row({ company: employer, title: 'Synthetic Platform Engineer', snippet: description }), {
            semanticMatching: true, candidateUrls: leads, fetch: network(pages),
            match: async (_job, options) => {
              comparisons++;
              assert.ok(options.some(option => option.sourceUrl === posting && option.employer === employer));
              assert.ok(options.every(option => option.candidate.tenantProven), 'only careers-linked tenant sources reach comparison');
              return { choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['This fixture exercises discovery only.'] };
            },
          });
          assert.equal(comparisons, 2, `${provider}: ${leads.join(', ')}`);
          assert.ok(result.officialPosting.trail.includes('semantic-uncertain'));
          assert.equal(result.officialPosting.trail.includes('source-unproven'), false);
          assert.equal(result.officialPosting.sourceUrl, undefined, 'discovery never forces an AI matching verdict');
        }
      }
    },
  },
  {
    name: 'ATS corporate root branding alone cannot authorize an unrelated customer tenant without a careers link',
    async run() {
      const root = 'https://www.ashbyhq.com/'; const posting = 'https://jobs.ashbyhq.com/synthetic-unlinked-customer/role';
      const pages = { [root]: '<title>Ashby | Synthetic hiring platform</title><a href="/careers">Careers</a>',
        [`${root}careers`]: '<main>No linked hiring platform</main>',
        [posting]: jsonld({ url: posting, title: 'Synthetic Platform Engineer', hiringOrganization: { name: 'Ashby', sameAs: root } }),
        'https://api.ashbyhq.com/posting-api/job-board/synthetic-unlinked-customer?includeCompensation=true': {
          contentType: 'application/json', body: JSON.stringify({ jobs: [boardJob({ jobUrl: posting, companyName: 'Ashby' })] }) } };
      let comparisons = 0;
      const result = await resolveOfficialPosting(row({ company: 'Ashby', title: 'Synthetic Platform Engineer' }), {
        semanticMatching: true, researchRan: true, candidateUrls: [posting, root], fetch: network(pages),
        match: async () => { comparisons++; throw new Error('An unrelated tenant must not reach comparison.'); },
      });
      assert.equal(comparisons, 0);
      assert.ok(result.officialPosting.trail.includes('source-unproven'));
      assert.equal(officialPostingLookupStatus(result.officialPosting).retryable, true);
    },
  },
  {
    name: 'researched oversize malformed unsupported and unsafe page misses are retried instead of cached as no match',
    async run() {
      for (const code of ['oversize', 'invalid-text', 'unsupported-content-type', 'unsafe-url', 'unsafe-address']) {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'official-unreadable-'));
        try {
          const store = createOfficialPostingStore(path.join(root, 'official-postings'));
          const original = row({ company: 'Northwind Labs', title: 'Software Engineer' });
          let calls = 0;
          for (let attempt = 0; attempt < 2; attempt++) {
            const result = await resolveOfficialPosting(original, { store, candidateUrls: ['https://northwind.test/jobs/unreadable'],
              research: async () => [], fetch: async url => { calls++; throw Object.assign(new Error('PRIVATE RESPONSE BODY'), { code, url }); } });
            assert.equal(officialPostingLookupStatus(result.officialPosting).state, 'incomplete', code);
            assert.equal(result.officialPosting.trail.includes('recent-miss'), false, code);
            assert.equal(await store.find(original), null, code);
          }
          assert.ok(calls >= 2, `${code} must be fetched again on the next lookup`);
        } finally { await fs.rm(root, { recursive: true, force: true }); }
      }
    },
  },
  {
    name: 'official lookup retains the failed verification URL and HTTP cause without replacing the scraped listing',
    async run() {
      const url = 'https://northwind.test/jobs/blocked';
      const original = row({ company: 'Northwind Labs', title: 'Software Engineer' });
      const before = JSON.stringify(original);
      const result = await resolveOfficialPosting(original, { candidateUrls: [url], research: async () => [],
        fetch: async requested => { throw Object.assign(new Error('PRIVATE RESPONSE BODY'), {
          code: 'fetch-failed', statusCode: 403, url: requested,
        }); } });
      assert.equal(JSON.stringify(original), before);
      assert.ok(result.officialPosting.fetchFailures.some(failure => failure.url === url && failure.statusCode === 403 && failure.reason === 'access-denied'));
      assert.ok(result.officialPosting.fetchFailures.length <= 8);
      assert.equal(JSON.stringify(result).includes('PRIVATE RESPONSE BODY'), false);
      const status = officialPostingLookupStatus(result.officialPosting);
      assert.equal(status.state, 'incomplete'); assert.equal(status.retryable, true);
      assert.match(status.detail, /northwind\.test\/jobs\/blocked/u);
      assert.match(status.detail, /HTTP 403/u); assert.match(status.detail, /original listing is retained/u);
    },
  },
  {
    name: 'official lookup reports storage failures separately from a failed page request',
    async run() {
      let saves = 0;
      const result = await resolveOfficialPosting(row(), { candidateUrls: ['https://northwind.test/'], fetch: network(careersPages()),
        store: { find: async () => null, save: async () => { saves++; throw new Error('Disk unavailable'); } } });
      assert.equal(saves, 1);
      assert.equal(result.officialPosting.outcome, 'failed');
      assert.ok(result.officialPosting.trail.includes('storage-failed'));
      assert.equal(result.officialPosting.trail.includes('fetch-failed'), false);
      assert.equal(officialPostingLookupStatus(result.officialPosting).label, 'Official posting check could not be saved');
      const unexpected = await resolveOfficialPosting(row(), { store: { find: async () => { throw new Error('Unexpected lookup failure'); } } });
      assert.equal(unexpected.officialPosting.trail.includes('fetch-failed'), false);
      assert.equal(officialPostingLookupStatus(unexpected.officialPosting).label, 'Official posting lookup incomplete');
    },
  },
  {
    name: 'official tenant ownership propagates from a later proven root through already-fetched careers pages in every lead order',
    async run() {
      const smart = 'https://jobs.smartrecruiters.com/Northwind/740000000000018-software-engineer';
      const api = 'https://api.smartrecruiters.com/v1/companies/Northwind/postings/740000000000018';
      const root = 'https://www.northwind.test/'; const career = 'https://careers.northwind.test/jobs/one';
      for (const linked of [false, true]) for (const leads of [[smart, career, root], [career, smart, root], [root, career, smart]]) {
        const pages = { [root]: `<title>Northwind Labs</title>${linked ? '<a href="https://careers.northwind.test/careers">Careers</a>' : ''}`,
          'https://careers.northwind.test/': `<title>Northwind Careers</title><a href="${smart}">Open role</a>`,
          'https://careers.northwind.test/careers': '<title>Northwind Careers</title>',
          [career]: `<title>Northwind Careers</title><a href="${smart}">Apply</a>`,
          [api]: { contentType: 'application/json', body: JSON.stringify({ id: '740000000000018', name: 'Software Engineer',
            company: { identifier: 'Northwind', name: 'Northwind Labs' }, postingUrl: smart, active: true,
            location: { city: 'Lakeview', region: 'Ontario', country: 'ca' },
            jobAd: { sections: { jobDescription: { title: 'Responsibilities', text: description } } } }) } };
        let matches = 0; const read = network(pages);
        const result = await resolveOfficialPosting(row({ company: 'Northwind Labs', title: 'Software Engineer' }), {
          semanticMatching: true, candidateUrls: leads,
          fetch: async url => {
            if (url === smart) throw Object.assign(new Error('Forbidden'), { code: 'fetch-failed', statusCode: 403 });
            return read(url);
          }, match: async () => { matches++; return { choice: 'P1', evidence: [{ scrapedQuote: 'Software Engineer', officialQuote: 'Software Engineer' }], distinguishing: [], conflicts: [] }; },
        });
        assert.equal(result.officialPosting.sourceUrl, linked ? smart : undefined, `${linked}: ${leads.join(', ')}`);
        assert.equal(matches, linked ? 2 : 0, 'conventional careers branding alone cannot prove the employer');
      }
    },
  },
  {
    name: 'SmartRecruiters exact detail API survives blocked public HTML while ownership still requires the fetched employer careers link',
    async run() {
      const smart = 'https://jobs.smartrecruiters.com/Northwind/740000000000017-software-engineer';
      const api = 'https://api.smartrecruiters.com/v1/companies/Northwind/postings/740000000000017';
      for (const linked of [false, true]) {
        const requests = []; let matches = 0;
        const pages = { 'https://northwind.test/': '<title>Northwind Labs</title><a href="/careers">Careers</a>',
          'https://northwind.test/careers': `<a href="${smart}">Open role</a>`,
          [api]: { contentType: 'application/json', body: JSON.stringify({ id: '740000000000017', name: 'Software Engineer',
            company: { identifier: 'Northwind', name: 'Northwind Labs' }, postingUrl: smart, active: true,
            location: { city: 'Lakeview', region: 'Ontario', country: 'ca' },
            jobAd: { sections: { jobDescription: { title: 'Responsibilities', text: description } } } }) } };
        const read = network(pages, requests);
        const result = await resolveOfficialPosting(row({ company: 'Northwind Labs', title: 'Software Engineer' }), {
          semanticMatching: true, candidateUrls: [linked ? 'https://northwind.test/careers' : smart],
          fetch: async url => {
            if (url === smart) { requests.push(url); throw Object.assign(new Error('Forbidden'), { code: 'fetch-failed', statusCode: 403 }); }
            return read(url);
          }, match: async () => { matches++; return { choice: 'P1', evidence: [{ scrapedQuote: 'Software Engineer', officialQuote: 'Software Engineer' }], distinguishing: [], conflicts: [] }; },
        });
        assert.ok(requests.includes(api), 'the observed exact posting supplies a bounded documented detail route');
        assert.equal(result.officialPosting.sourceUrl, linked ? smart : undefined);
        assert.equal(matches, linked ? 2 : 0, 'an ATS name alone cannot grant ownership');
        if (linked) assert.equal(result.description.includes(description), true);
      }
    },
  },
  {
    name: 'Official posting resolver follows a careers host discovered from a strictly proven employer root',
    async run() {
      const pages = careersPages();
      pages['https://northwind.test/'] = '<title>Northwind Labs</title><a href="https://careers.northwind.test/careers">Careers</a>';
      pages['https://careers.northwind.test/'] = '<title>Build the future | Open opportunities</title>';
      pages['https://careers.northwind.test/careers'] = '<title>Build the future | Open opportunities</title><a href="https://jobs.ashbyhq.com/northwind">Open roles</a>';
      const result = await resolveOfficialPosting(row(), { fetch: network(pages), candidateUrls: ['https://northwind.test/'] });
      assert.equal(result.officialPosting.level, 'L2'); assert.equal(result.officialPosting.employer, 'Northwind Labs');
      assert.equal(result.officialPosting.officialApplyUrl, boardJob().applyUrl);
      assert.ok(result.officialPosting.trail.includes('domain-proof'));
      const sameHostUrl = 'https://northwind.test/jobs/one';
      const direct = { ...pages, [sameHostUrl]: jsonld({ hiringOrganization: { name: 'Northwind Labs' } }) };
      direct['https://northwind.test/careers'] = `<title>Careers at Northwind Labs | Build the future</title><a href="${sameHostUrl}">Open role</a>`;
      const own = await resolveOfficialPosting(row(), { fetch: network(direct), candidateUrls: [sameHostUrl, 'https://northwind.test/careers'] });
      assert.equal(own.officialPosting.level, 'L1', 'the fetched strict employer root independently proves its own matching job');
    },
  },
  {
    name: 'Official posting resolver proves apex and www root redirects in either direction for own leads and sameAs',
    async run() {
      const ats = 'https://jobs.lever.co/northwind/one';
      for (const [requestedRoot, finalRoot] of [['https://nwlhq.test/', 'https://www.nwlhq.test/'],
        ['https://www.nwlhq.test/', 'https://nwlhq.test/']]) {
        const ownUrl = `${requestedRoot}jobs/one`;
        const ownRow = row({ company: 'Northwind Labs', title: 'Software Engineer', snippet: description, url: ownUrl });
        const pages = { [requestedRoot]: { url: finalRoot, body: '<title>Northwind Labs</title>' },
          [finalRoot]: '<title>Northwind Labs</title>',
          [ownUrl]: jsonld({ url: ownUrl, hiringOrganization: { name: 'Northwind Labs' } }),
          [ats]: jsonld({ url: ats, hiringOrganization: { name: 'Northwind Labs', sameAs: requestedRoot } }) };
        const own = await resolveOfficialPosting(ownRow, { fetch: network(pages) });
        assert.equal(own.officialPosting.level, 'L1', requestedRoot);
        assert.equal(own.officialPosting.sourceUrl, ownUrl);
        for (const leads of [[ats, requestedRoot], [requestedRoot, ats]]) {
          const sameAs = await resolveOfficialPosting(row({ company: 'Northwind Labs', title: 'Software Engineer', snippet: description }),
            { fetch: network(pages), candidateUrls: leads });
          assert.equal(sameAs.officialPosting.level, 'L3', `${requestedRoot}: ${leads.join(', ')}`);
          assert.equal(sameAs.officialPosting.sourceUrl, ats);
        }
      }
    },
  },
  {
    name: 'Official posting resolver keeps root ownership redirect and requested-url boundaries outside apex and www',
    async run() {
      const root = 'https://nwlhq.test/'; const url = `${root}jobs/one`;
      const own = row({ company: 'Northwind Labs', title: 'Software Engineer', snippet: description, url });
      for (const finalRoot of ['https://careers.nwlhq.test/', 'https://www.careers.nwlhq.test/', 'https://elsewhere.test/',
        'https://www.elsewhere.test/', 'https://jobs.lever.co/northwind/']) {
        const result = await resolveOfficialPosting(own, { fetch: network({
          [root]: { url: finalRoot, body: '<title>Northwind Labs</title>' },
          [url]: jsonld({ url, hiringOrganization: { name: 'Northwind Labs' } }),
        }) });
        assert.equal(result.officialPosting.level, 'L5', finalRoot);
        assert.equal(result.officialPosting.sourceUrl, undefined);
      }
      const mismatchedRequest = await resolveOfficialPosting(own, { fetch: network({
        [root]: { url: 'https://www.nwlhq.test/', requestedUrl: 'https://www.nwlhq.test/', body: '<title>Northwind Labs</title>' },
        [url]: jsonld({ url, hiringOrganization: { name: 'Northwind Labs' } }),
      }) });
      assert.equal(mismatchedRequest.officialPosting.level, 'L5', 'the response still belongs to this exact requested root');
    },
  },
  {
    name: 'Official posting resolver refuses title-only careers identity, absent links and sibling-tenant proof transfer',
    async run() {
      const base = careersPages();
      base['https://northwind.test/'] = '<title>Synthetic workflow platform</title><a href="/careers">Careers</a>';
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
    name: 'Official posting resolver rejects recruiter careers-title and unlisted mirror self-attestations',
    async run() {
      const recruiterBoard = 'https://api.ashbyhq.com/posting-api/job-board/acme-talent?includeCompensation=true';
      const recruiter = {
        'https://acmetalent.test/': '<title>Acme Talent Partners | Executive Search</title><a href="/careers/northwind">Careers</a>',
        'https://acmetalent.test/careers/northwind': '<title>Careers at Northwind Labs | Acme Talent Partners</title><a href="https://jobs.ashbyhq.com/acme-talent">Apply</a>',
        'https://jobs.ashbyhq.com/acme-talent': '<main>Open roles</main>',
        [recruiterBoard]: { body: JSON.stringify({ jobs: [boardJob({ jobUrl: 'https://jobs.ashbyhq.com/acme-talent/req-one' })] }), contentType: 'application/json' },
      };
      const poster = await resolveOfficialPosting(row(), { fetch: network(recruiter), candidateUrls: ['https://acmetalent.test/careers/northwind'] });
      assert.equal(poster.officialPosting.level, 'L6');
      assert.equal(poster.officialPosting.officialApplyUrl, undefined);
      const mirrorUrl = 'https://jobmirror.test/jobs/123';
      const mirror = { 'https://jobmirror.test/': '<title>JobMirror | Find jobs</title>',
        'https://jobmirror.test/careers/northwind': `<title>Careers at Northwind Labs | JobMirror</title><a href="${mirrorUrl}">Software Engineer</a>`,
        [mirrorUrl]: jsonld({ url: mirrorUrl }) };
      for (const applyOptions of [[], [{ label: 'Apply', href: mirrorUrl }]]) {
        const result = await resolveOfficialPosting(row({ applyOptions }), { fetch: network(mirror), candidateUrls: ['https://jobmirror.test/careers/northwind'] });
        assert.equal(result.officialPosting.level, 'L6');
        assert.equal(result.officialPosting.officialApplyUrl, undefined);
      }
    },
  },
  {
    name: 'Official posting resolver vetoes poster root branding and poster tenant slugs despite independent client proof',
    async run() {
      const url = 'https://recruiter.test/jobs/one';
      for (const branding of [
        '<title>Acme Talent Partners | Executive Search</title>',
        '<title>Northwind Labs</title><meta property="og:site_name" content="Careers by Acme Talent Partners">',
        '<title>Northwind Labs</title><footer>Recruiting services by <b>Acme Talent Partners</b> Incorporated</footer>',
      ]) {
        const result = await resolveOfficialPosting(row({ applyOptions: [{ label: 'Apply', href: url }] }), {
          fetch: network({ 'https://recruiter.test/': branding, [url]: jsonld({ url, hiringOrganization: { name: 'Northwind Labs' } }) }),
        });
        assert.equal(result.officialPosting.level, 'L6', branding);
        assert.ok(result.officialPosting.trail.includes('poster-tenant'));
      }
      for (const slug of ['acme-talent', 'Acme-Talent']) {
        const lever = `https://jobs.lever.co/${slug}/one`;
        const result = await resolveOfficialPosting(row({ applyOptions: [{ label: 'Apply', href: lever }] }), {
          fetch: network({ 'https://northwind.test/': '<title>Northwind Labs</title>', [lever]: jsonld({ url: lever }) }),
        });
        assert.equal(result.officialPosting.level, 'L6');
        assert.ok(result.officialPosting.trail.includes('poster-tenant'));
      }
      const legitimate = await resolveOfficialPosting(row({ company: 'Acme Talent Partners', title: 'Software Engineer', snippet: description,
        applyOptions: [{ label: 'Apply', href: 'https://jobs.lever.co/acme-talent/one' }] }), {
        fetch: network({ 'https://acmetalent.test/': '<title>Acme Talent Partners</title>',
          'https://jobs.lever.co/acme-talent/one': jsonld({ hiringOrganization: { name: 'Acme Talent Partners', sameAs: 'https://acmetalent.test/' } }) }),
      });
      assert.equal(legitimate.officialPosting.level, 'L3', 'an ordinary own-employer tenant is not a poster veto');
    },
  },
  {
    name: 'Official posting resolver requires fetched independent sameAs ownership and never inherits script or unrelated-host claims',
    async run() {
      const url = 'https://jobs.lever.co/northwind/one';
      for (const root of [undefined, '<title>Unrelated opportunities</title>', '<title>Acme Talent Partners | Executive Search</title>']) {
        const result = await resolveOfficialPosting(row({ applyOptions: [{ label: 'Apply', href: url }] }), {
          fetch: network({ [url]: jsonld(), 'https://northwind.test/': root }),
        });
        assert.equal(result.officialPosting.level, 'L6');
        assert.equal(result.officialPosting.officialApplyUrl, undefined);
      }
      for (const link of ['<script src="https://careers.northwind.test/careers"></script>',
        '<a href="https://unrelated.test/marketing">Marketing</a>']) {
        const pages = careersPages();
        pages['https://northwind.test/'] = `<title>Northwind Labs</title>${link}`;
        pages['https://careers.northwind.test/'] = '<title>Open opportunities</title>';
        pages['https://careers.northwind.test/careers'] = '<a href="https://jobs.ashbyhq.com/northwind">Apply</a>';
        pages['https://unrelated.test/'] = '<title>Open opportunities</title>';
        pages['https://unrelated.test/marketing'] = '<a href="https://jobs.ashbyhq.com/northwind">Apply</a>';
        // Only the script and unrelated-host claims may link the tenant here; the root's own careers path has no page.
        delete pages['https://northwind.test/careers'];
        const result = await resolveOfficialPosting(row(), { fetch: network(pages), candidateUrls: ['https://northwind.test/'] });
        assert.equal(result.officialPosting.level, 'L6');
      }
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
        await store.save(job, { officialPosting: { level: 'L5', outcome: 'not-found', employer: job.company,
          trail: ['bridge-research', OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL] } });
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
      const l1 = await resolveOfficialPosting(row({ company: 'Northwind Labs', title: 'Software Engineer', snippet: description, url: 'https://northwind.test/jobs/one' }), {
        fetch: network({ 'https://northwind.test/': '<title>Northwind Labs</title>', 'https://northwind.test/jobs/one': jsonld() }),
      });
      assert.equal(l1.officialPosting.level, 'L1');
      const portalUrl = 'https://www.usajobs.gov/job/123';
      const portal = await resolveOfficialPosting(row({ company: 'Northwind Labs', title: 'Software Engineer', snippet: description, url: portalUrl }), {
        fetch: network({ [portalUrl]: jsonld() }),
      });
      assert.equal(portal.officialPosting.level, 'L1');
      assert.equal(portal.officialPosting.employer, 'Northwind Labs');
      const url = 'https://jobs.lever.co/northwind/one';
      const l3 = await resolveOfficialPosting(row({ applyOptions: [{ label: 'Employer', href: url }] }), { fetch: network({ [url]: jsonld(), 'https://northwind.test/': '<title>Northwind Labs</title>' }) });
      assert.equal(l3.officialPosting.level, 'L3'); assert.equal(l3.officialPosting.employer, 'Northwind Labs');
      const l4 = await resolveOfficialPosting(row({ identifier: 'req-one', applyOptions: [{ label: 'Employer', href: url }] }), {
        fetch: network({ [url]: jsonld({ description: 'A brief role summary.' }), 'https://northwind.test/': '<title>Northwind Labs</title>' }),
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
    name: 'Official posting resolver keeps closed and employer-filtered fetched siblings in the description comparison pool',
    async run() {
      for (const companyName of [undefined, 'Other Labs']) {
        const closed = boardJob({ id: 'req-closed', jobUrl: 'https://jobs.ashbyhq.com/northwind/req-closed', isListed: false, companyName });
        const sibling = boardJob({ id: 'req-active', jobUrl: 'https://jobs.ashbyhq.com/northwind/req-active',
          descriptionPlain: `${description} Manage the consumer payment gateway roadmap.` });
        const result = await resolveOfficialPosting(row(), {
          fetch: network(careersPages([closed, sibling])), candidateUrls: ['https://northwind.test/'],
        });
        assert.equal(result.officialPosting.level, 'L6');
        assert.equal(result.officialPosting.officialApplyUrl, undefined, 'shared board copy cannot anchor a different live sibling');
      }
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
      const job = row({ company: 'Northwind Labs', title: 'Software Engineer', snippet: description, identifier: 'req-one', url });
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
        assert.equal(ambiguous.officialPosting.level, 'L5', 'the ordinary own-employer row keeps only its scraped employer when the posting body is ambiguous');
        assert.equal(ambiguous.officialPosting.employer, 'Northwind Labs');
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
      const links = Array.from({ length: 33 }, (_, index) => `https://northwind.test/jobs/${index}`); const omitted = [];
      assert.deepEqual(freeOfficialPostingLeads(row({ snippet: [...links, links[0], 'https://www.linkedin.com/jobs/one'].join(' ') }), {
        onOmitted: url => omitted.push(url),
      }), links.slice(0, 32));
      assert.deepEqual(omitted, [links[32]], 'only distinct eligible omitted leads count toward incomplete discovery');
    },
  },
  {
    name: 'A hosted board page links its employer root as a lead whether or not research supplied the domain, and a lookalike stays unproven',
    async run() {
      const root = 'https://northwind.test/'; const board = 'https://job-boards.greenhouse.io/northwind';
      const target = `${board}/jobs/123456`; const api = 'https://boards-api.greenhouse.io/v1/boards/northwind/jobs/123456?questions=false';
      const sibling = id => `${board}/jobs/${200000 + id}`;
      for (const mode of ['no-domain', 'with-domain', 'lookalike', 'lookalike-unlinked-root']) {
        const employerLink = mode.startsWith('lookalike') ? 'https://northwindlabs.test/company/careers' : 'https://www.northwind.test/company/careers';
        const pages = { [root]: '<title>Northwind Labs</title><a href="/careers">Careers</a>',
          [`${root}careers`]: `<a href="${board}">Open roles</a>`,
          'https://northwindlabs.test/': mode === 'lookalike' ? `<title>Northwind Labs</title><a href="${board}">Open roles</a>` : '<title>Northwind Labs</title><main>No jobs</main>',
          [board]: '<main>Board</main>',
          [target]: Array.from({ length: 10 }, (_, i) => `<a href="${sibling(i)}">Role ${i}</a>`).join('') + `<a href="${employerLink}">About</a>`,
          [api]: { contentType: 'application/json', body: JSON.stringify({ id: 123456, title: 'Software Engineer', company_name: 'Northwind Labs',
            absolute_url: target, location: { name: 'Lakeview, Ontario, Canada' }, content: description }) } };
        for (let i = 0; i < 10; i++) pages[sibling(i)] = '<main>Another role</main>';
        pages['https://www.northwind.test/'] = pages[root];
        pages['https://www.northwind.test/careers'] = pages[`${root}careers`];
        const requests = []; let comparisons = 0;
        const result = await resolveOfficialPosting(row({ company: 'Northwind Labs', title: 'Software Engineer', snippet: description }), {
          semanticMatching: true, researchRan: true, persistResults: false, store: null, render: null,
          candidateUrls: [mode === 'with-domain' ? { postingUrl: target, employer: 'Northwind Labs', employerDomain: root } : target],
          fetch: network(pages, requests),
          match: async (_job, options) => { comparisons++; assert.ok(options.some(option => option.sourceUrl === target && option.candidate.tenantProven));
            return { choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['Source admission only.'] }; },
        });
        if (mode.startsWith('lookalike')) {
          // The lead is only navigation: the lookalike was read, but a root that does not link the exact tenant proves nothing.
          if (mode === 'lookalike-unlinked-root') {
            assert.ok(requests.includes('https://northwindlabs.test/'), 'the brand-matching employer link is read as a root lead');
            assert.equal(comparisons, 0, mode);
            assert.ok(result.officialPosting.trail.includes('source-unproven'), mode);
          }
          if (mode === 'lookalike') assert.ok(requests.includes('https://northwindlabs.test/'));
        } else {
          assert.equal(comparisons, 2, `${mode}: same ownership outcome with or without a researched employerDomain`);
          const rootAt = requests.findIndex(url => url.startsWith('https://www.northwind.test/') || url === root);
          const siblingAt = requests.findIndex(url => url.startsWith(`${board}/jobs/2`));
          assert.ok(rootAt >= 0 && (siblingAt < 0 || rootAt < siblingAt), `${mode}: the employer root is read before sibling job pages: ${requests.join(' ')}`);
        }
        assert.equal(shouldPersistOfficialPostingResult(result, { researchRan: true }), false, mode);
      }
    },
  },
  {
    name: 'Employer navigation promotion skips sibling job details and never jumps an unread research lead or adapter',
    async run() {
      const root = 'https://northwind.test/'; const board = 'https://job-boards.greenhouse.io/northwind';
      const target = `${board}/jobs/123456`; const first = `${root}jobs/1`;
      const pages = { [root]: '<title>Northwind Labs</title>',
        [first]: Array.from({ length: 6 }, (_, i) => `<a href="${root}jobs/${100 + i}">Role ${i}</a>`).join('') + `<a href="${root}careers/culture">Culture</a>`,
        [target]: '<main>Official role</main>', [`${root}careers/culture`]: '<main>Culture</main>' };
      for (let i = 0; i < 6; i++) pages[`${root}jobs/${100 + i}`] = '<main>Sibling</main>';
      const requests = [];
      await resolveOfficialPosting(row({ company: 'Northwind Labs', title: 'Software Engineer', snippet: description }), {
        semanticMatching: true, researchRan: true, persistResults: false, store: null, render: null,
        candidateUrls: [first, target], fetch: network(pages, requests),
        match: async () => ({ choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['Order only.'] }),
      });
      const at = url => requests.indexOf(url);
      assert.ok(at(target) >= 0, 'the explicit research lead is read');
      assert.ok(at(target) < at(`${root}jobs/100`), 'sibling job details are not navigation and do not jump the research lead');
      assert.ok(at(target) < at(`${root}careers/culture`), 'true navigation does not jump an unread research lead either');
      assert.ok(at(`${root}careers/culture`) >= 0 && at(`${root}careers/culture`) < at(`${root}jobs/100`), 'navigation still precedes sibling details');
    },
  },
  {
    name: 'Hosted board root twins and listing-filter variants are one page while posting-id URLs stay distinct',
    async run() {
      const board = 'https://jobs.lever.co/northwind'; const posts = Array.from({ length: 6 }, (_, i) => `${board}/0000000${i}-aaaa-bbbb-cccc-000000000000`);
      const variants = [`${board}/`, `${board}?workplaceType=onsite`, `${board}/?location=Austin`, `${board}?department=Eng&team=Core`];
      const kept = [`${board}?gh_jid=77`, `${board}?page=2`];
      // Variants first would be read as separate pages; variants last (after eight follows) would be counted as unfollowed pages.
      for (const order of ['variants-first', 'variants-last']) {
        const links = (order === 'variants-first' ? [...variants, ...kept, ...posts] : [...kept, ...posts, ...variants])
          .map(url => `<a href="${url}">x</a>`).join('');
        const pages = { [board]: links, [`${board}/`]: 'twin', [`${board}?gh_jid=77`]: 'post', [`${board}?page=2`]: 'other' };
        for (const url of posts) pages[url] = '<main>Role</main>';
        const requests = [];
        const result = await resolveOfficialPosting(row({ company: 'Northwind Labs', title: 'Software Engineer', snippet: description }), {
          semanticMatching: true, researchRan: true, persistResults: false, store: null, render: null,
          candidateUrls: [board], fetch: network(pages, requests),
          match: async () => ({ choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['Hygiene only.'] }),
        });
        for (const skipped of variants) assert.equal(requests.includes(skipped), false, `${order}: skipped ${skipped}`);
        if (order === 'variants-first') for (const url of kept) assert.ok(requests.includes(url), `${order}: never collapsed ${url}`);
        const trail = result.officialPosting.trail;
        assert.equal(trail.includes('crawl-partial') || trail.includes('crawl-budget'), false, `${order}: skipped variants are not unfollowed pages: ${trail}`);
      }
    },
  },
  {
    name: 'A 404 on a derived adapter records no closed code while a researched URL 404 still does',
    async run() {
      const board = 'https://job-boards.greenhouse.io/northwind'; const target = `${board}/jobs/123456`;
      for (const researched of [false, true]) {
        const missing = 'https://northwind.test/jobs/gone';
        const result = await resolveOfficialPosting(row({ company: 'Northwind Labs', title: 'Software Engineer', snippet: description }), {
          semanticMatching: true, researchRan: true, persistResults: false, store: null, render: null,
          candidateUrls: researched ? [missing] : [target], fetch: network({ [target]: '<main>Official role</main>' }),
          match: async () => ({ choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['Trail only.'] }),
        });
        assert.equal(result.officialPosting.trail.includes('closed'), researched, `researched=${researched}: ${result.officialPosting.trail.join(',')}`);
      }
    },
  },
  {
    name: 'A board tagline label stands for the owner only after a fetched employer link to the exact tenant',
    async run() {
      const root = 'https://cognite.test/'; const board = 'https://job-boards.greenhouse.io/cognite';
      const target = `${board}/jobs/123456`; const api = 'https://boards-api.greenhouse.io/v1/boards/cognite/jobs/123456?questions=false';
      for (const mode of ['linked', 'unlinked', 'agency-tagline']) {
        const pages = { [root]: `<title>Cognite</title><a href="/careers">Careers</a>`,
          [`${root}careers`]: mode === 'unlinked' ? '<main>Culture</main>' : `<a href="${board}">Open roles</a>`,
          [target]: '<main>Official role</main>',
          [api]: { contentType: 'application/json', body: JSON.stringify({ id: 123456, title: 'Software Engineer',
            company_name: mode === 'agency-tagline' ? 'Cognite - Staffing Partner' : 'Cognite - AI for Industry', absolute_url: target,
            location: { name: 'Lakeview, Ontario, Canada' }, content: description }) } };
        let comparisons = 0;
        await resolveOfficialPosting(row({ company: 'Cognite', title: 'Software Engineer', snippet: description }), {
          semanticMatching: true, researchRan: true, persistResults: false, store: null, render: null,
          candidateUrls: [target, root], fetch: network(pages),
          match: async () => { comparisons++; return { choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['Admission only.'] }; },
        });
        assert.equal(comparisons, mode === 'linked' ? 2 : 0, mode);
      }
    },
  },
  {
    name: 'A posting sameAs careers page is read when the root has no anchors but must still link the exact tenant on the same domain',
    async run() {
      const root = 'https://northwind.test/'; const careers = `${root}careers`; const source = 'https://jobs.ashbyhq.com/northwind/req-one';
      for (const mode of ['valid', 'not-careers-path', 'no-tenant-link']) {
        const sameAs = mode === 'not-careers-path' ? `${root}about-us` : careers;
        // With a non-careers sameAs, only the conventional /careers path could still link the tenant, so it has no page here.
        const pages = { [root]: '<title>Northwind Labs | Home</title><div id="app"></div>',
          ...(mode === 'not-careers-path' ? {} : { [careers]: '<div id="app"></div>' }),
          [`${root}about-us`]: '<div id="app"></div>',
          [source]: jsonld({ url: source, hiringOrganization: { name: 'Northwind Labs', sameAs }, identifier: 'req-one' }),
          'https://api.ashbyhq.com/posting-api/job-board/northwind?includeCompensation=true': { body: '{"jobs":[]}', contentType: 'application/json' } };
        const rendered = []; let comparisons = 0;
        await resolveOfficialPosting(row({ company: 'Northwind Labs', title: 'Software Engineer', snippet: description }), {
          semanticMatching: true, researchRan: true, persistResults: false, store: null, candidateUrls: [source], fetch: network(pages),
          render: async url => { rendered.push(url); return { url, statusCode: 200, contentType: 'text/html', rendered: true,
            body: mode === 'no-tenant-link' ? '<main>No links</main>' : '<a href="https://jobs.ashbyhq.com/northwind">Open roles</a>' }; },
          match: async () => { comparisons++; return { choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['Admission only.'] }; },
        });
        assert.equal(comparisons, mode === 'valid' ? 2 : 0, `${mode}: ${rendered.join(',')}`);
        if (mode === 'valid') assert.ok(rendered.includes(careers), 'the sameAs careers page is rendered');
      }
    },
  },
  {
    name: 'A proven employer host search link yields one title-search lead read before sibling details, and nothing else does',
    async run() {
      const root = 'https://northwind.test/'; const siblings = Array.from({ length: 6 }, (_, i) => `${root}careers/job/${100 + i}/other-role`);
      const careersHtml = extra => `<title>Northwind Labs</title>${siblings.map(url => `<a href="${url}">Role</a>`).join('')}${extra}`;
      const results = `<a href="${root}careers/job/999/software-engineer">Software Engineer</a>`;
      const run = async (pages, { candidateUrls = [root], title = 'Software Engineer - Lakeview' } = {}) => {
        for (const url of siblings) pages[url] = '<main>Sibling</main>';
        const requests = [];
        await resolveOfficialPosting(row({ company: 'Northwind Labs', title, snippet: description }), {
          semanticMatching: true, researchRan: true, persistResults: false, store: null, render: null, candidateUrls,
          fetch: network(pages, requests), match: async () => ({ choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['Order only.'] }),
        });
        return requests;
      };
      const search = `${root}careers/search?keyword=Software+Engineer`;
      const link = `<a href="${root}careers/search?keyword=intern&page=2">Internships</a>`;
      const base = { [root]: '<title>Northwind Labs</title><a href="/careers">Careers</a>', [search]: results,
        [`${root}careers/job/999/software-engineer`]: '<main>The role</main>' };
      // Positive: the title (without its place suffix) replaces the keyword, only that parameter is kept, and it precedes sibling details.
      const requests = await run({ ...base, [`${root}careers`]: careersHtml(link + `<a href="${root}careers/search?keyword=associate">More</a>`) });
      assert.ok(requests.includes(search), `the title search is read: ${requests.join(' ')}`);
      assert.equal(requests.filter(url => url.startsWith(`${root}careers/search`) && url.includes('Software')).length, 1, 'once per host');
      assert.ok(requests.indexOf(search) < requests.indexOf(siblings[0]), 'the search listing precedes sibling details');
      assert.ok(requests.indexOf(`${root}careers/job/999/software-engineer`) < requests.indexOf(siblings[0]), 'its top results precede sibling details');
      // Positive: a GET search form is the same entry point.
      const form = await run({ ...base, [`${root}careers`]: careersHtml('<form method="get" action="/careers/search"><input type="text" name="keyword"></form>') });
      assert.ok(form.includes(search), 'a GET search form is followed');
      // Negatives: no search link; a hosted-ATS link; an unproven host; a non-GET form.
      const none = await run({ ...base, [`${root}careers`]: careersHtml('') });
      assert.ok(!none.some(url => url.includes('keyword=Software')), 'no search link, no lead');
      const ats = await run({ ...base, [`${root}careers`]: careersHtml('<a href="https://jobs.lever.co/northwind?search=intern">Jobs</a>') });
      assert.ok(!ats.some(url => url.includes('search=Software')), 'a hosted-ATS search link is not rewritten');
      const post = await run({ ...base, [`${root}careers`]: careersHtml('<form method="post" action="/careers/search"><input name="keyword"></form>') });
      assert.ok(!post.includes(search), 'a POST form is not a lead');
      const unproven = await run({ 'https://stranger.test/': '<title>Stranger Inc</title><a href="/careers">Careers</a>',
        'https://stranger.test/careers': careersHtml('<a href="https://stranger.test/careers/search?keyword=intern">Jobs</a>') }, { candidateUrls: ['https://stranger.test/careers'] });
      assert.ok(!unproven.some(url => url.includes('keyword=Software')), 'an unproven host is never searched');
    },
  },
  {
    name: 'A proven Phenom careers page with no anchors yields one title search of its own site, whose embedded jobs become detail links',
    async run() {
      const root = 'https://northwind.test/'; const siblings = Array.from({ length: 6 }, (_, i) => `${root}careers/en/job/R10${i}/Other-Role`);
      const bootstrap = host => `<script>var phApp = phApp || {};phApp = phApp || {"country":"careers","locale":"en_careers","baseUrl":"${host}careers/en/"};
        phApp.routes = {"search-results":"search-results"};</script>`;
      const careersHtml = (extra = bootstrap(root)) => `<title>Northwind Labs</title>${extra}`;
      const search = `${root}careers/en/search-results?keywords=Software+Engineer`;
      const results = `<title>Results</title>${bootstrap(root)}<script>phApp.ddo = {"eagerLoadRefineSearch":{"hits":2,"data":{"jobs":[
        {"jobId":"R999","title":"Software Engineer"},{"jobId":"R998","title":"Software Engineer: Data"}]}}};</script>`;
      const run = async (pages, candidateUrls = [root]) => {
        for (const url of siblings) pages[url] = '<main>Sibling</main>';
        const requests = [];
        await resolveOfficialPosting(row({ company: 'Northwind Labs', title: 'Software Engineer - Lakeview', snippet: description }), {
          semanticMatching: true, researchRan: true, persistResults: false, store: null, render: null, candidateUrls,
          fetch: network(pages, requests), match: async () => ({ choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['Order only.'] }),
        });
        return requests;
      };
      const base = { [root]: '<title>Northwind Labs</title><a href="/careers">Careers</a>', [search]: results,
        [`${root}careers/en/job/R999/Software-Engineer`]: '<main>The role</main>', [`${root}careers/en/job/R998/Software-Engineer-Data`]: '<main>Other</main>' };
      const requests = await run({ ...base, [`${root}careers`]: careersHtml() });
      assert.equal(requests.filter(url => url.includes('search-results')).length, 1, `once per host: ${requests.join(' ')}`);
      assert.ok(requests.includes(search), 'the Phenom keyword search is read');
      assert.ok(requests.includes(`${root}careers/en/job/R999/Software-Engineer`), 'an embedded result job is read');
      // Negatives: a page without the Phenom bootstrap; a baseUrl on another origin; an unproven host.
      const plain = await run({ ...base, [`${root}careers`]: careersHtml('<main>Jobs</main>') });
      assert.ok(!plain.some(url => url.includes('search-results')), 'a non-Phenom page has no search lead');
      const foreign = await run({ ...base, [`${root}careers`]: careersHtml(bootstrap('https://other.test/')) });
      assert.ok(!foreign.some(url => url.includes('search-results')), 'a foreign baseUrl is never followed');
      const unproven = await run({ 'https://stranger.test/': '<title>Stranger Inc</title><a href="/careers">Careers</a>',
        'https://stranger.test/careers': careersHtml(bootstrap('https://stranger.test/')) }, ['https://stranger.test/careers']);
      assert.ok(!unproven.some(url => url.includes('search-results')), 'an unproven host is never searched');
    },
  },
  {
    name: 'A proven employer page links a same-brand second domain as a root lead that must independently prove itself',
    async run() {
      const root = 'https://northwind.test/'; const other = 'https://northwindlabs.test/'; const board = 'https://job-boards.greenhouse.io/northwind';
      const target = `${board}/jobs/123456`; const api = 'https://boards-api.greenhouse.io/v1/boards/northwind/jobs/123456?questions=false';
      const posting = { contentType: 'application/json', body: JSON.stringify({ id: 123456, title: 'Software Engineer', company_name: 'Northwind Labs',
        absolute_url: target, location: { name: 'Lakeview, Ontario, Canada' }, content: description }) };
      for (const mode of ['same-brand', 'lookalike-fails-root', 'not-brand', 'ats-and-aggregator']) {
        const link = { 'same-brand': other, 'lookalike-fails-root': other, 'not-brand': 'https://unrelated.test/', 'ats-and-aggregator': 'https://jobs.lever.co/' }[mode];
        const pages = { [root]: `<title>Northwind Labs</title><a href="${link}">Our other site</a><a href="https://www.indeed.com/">Indeed</a><a href="https://www.greenhouse.io/">Greenhouse</a>`,
          [other]: `<title>${mode === 'lookalike-fails-root' ? 'Somebody Else' : 'Northwind Labs'}</title><a href="/careers">Careers</a>`,
          [`${other}careers`]: `<a href="${board}">Open roles</a>`, 'https://unrelated.test/': '<title>Northwind Labs</title><a href="/careers">Careers</a>',
          'https://unrelated.test/careers': `<a href="${board}">Open roles</a>`, [board]: '<main>Board</main>', [target]: '<main>Role</main>', [api]: posting };
        const requests = []; let comparisons = 0;
        await resolveOfficialPosting(row({ company: 'Northwind Labs', title: 'Software Engineer', snippet: description }), {
          semanticMatching: true, researchRan: true, persistResults: false, store: null, render: null,
          candidateUrls: [{ postingUrl: target, employer: 'Northwind Labs', employerDomain: root }], fetch: network(pages, requests),
          match: async (_job, options) => { comparisons++; assert.ok(options.some(option => option.sourceUrl === target && option.candidate.tenantProven), mode);
            return { choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['Source admission only.'] }; },
        });
        if (mode === 'same-brand') { assert.ok(requests.includes(other), 'the same-brand domain root is read'); assert.ok(comparisons >= 1, 'its careers link proves the exact tenant'); }
        if (mode === 'lookalike-fails-root') { assert.ok(requests.includes(other)); assert.equal(comparisons, 0, 'a root that fails rootProof proves nothing'); }
        if (mode === 'not-brand') assert.ok(!requests.includes('https://unrelated.test/'), 'a non-brand domain is not a lead');
        assert.ok(!requests.includes('https://jobs.lever.co/') && !requests.includes('https://www.indeed.com/') && !requests.includes('https://www.greenhouse.io/'), `${mode}: ATS and aggregator hosts are never roots`);
      }
    },
  },
];
