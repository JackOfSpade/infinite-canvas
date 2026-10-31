import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cappedHandoff, resolveOfficialPostings } from '../../electron/ipc/officialPostingService.js';
import { createOfficialPostingStore } from '../../electron/ipc/officialPostingStore.js';
import { normalizeOfficialPosting, officialPostingComparativeTrail, officialPostingLookupStatus, officialResearchSettled } from '../../electron/ipc/officialPostingFields.js';
import { shouldPersistOfficialPostingResult, unresolvedOfficialPosting } from '../../electron/ipc/officialPostingResolver.js';
import { officialPostingSemanticInputHash, officialPostingSemanticProofMatches } from '../../electron/ipc/officialPostingSemantic.js';
import { OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL } from '../../electron/ipc/officialPostingNegativePolicy.js';
import { extractAtsTenant, strictEmployerEqual } from '../../electron/ipc/officialSourceHosts.js';
import { snapshotOfficialPostingLeads } from '../../electron/ipc/officialPostingSnapshot.js';
import { buildOfficialPostingJudgeRequest, canonicalJudgeDescription, decideOfficialPostingJudgments, judgeDescriptionsAgree,
  rankJudgeCitations, validateOfficialPostingJudgeResponse } from '../../electron/ipc/officialPostingJudge.js';
import { _resetOfficialPostingDiscoveryDiagnosticsForTests, buildOfficialPostingDiscoveryMarkdown,
  getOfficialPostingDiscoveryDiagnosticsSnapshot } from '../../electron/ipc/officialPostingDiscoveryDiagnostics.js';
import { hasLiveObservedWorker, registerObservedWorkerAvailability, registerBridgeLauncherAvailability } from '../../electron/ipc/handoffBridge/observedChatContext.js';
import { bridgeComparisonAvailable, bridgeHandoffCapacity } from '../../electron/ipc/handoffBridge/bridgeAvailability.js';
import { recommendWorkerPool } from '../../electron/ipc/handoffBridge/workerPool.js';

const DESCRIPTION = 'Northwind Labs is hiring a Dispatch Engineer to build reliable routing services for regional delivery teams.\n'
  + '• Design the dispatch scheduling service and its reporting pipeline.\n'
  + '• Review route reports with operations leads every week.\n'
  + 'Requirements: five years building backend services in TypeScript or Go.';
const job = (extra = {}) => ({ title: 'Dispatch Engineer', company: 'Northwind Labs', location: 'Lakeview, Ontario, Canada',
  snippet: DESCRIPTION, url: 'https://www.linkedin.com/jobs/view/synthetic-dispatch', sourceJobKey: 'dispatch-1', ...extra });
const POSTING = 'https://job-boards.greenhouse.io/northwind/jobs/4455667';
const CAREERS = 'https://northwind.test/careers';
const leads = [{ id: 'P1', url: POSTING, kind: 'posting', employer: 'Northwind Labs' }, { id: 'P2', url: CAREERS, kind: 'careers', employer: 'Northwind Labs' }];
const chosen = (extra = {}) => ({ choice: 'P1', postingUrl: POSTING, status: 'open', statusQuote: 'Apply for this job',
  employerLinked: true, employerPageUrl: CAREERS, employerLinkQuote: 'View open roles', title: 'Dispatch Engineer',
  employer: 'Northwind Labs', location: 'Lakeview, Ontario, Canada', salary: '', description: DESCRIPTION,
  evidence: [{ scrapedQuote: 'Review route reports with operations leads every week.', officialQuote: 'Review route reports with operations leads every week.' }],
  conflicts: [], ...extra });
const unresolvedAnswer = choice => ({ choice, postingUrl: '', status: 'unknown', statusQuote: '', employerLinked: false, employerPageUrl: '',
  employerLinkQuote: '', title: '', employer: '', location: '', salary: '', description: '', evidence: [], conflicts: ['No lead is this posting.'] });
const decide = (row, answerA, answerB, extra = {}) => decideOfficialPostingJudgments(row, { leads, answerA, answerB, now: () => Date.UTC(2026, 9, 29),
  fallback: unresolvedOfficialPosting, comparativeTrail: officialPostingComparativeTrail, inputHash: officialPostingSemanticInputHash(row),
  extractRoute: url => extractAtsTenant(url), employerEqual: strictEmployerEqual, negativeProofTrail: OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL, ...extra });
const research = ids => ids.map(id => `BEGIN OFFICIAL POSTING RESEARCH ${id}\nCANDIDATE: ${JSON.stringify({ careersPageUrl: CAREERS,
  postingUrl: POSTING, employer: 'Northwind Labs', employerDomain: 'https://northwind.test', ats: 'Greenhouse' })}\nEND OFFICIAL POSTING RESEARCH ${id}`).join('\n');
const notFound = ids => ids.map(id => `BEGIN OFFICIAL POSTING RESEARCH ${id}\nNOT FOUND\nEND OFFICIAL POSTING RESEARCH ${id}`).join('\n');
const requestedIds = prompt => prompt.match(/Requested ids: ([a-f0-9, ]+)\./u)[1].split(', ');
const offline = async () => { const error = new Error('offline test'); error.code = 'fetch-failed'; throw error; };
const hostLeads = prompt => JSON.parse(prompt.split('BEGIN HOST LEADS JSON\n')[1].split('\nEND HOST LEADS JSON')[0]);
const flush = () => new Promise(resolve => setImmediate(resolve));
const linkedPool = (active = true, capacity = 2) => ({ enabled: true, link: { state: 'linked' },
  limits: { maxConcurrentHandoffs: capacity }, chat: { state: 'working', pool: { active, workerCount: capacity } } });
async function withObservedWorkers(count, run) {
  let live = count;
  const release = registerObservedWorkerAvailability(() => live > 0, null, () => live);
  try { return await run(value => { live = value; }); } finally { release(); }
}
async function waitFor(check) {
  for (let index = 0; index < 200; index += 1) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Expected scheduling checkpoint was not reached');
}
async function withStore(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'official-chat-'));
  try { return await run(createOfficialPostingStore(path.join(root, 'official-postings'))); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

export default [
  {
    name: 'An enabled cold bridge stays serial until its pool starts, even with automatic launching configured',
    run() {
      const cold = { ...linkedPool(false, 6), autoLaunchChats: true };
      assert.equal(bridgeHandoffCapacity(cold), 1, 'one queued request creates cold-start demand');
      assert.equal(bridgeHandoffCapacity({ ...cold, autoLaunchChats: false }), 1, 'a manual single chat stays serial');
      assert.equal(bridgeHandoffCapacity({ ...cold, enabled: false }), 1);
      assert.equal(bridgeHandoffCapacity({ ...cold, link: { state: 'unlinked' } }), 1);
      assert.equal(bridgeHandoffCapacity({ ...cold, limits: { maxConcurrentHandoffs: 3 } }), 1);
    },
  },
  {
    name: 'Cold pool startup admits queued work before its first slow handoff finishes',
    async run() {
      await withObservedWorkers(6, async () => withStore(async store => {
        const rows = Array.from({ length: 13 }, (_, index) => job({
          url: `https://www.linkedin.com/jobs/view/cold-pool-${index}`, sourceJobKey: `cold-pool-${index}`,
        }));
        let poolActive = false; let launchScheduled = false; let firstFinder = true; let released = false; let active = 0; let maximum = 0;
        const held = [];
        const status = () => ({ ...linkedPool(poolActive, 6), autoLaunchChats: true });
        const callRaw = async (prompt, options) => {
          const finder = options.task.endsWith('-research');
          if (finder && firstFinder) { firstFinder = false; return research(requestedIds(prompt)); }
          active += 1; maximum = Math.max(maximum, active);
          // The first queued work starts the automatic pool, then holds its
          // turn while the other locally queued requests should be admitted.
          if (!launchScheduled) {
            launchScheduled = true;
            setImmediate(() => { poolActive = true; });
          }
          if (!released) await new Promise(resolve => held.push(resolve));
          active -= 1;
          return finder ? research(requestedIds(prompt))
            : JSON.stringify(chosen({ choice: hostLeads(prompt).find(lead => lead.url === POSTING).id }));
        };
        const running = resolveOfficialPostings(rows, { store, callRaw, snapshotFetch: offline, bridgeStatus: status });
        let result;
        try {
          await waitFor(() => poolActive);
          await waitFor(() => maximum === 6);
          assert.equal(released, false, 'pool startup must expose all six slots while the first turn is still held');
        } finally {
          released = true; held.splice(0).forEach(resolve => resolve()); result = await running;
        }
        assert.ok(result.jobs.every(row => row.officialPosting.outcome === 'found'));
      }));
    },
  },
  {
    name: 'Parallel judge admission requires trusted observed counts rather than planned pool slots or a legacy boolean',
    run() {
      const release = registerObservedWorkerAvailability(() => true);
      try {
        assert.equal(hasLiveObservedWorker(), true);
        assert.equal(hasLiveObservedWorker(2), false, 'a boolean provider proves only one live worker');
        for (const minimum of [0, -1, 1.5, NaN]) assert.equal(hasLiveObservedWorker(minimum), false);
      } finally { release(); }
    },
  },
  {
    name: 'Two live observed workers overlap isolated A and B judgments with distinct comparison runs',
    async run() {
      await withObservedWorkers(2, async () => withStore(async store => {
        const started = []; const waiting = []; let released = false;
        const callRaw = async (prompt, options) => {
          if (options.task === 'job-official-posting-research') return research(requestedIds(prompt));
          started.push({ ...options.manualHandoff });
          if (!released) await new Promise(resolve => waiting.push(resolve));
          return JSON.stringify(chosen({ choice: hostLeads(prompt).find(lead => lead.url === POSTING).id }));
        };
        const running = resolveOfficialPostings([job()], { store, callRaw, snapshotFetch: offline, bridgeStatus: linkedPool });
        let result;
        try {
          await waitFor(() => started.length === 2);
          assert.deepEqual(started.map(item => item.comparisonRun), ['A', 'B']);
          assert.equal(started[0].comparisonGroup, started[1].comparisonGroup);
        } finally {
          released = true; waiting.splice(0).forEach(resolve => resolve());
          result = await running;
        }
        assert.equal(result.jobs[0].officialPosting.outcome, 'found');
      }));
    },
  },
  {
    name: 'One observed worker, unobserved pool slots, and a linked single chat all retain sequential A and B judgments',
    async run() {
      for (const [observed, pool] of [[1, true], [0, true], [2, false]]) await withObservedWorkers(observed, async () => withStore(async store => {
        let active = 0; let maximum = 0; const runs = [];
        const callRaw = async (prompt, options) => {
          if (options.task === 'job-official-posting-research') return research(requestedIds(prompt));
          active += 1; maximum = Math.max(maximum, active); runs.push(options.manualHandoff.comparisonRun);
          await flush(); active -= 1;
          return JSON.stringify(chosen({ choice: hostLeads(prompt).find(lead => lead.url === POSTING).id }));
        };
        const result = await resolveOfficialPostings([job()], { store, callRaw, snapshotFetch: offline, bridgeStatus: () => linkedPool(pool) });
        assert.equal(result.jobs[0].officialPosting.outcome, 'found');
        assert.equal(maximum, 1, `observed=${observed}, pool=${pool}`);
        assert.deepEqual(runs, ['A', 'B']);
      }));
    },
  },
  {
    name: 'Concurrent judge failures prefer A deterministically even when B fails first',
    async run() {
      await withObservedWorkers(2, async () => withStore(async store => {
        let releaseA; const bFailed = new Promise(resolve => { releaseA = resolve; }); const order = [];
        const callRaw = async (prompt, options) => {
          if (options.task === 'job-official-posting-research') return research(requestedIds(prompt));
          const run = options.manualHandoff.comparisonRun;
          if (run === 'A') await bFailed; else releaseA();
          order.push(run);
          throw Object.assign(new Error('Synthetic judge failure'), { code: run === 'A'
            ? 'OFFICIAL_POSTING_COMPARATIVE_INVALID' : 'comparative-unavailable' });
        };
        const result = await resolveOfficialPostings([job()], { store, callRaw, snapshotFetch: offline, bridgeStatus: linkedPool });
        assert.equal(order[0], 'B');
        assert.equal(order.at(-1), 'A');
        assert.ok(order.includes('A') && order.includes('B'));
        assert.ok(result.jobs[0].officialPosting.trail.includes('comparative-invalid'));
        assert.equal(result.jobs[0].officialPosting.trail.includes('comparative-unavailable'), false);
        assert.equal(result.telemetry.comparativeInvalidRuns, 2);
        assert.equal(await store.find(job()), null);
      }));
    },
  },
  {
    name: 'A concurrent B waiting behind a busy live worker does not exhaust comparative absence grace',
    async run() {
      await withObservedWorkers(2, async setObserved => withStore(async store => {
        let releaseB; const aFinished = new Promise(resolve => { releaseB = resolve; }); const aborted = [];
        const callRaw = async (prompt, options) => {
          if (options.task === 'job-official-posting-research') return research(requestedIds(prompt));
          const run = options.manualHandoff.comparisonRun;
          options.signal.addEventListener('abort', () => aborted.push(run));
          if (run === 'A') {
            await new Promise(resolve => setTimeout(resolve, 35));
            releaseB();
          } else {
            setObserved(1); // One observed worker is occupied; B remains queued.
            await aFinished;
            await new Promise(resolve => setTimeout(resolve, 35));
          }
          return JSON.stringify(chosen({ choice: hostLeads(prompt).find(lead => lead.url === POSTING).id }));
        };
        const result = await resolveOfficialPostings([job()], { store, callRaw, snapshotFetch: offline, bridgeStatus: linkedPool,
          comparativeGraceMs: 10, comparativeWorkerAvailable: () => bridgeComparisonAvailable(linkedPool(), hasLiveObservedWorker) });
        assert.equal(result.jobs[0].officialPosting.outcome, 'found');
        assert.deepEqual(aborted, []);
      }));
    },
  },
  {
    name: 'Ten queued handoffs survive serialized 60-second launches and grow admission as each worker appears',
    async run() {
      await withObservedWorkers(1, async setObserved => withStore(async store => {
        const rows = Array.from({ length: 25 }, (_, index) => job({
          url: `https://www.linkedin.com/jobs/view/grow-pool-${index}`, sourceJobKey: `grow-pool-${index}`,
        }));
        const status = () => linkedPool(true, 10);
        const queue = []; const aborted = []; const launched = []; const admissions = [];
        let live = 1; let active = 0; let outstanding = 0; let maximum = 0; let target = 1; let launchTimer = null; let firstFinder = true;
        const schedule = globalThis.setTimeout; const repeat = globalThis.setInterval;
        // One real millisecond represents one second. Production's old 105s
        // deadline would fire before the second serialized worker arrives.
        globalThis.setTimeout = (fn, delay, ...args) => schedule(fn, delay >= 100_000 ? delay / 1_000 : delay, ...args);
        globalThis.setInterval = (fn, delay, ...args) => repeat(fn, delay === 250 ? 1 : delay, ...args);
        const releaseLauncher = registerBridgeLauncherAvailability(() => ({ available: true,
          pending: launchTimer !== null, inProgress: launchTimer !== null ? 1 : 0 }));
        const start = Date.now();
        const pump = () => {
          while (active < live && queue.length) {
            const item = queue.shift(); active += 1;
            item.options.manualHandoff.onAssigned();
            schedule(() => {
              item.options.signal.removeEventListener('abort', item.onAbort);
              active -= 1; outstanding -= 1;
              item.resolve(item.reply()); pump();
            }, 750);
          }
        };
        const launchNext = () => {
          if (launchTimer !== null || live >= target) return;
          launchTimer = schedule(() => {
            live += 1; setObserved(live); launched.push(live); launchTimer = null;
            pump(); launchNext();
          }, 60);
        };
        const callRaw = (prompt, options) => {
          if (firstFinder) { firstFinder = false; options.manualHandoff.onAssigned(); return research(requestedIds(prompt)); }
          return new Promise(resolve => {
            outstanding += 1; maximum = Math.max(maximum, outstanding);
            admissions.push({ live, outstanding, bound: Math.min(10, live + (launchTimer !== null ? 1 : 0) + 1) });
            const recommendation = recommendWorkerPool({ tasks: [{ task: options.task, pending: outstanding }], capability: status().limits });
            target = Math.max(target, recommendation.recommended); launchNext();
            const item = { options, resolve, onAbort: () => aborted.push(options.task), reply: () => options.task.endsWith('-research')
              ? research(requestedIds(prompt)) : JSON.stringify(chosen({ choice: hostLeads(prompt).find(lead => lead.url === POSTING).id })) };
            options.signal.addEventListener('abort', item.onAbort, { once: true });
            queue.push(item); pump();
          });
        };
        let result;
        try {
          result = await resolveOfficialPostings(rows, { store, callRaw, snapshotFetch: offline, bridgeStatus: status,
            now: () => (Date.now() - start) * 1_000, timeoutStartsOnAssignment: true });
        } finally {
          clearTimeout(launchTimer); releaseLauncher();
          globalThis.setTimeout = schedule; globalThis.setInterval = repeat;
        }
        assert.ok(admissions.every(item => item.outstanding <= item.bound), JSON.stringify(admissions));
        assert.equal(maximum, 10);
        assert.deepEqual(launched, [2, 3, 4, 5, 6, 7, 8, 9, 10], 'workers launch one at a time');
        assert.deepEqual(aborted, [], 'serialized launches must not consume response time or trigger absence');
        assert.equal(result.telemetry.bridgeTimeout, 0);
        assert.deepEqual(result.jobs.map(row => row.url), rows.map(row => row.url));
        assert.ok(result.jobs.every(row => row.officialPosting.outcome === 'found'));
      }));
    },
  },
  {
    name: 'A live linked chat with autoLaunchChats but no launcher stays serial and does not abort',
    async run() {
      await withObservedWorkers(6, async () => withStore(async store => {
        const rows = Array.from({ length: 13 }, (_, index) => job({ url: `https://www.linkedin.com/jobs/view/single-chat-${index}` }));
        let active = 0; let maximum = 0;
        const callRaw = async (prompt, options) => {
          active += 1; maximum = Math.max(maximum, active);
          await new Promise(resolve => setTimeout(resolve, 15));
          assert.equal(options.signal.aborted, false, 'a live chat suspends absence grace without an automatic launcher');
          active -= 1;
          return options.task.endsWith('-research') ? research(requestedIds(prompt))
            : JSON.stringify(chosen({ choice: hostLeads(prompt).find(lead => lead.url === POSTING).id }));
        };
        const result = await resolveOfficialPostings(rows, { store, callRaw, snapshotFetch: offline,
          bridgeStatus: () => ({ ...linkedPool(false, 10), autoLaunchChats: true }),
          comparativeGraceMs: 5, timeoutStartsOnAssignment: true });
        assert.equal(maximum, 1);
        assert.ok(result.jobs.every(row => row.officialPosting.outcome === 'found'));
      }));
    },
  },
  {
    name: 'An assigned handoff still times out during an unresponsive worker turn',
    async run() {
      let assigned; let workerSignal;
      const stats = { handoffs: 0, handoffMs: 0 };
      const pending = cappedHandoff({ prompt: 'Synthetic assignment timeout' }, {
        call: (_prompt, options) => { assigned = options.manualHandoff.onAssigned; workerSignal = options.signal; return new Promise(() => {}); },
        timeoutMs: 20, timeoutStartsOnAssignment: true, now: Date.now, stats,
      });
      await new Promise(resolve => setTimeout(resolve, 35));
      assert.equal(workerSignal.aborted, false, 'queued requests have no running response timer');
      assigned(); assigned();
      const expired = assert.rejects(pending, error => error.code === 'bridge-timeout');
      await waitFor(() => workerSignal.aborted);
      await expired;
      assigned();
      assert.equal(workerSignal.aborted, true);
      assert.equal(stats.handoffs, 1);
    },
  },
  {
    name: 'Assignment timing keeps comparative launch grace and ignores a late assignment after settlement',
    async run() {
      let available = false; let launching = true; let workerSignal; let assigned;
      const result = await cappedHandoff({ prompt: 'Synthetic comparative launch' }, {
        call: async (_prompt, options) => {
          workerSignal = options.signal; assigned = options.manualHandoff.onAssigned;
          await new Promise(resolve => setTimeout(resolve, 35));
          assert.equal(workerSignal.aborted, false, 'pending worker launch suspends the shorter absence grace');
          available = true; launching = false; assigned();
          await new Promise(resolve => setTimeout(resolve, 5));
          return 'Synthetic completed response';
        },
        timeoutMs: 20, timeoutStartsOnAssignment: true, now: Date.now, stats: { handoffs: 0, handoffMs: 0 },
        comparativeWorkerAvailable: () => available, comparativeWorkerLaunching: () => launching, comparativeGraceMs: 10,
      });
      assert.equal(result, 'Synthetic completed response');
      assigned();
      await new Promise(resolve => setTimeout(resolve, 35));
      assert.equal(workerSignal.aborted, false, 'a stale assignment cannot restart the cleared response timer');
    },
  },
  {
    name: 'Comparative B waits beyond presentation and absence deadlines while its separate chat launch is pending',
    async run() {
      await withObservedWorkers(1, async setObserved => withStore(async store => {
        let pendingLaunch = false; let offset = 0; const runs = []; const aborted = [];
        const releaseLauncher = registerBridgeLauncherAvailability(() => ({ available: false,
          pending: pendingLaunch, inProgress: Number(pendingLaunch) }));
        try {
          const callRaw = async (prompt, options) => {
            options.signal.addEventListener('abort', () => aborted.push(options.signal.reason.code), { once: true });
            if (options.task.endsWith('-research')) {
              options.manualHandoff.onAssigned(); return research(requestedIds(prompt));
            }
            const run = options.manualHandoff.comparisonRun; runs.push(run);
            if (run === 'B') {
              await new Promise(resolve => setTimeout(resolve, 15));
              offset += 180_000;
              await new Promise(resolve => setTimeout(resolve, 15));
              assert.equal(options.signal.aborted, false, 'B keeps waiting for the fresh chat despite elapsed presentation time');
              setObserved(1); pendingLaunch = false;
            }
            options.manualHandoff.onAssigned();
            if (run === 'A') { setObserved(0); pendingLaunch = true; }
            return JSON.stringify(chosen({ choice: hostLeads(prompt).find(lead => lead.url === POSTING).id }));
          };
          const result = await resolveOfficialPostings([job()], { store, callRaw, snapshotFetch: offline, bridgeStatus: linkedPool,
            timeoutStartsOnAssignment: true, timeoutMs: 20, comparativeGraceMs: 5, now: () => Date.now() + offset });
          assert.deepEqual(runs, ['A', 'B']);
          assert.deepEqual(aborted, []);
          assert.equal(result.jobs[0].officialPosting.outcome, 'found');
        } finally { releaseLauncher(); }
      }));
    },
  },
  {
    name: 'Three admitted handoffs wait behind two workers busy with another module without spending their response budgets',
    async run() {
      await withObservedWorkers(2, async () => withStore(async store => {
        const rows = Array.from({ length: 25 }, (_, index) => job({
          url: `https://www.linkedin.com/jobs/view/slow-workers-${index}`, sourceJobKey: `slow-workers-${index}`,
        }));
        const queue = []; const aborted = []; const completedFinders = [];
        let active = 0; let outstanding = 0; let maximum = 0; let missing; let maximumWait = 0; let available = false;
        const timeoutMs = 150; const turnMs = 90;
        const pump = () => {
          while (available && active < 2 && queue.length) {
            const item = queue.shift();
            active += 1;
            maximumWait = Math.max(maximumWait, Date.now() - item.queuedAt);
            item.options.manualHandoff.onAssigned();
            item.timer = setTimeout(() => {
              item.cleanup(); active -= 1; outstanding -= 1;
              if (item.options.task === 'job-official-posting-research') completedFinders.push(item.options.hints);
              item.resolve(item.reply());
              pump();
            }, turnMs);
          }
        };
        const callRaw = (prompt, options) => new Promise((resolve, reject) => {
          const finder = options.task === 'job-official-posting-research';
          const reply = () => {
            if (!finder) return JSON.stringify(chosen({ choice: hostLeads(prompt).find(lead => lead.url === POSTING).id }));
            const ids = requestedIds(prompt);
            if (options.hints.attemptKind === 'second-search') return research(ids);
            missing ||= ids[0];
            return ids.map(id => id === missing ? notFound([id]) : research([id])).join('\n');
          };
          const item = { options, reply, resolve, timer: null, queuedAt: Date.now() };
          const onAbort = () => {
            item.cleanup(); outstanding -= 1;
            if (item.timer) { clearTimeout(item.timer); active -= 1; }
            else queue.splice(queue.indexOf(item), 1);
            aborted.push(options.task);
            reject(options.signal.reason);
            pump();
          };
          item.cleanup = () => options.signal.removeEventListener('abort', onAbort);
          options.signal.addEventListener('abort', onAbort, { once: true });
          outstanding += 1; maximum = Math.max(maximum, outstanding);
          queue.push(item); pump();
        });
        setTimeout(() => { available = true; pump(); }, 200);
        const result = await resolveOfficialPostings(rows, { store, callRaw, snapshotFetch: offline,
          bridgeStatus: () => linkedPool(true, 6), timeoutMs, timeoutStartsOnAssignment: true });
        assert.deepEqual(aborted, [], 'a turn shorter than its timeout must not expire waiting for a worker');
        assert.equal(maximum, 3, 'two live workers expose only one extra request');
        assert.ok(maximumWait > timeoutMs, `queued time must exceed the response timeout, observed ${maximumWait}ms`);
        assert.equal(completedFinders.length, 4, 'all three first-search batches and the second-search batch finish');
        assert.equal(completedFinders.filter(hints => hints.attemptKind === 'second-search').length, 1);
        assert.equal(result.telemetry.bridgeTimeout, 0);
        assert.ok(result.jobs.every(row => row.officialPosting.outcome === 'found'));
      }));
    },
  },
  {
    name: 'Queued judgments leave the finder lane free through later batches and the second search',
    async run() {
      await withObservedWorkers(2, async () => withStore(async store => {
        const rows = Array.from({ length: 25 }, (_, index) => job({ url: `https://www.linkedin.com/jobs/view/finder-priority-${index}` }));
        let finders = 0; let judges = 0; let missing; let release;
        const judgmentsBlocked = new Promise(resolve => { release = resolve; });
        const finderJudgmentCounts = [];
        const callRaw = async (prompt, options) => {
          if (options.task.endsWith('-research')) {
            finders += 1;
            if (finders === 2) await waitFor(() => judges === 2);
            finderJudgmentCounts.push(judges);
            const ids = requestedIds(prompt);
            if (options.hints.attemptKind === 'second-search') return research(ids);
            missing ||= ids[0];
            return ids.map(id => id === missing ? notFound([id]) : research([id])).join('\n');
          }
          judges += 1;
          await judgmentsBlocked;
          return JSON.stringify(chosen({ choice: hostLeads(prompt).find(lead => lead.url === POSTING).id }));
        };
        const running = resolveOfficialPostings(rows, { store, callRaw, snapshotFetch: offline, bridgeStatus: () => linkedPool(true, 6) });
        let result;
        try {
          await waitFor(() => finderJudgmentCounts.length === 4);
          assert.deepEqual(finderJudgmentCounts, [0, 2, 2, 2], 'all finder batches pass queued judgments while two comparison slots remain occupied');
        } finally { release(); result = await running; }
        assert.ok(result.jobs.every(row => row.officialPosting.outcome === 'found'));
      }));
    },
  },
  {
    name: 'Judging begins before later finder batches return, stays bounded, and preserves input result order',
    async run() {
      await withObservedWorkers(2, async () => withStore(async store => {
        const rows = Array.from({ length: 25 }, (_, index) => job({ url: `https://www.linkedin.com/jobs/view/early-${24 - index}` }));
        let releaseFinder; let finderWaiting = false; let finderCalls = 0; let judgeCalls = 0; let active = 0; let maximum = 0;
        const laterFinder = new Promise(resolve => { releaseFinder = resolve; });
        const callRaw = async (prompt, options) => {
          if (options.task === 'job-official-posting-research') {
            finderCalls += 1;
            if (finderCalls === 2) { finderWaiting = true; await laterFinder; }
            return research(requestedIds(prompt));
          }
          judgeCalls += 1; active += 1; maximum = Math.max(maximum, active);
          await flush(); active -= 1;
          return JSON.stringify(chosen({ choice: hostLeads(prompt).find(lead => lead.url === POSTING).id }));
        };
        const running = resolveOfficialPostings(rows, { store, callRaw, snapshotFetch: offline, bridgeStatus: linkedPool });
        let result;
        try {
          await waitFor(() => finderWaiting && judgeCalls > 0);
          assert.equal(finderCalls, 2, 'the later finder is still waiting while earlier rows judge');
        } finally { releaseFinder(); result = await running; }
        assert.equal(finderCalls, 3);
        assert.ok(maximum <= 2, `issued judgments fit the live workers, observed ${maximum}`);
        assert.deepEqual(result.jobs.map(row => row.url), rows.map(row => row.url));
        assert.ok(result.jobs.every(row => row.officialPosting.outcome === 'found'));
      }));
    },
  },
  {
    name: 'Only zero-lead rows enter the second finder while ready rows judge independently',
    async run() {
      await withStore(async store => {
        const rows = Array.from({ length: 13 }, (_, index) => job({ url: `https://www.linkedin.com/jobs/view/second-finder-${index}` }));
        let missing; const secondIds = [];
        const callRaw = async (prompt, options) => {
          if (options.task === 'job-official-posting-research') {
            const ids = requestedIds(prompt);
            if (options.hints.attemptKind === 'second-search') { secondIds.push(...ids); return research(ids); }
            missing ||= ids[0];
            return ids.map(id => id === missing ? notFound([id]) : research([id])).join('\n');
          }
          return JSON.stringify(chosen({ choice: hostLeads(prompt).find(lead => lead.url === POSTING).id }));
        };
        const result = await resolveOfficialPostings(rows, { store, callRaw, snapshotFetch: offline });
        assert.deepEqual(secondIds, [missing]);
        assert.ok(result.jobs.every(row => row.officialPosting.outcome === 'found'));
      });
    },
  },
  {
    name: 'Cancellation drains early judgments and finder work without storing cancelled rows or reordering results',
    async run() {
      await withObservedWorkers(2, async () => withStore(async store => {
        const rows = Array.from({ length: 13 }, (_, index) => job({ url: `https://www.linkedin.com/jobs/view/cancel-early-${index}` }));
        const controller = new AbortController(); let finderCalls = 0; let judgeCalls = 0;
        const callRaw = async (prompt, options) => {
          if (options.task === 'job-official-posting-research') {
            finderCalls += 1;
            if (finderCalls === 1) return research(requestedIds(prompt));
          } else judgeCalls += 1;
          return new Promise(() => {}); // The handoff owner must enforce cancellation.
        };
        const running = resolveOfficialPostings(rows, { store, callRaw, snapshotFetch: offline, signal: controller.signal,
          bridgeStatus: linkedPool });
        let result;
        try { await waitFor(() => finderCalls === 2 && judgeCalls > 0); }
        finally {
          controller.abort(Object.assign(new Error('Synthetic stop'), { code: 'bridge-aborted' }));
          result = await running;
        }
        assert.deepEqual(result.jobs.map(row => row.url), rows.map(row => row.url));
        assert.ok(result.jobs.every(row => row.officialPosting.trail.includes('bridge-aborted')));
        for (const row of rows) assert.equal(await store.find(row), null);
      }));
    },
  },
  {
    name: 'Concurrent second-round judgments settle only on their own agreement, without borrowing the first pair',
    async run() {
      await withObservedWorkers(2, async () => withStore(async store => {
        const identities = [];
        const callRaw = async (prompt, options) => {
          if (options.task === 'job-official-posting-research') return research(requestedIds(prompt));
          const second = prompt.includes('second independent review');
          const run = options.manualHandoff.comparisonRun;
          identities.push({ second, ...options.manualHandoff });
          return JSON.stringify((second ? run === 'B' : run === 'A')
            ? chosen({ choice: hostLeads(prompt).find(lead => lead.url === POSTING).id }) : unresolvedAnswer('uncertain'));
        };
        const result = await resolveOfficialPostings([job()], { store, callRaw, snapshotFetch: offline, bridgeStatus: linkedPool });
        assert.equal(result.jobs[0].officialPosting.outcome, 'ambiguous');
        assert.equal(await store.find(job()), null);
        assert.equal(identities.length, 4);
        assert.deepEqual(identities.map(item => item.comparisonRun), ['A', 'B', 'A', 'B']);
        assert.notEqual(identities[0].comparisonGroup, identities[2].comparisonGroup);
      }));
    },
  },
  {
    name: 'Chat snapshots share successful lead downloads across distinct rows and start fresh on the next invocation',
    async run() {
      await withStore(async store => {
        const rows = [job(), job({ url: 'https://www.linkedin.com/jobs/view/synthetic-dispatch-two', sourceJobKey: 'dispatch-2' })];
        const downloads = new Map();
        const snapshotFetch = async url => {
          downloads.set(url, (downloads.get(url) || 0) + 1);
          return { url, contentType: 'text/html', body: '<main>Current Northwind careers page</main>' };
        };
        const callRaw = async (prompt, options) => options.task === 'job-official-posting-research'
          ? research(requestedIds(prompt)) : JSON.stringify(chosen({ choice: hostLeads(prompt).find(lead => lead.url === POSTING).id }));
        const run = () => resolveOfficialPostings(rows, { store, snapshotFetch, callRaw, bypassCache: true });
        const first = await run();
        assert.equal(first.jobs.length, 2);
        assert.equal(downloads.size, 2, 'the posting data and careers lead are separate downloads');
        assert.ok([...downloads.values()].every(count => count === 1), 'both distinct rows share each download');
        assert.equal(first.telemetry.fetches, 2);
        assert.equal(first.telemetry.cacheHits, 2);
        await run();
        assert.ok([...downloads.values()].every(count => count === 2), 'a fresh lookup downloads new snapshots');
      });
    },
  },
  {
    name: 'Chat snapshots retry a recovered lead in a later row instead of retaining a failed download',
    async run() {
      await withStore(async store => {
        const rows = Array.from({ length: 7 }, (_, index) => job({
          url: `https://www.linkedin.com/jobs/view/synthetic-snapshot-${index}`, sourceJobKey: `snapshot-${index}`,
        }));
        let downloads = 0;
        const reads = [];
        const snapshotFetch = async url => {
          downloads += 1;
          if (downloads === 1) throw Object.assign(new Error('Synthetic temporary failure'), { code: 'fetch-failed' });
          return { url, contentType: 'text/html', body: '<main>Recovered posting</main>' };
        };
        const callRaw = async (prompt, options) => {
          if (options.task === 'job-official-posting-research') return requestedIds(prompt).map(id =>
            `BEGIN OFFICIAL POSTING RESEARCH ${id}\nCANDIDATE: ${JSON.stringify({ postingUrl: POSTING, careersPageUrl: '',
              employer: 'Northwind Labs', employerDomain: 'https://northwind.test', ats: 'Greenhouse' })}\nEND OFFICIAL POSTING RESEARCH ${id}`).join('\n');
          const snapshots = JSON.parse(prompt.split('BEGIN UNTRUSTED APP PAGE SNAPSHOTS JSON\n')[1]
            .split('\nEND UNTRUSTED APP PAGE SNAPSHOTS JSON')[0]);
          reads.push(snapshots[0].read);
          return JSON.stringify(chosen({ choice: hostLeads(prompt).find(lead => lead.url === POSTING).id }));
        };
        await resolveOfficialPostings(rows, { store, snapshotFetch, callRaw, bypassCache: true });
        assert.equal(downloads, 2, 'in-flight failures are shared, but a later row can download the recovered lead');
        assert.ok(reads.includes(false));
        assert.ok(reads.includes(true), 'the recovered page reaches a later row\'s judges');
      });
    },
  },
  {
    name: 'Chat snapshots fetch later rows after three host failures instead of excluding the recovered host',
    async run() {
      await withStore(async store => {
        const rows = Array.from({ length: 7 }, (_, index) => job({
          url: `https://www.linkedin.com/jobs/view/synthetic-snapshot-${index}`, sourceJobKey: `snapshot-${index}`,
        }));
        let downloads = 0;
        const reads = [];
        const snapshotFetch = async url => {
          downloads += 1;
          if (downloads <= 3) throw Object.assign(new Error('Synthetic temporary failure'), { code: 'fetch-failed', statusCode: 503 });
          return { url, contentType: 'text/html', body: '<main>Recovered posting</main>' };
        };
        const callRaw = async (prompt, options) => {
          if (options.task === 'job-official-posting-research') return requestedIds(prompt).map(id =>
            `BEGIN OFFICIAL POSTING RESEARCH ${id}\nCANDIDATE: ${JSON.stringify({ postingUrl: `https://jobs.northwind.test/postings/${id}`, careersPageUrl: '',
              employer: 'Northwind Labs', employerDomain: 'https://northwind.test', ats: '' })}\nEND OFFICIAL POSTING RESEARCH ${id}`).join('\n');
          const snapshots = JSON.parse(prompt.split('BEGIN UNTRUSTED APP PAGE SNAPSHOTS JSON\n')[1]
            .split('\nEND UNTRUSTED APP PAGE SNAPSHOTS JSON')[0]);
          reads.push(snapshots[0].read);
          const lead = hostLeads(prompt)[0];
          return JSON.stringify(chosen({ choice: lead.id, postingUrl: lead.url }));
        };
        await resolveOfficialPostings(rows, { store, snapshotFetch, callRaw, bypassCache: true });
        assert.equal(downloads, rows.length, 'each distinct later row reaches the host after the initial three failures');
        assert.ok(reads.includes(false));
        assert.ok(reads.includes(true), 'the recovered page reaches a later row\'s judges');
      });
    },
  },
  {
    name: 'Production ChatGPT lookup records discovery and snapshot counts, while cache reuse preserves the prior observation',
    async run() {
      _resetOfficialPostingDiscoveryDiagnosticsForTests();
      try {
        await withStore(async store => {
          const row = job();
          const callRaw = async (prompt, options) => options.task === 'job-official-posting-research'
            ? research(requestedIds(prompt)) : JSON.stringify(chosen({ choice: hostLeads(prompt).find(lead => lead.url === POSTING).id }));
          await resolveOfficialPostings([row], { store, snapshotFetch: offline, callRaw });
          const before = getOfficialPostingDiscoveryDiagnosticsSnapshot();
          assert.equal(before.observations.length, 1);
          const observation = before.observations[0];
          assert.equal(observation.candidateCount, 2); assert.equal(observation.eligibleCount, null);
          assert.equal(observation.comparisonRuns, 2); assert.equal(observation.stage, 'final');
          assert.equal(observation.outcome, 'found'); assert.equal(observation.settled, true);
          assert.deepEqual(observation.chatStats, { finderCalls: 1, judgeRounds: 1, judgeCalls: 2,
            snapshotReads: 0, snapshotFailures: 2, truncatedSnapshots: 0 });
          await resolveOfficialPostings([row], { store, snapshotFetch: offline, callRaw: () => { throw new Error('cached'); } });
          assert.deepEqual(getOfficialPostingDiscoveryDiagnosticsSnapshot(), before);
          const markdown = buildOfficialPostingDiscoveryMarkdown();
          assert.match(markdown, /candidates 2 · eligible not assessed/);
          assert.match(markdown, /finder calls 1 · judge rounds 1 · judge calls 2 · snapshots read 0 · snapshot failures 2/);
          for (const privateText of [DESCRIPTION, POSTING, CAREERS, row.company, row.title]) assert.equal(markdown.includes(privateText), false);
        });
      } finally { _resetOfficialPostingDiscoveryDiagnosticsForTests(); }
    },
  },
  {
    name: 'Production discovery distinguishes no finder leads from four valid but unsettled judge responses',
    async run() {
      _resetOfficialPostingDiscoveryDiagnosticsForTests();
      try {
        await withStore(async store => {
          await resolveOfficialPostings([job()], { store, snapshotFetch: offline,
            callRaw: async prompt => notFound(requestedIds(prompt)) });
          let observation = getOfficialPostingDiscoveryDiagnosticsSnapshot().observations[0];
          assert.equal(observation.candidateCount, 0); assert.equal(observation.comparisonRuns, 0);
          assert.equal(observation.settled, false);
          assert.deepEqual(observation.resolutionReasons, ['research-miss']);
          assert.deepEqual(observation.chatStats, { finderCalls: 2, judgeRounds: 0, judgeCalls: 0,
            snapshotReads: 0, snapshotFailures: 0, truncatedSnapshots: 0 });
          const callRaw = async (prompt, options) => options.task === 'job-official-posting-research'
            ? research(requestedIds(prompt)) : JSON.stringify(unresolvedAnswer('uncertain'));
          await resolveOfficialPostings([job()], { store, snapshotFetch: offline, callRaw });
          observation = getOfficialPostingDiscoveryDiagnosticsSnapshot().observations[0];
          assert.equal(getOfficialPostingDiscoveryDiagnosticsSnapshot().observations.length, 1);
          assert.equal(observation.candidateCount, 2); assert.equal(observation.comparisonRuns, 4);
          assert.equal(observation.settled, false); assert.equal(observation.outcome, 'ambiguous');
          assert.deepEqual(observation.resolutionReasons, ['semantic-uncertain']);
          assert.equal(observation.chatStats.judgeCalls, 4); assert.equal(observation.chatStats.judgeRounds, 2);
        });
      } finally { _resetOfficialPostingDiscoveryDiagnosticsForTests(); }
    },
  },
  {
    name: 'Production discovery records link-only outcomes and distinguishes unproved employer ownership from host rejection',
    async run() {
      _resetOfficialPostingDiscoveryDiagnosticsForTests();
      try {
        for (const mode of ['link-only', 'source-unproven']) await withStore(async store => {
          const callRaw = async (prompt, options) => {
            if (options.task === 'job-official-posting-research') return research(requestedIds(prompt));
            const extra = mode === 'source-unproven'
              ? { employerLinked: false, employerPageUrl: '', employerLinkQuote: '' }
              : options.manualHandoff.comparisonRun === 'B' ? { description: `${DESCRIPTION}\nA different final requirement.` } : {};
            return JSON.stringify(chosen({ choice: hostLeads(prompt).find(lead => lead.url === POSTING).id, ...extra }));
          };
          await resolveOfficialPostings([job()], { store, snapshotFetch: offline, callRaw });
          const observation = getOfficialPostingDiscoveryDiagnosticsSnapshot().observations[0];
          assert.equal(observation.eligibleCount, null);
          if (mode === 'link-only') {
            assert.equal(observation.outcome, 'link-only'); assert.equal(observation.settled, true);
            assert.deepEqual(observation.resolutionReasons, []);
          } else {
            assert.equal(observation.outcome, 'ambiguous'); assert.equal(observation.settled, false);
            assert.deepEqual(observation.resolutionReasons, ['source-unproven']);
            const markdown = buildOfficialPostingDiscoveryMarkdown();
            assert.match(markdown, /Chat resolution reasons: source-unproven/);
            assert.match(markdown, /source eligibility rejections not assessed/);
            assert.doesNotMatch(markdown, /rejected source-unproven=0/);
          }
        });
      } finally { _resetOfficialPostingDiscoveryDiagnosticsForTests(); }
    },
  },
  {
    name: 'Production discovery counts valid judgments separately from correction calls and reports storage failure as unsettled',
    async run() {
      _resetOfficialPostingDiscoveryDiagnosticsForTests();
      try {
        await withStore(async store => {
          let calls = 0;
          const callRaw = async (prompt, options) => {
            if (options.task === 'job-official-posting-research') return research(requestedIds(prompt));
            calls += 1;
            if (calls === 1) return '{"choice":"P1"}';
            return JSON.stringify(chosen({ choice: hostLeads(prompt).find(lead => lead.url === POSTING).id }));
          };
          await resolveOfficialPostings([job()], { store: { ...store, save: async () => { throw Object.assign(new Error('PRIVATE_FAILURE'), { code: 'EACCES' }); } },
            snapshotFetch: offline, callRaw });
          const observation = getOfficialPostingDiscoveryDiagnosticsSnapshot().observations[0];
          assert.equal(observation.comparisonRuns, 2); assert.equal(observation.chatStats.judgeCalls, 3);
          assert.equal(observation.outcome, 'failed'); assert.equal(observation.settled, false);
          assert.deepEqual(observation.resolutionReasons, ['storage-failed']);
          assert.equal(buildOfficialPostingDiscoveryMarkdown().includes('PRIVATE_FAILURE'), false);
        });
      } finally { _resetOfficialPostingDiscoveryDiagnosticsForTests(); }
    },
  },
  {
    name: 'Judge citations rank employer-linked pages first, add uncited search leads, and never offer the scraped listing',
    run() {
      const unmatched1 = 'https://other.example.test/one';
      const unmatched2 = 'https://other.example.test/two';
      const answers = [
        chosen({ postingUrl: unmatched1 }), chosen({ postingUrl: CAREERS, status: 'closed', employerLinked: false }),
        chosen({ postingUrl: POSTING, status: 'open' }), chosen({ postingUrl: unmatched2 }),
        chosen({ postingUrl: `${POSTING}/`, status: 'closed', employerLinked: false }),
        unresolvedAnswer('none'), unresolvedAnswer('uncertain'), null, undefined,
      ];
      const before = structuredClone({ leads, answers });
      const ranked = rankJudgeCitations({ leads, answers });
      // Employer-linked citations outrank unlinked ones, then votes, then lead order.
      assert.deepEqual(ranked, [
        { url: POSTING, title: 'Unconfirmed · cited by 2 of 7 judges · status split: 1 open, 1 closed · employer link confirmed by 1 of 2' },
        { url: unmatched1, title: 'Unconfirmed · cited by 1 of 7 judges' },
        { url: unmatched2, title: 'Unconfirmed · cited by 1 of 7 judges' },
        { url: CAREERS, title: 'Unconfirmed · cited by 1 of 7 judges · reported closed · employer link confirmed by 0 of 1' },
      ]);
      assert.deepEqual({ leads, answers }, before);
      assert.deepEqual(rankJudgeCitations({ leads, answers: [chosen({ postingUrl: CAREERS }), chosen()] }).map(item => item.url), [POSTING, CAREERS]);
      assert.deepEqual(rankJudgeCitations({ leads, answers: [chosen({ status: 'unknown' })] }), [
        { url: POSTING, title: 'Unconfirmed · cited by 1 of 1 judges · status unknown' },
        { url: CAREERS, title: 'Unconfirmed · careers page found by search, not cited by judges' },
      ]);
      const searchOnly = [{ url: POSTING, title: 'Unconfirmed · found by search, not cited by judges' },
        { url: CAREERS, title: 'Unconfirmed · careers page found by search, not cited by judges' }];
      assert.deepEqual(rankJudgeCitations({ leads, answers: [
        { ...unresolvedAnswer('none'), postingUrl: POSTING }, { ...unresolvedAnswer('uncertain'), postingUrl: CAREERS }, null,
      ] }), searchOnly);
      assert.deepEqual(rankJudgeCitations({ leads: [...leads].reverse(), answers: [] }), searchOnly);
      assert.deepEqual(rankJudgeCitations({ leads: [], answers: [] }), []);
      // An employer-linked page outranks a page more judges cited without that link.
      const board = 'https://careers.vcfund.example.test/companies/northwind/jobs/1';
      assert.deepEqual(rankJudgeCitations({ leads: [], answers: [chosen({ postingUrl: board, employerLinked: false }),
        chosen({ postingUrl: board, employerLinked: false }), chosen()] }).map(item => item.url), [POSTING, board]);
      // The scraped listing and reposting aggregators are never candidates; a scraped employer job-board page stays one.
      const scraped = job().url;
      assert.deepEqual(rankJudgeCitations({ leads: [{ id: 'P1', url: scraped, kind: 'posting' }, ...leads],
        answers: [chosen({ postingUrl: scraped }), chosen({ postingUrl: 'https://ca.linkedin.com/jobs/view/other-123' }),
          chosen({ postingUrl: 'https://www.ziprecruiter.com/c/Northwind/Job/Dispatch' })], sourceUrls: [scraped] }), searchOnly);
      assert.deepEqual(rankJudgeCitations({ leads, answers: [chosen()], sourceUrls: [POSTING] }).map(item => item.url), [POSTING, CAREERS]);
      const builtIn = 'https://builtin.com/job/dispatch-engineer/1';
      assert.deepEqual(rankJudgeCitations({ leads: [{ id: 'P1', url: builtIn, kind: 'posting' }], answers: [], sourceUrls: [builtIn] }), []);
      const many = Array.from({ length: 13 }, (_, index) => chosen({ postingUrl: `https://other.example.test/${index}` }));
      many.unshift(chosen({ postingUrl: 'http://other.example.test/insecure' }));
      const capped = rankJudgeCitations({ leads: [], answers: many });
      assert.deepEqual(capped.map(item => item.url), many.slice(1, 13).map(answer => answer.postingUrl));
      assert.ok(capped.every(item => item.title.length <= 500));
    },
  },
  {
    name: 'Split employer-link judgments store all four citations on the ambiguous record',
    async run() {
      await withStore(async store => {
        let judgments = 0;
        const callRaw = async (prompt, options) => {
          if (options.task === 'job-official-posting-research') return research(requestedIds(prompt));
          judgments += 1;
          const linked = options.manualHandoff.comparisonRun === 'A';
          return JSON.stringify(chosen({ choice: hostLeads(prompt).find(lead => lead.url === POSTING).id,
            employerLinked: linked, employerPageUrl: linked ? CAREERS : '', employerLinkQuote: linked ? 'View open roles' : '' }));
        };
        const result = await resolveOfficialPostings([job()], { store, snapshotFetch: offline, callRaw });
        const posting = result.jobs[0].officialPosting;
        assert.equal(judgments, 4);
        assert.equal(posting.outcome, 'ambiguous');
        assert.deepEqual(posting.alternatives, [{ url: POSTING,
          title: 'Unconfirmed · cited by 4 of 4 judges · employer link confirmed by 2 of 4' }, { url: CAREERS, title: 'Unconfirmed · careers page found by search, not cited by judges' }]);
        assert.deepEqual(normalizeOfficialPosting(posting).alternatives, posting.alternatives);
      });
    },
  },
  {
    name: 'A failed second pair preserves the first ambiguous decision and counts its valid partial citation',
    async run() {
      await withStore(async store => {
        let judgments = 0;
        const callRaw = async (prompt, options) => {
          if (options.task === 'job-official-posting-research') return research(requestedIds(prompt));
          judgments += 1;
          if (judgments >= 4) return '{"choice":"P1"}';
          const linked = options.manualHandoff.comparisonRun === 'A';
          return JSON.stringify(chosen({ choice: hostLeads(prompt).find(lead => lead.url === POSTING).id,
            employerLinked: linked, employerPageUrl: linked ? CAREERS : '', employerLinkQuote: linked ? 'View open roles' : '' }));
        };
        const result = await resolveOfficialPostings([job()], { store, snapshotFetch: offline, callRaw });
        const posting = result.jobs[0].officialPosting;
        assert.equal(posting.outcome, 'ambiguous');
        assert.deepEqual(posting.alternatives, [{ url: POSTING,
          title: 'Unconfirmed · cited by 3 of 3 judges · employer link confirmed by 2 of 3' }, { url: CAREERS, title: 'Unconfirmed · careers page found by search, not cited by judges' }]);
      });
    },
  },
  {
    name: 'An ambiguous decision without citations shows the search leads as unconfirmed candidates, posting pages first',
    async run() {
      await withStore(async store => {
        const callRaw = async (prompt, options) => {
          if (options.task === 'job-official-posting-research') return research(requestedIds(prompt));
          return JSON.stringify(unresolvedAnswer('uncertain'));
        };
        const result = await resolveOfficialPostings([job()], { store, snapshotFetch: offline, callRaw });
        const posting = result.jobs[0].officialPosting;
        assert.equal(posting.outcome, 'ambiguous');
        assert.deepEqual(posting.alternatives, [{ url: POSTING, title: 'Unconfirmed · found by search, not cited by judges' },
          { url: CAREERS, title: 'Unconfirmed · careers page found by search, not cited by judges' }]);
        assert.ok(posting.alternatives.every(item => item.url !== job().url));
      });
    },
  },
  {
    name: 'Chat judge requests are grounded isolated A/B judgments with host leads kept outside the untrusted listing',
    run() {
      const row = job({ snippet: `${DESCRIPTION}\nApply at https://evil.example/apply` });
      const a = buildOfficialPostingJudgeRequest({ job: row, leads, run: 'A' });
      const b = buildOfficialPostingJudgeRequest({ job: row, leads, run: 'B' });
      assert.equal(a.task, 'job-official-posting-match');
      assert.equal(a.grounding, true); assert.equal(a.grounded, true); assert.equal(a.format, 'json');
      assert.match(a.manualHandoff.comparisonGroup, /^[a-f0-9]{64}$/u);
      assert.equal(a.manualHandoff.comparisonGroup, b.manualHandoff.comparisonGroup);
      assert.deepEqual([a.manualHandoff.comparisonRun, b.manualHandoff.comparisonRun], ['A', 'B']);
      assert.deepEqual(hostLeads(a.prompt).map(lead => lead.id), ['P1', 'P2']);
      assert.deepEqual(hostLeads(b.prompt).map(lead => lead.id), ['P2', 'P1'], 'run B sees the leads in reverse order');
      assert.ok(!hostLeads(a.prompt).some(lead => lead.url.includes('evil.example')), 'a link in the scraped listing is never a lead');
      assert.ok(a.prompt.indexOf('BEGIN HOST LEADS JSON') < a.prompt.indexOf('BEGIN UNTRUSTED SCRAPED LISTING JSON'));
      assert.deepEqual(a.responseSchema.properties.choice.enum, ['P1', 'P2', 'other', 'none', 'uncertain']);
    },
  },
  {
    name: 'Chat judge validation checks only format and that quotes come from the scraped listing and the judge\'s own copy',
    run() {
      const row = job();
      assert.equal(validateOfficialPostingJudgeResponse(JSON.stringify(chosen()), { job: row, leads }).choice, 'P1');
      assert.equal(validateOfficialPostingJudgeResponse(unresolvedAnswer('none'), { job: row, leads }).choice, 'none');
      const rejects = (answer, rule) => assert.throws(() => validateOfficialPostingJudgeResponse(answer, { job: row, leads }),
        error => error.code === 'OFFICIAL_POSTING_RESPONSE_INVALID'
          && error.correctionRuleIds.some(id => id.toLowerCase().replace(/_/gu, '-').includes(rule)), rule);
      rejects(chosen({ choice: 'P7' }), 'official-judge-choice');
      rejects(chosen({ postingUrl: 'http://insecure.example/job' }), 'official-judge-url');
      rejects(chosen({ description: '' }), 'official-judge-posting');
      rejects(chosen({ employerPageUrl: '' }), 'official-judge-employer');
      rejects(chosen({ evidence: [{ scrapedQuote: 'Invented scraped words.', officialQuote: 'Review route reports with operations leads every week.' }] }), 'official-judge-verbatim');
      rejects(chosen({ evidence: [{ scrapedQuote: 'Review route reports with operations leads every week.', officialQuote: 'Words the judge never copied.' }] }), 'official-judge-verbatim');
      rejects({ ...unresolvedAnswer('uncertain'), conflicts: [] }, 'official-judge-unresolved');
      rejects({ ...chosen(), extra: true }, 'official-judge-json');
      // A closed posting may no longer show its description.
      assert.equal(validateOfficialPostingJudgeResponse(chosen({ status: 'closed', statusQuote: 'This job is no longer accepting applications',
        description: '', evidence: [{ scrapedQuote: 'Dispatch Engineer', officialQuote: 'Dispatch Engineer' }] }), { job: row, leads }).status, 'closed');
    },
  },
  {
    name: 'Two copies of a description agree on the same words regardless of spacing, bullets, quote and dash styles',
    run() {
      assert.equal(judgeDescriptionsAgree('• Ship “reliable” tools — fast.\n\nRequirements:  Go', '- Ship "reliable" tools - fast. Requirements: Go'), true);
      assert.equal(judgeDescriptionsAgree('Ship reliable tools fast.', 'Ship reliable tools.'), false);
      assert.equal(judgeDescriptionsAgree('', ''), false);
      assert.equal(canonicalJudgeDescription('\r\n line one\r\nline\u0007two \n'), 'line one\nline two');
    },
  },
  {
    name: 'Only a truncated snapshot of the actual posting can withhold its agreed description',
    run() {
      const row = job();
      const shortened = DESCRIPTION.slice(0, 120);
      const chosenSnapshot = { id: 'P1', description: shortened, descriptionTruncated: true };
      const check = (snapshots, answer = chosen(), other = answer) => decide(row, answer, other, { snapshots });
      const incomplete = check([chosenSnapshot], chosen({ description: shortened }));
      assert.equal(incomplete.officialPosting.level, 'L4');
      assert.equal(incomplete.description, undefined, 'two identical copies of a known shortened description do not establish completeness');
      assert.equal(check([chosenSnapshot], chosen({ description: shortened.slice(0, 80) })).officialPosting.level, 'L4');
      assert.equal(check([chosenSnapshot]).officialPosting.level, 'L2', 'full agreeing text obtained beyond the snapshot remains usable');
      assert.equal(check([chosenSnapshot], chosen(), chosen({ description: `${DESCRIPTION}\nBenefits: dental.` })).officialPosting.level, 'L4',
        'a larger live copy never overrides disagreement between the judges');
      assert.equal(check([{ id: 'P2', pageText: DESCRIPTION, pageTextTruncated: true }]).officialPosting.level, 'L2',
        'a truncated careers page that leads elsewhere cannot truncate the posting');
      assert.equal(check([{ id: 'P2', description: DESCRIPTION, descriptionTruncated: true }]).officialPosting.level, 'L2',
        'an unrelated candidate cannot truncate the chosen posting');
      const viaCareers = chosen({ choice: 'P2' });
      assert.equal(check([{ id: 'P2', pageText: DESCRIPTION, pageTextTruncated: true }], viaCareers).officialPosting.level, 'L2',
        'choosing a careers lead still binds completeness to the downstream posting URL');
      assert.equal(check([{ id: 'P1', pageText: DESCRIPTION, pageTextTruncated: true }]).officialPosting.level, 'L4',
        'a copy wholly contained in shortened posting-page text stays link-only');
      const fromOther = chosen({ choice: 'other' });
      assert.equal(check([{ id: 'P1', description: DESCRIPTION, descriptionTruncated: true }], fromOther).officialPosting.level, 'L4',
        'other choices still honor a known snapshot of that actual URL');
      const redirectedUrl = 'https://northwind.test/careers/dispatch-engineer';
      assert.equal(check([{ id: 'P1', finalUrl: redirectedUrl, description: DESCRIPTION, descriptionTruncated: true }],
        chosen({ postingUrl: redirectedUrl })).officialPosting.level, 'L4', 'redirected snapshots bind by their final posting URL');
    },
  },
  {
    name: 'Production chat resolution keeps complete chosen text when an unrelated careers snapshot is truncated',
    async run() {
      _resetOfficialPostingDiscoveryDiagnosticsForTests();
      try { await withStore(async store => {
        const snapshotFetch = async url => url === CAREERS
          ? { url, contentType: 'text/html', body: `<main>${'Unrelated careers navigation. '.repeat(1500)}</main>` }
          : { url, contentType: 'application/json', body: JSON.stringify({ id: 4455667, title: 'Dispatch Engineer',
            absolute_url: POSTING, location: { name: 'Lakeview, Ontario, Canada' }, content: DESCRIPTION, company_name: 'Northwind Labs' }) };
        const callRaw = async (prompt, options) => options.task === 'job-official-posting-research'
          ? research(requestedIds(prompt)) : JSON.stringify(chosen({ choice: hostLeads(prompt).find(lead => lead.url === POSTING).id }));
        const result = await resolveOfficialPostings([job()], { store, snapshotFetch, callRaw });
        assert.equal(result.jobs[0].officialPosting.level, 'L2');
        const saved = await store.find(job());
        assert.equal(await store.readText(saved.officialPosting.contentHash), DESCRIPTION);
        const diagnostic = getOfficialPostingDiscoveryDiagnosticsSnapshot().observations.findLast(row => row.chatStats);
        assert.equal(diagnostic.chatStats.snapshotReads, 2);
        assert.equal(diagnostic.chatStats.truncatedSnapshots, 1);
      }); } finally { _resetOfficialPostingDiscoveryDiagnosticsForTests(); }
    },
  },
  {
    name: 'Agreeing judges store a durable verified posting whose text the generation freeze accepts; differing copies keep only the link',
    run() {
      const row = job();
      const agreed = decide(row, chosen(), chosen({ description: DESCRIPTION.replace(/\n/gu, '\n\n') }));
      const posting = normalizeOfficialPosting(agreed.officialPosting);
      assert.equal(posting.level, 'L2'); assert.equal(posting.outcome, 'found');
      assert.equal(posting.ats, 'greenhouse'); assert.equal(posting.tenant, 'northwind'); assert.equal(posting.sourceUrl, POSTING);
      assert.equal(agreed.description, canonicalJudgeDescription(DESCRIPTION));
      assert.equal(officialPostingSemanticProofMatches(row, posting), true);
      assert.equal(shouldPersistOfficialPostingResult({ officialPosting: posting }, { researchRan: true }), true);
      assert.equal(officialPostingLookupStatus(posting).label, 'Exact official posting verified');
      assert.equal(agreed.postedBy, '');
      const linkOnly = decide(row, chosen(), chosen({ description: `${DESCRIPTION}\nBenefits: dental.` }));
      assert.equal(linkOnly.officialPosting.level, 'L4'); assert.equal(linkOnly.officialPosting.outcome, 'link-only');
      assert.equal(linkOnly.description, undefined, 'unconfirmed text never reaches generation');
      assert.equal(officialPostingLookupStatus(linkOnly.officialPosting).state, 'verified');
      const ownSite = decide(row, chosen({ postingUrl: 'https://northwind.test/careers/dispatch-engineer' }),
        chosen({ postingUrl: 'https://northwind.test/careers/dispatch-engineer/' }));
      assert.equal(ownSite.officialPosting.level, 'L1');
      const recruiter = decide(job({ company: 'Acme Talent Partners' }), chosen(), chosen());
      assert.equal(recruiter.postedBy, 'Acme Talent Partners');
    },
  },
  {
    name: 'Copied title and employer must agree; a differing location or pay is not stored and the frozen job keeps the listing value',
    async run() {
      const row = job({ salary: '', salaryProvenance: 'unknown' });
      for (const [field, other] of [['location', 'Synthetic Foreign Location'], ['salary', 'CAD 90,000'], ['location', '']]) {
        // The agreed page and its agreed description stay verified; neither copy of the differing fact is stored,
        // and the frozen application keeps the scraped listing's value for that fact.
        const split = field === 'location' ? 'judge-location-split' : 'judge-salary-split';
        for (const [a, b] of [[chosen(), chosen({ [field]: other })], [chosen({ [field]: other }), chosen()]]) {
          const kept = decide(row, a, b);
          assert.equal(kept.officialPosting.outcome, 'found', field);
          assert.equal(kept.comparison.accepted, true, field);
          assert.equal(kept.description, DESCRIPTION, field);
          assert.ok(kept.officialPosting.trail.includes(split), field);
          if (field === 'location') assert.equal(kept.officialPosting.location, undefined);
          else assert.deepEqual(kept.officialPosting.salary, { text: '', provenance: 'unknown' });
          const posting = normalizeOfficialPosting({ ...kept.officialPosting, contentHash: crypto.createHash('sha256').update(kept.description).digest('hex') });
          assert.ok(posting.trail.includes(split), `${field} survives normalization`);
          const frozen = (await import('../../electron/ipc/localAiApplication.js')).__freezeOfficialPostingJobForTests(row,
            { officialPosting: posting, postedBy: kept.postedBy, description: kept.description, freshness: 'fresh-discovery', semanticMatching: true });
          assert.equal(frozen.snippet, DESCRIPTION, `${field} freezes the agreed official description`);
          assert.equal(frozen[field], row[field], `${field} keeps the scraped value`);
        }
      }
      // With both facts agreed, an official posting without pay still overrides the scraped pay (no split marker).
      const paid = job({ salary: 'CAD 80,000', salaryProvenance: 'posted' });
      const agreed = decide(paid, chosen(), chosen());
      const frozenAgreed = (await import('../../electron/ipc/localAiApplication.js')).__freezeOfficialPostingJobForTests(paid,
        { officialPosting: normalizeOfficialPosting({ ...agreed.officialPosting, contentHash: crypto.createHash('sha256').update(agreed.description).digest('hex') }), postedBy: agreed.postedBy, description: agreed.description,
          freshness: 'fresh-discovery', semanticMatching: true });
      assert.equal(frozenAgreed.salary, '');
      // Neither differing spelling is stored: the scraped company name, which both equal, is.
      for (const [a, b] of [[chosen(), chosen({ employer: 'Northwind Labs, Inc.' })], [chosen({ employer: 'Northwind Labs LLC' }), chosen({ employer: 'Northwind Labs, Inc.' })]]) {
        const suffixed = decide(row, a, b);
        assert.equal(suffixed.officialPosting.outcome, 'found');
        assert.equal(suffixed.officialPosting.employer, row.company);
      }
      assert.equal(decide(job({ company: 'Northwind Logistics' }), chosen(), chosen({ employer: 'Northwind Labs, Inc.' })).officialPosting.outcome, 'ambiguous');
      // A closed posting never hands back a description, agreed or not.
      const closedSplit = decide(row, chosen({ status: 'closed', location: 'Elsewhere' }), chosen({ status: 'closed' }));
      assert.equal(closedSplit.officialPosting.outcome, 'closed');
      assert.equal(closedSplit.description, undefined);
      for (const [field, other] of [['title', 'Synthetic Different Role'], ['employer', 'Synthetic Different Employer']]) {
        const answerA = chosen(); const answerB = chosen({ [field]: other });
        for (const answer of [answerA, answerB]) validateOfficialPostingJudgeResponse(answer, { job: row, leads });
        for (const [a, b] of [[answerA, answerB], [answerB, answerA]]) {
          const split = decide(row, a, b);
          assert.equal(split.officialPosting.outcome, 'ambiguous', field);
          assert.equal(split.officialPosting.level, 'L5', field);
          assert.ok(split.officialPosting.trail.includes('semantic-uncertain'), field);
          assert.equal(split.comparison.accepted, false, field);
          assert.equal(split.description, undefined, field);
          assert.equal(officialPostingSemanticProofMatches(row, split.officialPosting), false, field);
          assert.equal(officialPostingLookupStatus(split.officialPosting).retryable, true, field);
          assert.equal(shouldPersistOfficialPostingResult(split, { researchRan: true }), false, field);
        }
      }
      // The production service retries with a fresh independent pair, then leaves a persistent split unsettled.
      await withStore(async store => {
        let judgments = 0;
        const callRaw = async (prompt, options) => {
          if (options.task === 'job-official-posting-research') return research(requestedIds(prompt));
          judgments++;
          return JSON.stringify(chosen({ choice: hostLeads(prompt).find(lead => lead.url === POSTING).id,
            ...(options.manualHandoff.comparisonRun === 'A' ? { title: 'Synthetic Different Role',
              employer: 'Synthetic Different Employer', location: 'Synthetic Foreign Location', salary: 'CAD 90,000' } : {}) }));
        };
        const result = await resolveOfficialPostings([row], { store, snapshotFetch: offline, callRaw });
        assert.equal(judgments, 4);
        assert.equal(result.jobs[0].officialPosting.outcome, 'ambiguous');
        assert.equal(await store.find(row), null, 'conflicting copies never become a reusable posting record');
        const { __freezeOfficialPostingJobForTests: freeze } = await import('../../electron/ipc/localAiApplication.js');
        const frozen = freeze(row, { officialPosting: result.jobs[0].officialPosting, description: DESCRIPTION,
          freshness: 'fresh-discovery', semanticMatching: true });
        for (const field of ['title', 'company', 'location', 'salary', 'snippet']) assert.equal(frozen[field], row[field], field);
      });
    },
  },
  {
    name: 'Copied posting metadata agreement uses presentation normalization without semantic substitutions',
    run() {
      const a = chosen({ title: 'Dispatch “Service” Engineer — Routing', employer: 'Northwind Labs',
        location: 'Lakeview, Ontario, Canada', salary: 'CAD 90,000 — 100,000' });
      const b = chosen({ title: '  Dispatch "Service" Engineer - Routing  ', employer: 'Northwind\u00a0 Labs',
        location: ' Lakeview,  Ontario, Canada ', salary: 'CAD 90,000 - 100,000' });
      const agreed = decide(job(), a, b);
      assert.equal(agreed.officialPosting.outcome, 'found');
      assert.equal(agreed.comparison.accepted, true);
      assert.equal(agreed.officialPosting.title, a.title);
      assert.equal(agreed.officialPosting.salary.text, a.salary);
      for (const changed of [chosen({ title: 'dispatch engineer' }), chosen({ employer: 'Northwind' })]) {
        assert.equal(decide(job(), chosen(), changed).officialPosting.outcome, 'ambiguous');
      }
      for (const changed of [chosen({ location: 'Lakeview' }), chosen({ salary: 'CAD 90000 per year' })]) {
        assert.equal(decide(job(), chosen(), changed).officialPosting.outcome, 'found');
      }
    },
  },
  {
    name: 'Judges reaching one posting through different leads agree; different posting pages or statuses stay retryable',
    run() {
      const row = job();
      const viaCareers = decide(row, chosen(), chosen({ choice: 'P2' }));
      assert.equal(viaCareers.officialPosting.outcome, 'found');
      assert.ok(viaCareers.officialPosting.trail.includes('comparative-equivalent'));
      assert.equal(shouldPersistOfficialPostingResult({ officialPosting: viaCareers.officialPosting }, { researchRan: true }), true);
      for (const [answerB, code] of [
        [chosen({ postingUrl: 'https://job-boards.greenhouse.io/northwind/jobs/9999999' }), 'semantic-uncertain'],
        [unresolvedAnswer('uncertain'), 'semantic-uncertain'],
        [chosen({ status: 'unknown' }), 'official-liveness-unconfirmed'],
        [chosen({ status: 'closed', description: '' }), 'official-liveness-unconfirmed'],
        [chosen({ employerLinked: false, employerPageUrl: '', employerLinkQuote: '' }), 'source-unproven'],
      ]) {
        const result = decide(row, chosen(), answerB);
        assert.ok(result.officialPosting.trail.includes(code), code);
        assert.equal(officialPostingLookupStatus(result.officialPosting).retryable, true, code);
        assert.equal(shouldPersistOfficialPostingResult({ officialPosting: result.officialPosting }, { researchRan: true }), false, code);
      }
    },
  },
  {
    name: 'Both judges seeing it closed record a durable closed posting; both finding no lead record a settled miss',
    run() {
      const row = job();
      const closedAnswer = { status: 'closed', statusQuote: 'No longer accepting applications', description: '',
        evidence: [{ scrapedQuote: 'Dispatch Engineer', officialQuote: 'Dispatch Engineer' }] };
      const closed = decide(row, chosen(closedAnswer), chosen(closedAnswer));
      assert.equal(closed.officialPosting.outcome, 'closed');
      assert.equal(officialPostingLookupStatus(closed.officialPosting).state, 'closed');
      assert.equal(shouldPersistOfficialPostingResult({ officialPosting: closed.officialPosting }, { researchRan: true }), true);
      const miss = decide(row, unresolvedAnswer('none'), unresolvedAnswer('none'));
      assert.equal(miss.officialPosting.outcome, 'not-found');
      assert.equal(officialResearchSettled(miss.officialPosting), true);
      assert.equal(officialPostingLookupStatus(miss.officialPosting).state, 'not-found');
    },
  },
  {
    name: 'A posting counts only when both judges saw the employer link it, closed included; unseen leads block a settled miss',
    run() {
      const row = job();
      const unlinked = { status: 'closed', statusQuote: 'No longer accepting applications', description: '', employerLinked: false,
        employerPageUrl: '', employerLinkQuote: '', evidence: [{ scrapedQuote: 'Dispatch Engineer', officialQuote: 'Dispatch Engineer' }] };
      const closedRepost = decide(row, chosen(unlinked), chosen(unlinked));
      assert.ok(closedRepost.officialPosting.trail.includes('source-unproven'));
      assert.equal(officialPostingLookupStatus(closedRepost.officialPosting).retryable, true);
      const capped = decide(row, unresolvedAnswer('none'), unresolvedAnswer('none'), { totalLeads: 11 });
      assert.ok(capped.officialPosting.trail.includes('comparative-truncated'));
      assert.equal(officialResearchSettled(capped.officialPosting), false);
      assert.equal(capped.comparison.truncated, true); assert.equal(capped.comparison.preCapCount, 11);
      // A copy that is empty once unsafe characters are removed is not usable text.
      assert.throws(() => validateOfficialPostingJudgeResponse(chosen({ description: '\u0001', evidence: [{ scrapedQuote: 'Dispatch Engineer', officialQuote: 'Dispatch Engineer' }] }),
        { job: row, leads }), error => error.code === 'OFFICIAL_POSTING_RESPONSE_INVALID');
    },
  },
  {
    name: 'Cards sharing one scraped identity share one finder slot and both receive its leads',
    async run() {
      await withStore(async store => {
        const first = job(); const second = job();
        const callRaw = async (prompt, options) => {
          if (options.task === 'job-official-posting-research') {
            assert.equal(requestedIds(prompt).length, 1, 'one research slot for the shared identity');
            return research(requestedIds(prompt));
          }
          return JSON.stringify(chosen({ choice: hostLeads(prompt).find(lead => lead.url === POSTING).id }));
        };
        const result = await resolveOfficialPostings([first, second], { store, snapshotFetch: offline, callRaw });
        assert.deepEqual(result.jobs.map(row => row.officialPosting.outcome), ['found', 'found']);
      });
    },
  },
  {
    name: 'The production lookup asks ChatGPT only: finder, two judges, stored text, then a cache hit without new chats',
    async run() {
      await withStore(async store => {
        const row = job(); const calls = [];
        const callRaw = async (prompt, options) => {
          calls.push(options.task);
          if (options.task === 'job-official-posting-research') return research(requestedIds(prompt));
          assert.equal(options.grounding, true, 'judges are asked to browse');
          return JSON.stringify(chosen({ choice: hostLeads(prompt).find(lead => lead.url === POSTING).id }));
        };
        const result = await resolveOfficialPostings([row], { store, snapshotFetch: offline, callRaw, bridgeStatus: () => ({}) });
        assert.deepEqual(calls, ['job-official-posting-research', 'job-official-posting-match', 'job-official-posting-match']);
        const posting = result.jobs[0].officialPosting;
        assert.equal(posting.outcome, 'found'); assert.equal(posting.sourceUrl, POSTING);
        assert.equal(await store.readText(posting.contentHash), canonicalJudgeDescription(DESCRIPTION));
        assert.equal(result.telemetry.comparativeMatches, 1); assert.equal(result.telemetry.fetches, 2, 'lead snapshots use the shared download scheduler');
        const again = await resolveOfficialPostings([row], { store, snapshotFetch: offline, callRaw: () => { throw new Error('a cached verified row asks no chat'); } });
        assert.ok(again.jobs[0].officialPosting.trail.includes('cache-hit'));
        assert.equal(again.telemetry.fetches, 0, 'a cached decision does not create new snapshots');
      });
    },
  },
  {
    name: 'An unsettled first pair gets one fresh isolated pair; only that pair\'s own agreement can settle the row',
    async run() {
      for (const secondAgrees of [true, false]) {
        await withStore(async store => {
          const groups = []; let judgments = 0;
          const callRaw = async (prompt, options) => {
            if (options.task === 'job-official-posting-research') return research(requestedIds(prompt));
            judgments += 1; groups.push(options.manualHandoff.comparisonGroup);
            const id = hostLeads(prompt).find(lead => lead.url === POSTING).id;
            // First pair: A finds it, B is unsure. Second pair: both find it, or B is unsure again.
            const unsure = options.manualHandoff.comparisonRun === 'B' && (judgments === 2 || !secondAgrees);
            return JSON.stringify(unsure ? unresolvedAnswer('uncertain') : chosen({ choice: id }));
          };
          const result = await resolveOfficialPostings([job()], { store, snapshotFetch: offline, callRaw });
          assert.equal(judgments, 4);
          assert.equal(new Set(groups).size, 2, 'each pair has its own comparison group');
          const posting = result.jobs[0].officialPosting;
          if (secondAgrees) {
            assert.equal(posting.outcome, 'found');
            assert.equal(Object.hasOwn(posting, 'alternatives'), false);
          } else {
            assert.ok(posting.trail.includes('semantic-uncertain'));
            assert.equal(officialPostingLookupStatus(posting).retryable, true);
            assert.deepEqual(posting.alternatives, [{ url: POSTING, title: 'Unconfirmed · cited by 2 of 4 judges' }, { url: CAREERS, title: 'Unconfirmed · careers page found by search, not cited by judges' }]);
          }
        });
      }
    },
  },
  {
    name: 'A judge may report a posting its own search found; a miss settles only when a second isolated pair also finds nothing',
    async run() {
      const row = job();
      const elsewhere = 'https://northwind.test/jobs/dispatch-engineer';
      const viaSearch = decide(row, chosen({ choice: 'other', postingUrl: elsewhere }), chosen({ choice: 'other', postingUrl: `${elsewhere}/` }));
      assert.equal(viaSearch.officialPosting.outcome, 'found'); assert.equal(viaSearch.officialPosting.sourceUrl, elsewhere);
      assert.equal(shouldPersistOfficialPostingResult({ officialPosting: viaSearch.officialPosting }, { researchRan: true }), true);
      assert.equal(validateOfficialPostingJudgeResponse(chosen({ choice: 'other', postingUrl: elsewhere }), { job: row, leads }).choice, 'other');
      for (const [secondPair, expected] of [['none', 'not-found'], ['found', 'found'], ['fails', 'retryable']]) {
        await withStore(async store => {
          let judgments = 0;
          const callRaw = async (prompt, options) => {
            if (options.task === 'job-official-posting-research') return research(requestedIds(prompt));
            judgments += 1;
            if (judgments <= 2 || secondPair === 'none') return JSON.stringify(unresolvedAnswer('none'));
            if (secondPair === 'fails') return '{"choice":"P1"}';
            return JSON.stringify(chosen({ choice: hostLeads(prompt).find(lead => lead.url === POSTING).id }));
          };
          const result = await resolveOfficialPostings([job()], { store, snapshotFetch: offline, callRaw });
          const posting = result.jobs[0].officialPosting;
          if (expected === 'retryable') assert.equal(officialPostingLookupStatus(posting).retryable, true, secondPair);
          else assert.equal(posting.outcome, expected, secondPair);
          if (expected === 'not-found') assert.equal(officialResearchSettled(posting), true);
        });
      }
    },
  },
  {
    name: 'A closure, like a miss, is final only when a second isolated pair also sees it closed',
    async run() {
      const closedAnswer = id => chosen({ choice: id, status: 'closed', statusQuote: 'The application page for this job is not found',
        description: '', evidence: [{ scrapedQuote: 'Dispatch Engineer', officialQuote: 'Dispatch Engineer' }] });
      for (const [secondPair, expected] of [['closed', 'closed'], ['open', 'found'], ['fails', 'retryable']]) {
        await withStore(async store => {
          let judgments = 0;
          const callRaw = async (prompt, options) => {
            if (options.task === 'job-official-posting-research') return research(requestedIds(prompt));
            judgments += 1;
            const id = hostLeads(prompt).find(lead => lead.url === POSTING).id;
            if (judgments <= 2 || secondPair === 'closed') return JSON.stringify(closedAnswer(id));
            if (secondPair === 'fails') return '{"choice":"P1"}';
            return JSON.stringify(chosen({ choice: id }));
          };
          const result = await resolveOfficialPostings([job()], { store, snapshotFetch: offline, callRaw });
          const posting = result.jobs[0].officialPosting;
          if (expected === 'retryable') assert.equal(officialPostingLookupStatus(posting).retryable, true, secondPair);
          else assert.equal(posting.outcome, expected, secondPair);
        });
      }
    },
  },
  {
    name: 'A job-board posting lead carries that board\'s public data address for judges whose browser cannot run JavaScript',
    async run() {
      await withStore(async store => {
        let seen = null;
        const callRaw = async (prompt, options) => {
          if (options.task === 'job-official-posting-research') return research(requestedIds(prompt));
          seen ||= hostLeads(prompt);
          return JSON.stringify(chosen({ choice: hostLeads(prompt).find(lead => lead.url === POSTING).id }));
        };
        await resolveOfficialPostings([job()], { store, snapshotFetch: offline, callRaw });
        const posting = seen.find(lead => lead.url === POSTING); const careers = seen.find(lead => lead.url === CAREERS);
        assert.equal(posting.dataUrl, 'https://boards-api.greenhouse.io/v1/boards/northwind/jobs/4455667?questions=false');
        assert.equal(careers.dataUrl, undefined, 'a careers page has no board data address');
        assert.match(buildOfficialPostingJudgeRequest({ job: job(), leads: [{ id: 'P1', url: POSTING, kind: 'posting', dataUrl: posting.dataUrl }], run: 'A' }).prompt,
          /When a lead has a dataUrl, open it/u);
      });
    },
  },
  {
    name: 'The app downloads each lead for the judges: board data says whether the posting is listed, by its identifier',
    async run() {
      const api = 'https://boards-api.greenhouse.io/v1/boards/northwind/jobs/4455667?questions=false';
      const pages = { [api]: { url: api, contentType: 'application/json', statusCode: 200, body: JSON.stringify({ id: 4455667, title: 'Dispatch Engineer',
        absolute_url: 'https://boards.greenhouse.io/northwind/jobs/4455667', location: { name: 'Lakeview, Ontario, Canada' }, content: DESCRIPTION, company_name: 'Northwind Labs' }) },
      [CAREERS]: { url: CAREERS, contentType: 'text/html', statusCode: 200, body: '<title>Careers</title><a href="https://job-boards.greenhouse.io/northwind">Open roles</a>' } };
      const fetch = async url => { if (pages[url]) return pages[url]; const error = new Error('gone'); error.code = 'fetch-failed'; error.statusCode = 404; throw error; };
      const snaps = await snapshotOfficialPostingLeads([{ id: 'P1', url: POSTING, kind: 'posting', dataUrl: api }, { id: 'P2', url: CAREERS, kind: 'careers' },
        { id: 'P3', url: 'https://northwind.test/jobs/old', kind: 'posting' }], { fetch });
      assert.equal(snaps[0].listedInBoardData, true, 'a host move (boards. vs job-boards.) keeps the same posting identifier');
      assert.equal(snaps[0].title, 'Dispatch Engineer'); assert.ok(snaps[0].description.includes('Review route reports'));
      assert.deepEqual(snaps[1].jobBoardLinks, ['https://job-boards.greenhouse.io/northwind']);
      assert.equal(snaps[2].read, false); assert.equal(snaps[2].notFound, true);
      const prompt = buildOfficialPostingJudgeRequest({ job: job(), leads, run: 'A', snapshots: snaps }).prompt;
      assert.ok(prompt.indexOf('BEGIN UNTRUSTED APP PAGE SNAPSHOTS JSON') > prompt.indexOf('END HOST LEADS JSON'));
      // A copy taken from a shortened snapshot keeps only the official link.
      const short = decide(job(), chosen(), chosen(), { textComplete: false });
      assert.equal(short.officialPosting.level, 'L4'); assert.equal(short.description, undefined);
    },
  },
  {
    name: 'A row neither finder can place stays retryable after one extra search; the judges are never asked',
    async run() {
      await withStore(async store => {
        const calls = [];
        const callRaw = async (prompt, options) => { calls.push(options.task); return notFound(requestedIds(prompt)); };
        const result = await resolveOfficialPostings([job()], { store, snapshotFetch: offline, callRaw });
        assert.deepEqual(calls, ['job-official-posting-research', 'job-official-posting-research']);
        const posting = result.jobs[0].officialPosting;
        assert.ok(posting.trail.includes('research-miss'));
        assert.equal(officialPostingLookupStatus(posting).retryable, true);
      });
    },
  },
  {
    name: 'A malformed judgment gets one correction round; a second failure leaves the row retryable and unsaved',
    async run() {
      await withStore(async store => {
        let corrections = 0;
        const callRaw = async (prompt, options) => {
          if (options.task === 'job-official-posting-research') return research(requestedIds(prompt));
          if (options.correctionAttempt === 1) corrections += 1;
          return '{"choice":"P1"}';
        };
        const result = await resolveOfficialPostings([job()], { store, snapshotFetch: offline, callRaw });
        assert.equal(corrections, 1);
        const posting = result.jobs[0].officialPosting;
        assert.ok(posting.trail.includes('comparative-invalid'));
        assert.equal(officialPostingLookupStatus(posting).retryable, true);
        assert.equal(await store.find(job()), null);
      });
    },
  },
  {
    name: 'Without the ChatGPT bridge the lookup is incomplete, never a conclusion',
    async run() {
      await withStore(async store => {
        const result = await resolveOfficialPostings([job()], { store, snapshotFetch: offline, bridgeAvailable: false,
          callRaw: () => { throw new Error('no chat without the bridge'); } });
        const status = officialPostingLookupStatus(result.jobs[0].officialPosting);
        assert.equal(status.state, 'incomplete'); assert.equal(status.retryable, true);
      });
    },
  },
  {
    name: 'Each second-round judge has a distinct prompt and a fresh shared comparison group',
    run() {
      const row = job();
      const first = {}; const second = {};
      for (const run of ['A', 'B']) {
        first[run] = buildOfficialPostingJudgeRequest({ job: row, leads, run, round: 1 });
        second[run] = buildOfficialPostingJudgeRequest({ job: row, leads, run, round: 2 });
        const originalHeading = `Independent official posting judgment run ${run}.`;
        const secondHeading = `Independent official posting judgment run ${run}, second independent review (round 2).`;
        assert.equal(first[run].prompt.slice(0, originalHeading.length), originalHeading);
        assert.equal(second[run].prompt, secondHeading + first[run].prompt.slice(originalHeading.length));
        assert.notEqual(second[run].prompt, first[run].prompt);
        assert.doesNotMatch(first[run].prompt, /\b(?:round 2|second independent review)\b/u);
        assert.deepEqual(hostLeads(second[run].prompt), hostLeads(first[run].prompt));
      }
      assert.equal(first.A.manualHandoff.comparisonGroup, first.B.manualHandoff.comparisonGroup);
      assert.equal(second.A.manualHandoff.comparisonGroup, second.B.manualHandoff.comparisonGroup);
      assert.notEqual(second.A.manualHandoff.comparisonGroup, first.A.manualHandoff.comparisonGroup);
    },
  },
  {
    name: 'A failed judgment is recorded with its failure code and round',
    async run() {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'official-chat-failure-'));
      try {
        const store = createOfficialPostingStore(root);
        assert.equal(store.rootDir, root);
        const row = job(); const time = Date.UTC(2026, 9, 29);
        let card; let judgeCalls = 0; let judgeLeadUrls;
        const callRaw = async (prompt, options) => {
          assert.equal(options.task, 'job-official-posting-research');
          const ids = requestedIds(prompt); [card] = ids;
          return research(ids);
        };
        const callMatch = async (prompt, options) => {
          assert.equal(options.task, 'job-official-posting-match');
          judgeCalls += 1;
          judgeLeadUrls = hostLeads(prompt).map(lead => lead.url);
          return '{"choice":"P1"}';
        };
        await resolveOfficialPostings([row], { store, now: () => time, snapshotFetch: offline, callRaw, callMatch });
        assert.equal(judgeCalls, 2, 'the invalid answer receives one correction attempt');
        assert.ok(judgeLeadUrls.includes(POSTING));
        const entries = (await fs.readFile(path.join(store.rootDir, 'judgments.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
        assert.deepEqual(entries, [{ at: new Date(time).toISOString(), card, title: row.title, company: row.company,
          round: 1, run: 'A', route: 'mcp', manualRoutingReason: null, leads: judgeLeadUrls, failure: 'comparative-invalid' }]);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Judgment failures retain the actual manual routing reason through assignment wrapping',
    async run() {
      await withStore(async store => {
        const callRaw = async prompt => research(requestedIds(prompt));
        const callMatch = async (_prompt, options) => {
          options.manualHandoff.onRoute({ route: 'manual', manualRoutingReason: 'restored-draft' });
          throw Object.assign(new Error('Synthetic legacy manual state'), { code: 'OFFICIAL_POSTING_COMPARATIVE_UNAVAILABLE' });
        };
        await resolveOfficialPostings([job()], { store, snapshotFetch: offline, callRaw, callMatch,
          timeoutStartsOnAssignment: true, bridgeStatus: linkedPool });
        const entries = (await fs.readFile(path.join(store.rootDir, 'judgments.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
        assert.equal(entries.length, 1);
        assert.equal(entries[0].route, 'manual');
        assert.equal(entries[0].manualRoutingReason, 'restored-draft');
        assert.equal(entries[0].failure, 'comparative-unavailable');
      });
    },
  },
  {
    name: 'A second-round judge failure is logged without replacing the first unsettled decision',
    async run() {
      await withStore(async store => {
        const calls = [];
        const callRaw = async (prompt, options) => {
          assert.equal(options.task, 'job-official-posting-research');
          return research(requestedIds(prompt));
        };
        const callMatch = async (prompt, options) => {
          const run = options.manualHandoff.comparisonRun;
          const round = prompt.startsWith(`Independent official posting judgment run ${run}, second independent review (round 2).`) ? 2 : 1;
          calls.push(`${round}${run}`);
          if (round === 2 && run === 'B') return '{"choice":"P1"}';
          if (round === 1 && run === 'B') return JSON.stringify(unresolvedAnswer('uncertain'));
          return JSON.stringify(chosen({ choice: hostLeads(prompt).find(lead => lead.url === POSTING).id }));
        };
        const result = await resolveOfficialPostings([job()], { store, snapshotFetch: offline, callRaw, callMatch });
        assert.deepEqual(calls, ['1A', '1B', '2A', '2B', '2B']);
        assert.ok(result.jobs[0].officialPosting.trail.includes('semantic-uncertain'));
        const entries = (await fs.readFile(path.join(store.rootDir, 'judgments.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
        assert.deepEqual(entries.map(({ round, run, failure }) => ({ round, run, failure })), [
          { round: 1, run: 'A', failure: undefined }, { round: 1, run: 'B', failure: undefined },
          { round: 2, run: 'A', failure: undefined }, { round: 2, run: 'B', failure: 'comparative-invalid' },
        ]);
      });
    },
  },
  {
    name: 'Judges report a chosen posting lead by its listed address, so two judges cite one posting the same way',
    run() {
      const { prompt } = buildOfficialPostingJudgeRequest({ job: job(), leads, run: 'A' });
      assert.match(prompt, /When that lead is a posting lead, report its url exactly as listed as postingUrl, even when the same posting also appears at another address such as the employer's own careers page;/u);
      // Code still compares the two reported addresses only for equality: one requisition cited at two addresses stays unsettled.
      const EMPLOYER_PAGE = 'https://careers.northwind.test/job/R000105663/Dispatch-Engineer';
      const split = decide(job(), chosen({ postingUrl: EMPLOYER_PAGE }), chosen());
      assert.equal(split.comparison.accepted, false);
      assert.ok(split.officialPosting.trail.includes('semantic-uncertain'));
    },
  },
  {
    name: 'A plain HTML page longer than the snapshot cap is flagged pageTextTruncated; a short page is not',
    async run() {
      const page = body => ({ [POSTING]: { url: POSTING, contentType: 'text/html', statusCode: 200, body } });
      const snap = async body => (await snapshotOfficialPostingLeads([{ id: 'P1', url: POSTING, kind: 'posting' }], { fetch: async url => page(body)[url] }))[0];
      const long = await snap(`<html><body>${'<p>Build reliable routing services for delivery teams.</p>'.repeat(800)}<p>FINAL REQUIREMENT</p></body></html>`);
      assert.equal(long.pageText.length, 30000);
      assert.ok(!long.pageText.includes('FINAL REQUIREMENT'));
      assert.equal(long.pageTextTruncated, true);
      const shortSnap = await snap('<html><body><p>Short posting text about dispatch routing.</p></body></html>');
      assert.ok(shortSnap.pageText.includes('Short posting text'));
      assert.ok(!('pageTextTruncated' in shortSnap));
    },
  },
  {
    name: 'Judges may accept a parent company careers site only for a posting that names the hiring company',
    run() {
      const { prompt } = buildOfficialPostingJudgeRequest({ job: job(), leads, run: 'A' });
      assert.match(prompt, /A parent company's careers site counts as the hiring company's own when the posting itself names the hiring company as the brand, team or employer that is hiring/u);
      assert.match(prompt, /a sister company's site \(another company under the same parent\), or a parent company's page whose posting does not name the hiring company\./u);
      assert.doesNotMatch(prompt, /a parent or sister company's site/u);
    },
  },
];
