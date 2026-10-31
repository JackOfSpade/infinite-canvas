import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { assert } from './testHelpers.js';
import { createFakeClock } from './fixtures/handoff-bridge/fakeClock.js';
import { faultAt, withLeakCheck } from './fixtures/handoff-bridge/harness.js';
import { getKnownTaskIds } from '../../electron/ipc/llm.js';
import { PUSH_TASK_POLICY, assertPushTaskPolicy, createPushSource as createPushSourcePort, normalizePushHandoffCode } from '../../electron/ipc/handoffBridge/sources/push.js';
import { createHandoffEngine } from '../../electron/ipc/handoffBridge/engine.js';
import { createObservedChatContext, hasLiveObservedWorker, hasPendingObservedWorkerLaunch } from '../../electron/ipc/handoffBridge/observedChatContext.js';
import { CONSTANTS } from '../../electron/ipc/handoffBridge/constants.js';
import { createHandoffCodeGuard } from '../../electron/ipc/handoffBridge/lanes.js';
import { TOOLS_LIST } from '../../electron/ipc/handoffBridge/tools.js';
import { BRIDGE_ATTACHMENT_TASKS, BRIDGE_ENABLED_ATTACHMENT_TASKS, BRIDGE_RAW_RESEARCH_TASKS } from '../../electron/ipc/nonApiAi.js';

const CODE = 'HANDOFF-ABCDEF';
const CLAIM = '22222222-2222-4222-8222-222222222222';
const entry = Object.freeze({ requestId: 'request-ada', bridgeClaimId: CLAIM, handoffCode: CODE, windowId: 71, nodeId: 'node-ada', runId: 'run-ada', task: 'job-scoring', promptChars: 42, codeEnforced: true });
const testHubKey = (canvasFilePath, nodeId) => createHash('sha256').update(canvasFilePath).update('\n').update(nodeId).digest('hex');
const codeGuard = createHandoffCodeGuard();
const createPushSource = (options = {}) => createPushSourcePort({ hubKey: testHubKey, codeGuard, ...options });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function makeSource({ entries = [entry], read = null, submit = null, active = () => [], now = () => 1000, autoSelectHubs = false } = {}) {
  const windows = new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }], [72, { __canvasFilePath: '/tmp/other.canvas' }]]);
  const seam = {
    list: async () => ({ handoffs: entries, excluded: {}, pending: entries.length }),
    read: async item => read ? read(item) : ({ ok: true, requestId: item.requestId, handoffCode: item.handoffCode, task: item.task, responseFormat: item.responseFormat, prompt: 'Synthetic Ada scoring prompt', isCorrection: false, correction: '', attempt: 1, validationCode: null, validationDiagnostic: null }),
    submit: async item => submit ? submit(item) : ({ outcome: 'accepted', accepted: true }),
  };
  const source = createPushSource({ seam, windows, hubKey: testHubKey, activeNodeTasks: active, now, autoSelectHubs, timers: { setTimeout(fn) { fn(); return { unref() {} }; } } });
  assert(source.selectHub({ windowId: 71, canvasFilePath: '/tmp/ada.canvas', nodeId: 'node-ada' }), 'synthetic hub must select');
  return { source, windows };
}

const APP_JOB = '11111111-1111-4111-8111-111111111111';
const APP_PATH = '/tmp/push-engine.canvas';
const LINK = 'push-engine-link';

async function makeEngine({ pushGet, pushSubmit, appRead, submitBudgetMs = 25_000, pushSource = null, now, timers } = {}) {
  const application = {
    read: appRead || (async () => ({ kind: 'open', handoff: { code: 'APP-CODE', stage: 'resume', revision: 1, prompt: 'Synthetic application prompt.' } })),
    status: async () => ({ kind: 'host' }),
    submit: async () => ({ kind: 'accepted', completed: true }),
  };
  const push = pushSource || {
    get: pushGet || (async () => ({ status: 'queue_empty', remaining: { ready: 0, working: 0, needsYou: 0 } })),
    submit: pushSubmit || (async () => ({ status: 'unknown_handoff' })),
    closeEpoch: () => undefined,
    status: () => ({ served: 0, held: 0, selectedHubs: 1, working: 0, needsYou: 0 }),
  };
  const engine = createHandoffEngine({ sources: { application, push }, random: () => Buffer.alloc(26, 7), holdMs: 0, submitBudgetMs, now, timers });
  assert((await engine.release({ jobs: [{ jobId: APP_JOB, canvasFilePath: APP_PATH }] })).ok, 'application lane must release');
  const chat = await engine.newChat({ linkId: LINK });
  return { engine, session: chat.sessionCode };
}

// W3 step 7: a push source whose seam logs hand-backs and counts real submits.
// `handBack` receives the seam arguments and may return, throw or reject.
const JUNK_RESPONSES = Object.freeze({
  junk: '{}',
  misrouted: JSON.stringify({ handoffCode: 'HANDOFF-ZZZZZZ', text: 'Synthetic answer stamped for another handoff' }),
  too_large: 'x'.repeat(1_000_001),
});
const VALID_RESPONSE = JSON.stringify({ handoffCode: CODE, text: 'Synthetic valid answer' });

async function makeHandBackSource({ handBack = async () => true, submit = async () => ({ outcome: 'accepted', accepted: true }) } = {}) {
  const log = { handBacks: [], seamSubmits: 0 };
  const source = createPushSource({
    seam: {
      list: async () => ({ handoffs: [entry], excluded: {}, pending: 1 }),
      read: async item => ({ ok: true, requestId: item.requestId, handoffCode: item.handoffCode, task: item.task, responseFormat: item.responseFormat,
        prompt: 'Synthetic Ada scoring prompt', isCorrection: false, correction: '', attempt: 1 }),
      submit: async item => { log.seamSubmits += 1; return submit(item); },
      handBack: args => { log.handBacks.push({ ...args }); return handBack(args); },
    },
    windows: new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }]]), hubKey: testHubKey,
    timers: { setTimeout(fn) { fn(); return { unref() {} }; } },
  });
  assert(source.selectHub({ windowId: 71, canvasFilePath: '/tmp/ada.canvas', nodeId: 'node-ada' }), 'synthetic hub must select');
  assert((await source.get()).status === 'served', 'the synthetic handoff must be served before any submit');
  return { source, log };
}

async function makeReservedSource(handBack) {
  const attached = { ...entry, task: 'vision-product-analysis', hasAttachments: true };
  const log = [];
  const source = createPushSource({
    experimentalAttachmentTasks: true,
    seam: {
      list: async () => ({ handoffs: [attached], excluded: {}, pending: 1 }),
      read: async () => ({ ok: true, requestId: attached.requestId, handoffCode: CODE, task: attached.task, responseFormat: 'json', prompt: 'Inspect the attached photo', attempt: 1 }),
      attachments: async () => ({ handoffCode: CODE, attachments: [{ name: 'item.png', mime: 'image/png', bytes: Buffer.from('photo') }] }),
      submit: async () => ({ outcome: 'accepted', accepted: true }),
      handBack: args => { log.push({ ...args }); return handBack(args); },
    },
    windows: new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }]]), hubKey: testHubKey,
  });
  assert(source.selectHub({ windowId: 71, canvasFilePath: '/tmp/ada.canvas', nodeId: 'node-ada' }), 'synthetic hub must select');
  source.setAllowedTasks(new Set(['vision-product-analysis']));
  assert((await source.prepareAttachment({ epoch: 'E', worker: 'worker-1' })).status === 'ready', 'worker 1 must hold the reservation');
  return { source, log };
}

const HAND_BACK_MODES = Object.freeze([
  { name: 'async false', handBack: async () => false, released: false },
  { name: 'sync false', handBack: () => false, released: false },
  { name: 'sync throw', handBack: () => { throw new Error('synthetic seam failure'); }, released: false },
  { name: 'async rejection', handBack: async () => { throw new Error('synthetic seam failure'); }, released: false },
  { name: 'truthy non-true', handBack: async () => 1, released: false },
  { name: 'async true', handBack: async () => true, released: true },
  { name: 'sync true', handBack: () => true, released: true },
]);

const COMPARISON_GROUP = 'a'.repeat(64);
function comparativeFixture({ firstRun = 'A', beforeRead = null, submit = null, now = Date.now } = {}) {
  const a = { ...entry, requestId: 'comparison-a', task: 'job-official-posting-match', comparisonGroup: COMPARISON_GROUP, comparisonRun: 'A' };
  const b = { ...a, requestId: 'comparison-b', handoffCode: 'HANDOFF-GHJKLM', comparisonRun: 'B' };
  let pending = [firstRun === 'A' ? a : b];
  const reads = [], submits = [], unavailable = [], requeues = [];
  const push = createPushSource({ seam: {
    comparativeUnavailable: args => { unavailable.push(args); return true; },
    requeue: args => { requeues.push(args); return true; },
    list: async () => ({ handoffs: pending, excluded: {}, pending: pending.length }),
    read: async args => {
      reads.push(args);
      if (beforeRead) await beforeRead(args);
      const item = pending.find(value => value.requestId === args.requestId);
      return { ok: true, handoffCode: item.handoffCode, task: item.task, prompt: `Synthetic comparative run ${item.comparisonRun}` };
    },
    submit: async args => {
      submits.push(args);
      if (submit) return submit(args, submits.length);
      pending = pending.find(item => item.requestId === args.requestId)?.comparisonRun === 'A' ? [b] : [];
      return { outcome: 'accepted' };
    },
  }, windows: new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }]]), activeNodeTasks: () => [], graceMs: 0, pollMs: 0, now });
  assert(push.selectHub({ windowId: 71, canvasFilePath: '/tmp/ada.canvas', nodeId: 'node-ada' }));
  return { push, reads, submits, unavailable, requeues, a, b, setPending: value => { pending = value; } };
}
const comparisonContext = (character, pristine = false, isCurrent = () => true) => ({ conversationKey: character.repeat(64), observed: true, pristine, isCurrent });
let observedChatOrdinal = 0;
async function observedNewChat(engine) {
  const observedId = `synthetic-observed-chat-${++observedChatOrdinal}`;
  return { ...await engine.newChat({ linkId: LINK, observation: createObservedChatContext(observedId) }), observedId };
}
function observeWorker(engine, starter) {
  assert(engine.beginObservedChat({ linkId: LINK, sessionCode: starter.sessionCode }));
  assert(engine.confirmObservedChat({ linkId: LINK, sessionCode: starter.sessionCode,
    observation: createObservedChatContext(`synthetic-observed-worker-${++observedChatOrdinal}`) }));
}
const comparativeEngine = push => createHandoffEngine({ sources: { push, application: {
  read: async () => ({ kind: 'gone' }), status: async () => ({ kind: 'gone' }), submit: async () => ({ kind: 'gone' }),
} }, scope: { applications: false, scoring: true, marketplace: false }, holdMs: 0 });

export default [
  ...['success', 'throw'].flatMap(oldReadResult => ['reserved', 'served'].map(replacementState => ({
    name: `comparative push: stale ${oldReadResult} reread cannot erase or contaminate ${replacementState} replacement ownership`,
    run: async () => {
      const oldStarted = deferred(); const oldHeld = deferred();
      const replacementStarted = deferred(); const replacementHeld = deferred();
      let holdOld = false;
      const { push, a, b, requeues } = comparativeFixture({ beforeRead: async args => {
        const key = args.comparisonProvenance.conversationKey;
        if (holdOld && key === '2'.repeat(64)) {
          oldStarted.resolve(); await oldHeld.promise;
          if (oldReadResult === 'throw') throw new Error('Synthetic obsolete prompt read failure');
        }
        if (replacementState === 'reserved' && key === '3'.repeat(64)) {
          replacementStarted.resolve(); await replacementHeld.promise;
        }
      } });
      const submit = (worker, character, code) => push.submit({ epoch: 'stale-reread', worker,
        comparisonContext: comparisonContext(character, true), handoffCode: code,
        response: JSON.stringify({ handoffCode: code, answer: 'valid' }) });
      await push.get({ epoch: 'stale-reread', worker: 'worker-1', comparisonContext: comparisonContext('1') });
      await submit('worker-1', '1', a.handoffCode);
      await push.get({ epoch: 'stale-reread', worker: 'worker-2', comparisonContext: comparisonContext('2') });
      holdOld = true;
      const stale = push.get({ epoch: 'stale-reread', worker: 'worker-2', comparisonContext: comparisonContext('2') });
      await oldStarted.promise;
      await submit('worker-2', '2', a.handoffCode);
      assert((await submit('worker-2', '2', b.handoffCode)).status === 'fresh_context_required' && requeues.length === 1);
      const replacement = push.get({ epoch: 'stale-reread', worker: 'worker-3', comparisonContext: comparisonContext('3', true) });
      if (replacementState === 'reserved') await replacementStarted.promise;
      else assert((await replacement).status === 'served');
      oldHeld.resolve();
      const obsolete = await stale;
      assert(obsolete.status !== 'served' && !Object.hasOwn(obsolete, 'prompt'), 'an obsolete reread never delivers its old prompt again');
      const claims = push.status('stale-reread').claimWorkers;
      assert(claims.length === 1 && claims[0].workerOrdinal === 3 && requeues.length === 1,
        'old read completion neither drops the new lease nor consumes its fresh-context retry budget');
      replacementHeld.resolve();
      assert((await replacement).status === 'served');
      assert((await submit('worker-3', '3', b.handoffCode)).status === 'accepted', 'the replacement still completes B with its own isolated proof');
    },
  }))),
  ...[false, true].map(existingFence => ({
    name: `comparative push: stale empty discovery cannot erase a ${existingFence ? 'newly extended' : 'new'} B recovery-context fence`,
    run: async () => {
      const fullRead = deferred(); const fullHeld = deferred();
      const b = { ...entry, requestId: 'refresh-recovery-b', task: 'job-official-posting-match',
        comparisonGroup: COMPARISON_GROUP, comparisonRun: 'B' };
      let pending = [b]; let holdFull = false; const requeues = [];
      const push = createPushSource({ seam: {
        list: async args => {
          if (holdFull && args.allowNodeIds === null) {
            fullRead.resolve(); await fullHeld.promise;
            return { handoffs: [], excluded: {} };
          }
          return { handoffs: pending, excluded: {} };
        },
        read: async args => ({ ok: true, handoffCode: args.handoffCode, task: b.task, prompt: 'Synthetic fresh-context B' }),
        requeue: args => { requeues.push(args); return true; },
        submit: async () => { pending = []; return { outcome: 'accepted' }; },
      }, windows: new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }]]), graceMs: 0, pollMs: 0 });
      assert(push.selectHub({ windowId: 71, canvasFilePath: '/tmp/ada.canvas', nodeId: 'node-ada' }));
      const get = character => push.get({ epoch: 'refresh-recovery', worker: 'worker-2', comparisonContext: comparisonContext(character, true) });
      if (existingFence) {
        assert((await get('1')).status === 'served');
        assert(push.requeueWorker({ epoch: 'refresh-recovery', worker: 'worker-2', reason: 'fresh-context-required' }) === 1);
      }
      assert((await get('2')).status === 'served');
      holdFull = true;
      const refresh = push.refreshHubs(); await fullRead.promise;
      assert(push.requeueWorker({ epoch: 'refresh-recovery', worker: 'worker-2', reason: 'worker-replaced' }) === 1);
      fullHeld.resolve();
      assert(await refresh, 'the stale full discovery completes after the new recovery fence exists');
      assert((await get('2')).status === 'fresh_context_required',
        'even a purported pristine observation of the recovered conversation cannot receive B again');
      if (existingFence) assert((await get('1')).status === 'fresh_context_required', 'extending the fence retains its earlier banned conversation');
      assert(requeues.length === (existingFence ? 2 : 1), 'checking a barred conversation never consumes another retry');
      const fresh = await push.get({ epoch: 'refresh-recovery', worker: 'worker-3', comparisonContext: comparisonContext('3', true) });
      assert(fresh.status === 'served' && fresh.handoffCode === b.handoffCode);
      assert((await push.submit({ epoch: 'refresh-recovery', worker: 'worker-3', comparisonContext: comparisonContext('3', true),
        handoffCode: b.handoffCode, response: JSON.stringify({ handoffCode: b.handoffCode, answer: 'valid' }) })).status === 'accepted');
    },
  })),
  ...['worker-lost', 'worker-replaced'].map(reason => ({
    name: `handoff bridge: push: simultaneous reserved comparative reads survive ${reason} and complete with their original identities`,
    run: async () => {
      const held = deferred(); const reading = [];
      const pending = Array.from({ length: 5 }, (_, index) => ({ ...entry,
        requestId: `reserved-comparison-${index}`, bridgeClaimId: `reserved-claim-${index}`,
        handoffCode: `HANDOFF-AAAAA${'BCDEF'[index]}`, task: 'job-official-posting-match',
        comparisonGroup: index.toString(16).padStart(64, '0'), comparisonRun: 'A' }));
      const original = pending.map(item => `${item.requestId}:${item.handoffCode}`);
      const requeues = []; const completed = []; let hold = true; let oldCurrent = true;
      const push = createPushSource({ seam: {
        list: async () => ({ handoffs: pending, excluded: {} }),
        read: async args => {
          if (hold) { reading.push(args); await held.promise; }
          return { ok: true, handoffCode: args.handoffCode, task: 'job-official-posting-match', prompt: 'Synthetic reserved comparison' };
        },
        requeue: args => { requeues.push(args); return true; },
        submit: async args => {
          completed.push(`${args.requestId}:${args.handoffCode}`);
          pending.splice(pending.findIndex(item => item.requestId === args.requestId), 1);
          return { outcome: 'accepted' };
        },
      }, windows: new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }]]), graceMs: 0, pollMs: 0 });
      assert(push.selectHub({ windowId: 71, canvasFilePath: '/tmp/ada.canvas', nodeId: 'node-ada' }));
      const oldReads = pending.map((_, index) => push.get({ epoch: 'reserved-recovery', worker: `worker-${index + 1}`,
        comparisonContext: comparisonContext(String(index + 1), true, () => oldCurrent) }));
      for (let turn = 0; turn < 100 && reading.length < original.length; turn++) await Promise.resolve();
      assert(reading.length === original.length, 'every comparative request is reserved before worker recovery');
      oldCurrent = false;
      for (let index = 0; index < original.length; index++) {
        assert(push.requeueWorker({ epoch: 'reserved-recovery', worker: `worker-${index + 1}`, reason }) === 1,
          'each lost reservation is released synchronously in the same turn');
      }
      assert(requeues.length === original.length && requeues.every(item => item.reason === reason), 'recovery reaches every affected identity');
      hold = false;
      for (let index = 0; index < original.length; index++) {
        const served = await push.get({ epoch: 'reserved-recovery', worker: 'worker-6', comparisonContext: comparisonContext('9', true) });
        assert(served.status === 'served', 'the new live worker can claim each recovered request');
        assert((await push.submit({ epoch: 'reserved-recovery', worker: 'worker-6', comparisonContext: comparisonContext('9', true),
          handoffCode: served.handoffCode, response: JSON.stringify({ handoffCode: served.handoffCode, answer: 'valid' }) })).status === 'accepted');
      }
      held.resolve();
      assert((await Promise.all(oldReads)).every(item => item.status === 'retry'), 'late reads from dead conversations cannot claim new ownership');
      assert(completed.length === original.length && original.every(item => completed.includes(item)), 'all original request and handoff identities complete');
    },
  })),
  {
    name: 'comparative push: contaminated B requeues once and completes in a fresh conversation',
    run: async () => {
      const { push, a, b, requeues, submits, unavailable } = comparativeFixture();
      await push.get({ epoch: 'recover-b', worker: 'worker-1', comparisonContext: comparisonContext('1') });
      await push.submit({ epoch: 'recover-b', worker: 'worker-1', comparisonContext: comparisonContext('1'), handoffCode: a.handoffCode,
        response: JSON.stringify({ handoffCode: a.handoffCode, answer: 'A' }) });
      await push.get({ epoch: 'recover-b', worker: 'worker-2', comparisonContext: comparisonContext('2') });
      await push.submit({ epoch: 'recover-b', worker: 'worker-2', comparisonContext: comparisonContext('2'), handoffCode: a.handoffCode,
        response: JSON.stringify({ handoffCode: a.handoffCode, answer: 'A' }) });
      const contaminated = await push.submit({ epoch: 'recover-b', worker: 'worker-2', comparisonContext: comparisonContext('2'), handoffCode: b.handoffCode,
        response: JSON.stringify({ handoffCode: b.handoffCode, answer: 'B' }) });
      assert(contaminated.status === 'fresh_context_required' && requeues.length === 1
        && requeues[0].requestId === b.requestId && requeues[0].reason === 'comparison-contaminated', 'contamination releases B without rejecting its answer');
      assert(submits.length === 1 && unavailable.length === 0, 'contaminated B never consumes a validation attempt or the terminal unavailable seam');
      assert((await push.get({ epoch: 'recover-b', worker: 'worker-2', comparisonContext: comparisonContext('2') })).status === 'fresh_context_required');
      const fresh = await push.get({ epoch: 'recover-b', worker: 'worker-3', comparisonContext: comparisonContext('3', true) });
      assert(fresh.status === 'served' && fresh.handoffCode === b.handoffCode, 'a new conversation receives the same B request');
      assert((await push.submit({ epoch: 'recover-b', worker: 'worker-3', comparisonContext: comparisonContext('3', true), handoffCode: b.handoffCode,
        response: JSON.stringify({ handoffCode: b.handoffCode, answer: 'B' }) })).status === 'accepted');
    },
  },
  {
    name: 'handoff bridge: push: assignment notification follows a successful claim and skips reads abandoned by scope changes',
    run: async () => {
      const pendingRead = deferred(); const reading = deferred(); const assigned = [];
      let delayRead = true; let failRead = false; let source;
      source = createPushSource({ seam: {
        list: async () => ({ handoffs: [entry], excluded: {} }),
        read: async item => {
          if (delayRead) { reading.resolve(); await pendingRead.promise; }
          if (failRead) return { ok: false, reason: 'not_pending' };
          return { ok: true, requestId: item.requestId, handoffCode: item.handoffCode, task: entry.task, prompt: 'Synthetic assignment prompt', attempt: 1 };
        },
        assigned: args => {
          assert(source.status('assignment-test').served === 1, 'worker ownership is installed before notification');
          assigned.push(args);
        },
      }, windows: new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }]]) });
      source.selectHub({ windowId: 71, canvasFilePath: '/tmp/ada.canvas', nodeId: 'node-ada' });
      source.setAllowedTasks(new Set(['job-scoring']));
      const stale = source.get({ epoch: 'assignment-test' });
      await reading.promise;
      assert(assigned.length === 0, 'an in-flight prompt read is not an assignment');
      source.setAllowedTasks(new Set(['price-synthesis']));
      pendingRead.resolve();
      assert((await stale).status === 'retry' && assigned.length === 0, 'an abandoned read never starts the caller timer');
      delayRead = false;
      source.setAllowedTasks(new Set(['job-scoring']));
      failRead = true;
      assert((await source.get({ epoch: 'assignment-test' })).status !== 'served' && assigned.length === 0, 'failed reads never notify assignment');
      failRead = false;
      assert((await source.get({ epoch: 'assignment-test' })).status === 'served' && assigned.length === 1, 'successful delivery notifies its caller');
      assert((await source.get({ epoch: 'assignment-test' })).status === 'served' && assigned.length === 1, 're-reading an owned claim never restarts the timer');
      assert(assigned[0].requestId === entry.requestId && assigned[0].handoffCode === CODE
        && assigned[0].allowTasks.has('job-scoring') && assigned[0].allowNodeIds.has('node-ada')
        && assigned[0].allowWindowNodePairs.has('71\u0000node-ada'), 'notification uses the exact ownership-checked seam arguments');
    },
  },
  {
    name: 'Amendment 9 item 3: a delayed re-copy starts a fresh bounded observed-launch window',
    run: async () => {
      let stamp = 1_000_000;
      const { push } = comparativeFixture({ now: () => stamp });
      const engine = createHandoffEngine({ sources: { push, application: {
        read: async () => ({ kind: 'gone' }), status: async () => ({ kind: 'gone' }), submit: async () => ({ kind: 'gone' }),
      } }, scope: { applications: false, scoring: true, marketplace: false }, holdMs: 0, now: () => stamp });
      try {
        const pool = await engine.startWorkerPool({ linkId: LINK, requestedWorkers: 1 });
        const first = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
        observeWorker(engine, first);
        assert((await engine.get({ session: first.sessionCode, linkId: LINK })).status === 'served');
        stamp += 6 * 60_000;
        const replacement = engine.restartWorker({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
        assert(replacement.copied && hasPendingObservedWorkerLaunch(), 'the initial restart has bounded pending evidence');
        stamp += CONSTANTS.CHAT_LAUNCH_PRESENTATION_TIMEOUT_MS + 1;
        assert(!hasPendingObservedWorkerLaunch(), 'the unused clipboard restart expires');
        const copied = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
        assert(copied.recopied && copied.sessionCode === replacement.sessionCode, 're-copy retains the same worker capability');
        assert(engine.beginObservedChat({ linkId: LINK, sessionCode: copied.sessionCode }));
        assert(hasPendingObservedWorkerLaunch(), 'a delayed launcher gets a new window instead of the stale restart stamp');
        stamp += CONSTANTS.CHAT_LAUNCH_PRESENTATION_TIMEOUT_MS - 1;
        assert(engine.beginObservedChat({ linkId: LINK, sessionCode: copied.sessionCode }));
        stamp += 1;
        assert(!hasPendingObservedWorkerLaunch(), 'repeated begin calls do not extend an unexpired launch');
        assert(engine.beginObservedChat({ linkId: LINK, sessionCode: copied.sessionCode }));
        assert(hasPendingObservedWorkerLaunch(), 'begin also refreshes an already expired pending launch');
      } finally { await engine.close(); }
    },
  },
  {
    name: 'Amendment 9 item 3: a launcher begin after an unexpired re-copy gets its own full window',
    run: async () => {
      let stamp = 1_000_000;
      const { push } = comparativeFixture({ now: () => stamp });
      const engine = createHandoffEngine({ sources: { push, application: {
        read: async () => ({ kind: 'gone' }), status: async () => ({ kind: 'gone' }), submit: async () => ({ kind: 'gone' }),
      } }, scope: { applications: false, scoring: true, marketplace: false }, holdMs: 0, now: () => stamp });
      try {
        const pool = await engine.startWorkerPool({ linkId: LINK, requestedWorkers: 1 });
        const first = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
        observeWorker(engine, first);
        assert((await engine.get({ session: first.sessionCode, linkId: LINK })).status === 'served');
        stamp += 6 * 60_000;
        const replacement = engine.restartWorker({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
        assert(replacement.copied && hasPendingObservedWorkerLaunch());
        stamp += 30_000;
        const copied = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
        assert(copied.recopied && copied.sessionCode === replacement.sessionCode);
        stamp += 5_000;
        assert(engine.beginObservedChat({ linkId: LINK, sessionCode: copied.sessionCode }));
        stamp += CONSTANTS.CHAT_LAUNCH_PRESENTATION_TIMEOUT_MS - 1;
        assert(hasPendingObservedWorkerLaunch(), 'the launch window starts at begin, not at the earlier restart stamp');
        stamp += 1;
        assert(!hasPendingObservedWorkerLaunch(), 'the refreshed window stays bounded');
      } finally { await engine.close(); }
    },
  },
  {
    name: 'Amendment 8 item 5: a pristine run-A replacement drains ordinary work before a ready B',
    run: async () => {
      const { push, a, b, reads, setPending } = comparativeFixture();
      const scoring = { ...entry, requestId: 'ready-b-scoring', handoffCode: 'HANDOFF-NPQRST' };
      await push.get({ epoch: 'ready-b', worker: 'worker-1', comparisonContext: comparisonContext('1') });
      await push.submit({ epoch: 'ready-b', worker: 'worker-1', comparisonContext: comparisonContext('1'),
        handoffCode: a.handoffCode, response: JSON.stringify({ handoffCode: a.handoffCode, answer: 'A' }) });
      setPending([b, scoring]);
      const next = await push.get({ epoch: 'ready-b', worker: 'worker-1', comparisonContext: comparisonContext('2', true) });
      assert(next.status === 'served' && next.handoffCode === scoring.handoffCode,
        'a pristine chat on the same ordinal must drain ordinary work before its otherwise ready B');
      assert(reads.length === 2 && reads[1].requestId === scoring.requestId, 'run B must remain unread');
    },
  },
  {
    name: 'Amendment 8 item 4: a single-worker observed relaunch remains pending through the launcher window',
    run: async () => {
      let stamp = 1_000_000;
      const { push, a, b } = comparativeFixture({ now: () => stamp });
      const engine = createHandoffEngine({ sources: { push, application: {
        read: async () => ({ kind: 'gone' }), status: async () => ({ kind: 'gone' }), submit: async () => ({ kind: 'gone' }),
      } }, scope: { applications: false, scoring: true, marketplace: false }, holdMs: 0, now: () => stamp });
      try {
        const pool = await engine.startWorkerPool({ linkId: LINK, requestedWorkers: 1 });
        const first = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
        observeWorker(engine, first);
        assert((await engine.get({ session: first.sessionCode, linkId: LINK })).handoffCode === a.handoffCode);
        await engine.submit({ session: first.sessionCode, linkId: LINK, handoffCode: a.handoffCode, response: '{}' });
        assert((await engine.get({ session: first.sessionCode, linkId: LINK })).status === 'session_full');
        stamp += 6 * 60_000;
        const replacement = engine.restartWorker({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
        assert(hasPendingObservedWorkerLaunch() && !hasLiveObservedWorker(), 'restart preserves only bounded launch evidence');
        assert(engine.beginObservedChat({ linkId: LINK, sessionCode: replacement.sessionCode }));
        stamp += CONSTANTS.CHAT_LAUNCH_PRESENTATION_TIMEOUT_MS - 1;
        assert(hasPendingObservedWorkerLaunch(), 'the launch may outlast the comparative absence grace');
        stamp += 1;
        assert(!hasPendingObservedWorkerLaunch(), 'a stalled launcher expires at its existing maximum');
        engine.cancelObservedChat({ linkId: LINK, sessionCode: replacement.sessionCode });
        assert(!hasPendingObservedWorkerLaunch(), 'cancellation removes pending evidence');
        assert(engine.beginObservedChat({ linkId: LINK, sessionCode: replacement.sessionCode }));
        assert(hasPendingObservedWorkerLaunch(), 'a newly observed launch gets its own bounded window');
        assert(engine.confirmObservedChat({ linkId: LINK, sessionCode: replacement.sessionCode,
          observation: createObservedChatContext(`synthetic-observed-worker-${++observedChatOrdinal}`) }));
        assert(hasLiveObservedWorker() && !hasPendingObservedWorkerLaunch(), 'confirmation replaces pending with live evidence');
        assert((await engine.get({ session: replacement.sessionCode, linkId: LINK })).handoffCode === b.handoffCode);
      } finally { await engine.close(); }
    },
  },
  {
    name: 'Amendment 8 item 3: an unobserved replacement releases its comparison and drains scoring without consuming an attempt',
    run: async () => {
      let stamp = 1_000_000;
      const { push, reads, submits, unavailable, a, setPending } = comparativeFixture({ now: () => stamp });
      const scoring = { ...entry, requestId: 'replacement-scoring', handoffCode: 'HANDOFF-NPQRST' };
      setPending([a, scoring]);
      const engine = createHandoffEngine({ sources: { push, application: {
        read: async () => ({ kind: 'gone' }), status: async () => ({ kind: 'gone' }), submit: async () => ({ kind: 'gone' }),
      } }, scope: { applications: false, scoring: true, marketplace: false }, holdMs: 0, now: () => stamp });
      try {
        const pool = await engine.startWorkerPool({ linkId: LINK, requestedWorkers: 2 });
        const one = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
        const two = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 2 });
        observeWorker(engine, one); observeWorker(engine, two);
        assert((await engine.get({ session: one.sessionCode, linkId: LINK })).handoffCode === a.handoffCode);
        stamp += 6 * 60_000;
        const replacement = engine.restartWorker({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
        assert(replacement.copied === true, 'the manual replacement remains clipboard-only');
        const ordinary = await engine.get({ session: replacement.sessionCode, linkId: LINK });
        assert(ordinary.status === 'served' && ordinary.handoffCode === scoring.handoffCode,
          'the unobserved replacement must reach queued scoring instead of rereading its served comparison');
        const comparison = await engine.get({ session: two.sessionCode, linkId: LINK });
        assert(comparison.status === 'served' && comparison.handoffCode === a.handoffCode && comparison.attempt === 1,
          'an observed worker can reclaim the pending comparison at its original attempt');
        assert(unavailable.length === 0 && submits.length === 0 && reads.length === 3,
          'releasing the route neither submits nor fails the comparative request');
      } finally { await engine.close(); }
    },
  },
  {
    name: 'comparative engine: clipboard-only New and multiple worker capabilities never prove observed conversations',
    run: async () => {
      for (const pooled of [false, true]) {
        const { push, reads } = comparativeFixture(); const engine = comparativeEngine(push);
        const chat = await engine.newChat({ linkId: LINK });
        let starters = [chat];
        if (pooled) {
          const pool = await engine.startWorkerPool({ linkId: LINK, requestedWorkers: 2 });
          starters = [1, 2].map(workerOrdinal => engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal }));
        }
        for (const starter of starters) assert((await engine.get({ session: starter.sessionCode, linkId: LINK })).status === 'waiting');
        assert(reads.length === 0, 'clipboard credentials reveal no comparative prompt, even when minted by New or different workers');
        await engine.close();
      }
    },
  },
  {
    name: 'comparative engine: trusted observed worker counts exclude unobserved slots and include busy workers',
    run: async () => {
      const { push, a, b, setPending } = comparativeFixture();
      setPending([a, b]);
      const engine = comparativeEngine(push);
      try {
        await engine.newChat({ linkId: LINK });
        const pool = await engine.startWorkerPool({ linkId: LINK, requestedWorkers: 2 });
        const one = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
        const two = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 2 });
        assert(!hasLiveObservedWorker(), 'planned or copied worker slots do not prove a live observed conversation');
        observeWorker(engine, one);
        assert(hasLiveObservedWorker() && !hasLiveObservedWorker(2), 'one observed worker proves only sequential capacity');
        observeWorker(engine, two);
        assert(hasLiveObservedWorker(2), 'both observed conversations prove parallel capacity');
        assert((await engine.get({ session: one.sessionCode, linkId: LINK })).handoffCode === a.handoffCode);
        assert((await engine.get({ session: two.sessionCode, linkId: LINK })).handoffCode === b.handoffCode);
        assert(hasLiveObservedWorker(2), 'workers serving requests remain live while another comparison waits');
      } finally { await engine.close(); }
      assert(!hasLiveObservedWorker(), 'closing the engine retires its count provider');
    },
  },
  {
    name: 'comparative engine: an unobserved worker skips comparison for scoring and an observed second worker still claims it',
    run: async () => {
      const { push, reads, unavailable, a, setPending } = comparativeFixture();
      const scoring = { ...entry, requestId: 'comparison-scoring', handoffCode: 'HANDOFF-NPQRST' };
      setPending([a, scoring]);
      const engine = comparativeEngine(push);
      const pool = await engine.startWorkerPool({ linkId: LINK, requestedWorkers: 2 });
      const one = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
      const two = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 2 });
      observeWorker(engine, two);
      try {
        assert((await engine.get({ session: one.sessionCode, linkId: LINK })).handoffCode === scoring.handoffCode);
        assert((await engine.get({ session: two.sessionCode, linkId: LINK })).handoffCode === a.handoffCode);
        assert(unavailable.length === 0 && reads.length === 2, 'an unobserved poll neither aborts nor reads comparative work');
        assert(hasLiveObservedWorker(), 'an observed active worker remains available to the resolver');
      } finally { await engine.close(); }
    },
  },
  {
    name: 'comparative push: run A drains scoring before a bounded wait for another observed worker and fresh fallback',
    run: async () => {
      let stamp = 1_000;
      const { push, a, b, reads, setPending } = comparativeFixture({ now: () => stamp });
      const context = { ...comparisonContext('1'), availableWorkerIds: () => ['worker-2'] };
      await push.get({ epoch: 'ordinary-first', worker: 'worker-1', comparisonContext: context });
      await push.submit({ epoch: 'ordinary-first', worker: 'worker-1', comparisonContext: context, handoffCode: a.handoffCode, response: JSON.stringify({ handoffCode: a.handoffCode, answer: 'A' }) });
      const scoring = { ...entry, requestId: 'run-a-scoring', handoffCode: 'HANDOFF-NPQRST' };
      setPending([b, scoring]);
      assert((await push.get({ epoch: 'ordinary-first', worker: 'worker-1', comparisonContext: context })).handoffCode === scoring.handoffCode);
      await push.submit({ epoch: 'ordinary-first', worker: 'worker-1', comparisonContext: context, handoffCode: scoring.handoffCode, response: JSON.stringify({ handoffCode: scoring.handoffCode, answer: 'score' }) });
      setPending([b]);
      assert((await push.get({ epoch: 'ordinary-first', worker: 'worker-1', comparisonContext: context })).status === 'waiting');
      stamp += 5_001;
      assert((await push.get({ epoch: 'ordinary-first', worker: 'worker-1', comparisonContext: context })).status === 'fresh_context_required');
      assert(reads.length === 2, 'run B bytes never reach the run-A conversation');
    },
  },
  {
    name: 'comparative engine: application work is served before a run-B fresh-chat stop',
    run: async () => {
      const { engine, session } = await makeEngine({ pushGet: async () => ({ status: 'fresh_context_required', remaining: { ready: 1, working: 0, needsYou: 0 } }) });
      try {
        assert((await engine.get({ session, linkId: LINK })).handoffCode === 'APP-CODE');
        assert(engine.snapshot().chat.pool.workers[0]?.quietReason !== 'fresh_context_required');
      } finally { await engine.close(); }
    },
  },
  {
    name: 'comparative engine: push acceptance defers a run-B stop while unread application work is queued',
    run: async () => {
      let accepted = false; let appReads = 0;
      const push = {
        get: async () => accepted ? { status: 'fresh_context_required' }
          : { status: 'served', handoffCode: CODE, task: 'job-scoring', prompt: 'Synthetic scoring work' },
        submit: async () => { accepted = true; return { status: 'accepted' }; },
        nextAfterAccept: async () => ({ status: 'fresh_context_required' }),
        status: () => ({}),
      };
      const { engine, session } = await makeEngine({ pushSource: push,
        appRead: async () => { appReads++; return { kind: 'open', handoff: { code: 'APP-CODE', stage: 'resume', revision: 1, prompt: 'Synthetic application work' } }; } });
      try {
        assert((await engine.get({ session, linkId: LINK })).handoffCode === CODE && appReads === 0);
        const result = await engine.submit({ session, linkId: LINK, handoffCode: CODE, response: VALID_RESPONSE });
        assert(result.status === 'accepted' && result.next?.status === 'waiting', 'the push-only probe cannot stop a worker that can serve application work');
        assert((await engine.get({ session, linkId: LINK })).handoffCode === 'APP-CODE' && appReads > 0);
      } finally { await engine.close(); }
    },
  },
  {
    name: 'comparative engine: a first GET waits for observed launch and forged or delayed proof cannot bind a new capability',
    run: async () => {
      const { push, reads, a } = comparativeFixture(); const engine = comparativeEngine(push);
      await engine.newChat({ linkId: LINK });
      const pool = await engine.startWorkerPool({ linkId: LINK, requestedWorkers: 1 });
      const old = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
      assert(engine.beginObservedChat({ linkId: LINK, sessionCode: old.sessionCode }));
      assert(engine.cancelObservedChat({ linkId: LINK, sessionCode: old.sessionCode }));
      const fresh = engine.restartWorker({ linkId: LINK, generation: pool.generation, workerOrdinal: 1, failedLaunch: true });
      assert(fresh.copied && engine.beginObservedChat({ linkId: LINK, sessionCode: fresh.sessionCode }));
      assert((await engine.get({ session: fresh.sessionCode, linkId: LINK })).status === 'waiting' && reads.length === 0);
      assert(engine.confirmObservedChat({ linkId: LINK, sessionCode: fresh.sessionCode, observation: { conversationKey: '1'.repeat(64), fresh: true } }) === false);
      assert(engine.beginObservedChat({ linkId: LINK, sessionCode: fresh.sessionCode }));
      assert(engine.confirmObservedChat({ linkId: LINK, sessionCode: old.sessionCode,
        observation: createObservedChatContext('synthetic-delayed-old-launch') }) === false);
      assert(engine.confirmObservedChat({ linkId: LINK, sessionCode: fresh.sessionCode,
        observation: createObservedChatContext('synthetic-confirmed-current-launch') }));
      assert((await engine.get({ session: fresh.sessionCode, linkId: LINK })).handoffCode === a.handoffCode);
      assert(reads.length === 1 && reads[0].comparisonProvenance.version === 2 && reads[0].comparisonProvenance.observed === true);
      await engine.close();
    },
  },
  {
    name: 'comparative engine: an unobserved second worker is unavailable for preference and cannot block fresh observed fallback',
    run: async () => {
      const { push, reads, a, b } = comparativeFixture(); const engine = comparativeEngine(push);
      await engine.newChat({ linkId: LINK });
      const pool = await engine.startWorkerPool({ linkId: LINK, requestedWorkers: 2 });
      const one = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
      const two = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 2 });
      observeWorker(engine, one);
      await engine.get({ session: one.sessionCode, linkId: LINK });
      assert((await engine.get({ session: two.sessionCode, linkId: LINK })).status === 'waiting');
      await engine.submit({ session: one.sessionCode, linkId: LINK, handoffCode: a.handoffCode, response: JSON.stringify({ handoffCode: a.handoffCode, answer: 'A' }) });
      assert((await engine.get({ session: one.sessionCode, linkId: LINK })).status === 'session_full');
      const replacement = engine.restartWorker({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
      observeWorker(engine, replacement);
      assert((await engine.get({ session: replacement.sessionCode, linkId: LINK })).handoffCode === b.handoffCode && reads.length === 2);
      await engine.close();
    },
  },
  {
    name: 'comparative engine: the same invalid answer consumes the one correction instead of replaying a cached rejection',
    run: async () => {
      const { push, submits, a } = comparativeFixture({ submit: (_args, count) => count === 1
        ? { outcome: 'rejected', isCorrection: true, correction: 'Return the registered comparison fields.', attempt: 2 }
        : { outcome: 'not_pending' } });
      const engine = createHandoffEngine({ sources: { push, application: { read: async () => ({ kind: 'gone' }), status: async () => ({ kind: 'gone' }), submit: async () => ({ kind: 'gone' }) } }, scope: { applications: false, scoring: true, marketplace: false }, holdMs: 0 });
      const chat = await observedNewChat(engine);
      assert((await engine.get({ session: chat.sessionCode, linkId: LINK })).handoffCode === a.handoffCode);
      const args = { session: chat.sessionCode, linkId: LINK, handoffCode: a.handoffCode, response: '{}' };
      const first = await engine.submit(args);
      const second = await engine.submit(args);
      assert(first.status === 'rejected' && second.status === 'superseded' && submits.length === 2,
        'both source and engine caches release a completed comparative rejection before an identical correction');
      assert(!Object.hasOwn(first, 'comparative'), 'the internal cache instruction is absent from the tool result');
      await engine.close();
    },
  },
  {
    name: 'comparative push: two workers get independent runs and same-turn successor never reads run B in run A conversation',
    run: async () => {
      const { push, reads, a, b } = comparativeFixture();
      assert((await push.get({ epoch: 'pair', worker: 'worker-1', comparisonContext: comparisonContext('1') })).status === 'served');
      assert(reads.length === 1 && reads[0].comparisonProvenance.comparisonRun === 'A');
      assert((await push.submit({ epoch: 'pair', worker: 'worker-1', comparisonContext: comparisonContext('1'), handoffCode: a.handoffCode, response: JSON.stringify({ handoffCode: a.handoffCode, answer: 'A' }) })).status === 'accepted');
      const sameTurn = await push.nextAfterAccept({ epoch: 'pair', worker: 'worker-1', budgetMs: 1, comparisonContext: comparisonContext('1') });
      assert(sameTurn.status === 'fresh_context_required' && reads.length === 1, 'run B prompt was never read by run A chat or included in its accepted batch');
      const replayedA = await push.submit({ epoch: 'pair', worker: 'worker-2', comparisonContext: comparisonContext('2'), handoffCode: a.handoffCode,
        response: JSON.stringify({ handoffCode: a.handoffCode, answer: 'A' }) });
      assert(replayedA.status === 'duplicate');
      assert((await push.get({ epoch: 'pair', worker: 'worker-2', comparisonContext: comparisonContext('2') })).status === 'fresh_context_required', 'a duplicated A answer also contaminates that conversation');
      const second = await push.get({ epoch: 'pair', worker: 'worker-3', comparisonContext: comparisonContext('3') });
      assert(second.status === 'served' && second.handoffCode === b.handoffCode && reads.length === 2);
      assert(reads[1].comparisonProvenance.isolated === true && reads[0].comparisonProvenance.conversationKey !== reads[1].comparisonProvenance.conversationKey);
      assert(!JSON.stringify(second).includes('comparisonGroup') && !JSON.stringify(push.status()).includes(COMPARISON_GROUP), 'private routing proof never reaches ChatGPT or status');
    },
  },
  ...[false, true].map(queued => ({
    name: `comparative push: A answer exposure after B serve invalidates ${queued ? 'a queued B submit' : 'B rereads and submit'}`,
    run: async () => {
      const { push, reads, submits, a, b } = comparativeFixture();
      await push.get({ epoch: 'contamination', worker: 'worker-1', comparisonContext: comparisonContext('1') });
      await push.submit({ epoch: 'contamination', worker: 'worker-1', comparisonContext: comparisonContext('1'), handoffCode: a.handoffCode, response: JSON.stringify({ handoffCode: a.handoffCode, answer: 'A' }) });
      await push.get({ epoch: 'contamination', worker: 'worker-2', comparisonContext: comparisonContext('2') });
      const submitB = () => push.submit({ epoch: 'contamination', worker: 'worker-2', comparisonContext: comparisonContext('2'), handoffCode: b.handoffCode, response: JSON.stringify({ handoffCode: b.handoffCode, answer: 'B' }) });
      const pendingB = queued ? submitB() : null;
      const duplicate = await push.submit({ epoch: 'contamination', worker: 'worker-2', comparisonContext: comparisonContext('2'), handoffCode: a.handoffCode, response: JSON.stringify({ handoffCode: a.handoffCode, answer: 'A' }) });
      assert(duplicate.status === 'duplicate');
      if (!queued) assert((await push.get({ epoch: 'contamination', worker: 'worker-2', comparisonContext: comparisonContext('2') })).status === 'fresh_context_required' && reads.length === 2, 'own B route never bypasses newly observed exposure');
      const verdict = await (pendingB || submitB());
      assert(verdict.status !== 'accepted' && submits.length === 1, 'no B answer reaches host acceptance after it saw A, including the queued-submit race');
    },
  })),
  {
    name: 'comparative push: A exposure while a B prompt read is in flight prevents delivery and survives active-route history changes',
    run: async () => {
      const held = deferred();
      const { push, reads, a } = comparativeFixture({ beforeRead: args => args.comparisonProvenance.comparisonRun === 'B' ? held.promise : undefined });
      await push.get({ epoch: 'read-race', worker: 'worker-1', comparisonContext: comparisonContext('1') });
      await push.submit({ epoch: 'read-race', worker: 'worker-1', comparisonContext: comparisonContext('1'), handoffCode: a.handoffCode, response: JSON.stringify({ handoffCode: a.handoffCode, answer: 'A' }) });
      const pendingRead = push.get({ epoch: 'read-race', worker: 'worker-2', comparisonContext: comparisonContext('2') });
      while (reads.length < 2) await Promise.resolve();
      await push.submit({ epoch: 'read-race', worker: 'worker-2', comparisonContext: comparisonContext('2'), handoffCode: a.handoffCode, response: JSON.stringify({ handoffCode: a.handoffCode, answer: 'A' }) });
      held.resolve();
      const result = await pendingRead;
      assert(result.status === 'fresh_context_required' && !Object.hasOwn(result, 'prompt'), 'the now-contaminated conversation never receives B prompt bytes');
    },
  },
  {
    name: 'comparative push: bounded history eviction cannot restore a contaminated active B and a pristine replacement can recover',
    run: async () => {
      const { push, a, b, setPending } = comparativeFixture();
      await push.get({ epoch: 'bounded-history', worker: 'worker-1', comparisonContext: comparisonContext('1') });
      const submitA = () => push.submit({ epoch: 'bounded-history', worker: 'worker-1', comparisonContext: comparisonContext('1'), handoffCode: a.handoffCode, response: JSON.stringify({ handoffCode: a.handoffCode, answer: 'A' }) });
      await submitA();
      await push.get({ epoch: 'bounded-history', worker: 'worker-2', comparisonContext: comparisonContext('2') });
      await push.submit({ epoch: 'bounded-history', worker: 'worker-2', comparisonContext: comparisonContext('2'), handoffCode: a.handoffCode, response: JSON.stringify({ handoffCode: a.handoffCode, answer: 'A' }) });
      for (let index = 0; index < 501; index++) {
        setPending([{ ...a, requestId: `comparison-history-${index}`, comparisonGroup: index.toString(16).padStart(64, '0') }, b]);
        await push.get({ epoch: 'bounded-history', worker: 'worker-1', comparisonContext: comparisonContext('1') });
        await submitA();
      }
      assert((await push.get({ epoch: 'bounded-history', worker: 'worker-2', comparisonContext: comparisonContext('2') })).status === 'fresh_context_required', 'the active route remains tainted after its group is evicted from bounded history');
      const replacement = await push.get({ epoch: 'bounded-history', worker: 'worker-2', comparisonContext: comparisonContext('3', true) });
      assert(replacement.status === 'served' && replacement.handoffCode === b.handoffCode, 'a pristine replacement re-attests B even after history eviction');
    },
  },
  {
    name: 'comparative push: unknown or restarted run A provenance requires a pristine New chat and stale contexts receive no prompt',
    run: async () => {
      const { push, reads } = comparativeFixture({ firstRun: 'B' });
      for (const character of ['1', '2']) assert((await push.get({ epoch: 'resume', worker: 'worker-1', comparisonContext: comparisonContext(character) })).status === 'fresh_context_required');
      assert(reads.length === 0, 'an unknown predecessor and a Continue capability cannot infer separation');
      assert((await push.get({ epoch: 'resume', worker: 'worker-1', comparisonContext: comparisonContext('3', true, () => false) })).status === 'retry');
      assert(reads.length === 0, 'a stale context is rejected before prompt read');
      assert((await push.get({ epoch: 'resume', worker: 'worker-1', comparisonContext: comparisonContext('4', true) })).status === 'served');
      assert(reads.length === 1 && reads[0].comparisonProvenance.isolated === true);
      push.closeEpoch('resume');
      assert((await push.get({ epoch: 'relaunch', worker: 'worker-1', comparisonContext: comparisonContext('4') })).status === 'fresh_context_required', 'relaunch forgets process-local provenance and fails closed');
    },
  },
  {
    name: 'comparative push: a fresh A ordinal waits for a different available worker before reading B',
    run: async () => {
      const { push, reads, a, b } = comparativeFixture();
      await push.get({ epoch: 'preferred-worker', worker: 'worker-1', comparisonContext: comparisonContext('1') });
      await push.submit({ epoch: 'preferred-worker', worker: 'worker-1', comparisonContext: comparisonContext('1'), handoffCode: a.handoffCode, response: JSON.stringify({ handoffCode: a.handoffCode, answer: 'A' }) });
      const freshA = { ...comparisonContext('3', true), availableWorkerIds: () => ['worker-2'] };
      assert((await push.get({ epoch: 'preferred-worker', worker: 'worker-1', comparisonContext: freshA })).status === 'waiting' && reads.length === 1,
        'a new conversation on A ordinal does not outrun a different available worker');
      assert((await push.get({ epoch: 'preferred-worker', worker: 'worker-2', comparisonContext: comparisonContext('2') })).handoffCode === b.handoffCode && reads.length === 2);
    },
  },
  {
    name: 'comparative engine: a connected waiting second worker is preferred and a busy second worker permits fresh fallback',
    run: async () => {
      for (const busy of [false, true]) {
        const { push, reads, a, b, setPending } = comparativeFixture();
        const other = { ...entry, requestId: 'comparison-unrelated-work', handoffCode: 'HANDOFF-NPQRST' };
        if (busy) setPending([a, other]);
        const engine = createHandoffEngine({ sources: { push, application: { read: async () => ({ kind: 'gone' }), status: async () => ({ kind: 'gone' }), submit: async () => ({ kind: 'gone' }) } }, scope: { applications: false, scoring: true, marketplace: false }, holdMs: 0, submitBudgetMs: 100 });
        await engine.newChat({ linkId: LINK });
        const pool = await engine.startWorkerPool({ linkId: LINK, requestedWorkers: 2 });
        const one = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
        const two = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 2 });
        observeWorker(engine, one); observeWorker(engine, two);
        await engine.get({ session: one.sessionCode, linkId: LINK });
        const otherGet = await engine.get({ session: two.sessionCode, linkId: LINK });
        assert(otherGet.status === (busy ? 'served' : 'waiting'));
        const accepted = await engine.submit({ session: one.sessionCode, linkId: LINK, handoffCode: a.handoffCode, response: JSON.stringify({ handoffCode: a.handoffCode, answer: 'A' }) });
        assert(accepted.status === 'accepted' && accepted.next?.status === 'waiting', 'pool submit never includes a successor prompt');
        assert((await engine.get({ session: one.sessionCode, linkId: LINK })).status === (busy ? 'session_full' : 'waiting'));
        if (busy) {
          const replacement = engine.restartWorker({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
          observeWorker(engine, replacement);
          assert(replacement.copied && (await engine.get({ session: replacement.sessionCode, linkId: LINK })).handoffCode === b.handoffCode,
            'a busy alternative does not stall the only available worker fresh-chat fallback');
        } else {
          assert((await engine.get({ session: two.sessionCode, linkId: LINK })).handoffCode === b.handoffCode,
            'the connected idle worker receives B before the A ordinal can');
        }
        const comparisonReads = reads.filter(item => item.comparisonProvenance);
        assert(comparisonReads.length === 2 && comparisonReads[0].comparisonProvenance.conversationKey !== comparisonReads[1].comparisonProvenance.conversationKey);
        await engine.close();
      }
    },
  },
  {
    name: 'comparative engine: one worker must start a new conversation for B and Continue never substitutes for New chat',
    run: async () => {
      const { push, reads, a, b } = comparativeFixture();
      const engine = createHandoffEngine({ sources: { push, application: { read: async () => ({ kind: 'gone' }), status: async () => ({ kind: 'gone' }), submit: async () => ({ kind: 'gone' }) } }, scope: { applications: false, scoring: true, marketplace: false }, holdMs: 0, submitBudgetMs: 100 });
      const first = await observedNewChat(engine);
      const served = await engine.get({ session: first.sessionCode, linkId: LINK });
      assert(served.status === 'served' && served.handoffCode === a.handoffCode);
      const result = await engine.submit({ session: first.sessionCode, linkId: LINK, handoffCode: a.handoffCode, response: JSON.stringify({ handoffCode: a.handoffCode, answer: 'A' }) });
      assert(result.status === 'accepted' && result.next?.status === 'session_full' && reads.length === 1, 'B never enters the A submit turn');
      const continued = await engine.continueChat({ linkId: LINK, observation: createObservedChatContext(first.observedId, 'continue') });
      assert((await engine.get({ session: continued.sessionCode, linkId: LINK })).status === 'session_full' && reads.length === 1, 'Continue has a new key but the old conversation');
      const fresh = await observedNewChat(engine);
      const runB = await engine.get({ session: fresh.sessionCode, linkId: LINK });
      assert(runB.status === 'served' && runB.handoffCode === b.handoffCode && reads.length === 2);
      assert(reads[0].comparisonProvenance.conversationKey !== reads[1].comparisonProvenance.conversationKey);
      await engine.close();
    },
  },
  {
    name: 'comparative engine: restarting the single worker creates a new incarnation for B before its prompt is read',
    run: async () => {
      const { push, reads, a, b } = comparativeFixture();
      const engine = createHandoffEngine({ sources: { push, application: { read: async () => ({ kind: 'gone' }), status: async () => ({ kind: 'gone' }), submit: async () => ({ kind: 'gone' }) } }, scope: { applications: false, scoring: true, marketplace: false }, holdMs: 0 });
      await engine.newChat({ linkId: LINK });
      const pool = await engine.startWorkerPool({ linkId: LINK, requestedWorkers: 1 });
      const original = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
      observeWorker(engine, original);
      assert((await engine.get({ session: original.sessionCode, linkId: LINK })).handoffCode === a.handoffCode);
      await engine.submit({ session: original.sessionCode, linkId: LINK, handoffCode: a.handoffCode, response: JSON.stringify({ handoffCode: a.handoffCode, answer: 'A' }) });
      assert((await engine.get({ session: original.sessionCode, linkId: LINK })).status === 'session_full' && reads.length === 1);
      const replacement = engine.restartWorker({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
      observeWorker(engine, replacement);
      assert(replacement.copied && replacement.sessionCode !== original.sessionCode);
      assert((await engine.get({ session: replacement.sessionCode, linkId: LINK })).handoffCode === b.handoffCode);
      assert(reads.length === 2 && reads[0].comparisonProvenance.conversationKey !== reads[1].comparisonProvenance.conversationKey);
      await engine.close();
    },
  },
  {
    name: 'comparative engine: a live two-worker pool routes B away from A',
    run: async () => {
      const { push, reads, a, b } = comparativeFixture();
      const engine = createHandoffEngine({ sources: { push, application: { read: async () => ({ kind: 'gone' }), status: async () => ({ kind: 'gone' }), submit: async () => ({ kind: 'gone' }) } }, scope: { applications: false, scoring: true, marketplace: false }, holdMs: 0 });
      await engine.newChat({ linkId: LINK });
      const pool = await engine.startWorkerPool({ linkId: LINK, requestedWorkers: 2 });
      const one = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
      const two = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 2 });
      observeWorker(engine, one); observeWorker(engine, two);
      assert(one?.sessionCode && two?.sessionCode, 'two independent starters exist');
      assert((await engine.get({ session: one.sessionCode, linkId: LINK })).handoffCode === a.handoffCode);
      await engine.submit({ session: one.sessionCode, linkId: LINK, handoffCode: a.handoffCode, response: JSON.stringify({ handoffCode: a.handoffCode, answer: 'A' }) });
      assert((await engine.get({ session: one.sessionCode, linkId: LINK })).status === 'session_full');
      assert((await engine.get({ session: two.sessionCode, linkId: LINK })).handoffCode === b.handoffCode);
      assert(reads.length === 2 && reads[0].comparisonProvenance.conversationKey !== reads[1].comparisonProvenance.conversationKey);
      await engine.close();
    },
  },
  ...['junk', 'misrouted', 'too_large'].map(kind => ({
    name: `W3 step 7: five consecutive ${kind} prechecks hand the handoff back once and never reach the seam`,
    run: async () => {
      const { source, log } = await makeHandBackSource();
      const results = [];
      for (let index = 0; index < 5; index += 1) results.push(await source.submit({ handoffCode: CODE, response: JUNK_RESPONSES[kind] }));
      assert(results.slice(0, 4).every(result => result.status === kind),
        `the first four ${kind} submits only report ${kind} (got ${results.map(result => result.status).join(',')}, handBacks=${log.handBacks.length})`);
      assert(results[4].status === 'needs_user' && results[4].reason === 'rejection_cap' && log.handBacks.length === 1
        && log.handBacks[0].requestId === entry.requestId && log.handBacks[0].reason === 'rejection_cap' && log.seamSubmits === 0,
      `the fifth hands back once with rejection_cap (got ${JSON.stringify({ result: results[4], handBacks: log.handBacks, seam: log.seamSubmits })})`);
      assert((await source.submit({ handoffCode: CODE, response: JUNK_RESPONSES[kind] })).status === 'unknown_handoff',
        'a handed-back handoff is no longer served by the bridge');
    },
  })),
  { name: 'W3 step 7: junk, misrouted and too_large prechecks share one consecutive streak', run: async () => {
    const { source, log } = await makeHandBackSource();
    const order = ['junk', 'misrouted', 'too_large', 'junk', 'misrouted'];
    const results = [];
    for (const kind of order) results.push(await source.submit({ handoffCode: CODE, response: JUNK_RESPONSES[kind] }));
    assert(results.slice(0, 4).map(result => result.status).join(',') === 'junk,misrouted,too_large,junk',
      `each mixed refusal reports its own precheck status (got ${results.map(result => result.status).join(',')})`);
    assert(results[4].status === 'needs_user' && results[4].reason === 'rejection_cap' && log.handBacks.length === 1,
      'the fifth mixed refusal reaches the cap');
  } },
  { name: 'W3 step 7: a submission that passes the precheck resets the consecutive precheck streak', run: async () => {
    const { source, log } = await makeHandBackSource({ submit: async () => ({ outcome: 'rejected', validationCode: 'SYNTHETIC_REJECT', attempt: 2 }) });
    for (let index = 0; index < 4; index += 1) assert((await source.submit({ handoffCode: CODE, response: '{}' })).status === 'junk', `junk ${index + 1}`);
    const passed = await source.submit({ handoffCode: CODE, response: VALID_RESPONSE });
    assert(log.seamSubmits === 1 && passed.status !== 'junk' && passed.status !== 'needs_user', `the valid answer reaches the seam (got ${passed.status})`);
    for (let index = 0; index < 4; index += 1) {
      const result = await source.submit({ handoffCode: CODE, response: '{}' });
      assert(result.status === 'junk' && log.handBacks.length === 0, `after the reset, junk ${index + 1} of 4 must not hand back (got ${result.status})`);
    }
    const capped = await source.submit({ handoffCode: CODE, response: '{}' });
    assert(capped.status === 'needs_user' && capped.reason === 'rejection_cap' && log.handBacks.length === 1,
      'five consecutive refusals AFTER the reset reach the cap');
  } },
  { name: 'W3 step 7: removing the served handoff clears its precheck streak', run: async () => {
    const { source, log } = await makeHandBackSource();
    for (let index = 0; index < 4; index += 1) assert((await source.submit({ handoffCode: CODE, response: '{}' })).status === 'junk', `junk ${index + 1}`);
    assert(await source.handBackClaims({ epoch: 'default', claimIds: [CLAIM], reason: 'worker_restart_cap' }) === 1, 'the claim is handed back and removed');
    assert((await source.get()).status === 'served', 'the same request is served again afterwards');
    for (let index = 0; index < 4; index += 1) {
      const result = await source.submit({ handoffCode: CODE, response: '{}' });
      assert(result.status === 'junk', `a re-served request starts a fresh streak (got ${result.status} at ${index + 1})`);
    }
    assert(log.handBacks.length === 1 && log.handBacks[0].reason === 'worker_restart_cap', 'only the explicit claim hand-back has happened so far');
    const capped = await source.submit({ handoffCode: CODE, response: '{}' });
    assert(capped.status === 'needs_user' && log.handBacks.length === 2 && log.handBacks[1].reason === 'rejection_cap', 'the fresh streak caps at five');
  } },
  { name: 'W3 step 7: an unconfirmed precheck hand-back keeps the handoff served and retries on the next refusal', run: async () => {
    let confirmed = false;
    const { source, log } = await makeHandBackSource({ handBack: async () => confirmed });
    const results = [];
    for (let index = 0; index < 5; index += 1) results.push(await source.submit({ handoffCode: CODE, response: '{}' }));
    assert(results.every(result => result.status === 'junk') && log.handBacks.length === 1, 'an unconfirmed hand-back leaves the plain precheck status');
    confirmed = true;
    const retried = await source.submit({ handoffCode: CODE, response: '{}' });
    assert(retried.status === 'needs_user' && retried.reason === 'rejection_cap' && log.handBacks.length === 2, 'the streak is retained so the next refusal retries and succeeds');
  } },
  ...HAND_BACK_MODES.map(mode => ({
    name: `W3 step 7: handBackClaims releases a served handoff only on a true seam answer (${mode.name})`,
    run: async () => {
      const { source, log } = await makeHandBackSource({ handBack: mode.handBack });
      const handed = await source.handBackClaims({ epoch: 'default', claimIds: [CLAIM], reason: 'worker_restart_cap' });
      assert(log.handBacks.length === 1 && log.handBacks[0].requestId === entry.requestId && log.handBacks[0].reason === 'worker_restart_cap',
        `the seam is asked once with the request id and closed reason (got ${JSON.stringify(log.handBacks)})`);
      assert(handed === (mode.released ? 1 : 0), `released count must be ${mode.released ? 1 : 0} (got ${handed})`);
      const probe = await source.submit({ handoffCode: CODE, response: '{}' });
      assert(probe.status === (mode.released ? 'unknown_handoff' : 'junk'),
        `the served entry is ${mode.released ? 'released' : 'still owned'} (probe returned ${probe.status})`);
    },
  })),
  { name: 'W3 step 7: handBackClaims ignores unknown claim ids and never asks the seam', run: async () => {
    const { source, log } = await makeHandBackSource();
    assert(await source.handBackClaims({ epoch: 'default', claimIds: ['not-this-claim', 7, ''], reason: 'worker_restart_cap' }) === 0 && log.handBacks.length === 0,
      'only a matching bridge claim id is handed back');
    assert(await source.handBackClaims({ epoch: 'default', claimIds: [], reason: 'worker_restart_cap' }) === 0, 'an empty list hands back nothing');
    assert((await source.submit({ handoffCode: CODE, response: '{}' })).status === 'junk', 'the served entry is untouched');
  } },
  ...HAND_BACK_MODES.map(mode => ({
    name: `W3 step 7: handBackClaims releases an attachment reservation only on a true seam answer (${mode.name})`,
    run: async () => {
      const { source, log } = await makeReservedSource(mode.handBack);
      const before = await source.prepareAttachment({ epoch: 'E', worker: 'worker-2' });
      assert(before.status !== 'ready', 'while reserved, another worker cannot prepare the handoff');
      const handed = await source.handBackClaims({ epoch: 'E', claimIds: [CLAIM], reason: 'worker_restart_cap' });
      assert(log.length === 1 && log[0].requestId === entry.requestId && log[0].reason === 'worker_restart_cap', `the seam is asked once (got ${JSON.stringify(log)})`);
      assert(handed === (mode.released ? 1 : 0), `released count must be ${mode.released ? 1 : 0} (got ${handed})`);
      const after = await source.prepareAttachment({ epoch: 'E', worker: 'worker-2' });
      assert((after.status === 'ready') === mode.released,
        `the reservation is ${mode.released ? 'released to another worker' : 'still held'} (worker 2 prepare returned ${after.status})`);
    },
  })),
  { name: 'W3 repro R6: five consecutive junk submits for one served handoff hand it back to the person with rejection_cap', run: async () => {
    const handBacks = [];
    let seamSubmits = 0;
    const source = createPushSource({
      seam: {
        list: async () => ({ handoffs: [entry], excluded: {}, pending: 1 }),
        read: async item => ({ ok: true, requestId: item.requestId, handoffCode: item.handoffCode, task: item.task, responseFormat: item.responseFormat,
          prompt: 'Synthetic Ada scoring prompt', isCorrection: false, correction: '', attempt: 1 }),
        submit: async () => { seamSubmits += 1; return { outcome: 'accepted', accepted: true }; },
        handBack: async args => { handBacks.push({ ...args }); return true; },
      },
      windows: new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }]]), hubKey: testHubKey,
      timers: { setTimeout(fn) { fn(); return { unref() {} }; } },
    });
    assert(source.selectHub({ windowId: 71, canvasFilePath: '/tmp/ada.canvas', nodeId: 'node-ada' }), 'synthetic hub must select');
    assert((await source.get()).status === 'served', 'the synthetic handoff must be served before any submit');
    const results = [];
    for (let index = 0; index < 5; index += 1) results.push(await source.submit({ handoffCode: CODE, response: '{}' }));
    assert(results.slice(0, 4).every(result => result.status === 'junk') && seamSubmits === 0,
      `the first four empty-object submits are rejected by the precheck without reaching the seam (got ${results.map(result => result.status).join(',')}, seam=${seamSubmits})`);
    assert(results[4].status === 'needs_user' && results[4].reason === 'rejection_cap',
      `the fifth junk submit returns the handoff to the person (got ${JSON.stringify(results[4])})`);
    assert(handBacks.length === 1 && handBacks[0].requestId === entry.requestId && handBacks[0].reason === 'rejection_cap',
      `seam.handBack is called once with the request id and rejection_cap (got ${JSON.stringify(handBacks)})`);
  } },
  { name: 'handoff bridge: an attachment reservation binds one handoff to one worker chat', run: async () => {
    const attached = { ...entry, task: 'vision-product-analysis', hasAttachments: true };
    const source = createPushSource({
      experimentalAttachmentTasks: true,
      seam: {
        list: async () => ({ handoffs: [attached], excluded: {}, pending: 1 }),
        read: async () => ({ ok: true, requestId: attached.requestId, handoffCode: CODE,
          task: attached.task, responseFormat: 'json', prompt: 'Inspect the attached photo', attempt: 1 }),
        attachments: async () => ({ handoffCode: CODE, attachments: [{ name: 'item.png', mime: 'image/png', bytes: Buffer.from('photo') }] }),
        submit: async () => ({ outcome: 'accepted', accepted: true }),
      },
      windows: new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }]]), hubKey: testHubKey,
    });
    assert(source.selectHub({ windowId: 71, canvasFilePath: '/tmp/ada.canvas', nodeId: 'node-ada' }));
    source.setAllowedTasks(new Set(['vision-product-analysis']));
    const reserved = await source.prepareAttachment({ epoch: 'E', worker: 'worker-1' });
    assert(reserved.status === 'ready' && reserved.handoffCode === CODE && reserved.attachments[0].name === 'item.png');
    const other = await source.get({ epoch: 'E', worker: 'worker-2', keepWaiting: true });
    assert(other.status !== 'served', 'another worker must not receive the attached handoff');
    const own = await source.get({ epoch: 'E', worker: 'worker-1', keepWaiting: true });
    assert(own.status === 'served' && own.handoffCode === CODE);
    const accepted = await source.submit({ epoch: 'E', worker: 'worker-1', handoffCode: CODE,
      response: JSON.stringify({ handoffCode: CODE, description: 'ok' }) });
    assert(accepted.status === 'accepted');
    const after = await source.get({ epoch: 'E', worker: 'worker-1', keepWaiting: true });
    assert(after.status === 'queue_empty', 'the photo chat must not receive another handoff');
  } },
  { name: 'handoff bridge: failed attachment launch releases its lease to the manual dock', run: async () => {
    const attached = { ...entry, task: 'vision-product-analysis', hasAttachments: true };
    const fallbacks = [];
    const source = createPushSource({ experimentalAttachmentTasks: true,
      seam: { list: async () => ({ handoffs: [attached], excluded: {}, pending: 1 }),
        attachments: async () => ({ handoffCode: CODE, attachments: [{ name: 'item.png', mime: 'image/png', bytes: Buffer.from('photo') }] }),
        fallbackAttachment: args => { fallbacks.push(args.requestId); return true; } },
      windows: new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }]]), hubKey: testHubKey });
    assert(source.selectHub({ windowId: 71, canvasFilePath: '/tmp/ada.canvas', nodeId: 'node-ada' }));
    source.setAllowedTasks(new Set(['vision-product-analysis']));
    assert((await source.prepareAttachment({ epoch: 'E', worker: 'worker-1' })).status === 'ready');
    assert(source.releaseAttachment({ epoch: 'E', worker: 'worker-1', manualFallback: true }));
    assert(JSON.stringify(fallbacks) === JSON.stringify([attached.requestId]));
    assert((await source.prepareAttachment({ epoch: 'E', worker: 'worker-2' })).status === 'ready');
  } },
  { name: 'handoff bridge: a transient discovery gap cannot release an attachment while its bytes are being read', run: async () => {
    const attached = { ...entry, task: 'vision-product-analysis', hasAttachments: true };
    const entered = deferred();
    const finishRead = deferred();
    let lists = 0;
    const source = createPushSource({ seam: {
      list: async () => ({ handoffs: ++lists === 2 ? [] : [attached], excluded: {}, pending: 1 }),
      attachments: async () => { entered.resolve(); return finishRead.promise; },
    }, windows: new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }]]), hubKey: testHubKey });
    assert(source.selectHub({ windowId: 71, canvasFilePath: '/tmp/ada.canvas', nodeId: 'node-ada' }));
    source.setAllowedTasks(new Set(['vision-product-analysis']));
    const preparing = source.prepareAttachment({ epoch: 'E', worker: 'worker-1' });
    await entered.promise;
    await source.refreshHubs();
    finishRead.resolve({ handoffCode: CODE, attachments: [{ name: 'product.png', mime: 'image/png', bytes: Buffer.from('png') }] });
    assert((await preparing).status === 'ready');
  } },
  { name: 'handoff bridge: push end to end: one chat automatically drains eleven role-screen batches through get and submit', run: async () => {
    const codeSuffixes = '23456789ABH';
    const pending = Array.from({ length: 11 }, (_unused, index) => ({
      ...entry,
      requestId: `role-screen-${index + 1}`,
      bridgeClaimId: `${(0x30000000 + index).toString(16)}-3333-4333-8333-333333333333`,
      handoffCode: `HANDOFF-AAAAA${codeSuffixes[index]}`,
      task: 'job-role-screen-batch',
      responseFormat: 'json',
      batch: index + 1,
      batchTotal: 11,
      promptChars: 80,
    }));
    let accepted = 0;
    const push = createPushSource({
      seam: {
        list: async () => ({ handoffs: [...pending], excluded: {}, pending: pending.length }),
        read: async item => {
          const candidate = pending.find(value => value.requestId === item.requestId);
          return candidate
            ? { ok: true, requestId: candidate.requestId, handoffCode: candidate.handoffCode, task: candidate.task, responseFormat: 'json', prompt: `Role-screen batch ${candidate.batch} of 11`, isCorrection: false, correction: '', attempt: 1 }
            : { ok: false, code: 'NOT_PENDING' };
        },
        submit: async item => {
          const index = pending.findIndex(candidate => candidate.requestId === item.requestId);
          if (index < 0) return { outcome: 'not_pending' };
          pending.splice(index, 1);
          accepted += 1;
          return { outcome: 'accepted', accepted: true };
        },
      },
      windows: new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }]]),
      hubKey: testHubKey,
      activeNodeTasks: () => [],
      autoSelectHubs: true,
      graceMs: 0,
      pollMs: 0,
    });
    const application = {
      read: async () => ({ kind: 'gone' }),
      status: async () => ({ kind: 'gone' }),
      submit: async () => ({ kind: 'gone' }),
    };
    const engine = createHandoffEngine({
      sources: { application, push },
      scope: { applications: false, scoring: true, marketplace: false },
      random: () => Buffer.alloc(26, 7),
      holdMs: 0,
      submitBudgetMs: 1_000,
    });
    assert(await engine.refreshPushHubs(), 'the production-style auto-selection refresh must discover the role-screen hub');
    const before = engine.snapshot();
    assert(before.chat.state === 'none' && before.queue.push.available.length === 11 && before.queue.push.claimed.length === 0,
      'without a ChatGPT client call all eleven routes are selected and available, but none is claimed');

    const chat = await engine.newChat({ linkId: LINK });
    assert(chat.copied === true, 'one starter creates the bridge chat session');
    let handoff = await engine.get({ session: chat.sessionCode, linkId: LINK });
    for (let index = 0; index < 11; index += 1) {
      assert(handoff.status === 'served' && handoff.kind === 'push' && handoff.task === 'job-role-screen-batch'
        && handoff.batch === index + 1 && handoff.batchTotal === 11 && handoff.responseFormat === 'json',
      `automatic get must issue role batch ${index + 1} in order (${JSON.stringify(handoff)})`);
      const submitted = await engine.submit({
        session: chat.sessionCode,
        linkId: LINK,
        handoffCode: handoff.handoffCode,
        response: JSON.stringify({ handoffCode: handoff.handoffCode, decisions: [] }),
      });
      assert(submitted.status === 'accepted', `automatic submit must accept role batch ${index + 1}`);
      handoff = submitted.next || (index < 10 ? await engine.get({ session: chat.sessionCode, linkId: LINK }) : null);
    }
    const after = engine.snapshot();
    assert(accepted === 11 && pending.length === 0 && after.queue.push.claimed.length === 0 && after.queue.push.available.length === 0,
      'the same active chat returns all eleven answers through submit_handoff and leaves no manual paste route behind');
    await engine.close();
  } },
  { name: 'handoff bridge: push: selected availability is exact, is consumed by a claim, and clears on unselect', run: async () => {
    const { source } = makeSource();
    await source.refreshHubs();
    assert(JSON.stringify(source.status().available) === JSON.stringify([CLAIM]) && source.status().claimed.length === 0,
      'a selected eligible handoff exposes only its opaque available claim id before ChatGPT polls');
    const served = await source.get();
    assert(served.status === 'served' && source.status().available.length === 0 && JSON.stringify(source.status().claimed) === JSON.stringify([CLAIM]),
      'serving consumes the available id and promotes only that same id to claimed');
    assert(source.unselectHubKey(testHubKey('/tmp/ada.canvas', 'node-ada')),
      'the selected synthetic hub can be explicitly unselected');
    assert(source.status().available.length === 0 && source.status().claimed.length === 0,
      'unselect clears both an available/claimed route instead of leaving stale ownership in the dock');
  } },
  { name: 'handoff bridge: push: a claimed handoff reports its owning worker only through the bounded claim-worker map', run: async () => {
    const { source } = makeSource();
    await source.refreshHubs();
    const served = await source.get({ epoch: 'answer-silent-owner', worker: 'worker-3' });
    const status = source.status('answer-silent-owner');
    assert(served.status === 'served'
      && JSON.stringify(status.claimWorkers) === JSON.stringify([{ claimId: CLAIM, workerOrdinal: 3 }]),
    'the active claim has a stable worker ordinal for per-worker silence tracking without exposing a session or prompt');
    assert(!JSON.stringify(status.claimWorkers).includes('request-ada')
      && !JSON.stringify(status.claimWorkers).includes('/tmp/ada.canvas'),
    'claim-worker status never exposes seam request identifiers or canvas paths');
  } },
  { name: 'handoff bridge: push: a bounded queued-work forecast de-duplicates an active preference-research wave without disclosing its scope', run: async () => {
    const scopeId = 'a9e61d1f-2c80-4f12-93ef-260c77e0b821';
    const entries = Array.from({ length: 5 }, (_unused, index) => ({
      ...entry,
      requestId: `preference-forecast-${index + 1}`,
      bridgeClaimId: `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`,
      handoffCode: `HANDOFF-AAAAA${index + 2}`,
      task: 'job-preference-research-batch',
      queuedWorkForecast: { scopeId, remainingUnits: 209 - index },
    }));
    entries.push({
      ...entry,
      requestId: 'preference-forecast-invalid',
      bridgeClaimId: '22222222-2222-4222-8222-000000000099',
      handoffCode: 'HANDOFF-AAAAA7',
      task: 'job-scoring',
      // An injected/sensitive-looking scope and runaway count must be ignored
      // rather than reaching the planning cache or public status.
      queuedWorkForecast: { scopeId: 'PRIVATE_LISTING_TEXT_MUST_NOT_SURFACE', remainingUnits: 999999 },
    });
    const { source } = makeSource({ entries });
    await source.refreshHubs();
    const status = source.status();
    const task = status.discovered[0]?.tasks.find(item => item.task === 'job-preference-research-batch');
    assert(status.discovered[0]?.pending === 6 && task?.pending === 5 && task?.forecast === 209
      && !Object.hasOwn(task || {}, 'scopeId')
      && !JSON.stringify(status).includes(scopeId)
      && !JSON.stringify(status).includes('PRIVATE_LISTING_TEXT_MUST_NOT_SURFACE'),
    `five visible batches from a 209-batch research phase must retain the full forecast without leaking a scope (${JSON.stringify(task)})`);
  } },
  { name: 'handoff bridge: push: an injected scope allowlist polls and serves only its consented task family', run: async () => {
    const marketplace = { ...entry, requestId: 'request-market', handoffCode: 'HANDOFF-BCDEFG', task: 'price-synthesis', bridgeClaimId: '33333333-3333-4333-8333-333333333333' };
    const calls = [];
    // Both discovery and get calls prove the exact requested set at the seam.
    const windows = new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }]]);
    const scoped = createPushSource({
      seam: {
        list: async args => { calls.push(args); return { handoffs: [entry, marketplace], excluded: {} }; },
        read: async item => ({ ok: true, requestId: item.requestId, handoffCode: item.handoffCode, task: item.task, prompt: 'Synthetic prompt', attempt: 1 }),
        submit: async () => ({ outcome: 'accepted' }),
      }, windows, hubKey: testHubKey,
    });
    scoped.setAllowedTasks(new Set(['job-scoring']));
    assert(scoped.selectHub({ windowId: 71, canvasFilePath: '/tmp/ada.canvas', nodeId: 'node-ada' }), 'selected hub is still an explicit per-hub consent');
    await scoped.refreshHubs();
    const scoring = await scoped.get();
    assert(scoring.status === 'served' && JSON.stringify(scoped.status().claimed) === JSON.stringify([CLAIM]), 'scoring-only scope claims only the scoring request');
    assert([...calls[0].allowTasks].join() === 'job-scoring' && [...calls[1].allowTasks].join() === 'job-scoring', `scoring-only scope requests only scoring tasks (${[...calls[0].allowTasks]} / ${[...calls[1].allowTasks]})`);
    scoped.setAllowedTasks(new Set(['price-synthesis']));
    assert(scoped.status().claimed.length === 0, 'scope downgrade releases a previously served out-of-scope claim back to the dock');
    const marketplaceFrame = await scoped.get();
    assert(marketplaceFrame.status === 'served' && JSON.stringify(scoped.status().claimed) === JSON.stringify([marketplace.bridgeClaimId]) && [...calls.at(-1).allowTasks].join() === 'price-synthesis', 'marketplace-only scope cannot be starved by an out-of-scope scoring sibling');
  } },
  { name: 'handoff bridge: push: an old discovery completion cannot overwrite its replacement owner', run: async () => {
    const oldList = deferred(); const newList = deferred(); let calls = 0;
    const old = { ...entry, requestId: 'request-old', nodeId: 'node-old' };
    const fresh = { ...entry, requestId: 'request-fresh', nodeId: 'node-fresh', handoffCode: 'HANDOFF-BCDEFG', task: 'job-query-generation' };
    const source = createPushSource({
      seam: { list: async () => (++calls === 1 ? oldList.promise : newList.promise), read: async () => ({ ok: false }), submit: async () => ({ outcome: 'not_pending' }) },
      windows: new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }]]), hubKey: testHubKey,
    });
    const ownerA = {}; const ownerB = {};
    source.setDiscoveryOwner(ownerA);
    const stale = source.refreshHubs({ owner: ownerA });
    source.setDiscoveryOwner(ownerB);
    const current = source.refreshHubs({ owner: ownerB });
    newList.resolve({ handoffs: [fresh], excluded: {} });
    assert(await current, 'the replacement owner may publish its own completed discovery');
    oldList.resolve({ handoffs: [old], excluded: {} });
    assert(await stale === false && source.status().discovered[0]?.tasks[0]?.task === 'job-query-generation' && source.status().discovered[0]?.pending === 1, 'the old completion is discarded instead of overwriting replacement discovery');
  } },
  { name: 'handoff bridge: push: an old selected read cannot claim after its replacement owner refreshes', run: async () => {
    const oldList = deferred(); const oldRead = deferred(); let beginRead;
    const readStarted = new Promise(resolve => { beginRead = resolve; });
    let listCalls = 0;
    const old = { ...entry, requestId: 'request-old-read' };
    const fresh = { ...entry, requestId: 'request-fresh-read', handoffCode: 'HANDOFF-BCDEFG', task: 'job-query-generation' };
    const source = createPushSource({
      seam: {
        list: async () => (++listCalls === 1 ? oldList.promise : { handoffs: [fresh], excluded: {} }),
        read: async () => { beginRead(); return oldRead.promise; },
        submit: async () => ({ outcome: 'not_pending' }),
      },
      windows: new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }]]), hubKey: testHubKey,
    });
    const ownerA = {}; const ownerB = {};
    source.selectHub({ windowId: 71, canvasFilePath: '/tmp/ada.canvas', nodeId: 'node-ada' });
    source.setDiscoveryOwner(ownerA);
    const stale = source.get({ epoch: 'old-engine', owner: ownerA });
    oldList.resolve({ handoffs: [old], excluded: {} });
    await readStarted;
    source.setDiscoveryOwner(ownerB);
    assert(await source.refreshHubs({ owner: ownerB }), 'the replacement owner refreshes while the old selected read is pending');
    oldRead.resolve({ ok: true, requestId: old.requestId, handoffCode: old.handoffCode, task: old.task, prompt: 'stale prompt', attempt: 1 });
    const staleResult = await stale;
    assert(staleResult.status === 'retry' && source.status('old-engine').claimed.length === 0, 'the late old read cannot serve or claim a handoff in the replacement lifecycle');
    assert(source.status().discovered[0]?.tasks[0]?.task === 'job-query-generation', 'the late old read cannot overwrite the replacement discovery cache');
    const before = listCalls;
    assert((await source.nextAfterAccept({ epoch: 'old-engine', owner: ownerA, budgetMs: 1 })).status === 'retry' && listCalls === before, 'successor polling propagates the same stale-owner fence without starting a new selected read');
  } },
  { name: 'handoff bridge: push: an old-scope refresh cannot mutate newer-scope discovery or claims', run: async () => {
    const oldList = deferred(); let calls = 0;
    const marketplace = { ...entry, requestId: 'request-market-scope', handoffCode: 'HANDOFF-BCDEFG', task: 'price-synthesis', bridgeClaimId: '33333333-3333-4333-8333-333333333333' };
    const source = createPushSource({
      seam: { list: async () => (++calls === 1 ? oldList.promise : { handoffs: [marketplace], excluded: {} }), read: async item => ({ ok: true, requestId: item.requestId, handoffCode: item.handoffCode, task: item.task, prompt: 'Synthetic prompt', attempt: 1 }), submit: async () => ({ outcome: 'accepted' }) },
      windows: new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }]]), hubKey: testHubKey,
    });
    source.selectHub({ windowId: 71, canvasFilePath: '/tmp/ada.canvas', nodeId: 'node-ada' });
    source.setAllowedTasks(new Set(['job-scoring']));
    const stale = source.refreshHubs();
    source.setAllowedTasks(new Set(['price-synthesis']));
    assert((await source.get({ epoch: 'scope-race' })).status === 'served', 'the new scope serves its own family before the old refresh returns');
    oldList.resolve({ handoffs: [], excluded: {} });
    assert(await stale === false && JSON.stringify(source.status('scope-race').claimed) === JSON.stringify([marketplace.bridgeClaimId]),
      'the old-scope snapshot is discarded rather than erasing a newer-scope claim');
  } },
  { name: 'handoff bridge: push: a scope downgrade during prompt read cannot install a stale dock claim', run: async () => {
    const pendingRead = deferred(); let beginRead;
    const readStarted = new Promise(resolve => { beginRead = resolve; });
    const source = createPushSource({
      seam: {
        list: async () => ({ handoffs: [entry], excluded: {} }),
        read: async () => { beginRead(); return pendingRead.promise; },
        submit: async () => ({ outcome: 'accepted' }),
      }, windows: new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }]]), hubKey: testHubKey,
    });
    source.selectHub({ windowId: 71, canvasFilePath: '/tmp/ada.canvas', nodeId: 'node-ada' });
    source.setAllowedTasks(new Set(['job-scoring']));
    const stale = source.get({ epoch: 'scope-read-race' });
    await readStarted;
    source.setAllowedTasks(new Set(['price-synthesis']));
    pendingRead.resolve({ ok: true, requestId: entry.requestId, handoffCode: entry.handoffCode, task: entry.task, prompt: 'stale scoring prompt', attempt: 1 });
    const result = await stale;
    const status = source.status('scope-read-race');
    assert(result.status === 'retry' && status.served === 0 && status.claimed.length === 0,
      'a late old-scope prompt read must return control to the dock instead of installing a hidden claim');
  } },
  { name: 'handoff bridge: push: an older full refresh cannot clear a claim served after it began', run: async () => {
    const oldList = deferred(); let calls = 0;
    const source = createPushSource({
      seam: { list: async () => (++calls === 1 ? oldList.promise : { handoffs: [entry], excluded: {} }), read: async item => ({ ok: true, requestId: item.requestId, handoffCode: item.handoffCode, task: item.task, prompt: 'Synthetic prompt', attempt: 1 }), submit: async () => ({ outcome: 'accepted' }) },
      windows: new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }]]), hubKey: testHubKey,
    });
    source.selectHub({ windowId: 71, canvasFilePath: '/tmp/ada.canvas', nodeId: 'node-ada' });
    const stale = source.refreshHubs();
    await source.get({ epoch: 'later-claim' });
    oldList.resolve({ handoffs: [], excluded: {} });
    assert(await stale && JSON.stringify(source.status('later-claim').claimed) === JSON.stringify([CLAIM]),
      'a complete but older empty refresh only reconciles claims it could have observed at its own start');
  } },
  { name: 'handoff bridge: push: an older selected poll cannot clear a concurrent newer claim', run: async () => {
    const oldList = deferred(); let calls = 0;
    // The first selected list is delayed while a second one serves the same
    // request in this epoch.
    const raced = createPushSource({
      seam: { list: async () => (++calls === 1 ? oldList.promise : { handoffs: [entry], excluded: {} }), read: async item => ({ ok: true, requestId: item.requestId, handoffCode: item.handoffCode, task: item.task, prompt: 'Synthetic prompt', attempt: 1 }), submit: async () => ({ outcome: 'accepted' }) },
      windows: new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }]]), hubKey: testHubKey,
    });
    raced.selectHub({ windowId: 71, canvasFilePath: '/tmp/ada.canvas', nodeId: 'node-ada' });
    const oldGet = raced.get({ epoch: 'concurrent-get' });
    assert((await raced.get({ epoch: 'concurrent-get' })).status === 'served', 'the later selected poll serves its handoff');
    oldList.resolve({ handoffs: [], excluded: {} });
    await oldGet;
    assert(JSON.stringify(raced.status('concurrent-get').claimed) === JSON.stringify([CLAIM]), 'the old empty selected poll cannot erase the later claim');
  } },
  { name: 'handoff bridge: push: same-epoch pool workers synchronously reserve distinct prompt reads', run: async () => {
    const second = { ...entry, requestId: 'request-pool-two', handoffCode: 'HANDOFF-BCDEFG', bridgeClaimId: '33333333-3333-4333-8333-333333333333' };
    const readGate = deferred();
    const reads = [];
    let bothReadsStarted;
    const readsStarted = new Promise(resolve => { bothReadsStarted = resolve; });
    const source = createPushSource({
      seam: {
        list: async () => ({ handoffs: [entry, second], excluded: {} }),
        read: async item => {
          reads.push(item);
          if (reads.length === 2) bothReadsStarted();
          await readGate.promise;
          return { ok: true, requestId: item.requestId, handoffCode: item.handoffCode, task: item.task, prompt: `Prompt for ${item.handoffCode}`, attempt: 1 };
        },
        submit: async () => ({ outcome: 'accepted' }),
      }, windows: new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }]]), hubKey: testHubKey,
    });
    source.selectHub({ windowId: 71, canvasFilePath: '/tmp/ada.canvas', nodeId: 'node-ada' });
    const first = source.get({ epoch: 'pool-race', worker: 'worker-1' });
    const next = source.get({ epoch: 'pool-race', worker: 'worker-2' });
    await readsStarted;
    const beforeResolve = source.status('pool-race');
    assert(new Set(reads.map(item => item.requestId)).size === 2
      && beforeResolve.served === 0
      && beforeResolve.working === 2
      && beforeResolve.available.length === 0
      && new Set(beforeResolve.claimed).size === 2,
    'two concurrent workers reserve two distinct requests before either prompt read resolves, count as working, and both opaque claims remain dock-hidden');
    readGate.resolve();
    const [one, two] = await Promise.all([first, next]);
    assert(one.status === 'served' && two.status === 'served' && one.handoffCode !== two.handoffCode,
      'each same-epoch worker receives only its own distinct handoff after the reads complete');
    assert((await source.submit({ epoch: 'pool-race', worker: 'worker-2', handoffCode: one.handoffCode, response: JSON.stringify({ handoffCode: one.handoffCode }) })).status === 'unknown_handoff',
      'a worker cannot submit the route leased to its sibling worker');
  } },
  { name: 'handoff bridge: push: ten concurrent pool workers drain ten distinct live handoffs and wait behind a replayed forecast wave', run: async () => {
    const suffixes = '23456789AB';
    const entries = Array.from({ length: 10 }, (_unused, index) => ({
      ...entry,
      requestId: `throughput-${index + 1}`,
      bridgeClaimId: `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      handoffCode: `HANDOFF-THRPT${suffixes[index]}`,
      promptChars: 80 + index,
    }));
    const accepted = [];
    const windows = new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }]]);
    const source = createPushSource({
      seam: {
        list: async () => ({ handoffs: [...entries], excluded: {}, pending: entries.length }),
        read: async item => ({
          ok: true,
          requestId: item.requestId,
          handoffCode: item.handoffCode,
          task: item.task,
          prompt: `Distinct prompt for ${item.requestId}`,
          attempt: 1,
        }),
        submit: async item => {
          const index = entries.findIndex(candidate => candidate.requestId === item.requestId);
          if (index < 0) return { outcome: 'not_pending' };
          accepted.push({ requestId: item.requestId, code: item.handoffCode });
          entries.splice(index, 1);
          return { outcome: 'accepted' };
        },
      },
      windows,
      hubKey: testHubKey,
      graceMs: 0,
      pollMs: 0,
    });
    assert(source.selectHub({ windowId: 71, canvasFilePath: '/tmp/ada.canvas', nodeId: 'node-ada' }), 'the throughput hub must be selected');

    const epoch = 'pool-throughput';
    const workers = Array.from({ length: 10 }, (_unused, index) => `worker-${index + 1}`);
    const served = await Promise.all(workers.map(worker => source.get({ epoch, worker, keepWaiting: true })));
    assert(served.every(item => item.status === 'served')
      && new Set(served.map(item => item.handoffCode)).size === 10
      && new Set(served.map(item => item.prompt)).size === 10,
    `ten simultaneous workers must receive ten distinct live leases (${JSON.stringify(served.map(item => item.status))})`);

    const siblingAttempt = await source.submit({
      epoch,
      worker: workers[1],
      handoffCode: served[0].handoffCode,
      response: JSON.stringify({ handoffCode: served[0].handoffCode }),
    });
    assert(siblingAttempt.status === 'unknown_handoff', 'a worker must never submit a sibling worker\'s lease');

    const settlements = await Promise.all(served.map((handoff, index) => source.submit({
      epoch,
      worker: workers[index],
      handoffCode: handoff.handoffCode,
      response: JSON.stringify({ handoffCode: handoff.handoffCode, worker: workers[index] }),
    })));
    assert(settlements.every(item => item.status === 'accepted')
      && accepted.length === 10
      && new Set(accepted.map(item => item.requestId)).size === 10
      && source.status(epoch).claimed.length === 0,
    'each owner must settle exactly its own lease, without losing or retaining work');

    const replay = {
      ...entry,
      requestId: 'throughput-replay',
      bridgeClaimId: '40000000-0000-4000-8000-000000000011',
      handoffCode: 'HANDOFF-THRPTC',
      queuedWorkForecast: { scopeId: 'a9e61d1f-2c80-4f12-93ef-260c77e0b821', remainingUnits: 999 },
    };
    entries.push(replay);
    const replayOwner = await source.get({ epoch, worker: workers[0], keepWaiting: true });
    const replayAgain = await source.get({ epoch, worker: workers[0], keepWaiting: true });
    const waiters = await Promise.all(workers.slice(1).map(worker => source.get({ epoch, worker, keepWaiting: true })));
    assert(replayOwner.status === 'served' && replayAgain.status === 'served'
      && replayOwner.handoffCode === replay.handoffCode && replayAgain.handoffCode === replay.handoffCode,
    'the current owner must be able to replay its one live handoff');
    assert(waiters.every(item => item.status === 'waiting' && item.remaining?.working === 1),
      `future forecast work must keep sibling workers waiting behind the current replay, never queue-empty (${JSON.stringify(waiters)})`);
  } },
  { name: 'handoff bridge: push: an idle pool worker takes one authoritative snapshot and reports the sibling lease as working', run: async () => {
    let lists = 0;
    const source = createPushSource({
      seam: {
        list: async () => { lists += 1; return { handoffs: [entry], excluded: {} }; },
        read: async item => ({ ok: true, requestId: item.requestId, handoffCode: item.handoffCode, task: item.task, prompt: 'Synthetic prompt', attempt: 1 }),
        submit: async () => ({ outcome: 'accepted' }),
      }, windows: new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }]]), hubKey: testHubKey,
    });
    source.selectHub({ windowId: 71, canvasFilePath: '/tmp/ada.canvas', nodeId: 'node-ada' });
    const served = await source.get({ epoch: 'pool-wait', worker: 'worker-1' });
    const idle = await source.get({ epoch: 'pool-wait', worker: 'worker-2', keepWaiting: true });
    const status = source.status('pool-wait');
    assert(served.status === 'served' && served.remaining.working === 1,
      'the worker which receives a handoff must see its own active lease as working');
    assert(idle.status === 'waiting' && idle.retryAfterSeconds === 3 && idle.remaining.working === 1 && lists === 2,
      'an idle pool worker must return one structured wait after one registry snapshot, not spin three successor polls');
    assert(status.working === 1 && status.claimed.length === 1,
      'the synchronous status projection must retain the active served lease as working');
  } },
  { name: 'handoff bridge: push: status projects only an exact opaque claim while ChatGPT owns the request', run: async () => {
    const { source } = makeSource();
    const frame = await source.get({ epoch: 'claim-test' });
    const claimed = source.status('claim-test').claimed;
    assert(JSON.stringify(claimed) === JSON.stringify([CLAIM]), 'a served request exposes its own opaque bridge claim token');
    assert(!JSON.stringify(source.status('claim-test')).includes(entry.requestId) && !JSON.stringify(source.status('claim-test')).includes(CODE), 'claim status must not disclose request ids or handoff codes');
    assert(!JSON.stringify(frame).includes(CLAIM), 'the renderer-only claim token never enters the MCP handoff frame');
    const result = await source.submit({ epoch: 'claim-test', handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF"}' });
    assert(result.status === 'accepted' && source.status('claim-test').claimed.length === 0, 'accepted work immediately releases its claim projection');
  } },
  { name: 'handoff bridge: push: claim follows an exact request, not a same-task sibling', run: async () => {
    const siblingClaim = '33333333-3333-4333-8333-333333333333';
    const entries = [entry, { ...entry, requestId: 'request-grace', bridgeClaimId: siblingClaim, handoffCode: 'HANDOFF-BCDEFG' }];
    const { source } = makeSource({ entries });
    await source.get({ epoch: 'exact-claim' });
    assert(JSON.stringify(source.status('exact-claim').claimed) === JSON.stringify([CLAIM]), 'only the served request, not every job-scoring handoff, is held');
    entries.splice(0, 1);
    await source.get({ epoch: 'exact-claim' });
    assert(JSON.stringify(source.status('exact-claim').claimed) === JSON.stringify([siblingClaim]), 'a no-longer-pending request gives its dock controls back while a sibling gets its own claim');
    source.closeEpoch('exact-claim');
    assert(source.status('exact-claim').claimed.length === 0, 'chat rotation clears the renderer claim instead of leaving the dock suppressed');
  } },
  { name: 'handoff bridge: push: stale canvas paths release the served claim', run: async () => {
    for (const canvasFilePath of ['/tmp/after-save-as.canvas', null]) {
      const { source, windows } = makeSource();
      await source.get({ epoch: 'save-as-claim' });
      windows.get(71).__canvasFilePath = canvasFilePath;
      const status = source.status('save-as-claim');
      assert(status.claimed.length === 0 && status.served === 0 && status.selectedHubs.length === 0,
        'a live window changing or clearing its file prunes the now-unservable hub');
    }
  } },
  { name: 'handoff bridge: push: losing a display window preserves only its previously selected exact hub for worker completion', run: async () => {
    for (const claimBeforeLoss of [false, true]) {
      const sibling = { ...entry, requestId: 'detached-unselected', nodeId: 'unselected-node',
        bridgeClaimId: '33333333-3333-4333-8333-333333333333', handoffCode: 'HANDOFF-BCDEFG' };
      const entries = [entry]; let submitted = 0;
      const { source, windows } = makeSource({ entries, autoSelectHubs: true, submit: async args => {
        assert(args.requestId === entry.requestId && args.allowNodeIds.size === 1 && args.allowNodeIds.has(entry.nodeId)
          && args.allowWindowNodePairs.size === 1 && args.allowWindowNodePairs.has(`${entry.windowId}\u0000${entry.nodeId}`),
        'a detached worker submit retains the exact previously verified main-process hub scope');
        submitted += 1; return { outcome: 'accepted', accepted: true };
      } });
      const get = () => source.get({ epoch: 'display-lost', worker: 'worker-1' });
      if (claimBeforeLoss) assert((await get()).status === 'served');
      windows.delete(71);
      entries.push(sibling);
      assert(await source.refreshHubs(), 'registry discovery still succeeds without the display window');
      const pending = source.status('display-lost');
      assert(pending.selectedHubs.length === 1 && pending.discovered.length === 1
        && pending.discovered[0].pending === 1, 'only the already selected exact window/node hub is remembered');
      assert(!source.selectHub({ windowId: 71, canvasFilePath: '/tmp/ada.canvas', nodeId: sibling.nodeId })
        && !source.selectHubKey(testHubKey('/tmp/ada.canvas', sibling.nodeId)), 'a missing window cannot authorize a new detached hub');
      const first = await get(); const replay = await get();
      assert(first.status === 'served' && replay.status === 'served' && first.handoffCode === CODE
        && replay.handoffCode === CODE && source.status('display-lost').claimed.length === 1,
      'the original worker can read or re-read its exact pending claim after the window disappears');
      assert((await source.submit({ epoch: 'display-lost', worker: 'worker-1', handoffCode: CODE, response: VALID_RESPONSE })).status === 'accepted'
        && submitted === 1 && source.status('display-lost').claimed.length === 0, 'the worker completes through its original push route');
    }
  } },
  { name: 'handoff bridge: push: explicit scope removal revokes a remembered closed-window hub', run: async () => {
    for (const clear of [false, true]) {
      const { source, windows } = makeSource({ autoSelectHubs: true });
      assert((await source.get({ epoch: 'detached-opt-out' })).status === 'served');
      windows.delete(71);
      assert(source.status('detached-opt-out').claimed.length === 1);
      if (clear) source.clearHubs({ windowId: 71 });
      else assert(source.unselectHubKey(testHubKey('/tmp/ada.canvas', entry.nodeId)));
      assert(await source.refreshHubs());
      const status = source.status('detached-opt-out');
      assert(status.selectedHubs.length === 0 && status.claimed.length === 0 && status.discovered.length === 0,
        'removing scope also removes the only remembered authority for a closed window');
      assert((await source.get({ epoch: 'detached-opt-out' })).status !== 'served', 'discovery cannot silently restore detached scope');
    }
  } },
  { name: 'handoff bridge: push: a full registry refresh releases a settled served claim', run: async () => {
    const entries = [entry];
    const { source } = makeSource({ entries });
    await source.get({ epoch: 'registry-settle' });
    assert(source.status('registry-settle').claimed.length === 1, 'the served request initially owns its exact bridge claim');
    entries.splice(0, 1);
    assert(await source.refreshHubs(), 'the registry wake refresh completes from its complete eligible snapshot');
    const status = source.status('registry-settle');
    assert(status.served === 0 && status.claimed.length === 0 && status.discovered.length === 0,
      'a settled or cancelled record is handed back immediately without waiting for another MCP get or epoch close');
  } },
  { name: 'handoff bridge: push: a settling registry refresh retains a bridge route for a validation correction', run: async () => {
    let settling = false; const verdict = deferred(); let submissions = 0;
    const source = createPushSource({
      seam: {
        list: async () => settling
          ? { handoffs: [], excluded: { settling: 1 }, settlingRequestIds: [entry.requestId] }
          : { handoffs: [entry], excluded: {}, settlingRequestIds: [] },
        read: async item => ({ ok: true, requestId: item.requestId, handoffCode: item.handoffCode, task: item.task, prompt: 'Synthetic prompt', attempt: 1 }),
        submit: async () => { submissions += 1; settling = true; return submissions === 1 ? verdict.promise : { outcome: 'accepted' }; },
      }, windows: new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }]]), hubKey: testHubKey,
    });
    source.selectHub({ windowId: 71, canvasFilePath: '/tmp/ada.canvas', nodeId: 'node-ada' });
    await source.get({ epoch: 'validation-race' });
    const rejected = source.submit({ epoch: 'validation-race', handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF","first":true}' });
    await Promise.resolve();
    assert(await source.refreshHubs() && source.status('validation-race').claimed.length === 1,
      'a wake during the bridge submit recognizes the exact settling record as live rather than dropping its route');
    settling = false;
    verdict.resolve({ outcome: 'rejected', correction: 'Fix the response.', isCorrection: true });
    assert((await rejected).status === 'rejected', 'the first response remains a normal validation rejection');
    assert((await source.submit({ epoch: 'validation-race', handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF","corrected":true}' })).status === 'accepted' && submissions === 2,
      'the retained code route accepts the correction after the refresh race');
  } },
  { name: 'handoff bridge: push: a paced rejection releases its served route and reports the persisted retry wait', run: async () => {
    let cooled = false;
    const source = createPushSource({
      seam: {
        list: async () => cooled
          ? { handoffs: [], excluded: { cooldown: 1 }, retryAfterMs: 1_250 }
          : { handoffs: [entry], excluded: {} },
        read: async item => ({ ok: true, requestId: item.requestId, handoffCode: item.handoffCode, task: item.task, prompt: 'Synthetic prompt', attempt: 1 }),
        submit: async () => { cooled = true; return { outcome: 'rejected', retryAfterMs: 1_250, isCorrection: true, correction: 'Repair the cited segment.' }; },
      }, windows: new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }]]), hubKey: testHubKey,
    });
    source.selectHub({ windowId: 71, canvasFilePath: '/tmp/ada.canvas', nodeId: 'node-ada' });
    await source.get({ epoch: 'paced-rejection' });
    const rejected = await source.submit({ epoch: 'paced-rejection', handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF","first":true}' });
    const waiting = await source.get({ epoch: 'paced-rejection', keepWaiting: true });
    assert(rejected.status === 'waiting' && rejected.retryAfterSeconds === 2
      && source.status('paced-rejection').claimed.length === 0
      && waiting.status === 'waiting' && waiting.retryAfterSeconds === 2,
    'a paced rejection removes the old submit route and gives every later get a bounded round-up retry deadline');
  } },
  { name: 'handoff bridge: push: cancelled settling work still releases its bridge claim', run: async () => {
    const { source } = makeSource({ submit: async () => ({ outcome: 'cancelled_during_save' }) });
    await source.get({ epoch: 'cancelled-cleanup' });
    const outcome = await source.submit({ epoch: 'cancelled-cleanup', handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF"}' });
    assert(outcome.status === 'superseded' && source.status('cancelled-cleanup').claimed.length === 0,
      'a terminal cancellation releases the exact claim rather than treating it as transient settling');
  } },
  { name: 'handoff bridge: push: opaque hub keys are path-sensitive and never contain a path or node id', run: () => {
    const one = testHubKey('/tmp/ada.canvas', 'node-ada');
    const copiedCanvas = testHubKey('/tmp/copied.canvas', 'node-ada');
    const siblingNode = testHubKey('/tmp/ada.canvas', 'node-other');
    assert(/^[a-f0-9]{64}$/.test(one) && one !== copiedCanvas && one !== siblingNode, 'hub display key must distinguish both canvas and node');
    assert(!one.includes('ada') && !one.includes('node'), 'hub display key must not disclose its inputs');
  } },
  { name: 'handoff bridge: push: missing hub-key port fails closed without a discovery leak', run: async () => {
    const source = createPushSourcePort({
      seam: { list: async () => ({ handoffs: [entry], excluded: {} }), read: async () => ({ ok: false }), submit: async () => ({ outcome: 'not_pending' }) },
      windows: new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }]]),
      codeGuard,
    });
    assert(await source.refreshHubs(), 'an unavailable display port may still complete the bounded lookup');
    assert(source.status().discovered.length === 0 && !source.selectHub({ windowId: 71, canvasFilePath: '/tmp/ada.canvas', nodeId: 'node-ada' }), 'no hub key must mean no selected or disclosed hub');
  } },
  { name: 'handoff bridge: push: discovery is cached, opaque, and key selection re-establishes exact ownership', run: async () => {
    const calls = [];
    const windows = new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }], [72, { __canvasFilePath: '/tmp/other.canvas' }]]);
    const entries = [entry, { ...entry, requestId: 'request-other', windowId: 72 }];
    const source = createPushSource({
      seam: {
        list: async args => { calls.push(args); return { handoffs: entries, excluded: { attachment: 2, grounded: 1 } }; },
        read: async item => ({ ok: true, requestId: item.requestId, handoffCode: item.handoffCode, task: item.task, prompt: 'Synthetic prompt', attempt: 1 }),
        submit: async () => ({ outcome: 'accepted' }),
      },
      windows, hubKey: testHubKey,
      timers: { setTimeout(fn) { fn(); return { unref() {} }; } },
    });
    assert(await source.refreshHubs(), 'main-owned discovery must refresh asynchronously');
    const before = source.status();
    assert(before.selectedHubs.length === 0 && before.discovered.length === 2 && !JSON.stringify(before).includes('/tmp') && !JSON.stringify(before).includes('node-ada'), 'sync status must expose only safe cached rows');
    assert(before.diagnostics.refreshAttempts === 1 && before.diagnostics.refreshFailures === 0
      && before.diagnostics.lastRefreshOk === true && before.diagnostics.exclusionScope === 'all'
      && before.diagnostics.exclusions.attachment === 2,
    'all-hub discovery retains only bounded outcome and exclusion evidence for diagnostics');
    const key = before.discovered.find(hub => hub.key === testHubKey('/tmp/ada.canvas', 'node-ada')).key;
    assert(source.selectHubKey(key), 'known discovered key must select its exact main-owned triple');
    await source.get();
    const afterSelectedGet = source.status();
    assert(afterSelectedGet.discovered.length === 2 && !JSON.stringify(afterSelectedGet).match(/\/tmp|node-ada|request-other/), 'a selection-filtered poll must merge rather than erase other safe discovery rows');
    assert(afterSelectedGet.diagnostics.selectedPolls === 1 && afterSelectedGet.diagnostics.selectedPollFailures === 0
      && afterSelectedGet.diagnostics.lastSelectedPollOk === true && afterSelectedGet.diagnostics.exclusionScope === 'selected',
    'selected MCP polling records refresh evidence without retaining a request or hub identity');
    assert(!source.selectHubKey('f'.repeat(64)), 'forged hub key must fail closed');
    assert(calls[0].allowNodeIds === null, 'discovery must not depend on a renderer-provided node id');
    windows.get(71).__canvasFilePath = '/tmp/after-save-as.canvas';
    assert(!source.unselectHubKey(key) && source.status().selectedHubs.length === 0, 'Save As must prune selection before any later key action');
  } },
  { name: 'handoff bridge: push: an explicit hub opt-out survives later discovery refreshes until checked again', run: async () => {
    const { source } = makeSource({ autoSelectHubs: true });
    await source.refreshHubs();
    const key = testHubKey('/tmp/ada.canvas', 'node-ada');
    assert(source.status().selectedHubs.includes(key), 'discovery selects a new eligible hub by default');
    assert(source.unselectHubKey(key), 'a selected hub can be explicitly unchecked');
    await source.refreshHubs();
    assert(!source.status().selectedHubs.includes(key), 'a later refresh must preserve the explicit opt-out');
    assert(source.selectHubKey(key), 'checking the hub again restores it');
    await source.refreshHubs();
    assert(source.status().selectedHubs.includes(key) && JSON.stringify(source.status().available) === JSON.stringify([CLAIM]),
      'a renewed selection gets the exact selected availability on refresh without an MCP get or another registry event');
  } },
  { name: 'handoff bridge: push: a stale selected poll cannot restore availability after a newer full registry refresh', run: async () => {
    const selectedList = deferred(); let selectedCalls = 0; let reads = 0; let fullCalls = 0;
    const source = createPushSource({
      seam: {
        list: async args => {
          if (args.allowNodeIds === null) return fullCalls++ === 0 ? { handoffs: [entry], excluded: {} } : { handoffs: [], excluded: {} };
          selectedCalls += 1;
          return selectedCalls === 1 ? selectedList.promise : { handoffs: [], excluded: {} };
        },
        read: async () => { reads += 1; return { ok: true }; },
        submit: async () => ({ outcome: 'accepted' }),
      },
      windows: new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }]]), hubKey: testHubKey,
    });
    assert(source.selectHub({ windowId: 71, canvasFilePath: '/tmp/ada.canvas', nodeId: 'node-ada' }), 'fixture selects the scoped hub');
    await source.refreshHubs();
    assert(JSON.stringify(source.status().available) === JSON.stringify([CLAIM]), 'the initial full registry snapshot establishes selected availability');
    const pending = source.get();
    await Promise.resolve();
    assert(selectedCalls === 1, 'the old selected poll is in flight');
    await source.refreshHubs();
    assert(source.status().available.length === 0, 'the newer full snapshot clears the settled/manual availability before the old poll returns');
    selectedList.resolve({ handoffs: [entry], excluded: {} });
    const result = await pending;
    assert(result.status === 'queue_empty' && reads === 0 && source.status().available.length === 0 && source.status().claimed.length === 0,
      'the stale selected result is discarded and cannot revive availability or claim a settled/manual handoff');
  } },
  { name: 'handoff bridge: push: an explicit unselect survives an empty discovery gap and returns a live claim to the dock', run: async () => {
    const windows = new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }]]);
    const rows = [entry]; let reads = 0;
    const source = createPushSource({
      seam: {
        list: async () => ({ handoffs: rows, excluded: {} }),
        read: async item => { reads += 1; return { ok: true, requestId: item.requestId, handoffCode: item.handoffCode, task: item.task, prompt: 'Synthetic prompt', attempt: 1 }; },
        submit: async () => ({ outcome: 'accepted' }),
      }, windows, hubKey: testHubKey, autoSelectHubs: true,
    });
    const key = testHubKey('/tmp/ada.canvas', 'node-ada');
    await source.refreshHubs();
    assert((await source.get({ epoch: 'empty-gap' })).status === 'served' && source.status('empty-gap').claimed.length === 1,
      'the initially discovered hub auto-selects and its exact request can be claimed');
    rows.splice(0, rows.length);
    await source.refreshHubs();
    assert(source.status('empty-gap').claimed.length === 0 && source.status().selectedHubs.includes(key),
      'the full empty inventory returns the claim to copy/paste while retaining a selectable hub record');
    assert(source.unselectHubKey(key) && source.status().optedOutHubs === 1,
      'unselecting that retained hub records the source-lifetime opt-out even though discovery is currently empty');
    rows.push(entry);
    await source.refreshHubs();
    const fallback = await source.get({ epoch: 'empty-gap' });
    assert(!source.status().selectedHubs.includes(key) && source.status().optedOutHubs === 1
      && source.status('empty-gap').claimed.length === 0 && fallback.status === 'needs_user' && reads === 1,
    'a reappearing handoff remains dock-owned; auto-select cannot restore the explicit unselect or read it for MCP');
  } },
  { name: 'handoff bridge: push: selected polling replaces observed counts without erasing cached peers', run: async () => {
    const windows = new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }], [72, { __canvasFilePath: '/tmp/other.canvas' }]]);
    const first = { ...entry, requestId: 'request-first' };
    const second = { ...entry, requestId: 'request-second', handoffCode: 'HANDOFF-BCDEFG' };
    const other = { ...entry, requestId: 'request-other', handoffCode: 'HANDOFF-CDEFGH', windowId: 72, nodeId: 'node-other' };
    let selectedRows = [first, second];
    const source = createPushSource({
      seam: {
        list: async args => ({ handoffs: args.allowNodeIds === null ? [...selectedRows, other] : selectedRows, excluded: {} }),
        read: async item => ({ ok: true, requestId: item.requestId, handoffCode: item.handoffCode, task: item.task, prompt: 'Synthetic prompt', attempt: 1 }),
        submit: async () => ({ outcome: 'accepted' }),
      }, windows, hubKey: testHubKey,
    });
    await source.refreshHubs();
    const firstKey = testHubKey('/tmp/ada.canvas', 'node-ada');
    const otherKey = testHubKey('/tmp/other.canvas', 'node-other');
    source.unselectHubKey(otherKey);
    assert(source.selectHubKey(firstKey), 'a refreshed opaque hub must be selectable');
    await source.get(); await source.get();
    let rows = new Map(source.status().discovered.map(item => [item.key, item]));
    assert(rows.get(firstKey).pending === 2 && rows.get(otherKey).pending === 1, 'repeated selected polls must not accumulate pending counts');
    selectedRows = [first];
    await source.get();
    rows = new Map(source.status().discovered.map(item => [item.key, item]));
    assert(rows.get(firstKey).pending === 1 && rows.get(otherKey).pending === 1, 'an observed hub must replace N with M while an unselected cached peer survives');
  } },
  { name: 'handoff bridge: push: policy covers every LLM task and every reviewed text task is release-one', run: () => { const known = getKnownTaskIds(); assert(Object.keys(PUSH_TASK_POLICY).length === known.size, 'policy must contain each known task'); assert(assertPushTaskPolicy(known), 'policy must verify exact known set'); for (const task of known) assert(Object.hasOwn(PUSH_TASK_POLICY, task), `missing ${task}`); const releaseOne = new Set(Object.entries(PUSH_TASK_POLICY).filter(([, row]) => row.mode === 'release_one').map(([task]) => task));
    // The whole job pipeline rides the bridge; what stays behind is what
    // structurally cannot cross, not what merely has not been reviewed.
    for (const task of [
      'job-scoring', 'job-query-generation', 'job-taxonomy-plan', 'job-role-screen',
      'job-preference-evaluation', 'job-compensation-assessment', 'resume-parse',
      'job-compensation-research', 'job-preference-research', 'career-profile-compile',
      'career-profile-audit-completeness', 'career-profile-audit-grounding',
      'career-profile-audit-attribution', 'career-profile-audit-metrics',
      'career-profile-audit-skills', 'career-profile-audit-conflicts', 'career-profile-repair',
    ]) {
      assert(releaseOne.has(task), `${task} has a reviewed text response contract, so it must ride the bridge`);
    }
    for (const task of BRIDGE_RAW_RESEARCH_TASKS) {
      assert(releaseOne.has(task), `${task} must match the seam's reviewed raw-research exception`);
    }
    // The photo task passed its live upload check. The two hub scans use
    // text-only llmText calls; document uploads retain manual delivery.
    for (const task of BRIDGE_ENABLED_ATTACHMENT_TASKS) assert(PUSH_TASK_POLICY[task].bridgeable && PUSH_TASK_POLICY[task].mode === 'release_one');
    for (const task of ['marketplace-hub-scan', 'marketplace-hub-scan-batch']) assert(releaseOne.has(task));
    for (const task of BRIDGE_ATTACHMENT_TASKS.filter(task => !BRIDGE_ENABLED_ATTACHMENT_TASKS.includes(task))) {
      assert(!PUSH_TASK_POLICY[task].bridgeable && PUSH_TASK_POLICY[task].mode === 'never');
    }
    // Career files are plain text read locally (2026-10-14), so no career
    // transcription task exists. Nothing is held back for want of review: if
    // a row is not release_one it must name a real reason, so a future task
    // cannot quietly inherit paste-only status.
    for (const task of ['career-file-extract', 'career-file-transcription-audit', 'career-file-inventory', 'career-file-inventory-audit', 'career-file-boundary-audit']) {
      assert(!Object.hasOwn(PUSH_TASK_POLICY, task), `${task} no longer exists`);
    }
    assert(Object.values(PUSH_TASK_POLICY).filter(row => row.mode === 'never').length
      === BRIDGE_ATTACHMENT_TASKS.filter(task => !BRIDGE_ENABLED_ATTACHMENT_TASKS.includes(task)).length,
    'the never list contains only attachment tasks still disabled');
    // Marketplace pricing rides the bridge now that scope.marketplace is the
    // consent boundary for listing data; engine.js fences it on that scope
    // specifically, never on scope.scoring.
    for (const task of ['price-synthesis', 'price-synthesis-batch', 'bundle-price-synthesis', 'platform-fit-assessment']) {
      assert(releaseOne.has(task), `${task} must ride the bridge under its own consent scope`);
    }
    assert(!Object.values(PUSH_TASK_POLICY).some(row => row.mode === 'paste_only'),
      'nothing is held back for want of review; only work that cannot cross a text tool stays off'); } },
  { name: 'handoff bridge: push: the renderer task vocabulary covers every bridgeable task', run: () => {
    // controller.js may not import sources/push.js (it is not a permitted
    // sibling), so its closed TASK_IDS vocabulary is spelled out by hand. That
    // is exactly the kind of list that silently rots: a task the bridge serves
    // but the vocabulary omits projects to null, and the UI says "this handoff"
    // instead of naming the work. Fail here instead.
    const controller = fs.readFileSync(new URL('../../electron/ipc/handoffBridge/controller.js', import.meta.url), 'utf8');
    const block = controller.slice(controller.indexOf('const TASK_IDS = new Set(['), controller.indexOf(']);', controller.indexOf('const TASK_IDS = new Set([')));
    const declared = new Set([...block.matchAll(/'([a-z0-9-]+)'/g)].map(match => match[1]));
    const bridgeable = Object.entries(PUSH_TASK_POLICY).filter(([, row]) => row.mode === 'release_one').map(([task]) => task);
    for (const task of bridgeable) assert(declared.has(task), `controller TASK_IDS omits bridgeable task ${task}, so its name cannot reach the renderer`);
    for (const task of declared) assert(PUSH_TASK_POLICY[task]?.mode === 'release_one' || BRIDGE_ATTACHMENT_TASKS.includes(task), `controller TASK_IDS names ${task}, which the bridge never serves`);
  } },
  { name: 'handoff bridge: push: engine and report telemetry vocabularies exactly cover the isolated release-one policy', run: () => {
    // These modules deliberately do not import sources/push.js: engine accepts
    // a generic push-shaped port and telemetry must remain a standalone
    // privacy reducer. Their duplicated closed sets are therefore a drift risk
    // that this regression makes explicit.
    const releaseOne = new Set([
      ...Object.entries(PUSH_TASK_POLICY).filter(([, row]) => row.mode === 'release_one').map(([task]) => task),
      ...BRIDGE_ATTACHMENT_TASKS,
    ]);
    const vocabulary = (relativePath, declaration) => {
      const source = fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
      assert(!/from\s+['"][^'"]*sources\/push\.js/.test(source), `${relativePath} must stay isolated from the concrete push source`);
      const start = source.indexOf(`const ${declaration} = new Set([`);
      const end = source.indexOf(']);', start);
      assert(start >= 0 && end > start, `${relativePath} must declare ${declaration} as a closed vocabulary`);
      return new Set([...source.slice(start, end).matchAll(/'([a-z0-9-]+)'/g)].map(match => match[1]));
    };
    for (const [target, declaration] of [
      ['../../electron/ipc/handoffBridge/engine.js', 'STATUS_PUSH_TASKS'],
      ['../../electron/ipc/handoffBridge/telemetry.js', 'QUEUE_PUSH_TASKS'],
    ]) {
      const declared = vocabulary(target, declaration);
      assert(declared.size === releaseOne.size, `${declaration} has ${declared.size} rows but release_one has ${releaseOne.size}`);
      for (const task of releaseOne) assert(declared.has(task), `${declaration} omits release_one task ${task}`);
      for (const task of declared) assert(releaseOne.has(task), `${declaration} exposes non-release_one task ${task}`);
    }
  } },
  { name: 'handoff bridge: push: normalizes ASCII and curly wrapped valid codes only', run: () => { assert(normalizePushHandoffCode(' `handoff-abcdef` ') === CODE && normalizePushHandoffCode('\u201c`handoff-abcdef`\u201d') === CODE, 'ASCII and curly wrappers canonicalize'); assert(normalizePushHandoffCode('wrong') === 'wrong', 'invalid code stays exact'); } },
  { name: 'handoff bridge: push: digest routing accepts lower-case curly wrappers but rejects a same-prefix code', run: async () => { const lower = makeSource().source; await lower.get(); assert((await lower.submit({ handoffCode: '\u201c`handoff-abcdef`\u201d', response: '{"handoffCode":"HANDOFF-ABCDEF"}' })).status === 'accepted', 'push code canonicalization remains case-insensitive with curly wrappers'); const prefix = makeSource().source; await prefix.get(); assert((await prefix.submit({ handoffCode: 'HANDOFF-ABCDEG', response: '{"handoffCode":"HANDOFF-ABCDEG"}' })).status === 'unknown_handoff', 'a matching prefix cannot select a served route'); } },
  { name: 'handoff bridge: push: policy is deeply frozen and drift refuses an unknown task', run: () => { assert(Object.isFrozen(PUSH_TASK_POLICY) && Object.isFrozen(PUSH_TASK_POLICY['job-scoring']), 'policy must not be mutable at runtime'); let rejected = false; try { assertPushTaskPolicy(new Set([...getKnownTaskIds(), 'future-task'])); } catch { rejected = true; } assert(rejected, 'new LLM work must default deny'); } },
  { name: 'handoff bridge: push: seam list receives only the release-one task and selected node', run: async () => { let args; const { source } = makeSource({ read: async item => ({ ok: true, requestId: item.requestId, handoffCode: item.handoffCode, task: item.task, prompt: 'Synthetic prompt', attempt: 1 }) }); const original = source.get; assert(typeof original === 'function', 'source get surface exists'); const captured = createPushSource({ seam: { list: async value => { args = value; return { handoffs: [entry], excluded: {} }; }, read: async item => ({ ok: true, requestId: item.requestId, handoffCode: item.handoffCode, task: item.task, prompt: 'Synthetic prompt', attempt: 1 }), submit: async () => ({ outcome: 'accepted' }) }, windows: new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }]]), hubKey: testHubKey }); captured.selectHub({ windowId: 71, canvasFilePath: '/tmp/ada.canvas', nodeId: 'node-ada' }); await captured.get(); assert(args.allowTasks.has('job-scoring') && args.allowNodeIds.has('node-ada'), 'coarse seam gate is defence in depth');
    // The allow-list is the release_one set exactly, including only attachment
    // tasks whose live transport gate is enabled.
    for (const task of BRIDGE_ATTACHMENT_TASKS) {
      assert(args.allowTasks.has(task) === BRIDGE_ENABLED_ATTACHMENT_TASKS.includes(task),
        `${task} allow-list membership must match the live transport gate`);
    }
    assert([...args.allowTasks].every(task => PUSH_TASK_POLICY[task]?.mode === 'release_one'), 'the seam allow-list must be exactly the release-one rows'); } },
  { name: 'handoff bridge: push: exact selected window-path-node triple gates serving', run: async () => { const { source } = makeSource(); assert((await source.get()).status === 'served', 'exact hub should serve'); source.clearHubs(); assert((await source.get()).status === 'needs_user', 'no hub must fail closed'); } },
  { name: 'handoff bridge: push: forged selection path is refused before it reaches the seam', run: () => { const { source } = makeSource(); assert(!source.selectHub({ windowId: 71, canvasFilePath: '/tmp/forged.canvas', nodeId: 'node-ada' }), 'renderer path cannot select a hub'); } },
  { name: 'handoff bridge: push: same node id in another window is never served', run: async () => { const other = { ...entry, requestId: 'request-other', windowId: 72 }; const { source } = makeSource({ entries: [other] }); assert((await source.get()).status === 'needs_user', 'window identity must participate'); } },
  { name: 'handoff bridge: push: same-node windows receive exact selection consent through list read and submit', run: async () => {
    const other = { ...entry, requestId: 'request-other-window', windowId: 72, handoffCode: 'HANDOFF-BCDEFG', bridgeClaimId: '33333333-3333-4333-8333-333333333333' };
    const calls = { list: [], read: [], submit: [] };
    const source = createPushSource({
      seam: {
        list: async args => { calls.list.push(args); return { handoffs: [other, entry], excluded: {} }; },
        read: async args => { calls.read.push(args); return { ok: true, requestId: args.requestId, handoffCode: args.handoffCode, task: 'job-scoring', prompt: 'Synthetic prompt', attempt: 1 }; },
        submit: async args => { calls.submit.push(args); return { outcome: 'accepted' }; },
      }, windows: new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }], [72, { __canvasFilePath: '/tmp/other.canvas' }]]), hubKey: testHubKey,
    });
    source.selectHub({ windowId: 71, canvasFilePath: '/tmp/ada.canvas', nodeId: 'node-ada' });
    assert((await source.get({ epoch: 'window-collision' })).handoffCode === CODE, 'only the selected window can serve its same-node handoff');
    const firstPair = `${71}\u0000node-ada`;
    assert(calls.list[0].allowWindowNodePairs.size === 1 && calls.list[0].allowWindowNodePairs.has(firstPair)
      && calls.read[0].allowWindowNodePairs.has(firstPair), 'list and read carry only the selected exact window/node authorization');
    const raced = source.submit({ epoch: 'window-collision', handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF"}' });
    source.clearHubs();
    assert((await raced).status === 'held' && calls.submit.length === 0, 'deselection between submit scheduling and seam entry cannot borrow the old hub consent');
    source.selectHub({ windowId: 72, canvasFilePath: '/tmp/other.canvas', nodeId: 'node-ada' });
    assert((await source.submit({ epoch: 'window-collision', handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF"}' })).status === 'unknown_handoff', 'reselecting a same-id node in another window cannot revive the old route');
    assert((await source.get({ epoch: 'window-collision' })).handoffCode === other.handoffCode, 'the newly selected window receives only its own request');
    assert((await source.submit({ epoch: 'window-collision', handoffCode: other.handoffCode, response: '{"handoffCode":"HANDOFF-BCDEFG"}' })).status === 'accepted'
      && calls.submit.length === 1 && calls.submit[0].allowWindowNodePairs.has(`${72}\u0000node-ada`), 'submit rechecks and atomically forwards only the replacement window consent');
  } },
  { name: 'handoff bridge: push: Save As drops a selected hub', run: async () => { const { source, windows } = makeSource(); windows.get(71).__canvasFilePath = '/tmp/changed.canvas'; assert((await source.get()).status === 'needs_user', 'path change must deselect'); assert(source.selectedHubs().size === 0, 'stale hub must be removed'); } },
  { name: 'handoff bridge: push: clearing a destroyed window leaves another selected hub alone', run: () => { const { source, windows } = makeSource(); windows.set(72, { __canvasFilePath: '/tmp/other.canvas' }); assert(source.selectHub({ windowId: 72, canvasFilePath: '/tmp/other.canvas', nodeId: 'node-other' }), 'other hub selected'); source.clearHubs({ windowId: 71 }); assert(!source.selectedHubs().has('node-ada') && source.selectedHubs().has('node-other'), 'cleanup must be window-scoped'); } },
  { name: 'handoff bridge: push: submit uses served request id and tombstones acceptance', run: async () => { const { source } = makeSource(); await source.get(); assert((await source.submit({ handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF"}' })).status === 'accepted', 'served code commits'); assert((await source.submit({ handoffCode: CODE, response: '{}' })).status === 'duplicate', 'accepted code is tombstoned'); } },
  { name: 'handoff bridge: push: unknown code and a stale seam record are fixed outcomes', run: async () => { const { source } = makeSource({ submit: async () => ({ outcome: 'not_pending' }) }); assert((await source.submit({ handoffCode: CODE, response: '{}' })).status === 'unknown_handoff', 'unserved code cannot route live state'); await source.get(); assert((await source.submit({ handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF"}' })).status === 'superseded', 'cancelled seam record must not be retried'); } },
  { name: 'handoff bridge: push: deselection releases a claim without seam access', run: async () => { let calls = 0; const { source } = makeSource({ submit: async () => { calls += 1; return { outcome: 'accepted' }; } }); await source.get(); source.clearHubs(); const value = await source.submit({ handoffCode: CODE, response: '{}' }); assert(value.status === 'unknown_handoff' && calls === 0 && source.status().claimed.length === 0, 'deselection must return this request to the dock before a submit can reach the seam'); } },
  { name: 'handoff bridge: push: prechecks reject junk, stamps and oversized values without seam', run: async () => { let calls = 0; const { source } = makeSource({ submit: async () => { calls += 1; return { outcome: 'accepted' }; } }); await source.get(); assert((await source.submit({ handoffCode: CODE, response: '{}' })).status === 'junk', 'empty object is junk'); assert((await source.submit({ handoffCode: CODE, response: 'HANDOFF-BCDEFG' })).status === 'misrouted', 'other stamp is misrouted'); assert((await source.submit({ handoffCode: CODE, response: 'x'.repeat(1_000_001) })).status === 'too_large', 'size is bytes capped'); assert(calls === 0, 'prechecks must not use seam'); } },
  { name: 'handoff bridge: push: legacy non-enforced empty object reaches the seam', run: async () => { let received; const legacy = { ...entry, codeEnforced: false }; const { source } = makeSource({ entries: [legacy], submit: async args => { received = args.response; return { outcome: 'accepted' }; } }); await source.get(); assert((await source.submit({ handoffCode: CODE, response: {} })).status === 'accepted' && received === '{}', 'legacy mode permits JSON object response'); } },
  { name: 'handoff bridge: push: busy maps to a safe retry and status exposes no identifiers', run: async () => { const { source } = makeSource({ submit: async () => ({ outcome: 'busy' }) }); await source.get(); assert((await source.submit({ handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF"}' })).status === 'retry', 'busy must not hold or accept'); const snapshot = JSON.stringify(source.status()); assert(!snapshot.includes('request-ada') && !snapshot.includes('/tmp'), 'source status is metadata-only'); } },
  { name: 'handoff bridge: push: identical retries share and replay a verdict', run: async () => { let calls = 0; let resolve; const pending = new Promise(done => { resolve = done; }); const { source } = makeSource({ submit: async () => { calls += 1; return pending; } }); await source.get(); const a = source.submit({ handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF"}' }); const b = source.submit({ handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF"}' }); resolve({ outcome: 'rejected', correction: 'Fix synthetic score.', attempt: 2, validationCode: 'schema' }); const [left, right] = await Promise.all([a, b]); assert(calls === 1 && left.status === 'rejected' && right.status === 'rejected', 'one seam call per response'); } },
  { name: 'handoff bridge: push: quality rejections remain retryable until acceptance', run: async () => { let attempts = 0; const { source } = makeSource({ submit: async () => (++attempts <= 4 ? { outcome: 'rejected', correction: 'Fix synthetic score.', attempt: attempts } : { outcome: 'accepted' }) }); await source.get(); for (let index = 0; index < 4; index += 1) { const rejection = await source.submit({ handoffCode: CODE, response: `{"handoffCode":"${CODE}","n":${index}}` }); assert(rejection.status === 'rejected' && rejection.attempt === index + 1, 'quality feedback remains retryable beyond the former cap'); } assert((await source.submit({ handoffCode: CODE, response: `{"handoffCode":"${CODE}","n":4}` })).status === 'accepted', 'a later corrected response must be accepted'); } },
  { name: 'handoff bridge: push: commit failure needs attention after the second attempt', run: async () => { const { source } = makeSource({ submit: async () => ({ outcome: 'commit_failed', error: '/private/path' }) }); await source.get(); assert((await source.submit({ handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF","x":1}' })).status === 'retry', 'first failure retries'); assert((await source.submit({ handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF","x":2}' })).status === 'needs_user' && source.status().claimed.length === 0, 'second failure holds and returns copy/paste ownership to the dock'); } },
  { name: 'handoff bridge: push: a repeated-cause rejection returns the handoff to the person and the engine keeps that reason', run: async () => { const { source } = makeSource({ submit: async () => ({ outcome: 'rejection_cap', validationCode: 'CAREER_SNAPSHOT_PAGE_INVALID', validationDiagnostic: '/private/diagnostic' }) }); await source.get(); const capped = await source.submit({ handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF","n":5}' }); assert(capped.status === 'needs_user' && capped.reason === 'rejection_cap' && source.status().claimed.length === 0 && source.status().held === 0 && !JSON.stringify(capped).includes('/private/diagnostic'), 'the chat is told it needs the person, the dock claim is released, and the registry exclusion (not a second hold) counts it'); const { engine, session } = await makeEngine({ pushGet: async () => ({ status: 'served', handoffCode: CODE, task: 'career-profile-repair', prompt: 'repair', remaining: { ready: 0, working: 0, needsYou: 0 } }), pushSubmit: async () => ({ status: 'needs_user', reason: 'rejection_cap' }) }); await engine.get({ session, linkId: LINK }); const framed = await engine.submit({ session, linkId: LINK, handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF"}' }); assert(framed.status === 'needs_user' && framed.reason === 'rejection_cap', 'engine framing keeps the rejection_cap reason'); } },
  { name: 'handoff bridge: push: person editing remains held', run: async () => { const { source } = makeSource({ submit: async () => ({ outcome: 'ineligible', exclusion: 'person_editing' }) }); await source.get(); const value = await source.submit({ handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF"}' }); assert(value.status === 'held' && value.reason === 'person_editing' && source.status().claimed.length === 0, 'draft lease must win and restore this request’s paste controls'); } },
  { name: 'handoff bridge: push: disabled seam task remains held with a fixed policy reason', run: async () => { const { source } = makeSource({ submit: async () => ({ outcome: 'ineligible', exclusion: 'task_not_allowed' }) }); await source.get(); const value = await source.submit({ handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF"}' }); assert(value.status === 'held' && value.reason === 'task_disabled', 'policy change must stop the served handoff'); } },
  { name: 'handoff bridge: push: a list fault leaves a later get usable', run: async () => { let lists = 0; const { source } = makeSource(); const original = source.get; assert(typeof original === 'function', 'adapter should expose get'); const faulty = createPushSource({ seam: { list: async () => { lists += 1; if (lists === 1) throw new Error('private'); return { handoffs: [entry], excluded: {} }; }, read: async item => ({ ok: true, requestId: item.requestId, handoffCode: item.handoffCode, task: item.task, prompt: 'Synthetic prompt', attempt: 1 }), submit: async () => ({ outcome: 'accepted' }) }, windows: new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }]]), hubKey: testHubKey }); assert(faulty.selectHub({ windowId: 71, canvasFilePath: '/tmp/ada.canvas', nodeId: 'node-ada' }), 'hub selected'); assert((await faulty.get()).status === 'retry' && (await faulty.get()).status === 'served', 'list failure must not poison state'); } },
  { name: 'handoff bridge: push: a submit fault leaves a later unique retry usable', run: async () => { let calls = 0; const { source } = makeSource({ submit: async () => { calls += 1; if (calls === 1) throw new Error('private'); return { outcome: 'accepted' }; } }); await source.get(); assert((await source.submit({ handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF","n":1}' })).status === 'retry', 'throw becomes fixed retry'); assert((await source.submit({ handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF","n":2}' })).status === 'accepted' && calls === 2, 'later response must settle normally'); } },
  { name: 'handoff bridge: push: every owner correction re-get is self-contained and another worker cannot steal it', run: async () => { let submissions = 0; const { source } = makeSource({ read: async item => ({ ok: true, requestId: item.requestId, handoffCode: item.handoffCode, task: item.task, prompt: 'Original materialized prompt\n--- CORRECTION REQUIRED ---\nFix field.', isCorrection: true, correction: 'Fix field.', attempt: 2 }), submit: async () => (++submissions === 1 ? { outcome: 'rejected', correction: 'Fix field.', attempt: 2 } : { outcome: 'accepted' }) }); const first = await source.get({ epoch: 'retry-pool', worker: 'worker-1' }); assert(first.status === 'served' && first.prompt.includes('Original materialized prompt') && first.prompt.includes('CORRECTION REQUIRED') && first.correction === '' && first.note, 'first correction delivery must include the full retry prompt'); const rejected = await source.submit({ epoch: 'retry-pool', worker: 'worker-1', handoffCode: CODE, response: `{"handoffCode":"${CODE}","attempt":1}` }); assert(rejected.status === 'rejected', 'the initial invalid answer must remain retryable'); const again = await source.get({ epoch: 'retry-pool', worker: 'worker-1' }); assert(again.status === 'served' && again.prompt.includes('Original materialized prompt') && again.prompt.includes('CORRECTION REQUIRED') && again.correction === '' && !again.correctionOnly, 'same-owner retry must never lose the original prompt or correction context'); const stolen = await source.get({ epoch: 'retry-pool', worker: 'worker-2' }); assert(stolen.status !== 'served', 'a different worker cannot steal the rejected owner\'s handoff'); const accepted = await source.submit({ epoch: 'retry-pool', worker: 'worker-1', handoffCode: CODE, response: `{"handoffCode":"${CODE}","attempt":2}` }); assert(accepted.status === 'accepted' && submissions === 2, 'the owner can submit its corrected complete answer'); } },
  { name: 'handoff bridge: push engine: rejected re-get keeps the complete prompt, charges it once, and accepts the correction', run: async () => { let submissions = 0; const { source } = makeSource({ read: async item => ({ ok: true, requestId: item.requestId, handoffCode: item.handoffCode, task: item.task, responseFormat: 'json', prompt: 'Original engine prompt\n--- CORRECTION REQUIRED ---\nReturn every row.', isCorrection: true, correction: 'Return every row.', attempt: 2 }), submit: async () => (++submissions === 1 ? { outcome: 'rejected', correction: 'Return every row.', attempt: 2 } : { outcome: 'accepted' }) }); const { engine, session } = await makeEngine({ pushSource: source }); const first = await engine.get({ session, linkId: LINK }); const rejected = await engine.submit({ session, linkId: LINK, handoffCode: CODE, response: `{"handoffCode":"${CODE}","attempt":1}` }); const retried = await engine.get({ session, linkId: LINK }); assert(first.status === 'served' && rejected.status === 'rejected' && retried.status === 'served' && retried.prompt.includes('Original engine prompt') && retried.prompt.includes('CORRECTION REQUIRED'), 'engine must reframe a rejected handoff with complete recovery context'); assert(engine.snapshot().chat.bytesServed === 42, 'self-contained re-get must not charge the same prompt twice'); const accepted = await engine.submit({ session, linkId: LINK, handoffCode: CODE, response: `{"handoffCode":"${CODE}","attempt":2}` }); assert(accepted.status === 'accepted' && submissions === 2, 'corrected retry must settle through the same worker'); } },
  { name: 'handoff bridge: push: a reissued request may reuse a code after an old tombstone', run: async () => { const records = [entry]; const { source } = makeSource({ entries: records, submit: async () => ({ outcome: 'accepted' }) }); await source.get(); await source.submit({ handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF"}' }); records.splice(0, 1, { ...entry, requestId: 'request-reissued' }); assert((await source.get()).status === 'served', 'new record can be served'); assert((await source.submit({ handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF","v":2}' })).status === 'accepted', 'old tombstone cannot block a new request id'); } },
  { name: 'handoff bridge: push: epoch close forgets all served routing state', run: async () => { const { source } = makeSource(); await source.get({ epoch: 'chat-one' }); source.closeEpoch('chat-one'); assert(source.status('chat-one').claimed.length === 0 && (await source.submit({ epoch: 'chat-one', handoffCode: CODE, response: '{}' })).status === 'unknown_handoff', 'chat rotation ends both the old route and its dock-suppressing claim'); } },
  { name: 'handoff bridge: push: read failures retry at most three and retain no item', run: async () => { let reads = 0; const { source } = makeSource({ read: async () => { reads += 1; throw new Error('private'); } }); assert((await source.get()).status === 'waiting' && reads === 3, 'read retries must be bounded'); assert(source.status().served === 0, 'failed read must not retain serving state'); } },
  { name: 'handoff bridge: push: ending-only exclusions do not create a false needs-user card', run: async () => { const { source } = makeSource({ entries: [], read: null }); const empty = createPushSource({ seam: { list: async () => ({ handoffs: [], excluded: { ending: 2 } }), read: async () => ({ ok: false }), submit: async () => ({ outcome: 'not_pending' }) }, windows: new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }]]), hubKey: testHubKey }); empty.selectHub({ windowId: 71, canvasFilePath: '/tmp/ada.canvas', nodeId: 'node-ada' }); assert((await empty.get()).status === 'queue_empty', 'ending work is not actionable'); assert(source.status().selectedHubs.length === 1, 'unrelated adapter state remains local'); } },
  { name: 'handoff bridge: push engine: uses push before a fresh application lane and frames exact push fields', run: async () => { const { engine, session } = await makeEngine({ pushGet: async () => ({ status: 'served', handoffCode: CODE, task: 'job-scoring', batch: 2, batchTotal: 3, attempt: 1, prompt: 'Synthetic scoring prompt.', remaining: { ready: 0, working: 0, needsYou: 0 } }) }); const body = await engine.get({ session, linkId: LINK }); assert(body.status === 'served' && body.kind === 'push' && body.task === 'job-scoring' && body.batch === 2 && body.batchTotal === 3 && body.responseFormat === 'json' && body.instructions.includes('responseFormat json'), 'push must win at a job boundary with the fixed JSON framing'); assert(!Object.keys(body).some(key => /request|window|node|run|path/i.test(key)), 'push frame must not expose seam identifiers'); } },
  { name: 'handoff bridge: push engine: raw research result framing authoritatively overrides the frozen generic JSON metadata', run: async () => { const { engine, session } = await makeEngine({ pushGet: async () => ({ status: 'served', handoffCode: CODE, task: 'job-compensation-research', responseFormat: 'text', attempt: 1, prompt: `=== ${CODE} ===`, remaining: { ready: 0, working: 0, needsYou: 0 } }) }); const body = await engine.get({ session, linkId: LINK }); const submit = TOOLS_LIST.find(tool => tool.name === 'submit_handoff'); assert(submit?.inputSchema?.properties?.response?.description?.includes('one JSON object'), 'the compatibility test must exercise the intentionally frozen generic metadata'); assert(body.status === 'served' && body.responseFormat === 'text' && body.instructions.includes('override the submit_handoff tool description') && body.instructions.includes('Handoff: immediately followed by a space and the exact handoffCode') && body.instructions.includes('do not add a handoffCode JSON property') && !body.instructions.includes('Handoff: CODE'), 'the served result must unambiguously override generic metadata and describe the exact text header without inviting a literal placeholder'); } },
  { name: 'handoff bridge: push engine: an outstanding application continuation wins over push', run: async () => { let pushReady = false; const { engine, session } = await makeEngine({ pushGet: async () => pushReady ? ({ status: 'served', handoffCode: CODE, task: 'job-scoring', batch: null, batchTotal: null, attempt: 1, prompt: 'score', remaining: { ready: 0, working: 0, needsYou: 0 } }) : ({ status: 'queue_empty', remaining: { ready: 0, working: 0, needsYou: 0 } }) }); const first = await engine.get({ session, linkId: LINK }); pushReady = true; const again = await engine.get({ session, linkId: LINK }); assert(first.kind === 'application' && again.kind === 'application' && again.handoffCode === first.handoffCode, 'an already-served application must never be preempted by push'); } },
  { name: 'handoff bridge: push engine: routes push tombstones before application unknown-code handling', run: async () => { let accepted = false; const { engine, session } = await makeEngine({ pushGet: async () => ({ status: 'served', handoffCode: CODE, task: 'job-scoring', batch: null, batchTotal: null, attempt: 1, prompt: 'score', remaining: { ready: 0, working: 0, needsYou: 0 } }), pushSubmit: async () => accepted ? ({ status: 'duplicate' }) : (accepted = true, { status: 'accepted' }) }); await engine.get({ session, linkId: LINK }); const first = await engine.submit({ session, linkId: LINK, handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF"}' }); const second = await engine.submit({ session, linkId: LINK, handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF","retry":2}' }); assert(first.status === 'accepted' && second.status === 'duplicate', 'a push tombstone must win before application unknown-code routing'); } },
  { name: 'handoff bridge: push engine: a timed-out push submit stays single-flight and unattached identifiers never leak', run: async () => { let calls = 0; let settle; const pending = new Promise(resolve => { settle = resolve; }); const { engine, session } = await makeEngine({ submitBudgetMs: 0, pushGet: async () => ({ status: 'served', handoffCode: CODE, task: 'job-scoring', batch: null, batchTotal: null, attempt: 1, prompt: 'score sentinel /private/push', remaining: { ready: 0, working: 0, needsYou: 0 } }), pushSubmit: async () => { calls += 1; return pending; } }); const served = await engine.get({ session, linkId: LINK }); const one = await engine.submit({ session, linkId: LINK, handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF"}' }); const two = await engine.submit({ session, linkId: LINK, handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF"}' }); settle({ status: 'accepted' }); assert(one.status === 'retry' && two.status === 'retry' && calls === 1 && !JSON.stringify(engine.snapshot()).includes('/private/push') && !JSON.stringify(served).includes('request-ada'), 'deadline answers retry without aborting or duplicating the push call'); } },
  { name: 'handoff bridge: push: grace and active node observations both prevent a false empty result', run: async () => { let tick = 1_000; let active = false; let records = [entry]; const source = createPushSource({ seam: { list: async () => ({ handoffs: records, excluded: {} }), read: async item => ({ ok: true, requestId: item.requestId, handoffCode: item.handoffCode, task: item.task, prompt: 'Synthetic prompt', attempt: 1 }), submit: async () => ({ outcome: 'accepted' }) }, windows: new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }]]), hubKey: testHubKey, now: () => tick, activeNodeTasks: () => active ? [{ nodeId: 'node-ada', taskDetails: [{ manualAiRunId: 'run-ada' }] }] : [], timers: { setTimeout(fn) { fn(); return { unref() {} }; } } }); source.selectHub({ windowId: 71, canvasFilePath: '/tmp/ada.canvas', nodeId: 'node-ada' }); await source.get(); await source.submit({ handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF"}' }); records = []; assert((await source.get()).status === 'waiting', 'last accept inside grace must wait'); tick += 16_000; active = true; assert((await source.get()).status === 'waiting', 'an active matching node/run must wait even after grace expires'); } },
  { name: 'handoff bridge: push: correction and rejection results omit seam diagnostics and map cancellation safely', run: async () => { const { source } = makeSource({ read: async item => ({ ok: true, requestId: item.requestId, handoffCode: item.handoffCode, task: item.task, prompt: 'Prompt', isCorrection: true, correction: 'Fix it.', attempt: 2, validationDiagnostic: '/private/diagnostic' }), submit: async () => ({ outcome: 'cancelled_during_save', validationDiagnostic: '/private/diagnostic' }) }); const served = await source.get(); const submit = await source.submit({ handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF"}' }); const wire = JSON.stringify({ served, submit }); assert(served.status === 'served' && !wire.includes('request-ada') && !wire.includes('/private/diagnostic') && submit.status === 'superseded', 'read and cancelled-save outputs must remain identifier- and diagnostic-free'); } },
  { name: 'handoff bridge: push: settled verdicts replay without a second seam submit', run: async () => { let calls = 0; const { source } = makeSource({ submit: async () => { calls += 1; return { outcome: 'rejected', correction: 'Fix synthetic score.', attempt: 2, validationCode: 'schema' }; } }); await source.get(); const args = { handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF","retry":1}' }; const first = await source.submit(args); const replay = await source.submit(args); assert(first.status === 'rejected' && replay.status === 'rejected' && calls === 1, 'a settled identical verdict must be replayed'); } },
  { name: 'handoff bridge: push: status prunes a Save As selection before it is rendered', run: () => { const { source, windows } = makeSource(); windows.get(71).__canvasFilePath = '/tmp/after-save-as.canvas'; assert(source.status().selectedHubs.length === 0, 'status must not advertise a stale path selection'); } },
  { name: 'handoff bridge: push: another window with the same node cannot submit through this hub', run: async () => { let calls = 0; const other = { ...entry, requestId: 'request-other-window', handoffCode: 'HANDOFF-BCDEFG', windowId: 72 }; const { source } = makeSource({ entries: [entry, other], submit: async () => { calls += 1; return { outcome: 'accepted' }; } }); await source.get(); const forged = await source.submit({ handoffCode: other.handoffCode, response: '{"handoffCode":"HANDOFF-BCDEFG"}' }); assert(forged.status === 'unknown_handoff' && calls === 0, 'a sibling window record is never routable by the selected hub'); } },
  { name: 'handoff bridge: push: accepted scoring waits through successor grace before serving next', run: async () => { let tick = 0; let accepted = false; let successor = false; const next = { ...entry, requestId: 'request-successor', handoffCode: 'HANDOFF-BCDEFG' }; const source = createPushSource({ seam: { list: async () => ({ handoffs: successor ? [next] : accepted ? [] : [entry], excluded: {} }), read: async item => ({ ok: true, requestId: item.requestId, handoffCode: item.handoffCode, task: item.task, prompt: 'Synthetic prompt', attempt: 1 }), submit: async () => { accepted = true; return { outcome: 'accepted' }; } }, windows: new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }]]), hubKey: testHubKey, now: () => tick, timers: { setTimeout(fn, delay) { tick += delay; if (tick >= 15_000) successor = true; fn(); return { unref() {} }; } } }); source.selectHub({ windowId: 71, canvasFilePath: '/tmp/ada.canvas', nodeId: 'node-ada' }); await source.get(); await source.submit({ handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF"}' }); const nextResult = await source.nextAfterAccept({ budgetMs: 25_000 }); assert(nextResult.status === 'served' && nextResult.handoffCode === 'HANDOFF-BCDEFG' && tick >= 15_000, 'next scoring work waits for the grace interval rather than falsely draining'); } },
  { name: 'handoff bridge: push engine: preserves hub deselection and commit-failure reasons', run: async () => { const { engine, session } = await makeEngine({ pushGet: async () => ({ status: 'served', handoffCode: CODE, task: 'job-scoring', prompt: 'score', remaining: { ready: 0, working: 0, needsYou: 0 } }), pushSubmit: async () => ({ status: 'held', reason: 'hub_not_selected' }) }); await engine.get({ session, linkId: LINK }); const held = await engine.submit({ session, linkId: LINK, handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF"}' }); assert(held.status === 'held' && held.reason === 'hub_not_selected', 'deselection must not be disguised as task policy'); const retry = await makeEngine({ pushGet: async () => ({ status: 'served', handoffCode: CODE, task: 'job-scoring', prompt: 'score', remaining: { ready: 0, working: 0, needsYou: 0 } }), pushSubmit: async () => ({ status: 'needs_user', reason: 'commit_failed' }) }); await retry.engine.get({ session: retry.session, linkId: LINK }); const failed = await retry.engine.submit({ session: retry.session, linkId: LINK, handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF"}' }); assert(failed.status === 'needs_user' && failed.reason === 'commit_failed', 'safe commit failure reason must survive engine framing'); } },
  { name: 'handoff bridge: push engine: charges a re-served prompt only once and returns a grace successor', run: async () => { let gets = 0; const push = { get: async () => ({ status: 'served', handoffCode: gets++ ? 'HANDOFF-BCDEFG' : CODE, task: 'job-scoring', prompt: 'score', promptBytes: gets === 1 ? 321 : 0, remaining: { ready: 0, working: 0, needsYou: 0 } }), submit: async () => ({ status: 'accepted' }), nextAfterAccept: async () => ({ status: 'served', handoffCode: 'HANDOFF-CDEFGH', task: 'job-scoring', prompt: 'next score', promptBytes: 17, remaining: { ready: 0, working: 0, needsYou: 0 } }), status: () => ({}) }; const { engine, session } = await makeEngine({ pushSource: push }); const first = await engine.get({ session, linkId: LINK }); const second = await engine.get({ session, linkId: LINK }); assert(first.kind === 'push' && second.kind === 'push' && engine.snapshot().chat.bytesServed === 321, 'repeat get must not consume the prompt budget twice'); const accepted = await engine.submit({ session, linkId: LINK, handoffCode: second.handoffCode, response: '{"handoffCode":"HANDOFF-BCDEFG"}' }); assert(accepted.status === 'accepted' && accepted.next?.kind === 'push' && accepted.next.handoffCode === 'HANDOFF-CDEFGH', 'accepted push waits for and returns its successor'); } },
  { name: 'handoff bridge: push engine: a settled accepted replay is framed exactly once', run: async () => { let successors = 0; const push = { get: async () => ({ status: 'served', handoffCode: CODE, task: 'job-scoring', prompt: 'score', promptBytes: 1, remaining: { ready: 0, working: 0, needsYou: 0 } }), submit: async () => ({ status: 'accepted' }), nextAfterAccept: async () => { successors += 1; return { status: 'queue_empty', remaining: { ready: 0, working: 0, needsYou: 0 } }; }, status: () => ({}) }; const { engine, session } = await makeEngine({ pushSource: push }); await engine.get({ session, linkId: LINK }); const args = { session, linkId: LINK, handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF"}' }; const first = await engine.submit(args); const replay = await engine.submit(args); assert(first.status === 'accepted' && replay.status === 'accepted' && successors === 1 && engine.snapshot().counts.submitAccepted === 1, 'cached accepted result must not run successor framing or counters twice'); } },
  { name: 'handoff bridge: push engine: submit deadline is twenty-five seconds and the call keeps running', run: async () => { const clock = createFakeClock(0); let calls = 0; let settle; const pending = new Promise(resolve => { settle = resolve; }); const { engine, session } = await makeEngine({ now: clock.now, timers: clock, submitBudgetMs: 25_000, pushGet: async () => ({ status: 'served', handoffCode: CODE, task: 'job-scoring', prompt: 'score', remaining: { ready: 0, working: 0, needsYou: 0 } }), pushSubmit: async () => { calls += 1; return pending; } }); await engine.get({ session, linkId: LINK }); const reply = engine.submit({ session, linkId: LINK, handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF"}' }); for (let step = 0; step < 4; step += 1) await Promise.resolve(); assert(calls === 1 && clock.pendingCount() === 1, 'one live seam call and one response deadline expected'); clock.advance(25_000); const timedOut = await reply; assert(timedOut.status === 'retry' && timedOut.inFlight === true && clock.now() === 25_000, 'response budget must expire at exactly 25 seconds'); settle({ status: 'accepted' }); for (let step = 0; step < 4; step += 1) await Promise.resolve(); assert(engine.debugState().submitActive === 0, 'late settlement releases the shared submit slot'); } },
  { name: 'handoff bridge: push: every seam await fault releases state for a following operation', run: async () => { await withLeakCheck(async () => { const makeBase = () => ({ list: async () => ({ handoffs: [entry], excluded: {} }), read: async item => ({ ok: true, requestId: item.requestId, handoffCode: item.handoffCode, task: item.task, prompt: 'Synthetic prompt', attempt: 1 }), submit: async () => ({ outcome: 'accepted' }) }); for (const [site, kth] of [['list', 1], ['read', 2]]) { const injected = faultAt(makeBase(), kth, { mode: 'reject' }); const source = createPushSource({ seam: injected.port, windows: new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }]]) }); source.selectHub({ windowId: 71, canvasFilePath: '/tmp/ada.canvas', nodeId: 'node-ada' }); const first = await source.get(); const following = await source.get(); assert((site === 'list' ? first.status === 'retry' : first.status === 'served') && following.status === 'served', `${site} fault must leave the adapter usable`); } const submitFault = faultAt(makeBase(), 3, { mode: 'throw' }); const submitSource = createPushSource({ seam: submitFault.port, windows: new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }]]) }); submitSource.selectHub({ windowId: 71, canvasFilePath: '/tmp/ada.canvas', nodeId: 'node-ada' }); await submitSource.get(); assert((await submitSource.submit({ handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF","n":1}' })).status === 'retry', 'seam submit throw must become retry'); assert((await submitSource.submit({ handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF","n":2}' })).status === 'accepted', 'post-fault submit must not remain single-flight locked'); let tick = 0; let records = [entry]; const activeSource = createPushSource({ seam: { list: async () => ({ handoffs: records, excluded: {} }), read: makeBase().read, submit: async () => ({ outcome: 'accepted' }) }, windows: new Map([[71, { __canvasFilePath: '/tmp/ada.canvas' }]]), now: () => tick, activeNodeTasks: () => { throw new Error('private'); }, timers: { setTimeout(fn) { fn(); return { unref() {} }; } } }); activeSource.selectHub({ windowId: 71, canvasFilePath: '/tmp/ada.canvas', nodeId: 'node-ada' }); await activeSource.get(); await activeSource.submit({ handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF"}' }); records = []; assert((await activeSource.get()).status === 'waiting', 'active-node observation throw falls back to the successor grace'); tick += 16_000; assert((await activeSource.get()).status === 'queue_empty', 'post-grace active-node failure must not retain a false wait'); let calls = 0; let resolve; const pending = new Promise(done => { resolve = done; }); const cacheSource = makeSource({ submit: async () => { calls += 1; return pending; } }).source; await cacheSource.get(); const args = { handoffCode: CODE, response: '{"handoffCode":"HANDOFF-ABCDEF","cache":1}' }; const left = cacheSource.submit(args); const right = cacheSource.submit(args); resolve({ outcome: 'accepted' }); assert((await left).status === 'accepted' && (await right).status === 'accepted' && calls === 1, 'cache single-flight must share a fault-prone seam await'); }); } },
];
