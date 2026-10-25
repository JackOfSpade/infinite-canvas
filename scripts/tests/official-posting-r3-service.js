import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { officialPostingAliases } from '../../electron/ipc/officialPostingStore.js';
import { normalizeOfficialPosting } from '../../electron/ipc/officialPostingFields.js';
import { officialPostingChunks, unresolvedOfficialPosting } from '../../electron/ipc/officialPostingResolver.js';
import { mergeOfficialPostingTelemetry, partitionOfficialPostingRows, resolveOfficialPostings } from '../../electron/ipc/officialPostingService.js';

const description = 'Requirements include building reliable dispatch services, reviewing route reports, and documenting operational changes with the engineering team.';
const job = (id, extra = {}) => ({ title: `Dispatch Engineer ${id}`, company: 'Northwind Labs', location: 'Lakeview, Ontario, Canada',
  snippet: description, url: `https://mirror.example/jobs/${id}`, sourceJobKey: `source-${id}`, ...extra });
const posting = (extra = {}) => ({ level: 'L4', outcome: 'link-only', employer: 'Northwind Labs', title: 'Dispatch Engineer',
  sourceUrl: 'https://northwind.test/jobs/dispatch', officialApplyUrl: 'https://northwind.test/jobs/dispatch', trail: [], ...extra });
const record = (row, value, savedAt = Date.now()) => ({ version: 1, aliases: officialPostingAliases(row), savedAt, officialPosting: normalizeOfficialPosting(value) });
const response = prompt => prompt.match(/Requested ids: ([a-f0-9, ]+)\./u)[1].split(', ').map(id =>
  `BEGIN OFFICIAL POSTING RESEARCH ${id}\nNOT FOUND\nEND OFFICIAL POSTING RESEARCH ${id}`).join('\n');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function memoryStore(initial = []) {
  const records = new Map(initial); const saves = [];
  return { saves, records, find: async row => records.get(row.sourceJobKey) || null,
    save: async (row, payload) => { saves.push({ row, payload }); const value = record(row, payload.officialPosting); records.set(row.sourceJobKey, value); return value; } };
}
const noNetwork = () => { throw new Error('This service fixture must not fetch.'); };

export default [
  {
    name: 'R3 service partitions only normalized identity-bound settled rows and overlays host metadata without changing scraped fields',
    async run() {
      const now = Date.parse('2026-02-01T12:00:00Z');
      const rows = Array.from({ length: 8 }, (_, index) => job(index, { officialPosting: posting() }));
      rows[0].officialPosting = posting({ employer: 'Forged Example', sourceUrl: 'https://forged.test/job' });
      delete rows[1].officialPosting;
      rows[7].officialPosting = { ...posting(), extra: 'invalid' };
      const valid = record(rows[0], posting({ level: 'L1', outcome: 'found' }), now);
      const wrong = record(job(200, { title: 'Finance Analyst' }), posting(), now);
      const clean = record(rows[3], posting({ level: 'L5', outcome: 'not-found', trail: ['bridge-research'] }), now - 1_000);
      const transient = record(rows[4], posting({ level: 'L5', outcome: 'not-found', trail: ['bridge-aborted'] }), now - 1_000);
      const unproven = record(rows[5], posting({ level: 'L5', outcome: 'not-found' }), now - 1_000);
      const expired = record(rows[6], posting({ level: 'L5', outcome: 'not-found', trail: ['bridge-research'] }), now - 24 * 60 * 60 * 1_000);
      const store = memoryStore([[rows[0].sourceJobKey, valid], [rows[1].sourceJobKey, record(rows[1], posting(), now)],
        [rows[2].sourceJobKey, wrong], [rows[3].sourceJobKey, clean], [rows[4].sourceJobKey, transient], [rows[5].sourceJobKey, unproven], [rows[6].sourceJobKey, expired]]);
      const before = JSON.stringify(rows);
      const result = await partitionOfficialPostingRows(rows, { store, now });
      assert.equal(JSON.stringify(rows), before);
      assert.deepEqual(result.unresolvedIndices, [1, 2, 4, 5, 6, 7]);
      assert.deepEqual(result.jobs[0].officialPosting, valid.officialPosting, 'inline proof is replaced by host-owned proof');
      assert.equal(result.jobs[0].company, rows[0].company); assert.equal(result.jobs[0].snippet, rows[0].snippet);
      assert.equal(result.settledTelemetry.total, 2); assert.equal(result.settledTelemetry.levels.L1, 1); assert.equal(result.settledTelemetry.levels.L5, 1);
      assert.equal(store.saves.length, 0);
      const cancelled = await partitionOfficialPostingRows(rows, { store, now, signal: AbortSignal.abort() });
      assert.equal(cancelled.unresolvedIndices.length, rows.length); assert.equal(cancelled.settledTelemetry.total, 0);
    },
  },
  {
    name: 'R3 service skips all twenty-one handoffs for 250 definitive cached misses and chunks only thirty unresolved input rows',
    async run() {
      const rows = Array.from({ length: 250 }, (_, index) => job(index));
      const store = memoryStore(rows.map(row => [row.sourceJobKey, record(row, posting({ level: 'L5', outcome: 'not-found', trail: ['bridge-research'] }))]));
      const result = await resolveOfficialPostings(rows, { store, fetch: noNetwork, callRaw: () => { throw new Error('250 settled rows must dispatch zero handoffs'); } });
      assert.equal(result.jobs.length, 250); assert.equal(result.telemetry.handoffs, 0); assert.equal(result.telemetry.levels.L5, 250);
      assert.equal(store.saves.length, 0);
      const normalized = result.jobs; const fresh = Array.from({ length: 30 }, (_, index) => job(index + 250));
      const partition = await partitionOfficialPostingRows([...normalized, ...fresh], { store });
      assert.deepEqual(partition.unresolvedIndices, Array.from({ length: 30 }, (_, index) => index + 250));
      const calls = [];
      const resolved = await resolveOfficialPostings(partition.unresolvedIndices.map(index => partition.jobs[index]), { store, fetch: noNetwork,
        resolve: async row => unresolvedOfficialPosting(row), callRaw: async (prompt, options) => { calls.push(options.hints); return response(prompt); } });
      assert.deepEqual(calls, [{ itemCount: 12, batch: 1, batchTotal: 3 }, { itemCount: 12, batch: 2, batchTotal: 3 }, { itemCount: 6, batch: 3, batchTotal: 3 }]);
      assert.equal(resolved.telemetry.handoffs, 3); assert.equal(mergeOfficialPostingTelemetry(partition.settledTelemetry, resolved.telemetry).total, 280);
    },
  },
  {
    name: 'R3 service runs six host rows in parallel with one shared fetch session and row budget while research chunks remain sequential',
    async run() {
      const rows = Array.from({ length: 13 }, (_, index) => job(index)); const before = JSON.stringify(rows);
      const store = memoryStore(); const budgets = new Map(); const phases = { free: 0, pending: 0 }; const peak = { free: 0, pending: 0 };
      let freeCompleted = 0; let baseFetches = 0; const calls = []; const progress = [];
      const chunks = officialPostingChunks(rows);
      const result = await resolveOfficialPostings(rows, { store, onProgress: value => progress.push(value),
        fetch: async url => { baseFetches++; await delay(3); return { url, statusCode: 200, contentType: 'text/html', body: '<title>Shared root</title>' }; },
        resolve: async (row, options) => {
          const phase = options.bypassCache ? 'pending' : 'free'; phases[phase]++; peak[phase] = Math.max(peak[phase], phases[phase]);
          assert.equal(options.persistResults, false); assert.equal(options.persistMisses, false);
          assert.equal(options.signal, options.rowBudget.signal);
          if (budgets.has(row.sourceJobKey)) assert.equal(options.rowBudget, budgets.get(row.sourceJobKey)); else budgets.set(row.sourceJobKey, options.rowBudget);
          await options.fetch('https://shared.test/', { signal: options.signal }); await delay(Number(row.sourceJobKey.split('-')[1]) % 3 + 2);
          phases[phase]--;
          if (phase === 'free') { freeCompleted++; return unresolvedOfficialPosting(row); }
          return { officialPosting: posting({ title: row.title }) };
        }, callRaw: async (prompt, options) => {
          assert.equal(freeCompleted, rows.length, 'all free passes finish before the first handoff');
          assert.equal(phases.pending, 0, 'a later research chunk starts after earlier pending rows finish');
          calls.push({ prompt, hints: options.hints }); return response(prompt);
        } });
      assert.equal(JSON.stringify(rows), before); assert.deepEqual(peak, { free: 6, pending: 6 });
      assert.equal(baseFetches, 1); assert.equal(result.telemetry.fetches, 1); assert.equal(result.telemetry.uniqueUrls, 1); assert.equal(result.telemetry.cacheHits, 25);
      assert.equal(result.telemetry.maxPerHostRate, 1); assert.equal(result.telemetry.breakerTrips, 0);
      assert.equal(store.saves.length, 13, 'each verified row is written once by the service');
      assert.equal(result.jobs.every(row => row.officialPosting.level === 'L4'), true);
      assert.deepEqual(calls.map(call => call.hints), [{ itemCount: 12, batch: 1, batchTotal: 2 }, { itemCount: 1, batch: 2, batchTotal: 2 }]);
      for (let index = 0; index < calls.length; index++) for (const member of chunks[index]) assert.ok(calls[index].prompt.includes(member.id));
      assert.deepEqual(progress.at(-1), { completed: 13, total: 13 });
    },
  },
  {
    name: 'R3 service never stores stopped transient unavailable timed-out or malformed research misses and permits a healthy retry',
    async run() {
      const cases = ['stop', 'bridge-unavailable', 'bridge-timeout', 'parse-error', 'fetch-failed', 'fetch-timeout', 'failed', 'research-miss', 'bridge-aborted', 'crawl-budget'];
      for (const [index, code] of cases.entries()) {
        const row = job(index); const store = memoryStore(); const controller = new AbortController(); let calls = 0;
        const hostCode = ['fetch-failed', 'fetch-timeout', 'failed', 'research-miss', 'bridge-aborted', 'crawl-budget'].includes(code) ? code : null;
        const result = await resolveOfficialPostings([row], { store, fetch: noNetwork, signal: controller.signal,
          timeoutMs: code === 'bridge-timeout' ? 5 : undefined, bridgeAvailable: code !== 'bridge-unavailable',
          resolve: async value => unresolvedOfficialPosting(value, { outcome: hostCode === 'failed' ? 'failed' : 'not-found', trail: hostCode ? [hostCode] : [] }),
          callRaw: async prompt => { calls++;
            if (code === 'stop') { controller.abort(); throw new Error('stopped'); }
            if (code === 'bridge-timeout') { await delay(20); return response(prompt); }
            return code === 'parse-error' ? 'malformed' : response(prompt);
          } });
        assert.equal(store.saves.length, 0, `${code} must not create a durable miss`);
        assert.ok(['L5', 'L6'].includes(result.jobs[0].officialPosting.level));
        assert.equal(calls, code === 'bridge-unavailable' ? 0 : 1);
        let retried = 0;
        const healthy = await resolveOfficialPostings([row], { store, fetch: noNetwork, resolve: async value => unresolvedOfficialPosting(value),
          callRaw: async prompt => { retried++; return response(prompt); } });
        assert.equal(retried, 1, `${code} remains retryable on the next run`); assert.equal(store.saves.length, 1);
        assert.ok(healthy.jobs[0].officialPosting.trail.includes('bridge-research'));
      }
    },
  },
  {
    name: 'R3 service retries old persisted transient misses through the real resolver and stores only the new clean researched conclusion',
    async run() {
      const row = job(1); const old = record(row, posting({ level: 'L5', outcome: 'not-found', trail: ['bridge-timeout'] }));
      const store = memoryStore([[row.sourceJobKey, old]]); let researched = 0; let fetched = 0;
      const result = await resolveOfficialPostings([row], { store, fetch: async () => { fetched++; const error = new Error('closed'); error.code = 'closed'; throw error; },
        callRaw: async prompt => { researched++; return response(prompt); } });
      assert.equal(researched, 1); assert.equal(fetched, 1, 'the shared negative cache prevents another host request in pass two');
      assert.equal(store.saves.length, 1); assert.equal(result.jobs[0].officialPosting.level, 'L5');
      assert.ok(result.jobs[0].officialPosting.trail.includes('bridge-research')); assert.equal(result.jobs[0].officialPosting.trail.includes('bridge-timeout'), false);
      assert.equal(result.jobs[0].officialPosting.trail.includes('recent-miss'), false);
    },
  },
  {
    name: 'R3 service persists clean parsed ambiguous results once and merges counts without leaking supplied facts or host names',
    async run() {
      const row = job(1); const store = memoryStore();
      const result = await resolveOfficialPostings([row], { store, fetch: noNetwork,
        resolve: async value => unresolvedOfficialPosting(value, { outcome: 'ambiguous', trail: ['ambiguous'], alternatives: [
          { title: 'Dispatch Engineer', url: 'https://northwind.test/jobs/alternative-one' },
          { title: 'Dispatch Engineer', url: 'https://northwind.test/jobs/alternative-two' },
        ] }),
        callRaw: async prompt => response(prompt) });
      assert.equal(store.saves.length, 1); assert.equal(result.jobs[0].officialPosting.outcome, 'ambiguous');
      const combined = mergeOfficialPostingTelemetry(result.telemetry, { total: 2, levels: { L1: 2, secret: 99 }, outcomes: { found: 2 },
        fetches: 8, uniqueUrls: 5, cacheHits: 3, maxPerHostRate: 4, breakerTrips: 1, rejections: { 'title-mismatch': 2, 'northwind.test': 999 }, snippet: 'private page content' },
      { fetches: 2, uniqueUrls: 1, cacheHits: 1, maxPerHostRate: 3, breakerTrips: 0, levels: { L1: 'unsafe count' } });
      assert.equal(combined.total, 3); assert.equal(combined.levels.L1, 2); assert.equal(combined.levels.L5, 1);
      assert.equal(combined.fetches, 10); assert.equal(combined.uniqueUrls, 6); assert.equal(combined.cacheHits, 4); assert.equal(combined.maxPerHostRate, 4); assert.equal(combined.breakerTrips, 1);
      assert.equal(combined.rejections['title-mismatch'], 2); assert.equal(/northwind|private|secret|unsafe/u.test(JSON.stringify(combined)), false);
    },
  },
  {
    name: 'R3 service stores a verified match when only the row host budget ended after it was found and drops it when the run stopped',
    async run() {
      const text = 'Requirements include experience building reliable services and maintaining reporting workflows. Engineers design clear interfaces for dispatch teams and validate operational changes with careful review. The role includes improving data quality across scheduled pipelines and documenting decisions for partner teams. You will work with colleagues to investigate delivery failures and make service behavior understandable. Responsibilities include writing tests for new features and improving the tools used by support teams every day.';
      const url = 'https://northwind.test/jobs/1'; const apply = ['https://northwind.test/apply/1', 'https://northwind.test/apply/2'];
      const lead = { title: 'Engineer 1', company: 'Northwind Labs', location: 'Lakeview, Ontario, Canada', snippet: text, source: 'google', url,
        sourceJobKey: 'source-budget', salaryProvenance: 'unknown', applyOptions: [url, ...apply].map(href => ({ label: 'Apply', href })) };
      const pages = { 'https://northwind.test/': '<title>Northwind Labs</title>', [url]: `<script type="application/ld+json">${JSON.stringify({
        '@type': 'JobPosting', title: 'Engineer 1', hiringOrganization: { name: 'Northwind Labs' }, description: text,
        jobLocation: { address: { addressLocality: 'Lakeview', addressRegion: 'Ontario', addressCountry: 'Canada' } } })}</script>`,
      [apply[0]]: '<main>Apply</main>', [apply[1]]: '<main>Apply</main>' };
      const serve = (target, onRead) => { onRead?.(target); if (!pages[target]) throw Object.assign(new Error('closed'), { code: 'closed' });
        return { url: target, sourceUrl: target, statusCode: 200, contentType: 'text/html', body: pages[target] }; };
      const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;
      try {
        // A slow employer host spends the row's sixty seconds of host time while its own leads are still being read.
        const store = memoryStore();
        const result = await resolveOfficialPostings([lead], { store, bridgeAvailable: false, fetch: async target => serve(target, read => { if (read === url) skew += 61_000; }) });
        assert.equal(result.jobs[0].officialPosting.level, 'L1'); assert.ok(result.jobs[0].officialPosting.trail.includes('fetch-timeout'));
        assert.equal(store.saves.length, 1, 'the verified record is stored so Generate and scoring can serve its text');
        assert.equal(store.saves[0].payload.description, text);
        skew = 0;
        const controller = new AbortController(); const stopped = memoryStore();
        const halted = await resolveOfficialPostings([lead], { store: stopped, bridgeAvailable: false, signal: controller.signal,
          fetch: async target => serve(target, read => { if (read === apply[0]) controller.abort(); }) });
        assert.equal(halted.jobs[0].officialPosting.level, 'L1');
        assert.equal(stopped.saves.length, 0, 'a stopped run never writes a result');
      } finally { Date.now = realNow; }
    },
  },
  {
    name: 'R3 service releases its own run and row abort listeners while preserving an injected reusable fetch session',
    async run() {
      const controller = new AbortController(); const rows = Array.from({ length: 13 }, (_, index) => job(index));
      const options = { signal: controller.signal, store: memoryStore(), fetch: noNetwork,
        resolve: async value => unresolvedOfficialPosting(value), callRaw: async prompt => response(prompt) };
      await resolveOfficialPostings(rows, options);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'owned row budgets and session release their run listeners');
      let disposed = false;
      const fetchSession = { fetch: noNetwork, telemetry: () => ({ fetches: 0, uniqueUrls: 0, cacheHits: 0, maxPerHostRate: 0, breakerTrips: 0 }),
        dispose: () => { disposed = true; } };
      await resolveOfficialPostings(rows, { ...options, fetchSession });
      assert.equal(disposed, false, 'a caller can reuse its own shared session across service invocations');
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    },
  },
];
