import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  boardCombinedSearchRun, boardOfficialPostingRefreshCardMatches, carryBoardOfficialPostingResults, countBoardOfficialRetries, refreshBoardOfficialPostingJobs,
  searchRowsWithIncompleteLookups, summarizeBoardOfficialPostingChecks, summarizeSearchOfficialLookups,
} from '../../src/utils/jobBoardOfficialPostingRefresh.js';
import { officialPostingPreparationSourceKey, projectOfficialPostingGenerationJob } from '../../src/utils/officialPostingPreparation.js';
import { appendDeadSourceUrl, carryBoardDeadSourceUrls, jobCardSourceLinks, jobSourceLinkMark, jobSourceLinks, MAX_DEAD_SOURCE_URLS,
  mergeDeadSourceUrls, pickCurrentJobSourceLink, sourceLinkHostClass } from '../../src/utils/jobSourceLinks.js';
import { AGGREGATOR_BASE_DOMAINS, ATS_BASE_DOMAINS } from '../../electron/ipc/officialSourceHosts.js';
import { buildJobTreeNodes } from '../../src/nodes/jobsearch/buildJobTree.js';
import { OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL } from '../../electron/ipc/officialPostingNegativePolicy.js';
import { bundleComponent, withDom } from './fixtures/practice-connector/mountComponent.js';
import { withConsoleCollector } from './fixtures/practice-connector/renderHarness.js';

const job = (index = 0, extra = {}) => ({ title: `Synthetic Role ${index}`, company: 'Synthetic Employer',
  location: 'Synthetic City, Canada', source: 'linkedin', url: `https://listing.example.test/${index}`,
  snippet: `Synthetic source description ${index}.`, salary: '', matchScore: 83,
  ...extra });
const posting = (index = 0, extra = {}) => ({ level: 'L1', outcome: 'found', employer: 'Synthetic Employer',
  sourceUrl: `https://careers.example.test/${index}`, trail: ['semantic-match-v1'],
  semanticMatch: { version: 1, inputHash: 'a'.repeat(64), sourceHash: 'b'.repeat(64) }, ...extra });
const card = (data, id = 'synthetic-card') => ({ id, type: 'jobcard', hidden: true, data });
const response = entries => ({ success: true, entries: entries.map(({ cardId }, index) => ({ cardId,
  officialPosting: posting(index), postedBy: '' })) });
const key = data => officialPostingPreparationSourceKey(projectOfficialPostingGenerationJob(data));
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

async function withRefreshHook(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'board-official-refresh-'));
  let bundle;
  try {
    const entry = path.join(directory, 'Probe.jsx');
    await fs.writeFile(entry, `
import React from ${JSON.stringify(path.resolve('node_modules/react/index.js'))};
import { useBoardOfficialPostingRefresh } from ${JSON.stringify(path.resolve('src/hooks/useBoardOfficialPostingRefresh.js'))};
export { getOfficialPostingPreparation as probePreparation } from ${JSON.stringify(path.resolve('src/utils/officialPostingPreparation.js'))};
export { EventLogger as probeLogger } from ${JSON.stringify(path.resolve('src/utils/EventLogger.js'))};
export function Probe({ options, capture }) {
  const value = useBoardOfficialPostingRefresh(options);
  capture(value);
  return <span>{value.progress ? 'working' : 'idle'}</span>;
}
`);
    bundle = await bundleComponent(entry);
    const { React, act, createRoot, Probe, probePreparation, probeLogger } = bundle.module;
    await withDom(window => withConsoleCollector(async consoleEntries => {
      const board = { id: 'board', type: 'jobboard', data: { hubState: 'done' } };
      const nodes = [board, ...Array.from({ length: 6 }, (_, index) => card({ ...job(index), hubId: board.id,
        notes: `Synthetic live note ${index}`, localApplication: { id: `synthetic-application-${index}` } }, `card-${index}`))];
      const updates = []; const pendingUpdates = []; const requests = []; const cancellations = []; const retired = []; const leases = []; const toasts = [];
      let scope = 'source-run-one'; let handle; let operation; let reply; let cancellation; let acknowledge; let rejectAcknowledgment;
      let holdAcknowledgement = false; let deferredUpdates = false; let holdRetirement = false; let retire; let unmounted = false;
      const applyUpdate = (id, update) => {
        const node = nodes.find(candidate => candidate.id === id);
        const patch = typeof update === 'function' ? update(node) : update;
        if (patch && node) { updates.push({ id, patch }); node.data = { ...node.data, ...patch }; }
      };
      window.electronAPI = {
        refreshOfficialPostings: args => { requests.push(args); return new Promise(resolve => { reply = resolve; }); },
        cancelNodeTaskAndWait: (...args) => {
          cancellations.push(args);
          return holdAcknowledgement ? new Promise((resolve, reject) => { acknowledge = resolve; rejectAcknowledgment = reject; }) : Promise.resolve({ settled: true });
        },
        completeNonApiAiRun: async id => {
          retired.push(id);
          if (holdRetirement) await new Promise(resolve => { retire = resolve; });
        },
      };
      let options = { nodeId: board.id, canvasFilePath: '/synthetic/workspace.canvas',
        getNode: id => nodes.find(node => node.id === id), getNodes: () => nodes,
        updateGlobal: (id, update) => { if (deferredUpdates) pendingUpdates.push({ id, update }); else applyUpdate(id, update); },
        moduleRunQueue: { acquireModuleRun: async args => {
          const lease = { args, released: false, release() { this.released = true; } }; leases.push(lease); return lease;
        }, cancelQueuedRunsForNode() {} },
        addToast: value => toasts.push(value), canStart: () => true, getScopeKey: () => scope };
      const root = createRoot(window.document.getElementById('root'));
      const render = async patch => {
        options = { ...options, ...patch };
        await act(async () => root.render(React.createElement(React.StrictMode, null,
          React.createElement(Probe, { options, capture: value => { handle = value; } }))));
      };
      try {
        await render();
        await run({ nodes, board, updates, requests, cancellations, retired, leases, toasts, render,
          get handle() { return handle; }, probePreparation, getLogs: () => probeLogger.getLogs(),
          get pendingUpdates() { return pendingUpdates.length; },
          setScope: value => { scope = value; }, holdAcknowledgement: () => { holdAcknowledgement = true; },
          deferUpdates: () => { deferredUpdates = true; }, holdRetirement: () => { holdRetirement = true; },
          async drainUpdates() { await act(async () => { for (const { id, update } of pendingUpdates.splice(0)) applyUpdate(id, update); }); },
          async finishRetirement() { await act(async () => { retire?.(); await operation; }); },
          async start() {
            await act(async () => {
              const running = handle.runRef.current;
              const next = handle.start();
              if (!running) operation = next;
              await Promise.resolve();
            });
          },
          async finishOperation() { await act(async () => { await operation; }); },
          async retryIncomplete() {
            await act(async () => { operation = handle.retryIncomplete(); await Promise.resolve(); });
          },
          async complete(value = response(requests.at(-1).entries)) {
            await act(async () => { reply(value); await operation; });
          },
          async replyWithoutWaiting(value = response(requests.at(-1).entries)) {
            await act(async () => { reply(value); await Promise.resolve(); await Promise.resolve(); });
          },
          async cancel() { await act(async () => { cancellation = handle.cancel(); await Promise.resolve(); }); },
          async acknowledge() { await act(async () => { acknowledge?.({ settled: true }); await cancellation; await operation; }); },
          async failAcknowledgement(reject = false) {
            await act(async () => {
              if (reject) rejectAcknowledgment(new Error('Synthetic acknowledgment failure.'));
              else acknowledge({ settled: false });
              await Promise.resolve(); await Promise.resolve();
            });
          },
          async hide() { await act(async () => root.render(null)); },
          async unmount() { await act(async () => root.unmount()); unmounted = true; },
        });
      } finally {
        await act(async () => {
          reply?.({ success: false, cancelled: true }); acknowledge?.({ settled: true }); retire?.();
          await Promise.allSettled([operation, cancellation]);
          if (!unmounted) root.unmount();
        });
      }
      assert.deepEqual(consoleEntries, [], 'the mounted hook must not emit React warnings');
    }));
  } finally { await bundle?.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
}

const uncertain = (extra = {}) => ({ level: 'L5', outcome: 'ambiguous', employer: 'Synthetic Employer',
  trail: ['worker-research', 'semantic-uncertain'], ...extra });

export default [
  {
    name: 'Retry incomplete checks only unfinished cards in place and lets the host reuse saved results',
    async run() {
      await withRefreshHook(async probe => {
        const [done, incomplete, paused, unchecked, locked, low] = probe.nodes.slice(1);
        done.data = { ...done.data, officialPosting: posting(0) };
        incomplete.data = { ...incomplete.data, officialPosting: uncertain() };
        // The retired marker predates job-board links in snapshots, so that card gets one more try.
        paused.data = { ...paused.data, officialPosting: uncertain({ trail: ['worker-research', 'semantic-uncertain', 'retry-paused'] }) };
        locked.data = { ...locked.data, officialPosting: uncertain(), locked: true };
        low.data = { ...low.data, officialPosting: uncertain(), matchScore: 20 };
        assert.equal(countBoardOfficialRetries(probe.nodes, 'board'), 3);
        await probe.retryIncomplete();
        assert.equal(probe.requests.length, 1);
        assert.deepEqual(probe.requests[0].entries.map(entry => entry.cardId), [incomplete.id, paused.id, unchecked.id]);
        assert.equal(probe.requests[0].force, false, 'saved decisions stay available to the host');
        const untouched = structuredClone(done.data);
        await probe.complete();
        assert.deepEqual(done.data, untouched);
        assert.equal(incomplete.data.officialPosting.outcome, 'found');
        assert.equal(incomplete.data.notes, 'Synthetic live note 1', 'a retry keeps the card');
        assert.match(probe.toasts.at(-1).description, /Re-combine to apply any score or duplicate changes/u);
      });
    },
  },
  {
    name: 'Recheck all stays a full bypass and Retry incomplete reports when nothing is unfinished',
    async run() {
      await withRefreshHook(async probe => {
        for (const node of probe.nodes.slice(1)) node.data = { ...node.data, officialPosting: posting() };
        await probe.retryIncomplete();
        await probe.finishOperation();
        assert.equal(probe.requests.length, 0);
        assert.equal(probe.toasts.at(-1).title, 'No incomplete lookups');
        await probe.start();
        assert.equal(probe.requests.length, 1);
        assert.equal(probe.requests[0].entries.length, probe.nodes.length - 1);
        assert.equal(Object.hasOwn(probe.requests[0], 'force'), false, 'the host treats a missing force as a full bypass');
        await probe.complete();
      });
    },
  },
  {
    name: 'A lookup is exhausted only when a second full attempt also ends without a conclusion',
    async run() {
      const { refreshOfficialPostingEntries } = await import('../../electron/ipc/officialPostingRefresh.js');
      const { officialPostingExhausted: officialPostingRetryPaused, officialPostingLookupStatus } = await import('../../electron/ipc/officialPostingFields.js');
      const { officialPostingDisplay, officialPostingNeedsRefresh } = await import('../../src/utils/officialPostingDisplay.js');
      const run = async (previous, next) => (await refreshOfficialPostingEntries({ nodeId: 'board', manualAiRunId: 'official-posting:pause',
        entries: [{ cardId: 'card', job: { ...job(7), ...(previous ? { officialPosting: previous } : {}) } }] }, {
        store: { find: async () => null },
        resolve: async rows => ({ jobs: rows.map(row => ({ ...row, officialPosting: next })) }),
      })).entries[0].officialPosting;
      assert.equal(officialPostingRetryPaused(await run(null, uncertain())), false, 'one uncertain result retries');
      assert.equal(officialPostingRetryPaused(await run(uncertain(), uncertain())), true);
      assert.equal(officialPostingRetryPaused(await run(uncertain({ trail: ['worker-research', 'source-unproven'] }), uncertain())), true,
        'either kind of judged doubt counts');
      const interrupted = { level: 'L5', outcome: 'failed', employer: '', trail: ['worker-timeout'] };
      assert.equal(officialPostingRetryPaused(await run(uncertain(), interrupted)), false, 'an interrupted run can recover');
      assert.equal(officialPostingRetryPaused(await run(interrupted, uncertain())), false, 'an interrupted first attempt was no judgment');
      const noLeads = { level: 'L5', outcome: 'ambiguous', employer: '', trail: ['worker-research', 'research-miss'] };
      assert.equal(officialPostingRetryPaused(await run(noLeads, noLeads)), true, 'two searches that found nothing are a conclusion');
      assert.equal(officialPostingRetryPaused(await run(uncertain(), { ...noLeads, trail: ['research-miss'] })), false, 'a failed search found nothing only because it failed');
      const exhausted = await run(uncertain(), uncertain());
      assert.deepEqual([officialPostingLookupStatus(exhausted).state, officialPostingLookupStatus(exhausted).retryable], ['exhausted', false]);
      assert.equal(officialPostingNeedsRefresh({ officialPosting: exhausted }), false, 'nothing counts it as unfinished');
      const unstamped = { ...exhausted, trail: [...exhausted.trail.filter(code => code !== 'lookup-exhausted'), 'retry-paused'] };
      assert.equal(officialPostingRetryPaused(unstamped), false, 'the retired marker earns one more try');
      const display = officialPostingDisplay({ officialPosting: exhausted, matchScore: 80 });
      assert.deepEqual([display.statusLabel, display.lookupExhausted, display.lookupNeedsRefresh, display.lookupActionLabel],
        ['No confirmed official posting', true, true, 'Check again'], 'the card keeps a quiet way to look again');
      const standing = posting(1, { trail: ['semantic-match-v1', 'semantic-uncertain', 'reverify-failed', 'lookup-exhausted'] });
      assert.equal(officialPostingNeedsRefresh({ officialPosting: standing }), false, 'a verification kept through two failed rechecks stops counting');
      assert.equal(officialPostingDisplay({ officialPosting: standing, boardClosed: undefined }).lookupState, 'verified');
      const failedSearches = posting(1, { trail: ['worker-research', 'semantic-match-v1', 'research-miss', 'reverify-failed'] });
      assert.equal(officialPostingRetryPaused({ ...failedSearches, trail: [...failedSearches.trail, 'lookup-exhausted'] }), false, 'failed searches on a kept verification can recover');
      const { decideGenerationListingCheck } = await import('../../electron/ipc/listingLivenessProbe.js');
      const closedBoard = { job: { ...job(7), source: 'linkedin', listingLiveness: { state: 'closed', board: 'linkedin', checkedAt: new Date().toISOString() } } };
      const closedCheck = decideGenerationListingCheck({ ...closedBoard, posting: exhausted, verdict: 'closed', basis: 'open-rule', board: 'linkedin', official: exhausted });
      assert.equal(closedCheck.listingCheck?.action ?? closedCheck.action, 'refuse-final', 'a closed listing with an exhausted lookup does not loop on retry');
      const low = officialPostingDisplay({ officialPosting: uncertain(), matchScore: 20 });
      assert.deepEqual([low.researchSkipped, low.lookupActionLabel], [true, 'Check official posting'], 'a leftover lookup below the threshold is not unfinished work');
      const failedFetch = uncertain({ fetchFailures: [{ url: 'https://careers.example.test/x', code: 'fetch-timeout', reason: 'fetch-timeout' }] });
      assert.equal(officialPostingRetryPaused({ ...uncertain({ trail: ['semantic-uncertain', 'lookup-exhausted'] }), ...failedFetch }), false,
        'an unread page is not a judgment');
      assert.equal(officialPostingRetryPaused(posting(1, { trail: ['semantic-match-v1', 'lookup-exhausted'] })), false, 'a settled result is never paused');
    },
  },
  {
    name: 'The Job Search banner counts unfinished work from the Board cards, not the saved first attempt',
    async run() {
      const rows = [job(1, { officialPosting: uncertain() }), job(2, { officialPosting: uncertain() }), job(3), job(4, { officialPosting: posting(4) }), job(5, { matchScore: 10 })];
      const pending = searchRowsWithIncompleteLookups(rows);
      assert.deepEqual(pending.map(row => row.title), ['Synthetic Role 1', 'Synthetic Role 2', 'Synthetic Role 3'],
        'never-checked rows count; settled and below-threshold rows do not');
      const nodes = [card({ ...rows[0], hubId: 'board', officialPosting: posting(1) }, 'settled'),
        card({ ...rows[1], hubId: 'board', officialPosting: uncertain() }, 'incomplete'),
        card({ ...rows[2], hubId: 'other-board' }, 'unconnected')];
      assert.deepEqual(summarizeSearchOfficialLookups(pending, { nodes, boardIds: ['board'] }), { onBoard: 1, awaitingCombine: 1 });
      assert.deepEqual(summarizeSearchOfficialLookups(pending, { nodes, boardIds: ['board'], runCombined: true }), { onBoard: 1, awaitingCombine: 0 },
        'a row the Board already combined away is not waiting');
      assert.deepEqual(summarizeSearchOfficialLookups(pending, { nodes, boardIds: [] }), { onBoard: 0, awaitingCombine: 3 });
      assert.deepEqual(summarizeSearchOfficialLookups([], { nodes, boardIds: ['board'] }), { onBoard: 0, awaitingCombine: 0 });
      const board = { data: { combineSourceRuns: [{ sourceHubId: 'search', runId: 'run-1' }, { sourceId: 'live-shape', runId: 'run-2' }] } };
      assert.equal(boardCombinedSearchRun(board, 'search', 'run-1'), true);
      assert.equal(boardCombinedSearchRun(board, 'live-shape', 'run-2'), true);
      assert.equal(boardCombinedSearchRun(board, 'search', 'run-newer'), false, 'a newer run still needs its Combine');
      assert.equal(boardCombinedSearchRun(board, 'other', 'run-1'), false);
      assert.equal(boardCombinedSearchRun(board, 'search', undefined), false);
      assert.equal(boardCombinedSearchRun({ data: {} }, 'search', 'run-1'), false);
    },
  },
  {
    name: 'Retained verified rechecks carry new judge citations except their own source URL, never uncited search leads',
    async run() {
      const { refreshOfficialPostingEntries } = await import('../../electron/ipc/officialPostingRefresh.js');
      const { officialPostingAliases } = await import('../../electron/ipc/officialPostingStore.js');
      const source = job(42);
      const prior = posting(42, { alternatives: [{ url: 'https://old.example.test/lead', title: 'Unconfirmed old' }] });
      const priorCitation = { url: `${prior.sourceUrl}/`, title: 'Unconfirmed · cited by 2 of 4 judges' };
      const otherCitation = { url: 'https://careers.example.test/new-role', title: 'Unconfirmed · cited by 2 of 4 judges' };
      const genericLead = { url: 'https://careers.example.test/lead', title: 'Synthetic Employer posting lead' };
      const searchLead = { url: 'https://careers.example.test/search', title: 'Unconfirmed · found by search, not cited by judges' };
      for (const alternatives of [[priorCitation, otherCitation, genericLead, searchLead], [priorCitation, genericLead, searchLead], []]) {
        const result = await refreshOfficialPostingEntries({ nodeId: 'board', manualAiRunId: 'official-posting:retained',
          entries: [{ cardId: 'card', job: source }] }, {
          store: { find: async () => ({ aliases: officialPostingAliases(source), officialPosting: prior }) },
          resolve: async rows => ({ jobs: rows.map(row => ({ ...row, officialPosting: {
            level: 'L5', outcome: 'ambiguous', employer: 'Synthetic Employer', trail: ['worker-research', 'source-unproven'], alternatives,
          } })) }),
        });
        const retained = result.entries[0].officialPosting;
        assert.equal(retained.sourceUrl, prior.sourceUrl);
        assert.equal(retained.outcome, 'found');
        assert.ok(retained.trail.includes('reverify-failed'));
        if (alternatives.includes(otherCitation)) assert.deepEqual(retained.alternatives, [otherCitation]);
        else assert.equal(Object.hasOwn(retained, 'alternatives'), false);
      }
    },
  },
  {
    name: 'Mounted Board refresh commits only lookup metadata and fences overlapping starts',
    async run() {
      await withRefreshHook(async probe => {
        await probe.start();
        const original = structuredClone(probe.nodes.slice(1));
        assert.equal(probe.requests.length, 1); assert.equal(probe.leases[0].args.lane, 'job-search');
        assert.deepEqual(probe.requests[0].entries.map(entry => entry.cardId), probe.nodes.slice(1).map(node => node.id));
        await probe.start(); assert.equal(probe.requests.length, 1, 'the synchronous owner fences a second pre-render click');
        probe.nodes[1].data.notes = 'A newer note during lookup';
        probe.nodes[1].data.localApplication = { id: 'newer-saved-application' };
        await probe.complete();
        assert.equal(probe.updates.length, 6);
        for (const update of probe.updates) assert.deepEqual(Object.keys(update.patch).sort(), ['officialPosting', 'postedBy']);
        assert.equal(probe.nodes[1].data.notes, 'A newer note during lookup');
        assert.equal(probe.nodes[1].data.localApplication.id, 'newer-saved-application');
        for (let index = 1; index < original.length; index++) {
          assert.deepEqual(probe.nodes[index + 1].data, { ...original[index].data, officialPosting: posting(index), postedBy: '' });
        }
        assert.equal(probe.retired.length, 1); assert.equal(probe.leases[0].released, true);
        assert.equal(probe.probePreparation('/synthetic/workspace.canvas', 'board'), null);
        assert.deepEqual(probe.toasts.at(-1), { title: 'Official postings checked', type: 'success',
          description: '6 checks finished: 6 verified. Changed or unavailable cards kept their current results.' });
      });
    },
  },
  {
    name: 'Mounted Board refresh distinguishes settled outcomes from incomplete attempts in its toast and private-safe event summary',
    async run() {
      const settled = [posting(0),
        { level: 'L5', outcome: 'not-found', employer: 'Synthetic Employer', trail: ['worker-research', OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL] },
        { level: 'L5', outcome: 'ambiguous', employer: 'Synthetic Employer', trail: ['worker-research', OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL] },
        posting(3, { outcome: 'closed', trail: ['closed', 'semantic-match-v1'] })];
      for (const incomplete of [false, true]) {
        await withRefreshHook(async probe => {
          await probe.start();
          const tail = incomplete ? [posting(4, { trail: ['semantic-match-v1', 'reverify-failed', 'fetch-failed'] }),
            { level: 'L5', outcome: 'not-found', employer: 'Synthetic Employer', trail: ['worker-research', 'crawl-budget'] }]
            : [posting(4), posting(5)];
          const results = [...settled, ...tail];
          await probe.complete({ success: true, entries: probe.requests[0].entries.map(({ cardId }, index) => ({ cardId,
            officialPosting: results[index], postedBy: '' })) });
          assert.equal(probe.updates.length, 6, 'incomplete lookup states remain available on their cards for retry');
          assert.deepEqual(probe.toasts.at(-1), {
            title: incomplete ? 'Official posting checks incomplete' : 'Official postings checked',
            type: incomplete ? 'info' : 'success',
            description: incomplete
              ? '6 checks finished: 1 verified, 1 no exact match, 1 ambiguous, 1 closed, 2 incomplete. Retry incomplete lookups. Changed or unavailable cards kept their current results.'
              : '6 checks finished: 3 verified, 1 no exact match, 1 ambiguous, 1 closed. Changed or unavailable cards kept their current results.',
          });
          const summary = probe.getLogs().findLast(line => line.includes('[JobBoard] official-posting refresh finished'));
          assert.ok(summary);
          assert.equal(summary.slice(summary.indexOf('[JobBoard]')),
            `[JobBoard] official-posting refresh finished mode=all checked=6 verified=${incomplete ? 1 : 3} notFound=1 ambiguous=1 closed=1 exhausted=0 recheckFailed=0 retryable=${incomplete ? 2 : 0}`);
          for (const source of ['Synthetic Employer', 'careers.example.test', 'Synthetic Role']) assert.equal(summary.includes(source), false);
        });
      }
    },
  },
  {
    name: 'Board refresh check totals count failed verified rechecks and missing results as retryable, not settled',
    run() {
      const results = [job(0, { officialPosting: posting(0) }),
        job(1, { officialPosting: posting(1, { trail: ['semantic-match-v1', 'reverify-failed', 'fetch-failed'] }) }),
        job(2), job(3, { officialPosting: { level: 'L5', outcome: 'not-found', employer: 'Synthetic Employer',
          trail: ['worker-research', 'oversize'] } })];
      const before = structuredClone(results); freeze(results);
      assert.deepEqual(summarizeBoardOfficialPostingChecks(results), {
        checked: 4, verified: 1, notFound: 0, ambiguous: 0, closed: 0, exhausted: 0, recheckFailed: 0, retryable: 3,
      });
      assert.deepEqual(results, before);
      assert.deepEqual(summarizeBoardOfficialPostingChecks([]), {
        checked: 0, verified: 0, notFound: 0, ambiguous: 0, closed: 0, exhausted: 0, recheckFailed: 0, retryable: 0,
      });
    },
  },
  {
    name: 'Board refresh check totals: a verified posting whose rechecks are exhausted is its own bucket, neither exhausted nor retryable',
    run() {
      const standing = job(0, { officialPosting: posting(0, { trail: ['semantic-match-v1', 'semantic-uncertain', 'reverify-failed', 'lookup-exhausted'] }) });
      const missing = job(1, { officialPosting: { level: 'L5', outcome: 'ambiguous', employer: 'Synthetic Employer', trail: ['semantic-uncertain', 'lookup-exhausted'] } });
      const interrupted = job(2, { officialPosting: posting(2, { trail: ['semantic-match-v1', 'reverify-failed'] }) });
      assert.deepEqual(summarizeBoardOfficialPostingChecks([standing, missing, interrupted]), {
        checked: 3, verified: 0, notFound: 0, ambiguous: 0, closed: 0, exhausted: 1, recheckFailed: 1, retryable: 1,
      });
    },
  },
  {
    name: 'Mounted Board refresh skips deleted, moved, edited, locked and superseded card results',
    async run() {
      await withRefreshHook(async probe => {
        await probe.start();
        probe.nodes.splice(probe.nodes.findIndex(node => node.id === 'card-0'), 1);
        probe.nodes.find(node => node.id === 'card-1').data.hubId = 'other-board';
        probe.nodes.find(node => node.id === 'card-2').data.snippet = 'Changed source during lookup';
        probe.nodes.find(node => node.id === 'card-3').data.officialPosting = posting(300);
        probe.nodes.find(node => node.id === 'card-4').data.locked = true;
        await probe.complete();
        assert.deepEqual(probe.updates.map(update => update.id), ['card-5']);
        assert.equal(probe.nodes.find(node => node.id === 'card-3').data.officialPosting.sourceUrl, posting(300).sourceUrl);
      });
    },
  },
  {
    name: 'Mounted Board refresh commits deferred state updaters after the operation finishes',
    async run() {
      await withRefreshHook(async probe => {
        probe.deferUpdates(); await probe.start(); await probe.complete();
        assert.equal(probe.handle.runRef.current, null, 'lookup ownership is released before React drains the queued data updates');
        assert.equal(probe.pendingUpdates, 6); assert.equal(probe.updates.length, 0);
        await probe.drainUpdates();
        assert.equal(probe.updates.length, 6, 'unchanged cards still receive their completed lookup results');
      });
    },
  },
  {
    name: 'Board refresh survives nested canvas unmounts and applies worker results to retained global node state',
    async run() {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'board-refresh-canvas-state-'));
      let bundle;
      try {
        const entry = path.join(directory, 'Probe.jsx');
        await fs.writeFile(entry, `
import React, { useRef, useState } from ${JSON.stringify(path.resolve('node_modules/react/index.js'))};
import { ReactFlowProvider, useNodesState } from ${JSON.stringify(path.resolve('node_modules/@xyflow/react/dist/esm/index.js'))};
import { useBoardOfficialPostingRefresh } from ${JSON.stringify(path.resolve('src/hooks/useBoardOfficialPostingRefresh.js'))};
import { useCanvasNavigation } from ${JSON.stringify(path.resolve('src/hooks/useCanvasNavigation.js'))};
export function Probe(props) { return <ReactFlowProvider initialNodes={props.initialNodes}><CanvasProbe {...props} /></ReactFlowProvider>; }
function CanvasProbe({ initialNodes, capture, addToast }) {
  const [nodes, setNodes] = useNodesState(initialNodes);
  const [edges, setEdges] = useState([]);
  const [drawings, setDrawings] = useState([]);
  const currentNodes = useRef(nodes);
  currentNodes.current = nodes;
  const navigation = useCanvasNavigation({ nodes, edges, drawings, setNodes, setEdges, setDrawings,
    clearHistory() {}, animationDuration: 0 });
  capture({ nodes, navigation });
  return nodes.some(node => node.id === 'board') ? <BoardProbe navigation={navigation} capture={capture} addToast={addToast} /> : <span>Nested canvas</span>;
}
function BoardProbe({ navigation, capture, addToast }) {
  const handle = useBoardOfficialPostingRefresh({ nodeId: 'board', canvasFilePath: '/synthetic/workspace.canvas',
    getCurrentFile: () => '/synthetic/workspace.canvas',
    getNode: id => navigation.enumerateAllNodes().find(node => node.id === id), getNodes: navigation.enumerateAllNodes,
    updateGlobal: navigation.updateNodeDataGlobally,
    moduleRunQueue: { acquireModuleRun: async () => ({ release() {} }), cancelQueuedRunsForNode() {} },
    addToast, canStart: () => true, getScopeKey: () => 'source-run-one' });
  capture({ handle });
  return <span>{handle.refreshing ? 'working' : 'idle'}</span>;
}
`);
        bundle = await bundleComponent(entry);
        const { React, act, createRoot, Probe } = bundle.module;
        await withDom(window => withConsoleCollector(async consoleEntries => {
          let reply; let latest = {}; let operation; let cancellations = 0;
          const toasts = [];
          window.electronAPI = { refreshOfficialPostings: args => new Promise(resolve => { reply = () => resolve(response(args.entries)); }),
            completeNonApiAiRun: async () => {}, cancelNodeTaskAndWait: async () => { cancellations += 1; return { settled: true }; } };
          const initialNodes = [{ id: 'board', type: 'jobboard', data: { hubState: 'done' } },
            ...Array.from({ length: 6 }, (_, index) => card({ ...job(index), hubId: 'board' }, `card-${index}`)),
            { id: 'nested', type: 'group', data: { title: 'Nested', canvasData: { nodes: [], edges: [], drawings: [] } } }]
            .map(node => ({ ...node, position: { x: 0, y: 0 } }));
          const root = createRoot(window.document.getElementById('root'));
          try {
            await act(async () => root.render(React.createElement(React.StrictMode, null,
              React.createElement(Probe, { initialNodes, capture: value => { latest = { ...latest, ...value }; }, addToast: value => toasts.push(value) }))));
            await act(async () => { operation = latest.handle.start(); await Promise.resolve(); });
            await act(async () => { latest.navigation.diveIn('nested'); await new Promise(resolve => setTimeout(resolve, 30)); });
            assert.equal(latest.navigation.depth, 1); assert.equal(latest.nodes.length, 0);
            assert.equal(cancellations, 0, 'dive-in retains worker transport and refresh ownership');
            await act(async () => { latest.navigation.diveOut(); await new Promise(resolve => setTimeout(resolve, 30)); });
            assert.equal(latest.navigation.depth, 0);
            assert.equal(latest.handle.refreshing, true, 'a remounted Board observes the original retained refresh');
            await act(async () => { latest.navigation.diveIn('nested'); await new Promise(resolve => setTimeout(resolve, 30)); });
            assert.equal(latest.navigation.depth, 1); assert.equal(cancellations, 0);
            await act(async () => { reply(); await operation; });
            assert.equal(cancellations, 0, 'worker completion while the Board is hidden does not cancel its request');
            const retained = latest.navigation.enumerateAllNodes();
            for (let index = 0; index < 6; index++) {
              const refreshed = retained.find(node => node.id === `card-${index}`);
              assert.deepEqual(refreshed.data.officialPosting, posting(index));
              assert.equal(refreshed.data.snippet, initialNodes[index + 1].data.snippet);
            }
            await act(async () => { latest.navigation.diveOut(); await new Promise(resolve => setTimeout(resolve, 30)); });
            assert.equal(latest.navigation.depth, 0); assert.equal(latest.handle.refreshing, false);
            assert.equal(latest.nodes.find(node => node.id === 'card-0').data.officialPosting.sourceUrl, posting(0).sourceUrl);
            assert.equal(toasts.at(-1).type, 'success');
          } finally { await act(async () => root.unmount()); }
          assert.deepEqual(consoleEntries, [], 'real canvas state must settle without React warnings');
        }));
      } finally { await bundle?.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'Mounted Board deferred settlements still fence card changes made after operation cleanup',
    async run() {
      await withRefreshHook(async probe => {
        probe.deferUpdates(); await probe.start(); await probe.complete();
        probe.nodes.splice(probe.nodes.findIndex(node => node.id === 'card-0'), 1);
        probe.nodes.find(node => node.id === 'card-1').data.hubId = 'other-board';
        probe.nodes.find(node => node.id === 'card-2').data.snippet = 'Edited after lookup completion';
        probe.nodes.find(node => node.id === 'card-3').data.officialPosting = posting(300);
        probe.nodes.find(node => node.id === 'card-4').data.locked = true;
        await probe.drainUpdates();
        assert.deepEqual(probe.updates.map(update => update.id), ['card-5']);
      });
    },
  },
  {
    name: 'Mounted Board deferred settlements reject later scope changes, canvas switches and unmounts',
    async run() {
      for (const change of [probe => probe.setScope('new-source-run'),
        probe => probe.render({ canvasFilePath: '/synthetic/other-workspace.canvas' }), probe => probe.unmount()]) {
        await withRefreshHook(async probe => {
          probe.deferUpdates(); await probe.start(); await probe.complete();
          await change(probe); await probe.drainUpdates();
          assert.equal(probe.updates.length, 0);
        });
      }
    },
  },
  {
    name: 'Mounted Board deferred settlements reject cancellation and a successor refresh without blocking successor results',
    async run() {
      await withRefreshHook(async probe => {
        probe.deferUpdates(); probe.holdRetirement(); await probe.start(); await probe.replyWithoutWaiting();
        assert.equal(probe.pendingUpdates, 6);
        await probe.cancel(); await probe.drainUpdates();
        assert.equal(probe.updates.length, 0);
        await probe.finishRetirement();
      });
      await withRefreshHook(async probe => {
        probe.deferUpdates(); await probe.start(); await probe.complete();
        await probe.start(); await probe.drainUpdates();
        assert.equal(probe.updates.length, 0, 'a successor owns settlement even before its lookup returns');
        await probe.complete(); await probe.drainUpdates();
        assert.equal(probe.updates.length, 6, 'the successor results remain publishable after its cleanup');
      });
    },
  },
  {
    name: 'Mounted Board refresh discards old exact-run scope and canvas switch settlements',
    async run() {
      for (const change of [probe => probe.setScope('same-payload-new-source-run'),
        probe => probe.render({ canvasFilePath: '/synthetic/other-workspace.canvas' })]) {
        await withRefreshHook(async probe => {
          await probe.start(); await change(probe); await probe.complete();
          assert.equal(probe.updates.length, 0); assert.equal(probe.retired.length, 1);
          assert.equal(probe.leases[0].released, true);
        });
      }
    },
  },
  {
    name: 'Board refresh background ownership still cancels when its node is removed or its canvas file is replaced',
    async run() {
      for (const removeOwner of [true, false]) {
        await withRefreshHook(async probe => {
          let currentFile = '/synthetic/workspace.canvas';
          await probe.render({ getCurrentFile: () => currentFile });
          await probe.start();
          if (removeOwner) probe.nodes.splice(probe.nodes.findIndex(node => node.id === 'board'), 1);
          else currentFile = '/synthetic/replacement.canvas';
          await probe.hide();
          await probe.complete();
          assert.equal(probe.cancellations.length, 1, 'only a globally retained same-file owner can outlive unmount');
          assert.equal(probe.updates.length, 0); assert.equal(probe.leases[0].released, true);
          assert.equal(probe.probePreparation('/synthetic/workspace.canvas', 'board'), null);
        });
      }
    },
  },
  {
    name: 'Mounted Board refresh retains cancellation ownership until acknowledgment and never writes after unmount',
    async run() {
      for (const unmount of [false, true]) {
        await withRefreshHook(async probe => {
          await probe.start(); probe.holdAcknowledgement();
          if (unmount) await probe.unmount(); else { await probe.cancel(); await probe.cancel(); }
          await probe.replyWithoutWaiting();
          assert.equal(probe.updates.length, 0); assert.equal(probe.cancellations.length, 1);
          assert.equal(probe.leases[0].released, false, 'the job lane stays owned until cancellation is acknowledged');
          assert.ok(probe.probePreparation('/synthetic/workspace.canvas', 'board'));
          assert.ok(probe.probePreparation('/synthetic/workspace.canvas', 'card-0'));
          await probe.acknowledge();
          assert.equal(probe.leases[0].released, true); assert.equal(probe.retired.length, 1);
          assert.equal(probe.probePreparation('/synthetic/workspace.canvas', 'board'), null);
          assert.equal(probe.probePreparation('/synthetic/workspace.canvas', 'card-0'), null);
        });
      }
    },
  },
  {
    name: 'Mounted Board refresh recovers failed cancellation acknowledgment across unmount and retries the retained owner',
    async run() {
      for (const reject of [false, true]) {
        await withRefreshHook(async probe => {
          await probe.start(); probe.holdAcknowledgement(); await probe.hide();
          assert.equal(probe.cancellations.length, 1);
          await probe.replyWithoutWaiting(); await probe.failAcknowledgement(reject);
          assert.equal(probe.updates.length, 0); assert.equal(probe.leases[0].released, false);
          assert.ok(probe.probePreparation('/synthetic/workspace.canvas', 'board'));
          await probe.render();
          assert.equal(probe.handle.refreshing, true); assert.equal(probe.handle.progress.recovering, true);
          await probe.start(); assert.equal(probe.requests.length, 1, 'a remounted owner cannot start a new lookup while acknowledgment is pending');
          await probe.cancel();
          assert.equal(probe.cancellations.length, 2, 'the retained owner accepts one cancellation retry after its earlier acknowledgment failed');
          await probe.acknowledge();
          assert.equal(probe.leases[0].released, true); assert.equal(probe.retired.length, 1);
          assert.equal(probe.probePreparation('/synthetic/workspace.canvas', 'board'), null);
          assert.equal(probe.probePreparation('/synthetic/workspace.canvas', 'card-0'), null);
          assert.equal(probe.handle.refreshing, false); assert.equal(probe.updates.length, 0);
        });
      }
    },
  },
  {
    name: 'Board lookup carry overlays exact-source metadata while preserving source and protected application fields',
    run() {
      const source = job(1, { officialPosting: { level: 'L5', outcome: 'not-found', employer: 'Synthetic Employer', trail: ['worker-research'] },
        notes: 'Live synthetic notes', localApplication: { id: 'live-application', status: 'saved' },
        careerSnapshotId: 'live-career', postingVariants: [] });
      const saved = card({ ...source, officialPosting: posting(1), postedBy: '', notes: 'Older synthetic notes',
        localApplication: { id: 'other-application' }, careerSnapshotId: 'old-career' });
      const before = structuredClone({ source, saved });
      freeze(source); freeze(saved);
      const [carried] = carryBoardOfficialPostingResults([source], [saved]);
      assert.deepEqual(carried, { ...source, officialPosting: posting(1), postedBy: '' });
      assert.equal(carried.localApplication, source.localApplication);
      assert.equal(carried.postingVariants, source.postingVariants);
      assert.deepEqual({ source, saved }, before);
    },
  },
  {
    name: 'Board lookup carry separates sibling locations, source descriptions and listing identities',
    run() {
      const original = job(2);
      const siblings = [job(2, { location: 'Other Synthetic City, Canada' }), job(2, { snippet: 'Different requisition wording.' }),
        job(2, { url: 'https://listing.example.test/other' }), job(2, { source: 'indeed' }),
        job(2, { title: 'Other Synthetic Role' }), job(2, { workMode: 'remote' })];
      const input = [original, ...siblings];
      const output = carryBoardOfficialPostingResults(input, [card({ ...original, officialPosting: posting(2) })]);
      assert.equal(output[0].officialPosting.sourceUrl, posting(2).sourceUrl);
      for (let index = 1; index < input.length; index++) assert.equal(output[index], input[index]);
    },
  },
  {
    name: 'Board lookup carry binds consolidated variant membership while allowing liveness-only updates',
    run() {
      const variants = [{ location: 'First Synthetic City', url: 'https://listing.example.test/first', source: 'linkedin' },
        { location: 'Second Synthetic City', url: 'https://listing.example.test/second', source: 'linkedin' }];
      const original = job(3, { location: 'Multiple locations', postingVariants: variants });
      const saved = card({ ...original, officialPosting: posting(3) });
      const changed = [job(3), { ...original, postingVariants: variants.slice(0, 1) },
        { ...original, postingVariants: [...variants].reverse() },
        { ...original, postingVariants: [...variants, { location: 'Third Synthetic City', url: 'https://listing.example.test/third' }] }];
      const out = carryBoardOfficialPostingResults([original, ...changed,
        { ...original, postingVariants: variants.map(variant => ({ ...variant, liveness: 'closed' })) }], [saved]);
      assert.equal(out[0].officialPosting.sourceUrl, posting(3).sourceUrl);
      for (let index = 0; index < changed.length; index++) assert.equal(out[index + 1], changed[index]);
      assert.equal(out.at(-1).officialPosting.sourceUrl, posting(3).sourceUrl);
      assert.equal(out.at(-1).postingVariants[0].liveness, 'closed');
    },
  },
  {
    name: 'Board lookup carry excludes settled legacy and invalid receipts but preserves retry hints and forces conflicting cards fresh',
    run() {
      const source = job(4);
      for (const result of [posting(4, { trail: [] }), posting(4, { semanticMatch: undefined }), { level: 'L1' }]) {
        assert.equal(carryBoardOfficialPostingResults([source], [card({ ...source, officialPosting: result })])[0], source);
      }
      const retry = posting(4, { trail: ['semantic-match-v1', 'reverify-failed', 'fetch-failed'] });
      assert.deepEqual(carryBoardOfficialPostingResults([source], [card({ ...source, officialPosting: retry })])[0].officialPosting, retry);
      const first = card({ ...source, officialPosting: posting(4), postedBy: '' }, 'first');
      const second = card({ ...source, officialPosting: posting(5), postedBy: '' }, 'second');
      const conflicted = carryBoardOfficialPostingResults([source], [first, second, first])[0];
      assert.deepEqual(conflicted, { ...source, officialPosting: { level: 'L5', outcome: 'failed', employer: '', trail: ['failed'] } });
      assert.equal(JSON.stringify(conflicted.officialPosting).includes('careers.example.test'), false,
        'the retry marker does not choose a conflicting posting URL or receipt');
      const equal = card({ ...source, officialPosting: { ...posting(4), semanticMatch: { sourceHash: 'b'.repeat(64),
        inputHash: 'a'.repeat(64), version: 1 } }, postedBy: '' }, 'equal');
      assert.deepEqual(carryBoardOfficialPostingResults([source], [first, equal])[0].officialPosting, posting(4));
      const settledMiss = { level: 'L5', outcome: 'not-found', employer: 'Synthetic Employer',
        trail: ['worker-research', 'semantic-match-v1'], semanticMatch: { version: 1, inputHash: 'a'.repeat(64) } };
      assert.deepEqual(carryBoardOfficialPostingResults([source], [card({ ...source, officialPosting: settledMiss })])[0].officialPosting, settledMiss);
    },
  },
  {
    name: 'Board failed-recheck and conflicting-card hints force fresh host work even when Combine permits cache reuse',
    async run() {
      const { refreshOfficialPostingEntries } = await import('../../electron/ipc/officialPostingRefresh.js');
      const source = job(44, { officialPosting: { level: 'L5', outcome: 'not-found', employer: 'Synthetic Employer', trail: ['worker-research'] } });
      const failed = card({ ...source, officialPosting: posting(44, { trail: ['semantic-match-v1', 'reverify-failed', 'fetch-failed'] }) });
      const conflictA = card({ ...source, officialPosting: posting(45) }, 'conflict-a');
      const conflictB = card({ ...source, officialPosting: posting(46) }, 'conflict-b');
      const carried = [carryBoardOfficialPostingResults([source], [failed])[0],
        carryBoardOfficialPostingResults([source], [conflictA, conflictB])[0]];
      const before = structuredClone(source); let hostCalls = 0;
      await refreshBoardOfficialPostingJobs(carried, { nodeId: 'board-retry', manualAiRunId: 'official-posting:retry-hints', force: true,
        refresh: async args => ({ success: true, ...await refreshOfficialPostingEntries({ ...args, force: false }, {
          store: { find: async () => null },
          resolve: async (rows, options) => {
            hostCalls++; assert.equal(options.bypassCache, false);
            assert.deepEqual(options.bypassCacheByRow, [true, true], 'per-row retry hints override cache permission');
            return { jobs: rows.map(row => ({ ...row, officialPosting: { level: 'L5', outcome: 'failed',
              employer: row.company, trail: ['failed'] } })) };
          },
        }) }),
      });
      assert.equal(hostCalls, 1); assert.deepEqual(source, before);
    },
  },
  {
    name: 'Board lookup commit guard rejects deleted, moved, locked, edited and superseded card snapshots',
    run() {
      const node = card({ ...job(5), hubId: 'board', officialPosting: posting(5), postedBy: '' });
      const snapshot = { id: node.id, key: key(node.data), posting: JSON.stringify(node.data.officialPosting), postedBy: '' };
      assert.equal(boardOfficialPostingRefreshCardMatches(node, snapshot, 'board'), true);
      for (const candidate of [null, { ...node, id: 'replacement' }, { ...node, type: 'text' },
        { ...node, data: { ...node.data, hubId: 'other-board' } }, { ...node, data: { ...node.data, locked: true } },
        { ...node, data: { ...node.data, snippet: 'Edited source.' } },
        { ...node, data: { ...node.data, officialPosting: posting(6) } },
        { ...node, data: { ...node.data, postedBy: 'New synthetic poster' } }]) {
        assert.equal(boardOfficialPostingRefreshCardMatches(candidate, snapshot, 'board'), false);
      }
      assert.equal(boardOfficialPostingRefreshCardMatches({ ...node, data: { ...node.data,
        notes: 'Edited note', localApplication: { id: 'new-application' }, matchScore: 91 } }, snapshot, 'board'), true);
    },
  },
  {
    name: 'Board refresh batches 128 rows, correlates reordered responses and preserves every original source row',
    async run() {
      const jobs = Array.from({ length: 260 }, (_, index) => job(index, {
        applyOptions: [{ label: 'Synthetic apply', href: `https://listing.example.test/apply/${index}` }],
        provenance: { marker: 'source-alias' }, localApplication: { id: `application-${index}` },
        ...(index === 0 || index === 129 ? { officialPosting: posting(index) } : {}) }));
      const before = structuredClone(jobs); freeze(jobs);
      const calls = []; const progress = [];
      const result = await refreshBoardOfficialPostingJobs(jobs, { nodeId: 'board', manualAiRunId: 'official-posting:synthetic',
        onProgress: value => progress.push(value), refresh: async args => {
          calls.push(args);
          for (const entry of args.entries) {
            entry.job.applyOptions[0].label = 'Changed callback copy'; entry.job.provenance.marker = 'Changed callback copy';
          }
          return { success: true, entries: [...args.entries].reverse().map(entry => ({ cardId: entry.cardId,
            officialPosting: posting(Number(entry.cardId.slice('official-row-'.length))), postedBy: '' })) };
        } });
      assert.deepEqual(calls.map(call => call.entries.length), [128, 128, 2]);
      assert.equal(result.refreshed, 258); assert.equal(result.jobs.length, jobs.length);
      assert.deepEqual(progress[0], { completed: 0, total: 258 });
      assert.deepEqual(progress.at(-1), { completed: 258, total: 258 });
      for (const [index, row] of result.jobs.entries()) {
        assert.equal(row.officialPosting.sourceUrl, posting(index).sourceUrl);
        assert.equal(row.localApplication, jobs[index].localApplication);
        assert.equal(row.provenance, jobs[index].provenance);
        assert.equal(row.snippet, jobs[index].snippet); assert.equal(row.matchScore, jobs[index].matchScore);
      }
      assert.equal(result.jobs[0], jobs[0]); assert.equal(result.jobs[129], jobs[129]);
      assert.deepEqual(jobs, before);
    },
  },
  {
    name: 'Board refresh bounds rich-description batches by UTF-8 bytes without truncating source text',
    async run() {
      const description = 'Synthetic evidence. '.repeat(12_500);
      const jobs = Array.from({ length: 80 }, (_, index) => job(index, { description }));
      const sizes = [];
      const result = await refreshBoardOfficialPostingJobs(jobs, { refresh: async args => {
        const bytes = args.entries.reduce((sum, entry) => sum + new TextEncoder().encode(JSON.stringify(entry.job)).byteLength, 0);
        sizes.push(bytes); assert(bytes <= 15 * 1024 * 1024);
        for (const entry of args.entries) assert.equal(entry.job.description, description);
        return response(args.entries);
      } });
      assert.equal(sizes.length, 2); assert.equal(result.refreshed, 80); assert.equal(result.jobs.length, 80);
      for (const row of result.jobs) assert.equal(row.description, description);
      let called = false;
      await assert.rejects(refreshBoardOfficialPostingJobs([job(0, { description: 'x'.repeat(512 * 1024) })], {
        refresh: async () => { called = true; },
      }), { code: 'JOB_OFFICIAL_REFRESH_INVALID' });
      assert.equal(called, false, 'one oversized source cannot be silently truncated or submitted');
    },
  },
  {
    name: 'Board refresh skips current rows unless forced and retains duplicate listing rows with real card owners',
    async run() {
      const current = job(7, { officialPosting: posting(7) }); let calls = 0;
      const skipped = await refreshBoardOfficialPostingJobs([current], { refresh: () => { calls++; } });
      assert.equal(calls, 0); assert.equal(skipped.refreshed, 0); assert.equal(skipped.jobs[0], current);
      const result = await refreshBoardOfficialPostingJobs([current, current], { force: true,
        cardIds: ['saved-card-one', 'saved-card-two'], refresh: async args => {
          calls++; assert.deepEqual(args.entries.map(entry => entry.cardId), ['saved-card-one', 'saved-card-two']);
          return response(args.entries);
        } });
      assert.equal(calls, 1); assert.equal(result.refreshed, 2); assert.equal(result.jobs.length, 2);
      assert.notEqual(result.jobs[0].officialPosting.sourceUrl, result.jobs[1].officialPosting.sourceUrl);
      for (const cardIds of [['same', 'same'], ['only-one'], [null, 'two']]) {
        await assert.rejects(refreshBoardOfficialPostingJobs([current, current], { cardIds }), { code: 'JOB_OFFICIAL_REFRESH_INVALID' });
      }
    },
  },
  {
    name: 'Board refresh rejects missing, duplicate, unknown and malformed results without altering source aliases',
    async run() {
      const jobs = [job(8), job(9)]; const before = structuredClone(jobs); freeze(jobs);
      const bad = [undefined, { success: false }, { success: true, entries: [] },
        { success: true, entries: [{ cardId: 'official-row-0', officialPosting: posting() }, { cardId: 'official-row-0', officialPosting: posting() }] },
        { success: true, entries: [{ cardId: 'official-row-0', officialPosting: posting() }, { cardId: 'other', officialPosting: posting() }] },
        { success: true, entries: [{ cardId: 'official-row-0', officialPosting: posting() }, { cardId: 'official-row-1', officialPosting: { level: 'L1' } }] },
        { success: true, entries: [{ cardId: 'official-row-0', officialPosting: posting() }, { cardId: 'official-row-1', officialPosting: posting(), postedBy: {} }] }];
      for (const result of bad) await assert.rejects(refreshBoardOfficialPostingJobs(jobs, { refresh: async () => result }));
      const expected = Object.assign(new Error('Synthetic host failure.'), { code: 'SYNTHETIC_HOST_FAILURE' });
      await assert.rejects(refreshBoardOfficialPostingJobs(jobs, { refresh: async () => { throw expected; } }), error => error === expected);
      await assert.rejects(refreshBoardOfficialPostingJobs(jobs, { refresh: async () => ({ success: false,
        error: 'Synthetic refusal.', errorCode: 'SYNTHETIC_REFUSAL' }) }), { code: 'SYNTHETIC_REFUSAL' });
      assert.deepEqual(jobs, before);
    },
  },
  {
    name: 'Board refresh cancellation prevents later batches and discards completed partial batches',
    async run() {
      let cancelled = true; let calls = 0;
      await assert.rejects(refreshBoardOfficialPostingJobs([job()], { cancelled: () => cancelled,
        refresh: () => { calls++; } }), { code: 'JOB_OFFICIAL_REFRESH_CANCELLED' });
      assert.equal(calls, 0);
      cancelled = false;
      const jobs = Array.from({ length: 129 }, (_, index) => job(index)); const before = structuredClone(jobs);
      await assert.rejects(refreshBoardOfficialPostingJobs(jobs, { cancelled: () => cancelled,
        refresh: async args => { calls++; cancelled = true; return response(args.entries); } }), { code: 'JOB_OFFICIAL_REFRESH_CANCELLED' });
      assert.equal(calls, 1); assert.deepEqual(jobs, before);
      for (const result of [{ success: false, cancelled: true }, { success: false, pausedForQuit: true },
        { success: false, errorCode: 'APP_QUIT_PAUSED' }]) {
        await assert.rejects(refreshBoardOfficialPostingJobs([job()], { refresh: async () => result }), { code: 'JOB_OFFICIAL_REFRESH_CANCELLED' });
      }
      await assert.rejects(refreshBoardOfficialPostingJobs([job()], { refresh: async () => {
        throw Object.assign(new Error('Synthetic abort.'), { name: 'AbortError' });
      } }), { code: 'JOB_OFFICIAL_REFRESH_CANCELLED' });
    },
  },
  {
    name: 'Job source links rank a confirmed official posting first, then ATS, employer, boards, unknown sites, reposters and the Google card last',
    run() {
      const row = job(60, {
        company: 'Acme Inc.',
        url: 'https://www.linkedin.com/jobs/view/123',
        googleCardUrl: 'https://www.google.com/search?q=Synthetic+Role&udm=8&htidocid=doc-60',
        applyOptions: [{ label: 'Apply on ZipRecruiter', href: 'https://www.ziprecruiter.com/c/x/job/1' },
          { label: 'Apply on Acme', href: 'https://careers.acme.example/jobs/60' },
          { label: 'Apply on Greenhouse', href: 'https://boards.greenhouse.io/acme/jobs/60' },
          { label: 'Apply on LinkedIn', href: 'https://www.linkedin.com/jobs/view/123' },
          { label: 'Apply on Unknown', href: 'https://reposts.example/job/60' },
          { label: 'Apply on Built In NYC', href: 'https://www.builtinnyc.com/job/60' }],
        alternateListings: [{ board: 'indeed', url: 'https://ca.indeed.com/viewjob?jk=60' },
          { board: 'talent', url: 'https://ca.talent.com/view?id=60' }],
        postingVariants: [{ location: 'Elsewhere', url: 'https://jobs.lever.co/acme/60' },
          { location: 'Closed city', url: 'https://jobs.ashbyhq.com/acme/closed', liveness: 'closed' }],
        officialPosting: posting(60, { officialApplyUrl: 'https://careers.example.test/60/apply' }),
      });
      const links = jobSourceLinks(row);
      assert.deepEqual(links.map(link => link.url), [
        'https://careers.example.test/60', 'https://careers.example.test/60/apply',
        'https://boards.greenhouse.io/acme/jobs/60', 'https://jobs.lever.co/acme/60', 'https://careers.acme.example/jobs/60',
        'https://www.linkedin.com/jobs/view/123', 'https://www.builtinnyc.com/job/60', 'https://ca.indeed.com/viewjob?jk=60',
        'https://reposts.example/job/60',
        'https://www.ziprecruiter.com/c/x/job/1', 'https://ca.talent.com/view?id=60',
        links.at(-1).url,
      ]);
      assert.deepEqual(links.map(link => link.kind), ['official', 'official', 'employer', 'employer', 'employer',
        'board', 'board', 'board', 'other', 'aggregator', 'aggregator', 'google']);
      assert.match(links.at(-1).url, /^https:\/\/www\.google\.com\/search\?.*htidocid=doc-60/u);
      assert.equal(links[0].label, 'Open official posting');
      assert.equal(links[5].label, 'Open listing on linkedin.com');
      assert.equal(links.at(-1).label, 'Open Google Jobs card');
      assert.ok(!links.some(link => link.url.includes('closed')), 'a sibling posting already found closed is skipped');
    },
  },
  {
    name: 'Job source links drop unsafe URLs, exclude closed and unconfirmed official addresses, and repair legacy Google routes',
    run() {
      const row = job(61, {
        company: 'Acme',
        url: 'javascript:alert(1)',
        googleCardUrl: 'https://www.google.com/webhp?ibp=htl;jobs#htivrt=jobs&htidocid=legacy-61',
        applyOptions: [{ href: 'https://user:secret@careers.acme.example/x' }, { href: 'data:text/html,hi' },
          { href: 'linkedin' }, { href: 'https://careers.acme.example/jobs/61' }],
        officialPosting: posting(61, { level: 'L1', outcome: 'closed', trail: ['closed'] }),
      });
      const links = jobSourceLinks(row);
      assert.deepEqual(links.map(link => link.kind), ['employer', 'google']);
      assert.equal(links[0].url, 'https://careers.acme.example/jobs/61');
      assert.match(links[1].url, /^https:\/\/www\.google\.com\/search\?q=.*&udm=8&htidocid=legacy-61/u);
      const card = jobCardSourceLinks(row);
      assert.equal(card[0].kind, 'closed-official', 'the card still opens a previously closed official page first');
      assert.equal(card[0].url, posting(61).sourceUrl);
      assert.deepEqual(card.slice(1), links);
      const ambiguous = job(62, { url: '', officialPosting: posting(62, { outcome: 'ambiguous', level: 'L5',
        sourceUrl: undefined, alternatives: [{ url: 'https://careers.example.test/maybe', title: 'Unconfirmed · cited by 2 of 2 judges' }] }) });
      assert.deepEqual(jobSourceLinks(ambiguous), [], 'unconfirmed candidates keep their own UI and are never in the chain');
      assert.deepEqual(jobSourceLinks(null), []);
    },
  },
  {
    name: 'Job source links de-duplicate by normalized URL across fields and keep stable order inside a host class',
    run() {
      const row = job(63, { url: 'https://Jobs.Lever.co/acme/63', applyOptions: [{ href: 'https://jobs.lever.co/acme/63' },
        { href: 'https://acme.wd5.myworkdayjobs.com/en-US/careers/job/63' }],
      alternateListings: [{ url: 'https://jobs.lever.co/acme/63' }], postingVariants: [{ url: 'https://jobs.lever.co/acme/63' }] });
      assert.deepEqual(jobSourceLinks(row).map(link => link.url),
        ['https://jobs.lever.co/acme/63', 'https://acme.wd5.myworkdayjobs.com/en-US/careers/job/63']);
    },
  },
  {
    name: 'Job source link host tables cover every host ATS and reposting domain',
    run() {
      for (const domain of ATS_BASE_DOMAINS) assert.equal(sourceLinkHostClass(`https://tenant.${domain}/job`), 'ats', domain);
      for (const domain of AGGREGATOR_BASE_DOMAINS) {
        assert.ok(['board', 'aggregator', 'google'].includes(sourceLinkHostClass(`https://${domain}/job`)), domain);
      }
      assert.equal(sourceLinkHostClass('https://uk.linkedin.com/jobs/view/1'), 'board');
      assert.equal(sourceLinkHostClass('https://www.glassdoor.co.uk/job'), 'board');
      assert.equal(sourceLinkHostClass('https://www.simplyhired.ca/job/1'), 'aggregator');
      assert.equal(sourceLinkHostClass('https://google.com.evil.example/search'), 'other');
      for (const host of ['www.builtinnyc.com', 'www.builtinchicago.org', 'builtin.com']) {
        assert.equal(sourceLinkHostClass(`https://${host}/job/1`), 'board', host);
      }
      for (const host of ['talentify.io', 'www.salary.com']) assert.equal(sourceLinkHostClass(`https://${host}/job/1`), 'aggregator', host);
      // An unknown host is the employer's own site only when it carries the company's name.
      assert.equal(sourceLinkHostClass('https://careers.northwind.example/1', ['Northwind Labs Inc.']), 'employer');
      assert.equal(sourceLinkHostClass('https://jobs.bankofamerica.com/1', ['Bank of America']), 'employer');
      assert.equal(sourceLinkHostClass('https://reposter.example/1', ['Northwind Labs Inc.']), 'other');
      assert.equal(sourceLinkHostClass('https://careers.northwind.example/1'), 'other');
    },
  },
  {
    name: 'Job source link dead marks on a Google card survive consolidation rewriting the row location',
    run() {
      const raw = 'https://www.google.com/search?udm=8&htidocid=abc';
      const single = job(64, { url: '', googleCardUrl: raw, location: 'Toronto, ON' });
      const merged = { ...single, location: 'Multiple locations' };
      const [before] = jobSourceLinks(single);
      const [after] = jobSourceLinks(merged);
      assert.notEqual(before.url, after.url, 'the opened Google search carries the row location');
      assert.equal(jobSourceLinkMark(before), raw, 'the mark is the stored address, not the repaired one');
      assert.equal(jobSourceLinkMark(before), jobSourceLinkMark(after));
      assert.deepEqual(pickCurrentJobSourceLink([after], [jobSourceLinkMark(before)]), { current: null, remaining: [], exhausted: true });
      const saved = card({ ...single, deadSourceUrls: [jobSourceLinkMark(before)] });
      assert.deepEqual(carryBoardDeadSourceUrls([merged], [saved])[0].deadSourceUrls, [raw]);
    },
  },
  {
    name: 'Job source link dead marks pick the next link, report exhaustion, and cap stored marks',
    run() {
      const links = [{ url: 'https://a.example/1', kind: 'employer' }, { url: 'https://b.example/2', kind: 'board' }];
      assert.deepEqual(pickCurrentJobSourceLink(links, undefined), { current: links[0], remaining: [links[1]], exhausted: false });
      assert.deepEqual(pickCurrentJobSourceLink(links, ['https://a.example/1']), { current: links[1], remaining: [], exhausted: false });
      assert.deepEqual(pickCurrentJobSourceLink(links, ['https://b.example/2', 'https://a.example/1', 42]),
        { current: null, remaining: [], exhausted: true });
      assert.deepEqual(pickCurrentJobSourceLink([], ['https://a.example/1']), { current: null, remaining: [], exhausted: false });
      const once = appendDeadSourceUrl(undefined, 'https://a.example/1');
      assert.deepEqual(once, ['https://a.example/1']);
      assert.equal(appendDeadSourceUrl(once, 'https://a.example/1'), once, 'a repeated mark is a no-op');
      assert.deepEqual(appendDeadSourceUrl(once, 'javascript:alert(1)'), once);
      const many = Array.from({ length: MAX_DEAD_SOURCE_URLS + 5 }, (_, index) => `https://dead.example/${index}`);
      const capped = mergeDeadSourceUrls(many);
      assert.equal(capped.length, MAX_DEAD_SOURCE_URLS);
      assert.equal(capped.at(-1), many.at(-1), 'the newest marks are kept');
    },
  },
  {
    name: 'Board Combine carries each card\'s dead marks onto its own rebuilt row and returns untouched rows unchanged',
    run() {
      const marked = job(70, { url: 'https://www.linkedin.com/jobs/view/70', applyOptions: [{ href: 'https://jobs.lever.co/acme/70' }] });
      const other = job(71, { url: 'https://www.linkedin.com/jobs/view/71' });
      const saved = card({ ...marked, deadSourceUrls: ['https://jobs.lever.co/acme/70'] });
      // Consolidation gave the job a new representative: a different source key,
      // but the marked card's own listing is still in its link list.
      const consolidated = job(72, { url: 'https://www.indeed.com/viewjob?jk=72', location: 'Multiple locations',
        postingVariants: [{ location: 'Elsewhere', url: 'https://www.linkedin.com/jobs/view/70' },
          { location: 'Here', url: 'https://jobs.lever.co/acme/70' }] });
      freeze(marked); freeze(other); freeze(saved); freeze(consolidated);
      const out = carryBoardDeadSourceUrls([marked, other], [saved, { type: 'text', data: { deadSourceUrls: ['https://www.linkedin.com/jobs/view/71'] } }]);
      assert.deepEqual(out[0], { ...marked, deadSourceUrls: ['https://jobs.lever.co/acme/70'] });
      assert.equal(out[1], other, 'a row whose links were never marked keeps its identity');
      assert.deepEqual(carryBoardDeadSourceUrls([consolidated], [saved])[0].deadSourceUrls, ['https://jobs.lever.co/acme/70'],
        'a rebuilt row is matched by a link only it holds, not by source key');
      const already = { ...marked, deadSourceUrls: ['https://jobs.lever.co/acme/70'] };
      assert.equal(carryBoardDeadSourceUrls([already], [saved])[0], already, 'nothing new to carry keeps identity');
      assert.equal(carryBoardDeadSourceUrls([marked], [])[0], marked);
      assert.deepEqual(carryBoardDeadSourceUrls([already], [card(marked)])[0], marked,
        'the live cards are the authority: a list copied from an older snapshot is replaced');
      assert.equal(key(out[0]), key(marked), 'dead marks never change the lookup source key');
      const built = buildJobTreeNodes({ displayedJobs: [out[0], other],
        bucketTree: { roles: [{ name: 'Synthetic', jobIndices: [0, 1] }],
          likelihoodBands: [{ label: 'Strong (70-100%)', minScore: 70, maxScore: 100 }],
          salaryRanges: [{ label: 'Any', minSalary: 0, maxSalary: null }] },
        originalPos: { x: 0, y: 0 }, hubId: 'board', baseNodeId: 'board' });
      const cards = built.newNodes.filter(node => node.type === 'jobcard');
      assert.deepEqual(cards.find(node => node.data.title === marked.title).data.deadSourceUrls, ['https://jobs.lever.co/acme/70']);
      assert.equal(Object.hasOwn(cards.find(node => node.data.title === other.title).data, 'deadSourceUrls'), false);
    },
  },
  {
    name: 'Board Combine never moves a dead mark to a different job that shares the address',
    run() {
      const careers = 'https://careers.acme.com/';
      const a = job(73, { company: 'Acme', url: careers, applyOptions: [{ href: 'https://jobs.lever.co/acme/73' }] });
      const b = job(74, { company: 'Acme', url: careers });
      const markedA = card({ ...a, deadSourceUrls: [careers] }, 'card-a');
      const out = carryBoardDeadSourceUrls([a, b], [markedA, card(b, 'card-b')]);
      assert.deepEqual(out[0].deadSourceUrls, [careers]);
      assert.equal(out[1], b, 'the other job keeps its only link');
      assert.deepEqual(pickCurrentJobSourceLink(jobCardSourceLinks(out[1]), out[1].deadSourceUrls).current.url, careers);
    },
  },
  {
    name: 'Board Combine keeps a Restore when a sibling card still marks the shared address',
    run() {
      const lever = 'https://jobs.lever.co/acme/75';
      const a = job(75, { url: 'https://www.linkedin.com/jobs/view/75', applyOptions: [{ href: lever }] });
      const b = job(76, { url: 'https://www.indeed.com/viewjob?jk=76', postingVariants: [{ location: 'Elsewhere', url: lever }] });
      const first = carryBoardDeadSourceUrls([a, b], [card({ ...a, deadSourceUrls: [lever] }, 'card-a'), card({ ...b, deadSourceUrls: [lever] }, 'card-b')]);
      assert.deepEqual(first.map(row => row.deadSourceUrls), [[lever], [lever]]);
      // The user restores links on A only; B keeps its own mark.
      const restoredA = card({ ...first[0], deadSourceUrls: [] }, 'card-a');
      const second = carryBoardDeadSourceUrls([a, b], [restoredA, card(first[1], 'card-b')]);
      assert.equal(second[0], a, 'the restored card gets nothing back from its sibling');
      assert.deepEqual(second[1].deadSourceUrls, [lever]);
      assert.equal(pickCurrentJobSourceLink(jobCardSourceLinks(second[0]), second[0].deadSourceUrls).current.url, lever);
    },
  },
  {
    name: 'Board Combine carries dead marks from the live cards right before the tree build',
    async run() {
      const source = await fs.readFile(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      const carry = source.indexOf('union = carryBoardDeadSourceUrls(union, liveBoardCards);');
      const live = source.indexOf("const liveBoardCards = getNodes().filter(node => node?.type === 'jobcard' && node?.data?.hubId === id);");
      const build = source.indexOf('buildJobTreeNodes({\n        displayedJobs: union,');
      assert.ok(live > 0 && carry > live && build > carry, 'the carry reads live cards and runs before the build');
      assert.ok(!/\bawait\b/u.test(source.slice(live, build)), 'nothing yields between the live read and the build');
      assert.equal(source.split('carryBoardDeadSourceUrls(').length - 1, 1, 'there is no earlier carry from the Combine snapshot');
    },
  },

];
