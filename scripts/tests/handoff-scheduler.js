import { strict as nodeAssert } from 'node:assert';
import { createDependencyReadyQueue, mapAutomaticHandoffs, runAutomaticHandoffWorkers } from '../../src/utils/handoffScheduler.js';
import { evaluateJobPreferences } from '../test-dependencies.js';

const assert = (condition, message) => nodeAssert.ok(condition, message);

async function yieldUntil(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(message);
}

async function settlesWithin(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export default [
  {
    name: 'handoff scheduler module: automatic work refills immediately, preserves order, and respects its cap',
    run: async () => {
      const calls = [];
      let active = 0;
      let peak = 0;
      let releaseSlow;
      const run = mapAutomaticHandoffs(['slow', 'fast-a', 'fast-b', 'fast-c'], 2, async (item, index) => {
        calls.push(index);
        active += 1;
        peak = Math.max(peak, active);
        if (item === 'slow') await new Promise(resolve => { releaseSlow = resolve; });
        active -= 1;
        return item.toUpperCase();
      });
      await yieldUntil(() => calls.includes(3), 'a completed slot never refilled while its sibling was slow');
      assert(calls.join(',') === '0,1,2,3' && active === 1 && peak === 2,
        `rolling work must refill one slot without exceeding its cap, got ${JSON.stringify({ calls, active, peak })}`);
      releaseSlow();
      const output = await run;
      assert(JSON.stringify(output) === JSON.stringify(['SLOW', 'FAST-A', 'FAST-B', 'FAST-C']) && active === 0,
        `rolling completion must preserve input order, got ${JSON.stringify({ output, active })}`);
      return { peak, output };
    },
  },
  {
    name: 'handoff scheduler module: first work error aborts future claims and drains active siblings',
    run: async () => {
      const controller = new AbortController();
      const claims = ['fails', 'drains', 'must-not-start'];
      const started = [];
      let rejectFailure;
      let finishSibling;
      let siblingSignal;
      const failure = new Error('first handoff failed');
      const run = runAutomaticHandoffWorkers({
        workerCount: 2,
        abortController: controller,
        claim: () => claims.shift() ?? null,
        work: (item, { signal }) => new Promise((resolve, reject) => {
          started.push(item);
          if (item === 'fails') rejectFailure = reject;
          else {
            siblingSignal = signal;
            finishSibling = resolve;
          }
        }),
      });
      const outcome = run.then(() => null, error => error);
      await yieldUntil(() => started.length === 2, 'the initial worker roster did not start');
      rejectFailure(failure);
      await new Promise(resolve => setImmediate(resolve));
      assert(controller.signal.aborted && siblingSignal?.aborted && claims.join(',') === 'must-not-start',
        `first failure must abort the phase and fence future claims, got ${JSON.stringify({ started, claims, aborted: controller.signal.aborted })}`);
      let settled = false;
      void outcome.then(() => { settled = true; });
      await new Promise(resolve => setImmediate(resolve));
      assert(!settled, 'the scheduler rejected before its active sibling had drained');
      finishSibling();
      const rejected = await outcome;
      assert(rejected === failure && started.join(',') === 'fails,drains',
        'the scheduler must retain the first error after draining active work');
      return { drained: true, preservedFirstError: true };
    },
  },
  {
    name: 'handoff scheduler module: dependency-ready work refills a slot before an unrelated predecessor settles',
    run: async () => {
      const queue = createDependencyReadyQueue(['slow-raw', 'fast-raw', 'queued-raw']);
      const started = [];
      let releaseSlow;
      const run = runAutomaticHandoffWorkers({
        workerCount: 2,
        claim: context => queue.claim(context),
        work: async (item) => {
          started.push(item);
          if (item === 'slow-raw') {
            await new Promise(resolve => { releaseSlow = resolve; });
          } else if (item === 'fast-raw') {
            queue.add('ready-assessment', { front: true });
          }
          queue.complete();
        },
      });
      await yieldUntil(() => started.includes('ready-assessment'),
        'a freed worker did not claim newly dependency-ready work');
      assert(started.slice(0, 3).join(',') === 'slow-raw,fast-raw,ready-assessment',
        `priority dependency work must run before an unclaimed raw descriptor, got ${JSON.stringify(started)}`);
      await yieldUntil(() => started.includes('queued-raw'),
        'the ordinary queue did not resume after its dependency-ready successor');
      releaseSlow();
      await run;
      return { started };
    },
  },
  {
    name: 'handoff scheduler integration: a slow legacy probe cannot barrier compatibility raw work',
    run: async () => {
      const jobs = Array.from({ length: 13 }, (_, index) => ({
        title: 'Engineer',
        company: `Accepted Replay Company ${index + 1}`,
      }));
      const preferencePlan = {
        version: 1,
        summary: '',
        direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false },
        softPreferences: [],
        strictRequirements: [{ id: 'benefit', criterion: 'Published training budget', category: 'perk' }],
        warnings: [],
        titles: [],
      };
      let releaseAccepted;
      let acceptedReleased = false;
      const acceptedGate = new Promise(resolve => { releaseAccepted = resolve; });
      const rawStarts = [];
      let legacyProbeCalls = 0;
      const run = evaluateJobPreferences({
        jobs,
        jobPreferences: 'Published training budget',
        preferencePlan,
        // The IPC run-level durable-task gate passes false on a fresh run.
        // This deliberately never-settling probe proves the compatibility
        // discovery seam cannot become a preflight barrier in that case.
        legacyResearchMigrationNeeded: false,
        legacyResearchStepProbe: async () => {
          legacyProbeCalls += 1;
          return new Promise(() => {});
        },
        // Exercise the two-phase compatibility branch too: the old status
        // probe is gone, so its raw work still starts through one roster.
        companyResearchPipelineEligible: false,
        callRaw: async (prompt, options) => {
          const ids = [...new Set(prompt.match(/research-[a-f0-9]{20}/g) || [])];
          rawStarts.push({ batch: options.hints.batch, beforeAcceptedRelease: !acceptedReleased });
          if (options.hints.batch === 1) await acceptedGate;
          return ids.map(id => `BEGIN RESEARCH ${id}\nPublished training budget. https://example.test/${id}\nEND RESEARCH ${id}`).join('\n');
        },
        callText: async (prompt, options) => {
          if (options.task === 'job-preference-evaluation') {
            return { assessments: Array.from({ length: options.hints.itemCount }, (_, index) => ({
              index,
              matches: [{ preferenceId: 'benefit', outcome: 'unverified', evidence: 'Not listed.' }],
            })) };
          }
          const ids = [...new Set(prompt.match(/research-[a-f0-9]{20}/g) || [])];
          return { assessments: ids.map(id => ({
            researchId: id,
            preferenceId: 'benefit',
            outcome: 'confirmed',
            evidence: 'Benefits page.',
            evidenceQuote: 'Published training budget.',
            sourceUrls: [`https://example.test/${id}`],
            sourceDate: '',
          })) };
        },
      });
      for (let attempt = 0; attempt < 200 && rawStarts.length < 2; attempt += 1) {
        await new Promise(resolve => setImmediate(resolve));
      }
      const visibleStartedBeforeAcceptedSettled = rawStarts.some(call => call.batch === 2 && call.beforeAcceptedRelease);
      acceptedReleased = true;
      releaseAccepted();
      const result = await run;
      assert(visibleStartedBeforeAcceptedSettled
        && result.acceptedJobs.length === jobs.length
        && legacyProbeCalls === 0,
      `compatibility raw work must bypass a slow legacy probe and refill beside a slow sibling, got ${JSON.stringify({ rawStarts, legacyProbeCalls, accepted: result.acceptedJobs.length })}`);
      return { rawStarts, accepted: result.acceptedJobs.length, legacyProbeBarrierSkipped: true };
    },
  },
  {
    name: 'handoff scheduler integration: fallback raw rows never inflate overlapping assessment totals',
    run: async () => {
      const jobs = Array.from({ length: 28 }, (_, index) => ({
        title: 'Engineer',
        company: `Fallback Progress Company ${index + 1}`,
      }));
      const preferencePlan = {
        version: 1,
        summary: '',
        direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false },
        softPreferences: [],
        strictRequirements: [{ id: 'benefit', criterion: 'Published training budget', category: 'perk' }],
        warnings: [],
        titles: [],
      };
      const assessmentHints = [];
      const result = await evaluateJobPreferences({
        jobs,
        jobPreferences: 'Published training budget',
        preferencePlan,
        callRaw: async (prompt, options) => {
          if (options.hints.batch === 1) throw new Error('simulated raw transport outage');
          const ids = [...new Set(prompt.match(/research-[a-f0-9]{20}/g) || [])];
          return ids.map(id => `BEGIN RESEARCH ${id}\nPublished training budget. https://example.test/${id}\nEND RESEARCH ${id}`).join('\n');
        },
        callText: async (prompt, options) => {
          if (options.task === 'job-preference-evaluation') {
            return { assessments: Array.from({ length: options.hints.itemCount }, (_, index) => ({
              index,
              matches: [{ preferenceId: 'benefit', outcome: 'unverified', evidence: 'Not listed.' }],
            })) };
          }
          assessmentHints.push(options.hints);
          const ids = [...new Set(prompt.match(/research-[a-f0-9]{20}/g) || [])];
          return { assessments: ids.map(id => ({
            researchId: id,
            preferenceId: 'benefit',
            outcome: 'confirmed',
            evidence: 'Benefits page.',
            evidenceQuote: 'Published training budget.',
            sourceUrls: [`https://example.test/${id}`],
            sourceDate: '',
          })) };
        },
      });
      const hints = assessmentHints[0] || {};
      assert(assessmentHints.length === 1
        && hints.itemCount === 16
        && !Object.hasOwn(hints, 'itemsTotal')
        && !Object.hasOwn(hints, 'batchTotal')
        && !Object.hasOwn(hints, 'progressScopeId')
        && !Object.hasOwn(hints, 'progressUnitId')
        && result.acceptedJobs.length === 16
        && result.filteredJobs.length === 12,
      `a 12-row raw fallback must produce one 16-row assessment without impossible 28/2 totals, got ${JSON.stringify({ assessmentHints, accepted: result.acceptedJobs.length, filtered: result.filteredJobs.length })}`);
      return { assessmentItems: hints.itemCount, accepted: result.acceptedJobs.length, filtered: result.filteredJobs.length };
    },
  },
  {
    name: 'handoff scheduler module: external abort wakes an async parked claim without deadlocking',
    run: async () => {
      const controller = new AbortController();
      let claimSignal;
      const run = runAutomaticHandoffWorkers({
        workerCount: 1,
        signal: controller.signal,
        claim: ({ signal }) => {
          claimSignal = signal;
          return new Promise(() => {});
        },
        work: async () => { throw new Error('a parked claim must never issue work'); },
      });
      await yieldUntil(() => Boolean(claimSignal), 'the async claim never began');
      const reason = new Error('cancel parked claim');
      controller.abort(reason);
      const rejected = await settlesWithin(run.then(() => null, error => error), 250,
        'external abort left a parked claim waiting forever');
      assert(rejected === reason && claimSignal.aborted,
        'external cancellation must reject with its reason and reach the parked claim');
      return { settledAfterExternalAbort: true };
    },
  },
  {
    name: 'handoff scheduler module: combined-signal fallback propagates cancellation when AbortSignal.any is unavailable',
    run: async () => {
      const originalAny = AbortSignal.any;
      const external = new AbortController();
      let workSignal;
      try {
        AbortSignal.any = undefined;
        const run = runAutomaticHandoffWorkers({
          workerCount: 1,
          signal: external.signal,
          claim: () => 'only-item',
          work: (_item, { signal }) => new Promise(resolve => {
            workSignal = signal;
            signal.addEventListener('abort', resolve, { once: true });
          }),
        });
        await yieldUntil(() => Boolean(workSignal), 'fallback scheduler never issued its first item');
        const reason = new Error('fallback external abort');
        external.abort(reason);
        const rejected = await settlesWithin(run.then(() => null, error => error), 250,
          'fallback combined signal did not settle after external cancellation');
        assert(rejected === reason && workSignal.aborted && workSignal.reason === reason,
          'the AbortSignal.any fallback must forward external cancellation to active work');
        return { fallbackUsed: true };
      } finally {
        AbortSignal.any = originalAny;
      }
    },
  },
];
