import assert from 'node:assert';
import {
  awaitedSourceTerminalStatus,
  canRetryBoardRecoveryAfterError,
  terminalJobSearchOutcome,
} from '../../src/utils/jobBoardPausedSourceContinuation.js';
import { SAVED_HANDOFF_READY_MESSAGE } from '../../src/nodes/jobboard/boardRecoveryNotice.js';
import { boardSelectorRuntimeSummary } from '../../electron/ipc/bugReport/jobsSnapshot.js';

// The exact source generation the paused Board recorded in
// `boardScanResume.awaitingSourceResolution.jobRunId`.
const AWAITED_RUN = 'search-run-7f3a';
const OTHER_RUN = 'search-run-9c1b';

function scoredJob(title) {
  return {
    title,
    company: 'Example',
    url: `https://jobs.example.test/${encodeURIComponent(title.replace(/\s+/g, '-').toLowerCase())}`,
    matchScore: 88,
  };
}

// A realistic terminal Job Search receipt: `terminalJobSearchOutcome` requires
// a `done` hub with a run id, a disposition and no error/finalization marker.
function doneSource(id, overrides = {}) {
  return {
    id,
    type: 'jobhub',
    data: {
      hubState: 'done',
      jobRunId: AWAITED_RUN,
      resultDisposition: 'scored',
      scoredJobs: [scoredJob('Senior Data Analyst')],
      ...overrides,
    },
  };
}

function pendingSource(id) {
  return {
    id,
    type: 'jobhub',
    data: { hubState: 'sources-ready', jobRunId: AWAITED_RUN, scrapeWarnings: [] },
  };
}

function lookup(...sources) {
  const byId = new Map(sources.map(source => [source.id, source]));
  return id => byId.get(id) || null;
}

const searchedPlan = (overrides = {}) => ({ version: 1, phase: 'searches', ...overrides });
const awaiting = (sourceId, jobRunId = AWAITED_RUN) => ({ sourceId, jobRunId });

export default [
  {
    name: 'awaitedSourceTerminalStatus classifies none, pending, run-changed and terminal-match',
    run() {
      // Sanity: the fixture really is a terminal scored receipt, and a paused
      // hub is really not one — otherwise the statuses below prove nothing.
      const done = doneSource('linkedin');
      const terminal = terminalJobSearchOutcome(done);
      assert.strictEqual(terminal.runId, AWAITED_RUN);
      assert.strictEqual(terminal.resultDisposition, 'scored');
      assert.strictEqual(terminalJobSearchOutcome(pendingSource('linkedin')), null);

      assert.strictEqual(awaitedSourceTerminalStatus(null, lookup()), 'none');
      assert.strictEqual(awaitedSourceTerminalStatus({}, lookup()), 'none');
      assert.strictEqual(
        awaitedSourceTerminalStatus(searchedPlan({ awaitingSourceResolutions: [] }), lookup()),
        'none',
      );
      assert.strictEqual(
        awaitedSourceTerminalStatus(
          searchedPlan({ awaitingSourceResolution: awaiting('linkedin') }),
          lookup(pendingSource('linkedin')),
        ),
        'pending',
      );
      assert.strictEqual(
        awaitedSourceTerminalStatus(
          searchedPlan({ awaitingSourceResolution: awaiting('linkedin') }),
          lookup(doneSource('linkedin', { jobRunId: OTHER_RUN })),
        ),
        'run-changed',
      );
      assert.strictEqual(
        awaitedSourceTerminalStatus(
          searchedPlan({ awaitingSourceResolution: awaiting('linkedin') }),
          lookup(done),
        ),
        'terminal-match',
      );
      // Multi-source: every awaited source must prove its own recorded run.
      assert.strictEqual(
        awaitedSourceTerminalStatus(
          searchedPlan({
            awaitingSourceResolution: awaiting('linkedin'),
            awaitingSourceResolutions: [awaiting('linkedin'), awaiting('indeed')],
          }),
          lookup(doneSource('linkedin'), doneSource('indeed')),
        ),
        'terminal-match',
      );
      assert.strictEqual(
        awaitedSourceTerminalStatus(
          searchedPlan({ awaitingSourceResolutions: [awaiting('linkedin'), awaiting('indeed')] }),
          lookup(doneSource('linkedin'), pendingSource('indeed')),
        ),
        'pending',
      );
    },
  },
  {
    name: 'canRetryBoardRecoveryAfterError admits the existing Search retry and the awaited-source retry only',
    run() {
      assert.strictEqual(
        canRetryBoardRecoveryAfterError({
          plan: searchedPlan({ awaitingSourceResolution: awaiting('linkedin') }),
          recoveryError: '',
          searchRecoveryError: null,
          recoveryKey: 'recovery-key-1',
          awaitedStatus: 'terminal-match',
        }),
        true,
      );
      // Existing rule: a Search error raised under another recovery key.
      assert.strictEqual(
        canRetryBoardRecoveryAfterError({
          plan: searchedPlan(),
          recoveryError: 'Job Search failed to gather jobs.',
          searchRecoveryError: { key: 'recovery-key-0', message: 'Job Search failed to gather jobs.' },
          recoveryKey: 'recovery-key-1',
          awaitedStatus: 'none',
        }),
        true,
      );
      assert.strictEqual(
        canRetryBoardRecoveryAfterError({
          plan: searchedPlan(),
          recoveryError: 'Job Search failed to gather jobs.',
          searchRecoveryError: { key: 'recovery-key-1', message: 'Job Search failed to gather jobs.' },
          recoveryKey: 'recovery-key-1',
          awaitedStatus: 'none',
        }),
        false,
      );
      // The reported deadlock: an error set directly (no recorded key) with the
      // awaited source now terminal on the recorded run.
      assert.strictEqual(
        canRetryBoardRecoveryAfterError({
          plan: searchedPlan({ awaitingSourceResolution: awaiting('linkedin') }),
          recoveryError: 'Job Search failed to gather jobs.',
          searchRecoveryError: null,
          recoveryKey: 'recovery-key-1',
          awaitedStatus: 'terminal-match',
        }),
        true,
      );
      assert.strictEqual(
        canRetryBoardRecoveryAfterError({
          plan: searchedPlan({ awaitingSourceResolution: awaiting('linkedin') }),
          recoveryError: 'Job Search failed to gather jobs.',
          searchRecoveryError: null,
          recoveryKey: 'recovery-key-1',
          awaitedStatus: 'pending',
        }),
        false,
      );
      assert.strictEqual(
        canRetryBoardRecoveryAfterError({
          plan: searchedPlan({ recoverableFailure: { sourceId: 'linkedin' } }),
          recoveryError: 'Job Search failed to gather jobs.',
          searchRecoveryError: null,
          recoveryKey: 'recovery-key-1',
          awaitedStatus: 'terminal-match',
        }),
        false,
      );
      assert.strictEqual(
        canRetryBoardRecoveryAfterError({
          plan: searchedPlan({ cancellationCleanup: { sourceIds: ['linkedin'] } }),
          recoveryError: 'Job Search failed to gather jobs.',
          searchRecoveryError: null,
          recoveryKey: 'recovery-key-1',
          awaitedStatus: 'terminal-match',
        }),
        false,
      );
      // A saved pause is a user wait, never a failed Search: terminal-match must
      // not clear either published saved-pause message.
      for (const pausedMessage of [
        SAVED_HANDOFF_READY_MESSAGE,
        'This Job Search is paused with its saved work. Continue from the Job Board when ready.',
      ]) {
        assert.strictEqual(
          canRetryBoardRecoveryAfterError({
            plan: searchedPlan(),
            recoveryError: pausedMessage,
            searchRecoveryError: null,
            recoveryKey: 'recovery-key-1',
            awaitedStatus: 'terminal-match',
          }),
          false,
        );
      }
      // A combine plan has no Search transition to retry.
      assert.strictEqual(
        canRetryBoardRecoveryAfterError({
          plan: { version: 1, phase: 'combine' },
          recoveryError: 'Job Search failed to gather jobs.',
          searchRecoveryError: null,
          recoveryKey: 'recovery-key-1',
          awaitedStatus: 'terminal-match',
        }),
        false,
      );
    },
  },
  {
    name: 'boardSelectorRuntimeSummary prints the exact recovery-error-latch and awaited-source codes',
    run() {
      const sanitized = {
        rowCount: null,
        selectedCount: null,
        actionEligible: null,
        actionVisible: null,
        actionLabel: null,
        reasons: [],
        selectorBounds: null,
        sourceListBounds: null,
        recoveryErrorLatch: 'sticky',
        awaitedSource: 'terminal-match',
      };
      assert.strictEqual(
        boardSelectorRuntimeSummary(sanitized),
        'rows=not retained · selected=not retained · action=not retained · reasons=none · selector=not retained · source-list=not retained · recovery-error-latch=sticky · awaited-source=terminal-match',
      );
      // Anything outside the allow-list must render as "not retained" rather
      // than echoing a message or a run id into the report.
      assert.strictEqual(
        boardSelectorRuntimeSummary({ ...sanitized, recoveryErrorLatch: 'Job Search failed', awaitedSource: AWAITED_RUN }),
        'rows=not retained · selected=not retained · action=not retained · reasons=none · selector=not retained · source-list=not retained · recovery-error-latch=not retained · awaited-source=not retained',
      );
    },
  },
];
