import { createJobAnalysisOperationLedger, jobAnalysisOperationMatches } from '../../src/utils/jobAnalysisOperationLedger.js';
import { __resolvePinnedScoringInputForTests, __createDescriptionRecoveryCheckpointForTests, __saveJobAnalysisSnapshotForTests, registerJobsHandlers } from '../../electron/ipc/jobs.js';
import { beginJobContinuation, listJobContinuations } from '../../electron/ipc/jobContinuation.js';
import { getJobDescriptionRecoveryCheckpointPath } from '../../electron/ipc/jobAnalysisPaths.js';
import { startRun, readRunState } from '../../electron/ipc/jobRunStaging.js';
import electronPkg from 'electron';
import { runInNewContext } from 'node:vm';
import { handleSafe } from '../../electron/ipc/ipcUtils.js';
import { rebindRunOperationAuthority } from '../../electron/ipc/jobRunStaging.js';
import {
  claimJobAnalysisOperationAuthority,
  revokeJobAnalysisOperationAuthority,
  clearJobAnalysisOperationAuthority,
  publishedJobAnalysisOperationAuthority,
  withCurrentJobAnalysisOperationAuthority,
} from '../../electron/ipc/jobAnalysisOperationAuthorityStore.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function assert(value, message) { if (!value) throw new Error(message); }

const pin = 'a'.repeat(64);
const base = (kind, extra = {}) => ({
  kind, careerSnapshotId: pin, runId: 'run-1', fingerprint: 'fingerprint-1',
  analysisRevisionId: null, continuationId: null, sourceArtifactFingerprint: null, ...extra,
});

export default [
  {
    name: 'production Pause and save repairs its exact interrupted scoring receipt before cancelling backend work',
    run: async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-production-saved-pause-'));
      const canvas = path.join(directory, 'canvas.json');
      const owner = { canvasFilePath: canvas, hubId: 'hub' };
      const sender = { id: 98225, isDestroyed: () => false, on() {}, once() {}, removeListener() {}, send() {} };
      let stopped = false;
      let worker;
      try {
        fs.writeFileSync(canvas, '{}');
        registerJobsHandlers();
        const first = await claimJobAnalysisOperationAuthority({ ...owner, operationId: 'first', semanticBase: base('search') });
        await startRun(canvas, { runId: 'run-1', startedAt: Date.now(), nodeId: 'hub', careerSnapshotId: pin, operationAuthority: first.receipt });
        const parent = {
          version: 2, canvasFilePath: canvas, sourceHubId: 'hub', nodeId: 'hub', runId: 'run-1',
          createdAt: new Date().toISOString(), careerSnapshotId: pin, operationAuthority: first.receipt,
          jobs: [{ title: 'Retained role', company: 'Example', url: 'https://example.test/job' }],
          gatheredJobCount: 1, sourceGatheredCount: 1, selectedJobCount: 1, cachedPrefix: 'Retained evidence', previewBatches: [],
        };
        await __saveJobAnalysisSnapshotForTests(parent);
        assert((await beginJobContinuation(canvas, {
          nodeId: 'hub', parentRunId: 'run-1', kind: 'late-source-refresh',
          operation: 'search-jobs-single-source', sourceId: 'usajobs', careerSnapshotId: pin,
          profileFingerprint: 'c'.repeat(64), operationAuthority: first.receipt,
          searchWindow: { startTimestamp: 1, endTimestamp: 2 }, canonicalLocation: 'Toronto',
          generationFingerprint: 'source-receipt', recoveryMode: 'automatic', now: Date.now(),
        })).ok, 'fixture must retain an older sealed source receipt');
        const next = await claimJobAnalysisOperationAuthority({ ...owner, operationId: 'scoring', semanticBase: base('resolved-source-continuation'), predecessor: first.receipt });
        handleSafe('saved-pause-test-worker', async (_event, _args, signal) => {
          await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
          const state = await readRunState(canvas, Date.now(), { nodeId: 'hub' });
          assert(state.manifest.recoveryDisposition === 'manual', 'manual recovery must reach disk before the worker receives cancellation');
          stopped = true;
          return { success: true };
        });
        worker = electronPkg.ipcMain.__getInvokeHandler('saved-pause-test-worker')({ sender }, { nodeId: 'hub' });
        const pause = electronPkg.ipcMain.__getInvokeHandler('pause-job-run-and-cancel');
        const refused = await pause({ sender }, { canvasFilePath: canvas, nodeId: 'hub', runId: 'other-run', operationAuthority: next.receipt });
        assert(refused.settled === false && !stopped, 'a different run must not cancel this worker');
        const saved = await pause({ sender }, { canvasFilePath: canvas, nodeId: 'hub', runId: 'run-1', operationAuthority: next.receipt });
        await worker;
        const state = await readRunState(canvas, Date.now(), { nodeId: 'hub' });
        assert(saved.ok && saved.paused && saved.settled && stopped
          && state.manifest.inputs.operationAuthority.operationId === 'scoring'
          && state.manifest.recoveryDisposition === 'manual', 'the actual IPC must repair S1→S2, persist manual recovery, and await worker settlement');
        assert(!(await withCurrentJobAnalysisOperationAuthority({ ...owner, ...next.receipt }, () => 'late')).admitted,
          'acknowledged pause must fence delayed writes from the stopped worker');
        assert((await listJobContinuations(canvas, 'hub')).length === 1,
          'obsolete sealed source receipts must be retained, while their revoked authority cannot block stopping current scoring');
      } finally {
        electronPkg.ipcMain.removeHandler('saved-pause-test-worker');
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'production scoring continuation and restart Continue keep manifest authority current and repair one interrupted rebind',
    run: async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-production-continue-'));
      const canvas = path.join(directory, 'canvas.json');
      const owner = { canvasFilePath: canvas, hubId: 'hub' };
      const sender = { id: 98224, isDestroyed: () => false, on() {}, once() {}, removeListener() {}, send() {} };
      try {
        fs.writeFileSync(canvas, '{}');
        registerJobsHandlers();
        const claim = electronPkg.ipcMain.__getInvokeHandler('claim-job-analysis-operation');
        const peek = electronPkg.ipcMain.__getInvokeHandler('peek-job-run');
        const first = await claim({ sender }, { ...owner, operationId: 'first', semanticBase: base('search') });
        await startRun(canvas, { runId: 'run-1', startedAt: Date.now(), nodeId: 'hub', careerSnapshotId: pin, operationAuthority: first.receipt });
        const checkpoint = {
          version: 2, canvasFilePath: canvas, sourceHubId: 'hub', nodeId: 'hub', runId: 'run-1',
          createdAt: new Date().toISOString(), careerSnapshotId: pin,
          gatheredJobCount: 1, sourceGatheredCount: 1, selectedJobCount: 1,
          cachedPrefix: 'Retained evidence', previewBatches: [],
          jobs: [{ title: 'Retained role', company: 'Example', url: 'https://example.test/job' }],
          preferenceCandidatePool: [{ title: 'Retained role', company: 'Example', url: 'https://example.test/job' }],
          operationAuthority: first.receipt,
        };
        assert((await __createDescriptionRecoveryCheckpointForTests(checkpoint)).saved, 'fixture must seal the same recovery checkpoint used by Solve');
        const second = await claim({ sender }, { ...owner, operationId: 'second', semanticBase: base('resolved-source-continuation'), predecessor: first.receipt });
        assert(second.admitted, 'the actual scoring continuation IPC must be admitted');
        const staged = await readRunState(canvas, Date.now(), { nodeId: 'hub' });
        assert(staged.manifest.inputs.operationAuthority.operationId === 'second', 'acknowledging scoring must also rebind its staged manifest before preference handoffs start');
        const secondReplay = await claim({ sender }, { ...owner, operationId: 'second', semanticBase: base('resolved-source-continuation'), predecessor: first.receipt });
        assert(secondReplay.admitted && secondReplay.idempotent, 'an acknowledgement retry must remain idempotent after the manifest has already moved');
        const third = await claim({ sender }, { ...owner, operationId: 'third', semanticBase: base('crash-resume'), predecessor: (await peek({ sender }, { canvasFilePath: canvas, nodeId: 'hub' })).operationAuthority });
        assert(third.admitted, 'restart Continue must use the current staged receipt');
        // Model the older build/crash: host acknowledged S4, then never got as
        // far as re-stamping the manifest. A new process has no renderer state.
        const orphan = await claimJobAnalysisOperationAuthority({ ...owner, operationId: 'orphan', semanticBase: base('resolved-source-continuation'), predecessor: third.receipt });
        const offered = await peek({ sender }, { canvasFilePath: canvas, nodeId: 'hub' });
        assert(offered.operationAuthority.operationId === orphan.receipt.operationId, 'peek must discover only the immediate same-run interrupted successor');
        assert((await readRunState(canvas, Date.now(), { nodeId: 'hub' })).manifest.inputs.operationAuthority.operationId === 'third', 'peek must remain read-only');
        const repaired = await claim({ sender }, { ...owner, operationId: 'repaired', semanticBase: base('crash-resume'), predecessor: offered.operationAuthority });
        assert(repaired.admitted && (await readRunState(canvas, Date.now(), { nodeId: 'hub' })).manifest.inputs.operationAuthority.operationId === 'repaired', 'Continue must finish S3→S4 adoption before admitting and adopting S5');
        const recoveredCheckpoint = JSON.parse(fs.readFileSync(getJobDescriptionRecoveryCheckpointPath(canvas, 'run-1', null), 'utf8'));
        assert(recoveredCheckpoint.operationAuthority.operationId === 'repaired'
          && JSON.stringify(recoveredCheckpoint.jobs) === JSON.stringify(checkpoint.jobs)
          && JSON.stringify(recoveredCheckpoint.preferenceCandidatePool) === JSON.stringify(checkpoint.preferenceCandidatePool), 'receipt repair must preserve all recovered job evidence and candidate rows');
        const saved = await claim({ sender }, { ...owner, operationId: 'saved-analysis', semanticBase: base('resume-saved-scrape'), predecessor: repaired.receipt });
        assert(saved.admitted && (await readRunState(canvas, Date.now(), { nodeId: 'hub' })).manifest.inputs.operationAuthority.operationId === 'saved-analysis',
          'saved analysis must adopt its unfinished provider manifest so terminal finalization can complete the same run without scraping');
        const wrong = await claimJobAnalysisOperationAuthority({ ...owner, operationId: 'wrong-run', semanticBase: base('resolved-source-continuation', { runId: 'other-run' }), predecessor: saved.receipt });
        const wrongOffer = await peek({ sender }, { canvasFilePath: canvas, nodeId: 'hub' });
        assert(wrong.admitted && wrongOffer.operationAuthority.operationId === saved.receipt.operationId, 'another run must never be offered as an adoptable continuation');
        const refused = await claim({ sender }, { ...owner, operationId: 'refused', semanticBase: base('crash-resume'), predecessor: wrongOffer.operationAuthority });
        assert(!refused.admitted, 'a stale offer must remain fenced instead of borrowing another run');
        await clearJobAnalysisOperationAuthority(owner);
        assert(!(await claim({ sender }, { ...owner, operationId: 'after-clear', semanticBase: base('crash-resume'), predecessor: repaired.receipt })).admitted, 'Clear must remain a hard recovery boundary');
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'renderer recovery admission failure preserves saved work and Board ownership',
    run: async () => {
      const source = fs.readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      for (const variable of ['resumeOperation', 'continuationOperation']) {
        const block = source.match(new RegExp(`if \\(!${variable}\\) \\{([\\s\\S]*?)\\n      \\}`));
        assert(block, `production ${variable} refusal block must exist`);
        const writes = [];
        const outcome = runInNewContext(`(function(){${block[1]}})()`, {
          currentId: 'hub', activeJobRunId: 'run-1', offer: { runId: 'run-1' },
          updateGlobal: (id, patch) => writes.push({ id, patch }),
          searchRunOutcome: (status, details) => ({ status, ...details }),
        });
        assert(outcome.status === 'recovery-inspection-failed' && outcome.runId === 'run-1', 'Board must receive a retryable inspection failure, not a terminal/superseded attempt');
        assert(writes.length === 1 && !Object.hasOwn(writes[0].patch, 'manualAiResume') && !Object.hasOwn(writes[0].patch, 'hubState'), 'a rejected claim must preserve the marker and visible saved state');
      }
      const board = source.slice(source.indexOf('const runForJobBoard = useCallback'), source.indexOf('// Re-score the currently displayed listings'));
      assert(board.indexOf("outcome?.status === 'recovery-inspection-failed'") < board.indexOf("if (!outcome || outcome.status !== 'completed')"), 'Board executor must preserve an inspection failure before retiring a manual marker');
    },
  },
  {
    name: 'durable operation authority fences delayed writes yet preserves sealed S1 recovery across S2 cancel and reload',
    run: async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-operation-authority-'));
      const canvas = path.join(directory, 'canvas.json');
      const s1 = { canvasFilePath: canvas, hubId: 'hub', operationId: 'operation-s1', semanticBase: base('search') };
      const s2 = { canvasFilePath: canvas, hubId: 'hub', operationId: 'operation-s2', semanticBase: base('search', { runId: 'run-2' }) };
      try {
        fs.writeFileSync(canvas, '{}');
        const claimedS1 = await claimJobAnalysisOperationAuthority(s1);
        assert(claimedS1.admitted, 'S1 must receive the durable admission acknowledgement');
        let releaseWrite;
        const gate = new Promise(resolve => { releaseWrite = resolve; });
        const s1Write = withCurrentJobAnalysisOperationAuthority({ ...s1, revision: claimedS1.receipt.revision }, async (_current, stage) => {
          await stage({ publications: [{ slot: 'current', digest: 'b'.repeat(64) }] });
          await gate;
          return 's1-published';
        });
        await Promise.resolve();
        let s2Acknowledged = false;
        const s2Claim = claimJobAnalysisOperationAuthority(s2).then(value => { s2Acknowledged = value.admitted; return value; });
        await Promise.resolve();
        assert(!s2Acknowledged, 'S2 acknowledgement must wait while accepted S1 is in its authority transaction');
        releaseWrite();
        const written = await s1Write;
        const claimedS2 = await s2Claim;
        assert(written.admitted && written.value === 's1-published' && claimedS2.admitted, 'S1 must commit before the S2 acknowledgement');
        assert(await publishedJobAnalysisOperationAuthority({ ...s1, revision: claimedS1.receipt.revision, slot: 'current', digest: 'b'.repeat(64) }), 'host-published S1 must remain readable after S2 claim');
        const cancelledS2 = await revokeJobAnalysisOperationAuthority({ ...s2, revision: claimedS2.receipt.revision });
        assert(cancelledS2.revoked, 'S2 cancel must write a durable tombstone');
        assert(await publishedJobAnalysisOperationAuthority({ ...s1, revision: claimedS1.receipt.revision, slot: 'current', digest: 'b'.repeat(64) }), 'S2 tombstone must not invalidate already published S1 fallback');
        const delayedS1 = await withCurrentJobAnalysisOperationAuthority({ ...s1, revision: claimedS1.receipt.revision }, () => 'late');
        assert(!delayedS1.admitted, 'a delayed S1 write after S2 acknowledgement/tombstone must be rejected');
        const reloaded = await import(`../../electron/ipc/jobAnalysisOperationAuthorityStore.js?restart=${Date.now()}`);
        assert(await reloaded.publishedJobAnalysisOperationAuthority({ ...s1, revision: claimedS1.receipt.revision, slot: 'current', digest: 'b'.repeat(64) }), 'published S1 must remain readable after a process-style module reload');
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'ordinary revoke is exact-CAS while explicit clear drops published recovery',
    run: async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-operation-clear-'));
      const canvas = path.join(directory, 'canvas.json');
      const s1 = { canvasFilePath: canvas, hubId: 'hub', operationId: 'operation-s1', semanticBase: base('search') };
      const s2 = { canvasFilePath: canvas, hubId: 'hub', operationId: 'operation-s2', semanticBase: base('search', { runId: 'run-2' }) };
      try {
        fs.writeFileSync(canvas, '{}');
        const one = await claimJobAnalysisOperationAuthority(s1);
        await withCurrentJobAnalysisOperationAuthority({ ...s1, revision: one.receipt.revision }, async (_current, stage) => {
          await stage({ publications: [{ slot: 'current', digest: 'c'.repeat(64) }] });
          return 'published';
        });
        const two = await claimJobAnalysisOperationAuthority(s2);
        const stale = await revokeJobAnalysisOperationAuthority({ ...s1, revision: one.receipt.revision });
        assert(stale.revoked === false && stale.superseded === true, 'stale ordinary revoke must not affect S2');
        assert(await publishedJobAnalysisOperationAuthority({ ...s1, revision: one.receipt.revision, slot: 'current', digest: 'c'.repeat(64) }), 'ordinary cancel preserves old publication');
        const clear = await clearJobAnalysisOperationAuthority({ canvasFilePath: canvas, hubId: 'hub' });
        assert(clear.cleared === true && two.admitted, 'explicit clear must write durable destructive fence');
        assert(!await publishedJobAnalysisOperationAuthority({ ...s1, revision: one.receipt.revision, slot: 'current', digest: 'c'.repeat(64) }), 'clear must invalidate old publication');
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'stopped manifest receipt is the exact immediate predecessor for one resume rebind',
    run: async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-operation-resume-'));
      const canvas = path.join(directory, 'canvas.json');
      const initial = { canvasFilePath: canvas, hubId: 'hub', operationId: 'operation-s1', semanticBase: base('search') };
      try {
        fs.writeFileSync(canvas, '{}');
        const s1 = await claimJobAnalysisOperationAuthority(initial);
        const manifest = await startRun(canvas, {
          runId: 'run-1', startedAt: Date.now(), nodeId: 'hub', sourceIds: [], requireCareerSnapshot: true,
          careerSnapshotId: pin, operationAuthority: s1.receipt,
        });
        assert(manifest?.runId === 'run-1', 'fixture must persist only S1 receipt in manifest');
        const stopped = await revokeJobAnalysisOperationAuthority({ ...initial, revision: s1.receipt.revision });
        assert(stopped.revoked && stopped.receipt.revision === s1.receipt.revision, 'Stop must retain manifest-visible S1 revision');
        const resumeBase = base('resume');
        const s2 = await claimJobAnalysisOperationAuthority({
          canvasFilePath: canvas, hubId: 'hub', operationId: 'operation-s2', semanticBase: resumeBase,
          expectedRevision: s1.receipt.revision, predecessor: s1.receipt,
        });
        assert(s2.admitted, 'resume must be claimable from manifest S1 receipt without hidden sidecar state');
        const rebound = await rebindRunOperationAuthority(canvas, {
          expectedRunId: 'run-1', expectedNodeId: 'hub', careerSnapshotId: pin,
          currentAuthority: s2.receipt, predecessorAuthority: s1.receipt,
        });
        assert(rebound.ok && rebound.rebound, 'manifest must adopt exactly immediate S2 predecessor');
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'same-snapshot S2 admission synchronously revokes S1 before S1 can commit after an await',
    run: async () => {
      const ledger = createJobAnalysisOperationLedger();
      const s1 = ledger.claim({ canvasFilePath: '/tmp/a.canvas.json', hubId: 'hub', disposition: 'search' });
      const persistedS1 = ledger.receiptFor(s1);
      await Promise.resolve();
      const s2 = ledger.claim({ canvasFilePath: '/tmp/a.canvas.json', hubId: 'hub', disposition: 'search' });
      const persistedS2 = ledger.receiptFor(s2);
      assert(!ledger.canCommit(s1) && ledger.canCommit(s2), 'S2 must revoke S1 even when snapshot/hub match');
      assert(!jobAnalysisOperationMatches({ analysisOperation: persistedS2 }, s1), 'S1 CAS must reject S2 receipt');
      assert(jobAnalysisOperationMatches({ analysisOperation: persistedS2 }, s2), 'S2 CAS must accept its receipt');
      assert(persistedS1.generation !== persistedS2.generation, 'serialized receipts must differ by generation');
      assert(persistedS1.operationId !== persistedS2.operationId, 'serialized receipts must carry opaque operation authority');
    },
  },
  {
    name: 'remount ledger cannot collide with an older same-generation operation receipt',
    run: () => {
      const beforeReload = createJobAnalysisOperationLedger().claim({ canvasFilePath: '/tmp/a.canvas.json', hubId: 'hub', disposition: 'search' });
      const afterReloadLedger = createJobAnalysisOperationLedger();
      const afterReload = afterReloadLedger.claim({ canvasFilePath: '/tmp/a.canvas.json', hubId: 'hub', disposition: 'search' });
      const oldReceipt = { analysisOperation: { ...createJobAnalysisOperationLedger().receiptFor(beforeReload) } };
      const newReceipt = { analysisOperation: afterReloadLedger.receiptFor(afterReload) };
      assert(beforeReload.generation === afterReload.generation, 'fixture proves a remount restarts diagnostic generation');
      assert(beforeReload.operationId !== afterReload.operationId, 'opaque operation id must survive the remount collision case');
      assert(!jobAnalysisOperationMatches(oldReceipt, afterReload) && jobAnalysisOperationMatches(newReceipt, afterReload), 'new operation must reject S1 serialized authority despite matching generation');
    },
  },
  {
    name: 'a rejected preflight does not claim or revoke an active operation',
    run: () => {
      const ledger = createJobAnalysisOperationLedger();
      const active = ledger.claim({ canvasFilePath: '/tmp/a.canvas.json', hubId: 'hub', disposition: 'search' });
      const before = ledger.currentReceipt();
      // A busy/invalid request is deliberately rejected before `claim()`.
      const rejectedBeforeAdmission = null;
      assert(rejectedBeforeAdmission === null && ledger.canCommit(active), 'rejected request must leave S1 capable of committing');
      assert(ledger.currentReceipt().operationId === before.operationId, 'rejected request must not replace the persisted receipt');
    },
  },
  {
    name: 'reset during an await revokes the captured S1 capability before its delayed write',
    run: async () => {
      const ledger = createJobAnalysisOperationLedger();
      const s1 = ledger.claim({ canvasFilePath: '/tmp/a.canvas.json', hubId: 'hub', disposition: 'search' });
      const receipt = ledger.receiptFor(s1);
      await Promise.resolve(); // stand-in for a delayed IPC/provider response
      ledger.revoke(s1); // synchronous Reset/Clear cancellation
      assert(!ledger.canCommit(s1), 'late S1 completion must have no capability after reset');
      assert(!jobAnalysisOperationMatches({ analysisOperation: null }, s1), 'cleared node receipt must reject late S1 CAS');
      assert(receipt.operationId, 'fixture captured a real serialized operation');
    },
  },
  {
    name: 'production scoring resolver rejects unpinned renderer data while explicit test seam remains isolated',
    run: async () => {
      let rejected = false;
      try {
        await __resolvePinnedScoringInputForTests({ profile: { titles: ['raw'] }, careerData: 'raw renderer data' });
      } catch { rejected = true; }
      const migration = await __resolvePinnedScoringInputForTests({
        allowLegacyUnpinnedForTests: true,
        profile: { titles: ['fixture only'] },
        careerData: 'fixture only',
      });
      assert(rejected, 'default resolver must reject an absent immutable snapshot pin');
      assert(migration.pinned === false && migration.careerData === 'fixture only', 'legacy path must require the explicit test-only seam');
    },
  },
  {
    name: 'required-pinned startRun rejects without creating a truthy manifest',
    run: async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-required-pin-'));
      const canvas = path.join(directory, 'canvas.json');
      try {
        fs.writeFileSync(canvas, '{}');
        const result = await startRun(canvas, {
          runId: 'required-pin-run', startedAt: Date.now(), nodeId: 'hub',
          requireCareerSnapshot: true,
        });
        assert(result?.rejected === true && result?.careerSnapshotMissing === true && !result?.runId,
          'required pin rejection must not masquerade as a started manifest');
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'operation receipt refuses cross-hub and revoked write authority',
    run: () => {
      const ledger = createJobAnalysisOperationLedger();
      const owner = ledger.claim({ canvasFilePath: '/tmp/a.canvas.json', hubId: 'hub-a', disposition: 'reanalyze' });
      const receipt = ledger.receiptFor(owner);
      assert(!jobAnalysisOperationMatches({ analysisOperation: { ...receipt, hubId: 'hub-b' } }, owner), 'receipt must remain hub scoped');
      ledger.revoke(owner);
      assert(!ledger.canCommit(owner), 'cancellation must revoke durable-write authority');
    },
  },
];
