import assert from 'node:assert/strict';
import {
  OFFICIAL_POSTING_DISCOVERY_DIAGNOSTIC_LIMIT,
  _resetOfficialPostingDiscoveryDiagnosticsForTests,
  buildOfficialPostingDiscoveryMarkdown,
  getOfficialPostingDiscoveryDiagnosticsSnapshot,
  officialPostingHandoffFailureCause,
  officialPostingHandoffFailureCode,
  recordOfficialPostingAvailabilityDecision,
  recordOfficialPostingDiscovery,
  recordOfficialPostingPlannerTransition,
} from '../../electron/ipc/officialPostingDiscoveryDiagnostics.js';
import { officialPostingSemanticInputHash } from '../../electron/ipc/officialPostingSemantic.js';
import { generateMarkdown } from '../../electron/ipc/bugReport.js';
import { logger } from '../../electron/logger.js';
import { applyBugReportCode, CODE_DEFINITIONS } from '../../src/utils/bugReportCodes.js';

const job = (index = 0) => ({ title: `Synthetic role ${index}`, company: 'Synthetic employer',
  url: `https://listing.example.test/synthetic/${index}`, snippet: `Synthetic source content ${index}.` });
const observation = (extra = {}) => ({ candidateCount: 3, outcome: 'not-found', settled: true, comparisonRuns: 2, ...extra });

function isolated(run) {
  _resetOfficialPostingDiscoveryDiagnosticsForTests();
  try { return run(); }
  finally { _resetOfficialPostingDiscoveryDiagnosticsForTests(); }
}

export default [
  {
    name: 'Official discovery separates empty research from validated comparisons',
    run() {
      isolated(() => {
        recordOfficialPostingDiscovery(job(1), observation({ candidateCount: 0, comparisonRuns: 0 }));
        recordOfficialPostingDiscovery(job(2), observation({ candidateCount: 4, comparisonRuns: 0 }));
        recordOfficialPostingDiscovery(job(3), observation());
        recordOfficialPostingDiscovery(job(4), observation({ candidateCount: 2, outcome: 'unreadable', settled: false, comparisonRuns: 0 }));
        const markdown = buildOfficialPostingDiscoveryMarkdown();
        assert.match(markdown, /zero candidates 1 · inputs with validated comparisons 1 · settled 3/);
        assert.match(markdown, /candidates 4 · validated comparison runs 0/);
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
          observation({ candidateCount: 0, comparisonRuns: 0 }));
        snapshot = getOfficialPostingDiscoveryDiagnosticsSnapshot();
        assert.equal(snapshot.observations.length, 200, 'result fields and node identifiers do not create another source input');
        assert.equal(snapshot.observations.at(-1).candidateCount, 0);
        assert.match(buildOfficialPostingDiscoveryMarkdown(), /zero candidates 1/);
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
          candidateCount: 'PRIVATE_COUNT', comparisonRuns: Infinity,
          outcome: 'PRIVATE_OUTCOME', settled: 'PRIVATE_SETTLED',
          candidates: [{ description: 'PRIVATE_CANDIDATE_TEXT' }], inputId: 'PRIVATE_INPUT_ID',
        })), true);
        const snapshot = getOfficialPostingDiscoveryDiagnosticsSnapshot();
        const row = snapshot.observations[0];
        assert.deepEqual(Object.keys(row).sort(), ['at', 'candidateCount', 'chatStats', 'comparisonRuns', 'failureCodes', 'input', 'outcome', 'resolutionReasons', 'settled']);
        assert.match(row.input, /^[a-f0-9]{16}$/);
        assert.notEqual(row.input, semanticHash.slice(0, 16), 'correlation does not expose a semantic proof-hash prefix');
        assert.equal(row.candidateCount, null);
        assert.equal(row.comparisonRuns, null); assert.equal(row.settled, null); assert.equal(row.outcome, 'unknown');
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
    name: 'Official discovery chat counts retain only bounded fixed metadata and isolate returned snapshots',
    run() {
      isolated(() => {
        recordOfficialPostingDiscovery(job(), observation({ outcome: 'link-only',
          resolutionReasons: ['source-unproven', 'source-unproven', 'PRIVATE_ERROR', 'https://private.example.test/PRIVATE_ID', 'comparative-match'], chatStats: {
          finderCalls: 1, judgeRounds: 2, judgeCalls: 5, snapshotReads: -1,
          snapshotFailures: Number.MAX_SAFE_INTEGER, truncatedSnapshots: 'PRIVATE_COUNT',
          sourceUrl: 'https://private.example.test/PRIVATE_ID', error: 'PRIVATE_ERROR',
        } }));
        const snapshot = getOfficialPostingDiscoveryDiagnosticsSnapshot();
        assert.deepEqual(snapshot.observations[0].chatStats, { finderCalls: 1, judgeRounds: 2, judgeCalls: 5,
          snapshotReads: null, snapshotFailures: 1_000_000_000, truncatedSnapshots: null });
        assert.deepEqual(snapshot.observations[0].resolutionReasons, ['source-unproven']);
        snapshot.observations[0].resolutionReasons.push('PRIVATE_MUTATION');
        assert.deepEqual(getOfficialPostingDiscoveryDiagnosticsSnapshot().observations[0].resolutionReasons, ['source-unproven']);
        snapshot.observations[0].chatStats.finderCalls = 99;
        assert.equal(getOfficialPostingDiscoveryDiagnosticsSnapshot().observations[0].chatStats.finderCalls, 1);
        const markdown = buildOfficialPostingDiscoveryMarkdown();
        assert.match(markdown, /Chat discovery: finder calls 1 · judge rounds 2 · judge calls 5/);
        assert.match(markdown, /outcome link-only/);
        assert.match(markdown, /Chat resolution reasons: source-unproven/);
        assert.match(markdown, /not transport-owned correction attempts/);
        for (const text of [JSON.stringify(getOfficialPostingDiscoveryDiagnosticsSnapshot()), markdown]) {
          assert.equal(text.includes('PRIVATE_'), false);
          assert.equal(text.includes('private.example.test'), false);
        }
      });
    },
  },
  {
    name: 'Official discovery distinguishes handoff infrastructure and validation with closed error classes',
    run() {
      isolated(() => {
        for (const [code, expected] of [
          ['BRIDGE_WORKER_LOST', 'worker-lost'], ['BRIDGE_WORKER_REPLACED', 'worker-replaced'],
          ['BRIDGE_COMPARISON_CONTAMINATED', 'comparison-contaminated'], ['BRIDGE_FRESH_CONTEXT_REQUIRED', 'fresh-context-required'],
          ['BRIDGE_REQUEUE_EXHAUSTED', 'requeue-exhausted'], ['BRIDGE_RENDERER_UNAVAILABLE', 'renderer-unavailable'],
          ['IPC_SENDER_DESTROYED', 'sender-destroyed'], ['IPC_RENDERER_STOPPED', 'renderer-stopped'],
          ['IPC_RENDERER_NAVIGATED', 'renderer-navigated'], ['IPC_REQUEST_TIMEOUT', 'request-timeout'],
          ['OFFICIAL_POSTING_COMPARATIVE_INVALID', 'comparative-invalid'], ['bridge-aborted', 'bridge-aborted'],
        ]) {
          const error = Object.assign(new Error('PRIVATE_PROMPT_AND_ERROR'), { code });
          assert.equal(officialPostingHandoffFailureCode(error), expected);
          const controller = new AbortController(); controller.abort(error);
          assert.equal(officialPostingHandoffFailureCode(new Error('PRIVATE_WRAPPER'), controller.signal), expected);
        }
        assert.equal(officialPostingHandoffFailureCode(new TypeError('PRIVATE_DETAILS')), 'type-error');
        assert.equal(officialPostingHandoffFailureCode(new SyntaxError('PRIVATE_DETAILS')), 'syntax-error');
        assert.equal(officialPostingHandoffFailureCode({ code: 'PRIVATE_CODE', name: 'PRIVATE_NAME' }), 'unexpected-error');
        assert.equal(officialPostingHandoffFailureCode({ name: '__proto__' }), 'unexpected-error');
        assert.equal(officialPostingHandoffFailureCause({ recoveryCode: 'BRIDGE_WORKER_LOST' }), 'worker-lost');
        assert.equal(officialPostingHandoffFailureCause({ recoveryCode: 'PRIVATE_CAUSE' }), null);
        recordOfficialPostingDiscovery(job(), observation({ failureCodes: ['worker-lost', 'comparative-invalid', 'worker-lost',
          'PRIVATE_PROMPT', new Error('PRIVATE_ERROR')], chatStats: { judgeCalls: 3 } }));
        const snapshot = getOfficialPostingDiscoveryDiagnosticsSnapshot();
        assert.deepEqual(snapshot.observations[0].failureCodes, ['worker-lost', 'comparative-invalid']);
        snapshot.observations[0].failureCodes.push('PRIVATE_MUTATION');
        assert.deepEqual(getOfficialPostingDiscoveryDiagnosticsSnapshot().observations[0].failureCodes, ['worker-lost', 'comparative-invalid']);
        assert.match(buildOfficialPostingDiscoveryMarkdown(), /Handoff failure classes: worker-lost, comparative-invalid/);
        for (const text of [JSON.stringify(getOfficialPostingDiscoveryDiagnosticsSnapshot()), buildOfficialPostingDiscoveryMarkdown()]) {
          assert.equal(text.includes('PRIVATE_'), false);
        }
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
        recordOfficialPostingAvailabilityDecision({ stage: 'absence-abort', liveWorkers: 0,
          launchPending: false, autoLaunchAvailable: false, reason: 'no-eligible-worker' });
        recordOfficialPostingPlannerTransition({ reason: 'maximum_parallelism', recommended: 10,
          queued: 20, materialized: 5, expandBy: 4 });
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
          assert.ok(report.includes('candidates 3 · validated comparison runs 2'));
          assert.ok(report.includes('Worker availability') && report.includes('closed reason no-eligible-worker'));
          assert.ok(report.includes('Worker planner transition') && report.includes('recommended 10 · queued 20'));
          assert.ok(report.includes('Synthetic official-posting main discovery marker'));
          assert.equal(report.includes('Synthetic unrelated main discovery marker'), filterCode !== 'OFFDISC');
        }
        assert.equal(generateMarkdown({ ...base, filterCode: 'JOBPAY' }).markdown.includes('Official Posting Discovery Diagnostics (OFFDISC)'), false);
        const full = applyBugReportCode(logs, {}, 'FULL+OFFDISC');
        assert.deepEqual(full.filteredLogs, logs, 'the focused lens never narrows FULL');
      });
    },
  },
  {
    name: 'Official discovery retains bounded worker availability refusals and planner transitions',
    run() {
      isolated(() => {
        assert.equal(recordOfficialPostingAvailabilityDecision({ stage: 'absence-abort', liveWorkers: 0,
          launchPending: false, autoLaunchAvailable: false, reason: 'no-eligible-worker' }), true);
        assert.equal(recordOfficialPostingAvailabilityDecision({ stage: 'launch-refused', liveWorkers: 0,
          launchPending: true, autoLaunchAvailable: true, reason: 'ready', launchReason: 'chat_mode_unavailable' }), true);
        for (let index = 0; index < 60; index += 1) {
          recordOfficialPostingAvailabilityDecision({ stage: 'absence-abort', liveWorkers: index + 1,
            launchPending: index % 2 === 0, autoLaunchAvailable: index % 3 === 0, reason: 'no-eligible-worker' });
        }
        for (let index = 0; index < 55; index += 1) {
          recordOfficialPostingPlannerTransition({ reason: 'one_work_item', recommended: index,
            queued: index + 1, materialized: index, expandBy: 1 });
        }
        recordOfficialPostingAvailabilityDecision({ stage: 'absence-abort', liveWorkers: 0,
          launchPending: false, autoLaunchAvailable: false, reason: 'no-eligible-worker' });
        recordOfficialPostingAvailabilityDecision({ stage: 'launch-refused', liveWorkers: 0,
          launchPending: true, autoLaunchAvailable: true, reason: 'ready', launchReason: 'chat_mode_unavailable' });
        const snapshot = getOfficialPostingDiscoveryDiagnosticsSnapshot();
        const markdown = buildOfficialPostingDiscoveryMarkdown();
        assert.equal(snapshot.availabilityDecisionLimit, 50);
        assert.equal(snapshot.availabilityDecisions.length, 50);
        assert.equal(snapshot.availabilityDecisions[0].liveWorkers, 13);
        assert.equal(snapshot.plannerTransitions.length, 50);
        assert.equal(snapshot.plannerTransitions[0].recommended, 5);
        assert.match(markdown, /Worker availability .*absence-abort · live workers 0 · launch pending no · auto launch available no · closed reason no-eligible-worker/u);
        assert.match(markdown, /launch refusal chat_mode_unavailable/u);
        assert.match(markdown, /Worker planner transition .*one_work_item · recommended 54 · queued 55/u);
      });
    },
  },
  {
    name: 'main log keeps 200 routine entries and a separate 300-entry warning/error ring',
    async run() {
      const isolatedLog = await import(`../../electron/logger.js?ring-test=${Date.now()}`);
      const originalLog = console.log; const originalWarn = console.warn; const originalError = console.error;
      console.log = () => {}; console.warn = () => {}; console.error = () => {};
      try {
        for (let index = 0; index < 250; index += 1) isolatedLog.logger.info(`normal-ring-${index}`);
        for (let index = 0; index < 350; index += 1) isolatedLog.logger.error(`high-ring-${index}`);
      } finally {
        console.log = originalLog; console.warn = originalWarn; console.error = originalError;
      }
      const recent = isolatedLog.getRecentLogs(500);
      assert.equal(recent.length, 500);
      assert.equal(recent.filter(entry => entry.level === 'info').length, 200);
      assert.equal(recent.filter(entry => entry.level === 'error').length, 300);
      assert.ok(recent.some(entry => entry.message === 'normal-ring-50'));
      assert.ok(!recent.some(entry => entry.message === 'normal-ring-49'));
      assert.ok(recent.some(entry => entry.message === 'high-ring-50'));
      assert.ok(!recent.some(entry => entry.message === 'high-ring-49'));
      assert.deepEqual(recent, [...recent].sort((a, b) => a.sequence - b.sequence),
        'the merged report view stays in original chronology');
    },
  },
];
