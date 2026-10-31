import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import electronPkg from 'electron';
import { handleSafe, abortNodeTasksAndWait, nodeCancellationError } from '../../electron/ipc/ipcUtils.js';
import { callLLMRaw, callLLMText } from '../../electron/ipc/llm.js';
import { requestNonApiAi, registerNonApiAiHandlers, returnBridgeHandoffToPerson } from '../../electron/ipc/nonApiAi.js';

const { ipcMain } = electronPkg;
const schema = { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } };
let sequence = 0;
async function until(read) {
  for (let turn = 0; turn < 300; turn++) {
    const value = read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Synthetic route diagnostic checkpoint timed out');
}
function fixture({ task = 'job-scoring', failFirstSend = false } = {}) {
  ipcMain.__clearInvokeHandlers();
  registerNonApiAiHandlers();
  const id = ++sequence;
  const nodeId = `route-diagnostic-${id}`;
  const runId = `route-diagnostic-${process.pid}-${Date.now()}-${id}`;
  const sender = new EventEmitter();
  sender.id = 9700 + id;
  sender.isDestroyed = () => false;
  const sent = [], attempts = [], routes = [[], []];
  sender.send = (channel, payload) => {
    if (channel === 'non-api-ai-request') {
      attempts.push(payload);
      if (failFirstSend && attempts.length === 1) throw new Error('Synthetic transient delivery gap');
    }
    sent.push({ channel, payload });
  };
  const channel = `route-diagnostic-test-${id}`;
  handleSafe(channel, async (_event, args, signal) => ({ answer: await requestNonApiAi({
    prompt: `SYNTHETIC route diagnostic ${id}`, task, responseSchema: schema, signal,
    initialResponse: args.initialResponse,
    onHandoffRoute: route => { routes[args.slot || 0].push(route); },
  }) }));
  const invoke = (args = {}) => ipcMain.__getInvokeHandler(channel)({ sender }, { nodeId, manualAiRunId: runId, ...args });
  const requests = () => sent.filter(item => item.channel === 'non-api-ai-request').map(item => item.payload);
  const submit = request => ipcMain.__getInvokeHandler('submit-non-api-ai-response')({ sender }, {
    requestId: request.requestId, response: JSON.stringify({ handoffCode: request.handoffCode, answer: 'valid' }),
  });
  const abort = () => abortNodeTasksAndWait(nodeId, sender, nodeCancellationError('Synthetic route cancellation'));
  const cleanup = async () => {
    await abort();
    await ipcMain.__getInvokeHandler('complete-non-api-ai-run')({ sender }, { runId });
  };
  return { sender, routes, attempts, invoke, requests, submit, abort, cleanup };
}

export default [
  {
    name: 'Route diagnostics: LLM facades report prospective MCP routing before missing IPC context fails',
    async run() {
      for (const [call, options] of [
        [callLLMText, { task: 'job-scoring', responseSchema: schema }],
        [callLLMRaw, { task: 'job-official-posting-research', grounding: true, responseValidator: value => value }],
      ]) {
        const routes = [];
        await assert.rejects(call('SYNTHETIC missing context', { ...options,
          manualHandoff: { onRoute: route => { routes.push(route); throw new Error('Synthetic observer failure'); } },
        }), { code: 'BRIDGE_RENDERER_UNAVAILABLE' });
        assert.deepEqual(routes, [{ route: 'mcp', manualRoutingReason: null }]);
      }
    },
  },
  {
    name: 'Route diagnostics: manual routing exposes closed reasons without source content',
    async run() {
      for (const [options, reason] of [
        [{ task: 'synthetic-unreviewed', responseSchema: schema }, 'unreviewed-task'],
        [{ task: 'job-scoring', requestKind: 'raw-text' }, 'unsupported-response-format'],
        [{ task: 'job-scoring', responseSchema: schema, attachmentPaths: ['/tmp/synthetic-private-attachment.txt'] }, 'attachment'],
        [{ task: 'job-scoring', responseSchema: schema, initialResponse: 'SYNTHETIC PRIVATE DRAFT' }, 'initial-response'],
      ]) {
        const routes = [];
        await assert.rejects(requestNonApiAi({ prompt: 'SYNTHETIC private prompt', ...options,
          onHandoffRoute: route => routes.push(route) }), { code: 'BRIDGE_RENDERER_UNAVAILABLE' });
        assert.deepEqual(routes, [{ route: 'manual', manualRoutingReason: reason }]);
      }
    },
  },
  {
    name: 'Route diagnostics: transient first manual presentation retries the same pending request',
    async run() {
      const f = fixture({ task: 'synthetic-unreviewed', failFirstSend: true });
      try {
        let settled = false;
        const owner = f.invoke().then(result => { settled = true; return result; });
        await until(() => f.attempts.length === 1);
        assert.equal(settled, false, 'a transient send failure cannot reject the manual item');
        const request = await until(() => f.requests()[0]);
        assert.equal(f.attempts.length, 2, 'presentation retries automatically');
        assert.equal(request.requestId, f.attempts[0].requestId);
        assert.equal(request.handoffCode, f.attempts[0].handoffCode);
        assert.deepEqual(f.routes[0].at(-1), { route: 'manual', manualRoutingReason: 'unreviewed-task' });
        assert.equal((await f.submit(request)).accepted, true);
        assert.equal((await owner).success, true);
      } finally { await f.cleanup(); }
    },
  },
  {
    name: 'Route diagnostics: restored draft and accepted durable replay report their current routing',
    async run() {
      const f = fixture();
      try {
        const first = f.invoke({ initialResponse: 'SYNTHETIC saved draft' });
        await until(() => f.requests()[0]);
        assert.deepEqual(f.routes[0].at(-1), { route: 'manual', manualRoutingReason: 'initial-response' });
        await f.abort();
        assert.equal((await first).success, false);
        const resumed = f.invoke({ slot: 1 });
        const request = await until(() => f.requests()[1]);
        assert.equal(request.initialResponse, 'SYNTHETIC saved draft');
        assert.deepEqual(f.routes[1].at(-1), { route: 'manual', manualRoutingReason: 'restored-draft' });
        assert.equal((await f.submit(request)).accepted, true);
        assert.equal((await resumed).success, true);
        const count = f.requests().length;
        assert.equal((await f.invoke()).success, true);
        assert.equal(f.requests().length, count, 'accepted replay emits no new handoff');
        assert.deepEqual(f.routes[0].at(-1), { route: 'mcp', manualRoutingReason: null });
      } finally { await f.cleanup(); }
    },
  },
  {
    name: 'Route diagnostics: adopted observers receive the actual live route and later escalation',
    async run() {
      const f = fixture();
      try {
        const first = f.invoke();
        const request = await until(() => f.requests()[0]);
        const adopted = f.invoke({ slot: 1 });
        await until(() => f.requests()[1]);
        assert.equal(f.requests()[1].requestId, request.requestId);
        assert.deepEqual(f.routes[1].at(-1), { route: 'mcp', manualRoutingReason: null });
        assert.equal(returnBridgeHandoffToPerson({ requestId: request.requestId, reason: 'worker_restart_cap' }), true);
        for (const routes of f.routes) assert.deepEqual(routes.at(-1), { route: 'manual', manualRoutingReason: 'worker_restart_cap' });
        assert.equal((await f.submit(request)).accepted, true);
        const results = await Promise.all([first, adopted]);
        assert(results.every(result => result.success));
      } finally { await f.cleanup(); }
    },
  },
];
