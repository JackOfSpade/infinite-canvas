/** Focused adversarial contract: a continuation lease is never authority. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  claimJobAnalysisOperationAuthority,
  withCurrentJobAnalysisOperationAuthority,
} from '../../electron/ipc/jobAnalysisOperationAuthorityStore.js';
import { getJobAnalysisPaths } from '../../electron/ipc/jobAnalysisPaths.js';
import {
  beginJobContinuation,
  claimJobContinuation,
  checkpointJobContinuationResult,
  releaseJobContinuationExecution,
} from '../../electron/ipc/jobContinuation.js';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');

export async function runJobContinuationAuthorityContract() {
  const careerSnapshotId = 'a'.repeat(64);
  const sender = { once() {} };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ic-continuation-authority-'));
  const canvas = path.join(dir, 'canvas.json');
  const nodeId = 'hub-contract';
  const parentRunId = 'run-contract';
  const base = {
    kind: 'search', careerSnapshotId, runId: null, analysisRevisionId: null,
    fingerprint: null, continuationId: null, sourceArtifactFingerprint: null,
  };
  try {
    await fs.writeFile(canvas, '{}\n');
    const first = await claimJobAnalysisOperationAuthority({
      canvasFilePath: canvas, hubId: nodeId, operationId: 'contract-s1', semanticBase: base,
    });
    assert.equal(first.admitted, true, 'S1 authority claim must succeed');
    const snapshot = { nodeId, sourceHubId: nodeId, runId: parentRunId, careerSnapshotId, operationAuthority: first.receipt };
    const serialized = `${JSON.stringify(snapshot)}\n`;
    const digest = sha(serialized);
    const paths = getJobAnalysisPaths(canvas, null, nodeId);
    await withCurrentJobAnalysisOperationAuthority({ canvasFilePath: canvas, hubId: nodeId, ...first.receipt }, async (_record, stage) => {
      await stage({ publications: [{ slot: 'current', digest }] });
      await fs.writeFile(paths.jsonPath, serialized, { mode: 0o600 });
      return { ok: true };
    });
    const identity = {
      nodeId, parentRunId, profileFingerprint: 'c'.repeat(64), kind: 'late-source-refresh',
      operation: 'search-jobs-single-source', sourceId: 'usajobs', careerSnapshotId,
      operationAuthority: first.receipt, parentArtifactFingerprint: digest,
      searchWindow: { startTimestamp: 1, endTimestamp: 2 }, canonicalLocation: 'Toronto',
      generationFingerprint: 'generation-contract', recoveryMode: 'automatic', now: Date.now(),
    };
    const started = await beginJobContinuation(canvas, identity);
    assert.equal(started.ok, true, `sealed S1 snapshot permits exact continuation intent: ${JSON.stringify(started)}`);
    const badPin = await beginJobContinuation(canvas, { ...identity, careerSnapshotId: 'b'.repeat(64), now: Date.now() + 1 });
    assert.equal(badPin.ok, false, 'wrong career pin must create no continuation');
    const claimed = await claimJobContinuation(canvas, { ...identity, intentId: started.intent.intentId }, { sender });
    assert.equal(claimed.ok, true, `exact identity claims one execution lease: ${JSON.stringify(claimed)}`);
    const second = await claimJobAnalysisOperationAuthority({
      canvasFilePath: canvas, hubId: nodeId, operationId: 'contract-s2',
      semanticBase: { ...base, kind: 'resolved-source-continuation', runId: parentRunId, continuationId: started.intent.intentId },
      predecessor: first.receipt,
    });
    assert.equal(second.admitted, true, 'S2 supersedes S1 through its exact predecessor');
    assert.equal(releaseJobContinuationExecution(started.intent.intentId, claimed.leaseToken, sender), true);
    const reboundS2 = await claimJobContinuation(canvas, { ...identity, operationAuthority: second.receipt, intentId: started.intent.intentId }, { sender });
    assert.equal(reboundS2.ok, true, 'S2 atomically adopts its exact S1 continuation');
    assert.equal(reboundS2.rebound, true, 'S2 adoption is reported without exposing authority internals');
    const third = await claimJobAnalysisOperationAuthority({
      canvasFilePath: canvas, hubId: nodeId, operationId: 'contract-s3',
      semanticBase: { ...base, kind: 'resume', runId: parentRunId, continuationId: reboundS2.intent.intentId },
      predecessor: second.receipt,
    });
    assert.equal(third.admitted, true, 'S3 is an exact one-step S2 successor');
    const late = await checkpointJobContinuationResult(canvas, {
      nodeId, parentRunId, intentId: reboundS2.intent.intentId, leaseToken: reboundS2.leaseToken,
      operation: 'search-jobs-single-source', careerSnapshotId,
      operationAuthority: second.receipt, parentArtifactFingerprint: digest, result: { success: true, jobs: [] },
    }, { sender });
    assert.equal(late.saved, false, 'late S1 cannot checkpoint after S2');
    assert.equal(late.operationSuperseded, true, 'late S2 cannot checkpoint after S3');
    assert.equal(releaseJobContinuationExecution(reboundS2.intent.intentId, reboundS2.leaseToken, sender), true);
    const reboundS3 = await claimJobContinuation(canvas, { ...identity, operationAuthority: third.receipt, intentId: reboundS2.intent.intentId }, { sender });
    assert.equal(reboundS3.ok, true, `S3 adopts only the immediately rebound S2 continuation: ${JSON.stringify(reboundS3)}`);
    assert.equal(releaseJobContinuationExecution(reboundS3.intent.intentId, reboundS3.leaseToken, sender), true);
    return { assertions: 11, s1ToS3ExactRebind: true };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export default [{
  name: 'job continuation authority contract: sealed parent, exact S1→S2→S3, and late checkpoint fence',
  run: runJobContinuationAuthorityContract,
}];

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runJobContinuationAuthorityContract();
  console.log('job continuation authority contract: 11 assertions passed');
}
