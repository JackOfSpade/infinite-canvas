import assert from 'node:assert/strict';
import {
  OFFICIAL_POSTING_DISCOVERY_DIAGNOSTIC_LIMIT,
  _resetOfficialPostingDiscoveryDiagnosticsForTests,
  buildOfficialPostingDiscoveryMarkdown,
  finalizeOfficialPostingDiscovery,
  getOfficialPostingDiscoveryDiagnosticsSnapshot,
  officialPostingRenderFailureReason,
  recordOfficialPostingDiscovery,
  recordOfficialPostingSemanticDiscovery,
} from '../../electron/ipc/officialPostingDiscoveryDiagnostics.js';
import { officialPostingSemanticInputHash } from '../../electron/ipc/officialPostingSemantic.js';
import { generateMarkdown } from '../../electron/ipc/bugReport.js';
import { logger } from '../../electron/logger.js';
import { applyBugReportCode, CODE_DEFINITIONS } from '../../src/utils/bugReportCodes.js';

const job = (index = 0) => ({ title: `Synthetic role ${index}`, company: 'Synthetic employer',
  url: `https://listing.example.test/synthetic/${index}`, snippet: `Synthetic source content ${index}.` });
const observation = (extra = {}) => ({ candidateCount: 3, eligibleCount: 1,
  rejected: { 'source-unproven': 2 }, outcome: 'not-found', settled: true, comparisonRuns: 2, ...extra });

function isolated(run) {
  _resetOfficialPostingDiscoveryDiagnosticsForTests();
  try { return run(); }
  finally { _resetOfficialPostingDiscoveryDiagnosticsForTests(); }
}

export default [
  {
    name: 'Official discovery distinguishes empty research from source rejection before comparison',
    run() {
      isolated(() => {
        recordOfficialPostingDiscovery(job(1), observation({ candidateCount: 0, eligibleCount: 0,
          rejected: {}, comparisonRuns: 0 }));
        recordOfficialPostingDiscovery(job(2), observation({ candidateCount: 4, eligibleCount: 0,
          rejected: { 'source-unproven': 2, 'aggregator-source': 1, 'unsafe-url': 1, 'invalid-source': 0 }, comparisonRuns: 0 }));
        recordOfficialPostingDiscovery(job(3), observation());
        recordOfficialPostingDiscovery(job(4), observation({ candidateCount: 2, eligibleCount: 2,
          rejected: {}, outcome: 'unreadable', settled: false, comparisonRuns: 0 }));
        const markdown = buildOfficialPostingDiscoveryMarkdown();
        assert.match(markdown, /zero candidates 1 · candidates without eligible sources 1 · inputs with validated comparisons 1 · settled 3/);
        assert.match(markdown, /candidates 4 · eligible 0 · rejected source-unproven=2, aggregator-source=1, unsafe-url=1, invalid-source=0 · validated comparison runs 0/);
        assert.match(markdown, /validated comparison runs 0 · outcome unreadable · settled no/);
        assert.match(markdown, /not attempted calls, failed responses or research calls/);
        assert.match(markdown, /Captured: \d{4}-\d\d-\d\dT/);
        for (const row of getOfficialPostingDiscoveryDiagnosticsSnapshot().observations) {
          assert.ok(Number.isFinite(Date.parse(row.at)));
        }
      });
    },
  },
  {
    name: 'Official discovery replaces repeated semantic inputs and bounds latest observations to 200',
    run() {
      isolated(() => {
        recordOfficialPostingDiscovery(job(0), observation());
        const expectedFirst = getOfficialPostingDiscoveryDiagnosticsSnapshot().observations[0].input;
        for (let index = 1; index <= OFFICIAL_POSTING_DISCOVERY_DIAGNOSTIC_LIMIT; index++) {
          recordOfficialPostingDiscovery(job(index), observation());
        }
        let snapshot = getOfficialPostingDiscoveryDiagnosticsSnapshot();
        assert.equal(snapshot.observations.length, 200);
        assert.equal(snapshot.observations.some(row => row.input === expectedFirst), false);
        recordOfficialPostingDiscovery({ ...job(1), officialPosting: { outcome: 'found' }, id: 'synthetic-unused-id' },
          observation({ candidateCount: 0, eligibleCount: 0, rejected: {}, comparisonRuns: 0 }));
        snapshot = getOfficialPostingDiscoveryDiagnosticsSnapshot();
        assert.equal(snapshot.observations.length, 200, 'result fields and node identifiers do not create another source input');
        assert.equal(snapshot.observations.at(-1).candidateCount, 0);
        assert.match(buildOfficialPostingDiscoveryMarkdown(), /zero candidates 1/);
        snapshot.observations.at(-1).rejected['source-unproven'] = 99;
        assert.equal(getOfficialPostingDiscoveryDiagnosticsSnapshot().observations.at(-1).rejected['source-unproven'], 0);
      });
    },
  },
  {
    name: 'Official discovery stores only opaque correlation and closed metadata even for hostile arguments',
    run() {
      isolated(() => {
        const source = { ...job(), title: 'PRIVATE_LISTING_TITLE', company: 'PRIVATE_EMPLOYER',
          url: 'https://private.example.test/PRIVATE_SOURCE_ID', snippet: 'PRIVATE_SOURCE_PROSE',
          id: 'PRIVATE_NODE_ID', error: 'PRIVATE_RAW_ERROR' };
        const semanticHash = officialPostingSemanticInputHash(source);
        assert.equal(recordOfficialPostingDiscovery(source, observation({
          candidateCount: 'PRIVATE_COUNT', eligibleCount: -1, comparisonRuns: Infinity,
          outcome: 'PRIVATE_OUTCOME', settled: 'PRIVATE_SETTLED',
          rejected: { 'source-unproven': 2, 'PRIVATE_REASON': 'PRIVATE_DETAIL', 'unsafe-url': 'PRIVATE_URL' },
          candidates: [{ description: 'PRIVATE_CANDIDATE_TEXT' }], inputId: 'PRIVATE_INPUT_ID',
        })), true);
        const snapshot = getOfficialPostingDiscoveryDiagnosticsSnapshot();
        const row = snapshot.observations[0];
        assert.deepEqual(Object.keys(row).sort(), ['at', 'candidateCount', 'comparisonRuns', 'eligibleCount', 'input', 'outcome', 'rejected', 'renderStats', 'semanticSettled', 'settled', 'stage']);
        assert.match(row.input, /^[a-f0-9]{16}$/);
        assert.notEqual(row.input, semanticHash.slice(0, 16), 'correlation does not expose a semantic proof-hash prefix');
        assert.equal(row.candidateCount, null); assert.equal(row.eligibleCount, null);
        assert.equal(row.comparisonRuns, null); assert.equal(row.settled, null); assert.equal(row.outcome, 'unknown');
        assert.deepEqual(Object.keys(row.rejected).sort(), ['aggregator-source', 'invalid-source', 'source-unproven', 'unsafe-url']);
        for (const text of [JSON.stringify(snapshot), buildOfficialPostingDiscoveryMarkdown()]) {
          assert.equal(text.includes('PRIVATE_'), false);
          assert.equal(text.includes('private.example.test'), false);
          assert.equal(text.includes(semanticHash), false);
        }
        const cyclic = {}; cyclic.description = cyclic;
        assert.equal(recordOfficialPostingDiscovery(cyclic, observation()), false);
        assert.equal(recordOfficialPostingDiscovery(null, observation()), false);
        assert.equal(getOfficialPostingDiscoveryDiagnosticsSnapshot().observations.length, 1);
        assert.doesNotThrow(() => recordOfficialPostingDiscovery(job(9), null));
      });
    },
  },
  {
    name: 'Official discovery retains bounded render counts and fixed failure reasons without renderer errors or paths',
    run() {
      isolated(() => {
        for (const code of ['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'ENOENT']) {
          assert.equal(officialPostingRenderFailureReason({ code, message: 'PRIVATE_MODULE_PATH' }), 'renderer-unavailable');
        }
        for (const [error, expected] of [[{ name: 'TimeoutError' }, 'timeout'], [{ cause: { code: 'ETIMEDOUT' } }, 'timeout'],
          [{ code: 'unsafe-address' }, 'unsafe-source'], [{ code: 'oversize' }, 'oversize'],
          [{ code: 'fetch-failed' }, 'fetch-failed'], [{ code: 'PRIVATE_ERROR', message: 'PRIVATE_DETAIL' }, 'other']]) {
          assert.equal(officialPostingRenderFailureReason(error), expected);
        }
        const attempt = recordOfficialPostingSemanticDiscovery(job(), observation());
        finalizeOfficialPostingDiscovery(attempt, { outcome: 'ambiguous', settled: false, renderStats: {
          attempts: 2, successes: 0, cacheReuses: 3, failures: { 'renderer-unavailable': 2,
            timeout: -1, oversize: Infinity, other: Number.MAX_SAFE_INTEGER, PRIVATE_REASON: 'PRIVATE_DETAIL' },
          error: new Error('PRIVATE_MODULE_PATH'), url: 'https://private.example.test/PRIVATE_ID',
        } });
        const snapshot = getOfficialPostingDiscoveryDiagnosticsSnapshot();
        const stats = snapshot.observations[0].renderStats;
        assert.deepEqual(Object.keys(stats).sort(), ['attempts', 'cacheReuses', 'failures', 'successes']);
        assert.deepEqual(stats, { attempts: 2, successes: 0, cacheReuses: 3, failures: {
          'renderer-unavailable': 2, timeout: 0, 'unsafe-source': 0, oversize: 0, 'fetch-failed': 0, other: 1_000_000_000 } });
        stats.failures['renderer-unavailable'] = 99;
        assert.equal(getOfficialPostingDiscoveryDiagnosticsSnapshot().observations[0].renderStats.failures['renderer-unavailable'], 2);
        for (const text of [JSON.stringify(snapshot), buildOfficialPostingDiscoveryMarkdown()]) {
          assert.equal(text.includes('PRIVATE_'), false); assert.equal(text.includes('private.example.test'), false);
        }
        assert.match(buildOfficialPostingDiscoveryMarkdown(), /Rendering: attempts 2 · successes 0 · cache reuses 3 · failures renderer-unavailable=2/);
        recordOfficialPostingDiscovery(job(2), observation({ renderStats: {
          attempts: 'PRIVATE_COUNT', successes: -1, cacheReuses: Infinity, failures: {} } }));
        assert.deepEqual(getOfficialPostingDiscoveryDiagnosticsSnapshot().observations.at(-1).renderStats,
          { attempts: null, successes: null, cacheReuses: null, failures: {
            'renderer-unavailable': 0, timeout: 0, 'unsafe-source': 0, oversize: 0, 'fetch-failed': 0, other: 0 } });
      });
    },
  },
  {
    name: 'Official discovery finalizes only the exact latest semantic attempt without changing its counts',
    run() {
      isolated(() => {
        const older = recordOfficialPostingSemanticDiscovery(job(), observation());
        let row = getOfficialPostingDiscoveryDiagnosticsSnapshot().observations[0];
        assert.equal(row.stage, 'semantic'); assert.equal(row.semanticSettled, true); assert.equal(row.settled, null);
        assert.match(buildOfficialPostingDiscoveryMarkdown(), /settled pending · stage semantic · semantic settled yes/);
        const latest = recordOfficialPostingSemanticDiscovery(job(), observation({ candidateCount: 0,
          eligibleCount: 0, rejected: {}, comparisonRuns: 0 }));
        assert.equal(finalizeOfficialPostingDiscovery(older, { outcome: 'found', settled: true }), false);
        assert.equal(finalizeOfficialPostingDiscovery({}, { outcome: 'found', settled: true }), false);
        assert.equal(finalizeOfficialPostingDiscovery(latest, { outcome: 'not-found', settled: false }), true);
        row = getOfficialPostingDiscoveryDiagnosticsSnapshot().observations[0];
        assert.equal(row.stage, 'final'); assert.equal(row.semanticSettled, true); assert.equal(row.settled, false);
        assert.equal(row.candidateCount, 0); assert.equal(row.eligibleCount, 0); assert.equal(row.comparisonRuns, 0);
        assert.equal(finalizeOfficialPostingDiscovery(latest, { outcome: 'found', settled: true }), false);
        assert.match(buildOfficialPostingDiscoveryMarkdown(), /outcome not-found · settled no · stage final · semantic settled yes/);
      });
    },
  },
  {
    name: 'Official discovery empty process explicitly declines prior-process reconstruction',
    run() {
      isolated(() => {
        const markdown = buildOfficialPostingDiscoveryMarkdown();
        assert.match(markdown, /No discovery observation retained in this process/);
        assert.match(markdown, /No prior-process reconstruction is available after a restart/);
        assert.match(markdown, /Saved card outcomes do not reconstruct/);
      });
    },
  },
  {
    name: 'FULL and OFFDISC reports include discovery metadata and focused official-posting logs',
    run() {
      isolated(() => {
        recordOfficialPostingDiscovery(job(), observation());
        const logs = Array.from({ length: 20 }, (_, index) => `Synthetic unrelated renderer event ${index}`);
        logs[10] = 'Synthetic official-posting discovery marker';
        const filter = applyBugReportCode(logs, {}, 'OFFDISC');
        assert.deepEqual(filter.unknownCodes, []);
        assert.ok(filter.sectionExclusions.has('nodes'));
        assert.ok(filter.filteredLogs.includes(logs[10]) && filter.filteredLogs.length < logs.length);
        assert.equal(CODE_DEFINITIONS.OFFDISC.logFilter('Synthetic unrelated marker'), false);
        logger.info('Synthetic official-posting main discovery marker');
        logger.info('Synthetic unrelated main discovery marker');
        const base = { description: 'Synthetic discovery report', nodes: [], edges: [], drawings: [],
          frontEndState: {}, eventLogs: [] };
        for (const filterCode of ['FULL', 'OFFDISC', 'FULL+OFFDISC']) {
          const report = generateMarkdown({ ...base, filterCode }).markdown;
          assert.ok(report.includes('Official Posting Discovery Diagnostics (OFFDISC)'));
          assert.ok(report.includes('candidates 3 · eligible 1') && report.includes('validated comparison runs 2'));
          assert.ok(report.includes('Synthetic official-posting main discovery marker'));
          assert.equal(report.includes('Synthetic unrelated main discovery marker'), filterCode !== 'OFFDISC');
        }
        assert.equal(generateMarkdown({ ...base, filterCode: 'JOBPAY' }).markdown.includes('Official Posting Discovery Diagnostics (OFFDISC)'), false);
        const full = applyBugReportCode(logs, {}, 'FULL+OFFDISC');
        assert.deepEqual(full.filteredLogs, logs, 'the focused lens never narrows FULL');
      });
    },
  },
];
