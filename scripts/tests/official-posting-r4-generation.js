import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { comparisonRow } from './official-posting-r3-resolver.js';
import { comparativeServiceFixture, comparisonVisible, serviceComparisonAnswer } from './official-posting-r3-service.js';
import { createOfficialPostingStore } from '../../electron/ipc/officialPostingStore.js';
import { getPreparedOfficialPosting, prepareOfficialPostingForGeneration as prepareSemanticOfficialPostingForGeneration } from '../../electron/ipc/officialPostingGeneration.js';

const description = 'Requirements include experience building reliable dispatch tools and maintaining reporting workflows. Engineers design clear interfaces for operations teams and validate changes through careful review. The role improves data quality across scheduled pipelines and documents decisions for partner groups. You will collaborate with colleagues to investigate delivery failures and make service behavior understandable. Responsibilities include writing tests for new features and improving tools that support teams use every day.';
const location = 'Lakeview, Ontario, Canada';
const sourceUrl = 'https://northwind.test/jobs/dispatch';
const row = (extra = {}) => ({ title: 'Software Engineer at Northwind Labs', company: 'Acme Talent Partners', location,
  snippet: `Our client is hiring. ${description}`, url: 'https://mirror.example/jobs/dispatch', sourceJobKey: 'r4-dispatch', ...extra });
const args = job => ({ job, nodeId: 'r4-board', cardId: 'r4-card', manualAiRunId: 'r4-generation-run' });
const status = active => ({ enabled: true, link: { state: 'linked' }, chat: { pool: { active } } });
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
const prepareOfficialPostingForGeneration = (args, options = {}) => prepareSemanticOfficialPostingForGeneration(args, { semanticMatching: false, ...options });
async function withStore(run, options) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'official-r4-generation-'));
  try { await run(createOfficialPostingStore(path.join(root, 'official-postings'), options)); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
async function assertPreserved(store, job, before, fetch) {
  const input = JSON.stringify(job);
  const result = await prepareOfficialPostingForGeneration(args(job), { store, fetch, bridgeStatus: () => status(true) });
  const trusted = getPreparedOfficialPosting(result.resolutionId, job);
  assert.equal(JSON.stringify(job), input);
  for (const key of ['level', 'outcome', 'employer', 'sourceUrl', 'officialApplyUrl', 'contentHash', 'alternatives']) {
    assert.deepEqual(result.officialPosting[key], before.officialPosting[key], key);
  }
  assert.ok(result.officialPosting.trail.includes('reverify-failed'));
  assert.equal(trusted.description, ['L1', 'L2', 'L3'].includes(before.officialPosting.level) ? description : undefined);
  const saved = await store.find(job);
  assert.equal(saved.officialPosting.level, before.officialPosting.level);
  assert.equal(saved.officialPosting.contentHash, before.officialPosting.contentHash);
  assert.ok(saved.officialPosting.trail.includes('reverify-failed'));
  return result;
}

export default [
  {
    name: 'Amendment 4 complete cached proof survives repeated transient rechecks without becoming a partial crawl',
    async run() {
      await withStore(async store => {
        const job = row(); await store.save(job, { officialPosting: posting(), description });
        let research = 0;
        const options = { store, bridgeStatus: () => status(true),
          fetch: async () => { throw Object.assign(new Error('transient'), { code: 'fetch-timeout' }); },
          resolve: async jobs => { research++; return { jobs: jobs.map(value => ({ ...value, officialPosting: { level: 'L5', outcome: 'not-found', employer: value.company, trail: [] } })) }; } };
        const first = await prepareOfficialPostingForGeneration(args(job), options);
        const second = await prepareOfficialPostingForGeneration(args(job), options);
        assert.equal(first.officialPosting.level, 'L2'); assert.equal(second.officialPosting.level, 'L2');
        assert.equal(research, 0, 'a later transient recheck still inherits the original complete proof');
      });
    },
  },
  {
    name: 'Amendment 4 Generate retries old partial text-only records without reverify fallback or resaving the unsafe proof',
    async run() {
      for (const partial of ['fetch-timeout', 'crawl-budget']) for (const failedRecheck of [false, true]) for (const resolverFails of [false, true]) await withStore(async store => {
        const job = row();
        const before = await store.save(job, { officialPosting: posting({ trail: ['description-anchor', partial, ...(failedRecheck ? ['reverify-failed'] : [])] }), description });
        let calls = 0; let reads = 0; let saves = 0;
        const counted = { ...store, save: async (...values) => { saves++; return store.save(...values); } };
        const result = await prepareOfficialPostingForGeneration(args(job), { store: counted, bridgeStatus: () => status(true),
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
    name: 'R4 Generate keeps the active-pool gate without storing an idle skip and researches the next active click',
    async run() {
      for (const legacy of [false, true]) await withStore(async store => {
        const job = row(); let calls = 0;
        if (legacy) await store.save(job, { officialPosting: { level: 'L6', outcome: 'not-found', employer: '', trail: ['bridge-unavailable'] } });
        const fetch = async () => { throw Object.assign(new Error('unavailable'), { code: 'fetch-failed' }); };
        const callRaw = async (prompt, options) => { calls++; const raw = missResponse(prompt); options.responseValidator(raw); return raw; };
        if (!legacy) {
          const idle = await prepareOfficialPostingForGeneration(args(job), { store, fetch, callRaw, bridgeStatus: () => status(false) });
          assert.equal(calls, 0); assert.ok(idle.officialPosting.trail.includes('bridge-unavailable'));
          assert.equal(await store.find(job), null, 'a research-free idle click does not save a miss');
        }
        const active = await prepareOfficialPostingForGeneration(args(job), { store, fetch, callRaw, bridgeStatus: () => status(true) });
        assert.equal(calls, 1, legacy ? 'old unavailable misses retry' : 'a later active click researches');
        assert.equal(active.officialPosting.trail.includes('recent-miss'), false);
        assert.ok(active.officialPosting.trail.includes('bridge-research'));
      });
    },
  },
  {
    name: 'R4 transient rechecks preserve every verified level including named and unnamed L4 links',
    async run() {
      for (const level of ['L1', 'L2', 'L3', 'L4', 'unnamed-L4']) await withStore(async store => {
        const unnamed = level === 'unnamed-L4'; const job = row();
        const before = await store.save(job, { officialPosting: posting({ level: unnamed ? 'L4' : level,
          outcome: level.endsWith('L4') ? 'link-only' : 'found', employer: unnamed ? '' : 'Northwind Labs' }),
        ...(level.endsWith('L4') ? {} : { description }) });
        let calls = 0;
        await assertPreserved(store, job, before, async url => { calls++; assert.equal(url, sourceUrl);
          throw Object.assign(new Error('transient'), { code: 'fetch-timeout' }); });
        assert.equal(calls, 1, 'unnamed official links are still checked for definitive closure');
      });
    },
  },
  {
    name: 'R4 weak pages and invalid changed extraction preserve the exact prior proof and text',
    async run() {
      const changed = `${description} The role now reviews shared deployment schedules.`;
      const weak = [page('<main>Temporarily unavailable</main>'), page('<script type="application/ld+json">{invalid}</script>'),
        page(html('A brief role summary.')),
        page(JSON.stringify({ success: false, error: 'Temporarily unavailable', '@type': 'JobPosting', title: 'Software Engineer',
          hiringOrganization: { name: 'Northwind Labs' }, description: changed }), { contentType: 'application/json' }),
        page(html(changed, { title: 'Staff Engineer' })), page(html(changed, { hiringOrganization: { name: 'Other Labs' } })),
        page(html(changed, { jobLocation: { address: { addressLocality: 'Riverton', addressRegion: 'Alberta', addressCountry: 'Canada' } } })),
        page(html(description, { validThrough: '2000-01-01T00:00:00Z' })), page(html(), { statusCode: 503 }),
        page(html(), { url: 'https://foreign.test/jobs/dispatch' }), page(html(), { requestedUrl: 'https://foreign.test/' }), null];
      for (const level of ['L1', 'L2', 'L3']) for (const value of weak) await withStore(async store => {
        const job = row(); const before = await store.save(job, { officialPosting: posting({ level }), description });
        await assertPreserved(store, job, before, async () => value);
      });
    },
  },
  {
    name: 'R4 only explicit 404 or 410 closes named and unnamed official links',
    async run() {
      for (const unnamed of [false, true]) for (const code of [404, 410]) for (const throws of [false, true]) await withStore(async store => {
        const job = row(); await store.save(job, { officialPosting: posting({ level: 'L4', outcome: 'link-only', employer: unnamed ? '' : 'Northwind Labs' }) });
        let calls = 0;
        const result = await prepareOfficialPostingForGeneration(args(job), { store, bridgeStatus: () => status(true), fetch: async url => {
          calls++; assert.equal(url, sourceUrl);
          if (throws) throw Object.assign(new Error('closed'), { statusCode: code, code: 'closed' });
          return page('', { statusCode: code });
        } });
        assert.equal(calls, 1); assert.equal(result.officialPosting.outcome, 'closed');
        assert.equal(result.officialPosting.level, 'L6'); assert.equal(result.officialPosting.officialApplyUrl, undefined);
        assert.equal((await store.find(job)).officialPosting.outcome, 'closed');
      });
    },
  },
  {
    name: 'R4 only a complete exact-tenant ATS board can authoritatively delist a stored posting',
    async run() {
      const url = 'https://jobs.ashbyhq.com/northwind/dispatch';
      const api = 'https://api.ashbyhq.com/posting-api/job-board/northwind?includeCompensation=true';
      const listed = { id: 'other', title: 'Other Engineer', jobUrl: 'https://jobs.ashbyhq.com/northwind/other' };
      const changedTarget = { id: 'dispatch', title: 'Software Engineer', location, isListed: true,
        descriptionPlain: `${description} The current role also reviews release schedules.`, jobUrl: url };
      const boards = [
        { body: { jobs: [] }, closed: true }, { body: { jobs: [listed] }, closed: true },
        { body: { jobs: [{ id: 'dispatch', title: 'Software Engineer', location, isListed: false, descriptionPlain: description, jobUrl: url }] }, closed: true },
        { body: { jobs: [], hasMore: true } }, { body: { jobs: [], meta: { total: 2 } } },
        { body: { jobs: [], error: 'Temporarily unavailable', success: false } },
        { body: { jobs: [], errors: ['Temporarily unavailable'] } }, { body: { jobs: [], status: 'failed' } },
        { body: { jobs: [], statusCode: 503 } },
        { body: { success: false, error: 'Temporarily unavailable', jobs: [changedTarget] } },
        { body: { success: false, error: 'Temporarily unavailable', jobs: [changedTarget] }, direct: true },
        { body: { errors: ['Temporarily unavailable'], jobs: [changedTarget] } },
        { body: { jobs: [{ ...listed, jobUrl: 'https://jobs.ashbyhq.com/foreign/other' }] } },
        { body: { jobs: [] }, statusCode: 503 }, { body: { jobs: [] }, requestedUrl: 'https://foreign.test/' },
        { body: { message: 'Temporarily unavailable' } }, { raw: '{invalid}' },
      ];
      for (const board of boards) await withStore(async store => {
        const job = row(); const before = await store.save(job, { officialPosting: posting({ sourceUrl: url, officialApplyUrl: url, ats: 'ashby', tenant: 'northwind' }), description });
        const calls = []; const fetch = async target => { calls.push(target); return target === url && !board.direct ? page('<main>Loads with JavaScript</main>', { url })
          : page(board.raw || JSON.stringify(board.body), { url: board.direct ? url : api, contentType: 'application/json', ...(board.statusCode ? { statusCode: board.statusCode } : {}),
            ...(board.requestedUrl ? { requestedUrl: board.requestedUrl } : {}) }); };
        if (board.closed) {
          const result = await prepareOfficialPostingForGeneration(args(job), { store, fetch, bridgeStatus: () => status(true) });
          assert.equal(result.officialPosting.outcome, 'closed'); assert.equal(result.officialPosting.officialApplyUrl, undefined);
        } else await assertPreserved(store, job, before, fetch);
        assert.deepEqual(calls, board.direct ? [url] : [url, api]);
      });
      const otherBoards = [
        { ats: 'greenhouse', tenant: 'northwind', url: 'https://boards.greenhouse.io/northwind/jobs/12',
          api: 'https://boards-api.greenhouse.io/v1/boards/northwind/jobs?content=true', body: JSON.stringify({ jobs: [], meta: { total: 0 } }), closed: true },
        { ats: 'lever', tenant: 'northwind', url: 'https://jobs.lever.co/northwind/dispatch',
          api: 'https://api.lever.co/v0/postings/northwind?mode=json', body: '[]', closed: true },
        { ats: 'teamtailor', tenant: 'careers.northwind.example', url: 'https://careers.northwind.example/jobs/dispatch',
          api: 'https://careers.northwind.example/jobs.rss', contentType: 'application/rss+xml',
          body: '<rss version="2.0"><channel><title>Northwind Labs</title></channel></rss>', closed: false },
      ];
      for (const board of otherBoards) await withStore(async store => {
        const job = row(); const before = await store.save(job, { officialPosting: posting({ sourceUrl: board.url, officialApplyUrl: board.url,
          ats: board.ats, tenant: board.tenant }), description });
        const calls = []; const fetch = async target => { calls.push(target); return target === board.url
          ? page('<footer>Powered by <a href="https://www.teamtailor.com/">Teamtailor</a></footer>', { url: board.url })
          : page(board.body, { url: board.api, contentType: board.contentType || 'application/json' }); };
        if (board.closed) {
          const result = await prepareOfficialPostingForGeneration(args(job), { store, fetch, bridgeStatus: () => status(true) });
          assert.equal(result.officialPosting.outcome, 'closed');
        } else await assertPreserved(store, job, before, fetch);
        assert.deepEqual(calls, [board.url, board.api]);
      });
    },
  },
  {
    name: 'R4 valid changed content updates the hash while unchanged content retains its stored proof level',
    async run() {
      for (const level of ['L1', 'L2', 'L3']) for (const changed of [false, true]) await withStore(async store => {
        const job = row(); const before = await store.save(job, { officialPosting: posting({ level }), description });
        const current = changed ? `${description} The current role also reviews release schedules.` : description;
        const result = await prepareOfficialPostingForGeneration(args(job), { store, bridgeStatus: () => status(true), fetch: async () => page(html(current)) });
        assert.equal(result.officialPosting.level, level); assert.ok(result.officialPosting.trail.includes('reverified'));
        assert.equal(result.officialPosting.trail.includes('reverify-failed'), false);
        assert.equal(result.officialPosting.contentHash === before.officialPosting.contentHash, !changed);
        assert.equal(getPreparedOfficialPosting(result.resolutionId, job).description, current);
        assert.equal(await store.readText((await store.find(job)).officialPosting.contentHash), current);
      });
    },
  },
  {
    name: 'R4 internal prepare timeout preserves loaded host proof while explicit Stop rejects without a token or write',
    async run() {
      for (const stop of [false, true]) await withStore(async store => {
        const job = row(); const before = await store.save(job, { officialPosting: posting(), description });
        const controller = new AbortController(); let writes = 0; let fetches = 0; let markFetching;
        const fetching = new Promise(resolve => { markFetching = resolve; });
        // Keep the real store record/text but make their already-completed reads
        // immediate, so a two-millisecond cap deterministically expires in fetch.
        const cachedStore = { ...store, find: async () => before, readText: async hash => {
          assert.equal(hash, before.officialPosting.contentHash); return description;
        }, save: async (...values) => { writes++; return store.save(...values); } };
        const pending = prepareOfficialPostingForGeneration(args(job), { store: cachedStore, signal: controller.signal,
          timeoutMs: stop ? 60_000 : 2, bridgeStatus: () => status(true), fetch: () => {
            fetches++; markFetching(); return new Promise(() => {});
          }, callRaw: () => { throw new Error('A stored proof never needs a handoff.'); } });
        await fetching;
        if (stop) {
          const reason = Object.assign(new Error('user stop'), { code: 'bridge-aborted' }); controller.abort(reason);
          await assert.rejects(pending, error => error === reason);
        } else {
          const keepAlive = setTimeout(() => {}, 30);
          const result = await pending; clearTimeout(keepAlive);
          assert.equal(result.officialPosting.level, 'L2'); assert.equal(result.officialPosting.contentHash, before.officialPosting.contentHash);
          assert.ok(result.officialPosting.trail.includes('reverify-failed')); assert.ok(result.officialPosting.trail.includes('bridge-timeout'));
          assert.equal(getPreparedOfficialPosting(result.resolutionId, job).description, description);
        }
        assert.equal(fetches, 1); assert.equal(writes, 0); assert.deepEqual(await store.find(job), before);
      });
    },
  },
  {
    name: 'R4 recent definitive ambiguous misses retain all alternatives and retry only after the miss expires',
    async run() {
      let time = Date.parse('2026-03-01T00:00:00Z');
      await withStore(async store => {
        const job = row(); const alternatives = [{ url: 'https://northwind.test/jobs/one', title: 'Software Engineer' },
          { url: 'https://northwind.test/jobs/two', title: 'Software Engineer' }];
        await store.save(job, { officialPosting: { level: 'L6', outcome: 'ambiguous', employer: '', trail: ['bridge-research', 'ambiguous'], alternatives } });
        let calls = 0;
        const options = { store, now: () => time, bridgeStatus: () => status(true), fetch: () => { throw new Error('A fresh miss cannot fetch.'); },
          resolve: async jobs => { calls++; return { jobs: jobs.map(value => ({ ...value, officialPosting: { level: 'L6', outcome: 'not-found', employer: '', trail: ['bridge-research'] } })) }; } };
        const recent = await prepareOfficialPostingForGeneration(args(job), options);
        assert.equal(calls, 0); assert.deepEqual(recent.officialPosting.alternatives, alternatives); assert.ok(recent.officialPosting.trail.includes('recent-miss'));
        time += 24 * 60 * 60 * 1000;
        await prepareOfficialPostingForGeneration(args(job), options); assert.equal(calls, 1);
      }, { now: () => time });
    },
  },
  {
    name: 'Amendment 5 Generate forwards comparative callers through the real single-row service and stores host-verified text',
    async run() {
      await withStore(async store => {
        const fixture = comparativeServiceFixture([{ id: 'one' }]); const job = comparisonRow(); const calls = [];
        const prepared = await prepareOfficialPostingForGeneration(args(job), { store, fetch: fixture.fetch, bridgeStatus: () => status(true),
          callRaw: fixture.research, callMatch: async (prompt, options) => {
            calls.push(options.manualHandoff);
            return JSON.stringify(serviceComparisonAnswer(comparisonVisible(prompt)));
          } });
        assert.equal(prepared.officialPosting.level, 'L1'); assert.equal(prepared.officialPosting.sourceUrl, fixture.candidateUrls[0]);
        assert.ok(prepared.officialPosting.trail.includes('comparative-match'));
        assert.equal(prepared.telemetry.officialPosting.comparisons, 1);
        assert.equal(prepared.telemetry.officialPosting.comparativeAgreements, 1);
        assert.equal(prepared.telemetry.officialPosting.comparisonOptions[1], 1);
        assert.equal(prepared.telemetry.officialPosting.comparativeMatches, 1);
        assert.equal(/Northwind|freight|Quote|prompt|evidence/u.test(JSON.stringify(prepared.telemetry)), false);
        assert.deepEqual(calls.map(call => call.comparisonRun), ['A', 'B']);
        assert.equal(calls[0].comparisonGroup, calls[1].comparisonGroup);
        const trusted = getPreparedOfficialPosting(prepared.resolutionId, job);
        assert.ok(trusted.description.includes('nightly route allocation across coastal depots'));
        assert.equal(trusted.applyUrl, fixture.candidateUrls[0]);
        assert.ok((await store.find(job)).officialPosting.trail.includes('comparative-choice-p1'));
      });
    },
  },
];
