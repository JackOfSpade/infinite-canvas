import { readFileSync } from 'node:fs';
import { assert } from './testHelpers.js';
import { createModuleRunQueue } from '../../src/utils/moduleRunQueue.js';
import {
  APPLICATION_HANDOFF_LIMIT,
  countActiveApplicationHandoffs,
  applicationRequestId,
} from '../../src/utils/applicationHandoffDock.js';

// A hand-rolled deterministic timer that never really waits. The queue only
// uses `setTimeout(fn, ms)`, `clearTimeout(handle)` and `handle.unref()`, so
// this shape is a drop-in replacement.
function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();

  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, at: now + ms });
      return {
        id,
        unref() {
          // ModuleRunQueue calls this defensively so tests are never kept alive.
        },
      };
    },
    clearTimeout(handle) {
      pending.delete(handle?.id);
    },
    advance(ms) {
      now += ms;
      const due = [...pending.entries()].filter(([, t]) => t.at <= now);
      for (const [id, t] of due) {
        pending.delete(id);
        t.fn();
      }
    },
    pendingCount() {
      return pending.size;
    },
  };
}

const flushMicrotasks = async () => {
  // startEntry runs onStart on one microtask and resolves the acquire promise
  // on the next, so several turns are enough to settle every chained step.
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

// Same fixture shape the dock tests use, copied so this file stays self
// contained. A paste bundle in a non-idle status holds an application slot.
const jobCard = (id, localApplication, extra = {}) => ({
  id,
  type: 'jobcard',
  data: { title: 'Staff Engineer', company: 'Acme', ...extra, localApplication },
});

const pasteJob = (id, status = 'queued') => ({
  id, status, mode: 'paste', canvasFilePath: '/canvas/board.json',
});

const buildTenOccupyingCards = () => Array.from(
  { length: APPLICATION_HANDOFF_LIMIT },
  (_, i) => jobCard(`job-${i + 1}`, pasteJob(`job-${i + 1}`, 'queued')),
);

export default [
  {
    name: 'application slot queue: a refused canStart on an idle lane queues at position 1, blocked, then starts',
    run: async () => {
      const timers = createFakeTimers();
      const queue = createModuleRunQueue({ timers, admissionRecheckMs: 1000 });
      let admit = false;
      let queuedArg = null;
      let startArg = null;
      let startCount = 0;

      const lease = queue.acquireModuleRun({
        lane: 'application',
        nodeId: 'card-a',
        kind: 'application',
        label: 'Application: Acme',
        canStart: () => admit,
        onQueued: (info) => { queuedArg = info; },
        onStart: (info) => { startArg = info; startCount += 1; },
      });

      // The predicate refused while the lane was idle, so the entry must be
      // queued (not started) and reported as blocked at the head.
      assert(queuedArg && queuedArg.position === 1, 'onQueued must report position 1');
      assert(queue.getSnapshot().queued.length === 1, 'one entry should be queued');
      assert(queue.getSnapshot().queued[0].blocked === true, 'head must be blocked');
      assert(queue.getSnapshot().queued[0].position === 1, 'blocked head is at position 1');
      assert(queue.getSnapshot().queued[0].nodeId === 'card-a', 'queued entry keeps its nodeId');
      assert(startCount === 0, 'onStart must NOT fire for a refused entry');
      assert(timers.pendingCount() === 1, 'a blocked head arms exactly one recheck');

      // Flip the predicate and let the recheck fire.
      admit = true;
      timers.advance(1000);
      await flushMicrotasks();

      assert(startCount === 1, 'onStart must fire once admitted');
      assert(startArg.wasQueued === true, 'a formerly queued entry reports wasQueued true');
      assert(startArg.blocked === false, 'blocked must clear once the entry starts');
      assert(queue.getSnapshot().queued.length === 0, 'queued entry moves out of the queue');
      assert(timers.pendingCount() === 0, 'no recheck remains once the head is admitted');

      const settled = await lease;
      assert(typeof settled.release === 'function', 'acquire promise resolves with a release()');
    },
  },
  {
    name: 'application slot queue: strict FIFO keeps a later ready entry behind a blocked head',
    run: async () => {
      const timers = createFakeTimers();
      const queue = createModuleRunQueue({ timers, admissionRecheckMs: 1000 });
      let admitA = false;
      const order = [];

      const pA = queue.acquireModuleRun({
        lane: 'application',
        nodeId: 'card-a',
        label: 'A',
        canStart: () => admitA,
        onStart: () => order.push('A'),
      });
      const pB = queue.acquireModuleRun({
        lane: 'application',
        nodeId: 'card-b',
        label: 'B',
        canStart: () => true,
        onStart: () => order.push('B'),
      });

      assert(queue.getSnapshot().queued.length === 2, 'both entries are queued');
      assert(queue.getSnapshot().queued[0].blocked === true, 'A blocks at the head');
      assert(order.length === 0, 'neither entry starts while A is blocked');

      admitA = true;
      timers.advance(1000);
      await flushMicrotasks();

      assert(order.join(',') === 'A', 'only A may start, not the ready B behind it');

      const aLease = await pA;
      aLease.release();
      await flushMicrotasks();

      assert(order.join(',') === 'A,B', 'B starts only after A is released');
      const bLease = await pB;
      bLease.release();
      await flushMicrotasks();
      assert(order.join(',') === 'A,B', 'order is stable after both finish');
    },
  },
  {
    name: 'application slot queue: two simultaneous acquires never overlap a shared limit-1 slot',
    run: async () => {
      const timers = createFakeTimers();
      const queue = createModuleRunQueue({ timers, admissionRecheckMs: 1000 });
      let used = 0;
      let running = 0;
      let maxRunning = 0;
      const order = [];

      const make = (label) => queue.acquireModuleRun({
        lane: 'application',
        label,
        canStart: () => used < 1,
        onStart: () => {
          order.push(`start:${label}`);
          used += 1;
        },
      }).then(({ release }) => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        order.push(`work:${label}`);
        running -= 1;
        used -= 1;
        release();
        order.push(`done:${label}`);
        return label;
      });

      // Issued back-to-back in click order.
      const results = await Promise.all([make('first'), make('second')]);

      assert(results.join(',') === 'first,second', 'both complete in click order');
      assert(maxRunning === 1, 'at most one entry holds the slot at any time');
      assert(
        order.join(',')
          === 'start:first,work:first,done:first,start:second,work:second,done:second',
        'work must be strictly serialized',
      );
      assert(timers.pendingCount() === 0, 'no admission recheck was needed');
    },
  },
  {
    name: 'application slot queue: cancelQueuedRunsForNode rejects a blocked head and starts the next entry',
    run: async () => {
      const timers = createFakeTimers();
      const queue = createModuleRunQueue({ timers, admissionRecheckMs: 1000 });
      let admitA = false;
      let aCancelCount = 0;
      let aRejection = null;
      let aResolved = false;
      const order = [];

      const pA = queue.acquireModuleRun({
        lane: 'application',
        nodeId: 'node-a',
        label: 'A',
        canStart: () => admitA,
        onCancel: () => { aCancelCount += 1; },
        onStart: () => order.push('A'),
      });
      pA.then(
        () => { aResolved = true; },
        (e) => { aRejection = e; },
      );
      const pB = queue.acquireModuleRun({
        lane: 'application',
        nodeId: 'node-b',
        label: 'B',
        canStart: () => true,
        onStart: () => order.push('B'),
      });

      assert(queue.getSnapshot().queued.length === 2, 'A and B are both queued');
      assert(queue.getSnapshot().queued[0].blocked === true, 'A is the blocked head');

      const cancelled = queue.cancelQueuedRunsForNode('node-a', 'Application generation cancelled before it started');
      await flushMicrotasks();

      assert(cancelled === 1, 'exactly one entry was cancelled');
      assert(aResolved === false, 'the cancelled entry must not resolve');
      assert(aRejection instanceof Error, 'the cancelled entry rejects with an Error');
      assert(aRejection.message === 'Application generation cancelled before it started', 'rejection carries the cancel reason');
      assert(aCancelCount === 1, 'onCancel is called exactly once');
      assert(order.join(',') === 'B', 'the next ready entry becomes head and starts');

      await pB;
    },
  },
  {
    name: 'application slot queue: a throwing canStart rejects the entry and frees the lane',
    run: async () => {
      const timers = createFakeTimers();
      const queue = createModuleRunQueue({ timers, admissionRecheckMs: 1000 });
      const boom = new Error('boom');
      let thrown = null;

      const pThrowing = queue.acquireModuleRun({
        lane: 'application',
        nodeId: 'card-broken',
        label: 'broken',
        canStart: () => { throw boom; },
        onStart: () => { throw new Error('must not start'); },
      });
      pThrowing.then(
        () => { throw new Error('must not resolve'); },
        (e) => { thrown = e; },
      );
      await flushMicrotasks();

      assert(thrown === boom, 'the acquire promise rejects with the thrown error');

      const order = [];
      const pNext = queue.acquireModuleRun({
        lane: 'application',
        nodeId: 'card-next',
        label: 'next',
        onStart: () => order.push('next'),
      });
      await flushMicrotasks();
      assert(order.join(',') === 'next', 'the lane is free for the next entry');

      await pNext;
      assert(timers.pendingCount() === 0, 'no recheck timer leaked from the throw');
    },
  },
  {
    name: 'application slot queue: no timer leak and a single recheck while a head is blocked',
    run: async () => {
      const timers = createFakeTimers();
      const queue = createModuleRunQueue({ timers, admissionRecheckMs: 1000 });
      let admitA = false;
      const order = [];

      const pA = queue.acquireModuleRun({
        lane: 'application', nodeId: 'a', label: 'A',
        canStart: () => admitA,
        onStart: () => order.push('start:A'),
      });
      const pB = queue.acquireModuleRun({
        lane: 'application', nodeId: 'b', label: 'B',
        canStart: () => true,
        onStart: () => order.push('start:B'),
      });
      const pC = queue.acquireModuleRun({
        lane: 'application', nodeId: 'c', label: 'C',
        canStart: () => true,
        onStart: () => order.push('start:C'),
      });

      assert(timers.pendingCount() === 1, 'exactly one recheck timer, even with three queued entries');

      // A recheck fires, sees A still blocked, and merely re-arms the single timer.
      timers.advance(1000);
      assert(timers.pendingCount() === 1, 'a recheck does not accumulate extra timers');
      assert(queue.getSnapshot().queued[0].blocked === true, 'A remains blocked after a recheck');

      admitA = true;
      timers.advance(1000);
      await flushMicrotasks();
      assert(order.join(',') === 'start:A', 'A admitted; B and C stay behind the active A');
      assert(timers.pendingCount() === 0, 'no recheck remains once the head is admitted');

      const a = await pA;
      a.release();
      await flushMicrotasks();
      const b = await pB;
      b.release();
      await flushMicrotasks();
      const c = await pC;
      c.release();
      await flushMicrotasks();

      assert(order.join(',') === 'start:A,start:B,start:C', 'all entries run FIFO');
      assert(timers.pendingCount() === 0, 'no timer is left pending after every entry finishes');
    },
  },
  {
    name: 'application slot queue: entries without canStart keep FIFO with position updates on shift',
    run: async () => {
      const timers = createFakeTimers();
      const queue = createModuleRunQueue({ timers, admissionRecheckMs: 1000 });
      const order = [];
      let p2QueuedPos = null;
      let p3QueuedPos = null;
      const p3Updates = [];

      const p1 = queue.acquireModuleRun({
        lane: 'application', nodeId: 'p1', label: 'P1',
        onStart: () => order.push('P1'),
      });
      const p2 = queue.acquireModuleRun({
        lane: 'application', nodeId: 'p2', label: 'P2',
        onQueued: (info) => { p2QueuedPos = info.position; },
        onStart: () => order.push('P2'),
      });
      const p3 = queue.acquireModuleRun({
        lane: 'application', nodeId: 'p3', label: 'P3',
        onQueued: (info) => { p3QueuedPos = info.position; },
        onQueueUpdate: (info) => p3Updates.push(info.position),
        onStart: () => order.push('P3'),
      });

      assert(p2QueuedPos === 1, 'second entry queues behind the active first at position 1');
      assert(p3QueuedPos === 2, 'third entry queues at position 2');

      const p1Lease = await p1;
      p1Lease.release();
      await flushMicrotasks();

      assert(order.join(',') === 'P1,P2', 'P2 starts after P1 releases');
      assert(p3Updates.join(',') === '2,1', 'P3 is told position 2 at queue time and position 1 after the shift');

      const p2Lease = await p2;
      p2Lease.release();
      await flushMicrotasks();
      assert(order.join(',') === 'P1,P2,P3', 'third entry runs last');
      await p3;
    },
  },
  {
    name: 'application slot queue: real cap blocks an 11th card and admits when a slot frees or is dismissed',
    run: async () => {
      // --- Scenario 1: a full dock blocks the 11th Generate, and a saved
      // bundle frees a slot so the recheck admits it. ---
      const nodesA = buildTenOccupyingCards();
      const dismissedA = new Set();
      const timersA = createFakeTimers();
      const queueA = createModuleRunQueue({ timers: timersA, admissionRecheckMs: 1000 });
      const requestingA = 'request-11';
      const recordA = [];

      const pA = queueA.acquireModuleRun({
        lane: 'application',
        nodeId: requestingA,
        label: '11th application',
        canStart: () => {
          const others = nodesA.filter((n) => n.id !== requestingA);
          return countActiveApplicationHandoffs(others, dismissedA) < APPLICATION_HANDOFF_LIMIT;
        },
        onQueued: (info) => recordA.push(`queued:${info.position}`),
        onStart: () => recordA.push('start'),
      });

      assert(queueA.getSnapshot().queued[0].blocked === true, '11th request is blocked at the cap');
      assert(recordA.join(',') === 'queued:1', '11th request queued at position 1, not started');

      // Mark any bundle finished; the dock no longer counts it.
      nodesA[0].data.localApplication.status = 'saved';
      timersA.advance(1000);
      await flushMicrotasks();

      assert(recordA.join(',') === 'queued:1,start', 'freeing a slot admits the 11th request');
      await pA;

      // --- Scenario 2: a full dock blocks the request, then dismissing a
      // bundle frees its slot so the recheck admits it. ---
      const nodesB = buildTenOccupyingCards();
      const dismissedB = new Set();
      const timersB = createFakeTimers();
      const queueB = createModuleRunQueue({ timers: timersB, admissionRecheckMs: 1000 });
      const requestingB = 'request-12';
      const recordB = [];

      const pB = queueB.acquireModuleRun({
        lane: 'application',
        nodeId: requestingB,
        label: '12th application',
        canStart: () => (
          countActiveApplicationHandoffs(
            nodesB.filter((n) => n.id !== requestingB),
            dismissedB,
          ) < APPLICATION_HANDOFF_LIMIT
        ),
        onQueued: (info) => recordB.push(`queued:${info.position}`),
        onStart: () => recordB.push('start'),
      });

      assert(queueB.getSnapshot().queued[0].blocked === true, 'a full dock with no dismissals blocks the request');
      assert(recordB.join(',') === 'queued:1', 'dismissed-slot request starts queued');

      // Dismissing one of the ten occupying bundles frees its slot.
      dismissedB.add(applicationRequestId('job-2'));
      timersB.advance(1000);
      await flushMicrotasks();
      assert(recordB.join(',') === 'queued:1,start', 'dismissing one bundle frees a slot for the request');
      await pB;

      // --- Scenario 3: a regenerating card is not blocked by its own bundle. ---
      const nodesC = buildTenOccupyingCards();
      const timersC = createFakeTimers();
      const queueC = createModuleRunQueue({ timers: timersC, admissionRecheckMs: 1000 });
      const regeneratingId = 'job-5';
      const recordC = [];

      const pC = queueC.acquireModuleRun({
        lane: 'application',
        nodeId: regeneratingId,
        label: 'regenerated application',
        canStart: () => (
          countActiveApplicationHandoffs(
            nodesC.filter((n) => n.id !== regeneratingId),
            new Set(),
          ) < APPLICATION_HANDOFF_LIMIT
        ),
        onQueued: () => recordC.push('queued'),
        onStart: () => recordC.push('start'),
      });
      await flushMicrotasks();

      assert(recordC.join(',') === 'start', 'a regenerating card starts immediately because its own bundle is excluded');
      assert(queueC.getSnapshot().queued.length === 0, 'regenerating card is not queued');
      await pC;
    },
  },
  {
    name: 'application slot queue: JobCardNode wires canStart, the cap, and a queue-only Cancel with no refusal toast',
    run: () => {
      const card = readFileSync(new URL('../../src/nodes/JobCardNode.jsx', import.meta.url), 'utf8');

      assert(card.includes('canStart:'), 'JobCardNode passes a canStart predicate to the queue');
      assert(
        card.includes('countActiveApplicationHandoffs(handoffCapNodes, getDismissedApplicationBundles())'),
        'canStart reads the real dock capacity and dismissed bundles',
      );
      assert(!card.includes('Too Many Pending Applications'), 'the old click-time refusal toast was removed');

      // The Cancel affordance must live only inside the queued branch.
      const queuedMarker = "{displayedApplicationRun.state === 'queued' && (";
      const queuedIdx = card.indexOf(queuedMarker);
      assert(queuedIdx !== -1, 'the queued conditional exists');
      const blockCloseIdx = card.slice(queuedIdx).indexOf(')}');
      assert(blockCloseIdx !== -1, 'the queued conditional closes with )}');
      const queuedBlock = card.slice(queuedIdx, queuedIdx + blockCloseIdx);
      assert(
        queuedBlock.includes("cancelQueuedRunsForNode(id, 'Application generation cancelled before it started')"),
        'the queued branch cancels the card before it started',
      );

      // canStart is declared before onQueued within the acquireModuleRun options.
      assert(
        card.indexOf('canStart:') !== -1
          && card.indexOf('onQueued:') !== -1
          && card.indexOf('canStart:') < card.indexOf('onQueued:'),
        'canStart appears before onQueued in the acquireModuleRun options',
      );

      return { checkedMarkers: 5 };
    },
  },
];
