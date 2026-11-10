// Regression: the parse-career-data handler stores its diagnostics through the
// nodeId-scoped telemetry proxy as `careerSnapshotCache`, and only that record
// names its owner. A process that only drops career files never calls
// recordJobsSourceScope, so telemetry.nodeId stays null and the report used to
// drop every completed compile (a 2026-11-09 report lost two).
import test from 'node:test';
import assert from 'node:assert/strict';
import { __runWithIpcRequestContextForTests } from '../electron/ipc/ipcUtils.js';
import {
  __resetJobsTelemetryForTests,
  getJobsTelemetry,
  getJobsTelemetryForReport,
  getJobsTelemetryHubCountForReport,
} from '../electron/ipc/jobs.js';
import { buildJobsPipelineSnapshot } from '../electron/ipc/bugReport/jobsSnapshot.js';

const WINDOW_ID = 48213;
const NODE_ID = 'career-compile-hub';
const sender = { id: WINDOW_ID, getURL: () => 'file:///synthetic/career-compile/index.html' };

const withSender = (channel, nodeId, work) => __runWithIpcRequestContextForTests({ sender, nodeId, channel }, work);

const CONVERGENCE_ROUNDS = [
  { round: 1, findings: { blocker: 2, warning: 1 }, editsApplied: 3, decisionsTotal: 4 },
  { round: 2, findings: { blocker: 1, warning: 4 }, decisionsTotal: 6 },
];

// Mirrors the handler: the compile writes only its own record, and the cache
// stamp (not the enclosing telemetry) names the owner.
function recordCareerCompile({ nodeId = NODE_ID, cacheNodeId = nodeId } = {}) {
  let telemetry = null;
  withSender('parse-career-data', nodeId, () => {
    telemetry = getJobsTelemetry();
    telemetry.careerSnapshotCache = {
      ts: Date.now(),
      nodeId: cacheNodeId,
      fileCount: 2,
      fingerprint: 'abc123def456',
      outcome: 'published',
      progress: { phase: 'saving', updatedAt: Date.now() },
      convergenceRounds: CONVERGENCE_ROUNDS,
    };
  });
  return telemetry;
}

const buildReport = (nodeIds, reportWindowId = WINDOW_ID) => __runWithIpcRequestContextForTests(
  { sender, nodeId: null, channel: 'bug-report' },
  () => buildJobsPipelineSnapshot(new Set(nodeIds), reportWindowId, null),
);

function assertCareerSectionRendered(report) {
  assert.match(report, /^### Approved Career Snapshot Cache$/m, `the compile section must be rendered\n${report}`);
  const ownerLines = report.match(/^- Career compilation owner: `[^`]+`$/gm) || [];
  assert.equal(ownerLines.length, 1, `exactly one compile owner must be rendered\n${report}`);
  assert.match(report, /^- miss → published — the approved career snapshot was atomically stored · 2 file\(s\) · fingerprint `abc123def456`/m, `compile outcome must be rendered\n${report}`);
  assert.ok(report.includes('- Audit convergence (2 round(s) retained):'), `convergence rounds must be rendered\n${report}`);
  assert.ok(report.includes('  - round 1 · findings 2 blocker / 1 warning · edits applied 3 · decisions 4 · challenges 0 · adjudications 0 · rejected 0 · edit repairs 0 · deterministic errors 0'), `round 1 counts must be rendered\n${report}`);
  assert.ok(report.includes('  - round 2 · findings 1 blocker / 4 warning · edits applied 0 · decisions 6 · challenges 0 · adjudications 0 · rejected 0 · edit repairs 0 · deterministic errors 0'), `round 2 counts must be rendered\n${report}`);
  assert.ok(report.includes('  - Trend: findings went from 3 (round 1) to 5 (round 2); decisions recorded: 6.'), `convergence trend must be rendered\n${report}`);
}

function assertNoCareerSection(report) {
  assert.ok(!report.includes('### Approved Career Snapshot Cache'), `no compile section may be rendered\n${report}`);
  assert.ok(!report.includes('- Audit convergence'), `no convergence rounds may be rendered\n${report}`);
}

test('reports a career compile whose owner is only stamped on careerSnapshotCache', () => {
  __resetJobsTelemetryForTests();
  const telemetry = recordCareerCompile();
  assert.ok(!telemetry.nodeId, 'precondition: no search or rescore stamped telemetry.nodeId');
  assertCareerSectionRendered(buildReport([NODE_ID]));
});

test('drops a career compile whose node is not in the report node set', () => {
  __resetJobsTelemetryForTests();
  recordCareerCompile();
  assertNoCareerSection(buildReport(['some-other-hub']));
  // Control: the very same record is rendered for its own node set.
  assertCareerSectionRendered(buildReport([NODE_ID]));
});

test('drops a career compile when the report window is not the sender window', () => {
  __resetJobsTelemetryForTests();
  recordCareerCompile();
  assertNoCareerSection(buildReport([NODE_ID], WINDOW_ID + 1));
  // Control: the same window renders it.
  assertCareerSectionRendered(buildReport([NODE_ID], WINDOW_ID));
});

test('drops a career compile whose own stamp names a different node than its map key', () => {
  __resetJobsTelemetryForTests();
  recordCareerCompile({ cacheNodeId: 'different-career-owner' });
  assertNoCareerSection(buildReport([NODE_ID, 'different-career-owner']));
  // Control: with the stamp naming its map key, the record is rendered.
  recordCareerCompile();
  assertCareerSectionRendered(buildReport([NODE_ID]));
});

test('attributes an ambient (no sender) career compile by its own stamp and still scopes it', () => {
  __resetJobsTelemetryForTests();
  __runWithIpcRequestContextForTests({ channel: 'parse-career-data' }, () => {
    const telemetry = getJobsTelemetry();
    telemetry.careerSnapshotCache = {
      ts: Date.now(),
      nodeId: NODE_ID,
      fileCount: 2,
      fingerprint: 'abc123def456',
      outcome: 'published',
      convergenceRounds: CONVERGENCE_ROUNDS,
    };
    assert.ok(!telemetry.nodeId, 'precondition: ambient telemetry was never stamped');
  });
  const ambientReport = nodeIds => __runWithIpcRequestContextForTests(
    { channel: 'bug-report' },
    () => buildJobsPipelineSnapshot(new Set(nodeIds), null),
  );
  assertCareerSectionRendered(ambientReport([NODE_ID]));
  assertNoCareerSection(ambientReport(['some-other-hub']));
});

test('an unstamped telemetry entry still contributes no search/funnel attribution', () => {
  __resetJobsTelemetryForTests();
  const telemetry = recordCareerCompile();
  telemetry.search = { ts: Date.now(), input: 9, locations: 1 };
  telemetry.pipeline = { ts: Date.now(), stage: 'searching' };
  assert.ok(!telemetry.nodeId, 'precondition: no search or rescore stamped telemetry.nodeId');
  withSender('bug-report', null, () => {
    assert.equal(getJobsTelemetryForReport(new Set([NODE_ID]), WINDOW_ID), null,
      'an unstamped funnel must stay unattributable to the hub');
    assert.equal(getJobsTelemetryHubCountForReport(new Set([NODE_ID]), WINDOW_ID), 0,
      'an unstamped funnel must not count as an attributable hub');
  });
});
