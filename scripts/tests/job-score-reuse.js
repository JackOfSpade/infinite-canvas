import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ipcMain } from 'electron';
import {
  JOB_SCORE_REUSE_KEY,
  JOB_SCORE_REUSE_MAX_ENTRIES,
  createJobScoreReuseStore,
  jobScoreReuseFingerprint,
  mergeReusedAndScored,
  partitionBatchForReuse,
} from '../../electron/ipc/jobScoreReuse.js';
import { __registerJobsHandlersForTests, getJobsTelemetry, registerJobsHandlers } from '../../electron/ipc/jobs.js';
import { __runWithIpcRequestContextForTests } from '../../electron/ipc/ipcUtils.js';
import { claimJobAnalysisOperationAuthority } from '../../electron/ipc/jobAnalysisOperationAuthorityStore.js';

// Synthetic fixtures only: invented listings and invented evidence.
const baseFingerprintInput = () => ({
  contract: 'synthetic-scoring-contract:v1',
  prefix: 'Synthetic cached prefix.',
  careerSnapshotId: 'synthetic-snapshot-1',
  job: { index: 3, title: 'Synthetic role', company: 'Synthetic employer', snippet: 'Alpha duty is required' },
});

const inMemoryRunMigrations = () => {
  const values = new Map();
  const calls = { recall: 0, remember: 0 };
  return {
    values,
    calls,
    recall: async (runId, key) => {
      calls.recall += 1;
      return values.get(`${runId}\u0000${key}`) ?? null;
    },
    remember: async (runId, key, value) => {
      calls.remember += 1;
      values.set(`${runId}\u0000${key}`, value);
    },
  };
};

// Reads the JSON array that follows a marker without trusting any suffix.
function jsonArrayAfter(text, marker) {
  const markerAt = text.indexOf(marker);
  assert.ok(markerAt >= 0, `prompt is missing ${JSON.stringify(marker)}`);
  const start = markerAt + marker.length;
  assert.equal(text[start], '[', 'the marker must be followed by the job array');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let at = start; at < text.length; at += 1) {
    const character = text[at];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '[') depth += 1;
    else if (character === ']') {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(start, at + 1));
    }
  }
  throw new assert.AssertionError({ message: 'the job array never closed' });
}

// The real score-jobs handler with an injected scorer, no gap review, and an
// in-memory per-run row store, driven exactly like a resumed manual run.
function createScoreJobsHarness({ careerData }) {
  const calls = [];
  const reviewCalls = [];
  const runMigrations = inMemoryRunMigrations();
  const score = async (prompt, options) => {
    const parsed = jsonArrayAfter(prompt, 'JOBS TO SCORE (array, indexed):\n');
    calls.push(parsed);
    const response = {
      scores: parsed.map(job => ({
        index: job.index,
        matchScore: 86,
        confidence: 'high',
        careerDirection: 'Engineering',
        reasoning: `Synthetic reasoning for ${job.title}.`,
        requirementAssessments: [],
        materialGaps: [{
          requirementText: 'Synthetic core requirement',
          priority: 'required',
          jobEvidence: job.snippet,
          status: 'not_documented',
          candidateEvidence: '',
          impact: 'The supplied synthetic career data does not document it.',
        }],
      })),
    };
    options.responseValidator(response);
    return response;
  };
  return { calls, reviewCalls, runMigrations, careerData, score };
}

export default [
  {
    name: 'Job score reuse: the fingerprint is stable, complete, and blind to the slim row index',
    run: () => {
      const fingerprint = jobScoreReuseFingerprint(baseFingerprintInput());
      assert.match(fingerprint, /^[a-f0-9]{64}$/u);
      assert.equal(jobScoreReuseFingerprint(baseFingerprintInput()), fingerprint, 'equal inputs are stable');
      const changed = {
        job: jobScoreReuseFingerprint({ ...baseFingerprintInput(), job: { ...baseFingerprintInput().job, snippet: 'Beta duty is required' } }),
        title: jobScoreReuseFingerprint({ ...baseFingerprintInput(), job: { ...baseFingerprintInput().job, title: 'Another role' } }),
        prefix: jobScoreReuseFingerprint({ ...baseFingerprintInput(), prefix: 'Synthetic cached prefix. ' }),
        contract: jobScoreReuseFingerprint({ ...baseFingerprintInput(), contract: 'synthetic-scoring-contract:v2' }),
        snapshot: jobScoreReuseFingerprint({ ...baseFingerprintInput(), careerSnapshotId: 'synthetic-snapshot-2' }),
      };
      for (const [field, value] of Object.entries(changed)) {
        assert.notEqual(value, fingerprint, `${field} must change the fingerprint`);
      }
      assert.equal(jobScoreReuseFingerprint({ ...baseFingerprintInput(), careerSnapshotId: '' }), jobScoreReuseFingerprint({ ...baseFingerprintInput(), careerSnapshotId: null }), 'no snapshot id hashes the same null');
      assert.equal(jobScoreReuseFingerprint({ ...baseFingerprintInput(), job: { ...baseFingerprintInput().job, index: 0 } }), fingerprint, 'index is positional, not identity');
    },
  },
  {
    name: 'Job score reuse: store round-trips through the run migrations, strips index, evicts oldest, keeps concurrent writes',
    run: async () => {
      const fake = inMemoryRunMigrations();
      const store = createJobScoreReuseStore({ runId: 'run-a', recall: fake.recall, remember: fake.remember });
      assert.equal(await store.load(), 0, 'an unwritten run loads nothing');
      assert.equal(store.size(), 0);
      assert.equal(store.get('fp1'), null);

      const remembered = await store.record([{
        fingerprint: 'fp1',
        row: { index: 4, matchScore: 71, nested: { index: 9, keep: true }, rows: [{ index: 1, keep: true }] },
      }]);
      assert.equal(await remembered, undefined, 'record resolves after the write');
      assert.equal(store.size(), 1);
      assert.deepEqual(store.get('fp1'), { matchScore: 71, nested: { index: 9, keep: true }, rows: [{ index: 1, keep: true }] }, 'the row\'s own positional index is stripped');
      const readback = store.get('fp1');
      readback.matchScore = 1;
      assert.equal(store.get('fp1').matchScore, 71, 'get hands back a copy');
      const persisted = fake.values.get(`run-a\u0000${JOB_SCORE_REUSE_KEY}`);
      assert.equal(persisted.version, 1);
      assert.deepEqual(persisted.rows, { fp1: { matchScore: 71, nested: { index: 9, keep: true }, rows: [{ index: 1, keep: true }] } });

      const reloaded = createJobScoreReuseStore({ runId: 'run-a', recall: fake.recall, remember: fake.remember });
      assert.equal(await reloaded.load(), 1);
      assert.deepEqual(reloaded.get('fp1'), { matchScore: 71, nested: { index: 9, keep: true }, rows: [{ index: 1, keep: true }] });

      const malformed = inMemoryRunMigrations();
      await malformed.remember('run-bad', JOB_SCORE_REUSE_KEY, { version: 2, rows: { fp1: { matchScore: 3 } } });
      const badStore = createJobScoreReuseStore({ runId: 'run-bad', recall: malformed.recall, remember: malformed.remember });
      assert.equal(await badStore.load(), 0, 'only version 1 with a rows object is accepted');
      assert.equal(badStore.size(), 0);

      const evicting = createJobScoreReuseStore({ runId: 'run-e', recall: inMemoryRunMigrations().recall, remember: inMemoryRunMigrations().remember, maxEntries: 2 });
      await evicting.record([{ fingerprint: 'first', row: { matchScore: 1 } }]);
      await evicting.record([{ fingerprint: 'second', row: { matchScore: 2 } }]);
      await evicting.record([{ fingerprint: 'third', row: { matchScore: 3 } }]);
      assert.equal(evicting.size(), 2, 'the cap holds');
      assert.equal(evicting.get('first'), null, 'the oldest insert is the one evicted');
      assert.equal(evicting.get('second').matchScore, 2);
      assert.equal(evicting.get('third').matchScore, 3);
      assert.ok(JOB_SCORE_REUSE_MAX_ENTRIES >= 1000, 'the default cap leaves room for several runs of batches');

      const concurrent = inMemoryRunMigrations();
      const racing = createJobScoreReuseStore({ runId: 'run-c', recall: concurrent.recall, remember: concurrent.remember });
      await Promise.all([
        racing.record([{ fingerprint: 'a', row: { matchScore: 1 } }]),
        racing.record([{ fingerprint: 'b', row: { matchScore: 2 } }]),
      ]);
      assert.deepEqual(Object.keys(concurrent.values.get(`run-c\u0000${JOB_SCORE_REUSE_KEY}`).rows).sort(), ['a', 'b'], 'the whole map, not the batch, is written');
      assert.equal(racing.size(), 2);

      const failing = createJobScoreReuseStore({
        runId: 'run-f',
        recall: async () => { throw new Error('synthetic recall failure'); },
        remember: async () => { throw new Error('synthetic remember failure'); },
      });
      assert.equal(await failing.load(), 0, 'a recall failure is an empty load');
      await failing.record([{ fingerprint: 'kept', row: { matchScore: 5 } }]);
      assert.equal(failing.get('kept').matchScore, 5, 'a write failure keeps the in-memory row');

      const unused = inMemoryRunMigrations();
      const unscoped = createJobScoreReuseStore({ runId: null, recall: unused.recall, remember: unused.remember });
      assert.equal(await unscoped.load(), 0);
      await unscoped.record([{ fingerprint: 'fp', row: { matchScore: 9 } }]);
      assert.deepEqual(unused.calls, { recall: 0, remember: 0 }, 'no run id means nothing is read or written');
      assert.equal(unscoped.size(), 0);
      assert.equal(unscoped.get('fp'), null);
    },
  },
  {
    name: 'Job score reuse: partition reuses only validating rows and merge restores positions',
    run: () => {
      const batch = [{ snippet: 'one' }, { snippet: 'two' }, { snippet: 'three' }];
      const fingerprints = ['fp-one', 'fp-two', 'fp-three'];
      const saved = new Map([['fp-one', { matchScore: 80 }], ['fp-two', { matchScore: 70 }], ['fp-three', { matchScore: 60 }]]);
      const store = { get: fingerprint => saved.get(fingerprint) ?? null };
      const partitioned = partitionBatchForReuse(batch, {
        fingerprintOf: (job, index) => fingerprints[index],
        store,
        isReusable: (row, job, index) => index !== 1,
      });
      assert.deepEqual(partitioned.fingerprints, fingerprints);
      assert.deepEqual([...partitioned.reused.keys()], [0, 2], 'only the validating rows are reused');
      assert.deepEqual(partitioned.pendingIndices, [1], 'a row that fails isReusable is pending');

      const throwing = partitionBatchForReuse(batch, {
        fingerprintOf: () => { throw new Error('synthetic fingerprint failure'); },
        store,
        isReusable: () => true,
      });
      assert.deepEqual(throwing.fingerprints, ['', '', '']);
      assert.deepEqual(throwing.pendingIndices, [0, 1, 2], 'an unusable fingerprint is never reused');

      const hostile = partitionBatchForReuse(batch, {
        fingerprintOf: (job, index) => fingerprints[index],
        store,
        isReusable: (row, job, index) => {
          if (index === 0) throw new Error('synthetic validation failure');
          return true;
        },
      });
      assert.deepEqual(hostile.pendingIndices, [0], 'a validation that throws is a pending job');
      assert.deepEqual([...hostile.reused.keys()], [1, 2]);

      const merged = mergeReusedAndScored(3, new Map([[0, { matchScore: 80 }], [2, { matchScore: 60 }]]), [1], [{ matchScore: 70 }]);
      assert.deepEqual(merged, [{ matchScore: 80, index: 0 }, { matchScore: 70 }, { matchScore: 60, index: 2 }], 'reused rows take their own positions with their index');
      assert.equal(merged[1].index, undefined, 'a freshly scored row keeps the provider shape');
      assert.deepEqual(mergeReusedAndScored(2, new Map(), [0, 1], [null, { matchScore: 5 }]), [null, { matchScore: 5 }], 'a missing scored row stays null');
      assert.deepEqual(mergeReusedAndScored(1, new Map([[0, { matchScore: 1 }]]), [], []), [{ matchScore: 1, index: 0 }], 'a fully reused batch needs no scored rows');
      const noMutate = { matchScore: 80 };
      const filled = mergeReusedAndScored(1, new Map([[0, noMutate]]), [], []);
      filled[0].matchScore = 1;
      assert.equal(noMutate.matchScore, 80, 'the reused row is copied, not aliased');
    },
  },
  {
    name: 'Job score reuse: a resumed run re-scores only the changed job and a new run reuses nothing',
    run: async () => {
      const harness = createScoreJobsHarness({ careerData: 'Candidate used alpha tool and beta tool across two synthetic projects.' });
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ic-score-reuse-live-'));
      const canvas = path.join(directory, 'canvas.json');
      const pinnedSnapshotId = 'a1'.repeat(32);
      const sender = {
        id: 7431,
        isDestroyed: () => false,
        once: () => {},
        on: () => {},
        off: () => {},
        removeListener: () => {},
      };
      // A refreshed listing rewrites the prompt-visible text (snippet + body),
      // which is exactly what must invalidate a saved row.
      const jobFor = (n, refreshed = '') => ({
        title: `Synthetic role ${n}`,
        company: `Synthetic employer ${n}`,
        url: `https://example.test/synthetic-score-reuse-${n}`,
        snippet: `Alpha duty ${n} is required${refreshed}`,
        description: `Alpha duty ${n} is required${refreshed}. ${'Synthetic posting detail for this listing. '.repeat(8)}`,
      });
      try {
        await fs.writeFile(canvas, '{}', 'utf8');
        const claim = await claimJobAnalysisOperationAuthority({
          canvasFilePath: canvas,
          hubId: 'synthetic-hub',
          operationId: 'synthetic-score-reuse',
          semanticBase: { kind: 'search', careerSnapshotId: pinnedSnapshotId, runId: 'run-1' },
        });
        __registerJobsHandlersForTests({
          resolvePinnedScoringInput: async () => ({ profile: { workHistory: [] }, careerData: harness.careerData, pinned: true }),
          runScoreBatch: harness.score,
          runGapReview: async () => {
            harness.reviewCalls.push(1);
            throw new Error('synthetic: no gap review is expected for at-or-above-bar scores');
          },
          jobScoreReuseStore: { recall: harness.runMigrations.recall, remember: harness.runMigrations.remember },
        });
        const handler = ipcMain.__getInvokeHandler('score-jobs');
        // The renderer passes the run id in the payload (handleSafe binds the
        // request context from it); bind the same id as the ambient context too.
        const invoke = (jobs, manualAiRunId) => __runWithIpcRequestContextForTests({ manualAiRunId }, async () => {
          const result = await handler({ sender }, {
            jobs,
            manualAiRunId,
            careerSnapshotId: pinnedSnapshotId,
            nodeId: 'synthetic-hub',
            operationAuthority: claim.receipt,
            snapshotContext: { canvasFilePath: canvas, runId: 'run-1' },
          });
          return { result, telemetry: getJobsTelemetry() };
        });
        const byUrl = scoredJobs => new Map((scoredJobs || []).map(job => [job.url, job]));
        const savedRows = runId => harness.runMigrations.values.get(`${runId}\u0000${JOB_SCORE_REUSE_KEY}`)?.rows || {};

        // Call 1 — nothing saved yet, so all three jobs go out in one handoff.
        const first = await invoke([jobFor(1), jobFor(2), jobFor(3)], 'run-reuse');
        assert.equal(first.result.success, true, `first call failed: ${first.result.error}`);
        assert.equal(harness.calls.length, 1);
        assert.deepEqual(harness.calls[0].map(job => job.title), ['Synthetic role 1', 'Synthetic role 2', 'Synthetic role 3'], 'the first call scores every job');
        const firstScores = byUrl(first.result.scoredJobs);
        assert.equal(firstScores.size, 3);
        for (const job of firstScores.values()) assert.equal(job.matchScore, 79, 'one required synthetic gap caps the raw 86 at 79');
        assert.equal(first.telemetry.scoring.reusedScoreCount, 0, 'nothing was reused on a first call');
        assert.equal(Object.keys(savedRows('run-reuse')).length, 3, 'every validated row is saved under the run');

        // Call 2 — job 2's listing was refreshed; jobs 1 and 3 must be reused.
        const second = await invoke([jobFor(1), jobFor(2, ' and now asks for gamma duty'), jobFor(3)], 'run-reuse');
        assert.equal(second.result.success, true, `second call failed: ${second.result.error}`);
        assert.equal(harness.calls.length, 2, 'the resumed batch issues exactly one handoff');
        assert.deepEqual(harness.calls[1].map(job => job.title), ['Synthetic role 2'], 'only the changed job is re-scored');
        const secondScores = byUrl(second.result.scoredJobs);
        assert.equal(secondScores.size, 3, 'reused rows still produce all three cards');
        assert.equal(secondScores.get('https://example.test/synthetic-score-reuse-2').matchScore, 79);
        assert.equal(secondScores.get('https://example.test/synthetic-score-reuse-1').matchScore, 79, 'an unchanged row is reused, not re-scored');
        assert.equal(secondScores.get('https://example.test/synthetic-score-reuse-3').matchScore, 79);
        assert.equal(second.telemetry.scoring.reusedScoreCount, 2, 'exactly the two unchanged jobs were reused');
        assert.equal(Object.keys(savedRows('run-reuse')).length, 4, 'the re-scored job adds its own row instead of replacing the others');
        assert.deepEqual(harness.reviewCalls, [], 'reuse never spends a gap review');

        // Call 3 — a different run id has no saved rows to reuse.
        const third = await invoke([jobFor(1), jobFor(2), jobFor(3)], 'run-other-reuse');
        assert.equal(third.result.success, true, `third call failed: ${third.result.error}`);
        assert.equal(harness.calls.length, 3);
        assert.deepEqual(harness.calls[2].map(job => job.title), ['Synthetic role 1', 'Synthetic role 2', 'Synthetic role 3'], 'reuse is scoped to the run id');
        assert.equal(byUrl(third.result.scoredJobs).size, 3);
        assert.equal(third.telemetry.scoring.reusedScoreCount, 0);
        assert.equal(Object.keys(savedRows('run-other-reuse')).length, 3, 'the other run records only its own rows');
      } finally {
        registerJobsHandlers();
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  },
];
