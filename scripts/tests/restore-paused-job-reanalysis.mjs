import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPausedReanalysisRestore, restorePausedJobReanalysis, REANALYZE_SAVED_JOBS_RECOVERY_MODE } from '../restore-paused-job-reanalysis.mjs';

const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-restore-paused-reanalysis-'));
const input = path.join(root, 'canvas.json');
const output = path.join(root, 'restored.json');
const hubId = 'hub-reanalysis-fixture';
const candidatePool = [
  { title: 'Platform Engineer', company: 'Example', url: 'https://example.test/1', preferenceAssessment: { accepted: false } },
  { title: 'Staff Engineer', company: 'Example', url: 'https://example.test/2', preferenceAssessment: { accepted: false } },
];
const fixture = {
  nodes: [{ id: 'container', type: 'canvas', data: { nested: { nodes: [{
    id: hubId,
    type: 'jobhub',
    data: {
      hubState: 'empty',
      preferenceCandidatePool: candidatePool,
      resumeProfile: { summary: 'Saved profile', skills: ['TypeScript'] },
      jobPreferences: 'Prefer product infrastructure roles.',
      activeJobPreferences: 'Prefer product infrastructure roles.',
      gatheredCount: 42,
      preferenceFilteredCount: 2,
      collectionScopeCaveats: [{ code: 'provider-cap' }],
      queuedModuleRun: { label: 'Searching', position: 1 },
      errorMessage: 'stale accidental-run UI',
      pendingJobs: [{ title: 'do not keep this transient UI' }],
      scoredJobs: [],
    },
  }] } } }],
};

try {
  const serializedFixture = `${JSON.stringify(fixture, null, 2)}\n`;
  await fs.promises.writeFile(input, serializedFixture, 'utf8');

  const dryRun = await restorePausedJobReanalysis({
    canvasPath: input,
    hubId,
    outputPath: output,
    recoveryRunId: 'job-search:hub-reanalysis-fixture:recovered-test',
    now: 1_790_000_000_000,
  });
  assert.equal(dryRun.mode, 'dry-run');
  assert.equal(dryRun.candidateSource, 'preferenceCandidatePool');
  assert.equal(dryRun.effectiveCandidateCount, 2);
  await assert.rejects(fs.promises.access(output), /ENOENT/);

  const written = await restorePausedJobReanalysis({
    canvasPath: input,
    hubId,
    outputPath: output,
    write: true,
    recoveryRunId: 'job-search:hub-reanalysis-fixture:recovered-test',
    now: 1_790_000_000_000,
  });
  assert.equal(written.mode, 'written');
  assert.equal(await fs.promises.readFile(input, 'utf8'), serializedFixture, 'the input canvas must remain byte-for-byte unchanged');

  const restored = JSON.parse(await fs.promises.readFile(output, 'utf8'));
  const restoredHub = restored.nodes[0].data.nested.nodes[0];
  assert.deepEqual(restoredHub.data.preferenceCandidatePool, candidatePool, 'candidate rows must be preserved verbatim');
  assert.deepEqual(restoredHub.data.resumeProfile, fixture.nodes[0].data.nested.nodes[0].data.resumeProfile, 'profile must be preserved');
  assert.equal(restoredHub.data.jobPreferences, fixture.nodes[0].data.nested.nodes[0].data.jobPreferences, 'brief must be preserved');
  assert.equal(restoredHub.data.gatheredCount, 42, 'collection facts must be preserved');
  assert.deepEqual(restoredHub.data.collectionScopeCaveats, [{ code: 'provider-cap' }], 'collection metadata must be preserved');
  assert.equal(restoredHub.data.hubState, 'done');
  assert.equal(restoredHub.data.resultDisposition, 'preference-filtered');
  assert.equal(restoredHub.data.resultCount, 0);
  assert.equal(restoredHub.data.totalScoredCount, 0);
  assert.equal(restoredHub.data.scrapedCount, 0);
  assert.equal(restoredHub.data.preferenceFilteredCount, 2, 'the retained pool/filter facts must remain intact');
  assert.equal(restoredHub.data.queuedModuleRun, null);
  assert.equal(restoredHub.data.errorMessage, null);
  assert.equal(restoredHub.data.pendingJobs, null);
  assert.equal(restoredHub.data.manualAiResume.recoveryMode, REANALYZE_SAVED_JOBS_RECOVERY_MODE);
  assert.equal(restoredHub.data.manualAiResume.pausedByUser, true);
  assert.equal(restoredHub.data.manualAiResume.runId, 'job-search:hub-reanalysis-fixture:recovered-test');

  const scoredOnly = {
    nodes: [{
      id: 'scores-only',
      type: 'jobhub',
      data: {
        hubState: 'empty',
        scoredJobs: [{ title: 'Saved scored listing', company: 'Example', url: 'https://example.test/scored' }],
        resumeProfile: { summary: 'Saved profile' },
        activeJobPreferences: 'Saved brief',
        resultCount: 1,
      },
    }],
  };
  const scoredOnlyRestore = buildPausedReanalysisRestore(scoredOnly, {
    hubId: 'scores-only',
    recoveryRunId: 'job-search:scores-only:recovered-test',
    now: 1_790_000_000_001,
  });
  const scoredOnlyData = scoredOnlyRestore.restored.nodes[0].data;
  assert.equal(scoredOnlyRestore.summary.candidateSource, 'scoredJobs');
  assert.equal(scoredOnlyRestore.summary.effectiveCandidateCount, 1);
  assert.deepEqual(scoredOnlyData.scoredJobs, scoredOnly.nodes[0].data.scoredJobs, 'scoredJobs-only recovery must retain its rows');
  assert.equal(scoredOnlyData.resultCount, 1, 'non-filtered score-only terminal facts must not be rewritten');

  await assert.rejects(
    async () => buildPausedReanalysisRestore({ nodes: [{
      id: 'empty-candidates', type: 'jobhub', data: {
        preferenceCandidatePool: [], scoredJobs: [], resumeProfile: { summary: 'profile' }, jobPreferences: 'brief',
      },
    }] }, { hubId: 'empty-candidates', now: 1_790_000_000_002 }),
    /neither a saved preferenceCandidatePool nor scoredJobs/,
    'both-empty recovery must be rejected',
  );

  await assert.rejects(
    restorePausedJobReanalysis({ canvasPath: input, hubId, outputPath: output, write: true }),
    /Refusing to overwrite existing output/,
    'the utility must never overwrite an output file',
  );
  await assert.rejects(
    restorePausedJobReanalysis({ canvasPath: input, hubId: 'missing', outputPath: path.join(root, 'missing.json') }),
    /Expected exactly one jobhub/,
    'the utility must require one exact hub',
  );
  process.stdout.write('restore-paused-job-reanalysis: passed\n');
} finally {
  await fs.promises.rm(root, { recursive: true, force: true });
}
