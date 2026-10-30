import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ipcMain } from 'electron';
import { __registerJobsHandlersForTests, getJobsTelemetry, registerJobsHandlers } from '../../electron/ipc/jobs.js';
import { claimJobAnalysisOperationAuthority } from '../../electron/ipc/jobAnalysisOperationAuthorityStore.js';
import { finalizeListingEvidence, LISTING_LIVENESS_RULES } from '../../electron/ipc/listingLiveness.js';
import { memoListingVerdict, recordListingEvidence, recordOfficialExpiryCandidates } from '../../electron/ipc/listingLivenessStore.js';
import { writeApprovedCareerSnapshotFixture } from './careerSnapshotFixture.mjs';
import { officialPostingSemanticInputHash } from '../../electron/ipc/officialPostingSemantic.js';
import { OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL } from '../../electron/ipc/officialPostingNegativePolicy.js';

const AT = '2026-10-25T12:00:00.000Z';
const DESCRIPTION = 'Build reliable platform services, review incidents, and document service recovery with the engineering team. '.repeat(8);
const CLOSED_NOTICE = 'This posting has closed.';
const OPEN_NOTICE = 'Applications are open.';
const linked = () => ({ enabled: true, link: { state: 'linked' }, chat: { pool: { active: false } } });
const unlinked = () => ({ enabled: true, link: { state: 'unlinked' }, chat: { pool: { active: false } } });

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
  officialPosting = missed, callListingLiveness, handoffBridgeStatus = linked,
  listingLivenessCalibrationStore, settleBoardClosedRowsForTests, memos = new Map(), expiryCandidatesForRow = null } = {}) {
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
        for (const row of jobs) {
          const captured = evidence.get(row.jobkey);
          if (captured) assert.equal(recordListingEvidence(row, captured), true, 'the provider callback has the IPC evidence context');
          if (memos.has(row.jobkey)) memoListingVerdict(row, memos.get(row.jobkey));
        }
        const result = { sourceId, jobs, gathered: jobs.length };
        await args[11](sourceId, result);
        await args[8]({ sourceId, query: 'synthetic engineer', page: 1, jobs });
        results.push(result);
      }
      return results;
    },
    resolveOfficialPostings: async jobs => ({ jobs: jobs.map(row => {
      const posting = officialPosting(row);
      return { ...row, officialPosting: { ...posting, trail: [...(posting.trail || []), 'semantic-match-v1'],
        semanticMatch: { version: 1, inputHash: officialPostingSemanticInputHash(row),
          ...(['L1', 'L2', 'L3', 'L4'].includes(posting.level) ? { sourceHash: 'b'.repeat(64) } : {}) } } };
    }),
      expiryCandidates: jobs.map(row => {
        const candidates = expiryCandidatesForRow?.(row) || [];
        if (candidates.length) assert.equal(recordOfficialExpiryCandidates(row, candidates), true);
        return candidates.map(candidate => candidate.url);
      }), telemetry: { total: jobs.length } }),
    getOfficialPostingView: async row => ({ description: '', officialPosting: row.officialPosting }),
    callListingLiveness,
    handoffBridgeStatus,
    ...(listingLivenessCalibrationStore ? { listingLivenessCalibrationStore } : {}),
    ...(settleBoardClosedRowsForTests ? { settleBoardClosedRowsForTests } : {}),
  });
  const sender = { id: 71949, isDestroyed: () => false, once() {}, on() {}, removeListener() {}, send() {} };
  const result = await ipcMain.__getInvokeHandler('search-jobs')({ sender }, {
    queries: ['synthetic engineer'], nodeId, canvasFilePath, careerSnapshotId, operationAuthority: authority.receipt,
    enabledSourceIds: [...bySource.keys()], targetRole: '', preferredLocation: '',
  });
  return { result, telemetry: getJobsTelemetry().search };
}

function answer(verdicts) {
  return async (_prompt, options) => options.responseValidator({ rows: verdicts.map((verdict, index) => ({
    id: `r${index + 1}`, verdict, quote: verdict === 'closed' ? CLOSED_NOTICE : verdict === 'open' ? OPEN_NOTICE : '',
  })) });
}

export default [
  {
    name: 'deferred expiry search requires candidate AI confirmation before settled board retirement and reports counts only',
    async run() {
      await withSearchHarness(async ({ canvasFilePath, careerSnapshotId }) => {
        const states = ['closed', 'open', 'unclear'];
        const rows = states.map(state => job({ key: `synthetic-expiry-${state}`,
          title: `Synthetic ${state} Expiry Engineer`, verdict: 'closed', basis: 'structural',
          extra: { boardClosed: { board: 'remoteok', reason: 'detail-page-not-found', at: AT } } }));
        const candidateFor = target => {
          const url = `https://careers.example.test/jobs/${target.jobkey}`;
          const notice = target.title.includes('closed') ? CLOSED_NOTICE : OPEN_NOTICE;
          return [{ url, evidence: finalizeListingEvidence({ board: 'generic', ruleKey: 'generic',
            requestedUrl: url, finalUrl: url, httpStatus: 200, title: target.title, h1: target.title,
            expectedTitle: target.title, expectedCompany: target.company, expectedLocation: target.location,
            chromeText: `${notice} ${'This synthetic role has a visible posting page. '.repeat(5)}`,
            descriptionText: target.snippet, descriptionIsPage: false,
            closedHits: [], openSignals: [], jsonLd: { validThrough: '2000-01-01T00:00:00Z', isListed: null },
          }) }];
        };
        let calls = 0;
        const { result, telemetry } = await runSearch({ canvasFilePath, careerSnapshotId,
          nodeId: 'synthetic-expiry-confirmation-hub', rows,
          officialPosting: target => ({ level: 'L5', outcome: 'not-found', employer: target.company,
            trail: ['bridge-research', 'closed', OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL] }), expiryCandidatesForRow: candidateFor,
          callListingLiveness: async (_prompt, options) => {
            calls++;
            return options.responseValidator({ rows: states.map((state, index) => ({ id: `r${index + 1}`,
              verdict: state, quote: state === 'closed' ? CLOSED_NOTICE : state === 'open' ? OPEN_NOTICE : '' })) });
          },
        });
        assert.equal(result.success, true, result.error);
        assert.equal(calls, 1);
        assert.deepEqual(result.jobs.map(item => item.jobkey).sort(), rows.slice(1).map(item => item.jobkey).sort());
        assert.equal(telemetry?.officialPosting?.listingLiveness?.remoteok?.expiryOnlyClosedCopies, 3);
        assert.equal(telemetry?.officialPosting?.listingLiveness?.remoteok?.expiryCandidatesConfirmedClosed, 1);
        assert.equal(telemetry?.officialPosting?.listingLiveness?.remoteok?.expiryCandidatesNotConfirmed, 2);
        assert.equal(telemetry?.boardClosedDropped, 1);
      });
    },
  },
  {
    name: 'listing liveness handler: linked single chat checks pending L5 while unlinked leaves it pending',
    async run() {
      for (const [name, status, expectedCalls, expectedVerdict] of [
        ['linked', linked, 1, 'open'], ['unlinked', unlinked, 0, 'pending'],
      ]) await withSearchHarness(async ({ canvasFilePath, careerSnapshotId }) => {
        const pending = job({ key: `synthetic-${name}-pending`, title: `Synthetic ${name} Engineer` });
        const official = job({ key: `synthetic-${name}-official`, title: `Synthetic ${name} Official`, basis: 'neither' });
        const evidence = new Map([[pending.jobkey, evidenceFor(pending, {
          chromeText: `${OPEN_NOTICE} ${'This synthetic job is accepting applications. '.repeat(4)}`, closed: false,
        })], [official.jobkey, evidenceFor(official, { closed: false })]]);
        let calls = 0;
        const { result, telemetry } = await runSearch({ canvasFilePath, careerSnapshotId,
          nodeId: `synthetic-liveness-${name}`, rows: [pending, official], evidence,
          officialPosting: row => row.jobkey === official.jobkey ? found(row) : missed(row),
          handoffBridgeStatus: status,
          callListingLiveness: async (...args) => { calls += 1; return answer(['open'])(...args); },
        });
        assert.equal(result.success, true, result.error);
        assert.equal(calls, expectedCalls);
        assert.equal(result.jobs.find(row => row.jobkey === pending.jobkey)?.listingLiveness?.verdict, expectedVerdict);
        assert.equal(result.jobs.find(row => row.jobkey === official.jobkey)?.officialPosting?.level, 'L2');
        assert.equal(telemetry?.officialPosting?.listingLiveness?.remoteok?.aiSkippedOfficial, 1);
        assert.equal(telemetry?.reconciliation?.reconciled, true);
      });
    },
  },
  {
    name: 'listing liveness handler: AI-confirmed ATS closure drops with a receipted conserved funnel',
    async run() {
      await withSearchHarness(async ({ canvasFilePath, careerSnapshotId }) => {
        const row = job({ key: 'synthetic-ats-close' });
        const evidence = new Map([[row.jobkey, evidenceFor(row, {
          finalUrl: 'https://boards.greenhouse.io/example/jobs/synthetic-ats-close',
        })]]);
        let calls = 0;
        const { result, telemetry } = await runSearch({ canvasFilePath, careerSnapshotId,
          nodeId: 'synthetic-ats-close-hub', rows: [row], evidence,
          callListingLiveness: async (...args) => { calls += 1; return answer(['closed'])(...args); },
        });
        assert.equal(result.success, true, result.error);
        assert.equal(calls, 1);
        assert.deepEqual(result.jobs, []);
        assert.equal(telemetry?.boardClosedDropped, 1);
        assert.equal(telemetry?.officialPosting?.listingLiveness?.remoteok?.droppedOfficialClosed, 1);
        assert.equal(telemetry?.reconciliation?.reconciled, true);
      });
    },
  },
  {
    name: 'listing liveness handler: an AI-closed aggregator with unsettled official search stays held',
    async run() {
      await withSearchHarness(async ({ canvasFilePath, careerSnapshotId }) => {
        const row = job({ key: 'synthetic-unsettled-aggregator' });
        const evidence = new Map([[row.jobkey, evidenceFor(row)]]);
        const { result, telemetry } = await runSearch({ canvasFilePath, careerSnapshotId,
          nodeId: 'synthetic-unsettled-aggregator-hub', rows: [row], evidence,
          callListingLiveness: answer(['closed']),
        });
        assert.equal(result.success, true, result.error);
        assert.equal(result.jobs.length, 1, 'an unsettled non-ATS row remains available for review');
        assert.equal(result.jobs[0].jobkey, row.jobkey);
        assert.equal(result.jobs[0].listingLiveness?.verdict, 'closed');
        assert.equal(result.jobs[0].officialPosting?.level, 'L5');
        assert.equal(telemetry?.boardClosedDropped || 0, 0);
      });
    },
  },
  {
    name: 'listing liveness handler: a description-less set-aside stays deferred after an AI open restamp',
    async run() {
      await withSearchHarness(async ({ canvasFilePath, careerSnapshotId }) => {
        const row = job({ key: 'synthetic-restamped-aside', snippet: '' });
        const evidence = new Map([[row.jobkey, evidenceFor(row, {
          chromeText: `${CLOSED_NOTICE} ${OPEN_NOTICE} ${'Synthetic page controls are visible. '.repeat(5)}`,
        })]]);
        const { result, telemetry } = await runSearch({ canvasFilePath, careerSnapshotId,
          nodeId: 'synthetic-restamped-aside-hub', rows: [row], evidence,
          callListingLiveness: answer(['open']),
        });
        assert.equal(result.success, true, result.error);
        assert.deepEqual(result.jobs, [], 'an open verdict does not supply the missing score-safe text');
        assert.equal(telemetry?.boardClosedDropped, 1);
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
        const { result, telemetry } = await runSearch({ canvasFilePath, careerSnapshotId,
          nodeId: 'synthetic-fallback-aside-hub', rows: [row], evidence,
          callListingLiveness: answer(['open']),
          settleBoardClosedRowsForTests: async () => { settlementCalls += 1; throw new Error('synthetic view failure'); },
        });
        assert.equal(settlementCalls, 1, 'the first settlement pass really failed');
        assert.equal(result.success, true, result.error);
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
          [winner.jobkey, evidenceFor(winner, { chromeText: `${OPEN_NOTICE} ${'This synthetic job is accepting applications. '.repeat(4)}`, closed: false })],
          [alternate.jobkey, evidenceFor(alternate, { chromeText: `${OPEN_NOTICE} ${'This synthetic job is accepting applications. '.repeat(4)}`, closed: false })],
        ]);
        let calls = 0;
        const { result, telemetry } = await runSearch({ canvasFilePath, careerSnapshotId,
          nodeId: 'synthetic-open-winner-hub', rows: [winner, alternate], evidence,
          callListingLiveness: async (...args) => { calls += 1; return answer(['open'])(...args); },
        });
        assert.equal(result.success, true, result.error);
        assert.equal(result.jobs.length, 1);
        assert.equal(result.jobs[0].jobkey, winner.jobkey);
        assert.equal(result.jobs[0].url, winner.url);
        assert.deepEqual(result.jobs[0].alternateListings, [{ board: alternate.source, url: alternate.url }],
          'the search seam carries a bounded link to the nonclosed dedup copy');
        assert.equal(calls, 1);
        assert.equal(telemetry?.officialPosting?.listingLiveness?.weworkremotely?.alternateRestored || 0, 0);
      });
    },
  },
  {
    name: 'listing liveness handler: closed winner with live L1-L3 posting retains official precedence',
    async run() {
      for (const level of ['L1', 'L2', 'L3']) await withSearchHarness(async ({ canvasFilePath, careerSnapshotId }) => {
        const winner = job({ key: 'synthetic-official-winner', title: 'Synthetic Shared Engineer' });
        const alternate = job({ source: 'weworkremotely', key: 'synthetic-official-alternate', title: winner.title, snippet: '' });
        const evidence = new Map([
          [winner.jobkey, evidenceFor(winner)],
          [alternate.jobkey, evidenceFor(alternate, { chromeText: `${OPEN_NOTICE} ${'This synthetic job is accepting applications. '.repeat(4)}`, closed: false })],
        ]);
        let calls = 0;
        const { result, telemetry } = await runSearch({ canvasFilePath, careerSnapshotId,
          nodeId: `synthetic-official-winner-${level}-hub`, rows: [winner, alternate], evidence,
          officialPosting: row => row.jobkey === winner.jobkey ? { ...found(row), level } : missed(row),
          memos: new Map([[winner.jobkey, 'closed']]),
          callListingLiveness: async (...args) => { calls += 1; return answer(['open'])(...args); },
        });
        assert.equal(result.success, true, result.error);
        assert.equal(result.jobs.length, 1);
        assert.equal(result.jobs[0].jobkey, winner.jobkey);
        assert.equal(result.jobs[0].officialPosting?.level, level);
        assert.equal(calls, 0, `${level} official authority skips the AI and alternate`);
        assert.equal(telemetry?.officialPosting?.listingLiveness?.weworkremotely?.alternateRestored || 0, 0);
      });
    },
  },
  {
    name: 'listing liveness handler: ambiguous official result still tries an open alternate',
    async run() {
      await withSearchHarness(async ({ canvasFilePath, careerSnapshotId }) => {
        const winner = job({ key: 'synthetic-ambiguous-winner', title: 'Synthetic Shared Engineer' });
        const alternate = job({ source: 'weworkremotely', key: 'synthetic-ambiguous-alternate',
          title: winner.title, snippet: '' });
        const evidence = new Map([
          [winner.jobkey, evidenceFor(winner)],
          [alternate.jobkey, evidenceFor(alternate, {
            chromeText: `${OPEN_NOTICE} ${'Synthetic application controls remain available. '.repeat(4)}`, closed: false,
          })],
        ]);
        let calls = 0;
        const { result, telemetry } = await runSearch({ canvasFilePath, careerSnapshotId,
          nodeId: 'synthetic-ambiguous-alternate-hub', rows: [winner, alternate], evidence,
          officialPosting: row => row.jobkey === winner.jobkey
            ? { level: 'L5', outcome: 'ambiguous', employer: row.company, trail: ['comparative-disagree'] } : missed(row),
          memos: new Map([[winner.jobkey, 'closed']]),
          callListingLiveness: async (...args) => { calls += 1; return answer(['open'])(...args); },
        });
        assert.equal(result.success, true, result.error);
        assert.equal(result.jobs.length, 1);
        assert.equal(result.jobs[0].jobkey, alternate.jobkey);
        assert.equal(calls, 1, 'the alternate is checked once after the ambiguous official result');
        assert.equal(telemetry?.officialPosting?.listingLiveness?.weworkremotely?.alternateRestored, 1);
      });
    },
  },
  {
    name: 'listing liveness handler: open alternate retains its own score-safe description',
    async run() {
      await withSearchHarness(async ({ canvasFilePath, careerSnapshotId }) => {
        const winner = job({ key: 'synthetic-own-text-winner', title: 'Synthetic Shared Engineer' });
        const alternateText = 'Synthetic alternate duties and responsibilities. '.repeat(20);
        const alternate = job({ source: 'weworkremotely', key: 'synthetic-own-text-alternate',
          title: winner.title, snippet: alternateText });
        const evidence = new Map([
          [winner.jobkey, evidenceFor(winner)],
          [alternate.jobkey, evidenceFor(alternate, { chromeText: `${OPEN_NOTICE} ${'This synthetic job is accepting applications. '.repeat(4)}`, closed: false })],
        ]);
        let calls = 0;
        const { result } = await runSearch({ canvasFilePath, careerSnapshotId,
          nodeId: 'synthetic-own-text-hub', rows: [winner, alternate], evidence,
          callListingLiveness: async (...args) => { calls += 1; return answer([calls === 1 ? 'closed' : 'open'])(...args); },
        });
        assert.equal(result.success, true, result.error);
        assert.equal(result.jobs.length, 1);
        assert.equal(result.jobs[0].jobkey, alternate.jobkey);
        assert.equal(result.jobs[0].snippet, alternateText);
      });
    },
  },
  {
    name: 'listing liveness handler: a closed dedup winner restores its open cross-source alternate',
    async run() {
      await withSearchHarness(async ({ canvasFilePath, careerSnapshotId }) => {
        const winner = job({ key: 'synthetic-duplicate-winner', title: 'Synthetic Shared Engineer' });
        const alternate = job({ source: 'weworkremotely', key: 'synthetic-duplicate-alternate', title: winner.title,
          snippet: '', extra: { applyOptions: [{ label: 'Apply', href: 'https://careers.example.test/apply/alternate' }] } });
        const evidence = new Map([
          [winner.jobkey, evidenceFor(winner)],
          [alternate.jobkey, evidenceFor(alternate, {
            chromeText: `${OPEN_NOTICE} ${'This synthetic job is accepting applications. '.repeat(4)}`, closed: false,
          })],
        ]);
        let calls = 0;
        const { result, telemetry } = await runSearch({ canvasFilePath, careerSnapshotId,
          nodeId: 'synthetic-alternate-hub', rows: [winner, alternate], evidence,
          callListingLiveness: async (...args) => { calls += 1; return answer([calls === 1 ? 'closed' : 'open'])(...args); },
        });
        assert.equal(result.success, true, result.error);
        assert.equal(calls, 2, 'the pending alternate is asked in a second round under the same search');
        assert.equal(result.jobs.length, 1);
        const restored = result.jobs[0];
        assert.equal(restored.source, alternate.source);
        assert.equal(restored.jobkey, alternate.jobkey);
        assert.equal(restored.url, alternate.url);
        assert.deepEqual(restored.applyOptions, alternate.applyOptions);
        assert.equal(restored.listingLiveness?.verdict, 'open');
        assert.equal(restored.officialPosting?.level, 'L5');
        assert.equal(restored.snippet, winner.snippet, 'the score-safe winner text is lent only because the alternate had none');
        assert.equal(telemetry?.officialPosting?.listingLiveness?.weworkremotely?.alternateRestored, 1);
        assert.equal(telemetry?.boardClosedDropped || 0, 0);
        assert.equal(telemetry?.reconciliation?.reconciled, true);
      });
    },
  },
  {
    name: 'listing liveness handler: a closed active-rule audit demotes and rechecks the remaining board candidates',
    async run() {
      await withSearchHarness(async ({ canvasFilePath, careerSnapshotId }) => {
        const ruleId = LISTING_LIVENESS_RULES.generic.openRules[0].id;
        const rows = Array.from({ length: 9 }, (_, index) => job({ key: `synthetic-audit-${index + 1}`,
          title: `Synthetic Audit Engineer ${index + 1}`, verdict: 'open', basis: 'open-marker' }));
        const evidence = new Map(rows.map(row => [row.jobkey, evidenceFor(row, {
          chromeText: `${CLOSED_NOTICE} ${OPEN_NOTICE} ${'This synthetic page has a visible apply control. '.repeat(3)}`,
          closed: false, openSignals: [{ ruleId, state: 'active' }],
        })]));
        const demotions = []; const calls = [];
        const calibration = {
          async snapshot() { return { rulesFor: key => LISTING_LIVENESS_RULES[key], latestDemotedAt: () => null }; },
          async recordAiAnswer() { return { snapshot: {}, promoted: [], demoted: [] }; },
          async demoteRule(input) { demotions.push(input); return {}; },
          async latestDemotedAt() { return null; },
        };
        const { result, telemetry } = await runSearch({ canvasFilePath, careerSnapshotId,
          nodeId: 'synthetic-audit-hub', rows, evidence, listingLivenessCalibrationStore: calibration,
          callListingLiveness: async (prompt, options) => {
            calls.push({ prompt, hints: options.hints });
            const verdicts = calls.length === 1 ? ['closed', 'open'] : Array(options.hints.itemCount).fill('unclear');
            return answer(verdicts)(prompt, options);
          },
        });
        assert.equal(result.success, true, result.error);
        assert.equal(calls.length, 2, 'the disagreement forces a second round for the other candidates');
        assert.equal(calls[0].hints.itemCount, 2, 'sorted first and every eighth candidate are audited');
        assert.equal(calls[1].hints.itemCount, 8);
        assert.equal(demotions.length, 1);
        assert.equal(demotions[0].ruleId, ruleId);
        assert.equal(demotions[0].ruleKey, 'generic');
        assert.ok(Number(demotions[0].suspendedUntil) >= Date.now() + 6 * 24 * 60 * 60 * 1000);
        assert.equal(telemetry?.officialPosting?.listingLiveness?.remoteok?.auditChecked, 10);
        assert.equal(telemetry?.officialPosting?.listingLiveness?.remoteok?.auditDisagreed, 1);
        assert.equal(telemetry?.officialPosting?.listingLiveness?.remoteok?.ruleDemoted, 1);
        assert.equal(telemetry?.reconciliation?.reconciled, true);
      });
    },
  },
];
