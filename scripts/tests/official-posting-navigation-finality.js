import assert from 'node:assert/strict';
import { resolveOfficialPosting, shouldPersistOfficialPostingResult } from '../../electron/ipc/officialPostingResolver.js';
import { officialPostingLookupStatus } from '../../electron/ipc/officialPostingFields.js';

const root = 'https://northwind.test/';
const account = '40000000-0000-4000-8000-000000000001';
const board = `https://recruiting.paylocity.com/Recruiting/Jobs/All/${account}`;
const detail = id => `https://recruiting.paylocity.com/Recruiting/Jobs/Details/${id}`;
const description = 'Build distributed systems for operational reporting. Maintain stable production services and collaborate with product managers to improve engineering workflows. '.repeat(4);
const job = { title: 'Target Engineer', company: 'Northwind Labs', location: 'Toronto, Ontario, Canada',
  snippet: description, url: 'https://www.linkedin.com/jobs/view/synthetic-navigation-finality' };
const jsonLd = (title, sourceUrl) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title,
  url: sourceUrl, hiringOrganization: { name: job.company }, description,
  jobLocation: { address: { addressLocality: 'Toronto', addressRegion: 'Ontario', addressCountry: 'Canada' } } })}</script>`;
const none = () => ({ choice: 'none', evidence: [], distinguishing: [], conflicts: ['The offered roles describe other work.'] });
const html = (url, body) => ({ url, statusCode: 200, contentType: 'text/html', body });

async function inventoryRun({ count = 9, chooseTarget = false, targetId = 109, domFallback = false } = {}) {
  const jobs = Array.from({ length: count }, (_, at) => ({ JobId: 101 + at, IsInternal: false, JobLocation: { ModuleId: 42 } }));
  const data = { ModuleId: '42', LeadJoinUrl: `/Recruiting/PublicLeads/New/${account}`, ShowInternal: false, Jobs: jobs };
  const pages = { [root]: `<title>Northwind Labs</title><a href="${board}">Careers</a>`,
    [board]: `<script>window.pageData=${JSON.stringify(data)};</script><script>window.ATSJobDetailsBaseUrl='/Recruiting/Jobs/Details/';</script>`
      + (domFallback ? jobs.slice(0, 8).map(item => `<a href="${detail(item.JobId)}">Role</a>`).join('') : '') };
  for (const item of jobs) pages[detail(item.JobId)] = `<a href="${board}">All jobs</a>${jsonLd(item.JobId === targetId ? job.title : `Other Engineer ${item.JobId}`, detail(item.JobId))}`;
  const reads = []; let comparisons = 0;
  const result = await resolveOfficialPosting(job, { semanticMatching: true, researchRan: true, persistResults: false,
    store: null, render: null, candidateUrls: [{ careersPageUrl: board, employerDomain: root, employer: job.company }],
    fetch: async url => { reads.push(url); if (!pages[url]) throw new Error('Unretained synthetic source'); return html(url, pages[url]); },
    match: async (_job, options) => {
      comparisons++;
      if (!chooseTarget) return none();
      const option = options.find(value => value.sourceUrl === detail(targetId));
      assert.ok(option, 'the positive control is one of the actually fetched options');
      return { choice: option.id, evidence: [{ scrapedQuote: description, officialQuote: option.description }], distinguishing: [], conflicts: [] };
    },
  });
  return { result, reads, comparisons };
}

export default [
  { name: 'A known ninth public inventory role skipped by navigation cap cannot establish a durable negative', async run() {
    const { result, reads, comparisons } = await inventoryRun();
    assert.equal(comparisons, 2); assert.equal(reads.includes(detail(109)), false);
    assert.equal(reads.filter(url => url.includes('/Details/')).length, 8);
    assert.ok(result.officialPosting.trail.includes('comparative-none'));
    assert.ok(result.officialPosting.trail.includes('crawl-partial'));
    assert.equal(shouldPersistOfficialPostingResult(result, { researchRan: true }), false);
    assert.equal(officialPostingLookupStatus(result.officialPosting).retryable, true);
  } },
  { name: 'Navigation-cap coverage still permits an independently agreed exact fetched eighth role', async run() {
    const { result, reads, comparisons } = await inventoryRun({ chooseTarget: true, targetId: 108 });
    assert.equal(comparisons, 2); assert.equal(reads.includes(detail(108)), true); assert.equal(reads.includes(detail(109)), false);
    assert.equal(result.officialPosting.outcome, 'found');
    assert.equal(result.officialPosting.sourceUrl, detail(108));
    assert.equal(shouldPersistOfficialPostingResult(result, { researchRan: true }), true);
  } },
  { name: 'Exactly eight complete public inventory roles can settle two valid semantic none judgments', async run() {
    const { result, comparisons } = await inventoryRun({ count: 8 });
    assert.equal(comparisons, 2); assert.equal(result.officialPosting.trail.includes('crawl-partial'), false);
    assert.equal(result.officialPosting.outcome, 'not-found');
    assert.equal(shouldPersistOfficialPostingResult(result, { researchRan: true }), true);
  } },
  { name: 'A bound oversized typed inventory cannot settle absence from eight readable fallback detail links', async run() {
    const { result, reads, comparisons } = await inventoryRun({ count: 513, targetId: 613, domFallback: true });
    assert.equal(comparisons, 2); assert.equal(reads.includes(detail(613)), false);
    assert.equal(reads.filter(url => url.includes('/Details/')).length, 8);
    assert.ok(result.officialPosting.trail.includes('crawl-partial'));
    assert.equal(shouldPersistOfficialPostingResult(result, { researchRan: true }), false);
    assert.equal(officialPostingLookupStatus(result.officialPosting).retryable, true);
  } },
  { name: 'A third proven empty careers page skipped by rendering allowance keeps negative coverage incomplete', async run() {
    const careers = [1, 2, 3].map(id => `${root}careers/region-${id}`); const other = `${root}jobs/other-role`;
    const pages = { [root]: `<title>Northwind Labs</title>${careers.map(url => `<a href="${url}">Careers</a>`).join('')}`,
      [other]: jsonLd('Other Engineer', other) };
    for (const url of careers) pages[url] = '<main>Current job openings load here.</main>';
    const rendered = []; let comparisons = 0;
    const result = await resolveOfficialPosting(job, { semanticMatching: true, researchRan: true, persistResults: false, store: null,
      candidateUrls: [{ postingUrl: other, employerDomain: root, employer: job.company }, ...careers],
      fetch: async url => { if (!pages[url]) throw new Error('Unretained synthetic source'); return html(url, pages[url]); },
      render: async url => { rendered.push(url); return html(url, url === careers[2] ? jsonLd(job.title, url) : '<main>No current roles.</main>'); },
      match: async () => { comparisons++; return none(); },
    });
    assert.equal(rendered.length, 2); assert.equal(rendered.includes(careers[2]), false); assert.equal(comparisons, 2);
    assert.ok(result.officialPosting.trail.includes('crawl-partial'));
    assert.equal(shouldPersistOfficialPostingResult(result, { researchRan: true }), false);
    assert.equal(officialPostingLookupStatus(result.officialPosting).retryable, true);
  } },
];
