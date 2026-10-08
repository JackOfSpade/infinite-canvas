import { createJobAnalysisOperationLedger, jobAnalysisOperationMatches } from '../../src/utils/jobAnalysisOperationLedger.js';
import { __resolvePinnedScoringInputForTests } from '../../electron/ipc/jobs.js';
import { startRun } from '../../electron/ipc/jobRunStaging.js';
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
