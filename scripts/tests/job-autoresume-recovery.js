import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  beginJobContinuation,
  checkpointJobContinuationResult,
  claimJobContinuation,
  clearJobContinuations,
  completeJobContinuation,
  __jobContinuationPathForTests,
  listJobContinuations,
  pauseJobContinuations,
  readJobContinuationResult,
  rebindJobContinuationOwners,
  releaseJobContinuationExecution,
  validateJobContinuationExecution,
} from '../../electron/ipc/jobContinuation.js';
import {
  claimJobBoardRunExecution,
  releaseJobBoardRunExecution,
  validateJobBoardRunExecution,
} from '../../electron/ipc/jobBoardRunLease.js';
import {
  acquireCanvasRecoveryRead,
  withCanvasRecoveryOwner,
  withCanvasRecoveryRebind,
} from '../../electron/ipc/canvasRecoveryPaths.js';
import { claimJobAnalysisOperationAuthority, withCurrentJobAnalysisOperationAuthority } from '../../electron/ipc/jobAnalysisOperationAuthorityStore.js';
import { getJobAnalysisPaths, rebindJobAnalysisRecoveryOwners } from '../../electron/ipc/jobAnalysisPaths.js';
import {
  JOB_RUN_COLLECTION_DISPOSITION,
  clearRunWithResult,
  finishRunWithSavedListings,
  isJobRunAutomaticRecoveryEligible,
  markSourceStatus,
  readRunState,
  recordSourcePage,
  startRun,
} from '../../electron/ipc/jobRunStaging.js';
import {
  backgroundJobResumeRequest,
  createWorkspaceStartupRecoveryCoordinator,
  hiddenJobContinuationEntry,
  workspaceStartupRecoverySignature,
} from '../../src/utils/workspaceStartupRecovery.js';
import {
  jobContinuationAppliedReceipt,
  upsertJobContinuationAppliedReceipt,
} from '../../src/utils/jobContinuationReceipt.js';
import { moduleFingerprint } from '../../src/nodes/jobboard/mergeJobs.js';
import { normalizeJobCollectionLimits } from '../../src/utils/jobCollectionLimits.js';
import {
  prepareBackgroundBoardChildRequest,
  validateBackgroundBoardChildRequest,
} from '../../src/utils/jobBoardBackgroundRecovery.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sender(id) {
  return { id, once() {} };
}

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

const profileFingerprint = 'b'.repeat(64);

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

// Continuation tests must exercise the same provenance boundary as production:
// a claimed authority has sealed the exact parent artifact before an intent is
// admitted.  This deliberately does not fake a renderer-derived digest.
async function sealContinuationIdentity(canvasFilePath, identity, { careerSnapshotId = 'a'.repeat(64) } = {}) {
  const operation = await claimJobAnalysisOperationAuthority({
    canvasFilePath,
    hubId: identity.nodeId,
    operationId: `test-cont-${sha256(`${canvasFilePath}:${identity.nodeId}:${identity.parentRunId}:${identity.generationFingerprint || ''}`).slice(0, 24)}`,
    semanticBase: {
      kind: 'search', careerSnapshotId, runId: null, analysisRevisionId: null,
      fingerprint: null, continuationId: null, sourceArtifactFingerprint: null,
    },
  });
  if (!operation.admitted || !operation.receipt) throw new Error('fixture could not claim continuation authority');
  const snapshot = {
    canvasFilePath,
    nodeId: identity.nodeId,
    sourceHubId: identity.nodeId,
    runId: identity.parentRunId,
    careerSnapshotId,
    operationAuthority: operation.receipt,
  };
  const serialized = `${JSON.stringify(snapshot)}\n`;
  const parentArtifactFingerprint = sha256(serialized);
  const paths = getJobAnalysisPaths(canvasFilePath, null, identity.nodeId);
  const sealed = await withCurrentJobAnalysisOperationAuthority({
    canvasFilePath, hubId: identity.nodeId, ...operation.receipt,
  }, async (_record, stage) => {
    await stage({ publications: [{ slot: 'current', digest: parentArtifactFingerprint }] });
    await fs.promises.writeFile(paths.jsonPath, serialized, { mode: 0o600 });
    return { ok: true };
  });
  if (!sealed.admitted) throw new Error('fixture could not seal continuation parent artifact');
  return {
    ...identity,
    careerSnapshotId,
    operationAuthority: operation.receipt,
    parentArtifactFingerprint,
  };
}

export default [
  {
    name: 'job continuation leases are canvas-scoped and terminal receipts survive the same-process autosave gap',
    run: async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-job-continuation-lease-'));
      const canvasA = path.join(dir, 'a.json');
      const canvasB = path.join(dir, 'b.json');
      fs.writeFileSync(canvasA, '{}');
      fs.writeFileSync(canvasB, '{}');
      const identity = {
        nodeId: 'same-hub',
        parentRunId: 'same-run',
        profileFingerprint,
        kind: 'late-source-refresh',
        operation: 'search-jobs-single-source',
        sourceId: 'usajobs',
        searchWindow: { startTimestamp: 100, anchorTimestamp: 100, providerLookbackDays: 1 },
        canonicalLocation: 'Toronto, ON',
        generationFingerprint: 'done:generation',
        operationInput: { query: 'engineer', sourceId: 'usajobs' },
      };
      const senderA = sender(1);
      const senderB = sender(2);
      const senderC = sender(3);
      try {
        const identityA = await sealContinuationIdentity(canvasA, identity);
        const identityB = await sealContinuationIdentity(canvasB, identity);
        const begunA = await beginJobContinuation(canvasA, { ...identityA, recoveryMode: 'automatic', now: 101 });
        const begunB = await beginJobContinuation(canvasB, { ...identityB, recoveryMode: 'automatic', now: 101 });
        assert(begunA.ok && begunB.ok && begunA.intent.intentId !== begunB.intent.intentId,
          'the sealed authority receipt is part of the continuation identity, so cloned canvases cannot borrow one another’s capability');

        const claimA = await claimJobContinuation(canvasA, {
          ...identityA, intentId: begunA.intent.intentId, autoResume: true, automaticOperation: 'execute',
        }, { sender: senderA });
        const claimB = await claimJobContinuation(canvasB, {
          ...identityB, intentId: begunB.intent.intentId, autoResume: true, automaticOperation: 'execute',
        }, { sender: senderB });
        const duplicateA = await claimJobContinuation(canvasA, {
          ...identityA, intentId: begunA.intent.intentId,
        }, { sender: senderC });
        assert(claimA.ok && claimB.ok && duplicateA.busy,
          'different canvases may claim their own exact continuations while one canvas remains single-owner');
        assert(validateJobContinuationExecution(
          begunA.intent.intentId, claimA.leaseToken, senderA, canvasA,
        ) && !validateJobContinuationExecution(
          begunA.intent.intentId, claimA.leaseToken, senderA, canvasB,
        ), 'a cloned-canvas request cannot borrow another canvas lease before provider side effects');

        const checkpoint = await checkpointJobContinuationResult(canvasA, {
          nodeId: identity.nodeId,
          parentRunId: identity.parentRunId,
          intentId: begunA.intent.intentId,
          leaseToken: claimA.leaseToken,
          operation: identity.operation,
          careerSnapshotId: identityA.careerSnapshotId,
          operationAuthority: identityA.operationAuthority,
          parentArtifactFingerprint: identityA.parentArtifactFingerprint,
          result: { success: true, jobs: [{ id: 'durable-result' }], warning: null },
        }, { sender: senderA });
        assert(checkpoint.saved && checkpoint.resultKey && checkpoint.processEpoch,
          `terminal provider output is durable before its invoke can reply: ${JSON.stringify(checkpoint)}`);
        const sameProcessAck = await completeJobContinuation(canvasA, {
          nodeId: identity.nodeId,
          parentRunId: identity.parentRunId,
          intentId: begunA.intent.intentId,
          operation: identity.operation,
          leaseToken: claimA.leaseToken,
          careerSnapshotId: identityA.careerSnapshotId,
          operationAuthority: identityA.operationAuthority,
          parentArtifactFingerprint: identityA.parentArtifactFingerprint,
          expectedResultKey: checkpoint.resultKey,
          appliedProcessEpoch: checkpoint.processEpoch,
        }, { sender: senderA });
        assert(!sameProcessAck.ok && sameProcessAck.reason === 'same-process-autosave-unproven',
          `same-process React application cannot delete the only durable copy before canvas autosave: ${JSON.stringify(sameProcessAck)}`);

        releaseJobContinuationExecution(begunA.intent.intentId, claimA.leaseToken, senderA);
        releaseJobContinuationExecution(begunB.intent.intentId, claimB.leaseToken, senderB);
        const replayClaim = await claimJobContinuation(canvasA, {
          ...identityA,
          intentId: begunA.intent.intentId,
          autoResume: true,
          automaticOperation: 'replay',
        }, { sender: senderC });
        const replay = await readJobContinuationResult(canvasA, {
          nodeId: identity.nodeId,
          parentRunId: identity.parentRunId,
          intentId: begunA.intent.intentId,
          leaseToken: replayClaim.leaseToken,
          careerSnapshotId: identityA.careerSnapshotId,
          operationAuthority: identityA.operationAuthority,
          parentArtifactFingerprint: identityA.parentArtifactFingerprint,
        }, { sender: senderC });
        assert(replay.found && replay.result?.jobs?.[0]?.id === 'durable-result'
          && replay.resultKey === checkpoint.resultKey,
        'a crash/remount before autosave replays the exact staged terminal result without provider work');
        releaseJobContinuationExecution(begunA.intent.intentId, replayClaim.leaseToken, senderC);

        const restarted = await import(`../../electron/ipc/jobContinuation.js?restart=${Date.now()}`);
        const restartClaim = await restarted.claimJobContinuation(canvasA, {
          ...identityA, intentId: begunA.intent.intentId, autoResume: true, automaticOperation: 'replay',
        }, { sender: senderC });
        const laterAck = await restarted.completeJobContinuation(canvasA, {
          nodeId: identity.nodeId,
          parentRunId: identity.parentRunId,
          intentId: begunA.intent.intentId,
          operation: identity.operation,
          leaseToken: restartClaim.leaseToken,
          careerSnapshotId: identityA.careerSnapshotId,
          operationAuthority: identityA.operationAuthority,
          parentArtifactFingerprint: identityA.parentArtifactFingerprint,
          expectedResultKey: checkpoint.resultKey,
          appliedProcessEpoch: checkpoint.processEpoch,
        }, { sender: senderC });
        assert(restartClaim.ok && laterAck.ok && laterAck.removed && (await listJobContinuations(canvasA, identity.nodeId)).length === 0,
          'only a later process observing the exact saved result receipt may retire the terminal sidecar');

        const attemptedAgainB = await claimJobContinuation(canvasB, {
          ...identityB, intentId: begunB.intent.intentId, autoResume: true, automaticOperation: 'execute',
        }, { sender: senderB });
        assert(attemptedAgainB.attempted,
          'one-shot automatic attempts remain scoped to their own canvas and operation');

        const symlinkCanvas = path.join(dir, 'symlink.json');
        fs.writeFileSync(symlinkCanvas, '{}');
        const sidecarPath = __jobContinuationPathForTests(symlinkCanvas, identity.nodeId);
        const foreign = path.join(dir, 'foreign.json');
        fs.writeFileSync(foreign, JSON.stringify({ version: 1, nodeId: identity.nodeId, intents: [] }));
        fs.symlinkSync(foreign, sidecarPath);
        assert((await listJobContinuations(symlinkCanvas, identity.nodeId)).length === 0,
          'continuation reads reject symlink substitution instead of following an attacker-selected file');
        return { clonedCanvasesIndependent: true, terminalReplayDurable: true, symlinkRejected: true };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'canvas recovery reads are exact-owner reentrant and continuation stop/retire cannot deadlock behind Save As',
    run: async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-job-reentrant-recovery-'));
      const leaseCanvas = path.join(dir, 'lease-before.json');
      const leaseCanvasAfter = path.join(dir, 'lease-after.json');
      fs.writeFileSync(leaseCanvas, '{}');
      fs.writeFileSync(leaseCanvasAfter, '{}');
      const owner = sender(31);
      const stranger = sender(32);
      try {
        const outer = await acquireCanvasRecoveryRead(leaseCanvas, { owner });
        let writerEntered = false;
        let releaseWriter;
        const writerHold = new Promise(resolve => { releaseWriter = resolve; });
        const writer = withCanvasRecoveryRebind(leaseCanvas, leaseCanvasAfter, async ({ installAlias }) => {
          writerEntered = true;
          installAlias();
          await writerHold;
          return { success: true };
        });
        await nextTurn();
        assert(!writerEntered, 'a Save As writer waits for the original long-lived reader');

        let strangerSettled = false;
        const strangerRead = acquireCanvasRecoveryRead(leaseCanvasAfter, { owner: stranger })
          .then((lease) => { strangerSettled = true; return lease; });
        const nested = await acquireCanvasRecoveryRead(leaseCanvas, { owner });
        assert(!writerEntered && !strangerSettled,
          'the exact existing owner may nest past a queued writer while another sender remains fenced');
        outer.release();
        await nextTurn();
        assert(!writerEntered,
          'releasing the outer read does not let the writer pass while its same-owner nested read remains');
        nested.release();
        await nextTurn();
        assert(writerEntered && !strangerSettled,
          'the writer starts after all owner refs drain and still excludes a different reader');
        releaseWriter();
        await writer;
        const strangerLease = await strangerRead;
        strangerLease.release();

        const identity = {
          nodeId: 'hub-stop',
          parentRunId: 'run-stop',
          profileFingerprint,
          kind: 'source-recovery',
          operation: 'resume-job-source',
          sourceId: 'indeed',
          searchWindow: { startTimestamp: 100, anchorTimestamp: 100, providerLookbackDays: 1 },
          canonicalLocation: 'Toronto, ON',
          generationFingerprint: 'generation-stop',
          operationInput: { sourceId: 'indeed', resumeState: { mode: 'retry-descriptions', jobs: [] } },
        };
        const stopBefore = path.join(dir, 'stop-before.json');
        const stopAfter = path.join(dir, 'stop-after.json');
        fs.writeFileSync(stopBefore, '{}');
        fs.writeFileSync(stopAfter, '{}');
        const stopIdentity = await sealContinuationIdentity(stopBefore, identity);
        const begun = await beginJobContinuation(stopBefore, { ...stopIdentity, recoveryMode: 'automatic', now: 200 });
        const claimed = await claimJobContinuation(stopBefore, {
          ...stopIdentity, intentId: begun.intent.intentId,
        }, { sender: owner });
        let stopWriterEntered = false;
        const stopRebind = withCanvasRecoveryRebind(stopBefore, stopAfter, async ({ installAlias }) => {
          stopWriterEntered = true;
          const analysis = await rebindJobAnalysisRecoveryOwners(stopBefore, stopAfter, { alreadyExclusive: true });
          const migrated = analysis.success ? await rebindJobContinuationOwners(stopBefore, stopAfter) : { success: false };
          if (migrated.success && analysis.success) installAlias();
          return { ...migrated, success: migrated.success && analysis.success, analysis };
        });
        await nextTurn();
        const paused = await withCanvasRecoveryOwner(owner, () => pauseJobContinuations(stopBefore, {
          nodeId: identity.nodeId,
          parentRunId: identity.parentRunId,
          intentId: begun.intent.intentId,
          careerSnapshotId: stopIdentity.careerSnapshotId,
          operationAuthority: stopIdentity.operationAuthority,
          parentArtifactFingerprint: stopIdentity.parentArtifactFingerprint,
          now: 201,
        }));
        assert(paused.ok && paused.paused === 1 && !stopWriterEntered,
          'Stop durably marks the exact continuation manual through its existing read before abort/release');
        releaseJobContinuationExecution(begun.intent.intentId, claimed.leaseToken, owner);
        const stopMoved = await stopRebind;
        assert(stopMoved.success, `Save As proceeds after the stopped execution releases: ${JSON.stringify(stopMoved)}`);
        const pausedAfter = (await listJobContinuations(stopAfter, identity.nodeId))[0];
        assert(pausedAfter?.recoveryMode === 'manual', 'the migrated continuation retains the durable Stop tombstone');

        const clearOwner = sender(33);
        const clearClaim = await claimJobContinuation(stopAfter, {
          ...pausedAfter,
          intentId: pausedAfter.intentId,
          allowManualResume: true,
        }, { sender: clearOwner });
        const clearAfter = path.join(dir, 'clear-after.json');
        fs.writeFileSync(clearAfter, '{}');
        let clearWriterEntered = false;
        const clearRebind = withCanvasRecoveryRebind(stopAfter, clearAfter, async ({ installAlias }) => {
          clearWriterEntered = true;
          const analysis = await rebindJobAnalysisRecoveryOwners(stopAfter, clearAfter, { alreadyExclusive: true });
          const migrated = analysis.success ? await rebindJobContinuationOwners(stopAfter, clearAfter) : { success: false };
          if (migrated.success && analysis.success) installAlias();
          return { ...migrated, success: migrated.success && analysis.success, analysis };
        });
        await nextTurn();
        const cleared = await withCanvasRecoveryOwner(clearOwner, () => clearJobContinuations(stopAfter, {
          nodeId: identity.nodeId,
          parentRunId: identity.parentRunId,
          intentId: pausedAfter.intentId,
          careerSnapshotId: pausedAfter.careerSnapshotId,
          operationAuthority: pausedAfter.operationAuthority,
          parentArtifactFingerprint: pausedAfter.parentArtifactFingerprint,
        }));
        assert(cleared.ok && cleared.removed === 1 && !clearWriterEntered,
          `explicit Clear can durably tombstone/remove its exact active continuation before cancellation: ${JSON.stringify({ cleared, clearClaim, pausedAfter })}`);
        releaseJobContinuationExecution(pausedAfter.intentId, clearClaim.leaseToken, clearOwner);
        assert((await clearRebind).success, 'Clear releases the long read so a queued Save As can finish');
        assert((await listJobContinuations(clearAfter, identity.nodeId)).length === 0,
          'a cleared continuation cannot reappear at the adopted path');

        const successBefore = path.join(dir, 'success-before.json');
        const successAfter = path.join(dir, 'success-after.json');
        fs.writeFileSync(successBefore, '{}');
        fs.writeFileSync(successAfter, '{}');
        const successIdentity = { ...identity, nodeId: 'hub-success', parentRunId: 'run-success', generationFingerprint: 'generation-success' };
        const sealedSuccessIdentity = await sealContinuationIdentity(successBefore, successIdentity);
        const successBegun = await beginJobContinuation(successBefore, { ...sealedSuccessIdentity, recoveryMode: 'automatic', now: 300 });
        const successClaim = await claimJobContinuation(successBefore, {
          ...sealedSuccessIdentity, intentId: successBegun.intent.intentId,
        }, { sender: owner });
        const terminal = await checkpointJobContinuationResult(successBefore, {
          nodeId: successIdentity.nodeId,
          parentRunId: successIdentity.parentRunId,
          intentId: successBegun.intent.intentId,
          leaseToken: successClaim.leaseToken,
          operation: successIdentity.operation,
          careerSnapshotId: sealedSuccessIdentity.careerSnapshotId,
          operationAuthority: sealedSuccessIdentity.operationAuthority,
          parentArtifactFingerprint: sealedSuccessIdentity.parentArtifactFingerprint,
          result: { resolved: true, items: [{ id: 'saved-before-rebind' }] },
        }, { sender: owner });
        const successRebind = withCanvasRecoveryRebind(successBefore, successAfter, async ({ installAlias }) => {
          const analysis = await rebindJobAnalysisRecoveryOwners(successBefore, successAfter, { alreadyExclusive: true });
          const migrated = analysis.success ? await rebindJobContinuationOwners(successBefore, successAfter) : { success: false };
          if (migrated.success && analysis.success) installAlias();
          return { ...migrated, success: migrated.success && analysis.success, analysis };
        });
        await nextTurn();
        releaseJobContinuationExecution(successBegun.intent.intentId, successClaim.leaseToken, owner);
        assert((await successRebind).success, 'terminal success releases before its queued Save As writer');
        const stagedAfter = (await listJobContinuations(successAfter, successIdentity.nodeId))[0];
        assert(terminal.saved && stagedAfter?.terminalResultKey === terminal.resultKey,
          'successful provider output remains staged after release/rebind until a later persisted receipt');

        const retireBefore = path.join(dir, 'retire-before.json');
        const retireAfter = path.join(dir, 'retire-after.json');
        fs.writeFileSync(retireBefore, '{}');
        fs.writeFileSync(retireAfter, '{}');
        const retireIdentity = { ...identity, nodeId: 'hub-retire', parentRunId: 'run-retire', generationFingerprint: 'generation-retire' };
        const sealedRetireIdentity = await sealContinuationIdentity(retireBefore, retireIdentity);
        const retireBegun = await beginJobContinuation(retireBefore, { ...sealedRetireIdentity, recoveryMode: 'automatic', now: 400 });
        const retireClaim = await claimJobContinuation(retireBefore, {
          ...sealedRetireIdentity, intentId: retireBegun.intent.intentId,
        }, { sender: stranger });
        const retireRebind = withCanvasRecoveryRebind(retireBefore, retireAfter, async ({ installAlias }) => {
          const analysis = await rebindJobAnalysisRecoveryOwners(retireBefore, retireAfter, { alreadyExclusive: true });
          const migrated = analysis.success ? await rebindJobContinuationOwners(retireBefore, retireAfter) : { success: false };
          if (migrated.success && analysis.success) installAlias();
          return { ...migrated, success: migrated.success && analysis.success, analysis };
        });
        await nextTurn();
        releaseJobContinuationExecution(retireBegun.intent.intentId, retireClaim.leaseToken, stranger);
        assert((await retireRebind).success, 'supersession releases its execution before sidecar retirement');
        const retiredIntent = (await listJobContinuations(retireAfter, retireIdentity.nodeId))[0];
        const retireAckClaim = await claimJobContinuation(retireAfter, {
          ...retiredIntent, intentId: retiredIntent.intentId,
        }, { sender: stranger });
        const retired = await completeJobContinuation(retireBefore, {
          nodeId: retireIdentity.nodeId,
          parentRunId: retireIdentity.parentRunId,
          intentId: retiredIntent.intentId,
          operation: retireIdentity.operation,
          // Reclaim after the migration so the acknowledgement has an exact
          // active execution lease at the adopted owner path.
          leaseToken: retireAckClaim.leaseToken,
          careerSnapshotId: retiredIntent.careerSnapshotId,
          operationAuthority: retiredIntent.operationAuthority,
          parentArtifactFingerprint: retiredIntent.parentArtifactFingerprint,
          superseded: true,
        }, { sender: stranger });
        assert(retireAckClaim.ok && retired.ok && retired.removed && (await listJobContinuations(retireAfter, retireIdentity.nodeId)).length === 0,
          'retirement follows the adopted alias and cannot deadlock or leave an orphan');

        const sourceCard = fs.readFileSync(path.resolve('src/nodes/JobSourceCardNode.jsx'), 'utf8');
        const jobSearch = fs.readFileSync(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8');
        for (const [label, source] of [['JobSource', sourceCard], ['JobSearch', jobSearch]]) {
          const releaseAt = source.indexOf('await window.electronAPI?.releaseJobContinuation?.');
          const retireAt = source.indexOf('if (shouldRetireSupersededContinuation)', releaseAt);
          assert(releaseAt >= 0 && retireAt > releaseAt,
            `${label} must release its long read before a superseded sidecar mutation`);
        }
        return {
          exactOwnerReentrant: true,
          stopAndClearDurableBeforeAbort: true,
          successAndRetireReleaseBeforeMutation: true,
        };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'continuation destructive rebind converges after partial unlink failure and last-file removal fsyncs its directory',
    run: async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-job-continuation-rebind-failure-'));
      const before = path.join(dir, 'before.json');
      const after = path.join(dir, 'after.json');
      fs.writeFileSync(before, '{}');
      fs.writeFileSync(after, '{}');
      const base = {
        parentRunId: 'run',
        profileFingerprint,
        kind: 'late-source-refresh',
        operation: 'search-jobs-single-source',
        sourceId: 'usajobs',
        searchWindow: { startTimestamp: 100, anchorTimestamp: 100, providerLookbackDays: 1 },
        canonicalLocation: 'Toronto, ON',
        operationInput: { query: 'engineer', sourceId: 'usajobs' },
      };
      const oldUnlink = fs.promises.unlink;
      const oldOpen = fs.promises.open;
      try {
        for (const [index, nodeId] of ['hub-a', 'hub-b'].entries()) {
          const identity = await sealContinuationIdentity(before, {
            ...base, nodeId, generationFingerprint: `generation-${nodeId}`,
          });
          const begun = await beginJobContinuation(before, {
            ...identity,
            recoveryMode: 'automatic',
            now: 100 + index,
          });
          assert(begun.ok, `fixture continuation ${nodeId} must be durable`);
        }
        const oldPaths = new Set([
          __jobContinuationPathForTests(before, 'hub-a'),
          __jobContinuationPathForTests(before, 'hub-b'),
        ]);
        let oldDeletes = 0;
        fs.promises.unlink = async (target, ...args) => {
          if (oldPaths.has(target) && ++oldDeletes === 2) {
            const error = new Error('injected second source unlink failure');
            error.code = 'EIO';
            throw error;
          }
          return oldUnlink.call(fs.promises, target, ...args);
        };
        // Production migrates sealed analysis artifacts first, so the
        // continuation copier can atomically rebind its parent byte digest.
        const analysisFirst = await rebindJobAnalysisRecoveryOwners(before, after);
        assert(analysisFirst.success, 'fixture must move sealed parent artifacts before continuation sidecars');
        const interrupted = await rebindJobContinuationOwners(before, after);
        assert(!interrupted.success && oldDeletes === 2,
          'the fixture interrupts after deletion has begun, not during the copy phase');
        assert(fs.existsSync(__jobContinuationPathForTests(after, 'hub-a'))
          && fs.existsSync(__jobContinuationPathForTests(after, 'hub-b')),
        'durable destination copies survive once destructive source deletion starts');
        fs.promises.unlink = oldUnlink;
        const retried = await rebindJobContinuationOwners(before, after);
        const authorityRebind = analysisFirst;
        assert(retried.success && authorityRebind.success
          && (await listJobContinuations(after, 'hub-a')).length === 1
          && (await listJobContinuations(after, 'hub-b')).length === 1,
        `an idempotent replay accepts identical destinations and converges the remaining source deletion: ${JSON.stringify({ retried, authorityRebind })}`);

        let directorySyncOpens = 0;
        fs.promises.open = async (target, flags, ...args) => {
          if (target === dir && flags === 'r') directorySyncOpens += 1;
          return oldOpen.call(fs.promises, target, flags, ...args);
        };
        const hubAIntent = (await listJobContinuations(after, 'hub-a'))[0];
        const cleared = await clearJobContinuations(after, {
          nodeId: 'hub-a', parentRunId: 'run', intentId: hubAIntent?.intentId,
          careerSnapshotId: hubAIntent?.careerSnapshotId,
          operationAuthority: hubAIntent?.operationAuthority,
          parentArtifactFingerprint: hubAIntent?.parentArtifactFingerprint,
        });
        assert(cleared.ok && cleared.removed === 1 && directorySyncOpens > 0,
          'removing a continuation store’s last file fsyncs the parent directory before acknowledgement');
        return { partialDeleteReplayConverged: true, lastFileDirectoryFsynced: true };
      } finally {
        fs.promises.unlink = oldUnlink;
        fs.promises.open = oldOpen;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Job Board process lease survives wait contention and fences Save As across old/new paths',
    run: async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-job-board-lease-'));
      const oldCanvas = path.join(dir, 'before.json');
      const newCanvas = path.join(dir, 'after.json');
      fs.writeFileSync(oldCanvas, '{}');
      fs.writeFileSync(newCanvas, '{}');
      const a = sender(11);
      const b = sender(12);
      const c = sender(13);
      try {
        const first = await claimJobBoardRunExecution({
          canvasFilePath: oldCanvas, nodeId: 'board', boardRunId: 'run', operation: 'hidden-provider',
        }, { sender: a });
        const duplicate = await claimJobBoardRunExecution({
          canvasFilePath: oldCanvas, nodeId: 'board', boardRunId: 'run', operation: 'board-orchestration',
        }, { sender: b });
        assert(first.ok && duplicate.busy, 'all Board phases share one process-wide owner lease');

        const waiterPromise = claimJobBoardRunExecution({
          canvasFilePath: oldCanvas,
          nodeId: 'board',
          boardRunId: 'run',
          operation: 'hidden-provider',
          autoResume: true,
          waitForRelease: true,
        }, { sender: b });
        await Promise.resolve();
        assert(releaseJobBoardRunExecution({
          canvasFilePath: oldCanvas, nodeId: 'board', boardRunId: 'run', claimToken: first.claimToken,
        }, { sender: a }), 'exact first Board owner releases');
        const waiter = await waiterPromise;
        assert(waiter.ok, 'wait-for-release commits its one-shot marker only after the recursive claim succeeds');
        releaseJobBoardRunExecution({
          canvasFilePath: oldCanvas, nodeId: 'board', boardRunId: 'run', claimToken: waiter.claimToken,
        }, { sender: b });
        const repeated = await claimJobBoardRunExecution({
          canvasFilePath: oldCanvas,
          nodeId: 'board', boardRunId: 'run', operation: 'hidden-provider', autoResume: true,
        }, { sender: b });
        assert(repeated.attempted, 'the completed logical automatic attempt is one-shot');

        const cleanup = await claimJobBoardRunExecution({
          canvasFilePath: oldCanvas,
          nodeId: 'board', boardRunId: 'run', operation: 'board-cleanup', autoResume: true,
        }, { sender: a });
        assert(cleanup.ok, 'cleanup has its own automatic phase after provider release');
        releaseJobBoardRunExecution({
          canvasFilePath: oldCanvas, nodeId: 'board', boardRunId: 'run', claimToken: cleanup.claimToken,
        }, { sender: a });
        const combine = await claimJobBoardRunExecution({
          canvasFilePath: oldCanvas,
          nodeId: 'board', boardRunId: 'run', operation: 'board-combine', autoResume: true,
        }, { sender: a });
        assert(combine.ok, 'combine can follow cleanup but cannot overlap it');
        releaseJobBoardRunExecution({
          canvasFilePath: oldCanvas, nodeId: 'board', boardRunId: 'run', claimToken: combine.claimToken,
        }, { sender: a });

        const duringRebind = await claimJobBoardRunExecution({
          canvasFilePath: oldCanvas, nodeId: 'board-2', boardRunId: 'run-2', operation: 'board-orchestration',
        }, { sender: a });
        let rebindEntered = false;
        const rebind = withCanvasRecoveryRebind(oldCanvas, newCanvas, async ({ installAlias }) => {
          rebindEntered = true;
          installAlias();
          return { success: true };
        });
        let newClaimSettled = false;
        const newClaimPromise = claimJobBoardRunExecution({
          canvasFilePath: newCanvas, nodeId: 'board-2', boardRunId: 'run-2', operation: 'board-orchestration',
        }, { sender: c }).then((value) => { newClaimSettled = true; return value; });
        await new Promise(resolve => setTimeout(resolve, 0));
        assert(!rebindEntered && !newClaimSettled,
          'Save As reserves both spellings before draining the old-path Board reader');
        releaseJobBoardRunExecution({
          canvasFilePath: oldCanvas, nodeId: 'board-2', boardRunId: 'run-2', claimToken: duringRebind.claimToken,
        }, { sender: a });
        await rebind;
        const afterRebind = await newClaimPromise;
        assert(afterRebind.ok, 'new-path Board claim starts only after rebind installs the canonical owner');
        releaseJobBoardRunExecution({
          canvasFilePath: newCanvas, nodeId: 'board-2', boardRunId: 'run-2', claimToken: afterRebind.claimToken,
        }, { sender: c });
        return { waitedOnce: true, cleanupCombineSerialized: true, rebindFenced: true };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'saved nested Job Search fails closed for legacy browser blocks while safe title-bearing providers auto-advance only to the AI boundary',
    run: async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-saved-job-card-'));
      const canvas = path.join(dir, 'saved-card.json');
      fs.writeFileSync(canvas, '{}');
      const nodeId = 'saved-hub';
      const runId = 'saved-run';
      const careerSnapshotId = 'a'.repeat(64);
      const queries = Array.from({ length: 16 }, (_, index) => `software engineer ${index + 1}`);
      const doneSources = ['linkedin', 'remoteok', 'weworkremotely', 'ziprecruiter', 'dice', 'usajobs'];
      const legacyBlockedSources = ['google', 'indeed', 'glassdoor'];
      const allSources = [...doneSources, ...legacyBlockedSources];
      const node = {
        id: nodeId,
        type: 'jobhub',
        data: {
          hubState: 'empty',
          jobRunId: null,
          careerSnapshotId,
          resumeProfile: { name: 'Candidate', locations: ['Toronto, ON'] },
          resumeFingerprint: profileFingerprint,
          canonicalLocation: 'Toronto, ON',
          preferredLocation: 'Toronto, ON',
          queries,
          resolvedRoles: ['Software Engineer'],
          resolvedRolesMeta: { derivedAt: '2026-10-01T00:00:00.000Z' },
          searchBriefPlan: { titles: ['Software Engineer'] },
          enabledSourceIds: allSources,
          collectionLimits: { jobsPerPlatform: null, pagesPerPlatform: null },
        },
      };
      try {
        const admitted = await claimJobAnalysisOperationAuthority({
          canvasFilePath: canvas,
          hubId: nodeId,
          operationId: 'saved-card-fixture-operation',
          semanticBase: {
            kind: 'fixture-fresh', careerSnapshotId, runId,
            fingerprint: profileFingerprint, analysisRevisionId: null,
            continuationId: null, sourceArtifactFingerprint: null,
          },
        });
        assert(admitted?.admitted === true && admitted?.receipt,
          'the current-format saved-card fixture must claim a durable analysis authority before staging');
        const operationAuthority = admitted.receipt;
        const started = await startRun(canvas, {
          runId,
          startedAt: 100,
          queries,
          profileFingerprint,
          careerSnapshotId,
          operationAuthority,
          requireCareerSnapshot: true,
          targetRole: '',
          jobPreferences: 'Software engineering roles',
          jobPreferencePlan: { titles: ['Software Engineer'] },
          canonicalLocation: 'Toronto, ON',
          searchWindow: { startTimestamp: 1, anchorTimestamp: 1, providerLookbackDays: 21 },
          collectionLimits: node.data.collectionLimits,
          nodeId,
          sourceIds: allSources,
        });
        assert(started?.runId === runId || started === true,
          'the saved-card fixture must own an exact staged run');
        let written = 0;
        for (let sourceIndex = 0; sourceIndex < doneSources.length; sourceIndex += 1) {
          const sourceId = doneSources[sourceIndex];
          const count = sourceIndex === doneSources.length - 1 ? 687 : 686;
          const jobs = Array.from({ length: count }, (_, index) => ({
            id: `${sourceId}-${index}`,
            title: `Software Engineer ${written + index}`,
            url: `https://example.test/${sourceId}/${index}`,
          }));
          written += count;
          await recordSourcePage(canvas, {
            sourceId,
            query: queries[0],
            page: 1,
            jobs,
            now: 110 + sourceIndex,
            expectedRunId: runId,
            nodeId,
            expectedOperationAuthority: operationAuthority,
          });
          await markSourceStatus(canvas, sourceId, 'done', 120 + sourceIndex, {
            expectedRunId: runId,
            nodeId,
            expectedOperationAuthority: operationAuthority,
          });
        }
        for (let index = 0; index < legacyBlockedSources.length; index += 1) {
          // Browser login/CAPTCHA work is explicitly durable-manual. A missing
          // legacy disposition is retryable, so only this recorded human gate
          // may keep startup recovery paused.
          await markSourceStatus(canvas, legacyBlockedSources[index], 'blocked', 140 + index, {
            expectedRunId: runId,
            nodeId,
            expectedOperationAuthority: operationAuthority,
            recoveryDisposition: 'manual',
          });
        }
        const state = await readRunState(canvas, 200, { nodeId });
        assert(state?.incomplete && state.stagedJobs.length === 4_117 && written === 4_117,
          'the sanitized empty card still discovers all 4,117 rows from its exact sidecar');
        assert(!isJobRunAutomaticRecoveryEligible(state.manifest),
          'durably manual browser sources stay paused at startup');
        const sourceSummary = Object.entries(state.manifest.sources).map(([id, source]) => ({
          id,
          status: source.status,
          recoveryDisposition: source.recoveryDisposition || null,
        }));
        const offer = {
          found: true,
          incomplete: true,
          stage: state.manifest.stage,
          runId,
          gatheredCount: state.stagedJobs.length,
          totalSources: sourceSummary.length,
          doneSources: sourceSummary.filter(source => source.status === 'done' || source.status === 'skipped').length,
          sourceSummary,
          autoResumeEligible: isJobRunAutomaticRecoveryEligible(state.manifest),
          unfinishedSourceIds: sourceSummary
            .filter(source => source.status !== 'done' && source.status !== 'skipped')
            .map(source => source.id),
          nodeId,
          queries,
          targetRole: '',
          jobPreferences: state.manifest.inputs.jobPreferences,
          jobPreferencePlan: state.manifest.inputs.jobPreferencePlan,
          canonicalLocation: state.manifest.inputs.canonicalLocation,
          locationRecorded: true,
          searchWindow: state.manifest.inputs.searchWindow,
          profileFingerprint,
        };
        const root = { id: 'group', type: 'group', data: { canvasData: { nodes: [node], edges: [] } } };
        const nestedPlan = await createWorkspaceStartupRecoveryCoordinator({
          peekJobRun: async () => offer,
          listJobContinuations: async () => [],
        }).discover({ canvasFilePath: canvas, rootNodes: [root] });
        assert(!nestedPlan.some(entry => entry.kind === 'jobhub' && entry.state === 'ready'),
          'hidden startup never launches human-ambiguous Google/Indeed/Glassdoor recovery');
        assert(backgroundJobResumeRequest(node, offer, canvas) === null,
          'the background request builder independently refuses a durable manual/legacy-blocked run');

        const safeTitleOffer = {
          ...offer,
          autoResumeEligible: true,
          unfinishedSourceIds: ['linkedin', 'remoteok', 'weworkremotely', 'dice', 'usajobs'],
        };
        const safeRequest = backgroundJobResumeRequest(node, safeTitleOffer, canvas);
        assert(safeRequest?.providerPhaseOnly === true && safeRequest.resumeRunId === runId,
          'title-bearing API-safe providers resume with the exact token and stop before semantic screening');
        assert(backgroundJobResumeRequest(node, {
          ...safeTitleOffer, unfinishedSourceIds: [],
        }, canvas) === null,
        'after safe providers finish, hidden startup pauses for the mounted role-screen/bridge');
        const browserRequest = backgroundJobResumeRequest(node, {
          ...safeTitleOffer, unfinishedSourceIds: ['google', 'indeed', 'ziprecruiter', 'glassdoor'],
        }, canvas);
        assert(browserRequest?.providerPhaseOnly === true && browserRequest.resumeRunId === runId,
          'an auto-eligible interrupted browser source inherits the exact provider-only recovery capability');

        const finish = await finishRunWithSavedListings(canvas, {
          expectedRunId: runId,
          nodeId,
          expectedOperationAuthority: operationAuthority,
          now: 250,
        });
        const finishedState = await readRunState(canvas, 251, { nodeId });
        assert(finish.ok && finish.marked
          && finishedState.manifest.collectionDisposition === JOB_RUN_COLLECTION_DISPOSITION.USER_FINISHED_PARTIAL
          && finishedState.stagedJobs.length === 4_117,
        'Finish with saved listings durably preserves every staged row and records a no-provider disposition');
        assert(doneSources.every(sourceId => finishedState.manifest.sources[sourceId].status === 'done')
          && legacyBlockedSources.every(sourceId => finishedState.manifest.sources[sourceId].status === 'blocked'),
        'six completed sources remain reusable and the three blocked providers are never relabelled or retried by Finish');

        const jobSearchSource = fs.readFileSync(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8');
        const jobsMainSource = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
        assert(jobSearchSource.includes('>Finish with saved listings</button>')
          && jobSearchSource.includes('Resume continues only remaining sources from their per-query checkpoints; an interrupted load-more query may replay from its first view'),
        'mounting the sanitized card surfaces both exact Resume and Finish-with-saved actions');
        assert(jobsMainSource.includes("if (priorSources[sid]?.status === 'done' || priorSources[sid]?.status === 'skipped') continue")
          && jobsMainSource.includes('skipProviderCollection = finishSavedRecoveryRequested || resumeGatheredOnly')
          && jobsMainSource.includes('BACKGROUND_PROVIDER_ONLY_SOURCE_IDS'),
        'main reuses completed sources, makes Finish network-free, and revalidates the safe provider-only allow-list');
        return {
          legacyBrowserBlocksManual: true,
          stagedRowsRecovered: finishedState.stagedJobs.length,
          safeTitleProvidersSplitBeforeAi: true,
          finishIsNetworkFree: true,
        };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'nested startup dispatches exact unfinished providers once and never replays terminal work',
    run: async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-startup-provider-dispatch-'));
      const canvas = path.join(dir, 'workspace.json');
      fs.writeFileSync(canvas, '{}');
      const nodeId = 'startup-hub';
      const queries = ['platform engineer'];
      const node = {
        id: nodeId,
        type: 'jobhub',
        data: {
          hubState: 'empty',
          resumeProfile: { name: 'Candidate', locations: ['Toronto, ON'] },
          resumeFingerprint: profileFingerprint,
          canonicalLocation: 'Toronto, ON',
          preferredLocation: 'Toronto, ON',
          queries,
          enabledSourceIds: ['remoteok', 'indeed'],
          collectionLimits: { jobsPerPlatform: null, pagesPerPlatform: null },
        },
      };
      const root = { id: 'group', type: 'group', data: { canvasData: { nodes: [node], edges: [] } } };
      const careerSnapshotId = 'c'.repeat(64);
      node.data.careerSnapshotId = careerSnapshotId;
      const authorityForRun = new Map();
      const startCurrentFixtureRun = async (runId, startedAt, sourceIds) => {
        const admitted = await claimJobAnalysisOperationAuthority({
          canvasFilePath: canvas,
          hubId: nodeId,
          operationId: `startup-fixture-${runId}`,
          semanticBase: {
            kind: 'fixture-fresh', careerSnapshotId, runId,
            fingerprint: profileFingerprint, analysisRevisionId: null,
            continuationId: null, sourceArtifactFingerprint: null,
          },
        });
        assert(admitted?.admitted === true && admitted?.receipt,
          `fixture run ${runId} must have a current durable authority`);
        authorityForRun.set(runId, admitted.receipt);
        return startRun(canvas, {
          runId, startedAt, queries, profileFingerprint, careerSnapshotId,
          operationAuthority: admitted.receipt, requireCareerSnapshot: true,
          canonicalLocation: 'Toronto, ON', nodeId, sourceIds,
        });
      };

      const offerFromState = (state) => {
        const sourceSummary = Object.entries(state.manifest.sources || {}).map(([id, source]) => ({
          id,
          status: source?.status || 'pending',
          recoveryDisposition: source?.recoveryDisposition || null,
        }));
        return {
          found: true,
          incomplete: true,
          nodeId,
          runId: state.manifest.runId,
          stage: state.manifest.stage,
          queries,
          canonicalLocation: 'Toronto, ON',
          locationRecorded: true,
          profileFingerprint,
          careerSnapshotId: state.manifest.inputs.careerSnapshotId,
          operationAuthority: state.manifest.inputs.operationAuthority,
          searchWindow: state.manifest.inputs.searchWindow,
          sourceSummary,
          unfinishedSourceIds: sourceSummary
            .filter(source => source.status !== 'done' && source.status !== 'skipped')
            .map(source => source.id),
          autoResumeEligible: isJobRunAutomaticRecoveryEligible(state.manifest),
        };
      };
      const dispatches = [];
      const startup = async () => {
        // This is the actual hidden-workspace coordinator. The small executor
        // below deliberately records the one request it authorizes rather
        // than reproducing the source-selection policy in the test.
        const coordinator = createWorkspaceStartupRecoveryCoordinator({
          peekJobRun: async () => offerFromState(await readRunState(canvas, Date.now(), { nodeId })),
          listJobContinuations: async () => [],
        });
        const plan = await coordinator.discover({ canvasFilePath: canvas, rootNodes: [root] });
        for (const entry of plan.filter(entry => entry.kind === 'jobhub' && entry.state === 'ready')) {
          dispatches.push({ request: entry.request, unfinishedSourceIds: entry.offer.unfinishedSourceIds });
        }
        return plan;
      };

      try {
        await startCurrentFixtureRun('all-terminal', 100, ['remoteok', 'indeed']);
        await markSourceStatus(canvas, 'remoteok', 'done', 101, { expectedRunId: 'all-terminal', nodeId, expectedOperationAuthority: authorityForRun.get('all-terminal') });
        await markSourceStatus(canvas, 'indeed', 'skipped', 102, { expectedRunId: 'all-terminal', nodeId, expectedOperationAuthority: authorityForRun.get('all-terminal') });
        const terminalPlan = await startup();
        assert(dispatches.length === 0
          && terminalPlan.some(entry => entry.kind === 'jobhub' && entry.state === 'awaiting-mounted-recovery'),
        'an all-terminal manifest must produce no startup search/resume dispatch');

        // Replace the completed fixture with a new exact run: Indeed is
        // terminal, while the HTTP-only RemoteOK source is the sole safe
        // unfinished provider. This models a real crash after partial work.
        const reset = await clearRunWithResult(canvas, { expectedRunId: 'all-terminal', expectedNodeId: nodeId, expectedOperationAuthority: authorityForRun.get('all-terminal') });
        assert(reset?.cleared === true, 'the all-terminal fixture must clear before installing the partial run');
        await startCurrentFixtureRun('safe-partial', 200, ['remoteok', 'indeed']);
        await markSourceStatus(canvas, 'indeed', 'done', 201, { expectedRunId: 'safe-partial', nodeId, expectedOperationAuthority: authorityForRun.get('safe-partial') });
        const safePlan = await startup();
        assert(dispatches.length === 1
          && safePlan.filter(entry => entry.kind === 'jobhub' && entry.state === 'ready').length === 1
          && dispatches[0].request?.resume === true
          && dispatches[0].request?.resumeRunId === 'safe-partial'
          && dispatches[0].request?.providerPhaseOnly === true
          && JSON.stringify(dispatches[0].unfinishedSourceIds) === JSON.stringify(['remoteok']),
        'startup must issue one exact provider-only request for the sole safe unfinished source, never the completed source');

        // Persisting the terminal transition is the important second-startup
        // boundary: a new coordinator must not replay the request it issued
        // before the app stopped again.
        await markSourceStatus(canvas, 'remoteok', 'done', 202, { expectedRunId: 'safe-partial', nodeId, expectedOperationAuthority: authorityForRun.get('safe-partial') });
        const secondStartupPlan = await startup();
        assert(dispatches.length === 1
          && secondStartupPlan.some(entry => entry.kind === 'jobhub' && entry.state === 'awaiting-mounted-recovery'),
        'after the safe source is durably done, a second startup must make zero provider calls');

        const safeReset = await clearRunWithResult(canvas, { expectedRunId: 'safe-partial', expectedNodeId: nodeId, expectedOperationAuthority: authorityForRun.get('safe-partial') });
        assert(safeReset?.cleared === true, 'the safe partial fixture must clear before installing the browser-only run');
        await startCurrentFixtureRun('browser-only', 300, ['google', 'indeed', 'ziprecruiter', 'glassdoor']);
        const browserPlan = await startup();
        assert(dispatches.length === 2
          && browserPlan.filter(entry => entry.kind === 'jobhub' && entry.state === 'ready').length === 1
          && dispatches[1].request?.resumeRunId === 'browser-only'
          && dispatches[1].request?.providerPhaseOnly === true
          && JSON.stringify(dispatches[1].unfinishedSourceIds) === JSON.stringify(['google', 'indeed', 'ziprecruiter', 'glassdoor']),
        'an auto-eligible browser-only unfinished run must receive one exact unattended provider recovery request');
        return { terminalDispatches: 0, safeDispatches: 1, secondStartupDispatches: 0, browserDispatches: 1 };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'hidden Board between children bootstraps only its exact cached-query unattended child under the process lease',
    run: async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-hidden-board-next-child-'));
      const canvas = path.join(dir, 'board.json');
      fs.writeFileSync(canvas, '{}');
      const startedAt = Date.now();
      const preferences = 'Software engineering roles';
      const preferredLocation = 'Toronto, Ontario, Canada';
      const careerSnapshotId = 'a'.repeat(64);
      const nextChild = {
        id: 'child-next',
        type: 'jobhub',
        data: {
          hubState: 'empty',
          resumeProfile: { name: 'Candidate' },
          resumeFingerprint: profileFingerprint,
          careerSnapshotId,
          careerDerivedSnapshotId: careerSnapshotId,
          queryCareerSnapshotId: careerSnapshotId,
          jobPreferences: preferences,
          searchBriefPlan: { titles: ['Software Engineer'] },
          jobPreferencePlan: { titles: ['Software Engineer'] },
          resolvedRoles: ['Software Engineer'],
          resolvedRolesMeta: { derivedAt: '2026-10-01T00:00:00.000Z', careerSnapshotId },
          queries: {
            targetRoleQueries: ['software engineer'],
            titleQueries: ['backend engineer'],
            suggestedRoleQueries: [],
            skillsOnlyQueries: [],
          },
          queryCacheKey: JSON.stringify({
            strategyVersion: 7,
            careerSnapshotId,
            resumeFingerprint: profileFingerprint,
            jobPreferences: preferences,
            preferredLocation,
          }),
          preferredLocation,
          canonicalLocation: preferredLocation,
          canonicalCountry: 'Canada',
          enabledSourceIds: ['linkedin', 'remoteok', 'weworkremotely', 'dice', 'usajobs'],
          collectionLimits: { jobsPerPlatform: 50, pagesPerPlatform: 3 },
        },
      };
      const prepared = prepareBackgroundBoardChildRequest({
        node: nextChild,
        boardNodeId: 'board',
        boardRunId: 'board-run',
        startedAt,
        canvasFilePath: canvas,
      });
      assert(prepared?.request?.providerPhaseOnly === true
        && prepared.request.enabledSourceIds.every(sourceId => ['linkedin', 'remoteok', 'weworkremotely', 'dice', 'usajobs'].includes(sourceId)),
      'the Board freezes a provider-only request only from cached queries and unattended-safe sources');
      const completedChild = {
        id: 'child-done',
        type: 'jobhub',
        data: { hubState: 'done', jobRunId: 'done-run', resultDisposition: 'scored', resumeProfile: { name: 'Candidate' } },
      };
      const board = {
        id: 'board',
        type: 'jobboard',
        data: {
          boardScanResume: {
            version: 1,
            boardRunId: 'board-run',
            startedAt,
            phase: 'searches',
            autoResumeEligible: true,
            selectedSearchModuleIds: ['child-done', 'child-next'],
            completedSourceRuns: { 'child-done': { runId: 'done-run', resultDisposition: 'scored', fingerprint: 'done' } },
            incompleteSearches: [],
            activeSourceId: null,
            activeSourceIds: [],
            awaitingSourceResolution: null,
            awaitingSourceResolutions: [],
            backgroundChildRequests: { 'child-next': prepared },
          },
        },
      };
      const edges = [
        { id: 'board-done', source: 'board', target: 'child-done' },
        { id: 'board-next', source: 'board', target: 'child-next' },
      ];
      const root = { id: 'group', type: 'group', data: { canvasData: { nodes: [board, completedChild, nextChild], edges } } };
      try {
        const adoptedCanvas = path.join(dir, 'board-save-as.json');
        fs.writeFileSync(adoptedCanvas, '{}');
        const adopted = validateBackgroundBoardChildRequest(
          prepared,
          nextChild,
          board.data.boardScanResume,
          adoptedCanvas,
        );
        assert(adopted?.request?.canvasFilePath === adoptedCanvas
          && adopted.inputKey === prepared.inputKey,
        'Save As adopts the current canonical canvas owner without changing the frozen child input');
        const coordinator = createWorkspaceStartupRecoveryCoordinator({
          peekJobRun: async () => ({ found: false }),
          listJobContinuations: async () => [],
        });
        const plan = await coordinator.discover({ canvasFilePath: canvas, rootNodes: [root] });
        const bootstrap = plan.find(entry => entry.kind === 'jobboard-child-bootstrap');
        assert(bootstrap?.nodeId === 'board'
          && bootstrap.childNodeId === 'child-next'
          && bootstrap.runId === 'board-run'
          && bootstrap.request?.canvasFilePath === canvas
          && JSON.stringify(bootstrap.request?.queries) === JSON.stringify(prepared.request.queries),
        'a hidden Board between children selects its first unfinished exact prepared child without mounting the subcanvas');

        const boardSender = sender(41);
        const otherSender = sender(42);
        const claim = await claimJobBoardRunExecution({
          canvasFilePath: canvas,
          nodeId: 'board',
          boardRunId: 'board-run',
          operation: 'hidden-provider',
          autoResume: true,
        }, { sender: boardSender });
        assert(claim.ok && validateJobBoardRunExecution({
          canvasFilePath: canvas,
          nodeId: 'board',
          boardRunId: 'board-run',
          operation: 'hidden-provider',
          claimToken: claim.claimToken,
        }, { sender: boardSender }),
        'the provider bootstrap is admitted only under its exact process-wide Board claim');
        assert(!validateJobBoardRunExecution({
          canvasFilePath: canvas,
          nodeId: 'board',
          boardRunId: 'board-run',
          operation: 'hidden-provider',
          claimToken: claim.claimToken,
        }, { sender: otherSender }),
        'another window cannot borrow the Board token before provider side effects');
        releaseJobBoardRunExecution({
          canvasFilePath: canvas,
          nodeId: 'board',
          boardRunId: 'board-run',
          claimToken: claim.claimToken,
        }, { sender: boardSender });

        const unsafeChild = {
          ...nextChild,
          data: { ...nextChild.data, enabledSourceIds: ['indeed'] },
        };
        assert(prepareBackgroundBoardChildRequest({
          node: unsafeChild,
          boardNodeId: 'board',
          boardRunId: 'board-run',
          startedAt,
          canvasFilePath: canvas,
        }) === null,
        'a native/login/CAPTCHA-capable next child remains awaiting Board hydration');
        const changedRoot = {
          ...root,
          data: { canvasData: { nodes: [board, completedChild, unsafeChild], edges } },
        };
        const unsafePlan = await createWorkspaceStartupRecoveryCoordinator({
          peekJobRun: async () => ({ found: false }),
          listJobContinuations: async () => [],
        }).discover({ canvasFilePath: canvas, rootNodes: [changedRoot] });
        assert(!unsafePlan.some(entry => entry.kind === 'jobboard-child-bootstrap')
          && unsafePlan.some(entry => entry.kind === 'jobboard' && entry.state === 'awaiting-board-hydration'),
        'changed or unsafe prepared inputs fail closed instead of launching a fresh substitute');

        const hookSource = fs.readFileSync(path.resolve('src/hooks/useWorkspaceStartupRecovery.js'), 'utf8');
        const mainSource = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
        assert(hookSource.includes("entry.kind === 'jobboard-child-bootstrap'")
          && hookSource.includes('boardRecoveryClaim:'),
        'the hidden executor forwards the process claim with the frozen child request');
        assert(mainSource.includes('validateJobBoardRunExecution({')
          && mainSource.includes('(!hasExactResumeToken && !backgroundBoardProviderBootstrap)'),
        'main rejects fresh provider-only work unless the exact Board execution owns it');
        return { betweenChildrenBootstrapped: true, crossWindowTokenRejected: true, unsafeChildPaused: true };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'hidden Job continuations run only exact headless work and preserve terminal replay until later-process receipt',
    run: async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-hidden-job-continuation-'));
      const canvas = path.join(dir, 'nested.json');
      fs.writeFileSync(canvas, '{}');
      const resumeState = {
        mode: 'retry-descriptions',
        jobs: [{ key: 'job-1', title: 'Engineer', url: 'https://example.test/job-1' }],
      };
      const careerSnapshotId = 'd'.repeat(64);
      const admitted = await claimJobAnalysisOperationAuthority({
        canvasFilePath: canvas,
        hubId: 'child',
        operationId: 'hidden-continuation-fixture-operation',
        semanticBase: {
          kind: 'fixture-fresh', careerSnapshotId, runId: 'child-run',
          fingerprint: profileFingerprint, analysisRevisionId: null,
          continuationId: null, sourceArtifactFingerprint: null,
        },
      });
      assert(admitted?.admitted === true && admitted?.receipt,
        'the hidden continuation fixture must begin with a current durable authority');
      const operationAuthority = admitted.receipt;
      const hubData = {
        resumeProfile: { name: 'Candidate' },
        resumeFingerprint: profileFingerprint,
        jobRunId: 'child-run',
        hubState: 'sources-ready',
        canonicalLocation: 'Toronto, ON',
        preferredLocation: 'Toronto, ON',
        searchWindow: { startTimestamp: 100, anchorTimestamp: 100, providerLookbackDays: 1 },
        enabledSourceIds: ['indeed'],
        collectionLimits: { jobsPerPlatform: 10 },
        resultDisposition: 'incomplete',
        scoredJobs: [],
        pendingJobs: [{ id: 'pending' }],
        careerSnapshotId,
        analysisOperation: { operationId: operationAuthority.operationId, authority: operationAuthority },
      };
      const progress = {
        jobRunId: 'child-run',
        status: 'error',
        warning: { code: 'description-missing', severity: 'block', resumeState },
      };
      const collectionLimits = normalizeJobCollectionLimits(hubData.collectionLimits);
      const identityInput = {
        nodeId: 'child',
        parentRunId: 'child-run',
        profileFingerprint,
        kind: 'source-recovery',
        operation: 'resume-job-source',
        sourceId: 'indeed',
        searchWindow: hubData.searchWindow,
        canonicalLocation: hubData.canonicalLocation,
        generationFingerprint: `${hubData.resultDisposition}:${moduleFingerprint(hubData.scoredJobs)}:${moduleFingerprint(hubData.pendingJobs)}`,
        operationInput: {
          sourceId: 'indeed',
          resumeState,
          collectionLimits,
          enabledSourceIds: hubData.enabledSourceIds,
          preferredLocation: hubData.canonicalLocation,
        },
      };
      const identity = await sealContinuationIdentity(canvas, identityInput, { careerSnapshotId });
      const board = {
        id: 'board', type: 'jobboard', data: { boardScanResume: {
          version: 1,
          boardRunId: 'board-run',
          startedAt: 100,
          phase: 'searches',
          autoResumeEligible: true,
          selectedSearchModuleIds: ['child'],
          activeSourceId: 'child',
          activeSourceIds: ['child'],
          awaitingSourceResolution: { sourceId: 'child', jobRunId: 'child-run' },
          completedSourceRuns: {},
        } },
      };
      const hub = { id: 'child', type: 'jobhub', data: hubData };
      const card = { id: 'card', type: 'jobsourcecard', data: { hubId: 'child', sourceId: 'indeed', persistedProgress: progress } };
      const edge = { id: 'board-child', source: 'board', target: 'child' };
      const root = { id: 'group', type: 'group', data: { canvasData: { nodes: [board, hub, card], edges: [edge] } } };
      const runner = sender(21);
      try {
        const begun = await beginJobContinuation(canvas, { ...identity, recoveryMode: 'automatic', now: 200 });
        const coordinator = createWorkspaceStartupRecoveryCoordinator({
          listJobContinuations: args => listJobContinuations(args.canvasFilePath, args.nodeId),
          peekJobRun: async () => ({ found: false }),
        });
        const firstPlan = await coordinator.discover({ canvasFilePath: canvas, rootNodes: [root] });
        const ready = firstPlan.find(entry => entry.kind === 'jobcontinuation');
        assert(ready?.state === 'ready'
          && ready.boardOwner?.orchestratorNodeId === 'board'
          && ready.request?.resumeState?.mode === 'retry-descriptions',
        'an exact paused Board child may resume only its headless description retry while hidden');

        const nativeIntent = {
          ...begun.intent,
          operation: 'resume-job-source',
          recoveryMode: 'automatic',
        };
        const nativeHub = { ...hub, data: { ...hubData } };
        const nativeCard = { ...card, data: { ...card.data, persistedProgress: {
          ...progress, warning: { ...progress.warning, resumeState: { mode: 'native-challenge' } },
        } } };
        assert(hiddenJobContinuationEntry({
          node: nativeHub,
          nodes: [board, nativeHub, nativeCard],
          edges: [edge],
          intent: nativeIntent,
          canvasFilePath: canvas,
        }) === null, 'native challenge/login/CAPTCHA recovery never gains hidden-start consent');

        const claimed = await claimJobContinuation(canvas, {
          ...identity, intentId: begun.intent.intentId,
        }, { sender: runner });
        const checkpoint = await checkpointJobContinuationResult(canvas, {
          nodeId: 'child', parentRunId: 'child-run', intentId: begun.intent.intentId,
          leaseToken: claimed.leaseToken, operation: 'resume-job-source',
          careerSnapshotId: identity.careerSnapshotId,
          operationAuthority: identity.operationAuthority,
          parentArtifactFingerprint: identity.parentArtifactFingerprint,
          result: { resolved: true, items: [{ id: 'recovered' }], replaceMatchingItems: true },
        }, { sender: runner });
        releaseJobContinuationExecution(begun.intent.intentId, claimed.leaseToken, runner);
        const terminalPlan = await createWorkspaceStartupRecoveryCoordinator({
          listJobContinuations: args => listJobContinuations(args.canvasFilePath, args.nodeId),
        }).discover({ canvasFilePath: canvas, rootNodes: [root] });
        assert(terminalPlan.find(entry => entry.kind === 'jobcontinuation')?.state === 'awaiting-mounted-replay',
          'hidden provider completion leaves its terminal payload staged for exact mounted replay');

        const terminalIntent = (await listJobContinuations(canvas, 'child'))[0];
        const applied = jobContinuationAppliedReceipt(terminalIntent, checkpoint, 300);
        hub.data.jobContinuationAppliedReceipts = upsertJobContinuationAppliedReceipt(hub.data, applied);
        const sameEpochPlan = await createWorkspaceStartupRecoveryCoordinator({
          listJobContinuations: args => listJobContinuations(args.canvasFilePath, args.nodeId),
        }).discover({ canvasFilePath: canvas, rootNodes: [root] });
        assert(sameEpochPlan.find(entry => entry.kind === 'jobcontinuation')?.state === 'awaiting-canvas-save',
          'same-process remount neither replays nor acknowledges a terminal result already applied to React state');

        const restarted = await import(`../../electron/ipc/jobContinuation.js?hidden-restart=${Date.now()}`);
        const laterPlan = await createWorkspaceStartupRecoveryCoordinator({
          listJobContinuations: args => restarted.listJobContinuations(args.canvasFilePath, args.nodeId),
        }).discover({ canvasFilePath: canvas, rootNodes: [root] });
        assert(laterPlan.find(entry => entry.kind === 'jobcontinuation')?.state === 'terminal-ack-ready',
          'a later process recognizes the exact persisted resultKey receipt and may retire without replay');
        return { boardPausedOwnerExact: true, nativeManual: true, hiddenTerminalReplayDurable: true };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'nested recovery signature ignores position/style churn but tracks recovery ownership and inputs',
    run: () => {
      const nested = {
        id: 'nested', type: 'jobhub', position: { x: 1, y: 2 }, style: { opacity: 1 },
        data: { resumeProfile: { name: 'Candidate' }, resumeFingerprint: profileFingerprint, jobRunId: 'run-a' },
      };
      const root = { id: 'group', type: 'group', data: { canvasData: { nodes: [nested], edges: [] } } };
      const moved = { ...root, data: { canvasData: { nodes: [{
        ...nested, position: { x: 900, y: -300 }, style: { opacity: 0.4 },
      }], edges: [] } } };
      const changed = { ...root, data: { canvasData: { nodes: [{
        ...nested, data: { ...nested.data, jobRunId: 'run-b' },
      }], edges: [] } } };
      assert(workspaceStartupRecoverySignature([root]) === workspaceStartupRecoverySignature([moved]),
        'drag/layout-only rootNodes recreation must not trigger sidecar discovery or Settings reads');
      assert(workspaceStartupRecoverySignature([root]) !== workspaceStartupRecoverySignature([changed]),
        'a recovery generation change must invalidate startup discovery');
      let priorSignature = null;
      let sidecarDiscoveries = 0;
      let settingsReads = 0;
      const runRecoveryEffect = (nodes) => {
        const signature = workspaceStartupRecoverySignature(nodes);
        if (signature === priorSignature) return;
        priorSignature = signature;
        sidecarDiscoveries += 1;
        settingsReads += 1;
      };
      runRecoveryEffect([root]);
      runRecoveryEffect([moved]);
      assert(sidecarDiscoveries === 1 && settingsReads === 1,
        'position-only updates cause zero additional sidecar discovery or Settings reads');
      runRecoveryEffect([changed]);
      assert(sidecarDiscoveries === 2 && settingsReads === 2,
        'a recovery-relevant generation change re-runs discovery exactly once');
      const hookSource = fs.readFileSync(path.resolve('src/hooks/useWorkspaceStartupRecovery.js'), 'utf8');
      assert(hookSource.includes('recoverySignature, updateNodeDataGlobally')
        && !hookSource.includes('moduleRunQueue, rootNodes, updateNodeDataGlobally'),
      'the effect is keyed by the recovery signature rather than ReactFlow array identity');
      assert(hookSource.includes("const publishQueued = (position) =>")
        && hookSource.includes("const publishRunning = () =>")
        && hookSource.includes("const publishSettled = ({ providerSettled }) =>")
        && hookSource.includes("onStart: publishRunning")
        && hookSource.includes("providerPhaseAwaitingResume: true"),
      'a hidden job-provider recovery publishes queued/running/settled card state, so a card mounted mid-run cannot queue a duplicate resume behind it');
      return { positionIgnored: true, recoveryChangeObserved: true };
    },
  },
  {
    name: 'mounted Job Search and Job Board require an explicit Continue at every saved manual-AI boundary',
    run: () => {
      const searchSource = fs.readFileSync(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8');
      const boardSource = fs.readFileSync(path.resolve('src/nodes/JobBoardNode.jsx'), 'utf8');
      const selectorSource = fs.readFileSync(path.resolve('src/nodes/jobboard/JobBoardSearchSelection.jsx'), 'utf8');
      const mainSource = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');

      assert(searchSource.includes('manualAiExplicitResumeRequest?.runId !== resume.runId')
        && searchSource.includes('Continuing explicitly selected manual AI run')
        && !searchSource.includes('Auto-resuming manual AI run'),
      'a mounted Job Search exposes the exact saved handoff but does not invoke it without the Continue action');
      const automaticProviderResumeStart = searchSource.indexOf('// Unexpected app/window interruption resumes without another click.');
      const automaticProviderResumeEnd = searchSource.indexOf('const handleFinishWithSavedListings', automaticProviderResumeStart);
      const automaticProviderResume = searchSource.slice(automaticProviderResumeStart, automaticProviderResumeEnd);
      const resumeBannerStart = searchSource.indexOf('const resumeBanner = showUnfinishedRunBanner');
      const resumeBannerEnd = searchSource.indexOf('const pausedManualAiRecovery', resumeBannerStart);
      const resumeBanner = searchSource.slice(resumeBannerStart, resumeBannerEnd);
      assert(automaticProviderResumeStart >= 0 && automaticProviderResumeEnd > automaticProviderResumeStart
        && automaticProviderResume.includes('data.providerPhaseAwaitingResume === true')
        && automaticProviderResume.includes('handleResumeRun({ offer, providerPhaseOnly: true })')
        && resumeBanner.includes('onClick={handleResumeRun}'),
      'after a hidden provider-only pass settles, mounted auto-resume must stop at the explicit semantic handoff while the person can still choose Resume');
      assert(boardSource.includes('explicitRecoveryContinue: true')
        && boardSource.includes('providerPhaseOnlyRecovery')
        && boardSource.includes('Saved AI handoff ready. Choose Continue saved AI handoff')
        && !boardSource.includes('[JobBoard] Auto-resuming manual AI run'),
      'a mounted Board advances only provider recovery automatically and leaves semantic AI behind an explicit Continue');
      assert(selectorSource.includes("recoveryActionLabel = 'Retry recovery'")
        && selectorSource.includes('{recoveryActionLabel}')
        && boardSource.includes("'Continue saved AI handoff'"),
      'the recovery control names the saved AI continuation instead of presenting it as an automatic retry');
      assert(mainSource.includes("['hidden-provider', 'board-orchestration']")
        && mainSource.includes('operation: backgroundBoardProviderOperation'),
      'fresh provider-only bootstrap accepts only an exact hidden or mounted Board process lease');
      return { searchConsentBoundary: true, boardConsentBoundary: true, mountedProviderLeaseExact: true };
    },
  },
];
