import { assert } from './testHelpers.js';
import {
  applicationDockItemState,
  applicationDockRequest,
} from '../../src/utils/applicationHandoffDock.js';
import {
  getClaudeApplicationRun,
  normalizeClaudeRun,
  setClaudeApplicationRun,
  subscribeClaudeApplicationRuns,
  __resetClaudeApplicationRunsForTests,
} from '../../src/utils/claudeApplicationRuns.js';

const jobCard = (id, jobId) => ({
  id,
  type: 'jobcard',
  data: {
    title: 'Staff Engineer',
    company: 'Acme',
    localApplication: { id: jobId, status: 'queued', mode: 'paste', canvasFilePath: '/canvas/board.json' },
  },
});

const handoff = (jobId, overrides = {}) => ({
  jobId,
  stage: 'resume',
  revision: 2,
  handoffCode: 'fZ8kQ1v3nT7pLwXyBc2dGh4j',
  baseHashes: {},
  prompt: 'Write the résumé.',
  draft: '',
  ...overrides,
});

export default [
  {
    name: 'claude dock: normalizeClaudeRun keeps the rendered fields of a valid state',
    run() {
      const run = normalizeClaudeRun({
        status: 'running', stage: 'cover-letter', code: 'C1', message: 'busy', updatedAt: 123, extra: true,
      });
      assert(JSON.stringify(run) === JSON.stringify({ status: 'running', stage: 'cover-letter', code: 'C1', message: 'busy' }),
        `unexpected normalized run: ${JSON.stringify(run)}`);
      const bare = normalizeClaudeRun({ status: 'failed' });
      assert(JSON.stringify(bare) === JSON.stringify({ status: 'failed', stage: '', code: '', message: '' }),
        `missing optional fields become empty strings: ${JSON.stringify(bare)}`);
      for (const status of ['running', 'failed', 'done', 'needs-review', 'bridge', 'invalid']) {
        assert(normalizeClaudeRun({ status })?.status === status, `${status} is a known status`);
      }
    },
  },
  {
    name: 'claude dock: normalizeClaudeRun rejects unknown or malformed states',
    run() {
      const malformed = [
        null, undefined, 'running', 42, [], ['running'], {}, { status: 'paused' }, { status: 7 },
        { status: 'RUNNING' }, { stage: 'resume' },
      ];
      for (const value of malformed) {
        assert(normalizeClaudeRun(value) === null, `expected null for ${JSON.stringify(value)}`);
      }
      const odd = normalizeClaudeRun({ status: 'failed', stage: 5, code: {}, message: ['x'] });
      assert(odd.stage === '' && odd.code === '' && odd.message === '', 'non-string fields are dropped, not stringified');
    },
  },
  {
    name: 'claude dock: normalizeClaudeRun clips the message to 400 characters',
    run() {
      const long = `${'a'.repeat(399)}bcdef`;
      const run = normalizeClaudeRun({ status: 'failed', message: long });
      assert(run.message.length === 400, `expected 400 chars, got ${run.message.length}`);
      assert(run.message === `${'a'.repeat(399)}b`, 'the clip keeps the first 400 characters');
      const exact = 'z'.repeat(400);
      assert(normalizeClaudeRun({ status: 'failed', message: exact }).message === exact, 'a 400-char message is untouched');
    },
  },
  {
    name: 'claude dock: applicationDockRequest carries the stored runner state, or null when absent',
    run() {
      __resetClaudeApplicationRunsForTests();
      try {
        const absent = applicationDockRequest({ node: jobCard('card-1', 'job-1'), handoff: handoff('job-1'), canvasFilePath: '/canvas/board.json' });
        assert(absent && Object.prototype.hasOwnProperty.call(absent, 'claudeRun'), 'the request always has a claudeRun key');
        assert(absent.claudeRun === null, 'no stored state means claudeRun is null');

        setClaudeApplicationRun('job-1', { status: 'running', stage: 'resume', message: 'm'.repeat(500), updatedAt: 1 });
        setClaudeApplicationRun('job-2', { status: 'failed', message: 'other job' });
        const running = applicationDockRequest({ node: jobCard('card-1', 'job-1'), handoff: handoff('job-1'), canvasFilePath: '/canvas/board.json' });
        assert(running.claudeRun?.status === 'running', `expected running, got ${JSON.stringify(running.claudeRun)}`);
        assert(running.claudeRun.stage === 'resume', 'stage carried through');
        assert(running.claudeRun.message.length === 400, 'the stored message is clipped');
        assert(!('updatedAt' in running.claudeRun), 'only normalized fields reach the dock item');
        // The pre-existing fields are untouched by the new key.
        assert(running.jobId === 'job-1' && running.prompt === 'Write the résumé.' && running.kind === 'application',
          'existing request fields are unchanged');

        const other = applicationDockRequest({ node: jobCard('card-3', 'job-3'), handoff: handoff('job-3'), canvasFilePath: '/canvas/board.json' });
        assert(other.claudeRun === null, 'another job never inherits a stored state');

        setClaudeApplicationRun('job-1', { status: 'nonsense' });
        assert(getClaudeApplicationRun('job-1') === null, 'a malformed state clears the entry');
        const cleared = applicationDockRequest({ node: jobCard('card-1', 'job-1'), handoff: handoff('job-1'), canvasFilePath: '/canvas/board.json' });
        assert(cleared.claudeRun === null, 'cleared state reads back as null');
      } finally {
        __resetClaudeApplicationRunsForTests();
      }
    },
  },
  {
    name: 'claude dock: store notifies subscribers with next and previous states',
    run() {
      __resetClaudeApplicationRunsForTests();
      try {
        const seen = [];
        const unsubscribe = subscribeClaudeApplicationRuns((jobId, next, previous) => {
          seen.push([jobId, next?.status ?? null, previous?.status ?? null]);
        });
        setClaudeApplicationRun('job-9', { status: 'running' });
        setClaudeApplicationRun('job-9', { status: 'failed', message: 'boom' });
        unsubscribe();
        setClaudeApplicationRun('job-9', { status: 'running' });
        assert(JSON.stringify(seen) === JSON.stringify([['job-9', 'running', null], ['job-9', 'failed', 'running']]),
          `unexpected notifications: ${JSON.stringify(seen)}`);
      } finally {
        __resetClaudeApplicationRunsForTests();
      }
    },
  },
  {
    name: 'claude dock: a running Claude stage is working, a failed one still awaits a person',
    run() {
      assert(applicationDockItemState('queued') === 'waiting', 'baseline: a queued stage awaits a paste');
      assert(applicationDockItemState('queued', normalizeClaudeRun({ status: 'running' })) === 'working',
        'Claude running means the stage is being worked, not awaiting a person');
      assert(applicationDockItemState('queued', normalizeClaudeRun({ status: 'failed', message: 'x' })) === 'waiting',
        'a failed run hands the stage back to a person');
      assert(applicationDockItemState('queued', normalizeClaudeRun({ status: 'bridge' })) === 'waiting',
        'bridge runs keep the existing classification');
      assert(applicationDockItemState('queued', null) === 'waiting', 'no runner state keeps the existing classification');
      // Running never masks a terminal or blocked status.
      assert(applicationDockItemState('saved', normalizeClaudeRun({ status: 'running' })) === 'idle', 'idle stays idle');
      assert(applicationDockItemState('blocked', normalizeClaudeRun({ status: 'running' })) === 'blocked', 'blocked stays blocked');
    },
  },
];
