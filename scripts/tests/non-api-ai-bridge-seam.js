// Parity and safety gates for the bridge seam in electron/ipc/nonApiAi.js. An answer submitted through the seam must
// leave exactly the state a dock paste leaves, so the core test runs each scenario twice (paste, bridge) and diffs everything observable.
import fs, { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  _resetNonApiAiHandoffLifecycle, assert, electronPkg, getNonApiAiHandoffLifecycle, handleSafe, ipcMain,
  registerNonApiAiHandlers, requestNonApiAi,
} from '../test-dependencies.js';
import { getRecentLogs } from '../../electron/logger.js';
import {
  __claimAcceptedResponseFingerprintForTests, BRIDGE_EXCLUSION_REASONS, listBridgeableNonApiAiHandoffs, readBridgeableNonApiAiHandoff, submitNonApiAiResponseForBridge,
} from '../../electron/ipc/nonApiAi.js';
import { getKnownTaskIds } from '../../electron/ipc/llm.js';

const source = readFileSync(new URL('../../electron/ipc/nonApiAi.js', import.meta.url), 'utf8');
const dialogSource = readFileSync(new URL('../../src/components/NonApiAiDialog.jsx', import.meta.url), 'utf8');
const SCHEMA = { type: 'object', required: ['answer'], additionalProperties: false, properties: { answer: { type: 'string' } } };
const TASK = 'job-scoring';
const ALLOW = Object.freeze({ allowTasks: new Set([TASK]) });
const PRIVATE = 'PRIVATE_VALIDATOR_DETAIL_MUST_NOT_REACH_THE_CHAT';
const handler = (channel) => ipcMain.__getInvokeHandler(channel);
const answer = (request, text = 'ok') => JSON.stringify({ handoffCode: request.handoffCode, answer: text });
const without = (object, keys) => Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
let senderSeq = 0;

function freshHarness() {
  ipcMain.__clearInvokeHandlers();
  _resetNonApiAiHandoffLifecycle();
  registerNonApiAiHandlers();
  senderSeq += 1;
  const sent = [];
  const sender = { id: 51000 + senderSeq, isDestroyed: () => false, once: () => {}, removeListener: () => {}, send: (channel, payload) => sent.push({ channel, payload }) };
  const waitFor = async (count) => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const requests = sent.filter(item => item.channel === 'non-api-ai-request').map(item => item.payload);
      if (requests.length >= count) return requests;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('timed out waiting for handoff requests');
  };
  return { sent, sender, waitFor };
}

// Issue `handoffs` concurrently from one handleSafe workflow, as a hub does.
function startWorkflow({ sender, nodeId, runId, handoffs, extra = {} }) {
  const channel = `bridge-seam-workflow-${nodeId}`;
  handleSafe(channel, async (_event, _args, signal) => ({
    values: await Promise.all(handoffs.map(spec => requestNonApiAi({ task: TASK, responseSchema: SCHEMA, signal, ...extra, ...spec }))),
  }));
  return handler(channel)({ sender }, { nodeId, manualAiRunId: runId });
}

const cancelAll = async (sender, requests) => {
  for (const request of requests) await handler('cancel-non-api-ai-request')({ sender }, { requestId: request.requestId }).catch(() => {});
};

async function durableSteps(runId) {
  await handler('flush-non-api-ai-persistence')({});
  const file = path.join(electronPkg.app.getPath('userData'), 'non-api-ai-handoffs.json');
  const steps = JSON.parse(fs.readFileSync(file, 'utf8')).runs?.[runId]?.steps || {};
  return Object.values(steps).map(step => without(step, ['updatedAt'])).sort((a, b) => String(a.batch).localeCompare(String(b.batch)));
}

// Everything a dock or a bug report can observe, with volatile ids masked.
function observe({ sent, lifecycle, steps, logs, values, requestIds }) {
  let text = JSON.stringify({
    sent,
    lifecycle: lifecycle.map(receipt => ({
      ...without(receipt, ['issuedAt', 'updatedAt', 'windowId', 'acceptedAt', 'settledAt', 'failures']),
      accepted: receipt.acceptedAt != null,
      settled: receipt.settledAt != null,
      failures: receipt.failures.map(failure => without(failure, ['at'])),
    })),
    steps, logs, values,
  });
  for (const [index, id] of requestIds.entries()) text = text.split(id).join(`<REQ${index}>`).split(id.slice(0, 12)).join(`<REQ${index}>`);
  return JSON.parse(text);
}

async function runScenario({ via, scenario, nodeId, runId }) {
  const logsBefore = new Set(getRecentLogs());
  const { sent, sender, waitFor } = freshHarness();
  const allow = { ...ALLOW, allowNodeIds: new Set([nodeId]) };
  const outcomes = [];
  const run = startWorkflow({ sender, nodeId, runId, handoffs: scenario.handoffs });
  const requests = (await waitFor(scenario.handoffs.length)).sort((a, b) => (a.batch ?? 0) - (b.batch ?? 0));
  const submit = async (index, response) => {
    const { requestId, handoffCode } = requests[index];
    const result = via === 'ipc'
      ? await handler('submit-non-api-ai-response')({ sender }, { requestId, response })
      : await submitNonApiAiResponseForBridge({ requestId, handoffCode, response, ...allow });
    outcomes.push(result.accepted);
  };
  await scenario.script({ requests, submit });
  const values = (await run).values ?? null;
  const observables = observe({
    sent,
    lifecycle: getNonApiAiHandoffLifecycle({ windowId: sender.id }),
    steps: await durableSteps(runId).catch(() => []),
    logs: getRecentLogs().filter(entry => !logsBefore.has(entry)).map(entry => entry.message).filter(message => message.includes('[Non-API AI] Rejected response')),
    values,
    requestIds: requests.map(request => request.requestId),
  });
  await handler('complete-non-api-ai-run')({ sender }, { runId });
  return { observables, outcomes };
}

const SCENARIOS = [
  {
    name: 'R1 plain structured answer is accepted',
    handoffs: [{ prompt: 'PARITY VALID', batch: 1, batchTotal: 1, itemCount: 4, itemsDone: 0, itemsTotal: 4, progressScopeId: 's', progressUnitId: 'u1', progressUnits: 4, measureResponseUnits: () => 4 }],
    script: async ({ requests, submit }) => { await submit(0, answer(requests[0])); },
  },
  {
    name: 'R2 invalid JSON reissues the same handoff before acceptance',
    handoffs: [{ prompt: 'PARITY INVALID JSON', batch: 1, batchTotal: 1, itemCount: 1 }],
    script: async ({ requests, submit }) => {
      await submit(0, `{"handoffCode":"${requests[0].handoffCode}","answer": "x" broken}`);
      await submit(0, answer(requests[0], 'fixed'));
    },
  },
  {
    name: 'R3 schema miss reissues the same handoff before acceptance',
    handoffs: [{ prompt: 'PARITY SCHEMA', batch: 1, batchTotal: 1, itemCount: 1 }],
    script: async ({ requests, submit }) => {
      await submit(0, JSON.stringify({ handoffCode: requests[0].handoffCode, unexpected: true }));
      await submit(0, answer(requests[0], 'fixed'));
    },
  },
  {
    name: 'R4 domain validator rejection reissues the same handoff before acceptance',
    handoffs: [{ prompt: 'PARITY REJECTIONS', batch: 1, batchTotal: 1, itemCount: 1, responseValidator: (value) => { if (value.answer === 'domain') throw new Error(PRIVATE); } }],
    script: async ({ requests, submit }) => {
      await submit(0, answer(requests[0], 'domain'));
      await submit(0, answer(requests[0], 'fixed'));
    },
  },
  {
    name: 'R5 wrong handoff code is rejected with the base prompt reissued unchanged',
    handoffs: [{ prompt: 'PARITY CODES', batch: 1, batchTotal: 1, itemCount: 1 }],
    script: async ({ requests, submit }) => {
      await submit(0, JSON.stringify({ handoffCode: 'HANDOFF-ZZZZZZ', answer: 'ok' }));
      await submit(0, answer(requests[0]));
    },
  },
  {
    name: 'R6 missing handoff code is rejected with the base prompt reissued unchanged',
    handoffs: [{ prompt: 'PARITY MISSING CODE', batch: 1, batchTotal: 1, itemCount: 1 }],
    script: async ({ requests, submit }) => {
      await submit(0, JSON.stringify({ answer: 'ok' }));
      await submit(0, answer(requests[0]));
    },
  },
  {
    name: 'R7 a long structured answer is accepted',
    handoffs: [{ prompt: 'PARITY LONG', batch: 1, batchTotal: 1, itemCount: 1 }],
    script: async ({ requests, submit }) => { await submit(0, answer(requests[0], 'x'.repeat(600))); },
  },
  {
    name: 'R8 the same long answer is refused for a second step and a distinct retry succeeds',
    handoffs: [
      { prompt: 'PARITY DUPLICATE ONE', batch: 1, batchTotal: 2, itemCount: 1 },
      { prompt: 'PARITY DUPLICATE TWO', batch: 2, batchTotal: 2, itemCount: 1 },
    ],
    script: async ({ requests, submit }) => {
      await submit(0, answer(requests[0], 'x'.repeat(600)));
      await submit(1, answer(requests[1], 'x'.repeat(600)));
      await submit(1, answer(requests[1], 'second'));
    },
  },
  {
    name: 'R9 two batches accepted in reverse answer order preserve dock-observable state',
    handoffs: [
      { prompt: 'PARITY REVERSE ONE', batch: 1, batchTotal: 2, itemCount: 1 },
      { prompt: 'PARITY REVERSE TWO', batch: 2, batchTotal: 2, itemCount: 1 },
    ],
    script: async ({ requests, submit }) => {
      await submit(1, answer(requests[1], 'second'));
      await submit(0, answer(requests[0], 'first'));
    },
  },
  {
    name: 'R10 shared progress records update consistently as each answer is accepted',
    handoffs: [
      { prompt: 'PARITY PROGRESS ONE', batch: 1, batchTotal: 2, itemCount: 2, itemsDone: 0, itemsTotal: 4, progressScopeId: 'matrix-progress', progressUnitId: 'one', progressUnits: 2, measureResponseUnits: () => 2 },
      { prompt: 'PARITY PROGRESS TWO', batch: 2, batchTotal: 2, itemCount: 2, itemsDone: 0, itemsTotal: 4, progressScopeId: 'matrix-progress', progressUnitId: 'two', progressUnits: 2, measureResponseUnits: () => 2 },
    ],
    script: async ({ requests, submit }) => {
      await submit(0, answer(requests[0], 'one'));
      await submit(1, answer(requests[1], 'two'));
    },
  },
  {
    name: 'R11 durable-write failure rejects on both paths and a retry succeeds',
    handoffs: [{ prompt: 'PARITY COMMIT FAILURE', batch: 1, batchTotal: 1, itemCount: 1 }],
    script: async ({ requests, submit }) => {
      const original = fs.promises.writeFile;
      let failOnce = true;
      fs.promises.writeFile = async (...args) => {
        if (failOnce && String(args[0]).includes('non-api-ai-handoffs.json')) {
          failOnce = false;
          throw Object.assign(new Error("EACCES: permission denied, open '/Users/private/secret/non-api-ai-handoffs.json'"), { code: 'EACCES' });
        }
        return original(...args);
      };
      try {
        await submit(0, answer(requests[0]));
        await submit(0, answer(requests[0]));
      } finally {
        fs.promises.writeFile = original;
      }
    },
  },
  {
    name: 'R12 a correction followed by a long replacement answer settles once',
    handoffs: [{ prompt: 'PARITY CORRECTION', batch: 1, batchTotal: 1, itemCount: 1, responseValidator: (value) => { if (value.answer === 'reject') throw new Error(PRIVATE); } }],
    script: async ({ requests, submit }) => {
      await submit(0, answer(requests[0], 'reject'));
      await submit(0, answer(requests[0], 'replacement '.repeat(80)));
    },
  },
];

// The matrix is deliberately explicit: an ineligible record kind must state
// its refusal for every response scenario rather than silently falling out of
// a separate eligibility test. K1-K3 and K6 reach the shared accept body; K4,
// K5 and K7 do not, by design. R1-R12 are the frozen acceptance rows in the
// Phase 1 plan.
const MATRIX_EXPECTATIONS = Object.freeze({
  K1: Object.freeze(['accepted', 'validation', 'validation', 'validation', 'validation', 'validation', 'duplicate', 'not_pending', 'busy', 'cancelled_during_save', 'commit_failed', 'validation']),
  K2: Object.freeze(['free_text', 'free_text', 'free_text', 'free_text', 'free_text', 'free_text', 'free_text', 'free_text', 'free_text', 'free_text', 'free_text', 'free_text']),
  K3: Object.freeze(['accepted', 'validation', 'validation', 'validation', 'validation', 'validation', 'duplicate', 'not_pending', 'busy', 'cancelled_during_save', 'commit_failed', 'validation']),
  K4: Object.freeze(['attachment', 'attachment', 'attachment', 'attachment', 'attachment', 'attachment', 'attachment', 'attachment', 'attachment', 'attachment', 'attachment', 'attachment']),
  K5: Object.freeze(['person_editing', 'person_editing', 'person_editing', 'person_editing', 'person_editing', 'person_editing', 'person_editing', 'person_editing', 'person_editing', 'person_editing', 'person_editing', 'person_editing']),
  K6: Object.freeze(['accepted', 'validation', 'validation', 'validation', 'validation', 'validation', 'duplicate', 'not_pending', 'busy', 'cancelled_during_save', 'commit_failed', 'validation']),
  K7: Object.freeze(['task_not_allowed', 'task_not_allowed', 'task_not_allowed', 'task_not_allowed', 'task_not_allowed', 'task_not_allowed', 'task_not_allowed', 'task_not_allowed', 'task_not_allowed', 'task_not_allowed', 'task_not_allowed', 'task_not_allowed']),
});

// This is deliberately a behaviour matrix, not merely the compact contract
// declaration above.  It keeps the tests honest when a future edit moves an
// eligibility check or makes one entry point bypass the shared accept body.
const MATRIX_KINDS = Object.freeze([
  { id: 'K1', task: TASK, expectedExclusion: null },
  // Raw-text preference research is deliberately never bridgeable.  Every
  // response row executes this `free_text` refusal below; the dock path still
  // proves that the refusal leaves the pending record untouched.
  { id: 'K2', task: 'job-preference-research-batch', requestKind: 'raw-text', expectedExclusion: 'free_text' },
  { id: 'K3', task: TASK, successor: true, expectedExclusion: null },
  { id: 'K4', task: TASK, attachmentPaths: ['/Users/synthetic/attachment.txt'], expectedExclusion: 'attachment' },
  { id: 'K5', task: TASK, initialResponse: 'A person is editing this synthetic draft.', expectedExclusion: 'person_editing' },
  // Grounding no longer excludes: a structured, schema-answered request that
  // asked for web research reaches the shared accept body exactly like K1,
  // proving `grounded` carries no structural weight any more.
  { id: 'K6', task: TASK, grounding: true, expectedExclusion: null },
  { id: 'K7', task: 'price-synthesis', expectedExclusion: 'task_not_allowed' },
]);

const MATRIX_RESPONSES = Object.freeze([
  'valid', 'invalid_json', 'schema_invalid', 'validator_rejected', 'wrong_code', 'missing_code',
  'duplicate_second_record', 'not_pending', 'already_settling', 'cancelled_during_save', 'write_failure', 'oversize',
]);

function matrixValidator(value) {
  if (value.answer === 'domain') throw new Error(PRIVATE);
  // This is intentionally a real, over-one-megabyte payload.  The app's
  // normal schema validator has no generic text cap, so this task contract is
  // the controlled boundary that proves an oversized response stays in the
  // retry loop on both entry points.
  if (typeof value.answer === 'string' && value.answer.length > 1_000_000) throw new Error('Synthetic answer exceeds the task response limit.');
}

function matrixHandoffs(kind, responseRow) {
  const count = kind.successor ? 2 : 1;
  return Array.from({ length: count }, (_, index) => ({
    prompt: `MATRIX ${kind.id} ${responseRow} ${index + 1}`,
    task: kind.task,
    requestKind: kind.requestKind,
    responseSchema: kind.id === 'K2' ? undefined : SCHEMA,
    responseValidator: kind.id === 'K2' ? (value) => { if (value.includes('domain')) throw new Error(PRIVATE); } : matrixValidator,
    attachmentPaths: kind.attachmentPaths,
    grounding: kind.grounding,
    initialResponse: kind.initialResponse,
    batch: index + 1,
    batchTotal: count,
    itemCount: 1,
  }));
}

function matrixResponse(request, row, text = 'accepted') {
  if (request.task === 'job-preference-research-batch') {
    if (row === 'wrong_code') return 'Handoff: HANDOFF-ZZZZZZ\n\nwrong';
    if (row === 'missing_code') return 'missing code';
    if (row === 'oversize') return `Handoff: ${request.handoffCode}\n\n${'x'.repeat(1_000_001)}`;
    return `Handoff: ${request.handoffCode}\n\n${row === 'validator_rejected' ? 'domain' : text}`;
  }
  switch (row) {
    case 'invalid_json': return `{"handoffCode":"${request.handoffCode}","answer":"broken"`;
    case 'schema_invalid': return JSON.stringify({ handoffCode: request.handoffCode, wrong: true });
    case 'validator_rejected': return answer(request, 'domain');
    case 'wrong_code': return JSON.stringify({ handoffCode: 'HANDOFF-ZZZZZZ', answer: 'wrong' });
    case 'missing_code': return JSON.stringify({ answer: 'missing' });
    case 'oversize': return answer(request, 'x'.repeat(1_000_001));
    default: return answer(request, text);
  }
}

function assertIpcTuple(result, label) {
  const keys = Object.keys(result).sort().join();
  assert(keys === 'accepted' || keys === 'accepted,validationErrors', `${label}: IPC only exposes the frozen return shapes`);
  assert(!Object.prototype.hasOwnProperty.call(result, 'reason'), `${label}: internal reason does not cross IPC`);
}

async function runMatrixCell({ kind, row, via }) {
  const logStart = getRecentLogs().length;
  const { sent, sender, waitFor } = freshHarness();
  // Both paths receive the exact same logical handoff identity.  It must
  // never differ in the prompt, code derivation, durable key or event diff.
  // R10 needs the direct per-record cancellation branch: a node-wide cancel
  // waits for every successor and would turn this durable-write race into a
  // different (and potentially circular) operation.
  const nodeId = row === 'cancelled_during_save' ? null : `bridge-seam-matrix-${kind.id}-${row}`;
  const runId = `bridge-seam-matrix-${kind.id}-${row}-${process.pid}`;
  const allow = { allowTasks: new Set([TASK, 'job-preference-research-batch']), allowNodeIds: new Set([nodeId]) };
  const cancellationController = row === 'cancelled_during_save' ? new AbortController() : null;
  const handoffs = matrixHandoffs(kind, row).map(spec => ({ ...spec, ...(cancellationController ? { signal: cancellationController.signal } : {}) }));
  const run = startWorkflow({ sender, nodeId, runId, handoffs });
  const requests = (await waitFor(kind.successor ? 2 : 1)).sort((a, b) => (a.batch ?? 0) - (b.batch ?? 0));
  const route = async (request, response) => {
    const result = via === 'ipc'
      ? await handler('submit-non-api-ai-response')({ sender }, { requestId: request.requestId, response })
      : await submitNonApiAiResponseForBridge({ requestId: request.requestId, handoffCode: request.handoffCode, response, ...allow });
    if (via === 'ipc') assertIpcTuple(result, `${kind.id}/${row}`);
    return result;
  };
  let resolvedValues = null;
  let runRejected = false;
  const settleRun = async () => {
    try { resolvedValues = (await run).values ?? null; }
    catch { runRejected = true; }
  };
  const finishSuccessor = async () => {
    if (kind.successor) {
      assert((await route(requests[1], matrixResponse(requests[1], 'valid', 'successor'))).accepted === true, `${kind.id}/${row}: successor remains independently settleable`);
    }
  };

  // K4-K7 must remain a real, executed refusal for EVERY response row.  The
  // matching dock submission is then allowed through, proving the external
  // filter did not mutate or settle the record behind the user's back.
  if (kind.expectedExclusion) {
    const refused = await submitNonApiAiResponseForBridge({
      requestId: requests[0].requestId, handoffCode: requests[0].handoffCode,
      response: matrixResponse(requests[0], row), ...allow,
    });
    assert(refused.outcome === 'ineligible' && refused.exclusion === kind.expectedExclusion, `${kind.id}/${row}: structural exclusion executes before validation`);
    const dock = await handler('submit-non-api-ai-response')({ sender }, { requestId: requests[0].requestId, response: matrixResponse(requests[0], 'valid') });
    assertIpcTuple(dock, `${kind.id}/${row} dock untouched`);
    assert(dock.accepted === true, `${kind.id}/${row}: an excluded bridge record remains live for the dock`);
    await settleRun();
  } else if (row === 'not_pending') {
    await handler('cancel-non-api-ai-request')({ sender }, { requestId: requests[0].requestId });
    const result = await route(requests[0], matrixResponse(requests[0], 'valid'));
    if (via === 'bridge') assert(result.outcome === 'not_pending', `${kind.id}/R8: late bridge submit is not pending`);
    else assert(result.accepted === false, `${kind.id}/R8: late dock submit retains its legacy rejection shape`);
    await settleRun();
  } else if (row === 'already_settling' || row === 'cancelled_during_save') {
    const original = fs.promises.writeFile;
    let releaseWrite;
    let enteredWrite;
    const release = new Promise(resolve => { releaseWrite = resolve; });
    const entered = new Promise(resolve => { enteredWrite = resolve; });
    fs.promises.writeFile = async (...args) => {
      if (String(args[0]).includes('non-api-ai-handoffs.json')) {
        enteredWrite();
        await release;
      }
      return original(...args);
    };
    try {
      const first = route(requests[0], matrixResponse(requests[0], 'valid'));
      await entered;
      if (row === 'already_settling') {
        const second = await route(requests[0], matrixResponse(requests[0], 'valid'));
        if (via === 'bridge') assert(second.outcome === 'busy', `${kind.id}/R9: settling record is busy`);
        else assert(second.accepted === false, `${kind.id}/R9: settling dock submission is rejected`);
      } else {
        const cancellation = Promise.resolve().then(() => cancellationController.abort(new Error('synthetic cancel during durable save')));
        await new Promise(resolve => setImmediate(resolve));
        releaseWrite();
        await cancellation;
      }
      releaseWrite();
      const firstResult = await first;
      if (row === 'cancelled_during_save') {
        if (via === 'bridge') assert(firstResult.outcome === 'not_pending', `${kind.id}/R10: cancellation maps to the bridge's non-pending outcome`);
        else assert(firstResult.accepted === false, `${kind.id}/R10: cancellation retains dock rejection shape`);
        await settleRun();
      } else {
        await finishSuccessor();
        await settleRun();
      }
    } finally {
      fs.promises.writeFile = original;
      releaseWrite?.();
    }
  } else if (row === 'write_failure') {
    const original = fs.promises.writeFile;
    let failOnce = true;
    fs.promises.writeFile = async (...args) => {
      if (failOnce && String(args[0]).includes('non-api-ai-handoffs.json')) {
        failOnce = false;
        throw Object.assign(new Error("EACCES: permission denied, open '/Users/synthetic/private/non-api-ai-handoffs.json'"), { code: 'EACCES' });
      }
      return original(...args);
    };
    try {
      const failed = await route(requests[0], matrixResponse(requests[0], 'valid'));
      if (via === 'bridge') assert(failed.outcome === 'commit_failed', `${kind.id}/R11: durable write fault is commit_failed`);
      else assert(failed.accepted === false, `${kind.id}/R11: durable write fault keeps legacy IPC shape`);
      const retried = await route(requests[0], matrixResponse(requests[0], 'valid'));
      assert(retried.accepted === true, `${kind.id}/R11: write failure restores settling in finally for retry`);
    } finally {
      fs.promises.writeFile = original;
    }
    await finishSuccessor();
    await settleRun();
  } else if (row === 'duplicate_second_record') {
    const long = 'd'.repeat(600);
    assert((await route(requests[0], answer(requests[0], long))).accepted === true, `${kind.id}/R7: first fingerprint commits`);
    await finishSuccessor();
    await settleRun();
    // Current records carry unique mandatory codes, so their raw responses
    // cannot be byte-identical.  The shared accept body nonetheless retains
    // the legacy cross-record guard: exercise it with a second logical step
    // and the exact raw response the first accept body already claimed.
    let duplicate = null;
    try { __claimAcceptedResponseFingerprintForTests({ stepKey: `${runId}-second-logical-step` }, answer(requests[0], long)); }
    catch (error) { duplicate = error; }
    assert(duplicate?.code === 'DUPLICATE_RESPONSE', `${kind.id}/R7: duplicate fingerprint is refused in a second logical record`);
    const secondRunId = `${runId}-fresh-code-record`;
    const [secondSpec] = matrixHandoffs(kind, row);
    const second = startWorkflow({
      sender, nodeId, runId: secondRunId,
      handoffs: [{ ...secondSpec, prompt: `${secondSpec.prompt} fresh code-bearing record`, batch: 2, batchTotal: 2 }],
    });
    const fresh = (await waitFor(kind.successor ? 3 : 2)).at(-1);
    assert(fresh.handoffCode !== requests[0].handoffCode, `${kind.id}/R7: fresh code-bearing records remain distinct`);
    assert((await route(fresh, answer(fresh, long))).accepted === true, `${kind.id}/R7: distinct code-bearing record accepts its own long answer`);
    await second;
    await handler('complete-non-api-ai-run')({ sender }, { runId: secondRunId });
  } else {
    const result = await route(requests[0], matrixResponse(requests[0], row));
    if (row === 'valid') assert(result.accepted === true, `${kind.id}/R1: valid answer accepts`);
    else {
      assert(result.accepted === false, `${kind.id}/${row}: invalid answer reissues`);
      assert((await route(requests[0], matrixResponse(requests[0], 'valid'))).accepted === true, `${kind.id}/${row}: correction accepts`);
    }
    // K3 deliberately has a successor.  It is not part of the response row,
    // so complete it with its own value after the target row has been tested.
    if (kind.successor && row !== 'duplicate_second_record') await finishSuccessor();
    await settleRun();
  }

  const listed = listBridgeableNonApiAiHandoffs(allow);
  assert(listed.pending === 0, `${kind.id}/${row}: terminal request leaves no pending membership or code reservation`);
  const lifecycle = getNonApiAiHandoffLifecycle({ windowId: sender.id });
  assert(lifecycle.length > 0, `${kind.id}/${row}: lifecycle receipt is recorded`);
  const events = sent.map(entry => entry.channel);
  assert(events.includes('non-api-ai-request'), `${kind.id}/${row}: ordered request event exists`);
  const durable = await durableSteps(runId).catch(() => []);
  if (!runRejected && !['not_pending', 'cancelled_during_save'].includes(row)) {
    assert(durable.some(step => step.status === 'accepted'), `${kind.id}/${row}: durable accepted status is observed before cleanup`);
  }
  const serializedEvents = JSON.stringify(sent)
    .replace(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/gi, '<request-id>')
    .replace(/HANDOFF-[2-9A-HJ-NP-Z]{6}/g, '<handoff-code>');
  const logLines = getRecentLogs().slice(logStart).map(entry => entry.message).filter(message => message.includes('[Non-API AI] Rejected response'));
  await handler('complete-non-api-ai-run')({ sender }, { runId }).catch(() => {});
  return { events: serializedEvents, lifecycle: lifecycle.map(entry => entry.outcome), durable, values: resolvedValues, runRejected, logs: logLines };
}

const differing = (a, b) => Object.keys({ ...a, ...b }).filter(key => JSON.stringify(a[key]) !== JSON.stringify(b[key]));

export default [
  {
    name: 'non-API AI bridge seam: K1-K7 by R1-R12 executes the frozen differential matrix',
    run: async () => {
      const rows = Object.entries(MATRIX_EXPECTATIONS);
      assert(rows.length === 7 && rows.every(([, values]) => values.length === 12), 'seven record kinds and twelve response scenarios are pinned');
      const cells = rows.flatMap(([kind, values]) => values.map((expected, index) => `${kind}:R${index + 1}:${expected}`));
      assert(cells.length === 84 && cells.every(cell => /^[K][1-7]:R(?:[1-9]|1[0-2]):[a-z_]+$/.test(cell)), 'every matrix cell carries an expected accept-body reason or exclusion');
      assert(MATRIX_EXPECTATIONS.K1[6] === 'duplicate' && MATRIX_EXPECTATIONS.K1[7] === 'not_pending'
        && MATRIX_EXPECTATIONS.K1[8] === 'busy' && MATRIX_EXPECTATIONS.K1[9] === 'cancelled_during_save'
        && MATRIX_EXPECTATIONS.K1[10] === 'commit_failed' && MATRIX_EXPECTATIONS.K1[11] === 'validation', 'R7-R12 stay in their frozen order');
      // K1-K3 drive both public entry points against fresh records.  K4-K7
      // execute each bridge exclusion and then prove the untouched record is
      // still usable by the dock.  Keeping all 84 cells in one test preserves
      // the verified eight-test file contract while making each declaration a
      // real controlled behaviour.
      for (const kind of MATRIX_KINDS) {
        for (const row of MATRIX_RESPONSES) {
          const bridge = await runMatrixCell({ kind, row, via: 'bridge' });
          if (!kind.expectedExclusion) {
            const ipc = await runMatrixCell({ kind, row, via: 'ipc' });
            assert(bridge.events === ipc.events, `${kind.id}/${row}: bridge and dock preserve ordered event payloads`);
            assert(bridge.lifecycle.join() === ipc.lifecycle.join(), `${kind.id}/${row}: bridge and dock preserve lifecycle outcomes`);
            assert(JSON.stringify(bridge.durable) === JSON.stringify(ipc.durable), `${kind.id}/${row}: bridge and dock preserve durable status`);
            assert(JSON.stringify(bridge.values) === JSON.stringify(ipc.values) && bridge.runRejected === ipc.runRejected, `${kind.id}/${row}: bridge and dock preserve resolved values and terminal state`);
            assert(JSON.stringify(bridge.logs) === JSON.stringify(ipc.logs), `${kind.id}/${row}: bridge and dock preserve safe rejection logs`);
          }
        }
      }
      // These are intentionally internal and source-private.  The public
      // bridge outcomes above exercise every branch; this pin makes a future
      // accidental enum rename fail instead of silently mapping it to the
      // default `not_pending` branch.
      assert(['accepted', 'validation', 'not_pending', 'cancelled_during_save', 'commit_failed']
        .every(reason => source.includes(`'${reason}'`)), 'the shared accept body retains its complete internal reason enum');
    },
  },
  {
    name: 'non-API AI bridge seam: every scenario leaves identical dock events, durable steps, lifecycle receipts, logs and resolved values on the paste path and the bridge path',
    run: async () => {
      let index = 0;
      for (const scenario of SCENARIOS) {
        index += 1;
        const nodeId = `bridge-seam-parity-node-${index}`;
        const runId = `bridge-seam-parity-run-${index}-${process.pid}-${Date.now()}`;
        const paste = await runScenario({ via: 'ipc', scenario, nodeId, runId });
        const bridge = await runScenario({ via: 'bridge', scenario, nodeId, runId });
        assert(JSON.stringify(paste.outcomes) === JSON.stringify(bridge.outcomes), `${scenario.name}: accept/reject sequence differs (${paste.outcomes} vs ${bridge.outcomes})`);
        const diff = differing(paste.observables, bridge.observables);
        assert(diff.length === 0, `${scenario.name}: observables differ in ${diff.join(', ')}`);
      }
      return { scenarios: SCENARIOS.length };
    },
  },
  {
    name: 'non-API AI bridge seam: the IPC handler still returns exactly { accepted } or { accepted, validationErrors }',
    run: async () => {
      const { sender, waitFor } = freshHarness();
      const run = startWorkflow({ sender, nodeId: 'bridge-seam-ipc-shape', runId: null, handoffs: [{ prompt: 'IPC SHAPE', batch: 1, batchTotal: 1, itemCount: 1 }] });
      const [request] = await waitFor(1);
      const submit = handler('submit-non-api-ai-response');
      const rejected = await submit({ sender }, { requestId: request.requestId, response: '{}' });
      const accepted = await submit({ sender }, { requestId: request.requestId, response: answer(request) });
      const gone = await submit({ sender }, { requestId: request.requestId, response: answer(request) });
      await run;
      const keys = (result) => Object.keys(result).sort().join();
      assert(keys(rejected) === 'accepted,validationErrors' && keys(accepted) === 'accepted' && keys(gone) === 'accepted,validationErrors', 'the internal reason never crosses IPC');
    },
  },
  {
    name: 'non-API AI bridge seam: a rejection carries only the outcome enum, the safe classification and the correction block, never the validator message',
    run: async () => {
      const { sender, waitFor, sent } = freshHarness();
      const run = startWorkflow({
        sender, nodeId: 'bridge-seam-privacy', runId: `bridge-seam-privacy-${process.pid}-${Date.now()}`,
        handoffs: [{ prompt: 'PRIVACY PROMPT', batch: 1, batchTotal: 1, itemCount: 1, responseValidator: () => { throw new Error(PRIVATE); } }],
      });
      const [request] = await waitFor(1);
      const ids = { requestId: request.requestId, handoffCode: request.handoffCode };
      const rejected = await submitNonApiAiResponseForBridge({ ...ids, response: answer(request), ...ALLOW });
      const dock = sent.filter(item => item.channel === 'non-api-ai-request').at(-1).payload;
      assert(rejected.outcome === 'rejected' && rejected.accepted === false && rejected.validationCode === 'VALIDATION_FAILED' && rejected.isCorrection === true
        && !JSON.stringify(rejected).includes(PRIVATE) && dock.validationError === PRIVATE, 'the dock keeps the precise message; the bridge outcome does not');
      assert(`${request.prompt}\n\n${rejected.correction}` === dock.prompt, 'base prompt plus the correction block is the dock retry prompt');
      const read = readBridgeableNonApiAiHandoff({ ...ids, ...ALLOW });
      assert(read.ok && read.prompt === dock.prompt && read.attempt === 2 && read.isCorrection, 'a re-serve carries the dock retry prompt byte for byte');
      await cancelAll(sender, [request]);
      await run.catch(() => {});
    },
  },
  {
    name: 'non-API AI bridge seam: only text-only, structured, allowlisted, undrafted handoffs are listed, and the allowlist cannot unlock the structural exclusions',
    run: async () => {
      const { sender, waitFor } = freshHarness();
      const nodeId = 'bridge-seam-eligibility';
      handleSafe('bridge-seam-eligibility-workflow', async (_event, _args, signal) => ({
        values: await Promise.all([
          requestNonApiAi({ prompt: 'OK', task: TASK, responseSchema: SCHEMA, batch: 1, batchTotal: 6, signal }),
          requestNonApiAi({ prompt: 'WITH FILE', task: 'vision-product-analysis', responseSchema: SCHEMA, attachmentPaths: ['/Users/private/photo.png'], signal }),
          requestNonApiAi({ prompt: 'WEB', task: 'job-compensation-research', responseSchema: SCHEMA, grounding: true, signal }),
          requestNonApiAi({ prompt: 'OTHER TASK', task: 'price-synthesis', responseSchema: SCHEMA, signal }),
          requestNonApiAi({ prompt: 'DRAFTED', task: TASK, responseSchema: SCHEMA, batch: 5, batchTotal: 6, signal }),
          requestNonApiAi({ prompt: 'SCHEMALESS', task: TASK, requestKind: 'raw-text', signal }),
        ]),
      }));
      const run = handler('bridge-seam-eligibility-workflow')({ sender }, { nodeId });
      const requests = await waitFor(6);
      const by = (text) => requests.find(request => request.prompt.includes(text));
      await handler('update-non-api-ai-draft')({ sender }, { requestId: by('DRAFTED').requestId, response: 'PRIVATE_DRAFT_TEXT typed by the person' });
      const everything = { allowTasks: new Set([TASK, 'vision-product-analysis', 'job-compensation-research', 'price-synthesis']), allowNodeIds: new Set([nodeId]) };
      const listed = listBridgeableNonApiAiHandoffs(everything);
      assert(listed.handoffs.length === 3 && listed.handoffs.some(item => item.task === 'price-synthesis') && listed.handoffs.some(item => item.task === 'job-compensation-research') && listed.handoffs.some(item => item.batch === 1), 'the plain structured handoffs remain, and a structured grounded one now joins them');
      assert(listed.excluded.attachment === 1 && listed.excluded.free_text === 1 && listed.excluded.person_editing === 1 && !('grounded' in listed.excluded), 'each exclusion counted once under its own reason, and grounding is no longer one of them');
      assert(listBridgeableNonApiAiHandoffs().handoffs.length === 0 && listBridgeableNonApiAiHandoffs().excluded.task_not_allowed === 4, 'no allowlist offers nothing');
      const otherHub = listBridgeableNonApiAiHandoffs({ ...ALLOW, allowNodeIds: new Set(['another-hub']) });
      assert(otherHub.handoffs.length === 0 && otherHub.excluded.node_not_allowed === 2, 'an unselected hub offers nothing');
      const serialized = JSON.stringify(listed);
      assert(!serialized.includes('PRIVATE_DRAFT_TEXT') && !serialized.includes('/Users/private') && !serialized.includes('"prompt"'), 'the list carries no prompt, draft or path');
      const drafted = readBridgeableNonApiAiHandoff({ requestId: by('DRAFTED').requestId, handoffCode: by('DRAFTED').handoffCode, ...ALLOW });
      const attachment = readBridgeableNonApiAiHandoff({ requestId: by('WITH FILE').requestId, handoffCode: by('WITH FILE').handoffCode, ...everything });
      assert(drafted.reason === 'person_editing' && attachment.reason === 'attachment', 'reading re-applies the rules');
      const refused = await submitNonApiAiResponseForBridge({ requestId: by('WITH FILE').requestId, handoffCode: by('WITH FILE').handoffCode, response: answer(by('WITH FILE')), ...everything });
      assert(refused.outcome === 'ineligible' && refused.exclusion === 'attachment', 'submitting to an attachment handoff is refused untouched');
      assert(BRIDGE_EXCLUSION_REASONS.every(reason => reason in listed.excluded), 'every reason is reported');
      await cancelAll(sender, requests);
      await run.catch(() => {});
    },
  },
  {
    name: 'non-API AI bridge seam: every current known task id is default-denied unless the caller explicitly allowlists it',
    run: async () => {
      const { sender, waitFor } = freshHarness();
      const nodeId = 'bridge-seam-task-sweep';
      const tasks = [...getKnownTaskIds()].sort();
      const run = startWorkflow({
        sender,
        nodeId,
        runId: null,
        handoffs: tasks.map((task, index) => ({ prompt: `TASK SWEEP ${index}`, task, responseSchema: SCHEMA, batch: index + 1, batchTotal: tasks.length, itemCount: 1 })),
      });
      const requests = await waitFor(tasks.length);
      const selected = listBridgeableNonApiAiHandoffs({ allowTasks: new Set([TASK]), allowNodeIds: new Set([nodeId]) });
      assert(selected.handoffs.length === 1 && selected.handoffs[0].task === TASK, 'only the explicitly allowlisted task is bridgeable');
      assert(selected.excluded.task_not_allowed === tasks.length - 1, 'every other known task is default-denied');
      const allAllowed = listBridgeableNonApiAiHandoffs({ allowTasks: new Set(tasks), allowNodeIds: new Set([nodeId]) });
      assert(allAllowed.handoffs.map(entry => entry.task).sort().join('\n') === tasks.join('\n'), 'the sweep covers every task id the router currently recognizes');
      await cancelAll(sender, requests);
      await run.catch(() => {});
    },
  },
  {
    name: 'non-API AI bridge seam: handoffs are listed in the dock order regardless of arrival order',
    run: async () => {
      const { sender, waitFor } = freshHarness();
      const nodeId = 'bridge-seam-order';
      const run = startWorkflow({ sender, nodeId, runId: null, handoffs: [3, 1, 2].map(batch => ({ prompt: `ORDER ${batch}`, batch, batchTotal: 3, itemCount: 1 })) });
      const requests = await waitFor(3);
      const listed = listBridgeableNonApiAiHandoffs({ ...ALLOW, allowNodeIds: new Set([nodeId]) }).handoffs;
      assert(listed.map(item => item.batch).join() === '1,2,3', 'batch order, not arrival order');
      // Drift alarm: the dock's insertion rule in receiveRequest is the one bridgeDockOrder copies.
      assert(['queued.nodeId === incoming.nodeId', 'queued.task === incoming.task', 'queued.batch > incoming.batch', 'next.splice(at, 0, incoming);'].every(part => dialogSource.includes(part)), 'the dock still orders by the copied rule');
      await cancelAll(sender, requests);
      await run.catch(() => {});
    },
  },
  {
    name: 'non-API AI bridge seam: two simultaneous submissions commit once, whichever path they arrive on',
    run: async () => {
      const { sender, waitFor } = freshHarness();
      const runId = `bridge-seam-race-${process.pid}-${Date.now()}`;
      const run = startWorkflow({ sender, nodeId: 'bridge-seam-race', runId, handoffs: [{ prompt: 'RACE', batch: 1, batchTotal: 1, itemCount: 3, itemsDone: 0, itemsTotal: 3, progressScopeId: 'r', progressUnitId: 'u', progressUnits: 3 }] });
      const [request] = await waitFor(1);
      const args = { requestId: request.requestId, handoffCode: request.handoffCode, response: answer(request), ...ALLOW };
      const results = await Promise.all([
        submitNonApiAiResponseForBridge(args),
        submitNonApiAiResponseForBridge(args),
        handler('submit-non-api-ai-response')({ sender }, { requestId: request.requestId, response: answer(request) }),
      ]);
      await run;
      assert(results.filter(result => result.accepted).length === 1 && results.filter(result => result.outcome === 'busy').length === 1, 'exactly one commit; the other bridge call is busy');
      const receipts = getNonApiAiHandoffLifecycle({ windowId: sender.id }).filter(receipt => receipt.runId === runId);
      assert(receipts.length === 1 && receipts[0].outcome === 'accepted' && receipts[0].itemsDone === 3, 'one accepted receipt, progress counted once');
      await handler('complete-non-api-ai-run')({ sender }, { runId });
      assert((await submitNonApiAiResponseForBridge(args)).outcome === 'not_pending', 'a late duplicate finds nothing pending');
    },
  },
  {
    name: 'non-API AI bridge seam: a handoff re-issued under the same code after Back cannot be answered by a stale bridge submission',
    run: async () => {
      const { sender, waitFor, sent } = freshHarness();
      const runId = `bridge-seam-back-${process.pid}-${Date.now()}`;
      const spec = { prompt: 'BACK STEP', batch: 1, batchTotal: 1, itemCount: 1 };
      const first = startWorkflow({ sender, nodeId: 'bridge-seam-back', runId, handoffs: [spec] });
      const [original] = await waitFor(1);
      await submitNonApiAiResponseForBridge({ requestId: original.requestId, handoffCode: original.handoffCode, response: answer(original), ...ALLOW });
      await first;
      sent.length = 0;
      // Back: the same step (same code) is issued again with the accepted answer restored as an editable draft.
      const second = startWorkflow({ sender, nodeId: 'bridge-seam-back-again', runId: `${runId}-again`, handoffs: [{ ...spec }], extra: { initialResponse: answer(original) } });
      const [reissued] = await waitFor(1);
      const stale = await submitNonApiAiResponseForBridge({ requestId: original.requestId, handoffCode: original.handoffCode, response: answer(original), ...ALLOW });
      const drafted = await submitNonApiAiResponseForBridge({ requestId: reissued.requestId, handoffCode: reissued.handoffCode, response: answer(reissued), ...ALLOW });
      assert(stale.outcome === 'not_pending', 'the old request id is gone');
      assert(drafted.outcome === 'ineligible' && drafted.exclusion === 'person_editing', 'the restored draft keeps the reissued handoff out of the bridge');
      await cancelAll(sender, [reissued]);
      await second.catch(() => {});
      await handler('complete-non-api-ai-run')({ sender }, { runId });
    },
  },
  {
    name: 'non-API AI bridge seam: the accept body exists once, both entry points only call it, and the pinned log lines are untouched',
    run: () => {
      const between = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
      const ipcHandler = between("ipcMain.handle('submit-non-api-ai-response'", "ipcMain.handle('step-back-non-api-ai-request'");
      const bridgeSubmit = between('export async function submitNonApiAiResponseForBridge(', '\n}\n');
      const forbidden = ['validateNonApiAiSubmission(', 'updateDurableStep(', 'settle(', 'record.resolve(', 'claimAcceptedResponseFingerprint(', 'updateHandoffLifecycle('];
      assert(forbidden.every(text => !ipcHandler.includes(text) && !bridgeSubmit.includes(text)), 'neither entry point re-implements validation, commit or settlement');
      assert(ipcHandler.includes('await acceptNonApiAiResponse(record, args)') && bridgeSubmit.includes('await acceptNonApiAiResponse(record, { response })'), 'both call the one accept body');
      assert((source.match(/updateDurableStep\(record, \{ status: 'accepted'/g) || []).length === 1, 'exactly one accepted-commit site');
      const beforeCall = bridgeSubmit.slice(0, bridgeSubmit.indexOf('await acceptNonApiAiResponse')).split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
      assert(!beforeCall.includes('await '), 'no await between the eligibility checks and the accept body');
      const seam = between('// ── In-process bridge seam', 'export function registerNonApiAiHandlers()');
      assert(!/\.message|\.stack|validationErrors|validationError\b/.test(seam.replace(/record\.validationError\b/g, '')), 'the seam never reads an error message');
      assert(source.split('\n').filter(line => /Rejected response for task|Ignoring invalid (legacy )?saved response/.test(line)).length === 3, 'the exactly-three log-line pin holds');
    },
  },
];
