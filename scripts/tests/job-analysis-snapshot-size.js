import assert from 'node:assert/strict';
import {
  __formatJobAnalysisPromptForTests,
  __prepareJobAnalysisSnapshotForWriteForTests,
} from '../../electron/ipc/jobs.js';

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
      const fullBytes = Buffer.byteLength(__prepareJobAnalysisSnapshotForWriteForTests(snapshot).serialized, 'utf8');
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
];
