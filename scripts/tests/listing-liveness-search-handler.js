import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ipcMain } from 'electron';
import { __registerJobsHandlersForTests, getJobsTelemetry, registerJobsHandlers } from '../../electron/ipc/jobs.js';
import { claimJobAnalysisOperationAuthority } from '../../electron/ipc/jobAnalysisOperationAuthorityStore.js';
import { finalizeListingEvidence, LISTING_LIVENESS_RULES } from '../../electron/ipc/listingLiveness.js';
import { recordListingEvidence } from '../../electron/ipc/listingLivenessStore.js';
import { writeApprovedCareerSnapshotFixture } from './careerSnapshotFixture.mjs';
import { officialPostingSemanticInputHash } from '../../electron/ipc/officialPostingSemantic.js';
import { OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL } from '../../electron/ipc/officialPostingNegativePolicy.js';

const AT = '2026-10-25T12:00:00.000Z';
const DESCRIPTION = 'Build reliable platform services, review incidents, and document service recovery with the engineering team. '.repeat(8);
const CLOSED_NOTICE = 'This posting has closed.';
const OPEN_NOTICE = 'Applications are open.';

function job({ source = 'remoteok', key, title = 'Synthetic Engineer', company = 'Example Works', url,
  snippet = DESCRIPTION, verdict = 'pending', basis = 'closed-marker', extra = {} } = {}) {
  return { source, jobkey: key, title, company, location: 'Remote', salary: '', posted: 'today',
    url: url || (source === 'weworkremotely'
      ? `https://weworkremotely.com/remote-jobs/${key}` : `https://remoteok.com/remote-jobs/${key}`),
    snippet, listingLiveness: { verdict, basis, board: source, at: AT }, ...extra };
}

function evidenceFor(row, { finalUrl = row.url, chromeText = `${CLOSED_NOTICE} ${'This synthetic page is unavailable. '.repeat(4)}`,
  closed = true, openSignals = [] } = {}) {
  return finalizeListingEvidence({
    board: row.source, ruleKey: LISTING_LIVENESS_RULES[row.source] ? row.source : 'generic',
    requestedUrl: row.url, finalUrl, httpStatus: 200,
    title: `${row.title} | Board`, h1: row.title, expectedTitle: row.title,
    expectedCompany: row.company, expectedLocation: row.location,
    chromeText, descriptionText: row.snippet || '', descriptionIsPage: false,
    closedHits: closed ? [{ ruleId: 'synthetic-closed-banner', insideDescription: false, context: CLOSED_NOTICE }] : [],
    openSignals, jsonLd: { validThrough: null, isListed: null },
  });
}

const missed = row => ({ level: 'L5', outcome: 'not-found', employer: row.company, trail: ['bridge-unavailable'] });
const found = row => ({ level: 'L2', outcome: 'found', employer: row.company, trail: ['careers-page'],
  sourceUrl: `https://careers.example.test/jobs/${row.jobkey}` });

async function withSearchHarness(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'listing-liveness-search-'));
  const canvasFilePath = path.join(directory, 'canvas.json');
  try {
    await fs.writeFile(canvasFilePath, '{}');
    const { snapshotId: careerSnapshotId } = await writeApprovedCareerSnapshotFixture();
    await run({ directory, canvasFilePath, careerSnapshotId });
  } finally {
    registerJobsHandlers();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function runSearch({ canvasFilePath, careerSnapshotId, nodeId, rows, evidence = new Map(),
  callListingLiveness, listingLivenessCalibrationStore, settleBoardClosedRowsForTests } = {}) {
  const authority = await claimJobAnalysisOperationAuthority({ canvasFilePath, hubId: nodeId, operationId: `op-${nodeId}`,
    semanticBase: { kind: 'search', careerSnapshotId, runId: null, fingerprint: `synthetic-${nodeId}`,
      analysisRevisionId: null, continuationId: null, sourceArtifactFingerprint: null } });
  assert.equal(authority.admitted, true);
  const bySource = new Map();
  for (const row of rows) bySource.set(row.source, [...(bySource.get(row.source) || []), row]);
  // A search spends no research and no AI on a listing: both counters must stay
  // at zero, whatever the rows look like.
  const spent = { research: 0, liveness: 0, progress: [] };
  __registerJobsHandlersForTests({
    resolveRequiredPinnedCareerInput: async () => ({ profile: {}, careerData: '', pinned: true }),
    fetchHttpSources: async (...args) => {
      const results = [];
      for (const [sourceId, jobs] of bySource) {
        await args[10](sourceId);
        for (const row of jobs) {
          const captured = evidence.get(row.jobkey);
          if (captured) assert.equal(recordListingEvidence(row, captured), true, 'the provider callback has the IPC evidence context');
        }
        const result = { sourceId, jobs, gathered: jobs.length };
        await args[11](sourceId, result);
        await args[8]({ sourceId, query: 'synthetic engineer', page: 1, jobs });
        results.push(result);
      }
      return results;
    },
    resolveOfficialPostings: async jobs => { spent.research += 1; return { jobs, expiryCandidates: jobs.map(() => []), telemetry: { total: jobs.length } }; },
    getOfficialPostingView: async row => ({ description: '', officialPosting: row.officialPosting }),
    callListingLiveness: async (...args) => {
      spent.liveness += 1;
      return callListingLiveness ? callListingLiveness(...args) : answer(['open'])(...args);
    },
    ...(listingLivenessCalibrationStore ? { listingLivenessCalibrationStore } : {}),
    ...(settleBoardClosedRowsForTests ? { settleBoardClosedRowsForTests } : {}),
  });
  const sender = { id: 71949, isDestroyed: () => false, once() {}, on() {}, removeListener() {},
    send(channel, payload) { spent.progress.push({ channel, payload }); } };
  const result = await ipcMain.__getInvokeHandler('search-jobs')({ sender }, {
    queries: ['synthetic engineer'], nodeId, canvasFilePath, careerSnapshotId, operationAuthority: authority.receipt,
    enabledSourceIds: [...bySource.keys()], targetRole: '', preferredLocation: '',
  });
  return { result, telemetry: getJobsTelemetry().search, spent };
}

// The search contract: no lookup, no liveness AI, no research progress, and no
// row gains an official posting it did not already hold.
function assertSearchSpentNothing(spent, jobs, held = []) {
  assert.equal(spent.research, 0, 'a search makes no official-posting lookup');
  assert.equal(spent.liveness, 0, 'a search never calls the listing-liveness AI');
  assert.equal(spent.progress.some(item => /Finding official postings/u.test(JSON.stringify(item.payload || {}))), false,
    'a search reports no official-posting progress');
  for (const row of jobs) {
    if (!held.includes(row.jobkey)) assert.equal(row.officialPosting, undefined, 'a scraped row carries no officialPosting');
  }
}

// Board research runs against rows that already have a fit score.
async function runBoardResearch({ nodeId, jobs, evidence = new Map(), callListingLiveness,
  listingLivenessCalibrationStore } = {}) {
  const spent = { visited: [], liveness: 0 };
  __registerJobsHandlersForTests({
    createListingLivenessProbe: () => ({ probe: async url => { spent.visited.push(url); return evidence.get(url) || { unknown: 'synthetic-unavailable' }; } }),
    getOfficialPostingView: async row => ({ description: '', officialPosting: row.officialPosting }),
    callListingLiveness: async (...args) => {
      spent.liveness += 1;
      return callListingLiveness ? callListingLiveness(...args) : answer(['open'])(...args);
    },
    ...(listingLivenessCalibrationStore ? { listingLivenessCalibrationStore } : {}),
  });
  const sender = { id: 71950, isDestroyed: () => false, once() {}, on() {}, removeListener() {}, send() {} };
  const result = await ipcMain.__getInvokeHandler('settle-board-research')({ sender }, { jobs, nodeId });
  return { result, spent };
}

// A saved official lookup, with the semantic proof a settled row carries.
function withOfficial(row, posting) {
  return { ...row, officialPosting: { ...posting, trail: [...(posting.trail || []), 'semantic-match-v1'],
    semanticMatch: { version: 1, inputHash: officialPostingSemanticInputHash(row),
      ...(['L1', 'L2', 'L3', 'L4'].includes(posting.level) ? { sourceHash: 'b'.repeat(64) } : {}) } } };
}

function answer(verdicts) {
  return async (_prompt, options) => options.responseValidator({ rows: verdicts.map((verdict, index) => ({
    id: `r${index + 1}`, verdict, quote: verdict === 'closed' ? CLOSED_NOTICE : verdict === 'open' ? OPEN_NOTICE : '',
  })) });
}

const ACTIVE_NOTICE = `${OPEN_NOTICE} ${'This synthetic job is accepting applications. '.repeat(4)}`;

export default [
  {
    name: 'listing liveness handler: a search keeps board-closed rows with no lookup, no AI and no expiry confirmation',
    async run() {
      await withSearchHarness(async ({ canvasFilePath, careerSnapshotId }) => {
        const states = ['closed', 'open', 'unclear'];
        const rows = states.map(state => job({ key: `synthetic-expiry-${state}`,
          title: `Synthetic ${state} Expiry Engineer`, verdict: 'closed', basis: 'structural',
          extra: { boardClosed: { board: 'remoteok', reason: 'detail-page-not-found', at: AT } } }));
        const { result, telemetry, spent } = await runSearch({ canvasFilePath, careerSnapshotId,
          nodeId: 'synthetic-expiry-confirmation-hub', rows });
        assert.equal(result.success, true, result.error);
        assertSearchSpentNothing(spent, result.jobs);
        // Each row has a scraped description and no official posting yet, so it
        // is kept unchecked for the Board to research once it has a fit score.
        assert.deepEqual(result.jobs.map(item => item.jobkey).sort(), rows.map(item => item.jobkey).sort());
        assert.equal(telemetry?.officialPosting?.listingLiveness?.remoteok?.expiryOnlyClosedCopies || 0, 0);
        assert.equal(telemetry?.officialPosting?.listingLiveness?.remoteok?.expiryCandidatesConfirmedClosed || 0, 0);
        assert.equal(telemetry?.boardClosedDropped || 0, 0);
        assert.equal(telemetry?.officialPosting?.boardClosed?.remoteok?.keptUnchecked, 3);
      });
    },
  },
  {
    name: 'listing liveness handler: a search leaves a pending row pending and keeps a saved official posting untouched',
    async run() {
      await withSearchHarness(async ({ canvasFilePath, careerSnapshotId }) => {
        const pending = job({ key: 'synthetic-pending', title: 'Synthetic Engineer' });
        const official = withOfficial(job({ key: 'synthetic-official', title: 'Synthetic Official', basis: 'neither' }),
          found(job({ key: 'synthetic-official' })));
        const evidence = new Map([[pending.jobkey, evidenceFor(pending, { chromeText: ACTIVE_NOTICE, closed: false })],
          [official.jobkey, evidenceFor(official, { closed: false })]]);
        const { result, telemetry, spent } = await runSearch({ canvasFilePath, careerSnapshotId,
          nodeId: 'synthetic-liveness-pending', rows: [pending, official], evidence });
        assert.equal(result.success, true, result.error);
        assertSearchSpentNothing(spent, result.jobs, [official.jobkey]);
        assert.equal(result.jobs.find(row => row.jobkey === pending.jobkey)?.listingLiveness?.verdict, 'pending',
          'no AI answer is asked for, so the pending verdict stays');
        assert.equal(result.jobs.find(row => row.jobkey === official.jobkey)?.officialPosting?.level, 'L2',
          'an older row keeps the official posting it already held');
        assert.equal(telemetry?.officialPosting?.listingLiveness?.remoteok?.aiSkippedOfficial || 0, 0);
        assert.equal(telemetry?.reconciliation?.reconciled, true);
      });
    },
  },
  {
    name: 'listing liveness handler: an older row holding an AI-confirmed ATS closure drops with a receipted conserved funnel',
    async run() {
      await withSearchHarness(async ({ canvasFilePath, careerSnapshotId }) => {
        const row = job({ key: 'synthetic-ats-close', verdict: 'closed', basis: 'ai' });
        const evidence = new Map([[row.jobkey, evidenceFor(row, {
          finalUrl: 'https://boards.greenhouse.io/example/jobs/synthetic-ats-close',
        })]]);
        const { result, telemetry, spent } = await runSearch({ canvasFilePath, careerSnapshotId,
          nodeId: 'synthetic-ats-close-hub', rows: [row], evidence });
        assert.equal(result.success, true, result.error);
        assertSearchSpentNothing(spent, result.jobs);
        assert.deepEqual(result.jobs, []);
        assert.equal(telemetry?.boardClosedDropped, 1);
        assert.equal(telemetry?.officialPosting?.listingLiveness?.remoteok?.droppedOfficialClosed, 1);
        assert.equal(telemetry?.reconciliation?.reconciled, true);
      });
    },
  },
  {
    name: 'listing liveness handler: a pending ATS-page row is not closed by a search, which asks no AI',
    async run() {
      await withSearchHarness(async ({ canvasFilePath, careerSnapshotId }) => {
        const row = job({ key: 'synthetic-ats-pending' });
        const evidence = new Map([[row.jobkey, evidenceFor(row, {
          finalUrl: 'https://boards.greenhouse.io/example/jobs/synthetic-ats-pending',
        })]]);
        const { result, telemetry, spent } = await runSearch({ canvasFilePath, careerSnapshotId,
          nodeId: 'synthetic-ats-pending-hub', rows: [row], evidence });
        assert.equal(result.success, true, result.error);
        assertSearchSpentNothing(spent, result.jobs);
        assert.equal(result.jobs.length, 1);
        assert.equal(result.jobs[0].listingLiveness?.verdict, 'pending');
        assert.equal(telemetry?.boardClosedDropped || 0, 0);
        assert.equal(telemetry?.reconciliation?.reconciled, true);
      });
    },
  },
  {
    name: 'listing liveness handler: a closed aggregator row with an unsettled saved official search stays held',
    async run() {
      await withSearchHarness(async ({ canvasFilePath, careerSnapshotId }) => {
        const row = withOfficial(job({ key: 'synthetic-unsettled-aggregator', verdict: 'closed', basis: 'closed-marker' }),
          missed(job({ key: 'synthetic-unsettled-aggregator' })));
        const evidence = new Map([[row.jobkey, evidenceFor(row)]]);
        const { result, telemetry, spent } = await runSearch({ canvasFilePath, careerSnapshotId,
          nodeId: 'synthetic-unsettled-aggregator-hub', rows: [row], evidence });
        assert.equal(result.success, true, result.error);
        assertSearchSpentNothing(spent, result.jobs, [row.jobkey]);
        assert.equal(result.jobs.length, 1, 'an unsettled non-ATS row remains available for review');
        assert.equal(result.jobs[0].jobkey, row.jobkey);
        assert.equal(result.jobs[0].listingLiveness?.verdict, 'closed');
        assert.equal(result.jobs[0].officialPosting?.level, 'L5');
        assert.equal(telemetry?.boardClosedDropped || 0, 0);
      });
    },
  },
  {
    name: 'listing liveness handler: a description-less pending closed-marker row is deferred with no AI restamp',
    async run() {
      await withSearchHarness(async ({ canvasFilePath, careerSnapshotId }) => {
        const row = job({ key: 'synthetic-restamped-aside', snippet: '' });
        const evidence = new Map([[row.jobkey, evidenceFor(row, {
          chromeText: `${CLOSED_NOTICE} ${OPEN_NOTICE} ${'Synthetic page controls are visible. '.repeat(5)}`,
        })]]);
        const { result, telemetry, spent } = await runSearch({ canvasFilePath, careerSnapshotId,
          nodeId: 'synthetic-restamped-aside-hub', rows: [row], evidence });
        assert.equal(result.success, true, result.error);
        assertSearchSpentNothing(spent, result.jobs);
        assert.deepEqual(result.jobs, [], 'a pending closed marker with no score-safe text has nothing to score');
        assert.equal(telemetry?.boardClosedDropped, 1);
        assert.equal(telemetry?.reconciliation?.reconciled, true);
      });
    },
  },
  {
    name: 'listing liveness handler: a confirmed-closed row with no description is dropped, a described one is kept unchecked',
    async run() {
      await withSearchHarness(async ({ canvasFilePath, careerSnapshotId }) => {
        const bare = job({ key: 'synthetic-closed-bare', verdict: 'closed', basis: 'structural', snippet: '' });
        const described = job({ key: 'synthetic-closed-described', verdict: 'closed', basis: 'structural' });
        const { result, telemetry, spent } = await runSearch({ canvasFilePath, careerSnapshotId,
          nodeId: 'synthetic-closed-rank-hub', rows: [bare, described] });
        assert.equal(result.success, true, result.error);
        assertSearchSpentNothing(spent, result.jobs);
        assert.deepEqual(result.jobs.map(row => row.jobkey), [described.jobkey]);
        assert.equal(telemetry?.boardClosedDropped, 1);
        assert.equal(telemetry?.officialPosting?.boardClosed?.remoteok?.keptUnchecked, 1);
        assert.equal(telemetry?.officialPosting?.boardClosed?.remoteok?.dropped, 1);
        assert.equal(telemetry?.reconciliation?.reconciled, true);
      });
    },
  },
  {
    name: 'listing liveness handler: settlement read failure preserves set-aside identity in fallback',
    async run() {
      await withSearchHarness(async ({ canvasFilePath, careerSnapshotId }) => {
        const row = job({ key: 'synthetic-fallback-aside', snippet: '' });
        const evidence = new Map([[row.jobkey, evidenceFor(row, {
          chromeText: `${CLOSED_NOTICE} ${OPEN_NOTICE} ${'Synthetic page controls are visible. '.repeat(5)}`,
        })]]);
        let settlementCalls = 0;
        const { result, telemetry, spent } = await runSearch({ canvasFilePath, careerSnapshotId,
          nodeId: 'synthetic-fallback-aside-hub', rows: [row], evidence,
          settleBoardClosedRowsForTests: async () => { settlementCalls += 1; throw new Error('synthetic view failure'); },
        });
        assert.equal(settlementCalls, 1, 'the first settlement pass really failed');
        assert.equal(result.success, true, result.error);
        assertSearchSpentNothing(spent, result.jobs);
        assert.deepEqual(result.jobs, [], 'the fallback still checks the request-local set-aside key');
        assert.equal(telemetry?.boardClosedDropped, 1);
      });
    },
  },
  {
    name: 'listing liveness handler: open dedup winner keeps its own link',
    async run() {
      await withSearchHarness(async ({ canvasFilePath, careerSnapshotId }) => {
        const winner = job({ key: 'synthetic-open-winner', title: 'Synthetic Shared Engineer' });
        const alternate = job({ source: 'weworkremotely', key: 'synthetic-open-alternate', title: winner.title, snippet: '' });
        const evidence = new Map([
          [winner.jobkey, evidenceFor(winner, { chromeText: ACTIVE_NOTICE, closed: false })],
          [alternate.jobkey, evidenceFor(alternate, { chromeText: ACTIVE_NOTICE, closed: false })],
        ]);
        const { result, telemetry, spent } = await runSearch({ canvasFilePath, careerSnapshotId,
          nodeId: 'synthetic-open-winner-hub', rows: [winner, alternate], evidence });
        assert.equal(result.success, true, result.error);
        assertSearchSpentNothing(spent, result.jobs);
        assert.equal(result.jobs.length, 1);
        assert.equal(result.jobs[0].jobkey, winner.jobkey);
        assert.equal(result.jobs[0].url, winner.url);
        assert.deepEqual(result.jobs[0].alternateListings, [{ board: alternate.source, url: alternate.url }],
          'the search seam carries a bounded link to the nonclosed dedup copy');
        assert.equal(telemetry?.officialPosting?.listingLiveness?.weworkremotely?.alternateRestored || 0, 0);
      });
    },
  },
  {
    name: 'listing liveness handler: a closed older row holding a saved live L1-L3 posting stays kept-official',
    async run() {
      for (const level of ['L1', 'L2', 'L3']) await withSearchHarness(async ({ canvasFilePath, careerSnapshotId }) => {
        const row = withOfficial(job({ key: 'synthetic-official-winner', title: 'Synthetic Shared Engineer',
          verdict: 'closed', basis: 'closed-marker' }), { ...found(job({ key: 'synthetic-official-winner' })), level });
        const evidence = new Map([[row.jobkey, evidenceFor(row)]]);
        const { result, telemetry, spent } = await runSearch({ canvasFilePath, careerSnapshotId,
          nodeId: `synthetic-official-winner-${level}-hub`, rows: [row], evidence });
        assert.equal(result.success, true, result.error);
        assertSearchSpentNothing(spent, result.jobs, [row.jobkey]);
        assert.equal(result.jobs.length, 1);
        assert.equal(result.jobs[0].officialPosting?.level, level, `${level} official authority keeps the row`);
        assert.equal(result.jobs[0].listingLiveness?.verdict, 'closed', 'the stored verdict is not rewritten by a search');
        assert.equal(telemetry?.officialPosting?.boardClosed?.remoteok?.keptOfficial, 1);
        assert.equal(telemetry?.boardClosedDropped || 0, 0);
      });
    },
  },
  {
    name: 'listing liveness handler: a closed older row with an ambiguous saved result and text is kept, one without text is deferred',
    async run() {
      await withSearchHarness(async ({ canvasFilePath, careerSnapshotId }) => {
        const ambiguous = { level: 'L5', outcome: 'ambiguous', employer: 'Example Works', trail: ['comparative-disagree'] };
        const withText = withOfficial(job({ key: 'synthetic-ambiguous-text', title: 'Synthetic Ambiguous Text Engineer',
          verdict: 'closed', basis: 'closed-marker' }), ambiguous);
        const bare = withOfficial(job({ key: 'synthetic-ambiguous-bare', title: 'Synthetic Ambiguous Bare Engineer',
          verdict: 'closed', basis: 'closed-marker', snippet: '' }), ambiguous);
        const { result, telemetry, spent } = await runSearch({ canvasFilePath, careerSnapshotId,
          nodeId: 'synthetic-ambiguous-hub', rows: [withText, bare] });
        assert.equal(result.success, true, result.error);
        assertSearchSpentNothing(spent, result.jobs, [withText.jobkey, bare.jobkey]);
        assert.deepEqual(result.jobs.map(row => row.jobkey), [withText.jobkey]);
        assert.equal(result.jobs[0].officialPosting?.outcome, 'ambiguous');
        assert.equal(telemetry?.boardClosedDropped, 1);
        assert.equal(telemetry?.reconciliation?.reconciled, true);
      });
    },
  },
  {
    name: 'listing liveness handler: an open copy beats a closed copy of the same posting and keeps its own text and link',
    async run() {
      await withSearchHarness(async ({ canvasFilePath, careerSnapshotId }) => {
        const closedCopy = job({ key: 'synthetic-own-text-winner', title: 'Synthetic Shared Engineer',
          verdict: 'closed', basis: 'closed-marker' });
        const alternateText = 'Synthetic alternate duties and responsibilities. '.repeat(20);
        const openCopy = job({ source: 'weworkremotely', key: 'synthetic-own-text-alternate',
          title: closedCopy.title, snippet: alternateText, verdict: 'open', basis: 'open-marker',
          extra: { applyOptions: [{ label: 'Apply', href: 'https://careers.example.test/apply/alternate' }] } });
        const evidence = new Map([
          [closedCopy.jobkey, evidenceFor(closedCopy)],
          [openCopy.jobkey, evidenceFor(openCopy, { chromeText: ACTIVE_NOTICE, closed: false })],
        ]);
        const { result, telemetry, spent } = await runSearch({ canvasFilePath, careerSnapshotId,
          nodeId: 'synthetic-own-text-hub', rows: [closedCopy, openCopy], evidence });
        assert.equal(result.success, true, result.error);
        assertSearchSpentNothing(spent, result.jobs);
        assert.equal(result.jobs.length, 1);
        const kept = result.jobs[0];
        assert.equal(kept.source, openCopy.source);
        assert.equal(kept.jobkey, openCopy.jobkey);
        assert.equal(kept.url, openCopy.url);
        assert.equal(kept.snippet, alternateText);
        assert.deepEqual(kept.applyOptions, openCopy.applyOptions);
        assert.equal(kept.listingLiveness?.verdict, 'open');
        assert.equal(kept.alternateListings, undefined, 'a closed copy is never offered as an alternate link');
        assert.equal(telemetry?.officialPosting?.listingLiveness?.weworkremotely?.alternateRestored || 0, 0);
        assert.equal(telemetry?.reconciliation?.reconciled, true);
      });
    },
  },
  {
    name: 'listing liveness handler: a search never audits open-marker rows or demotes a rule',
    async run() {
      await withSearchHarness(async ({ canvasFilePath, careerSnapshotId }) => {
        const ruleId = LISTING_LIVENESS_RULES.generic.openRules[0].id;
        const rows = Array.from({ length: 9 }, (_unused, index) => job({ key: `synthetic-audit-${index + 1}`,
          title: `Synthetic Audit Engineer ${index + 1}`, verdict: 'open', basis: 'open-marker' }));
        const evidence = new Map(rows.map(row => [row.jobkey, evidenceFor(row, {
          chromeText: `${CLOSED_NOTICE} ${OPEN_NOTICE} ${'This synthetic page has a visible apply control. '.repeat(3)}`,
          closed: false, openSignals: [{ ruleId, state: 'active' }],
        })]));
        const writes = [];
        const calibration = {
          async snapshot() { return { rulesFor: key => LISTING_LIVENESS_RULES[key], latestDemotedAt: () => null }; },
          async recordAiAnswer(input) { writes.push(['answer', input]); return { snapshot: {}, promoted: [], demoted: [] }; },
          async demoteRule(input) { writes.push(['demote', input]); return {}; },
          async latestDemotedAt() { return null; },
        };
        const { result, telemetry, spent } = await runSearch({ canvasFilePath, careerSnapshotId,
          nodeId: 'synthetic-audit-hub', rows, evidence, listingLivenessCalibrationStore: calibration });
        assert.equal(result.success, true, result.error);
        assertSearchSpentNothing(spent, result.jobs);
        assert.equal(result.jobs.length, 9);
        assert.ok(result.jobs.every(row => row.listingLiveness?.verdict === 'open' && row.listingLiveness.basis === 'open-marker'),
          'every row keeps its scrape-time open marker');
        assert.deepEqual(writes, [], 'no calibration answer or demotion is written');
        assert.equal(telemetry?.officialPosting?.listingLiveness?.remoteok?.auditChecked || 0, 0);
        assert.equal(telemetry?.reconciliation?.reconciled, true);
      });
    },
  },
  {
    name: 'settle-board-research: rechecks a pending row with a probe and the AI, spares an official posting, an open marker and a low fit',
    async run() {
      await withSearchHarness(async () => {
        const pending = job({ key: 'synthetic-pending', title: 'Synthetic Engineer', extra: { matchScore: 80 } });
        const official = withOfficial(job({ key: 'synthetic-official', title: 'Synthetic Official', basis: 'neither',
          extra: { matchScore: 80 } }), found(job({ key: 'synthetic-official' })));
        const marked = job({ key: 'synthetic-marked', title: 'Synthetic Marked', verdict: 'open', basis: 'open-marker',
          extra: { matchScore: 80 } });
        const low = job({ key: 'synthetic-low', title: 'Synthetic Low', extra: { matchScore: 40 } });
        const evidence = new Map([[pending.url, evidenceFor(pending, { chromeText: ACTIVE_NOTICE, closed: false })],
          [official.url, evidenceFor(official, { closed: false })], [marked.url, evidenceFor(marked, { closed: false })],
          [low.url, evidenceFor(low, { chromeText: ACTIVE_NOTICE, closed: false })]]);
        const { result, spent } = await runBoardResearch({ nodeId: 'synthetic-research-pending',
          jobs: [pending, official, marked, low], evidence });
        assert.equal(result.success, true, result.error);
        assert.deepEqual(spent.visited, [pending.url], 'only the eligible pending row without an official posting is visited');
        assert.equal(spent.liveness, 1);
        const byKey = new Map(result.jobs.map(row => [row.jobkey, row]));
        assert.equal(byKey.get(pending.jobkey).listingLiveness.verdict, 'open');
        assert.equal(byKey.get(pending.jobkey).listingLiveness.basis, 'ai');
        assert.equal(byKey.get(official.jobkey).officialPosting.level, 'L2');
        assert.equal(byKey.get(marked.jobkey).listingLiveness.basis, 'open-marker', 'an open marker is not audited here');
        assert.equal(byKey.get(low.jobkey).listingLiveness.verdict, 'pending', 'a row below the fit threshold is untouched');
        assert.deepEqual([result.counts.livenessVisited, result.counts.livenessRechecked, result.counts.livenessStillPending], [1, 1, 0]);
        assert.deepEqual(result.dropped, []);
      });
    },
  },
  {
    name: 'settle-board-research: an AI-closed ATS-page row is stamped closed from the fresh probe evidence',
    async run() {
      await withSearchHarness(async () => {
        const row = job({ key: 'synthetic-ats-close', extra: { matchScore: 80 } });
        const evidence = new Map([[row.url, evidenceFor(row, {
          finalUrl: 'https://boards.greenhouse.io/example/jobs/synthetic-ats-close',
        })]]);
        const { result, spent } = await runBoardResearch({ nodeId: 'synthetic-research-ats', jobs: [row], evidence,
          callListingLiveness: answer(['closed']) });
        assert.equal(result.success, true, result.error);
        assert.deepEqual(spent.visited, [row.url]);
        assert.equal(spent.liveness, 1);
        const stamped = result.jobs[0];
        assert.equal(stamped.listingLiveness.verdict, 'closed');
        assert.equal(stamped.listingLiveness.basis, 'ai');
        assert.equal(result.counts.livenessRechecked, 1);
      });
    },
  },
  {
    name: 'settle-board-research: a closed row with a settled negative official search is dropped as closed with no liveness AI',
    async run() {
      await withSearchHarness(async () => {
        const settled = withOfficial(job({ key: 'synthetic-settled-negative', verdict: 'closed', basis: 'structural',
          extra: { matchScore: 80, boardClosed: { board: 'remoteok', reason: 'detail-page-not-found', at: AT } } }),
        { level: 'L5', outcome: 'not-found', employer: 'Example Works',
          trail: ['bridge-research', 'closed', OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL] });
        const { result, spent } = await runBoardResearch({ nodeId: 'synthetic-research-settled', jobs: [settled] });
        assert.equal(result.success, true, result.error);
        assert.equal(spent.liveness, 0);
        assert.deepEqual(result.dropped, [{ index: 0, reason: 'closed' }]);
        assert.equal(result.counts.closedDropped, 1);
      });
    },
  },
  {
    name: 'settle-board-research: an AI-closed aggregator with an unsettled official search stays held',
    async run() {
      await withSearchHarness(async () => {
        const row = withOfficial(job({ key: 'synthetic-unsettled-aggregator', extra: { matchScore: 80 } }),
          missed(job({ key: 'synthetic-unsettled-aggregator' })));
        const evidence = new Map([[row.url, evidenceFor(row)]]);
        const { result, spent } = await runBoardResearch({ nodeId: 'synthetic-research-unsettled', jobs: [row], evidence,
          callListingLiveness: answer(['closed']) });
        assert.equal(result.success, true, result.error);
        assert.equal(spent.liveness, 1);
        assert.equal(result.jobs.length, 1);
        assert.equal(result.jobs[0].listingLiveness.verdict, 'closed');
        assert.equal(result.jobs[0].officialPosting.level, 'L5');
        assert.deepEqual(result.dropped, [], 'an unsettled non-ATS row remains available for review');
        assert.equal(result.counts.closedDropped, 0);
      });
    },
  },
  {
    name: 'settle-board-research: a pending row holding a live L1-L3 posting keeps official precedence and is never probed',
    async run() {
      for (const level of ['L1', 'L2', 'L3']) await withSearchHarness(async () => {
        const row = withOfficial(job({ key: 'synthetic-official-winner', title: 'Synthetic Shared Engineer',
          extra: { matchScore: 80 } }), { ...found(job({ key: 'synthetic-official-winner' })), level });
        const evidence = new Map([[row.url, evidenceFor(row)]]);
        const { result, spent } = await runBoardResearch({ nodeId: `synthetic-research-official-${level}`, jobs: [row],
          evidence, callListingLiveness: answer(['open']) });
        assert.equal(result.success, true, result.error);
        assert.deepEqual(spent.visited, [], `${level} official authority skips the probe`);
        assert.equal(spent.liveness, 0, `${level} official authority skips the AI`);
        assert.equal(result.jobs.length, 1);
        assert.equal(result.jobs[0].officialPosting.level, level);
        assert.deepEqual(result.dropped, []);
      });
    },
  },
  {
    name: 'settle-board-research: an AI-open recheck keeps a described row and a closed row with no description is dropped',
    async run() {
      await withSearchHarness(async () => {
        const described = job({ key: 'synthetic-recheck-described', title: 'Synthetic Described', extra: { matchScore: 85 } });
        const bare = job({ key: 'synthetic-recheck-bare', title: 'Synthetic Bare', snippet: '', verdict: 'closed',
          basis: 'structural', extra: { matchScore: 85 } });
        const evidence = new Map([[described.url, evidenceFor(described, { chromeText: ACTIVE_NOTICE, closed: false })]]);
        const { result } = await runBoardResearch({ nodeId: 'synthetic-research-closed-text', jobs: [described, bare], evidence });
        assert.equal(result.success, true, result.error);
        assert.deepEqual(result.dropped, [{ index: 1, reason: 'closed' }]);
        assert.equal(result.jobs[0].listingLiveness.verdict, 'open');
        assert.equal(result.counts.closedDropped, 1);
      });
    },
  },
];
