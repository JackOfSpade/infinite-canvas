import assert from 'node:assert/strict';
import { describeClaudeSdkMessage } from '../../electron/ipc/claudeApplicationSdkStage.js';
import { clearClaudeUsageLimit, claudeUsageLimit, claudeUsageWaitMs, drainClaudeCalls, holdClaude, trackClaudeCall, releaseClaude, reportClaudeUsageLimit, waitForClaudeRelease, waitForClaudeUsage } from '../../electron/ipc/claudePause.js';
import { createClaudeTaskActivity } from '../../electron/ipc/claudeTaskActivity.js';
import { createClaudeTaskWorker } from '../../electron/ipc/claudeTaskWorker.js';
import { CLAUDE_STALE_AFTER_MS, claudeProgressTimeLines, deriveClaudeTaskProgress } from '../../src/utils/claudeJobProgress.js';
import { normalizeClaudeTaskActivity } from '../../src/utils/claudeTaskActivityStore.js';
import { claudeUsageLimitNotice } from '../../src/utils/claudeTaskPause.js';
import { __resetClaudePauseFlowsForTests, getClaudePauseFlow, startClaudePause } from '../../src/utils/claudePauseFlow.js';
import { deriveClaudeJobProgress } from '../../src/utils/claudeJobProgress.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 20; i += 1) await tick(); };
const stream = event => ({ type: 'stream_event', event });
const entry = (requestId, extra = {}) => ({ requestId, handoffCode: `code-${requestId}`, task: 'job-official-posting-research', hasAttachments: false, ...extra });
const answer = { text: 'answer', model: 'claude-opus-5-5', usage: {}, costUsd: 0 };

function workerHarness({ entries, runStage, submit, ...options }) {
  const state = { pending: new Map(entries.map(row => [row.requestId, row])), timers: [], clock: 1000, notified: [] };
  const worker = createClaudeTaskWorker({
    seam: {
      list: () => ({ handoffs: [...state.pending.values()], settlingRequestIds: [], retryAfterMs: 0 }),
      read: args => (state.pending.has(args.requestId) ? { ok: true, prompt: 'p' } : { ok: false }),
      assigned: () => true,
      attachments: async () => ({ attachments: [] }),
      submit: async (args) => {
        const outcome = submit ? submit(args, state) : { outcome: 'accepted' };
        if (outcome.outcome === 'accepted') state.pending.delete(args.requestId);
        return outcome;
      },
      returnToPerson: () => true,
      fail: () => true,
      onEvent: () => () => {},
    },
    binding: () => ({ binary: 'claude', env: {}, cwd: '.' }),
    now: () => state.clock,
    setTimer: (fn, ms) => { const timer = { fn, ms }; state.timers.push(timer); return timer; },
    clearTimer: (timer) => { state.timers = state.timers.filter(item => item !== timer); },
    onActivityChange: snapshot => state.notified.push(snapshot),
    runStage,
    ...options,
  });
  return { worker, state };
}

export default [
  {
    name: 'claude task activity: SDK messages describe each kind of activity',
    run() {
      assert.deepEqual(describeClaudeSdkMessage({ type: 'system', subtype: 'init' }), { kind: 'started' });
      assert.deepEqual(describeClaudeSdkMessage(stream({ type: 'message_start' })), { kind: 'request' });
      assert.deepEqual(describeClaudeSdkMessage(stream({ type: 'content_block_start', content_block: { type: 'thinking' } })), { kind: 'thinking', chars: 0 });
      assert.deepEqual(describeClaudeSdkMessage(stream({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'abc' } })), { kind: 'thinking', chars: 3 });
      assert.deepEqual(describeClaudeSdkMessage(stream({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } })), { kind: 'writing', chars: 5 });
      assert.deepEqual(describeClaudeSdkMessage({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true }] } }), { kind: 'tool-result', isError: true });
      assert.deepEqual(describeClaudeSdkMessage({ type: 'tool_progress', tool_name: 'WebFetch', elapsed_time_seconds: 9 }), { kind: 'tool-progress', tool: 'WebFetch', seconds: 9 });
      assert.deepEqual(describeClaudeSdkMessage({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 8000, error_status: 529 }),
        { kind: 'api-retry', attempt: 2, maxRetries: 10, delayMs: 8000, status: 529 });
      assert.deepEqual(describeClaudeSdkMessage({ type: 'result' }), { kind: 'finished' });
      assert.deepEqual(describeClaudeSdkMessage({ type: 'assistant', parent_tool_use_id: 'x', message: { content: [{ type: 'tool_use', name: 'WebFetch' }] } }), { kind: 'subagent' });
    },
  },
  {
    name: 'claude task activity: events carry no prompt, thinking or answer text and no URL query',
    run() {
      const secret = 'private-career-text';
      for (const message of [
        stream({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: secret } }),
        stream({ type: 'content_block_delta', delta: { type: 'text_delta', text: secret } }),
        { type: 'assistant', message: { content: [{ type: 'text', text: secret }, { type: 'tool_use', name: 'Bash', input: { command: secret } }] } },
      ]) assert(!JSON.stringify(describeClaudeSdkMessage(message)).includes(secret));
      const fetched = describeClaudeSdkMessage({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', name: 'WebFetch', input: { url: 'https://jobs.example.com/apply/1?token=abc#top' } }] } });
      assert.deepEqual(fetched.calls, [{ tool: 'WebFetch', target: 'jobs.example.com/apply/1' }]);
      const searched = describeClaudeSdkMessage({ type: 'assistant', message: { content: [{ type: 'server_tool_use', name: 'WebSearch', input: { query: 'x'.repeat(500) } }] } });
      assert.equal(searched.calls[0].target.length, 120);
      const unknown = describeClaudeSdkMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Other', input: { query: secret, url: secret } }] } });
      assert.equal(unknown.calls[0].target, null);
      for (const bad of [null, undefined, 42, 'text', [], {}, { type: 'stream_event' }, { type: 'assistant', message: { content: 'nope' } }]) {
        assert.equal(describeClaudeSdkMessage(bad), null);
      }
    },
  },
  {
    name: 'claude task activity: steps change with the phase, not with each streamed delta',
    run() {
      let clock = 100;
      const tracker = createClaudeTaskActivity({ now: () => clock });
      tracker.begin('a', { task: 't', model: 'opus', effort: 'low', maxTurns: 16 });
      for (let i = 0; i < 5; i += 1) { clock += 1; tracker.event('a', { kind: 'thinking', chars: 10 }); }
      for (let i = 0; i < 5; i += 1) tracker.event('a', { kind: 'writing', chars: 2 });
      let task = tracker.snapshot().tasks.a;
      assert.deepEqual(task.steps.map(step => step.label), ['Thinking', 'Writing the answer']);
      assert.equal(task.thinkingChars, 50);
      assert.equal(task.outputChars, 10);
      for (let i = 0; i < 20; i += 1) tracker.event('a', { kind: 'tool', messageId: `m${i % 3}`, calls: [{ tool: 'WebSearch', target: `q${i}` }] });
      task = tracker.snapshot().tasks.a;
      assert.equal(task.steps.length, 12, 'the step log is bounded');
      assert.equal(task.steps.at(-1).label, 'Searching the web: q19');
      assert.equal(task.toolTurns, 3, 'turns count distinct assistant messages');
      assert.equal('turnIds' in task, false, 'the snapshot crosses IPC as plain data');
      assert.doesNotThrow(() => JSON.stringify(tracker.snapshot()));
    },
  },
  {
    name: 'claude task activity: an undescribed message still proves Claude is alive',
    run() {
      let clock = 100;
      const tracker = createClaudeTaskActivity({ now: () => clock });
      tracker.begin('a', {});
      assert.equal(tracker.snapshot().tasks.a.lastActivityAt, null);
      clock = 500;
      tracker.event('a', null);
      assert.equal(tracker.snapshot().tasks.a.lastActivityAt, 500);
      assert.equal(tracker.snapshot().tasks.a.phase, 'starting');
    },
  },
  {
    name: 'claude task activity: an accepted answer leaves the snapshot once the correction round ends',
    async run() {
      let rounds = 0;
      const { worker } = workerHarness({
        entries: [entry('a', { issuedAt: 400 })],
        runStage: async ({ onActivity }) => { rounds += 1; onActivity({ kind: 'writing', chars: 7 }); return answer; },
        submit: () => (rounds === 1 ? { outcome: 'rejected' } : { outcome: 'accepted' }),
      });
      worker.pump();
      await settle();
      assert.equal(rounds, 2, 'the rejected answer was asked again');
      assert.equal(worker.activity().tasks.a, undefined);
      worker.stop();
    },
  },
  {
    name: 'claude task activity: a rejection keeps the same entry and names the step',
    async run() {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      let calls = 0;
      const { worker } = workerHarness({
        entries: [entry('a', { issuedAt: 400 })],
        runStage: async ({ onActivity }) => {
          calls += 1;
          onActivity({ kind: 'writing', chars: 7 });
          if (calls === 2) await gate;
          return answer;
        },
        submit: () => (calls === 1 ? { outcome: 'rejected' } : { outcome: 'accepted' }),
      });
      worker.pump();
      await settle();
      const task = worker.activity().tasks.a;
      assert.equal(task.round, 2);
      assert.equal(task.rejections, 1);
      assert.equal(task.firstStartedAt, 400);
      assert.equal(task.outputChars, 7, 'the character count restarts each round');
      const labels = task.steps.map(step => step.label);
      assert(labels.includes('App rejected the answer') && labels.includes('Checking the answer'), labels.join());
      release();
      await settle();
      worker.stop();
    },
  },
  {
    name: 'claude task activity: handoffs past the slot limit read as queued, running ones as running',
    async run() {
      const { worker } = workerHarness({
        concurrency: 1,
        entries: [entry('a'), entry('b')],
        runStage: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { code: 'CLAUDE_CANCELLED' })))),
      });
      worker.pump();
      await settle();
      const snapshot = worker.activity();
      assert.equal(snapshot.tasks.a.state, 'running');
      assert.equal(snapshot.tasks.a.model, 'opus');
      assert.equal(snapshot.tasks.a.maxTurns, 16, 'a research task reports its turn limit');
      assert.equal(snapshot.tasks.b.state, 'queued');
      assert.equal(snapshot.running, 1);
      assert.equal(snapshot.waiting, 1);
      worker.stop();
      await settle();
    },
  },
  {
    name: 'claude task activity: a failed attempt shows its reason and next attempt, then a pause shows as paused',
    async run() {
      let code = 'CLAUDE_TIMEOUT';
      const { worker, state } = workerHarness({
        entries: [entry('a')],
        runStage: async () => { throw Object.assign(new Error('provider secret text'), { code }); },
      });
      worker.pump();
      await settle();
      const task = worker.activity().tasks.a;
      assert.equal(task.state, 'retrying');
      assert.equal(task.failure.code, 'CLAUDE_TIMEOUT');
      assert.equal(task.failure.retryAt, 1000 + 30_000);
      assert(!JSON.stringify(task).includes('provider secret text'), 'provider messages never reach the dock');
      code = 'CLAUDE_USAGE_LIMIT';
      state.clock += 31_000;
      worker.pump();
      await settle();
      const paused = worker.activity();
      assert.equal(paused.paused, true);
      assert.equal(paused.pauseCode, 'CLAUDE_USAGE_LIMIT');
      assert.equal(paused.tasks.a.state, 'queued');
      worker.stop();
    },
  },
  {
    name: 'claude task activity: a handoff that is gone leaves the snapshot',
    async run() {
      const { worker, state } = workerHarness({
        concurrency: 0,
        entries: [entry('a')],
        runStage: async () => answer,
      });
      worker.pump();
      assert.equal(worker.activity().tasks.a.state, 'queued');
      state.pending.delete('a');
      worker.pump();
      assert.equal(worker.activity().tasks.a, undefined);
      worker.stop();
    },
  },
  {
    name: 'claude task activity: pushes to the dock are throttled and stop with the worker',
    async run() {
      const { worker, state } = workerHarness({
        entries: [entry('a')],
        runStage: ({ onActivity, signal }) => new Promise((_, reject) => {
          for (let i = 0; i < 50; i += 1) onActivity({ kind: 'writing', chars: 1 });
          signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { code: 'CLAUDE_CANCELLED' })));
        }),
      });
      worker.pump();
      await settle();
      const pending = state.timers.filter(timer => timer.ms === 500);
      assert.equal(pending.length, 1, 'fifty deltas schedule one push');
      assert.equal(state.notified.length, 0);
      pending[0].fn();
      assert.equal(state.notified.length, 1);
      assert.equal(state.notified[0].tasks.a.outputChars, 50);
      worker.stop();
      assert.equal(state.timers.filter(timer => timer.ms === 500 && timer !== pending[0]).length, 0, 'stop leaves no push pending');
      await settle();
    },
  },
  {
    name: 'claude task activity: a broken subscriber cannot affect a task',
    async run() {
      const { worker, state } = workerHarness({
        entries: [entry('a')],
        runStage: async () => answer,
        onActivityChange: () => { throw new Error('window closing'); },
      });
      worker.pump();
      await settle();
      for (const timer of state.timers.filter(row => row.ms === 500)) assert.doesNotThrow(() => timer.fn());
      assert.equal(state.pending.size, 0, 'the answer was still accepted');
      worker.stop();
    },
  },
  {
    name: 'claude task activity: the store keeps only bounded known fields',
    run() {
      const hostile = normalizeClaudeTaskActivity({
        running: -1, waiting: 'many', paused: 'yes', tasks: {
          a: { state: 'running', phase: 'nonsense', prompt: 'secret', firstStartedAt: -5, outputChars: Infinity, target: 'x'.repeat(500), failure: 'no',
            steps: [{ at: 1, label: 'ok' }, { at: 'late', label: 'bad time' }, { at: 2, label: 42 }, null] },
          b: { state: 'unknown' },
          c: 'text',
        },
      });
      assert.equal(hostile.running, 0);
      assert.equal(hostile.waiting, 0);
      assert.equal(hostile.paused, false);
      assert.deepEqual(Object.keys(hostile.tasks), ['a']);
      const task = hostile.tasks.a;
      assert.equal(task.phase, 'starting');
      assert.equal('prompt' in task, false);
      assert.equal(task.firstStartedAt, null);
      assert.equal(task.outputChars, 0);
      assert.equal(task.target.length, 160);
      assert.equal(task.failure, null);
      assert.deepEqual(task.steps, [{ at: 1, label: 'ok' }]);
      for (const bad of [null, 42, [], 'x']) assert.deepEqual({ ...normalizeClaudeTaskActivity(bad).tasks }, {});
    },
  },
  {
    name: 'claude task activity: the view says what is known for every state',
    run() {
      const view = (task, extra = {}) => deriveClaudeTaskProgress({ activity: { running: 1, waiting: 0, ...extra, tasks: task ? { a: task } : {} }, requestId: 'a' });
      const unknown = view(null);
      assert.equal(unknown.headline, 'Waiting for Claude to pick this up');
      assert.equal(unknown.since, null);
      assert.equal(view(null, { paused: true }).headline, 'Paused until Claude is available');
      assert.equal(view({ state: 'queued', phaseStartedAt: 5, firstStartedAt: 5 }).headline, 'Waiting for an available Claude slot');
      assert.equal(view({ state: 'queued' }, { paused: true }).tone, 'attention');
      const base = { state: 'running', model: 'opus', effort: 'low', round: 1, firstStartedAt: 1, phaseStartedAt: 2, lastActivityAt: 3 };
      assert.equal(view({ ...base, phase: 'starting' }).headline, 'Starting Claude');
      assert.equal(view({ ...base, phase: 'thinking' }).headline, 'Claude is thinking');
      assert.equal(view({ ...base, phase: 'writing' }).headline, 'Claude is writing the answer');
      const searching = view({ ...base, phase: 'tool', tool: 'WebSearch', target: 'Acme jobs' });
      assert.equal(searching.headline, 'Searching the web');
      assert.equal(searching.detail, 'Acme jobs');
      assert.equal(view({ ...base, phase: 'tool', tool: 'WebFetch' }).headline, 'Reading a page');
      assert.equal(view({ ...base, phase: 'waiting' }).headline, 'Waiting for Claude to respond');
      const finishedTool = createClaudeTaskActivity();
      finishedTool.begin('a', {});
      finishedTool.event('a', { kind: 'tool', messageId: 'm', calls: [{ tool: 'WebFetch', target: 'a.com' }] });
      finishedTool.event('a', { kind: 'tool-result', isError: false });
      assert.equal(finishedTool.snapshot().tasks.a.phase, 'waiting', 'a finished tool no longer reads as running');
      assert.equal(finishedTool.snapshot().tasks.a.target, null);
      const retry = view({ ...base, phase: 'api-retry', apiRetry: { attempt: 2, maxRetries: 10, delayMs: 8000, status: 529 } });
      assert.equal(retry.tone, 'attention');
      assert.equal(retry.detail, 'Attempt 2 of 10, waiting 8s (HTTP 529).');
      const checking = view({ ...base, state: 'checking' });
      assert.equal(checking.kind, 'claude-checking');
      assert.equal(checking.lastHeard, null, 'host checks do not claim Claude is streaming');
      const retrying = view({ ...base, state: 'retrying', failure: { label: 'Claude did not finish in time', retryAt: 31000 } });
      assert.equal(retrying.kind, 'claude-retrying');
      assert.equal(retrying.detail, 'Claude did not finish in time.');
      assert.equal(claudeProgressTimeLines(retrying, 1000).next, 'Next attempt in 30s');
      assert.equal(claudeProgressTimeLines(retrying, 31000).next, 'Next attempt now');
      assert.equal(claudeProgressTimeLines(retrying, 1000).heard, null);
      const full = view({ ...base, phase: 'writing', round: 2, rejections: 1, toolTurns: 3, maxTurns: 16, outputChars: 1234, thinkingChars: 890 }, { running: 4, waiting: 12 });
      assert.equal(full.contextLabel, 'Opus · low effort · round 2');
      assert.equal(full.summary, '1 rejected · Web research turn 3 of 16 · 1,234 characters written · 890 characters of thinking · 4 tasks running · 12 waiting for a slot');
      const many = view({ ...base, phase: 'writing', steps: Array.from({ length: 12 }, (_, at) => ({ at, label: `s${at}` })) });
      assert.deepEqual(many.steps.map(step => step.label), ['s4', 's5', 's6', 's7', 's8', 's9', 's10', 's11']);
    },
  },
  {
    name: 'claude task activity: silence is flagged from exactly the limit and never hides the clock',
    run() {
      const running = { kind: 'claude-writing', lastHeard: 1000, since: 1000, startedAt: 1000 };
      assert.equal(claudeProgressTimeLines(running, 1000 + CLAUDE_STALE_AFTER_MS - 1).stale, false);
      const stale = claudeProgressTimeLines(running, 1000 + CLAUDE_STALE_AFTER_MS);
      assert.equal(stale.stale, true);
      assert.equal(stale.heard, 'Last heard from Claude 2 min ago');
      assert.equal(claudeProgressTimeLines({ kind: 'claude-queued', since: 1000 }, 500000).stale, false, 'a queued task is not silent');
    },
  },
  {
    name: 'claude clean pause: a held node starts nothing new, its running call finishes and is saved, and drain then resolves',
    async run() {
      let held = false;
      let finish;
      const submitted = [];
      const starts = [];
      const { worker } = workerHarness({
        concurrency: 2,
        isHeld: () => held,
        entries: [entry('a', { nodeId: 'hub' })],
        runStage: ({ signal }) => new Promise((resolve, reject) => {
          starts.push('call');
          finish = () => resolve(answer);
          signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { code: 'CLAUDE_CANCELLED' })));
        }),
        submit: (args) => { submitted.push(args.requestId); return { outcome: 'accepted' }; },
      });
      worker.pump();
      await settle();
      assert.equal(starts.length, 1);
      held = true;
      let drained = false;
      const draining = worker.drain('hub').then(() => { drained = true; });
      await settle();
      assert.equal(drained, false, 'a running call is never cut off by a pause');
      finish();
      await draining;
      assert.deepEqual(submitted, ['a'], 'its answer was submitted before the drain ended');
      worker.stop();
    },
  },
  {
    name: 'claude clean pause: a held handoff stays queued and starts after release; stop-now ends only that node',
    async run() {
      let held = true;
      const started = [];
      const { worker } = workerHarness({
        isHeld: nodeId => held && nodeId === 'hub',
        entries: [entry('a', { nodeId: 'hub' }), entry('b', { nodeId: 'other' })],
        runStage: ({ signal }) => new Promise((_, reject) => {
          started.push('call');
          signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { code: 'CLAUDE_CANCELLED' })));
        }),
      });
      worker.pump();
      await settle();
      assert.equal(worker.activity().tasks.a.state, 'queued', 'the held node waits');
      assert.equal(worker.activity().tasks.b.state, 'running', 'another node is untouched');
      held = false;
      worker.pump();
      await settle();
      assert.equal(worker.activity().tasks.a.state, 'running');
      worker.stopRunning('hub');
      await settle();
      assert.equal(worker.activity().tasks.b.state, 'running', 'stop-now leaves other nodes running');
      worker.stop();
      await settle();
    },
  },
  {
    name: 'claude clean pause: waiting for release ends on release or on an abort, so a discard still works',
    async run() {
      holdClaude('application:job');
      let released = false;
      const waiting = waitForClaudeRelease('application:job').then(() => { released = true; });
      await settle();
      assert.equal(released, false);
      releaseClaude('application:job');
      await waiting;
      holdClaude('application:job');
      const controller = new AbortController();
      const aborted = waitForClaudeRelease('application:job', controller.signal);
      controller.abort();
      await aborted;
      releaseClaude('application:job');
      await waitForClaudeRelease('application:job');
    },
  },
  {
    name: 'claude usage limit: a known reset sets the wait, an unknown one probes, and later failures cannot shorten it',
    async run() {
      assert.equal(claudeUsageWaitMs(161_000, 100_000), 121_000, 'reset plus a grace minute');
      assert.equal(claudeUsageWaitMs(null, 100_000), 600_000);
      assert.equal(claudeUsageWaitMs(50_000, 100_000), 600_000, 'a reset in the past is not a wait');
      const resetsAt = Date.now() + 3_600_000;
      try {
        reportClaudeUsageLimit({ resetsAt });
        const first = claudeUsageLimit().resumeAt;
        reportClaudeUsageLimit({ resetsAt: null });
        assert.equal(claudeUsageLimit().resumeAt, first);
        let woke = false;
        const waiting = waitForClaudeUsage().then(() => { woke = true; });
        await settle();
        assert.equal(woke, false);
        clearClaudeUsageLimit();
        await waiting;
        assert.equal(claudeUsageLimit(), null);
      } finally { clearClaudeUsageLimit(); }
    },
  },
  {
    name: 'claude usage limit: the worker waits for the reported reset and Resume now starts it again',
    async run() {
      const reports = [];
      let limited = true;
      const { worker, state } = workerHarness({
        entries: [entry('a')],
        onUsageLimit: report => reports.push(report),
        runStage: async () => {
          if (limited) throw Object.assign(new Error('limit'), { code: 'CLAUDE_USAGE_LIMIT', detail: { resetsAt: state.clock + 3_600_000 } });
          return answer;
        },
      });
      worker.pump();
      await settle();
      assert.equal(reports[0].resetsAt, 1000 + 3_600_000);
      assert.equal(worker.status().pauseCode, 'CLAUDE_USAGE_LIMIT');
      assert.equal(worker.activity().tasks.a.state, 'queued', 'the work stays pending');
      assert.equal(state.timers.at(-1).ms, 3_660_000, 'it wakes at the reset');
      limited = false;
      worker.resumeNow();
      await settle();
      assert.equal(state.pending.size, 0, 'Resume now finished the work');
      assert.equal(worker.status().pauseCode, null);
      worker.stop();
    },
  },
  {
    name: 'claude usage limit: the SDK reset arrives on the event and the notice names what is safe',
    run() {
      assert.deepEqual(describeClaudeSdkMessage({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1_700_000_000 } }), { kind: 'rate-limited', resetsAt: 1_700_000_000_000 });
      assert.equal(describeClaudeSdkMessage({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1 } }), null);
      assert.match(claudeUsageLimitNotice({ resumeAt: Date.now(), knownReset: true }).reason, /finished work is saved.*when usage resets/u);
      assert.match(claudeUsageLimitNotice({ resumeAt: Date.now(), knownReset: false }).reason, /did not say when/u);
      assert.equal(claudeUsageLimitNotice(null), null);
    },
  },
  {
    name: 'claude status views: paused, pausing and usage-limited each say so, for tasks and for bundles',
    run() {
      const task = state => deriveClaudeTaskProgress({ activity: { held: ['node:hub'], tasks: { a: { state, nodeId: 'hub', phase: 'writing', model: 'opus' } } }, requestId: 'a' });
      assert.equal(task('queued').headline, 'Paused');
      assert.equal(task('retrying').retryAt, null, 'a paused task promises no next attempt');
      assert.equal(task('running').headline, 'Claude is writing the answer');
      assert.match(task('running').summary, /Pausing after this call finishes/u);
      const limited = deriveClaudeTaskProgress({ activity: { usageLimit: { resumeAt: 1 }, tasks: { a: { state: 'queued' } } }, requestId: 'a' });
      assert.equal(limited.headline, 'Paused until Claude usage resets');
      const bundle = extra => deriveClaudeJobProgress({ run: { status: 'running', stage: 'write', activity: 'waiting' }, ...extra });
      assert.equal(bundle({ held: true }).headline, 'Paused');
      assert.equal(bundle({ usageLimited: true }).headline, 'Paused until Claude usage resets');
      const live = deriveClaudeJobProgress({ run: { status: 'running', stage: 'write', live: { state: 'running', phase: 'tool', tool: 'WebSearch', target: 'Acme', toolTurns: 2, outputChars: 12, steps: [{ at: 1, label: 'Write application' }] } } });
      assert.equal(live.headline, 'Write application');
      assert.equal(live.detail, 'Searching the web: Acme');
      assert.match(live.summary, /2 tool turns · 12 characters written/u);
      assert.deepEqual(live.steps.map(step => step.label), ['Write application']);
    },
  },
  {
    name: 'claude clean pause: drain waits for the exact key and only that key',
    async run() {
      const endA = trackClaudeCall('application:a');
      const endA2 = trackClaudeCall('application:a');
      const endB = trackClaudeCall('application:b');
      let drained = false;
      const draining = drainClaudeCalls('application:a').then(() => { drained = true; });
      endB();
      endA();
      await settle();
      assert.equal(drained, false, 'one call for this key is still running');
      endA2();
      endA2();
      await draining;
      await drainClaudeCalls('application:never-ran');
    },
  },
  {
    name: 'claude clean pause: only a confirmed save releases the hold',
    async run() {
      const calls = [];
      const previous = globalThis.window;
      globalThis.window = { electronAPI: {
        holdClaude: async key => calls.push(`hold ${key}`), releaseClaude: async key => calls.push(`release ${key}`), drainClaude: async key => calls.push(`drain ${key}`),
      } };
      try {
        for (const [result, error] of [[undefined, 'The save could not be confirmed.'], [{ success: false, error: 'Busy.' }, 'Busy.'], [{ success: 'yes' }, 'The save could not be confirmed.']]) {
          __resetClaudePauseFlowsForTests();
          calls.length = 0;
          await startClaudePause(['node:n'], async () => result);
          assert.deepEqual({ ...getClaudePauseFlow('node:n') }, { phase: 'paused', error });
          assert.equal(calls.some(call => call.startsWith('release')), false, 'an unconfirmed save keeps the hold');
        }
        __resetClaudePauseFlowsForTests();
        calls.length = 0;
        await startClaudePause(['node:n'], async () => ({ success: true }));
        assert.deepEqual(calls, ['hold node:n', 'drain node:n', 'release node:n'], 'order: hold, drain, save, release');
        assert.equal(getClaudePauseFlow('node:n').phase, 'idle');
        await startClaudePause(['node:m']);
        assert.equal(getClaudePauseFlow('node:m').phase, 'paused', 'work with no checkpoint stays held until Resume');
      } finally { globalThis.window = previous; __resetClaudePauseFlowsForTests(); }
    },
  },
  {
    name: 'claude usage limit: a replaced wake timer cannot strand the worker past the reset',
    async run() {
      const { worker, state } = workerHarness({
        entries: [entry('a')],
        runStage: async () => { throw Object.assign(new Error('limit'), { code: 'CLAUDE_USAGE_LIMIT', detail: { resetsAt: state.clock + 3_600_000 } }); },
      });
      worker.pump();
      await settle();
      state.timers.length = 0;
      state.clock += 1000;
      worker.pump();
      assert.equal(state.timers.length, 1, 'any later pump re-arms the wake');
      assert.equal(state.timers[0].ms, 3_659_000);
      worker.stop();
    },
  },
];
