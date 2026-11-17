import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOfficialPostingStore } from '../../electron/ipc/officialPostingStore.js';
import { getPreparedOfficialPosting, prepareOfficialPostingForGeneration } from '../../electron/ipc/officialPostingGeneration.js';
import { OfficialPostingFetchError } from '../../electron/ipc/officialPostingFetch.js';
import { OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL } from '../../electron/ipc/officialPostingNegativePolicy.js';

const description = 'Requirements include experience building reliable dispatch tools and maintaining reporting workflows. Engineers design clear interfaces for operations teams and validate changes through careful review. The role improves data quality across scheduled pipelines and documents decisions for partner groups. You will collaborate with colleagues to investigate delivery failures and make service behavior understandable. Responsibilities include writing tests for new features and improving tools that support teams use every day.';
const location = 'Lakeview, Ontario, Canada';
const sourceUrl = 'https://northwind.test/jobs/dispatch';
const row = (extra = {}) => ({ title: 'Software Engineer at Northwind Labs', company: 'Acme Talent Partners', location,
  snippet: `Our client is hiring. ${description}`, url: 'https://mirror.example/jobs/dispatch', sourceJobKey: 'r4-dispatch', ...extra });
const args = job => ({ job, nodeId: 'r4-board', cardId: 'r4-card', manualAiRunId: 'r4-generation-run' });
const posting = (extra = {}) => ({ level: 'L2', outcome: 'found', employer: 'Northwind Labs', title: 'Software Engineer',
  sourceUrl, officialApplyUrl: sourceUrl, location: { display: location, remote: false, workMode: '', remoteCountry: '', remoteRegion: '' },
  salary: { text: '', provenance: 'unknown' }, trail: ['description-anchor'], ...extra });
function html(text = description, extra = {}) {
  return `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Software Engineer',
    hiringOrganization: { name: 'Northwind Labs' }, description: text,
    jobLocation: { address: { addressLocality: 'Lakeview', addressRegion: 'Ontario', addressCountry: 'Canada' } }, ...extra })}</script>`;
}
const page = (body, extra = {}) => ({ url: sourceUrl, statusCode: 200, contentType: 'text/html', body, ...extra });
const missResponse = prompt => prompt.match(/Requested ids: ([a-f0-9, ]+)\./u)[1].split(', ').map(id =>
  `BEGIN OFFICIAL POSTING RESEARCH ${id}\nNOT FOUND\nEND OFFICIAL POSTING RESEARCH ${id}`).join('\n');
async function withStore(run, options) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'official-r4-generation-'));
  try { await run(createOfficialPostingStore(path.join(root, 'official-postings'), options)); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
export default [
  {
    name: 'Amendment 4 Generate retries old partial text-only records without reverify fallback or resaving the unsafe proof',
    async run() {
      for (const partial of ['fetch-timeout', 'crawl-budget']) for (const failedRecheck of [false, true]) for (const resolverFails of [false, true]) await withStore(async store => {
        const job = row();
        const before = await store.save(job, { officialPosting: posting({ trail: ['description-anchor', partial, ...(failedRecheck ? ['reverify-failed'] : [])] }), description });
        let calls = 0; let reads = 0; let saves = 0;
        const counted = { ...store, save: async (...values) => { saves++; return store.save(...values); } };
        const result = await prepareOfficialPostingForGeneration(args(job), { store: counted,
          fetch: async () => { reads++; return page(html()); },
          resolve: async jobs => { calls++; if (resolverFails) throw Object.assign(new Error('failed'), { code: 'fetch-failed' });
            return { jobs: jobs.map(value => ({ ...value, officialPosting: { level: 'L5', outcome: 'not-found', employer: value.company, trail: [] } })) }; } });
        assert.equal(calls, 1, 'unsafe partial proof falls through to fresh resolution');
        assert.equal(reads, 0, 'it is never reverified as trusted cached proof');
        assert.equal(saves, 0, 'failed fresh research cannot re-save an unsafe cached result');
        assert.ok(['L5', 'L6'].includes(result.officialPosting.level));
        assert.equal(getPreparedOfficialPosting(result.resolutionId, job).description, undefined);
        assert.deepEqual(await store.find(job), before, 'the old record remains intact for review');
      });
    },
  },
  {
    name: 'Generate retries unavailable research on the Claude worker',
    async run() {
      for (const legacy of [false, true]) await withStore(async store => {
        const job = row(); let calls = 0;
        if (legacy) await store.save(job, { officialPosting: { level: 'L6', outcome: 'not-found', employer: '', trail: ['bridge-unavailable'] } });
        const fetch = async () => { throw Object.assign(new Error('unavailable'), { code: 'fetch-failed' }); };
        const callRaw = async (prompt, options) => { calls++; const raw = missResponse(prompt); options.responseValidator(raw); return raw; };
        const active = await prepareOfficialPostingForGeneration(args(job), { store, fetch, callRaw });
        assert.equal(calls, 2, legacy ? 'old unavailable misses retry' : 'a fresh click researches with one extra search');
        assert.equal(active.officialPosting.trail.includes('recent-miss'), false);
        assert.ok(active.officialPosting.trail.includes('worker-research'));
      });
    },
  },
  {
    name: 'Generate forwards finder and judge callers through the real single-row service and stores the judged text',
    async run() {
      await withStore(async store => {
        const posting = 'https://job-boards.greenhouse.io/northwind/jobs/4455667'; const careers = 'https://northwind.test/careers';
        const official = 'Northwind Labs is hiring a Dispatch Engineer to build reliable routing services for regional delivery teams.\n'
          + 'Design the dispatch scheduling service and its reporting pipeline.\nReview route reports with operations leads every week.';
        const job = row({ title: 'Dispatch Engineer', company: 'Northwind Labs', snippet: official, sourceJobKey: 'r4-judge' });
        const offline = async () => { throw Object.assign(new Error('offline test'), { code: 'fetch-failed' }); };
        const calls = [];
        const prepared = await prepareOfficialPostingForGeneration(args(job), { store, fetch: offline,
          callRaw: async (prompt, options) => {
            assert.equal(options.task, 'job-official-posting-research');
            const ids = prompt.match(/Requested ids: ([a-f0-9, ]+)\./u)[1].split(', ');
            return ids.map(id => `BEGIN OFFICIAL POSTING RESEARCH ${id}\nCANDIDATE: ${JSON.stringify({ careersPageUrl: careers, postingUrl: posting,
              employer: 'Northwind Labs', employerDomain: 'https://northwind.test', ats: 'Greenhouse' })}\nEND OFFICIAL POSTING RESEARCH ${id}`).join('\n');
          }, callMatch: async (prompt, options) => {
            calls.push(options.manualHandoff);
            const leadsJson = JSON.parse(prompt.split('BEGIN HOST LEADS JSON\n')[1].split('\nEND HOST LEADS JSON')[0]);
            return JSON.stringify({ choice: leadsJson.find(lead => lead.url === posting).id, postingUrl: posting, status: 'open', statusQuote: 'Apply for this job',
              employerLinked: true, employerPageUrl: careers, employerLinkQuote: 'View open roles', title: 'Dispatch Engineer', employer: 'Northwind Labs',
              location, salary: '', description: official,
              evidence: [{ scrapedQuote: 'Review route reports with operations leads every week.', officialQuote: 'Review route reports with operations leads every week.' }],
              conflicts: [] });
          } });
        assert.equal(prepared.officialPosting.outcome, 'found'); assert.equal(prepared.officialPosting.sourceUrl, posting);
        assert.ok(prepared.officialPosting.trail.includes('comparative-match'));
        assert.equal(prepared.telemetry.officialPosting.comparisons, 1);
        assert.equal(prepared.telemetry.officialPosting.comparativeAgreements, 1);
        assert.equal(prepared.telemetry.officialPosting.comparativeMatches, 1);
        assert.equal(/Northwind|Quote|prompt|evidence/u.test(JSON.stringify(prepared.telemetry)), false);
        assert.deepEqual(calls.map(call => call.comparisonRun), ['A', 'B']);
        assert.equal(calls[0].comparisonGroup, calls[1].comparisonGroup);
        const trusted = getPreparedOfficialPosting(prepared.resolutionId, job);
        assert.ok(trusted.description.includes('Review route reports with operations leads every week.'));
        assert.equal(trusted.applyUrl, posting);
        assert.ok((await store.find(job)).officialPosting.trail.includes('comparative-match'));
      });
    },
  },
];
