// Safety gates for the bridge seam in electron/ipc/nonApiAi.js. Reviewed text
// is plugin-only; these tests pin the route boundary, bridge acceptance, and
// the remaining structurally manual recovery paths.
import fs, { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  _resetNonApiAiHandoffLifecycle, __reloadDurableStateForTests, assert, buildNonApiAiHandoffLifecycleMarkdown, callLLMText, electronPkg, getNonApiAiHandoffLifecycle,
  handleSafe, ipcMain, registerNonApiAiHandlers, requestNonApiAi, validateJobScoringSubmission,
  returnBridgeHandoffToPerson, __promptForRetryForTests, __defaultSafeValidationDiagnosticForTests,
  JOB_GAP_REVIEW_SCHEMA, validateGapReviewSubmission,
} from '../test-dependencies.js';
import { getRecentLogs } from '../../electron/logger.js';
import {
  __bridgeExclusionReasonForTests, __claimAcceptedResponseFingerprintForTests, BRIDGE_EXCLUSION_REASONS, BRIDGE_RAW_RESEARCH_TASKS, BRIDGE_RELEASE_ONE_TASKS, listBridgeableNonApiAiHandoffs, onNonApiAiEvent, readBridgeableNonApiAiHandoff, submitNonApiAiResponseForBridge,
} from '../../electron/ipc/nonApiAi.js';
import { callLLMRaw, getKnownTaskIds } from '../../electron/ipc/llm.js';
import {
  buildOfficialPostingMatchRequest, buildOfficialPostingResearchRequest, officialPostingResearchId,
} from '../../electron/ipc/officialPostingBridge.js';
import { resolveOfficialPostings } from '../../electron/ipc/officialPostingService.js';
import { unresolvedOfficialPosting } from '../../electron/ipc/officialPostingResolver.js';

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

function freshHarness(handlerOptions) {
  ipcMain.__clearInvokeHandlers();
  _resetNonApiAiHandoffLifecycle();
  registerNonApiAiHandlers(handlerOptions);
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
  // The dock-only bridge claim token is freshly random for each request. It
  // neither changes the prompt/response contract nor crosses the bridge
  // seam, so exclude it from the transport-parity snapshot alongside ids.
  const stableSent = sent.map(entry => entry?.channel === 'non-api-ai-request'
    ? { ...entry, payload: without(entry.payload || {}, ['bridgeClaimId']) }
    : entry);
  let text = JSON.stringify({
    sent: stableSent,
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
  // Even a reviewed raw-research task stays default-denied without the exact
  // grounding contract. Every response row executes this `free_text` refusal.
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
    if (kind.id === 'K7') {
      const dock = await handler('submit-non-api-ai-response')({ sender }, { requestId: requests[0].requestId, response: matrixResponse(requests[0], 'valid') });
      assert(dock.accepted === false && dock.validationErrors?.[0]?.includes('ChatGPT plugin'), `${kind.id}/${row}: a scope-excluded MCP record stays plugin-only`);
      await handler('cancel-non-api-ai-request')({ sender }, { requestId: requests[0].requestId });
    } else {
      const dock = await handler('submit-non-api-ai-response')({ sender }, { requestId: requests[0].requestId, response: matrixResponse(requests[0], 'valid') });
      assertIpcTuple(dock, `${kind.id}/${row} dock untouched`);
      assert(dock.accepted === true, `${kind.id}/${row}: a structurally manual record remains live for the dock`);
    }
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
  if (!runRejected && kind.id !== 'K7' && !['not_pending', 'cancelled_during_save'].includes(row)) {
    assert(durable.some(step => step.status === 'accepted'), `${kind.id}/${row}: durable accepted status is observed before cleanup`);
  }
  const serializedEvents = JSON.stringify(sent)
    .replace(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/gi, '<request-id>')
    .replace(/HANDOFF-[2-9A-HJ-NP-Z]{6}/g, '<handoff-code>');
  const logLines = getRecentLogs().slice(logStart).map(entry => entry.message).filter(message => message.includes('[Non-API AI] Rejected response'));
  await handler('complete-non-api-ai-run')({ sender }, { runId }).catch(() => {});
  return { events: serializedEvents, lifecycle: lifecycle.map(entry => entry.outcome), durable, values: resolvedValues, runRejected, logs: logLines };
}

async function withRuleHandoff(validator, check, { schema = SCHEMA } = {}) {
  const copied = [];
  const { sender, sent, waitFor } = freshHarness({ clipboard: { writeText: value => copied.push(value) } });
  const runId = `w3-rules-${sender.id}-${Date.now()}`;
  const channel = `w3-rules-${sender.id}`;
  const allow = { allowTasks: new Set(['career-profile-repair']) };
  let abort = new AbortController();
  handleSafe(channel, async () => ({ value: await callLLMText('SYNTHETIC W3 RULES', {
    task: 'career-profile-repair', signal: abort.signal, responseSchema: schema, responseValidator: validator,
  }) }));
  const launch = () => handler(channel)({ sender }, { manualAiRunId: runId });
  let run = launch();
  let [request] = await waitFor(1);
  const context = {
    sender, sent, copied, runId,
    get request() { return request; },
    submit: value => submitNonApiAiResponseForBridge({ requestId: request.requestId, handoffCode: request.handoffCode, response: answer(request, value), ...allow }),
    submitObject: value => submitNonApiAiResponseForBridge({ requestId: request.requestId, handoffCode: request.handoffCode, response: JSON.stringify({ ...value, handoffCode: request.handoffCode }), ...allow }),
    async restart() {
      abort.abort(new Error('synthetic relaunch'));
      await run;
      await __reloadDurableStateForTests();
      sent.length = 0;
      abort = new AbortController();
      run = launch();
      [request] = await waitFor(1);
    },
  };
  try { await check(context); }
  finally {
    await cancelAll(sender, [request]);
    await run;
    await handler('complete-non-api-ai-run')({ sender }, { runId }).catch(() => {});
  }
}

function ruleError(lines, ids) {
  return Object.assign(new Error('Private local failure'), {
    code: 'CAREER_SNAPSHOT_AUDIT_INVALID', correctionDetails: lines, correctionRuleIds: ids,
  });
}

export default [
  {
    name: 'W4 repro R1: distinct gap-review rules count separately and the fifth repeat hands back',
    run: async () => {
      const { sender, sent, waitFor } = freshHarness();
      const logsBefore = new Set(getRecentLogs());
      const runId = `w4-gap-causes-${sender.id}-${Date.now()}`;
      const allow = { allowTasks: new Set(['job-gap-review']) };
      const batch = [{ index: 0, jobText: 'Alpha duty one.', rows: ['r1', 'r2'].map(id => ({
        id, requirement: 'a', priority: 'required', status: 'not_documented', jobEvidence: [], candidateEvidence: [],
      })) }];
      handleSafe('w4-gap-causes', async (_event, _args, signal) => ({
        value: await callLLMText('GAP REVIEW CAUSES', { signal, task: 'job-gap-review', responseSchema: JOB_GAP_REVIEW_SCHEMA,
          responseValidator: value => validateGapReviewSubmission(value, batch) }),
      }));
      const run = handler('w4-gap-causes')({ sender }, { manualAiRunId: runId });
      const [request] = await waitFor(1);
      const row = (id, attempt) => ({ id, verdict: 'confirmed', priority: 'unchanged', status: 'unchanged', jobEvidence: '', candidateEvidence: '', duplicateOf: '', explanation: `Synthetic attempt ${attempt}` });
      const submit = (ids, attempt) => submitNonApiAiResponseForBridge({ requestId: request.requestId, handoffCode: request.handoffCode,
        response: JSON.stringify({ handoffCode: request.handoffCode, reviews: [{ index: 0, rows: ids.map(id => row(id, attempt)) }] }), ...allow });
      try {
        for (let index = 0; index < 4; index++) {
          const result = await submit(['r1'], index);
          assert(result.outcome === 'rejected' && /1\. .*r2.*missing/iu.test(result.correction), 'the missing-row rule has a numbered correction and remains bridged');
        }
        for (let index = 0; index < 4; index++) {
          const result = await submit(['r1', 'r2', `zz-${index + 1}`], index + 4);
          assert(result.outcome === 'rejected' && /1\. .*zz-.*not among/iu.test(result.correction), 'the unlisted-row rule has a separate numbered correction and does not cap at five total');
        }
        assert((await submit(['r1'], 8)).outcome === 'rejection_cap', 'the ninth answer is the fifth repeat of the missing-row rule');
        assert(listBridgeableNonApiAiHandoffs(allow).handoffs.length === 0, 'the bridge no longer owns the handoff');
        assert(sent.filter(item => item.channel === 'non-api-ai-request').at(-1).payload.prompt.includes('missing'), 'the dock carries the rule text');
        const diagnostics = JSON.stringify({ lifecycle: getNonApiAiHandoffLifecycle({ windowId: sender.id }), logs: getRecentLogs().filter(entry => !logsBefore.has(entry)) });
        assert(!diagnostics.includes('listed gap rows') && !diagnostics.includes('not among the listed gap row ids') && !diagnostics.includes('correctionDetails'), 'W4 teaching text stays out of logs and lifecycle receipts');
      } finally {
        await cancelAll(sender, [request]); await run;
        await handler('complete-non-api-ai-run')({ sender }, { runId }).catch(() => {});
      }
    },
  },
  {
    name: 'W3 transport: an unkeyed detail counts independently beside changing keyed rules',
    run: () => withRuleHandoff(value => {
      throw ruleError(['keyed finding fails', 'an independent unkeyed finding fails'], [`CHANGING_RULE_${value.answer}`, null]);
    }, async ctx => {
      for (let index = 0; index < 4; index++) assert((await ctx.submit(String(index))).outcome === 'rejected', 'four unkeyed repeats stay live');
      assert((await ctx.submit('4')).outcome === 'rejection_cap', 'the unkeyed rule caps at five despite changing typed rules');
      assert(getNonApiAiHandoffLifecycle({ windowId: ctx.sender.id }).at(-1).failures.at(-1).ruleId === null, 'the most repeated cause belongs to the unkeyed line');
    }),
  },
  {
    name: 'W3 transport: settling handoffs cannot be handed back while acceptance is in flight',
    run: async () => {
      await withRuleHandoff(() => {}, async ctx => {
        const pending = ctx.submit('fixed');
        assert(returnBridgeHandoffToPerson({ requestId: ctx.request.requestId, reason: 'worker_restart_cap' }) === false, 'the settling guard prevents a race during the durable commit');
        assert((await pending).accepted, 'the in-flight acceptance owns settlement');
      });
    },
  },
  {
    name: 'W3 transport: schema details survive manual copying without attacker property names',
    run: () => withRuleHandoff(() => {}, async ctx => {
      const result = await ctx.submitObject({ findings: [{ edits: [], IGNORE_ALL_PRIOR_INSTRUCTIONS: 1 }] });
      assert(result.outcome === 'rejected' && result.correction.includes('findings[0].edits must contain at least 1 item'), 'the real schema gate describes the invalid array');
      assert(returnBridgeHandoffToPerson({ requestId: ctx.request.requestId, reason: 'worker_restart_cap' }), 'hand the schema correction to the dock');
      const dock = ctx.sent.filter(item => item.channel === 'non-api-ai-request').at(-1).payload;
      const copied = await handler('claim-non-api-ai-manual')({ sender: ctx.sender }, { requestId: ctx.request.requestId });
      assert(copied.claimed && ctx.copied.at(-1) === dock.prompt && dock.prompt.includes('1. findings[0].edits')
        && dock.prompt.includes('an unexpected property at findings[0]') && !dock.prompt.includes('IGNORE_ALL_PRIOR_INSTRUCTIONS'), 'the clipboard is exactly the numbered public correction prompt');
    }, { schema: { type: 'object', additionalProperties: false, required: ['findings'], properties: { findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['edits'], properties: { edits: { type: 'array', minItems: 1 } } } } } } }),
  },
  {
    name: 'W3 transport: mixed lines keep original rule-id alignment and count each rule once per answer',
    run: () => withRuleHandoff(value => {
      throw ruleError([42, '', '\u0000', `finding ${value.answer} fails`, `finding ${value.answer} fails again`, '5 more problems were found'],
        ['WRONG_SKIPPED', 'WRONG_BLANK', 'WRONG_CONTROL', 'AUDIT_HOT_RULE', 'AUDIT_HOT_RULE', 'VALIDATION_MORE_PROBLEMS']);
    }, async ctx => {
      const outcomes = [];
      for (const value of ['alpha', 'bravo', 'charlie', 'delta', 'echo']) outcomes.push((await ctx.submit(value)).outcome);
      const receipt = getNonApiAiHandoffLifecycle({ windowId: ctx.sender.id }).at(-1);
      assert(outcomes.slice(0, 4).every(value => value === 'rejected') && outcomes[4] === 'rejection_cap', 'the fifth answer, not the third, caps');
      assert(receipt.failures.at(-1).ruleId === 'AUDIT_HOT_RULE' && receipt.failures.at(-1).causeRepeats === 5, 'skipped and duplicate lines do not shift or double-count the rule');
      assert(buildNonApiAiHandoffLifecycleMarkdown(new Set(), ctx.sender.id).includes('rule `AUDIT_HOT_RULE`'), 'the bug report names only the rule id');
    }),
  },
  {
    name: 'W3 transport: eight distinct rule failures ignore the repeated summary rule',
    run: () => withRuleHandoff(value => {
      if (value.answer === 'fixed') return;
      throw ruleError(['one finding fails', 'More omitted problems'], [`RULE_${value.answer}`, 'VALIDATION_MORE_PROBLEMS']);
    }, async ctx => {
      for (const key of ['AAA', 'BBB', 'CCC', 'DDD', 'AAA', 'BBB', 'CCC', 'DDD']) assert((await ctx.submit(key)).outcome === 'rejected', 'changing rules stay uncapped');
      assert((await ctx.submit('fixed')).accepted, 'the corrected answer finishes');
    }),
  },
  ...[false, true].map(plain => ({
    name: `W3 transport: ${plain ? 'unadopted plain errors' : 'invalid rule ids'} keep the legacy five-answer cap`,
    run: () => withRuleHandoff(() => {
      if (plain) throw new Error('a private ordinary message');
      throw ruleError(['finding "changing value" fails a stable rule'], ['invalid lower case']);
    }, async ctx => {
      const results = [];
      for (let index = 0; index < 5; index++) results.push((await ctx.submit(String(index))).outcome);
      assert(results.slice(0, 4).every(value => value === 'rejected') && results[4] === 'rejection_cap', 'fallback shape/classification counts reach five');
      assert(getNonApiAiHandoffLifecycle({ windowId: ctx.sender.id }).at(-1).failures.every(row => row.ruleId === null), 'invalid or absent ids are never logged as rules');
    }),
  })),
  {
    name: 'W3 transport: lowest-count eviction preserves a recurring rule across seventy one-off rules',
    run: () => withRuleHandoff(value => {
      throw ruleError(['finding fails a rule'], [value.answer === 'hot' ? 'HOT_RULE' : `COLD_RULE_${value.answer}`]);
    }, async ctx => {
      for (let index = 0; index < 4; index++) assert((await ctx.submit('hot')).outcome === 'rejected', 'four hot failures stay live');
      for (let index = 0; index < 70; index++) assert((await ctx.submit(String(index))).outcome === 'rejected', 'one-off rules do not cap');
      assert((await ctx.submit('hot')).outcome === 'rejection_cap', 'the older count-four rule survived eviction');
      const [step] = await durableSteps(ctx.runId);
      assert(Object.keys(step.bridgeRejectionCauses).length <= 64, 'the durable map remains bounded');
    }),
  },
  ...[false, true].map(escalate => ({
    name: `W3 transport: clipped corrections survive relaunch ${escalate ? 'after worker restart hand-back' : 'while still bridged'}`,
    run: () => withRuleHandoff(value => {
      if (value.answer === 'fixed') return;
      throw ruleError(['finding audit-1 violates quote rule', 'x'.repeat(800)], ['AUDIT_QUOTE_NOT_VERBATIM', 'AUDIT_OTHER_RULE']);
    }, async ctx => {
      await ctx.submit('bad');
      assert(returnBridgeHandoffToPerson({ requestId: ctx.request.requestId, reason: 'unknown' }) === false, 'unknown reasons cannot change the route');
      if (escalate) {
        assert(returnBridgeHandoffToPerson({ requestId: ctx.request.requestId, reason: 'worker_restart_cap' }), 'the bridge hands it back');
        assert(returnBridgeHandoffToPerson({ requestId: ctx.request.requestId, reason: 'worker_restart_cap' }) === false, 'a manual record is never handed back twice');
        assert(buildNonApiAiHandoffLifecycleMarkdown(new Set(), ctx.sender.id).includes('`worker_restart_cap`'), 'the report names the closed escalation');
      }
      const [saved] = await durableSteps(ctx.runId);
      assert(saved.validationCorrectionDetails[0] === 'finding audit-1 violates quote rule', 'only cleaned correction lines persist');
      assert(saved.validationCorrectionDetails.every(line => line.length <= 600), 'private durable lines retain the transport clipping bound');
      await ctx.restart();
      assert(ctx.request.prompt.includes('1. finding audit-1 violates quote rule') && ctx.request.mcpEligible === !escalate, 'relaunch restores the correction block and route');
      if (escalate) {
        assert(ctx.request.bridgeEscalation === 'worker_restart_cap', 'the public dock exposes why it came back');
        const claimed = await handler('claim-non-api-ai-manual')({ sender: ctx.sender }, { requestId: ctx.request.requestId });
        assert(claimed.claimed && ctx.copied.at(-1) === ctx.request.prompt, 'manual clipboard contains the same numbered prompt');
        assert((await handler('submit-non-api-ai-response')({ sender: ctx.sender }, { requestId: ctx.request.requestId, response: answer(ctx.request, 'fixed') })).accepted, 'the person can finish');
      } else assert((await ctx.submit('fixed')).accepted, 'the bridge can finish');
      const [settled] = await durableSteps(ctx.runId);
      assert(settled.validationCorrectionDetails === null && settled.bridgeEscalation === null, 'acceptance clears private correction and escalation state');
    }),
  })),
  {
    name: 'W3 transport: repair guidance respects the edit protocol and audit diagnostics stay typed',
    run: () => {
      for (const reason of ['CAREER_PAGE_VALIDATION_FAILED', 'CAREER_PAGE_REPAIR_NO_PROGRESS', 'CAREER_PAGE_REPAIR_TARGET_MISSED']) {
        const { prompt } = __promptForRetryForTests({ task: 'career-profile-repair', materializedPrompt: 'original', responseSchema: SCHEMA, validationCode: 'STRUCTURED_OUTPUT_SCHEMA_INVALID', validationDiagnostic: { stage: 'domain', reason, counts: {} } }, 'invalid');
        assert(!prompt.includes('Rebuild the complete career page shard') && !prompt.includes('Do not return a patch') && prompt.includes('complete corrected answer'), 'repair schema corrections retain edits/adjudication format');
      }
      const diagnostic = __defaultSafeValidationDiagnosticForTests({}, 'CAREER_SNAPSHOT_AUDIT_INVALID');
      assert(diagnostic.reason === 'CAREER_AUDIT_FINDINGS_INVALID' && diagnostic.stage === 'domain', 'audit errors have a closed domain diagnostic');
      const correction = (task, reason) => __promptForRetryForTests({ task, materializedPrompt: 'original', responseSchema: SCHEMA,
        validationCode: 'CAREER_SNAPSHOT_PAGE_INVALID', validationDiagnostic: { stage: 'domain', reason, counts: {} } }, 'invalid').prompt;
      assert(correction('career-profile-compile', 'CAREER_PAGE_VALIDATION_FAILED').includes('Rebuild the complete career page shard'), 'compile guidance retains the existing whole-shard protocol');
      assert(correction('career-profile-audit-skills', 'CAREER_AUDIT_FINDINGS_INVALID').includes('Fix or drop each finding'), 'audit guidance permits removing invalid findings');
      assert(dialogSource.includes('The same rule failed in 5 answers from ChatGPT.') && dialogSource.includes('The worker chat was replaced 3 times without an answer.'), 'the dock names both reasons plainly');
    },
  },
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
      // MCP-routed K1/K3/K6 drive the plugin entry point only: the renderer
      // IPC is intentionally denied for those records. K4/K5 remain manual
      // and K2/K7 are excluded. Keeping all 84 cells in one test preserves
      // the verified eight-test file contract while making each declaration a
      // real controlled behaviour.
      for (const kind of MATRIX_KINDS) {
        for (const row of MATRIX_RESPONSES) {
          await runMatrixCell({ kind, row, via: 'bridge' });
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
    name: 'non-API AI bridge seam: every reviewed scenario settles through the plugin path with durable receipts',
    run: async () => {
      let index = 0;
      for (const scenario of SCENARIOS) {
        index += 1;
        const nodeId = `bridge-seam-parity-node-${index}`;
        const runId = `bridge-seam-parity-run-${index}-${process.pid}-${Date.now()}`;
        const bridge = await runScenario({ via: 'bridge', scenario, nodeId, runId });
        assert(bridge.outcomes.length > 0 && bridge.observables.lifecycle.length > 0,
          `${scenario.name}: the plugin path records outcomes and a durable lifecycle receipt`);
      }
      return { scenarios: SCENARIOS.length };
    },
  },
  {
    name: 'non-API AI bridge seam: the IPC handler still returns exactly { accepted } or { accepted, validationErrors }',
    run: async () => {
      const { sender, waitFor } = freshHarness();
      const run = startWorkflow({ sender, nodeId: 'bridge-seam-ipc-shape', runId: null, handoffs: [{ task: 'test-manual-ipc-shape', prompt: 'IPC SHAPE', batch: 1, batchTotal: 1, itemCount: 1 }] });
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
        && request.mcpEligible === true && dock.mcpEligible === true
        && !JSON.stringify(rejected).includes(PRIVATE) && dock.validationError === PRIVATE, 'the dock keeps the precise message; the bridge outcome does not');
      assert(`${request.prompt}\n\n${rejected.correction}` === dock.prompt, 'base prompt plus the correction block is the dock retry prompt');
      const read = readBridgeableNonApiAiHandoff({ ...ids, ...ALLOW });
      assert(read.ok && read.prompt === dock.prompt && read.attempt === 2 && read.isCorrection, 'a re-serve carries the dock retry prompt byte for byte');
      await cancelAll(sender, [request]);
      await run.catch(() => {});
    },
  },
  {
    name: 'non-API AI bridge seam: a domain rejection remains pending and reissues before any accepted receipt or successor drain',
    run: async () => {
      const { sender, waitFor, sent } = freshHarness();
      const nodeId = 'bridge-seam-validator-transaction';
      const runId = `bridge-seam-validator-transaction-${process.pid}-${Date.now()}`;
      const allow = { ...ALLOW, allowNodeIds: new Set([nodeId]) };
      const run = startWorkflow({
        sender,
        nodeId,
        runId,
        handoffs: [{
          prompt: 'VALIDATOR TRANSACTION', batch: 1, batchTotal: 1, itemCount: 1,
          itemsDone: 0, itemsTotal: 1, progressScopeId: 'validator-transaction', progressUnitId: 'only', progressUnits: 1,
          responseValidator: value => {
            if (value?.answer === 'stale') throw new Error(PRIVATE);
          },
        }],
      });
      const [request] = await waitFor(1);
      const rejected = await submitNonApiAiResponseForBridge({
        requestId: request.requestId,
        handoffCode: request.handoffCode,
        response: answer(request, 'stale'),
        ...allow,
      });
      const rejectedSteps = await durableSteps(runId);
      const rejectedLifecycle = getNonApiAiHandoffLifecycle({ windowId: sender.id });
      const reissue = sent.filter(item => item.channel === 'non-api-ai-request').at(-1)?.payload;
      const listed = listBridgeableNonApiAiHandoffs(allow);
      assert(rejected.outcome === 'rejected' && rejected.accepted === false && rejected.isCorrection === true
        && !JSON.stringify(rejected).includes(PRIVATE),
      'the bridge exposes a safe correction instead of acknowledging a domain-invalid answer');
      assert(rejectedSteps.length === 1 && rejectedSteps[0].status === 'pending'
        && rejectedLifecycle.length === 1 && rejectedLifecycle[0].acceptedAt == null && rejectedLifecycle[0].settledAt == null
        && !sent.some(item => item.channel === 'non-api-ai-settled'),
      'a validator rejection leaves the durable row, lifecycle, and progress settlement unaccepted');
      assert(reissue?.requestId === request.requestId && reissue?.handoffCode === request.handoffCode
        && reissue?.isCorrection === true && reissue?.itemsDone === 0
        && listed.pending === 1 && listed.handoffs.length === 1 && listed.handoffs[0].requestId === request.requestId,
      'the same bridge request is reissued and remains queueable rather than draining to queue_empty');

      const accepted = await submitNonApiAiResponseForBridge({
        requestId: request.requestId,
        handoffCode: request.handoffCode,
        response: answer(request, 'fixed'),
        ...allow,
      });
      const completed = await run;
      const acceptedSteps = await durableSteps(runId);
      assert(accepted.outcome === 'accepted' && completed.values?.[0]?.answer === 'fixed'
        && acceptedSteps.length === 1 && acceptedSteps[0].status === 'accepted',
      'only the corrected response reaches the durable acceptance point');
      await handler('complete-non-api-ai-run')({ sender }, { runId });
    },
  },
  {
    name: 'non-API AI bridge seam: a queued-work forecast crosses only the main-process planning seam',
    run: async () => {
      const { sender, waitFor } = freshHarness();
      const nodeId = 'bridge-seam-queued-work-forecast';
      const scopeId = 'db778d75-5dc2-4980-9d2e-95a917f8669b';
      handleSafe('bridge-seam-queued-work-forecast-workflow', async (_event, _args, signal) => ({
        values: await Promise.all([
          callLLMText('QUEUED WORK FORECAST', {
            signal,
            task: TASK,
            responseSchema: SCHEMA,
            hints: {
              itemCount: 10,
              itemsDone: 145,
              itemsTotal: 2058,
              progressScopeId: scopeId,
              progressUnitId: 'listing-evaluation-145',
              progressUnits: 10,
              queuedWorkForecast: { scopeId, remainingUnits: 192 },
            },
          }),
          // Simulates a handoff already pending when this app update lands.
          // It has the historic progress metadata but no new forecast field.
          callLLMText('LEGACY QUEUED WORK FORECAST', {
            signal,
            task: 'job-preference-evaluation',
            responseSchema: SCHEMA,
            hints: {
              itemCount: 10,
              itemsDone: 145,
              itemsTotal: 2058,
              progressScopeId: scopeId,
              progressUnitId: 'listing-evaluation-155',
              progressUnits: 10,
            },
          }),
          callLLMRaw('RAW RESEARCH QUEUED WORK FORECAST', {
            signal,
            task: 'job-preference-research-batch',
            grounding: true,
            hints: {
              itemCount: 12,
              batch: 71,
              batchTotal: 209,
              itemsDone: 840,
              itemsTotal: 2508,
              progressScopeId: scopeId,
              progressUnitId: 'company-research-raw-71',
              progressUnits: 12,
              queuedWorkForecast: { scopeId, remainingUnits: 139 },
            },
            responseValidator: value => value,
          }),
        ]),
      }));
      const run = handler('bridge-seam-queued-work-forecast-workflow')({ sender }, { nodeId });
      const requests = await waitFor(3);
      const request = requests.find(item => item.prompt.includes('QUEUED WORK FORECAST') && !item.prompt.includes('LEGACY') && !item.prompt.includes('RAW RESEARCH'));
      const legacy = requests.find(item => item.prompt.includes('LEGACY QUEUED WORK FORECAST'));
      const rawResearch = requests.find(item => item.prompt.includes('RAW RESEARCH QUEUED WORK FORECAST'));
      const listed = listBridgeableNonApiAiHandoffs({ allowTasks: new Set([TASK, 'job-preference-evaluation', 'job-preference-research-batch']), allowNodeIds: new Set([nodeId]) }).handoffs;
      const listedCurrent = listed.find(item => item.requestId === request?.requestId);
      const listedLegacy = listed.find(item => item.requestId === legacy?.requestId);
      const listedRawResearch = listed.find(item => item.requestId === rawResearch?.requestId);
      assert(request && legacy && rawResearch
        && !Object.hasOwn(request, 'queuedWorkForecast')
        && !JSON.stringify(request).includes(scopeId)
        && listedCurrent?.queuedWorkForecast?.scopeId === scopeId
        && listedCurrent.queuedWorkForecast.remainingUnits === 192
        && listedLegacy?.queuedWorkForecast?.scopeId === scopeId
        && listedLegacy.queuedWorkForecast.remainingUnits === 192
        && listedRawResearch?.queuedWorkForecast?.scopeId === scopeId
        && listedRawResearch.queuedWorkForecast.remainingUnits === 139,
      'the structured and raw LLM callers forward bounded forecasts to the private push seam, and an already-pending preference handoff derives the same aggregate without adding it to the renderer request');
      await cancelAll(sender, requests);
      await run.catch(() => {});
    },
  },
  {
    name: 'non-API AI bridge seam: rolling preference research derives remaining work from accepted progress, not a straggler batch ordinal',
    run: async () => {
      const { sender, waitFor } = freshHarness();
      const nodeId = 'bridge-seam-rolling-research-forecast';
      const scopeId = 'e64b5f45-98b8-467e-b1da-69631e5d17e8';
      handleSafe('bridge-seam-rolling-research-forecast-workflow', async (_event, _args, signal) => ({
        values: await Promise.all(Array.from({ length: 3 }, (_unused, index) => callLLMRaw(`ROLLING RESEARCH ${index + 1}`, {
          signal,
          task: 'job-preference-research-batch',
          grounding: true,
          hints: {
            itemCount: 12,
            batch: index + 1,
            batchTotal: 3,
            itemsDone: 0,
            itemsTotal: 36,
            progressScopeId: scopeId,
            progressUnitId: `company-research-raw-${index + 1}`,
            progressUnits: 12,
            rootBatchSize: 12,
            // This is the historical per-record ordinal forecast. Batch one
            // remains open while batches two and three settle first.
            queuedWorkForecast: { scopeId, remainingUnits: 3 - index },
          },
          responseValidator: value => value,
        }))),
      }));
      const run = handler('bridge-seam-rolling-research-forecast-workflow')({ sender }, { nodeId });
      const requests = await waitFor(3);
      const byBatch = new Map(requests.map(request => [request.batch, request]));
      const allow = {
        allowTasks: new Set(['job-preference-research-batch']),
        allowNodeIds: new Set([nodeId]),
      };
      for (const batch of [3, 2]) {
        const request = byBatch.get(batch);
        const accepted = await submitNonApiAiResponseForBridge({
          requestId: request.requestId,
          handoffCode: request.handoffCode,
          response: `Handoff: ${request.handoffCode}\n\nresearch batch ${batch}`,
          ...allow,
        });
        assert(accepted.accepted === true, `out-of-order batch ${batch} must settle`);
      }
      const oldest = byBatch.get(1);
      const listed = listBridgeableNonApiAiHandoffs(allow).handoffs.find(item => item.requestId === oldest.requestId);
      assert(listed?.queuedWorkForecast?.scopeId === scopeId
        && listed.queuedWorkForecast.remainingUnits === 1,
      `two later accepted 12-item batches leave exactly one root batch despite batch one's legacy ordinal forecast (${JSON.stringify(listed?.queuedWorkForecast)})`);
      const acceptedOldest = await submitNonApiAiResponseForBridge({
        requestId: oldest.requestId,
        handoffCode: oldest.handoffCode,
        response: `Handoff: ${oldest.handoffCode}\n\nresearch batch 1`,
        ...allow,
      });
      assert(acceptedOldest.accepted === true, 'the oldest remaining batch still settles normally');
      await run;
    },
  },
  {
    name: 'non-API AI bridge seam: rolling listing evaluation derives remaining work from accepted progress, not a straggler forecast',
    run: async () => {
      const { sender, waitFor } = freshHarness();
      const nodeId = 'bridge-seam-rolling-listing-forecast';
      const scopeId = '3d4f2051-fd50-4e2b-b91e-b3e6fcf8ad57';
      handleSafe('bridge-seam-rolling-listing-forecast-workflow', async (_event, _args, signal) => ({
        values: await Promise.all(Array.from({ length: 3 }, (_unused, index) => callLLMText(`ROLLING LISTING ${index + 1}`, {
          signal,
          task: 'job-preference-evaluation',
          responseSchema: SCHEMA,
          hints: {
            itemCount: 12,
            batch: index + 1,
            itemsDone: 0,
            itemsTotal: 36,
            progressScopeId: scopeId,
            progressUnitId: `listing-evaluation-${index + 1}`,
            progressUnits: 12,
            // These issue-time estimates become stale while batch one waits.
            // Omit rootBatchSize to cover the item's established fallback.
            queuedWorkForecast: { scopeId, remainingUnits: 3 - index },
          },
        }))),
      }));
      const run = handler('bridge-seam-rolling-listing-forecast-workflow')({ sender }, { nodeId });
      const requests = await waitFor(3);
      const byBatch = new Map(requests.map(request => [request.batch, request]));
      const allow = {
        allowTasks: new Set(['job-preference-evaluation']),
        allowNodeIds: new Set([nodeId]),
      };
      for (const batch of [3, 2]) {
        const request = byBatch.get(batch);
        const accepted = await submitNonApiAiResponseForBridge({
          requestId: request.requestId,
          handoffCode: request.handoffCode,
          response: answer(request, `listing batch ${batch}`),
          ...allow,
        });
        assert(accepted.accepted === true, `out-of-order listing batch ${batch} must settle`);
      }
      const oldest = byBatch.get(1);
      const listed = listBridgeableNonApiAiHandoffs(allow).handoffs.find(item => item.requestId === oldest.requestId);
      assert(listed?.queuedWorkForecast?.scopeId === scopeId
        && listed.queuedWorkForecast.remainingUnits === 1,
      `two later accepted 12-item listing batches leave one root batch despite batch one's static forecast (${JSON.stringify(listed?.queuedWorkForecast)})`);
      const acceptedOldest = await submitNonApiAiResponseForBridge({
        requestId: oldest.requestId,
        handoffCode: oldest.handoffCode,
        response: answer(oldest, 'listing batch 1'),
        ...allow,
      });
      assert(acceptedOldest.accepted === true, 'the oldest remaining listing batch still settles normally');
      await run;
    },
  },
  {
    name: 'non-API AI bridge seam: durable no-progress career repairs cool, persist, and remain cancellable',
    run: async () => {
      const { sender, sent, waitFor } = freshHarness();
      const runId = `bridge-paced-repair-${process.pid}-${Date.now()}`;
      const allow = { allowTasks: new Set(['career-profile-repair']) };
      handleSafe('bridge-paced-repair-workflow', async (_event, _args, signal) => ({
        value: await callLLMText('REPAIR ONLY THE ASSIGNED CAREER PAGE', {
          signal,
          task: 'career-profile-repair',
          responseSchema: SCHEMA,
          responseValidator: () => {
            const error = new Error('A repair must make canonical progress.');
            error.code = 'CAREER_SNAPSHOT_PAGE_INVALID';
            error.validationDiagnostic = { stage: 'domain', reason: 'CAREER_PAGE_REPAIR_NO_PROGRESS', counts: {} };
            throw error;
          },
        }),
      }));
      const run = handler('bridge-paced-repair-workflow')({ sender }, { manualAiRunId: runId });
      const [request] = await waitFor(1);
      const rejected = await submitNonApiAiResponseForBridge({
        requestId: request.requestId, handoffCode: request.handoffCode, response: answer(request, 'unchanged'), ...allow,
      });
      const listed = listBridgeableNonApiAiHandoffs(allow);
      const read = readBridgeableNonApiAiHandoff({ requestId: request.requestId, handoffCode: request.handoffCode, ...allow });
      const bypass = await submitNonApiAiResponseForBridge({
        requestId: request.requestId, handoffCode: request.handoffCode, response: answer(request, 'unchanged again'), ...allow,
      });
      const [step] = await durableSteps(runId);
      assert(rejected.outcome === 'rejected' && rejected.retryAfterMs >= 1
        && listed.handoffs.length === 0 && listed.excluded.cooldown === 1 && listed.retryAfterMs >= 1
        && read.ok === false && read.reason === 'cooldown' && read.retryAfterMs >= 1
        && bypass.outcome === 'cooldown' && bypass.retryAfterMs >= 1
        && step?.status === 'pending' && step.retryRejectionCount === 1 && step.retryNotBefore > Date.now(),
      'a no-progress repair leaves a durable, timed checkpoint; list/read/submit cannot re-offer or bypass it');
      await handler('cancel-non-api-ai-request')({ sender }, { requestId: request.requestId });
      await new Promise(resolve => setTimeout(resolve, 850));
      assert(sent.filter(item => item.channel === 'non-api-ai-request').length === 1,
        'cancelling during a retry cooldown clears its timer instead of delivering a delayed reissue');
      await run.catch(() => {});
      return { persistedBackoff: true, cancellable: true };
    },
  },
  {
    name: 'non-API AI bridge seam: a recovered durable no-progress repair retains its retry deadline',
    run: async () => {
      const { sender, sent, waitFor } = freshHarness();
      const runId = `bridge-recovered-paced-repair-${process.pid}-${Date.now()}`;
      const allow = { allowTasks: new Set(['career-profile-repair']) };
      const firstAbort = new AbortController();
      const rejectNoProgress = () => {
        const error = new Error('A repair must make canonical progress.');
        error.code = 'CAREER_SNAPSHOT_PAGE_INVALID';
        error.validationDiagnostic = { stage: 'domain', reason: 'CAREER_PAGE_REPAIR_TARGET_MISSED', counts: {} };
        throw error;
      };
      handleSafe('bridge-recovered-paced-repair-seed', async () => ({
        value: await callLLMText('RECOVERED REPAIR', { signal: firstAbort.signal, task: 'career-profile-repair', responseSchema: SCHEMA, responseValidator: rejectNoProgress }),
      }));
      const seedRun = handler('bridge-recovered-paced-repair-seed')({ sender }, { manualAiRunId: runId });
      const [request] = await waitFor(1);
      await submitNonApiAiResponseForBridge({ requestId: request.requestId, handoffCode: request.handoffCode, response: answer(request, 'missed target'), ...allow });
      firstAbort.abort(new Error('simulated restart'));
      await seedRun.catch(() => {});
      // Drop the in-memory durable cache after the old record has settled. The
      // next workflow therefore proves the persisted checkpoint, not an old
      // record or timer, is what keeps the replacement handoff cooling.
      await __reloadDurableStateForTests();
      sent.length = 0;
      const resumedAbort = new AbortController();
      handleSafe('bridge-recovered-paced-repair-resume', async () => ({
        value: await callLLMText('RECOVERED REPAIR', { signal: resumedAbort.signal, task: 'career-profile-repair', responseSchema: SCHEMA, responseValidator: rejectNoProgress }),
      }));
      const resumed = handler('bridge-recovered-paced-repair-resume')({ sender }, { manualAiRunId: runId });
      let recovered = listBridgeableNonApiAiHandoffs(allow);
      for (let attempt = 0; recovered.pending !== 1 && attempt < 100; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 2));
        recovered = listBridgeableNonApiAiHandoffs(allow);
      }
      assert(sent.length === 0 && recovered.handoffs.length === 0 && recovered.excluded.cooldown === 1 && recovered.retryAfterMs >= 1,
        'a new process-equivalent durable read does not immediately replay a no-progress repair before its saved deadline');
      // An owning-operation abort remains immediate even though the request is
      // intentionally absent from the bridge's list/read projections.
      resumedAbort.abort(new Error('end recovered cooldown test'));
      await resumed.catch(() => {});
      await handler('complete-non-api-ai-run')({ sender }, { runId });
      return { recoveredCooldown: true };
    },
  },
  {
    name: 'non-API AI bridge seam: official posting research and comparative JSON judgment validate corrected answers through callLLMRaw',
    run: async () => {
      const { sender, waitFor } = freshHarness();
      const nodeId = 'bridge-seam-official-postings';
      const runId = `bridge-seam-official-postings-${process.pid}-${Date.now()}`;
      const job = { title: 'Platform Engineer', company: 'Acme Talent Partners', location: 'Lakeview, Canada',
        snippet: 'Maintain dependable platform services with documented delivery practices.', url: 'https://listing.example.test/platform' };
      const description = 'Maintain dependable platform services with documented engineering delivery practices.';
      const comparison = buildOfficialPostingMatchRequest({ job: { ...job, snippet: description }, run: 'A',
        options: [{ id: 'P1', title: job.title, location: job.location, status: 'live', description }] });
      const specs = [buildOfficialPostingResearchRequest([job]), comparison];
      handleSafe('bridge-seam-official-postings-workflow', async (_event, _args, signal) => ({
        values: await Promise.all(specs.map(({ prompt, ...options }) => callLLMRaw(prompt, { ...options, signal }))),
      }));
      const invoke = () => handler('bridge-seam-official-postings-workflow')({ sender }, { nodeId, manualAiRunId: runId });
      const run = invoke();
      const requests = await waitFor(2);
      assert(requests.every(request => request.runId === runId && request.nodeId === nodeId),
        'both task formats must retain the existing IPC ambient run and node scope through nested raw calls');
      const allowed = { allowTasks: new Set(specs.map(spec => spec.task)), allowNodeIds: new Set([nodeId]) };
      const listed = listBridgeableNonApiAiHandoffs(allowed);
      assert(listed.handoffs.length === 2 && requests.every(request => request.mcpEligible), 'both reviewed task contracts must ride the bridge');
      const research = requests.find(request => request.task === 'job-official-posting-research');
      const match = requests.find(request => request.task === 'job-official-posting-match');
      const identities = request => ({ requestId: request.requestId, handoffCode: request.handoffCode, ...allowed,
        ...(request.task === 'job-official-posting-match' ? { comparisonProvenance: { version: 2, transport: 'bridge', observed: true,
          ...comparison.manualHandoff, conversationKey: 'b'.repeat(64), isolated: false } } : {}) });
      assert(listed.handoffs.find(item => item.task === research.task)?.responseFormat === 'text'
        && listed.handoffs.find(item => item.task === match.task)?.responseFormat === 'json',
      'the narrow callLLMRaw match dispatch must use the schema-backed JSON route while grounded research stays raw text');
      const badResearch = await submitNonApiAiResponseForBridge({ ...identities(research), response: `Handoff: ${research.handoffCode}\n\nVERIFIED EMPLOYER: invented` });
      assert(readBridgeableNonApiAiHandoff(identities(match)).ok, 'the comparative judgment first receives trusted bridge conversation provenance');
      const badMatch = await submitNonApiAiResponseForBridge({ ...identities(match), response: JSON.stringify({ handoffCode: match.handoffCode,
        choice: 'P1', evidence: [{ scrapedQuote: 'Unique invented quoted content that never appears in either supplied description.', officialQuote: 'Unique invented quoted content that never appears in either supplied description.' }], distinguishing: [], conflicts: [] }) });
      assert(badResearch.outcome === 'rejected' && badResearch.isCorrection && /sections|marker/iu.test(badResearch.correction), 'malformed research must yield a section correction');
      assert(badMatch.outcome === 'rejected' && badMatch.isCorrection && /1 scraped/iu.test(badMatch.correction)
        && !badMatch.correction.includes('Unique invented'), 'a nonverbatim JSON answer must yield a source-free domain correction');
      for (const request of [research, match]) {
        const retry = readBridgeableNonApiAiHandoff(identities(request));
        assert(retry.ok && retry.isCorrection && retry.attempt === 2, 'both corrections remain bridge-eligible');
      }
      const id = officialPostingResearchId(job);
      const validResearch = `BEGIN OFFICIAL POSTING RESEARCH ${id}\nCANDIDATE: ${JSON.stringify({ careersPageUrl: 'https://careers.example.test/', postingUrl: 'https://jobs.ashbyhq.com/northwind-synthetic/platform', employer: 'Northwind Labs', employerDomain: 'https://northwind.example.test', ats: 'ashby' })}\nEND OFFICIAL POSTING RESEARCH ${id}`;
      const acceptedResearch = await submitNonApiAiResponseForBridge({ ...identities(research), response: `Handoff: ${research.handoffCode}\n\n${validResearch}` });
      const acceptedMatch = await submitNonApiAiResponseForBridge({ ...identities(match), response: JSON.stringify({ handoffCode: match.handoffCode, choice: 'none', evidence: [], distinguishing: [], conflicts: [] }) });
      assert(acceptedResearch.accepted && acceptedMatch.accepted, 'valid raw leads and a valid JSON miss must both accept');
      const completed = await run;
      assert(completed.values?.[0] === validResearch
        && completed.values?.[1]?.choice === 'none', 'the injected raw caller retains raw research and returns parsed JSON only for the new comparison task');
      const replay = await invoke();
      assert(replay.values?.[0] === validResearch && replay.values?.[1]?.choice === 'none'
        && (await waitFor(2)).length === 4, 'accepted tasks replay without emitting any new handoff requests');
      // waitFor counts correction reissues as requests too: two originals plus
      // one correction of each task are the complete delivered sequence.
      await handler('complete-non-api-ai-run')({ sender }, { runId });
    },
  },
  {
    name: 'non-API AI bridge seam: official posting Stop and timeout mark the actual handoff signal ending and retire the pending request',
    run: async () => {
      for (const mode of ['stop', 'timeout']) {
        const { sender, waitFor } = freshHarness();
        const nodeId = `bridge-seam-official-${mode}`;
        const runId = `${nodeId}-${process.pid}-${Date.now()}`;
        const controller = new AbortController(); let handoffSignal;
        const job = { title: 'Platform Engineer', company: 'Northwind Labs', location: 'Lakeview, Canada',
          snippet: 'Maintain dependable platform services using documented delivery practices.', url: 'https://listing.example.test/platform' };
        const channel = `bridge-seam-official-${mode}-workflow`;
        handleSafe(channel, async () => resolveOfficialPostings([job], {
          nodeId, manualAiRunId: runId, signal: controller.signal, timeoutMs: mode === 'timeout' ? 500 : 5000,
          resolve: async source => unresolvedOfficialPosting(source),
          store: { save: async (_source, result) => result },
          callRaw: (prompt, options) => { handoffSignal = options.signal; return callLLMRaw(prompt, options); },
        }));
        const run = handler(channel)({ sender }, { nodeId, manualAiRunId: runId });
        const [request] = await waitFor(1);
        const allowed = { allowTasks: new Set(['job-official-posting-research']), allowNodeIds: new Set([nodeId]) };
        const ids = { requestId: request.requestId, handoffCode: request.handoffCode, ...allowed };
        assert(listBridgeableNonApiAiHandoffs(allowed).handoffs.length === 1 && handoffSignal?.aborted === false,
          'the service must have a real eligible pending bridge request before cancellation');
        if (mode === 'stop') controller.abort(new Error('Synthetic run Stop'));
        // Keep the test process alive while the production timeout uses its
        // intentionally unrefed timer; this does not control its expiry.
        const keepAlive = setTimeout(() => {}, 1000);
        let completed;
        try { completed = await run; } finally { clearTimeout(keepAlive); }
        assert(handoffSignal.aborted && __bridgeExclusionReasonForTests({ sender, signal: handoffSignal }, allowed) === 'ending',
          'the actual request signal must meet the ending exclusion immediately after Stop or timeout');
        assert(listBridgeableNonApiAiHandoffs(allowed).pending === 0
          && readBridgeableNonApiAiHandoff(ids).ok === false,
        'an aborted service handoff must leave no bridge-readable pending record');
        assert((await submitNonApiAiResponseForBridge({ ...ids, response: `Handoff: ${request.handoffCode}\n\nlate answer` })).outcome === 'not_pending',
          'a late response to a stopped or expired request must never revive it');
        const code = mode === 'stop' ? 'bridge-aborted' : 'bridge-timeout';
        assert(completed.jobs[0].officialPosting.trail.includes(code), 'the resolver falls back with the exact bounded cancellation reason');
        await handler('complete-non-api-ai-run')({ sender }, { runId });
      }
    },
  },
  {
    name: 'non-API AI bridge seam: only structured or reviewed validated research text is listed, and the allowlist cannot unlock structural exclusions',
    run: async () => {
      const { sender, waitFor } = freshHarness();
      const nodeId = 'bridge-seam-eligibility';
      handleSafe('bridge-seam-eligibility-workflow', async (_event, _args, signal) => ({
        values: await Promise.all([
          requestNonApiAi({ prompt: 'OK', task: TASK, responseSchema: SCHEMA, batch: 1, batchTotal: 7, signal }),
          requestNonApiAi({ prompt: 'WITH FILE', task: 'vision-product-analysis', responseSchema: SCHEMA, attachmentPaths: ['/Users/private/photo.png'], signal }),
          requestNonApiAi({ prompt: 'WEB', task: 'job-compensation-research', responseSchema: SCHEMA, grounding: true, signal }),
          requestNonApiAi({ prompt: 'OTHER TASK', task: 'price-synthesis', responseSchema: SCHEMA, signal }),
          requestNonApiAi({ prompt: 'DRAFTED', task: TASK, responseSchema: SCHEMA, initialResponse: 'PRIVATE_DRAFT_TEXT typed by the person', batch: 5, batchTotal: 7, signal }),
          requestNonApiAi({ prompt: 'SCHEMALESS', task: TASK, requestKind: 'raw-text', signal }),
          requestNonApiAi({
            prompt: 'VALIDATED RAW', task: 'job-preference-research', requestKind: 'raw-text', grounding: true, signal,
            responseValidator: value => { if (!value.includes('research evidence')) throw new Error(PRIVATE); },
          }),
        ]),
      }));
      const run = handler('bridge-seam-eligibility-workflow')({ sender }, { nodeId });
      const requests = await waitFor(7);
      const by = (text) => requests.find(request => request.prompt.includes(text));
      const everything = { allowTasks: new Set([TASK, 'vision-product-analysis', 'job-compensation-research', 'job-preference-research', 'price-synthesis']), allowNodeIds: new Set([nodeId]) };
      const listed = listBridgeableNonApiAiHandoffs(everything);
      const rawEntry = listed.handoffs.find(item => item.task === 'job-preference-research');
      assert(by('OK').mcpEligible === true && by('WEB').mcpEligible === true && by('OTHER TASK').mcpEligible === true
        && by('VALIDATED RAW').mcpEligible === true && by('WITH FILE').mcpEligible === false
        && by('SCHEMALESS').mcpEligible === false && by('DRAFTED').mcpEligible === false,
      'public requests carry a fixed main-owned MCP route for reviewed structured/raw text and an explicit manual route for attachments, unsafe raw text, and legacy drafts');
      assert(listed.handoffs.length === 4 && listed.handoffs.some(item => item.task === 'price-synthesis') && listed.handoffs.some(item => item.task === 'job-compensation-research') && listed.handoffs.some(item => item.batch === 1) && rawEntry?.responseFormat === 'text', 'structured handoffs and the exact reviewed validated raw-research contract are bridgeable');
      assert(listed.handoffs.filter(item => item.task !== 'job-preference-research').every(item => item.responseFormat === 'json'), 'structured seam entries use only the closed json response format');
      assert(listed.excluded.attachment === 1 && listed.excluded.free_text === 1 && listed.excluded.person_editing === 1 && !('grounded' in listed.excluded), 'each exclusion counted once under its own reason, and grounding is no longer one of them');
      assert(listBridgeableNonApiAiHandoffs().handoffs.length === 0 && listBridgeableNonApiAiHandoffs().excluded.task_not_allowed === 4, 'no allowlist offers nothing');
      const otherHub = listBridgeableNonApiAiHandoffs({ ...ALLOW, allowNodeIds: new Set(['another-hub']) });
      assert(otherHub.handoffs.length === 0 && otherHub.excluded.node_not_allowed === 1, 'an unselected hub offers nothing');
      const serialized = JSON.stringify(listed);
      assert(!serialized.includes('PRIVATE_DRAFT_TEXT') && !serialized.includes('/Users/private') && !serialized.includes('"prompt"'), 'the list carries no prompt, draft or path');
      const drafted = readBridgeableNonApiAiHandoff({ requestId: by('DRAFTED').requestId, handoffCode: by('DRAFTED').handoffCode, ...ALLOW });
      const attachment = readBridgeableNonApiAiHandoff({ requestId: by('WITH FILE').requestId, handoffCode: by('WITH FILE').handoffCode, ...everything });
      const rawRead = readBridgeableNonApiAiHandoff({ requestId: by('VALIDATED RAW').requestId, handoffCode: by('VALIDATED RAW').handoffCode, ...everything });
      assert(drafted.reason === 'person_editing' && attachment.reason === 'attachment', 'reading re-applies the immutable route and structural rules');
      assert(rawRead.ok && rawRead.responseFormat === 'text' && rawRead.prompt.includes('Expected response format: free text'), 'raw research read carries its closed format with the unchanged dock prompt');
      const rawAccepted = await submitNonApiAiResponseForBridge({
        requestId: by('VALIDATED RAW').requestId,
        handoffCode: by('VALIDATED RAW').handoffCode,
        response: `Handoff: ${by('VALIDATED RAW').handoffCode}\n\nvalidated research evidence`,
        ...everything,
      });
      assert(rawAccepted.accepted === true, 'validated grounded research uses the same shared acceptance path');
      const refused = await submitNonApiAiResponseForBridge({ requestId: by('WITH FILE').requestId, handoffCode: by('WITH FILE').handoffCode, response: answer(by('WITH FILE')), ...everything });
      assert(refused.outcome === 'ineligible' && refused.exclusion === 'attachment', 'submitting to an attachment handoff is refused untouched');
      assert(BRIDGE_EXCLUSION_REASONS.every(reason => reason in listed.excluded), 'every reason is reported');
      assert(BRIDGE_RAW_RESEARCH_TASKS.join() === 'job-compensation-research,job-compensation-research-batch,job-preference-research,job-preference-research-batch,interview-brief-research,job-official-posting-research', 'raw bridge eligibility remains an exact reviewed task set');
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
        handoffs: tasks.map((task, index) => ({ prompt: `TASK SWEEP ${index}`, task, responseSchema: SCHEMA, batch: index + 1, batchTotal: tasks.length, itemCount: 1,
          ...(task === 'job-official-posting-match' ? { comparisonGroup: 'd'.repeat(64), comparisonRun: 'A' } : {}) })),
      });
      const requests = await waitFor(tasks.length);
      const selected = listBridgeableNonApiAiHandoffs({ allowTasks: new Set([TASK]), allowNodeIds: new Set([nodeId]) });
      assert(selected.handoffs.length === 1 && selected.handoffs[0].task === TASK, 'only the explicitly allowlisted task is bridgeable');
      assert(selected.excluded.task_not_allowed === tasks.length - 1, 'every other known task is default-denied');
      const allAllowed = listBridgeableNonApiAiHandoffs({ allowTasks: new Set(tasks), allowNodeIds: new Set([nodeId]) });
      const reviewed = tasks.filter(task => BRIDGE_RELEASE_ONE_TASKS.includes(task));
      assert(allAllowed.handoffs.map(entry => entry.task).sort().join('\n') === reviewed.join('\n')
        && allAllowed.excluded.task_not_allowed === tasks.length - reviewed.length,
      'the immutable route keeps never and unreviewed tasks out even when a caller passes an overly broad allowlist');
      await cancelAll(sender, requests);
      await run.catch(() => {});
    },
  },
  {
    name: 'non-API AI bridge seam: exact sender-window and node consent prevents same-node cross-window borrowing',
    run: async () => {
      const { sender, waitFor } = freshHarness();
      const otherSent = [];
      const otherSender = { id: sender.id + 1, isDestroyed: () => false, once: () => {}, removeListener: () => {}, send: (channel, payload) => otherSent.push({ channel, payload }) };
      const nodeId = 'bridge-seam-window-collision';
      handleSafe('bridge-seam-window-one', async (_event, _args, signal) => ({ value: await requestNonApiAi({ prompt: 'WINDOW ONE', task: TASK, responseSchema: SCHEMA, signal }) }));
      handleSafe('bridge-seam-window-two', async (_event, _args, signal) => ({ value: await requestNonApiAi({ prompt: 'WINDOW TWO', task: TASK, responseSchema: SCHEMA, signal }) }));
      const oneRun = handler('bridge-seam-window-one')({ sender }, { nodeId });
      const twoRun = handler('bridge-seam-window-two')({ sender: otherSender }, { nodeId });
      const [one] = await waitFor(1);
      let two;
      for (let attempt = 0; attempt < 100 && !two; attempt += 1) {
        two = otherSent.find(item => item.channel === 'non-api-ai-request')?.payload;
        if (!two) await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert(two, 'the second same-node window has its own pending handoff');
      const allow = { ...ALLOW, allowNodeIds: new Set([nodeId]), allowWindowNodePairs: new Set([`${sender.id}\u0000${nodeId}`]) };
      const listed = listBridgeableNonApiAiHandoffs(allow);
      assert(listed.handoffs.length === 1 && listed.handoffs[0].requestId === one.requestId, 'list offers only the selected sender/window despite a matching node id');
      assert((await readBridgeableNonApiAiHandoff({ requestId: two.requestId, handoffCode: two.handoffCode, ...allow })).reason === 'node_not_allowed', 'read applies the same exact-window gate');
      assert((await submitNonApiAiResponseForBridge({ requestId: two.requestId, handoffCode: two.handoffCode, response: answer(two), ...allow })).outcome === 'ineligible', 'submit atomically rejects the other window before it can settle');
      assert((await submitNonApiAiResponseForBridge({ requestId: one.requestId, handoffCode: one.handoffCode, response: answer(one), ...allow })).accepted, 'the authorized sender/window still accepts normally');
      await oneRun;
      await handler('cancel-non-api-ai-request')({ sender: otherSender }, { requestId: two.requestId });
      await twoRun.catch(() => {});
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
    name: 'non-API AI bridge seam: pending-registry wake-ups fire after delivery and settlement without exposing a record',
    async run() {
      const { sender, waitFor } = freshHarness();
      let notifications = 0;
      const stop = onNonApiAiEvent(() => { notifications += 1; });
      try {
        const run = startWorkflow({ sender, nodeId: 'bridge-seam-wakeup', runId: `bridge-seam-wakeup-${process.pid}`, handoffs: [{ prompt: 'WAKE', batch: 1, batchTotal: 1, itemCount: 1 }] });
        const [request] = await waitFor(1);
        assert(notifications === 1, 'the delivered pending request wakes observers exactly once');
        const result = await submitNonApiAiResponseForBridge({ requestId: request.requestId, handoffCode: request.handoffCode, response: answer(request), ...ALLOW, allowNodeIds: new Set(['bridge-seam-wakeup']) });
        assert(result.accepted === true && notifications === 2, 'settlement wakes observers after the request has left the pending registry');
        await run;
      } finally { stop(); }
    },
  },
  {
    name: 'non-API AI bridge seam: MCP-routed work rejects renderer manual takeover',
    async run() {
      const copied = [];
      const { sender, waitFor } = freshHarness({ clipboard: { writeText: value => copied.push(value) } });
      const nodeId = 'bridge-seam-manual-takeover';
      const run = startWorkflow({ sender, nodeId, runId: `bridge-seam-manual-takeover-${process.pid}`, handoffs: [{ prompt: 'MANUAL TAKEOVER', batch: 1, batchTotal: 1, itemCount: 1 }] });
      const [request] = await waitFor(1);
      let notifications = 0;
      const stop = onNonApiAiEvent(() => { notifications += 1; });
      try {
        const first = await handler('claim-non-api-ai-manual')({ sender }, { requestId: request.requestId });
        const second = await handler('claim-non-api-ai-manual')({ sender }, { requestId: request.requestId });
        const draft = await handler('update-non-api-ai-draft')({ sender }, { requestId: request.requestId, response: '{"answer":"bypass"}' });
        const localSubmit = await handler('submit-non-api-ai-response')({ sender }, { requestId: request.requestId, response: answer(request) });
        const allow = { ...ALLOW, allowNodeIds: new Set([nodeId]) };
        const listed = listBridgeableNonApiAiHandoffs(allow);
        const bridge = await submitNonApiAiResponseForBridge({ requestId: request.requestId, handoffCode: request.handoffCode, response: answer(request), ...allow });
        assert(first.claimed === false && second.claimed === false && draft.saved === false
          && localSubmit.accepted === false && localSubmit.validationErrors?.[0]?.includes('ChatGPT plugin')
          && notifications === 1 && copied.length === 0,
        'renderer IPC cannot claim, draft, or submit a reviewed MCP handoff');
        assert(listed.handoffs.some(item => item.requestId === request.requestId) && listed.excluded.person_editing === 0
          && bridge.accepted === true,
        'the plugin remains the sole answer path and can settle the same request');
      } finally {
        stop();
        await cancelAll(sender, [request]);
        await run.catch(() => {});
      }
    },
  },
  {
    name: 'non-API AI bridge seam: manual-only tasks retain clipboard failure recovery',
    async run() {
      for (const [label, clipboard] of [
        ['unavailable', null],
        ['rejected', { writeText() { throw new Error('synthetic clipboard refusal'); } }],
      ]) {
        const { sender, waitFor } = freshHarness({ clipboard });
        const nodeId = `bridge-seam-clipboard-${label}`;
        const run = startWorkflow({ sender, nodeId, runId: `${nodeId}-${process.pid}`, handoffs: [{ task: 'test-manual-clipboard', prompt: `CLIPBOARD ${label}`, batch: 1, batchTotal: 1, itemCount: 1 }] });
        const [request] = await waitFor(1);
        let notifications = 0;
        const stop = onNonApiAiEvent(() => { notifications += 1; });
        try {
          const result = await handler('claim-non-api-ai-manual')({ sender }, { requestId: request.requestId });
          const listed = listBridgeableNonApiAiHandoffs({ allowTasks: new Set(['test-manual-clipboard']), allowNodeIds: new Set([nodeId]) });
          assert(result.claimed === false && result.copied === false && result.code === 'CLIPBOARD_FAILED'
            && notifications === 0 && !listed.handoffs.some(item => item.requestId === request.requestId)
            && listed.excluded.task_not_allowed === 1,
          `${label} clipboard failure keeps an explicitly manual task local without mutating its state`);
        } finally {
          stop();
          await cancelAll(sender, [request]);
          await run.catch(() => {});
        }
      }
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
      assert(ipcHandler.includes('await acceptNonApiAiResponse(record, args)')
        && bridgeSubmit.includes("await acceptNonApiAiResponse(record, { response }, { transport: 'bridge' })")
        && !source.includes('args.transport'),
      'the renderer uses the default accept body while only the internal bridge supplies its trusted transport marker');
      assert((source.match(/updateDurableStep\(record, \{ status: 'accepted'/g) || []).length === 1, 'exactly one accepted-commit site');
      const beforeCall = bridgeSubmit.slice(0, bridgeSubmit.indexOf('await acceptNonApiAiResponse')).split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
      assert(!beforeCall.includes('await '), 'no await between the eligibility checks and the accept body');
      const seam = between('// ── In-process bridge seam', 'export function registerNonApiAiHandlers(');
      assert(!/\.message|\.stack|validationErrors|validationError\b/.test(seam.replace(/record\.validationError\b/g, '')), 'the seam never reads an error message');
      assert(source.split('\n').filter(line => /Rejected response for task|Ignoring invalid (legacy )?saved response/.test(line)).length === 3, 'the exactly-three log-line pin holds');
    },
  },
  {
    name: 'non-API AI bridge seam: validator-vouched correction lines reach the answering chat; plain messages, receipts and logs never carry them',
    run: async () => {
      const { sender, sent, waitFor } = freshHarness();
      const runId = `bridge-correction-details-${process.pid}-${Date.now()}`;
      const allow = { allowTasks: new Set(['career-profile-repair']) };
      const RULE = 'achievements[p0002-achievement-41].technologyReferences[5].technology is not literally grounded in its cited source segment(s).';
      const logStart = getRecentLogs().length;
      handleSafe('bridge-correction-details-workflow', async (_event, _args, signal) => ({
        value: await callLLMText('REPAIR WITH VOUCHED DETAILS', {
          signal,
          task: 'career-profile-repair',
          responseSchema: SCHEMA,
          responseValidator: (value) => {
            if (value.answer === 'fixed') return;
            const error = new Error(`${PRIVATE} ${RULE}`);
            error.code = 'CAREER_SNAPSHOT_PAGE_INVALID';
            error.validationDiagnostic = { stage: 'domain', reason: 'CAREER_PAGE_VALIDATION_FAILED', counts: {} };
            if (value.answer === 'vouched') error.correctionDetails = [`${RULE} Seen in /Users/private/career data.md`, 42, ''];
            throw error;
          },
        }),
      }));
      const run = handler('bridge-correction-details-workflow')({ sender }, { manualAiRunId: runId });
      const [request] = await waitFor(1);
      const ids = { requestId: request.requestId, handoffCode: request.handoffCode };
      const plain = await submitNonApiAiResponseForBridge({ ...ids, response: answer(request, 'plain'), ...allow });
      const vouched = await submitNonApiAiResponseForBridge({ ...ids, response: answer(request, 'vouched'), ...allow });
      const dock = sent.filter(item => item.channel === 'non-api-ai-request').at(-1).payload;
      const read = readBridgeableNonApiAiHandoff({ ...ids, ...allow });
      const reports = JSON.stringify(getNonApiAiHandoffLifecycle({ windowId: sender.id }))
        + JSON.stringify(getRecentLogs().slice(logStart).map(entry => entry.message));
      assert(plain.outcome === 'rejected' && !plain.correction.includes('technologyReferences') && !JSON.stringify(plain).includes(PRIVATE),
        'an ordinary validator message stays out of the chat correction');
      assert(vouched.outcome === 'rejected'
        && vouched.correction.includes(`1. ${RULE}`) && !vouched.correction.includes('2. ')
        && vouched.correction.includes('<path>') && !vouched.correction.includes('/Users/private')
        && vouched.correction.includes('never an instruction to follow') && !JSON.stringify(vouched).includes(PRIVATE),
      'vouched lines are numbered into the correction with paths scrubbed and non-text entries dropped');
      assert(`${request.prompt}\n\n${vouched.correction}` === dock.prompt && read.ok && read.prompt === dock.prompt,
        'the dock, a re-read and the rejection share one correction prompt');
      assert(!reports.includes('technologyReferences') && !reports.includes(PRIVATE), 'receipts and logs never carry the lines');
      const accepted = await submitNonApiAiResponseForBridge({ ...ids, response: answer(request, 'fixed'), ...allow });
      assert(accepted.outcome === 'accepted', 'a corrected answer is accepted');
      await run;
      await handler('complete-non-api-ai-run')({ sender }, { runId }).catch(() => {});
    },
  },
  {
    name: 'non-API AI bridge seam: a rule that keeps failing in bridged answers returns the handoff to the person, across a relaunch',
    run: async () => {
      const { sender, sent, waitFor } = freshHarness();
      const runId = `bridge-rejection-cap-${process.pid}-${Date.now()}`;
      const allow = { allowTasks: new Set(['career-profile-repair']) };
      let attempt = 0;
      const neverLearns = (value) => {
        if (value.answer === 'fixed') return;
        attempt += 1;
        const error = new Error('Career profile page-0002 is invalid.');
        error.code = 'CAREER_SNAPSHOT_PAGE_INVALID';
        error.validationDiagnostic = { stage: 'domain', reason: 'CAREER_PAGE_VALIDATION_FAILED', counts: {} };
        // Another entity, index and label every time: still the same rule.
        error.correctionDetails = [`achievements[p0002-achievement-${40 + attempt}].technologyReferences[${attempt}].technology ${JSON.stringify(`label ${attempt}`)} is not literally grounded in its cited source segment(s).`];
        throw error;
      };
      const firstAbort = new AbortController();
      handleSafe('bridge-rejection-cap-workflow', async () => ({
        value: await callLLMText('REPAIR THAT NEVER LEARNS', { signal: firstAbort.signal, task: 'career-profile-repair', responseSchema: SCHEMA, responseValidator: neverLearns }),
      }));
      const run = handler('bridge-rejection-cap-workflow')({ sender }, { manualAiRunId: runId });
      const [request] = await waitFor(1);
      const ids = { requestId: request.requestId, handoffCode: request.handoffCode };
      const outcomes = [];
      for (let index = 0; index < 5; index += 1) {
        outcomes.push(await submitNonApiAiResponseForBridge({ ...ids, response: answer(request, `attempt ${index}`), ...allow }));
      }
      const dock = sent.filter(item => item.channel === 'non-api-ai-request').at(-1).payload;
      const listed = listBridgeableNonApiAiHandoffs(allow);
      const read = readBridgeableNonApiAiHandoff({ ...ids, ...allow });
      const late = await submitNonApiAiResponseForBridge({ ...ids, response: answer(request, 'too late'), ...allow });
      const [step] = await durableSteps(runId);
      const receipt = getNonApiAiHandoffLifecycle({ windowId: sender.id }).at(-1);
      assert(outcomes.slice(0, 4).every(outcome => outcome.outcome === 'rejected')
        && outcomes[4].outcome === 'rejection_cap' && outcomes[4].validationCode === 'CAREER_SNAPSHOT_PAGE_INVALID',
      `the fifth answer failing the same rule returns the handoff (got ${outcomes.map(outcome => outcome.outcome).join(',')})`);
      assert(dock.requestId === request.requestId && dock.mcpEligible === false && dock.isCorrection === true
        && dock.validationError.includes('page-0002') && dock.prompt.includes('is not literally grounded'),
      'the dock receives it with the precise message and the correction');
      assert(listed.pending === 1 && listed.handoffs.length === 0 && read.ok === false && late.outcome === 'ineligible',
        'the bridge can no longer serve or accept it');
      assert(step?.status === 'pending' && step.bridgeEscalation === 'rejection_cap'
        && Object.values(step.bridgeRejectionCauses || {}).includes(5),
      'the escalation and its cause count are durable');
      assert(receipt?.escalated === 'rejection_cap' && receipt.escalatedAfterRejections === 5
        && receipt.failures.at(-1).causeRepeats === 5 && /^[a-f0-9]{8}$/.test(receipt.failures[0].causeTag)
        && receipt.failures.every(failure => failure.causeTag === receipt.failures[0].causeTag),
      'the receipt shows one repeated cause and the escalation');
      const markdown = buildNonApiAiHandoffLifecycleMarkdown(new Set(), sender.id);
      assert(markdown.includes('**returned to the person** (`rejection_cap`') && markdown.includes('after 5 rejection(s)')
        && /cause `[a-f0-9]{8}` ×5/.test(markdown) && !markdown.includes('label 5') && !markdown.includes('not literally grounded'),
      'the bug report shows the repeated cause and the escalation, never the rule text');
      firstAbort.abort(new Error('simulated restart'));
      await run.catch(() => {});
      await __reloadDurableStateForTests();
      sent.length = 0;
      handleSafe('bridge-rejection-cap-resume', async (_event, _args, signal) => ({
        value: await callLLMText('REPAIR THAT NEVER LEARNS', { signal, task: 'career-profile-repair', responseSchema: SCHEMA, responseValidator: neverLearns }),
      }));
      const resumed = handler('bridge-rejection-cap-resume')({ sender }, { manualAiRunId: runId });
      const [again] = await waitFor(1);
      assert(again.mcpEligible === false && listBridgeableNonApiAiHandoffs(allow).handoffs.length === 0,
        'a relaunch keeps the handoff with the person');
      const pasted = await handler('submit-non-api-ai-response')({ sender }, { requestId: again.requestId, response: answer(again, 'fixed') });
      await resumed;
      const [settled] = await durableSteps(runId);
      assert(pasted.accepted === true && settled?.status === 'accepted' && settled.bridgeEscalation === null && settled.bridgeRejectionCauses === null,
        'the person can finish it from the dock, which clears the escalation');
      await handler('complete-non-api-ai-run')({ sender }, { runId }).catch(() => {});
    },
  },
  {
    name: 'non-API AI bridge seam: bridged answers that keep changing what fails are never capped',
    run: async () => {
      const { sender, waitFor } = freshHarness();
      const runId = `bridge-changing-causes-${process.pid}-${Date.now()}`;
      const allow = { allowTasks: new Set(['career-profile-repair']) };
      const rules = {
        a: 'achievements[p0002-achievement-41].technologyReferences[2].technology is not literally grounded in its cited source segment(s).',
        b: 'achievements[p0002-achievement-42].technologyReferences relationship group "g" must retain one shared literal relationship evidence slice.',
        c: 'skills[p0002-skill-x].supportMode must be direct or relationship-qualified.',
        d: 'projects[p0002-project-43].technologyReferences[1].relationshipEvidence must be a literal source slice grounded in its cited segment(s).',
      };
      handleSafe('bridge-changing-causes-workflow', async (_event, _args, signal) => ({
        value: await callLLMText('REPAIR THAT KEEPS LEARNING', {
          signal,
          task: 'career-profile-repair',
          responseSchema: SCHEMA,
          responseValidator: (value) => {
            if (value.answer === 'fixed') return;
            const error = new Error('Career profile page-0002 is invalid.');
            error.code = 'CAREER_SNAPSHOT_PAGE_INVALID';
            error.validationDiagnostic = { stage: 'domain', reason: 'CAREER_PAGE_VALIDATION_FAILED', counts: {} };
            error.correctionDetails = value.answer.split('').map(key => rules[key]);
            throw error;
          },
        }),
      }));
      const run = handler('bridge-changing-causes-workflow')({ sender }, { manualAiRunId: runId });
      const [request] = await waitFor(1);
      const ids = { requestId: request.requestId, handoffCode: request.handoffCode };
      // Each rule fails in at most four answers, so the same-cause limit is
      // never reached however many rejections the handoff accumulates.
      const outcomes = [];
      for (const failing of ['abcd', 'abc', 'bcd', 'ad', 'c', 'b', 'd', 'a']) {
        outcomes.push((await submitNonApiAiResponseForBridge({ ...ids, response: answer(request, failing), ...allow })).outcome);
      }
      const accepted = await submitNonApiAiResponseForBridge({ ...ids, response: answer(request, 'fixed'), ...allow });
      assert(outcomes.every(outcome => outcome === 'rejected') && accepted.outcome === 'accepted',
        `eight rejections without a fifth repeat of any rule stay with the chat (got ${outcomes.join(',')})`);
      await run;
      await handler('complete-non-api-ai-run')({ sender }, { runId }).catch(() => {});
    },
  },
  {
    name: 'W3 repro R1: rotating non-digit finding names under one declared rule id cap the bridged handoff on the fifth rejection',
    run: async () => {
      const { sender, waitFor } = freshHarness();
      const runId = `w3-repro-r1-${process.pid}-${Date.now()}`;
      const allow = { allowTasks: new Set(['career-profile-repair']) };
      const NAMES = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
      let n = 0;
      handleSafe('w3-repro-r1-workflow', async (_event, _args, signal) => ({
        value: await callLLMText('W3 R1 REPAIR WITH ROTATING NAMES', {
          signal,
          task: 'career-profile-repair',
          responseSchema: SCHEMA,
          responseValidator: (v) => {
            if (v.answer === 'fixed') return;
            const e = new Error('x');
            e.code = 'CAREER_SNAPSHOT_AUDIT_INVALID';
            e.correctionDetails = [`finding ${NAMES[n++ % 6]} sourceQuote is not a verbatim quote of its cited segments segment-0001; copy the exact source text or drop the finding.`];
            e.correctionRuleIds = ['AUDIT_QUOTE_NOT_VERBATIM'];
            throw e;
          },
        }),
      }));
      const run = handler('w3-repro-r1-workflow')({ sender }, { manualAiRunId: runId });
      const [request] = await waitFor(1);
      const ids = { requestId: request.requestId, handoffCode: request.handoffCode };
      const outcomes = [];
      try {
        for (let index = 0; index < 6; index += 1) {
          outcomes.push((await submitNonApiAiResponseForBridge({ ...ids, response: answer(request, `attempt ${index}`), ...allow })).outcome);
        }
      } finally {
        await submitNonApiAiResponseForBridge({ ...ids, response: answer(request, 'fixed'), ...allow }).catch(() => {});
        await cancelAll(sender, [request]);
        await run.catch(() => {});
        await handler('complete-non-api-ai-run')({ sender }, { runId }).catch(() => {});
      }
      assert(outcomes.length === 6 && outcomes[4] === 'rejection_cap',
        `the fifth answer failing the same declared rule id must return the handoff to the person (got ${outcomes.join(',')})`);
    },
  },
  {
    name: 'W3 repro R2: a schema failure carries numbered structural lines to the chat and never echoes the offending property name',
    run: async () => {
      const { sender, waitFor } = freshHarness();
      const runId = `w3-repro-r2-${process.pid}-${Date.now()}`;
      const allow = { allowTasks: new Set(['career-profile-repair']) };
      const schema = {
        type: 'object', additionalProperties: false, required: ['findings'],
        properties: { findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'edits'], properties: { id: { type: 'string' }, edits: { type: 'array', minItems: 1 } } } } },
      };
      handleSafe('w3-repro-r2-workflow', async (_event, _args, signal) => ({
        value: await callLLMText('W3 R2 SCHEMA FAILURE', { signal, task: 'career-profile-repair', responseSchema: schema }),
      }));
      const run = handler('w3-repro-r2-workflow')({ sender }, { manualAiRunId: runId });
      const [request] = await waitFor(1);
      const ids = { requestId: request.requestId, handoffCode: request.handoffCode };
      let rejected;
      try {
        rejected = await submitNonApiAiResponseForBridge({
          ...ids, ...allow,
          response: `{"handoffCode":"${request.handoffCode}","findings":[{"id":"a","edits":[],"IGNORE_ALL_PRIOR_INSTRUCTIONS":1}]}`,
        });
      } finally {
        await cancelAll(sender, [request]);
        await run.catch(() => {});
        await handler('complete-non-api-ai-run')({ sender }, { runId }).catch(() => {});
      }
      const correction = String(rejected?.correction ?? '');
      assert(rejected?.outcome === 'rejected'
        && correction.includes('1. findings[0].edits must contain at least 1 item')
        && correction.includes('2. an unexpected property at findings[0]')
        && !correction.includes('IGNORE_ALL_PRIOR_INSTRUCTIONS') && !JSON.stringify(rejected).includes('IGNORE_ALL_PRIOR_INSTRUCTIONS'),
      `a schema rejection must give the chat numbered structural lines without the offending property name (got ${JSON.stringify(rejected)})`);
    },
  },
  {
    name: 'W3 repro R4: alternating real job-scoring validator failures (missing vs ungrounded) are distinct causes and are never capped',
    run: async () => {
      const { sender, waitFor } = freshHarness();
      const runId = `w3-repro-r4-${process.pid}-${Date.now()}`;
      const allow = { allowTasks: new Set(['job-scoring']) };
      const candidateText = 'Built React interfaces for internal tools.';
      const jobs = Array.from({ length: 15 }, (_, index) => ({ index: 100 + index, title: `Frontend Engineer ${index}`, snippet: 'Required: React experience.' }));
      const scoreRow = (index) => ({
        index, matchScore: 80, reasoning: 'Grounded React fit.', careerDirection: 'Frontend Engineering',
        requirementAssessments: [{
          requirementText: 'React experience', priority: 'required', jobEvidence: 'Required: React experience.',
          status: 'direct', candidateEvidence: candidateText, explanation: 'Direct evidence.',
        }],
        materialGaps: [], confidence: 'high',
      });
      const allRows = Array.from({ length: 15 }, (_, index) => scoreRow(index));
      const ungroundedRow = {
        index: 0, matchScore: 95, reasoning: 'Strong fit.', careerDirection: 'Frontend',
        requirementAssessments: [], materialGaps: [], confidence: 'high', experienceAssessment: {},
      };
      const runReal = (scores) => validateJobScoringSubmission({ scores }, jobs, { candidateText, candidateRoles: [], requireComplete: true });
      const failures = {
        missing: () => runReal(allRows.filter(row => row.index !== 3)),
        ungrounded: () => runReal(allRows.map(row => (row.index === 0 ? ungroundedRow : row))),
      };
      const direct = Object.fromEntries(Object.entries(failures).map(([key, call]) => {
        try { call(); return [key, null]; } catch (error) { return [key, error]; }
      }));
      assert(direct.missing instanceof Error && direct.ungrounded instanceof Error && direct.missing.message !== direct.ungrounded.message,
        'the real scoring validator must reject both an omitted index and an ungrounded row, with different messages');
      handleSafe('w3-repro-r4-workflow', async (_event, _args, signal) => ({
        value: await callLLMText('W3 R4 SCORING', {
          signal,
          task: 'job-scoring',
          responseSchema: SCHEMA,
          responseValidator: (value) => {
            if (value.answer === 'fixed') return;
            if (!failures[value.answer]) throw new Error(`unexpected synthetic answer ${value.answer}`);
            failures[value.answer]();
          },
        }),
      }));
      const run = handler('w3-repro-r4-workflow')({ sender }, { manualAiRunId: runId });
      const [request] = await waitFor(1);
      const ids = { requestId: request.requestId, handoffCode: request.handoffCode };
      const outcomes = [];
      let accepted;
      try {
        for (let index = 0; index < 8; index += 1) {
          outcomes.push((await submitNonApiAiResponseForBridge({ ...ids, response: answer(request, index % 2 === 0 ? 'missing' : 'ungrounded'), ...allow })).outcome);
        }
        accepted = await submitNonApiAiResponseForBridge({ ...ids, response: answer(request, 'fixed'), ...allow });
      } finally {
        await cancelAll(sender, [request]);
        await run.catch(() => {});
        await handler('complete-non-api-ai-run')({ sender }, { runId }).catch(() => {});
      }
      assert(!outcomes.includes('rejection_cap') && outcomes.every(outcome => outcome === 'rejected') && accepted?.outcome === 'accepted',
        `eight alternating missing/ungrounded rejections (four each) must never cap, then the fixed answer is accepted (got ${outcomes.join(',')} then ${accepted?.outcome})`);
    },
  },
];
