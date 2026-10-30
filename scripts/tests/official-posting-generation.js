import { OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL } from '../../electron/ipc/officialPostingNegativePolicy.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import electronPkg from 'electron';
import { createOfficialPostingStore, officialPostingAliases } from '../../electron/ipc/officialPostingStore.js';
import { createOfficialPostingPrepareSemaphore, getPreparedOfficialPosting, prepareOfficialPostingForGeneration as prepareSemanticOfficialPostingForGeneration, registerOfficialPostingGenerationHandlers } from '../../electron/ipc/officialPostingGeneration.js';
import { officialPostingSemanticInputHash, officialPostingSemanticSourceHash } from '../../electron/ipc/officialPostingSemantic.js';
import { extractOfficialPostingCandidates } from '../../electron/ipc/officialPostingExtractors.js';
import { abortNodeTasksAndWait, beginSenderQuitPause, releaseSenderQuitPause, snapshotActiveNodeTasks } from '../../electron/ipc/ipcUtils.js';
import { refreshOfficialPostingEntries, validateOfficialPostingRefreshArgs, registerOfficialPostingRefreshHandler } from '../../electron/ipc/officialPostingRefresh.js';
import { resolveOfficialPostings } from '../../electron/ipc/officialPostingService.js';
import { __projectLocalApplicationJobForAcceptanceHarness as projectProductionJob, __freezeOfficialPostingJobForTests } from '../../electron/ipc/localAiApplication.js';

const text = 'Requirements include experience building reliable dispatch tools and maintaining reporting workflows. Engineers design clear interfaces for operations teams and validate changes through careful review. The role improves data quality across scheduled pipelines and documents decisions for partner groups. You will collaborate with colleagues to investigate delivery failures and make service behavior understandable. Responsibilities include writing tests for new features and improving tools that support teams use every day.';
const place = 'Lakeview, Ontario, Canada';
const officialUrl = 'https://northwind.test/jobs/one';
const job = (extra = {}) => ({ title: 'Software Engineer at Northwind Labs', company: 'Acme Talent Partners', location: place,
  snippet: `Our client is hiring. ${text}`, url: 'https://mirror.example/jobs/one', sourceJobKey: 'synthetic-one', ...extra });
const args = (value = job(), cardId = 'card-one') => ({ nodeId: 'board-one', cardId, manualAiRunId: `official-posting:${cardId}:run`, job: value });
const posting = (extra = {}) => ({ level: 'L1', outcome: 'found', employer: 'Northwind Labs', title: 'Software Engineer',
  location: { display: place, remote: false, workMode: '', remoteCountry: '', remoteRegion: '' },
  salary: { text: '', provenance: 'unknown' }, sourceUrl: officialUrl, officialApplyUrl: officialUrl,
  ats: '', tenant: '', trail: ['description-anchor'], ...extra });
const status = () => ({ enabled: true, link: { state: 'linked' }, chat: { pool: { active: true } } });
function page(description = text, extra = {}) { return `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting',
  title: 'Software Engineer', hiringOrganization: { name: 'Northwind Labs' }, description,
  jobLocation: { address: { addressLocality: 'Lakeview', addressRegion: 'Ontario', addressCountry: 'Canada' } }, ...extra })}</script>`; }
function livenessPage({ description = text, notice = '', extra = {} } = {}) {
  const surrounding = 'The careers page explains interview steps, team structure, benefits and working arrangements for candidates. '.repeat(5);
  return `<html><head><title>Software Engineer</title></head><body>${page(description, extra)}<main><h1>Software Engineer</h1><p>${description}</p><p>${surrounding}</p><aside>${notice}</aside></main></body></html>`;
}
function network(pages, calls = []) { return async url => { calls.push(url); const value = pages[url];
  if (!value) { const error = new Error('closed'); error.code = 'closed'; throw error; }
  return { url, contentType: 'text/html', statusCode: 200, ...(typeof value === 'string' ? { body: value } : value) };
}; }
async function withStore(run, options) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'official-generation-'));
  try { await run(createOfficialPostingStore(path.join(root, 'official-postings'), options)); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
async function waitFor(predicate) { for (let i = 0; i < 1000 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 2)); assert.ok(predicate(), 'expected asynchronous boundary is reached'); }
const fallbackResolve = async rows => ({ jobs: rows.map(row => ({ ...row, officialPosting: { level: 'L5', outcome: 'not-found', employer: row.company, trail: [] } })) });
// Historical reverify cases retain their explicit legacy contract. Production
// and the migration cases below use the semantic default.
const prepareOfficialPostingForGeneration = (args, options = {}) => prepareSemanticOfficialPostingForGeneration(args, { semanticMatching: false, ...options });
function semanticPosting(original, body = page(), extra = {}) {
  const candidate = extractOfficialPostingCandidates({ body, sourceUrl: officialUrl, contentType: 'text/html', employer: 'Northwind Labs' })[0];
  return posting({ title: candidate.title, location: candidate.location, salary: candidate.salary,
    semanticMatch: { version: 1, inputHash: officialPostingSemanticInputHash(original),
      sourceHash: officialPostingSemanticSourceHash({ ...candidate, provenance: 'employer' }) }, trail: ['semantic-match-v1', 'comparative-match'], ...extra });
}

export default [
  {
    name: 'production refresh preparation and queue projections retain identical bounded remote requisition and description source facts',
    async run() {
      const original = job({ description: text, remote: true, workMode: 'remote', remoteCountry: 'Canada',
        remoteRegion: 'Ontario', identifier: { '@type': 'PropertyValue', value: 'synthetic-req-123' },
        requisitionId: 'synthetic-req-123', hiringOrganization: { name: 'Northwind Labs' },
        locations: [{ display: 'Remote, Canada', remote: true, remoteCountry: 'Canada' }],
        employmentType: ['FULL_TIME'], seniority: 'Intermediate', sourceUrl: 'https://mirror.example/jobs/one' });
      const expected = projectProductionJob(original);
      const captures = [];
      const resolve = async rows => {
        captures.push(structuredClone(rows[0]));
        return { jobs: rows.map(row => ({ ...row, officialPosting: { level: 'L5', outcome: 'not-found', employer: row.company,
          semanticMatch: { version: 1, inputHash: officialPostingSemanticInputHash(row) }, trail: [OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL, 'bridge-research', 'semantic-match-v1'] } })) };
      };
      const store = { find: async () => null };
      await refreshOfficialPostingEntries({ nodeId: 'source-board', manualAiRunId: 'refresh-source-fields',
        entries: [{ cardId: 'source-card', job: original }] }, { store, resolve, bridgeStatus: status, projectJob: projectProductionJob });
      const prepared = await prepareSemanticOfficialPostingForGeneration(args(original), { store, resolve, bridgeStatus: status,
        projectJob: projectProductionJob, listingProbe: { probe: async () => ({ unknown: 'synthetic-unavailable' }) } });
      const receipt = getPreparedOfficialPosting(prepared.resolutionId, expected);
      assert.ok(receipt);
      const frozen = __freezeOfficialPostingJobForTests(original, receipt);
      for (const candidate of [...captures, receipt.scrapedJob, frozen]) {
        for (const field of ['description', 'remote', 'workMode', 'remoteCountry', 'remoteRegion', 'identifier', 'requisitionId',
          'hiringOrganization', 'locations', 'employmentType', 'seniority', 'sourceUrl']) assert.deepEqual(candidate[field], expected[field], field);
        assert.equal(officialPostingSemanticInputHash(candidate), officialPostingSemanticInputHash(expected));
      }
      assert.equal(captures.length, 2);
      assert.throws(() => projectProductionJob({ ...original, description: 'x'.repeat(80_001) }), /size limit/u);
      assert.throws(() => projectProductionJob({ ...original, remote: 'true' }), /invalid type/u);
      assert.throws(() => projectProductionJob({ ...original, identifier: { value: () => 'unsafe' } }), /serializable/u);
      const cycle = {}; cycle.value = cycle;
      assert.throws(() => projectProductionJob({ ...original, hiringOrganization: cycle }), /serializable/u);
    },
  },
  {
    name: 'nonforced refresh cheaply reuses only host-bound current semantic verification and researches edited legacy or failed-recheck rows',
    async run() {
      for (const mode of ['current', 'edited', 'legacy', 'failed-recheck']) await withStore(async store => {
        const original = job();
        const saved = mode === 'legacy' ? posting() : semanticPosting(original);
        await store.save(original, { officialPosting: saved, description: text });
        const current = { ...original, ...(mode === 'edited' ? { snippet: `${original.snippet} Additional current responsibility.` } : {}),
          officialPosting: { ...saved, ...(mode === 'failed-recheck' ? { trail: [...saved.trail, 'reverify-failed', 'fetch-failed'] } : {}) } };
        let fetches = 0; let research = 0;
        const result = await refreshOfficialPostingEntries({ nodeId: 'board-cache', manualAiRunId: `refresh-cache:${mode}`, force: false,
          entries: [{ cardId: 'cache-card', job: current }] }, { store, bridgeStatus: status,
          fetch: async () => { fetches++; throw Object.assign(new Error('Unavailable'), { code: 'fetch-failed' }); },
          callRaw: async prompt => { research++; return prompt.match(/Requested ids: ([a-f0-9, ]+)\./u)[1].split(', ')
            .map(id => `BEGIN OFFICIAL POSTING RESEARCH ${id}\nNOT FOUND\nEND OFFICIAL POSTING RESEARCH ${id}`).join('\n'); },
        });
        assert.equal(result.entries[0].officialPosting.sourceUrl, officialUrl);
        if (mode === 'current') { assert.equal(fetches, 0); assert.equal(research, 0); }
        else {
          assert.ok(fetches > 0, mode); assert.ok(research > 0, mode);
          assert.ok(result.entries[0].officialPosting.trail.includes('reverify-failed'), mode);
        }
      });
    },
  },
  {
    name: 'nonforced refresh reuses a current semantic miss only until its host cache TTL expires',
    async run() {
      let clock = Date.UTC(2030, 0, 1);
      await withStore(async store => {
        const original = job();
        const miss = { level: 'L5', outcome: 'not-found', employer: original.company,
          semanticMatch: { version: 1, inputHash: officialPostingSemanticInputHash(original) }, trail: [OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL, 'bridge-research', 'semantic-match-v1'] };
        await store.save(original, { officialPosting: miss });
        let research = 0;
        const refresh = () => refreshOfficialPostingEntries({ nodeId: 'board-miss-cache', manualAiRunId: 'refresh-miss-cache', force: false,
          entries: [{ cardId: 'miss-card', job: { ...original, officialPosting: miss } }] }, { store, now: () => clock, bridgeStatus: status,
          fetch: async () => { throw Object.assign(new Error('Unavailable'), { code: 'fetch-failed' }); },
          callRaw: async prompt => { research++; return prompt.match(/Requested ids: ([a-f0-9, ]+)\./u)[1].split(', ')
            .map(id => `BEGIN OFFICIAL POSTING RESEARCH ${id}\nNOT FOUND\nEND OFFICIAL POSTING RESEARCH ${id}`).join('\n'); } });
        assert.ok((await refresh()).entries[0].officialPosting.trail.includes('recent-miss'));
        assert.equal(research, 0);
        clock += 24 * 60 * 60_000;
        assert.equal((await refresh()).entries[0].officialPosting.trail.includes('recent-miss'), false);
        assert.equal(research, 1);
      }, { now: () => clock });
    },
  },
  {
    name: 'bulk official refresh preserves duplicate cards, source facts and order while using isolated leads and the shared semantic pipeline',
    async run() {
      const first = job({ description: text, remote: true, workMode: 'remote', remoteCountry: 'Canada',
        officialPosting: posting({ sourceUrl: 'https://card-lead.test/jobs/one' }), score: 85 });
      const second = job({ title: 'Product Engineer', url: 'https://mirror.example/jobs/two', sourceJobKey: 'two',
        officialPosting: posting({ sourceUrl: 'https://card-lead.test/jobs/two' }) });
      const request = { nodeId: 'board-refresh', manualAiRunId: 'official-refresh:one', entries: [
        { cardId: 'card-a', job: first }, { cardId: 'card-b', job: second }, { cardId: 'card-c', job: first },
      ] };
      const before = structuredClone(request); const progress = [];
      const refreshed = await refreshOfficialPostingEntries(request, { bridgeStatus: status, store: { find: async () => null },
        projectJob: row => ({ title: row.title, company: row.company, location: row.location, snippet: row.snippet, url: row.url, sourceJobKey: row.sourceJobKey }),
        resolve: async (rows, options) => {
          assert.equal(options.semanticMatching, true); assert.equal(options.bypassCache, true);
          // Production refresh lets ChatGPT read the pages: no host fetch session is opened.
          assert.equal(options.fetchSession, undefined);
          assert.deepEqual(options.candidateUrlsByRow, [['https://card-lead.test/jobs/one', officialUrl], ['https://card-lead.test/jobs/two', officialUrl], ['https://card-lead.test/jobs/one', officialUrl]]);
          assert.equal(rows[0].description, text); assert.equal(rows[0].remote, true);
          assert.equal(rows[0].remoteCountry, 'Canada'); assert.equal(rows[0].workMode, 'remote');
          for (const row of rows) { assert.equal(row.officialPosting, undefined); assert.equal(row.score, undefined); }
          options.onProgress({ completed: 2 });
          return { jobs: rows.map(row => ({ ...row, officialPosting: { level: 'L5', outcome: 'not-found', employer: row.company,
            semanticMatch: { version: 1, inputHash: officialPostingSemanticInputHash(row) }, trail: [OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL, 'bridge-research', 'semantic-match-v1'] } })), telemetry: { total: rows.length } };
        }, onProgress: value => progress.push(value) });
      assert.deepEqual(refreshed.entries.map(entry => entry.cardId), ['card-a', 'card-b', 'card-c']);
      assert.deepEqual(Object.keys(refreshed).sort(), ['entries', 'telemetry']);
      assert.deepEqual(refreshed.telemetry, { total: 3 });
      assert.deepEqual(progress.map(value => value.completed), [0, 2, 3]);
      assert.ok(progress.every(value => value.nodeId === request.nodeId && value.manualAiRunId === request.manualAiRunId && value.total === 3));
      assert.deepEqual(request, before, 'refresh cannot mutate source jobs or allocate Generate receipts');
    },
  },
  {
    name: 'official refresh retains host-bound historical verification on transient failure but never trusts a foreign cache or replaces a proved close',
    async run() {
      const original = job();
      const request = { nodeId: 'board-refresh', manualAiRunId: 'official-refresh:failure', entries: [{ cardId: 'card-a', job: original }] };
      for (const legacy of [false, true]) {
        const prior = { aliases: officialPostingAliases(original), officialPosting: legacy ? posting() : semanticPosting(original) };
        const refreshed = await refreshOfficialPostingEntries(request, { bridgeStatus: status, store: { find: async () => prior },
          resolve: async rows => ({ jobs: rows.map(row => ({ ...row, officialPosting: { level: 'L5', outcome: 'failed', employer: row.company,
            trail: ['bridge-research', 'fetch-failed'], fetchFailures: [{ url: officialUrl, code: 'fetch-failed', reason: 'access-denied', statusCode: 403 }] } })) }) });
        assert.equal(refreshed.entries[0].officialPosting.sourceUrl, officialUrl);
        assert.ok(refreshed.entries[0].officialPosting.trail.includes('reverify-failed'));
        assert.equal(refreshed.entries[0].officialPosting.fetchFailures[0].statusCode, 403);
        assert.equal(refreshed.entries[0].postedBy, original.company);
      }
      const closed = await refreshOfficialPostingEntries(request, { bridgeStatus: status,
        store: { find: async () => ({ aliases: officialPostingAliases(original), officialPosting: semanticPosting(original) }) },
        resolve: async rows => ({ jobs: rows.map(row => ({ ...row, officialPosting: { level: 'L5', outcome: 'closed', employer: row.company,
          semanticMatch: { version: 1, inputHash: officialPostingSemanticInputHash(row) }, trail: ['bridge-research', 'closed', 'semantic-match-v1'] } })) }) });
      assert.equal(closed.entries[0].officialPosting.outcome, 'closed');
      assert.equal(closed.entries[0].officialPosting.sourceUrl, undefined);
      const foreign = await refreshOfficialPostingEntries(request, { bridgeStatus: status,
        store: { find: async () => ({ aliases: officialPostingAliases(job({ title: 'Unrelated Supervisor' })), officialPosting: posting() }) },
        resolve: async (rows, options) => { assert.deepEqual(options.priorOfficialRecords, [null]); assert.deepEqual(options.candidateUrlsByRow, [[]]);
          return { jobs: rows.map(row => ({ ...row, officialPosting: { level: 'L5', outcome: 'failed', employer: row.company, trail: ['fetch-failed'] } })) }; } });
      assert.equal(foreign.entries[0].officialPosting.level, 'L5');
    },
  },
  {
    name: 'official refresh fails visibly before publishing unavailable, incomplete, reordered or unproved results',
    async run() {
      const request = { nodeId: 'board-refresh', manualAiRunId: 'official-refresh:invalid', entries: [{ cardId: 'card-a', job: job() }] };
      let calls = 0;
      await assert.rejects(refreshOfficialPostingEntries(request, { bridgeStatus: () => ({ enabled: false }),
        resolve: async () => { calls++; }, store: { find: async () => null } }), error => error.code === 'OFFICIAL_POSTING_RESEARCH_UNAVAILABLE');
      assert.equal(calls, 0);
      for (const result of [() => ({ jobs: [] }), rows => ({ jobs: [{ ...rows[0], title: 'Foreign role', officialPosting: { level: 'L5', outcome: 'failed', employer: rows[0].company, trail: ['failed'] } }] }),
        rows => ({ jobs: [{ ...rows[0], officialPosting: posting() }] }), rows => ({ jobs: [{ ...rows[0], officialPosting: { level: 'L5', outcome: 'not-found', employer: rows[0].company, trail: [OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL, 'bridge-research'] } }] })]) {
        await assert.rejects(refreshOfficialPostingEntries(request, { bridgeStatus: status, store: { find: async () => null }, resolve: async rows => result(rows) }),
          error => /^OFFICIAL_POSTING_REFRESH_(?:INCOMPLETE|INVALID)$/u.test(error.code));
      }
    },
  },
  {
    name: 'official refresh validates bounded serializable inputs and distinct card ownership',
    run() {
      const request = { nodeId: 'board-refresh', manualAiRunId: 'official-refresh:validation', entries: [{ cardId: 'card-a', job: job() }] };
      validateOfficialPostingRefreshArgs(request);
      for (const invalid of [{ ...request, entries: [] }, { ...request, entries: [...request.entries, ...request.entries] },
        { ...request, nodeId: {} }, { ...request, manualAiRunId: 'bad run' }, { ...request, force: 'yes' },
        { ...request, entries: [{ cardId: 'card-a', job: { title: 'x'.repeat(512 * 1024) } }] },
        { ...request, entries: [{ cardId: 'card-a', job: { invalid: () => {} } }] },
        { ...request, entries: Array.from({ length: 129 }, (_, index) => ({ cardId: `card-${index}`, job: job() })) }]) {
        assert.throws(() => validateOfficialPostingRefreshArgs(invalid), TypeError);
      }
      const cycle = {}; cycle.self = cycle;
      assert.throws(() => validateOfficialPostingRefreshArgs({ ...request, entries: [{ cardId: 'card-a', job: cycle }] }), TypeError);
    },
  },
  {
    name: 'bulk refresh IPC registers every card owner, emits scoped progress and cancels on card deletion and quit pause',
    async run() {
      const sender = new EventEmitter(); sender.id = 9081; sender.isDestroyed = () => false;
      const events = []; sender.send = (...values) => events.push(values);
      const previous = electronPkg.ipcMain.__getInvokeHandler('refresh-official-postings');
      const entered = deferred();
      try {
        registerOfficialPostingRefreshHandler({ projectJob: row => ({ ...row }), bridgeStatus: status, store: { find: async () => null },
          resolve: async (_rows, { signal, onProgress }) => { onProgress({ completed: 2 }); entered.resolve();
            return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } });
        const invoke = electronPkg.ipcMain.__getInvokeHandler('refresh-official-postings');
        const request = { nodeId: 'board-refresh-many', manualAiRunId: 'official-refresh:owners',
          entries: Array.from({ length: 12 }, (_, index) => ({ cardId: `refresh-card-${index}`, job: job() })) };
        const pending = invoke({ sender }, request); await entered.promise;
        assert.equal(snapshotActiveNodeTasks(sender.id).length, 13);
        assert.ok(events.some(([name, value]) => name === 'official-posting-refresh-progress' && value.completed === 2 && value.total === 12
          && value.manualAiRunId === request.manualAiRunId && value.nodeId === request.nodeId));
        await abortNodeTasksAndWait('refresh-card-11', sender);
        assert.equal((await pending).cancelled, true);
        assert.deepEqual(snapshotActiveNodeTasks(sender.id), []);
        beginSenderQuitPause(sender);
        assert.equal((await invoke({ sender }, request)).errorCode, 'APP_QUIT_PAUSED');
      } finally { releaseSenderQuitPause(sender); if (previous) electronPkg.ipcMain.handle('refresh-official-postings', previous); }
    },
  },
  {
    name: 'shared official resolver keeps per-row refresh leads isolated across discovery and research passes',
    async run() {
      const rows = [job({ title: 'Engineer One', sourceJobKey: 'one' }), job({ title: 'Engineer Two', sourceJobKey: 'two', url: 'https://mirror.example/jobs/two' })];
      const calls = [];
      const result = await resolveOfficialPostings(rows, { store: { find: async () => null },
        semanticMatching: false, candidateUrls: ['https://shared.test/careers'], candidateUrlsByRow: [['https://one.test/job'], ['https://two.test/job']],
        resolve: async (row, options) => { calls.push({ title: row.title, leads: options.candidateUrls }); return { officialPosting: { level: 'L5', outcome: 'not-found', employer: row.company, trail: ['fetch-failed'] } }; },
        callRaw: async prompt => [...prompt.matchAll(/Requested ids: ([a-f0-9, ]+)\./gu)][0][1].split(', ').map(id =>
          `BEGIN OFFICIAL POSTING RESEARCH ${id}\nNOT FOUND\nEND OFFICIAL POSTING RESEARCH ${id}`).join('\n') });
      assert.equal(result.jobs.length, 2); assert.equal(calls.length, 4);
      for (const call of calls) assert.deepEqual(call.leads, ['https://shared.test/careers', call.title === 'Engineer One' ? 'https://one.test/job' : 'https://two.test/job']);
    },
  },
  {
    name: 'fresh official closure refuses stale board-open and alternate links even with a generation override',
    async run() {
      await withStore(async store => {
        const original = job({ source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/synthetic-source-closed',
          listingLiveness: { board: 'linkedin', verdict: 'open', basis: 'ai', at: new Date().toISOString() },
          alternateListings: [{ board: 'indeed', url: 'https://www.indeed.com/viewjob?jk=synthetic-stale-alternate' }] });
        await store.save(original, { officialPosting: semanticPosting(original), description: text });
        let probes = 0;
        const prepared = await prepareSemanticOfficialPostingForGeneration({ ...args(original), listingOverride: true }, {
          store, bridgeStatus: status,
          resolve: async rows => ({ jobs: rows.map(row => ({ ...row,
            officialPosting: { level: 'L5', outcome: 'closed', employer: row.company, trail: ['bridge-research', 'closed'] } })) }),
          listingProbe: { probe: async () => { probes++; throw new Error('Closed official source cannot reopen through board links.'); } },
        });
        assert.equal(prepared.listingCheck.action, 'refuse-final');
        assert.equal(prepared.listingCheck.basis, 'official-closed');
        assert.equal(prepared.listingCheck.override, false);
        assert.equal(probes, 0);
        assert.deepEqual(prepared.listingLiveness, original.listingLiveness, 'historical board evidence remains separate');
        assert.equal(prepared.listingLinkUrl, '');
        assert.equal(getPreparedOfficialPosting(prepared.resolutionId, original).listingAudit, null);
      });
    },
  },
  {
    name: 'generation freezes a fresh shared-process official replacement instead of the prior verified URL',
    async run() {
      await withStore(async store => {
        const original = job(); await store.save(original, { officialPosting: semanticPosting(original), description: text });
        const replacement = 'https://northwind.test/jobs/replacement';
        const prepared = await prepareSemanticOfficialPostingForGeneration(args(original), { store, bridgeStatus: status,
          resolve: async rows => {
            const record = await store.save(original, { officialPosting: posting({ level: 'L4', outcome: 'link-only',
              sourceUrl: replacement, officialApplyUrl: replacement,
              semanticMatch: { version: 1, inputHash: officialPostingSemanticInputHash(original), sourceHash: 'c'.repeat(64) },
              trail: ['semantic-match-v1', 'comparative-match'] }) });
            return { jobs: [{ ...rows[0], officialPosting: record.officialPosting }] };
          } });
        assert.equal(prepared.listingCheck.action, 'proceed');
        assert.equal(getPreparedOfficialPosting(prepared.resolutionId, original).officialPosting.sourceUrl, replacement);
      });
    },
  },
  {
    name: 'semantic generation treats normalized card URLs as discovery-only leads and discards foreign host cache receipts',
    async run() {
      const cardUrl = 'https://card-lead.test/jobs/unverified';
      const original = job({ officialPosting: posting({ sourceUrl: cardUrl, officialApplyUrl: `${cardUrl}/apply` }) });
      const foreign = { aliases: officialPostingAliases(job({ title: 'Unrelated Supervisor', company: 'Other Employer' })),
        officialPosting: posting({ sourceUrl: 'https://foreign-cache.test/jobs/one' }) };
      let calls = 0;
      const prepared = await prepareSemanticOfficialPostingForGeneration(args(original), {
        store: { find: async () => foreign }, bridgeStatus: status,
        resolve: async (rows, options) => {
          calls++; assert.equal(options.bypassCache, true);
          assert.deepEqual(options.candidateUrls, [cardUrl, `${cardUrl}/apply`]);
          assert.equal(options.priorOfficialRecords, undefined);
          assert.equal(rows[0].officialPosting, undefined, 'renderer official facts cannot reach fresh identity authority');
          return { jobs: rows.map(row => ({ ...row,
            officialPosting: { level: 'L5', outcome: 'not-found', employer: row.company, trail: [OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL, 'bridge-research'] } })) };
        },
      });
      assert.equal(calls, 1);
      assert.equal(prepared.officialPosting.level, 'L5');
      assert.equal(prepared.officialPosting.sourceUrl, undefined, 'a card URL cannot become a verified result by itself');
    },
  },
  {
    name: 'official preparation store drain stays bounded when an injected store never returns',
    async run() {
      const started = deferred(); let released = false; let guard;
      const pending = prepareSemanticOfficialPostingForGeneration(args(), { bridgeStatus: status, timeoutMs: 5,
        slots: { acquire: async () => () => { released = true; } },
        store: { find: async () => { started.resolve(); return new Promise(() => {}); } },
      });
      await started.promise;
      try {
        const result = await Promise.race([pending, new Promise((_resolve, reject) => {
          guard = setTimeout(() => reject(new Error('The store drain exceeded its bounded cleanup allowance.')), 4_000);
        })]);
        assert.equal(released, true);
        assert.equal(result.listingCheck.action, 'refuse-retry');
        assert.ok(result.officialPosting.trail.includes('bridge-timeout'));
      } finally { clearTimeout(guard); }
    },
  },
  {
    name: 'official preparation cancellation drains an in-flight host store operation before releasing ownership',
    async run() {
      const started = deferred(); const finish = deferred(); const controller = new AbortController();
      let settled = false; let resolutions = 0;
      const pending = prepareSemanticOfficialPostingForGeneration(args(), { signal: controller.signal, bridgeStatus: status,
        store: { find: async () => { started.resolve(); await finish.promise; return null; } },
        resolve: async rows => { resolutions++; return fallbackResolve(rows); },
      });
      const rejected = assert.rejects(pending, /synthetic cancellation/u).then(() => { settled = true; });
      await started.promise; controller.abort(new Error('synthetic cancellation')); await flush();
      assert.equal(settled, false, 'cancel-and-wait still owns the in-flight filesystem operation');
      finish.resolve(); await rejected;
      assert.equal(resolutions, 0, 'cancelled store reads cannot start research afterwards');
    },
  },
  {
    name: 'official preparation cancellation never waits for an uncooperative research promise',
    async run() {
      const started = deferred(); const controller = new AbortController(); let settled = false;
      const pending = prepareSemanticOfficialPostingForGeneration(args(), { signal: controller.signal, bridgeStatus: status,
        store: { find: async () => null }, resolve: async () => { started.resolve(); return new Promise(() => {}); },
      });
      const rejected = assert.rejects(pending, /synthetic cancellation/u).then(() => { settled = true; });
      await started.promise; controller.abort(new Error('synthetic cancellation'));
      await waitFor(() => settled); await rejected;
    },
  },
  {
    name: 'production generation repeats a definitive cached miss and refuses generation when fresh research is unavailable',
    async run() {
      await withStore(async store => {
        const original = job({ source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/synthetic-cached-miss',
          listingLiveness: { board: 'linkedin', verdict: 'open', basis: 'open-marker', at: new Date().toISOString() } });
        await store.save(original, { officialPosting: { level: 'L5', outcome: 'not-found', employer: original.company,
          trail: [OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL, 'bridge-research', 'semantic-match-v1'],
          semanticMatch: { version: 1, inputHash: officialPostingSemanticInputHash(original) } } });
        let calls = 0;
        const prepared = await prepareSemanticOfficialPostingForGeneration(args(original), {
          store, bridgeStatus: () => ({ enabled: false }),
          resolve: async (rows, options) => {
            calls++; assert.equal(options.bypassCache, true);
            return { jobs: rows.map(row => ({ ...row, officialPosting: { level: 'L5', outcome: 'not-found', employer: row.company,
              trail: ['bridge-unavailable'] } })) };
          },
        });
        assert.equal(calls, 1);
        assert.equal(prepared.listingCheck.action, 'refuse-retry');
        assert.equal(prepared.officialPosting.trail.includes('recent-miss'), false);
        assert.equal(prepared.officialPosting.trail.includes('bridge-unavailable'), true);
      });
    },
  },
  {
    name: 'production generation refuses incomplete official research even with an open original listing and an override',
    async run() {
      for (const trail of [['bridge-unavailable'], ['fetch-timeout'], ['crawl-budget'], ['comparative-invalid'], []]) {
        const original = job({ source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/synthetic-retry',
          listingLiveness: { board: 'linkedin', verdict: 'open', basis: 'open-marker', at: new Date().toISOString() } });
        const prepared = await prepareSemanticOfficialPostingForGeneration({ ...args(original), listingOverride: true }, {
          store: { find: async () => null }, bridgeStatus: status,
          resolve: async rows => ({ jobs: rows.map(row => ({ ...row,
            officialPosting: { level: 'L5', outcome: 'not-found', employer: row.company, trail } })) }),
        });
        assert.equal(prepared.listingCheck.action, 'refuse-retry', trail.join(','));
        assert.equal(prepared.listingCheck.override, false);
        assert.equal(prepared.listingCheck.basis, 'official-lookup');
        assert.match(prepared.message, /retry Generate/iu);
        assert.equal(getPreparedOfficialPosting(prepared.resolutionId, original).listingCheck.action, 'refuse-retry');
      }
    },
  },
  {
    name: 'production generation retains a completed no-match fallback when the original listing is open',
    async run() {
      const original = job({ source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/synthetic-complete',
        listingLiveness: { board: 'linkedin', verdict: 'open', basis: 'open-marker', at: new Date().toISOString() } });
      const prepared = await prepareSemanticOfficialPostingForGeneration(args(original), {
        store: { find: async () => null }, bridgeStatus: () => ({ ...status(), chat: { pool: { active: false } } }),
        resolve: async rows => ({ jobs: rows.map(row => ({ ...row,
          officialPosting: { level: 'L5', outcome: 'not-found', employer: row.company, trail: [OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL, 'bridge-research', 'comparative-none'] } })) }),
      });
      assert.equal(prepared.listingCheck.action, 'proceed');
      assert.equal(prepared.officialPosting.level, 'L5');
      assert.equal(prepared.officialPosting.trail.includes('bridge-unavailable'), false);
    },
  },
  {
    name: 'official-posting prepare re-extracts changed host text, marks unavailable bridge and binds an opaque immutable record to exact scraped identity and aliases',
    async run() {
      await withStore(async store => {
        const original = job(); const before = JSON.stringify(original);
        const old = await store.save(original, { officialPosting: posting(), description: text });
        const changed = `${text} The current posting also includes reviewing route access policies.`;
        const prepared = await prepareOfficialPostingForGeneration(args(original), { store, bridgeStatus: () => ({ enabled: false }), fetch: network({ [officialUrl]: page(changed) }) });
        assert.equal(JSON.stringify(original), before); assert.match(prepared.resolutionId, /^[a-f0-9-]{36}$/u);
        assert.equal(prepared.officialPosting.level, 'L1'); assert.equal(prepared.postedBy, original.company);
        assert.ok(prepared.officialPosting.trail.includes('bridge-unavailable')); assert.ok(prepared.officialPosting.trail.includes('reverified'));
        assert.notEqual(prepared.officialPosting.contentHash, old.officialPosting.contentHash);
        const trusted = getPreparedOfficialPosting(prepared.resolutionId, original);
        assert.equal(trusted.description, changed); assert.equal(trusted.applyUrl, officialUrl); assert.equal(trusted.scrapedJob.company, original.company);
        for (const change of [{ title: 'Staff Engineer at Northwind Labs' }, { company: 'Other Talent Partners' }, { location: 'Riverton, Alberta, Canada' }, { url: 'https://mirror.example/jobs/two' }]) {
          assert.equal(getPreparedOfficialPosting(prepared.resolutionId, { ...original, ...change }), null);
        }
        assert.equal(getPreparedOfficialPosting(prepared.resolutionId, original).description, changed, 'foreign attempts do not consume the real queue entry');
        trusted.description = 'Changed by caller'; assert.equal(getPreparedOfficialPosting(prepared.resolutionId, original).description, changed);
        assert.equal(getPreparedOfficialPosting(prepared.resolutionId, original, { now: trusted.createdAt + 24 * 60 * 60 * 1000 }), null);
      });
    },
  },
  {
    name: 'official-posting prepare drops explicit 404 postings while preserving cached proof on weak expired wrong-title or redirected pages',
    async run() {
      for (const kind of ['closed', 'expired', 'title', 'redirect']) await withStore(async store => {
        const original = job(); await store.save(original, { officialPosting: posting(), description: text });
        const fetched = kind === 'closed' ? {} : { [officialUrl]: kind === 'redirect'
          ? { url: 'https://elsewhere.example/jobs/foreign', body: page() }
          : page(text, kind === 'expired' ? { validThrough: '2000-01-01T00:00:00Z' } : { title: 'Staff Engineer' }) };
        const read = network(fetched);
        const prepared = await prepareOfficialPostingForGeneration(args(original), { store, bridgeStatus: status, fetch: kind === 'closed'
          ? async () => { throw Object.assign(new Error('closed'), { code: 'closed', statusCode: 404 }); } : read });
        assert.equal(prepared.officialPosting.level, kind === 'closed' ? 'L6' : 'L1', kind);
        assert.equal(prepared.officialPosting.officialApplyUrl, kind === 'closed' ? undefined : officialUrl, kind);
        assert.equal(getPreparedOfficialPosting(prepared.resolutionId, original).description, kind === 'closed' ? undefined : text);
        if (kind === 'closed') {
          assert.equal(prepared.officialPosting.outcome, 'closed'); assert.equal((await store.find(original)).officialPosting.outcome, 'closed');
        } else assert.ok(prepared.officialPosting.trail.includes('reverify-failed'), kind);
      });
    },
  },
  {
    name: 'official-page expiry is demoted only after quoted AI closure and refuses without probing stale board links',
    async run() {
      await withStore(async store => {
        const original = job({ source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/synthetic-one' });
        await store.save(original, { officialPosting: posting(), description: text });
        const now = Date.parse('2026-10-26T12:00:00Z');
        let aiCalls = 0; let boardVisits = 0;
        const prepared = await prepareOfficialPostingForGeneration(args(original), {
          store, now: () => now, bridgeStatus: status,
          fetch: network({ [officialUrl]: livenessPage({ notice: 'Applications for this opening have ended.',
            extra: { validThrough: '2000-01-01T00:00:00Z' } }) }),
          callText: async (_prompt, request) => {
            aiCalls += 1; assert.equal(request.task, 'job-listing-liveness');
            return { rows: [{ id: 'r1', verdict: 'closed', quote: 'Applications for this opening have ended.' }] };
          },
          listingProbe: { probe: async url => { boardVisits += 1; assert.equal(url, original.url);
            return { board: 'linkedin', ruleKey: 'linkedin', requestedUrl: url, finalUrl: url,
              httpStatus: 404, title: 'Page not found', chromeText: 'This posting could not be found.' }; } },
        });
        assert.equal(aiCalls, 1); assert.equal(boardVisits, 0);
        assert.equal(prepared.officialPosting.level, 'L6'); assert.equal(prepared.officialPosting.outcome, 'closed');
        assert.equal(prepared.listingCheck.action, 'refuse-final');
        assert.equal(prepared.listingCheck.basis, 'official-closed');
        assert.equal(prepared.boardClosed, null, 'official closure does not invent a board closure observation');
        assert.equal((await store.find(original)).officialPosting.outcome, 'closed');
      });
    },
  },
  {
    name: 'official-page outside-description closure needs AI while description wording and mismatched pages never invoke it',
    async run() {
      await withStore(async store => {
        const original = job(); await store.save(original, { officialPosting: posting(), description: text });
        let calls = 0;
        const result = await prepareOfficialPostingForGeneration(args(original), { store, bridgeStatus: status,
          fetch: network({ [officialUrl]: livenessPage({ notice: 'This position has been filled.' }) }),
          callText: async () => { calls += 1; return { rows: [{ id: 'r1', verdict: 'closed', quote: 'This position has been filled.' }] }; } });
        assert.equal(calls, 1); assert.equal(result.officialPosting.level, 'L6'); assert.equal(result.officialPosting.outcome, 'closed');
      });
      for (const kind of ['description', 'title', 'redirect', 'unreadable', 'server']) await withStore(async store => {
        const original = job(); await store.save(original, { officialPosting: posting(), description: text });
        const inside = `${text} This position has been filled.`;
        const value = kind === 'description' ? livenessPage({ description: inside })
          : kind === 'title' ? livenessPage({ notice: 'This position has been filled.', extra: { title: 'Staff Engineer' } })
            : kind === 'redirect' ? { url: 'https://elsewhere.example/jobs/foreign', body: livenessPage({ notice: 'This position has been filled.' }) }
              : kind === 'unreadable' ? '<main><h1>Software Engineer</h1><p>This position has been filled.</p></main>'
                : { statusCode: 503, body: livenessPage({ notice: 'This position has been filled.' }) };
        let calls = 0;
        const result = await prepareOfficialPostingForGeneration(args(original), { store, bridgeStatus: status,
          fetch: network({ [officialUrl]: value }), callText: async () => { calls += 1; return { rows: [{ id: 'r1', verdict: 'closed', quote: 'This position has been filled.' }] }; } });
        assert.equal(calls, 0, kind); assert.equal(result.officialPosting.level, 'L1', kind);
        assert.notEqual(result.officialPosting.outcome, 'closed', kind);
      });
    },
  },
  {
    name: 'official-page unconfirmed expiry preserves the prior proof with a bounded liveness audit fact',
    async run() {
      for (const kind of ['unavailable', 'unclear', 'no-quote', 'description-quote', 'json-only-quote', 'timeout']) await withStore(async store => {
        const original = job(); await store.save(original, { officialPosting: posting(), description: text });
        let calls = 0;
        const body = kind === 'json-only-quote'
          ? `<html><body>${page(text, { validThrough: '2000-01-01T00:00:00Z' })}<main><h1>Software Engineer</h1><p>${'Candidates can read the application steps and learn about the hiring process. '.repeat(4)}</p></main></body></html>`
          : livenessPage({ extra: { validThrough: '2000-01-01T00:00:00Z' } });
        const prepared = await prepareOfficialPostingForGeneration(args(original), {
          store, bridgeStatus: kind === 'unavailable' ? () => ({ enabled: false }) : status,
          fetch: network({ [officialUrl]: body }),
          callText: async () => {
            calls += 1;
            if (kind === 'timeout') throw Object.assign(new Error('timed out'), { code: 'bridge-timeout' });
            return { rows: [{ id: 'r1', verdict: kind === 'unclear' ? 'unclear' : 'closed',
              quote: ['description-quote', 'json-only-quote'].includes(kind) ? 'Engineers design clear interfaces' : '' }] };
          },
        });
        assert.equal(calls, kind === 'unavailable' ? 0 : 1, kind);
        assert.equal(prepared.officialPosting.level, 'L1', kind);
        assert.ok(prepared.officialPosting.trail.includes('reverify-failed'), kind);
        assert.ok(prepared.officialPosting.trail.includes('official-liveness-unconfirmed'), kind);
        assert.equal((await store.find(original)).officialPosting.outcome, 'found', kind);
      });
    },
  },
  {
    name: 'official-posting prepare freezes confirmed-open-or-unknown variants after the primary decision',
    async run() {
      const closedUrl = 'https://www.linkedin.com/jobs/view/synthetic-variant-closed';
      const unknownUrl = 'https://www.linkedin.com/jobs/view/synthetic-variant-unknown';
      const original = job({ postingVariants: [
        { location: 'North', url: closedUrl }, { location: 'South', url: unknownUrl },
      ] });
      const visits = [];
      const prepared = await prepareOfficialPostingForGeneration(args(original), {
        store: { find: async () => null }, resolve: fallbackResolve,
        bridgeStatus: () => ({ enabled: false }),
        listingProbe: { probe: async url => { visits.push(url);
          if (url === closedUrl) return { requestedUrl: url, finalUrl: url, httpStatus: 404,
            board: 'linkedin', ruleKey: 'linkedin', title: 'Page not found', chromeText: 'Page not found' };
          return { unknown: true }; } },
      });
      assert.equal(prepared.listingCheck.action, 'proceed');
      assert.deepEqual(visits, [closedUrl, unknownUrl]);
      assert.deepEqual(prepared.postingVariants.map(variant => variant.location), ['South']);
      const frozen = getPreparedOfficialPosting(prepared.resolutionId, original);
      assert.deepEqual(frozen.postingVariants, prepared.postingVariants);
      assert.deepEqual(frozen.scrapedJob.postingVariants, original.postingVariants,
        'variant filtering must not change scraped identity');
    },
  },
  {
    name: 'official-posting prepare can re-read a live JS ATS source only through its proven tenant API and exact stored posting URL',
    async run() {
      const url = 'https://jobs.ashbyhq.com/northwind/req-one';
      const api = 'https://api.ashbyhq.com/posting-api/job-board/northwind?includeCompensation=true';
      for (const foreign of [false, true]) await withStore(async store => {
        const original = job(); await store.save(original, { officialPosting: posting({ level: 'L2', ats: 'ashby', tenant: 'northwind', sourceUrl: url, officialApplyUrl: url }), description: text });
        const calls = []; const changed = `${text} Additional responsibilities include reviewing shared release checklists.`;
        const prepared = await prepareOfficialPostingForGeneration(args(original), { store, bridgeStatus: status, fetch: network({
          [url]: '<main>A JavaScript application loads the role.</main>', [api]: { contentType: 'application/json', body: JSON.stringify({ jobs: [{ id: 'req-one', title: 'Software Engineer',
            location: place, isListed: true, descriptionPlain: changed, jobUrl: foreign ? 'https://jobs.ashbyhq.com/other/req-one' : url, applyUrl: url }] }) },
        }, calls) });
        assert.deepEqual(calls, [url, api]);
        assert.equal(prepared.officialPosting.level, 'L2');
        assert.equal(getPreparedOfficialPosting(prepared.resolutionId, original).description, foreign ? text : changed);
        assert.equal(prepared.officialPosting.trail.includes('reverify-failed'), foreign);
      });
    },
  },
  {
    name: 'official-posting prepare preserves recent misses without research, retries expired misses and checks actual bridge status before slot/store work',
    async run() {
      let time = Date.parse('2026-01-01T00:00:00Z');
      await withStore(async store => {
        const original = job(); await store.save(original, { officialPosting: { level: 'L6', outcome: 'not-found', employer: '', trail: [OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL, 'bridge-research'] } });
        let calls = 0; const order = [];
        const options = { store: { ...store, find: async row => { order.push('store'); return store.find(row); } }, now: () => time,
          bridgeStatus: () => { order.push('status'); return status(); }, slots: { acquire: async () => { order.push('slot'); return () => {}; } },
          resolve: async (rows, options) => { calls++; assert.equal(options.manualAiRunId, args().manualAiRunId); assert.equal(options.nodeId, 'board-one'); return fallbackResolve(rows); } };
        const recent = await prepareOfficialPostingForGeneration(args(original), options);
        assert.equal(calls, 0); assert.ok(recent.officialPosting.trail.includes('recent-miss')); assert.deepEqual(order, ['status', 'slot', 'store']);
        time += 24 * 60 * 60 * 1000;
        await prepareOfficialPostingForGeneration(args(original), options); assert.equal(calls, 1);
      }, { now: () => time });
    },
  },
  {
    name: 'official-posting prepare admits only three operations and its whole budget includes a cancellable slot wait',
    async run() {
      await withStore(async store => {
        const slots = createOfficialPostingPrepareSemaphore(); const releases = []; let running = 0; let peak = 0;
        const resolve = async rows => { running++; peak = Math.max(peak, running); const gate = deferred(); releases.push(gate);
          await gate.promise; running--; return fallbackResolve(rows); };
        const prepare = index => prepareOfficialPostingForGeneration(args(job({ url: `https://mirror.example/jobs/${index}`, sourceJobKey: String(index) }), `card-${index}`), { store, slots, bridgeStatus: status, resolve });
        const pending = [prepare(1), prepare(2), prepare(3), prepare(4)]; await waitFor(() => releases.length === 3);
        assert.equal(releases.length, 3); assert.equal(peak, 3);
        releases[0].resolve(); await waitFor(() => releases.length === 4); assert.equal(releases.length, 4);
        releases.slice(1).forEach(gate => gate.resolve()); await Promise.all(pending); assert.equal(peak, 3);
        const single = createOfficialPostingPrepareSemaphore(1); const release = await single.acquire();
        let invoked = false;
        const timed = prepareOfficialPostingForGeneration(args(job({ sourceJobKey: 'waiting' })), { store, slots: single, bridgeStatus: status,
          timeoutMs: 5, resolve: async rows => { invoked = true; return fallbackResolve(rows); } });
        const keepAlive = setTimeout(() => {}, 25); const result = await timed; clearTimeout(keepAlive); release();
        assert.equal(invoked, false); assert.ok(result.officialPosting.trail.includes('bridge-timeout'));
      });
    },
  },
  {
    name: 'official-posting prepare IPC registers one controller under validated Board and card ownership and reports explicit cancellation',
    async run() {
      await withStore(async store => {
        const previous = electronPkg.ipcMain.__getInvokeHandler('prepare-official-posting-for-generation');
        const sender = new EventEmitter(); sender.id = 9071; sender.isDestroyed = () => false;
        try {
          registerOfficialPostingGenerationHandlers({ projectJob: row => ({ ...row }), store, bridgeStatus: status,
            resolve: async (_rows, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
          const invoke = electronPkg.ipcMain.__getInvokeHandler('prepare-official-posting-for-generation');
          const first = invoke({ sender }, args(job(), 'card-a'));
          const second = invoke({ sender }, args(job({ sourceJobKey: 'second', url: 'https://mirror.example/jobs/second' }), 'card-b'));
          await flush();
          const owners = snapshotActiveNodeTasks(sender.id); assert.equal(owners.find(owner => owner.nodeId === 'board-one').taskCount, 2);
          assert.equal(owners.find(owner => owner.nodeId === 'card-a').taskCount, 1);
          await abortNodeTasksAndWait('card-a', sender); assert.equal((await first).cancelled, true);
          assert.ok(snapshotActiveNodeTasks(sender.id).some(owner => owner.nodeId === 'card-b'));
          await abortNodeTasksAndWait('board-one', sender); assert.equal((await second).cancelled, true);
          assert.deepEqual(snapshotActiveNodeTasks(sender.id), []);
          assert.equal((await invoke({ sender }, { ...args(), cardId: { bad: true } })).success, false); assert.deepEqual(snapshotActiveNodeTasks(sender.id), []);
          beginSenderQuitPause(sender);
          assert.equal((await invoke({ sender }, args())).errorCode, 'APP_QUIT_PAUSED');
        } finally { releaseSenderQuitPause(sender); if (previous) electronPkg.ipcMain.handle('prepare-official-posting-for-generation', previous); }
      });
    },
  },
  {
    name: 'semantic generation rechecks legacy proof with AI and never returns it after a failed fresh resolution',
    async run() {
      for (const reject of [false, true]) await withStore(async store => {
        const original = job(); await store.save(original, { officialPosting: posting(), description: text });
        let calls = 0; let fetches = 0;
        const prepared = await prepareSemanticOfficialPostingForGeneration(args(original), { store, bridgeStatus: status,
          fetch: async () => { fetches++; throw new Error('Legacy proof is not eligible for direct reverify.'); },
          resolve: async (rows, options) => {
            calls++; assert.equal(options.semanticMatching, true); assert.equal(options.bypassCache, true);
            assert.deepEqual(options.candidateUrls, [officialUrl]);
            if (reject) throw Object.assign(new Error('AI unavailable'), { code: 'comparative-unavailable' });
            return fallbackResolve(rows);
          } });
        assert.equal(calls, 1); assert.equal(fetches, 0);
        assert.ok(['L5', 'L6'].includes(prepared.officialPosting.level));
        assert.equal(prepared.officialPosting.officialApplyUrl, undefined);
        assert.equal(getPreparedOfficialPosting(prepared.resolutionId, original).description, undefined);
        for (const change of [{ snippet: 'Edited source responsibilities.' }, { salary: 'CAD 135000 per year', salaryProvenance: 'posted' }]) {
          assert.equal(getPreparedOfficialPosting(prepared.resolutionId, { ...original, ...change }), null, 'miss and unavailable receipts also bind the complete input');
        }
        assert.ok(getPreparedOfficialPosting(prepared.resolutionId, original), 'rejected changed inputs do not consume the original receipt');
      });
    },
  },
  {
    name: 'semantic generation reruns current host fetches and both shared AI comparisons on every unchanged cached posting',
    async run() {
      await withStore(async store => {
        const original = job(); await store.save(original, { officialPosting: semanticPosting(original), description: text });
        const requests = []; const comparisons = [];
        const fetch = network({ [officialUrl]: page(), 'https://northwind.test/': '<title>Northwind Labs</title>' }, requests);
        for (let attempt = 0; attempt < 2; attempt++) {
          const prepared = await prepareSemanticOfficialPostingForGeneration(args(original), { store, bridgeStatus: status, fetch,
            callRaw: async () => { throw new Error('A verified fresh source needs final comparisons before broader research.'); },
            callMatch: async (_prompt, options) => {
              comparisons.push(options.manualHandoff.comparisonRun);
              return { choice: 'P1', evidence: [{ scrapedQuote: 'Software Engineer', officialQuote: 'Software Engineer' }], distinguishing: [], conflicts: [] };
            } });
          assert.equal(prepared.officialPosting.level, 'L1');
          assert.equal(prepared.officialPosting.trail.includes('reverified'), false);
          assert.equal(prepared.officialPosting.trail.includes('cache-hit'), false);
          const receipt = getPreparedOfficialPosting(prepared.resolutionId, original);
          assert.equal(receipt.description, text);
          assert.equal(receipt.freshness, 'fresh-discovery');
          assert.equal(Date.parse(prepared.preparedAt), receipt.createdAt);
          for (const change of [{ snippet: `${original.snippet} New scope.` }, { workMode: 'remote' }, { identifier: 'different-req' }]) {
            assert.equal(getPreparedOfficialPosting(prepared.resolutionId, { ...original, ...change }), null);
          }
        }
        assert.equal(requests.filter(url => url === officialUrl).length, 2, 'each Generate owns a fresh host fetch session');
        assert.deepEqual(comparisons, ['A', 'B', 'A', 'B']);
      });
    },
  },
  {
    name: 'semantic generation sends changed title location and requisition facts to AI without deterministic identity rejection',
    async run() {
      for (const extra of [{ title: 'Platform Developer' }, { jobLocation: { address: { addressLocality: 'Lakeview', addressRegion: 'ON', addressCountry: 'CA' } } },
        { identifier: { value: 'REQ-NEW' } }]) await withStore(async store => {
        const original = job(); await store.save(original, { officialPosting: semanticPosting(original), description: text });
        let resolutions = 0;
        const prepared = await prepareSemanticOfficialPostingForGeneration(args(original), { store, bridgeStatus: status,
          fetch: network({ [officialUrl]: page(text, extra) }), resolve: async (rows, options) => {
            resolutions++; assert.equal(options.semanticMatching, true); assert.equal(options.bypassCache, true);
            assert.deepEqual(options.candidateUrls, [officialUrl]); return fallbackResolve(rows);
          } });
        assert.equal(resolutions, 1); assert.ok(['L5', 'L6'].includes(prepared.officialPosting.level));
        assert.equal(prepared.officialPosting.officialApplyUrl, undefined);
      });
    },
  },
  {
    name: 'semantic generation accepts changed official text only through newly saved semantic proof',
    async run() {
      await withStore(async store => {
        const original = job(); await store.save(original, { officialPosting: semanticPosting(original), description: text });
        const changed = `${text} The role also owns route planning.`; const changedPage = page(changed, { title: 'Platform Developer' });
        let resolutions = 0;
        const prepared = await prepareSemanticOfficialPostingForGeneration(args(original), { store, bridgeStatus: status,
          fetch: network({ [officialUrl]: changedPage }), resolve: async rows => {
            resolutions++; const record = await store.save(original, { officialPosting: semanticPosting(original, changedPage), description: changed });
            return { jobs: [{ ...rows[0], officialPosting: record.officialPosting }] };
          } });
        assert.equal(resolutions, 1); assert.equal(prepared.officialPosting.title, 'Platform Developer');
        assert.equal(getPreparedOfficialPosting(prepared.resolutionId, original).description, changed);
        assert.equal((await store.find(original)).officialPosting.title, 'Platform Developer');
      });
    },
  },
  {
    name: 'semantic generation sends formerly verified sources through current shared resolution rather than direct reverify',
    async run() {
      for (const outcome of ['closed', 'failed']) await withStore(async store => {
        const original = job(); const before = await store.save(original, { officialPosting: semanticPosting(original), description: text });
        let resolutions = 0; let directFetches = 0;
        const prepared = await prepareSemanticOfficialPostingForGeneration(args(original), { store, bridgeStatus: status,
          fetch: async () => { directFetches++; throw new Error('Only the shared process may decide fresh source status.'); },
          resolve: async (rows, options) => {
            resolutions++; assert.equal(options.bypassCache, true);
            assert.deepEqual(options.priorOfficialRecords[0].officialPosting, before.officialPosting);
            return { jobs: rows.map(row => ({ ...row, officialPosting: { level: 'L5', outcome, employer: row.company,
              trail: outcome === 'closed' ? ['bridge-research', 'closed'] : ['fetch-failed'] } })) };
          } });
        assert.equal(resolutions, 1); assert.equal(directFetches, 0);
        assert.equal(prepared.officialPosting.level, 'L5');
        assert.equal(prepared.officialPosting.officialApplyUrl, undefined);
        assert.equal(prepared.officialPosting.outcome, outcome);
        assert.equal(getPreparedOfficialPosting(prepared.resolutionId, original).description, undefined);
      });
    },
  },
  {
    name: 'semantic generation timeout after detecting changed source cannot resurrect prior proof',
    async run() {
      await withStore(async store => {
        const original = job(); await store.save(original, { officialPosting: semanticPosting(original), description: text });
        const started = deferred();
        const pending = prepareSemanticOfficialPostingForGeneration(args(original), { store, bridgeStatus: status, timeoutMs: 30,
          fetch: network({ [officialUrl]: page(`${text} Changed source facts.`) }),
          resolve: async () => { started.resolve(); return new Promise(() => {}); } });
        await started.promise; const keepAlive = setTimeout(() => {}, 50);
        const prepared = await pending; clearTimeout(keepAlive);
        assert.equal(prepared.officialPosting.level, 'L6'); assert.equal(prepared.officialPosting.officialApplyUrl, undefined);
        assert.equal(prepared.officialPosting.trail.includes('bridge-timeout'), true);
      });
    },
  },
];
