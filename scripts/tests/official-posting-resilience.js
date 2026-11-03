import { OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL } from '../../electron/ipc/officialPostingNegativePolicy.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ipcMain } from 'electron';
import { normalizeOfficialPosting } from '../../electron/ipc/officialPostingFields.js';
import { unresolvedOfficialPosting, officialPostingRequestId } from '../../electron/ipc/officialPostingResolver.js';
import { refreshOfficialPostingEntries } from '../../electron/ipc/officialPostingRefresh.js';
import { createOfficialPostingStore, officialPostingView } from '../../electron/ipc/officialPostingStore.js';
import { prepareOfficialPostingForGeneration } from '../../electron/ipc/officialPostingGeneration.js';
import { officialPostingSemanticInputHash, officialPostingSemanticSourceHash } from '../../electron/ipc/officialPostingSemantic.js';
import { __freezeOfficialPostingJobForTests } from '../../electron/ipc/localAiApplication.js';
import { __registerJobsHandlersForTests, getJobsTelemetry, registerJobsHandlers } from '../../electron/ipc/jobs.js';
import { claimJobAnalysisOperationAuthority } from '../../electron/ipc/jobAnalysisOperationAuthorityStore.js';
import { writeApprovedCareerSnapshotFixture } from './careerSnapshotFixture.mjs';

const DESCRIPTION = 'Requirements include experience building reliable dispatch services and maintaining reconciliation workflows. '
  + 'Engineers design operational interfaces for route planners and validate migration changes with repeatable checks. '
  + 'The role includes diagnosing delayed ledger updates, documenting deployment dependencies, and reviewing service ownership. '
  + 'You will partner with platform colleagues to investigate delivery failures and make system behavior understandable. '
  + 'Responsibilities include writing diagnostic tests and maintaining tools for regional dispatch operations.';
const job = (extra = {}) => ({ title: 'Software Engineer', company: 'Northwind Labs', location: 'Lakeview, Ontario, Canada',
  snippet: DESCRIPTION, salary: '', salaryProvenance: 'unknown', source: 'remoteok',
  url: 'https://www.linkedin.com/jobs/view/synthetic-one', ...extra });

async function withStore(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'official-resilience-'));
  try { return await run(createOfficialPostingStore(path.join(root, 'official-postings')), root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

// Search no longer researches. The resolver below is a tripwire: any call to it
// from the search path is recorded, and the tests assert there are none.
async function search(rows, { prepareStore } = {}) {
  return withStore(async (store, root) => {
    const resolverCalls = []; const progress = [];
    await prepareStore?.(store, rows);
    const canvasFilePath = path.join(root, 'canvas.json');
    const nodeId = `resilience-${path.basename(root)}`;
    await fs.writeFile(canvasFilePath, '{}');
    const { snapshotId: careerSnapshotId } = await writeApprovedCareerSnapshotFixture();
    const authority = await claimJobAnalysisOperationAuthority({ canvasFilePath, hubId: nodeId, operationId: 'search-one',
      semanticBase: { kind: 'search', careerSnapshotId, runId: null, fingerprint: 'synthetic-resilience',
        analysisRevisionId: null, continuationId: null, sourceArtifactFingerprint: null } });
    assert.equal(authority.admitted, true);
    __registerJobsHandlersForTests({
      resolveRequiredPinnedCareerInput: async () => ({ profile: {}, careerData: '', pinned: true }),
      fetchHttpSources: async (...args) => {
        await args[10]('remoteok');
        const result = { sourceId: 'remoteok', jobs: rows, gathered: rows.length };
        await args[11]('remoteok', result);
        await args[8]({ sourceId: 'remoteok', query: 'software engineer', page: 1, jobs: rows });
        return [result];
      },
      officialPostingStore: store,
      resolveOfficialPostings: async jobs => { resolverCalls.push(jobs.map(row => row.url)); throw new Error('Search must not research.'); },
    });
    try {
      const sender = { id: 72991, isDestroyed: () => false, once() {}, on() {}, removeListener() {},
        send(channel, payload) { if (channel === 'job-source-progress') progress.push(payload); } };
      const result = await ipcMain.__getInvokeHandler('search-jobs')({ sender }, {
        queries: ['software engineer'], nodeId, canvasFilePath, careerSnapshotId, operationAuthority: authority.receipt,
        enabledSourceIds: ['remoteok'], targetRole: '', preferredLocation: '',
      });
      return { result, telemetry: structuredClone(getJobsTelemetry()), resolverCalls, progress };
    } finally { registerJobsHandlers(); }
  });
}

// A model that finds a posting on the row's own host for every healthy row it is
// given and answers NOT FOUND for the rest, with snapshots unavailable.
function healthyResolverFixture(healthyRows) {
  const hostRows = new Map(healthyRows.map(row => [officialPostingRequestId(row), row]));
  const offline = async () => { throw Object.assign(new Error('offline test'), { code: 'fetch-failed' }); };
  const callRaw = (prompt, options) => {
    const ids = prompt.match(/Requested ids: ([a-f0-9, ]+)\./u)[1].split(', ');
    const answer = ids.map(id => `BEGIN OFFICIAL POSTING RESEARCH ${id}\n${hostRows.has(id)
      ? `CANDIDATE: ${JSON.stringify({ careersPageUrl: `https://${new URL(hostRows.get(id).url).host}/`, postingUrl: hostRows.get(id).url,
        employer: hostRows.get(id).company, employerDomain: '', ats: '' })}` : 'NOT FOUND'}\nEND OFFICIAL POSTING RESEARCH ${id}`).join('\n');
    options.responseValidator(answer);
    return answer;
  };
  const callMatch = (prompt, options) => {
    const leads = JSON.parse(prompt.split('BEGIN HOST LEADS JSON\n')[1].split('\nEND HOST LEADS JSON')[0]);
    const lead = leads.find(item => item.kind === 'posting'); const row = [...hostRows.values()].find(item => item.url === lead.url);
    const answer = { choice: lead.id, postingUrl: lead.url, status: 'open', statusQuote: 'Apply now', employerLinked: true,
      employerPageUrl: `https://${new URL(lead.url).host}/`, employerLinkQuote: 'Careers', title: row.title, employer: row.company,
      location: row.location, salary: '', description: DESCRIPTION, conflicts: [],
      evidence: [{ scrapedQuote: DESCRIPTION, officialQuote: DESCRIPTION }] };
    options.responseValidator(JSON.stringify(answer));
    return JSON.stringify(answer);
  };
  return { callRaw, callMatch, offline };
}

export default [
  {
    name: 'Official posting resilience: fallback sanitizes bounded display fields and has a constant last resort',
    run() {
      for (const company of ['Tech <3 Labs', 'Cedar\u0001Works', 'Cedar\u007fWorks', 'Tech ＞ Labs']) {
        const input = job({ company }); const before = JSON.stringify(input);
        const result = unresolvedOfficialPosting(input, { outcome: 'ambiguous', alternatives: [
          { url: 'https://careers.northwind.example/jobs/one', title: 'Staff Engineer > Platform\u0001' },
          { url: 'https://careers.northwind.example/jobs/two', title: 'x'.repeat(600) },
          { url: 'https://careers.northwind.example/' + 'x'.repeat(2100), title: 'Invalid URL' },
        ] });
        assert.ok(normalizeOfficialPosting(result.officialPosting));
        assert.equal(result.officialPosting.outcome, 'ambiguous');
        // eslint-disable-next-line no-control-regex
        assert.equal(/[<>\x00-\x1f\x7f]/u.test(result.officialPosting.employer), false);
        assert.equal(result.officialPosting.alternatives.length, 2);
        assert.equal(result.officialPosting.alternatives[0].title, 'Staff Engineer  Platform');
        assert.equal(result.officialPosting.alternatives[1].title.length, 500);
        assert.equal(JSON.stringify(input), before);
      }
      assert.deepEqual(unresolvedOfficialPosting(job(), { outcome: 'not-a-real-outcome' }).officialPosting,
        { level: 'L6', outcome: 'failed', employer: '', trail: ['failed'] });
    },
  },
  {
    name: 'Official posting resilience: L5 queue fallback preserves the scraped company with or without a prepared fallback',
    run() {
      const input = job({ company: 'Tech <3 Labs' });
      for (const prepared of [null, unresolvedOfficialPosting(input)]) {
        const frozen = __freezeOfficialPostingJobForTests(input, prepared);
        assert.equal(frozen.company, input.company);
        assert.equal(frozen.snippet, input.snippet);
        assert.equal(frozen.officialPosting.level, 'L5');
        assert.equal(frozen.applyUrl, '');
      }
      const telemetry = { failed: 0 };
      const broken = { get officialPosting() { throw new Error('Synthetic record read failure.'); } };
      const frozen = __freezeOfficialPostingJobForTests(input, broken, telemetry);
      assert.equal(frozen.company, input.company);
      assert.equal(frozen.officialPosting.outcome, 'failed');
      assert.equal(telemetry.failed, 1);
    },
  },
  {
    name: 'Official posting resilience: prepare returns a valid fallback and counts non-abort projection or storage faults',
    async run() {
      const input = job({ company: 'Tech <3 Labs' });
      const args = { job: input, nodeId: 'resilience-board', cardId: 'resilience-card', manualAiRunId: 'resilience-run' };
      for (const dependencies of [
        { projectJob() { throw new Error('Synthetic projection failure.'); } },
        { projectJob: () => null },
        { store: { async find() { throw new Error('Synthetic read failure.'); } } },
      ]) {
        const telemetry = { failed: 0 };
        // This fault fixture verifies official fallback, not a live LinkedIn visit.
        const listingProbe = { probe: async () => ({ unknown: 'synthetic-unavailable' }) };
        const result = await prepareOfficialPostingForGeneration(args, { ...dependencies, telemetry,
          bridgeStatus: () => ({ enabled: false }), listingProbe });
        assert.ok(normalizeOfficialPosting(result.officialPosting));
        assert.equal(telemetry.failed, 1); assert.equal(result.telemetry.failed, 1);
        assert.equal(input.company, 'Tech <3 Labs');
      }
      const controller = new AbortController(); controller.abort(new Error('Synthetic user stop.'));
      const telemetry = { failed: 0 };
      await assert.rejects(prepareOfficialPostingForGeneration(args, { signal: controller.signal, telemetry,
        projectJob() { throw new Error('Projection did not run.'); } }), /Synthetic user stop/u);
      assert.equal(telemetry.failed, 0);
    },
  },
  {
    name: 'Official posting resilience: L6 scoring view retains scraped company without granting letter authority',
    async run() {
      await withStore(async store => {
        const input = job({ company: 'Acme Talent Partners' });
        const posting = { level: 'L6', outcome: 'not-found', employer: '', trail: [] };
        await store.save(input, { officialPosting: posting });
        const view = await officialPostingView({ ...input, officialPosting: posting }, { store });
        assert.equal(view.employer, input.company); assert.equal(view.postedBy, input.company);
        assert.equal(__freezeOfficialPostingJobForTests(input, { officialPosting: posting }).company, '');
      });
    },
  },
  {
    name: 'Official posting resilience: real search no longer researches and leaves rows scraped around an invalid employer',
    async run() {
      const rows = [job({ url: 'https://careers.northwind.example/jobs/one' }), job({ company: 'Tech <3 Labs' }),
        job({ company: 'Cedar Works', url: 'https://careers.cedar.example/jobs/two' })];
      const { result, telemetry, resolverCalls, progress } = await search(rows);
      assert.equal(result.success, true, result.error); assert.equal(result.jobs.length, 3);
      assert.deepEqual(resolverCalls, [], 'search must make no official posting research call');
      assert.equal(progress.some(item => /Finding official postings/u.test(item.detail || '')), false);
      assert.equal(progress.some(item => item.sourceId === 'official-posting'), false);
      const byId = new Map(result.jobs.map(row => [officialPostingRequestId(row), row]));
      for (const row of rows) {
        const actual = byId.get(officialPostingRequestId(row)); assert.ok(actual, row.company);
        assert.equal(actual.company, row.company); assert.equal(actual.snippet, row.snippet); assert.equal(actual.url, row.url);
        assert.equal(Object.hasOwn(actual, 'officialPosting'), false, `${row.company} must carry no officialPosting`);
      }
      assert.ok(!telemetry.search.officialPosting?.total, 'search records no official posting lookups');
    },
  },
  {
    name: 'Official posting resilience: Board refresh resolves both healthy rows around an invalid scraped employer',
    async run() {
      const rows = [job({ url: 'https://careers.northwind.example/jobs/one' }), job({ company: 'Tech <3 Labs' }),
        job({ company: 'Cedar Works', url: 'https://careers.cedar.example/jobs/two' })];
      const { callRaw, callMatch, offline } = healthyResolverFixture(rows.filter(row => row.company !== 'Tech <3 Labs'));
      const entries = rows.map((row, index) => ({ cardId: `resilience-card-${index}`, job: row }));
      const before = JSON.stringify(entries);
      const { entries: refreshed } = await withStore(store => refreshOfficialPostingEntries(
        { nodeId: 'resilience-board', manualAiRunId: 'resilience-run', entries },
        { store, snapshotFetch: offline, callRaw, callMatch }));
      assert.equal(JSON.stringify(entries), before, 'refresh must not mutate its input');
      assert.deepEqual(refreshed.map(entry => entry.cardId), entries.map(entry => entry.cardId));
      refreshed.forEach((entry, index) => {
        const row = rows[index]; assert.ok(normalizeOfficialPosting(entry.officialPosting), row.company);
        if (row.company === 'Tech <3 Labs') assert.ok(['L5', 'L6'].includes(entry.officialPosting.level));
        else assert.ok(['L1', 'L2', 'L3', 'L4'].includes(entry.officialPosting.level), `${row.company}: ${entry.officialPosting.level}`);
      });
    },
  },
  {
    name: 'Official posting resilience: a resolver failure during Board refresh rejects without mutating rows, and search never reaches it',
    async run() {
      const rows = [job(), job({ company: 'Cedar Works', url: 'https://board.example/two' })];
      const { result, telemetry, resolverCalls } = await search(rows);
      assert.equal(result.success, true, result.error); assert.equal(result.jobs.length, rows.length);
      assert.deepEqual(result.jobs.map(row => row.company).sort(), rows.map(row => row.company).sort());
      assert.deepEqual(resolverCalls, []);
      assert.ok(!telemetry.search.officialPosting?.failed, 'search records no failed official lookups');
      const entries = rows.map((row, index) => ({ cardId: `failure-card-${index}`, job: row }));
      const before = JSON.stringify(entries);
      await withStore(async store => {
        await assert.rejects(refreshOfficialPostingEntries({ nodeId: 'resilience-board', manualAiRunId: 'resilience-run', entries },
          { store, resolve: async () => { throw new Error('Synthetic resolver failure.'); } }), /Synthetic resolver failure/u);
      });
      assert.equal(JSON.stringify(entries), before);
      // The real resolver contains a storage fault: the row is returned as a failed lookup and counted.
      const { callRaw, callMatch, offline } = healthyResolverFixture([rows[0]]);
      const faulty = { async find() { return null; }, async save() { throw new Error('Synthetic storage failure.'); },
        async readText() { return null; } };
      const { entries: refreshed, telemetry: lookupTelemetry } = await refreshOfficialPostingEntries(
        { nodeId: 'resilience-board', manualAiRunId: 'resilience-run', entries: [entries[0]] },
        { store: faulty, snapshotFetch: offline, callRaw, callMatch });
      assert.equal(refreshed.length, 1); assert.ok(normalizeOfficialPosting(refreshed[0].officialPosting));
      assert.equal(lookupTelemetry.failed, 1);
    },
  },
  {
    name: 'R3 Board refresh reuses matching verified and fresh miss records and researches only new or unbound rows; search carries rows untouched',
    async run() {
      const rows = [job({ url: 'https://board.example/cache-one' }),
        job({ title: 'Systems Engineer', url: 'https://board.example/cache-two' }),
        job({ title: 'Release Engineer', url: 'https://board.example/new-three' }),
        job({ company: 'Cedar Works', url: 'https://board.example/unbound-four' })];
      const prepareStore = async store => {
        const verifiedSource = { employer: rows[0].company, title: rows[0].title,
          sourceUrl: 'https://careers.northwind.example/jobs/cache-one', description: DESCRIPTION };
        const verified = await store.save(rows[0], { officialPosting: { level: 'L1', outcome: 'found',
          employer: verifiedSource.employer, title: verifiedSource.title, sourceUrl: verifiedSource.sourceUrl,
          semanticMatch: { version: 1, inputHash: officialPostingSemanticInputHash(rows[0]),
            sourceHash: officialPostingSemanticSourceHash(verifiedSource) },
          trail: ['comparative-match', 'semantic-match-v1'] }, description: DESCRIPTION });
        rows[0].officialPosting = verified.officialPosting;
        const miss = await store.save(rows[1], { officialPosting: { ...unresolvedOfficialPosting(rows[1]).officialPosting,
          semanticMatch: { version: 1, inputHash: officialPostingSemanticInputHash(rows[1]) },
          trail: [OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL, 'bridge-research', 'comparative-none', 'semantic-match-v1'] } });
        rows[1].officialPosting = miss.officialPosting;
        rows[3].officialPosting = structuredClone(verified.officialPosting);
      };
      // Search: zero research, every row (including older ones holding a record) comes through with its own view.
      const { result, telemetry, resolverCalls, progress } = await search(rows, { prepareStore });
      assert.equal(result.success, true, result.error);
      assert.equal(result.jobs.length, 4);
      assert.deepEqual(resolverCalls, []);
      assert.equal(progress.some(item => /Finding official postings/u.test(item.detail || '')), false);
      assert.ok(!telemetry.search.officialPosting?.total, 'search records no official posting lookups');
      for (const original of rows) {
        const found = result.jobs.find(row => row.url === original.url);
        assert.ok(found);
        for (const field of ['title', 'company', 'snippet', 'url']) assert.equal(found[field], original[field]);
      }
      assert.equal(result.jobs.find(row => row.url === rows[0].url).officialPosting?.level, 'L1', 'an older verified row keeps its view');
      assert.equal(Object.hasOwn(result.jobs.find(row => row.url === rows[2].url), 'officialPosting'), false, 'a new row is not researched');
      // Board refresh without force: the saved verified and fresh miss records settle without a chat; the rest are researched.
      await withStore(async store => {
        await prepareStore(store);
        const { callRaw, callMatch, offline } = healthyResolverFixture([]);
        const researched = [];
        const spyRaw = (prompt, options) => {
          researched.push(...prompt.match(/Requested ids: ([a-f0-9, ]+)\./u)[1].split(', '));
          return callRaw(prompt, options);
        };
        const { entries } = await refreshOfficialPostingEntries({ nodeId: 'resilience-board', manualAiRunId: 'resilience-run', force: false,
          entries: rows.map((row, index) => ({ cardId: `cache-card-${index}`, job: row })) },
        { store, snapshotFetch: offline, callRaw: spyRaw, callMatch });
        assert.equal(entries.length, 4);
        assert.deepEqual([...new Set(researched)].sort(), [officialPostingRequestId(rows[2]), officialPostingRequestId(rows[3])].sort());
        assert.equal(entries[0].officialPosting.level, 'L1');
        assert.ok(entries[0].officialPosting.trail.includes('cache-hit'));
        assert.ok(entries[1].officialPosting.trail.includes('recent-miss'));
      });
    },
  },
];
