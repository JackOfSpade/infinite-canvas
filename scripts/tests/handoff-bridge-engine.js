import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { assert } from './testHelpers.js';
import { createFakeClock } from './fixtures/handoff-bridge/fakeClock.js';
import { createHandoffEngine } from '../../electron/ipc/handoffBridge/engine.js';
import { createHandoffBridgePower } from '../../electron/ipc/handoffBridge/power.js';
import { MAX_LIVE_LANES, createLaneStore } from '../../electron/ipc/handoffBridge/laneStore.js';
import { createAuditSink, makeAuditLine, SECURITY_AUDIT_EVENTS } from '../../electron/ipc/handoffBridge/audit.js';
import { CONSTANTS } from '../../electron/ipc/handoffBridge/constants.js';
import { APPLICATION_FENCE_RE, DUPLICATE_RESPONSE_MIN_CHARS, MAX_RESPONSE_BYTES, classifySubmission, extractPasteEnvelopeIdentity, normalizePastedResponse, responseFingerprint, stringifySubmission, trimHandoffCode } from '../../electron/ipc/handoffBridge/preflight.js';
import { APPLICATION_INSTRUCTIONS, REJECTED_CAUTION, RESULT_NOTES, clipCorrectionItem, frameCorrections, makeRejectedBody, makeServedBody, makeResultBody } from '../../electron/ipc/handoffBridge/framing.js';
import { createApplicationLane, createHandoffCodeGuard, holdLane, isHumanAdvance, makeChatKey, rehydrateApplicationLane, remainingCounts, resumeLane, tombstoneCode } from '../../electron/ipc/handoffBridge/lanes.js';
import { AUDIT_LINE_EXAMPLE, ENGINE_PORT_SHAPE, SOURCE_ADAPTER_SHAPE, STATUS_SNAPSHOT_EXAMPLE, TUNNEL_PORT_SHAPE } from '../../electron/ipc/handoffBridge/contracts.js';
import { classifyThrow, fixedError } from '../../electron/ipc/handoffBridge/errors.js';
import { createHandoffBridgeLog, makeLogRecord } from '../../electron/ipc/handoffBridge/log.js';
import { createApplicationSource } from '../../electron/ipc/handoffBridge/sources/application.js';
import { createPushSource } from '../../electron/ipc/handoffBridge/sources/push.js';
import { reduceBridgeQueue } from '../../electron/ipc/handoffBridge/telemetry.js';
import { SURFACE_PIN, TOOLS_LIST, surfaceHash } from '../../electron/ipc/handoffBridge/tools.js';
import { MAX_WORKER_POOL_PLANNING_UNITS, recommendWorkerPool } from '../../electron/ipc/handoffBridge/workerPool.js';

const JOB_A = '11111111-1111-4111-8111-111111111111';
const JOB_B = '22222222-2222-4222-8222-222222222222';
const JOB_C = '33333333-3333-4333-8333-333333333333';
const PATH_A = '/tmp/marisol.canvas';
const PATH_B = '/tmp/ada.canvas';
const LINK = 'link-synthetic';
const codeGuard = createHandoffCodeGuard();

function handoff({ code = 'HANDOFF-A', jobId = JOB_A, stage = 'resume', revision = 1, prompt = 'Synthetic application prompt.' } = {}) {
  return { code, jobId, stage, revision, prompt };
}

function answer({ jobId = JOB_A, code = 'HANDOFF-A', stage = 'resume', extra = {} } = {}) {
  return JSON.stringify({ jobId, stage, handoffCode: code, text: 'Synthetic answer '.repeat(8), ...extra });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function source(overrides = {}) {
  const calls = { read: 0, status: 0, submit: 0 };
  const api = {
    read: async ({ jobId }) => { calls.read++; return { kind: 'open', handoff: handoff({ code: jobId === JOB_B ? 'HANDOFF-B' : 'HANDOFF-A', jobId }) }; },
    status: async () => { calls.status++; return { kind: 'host' }; },
    submit: async () => { calls.submit++; return { kind: 'accepted', completed: true }; },
    ...overrides,
  };
  return { calls, api };
}

async function started({ sourceOverrides, clock = createFakeClock(), engineOptions = {} } = {}) {
  const fake = source(sourceOverrides);
  const engine = createHandoffEngine({ source: fake.api, now: clock.now, timers: clock, random: () => Buffer.alloc(26, 7), holdMs: 0, ...engineOptions });
  assert((await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] })).ok, 'synthetic lane must release');
  const chat = await engine.newChat({ linkId: LINK });
  assert(chat.copied, 'synthetic chat must start');
  return { engine, fake, clock, session: chat.sessionCode };
}

async function served(options = {}) {
  const state = await started(options);
  const result = await state.engine.get({ session: state.session, linkId: LINK });
  assert(result.status === 'served', `expected served handoff, got ${result.status}`);
  return { ...state, result };
}

function cleanDirectory() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ic-handoff-engine-')); }

const tests = [
  {
    name: 'handoff bridge: worker pool planner deploys the maximum safe work count up to ten',
    run: () => {
      // Copying starters is cheap enough that every safe available work item
      // gets a worker until the hard ten-chat ceiling. Use short units here:
      // the old elapsed-time heuristic under-sized these at nine and eleven.
      for (const [work, expected] of [[1, 1], [6, 6], [9, 9], [10, 10], [11, 10]]) {
        const plan = recommendWorkerPool({ tasks: [{ task: 'job-scoring', pending: work }] });
        assert(plan.queued === work && plan.materialized === work && plan.max === expected && plan.recommended === expected,
          `${work} available work items must deploy ${expected} workers (${JSON.stringify(plan)})`);
      }
      const aggregate = recommendWorkerPool({
        tasks: [{ task: 'job-scoring', pending: 2 }],
        applicationCount: 4,
      });
      assert(aggregate.queued === 6 && aggregate.materialized === 6 && aggregate.recommended === 6,
        'the worker count must include every safe push and application work item');
      const hostApplication = recommendWorkerPool({ applicationCount: 0, applicationForecastCount: 1 });
      assert(hostApplication.queued === 1 && hostApplication.materialized === 0 && hostApplication.recommended === 1,
        'app-owned host work remains planned capacity but is not presented as a released handoff');
      const restricted = recommendWorkerPool({
        tasks: [{ task: 'job-scoring', pending: 6 }],
        maxWorkers: 4,
      });
      assert(restricted.queued === 6 && restricted.max === 4 && restricted.recommended === 4,
        'an explicit per-start cap remains a valid restriction on the maximum worker count');
    },
  },
  {
    name: 'handoff bridge: an application host lane remains forecast work until the app releases its next handoff',
    run: async () => {
      const engine = createHandoffEngine({
        source: source({ read: async () => ({ kind: 'host' }) }).api,
        scope: { applications: true, scoring: false, marketplace: false },
        holdMs: 0,
      });
      assert((await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] })).ok, 'the application lane releases');
      const chat = await engine.newChat({ linkId: LINK });
      assert((await engine.get({ session: chat.sessionCode, linkId: LINK })).status === 'waiting', 'the app retains the lane in its host phase');
      const pool = await engine.startWorkerPool({ linkId: LINK });
      assert(pool.started && pool.queued === 1 && pool.materialized === 0
        && engine.snapshot().chat.pool.plan.queued === 1 && engine.snapshot().chat.pool.plan.materialized === 0,
      `a host lane forecasts one later worker unit without claiming it is available now (${JSON.stringify(pool)})`);
      await engine.close();
    },
  },
  {
    name: 'handoff bridge: worker-pool start deploys one chat for each safe work item up to ten',
    run: async () => {
      for (const [work, expected] of [[6, 6], [11, 10]]) {
        const push = {
          refreshHubs: async () => true,
          status: () => ({
            discovered: [{ tasks: [{ task: 'job-scoring', pending: work }] }],
            working: 0,
          }),
          get: async () => ({ status: 'queue_empty', remaining: { ready: 0, working: 0, needsYou: 0 } }),
          submit: async () => ({ status: 'unknown_handoff' }),
          closeEpoch: () => undefined,
        };
        const engine = createHandoffEngine({
          sources: { application: source().api, push },
          scope: { applications: false, scoring: true, marketplace: false },
        });
        const pool = await engine.startWorkerPool({ linkId: LINK });
        assert(pool.started === true && pool.queued === work && pool.workerCount === expected && pool.recommended === expected,
          `${work} safe work items must start ${expected} worker chats (${JSON.stringify(pool)})`);
        await engine.close();
      }
    },
  },
  {
    name: 'handoff bridge: an active five-item preference-research wave forecasts the full phase before choosing worker count',
    run: async () => {
      // The source keeps only a small active wave materialized, but its safe
      // aggregate forecast says that roughly two hundred batches remain. The
      // plan must use the latter for its one-time starter decision; otherwise
      // a 209-batch research phase wrongly looks like five short tasks.
      const task = { task: 'job-preference-research-batch', pending: 5, forecast: 209 };
      const direct = recommendWorkerPool({ tasks: [task] });
      assert(direct.recommended === 10 && direct.queued === 209 && direct.max === 10,
        `the full forecast must justify the ten-worker maximum (${JSON.stringify(direct)})`);
      const capped = recommendWorkerPool({ tasks: [{ ...task, forecast: MAX_WORKER_POOL_PLANNING_UNITS * 2 }] });
      assert(capped.queued === MAX_WORKER_POOL_PLANNING_UNITS && capped.recommended === 10,
        'a malformed/adaptor-sized forecast must stay bounded before planner expansion');
      const push = {
        refreshHubs: async () => true,
        status: () => ({ discovered: [{ tasks: [task] }], working: 0 }),
        get: async () => ({ status: 'queue_empty', remaining: { ready: 0, working: 0, needsYou: 0 } }),
        submit: async () => ({ status: 'unknown_handoff' }),
        closeEpoch: () => undefined,
      };
      const engine = createHandoffEngine({
        sources: { application: source().api, push },
        scope: { applications: false, scoring: true, marketplace: false },
      });
      const pool = await engine.startWorkerPool({ linkId: LINK });
      assert(pool.started === true && pool.workerCount === 10 && pool.queued === 209 && pool.materialized === 5,
        `engine planning must retain the source forecast, not just the five visible tasks (${JSON.stringify(pool)})`);
      await engine.close();
    },
  },
  {
    name: 'handoff bridge: an explicit worker target reserves later-wave capacity without hiding the automatic forecast',
    run: async () => {
      const push = {
        refreshHubs: async () => true,
        status: () => ({ discovered: [{ tasks: [{ task: 'job-preference-evaluation', pending: 6 }] }], working: 0 }),
        get: async () => ({ status: 'queue_empty', remaining: { ready: 0, working: 0, needsYou: 0 } }),
        submit: async () => ({ status: 'unknown_handoff' }),
        closeEpoch: () => undefined,
      };
      const engine = createHandoffEngine({
        sources: { application: source().api, push },
        scope: { applications: false, scoring: true, marketplace: false },
      });
      const automatic = await engine.startWorkerPool({ linkId: LINK });
      assert(automatic.started && automatic.workerCount === 6 && automatic.recommended === 6,
        `six known units must still get the lean automatic pool (${JSON.stringify(automatic)})`);
      const expanded = await engine.startWorkerPool({ linkId: LINK, requestedWorkers: 10 });
      assert(expanded.started && expanded.existing && expanded.workerCount === 10 && expanded.recommended === 6
        && JSON.stringify(expanded.newWorkerOrdinals) === JSON.stringify([7, 8, 9, 10]),
      `an explicit target must add waiting capacity without misreporting the six-unit automatic plan (${JSON.stringify(expanded)})`);
      await engine.close();
    },
  },
  {
    name: 'handoff bridge: an explicit worker target expands a fully claimed live pool for later waves',
    run: async () => {
      let pending = 6;
      const push = {
        refreshHubs: async () => true,
        status: () => ({ discovered: pending ? [{ tasks: [{ task: 'job-preference-evaluation', pending }] }] : [], working: 0 }),
        get: async () => ({ status: 'queue_empty', remaining: { ready: 0, working: 0, needsYou: 0 } }),
        submit: async () => ({ status: 'unknown_handoff' }),
        closeEpoch: () => undefined,
      };
      const engine = createHandoffEngine({
        sources: { application: source().api, push },
        scope: { applications: false, scoring: true, marketplace: false },
      });
      const initial = await engine.startWorkerPool({ linkId: LINK });
      pending = 0;
      const expanded = await engine.startWorkerPool({ linkId: LINK, requestedWorkers: 10 });
      assert(initial.started && initial.workerCount === 6 && expanded.started && expanded.workerCount === 10
        && JSON.stringify(expanded.newWorkerOrdinals) === JSON.stringify([7, 8, 9, 10]),
      `a claimed current wave must not prevent explicitly reserving later-wave workers (${JSON.stringify(expanded)})`);
      await engine.close();
    },
  },
  {
    name: 'handoff bridge: worker pool mints distinct one-time starters without exposing their session codes in status',
    run: async () => {
      const push = {
        refreshHubs: async () => true,
        status: () => ({
          discovered: [{ tasks: [{ task: 'job-role-screen-batch', pending: 13 }] }],
          working: 0,
        }),
        get: async () => ({ status: 'queue_empty', remaining: { ready: 0, working: 0, needsYou: 0 } }),
        submit: async () => ({ status: 'unknown_handoff' }),
        closeEpoch: () => undefined,
      };
      let entropy = 0;
      const engine = createHandoffEngine({
        sources: { application: source().api, push },
        scope: { applications: false, scoring: true, marketplace: false },
        random: () => Buffer.alloc(26, ++entropy),
      });
      const pool = await engine.startWorkerPool({ linkId: LINK });
      assert(pool.started === true && pool.workerCount === 10 && pool.recommended === 10 && pool.queued === 13,
        `the engine must create the planner-selected pool (${JSON.stringify(pool)})`);
      const reserved = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
      assert(reserved.copied === true
        && engine.abandonWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 }) === true,
      'a main-process clipboard failure can release an unobserved worker reservation');
      const starters = [];
      for (let workerOrdinal = 1; workerOrdinal <= pool.workerCount; workerOrdinal += 1) {
        const copied = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal });
        assert(copied.copied === true && copied.workerOrdinal === workerOrdinal && copied.workerCount === pool.workerCount,
          `worker ${workerOrdinal} must get only its own starter`);
        starters.push(copied.sessionCode);
      }
      assert(new Set(starters).size === pool.workerCount, 'every worker starter must carry a distinct session capability');
      assert(engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 }).status === 'starter_copied',
        'a worker starter must be exported at most once before its chat connects');
      const poolStatus = engine.snapshot().chat.pool;
      assert(poolStatus?.active === true && poolStatus.generation === pool.generation && poolStatus.workerCount === pool.workerCount,
        'status must expose only the bounded live-pool identity needed to retire stale renderer controls');
      assert(Array.isArray(poolStatus.workers) && poolStatus.workers.length === pool.workerCount
        && poolStatus.workers.every((worker, index) => worker.ordinal === index + 1 && worker.state === 'ready' && worker.completed === 0),
      'a copied-but-not-yet-connected starter is reported as ready without exposing its capability');
      const serializedStatus = JSON.stringify(engine.snapshot());
      assert(starters.every(sessionCode => !serializedStatus.includes(sessionCode)), 'worker session codes must never reach status');
      assert((await engine.newChat({ linkId: LINK })).status === 'pool_active'
        && (await engine.continueChat({ linkId: LINK })).status === 'pool_active',
      'ordinary one-chat controls must not silently replace an active worker pool');
      await engine.close();
    },
  },
  {
    name: 'handoff bridge: a drained worker pool retains bounded closed lifecycle evidence without capabilities',
    run: async () => {
      const privateStarter = 'PRIVATE-DRAINED-STARTER';
      const push = {
        refreshHubs: async () => true,
        status: () => ({ discovered: [{ tasks: [{ task: 'job-scoring', pending: 1 }] }], working: 0 }),
        get: async () => ({ status: 'queue_empty', remaining: { ready: 0, working: 0, needsYou: 0 } }),
        submit: async () => ({ status: 'unknown_handoff' }), closeEpoch: () => undefined,
      };
      const engine = createHandoffEngine({ sources: { application: source().api, push }, scope: { applications: false, scoring: true, marketplace: false }, holdMs: 0,
        random: () => Buffer.from(privateStarter.padEnd(26, 'X').slice(0, 26)) });
      const pool = await engine.startWorkerPool({ linkId: LINK, requestedWorkers: 1 });
      const starter = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
      assert((await engine.get({ session: starter.sessionCode, linkId: LINK })).status === 'queue_empty', 'the empty pull drains the live pool');
      const closed = engine.snapshot().chat.pool.history;
      assert(engine.snapshot().chat.pool.active === false && closed.length === 1 && closed[0].reason === 'drained'
        && closed[0].workerCount === 1 && closed[0].workers[0]?.ordinal === 1,
      'a terminal queue_empty keeps one bounded closed-pool receipt instead of relabelling it legacy');
      assert(!JSON.stringify(closed).includes(starter.sessionCode) && !JSON.stringify(closed).includes(privateStarter),
        'closed pool diagnostics never expose a session capability or prompt material');
      await engine.close();
    },
  },
  {
    name: 'handoff bridge: a push source ending an owned handoff records source_ended instead of drained',
    run: async () => {
      const rec = recorders();
      let gets = 0;
      const push = {
        refreshHubs: async () => true,
        status: () => ({ discovered: [{ tasks: [{ task: 'job-scoring', pending: 2 }] }], working: 1 }),
        get: async () => (gets++ === 0
          ? { status: 'served', handoffCode: 'PUSH-SOURCE-ENDED', task: 'job-scoring', prompt: 'Synthetic push prompt.', remaining: { ready: 0, working: 1, needsYou: 0 } }
          : { status: 'queue_empty', remaining: { ready: 0, working: 0, needsYou: 0 } }),
        submit: async () => ({ status: 'unknown_handoff' }), closeEpoch: () => undefined,
      };
      const engine = createHandoffEngine({ sources: { application: source().api, push }, scope: { applications: false, scoring: true, marketplace: false }, holdMs: 0, ...rec.port });
      const pool = await engine.startWorkerPool({ linkId: LINK, requestedWorkers: 2 });
      const owner = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
      const observer = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 2 });
      assert((await engine.get({ session: owner.sessionCode, linkId: LINK })).status === 'served', 'worker 1 must first own the push handoff');
      assert((await engine.get({ session: observer.sessionCode, linkId: LINK })).status === 'queue_empty', 'worker 2 observes the disappeared source handoff');
      const status = engine.snapshot();
      assert(status.chat.pool.active === false && status.chat.pool.history[0]?.reason === 'source_ended'
        && status.chat.previous[0]?.reason === 'source_ended',
      'a terminal source disappearance is retained as source_ended rather than a natural drain');
      assert(rec.logs.some(entry => entry.code === 'epoch_closed' && entry.fields.cause === 'source_ended')
        && rec.audit.some(entry => entry.event === 'epoch_closed' && entry.fields.reason === 'source_ended'),
      'the neutral close reason reaches audit and structured diagnostics');
      await engine.close();
    },
  },
  {
    name: 'handoff bridge: a worker that stops after waiting becomes a restartable polling-silence recovery, including an accepted successor wait',
    run: async () => {
      const clock = createFakeClock();
      let served = false;
      const push = {
        refreshHubs: async () => true,
        status: () => ({ discovered: [{ tasks: [{ task: 'job-scoring', pending: 1 }] }], working: 1 }),
        get: async () => served
          ? { status: 'waiting', remaining: { ready: 0, working: 1, needsYou: 0 } }
          : (served = true, { status: 'served', handoffCode: 'PUSH-WAIT-RECOVERY', task: 'job-scoring', prompt: 'Synthetic prompt.', remaining: { ready: 0, working: 1, needsYou: 0 } }),
        submit: async () => ({ status: 'accepted' }),
        nextAfterAccept: async () => ({ status: 'waiting', retryAfterSeconds: 3, remaining: { ready: 0, working: 1, needsYou: 0 } }),
        closeEpoch: () => undefined,
      };
      const engine = createHandoffEngine({
        sources: { application: source().api, push }, scope: { applications: false, scoring: true, marketplace: false },
        now: clock.now, timers: clock, holdMs: 0,
      });
      const pool = await engine.startWorkerPool({ linkId: LINK, requestedWorkers: 1 });
      const starter = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
      const first = await engine.get({ session: starter.sessionCode, linkId: LINK });
      const accepted = await engine.submit({ session: starter.sessionCode, linkId: LINK, handoffCode: first.handoffCode, response: 'Synthetic completed response '.repeat(8) });
      assert(first.status === 'served' && accepted.status === 'accepted' && accepted.next?.status === 'waiting',
        'an accepted submit preserves its established result while exposing the successor wait');
      let worker = engine.snapshot().chat.pool.workers[0];
      assert(worker?.state === 'waiting' && worker.lastOutcome === 'accepted',
        'the accepted successor wait leaves the worker connected and expecting another poll');
      clock.advance(CONSTANTS.STALL_NOTICE_MS);
      worker = engine.snapshot().chat.pool.workers[0];
      assert(worker?.state === 'quiet' && worker.quietReason === 'polling_stopped',
        'a chat that stops after an explicit wait gets the safe polling-silence recovery signal');
      const replacement = engine.restartWorker({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
      assert(replacement.copied && engine.snapshot().chat.pool.workers[0]?.state === 'ready'
        && engine.snapshot().chat.pool.workers[0]?.restarts === 1,
      'the quiet polling worker receives a fresh replacement starter without auto-invalidating it first');
      assert((await engine.get({ session: starter.sessionCode, linkId: LINK })).status === 'session_ended',
        'the old worker is retired only when the user explicitly requests replacement');
      const directWait = await engine.get({ session: replacement.sessionCode, linkId: LINK });
      assert(directWait.status === 'waiting', 'a fresh worker can receive a plain get_handoff waiting result before work exists');
      for (let poll = 0; poll < 3; poll++) {
        clock.advance(Math.ceil(CONSTANTS.STALL_NOTICE_MS / 2));
        assert((await engine.get({ session: replacement.sessionCode, linkId: LINK })).status === 'waiting',
          `healthy waiting poll ${poll + 1} is acknowledged`);
        assert(engine.snapshot().chat.pool.workers[0]?.state === 'waiting'
          && engine.restartWorker({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 }).status === 'not_quiet',
        `a repeated promised poll refreshes the silence deadline (${poll + 1})`);
      }
      clock.advance(CONSTANTS.STALL_NOTICE_MS);
      assert(engine.snapshot().chat.pool.workers[0]?.state === 'quiet'
        && engine.snapshot().chat.pool.workers[0]?.quietReason === 'polling_stopped'
        && engine.restartWorker({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 }).copied,
      'a worker that stops immediately after a direct waiting result is also restartable');
      await engine.close();
    },
  },
  {
    name: 'handoff bridge: an unanswered preference handoff becomes answer-silent at five minutes without revoking its late submit',
    run: async () => {
      const clock = createFakeClock();
      const privatePrompt = 'PRIVATE-PREFERENCE-PROMPT';
      let pulls = 0;
      const push = {
        refreshHubs: async () => true,
        status: () => ({
          discovered: [{ tasks: [{ task: 'job-preference-evaluation', pending: 1 }] }],
          working: 0,
        }),
        get: async () => {
          pulls += 1;
          if (pulls === 1) {
            return {
              status: 'served',
              handoffCode: 'PUSH-QUIET-WORKER',
              task: 'job-preference-evaluation',
              prompt: privatePrompt,
              remaining: { ready: 0, working: 1, needsYou: 0 },
            };
          }
          return { status: 'waiting', remaining: { ready: 0, working: 1, needsYou: 0 } };
        },
        submit: async () => ({ status: 'accepted' }),
        closeEpoch: () => undefined,
      };
      const engine = createHandoffEngine({
        sources: { application: source().api, push },
        scope: { applications: false, scoring: true, marketplace: false },
        now: clock.now,
        timers: clock,
        holdMs: 0,
      });
      const pool = await engine.startWorkerPool({ linkId: LINK, requestedWorkers: 1 });
      const starter = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
      const served = await engine.get({ session: starter.sessionCode, linkId: LINK });
      assert(pool.started && starter.copied && served.status === 'served' && served.kind === 'push',
        'the fixture must give the single worker a preference handoff');
      assert(engine.snapshot().chat.pool.workers[0]?.state === 'working'
        && engine.snapshot().chat.pool.workers[0]?.completed === 0,
      'a freshly served push handoff is processing, not quiet');

      clock.advance(CONSTANTS.STALL_NOTICE_MS - 1);
      assert(engine.snapshot().chat.pool.workers[0]?.state === 'working',
        'a worker remains working until its response grace period has actually elapsed');
      clock.advance(1);
      const slowSnapshot = engine.snapshot();
      assert(slowSnapshot.chat.pool.workers[0]?.state === 'quiet'
        && slowSnapshot.chat.pool.workers[0]?.quietReason === 'answer_silent',
      'an unanswered preference handoff becomes an actionable answer-silent warning at the five-minute boundary');
      const accepted = await engine.submit({
        session: starter.sessionCode, linkId: LINK, handoffCode: served.handoffCode,
        response: 'Synthetic completed preference response '.repeat(8),
      });
      const settled = engine.snapshot().chat.pool.workers[0];
      assert(accepted.status === 'accepted' && settled?.completed === 1 && settled?.state === 'waiting',
        'the original slow worker can submit its valid late response and then return to the explicit waiting lifecycle');
      await engine.close();
    },
  },
  {
    name: 'handoff bridge: an unanswered application handoff becomes answer-silent but accepts a late original response',
    run: async () => {
      const clock = createFakeClock();
      const privatePrompt = 'PRIVATE-APPLICATION-PROMPT';
      const application = source({
        read: async () => ({ kind: 'open', handoff: handoff({ code: 'APPLICATION-QUIET-WORKER', prompt: privatePrompt }) }),
      });
      const engine = createHandoffEngine({
        source: application.api,
        scope: { applications: true, scoring: false, marketplace: false },
        now: clock.now,
        timers: clock,
        holdMs: 0,
      });
      assert((await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] })).ok,
        'the application worker fixture must have one released handoff');
      const pool = await engine.startWorkerPool({ linkId: LINK, requestedWorkers: 1 });
      const starter = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
      const served = await engine.get({ session: starter.sessionCode, linkId: LINK });
      assert(pool.started && starter.copied && served.status === 'served' && served.kind === 'application',
        'the application pool worker must receive the released handoff');
      clock.advance(CONSTANTS.STALL_NOTICE_MS - 1);
      assert(engine.snapshot().chat.pool.workers[0]?.state === 'working',
        'a slow application response does not look stale before the grace period');
      clock.advance(1);
      const slowSnapshot = engine.snapshot();
      assert(slowSnapshot.chat.pool.workers[0]?.state === 'quiet'
        && slowSnapshot.chat.pool.workers[0]?.quietReason === 'answer_silent',
      'an unanswered application handoff becomes answer-silent at the five-minute boundary instead of claiming the chat is still working');
      const accepted = await engine.submit({
        session: starter.sessionCode, linkId: LINK, handoffCode: served.handoffCode,
        response: answer({ code: served.handoffCode, stage: served.stage }),
      });
      assert(accepted.status === 'accepted' && engine.snapshot().chat.pool.workers[0]?.completed === 1,
        'the original application worker can submit its valid late answer without losing ownership');
      await engine.close();
    },
  },
  {
    name: 'handoff bridge: an authenticated worker refresh expands a live pool monotonically from fresh forecast work',
    run: async () => {
      let forecast = 1;
      const push = {
        refreshHubs: async () => true,
        status: () => ({
          discovered: [{ tasks: [{ task: 'job-scoring', pending: 1, forecast }] }],
          working: 1,
        }),
        get: async () => ({ status: 'waiting', remaining: { ready: 0, working: 1, needsYou: 0 } }),
        submit: async () => ({ status: 'unknown_handoff' }),
        closeEpoch: () => undefined,
      };
      const engine = createHandoffEngine({
        sources: { application: source().api, push },
        scope: { applications: false, scoring: true, marketplace: false },
        holdMs: 0,
      });
      const pool = await engine.startWorkerPool({ linkId: LINK, requestedWorkers: 1 });
      const starter = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
      assert(pool.workerCount === 1 && starter.copied, 'the initial one-item forecast must create exactly one copyable worker');
      forecast = 12;
      // MCP's tool schema intentionally supplies only `session`; its
      // authenticated OAuth grant owns the link binding. Pool expansion must
      // use that grant too, not silently require a renderer-only linkId.
      const refreshed = await engine.get({ session: starter.sessionCode, grant: { linkId: LINK } });
      const expanded = engine.snapshot().chat.pool;
      assert(refreshed.status === 'waiting' && expanded.workerCount === 10
        && expanded.plan.recommended === 10 && expanded.plan.queued === 12
        && expanded.plan.materialized === 1
        && expanded.plan.expandBy === 0 && expanded.plan.reason === 'maximum_parallelism',
      `fresh authenticated work must grow the existing pool to the safe ceiling (${JSON.stringify(expanded)})`);
      assert(expanded.workers.slice(1).every(worker => worker.state === 'available')
        && engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 10 }).copied,
      'newly planned workers remain available starters; expansion never opens chats itself');
      forecast = 1;
      await engine.get({ session: starter.sessionCode, grant: { linkId: LINK } });
      assert(engine.snapshot().chat.pool.workerCount === 10,
        'a later smaller forecast never silently retires live workers or copied starters');
      await engine.close();
    },
  },
  {
    name: 'handoff bridge: an outstanding push handoff is answer-silent after five minutes but its original chat may still submit',
    run: async () => {
      const clock = createFakeClock();
      let pulls = 0;
      const push = {
        refreshHubs: async () => true,
        status: () => ({ discovered: [{ tasks: [{ task: 'job-scoring', pending: 1 }] }], working: 1 }),
        get: async () => {
          pulls += 1;
          return {
            status: 'served', handoffCode: 'PUSH-RESTART-SAME', task: 'job-scoring',
            prompt: 'Complete this same outstanding scoring handoff.',
            remaining: { ready: 0, working: 1, needsYou: 0 },
          };
        },
        submit: async () => ({ status: 'accepted' }),
        closeEpoch: () => undefined,
      };
      let entropy = 0;
      const engine = createHandoffEngine({
        sources: { application: source().api, push },
        scope: { applications: false, scoring: true, marketplace: false },
        now: clock.now, timers: clock, holdMs: 0,
        random: () => Buffer.alloc(26, ++entropy),
      });
      const pool = await engine.startWorkerPool({ linkId: LINK, requestedWorkers: 1 });
      const oldStarter = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
      const initial = await engine.get({ session: oldStarter.sessionCode, linkId: LINK });
      assert(initial.status === 'served' && initial.handoffCode === 'PUSH-RESTART-SAME', 'the worker must own the push handoff before it can be answered');
      const accepted = await engine.submit({
        session: oldStarter.sessionCode, linkId: LINK, handoffCode: initial.handoffCode,
        response: 'Completed the first safe scoring result. '.repeat(8),
      });
      const outstanding = await engine.get({ session: oldStarter.sessionCode, linkId: LINK });
      assert(accepted.status === 'accepted' && outstanding.status === 'served',
        'the fixture must retain a later outstanding handoff after one completed result');
      clock.advance(CONSTANTS.STALL_NOTICE_MS - 1);
      assert(engine.snapshot().chat.pool.workers[0]?.state === 'working', 'an outstanding push answer stays working before the five-minute grace period');
      clock.advance(1);
      assert(engine.snapshot().chat.pool.workers[0]?.state === 'quiet'
        && engine.snapshot().chat.pool.workers[0]?.quietReason === 'answer_silent',
      'a silent outstanding push answer becomes recoverable at five minutes rather than claiming its chat is still working');
      const late = await engine.submit({
        session: oldStarter.sessionCode, linkId: LINK, handoffCode: outstanding.handoffCode,
        response: 'Completed the delayed scoring result. '.repeat(8),
      });
      assert(late.status === 'accepted' && engine.snapshot().chat.pool.workers[0]?.completed === 2 && pulls === 2,
        'the original chat retains the outstanding push handoff and can submit it late');
      await engine.close();
    },
  },
  {
    name: 'handoff bridge: an answer-silent application worker replacement replays its assigned lane without losing the late-response fence',
    run: async () => {
      const clock = createFakeClock();
      const application = source({
        read: async () => ({ kind: 'open', handoff: handoff({ code: 'APPLICATION-ANSWER-SILENT-REPLAY' }) }),
        submit: async () => ({ kind: 'accepted', completed: true }),
      });
      const engine = createHandoffEngine({
        source: application.api, scope: { applications: true, scoring: false, marketplace: false },
        now: clock.now, timers: clock, holdMs: 0,
      });
      assert((await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] })).ok,
        'the replay fixture must own one released application lane');
      const pool = await engine.startWorkerPool({ linkId: LINK, requestedWorkers: 1 });
      const oldStarter = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
      const first = await engine.get({ session: oldStarter.sessionCode, linkId: LINK });
      assert(engine.snapshot().queue.jobs.find(job => job.jobId === JOB_A)?.workerOrdinal === 1,
        'the application status exposes only the owning worker ordinal, never a session capability');
      clock.advance(CONSTANTS.STALL_NOTICE_MS);
      assert(engine.snapshot().chat.pool.workers[0]?.quietReason === 'answer_silent',
        'application ownership must expose the same answer-silent recovery signal');
      const replacement = engine.restartWorker({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
      const duplicateRestart = engine.restartWorker({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
      assert(replacement.copied && duplicateRestart.status === 'not_quiet'
        && engine.snapshot().chat.pool.workers[0]?.state === 'ready'
        && engine.snapshot().queue.jobs.find(job => job.jobId === JOB_A)?.workerOrdinal === 1,
      'a replacement starter resets only the ambiguity clock, so a double restart cannot invalidate it before its first get');
      const replay = await engine.get({ session: replacement.sessionCode, linkId: LINK });
      assert(replay.status === 'served' && replay.handoffCode === first.handoffCode
        && (await engine.get({ session: oldStarter.sessionCode, linkId: LINK })).status === 'session_ended',
      'the replacement owns the original application lane while the old chat cannot submit it');
      const settled = await engine.submit({
        session: replacement.sessionCode, linkId: LINK, handoffCode: replay.handoffCode,
        response: answer({ code: replay.handoffCode }),
      });
      assert(settled.status === 'accepted' && engine.snapshot().chat.pool.workers[0]?.completed === 1,
        'the replayed application lane settles once through its replacement worker');
      await engine.close();
    },
  },
  {
    name: 'handoff bridge: replacing an answer-silent worker retains its handoff for the replacement and ends only the old chat',
    run: async () => {
      const clock = createFakeClock();
      let gets = 0;
      let submissions = 0;
      const push = {
        refreshHubs: async () => true,
        status: () => ({ discovered: [{ tasks: [{ task: 'job-preference-evaluation', pending: 1 }] }], working: 1 }),
        get: async () => ({
          status: 'served', handoffCode: 'PUSH-ANSWER-SILENT-REPLAY', task: 'job-preference-evaluation',
          prompt: `Synthetic replayable prompt ${++gets}.`, remaining: { ready: 0, working: 1, needsYou: 0 },
        }),
        submit: async () => ({ status: ++submissions === 1 ? 'accepted' : 'duplicate' }),
        closeEpoch: () => undefined,
      };
      const engine = createHandoffEngine({
        sources: { application: source().api, push }, scope: { applications: false, scoring: true, marketplace: false },
        now: clock.now, timers: clock, holdMs: 0,
      });
      const pool = await engine.startWorkerPool({ linkId: LINK, requestedWorkers: 1 });
      const oldStarter = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
      const first = await engine.get({ session: oldStarter.sessionCode, linkId: LINK });
      clock.advance(CONSTANTS.STALL_NOTICE_MS);
      assert(engine.snapshot().chat.pool.workers[0]?.state === 'quiet'
        && engine.snapshot().chat.pool.workers[0]?.quietReason === 'answer_silent',
      'only a truly silent outstanding response offers recovery');
      const replacement = engine.restartWorker({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
      assert(replacement.copied && (await engine.get({ session: oldStarter.sessionCode, linkId: LINK })).status === 'session_ended',
        'replacement explicitly invalidates the old chat but no passive timeout does');
      const replay = await engine.get({ session: replacement.sessionCode, linkId: LINK });
      assert(first.status === 'served' && replay.status === 'served' && replay.handoffCode === first.handoffCode,
        'the replacement receives the same logical handoff and code rather than a duplicate claim');
      const settled = await engine.submit({
        session: replacement.sessionCode, linkId: LINK, handoffCode: replay.handoffCode,
        response: 'Synthetic replacement response '.repeat(8),
      });
      assert(settled.status === 'accepted' && submissions === 1 && engine.snapshot().chat.pool.workers[0]?.completed === 1,
        'the replacement settles the replayed handoff exactly once');
      await engine.close();
    },
  },
  {
    name: 'handoff bridge: worker pool plans only selected enabled sources',
    run: async () => {
      const selectedKey = 'a'.repeat(64); const optedOutKey = 'b'.repeat(64);
      const push = {
        refreshHubs: async () => true,
        status: () => ({
          selectedHubs: [selectedKey],
          discovered: [
            { key: selectedKey, tasks: [{ task: 'job-scoring', pending: 1 }] },
            { key: optedOutKey, tasks: [{ task: 'job-role-screen-batch', pending: 13 }] },
          ],
          working: 0,
        }),
        get: async () => ({ status: 'queue_empty', remaining: { ready: 0, working: 0, needsYou: 0 } }),
        submit: async () => ({ status: 'unknown_handoff' }),
        closeEpoch: () => undefined,
      };
      const engine = createHandoffEngine({
        sources: { application: source().api, push },
        scope: { applications: false, scoring: true, marketplace: false },
      });
      const pool = await engine.startWorkerPool({ linkId: LINK });
      assert(pool.started === true && pool.queued === 1 && pool.workerCount === 1,
        'unselected push hubs and disabled application lanes must not cause needless worker chats');
      await engine.close();
    },
  },
  {
    name: 'handoff bridge: concurrent worker-pool starts share one committed generation',
    run: async () => {
      const refreshGate = deferred(); let refreshes = 0;
      const push = {
        refreshHubs: async () => { refreshes += 1; await refreshGate.promise; return true; },
        status: () => ({ discovered: [{ tasks: [{ task: 'job-role-screen-batch', pending: 13 }] }], working: 0 }),
        get: async () => ({ status: 'queue_empty', remaining: { ready: 0, working: 0, needsYou: 0 } }),
        submit: async () => ({ status: 'unknown_handoff' }),
        closeEpoch: () => undefined,
      };
      let entropy = 0;
      const engine = createHandoffEngine({
        sources: { application: source().api, push },
        scope: { applications: false, scoring: true, marketplace: false },
        random: () => Buffer.alloc(26, ++entropy),
      });
      const first = engine.startWorkerPool({ linkId: LINK });
      const second = engine.startWorkerPool({ linkId: LINK });
      await Promise.resolve(); await Promise.resolve();
      assert(refreshes === 1, 'overlapping pool starts must share the one discovery/commit operation');
      refreshGate.resolve(true);
      const [left, right] = await Promise.all([first, second]);
      assert(left.started === true && right.started === true && left.generation === right.generation && left.workerCount === right.workerCount,
        'every concurrent caller must receive the same live pool generation');
      await engine.close();
    },
  },
  {
    name: 'handoff bridge: expanding a live chat preserves worker one and only mints missing worker starters',
    run: async () => {
      const app = source({
        read: async ({ jobId }) => ({
          kind: 'open',
          handoff: handoff({ jobId, code: jobId === JOB_A ? 'HANDOFF-A' : 'HANDOFF-B' }),
        }),
      });
      const engine = createHandoffEngine({
        source: app.api,
        scope: { applications: true, scoring: false, marketplace: false },
        holdMs: 0,
      });
      assert((await engine.release({ jobs: [
        { jobId: JOB_A, canvasFilePath: PATH_A },
        { jobId: JOB_B, canvasFilePath: PATH_B },
      ] })).ok, 'two application lanes must be ready');
      const legacy = await engine.newChat({ linkId: LINK });
      const first = await engine.get({ session: legacy.sessionCode, linkId: LINK });
      assert(first.status === 'served' && first.handoffCode === 'HANDOFF-A', 'worker one must own the already-served handoff before expansion');
      const pool = await engine.startWorkerPool({ linkId: LINK });
      assert(pool.started && pool.existing && pool.workerCount === 2
        && JSON.stringify(pool.newWorkerOrdinals) === JSON.stringify([2]),
      `the live chat must become worker one without a replacement (${JSON.stringify(pool)})`);
      const sibling = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 2 });
      assert(sibling.copied, 'only the newly minted worker needs a new starter');
      const second = await engine.get({ session: sibling.sessionCode, linkId: LINK });
      assert(second.status === 'served' && second.handoffCode === 'HANDOFF-B', 'the sibling worker must receive the other lane');
      const accepted = await engine.submit({
        session: legacy.sessionCode,
        linkId: LINK,
        handoffCode: first.handoffCode,
        response: answer({ code: first.handoffCode, stage: first.stage }),
      });
      assert(accepted.status === 'accepted', 'expanding must not strand worker one\'s outstanding answer');
      await engine.close();
    },
  },
  {
    name: 'handoff bridge: pool workers own distinct application handoffs and keep rolling past the single-chat job cap',
    run: async () => {
      const app = source({
        read: async ({ jobId }) => ({
          kind: 'open',
          handoff: handoff({
            jobId,
            code: jobId === JOB_A ? 'HANDOFF-A' : jobId === JOB_B ? 'HANDOFF-B' : 'HANDOFF-C',
          }),
        }),
      });
      let entropy = 0;
      const engine = createHandoffEngine({
        source: app.api,
        scope: { applications: true, scoring: false, marketplace: false },
        random: () => Buffer.alloc(26, ++entropy),
        holdMs: 0,
      });
      assert((await engine.release({ jobs: [
        { jobId: JOB_A, canvasFilePath: PATH_A },
        { jobId: JOB_B, canvasFilePath: PATH_A },
        { jobId: JOB_C, canvasFilePath: PATH_A },
      ] })).ok, 'three application lanes must be available to the pool');
      const pool = await engine.startWorkerPool({ linkId: LINK, requestedWorkers: 1 });
      const starter = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
      assert(pool.started && pool.workerCount === 1 && starter.copied, 'the forced one-worker pool must expose its one starter');
      for (const [expected, expectedCode] of [[JOB_A, 'HANDOFF-A'], [JOB_B, 'HANDOFF-B'], [JOB_C, 'HANDOFF-C']]) {
        const got = await engine.get({ session: starter.sessionCode, linkId: LINK });
        assert(got.status === 'served' && got.handoffCode === expectedCode, `pool worker must keep claiming ${expected}`);
        const accepted = await engine.submit({
          session: starter.sessionCode,
          linkId: LINK,
          handoffCode: got.handoffCode,
          response: answer({ jobId: expected, code: got.handoffCode, stage: got.stage }),
        });
        assert(accepted.status === 'accepted', `pool worker must finish ${expected}`);
      }
      const workerProgress = engine.snapshot().chat.pool.workers;
      assert(workerProgress.length === 1 && workerProgress[0].ordinal === 1
        && workerProgress[0].state === 'waiting' && workerProgress[0].completed === 3,
      'one connected worker reports every accepted handoff as completed after its rolling queue drains');
      await engine.close();
    },
  },
  {
    name: 'handoff bridge: concurrent application pool workers receive distinct routes and cannot submit for one another',
    run: async () => {
      const app = source({
        read: async ({ jobId }) => ({ kind: 'open', handoff: handoff({ jobId, code: jobId === JOB_A ? 'HANDOFF-A' : 'HANDOFF-B' }) }),
      });
      let entropy = 0;
      const engine = createHandoffEngine({
        source: app.api,
        scope: { applications: true, scoring: false, marketplace: false },
        random: () => Buffer.alloc(26, ++entropy),
        holdMs: 0,
      });
      assert((await engine.release({ jobs: [
        { jobId: JOB_A, canvasFilePath: PATH_A },
        { jobId: JOB_B, canvasFilePath: PATH_A },
      ] })).ok, 'two application lanes must be available to the pool');
      const pool = await engine.startWorkerPool({ linkId: LINK, requestedWorkers: 2 });
      const firstStarter = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
      const secondStarter = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 2 });
      const [firstInitial, secondInitial] = await Promise.all([
        engine.get({ session: firstStarter.sessionCode, linkId: LINK }),
        engine.get({ session: secondStarter.sessionCode, linkId: LINK }),
      ]);
      assert(firstInitial.status === 'served' && secondInitial.status === 'served'
        && firstInitial.handoffCode !== secondInitial.handoffCode,
      'two workers must immediately receive distinct application handoffs from a concurrent pull');
      const foreign = await engine.submit({
        session: secondStarter.sessionCode,
        linkId: LINK,
        handoffCode: firstInitial.handoffCode,
        response: answer({ code: firstInitial.handoffCode, stage: firstInitial.stage }),
      });
      assert(foreign.status === 'unknown_handoff', 'a worker cannot submit an application handoff owned by another worker');
      await engine.close();
    },
  },
  {
    name: 'handoff bridge: snapshot aggregates live-worker traffic instead of reporting only worker one',
    run: async () => {
      const app = source({
        read: async ({ jobId }) => ({
          kind: 'open',
          handoff: handoff({
            jobId,
            code: jobId === JOB_A ? 'HANDOFF-SNAPSHOT-A' : 'HANDOFF-SNAPSHOT-B',
            // Make worker two's contribution unmistakable in the aggregate.
            prompt: jobId === JOB_B ? 'x'.repeat(12_000) : 'small worker-one prompt',
          }),
        }),
      });
      const engine = createHandoffEngine({
        source: app.api,
        scope: { applications: true, scoring: false, marketplace: false },
        holdMs: 0,
      });
      assert((await engine.release({ jobs: [
        { jobId: JOB_A, canvasFilePath: PATH_A },
        { jobId: JOB_B, canvasFilePath: PATH_B },
      ] })).ok, 'two application lanes must release');
      const pool = await engine.startWorkerPool({ linkId: LINK, requestedWorkers: 2 });
      const one = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
      const two = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 2 });
      assert((await engine.get({ session: one.sessionCode, linkId: LINK })).status === 'served', 'worker one must receive the first lane');
      assert((await engine.get({ session: two.sessionCode, linkId: LINK })).status === 'served', 'worker two must receive the second lane');
      const chat = engine.snapshot().chat;
      assert(chat.calls === 2 && chat.jobsAssigned === 2 && chat.bytesServed > 10_000
        && chat.pool.active === true && chat.pool.workerCount === 2,
      `pool diagnostics must aggregate every active worker (${JSON.stringify(chat)})`);
      assert(chat.pool.workers.length === 2 && chat.pool.workers.every((worker, index) =>
        worker.ordinal === index + 1 && worker.state === 'working' && worker.completed === 0),
      'each served worker has a bounded active-processing roster entry before it submits');
      await engine.close();
    },
  },
  {
    name: 'handoff bridge: same worker concurrent application GETs attach to one proof reservation',
    run: async () => {
      let statusCalls = 0; let heldProof = null;
      const app = source({
        status: async () => {
          statusCalls += 1;
          if (heldProof) await heldProof.promise;
          return { kind: 'host' };
        },
      });
      const engine = createHandoffEngine({
        source: app.api,
        scope: { applications: true, scoring: false, marketplace: false },
        holdMs: 0,
      });
      assert((await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] })).ok, 'application lane must release');
      const chat = await engine.newChat({ linkId: LINK });
      const first = await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(first.status === 'served', 'the first GET establishes an outstanding application handoff');
      const beforeProof = statusCalls;
      heldProof = deferred();
      const one = engine.get({ session: chat.sessionCode, linkId: LINK });
      const two = engine.get({ session: chat.sessionCode, linkId: LINK });
      await new Promise(resolve => setImmediate(resolve));
      assert(statusCalls === beforeProof + 1, 'same-worker retries must start only one asynchronous bundle proof');
      heldProof.resolve();
      const [left, right] = await Promise.all([one, two]);
      const snapshot = engine.snapshot();
      assert(left.status === 'served' && right.status === 'served' && left.handoffCode === first.handoffCode && right.handoffCode === first.handoffCode
        && snapshot.counts.getServed === 2 && snapshot.chat.calls === 3 && snapshot.chat.servedTwice === true,
      'both retries must receive the one re-served handoff, with no duplicate serve or byte/count mutation');
      await engine.close();
    },
  },
  {
    name: 'handoff bridge: engine: frozen port and status contracts are complete and immutable',
    run: () => {
      assert(ENGINE_PORT_SHAPE.join(',') === 'get,submit,snapshot,close', 'engine port shape drifted');
      assert(SOURCE_ADAPTER_SHAPE.join(',') === 'read,status,submit', 'source adapter shape drifted');
      assert(TUNNEL_PORT_SHAPE.join(',') === 'start,stop,status,reapOrphans', 'tunnel port shape drifted');
      assert(STATUS_SNAPSHOT_EXAMPLE.v === 1 && STATUS_SNAPSHOT_EXAMPLE.power.keepAwake === false, 'status example must be safe and versioned');
      assert(STATUS_SNAPSHOT_EXAMPLE.limits.idlePauseMinutes === 1440, 'status example must expose the accepted idle default');
      assert(Object.isFrozen(STATUS_SNAPSHOT_EXAMPLE.queue.applications), 'status contract must be deeply immutable');
      assert(!JSON.stringify(STATUS_SNAPSHOT_EXAMPLE).match(/prompt|handoffCode|canvasFilePath|label/i), 'status contract must not expose content or identifiers');
      assert(Object.keys(AUDIT_LINE_EXAMPLE).join(',') === 't,ev,tool,outcome,stage,argBytes,resultBytes,ms,grantFp,epochFp,source,tokenLeftSec', 'serve audit schema drifted');
    },
  },
  {
    name: 'handoff bridge: engine: errors logs and audit lines reject free text',
    run: () => {
      assert(fixedError('no_hostname').message === 'A bridge hostname is required.', 'fixed error sentence drifted');
      assert(classifyThrow({ code: 'no_hostname', message: 'secret prompt' }).code === 'no_hostname', 'classification must use only code');
      assert(classifyThrow({ code: 'not-a-code', message: 'secret prompt' }).code === 'internal_error', 'unknown codes must collapse');
      assert(makeLogRecord('pause', { cause: 'idle' }).fields.cause === 'idle', 'safe enumerated log fields must pass');
      assert(makeLogRecord('worker_pool_started', { workers: 10, recommended: 10, queued: 184 }).fields.queued === 184,
        'worker-pool lifecycle evidence must use the closed aggregate log schema');
      for (const attempt of [
        () => makeLogRecord('unknown', {}), () => makeLogRecord('pause', { reason: 'free text with spaces' }),
        () => makeLogRecord('link_created', { candidate: 'ada' }), () => makeLogRecord('pause', { tool: 'get_handoff' }),
        () => makeAuditLine({ event: 'served', fields: { prompt: 'secret' } }), () => makeAuditLine({ event: 'served', fields: { code: 'safe-looking-code' } }),
        () => makeAuditLine({ event: 'not_enumerated', fields: {} }),
      ]) { let threw = false; try { attempt(); } catch { threw = true; } assert(threw, 'free-form log or audit input must be rejected'); }
      assert(makeAuditLine({ at: 1, event: 'served', fields: { tool: 'get_handoff', outcome: 'ok', argBytes: 12 } }).ev === 'served', 'enumerated serve audit must pass');
    },
  },
  {
    name: 'handoff bridge: engine: concrete bridge logger validates exact output and bounds redacted Activity',
    run: async () => {
      let stamp = 100; const lines = [];
      const log = createHandoffBridgeLog({ logger: { info: line => lines.push(line) }, now: () => ++stamp });
      log.record('tool_call', { ms: 7, outcome: 'served', tool: 'get' });
      assert(lines[0] === '[HandoffBridge] tool_call tool=get outcome=served ms=7', 'app logger output must use the exact closed record format and field order');
      assert(JSON.stringify(log.getRecent()) === JSON.stringify([{ kind: 'get-served', at: 101, outcome: 'served' }]) && log.getVersion() === 1,
        'a safe credential record becomes one redacted Activity item and increments its monotonic version');
      let threw = false;
      try { log.record('tool_call', { tool: 'get', outcome: 'secret prompt with spaces', ms: 8 }); } catch { threw = true; }
      assert(threw && lines.length === 1 && log.getRecent().length === 1 && log.getVersion() === 1,
        'unsafe fields must be rejected before either the app logger or Activity ring changes');
      log.record('worker_pool_started', { workers: 10, recommended: 10, queued: 184 });
      log.record('worker_pool_expanded', { workers: 10, recommended: 10, queued: 184, added: 4 });
      assert(lines.includes('[HandoffBridge] worker_pool_started workers=10 recommended=10 queued=184')
        && lines.includes('[HandoffBridge] worker_pool_expanded workers=10 recommended=10 queued=184 added=4'),
      'FULL-report main logs retain closed aggregate worker-pool planning and expansion evidence');
      for (let index = 0; index < 205; index += 1) log.record('pause', { cause: 'user' });
      const activity = log.getRecent();
      assert(activity.length === 200 && log.getVersion() === 206 && activity.every(item => item.kind === 'paused' && item.outcome === 'paused'),
        'Activity retains only its newest 200 safe projections while its version never wraps with the ring');

      let failPersistence = false; const persistLines = [];
      const engine = createHandoffEngine({
        source: source().api,
        store: { saveLanes: async () => !failPersistence },
        logger: createHandoffBridgeLog({ logger: { info: line => persistLines.push(line) }, now: () => stamp }),
      });
      assert((await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] })).ok, 'fixture lane must persist before its injected failure');
      failPersistence = true;
      assert((await engine.hold(JOB_A)).code === 'persist_failed', 'a failed lane write must fail closed');
      assert(persistLines.includes('[HandoffBridge] persist_failed code=persist_failed store=lanes'),
        'engine persistence failures use only the frozen persist_failed field schema');
    },
  },
  {
    name: 'handoff bridge: engine: lifecycle audit events remain allow-listed and redacted',
    run: async () => {
      const emitted = [];
      const engine = createHandoffEngine({
        source: source().api,
        audit: { append: (event, fields) => { emitted.push({ event, fields }); return Promise.resolve(true); } },
      });
      assert((await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] })).ok, 'release must succeed');
      assert((await engine.pause('manual')).ok && (await engine.resume({})).ok, 'bridge pause and resume must succeed');
      assert((await engine.unrelease(JOB_A)).ok, 'unrelease must succeed');
      for (const event of ['pause', 'resume', 'release', 'unrelease']) {
        assert(SECURITY_AUDIT_EVENTS.includes(event), `${event} must be a security audit event`);
        const record = emitted.find(item => item.event === event);
        assert(record && makeAuditLine({ at: 1, event, fields: record.fields }).ev === event, `${event} must pass the audit boundary`);
      }
      let threw = false;
      try { makeAuditLine({ event: 'release', fields: { jobId: JOB_A } }); } catch { threw = true; }
      assert(threw, 'audit lines must reject raw job identifiers');
    },
  },
  {
    name: 'handoff bridge: engine: preflight rejects all empty and non-object envelopes',
    run: () => {
      const lane = createApplicationLane({ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, handoff: handoff() });
      for (const value of ['', '   ', '{}', '[]', 'null', '"text"', 'x'.repeat(63)]) assert(classifySubmission({ response: value, lane }) === 'junk', `must be junk: ${value.slice(0, 8)}`);
    },
  },
  {
    name: 'handoff bridge: engine: preflight rejects every missing application envelope key',
    run: () => {
      const lane = createApplicationLane({ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, handoff: handoff() });
      for (const missing of ['jobId', 'stage', 'handoffCode']) {
        const value = { jobId: JOB_A, stage: 'resume', handoffCode: 'HANDOFF-A' }; delete value[missing];
        assert(classifySubmission({ response: JSON.stringify(value), lane }) === 'junk', `${missing} is required`);
      }
    },
  },
  {
    name: 'handoff bridge: engine: preflight identifies parsed and regex-extracted foreign jobs',
    run: () => {
      const lane = createApplicationLane({ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, handoff: handoff() });
      assert(classifySubmission({ response: JSON.stringify({ jobId: JOB_B, stage: 'resume', handoffCode: 'HANDOFF-A' }), lane }) === 'misrouted', 'foreign parsed job must misroute');
      assert(classifySubmission({ response: `{"jobId":"${JOB_B}", ${'broken '.repeat(12)}`, lane }) === 'misrouted', 'foreign regex job must misroute');
      assert(extractPasteEnvelopeIdentity(`{"jobId":"${JOB_B}",`).jobId === JOB_B, 'identity extraction must remain parser-independent');
    },
  },
  {
    name: 'handoff bridge: engine: preflight distinguishes stage supersession from code routing',
    run: () => {
      const lane = createApplicationLane({ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, handoff: handoff({ stage: 'review' }) });
      assert(classifySubmission({ response: JSON.stringify({ jobId: JOB_A, stage: 'resume', handoffCode: 'HANDOFF-A' }), lane }) === 'superseded', 'wrong stage must supersede');
    },
  },
  {
    name: 'handoff bridge: engine: preflight accepts large syntax-broken output and caps bytes not characters',
    run: () => {
      const lane = createApplicationLane({ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, handoff: handoff() });
      assert(classifySubmission({ response: `{${'x'.repeat(30 * 1024)}`, lane }) === 'pass', 'large broken model output must reach app validator');
      assert(Buffer.byteLength('λ'.repeat(600_000), 'utf8') > MAX_RESPONSE_BYTES, 'fixture must exceed byte cap');
      assert(stringifySubmission({ value: 'x' }).ok, 'objects normalize only through JSON');
    },
  },
  {
    name: 'handoff bridge: engine: imported paste identity helpers and local drift pins remain stable',
    run: () => {
      assert(DUPLICATE_RESPONSE_MIN_CHARS === 400, 'duplicate threshold must be imported and pinned');
      assert(typeof normalizePastedResponse === 'function' && typeof responseFingerprint === 'function', 'identity helpers must be imported');
      assert(APPLICATION_FENCE_RE.test('```json\n{}\n```'), 'fence regex drifted');
      assert(MAX_RESPONSE_BYTES === 1_000_000, 'frozen byte cap drifted');
      assert(trimHandoffCode(' "`HANDOFF-A`" ') === 'HANDOFF-A', 'code trim must remove only edge wrappers');
      assert(trimHandoffCode(`x${'a'.repeat(513)}`).length === 514, 'oversized code must not normalize around cap');
    },
  },
  {
    name: 'handoff bridge: engine: duplicate fingerprints block only a different accepted lane',
    run: () => {
      const first = createApplicationLane({ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, handoff: handoff() });
      const second = createApplicationLane({ ord: 2, jobId: JOB_B, canvasFilePath: PATH_B, handoff: handoff({ jobId: JOB_B, code: 'HANDOFF-B' }) });
      const text = JSON.stringify({ jobId: JOB_B, stage: 'resume', handoffCode: 'HANDOFF-B', text: 'z'.repeat(500) });
      second.acceptedFingerprints.add(responseFingerprint(text));
      assert(classifySubmission({ response: text, lane: second, lanes: [first, second] }) === 'pass', 'same lane replay belongs to app routing');
      assert(classifySubmission({ response: text, lane: first, lanes: [first, second] }) === 'misrouted', 'different accepted lane must block fingerprint');
    },
  },
  {
    name: 'handoff bridge: engine: correction framing clips paths quoted spans and item volume safely',
    run: () => {
      const firstQuoted = 'q'.repeat(500);
      const secondQuoted = 's'.repeat(201);
      const quoted = `bad "${firstQuoted}" and '${secondQuoted}' at /Users/Marisol/private.json`;
      const framed = frameCorrections(Array(32).fill(quoted));
      assert(framed.validationErrors.length === 30, 'corrections cap at 30');
      assert(framed.validationErrors[0].includes('…') && !framed.validationErrors[0].includes('/Users/Marisol'), 'quoted spans and paths must scrub');
      assert(framed.correctionPrompt.includes(`"${firstQuoted.slice(0, 200)}…"`) && framed.correctionPrompt.includes(`'${secondQuoted.slice(0, 200)}…'`),
        'generated correction prompts must clip every overlong quoted span');
      const supplied = frameCorrections(['fix it'], quoted);
      assert(supplied.correctionPrompt.includes(`"${firstQuoted.slice(0, 200)}…"`) && supplied.correctionPrompt.includes(`'${secondQuoted.slice(0, 200)}…'`)
        && !supplied.correctionPrompt.includes(firstQuoted) && !supplied.correctionPrompt.includes(secondQuoted),
      'supplied app correction prompts must receive the same quoted-span clip after path scrubbing');
      assert(supplied.correctionPrompt.split(REJECTED_CAUTION).length === 2,
        'a supplied correction prompt must carry the fixed untrusted-evidence caution exactly once');
      const duplicateCaution = frameCorrections(['fix it'], `${REJECTED_CAUTION}\nRepair the field.\n${REJECTED_CAUTION}`);
      assert(duplicateCaution.correctionPrompt.split(REJECTED_CAUTION).length === 2,
        'an app-supplied caution must be de-duplicated rather than amplified');
      assert(clipCorrectionItem('x'.repeat(1600)).length === 1500, 'long correction must use exact 1500 clip');
    },
  },
  {
    name: 'handoff bridge: engine: rejected framing always includes fixed caution and paired correction prompt',
    run: () => {
      const body = makeRejectedBody({ handoffCode: 'HANDOFF-A', validationErrors: ['fix it'] });
      assert(body.caution === REJECTED_CAUTION && body.note === RESULT_NOTES.rejected, 'caution and measured note must be separate fixed fields');
      assert(Array.isArray(body.validationErrors) && typeof body.correctionPrompt === 'string', 'errors never travel without correction prompt');
      const empty = makeRejectedBody({ handoffCode: 'HANDOFF-A', validationErrors: [] });
      assert(!Object.hasOwn(empty, 'validationErrors') && !Object.hasOwn(empty, 'correctionPrompt'), 'empty corrections must not fabricate partial frame');
    },
  },
  {
    name: 'handoff bridge: engine: served application bodies use frozen directive wording',
    run: () => {
      const lane = createApplicationLane({ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, handoff: handoff() });
      const body = makeServedBody({ lane, remaining: { ready: 0, working: 0, needsYou: 0 } });
      assert(body.instructions === APPLICATION_INSTRUCTIONS
        && body.instructions.includes('submit_handoff')
        && body.instructions.includes('second validation pass')
        && body.instructions.includes('every requested section and shared field')
        && body.instructions.includes('every correction is satisfied'), 'application instructions must require complete second-pass validation before submission');
    },
  },
  {
    name: 'handoff bridge: engine: lane phases codes tombstones and human advance are bounded',
    run: () => {
      const lane = createApplicationLane({ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, handoff: handoff(), codeGuard });
      assert(lane.phase === 'awaiting' && isHumanAdvance(lane, 'HUMAN-CODE', codeGuard), 'fresh human code must be recognized');
      lane.issuedCodes.set(codeGuard.key('OLD-CODE'), codeGuard.digest('OLD-CODE')); assert(!isHumanAdvance(lane, 'OLD-CODE', codeGuard), 'bridge-issued codes are not human advance');
      holdLane(lane, 'user_hold', 1); assert(lane.phase === 'held' && lane.heldFrom === 'awaiting', 'hold must retain resumable phase');
      resumeLane(lane); assert(lane.phase === 'awaiting' && lane.reason === null, 'resume must restore phase');
      const tombstones = new Map(); tombstoneCode(tombstones, 'HANDOFF-A', 'accepted', {}, undefined, codeGuard); assert(tombstones.get(codeGuard.key('HANDOFF-A')).reason === 'accepted', 'tombstone must retain route');
    },
  },
  {
    name: 'handoff bridge: engine: code guard uses fixed digests for wrapped, case, and same-prefix routes',
    run: () => {
      const digest = codeGuard.digest('HANDOFF-ABCDEF');
      assert(Buffer.isBuffer(digest) && digest.length === 32, 'routing identity must be a fixed SHA-256 digest');
      assert(codeGuard.equal(' \u201c`HANDOFF-ABCDEF`\u201d ', 'HANDOFF-ABCDEF'), 'ASCII and curly edge wrappers canonicalize before comparison');
      const multibyteAtCharacterCap = `\u201c${'\u00e9'.repeat(510)}\u201d`;
      const oversized = `\u201c${'x'.repeat(511)}\u201d`;
      assert(trimHandoffCode(multibyteAtCharacterCap) === '\u00e9'.repeat(510) && trimHandoffCode(oversized) === oversized && !codeGuard.equal(oversized, 'x'.repeat(511)), 'the 512-character cap normalizes multibyte input while an over-cap wrapper remains exact before validation');
      assert(!codeGuard.equal('HANDOFF-ABCDEF', 'HANDOFF-ABCDEG') && !codeGuard.equal('HANDOFF-ABCDEF', 'handoff-abcdef'), 'same-prefix and lower-case application codes remain distinct');
      const lane = createApplicationLane({ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, handoff: handoff({ code: 'HANDOFF-ABCDEF' }), codeGuard });
      const direct = lane.issuedCodes.get(codeGuard.key('HANDOFF-ABCDEF'));
      assert(codeGuard.sameDigest(digest, direct) && !codeGuard.sameDigest(codeGuard.digest('HANDOFF-ABCDEG'), direct), 'issued-code Map entries retain digest evidence instead of raw codes');
    },
  },
  {
    name: 'handoff bridge: engine: wrapped app code routes, while lower-case and same-prefix inputs do not',
    run: async () => {
      const state = await served({ sourceOverrides: { read: async () => ({ kind: 'open', handoff: handoff({ code: 'HANDOFF-ABCDEF' }) }) } });
      const wrongCase = await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: 'handoff-abcdef', response: answer({ code: 'HANDOFF-ABCDEF' }) });
      const samePrefix = await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: 'HANDOFF-ABCDEG', response: answer({ code: 'HANDOFF-ABCDEF' }) });
      const accepted = await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: ' `HANDOFF-ABCDEF` ', response: answer({ code: 'HANDOFF-ABCDEF' }) });
      assert(wrongCase.status === 'unknown_handoff' && samePrefix.status === 'unknown_handoff' && accepted.status === 'accepted', 'only the wrapped exact application route may reach the source');
    },
  },
  {
    name: 'handoff bridge: engine: chat keys are fixed-length and lanes count serving states',
    run: () => {
      const key = makeChatKey(() => Buffer.alloc(26, 0));
      assert(key.length === 26 && /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]+$/.test(key), 'chat key alphabet and length must be frozen');
      const upperBucket = makeChatKey(() => Buffer.alloc(26, 255));
      assert(upperBucket === 'Z'.repeat(26), 'chat-key generation maps the upper byte bucket to the final alphabet symbol without modulo bias');
      const lanes = [createApplicationLane({ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, handoff: handoff() }), createApplicationLane({ ord: 2, jobId: JOB_B, canvasFilePath: PATH_B })];
      holdLane(lanes[1], 'user_hold'); assert(JSON.stringify(remainingCounts(lanes)) === JSON.stringify({ ready: 1, working: 0, needsYou: 1 }), 'queue counts must hide identifiers');
    },
  },
  {
    name: 'handoff bridge: engine: get is session fenced and a new epoch is memory-only',
    run: async () => {
      const { engine, session } = await started();
      assert((await engine.get({ session: 'wrong', linkId: LINK })).status === 'unauthorized', 'live wrong key must be uniform unauthorized');
      assert((await engine.get({ session, linkId: 'other-link' })).status === 'session_ended', 'same key under another link must not authenticate: the relink ended that chat');
      assert(engine.snapshot().chat.state === 'none' && !JSON.stringify(engine.snapshot()).includes(session), 'the relinked chat is gone from status, and snapshot must not contain chat key');
    },
  },
  {
    name: 'handoff bridge: engine: status snapshot projects only the closed queue and chat vocabulary',
    run: async () => {
      const state = await served();
      const snapshot = state.engine.snapshot();
      const job = snapshot.queue.jobs[0];
      assert(job.jobId === JOB_A && job.phase === 'awaiting' && job.stage === 'resume' && job.servedToChat === 1 && Number.isSafeInteger(job.changedAt), 'controller status needs safe canonical lane facts');
      assert(snapshot.chat.state === 'working' && snapshot.chat.calls === 1 && snapshot.chat.outstanding?.stage === 'resume' && snapshot.chat.outstanding?.kind === 'application', 'chat status must expose only closed observability fields');
      const text = JSON.stringify(snapshot);
      assert(!text.includes(state.session) && !text.includes(PATH_A) && !text.includes('HANDOFF-A') && !text.includes('Synthetic application prompt'), 'engine status must never expose secret or content-bearing lane fields');
    },
  },
  {
    name: 'handoff bridge: engine: scoring status totals discovered hubs but counts only served work as with-chat',
    run: () => {
      const keyA = 'a'.repeat(64); const keyB = 'b'.repeat(64);
      const engine = createHandoffEngine({
        source: source().api,
        sources: { application: source().api, push: { get: async () => ({ status: 'queue_empty' }), submit: async () => ({ status: 'unknown_handoff' }), status: () => ({ served: 1, held: 2, claimed: ['22222222-2222-4222-8222-222222222222', 'unsafe-claim'], discovered: [{ key: keyA, pending: 2, tasks: [{ task: 'job-scoring', pending: 2 }] }, { key: keyB, pending: 3, tasks: [{ task: 'job-scoring', pending: 3 }, { task: 'job-role-screen-batch', pending: 3 }] }] }) } },
      });
      const scoring = engine.snapshot().queue.scoring;
      assert(scoring.pending === 5 && scoring.withChat === 1 && scoring.tasks.find(task => task.task === 'job-scoring')?.pending === 5
        && scoring.tasks.find(task => task.task === 'job-role-screen-batch')?.pending === 3,
      'discovery and served counts must not be conflated, and every closed bridgeable task remains visible');
      const ownership = engine.snapshot().queue.push;
      assert(ownership.served === 1 && ownership.held === 2 && ownership.claimed.length === 1
        && ownership.claimed[0] === '22222222-2222-4222-8222-222222222222',
      'only aggregate push ownership and opaque UUID-shaped claims survive the engine status projection');
    },
  },
  {
    name: 'handoff bridge: engine: absent and retired epochs return session ended without burst accounting',
    run: async () => {
      const fake = source(); const clock = createFakeClock(); const engine = createHandoffEngine({ source: fake.api, now: clock.now, timers: clock });
      for (let index = 0; index < 7; index++) assert((await engine.get({ session: `old-${index}`, linkId: LINK })).status === 'session_ended', 'no epoch must not count stale key');
      const chat = await engine.newChat({ linkId: LINK }); await engine.continueChat({ linkId: LINK });
      assert((await engine.get({ session: chat.sessionCode, linkId: LINK })).status === 'session_ended', 'rotation must retire old epoch');
      assert((await engine.get({ session: chat.sessionCode, linkId: 'other-link' })).status === 'session_ended',
        'a retired epoch digest is link-free: an ended key reads as ended under any link');
      assert(engine.snapshot().pauseCause === null, 'old/no epoch requests cannot cause anomaly pause');
    },
  },
  {
    name: 'handoff bridge: engine: twenty unrecognised live keys never pause the engine, the next valid call is served, and the observations are counted',
    run: async () => {
      const { engine, session, clock } = await started();
      for (let index = 0; index < 20; index++) assert((await engine.get({ session: `wrong-${index}`, linkId: LINK })).status === 'unauthorized', 'wrong live key must be unauthorized');
      const snapshot = engine.snapshot();
      assert(snapshot.paused === false && snapshot.pauseCause === null && snapshot.counts.pauses === 0, 'unrecognised keys never pause the engine');
      assert(snapshot.keys.unrecognisedRecent === 20 && snapshot.keys.unrecognisedWindowMinutes === 10 && Number.isFinite(snapshot.keys.lastUnrecognisedAt) && snapshot.keys.ended === 0,
        `the snapshot counts them for diagnostics only: ${JSON.stringify(snapshot.keys)}`);
      assert((await engine.get({ session, linkId: LINK })).status === 'served', 'the next valid call is served');
      clock.advance(11 * 60_000);
      const later = engine.snapshot().keys;
      assert(later.unrecognisedRecent === 0 && later.lastUnrecognisedAt === snapshot.keys.lastUnrecognisedAt, 'the window forgets old keys but the last time stays observable');
      assert(!JSON.stringify(engine.snapshot()).includes('wrong-'), 'no key text reaches the snapshot');
    },
  },
  {
    name: 'handoff bridge: engine: released lanes schedule depth-first and get is idempotent',
    run: async () => {
      const { engine, session, fake } = await started(); await engine.release({ jobs: [{ jobId: JOB_B, canvasFilePath: PATH_B }] });
      const first = await engine.get({ session, linkId: LINK }); const second = await engine.get({ session, linkId: LINK });
      assert(first.status === 'served' && second.status === 'served' && first.handoffCode === second.handoffCode, 'outstanding lane must re-serve before later release');
      assert(fake.calls.read === 1, 'idempotent serve must not re-read prompt');
    },
  },
  {
    name: 'handoff bridge: engine: accepted submission completes a lane and leaves no stale prompt',
    run: async () => {
      const { engine, session, result } = await served();
      const reply = await engine.submit({ session, linkId: LINK, handoffCode: result.handoffCode, response: answer({ code: result.handoffCode, stage: result.stage }) });
      assert(reply.status === 'accepted' && reply.jobComplete === true, 'completion acceptance must not invent next prompt');
      assert((await engine.get({ session, linkId: LINK })).status === 'waiting', 'host lane must not re-serve stale prompt');
    },
  },
  {
    name: 'handoff bridge: engine: accepted completed submit notifies its owner once and contains callback throws',
    run: async () => {
      const changes = [];
      const state = await served({ engineOptions: { onJobChanged: payload => { changes.push(payload); throw new Error('advisory callback failure'); } } });
      const result = await state.engine.submit({
        session: state.session,
        linkId: LINK,
        handoffCode: state.result.handoffCode,
        response: answer({ code: state.result.handoffCode, stage: state.result.stage }),
      });
      assert(result.status === 'accepted' && result.jobComplete === true, 'callback failure must not change completed acceptance');
      assert(changes.length === 1 && JSON.stringify(changes[0]) === JSON.stringify({ jobId: JOB_A, canvasFilePath: PATH_A }), 'completed bridge mutation must notify its owning UI once with the canonical job payload');
    },
  },
  {
    name: 'handoff bridge: engine: accepted successor submit notifies its owner once after mutation',
    run: async () => {
      const changes = [];
      const state = await served({
        sourceOverrides: { submit: async () => ({ kind: 'accepted', completed: false, handoff: handoff({ code: 'HANDOFF-NEXT', revision: 2 }) }) },
        engineOptions: { onJobChanged: payload => changes.push(payload) },
      });
      const result = await state.engine.submit({
        session: state.session,
        linkId: LINK,
        handoffCode: state.result.handoffCode,
        response: answer({ code: state.result.handoffCode, stage: state.result.stage }),
      });
      assert(result.status === 'accepted' && result.jobComplete === false, 'successor acceptance must remain successful');
      assert(changes.length === 1 && JSON.stringify(changes[0]) === JSON.stringify({ jobId: JOB_A, canvasFilePath: PATH_A }), 'successor bridge mutation must notify its owning UI once with the canonical job payload');
    },
  },
  {
    name: 'handoff bridge: engine: observations, rejection, errors, held lanes, and human advance never notify owners',
    run: async () => {
      const observed = [];
      const observation = await started({
        sourceOverrides: { read: async () => ({ kind: 'host' }), status: async () => ({ kind: 'host' }) },
        engineOptions: { onJobChanged: payload => observed.push(payload) },
      });
      await observation.engine.get({ session: observation.session, linkId: LINK });
      observation.clock.advance(CONSTANTS.HOST_POLL_MS);
      await observation.engine.get({ session: observation.session, linkId: LINK });
      assert(observed.length === 0, 'source reads and host status observations must not notify an owner');

      const rejectedChanges = [];
      const rejected = await served({
        sourceOverrides: { submit: async () => ({ kind: 'rejected', handoff: handoff(), validationErrors: ['synthetic invalid'] }) },
        engineOptions: { onJobChanged: payload => rejectedChanges.push(payload) },
      });
      await rejected.engine.submit({ session: rejected.session, linkId: LINK, handoffCode: rejected.result.handoffCode, response: answer({ code: rejected.result.handoffCode, stage: rejected.result.stage }) });
      assert(rejectedChanges.length === 0, 'rejected submits must not notify an owner');

      const erroredChanges = [];
      const errored = await served({
        sourceOverrides: { submit: async () => ({ kind: 'threw', code: 'LOCAL_AI_JOB_INTEGRITY' }) },
        engineOptions: { onJobChanged: payload => erroredChanges.push(payload) },
      });
      await errored.engine.submit({ session: errored.session, linkId: LINK, handoffCode: errored.result.handoffCode, response: answer({ code: errored.result.handoffCode, stage: errored.result.stage }) });
      await errored.engine.hold(JOB_A);
      assert(erroredChanges.length === 0, 'error and held transitions must not notify an owner');

      const humanChanges = [];
      let reads = 0;
      const humanAdvance = await served({
        sourceOverrides: { read: async () => ({ kind: 'open', handoff: handoff({ code: ++reads === 1 ? 'HANDOFF-A' : 'HUMAN-NEW' }) }) },
        engineOptions: { onJobChanged: payload => humanChanges.push(payload) },
      });
      humanAdvance.engine.hint({ jobId: JOB_A });
      await humanAdvance.engine.get({ session: humanAdvance.session, linkId: LINK });
      assert(humanChanges.length === 0, 'human advance holds must not notify an owner');
    },
  },
  {
    name: 'handoff bridge: engine: verdict cache attaches concurrent submits with one source call',
    run: async () => {
      const pending = deferred(); let submits = 0;
      const state = await served({ sourceOverrides: { submit: async () => { submits++; return pending.promise; } } });
      const body = answer({ code: state.result.handoffCode, stage: state.result.stage });
      const one = state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: body });
      const two = state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: body });
      await Promise.resolve(); pending.resolve({ kind: 'accepted', completed: true }); const [left, right] = await Promise.all([one, two]);
      assert(left.status === 'accepted' && right.status === 'accepted' && submits === 1, 'identical verdicts must attach to one app submit');
    },
  },
  {
    name: 'handoff bridge: engine: accepted and rotated tombstones distinguish duplicate and superseded',
    run: async () => {
      const state = await served(); const body = answer({ code: state.result.handoffCode, stage: state.result.stage });
      await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: body });
      assert((await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: body })).status === 'duplicate', 'accepted retired code must take duplicate route');
      const rotated = await served({ sourceOverrides: { submit: async () => ({ kind: 'rejected', handoff: handoff({ code: 'HANDOFF-ROTATED' }), validationErrors: ['fix'] }) } });
      const rejected = await rotated.engine.submit({ session: rotated.session, linkId: LINK, handoffCode: rotated.result.handoffCode, response: answer({ code: rotated.result.handoffCode, stage: rotated.result.stage }) });
      assert(rejected.status === 'rejected' && (await rotated.engine.submit({ session: rotated.session, linkId: LINK, handoffCode: rotated.result.handoffCode, response: '{}' })).status === 'superseded', 'rotated stale code must supersede');
    },
  },
  {
    name: 'handoff bridge: engine: codes route solely through memory index and never envelope fallback',
    run: async () => {
      const state = await served();
      const response = JSON.stringify({ jobId: JOB_A, stage: 'resume', handoffCode: 'NOT-IN-INDEX', text: 'x'.repeat(100) });
      const result = await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: 'NOT-IN-INDEX', response });
      assert(result.status === 'unknown_handoff' && state.fake.calls.submit === 0, 'real lane identity cannot bypass missing code index');
    },
  },
  {
    name: 'handoff bridge: engine: same-code rejected verdict replays from cache without second source call',
    run: async () => {
      let submits = 0;
      const state = await served({ sourceOverrides: { submit: async () => { submits++; return { kind: 'rejected', handoff: handoff(), validationErrors: ['synthetic invalid'] }; } } });
      const response = answer({ code: state.result.handoffCode, stage: state.result.stage });
      const first = await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response });
      const second = await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response });
      assert(first.status === 'rejected' && second.status === 'rejected' && submits === 1, 'same-code rejected verdict must replay without a second app call');
    },
  },
  {
    name: 'handoff bridge: engine: response byte cap and junk cap fail before source submission',
    run: async () => {
      const state = await served(); assert((await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: 'λ'.repeat(600_000) })).status === 'too_large', 'byte overage must reject');
      for (let index = 0; index < 5; index++) await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: '{}' });
      assert((await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: answer({ code: state.result.handoffCode, stage: state.result.stage }) })).status === 'held', 'five junk responses must cap lane');
      assert(state.fake.calls.submit === 0, 'invalid submissions never call source');
    },
  },
  {
    name: 'handoff bridge: engine: validation corrections continue past six rejections and can accept',
    run: async () => {
      let submits = 0;
      const persisted = [];
      const state = await served({ sourceOverrides: {
        submit: async () => {
          submits++;
          return submits <= 7
            ? { kind: 'rejected', handoff: handoff(), validationErrors: ['synthetic invalid'] }
            : { kind: 'accepted', completed: true };
        },
      }, engineOptions: { store: { saveLanes: async lanes => { persisted.push(lanes); return true; } } } });
      for (let index = 0; index < 7; index++) {
        const rejected = await state.engine.submit({
          session: state.session, linkId: LINK, handoffCode: state.result.handoffCode,
          response: answer({ code: state.result.handoffCode, stage: state.result.stage, extra: { n: index } }),
        });
        assert(rejected.status === 'rejected', `correction ${index + 1} must remain available, not held`);
      }
      const lane = state.engine.snapshot().queue.jobs[0];
      const savedLane = persisted.at(-1)?.[0];
      assert(lane.phase === 'awaiting' && savedLane?.counters?.rejections === 7,
        'more than six validation rejections must remain awaiting with its counter persisted for telemetry');
      const accepted = await state.engine.submit({
        session: state.session, linkId: LINK, handoffCode: state.result.handoffCode,
        response: answer({ code: state.result.handoffCode, stage: state.result.stage, extra: { n: 7 } }),
      });
      assert(accepted.status === 'accepted' && accepted.jobComplete === true,
        'a later corrected answer must still reach application acceptance');
    },
  },
  {
    name: 'handoff bridge: engine: human advance is held automatically instead of overwritten',
    run: async () => {
      let reads = 0;
      const state = await served({ sourceOverrides: { read: async () => { reads++; return { kind: 'open', handoff: handoff({ code: reads === 1 ? 'HANDOFF-A' : 'HUMAN-NEW' }) }; } } });
      state.engine.hint({ jobId: JOB_A }); state.clock.advance(CONSTANTS.HINT_MIN_INTERVAL_MS); await Promise.resolve();
      const next = await state.engine.get({ session: state.session, linkId: LINK });
      assert(next.status === 'paused' && next.reason === 'needs_user', 'unissued human code must require review');
    },
  },
  {
    name: 'handoff bridge: engine: soft job cap sessions full only when another lane is ready',
    run: async () => {
      // 'done' is a saved job: it is only reported once the job has been answered and finished.
      let finished = false;
      const { engine, session, clock } = await started({ sourceOverrides: { status: async () => ({ kind: finished ? 'done' : 'host' }) }, engineOptions: { limits: { jobsPerChat: 1 } } }); await engine.release({ jobs: [{ jobId: JOB_B, canvasFilePath: PATH_B }] });
      const first = await engine.get({ session, linkId: LINK }); await engine.submit({ session, linkId: LINK, handoffCode: first.handoffCode, response: answer({ code: first.handoffCode, stage: first.stage }) }); finished = true;
      clock.advance(CONSTANTS.HOST_POLL_MS);
      await engine.get({ session, linkId: LINK });
      assert((await engine.get({ session, linkId: LINK })).status === 'session_full', 'next ready lane must observe per-chat cap');
    },
  },
  {
    name: 'handoff bridge: engine: an explicitly enabled hard byte budget stops the next handoff after it is spent',
    run: async () => {
      const { engine, session } = await started({ engineOptions: { limits: { epochHardBytes: 1 } } });
      assert((await engine.get({ session, linkId: LINK })).status === 'served', 'the first prompt spends the explicitly enabled byte budget');
      assert((await engine.get({ session, linkId: LINK })).status === 'session_full', 'the explicit hard byte budget must fence the next handoff');
    },
  },
  {
    name: 'handoff bridge: engine: the default zero byte budget never rolls a healthy chat over',
    run: async () => {
      let reads = 0;
      const push = {
        get: async () => ({
          status: 'served',
          handoffCode: `PUSH-ZERO-BUDGET-${++reads}`,
          task: 'job-scoring',
          prompt: 'Synthetic scoring prompt.',
          // Cross the old invisible 900 KB fence in one otherwise valid
          // response. A second GET proves zero is disabled rather than a
          // literal zero-byte ceiling or an implicit legacy default.
          promptBytes: 900_001,
          remaining: { ready: 1, working: 0, needsYou: 0 },
        }),
        submit: async () => ({ status: 'unknown_handoff' }),
      };
      const engine = createHandoffEngine({
        sources: { application: source().api, push },
        scope: { applications: false, scoring: true, marketplace: false },
        limits: { epochSoftBytes: 0, epochHardBytes: 0 },
        holdMs: 0,
      });
      const chat = await engine.newChat({ linkId: LINK });
      const first = await engine.get({ session: chat.sessionCode, linkId: LINK });
      const second = await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(first.status === 'served' && second.status === 'served' && reads === 2
        && engine.snapshot().chat.bytesServed > 900_000,
      'a zero budget must leave rollover off after traffic exceeds the retired default');
      await engine.close();
    },
  },
  {
    name: 'handoff bridge: engine: an accepted application successor cannot bypass the hard byte budget',
    run: async () => {
      const response = answer({ extra: { text: 'x'.repeat(12_000) } });
      let reads = 0;
      const state = await served({
        sourceOverrides: {
          read: async () => ({
            kind: 'open',
            handoff: handoff({
              code: ++reads === 1 ? 'HANDOFF-A' : 'HANDOFF-APPLICATION-RESUMED',
              revision: reads,
              prompt: 'Synthetic resumed application prompt.',
            }),
          }),
          submit: async () => ({
            kind: 'accepted',
            completed: false,
            handoff: handoff({ code: 'HANDOFF-APPLICATION-RESUMED', revision: 2, prompt: 'Synthetic resumed application prompt.' }),
          }),
        },
        engineOptions: { limits: { epochHardBytes: 10_000 } },
      });
      const accepted = await state.engine.submit({
        session: state.session,
        linkId: LINK,
        handoffCode: state.result.handoffCode,
        response,
      });
      assert(accepted.status === 'accepted' && accepted.next?.status === 'session_full',
        'an accepted application commit may finish, but its inline successor must hit the hard budget fence');
      const full = state.engine.snapshot();
      assert(reads === 1 && full.counts.getServed === 1 && full.chat.bytesReceived >= 12_000,
        'the fenced inline successor must not read or charge a second application prompt');
      assert((await state.engine.get({ session: state.session, linkId: LINK })).status === 'session_full',
        'the original full chat must not serve the successor on a later poll');
      const resumed = await state.engine.newChat({ linkId: LINK });
      const next = await state.engine.get({ session: resumed.sessionCode, linkId: LINK });
      assert(next.status === 'served' && next.kind === 'application',
        'a replacement chat must be able to resume application work with a fresh epoch budget');
    },
  },
  {
    name: 'handoff bridge: engine: an accepted push successor cannot bypass the hard byte budget',
    run: async () => {
      let gets = 0; let successors = 0;
      const push = {
        async get() {
          gets++;
          return {
            status: 'served',
            handoffCode: gets === 1 ? 'PUSH-HARD-BUDGET-A' : 'PUSH-HARD-BUDGET-RESUMED',
            task: 'job-scoring',
            prompt: 'Synthetic scoring prompt.',
            promptBytes: 1,
            remaining: { ready: 0, working: 0, needsYou: 0 },
          };
        },
        async submit() { return { status: 'accepted' }; },
        async nextAfterAccept() {
          successors++;
          return {
            status: 'served',
            handoffCode: 'PUSH-HARD-BUDGET-SUCCESSOR',
            task: 'job-scoring',
            prompt: 'Synthetic successor scoring prompt.',
            promptBytes: 1,
            remaining: { ready: 0, working: 0, needsYou: 0 },
          };
        },
      };
      const engine = createHandoffEngine({
        sources: { application: source().api, push },
        scope: { applications: false, scoring: true },
        holdMs: 0,
        limits: { epochHardBytes: 100 },
      });
      const chat = await engine.newChat({ linkId: LINK });
      const first = await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(first.status === 'served' && first.kind === 'push', 'fixture must first serve the synthetic scoring handoff');
      const accepted = await engine.submit({
        session: chat.sessionCode,
        linkId: LINK,
        handoffCode: first.handoffCode,
        response: 'y'.repeat(128),
      });
      assert(accepted.status === 'accepted' && accepted.next?.status === 'session_full',
        'an accepted push commit may finish, but its inline successor must hit the hard budget fence');
      const full = engine.snapshot();
      assert(gets === 1 && successors === 1 && full.counts.getServed === 1 && full.chat.bytesServed === 1 && full.chat.bytesReceived === 128,
        'the fenced inline successor must not be charged or counted as a second served push prompt');
      assert((await engine.get({ session: chat.sessionCode, linkId: LINK })).status === 'session_full',
        'the original full chat must not serve the push successor on a later poll');
      const resumed = await engine.newChat({ linkId: LINK });
      const next = await engine.get({ session: resumed.sessionCode, linkId: LINK });
      assert(next.status === 'served' && next.handoffCode === 'PUSH-HARD-BUDGET-RESUMED' && gets === 2,
        'a replacement chat must be able to resume scoring work with a fresh epoch budget');
    },
  },
  {
    name: 'handoff bridge: engine: idle pause measures human actions rather than authenticated polling',
    run: async () => {
      const state = await served({ engineOptions: { limits: { idlePauseMinutes: 1 } } }); state.clock.advance(61_000);
      const paused = await state.engine.get({ session: state.session, linkId: LINK });
      assert(paused.status === 'paused' && paused.reason === 'idle', 'authenticated get must not renew human clock');
      assert((await state.engine.resume({})).ok && (await state.engine.get({ session: state.session, linkId: LINK })).status === 'served', 'one resume lifts pause');
    },
  },
  {
    name: 'handoff bridge: engine: queue empty closes an all-terminal epoch',
    run: async () => {
      // 'done' is a saved job: it is only reported once the job has been answered and finished.
      let finished = false;
      const state = await served({ sourceOverrides: { status: async () => ({ kind: finished ? 'done' : 'host' }) } }); await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: answer({ code: state.result.handoffCode, stage: state.result.stage }) }); finished = true; state.clock.advance(CONSTANTS.HOST_POLL_MS);
      assert((await state.engine.get({ session: state.session, linkId: LINK })).status === 'queue_empty', 'terminal queue must report drain first');
      assert((await state.engine.get({ session: state.session, linkId: LINK })).status === 'session_ended', 'drained epoch closes immediately after empty delivery');
    },
  },
  {
    name: 'handoff bridge: engine: empty publish never closes epoch with held or host work',
    run: async () => {
      const { engine, session } = await started({ sourceOverrides: { read: async () => ({ kind: 'host' }) } });
      assert((await engine.get({ session, linkId: LINK })).status === 'waiting', 'host work is not queue empty');
      await engine.hold(JOB_A); assert((await engine.get({ session, linkId: LINK })).status === 'paused', 'held work is not queue empty');
    },
  },
  {
    name: 'handoff bridge: engine: restart confirm gates exactly first post-restore mint',
    run: async () => {
      const restoredLanes = [{ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, releasedAt: 0, phase: 'unread' }]; let confirms = 0; const fake = source(); const clock = createFakeClock();
      const engine = createHandoffEngine({ source: fake.api, restoredLanes, now: clock.now, timers: clock, confirmRestart: async () => { confirms++; return true; } });
      assert((await engine.newChat({ linkId: LINK })).copied && (await engine.continueChat({ linkId: LINK })).copied && confirms === 1, 'restart confirmation must be once per launch');
    },
  },
  {
    name: 'handoff bridge: engine: overlapping prepared chats reserve distinct ordinals and push epochs',
    run: async () => {
      const epochs = [];
      const push = {
        async get({ epoch }) {
          epochs.push(epoch);
          return { status: 'served', handoffCode: `PUSH-${epoch}`, task: 'job-scoring', prompt: 'Synthetic scoring prompt.', remaining: { ready: 0, working: 0, needsYou: 0 } };
        },
        async submit() { return { status: 'unknown_handoff' }; },
        closeEpoch() {},
      };
      const engine = createHandoffEngine({ sources: { application: source().api, push }, scope: { applications: false, scoring: true }, holdMs: 0 });
      const [first, second] = await Promise.all([
        engine.prepareChat({ linkId: LINK, kind: 'new' }),
        engine.prepareChat({ linkId: LINK, kind: 'continue' }),
      ]);
      assert(first.copied && second.copied && first.chatOrdinal === 1 && second.chatOrdinal === 2,
        'overlapping preparations must reserve unique, monotonically increasing ordinals');
      assert(first.commit() === true, 'the first prepared capability must start epoch one');
      assert((await engine.get({ session: first.sessionCode, linkId: LINK })).status === 'served', 'epoch one must reach the push source');
      assert(second.commit() === true, 'the newer prepared capability must rotate to epoch two');
      assert((await engine.get({ session: second.sessionCode, linkId: LINK })).status === 'served'
        && JSON.stringify(epochs) === JSON.stringify(['epoch-1', 'epoch-2']),
      'separate prepared chats must never alias their push epoch id');
    },
  },
  {
    name: 'handoff bridge: engine: stale prepared commit cannot retire or mutate a newer live push epoch',
    run: async () => {
      const epochs = []; const closed = [];
      const push = {
        async get({ epoch }) {
          epochs.push(epoch);
          return { status: 'served', handoffCode: 'PUSH-ADA-EXAMPLE', task: 'job-scoring', prompt: 'Synthetic Ada scoring prompt.', remaining: { ready: 0, working: 0, needsYou: 0 } };
        },
        async submit() { return { status: 'unknown_handoff' }; },
        closeEpoch(epoch) { closed.push(epoch); },
      };
      const engine = createHandoffEngine({ sources: { application: source().api, push }, scope: { applications: false, scoring: true }, holdMs: 0 });
      const [older, newer] = await Promise.all([engine.prepareChat({ linkId: LINK }), engine.prepareChat({ linkId: LINK })]);
      assert(newer.commit() === true, 'the later prepared capability must be able to commit first');
      assert((await engine.get({ session: newer.sessionCode, linkId: LINK })).status === 'served' && JSON.stringify(epochs) === JSON.stringify(['epoch-2']),
        'the live later preparation must own epoch two');
      assert(older.commit() === false, 'an older prepared capability must refuse an out-of-order commit');
      const afterStale = engine.snapshot();
      assert(afterStale.chat.ordinal === 2 && closed.every(epoch => epoch !== 'epoch-2'),
        'a stale commit must not close or replace the live newer push epoch');
      assert((await engine.get({ session: newer.sessionCode, linkId: LINK })).status === 'served'
        && JSON.stringify(epochs) === JSON.stringify(['epoch-2', 'epoch-2']),
      'the newer session remains live after the refused stale commit');
    },
  },
  {
    name: 'handoff bridge: engine: overlapping restart preparations confirm and persist once',
    run: async () => {
      const confirmation = deferred(); let confirms = 0; let saves = 0;
      const engine = createHandoffEngine({
        source: source().api,
        restoredLanes: [{ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, releasedAt: 0, phase: 'unread' }],
        confirmRestart: async () => { confirms++; return confirmation.promise; },
        store: { saveLanes: async () => { saves++; return true; } },
      });
      const first = engine.prepareChat({ linkId: LINK });
      const second = engine.prepareChat({ linkId: LINK });
      await Promise.resolve();
      assert(confirms === 1 && saves === 0, 'overlapping preparations must share the one pending restart confirmation');
      confirmation.resolve(true);
      const [left, right] = await Promise.all([first, second]);
      assert(left.copied && right.copied && confirms === 1 && saves === 1,
        'one accepted restart confirmation must persist once before both preparations return');
    },
  },
  {
    name: 'handoff bridge: engine: restored ordinary lanes become restart holds while existing holds retain reason',
    run: () => {
      const plain = rehydrateApplicationLane({ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, releasedAt: 0, phase: 'unread', counters: {} });
      const held = rehydrateApplicationLane({ ord: 2, jobId: JOB_B, canvasFilePath: PATH_B, releasedAt: 0, phase: 'held', reason: 'user_hold', heldFrom: 'awaiting', counters: {} });
      const needs = rehydrateApplicationLane({ ord: 3, jobId: '33333333-3333-4333-8333-333333333333', canvasFilePath: '/tmp/x.canvas', releasedAt: 0, phase: 'needs_user', reason: 'job_broken', heldFrom: 'awaiting', counters: {} });
      assert(plain.reason === 'restart' && held.reason === 'user_hold' && needs.reason === 'job_broken', 'rehydration preserves explicit holds');
    },
  },
  {
    name: 'handoff bridge: engine: hint coalescing invalidates one lane without multiple timers',
    run: async () => {
      const state = await served(); assert(state.engine.hint({ jobId: JOB_A }) && state.engine.hint({ jobId: JOB_A }), 'hints should be accepted');
      assert(state.clock.pendingCount() <= 1, 'coalesced hints must keep one timer'); state.clock.advance(CONSTANTS.HINT_MIN_INTERVAL_MS); await Promise.resolve(); await state.engine.get({ session: state.session, linkId: LINK });
      assert(state.fake.calls.read === 2, 'coalesced hint invalidates exactly one subsequent read');
    },
  },
  {
    name: 'handoff bridge: engine: release validates UUID paths deduplicates and enforces lane cap',
    run: async () => {
      const fake = source(); const engine = createHandoffEngine({ source: fake.api });
      assert((await engine.release({ jobs: [{ jobId: 'not-a-uuid', canvasFilePath: PATH_A }] })).code === 'invalid_arguments', 'invalid release must fail closed');
      assert((await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }, { jobId: JOB_A, canvasFilePath: PATH_A }] })).count === 1, 'duplicate release must collapse');
      const jobs = Array.from({ length: 9 }, (_, index) => { const digit = (index + 3).toString(16); return { jobId: `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`, canvasFilePath: `/tmp/${index}.canvas` }; });
      assert((await engine.release({ jobs })).ok && (await engine.release({ jobs: [{ jobId: JOB_B, canvasFilePath: PATH_B }] })).code === 'lane_limit', 'ten live lanes is hard cap');
    },
  },
  {
    name: 'handoff bridge: engine: power resume aborts a held get and refreshes stale awaiting state',
    run: async () => {
      const clock = createFakeClock();
      const state = await started({ clock, engineOptions: { holdMs: 10_000, limits: { jobsPerChat: 1 } } });
      await state.engine.release({ jobs: [{ jobId: JOB_B, canvasFilePath: PATH_B }] });
      const first = await state.engine.get({ session: state.session, linkId: LINK });
      const initialPower = state.engine.powerState();
      assert(initialPower.awaiting === true && initialPower.hostCanvasPaths.length === 0 && Number.isFinite(initialPower.lastCallAt)
        && JSON.stringify(Object.keys(initialPower).sort()) === JSON.stringify(['awaiting', 'hostCanvasPaths', 'lastCallAt']),
      'private power state must expose awaiting work without leaking lane metadata');
      await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: first.handoffCode, response: answer({ code: first.handoffCode, stage: first.stage }) });
      state.engine.hint({ jobId: JOB_B }); clock.advance(CONSTANTS.HINT_MIN_INTERVAL_MS);
      const held = state.engine.get({ session: state.session, linkId: LINK });
      await new Promise(resolve => setImmediate(resolve));
      assert(state.engine.debugState().waiters === 1, 'second poll must be held before resume');
      assert(state.engine.onPowerResume(), 'resume fence must be accepted');
      const result = await held;
      assert(result.status === 'retry' && state.fake.calls.read === 2, 'pre-resume held get must wake retry without continuing source work');
      const lanes = state.engine.snapshot().queue.jobs;
      assert(lanes.some(lane => lane.jobId === JOB_B && lane.phase === 'awaiting'), 'resume must preserve the awaiting lane rather than serve stale work');
      const refreshed = state.engine.get({ session: state.session, linkId: LINK });
      await new Promise(resolve => setImmediate(resolve)); clock.advance(10_000);
      assert((await refreshed).status === 'waiting' && state.fake.calls.read === 3, 'next get must refresh the invalidated awaiting lane');
    },
  },
  {
    name: 'handoff bridge: engine: power hooks stay active with keep-awake disabled and contain callbacks',
    run: () => {
      const listeners = new Map(); const removed = []; const calls = []; const callbackArgs = [];
      const monitor = {
        on(event, callback) { listeners.set(event, callback); },
        removeListener(event, callback) { removed.push([event, callback]); },
      };
      const power = createHandoffBridgePower({
        enabled: false,
        now: () => 123,
        powerMonitor: monitor,
        powerSaveBlocker: { start: () => calls.push('start'), stop: () => calls.push('stop') },
        getCanvasWindows: () => [{ webContents: { id: 7, setBackgroundThrottling: value => calls.push(value) } }],
        onSuspend: (...args) => callbackArgs.push(args),
        onResume: () => { throw new Error('synthetic callback'); },
      });
      assert(listeners.has('suspend') && listeners.has('resume'), 'lifecycle hooks must attach even while keep-awake is disabled');
      listeners.get('suspend')(); listeners.get('resume')();
      assert(callbackArgs.length === 1 && callbackArgs[0].length === 0, 'suspend timestamp must remain internal');
      assert(power.update({ hostLane: true, recentChat: true, hostWindowIds: [7] }) === false && calls.length === 0, 'false keep-awake must not touch blocker or throttling ports');
      power.dispose();
      assert(removed.length === 2 && removed.every(([event, callback]) => listeners.get(event) === callback), 'dispose must remove both lifecycle listeners');
    },
  },
  {
    name: 'handoff bridge: engine: concurrent get calls attach to one pending read and one serve',
    run: async () => {
      const pending = deferred(); let reads = 0;
      const state = await started({ sourceOverrides: { read: async () => { reads++; return pending.promise; } } });
      const one = state.engine.get({ session: state.session, linkId: LINK }); const two = state.engine.get({ session: state.session, linkId: LINK });
      await new Promise(resolve => setImmediate(resolve)); pending.resolve({ kind: 'open', handoff: handoff() });
      const [left, right] = await Promise.all([one, two]);
      const snapshot = state.engine.snapshot();
      assert(reads === 1 && left.status === 'served' && right.status === 'served' && left.handoffCode === right.handoffCode
        && snapshot.counts.getServed === 1 && snapshot.chat.servedTwice === false && snapshot.chat.calls === 2,
      'concurrent polls must attach to one source read and one application serve while retaining both call observations');
    },
  },
  {
    name: 'handoff bridge: engine: watchdog frees an unsettled read slot for a later retry',
    run: async () => {
      let reads = 0; const never = new Promise(() => {}); const fake = source({ read: async () => (++reads === 1 ? never : { kind: 'open', handoff: handoff() }) });
      const timers = { setTimeout: (fn, ms) => ({ timer: setTimeout(fn, ms), unref() {} }), clearTimeout: handle => clearTimeout(handle?.timer ?? handle) };
      const engine = createHandoffEngine({ source: fake.api, timers, readWatchdogMs: 1, holdMs: 0, random: () => Buffer.alloc(26, 7) });
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] }); const chat = await engine.newChat({ linkId: LINK });
      const result = await engine.get({ session: chat.sessionCode, linkId: LINK }); await engine.close();
      assert(reads === 2 && result.status === 'served', 'watchdog must free a stuck source slot and retry once');
    },
  },
  {
    name: 'handoff bridge: engine: zero submit budget returns retry while app submit continues',
    run: async () => {
      const pending = deferred(); const state = await served({ sourceOverrides: { submit: async () => pending.promise }, engineOptions: { submitBudgetMs: 0 } });
      const response = answer({ code: state.result.handoffCode, stage: state.result.stage });
      assert((await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response })).status === 'retry', 'budget must return retry without aborting app call');
      pending.resolve({ kind: 'accepted', completed: true }); await new Promise(resolve => setImmediate(resolve));
      assert(state.engine.snapshot().counts.submitAccepted === 1, 'budgeted app submit must continue to its durable result');
    },
  },
  {
    name: 'handoff bridge: engine: held lane rejects submit and resume restores its awaiting prompt',
    run: async () => {
      const state = await served(); await state.engine.hold(JOB_A);
      assert((await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: '{}' })).status === 'held', 'held lane must not submit');
      assert((await state.engine.resume({ jobId: JOB_A })).ok && (await state.engine.get({ session: state.session, linkId: LINK })).status === 'served', 'lane resume restores serving');
    },
  },
  {
    name: 'handoff bridge: engine: unrelease removes its in-memory code route',
    run: async () => {
      const state = await served(); assert((await state.engine.unrelease(JOB_A)).ok, 'unrelease should succeed');
      assert((await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: '{}' })).status === 'unknown_handoff', 'unreleased code must lose index route');
    },
  },
  {
    name: 'handoff bridge: engine: serve-after-idle hook is rate limited and contains callback failures',
    run: async () => {
      let notices = 0; const clock = createFakeClock();
      const state = await started({ clock, engineOptions: { onServeAfterIdle: () => { notices++; throw new Error('synthetic callback'); } } });
      clock.advance(CONSTANTS.SERVE_AFTER_IDLE_NOTICE_HOURS * 3_600_000); await state.engine.get({ session: state.session, linkId: LINK }); await state.engine.get({ session: state.session, linkId: LINK });
      assert(notices === 1, 'idle notice must not repeat on an immediate re-serve');
    },
  },
  {
    name: 'handoff bridge: engine: application throw rereads and retries rather than exposing errors',
    run: async () => {
      let submits = 0;
      const state = await served({ sourceOverrides: { submit: async () => { submits++; return submits === 1 ? { kind: 'threw', code: 'EIO' } : { kind: 'accepted', completed: true }; } } });
      const result = await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: answer({ code: state.result.handoffCode, stage: state.result.stage }) });
      assert(result.status === 'accepted' && submits === 2, 'submit throw must re-read and retry safely');
    },
  },
  {
    name: 'handoff bridge: engine: same-stage fresh recovery code retries once and supersedes old code',
    run: async () => {
      let reads = 0; const submittedCodes = [];
      const state = await served({ sourceOverrides: {
        read: async () => ({ kind: 'open', handoff: handoff({ code: ++reads === 1 ? 'HANDOFF-A' : 'HANDOFF-FRESH', stage: 'resume' }) }),
        submit: async (_lane, submitted) => { submittedCodes.push(submitted.code); return submittedCodes.length === 1 ? { kind: 'threw', code: 'EIO', stage: 'resume' } : { kind: 'accepted', completed: true }; },
      } });
      const result = await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: answer({ code: state.result.handoffCode, stage: state.result.stage }) });
      assert(result.status === 'accepted' && submittedCodes.join(',') === 'HANDOFF-A,HANDOFF-FRESH', 'same-stage recovery must retry exactly once with fresh code');
      assert((await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: 'HANDOFF-A', response: '{}' })).status === 'superseded', 'old recovery code must become superseded');
    },
  },
  {
    name: 'handoff bridge: engine: different-stage fresh recovery code holds human advance without retry',
    run: async () => {
      let reads = 0; let submits = 0;
      const state = await served({ sourceOverrides: {
        read: async () => ({ kind: 'open', handoff: handoff({ code: ++reads === 1 ? 'HANDOFF-A' : 'HANDOFF-REVIEW', stage: reads === 1 ? 'resume' : 'review' }) }),
        submit: async () => { submits++; return { kind: 'threw', code: 'EIO', stage: 'resume' }; },
      } });
      const result = await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: answer({ code: state.result.handoffCode, stage: state.result.stage }) });
      const lane = state.engine.snapshot().queue.jobs[0];
      assert(result.status === 'superseded' && submits === 1, 'stage change must return superseded without retrying submit');
      assert(lane.phase === 'held' && lane.reason === 'human_advance', 'stage-changing fresh code must require human review');
    },
  },
  {
    name: 'handoff bridge: engine: integrity faults become fixed needs-user result without source text',
    run: async () => {
      const state = await served({ sourceOverrides: { submit: async () => ({ kind: 'threw', code: 'LOCAL_AI_JOB_INTEGRITY', message: '/private/secret' }) } });
      const result = await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: answer({ code: state.result.handoffCode, stage: state.result.stage }) });
      assert(result.status === 'needs_user' && result.reason === 'job_broken' && !JSON.stringify(result).includes('/private'), 'integrity error must be fixed and private');
    },
  },
  {
    name: 'handoff bridge: engine: review revisions continue past eight and can complete',
    run: async () => {
      let submits = 0;
      const persisted = [];
      const state = await served({ sourceOverrides: {
        submit: async () => {
          submits++;
          return submits <= 10
            ? { kind: 'accepted', completed: false, handoff: handoff({ code: `HANDOFF-REVIEW-${submits}`, stage: 'review', revision: submits }) }
            : { kind: 'accepted', completed: true };
        },
      }, engineOptions: { store: { saveLanes: async lanes => { persisted.push(lanes); return true; } } } });
      let code = state.result.handoffCode;
      let stage = state.result.stage;
      // The first accept enters review; the following nine are review→review
      // revisions, deliberately exceeding the former automatic hold threshold.
      for (let index = 0; index < 10; index++) {
        const result = await state.engine.submit({
          session: state.session, linkId: LINK, handoffCode: code,
          response: answer({ code, stage, extra: { index } }),
        });
        assert(result.status === 'accepted' && result.jobComplete === false && result.next?.stage === 'review',
          `revision ${index + 1} must serve the next review handoff without a human resume`);
        code = result.next.handoffCode;
        stage = result.next.stage;
      }
      const lane = state.engine.snapshot().queue.jobs[0];
      const savedLane = persisted.at(-1)?.[0];
      assert(lane.phase === 'awaiting' && savedLane?.counters?.revisedRounds === 9,
        'more than eight review revisions must remain awaiting with its counter persisted for telemetry');
      const completed = await state.engine.submit({
        session: state.session, linkId: LINK, handoffCode: code,
        response: answer({ code, stage, extra: { final: true } }),
      });
      assert(completed.status === 'accepted' && completed.jobComplete === true,
        'a later review pass must still complete the application');
    },
  },
  {
    name: 'handoff bridge: engine: persisted metadata rejects selected hub and code fields',
    run: async () => {
      const directory = cleanDirectory();
      try {
        const store = createLaneStore({ userDataPath: directory });
        assert(!(await store.saveLanes([{ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, phase: 'held', reason: 'user_hold', heldFrom: 'awaiting', counters: {}, selectedHub: 'hub' }])), 'selected hubs are never durable lane fields');
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'handoff bridge: engine: close retires the live epoch and cancels hint timers',
    run: async () => {
      const state = await served(); state.engine.hint({ jobId: JOB_A }); await state.engine.close();
      assert(state.clock.pendingCount() === 0 && (await state.engine.get({ session: state.session, linkId: LINK })).status === 'paused', 'close must clear timers and stop calls');
    },
  },
  {
    name: 'handoff bridge: engine: fresh corrections send the fixed note before correction prompt',
    run: () => {
      const lane = createApplicationLane({ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, handoff: { ...handoff(), corrections: ['fix synthetic field'], correctionPrompt: 'private app prompt' } });
      const body = makeServedBody({ lane, remaining: { ready: 1, working: 0, needsYou: 0 }, servedBefore: false });
      assert(typeof body.note === 'string' && !Object.hasOwn(body, 'correctionPrompt'), 'first fresh correction uses fixed framing note only');
    },
  },
  {
    name: 'handoff bridge: engine: ENOENT status becomes canvas-unavailable needs-user lane',
    run: async () => {
      const state = await served({ sourceOverrides: { status: async () => ({ kind: 'threw', code: 'ENOENT' }) } });
      await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: answer({ code: state.result.handoffCode, stage: state.result.stage }) }); state.clock.advance(CONSTANTS.HOST_POLL_MS);
      await state.engine.get({ session: state.session, linkId: LINK });
      const lane = state.engine.snapshot().queue.jobs[0]; assert(lane.phase === 'needs_user' && lane.reason === 'canvas_unavailable', 'missing canvas must never be silently retried');
    },
  },
  {
    name: 'handoff bridge: engine: a deterministic app-side layout failure stays an app-fix hold, never a retryable handoff',
    run: async () => {
      // This is the bridge-facing end of the PDF comparator fence. The source
      // has already decided the exact same bytes would reproduce its failure;
      // keep that distinct reason through the host poll rather than offering
      // ChatGPT another application handoff or collapsing it to render_retry.
      const state = await served({ sourceOverrides: { status: async () => ({ kind: 'needs_user', reason: 'app_fix_required' }) } });
      await state.engine.submit({
        session: state.session, linkId: LINK, handoffCode: state.result.handoffCode,
        response: answer({ code: state.result.handoffCode, stage: state.result.stage }),
      });
      state.clock.advance(CONSTANTS.HOST_POLL_MS);
      const response = await state.engine.get({ session: state.session, linkId: LINK });
      const lane = state.engine.snapshot().queue.jobs[0];
      assert(response.status === 'paused' && response.reason === 'needs_user', `ChatGPT must stop for an app fix, got ${response.status}/${response.reason || ''}`);
      assert(lane.phase === 'needs_user' && lane.reason === 'app_fix_required', `the deterministic block must not become retryable (${lane.phase}/${lane.reason})`);
    },
  },
  {
    name: 'handoff bridge: engine: an unsettled submit is held submit-stuck at ninety seconds',
    run: async () => {
      const pending = deferred(); const state = await served({ sourceOverrides: { submit: async () => pending.promise }, engineOptions: { submitBudgetMs: 0 } });
      await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: answer({ code: state.result.handoffCode, stage: state.result.stage }) }); await new Promise(resolve => setImmediate(resolve)); state.clock.advance(CONSTANTS.SUBMIT_STUCK_MS); await new Promise(resolve => setImmediate(resolve));
      const lane = state.engine.snapshot().queue.jobs[0]; assert(lane.phase === 'needs_user' && lane.reason === 'submit_stuck', 'unsettled app submit must be visibly held'); pending.resolve({ kind: 'accepted', completed: true });
    },
  },
  {
    name: 'handoff bridge: engine: an unsettled internal recovery submit releases its semaphore slot',
    run: async () => {
      const pending = deferred(); let submits = 0;
      const state = await served({
        sourceOverrides: { submit: async () => (++submits === 1 ? { kind: 'threw', code: 'EIO' } : pending.promise) },
        engineOptions: { submitBudgetMs: 0 },
      });
      await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: answer({ code: state.result.handoffCode, stage: state.result.stage }) });
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      assert(state.engine.debugState().submitActive === 1, 'internal recovery must hold the submit slot while it is pending');
      state.clock.advance(CONSTANTS.SUBMIT_STUCK_MS);
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      const lane = state.engine.snapshot().queue.jobs[0];
      assert(lane.phase === 'needs_user' && lane.reason === 'submit_stuck', 'internal recovery timeout must hold the lane visibly');
      assert(state.engine.debugState().submitActive === 0 && state.engine.debugState().submitWaiting === 0, 'internal recovery timeout must release the semaphore');
      pending.resolve({ kind: 'accepted', completed: true });
    },
  },
  {
    name: 'handoff bridge: engine: different bytes replay retained crash-gap bytes before a new answer',
    run: async () => {
      const submitted = [];
      const state = await served({ sourceOverrides: {
        submit: async (_lane, value) => {
          submitted.push(value.text);
          return submitted.length < 4 ? { kind: 'threw', code: 'EIO' } : { kind: 'accepted', completed: true };
        },
      } });
      const first = answer({ code: state.result.handoffCode, stage: state.result.stage, extra: { version: 1 } });
      const second = answer({ code: state.result.handoffCode, stage: state.result.stage, extra: { version: 2 } });
      assert((await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: first })).status === 'retry', 'exhausted crash-gap recovery must ask for a retry');
      assert((await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: second })).status === 'accepted', 'retained crash-gap bytes should recover before accepting replacement bytes');
      assert(submitted.length === 4 && submitted.every(value => value === first), 'replacement bytes must not overtake retained crash-gap bytes');
    },
  },
  {
    name: 'handoff bridge: engine: failed persistence rolls release state back atomically',
    run: async () => {
      const fake = source(); const engine = createHandoffEngine({ source: fake.api, store: { saveLanes: async () => false } });
      assert((await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] })).code === 'persist_failed', 'failed durable release must report fixed result');
      assert(engine.snapshot().queue.jobs.length === 0, 'failed durable release must not leave a ghost lane');
    },
  },
];

tests.push(
  {
    name: 'handoff bridge: engine: lane persistence omits all epoch prompt and handoff material',
    run: async () => {
      const directory = cleanDirectory();
      try {
        const store = createLaneStore({ userDataPath: directory }); const lane = createApplicationLane({ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, handoff: handoff({ prompt: 'must not persist' }) });
        await store.saveLanes([lane]); const raw = fs.readFileSync(store.lanesPath, 'utf8');
        assert(!/HANDOFF|prompt|session|epoch|retired|must not persist/i.test(raw), 'durable lanes must omit secrets and content');
        const restored = store.loadLanes(); assert(restored.length === 1 && restored[0].phase === 'held' && restored[0].reason === 'restart', 'restart must rehydrate held lane');
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'handoff bridge: engine: lane store retains existing held and needs-user reasons after restart',
    run: async () => {
      const directory = cleanDirectory();
      try {
        const store = createLaneStore({ userDataPath: directory }); const one = createApplicationLane({ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A }); const two = createApplicationLane({ ord: 2, jobId: JOB_B, canvasFilePath: PATH_B }); holdLane(one, 'user_hold'); holdLane(two, 'job_broken');
        await store.saveLanes([one, two]); const loaded = store.loadLanes(); assert(loaded[0].reason === 'user_hold' && loaded[1].reason === 'job_broken', 'existing hold reasons must survive restart');
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'handoff bridge: engine: lane store ignores unknown versions and preserves tool surface fingerprint',
    run: async () => {
      const directory = cleanDirectory();
      try {
        const store = createLaneStore({ userDataPath: directory }); fs.mkdirSync(path.dirname(store.lanesPath), { recursive: true }); fs.writeFileSync(store.lanesPath, '{"v":99,"lanes":[]}'); assert(store.loadLanes().length === 0, 'unknown lanes version must load empty');
        const meta = { linkId: LINK, toolsSurfaceFp: 'a'.repeat(64), toolsListedAt: 1 }; assert(await store.saveLinkMeta(meta) && await store.saveLinkMeta(meta), 'unchanged tool surface should avoid write amplification'); assert(store.readLinkMeta().toolsSurfaceFp === meta.toolsSurfaceFp, 'surface fingerprint must survive restart');
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'handoff bridge: engine: autoStart does not mint or serve a chat',
    run: async () => {
      const fake = source(); const engine = createHandoffEngine({ source: fake.api, autoStart: true });
      assert((await engine.get({ session: 'old-session', linkId: LINK })).status === 'session_ended', 'autoStart is never implicit serving'); assert(fake.calls.read === 0 && engine.snapshot().autoStart, 'autoStart must have no adapter side effect');
    },
  },
  {
    name: 'handoff bridge: engine: audit ledgers separate safe security and serving events',
    run: async () => {
      const directory = cleanDirectory();
      try {
        const audit = createAuditSink({ userDataPath: directory }); await audit.append('pause', { cause: 'idle' }, 1); await audit.append('served', { tool: 'get_handoff', outcome: 'ok', stage: 'resume' }, 2);
        const security = fs.readFileSync(audit.securityPath, 'utf8'); const serve = fs.readFileSync(audit.servePath, 'utf8'); assert(security.includes('pause') && !security.includes('HANDOFF') && serve.includes('served'), 'ledger routing must be enumerated and private');
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'handoff bridge: engine: close fences delayed application read status and submit results',
    run: async () => {
      // Read: a completion after Close cannot adopt a handoff, persist, or
      // notify a renderer.
      const readPending = deferred(); let readCalls = 0; let readSaves = 0; let readNotices = 0;
      const readState = await started({
        sourceOverrides: { read: async () => { readCalls++; return readPending.promise; } },
        engineOptions: { store: { saveLanes: async () => { readSaves++; return true; } }, onJobChanged: () => { readNotices++; } },
      });
      const readBaseline = readSaves;
      const delayedRead = readState.engine.get({ session: readState.session, linkId: LINK });
      await new Promise(resolve => setImmediate(resolve));
      assert(readCalls === 1, 'fixture must dispatch one read before Close');
      await readState.engine.close(); readPending.resolve({ kind: 'open', handoff: handoff() });
      await delayedRead; await Promise.resolve();
      assert(readState.engine.snapshot().queue.jobs[0].phase === 'unread' && readSaves === readBaseline && readNotices === 0 && readState.engine.snapshot().counts.getServed === 0,
        'a stale read must not mutate a lane, persist, notify, or serve');

      // Status: the same fence applies after an already-hosted lane polls.
      const statusPending = deferred(); let statusSaves = 0; let statusNotices = 0; let statusCalls = 0;
      const clock = createFakeClock(); const statusSource = source({
        read: async () => ({ kind: 'host' }),
        status: async () => { statusCalls++; return statusPending.promise; },
      });
      const statusEngine = createHandoffEngine({ source: statusSource.api, now: clock.now, timers: clock, holdMs: 0,
        store: { saveLanes: async () => { statusSaves++; return true; } }, onJobChanged: () => { statusNotices++; } });
      await statusEngine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] }); const statusChat = await statusEngine.newChat({ linkId: LINK });
      await statusEngine.get({ session: statusChat.sessionCode, linkId: LINK });
      const statusBaseline = statusSaves; clock.advance(CONSTANTS.HOST_POLL_MS);
      const delayedStatus = statusEngine.get({ session: statusChat.sessionCode, linkId: LINK });
      await new Promise(resolve => setImmediate(resolve));
      assert(statusCalls === 1, 'fixture must dispatch one status poll before Close');
      await statusEngine.close(); statusPending.resolve({ kind: 'done' });
      await delayedStatus; await Promise.resolve();
      assert(statusEngine.snapshot().queue.jobs[0].phase === 'host' && statusSaves === statusBaseline && statusNotices === 0,
        'a stale status result must not complete or persist a host lane');

      // Submit: result framing and its verdict cache are also fenced.
      const submitPending = deferred(); let submitSaves = 0; let submitNotices = 0;
      const submitState = await served({
        sourceOverrides: { submit: async () => submitPending.promise },
        engineOptions: { store: { saveLanes: async () => { submitSaves++; return true; } }, onJobChanged: () => { submitNotices++; } },
      });
      const submitBaseline = submitSaves;
      const delayedSubmit = submitState.engine.submit({ session: submitState.session, linkId: LINK, handoffCode: submitState.result.handoffCode, response: answer({ code: submitState.result.handoffCode, stage: submitState.result.stage }) });
      await new Promise(resolve => setImmediate(resolve));
      await submitState.engine.close(); submitPending.resolve({ kind: 'accepted', completed: true });
      await delayedSubmit; await Promise.resolve();
      assert(submitState.engine.snapshot().counts.submitAccepted === 0 && submitSaves === submitBaseline && submitNotices === 0,
        'a stale submit result must not cache a verdict, persist, or notify');
    },
  },
  {
    name: 'handoff bridge: engine: close before a queued push acquire never invokes the source',
    run: async () => {
      let pushSubmits = 0;
      const push = {
        async get() { return { status: 'served', handoffCode: 'PUSH-A', task: 'job-scoring', prompt: 'Synthetic scoring prompt.', remaining: { ready: 0, working: 0, needsYou: 0 } }; },
        async submit() { pushSubmits++; return { status: 'accepted' }; },
      };
      const engine = createHandoffEngine({ sources: { application: source().api, push }, scope: { applications: false, scoring: true }, holdMs: 0 });
      const chat = await engine.newChat({ linkId: LINK }); const servedPush = await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(servedPush.status === 'served' && servedPush.kind === 'push', 'fixture must receive a scoring handoff');
      const pending = engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: servedPush.handoffCode, response: 'Synthetic scoring answer.' });
      await engine.close(); await pending; await Promise.resolve();
      assert(pushSubmits === 0 && engine.snapshot().counts.submitAccepted === 0, 'Close during semaphore acquisition must stop the queued push source call and result framing');
    },
  },
  {
    name: 'handoff bridge: engine: an aborted held GET releases its waiter without changing submit behavior',
    run: async () => {
      const clock = createFakeClock(); let polls = 0;
      const push = {
        async get() { polls++; return { status: 'waiting', remaining: { ready: 0, working: 1, needsYou: 0 } }; },
        async submit() { return { status: 'unknown_handoff' }; },
      };
      const engine = createHandoffEngine({ sources: { application: source().api, push }, scope: { applications: false, scoring: true }, now: clock.now, timers: clock, holdMs: 30_000 });
      const chat = await engine.newChat({ linkId: LINK }); const abort = new AbortController();
      const pending = engine.get({ session: chat.sessionCode, linkId: LINK, signal: abort.signal });
      await new Promise(resolve => setImmediate(resolve));
      assert(engine.debugState().waiters === 1 && polls === 1, 'held GET must retain exactly one wake waiter');
      abort.abort(); const result = await pending;
      assert(result.status === 'retry' && engine.debugState().waiters === 0 && clock.pendingCount() === 0 && polls === 1,
        'aborted GET must return promptly, remove timer/listener state, and launch no follow-up source poll');
    },
  },
  {
    name: 'handoff bridge: engine: injects an exact mixed-scope task set into the push source before polling',
    run: () => {
      const received = [];
      const push = {
        setAllowedTasks(tasks) { received.push(new Set(tasks)); },
        async get() { return { status: 'queue_empty', remaining: { ready: 0, working: 0, needsYou: 0 } }; },
        async submit() { return { status: 'unknown_handoff' }; },
      };
      const engine = createHandoffEngine({ sources: { application: source().api, push }, scope: { applications: false, scoring: true, marketplace: false } });
      const scoringOnly = received.at(-1);
      assert(scoringOnly.has('job-scoring') && !scoringOnly.has('price-synthesis'), 'scoring consent injects scoring tasks but not marketplace tasks');
      engine.setScope({ applications: false, scoring: false, marketplace: true });
      const marketplaceOnly = received.at(-1);
      assert(JSON.stringify([...marketplaceOnly].sort()) === JSON.stringify(['bundle-price-synthesis', 'platform-fit-assessment', 'price-synthesis', 'price-synthesis-batch']), 'marketplace-only consent injects exactly its closed task family');
    },
  },
  {
    name: 'handoff bridge: engine: an omitted scope retains the default-on marketplace family',
    run: async () => {
      const push = {
        async get() { return { status: 'served', handoffCode: 'PUSH-MARKET-DEFAULT', task: 'price-synthesis', prompt: 'Synthetic pricing prompt.', remaining: { ready: 0, working: 0, needsYou: 0 } }; },
        async submit() { return { status: 'unknown_handoff' }; },
      };
      const engine = createHandoffEngine({ sources: { application: source().api, push }, holdMs: 0 });
      const chat = await engine.newChat({ linkId: LINK });
      const served = await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(served.status === 'served' && served.kind === 'push' && served.task === 'price-synthesis',
        'the standalone fallback must agree with persisted/bootstrap default-on marketplace scope');
    },
  },
  {
    name: 'handoff bridge: engine: scope changes fence each source family independently',
    run: async () => {
      const app = source(); let pushGets = 0; let pushSubmits = 0;
      const push = {
        async get() { pushGets++; return { status: 'served', handoffCode: 'PUSH-SCOPE', task: 'job-scoring', prompt: 'Synthetic scoring prompt.', remaining: { ready: 0, working: 0, needsYou: 0 } }; },
        async submit() { pushSubmits++; return { status: 'unknown_handoff' }; },
      };
      const engine = createHandoffEngine({ sources: { application: app.api, push }, scope: { applications: true, scoring: true, marketplace: false }, holdMs: 0 });
      assert((await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] })).ok, 'fixture must release an application lane before lowering scope');
      const chat = await engine.newChat({ linkId: LINK });
      engine.setScope({ applications: false, scoring: true, marketplace: false });
      const pushed = await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(pushed.kind === 'push' && app.calls.read === 0 && pushGets === 1, 'applications-off must leave released lanes inert while scoring remains live');
      const frozenPushGets = pushGets;
      engine.setScope({ applications: true, scoring: false, marketplace: false });
      const applied = await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(applied.kind === 'application' && app.calls.read === 1 && pushGets === frozenPushGets, 'scoring-off must stop scoring polls while application serving resumes');
      engine.setScope({ applications: false, scoring: false, marketplace: false });
      const denied = await engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: applied.handoffCode, response: answer({ code: applied.handoffCode, stage: applied.stage }) });
      assert(denied.status === 'held' && denied.reason === 'scope_disabled' && app.calls.submit === 0 && pushSubmits === 0,
        'a later scope downgrade must block outstanding application answers without either adapter call');
    },
  },
  {
    name: 'handoff bridge: engine: a marketplace push task stays held until scope.marketplace is on, even with scoring on',
    run: async () => {
      let pushGets = 0;
      const push = {
        async get() { pushGets++; return { status: 'served', handoffCode: 'PUSH-MARKET', task: 'price-synthesis', prompt: 'Synthetic pricing prompt.', remaining: { ready: 0, working: 0, needsYou: 0 } }; },
        async submit() { return { status: 'unknown_handoff' }; },
      };
      const engine = createHandoffEngine({
        sources: { application: source().api, push },
        scope: { applications: false, scoring: true, marketplace: false },
        holdMs: 0,
      });
      const chat = await engine.newChat({ linkId: LINK });
      const held = await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(held.status === 'held' && held.reason === 'scope_disabled' && pushGets === 1,
        'a marketplace task must never be framed as served while scope.marketplace is off, even though the push channel is live for scoring');
      engine.setScope({ applications: false, scoring: true, marketplace: true });
      const served = await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(served.status === 'served' && served.kind === 'push' && served.task === 'price-synthesis' && served.handoffCode === 'PUSH-MARKET',
        'turning marketplace on must let the same push task serve');
    },
  },
  {
    name: 'handoff bridge: engine: terminal evidence is pruned after one hour and persisted once',
    run: async () => {
      const clock = createFakeClock(); let saves = 0;
      const engine = createHandoffEngine({ source: source({ read: async () => ({ kind: 'done' }) }).api, now: clock.now, timers: clock, holdMs: 0,
        store: { saveLanes: async () => { saves++; return true; } } });
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] }); const chat = await engine.newChat({ linkId: LINK });
      await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(engine.snapshot().queue.jobs[0].phase === 'done', 'fixture must retain terminal evidence before pruning');
      const before = saves; clock.advance(60 * 60_000); await engine.tick(clock.now());
      assert(engine.snapshot().queue.jobs.length === 0 && saves === before + 1, 'one-hour terminal evidence prune must bound memory and durable lanes');
    },
  },
  {
    name: 'handoff bridge: engine: a queued hint cannot revive terminal evidence or block its prune',
    run: async () => {
      const clock = createFakeClock();
      const engine = createHandoffEngine({ source: source({ read: async () => ({ kind: 'done' }) }).api, now: clock.now, timers: clock, holdMs: 0 });
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] }); const chat = await engine.newChat({ linkId: LINK });
      assert(engine.hint({ jobId: JOB_A }) && engine.hint({ jobId: JOB_A }) && clock.pendingCount() === 1, 'second hint must queue one deferred invalidation');
      await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(engine.snapshot().queue.jobs[0].phase === 'done' && clock.pendingCount() === 0, 'terminal transition must clear the queued hint timer');
      clock.advance(CONSTANTS.HINT_MIN_INTERVAL_MS); clock.advance(60 * 60_000); await engine.tick(clock.now());
      assert(engine.snapshot().queue.jobs.length === 0, 'a stale hint callback must not set needsRefresh and prevent terminal pruning');
    },
  },
  {
    name: 'handoff bridge: engine: Close rolls back a delayed push-hub selection',
    run: async () => {
      const selection = deferred(); const selected = new Set(); const key = 'a'.repeat(64);
      const push = {
        async get() { return { status: 'queue_empty', remaining: { ready: 0, working: 0, needsYou: 0 } }; },
        async submit() { return { status: 'unknown_handoff' }; },
        async selectHubKey(value) { await selection.promise; selected.add(value); return true; },
        async unselectHubKey(value) { selected.delete(value); return true; },
        clearHubs() { selected.clear(); },
      };
      const engine = createHandoffEngine({ sources: { application: source().api, push }, scope: { applications: false, scoring: true } });
      const selecting = engine.selectPushHubKey(key); await Promise.resolve();
      await engine.close(); selection.resolve();
      assert(await selecting === false && selected.size === 0,
        'a source selection completing after Close must be removed rather than repopulating closed push state');
    },
  },
  {
    name: 'handoff bridge: engine: delayed old hub refresh cannot populate a replacement engine discovery cache',
    run: async () => {
      const refreshGate = deferred(); const key = 'b'.repeat(64); const discovered = []; let refreshes = 0;
      const push = {
        async get() { return { status: 'queue_empty', remaining: { ready: 0, working: 0, needsYou: 0 } }; },
        async submit() { return { status: 'unknown_handoff' }; },
        async refreshHubs() {
          refreshes += 1;
          if (refreshes === 1) await refreshGate.promise;
          discovered.splice(0, discovered.length, { key, pending: 1, tasks: [{ task: 'job-scoring', pending: 1 }], excluded: {} });
          return true;
        },
        clearHubs() {},
        status() { return { discovered, selectedHubs: [], served: 0, held: 0, working: 0, needsYou: 0 }; },
      };
      const oldEngine = createHandoffEngine({ sources: { application: source().api, push }, scope: { applications: false, scoring: true } });
      const staleRefresh = oldEngine.refreshPushHubs(); await Promise.resolve();
      await oldEngine.close();
      const replacement = createHandoffEngine({ sources: { application: source().api, push }, scope: { applications: false, scoring: true } });
      refreshGate.resolve();
      assert(await staleRefresh === false && replacement.snapshot().push.discovered.length === 0,
        'a stale shared-source refresh must stay hidden until the replacement performs its own refresh');
      assert(await replacement.refreshPushHubs() === true && replacement.snapshot().push.discovered.length === 1,
        'the replacement may expose only discovery it refreshed under its own generation');
    },
  },
  {
    name: 'handoff bridge: engine: rotation discards a delayed old-chat application get before it can seed the replacement',
    run: async () => {
      const oldRead = deferred(); let reads = 0; let saves = 0;
      const application = source({
        read: async () => {
          reads++;
          return reads === 1
            ? oldRead.promise
            : { kind: 'open', handoff: handoff({ code: 'HANDOFF-ADA-EXAMPLE', prompt: 'Synthetic Ada replacement prompt.' }) };
        },
      });
      const engine = createHandoffEngine({ source: application.api, holdMs: 0, store: { saveLanes: async () => { saves++; return true; } } });
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      const oldChat = await engine.newChat({ linkId: LINK });
      const oldGet = engine.get({ session: oldChat.sessionCode, linkId: LINK });
      await new Promise(resolve => setImmediate(resolve));
      assert(reads === 1, 'old chat must dispatch exactly one delayed application read');

      const replacement = await engine.newChat({ linkId: LINK });
      const baseline = engine.snapshot(); const baselineSaves = saves;
      assert(baseline.chat.calls === 0 && baseline.chat.bytesServed === 0 && baseline.chat.bytesReceived === 0
        && baseline.queue.jobs[0]?.phase === 'unread', 'rotation must start an untouched replacement epoch and clear the old read lane state');
      oldRead.resolve({ kind: 'open', handoff: handoff({ code: 'HANDOFF-MARISOL-OLD', prompt: 'Synthetic Marisol old-chat prompt.' }) });
      assert((await oldGet).status === 'retry', 'the old application GET must never serve after its epoch rotates');
      const afterOld = engine.snapshot();
      assert(afterOld.chat.calls === 0 && afterOld.chat.bytesServed === 0 && afterOld.chat.bytesReceived === 0
        && afterOld.counts.getServed === 0 && afterOld.queue.jobs[0]?.phase === 'unread' && saves === baselineSaves,
      'the late application read must not alter replacement calls, bytes, lane state, counters, or persistence');

      const fresh = await engine.get({ session: replacement.sessionCode, linkId: LINK });
      assert(fresh.status === 'served' && fresh.handoffCode === 'HANDOFF-ADA-EXAMPLE' && reads === 2,
        'the replacement chat must re-read and serve its own synthetic Ada handoff rather than an old cache');
    },
  },
  {
    name: 'handoff bridge: engine: rotation fences delayed old-chat push get with its original epoch id',
    run: async () => {
      const oldPushGet = deferred(); const getEpochs = []; const closedEpochs = [];
      const push = {
        async get({ epoch }) {
          getEpochs.push(epoch);
          return getEpochs.length === 1
            ? oldPushGet.promise
            : { status: 'served', handoffCode: 'PUSH-ADA-EXAMPLE', task: 'job-scoring', prompt: 'Synthetic Ada replacement scoring prompt.', remaining: { ready: 0, working: 0, needsYou: 0 } };
        },
        async submit() { return { status: 'unknown_handoff' }; },
        closeEpoch(epoch) { closedEpochs.push(epoch); },
      };
      const engine = createHandoffEngine({ sources: { application: source().api, push }, scope: { applications: false, scoring: true }, holdMs: 0 });
      const oldChat = await engine.newChat({ linkId: LINK });
      const oldGet = engine.get({ session: oldChat.sessionCode, linkId: LINK });
      await new Promise(resolve => setImmediate(resolve));
      assert(JSON.stringify(getEpochs) === JSON.stringify(['epoch-1']), 'the old push GET must receive only epoch-1');

      const replacement = await engine.newChat({ linkId: LINK });
      oldPushGet.resolve({ status: 'served', handoffCode: 'PUSH-MARISOL-OLD', task: 'job-scoring', prompt: 'Synthetic Marisol old scoring prompt.', remaining: { ready: 0, working: 0, needsYou: 0 } });
      assert((await oldGet).status === 'retry', 'the late old push GET must never frame a served handoff');
      const afterOld = engine.snapshot();
      assert(afterOld.chat.calls === 0 && afterOld.chat.bytesServed === 0 && afterOld.chat.bytesReceived === 0 && afterOld.counts.getServed === 0
        && closedEpochs.every(epoch => epoch === 'epoch-1'), 'a late push GET may clean up only its original epoch and cannot mutate replacement accounting');

      const fresh = await engine.get({ session: replacement.sessionCode, linkId: LINK });
      assert(fresh.status === 'served' && fresh.handoffCode === 'PUSH-ADA-EXAMPLE'
        && JSON.stringify(getEpochs) === JSON.stringify(['epoch-1', 'epoch-2']), 'the replacement push GET must use epoch-2 and still work');
    },
  },
  {
    name: 'handoff bridge: engine: rotation discards a delayed old-chat application submit without retaining its verdict',
    run: async () => {
      const oldSubmit = deferred(); let submits = 0; let saves = 0;
      const application = source({
        read: async () => ({ kind: 'open', handoff: handoff({ code: 'HANDOFF-EXAMPLE', prompt: 'Synthetic example application prompt.' }) }),
        submit: async () => {
          submits++;
          return submits === 1 ? oldSubmit.promise : { kind: 'accepted', completed: true };
        },
      });
      const engine = createHandoffEngine({ source: application.api, holdMs: 0, store: { saveLanes: async () => { saves++; return true; } } });
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      const oldChat = await engine.newChat({ linkId: LINK });
      const servedOld = await engine.get({ session: oldChat.sessionCode, linkId: LINK });
      const stale = engine.submit({ session: oldChat.sessionCode, linkId: LINK, handoffCode: servedOld.handoffCode, response: answer({ code: servedOld.handoffCode, stage: servedOld.stage }) });
      await new Promise(resolve => setImmediate(resolve));
      assert(submits === 1, 'old chat must dispatch its one delayed application submit');

      const replacement = await engine.newChat({ linkId: LINK }); const baselineSaves = saves;
      oldSubmit.resolve({ kind: 'accepted', completed: true });
      assert((await stale).status === 'retry', 'an accepted old application submit must be reported only as retry after rotation');
      const afterOld = engine.snapshot();
      assert(afterOld.chat.calls === 0 && afterOld.chat.bytesServed === 0 && afterOld.chat.bytesReceived === 0
        && afterOld.counts.submitAccepted === 0 && afterOld.queue.jobs[0]?.phase === 'awaiting' && saves === baselineSaves,
      'the late application submit must not complete the lane, persist, or seed replacement verdict state');

      const fresh = await engine.get({ session: replacement.sessionCode, linkId: LINK });
      const accepted = await engine.submit({ session: replacement.sessionCode, linkId: LINK, handoffCode: fresh.handoffCode, response: answer({ code: fresh.handoffCode, stage: fresh.stage }) });
      assert(fresh.status === 'served' && accepted.status === 'accepted' && submits === 2,
        'the replacement must re-serve and submit the same example bytes through a new source call, not an old verdict cache');
    },
  },
  {
    name: 'handoff bridge: engine: rotation discards a delayed old-chat push submit and keeps push verdicts epoch-local',
    run: async () => {
      const oldPushSubmit = deferred(); const getEpochs = []; const submitEpochs = []; const closedEpochs = [];
      const push = {
        async get({ epoch }) {
          getEpochs.push(epoch);
          return { status: 'served', handoffCode: 'PUSH-EXAMPLE', task: 'job-scoring', prompt: 'Synthetic example scoring prompt.', remaining: { ready: 0, working: 0, needsYou: 0 } };
        },
        async submit({ epoch }) {
          submitEpochs.push(epoch);
          return submitEpochs.length === 1 ? oldPushSubmit.promise : { status: 'accepted' };
        },
        closeEpoch(epoch) { closedEpochs.push(epoch); },
      };
      const engine = createHandoffEngine({ sources: { application: source().api, push }, scope: { applications: false, scoring: true }, holdMs: 0 });
      const oldChat = await engine.newChat({ linkId: LINK });
      const servedOld = await engine.get({ session: oldChat.sessionCode, linkId: LINK });
      const stale = engine.submit({ session: oldChat.sessionCode, linkId: LINK, handoffCode: servedOld.handoffCode, response: 'Synthetic example scoring answer.' });
      await new Promise(resolve => setImmediate(resolve));
      assert(JSON.stringify(getEpochs) === JSON.stringify(['epoch-1']) && JSON.stringify(submitEpochs) === JSON.stringify(['epoch-1']),
        'old push get and submit must be tagged with the original epoch id');

      const replacement = await engine.newChat({ linkId: LINK });
      oldPushSubmit.resolve({ status: 'accepted' });
      assert((await stale).status === 'retry', 'an accepted old push submit must never become an accepted replacement result');
      const afterOld = engine.snapshot();
      assert(afterOld.chat.calls === 0 && afterOld.chat.bytesServed === 0 && afterOld.chat.bytesReceived === 0 && afterOld.counts.submitAccepted === 0
        && closedEpochs.every(epoch => epoch === 'epoch-1'), 'the old push verdict must not charge, cache, or close a replacement epoch');

      const fresh = await engine.get({ session: replacement.sessionCode, linkId: LINK });
      const accepted = await engine.submit({ session: replacement.sessionCode, linkId: LINK, handoffCode: fresh.handoffCode, response: 'Synthetic example scoring answer.' });
      assert(fresh.status === 'served' && accepted.status === 'accepted'
        && JSON.stringify(getEpochs) === JSON.stringify(['epoch-1', 'epoch-2']) && JSON.stringify(submitEpochs) === JSON.stringify(['epoch-1', 'epoch-2']),
      'the replacement must independently serve and accept through epoch-2 rather than replaying the old push verdict');
    },
  },
  {
    name: 'handoff bridge: engine: a resumed drain retires to null and fences a delayed old push call before replacement',
    run: async () => {
      const delayedOld = deferred(); const getEpochs = []; const closedEpochs = [];
      const push = {
        async get({ epoch }) {
          getEpochs.push(epoch);
          if (getEpochs.length === 1) return delayedOld.promise;
          if (getEpochs.length === 2) return { status: 'queue_empty', remaining: { ready: 0, working: 0, needsYou: 0 } };
          return { status: 'served', handoffCode: 'PUSH-ADA-AFTER-DRAIN', task: 'job-scoring', prompt: 'Synthetic Ada post-drain scoring prompt.', remaining: { ready: 0, working: 0, needsYou: 0 } };
        },
        async submit() { return { status: 'unknown_handoff' }; },
        closeEpoch(epoch) { closedEpochs.push(epoch); },
      };
      const engine = createHandoffEngine({ sources: { application: source().api, push }, scope: { applications: false, scoring: true }, holdMs: 0 });
      const oldChat = await engine.newChat({ linkId: LINK });
      const stale = engine.get({ session: oldChat.sessionCode, linkId: LINK });
      await new Promise(resolve => setImmediate(resolve));
      // Same-generation duplicate GETs now deliberately attach to the first
      // request. A power resume makes this a real new generation, so it must
      // still be able to poll/drain while the old source call is fenced off.
      assert(engine.onPowerResume(), 'the source generation can resume while an old push GET is pending');
      const draining = await engine.get({ session: oldChat.sessionCode, linkId: LINK });
      assert(draining.status === 'queue_empty' && JSON.stringify(getEpochs) === JSON.stringify(['epoch-1', 'epoch-1'])
        && engine.snapshot().chat.ordinal === 0, 'a new-generation empty GET must retire the old epoch to null while both calls used epoch-1');

      delayedOld.resolve({ status: 'served', handoffCode: 'PUSH-MARISOL-LATE', task: 'job-scoring', prompt: 'Synthetic Marisol late scoring prompt.', remaining: { ready: 0, working: 0, needsYou: 0 } });
      assert((await stale).status === 'retry', 'a delayed call that resumes after drain-to-null must never serve');
      const nullEpoch = engine.snapshot();
      assert(nullEpoch.chat.ordinal === 0 && nullEpoch.chat.calls === 0 && nullEpoch.chat.bytesServed === 0 && nullEpoch.counts.getServed === 0
        && closedEpochs.every(epoch => epoch === 'epoch-1'), 'the delayed old call must not resurrect or mutate the null epoch');

      const replacement = await engine.newChat({ linkId: LINK });
      const fresh = await engine.get({ session: replacement.sessionCode, linkId: LINK });
      assert(fresh.status === 'served' && fresh.handoffCode === 'PUSH-ADA-AFTER-DRAIN'
        && JSON.stringify(getEpochs) === JSON.stringify(['epoch-1', 'epoch-1', 'epoch-2']), 'a fresh chat after drain must work with a new epoch id');
    },
  },
);

// ---------------------------------------------------------------------------
// Discard / release hygiene (2026-09-30 incident: a discarded bundle's released
// lane leaked; one lane was "released" three times by auto-release keep-alives).
function recorders() {
  const audit = []; const logs = []; const saves = [];
  return {
    audit, logs, saves,
    port: {
      audit: { append: (event, fields) => { audit.push({ event, fields }); return Promise.resolve(true); } },
      logger: { record: (code, fields) => { logs.push({ code, fields }); } },
      store: { saveLanes: async lanes => { saves.push(lanes.map(lane => ({ jobId: lane.jobId, phase: lane.phase }))); return true; } },
    },
  };
}

tests.push(
  {
    name: 'handoff bridge: engine: releasing a job that already has a lane is a true no-op, and only real additions are counted',
    run: async () => {
      const rec = recorders(); const clock = createFakeClock();
      const engine = createHandoffEngine({ source: source().api, now: clock.now, timers: clock, holdMs: 0, ...rec.port });
      const first = await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      const second = await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      const third = await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      assert(first.ok && first.count === 1 && JSON.stringify(first.added) === JSON.stringify([JOB_A]), 'the first release adds the lane');
      assert(second.ok && second.count === 0 && third.count === 0 && second.added.length === 0, 're-releasing reports that it added nothing');
      assert(rec.saves.length === 1, 'a no-op release must not rewrite lanes.json');
      assert(rec.audit.filter(row => row.event === 'release').length === 1 && rec.logs.filter(row => row.code === 'release').length === 1,
        'one lane means one release audit row and one release log line, not one per keep-alive');
      assert(rec.audit[0].fields.count === 1 && rec.logs[0].fields.count === 1, 'the recorded count is the number actually added');
      const counts = engine.snapshot().counts;
      assert(counts.releaseCalls === 3 && counts.releaseNoops === 2, 'the no-ops are visible to a bug report as counters');
      assert(engine.snapshot().queue.jobs.length === 1, 'still exactly one lane');
    },
  },
  {
    name: 'handoff bridge: engine: a no-op release does not count as human activity, so the idle pause still engages',
    run: async () => {
      const clock = createFakeClock();
      const fake = source();
      const engine = createHandoffEngine({ source: fake.api, now: clock.now, timers: clock, holdMs: 0, limits: { idlePauseMinutes: 60 } });
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      const chat = await engine.newChat({ linkId: LINK });
      clock.advance(59 * 60_000);
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] }); // an unattended keep-alive
      clock.advance(2 * 60_000);
      const result = await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(result.status === 'paused', `an unattended re-release must not reset the idle clock (got ${result.status})`);
    },
  },
  {
    name: 'handoff bridge: engine: dropLane frees a served lane, its code and its chat slot, and nothing more is served for it',
    run: async () => {
      const rec = recorders(); const clock = createFakeClock(); let discarded = false; let sourceCalls = 0;
      const gone = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      const engine = createHandoffEngine({
        source: source({
          read: async ({ jobId }) => { sourceCalls++; if (discarded) throw gone; return { kind: 'open', handoff: handoff({ jobId }) }; },
          status: async () => { sourceCalls++; return discarded ? { kind: 'gone' } : { kind: 'host' }; },
        }).api,
        now: clock.now, timers: clock, holdMs: 0, ...rec.port,
      });
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      const chat = await engine.newChat({ linkId: LINK });
      const first = await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(first.status === 'served' && engine.snapshot().chat.jobsAssigned === 1, 'the bundle is served once while it exists');

      discarded = true;
      const dropped = await engine.dropLane(JOB_A, 'bundle_discarded');
      assert(dropped.ok === true, 'the app can retire the lane');
      const snap = engine.snapshot();
      assert(snap.queue.jobs.length === 0 && snap.queue.applications.working === 0 && snap.queue.applications.ready === 0 && snap.chat.jobsAssigned === 0,
        'the lane no longer occupies capacity or a chat slot');
      assert(snap.counts.lanesDropped === 1 && snap.counts.unreleaseCalls === 0, 'an app-driven drop is counted apart from a person\'s Unrelease');
      const late = await engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: first.handoffCode, response: answer({ code: first.handoffCode }) });
      assert(late.status === 'superseded', `an answer to the retired code is told it was superseded, not treated as a forged code (got ${late.status})`);
      const callsBefore = sourceCalls;
      const second = await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(second.status !== 'served' && !JSON.stringify(second).includes('Synthetic application prompt'), 'the discarded bundle\'s cached prompt is never served again');
      assert(sourceCalls === callsBefore, 'nothing is read for a lane that no longer exists');
      const row = rec.audit.filter(item => item.event === 'unrelease').pop();
      assert(row?.fields?.cause === 'bundle_discarded', 'the audit row records the closed cause');
      assert(rec.logs.some(item => item.code === 'unrelease' && item.fields.cause === 'bundle_discarded'), 'the log line records the closed cause');
      assert((await engine.dropLane(JOB_A)).code === 'not_found', 'dropping a lane that is not there is a quiet miss');
      assert((await engine.dropLane(JOB_B, 'a free text cause')).code === 'not_found', 'an unknown cause is never recorded verbatim');
    },
  },
  {
    name: 'handoff bridge: engine: dropLane rolls back when the lane store refuses the write',
    run: async () => {
      let ok = true; const clock = createFakeClock();
      const engine = createHandoffEngine({ source: source().api, now: clock.now, timers: clock, holdMs: 0, store: { saveLanes: async () => ok } });
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      ok = false;
      assert((await engine.dropLane(JOB_A)).code === 'persist_failed' && engine.snapshot().queue.jobs.length === 1, 'a failed write keeps the lane');
      assert(engine.snapshot().fault === 'persist_failed', 'and reports the fault');
      ok = true;
      assert((await engine.dropLane(JOB_A)).ok === true && engine.snapshot().queue.jobs.length === 0, 'the retry succeeds');
      assert(engine.snapshot().fault === null, 'a later successful write clears the persist fault instead of leaving the bridge faulted until restart');
    },
  },
  {
    name: 'handoff bridge: engine: finished and vanished lanes are never restored, and a resumed one is re-read rather than stuck',
    run: async () => {
      const clock = createFakeClock();
      const engine = createHandoffEngine({
        source: source().api, now: clock.now, timers: clock, holdMs: 0,
        restoredLanes: [
          { ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, releasedAt: 1, phase: 'gone', reason: null, heldFrom: null, counters: {} },
          { ord: 2, jobId: JOB_B, canvasFilePath: PATH_B, releasedAt: 2, phase: 'unread', reason: null, heldFrom: null, counters: {} },
        ],
      });
      const jobs = engine.snapshot().queue.jobs;
      assert(jobs.length === 1 && jobs[0].jobId === JOB_B && jobs[0].phase === 'held' && jobs[0].reason === 'restart', 'only the live lane comes back, held for restart');
      const lane = createApplicationLane({ ord: 9, jobId: JOB_A, canvasFilePath: PATH_A, releasedAt: 1, phase: 'held' });
      lane.heldFrom = 'gone';
      resumeLane(lane);
      assert(lane.phase === 'unread', 'resuming a lane held from a terminal phase re-reads it instead of restoring a snapshot-less terminal lane');
    },
  },
  {
    name: 'handoff bridge: engine: a lane whose bundle vanished reaches gone and is pruned after the hour',
    run: async () => {
      const clock = createFakeClock(); const rec = recorders();
      const engine = createHandoffEngine({
        source: source().api, now: clock.now, timers: clock, holdMs: 0, ...rec.port,
      });
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      const chat = await engine.newChat({ linkId: LINK });
      // Vanish the bundle via a status read so the lane goes terminal.
      const goneEngine = createHandoffEngine({
        source: source({ read: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); }, status: async () => ({ kind: 'gone' }) }).api,
        now: clock.now, timers: clock, holdMs: 0, ...rec.port,
      });
      await goneEngine.release({ jobs: [{ jobId: JOB_B, canvasFilePath: PATH_B }] });
      const goneChat = await goneEngine.newChat({ linkId: LINK });
      await goneEngine.get({ session: goneChat.sessionCode, linkId: LINK });
      assert(goneEngine.snapshot().queue.jobs[0]?.phase === 'gone', 'the lane reaches gone when its bundle vanishes');
      clock.advance(61 * 60_000);
      await goneEngine.tick();
      assert(goneEngine.snapshot().queue.jobs.length === 0, 'and is pruned after the hour');
      assert(chat.copied, 'the unrelated engine is unaffected');
    },
  },
  {
    name: 'handoff bridge: engine: an answer for a bundle that vanished mid-chat gets a definite answer, not an endless retry',
    run: async () => {
      const clock = createFakeClock(); let discarded = false;
      const enoent = () => Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      const engine = createHandoffEngine({
        source: source({
          read: async ({ jobId }) => { if (discarded) throw enoent(); return { kind: 'open', handoff: handoff({ jobId }) }; },
          status: async () => (discarded ? { kind: 'gone' } : { kind: 'host' }),
          submit: async () => { throw enoent(); },
        }).api,
        now: clock.now, timers: clock, holdMs: 0,
      });
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      const chat = await engine.newChat({ linkId: LINK });
      const served = await engine.get({ session: chat.sessionCode, linkId: LINK });
      discarded = true;
      const reply = await engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: served.handoffCode, response: answer({ code: served.handoffCode }) });
      assert(reply.status === 'unknown_handoff', `a submit for a vanished bundle is answered definitively (got ${reply.status})`);
      assert(engine.snapshot().queue.jobs[0]?.phase === 'gone', 'and the lane is marked gone');
    },
  },
  {
    name: 'handoff bridge: engine: a lane that goes gone gives its chat slot back so a live job can be served',
    run: async () => {
      const clock = createFakeClock(); let aGone = false;
      const enoent = () => Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      const engine = createHandoffEngine({
        source: source({
          read: async ({ jobId }) => {
            if (jobId === JOB_A && aGone) throw enoent();
            return { kind: 'open', handoff: handoff({ code: jobId === JOB_B ? 'HANDOFF-B' : 'HANDOFF-A', jobId }) };
          },
          status: async ({ jobId }) => (jobId === JOB_A && aGone ? { kind: 'gone' } : { kind: 'host' }),
        }).api,
        now: clock.now, timers: clock, holdMs: 0, limits: { jobsPerChat: 1 },
      });
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      const chat = await engine.newChat({ linkId: LINK });
      assert((await engine.get({ session: chat.sessionCode, linkId: LINK })).status === 'served', 'the only slot is used by job A');
      aGone = true;
      await engine.release({ jobs: [{ jobId: JOB_B, canvasFilePath: PATH_B }] });
      engine.hint({ jobId: JOB_A });
      const next = await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(engine.snapshot().queue.jobs.find(job => job.jobId === JOB_A)?.phase === 'gone', 'the vanished bundle is discovered on the next poll');
      assert(next.status === 'served' && next.handoffCode === 'HANDOFF-B', `the dead job's slot is released for the live one (got ${next.status})`);
    },
  },
  {
    name: 'handoff bridge: engine: terminal lanes do not count against the lane cap or block the persist',
    run: async () => {
      const directory = cleanDirectory(); const clock = createFakeClock();
      try {
        const store = createLaneStore({ userDataPath: directory });
        let vanished = false;
        const engine = createHandoffEngine({
          source: source({
            read: async ({ jobId }) => { if (vanished) throw Object.assign(new Error('x'), { code: 'ENOENT' }); return { kind: 'open', handoff: handoff({ jobId }) }; },
            status: async () => (vanished ? { kind: 'gone' } : { kind: 'host' }),
          }).api,
          now: clock.now, timers: clock, holdMs: 0, store,
        });
        const ids = Array.from({ length: CONSTANTS.MAX_LANES }, (_, index) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`);
        assert((await engine.release({ jobs: ids.map(jobId => ({ jobId, canvasFilePath: PATH_A })) })).ok, 'a full set of live lanes releases');
        vanished = true;
        const chat = await engine.newChat({ linkId: LINK });
        for (let index = 0; index < ids.length + 1; index += 1) await engine.get({ session: chat.sessionCode, linkId: LINK });
        assert(engine.snapshot().queue.jobs.every(job => job.phase === 'gone'), 'every lane has vanished');
        const fresh = await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
        assert(fresh.ok === true, `a new release must not fail persist_failed just because ${ids.length} dead lanes linger (got ${fresh.code})`);
        assert(store.readLanes().length === 1 && store.readLanes()[0].jobId === JOB_A, 'only the live lane is persisted; dead lanes are not written back');
        assert(engine.snapshot().fault === null, 'and the engine is not faulted');
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    },
  },
);

tests.push(
  {
    name: 'handoff bridge: engine: the lane store persists live lanes only, under the same cap the engine enforces',
    run: async () => {
      assert(MAX_LIVE_LANES === CONSTANTS.MAX_LANES, 'the store cap and the engine release cap are one rule');
      const directory = cleanDirectory();
      try {
        const store = createLaneStore({ userDataPath: directory });
        const lane = (ord, phase) => ({ ord, jobId: `bbbbbbbb-bbbb-4bbb-8bbb-${String(ord).padStart(12, '0')}`, canvasFilePath: PATH_A, releasedAt: ord, phase, reason: null, heldFrom: null, counters: {} });
        const live = Array.from({ length: MAX_LIVE_LANES }, (_, index) => lane(index + 1, 'awaiting'));
        const dead = Array.from({ length: 5 }, (_, index) => lane(100 + index, index % 2 ? 'done' : 'gone'));
        assert(await store.saveLanes([...live, ...dead]) === true, 'dead lanes beside a full set of live ones must not make the save fail');
        assert(store.readLanes().length === MAX_LIVE_LANES && store.readLanes().every(item => item.phase === 'awaiting'), 'only live lanes reach disk');
        assert(await store.saveLanes([...live, lane(50, 'unread')]) === false, 'more live lanes than the cap is still refused');
        // A file written by an older build holds a gone lane beside 10 live ones.
        fs.writeFileSync(store.lanesPath, `${JSON.stringify({ v: 1, lanes: [...live.slice(0, 9), lane(200, 'gone'), lane(201, 'done')] })}\n`);
        const loaded = store.loadLanes(5);
        assert(loaded.length === 9 && loaded.every(item => item.phase === 'held' && item.reason === 'restart'), 'a persisted terminal lane is dropped at load, never resurrected as a restart hold');
        assert(store.readLanes().length === 9, 'and the raw view the enable sheet reads omits it too');
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    },
  },
);


// ---------------------------------------------------------------------------
// Stranded lanes, serve-time revalidation, stall detection and per-job answer
// tracking (2026-09-30 review).
const settle = async () => { for (let index = 0; index < 8; index += 1) await new Promise(resolve => setImmediate(resolve)); };

tests.push(
  {
    name: 'handoff bridge: engine: a lane restored for a bundle that is proven gone is dropped at restore, a transient probe error never drops one, and probing is bounded',
    run: async () => {
      const rec = recorders(); const clock = createFakeClock();
      const JOB_C = '33333333-3333-4333-8333-333333333333';
      const JOB_D = '44444444-4444-4444-8444-444444444444';
      const JOB_E = '55555555-5555-4555-8555-555555555555';
      const probes = { [JOB_A]: 0, [JOB_B]: 0, [JOB_C]: 0, [JOB_D]: 0, [JOB_E]: 0 };
      let cLatched = false;
      const lane = (ord, jobId) => ({ ord, jobId, canvasFilePath: PATH_A, releasedAt: ord, phase: 'unread', reason: null, heldFrom: null, counters: {} });
      const engine = createHandoffEngine({
        source: source({ status: async ({ jobId }) => {
          probes[jobId] += 1;
          if (jobId === JOB_A) return { kind: 'gone' };                                    // discarded / pruned / deleted by hand
          if (jobId === JOB_B) throw Object.assign(new Error('ENOENT: canvas'), { code: 'ENOENT' }); // transient: proves nothing
          if (jobId === JOB_C) return cLatched ? { kind: 'gone' } : { kind: 'busy' };      // unknown at first, proven on a later tick
          if (jobId === JOB_D) return { kind: 'done' };                                    // saved tombstone
          return { kind: 'host' };                                                          // alive
        } }).api,
        now: clock.now, timers: clock, holdMs: 0, ...rec.port,
        restoredLanes: [lane(1, JOB_A), lane(2, JOB_B), lane(3, JOB_C), lane(4, JOB_D), lane(5, JOB_E)],
      });
      assert(engine.snapshot().queue.jobs.length === 5, 'all five restore as held/restart before any probe answers');
      await settle();
      const ids = () => engine.snapshot().queue.jobs.map(job => job.jobId);
      assert(!ids().includes(JOB_A) && !ids().includes(JOB_D), `a proven-gone lane (status gone) and a saved tombstone are dropped at restore, got ${ids()}`);
      assert(ids().includes(JOB_B) && ids().includes(JOB_C) && ids().includes(JOB_E), 'a thrown error, a busy answer and a live bundle each keep their lane');
      const causes = rec.logs.filter(item => item.code === 'unrelease').map(item => `${item.fields.kind}/${item.fields.cause}`).sort();
      assert(JSON.stringify(causes) === JSON.stringify(['application/bundle_missing', 'application/bundle_saved']), `each drop is logged with its closed cause, got ${causes}`);
      assert(rec.audit.filter(row => row.event === 'unrelease').every(row => ['bundle_missing', 'bundle_saved'].includes(row.fields.cause)), 'and audited with it');
      assert(engine.snapshot().counts.lanesDropped === 2 && engine.snapshot().counts.unreleaseCalls === 0, 'counted as app-driven drops, not a person\'s Unrelease');
      assert(JSON.stringify(rec.saves.at(-1).map(item => item.jobId).sort()) === JSON.stringify([JOB_B, JOB_C, JOB_E].sort()), 'the durable lanes no longer carry the dropped ones');

      // A later tick retries the lane that could not be checked, and proves it.
      cLatched = true;
      await engine.tick(); await settle();
      assert(!ids().includes(JOB_C), 'the lane whose probe was inconclusive is dropped once a later probe proves it gone');
      // Probing is bounded: a lane that keeps erroring is not polled forever.
      for (let round = 0; round < 12; round += 1) { await engine.tick(); await settle(); }
      assert(probes[JOB_B] === 5 && ids().includes(JOB_B), `an always-erroring lane is probed a bounded number of times and never dropped (probed ${probes[JOB_B]})`);
      assert(probes[JOB_A] === 1, 'a dropped lane is not probed again');
    },
  },
  {
    name: 'handoff bridge: engine: a served prompt is revalidated before every serve; a bundle removed outside Discard is dropped and the next job is served',
    run: async () => {
      const rec = recorders(); const clock = createFakeClock();
      const state = { aGone: false, statusError: false }; const probed = [];
      const engine = createHandoffEngine({
        source: source({
          read: async ({ jobId }) => ({ kind: 'open', handoff: handoff({ code: jobId === JOB_B ? 'HANDOFF-B' : 'HANDOFF-A', jobId, prompt: `Synthetic prompt for ${jobId === JOB_B ? 'B' : 'A'}.` }) }),
          status: async ({ jobId }) => {
            probed.push(jobId);
            if (jobId === JOB_A && state.statusError) throw Object.assign(new Error('EIO'), { code: 'EIO' });
            return jobId === JOB_A && state.aGone ? { kind: 'gone' } : { kind: 'host' };
          },
        }).api,
        now: clock.now, timers: clock, holdMs: 0, ...rec.port,
      });
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      await engine.release({ jobs: [{ jobId: JOB_B, canvasFilePath: PATH_B }] });
      const chat = await engine.newChat({ linkId: LINK });
      const first = await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(first.status === 'served' && first.handoffCode === 'HANDOFF-A', 'the first lane is served while its bundle exists');
      assert(probed.includes(JOB_A), 'a serve confirms the bundle exists first');
      // Re-serve after a transient probe failure: still served, never dropped.
      state.statusError = true;
      const again = await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(again.status === 'served' && again.handoffCode === 'HANDOFF-A' && engine.snapshot().queue.jobs.length === 2, 'a transient status error must not drop the lane or stop the serve');
      // The bundle is deleted by hand (no Discard, no event).
      state.statusError = false; state.aGone = true;
      const next = await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(next.status === 'served' && next.handoffCode === 'HANDOFF-B' && !JSON.stringify(next).includes('prompt for A'), `the cached prompt of the removed bundle is not re-served; the next job is (got ${next.status})`);
      assert(engine.snapshot().queue.jobs.map(job => job.jobId).join() === JOB_B, 'the removed bundle\'s lane is dropped');
      assert(rec.logs.some(item => item.code === 'unrelease' && item.fields.cause === 'bundle_missing') && rec.audit.some(row => row.event === 'unrelease' && row.fields.cause === 'bundle_missing'), 'with the closed cause in the log and the audit');
      const late = await engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: first.handoffCode, response: answer({ code: first.handoffCode }) });
      assert(late.status === 'superseded', `an answer to the dropped lane's code is told it was superseded, got ${late.status}`);
      // No next job at all: an honest empty answer.
      state.aGone = false;
      const lone = createHandoffEngine({ source: source({ status: async () => ({ kind: 'gone' }) }).api, now: clock.now, timers: clock, holdMs: 0 });
      await lone.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      const loneChat = await lone.newChat({ linkId: LINK });
      const empty = await lone.get({ session: loneChat.sessionCode, linkId: LINK });
      assert(empty.status === 'queue_empty' && lone.snapshot().queue.jobs.length === 0, `a lone removed bundle serves queue_empty, got ${empty.status}`);
    },
  },
  {
    name: 'handoff bridge: engine: a lane served to the current chat becomes a bounded response-overdue warning after STALL_NOTICE_MS',
    run: async () => {
      const clock = createFakeClock();
      const engine = createHandoffEngine({
        source: source({ submit: async () => ({ kind: 'accepted', completed: false, handoff: handoff({ code: 'HANDOFF-NEXT', stage: 'cover-letter' }) }) }).api,
        now: clock.now, timers: clock, holdMs: 0,
      });
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      await engine.release({ jobs: [{ jobId: JOB_B, canvasFilePath: PATH_B }] });
      const chat = await engine.newChat({ linkId: LINK });
      const beforeServe = engine.snapshot();
      assert(beforeServe.chat.outstanding === null && beforeServe.queue.jobs.every(job => job.awaitingAnswer === false && job.stalled === false), 'nothing served, nothing outstanding');
      const first = await engine.get({ session: chat.sessionCode, linkId: LINK });
      const servedAt = clock.now();
      let snap = engine.snapshot();
      const jobA = () => engine.snapshot().queue.jobs.find(job => job.jobId === JOB_A);
      assert(snap.chat.outstanding?.stalled === false && snap.chat.outstanding.stalledSince === null && snap.chat.outstanding.servedAt === servedAt, 'freshly served is not stalled');
      clock.advance(CONSTANTS.STALL_NOTICE_MS + 8 * 60_000);
      snap = engine.snapshot();
      assert(snap.chat.outstanding.stalled === true && jobA().stalled === true && jobA().awaitingAnswer === true && jobA().servedAt === servedAt,
        'an unanswered handoff becomes a response-overdue warning on its owning chat and job row');
      assert(snap.chat.outstanding.stallsLastHour === 1, 'an answer-silent handoff records one bounded stale interval');
      // Reading status again cannot multiply the same stale interval.
      await engine.tick(); engine.snapshot();
      assert(engine.snapshot().chat.outstanding.stallsLastHour === 1, 'polling status does not duplicate the same response-overdue interval');
      // An accepted answer moves the job to the next stage.
      await engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: first.handoffCode, response: answer({ code: first.handoffCode, stage: first.stage }) });
      snap = engine.snapshot();
      assert(snap.chat.outstanding?.stalled === false && jobA().stalled === false && jobA().awaitingAnswer === true && jobA().answeredAt === clock.now(), 'an accepted submit clears the prior warning and starts the successor response grace period');
      clock.advance(CONSTANTS.STALL_NOTICE_MS + 8 * 60_000);
      assert(engine.snapshot().chat.outstanding.stalled === true && engine.snapshot().chat.outstanding.stallsLastHour === 2, 'a later unanswered successor has its own response-overdue interval');
      // A new chat never inherits an outstanding answer for work it was not served.
      await engine.newChat({ linkId: LINK });
      snap = engine.snapshot();
      assert(snap.chat.outstanding === null && jobA().stalled === false && jobA().awaitingAnswer === false && jobA().servedAt === null, 'a lane served to a previous chat is neither outstanding nor awaiting for the new one');
    },
  },
  {
    name: 'handoff bridge: engine: per-job answer tracking separates "ChatGPT is answering THIS job" from "the answer was accepted and the next stage is not served yet"',
    run: async () => {
      const clock = createFakeClock(); let next = null;
      const engine = createHandoffEngine({
        source: source({ submit: async () => (next ? { kind: 'accepted', completed: false, handoff: next } : { kind: 'accepted', completed: true }) }).api,
        now: clock.now, timers: clock, holdMs: 0, limits: { jobsPerChat: 2 },
      });
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }, { jobId: JOB_B, canvasFilePath: PATH_B }] });
      const chat = await engine.newChat({ linkId: LINK });
      const jobOf = id => engine.snapshot().queue.jobs.find(job => job.jobId === id);
      const a = await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(a.status === 'served' && jobOf(JOB_A).awaitingAnswer === true && jobOf(JOB_B).awaitingAnswer === false && jobOf(JOB_B).servedAt === null,
        'only the served job is being answered; the other lane, though released, is not');
      assert(engine.snapshot().chat.outstanding.stage === jobOf(JOB_A).stage, 'and chat.outstanding agrees while there is a single job');
      // Accepted with NO next stage handed back yet (host builds the documents).
      const done = await engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: a.handoffCode, response: answer({ code: a.handoffCode, stage: a.stage }) });
      assert(done.status === 'accepted' && done.jobComplete === true, 'the answer is accepted');
      assert(jobOf(JOB_A).awaitingAnswer === false && jobOf(JOB_A).answeredAt === clock.now() && jobOf(JOB_A).servedAt === null && jobOf(JOB_A).stalled === false,
        'an accepted answer with nothing served after it is answered, not awaited');
      clock.advance(CONSTANTS.STALL_NOTICE_MS * 3);
      assert(jobOf(JOB_A).stalled === false && engine.snapshot().chat.outstanding === null, 'and a job nobody owes an answer for never stalls');
      // The second job is served after the first: outstanding is THIS job, not the first served one.
      const b = await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(b.status === 'served' && jobOf(JOB_B).awaitingAnswer === true && jobOf(JOB_B).servedAt === clock.now() && jobOf(JOB_A).awaitingAnswer === false,
        'the second job is awaited; the first is not, even though it was served earlier');
      // A rejected answer keeps the job awaited without treating response time as failure.
      const rejectEngine = createHandoffEngine({ source: source({ submit: async () => ({ kind: 'rejected', validationErrors: ['fix it'], handoff: handoff({ code: 'HANDOFF-A2' }) }) }).api, now: clock.now, timers: clock, holdMs: 0 });
      await rejectEngine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      const rejectChat = await rejectEngine.newChat({ linkId: LINK });
      const served = await rejectEngine.get({ session: rejectChat.sessionCode, linkId: LINK });
      clock.advance(CONSTANTS.STALL_NOTICE_MS + 8 * 60_000);
      const beforeReject = rejectEngine.snapshot().queue.jobs[0];
      assert(beforeReject.stalled === true, 'a delayed answer becomes response-overdue without being revoked');
      const rejected = await rejectEngine.submit({ session: rejectChat.sessionCode, linkId: LINK, handoffCode: served.handoffCode, response: answer({ code: served.handoffCode, stage: served.stage }) });
      assert(rejected.status === 'rejected', 'the answer is rejected');
      const afterReject = rejectEngine.snapshot().queue.jobs[0];
      assert(afterReject.awaitingAnswer === true && afterReject.answeredAt === null && afterReject.stalled === false,
        'a rejected answer is not an accepted one (still awaited) and the chat was just heard, so it is not stalled');
      clock.advance(CONSTANTS.STALL_NOTICE_MS + 8 * 60_000);
      assert(rejectEngine.snapshot().queue.jobs[0].stalled === true, 'a correction response also becomes response-overdue if the worker stays silent again');
    },
  },
  {
    name: 'handoff bridge: engine: a lane that changes during the serve-time probe is re-validated, never served stale (completed, discarded or held mid-probe)',
    run: async () => {
      const setup = async () => {
        const clock = createFakeClock(); const hold = { armed: false, gate: null };
        const engine = createHandoffEngine({
          source: source({
            status: async () => { if (hold.armed) { hold.armed = false; await hold.gate.promise; } return { kind: 'host' }; },
            read: async ({ jobId }) => ({ kind: 'open', handoff: handoff({ code: jobId === JOB_B ? 'HANDOFF-B' : 'HANDOFF-A', jobId, prompt: `Synthetic prompt for ${jobId === JOB_B ? 'B' : 'A'}.` }) }),
          }).api,
          now: clock.now, timers: clock, holdMs: 0,
        });
        await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
        await engine.release({ jobs: [{ jobId: JOB_B, canvasFilePath: PATH_B }] });
        const chat = await engine.newChat({ linkId: LINK });
        const first = await engine.get({ session: chat.sessionCode, linkId: LINK });
        assert(first.status === 'served' && first.handoffCode === 'HANDOFF-A', 'the first lane is served');
        const probeHeld = () => { hold.armed = true; hold.gate = deferred(); return engine.get({ session: chat.sessionCode, linkId: LINK }).then(value => ({ value }), error => ({ error })); };
        return { engine, chat, first, hold, probeHeld };
      };
      // (a) The answer completing the job arrives while the next get is probing.
      {
        const { engine, chat, first, hold, probeHeld } = await setup();
        const pending = probeHeld();
        await settle();
        const done = await engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: first.handoffCode, response: answer({ code: first.handoffCode, stage: first.stage }) });
        assert(done.status === 'accepted' && done.jobComplete === true, 'the answer completing the job is accepted mid-probe');
        hold.gate.resolve();
        const outcome = await pending;
        assert(!outcome.error, `a lane that completed during the probe must not throw, got ${outcome.error?.message}`);
        assert(outcome.value.status === 'served' ? outcome.value.handoffCode === 'HANDOFF-B' : true, 'and the finished lane\'s prompt is never re-served');
        assert(engine.snapshot().queue.jobs.find(job => job.jobId === JOB_A).phase === 'host', 'the completed lane stays with the app');
      }
      // (b) The bundle is discarded while the next get is probing.
      {
        const { engine, chat, hold, probeHeld } = await setup();
        const pending = probeHeld();
        await settle();
        assert((await engine.dropLane(JOB_A, 'bundle_discarded')).ok, 'the discard frees the lane mid-probe');
        hold.gate.resolve();
        const outcome = await pending;
        assert(!outcome.error && outcome.value.status === 'served' && outcome.value.handoffCode === 'HANDOFF-B',
          `a removed lane is not served; the next job is (got ${outcome.error?.message ?? `${outcome.value.status} ${outcome.value.handoffCode}`})`);
        const snap = engine.snapshot();
        assert(snap.queue.jobs.map(job => job.jobId).join() === JOB_B && snap.chat.jobsAssigned === 1,
          `the removed lane must not re-take a chat slot, got ${snap.queue.jobs.length} lane(s) and ${snap.chat.jobsAssigned} assigned`);
        assert(chat.sessionCode, 'chat stays valid');
      }
      // (c) The person holds the lane while the next get is probing.
      {
        const { engine, hold, probeHeld } = await setup();
        const pending = probeHeld();
        await settle();
        assert((await engine.hold(JOB_A)).ok, 'the person holds the lane mid-probe');
        hold.gate.resolve();
        const outcome = await pending;
        assert(!outcome.error && outcome.value.status === 'served' && outcome.value.handoffCode === 'HANDOFF-B',
          `a held lane is not served; the next job is (got ${outcome.error?.message ?? `${outcome.value.status} ${outcome.value.handoffCode}`})`);
      }
    },
  },
  {
    name: 'handoff bridge: engine: response age creates one bounded stale timestamp and a rejected answer restarts it',
    run: async () => {
      const clock = createFakeClock();
      const engine = createHandoffEngine({
        source: source({ submit: async () => ({ kind: 'rejected', validationErrors: ['fix it'], handoff: handoff({ code: 'HANDOFF-A2' }) }) }).api,
        now: clock.now, timers: clock, holdMs: 0,
      });
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      const chat = await engine.newChat({ linkId: LINK });
      const first = await engine.get({ session: chat.sessionCode, linkId: LINK });
      clock.advance(CONSTANTS.STALL_NOTICE_MS + 4 * 60_000);
      let snap = engine.snapshot();
      assert(snap.chat.outstanding.stalled === true && snap.chat.outstanding.stalledSince !== null && snap.queue.jobs[0].stalledSince !== null,
        'a slow first answer creates a bounded stale timestamp');
      const rejected = await engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: first.handoffCode, response: answer({ code: first.handoffCode, stage: first.stage }) });
      assert(rejected.status === 'rejected', 'a rejected answer restarts the quiet clock');
      clock.advance(CONSTANTS.STALL_NOTICE_MS + 2 * 60_000);
      snap = engine.snapshot();
      assert(snap.queue.jobs[0].stalledSince !== null && snap.chat.outstanding.stalledSince !== null,
        'the corrected answer gets a fresh response-overdue timestamp only after another full grace period');
    },
  },
  {
    name: 'handoff bridge: engine: holds and pauses reset stale evidence, while a re-served unanswered lane can become response-overdue',
    run: async () => {
      // Per-job hold, then resume.
      {
        const clock = createFakeClock();
        const engine = createHandoffEngine({ source: source().api, now: clock.now, timers: clock, holdMs: 0 });
        await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
        const chat = await engine.newChat({ linkId: LINK });
        await engine.get({ session: chat.sessionCode, linkId: LINK });
        assert((await engine.hold(JOB_A)).ok, 'the person holds the job');
        clock.advance(21 * 60_000);
        const jobA = () => engine.snapshot().queue.jobs[0];
        assert(jobA().phase === 'held' && jobA().stalled === false, 'a held job is not stalled');
        assert((await engine.resume({ jobId: JOB_A })).ok, 'and is resumed');
        assert(jobA().stalled === false && engine.snapshot().chat.outstanding?.stalled !== true && (engine.snapshot().chat.outstanding?.stallsLastHour ?? 0) === 0,
          'ChatGPT was never able to answer during the hold, so resume is not an instant stall');
        assert(jobA().awaitingAnswer === false, 'and nothing was re-served, so no answer is claimed as owed');
        // The next serve is still working regardless of answer duration.
        clock.advance(60_000);
        await engine.get({ session: chat.sessionCode, linkId: LINK });
        const reservedAt = clock.now();
        assert(jobA().awaitingAnswer === true && jobA().servedAt === reservedAt, 'the next get serves it again and the wait starts there');
        clock.advance(CONSTANTS.STALL_NOTICE_MS + 8 * 60_000);
        assert(jobA().stalled === true && jobA().stalledSince === reservedAt && jobA().servedAt === reservedAt,
          'a re-served application becomes response-overdue only after its own full grace period');
      }
      // Bridge-wide pause, a refused submit, then resume.
      {
        const clock = createFakeClock();
        const engine = createHandoffEngine({ source: source().api, now: clock.now, timers: clock, holdMs: 0 });
        await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
        const chat = await engine.newChat({ linkId: LINK });
        const first = await engine.get({ session: chat.sessionCode, linkId: LINK });
        engine.pause('user');
        clock.advance(10 * 60_000);
        const refused = await engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: first.handoffCode, response: answer({ code: first.handoffCode, stage: first.stage }) });
        assert(refused.status === 'paused', 'ChatGPT\'s answer is turned away while paused');
        const jobA = () => engine.snapshot().queue.jobs[0];
        assert(jobA().stalled === false && engine.snapshot().chat.outstanding?.stalled !== true, 'a paused bridge reports no stall');
        await engine.resume();
        assert(jobA().stalled === false && (engine.snapshot().chat.outstanding?.stallsLastHour ?? 0) === 0, 'resume does not report an instant stall');
        clock.advance(CONSTANTS.STALL_NOTICE_MS + 8 * 60_000);
        assert(jobA().stalled === true && jobA().stalledSince !== null, 'a resumed unanswered application gets a fresh response-overdue warning after a full grace period');
      }
    },
  },
  {
    name: 'handoff bridge: engine: restore probes are spent only by a probe that ran and proved nothing; scope-off and conclusive answers spend none; an unresolved lane is retried slowly, not never',
    run: async () => {
      const lane = (ord, jobId) => ({ ord, jobId, canvasFilePath: PATH_A, releasedAt: ord, phase: 'unread', reason: null, heldFrom: null, counters: {} });
      const ids = engine => engine.snapshot().queue.jobs.map(job => job.jobId);
      // Applications scope off: nothing is probed and nothing is spent.
      {
        const clock = createFakeClock(); let calls = 0;
        const engine = createHandoffEngine({
          source: source({ status: async () => { calls += 1; return { kind: 'gone' }; } }).api,
          scope: { applications: false, scoring: true }, now: clock.now, timers: clock, holdMs: 0, restoredLanes: [lane(1, JOB_A)],
        });
        for (let round = 0; round < 8; round += 1) { await engine.tick(); await settle(); }
        assert(calls === 0 && ids(engine).includes(JOB_A), 'no probe runs while applications are off');
        engine.setScope({ applications: true });
        await engine.tick(); await settle();
        assert(calls === 1 && !ids(engine).includes(JOB_A), `re-enabling still probes the stranded lane (calls ${calls})`);
      }
      // A conclusive "alive" answer ends the probing for that lane.
      {
        const clock = createFakeClock(); let calls = 0;
        const engine = createHandoffEngine({
          source: source({ status: async () => { calls += 1; return { kind: 'host' }; } }).api,
          now: clock.now, timers: clock, holdMs: 0, restoredLanes: [lane(1, JOB_A)],
        });
        await settle();
        for (let round = 0; round < 10; round += 1) { await engine.tick(); await settle(); }
        assert(calls === 1 && ids(engine).includes(JOB_A), `a lane proven alive is probed once, not five times (calls ${calls})`);
      }
      // A lane whose probes keep failing is retried slowly and dropped once proven gone.
      {
        const clock = createFakeClock(); let calls = 0; let gone = false;
        const engine = createHandoffEngine({
          source: source({ status: async () => { calls += 1; if (gone) return { kind: 'gone' }; throw Object.assign(new Error('EIO'), { code: 'EIO' }); } }).api,
          now: clock.now, timers: clock, holdMs: 0, restoredLanes: [lane(1, JOB_A)],
        });
        await settle();
        for (let round = 0; round < 12; round += 1) { await engine.tick(); await settle(); }
        assert(calls === 5, `the fast retries are bounded at five, got ${calls}`);
        gone = true;
        clock.advance(2 * 60_000); await engine.tick(); await settle();
        assert(calls === 5 && ids(engine).includes(JOB_A), 'the slow retry waits for its interval');
        clock.advance(4 * 60_000); await engine.tick(); await settle();
        assert(calls === 6 && !ids(engine).includes(JOB_A), `after several minutes the lane is probed again and dropped once proven gone (calls ${calls})`);
      }
    },
  },
  {
    name: 'handoff bridge: engine: per-cause drop counters: discard, prune, missing and saved are counted apart and sum to lanesDropped',
    run: async () => {
      const clock = createFakeClock();
      const states = { [JOB_A]: 'gone', [JOB_B]: 'done' };
      const JOB_C = '33333333-3333-4333-8333-333333333333';
      const JOB_D = '44444444-4444-4444-8444-444444444444';
      const lane = (ord, jobId) => ({ ord, jobId, canvasFilePath: PATH_A, releasedAt: ord, phase: 'unread', reason: null, heldFrom: null, counters: {} });
      const engine = createHandoffEngine({
        source: source({ status: async ({ jobId }) => ({ kind: states[jobId] || 'host' }) }).api,
        now: clock.now, timers: clock, holdMs: 0, restoredLanes: [lane(1, JOB_A), lane(2, JOB_B), lane(3, JOB_C), lane(4, JOB_D)],
      });
      await settle();
      await engine.dropLane(JOB_C, 'bundle_discarded');
      await engine.dropLane(JOB_D, 'bundle_pruned');
      const counts = engine.snapshot().counts;
      assert(counts.lanesDropped === 4 && counts.droppedMissing === 1 && counts.droppedSaved === 1 && counts.droppedDiscarded === 1 && counts.droppedPruned === 1,
        `each cause is counted, got ${JSON.stringify(counts)}`);
    },
  },
  {
    name: 'handoff bridge: engine: a lane whose bundle is proven gone is never served even when the durable drop is refused, and is ended in memory',
    run: async () => {
      const clock = createFakeClock(); let persist = true; let statusCalls = 0;
      const engine = createHandoffEngine({
        source: source({ status: async () => { statusCalls += 1; return { kind: 'gone' }; } }).api,
        store: { saveLanes: async () => persist }, now: clock.now, timers: clock, holdMs: 0,
      });
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      const chat = await engine.newChat({ linkId: LINK });
      persist = false;
      const result = await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(result.status !== 'served', `a gone bundle is never served, got ${result.status}`);
      const job = engine.snapshot().queue.jobs.find(item => item.jobId === JOB_A);
      assert(job?.phase === 'gone' && statusCalls === 1, `the refused drop ends the lane in memory instead of re-probing it (phase ${job?.phase}, probes ${statusCalls})`);
    },
  },
  {
    name: 'handoff bridge: engine: submits, rotated handoffs, and delayed answers never fabricate a dead-chat stall',
    run: async () => {
      // A submit in flight is never a stall.
      {
        const clock = createFakeClock(); const gate = deferred();
        const engine = createHandoffEngine({ source: source({ submit: async () => { await gate.promise; return { kind: 'accepted', completed: true }; } }).api, now: clock.now, timers: clock, holdMs: 0 });
        await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
        const chat = await engine.newChat({ linkId: LINK });
        const first = await engine.get({ session: chat.sessionCode, linkId: LINK });
        const pending = engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: first.handoffCode, response: answer({ code: first.handoffCode, stage: first.stage }) });
        await settle();
        clock.advance(CONSTANTS.STALL_NOTICE_MS * 2);
        assert(engine.snapshot().queue.jobs[0].stalled === false, 'a submit that is still running is not a stall');
        gate.resolve(); await pending;
      }
      // Multiple outstanding paths remain working even when one was served earlier.
      {
        const clock = createFakeClock();
        const engine = createHandoffEngine({
          source: source({ read: async ({ jobId }) => ({ kind: 'open', handoff: handoff({ code: jobId === JOB_B ? 'HANDOFF-B' : 'HANDOFF-A', jobId }) }) }).api,
          now: clock.now, timers: clock, holdMs: 0, limits: { jobsPerChat: 2 },
        });
        await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }, { jobId: JOB_B, canvasFilePath: PATH_B }] });
        const chat = await engine.newChat({ linkId: LINK });
        await engine.get({ session: chat.sessionCode, linkId: LINK });
        assert((await engine.hold(JOB_A)).ok, 'the first job is held so the second can be served');
        const second = await engine.get({ session: chat.sessionCode, linkId: LINK });
        assert(second.status === 'served' && second.handoffCode === 'HANDOFF-B', 'the second job is served');
        clock.advance(4 * 60_000);
        assert((await engine.resume({ jobId: JOB_A })).ok, 'the first job is resumed later, so it is the fresher one');
        clock.advance(60_000);
        const snap = engine.snapshot();
        const rowOf = id => snap.queue.jobs.find(job => job.jobId === id);
        assert(rowOf(JOB_B).stalled === true && rowOf(JOB_A).stalled === false,
          'the older unanswered job is response-overdue while the recently resumed-but-unserved lane is not');
        assert(snap.chat.outstanding?.stalled === true && snap.chat.outstanding.stalledSince !== null,
          'the chat-wide projection identifies the actual silent owner rather than treating the fresher sibling as stalled');
      }
      // A handoff that replaces the one the chat was given clears the wait.
      {
        const clock = createFakeClock(); const hold = { armed: false, skip: 0, gate: null }; let mode = 'open-A';
        const engine = createHandoffEngine({
          source: source({
            read: async ({ jobId }) => (mode === 'host' ? { kind: 'host' } : { kind: 'open', handoff: handoff({ code: mode === 'open-B' ? 'HANDOFF-B' : 'HANDOFF-A', jobId }) }),
            // While the app offers the new handoff, a lane's status says it is open again.
            status: async () => { if (hold.armed && hold.skip-- <= 0) { hold.armed = false; await hold.gate.promise; } return mode === 'open-B' ? { kind: 'awaiting', phase: 'awaiting', read: true } : { kind: 'host' }; },
          }).api,
          now: clock.now, timers: clock, holdMs: 0,
        });
        await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
        const chat = await engine.newChat({ linkId: LINK });
        const firstServe = await engine.get({ session: chat.sessionCode, linkId: LINK });
        assert(firstServe.status === 'served' && firstServe.handoffCode === 'HANDOFF-A', 'the first handoff is served');
        // The app takes the job over (finished in the dock), then offers a new handoff.
        mode = 'host'; clock.advance(CONSTANTS.HINT_MIN_INTERVAL_MS + 1);
        assert(engine.hint({ jobId: JOB_A }) === true, 'the app hints the lane changed');
        await engine.get({ session: chat.sessionCode, linkId: LINK });
        assert(engine.snapshot().queue.jobs[0].phase === 'host', 'the lane is with the app');
        // The app polls a lane it holds; its status now says the job is open again
        // (the lane's own read is the first status call, the serve-time probe the second).
        mode = 'open-B'; clock.advance(CONSTANTS.HOST_POLL_MS + 1);
        hold.armed = true; hold.skip = 1; hold.gate = deferred();
        const pending = engine.get({ session: chat.sessionCode, linkId: LINK });
        await settle();
        const mid = engine.snapshot().queue.jobs[0];
        assert(mid.phase === 'awaiting' && mid.awaitingAnswer === false && mid.servedAt === null,
          `a different handoff has not been served yet, so nothing is awaited for it (phase ${mid.phase}, awaiting ${mid.awaitingAnswer}, servedAt ${mid.servedAt})`);
        hold.gate.resolve();
        const again = await pending;
        assert(again.status === 'served' && again.handoffCode === 'HANDOFF-B' && engine.snapshot().queue.jobs[0].awaitingAnswer === true, 'the new handoff is then served and awaited');
      }
      // Slow-answer status records one bounded response-overdue interval per silent handoff.
      {
        const clock = createFakeClock();
        const engine = createHandoffEngine({
          source: source({ submit: async () => ({ kind: 'accepted', completed: false, handoff: handoff({ code: 'HANDOFF-NEXT', stage: 'cover-letter' }) }) }).api,
          now: clock.now, timers: clock, holdMs: 0,
        });
        await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
        const chat = await engine.newChat({ linkId: LINK });
        const first = await engine.get({ session: chat.sessionCode, linkId: LINK });
        clock.advance(CONSTANTS.STALL_NOTICE_MS + 8 * 60_000);
        assert(engine.snapshot().chat.outstanding.stalled === true && engine.snapshot().chat.outstanding.stallsLastHour === 1,
          'a slow answer is counted once as a response-overdue interval');
        await engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: first.handoffCode, response: answer({ code: first.handoffCode, stage: first.stage }) });
        clock.advance(66 * 60_000);
        const outstanding = engine.snapshot().chat.outstanding;
        assert(outstanding.stalled === true && outstanding.stallsLastHour === 1,
          `the current successor has one response-overdue interval after the old one ages out, got ${outstanding.stallsLastHour}`);
      }
    },
  },
);

// ---------------------------------------------------------------------------
// Lane lifecycle and progress-truth follow-ups (2026-09-29 verification).
const enoentError = () => Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });

tests.push(
  {
    name: 'handoff bridge: engine: a bundle saved by another route while its lane is live is dropped at the next serve, never re-served, and a submit against it is a final answer, not needs_user',
    run: async () => {
      // (a) The serve-time probe treats the saved tombstone as gone.
      {
        const clock = createFakeClock(); const rec = recorders(); let aSaved = false;
        const engine = createHandoffEngine({
          source: source({
            read: async ({ jobId }) => { if (jobId === JOB_A && aSaved) throw enoentError(); return { kind: 'open', handoff: handoff({ code: jobId === JOB_B ? 'HANDOFF-B' : 'HANDOFF-A', jobId, prompt: `Synthetic prompt for ${jobId === JOB_B ? 'B' : 'A'}.` }) }; },
            status: async ({ jobId }) => (jobId === JOB_A && aSaved ? { kind: 'done' } : { kind: 'host' }),
          }).api,
          now: clock.now, timers: clock, holdMs: 0, ...rec.port,
        });
        await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
        await engine.release({ jobs: [{ jobId: JOB_B, canvasFilePath: PATH_B }] });
        const chat = await engine.newChat({ linkId: LINK });
        const first = await engine.get({ session: chat.sessionCode, linkId: LINK });
        assert(first.status === 'served' && first.handoffCode === 'HANDOFF-A', 'job A is served and left awaiting');
        aSaved = true;
        const next = await engine.get({ session: chat.sessionCode, linkId: LINK });
        assert(next.status === 'served' && next.handoffCode === 'HANDOFF-B' && !JSON.stringify(next).includes('prompt for A'),
          `a saved job's prompt is not re-served; the next job is (got ${next.status} ${next.handoffCode})`);
        const snap = engine.snapshot();
        assert(snap.queue.jobs.map(job => job.jobId).join() === JOB_B && snap.chat.jobsAssigned === 1, 'the saved job leaves the queue and gives its chat slot back');
        assert(rec.logs.some(item => item.code === 'unrelease' && item.fields.cause === 'bundle_saved'), 'and is dropped with the closed bundle_saved cause');
      }
      // (b) A submit that finds the bundle saved is definitive and never flips the lane to needs_user.
      {
        const clock = createFakeClock(); let saved = false; let savedSubmits = 0;
        const engine = createHandoffEngine({
          source: source({
            read: async () => { if (saved) throw enoentError(); return { kind: 'open', handoff: handoff() }; },
            status: async () => (saved ? { kind: 'done' } : { kind: 'host' }),
            submit: async () => { if (saved) savedSubmits++; if (saved) throw enoentError(); return { kind: 'accepted', completed: true }; },
          }).api,
          now: clock.now, timers: clock, holdMs: 0,
        });
        await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
        const chat = await engine.newChat({ linkId: LINK });
        const first = await engine.get({ session: chat.sessionCode, linkId: LINK });
        saved = true;
        const statuses = [];
        for (let index = 0; index < 5; index += 1) {
          const reply = await engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: first.handoffCode, response: answer({ code: first.handoffCode, extra: { n: index } }) });
          statuses.push(reply.status);
        }
        assert(statuses.every(status => status === 'unknown_handoff'), `every answer for a saved job is definitive, got ${statuses}`);
        assert(savedSubmits === 1, `only the first answer reaches the source; later ones are turned away up front (source submits ${savedSubmits})`);
        const snap = engine.snapshot();
        assert(snap.queue.jobs.every(job => job.phase !== 'needs_user' && job.reason !== 'write_failed') && snap.queue.applications.needsYou === 0,
          'a finished job never reads as needing the person');
        assert(snap.queue.jobs[0]?.phase === 'done', 'the lane is simply finished');
      }
    },
  },
  {
    name: 'handoff bridge: engine: a release that lost a race with a discard adds no lane; other jobs in the same release still go through, and the person\'s own Unrelease does not block a re-release',
    run: async () => {
      const clock = createFakeClock(); const rec = recorders();
      const engine = createHandoffEngine({ source: source().api, now: clock.now, timers: clock, holdMs: 0, ...rec.port });
      assert((await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] })).ok, 'job A releases');
      assert((await engine.dropLane(JOB_A, 'bundle_discarded')).ok, 'job A is discarded');
      const releasesBefore = rec.audit.filter(row => row.event === 'release').length;
      const late = await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      assert(late.ok === false && late.code === 'unknown_job', `a release for a discarded bundle is refused, got ${JSON.stringify(late)}`);
      assert(engine.snapshot().queue.jobs.length === 0 && engine.snapshot().queue.applications.working === 0, 'no lane, no working count');
      assert(rec.audit.filter(row => row.event === 'release').length === releasesBefore, 'and no release is audited');
      const mixed = await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }, { jobId: JOB_B, canvasFilePath: PATH_B }] });
      assert(mixed.ok === true && mixed.count === 1 && mixed.added.join() === JOB_B, `the live job of a mixed release is added alone, got ${JSON.stringify(mixed)}`);
      // A pruned bundle is refused too; an Unrelease is the person's choice and stays reversible.
      assert((await engine.release({ jobs: [{ jobId: '33333333-3333-4333-8333-333333333333', canvasFilePath: PATH_A }] })).ok, 'job C releases');
      assert((await engine.dropLane('33333333-3333-4333-8333-333333333333', 'bundle_pruned')).ok, 'job C is pruned');
      assert((await engine.release({ jobs: [{ jobId: '33333333-3333-4333-8333-333333333333', canvasFilePath: PATH_A }] })).code === 'unknown_job', 'a pruned bundle is refused');
      assert((await engine.unrelease(JOB_B)).ok && (await engine.release({ jobs: [{ jobId: JOB_B, canvasFilePath: PATH_B }] })).ok, 'a person\'s Unrelease can be undone by releasing again');
    },
  },
  {
    name: 'handoff bridge: engine: each bridge call renews answer-silence timing, but an unanswered lane becomes response-overdue after the next full grace period',
    run: async () => {
      const clock = createFakeClock(); const minute = 60_000;
      const engine = createHandoffEngine({
        source: source({ submit: async () => ({ kind: 'rejected', validationErrors: ['fix it'], handoff: handoff({ code: 'HANDOFF-A' }) }) }).api,
        now: clock.now, timers: clock, holdMs: 0,
      });
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      const chat = await engine.newChat({ linkId: LINK });
      const first = await engine.get({ session: chat.sessionCode, linkId: LINK });
      const jobA = () => engine.snapshot().queue.jobs[0];
      clock.advance(CONSTANTS.STALL_NOTICE_MS - minute);
      const junk = await engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: first.handoffCode, response: 'not json at all' });
      assert(junk.status === 'junk', `the first attempt is junk, got ${junk.status}`);
      clock.advance(minute);
      const wrongStage = await engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: first.handoffCode, response: answer({ code: first.handoffCode, stage: 'cover-letter' }) });
      assert(wrongStage.status === 'superseded', `the second attempt is for the wrong stage, got ${wrongStage.status}`);
      clock.advance(minute);
      assert(jobA().stalled === false && engine.snapshot().chat.outstanding.stalled === false, 'ChatGPT submitted a minute ago, so the job remains working');
      clock.advance(CONSTANTS.STALL_NOTICE_MS + 8 * 60_000 - minute);
      assert(jobA().stalled === true && jobA().stalledSince !== null, 'a long quiet response interval becomes a bounded response-overdue warning');
      // An identical retry answered from the verdict cache is also the chat being heard.
      const rejected = await engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: first.handoffCode, response: answer({ code: first.handoffCode }) });
      assert(rejected.status === 'rejected', 'a valid answer is rejected once');
      clock.advance(30_000);
      const again = await engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: first.handoffCode, response: answer({ code: first.handoffCode }) });
      assert(again.status === 'rejected', 'the identical retry is answered from the verdict cache');
      clock.advance(CONSTANTS.STALL_NOTICE_MS + 8 * 60_000);
      assert(jobA().stalled === true && jobA().stalledSince !== null, 'a cached-verdict retry renews liveness once, then becomes response-overdue after another full grace period');
    },
  },
  {
    name: 'handoff bridge: engine: a rejected answer after a re-read that rotated the code stays awaited and becomes response-overdue only after silence',
    run: async () => {
      const clock = createFakeClock(); let reads = 0; let submits = 0;
      const engine = createHandoffEngine({
        source: source({
          read: async () => { reads += 1; return { kind: 'open', handoff: handoff({ code: reads === 1 ? 'HANDOFF-A' : 'HANDOFF-A2' }) }; },
          submit: async () => {
            submits += 1;
            if (submits === 1) throw Object.assign(new Error('EIO'), { code: 'EIO' });
            return { kind: 'rejected', validationErrors: ['fix it'], handoff: handoff({ code: 'HANDOFF-A2' }) };
          },
        }).api,
        now: clock.now, timers: clock, holdMs: 0,
      });
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      const chat = await engine.newChat({ linkId: LINK });
      const first = await engine.get({ session: chat.sessionCode, linkId: LINK });
      const reply = await engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: first.handoffCode, response: answer({ code: first.handoffCode }) });
      assert(reply.status === 'rejected' && reply.handoffCode === 'HANDOFF-A2', `the correction carries the rotated code, got ${reply.status} ${reply.handoffCode}`);
      let job = engine.snapshot().queue.jobs[0];
      assert(job.awaitingAnswer === true && engine.snapshot().chat.outstanding !== null, 'ChatGPT was just handed a code, so the corrected answer is awaited');
      clock.advance(CONSTANTS.STALL_NOTICE_MS + 8 * 60_000);
      job = engine.snapshot().queue.jobs[0];
      assert(job.stalled === true && job.stalledSince !== null, 'and a silent corrected answer becomes response-overdue');
    },
  },
  {
    name: 'handoff bridge: engine: a lane held or dropped while an accepted answer is being persisted is not served the next stage',
    run: async () => {
      for (const variant of ['hold', 'drop']) {
        const clock = createFakeClock(); const state = { armed: false, gate: null };
        const store = { saveLanes: async () => { if (state.armed) { state.armed = false; await state.gate.promise; } return true; } };
        const engine = createHandoffEngine({
          source: source({ submit: async () => ({ kind: 'accepted', completed: false, handoff: handoff({ code: 'HANDOFF-NEXT', stage: 'cover-letter', prompt: 'Synthetic next-stage prompt.' }) }) }).api,
          store, now: clock.now, timers: clock, holdMs: 0,
        });
        await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
        const chat = await engine.newChat({ linkId: LINK });
        const first = await engine.get({ session: chat.sessionCode, linkId: LINK });
        state.armed = true; state.gate = deferred();
        const pending = engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: first.handoffCode, response: answer({ code: first.handoffCode }) });
        await settle();
        assert((variant === 'hold' ? await engine.hold(JOB_A) : await engine.dropLane(JOB_A, 'bundle_discarded')).ok, `the lane is ${variant === 'hold' ? 'held' : 'dropped'} mid-persist`);
        state.gate.resolve();
        const reply = await pending;
        assert(reply.status === 'accepted' && reply.next?.status === 'retry' && !JSON.stringify(reply).includes('next-stage prompt'),
          `${variant}: the next stage is not served for a lane that is no longer live, got ${JSON.stringify(reply.next)}`);
      }
    },
  },
  {
    name: 'handoff bridge: engine: a lane that goes to the app and comes back with the same handoff does not count the app\'s time as ChatGPT being quiet',
    run: async () => {
      const clock = createFakeClock(); const hold = { armed: false, skip: 0, gate: null }; let mode = 'open';
      const engine = createHandoffEngine({
        source: source({
          read: async ({ jobId }) => (mode === 'host' ? { kind: 'host' } : { kind: 'open', handoff: handoff({ code: 'HANDOFF-A', jobId }) }),
          status: async () => { if (hold.armed && hold.skip-- <= 0) { hold.armed = false; await hold.gate.promise; } return mode === 'open' ? { kind: 'awaiting', phase: 'awaiting', read: true } : { kind: 'host' }; },
        }).api,
        now: clock.now, timers: clock, holdMs: 0,
      });
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      const chat = await engine.newChat({ linkId: LINK });
      const first = await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(first.status === 'served' && first.handoffCode === 'HANDOFF-A', 'the handoff is served');
      mode = 'host'; clock.advance(CONSTANTS.HINT_MIN_INTERVAL_MS + 1);
      assert(engine.hint({ jobId: JOB_A }) === true, 'the app hints that the lane changed');
      await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(engine.snapshot().queue.jobs[0].phase === 'host', 'the lane is with the app');
      clock.advance(CONSTANTS.STALL_NOTICE_MS);
      mode = 'open'; clock.advance(CONSTANTS.HOST_POLL_MS + 1);
      hold.armed = true; hold.skip = 1; hold.gate = deferred();
      const pending = engine.get({ session: chat.sessionCode, linkId: LINK });
      await settle();
      const mid = engine.snapshot().queue.jobs[0];
      assert(mid.phase === 'awaiting' && mid.awaitingAnswer === true, `the same handoff is awaited again (phase ${mid.phase}, awaiting ${mid.awaitingAnswer})`);
      assert(mid.stalled === false, 'the time the app held the job is not ChatGPT being quiet');
      hold.gate.resolve();
      await pending;
    },
  },
);

// ---------------------------------------------------------------------------
// 2026-09-29 verification batch: in-flight results vs removed lanes, resume
// truth, servedTwice, and the cheap guards that were unobserved.
tests.push(
  {
    name: 'handoff bridge: engine: a read or status that resolves after its lane was Unreleased or discarded never re-registers the served code',
    run: async () => {
      for (const mode of ['unrelease', 'discard']) {
        const clock = createFakeClock(); const gate = deferred(); let gated = false; let submits = 0; let reads = 0;
        const engine = createHandoffEngine({
          source: source({
            read: async ({ jobId }) => { reads++; if (gated && jobId === JOB_A) await gate.promise; return { kind: 'open', handoff: handoff({ code: jobId === JOB_B ? 'HANDOFF-B' : 'HANDOFF-A', jobId }) }; },
            submit: async () => { submits++; return { kind: 'accepted', completed: true }; },
          }).api,
          now: clock.now, timers: clock, holdMs: 0,
        });
        await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
        await engine.release({ jobs: [{ jobId: JOB_B, canvasFilePath: PATH_B }] }); // keeps the chat alive once A is removed
        const chat = await engine.newChat({ linkId: LINK });
        const first = await engine.get({ session: chat.sessionCode, linkId: LINK });
        assert(first.status === 'served' && first.handoffCode === 'HANDOFF-A', `${mode}: the lane is served`);
        clock.advance(CONSTANTS.HINT_MIN_INTERVAL_MS + 1);
        assert(engine.hint({ jobId: JOB_A }) === true, `${mode}: the app hints the lane changed`);
        gated = true; const readsBefore = reads;
        const pending = engine.get({ session: chat.sessionCode, linkId: LINK });
        await settle();
        assert(reads === readsBefore + 1, `${mode}: a lane read is in flight`);
        const removed = mode === 'unrelease' ? await engine.unrelease(JOB_A) : await engine.dropLane(JOB_A, 'bundle_discarded');
        assert(removed.ok === true, `${mode}: the lane is removed while the read is in flight`);
        gate.resolve(); await pending; await settle();
        const late = await engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: first.handoffCode, response: answer({ code: first.handoffCode }) });
        assert(submits === 0, `${mode}: the removed lane's code must never reach the source (submit calls ${submits})`);
        const expected = mode === 'unrelease' ? 'unknown_handoff' : 'superseded';
        assert(late.status === expected, `${mode}: an answer for the removed lane is ${expected}, got ${late.status}`);
        assert(engine.snapshot().queue.jobs.every(job => job.jobId !== JOB_A), `${mode}: the removed lane does not come back`);
      }
    },
  },
  {
    name: 'handoff bridge: engine: a submit in flight when its lane is removed reports the source outcome without re-indexing the lane',
    run: async () => {
      const clock = createFakeClock(); const gate = deferred(); let submits = 0;
      const engine = createHandoffEngine({
        source: source({
          submit: async () => { submits++; await gate.promise; return { kind: 'accepted', handoff: handoff({ code: 'HANDOFF-A2', stage: 'review' }) }; },
        }).api,
        now: clock.now, timers: clock, holdMs: 0,
      });
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      const chat = await engine.newChat({ linkId: LINK });
      const first = await engine.get({ session: chat.sessionCode, linkId: LINK });
      const inFlight = engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: first.handoffCode, response: answer({ code: first.handoffCode }) });
      await settle();
      assert((await engine.unrelease(JOB_A)).ok && submits === 1, 'the lane is removed while its submit is in flight');
      gate.resolve();
      const reply = await inFlight;
      assert(reply.status === 'accepted' && !reply.next, `the accepted answer is reported without serving a next stage for a removed lane (got ${reply.status})`);
      const again = await engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: 'HANDOFF-A2', response: answer({ code: 'HANDOFF-A2', stage: 'review' }) });
      assert(again.status === 'unknown_handoff' && submits === 1, `the next stage's code was never indexed for the removed lane (got ${again.status}, ${submits} submits)`);
    },
  },
  {
    name: 'handoff bridge: engine: a lane resumed from a hold does not claim ChatGPT owes an answer, and the hold is not counted as working time',
    run: async () => {
      const state = await served();
      const { engine, clock } = state;
      clock.advance(2 * 60_000);
      assert((await engine.hold(JOB_A)).ok, 'the person holds the lane');
      clock.advance(60 * 60_000);
      assert((await engine.resume({ jobId: JOB_A })).ok, 'the person resumes it with no new get');
      const row = engine.snapshot().queue.jobs[0];
      assert(row.phase === 'awaiting' && row.awaitingAnswer === false && row.servedAt === null,
        `nothing was re-served, so no answer is owed and no serve time is claimed (awaiting ${row.awaitingAnswer}, servedAt ${row.servedAt})`);
      assert(engine.snapshot().chat.outstanding === null, 'and the chat has no outstanding job');
      const again = await engine.get({ session: state.session, linkId: LINK });
      const rearmed = engine.snapshot().queue.jobs[0];
      assert(again.status === 'served' && rearmed.awaitingAnswer === true && rearmed.servedAt === clock.now(), 'the next get re-arms the wait from the new serve');
    },
  },
  {
    name: 'handoff bridge: engine: a normal stage advance is not a duplicate serve; re-serving the same handoff is',
    run: async () => {
      const state = await served({ sourceOverrides: { submit: async () => ({ kind: 'accepted', handoff: handoff({ code: 'HANDOFF-A2', stage: 'review' }) }) } });
      const { engine } = state;
      assert(engine.snapshot().chat.servedTwice === false, 'one serve is not a duplicate');
      const reply = await engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: answer({ code: state.result.handoffCode, stage: state.result.stage }) });
      assert(reply.status === 'accepted' && reply.next?.status === 'served' && reply.next.stage === 'review', 'the accepted answer serves the next stage inline');
      assert(engine.snapshot().chat.servedTwice === false, 'a new stage served after an accepted answer is not two chats on one code');
      const repeat = await engine.get({ session: state.session, linkId: LINK });
      assert(repeat.status === 'served' && repeat.handoffCode === 'HANDOFF-A2', 'the same handoff is served again');
      assert(engine.snapshot().chat.servedTwice === true, 'serving the same handoff code again is reported');
    },
  },
  {
    name: 'handoff bridge: engine: a status probe that times out is not proof the bundle is gone, at serve time or at restore',
    run: async () => {
      const never = new Promise(() => {});
      const timers = { setTimeout: (fn, ms) => ({ timer: setTimeout(fn, ms), unref() {} }), clearTimeout: handle => clearTimeout(handle?.timer ?? handle) };
      const serveEngine = createHandoffEngine({ source: source({ status: async () => never }).api, timers, readWatchdogMs: 20, holdMs: 0, random: () => Buffer.alloc(26, 7) });
      await serveEngine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      const chat = await serveEngine.newChat({ linkId: LINK });
      const result = await serveEngine.get({ session: chat.sessionCode, linkId: LINK });
      assert(result.status === 'served' && serveEngine.snapshot().queue.jobs.length === 1, `a slow status probe still serves the lane (got ${result.status})`);
      await serveEngine.close();
      const restored = createHandoffEngine({
        source: source({ status: async () => never }).api, timers, readWatchdogMs: 20, holdMs: 0,
        restoredLanes: [{ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, releasedAt: 1, phase: 'unread', reason: null, heldFrom: null, counters: {} }],
      });
      await new Promise(resolve => setTimeout(resolve, 80));
      assert(restored.snapshot().queue.jobs.length === 1, 'a restore probe that times out never drops the lane');
      await restored.close();
    },
  },
  {
    name: 'handoff bridge: engine: dropLane records only a closed cause and remembers a bounded set of removed bundles',
    run: async () => {
      const rec = recorders(); const clock = createFakeClock();
      const engine = createHandoffEngine({ source: source().api, now: clock.now, timers: clock, holdMs: 0, ...rec.port });
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      assert((await engine.dropLane(JOB_A, 'free text /Users/someone/private.canvas')).ok, 'an unknown cause still removes the lane');
      assert(rec.audit.filter(row => row.event === 'unrelease').every(row => row.fields.cause === 'bundle_discarded'), 'the audit row records the closed default cause');
      assert(rec.logs.filter(row => row.code === 'unrelease').every(row => row.fields.cause === 'bundle_discarded'), 'and so does the log line');
      assert((await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] })).code === 'unknown_job', 'a sanitised cause is remembered as a discard');
      const idFor = index => `${index.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
      for (let index = 1; index <= 300; index += 1) await engine.dropLane(idFor(index), 'bundle_pruned');
      assert((await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] })).ok === true, 'the oldest removed bundle is forgotten once the bound is passed');
      assert((await engine.release({ jobs: [{ jobId: idFor(300), canvasFilePath: PATH_A }] })).code === 'unknown_job', 'a recent removed bundle is still refused');
    },
  },
);

// ---------------------------------------------------------------------------
// 2026-09-29 round-4 batch: rollbacks that must not clobber concurrent lane
// changes, submits queued behind the semaphore, in-flight results vs holds and
// chat rotation, servedTwice scope, and resume on a lane that is not held.
const rowOf = (engine, jobId = JOB_A) => engine.snapshot().queue.jobs.find(job => job.jobId === jobId);

tests.push(
  {
    name: 'handoff bridge: engine: a failed Unrelease save after the submit was accepted restores a lane that re-reads the next stage instead of re-serving the answered one',
    run: async () => {
      const clock = createFakeClock(); const gate = deferred(); let committed = false; let saveBehaviour = 'ok'; let pendingSave = null;
      const engine = createHandoffEngine({
        source: source({
          read: async ({ jobId }) => ({ kind: 'open', handoff: committed ? handoff({ code: 'HANDOFF-A2', stage: 'cover', jobId }) : handoff({ code: 'HANDOFF-A', stage: 'resume', jobId }) }),
          submit: async () => { await gate.promise; committed = true; return { kind: 'accepted', handoff: handoff({ code: 'HANDOFF-A2', stage: 'cover' }) }; },
        }).api,
        store: { saveLanes: async () => { if (saveBehaviour === 'ok') return true; pendingSave = deferred(); return pendingSave.promise; } },
        now: clock.now, timers: clock, holdMs: 0,
      });
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      const chat = await engine.newChat({ linkId: LINK });
      const first = await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(first.status === 'served' && first.handoffCode === 'HANDOFF-A', 'the resume stage is served');
      const inFlight = engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: first.handoffCode, response: answer({ code: first.handoffCode }) });
      await settle();
      saveBehaviour = 'slow-fail';
      const removal = engine.unrelease(JOB_A);
      await settle();
      assert(pendingSave, 'the Unrelease save is pending');
      gate.resolve();
      const reply = await inFlight;
      assert(reply.status === 'accepted', `the submit was accepted while the lane was detached, got ${reply.status}`);
      pendingSave.resolve(false);
      assert((await removal).code === 'persist_failed', 'the Unrelease save fails');
      saveBehaviour = 'ok';
      const next = await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(next.status === 'served' && next.handoffCode === 'HANDOFF-A2' && next.stage === 'cover',
        `the restored lane must serve the cover handoff the source advanced to, not the answered resume (got ${next.status} ${next.handoffCode} ${next.stage})`);
      const stale = await engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: 'HANDOFF-A', response: answer({ code: 'HANDOFF-A' }) });
      assert(stale.status === 'duplicate', `the answered code is a duplicate, got ${stale.status}`);
    },
  },
  {
    name: 'handoff bridge: engine: a failed terminal-lane prune does not roll back a lane a concurrent release added',
    run: async () => {
      const clock = createFakeClock(); let saves = 0; let pendingSave = null;
      const engine = createHandoffEngine({
        source: source({ read: async ({ jobId }) => (jobId === JOB_A ? { kind: 'done' } : { kind: 'open', handoff: handoff({ code: 'HANDOFF-B', jobId }) }) }).api,
        store: { saveLanes: async () => { saves++; if (saves === 3) { pendingSave = deferred(); return pendingSave.promise; } return true; } },
        now: clock.now, timers: clock, holdMs: 0,
      });
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      const chat = await engine.newChat({ linkId: LINK });
      await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(rowOf(engine, JOB_A)?.phase === 'done', 'the terminal lane is done');
      clock.advance(61 * 60_000);
      saves = 2;
      const ticking = engine.tick();
      await settle();
      assert(pendingSave, 'the prune save is pending');
      assert((await engine.release({ jobs: [{ jobId: JOB_B, canvasFilePath: PATH_B }] })).ok, 'a release lands while the prune save is pending');
      pendingSave.resolve(false);
      await ticking;
      const rows = engine.snapshot().queue.jobs;
      assert(rows.some(job => job.jobId === JOB_B), `the concurrently released lane must survive the prune rollback (rows ${JSON.stringify(rows.map(job => [job.jobId.slice(0, 2), job.phase]))})`);
      assert(rows.filter(job => job.jobId === JOB_A).length <= 1, 'and no lane is duplicated');
    },
  },
  {
    name: 'handoff bridge: engine: a failed Unrelease save does not duplicate a lane the keep-alive re-released meanwhile',
    run: async () => {
      const clock = createFakeClock(); let saves = 0; let pendingSave = null;
      const engine = createHandoffEngine({
        source: source().api,
        store: { saveLanes: async () => { saves++; if (saves === 2) { pendingSave = deferred(); return pendingSave.promise; } return true; } },
        now: clock.now, timers: clock, holdMs: 0,
      });
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      const removal = engine.unrelease(JOB_A);
      await settle();
      assert(pendingSave, 'the Unrelease save is pending');
      assert((await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] })).ok, 'the keep-alive re-releases the job');
      pendingSave.resolve(false);
      assert((await removal).code === 'persist_failed', 'the Unrelease save fails');
      assert(engine.snapshot().queue.jobs.filter(job => job.jobId === JOB_A).length === 1, 'exactly one lane exists for the job');
      assert(engine.restartJobs().filter(job => job.jobId === JOB_A).length === 1, 'and restart sees one');
    },
  },
  {
    name: 'handoff bridge: engine: a submit queued behind the semaphore re-checks its lane and never calls the app for a removed, held or completed job',
    run: async () => {
      for (const mode of ['unrelease', 'hold', 'completed']) {
        const clock = createFakeClock(); const gates = []; const submitted = [];
        const engine = createHandoffEngine({
          source: source({
            submit: async (_lane, { text }) => { submitted.push(text.length); if (submitted.length > 2) return { kind: 'accepted', completed: true }; const gate = deferred(); gates.push(gate); await gate.promise; return { kind: 'accepted', completed: true }; },
          }).api,
          now: clock.now, timers: clock, holdMs: 0,
        });
        await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
        const chat = await engine.newChat({ linkId: LINK });
        assert((await engine.get({ session: chat.sessionCode, linkId: LINK })).status === 'served', `${mode}: A is served`);
        const send = note => engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: 'HANDOFF-A', response: answer({ extra: { note } }) });
        // The second, different answer for the same code replays the retained first one, so it holds the other slot.
        const first = send('one'); const second = send('two');
        await settle();
        assert(submitted.length === 2, `${mode}: both semaphore slots are held by in-flight app calls (${submitted.length})`);
        const queued = send('three');
        await settle();
        assert(submitted.length === 2, `${mode}: the third submit waits for a slot`);
        if (mode === 'unrelease') assert((await engine.unrelease(JOB_A)).ok, `${mode}: the lane is removed while the third submit waits`);
        if (mode === 'hold') assert((await engine.hold(JOB_A)).ok, `${mode}: the lane is held while the third submit waits`);
        gates[0].resolve(); await settle();
        if (mode === 'completed') assert(rowOf(engine, JOB_A)?.phase === 'host', 'completed: the sibling submit completed the job');
        let outcome;
        try { outcome = await queued; } catch (error) { outcome = { threw: String(error?.message) }; }
        assert(!outcome.threw, `${mode}: the queued submit must answer, not throw (${outcome.threw})`);
        assert(submitted.length === 2, `${mode}: the queued submit never reached the app (${submitted.length} calls)`);
        const expected = { unrelease: ['unknown_handoff', 'duplicate', 'superseded'], hold: ['held'], completed: ['superseded', 'duplicate', 'unknown_handoff'] }[mode];
        assert(expected.includes(outcome.status), `${mode}: the queued submit is ${expected.join('/')}, got ${outcome.status}`);
        for (const gate of gates) gate.resolve();
        await Promise.allSettled([first, second]);
      }
    },
  },
  {
    name: 'handoff bridge: engine: a chat rotation or power resume during a submit keeps the accepted next handoff from reading as a person\'s edit',
    run: async () => {
      for (const mode of ['newChat', 'power']) {
        const clock = createFakeClock(); const gate = deferred(); let committed = false;
        const engine = createHandoffEngine({
          source: source({
            read: async ({ jobId }) => ({ kind: 'open', handoff: committed ? handoff({ code: 'HANDOFF-A2', stage: 'review', jobId }) : handoff({ code: 'HANDOFF-A', jobId }) }),
            submit: async () => { await gate.promise; committed = true; return { kind: 'accepted', handoff: handoff({ code: 'HANDOFF-A2', stage: 'review' }) }; },
          }).api,
          now: clock.now, timers: clock, holdMs: 0,
        });
        await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
        let chat = await engine.newChat({ linkId: LINK });
        const first = await engine.get({ session: chat.sessionCode, linkId: LINK });
        const inFlight = engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: first.handoffCode, response: answer({ code: first.handoffCode }) });
        await settle();
        if (mode === 'newChat') chat = await engine.newChat({ linkId: LINK }); else engine.onPowerResume();
        gate.resolve();
        assert((await inFlight).status === 'retry', `${mode}: the fenced submit answers retry`);
        const next = await engine.get({ session: chat.sessionCode, linkId: LINK });
        assert(next.status === 'served' && next.handoffCode === 'HANDOFF-A2' && next.stage === 'review',
          `${mode}: the next stage the source committed is served, got ${next.status}${next.reason ? `/${next.reason}` : ''}`);
        assert(rowOf(engine)?.phase === 'awaiting', `${mode}: the lane is not held as a human advance`);
        const old = await engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: 'HANDOFF-A', response: answer({ code: 'HANDOFF-A' }) });
        assert(old.status === 'duplicate', `${mode}: the answered code is a duplicate, got ${old.status}`);
      }
    },
  },
  {
    name: 'handoff bridge: engine: a Hold that lands while a read is in flight is kept and the lane is not served',
    run: async () => {
      const clock = createFakeClock(); const gate = deferred(); let gated = false;
      const engine = createHandoffEngine({
        source: source({ read: async ({ jobId }) => { if (gated) await gate.promise; return { kind: 'open', handoff: handoff({ jobId }) }; } }).api,
        now: clock.now, timers: clock, holdMs: 0,
      });
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      const chat = await engine.newChat({ linkId: LINK });
      gated = true;
      const pending = engine.get({ session: chat.sessionCode, linkId: LINK });
      await settle();
      assert((await engine.hold(JOB_A)).ok && rowOf(engine).phase === 'held', 'the person holds the lane while its read is in flight');
      gate.resolve();
      const result = await pending;
      assert(result.status !== 'served', `the get that was reading must not serve a held lane, got ${result.status}`);
      const row = rowOf(engine);
      assert(row.phase === 'held' && row.awaitingAnswer === false && engine.snapshot().queue.applications.ready === 0, `the lane stays held (phase ${row.phase})`);
      const later = await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(later.status === 'paused' && later.reason === 'needs_user', `a later get is told the bridge needs the person, got ${later.status}`);
      gated = false;
      assert((await engine.resume({ jobId: JOB_A })).ok, 'the person resumes');
      assert((await engine.get({ session: chat.sessionCode, linkId: LINK })).status === 'served', 'the resumed lane is read and served');
    },
  },
  {
    name: 'handoff bridge: engine: a Hold that lands while a submit is in flight is kept: no next stage is served and no answer is owed',
    run: async () => {
      for (const kind of ['accepted', 'completed', 'rejected']) {
        const clock = createFakeClock(); const gate = deferred(); let stage2 = false;
        const engine = createHandoffEngine({
          source: source({
            read: async ({ jobId }) => ({ kind: 'open', handoff: stage2 ? handoff({ code: 'HANDOFF-A2', stage: 'review', jobId }) : handoff({ jobId }) }),
            submit: async () => {
              await gate.promise;
              if (kind === 'completed') return { kind: 'accepted', completed: true };
              if (kind === 'accepted') { stage2 = true; return { kind: 'accepted', handoff: handoff({ code: 'HANDOFF-A2', stage: 'review' }) }; }
              return { kind: 'rejected', handoff: handoff(), validationErrors: ['Fix the summary.'] };
            },
          }).api,
          now: clock.now, timers: clock, holdMs: 0,
        });
        await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
        const chat = await engine.newChat({ linkId: LINK });
        const first = await engine.get({ session: chat.sessionCode, linkId: LINK });
        const inFlight = engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: first.handoffCode, response: answer({ code: first.handoffCode }) });
        await settle();
        assert((await engine.hold(JOB_A)).ok, `${kind}: the person holds the lane`);
        gate.resolve();
        const reply = await inFlight;
        if (kind !== 'rejected') assert(reply.status === 'accepted' && !reply.next, `${kind}: the accepted answer does not serve a next stage for a held lane (got ${reply.status} ${reply.next?.status})`);
        const row = rowOf(engine);
        assert(row.phase === 'held' && row.awaitingAnswer === false && row.servedAt === null, `${kind}: the hold survives and owes no answer (phase ${row.phase}, awaiting ${row.awaitingAnswer})`);
        if (kind === 'completed') return;
        assert((await engine.resume({ jobId: JOB_A })).ok, `${kind}: resume`);
        const after = await engine.get({ session: chat.sessionCode, linkId: LINK });
        assert(after.status === 'served' && after.handoffCode === (kind === 'accepted' ? 'HANDOFF-A2' : first.handoffCode), `${kind}: the resumed lane serves the right handoff, got ${after.status} ${after.handoffCode}`);
      }
    },
  },
  {
    name: 'handoff bridge: engine: two chats on one code is reported only for a repeat serve in the same chat with no hold between',
    run: async () => {
      const state = await served();
      const { engine, clock } = state;
      clock.advance(CONSTANTS.STALL_NOTICE_MS + 60_000);
      const chat = await engine.newChat({ linkId: LINK });
      const again = await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(again.status === 'served' && again.handoffCode === state.result.handoffCode, 'the new chat is served the same code');
      assert(engine.snapshot().chat.servedTwice === false, 'a serve to a fresh chat after a rotation is not two chats on one code');
      assert((await engine.hold(JOB_A)).ok && (await engine.resume({ jobId: JOB_A })).ok, 'hold and resume');
      const third = await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(third.status === 'served' && engine.snapshot().chat.servedTwice === false, 'the first serve after a hold is a fresh serve');
      assert((await engine.get({ session: chat.sessionCode, linkId: LINK })).status === 'served' && engine.snapshot().chat.servedTwice === true, 'a repeat serve in the same chat is still reported');
    },
  },
  {
    name: 'handoff bridge: engine: resuming a lane that is not held is a no-op and preserves its active unanswered handoff',
    run: async () => {
      const state = await served();
      const { engine, clock } = state;
      clock.advance(CONSTANTS.STALL_NOTICE_MS + 8 * 60_000);
      assert(rowOf(engine).stalled === true, 'the lane is response-overdue while its answer is silent');
      assert((await engine.resume({ jobId: JOB_A })).ok, 'a stale Resume click still answers ok');
      const row = rowOf(engine);
      assert(row.stalled === true && row.awaitingAnswer === true, `the awaited handoff is preserved (stalled ${row.stalled})`);
      assert(engine.snapshot().chat.outstanding?.stalled === true, 'and the chat-wide response-overdue warning remains visible');
    },
  },
);

// ---------------------------------------------------------------------------
// Round-4 review: hold/resume loops, release rollback and late submit results.
function pendingStore() {
  const pending = [];
  return { pending, saveLanes: () => { const gate = deferred(); pending.push(gate); return gate.promise; } };
}

function pendingEngine(store, sourceOverrides = {}) {
  const clock = createFakeClock();
  const engine = createHandoffEngine({
    source: source({ read: async ({ jobId }) => ({ kind: 'open', handoff: handoff({ code: `HANDOFF-${jobId.slice(0, 2)}`, jobId }) }), ...sourceOverrides }).api,
    store, now: clock.now, timers: clock, random: () => Buffer.alloc(26, 7), holdMs: 0,
  });
  return { engine, clock };
}

tests.push(
  {
    name: 'handoff bridge: engine: Resume after a human-advance hold re-reads and serves the app\'s current handoff, never the retired one',
    run: async () => {
      let appCode = 'HANDOFF-A'; let appStage = 'resume'; const submitted = [];
      const state = await served({ sourceOverrides: {
        read: async () => ({ kind: 'open', handoff: handoff({ code: appCode, stage: appStage }) }),
        submit: async (_lane, { code }) => {
          submitted.push(code);
          if (code !== appCode) throw Object.assign(new Error('stale handoff'), { code: 'EIO' });
          return { kind: 'accepted', completed: true };
        },
      } });
      const { engine, session } = state;
      appCode = 'HANDOFF-B'; appStage = 'cover-letter';
      assert(engine.hint({ jobId: JOB_A }), 'the hint is accepted');
      await engine.get({ session, linkId: LINK });
      assert(rowOf(engine).phase === 'held' && rowOf(engine).reason === 'human_advance', 'the person answered in the dock, so the lane holds');
      assert((await engine.resume({ jobId: JOB_A })).ok, 'resume');
      const after = await engine.get({ session, linkId: LINK });
      assert(after.status === 'served' && after.handoffCode === 'HANDOFF-B' && after.stage === 'cover-letter',
        `Resume must serve the app's current handoff, got ${after.status} ${after.handoffCode}`);
      const reply = await engine.submit({ session, linkId: LINK, handoffCode: after.handoffCode, response: answer({ code: after.handoffCode, stage: after.stage }) });
      assert(reply.status === 'accepted', `the fresh handoff is accepted, got ${reply.status}`);
      assert(!submitted.includes('HANDOFF-A'), 'the retired prompt never reached the app again');
    },
  },
  {
    name: 'handoff bridge: engine: a human-advance lane rehydrated as held still resumes through a re-read',
    run: async () => {
      const lane = createApplicationLane({ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, handoff: handoff({ code: 'HANDOFF-A' }) });
      holdLane(lane, 'human_advance', 1);
      lane.heldFrom = 'awaiting';
      resumeLane(lane);
      assert(lane.phase === 'unread', `a human-advance hold never resumes straight to awaiting, got ${lane.phase}`);
    },
  },
  {
    name: 'handoff bridge: engine: a failed release does not rewind the lane ordinal under a reinstated lane',
    run: async () => {
      const dir = cleanDirectory();
      const real = createLaneStore({ userDataPath: dir });
      const held = []; let hold = false;
      const store = { ...real, saveLanes: lanes => { if (!hold) return real.saveLanes(lanes); const gate = deferred(); held.push(gate); return gate.promise; } };
      const { engine } = pendingEngine(store, { status: async () => ({ kind: 'host' }) });
      const JOB_C = '33333333-3333-4333-8333-333333333333'; const JOB_D = '44444444-4444-4444-8444-444444444444';
      const rel = jobId => engine.release({ jobs: [{ jobId, canvasFilePath: PATH_A }] });
      assert((await rel(JOB_A)).ok, 'release A');
      hold = true;
      const releaseB = rel(JOB_B); await settle();
      const unreleaseB = engine.unrelease(JOB_B); await settle();
      held[0].resolve(false); await settle(); held[1].resolve(false);
      assert((await releaseB).code === 'persist_failed' && (await unreleaseB).code === 'persist_failed', 'both saves fail');
      hold = false;
      const releaseC = await rel(JOB_C); const releaseD = await rel(JOB_D);
      assert(releaseC.ok && releaseD.ok, `later releases must succeed on a healthy disk, got ${releaseC.code} ${releaseD.code}`);
      const jobs = engine.snapshot().queue.jobs;
      assert(engine.snapshot().fault !== 'persist_failed', 'no sticky persist fault');
      assert(jobs.length === new Set(jobs.map(job => job.ord ?? job.jobId)).size && jobs.some(job => job.jobId === JOB_D), 'every job has a lane');
    },
  },
  {
    name: 'handoff bridge: engine: a failed release does not erase a concurrent successful release',
    run: async () => {
      const store = pendingStore();
      const { engine } = pendingEngine(store, { status: async () => ({ kind: 'host' }) });
      const releaseA = engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] }); await settle();
      const releaseB = engine.release({ jobs: [{ jobId: JOB_B, canvasFilePath: PATH_A }] }); await settle();
      assert(store.pending.length === 2, 'both saves are pending');
      store.pending[0].resolve(false); store.pending[1].resolve(true);
      const [a, b] = [await releaseA, await releaseB];
      assert(a.ok === false && b.ok === true, 'A fails, B succeeds');
      const ids = engine.snapshot().queue.jobs.map(job => job.jobId);
      assert(ids.length === 1 && ids[0] === JOB_B, `B's lane must survive A's rollback, got ${JSON.stringify(ids)}`);
    },
  },
  {
    name: 'handoff bridge: engine: a failed release does not resurrect a lane a discard removed during the save',
    run: async () => {
      const store = pendingStore();
      const { engine } = pendingEngine(store, { status: async () => ({ kind: 'host' }) });
      const releaseA = engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] }); await settle();
      store.pending.shift().resolve(true); assert((await releaseA).ok, 'release A');
      const releaseB = engine.release({ jobs: [{ jobId: JOB_B, canvasFilePath: PATH_A }] }); await settle();
      const dropA = engine.dropLane(JOB_A, 'bundle_discarded'); await settle();
      assert(store.pending.length === 2, 'the release and the discard saves are pending');
      store.pending[0].resolve(false); await settle(); store.pending[1].resolve(true);
      assert((await releaseB).ok === false && (await dropA).ok === true, 'release B fails, the discard succeeds');
      const ids = engine.snapshot().queue.jobs.map(job => job.jobId);
      assert(ids.length === 0, `the discarded lane must stay gone, got ${JSON.stringify(ids)}`);
    },
  },
  {
    name: 'handoff bridge: engine: serial queue prevents a failed resume rollback from clobbering a concurrent hold',
    run: async () => {
      const store = pendingStore();
      const { engine } = pendingEngine(store);
      const releaseA = engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      await settle();
      store.pending.shift().resolve(true);
      assert((await releaseA).ok, 'release A');

      const holdA = engine.hold(JOB_A, 'user_hold');
      await settle();
      store.pending.shift().resolve(true);
      assert((await holdA).ok, 'hold A');
      assert(rowOf(engine, JOB_A)?.reason === 'user_hold', 'initially user_hold');

      const resuming = engine.resume({ jobId: JOB_A });
      await settle();
      assert(store.pending.length >= 1, 'resume save is pending');

      const concurrentHold = engine.hold(JOB_A, 'rejection_cap');
      await settle();

      store.pending.shift().resolve(false);
      await settle();

      if (store.pending.length > 0) {
        store.pending.shift().resolve(true);
      }

      await resuming;
      await concurrentHold;

      const row = rowOf(engine, JOB_A);
      assert(row?.reason === 'rejection_cap', `concurrent hold reason must not be clobbered by resume rollback (got ${row?.reason})`);
    },
  },
  {
    name: 'handoff bridge: engine: serial queue prevents a failed restart confirmation rollback from clobbering a concurrent hold',
    run: async () => {
      const store = pendingStore();
      const clock = createFakeClock();
      const engine = createHandoffEngine({
        source: source().api,
        store, now: clock.now, timers: clock, random: () => Buffer.alloc(26, 7), holdMs: 0,
        restoredLanes: [{ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, releasedAt: 10, phase: 'held', reason: 'restart' }],
        confirmRestart: async () => true,
      });
      assert(rowOf(engine, JOB_A)?.reason === 'restart', 'initially restart');

      const preparing = engine.newChat({ linkId: LINK });
      await settle();
      assert(store.pending.length >= 1, 'restart confirmation save is pending');

      const concurrentHold = engine.hold(JOB_A, 'user_hold');
      await settle();

      store.pending.shift().resolve(false);
      await settle();

      if (store.pending.length > 0) {
        store.pending.shift().resolve(true);
      }

      await preparing;
      await concurrentHold;

      const row = rowOf(engine, JOB_A);
      assert(row?.reason === 'user_hold', `concurrent hold reason must not be clobbered by restart confirmation rollback (got ${row?.reason})`);
    },
  },
  {
    name: 'handoff bridge: engine: a failed Resume save cannot revive a lane that a concurrent discard retired',
    run: async () => {
      const store = pendingStore();
      const { engine } = pendingEngine(store);
      const releaseA = engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      await settle(); store.pending.shift().resolve(true);
      assert((await releaseA).ok, 'release A');
      const holdA = engine.hold(JOB_A, 'user_hold');
      await settle(); store.pending.shift().resolve(true);
      assert((await holdA).ok, 'hold A');

      const resuming = engine.resume({ jobId: JOB_A });
      await settle();
      const dropping = engine.dropLane(JOB_A, 'bundle_discarded');
      await settle();
      assert(store.pending.length === 2, 'the Resume and discard saves both start while storage is pending');

      store.pending.shift().resolve(false);
      store.pending.shift().resolve(true);
      assert((await resuming).code === 'persist_failed', 'the older Resume write fails');
      assert((await dropping).ok, 'the later discard persists');
      assert(!rowOf(engine, JOB_A), 'the failed Resume rollback must not revive the discarded lane');
      assert((await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] })).code === 'unknown_job',
        'a discarded bundle remains fenced from a late re-release');
    },
  },
  {
    name: 'handoff bridge: engine: a failed release yields to a later hold and its durable reconciliation snapshot',
    run: async () => {
      const saves = [];
      const store = { saveLanes: lanes => { const gate = deferred(); saves.push({ lanes, gate }); return gate.promise; } };
      const { engine } = pendingEngine(store);
      const releasing = engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      await settle();
      const holding = engine.hold(JOB_A, 'user_hold');
      await settle();
      assert(saves.length === 2, 'the later Hold stages and snapshots without waiting for the release write');

      saves[0].gate.resolve(false);
      saves[1].gate.resolve(true);
      assert((await releasing).code === 'persist_failed', 'the initial release fails');
      assert((await holding).ok, 'the later hold persists');
      const row = rowOf(engine, JOB_A);
      assert(row?.phase === 'held' && row.reason === 'user_hold', `the later state wins (got ${row?.phase} ${row?.reason})`);
      const durable = saves[1].lanes.find(lane => lane.jobId === JOB_A);
      assert(durable?.phase === 'held' && durable.reason === 'user_hold', 'the later save carries the reconciliation snapshot, not the failed release state');
    },
  },
  {
    name: 'handoff bridge: engine: a late accepted submit from an Unreleased generation cannot mutate a re-released job',
    run: async () => {
      const gate = deferred(); let generation = 0;
      const state = await served({ engineOptions: { submitBudgetMs: 0 }, sourceOverrides: {
        read: async () => ({ kind: 'open', handoff: handoff({ code: generation === 0 ? 'HANDOFF-OLD' : 'HANDOFF-NEW', stage: generation === 0 ? 'resume' : 'cover-letter' }) }),
        submit: () => gate.promise,
      } });
      const { engine, session, result } = state;
      const oldSubmit = engine.submit({ session, linkId: LINK, handoffCode: result.handoffCode, response: answer({ code: result.handoffCode, stage: result.stage }) });
      await settle();
      assert((await engine.unrelease(JOB_A)).ok, 'the original lane is removed while its submit is in flight');
      generation = 1;
      assert((await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] })).ok, 'the same job receives a fresh lane');
      const fresh = await engine.get({ session, linkId: LINK });
      assert(fresh.status === 'served' && fresh.handoffCode === 'HANDOFF-NEW', 'the fresh lane serves its own handoff');

      gate.resolve({ kind: 'accepted', handoff: handoff({ code: 'HANDOFF-OLD-NEXT', stage: 'review' }) });
      assert((await oldSubmit).status === 'retry', 'the original request exhausted its zero response budget');
      await settle();
      const row = rowOf(engine, JOB_A);
      assert(row?.phase === 'awaiting' && row.stage === 'cover-letter', `the new lane is untouched by the old acceptance (got ${row?.phase} ${row?.stage})`);
      const staleNext = await engine.submit({ session, linkId: LINK, handoffCode: 'HANDOFF-OLD-NEXT', response: answer({ code: 'HANDOFF-OLD-NEXT', stage: 'review' }) });
      assert(staleNext.status === 'unknown_handoff', `the old successor was never indexed on the fresh lane (got ${staleNext.status})`);
    },
  },
  {
    name: 'handoff bridge: engine: an answer the app commits after submit_stuck is remembered, so Resume re-reads instead of re-serving the answered stage',
    run: async () => {
      const gate = deferred(); let appCode = 'HANDOFF-A'; let reads = 0;
      const state = await served({ engineOptions: { submitBudgetMs: 0 }, sourceOverrides: {
        read: async () => { reads++; return { kind: 'open', handoff: handoff({ code: appCode, stage: appCode === 'HANDOFF-A' ? 'resume' : 'cover-letter' }) }; },
        submit: () => gate.promise,
      } });
      const { engine, clock, session } = state;
      await engine.submit({ session, linkId: LINK, handoffCode: state.result.handoffCode, response: answer({ code: state.result.handoffCode }) });
      await settle();
      clock.advance(CONSTANTS.SUBMIT_STUCK_MS + 1_000); await settle();
      assert(rowOf(engine).reason === 'submit_stuck', 'the lane is held as submit_stuck');
      appCode = 'HANDOFF-A2';
      gate.resolve({ kind: 'accepted', completed: false, handoff: handoff({ code: 'HANDOFF-A2', stage: 'cover-letter' }) }); await settle();
      assert((await engine.resume({ jobId: JOB_A })).ok, 'resume');
      const after = await engine.get({ session, linkId: LINK });
      assert(after.status === 'served' && after.handoffCode === 'HANDOFF-A2' && reads >= 2,
        `Resume must serve the stage the app advanced to, got ${after.status} ${after.handoffCode}`);
      const stale = await engine.submit({ session, linkId: LINK, handoffCode: 'HANDOFF-A', response: answer({ code: 'HANDOFF-A' }) });
      assert(stale.status === 'duplicate', `the answered code is a duplicate, got ${stale.status}`);
    },
  },
  {
    name: 'handoff bridge: engine: a rejected result with a rotated code that a power resume or chat rotation fenced off is not a human advance',
    run: async () => {
      for (const via of ['power', 'chat']) {
        const gate = deferred(); let appCode = 'HANDOFF-A';
        const state = await served({ engineOptions: { submitBudgetMs: 0 }, sourceOverrides: {
          read: async () => ({ kind: 'open', handoff: handoff({ code: appCode }) }),
          submit: () => gate.promise,
        } });
        const { engine } = state; let { session } = state;
        await engine.submit({ session, linkId: LINK, handoffCode: 'HANDOFF-A', response: answer({ code: 'HANDOFF-A' }) }); await settle();
        if (via === 'power') engine.onPowerResume();
        else session = (await engine.continueChat({ linkId: LINK })).sessionCode;
        appCode = 'HANDOFF-A2';
        gate.resolve({ kind: 'rejected', validationErrors: ['x'], handoff: handoff({ code: 'HANDOFF-A2' }) }); await settle();
        const next = await engine.get({ session, linkId: LINK });
        assert(next.status === 'served' && next.handoffCode === 'HANDOFF-A2', `${via}: the rotated code is served, got ${next.status} ${next.reason ?? ''}`);
        assert(rowOf(engine).reason !== 'human_advance', `${via}: no false human-advance hold`);
      }
    },
  },
  {
    name: 'handoff bridge: engine: a failed Hold save does not restore answer tracking over an accepted submit that landed during the save',
    run: async () => {
      const gate = deferred(); const saves = []; let slow = false;
      const store = { saveLanes: () => { if (!slow) return Promise.resolve(true); const save = deferred(); saves.push(save); return save.promise; } };
      const state = await served({ engineOptions: { store }, sourceOverrides: { submit: () => gate.promise } });
      const { engine, clock, session } = state;
      const inFlight = engine.submit({ session, linkId: LINK, handoffCode: state.result.handoffCode, response: answer({ code: state.result.handoffCode }) });
      await settle();
      slow = true;
      const holding = engine.hold(JOB_A); await settle();
      gate.resolve({ kind: 'accepted', completed: false, handoff: handoff({ code: 'HANDOFF-A2', stage: 'cover-letter' }) }); await settle();
      saves.forEach(save => save.resolve(false));
      await inFlight;
      assert((await holding).code === 'persist_failed', 'the hold save fails');
      const row = rowOf(engine);
      assert(row.awaitingAnswer === false && row.servedAt === null, `nothing was served for the new stage (awaiting ${row.awaitingAnswer})`);
      assert(row.phase === 'awaiting' && row.reason === null, `the failed hold leaves no hold marker (phase ${row.phase}, reason ${row.reason})`);
      clock.advance(CONSTANTS.STALL_NOTICE_MS + 60_000);
      assert(rowOf(engine).stalled !== true && !engine.snapshot().chat.outstanding?.stalled, 'no false stall for a stage never served');
      const next = await engine.get({ session, linkId: LINK });
      assert(next.status === 'served' && next.handoffCode === 'HANDOFF-A2', `the new stage is served, not paused (got ${next.status} ${next.reason ?? ''})`);
    },
  },
);

// ---------------------------------------------------------------------------
// Copy starter re-copy: a chat that has not made a call yet is re-copied, not
// rotated (2026-09-30: seven presses burned six unused chats and bumped the
// chat number to 7 while ChatGPT had never called).
function distinctKeys(start = 0) { let counter = start; return () => Buffer.alloc(26, (counter += 1)); }
// distinctKeys repeats every 32 keys (a key byte selects one of 32 characters); this one does not.
function manyKeys(start = 0) { let counter = start; return () => { counter += 1; const bytes = Buffer.alloc(26, 7); bytes[0] = counter % 32; bytes[1] = Math.floor(counter / 32) % 32; bytes[2] = Math.floor(counter / 1024) % 32; return bytes; }; }
async function press(engine, kind = 'new') {
  const prepared = await engine.prepareChat({ linkId: LINK, kind });
  assert(prepared.copied === true, 'a press prepares a copyable starter');
  assert(prepared.commit() === true, 'a press commits');
  return prepared;
}

tests.push(
  {
    name: 'handoff bridge: engine: pressing copy starter again before any call re-copies the same starter for the same chat',
    run: async () => {
      const rec = recorders(); const clock = createFakeClock();
      const engine = createHandoffEngine({ source: source().api, now: clock.now, timers: clock, holdMs: 0, random: distinctKeys(), ...rec.port });
      assert((await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] })).ok, 'a released job exists');
      const releasedBefore = JSON.stringify(engine.snapshot().queue);
      const first = await press(engine);
      assert(first.recopied !== true && first.chatOrdinal === 1, 'the first press starts chat 1');
      const presses = [];
      for (let index = 0; index < 6; index += 1) presses.push(await press(engine));
      assert(presses.every(item => item.recopied === true && item.chatOrdinal === 1 && item.sessionCode === first.sessionCode),
        'six more presses with no call return the same ordinal and the identical starter key');
      const chat = engine.snapshot().chat;
      assert(chat.ordinal === 1 && chat.state === 'awaiting-first-call' && chat.calls === 0, 'the chat is still chat 1, still waiting for its first call');
      assert(JSON.stringify(engine.snapshot().queue) === releasedBefore, 'released-job membership is unchanged by a re-copy');
      assert(rec.logs.filter(entry => entry.code === 'epoch_closed').length === 0, 'no epoch_closed on a re-copy');
      assert(rec.logs.filter(entry => entry.code === 'new_chat').length === 1, 'exactly one new_chat was logged');
      const recopies = rec.logs.filter(entry => entry.code === 'starter_recopied');
      assert(recopies.length === 6 && recopies.every(entry => JSON.stringify(entry.fields) === JSON.stringify({ chatOrdinal: 1 })), 'each re-copy logs starter_recopied with only the ordinal');
      assert(rec.audit.filter(entry => entry.event === 'new_chat').length === 1 && rec.audit.every(entry => entry.event !== 'epoch_closed' && entry.event !== 'starter_recopied'),
        'a re-copy is not a security-ledger event');
      const viaCompat = await engine.newChat({ linkId: LINK });
      assert(viaCompat.recopied === true && viaCompat.sessionCode === first.sessionCode && viaCompat.chatOrdinal === 1, 'the compatibility newChat re-copies too');
      assert((await engine.get({ session: first.sessionCode, linkId: LINK })).status === 'served', 'the re-copied key is the live key');
    },
  },
  {
    name: 'handoff bridge: engine: after the first call a copy starter press rotates and the rotated key is refused',
    run: async () => {
      const rec = recorders(); const clock = createFakeClock();
      const engine = createHandoffEngine({ source: source().api, now: clock.now, timers: clock, holdMs: 0, random: distinctKeys(), ...rec.port });
      assert((await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] })).ok, 'a released job exists');
      const first = await press(engine); await press(engine);
      assert((await engine.get({ session: first.sessionCode, linkId: LINK })).status === 'served', 'the chat makes its first call');
      assert(engine.snapshot().chat.state === 'working', 'the chat is working');
      const second = await press(engine);
      assert(second.recopied !== true && second.chatOrdinal === 2 && second.sessionCode !== first.sessionCode, 'a press after a call rotates to a new ordinal and a new key');
      assert(rec.logs.some(entry => entry.code === 'epoch_closed' && entry.fields.cause === 'rotated') && rec.audit.some(entry => entry.event === 'epoch_closed'), 'the rotation closes the epoch as before');
      assert((await engine.get({ session: first.sessionCode, linkId: LINK })).status === 'session_ended', 'the rotated epoch key is refused');
      const third = await press(engine);
      assert(third.recopied === true && third.chatOrdinal === 2 && third.sessionCode === second.sessionCode, 'chat 2 has made no call yet, so a further press re-copies chat 2');
      assert((await engine.get({ session: second.sessionCode, linkId: LINK })).status !== 'session_ended', 'the new key is live');
    },
  },
  {
    name: 'handoff bridge: engine: a submit also counts as the first call, and continue never re-copies',
    run: async () => {
      const clock = createFakeClock();
      const engine = createHandoffEngine({ source: source().api, now: clock.now, timers: clock, holdMs: 0, random: distinctKeys() });
      const first = await press(engine);
      await engine.submit({ session: first.sessionCode, linkId: LINK, handoffCode: 'UNKNOWN-CODE', response: '{}' });
      assert(engine.snapshot().chat.calls === 1, 'a submit is a call');
      const next = await press(engine);
      assert(next.recopied !== true && next.chatOrdinal === 2, 'a press after a submit rotates');
      const continued = await press(engine, 'continue');
      assert(continued.recopied !== true && continued.chatOrdinal === 3 && continued.sessionCode !== next.sessionCode, 'Continue always makes a new key and ordinal');
    },
  },
  {
    name: 'handoff bridge: engine: no plaintext key survives an app restart, a link change or key expiry, so those presses rotate',
    run: async () => {
      const clock = createFakeClock();
      const options = { source: source().api, now: clock.now, timers: clock, holdMs: 0, random: distinctKeys() };
      const before = createHandoffEngine(options);
      const started = await press(before);
      assert(started.chatOrdinal === 1, 'chat 1 starts');
      // A new engine is what an app restart builds: epochs are memory-only.
      const after = createHandoffEngine({ ...options, random: distinctKeys(50) });
      assert(after.snapshot().chat.state === 'none', 'a restarted engine has no chat');
      const restarted = await press(after);
      assert(restarted.recopied !== true && restarted.chatOrdinal === 1, 'the first press after a restart starts a fresh chat');
      assert((await after.get({ session: started.sessionCode, linkId: LINK })).status === 'unauthorized', 'the pre-restart key is not accepted after a restart');
      const relinked = await after.prepareChat({ linkId: 'link-other', kind: 'new' });
      assert(relinked.copied === true && relinked.recopied !== true && relinked.chatOrdinal === 2, 'a different link cannot reuse the starter, so the press rotates');
      relinked.commit();
      const key = engine => engine.snapshot().chat;
      const aged = createHandoffEngine({ ...options, limits: { chatKeyMaxAgeHours: 1 }, random: distinctKeys(90) });
      const agedFirst = await press(aged);
      clock.advance(2 * 3_600_000);
      const agedNext = await press(aged);
      assert(agedNext.recopied !== true && agedNext.sessionCode !== agedFirst.sessionCode && key(aged).ordinal === 2, 'an expired uncalled key is replaced, not re-copied');
    },
  },
  {
    name: 'handoff bridge: engine: a re-copy whose chat was replaced meanwhile refuses to commit and cannot resurrect the old key',
    run: async () => {
      const clock = createFakeClock();
      const engine = createHandoffEngine({ source: source().api, now: clock.now, timers: clock, holdMs: 0, random: distinctKeys() });
      const first = await press(engine);
      const pendingRecopy = await engine.prepareChat({ linkId: LINK, kind: 'new' });
      assert(pendingRecopy.recopied === true, 'the second preparation is a re-copy');
      const continued = await engine.prepareChat({ linkId: LINK, kind: 'continue' });
      assert(continued.commit() === true, 'a continue replaces the chat while the re-copy is still pending');
      assert(pendingRecopy.commit() === false, 'the pending re-copy is refused once its chat was replaced');
      assert((await engine.get({ session: first.sessionCode, linkId: LINK })).status === 'session_ended', 'the replaced starter key is refused');
    },
  },
  {
    name: 'handoff bridge: engine: no starter key reaches logs, the ledger or the status snapshot, before or after re-copies',
    run: async () => {
      const rec = recorders(); const lines = []; const clock = createFakeClock();
      const logger = createHandoffBridgeLog({ logger: { info: line => lines.push(line) }, now: () => 1 });
      const engine = createHandoffEngine({ source: source().api, now: clock.now, timers: clock, holdMs: 0, random: distinctKeys(), audit: rec.port.audit, logger });
      const first = await press(engine); await press(engine); await press(engine);
      await engine.get({ session: first.sessionCode, linkId: LINK });
      await press(engine);
      const everything = JSON.stringify({ lines, audit: rec.audit, snapshot: engine.snapshot(), recent: logger.getRecent() });
      assert(lines.filter(line => line === '[HandoffBridge] starter_recopied chatOrdinal=1').length === 2, 'the closed re-copy line is the only trace of a re-copy');
      assert(!everything.includes(first.sessionCode) && !everything.includes(first.sessionCode.toLowerCase()), 'the plaintext starter key never appears in logs, audit or status');
      assert(!Object.keys(engine.snapshot().chat).some(name => /key|session|starter|secret/i.test(name)), 'no status field can carry the key');
    },
  },
  {
    name: 'handoff bridge: engine: one starter pasted into two chats coalesces a duplicate GET, so every cap stays epoch-wide',
    run: async () => {
      const clock = createFakeClock();
      const jobs = [[JOB_A, PATH_A], [JOB_B, PATH_B]];
      const engine = createHandoffEngine({ source: source().api, now: clock.now, timers: clock, holdMs: 0, random: distinctKeys(), limits: { jobsPerChat: 1 } });
      for (const [jobId, canvasFilePath] of jobs) assert((await engine.release({ jobs: [{ jobId, canvasFilePath }] })).ok, 'released');
      const shared = await press(engine); await press(engine);
      const [chatA, chatB] = await Promise.all([
        engine.get({ session: shared.sessionCode, linkId: LINK }),
        engine.get({ session: shared.sessionCode, linkId: LINK }),
      ]);
      const snapshot = engine.snapshot().chat;
      assert(chatA.status === 'served' && chatB.status === 'served' && chatA.handoffCode === chatB.handoffCode
        && snapshot.ordinal === 1 && snapshot.jobsAssigned === 1 && snapshot.jobsAssigned <= snapshot.jobsCap,
      'two chats holding one key are both handed the same single outstanding handoff, never a second job past the epoch cap');
      assert(snapshot.servedTwice === false && snapshot.calls === 2 && engine.snapshot().counts.getServed === 1,
        'the epoch counts both transport calls but coalesces their one handoff serve');
    },
  },
);

// Re-copy guard rails: which epochs may hand their starter out again.
tests.push(
  {
    name: 'handoff bridge: engine: a new-chat press over an uncalled Continue key rotates and retires the Continue key',
    run: async () => {
      const rec = recorders(); const clock = createFakeClock();
      const engine = createHandoffEngine({ source: source().api, now: clock.now, timers: clock, holdMs: 0, random: distinctKeys(), ...rec.port });
      await press(engine);
      const continued = await press(engine, 'continue');
      assert(continued.chatOrdinal === 2 && engine.snapshot().chat.state === 'awaiting-first-call', 'an uncalled Continue epoch is current');
      const fresh = await engine.prepareChat({ linkId: LINK, kind: 'new' });
      assert(fresh.recopied !== true && fresh.sessionCode !== continued.sessionCode && fresh.chatOrdinal === 3,
        'a new-chat press must mint its own key, never hand out the Continue key as a starter');
      assert(fresh.commit() === true, 'the rotation commits');
      assert((await engine.get({ session: continued.sessionCode, linkId: LINK })).status === 'session_ended', 'the Continue key is retired by the press');
      assert(rec.logs.filter(entry => entry.code === 'epoch_closed').length >= 2 && rec.logs.every(entry => entry.code !== 'starter_recopied'), 'the Continue epoch closed and nothing was logged as a re-copy');
    },
  },
  {
    name: 'handoff bridge: engine: a key that was presented but turned away (idle pause) is no longer re-copyable and reads as reached',
    run: async () => {
      const clock = createFakeClock();
      const engine = createHandoffEngine({ source: source().api, now: clock.now, timers: clock, holdMs: 0, random: distinctKeys(), limits: { idlePauseMinutes: 60 } });
      const first = await press(engine);
      assert(engine.snapshot().chat.state === 'awaiting-first-call', 'nothing has presented the key yet');
      clock.advance(2 * 3_600_000);
      const refused = await engine.get({ session: first.sessionCode, linkId: LINK });
      assert(refused.status === 'paused' && refused.reason === 'idle', 'the idle pause turns the chat away');
      const chat = engine.snapshot().chat;
      assert(chat.calls === 0 && chat.state === 'reached' && Number.isFinite(chat.lastCallAt) && chat.firstCallAt === null,
        'the chat reached the bridge with its key: state is reached, not awaiting-first-call, and no call is counted');
      const next = await engine.prepareChat({ linkId: LINK, kind: 'new' });
      assert(next.recopied !== true && next.sessionCode !== first.sessionCode && next.chatOrdinal === 2, 'the next press rotates instead of handing the same key to a second chat');
      next.commit();
      assert((await engine.get({ session: first.sessionCode, linkId: LINK })).status === 'session_ended', 'the chat that presented the key is retired');
      assert(engine.snapshot().paused === false && engine.snapshot().chat.state === 'awaiting-first-call', 'the rotation cleared the pause and the new chat awaits its first call');
    },
  },
  {
    name: 'handoff bridge: engine: notePresented marks a key the controller turned away, matches only, and never counts a wrong key',
    run: async () => {
      const clock = createFakeClock();
      const engine = createHandoffEngine({ source: source().api, now: clock.now, timers: clock, holdMs: 0, random: distinctKeys() });
      const first = await press(engine);
      for (let index = 0; index < 6; index += 1) assert(engine.notePresented({ session: 'WRONG-KEY', linkId: LINK }) === false, 'a wrong key is not a presentation');
      assert(engine.snapshot().keys.unrecognisedRecent === 0 && engine.snapshot().counts.getUnauthorized === 0 && engine.snapshot().paused === false && engine.snapshot().chat.state === 'awaiting-first-call', 'wrong keys through notePresented count nothing and pause nothing');
      assert(engine.notePresented({ session: first.sessionCode, linkId: 'link-other' }) === false && engine.snapshot().chat.state === 'awaiting-first-call', 'the key under another link does not match');
      assert(engine.notePresented({ session: `  ${first.sessionCode}  `, linkId: LINK }) === true, 'the chat key matches');
      assert(engine.snapshot().chat.state === 'reached', 'the chat is reached');
      const next = await engine.prepareChat({ linkId: LINK, kind: 'new' });
      assert(next.recopied !== true && next.chatOrdinal === 2, 'a presented key rotates');
    },
  },
  {
    name: 'handoff bridge: engine: a pasted but uncalled starter is still re-copied while stale keys keep arriving; only a pause forces a rotation',
    run: async () => {
      const clock = createFakeClock();
      const engine = createHandoffEngine({ source: source().api, now: clock.now, timers: clock, holdMs: 0, random: distinctKeys() });
      const first = await press(engine);
      for (let index = 0; index < 20; index += 1) await engine.get({ session: 'STALE-CHAT-KEY', linkId: LINK });
      assert(engine.snapshot().keys.unrecognisedRecent === 20 && engine.snapshot().paused === false, 'stale keys are only counted');
      const again = await press(engine);
      assert(again.recopied === true && again.chatOrdinal === 1 && again.sessionCode === first.sessionCode, 'the press re-copies the unused starter: stale noise must not kill it');
      for (let index = 0; index < 5; index += 1) await engine.get({ session: 'STALE-CHAT-KEY', linkId: LINK });
      const third = await press(engine);
      assert(third.recopied === true && third.sessionCode === first.sessionCode, 'and again after more stale keys');
      assert((await engine.get({ session: first.sessionCode, linkId: LINK })).status !== 'unauthorized', 'the starter still works for its first call');
      engine.pause('user');
      const rotated = await press(engine);
      assert(rotated.recopied !== true && rotated.chatOrdinal === 2 && rotated.sessionCode !== first.sessionCode, 'a paused engine rotates, and the rotation clears the pause');
      assert(engine.snapshot().paused === false && engine.snapshot().pauseCause === null, 'the rotation lifted the pause');
    },
  },
);

// Ended-chat ledger: a chat from before a restart reads as ended, not as a
// wrong code to retry. Only one-way digests are written.
const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
const retiredFile = store => JSON.parse(fs.readFileSync(store.retiredPath, 'utf8'));
const engineOn = (store, clock, extra = {}) => createHandoffEngine({ source: source().api, store, now: clock.now, timers: clock, holdMs: 0, ...extra });
async function pressAndCall(engine, linkId = LINK) {
  const prepared = await engine.prepareChat({ linkId, kind: 'new' });
  assert(prepared.copied === true && prepared.commit() === true, 'a press commits');
  assert((await engine.get({ session: prepared.sessionCode, linkId })).status !== 'unauthorized', 'the chat calls');
  return prepared;
}

// A chat that stays live across calls: with no released job the first call drains
// (and so retires) the chat.
async function pressAndCallLive(engine, linkId = LINK) {
  await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
  return pressAndCall(engine, linkId);
}

tests.push(
  {
    name: 'handoff bridge: engine: a pre-restart key reads as ended after a restart plus a new chat, and is not counted as unrecognised',
    run: async () => {
      const dir = cleanDirectory();
      try {
        const clock = createFakeClock();
        const store = createLaneStore({ userDataPath: dir });
        const before = engineOn(store, clock, { random: distinctKeys(0) });
        const ended = await pressAndCall(before);
        const live = await pressAndCall(before);
        await store.flush();
        // No close(): the process died with `live` still the current chat.
        const file = retiredFile(store);
        assert(file.v === 2 && file.chats.length === 2 && file.chats.every(chat => Object.keys(chat).sort().join() === 'digest,retiredAt'), `the file holds only link-free digests: ${JSON.stringify(file)}`);
        assert(!fs.readFileSync(store.retiredPath, 'utf8').toLowerCase().includes(ended.sessionCode.toLowerCase()), 'no key text is written');
        if (process.platform !== 'win32') assert((fs.statSync(store.retiredPath).mode & 0o777) === 0o600, 'the file is owner-only');

        const restarted = engineOn(createLaneStore({ userDataPath: dir }), clock, { random: distinctKeys(100) });
        assert((await restarted.get({ session: ended.sessionCode, linkId: LINK })).status === 'session_ended', 'with no chat yet, a stale key is already session_ended');
        const fresh = await press(restarted);
        for (const stale of [ended, live]) assert((await restarted.get({ session: stale.sessionCode, linkId: LINK })).status === 'session_ended', 'a pre-restart key is session_ended once a new chat exists');
        const keys = restarted.snapshot().keys;
        assert(keys.unrecognisedRecent === 0 && keys.lastUnrecognisedAt === null && keys.ended === 3 && restarted.snapshot().counts.getUnauthorized === 0, `ended keys are not unrecognised: ${JSON.stringify(keys)}`);
        assert((await restarted.get({ session: 'GARBLED-CODE', linkId: LINK })).status === 'unauthorized' && restarted.snapshot().keys.unrecognisedRecent === 1, 'a code nothing ever issued is still unrecognised');
        assert((await restarted.get({ session: fresh.sessionCode, linkId: LINK })).status !== 'session_ended', 'the new chat works');
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
  },
  {
    name: 'handoff bridge: engine: a corrupt, unreadable or wrong-shape ended-chat file loads as an empty list and the engine still works',
    run: async () => {
      const goodDigest = sha('x');
      const shapes = [
        'not json {',
        '',
        // A version-1 file (digests bound to the link id) loads as empty: stale chats then read as unrecognised once.
        JSON.stringify({ v: 1, chats: [{ digest: sha(`retired-chat-v1\n${LINK}\nOLD-KEY`), linkDigest: sha(`retired-chat-link-v1\n${LINK}`), retiredAt: 1 }] }),
        JSON.stringify({ v: 1, chats: [{ digest: goodDigest, retiredAt: 1 }] }),
        JSON.stringify({ v: 3, chats: [] }),
        JSON.stringify({ v: 2, chats: [{ digest: 'abc', retiredAt: 1 }] }),
        JSON.stringify({ v: 2, chats: [{ digest: goodDigest, retiredAt: 1, extra: 'field' }] }),
        JSON.stringify({ v: 2, chats: [{ digest: goodDigest, linkDigest: goodDigest, retiredAt: 1 }] }),
        JSON.stringify({ v: 2, chats: [{ digest: goodDigest, retiredAt: -5 }] }),
        JSON.stringify({ v: 2, chats: [{ digest: goodDigest, retiredAt: 1 }, { digest: goodDigest, retiredAt: 2 }] }),
        JSON.stringify({ v: 2, chats: Array.from({ length: 33 }, (_, index) => ({ digest: sha(String(index)), retiredAt: 1 })) }),
      ];
      for (const text of shapes) {
        const dir = cleanDirectory();
        try {
          const clock = createFakeClock();
          const store = createLaneStore({ userDataPath: dir });
          fs.mkdirSync(path.dirname(store.retiredPath), { recursive: true });
          fs.writeFileSync(store.retiredPath, text);
          assert(store.loadRetiredChats().length === 0, `a bad file loads empty: ${text.slice(0, 40)}`);
          const engine = engineOn(store, clock, { random: distinctKeys(0) });
          const chat = await press(engine);
          assert((await engine.get({ session: 'OLD-KEY', linkId: LINK })).status === 'unauthorized', 'an old key is simply unrecognised');
          assert((await engine.get({ session: chat.sessionCode, linkId: LINK })).status !== 'unauthorized', 'the engine serves on an empty list');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
      }
      // A file path that is a directory cannot be read at all.
      const dir = cleanDirectory();
      try {
        const store = createLaneStore({ userDataPath: dir });
        fs.mkdirSync(store.retiredPath, { recursive: true });
        assert(store.loadRetiredChats().length === 0, 'an unreadable file loads empty');
        const engine = engineOn(store, createFakeClock(), { random: distinctKeys(0) });
        assert((await press(engine)).copied === true, 'and the engine still starts a chat');
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
      // A store that throws on load is treated the same way.
      const clock = createFakeClock();
      const engine = createHandoffEngine({ source: source().api, now: clock.now, timers: clock, holdMs: 0, random: distinctKeys(0), store: { loadRetiredChats() { throw new Error('boom'); }, saveRetiredChats() { throw new Error('boom'); } } });
      const chat = await press(engine);
      assert((await engine.get({ session: chat.sessionCode, linkId: LINK })).status !== 'unauthorized', 'a throwing store never breaks serving');
    },
  },
  {
    name: 'handoff bridge: engine: the ended-chat list is pruned on link revoke, by age, and capped at 32, and is never purged by a relink',
    run: async () => {
      // Revoke: everything goes, and the closing chat does not write itself back.
      let dir = cleanDirectory();
      try {
        const clock = createFakeClock(); const store = createLaneStore({ userDataPath: dir });
        const engine = engineOn(store, clock, { random: distinctKeys(0) });
        const one = await pressAndCall(engine); await pressAndCall(engine);
        await store.flush();
        assert(fs.existsSync(store.retiredPath) && retiredFile(store).chats.length === 2, 'two chats are on record');
        engine.pause('revoked');
        await engine.close();
        await store.flush();
        assert(!fs.existsSync(store.retiredPath), 'a revoked link leaves no ended-chat file, even after the live chat closes');
        const next = engineOn(createLaneStore({ userDataPath: dir }), clock, { random: distinctKeys(50) });
        await press(next);
        assert((await next.get({ session: one.sessionCode, linkId: LINK })).status === 'unauthorized', 'the revoked link ended chats are forgotten');
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }

      // Revoke in one process: the in-memory retired chats are forgotten too, not only the file.
      dir = cleanDirectory();
      try {
        const clock = createFakeClock(); const store = createLaneStore({ userDataPath: dir });
        const engine = engineOn(store, clock, { random: distinctKeys(0) });
        const rotated = await pressAndCallLive(engine); await pressAndCall(engine);
        assert((await engine.get({ session: rotated.sessionCode, linkId: LINK })).status === 'session_ended', 'before the revoke the rotated key reads as ended');
        engine.pause('revoked');
        await store.flush();
        assert(!fs.existsSync(store.retiredPath), 'the revoke clears the file');
        assert((await engine.get({ session: rotated.sessionCode, linkId: LINK })).status === 'unauthorized', 'after the revoke the in-memory retired key is forgotten as well');
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }

      // A relink does not purge: starting a chat under another link keeps every ended key.
      dir = cleanDirectory();
      try {
        const clock = createFakeClock(); const store = createLaneStore({ userDataPath: dir });
        const engine = engineOn(store, clock, { random: distinctKeys(0) });
        const ended = await pressAndCallLive(engine); const live = await pressAndCall(engine);
        await store.flush();
        const relinked = await engine.prepareChat({ linkId: 'link-b', kind: 'new' }); relinked.commit();
        await store.flush();
        assert(retiredFile(store).chats.length === 3, `no ended key is purged by a chat under another link: ${JSON.stringify(retiredFile(store))}`);
        assert((await engine.get({ session: 'anything', linkId: 'link-b' })).status === 'unauthorized', 'while a chat is live, a key nothing issued is still unrecognised');
        for (const key of [ended, live]) for (const link of [LINK, 'link-b', 'link-c']) {
          assert((await engine.get({ session: key.sessionCode, linkId: link })).status === 'session_ended', `an ended key reads as ended under ${link}`);
        }
        await store.flush();
        assert(retiredFile(store).chats.length === 3, 'and calls carrying other links drop nothing');
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }

      // Age: the window is max(chatKeyMaxAgeHours, 24h).
      for (const [hours, inside, outside] of [[48, 47, 49], [1, 23, 25]]) {
        dir = cleanDirectory();
        try {
          const clock = createFakeClock(); const limits = { chatKeyMaxAgeHours: hours };
          const store = createLaneStore({ userDataPath: dir });
          const first = engineOn(store, clock, { random: distinctKeys(0), limits });
          const old = await pressAndCall(first); await pressAndCall(first);
          await store.flush();
          clock.advance(inside * 3_600_000);
          const restoredStore = createLaneStore({ userDataPath: dir });
          const restarted = engineOn(restoredStore, clock, { random: distinctKeys(100), limits });
          await press(restarted);
          assert((await restarted.get({ session: old.sessionCode, linkId: LINK })).status === 'session_ended', `${inside}h after, inside the ${Math.max(hours, 24)}h window, the key reads as ended`);
          clock.advance((outside - inside) * 3_600_000);
          assert((await restarted.get({ session: old.sessionCode, linkId: LINK })).status === 'unauthorized', `${outside}h after, the entry has aged out`);
          await restoredStore.flush();
          assert(retiredFile(restoredStore).chats.length === 1, 'the aged entries are written out of the file, leaving only the chat started since');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
      }

      // Cap.
      dir = cleanDirectory();
      try {
        const clock = createFakeClock(); const store = createLaneStore({ userDataPath: dir });
        const engine = engineOn(store, clock, { random: manyKeys(0) });
        const chats = [];
        for (let index = 0; index < 40; index += 1) chats.push(await pressAndCall(engine));
        await store.flush();
        assert(CONSTANTS.RETIRED_EPOCHS === 32 && retiredFile(store).chats.length === 32, 'the file holds at most 32 entries');
        const restarted = engineOn(createLaneStore({ userDataPath: dir }), clock, { random: manyKeys(5000) });
        await press(restarted);
        assert((await restarted.get({ session: chats[0].sessionCode, linkId: LINK })).status === 'unauthorized', 'the oldest chat was evicted');
        assert((await restarted.get({ session: chats[20].sessionCode, linkId: LINK })).status === 'session_ended', 'a recent chat is remembered');
        assert(engine.snapshot().chat.previous.length <= 5, 'the status list of previous chats stays short');
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
  },
);

// A store whose ended-chat writes are recorded (each write's list) but otherwise real.
function countingStore(dir) {
  const real = createLaneStore({ userDataPath: dir });
  const saves = [];
  return { ...real, saves, saveRetiredChats(chats) { saves.push(chats.map(chat => ({ ...chat }))); return real.saveRetiredChats(chats); } };
}
const HOUR = 3_600_000;

tests.push(
  {
    name: 'handoff bridge: engine: a relink (a call under another link) retires the live chat as link_changed, its key reads as ended under either link, and status shows no chat',
    run: async () => {
      const dir = cleanDirectory();
      try {
        const rec = recorders(); const clock = createFakeClock(); const store = createLaneStore({ userDataPath: dir });
        const engine = createHandoffEngine({ source: source().api, now: clock.now, timers: clock, holdMs: 0, random: distinctKeys(0), ...rec.port, store });
        const chat = await pressAndCallLive(engine, 'link-a');
        assert(engine.snapshot().chat.state !== 'none' && engine.snapshot().chat.ordinal === 1, 'a chat is live under link A');
        assert((await engine.get({ session: chat.sessionCode, linkId: 'link-b' })).status === 'session_ended', 'the call under link B is answered session_ended, not unauthorized');
        const status = engine.snapshot();
        assert(status.chat.state === 'none' && status.chat.ordinal === 0, `status shows no chat: ${JSON.stringify(status.chat)}`);
        assert(status.chat.previous.length === 1 && status.chat.previous[0].reason === 'link_changed', 'the closed chat is listed with the link_changed reason');
        assert(rec.logs.some(entry => entry.code === 'epoch_closed' && entry.fields.cause === 'link_changed'), 'the log line is epoch_closed cause=link_changed');
        assert(rec.audit.some(entry => entry.event === 'epoch_closed' && entry.fields.reason === 'link_changed'), 'the audit line carries the same closed reason');
        for (const link of ['link-a', 'link-b', 'link-c']) assert((await engine.get({ session: chat.sessionCode, linkId: link })).status === 'session_ended', `the old key reads as ended under ${link}`);
        const keys = engine.snapshot().keys;
        assert(keys.ended === 4 && keys.unrecognisedRecent === 0 && engine.snapshot().counts.getUnauthorized === 0, `the old key is counted as ended, never as unrecognised: ${JSON.stringify(keys)}`);
        // The person starts a new chat under the new link, and it works while the old key stays ended.
        const fresh = await pressAndCall(engine, 'link-b');
        assert(engine.snapshot().chat.state !== 'none' && (await engine.get({ session: chat.sessionCode, linkId: 'link-b' })).status === 'session_ended', 'a new chat works and the old key stays ended');
        await store.flush();
        const digests = retiredFile(store).chats.map(entry => entry.digest);
        assert(digests.includes(sha(`retired-chat-v2\n${chat.sessionCode}`)) && digests.includes(sha(`retired-chat-v2\n${fresh.sessionCode}`)), 'both chats are on record by their link-free digests');
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
  },
  {
    name: 'handoff bridge: engine: noteLink retires only a live chat started under a different link',
    run: async () => {
      const rec = recorders(); const clock = createFakeClock();
      const engine = createHandoffEngine({ source: source().api, now: clock.now, timers: clock, holdMs: 0, random: distinctKeys(0), ...rec.port });
      assert(engine.noteLink('link-a') === false, 'no chat: nothing to retire');
      const chat = await pressAndCallLive(engine, 'link-a');
      for (const value of ['link-a', '', null, undefined, 7]) assert(engine.noteLink(value) === false && engine.snapshot().chat.state !== 'none', `noteLink(${String(value)}) leaves the chat`);
      assert(engine.noteLink('link-b') === true && engine.snapshot().chat.state === 'none', 'a different link retires the chat');
      assert(rec.logs.filter(entry => entry.code === 'epoch_closed' && entry.fields.cause === 'link_changed').length === 1, 'one link_changed close');
      assert(engine.noteLink('link-b') === false, 'nothing left to retire');
      assert((await engine.get({ session: chat.sessionCode, linkId: 'link-b' })).status === 'session_ended', 'the old key is ended');
      await engine.close();
      assert(engine.noteLink('link-c') === false, 'a closed engine ignores it');
    },
  },
  {
    name: 'handoff bridge: engine: a call under another link ends the live chat only when it presents that chat\'s own key (a stale grant carrying any other key cannot end a healthy chat)',
    run: async () => {
      const rec = recorders(); const clock = createFakeClock();
      const engine = createHandoffEngine({ source: source().api, now: clock.now, timers: clock, holdMs: 0, random: distinctKeys(0), ...rec.port });
      const chat = await pressAndCallLive(engine, 'link-b');
      for (const session of ['not-this-chats-key', '', 'x'.repeat(40)]) {
        const result = await engine.get({ session, linkId: 'link-a' });
        assert(result.status === 'unauthorized', `a stale-link call with another key is refused (${session.length} chars)`);
        assert(engine.snapshot().chat.state !== 'none', 'and the healthy chat stays live');
      }
      assert(!rec.logs.some(entry => entry.code === 'epoch_closed' && entry.fields.cause === 'link_changed'), 'no link_changed close from a stale grant');
      assert((await engine.get({ session: chat.sessionCode, linkId: 'link-a' })).status === 'session_ended', 'the chat presenting its own key under another link is ended');
      assert(rec.logs.filter(entry => entry.code === 'epoch_closed' && entry.fields.cause === 'link_changed').length === 1, 'exactly one link_changed close');
      await engine.close();
    },
  },
  {
    name: 'handoff bridge: engine: the ended-chat digest is link-free (the same key gives the same digest under any link) and holds no plaintext',
    run: async () => {
      const digests = [];
      for (const link of ['link-one', 'link-two']) {
        const dir = cleanDirectory();
        try {
          const store = createLaneStore({ userDataPath: dir });
          const engine = engineOn(store, createFakeClock(), { random: distinctKeys(0) });
          const chat = await pressAndCall(engine, link);
          await store.flush();
          const text = fs.readFileSync(store.retiredPath, 'utf8');
          const file = JSON.parse(text);
          assert(file.chats.length === 1 && file.chats[0].digest === sha(`retired-chat-v2\n${chat.sessionCode}`), 'the digest is sha256 of the v2 prefix and the key alone');
          assert(!text.includes(chat.sessionCode) && !text.includes(link), 'no key and no link id in the file');
          digests.push(file.chats[0].digest);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
      }
      assert(digests[0] === digests[1], 'the same key under two links leaves the same digest');
    },
  },
  {
    name: 'handoff bridge: engine: a version-1 ended-chat file loads as empty and is replaced by a version-2 file on the next write',
    run: async () => {
      const dir = cleanDirectory();
      try {
        const clock = createFakeClock(); const store = createLaneStore({ userDataPath: dir });
        const key = 'V1-ERA-KEY';
        fs.mkdirSync(path.dirname(store.retiredPath), { recursive: true });
        fs.writeFileSync(store.retiredPath, JSON.stringify({ v: 1, chats: [{ digest: sha(`retired-chat-v1\n${LINK}\n${key}`), linkDigest: sha(`retired-chat-link-v1\n${LINK}`), retiredAt: clock.now() }] }));
        assert(store.loadRetiredChats().length === 0, 'the v1 file loads as empty');
        const engine = engineOn(store, clock, { random: distinctKeys(0) });
        assert((await engine.get({ session: key, linkId: LINK })).status === 'session_ended' && engine.snapshot().keys.ended === 0, 'with no chat any key reads session_ended, but the v1 entry is not counted as recognised');
        await press(engine);
        assert((await engine.get({ session: key, linkId: LINK })).status === 'unauthorized', 'the v1 key reads as unrecognised once (fail closed, harmless)');
        await store.flush();
        assert(retiredFile(store).v === 2, 'the next write is a v2 file');
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
  },
  {
    name: 'handoff bridge: engine: the live chat entry survives a 25h-old chat, is refreshed at most once per hour of use, and no call writes the ledger',
    run: async () => {
      const dir = cleanDirectory();
      try {
        const clock = createFakeClock(); const store = countingStore(dir);
        const engine = engineOn(store, clock, { random: distinctKeys(0), limits: { idlePauseMinutes: 0 } });
        const chat = await pressAndCallLive(engine);
        const digest = sha(`retired-chat-v2\n${chat.sessionCode}`);
        await settle();
        assert(store.saves.length === 1, `the commit wrote once: ${store.saves.length}`);
        for (let index = 0; index < 100; index += 1) assert((await engine.get({ session: chat.sessionCode, linkId: LINK })).status !== 'unauthorized', 'a call is served');
        await settle();
        assert(store.saves.length === 1, `100 calls in the first hour wrote nothing: ${store.saves.length}`);
        // 25 hours in: an unrelated lookup prunes the ledger, and the live entry must survive it.
        clock.advance(25 * HOUR);
        assert((await engine.get({ session: 'GARBLED', linkId: LINK })).status === 'unauthorized', 'a garbled key is unrecognised');
        assert((await engine.get({ session: chat.sessionCode, linkId: LINK })).status !== 'unauthorized', 'the 25h-old chat still serves');
        await settle(); await store.flush();
        assert(store.saves.length === 2, `the first use after an hour refreshed once: ${store.saves.length}`);
        const stamped = retiredFile(store).chats.find(entry => entry.digest === digest);
        assert(stamped && stamped.retiredAt === clock.now(), `the entry survived and was re-stamped: ${JSON.stringify(retiredFile(store))}`);
        for (let index = 0; index < 59; index += 1) { clock.advance(60_000); await engine.get({ session: chat.sessionCode, linkId: LINK }); }
        await settle();
        assert(store.saves.length === 2, `59 more minutes of use wrote nothing: ${store.saves.length}`);
        clock.advance(2 * 60_000);
        await engine.get({ session: chat.sessionCode, linkId: LINK });
        await settle();
        assert(store.saves.length === 3, `the next hour of use wrote once more: ${store.saves.length}`);
        // Retiring re-stamps it as ended, and it stays recognised.
        const next = await press(engine);
        assert(next.copied === true && (await engine.get({ session: chat.sessionCode, linkId: LINK })).status === 'session_ended', 'the rotated chat reads as ended');
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
  },
  {
    name: 'handoff bridge: engine: after a crash, a 30h-old chat that was used recently is recognised as ended, while one unused for 30h has aged out from its last refresh',
    run: async () => {
      for (const [label, keepUsing, expected] of [['recently used', true, 'session_ended'], ['unused for 30h', false, 'unauthorized']]) {
        const dir = cleanDirectory();
        try {
          const clock = createFakeClock(); const store = countingStore(dir);
          const engine = engineOn(store, clock, { random: distinctKeys(0), limits: { idlePauseMinutes: 0 } });
          const chat = await pressAndCallLive(engine);
          for (let hour = 0; hour < 30; hour += 1) {
            clock.advance(HOUR + 1000);
            if (keepUsing) await engine.get({ session: chat.sessionCode, linkId: LINK });
          }
          await settle(); await store.flush();
          // No close(): the process died with the chat still live.
          const restarted = engineOn(createLaneStore({ userDataPath: dir }), clock, { random: distinctKeys(100) });
          await press(restarted);
          assert((await restarted.get({ session: chat.sessionCode, linkId: LINK })).status === expected, `${label}: expected ${expected}`);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
      }
    },
  },
  {
    name: 'handoff bridge: engine: a failing ended-chat write never throws into a request',
    run: async () => {
      const clock = createFakeClock(); const failures = [];
      const stores = [
        { loadRetiredChats: () => [], saveRetiredChats() { failures.push('throw'); throw new Error('disk gone'); } },
        { loadRetiredChats: () => [], saveRetiredChats() { failures.push('reject'); return Promise.reject(new Error('disk gone')); } },
      ];
      const unhandled = []; const onUnhandled = reason => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);
      try {
        for (const store of stores) {
          const engine = createHandoffEngine({ source: source().api, now: clock.now, timers: clock, holdMs: 0, random: distinctKeys(0), limits: { idlePauseMinutes: 0 }, store });
          const chat = await pressAndCallLive(engine);
          clock.advance(2 * HOUR);
          assert((await engine.get({ session: chat.sessionCode, linkId: LINK })).status !== 'unauthorized', 'the refresh write fails and the request is still served');
          await settle();
        }
        await new Promise(resolve => setImmediate(resolve));
        assert(failures.length >= 4 && unhandled.length === 0, `both refreshes tried to write and nothing leaked: ${failures.join()} ${unhandled.length}`);
      } finally { process.off('unhandledRejection', onUnhandled); }
    },
  },
);

// ---- get() must not wait on a finished job (first live ChatGPT bridge run) ----
// Live evidence: the last job was saved, yet every get answered 'waiting' for
// ~3 minutes until the wait limit said "paused". The renderer's job-changed hint
// had set needsRefresh on the HOST lane; nothing consumes that flag off an
// awaiting lane, and `working` counted it, so a saved job read as pending work.
function liveBridgeHarness({ scope = { applications: true, scoring: true, marketplace: true } } = {}) {
  const clock = createFakeClock();
  const jobRoot = { status: 'queued' };
  let finalReview = false;
  const application = createApplicationSource({
    getHandoff: async () => ({ handoff: { handoffCode: 'HANDOFF-REVIEW', stage: 'review', prompt: 'Synthetic review prompt.', revision: 1 } }),
    submitHandoff: async () => { finalReview = true; jobRoot.status = 'importing'; return { accepted: true, completed: true }; },
    getStatus: async () => ({ ...jobRoot }),
    discover: async () => [],
    subscribeLocalApplicationDiscards: () => () => undefined,
  });
  const push = createPushSource({
    // Nothing pending in any hub: scoring and marketplace are idle.
    seam: { list: async () => ({ handoffs: [], excluded: {}, pending: 0 }), read: async () => ({ ok: false }), submit: async () => ({ outcome: 'not_pending' }) },
    hubKey: () => null, now: clock.now, timers: clock,
  });
  const engine = createHandoffEngine({ sources: { application, push }, scope, now: clock.now, timers: clock, random: () => Buffer.alloc(26, 7), holdMs: 0 });
  return { engine, clock, jobRoot, saved: () => { jobRoot.status = 'saved'; }, finalReview: () => finalReview };
}

async function liveBridgeServedAndSubmitted(harness) {
  const { engine } = harness;
  assert((await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] })).ok, 'the live job releases');
  const chat = await engine.newChat({ linkId: LINK });
  const first = await engine.get({ session: chat.sessionCode, linkId: LINK });
  assert(first.status === 'served' && first.stage === 'review', `the review handoff is served, got ${first.status}`);
  const accepted = await engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: 'HANDOFF-REVIEW', response: answer({ code: 'HANDOFF-REVIEW', stage: 'review' }) });
  assert(accepted.status === 'accepted' && accepted.jobComplete === true, `the final answer is accepted as complete, got ${accepted.status}`);
  return chat.sessionCode;
}

tests.push(
  {
    name: 'handoff bridge: engine: a job saved after a renderer hint ends the chat with queue_empty, not waiting until the wait limit',
    run: async () => {
      const harness = liveBridgeHarness();
      const { engine, clock } = harness;
      const session = await liveBridgeServedAndSubmitted(harness);
      // The card's publication changes while the app imports, then the job leaves it on save.
      engine.hint({ jobId: JOB_A }); clock.advance(CONSTANTS.HINT_MIN_INTERVAL_MS);
      clock.advance(CONSTANTS.HOST_POLL_MS + 1);
      const importing = await engine.get({ session, linkId: LINK });
      assert(importing.status === 'waiting', `an import still running is legitimately waiting, got ${importing.status}`);
      harness.saved(); engine.hint({ jobId: JOB_A }); clock.advance(CONSTANTS.HINT_MIN_INTERVAL_MS);
      clock.advance(CONSTANTS.HOST_POLL_MS + 1);
      const drained = await engine.get({ session, linkId: LINK });
      assert(drained.status === 'queue_empty', `once the bundle is saved the next get is queue_empty, got ${drained.status}`);
      assert(engine.snapshot().queue.jobs[0].phase === 'done', 'the lane finished');
      assert((await engine.get({ session, linkId: LINK })).status === 'session_ended', 'the drained chat is retired (terminalDrain still applies)');
    },
  },
  {
    name: 'handoff bridge: engine: a hint on a finished or held lane never becomes pending work',
    run: async () => {
      const harness = liveBridgeHarness();
      const { engine, clock } = harness;
      const session = await liveBridgeServedAndSubmitted(harness);
      harness.saved();
      clock.advance(CONSTANTS.HOST_POLL_MS + 1);
      // Hints arrive both before the probe (host) and after it (done, which hint() refuses).
      engine.hint({ jobId: JOB_A }); clock.advance(CONSTANTS.HINT_MIN_INTERVAL_MS);
      const result = await engine.get({ session, linkId: LINK });
      assert(result.status === 'queue_empty', `a saved job is not work, got ${result.status}`);

      const held = liveBridgeHarness();
      assert((await held.engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] })).ok, 'release');
      const chat = await held.engine.newChat({ linkId: LINK });
      assert((await held.engine.hold(JOB_A)).ok, 'the person holds the lane');
      held.engine.hint({ jobId: JOB_A }); held.clock.advance(CONSTANTS.HINT_MIN_INTERVAL_MS);
      const stopped = await held.engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(stopped.status === 'paused' && stopped.reason === 'needs_user', `a hinted held lane still asks for the person, not 'waiting', got ${stopped.status}`);
    },
  },
  {
    name: 'handoff bridge: engine: waiting explicitly keeps a pool worker polling for later waves',
    run: async () => {
      const waiting = makeResultBody('waiting', { retryAfterSeconds: 3 });
      assert(waiting.status === 'waiting' && waiting.retryAfterSeconds === 3, 'the bounded retry delay survives framing');
      assert(/retryAfterSeconds/.test(waiting.note) && /call get_handoff again/i.test(waiting.note)
        && /same session/i.test(waiting.note) && /queue_empty/.test(waiting.note)
        && /paused/.test(waiting.note) && /do not stop on waiting/i.test(waiting.note),
      'waiting tells every worker exactly how to drain later waves');
    },
  },
  {
    name: 'handoff bridge: engine: legacy waiting remains durable instead of requiring Continue',
    run: async () => {
      const harness = liveBridgeHarness();
      const { engine, clock } = harness;
      const session = await liveBridgeServedAndSubmitted(harness);
      let last = null; let polls = 0;
      // The import genuinely never finishes: every poll is a legitimate wait.
      for (; polls < CONSTANTS.MAX_CONSECUTIVE_WAITS + 2; polls += 1) {
        clock.advance(CONSTANTS.HOST_POLL_MS + 1);
        last = await engine.get({ session, linkId: LINK });
        if (last.status !== 'waiting') break;
        assert(engine.snapshot().chat.state === 'working', 'a waiting chat is working');
      }
      assert(polls === CONSTANTS.MAX_CONSECUTIVE_WAITS + 2 && last.status === 'waiting',
        `legacy waits remain an explicit poll instruction, got ${last?.status}/${last?.reason} after ${polls}`);
      assert(engine.snapshot().paused === false, 'the bridge itself is not paused');
      assert(engine.snapshot().chat.state === 'working', `a waiting chat stays working, got ${engine.snapshot().chat.state}`);
      // A later authenticated call keeps the durable wait contract.
      clock.advance(CONSTANTS.WAIT_COUNTER_RESET_IDLE_MS + 1);
      const resumed = await engine.get({ session, linkId: LINK });
      assert(resumed.status === 'waiting' && engine.snapshot().chat.state === 'working', 'a fresh call remains in the durable wait state');
      // A real pause still says paused.
      engine.pause('user');
      const paused = await engine.get({ session, linkId: LINK });
      assert(paused.status === 'paused' && /paused/.test(paused.note), 'a real pause keeps its own wording');
    },
  },
  {
    name: 'handoff bridge: engine: a prepared pool worker keeps waiting beyond the legacy poll limit',
    run: async () => {
      const calls = [];
      const push = {
        refreshHubs: async () => true,
        status: () => ({
          discovered: [{ tasks: [{ task: 'job-preference-evaluation', pending: 1 }] }],
          working: 1,
        }),
        get: async ({ keepWaiting } = {}) => {
          calls.push(keepWaiting);
          return { status: 'waiting', remaining: { ready: 0, working: 1, needsYou: 0 } };
        },
        submit: async () => ({ status: 'unknown_handoff' }),
        closeEpoch: () => undefined,
      };
      const engine = createHandoffEngine({
        sources: { application: source().api, push },
        scope: { applications: false, scoring: true, marketplace: false },
        holdMs: 0,
      });
      const pool = await engine.startWorkerPool({ linkId: LINK, requestedWorkers: 1 });
      const starter = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
      assert(pool.started && starter.copied, 'the one-worker adaptive plan must produce a persistent pool starter');
      let last = null;
      for (let poll = 0; poll < CONSTANTS.MAX_CONSECUTIVE_WAITS + 4; poll += 1) {
        last = await engine.get({ session: starter.sessionCode, linkId: LINK });
        assert(last.status === 'waiting', `pool poll ${poll + 1} must keep draining later waves, got ${last.status}/${last.reason ?? ''}`);
      }
      assert(calls.length > CONSTANTS.MAX_CONSECUTIVE_WAITS && calls.every(value => value === true)
        && engine.snapshot().chat.pool.active === true && engine.snapshot().chat.state === 'working',
      'pool workers must pass the durable-wait mode to the source and never hit the legacy waiting_limit');
      await engine.close();
    },
  },
  {
    name: 'handoff bridge: engine: pool waits return promptly and the next poll still drains the finished queue',
    run: async () => {
      const clock = createFakeClock();
      let state = 'waiting';
      const push = {
        refreshHubs: async () => true,
        status: () => ({ discovered: [{ tasks: [{ task: 'job-preference-evaluation', pending: 1 }] }], working: state === 'waiting' ? 1 : 0 }),
        get: async () => state === 'waiting'
          ? { status: 'waiting', remaining: { ready: 0, working: 1, needsYou: 0 } }
          : { status: 'queue_empty', remaining: { ready: 0, working: 0, needsYou: 0 } },
        submit: async () => ({ status: 'unknown_handoff' }),
        closeEpoch: () => undefined,
      };
      const engine = createHandoffEngine({
        sources: { application: source().api, push },
        scope: { applications: false, scoring: true, marketplace: false },
        now: clock.now, timers: clock, holdMs: CONSTANTS.GET_HOLD_MS,
      });
      const pool = await engine.startWorkerPool({ linkId: LINK, requestedWorkers: 1 });
      const starter = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
      const waiting = await engine.get({ session: starter.sessionCode, linkId: LINK });
      assert(waiting.status === 'waiting' && clock.pendingCount() === 0,
        'a pool wait returns immediately instead of scheduling the legacy 20-second held GET');
      state = 'empty';
      const drained = await engine.get({ session: starter.sessionCode, linkId: LINK });
      assert(drained.status === 'queue_empty' && engine.snapshot().chat.pool.active === false,
        'the first poll after work settles still returns queue_empty and retires the pool');
      await engine.close();
    },
  },
  {
    name: 'handoff bridge: engine: a ten-worker pool uses one rate-safe waiting cadence across every worker',
    run: async () => {
      const push = {
        refreshHubs: async () => true,
        status: () => ({ discovered: [{ tasks: [{ task: 'job-preference-evaluation', pending: 10 }] }], working: 1 }),
        get: async () => ({ status: 'waiting', remaining: { ready: 0, working: 1, needsYou: 0 } }),
        submit: async () => ({ status: 'unknown_handoff' }),
        closeEpoch: () => undefined,
      };
      const engine = createHandoffEngine({
        sources: { application: source().api, push },
        scope: { applications: false, scoring: true, marketplace: false },
        holdMs: 0,
      });
      const pool = await engine.startWorkerPool({ linkId: LINK, requestedWorkers: 10 });
      assert(pool.started && pool.workerCount === 10, 'fixture must create the maximum worker pool');
      const delays = [];
      for (let ordinal = 1; ordinal <= 10; ordinal += 1) {
        const starter = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: ordinal });
        const waiting = await engine.get({ session: starter.sessionCode, linkId: LINK });
        assert(waiting.status === 'waiting', `worker ${ordinal} must receive the poll instruction`);
        delays.push(waiting.retryAfterSeconds);
      }
      assert(delays.every(delay => delay >= CONSTANTS.POOL_WAIT_MIN_SECONDS && delay <= CONSTANTS.POOL_WAIT_MAX_SECONDS)
        && delays[0] === CONSTANTS.POOL_WAIT_MIN_SECONDS && delays.at(-1) === CONSTANTS.POOL_WAIT_MAX_SECONDS,
      `ten workers must receive the staggered conservative cadence, got ${JSON.stringify(delays)}`);
      await engine.close();
    },
  },
  {
    name: 'handoff bridge: engine: a waiting pool worker stays waiting while its next GET is in flight',
    run: async () => {
      const firstPoll = deferred();
      const slowPoll = deferred();
      let phase = 'first'; let firstStarted = false; let slowStarted = false;
      const push = {
        refreshHubs: async () => true,
        status: () => ({ discovered: [{ tasks: [{ task: 'job-scoring', pending: 1 }] }], working: 0 }),
        get: async () => {
          if (phase === 'first') {
            firstStarted = true;
            return firstPoll.promise;
          }
          if (phase === 'waiting') return { status: 'waiting', remaining: { ready: 0, working: 1, needsYou: 0 } };
          slowStarted = true;
          return slowPoll.promise;
        },
        submit: async () => ({ status: 'unknown_handoff' }),
        closeEpoch: () => undefined,
      };
      const engine = createHandoffEngine({
        sources: { application: source().api, push },
        scope: { applications: false, scoring: true, marketplace: false },
        holdMs: 0,
      });
      const pool = await engine.startWorkerPool({ linkId: LINK, requestedWorkers: 1 });
      const starter = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
      const initial = engine.get({ session: starter.sessionCode, linkId: LINK });
      for (let attempt = 0; attempt < 20 && !firstStarted; attempt += 1) await Promise.resolve();
      assert(firstStarted && engine.snapshot().chat.pool.workers[0]?.state === 'working',
        'an initial claim remains working while the source is selecting its result');
      phase = 'waiting';
      firstPoll.resolve({ status: 'waiting', remaining: { ready: 0, working: 1, needsYou: 0 } });
      const waiting = await initial;
      assert(waiting.status === 'waiting' && engine.snapshot().chat.pool.workers[0]?.state === 'waiting',
        'a completed poll that finds no work leaves this worker waiting for its scheduled retry');
      phase = 'slow';
      const poll = engine.get({ session: starter.sessionCode, linkId: LINK });
      for (let attempt = 0; attempt < 20 && !slowStarted; attempt += 1) await Promise.resolve();
      assert(slowStarted && engine.snapshot().chat.pool.workers[0]?.state === 'waiting',
        'a worker following a waiting instruction must not flap to working before new work is actually served');
      slowPoll.resolve({ status: 'waiting', remaining: { ready: 0, working: 1, needsYou: 0 } });
      await poll;
      await engine.close();
    },
  },
  {
    name: 'handoff bridge: engine: a pool submit does not spend its successor-probe budget before polling again',
    run: async () => {
      let successorProbes = 0;
      const push = {
        refreshHubs: async () => true,
        status: () => ({ discovered: [{ tasks: [{ task: 'job-scoring', pending: 1 }] }], working: 0 }),
        get: async () => ({
          status: 'served', handoffCode: 'POOL-PROMPT', task: 'job-scoring', prompt: 'Synthetic prompt.',
          remaining: { ready: 0, working: 0, needsYou: 0 },
        }),
        submit: async () => ({ status: 'accepted' }),
        nextAfterAccept: async () => { successorProbes += 1; return new Promise(() => {}); },
        closeEpoch: () => undefined,
      };
      const engine = createHandoffEngine({
        sources: { application: source().api, push },
        scope: { applications: false, scoring: true, marketplace: false },
        holdMs: 0,
      });
      const pool = await engine.startWorkerPool({ linkId: LINK, requestedWorkers: 1 });
      const starter = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
      const served = await engine.get({ session: starter.sessionCode, linkId: LINK });
      const accepted = await engine.submit({
        session: starter.sessionCode, linkId: LINK, handoffCode: served.handoffCode,
        response: 'Synthetic completed response '.repeat(8),
      });
      assert(accepted.status === 'accepted' && accepted.next?.status === 'waiting'
        && accepted.next.retryAfterSeconds === CONSTANTS.POOL_WAIT_MIN_SECONDS && successorProbes === 0,
        'a pool submit immediately gives its worker a poll instruction instead of spending the successor-probe budget');
      await engine.close();
    },
  },
  {
    name: 'handoff bridge: engine: a held job also stops the chat as idle, with its own truthful note',
    run: async () => {
      const state = await started();
      assert((await state.engine.hold(JOB_A)).ok, 'hold');
      const stopped = await state.engine.get({ session: state.session, linkId: LINK });
      assert(stopped.status === 'paused' && stopped.reason === 'needs_user' && stopped.note === RESULT_NOTES.needsAttention && !/bridge is paused/i.test(stopped.note), `needs_user is not a bridge pause, got ${stopped.note}`);
      assert(state.engine.snapshot().chat.state === 'idle', 'ChatGPT was told to stop, so the chat is idle');
    },
  },
  {
    name: 'handoff bridge: engine: a lane reports how long it has been in its CURRENT phase, not since release',
    run: async () => {
      const harness = liveBridgeHarness();
      const { engine, clock } = harness;
      assert((await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] })).ok, 'release');
      const releasedAt = clock.now();
      const chat = await engine.newChat({ linkId: LINK });
      clock.advance(11 * 60_000);
      assert((await engine.get({ session: chat.sessionCode, linkId: LINK })).status === 'served', 'served after 11 minutes of being released');
      const awaitingSince = engine.snapshot().queue.jobs[0].changedAt;
      assert(awaitingSince === clock.now(), `entering awaiting is the phase entry (${awaitingSince} vs ${clock.now()})`);
      clock.advance(60_000);
      await engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: 'HANDOFF-REVIEW', response: answer({ code: 'HANDOFF-REVIEW', stage: 'review' }) });
      const hostAt = clock.now();
      assert(engine.snapshot().queue.jobs[0].phase === 'host' && engine.snapshot().queue.jobs[0].changedAt === hostAt, 'entering host restarts the phase clock');
      clock.advance(30_000); harness.saved(); clock.advance(CONSTANTS.HOST_POLL_MS + 1);
      await engine.get({ session: chat.sessionCode, linkId: LINK });
      const row = engine.snapshot().queue.jobs[0];
      assert(row.phase === 'done' && row.changedAt > hostAt && row.changedAt < releasedAt + 13 * 60_000, 'done is stamped when the lane finished');
      const reduced = reduceBridgeQueue({ at: clock.now() + 4000, enabled: true, serving: 'live', lanes: [row], queue: {}, chat: engine.snapshot().chat, counts: {} });
      assert(reduced.lanes[0].ageSeconds < 60, `the bug report's "in this phase" is seconds for a lane that just finished, got ${reduced.lanes[0].ageSeconds}s`);
      // Resuming a held lane restarts the clock too.
      const other = await started();
      assert((await other.engine.hold(JOB_A)).ok, 'hold'); other.clock.advance(5 * 60_000);
      assert((await other.engine.resume({ jobId: JOB_A })).ok && other.engine.snapshot().queue.jobs[0].changedAt === other.clock.now(), 'resume is a phase change');
    },
  },
  {
    name: 'handoff bridge: engine: idle is a closed chat state in every consumer, and the tool surface did not change',
    run: async () => {
      const raw = state => ({ at: 1, enabled: true, serving: 'live', lanes: [], queue: {}, chat: { state }, counts: {} });
      for (const state of ['idle', 'ended', 'working', 'full']) assert(reduceBridgeQueue(raw(state)).chat.state === state, `${state} must survive the bug-report reducer`);
      assert(reduceBridgeQueue(raw('made-up')).chat.state === 'none', 'an unknown state still collapses');
      assert(surfaceHash(TOOLS_LIST) === SURFACE_PIN, 'a runtime result note must not change the surface ChatGPT caches');
    },
  },
);

// ---- Each fix of the "saved job reads as work" bug pinned on its own ----------
// The stale-flag fix has two halves that fail differently, so each has a test
// that goes red when ONLY that half is reverted.
tests.push(
  {
    // Reverting only laneBusy(): a hint landed while the lane was AWAITING (the
    // flag is set while ChatGPT writes), the final answer is accepted, the lane
    // goes host then done, and the flag is still set on the finished lane.
    name: 'handoff bridge: engine: a hint that landed while ChatGPT was writing does not keep a saved job "waiting"',
    run: async () => {
      const harness = liveBridgeHarness();
      const { engine, clock } = harness;
      assert((await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] })).ok, 'release');
      const chat = await engine.newChat({ linkId: LINK });
      const first = await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(first.status === 'served', `served, got ${first.status}`);
      clock.advance(CONSTANTS.HINT_MIN_INTERVAL_MS + 1);
      assert(engine.hint({ jobId: JOB_A }) === true, 'the hint lands on the awaiting lane');
      const accepted = await engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: 'HANDOFF-REVIEW', response: answer({ code: 'HANDOFF-REVIEW', stage: 'review' }) });
      assert(accepted.status === 'accepted' && accepted.jobComplete === true, `accepted as complete, got ${accepted.status}`);
      assert(engine.snapshot().queue.jobs[0].phase === 'host', 'the app is saving it');
      harness.saved();
      clock.advance(CONSTANTS.HOST_POLL_MS + 1);
      const next = await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(next.status === 'queue_empty', `a saved job with a stale hint is not work; expected queue_empty, got ${next.status}/${next.reason ?? ''}`);
      assert(engine.snapshot().queue.jobs[0].phase === 'done', 'the lane finished');
    },
  },
  {
    // Reverting only hint() to flag awaiting lanes alone: a lane held while
    // awaiting, whose stage the person advanced by pasting, comes back awaiting
    // with its OLD handoff on Resume unless the hint flagged the held lane.
    name: 'handoff bridge: engine: a lane held while awaiting, hinted after the person advanced its stage, never serves the old prompt after Resume',
    run: async () => {
      let code = 'HANDOFF-A'; let stage = 'resume';
      const submitted = [];
      const { engine, clock, session } = await started({ sourceOverrides: {
        read: async () => ({ kind: 'open', handoff: handoff({ code, stage }) }),
        submit: async (lane, { code: sent }) => { submitted.push(sent); return { kind: 'accepted', completed: true }; },
      } });
      const first = await engine.get({ session, linkId: LINK });
      assert(first.status === 'served' && first.handoffCode === 'HANDOFF-A', 'the resume stage is served');
      assert((await engine.hold(JOB_A)).ok, 'the person presses Keep for me');
      code = 'HANDOFF-HUMAN'; stage = 'cover-letter'; // they answered that stage by paste in the dock
      clock.advance(CONSTANTS.HINT_MIN_INTERVAL_MS + 1);
      assert(engine.hint({ jobId: JOB_A }) === true, 'the card publication change hints the held lane');
      assert((await engine.resume({ jobId: JOB_A })).ok, 'resume');
      const after = await engine.get({ session, linkId: LINK });
      assert(!(after.status === 'served' && after.handoffCode === 'HANDOFF-A'), 'the retired prompt must never be served again');
      assert(after.status === 'paused' && after.reason === 'needs_user', `the lane re-reads and asks for the person, got ${after.status}/${after.reason ?? ''}`);
      assert(engine.snapshot().queue.jobs[0].reason === 'human_advance', 'the re-read found the advanced stage');
      assert(submitted.length === 0, 'nothing was submitted for the retired code');
    },
  },
  {
    // Reverting only the pre-refresh guard in get() to awaiting lanes: a hinted
    // HOST lane must be re-read before a ready scoring item is served, so the
    // job's continuation is not passed over.
    name: 'handoff bridge: engine: a hinted host lane is refreshed before a push item is served (its continuation goes first)',
    run: async () => {
      const clock = createFakeClock();
      let building = false; let appCode = 'HANDOFF-A'; let appStage = 'resume'; let pushReady = false;
      const application = {
        read: async () => building ? { kind: 'host' } : { kind: 'open', handoff: handoff({ code: appCode, stage: appStage }) },
        status: async () => building ? { kind: 'host' } : { kind: 'awaiting', read: true },
        submit: async () => { building = true; return { kind: 'accepted', completed: true }; },
      };
      const push = {
        get: async () => pushReady
          ? { status: 'served', handoffCode: 'PUSH-1', task: 'job-scoring', prompt: 'score', remaining: { ready: 1, working: 0, needsYou: 0 } }
          : { status: 'queue_empty', remaining: { ready: 0, working: 0, needsYou: 0 } },
        submit: async () => ({ status: 'unknown_handoff' }),
      };
      const engine = createHandoffEngine({ sources: { application, push }, scope: { applications: true, scoring: true }, now: clock.now, timers: clock, random: () => Buffer.alloc(26, 7), holdMs: 0 });
      assert((await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] })).ok, 'release');
      const chat = await engine.newChat({ linkId: LINK });
      const first = await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert((await engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: first.handoffCode, response: answer({ code: first.handoffCode }) })).status === 'accepted', 'accepted');
      assert(engine.snapshot().queue.jobs[0].phase === 'host', 'the app is building the next stage');
      assert((await engine.get({ session: chat.sessionCode, linkId: LINK })).status === 'waiting', 'still building');
      building = false; appCode = 'HANDOFF-B'; appStage = 'cover-letter'; pushReady = true;
      clock.advance(CONSTANTS.HINT_MIN_INTERVAL_MS + 1);
      engine.hint({ jobId: JOB_A });
      const next = await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(next.status === 'served' && next.handoffCode === 'HANDOFF-B' && next.stage === 'cover-letter', `the job's continuation is served before the scoring item, got ${next.status}/${next.handoffCode}`);
    },
  },
  {
    name: 'handoff bridge: engine: a submit from a durable-waiting chat remains working, and a held submit marks it idle',
    run: async () => {
      const harness = liveBridgeHarness();
      const { engine, clock } = harness;
      const session = await liveBridgeServedAndSubmitted(harness);
      for (let polls = 0; polls < CONSTANTS.MAX_CONSECUTIVE_WAITS + 2; polls += 1) {
        clock.advance(CONSTANTS.HOST_POLL_MS + 1);
        if ((await engine.get({ session, linkId: LINK })).status !== 'waiting') break;
      }
      assert(engine.snapshot().chat.state === 'working', 'durable waiting leaves the chat available to submit');
      // ChatGPT is heard again, by a submit rather than a get.
      const reply = await engine.submit({ session, linkId: LINK, handoffCode: 'HANDOFF-REVIEW', response: answer({ code: 'HANDOFF-REVIEW', stage: 'review' }) });
      assert(reply.status !== 'paused', `the submit is answered normally, got ${reply.status}`);
      assert(engine.snapshot().chat.state === 'working', `a submit means the chat is not stopped, got ${engine.snapshot().chat.state}`);

      // A submit whose answer is turned away with "stop" (the job was kept for the person) reads idle, like a stopping get.
      const state = await served();
      assert((await state.engine.hold(JOB_A)).ok, 'the person holds the job while ChatGPT writes');
      const held = await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: 'HANDOFF-A', response: answer() });
      assert(held.status === 'held', `the answer is turned away as held, got ${held.status}`);
      assert(state.engine.snapshot().chat.state === 'idle', `ChatGPT was told to stop, so the chat is idle, got ${state.engine.snapshot().chat.state}`);
      // A real bridge pause is not this: gate() answers it before the chat is touched.
    },
  },
  {
    name: 'handoff bridge: engine: work served or an answer accepted resets the wait streak, so a busy chat is never told to stop',
    run: async () => {
      let n = 1; let building = false;
      const { engine, clock, session } = await started({ sourceOverrides: {
        read: async () => building ? { kind: 'host' } : { kind: 'open', handoff: handoff({ code: `HANDOFF-${n}`, stage: 'review', revision: n, prompt: `Round ${n}` }) },
        status: async () => building ? { kind: 'host' } : { kind: 'awaiting', read: true },
        submit: async () => { building = true; n += 1; return { kind: 'accepted', completed: true }; },
      } });
      const rounds = CONSTANTS.MAX_CONSECUTIVE_WAITS + 4;
      for (let round = 1; round <= rounds; round += 1) {
        clock.advance(10_000);
        const got = await engine.get({ session, linkId: LINK });
        assert(got.status === 'served', `round ${round}: expected served, got ${got.status}/${got.reason ?? ''}`);
        clock.advance(30_000);
        const sent = await engine.submit({ session, linkId: LINK, handoffCode: got.handoffCode, response: answer({ code: got.handoffCode, stage: 'review' }) });
        assert(sent.status === 'accepted', `round ${round}: accepted, got ${sent.status}`);
        clock.advance(5_000 + CONSTANTS.HOST_POLL_MS);
        const wait = await engine.get({ session, linkId: LINK }); // the app builds: one legitimate wait per round
        assert(wait.status === 'waiting' && wait.pollCount === 1, `round ${round}: a single wait (pollCount 1), got ${wait.status}/${wait.pollCount ?? ''}/${wait.reason ?? ''}`);
        building = false;
      }
      assert(engine.snapshot().chat.state === 'working', 'the chat was never told to stop');
    },
  },
  {
    name: 'handoff bridge: engine: a push item served resets the wait streak too',
    run: async () => {
      const clock = createFakeClock();
      let mode = 'waiting'; let served = 0;
      const push = {
        get: async () => mode === 'ready'
          ? { status: 'served', handoffCode: `PUSH-${served += 1}`, task: 'job-scoring', prompt: 'score', remaining: { ready: 1, working: 0, needsYou: 0 } }
          : { status: 'waiting', remaining: { ready: 0, working: 1, needsYou: 0 } },
        submit: async () => ({ status: 'unknown_handoff' }),
      };
      const engine = createHandoffEngine({ sources: { application: source().api, push }, scope: { applications: true, scoring: true }, now: clock.now, timers: clock, random: () => Buffer.alloc(26, 7), holdMs: 0 });
      const chat = await engine.newChat({ linkId: LINK });
      const call = { session: chat.sessionCode, linkId: LINK };
      for (let round = 1; round <= 3; round += 1) {
        mode = 'waiting';
        for (let poll = 1; poll <= CONSTANTS.MAX_CONSECUTIVE_WAITS - 2; poll += 1) {
          clock.advance(1000);
          const wait = await engine.get(call);
          assert(wait.status === 'waiting', `round ${round} poll ${poll}: expected waiting, got ${wait.status}/${wait.reason ?? ''}`);
        }
        mode = 'ready'; clock.advance(1000);
        assert((await engine.get(call)).status === 'served', `round ${round}: the scoring item is served`);
      }
    },
  },
  {
    name: 'handoff bridge: engine: a hint on a host lane with no get waiting probes it in the background, once, so a saved job finishes without ChatGPT polling',
    run: async () => {
      const harness = liveBridgeHarness();
      const { engine, clock } = harness;
      await liveBridgeServedAndSubmitted(harness);
      assert(engine.snapshot().queue.jobs[0].phase === 'host', 'the app is saving it');
      harness.saved();
      clock.advance(CONSTANTS.HINT_MIN_INTERVAL_MS + 1);
      engine.hint({ jobId: JOB_A });
      await settle();
      assert(engine.snapshot().queue.jobs[0].phase === 'done', 'no get was made, yet the saved job finished');

      // No probe storm: while one probe is in flight, further hints start none.
      let statusCalls = 0; let stall = false; const gate = deferred();
      const busy = await started({ sourceOverrides: { status: () => { statusCalls += 1; return stall ? gate.promise : Promise.resolve({ kind: 'host' }); } } });
      const first = await busy.engine.get({ session: busy.session, linkId: LINK });
      assert((await busy.engine.submit({ session: busy.session, linkId: LINK, handoffCode: first.handoffCode, response: answer({ code: first.handoffCode }) })).status === 'accepted', 'accepted');
      assert(busy.engine.snapshot().queue.jobs[0].phase === 'host', 'host');
      stall = true;
      const before = statusCalls;
      for (let hints = 0; hints < 5; hints += 1) { busy.clock.advance(CONSTANTS.HINT_MIN_INTERVAL_MS + 1); busy.engine.hint({ jobId: JOB_A }); await settle(); }
      assert(statusCalls - before === 1, `one in-flight probe per lane, got ${statusCalls - before}`);
      gate.resolve({ kind: 'host' });
      await settle();
      // A throwing source never escapes the background probe.
      const broken = await started({ sourceOverrides: { status: async () => { throw new Error('boom'); } } });
      const one = await broken.engine.get({ session: broken.session, linkId: LINK });
      await broken.engine.submit({ session: broken.session, linkId: LINK, handoffCode: one.handoffCode, response: answer({ code: one.handoffCode }) });
      broken.clock.advance(CONSTANTS.HINT_MIN_INTERVAL_MS + 1);
      assert(broken.engine.hint({ jobId: JOB_A }) === true, 'hint');
      await settle();
    },
  },
  {
    name: 'handoff bridge: engine: a restored lane has a phase-entry time from the restore, and hold/resume go through setPhase',
    run: async () => {
      const lane = rehydrateApplicationLane({ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, releasedAt: 10, phase: 'held', reason: 'user_hold', heldFrom: 'awaiting' }, 7777);
      assert(lane.changedAt === 7777, `an already-held lane restores with the restore time, got ${lane.changedAt}`);
      const live = rehydrateApplicationLane({ ord: 2, jobId: JOB_B, canvasFilePath: PATH_B, releasedAt: 10, phase: 'awaiting' }, 8888);
      assert(live.phase === 'held' && live.changedAt === 8888, 'a lane restored from a live phase is held at the restore time');
      const clock = createFakeClock(); clock.advance(5000);
      const engine = createHandoffEngine({ source: source().api, now: clock.now, timers: clock, random: () => Buffer.alloc(26, 7), holdMs: 0 });
      assert(engine.restore([{ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, releasedAt: 10, phase: 'needs_user', reason: 'read_failed', heldFrom: 'unread' }]) === 1, 'restored');
      assert(engine.snapshot().queue.jobs[0].changedAt === clock.now(), 'the dock and bug report age a restored lane from the restore, not from its release');
    },
  },
  {
    name: 'handoff bridge: engine: a late older save success cannot clear a newer persistence failure',
    run: async () => {
      const saves = [];
      const store = { saveLanes: lanes => { const gate = deferred(); saves.push({ lanes, gate }); return gate.promise; } };
      const { engine } = pendingEngine(store);
      const releasing = engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      await settle();
      const holding = engine.hold(JOB_A, 'user_hold');
      await settle();
      assert(saves.length === 2, 'both writes are in flight');

      saves[1].gate.resolve(false);
      await settle();
      assert(engine.snapshot().fault === 'persist_failed', 'the newer failed write is visible as the current fault');
      saves[0].gate.resolve(true);
      assert((await holding).code === 'persist_failed', 'the newer operation reports its failed save');
      assert((await releasing).ok, 'the older operation itself did save');
      assert(engine.snapshot().fault === 'persist_failed', 'the late older success must not clear the newer failure');
    },
  },
  {
    name: 'handoff bridge: engine: rollback reconciliation persists the concurrent winner and clears its fault only after that write succeeds',
    run: async () => {
      const saves = [];
      const store = { saveLanes: lanes => { const gate = deferred(); saves.push({ lanes, gate }); return gate.promise; } };
      const { engine } = pendingEngine(store, { read: async () => ({ kind: 'host' }) });
      const releasing = engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      await settle();
      const chat = await engine.newChat({ linkId: LINK });
      await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(rowOf(engine, JOB_A)?.phase === 'host', 'a concurrent source result wins the lane state before release rollback');

      saves[0].gate.resolve(false);
      assert((await releasing).code === 'persist_failed', 'the original release write fails');
      await settle();
      assert(saves.length === 2 && engine.snapshot().fault === 'persist_failed', 'rollback schedules a corrective write while faulted');
      const repaired = saves[1].lanes.find(lane => lane.jobId === JOB_A);
      assert(repaired?.phase === 'host', `the corrective snapshot must contain the winning host state, got ${repaired?.phase}`);

      saves[1].gate.resolve(true);
      await settle();
      assert(engine.snapshot().fault === null, 'only the successful corrective write clears the persistence fault');
    },
  },
  {
    name: 'handoff bridge: engine: lane-store writes receive immutable snapshots rather than live lane arrays',
    run: async () => {
      const saves = [];
      const store = { saveLanes: lanes => { const gate = deferred(); saves.push({ lanes, gate }); return gate.promise; } };
      const { engine } = pendingEngine(store);
      const releaseA = engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      await settle();
      const first = saves[0].lanes;
      const releaseB = engine.release({ jobs: [{ jobId: JOB_B, canvasFilePath: PATH_B }] });
      await settle();
      assert(Object.isFrozen(first) && Object.isFrozen(first[0]) && Object.isFrozen(first[0].counters), 'the store receives a deeply frozen lane snapshot');
      assert(first.length === 1 && first[0].jobId === JOB_A, 'the first write stays at its original one-lane state');
      assert(saves[1].lanes.length === 2 && saves[1].lanes.some(lane => lane.jobId === JOB_B), 'the later release appears only in its own write');
      saves[0].gate.resolve(true); saves[1].gate.resolve(true);
      assert((await releaseA).ok && (await releaseB).ok, 'both writes complete');
    },
  },
  {
    name: 'handoff bridge: engine: a dynamic restore arriving during a restore probe is subsequently probed',
    run: async () => {
      const firstProbe = deferred(); const probed = [];
      const clock = createFakeClock();
      const engine = createHandoffEngine({
        source: source({ status: async ({ jobId }) => {
          probed.push(jobId);
          return jobId === JOB_A ? firstProbe.promise : { kind: 'host' };
        } }).api,
        now: clock.now, timers: clock, random: () => Buffer.alloc(26, 7), holdMs: 0,
        restoredLanes: [{ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, releasedAt: 1, phase: 'unread', counters: {} }],
      });
      await settle();
      assert(JSON.stringify(probed) === JSON.stringify([JOB_A]), 'the initial restore probe is in flight');
      assert(engine.restore([{ ord: 2, jobId: JOB_B, canvasFilePath: PATH_B, releasedAt: 2, phase: 'unread', counters: {} }]) === 2, 'the second restore remains synchronous');
      firstProbe.resolve({ kind: 'host' });
      await settle();
      assert(probed.filter(jobId => jobId === JOB_B).length === 1, 'the dynamically restored lane is probed after the active pass finishes');
    },
  },
  {
    name: 'handoff bridge: engine: a restore probe that lands after Resume does not spend the resumed lane\'s retry budget',
    run: async () => {
      const firstProbe = deferred(); let probes = 0;
      const clock = createFakeClock();
      const engine = createHandoffEngine({
        source: source({ status: async () => {
          probes += 1;
          return probes === 1 ? firstProbe.promise : { kind: 'busy' };
        } }).api,
        now: clock.now, timers: clock, random: () => Buffer.alloc(26, 7), holdMs: 0,
        restoredLanes: [{ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, releasedAt: 1, phase: 'unread', counters: {} }],
      });
      await settle();
      assert(probes === 1, 'the initial restore probe is pending');
      assert((await engine.resume({ jobId: JOB_A })).ok && rowOf(engine, JOB_A)?.phase === 'unread', 'Resume changes the lane before the old probe returns');
      firstProbe.resolve({ kind: 'busy' });
      await settle();
      assert((await engine.hold(JOB_A, 'user_hold')).ok, 'the lane becomes probe-eligible again in a new revision');
      for (let attempt = 0; attempt < 5; attempt += 1) { await engine.tick(); await settle(); }
      assert(probes === 6, `the stale probe spends no retry: one stale plus five fresh probes expected, got ${probes}`);
    },
  },
  {
    name: 'handoff bridge: engine: a hinted revision fences stale read and status results instead of adopting their retired handoffs',
    run: async () => {
      // A fresh-lane read is already in flight when the app tells us the lane changed.
      {
        const readGate = deferred(); let reads = 0;
        const clock = createFakeClock();
        const engine = createHandoffEngine({
          source: source({
            read: async () => {
              reads += 1;
              return reads === 1
                ? readGate.promise
                : { kind: 'open', handoff: handoff({ code: 'HANDOFF-FRESH', stage: 'cover-letter' }) };
            },
          }).api,
          now: clock.now, timers: clock, random: () => Buffer.alloc(26, 7), holdMs: 0,
        });
        await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
        const chat = await engine.newChat({ linkId: LINK });
        const pending = engine.get({ session: chat.sessionCode, linkId: LINK });
        await settle();
        assert(reads === 1 && engine.hint({ jobId: JOB_A }), 'the stale read is in flight when the hint advances the lane revision');
        readGate.resolve({ kind: 'open', handoff: handoff({ code: 'HANDOFF-RETIRED', stage: 'resume' }) });
        const stale = await pending;
        assert(!(stale.status === 'served' && stale.handoffCode === 'HANDOFF-RETIRED'), 'the old read is never served after the hint');
        const fresh = await engine.get({ session: chat.sessionCode, linkId: LINK });
        assert(fresh.status === 'served' && fresh.handoffCode === 'HANDOFF-FRESH', `the follow-up read serves the fresh handoff, got ${fresh.status}/${fresh.handoffCode ?? ''}`);
      }

      // The same rule applies to a background host-status probe.
      {
        const statusGate = deferred(); let reads = 0; let statuses = 0;
        const clock = createFakeClock();
        const engine = createHandoffEngine({
          source: source({
            read: async () => {
              reads += 1;
              return reads === 1
                ? { kind: 'host' }
                : { kind: 'open', handoff: handoff({ code: 'HANDOFF-FRESH-STATUS', stage: 'cover-letter' }) };
            },
            status: async () => {
              statuses += 1;
              return statuses === 1
                ? statusGate.promise
                : { kind: 'awaiting', read: true };
            },
          }).api,
          now: clock.now, timers: clock, random: () => Buffer.alloc(26, 7), holdMs: 0,
        });
        await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
        const chat = await engine.newChat({ linkId: LINK });
        await engine.get({ session: chat.sessionCode, linkId: LINK });
        assert(rowOf(engine, JOB_A)?.phase === 'host', 'the initial read leaves the lane with the app');
        assert(engine.hint({ jobId: JOB_A }), 'the first hint starts a host-status probe');
        await settle();
        clock.advance(CONSTANTS.HINT_MIN_INTERVAL_MS + 1);
        assert(statuses === 1 && engine.hint({ jobId: JOB_A }), 'a second hint advances the lane while that status is in flight');
        statusGate.resolve({ kind: 'open', handoff: handoff({ code: 'HANDOFF-RETIRED-STATUS', stage: 'resume' }) });
        await settle();
        const fresh = await engine.get({ session: chat.sessionCode, linkId: LINK });
        assert(fresh.status === 'served' && fresh.handoffCode === 'HANDOFF-FRESH-STATUS', `the stale status cannot adopt its handoff, got ${fresh.status}/${fresh.handoffCode ?? ''}`);
      }
    },
  },
  {
    name: 'handoff bridge: engine: a failed durable source result writes a corrective snapshot and clears fault only after it succeeds',
    run: async () => {
      const saves = [];
      const store = { saveLanes: lanes => { const gate = deferred(); saves.push({ lanes, gate }); return gate.promise; } };
      const { engine } = pendingEngine(store, { read: async () => ({ kind: 'threw', code: 'LOCAL_AI_JOB_INTEGRITY' }) });
      const release = engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      await settle(); saves.shift().gate.resolve(true);
      assert((await release).ok, 'release persists first');
      const chat = await engine.newChat({ linkId: LINK });
      const getting = engine.get({ session: chat.sessionCode, linkId: LINK });
      await settle();
      assert(saves.length === 1, 'the durable source result has one pending write');
      saves.shift().gate.resolve(false);
      await getting;
      await settle();
      assert(engine.snapshot().fault === 'persist_failed' && saves.length === 1, 'a failed source-result write schedules one corrective snapshot');
      const corrected = saves[0].lanes.find(lane => lane.jobId === JOB_A);
      assert(corrected?.phase === 'needs_user' && corrected.reason === 'job_broken', 'the corrective snapshot retains the source-result state');
      saves.shift().gate.resolve(true);
      await settle();
      assert(engine.snapshot().fault === null, 'the successful corrective snapshot clears the fault');
    },
  },
  {
    name: 'handoff bridge: engine: a reconciliation request from a new source generation survives an old in-flight worker',
    run: async () => {
      const saves = [];
      const store = { saveLanes: lanes => { const gate = deferred(); saves.push({ lanes, gate }); return gate.promise; } };
      const { engine } = pendingEngine(store);
      const release = engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      await settle(); saves.shift().gate.resolve(true);
      assert((await release).ok, 'release persists first');

      const firstHold = engine.hold(JOB_A, 'user_hold');
      await settle(); saves.shift().gate.resolve(false);
      await firstHold; await settle();
      assert(saves.length === 1, 'the old-generation reconciliation write is in flight');

      assert(engine.onPowerResume(), 'power resume starts a new source generation');
      await settle();
      const secondHold = engine.hold(JOB_A, 'rejection_cap');
      await settle();
      assert(saves.length === 2, 'the new-generation operation has its own write');
      saves[1].gate.resolve(false);
      await secondHold;
      saves[0].gate.resolve(true);
      await settle();
      assert(saves.length === 3, 'the new-generation reconciliation is not lost when the old worker exits');
      saves[2].gate.resolve(true);
      await settle();
      assert(engine.snapshot().fault === null, 'the surviving new-generation reconciliation eventually succeeds');
    },
  },
  {
    name: 'handoff bridge: engine: re-entrant public restore from an audit callback remains synchronous and restores one lane once',
    run: async () => {
      let engine; let restored = null; let auditCalls = 0;
      const clock = createFakeClock();
      engine = createHandoffEngine({
        source: source().api,
        audit: { append: event => {
          if (event === 'release' && auditCalls++ === 0) {
            restored = engine.restore([{ ord: 2, jobId: JOB_B, canvasFilePath: PATH_B, releasedAt: 2, phase: 'unread', counters: {} }]);
          }
          return Promise.resolve(true);
        } },
        now: clock.now, timers: clock, random: () => Buffer.alloc(26, 7), holdMs: 0,
      });
      assert((await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] })).ok, 'the release completes despite re-entrant restore');
      assert(restored === 2, `restore preserves its synchronous numeric contract, got ${restored}`);
      const ids = engine.snapshot().queue.jobs.map(job => job.jobId);
      assert(ids.filter(jobId => jobId === JOB_A).length === 1 && ids.filter(jobId => jobId === JOB_B).length === 1,
        `the re-entrant restore applies exactly once, got ${JSON.stringify(ids)}`);
    },
  },
  {
    name: 'handoff bridge: engine: a restart confirmation cannot silently unhold a lane restored after its dialog was shown',
    run: async () => {
      const confirmation = deferred(); let displayed = null;
      const clock = createFakeClock();
      const engine = createHandoffEngine({
        source: source().api,
        restoredLanes: [{ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, releasedAt: 1, phase: 'unread', counters: {} }],
        confirmRestart: async ords => { displayed = ords.slice(); return confirmation.promise; },
        now: clock.now, timers: clock, random: () => Buffer.alloc(26, 7), holdMs: 0,
      });
      const preparing = engine.newChat({ linkId: LINK });
      await settle();
      assert(JSON.stringify(displayed) === JSON.stringify([1]), `the dialog displayed only the original lane, got ${JSON.stringify(displayed)}`);
      assert(engine.restore([{ ord: 2, jobId: JOB_B, canvasFilePath: PATH_B, releasedAt: 2, phase: 'unread', counters: {} }]) === 2, 'a second restart-held lane arrives while the dialog is pending');
      confirmation.resolve(true);
      await preparing;
      const late = rowOf(engine, JOB_B);
      assert(late?.phase === 'held' && late.reason === 'restart', `a stale confirmation must not unhold the undisplayed lane, got ${late?.phase}/${late?.reason}`);
    },
  },
  {
    name: 'handoff bridge: engine: a failed old Hold preserves an accepted submit without clobbering a later Hold reason',
    run: async () => {
      const submitGate = deferred(); const saves = []; let slow = false;
      const store = { saveLanes: () => {
        if (!slow) return Promise.resolve(true);
        const gate = deferred(); saves.push(gate); return gate.promise;
      } };
      const state = await served({ engineOptions: { store }, sourceOverrides: { submit: () => submitGate.promise } });
      const { engine, session, result } = state;
      const inFlight = engine.submit({ session, linkId: LINK, handoffCode: result.handoffCode, response: answer({ code: result.handoffCode, stage: result.stage }) });
      await settle();
      slow = true;
      const firstHold = engine.hold(JOB_A, 'user_hold');
      await settle();
      assert(saves.length === 1, 'the first Hold write is pending');
      submitGate.resolve({ kind: 'accepted', completed: false, handoff: handoff({ code: 'HANDOFF-A2', stage: 'cover-letter' }) });
      await settle();
      assert(saves.length === 2, 'the accepted result stages its own durable state');
      const laterHold = engine.hold(JOB_A, 'rejection_cap');
      await settle();
      assert(saves.length === 3, 'the later Hold stages after the accepted result');

      saves[0].resolve(false);
      saves[1].resolve(true);
      saves[2].resolve(true);
      assert((await firstHold).code === 'persist_failed', 'the old Hold write fails');
      assert((await inFlight).status === 'accepted', 'the submit was accepted while it was held');
      assert((await laterHold).ok, 'the later Hold persists');
      const row = rowOf(engine, JOB_A);
      assert(row?.phase === 'held' && row.reason === 'rejection_cap', `the later Hold marker wins, got ${row?.phase}/${row?.reason}`);
      assert(row.stage === 'cover-letter' && row.awaitingAnswer === false && row.servedAt === null,
        `the accepted bookkeeping remains intact, got ${row.stage}/${row.awaitingAnswer}/${row.servedAt}`);
      const savesBeforeRepeat = saves.length;
      const changedAtBeforeRepeat = row.changedAt;
      assert((await engine.hold(JOB_A, 'rejection_cap')).ok, 'an exact repeat Hold is accepted as a no-op');
      await settle();
      assert(saves.length === savesBeforeRepeat && rowOf(engine, JOB_A)?.changedAt === changedAtBeforeRepeat,
        'an identical Hold neither starts another save nor restamps its marker');
    },
  },
  {
    name: 'handoff bridge: engine: stale awaiting and needs-user status results cannot undo newer Hold or Resume state',
    run: async () => {
      const run = async (outcome, mutate, verify) => {
        const statusGate = deferred(); let reads = 0;
        const clock = createFakeClock();
        const engine = createHandoffEngine({
          source: source({
            read: async () => (++reads === 1 ? { kind: 'host' } : { kind: 'open', handoff: handoff({ code: 'HANDOFF-FRESH-STATUS', stage: 'cover-letter' }) }),
            status: async () => statusGate.promise,
          }).api,
          now: clock.now, timers: clock, random: () => Buffer.alloc(26, 7), holdMs: 0,
        });
        await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
        const chat = await engine.newChat({ linkId: LINK });
        await engine.get({ session: chat.sessionCode, linkId: LINK });
        assert(rowOf(engine, JOB_A)?.phase === 'host', 'fixture starts with a host lane');
        assert(engine.hint({ jobId: JOB_A }), 'hint starts the deferred status call');
        await settle();
        await mutate(engine);
        statusGate.resolve(outcome);
        await settle();
        verify(engine);
      };

      await run({ kind: 'awaiting', read: true }, engine => engine.hold(JOB_A, 'user_hold'), engine => {
        const row = rowOf(engine, JOB_A);
        assert(row?.phase === 'held' && row.reason === 'user_hold', `stale awaiting cannot unhold the later Hold, got ${row?.phase}/${row?.reason}`);
      });
      await run({ kind: 'needs_user', reason: 'job_broken' }, async engine => {
        assert((await engine.hold(JOB_A, 'user_hold')).ok, 'newer Hold');
        assert((await engine.resume({ jobId: JOB_A })).ok, 'newer Resume');
      }, engine => {
        const row = rowOf(engine, JOB_A);
        assert(row?.phase === 'unread' && row.reason === null, `stale needs_user cannot re-hold after Resume, got ${row?.phase}/${row?.reason}`);
      });
    },
  },
  {
    name: 'handoff bridge: engine: reversed successful physical writes are repaired with a final current snapshot',
    run: async () => {
      const saves = []; let disk = [];
      const store = { saveLanes: lanes => {
        const gate = deferred(); saves.push({ lanes, gate });
        return gate.promise.then(ok => { if (ok !== false) disk = lanes; return ok; });
      } };
      const { engine } = pendingEngine(store);
      const first = engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      await settle();
      const second = engine.release({ jobs: [{ jobId: JOB_B, canvasFilePath: PATH_B }] });
      await settle();
      assert(saves.length === 2, 'two immutable writes are pending');
      saves[1].gate.resolve(true);
      assert((await second).ok, 'v2 completes first');
      saves[0].gate.resolve(true);
      assert((await first).ok, 'v1 completes late and physically overwrites v2');
      await settle();
      assert(saves.length === 3, 'the engine schedules one final current snapshot');
      saves[2].gate.resolve(true);
      await settle();
      const ids = disk.map(lane => lane.jobId).sort();
      assert(JSON.stringify(ids) === JSON.stringify([JOB_A, JOB_B].sort()), `durable sink converges to the newest lanes, got ${JSON.stringify(ids)}`);
    },
  },
  {
    name: 'handoff bridge: engine: a semaphore-queued malformed X submit cannot affect or call after a same-stage read rotates to Y',
    run: async () => {
      const gates = [deferred(), deferred()]; const sent = []; let reads = 0; let sourceCode = 'HANDOFF-X';
      const clock = createFakeClock();
      const engine = createHandoffEngine({
        source: source({
          read: async () => {
            reads += 1;
            return { kind: 'open', handoff: handoff({ code: sourceCode, stage: 'resume' }) };
          },
          submit: async (_lane, payload) => {
            sent.push(payload.code);
            return gates[sent.length - 1].promise;
          },
        }).api,
        now: clock.now, timers: clock, random: () => Buffer.alloc(26, 7), holdMs: 0,
      });
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      const chat = await engine.newChat({ linkId: LINK });
      const first = await engine.get({ session: chat.sessionCode, linkId: LINK });
      // A never-issued code is deliberately held as a human advance. Establish
      // Y once, then return to the already-issued X so the target read can
      // adopt Y and exercise the semaphore fence rather than that hold policy.
      sourceCode = 'HANDOFF-Y';
      assert(engine.hint({ jobId: JOB_A }), 'the first rotation invalidates X');
      await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(rowOf(engine, JOB_A)?.reason === 'human_advance', 'an unknown Y is first fenced as a human advance');
      assert((await engine.resume({ jobId: JOB_A })).ok, 'resume permits the first Y read');
      assert((await engine.get({ session: chat.sessionCode, linkId: LINK })).handoffCode === 'HANDOFF-Y', 'Y is now an issued code');
      sourceCode = 'HANDOFF-X';
      clock.advance(CONSTANTS.HINT_MIN_INTERVAL_MS + 1);
      assert(engine.hint({ jobId: JOB_A }), 'the source rotates back to issued X');
      await engine.get({ session: chat.sessionCode, linkId: LINK });
      const submit = (suffix, response = answer({ code: first.handoffCode, extra: { text: `Synthetic answer ${suffix} `.repeat(8) } })) => engine.submit({
        session: chat.sessionCode, linkId: LINK, handoffCode: first.handoffCode, response,
      });
      const blockerOne = submit('one'); const blockerTwo = submit('two');
      await settle();
      assert(sent.length === 2 && sent.every(code => code === 'HANDOFF-X'), 'two admitted submits occupy both semaphore slots');
      const queued = submit('three');
      await settle();
      sourceCode = 'HANDOFF-Y';
      clock.advance(CONSTANTS.HINT_MIN_INTERVAL_MS + 1);
      assert(engine.hint({ jobId: JOB_A }), 'the app advances the lane while the third submit waits');
      await engine.get({ session: chat.sessionCode, linkId: LINK });
      const rotated = rowOf(engine, JOB_A);
      assert(reads === 5 && rotated?.stage === 'resume' && rotated?.phase === 'awaiting',
        `the lane re-reads and adopts Y before the queued submit runs (reads ${reads}, ${rotated?.phase}/${rotated?.stage})`);
      assert(rotated.reason === null, 'the queued X request has not held the successor before its slot opens');
      gates[0].resolve({ kind: 'accepted', completed: true }); gates[1].resolve({ kind: 'accepted', completed: true });
      await Promise.all([blockerOne, blockerTwo]);
      const result = await queued;
      const final = rowOf(engine, JOB_A);
      assert(sent.length === 2 && ['duplicate', 'superseded', 'retry', 'unknown_handoff'].includes(result.status),
        `no X payload reaches the adapter against Y (calls ${sent.length}, got ${result.status})`);
      assert(final?.stage === 'resume' && final.reason === null,
        'the queued stale X request leaves Y unheld');
      const junkBefore = engine.snapshot().counts.submitJunk;
      const staleJunk = await submit('stale-junk', 'not an application response');
      const afterJunk = rowOf(engine, JOB_A);
      assert(sent.length === 2 && ['unknown_handoff', 'duplicate', 'superseded'].includes(staleJunk.status),
        `a malformed stale X request cannot reach the adapter (calls ${sent.length}, got ${staleJunk.status})`);
      assert(afterJunk?.stage === 'resume' && afterJunk.reason === null && engine.snapshot().counts.submitJunk === junkBefore,
        'a malformed stale X request cannot classify against or hold Y');
    },
  },
  {
    name: 'handoff bridge: engine: a gone probe for an old canvas path cannot remove a lane after path adoption',
    run: async () => {
      const statusGate = deferred(); const paths = []; let statuses = 0;
      const clock = createFakeClock();
      const engine = createHandoffEngine({
        source: source({
          read: async () => ({ kind: 'open', handoff: handoff({ code: 'HANDOFF-PATH' }) }),
          status: async ({ canvasFilePath }) => {
            paths.push(canvasFilePath); statuses += 1;
            return statuses === 1 ? statusGate.promise : { kind: 'host' };
          },
          adoptCanvasPath: async () => ({ adopted: true }),
        }).api,
        now: clock.now, timers: clock, random: () => Buffer.alloc(26, 7), holdMs: 0,
      });
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      const chat = await engine.newChat({ linkId: LINK });
      const serving = engine.get({ session: chat.sessionCode, linkId: LINK });
      await settle();
      assert(paths[0] === PATH_A, 'the serve-time probe claimed the old path');
      assert((await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_B }] })).ok, 'Release adopts the new canvas path');
      statusGate.resolve({ kind: 'gone' });
      const served = await serving;
      assert(rowOf(engine, JOB_A) && paths.includes(PATH_B), `the old-path gone result cannot remove the adopted lane (${JSON.stringify(paths)})`);
      assert(served.status === 'served', `the retried new-path probe still serves the lane, got ${served.status}`);
    },
  },
  {
    name: 'handoff bridge: engine: restore rescans probe a dynamic lane once without re-spending an active inconclusive lane',
    run: async () => {
      const first = deferred(); const calls = { [JOB_A]: 0, [JOB_B]: 0 };
      const clock = createFakeClock();
      const engine = createHandoffEngine({
        source: source({ status: async ({ jobId }) => {
          calls[jobId] += 1;
          if (jobId === JOB_A && calls[jobId] === 1) return first.promise;
          return jobId === JOB_B ? { kind: 'host' } : { kind: 'busy' };
        } }).api,
        now: clock.now, timers: clock, random: () => Buffer.alloc(26, 7), holdMs: 0,
        restoredLanes: [{ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, releasedAt: 1, phase: 'unread', counters: {} }],
      });
      await settle();
      assert(calls[JOB_A] === 1, 'A has one active inconclusive probe');
      assert(engine.restore([{ ord: 2, jobId: JOB_B, canvasFilePath: PATH_B, releasedAt: 2, phase: 'unread', counters: {} }]) === 2, 'B dynamically restores');
      assert(engine.restore([{ ord: 2, jobId: JOB_B, canvasFilePath: PATH_B, releasedAt: 2, phase: 'unread', counters: {} }]) === 2, 'a duplicate restore adds nothing');
      await engine.tick();
      first.resolve({ kind: 'busy' });
      await settle();
      assert(calls[JOB_A] === 1 && calls[JOB_B] === 1, `only B gets the rescan; calls ${JSON.stringify(calls)}`);
    },
  },
  {
    name: 'handoff bridge: engine: two gets sharing a stale read cannot consume refresh and later serve its old handoff',
    run: async () => {
      const readGate = deferred(); let reads = 0;
      const clock = createFakeClock();
      const engine = createHandoffEngine({
        source: source({ read: async () => {
          reads += 1;
          return reads === 1 ? readGate.promise : { kind: 'open', handoff: handoff({ code: 'HANDOFF-NEWEST', stage: 'cover-letter' }) };
        } }).api,
        now: clock.now, timers: clock, random: () => Buffer.alloc(26, 7), holdMs: 0,
      });
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      const chat = await engine.newChat({ linkId: LINK });
      const one = engine.get({ session: chat.sessionCode, linkId: LINK });
      await settle();
      assert(engine.hint({ jobId: JOB_A }), 'first hint advances the read revision');
      clock.advance(CONSTANTS.HINT_MIN_INTERVAL_MS + 1);
      assert(engine.hint({ jobId: JOB_A }), 'second hint also advances it');
      const two = engine.get({ session: chat.sessionCode, linkId: LINK });
      await settle();
      assert(reads === 1, 'both gets share the original in-flight read');
      readGate.resolve({ kind: 'open', handoff: handoff({ code: 'HANDOFF-OLD', stage: 'resume' }) });
      const [first, second] = await Promise.all([one, two]);
      assert(![first, second].some(value => value.status === 'served' && value.handoffCode === 'HANDOFF-OLD'), 'neither shared stale read is served');
      const fresh = await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(fresh.status === 'served' && fresh.handoffCode === 'HANDOFF-NEWEST', `refresh remains owed and serves newest code, got ${fresh.status}/${fresh.handoffCode ?? ''}`);
    },
  },
  {
    name: 'handoff bridge: engine: a release save made stale by power resume schedules a current-generation snapshot',
    run: async () => {
      const saves = []; let disk = [];
      const store = { saveLanes: lanes => {
        const gate = deferred(); saves.push({ lanes, gate });
        return gate.promise.then(ok => { if (ok !== false) disk = lanes; return ok; });
      } };
      const { engine } = pendingEngine(store);
      const release = engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      await settle();
      assert(saves.length === 1 && engine.onPowerResume(), 'the release write is pending across power resume');
      await settle();
      saves[0].gate.resolve(true);
      assert((await release).code === 'not_ready', 'the old-generation release completion is fenced');
      await settle();
      assert(saves.length === 2, 'a current-generation snapshot is scheduled after the fenced write');
      saves[1].gate.resolve(true);
      await settle();
      assert(disk.length === 1 && disk[0].jobId === JOB_A, 'the durable sink receives the current lane snapshot');
    },
  },
  {
    name: 'handoff bridge: engine: late accepted or rejected X results cannot disturb an already-served Y successor',
    run: async () => {
      for (const kind of ['accepted', 'rejected']) {
        const resultGate = deferred(); let sourceCode = 'HANDOFF-Y'; let reads = 0;
        const clock = createFakeClock();
        const engine = createHandoffEngine({
          source: source({
            read: async () => {
              reads += 1;
              return { kind: 'open', handoff: handoff({ code: sourceCode, stage: 'resume' }) };
            },
            submit: async () => resultGate.promise,
          }).api,
          now: clock.now, timers: clock, random: () => Buffer.alloc(26, 7), holdMs: 0,
        });
        await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
        const chat = await engine.newChat({ linkId: LINK });
        assert((await engine.get({ session: chat.sessionCode, linkId: LINK })).handoffCode === 'HANDOFF-Y', `${kind}: Y is issued first`);
        sourceCode = 'HANDOFF-X';
        assert(engine.hint({ jobId: JOB_A }), `${kind}: X invalidates Y`);
        await engine.get({ session: chat.sessionCode, linkId: LINK });
        assert(rowOf(engine, JOB_A)?.reason === 'human_advance', `${kind}: X is initially held until confirmed`);
        assert((await engine.resume({ jobId: JOB_A })).ok, `${kind}: resume X`);
        const x = await engine.get({ session: chat.sessionCode, linkId: LINK });
        assert(x.handoffCode === 'HANDOFF-X', `${kind}: X is issued and served`);
        const old = engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: x.handoffCode,
          response: answer({ code: x.handoffCode, stage: x.stage }) });
        await settle();

        sourceCode = 'HANDOFF-Y';
        clock.advance(CONSTANTS.HINT_MIN_INTERVAL_MS + 1);
        assert(engine.hint({ jobId: JOB_A }), `${kind}: source rotates to issued Y while X is pending`);
        const y = await engine.get({ session: chat.sessionCode, linkId: LINK });
        assert(y.status === 'served' && y.handoffCode === 'HANDOFF-Y', `${kind}: Y is served before X lands`);
        const before = rowOf(engine, JOB_A);
        const readsBeforeLanding = reads;
        resultGate.resolve(kind === 'accepted'
          ? { kind: 'accepted', completed: false, handoff: handoff({ code: `HANDOFF-X-${kind}`, stage: 'review' }) }
          : { kind: 'rejected', validationErrors: ['synthetic'], handoff: handoff({ code: `HANDOFF-X-${kind}`, stage: 'review' }) });
        await old;
        await settle();
        const after = rowOf(engine, JOB_A);
        assert(after?.phase === 'awaiting' && after.stage === 'resume' && after.awaitingAnswer === true && after.servedAt === before.servedAt,
          `${kind}: late X cannot clear or restamp Y's outstanding serve`);
        const replay = await engine.get({ session: chat.sessionCode, linkId: LINK });
        assert(replay.status === 'served' && replay.handoffCode === 'HANDOFF-Y' && reads === readsBeforeLanding,
          `${kind}: late X cannot make Y re-read or serve an X successor`);
        const successor = await engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: `HANDOFF-X-${kind}`,
          response: answer({ code: `HANDOFF-X-${kind}`, stage: 'review' }) });
        assert(successor.status === 'unknown_handoff', `${kind}: X's successor is never indexed onto Y`);
      }
    },
  },
  {
    name: 'handoff bridge: engine: an X recovery after Y rotation retries fresh Y and a stale submit watchdog cannot hold Y',
    run: async () => {
      const prepareXWithIssuedY = async ({ submit, submitBudgetMs = undefined } = {}) => {
        let sourceCode = 'HANDOFF-Y'; const clock = createFakeClock();
        const engine = createHandoffEngine({
          source: source({
            read: async () => ({ kind: 'open', handoff: handoff({ code: sourceCode, stage: 'resume' }) }),
            submit,
          }).api,
          now: clock.now, timers: clock, random: () => Buffer.alloc(26, 7), holdMs: 0,
          ...(submitBudgetMs === undefined ? {} : { submitBudgetMs }),
        });
        await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
        const chat = await engine.newChat({ linkId: LINK });
        await engine.get({ session: chat.sessionCode, linkId: LINK });
        sourceCode = 'HANDOFF-X';
        assert(engine.hint({ jobId: JOB_A }), 'X invalidates initial Y');
        await engine.get({ session: chat.sessionCode, linkId: LINK });
        assert((await engine.resume({ jobId: JOB_A })).ok, 'resume permits X to be issued');
        const x = await engine.get({ session: chat.sessionCode, linkId: LINK });
        assert(x.handoffCode === 'HANDOFF-X', 'X is the submitted issued code');
        return {
          engine, clock, chat, x,
          rotateToY: async () => {
            sourceCode = 'HANDOFF-Y';
            clock.advance(CONSTANTS.HINT_MIN_INTERVAL_MS + 1);
            assert(engine.hint({ jobId: JOB_A }), 'Y invalidates X while its submit is pending');
            const y = await engine.get({ session: chat.sessionCode, linkId: LINK });
            assert(y.status === 'served' && y.handoffCode === 'HANDOFF-Y', 'issued Y is served before X settles');
            return y;
          },
        };
      };

      const throwGate = deferred(); const submittedCodes = [];
      const recovery = await prepareXWithIssuedY({ submit: async (_lane, payload) => {
        submittedCodes.push(payload.code);
        if (submittedCodes.length === 1) return throwGate.promise;
        return { kind: 'rejected', validationErrors: ['synthetic'], handoff: handoff({ code: 'HANDOFF-Y', stage: 'resume' }) };
      } });
      const old = recovery.engine.submit({ session: recovery.chat.sessionCode, linkId: LINK, handoffCode: recovery.x.handoffCode,
        response: answer({ code: recovery.x.handoffCode, stage: recovery.x.stage }) });
      await settle();
      await recovery.rotateToY();
      throwGate.reject(Object.assign(new Error('synthetic I/O failure'), { code: 'EIO' }));
      const recovered = await old;
      assert(recovered.status === 'rejected' && JSON.stringify(submittedCodes) === JSON.stringify(['HANDOFF-X', 'HANDOFF-Y']),
        `an X recovery must retry the fresh Y code exactly once (${JSON.stringify(submittedCodes)})`);
      const recoveredRow = rowOf(recovery.engine, JOB_A);
      assert(recoveredRow?.phase === 'awaiting' && recoveredRow.stage === 'resume' && recoveredRow.reason === null,
        'the fresh Y recovery remains the active, unheld handoff');

      const stuckGate = deferred(); const stuckCodes = [];
      const stuck = await prepareXWithIssuedY({ submitBudgetMs: CONSTANTS.HINT_MIN_INTERVAL_MS + 10, submit: async (_lane, payload) => {
        stuckCodes.push(payload.code); return stuckGate.promise;
      } });
      const pending = stuck.engine.submit({ session: stuck.chat.sessionCode, linkId: LINK, handoffCode: stuck.x.handoffCode,
        response: answer({ code: stuck.x.handoffCode, stage: stuck.x.stage }) });
      await settle();
      await stuck.rotateToY();
      stuck.clock.advance(11);
      await settle();
      const yAfterTimeout = rowOf(stuck.engine, JOB_A);
      assert(yAfterTimeout?.phase === 'awaiting' && yAfterTimeout.reason === null && yAfterTimeout.stage === 'resume' && stuckCodes.length === 1,
        'a stale X submit watchdog cannot hold Y or retry X text against it');
      stuckGate.resolve({ kind: 'rejected', validationErrors: [], handoff: null });
      await pending;
    },
  },
  {
    name: 'handoff bridge: engine: a late X result cannot index its successor after another X completion clears current ownership',
    run: async () => {
      for (const kind of ['accepted', 'rejected']) {
        const gates = [deferred(), deferred()]; let submitted = 0;
        const clock = createFakeClock();
        const engine = createHandoffEngine({
          source: source({ submit: async () => gates[submitted++].promise }).api,
          now: clock.now, timers: clock, random: () => Buffer.alloc(26, 7), holdMs: 0,
        });
        await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
        const chat = await engine.newChat({ linkId: LINK });
        const served = await engine.get({ session: chat.sessionCode, linkId: LINK });
        const send = note => engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: served.handoffCode,
          response: answer({ code: served.handoffCode, stage: served.stage, extra: { note } }) });
        const first = send(`${kind}-first`); const late = send(`${kind}-late`);
        await settle();
        assert(submitted === 2, `${kind}: both X calls are admitted before either settles`);
        gates[0].resolve({ kind: 'accepted', completed: true });
        await first;
        assert(rowOf(engine, JOB_A)?.phase === 'host', `${kind}: first completion clears the lane current handoff`);
        const successorCode = `HANDOFF-X-LATE-${kind}`;
        gates[1].resolve(kind === 'accepted'
          ? { kind: 'accepted', completed: false, handoff: handoff({ code: successorCode, stage: 'review' }) }
          : { kind: 'rejected', validationErrors: ['synthetic'], handoff: handoff({ code: successorCode, stage: 'review' }) });
        await late;
        const successor = await engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: successorCode,
          response: answer({ code: successorCode, stage: 'review' }) });
        assert(submitted === 2 && successor.status === 'unknown_handoff' && rowOf(engine, JOB_A)?.phase === 'host',
          `${kind}: a late result cannot claim a successor on a current-null lane`);
      }
    },
  },
  {
    name: 'handoff bridge: engine: a watchdog-expired A read is fenced before its same-lane replacement wins',
    run: async () => {
      const firstRead = deferred(); const replacementRead = deferred(); let reads = 0;
      const clock = createFakeClock();
      const engine = createHandoffEngine({
        source: source({ read: async () => (++reads === 1 ? firstRead.promise : replacementRead.promise) }).api,
        now: clock.now, timers: clock, random: () => Buffer.alloc(26, 7), holdMs: 0, readWatchdogMs: 10,
      });
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      const chat = await engine.newChat({ linkId: LINK });
      const served = engine.get({ session: chat.sessionCode, linkId: LINK });
      await settle();
      assert(reads === 1, 'A1 owns the initial read slot');
      clock.advance(11);
      await settle();
      assert(reads === 2, 'A watchdog expiry starts same-lane replacement A2');
      firstRead.resolve({ kind: 'open', handoff: handoff({ code: 'HANDOFF-A1-LATE', jobId: JOB_A }) });
      await settle();
      replacementRead.resolve({ kind: 'open', handoff: handoff({ code: 'HANDOFF-A2-WINNER', jobId: JOB_A }) });
      const result = await served;
      assert(result.status === 'served' && result.handoffCode === 'HANDOFF-A2-WINNER',
        `late A1 cannot beat replacement A2 after watchdog expiry (${result.status}/${result.handoffCode ?? ''})`);
    },
  },
  {
    name: 'handoff bridge: engine: a failed retained-A replay never sends or overwrites a later B response',
    run: async () => {
      let mode = 'initial'; const payloads = [];
      const clock = createFakeClock();
      const engine = createHandoffEngine({
        source: source({
          read: async () => ({ kind: 'open', handoff: handoff({ code: 'HANDOFF-A', stage: 'resume' }) }),
          submit: async (_lane, payload) => {
            payloads.push(payload);
            if (mode === 'initial') return { kind: 'threw', code: 'EIO', stage: 'resume' };
            if (mode === 'replay_fails') return { kind: 'threw', code: 'EIO', stage: 'resume' };
            return { kind: 'accepted', completed: true };
          },
        }).api,
        now: clock.now, timers: clock, random: () => Buffer.alloc(26, 7), holdMs: 0,
      });
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      const chat = await engine.newChat({ linkId: LINK });
      const served = await engine.get({ session: chat.sessionCode, linkId: LINK });
      const responseA = answer({ code: served.handoffCode, stage: served.stage, extra: { note: 'synthetic-A' } });
      const responseB = answer({ code: served.handoffCode, stage: served.stage, extra: { note: 'synthetic-B' } });
      const responseB2 = answer({ code: served.handoffCode, stage: served.stage, extra: { note: 'synthetic-B2' } });
      const initial = await engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: served.handoffCode, response: responseA });
      assert(['retry', 'needs_user'].includes(initial.status) && payloads.length > 0,
        `the initial A failure exhausts normal recovery without accepting (${initial.status}, ${payloads.length} calls)`);
      assert(payloads.every(payload => payload.text === responseA), 'normal recovery only sends retained A text');

      mode = 'replay_fails';
      const replayFailure = await engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: served.handoffCode, response: responseB });
      assert(['retry', 'needs_user'].includes(replayFailure.status),
        `a retained-A replay failure remains retryable or held (${replayFailure.status})`);
      assert(payloads.every(payload => payload.text === responseA), 'the first later B request replays A and never sends B');
      if (replayFailure.status === 'needs_user') assert((await engine.resume({ jobId: JOB_A })).ok, 'resume reopens the retained A lane');

      mode = 'accept';
      const replayed = await engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: served.handoffCode, response: responseB2 });
      assert(replayed.status === 'accepted' && payloads.every(payload => payload.text === responseA),
        'the later B request replays and accepts A without ever overwriting retained text');
    },
  },
);

export default tests;
