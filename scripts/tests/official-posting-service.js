import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOfficialPostingStore } from '../../electron/ipc/officialPostingStore.js';
import { officialPostingChunks, officialPostingRequestId } from '../../electron/ipc/officialPostingResolver.js';
import { cappedHandoff, OFFICIAL_POSTING_HANDOFF_ASSIGNMENT_TIMEOUT_MS, getOfficialPostingView as readPostingView, officialPostingDedup, resolveOfficialPostings as resolvePostings, partitionOfficialPostingRows } from '../../electron/ipc/officialPostingService.js';
import { officialPostingAliases } from '../../electron/ipc/officialPostingStore.js';
import { officialPostingSemanticInputHash } from '../../electron/ipc/officialPostingSemantic.js';
import { _resetOfficialPostingDiscoveryDiagnosticsForTests, getOfficialPostingDiscoveryDiagnosticsSnapshot } from '../../electron/ipc/officialPostingDiscoveryDiagnostics.js';

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
async function withStore(run, options) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'official-service-'));
  const store = createOfficialPostingStore(path.join(root, 'official-postings'), options);
  try { await run(store); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

// Exercise the generous production unassigned ceiling without waiting minutes.
async function withFastAssignmentDeadline(run) {
  const schedule = globalThis.setTimeout;
  const budget = OFFICIAL_POSTING_HANDOFF_ASSIGNMENT_TIMEOUT_MS;
  const timers = [];
  globalThis.setTimeout = (callback, delay, ...args) => {
    const timer = schedule(callback, delay === budget ? 40 : delay, ...args);
    if (delay === budget) timers.push(timer);
    return timer;
  };
  try { return await run(schedule); }
  finally { globalThis.setTimeout = schedule; timers.forEach(clearTimeout); }
}
function members(prompt) { return prompt.match(/Requested ids: ([a-f0-9, ]+)\./u)[1].split(', '); }
function response(prompt, leads = new Map()) {
  return members(prompt).map(id => `BEGIN OFFICIAL POSTING RESEARCH ${id}\n${leads.has(id)
    ? `CANDIDATE: ${JSON.stringify({ careersPageUrl: '', postingUrl: leads.get(id), employer: 'Northwind Labs', employerDomain: '', ats: '' })}`
    : 'NOT FOUND'}\nEND OFFICIAL POSTING RESEARCH ${id}`).join('\n');
}
const metadata = (url, extra = {}) => ({ level: 'L1', outcome: 'found', employer: 'Northwind Labs', title: 'Engineer',
  sourceUrl: url, officialApplyUrl: url, trail: [], ...extra });
const getOfficialPostingView = (job, options) => readPostingView(job, { requireSemantic: false, ...options });

export default [
  {
    name: 'Official posting judgment diagnostics distinguish worker recovery, renderer cancellation and invalid responses without raw errors',
    async run() {
      for (const [error, expected, trail] of [
        [Object.assign(new Error('PRIVATE_PROMPT'), { code: 'WORKER_WORKER_LOST' }), 'worker-lost', 'worker-unavailable'],
        [Object.assign(new Error('PRIVATE_PROMPT'), { code: 'WORKER_WORKER_REPLACED' }), 'worker-replaced', 'worker-unavailable'],
        [Object.assign(new Error('PRIVATE_PROMPT'), { code: 'WORKER_COMPARISON_CONTAMINATED' }), 'comparison-contaminated', 'worker-unavailable'],
        [Object.assign(new Error('PRIVATE_PROMPT'), { code: 'WORKER_FRESH_CONTEXT_REQUIRED' }), 'fresh-context-required', 'worker-unavailable'],
        [Object.assign(new Error('PRIVATE_PROMPT'), { code: 'WORKER_REQUEUE_EXHAUSTED', recoveryCode: 'WORKER_WORKER_LOST' }), 'requeue-exhausted', 'worker-unavailable'],
        [Object.assign(new Error('PRIVATE_PROMPT'), { code: 'WORKER_RENDERER_UNAVAILABLE' }), 'renderer-unavailable', 'worker-unavailable'],
        [Object.assign(new Error('PRIVATE_PROMPT'), { code: 'IPC_RENDERER_STOPPED' }), 'renderer-stopped', 'worker-aborted'],
        [Object.assign(new Error('PRIVATE_PROMPT'), { code: 'worker-aborted' }), 'worker-aborted', 'worker-aborted'],
        [new Error('PRIVATE_PROMPT'), 'unexpected-error', 'failed'],
        [new TypeError('PRIVATE_PROMPT'), 'type-error', 'failed'],
        [Object.assign(new Error('PRIVATE_PROMPT'), { code: 'OFFICIAL_POSTING_COMPARATIVE_INVALID' }), 'comparative-invalid', 'comparative-invalid'],
      ]) {
        _resetOfficialPostingDiscoveryDiagnosticsForTests();
        try {
          await withStore(async store => {
            await fs.mkdir(store.rootDir, { recursive: true });
            const result = await resolvePostings([row(expected)], { store, candidateUrls: [sourceUrl(expected)],
              snapshotFetch: async () => { throw Object.assign(new Error('offline'), { code: 'fetch-failed' }); },
              callRaw: async prompt => response(prompt), callMatch: async () => { throw error; },
            });
            const text = await fs.readFile(path.join(store.rootDir, 'judgments.jsonl'), 'utf8');
            const entries = text.trimEnd().split('\n').map(line => JSON.parse(line));
            assert.equal(entries.length, 2, "the A and B judges now run together, so each records its own failure");
            for (const entry of entries) {
              assert.equal(entry.failure, expected);
              assert.equal(entry.failureCause, error.recoveryCode ? "worker-lost" : undefined);
            }
            assert.equal(text.includes('PRIVATE_PROMPT'), false);
            const snapshot = getOfficialPostingDiscoveryDiagnosticsSnapshot();
            assert.deepEqual(snapshot.observations[0].failureCodes, [expected, ...(error.recoveryCode ? ['worker-lost'] : [])]);
            assert.equal(JSON.stringify(snapshot).includes('PRIVATE_PROMPT'), false);
            assert.ok(result.jobs[0].officialPosting.trail.includes(trail), expected);
            assert.equal(await store.find(row(expected)), null, 'a handoff failure stays retryable');
          });
        } finally { _resetOfficialPostingDiscoveryDiagnosticsForTests(); }
      }
    },
  },
  {
    name: 'semantic cache partition rechecks pre-upgrade misses despite matching input hashes without rewriting saved records',
    async run() {
      const jobs = Array.from({ length: 5 }, (_, index) => row(index + 1));
      const values = [metadata(sourceUrl(1)),
        { level: 'L5', outcome: 'not-found', employer: jobs[1].company, trail: ['bridge-research'] },
        metadata(sourceUrl(3), { trail: ['semantic-match-v1'], semanticMatch: { version: 1, inputHash: officialPostingSemanticInputHash(jobs[2]), sourceHash: 'b'.repeat(64) } }),
        { level: 'L5', outcome: 'not-found', employer: jobs[3].company, trail: ['bridge-research', 'semantic-match-v1'],
          semanticMatch: { version: 1, inputHash: officialPostingSemanticInputHash(jobs[3]) } },
        metadata(sourceUrl(5), { trail: ['semantic-match-v1'], semanticMatch: { version: 1, inputHash: 'a'.repeat(64) } })];
      jobs.forEach((job, index) => { job.officialPosting = values[index]; });
      const records = jobs.map((job, index) => ({ aliases: officialPostingAliases(job), savedAt: Date.now(), officialPosting: values[index] }));
      const before = JSON.stringify({ jobs, records });
      const store = { find: async job => records[jobs.indexOf(job)], save: () => { throw new Error('Partition must not rewrite records'); } };
      const partition = await partitionOfficialPostingRows(jobs, { store });
      assert.deepEqual(partition.unresolvedIndices, [0, 1, 3, 4], 'the prior semantic input hash does not waive ownership-discovery migration');
      assert.equal(partition.settledTelemetry.total, 1);
      assert.equal(JSON.stringify({ jobs, records }), before);
    },
  },
  {
    name: 'production posting view withholds legacy official facts until semantic proof matches the current input',
    async run() {
      await withStore(async store => {
        const job = row('legacy-view');
        const record = await store.save(job, { officialPosting: metadata(sourceUrl('legacy-view'), { title: 'Legacy official title' }),
          description: `${description} Official source details.` });
        job.officialPosting = record.officialPosting;
        assert.equal((await readPostingView(job, { store })).title, job.title);
        assert.equal((await readPostingView(job, { store })).officialPosting, undefined);
        const current = { ...record.officialPosting, trail: ['semantic-match-v1'],
          semanticMatch: { version: 1, inputHash: officialPostingSemanticInputHash(job), sourceHash: 'b'.repeat(64) } };
        await store.save(job, { officialPosting: current, description: `${description} Official source details.` });
        assert.equal((await readPostingView(job, { store })).title, 'Legacy official title');
        assert.equal((await readPostingView({ ...job, snippet: `${job.snippet} A newly captured requirement.` }, { store })).officialPosting, undefined);
      });
    },
  },
  {
    name: 'official-posting service caps each research handoff with linked abort and degrades a timeout without retrying its rows',
    async run() {
      await withStore(async store => {
        let calls = 0; let aborted = false;
        const timed = await resolvePostings([row()], { store, timeoutMs: 5,
          callRaw: (prompt, { signal }) => { calls++; signal.addEventListener('abort', () => { aborted = true; });
            return new Promise(resolve => setTimeout(() => resolve(response(prompt)), 25)); } });
        assert.equal(calls, 1); assert.equal(aborted, true); assert.ok(timed.jobs[0].officialPosting.trail.includes('worker-timeout'));
        assert.equal(timed.telemetry.workerTimeout, 1); assert.equal(timed.telemetry.handoffs, 1);
        assert.equal(await store.find(row()), null, 'a timed-out research handoff does not store a miss');
        assert.equal(/Requirements include|Northwind|Acme/u.test(JSON.stringify(timed.telemetry)), false, 'telemetry contains counts and enums only');
      });
    },
  },
  {
    name: 'unclaimed finder handoffs have a twenty-minute last-resort ceiling independent of the response budget',
    async run() {
      assert.equal(OFFICIAL_POSTING_HANDOFF_ASSIGNMENT_TIMEOUT_MS, 20 * 60 * 1000);
      await withFastAssignmentDeadline(async schedule => {
        const controller = new AbortController(); const stats = { handoffs: 0, handoffMs: 0 };
        let workerSignal; let assigned;
        const cleanup = schedule(() => controller.abort(Object.assign(new Error('test cleanup'), { code: 'worker-aborted' })), 500);
        try {
          const pending = cappedHandoff({ prompt: 'Synthetic unclaimed finder' }, {
            signal: controller.signal, timeoutMs: 5, timeoutStartsOnAssignment: true, now: Date.now, stats,
            call: (_prompt, options) => {
              workerSignal = options.signal; assigned = options.manualHandoff.onAssigned;
              return new Promise(() => {});
            },
          });
          const failure = pending.catch(error => error);
          await new Promise(resolve => schedule(resolve, 15));
          assert.equal(workerSignal.aborted, false, 'the response budget must not run before assignment');
          assert.equal((await failure).code, 'worker-timeout', 'an unclaimed finder eventually reaches the generous transport ceiling');
          assigned();
          assert.equal(workerSignal.reason.code, 'worker-timeout', 'a late claim cannot revive the expired handoff');
          assert.equal(stats.handoffs, 1);
        } finally { clearTimeout(cleanup); controller.abort(); }
      });
    },
  },
  {
    name: 'assignment replaces the unassigned ceiling with a full response budget and completion clears both timers',
    async run() {
      await withFastAssignmentDeadline(async schedule => {
        let workerSignal; let assigned;
        const result = await cappedHandoff({ prompt: 'Synthetic assigned finder' }, {
          timeoutMs: 100, timeoutStartsOnAssignment: true, now: Date.now, stats: { handoffs: 0, handoffMs: 0 },
          call: async (_prompt, options) => {
            workerSignal = options.signal; assigned = options.manualHandoff.onAssigned;
            await new Promise(resolve => schedule(resolve, 15));
            assigned(); assigned();
            await new Promise(resolve => schedule(resolve, 60));
            assert.equal(workerSignal.aborted, false, 'an assigned turn may outlast its cleared unassigned deadline');
            return 'Synthetic completed finder';
          },
        });
        assert.equal(result, 'Synthetic completed finder');
        assigned();
        await new Promise(resolve => schedule(resolve, 120));
        assert.equal(workerSignal.aborted, false, 'completion and late assignment leave no live deadline');
      });
    },
  },
  {
    name: 'unclaimed finder timeout releases serial admission so later batches finish and timed out rows remain retryable',
    async run() {
      await withFastAssignmentDeadline(async schedule => withStore(async store => {
        const controller = new AbortController(); const calls = []; let stalledSignal; let stalledIds;
        const rows = Array.from({ length: 13 }, (_, index) => row(index + 1));
        const cleanup = schedule(() => controller.abort(), 500);
        try {
          const result = await resolvePostings(rows, { store, signal: controller.signal, timeoutStartsOnAssignment: true,
            timeoutMs: 100,
            callRaw: (prompt, options) => {
              calls.push(options.hints);
              if (calls.length === 1) { stalledSignal = options.signal; stalledIds = members(prompt); return new Promise(() => {}); }
              options.manualHandoff.onAssigned();
              return response(prompt);
            },
          });
          assert.equal(controller.signal.aborted, false, 'lookup finishes without external cancellation');
          assert.equal(stalledSignal.reason.code, 'worker-timeout');
          assert.equal(calls.length, 3, 'later first-search and second-search batches get the released slot');
          for (const job of result.jobs) assert.equal(job.officialPosting.trail.includes('worker-timeout'), stalledIds.includes(officialPostingRequestId(job)));
          assert.equal(result.telemetry.workerTimeout, 12);
          assert.equal(await store.find(rows.find(job => stalledIds.includes(officialPostingRequestId(job)))), null, 'transport failure must not become a cached miss');
        } finally { clearTimeout(cleanup); controller.abort(); }
      }));
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
