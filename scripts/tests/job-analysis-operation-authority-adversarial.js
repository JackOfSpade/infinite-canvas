import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  __loadJobAnalysisSnapshotForTests,
  __createDescriptionRecoveryCheckpointForTests,
  __loadDescriptionRecoveryCheckpointForTests,
  __listDescriptionRecoveryCheckpointsForTests,
  __removeDescriptionRecoveryCheckpointForTests,
  __saveJobAnalysisSnapshotForTests,
  __saveDescriptionRecoverySnapshotIfCurrentForTests,
  __registerJobsHandlersForTests,
  __discardCancelledBoardRunArtifactsForTests,
  __boardHistoryAuthorityForTests,
  assessDescriptionRecoverySnapshotOwnership,
  isLiveDescriptionRecoveryRun,
  registerJobsHandlers,
} from '../../electron/ipc/jobs.js';
import {
  claimJobAnalysisOperationAuthority,
  clearJobAnalysisOperationAuthority,
  currentJobAnalysisOperationAuthority,
  revokeJobAnalysisOperationAuthority,
  publishedJobAnalysisOperationAuthority,
  withCurrentJobAnalysisOperationAuthority,
} from '../../electron/ipc/jobAnalysisOperationAuthorityStore.js';
import { getJobAnalysisPaths, getJobDescriptionRecoveryCheckpointPath, rebindJobAnalysisRecoveryOwners } from '../../electron/ipc/jobAnalysisPaths.js';
import {
  activateRunForResume,
  finishRunWithSavedListings,
  markProviderGathered,
  markSourceStatus,
  lastRunReceiptPathForCanvas,
  pauseRunForManualResume,
  readRunState,
  recordSourcePage,
  rebindRunOperationAuthority,
  setStage,
  startRun,
} from '../../electron/ipc/jobRunStaging.js';
import electronPkg, { ipcMain } from 'electron';

function assert(value, message) { if (!value) throw new Error(message); }

const pin = 'a'.repeat(64);
const base = (kind = 'search', extra = {}) => ({
  kind,
  careerSnapshotId: pin,
  runId: 'run-1',
  fingerprint: 'fingerprint-1',
  analysisRevisionId: null,
  continuationId: null,
  sourceArtifactFingerprint: null,
  ...extra,
});

function snapshot({ canvasFilePath, hubId = 'hub', runId = 'run-1', authority = null, title = 'Original role', careerSnapshotId = pin } = {}) {
  return {
    version: 2,
    canvasFilePath,
    sourceHubId: hubId,
    nodeId: hubId,
    runId,
    createdAt: '2026-10-07T12:00:00.000Z',
    careerSnapshotId,
    gatheredJobCount: 1,
    sourceGatheredCount: 1,
    selectedJobCount: 1,
    cachedPrefix: 'Immutable candidate evidence.',
    previewBatches: [],
    jobs: [{ title, company: 'Example', url: 'https://example.test/job' }],
    preferenceCandidatePool: [{ title, company: 'Example', url: 'https://example.test/job' }],
    operationAuthority: authority,
  };
}

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

async function rejectsLoad(load) {
  try {
    await load();
    return false;
  } catch (error) {
    return error?.code === 'ENOENT';
  }
}

async function settlesWithin(promise, ms = 2_000) {
  let timer;
  try {
    return await Promise.race([
      promise.then(value => ({ settled: true, value }), error => ({ settled: true, error })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ settled: false }), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

export default [
  {
    name: 'operation authority: exact receipt revision and semantic base fence revoke after restart',
    run: async () => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-operation-cas-'));
      const canvas = path.join(directory, 'canvas.json');
      const owner = { canvasFilePath: canvas, hubId: 'hub', operationId: 's1', semanticBase: base() };
      try {
        await fs.promises.writeFile(canvas, '{}');
        const claimed = await claimJobAnalysisOperationAuthority(owner);
        const receipt = claimed.receipt;
        assert(claimed.admitted && receipt.revision > 0, 'fixture must receive a durable S1 receipt');

        const wrongRevision = await revokeJobAnalysisOperationAuthority({ ...owner, revision: receipt.revision + 1 });
        const wrongBase = await revokeJobAnalysisOperationAuthority({ ...owner, revision: receipt.revision, semanticBase: base('search', { runId: 'other-run' }) });
        assert(!wrongRevision.revoked && !wrongBase.revoked,
          'a revoke must compare the complete observed receipt, including exact revision and semantic base');
        assert(await currentJobAnalysisOperationAuthority({ ...owner, revision: receipt.revision }),
          'a rejected stale revoke must leave S1 current');

        const restartedStore = await import(`../../electron/ipc/jobAnalysisOperationAuthorityStore.js?cas-restart=${Date.now()}`);
        assert(await restartedStore.currentJobAnalysisOperationAuthority({ ...owner, revision: receipt.revision }),
          'the durable receipt must remain current after a module/process-style reload');
        const exact = await restartedStore.revokeJobAnalysisOperationAuthority({ ...owner, revision: receipt.revision });
        assert(exact.revoked && !(await restartedStore.currentJobAnalysisOperationAuthority({ ...owner, revision: receipt.revision })),
          'only the exact receipt may install its durable revoke tombstone');
        return { revision: receipt.revision };
      } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'operation authority: S1 publication survives ordinary S2 cancel/reload but explicit clear fences it',
    run: async () => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-operation-clear-fence-'));
      const canvas = path.join(directory, 'canvas.json');
      const s1 = { canvasFilePath: canvas, hubId: 'hub', operationId: 's1', semanticBase: base() };
      const s2 = { canvasFilePath: canvas, hubId: 'hub', operationId: 's2', semanticBase: base('search', { runId: 'run-2' }) };
      try {
        await fs.promises.writeFile(canvas, '{}');
        const one = await claimJobAnalysisOperationAuthority(s1);
        const saved = await __saveJobAnalysisSnapshotForTests(snapshot({ canvasFilePath: canvas, authority: one.receipt }));
        assert(!saved.retired, 'a current S1 may publish its snapshot');

        const two = await claimJobAnalysisOperationAuthority(s2);
        const ordinaryCancel = await revokeJobAnalysisOperationAuthority({ ...s2, revision: two.receipt.revision, clearPublished: false });
        assert(ordinaryCancel.revoked, 'fixture must cancel S2 normally');
        const reloadedJobs = await import(`../../electron/ipc/jobs.js?ordinary-cancel-restart=${Date.now()}`);
        const preserved = await reloadedJobs.__loadJobAnalysisSnapshotForTests(canvas, 'hub', 'run-1');
        assert(preserved.snapshot.jobs[0].title === 'Original role',
          'an S2 cancel must not erase an already-published S1 fallback after reload');

        const clear = await clearJobAnalysisOperationAuthority({ canvasFilePath: canvas, hubId: 'hub' });
        assert(clear.cleared, 'fixture must install a destructive clear fence');
        assert(await rejectsLoad(() => reloadedJobs.__loadJobAnalysisSnapshotForTests(canvas, 'hub', 'run-1')),
          'a destructive career-data clear must reject every previously sealed publication');
        return { ordinaryCancelPreserved: true, clearRevision: clear.receipt.revision };
      } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'operation authority: a seal binds exact published slot and bytes, never a moved or altered artifact',
    run: async () => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-operation-publication-map-'));
      const canvas = path.join(directory, 'canvas.json');
      const owner = { canvasFilePath: canvas, hubId: 'hub', operationId: 's1', semanticBase: base() };
      try {
        await fs.promises.writeFile(canvas, '{}');
        const claimed = await claimJobAnalysisOperationAuthority(owner);
        const saved = await __saveJobAnalysisSnapshotForTests(snapshot({ canvasFilePath: canvas, authority: claimed.receipt }));
        assert(!saved.retired, 'fixture must publish S1 before testing publication validation');
        const paths = getJobAnalysisPaths(canvas, null, 'hub');
        const original = await fs.promises.readFile(paths.jsonPath);
        assert((await __loadJobAnalysisSnapshotForTests(canvas, 'hub', 'run-1')).origin === 'current', 'fixture must load the actual current slot');

        // The exact bytes were published to `current`, not to the unpopulated
        // retained-generation slot. A path/slot swap must not inherit S1's seal.
        await fs.promises.writeFile(paths.lastSuccessJsonPaths[1], original);
        await fs.promises.unlink(paths.jsonPath);
        await fs.promises.unlink(paths.lastSuccessJsonPath);
        assert(await rejectsLoad(() => __loadJobAnalysisSnapshotForTests(canvas, 'hub', 'run-1')),
          'moving valid S1 bytes into a different semantic recovery slot must be rejected');

        // Re-publish, then alter the bytes while retaining the whole embedded
        // authority receipt. A receipt-only seal is insufficient.
        const republished = await __saveJobAnalysisSnapshotForTests(snapshot({ canvasFilePath: canvas, authority: claimed.receipt, title: 'Fresh role' }));
        assert(!republished.retired, 'the still-current receipt may republish after the failed read fixture');
        const changed = JSON.parse(await fs.promises.readFile(paths.jsonPath, 'utf8'));
        changed.jobs[0].title = 'Attacker rewrite';
        changed.preferenceCandidatePool[0].title = 'Attacker rewrite';
        const altered = Buffer.from(`${JSON.stringify(changed)}\n`);
        await fs.promises.writeFile(paths.jsonPath, altered);
        await fs.promises.writeFile(paths.lastSuccessJsonPath, altered);
        await fs.promises.rm(paths.lastSuccessJsonPaths[1], { force: true });
        assert(await rejectsLoad(() => __loadJobAnalysisSnapshotForTests(canvas, 'hub', 'run-1')),
          'changed artifact bytes must fail SHA-256 publication validation even with an untouched embedded receipt');
        return { movedSlotRejected: true, alteredBytesRejected: true };
      } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'operation authority: failed writes do not seal and claim acknowledgement cannot cross S1 validation-to-rename transaction',
    run: async () => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-operation-transaction-barrier-'));
      const canvas = path.join(directory, 'canvas.json');
      const artifact = path.join(directory, 'artifact.json');
      const s1 = { canvasFilePath: canvas, hubId: 'hub', operationId: 's1', semanticBase: base() };
      const s2 = { canvasFilePath: canvas, hubId: 'hub', operationId: 's2', semanticBase: base('search', { runId: 'run-2' }) };
      try {
        await fs.promises.writeFile(canvas, '{}');
        const one = await claimJobAnalysisOperationAuthority(s1);
        let failed = false;
        try {
          await withCurrentJobAnalysisOperationAuthority({ ...s1, revision: one.receipt.revision }, async () => { throw new Error('simulated rename failure'); });
        } catch { failed = true; }
        await fs.promises.writeFile(artifact, 'would-have-published');
        assert(failed && !(await publishedJobAnalysisOperationAuthority({
          ...s1,
          revision: one.receipt.revision,
          slot: 'current',
          digest: sha256('would-have-published'),
        })),
          'only a successful artifact transaction may create a publication seal');

        let releaseRename;
        const renameGate = new Promise(resolve => { releaseRename = resolve; });
        let markEntered;
        const enteredPromise = new Promise(resolve => { markEntered = resolve; });
        let entered = false;
        const writing = withCurrentJobAnalysisOperationAuthority({ ...s1, revision: one.receipt.revision }, async () => {
          entered = true;
          markEntered();
          await renameGate;
          await fs.promises.writeFile(artifact, 'published');
          return 'renamed';
        });
        assert((await settlesWithin(enteredPromise, 500)).settled && entered,
          'fixture S1 transaction must reach its validation-to-rename pause');
        let s2Acknowledged = false;
        const claiming = claimJobAnalysisOperationAuthority(s2).then(value => { s2Acknowledged = true; return value; });
        await Promise.resolve();
        assert(!s2Acknowledged, 'S2 claim acknowledgement must wait until the accepted S1 write has crossed its rename boundary');
        releaseRename();
        const [published, two] = await Promise.all([writing, claiming]);
        assert(published.admitted && published.value === 'renamed' && two.admitted && s2Acknowledged,
          'S1 must finish its accepted transaction before S2 is acknowledged');
        return { failureUnsealed: true, barrierHeld: true };
      } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'operation authority: concurrent S2 then S1 intents linearize without inversion and Save As drains claims',
    run: async () => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-operation-rebind-drain-'));
      const oldCanvas = path.join(directory, 'before.json');
      const newCanvas = path.join(directory, 'after.json');
      const s0 = { canvasFilePath: oldCanvas, hubId: 'hub', operationId: 's0', semanticBase: base() };
      const s2 = { canvasFilePath: oldCanvas, hubId: 'hub', operationId: 's2', semanticBase: base('search', { runId: 'run-2' }) };
      const s1 = { canvasFilePath: oldCanvas, hubId: 'hub', operationId: 's1', semanticBase: base('search', { runId: 'run-3' }) };
      try {
        await Promise.all([fs.promises.writeFile(oldCanvas, '{}'), fs.promises.writeFile(newCanvas, '{}')]);
        const zero = await claimJobAnalysisOperationAuthority(s0);
        assert(!(await __saveJobAnalysisSnapshotForTests(snapshot({ canvasFilePath: oldCanvas, authority: zero.receipt }))).retired,
          'fixture must create a migratable sealed publication');

        const intentS2 = claimJobAnalysisOperationAuthority(s2);
        const intentS1 = claimJobAnalysisOperationAuthority(s1);
        const [two, one] = await Promise.all([intentS2, intentS1]);
        assert(two.receipt.revision < one.receipt.revision
          && await currentJobAnalysisOperationAuthority({ ...s1, revision: one.receipt.revision }),
        'later S1 intent must win deterministically; request labels must not invert durable claim order');

        const rebind = rebindJobAnalysisRecoveryOwners(oldCanvas, newCanvas);
        const claimDuringRebind = claimJobAnalysisOperationAuthority({ ...s1, canvasFilePath: newCanvas, operationId: 'post-save-as' });
        const settled = await settlesWithin(Promise.all([rebind, claimDuringRebind]));
        assert(settled.settled && !settled.error && settled.value[0]?.success && settled.value[1]?.admitted,
          `Save As migration and a new-path claim must drain/rebind without deadlock: ${JSON.stringify(settled)}`);
        assert(await rejectsLoad(() => __loadJobAnalysisSnapshotForTests(oldCanvas, 'hub', 'run-1')),
          'old path recovery must not remain readable after Save As authority migration');
        return { ordered: [two.receipt.revision, one.receipt.revision], migrated: true };
      } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'operation authority: a deferred authority transaction holds its recovery lease until Save As can exclusively rebind',
    run: async () => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-operation-recovery-scope-lease-'));
      const oldCanvas = path.join(directory, 'before.json');
      const newCanvas = path.join(directory, 'after.json');
      const owner = { canvasFilePath: oldCanvas, hubId: 'hub', operationId: 's1', semanticBase: base() };
      try {
        await Promise.all([fs.promises.writeFile(oldCanvas, '{}'), fs.promises.writeFile(newCanvas, '{}')]);
        const claimed = await claimJobAnalysisOperationAuthority(owner);
        assert(!(await __saveJobAnalysisSnapshotForTests(snapshot({ canvasFilePath: oldCanvas, authority: claimed.receipt }))).retired,
          'fixture must create a migratable sealed artifact');
        let releaseTransaction;
        const transactionGate = new Promise(resolve => { releaseTransaction = resolve; });
        let transactionEntered;
        const entered = new Promise(resolve => { transactionEntered = resolve; });
        const writing = withCurrentJobAnalysisOperationAuthority({ ...owner, revision: claimed.receipt.revision }, async () => {
          transactionEntered();
          await transactionGate;
          return { ok: true };
        });
        await entered;
        const migration = rebindJobAnalysisRecoveryOwners(oldCanvas, newCanvas);
        assert(!(await settlesWithin(migration, 150)).settled,
          'Save As must wait for the full deferred authority callback, not release its recovery read lease after callback construction');
        releaseTransaction();
        const [written, migrated] = await Promise.all([writing, migration]);
        assert(written.admitted && migrated.success,
          'the queued Save As rebind must proceed once the in-flight authority transaction resolves');
        return { deferredLeaseHeld: true, rebindDrained: true };
      } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'operation authority: Save As rewrites every sealed generation/checkpoint and rebases publication digests',
    run: async () => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-operation-save-as-publication-map-'));
      const oldCanvas = path.join(directory, 'before.json');
      const newCanvas = path.join(directory, 'after.json');
      const hubId = 'hub';
      const owner = { canvasFilePath: oldCanvas, hubId, operationId: 's1', semanticBase: base() };
      try {
        await Promise.all([fs.promises.writeFile(oldCanvas, '{}'), fs.promises.writeFile(newCanvas, '{}')]);
        const claimed = await claimJobAnalysisOperationAuthority(owner);
        const generations = [
          ['run-a', 'Generation A'],
          ['run-b', 'Generation B'],
          ['run-c', 'Generation C'],
        ];
        for (const [runId, title] of generations) {
          const saved = await __saveJobAnalysisSnapshotForTests(snapshot({
            canvasFilePath: oldCanvas, hubId, runId, authority: claimed.receipt, title,
          }));
          assert(!saved.retired, `${title} must become a sealed pre-Save As generation`);
        }
        const checkpoint = await __createDescriptionRecoveryCheckpointForTests(snapshot({
          canvasFilePath: oldCanvas, hubId, runId: 'run-c', authority: claimed.receipt, title: 'Generation C',
        }));
        assert(checkpoint.saved, 'fixture must include a sealed run-keyed checkpoint');

        const oldPaths = getJobAnalysisPaths(oldCanvas, null, hubId);
        const newPaths = getJobAnalysisPaths(newCanvas, null, hubId);
        assert(oldPaths.ownerNamespace !== newPaths.ownerNamespace,
          'Save As must use the owner namespace derived from the new canonical canvas path');
        const rebind = await rebindJobAnalysisRecoveryOwners(oldCanvas, newCanvas);
        assert(rebind.success, `Save As migration must complete: ${rebind.reason || 'unknown'}`);

        const restartedJobs = await import(`../../electron/ipc/jobs.js?save-as-publications=${Date.now()}`);
        for (const [runId, title] of generations) {
          const restored = await restartedJobs.__loadJobAnalysisSnapshotForTests(newCanvas, hubId, runId);
          assert(restored.snapshot.jobs[0]?.title === title,
            `new canvas must recover exact sealed ${title} after ownership rewrite`);
        }
        const newCheckpoint = await restartedJobs.__loadDescriptionRecoveryCheckpointForTests(newCanvas, hubId, 'run-c');
        assert(newCheckpoint.snapshot.jobs[0]?.title === 'Generation C',
          'new canvas must recover its exact sealed checkpoint after ownership rewrite');
        assert(await rejectsLoad(() => restartedJobs.__loadJobAnalysisSnapshotForTests(oldCanvas, hubId, 'run-c')),
          'old canvas must not retain a readable recovery publication after Save As');

        const authority = JSON.parse(await fs.promises.readFile(newPaths.operationAuthorityPath, 'utf8'));
        const expectedSlots = new Map([
          ['current', newPaths.jsonPath],
          ['success:1', newPaths.lastSuccessJsonPaths[0]],
          ['success:2', newPaths.lastSuccessJsonPaths[1]],
          ['success:3', newPaths.lastSuccessJsonPaths[2]],
        ]);
        const checkpointPath = getJobDescriptionRecoveryCheckpointPath(newCanvas, 'run-c');
        const checkpointToken = path.basename(checkpointPath).match(/description-recovery-([a-f0-9]{24})\.json$/)?.[1];
        expectedSlots.set(`checkpoint:${checkpointToken}`, checkpointPath);
        for (const [slot, artifactPath] of expectedSlots) {
          const bytes = await fs.promises.readFile(artifactPath);
          const stable = authority.publications?.[slot];
          assert(stable?.digest === sha256(bytes),
            `migrated stable publication ${slot} must hash the rewritten new-path bytes`);
          if (authority.pendingPublications?.[slot]) {
            assert(authority.pendingPublications[slot].digest === sha256(bytes),
              `migrated pending publication ${slot} must hash the rewritten new-path bytes`);
          }
        }
        return { generations: generations.length, checkpoint: true, namespaceChanged: true };
      } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'operation authority: Save As replay migrates an old owner-scoped prompt after its JSON envelopes were already committed',
    run: async () => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-operation-save-as-prompt-replay-'));
      const oldCanvas = path.join(directory, 'before.json');
      const newCanvas = path.join(directory, 'after.json');
      const hubId = 'hub';
      const owner = { canvasFilePath: oldCanvas, hubId, operationId: 's1', semanticBase: base() };
      try {
        await Promise.all([fs.promises.writeFile(oldCanvas, '{}'), fs.promises.writeFile(newCanvas, '{}')]);
        const claimed = await claimJobAnalysisOperationAuthority(owner);
        const saved = await __saveJobAnalysisSnapshotForTests(snapshot({
          canvasFilePath: oldCanvas, hubId, authority: claimed.receipt, title: 'Prompt replay role',
        }));
        assert(!saved.retired, 'fixture must create a sealed snapshot and its owner-scoped prompt');

        const oldPaths = getJobAnalysisPaths(oldCanvas, null, hubId);
        const newPaths = getJobAnalysisPaths(newCanvas, null, hubId);
        const oldPromptBytes = await fs.promises.readFile(oldPaths.promptPath);
        const first = await rebindJobAnalysisRecoveryOwners(oldCanvas, newCanvas);
        assert(first.success, 'fixture must commit the full first Save As migration');
        assert(await rejectsLoad(() => __loadJobAnalysisSnapshotForTests(oldCanvas, hubId, 'run-1')),
          'the first migration must remove old recovery JSON before simulating a partial deletion replay');

        // Model a crash after every old JSON source was deleted, but before the
        // old owner-scoped prompt was removed. The rewritten new JSON envelope
        // is the sole trustworthy source for mapping that old prompt namespace.
        await fs.promises.writeFile(oldPaths.promptPath, oldPromptBytes);
        const replay = await rebindJobAnalysisRecoveryOwners(oldCanvas, newCanvas);
        assert(replay.success,
          'Save As replay must recover the old prompt owner from committed new JSON, rather than infer it from its filename');
        assert(await fs.promises.readFile(newPaths.promptPath).then(bytes => bytes.equals(oldPromptBytes)),
          'replay must preserve the exact prompt bytes at its new owner namespace');
        await fs.promises.access(oldPaths.promptPath).then(
          () => { throw new Error('old prompt must be removed after replay'); },
          error => { if (error?.code !== 'ENOENT') throw error; },
        );
        const restored = await __loadJobAnalysisSnapshotForTests(newCanvas, hubId, 'run-1');
        assert(restored.snapshot.jobs[0]?.title === 'Prompt replay role',
          'prompt-only replay must not disturb the previously sealed new recovery snapshot');
        return { replayedPrompt: true, ownerNamespaceChanged: oldPaths.ownerNamespace !== newPaths.ownerNamespace };
      } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'operation authority: delayed S1 provider callbacks cannot borrow a rebound S2 manifest receipt',
    run: async () => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-operation-stale-provider-'));
      const canvas = path.join(directory, 'canvas.json');
      const hubId = 'hub';
      const runId = 'provider-run';
      const s1Request = { canvasFilePath: canvas, hubId, operationId: 's1', semanticBase: base('search', { runId }) };
      try {
        await fs.promises.writeFile(canvas, '{}');
        const s1 = await claimJobAnalysisOperationAuthority(s1Request);
        assert((await startRun(canvas, {
          runId, startedAt: 1_700_000_000_000, nodeId: hubId,
          careerSnapshotId: pin, profileFingerprint: 'b'.repeat(64), sourceIds: ['provider'],
          operationAuthority: s1.receipt,
        }))?.runId === runId, 'fixture must bind its manifest to S1 before the provider callback is delayed');
        const s2 = await claimJobAnalysisOperationAuthority({
          canvasFilePath: canvas, hubId, operationId: 's2', semanticBase: base('resume', { runId, fingerprint: 'resume-s2' }), predecessor: s1.receipt,
        });
        const rebound = await rebindRunOperationAuthority(canvas, {
          expectedRunId: runId, expectedNodeId: hubId, careerSnapshotId: pin,
          currentAuthority: s2.receipt, predecessorAuthority: s1.receipt,
        });
        assert(s2.admitted && rebound.ok && rebound.rebound,
          'fixture must make S2 the exact manifest authority before releasing the delayed S1 callback');

        const latePage = await recordSourcePage(canvas, {
          sourceId: 'provider', query: 'engineer', page: 0, jobs: [{ title: 'S1 leak' }], now: 1_700_000_000_100,
          expectedRunId: runId, nodeId: hubId, expectedOperationAuthority: s1.receipt,
        });
        const lateStatus = await markSourceStatus(canvas, 'provider', 'done', 1_700_000_000_101, {
          expectedRunId: runId, nodeId: hubId, expectedOperationAuthority: s1.receipt,
        });
        const lateBoundary = await markProviderGathered(canvas, 1_700_000_000_102, {
          expectedRunId: runId, nodeId: hubId, expectedOperationAuthority: s1.receipt, requiredSourceIds: ['provider'],
        });
        const afterLate = await readRunState(canvas, Date.now(), { nodeId: hubId });
        const delayedSource = afterLate?.manifest?.sources?.provider;
        assert(latePage === false && lateStatus === false && lateBoundary === false
          && delayedSource?.status === 'pending' && Object.keys(delayedSource?.queries || {}).length === 0
          && afterLate?.manifest?.stage === 'searching' && afterLate?.manifest?.providerGatheredAt == null,
        'a delayed S1 callback must not read S2 from the mutable manifest and borrow it to mutate staging');

        const s2Page = await recordSourcePage(canvas, {
          sourceId: 'provider', query: 'engineer', page: 0, jobs: [{ title: 'S2 admitted' }], now: 1_700_000_000_103,
          expectedRunId: runId, nodeId: hubId, expectedOperationAuthority: s2.receipt,
        });
        assert(s2Page === true,
          'the provider callback that captured the exact rebound S2 receipt remains admissible');
        return { staleS1Rejected: true, capturedS2Admitted: true };
      } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'operation authority: provider and stage mutations settle without nested authority-lock deadlock',
    run: async () => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-operation-stage-no-deadlock-'));
      const canvas = path.join(directory, 'canvas.json');
      const hubId = 'hub';
      const runId = 'stage-run';
      try {
        await fs.promises.writeFile(canvas, '{}');
        const claimed = await claimJobAnalysisOperationAuthority({ canvasFilePath: canvas, hubId, operationId: 's1', semanticBase: base() });
        assert((await startRun(canvas, {
          runId, startedAt: 1_700_000_000_000, nodeId: hubId,
          careerSnapshotId: pin, profileFingerprint: 'b'.repeat(64), sourceIds: ['provider'],
          operationAuthority: claimed.receipt,
        }))?.runId === runId, 'fixture must create an authority-bound run');
        const options = { expectedRunId: runId, nodeId: hubId, expectedOperationAuthority: claimed.receipt };
        const page = await settlesWithin(recordSourcePage(canvas, {
          sourceId: 'provider', query: 'engineer', page: 0, jobs: [{ title: 'Durable row' }], now: 1_700_000_000_100, ...options,
        }));
        const status = await settlesWithin(markSourceStatus(canvas, 'provider', 'done', 1_700_000_000_101, options));
        const boundary = await settlesWithin(markProviderGathered(canvas, 1_700_000_000_102, {
          ...options, requiredSourceIds: ['provider'],
        }));
        const stage = await settlesWithin(setStage(canvas, 'gathered', 1_700_000_000_103, options));
        assert(page.settled && page.value === true && status.settled && status.value === true
          && boundary.settled && boundary.value === true && stage.settled && stage.value === true,
        'each provider/stage mutation must use one authority→manifest transaction and finish within the deadlock watchdog');
        return { providerMutationSettled: true, stageMutationSettled: true };
      } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'operation authority: exact Stop tombstones S1, blocks delayed writes, and permits only immediate resume lineage',
    run: async () => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-operation-stop-tombstone-'));
      const canvas = path.join(directory, 'canvas.json');
      const hubId = 'hub';
      const runId = 'stop-run';
      const s1Request = { canvasFilePath: canvas, hubId, operationId: 's1', semanticBase: base('search', { runId }) };
      try {
        await fs.promises.writeFile(canvas, '{}');
        const s1 = await claimJobAnalysisOperationAuthority(s1Request);
        assert((await startRun(canvas, {
          runId, startedAt: 1_700_000_000_000, nodeId: hubId,
          careerSnapshotId: pin, profileFingerprint: 'b'.repeat(64), sourceIds: ['provider'],
          operationAuthority: s1.receipt,
        }))?.runId === runId, 'fixture must bind the stoppable manifest to S1');
        const paused = await withCurrentJobAnalysisOperationAuthority({
          ...s1Request, revision: s1.receipt.revision, tombstoneAfterWrite: true,
        }, () => pauseRunForManualResume(canvas, {
          expectedRunId: runId, nodeId: hubId, now: 1_700_000_000_100,
        }));
        assert(paused.admitted && paused.value?.ok && paused.terminalTombstoned
          && !(await currentJobAnalysisOperationAuthority({ ...s1Request, revision: s1.receipt.revision })),
        'Stop must durably pause the exact run and revoke S1 before returning');

        const delayed = await recordSourcePage(canvas, {
          sourceId: 'provider', query: 'engineer', page: 0, jobs: [{ title: 'late after Stop' }], now: 1_700_000_000_101,
          expectedRunId: runId, nodeId: hubId, expectedOperationAuthority: s1.receipt,
        });
        assert(delayed === false, 'a tombstoned S1 must reject its delayed provider callback after Stop');

        const missingPredecessor = await claimJobAnalysisOperationAuthority({
          canvasFilePath: canvas, hubId, operationId: 'unrelated', semanticBase: base('resume', { runId, fingerprint: 'unrelated' }),
        });
        assert(!missingPredecessor.admitted && missingPredecessor.reason === 'resume-predecessor-mismatch',
          'a resume that does not name the exact revoked S1 receipt must fail before it can reach the manifest-rebind transaction');

        const s2 = await claimJobAnalysisOperationAuthority({
          canvasFilePath: canvas, hubId, operationId: 's2', semanticBase: base('resume', { runId, fingerprint: 'resume-s2' }), predecessor: s1.receipt,
        });
        const resumed = await rebindRunOperationAuthority(canvas, {
          expectedRunId: runId, expectedNodeId: hubId, careerSnapshotId: pin,
          currentAuthority: s2.receipt, predecessorAuthority: s1.receipt,
        });
        assert(s2.admitted && resumed.ok && resumed.rebound,
          'only the exact S1→S2 resume lineage may rebind the paused manifest');
        return { pausedAndTombstoned: true, delayedWriteRejected: true, exactResumeOnly: true };
      } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'operation authority: Stop S1 checkpoint is adopted by exact Resume S2 for Solve, never directly by S3',
    run: async () => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-operation-stop-resume-checkpoint-'));
      const canvas = path.join(directory, 'canvas.json');
      const hubId = 'hub';
      const runId = 'stopped-checkpoint-run';
      const s1Request = { canvasFilePath: canvas, hubId, operationId: 's1', semanticBase: base('search', { runId }) };
      try {
        await fs.promises.writeFile(canvas, '{}');
        const s1 = await claimJobAnalysisOperationAuthority(s1Request);
        assert((await startRun(canvas, {
          runId, startedAt: 1_700_000_000_000, nodeId: hubId,
          careerSnapshotId: pin, profileFingerprint: 'b'.repeat(64), sourceIds: ['provider'], operationAuthority: s1.receipt,
        }))?.runId === runId, 'fixture must create an S1-owned stopped run');
        const checkpointSnapshot = snapshot({ canvasFilePath: canvas, hubId, runId, authority: s1.receipt, title: 'Stopped S1 checkpoint' });
        assert((await __createDescriptionRecoveryCheckpointForTests(checkpointSnapshot)).saved,
          'fixture must seal the S1 Solve checkpoint before Stop');
        const paused = await withCurrentJobAnalysisOperationAuthority({
          ...s1Request, revision: s1.receipt.revision, tombstoneAfterWrite: true,
        }, () => pauseRunForManualResume(canvas, { expectedRunId: runId, nodeId: hubId, now: 1_700_000_000_100 }));
        assert(paused.admitted && paused.terminalTombstoned, 'fixture must Stop and tombstone S1');
        const s2 = await claimJobAnalysisOperationAuthority({
          canvasFilePath: canvas, hubId, operationId: 's2', semanticBase: base('resume', { runId, fingerprint: 'resume-s2' }), predecessor: s1.receipt,
        });
        assert((await rebindRunOperationAuthority(canvas, {
          expectedRunId: runId, expectedNodeId: hubId, careerSnapshotId: pin,
          currentAuthority: s2.receipt, predecessorAuthority: s1.receipt,
        })).rebound, 'exact S1→S2 must adopt the stopped manifest once');
        const checkpoint = await __loadDescriptionRecoveryCheckpointForTests(canvas, hubId, runId);
        const solveOwnership = assessDescriptionRecoverySnapshotOwnership({
          snapshot: checkpoint.snapshot, origin: checkpoint.origin, nodeId: hubId, jobRunId: runId,
          careerSnapshotId: pin, operationAuthority: s2.receipt,
        });
        assert(solveOwnership.ok,
          'the exact S1→S2 resume lineage must adopt the checkpoint receipt so Solve can continue without a provider restart');

        // The checkpoint lives beside a user-controlled canvas. A pathname
        // swap must not make adoption read through a symlink after the S2
        // authority claim. Use a separate exact run so the successful S1→S2
        // checkpoint above remains the control case.
        const unsafeCanvas = path.join(directory, 'unsafe-checkpoint.json');
        const unsafeRunId = 'unsafe-checkpoint-run';
        await fs.promises.writeFile(unsafeCanvas, '{}');
        const unsafeS1 = await claimJobAnalysisOperationAuthority({
          canvasFilePath: unsafeCanvas, hubId, operationId: 'unsafe-s1',
          semanticBase: base('search', { runId: unsafeRunId }),
        });
        assert((await startRun(unsafeCanvas, {
          runId: unsafeRunId, startedAt: 1_700_000_000_001, nodeId: hubId,
          careerSnapshotId: pin, profileFingerprint: 'b'.repeat(64), sourceIds: ['provider'], operationAuthority: unsafeS1.receipt,
        }))?.runId === unsafeRunId, 'unsafe checkpoint fixture must create its exact S1 manifest');
        const unsafePath = getJobDescriptionRecoveryCheckpointPath(unsafeCanvas, unsafeRunId, null);
        const outside = path.join(directory, 'outside-checkpoint.json');
        await fs.promises.writeFile(outside, JSON.stringify(checkpointSnapshot));
        await fs.promises.symlink(outside, unsafePath);
        const unsafeS2 = await claimJobAnalysisOperationAuthority({
          canvasFilePath: unsafeCanvas, hubId, operationId: 'unsafe-s2',
          semanticBase: base('resume', { runId: unsafeRunId, fingerprint: 'unsafe-resume-s2' }), predecessor: unsafeS1.receipt,
        });
        const unsafeRebind = await rebindRunOperationAuthority(unsafeCanvas, {
          expectedRunId: unsafeRunId, expectedNodeId: hubId, careerSnapshotId: pin,
          currentAuthority: unsafeS2.receipt, predecessorAuthority: unsafeS1.receipt,
        });
        assert(unsafeS2.admitted && !unsafeRebind.ok && unsafeRebind.reason === 'checkpoint-invalid',
          'checkpoint adoption must use a bounded no-follow regular-file descriptor rather than following a swapped symlink');
        return { s1Stopped: true, s2CheckpointAdopted: true, unsafeCheckpointRejected: true };
      } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'operation authority: stale S1 activate and finish callbacks cannot mutate the S2-rebound manifest',
    run: async () => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-operation-stale-activate-finish-'));
      const canvas = path.join(directory, 'canvas.json');
      const hubId = 'hub';
      const runId = 'resume-run';
      try {
        await fs.promises.writeFile(canvas, '{}');
        const s1 = await claimJobAnalysisOperationAuthority({ canvasFilePath: canvas, hubId, operationId: 's1', semanticBase: base('search', { runId }) });
        assert((await startRun(canvas, {
          runId, startedAt: 1_700_000_000_000, nodeId: hubId,
          careerSnapshotId: pin, profileFingerprint: 'b'.repeat(64), sourceIds: ['provider'], operationAuthority: s1.receipt,
        }))?.runId === runId, 'fixture must create an S1-bound resumable manifest');
        const s2 = await claimJobAnalysisOperationAuthority({
          canvasFilePath: canvas, hubId, operationId: 's2', semanticBase: base('resume', { runId, fingerprint: 'resume-s2' }), predecessor: s1.receipt,
        });
        assert((await rebindRunOperationAuthority(canvas, {
          expectedRunId: runId, expectedNodeId: hubId, careerSnapshotId: pin,
          currentAuthority: s2.receipt, predecessorAuthority: s1.receipt,
        })).rebound, 'fixture must rebind the manifest to S2');
        const staleOptions = { expectedRunId: runId, nodeId: hubId, expectedOperationAuthority: s1.receipt, now: 1_700_000_000_100 };
        const staleActivate = await activateRunForResume(canvas, staleOptions);
        const staleFinish = await finishRunWithSavedListings(canvas, staleOptions);
        const state = await readRunState(canvas, Date.now(), { nodeId: hubId });
        assert(staleActivate === false && staleFinish === false
          && state?.manifest?.recoveryDisposition == null && state?.manifest?.collectionDisposition == null,
        'S1 callbacks delayed past S2 manifest rebind must fail before changing resume or partial-finish state');
        const liveOptions = { ...staleOptions, expectedOperationAuthority: s2.receipt, now: 1_700_000_000_101 };
        const liveFinish = await finishRunWithSavedListings(canvas, liveOptions);
        assert(liveFinish?.ok === true,
          'the exact S2 callback remains allowed to mark its own staged run after stale S1 is fenced');
        return { staleActivateRejected: true, staleFinishRejected: true, s2Admitted: true };
      } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'operation authority: discard accepts only the exact current clear receipt and cannot erase a successor run/checkpoint',
    run: async () => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-operation-discard-clear-cas-'));
      const canvas = path.join(directory, 'canvas.json');
      const hubId = 'hub';
      const originalTrashItem = electronPkg.shell.trashItem;
      const sender = { id: 7_715, isDestroyed: () => false, once: () => {}, on: () => {}, removeListener: () => {}, send: () => {} };
      try {
        await fs.promises.writeFile(canvas, '{}');
        const s1 = await claimJobAnalysisOperationAuthority({ canvasFilePath: canvas, hubId, operationId: 's1', semanticBase: base() });
        assert((await startRun(canvas, {
          runId: 'old-run', startedAt: 1_700_000_000_000, nodeId: hubId,
          careerSnapshotId: pin, profileFingerprint: 'b'.repeat(64), sourceIds: ['provider'], operationAuthority: s1.receipt,
        }))?.runId === 'old-run', 'fixture must create the pre-clear owned run');
        const staleClear = await clearJobAnalysisOperationAuthority({ canvasFilePath: canvas, hubId });
        registerJobsHandlers();
        const discard = ipcMain.__getInvokeHandler('discard-job-run');
        electronPkg.shell.trashItem = async filePath => fs.promises.unlink(filePath);
        const clearingOld = await settlesWithin(discard({ sender }, {
          canvasFilePath: canvas, nodeId: hubId, runId: 'old-run', operationAuthority: staleClear.receipt,
        }));
        const clearedOld = clearingOld.value;
        assert(clearingOld.settled && !clearingOld.error
          && clearedOld?.success === true && clearedOld.ok === true && clearedOld.cleared === true,
          `discard must consume the exact current clear receipt without self-deadlock: ${JSON.stringify(clearingOld)}`);
        const s2 = await claimJobAnalysisOperationAuthority({
          canvasFilePath: canvas, hubId, operationId: 's2', semanticBase: base('search', { runId: 'new-run' }),
        });
        assert((await startRun(canvas, {
          runId: 'new-run', startedAt: 1_700_000_000_100, nodeId: hubId,
          careerSnapshotId: pin, profileFingerprint: 'b'.repeat(64), sourceIds: ['provider'], operationAuthority: s2.receipt,
        }))?.runId === 'new-run', 'fixture must replace the cleared run with a current S2 successor');
        const successorSnapshot = snapshot({ canvasFilePath: canvas, hubId, runId: 'new-run', authority: s2.receipt, title: 'Successor checkpoint' });
        assert((await __createDescriptionRecoveryCheckpointForTests(successorSnapshot)).saved,
          'fixture must give the successor an exact sealed checkpoint');
        const staleAttempt = await settlesWithin(discard({ sender }, {
          canvasFilePath: canvas, nodeId: hubId, runId: 'new-run', operationAuthority: staleClear.receipt,
        }));
        const stale = staleAttempt.value;
        assert(staleAttempt.settled && !staleAttempt.error
          && stale?.success === true && stale.ok === false && stale.operationAuthorityMismatch === true
          && (await readRunState(canvas, Date.now(), { nodeId: hubId }))?.manifest?.runId === 'new-run'
          && (await __loadDescriptionRecoveryCheckpointForTests(canvas, hubId, 'new-run')).snapshot.jobs[0]?.title === 'Successor checkpoint',
        'a stale clear receipt must not delete a newer run or its sealed recovery checkpoint');

        const currentClear = await clearJobAnalysisOperationAuthority({ canvasFilePath: canvas, hubId });
        const exactAttempt = await settlesWithin(discard({ sender }, {
          canvasFilePath: canvas, nodeId: hubId, runId: 'new-run', operationAuthority: currentClear.receipt,
        }));
        const exact = exactAttempt.value;
        assert(exactAttempt.settled && !exactAttempt.error
          && exact?.success === true && exact.ok === true && exact.cleared === true
          && (await readRunState(canvas, Date.now(), { nodeId: hubId })) === null
          && await rejectsLoad(() => __loadDescriptionRecoveryCheckpointForTests(canvas, hubId, 'new-run')),
        `the exact current clear receipt may retire only its currently addressed successor run/checkpoint: ${JSON.stringify({ exactAttempt, exact })}`);
        return { staleClearRejected: true, successorPreserved: true, currentClearAdmitted: true };
      } finally {
        electronPkg.shell.trashItem = originalTrashItem;
        await fs.promises.rm(directory, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'operation authority: unsealed or tampered description checkpoints are not actionable discovery records',
    run: async () => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-operation-checkpoint-discovery-'));
      const canvas = path.join(directory, 'canvas.json');
      const hubId = 'hub';
      try {
        await fs.promises.writeFile(canvas, '{}');
        const rawRun = 'unsealed-run';
        const rawPath = getJobDescriptionRecoveryCheckpointPath(canvas, rawRun);
        await fs.promises.mkdir(path.dirname(rawPath), { recursive: true });
        await fs.promises.writeFile(rawPath, `${JSON.stringify(snapshot({ canvasFilePath: canvas, hubId, runId: rawRun, authority: null }))}\n`);
        const claimed = await claimJobAnalysisOperationAuthority({ canvasFilePath: canvas, hubId, operationId: 's1', semanticBase: base() });
        const tamperedRun = 'tampered-run';
        const sealed = snapshot({ canvasFilePath: canvas, hubId, runId: tamperedRun, authority: claimed.receipt, title: 'sealed checkpoint' });
        assert((await __createDescriptionRecoveryCheckpointForTests(sealed)).saved,
          'fixture must first seal a checkpoint through the publication map');
        const tamperedPath = getJobDescriptionRecoveryCheckpointPath(canvas, tamperedRun);
        const tampered = JSON.parse(await fs.promises.readFile(tamperedPath, 'utf8'));
        tampered.jobs[0].title = 'tampered checkpoint';
        await fs.promises.writeFile(tamperedPath, `${JSON.stringify(tampered)}\n`);
        const listed = await __listDescriptionRecoveryCheckpointsForTests(canvas);
        assert(!listed.some(entry => entry.runId === rawRun && entry.actionable)
          && !listed.some(entry => entry.runId === tamperedRun && entry.actionable),
        'discovery must validate the exact sealed bytes/receipt before presenting a checkpoint as actionable');
        return { unsealedHidden: true, tamperedHidden: true };
      } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'operation authority: a composite S1 description rewrite cannot leave global and checkpoint generations split after S2 claims',
    run: async () => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-operation-composite-description-'));
      const canvas = path.join(directory, 'canvas.json');
      const hubId = 'hub';
      const runId = 'description-run';
      const originalReadFile = fs.promises.readFile;
      try {
        await fs.promises.writeFile(canvas, '{}');
        const s1Request = { canvasFilePath: canvas, hubId, operationId: 's1', semanticBase: base() };
        const s1 = await claimJobAnalysisOperationAuthority(s1Request);
        const before = snapshot({ canvasFilePath: canvas, hubId, runId, authority: s1.receipt, title: 'Before S1 rewrite' });
        assert(!(await __saveJobAnalysisSnapshotForTests(before)).retired
          && (await __createDescriptionRecoveryCheckpointForTests(before)).saved,
        'fixture must create matching sealed global and checkpoint publications');
        const paths = getJobAnalysisPaths(canvas, null, hubId);
        let allowGlobalRead;
        const globalReadGate = new Promise(resolve => { allowGlobalRead = resolve; });
        let enteredGlobalRead;
        const globalReadEntered = new Promise(resolve => { enteredGlobalRead = resolve; });
        let intercept = true;
        fs.promises.readFile = async (filePath, ...args) => {
          if (intercept && filePath === paths.jsonPath) {
            intercept = false;
            enteredGlobalRead();
            await globalReadGate;
          }
          return originalReadFile(filePath, ...args);
        };
        const updating = __saveDescriptionRecoverySnapshotIfCurrentForTests(
          snapshot({ canvasFilePath: canvas, hubId, runId, authority: s1.receipt, title: 'After S1 rewrite' }),
          { nodeId: hubId, jobRunId: runId },
        );
        await globalReadEntered;
        // A correct composite transaction either completes all S1 artifacts
        // before this S2 intent wins, or rejects S1 as a whole. It may never
        // permit one sealed generation and one stale/unsealed sibling.
        const s2Intent = claimJobAnalysisOperationAuthority({
          canvasFilePath: canvas, hubId, operationId: 's2', semanticBase: base('search', { runId: 'run-2' }),
        });
        await Promise.resolve();
        allowGlobalRead();
        const [update, s2] = await Promise.all([updating, s2Intent]);
        fs.promises.readFile = originalReadFile;
        const global = await __loadJobAnalysisSnapshotForTests(canvas, hubId, runId).catch(() => null);
        const checkpoint = await __loadDescriptionRecoveryCheckpointForTests(canvas, hubId, runId).catch(() => null);
        const globalTitle = global?.snapshot?.jobs?.[0]?.title;
        const checkpointTitle = checkpoint?.snapshot?.jobs?.[0]?.title;
        const authorityRecord = JSON.parse(await fs.promises.readFile(paths.operationAuthorityPath, 'utf8'));
        const checkpointPath = getJobDescriptionRecoveryCheckpointPath(canvas, runId);
        const checkpointToken = path.basename(checkpointPath).match(/description-recovery-([a-f0-9]{24})\.json$/)?.[1];
        const stableCurrent = authorityRecord.publications?.current;
        const stableCheckpoint = authorityRecord.publications?.[`checkpoint:${checkpointToken}`];
        assert(s2.admitted && globalTitle && checkpointTitle && globalTitle === checkpointTitle
          && ['Before S1 rewrite', 'After S1 rewrite'].includes(globalTitle),
        `S2 contention must leave global/checkpoint bytes and publication maps as one consistent generation: ${JSON.stringify({ update, globalTitle, checkpointTitle })}`);
        assert(stableCurrent?.digest === sha256(await fs.promises.readFile(paths.jsonPath))
          && stableCheckpoint?.digest === sha256(await fs.promises.readFile(checkpointPath)),
        'a multi-stage checkpoint+current publication must retain both exact stable slot digests after promotion');
        return { s2Admitted: true, compositeGeneration: globalTitle };
      } finally {
        fs.promises.readFile = originalReadFile;
        await fs.promises.rm(directory, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'operation authority: stale scoring preflight rejects before it can dispatch a manual model handoff',
    run: async () => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-operation-stale-scoring-'));
      const canvas = path.join(directory, 'canvas.json');
      const hubId = 'hub';
      let handoffs = 0;
      const sender = { id: 7_714, isDestroyed: () => false, once: () => {}, on: () => {}, removeListener: () => {}, send: () => { handoffs += 1; } };
      try {
        await fs.promises.writeFile(canvas, '{}');
        const s1 = await claimJobAnalysisOperationAuthority({ canvasFilePath: canvas, hubId, operationId: 's1', semanticBase: base() });
        const s2 = await claimJobAnalysisOperationAuthority({
          canvasFilePath: canvas, hubId, operationId: 's2', semanticBase: base('search', { runId: 'run-2' }),
        });
        assert(s1.admitted && s2.admitted, 'fixture must supersede S1 before scoring begins');
        registerJobsHandlers();
        const score = ipcMain.__getInvokeHandler('score-jobs');
        const result = await score({ sender }, {
          jobs: [{ title: 'Stale score', company: 'Example', url: 'https://example.test/stale', description: 'x'.repeat(600) }],
          profile: {}, careerData: 'candidate', careerSnapshotId: pin, nodeId: hubId,
          operationAuthority: s1.receipt, snapshotContext: { canvasFilePath: canvas },
        });
        assert(result.success === true && result.operationSuperseded === true && Array.isArray(result.jobs) && result.jobs.length === 0 && handoffs === 0,
          'a stale S1 must fail at score admission without creating or dispatching a manual model handoff');
        return { stalePreflightRejected: true, modelHandoffs: handoffs };
      } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'operation authority: S1 score loses its pinned-snapshot race before telemetry, snapshot, or model dispatch',
    run: async () => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-operation-score-post-pin-'));
      const canvas = path.join(directory, 'canvas.json');
      const hubId = 'hub';
      let releaseS1;
      const releaseGate = new Promise(resolve => { releaseS1 = resolve; });
      let enteredS1;
      const enteredGate = new Promise(resolve => { enteredS1 = resolve; });
      let modelCalls = 0;
      let progressAfterSupersede = 0;
      let superseded = false;
      const sender = {
        id: 7_717, isDestroyed: () => false, once: () => {}, on: () => {}, removeListener: () => {},
        send: (channel) => { if (superseded && channel === 'scoring-progress') progressAfterSupersede += 1; },
      };
      try {
        await fs.promises.writeFile(canvas, '{}');
        const s1 = await claimJobAnalysisOperationAuthority({ canvasFilePath: canvas, hubId, operationId: 's1', semanticBase: base() });
        __registerJobsHandlersForTests({
          resolvePinnedScoringInput: async () => ({ profile: { workHistory: [] }, careerData: 'immutable candidate evidence', pinned: true }),
          beforeScoreSideEffect: async ({ phase }) => {
            if (phase === 'after-pinned-scoring-input') {
              enteredS1();
              await releaseGate;
            }
          },
          runScoreBatch: async () => { modelCalls += 1; return { scores: [] }; },
        });
        const score = ipcMain.__getInvokeHandler('score-jobs');
        const scoring = score({ sender }, {
          jobs: [{ title: 'Race score', company: 'Example', url: 'https://example.test/race-score', description: 'x'.repeat(600) }],
          careerSnapshotId: pin, nodeId: hubId, operationAuthority: s1.receipt, snapshotContext: { canvasFilePath: canvas },
        });
        await enteredGate;
        await claimJobAnalysisOperationAuthority({ canvasFilePath: canvas, hubId, operationId: 's2', semanticBase: base('search', { runId: 'run-2' }) });
        superseded = true;
        releaseS1();
        const result = await scoring;
        const paths = getJobAnalysisPaths(canvas, null, hubId);
        assert(result.operationSuperseded === true && Array.isArray(result.jobs) && result.jobs.length === 0,
          'S1 must return a quiet supersession result after S2 claims during its pinned-snapshot boundary');
        assert(modelCalls === 0 && progressAfterSupersede === 0,
          'a post-pin stale scorer must not dispatch a model call or emit stale scoring progress');
        assert(!fs.existsSync(paths.jsonPath), 'a post-pin stale scorer must not save an analysis snapshot');
        return { postPinSuperseded: true, modelCalls, progressAfterSupersede };
      } finally {
        registerJobsHandlers();
        await fs.promises.rm(directory, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'operation authority: S1 provider completion cannot stage or report success after S2 claims',
    run: async () => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-operation-search-post-provider-'));
      const canvas = path.join(directory, 'canvas.json');
      const hubId = 'hub';
      let releaseProvider;
      const providerRelease = new Promise(resolve => { releaseProvider = resolve; });
      let providerCompleted;
      const providerCompletedGate = new Promise(resolve => { providerCompleted = resolve; });
      let stageAttempts = 0;
      let progressAfterSupersede = 0;
      let superseded = false;
      const sender = {
        id: 7_718, isDestroyed: () => false, once: () => {}, on: () => {}, removeListener: () => {},
        send: (channel) => { if (superseded && channel === 'job-source-progress') progressAfterSupersede += 1; },
      };
      try {
        await fs.promises.writeFile(canvas, '{}');
        const s1 = await claimJobAnalysisOperationAuthority({ canvasFilePath: canvas, hubId, operationId: 's1', semanticBase: base() });
        __registerJobsHandlersForTests({
          resolveRequiredPinnedCareerInput: async () => ({ profile: {}, careerData: '', pinned: true }),
          fetchHttpSources: async (...args) => {
            const stageSource = args[8];
            const beforeSourceDispatch = args[10];
            const afterProviderResult = args[11];
            await beforeSourceDispatch('remoteok');
            providerCompleted();
            await providerRelease;
            const providerResult = { sourceId: 'remoteok', jobs: [], gathered: 0 };
            await afterProviderResult('remoteok', providerResult);
            stageAttempts += 1;
            await stageSource({ sourceId: 'remoteok', jobs: [] });
            return [providerResult];
          },
          beforeSearchStageWrite: async () => { stageAttempts += 1; },
        });
        const search = ipcMain.__getInvokeHandler('search-jobs');
        const searching = search({ sender }, {
          queries: ['software engineer'], nodeId: hubId, careerSnapshotId: pin, operationAuthority: s1.receipt,
          canvasFilePath: canvas, enabledSourceIds: ['remoteok'], preferredLocation: '', targetRole: 'Software Engineer',
        });
        await providerCompletedGate;
        await claimJobAnalysisOperationAuthority({ canvasFilePath: canvas, hubId, operationId: 's2', semanticBase: base('search', { runId: 'run-2' }) });
        superseded = true;
        releaseProvider();
        const result = await searching;
        const state = await readRunState(canvas, Date.now(), { nodeId: hubId });
        assert(result.operationSuperseded === true,
          'a post-provider stale search must not return a successful collection result');
        assert(stageAttempts === 0 && progressAfterSupersede === 0,
          'a post-provider stale search must not stage, checkpoint, or emit terminal progress after S2');
        assert(state?.stagedJobs?.length === 0 && state?.manifest?.sources?.remoteok?.status === 'pending',
          'S1 provider output must leave no durable source completion after S2 supersedes it');
        return { postProviderSuperseded: true, stageAttempts, progressAfterSupersede };
      } finally {
        registerJobsHandlers();
        await fs.promises.rm(directory, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'operation authority: terminal receipt-update crash retries only with the exact receipt and closes its capability',
    run: async () => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-operation-terminal-retry-'));
      const canvas = path.join(directory, 'canvas.json');
      const hubId = 'hub';
      const runId = 'terminal-run';
      const request = { canvasFilePath: canvas, hubId, operationId: 's1', semanticBase: base() };
      const sender = { id: 7_713, isDestroyed: () => false, once: () => {}, on: () => {}, removeListener: () => {}, send: () => {} };
      const originalRename = fs.promises.rename;
      const originalTrashItem = electronPkg.shell.trashItem;
      try {
        await fs.promises.writeFile(canvas, '{}');
        const claimed = await claimJobAnalysisOperationAuthority(request);
        assert((await startRun(canvas, {
          runId, startedAt: 1_700_000_000_000, nodeId: hubId,
          careerSnapshotId: pin, profileFingerprint: 'b'.repeat(64), sourceIds: ['provider'],
          operationAuthority: claimed.receipt,
        }))?.runId === runId, 'fixture must persist a terminally-owned S1 manifest');
        assert(await recordSourcePage(canvas, {
          sourceId: 'provider', query: 'engineer', page: 0, jobs: [{ title: 'terminal fixture row' }], now: 1_700_000_000_100,
          expectedRunId: runId, nodeId: hubId, expectedOperationAuthority: claimed.receipt,
        }) === true, 'fixture must create a staged row for terminal cleanup');

        registerJobsHandlers();
        const complete = ipcMain.__getInvokeHandler('complete-job-run');
        const receiptPath = lastRunReceiptPathForCanvas(canvas, hubId);
        let receiptRenames = 0;
        electronPkg.shell.trashItem = async filePath => fs.promises.unlink(filePath);
        fs.promises.rename = async (source, destination) => {
          if (destination === receiptPath && ++receiptRenames === 2) {
            const error = new Error('simulated crash before terminal receipt update');
            error.code = 'EIO';
            throw error;
          }
          return originalRename(source, destination);
        };
        const args = {
          canvasFilePath: canvas, nodeId: hubId, runId,
          terminalStatus: 'completed', terminalOutcome: 'populated', careerSnapshotId: pin,
          operationAuthority: claimed.receipt,
        };
        const interrupted = await complete({ sender }, args);
        fs.promises.rename = originalRename;
        assert(interrupted.success === true && interrupted.ok === false && interrupted.cleared === true
          && interrupted.receiptUpdateFailed === true && (await readRunState(canvas, Date.now(), { nodeId: hubId })) === null,
        'a crash after sidecar deletion but before final receipt acknowledgement must leave an exact receipt-only retry state');

        const wrongRetry = await complete({ sender }, { ...args, operationAuthority: {
          ...claimed.receipt, revision: claimed.receipt.revision + 1,
        } });
        const exactRetry = await complete({ sender }, args);
        assert(wrongRetry.success === true && wrongRetry.ok === false && wrongRetry.operationAuthorityMismatch === true
          && exactRetry.success === true && exactRetry.ok === true && exactRetry.cleared === true
          && !(await currentJobAnalysisOperationAuthority({ ...request, revision: claimed.receipt.revision })),
        `only the exact terminal receipt may finish cleanup after a crash, and that success must tombstone its write capability: ${JSON.stringify({ wrongRetry, exactRetry })}`);
        return { interruptedAfterCleanup: true, foreignRetryRejected: true, exactRetryTombstoned: true };
      } finally {
        fs.promises.rename = originalRename;
        electronPkg.shell.trashItem = originalTrashItem;
        await fs.promises.rm(directory, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'operation authority: terminal cleanup with ok-but-not-cleared remains retryable and only a cleared retry tombstones',
    run: async () => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-operation-terminal-partial-cleanup-'));
      const canvas = path.join(directory, 'canvas.json');
      const hubId = 'hub';
      const runId = 'partial-terminal-run';
      const request = { canvasFilePath: canvas, hubId, operationId: 's1', semanticBase: base() };
      const sender = { id: 7_716, isDestroyed: () => false, once: () => {}, on: () => {}, removeListener: () => {}, send: () => {} };
      const originalTrashItem = electronPkg.shell.trashItem;
      try {
        await fs.promises.writeFile(canvas, '{}');
        const claimed = await claimJobAnalysisOperationAuthority(request);
        assert((await startRun(canvas, {
          runId, startedAt: 1_700_000_000_000, nodeId: hubId,
          careerSnapshotId: pin, profileFingerprint: 'b'.repeat(64), sourceIds: ['provider'], operationAuthority: claimed.receipt,
        }))?.runId === runId, 'fixture must create a terminally-owned S1 run');
        assert(await recordSourcePage(canvas, {
          sourceId: 'provider', query: 'engineer', page: 0, jobs: [{ title: 'partial cleanup row' }], now: 1_700_000_000_100,
          expectedRunId: runId, nodeId: hubId, expectedOperationAuthority: claimed.receipt,
        }) === true, 'fixture must create a sidecar whose cleanup can remain incomplete');
        registerJobsHandlers();
        const complete = ipcMain.__getInvokeHandler('complete-job-run');
        const args = {
          canvasFilePath: canvas, nodeId: hubId, runId, terminalStatus: 'completed', terminalOutcome: 'populated',
          careerSnapshotId: pin, operationAuthority: claimed.receipt,
        };
        // Resolve without deletion: clearRun observes the surviving sidecar
        // and returns { ok:true, cleared:false }, which is a retry state.
        electronPkg.shell.trashItem = async () => {};
        const partial = await complete({ sender }, args);
        assert(partial.success === true && partial.ok === false && partial.cleared === false
          && await currentJobAnalysisOperationAuthority({ ...request, revision: claimed.receipt.revision }),
        'a terminal cleanup that did not clear every sidecar must retain its exact active retry capability');
        electronPkg.shell.trashItem = async filePath => fs.promises.unlink(filePath);
        const retried = await complete({ sender }, args);
        assert(retried.success === true && retried.ok === true && retried.cleared === true
          && !(await currentJobAnalysisOperationAuthority({ ...request, revision: claimed.receipt.revision })),
        'only the exact retry that confirms cleanup may close the terminal write capability');
        return { partialRetryable: true, clearedRetryTombstoned: true };
      } finally {
        electronPkg.shell.trashItem = originalTrashItem;
        await fs.promises.rm(directory, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'operation authority: fresh null-run S1 may bind exactly once to its manifest run on S2 resume',
    run: async () => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-operation-null-s1-rebind-'));
      const canvas = path.join(directory, 'canvas.json');
      const hubId = 'hub';
      const runId = 'main-allocated-run';
      try {
        await fs.promises.writeFile(canvas, '{}');
        // This models the actual renderer path: claim S1 before main has
        // generated the durable run id, then bind that receipt into startRun.
        const s1 = await claimJobAnalysisOperationAuthority({
          canvasFilePath: canvas, hubId, operationId: 'fresh-s1',
          semanticBase: base('search', { runId: null, fingerprint: 'fresh-s1' }),
        });
        assert((await startRun(canvas, {
          runId, startedAt: 1_700_000_000_000, nodeId: hubId,
          careerSnapshotId: pin, profileFingerprint: 'b'.repeat(64), sourceIds: ['provider'],
          operationAuthority: s1.receipt,
        }))?.runId === runId, 'fixture must bind a null-run S1 into its exact durable manifest');
        const s2 = await claimJobAnalysisOperationAuthority({
          canvasFilePath: canvas, hubId, operationId: 'resume-s2',
          semanticBase: base('resume', { runId, fingerprint: 'resume-s2' }), predecessor: s1.receipt,
        });
        const rebound = await rebindRunOperationAuthority(canvas, {
          expectedRunId: runId, expectedNodeId: hubId, careerSnapshotId: pin,
          currentAuthority: s2.receipt, predecessorAuthority: s1.receipt,
        });
        const state = await readRunState(canvas, Date.now(), { nodeId: hubId });
        assert(s1.admitted && s2.admitted && rebound.ok && rebound.rebound
          && state?.manifest?.runId === runId
          && state?.manifest?.inputs?.careerSnapshotId === pin
          && state?.manifest?.inputs?.operationAuthority?.operationId === s2.receipt.operationId,
        'only the exact null-run S1 sealed in the manifest may adopt the main-assigned run on S2');
        return { nullS1BoundByManifest: true, s2Rebound: true };
      } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'operation authority: resume manifest lineage permits only exact immediate predecessor adoption',
    run: async () => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-operation-resume-lineage-'));
      const canvas = path.join(directory, 'canvas.json');
      const hubId = 'hub';
      const runId = 'run-1';
      const startManifest = async (authority) => startRun(canvas, {
        runId, startedAt: 1_700_000_000_000, nodeId: hubId,
        careerSnapshotId: pin, profileFingerprint: 'b'.repeat(64), requireCareerSnapshot: true,
        operationAuthority: authority,
      });
      const resumeBase = (suffix) => base('resume', { runId, fingerprint: `resume-${suffix}` });
      try {
        await fs.promises.writeFile(canvas, '{}');
        const s1 = await claimJobAnalysisOperationAuthority({ canvasFilePath: canvas, hubId, operationId: 's1', semanticBase: base() });
        assert((await startManifest(s1.receipt))?.runId === runId, 'fixture must persist S1 in the exact manifest');
        const s2 = await claimJobAnalysisOperationAuthority({
          canvasFilePath: canvas, hubId, operationId: 's2', semanticBase: resumeBase('s2'), predecessor: s1.receipt,
        });
        const first = await rebindRunOperationAuthority(canvas, {
          expectedRunId: runId, expectedNodeId: hubId, careerSnapshotId: pin,
          currentAuthority: s2.receipt, predecessorAuthority: s1.receipt,
        });
        const repeat = await rebindRunOperationAuthority(canvas, {
          expectedRunId: runId, expectedNodeId: hubId, careerSnapshotId: pin,
          currentAuthority: s2.receipt, predecessorAuthority: s1.receipt,
        });
        assert(s2.admitted && first.ok && first.rebound && repeat.ok && repeat.idempotent,
          'S1→S2 must rebind the exact manifest once and make identical S2 resume idempotent');
        const wrongCurrentCareer = await rebindRunOperationAuthority(canvas, {
          expectedRunId: runId, expectedNodeId: hubId, careerSnapshotId: pin,
          currentAuthority: {
            ...s2.receipt,
            semanticBase: { ...s2.receipt.semanticBase, careerSnapshotId: 'c'.repeat(64) },
          },
          predecessorAuthority: s1.receipt,
        });
        const wrongPredecessorRun = await rebindRunOperationAuthority(canvas, {
          expectedRunId: runId, expectedNodeId: hubId, careerSnapshotId: pin,
          currentAuthority: s2.receipt,
          predecessorAuthority: {
            ...s1.receipt,
            semanticBase: { ...s1.receipt.semanticBase, runId: 'other-run' },
          },
        });
        assert(!wrongCurrentCareer.ok && wrongCurrentCareer.reason === 'authority-semantic-mismatch'
          && !wrongPredecessorRun.ok && wrongPredecessorRun.reason === 'authority-semantic-mismatch',
        'a rebind must reject a current or immediate-predecessor receipt whose career pin or run differs from the manifest tuple');

        // Separate lineage: S2 is admitted but never reaches the manifest,
        // then S3 must not skip S2 and adopt manifest S1 directly.
        const skipCanvas = path.join(directory, 'skip.json');
        await fs.promises.writeFile(skipCanvas, '{}');
        const skipS1 = await claimJobAnalysisOperationAuthority({ canvasFilePath: skipCanvas, hubId, operationId: 'skip-s1', semanticBase: base() });
        assert((await startRun(skipCanvas, {
          runId, startedAt: 1_700_000_000_001, nodeId: hubId, careerSnapshotId: pin,
          profileFingerprint: 'b'.repeat(64), requireCareerSnapshot: true, operationAuthority: skipS1.receipt,
        }))?.runId === runId, 'skip fixture must persist S1');
        const skipS2 = await claimJobAnalysisOperationAuthority({
          canvasFilePath: skipCanvas, hubId, operationId: 'skip-s2', semanticBase: resumeBase('skip-s2'), predecessor: skipS1.receipt,
        });
        const skipS3 = await claimJobAnalysisOperationAuthority({
          canvasFilePath: skipCanvas, hubId, operationId: 'skip-s3', semanticBase: resumeBase('skip-s3'), predecessor: skipS2.receipt,
        });
        const skipped = await rebindRunOperationAuthority(skipCanvas, {
          expectedRunId: runId, expectedNodeId: hubId, careerSnapshotId: pin,
          currentAuthority: skipS3.receipt, predecessorAuthority: skipS2.receipt,
        });
        assert(skipS2.admitted && skipS3.admitted && !skipped.ok && skipped.reason === 'manifest-predecessor-mismatch',
          'S3 claimed after unbound S2 must not skip that predecessor and adopt manifest S1');
        return { reboundOnce: true, idempotent: true, semanticTupleFenced: true, skippedRejected: true };
      } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'operation authority: exact stopped predecessor can resume lineage but clear is never a predecessor',
    run: async () => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-operation-revoked-lineage-'));
      const hubId = 'hub';
      const runId = 'run-1';
      const resumeBase = base('resume', { runId, fingerprint: 'resume-stop' });
      const start = async (canvas, authority) => startRun(canvas, {
        runId, startedAt: 1_700_000_000_100, nodeId: hubId, careerSnapshotId: pin,
        profileFingerprint: 'b'.repeat(64), requireCareerSnapshot: true, operationAuthority: authority,
      });
      try {
        const stoppedCanvas = path.join(directory, 'stopped.json');
        await fs.promises.writeFile(stoppedCanvas, '{}');
        const stoppedS1Request = { canvasFilePath: stoppedCanvas, hubId, operationId: 's1', semanticBase: base() };
        const s1 = await claimJobAnalysisOperationAuthority(stoppedS1Request);
        await start(stoppedCanvas, s1.receipt);
        const stopped = await revokeJobAnalysisOperationAuthority({ ...stoppedS1Request, revision: s1.receipt.revision });
        const s2 = await claimJobAnalysisOperationAuthority({
          canvasFilePath: stoppedCanvas, hubId, operationId: 's2', semanticBase: resumeBase, predecessor: stopped.receipt,
        });
        const resumedStopped = await rebindRunOperationAuthority(stoppedCanvas, {
          expectedRunId: runId, expectedNodeId: hubId, careerSnapshotId: pin,
          currentAuthority: s2.receipt, predecessorAuthority: stopped.receipt,
        });
        assert(stopped.revoked && s2.admitted && resumedStopped.ok,
          'an exact ordinary Stop/revoked receipt must remain an admissible immediate resume predecessor');

        const clearCanvas = path.join(directory, 'cleared.json');
        await fs.promises.writeFile(clearCanvas, '{}');
        const clearS1 = await claimJobAnalysisOperationAuthority({ canvasFilePath: clearCanvas, hubId, operationId: 'clear-s1', semanticBase: base() });
        await start(clearCanvas, clearS1.receipt);
        const cleared = await clearJobAnalysisOperationAuthority({ canvasFilePath: clearCanvas, hubId });
        const clearResume = await claimJobAnalysisOperationAuthority({
          canvasFilePath: clearCanvas, hubId, operationId: 'clear-s2', semanticBase: resumeBase, predecessor: cleared.receipt,
        });
        assert(cleared.cleared && !clearResume.admitted && clearResume.reason === 'resume-predecessor-mismatch',
          'Clear career data must never be an admissible resume lineage predecessor');
        return { stoppedResumed: true, clearRejected: true };
      } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'operation authority: renderer-visible receipts are sanitized capabilities, not sidecar records',
    run: async () => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-operation-public-receipt-'));
      const canvas = path.join(directory, 'private-canvas-name.json');
      const owner = { canvasFilePath: canvas, hubId: 'private-hub', operationId: 's1', semanticBase: base() };
      try {
        await fs.promises.writeFile(canvas, '{}');
        const claim = await claimJobAnalysisOperationAuthority(owner);
        const keys = Object.keys(claim.receipt || {}).sort();
        const serialized = JSON.stringify(claim.receipt);
        assert(claim.admitted && keys.join(',') === 'operationId,revision,semanticBase'
          && !serialized.includes(canvas) && !serialized.includes('private-hub')
          && !serialized.includes('publications') && !serialized.includes('pendingPublications'),
        'preload-facing claim acknowledgements may expose only the opaque exact receipt, never path/owner/publication internals');
        const revoked = await revokeJobAnalysisOperationAuthority({ ...owner, revision: claim.receipt.revision });
        assert(revoked.revoked && Object.keys(revoked.receipt || {}).sort().join(',') === 'operationId,revision,semanticBase',
          'the revoke acknowledgement must remain equally sanitized');
        return { receiptKeys: keys };
      } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'operation authority: more than sixteen sequential checkpoint publication/cleanup cycles retain authority',
    run: async () => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-operation-checkpoint-prune-'));
      const canvas = path.join(directory, 'canvas.json');
      const owner = { canvasFilePath: canvas, hubId: 'hub', operationId: 's1', semanticBase: base() };
      try {
        await fs.promises.writeFile(canvas, '{}');
        const claimed = await claimJobAnalysisOperationAuthority(owner);
        const current = snapshot({ canvasFilePath: canvas, authority: claimed.receipt, title: 'Stable global publication' });
        assert(!(await __saveJobAnalysisSnapshotForTests(current)).retired, 'fixture must create a sealed global publication');
        for (let index = 0; index < 20; index += 1) {
          const runId = `checkpoint-${index}`;
          const checkpoint = snapshot({ canvasFilePath: canvas, runId, authority: claimed.receipt, title: `Checkpoint ${index}` });
          const created = await __createDescriptionRecoveryCheckpointForTests(checkpoint);
          assert(created.saved, `checkpoint ${index} must publish before cleanup`);
          const removed = await __removeDescriptionRecoveryCheckpointForTests(canvas, 'hub', runId);
          assert(removed.removed, `checkpoint ${index} cleanup must retire its exact slot`);
          assert(await currentJobAnalysisOperationAuthority({ ...owner, revision: claimed.receipt.revision }),
            `checkpoint ${index} cleanup must not corrupt S1 write authority`);
        }
        const restarted = await import(`../../electron/ipc/jobs.js?checkpoint-prune=${Date.now()}`);
        const restored = await restarted.__loadJobAnalysisSnapshotForTests(canvas, 'hub', 'run-1');
        assert(restored.snapshot.jobs[0]?.title === 'Stable global publication',
          'checkpoint publication cleanup must prune its map entries rather than exhausting the bounded authority map');
        return { cycles: 20 };
      } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'operation authority: one stale receipt cannot rewrite either global snapshot or run-keyed checkpoint',
    run: async () => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-operation-checkpoint-fence-'));
      const canvas = path.join(directory, 'canvas.json');
      const s1 = { canvasFilePath: canvas, hubId: 'hub', operationId: 's1', semanticBase: base() };
      const s2 = { canvasFilePath: canvas, hubId: 'hub', operationId: 's2', semanticBase: base('search', { runId: 'run-2' }) };
      try {
        await fs.promises.writeFile(canvas, '{}');
        const one = await claimJobAnalysisOperationAuthority(s1);
        const original = snapshot({ canvasFilePath: canvas, authority: one.receipt, title: 'S1 global and checkpoint' });
        assert(!(await __saveJobAnalysisSnapshotForTests(original)).retired, 'S1 must publish the global snapshot');
        const firstCheckpoint = await __createDescriptionRecoveryCheckpointForTests(original);
        assert(firstCheckpoint.saved, 'S1 must publish its exact run-keyed checkpoint');
        const globalPaths = getJobAnalysisPaths(canvas, null, 'hub');
        const beforeGlobal = await fs.promises.readFile(globalPaths.jsonPath, 'utf8');
        const beforeCheckpoint = await fs.promises.readFile(firstCheckpoint.checkpointPath, 'utf8');

        await claimJobAnalysisOperationAuthority(s2);
        const stale = { ...original, jobs: [{ title: 'STALE GLOBAL WRITE' }], preferenceCandidatePool: [{ title: 'STALE GLOBAL WRITE' }] };
        const staleGlobal = await __saveJobAnalysisSnapshotForTests(stale);
        const staleCheckpoint = await __createDescriptionRecoveryCheckpointForTests(stale);
        assert(staleGlobal.retired && !staleCheckpoint.saved,
          'S2 admission must fence every old-receipt global/checkpoint writer');
        assert((await fs.promises.readFile(globalPaths.jsonPath, 'utf8')) === beforeGlobal
          && (await fs.promises.readFile(firstCheckpoint.checkpointPath, 'utf8')) === beforeCheckpoint,
        'a rejected stale writer must not change either artifact before reporting failure');
        const preserved = await __loadDescriptionRecoveryCheckpointForTests(canvas, 'hub', 'run-1');
        assert(preserved.snapshot.jobs[0].title === 'S1 global and checkpoint',
          'the S1 checkpoint remains a readable sealed recovery point after the S2 fence');
        return { globalFenced: true, checkpointFenced: true };
      } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'operation authority: fresh/resume and checkpoint paths require exact run, node, career pin, and receipt',
    run: async () => {
      const receipt = { operationId: 's1', semanticBase: base(), revision: 7 };
      const exactSnapshot = snapshot({ canvasFilePath: '/tmp/canvas.json', authority: receipt });
      const exactManifest = { stage: 'gathered', runId: 'run-1', inputs: { nodeId: 'hub', careerSnapshotId: pin, operationAuthority: receipt } };
      assert(assessDescriptionRecoverySnapshotOwnership({ snapshot: exactSnapshot, origin: 'current', nodeId: 'hub', jobRunId: 'run-1', careerSnapshotId: pin, operationAuthority: receipt }).ok
        && isLiveDescriptionRecoveryRun(exactManifest, 'hub', 'run-1', { careerSnapshotId: pin, operationAuthority: receipt }),
      'fixture establishes an exact fresh/resume tuple');
      const wrongRun = assessDescriptionRecoverySnapshotOwnership({ snapshot: exactSnapshot, origin: 'current', nodeId: 'hub', jobRunId: 'other-run', careerSnapshotId: pin, operationAuthority: receipt });
      const wrongHub = assessDescriptionRecoverySnapshotOwnership({ snapshot: exactSnapshot, origin: 'current', nodeId: 'other-hub', jobRunId: 'run-1', careerSnapshotId: pin, operationAuthority: receipt });
      const wrongCareer = assessDescriptionRecoverySnapshotOwnership({ snapshot: { ...exactSnapshot, careerSnapshotId: 'b'.repeat(64) }, origin: 'current', nodeId: 'hub', jobRunId: 'run-1', careerSnapshotId: pin, operationAuthority: receipt });
      const missingReceipt = assessDescriptionRecoverySnapshotOwnership({ snapshot: { ...exactSnapshot, operationAuthority: null }, origin: 'current', nodeId: 'hub', jobRunId: 'run-1', careerSnapshotId: pin, operationAuthority: receipt });
      assert(!wrongRun.ok && !wrongHub.ok && !wrongCareer.ok && !missingReceipt.ok
        && !isLiveDescriptionRecoveryRun({ ...exactManifest, inputs: { ...exactManifest.inputs, careerSnapshotId: 'b'.repeat(64) } }, 'hub', 'run-1', { careerSnapshotId: pin, operationAuthority: receipt }),
      'resume/checkpoint authorization must fail closed for every run/node/career/receipt mismatch');
      return { tupleMismatchesRejected: true };
    },
  },
  {
    name: 'operation authority: crash at every generation rename or publication-map phase preserves an exact sealed recovery',
    run: async () => {
      // `rename` is the real crash boundary: throwing immediately after the
      // syscall models a process that dies after that artifact reached disk,
      // before the surrounding transaction can acknowledge success.
      const boundaries = [
        'pending-publication-map', 'current', 'success:3', 'success:2',
        'success:1', 'published-publication-map',
      ];
      const outcomes = [];
      for (const boundary of boundaries) {
        const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-operation-rotation-crash-'));
        const canvas = path.join(directory, 'canvas.json');
        const hubId = 'hub';
        const originalRename = fs.promises.rename;
        let authorityRenames = 0;
        let injected = false;
        try {
          await fs.promises.writeFile(canvas, '{}');
          // Establish a real three-generation rotation under three old exact
          // receipts; a fourth save is the transaction we interrupt.
          for (let number = 1; number <= 3; number += 1) {
            const operation = {
              canvasFilePath: canvas, hubId, operationId: `seed-${number}`,
              semanticBase: base('search', { runId: `seed-run-${number}` }),
            };
            const claimed = await claimJobAnalysisOperationAuthority(operation);
            const saved = await __saveJobAnalysisSnapshotForTests(snapshot({
              canvasFilePath: canvas, hubId, runId: `seed-run-${number}`,
              authority: claimed.receipt, title: `Seed ${number}`,
            }));
            assert(!saved.retired, `seed ${number} must establish an on-disk successful generation`);
          }
          const incoming = {
            canvasFilePath: canvas, hubId, operationId: 'crash-run',
            semanticBase: base('search', { runId: 'crash-run' }),
          };
          const claimed = await claimJobAnalysisOperationAuthority(incoming);
          const paths = getJobAnalysisPaths(canvas, null, hubId);
          const targetFor = (destination) => {
            if (destination === paths.operationAuthorityPath) {
              authorityRenames += 1;
              return authorityRenames === 1 ? 'pending-publication-map' : 'published-publication-map';
            }
            if (destination === paths.jsonPath) return 'current';
            if (destination === paths.lastSuccessJsonPaths[0]) return 'success:1';
            if (destination === paths.lastSuccessJsonPaths[1]) return 'success:2';
            if (destination === paths.lastSuccessJsonPaths[2]) return 'success:3';
            return null;
          };
          fs.promises.rename = async (source, destination) => {
            const result = await originalRename(source, destination);
            if (!injected && targetFor(destination) === boundary) {
              injected = true;
              throw new Error(`simulated crash after ${boundary} rename`);
            }
            return result;
          };
          let interrupted = false;
          try {
            await __saveJobAnalysisSnapshotForTests(snapshot({
              canvasFilePath: canvas, hubId, runId: 'crash-run', authority: claimed.receipt, title: 'Newer interrupted generation',
            }));
          } catch (error) { interrupted = /simulated crash/.test(error?.message || ''); }
          assert(injected && interrupted, `${boundary} must inject after its actual durable rename`);
          fs.promises.rename = originalRename;

          const restarted = await import(`../../electron/ipc/jobs.js?rotation-crash=${boundary}-${Date.now()}`);
          const recovered = await restarted.__loadJobAnalysisSnapshotForTests(canvas, hubId);
          assert(/^Seed [1-3]$|^Newer interrupted generation$/.test(recovered.snapshot.jobs[0]?.title || ''),
            `${boundary}: restart must select an exact pre-existing or pending publication, never invent content`);

          // A copied/mutated byte sequence must not be admitted as this slot.
          const altered = JSON.parse(await fs.promises.readFile(recovered.paths.jsonPath, 'utf8'));
          altered.jobs[0].title = 'TAMPERED AFTER CRASH';
          altered.preferenceCandidatePool[0].title = 'TAMPERED AFTER CRASH';
          await fs.promises.writeFile(recovered.paths.jsonPath, `${JSON.stringify(altered)}\n`);
          const afterTamper = await restarted.__loadJobAnalysisSnapshotForTests(canvas, hubId);
          assert(afterTamper.snapshot.jobs[0]?.title !== 'TAMPERED AFTER CRASH',
            `${boundary}: a restart may fall back, but must never admit mismatched bytes from a sealed slot`);
          outcomes.push(boundary);
        } finally {
          fs.promises.rename = originalRename;
          await fs.promises.rm(directory, { recursive: true, force: true });
        }
      }
      return { crashBoundaries: outcomes };
    },
  },
  {
    name: 'operation authority: a second pre-rename crash reconciles the first pending rotation instead of losing D/A/B',
    run: async () => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-operation-double-crash-'));
      const canvas = path.join(directory, 'canvas.json');
      const hubId = 'hub';
      const originalRename = fs.promises.rename;
      try {
        await fs.promises.writeFile(canvas, '{}');
        // S0 establishes three durable recovery positions. The names are
        // deliberately semantic (A/B/C), not generation numbers.
        for (const [operationId, runId, title] of [['s0-c', 'run-c', 'C'], ['s0-b', 'run-b', 'B'], ['s0-a', 'run-a', 'A']]) {
          const claimed = await claimJobAnalysisOperationAuthority({
            canvasFilePath: canvas, hubId, operationId, semanticBase: base('search', { runId }),
          });
          assert(!(await __saveJobAnalysisSnapshotForTests(snapshot({ canvasFilePath: canvas, hubId, runId, authority: claimed.receipt, title }))).retired,
            `S0 ${title} must publish`);
        }
        const paths = getJobAnalysisPaths(canvas, null, hubId);
        const s1 = await claimJobAnalysisOperationAuthority({
          canvasFilePath: canvas, hubId, operationId: 's1-d', semanticBase: base('search', { runId: 'run-d' }),
        });
        // Crash 1: every S1 artifact rename has completed, but its pending
        // publication map has not been promoted. Disk now contains D/A/B-ish
        // rotation state that must survive a later claim.
        let firstCrash = false;
        fs.promises.rename = async (source, destination) => {
          const result = await originalRename(source, destination);
          if (!firstCrash && destination === paths.lastSuccessJsonPaths[0]) {
            firstCrash = true;
            throw new Error('simulated crash after final S1 rename');
          }
          return result;
        };
        try {
          await __saveJobAnalysisSnapshotForTests(snapshot({ canvasFilePath: canvas, hubId, runId: 'run-d', authority: s1.receipt, title: 'D' }));
        } catch { /* expected process-style interruption */ }
        assert(firstCrash, 'first crash must occur after S1 current/generation renames');
        fs.promises.rename = originalRename;

        // Restart, admit S2, then crash immediately after staging S2's map
        // and before any S2 artifact rename. This is the counterexample where
        // simply discarding S1 pending state makes D unreadable.
        const restartedStore = await import(`../../electron/ipc/jobAnalysisOperationAuthorityStore.js?double-crash-claim=${Date.now()}`);
        const s2 = await restartedStore.claimJobAnalysisOperationAuthority({
          canvasFilePath: canvas, hubId, operationId: 's2-e', semanticBase: base('search', { runId: 'run-e' }),
        });
        let authorityRenames = 0;
        let secondCrash = false;
        fs.promises.rename = async (source, destination) => {
          const result = await originalRename(source, destination);
          if (destination === paths.operationAuthorityPath) authorityRenames += 1;
          if (!secondCrash && destination === paths.operationAuthorityPath && authorityRenames === 1) {
            secondCrash = true;
            throw new Error('simulated crash after S2 pending map');
          }
          return result;
        };
        try {
          await __saveJobAnalysisSnapshotForTests(snapshot({ canvasFilePath: canvas, hubId, runId: 'run-e', authority: s2.receipt, title: 'E' }));
        } catch { /* expected process-style interruption */ }
        assert(secondCrash, 'second crash must occur before an S2 artifact rename');
        fs.promises.rename = originalRename;

        const restartedJobs = await import(`../../electron/ipc/jobs.js?double-crash-read=${Date.now()}`);
        const recoveredD = await restartedJobs.__loadJobAnalysisSnapshotForTests(canvas, hubId, 'run-d');
        assert(recoveredD.snapshot.jobs[0]?.title === 'D',
          'after S1 renamed D and S2 crashed pre-rename, D must remain exactly recoverable');
        const survivors = await Promise.all(['run-a', 'run-b', 'run-c'].map(async runId => {
          try { return (await restartedJobs.__loadJobAnalysisSnapshotForTests(canvas, hubId, runId)).snapshot.jobs[0]?.title; }
          catch { return null; }
        }));
        assert(survivors.filter(Boolean).length >= 2 && !survivors.includes('E'),
          'the second pending map may not make unrenamed E readable or discard every remaining S0 recovery point');
        return { recovered: ['D', ...survivors.filter(Boolean)] };
      } finally {
        fs.promises.rename = originalRename;
        await fs.promises.rm(directory, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'operation authority: publication-map recovery rejects symlink and oversize artifacts without following them',
    run: async () => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-operation-map-safe-read-'));
      const canvas = path.join(directory, 'canvas.json');
      const hubId = 'hub';
      try {
        await fs.promises.writeFile(canvas, '{}');
        const s1 = await claimJobAnalysisOperationAuthority({ canvasFilePath: canvas, hubId, operationId: 'map-s1', semanticBase: base() });
        await __saveJobAnalysisSnapshotForTests(snapshot({ canvasFilePath: canvas, hubId, authority: s1.receipt }));
        const paths = getJobAnalysisPaths(canvas, null, hubId);
        const originalPublication = await fs.promises.readFile(paths.jsonPath);
        const record = JSON.parse(await fs.promises.readFile(paths.operationAuthorityPath, 'utf8'));
        record.pendingPublications = record.publications;
        await fs.promises.writeFile(paths.operationAuthorityPath, `${JSON.stringify(record)}\n`);
        const outside = path.join(directory, 'outside.json');
        await fs.promises.writeFile(outside, JSON.stringify({ secret: 'must-not-follow' }));
        await fs.promises.unlink(paths.jsonPath);
        await fs.promises.symlink(outside, paths.jsonPath);
        const transaction = await withCurrentJobAnalysisOperationAuthority({ canvasFilePath: canvas, hubId, ...s1.receipt }, () => ({ ok: true }));
        const afterLink = JSON.parse(await fs.promises.readFile(paths.operationAuthorityPath, 'utf8'));
        assert(transaction.admitted && afterLink.pendingPublications,
          'a symlinked publication must fail closed instead of being read/promoted');
        await fs.promises.unlink(paths.jsonPath);
        await fs.promises.writeFile(paths.jsonPath, Buffer.alloc(64 * 1024 * 1024 + 1));
        const oversized = await withCurrentJobAnalysisOperationAuthority({ canvasFilePath: canvas, hubId, ...s1.receipt }, () => ({ ok: true }));
        const afterOversize = JSON.parse(await fs.promises.readFile(paths.operationAuthorityPath, 'utf8'));
        assert(oversized.admitted && afterOversize.pendingPublications,
          'an oversized publication must fail closed instead of being loaded into recovery reconciliation');
        await fs.promises.writeFile(paths.jsonPath, originalPublication);
        const originalOpen = fs.promises.open;
        let swappedAfterOpen = false;
        fs.promises.open = async (filePath, ...args) => {
          const handle = await originalOpen(filePath, ...args);
          if (!swappedAfterOpen && filePath === paths.jsonPath) {
            swappedAfterOpen = true;
            await fs.promises.rename(paths.jsonPath, `${paths.jsonPath}.opened-original`);
            await fs.promises.writeFile(paths.jsonPath, JSON.stringify({ replacement: true }));
          }
          return handle;
        };
        let swapped;
        try {
          swapped = await withCurrentJobAnalysisOperationAuthority({ canvasFilePath: canvas, hubId, ...s1.receipt }, () => ({ ok: true }));
        } finally { fs.promises.open = originalOpen; }
        const afterSwap = JSON.parse(await fs.promises.readFile(paths.operationAuthorityPath, 'utf8'));
        assert(swappedAfterOpen && swapped.admitted && afterSwap.pendingPublications,
          'a rename after descriptor open must fail closed rather than promote the replaced pathname');
        return { symlinkRejected: true, oversizeRejected: true, renameSwapRejected: true };
      } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'operation authority: Board cancellation retires only its exact sealed run and preserves newer generations',
    run: async () => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-operation-board-discard-'));
      const canvas = path.join(directory, 'canvas.json');
      const hubId = 'hub';
      try {
        await fs.promises.writeFile(canvas, '{}');
        const s1 = await claimJobAnalysisOperationAuthority({ canvasFilePath: canvas, hubId, operationId: 'board-s1', semanticBase: base() });
        await __saveJobAnalysisSnapshotForTests(snapshot({ canvasFilePath: canvas, hubId, authority: s1.receipt, title: 'cancelled' }));
        const retired = await __discardCancelledBoardRunArtifactsForTests(canvas, hubId, 'run-1', s1.receipt);
        assert(retired.ok && retired.cleared,
          `exact Board cancel must retire its own sealed artifact: ${JSON.stringify(retired)}`);
        const s2 = await claimJobAnalysisOperationAuthority({ canvasFilePath: canvas, hubId, operationId: 'board-s2', semanticBase: base('search', { runId: 'run-2' }) });
        await __saveJobAnalysisSnapshotForTests(snapshot({ canvasFilePath: canvas, hubId, runId: 'run-2', authority: s2.receipt, title: 'newer' }));
        const stale = await __discardCancelledBoardRunArtifactsForTests(canvas, hubId, 'run-1', s1.receipt);
        const current = await __loadJobAnalysisSnapshotForTests(canvas, hubId, 'run-2');
        assert(stale.operationSuperseded && current.snapshot.jobs[0]?.title === 'newer',
          'a late Board cancellation must not remove a successor snapshot');
        return { exactRetired: true, successorPreserved: true };
      } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'operation authority: Board history token is sender-bound, one-shot, and rejects source supersession',
    run: async () => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-operation-board-history-'));
      const canvas = path.join(directory, 'canvas.json');
      const hubId = 'hub';
      const sender = { id: 81 };
      try {
        await fs.promises.writeFile(canvas, '{}');
        const s1 = await claimJobAnalysisOperationAuthority({ canvasFilePath: canvas, hubId, operationId: 'history-s1', semanticBase: base() });
        await __saveJobAnalysisSnapshotForTests(snapshot({ canvasFilePath: canvas, hubId, authority: s1.receipt }));
        const rows = [{ source: 'remoteok', company: 'Example', title: 'Role', location: 'Toronto', url: 'https://example.test/role' }];
        const prepared = await __boardHistoryAuthorityForTests.prepare({ sender }, {
          canvasFilePath: canvas, jobs: rows,
          sources: [{ hubId, runId: 'run-1', careerSnapshotId: pin, operationAuthority: s1.receipt }],
        });
        assert(prepared.success && prepared.historyToken, 'fixture must receive a sealed host history token');
        const wrongSender = await __boardHistoryAuthorityForTests.consume({ sender: { id: 82 } }, {
          canvasFilePath: canvas, jobs: rows, historyToken: prepared.historyToken,
        });
        assert(wrongSender.operationSuperseded, 'history token must not cross renderer senders');
        const committed = await __boardHistoryAuthorityForTests.consume({ sender }, {
          canvasFilePath: canvas, jobs: rows, historyToken: prepared.historyToken,
        });
        const replay = await __boardHistoryAuthorityForTests.consume({ sender }, {
          canvasFilePath: canvas, jobs: rows, historyToken: prepared.historyToken,
        });
        assert(committed.written === 1 && replay.operationSuperseded,
          'a host history capability must be consumed exactly once after the Board commit');
        const supersedePrepared = await __boardHistoryAuthorityForTests.prepare({ sender }, {
          canvasFilePath: canvas, jobs: rows,
          sources: [{ hubId, runId: 'run-1', careerSnapshotId: pin, operationAuthority: s1.receipt }],
        });
        assert(supersedePrepared.success, 'a fresh unconsumed token must be preparable before supersession');
        await claimJobAnalysisOperationAuthority({ canvasFilePath: canvas, hubId, operationId: 'history-s2', semanticBase: base('search', { runId: 'run-2' }) });
        const stale = await __boardHistoryAuthorityForTests.consume({ sender }, {
          canvasFilePath: canvas, jobs: rows, historyToken: supersedePrepared.historyToken,
        });
        const history = await fs.promises.readFile(`${canvas.replace(/\.json$/, '')}.jobs-history.csv`, 'utf8');
        assert(stale.operationSuperseded && history.trim().split(/\r?\n/).length === 2,
          'source supersession before UI/history commit must add no CSV side effect');
        return { senderBound: true, oneShot: true, supersessionBlocked: true };
      } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'operation authority: legacy or receiptless preload-facing saves and recovery discovery are rejected',
    run: async () => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-operation-legacy-'));
      const canvas = path.join(directory, 'canvas.json');
      try {
        await fs.promises.writeFile(canvas, '{}');
        const receiptless = await __saveJobAnalysisSnapshotForTests(snapshot({ canvasFilePath: canvas, authority: null }));
        assert(receiptless.retired, 'a preload-facing save without a host receipt must not write an admissible artifact');

        const paths = getJobAnalysisPaths(canvas, null, 'hub');
        await fs.promises.mkdir(path.dirname(paths.jsonPath), { recursive: true });
        await fs.promises.writeFile(paths.jsonPath, JSON.stringify(snapshot({ canvasFilePath: canvas, authority: null })));
        await fs.promises.writeFile(paths.lastSuccessJsonPath, JSON.stringify(snapshot({ canvasFilePath: canvas, authority: null })));
        assert(await rejectsLoad(() => __loadJobAnalysisSnapshotForTests(canvas, 'hub', 'run-1')),
          'missing/legacy receipt artifacts must be absent from recovery discovery as well as refused on save');
        const preload = await fs.promises.readFile(path.resolve('electron/preload.js'), 'utf8');
        const renderer = await fs.promises.readFile(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8');
        assert(preload.includes('claimJobAnalysisOperation:')
          && preload.includes('revokeJobAnalysisOperation:')
          && preload.includes('clearJobAnalysisOperation:')
          && renderer.includes('operationAuthority: operationAuthorityFor('),
        'the renderer reload seam must forward the host receipt through claim, save, and revoke paths');
        return { receiptlessRejected: true, rendererSeamPresent: true };
      } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
    },
  },
];
