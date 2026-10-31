import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import electronPkg from 'electron';
import { handleSafe } from '../../electron/ipc/ipcUtils.js';
import { buildOfficialPostingJudgeRequest } from '../../electron/ipc/officialPostingJudge.js';
import {
  __reloadDurableStateForTests, flushNonApiAiPersistence, listBridgeableNonApiAiHandoffs,
  readBridgeableNonApiAiHandoff, registerNonApiAiHandlers, requestNonApiAi,
  requeueBridgeableNonApiAiHandoff, submitNonApiAiResponseForBridge,
} from '../../electron/ipc/nonApiAi.js';

const { app, ipcMain } = electronPkg;
const TASK = 'job-official-posting-match';
const allowTasks = new Set([TASK]);
let sequence = 0;
async function until(read) {
  for (let turn = 0; turn < 300; turn++) {
    const value = read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Synthetic cross-run handoff fixture timed out');
}

function fixture() {
  ipcMain.__clearInvokeHandlers();
  registerNonApiAiHandlers();
  const id = ++sequence;
  const nodeId = `official-cross-run-node-${id}`;
  const oldRun = `official-cross-run-old-${process.pid}-${Date.now()}-${id}`;
  const newRun = `${oldRun}-new`;
  const sender = new EventEmitter();
  sender.id = 9600 + id;
  sender.isDestroyed = () => false;
  const sent = []; const attempted = []; const controllers = []; const owners = [];
  let failDelivery = false;
  sender.send = (channel, payload) => {
    if (channel === 'non-api-ai-request') {
      attempted.push(payload);
      if (failDelivery) throw new Error('Synthetic initial dock delivery unavailable');
    }
    sent.push({ channel, payload });
  };
  const requests = ['Synthetic Chime', 'Synthetic EA SPORTS', 'Synthetic Watershed', 'Synthetic Engineered Arts'].map((company, slot) =>
    buildOfficialPostingJudgeRequest({ job: { title: 'Software Engineer', company,
      url: `https://listing.example.test/jobs/${slot}`, snippet: `Build systems for ${company}.` },
    leads: [{ id: 'P1', url: `https://careers.example.test/jobs/${slot}`, kind: 'posting' }], run: 'A' }));
  const channel = `official-cross-run-${id}`;
  handleSafe(channel, async (_event, args, signal) => {
    const request = requests[args.slot];
    const controller = new AbortController();
    controllers.push(controller);
    try {
      return { answer: await requestNonApiAi({ ...request, ...request.manualHandoff,
        itemCount: 1, signal: AbortSignal.any([signal, controller.signal]) }) };
    } catch (error) { return { failureCode: error.code || 'UNKNOWN' }; }
  });
  const invoke = (runId, slot) => {
    const owner = ipcMain.__getInvokeHandler(channel)({ sender }, { nodeId, manualAiRunId: runId, slot });
    owners.push(owner);
    return owner;
  };
  const args = request => ({ requestId: request.requestId, handoffCode: request.handoffCode, allowTasks });
  const read = (request, slot) => readBridgeableNonApiAiHandoff({ ...args(request), comparisonProvenance: {
    version: 2, transport: 'bridge', observed: true, comparisonGroup: requests[slot].manualHandoff.comparisonGroup,
    comparisonRun: 'A', conversationKey: '4'.repeat(64), isolated: false,
  } });
  const submit = (request, valid = true) => submitNonApiAiResponseForBridge({ ...args(request), response: JSON.stringify(valid ? {
    handoffCode: request.handoffCode, choice: 'uncertain', postingUrl: '', status: 'unknown', statusQuote: '',
    employerLinked: false, employerPageUrl: '', employerLinkQuote: '', title: '', employer: '', location: '',
    salary: '', description: '', evidence: [], conflicts: ['Synthetic page unavailable.'],
  } : { handoffCode: request.handoffCode, choice: 'invalid' }) });
  const pending = runId => listBridgeableNonApiAiHandoffs({ allowTasks }).handoffs.filter(item => item.nodeId === nodeId && item.runId === runId);
  const file = path.join(app.getPath('userData'), 'non-api-ai-handoffs.json');
  const disk = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const cleanup = async () => {
    controllers.forEach(controller => controller.abort(new Error('Synthetic fixture cleanup')));
    await Promise.allSettled(owners);
    for (const runId of [oldRun, newRun]) await ipcMain.__getInvokeHandler('complete-non-api-ai-run')({ sender }, { runId });
  };
  return { oldRun, newRun, sender, requests, sent, attempted, controllers, invoke, args, read, submit, pending,
    file, disk, cleanup, failDelivery: value => { failDelivery = value; } };
}

export default [
  {
    name: 'official posting cross-run: failed, aborted and legacy durable state cannot reroute a new simultaneous judge batch',
    async run() {
      const f = fixture();
      try {
        const oldRequests = [];
        for (let slot = 0; slot < f.requests.length; slot++) {
          const before = f.attempted.length;
          const owner = f.invoke(f.oldRun, slot);
          const request = await until(() => f.attempted[before]);
          oldRequests.push(request);
          assert(f.read(request, slot).ok);
          if (slot < 2) {
            assert.equal((await f.submit(request, false)).outcome, 'rejected');
            if (slot === 0) {
              assert.equal((await f.submit(request, false)).outcome, 'not_pending');
              assert.equal((await owner).failureCode, 'OFFICIAL_POSTING_COMPARATIVE_INVALID');
            } else {
              f.controllers.at(-1).abort(Object.assign(new Error('Synthetic prior run aborted'), { code: 'bridge-aborted' }));
              assert.equal((await owner).failureCode, 'bridge-aborted');
            }
          } else if (slot === 2) {
            for (let attempt = 0; attempt < 3; attempt++) assert(requeueBridgeableNonApiAiHandoff({ ...f.args(request), reason: 'worker-lost' }));
            assert.equal((await owner).failureCode, 'BRIDGE_REQUEUE_EXHAUSTED');
          } else {
            f.controllers.at(-1).abort(Object.assign(new Error('Synthetic prior run stopped'), { code: 'bridge-aborted' }));
            assert.equal((await owner).failureCode, 'bridge-aborted');
          }
        }
        await flushNonApiAiPersistence();
        const saved = f.disk();
        assert.equal(saved.runs[f.oldRun].steps[oldRequests[0].stepKey].status, 'failed');
        assert.equal(saved.runs[f.oldRun].steps[oldRequests[1].stepKey].comparisonInvalidCount, 1);
        assert.equal(saved.runs[f.oldRun].steps[oldRequests[1].stepKey].status, 'pending');
        // Simulate a legacy failed run with every suspected piece of transport
        // state. Even a matching row/prompt/step key must stay under its run id.
        Object.assign(saved.runs[f.oldRun].steps[oldRequests[3].stepKey], {
          draft: 'Synthetic stale manual draft', bridgeEscalation: 'worker_restart_cap',
          comparisonGroup: 'f'.repeat(64), comparisonInvalidCount: 2,
          comparisonProof: { version: 1, transport: 'manual' },
          validationCorrectionDetails: ['Synthetic obsolete correction'],
          retryRejectionCount: 8, retryNotBefore: Date.now() + 60_000,
        });
        await __reloadDurableStateForTests();
        fs.writeFileSync(f.file, JSON.stringify(saved));
        const priorRun = JSON.stringify(saved.runs[f.oldRun]);
        f.failDelivery(true);
        const owners = f.requests.map((_, slot) => f.invoke(f.newRun, slot));
        await until(() => f.attempted.filter(item => item.runId === f.newRun).length === owners.length);
        const current = f.attempted.filter(item => item.runId === f.newRun);
        assert.equal(f.pending(f.newRun).length, owners.length, 'all first presentations may fail together while the MCP batch remains pending');
        assert(current.every(item => item.mcpEligible && item.initialResponse === '' && item.bridgeEscalation === null && !item.isCorrection));
        assert.deepEqual(current.map(item => item.stepKey).sort(), oldRequests.map(item => item.stepKey).sort(), 'identical logical steps stay isolated by the new run id');
        for (const request of current) {
          const slot = oldRequests.findIndex(item => item.stepKey === request.stepKey);
          assert(f.read(request, slot).ok, 'fresh provenance, without the earlier run proof or pacing');
          assert.equal((await f.submit(request)).outcome, 'accepted');
        }
        assert((await Promise.all(owners)).every(result => result.answer?.choice === 'uncertain'));
        assert.equal(JSON.stringify(f.disk().runs[f.oldRun]), priorRun, 'issuing and accepting a new run does not adopt or mutate its predecessor');
      } finally { await f.cleanup(); }
    },
  },
  {
    name: 'official posting cross-run: live adoption and requeue remain in their own run during failed presentation',
    async run() {
      const f = fixture();
      try {
        const originalOwner = f.invoke(f.oldRun, 0);
        const original = await until(() => f.attempted[0]);
        assert(f.read(original, 0).ok);
        assert(requeueBridgeableNonApiAiHandoff({ ...f.args(original), reason: 'worker-replaced' }));
        f.failDelivery(true);
        const adoptedOwner = f.invoke(f.oldRun, 0);
        const newOwner = f.invoke(f.newRun, 0);
        await until(() => f.attempted.filter(item => item.requestId === original.requestId).length >= 2 && f.attempted.some(item => item.runId === f.newRun));
        const current = f.attempted.find(item => item.runId === f.newRun);
        assert.notEqual(current.requestId, original.requestId);
        assert.notEqual(current.handoffCode, original.handoffCode, 'the new run has independent worker authorization while its predecessor is live');
        assert.equal(current.stepKey, original.stepKey);
        assert.equal(f.pending(f.oldRun).length, 1, 'same-run adoption joins the requeued record');
        assert.equal(f.pending(f.newRun).length, 1, 'a different run does not adopt the old record');
        for (const request of [current, original]) {
          assert(f.read(request, 0).ok);
          assert.equal((await f.submit(request)).outcome, 'accepted');
        }
        const [oldResult, adoptedResult, newResult] = await Promise.all([originalOwner, adoptedOwner, newOwner]);
        assert.deepEqual(oldResult, adoptedResult);
        assert.equal(newResult.answer.choice, 'uncertain');
      } finally { await f.cleanup(); }
    },
  },
];
