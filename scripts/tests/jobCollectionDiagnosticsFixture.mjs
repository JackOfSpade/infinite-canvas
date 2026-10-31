import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  completeRunWithReceipt,
  finishRunWithSavedListings,
  jobRunPathScopeForCanvas,
  markSourceStatus,
  readLastRunReceipt,
  readRunState,
  sanitizeJobRunCollectionDiagnostics,
  sanitizeLastRunReceipt,
  setStage,
  startRun,
} from '../../electron/ipc/jobRunStaging.js';
import { claimJobAnalysisOperationAuthority } from '../../electron/ipc/jobAnalysisOperationAuthorityStore.js';

const UNKNOWN = { disposition: 'unknown', startedAt: null, completedAt: null, unfinishedSourceCount: null };
const CAREER = 'c'.repeat(64);

async function withRun(work) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-job-collection-diagnostics-'));
  const canvas = path.join(root, 'workspace.json');
  const nodeId = 'collection-diagnostics-hub';
  const runId = 'collection-diagnostics-run';
  try {
    const claimed = await claimJobAnalysisOperationAuthority({
      canvasFilePath: canvas,
      hubId: nodeId,
      operationId: 'collection-diagnostics-operation',
      semanticBase: {
        kind: 'search', careerSnapshotId: CAREER, runId: null,
        analysisRevisionId: null, fingerprint: null, continuationId: null, sourceArtifactFingerprint: null,
      },
    });
    assert.equal(claimed.admitted, true);
    const operationAuthority = claimed.receipt;
    const manifest = await startRun(canvas, {
      nodeId, runId, startedAt: 100, careerSnapshotId: CAREER,
      operationAuthority, sourceIds: ['google', 'remoteok'],
    });
    assert.equal(manifest.runId, runId);
    const ownership = { nodeId, expectedRunId: runId, expectedOperationAuthority: operationAuthority };
    const scope = jobRunPathScopeForCanvas(canvas, nodeId);
    const manifestPath = path.join(scope.dir, `${scope.base}.jobs-run.${scope.canvasHash}.${scope.ownerHash}.json`);
    const receipt = {
      nodeId, runId, operationAuthority, careerSnapshotId: CAREER,
      completedAt: 300, terminal: { status: 'completed', outcome: 'populated', scoreReadyCount: 5 },
    };
    const complete = overrides => completeRunWithReceipt(canvas, { ...receipt, ...overrides }, {
      expectedNodeId: nodeId, expectedCareerSnapshotId: CAREER,
    });
    await work({ canvas, nodeId, runId, ownership, manifestPath, complete });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

export default [
  {
    name: 'job collection diagnostics: fixed schema excludes private payloads and refuses coerced evidence',
    run: () => {
      assert.deepEqual(sanitizeJobRunCollectionDiagnostics(), UNKNOWN);
      assert.deepEqual(sanitizeJobRunCollectionDiagnostics({
        disposition: 'private provider error', startedAt: '100', completedAt: false,
        unfinishedSourceCount: 1001, url: 'https://private.example', career: 'private career text',
      }), UNKNOWN);
      for (const count of [-1, 0.5, '1', Infinity, true]) {
        assert.equal(sanitizeJobRunCollectionDiagnostics({ unfinishedSourceCount: count }).unfinishedSourceCount, null);
      }
      const diagnostic = sanitizeJobRunCollectionDiagnostics({
        disposition: 'unfinished-sources', startedAt: 100, completedAt: 200,
        unfinishedSourceCount: 2, prompt: 'secret', sourceIds: ['private source'],
      });
      assert.deepEqual(diagnostic, { disposition: 'unfinished-sources', startedAt: 100, completedAt: 200, unfinishedSourceCount: 2 });
      assert.deepEqual(sanitizeLastRunReceipt({ terminal: { status: 'completed' } }).collectionDiagnostics, UNKNOWN);
      assert.deepEqual(sanitizeLastRunReceipt({ collectionDiagnostics: diagnostic }).collectionDiagnostics, diagnostic);
    },
  },
  {
    name: 'job collection diagnostics: host gather evidence survives cleanup and exact receipt-only retries',
    run: async () => withRun(async ({ canvas, nodeId, ownership, complete }) => {
      const full = { disposition: 'full', startedAt: 100, completedAt: 200, unfinishedSourceCount: 0 };
      assert.equal(await setStage(canvas, 'gathered', 200, {
        ...ownership, collectionCompletedAt: 200, collectionDiagnostics: { ...full, prompt: 'private' },
      }), true);
      const state = await readRunState(canvas, 201, { nodeId });
      assert.deepEqual(state.manifest.collectionDiagnostics, full);
      // A resumed gather may refresh liveness, but must retain the first
      // collection boundary represented by the host manifest.
      await setStage(canvas, 'gathered', 250, {
        ...ownership, collectionCompletedAt: 250, collectionDiagnostics: { ...full, completedAt: 250 },
      });
      const spoofed = { disposition: 'user-finished-partial', startedAt: 1, completedAt: 2, unfinishedSourceCount: 999 };
      const result = await complete({ collectionDiagnostics: spoofed });
      assert.equal(result.cleared, true);
      assert.deepEqual(result.receipt.collectionDiagnostics, full);
      const retried = await complete({ collectionDiagnostics: spoofed, completedAt: 900 });
      assert.equal(retried.cleared, true);
      assert.deepEqual(retried.receipt.collectionDiagnostics, full);
      assert.equal(retried.receipt.completedAt, 300);
      const saved = await readLastRunReceipt(canvas, { nodeId });
      assert.deepEqual(saved.collectionDiagnostics, full);
      assert.equal(JSON.stringify(saved).includes('private'), false);
    }),
  },
  {
    name: 'job collection diagnostics: explicit partial finish is durable before another search response',
    run: async () => withRun(async ({ canvas, nodeId, ownership, complete }) => {
      await markSourceStatus(canvas, 'remoteok', 'done', 150, ownership);
      const finished = await finishRunWithSavedListings(canvas, { ...ownership, now: 200 });
      assert.equal(finished.marked, true);
      const partial = { disposition: 'user-finished-partial', startedAt: 100, completedAt: 200, unfinishedSourceCount: 1 };
      assert.deepEqual((await readRunState(canvas, 201, { nodeId })).manifest.collectionDiagnostics, partial);
      // An old/general caller must not relabel the user's irreversible choice.
      await setStage(canvas, 'gathered', 250, {
        ...ownership, collectionCompletedAt: 250,
        collectionDiagnostics: { disposition: 'full', startedAt: 100, completedAt: 250, unfinishedSourceCount: 0 },
      });
      assert.deepEqual((await complete()).receipt.collectionDiagnostics, partial);
    }),
  },
  {
    name: 'job collection diagnostics: unfinished gather and manifest read are bounded and ownership fenced',
    run: async () => withRun(async ({ canvas, nodeId, ownership, manifestPath, complete }) => {
      const partial = { disposition: 'unfinished-sources', startedAt: 100, completedAt: 200, unfinishedSourceCount: 1 };
      await setStage(canvas, 'gathered', 200, { ...ownership, collectionCompletedAt: 200, collectionDiagnostics: partial });
      const rejected = await setStage(canvas, 'gathered', 250, {
        ...ownership, expectedRunId: 'different-run', collectionDiagnostics: { disposition: 'full' },
      });
      assert.notEqual(rejected, true);
      const raw = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
      raw.collectionDiagnostics.prompt = 'private manifest content';
      raw.collectionDiagnostics.sourceIds = ['private source'];
      await fs.promises.writeFile(manifestPath, JSON.stringify(raw), 'utf8');
      assert.deepEqual((await readRunState(canvas, 251, { nodeId })).manifest.collectionDiagnostics, partial);
      assert.deepEqual((await complete()).receipt.collectionDiagnostics, partial);
    }),
  },
  {
    name: 'job collection diagnostics: legacy completed sources and terminal success never manufacture full collection',
    run: async () => withRun(async ({ canvas, nodeId, ownership, manifestPath, complete }) => {
      await markSourceStatus(canvas, 'google', 'done', 150, ownership);
      await markSourceStatus(canvas, 'remoteok', 'done', 150, ownership);
      await setStage(canvas, 'gathered', 200, { ...ownership, collectionCompletedAt: 200 });
      const raw = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
      delete raw.collectionDiagnostics;
      await fs.promises.writeFile(manifestPath, JSON.stringify(raw), 'utf8');
      assert.deepEqual((await readRunState(canvas, 201, { nodeId })).manifest.collectionDiagnostics, UNKNOWN);
      const result = await complete({ collectionDiagnostics: {
        disposition: 'full', startedAt: 100, completedAt: 200, unfinishedSourceCount: 0,
      } });
      assert.equal(result.receipt.terminal.status, 'completed');
      assert.deepEqual(result.receipt.collectionDiagnostics, UNKNOWN);
    }),
  },
];
