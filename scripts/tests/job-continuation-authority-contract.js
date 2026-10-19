/** Focused adversarial contract: a continuation lease is never authority. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
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
  listJobContinuations,
  readJobContinuationResult,
  validateJobContinuationAuthority,
  publishJobContinuationParentUpdate,
} from '../../electron/ipc/jobContinuation.js';
import {
  buildJobAnalysisSnapshot,
  __createDescriptionRecoveryCheckpointForTests,
  __saveJobAnalysisSnapshotForTests,
  __saveDescriptionRecoverySnapshotIfCurrentForTests,
  __loadDescriptionRecoveryCheckpointForTests,
} from '../../electron/ipc/jobs.js';

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
    // Exercise the actual renderer claim argument expressions against the host
    // store. A public begin/list response deliberately has no canvasFilePath;
    // tests that spread the original begin inputs masked this IPC regression.
    for (const component of ['JobSourceCardNode', 'JobSearchNode']) {
      const source = await fs.readFile(new URL(`../../src/nodes/${component}.jsx`, import.meta.url), 'utf8');
      const calls = [...source.matchAll(/claimJobContinuation\?\.\((\{[\s\S]*?\n\s*\})\);/g)];
      assert.equal(calls.length, 2, `${component} must exercise both saved and fresh claims`);
      for (const [index, call] of calls.entries()) {
        const sourceRecovery = component === 'JobSourceCardNode';
        const automatic = index === 0;
        const begun = await beginJobContinuation(canvas, {
          ...identity,
          kind: sourceRecovery ? 'source-recovery' : 'late-source-refresh',
          operation: sourceRecovery
            ? (automatic ? 'resume-job-source' : 'resolve-job-source')
            : 'search-jobs-single-source',
          sourceId: sourceRecovery ? 'linkedin' : 'usajobs',
          generationFingerprint: `${component}-${index}`,
          recoveryMode: sourceRecovery && !automatic ? 'manual' : 'automatic',
        });
        assert.equal(begun.ok, true, 'renderer fixture commits a sealed parent checkpoint');
        assert.equal(Object.hasOwn(begun.intent, 'canvasFilePath'), false, 'public intents omit the canvas path');
        const claimArgs = vm.runInNewContext(`(${call[1]})`, {
          continuationIntent: begun.intent,
          continuationIdentity: { canvasFilePath: canvas },
          canvasFilePath: canvas,
        });
        const { canvasFilePath: ownerCanvas, ...unscopedArgs } = claimArgs;
        const unscoped = await claimJobContinuation(undefined, unscopedArgs, { sender });
        assert.equal(unscoped.ok, false, 'the old unscoped IPC envelope is rejected before execution');
        assert.equal(ownerCanvas, canvas, 'renderer supplies the current owning canvas independently of the intent');
        const execution = await claimJobContinuation(ownerCanvas, claimArgs, { sender });
        assert.equal(execution.ok, true, `${component} ${automatic ? 'saved' : 'fresh'} claim: ${JSON.stringify(execution)}`);
        assert.ok(execution.leaseToken, 'claim reaches executable provider ownership');
        assert.equal(releaseJobContinuationExecution(execution.intent.intentId, execution.leaseToken, sender), true);
      }
    }
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
    return { rendererClaimPaths: 4, s1ToS3ExactRebind: true };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export async function runSourceRecoveryPublicationContract() {
  const source = await fs.readFile(new URL('../../electron/ipc/jobs.js', import.meta.url), 'utf8');
  for (const marker of ['const persistRecoveryPool = async', 'const persistSourceRecoveryJobs = async']) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ic-source-publication-'));
    const canvasFilePath = path.join(dir, 'canvas.json');
    const sender = { once() {} };
    let execution;
    try {
      await fs.writeFile(canvasFilePath, '{}');
      const careerSnapshotId = 'a'.repeat(64);
      const claimedAuthority = await claimJobAnalysisOperationAuthority({
        canvasFilePath, hubId: 'hub', operationId: 'source-recovery-contract',
        semanticBase: { kind: 'search', careerSnapshotId },
      });
      const operationAuthority = claimedAuthority.receipt;
      const row = { source: 'linkedin', title: 'Engineer', company: 'Example', url: 'https://example.invalid/job', snippet: 'Job description. '.repeat(50) };
      let snapshot = buildJobAnalysisSnapshot({
        jobs: [row], descriptionRecoveryJobs: [row], profile: {}, careerData: {}, careerSnapshotId,
        operationAuthority, nodeId: 'hub', snapshotContext: { sourceHubId: 'hub', runId: 'run', canvasFilePath },
      }).snapshot;
      await __saveJobAnalysisSnapshotForTests(snapshot);
      assert.equal((await __createDescriptionRecoveryCheckpointForTests(snapshot)).saved, true);
      const begun = await beginJobContinuation(canvasFilePath, {
        nodeId: 'hub', parentRunId: 'run', profileFingerprint: 'c'.repeat(64),
        kind: 'source-recovery', operation: 'resolve-job-source', sourceId: 'linkedin',
        careerSnapshotId, operationAuthority, recoveryMode: 'manual', now: Date.now(),
      });
      assert.equal(begun.ok, true);
      execution = await claimJobContinuation(canvasFilePath, { ...begun.intent, allowManualResume: true }, { sender });
      assert.equal(execution.ok, true);
      const ownership = {
        nodeId: 'hub', parentRunId: 'run', intentId: execution.intent.intentId, leaseToken: execution.leaseToken,
        operation: 'resolve-job-source', careerSnapshotId, operationAuthority,
        parentArtifactFingerprint: execution.intent.parentArtifactFingerprint,
      };
      // Simulate a crash after the durable intent update but before any bytes
      // are published. The old sealed layout must still be usable.
      await assert.rejects(publishJobContinuationParentUpdate(canvasFilePath, {
        ...ownership, nextParentArtifactFingerprint: 'd'.repeat(64),
      }, { sender }, async () => { throw new Error('injected-before-publication'); }), /injected/);
      assert.equal((await validateJobContinuationAuthority(canvasFilePath, ownership, { sender })).ok, true);
      const start = source.indexOf('buildJobAnalysisSnapshot({', source.indexOf(marker));
      const end = source.indexOf('\n      });', start);
      // LinkedIn has deeper indentation than the generic source rebuild.
      const linkedInEnd = source.indexOf('\n          });', start);
      const argumentEnd = marker.includes('persistRecoveryPool') ? linkedInEnd : end;
      const argsExpression = source.slice(start + 'buildJobAnalysisSnapshot('.length, argumentEnd) + '\n' + (marker.includes('persistRecoveryPool') ? '          }' : '      }');
      assert.ok(argumentEnd > start, 'production snapshot rebuild arguments are present');
      for (let pass = 1; pass <= 2; pass++) {
        const jobs = [{ ...row, snippet: `Recovered pass ${pass}. `.repeat(50) }];
        const args = vm.runInNewContext(`(${argsExpression})`, {
          snapshot, sourceRecoverySnapshot: snapshot, scoringJobs: jobs, descriptionRecoveryJobs: jobs,
          descriptionRecoveryState: null, operationAuthority, nodeId: 'hub', canvasFilePath,
        });
        const next = buildJobAnalysisSnapshot(args).snapshot;
        assert.deepEqual(next.operationAuthority, operationAuthority, 'the production rebuild retains write authority');
        const saved = await __saveDescriptionRecoverySnapshotIfCurrentForTests(next, {
          nodeId: 'hub', jobRunId: 'run', sender, continuation: ownership,
        });
        assert.equal(saved.saved, true, JSON.stringify(saved));
        assert.equal(saved.globalSaved, true);
        assert.equal((await __loadDescriptionRecoveryCheckpointForTests(canvasFilePath, 'hub', 'run')).snapshot.jobs[0].snippet, jobs[0].snippet);
        assert.equal((await validateJobContinuationAuthority(canvasFilePath, ownership, { sender })).ok, true, 'own publication preserves exact replay admission');
        snapshot = next;
      }
      let unauthorizedPublish = false;
      const unauthorized = await publishJobContinuationParentUpdate(canvasFilePath, {
        ...ownership, nextParentArtifactFingerprint: 'd'.repeat(64),
      }, { sender: { once() {} } }, async () => { unauthorizedPublish = true; });
      assert.equal(unauthorized.saved, false);
      assert.equal(unauthorizedPublish, false, 'a different sender cannot authorize parent replacement');
      const nextBytes = `${JSON.stringify({ ...snapshot, marker: 'crash-during-publish' })}\n`;
      const nextDigest = sha(nextBytes);
      for (const writeBytes of [false, true]) {
        await assert.rejects(publishJobContinuationParentUpdate(canvasFilePath, {
          ...ownership, nextParentArtifactFingerprint: nextDigest,
        }, { sender }, async stage => {
          await stage({ publications: [{ slot: 'current', digest: nextDigest }] });
          if (writeBytes) await fs.writeFile(getJobAnalysisPaths(canvasFilePath, null, 'hub').jsonPath, nextBytes);
          throw new Error('injected-during-publication');
        }), /injected/);
        assert.equal((await validateJobContinuationAuthority(canvasFilePath, ownership, { sender })).ok, true,
          'both old and new layouts remain admissible around a staged publication crash');
      }
      const result = { resolved: true, items: snapshot.jobs, replaceSourceItems: true };
      assert.equal((await checkpointJobContinuationResult(canvasFilePath, { ...ownership, result }, { sender })).saved, true);
      assert.equal(releaseJobContinuationExecution(execution.intent.intentId, execution.leaseToken, sender), true);
      const [listed] = await listJobContinuations(canvasFilePath, 'hub');
      execution = await claimJobContinuation(canvasFilePath, { ...listed, allowManualResume: true }, { sender });
      assert.equal(execution.ok, true, 'fresh discovery reclaims the updated parent after renderer restart');
      const replay = await readJobContinuationResult(canvasFilePath, { ...ownership, leaseToken: execution.leaseToken }, { sender });
      assert.equal(replay.found, true);
      assert.deepEqual(replay.result, result);
      releaseJobContinuationExecution(execution.intent.intentId, execution.leaseToken, sender);
      const successor = await claimJobAnalysisOperationAuthority({
        canvasFilePath, hubId: 'hub', operationId: 'source-recovery-successor',
        semanticBase: { kind: 'resume', careerSnapshotId, runId: 'run', continuationId: listed.intentId },
        predecessor: operationAuthority,
      });
      assert.equal(successor.admitted, true);
      execution = await claimJobContinuation(canvasFilePath, {
        ...listed, operationAuthority: successor.receipt, allowManualResume: true,
      }, { sender });
      assert.equal(execution.ok, true, 'exact successor adopts the updated parent');
      Object.assign(ownership, {
        intentId: execution.intent.intentId, leaseToken: execution.leaseToken,
        operationAuthority: successor.receipt,
      });
      snapshot = { ...snapshot, operationAuthority: successor.receipt };
      const successorSave = await __saveDescriptionRecoverySnapshotIfCurrentForTests(snapshot, {
        nodeId: 'hub', jobRunId: 'run', sender, continuation: ownership,
      });
      assert.equal(successorSave.saved, true, 'a rebound continuation publishes with its current authority');
      assert.equal((await validateJobContinuationAuthority(canvasFilePath, ownership, { sender })).ok, true);
      // An unrelated same-authority rewrite is still not an admitted parent.
      await __saveJobAnalysisSnapshotForTests({ ...snapshot, marker: 'unregistered-rewrite' });
      assert.equal((await validateJobContinuationAuthority(canvasFilePath, { ...ownership, leaseToken: execution.leaseToken }, { sender })).ok, false);
    } finally {
      if (execution?.leaseToken) releaseJobContinuationExecution(execution.intent.intentId, execution.leaseToken, sender);
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
}

export default [{
  name: 'job continuation authority contract: renderer claim scope, sealed parent, exact S1→S2→S3, and late checkpoint fence',
  run: runJobContinuationAuthorityContract,
}, {
  name: 'source recovery publication preserves authority and exact restart replay for LinkedIn and generic rebuilds',
  run: runSourceRecoveryPublicationContract,
}];

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runJobContinuationAuthorityContract();
  await runSourceRecoveryPublicationContract();
  console.log('job continuation authority contract passed, including all 4 renderer claim paths');
}
