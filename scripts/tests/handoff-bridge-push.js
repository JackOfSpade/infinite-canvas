import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { assert } from './testHelpers.js';
import { createFakeClock } from './fixtures/handoff-bridge/fakeClock.js';
import { faultAt, withLeakCheck } from './fixtures/handoff-bridge/harness.js';
import { getKnownTaskIds } from '../../electron/ipc/llm.js';
import { PUSH_TASK_POLICY, assertPushTaskPolicy, createPushSource as createPushSourcePort, normalizePushHandoffCode } from '../../electron/ipc/handoffBridge/sources/push.js';
import { createHandoffEngine } from '../../electron/ipc/handoffBridge/engine.js';
import { createHandoffCodeGuard } from '../../electron/ipc/handoffBridge/lanes.js';
import { TOOLS_LIST } from '../../electron/ipc/handoffBridge/tools.js';
import { BRIDGE_RAW_RESEARCH_TASKS } from '../../electron/ipc/nonApiAi.js';

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

export default [
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
    const { source, windows } = makeSource();
    await source.get({ epoch: 'save-as-claim' });
    windows.get(71).__canvasFilePath = '/tmp/after-save-as.canvas';
    const status = source.status('save-as-claim');
    assert(status.claimed.length === 0 && status.served === 0,
      'Save As prunes the now-unservable hub and returns this exact handoff to normal paste controls');
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
    // Photos (callLLMVision) and the file->text step itself (callLLMDocument)
    // need attachment bytes that the MCP text surface cannot carry.
    for (const task of [
      'vision-product-analysis', 'marketplace-hub-scan', 'marketplace-hub-scan-batch',
      'career-file-inventory', 'career-file-inventory-audit', 'career-file-boundary-audit',
      'career-file-extract', 'career-file-transcription-audit',
    ]) {
      assert(!PUSH_TASK_POLICY[task].bridgeable && PUSH_TASK_POLICY[task].mode === 'never', `${task} cannot cross an MCP text tool`);
    }
    // Only photos and attachment-backed document checks remain. Nothing else is held back
    // for want of review -- if a row is not release_one it must name a real
    // reason, so a future task cannot quietly inherit paste-only status.
    assert(Object.values(PUSH_TASK_POLICY).filter(row => row.mode === 'never').length === 8,
      'the never list is exactly the work that cannot cross a text tool');
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
    for (const task of declared) assert(PUSH_TASK_POLICY[task]?.mode === 'release_one', `controller TASK_IDS names ${task}, which the bridge never serves`);
  } },
  { name: 'handoff bridge: push: engine and report telemetry vocabularies exactly cover the isolated release-one policy', run: () => {
    // These modules deliberately do not import sources/push.js: engine accepts
    // a generic push-shaped port and telemetry must remain a standalone
    // privacy reducer. Their duplicated closed sets are therefore a drift risk
    // that this regression makes explicit.
    const releaseOne = new Set(Object.entries(PUSH_TASK_POLICY).filter(([, row]) => row.mode === 'release_one').map(([task]) => task));
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
    // The allow-list is the release_one set exactly -- never a task the policy
    // holds back, however the table grows.
    for (const task of ['vision-product-analysis', 'career-file-extract', 'career-file-transcription-audit', 'marketplace-hub-scan', 'marketplace-hub-scan-batch']) {
      assert(!args.allowTasks.has(task), `${task} must never reach the seam allow-list`);
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
