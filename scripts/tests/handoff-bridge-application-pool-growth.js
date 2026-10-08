import { assert } from './testHelpers.js';
import { createHandoffEngine } from '../../electron/ipc/handoffBridge/engine.js';
import { CONSTANTS } from '../../electron/ipc/handoffBridge/constants.js';

// An application-only worker pool must grow as more bundles are released.
// The pool is sized once, when the first bundle is released; the dock then
// releases the remaining bundles (up to the shared ten-slot cap) one at a
// time as each is created. Growth mints copyable starters only — it never
// opens a chat, retires a worker, or exceeds the shared ceiling. A release
// that names the live link grows the pool at once, without waiting for the
// next worker call; a release that names no link (or a different link) adds
// the lane but mints nothing, and growth still also happens on the next
// authenticated worker call.

const LINK = 'link-synthetic';
const PATH = '/tmp/marisol.canvas';
const CAP = CONSTANTS.MAX_LANES;
// Total queued bundles are not a worker target. Ten unfinished bundles need
// ten live workers; the reviewed ceiling remains a safety maximum only.
const TEN_BUNDLE_LIVE_WORKERS = 10;

// Valid UUID-v4-shaped ids (the engine's JOB_ID_RE), one per index.
const jobId = index => `a0000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const codeFor = id => `HANDOFF-G${Number(id.slice(-12))}`;
const jobs = (from, count) => Array.from({ length: count }, (_unused, offset) => ({ jobId: jobId(from + offset), canvasFilePath: PATH }));

function answer({ id, code, stage }) {
  return JSON.stringify({ jobId: id, stage, handoffCode: code, text: 'Synthetic answer '.repeat(8) });
}

function applicationEngine() {
  let entropy = 0;
  const api = {
    read: async ({ jobId: id }) => ({
      kind: 'open',
      handoff: { code: codeFor(id), jobId: id, stage: 'resume', revision: 1, prompt: 'Synthetic application prompt.' },
    }),
    status: async () => ({ kind: 'host' }),
    submit: async () => ({ kind: 'accepted', completed: true }),
  };
  return createHandoffEngine({
    source: api,
    scope: { applications: true, scoring: false, marketplace: false },
    random: () => Buffer.alloc(26, ++entropy),
    holdMs: 0,
  });
}

const poolOf = engine => engine.snapshot().chat.pool;

export default [
  {
    name: 'handoff bridge: application pool growth: later releases grow a live application-only pool on the next worker call',
    run: async () => {
      const engine = applicationEngine();
      try {
        assert((await engine.release({ jobs: jobs(1, 1) })).ok, 'the first bundle releases');
        const pool = await engine.startWorkerPool({ linkId: LINK });
        const starter = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
        assert(pool.started && pool.workerCount === 1 && starter.copied, 'one released bundle starts a one-worker pool');

        assert((await engine.release({ jobs: jobs(2, 3) })).ok, 'three more bundles release');
        assert(poolOf(engine).workerCount === 1,
          'a release that names no link cannot mint starters: growth waits for the next authenticated worker call');

        const first = await engine.get({ session: starter.sessionCode, linkId: LINK });
        assert(first.status === 'served' && first.handoffCode === codeFor(jobId(1)),
          `worker one keeps the handoff it was already owed (${first.status} ${first.handoffCode})`);
        const grown = poolOf(engine);
        assert(grown.workerCount === 4 && grown.workers.length === 4,
          `the next worker call grows the pool to four (${JSON.stringify(grown.workerCount)})`);
        assert(grown.workers[0].ordinal === 1 && grown.workers[0].state !== 'available',
          'worker one is untouched by growth');
        assert(grown.workers.slice(1).every((worker, index) => worker.ordinal === index + 2 && worker.state === 'available'),
          'workers two to four are minted as unstarted starters; nothing opens a chat');

        let workerTwoStarter = null;
        for (const ordinal of [2, 3, 4]) {
          const copied = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: ordinal });
          assert(copied.copied && copied.workerOrdinal === ordinal && typeof copied.sessionCode === 'string',
            `the minted starter for worker ${ordinal} is copyable`);
          if (ordinal === 2) workerTwoStarter = copied.sessionCode;
        }
        const again = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 2 });
        assert(again.copied === true && again.recopied === true && again.sessionCode === workerTwoStarter,
          'a minted but unpresented starter re-copies its exact same capability');
      } finally {
        await engine.close();
      }
    },
  },
  {
    name: 'handoff bridge: application pool growth: growth stops at the shared ceiling and a further release hits lane_limit',
    run: async () => {
      const engine = applicationEngine();
      try {
        assert((await engine.release({ jobs: jobs(1, TEN_BUNDLE_LIVE_WORKERS) })).ok, `${TEN_BUNDLE_LIVE_WORKERS} bundles release`);
        const pool = await engine.startWorkerPool({ linkId: LINK, requestedWorkers: 1 });
        const starter = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
        assert(pool.started && pool.workerCount === 1 && starter.copied,
          'an explicit one-worker start is only the initial size');

        await engine.get({ session: starter.sessionCode, linkId: LINK });
        assert(poolOf(engine).workerCount === TEN_BUNDLE_LIVE_WORKERS, `ten unfinished bundles grow the pool to exactly ${TEN_BUNDLE_LIVE_WORKERS}`);

        const eleventh = await engine.release({ jobs: jobs(TEN_BUNDLE_LIVE_WORKERS + 1, 1) });
        assert(eleventh.ok === true && eleventh.count === 1,
          `an eleventh unfinished bundle remains durably queued (${JSON.stringify(eleventh)})`);
        await engine.get({ session: starter.sessionCode, linkId: LINK });
        assert(poolOf(engine).workerCount === TEN_BUNDLE_LIVE_WORKERS, 'the pool retains only the live workers needed by pending bundles');
      } finally {
        await engine.close();
      }
    },
  },
  {
    name: 'handoff bridge: application pool growth: ten workers claim ten distinct application handoffs',
    run: async () => {
      const engine = applicationEngine();
      try {
        assert((await engine.release({ jobs: jobs(1, TEN_BUNDLE_LIVE_WORKERS) })).ok, `${TEN_BUNDLE_LIVE_WORKERS} bundles release`);
        const pool = await engine.startWorkerPool({ linkId: LINK });
        assert(pool.started && pool.workerCount === TEN_BUNDLE_LIVE_WORKERS && pool.recommended === TEN_BUNDLE_LIVE_WORKERS,
          `ten released bundles plan ten workers (${JSON.stringify({ count: pool.workerCount, recommended: pool.recommended })})`);
        const starters = Array.from({ length: TEN_BUNDLE_LIVE_WORKERS }, (_unused, index) => {
          const copied = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: index + 1 });
          assert(copied.copied, `worker ${index + 1} starter copies`);
          return copied;
        });
        assert(new Set(starters.map(starter => starter.sessionCode)).size === TEN_BUNDLE_LIVE_WORKERS, 'every live worker has its own session');

        // Lazily-read lanes are claimed a couple per poll round (each worker
        // call reads the oldest unread lane), so a worker told `waiting`
        // simply polls again, exactly as a real pool worker does after its
        // retry hint. Only unserved workers re-poll: a served worker owns
        // its handoff until it answers.
        const results = new Array(TEN_BUNDLE_LIVE_WORKERS).fill(null);
        let rounds = 0;
        while (results.some(result => result === null) && rounds < 10) {
          rounds += 1;
          const pending = starters.map((starter, index) => [starter, index]).filter(([, index]) => results[index] === null);
          const polled = await Promise.all(pending.map(([starter]) => engine.get({ session: starter.sessionCode, linkId: LINK })));
          polled.forEach((result, position) => {
            assert(['served', 'waiting'].includes(result.status), `a worker is served or told to poll again, never ${result.status}`);
            if (result.status === 'served') results[pending[position][1]] = result;
          });
        }
        assert(results.every(result => result !== null), `all ${TEN_BUNDLE_LIVE_WORKERS} workers are served within ${rounds} poll rounds`);
        const served = new Set(results.map(result => result.handoffCode));
        assert(served.size === TEN_BUNDLE_LIVE_WORKERS, `no handoff is served to two workers (${served.size} distinct of ${TEN_BUNDLE_LIVE_WORKERS})`);
        for (let index = 1; index <= TEN_BUNDLE_LIVE_WORKERS; index += 1) {
          assert(served.has(codeFor(jobId(index))), `bundle ${index} is claimed by exactly one worker`);
        }
      } finally {
        await engine.close();
      }
    },
  },
  {
    name: 'handoff bridge: application pool growth: finishing bundles never shrinks a grown pool',
    run: async () => {
      const engine = applicationEngine();
      try {
        assert((await engine.release({ jobs: jobs(1, 1) })).ok, 'the first bundle releases');
        const pool = await engine.startWorkerPool({ linkId: LINK });
        const starter = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
        assert((await engine.release({ jobs: jobs(2, 3) })).ok, 'three more bundles release');
        const first = await engine.get({ session: starter.sessionCode, linkId: LINK });
        assert(poolOf(engine).workerCount === 4, 'the pool grew to four');

        const accepted = await engine.submit({
          session: starter.sessionCode,
          linkId: LINK,
          handoffCode: first.handoffCode,
          response: answer({ id: jobId(1), code: first.handoffCode, stage: first.stage }),
        });
        assert(accepted.status === 'accepted', 'worker one finishes its bundle');
        await engine.get({ session: starter.sessionCode, linkId: LINK });
        const after = poolOf(engine);
        assert(after.workerCount === 4 && after.workers.length === 4,
          'fewer unfinished bundles than workers never retires a worker or a copied starter');
        assert(after.plan.expandBy === 0, 'a pool larger than the remaining work asks for no further growth');
      } finally {
        await engine.close();
      }
    },
  },
  {
    name: 'handoff bridge: application pool growth: the status plan reports no outstanding growth once the pool matches the work',
    run: async () => {
      const engine = applicationEngine();
      try {
        assert((await engine.release({ jobs: jobs(1, 1) })).ok, 'the first bundle releases');
        const pool = await engine.startWorkerPool({ linkId: LINK });
        const starter = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
        assert((await engine.release({ jobs: jobs(2, 5) })).ok, 'five more bundles release');
        await engine.get({ session: starter.sessionCode, linkId: LINK });
        const grown = poolOf(engine);
        assert(grown.workerCount === 6 && grown.plan.recommended === 6 && grown.plan.expandBy === 0,
          `six unfinished bundles plan and hold six workers (${JSON.stringify({ count: grown.workerCount, plan: grown.plan })})`);
        assert(grown.plan.expansionCount === 1 && grown.plan.lastExpansionAdded === 5,
          `one automatic expansion added five workers (${JSON.stringify(grown.plan)})`);
      } finally {
        await engine.close();
      }
    },
  },
  {
    name: 'handoff bridge: application pool growth: a release naming the live link grows the pool at once, while worker one is still busy',
    run: async () => {
      const engine = applicationEngine();
      try {
        assert((await engine.release({ jobs: jobs(1, 1), linkId: LINK })).ok, 'the first bundle releases');
        const pool = await engine.startWorkerPool({ linkId: LINK });
        const starter = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
        assert(pool.started && pool.workerCount === 1 && starter.copied, 'one released bundle starts a one-worker pool');

        const first = await engine.get({ session: starter.sessionCode, linkId: LINK });
        assert(first.status === 'served', 'worker one is served and stays busy');

        assert((await engine.release({ jobs: jobs(2, 1), linkId: LINK })).ok, 'one more bundle releases');
        const grown = poolOf(engine);
        assert(grown.workerCount === 2 && grown.workers.length === 2,
          `the release itself grows the pool to two at once (${JSON.stringify(grown.workerCount)})`);
        assert(grown.workers[0].ordinal === 1 && grown.workers[0].state === 'working',
          'worker one is still busy on its bundle');
        assert(grown.workers[1].ordinal === 2 && grown.workers[1].state === 'available',
          'worker two is minted as an unstarted starter');

        const copied = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 2 });
        assert(copied.copied === true,
          'the minted starter for worker 2 is copyable');
        const again = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 2 });
        assert(again.copied === true && again.recopied === true && again.sessionCode === copied.sessionCode,
          'a minted but unpresented starter re-copies its exact same capability');

        assert((await engine.release({ jobs: jobs(3, 2), linkId: LINK })).ok, 'two more bundles release');
        const expanded = poolOf(engine);
        assert(expanded.workerCount === 4 && expanded.plan.recommended === 4 && expanded.plan.expandBy === 0,
          `the second growing release expands to four workers (${JSON.stringify({ count: expanded.workerCount, plan: expanded.plan })})`);
        assert(expanded.plan.expansionCount === 2 && expanded.plan.lastExpansionAdded === 2,
          `one expansion per growing release added two workers (${JSON.stringify(expanded.plan)})`);
      } finally {
        await engine.close();
      }
    },
  },
  {
    name: 'handoff bridge: application pool growth: a keep-alive re-release of an already-released bundle never expands the pool',
    run: async () => {
      const engine = applicationEngine();
      try {
        assert((await engine.release({ jobs: jobs(1, 1), linkId: LINK })).ok, 'the first bundle releases');
        const pool = await engine.startWorkerPool({ linkId: LINK });
        const starter = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
        await engine.get({ session: starter.sessionCode, linkId: LINK });
        assert((await engine.release({ jobs: jobs(2, 1), linkId: LINK })).ok, 'the second bundle releases');
        const grown = poolOf(engine);
        assert(grown.workerCount === 2, 'the pool is at two workers');
        const expansionCountBefore = grown.plan.expansionCount;

        const replayed = await engine.release({ jobs: jobs(2, 1), linkId: LINK });
        assert(replayed.ok === true && replayed.count === 0,
          `a keep-alive re-release adds nothing (${JSON.stringify(replayed)})`);
        const after = poolOf(engine);
        assert(after.workerCount === 2, 'the pool stays at two workers');
        assert(after.plan.expansionCount === expansionCountBefore,
          'the keep-alive re-release does not count as an expansion');
      } finally {
        await engine.close();
      }
    },
  },
  {
    name: 'handoff bridge: application pool growth: a release naming no link, or a different link, grows nothing and leaves the live chat intact',
    run: async () => {
      const engine = applicationEngine();
      try {
        assert((await engine.release({ jobs: jobs(1, 1), linkId: LINK })).ok, 'the first bundle releases');
        const pool = await engine.startWorkerPool({ linkId: LINK });
        const starter = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
        await engine.get({ session: starter.sessionCode, linkId: LINK });
        const before = poolOf(engine);
        const generationBefore = before.generation;

        const otherLink = await engine.release({ jobs: jobs(2, 1), linkId: 'link-other' });
        assert(otherLink.ok === true && otherLink.count === 1,
          `a release naming a different link adds the lane (${JSON.stringify(otherLink)})`);
        const noLink = await engine.release({ jobs: jobs(3, 1) });
        assert(noLink.ok === true && noLink.count === 1,
          `a release naming no link adds the lane (${JSON.stringify(noLink)})`);

        const after = poolOf(engine);
        assert(after.workerCount === 1 && after.active === true,
          `no starter is minted and the live chat is untouched (${JSON.stringify({ count: after.workerCount, active: after.active })})`);
        assert(after.generation === generationBefore, 'the pool generation is unchanged by a foreign or unnamed release');
        assert(after.workers[0].state === 'working', 'worker one is still busy on its bundle');

        assert((await engine.release({ jobs: jobs(4, 1), linkId: LINK })).ok, 'a release naming the live link follows');
        const caughtUp = poolOf(engine);
        assert(caughtUp.workerCount === 4,
          `the live-link release catches the pool up to four unfinished bundles (${JSON.stringify(caughtUp.workerCount)})`);
      } finally {
        await engine.close();
      }
    },
  },
  {
    name: 'handoff bridge: application pool growth: a release before any pool starts mints nothing',
    run: async () => {
      const engine = applicationEngine();
      try {
        assert((await engine.release({ jobs: jobs(1, 2), linkId: LINK })).ok, 'two bundles release');
        const before = poolOf(engine);
        assert(before.active === false && before.workerCount === 0,
          'a release before any pool starts mints nothing');

        const pool = await engine.startWorkerPool({ linkId: LINK });
        assert(pool.workerCount === 2,
          'the two already-released bundles still size the pool on start');
      } finally {
        await engine.close();
      }
    },
  },
  {
    name: 'handoff bridge: application pool growth: release growth stops at the shared ceiling',
    run: async () => {
      const engine = applicationEngine();
      try {
        assert((await engine.release({ jobs: jobs(1, 1), linkId: LINK })).ok, 'the first bundle releases');
        const pool = await engine.startWorkerPool({ linkId: LINK, requestedWorkers: 1 });
        const starter = engine.copyWorkerStarter({ linkId: LINK, generation: pool.generation, workerOrdinal: 1 });
        assert(pool.started && pool.workerCount === 1 && starter.copied,
          'an explicit one-worker start is only the initial size');
        await engine.get({ session: starter.sessionCode, linkId: LINK });

        assert((await engine.release({ jobs: jobs(2, TEN_BUNDLE_LIVE_WORKERS - 1), linkId: LINK })).ok, `${TEN_BUNDLE_LIVE_WORKERS - 1} more bundles release`);
        assert(poolOf(engine).workerCount === TEN_BUNDLE_LIVE_WORKERS,
          `release growth reaches the ten live workers needed by ten pending bundles`);

        const eleventh = await engine.release({ jobs: jobs(TEN_BUNDLE_LIVE_WORKERS + 1, 1), linkId: LINK });
        assert(eleventh.ok === true && eleventh.count === 1,
          `an extra bundle is queued without expanding total-work limits (${JSON.stringify(eleventh)})`);
        assert(poolOf(engine).workerCount === TEN_BUNDLE_LIVE_WORKERS, 'the pool stays at the negotiated live-worker count');
      } finally {
        await engine.close();
      }
    },
  },
];
