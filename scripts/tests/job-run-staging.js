import { assert, appendJobsHistory, buildJobRunCompletionReceipt, completeRunWithReceipt, fs, lastRunReceiptPathForCanvas, os, path, readLastRunReceipt, readStagedJobs, sanitizeLastRunReceipt, startRun, writeLastRunReceipt } from '../test-dependencies.js';

export default [
  {
    name: 'job run staging: a failed fresh start preserves the prior recoverable JSONL',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-job-staging-rollback-'));
      const canvasPath = path.join(root, 'workspace.json');
      const stagingPath = path.join(root, 'workspace.jobs-staging.jsonl');
      const manifestPath = path.join(root, 'workspace.jobs-run.json');
      const priorRow = { sourceId: 'indeed', query: 'platform engineer', page: 1, job: { title: 'Recover me' } };
      try {
        await fs.promises.writeFile(stagingPath, `${JSON.stringify(priorRow)}\n`, { encoding: 'utf8', mode: 0o600 });
        // A directory at the manifest path makes its final atomic rename fail
        // after startRun has prepared its fresh staging file.
        await fs.promises.mkdir(manifestPath);
        const result = await startRun(canvasPath, { runId: 'replacement', startedAt: 1, sourceIds: ['indeed'] });
        const recovered = await readStagedJobs(canvasPath);
        assert(result === null, `a failed manifest replacement must fail the start, got ${JSON.stringify(result)}`);
        assert(recovered.length === 1 && recovered[0].job?.title === 'Recover me',
          `a failed fresh start must restore prior staged jobs, got ${JSON.stringify(recovered)}`);
        return { restoredRows: recovered.length };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'job run staging: saved-canvas start failure fails closed before source collection',
    run: async () => {
      const jobsSource = await fs.promises.readFile(path.resolve('electron/ipc/jobs.js'), 'utf8');
      assert(
        jobsSource.includes('if (canvasFilePath && !startedRun)')
          && jobsSource.includes('No job sources were queried and existing results were left unchanged.')
          && jobsSource.includes("retirePipeline('staging-start-failed', error)"),
        'search-jobs must reject a failed saved-canvas staging start before source collection can proceed',
      );
      return { failClosed: true };
    },
  },
  {
    name: 'job run staging: durable terminal receipt survives cleanup and redacts payloads',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-job-run-receipt-'));
      const canvasPath = path.join(root, 'workspace.json');
      try {
        const run = await startRun(canvasPath, { runId: 'receipt-run', startedAt: 100, nodeId: 'hub-1', sourceIds: ['remoteok'] });
        assert(run?.runId === 'receipt-run', 'receipt fixture must start a staged run');
        const completed = await completeRunWithReceipt(canvasPath, {
          runId: 'receipt-run', nodeId: 'hub-1', startedAt: 100, completedAt: 200,
          terminal: { status: 'completed', outcome: 'zero' },
          // Sponsored ads are excluded before title admission. The role funnel
          // therefore starts from the 39 real feed rows; its separate 3-ad
          // count must never be laundered into relevanceDropped.
          funnel: { raw: 39, relevanceDropped: 39, deduped: 0, ageDropped: 0, roleDropped: 0, historyDropped: 0, descriptionEvidenceDropped: 0, kept: 0 },
          sources: {
            remoteok: {
              count: 0, providerGathered: 39, relevanceDropped: 39, sponsoredDropped: 3,
              stopReason: 'feed-exhausted',
              warning: { code: 'safe-code', severity: 'info', evidence: 'MUST NOT PERSIST' },
              jobs: [{ title: 'MUST NOT PERSIST', url: 'https://private.example' }],
            },
          },
          jobs: [{ title: 'MUST NOT PERSIST' }], queries: ['MUST NOT PERSIST'], profile: { email: 'MUST NOT PERSIST' },
          stagingStarted: true,
        });
        const receipt = await readLastRunReceipt(canvasPath);
        const serialized = await fs.promises.readFile(lastRunReceiptPathForCanvas(canvasPath), 'utf8');
        const remaining = await fs.promises.readdir(root);
        assert(completed.ok && completed.cleared && receipt?.cleanup?.attempted && receipt?.cleanup?.cleared,
          `completion must truthfully record cleanup, got ${JSON.stringify(completed)}`);
        assert(receipt?.terminal?.outcome === 'zero' && receipt?.funnel?.raw === 39
          && receipt?.sources?.remoteok?.relevanceDropped === 39
          && receipt?.sources?.remoteok?.sponsoredDropped === 3,
          `receipt must retain safe RemoteOK aggregate facts, got ${JSON.stringify(receipt)}`);
        assert(!serialized.includes('MUST NOT PERSIST') && !('jobs' in receipt) && !('queries' in receipt) && !('profile' in receipt),
          `receipt must redact payload fields, got ${serialized}`);
        assert(!remaining.includes('workspace.jobs-run.json') && !remaining.includes('workspace.jobs-staging.jsonl'),
          `terminal cleanup must remove run sidecars, got ${remaining.join(', ')}`);
        return { outcome: receipt.terminal.outcome, cleared: receipt.cleanup.cleared };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'job run staging: terminal receipt completion is token-scoped',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-job-run-receipt-token-'));
      const canvasPath = path.join(root, 'workspace.json');
      try {
        await startRun(canvasPath, { runId: 'new-run', startedAt: 100, nodeId: 'new-hub', sourceIds: ['remoteok'] });
        const stale = await completeRunWithReceipt(canvasPath, {
          runId: 'old-run', nodeId: 'old-hub', terminal: { status: 'completed', outcome: 'zero' },
        });
        const state = await readStagedJobs(canvasPath);
        const entries = await fs.promises.readdir(root);
        assert(stale.tokenMismatch && !stale.ok && !entries.includes('workspace.jobs-last-run.json'),
          `a stale completion must not write a receipt, got ${JSON.stringify(stale)} / ${entries.join(', ')}`);
        assert(entries.includes('workspace.jobs-run.json') && Array.isArray(state),
          'a stale completion must preserve the newer run sidecars');
        const direct = await writeLastRunReceipt(canvasPath, { runId: 'receipt-a', terminal: { status: 'completed', outcome: 'zero' } });
        const rejected = await writeLastRunReceipt(canvasPath, { runId: 'receipt-b', terminal: { status: 'completed', outcome: 'zero' } }, { expectedRunId: 'different-token' });
        assert(direct.written && rejected.tokenMismatch && rejected.receipt?.runId === 'receipt-a',
          `direct receipt updates must also reject a wrong expected token, got ${JSON.stringify({ direct, rejected })}`);
        return { staleRejected: true, directTokenGuarded: true };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'job run staging: renderer terminal provenance distinguishes incomplete failure from a clean zero',
    run: () => {
      const built = buildJobRunCompletionReceipt('failed-batch-run', 200, {
        status: 'failed',
        outcome: 'incomplete',
      });
      const sanitized = sanitizeLastRunReceipt({
        ...built,
        terminal: { status: 'completed', outcome: 'collection-only' },
      });
      assert(built.terminal.status === 'failed' && built.terminal.outcome === 'incomplete',
        `renderer terminal provenance must override the search-only default, got ${JSON.stringify(built.terminal)}`);
      assert(!Object.hasOwn(built.terminal, 'scoreReadyCount'),
        'an unknown terminal result count must stay absent rather than being coerced from null to zero');
      assert(sanitized.terminal.status === 'completed' && sanitized.terminal.outcome === 'collection-only',
        `collection-only completion must remain distinct from a genuine zero, got ${JSON.stringify(sanitized.terminal)}`);
      return { failed: built.terminal.outcome, intentionalSkip: sanitized.terminal.outcome };
    },
  },
  {
    name: 'job run staging: every renderer terminal path awaits durable finalization before publishing done',
    run: async () => {
      const source = await fs.promises.readFile(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8');
      const awaited = source.match(/await completeJobRun\(/g) || [];
      assert(awaited.length === 5,
        `expected the five terminal job-run paths to await finalization, found ${awaited.length}`);
      assert(!source.includes('void completeJobRun('),
        'terminal job-run finalization must not be fire-and-forget after a hub has published done');

      const contracts = [
        ['scored settlement', 'const completion = completeRun && jobRunId', 'updateGlobal(id, {'],
        ['lost legacy batch', "? await completeJobRun(terminalRunId, 'failed', 'incomplete')", 'updateGlobal(id, live ==='],
        ['post-search zero', "? await completeJobRun(jobRunId, 'completed', 'zero', cfp)", 'updateGlobal(currentId, {'],
        ['collection-only', "? await completeJobRun(searchResult.runId, 'completed', 'collection-only')", 'updateGlobal(currentId, {'],
        ['paused zero', "? await completeJobRun(activeJobRunId, 'completed', 'zero')", 'updateGlobal(id, {'],
      ];
      for (const [label, awaitMarker, doneMarker] of contracts) {
        const begin = source.indexOf(awaitMarker);
        const done = begin >= 0 ? source.indexOf(doneMarker, begin) : -1;
        assert(begin >= 0 && done > begin,
          `${label} must await the receipt/cleanup transaction before it publishes its terminal hub state`);
        const section = source.slice(begin, done);
        assert(section.includes('if (cancelled()) return'),
          `${label} must discard a stale terminal update when Reset/unmount lands during finalization`);
      }
      assert(source.includes('function terminalFinalizationError(')
        && source.includes('Recovery data was kept; see Job Recovery Diagnostics'),
      'a failed durable finalization must be explicitly surfaced while its sidecars remain recoverable');
      return { awaitedTerminalPaths: awaited.length };
    },
  },
  {
    name: 'jobs history: persisted sidecar is private and failed atomic replacement leaves no temporary files',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-jobs-history-private-'));
      const canvasPath = path.join(root, 'workspace.json');
      try {
        const result = await appendJobsHistory(canvasPath, [{
          source: 'indeed', company: 'Acme', title: 'Platform Engineer', location: 'Toronto, ON',
          url: 'https://ca.indeed.com/rc/clk?jk=private-history',
        }]);
        const historyPath = path.join(root, 'workspace.jobs-history.csv');
        const mode = (await fs.promises.stat(historyPath)).mode & 0o777;
        const entries = await fs.promises.readdir(root);
        assert(result.written === 1, `history write should persist the listing, got ${JSON.stringify(result)}`);
        assert((mode & 0o077) === 0, `history sidecar must not be group/world-readable, mode=${mode.toString(8)}`);
        assert(!entries.some(name => name.includes('.jobs-history.csv.') && name.endsWith('.tmp')),
          `history write must clean temporary sidecars, got ${entries.join(', ')}`);
        await fs.promises.rm(historyPath);
        // Make the final rename fail only after atomicWriteHistory has created
        // its private exclusive temporary file. appendJobsHistory is best
        // effort, so callers receive a diagnostic result rather than an error.
        await fs.promises.mkdir(historyPath);
        const failed = await appendJobsHistory(canvasPath, [{
          source: 'indeed', company: 'Acme', title: 'Second listing', location: 'Toronto, ON',
          url: 'https://ca.indeed.com/rc/clk?jk=failed-history',
        }]);
        const afterFailure = await fs.promises.readdir(root);
        assert(typeof failed.error === 'string' && failed.written === 0,
          `a failed destination rename must be reported without throwing, got ${JSON.stringify(failed)}`);
        assert(!afterFailure.some(name => name.includes('.jobs-history.csv.') && name.endsWith('.tmp')),
          `failed history promotion must clean its exclusive temp, got ${afterFailure.join(', ')}`);
        return { mode: mode.toString(8), failedRenameCleaned: true };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
];
