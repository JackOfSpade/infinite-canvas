import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOfficialPostingStore } from '../../electron/ipc/officialPostingStore.js';
import { officialPostingChunks, officialPostingRequestId } from '../../electron/ipc/officialPostingResolver.js';
import { getOfficialPostingView, officialPostingDedup, resolveOfficialPostings } from '../../electron/ipc/officialPostingService.js';
import { CONSTANTS } from '../../electron/ipc/handoffBridge/constants.js';
import { buildOfficialPostingMatchRequest } from '../../electron/ipc/officialPostingBridge.js';

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
    name: 'Amendment 8 item 1 transport: service keeps hidden contradiction text host-only in both validation paths',
    async run() {
      const shared = description.split(/(?<=\.)\s+/u);
      const trueTeam = 'Team: Payments Platform. You will own the settlement services for the payments platform group and its on call rotation.';
      const wrongTeam = 'Team: Risk Engineering. You will own the fraud scoring services for the risk engineering group and its on call rotation.';
      const recruiter = 'Recruiters note that the candidate will join a friendly group.';
      const job = row(1, { snippet: `${trueTeam} ${recruiter} ${shared[0]} Occasional travel may be needed. ${shared[4]} Mentoring newer colleagues is encouraged.` });
      const candidate = { employer: job.company, title: job.title, location, sourceUrl: sourceUrl('visible') };
      const options = [{ id: 'P1', status: 'live', title: job.title, location, candidate,
        description: `${wrongTeam} ${description} Visible scope zero owns regional review procedures.` }];
      const contradictionOnly = [{ candidate: { ...candidate, sourceUrl: sourceUrl('hidden-pay-veto') },
        description: `${trueTeam} HIDDEN SOURCE ONLY: This separate historical description records a different operating scope. ${description}` }];
      const answer = { choice: 'P1', conflicts: [], evidence: [
        { scrapedQuote: shared[0], officialQuote: shared[0] },
        { scrapedQuote: shared[4], officialQuote: `${shared[4]} Visible scope zero owns regional review procedures.` },
        { scrapedQuote: recruiter, officialQuote: wrongTeam },
      ], distinguishing: [] };
      const visible = buildOfficialPostingMatchRequest({ job, options, run: 'A' });
      assert.doesNotThrow(() => visible.responseValidator(answer), 'the hidden posting is the reason this otherwise valid answer must fail');
      for (const invokeTransportValidator of [true, false]) {
        let calls = 0;
        let transportValidator;
        const result = await resolveOfficialPostings([job], { store: { find: async () => null }, fetch: network({}),
          resolve: async (input, context) => {
            if (!context.match) return { officialPosting: { level: 'L5', outcome: 'not-found', employer: input.company, trail: [] } };
            await assert.rejects(() => context.match(input, options, { run: 'A', contradictionOnly }),
              error => error.code === 'comparative-invalid');
            return { officialPosting: { level: 'L5', outcome: 'not-found', employer: input.company, trail: ['comparative-invalid'] } };
          }, callRaw: async (prompt, context) => {
            if (context.task.endsWith('-research')) return response(prompt);
            calls++;
            transportValidator = context.responseValidator;
            assert.equal(prompt, visible.prompt, 'hidden source bytes never enter the AI prompt');
            assert.equal(JSON.stringify(context.responseSchema).includes('HIDDEN SOURCE ONLY'), false);
            if (invokeTransportValidator) context.responseValidator(answer);
            return answer;
          } });
        if (invokeTransportValidator) assert.throws(() => transportValidator(answer),
          error => error.correctionRuleIds?.includes('LOOKUP_OFFICIAL_MATCH_DISTINCTIVE'),
          'the validator supplied to the transport rejects hidden contradictions independently');
        assert.equal(calls, 2, 'an invalid answer gets one correction before the service rejects it');
        assert.ok(result.jobs[0].officialPosting.trail.includes('comparative-invalid'));
      }
    },
  },
  {
    name: 'official-posting service host-verifies every row before full twelve-member research chunks and preserves scraped identity',
    async run() {
      await withStore(async store => {
        const jobs = Array.from({ length: 13 }, (_, index) => row(index + 1));
        // Each unavailable mirror is a different host, so this ordering
        // fixture does not trip the independently tested per-host breaker.
        for (const [index, job] of jobs.entries()) job.url = `https://mirror-${index}.example/jobs/${index + 1}`;
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
        for (const [index, job] of jobs.entries()) job.url = `https://mirror-${index}.example/jobs/${index}`;
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
        assert.equal(resumed.length, 2, 'an all-settled miss chunk no longer dispatches a handoff');
        assert.deepEqual(resumed[0], stopped[1]);
        assert.deepEqual(resumed.map(call => call.hints.itemCount), [12, 1]);
        assert.deepEqual(resumed.map(call => [call.hints.batch, call.hints.batchTotal]), [[2, 3], [3, 3]], 'remaining raw-input chunks retain their original deterministic hints');
        assert.ok(again.jobs.every(job => ['L5', 'L6'].includes(job.officialPosting.level)));
      });
    },
  },
  {
    name: 'official-posting service retains a definitive cached miss until twenty-four hours without a fresh handoff',
    async run() {
      let time = Date.parse('2026-01-01T00:00:00Z');
      await withStore(async store => {
        const job = row(); const old = await store.save(job, { officialPosting: { level: 'L5', outcome: 'not-found', employer: job.company, trail: ['bridge-research'] } });
        const leads = new Map([[officialPostingRequestId(job), sourceUrl(1)]]); let fetches = 0; let handoffs = 0;
        time += 1000;
        const recent = await resolveOfficialPostings([job], { store, now: () => time, fetch: async () => { fetches++; throw new Error('cached miss'); },
          callRaw: async prompt => { handoffs++; return response(prompt, leads); } });
        assert.equal(recent.jobs[0].officialPosting.level, 'L5'); assert.ok(recent.jobs[0].officialPosting.trail.includes('recent-miss'));
        assert.equal(fetches, 0); assert.equal(handoffs, 0); assert.equal((await store.find(job)).savedAt, old.savedAt);
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
        assert.equal(await store.find(row()), null, 'a timed-out research handoff does not store a miss');
        const unavailable = await resolveOfficialPostings([row(2, { company: 'Acme Talent Partners', snippet: `Our client is hiring. ${description}` })], {
          store, fetch: network({}), bridgeAvailable: false, callRaw: () => { throw new Error('disabled'); } });
        assert.equal(unavailable.jobs[0].officialPosting.level, 'L6'); assert.ok(unavailable.jobs[0].officialPosting.trail.includes('bridge-unavailable'));
        assert.equal(unavailable.telemetry.bridgeUnavailable, 1); assert.equal(unavailable.telemetry.handoffs, 0);
        assert.equal(await store.find(row(2, { company: 'Acme Talent Partners', snippet: `Our client is hiring. ${description}` })), null, 'an unavailable bridge does not store a miss');
        assert.equal(/Requirements include|Northwind|Acme/u.test(JSON.stringify(timed.telemetry)), false, 'telemetry contains counts and enums only');
      });
    },
  },
  {
    name: 'official-posting service uses two comparative JSON judgments for a host identity-pass candidate and counts material text changes',
    async run() {
      await withStore(async store => {
        const scraped = 'The engineer creates dispatch software for operators and reviews delayed routing records every morning. Account reports across the delivery network need clear explanations for regional planning partners. Applicants should understand how to explain design decisions to experienced business partners. Coordinate regularly with regional teams and review workflow changes through diagnostic tests before release.';
        const official = 'Requirements: operators rely on dispatch software; engineer responsibilities include reviews of delayed routing records. Responsibilities include clear account reports, delivery network explanations, and coordination with regional planning partners. Engineers need experience communicating implementation choices with established customer representatives and project leads. You will coordinate diagnostic tests, review release readiness, and discuss workflow changes with regional teams.';
        // Amendment 3: the row's own url is a lead identity anchor, so this posting arrives through the research lead instead.
        const job = row(1, { snippet: scraped });
        const left = scraped.split(/(?<=\.)\s+/u); const right = official.split(/(?<=\.)\s+/u);
        const answer = { choice: 'P1', evidence: [0, 1, 3].map(index => ({ scrapedQuote: left[index], officialQuote: right[index] })), distinguishing: [], conflicts: [] };
        const calls = [];
        const leads = new Map([[officialPostingRequestId(job), sourceUrl(1)]]);
        const result = await resolveOfficialPostings([job], { store, fetch: network({ 'https://northwind.test/': '<title>Northwind Labs</title>', [sourceUrl(1)]: jsonld(job, official) }),
          callRaw: async (prompt, options) => { calls.push(options.task); const raw = options.task.endsWith('-research') ? response(prompt, leads) : answer;
            options.responseValidator(raw); return raw; } });
        assert.deepEqual(calls, ['job-official-posting-research', 'job-official-posting-match', 'job-official-posting-match']);
        assert.equal(result.jobs[0].officialPosting.level, 'L1'); assert.ok(result.jobs[0].officialPosting.trail.includes('comparative-match'));
        assert.ok(result.jobs[0].officialPosting.trail.includes('comparative-a-valid')); assert.ok(result.jobs[0].officialPosting.trail.includes('comparative-b-valid'));
        assert.equal((await getOfficialPostingView(result.jobs[0], { store })).description, official);
        assert.equal(result.telemetry.materialJdChange, 1); assert.equal(result.telemetry.handoffs, 3);
        assert.equal(result.telemetry.comparisons, 1); assert.equal(result.telemetry.comparativeAgreements, 1);
        assert.ok((await store.find(job)).officialPosting.trail.includes('material-jd-change'), 'the durable verified record retains the material-change enum');
      });
    },
  },
  {
    name: 'official-posting service gives unobserved workers grace then fails comparison once without settling a miss',
    async run() {
      for (const observed of [false, true]) await withStore(async store => {
        const job = row(1);
        const official = description.split(/\s+/u).reverse().join(' ');
        const pages = { 'https://northwind.test/': '<title>Northwind Labs</title>', [sourceUrl(1)]: jsonld(job, official) };
        const leads = new Map([[officialPostingRequestId(job), sourceUrl(1)]]);
        let matches = 0; let aborted = false;
        const result = await resolveOfficialPostings([job], { store, fetch: network(pages), timeoutMs: 500,
          comparativeGraceMs: 10, comparativeWorkerAvailable: () => observed,
          callRaw: async (prompt, options) => {
            if (options.task.endsWith('-research')) return response(prompt, leads);
            matches++;
            options.signal.addEventListener('abort', () => { aborted = true; });
            await new Promise(resolve => setTimeout(resolve, 35));
            return { choice: 'none', evidence: [], distinguishing: [], conflicts: [] };
          } });
        assert.equal(matches, observed ? 2 : 1, 'absence fails only once; a live observed worker keeps both runs eligible');
        assert.equal(aborted, !observed);
        assert.equal(result.jobs[0].officialPosting.trail.includes('comparative-unavailable'), !observed);
        if (!observed) assert.equal(await store.find(job), null, 'worker absence is retryable rather than a durable miss');
      });
    },
  },
  {
    name: 'Amendment 8 item 4: comparative worker relaunch suspends absence grace and remains bounded by the launcher timeout',
    async run() {
      for (const mode of ['arrives', 'cancelled', 'expires']) await withStore(async store => {
        const job = row(1); const official = description.split(/\s+/u).reverse().join(' ');
        const pages = { 'https://northwind.test/': '<title>Northwind Labs</title>', [sourceUrl(1)]: jsonld(job, official) };
        const leads = new Map([[officialPostingRequestId(job), sourceUrl(1)]]);
        let matches = 0; let available = false; let launching = true; let clockOffset = 0; let abortCode = null;
        const scheduled = [];
        const keepAlive = setInterval(() => {}, 1000);
        try {
          const result = await resolveOfficialPostings([job], { store, fetch: network(pages), timeoutMs: 500,
            now: () => Date.now() + clockOffset, comparativeGraceMs: 5,
            comparativeWorkerAvailable: () => available, comparativeWorkerLaunching: () => launching,
            callRaw: async (prompt, options) => {
              if (options.task.endsWith('-research')) return response(prompt, leads);
              matches++;
              options.signal.addEventListener('abort', () => { abortCode = options.signal.reason?.code; });
              if (matches === 1) scheduled.push(setTimeout(() => {
                if (mode === 'arrives') { available = true; launching = false; }
                else if (mode === 'cancelled') launching = false;
                else clockOffset += CONSTANTS.CHAT_LAUNCH_PRESENTATION_TIMEOUT_MS + 1;
              }, 20));
              if (mode !== 'arrives') return new Promise(() => {});
              await new Promise(resolve => setTimeout(resolve, 35));
              return { choice: 'none', evidence: [], distinguishing: [], conflicts: [] };
            } });
          assert.equal(matches, mode === 'arrives' ? 2 : 1, `${mode}: run B stays eligible through launch, absence fails only once`);
          assert.equal(abortCode, mode === 'arrives' ? null : 'comparative-unavailable', `${mode}: only absence ends an unsuccessful relaunch`);
          assert.equal(result.jobs[0].officialPosting.trail.includes('comparative-unavailable'), mode !== 'arrives');
        } finally { clearInterval(keepAlive); for (const timer of scheduled) clearTimeout(timer); }
      });
    },
  },
  {
    name: 'official-posting service never dispatches another comparative run after a transport timeout and never compares a hard-gate mismatch',
    async run() {
      await withStore(async store => {
        const reversed = description.split(/\s+/u).reverse().join(' ');
        // Amendment 3: apply options are lead identity anchors, so the two candidates are reached from the employer's careers page.
        const job = row(1, { url: 'https://northwind.test/careers' });
        const pages = { 'https://northwind.test/': '<title>Northwind Labs</title>', 'https://northwind.test/careers': `<a href="${sourceUrl(1)}">One</a><a href="${sourceUrl(2)}">Two</a>`,
          [sourceUrl(1)]: jsonld(job, reversed), [sourceUrl(2)]: jsonld(job, `${reversed} Separate application workflow for inventory scheduling and delivery coordination.`) };
        let matches = 0; let aborted = false;
        const result = await resolveOfficialPostings([job], { store, fetch: network(pages), timeoutMs: 5,
          callRaw: async (prompt, options) => {
            if (options.task.endsWith('-research')) return response(prompt);
            matches++; options.signal.addEventListener('abort', () => { aborted = true; });
            return new Promise(resolve => setTimeout(() => resolve({ choice: 'none', evidence: [], distinguishing: [], conflicts: [] }), 25));
          } });
        assert.equal(matches, 1, 'run B cannot trigger another handoff after run A times out');
        assert.equal(aborted, true); assert.equal(result.telemetry.bridgeTimeout, 1);
        assert.ok(result.jobs[0].officialPosting.trail.includes('bridge-timeout')); assert.equal(result.jobs[0].officialPosting.level, 'L5');
        assert.equal(await store.find(job), null, 'a match timeout is retryable even after research parsed successfully');
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
