import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import electronPkg from 'electron';
import { handleSafe, abortNodeTasksAndWait, nodeCancellationError } from '../../electron/ipc/ipcUtils.js';
import { requestNonApiAi, registerNonApiAiHandlers, listBridgeableNonApiAiHandoffs, markBridgeableNonApiAiHandoffAssigned, submitNonApiAiResponseForBridge } from '../../electron/ipc/nonApiAi.js';
import { createPushSource } from '../../electron/ipc/handoffBridge/sources/push.js';
import { createHandoffCodeGuard } from '../../electron/ipc/handoffBridge/lanes.js';

const { ipcMain, app } = electronPkg;
let sequence = 0;
async function until(read) {
  for (let turn = 0; turn < 200; turn++) {
    const result = read();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Synthetic adoption fixture timed out');
}
function fixture(task = 'job-scoring') {
  ipcMain.__clearInvokeHandlers();
  registerNonApiAiHandlers();
  const id = ++sequence;
  const nodeId = `adoption-node-${id}`;
  const runId = `adoption-${process.pid}-${Date.now()}-${id}`;
  const assignments = [0, 0, 0];
  function renderer(offset) {
    const sender = new EventEmitter();
    sender.id = 8000 + id * 10 + offset;
    sender.isDestroyed = () => false;
    sender.sent = [];
    sender.send = (channel, payload) => sender.sent.push({ channel, payload });
    return sender;
  }
  const first = renderer(0), resumed = renderer(1);
  const channel = `adoption-test-${id}`;
  handleSafe(channel, async (_event, args, signal) => ({ answer: await requestNonApiAi({
    prompt: `SYNTHETIC adoption ${id}`, task, signal,
    responseSchema: { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } },
    onHandoffAssigned: () => { assignments[args.slot || 0]++; },
  }) }));
  const invoke = (sender, slot = 0) => ipcMain.__getInvokeHandler(channel)({ sender }, { nodeId, manualAiRunId: runId, slot });
  const requests = sender => sender.sent.filter(item => item.channel === 'non-api-ai-request').map(item => item.payload);
  const pending = () => listBridgeableNonApiAiHandoffs({ allowTasks: new Set([task]) }).handoffs.filter(item => item.nodeId === nodeId);
  const bridgeArgs = request => ({ requestId: request.requestId, handoffCode: request.handoffCode, allowTasks: new Set([task]) });
  const response = (request, answer = 'one accepted answer') => JSON.stringify({ handoffCode: request.handoffCode, answer });
  const submit = (request, answer) => submitNonApiAiResponseForBridge({ ...bridgeArgs(request), response: response(request, answer) });
  const complete = () => ipcMain.__getInvokeHandler('complete-non-api-ai-run')({ sender: resumed }, { runId });
  const durable = () => JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'non-api-ai-handoffs.json'), 'utf8')).runs[runId];
  const cleanup = async () => {
    await abortNodeTasksAndWait(nodeId, first, nodeCancellationError('Node deleted'));
    await abortNodeTasksAndWait(nodeId, resumed, nodeCancellationError('Node deleted'));
    await complete();
  };
  return { first, resumed, invoke, requests, pending, bridgeArgs, response, submit, complete, durable, cleanup, assignments, nodeId, runId };
}

export default [
  ...['navigation', 'new-window'].map(cause => ({
    name: `non-API AI adoption: ${cause} resume retains one push claim and settles both callers once`,
    run: async () => {
      const f = fixture();
      try {
        const oldCall = f.invoke(f.first);
        const original = await until(() => f.requests(f.first)[0]);
        const windows = new Map([[f.first.id, { __canvasFilePath: '/tmp/adoption.canvas' }]]);
        const push = createPushSource({ codeGuard: createHandoffCodeGuard(), hubKey: () => 'e'.repeat(64), windows, graceMs: 0, pollMs: 0 });
        assert(push.selectHub({ windowId: f.first.id, canvasFilePath: '/tmp/adoption.canvas', nodeId: f.nodeId }));
        const served = await push.get({ epoch: 'adopt', worker: 'worker-1' });
        assert.equal(served.status, 'served');
        let display = f.first;
        if (cause === 'new-window') {
          f.first.isDestroyed = () => true;
          f.first.emit('destroyed');
          windows.delete(f.first.id);
          display = f.resumed;
        } else {
          f.first.emit('did-start-navigation', {}, 'file:///canvas/index.html', false, true);
          f.first.emit('dom-ready');
        }
        const newCall = f.invoke(display, 1);
        await until(() => f.requests(display).some((request, index) => (display !== f.first || index > 0) && request.requestId === original.requestId));
        assert.equal(f.pending().length, 1);
        assert(f.requests(display).every(request => request.requestId === original.requestId && request.handoffCode === original.handoffCode));
        assert.deepEqual(f.assignments.slice(0, 2), [1, 1], 'adopting an assigned record immediately starts the new caller response deadline');
        const other = await push.get({ epoch: 'adopt', worker: 'worker-2' });
        assert.equal(other.status, 'waiting', 'a second worker cannot serve the adopted step');
        const accepted = await push.submit({ epoch: 'adopt', worker: 'worker-1', handoffCode: original.handoffCode, response: f.response(original) });
        assert.equal(accepted.status, 'accepted', 'the original worker can deliver its late answer after adoption');
        const [oldResult, newResult] = await Promise.all([oldCall, newCall]);
        assert.equal(oldResult.success, true);
        assert.deepEqual(oldResult, newResult);
        assert.equal(f.pending().length, 0);
        assert.equal((await f.submit(original, 'must never overwrite')).outcome, 'not_pending');
        assert.equal(f.durable().steps[original.stepKey].response, f.response(original));
        const replayed = await f.invoke(display, 2);
        assert.deepEqual(replayed, oldResult, 'later resume consumes the one accepted durable answer');
      } finally { await f.cleanup(); }
    },
  })),
  {
    name: 'non-API AI adoption: simultaneous callers join before initial durable admission completes',
    run: async () => {
      const f = fixture();
      const originalWrite = fs.promises.writeFile;
      let release, started;
      const gate = new Promise(resolve => { release = resolve; });
      const entered = new Promise(resolve => { started = resolve; });
      fs.promises.writeFile = async (...args) => {
        if (String(args[0]).includes('non-api-ai-handoffs.json')) { started(); await gate; }
        return originalWrite(...args);
      };
      try {
        const oldCall = f.invoke(f.first);
        await entered;
        const newCall = f.invoke(f.resumed, 1);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(f.requests(f.first).length + f.requests(f.resumed).length, 0);
        release();
        const request = await until(() => f.requests(f.resumed)[0]);
        assert.equal(f.pending().length, 1);
        assert.equal(f.requests(f.first)[0].requestId, request.requestId);
        assert(markBridgeableNonApiAiHandoffAssigned(f.bridgeArgs(request)));
        assert(markBridgeableNonApiAiHandoffAssigned(f.bridgeArgs(request)));
        assert.deepEqual(f.assignments.slice(0, 2), [1, 1], 'assignment notifies both waiting callers exactly once');
        assert.equal((await f.submit(request)).outcome, 'accepted');
        assert.deepEqual(await oldCall, await newCall);
      } finally {
        release();
        fs.promises.writeFile = originalWrite;
        await f.cleanup();
      }
    },
  },
  {
    name: 'non-API AI adoption: resume during acceptance shares the commit and rejects duplicate late answers',
    run: async () => {
      const f = fixture();
      const oldCall = f.invoke(f.first);
      const request = await until(() => f.requests(f.first)[0]);
      const originalWrite = fs.promises.writeFile;
      let release, started;
      const gate = new Promise(resolve => { release = resolve; });
      const entered = new Promise(resolve => { started = resolve; });
      fs.promises.writeFile = async (...args) => {
        if (String(args[0]).includes('non-api-ai-handoffs.json')) { started(); await gate; }
        return originalWrite(...args);
      };
      try {
        const saving = f.submit(request);
        await entered;
        const newCall = f.invoke(f.resumed, 1);
        await until(() => f.requests(f.resumed)[0]);
        assert.equal(f.requests(f.resumed)[0].requestId, request.requestId);
        assert.equal((await f.submit(request, 'racing answer')).outcome, 'busy');
        release();
        assert.equal((await saving).outcome, 'accepted');
        assert.deepEqual(await oldCall, await newCall);
        assert.equal((await f.submit(request, 'late answer')).outcome, 'not_pending');
        assert.equal(f.durable().steps[request.stepKey].response, f.response(request));
      } finally {
        release();
        fs.promises.writeFile = originalWrite;
        await f.cleanup();
      }
    },
  },
  ...['node-deleted', 'cancel-button'].map(cause => ({
    name: `non-API AI adoption: new-window ${cause} cancels surviving work and every attached caller`,
    run: async () => {
      const f = fixture();
      try {
        const oldCall = f.invoke(f.first);
        const request = await until(() => f.requests(f.first)[0]);
        f.first.isDestroyed = () => true;
        f.first.emit('destroyed');
        let newCall;
        if (cause === 'cancel-button') {
          newCall = f.invoke(f.resumed, 1);
          await until(() => f.requests(f.resumed)[0]);
          const cancelled = await ipcMain.__getInvokeHandler('cancel-non-api-ai-request')({ sender: f.resumed }, { requestId: request.requestId });
          assert.equal(cancelled.cancelled, true);
          assert.deepEqual(cancelled.manualAiRunIds, [f.runId]);
        } else {
          await abortNodeTasksAndWait(f.nodeId, f.resumed, nodeCancellationError('Node deleted'));
        }
        assert.equal((await oldCall).success, false);
        if (newCall) assert.equal((await newCall).success, false);
        assert.equal(f.pending().length, 0);
        assert.equal((await f.submit(request)).outcome, 'not_pending');
      } finally { await f.cleanup(); }
    },
  })),
];
