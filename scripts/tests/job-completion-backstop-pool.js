import os from 'node:os';
import {
  assert, buildJobCompletionAssessment, fs, getJobAnalysisPaths, getJobsTelemetry, path,
} from '../test-dependencies.js';

// Every telemetry field these cases touch, including the run-scoped
// `preferences` record that carries the backstop role-screen drop count.
const TELEMETRY_KEYS = ['nodeId', 'search', 'pipeline', 'scoring', 'bucketing', 'history', 'resolves', 'preferences'];

function withSavedTelemetry(run) {
  const telemetry = getJobsTelemetry();
  const saved = {};
  for (const key of TELEMETRY_KEYS) saved[key] = telemetry[key];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-backstop-pool-'));
  try {
    return run(telemetry, dir);
  } finally {
    for (const key of TELEMETRY_KEYS) {
      if (saved[key] === undefined) delete telemetry[key];
      else telemetry[key] = saved[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A completed run whose raw search+recovery aggregate is 129 + 20 = 149, but
// whose saved preference candidate pool is 148 because the backstop role screen
// removed one late row BEFORE preferences were evaluated.
function writeRunFixture(dir, { nodeId, runId }) {
  const canvas = path.join(dir, 'canvas.json');
  const analysisPaths = getJobAnalysisPaths(canvas, path.join(dir, 'analysis'));
  fs.mkdirSync(path.dirname(analysisPaths.jsonPath), { recursive: true });
  fs.writeFileSync(analysisPaths.jsonPath, JSON.stringify({
    runId, sourceHubId: nodeId, canvasFilePath: canvas, createdAt: Date.now(),
    jobs: Array.from({ length: 148 }, () => ({})), gatheredJobCount: 120,
  }), 'utf8');
  fs.writeFileSync(path.join(dir, 'canvas.jobs-last-run.json'), JSON.stringify({
    runId, nodeId, startedAt: 1_700_000_000_000, completedAt: 1_700_000_239_600,
    terminal: { status: 'completed', outcome: 'populated', scoreReadyCount: 120 },
    funnel: { raw: 200, relevanceDropped: 0, deduped: 160, ageDropped: 0, roleDropped: 11, historyDropped: 0, descriptionEvidenceDropped: 0, kept: 129 },
    recovery: { mergeNet: 20 },
    scoring: { input: 120, selected: 120, scored: 120, placeholders: 0, unscored: 0, failedBatches: 0 },
    cleanup: { attempted: true, cleared: true },
  }), 'utf8');
  return canvas;
}

export default [
  {
    name: 'same-hub backstop role-screen drops reconcile the saved preference candidate pool',
    run: () => withSavedTelemetry((telemetry, dir) => {
      const nodeId = 'backstop-pool-hub';
      Object.assign(telemetry, {
        nodeId, search: null, pipeline: null, scoring: null, bucketing: null,
        history: null, resolves: null,
        preferences: { roleScreenBackstopDropped: 1, filtered: 28 },
      });
      const canvas = writeRunFixture(dir, { nodeId, runId: 'backstop-pool-run' });
      const assessment = buildJobCompletionAssessment(canvas, new Set([nodeId]));
      assert(assessment.includes('129 initial score-ready + 20 recovered − 1 removed by the backstop role screen = 148 candidate pool − 28 preference-filtered = 120 terminal scoring input.'),
        'the durable candidate-pool search line must print the backstop drop so 129 + 20 − 1 = 148 balances');
      assert(!assessment.includes('≠ saved preference candidate pool'),
        'a same-hub backstop drop must not be reported as a recovery-versus-pool gap');
      assert(!assessment.includes('⚠️ **INDETERMINATE**'),
        'a fully explained same-hub backstop drop must not force INDETERMINATE');
      return { reconciledPool: 148 };
    }),
  },
  {
    name: 'without a backstop drop the exact recovery/pool mismatch still fires',
    run: () => withSavedTelemetry((telemetry, dir) => {
      const nodeId = 'backstop-pool-hub';
      Object.assign(telemetry, {
        nodeId, search: null, pipeline: null, scoring: null, bucketing: null,
        history: null, resolves: null,
        preferences: { roleScreenBackstopDropped: 0, filtered: 28 },
      });
      const canvas = writeRunFixture(dir, { nodeId, runId: 'backstop-pool-run' });
      const assessment = buildJobCompletionAssessment(canvas, new Set([nodeId]));
      assert(assessment.includes('durable recovery 129 initial +20 = 149 ≠ saved preference candidate pool 148'),
        'a zero backstop count must leave the existing exact-equality gap untouched');
      assert(assessment.includes('⚠️ **INDETERMINATE**'),
        'an unexplained 149-versus-148 pool gap must still be INDETERMINATE');
      assert(!assessment.includes('− 0 role-screened') && !assessment.includes('removed by the backstop role screen'),
        'a zero backstop count must not be printed as a subtraction term');
      return { exactEqualityPreserved: true };
    }),
  },
  {
    name: 'foreign-hub telemetry is not trusted to explain this receipt candidate pool',
    run: () => withSavedTelemetry((telemetry, dir) => {
      const nodeId = 'backstop-pool-hub';
      Object.assign(telemetry, {
        nodeId: 'another-backstop-hub', search: null, pipeline: null, scoring: null,
        bucketing: null, history: null, resolves: null,
        preferences: { roleScreenBackstopDropped: 1, filtered: 28 },
      });
      const canvas = writeRunFixture(dir, { nodeId, runId: 'backstop-pool-run' });
      const assessment = buildJobCompletionAssessment(canvas, new Set([nodeId]));
      assert(assessment.includes('durable recovery 129 initial +20 = 149 ≠ saved preference candidate pool 148'),
        'another hub\'s backstop drop count must not be subtracted from this receipt pool');
      assert(assessment.includes('⚠️ **INDETERMINATE**'),
        'foreign telemetry must not turn a real pool mismatch into a green verdict');
      assert(!assessment.includes('− 1 role-screened'),
        'foreign telemetry must not print a backstop term it cannot attribute to this run');
      return { foreignTelemetryRejected: true };
    }),
  },
  {
    name: 'live post-history candidate pool subtracts only same-hub backstop drops',
    run: () => withSavedTelemetry((telemetry, dir) => {
      const nodeId = 'backstop-pool-hub';
      Object.assign(telemetry, {
        nodeId, search: { kept: 149 }, pipeline: null, scoring: null, bucketing: null,
        history: null, resolves: null,
        preferences: { roleScreenBackstopDropped: 1, filtered: 28 },
      });
      const canvas = writeRunFixture(dir, { nodeId, runId: 'backstop-pool-run' });
      const reconciled = buildJobCompletionAssessment(canvas, new Set([nodeId]));
      assert(!reconciled.includes('≠ post-history candidates'),
        'a live 149-candidate pool minus one same-hub backstop drop must match the saved 148-row pool');

      telemetry.search = { kept: 150 };
      const mismatched = buildJobCompletionAssessment(canvas, new Set([nodeId]));
      assert(mismatched.includes('saved preference candidate pool 148 ≠ post-history candidates 150 − 1 role-screened = 149'),
        'a remaining live pool mismatch must print the backstop term so its arithmetic balances');
      assert(mismatched.includes('⚠️ **INDETERMINATE**'),
        'an unexplained live pool gap must still be INDETERMINATE');
      return { livePoolBackstopTerm: true };
    }),
  },
];
