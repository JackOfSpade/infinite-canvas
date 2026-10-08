import { assert } from './testHelpers.js';
import { HANDOFF_CONCURRENCY } from '../../src/utils/handoffScheduler.js';
import {
  isGroupableBridgeApplication,
  partitionBridgeApplications,
  buildDockNav,
  navGroupContains,
  isGroupOnlyNav,
  buildApplicationPageRows,
  pickWorkerRepresentative,
} from '../../src/utils/applicationBridgePage.js';

const STAGES = ['evidence-plan', 'resume', 'cover-letter', 'review'];

// Deep-freeze an input graph so any accidental mutation throws in strict mode.
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.getOwnPropertyNames(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function heldJob(jobId, phase, extra = {}) {
  return { jobId, phase, stage: 'resume', workerOrdinal: 1, ...extra };
}

function statusWith(jobs, chat = {}) {
  return {
    queue: { jobs },
    chat: { state: null, pool: { active: true, workers: [] }, ...chat },
    paused: false,
    config: { pluginName: 'Acme bridge' },
  };
}

function appRequest(jobId, extra = {}) {
  return { kind: 'application', requestId: `application:${jobId}`, jobId, subject: 'Staff Engineer', ...extra };
}

function pushRequest(id) {
  return { kind: 'task', requestId: id, label: `Push ${id}` };
}

export default [
  {
    name: 'application bridge page: only the working phases are groupable',
    run: () => {
      assert(isGroupableBridgeApplication(appRequest('a'), statusWith([heldJob('a', 'unread')])), 'unread held -> groupable');
      assert(isGroupableBridgeApplication(appRequest('b'), statusWith([heldJob('b', 'awaiting')])), 'awaiting held -> groupable');
      assert(isGroupableBridgeApplication(appRequest('c'), statusWith([heldJob('c', 'host')])), 'host held -> groupable');

      assert(!isGroupableBridgeApplication(appRequest('a'), statusWith([heldJob('a', 'held')])), 'held phase -> not groupable');
      assert(!isGroupableBridgeApplication(appRequest('a'), statusWith([heldJob('a', 'needs_user')])), 'needs_user -> not groupable');
      assert(!isGroupableBridgeApplication(appRequest('a'), statusWith([heldJob('a', 'gone')])), 'gone -> not groupable');
      assert(!isGroupableBridgeApplication(appRequest('a'), statusWith([heldJob('a', 'done')])), 'done -> not groupable');
      assert(!isGroupableBridgeApplication(appRequest('a'), statusWith([heldJob('z', 'unread')])), 'missing job -> not groupable');
    },
  },
  {
    name: 'application bridge page: integrity, unreadable and blocked are excluded while working is fine',
    run: () => {
      const status = statusWith([heldJob('a', 'awaiting')]);
      assert(
        !isGroupableBridgeApplication(appRequest('a', { integrityMessage: 'bad' }), status),
        'integrityMessage excludes even a held lane',
      );
      assert(
        !isGroupableBridgeApplication(appRequest('a', { unreadable: true }), status),
        'unreadable excludes even a held lane',
      );
      assert(
        !isGroupableBridgeApplication(appRequest('a', { workingState: 'blocked' }), status),
        'blocked workingState excludes',
      );
      assert(
        isGroupableBridgeApplication(appRequest('a', { workingState: 'working' }), status),
        'working workingState IS groupable',
      );
    },
  },
  {
    name: 'application bridge page: pushes and jobless applications stay in rest',
    run: () => {
      const status = statusWith([heldJob('a', 'unread')]);
      const request = appRequest('a');
      assert(!isGroupableBridgeApplication(pushRequest('p1'), status), 'push kind -> not groupable');
      assert(!isGroupableBridgeApplication({ kind: 'application', requestId: 'x' }, status), 'missing jobId -> not groupable');
      const partitioned = partitionBridgeApplications([pushRequest('p1'), request, { kind: 'application', requestId: 'x' }], status);
      assert(partitioned.held.length === 1 && partitioned.held[0] === request, 'only the real application is held');
      assert(partitioned.rest.length === 2, 'push and jobless application both rest');
    },
  },
  {
    name: 'application bridge page: buildDockNav order, mix and group position',
    run: () => {
      const status = statusWith([heldJob('h1', 'unread'), heldJob('h2', 'awaiting')]);
      const push = pushRequest('p');
      const manual = appRequest('m'); // no job in status -> manual
      const heldA = appRequest('h1');
      const heldB = appRequest('h2');

      const nav = buildDockNav([push, manual, heldA, heldB], status);
      assert(nav.length === 3, 'push, manual and one group');
      assert(nav[0].type === 'request' && nav[0].request === push, 'push first');
      assert(nav[1].type === 'request' && nav[1].request === manual, 'manual app before group');
      assert(nav[2].type === 'applications', 'group last at first-held position');
      assert(nav[2].requestId === 'application:h1', 'group requestId is the first held request');
      assert(nav[2].requests.length === 2, 'group collects both held apps');
    },
  },
  {
    name: 'application bridge page: the shared page takes the slot of the first held request',
    run: () => {
      const status = statusWith([heldJob('h1', 'unread'), heldJob('h2', 'awaiting')]);
      const manual = appRequest('m');
      const push = pushRequest('p');
      const first = buildDockNav([appRequest('h1'), manual, appRequest('h2')], status);
      assert(first.length === 2 && first[0].type === 'applications' && first[1].request === manual,
        'held, manual, held -> group first, then the manual request');
      assert(first[0].requests.map(request => request.requestId).join() === 'application:h1,application:h2',
        'group members keep input order');
      const middle = buildDockNav([manual, appRequest('h1'), push, appRequest('h2')], status);
      assert(middle.length === 3 && middle[0].request === manual && middle[1].type === 'applications' && middle[2].request === push,
        'manual, held, push, held -> manual, group, push');
    },
  },
  {
    name: 'application bridge page: buildDockNav single held app, none held, and malformed inputs',
    run: () => {
      const single = buildDockNav([pushRequest('p'), appRequest('h')], statusWith([heldJob('h', 'host')]));
      assert(single.length === 2 && single[1].type === 'applications' && single[1].requests.length === 1, 'single held app still groups');

      const none = buildDockNav([pushRequest('p'), appRequest('m')], statusWith([]));
      assert(none.every(entry => entry.type === 'request'), 'no held apps -> only request entries');

      for (const bad of [null, undefined, {}, 'x', [null]]) {
        const nav = buildDockNav(bad, statusWith([heldJob('h', 'unread')]));
        assert(Array.isArray(nav) && nav.length === 0, `build ${String(bad)} -> empty nav`);
      }
    },
  },
  {
    name: 'application bridge page: navGroupContains and isGroupOnlyNav',
    run: () => {
      const nav = buildDockNav([appRequest('a'), appRequest('b'), pushRequest('p')], statusWith([heldJob('a', 'unread'), heldJob('b', 'awaiting')]));
      assert(navGroupContains(nav, 'application:a'), 'group contains first held');
      assert(navGroupContains(nav, 'application:b'), 'group contains second held');
      assert(!navGroupContains(nav, 'p'), 'group does not contain the push');
      assert(!isGroupOnlyNav(nav), 'mixed nav is not group-only');

      assert(isGroupOnlyNav(buildDockNav([appRequest('a')], statusWith([heldJob('a', 'unread')]))), 'one app alone is group-only');
      assert(isGroupOnlyNav([{ type: 'applications', requestId: 'x', requests: [] }]), 'single synthetic group is group-only');
      assert(!isGroupOnlyNav([{ type: 'request', requestId: 'x', request: {} }]), 'single request entry is not group-only');
      assert(!isGroupOnlyNav(null), 'null nav is not group-only');
    },
  },
  {
    name: 'application bridge page: rows derive step states from job.stage',
    run: () => {
      const status = statusWith([heldJob('a', 'awaiting', { stage: 'resume' })]);
      const [row] = buildApplicationPageRows({ held: [appRequest('a')], status, now: 0 });
      const states = row.view.steps.map(step => step.state);
      assert(states.join(',') === 'done,current,upcoming,upcoming', 'resume -> evidence-plan done, resume current, rest upcoming');
      assert(row.stage === 'resume', 'row.stage follows job.stage');

      const unknownJob = heldJob('b', 'awaiting', { stage: 'nonsense' });
      const [rowB] = buildApplicationPageRows({ held: [appRequest('b', { stage: 'cover-letter' })], status: statusWith([unknownJob]) });
      assert(rowB.stage === 'cover-letter', 'falls back to request.stage when job.stage is not a key');

      const [rowC] = buildApplicationPageRows({ held: [appRequest('c')], status: statusWith([heldJob('c', 'awaiting', { stage: 'nonsense' })]) });
      assert(rowC.stage === null, 'stage null when neither job nor request has a key');
    },
  },
  {
    name: 'application bridge page: rows use ordinalFor, tolerate throws, and fall back subject',
    run: () => {
      const status = statusWith([heldJob('a', 'unread')]);
      const [row] = buildApplicationPageRows({ held: [appRequest('a')], status, ordinalFor: () => 7 });
      assert(row.ordinal === 7, 'ordinalFor result is used');

      const [throwing] = buildApplicationPageRows({
        held: [appRequest('a')],
        status,
        ordinalFor: () => { throw new Error('boom'); },
      });
      assert(throwing.ordinal === null, 'a throwing ordinalFor yields null ordinal');

      const [fallback] = buildApplicationPageRows({
        held: [{ kind: 'application', requestId: 'application:a', jobId: 'a', label: 'Only label' }],
        status,
        ordinalFor: () => -1,
      });
      assert(fallback.subject === 'Only label', 'label is used when subject is missing');
      assert(fallback.ordinal === null, 'a non-positive ordinal yields null');

      const [defaultSubject] = buildApplicationPageRows({
        held: [{ kind: 'application', requestId: 'application:a', jobId: 'a' }],
        status,
      });
      assert(defaultSubject.subject === 'This application', 'default subject when neither subject nor label');
    },
  },
  {
    name: 'application bridge page: workerOrdinal and ownerWorker pickup',
    run: () => {
      const worker = { ordinal: 3, state: 'idle', lastCallAt: 100 };
      const status = statusWith(
        [heldJob('a', 'awaiting', { workerOrdinal: 3 }), heldJob('b', 'awaiting', { workerOrdinal: 99 }), heldJob('c', 'awaiting', { workerOrdinal: 1.5 })],
        { pool: { active: true, workers: [worker] } },
      );
      const rows = buildApplicationPageRows({
        held: [appRequest('a'), appRequest('b'), appRequest('c')],
        status,
      });
      assert(rows[0].workerOrdinal === 3, 'in-range integer cardinal kept');
      assert(rows[0].ownerWorker === worker, 'ownerWorker matched by ordinal');
      assert(rows[1].workerOrdinal === null && rows[1].ownerWorker === null, 'out-of-range ordinal -> null');
      assert(rows[2].workerOrdinal === null && rows[2].ownerWorker === null, 'non-integer ordinal -> null');

      const inactive = statusWith([heldJob('a', 'awaiting', { workerOrdinal: 3 })], { pool: { active: false, workers: [worker] } });
      const [row] = buildApplicationPageRows({ held: [appRequest('a')], status: inactive });
      assert(row.workerOrdinal === 3 && row.ownerWorker === null, 'inactive pool never supplies an ownerWorker');
    },
  },
  {
    name: 'application bridge page: showDetail is false when the chat cannot start',
    run: () => {
      const status = statusWith([heldJob('a', 'unread')], { state: 'none' });
      const [row] = buildApplicationPageRows({ held: [appRequest('a')], status });
      assert(row.view.action === 'start-chat', 'no ordinal chat yields start-chat action');
      assert(row.showDetail === false, 'a row with an action hides its detail');

      const liveStatus = statusWith([heldJob('a', 'awaiting', { servedToChat: 1, awaitingAnswer: true, servedAt: 0 })], {
        state: 'working', ordinal: 3, jobsAssigned: 1,
        pool: { active: true, workers: [{ ordinal: 3, state: 'working' }] },
      });
      const [liveRow] = buildApplicationPageRows({ held: [appRequest('a')], status: liveStatus });
      assert(liveRow.view.action === null, 'a working chat has no action');
      assert(liveRow.showDetail === true, 'no action means the row shows its detail');
    },
  },
  {
    name: 'application bridge page: pickWorkerRepresentative priority and empties',
    run: () => {
      assert(pickWorkerRepresentative(null) === null, 'null rows -> null');
      assert(pickWorkerRepresentative('x') === null, 'non-array -> null');
      assert(pickWorkerRepresentative([]) === null, 'empty -> null');

      const mk = (action) => ({ view: { action } });
      const rows = [mk('continue-chat'), mk('start-chat'), mk('continue-chat')];
      assert(pickWorkerRepresentative(rows) === rows[1], 'first start-chat wins');

      const noStart = [mk('continue-chat'), mk(null), mk('continue-chat')];
      assert(pickWorkerRepresentative(noStart) === noStart[0], 'first non-null action otherwise');

      const noAction = [mk(null), mk(null), { view: {} }];
      assert(pickWorkerRepresentative(noAction) === noAction[0], 'falls back to first row');
    },
  },
  {
    name: 'application bridge page: none of the exports mutate their inputs',
    run: () => {
      const status = statusWith([heldJob('a', 'unread'), heldJob('h2', 'awaiting', { workerOrdinal: 2 })], {
        state: 'none',
        pool: { active: true, workers: [{ ordinal: 2, state: 'idle' }] },
      });
      const requests = [
        pushRequest('p'),
        appRequest('a', { corrections: [{ body: 'fix' }] }),
        appRequest('h2'),
        { kind: 'application', requestId: 'x' },
      ];
      const navIn = [{ type: 'applications', requestId: 'application:a', requests: [appRequest('a')] }];
      deepFreeze(status);
      deepFreeze(requests);
      deepFreeze(navIn);

      isGroupableBridgeApplication(requests[1], status);
      partitionBridgeApplications(requests, status);
      buildDockNav(requests, status);
      navGroupContains(navIn, 'application:a');
      isGroupOnlyNav(navIn);
      buildApplicationPageRows({
        held: requests.slice(1, 3),
        status,
        ordinalFor: () => 1,
        now: 123,
      });
      pickWorkerRepresentative([{ requestId: 'application:a', view: { action: 'start-chat' } }]);

      assert(status.paused === false, 'status survived all calls');
      assert(requests.length === 4, 'requests array survived');
      assert(Number.isInteger(HANDOFF_CONCURRENCY) && HANDOFF_CONCURRENCY >= 1, 'sanity: concurrency constant is available');
    },
  },
];
