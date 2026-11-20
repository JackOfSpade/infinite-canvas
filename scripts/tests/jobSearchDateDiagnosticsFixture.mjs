import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  jobSearchDateDiagnosticPatch, jobSearchDateRetentionReason,
  sanitizeJobSearchDateDiagnostics,
} from '../../src/utils/jobSearchDateDiagnostics.js';
import { normalizeCompletionTimestamp } from '../../src/utils/completionTimestamp.js';
import {
  canClaimJobRunCollectionCompletion, careerSnapshotBindingMatches, normalizedJobCareerSnapshotId,
} from '../../src/utils/jobCareerSnapshotBinding.js';
import { redactNodeForIssueReport } from '../../src/utils/issueReportRedaction.js';
import { cloneNode } from '../../src/utils/nodeFactory.js';
import { sanitizeNodesForSave } from '../../src/utils/serializationUtils.js';
import { applySourceSkipToPendingCoverage, buildSourceCoverageCommitPatch, sourcesWithoutDateProgress } from '../../src/utils/jobSearchSourceCoverage.js';

const SNAPSHOT = 'a'.repeat(64);
const OLD = Date.UTC(2026, 9, 6, 5, 30);
const START = Date.UTC(2026, 9, 27, 10);
const END = START + 60_000;

// Exercise the real renderer callbacks, with only their I/O and React hook
// shell substituted. This catches a diagnostic accidentally changing a date
// write or bypassing the existing owner/finalization guards.
function renderer(initial = {}) {
  const harness = {
    node: { id: 'date-hub', type: 'jobhub', data: {
      hubState: 'searching', careerSnapshotId: SNAPSHOT, jobRunId: 'date-run',
      lastCompletedRunAt: OLD, lastSearchCoverageStartedAt: OLD - 60_000, ...initial,
    } },
    result: { ok: true, cleared: true },
    calls: 0,
    toasts: [],
  };
  const context = {
    useCallback: fn => fn, id: harness.node.id, canvasFilePath: '/fixture/canvas.json',
    getNode: () => harness.node,
    updateGlobal: (_id, patch) => {
      const value = typeof patch === 'function' ? patch(harness.node) : patch;
      if (value) harness.node.data = { ...harness.node.data, ...value };
    },
    normalizedJobCareerSnapshotId, careerSnapshotBindingMatches, canClaimJobRunCollectionCompletion,
    normalizeCompletionTimestamp, jobSearchDateDiagnosticPatch, jobSearchDateRetentionReason,
    canCommitAnalysisOperation: () => true, operationAuthorityFor: () => null,
    terminalResultDisposition: value => value,
    setResumeOffer: () => {}, setActiveResumeCheckpoint: () => {},
    EventLogger: { error() {} },
    addToast: toast => { harness.toasts.push(toast); },
    buildSourceCoverageCommitPatch, sourcesWithoutDateProgress,
    applySourceSkipToPendingCoverage, sourcesSkippedDuringSearchRef: { current: { runId: null, sourceIds: new Set() } },
    ALL_JOB_SOURCE_IDS: ['indeed', 'linkedin', 'google'],
    JOB_SOURCE_BY_ID: { linkedin: { name: 'LinkedIn' }, indeed: { name: 'Indeed' }, google: { name: 'Google' } },
    window: { electronAPI: { completeJobRun: async () => { harness.calls++; return harness.result; } } },
  };
  const source = fs.readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('const completeJobRun = useCallback');
  const end = source.indexOf('const retryTerminalFinalization = useCallback', start);
  assert(start >= 0 && end > start);
  const callbacks = new Function(...Object.keys(context), `${source.slice(start, end)}
    return { completeJobRun, recordCollectionCompletion };`)(...Object.values(context));
  harness.collect = extra => callbacks.recordCollectionCompletion({
    runId: 'date-run', collectionStartedAt: START, collectionCompletedAt: END, ...extra,
  }, () => false, SNAPSHOT);
  harness.finish = (canCommit = () => true) => callbacks.completeJobRun(
    'date-run', 'completed', 'populated', '/fixture/canvas.json', 2, null,
    () => false, SNAPSHOT, canCommit,
  );
  return harness;
}

export default [
  {
    name: 'Job date diagnostics: full collection records staging, failed finalization and successful retry without changing date policy',
    async run() {
      const h = renderer();
      h.collect();
      assert.equal(h.node.data.lastCompletedRunAt, OLD);
      assert.equal(h.node.data.jobSearchDateDiagnostics.at(-1).reason, 'full-collection-staged');
      h.result = { ok: false, cleared: false };
      await h.finish();
      assert.equal(h.node.data.lastCompletedRunAt, OLD);
      assert.equal(h.node.data.jobSearchDateDiagnostics.at(-1).reason, 'finalization-failed');
      h.result = { ok: true, cleared: true };
      await h.finish();
      assert.equal(h.node.data.lastCompletedRunAt, END);
      assert.equal(h.node.data.lastSearchCoverageStartedAt, START);
      const entry = h.node.data.jobSearchDateDiagnostics.at(-1);
      assert.equal(entry.reason, 'completion-committed');
      assert.equal(entry.previousCompletedAt, OLD);
      assert.equal(entry.nextCompletedAt, END);
      assert.equal(entry.collectionDisposition, 'full');
      assert.equal(entry.collectionCompletedAt, END);
    },
  },
  {
    name: 'Job date diagnostics: a platform whose date did not move raises the dismiss-required popup once the scan finishes',
    async run() {
      const blocked = renderer();
      blocked.collect({
        hasUnfinishedSources: true, completedSourceIds: ['indeed'],
        participatingSourceIds: ['indeed', 'linkedin'],
        sourceQueryProgress: { linkedin: { finishedQueries: ['a'] } }, sourceQueryLocationKey: 'Canada',
      });
      assert.equal(blocked.toasts.length, 0, 'nothing is shown while the scan is still running');
      await blocked.finish();
      assert.equal(blocked.toasts.length, 1);
      const [toast] = blocked.toasts;
      assert.equal(toast.title, 'Scan date did not move: LinkedIn');
      assert.equal(toast.type, 'error');
      assert.equal(toast.duration, 0, 'it stays until dismissed');
      assert.equal(blocked.node.data.sourceCoverage.indeed.coverageStartedAt, START, 'the finished platform still moves');
      assert.deepEqual(blocked.node.data.sourceQueryProgress.linkedin.finishedQueries, ['a'],
        'and the blocked platform keeps the queries it finished');

      const clean = renderer();
      clean.collect({ completedSourceIds: ['indeed', 'linkedin'], participatingSourceIds: ['indeed', 'linkedin'] });
      await clean.finish();
      assert.equal(clean.toasts.length, 0, 'a scan where every platform moved shows nothing');
    },
  },
  {
    name: 'Job date diagnostics: partial finishes and a saved legacy Clear Scrape entry retain dates and diagnostic evidence across JSON reload',
    async run() {
      for (const input of [{ collectionDisposition: 'user-finished-partial' }, { hasUnfinishedSources: true }]) {
        const h = renderer();
        h.collect(input);
        await h.finish();
        assert.equal(h.node.data.lastCompletedRunAt, OLD);
        assert.equal(h.node.data.jobSearchDateDiagnostics.at(-1).reason, 'partial-collection');
        const before = h.node.data;
        // Clear Scrape is gone, but canvases saved by it keep the reason
        // 'clear-scrape' and its emptied results; both must still reload.
        h.node.data = { ...before, hubState: 'empty', scoredJobs: null, jobRunId: null, partialCollectionRunId: null,
          ...jobSearchDateDiagnosticPatch(before, { event: 'clear', reason: 'clear-scrape', runId: 'date-run' }) };
        const [reloaded] = JSON.parse(JSON.stringify(sanitizeNodesForSave([h.node])));
        assert.equal(reloaded.data.lastCompletedRunAt, OLD);
        assert.equal(reloaded.data.jobRunId, null);
        assert.equal(reloaded.data.partialCollectionRunId, null);
        assert.equal(reloaded.data.jobSearchDateDiagnostics.at(-1).reason, 'clear-scrape');
        assert.equal(reloaded.data.jobSearchDateDiagnostics.at(-1).collectionDisposition,
          input.collectionDisposition || 'unfinished-sources');
        assert.equal(cloneNode(reloaded).data.jobSearchDateDiagnostics, undefined);
      }
    },
  },
  {
    name: 'Job date diagnostics: missing and mismatched completion evidence is explicit and stale owners cannot log or advance dates',
    async run() {
      for (const [pending, reason] of [
        [null, 'missing-pending-completion'],
        [{ runId: 'other-run' }, 'pending-run-mismatch'],
        [{ runId: 'date-run', careerSnapshotId: 'b'.repeat(64), collectionCompletedAt: END }, 'pending-career-mismatch'],
        [{ runId: 'date-run', careerSnapshotId: SNAPSHOT, collectionCompletedAt: 'bad' }, 'invalid-pending-completion'],
      ]) {
        const h = renderer({ pendingCollectionCompletion: pending });
        await h.finish();
        assert.equal(h.node.data.lastCompletedRunAt, OLD);
        assert.equal(h.node.data.jobSearchDateDiagnostics.at(-1).reason, reason);
        assert.equal(h.node.data.jobSearchDateDiagnostics.at(-1).collectionDisposition, 'unknown');
      }
      const stale = renderer();
      stale.collect();
      const before = JSON.stringify(stale.node.data);
      await stale.finish(() => false);
      assert.equal(JSON.stringify(stale.node.data), before);
      assert.equal(stale.calls, 0);
    },
  },
  {
    name: 'Job date diagnostics: history is bounded and redaction discards private text and malformed timestamps',
    run() {
      let data = { lastCompletedRunAt: OLD };
      for (let index = 0; index < 20; index++) {
        data = { ...data, ...jobSearchDateDiagnosticPatch(data, {
          event: 'clear', reason: 'clear-all', recordedAt: OLD + index,
        }) };
      }
      assert.equal(data.jobSearchDateDiagnostics.length, 8);
      const hostile = { ...data.jobSearchDateDiagnostics[0], runId: 'https://private.example/',
        previousCompletedAt: 'secret text', nextCompletedAt: Infinity, secret: 'private prose' };
      const node = redactNodeForIssueReport({ type: 'jobhub', data: { jobSearchDateDiagnostics: [hostile] } });
      assert.equal(node.data.jobSearchDateDiagnostics[0].runId, null);
      assert.equal(node.data.jobSearchDateDiagnostics[0].previousCompletedAt, null);
      assert.equal(node.data.jobSearchDateDiagnostics[0].nextCompletedAt, null);
      assert(!JSON.stringify(node).includes('private'));
      assert.deepEqual(sanitizeJobSearchDateDiagnostics([{ ...hostile, reason: 'private prose' }]), []);
    },
  },
];
