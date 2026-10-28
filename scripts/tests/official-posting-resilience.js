import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ipcMain } from 'electron';
import { normalizeOfficialPosting } from '../../electron/ipc/officialPostingFields.js';
import { unresolvedOfficialPosting, officialPostingRequestId } from '../../electron/ipc/officialPostingResolver.js';
import { resolveOfficialPostings } from '../../electron/ipc/officialPostingService.js';
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
const notFound = (prompt, options) => {
  const ids = prompt.match(/Requested ids: ([a-f0-9, ]+)\./u)[1].split(', ');
  const answer = ids.map(id => `BEGIN OFFICIAL POSTING RESEARCH ${id}\nNOT FOUND\nEND OFFICIAL POSTING RESEARCH ${id}`).join('\n');
  options.responseValidator(answer);
  return answer;
};
const noNetwork = async () => { throw new Error('Unexpected network request.'); };
const confirmSemanticMatch = (_prompt, options) => {
  const answer = { choice: 'P1', evidence: [{ scrapedQuote: DESCRIPTION, officialQuote: DESCRIPTION }],
    distinguishing: [], conflicts: [] };
  options.responseValidator(answer);
  return JSON.stringify(answer);
};

async function withStore(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'official-resilience-'));
  try { return await run(createOfficialPostingStore(path.join(root, 'official-postings')), root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function search(rows, resolve, { prepareStore } = {}) {
  return withStore(async (store, root) => {
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
      resolveOfficialPostings: (jobs, options) => resolve(jobs, { ...options, store }),
    });
    try {
      const sender = { id: 72991, isDestroyed: () => false, once() {}, on() {}, removeListener() {}, send() {} };
      const result = await ipcMain.__getInvokeHandler('search-jobs')({ sender }, {
        queries: ['software engineer'], nodeId, canvasFilePath, careerSnapshotId, operationAuthority: authority.receipt,
        enabledSourceIds: ['remoteok'], targetRole: '', preferredLocation: '',
      });
      return { result, telemetry: structuredClone(getJobsTelemetry()) };
    } finally { registerJobsHandlers(); }
  });
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
    name: 'Official posting resilience: one invalid dependency result is counted and cannot poison neighboring rows',
    async run() {
      await withStore(async store => {
        const rows = [job({ company: 'Tech <3 Labs' }), job({ company: 'Cedar\u0001Works' }), job({ company: 'Cedar Works' })];
        const result = await resolveOfficialPostings(rows, { store, fetch: noNetwork, callRaw: notFound,
          resolve: async row => row.company === 'Cedar Works' ? unresolvedOfficialPosting(row) : { officialPosting: null } });
        assert.equal(result.jobs.length, rows.length);
        assert.ok(result.jobs.every(row => normalizeOfficialPosting(row.officialPosting)));
        assert.ok(result.telemetry.failed >= 2);
        rows.forEach((row, index) => assert.equal(result.jobs[index].company, row.company));
      });
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
    name: 'Official posting resilience: real search resolves both healthy rows around an invalid scraped employer',
    async run() {
      const rows = [job({ url: 'https://careers.northwind.example/jobs/one' }), job({ company: 'Tech <3 Labs' }),
        job({ company: 'Cedar Works', url: 'https://careers.cedar.example/jobs/two' })];
      const byHost = new Map(rows.filter(row => row.company !== 'Tech <3 Labs').map(row => [new URL(row.url).host, row]));
      const fetch = async url => {
        const row = byHost.get(new URL(url).host); assert.ok(row, 'only legitimate synthetic leads are fetched');
        return { url, statusCode: 200, contentType: 'text/html', body: new URL(url).pathname === '/'
          ? `<title>${row.company}</title>`
          : `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: row.title,
            hiringOrganization: { name: row.company }, description: DESCRIPTION,
            jobLocation: { address: { addressLocality: 'Lakeview', addressRegion: 'Ontario', addressCountry: 'Canada' } } })}</script>` };
      };
      const { result } = await search(rows, (jobs, options) => resolveOfficialPostings(jobs, {
        ...options, fetch, callRaw: notFound, callMatch: confirmSemanticMatch,
      }));
      assert.equal(result.success, true, result.error); assert.equal(result.jobs.length, 3);
      const byId = new Map(result.jobs.map(row => [officialPostingRequestId(row), row]));
      for (const row of rows) {
        const actual = byId.get(officialPostingRequestId(row)); assert.ok(actual);
        assert.equal(actual.company, row.company); assert.equal(actual.snippet, row.snippet);
        assert.equal(actual.officialPosting.level, row.company === 'Tech <3 Labs' ? 'L5' : 'L1');
      }
    },
  },
  {
    name: 'Official posting resilience: unexpected batch failure leaves real search rows intact and records failed telemetry',
    async run() {
      const rows = [job(), job({ company: 'Cedar Works', url: 'https://board.example/two' })];
      const { result, telemetry } = await search(rows, async () => { throw new Error('Synthetic resolver failure.'); });
      assert.equal(result.success, true, result.error); assert.equal(result.jobs.length, rows.length);
      assert.deepEqual(result.jobs.map(row => row.company).sort(), rows.map(row => row.company).sort());
      assert.equal(telemetry.search.officialPosting.failed, rows.length);
    },
  },
  {
    name: 'R3 real search carries matching verified and fresh miss records and resolves only new or unbound rows',
    async run() {
      const rows = [job({ url: 'https://board.example/cache-one' }),
        job({ title: 'Systems Engineer', url: 'https://board.example/cache-two' }),
        job({ title: 'Release Engineer', url: 'https://board.example/new-three' }),
        job({ company: 'Cedar Works', url: 'https://board.example/unbound-four' })];
      const calls = [];
      const { result, telemetry } = await search(rows, async jobs => {
        calls.push(jobs.map(row => row.url));
        return { jobs: jobs.map(row => ({ ...row, ...unresolvedOfficialPosting(row) })),
          telemetry: { total: jobs.length, levels: { L5: jobs.length }, outcomes: { 'not-found': jobs.length } } };
      }, { prepareStore: async store => {
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
          trail: ['bridge-research', 'comparative-none', 'semantic-match-v1'] } });
        rows[1].officialPosting = miss.officialPosting;
        rows[3].officialPosting = structuredClone(verified.officialPosting);
      } });
      assert.equal(result.success, true, result.error);
      assert.equal(result.jobs.length, 4);
      assert.deepEqual(calls, [[rows[2].url, rows[3].url]]);
      assert.equal(telemetry.search.officialPosting.total, 4);
      assert.equal(telemetry.search.officialPosting.levels.L1, 1);
      for (const original of rows) {
        const found = result.jobs.find(row => row.url === original.url);
        assert.ok(found);
        for (const field of ['title', 'company', 'snippet', 'url']) assert.equal(found[field], original[field]);
      }
    },
  },
];
