import assert from 'node:assert/strict';
import { resolveOfficialPostings } from '../../electron/ipc/officialPostingService.js';
import { officialPostingRequestId } from '../../electron/ipc/officialPostingResolver.js';

const root = 'https://northwind.test/';
const careers = `${root}careers`;
const hiring = `${root}hiring`;
const tenant = 'https://jobs.ashbyhq.com/northwind';
const posting = `${tenant}/req-one`;
const api = 'https://api.ashbyhq.com/posting-api/job-board/northwind?includeCompensation=true';
const description = 'Build reliable services for dispatch teams and maintain reporting workflows. Design clear interfaces, validate operational changes, investigate delivery failures, and improve the tools used by support teams. The work includes improving data quality across scheduled pipelines, writing tests for new features, documenting decisions, and collaborating with product engineers to deliver understandable service behavior.';
const job = { title: 'Software Engineer', company: 'Northwind Labs', location: 'Lakeview, Ontario, Canada',
  snippet: description, url: 'https://mirror.example/jobs/one', salaryProvenance: 'unknown' };

async function runTwoPass({ resourceOnly = false, failedFirst = false, incompleteFirst = false,
  explicitCareers = true, renderedFlag = true, redirectedCareers = false } = {}) {
  const events = []; let phase = 'initial';
  const destination = resourceOnly ? 'https://job-boards.greenhouse.io/northwind/jobs/123456' : posting;
  const resourceApi = 'https://boards-api.greenhouse.io/v1/boards/northwind/jobs?content=true';
  const pages = {
    [root]: `<title>Northwind Labs</title><a href="${careers}">Careers</a>${failedFirst ? `<a href="${hiring}">Hiring</a>` : ''}`,
    [careers]: redirectedCareers ? { url: `${root}careers/index.html`, body: '<main>Open positions load using JavaScript.</main>' }
      : '<main>Open positions load using JavaScript.</main>',
    [hiring]: '<main>Our hiring opportunities load using JavaScript.</main>',
    [tenant]: '<main>Available jobs</main>',
    [posting]: '<main>Software Engineer</main>',
    [destination]: '<main>Software Engineer</main>',
    [api]: { contentType: 'application/json', body: JSON.stringify({ jobs: [{ id: 'req-one', title: job.title,
      location: job.location, jobUrl: posting, applyUrl: `${posting}/application`,
      descriptionPlain: description, isListed: true }] }) },
    [resourceApi]: { contentType: 'application/json', body: JSON.stringify({ jobs: [{ id: 123456,
      title: job.title, company_name: job.company, location: { name: job.location },
      absolute_url: destination, content: description }] }) },
  };
  const fetch = async url => {
    events.push({ type: 'fetch', phase, url });
    if (!pages[url]) throw Object.assign(new Error('Unavailable'), { code: 'closed' });
    const value = pages[url];
    return { url, statusCode: 200, contentType: 'text/html', ...(typeof value === 'string' ? { body: value } : value) };
  };
  const result = await resolveOfficialPostings([job], {
    store: { find: async () => null, save: async (_job, record) => record }, bypassCache: true, semanticMatching: true,
    candidateUrls: [{ careersPageUrl: careers, employerDomain: root, employer: job.company }],
    fetchSession: { fetch, telemetry: () => ({}), retryFailedUrls() {} },
    render: async url => {
      events.push({ type: 'render', phase, url });
      if (failedFirst && phase === 'initial') throw Object.assign(new Error('Transient rendering failure'), { code: 'fetch-timeout' });
      return { url, statusCode: 200, contentType: 'text/html', ...(renderedFlag ? { rendered: true } : {}),
        incomplete: incompleteFirst && phase === 'initial',
        body: resourceOnly ? '<main>Open positions loaded.</main>' : `<a href="${tenant}">View jobs</a>`,
        resourceLinks: resourceOnly ? [resourceApi] : [] };
    },
    callRaw: async () => {
      events.push({ type: 'research', phase }); phase = 'researched';
      const id = officialPostingRequestId(job);
      return `BEGIN OFFICIAL POSTING RESEARCH ${id}\nCANDIDATE: ${JSON.stringify({ postingUrl: destination,
        careersPageUrl: explicitCareers ? careers : '', employerDomain: root, employer: job.company,
        ats: resourceOnly ? 'greenhouse' : 'ashby' })}\nEND OFFICIAL POSTING RESEARCH ${id}`;
    },
    callMatch: async () => {
      events.push({ type: 'comparison', phase });
      return { choice: 'uncertain', evidence: [], distinguishing: [], conflicts: ['This fixture checks source eligibility only.'] };
    },
  });
  return { events, result };
}

export default [
  { name: 'service researched pass reuses cached successful rendered careers DOM without rendering twice', async run() {
    for (const renderedFlag of [true, false]) {
      const { events } = await runTwoPass({ renderedFlag });
      assert.equal(events.filter(event => event.type === 'render').length, 1,
        'the host stamps successful rendered pages even when an injected renderer omits the flag');
      assert.equal(events.filter(event => event.type === 'comparison' && event.phase === 'initial').length, 2);
      assert.equal(events.filter(event => event.type === 'comparison' && event.phase === 'researched').length, 2,
        'cached rendered employer-to-tenant links still admit the exact researched posting');
    }
  } },
  { name: 'service researched pass retains actual ATS resource receipts from cached rendered careers pages', async run() {
    const { events } = await runTwoPass({ resourceOnly: true });
    assert.equal(events.filter(event => event.type === 'render').length, 1);
    assert.equal(events.filter(event => event.type === 'comparison' && event.phase === 'initial').length, 2);
    assert.equal(events.filter(event => event.type === 'comparison' && event.phase === 'researched').length, 2,
      'cached own-main-frame ATS JSON receipts must remain available after research');
  } },
  { name: 'service successful rendered careers redirects replace the original requested URL cache entry as well', async run() {
    const { events } = await runTwoPass({ redirectedCareers: true });
    assert.equal(events.filter(event => event.type === 'render').length, 1,
      'the original careers URL must reuse the rendered redirect destination after research');
    assert.equal(events.filter(event => event.type === 'comparison' && event.phase === 'researched').length, 2);
  } },
  { name: 'service fresh researched budget retries an explicitly researched careers URL after initial rendering failures', async run() {
    const { events } = await runTwoPass({ failedFirst: true });
    assert.equal(events.filter(event => event.type === 'render' && event.phase === 'initial').length, 2,
      'initial discovery is still bounded to two rendering attempts');
    assert.equal(events.filter(event => event.type === 'render' && event.phase === 'researched' && event.url === careers).length, 1,
      'a new researched URL gets a bounded retry after its failed initial rendering attempt');
    assert.equal(events.filter(event => event.type === 'comparison' && event.phase === 'researched').length, 2);
  } },
  { name: 'service retries an explicitly researched incomplete rendered careers response within its fresh render cap', async run() {
    const { events } = await runTwoPass({ incompleteFirst: true });
    assert.equal(events.filter(event => event.type === 'render' && event.phase === 'initial').length, 1);
    assert.equal(events.filter(event => event.type === 'render' && event.phase === 'researched').length, 1);
    assert.equal(events.filter(event => event.type === 'fetch' && event.phase === 'researched' && event.url === careers).length, 1,
      'the retry obtains the original transport document before rendering again');
    assert.equal(events.filter(event => event.type === 'comparison' && event.phase === 'researched').length, 2);
  } },
  { name: 'service cached incomplete renderer receipt remains partial when research did not explicitly refresh that careers URL', async run() {
    const { events, result } = await runTwoPass({ incompleteFirst: true, explicitCareers: false, resourceOnly: true });
    assert.equal(events.filter(event => event.type === 'render').length, 1);
    assert.equal(events.filter(event => event.type === 'comparison' && event.phase === 'researched').length, 2);
    assert.ok(result.jobs[0].officialPosting.trail.includes('crawl-partial'), 'incomplete cached receipt cannot become a completed miss');
  } },
];
