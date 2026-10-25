import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOfficialPostingStore } from '../../electron/ipc/officialPostingStore.js';
import { officialPostingChunks, officialPostingRequestId } from '../../electron/ipc/officialPostingResolver.js';
import { getOfficialPostingView, officialPostingDedup, resolveOfficialPostings } from '../../electron/ipc/officialPostingService.js';

const description = 'Requirements include experience building reliable services and maintaining reporting workflows. Engineers design clear interfaces for dispatch teams and validate operational changes with careful review. The role includes improving data quality across scheduled pipelines and documenting decisions for partner teams. You will work with colleagues to investigate delivery failures and make service behavior understandable. Responsibilities include writing tests for new features and improving the tools used by support teams every day.';
const location = 'Lakeview, Ontario, Canada';
const row = (index = 1, extra = {}) => ({ title: `Engineer ${index}`, company: 'Northwind Labs', location,
  snippet: description, url: `https://mirror.example/jobs/${index}`, salaryProvenance: 'unknown', ...extra });
const sourceUrl = index => `https://northwind.test/jobs/${index}`;
function jsonld(job, text = description, extra = {}) {
  return `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: job.title,
    hiringOrganization: { name: 'Northwind Labs' }, description: text,
    jobLocation: { address: { addressLocality: 'Lakeview', addressRegion: 'Ontario', addressCountry: 'Canada' } }, ...extra })}</script>`;
}
function network(pages, requests = []) {
  return async url => {
    requests.push(url);
    if (!pages[url]) { const error = new Error('closed'); error.code = 'closed'; throw error; }
    return { url, contentType: 'text/html', statusCode: 200, body: pages[url] };
  };
}
async function withStore(run, options) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'official-service-'));
  const store = createOfficialPostingStore(path.join(root, 'official-postings'), options);
  try { await run(store); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
function members(prompt) { return prompt.match(/Requested ids: ([a-f0-9, ]+)\./u)[1].split(', '); }
function response(prompt, leads = new Map()) {
  return members(prompt).map(id => `BEGIN OFFICIAL POSTING RESEARCH ${id}\n${leads.has(id)
    ? `CANDIDATE: ${JSON.stringify({ careersPageUrl: '', postingUrl: leads.get(id), employer: 'Northwind Labs', employerDomain: '', ats: '' })}`
    : 'NOT FOUND'}\nEND OFFICIAL POSTING RESEARCH ${id}`).join('\n');
}
const metadata = (url, extra = {}) => ({ level: 'L1', outcome: 'found', employer: 'Northwind Labs', title: 'Engineer',
  sourceUrl: url, officialApplyUrl: url, trail: [], ...extra });

export default [
  {
    name: 'official-posting service host-verifies every row before full twelve-member research chunks and preserves scraped identity',
    async run() {
      await withStore(async store => {
        const jobs = Array.from({ length: 13 }, (_, index) => row(index + 1));
        jobs[0].url = sourceUrl(1);
        const before = JSON.stringify(jobs); const requests = []; const calls = []; const progress = [];
        const pages = { 'https://northwind.test/': '<title>Northwind Labs</title>' };
        const leads = new Map();
        for (const [index, job] of jobs.entries()) { pages[sourceUrl(index + 1)] = jsonld(job); leads.set(officialPostingRequestId(job), sourceUrl(index + 1)); }
        const result = await resolveOfficialPostings(jobs, { store, fetch: network(pages, requests), manualAiRunId: 'run-synthetic', nodeId: 'search-synthetic',
          onProgress: value => progress.push(value), callRaw: async (prompt, options) => {
            assert.ok(jobs.every(job => requests.includes(job.url)), 'every free host pass finishes before any research handoff');
            assert.equal(options.manualAiRunId, 'run-synthetic'); assert.equal(options.nodeId, 'search-synthetic');
            assert.equal(options.task, 'job-official-posting-research'); assert.equal(options.grounding, true);
            const raw = response(prompt, leads); options.responseValidator(raw); calls.push({ prompt, hints: options.hints }); return raw;
          } });
        assert.equal(JSON.stringify(jobs), before); assert.equal(result.jobs.length, 13);
        for (const [index, job] of result.jobs.entries()) {
          assert.equal(job.officialPosting.level, 'L1');
          for (const key of ['title', 'company', 'location', 'salary', 'snippet', 'url', 'googleCardUrl', 'sourceJobKey']) assert.equal(job[key], jobs[index][key]);
          assert.equal((await getOfficialPostingView(job, { store })).description, description);
        }
        assert.deepEqual(calls.map(call => call.hints), [{ itemCount: 12, batch: 1, batchTotal: 2 }, { itemCount: 1, batch: 2, batchTotal: 2 }]);
        assert.ok(calls.some(call => members(call.prompt).includes(officialPostingRequestId(jobs[0]))), 'a freely verified member remains in its unresolved chunk');
        assert.deepEqual(progress.at(-1), { completed: 13, total: 13 });
        assert.equal(result.telemetry.total, 13); assert.equal(result.telemetry.levels.L1, 13); assert.equal(result.telemetry.handoffs, 2);
        const cached = await resolveOfficialPostings(jobs, { store, fetch: () => { throw new Error('cached rows do not fetch'); }, callRaw: () => { throw new Error('all verified chunks do not ask AI'); } });
        assert.equal(cached.telemetry.handoffs, 0); assert.equal(cached.jobs.every(job => job.officialPosting.level === 'L1'), true);
      });
    },
  },
  {
    name: 'official-posting service stop after batch one and resume keep the next prompt and hints byte-identical despite saved misses',
    async run() {
      await withStore(async store => {
        const jobs = Array.from({ length: 25 }, (_, index) => row(index));
        const controller = new AbortController(); const stopped = []; const resumed = [];
        const first = await resolveOfficialPostings(jobs, { store, fetch: network({}), signal: controller.signal,
          callRaw: async (prompt, options) => { stopped.push({ prompt, hints: options.hints });
            if (options.hints.batch === 2) { controller.abort(); throw new Error('stopped'); }
            return response(prompt);
          } });
        assert.equal(stopped.length, 2); assert.equal(first.jobs.some(job => job.officialPosting.trail.includes('bridge-aborted')), true);
        const again = await resolveOfficialPostings(jobs, { store, fetch: network({}), callRaw: async (prompt, options) => {
          resumed.push({ prompt, hints: options.hints }); return response(prompt);
        } });
        assert.equal(resumed.length, 3, 'the first all-recent-miss chunk still consumes its deterministic full replay');
        assert.deepEqual(resumed[1], stopped[1]);
        assert.deepEqual(resumed.map(call => call.hints.itemCount), [12, 12, 1]);
        assert.ok(again.jobs.every(job => ['L5', 'L6'].includes(job.officialPosting.level)));
      });
    },
  },
  {
    name: 'official-posting service retains a cached miss until twenty-four hours while replaying its complete chunk without accepting fresh AI leads',
    async run() {
      let time = Date.parse('2026-01-01T00:00:00Z');
      await withStore(async store => {
        const job = row(); const old = await store.save(job, { officialPosting: { level: 'L5', outcome: 'not-found', employer: job.company, trail: [] } });
        const leads = new Map([[officialPostingRequestId(job), sourceUrl(1)]]); let fetches = 0; let handoffs = 0;
        time += 1000;
        const recent = await resolveOfficialPostings([job], { store, now: () => time, fetch: async () => { fetches++; throw new Error('cached miss'); },
          callRaw: async prompt => { handoffs++; return response(prompt, leads); } });
        assert.equal(recent.jobs[0].officialPosting.level, 'L5'); assert.ok(recent.jobs[0].officialPosting.trail.includes('recent-miss'));
        assert.equal(fetches, 0); assert.equal(handoffs, 1); assert.equal((await store.find(job)).savedAt, old.savedAt);
        time += 24 * 60 * 60 * 1000;
        const found = await resolveOfficialPostings([job], { store, now: () => time, fetch: network({ 'https://northwind.test/': '<title>Northwind Labs</title>', [sourceUrl(1)]: jsonld(job) }),
          callRaw: async prompt => response(prompt, leads) });
        assert.equal(found.jobs[0].officialPosting.level, 'L1');
      }, { now: () => time });
    },
  },
  {
    name: 'official-posting service caps each research handoff with linked abort and degrades timeout or unavailable bridge without retrying its rows',
    async run() {
      await withStore(async store => {
        let calls = 0; let aborted = false;
        const timed = await resolveOfficialPostings([row()], { store, fetch: network({}), timeoutMs: 5,
          callRaw: (prompt, { signal }) => { calls++; signal.addEventListener('abort', () => { aborted = true; });
            return new Promise(resolve => setTimeout(() => resolve(response(prompt)), 25)); } });
        assert.equal(calls, 1); assert.equal(aborted, true); assert.ok(timed.jobs[0].officialPosting.trail.includes('bridge-timeout'));
        assert.equal(timed.telemetry.bridgeTimeout, 1); assert.equal(timed.telemetry.handoffs, 1);
        const unavailable = await resolveOfficialPostings([row(2, { company: 'Acme Talent Partners', snippet: `Our client is hiring. ${description}` })], {
          store, fetch: network({}), bridgeAvailable: false, callRaw: () => { throw new Error('disabled'); } });
        assert.equal(unavailable.jobs[0].officialPosting.level, 'L6'); assert.ok(unavailable.jobs[0].officialPosting.trail.includes('bridge-unavailable'));
        assert.equal(unavailable.telemetry.bridgeUnavailable, 1); assert.equal(unavailable.telemetry.handoffs, 0);
        assert.equal(/Requirements include|Northwind|Acme/u.test(JSON.stringify(timed.telemetry)), false, 'telemetry contains counts and enums only');
      });
    },
  },
  {
    name: 'official-posting service uses quoted JSON matching only for a host hard-pass candidate and counts material text changes',
    async run() {
      await withStore(async store => {
        const scraped = 'The hired engineer will create software for local dispatch operators every morning. This position focuses on clear account reports across the entire delivery network. Applicants should understand how to explain design decisions to experienced business partners. You will coordinate regularly with regional teams and review all workflow changes carefully.';
        const official = 'Requirements include creating operational applications for regional logistics groups throughout each working week. The role maintains readable financial summaries within a broad freight planning organization. Engineers need experience communicating implementation choices with established customer representatives and project leads. Responsibilities involve collaborating with local departments while inspecting proposed process updates thoroughly.';
        const job = row(1, { snippet: scraped, url: sourceUrl(1) });
        const left = scraped.split(/(?<=\.)\s+/u); const right = official.split(/(?<=\.)\s+/u);
        const answer = { sameJob: true, matchingPairs: [0, 1, 3].map(index => ({ scrapedQuote: left[index], officialQuote: right[index] })), conflicts: [] };
        const calls = [];
        const result = await resolveOfficialPostings([job], { store, fetch: network({ 'https://northwind.test/': '<title>Northwind Labs</title>', [sourceUrl(1)]: jsonld(job, official) }),
          callRaw: async (prompt, options) => { calls.push(options.task); const raw = options.task.endsWith('-research') ? response(prompt) : answer;
            options.responseValidator(raw); return raw; } });
        assert.deepEqual(calls, ['job-official-posting-research', 'job-official-posting-match']);
        assert.equal(result.jobs[0].officialPosting.level, 'L1'); assert.ok(result.jobs[0].officialPosting.trail.includes('quoted-match'));
        assert.equal((await getOfficialPostingView(result.jobs[0], { store })).description, official);
        assert.equal(result.telemetry.materialJdChange, 1); assert.equal(result.telemetry.handoffs, 2);
        assert.ok((await store.find(job)).officialPosting.trail.includes('material-jd-change'), 'the durable verified record retains the material-change enum');
      });
    },
  },
  {
    name: 'official-posting service never retries another comparison for a row after a match timeout and never compares a hard-gate mismatch',
    async run() {
      await withStore(async store => {
        const reversed = description.split(/\s+/u).reverse().join(' ');
        const job = row(1, { applyOptions: [{ label: 'One', href: sourceUrl(1) }, { label: 'Two', href: sourceUrl(2) }] });
        const pages = { 'https://northwind.test/': '<title>Northwind Labs</title>', [sourceUrl(1)]: jsonld(job, reversed), [sourceUrl(2)]: jsonld(job, reversed) };
        let matches = 0; let aborted = false;
        const result = await resolveOfficialPostings([job], { store, fetch: network(pages), timeoutMs: 5,
          callRaw: async (prompt, options) => {
            if (options.task.endsWith('-research')) return response(prompt);
            matches++; options.signal.addEventListener('abort', () => { aborted = true; });
            return new Promise(resolve => setTimeout(() => resolve({ sameJob: false, matchingPairs: [], conflicts: [] }), 25));
          } });
        assert.equal(matches, 1, 'a second unresolved candidate cannot trigger another handoff after the first timeout');
        assert.equal(aborted, true); assert.equal(result.telemetry.bridgeTimeout, 1);
        assert.ok(result.jobs[0].officialPosting.trail.includes('bridge-timeout')); assert.equal(result.jobs[0].officialPosting.level, 'L5');
        const mismatch = row(2, { title: 'Staff Engineer', applyOptions: [{ label: 'One', href: sourceUrl(1) }] });
        const hard = await resolveOfficialPostings([mismatch], { store, fetch: network(pages), callRaw: async (prompt, options) => {
          assert.equal(options.task, 'job-official-posting-research', 'a title mismatch cannot reach JSON comparison'); return response(prompt);
        } });
        assert.equal(hard.telemetry.handoffs, 1); assert.ok(hard.jobs[0].officialPosting.trail.includes('title-mismatch'));
      });
    },
  },
  {
    name: 'official-posting material-change feedback compares the complete record and preserves a concurrent proof upgrade',
    async run() {
      await withStore(async store => {
        const job = row(1, { snippet: 'A compact scraped summary describes entirely different responsibilities.' });
        const old = await store.save(job, { officialPosting: metadata(sourceUrl(1), { level: 'L3', title: job.title }), description });
        let compared = false;
        const racingStore = { ...store, save: async (savedJob, payload) => {
          if (payload.expectedRecord) {
            compared = true; assert.deepEqual(payload.expectedRecord, old);
            await store.save(savedJob, { officialPosting: { ...old.officialPosting, level: 'L2', trail: ['reverified'] } });
          }
          return store.save(savedJob, payload);
        } };
        const result = await resolveOfficialPostings([job], { store: racingStore,
          fetch: () => { throw new Error('verified cache'); }, callRaw: () => { throw new Error('verified cache'); } });
        assert.equal(compared, true); assert.equal(result.telemetry.materialJdChange, 1);
        const current = await store.find(job);
        assert.equal(current.officialPosting.level, 'L2'); assert.deepEqual(current.officialPosting.trail, ['reverified']);
        assert.equal(current.officialPosting.contentHash, old.officialPosting.contentHash);
      });
    },
  },
  {
    name: 'official-posting service missing-text view restores only the stored hash through host extraction and leaves historical rows scraped',
    async run() {
      await withStore(async store => {
        const job = row(1, { company: 'Acme Talent Partners', title: 'Engineer 1 at Northwind Labs' });
        const record = await store.save(job, { officialPosting: metadata(sourceUrl(1), { title: 'Engineer 1' }), description });
        await fs.unlink(path.join(store.rootDir, 'texts', `${record.officialPosting.contentHash}.txt`));
        let fetches = 0;
        const fetch = async url => { fetches++; assert.equal(url, sourceUrl(1)); return { url, contentType: 'text/html', body: jsonld({ title: 'Engineer 1' }) }; };
        const historical = await getOfficialPostingView(job, { store, fetch });
        assert.equal(historical.employer, job.company); assert.equal(historical.title, job.title); assert.equal(fetches, 0);
        const bound = { ...job, officialPosting: { ...record.officialPosting, sourceUrl: 'https://forged.example/jobs/one' } };
        const restored = await getOfficialPostingView(bound, { store, fetch });
        assert.equal(restored.description, description); assert.equal(restored.employer, 'Northwind Labs'); assert.equal(fetches, 1);
        assert.equal((await getOfficialPostingView(bound, { store, fetch })).description, description); assert.equal(fetches, 1);
      });
    },
  },
  {
    name: 'official-posting dedup keeps first verified posting or its own official URL, folds stable ATS ids and never folds L4–L6',
    run() {
      const officialUrl = 'https://jobs.lever.co/northwind/req-one';
      const mirror = row(1, { officialPosting: metadata(officialUrl, { level: 'L3' }) });
      const own = row(2, { url: officialUrl, officialPosting: metadata(officialUrl, { level: 'L3' }) });
      const later = row(3, { officialPosting: metadata(`${officialUrl}?lang=fr`, { level: 'L3' }) });
      const fallback = ['L4', 'L5', 'L6'].map((level, index) => row(index + 4, { officialPosting: metadata(officialUrl, { level, outcome: level === 'L4' ? 'link-only' : 'not-found' }) }));
      const result = officialPostingDedup([mirror, own, later, ...fallback]);
      assert.deepEqual(result.kept, [own, ...fallback]); assert.equal(result.dropped.length, 2);
      assert.deepEqual(result.dropped.map(item => [item.kept, item.dropped, item.reason, item.stage]), [
        [own, mirror, 'official-url', 'official-posting'], [own, later, 'official-ats-id', 'official-posting'],
      ]);
      const first = officialPostingDedup([mirror, { ...mirror }]); assert.equal(first.kept[0], mirror);
      assert.equal(officialPostingChunks(Array.from({ length: 13 }, (_, index) => row(index))).length, 2);
    },
  },
];
