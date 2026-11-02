import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CLAUDE_TASK_IDS,
  CLAUDE_TASK_PROFILES,
} from '../../electron/ipc/claudeTaskProfiles.js';
import { cachedPromptParts, createClaudeTaskWorker } from '../../electron/ipc/claudeTaskWorker.js';
import { BRIDGE_ENABLED_ATTACHMENT_TASKS, BRIDGE_RELEASE_ONE_TASKS } from '../../electron/ipc/nonApiAi.js';
import { answeringModel, buildClaudeInputMessage } from '../../electron/ipc/claudeApplicationRunner.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 20; i += 1) await tick(); };

function harness({ entries, runStage, submit, ...options }) {
  const state = { pending: new Map(entries.map(entry => [entry.requestId, entry])), reads: [], submits: [], returned: [], stages: [], listeners: new Set(), timers: [], clock: 1000 };
  const seam = {
    list: () => ({ handoffs: [...state.pending.values()], settlingRequestIds: [], retryAfterMs: 0 }),
    read: (args) => { state.reads.push(args); return state.pending.has(args.requestId) ? { ok: true, prompt: `prompt ${args.requestId}` } : { ok: false }; },
    assigned: () => true,
    attachments: async () => ({ attachments: [{ name: 'a.jpg', mime: 'image/jpeg', bytes: new Uint8Array([1]) }] }),
    submit: async (args) => {
      state.submits.push(args);
      const outcome = submit ? submit(args, state) : { outcome: 'accepted' };
      if (outcome.outcome === 'accepted') state.pending.delete(args.requestId);
      return outcome;
    },
    returnToPerson: (args) => { state.returned.push(args); state.pending.delete(args.requestId); return true; },
    onEvent: (listener) => { state.listeners.add(listener); return () => state.listeners.delete(listener); },
  };
  const worker = createClaudeTaskWorker({
    seam,
    binding: () => ({ binary: 'claude', env: {}, cwd: '/tmp' }),
    now: () => state.clock,
    setTimer: (fn, ms) => { const timer = { fn, ms }; state.timers.push(timer); return timer; },
    clearTimer: (timer) => { state.timers = state.timers.filter(item => item !== timer); },
    runStage: async (options_) => { state.stages.push(options_); return runStage(options_, state); },
    ...options,
  });
  return { worker, state };
}

const entry = (requestId, extra = {}) => ({ requestId, handoffCode: `code-${requestId}`, task: 'job-scoring', hasAttachments: false, ...extra });
const answer = { text: 'answer', model: 'claude-sonnet-5-5', usage: {}, costUsd: 0 };
const failing = code => () => { throw Object.assign(new Error(code), { code }); };

export default [
  {
    name: 'claude task worker: every ChatGPT-carried task has a profile',
    run() {
      const expected = [...BRIDGE_RELEASE_ONE_TASKS, ...BRIDGE_ENABLED_ATTACHMENT_TASKS].sort();
      assert.deepEqual([...CLAUDE_TASK_IDS].sort(), expected);
      for (const profile of Object.values(CLAUDE_TASK_PROFILES)) {
        assert(['haiku', 'sonnet', 'opus'].includes(profile.model), 'only the latest of these three models');
        assert(['low', 'medium', 'high', 'xhigh'].includes(profile.effort), 'max effort is excluded');
      }
    },
  },
  {
    name: 'claude task worker: answers a task in a fresh session with its profile and submits through the seam',
    async run() {
      const { worker, state } = harness({ entries: [entry('a')], runStage: () => answer });
      worker.start();
      await settle();
      assert.equal(state.stages[0].text, 'prompt a');
      assert.equal(state.stages[0].model, 'opus');
      assert.equal(state.stages[0].effort, 'low');
      assert.equal(state.stages[0].env.DISABLE_PROMPT_CACHING, '1', 'nothing to share, so no cache write');
      assert.equal(state.stages[0].persistSession, false);
      assert.equal(state.stages[0].tools, undefined, 'tasks without research get no tools');
      assert.equal(state.submits[0].response, 'answer');
      assert.equal(state.pending.size, 0);
    },
  },
  {
    name: 'claude task worker: the app always starts it, with no flag and no captured ChatGPT answers',
    run() {
      const main = fs.readFileSync(new URL('../../electron/main.js', import.meta.url), 'utf8');
      assert(/^\s*startClaudeTaskWorker\(\{/mu.test(main), 'started unconditionally at boot');
      assert(!main.includes('INFINITE_CANVAS_CLAUDE_TASKS'), 'no environment flag gates it');
      const nonApiAi = fs.readFileSync(new URL('../../electron/ipc/nonApiAi.js', import.meta.url), 'utf8');
      assert(!/aiTaskCorpus|AI_TASK_CORPUS/u.test(nonApiAi), 'accepted ChatGPT answers are no longer captured');
      assert(!fs.existsSync(new URL('../../electron/ipc/aiTaskCorpus.js', import.meta.url)), 'the capture module is gone');
    },
  },
  {
    name: 'claude task worker: shared text moves to the system prompt, and nothing else is lost',
    run() {
      const parts = cachedPromptParts('HEAD\nSHARED BLOCK\nTAIL', 'SHARED BLOCK');
      assert.equal(parts.systemAppend, 'SHARED REFERENCE:\nSHARED BLOCK');
      assert.ok(parts.text.startsWith('HEAD\n') && parts.text.endsWith('\nTAIL') && !parts.text.includes('SHARED BLOCK'));
      assert.deepEqual(cachedPromptParts('no match', 'SHARED BLOCK'), { text: 'no match', systemAppend: '' });
      assert.deepEqual(cachedPromptParts('plain', ''), { text: 'plain', systemAppend: '' });
    },
  },
  {
    name: 'claude task worker: research tasks get only the web tools and more than one turn',
    async run() {
      const { worker, state } = harness({ entries: [entry('a', { task: 'job-compensation-research-batch' })], runStage: () => answer });
      worker.start();
      await settle();
      assert.deepEqual(state.stages[0].tools, ['WebSearch', 'WebFetch']);
      assert(state.stages[0].maxTurns > 1);
    },
  },
  {
    name: 'claude task worker: a rejected answer is asked again from the corrected prompt',
    async run() {
      let tries = 0;
      const { worker, state } = harness({
        entries: [entry('a')],
        runStage: () => answer,
        submit: () => { tries += 1; return tries === 1 ? { outcome: 'rejected' } : { outcome: 'accepted' }; },
      });
      worker.start();
      await settle();
      assert.equal(state.stages.length, 2);
      assert.equal(state.pending.size, 0);
    },
  },
  {
    name: 'claude task worker: runs no more than its limit at once',
    async run() {
      let peak = 0;
      let now = 0;
      const { worker, state } = harness({
        concurrency: 2,
        entries: ['a', 'b', 'c', 'd', 'e'].map(id => entry(id)),
        runStage: async () => { now += 1; peak = Math.max(peak, now); await tick(); now -= 1; return answer; },
      });
      worker.start();
      await settle();
      assert.equal(peak, 2);
      assert.equal(state.pending.size, 0);
    },
  },
  {
    name: 'claude task worker: comparison runs each get their own isolated conversation key',
    async run() {
      const { worker, state } = harness({
        entries: [entry('a', { task: 'job-official-posting-match', comparisonGroup: 'g', comparisonRun: 'A' }), entry('b', { task: 'job-official-posting-match', comparisonGroup: 'g', comparisonRun: 'B' })],
        runStage: () => ({ ...answer, model: 'claude-haiku-5-5' }),
      });
      worker.start();
      await settle();
      const [a, b] = state.reads.map(read => read.comparisonProvenance);
      assert.match(a.conversationKey, /^[a-f0-9]{64}$/);
      assert.notEqual(a.conversationKey, b.conversationKey);
      assert.equal(b.isolated, true);
    },
  },
  {
    name: 'claude task worker: a safeguard block retries fresh, then returns to the person',
    async run() {
      const { worker, state } = harness({ entries: [entry('a')], runStage: failing('CLAUDE_SAFEGUARD_BLOCKED') });
      worker.start();
      await settle();
      assert.equal(state.stages.length, 3);
      assert.equal(state.returned.length, 1);
    },
  },
  {
    name: 'claude task worker: a truncated reply backs off and retries, then returns to the person after 3 attempts',
    async run() {
      const { worker, state } = harness({ entries: [entry('a')], runStage: failing('CLAUDE_OUTPUT_TRUNCATED') });
      worker.start();
      await settle();
      assert.equal(state.stages.length, 1);
      assert.equal(state.returned.length, 0);
      for (let attempt = 2; attempt <= 3; attempt += 1) {
        assert.equal(state.timers.length, 1, 'a backoff timer is waiting');
        state.clock += 10 * 60_000;
        state.timers.shift().fn();
        await settle();
        assert.equal(state.stages.length, attempt);
      }
      assert.equal(state.returned.length, 1);
      assert.equal(state.returned[0].requestId, 'a');
      assert.equal(state.returned[0].reason, 'worker_restart_cap');
    },
  },
  {
    name: 'claude task worker: a usage limit pauses all starts and keeps the work pending',
    async run() {
      const { worker, state } = harness({ concurrency: 1, entries: [entry('a'), entry('b')], runStage: failing('CLAUDE_USAGE_LIMIT') });
      worker.start();
      await settle();
      assert.equal(state.stages.length, 1);
      assert.equal(state.pending.size, 2);
      assert.equal(worker.status().paused, true);
      assert.equal(worker.status().pauseCode, 'CLAUDE_USAGE_LIMIT');
      state.clock += 11 * 60_000;
      state.timers.shift().fn();
      await settle();
      assert(state.stages.length > 1, 'work resumes after the wait');
    },
  },
  {
    name: 'claude task worker: a network failure backs off and retries',
    async run() {
      let tries = 0;
      const { worker, state } = harness({
        entries: [entry('a')],
        runStage: () => { tries += 1; if (tries === 1) failing('CLAUDE_ERROR')(); return answer; },
      });
      worker.start();
      await settle();
      assert.equal(state.stages.length, 1);
      assert.equal(state.timers[0].ms, 30_000);
      state.clock += 30_000;
      state.timers.shift().fn();
      await settle();
      assert.equal(state.pending.size, 0);
    },
  },
  {
    name: 'claude task worker: a cancelled task aborts its running call',
    async run() {
      let aborted = false;
      const { worker, state } = harness({
        entries: [entry('a')],
        runStage: ({ signal }) => new Promise((_, reject) => {
          signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('x'), { code: 'CLAUDE_CANCELLED' })); });
        }),
      });
      worker.start();
      await settle();
      state.pending.delete('a');
      worker.pump();
      await settle();
      assert.equal(aborted, true);
      assert.equal(state.submits.length, 0);
    },
  },
  {
    name: 'claude task worker: photos travel as labelled images, and Haiku answers pass the model check',
    async run() {
      const { worker, state } = harness({
        entries: [entry('a', { task: 'vision-product-analysis', hasAttachments: true })],
        prepareImage: () => ({ mimeType: 'image/jpeg', data: 'AAAA' }),
        runStage: () => answer,
      });
      worker.start();
      await settle();
      const message = JSON.parse(buildClaudeInputMessage({ text: 't', pageImages: state.stages[0].pageImages }));
      assert.equal(message.message.content[1].text, 'Photo 1');
      assert.equal(message.message.content[2].source.data, 'AAAA');
      assert.equal(answeringModel('haiku', ['claude-haiku-5-5']), 'claude-haiku-5-5');
    },
  },
];
