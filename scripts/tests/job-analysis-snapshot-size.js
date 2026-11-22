import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electronPkg from 'electron';
import {
  __formatJobAnalysisPromptForTests,
  __prepareJobAnalysisSnapshotForWriteForTests,
} from '../../electron/ipc/jobs.js';
import {
  __loadJobAnalysisSnapshotForTests,
  __recordOversizeSaveRefusalForTests,
  __saveJobAnalysisSnapshotForTests,
  readAnalysisArtifact,
  restoreJobAnalysisSnapshotAfterRead,
} from '../../electron/ipc/jobs/analysisStore.js';
import { getJobAnalysisPaths } from '../../electron/ipc/jobAnalysisPaths.js';
import { readJobAnalysisRecoveryLifecycle } from '../../electron/ipc/jobAnalysisRecoveryLifecycle.js';
import { findScoringRecoverySaveFailure } from '../../electron/ipc/bugReport/jobsSnapshot.js';

// A real 1076-job scoring run overflowed the 128 MiB recovery limit because
// every preview batch stored its jobs twice: once as `jobs` and once as the
// escaped `prompt` string. These cases pin the size ladder that keeps the
// crash-recovery copy writable, and the prompt text that must stay reproducible
// from whatever JSON actually reached disk.
const OMITTED_BATCH_JOBS_NOTICE = '(batch jobs omitted from the saved snapshot to stay under the 128 MiB recovery limit)';
const batchPromptBody = (jobs) => `JOBS TO SCORE (array, indexed):\n${JSON.stringify(jobs)}`;

function buildSnapshot() {
  const jobs = Array.from({ length: 6 }, (_, index) => ({
    index,
    title: `Synthetic role ${index}`,
    company: 'Synthetic employer',
    url: `https://example.test/snapshot-size/${index}`,
    description: `Synthetic posting detail number ${index}. `.repeat(4),
  }));
  const batches = [jobs.slice(0, 3), jobs.slice(3, 6)];
  return {
    schemaVersion: 2,
    createdAt: 1_700_000_000_000,
    runId: 'snapshot-size-run',
    gatheredJobCount: jobs.length,
    jobs,
    previewBatches: batches.map((batchJobs, offset) => ({
      batchNumber: offset + 1,
      jobCount: batchJobs.length,
      jobs: batchJobs,
      prompt: batchPromptBody(batchJobs),
    })),
  };
}

// A Job Preferences snapshot: every row carries its assessment and the
// evaluation's audits repeat it as `{ index, title, company, listingIdentity,
// ...assessment }` (jobPreferences.js attachAssessments). The summaries are
// long so the duplicated copy dominates the size, as it does on a real pool.
function buildPreferenceSnapshot({ canvasFilePath = '/tmp/ic-size-ladder/canvas.json', count = 8 } = {}) {
  const jobs = Array.from({ length: count }, (_, index) => ({
    title: `Preference role ${index}`,
    company: `Employer ${index}`,
    url: `https://example.test/preference-size/${index}`,
    description: `Posting text ${index}. `.repeat(6),
    preferenceAssessment: {
      status: index % 3 === 0 ? 'filtered' : 'accepted',
      matches: [{ id: `pref-${index}`, strict: index % 3 === 0, outcome: index % 3 === 0 ? 'conflicts' : 'confirmed', category: 'work', evidence: `Evidence ${index} `.repeat(40) }],
      confirmedSoftPreferences: index % 3 === 0 ? 0 : 1,
      conflictingSoftPreferences: 0,
      preferenceScore: index % 3 === 0 ? 0 : 25,
      summary: `Summary for ${index} `.repeat(30),
      evaluatedAt: '2026-11-20T00:00:00.000Z',
    },
  }));
  const audits = jobs.map((job, index) => ({
    index,
    title: job.title,
    company: job.company,
    listingIdentity: { url: job.url },
    ...structuredClone(job.preferenceAssessment),
  }));
  return {
    version: 1,
    createdAt: '2026-11-20T01:00:00.000Z',
    nodeId: 'size-ladder-hub',
    sourceHubId: 'size-ladder-hub',
    runId: 'size-ladder-run',
    canvasFilePath,
    preferenceEvaluation: { preferencePlan: { titles: ['Role'] }, audits, counts: { input: count }, preferenceFingerprint: 'fp' },
    gatheredJobCount: count,
    jobs,
    previewBatches: [{ batchNumber: 1, jobCount: 2, jobs: jobs.slice(0, 2).map(({ preferenceAssessment: _p, ...row }) => row) }],
  };
}

const bytes = text => Buffer.byteLength(text, 'utf8');
const prepareSizes = (snapshot) => {
  const pretty = __prepareJobAnalysisSnapshotForWriteForTests(snapshot).serialized;
  const compact = __prepareJobAnalysisSnapshotForWriteForTests(snapshot, { maxBytes: bytes(pretty) - 1 }).serialized;
  const deduped = __prepareJobAnalysisSnapshotForWriteForTests(snapshot, { maxBytes: bytes(compact) - 1 }).serialized;
  return { pretty, compact, deduped };
};

export default [
  {
    name: 'job-analysis snapshot write drops preview batch prompt copies while keeping batch jobs and identical prompt text',
    run: () => {
      const snapshot = buildSnapshot();
      const prepared = __prepareJobAnalysisSnapshotForWriteForTests(snapshot);
      const parsed = JSON.parse(prepared.serialized);
      assert.equal(/"prompt"/.test(prepared.serialized), false, 'no batch prompt copy survives serialization');
      assert.equal(parsed.previewBatches.length, snapshot.previewBatches.length, 'batch count is unchanged');
      for (const [index, batch] of parsed.previewBatches.entries()) {
        const original = snapshot.previewBatches[index];
        assert.equal(Object.hasOwn(batch, 'prompt'), false, `batch ${index} still stores an escaped prompt copy`);
        assert.deepEqual(batch.jobs, original.jobs, `batch ${index} keeps its job objects`);
        assert.equal(batch.batchNumber, original.batchNumber, `batch ${index} keeps batchNumber`);
        assert.equal(batch.jobCount, original.jobCount, `batch ${index} keeps jobCount`);
        assert.equal(Object.hasOwn(prepared.snapshot.previewBatches[index], 'prompt'), false, `prepared snapshot batch ${index} drops prompt`);
      }
      assert.deepEqual(parsed.jobs, snapshot.jobs, 'the top-level jobs pool is preserved');
      const originalText = __formatJobAnalysisPromptForTests(snapshot);
      const preparedText = __formatJobAnalysisPromptForTests(prepared.snapshot);
      const loadedText = __formatJobAnalysisPromptForTests(parsed);
      assert.equal(preparedText, originalText, 'a snapshot with stored prompt strings formats identically to one without them');
      assert.equal(loadedText, originalText, 'the reloaded JSON formats to the same prompt file text');
      assert.equal(originalText.split(batchPromptBody(snapshot.previewBatches[0].jobs)).length - 1, 1, 'the first batch payload is printed exactly once');
    },
  },
  {
    name: 'job-analysis snapshot write omits preview batch jobs only when the prompt-free form still exceeds the limit',
    run: () => {
      const snapshot = buildSnapshot();
      // The lossless compact form is tried first, so the lossy omission is
      // reached only when the compact form also exceeds the limit.
      const prettyBytes = Buffer.byteLength(__prepareJobAnalysisSnapshotForWriteForTests(snapshot).serialized, 'utf8');
      const compactSerialized = __prepareJobAnalysisSnapshotForWriteForTests(snapshot, { maxBytes: prettyBytes - 1 }).serialized;
      const fullBytes = Buffer.byteLength(compactSerialized, 'utf8');
      assert.equal(/"previewBatchJobsOmitted"/.test(compactSerialized), false, 'the compact form keeps batch jobs');
      const prepared = __prepareJobAnalysisSnapshotForWriteForTests(snapshot, { maxBytes: fullBytes - 1 });
      const parsed = JSON.parse(prepared.serialized);
      assert.ok(Buffer.byteLength(prepared.serialized, 'utf8') < fullBytes, 'omitted form is smaller than the prompt-free form');
      assert.equal(parsed.previewBatchJobsOmitted, true, 'the snapshot marks that batch jobs were omitted');
      assert.equal(parsed.previewBatches.length, snapshot.previewBatches.length, 'batch count is unchanged by omission');
      for (const [index, batch] of parsed.previewBatches.entries()) {
        const original = snapshot.previewBatches[index];
        assert.deepEqual(batch.jobs, [], `batch ${index} carries no jobs`);
        assert.equal(batch.jobsOmitted, true, `batch ${index} is marked omitted`);
        assert.equal(batch.batchNumber, original.batchNumber, `batch ${index} keeps batchNumber`);
        assert.equal(batch.jobCount, original.jobCount, `batch ${index} keeps jobCount`);
        assert.equal(Object.hasOwn(batch, 'prompt'), false, `batch ${index} still stores an escaped prompt copy`);
      }
      assert.deepEqual(parsed.jobs, snapshot.jobs, 'the top-level jobs pool is fully preserved');
      const text = __formatJobAnalysisPromptForTests(parsed);
      const noticeLines = text.split('\n').filter(line => line === OMITTED_BATCH_JOBS_NOTICE);
      assert.equal(noticeLines.length, snapshot.previewBatches.length, 'each omitted batch prints the omitted notice line');
      assert.equal(text.includes(snapshot.jobs[0].title), false, 'omitted batch jobs are not printed as if they were scored');
    },
  },
  {
    name: 'job-analysis snapshot write throws the recovery-limit error when even the omitted form does not fit',
    run: () => {
      const snapshot = buildSnapshot();
      assert.throws(
        () => __prepareJobAnalysisSnapshotForWriteForTests(snapshot, { maxBytes: 1 }),
        (error) => {
          assert.equal(error.code, 'JOB_ANALYSIS_ARTIFACT_TOO_LARGE', `unexpected error: ${error.message}`);
          assert.equal(error.message, 'Saved job analysis exceeds the 128 MiB recovery limit. The previous saved analysis was preserved.');
          return true;
        },
      );
    },
  },
  {
    name: 'job-analysis snapshot write falls back to compact JSON with reportMetadata still first before any lossy step',
    run: () => {
      const snapshot = buildPreferenceSnapshot();
      const { pretty, compact } = prepareSizes(snapshot);
      assert.ok(bytes(compact) < bytes(pretty), 'compact JSON is smaller');
      assert.ok(pretty.startsWith('{\n  "reportMetadata": {'), 'fixture writes a report envelope');
      assert.ok(compact.startsWith('{"reportMetadata":{'), 'the envelope stays the first property in compact output');
      assert.equal(compact.includes('\n  '), false, 'no indentation');
      assert.equal(/"preferenceAuditAssessmentsDeduplicated"|"previewBatchJobsOmitted"/.test(compact), false, 'compact step changes formatting only');
      assert.deepEqual(JSON.parse(compact), JSON.parse(pretty), 'compact output parses to the same data');
      const metadataEnd = compact.indexOf('},"') + 1;
      assert.deepEqual(JSON.parse(compact.slice('{"reportMetadata":'.length, metadataEnd)), JSON.parse(pretty).reportMetadata,
        'a bounded prefix read of the compact file yields the same envelope');
      assert.equal(compact[metadataEnd], ',', 'the envelope is followed by a payload property');
    },
  },
  {
    name: 'job-analysis snapshot write stores duplicated preference audits once and every read restores them exactly',
    run: async () => {
      const snapshot = buildPreferenceSnapshot();
      // A merged evaluation can carry an audit whose index names another row,
      // and an audit whose assessment matches no row at all.
      const audits = snapshot.preferenceEvaluation.audits;
      audits[1] = { ...audits[1], index: 5 };
      audits.push({ index: 99, title: 'Orphan', company: 'None', listingIdentity: null, status: 'filtered', matches: [], summary: 'No row' });
      const { pretty, compact, deduped } = prepareSizes(snapshot);
      const repeated = snapshot.jobs.reduce((sum, job) => sum + bytes(JSON.stringify(job.preferenceAssessment)), 0);
      assert.ok(bytes(compact) - bytes(deduped) > repeated * 0.9, 'the de-duplicated form drops (nearly) every repeated assessment');
      const raw = JSON.parse(deduped);
      assert.equal(raw.preferenceAuditAssessmentsDeduplicated, true, 'the file carries the de-duplication flag');
      assert.ok(deduped.startsWith('{"reportMetadata":{'), 'the envelope stays first');
      assert.equal(raw.previewBatchJobsOmitted, undefined, 'no lossy step was needed');
      assert.equal(raw.preferenceEvaluation.audits[0].preferenceAssessmentFromJobIndex, 0);
      assert.equal(Object.hasOwn(raw.preferenceEvaluation.audits[0], 'summary'), false, 'the audit copy is removed');
      assert.equal(raw.preferenceEvaluation.audits[1].preferenceAssessmentFromJobIndex, 1, 'a stale index falls back to the exact matching row');
      assert.equal(raw.preferenceEvaluation.audits[1].index, 5, 'the stale index itself is kept verbatim');
      assert.deepEqual(raw.preferenceEvaluation.audits.at(-1), audits.at(-1), 'an audit with no matching row is stored in full');
      assert.deepEqual(raw.jobs, JSON.parse(pretty).jobs, 'row assessments are untouched');
      const restored = restoreJobAnalysisSnapshotAfterRead(JSON.parse(deduped));
      const expected = JSON.parse(pretty);
      assert.equal(JSON.stringify(restored), JSON.stringify(expected), 'the restored snapshot is identical, key order included');
      restored.preferenceEvaluation.audits[0].matches.push({ id: 'mutation' });
      assert.equal(restored.jobs[0].preferenceAssessment.matches.length, 1, 'a restored audit does not share objects with its row');
      assert.equal(restoreJobAnalysisSnapshotAfterRead(expected), expected, 'a snapshot without the flag is returned unchanged');

      const broken = JSON.parse(deduped);
      broken.preferenceEvaluation.audits[0].preferenceAssessmentFromJobIndex = 999;
      assert.throws(() => restoreJobAnalysisSnapshotAfterRead(broken), SyntaxError, 'an unresolvable pointer reads as malformed');

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-size-ladder-read-'));
      try {
        const file = path.join(dir, 'snapshot.json');
        fs.writeFileSync(file, deduped, 'utf8');
        const read = await readAnalysisArtifact(file);
        assert.equal(read.state, 'present');
        assert.equal(read.serialized, deduped, 'the exact written bytes are still returned for digests');
        assert.equal(JSON.stringify(read.snapshot), JSON.stringify(expected), 'readAnalysisArtifact restores the audits');
        fs.writeFileSync(file, JSON.stringify(broken), 'utf8');
        assert.equal((await readAnalysisArtifact(file)).state, 'invalid', 'a malformed pointer file is invalid, not partially read');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'job-analysis snapshot save: deduplicated write loads back identical, and a too-large save leaves a durable failed lifecycle row',
    run: async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-size-ladder-save-'));
      const canvas = path.join(dir, 'canvas.json');
      const lifecyclePath = path.join(electronPkg.app.getPath('userData'), 'job-search', 'analysis-recovery-lifecycle.json');
      try {
        const snapshot = buildPreferenceSnapshot({ canvasFilePath: canvas, count: 12 });
        const { compact, deduped } = prepareSizes(snapshot);
        // The save adds a careerSnapshotId and authority receipt (well under
        // 4 KiB); the gap between the compact and de-duplicated forms is far
        // larger, so this limit forces exactly the de-duplication step.
        const maxBytes = bytes(deduped) + 4096;
        assert.ok(bytes(compact) > maxBytes + 4096, 'fixture leaves room between the ladder steps');

        await assert.rejects(
          __saveJobAnalysisSnapshotForTests(snapshot, { allowLegacyFixtureUpgrade: true, maxBytes: 64 }),
          error => error?.code === 'JOB_ANALYSIS_ARTIFACT_TOO_LARGE',
        );
        const paths = getJobAnalysisPaths(canvas, null, 'size-ladder-hub');
        assert.equal(fs.existsSync(paths.jsonPath), false, 'a refused save writes no snapshot');
        const failed = readJobAnalysisRecoveryLifecycle(lifecyclePath, { canvasFilePath: canvas, ownerIds: ['size-ladder-hub'] })
          .events.find(event => event.operation === 'snapshot-save' && event.result === 'failed');
        assert.ok(failed, 'a failed snapshot-save lifecycle row is recorded');
        assert.equal(failed.reason, 'artifact-too-large');
        assert.equal(failed.gatheredJobCount, 12);
        assert.equal(failed.candidatePoolJobCount, 12);
        assert.ok(/^#[a-f0-9]{10}$/.test(failed.run || ''), 'the row carries the run identity');

        const saved = await __saveJobAnalysisSnapshotForTests(snapshot, { allowLegacyFixtureUpgrade: true, maxBytes });
        assert.equal(saved.retired, undefined, `save was retired: ${saved.reason}`);
        const onDisk = fs.readFileSync(saved.jsonPath, 'utf8');
        assert.ok(bytes(onDisk) <= maxBytes, 'the written file fits the limit');
        assert.equal(JSON.parse(onDisk).preferenceAuditAssessmentsDeduplicated, true, 'the de-duplication step was used');
        const loaded = await __loadJobAnalysisSnapshotForTests(canvas, 'size-ladder-hub', 'size-ladder-run');
        assert.equal(Object.hasOwn(loaded.snapshot, 'preferenceAuditAssessmentsDeduplicated'), false, 'readers never see the flag');
        assert.equal(JSON.stringify(loaded.snapshot.preferenceEvaluation), JSON.stringify(snapshot.preferenceEvaluation), 'audits load back identical');
        assert.equal(JSON.stringify(loaded.snapshot.jobs), JSON.stringify(snapshot.jobs), 'rows load back identical');
        const events = readJobAnalysisRecoveryLifecycle(lifecyclePath, { canvasFilePath: canvas, ownerIds: ['size-ladder-hub'] }).events;
        assert.ok(events.some(event => event.operation === 'snapshot-save' && event.result === 'saved'), 'the successful save is recorded as before');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'job-analysis snapshot save: Solve rewrites and checkpoints record their own size refusal once, never read as the scoring save',
    run: async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-size-refusal-'));
      const canvas = path.join(dir, 'canvas.json');
      const lifecyclePath = path.join(electronPkg.app.getPath('userData'), 'job-search', 'analysis-recovery-lifecycle.json');
      try {
        const snapshot = { canvasFilePath: canvas, runId: 'refusal-run', gatheredJobCount: 5, jobs: [{}, {}, {}], snapshotContext: { recoveryMode: 'manual' } };
        const tooLarge = Object.assign(new Error('too large'), { code: 'JOB_ANALYSIS_ARTIFACT_TOO_LARGE' });
        await __recordOversizeSaveRefusalForTests(tooLarge, snapshot, 'refusal-hub', 'checkpoint-too-large');
        // The outer Solve wrapper sees the same error: it must not add a second row.
        await __recordOversizeSaveRefusalForTests(tooLarge, snapshot, 'refusal-hub', 'description-recovery-too-large');
        await __recordOversizeSaveRefusalForTests(new Error('disk full'), snapshot, 'refusal-hub', 'description-recovery-too-large');
        const events = readJobAnalysisRecoveryLifecycle(lifecyclePath, { canvasFilePath: canvas, ownerIds: ['refusal-hub'] })
          .events.filter(event => event.operation === 'snapshot-save' && event.result === 'failed');
        assert.equal(events.length, 1, 'one row per refused save; other errors record nothing');
        assert.equal(events[0].reason, 'checkpoint-too-large');
        assert.equal(events[0].gatheredJobCount, 5);
        assert.equal(events[0].candidatePoolJobCount, 3);
        assert.equal(findScoringRecoverySaveFailure(events, { ownerId: 'refusal-hub', runId: 'refusal-run', savedSnapshotCreatedAtMs: 1 }), null,
          'the report names the scoring save only for its own reason');

        const store = fs.readFileSync(new URL('../../electron/ipc/jobs/analysisStore.js', import.meta.url), 'utf8');
        assert.match(store, /recordOversizeSaveRefusal\(error, snapshot, snapshot\.nodeId, 'checkpoint-too-large'\)/);
        assert.match(store, /recordOversizeSaveRefusal\(error, snapshot, options\?\.nodeId, 'description-recovery-too-large'\)/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
];
