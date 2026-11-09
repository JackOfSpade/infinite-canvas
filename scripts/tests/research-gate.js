// The research gate: nothing researches a job before it has a fit score, and
// only a job at or above RESEARCH_MIN_FIT_SCORE is researched afterwards.
// Search paths settle scraped rows without any official lookup, liveness AI or
// dedup; the Board's research stage and its host handler do all of that for
// eligible rows only. Synthetic fixtures only (Northwind Labs and friends).
//
// Every test below must fail if a below-threshold or unscored job starts
// research: a search path that stamps an officialPosting, a liveness probe or
// score call for an ineligible row, a company-research prompt that names one.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { ipcMain } from 'electron';
import { getJobsBoardTelemetryForReport } from '../../electron/ipc/jobs.js';
import {
  __registerJobsHandlersForTests, filterJobsByDescriptionEvidence, getJobsTelemetry, registerJobsHandlers,
  UNSCORED_FALLBACK_SCORE,
} from '../../electron/ipc/jobs.js';
import { abortNodeTasks, __runWithIpcRequestContextForTests } from '../../electron/ipc/ipcUtils.js';
import { registerNonApiAiHandlers } from '../../electron/ipc/nonApiAi.js';
import { claimJobAnalysisOperationAuthority } from '../../electron/ipc/jobAnalysisOperationAuthorityStore.js';
import { writeApprovedCareerSnapshotFixture } from './careerSnapshotFixture.mjs';
import {
  classifyResearchEligibility, isResearchEligible, researchSkipReason, summarizeResearchEligibility,
  RESEARCH_ELIGIBILITY, RESEARCH_MIN_FIT_SCORE,
} from '../../electron/ipc/researchGate.js';
import { UNSCORED_SCORE_STATUS } from '../../electron/ipc/jobBatchReconcile.js';
import { filterNonEnglishJobs } from '../../src/utils/jobLanguage.js';
import { scoreSafeRowsWithBoardClosed } from '../../electron/ipc/officialPostingBoardClosed.js';
import { createOfficialPostingRecoveryPassResolver } from '../../electron/ipc/officialPostingService.js';
import { COMPANY_RESEARCH_VERSION, evaluateJobPreferences, researchDeferredJobPreferences } from '../../electron/ipc/jobPreferences.js';
import { runBoundedJobTaxonomy } from '../../electron/ipc/jobTaxonomy.js';
import { confirmSimilarJobLocationPairs } from '../../electron/ipc/jobLocationConsolidation.js';
import { findSimilarLocationCandidates } from '../../src/utils/jobLocationConsolidation.js';
import { refreshOfficialPostingEntries } from '../../electron/ipc/officialPostingRefresh.js';
import { normalizeOfficialPosting } from '../../electron/ipc/officialPostingFields.js';
import { officialPostingDisplay } from '../../src/utils/officialPostingDisplay.js';
import { collectOfficialPostingReport } from '../../src/utils/officialPostingReport.js';
import { projectOfficialPostingGenerationJob } from '../../src/utils/officialPostingPreparation.js';
import { carryBoardRescores, runBoardResearchStage } from '../../src/nodes/jobboard/jobBoardResearchStage.js';

const AT = '2026-10-25T12:00:00.000Z';
const PIN = 'b'.repeat(64);
const readSource = relative => fs.readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
const between = (source, start, end) => {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing source marker ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `missing source marker ${end}`);
  return source.slice(from, to);
};
const description = seed => `${seed} Responsibilities include building reliable services, reviewing incidents and mentoring peers. `.repeat(8);
const rawRow = (title, extra = {}) => ({ source: 'remoteok', title, company: 'Northwind Labs', location: 'Remote', salary: '',
  posted: 'today', url: `https://remoteok.com/remote-jobs/${title.toLowerCase().replaceAll(' ', '-')}`, snippet: description(title), ...extra });
const liveness = (verdict, basis = 'closed-marker', board = 'remoteok') => ({ verdict, basis, board, at: AT });
const boardClosed = (board = 'remoteok') => ({ board, reason: 'detail-page-not-found', at: AT });

// What each kind of fit score looks like on a row. `unscoredHigh` is a row whose
// numeric matchScore would pass a plain comparison; only its scoreStatus says it
// was never scored.
const FIT_KINDS = Object.freeze({
  atThreshold: { matchScore: RESEARCH_MIN_FIT_SCORE },
  belowThreshold: { matchScore: RESEARCH_MIN_FIT_SCORE - 1 },
  unscored: { matchScore: UNSCORED_FALLBACK_SCORE, scoreStatus: UNSCORED_SCORE_STATUS },
  unscoredHigh: { matchScore: RESEARCH_MIN_FIT_SCORE + 20, scoreStatus: UNSCORED_SCORE_STATUS },
});
const KIND_NAMES = Object.keys(FIT_KINDS);
const INELIGIBLE_KINDS = KIND_NAMES.filter(kind => kind !== 'atThreshold');

const hex = seed => crypto.createHash('sha256').update(seed).digest('hex');
// A saved official posting that the host holds a rescore reason for.
const foundPosting = (key, trail = []) => ({ level: 'L2', outcome: 'found', employer: 'Northwind Labs', title: 'Platform Engineer',
  sourceUrl: `https://careers.northwind.example.test/jobs/${key}`, officialApplyUrl: `https://careers.northwind.example.test/jobs/${key}/apply`,
  ats: 'ashby', tenant: 'northwind-synthetic', fetchedAt: AT, contentHash: hex(key),
  trail: ['careers-page', 'semantic-match-v1', ...trail],
  semanticMatch: { version: 1, inputHash: 'a'.repeat(64), sourceHash: 'b'.repeat(64) } });
const retryablePosting = () => ({ level: 'L5', outcome: 'not-found', employer: 'Northwind Labs', trail: ['worker-unavailable'] });
const pendingCompanyMatch = () => ({ preferenceId: 'lunch', criterion: 'Free lunch', category: 'perk', strict: true,
  outcome: 'unverified', evidence: 'Not listed.' });
const pendingCompanyAssessment = () => ({ status: 'accepted', companyResearchPending: true, matches: [pendingCompanyMatch()],
  confirmedSoftPreferences: 0, conflictingSoftPreferences: 0, preferenceScore: 0, summary: '', evaluatedAt: AT });

const sender = (id, sent = null) => ({ id, isDestroyed: () => false, once() {}, on() {}, removeListener() {},
  send(channel, payload) { sent?.push({ channel, payload }); } });

async function withSearchHarness(run) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'research-gate-'));
  const canvasFilePath = path.join(directory, 'canvas.json');
  try {
    await fs.promises.writeFile(canvasFilePath, '{}');
    const { snapshotId: careerSnapshotId } = await writeApprovedCareerSnapshotFixture();
    await run({ directory, canvasFilePath, careerSnapshotId });
  } finally {
    registerJobsHandlers();
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

// Every counter a search path must leave at zero. The real resolver always
// stamps an officialPosting, so a row that keeps none never reached it either.
function spendTraps() {
  const spent = { research: 0, liveness: 0, probes: 0, views: 0, progress: [] };
  return {
    spent,
    dependencies: {
      resolveOfficialPostings: async jobs => { spent.research += 1; return { jobs: jobs.map(job => ({ ...job, officialPosting: retryablePosting() })) }; },
      callListingLiveness: async () => { spent.liveness += 1; throw new Error('a search path must not call the listing-liveness AI'); },
      createListingLivenessProbe: () => ({ probe: async () => { spent.probes += 1; return { unknown: 'research-gate-trap' }; } }),
      getOfficialPostingView: async row => { spent.views += 1; return { description: '', officialPosting: row.officialPosting }; },
    },
  };
}

function assertNothingResearched(spent, jobs, { progress = spent.progress, held = new Map() } = {}) {
  assert.equal(spent.research, 0, 'no official-posting lookup');
  assert.equal(spent.liveness, 0, 'no listing-liveness AI');
  assert.equal(spent.probes, 0, 'no listing page was probed');
  assert.ok(Array.isArray(jobs) && jobs.length > 0, 'the path returned rows to check');
  for (const job of jobs) {
    if (held.has(job.title)) assert.deepEqual(job.officialPosting, held.get(job.title), `${job.title} keeps the lookup it already held, unchanged`);
    else assert.equal(Object.hasOwn(job, 'officialPosting'), false, `a scraped row carries no officialPosting (${job.title})`);
  }
  assert.equal(progress.some(item => /Finding official postings|official-posting/u.test(JSON.stringify(item.payload ?? item))), false,
    'no official-posting progress is reported');
  const telemetry = getJobsTelemetry().search?.officialPosting;
  assert.equal(telemetry?.total ?? 0, 0, 'no official lookups are counted');
  assert.equal(telemetry?.handoffs ?? 0, 0, 'no research handoff was issued');
}

async function runSearchJobs({ canvasFilePath, careerSnapshotId, nodeId, rows, traps, extraDependencies = {} }) {
  const authority = await claimJobAnalysisOperationAuthority({ canvasFilePath, hubId: nodeId, operationId: `op-${nodeId}`,
    semanticBase: { kind: 'search', careerSnapshotId, runId: null, fingerprint: `synthetic-${nodeId}`,
      analysisRevisionId: null, continuationId: null, sourceArtifactFingerprint: null } });
  assert.equal(authority.admitted, true);
  const bySource = new Map();
  for (const row of rows) bySource.set(row.source, [...(bySource.get(row.source) || []), row]);
  __registerJobsHandlersForTests({
    resolveRequiredPinnedCareerInput: async () => ({ profile: {}, careerData: '', pinned: true }),
    fetchHttpSources: async (...args) => {
      const results = [];
      for (const [sourceId, jobs] of bySource) {
        await args[10](sourceId);
        const result = { sourceId, jobs, gathered: jobs.length };
        await args[11](sourceId, result);
        await args[8]({ sourceId, query: 'platform engineer', page: 1, jobs });
        results.push(result);
      }
      return results;
    },
    ...traps.dependencies, ...extraDependencies,
  });
  const client = sender(71960, traps.spent.progress);
  const result = await ipcMain.__getInvokeHandler('search-jobs')({ sender: client }, {
    queries: ['platform engineer'], nodeId, canvasFilePath, careerSnapshotId, operationAuthority: authority.receipt,
    enabledSourceIds: [...bySource.keys()], targetRole: '', preferredLocation: '',
  });
  return { result, authority, sender: client };
}

// Rows a provider could hand a search: open, undecided, closed with and without
// text, and (from an older run) rows that already carry a score of every kind.
function searchRows() {
  return [
    rawRow('Open Engineer'),
    rawRow('Pending Engineer', { listingLiveness: liveness('pending') }),
    rawRow('Closed Described Engineer', { boardClosed: boardClosed(), listingLiveness: liveness('closed', 'structural') }),
    rawRow('Closed Blank Engineer', { snippet: '', boardClosed: boardClosed(), listingLiveness: liveness('closed', 'structural') }),
    ...KIND_NAMES.map(kind => rawRow(`Scored ${kind} Engineer`, FIT_KINDS[kind])),
  ];
}

const usaJobsResponse = items => new Response(JSON.stringify({ SearchResult: { SearchResultCountAll: items.length,
  SearchResultItems: items.map((title, index) => ({ MatchedObjectId: `synthetic-${index}`, MatchedObjectDescriptor: {
    PositionID: `synthetic-${index}`, PositionTitle: title, OrganizationName: 'Northwind Agency', PositionLocationDisplay: 'Remote',
    PositionURI: `https://www.usajobs.gov/job/synthetic-${index}`, PublicationStartDate: new Date().toISOString(),
    QualificationSummary: description(title), UserArea: { Details: { MajorDuties: [description(`${title} duties`)], Requirements: description(`${title} requirements`) } } } })) } }),
{ status: 200, headers: { 'content-type': 'application/json' } });

// The text a LinkedIn Solve or generic Solve source slice sees: any identifier
// it does not receive throws, and every research function is a recorded trap.
function researchTrapContext(extra = {}) {
  const calls = [];
  const trap = name => (...args) => { calls.push({ name, args }); throw new Error(`${name} must not run while settling scraped rows`); };
  const traps = Object.fromEntries(['resolveOfficialPostings', 'refreshOfficialPostingEntries', 'recheckPendingListings', 'officialPostingDedup',
    'createListingLivenessSearchSession', 'researchDeferredJobPreferences', 'callListingLiveness', 'rescoreMaterialOfficialText']
    .map(name => [name, trap(name)]));
  return { calls, context: { ...traps, ...extra } };
}
const RESEARCH_IDENTIFIERS = /resolveOfficialPostings|refreshOfficialPostingEntries|recheckPendingListings|officialPostingDedup\(|createListingLivenessSearchSession|researchDeferredJobPreferences|callListingLiveness|rescoreMaterialOfficialText|Finding official postings/u;

async function waitFor(predicate, label, timeoutMs = 10_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const PREFERENCE_PLAN = Object.freeze({ version: 1, summary: '',
  direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false },
  softPreferences: [], strictRequirements: [{ id: 'lunch', criterion: 'Free lunch', category: 'perk' }], warnings: [], titles: [] });

export default [
  // ── 1-6: every search path settles rows without research ─────────────────
  {
    name: 'research gate [1 search-jobs]: scraped rows of every kind come back with no officialPosting, no lookup, no liveness AI and no handoff',
    async run() {
      await withSearchHarness(async ({ canvasFilePath, careerSnapshotId }) => {
        const traps = spendTraps();
        const rows = searchRows();
        const { result } = await runSearchJobs({ canvasFilePath, careerSnapshotId, nodeId: 'research-gate-search-hub', rows, traps });
        assert.equal(result.success, true, result.error);
        assertNothingResearched(traps.spent, result.jobs);
        const titles = result.jobs.map(job => job.title);
        for (const title of ['Open Engineer', 'Pending Engineer', 'Closed Described Engineer']) assert.ok(titles.includes(title), `${title} is kept`);
        assert.equal(titles.includes('Closed Blank Engineer'), false, 'a confirmed-closed row with no description retires: nothing can score or research it');
        for (const kind of KIND_NAMES) assert.ok(titles.includes(`Scored ${kind} Engineer`), `a row carrying a ${kind} score is not researched either`);
      });
    },
  },
  {
    name: 'research gate [2 search-jobs-single-source]: a late USAJobs refresh settles rows without research',
    async run() {
      await withSearchHarness(async ({ canvasFilePath }) => {
        const traps = spendTraps();
        __registerJobsHandlersForTests(traps.dependencies);
        const nativeFetch = globalThis.fetch;
        const savedEnv = { key: process.env.USAJOBS_API_KEY, email: process.env.USAJOBS_EMAIL };
        const requested = [];
        process.env.USAJOBS_API_KEY = 'synthetic-research-gate-key';
        process.env.USAJOBS_EMAIL = 'synthetic@example.test';
        globalThis.fetch = async input => {
          requested.push(String(input?.url || input));
          assert.match(String(input?.url || input), /^https:\/\/data\.usajobs\.gov\//u, 'only the provider is contacted');
          return usaJobsResponse(['Federal Analyst One', 'Federal Analyst Two']);
        };
        try {
          const client = sender(71961, traps.spent.progress);
          const reply = await ipcMain.__getInvokeHandler('search-jobs-single-source')({ sender: client }, {
            query: 'analyst', sourceId: 'usajobs', canvasFilePath, nodeId: 'research-gate-single-hub',
            enabledSourceIds: ['usajobs'], preferredLocation: 'Austin, Texas, United States', maxAgeDays: 30,
          });
          assert.equal(reply.success, true, reply.error);
          assert.ok(requested.length >= 1, 'the provider fetch ran');
          assert.equal(reply.jobs.length, 2, JSON.stringify(reply.warning || reply));
          assertNothingResearched(traps.spent, reply.jobs);
          assert.equal(reply.officialPosting?.total ?? 0, 0, 'the reply reports no official lookups');
          assert.equal(reply.officialPosting?.handoffs ?? 0, 0, 'the reply reports no research handoff');
          assert.equal(reply.officialDedupDropped ?? 0, 0, 'no official dedup ran');
        } finally {
          globalThis.fetch = nativeFetch;
          for (const [name, value] of [['USAJOBS_API_KEY', savedEnv.key], ['USAJOBS_EMAIL', savedEnv.email]]) {
            if (value === undefined) delete process.env[name]; else process.env[name] = value;
          }
        }
      });
    },
  },
  {
    name: 'research gate [3 resolve-job-source generic Solve]: the real generic recovery glue settles through the scrape settler only',
    async run() {
      const source = readSource('electron/ipc/jobs.js');
      const generic = between(source, 'const runGenericResolve = async () =>', "checkpointContinuationBeforeReply('resolve-job-source')");
      assert.doesNotMatch(generic, RESEARCH_IDENTIFIERS, 'the generic Solve branch names no research function');
      const init = source.indexOf('const resolveGenericPostings =', source.indexOf('const runGenericResolve = async () =>'));
      const persist = source.indexOf('const persistSourceRecoveryJobs = async', init);
      const publish = source.indexOf('const officialResolution = await resolveGenericPostings(', persist);
      const languageFilter = source.indexOf('const languageFilter = filterNonEnglishJobs(items);', publish);
      assert.ok(init > 0 && persist > init && publish > persist && languageFilter > publish, 'the generic glue markers are present');
      const settleCalls = []; const checkpoints = [];
      const { calls, context } = researchTrapContext({
        createOfficialPostingRecoveryPassResolver,
        settleScrapedRowsForScoring: async (rows, options) => { settleCalls.push({ rows, options }); return { jobs: rows, officialPosting: null }; },
        sourceRecoverySnapshot: { jobs: [], descriptionRecoveryJobs: [], profile: {}, careerData: '', careerSnapshotId: 'synthetic-career', nodeId: 'board' },
        sourceRecoveryJobs: [], sourceRecoveryCheckpointOwned: true, recoveryCheckpointOutcome: 'unchanged', sourceId: 'remoteok',
        snapshotDescriptionRecoveryJobs: snapshot => snapshot.descriptionRecoveryJobs,
        mergeDescriptionRecoverySourceJobs: (_previous, _source, rows) => rows,
        filterJobsByDescriptionEvidence, filterNonEnglishJobs, scoreSafeRowsWithBoardClosed,
        overlayResolvedRecoveryRows: rows => rows,
        buildJobAnalysisSnapshot: args => ({ snapshot: args }),
        saveDescriptionRecoverySnapshotIfCurrent: async snapshot => { await Promise.resolve(); checkpoints.push(snapshot); return { saved: true }; },
        requireDescriptionRecoveryCheckpointPersisted: receipt => receipt,
        event: { sender: {} }, nodeId: 'board', signal: new AbortController().signal, jobRunId: 'run', canvasFilePath: '/synthetic/canvas.json',
        continuationAdmission: { continuation: false }, operationAuthority: {}, logger: { warn() {}, info() {} },
      });
      vm.runInNewContext(`${source.slice(init, source.indexOf('// Load the recovery snapshot', init))}\n${source.slice(persist, source.indexOf('// The normal manual-scrape path', persist))}\nglobalThis.api = { persist: persistSourceRecoveryJobs, publish: async items => { const descriptionEvidence = { jobs: items }; ${source.slice(publish, languageFilter)} return officialResolution; } };`, context);
      const rows = searchRows().filter(row => row.title !== 'Closed Blank Engineer');
      await context.api.persist(rows);
      const published = await context.api.publish(rows);
      assert.deepEqual(calls, [], 'no research function ran');
      assert.ok(settleCalls.length >= 1, 'rows crossed the single scrape-time settler');
      for (const call of settleCalls) assert.deepEqual(Object.keys(call.options), ['signal'], 'the settler gets only the abort signal, never an event or a progress reporter');
      assert.ok(checkpoints.length >= 1, 'the score-safe checkpoint still saved');
      for (const job of [...published.jobs, ...checkpoints.flatMap(snapshot => snapshot.jobs)]) {
        assert.equal(job.officialPosting, undefined, `no row gained an officialPosting (${job.title})`);
      }
      for (const kind of KIND_NAMES) assert.ok(published.jobs.some(job => job.title === `Scored ${kind} Engineer`), `${kind} rows publish unresearched`);
    },
  },
  {
    name: 'research gate [4 resolve-job-source LinkedIn Solve]: the admitForScoring wiring settles through the scrape settler only',
    async run() {
      const source = readSource('electron/ipc/jobs.js');
      const linked = between(source, 'const isLinkedInReEnrich =', "// Use the source's ordinary list extractor");
      assert.doesNotMatch(linked, RESEARCH_IDENTIFIERS, 'the LinkedIn Solve branch names no research function');
      const admitStart = linked.indexOf('const admitForScoring =');
      const admitEnd = linked.indexOf('const persistRecoveryPool =', admitStart);
      assert.ok(admitStart > 0 && admitEnd > admitStart);
      const settleCalls = [];
      const { calls, context } = researchTrapContext({
        settleScrapedRowsForScoring: async (rows, options) => { settleCalls.push({ rows, options }); return { jobs: rows }; },
        scoreSafeRowsWithBoardClosed, filterJobsByDescriptionEvidence, overlayResolvedRecoveryRows: rows => rows, filterNonEnglishJobs,
        snapshotRecoveryJobs: [], logger: { info() {} }, nodeId: 'hub', signal: new AbortController().signal,
      });
      vm.runInNewContext(`${linked.slice(admitStart, admitEnd)}\nglobalThis.admit = admitForScoring;`, context);
      const rows = searchRows().filter(row => row.title !== 'Closed Blank Engineer').map(row => ({ ...row, source: 'linkedin' }));
      const admitted = await context.admit(rows);
      assert.deepEqual(calls, [], 'no research function ran');
      assert.equal(settleCalls.length, 1);
      assert.deepEqual(Object.keys(settleCalls[0].options), ['signal']);
      assert.ok(admitted.length >= rows.length - 1, 'rows are admitted for scoring');
      for (const job of admitted) assert.equal(Object.hasOwn(job, 'officialPosting'), false, `no row gained an officialPosting (${job.title})`);
    },
  },
  {
    name: 'research gate [5 resume-job-source retry-descriptions]: Indeed description retries settle rows without research',
    async run() {
      await withSearchHarness(async ({ canvasFilePath, careerSnapshotId }) => {
        const traps = spendTraps();
        const nodeId = 'research-gate-retry-hub';
        const seed = await runSearchJobs({ canvasFilePath, careerSnapshotId, nodeId, rows: [rawRow('Seed Engineer')], traps });
        assert.equal(seed.result.success, true, seed.result.error);
        assert.equal(seed.result.jobs.length, 1);
        const indeedRow = (title, key, extra = {}) => ({ source: 'indeed', title, company: `${title} Co`, location: 'Remote', posted: 'today',
          url: `https://www.indeed.com/viewjob?jk=${key}`, jobkey: key, snippet: description(title), ...extra });
        const recovered = [indeedRow('Retry Open Engineer', 'open1'),
          indeedRow('Retry Pending Engineer', 'pend1', { listingLiveness: liveness('pending', 'closed-marker', 'indeed') }),
          indeedRow('Retry Closed Engineer', 'closed1', { boardClosed: boardClosed('indeed'), listingLiveness: liveness('closed', 'structural', 'indeed') }),
          ...KIND_NAMES.map(kind => indeedRow(`Retry ${kind} Engineer`, kind, FIT_KINDS[kind])),
          // Two older rows holding the same official posting: no official dedup runs on a search path, so both stay.
          indeedRow('Retry Older Copy A', 'olda', { officialPosting: foundPosting('retry-shared') }),
          indeedRow('Retry Older Copy B', 'oldb', { officialPosting: foundPosting('retry-shared') })];
        let retried = 0;
        __registerJobsHandlersForTests({
          ...traps.dependencies,
          retryIndeedJobDescriptions: async jobs => { retried += 1; return { jobs: recovered, attempted: jobs.length, recovered: recovered.length, remaining: 0 }; },
        });
        const reply = await ipcMain.__getInvokeHandler('resume-job-source')({ sender: seed.sender }, {
          sourceId: 'indeed', nodeId, jobRunId: seed.result.runId, canvasFilePath, enabledSourceIds: ['indeed'],
          careerSnapshotId, operationAuthority: seed.authority.receipt,
          resumeState: { mode: 'retry-descriptions', jobs: recovered.map(job => ({ ...job, snippet: '' })) },
        });
        assert.equal(retried, 1);
        assert.equal(reply.resolved, true, JSON.stringify(reply));
        assert.equal(reply.items.length, recovered.length, 'every recovered row is kept: nothing is dropped for want of research');
        assertNothingResearched(traps.spent, reply.items, { held: new Map([['Retry Older Copy A', foundPosting('retry-shared')], ['Retry Older Copy B', foundPosting('retry-shared')]]) });
      });
    },
  },
  {
    name: 'research gate [6 resume-job-source native resume]: the Indeed resume slice settles scraped rows without research',
    async run() {
      const source = readSource('electron/ipc/jobs.js');
      const handler = between(source, "handleSafe('resume-job-source',", "checkpointContinuationBeforeReply('resume-job-source')");
      assert.doesNotMatch(handler, RESEARCH_IDENTIFIERS, 'the whole resume handler names no research function');
      const slice = between(handler, 'const result = await withSharedProfileLock(() => fetchIndeedListingsBrowser(', 'const enrichment = {');
      const settleCalls = [];
      const { calls, context } = researchTrapContext({
        withSharedProfileLock: run => run(),
        fetchIndeedListingsBrowser: async () => ({ items: searchRows().filter(row => row.title !== 'Closed Blank Engineer').map(row => ({ ...row, source: 'indeed' })) }),
        syncIndeedSessionStatusFromScrape: async () => {},
        filterProvablyOutsideCountryScope: items => ({ jobs: items, dropped: 0 }),
        filterJobsByPostedSince: items => items,
        loadJobsHistory: async () => ({}), dedupAgainstHistory: items => ({ kept: items, removed: 0, samples: [] }),
        loadAppliedListingKeys: async () => new Set(), filterAppliedListings: items => ({ kept: items, removed: 0, samples: [] }),
        repairJobsMojibake: () => {}, normalizeJobsMarkup: () => {},
        filterJobsByDescriptionEvidence, scoreSafeRowsWithBoardClosed, filterNonEnglishJobs, sourceHealthWarningForRows: () => null,
        settleScrapedRowsForScoring: async (rows, options) => { settleCalls.push({ rows, options }); return { jobs: rows }; },
        remainingQueries: ['platform engineer'], resumeStartPages: [0], resumePageBudgets: null, resumeQueryIndexes: [0],
        ageDays: 30, location: '', normalizedCollectionLimits: { jobsPerPlatform: null }, activeSearchWindow: { startTimestamp: 0 },
        canvasFilePath: '/synthetic/canvas.json', nodeId: 'hub', jobRunId: 'run', sourceId: 'indeed', signal: new AbortController().signal,
        logger: { info() {} },
      });
      const resumed = await vm.runInNewContext(`(async () => { ${slice}\nreturn items; })()`, context);
      assert.deepEqual(calls, [], 'no research function ran');
      assert.equal(settleCalls.length, 1);
      assert.deepEqual(Object.keys(settleCalls[0].options), ['signal']);
      assert.ok(resumed.length > 0);
      for (const job of resumed) assert.equal(Object.hasOwn(job, 'officialPosting'), false, `no row gained an officialPosting (${job.title})`);
    },
  },
  {
    name: 'research gate: every research call in jobs.js lives inside settle-board-research, and no search path reads the lookup dependency',
    run() {
      const source = readSource('electron/ipc/jobs.js');
      const research = between(source, "handleSafe('settle-board-research',", "handleSafe('confirm-job-location-consolidations',");
      const outside = source.replace(research, '');
      // Imports and the helper definition are the only other mentions.
      const calls = outside.split('\n').filter(line => !/^\s*(import |\/\/|\*)/u.test(line)
        && /\b(recheckPendingListings|officialPostingDedup|researchDeferredJobPreferences|createListingLivenessSearchSession|resolveOfficialPostings|refreshOfficialPostingEntries)\s*\(/u.test(line));
      assert.deepEqual(calls, [], 'no research function is called outside the Board research handler');
      assert.equal([...outside.matchAll(/rescoreMaterialOfficialText\(/gu)].length, 1, 'the rescore helper is defined once and called only inside the handler');
      assert.doesNotMatch(source, /resolveScoreSafePostings|dependencies\.resolveOfficialPostings|Finding official postings/u);
      for (const [start, end] of [["handleSafe('search-jobs',", "handleSafe('peek-job-run',"], ["handleSafe('score-jobs',", "handleSafe('settle-board-research',"]]) {
        assert.doesNotMatch(between(source, start, end), RESEARCH_IDENTIFIERS, `${start} names no research function`);
      }
    },
  },
  // ── 7: score-jobs ────────────────────────────────────────────────────────
  {
    name: 'research gate [7 score-jobs]: an older row with a retryable lookup and a pending listing is scored on its scraped text with zero research',
    async run() {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'research-gate-score-'));
      const canvas = path.join(directory, 'canvas.json');
      const traps = spendTraps();
      const prompts = [];
      const marker = 'SCRAPED_TEXT_MARKER_7';
      const job = { ...rawRow('Older Retry Engineer', { snippet: `${marker} ${description('Older retry')}`, description: `${marker} ${description('Older retry')}` }),
        officialPosting: retryablePosting(), listingLiveness: liveness('pending') };
      const before = structuredClone(job);
      try {
        await fs.promises.writeFile(canvas, '{}');
        const claim = await claimJobAnalysisOperationAuthority({ canvasFilePath: canvas, hubId: 'hub', operationId: 'score',
          semanticBase: { kind: 'search', careerSnapshotId: PIN, runId: 'run-1' } });
        __registerJobsHandlersForTests({
          ...traps.dependencies,
          resolvePinnedScoringInput: async () => ({ profile: { workHistory: [] }, careerData: 'Synthetic candidate career text.', pinned: true }),
          runScoreBatch: async prompt => { prompts.push(prompt); throw new Error('synthetic scorer outage: the prompt is the observation'); },
        });
        const result = await ipcMain.__getInvokeHandler('score-jobs')({ sender: sender(71962, traps.spent.progress) }, {
          jobs: [job], careerSnapshotId: PIN, nodeId: 'hub', operationAuthority: claim.receipt,
          snapshotContext: { canvasFilePath: canvas, runId: 'run-1' },
        });
        assert.ok(prompts.length >= 1, 'the scorer ran on the scraped row');
        assert.ok(prompts.every(prompt => prompt.includes(marker)), 'the prompt carries the scraped text');
        assert.ok(prompts.every(prompt => !/Finding official postings/u.test(prompt)));
        assert.equal(traps.spent.research, 0, 'no official lookup retry');
        assert.equal(traps.spent.liveness, 0, 'no liveness AI');
        assert.equal(traps.spent.probes, 0, 'the pending listing is not rechecked before scoring');
        assert.equal(traps.spent.progress.some(item => /Finding official postings|official-posting/u.test(JSON.stringify(item.payload ?? item))), false);
        assert.deepEqual(job, before, 'the input row is untouched');
        const returned = (result.scoredJobs || []).find(row => row.title === job.title);
        assert.ok(returned, JSON.stringify(result).slice(0, 400));
        assert.deepEqual(returned.officialPosting, before.officialPosting, 'an older row keeps its lookup view exactly as it was');
        assert.deepEqual(returned.listingLiveness, before.listingLiveness, 'the pending verdict is carried, not rechecked');
      } finally {
        registerJobsHandlers();
        await fs.promises.rm(directory, { recursive: true, force: true });
      }
    },
  },
  // ── 8: settle-board-research ─────────────────────────────────────────────
  {
    name: 'research gate [8 settle-board-research]: only the row at the threshold reaches liveness, rescore and dedup; unscored and below rows pass through',
    async run() {
      const visited = []; const scored = []; let livenessAi = 0;
      const livenessRow = kind => ({ ...rawRow(`Live ${kind}`), ...FIT_KINDS[kind], listingLiveness: liveness('pending') });
      const rescoreRow = kind => ({ ...rawRow(`Rescore ${kind}`), ...FIT_KINDS[kind], officialPosting: foundPosting(`rescore-${kind}`, ['material-jd-change']),
        scoringEvidenceReceipt: { careerSnapshotId: PIN } });
      // The same official posting on every kind: the dedup winner may only come from the eligible rows.
      const duplicateRow = kind => ({ ...rawRow(`Dupe ${kind}`), ...FIT_KINDS[kind],
        officialPosting: foundPosting('shared-duplicate') });
      const belowBlankClosed = { ...rawRow('Below Closed Blank', { snippet: '', boardClosed: boardClosed(), listingLiveness: liveness('closed', 'structural') }),
        ...FIT_KINDS.belowThreshold };
      const unscoredBlankClosed = { ...rawRow('Unscored Closed Blank', { snippet: '', boardClosed: boardClosed(), listingLiveness: liveness('closed', 'structural') }),
        ...FIT_KINDS.unscoredHigh };
      const jobs = [...KIND_NAMES.map(livenessRow), ...KIND_NAMES.map(rescoreRow), ...KIND_NAMES.map(duplicateRow), belowBlankClosed, unscoredBlankClosed];
      const before = structuredClone(jobs);
      __registerJobsHandlersForTests({
        createListingLivenessProbe: () => ({ probe: async url => { visited.push(url); return { unknown: 'research-gate-probe' }; } }),
        callListingLiveness: async () => { livenessAi += 1; throw new Error('no evidence was captured, so no AI call is expected'); },
        getOfficialPostingView: async row => ({ description: '', officialPosting: row.officialPosting }),
        resolvePinnedScoringInput: async () => ({ profile: { workHistory: [] }, careerData: 'Synthetic candidate career text.', pinned: true }),
        runScoreBatch: async prompt => { scored.push(prompt); throw new Error('synthetic scorer outage: the prompt is the observation'); },
        runGapReview: async () => { throw new Error('no gap review expected'); },
      });
      try {
        const result = await ipcMain.__getInvokeHandler('settle-board-research')({ sender: sender(71963) }, { jobs, nodeId: 'research-gate-board' });
        assert.equal(result.success, true, result.error);
        assert.deepEqual(visited, ['https://remoteok.com/remote-jobs/live-atthreshold'], 'only the eligible pending row is probed');
        assert.equal(livenessAi, 0);
        assert.equal(result.counts.livenessVisited, 1);
        assert.equal(scored.length, 1, 'exactly one rescore handoff was attempted');
        assert.ok(scored[0].includes('Rescore atThreshold'), 'and it is for the eligible row');
        for (const kind of INELIGIBLE_KINDS) assert.equal(scored[0].includes(`Rescore ${kind}`), false, `${kind} is not in the rescore prompt`);
        assert.equal(result.counts.rescoreAttempted, 1);
        const eligibleTotal = jobs.filter(isResearchEligible).length;
        assert.equal(eligibleTotal, 3, 'the liveness, rescore and duplicate rows at the threshold');
        assert.equal(result.counts.eligible, eligibleTotal);
        assert.equal(result.counts.skippedBelowFit, 3 + 1, 'three below-threshold rows plus the closed blank one');
        assert.equal(result.counts.skippedUnscored, 3 * 2 + 1, 'both unscored kinds in each scenario plus the closed blank unscored row');
        const reasons = Object.fromEntries(result.dropped.map(entry => [entry.index, entry.reason]));
        const index = title => jobs.findIndex(job => job.title === title);
        assert.equal(reasons[index('Dupe atThreshold')], undefined, 'the only eligible copy of the posting cannot lose the dedup');
        assert.equal(result.counts.officialDuplicatesDropped, 0, 'ineligible copies never take part in the official dedup');
        assert.equal(reasons[index('Below Closed Blank')], 'below-fit-closed', 'a confirmed-closed row with no text below the bar is reported for removal');
        assert.equal(reasons[index('Unscored Closed Blank')], undefined, 'an unscored closed row is not treated as below the bar');
        assert.equal(Object.keys(reasons).length, 1);
        for (const [position, job] of jobs.entries()) {
          if (!isResearchEligible(job)) assert.deepEqual(result.jobs[position], before[position], `${job.title} passes through untouched`);
        }
      } finally {
        registerJobsHandlers();
      }
    },
  },
  {
    name: 'research gate [8 settle-board-research]: official dedup keeps the best eligible copy and ignores ineligible copies of the same posting',
    async run() {
      const copy = (title, extra) => ({ ...rawRow(title), officialPosting: foundPosting('shared-duplicate'), ...extra });
      const jobs = [copy('Copy Low', { matchScore: RESEARCH_MIN_FIT_SCORE }), copy('Copy High', { matchScore: RESEARCH_MIN_FIT_SCORE + 15 }),
        copy('Copy Below', { matchScore: RESEARCH_MIN_FIT_SCORE - 1 }), copy('Copy Unscored', FIT_KINDS.unscoredHigh)];
      __registerJobsHandlersForTests({ getOfficialPostingView: async row => ({ description: '', officialPosting: row.officialPosting }) });
      try {
        const result = await ipcMain.__getInvokeHandler('settle-board-research')({ sender: sender(71964) }, { jobs, nodeId: 'research-gate-dedup' });
        assert.equal(result.success, true, result.error);
        assert.deepEqual(result.dropped, [{ index: 0, reason: 'official-duplicate' }],
          'the lower eligible copy loses; the below-threshold and unscored copies are neither winners nor losers');
        assert.equal(result.counts.officialDuplicatesDropped, 1);
      } finally {
        registerJobsHandlers();
      }
    },
  },
  {
    name: 'research gate [8 settle-board-research]: deferred company research names only the eligible row\'s employer',
    async run() {
      const sent = [];
      const jobs = KIND_NAMES.map(kind => ({ ...rawRow(`Company ${kind}`, { company: `Gate Employer ${kind}` }), ...FIT_KINDS[kind],
        preferenceAssessment: pendingCompanyAssessment() }));
      const runId = `research-gate-company-${process.pid}`;
      const client = sender(71965, sent);
      __registerJobsHandlersForTests({});
      registerNonApiAiHandlers();
      try {
        const pending = ipcMain.__getInvokeHandler('settle-board-research')({ sender: client }, { jobs, nodeId: 'research-gate-company', manualAiRunId: runId });
        await waitFor(() => sent.some(item => item.channel === 'non-api-ai-request'), 'the first company-research prompt');
        const prompts = sent.filter(item => item.channel === 'non-api-ai-request').map(item => String(item.payload?.prompt || ''));
        abortNodeTasks('research-gate-company', client);
        await pending.catch(() => null);
        const issued = sent.filter(item => item.channel === 'non-api-ai-request').map(item => String(item.payload?.prompt || ''));
        assert.ok(issued.length >= 1);
        assert.ok(prompts[0].includes('Gate Employer atThreshold'), 'the eligible employer is researched');
        for (const kind of INELIGIBLE_KINDS) {
          assert.equal(issued.some(prompt => prompt.includes(`Gate Employer ${kind}`)), false, `${kind} employer is never researched`);
        }
      } finally {
        await ipcMain.__getInvokeHandler('complete-non-api-ai-run')({ sender: client }, { runId }).catch(() => null);
        registerJobsHandlers();
      }
    },
  },
  {
    name: 'research gate [8 settle-board-research]: a live official posting outranks a closed board verdict below the bar, and the report records a failed stage',
    async run() {
      const closed = { boardClosed: boardClosed(), listingLiveness: liveness('closed', 'structural') };
      const jobs = [{ ...rawRow('Below Closed Live', closed), ...FIT_KINDS.belowThreshold, officialPosting: foundPosting('live-below') },
        { ...rawRow('Below Closed Plain', closed), ...FIT_KINDS.belowThreshold }];
      const client = sender(71967);
      __registerJobsHandlersForTests({ getOfficialPostingView: async row => ({ description: '', officialPosting: row.officialPosting }) });
      try {
        const result = await ipcMain.__getInvokeHandler('settle-board-research')({ sender: client }, { jobs, nodeId: 'research-gate-live' });
        assert.deepEqual(result.dropped, [{ index: 1, reason: 'below-fit-closed' }], 'only the row with no live posting leaves');
        __registerJobsHandlersForTests({ settleBoardClosedRowsForTests: async () => { throw Object.assign(new Error('synthetic settle failure'), { code: 'SYNTHETIC' }); } });
        await ipcMain.__getInvokeHandler('settle-board-research')({ sender: client }, { jobs: [{ ...rawRow('Failing Row'), ...FIT_KINDS.atThreshold }], nodeId: 'research-gate-live' }).catch(() => null);
        const [record] = __runWithIpcRequestContextForTests({ sender: client, nodeId: null, channel: 'bug-report' },
          () => getJobsBoardTelemetryForReport(new Set(['research-gate-live']), client.id));
        assert.equal(record.research.error, true, 'a stage that failed never reads as a clean zero');
      } finally {
        registerJobsHandlers();
      }
    },
  },
  // ── 9: the Board stage ───────────────────────────────────────────────────
  {
    name: 'research gate [9 runBoardResearchStage]: only eligible rows reach the lookup, protected cards survive removal and settle sees untouched ineligible rows',
    async run() {
      const refreshed = []; const settled = []; const labels = [];
      const at = { ...rawRow('Stage At'), cardId: 'card-at', ...FIT_KINDS.atThreshold };
      const above = { ...rawRow('Stage Above'), cardId: 'card-above', matchScore: RESEARCH_MIN_FIT_SCORE + 25 };
      const below = { ...rawRow('Stage Below'), cardId: 'card-below', ...FIT_KINDS.belowThreshold };
      const protectedBelow = { ...rawRow('Stage Below Protected'), cardId: 'card-protected', ...FIT_KINDS.belowThreshold };
      const unscored = { ...rawRow('Stage Unscored'), cardId: 'card-unscored', ...FIT_KINDS.unscored };
      const unscoredHigh = { ...rawRow('Stage Unscored Linked'), cardId: 'card-linked', ...FIT_KINDS.unscoredHigh, localApplication: { id: 'synthetic-application' } };
      const union = [at, above, below, protectedBelow, unscored, unscoredHigh];
      const before = structuredClone(union);
      const outcome = await runBoardResearchStage(union, {
        nodeId: 'board', manualAiRunId: 'run-9', protectedIds: new Set(['card-protected']), onProgress: value => labels.push(value.label),
        refresh: async ({ entries }) => {
          refreshed.push(entries);
          return { success: true, entries: entries.map(({ cardId }) => ({ cardId, officialPosting: retryablePosting(), postedBy: '' })) };
        },
        settle: async args => {
          settled.push(args);
          // The host reports an eligible row, three below-threshold rows (one protected by id, one by a saved application)
          // and an unscored row as removable; only unprotected ones may leave.
          return { success: true, jobs: args.jobs, counts: { synthetic: true },
            dropped: [1, 2, 3, 4, 5].map(index => ({ index, reason: 'synthetic' })) };
        },
      });
      assert.equal(refreshed.length, 1);
      assert.deepEqual(refreshed[0].map(entry => entry.job.title), ['Stage At', 'Stage Above'], 'only eligible rows are looked up');
      for (const title of ['Stage Below', 'Stage Below Protected', 'Stage Unscored', 'Stage Unscored Linked']) {
        assert.equal(JSON.stringify(refreshed).includes(title), false, `${title} never appears in a refresh entry`);
      }
      assert.ok(refreshed[0].every(entry => !Object.hasOwn(entry.job, 'matchScore') && !Object.hasOwn(entry.job, 'scoreStatus')), 'the projection carries no score');
      assert.equal(settled.length, 1);
      assert.equal(settled[0].officialLookups, 2);
      assert.deepEqual(settled[0].jobs.map(job => job.title), union.map(job => job.title), 'settle sees every row in order');
      settled[0].jobs.forEach((job, index) => {
        if (index >= 2) assert.deepEqual(job, before[index], `${job.title} reaches settle exactly as it was`);
        else assert.deepEqual(job.officialPosting, retryablePosting(), `${job.title} carries the lookup`);
      });
      assert.deepEqual(outcome.jobs.map(job => job.title), ['Stage At', 'Stage Below Protected', 'Stage Unscored Linked'],
        'removal drops the unprotected rows only: protected by card id or by a saved application survives');
      assert.equal(outcome.removed, 3);
      assert.ok(labels.some(label => /2 of 2/u.test(label)), 'progress counts the eligible rows');
      assert.ok(labels.every(label => !/of 6/u.test(label)), 'progress never counts the whole union as researched');
    },
  },
  {
    name: 'research gate [9 runBoardResearchStage]: an exhausted lookup stays settled, every other eligible row still crosses',
    async run() {
      const paused = { ...rawRow('Stage Paused'), cardId: 'card-paused', matchScore: RESEARCH_MIN_FIT_SCORE + 5,
        officialPosting: { level: 'L5', outcome: 'ambiguous', employer: '', trail: ['worker-research', 'semantic-uncertain', 'lookup-exhausted'] } };
      const interrupted = { ...rawRow('Stage Interrupted'), cardId: 'card-interrupted', matchScore: RESEARCH_MIN_FIT_SCORE + 5,
        officialPosting: { level: 'L5', outcome: 'failed', employer: '', trail: ['worker-timeout', 'lookup-exhausted'] } };
      const open = { ...rawRow('Stage Open'), cardId: 'card-open', matchScore: RESEARCH_MIN_FIT_SCORE + 5 };
      const refreshed = []; const settled = []; const labels = [];
      const outcome = await runBoardResearchStage([paused, interrupted, open], {
        nodeId: 'board', manualAiRunId: 'run-paused', onProgress: value => labels.push(value.label),
        refresh: async ({ entries }) => { refreshed.push(...entries); return { success: true, entries: entries.map(({ cardId }) => ({ cardId, officialPosting: retryablePosting(), postedBy: '' })) }; },
        settle: async args => { settled.push(args); return { success: true, jobs: args.jobs, counts: {} }; },
      });
      assert.deepEqual(refreshed.map(entry => entry.job.title), ['Stage Interrupted', 'Stage Open']);
      assert.equal(settled[0].officialLookups, 2);
      assert.deepEqual(settled[0].jobs[0].officialPosting, paused.officialPosting, 'the paused row keeps its result and stays on the board');
      assert.equal(outcome.pausedRetries, 1);
      assert.equal(outcome.jobs.length, 3);
      assert.ok(labels.some(label => /0 below skipped/u.test(label)), 'a paused row is not reported as below the threshold');
    },
  },
  {
    name: 'research gate [9 runBoardResearchStage]: a row the last Combine removed reuses its lookup until it has a card',
    async run() {
      const row = title => ({ ...rawRow(title), cardId: `card-${title}`, matchScore: RESEARCH_MIN_FIT_SCORE + 5 });
      const uncertain = { level: 'L5', outcome: 'ambiguous', employer: '', trail: ['worker-research', 'semantic-uncertain'] };
      const finished = { level: 'L1', outcome: 'closed', employer: 'Synthetic Employer', sourceUrl: 'https://careers.example.test/gone',
        trail: ['closed', 'closure-page-read', 'semantic-match-v1'], semanticMatch: { version: 1, inputHash: 'a'.repeat(64), sourceHash: 'b'.repeat(64) } };
      const stage = async (union, options) => {
        const refreshed = []; const settled = [];
        const outcome = await runBoardResearchStage(union, { nodeId: 'board', manualAiRunId: 'run-removed', ...options,
          refresh: async ({ entries }) => { refreshed.push(...entries.map(entry => entry.job.title)); return { success: true, entries: entries.map(({ cardId }) => ({ cardId, officialPosting: options.result || finished, postedBy: 'Poster' })) }; },
          settle: async args => { settled.push(args); return { success: true, jobs: args.jobs, counts: {}, dropped: options.drop.map(index => ({ index, reason: 'closed' })) }; } });
        return { outcome, refreshed, settled };
      };
      const first = await stage([row('Gone'), row('Kept')], { drop: [0] });
      assert.deepEqual(first.refreshed, ['Gone', 'Kept']);
      assert.equal(first.outcome.removedLookups.length, 1, 'only the removed row is saved');
      assert.deepEqual(first.outcome.removedLookups[0].officialPosting, finished);
      assert.match(first.outcome.removedLookups[0].key, /^[a-f0-9]{64}$/u);
      const second = await stage([row('Gone'), row('Kept')], { drop: [0], removedLookups: first.outcome.removedLookups });
      assert.deepEqual(second.refreshed, ['Kept'], 'the removed row is not researched again');
      assert.deepEqual(second.settled[0].jobs[0].officialPosting, finished, 'settle sees the saved lookup and can remove it again');
      assert.equal(second.settled[0].jobs[0].postedBy, 'Poster');
      assert.equal(second.settled[0].officialLookups, 1);
      assert.equal(second.outcome.reusedRemovals, 1);
      assert.equal(second.outcome.pausedRetries, 0);
      assert.deepEqual(second.outcome.removedLookups, first.outcome.removedLookups, 'a repeat removal stays saved for the next Combine');
      const changed = await stage([{ ...row('Gone'), snippet: 'A changed source.' }], { drop: [], removedLookups: first.outcome.removedLookups });
      assert.deepEqual(changed.refreshed, ['Gone'], 'a changed source owes a new lookup');
      const carded = await stage([row('Gone')], { drop: [], removedLookups: first.outcome.removedLookups,
        existingCards: [{ id: 'gone', type: 'jobcard', data: row('Gone') }] });
      assert.deepEqual(carded.refreshed, ['Gone'], 'a live card outranks an old removal');
      const corrupt = await stage([row('Gone')], { drop: [], removedLookups: [{ ...first.outcome.removedLookups[0], officialPosting: { trail: ['not-a-code'] } }] });
      assert.deepEqual(corrupt.refreshed, ['Gone'], 'an unreadable saved lookup is researched');
      const incomplete = await stage([row('Gone')], { drop: [0], result: uncertain });
      assert.deepEqual(incomplete.outcome.removedLookups, [], 'an incomplete lookup is never saved');
      const oldIncomplete = await stage([row('Gone')], { drop: [], removedLookups: [{ ...first.outcome.removedLookups[0], officialPosting: uncertain }] });
      assert.deepEqual(oldIncomplete.refreshed, ['Gone'], 'an incomplete saved lookup is researched again');
      assert.equal(oldIncomplete.outcome.reusedRemovals, 0);
      const below = await stage([{ ...rawRow('Low'), ...FIT_KINDS.belowThreshold }], { drop: [0] });
      assert.deepEqual(below.outcome.removedLookups, [], 'a row that never owed a lookup is not saved');
    },
  },
  {
    name: 'research gate [9 runBoardResearchStage]: a rescore already carried on a card is reused and the host makes no new scoring call',
    async run() {
      const scoreCalls = [];
      const posting = foundPosting('carried', ['material-jd-change']);
      const job = { ...rawRow('Carried Engineer'), matchScore: RESEARCH_MIN_FIT_SCORE + 4, officialPosting: posting, scoringEvidenceReceipt: { careerSnapshotId: PIN } };
      const card = { type: 'jobcard', id: 'card-carried', data: { ...job, matchScore: RESEARCH_MIN_FIT_SCORE + 9, rawScore: 99, reasoning: 'Synthetic accepted rescore.',
        officialRescore: { contentHash: posting.contentHash, careerSnapshotId: PIN, previousScore: RESEARCH_MIN_FIT_SCORE + 4 } } };
      const carried = carryBoardRescores([job], [card])[0];
      assert.equal(carried.matchScore, RESEARCH_MIN_FIT_SCORE + 9, 'the accepted rescore rides on the row');
      assert.equal(carried.officialRescore.contentHash, posting.contentHash);
      assert.equal(carryBoardRescores([job], [{ ...card, data: { ...card.data, officialRescore: { contentHash: hex('another') } } }])[0].matchScore, job.matchScore,
        'a rescore of different official text is not reused');
      assert.equal(carryBoardRescores([{ ...job, scoringEvidenceReceipt: { careerSnapshotId: 'c'.repeat(64) } }], [card])[0].matchScore, job.matchScore,
        'a rescore on an older career record never overwrites a fresh score');
      const pendingJob = { ...job, preferenceAssessment: { status: 'accepted', companyResearchPending: true, matches: [] } };
      const answered = { status: 'accepted', companyResearchVersion: COMPANY_RESEARCH_VERSION, matches: [] };
      assert.deepEqual(carryBoardRescores([pendingJob], [{ ...card, data: { ...card.data, officialRescore: undefined, preferenceAssessment: answered } }])[0].preferenceAssessment, answered,
        'finished current-version company research on a card is not asked again');
      assert.equal(carryBoardRescores([pendingJob], [{ ...card, data: { ...card.data, officialRescore: undefined, preferenceAssessment: { status: 'accepted', matches: [] } } }])[0].preferenceAssessment.companyResearchPending, true,
        'research from before the current version is asked again');
      __registerJobsHandlersForTests({
        getOfficialPostingView: async row => ({ description: '', officialPosting: row.officialPosting }),
        resolvePinnedScoringInput: async () => ({ profile: { workHistory: [] }, careerData: 'Synthetic candidate career text.', pinned: true }),
        runScoreBatch: async prompt => { scoreCalls.push(prompt); throw new Error('synthetic scorer outage: the call itself is the observation'); },
        runGapReview: async () => { throw new Error('no gap review expected'); },
      });
      const stage = existingCards => runBoardResearchStage([job], {
        nodeId: 'board', manualAiRunId: 'run-9b', existingCards,
        refresh: async ({ entries }) => ({ success: true, entries: entries.map(({ cardId, job: entry }) => ({ cardId, officialPosting: entry.officialPosting, postedBy: '' })) }),
        settle: args => ipcMain.__getInvokeHandler('settle-board-research')({ sender: sender(71966) }, args),
      });
      try {
        const reused = await stage([card]);
        assert.deepEqual(scoreCalls, [], 'no new scoring call for a rescore already on the card');
        assert.equal(reused.jobs[0].matchScore, RESEARCH_MIN_FIT_SCORE + 9);
        assert.equal(reused.counts.rescoreAttempted, 0);
        const fresh = await stage([]);
        assert.equal(scoreCalls.length, 1, 'the same row without a carried rescore is rescored once, so the control is live');
        assert.equal(fresh.counts.rescoreAttempted, 1);
      } finally {
        registerJobsHandlers();
      }
    },
  },
  // ── 10: taxonomy ─────────────────────────────────────────────────────────
  {
    name: 'research gate [10 taxonomy]: an unmapped below-threshold or unscored row costs no classify call and lands in Other',
    async run() {
      const mapped = Array.from({ length: 24 }, (_unused, index) => ({ title: `Mapped Role ${index}`, careerDirection: `Direction ${index}`, salary: '$100k/yr',
        matchScore: RESEARCH_MIN_FIT_SCORE + 5 }));
      const plan = { salaryRanges: [{ label: '$100k+/yr', minSalary: 100000, maxSalary: 0 }, { label: 'Unspecified', minSalary: 0, maxSalary: 0 }],
        roleFamilies: ['Mapped', 'Classified', 'Other'],
        directionRoleIndexes: mapped.map((_job, index) => ({ direction: `Direction ${index}`, roleIndex: 0 })) };
      const outcomeFor = async rare => {
        const classified = [];
        const result = await runBoundedJobTaxonomy([...mapped, { title: 'Rare Role', careerDirection: 'Direction rare', salary: '$100k/yr', ...rare }], {
          callText: async (_prompt, options) => {
            if (options.task === 'job-taxonomy-plan') return plan;
            classified.push(options.hints);
            return { roleByIndex: [1] };
          },
        });
        return { role: result.roleByIndex[24], classified, mappedRoles: result.roleByIndex.slice(0, 24) };
      };
      const atThreshold = await outcomeFor(FIT_KINDS.atThreshold);
      assert.equal(atThreshold.classified.length, 1, 'at the threshold the rare direction is still classified');
      assert.equal(atThreshold.role, 'Classified');
      for (const kind of ['belowThreshold', 'unscored']) {
        const result = await outcomeFor(FIT_KINDS[kind]);
        assert.deepEqual(result.classified, [], `a ${kind} row costs no classify call`);
        assert.equal(result.role, 'Other');
        assert.ok(result.mappedRoles.every(role => role === 'Mapped'), 'planner-mapped rows are unaffected');
      }
    },
  },
  // ── 11: location consolidation ───────────────────────────────────────────
  {
    name: 'research gate [11 location consolidation]: a pair with no eligible row costs no confirmation call',
    async run() {
      const body = 'The platform role builds reliable service infrastructure and mentors engineers across production operations. '.repeat(12);
      const make = (index, fit) => ({ title: 'Platform Engineer', company: 'Northwind Labs', location: `Raw city ${index}`, source: 'google',
        description: `${body} Raw distinct variant ${index}.`, snippet: `${body} Raw distinct variant ${index}.`,
        url: `https://board.example.test/location-${index}`, ...fit });
      const asked = [];
      const confirm = jobs => confirmSimilarJobLocationPairs(jobs, {
        postingJob: job => job, checkFits: async () => ({ fits: true }),
        callText: async (prompt, options) => {
          const confirmations = [...prompt.matchAll(/"pairId":"([^"]+)"/gu)].map(match => ({ pairId: match[1], sameJob: true }));
          const value = { confirmations }; options.responseValidator(value); asked.push(...confirmations.map(row => row.pairId)); return value;
        },
      });
      const noneEligible = [make(0, FIT_KINDS.belowThreshold), make(1, FIT_KINDS.unscored), make(2, FIT_KINDS.unscoredHigh)];
      assert.equal(findSimilarLocationCandidates(noneEligible).length, 3, 'the fixture really holds similar pairs');
      assert.deepEqual(await confirm(noneEligible), { candidateCount: 0, batchCount: 0, confirmedPairIds: [] });
      assert.deepEqual(asked, [], 'no AI call for pairs of ineligible rows');
      const oneEligible = [make(0, FIT_KINDS.atThreshold), make(1, FIT_KINDS.belowThreshold), make(2, FIT_KINDS.unscored)];
      const expected = findSimilarLocationCandidates(oneEligible).filter(pair => pair.leftIndex === 0 || pair.rightIndex === 0).map(pair => pair.id);
      assert.equal(expected.length, 2);
      const result = await confirm(oneEligible);
      assert.deepEqual(asked, expected, 'only the pairs holding the eligible row are confirmed');
      assert.deepEqual(result.confirmedPairIds, expected);
    },
  },
  // ── 12: preferences ──────────────────────────────────────────────────────
  {
    name: 'research gate [12 preferences]: evaluating with deferCompanyResearch makes no research call and the deferred pass filters on a conflict',
    async run() {
      const jobs = ['Conflict', 'Confirmed'].map(name => ({ title: 'Program Manager', company: `Deferred ${name} Co`, location: 'Remote', snippet: description(name), url: `https://listing.example.test/${name}` }));
      const listingAnswer = async (_prompt, options) => {
        assert.equal(options.task, 'job-preference-evaluation', 'only the listing evaluation runs before research');
        return { assessments: jobs.map((_job, index) => ({ index, matches: [{ preferenceId: 'lunch', outcome: 'unverified', evidence: 'Not listed.' }] })) };
      };
      const rawCalls = [];
      const evaluated = await evaluateJobPreferences({
        jobs, jobPreferences: 'Free lunch is required.', preferencePlan: PREFERENCE_PLAN, deferCompanyResearch: true,
        callRaw: async (...args) => { rawCalls.push(args); throw new Error('deferred company research must not run during evaluation'); },
        callText: listingAnswer,
      });
      assert.deepEqual(rawCalls, [], 'zero grounded-research calls');
      assert.equal(evaluated.acceptedJobs.length, 2, 'a strict company match left unverified stays accepted');
      assert.equal(evaluated.filteredJobs.length, 0);
      assert.equal(evaluated.counts.researchDeferred, 2);
      for (const job of evaluated.candidatePool) {
        assert.equal(job.preferenceAssessment.status, 'accepted');
        assert.equal(job.preferenceAssessment.companyResearchPending, true);
        assert.equal(job.preferenceAssessment.matches[0].outcome, 'unverified');
      }
      // The control: without the flag the same evaluation does research.
      let controlRaw = 0;
      await evaluateJobPreferences({
        jobs: jobs.map(job => ({ ...job, company: `${job.company} Control` })), jobPreferences: 'Free lunch is required.', preferencePlan: PREFERENCE_PLAN,
        callRaw: async () => { controlRaw += 1; throw new Error('synthetic research outage'); },
        callText: listingAnswer,
      }).catch(() => null);
      assert.ok(controlRaw >= 1, 'without deferCompanyResearch the same evaluation attempts research, so the zero above is live');

      const researchCalls = [];
      const quote = company => `${company} offers no meal benefit.`;
      const research = pool => researchDeferredJobPreferences({
        jobs: pool,
        callRaw: async prompt => {
          const ids = [...new Set(prompt.match(/research-[a-f0-9]{20}/gu) || [])];
          researchCalls.push(ids);
          return ids.map(id => `BEGIN RESEARCH ${id}\nGate Evidence ${id}: ${quote('Deferred')} https://example.test/${id}\nEND RESEARCH ${id}`).join('\n');
        },
        callText: async prompt => {
          const ids = [...new Set(prompt.match(/research-[a-f0-9]{20}/gu) || [])];
          return { assessments: ids.map(researchId => ({ researchId, preferenceId: 'lunch', outcome: verdict, evidence: 'Benefits page.',
            evidenceQuote: quote('Deferred'), sourceUrls: [`https://example.test/${researchId}`], sourceDate: '' })) };
        },
      });
      let verdict = 'conflicts';
      const conflicted = await research([evaluated.candidatePool[0]]);
      assert.equal(conflicted.requests, 1);
      assert.equal(conflicted.filtered, 1);
      assert.equal(conflicted.jobs[0].preferenceAssessment.status, 'filtered', 'a researched conflict now filters the job');
      assert.equal(Object.hasOwn(conflicted.jobs[0].preferenceAssessment, 'companyResearchPending'), false);
      verdict = 'confirmed';
      const confirmed = await research([evaluated.candidatePool[1]]);
      assert.equal(confirmed.filtered, 0);
      assert.equal(confirmed.jobs[0].preferenceAssessment.status, 'accepted');
      assert.equal(Object.hasOwn(confirmed.jobs[0].preferenceAssessment, 'companyResearchPending'), false, 'research settles the pending flag');
      assert.equal(confirmed.jobs[0].preferenceAssessment.matches[0].outcome, 'confirmed');
      assert.equal(researchCalls.length, 2);
    },
  },
  // ── 13: Generate and the per-card lookup stay ungated ────────────────────
  {
    name: 'research gate [13 ungated lookups]: refreshOfficialPostingEntries researches an entry whatever its score, and the projection carries none',
    async run() {
      const projected = projectOfficialPostingGenerationJob({ ...rawRow('Projected Engineer'), matchScore: 3, scoreStatus: UNSCORED_SCORE_STATUS, rawScore: 3 });
      assert.equal(Object.hasOwn(projected, 'matchScore'), false);
      assert.equal(Object.hasOwn(projected, 'scoreStatus'), false);
      const resolved = [];
      const entries = [
        { cardId: 'lookup-low', job: { ...rawRow('Lookup Low'), ...FIT_KINDS.belowThreshold } },
        { cardId: 'lookup-unscored', job: { ...rawRow('Lookup Unscored'), ...FIT_KINDS.unscored } },
        { cardId: 'lookup-unscored-high', job: { ...rawRow('Lookup Unscored High'), ...FIT_KINDS.unscoredHigh } },
        { cardId: 'lookup-plain', job: projected },
      ];
      const result = await refreshOfficialPostingEntries({ nodeId: 'board', manualAiRunId: 'official-posting:gate', entries }, {
        store: { find: async () => null },
        resolve: async rows => { resolved.push(rows.map(row => row.title)); return { jobs: rows.map(row => ({ ...row, officialPosting: retryablePosting() })) }; },
      });
      assert.deepEqual(resolved, [['Lookup Low', 'Lookup Unscored', 'Lookup Unscored High', 'Projected Engineer']], 'every entry reaches the resolver regardless of score');
      assert.deepEqual(result.entries.map(entry => entry.cardId), entries.map(entry => entry.cardId));
      assert.ok(result.entries.every(entry => normalizeOfficialPosting(entry.officialPosting)), 'each entry got a lookup result');
    },
  },
  // ── 14: card display ─────────────────────────────────────────────────────
  {
    name: 'research gate [14 display]: a below-threshold or unscored card with no lookup says why, a verified one shows its state, a row with no score fields says not checked',
    run() {
      const base = rawRow('Display Engineer');
      const reasons = { belowThreshold: researchSkipReason(FIT_KINDS.belowThreshold), unscored: researchSkipReason(FIT_KINDS.unscored) };
      assert.match(reasons.belowThreshold, new RegExp(`fit below ${RESEARCH_MIN_FIT_SCORE}`, 'u'));
      assert.match(reasons.unscored, /fit score unavailable/u);
      for (const kind of ['belowThreshold', 'unscored', 'unscoredHigh']) {
        const display = officialPostingDisplay({ ...base, ...FIT_KINDS[kind] });
        assert.equal(display.researchSkipped, true, `${kind}: the lookup was skipped by the gate`);
        assert.equal(display.statusLabel, researchSkipReason(FIT_KINDS[kind]), `${kind}: the label is the true reason`);
        assert.equal(display.lookupRetryable, true, `${kind}: the card's own lookup is still offered`);
        assert.notEqual(display.statusLabel, 'Official posting not checked');
      }
      const eligible = officialPostingDisplay({ ...base, ...FIT_KINDS.atThreshold });
      assert.equal(eligible.researchSkipped, false, 'an eligible card that has not been looked up yet is simply not checked');
      assert.equal(eligible.statusLabel, 'Official posting not checked');
      const verified = officialPostingDisplay({ ...base, ...FIT_KINDS.belowThreshold, officialPosting: foundPosting('display-verified') });
      assert.equal(verified.researchSkipped, false);
      assert.equal(verified.lookupState, 'verified');
      assert.equal(verified.statusLabel, 'Exact official posting verified');
      const unscoredVerified = officialPostingDisplay({ ...base, ...FIT_KINDS.unscoredHigh, officialPosting: foundPosting('display-verified-unscored') });
      assert.equal(unscoredVerified.lookupState, 'verified');
      const unscoredFields = officialPostingDisplay(base);
      assert.equal(unscoredFields.researchSkipped, false, 'a row with no score fields at all (a dock entry, an export) reports no gate decision');
      assert.equal(unscoredFields.statusLabel, 'Official posting not checked');
      const failed = officialPostingDisplay({ ...rawRow('Below Failed'), ...FIT_KINDS.belowThreshold, officialPosting: retryablePosting() });
      assert.equal(failed.researchSkipped, true, 'an unfinished lookup below the threshold is not outstanding work');
      assert.equal(failed.statusLabel, researchSkipReason(FIT_KINDS.belowThreshold));
    },
  },
  // ── 15: report ───────────────────────────────────────────────────────────
  {
    name: 'research gate [15 report]: an unresearched ineligible card reports not-researched and is not retryable',
    run() {
      const card = (id, data) => ({ id, type: 'jobcard', data: { ...rawRow(id), ...data } });
      const report = collectOfficialPostingReport([
        card('below', FIT_KINDS.belowThreshold), card('unscored', FIT_KINDS.unscored), card('unscored-high', FIT_KINDS.unscoredHigh),
        card('eligible', FIT_KINDS.atThreshold), card('no-score', {}),
        card('below-verified', { ...FIT_KINDS.belowThreshold, officialPosting: foundPosting('report-verified') }),
        card('below-incomplete', { ...FIT_KINDS.belowThreshold, officialPosting: retryablePosting() }),
      ]);
      const rows = Object.fromEntries(report.rows.map(row => [row.id, row]));
      for (const id of ['below', 'unscored', 'unscored-high']) {
        assert.equal(rows[id].state, 'not-researched', `${id} was a decision, not a failure`);
        assert.equal(rows[id].retryable, false);
        assert.equal(rows[id].record, 'absent');
      }
      assert.equal(rows.eligible.state, 'unchecked', 'an eligible card with no lookup is still unchecked');
      assert.equal(rows.eligible.retryable, true);
      assert.equal(rows['no-score'].state, 'unchecked', 'a card with no score fields keeps the old reading');
      assert.equal(rows['below-verified'].state, 'verified');
      assert.equal(rows['below-verified'].retryable, false);
      assert.equal(rows['below-incomplete'].state, 'not-researched', 'an unfinished lookup below the threshold is not outstanding work');
      assert.equal(rows['below-incomplete'].retryable, false);
    },
  },
  // ── 16: the gate itself ──────────────────────────────────────────────────
  {
    name: 'research gate [16 unit]: inclusive at the threshold, an honest 50 is below it, unscored and non-finite scores are unavailable',
    run() {
      assert.equal(RESEARCH_MIN_FIT_SCORE, 70, 'the documented bar');
      assert.equal(classifyResearchEligibility({ matchScore: RESEARCH_MIN_FIT_SCORE }), RESEARCH_ELIGIBILITY.eligible, 'inclusive at the threshold');
      assert.equal(classifyResearchEligibility({ matchScore: RESEARCH_MIN_FIT_SCORE + 1 }), RESEARCH_ELIGIBILITY.eligible);
      assert.equal(classifyResearchEligibility({ matchScore: RESEARCH_MIN_FIT_SCORE - 1 }), RESEARCH_ELIGIBILITY.belowThreshold);
      assert.equal(classifyResearchEligibility({ matchScore: 50 }), RESEARCH_ELIGIBILITY.belowThreshold, 'an honest 50 is a score, and a low one');
      assert.equal(classifyResearchEligibility({ matchScore: 0 }), RESEARCH_ELIGIBILITY.belowThreshold);
      assert.equal(classifyResearchEligibility({ matchScore: 50, scoreStatus: 'unscored' }), RESEARCH_ELIGIBILITY.scoreUnavailable, 'the sentinel 50 is not a score');
      assert.equal(classifyResearchEligibility({ matchScore: 95, scoreStatus: 'unscored' }), RESEARCH_ELIGIBILITY.scoreUnavailable, 'a high number cannot override the marker');
      assert.equal(classifyResearchEligibility({ matchScore: 95, scoreStatus: 'unscored-format-error' }), RESEARCH_ELIGIBILITY.scoreUnavailable, 'any unscored prefix counts');
      assert.equal(classifyResearchEligibility({ matchScore: 95, scoreStatus: 'scored' }), RESEARCH_ELIGIBILITY.eligible, 'a status that is not unscored does not block');
      for (const matchScore of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined, null, '90', {}]) {
        assert.equal(classifyResearchEligibility({ matchScore }), RESEARCH_ELIGIBILITY.scoreUnavailable, `${String(matchScore)} is unavailable`);
      }
      for (const job of [null, undefined, {}, 'job']) assert.equal(classifyResearchEligibility(job), RESEARCH_ELIGIBILITY.scoreUnavailable);
      assert.equal(isResearchEligible({ matchScore: RESEARCH_MIN_FIT_SCORE }), true);
      assert.equal(isResearchEligible({ matchScore: RESEARCH_MIN_FIT_SCORE - 1 }), false);
      assert.equal(isResearchEligible({ matchScore: Number.NaN }), false);
      assert.equal(researchSkipReason({ matchScore: RESEARCH_MIN_FIT_SCORE }), null);
      assert.equal(researchSkipReason({ matchScore: RESEARCH_MIN_FIT_SCORE - 1 }), `Not researched: fit below ${RESEARCH_MIN_FIT_SCORE}`);
      assert.equal(researchSkipReason({ matchScore: 90, scoreStatus: 'unscored' }), 'Not researched: fit score unavailable');
      assert.deepEqual(summarizeResearchEligibility([{ matchScore: RESEARCH_MIN_FIT_SCORE }, { matchScore: RESEARCH_MIN_FIT_SCORE - 1 },
        { matchScore: 80, scoreStatus: 'unscored' }, { matchScore: Number.NaN }, {}]),
      { minFitScore: RESEARCH_MIN_FIT_SCORE, total: 5, eligible: 1, skippedBelowFit: 1, skippedUnscored: 3 });
    },
  },
];
