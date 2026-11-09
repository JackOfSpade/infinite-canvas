import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CLAUDE_TASK_IDS,
  CLAUDE_TASK_PROFILES,
} from '../../electron/ipc/claudeTaskProfiles.js';
import { cachedPromptParts, claudeTaskStatusView, createClaudeTaskWorker } from '../../electron/ipc/claudeTaskWorker.js';
import { createShadowMeasure } from '../../electron/ipc/aiShadowMeasure.js';
import { WORKER_ENABLED_ATTACHMENT_TASKS, WORKER_RELEASE_ONE_TASKS } from '../../electron/ipc/nonApiAi.js';
import { answeringModel, buildClaudeInputMessage } from '../../electron/ipc/claudeApplicationRunner.js';
import { buildOfficialPostingResearchRequest, officialPostingResearchMembers } from '../../electron/ipc/officialPostingBridge.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 20; i += 1) await tick(); };

function harness({ entries, runStage, submit, prompts = {}, ...options }) {
  const state = { pending: new Map(entries.map(entry => [entry.requestId, entry])), failed: [], reads: [], submits: [], returned: [], stages: [], listeners: new Set(), timers: [], clock: 1000 };
  const seam = {
    list: () => ({ handoffs: [...state.pending.values()], settlingRequestIds: [], retryAfterMs: 0 }),
    read: (args) => { state.reads.push(args); return state.pending.has(args.requestId) ? { ok: true, prompt: prompts[args.requestId] ?? `prompt ${args.requestId}` } : { ok: false }; },
    assigned: () => true,
    attachments: async () => ({ attachments: [{ name: 'a.jpg', mime: 'image/jpeg', bytes: new Uint8Array([1]) }] }),
    submit: async (args) => {
      state.submits.push(args);
      const outcome = submit ? submit(args, state) : { outcome: 'accepted' };
      if (outcome.outcome === 'accepted') state.pending.delete(args.requestId);
      return outcome;
    },
    returnToPerson: (args) => { state.returned.push(args); state.pending.delete(args.requestId); return true; },
    fail: (args) => { state.failed.push(args); state.pending.delete(args.requestId); return true; },
    onEvent: (listener) => { state.listeners.add(listener); return () => state.listeners.delete(listener); },
  };
  const worker = createClaudeTaskWorker({
    seam,
    binding: () => ({ binary: 'claude', env: {}, cwd: '/tmp' }),
    now: () => state.clock,
    setTimer: (fn, ms) => { const timer = { fn, ms }; state.timers.push(timer); return timer; },
    clearTimer: (timer) => { state.timers = state.timers.filter(item => item !== timer); },
    runStage: async (options_) => { state.stages.push(options_); return runStage(options_, state); },
    // Never the real keychain in tests: no Tavily unless a test supplies one.
    tavily: { readKey: async () => '', plainLeads: async () => [] },
    ...options,
  });
  return { worker, state };
}

const entry = (requestId, extra = {}) => ({ requestId, handoffCode: `code-${requestId}`, task: 'job-scoring', hasAttachments: false, ...extra });
const answer = { text: 'answer', model: 'claude-sonnet-5-5', usage: {}, costUsd: 0 };
const OFFLOAD_ROUTE = Object.freeze({ provider: 'offload', route: 'deepseek-flash', reasoning: 'high' });
async function until(check) {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('condition was not reached in time');
}
const failing = code => () => { throw Object.assign(new Error(code), { code }); };

export default [
  {
    name: 'claude task worker: every ChatGPT-carried task has a profile',
    run() {
      const expected = [...WORKER_RELEASE_ONE_TASKS, ...WORKER_ENABLED_ATTACHMENT_TASKS].sort();
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
    name: 'claude task worker: official posting research combines built-in search, Claude with Tavily and plain Tavily leads',
    async run() {
      const request = buildOfficialPostingResearchRequest([{ title: 'Platform Engineer', company: 'Acme', location: 'Toronto', url: 'https://www.linkedin.com/jobs/view/1', snippet: 'desc' }]);
      const [{ id }] = officialPostingResearchMembers(request.prompt);
      const section = urls => `BEGIN OFFICIAL POSTING RESEARCH ${id}\n${urls.map(url => `CANDIDATE: ${JSON.stringify({ careersPageUrl: '', postingUrl: url, employer: 'Acme', employerDomain: '', ats: '' })}`).join('\n')}\nEND OFFICIAL POSTING RESEARCH ${id}`;
      const leadCalls = [];
      const rows = [];
      const { worker, state } = harness({
        entries: [entry('a', { task: 'job-official-posting-research' })],
        prompts: { a: request.prompt },
        recordUsage: row => rows.push(row),
        tavily: {
          readKey: async () => 'tvly-test-key',
          plainLeads: async ({ key, member }) => { leadCalls.push({ key, title: member.title }); return ['https://acme.com/jobs/platform-engineer']; },
        },
        runStage: options => (options.mcpServers?.tavily
          ? { text: `Based on my research:\n${section(['https://jobs.lever.co/acme/2', 'https://jobs.lever.co/acme/1/'])}`, model: 'claude-opus-5-5', usage: { output_tokens: 7 }, costUsd: 0.25 }
          : { text: section(['https://jobs.lever.co/acme/1']), model: 'claude-opus-5-5', usage: { output_tokens: 5 }, costUsd: 0.2 }),
      });
      worker.start();
      await until(() => state.submits.length === 1);
      assert.equal(state.stages.length, 2, 'two Claude lookups');
      const native = state.stages.find(stage => !stage.mcpServers);
      const viaTavily = state.stages.find(stage => stage.mcpServers);
      assert.deepEqual(native.tools, ['WebSearch', 'WebFetch']);
      assert.deepEqual(viaTavily.tools, ['mcp__tavily__tavily_search', 'mcp__tavily__tavily_extract']);
      assert.deepEqual(Object.keys(viaTavily.mcpServers), ['tavily']);
      assert.equal(viaTavily.mcpServers.tavily.url.includes('tavilyApiKey=tvly-test-key'), true);
      assert.deepEqual(leadCalls, [{ key: 'tvly-test-key', title: 'Platform Engineer' }]);
      const rowsOut = request.responseValidator(state.submits[0].response);
      assert.deepEqual(rowsOut[0].candidates.map(candidate => candidate.postingUrl),
        ['https://jobs.lever.co/acme/1', 'https://jobs.lever.co/acme/2', 'https://acme.com/jobs/platform-engineer'],
        'built-in first, then Tavily, then plain leads; the duplicate lever link appears once');
      assert.equal(rows[0].costUsd, 0.45, 'both Claude lookups are recorded as spend');
      assert.deepEqual(rows[0].usage, { output_tokens: 12 });
      assert.equal(JSON.stringify(rows).includes('tvly-test-key'), false, 'the key is never recorded');
    },
  },
  {
    name: 'claude task worker: official posting research without a Tavily key is the built-in lookup alone',
    async run() {
      const request = buildOfficialPostingResearchRequest([{ title: 'Platform Engineer', company: 'Acme', location: 'Toronto', url: 'https://x.test/1', snippet: 'd' }]);
      const { worker, state } = harness({ entries: [entry('a', { task: 'job-official-posting-research' })], prompts: { a: request.prompt }, runStage: () => answer });
      worker.start();
      await until(() => state.submits.length === 1);
      assert.equal(state.stages.length, 1);
      assert.deepEqual(state.stages[0].tools, ['WebSearch', 'WebFetch']);
      assert.equal('mcpServers' in state.stages[0], false);
      assert.equal(state.submits[0].response, 'answer', 'the built-in answer goes through unchanged');
    },
  },
  {
    name: 'claude task worker: official posting research keeps whichever lookup succeeded',
    async run() {
      const request = buildOfficialPostingResearchRequest([{ title: 'Platform Engineer', company: 'Acme', location: 'Toronto', url: 'https://x.test/1', snippet: 'd' }]);
      const [{ id }] = officialPostingResearchMembers(request.prompt);
      const reply = url => ({ text: `BEGIN OFFICIAL POSTING RESEARCH ${id}\nCANDIDATE: ${JSON.stringify({ careersPageUrl: '', postingUrl: url, employer: '', employerDomain: '', ats: '' })}\nEND OFFICIAL POSTING RESEARCH ${id}`, model: 'claude-opus-5-5', usage: {}, costUsd: 0.1 });
      for (const failing of ['tavily', 'native']) {
        const { worker, state } = harness({
          entries: [entry('a', { task: 'job-official-posting-research' })], prompts: { a: request.prompt },
          tavily: { readKey: async () => 'k', plainLeads: async () => { throw new Error('search down'); } },
          runStage: options => {
            const isTavily = Boolean(options.mcpServers);
            if ((failing === 'tavily') === isTavily) throw Object.assign(new Error('boom'), { code: 'CLAUDE_FAILED' });
            return reply(isTavily ? 'https://t.test/job' : 'https://n.test/job');
          },
        });
        worker.start();
        await until(() => state.submits.length === 1);
        const candidates = request.responseValidator(state.submits[0].response)[0].candidates.map(candidate => candidate.postingUrl);
        assert.deepEqual(candidates, [failing === 'tavily' ? 'https://n.test/job' : 'https://t.test/job'], failing);
        worker.stop();
      }
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
    name: 'claude task worker: a prompt Claude calls too long fails its caller at once, with no retry or manual paste',
    async run() {
      const { worker, state } = harness({ entries: [entry('a')], runStage: failing('CLAUDE_PROMPT_TOO_LONG') });
      worker.start();
      await settle();
      assert.equal(state.stages.length, 1);
      assert.equal(state.timers.length, 0, 'no retry is scheduled');
      assert.equal(state.returned.length, 0);
      assert.equal(state.failed.length, 1);
      assert.equal(state.failed[0].requestId, 'a');
      assert.equal(state.failed[0].error.code, 'CLAUDE_PROMPT_TOO_LONG');
      assert.equal(worker.status().retrying, 0);
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
    name: 'claude task worker usage: a failed attempt with a cost logs one failed row, then the retry logs its normal row',
    async run() {
      const rows = []; let tries = 0;
      const { worker, state } = harness({
        entries: [entry('a')],
        recordUsage: row => rows.push(row),
        runStage: () => {
          tries += 1;
          if (tries === 1) {
            throw Object.assign(new Error('workflow unfinished'), {
              code: 'CLAUDE_WORKFLOW_UNFINISHED',
              detail: { usage: { input_tokens: 40, output_tokens: 7 }, costUsd: 1.5 },
            });
          }
          return answer;
        },
      });
      worker.start();
      await settle();
      assert.equal(rows.length, 1, 'the failed attempt spent money, so it logs one row');
      assert.equal(rows[0].outcome, 'failed');
      assert.equal(rows[0].code, 'CLAUDE_WORKFLOW_UNFINISHED');
      assert.equal(rows[0].costUsd, 1.5);
      assert.deepEqual(rows[0].usage, { input_tokens: 40, output_tokens: 7 });
      assert.equal(rows[0].provider, 'claude');
      assert.equal(rows[0].model, 'opus');
      assert.equal(rows[0].effort, 'low');
      assert.equal(rows[0].task, 'job-scoring');
      assert.equal(state.timers.length, 1, 'the failure still backs off and retries');
      state.clock += 30_000;
      state.timers.shift().fn();
      await settle();
      assert.equal(state.submits.length, 1);
      assert.equal(rows.length, 2);
      assert.equal('outcome' in rows[1], false, 'a success row gains no failed-attempt fields');
      assert.equal('code' in rows[1], false);
      assert.equal(rows[1].provider, 'claude');
      assert.equal(rows[1].costUsd, 0);
    },
  },
  {
    name: 'claude task worker usage: a failure without cost or usage records nothing and still retries',
    async run() {
      const rows = []; let tries = 0;
      const { worker, state } = harness({
        entries: [entry('a')],
        recordUsage: row => rows.push(row),
        runStage: () => { tries += 1; if (tries === 1) failing('CLAUDE_ERROR')(); return answer; },
      });
      worker.start();
      await settle();
      assert.equal(rows.length, 0, 'no spend was reported, so nothing is logged');
      assert.equal(state.timers.length, 1);
      state.clock += 30_000;
      state.timers.shift().fn();
      await settle();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].outcome, undefined);
    },
  },
  {
    name: 'claude task worker usage: a throwing usage log cannot throw out of handleFailure or change the retry',
    async run() {
      const rows = []; let tries = 0;
      const { worker, state } = harness({
        entries: [entry('a')],
        recordUsage: (row) => { rows.push(row); if (row.outcome === 'failed') throw new Error('usage log is unwritable'); },
        runStage: () => {
          tries += 1;
          if (tries === 1) throw Object.assign(new Error('workflow unfinished'), { code: 'CLAUDE_WORKFLOW_UNFINISHED', detail: { costUsd: 2 } });
          return answer;
        },
      });
      worker.start();
      await settle();
      assert.equal(rows.length, 1);
      assert.equal(state.timers[0].ms, 30_000, 'the same backoff is armed');
      state.clock += 30_000;
      state.timers.shift().fn();
      await settle();
      assert.equal(state.pending.size, 0, 'the retry still finished the task');
      assert.equal(rows.length, 2);
      assert.equal(rows[1].outcome, undefined);
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
  {
    name: 'claude task worker offload: a routed task is answered by the offload call and its usage row names provider, route and reasoning',
    async run() {
      const rows = []; const offloads = [];
      const { worker, state } = harness({
        entries: [entry('a')],
        runStage: () => { throw new Error('Claude must not run'); },
        recordUsage: row => rows.push(row),
        routeFor: task => (task === 'job-scoring' ? OFFLOAD_ROUTE : null),
        offloadCall: async (args) => { offloads.push(args); return { text: 'ds answer', model: 'deepseek-v4-flash', usage: { input_tokens: 3 }, costUsd: 0.01 }; },
      });
      worker.start();
      await settle();
      assert.equal(offloads.length, 1);
      assert.equal(offloads[0].route, 'deepseek-flash');
      assert.equal(offloads[0].reasoning, 'high');
      assert.equal(offloads[0].tag, 'job-scoring');
      assert.deepEqual(offloads[0].messages.map(item => item.role), ['system', 'user']);
      assert.equal(offloads[0].messages[1].content, 'prompt a');
      assert.equal(state.stages.length, 0);
      assert.equal(state.submits[0].response, 'ds answer');
      assert.equal(state.pending.size, 0);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].provider, 'offload');
      assert.equal(rows[0].route, 'deepseek-flash');
      assert.equal(rows[0].reasoning, 'high');
      assert.equal(rows[0].model, 'deepseek-v4-flash');
      assert.equal(rows[0].costUsd, 0.01);
    },
  },
  {
    name: 'claude task worker offload: a task without a table entry runs on Claude and logs provider claude',
    async run() {
      const rows = [];
      const { worker } = harness({
        entries: [entry('a')], runStage: () => answer, recordUsage: row => rows.push(row),
        routeFor: () => null, offloadCall: async () => { throw new Error('offload must not run'); },
      });
      worker.start();
      await settle();
      assert.equal(rows[0].provider, 'claude');
      assert.equal(rows[0].route, undefined);
      assert.equal(rows[0].reasoning, undefined);
    },
  },
  {
    name: 'claude task worker offload: an OFFLOAD_ error is answered on Claude in the same serve, with no backoff',
    async run() {
      const rows = []; let calls = 0;
      const { worker, state } = harness({
        entries: [entry('a')], runStage: () => answer, recordUsage: row => rows.push(row),
        routeFor: () => OFFLOAD_ROUTE,
        offloadCall: async () => { calls += 1; throw Object.assign(new Error('boom'), { code: 'OFFLOAD_PROVIDER_ERROR' }); },
      });
      worker.start();
      await settle();
      assert.equal(calls, 1);
      assert.equal(state.stages.length, 1);
      assert.equal(state.submits.length, 1);
      assert.equal(state.submits[0].response, 'answer');
      assert.equal(state.timers.length, 0, 'no retry timer was armed');
      assert.equal(rows[0].provider, 'claude');
      assert.equal(worker.status().providerNotice, null, 'an ordinary offload error shows no notice');
    },
  },
  {
    name: 'claude task worker offload: credit exhaustion falls back, blocks offload for 30 minutes and exposes providerNotice',
    async run() {
      let calls = 0;
      const { worker, state } = harness({
        entries: [entry('a')], runStage: () => answer,
        routeFor: () => OFFLOAD_ROUTE,
        offloadCall: async () => { calls += 1; throw Object.assign(new Error('credit'), { code: 'OFFLOAD_CREDIT_EXHAUSTED' }); },
      });
      worker.start();
      await settle();
      assert.equal(calls, 1);
      assert.equal(state.stages.length, 1);
      const notice = 'DeepSeek credit is exhausted; AI tasks continue on Claude. Top up DeepSeek to resume savings.';
      assert.equal(worker.status().providerNotice, notice);
      const view = claudeTaskStatusView(worker.status());
      assert.equal(view.providerNotice, notice);
      assert.equal(view.paused, false);
      assert.equal(view.pauseCode, null);
      assert.equal(Object.hasOwn(claudeTaskStatusView({ paused: false }), 'providerNotice'), false, 'no notice field without a notice');
      state.pending.set('b', entry('b', { task: 'job-scoring' }));
      worker.pump();
      await settle();
      assert.equal(calls, 1, 'a later task does not try offload while blocked');
      assert.equal(state.stages.length, 2);
      state.clock += 29 * 60_000;
      assert.equal(worker.status().providerNotice, notice);
      state.clock += 2 * 60_000;
      assert.equal(worker.status().providerNotice, null, 'the block ends after 30 minutes');
      state.pending.set('c', entry('c'));
      worker.pump();
      await settle();
      assert.equal(calls, 2, 'offload is tried again once the block has ended');
    },
  },
  {
    name: 'claude task worker offload: tasks with tools or photos never route',
    async run() {
      const { worker, state } = harness({
        entries: [entry('a', { task: 'job-compensation-research-batch' }), entry('b', { task: 'vision-product-analysis', hasAttachments: true })],
        prepareImage: () => ({ mimeType: 'image/jpeg', data: 'AAAA' }),
        runStage: () => answer,
        routeFor: () => OFFLOAD_ROUTE,
        offloadCall: async () => { throw new Error('offload must not run'); },
      });
      worker.start();
      await settle();
      assert.equal(state.stages.length, 2);
      assert.equal(state.submits.length, 2);
    },
  },
  {
    name: 'claude task worker offload: two rejected offload answers escalate the request to Claude',
    async run() {
      let calls = 0;
      const { worker, state } = harness({
        entries: [entry('a')], runStage: () => answer,
        routeFor: () => OFFLOAD_ROUTE,
        offloadCall: async () => { calls += 1; return { text: `ds ${calls}`, model: 'deepseek-v4-flash', usage: {} }; },
        submit: args => (args.response.startsWith('ds') ? { outcome: 'rejected' } : { outcome: 'accepted' }),
      });
      worker.start();
      await settle();
      assert.equal(calls, 2);
      assert.deepEqual(state.submits.map(item => item.response), ['ds 1', 'ds 2', 'answer']);
      assert.equal(state.stages.length, 1);
      assert.equal(state.pending.size, 0);
    },
  },
  {
    name: 'claude task worker shadow: off by default, so no offload call and no files',
    async run() {
      const dir = path.join(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-shadow-off-')), 'shadow');
      try {
        let offloadCalls = 0;
        for (const env of [{}, { INFINITE_CANVAS_SHADOW_OFFLOAD: 'flash:high' }, { INFINITE_CANVAS_SHADOW_DIR: dir }, { INFINITE_CANVAS_SHADOW_OFFLOAD: 'flash:high', INFINITE_CANVAS_SHADOW_DIR: 'relative/dir' }, { INFINITE_CANVAS_SHADOW_OFFLOAD: 'ultra:high,flash:turbo', INFINITE_CANVAS_SHADOW_DIR: dir }]) {
          const shadow = createShadowMeasure({ env, offloadCall: async () => { offloadCalls += 1; return { text: 'x' }; } });
          assert.equal(shadow.enabled, false);
          const { worker, state } = harness({ entries: [entry('a')], runStage: () => answer, shadow, shadowValidator: () => () => ({ valid: true, code: null }) });
          worker.start();
          await settle();
          assert.equal(state.submits.length, 1);
        }
        await settle();
        assert.equal(offloadCalls, 0);
        assert.equal(fs.existsSync(dir), false);
      } finally { await fs.promises.rm(path.dirname(dir), { recursive: true, force: true }); }
    },
  },
  {
    name: 'claude task worker shadow: an enabled run writes a 0600 row without text, and texts only with SHADOW_TEXTS=1',
    async run() {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-shadow-on-'));
      try {
        const claudeAnswer = { text: 'CLAUDE-ANSWER-7', model: 'claude-sonnet-5-5', usage: {}, costUsd: 0.5, durationMs: 40 };
        const run = async (dir, extraEnv, id) => {
          const offloads = [];
          const shadow = createShadowMeasure({
            env: { INFINITE_CANVAS_SHADOW_OFFLOAD: 'flash:high,bogus,pro:low', INFINITE_CANVAS_SHADOW_DIR: dir, ...extraEnv },
            offloadCall: async (args) => { offloads.push(args); return { text: 'SHADOW-ANSWER-9', model: 'deepseek-v4', durationMs: 12, costUsd: 0.001, usage: { output_tokens: 2 } }; },
          });
          const validated = [];
          const { worker, state } = harness({
            entries: [entry(id)], runStage: () => claudeAnswer, shadow,
            shadowValidator: (args) => {
              assert.equal(args.requestId, id);
              return (response) => { validated.push(response); return response === 'SHADOW-ANSWER-9' ? { valid: false, code: 'SCHEMA_BAD' } : { valid: true, code: null }; };
            },
          });
          worker.start();
          await settle();
          assert.equal(state.submits[0].response, 'CLAUDE-ANSWER-7', 'the real answer is submitted regardless');
          await until(() => fs.existsSync(path.join(dir, 'shadow.jsonl')) && fs.readFileSync(path.join(dir, 'shadow.jsonl'), 'utf8').trim().split('\n').length >= 2);
          return { offloads };
        };
        const plain = path.join(root, 'plain');
        const { offloads } = await run(plain, {}, 'a');
        assert.deepEqual(offloads.map(item => [item.route, item.reasoning, item.tag, item.caller]),
          [['deepseek-flash', 'high', 'shadow-job-scoring', 'infinite-canvas-shadow'], ['deepseek-pro', 'low', 'shadow-job-scoring', 'infinite-canvas-shadow']]);
        const raw = fs.readFileSync(path.join(plain, 'shadow.jsonl'), 'utf8');
        const rows = raw.trim().split('\n').map(line => JSON.parse(line));
        assert.equal(rows.length, 2);
        assert.equal(rows[0].kind, 'task');
        assert.equal(rows[0].id, 'job-scoring');
        assert.equal(rows[0].valid, false);
        assert.equal(rows[0].code, 'SCHEMA_BAD');
        assert.equal(rows[0].ok, true);
        assert.equal(rows[0].claude.outcome, 'accepted');
        assert.equal(typeof rows[0].sampleId, 'string');
        for (const secret of ['CLAUDE-ANSWER-7', 'SHADOW-ANSWER-9', 'prompt a']) assert(!raw.includes(secret), `shadow.jsonl must not contain ${secret}`);
        assert.equal(fs.statSync(path.join(plain, 'shadow.jsonl')).mode & 0o777, 0o600);
        assert.equal(fs.statSync(plain).mode & 0o777, 0o700);
        assert.equal(fs.existsSync(path.join(plain, 'texts')), false, 'texts are off unless SHADOW_TEXTS=1');
        const withTexts = path.join(root, 'texts');
        await run(withTexts, { INFINITE_CANVAS_SHADOW_TEXTS: '1' }, 'b');
        const textsDir = path.join(withTexts, 'texts');
        await until(() => {
          if (!fs.existsSync(textsDir) || fs.readdirSync(textsDir).length !== 1) return false;
          try { JSON.parse(fs.readFileSync(path.join(textsDir, fs.readdirSync(textsDir)[0]), 'utf8')); return true; } catch { return false; }
        });
        const [file] = fs.readdirSync(textsDir);
        const sampleId = JSON.parse(fs.readFileSync(path.join(withTexts, 'shadow.jsonl'), 'utf8').split('\n')[0]).sampleId;
        assert.equal(file, `${sampleId}.json`);
        assert.equal(fs.statSync(path.join(textsDir, file)).mode & 0o777, 0o600);
        const texts = JSON.parse(fs.readFileSync(path.join(textsDir, file), 'utf8'));
        assert.equal(texts.claudeText, 'CLAUDE-ANSWER-7');
        assert.equal(texts.messages[1].content, 'prompt b');
        assert.deepEqual(texts.shadow.map(item => [item.route, item.reasoning, item.text]), [['deepseek-flash', 'high', 'SHADOW-ANSWER-9'], ['deepseek-pro', 'low', 'SHADOW-ANSWER-9']]);
        assert(!fs.readFileSync(path.join(withTexts, 'shadow.jsonl'), 'utf8').includes('SHADOW-ANSWER-9'));
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'claude task worker shadow: a failing offload or validator never fails the real task',
    async run() {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-shadow-fail-'));
      try {
        const shadow = createShadowMeasure({
          env: { INFINITE_CANVAS_SHADOW_OFFLOAD: 'flash:off', INFINITE_CANVAS_SHADOW_DIR: root },
          offloadCall: async () => { throw Object.assign(new Error('down'), { code: 'OFFLOAD_UNAVAILABLE' }); },
        });
        const broken = harness({ entries: [entry('a')], runStage: () => answer, shadow, shadowValidator: () => { throw new Error('validator seam broke'); } });
        broken.worker.start();
        await settle();
        assert.equal(broken.state.submits.length, 1);
        const { worker, state } = harness({ entries: [entry('b')], runStage: () => answer, shadow, shadowValidator: () => () => ({ valid: true, code: null }) });
        worker.start();
        await settle();
        assert.equal(state.submits.length, 1, 'a failing shadow offload leaves the real task answered');
        await until(() => fs.existsSync(path.join(root, 'shadow.jsonl')) && fs.readFileSync(path.join(root, 'shadow.jsonl'), 'utf8').includes('OFFLOAD_UNAVAILABLE'));
        const direct = createShadowMeasure({
          env: { INFINITE_CANVAS_SHADOW_OFFLOAD: 'flash:off', INFINITE_CANVAS_SHADOW_DIR: root },
          offloadCall: async () => ({ text: 'x', model: 'm' }),
        });
        assert.equal(direct.measure({ kind: 'task', id: 't', messages: [], validate: () => { throw new Error('nope'); }, claude: {} }), undefined);
        await until(() => fs.existsSync(path.join(root, 'shadow.jsonl')) && fs.readFileSync(path.join(root, 'shadow.jsonl'), 'utf8').includes('VALIDATOR_THREW'));
        const rows = fs.readFileSync(path.join(root, 'shadow.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert(rows.some(row => row.ok === false && row.valid === false && row.code === 'OFFLOAD_UNAVAILABLE'));
        assert(rows.some(row => row.code === 'VALIDATOR_THREW' && row.valid === false));
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'claude task worker web offload: a WebSearch,WebFetch task with a webTools entry routes to offload with its budget and logs counts',
    async run() {
      const rows = []; const offloads = [];
      const webTools = { searchCount: 3, maxUsd: 0.2 };
      const { worker, state } = harness({
        entries: [entry('a', { task: 'job-compensation-research-batch' })], runStage: () => { throw new Error('claude must not run'); },
        recordUsage: row => rows.push(row),
        routeFor: () => ({ ...OFFLOAD_ROUTE, webTools }),
        offloadCall: async (args) => { offloads.push(args); return { text: 'web answer', model: 'deepseek-v4-flash', usage: {}, costUsd: 0.02, webTools: { turns: 2, toolCalls: 3 } }; },
      });
      worker.start();
      await settle();
      assert.equal(offloads.length, 1);
      assert.deepEqual(offloads[0].webTools, webTools);
      assert.equal(offloads[0].tag, 'job-compensation-research-batch');
      assert.equal(state.stages.length, 0);
      assert.equal(state.submits[0].response, 'web answer');
      assert.equal(rows[0].provider, 'offload');
      assert.deepEqual(rows[0].webTools, { turns: 2, toolCalls: 3 });
    },
  },
  {
    name: 'claude task worker web offload: a web task whose entry has no webTools stays on Claude with its tools',
    async run() {
      const { worker, state } = harness({
        entries: [entry('a', { task: 'job-compensation-research-batch' })], runStage: () => answer,
        routeFor: () => OFFLOAD_ROUTE,
        offloadCall: async () => { throw new Error('offload must not run'); },
      });
      worker.start();
      await settle();
      assert.equal(state.stages.length, 1);
      assert.deepEqual(state.stages[0].tools, ['WebSearch', 'WebFetch']);
      assert(state.stages[0].maxTurns > 1);
    },
  },
  {
    name: 'claude task worker web offload: an OFFLOAD_ failure on the web route falls back to Claude with tools and maxTurns',
    async run() {
      const rows = []; let calls = 0;
      const { worker, state } = harness({
        entries: [entry('a', { task: 'job-compensation-research-batch' })], runStage: () => answer, recordUsage: row => rows.push(row),
        routeFor: () => ({ ...OFFLOAD_ROUTE, webTools: { maxUsd: 0.1 } }),
        offloadCall: async () => { calls += 1; throw Object.assign(new Error('cap'), { code: 'OFFLOAD_BUDGET_CAP' }); },
      });
      worker.start();
      await settle();
      assert.equal(calls, 1);
      assert.equal(state.stages.length, 1);
      assert.deepEqual(state.stages[0].tools, ['WebSearch', 'WebFetch']);
      assert(state.stages[0].maxTurns > 1);
      assert.equal(state.submits[0].response, 'answer');
      assert.equal(rows[0].provider, 'claude');
      assert.equal(rows[0].webTools, undefined);
    },
  },
  {
    name: 'claude task worker web offload: a task with any tool besides WebSearch/WebFetch never routes, even with webTools',
    async run() {
      const profileFor = task => ({ model: 'opus', effort: 'low', tools: task === 'job-scoring' ? 'WebSearch,Bash' : 'WebSearch,WebFetch' });
      const { worker, state } = harness({
        entries: [entry('a', { task: 'job-scoring' })], profileFor, runStage: () => answer,
        routeFor: () => ({ ...OFFLOAD_ROUTE, webTools: {} }),
        offloadCall: async () => { throw new Error('offload must not run'); },
      });
      worker.start();
      await settle();
      assert.equal(state.stages.length, 1);
      assert.deepEqual(state.stages[0].tools, ['WebSearch', 'Bash']);
    },
  },
  {
    name: 'claude task worker web offload: a web task with photos never routes, and an entry maxRejections sets the escalation limit',
    async run() {
      const photo = harness({
        entries: [entry('a', { task: 'job-compensation-research-batch', hasAttachments: true })],
        prepareImage: () => ({ mimeType: 'image/jpeg', data: 'AAAA' }), runStage: () => answer,
        routeFor: () => ({ ...OFFLOAD_ROUTE, webTools: {} }),
        offloadCall: async () => { throw new Error('offload must not run'); },
      });
      photo.worker.start();
      await settle();
      assert.equal(photo.state.stages.length, 1);
      let calls = 0;
      const { worker, state } = harness({
        entries: [entry('b')], runStage: () => answer,
        routeFor: () => ({ ...OFFLOAD_ROUTE, maxRejections: 3 }),
        offloadCall: async () => { calls += 1; return { text: `ds ${calls}`, model: 'deepseek-v4-flash', usage: {} }; },
        submit: args => (args.response.startsWith('ds') ? { outcome: 'rejected' } : { outcome: 'accepted' }),
      });
      worker.start();
      await settle();
      assert.equal(calls, 3);
      assert.deepEqual(state.submits.map(item => item.response), ['ds 1', 'ds 2', 'ds 3', 'answer']);
    },
  },
];
